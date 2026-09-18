// @ts-check
/**
 * @file New Descent's combat simulation (ARCHITECTURE.md §4.11) — the two enemies, the player's
 * sword, and the health that connects them.
 *
 * Everything here **mutates the store-owned `GameState` in place** and is called from
 * `sim.js`'s playing step. It is pure and Node-testable, exactly like `autopilot.js`: it imports
 * `core/math`, `core/rng`, `maze/constants` and `balance`, and it touches no DOM.
 *
 * ## Classic Descent cannot reach this file's work
 * `state.enemies` is an empty array outside New Descent, and the per-step entry point is gated by
 * the CALLER: `sim.js` tests the mode before it calls `stepCombat`, so a classic step does not even
 * make the call. That is not fastidiousness — a call into a big function passes `dt` by the tagged
 * convention, which boxes it, and `perf.test.mjs` measured 8 B/tick of garbage on a classic step
 * from a version that called through and returned on its first line. The level-lifecycle entry
 * points (`spawnEnemies`, `resetRunCombat`, `healOnOil`) take no float and guard themselves.
 *
 * ## Cost per step is O(awake enemies), and the population is capped
 * `COMBAT.MAX_ENEMIES` (40) is a constant independent of the maze, so nothing here scales with the
 * level — the §6 invariant holds by construction rather than by care:
 * - a **sleeping** enemy costs one squared-distance compare and nothing else;
 * - an **awake** enemy costs one `hasLineOfSight` DDA (bounded by `WORLD.LOS_MAX_CELLS`) and one
 *   `moveCircle` (bounded by `PLAYER.MAX_SUBSTEPS`);
 * - separation runs over **awake enemies only** — typically two or three, never more than 40, so the
 *   pair loop is bounded by a constant and not by the population of the floor;
 * - the pool is allocated once per run and re-seeded per level, so a descent allocates no enemies
 *   after the first floor that needs that many.
 *
 * ## Why the enemies do not pathfind
 * A BFS per enemy per replan would be O(tiles) × O(enemies), which §6 forbids outright. An awake
 * enemy instead **seeks with wall sliding**: it steers at the player (or, having lost sight, at the
 * last place it saw them) and its move goes through the same `moveCircle` solver the player uses, so
 * a corridor wall turns it down the corridor. That is a dumber hunter than a pathfinder and
 * deliberately so — in a corridor maze the corridor *is* the path, and a monster that solves the
 * labyrinth to reach you is not a monster a torch-lit corridor game wants.
 */

import { TILE } from '../maze/constants.js';
import { TAU, angleDiff, clamp01, wrapAngle } from '../core/math.js';
import { createRng } from '../core/rng.js';
import { BOB, COMBAT, PLAYER, combatParams, enemyStats } from './balance.js';

/** @typedef {import('../core/types.js').Enemy} Enemy */
/** @typedef {import('../core/types.js').EnemyKind} EnemyKind */
/** @typedef {import('../core/types.js').EnemyState} EnemyState */
/** @typedef {import('./sim.js').SimState} SimState */

// ─── Enemy states (the `Enemy.st` values of §3) ──────────────────────────────────────────────

export const ST_IDLE = 0;
export const ST_CHASE = 1;
export const ST_WIND = 2;
export const ST_STRIKE = 3;
export const ST_RECOVER = 4;
export const ST_STAGGER = 5;
export const ST_DEAD = 6;

// ─── Sword states (the `GameState.attack.st` values of §3) ───────────────────────────────────

export const SW_IDLE = 0;
export const SW_WIND = 1;
export const SW_STRIKE = 2;
export const SW_RECOVER = 3;

/**
 * Enemy kinds, in the order a spawn table indexes them. `runsave.js` stores this index, so the
 * order is part of the save format — append, never reorder.
 * @type {ReadonlyArray<EnemyKind>}
 */
export const ENEMY_KINDS = Object.freeze(/** @type {EnemyKind[]} */ (['crawler', 'wraith']));

/**
 * How often a spawn is a wraith, by depth. None at all on level 1 — the first floor teaches the
 * sword against the fast, cheap thing before it introduces the one that out-reaches it.
 * @param {number} level
 * @returns {number} 0..1
 */
function wraithChance(level) {
  if (level <= 1) return 0;
  if (level === 2) return 0.18;
  const t = clamp01((level - 2) / 10);
  return 0.18 + t * 0.27;
}

// ─── Module scratch (reused; never escapes a synchronous call) ───────────────────────────────

/** Collision I/O for an enemy move: in [x, y, dx, dy, r], out [x, y, lostDx, lostDy]. */
const _move = new Float64Array(5);

/**
 * This step's `dt`, handed over through a typed-array slot rather than as a call argument.
 *
 * Same rule as `sim.js`'s `stepDt`, and for the same measured reason: a non-integer passed to a
 * function the compiler declines to inline is boxed into a fresh HeapNumber on every call, and
 * `stepCombat` is far too big to inline. `perf.test.mjs` caught exactly that — 8 B/tick on a
 * **Classic Descent** step, from a call that then immediately returned.
 * @type {Float64Array}
 */
export const combatDt = new Float64Array(1);

/** Indices of the awake enemies this step, for the separation pass. */
const _awake = new Int32Array(COMBAT.MAX_ENEMIES);

// ─── Pool ────────────────────────────────────────────────────────────────────────────────────

/**
 * A blank pooled enemy. Every field is present from the start so the object's shape never changes,
 * which keeps the per-step property access monomorphic.
 * @param {number} id
 * @returns {Enemy}
 */
function createEnemy(id) {
  return {
    id,
    kind: 'crawler',
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    angle: 0,
    hp: 0,
    hpMax: 0,
    st: /** @type {EnemyState} */ (ST_DEAD),
    t: 0,
    cool: 0,
    anim: 0,
    lkx: 0,
    lky: 0,
    hunt: 0,
    hurt: 0,
    damage: 0,
    awake: false,
    // Seconds before this one can be staggered again (see `COMBAT.STAGGER_IMMUNE`).
    poise: 0,
  };
}

/**
 * Grow `state.enemies` to exactly `n` pooled enemies, reusing the objects already there.
 *
 * The array's length changes **only here** — that is, only on a level install — so no step ever
 * mutates it and the renderer's per-frame walk sees a stable shape. Slots past a shrink are dropped
 * rather than kept: a 40-enemy floor followed by a 3-enemy one should not leave 37 dead bodies for
 * every consumer to skip.
 * @param {SimState} state
 * @param {number} n
 * @returns {Enemy[]}
 */
function ensureEnemies(state, n) {
  let list = /** @type {Enemy[]} */ (/** @type {any} */ (state).enemies);
  if (!Array.isArray(list)) {
    list = [];
    /** @type {any} */ (state).enemies = list;
  }
  while (list.length < n) list.push(createEnemy(list.length));
  if (list.length > n) list.length = n;
  for (let i = 0; i < list.length; i++) list[i].id = i;
  return list;
}

// ─── Spawning ────────────────────────────────────────────────────────────────────────────────

/**
 * Populate the installed level with enemies (ARCHITECTURE.md §4.11).
 *
 * Called from the `levelReady` reducer, once per level, never per step. Deterministic: the stream is
 * forked from the run seed and the level, so a replayed run meets the same monsters in the same
 * places — and, because it is its own fork, adding a draw here can never reshuffle the maze, the
 * items or the boon offer (§4.1 `rng.fork`).
 *
 * Placement is **rejection sampling over random tiles**, capped at `TRIES_PER_ENEMY` attempts each:
 * O(count) with a constant bound, never a scan of the tile grid. A tile is accepted when it is
 * floor, far enough from the maze start that a floor cannot open in an ambush
 * (`COMBAT.SPAWN_CLEAR_TILES`), and not on the exit.
 * @param {SimState} state must have `levelData` installed
 * @returns {void}
 */
export function spawnEnemies(state) {
  if (state.mode !== 'combat') {
    ensureEnemies(state, 0);
    return;
  }
  const level = state.levelData;
  if (level === null) {
    ensureEnemies(state, 0);
    return;
  }
  const maze = level.maze;
  const w = maze.width;
  const h = maze.height;
  const tiles = maze.tiles;
  const params = combatParams(state.level);
  const list = ensureEnemies(state, params.count);
  if (list.length === 0) return;

  const rng = createRng(state.seed >>> 0).fork('foes' + state.level);
  const sx = Math.floor(maze.start.x) + 0.5;
  const sy = Math.floor(maze.start.y) + 0.5;
  const clear2 = COMBAT.SPAWN_CLEAR_TILES * COMBAT.SPAWN_CLEAR_TILES;
  const ex = Math.floor(maze.exit.x);
  const ey = Math.floor(maze.exit.y);
  const pWraith = wraithChance(state.level);
  const TRIES_PER_ENEMY = 48;

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const kind = /** @type {EnemyKind} */ (rng.chance(pWraith) ? 'wraith' : 'crawler');
    const stats = enemyStats(kind);
    let tx = -1;
    let ty = -1;
    for (let k = 0; k < TRIES_PER_ENEMY; k++) {
      // Odd coordinates are the cell centres of a thick-wall maze, so this lands on corridor tiles
      // far more often than a uniform draw would (§6 "thick-wall tile mazes").
      const cx = 1 + 2 * rng.int(Math.max(1, (w - 1) >> 1));
      const cy = 1 + 2 * rng.int(Math.max(1, (h - 1) >> 1));
      if (cx <= 0 || cy <= 0 || cx >= w || cy >= h) continue;
      if (tiles[cy * w + cx] !== TILE.FLOOR) continue;
      if (cx === ex && cy === ey) continue;
      const ddx = cx + 0.5 - sx;
      const ddy = cy + 0.5 - sy;
      if (ddx * ddx + ddy * ddy < clear2) continue;
      tx = cx;
      ty = cy;
      break;
    }
    if (tx < 0) {
      // A maze with nowhere legal to stand (a tiny fixture) simply gets fewer monsters.
      e.st = /** @type {EnemyState} */ (ST_DEAD);
      e.hp = 0;
      e.t = COMBAT.CORPSE_SECONDS;
      e.awake = false;
      continue;
    }
    e.kind = kind;
    e.x = tx + 0.5;
    e.y = ty + 0.5;
    e.px = e.x;
    e.py = e.y;
    e.angle = rng.next() * TAU - Math.PI;
    e.hpMax = Math.max(1, Math.round(stats.hp * params.hpMult));
    e.hp = e.hpMax;
    e.damage = Math.max(1, Math.round(stats.damage * params.damageMult));
    e.st = /** @type {EnemyState} */ (ST_IDLE);
    e.t = 0;
    e.cool = 0;
    e.anim = rng.next() * TAU;
    e.lkx = e.x;
    e.lky = e.y;
    e.hunt = 0;
    e.hurt = 0;
    e.poise = 0;
    e.awake = false;
  }
}

// ─── The player's sword ──────────────────────────────────────────────────────────────────────

/**
 * Open a swing, if the sword is idle.
 *
 * Called from the playing step when the `attack` action was pressed. Returns false (and does
 * nothing) mid-swing, so holding the button does not queue attacks — the recovery window is the
 * rhythm the fight is built on.
 * @param {SimState} state
 * @returns {boolean} true when a swing actually started
 */
export function startAttack(state) {
  const atk = state.attack;
  if (!atk) return false;
  if (atk.st !== SW_IDLE) {
    // Busy. Remember the press instead of dropping it: a press during the recovery window is the
    // player asking for the next swing at the first legal moment, and swallowing it is what makes a
    // weapon feel like it is ignoring the button. Only the recovery buffers — buffering during the
    // wind-up or the strike would queue a swing the player has not seen the result of yet.
    if (atk.st === SW_RECOVER) atk.buffer = COMBAT.ATTACK_BUFFER;
    return false;
  }
  atk.st = SW_WIND;
  atk.t = 0;
  atk.hits = 0;
  atk.buffer = 0;
  return true;
}

/**
 * Advance the sword and resolve its strike window.
 *
 * The window resolves **once** (`hits` is set the moment it runs), against every living enemy inside
 * `SWING.REACH` and within `SWING.ARC` radians of the view that the player can actually see. The
 * sight test is what stops a swing cutting through a corner into the corridor beyond.
 * @param {SimState} state
 * @param {number} dt
 * @returns {void}
 */
function stepSword(state, dt, held) {
  const atk = state.attack;
  if (!atk) return;
  if (atk.st === SW_IDLE) {
    // Held down, or a press buffered during the last recovery: swing again. Holding the button is
    // how every player tests a weapon, and one swing per press-and-hold reads as a broken control.
    if (held || atk.buffer > 0) {
      startAttack(state);
      return;
    }
    // Only ages while the sword is FREE, so a press lands whatever moment of the recovery it
    // arrived in. Ticking it down during the swing made the window a race against the recovery's
    // remaining time: the same press bought a swing early in the recovery and was silently dropped
    // late in it, which is exactly the inconsistency a buffer exists to remove.
    if (atk.buffer > 0) {
      atk.buffer -= dt;
      if (atk.buffer < 0) atk.buffer = 0;
    }
    return;
  }
  atk.t += dt;
  const S = COMBAT.SWING;
  if (atk.st === SW_WIND) {
    if (atk.t >= S.WIND_UP) {
      atk.st = SW_STRIKE;
      atk.t -= S.WIND_UP;
      resolveSwing(state);
    }
    return;
  }
  if (atk.st === SW_STRIKE) {
    if (atk.t >= S.STRIKE) {
      atk.st = SW_RECOVER;
      atk.t -= S.STRIKE;
    }
    return;
  }
  if (atk.t >= S.RECOVER) {
    atk.st = SW_IDLE;
    atk.t = 0;
  }
}

/**
 * Cut everything in the arc. Emits one `swing` event saying whether anything was hit, plus an
 * `enemyHit` per victim.
 * @param {SimState} state
 * @returns {void}
 */
function resolveSwing(state) {
  const list = state.enemies;
  const level = state.levelData;
  const p = state.player;
  const S = COMBAT.SWING;
  let hits = 0;
  if (level !== null && Array.isArray(list)) {
    const maze = level.maze;
    const cosArc = Math.cos(S.ARC);
    const cosA = Math.cos(p.angle);
    const sinA = Math.sin(p.angle);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.st === ST_DEAD) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const d2 = dx * dx + dy * dy;
      // The enemy's own body counts: a wide crawler is hit when its edge is in reach, not its centre.
      const reach = S.REACH + enemyStats(e.kind).radius;
      if (d2 > reach * reach) continue;
      const d = Math.sqrt(d2);
      // Something standing on top of the player is cut whichever way they are facing — which is what
      // a sword actually does, and what stops a crawler that has closed all the way being unhittable.
      if (d > 0.6) {
        if ((dx * cosA + dy * sinA) / d < cosArc) continue;
      }
      if (!seesPoint(maze, p.x, p.y, e.x, e.y)) continue;
      // Interrupting a telegraph is the thing the fight rewards.
      const punish = e.st === ST_WIND ? S.PUNISH : 0;
      damageEnemy(state, e, S.DAMAGE + punish);
      hits++;
    }
  }
  state.attack.hits = hits;
  state.events.push({ type: 'swing', hit: hits > 0 });
}

/**
 * Apply damage to one enemy, emitting `enemyHit` and scoring a kill.
 * @param {SimState} state
 * @param {Enemy} e
 * @param {number} amount
 * @returns {void}
 */
function damageEnemy(state, e, amount) {
  e.hp -= amount;
  e.hurt = 1;
  e.awake = true;
  if (e.poise > 0) {
    // Already reeling from the last one: this hit hurts but does not interrupt (see STAGGER_IMMUNE).
  }
  const killed = e.hp <= 0;
  if (killed) {
    e.hp = 0;
    e.st = /** @type {EnemyState} */ (ST_DEAD);
    e.t = 0;
    const run = state.run;
    run.kills++;
    const value = COMBAT.KILL_SCORE * state.level * enemyStats(e.kind).score;
    run.score += value;
    // A kill also feeds the purse the Shrine spends, at the same rate a gem does (§4.9): New
    // Descent's economy has to reward the thing New Descent is about.
    const progress = state.progress;
    if (progress) progress.purse += state.perks ? state.perks.gemPurse : 1;
  } else if (e.poise <= 0) {
    // Staggered out of whatever it was doing — including its own wind-up — and then immune to being
    // staggered again for `STAGGER_IMMUNE`, which is what stops a rhythm-swinger locking it down
    // for ever. The next hit still lands; it simply does not interrupt.
    e.st = /** @type {EnemyState} */ (ST_STAGGER);
    e.t = 0;
    e.poise = COMBAT.STAGGER_IMMUNE;
  }
  state.events.push({ type: 'enemyHit', kind: e.kind, x: e.x, y: e.y, damage: amount, killed });
}

/**
 * Apply damage to the player, respecting the invulnerability window.
 * @param {SimState} state
 * @param {Enemy} e the attacker
 * @returns {void}
 */
function damagePlayer(state, e) {
  const run = state.run;
  if (run.iframes > 0) return;
  const amount = e.damage;
  run.hp -= amount;
  run.iframes = COMBAT.IFRAMES;
  const p = state.player;
  const sh = p.shake + COMBAT.HIT_SHAKE;
  p.shake = sh > 1 ? 1 : sh;
  if (run.hp < 0) run.hp = 0;
  state.events.push({ type: 'playerHit', kind: e.kind, damage: amount, x: e.x, y: e.y });
}

// ─── Enemies ─────────────────────────────────────────────────────────────────────────────────

/**
 * Advance every enemy and the sword by one step.
 *
 * Called from `stepPlayingBody` after the player has moved and before the fuel drain, so an enemy
 * reacts to where the player actually ended up this step.
 * `dt` arrives in `combatDt[0]`, not as an argument — see the note on that array.
 * @param {SimState} state must be in `playing` with `levelData` installed, and in `'combat'`
 * @returns {void}
 */
export function stepCombat(state) {
  const dt = combatDt[0];
  const run = state.run;
  if (run.iframes > 0) {
    run.iframes -= dt;
    if (run.iframes < 0) run.iframes = 0;
  }
  stepSword(state, dt, state.sim.attackHeld === true);

  const list = state.enemies;
  const level = state.levelData;
  if (level === null || !Array.isArray(list) || list.length === 0) return;
  const maze = level.maze;
  const p = state.player;
  const wake2 = COMBAT.WAKE_TILES * COMBAT.WAKE_TILES;
  const lose2 = COMBAT.LOSE_TILES * COMBAT.LOSE_TILES;
  let awakeN = 0;

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    e.px = e.x;
    e.py = e.y;
    if (e.hurt > 0) {
      e.hurt -= dt * 4;
      if (e.hurt < 0) e.hurt = 0;
    }
    if (e.st === ST_DEAD) {
      if (e.t < COMBAT.CORPSE_SECONDS) e.t += dt;
      continue;
    }
    if (e.cool > 0) {
      e.cool -= dt;
      if (e.cool < 0) e.cool = 0;
    }
    if (e.poise > 0) {
      e.poise -= dt;
      if (e.poise < 0) e.poise = 0;
    }

    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;

    // A sleeping enemy costs exactly this much: one compare. That is what makes a 40-enemy floor
    // free until the player is actually among them.
    if (!e.awake) {
      if (d2 > wake2 || !seesPoint(maze, e.x, e.y, p.x, p.y)) {
        e.t += dt;
        continue;
      }
      e.awake = true;
      e.st = /** @type {EnemyState} */ (ST_CHASE);
      e.t = 0;
    }

    const sees = seesPoint(maze, e.x, e.y, p.x, p.y);
    if (sees) {
      e.lkx = p.x;
      e.lky = p.y;
      e.hunt = COMBAT.HUNT_SECONDS;
    } else {
      e.hunt -= dt;
      if (e.hunt <= 0 && d2 > lose2) {
        // Lost them: back to sleep, facing where they went.
        e.awake = false;
        e.st = /** @type {EnemyState} */ (ST_IDLE);
        e.t = 0;
        continue;
      }
    }

    _awake[awakeN++] = i;
    stepEnemy(state, e, dt, dx, dy, d2, sees);
  }

  separate(list, awakeN, dt);
  updateThreat(state, list);
}

/**
 * One awake enemy's state machine and movement.
 * @param {SimState} state
 * @param {Enemy} e
 * @param {number} dt
 * @param {number} dx player x minus enemy x
 * @param {number} dy player y minus enemy y
 * @param {number} d2 squared distance to the player
 * @param {boolean} sees line of sight to the player right now
 * @returns {void}
 */
function stepEnemy(state, e, dt, dx, dy, d2, sees) {
  const stats = enemyStats(e.kind);
  e.t += dt;
  const st = e.st;

  if (st === ST_WIND) {
    faceToward(e, dx, dy, dt, 0.5);
    if (e.t >= stats.windUp) {
      e.st = /** @type {EnemyState} */ (ST_STRIKE);
      e.t = 0;
      // The blow lands on the frame the strike opens. Reach is measured from body edge to body
      // edge, and a player who has already stepped out of it is missed — which is what makes the
      // long telegraph of a wraith a thing you can answer by moving.
      const reach = stats.reach + PLAYER.RADIUS;
      if (d2 <= reach * reach && sees) damagePlayer(state, e);
    }
    return;
  }
  if (st === ST_STRIKE) {
    if (e.t >= stats.strike) {
      e.st = /** @type {EnemyState} */ (ST_RECOVER);
      e.t = 0;
    }
    return;
  }
  if (st === ST_RECOVER) {
    if (e.t >= stats.recover) {
      e.st = /** @type {EnemyState} */ (ST_CHASE);
      e.t = 0;
      e.cool = 0;
    }
    return;
  }
  if (st === ST_STAGGER) {
    // Knocked back a little, so a hit reads as an impact rather than as a number going down.
    if (e.t >= stats.stagger) {
      e.t = 0;
      // Coming out of a stagger inside its own reach, it hits back immediately rather than walking
      // in again: standing in front of something you have just interrupted has to cost something,
      // or the interrupt is a free stun rather than a trade.
      const back = stats.reach + PLAYER.RADIUS;
      if (sees && d2 <= back * back) {
        e.st = /** @type {EnemyState} */ (ST_WIND);
        e.cool = stats.windUp + stats.strike + stats.recover;
      } else {
        e.st = /** @type {EnemyState} */ (ST_CHASE);
      }
    } else {
      const d = Math.sqrt(d2);
      if (d > 1e-6) moveEnemy(state, e, (-dx / d) * stats.speed * 0.55, (-dy / d) * stats.speed * 0.55, dt);
      faceToward(e, dx, dy, dt, 1);
    }
    return;
  }

  // ── chase ──
  const reach = stats.reach + PLAYER.RADIUS;
  if (sees && d2 <= reach * reach && e.cool <= 0) {
    e.st = /** @type {EnemyState} */ (ST_WIND);
    e.t = 0;
    e.cool = stats.windUp + stats.strike + stats.recover;
    return;
  }
  // Toward the player when they can be seen, otherwise toward where they last were.
  const tx = sees ? dx : e.lkx - e.x;
  const ty = sees ? dy : e.lky - e.y;
  const d = Math.sqrt(tx * tx + ty * ty);
  faceToward(e, tx, ty, dt, 1);
  if (d < 0.08) {
    // Arrived at the last-known spot with nothing there: stand and look around rather than jitter.
    if (!sees) e.hunt = Math.min(e.hunt, 0.6);
    return;
  }
  // A crawler that is already on top of the player stops pushing: it is the reach that closes the
  // fight, not the shove.
  const stop = reach * 0.85;
  const dPlayer = Math.sqrt(d2);
  const gain = sees && dPlayer < stop ? 0 : 1;
  if (gain === 0) return;
  moveEnemy(state, e, (tx / d) * stats.speed, (ty / d) * stats.speed, dt);
}

/**
 * Move an enemy through the maze with wall sliding, and advance its gait phase by the distance it
 * actually covered (the same rule the player's head bob follows, so a monster pressed against a
 * wall stops walking on the spot).
 * @param {SimState} state
 * @param {Enemy} e
 * @param {number} vx tiles/second
 * @param {number} vy tiles/second
 * @param {number} dt
 * @returns {void}
 */
function moveEnemy(state, e, vx, vy, dt) {
  const level = state.levelData;
  if (level === null) return;
  const maze = level.maze;
  _move[0] = e.x;
  _move[1] = e.y;
  _move[2] = vx * dt;
  _move[3] = vy * dt;
  _move[4] = enemyStats(e.kind).radius;
  moveCircleInto(maze.tiles, maze.width, maze.height, _move);
  const mx = _move[0] - e.x;
  const my = _move[1] - e.y;
  e.x = _move[0];
  e.y = _move[1];
  const moved = Math.sqrt(mx * mx + my * my);
  if (moved > 0) {
    const a = e.anim + moved * (TAU / BOB.STRIDE_TILES);
    e.anim = a % TAU;
  }
}

/**
 * Ease an enemy's facing toward a direction.
 * @param {Enemy} e
 * @param {number} dx
 * @param {number} dy
 * @param {number} dt
 * @param {number} scale 0..1 fraction of the full turn rate
 * @returns {void}
 */
function faceToward(e, dx, dy, dt, scale) {
  if (dx === 0 && dy === 0) return;
  const want = Math.atan2(dy, dx);
  const err = angleDiff(e.angle, want);
  const rate = PLAYER.TURN_SPEED * scale * dt;
  if (err > rate) e.angle = wrapAngle(e.angle + rate);
  else if (err < -rate) e.angle = wrapAngle(e.angle - rate);
  else e.angle = want;
}

/**
 * Push awake enemies apart so a pack reads as several monsters rather than as one.
 *
 * The pair loop is over the **awake** list, which is two or three in practice and `MAX_ENEMIES` at
 * the absolute worst — a constant either way, so this is O(1) in the level like everything else here.
 * The push is a position nudge rather than a force: it is cosmetic, and running it through the
 * collision solver as well would let a crowd shove a body through a wall.
 * @param {Enemy[]} list
 * @param {number} n how many leading entries of `_awake` are valid
 * @param {number} dt
 * @returns {void}
 */
function separate(list, n, dt) {
  for (let a = 0; a < n; a++) {
    const ea = list[_awake[a]];
    for (let b = a + 1; b < n; b++) {
      const eb = list[_awake[b]];
      const dx = eb.x - ea.x;
      const dy = eb.y - ea.y;
      const want = enemyStats(ea.kind).radius + enemyStats(eb.kind).radius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= want * want || d2 < 1e-9) continue;
      const d = Math.sqrt(d2);
      const push = ((want - d) * 0.5) * Math.min(1, dt * 8);
      const nx = (dx / d) * push;
      const ny = (dy / d) * push;
      ea.x -= nx;
      ea.y -= ny;
      eb.x += nx;
      eb.y += ny;
    }
  }
}

/**
 * Recompute `derived.threat` — how close the nearest living, awake enemy is, 0..1. Audio rides it
 * and the post stack tints with it, so it must be a smooth function of distance rather than a flag.
 * @param {SimState} state
 * @param {Enemy[]} list
 * @returns {void}
 */
function updateThreat(state, list) {
  const p = state.player;
  let near2 = Infinity;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.st === ST_DEAD || !e.awake) continue;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < near2) near2 = d2;
  }
  if (!(near2 < Infinity)) {
    state.derived.threat = 0;
    return;
  }
  const d = Math.sqrt(near2);
  const range = COMBAT.WAKE_TILES;
  state.derived.threat = d >= range ? 0 : 1 - d / range;
}

// ─── Shared primitives ───────────────────────────────────────────────────────────────────────

/**
 * `sim.js`'s line-of-sight, called through a lazy binding.
 *
 * `sim.js` imports this module (it calls `stepCombat`), so importing `sim.js` back would be a cycle.
 * The two functions this file needs from it are installed by `sim.js` at module load instead —
 * which keeps the dependency edge one-way (`sim.js → combat.js`) and keeps the collision and
 * sight rules **literally the same code** the player obeys, rather than a second copy that could
 * drift.
 * @type {((tiles:Uint8Array, w:number, h:number, x0:number, y0:number, x1:number, y1:number) => boolean)|null}
 */
let losFn = null;

/** @type {((tiles:Uint8Array, w:number, h:number, io:Float64Array) => number)|null} */
let moveFn = null;

/**
 * Install the sim's collision and sight primitives. Called once, by `sim.js`, at module load.
 * @param {(tiles:Uint8Array, w:number, h:number, x0:number, y0:number, x1:number, y1:number) => boolean} los
 * @param {(tiles:Uint8Array, w:number, h:number, io:Float64Array) => number} move
 * @returns {void}
 */
export function installPrimitives(los, move) {
  losFn = los;
  moveFn = move;
}

/**
 * Line of sight between two world points, through the sim's own DDA.
 * @param {import('../core/types.js').Maze} maze
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @returns {boolean}
 */
function seesPoint(maze, x0, y0, x1, y1) {
  if (losFn === null) return true;
  return losFn(maze.tiles, maze.width, maze.height, x0, y0, x1, y1);
}

/**
 * Circle-vs-tile movement through the sim's own solver.
 * @param {Uint8Array} tiles @param {number} w @param {number} h @param {Float64Array} io
 * @returns {number}
 */
function moveCircleInto(tiles, w, h, io) {
  if (moveFn === null) {
    io[0] += io[2];
    io[1] += io[3];
    return 0;
  }
  return moveFn(tiles, w, h, io);
}

// ─── Level / run lifecycle ───────────────────────────────────────────────────────────────────

/**
 * Reset the player's combat state for a new level (health is per RUN, not per level — it is the
 * thing a descent spends, and refilling it at every portal would make the sword free).
 * @param {SimState} state
 * @returns {void}
 */
export function resetLevelCombat(state) {
  const atk = state.attack;
  if (atk) {
    atk.st = SW_IDLE;
    atk.t = 0;
    atk.hits = 0;
  }
  state.run.iframes = 0;
  state.derived.threat = 0;
}

/**
 * Reset the player's combat state for a new run: full health in New Descent, none in Classic (where
 * `hpMax` of 0 is what every consumer reads as "this mode has no health bar").
 * @param {SimState} state
 * @returns {void}
 */
export function resetRunCombat(state) {
  const run = state.run;
  run.hpMax = state.mode === 'combat' ? COMBAT.PLAYER_HP : 0;
  run.hp = run.hpMax;
  run.kills = 0;
  run.iframes = 0;
  resetLevelCombat(state);
  ensureEnemies(state, 0);
}

/**
 * Mend the player when an oil flask is taken (§4.11): the existing economy is the healing economy,
 * so New Descent needs no second pickup and the flask chain still proves the level is survivable.
 * @param {SimState} state
 * @returns {void}
 */
export function healOnOil(state) {
  if (state.mode !== 'combat') return;
  const run = state.run;
  if (run.hpMax <= 0) return;
  const hp = run.hp + COMBAT.HEAL_PER_OIL;
  run.hp = hp > run.hpMax ? run.hpMax : hp;
}

/**
 * Has the player run out of health? Checked by the playing step beside the fuel-out test.
 * @param {SimState} state
 * @returns {boolean}
 */
export function isPlayerDead(state) {
  return state.mode === 'combat' && state.run.hpMax > 0 && state.run.hp <= 0;
}
