// @ts-check
/**
 * @file New Descent's combat simulation (ARCHITECTURE.md §4.11).
 *
 * Driven through the **real reducer** rather than by calling `combat.js` directly wherever it can
 * be: the thing worth proving is that a swing dispatched as an `attack` press reaches an enemy, not
 * that an internal function does what it says. Levels are built with the real generator, like
 * `feasibility.test.mjs` — a combat proof over a fake maze would prove nothing about wall sliding,
 * line of sight or spawn placement.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState, reducer } from './game.js';
import { COMBAT, combatParams, enemyStats, levelParams } from './balance.js';
import { ENEMY_KINDS, ST_DEAD, ST_WIND } from './combat.js';
import { buildLevel } from '../maze/level.js';

/** A level built by the real generator. @param {number} level @param {number} seed */
const level = (level_, seed) => buildLevel(levelParams(level_), seed);

/**
 * A state in `playing`, in the given mode, on a real level.
 * @param {'classic'|'combat'} mode
 * @param {number} [lv]
 * @param {number} [seed]
 */
function run(mode, lv = 1, seed = 4242) {
  const s = createInitialState();
  reducer(s, { type: 'newGame', seed, mode });
  // The depth the level was BUILT for has to be the depth the state is on: `spawnEnemies` reads
  // `state.level` for its curve, so installing a level-8 maze on a state that still says 1 would
  // populate it with a level-1 crowd. `newGame` always starts at 1, so the fixture sets it.
  s.level = lv;
  reducer(s, { type: 'levelReady', data: level(lv, seed) });
  assert.equal(s.phase, 'playing');
  return s;
}

/**
 * One tick. `press` are the edges this step; `held` is the sword button still being down, which the
 * real input funnel reports separately because `pressed` can only carry an edge (§4.11).
 * @param {any} s @param {number} [n] @param {string[]} [press] @param {boolean} [held]
 */
function tick(s, n = 1, press = [], held = false) {
  const input = { moveX: 0, moveY: 0, turn: 0, lookDX: 0, pressed: new Set(press), attackHeld: held };
  for (let i = 0; i < n; i++) reducer(s, { type: 'tick', dt: 1 / 60, input });
}

/** Every event of a type emitted by the last dispatch. @param {any} s @param {string} type */
const events = (s, type) => s.events.filter((/** @type {any} */ e) => e.type === type);

// ─── Classic Descent is untouched ────────────────────────────────────────────────────────────

test('classic: no enemies, no health, and not one combat event however long it runs', () => {
  const s = run('classic', 2);
  assert.deepEqual(s.enemies, [], 'no enemies are spawned');
  assert.equal(s.run.hpMax, 0, 'hpMax 0 is what every consumer reads as "no health in this mode"');
  assert.equal(s.run.hp, 0);
  assert.equal(s.derived.threat, 0);

  /** @type {string[]} */
  const seen = [];
  for (let i = 0; i < 600; i++) {
    // `attack` pressed on every single step: in Classic Descent it must do nothing at all.
    tick(s, 1, ['attack']);
    for (const e of s.events) seen.push(e.type);
  }
  for (const t of ['swing', 'enemyHit', 'playerHit']) {
    assert.equal(seen.includes(t), false, `classic emitted "${t}"`);
  }
  assert.equal(s.attack.st, 0, 'the sword never leaves idle');
  assert.equal(s.derived.threat, 0);
});

// ─── Spawning ────────────────────────────────────────────────────────────────────────────────

test('spawn: the curve’s count, on floor, clear of the start, never on the exit', () => {
  for (const lv of [1, 2, 5, 9]) {
    const s = run('combat', lv);
    const want = combatParams(lv).count;
    assert.equal(s.enemies.length, want, `level ${lv}: ${want} enemies`);
    const maze = s.levelData.maze;
    const sx = Math.floor(maze.start.x) + 0.5;
    const sy = Math.floor(maze.start.y) + 0.5;
    const clear2 = COMBAT.SPAWN_CLEAR_TILES * COMBAT.SPAWN_CLEAR_TILES;
    for (const e of s.enemies) {
      if (e.st === ST_DEAD) continue; // a tiny maze may have nowhere legal to stand
      const tx = Math.floor(e.x);
      const ty = Math.floor(e.y);
      assert.equal(maze.tiles[ty * maze.width + tx], 0, `level ${lv}: enemy ${e.id} stands on floor`);
      assert.notEqual(`${tx},${ty}`, `${maze.exit.x},${maze.exit.y}`, 'never on the exit');
      const dx = e.x - sx;
      const dy = e.y - sy;
      assert.ok(dx * dx + dy * dy >= clear2, `level ${lv}: enemy ${e.id} is clear of the start`);
      assert.ok(e.hp > 0 && e.hp === e.hpMax, 'spawns at full health');
      assert.equal(e.awake, false, 'nothing starts awake');
    }
  }
});

test('spawn: never more than the cap, however deep', () => {
  for (const lv of [15, 30, 90]) {
    assert.ok(combatParams(lv).count <= COMBAT.MAX_ENEMIES, `level ${lv} within the cap`);
  }
  const s = run('combat', 30);
  assert.ok(s.enemies.length <= COMBAT.MAX_ENEMIES);
});

test('spawn: deterministic for a seed, and independent of the item placement', () => {
  const a = run('combat', 3, 991);
  const b = run('combat', 3, 991);
  assert.deepEqual(
    a.enemies.map((/** @type {any} */ e) => [e.kind, e.x, e.y, e.hpMax]),
    b.enemies.map((/** @type {any} */ e) => [e.kind, e.x, e.y, e.hpMax]),
  );
  // The enemy stream is its own fork, so the items a level carries are byte-identical in both modes.
  const classic = run('classic', 3, 991);
  assert.deepEqual(
    classic.levelData.items.map((/** @type {any} */ i) => [i.kind, i.x, i.y]),
    a.levelData.items.map((/** @type {any} */ i) => [i.kind, i.x, i.y]),
    'adding monsters cannot move a single flask (§4.11: the placement guarantee is untouched)',
  );
});

test('spawn: level 1 is crawlers only, and wraiths appear deeper', () => {
  const one = run('combat', 1);
  for (const e of one.enemies) assert.equal(e.kind, 'crawler', 'the first floor teaches the sword on crawlers');
  let sawWraith = false;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    for (const e of run('combat', 8, seed).enemies) if (e.kind === 'wraith') sawWraith = true;
  }
  assert.ok(sawWraith, 'wraiths are reachable by level 8');
});

// ─── The sword ───────────────────────────────────────────────────────────────────────────────

/** Put the player `d` tiles from enemy 0 and point them at it. @param {any} s @param {number} d */
function faceFirstEnemy(s, d) {
  const e = s.enemies.find((/** @type {any} */ x) => x.st !== ST_DEAD);
  assert.ok(e !== undefined, 'the level has a living enemy');
  const p = s.player;
  p.x = e.x - d;
  p.y = e.y;
  p.px = p.x;
  p.py = p.y;
  p.angle = 0; // +x, straight at it
  p.pangle = 0;
  return e;
}

test('sword: a press opens one swing, and a HELD button keeps swinging', () => {
  const s = run('combat', 1);
  faceFirstEnemy(s, 3);
  tick(s, 1, ['attack'], true);
  assert.equal(s.attack.st, 1, 'wind-up');
  const S = COMBAT.SWING;
  const cycle = S.WIND_UP + S.STRIKE + S.RECOVER;
  // Hold it down for three cycles' worth of steps. Holding a weapon's button is what every player
  // does first, and one swing per press-and-hold reads as a broken control.
  let swings = 0;
  for (let i = 0; i < Math.ceil(cycle * 3 * 60); i++) {
    tick(s, 1, [], true);
    swings += events(s, 'swing').length;
  }
  assert.ok(swings >= 2, `a held button keeps swinging (${swings} in three cycles)`);

  // Let go, and it stops at the end of the swing in flight.
  let after = 0;
  for (let i = 0; i < Math.ceil(cycle * 2 * 60); i++) {
    tick(s, 1, [], false);
    after += events(s, 'swing').length;
  }
  assert.ok(after <= 1, 'releasing stops it');
  assert.equal(s.attack.st, 0, 'and the sword comes back to rest');
});

test('sword: a press during the recovery is remembered, not dropped', () => {
  const s = run('combat', 1);
  faceFirstEnemy(s, 3);
  const S = COMBAT.SWING;
  tick(s, 1, ['attack']);
  // Land inside the recovery window and press there. Tapping on the beat is how a player asks for
  // the next swing, and swallowing that press makes the weapon feel like it is ignoring them.
  tick(s, Math.ceil((S.WIND_UP + S.STRIKE) * 60) + 1);
  assert.equal(s.attack.st, 3, 'recovering');
  tick(s, 1, ['attack']);
  assert.ok(s.attack.buffer > 0, 'the press was buffered');
  // Long enough for the recovery to finish AND the queued swing to reach its own strike window,
  // which is where the `swing` event is emitted.
  let swings = 0;
  for (let i = 0; i < Math.ceil((S.RECOVER + S.WIND_UP + S.STRIKE) * 60) + 6; i++) {
    tick(s, 1);
    swings += events(s, 'swing').length;
  }
  assert.equal(swings, 1, 'the buffered press became exactly one further swing');
});

test('sword: the strike window resolves once, and only within reach and arc', () => {
  const s = run('combat', 1);
  const e = faceFirstEnemy(s, 1.0);
  const hp0 = e.hp;
  tick(s, 12, ['attack']);
  // Somewhere in those 12 steps the strike window opened.
  assert.ok(e.hp < hp0, 'the enemy was cut');
  const dealt = hp0 - e.hp;
  assert.ok(dealt >= COMBAT.SWING.DAMAGE, `at least the base damage (${dealt})`);

  // Out of reach: nothing.
  const far = run('combat', 1);
  const e2 = faceFirstEnemy(far, COMBAT.SWING.REACH + 2);
  const before = e2.hp;
  tick(far, 12, ['attack']);
  assert.equal(e2.hp, before, 'a swing at nothing hits nothing');

  // In reach but behind: nothing. (Facing away, same distance that just worked.)
  const back = run('combat', 1);
  const e3 = faceFirstEnemy(back, 1.0);
  back.player.angle = Math.PI;
  back.player.pangle = Math.PI;
  const before3 = e3.hp;
  tick(back, 12, ['attack']);
  assert.equal(e3.hp, before3, 'the arc is in front of the player, not around them');
});

test('sword: a kill scores, fills the purse and leaves a corpse that stops being live', () => {
  const s = run('combat', 1);
  const e = faceFirstEnemy(s, 0.9);
  const score0 = s.run.score;
  const purse0 = s.progress.purse;
  let guard = 0;
  while (e.st !== ST_DEAD && guard++ < 600) tick(s, 1, ['attack']);
  assert.equal(e.st, ST_DEAD, 'it died');
  assert.equal(e.hp, 0);
  assert.equal(s.run.kills, 1);
  assert.ok(s.run.score > score0, 'a kill scores');
  assert.equal(s.run.score - score0, COMBAT.KILL_SCORE * s.level * enemyStats(e.kind).score);
  assert.ok(s.progress.purse > purse0, 'and feeds the purse the Shrine spends');
  // A dead enemy is inert: no more damage, no more threat from it.
  const hp = s.run.hp;
  tick(s, 240);
  assert.equal(s.run.hp, hp, 'a corpse cannot hit back');
});

test('enemies: a staggered one cannot be stun-locked by swinging on rhythm', () => {
  // THE bug the gauntlet found: every non-killing hit re-staggered, and stagger + wind-up is longer
  // than the sword's whole cycle for both kinds — so a player holding the button took literally zero
  // damage, for ever, from anything. `COMBAT.STAGGER_IMMUNE` is what buys the fight back.
  const s = run('combat', 1);
  const e = faceFirstEnemy(s, 0.85);
  e.awake = true;
  // Give it enough health that it survives the whole exchange, so this measures the loop and not
  // a lucky kill.
  e.hpMax = 4000;
  e.hp = 4000;
  let guard = 0;
  const hp0 = s.run.hp;
  while (s.run.hp === hp0 && guard++ < 60 * 25) tick(s, 1, ['attack'], true);
  assert.ok(s.run.hp < hp0, 'swinging on rhythm does NOT make the player invulnerable');
  assert.ok(guard < 60 * 25, `it got a hit in within ${(guard / 60).toFixed(1)}s`);
});

test('sword: interrupting a wind-up hits harder than a clean swing', () => {
  const s = run('combat', 1);
  const e = faceFirstEnemy(s, 0.9);
  e.st = ST_WIND;
  e.t = 0;
  e.awake = true;
  const hp0 = e.hp;
  // Resolve the strike while it is still in its telegraph.
  tick(s, 7, ['attack']);
  // Read the damage off the event rather than the health difference: a crawler has 30 hit points
  // and an interrupted swing does 34, so the difference is clamped by the kill and would under-report.
  const hit = s.events.filter((/** @type {any} */ x) => x.type === 'enemyHit');
  assert.ok(hp0 > e.hp, 'it connected');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].damage, COMBAT.SWING.DAMAGE + COMBAT.SWING.PUNISH, 'the interrupt bonus applied');
});

// ─── Enemies ─────────────────────────────────────────────────────────────────────────────────

test('enemies: a sleeping one is inert, and seeing the player wakes it', () => {
  const s = run('combat', 2);
  const e = s.enemies.find((/** @type {any} */ x) => x.st !== ST_DEAD);
  // Park the player far away: nothing must wake.
  s.player.x = 1.5;
  s.player.y = 1.5;
  tick(s, 120);
  const sleeping = s.enemies.filter((/** @type {any} */ x) => x.st !== ST_DEAD && !x.awake).length;
  const alive = s.enemies.filter((/** @type {any} */ x) => x.st !== ST_DEAD).length;
  assert.equal(sleeping, alive, 'nothing woke from across the maze');

  // A tile away, not two: at two the straight line between them can cross masonry, and then the
  // creature is correctly asleep and the test is measuring the maze rather than the waking rule.
  faceFirstEnemy(s, 1);
  tick(s, 5);
  assert.equal(e.awake, true, 'it noticed the player standing in front of it');
  assert.ok(s.derived.threat > 0, 'and the threat readout followed');
});

test('enemies: one that reaches the player damages them, once per hit, with i-frames', () => {
  const s = run('combat', 1);
  const e = faceFirstEnemy(s, 0.8);
  e.awake = true;
  const hp0 = s.run.hp;
  let guard = 0;
  while (s.run.hp === hp0 && guard++ < 900) tick(s, 1);
  assert.ok(s.run.hp < hp0, 'it landed a blow');
  const hit = events(s, 'playerHit');
  assert.ok(s.run.iframes > 0, 'a hit opens the invulnerability window');
  // Inside the window a second blow cannot land.
  const hp1 = s.run.hp;
  for (const other of s.enemies) {
    if (other.st === ST_DEAD) continue;
    other.x = s.player.x + 0.3;
    other.y = s.player.y;
    other.awake = true;
  }
  tick(s, 2);
  assert.equal(s.run.hp, hp1, 'i-frames hold a second attacker off');
  assert.ok(hit.length <= 1);
});

test('enemies: running out of health ends the run exactly as a dead torch does', () => {
  const s = run('combat', 1);
  s.run.hp = 1;
  const e = faceFirstEnemy(s, 0.8);
  e.awake = true;
  let guard = 0;
  while (s.phase === 'playing' && guard++ < 1800) tick(s, 1);
  assert.equal(s.phase, 'gameOver');
  assert.equal(s.run.hp, 0);
});

test('enemies: they never leave the floor, however long they hunt', () => {
  const s = run('combat', 4, 77);
  const maze = s.levelData.maze;
  faceFirstEnemy(s, 3);
  for (const e of s.enemies) e.awake = true;
  for (let i = 0; i < 1200; i++) {
    tick(s, 1);
    if (s.phase !== 'playing') break;
    for (const e of s.enemies) {
      if (e.st === ST_DEAD) continue;
      const tx = Math.floor(e.x);
      const ty = Math.floor(e.y);
      assert.ok(tx >= 0 && ty >= 0 && tx < maze.width && ty < maze.height, 'inside the maze');
      assert.equal(maze.tiles[ty * maze.width + tx], 0, `enemy ${e.id} walked into a wall at step ${i}`);
    }
  }
});

test('enemies: an oil flask mends as well as refuels, and never past full', () => {
  const s = run('combat', 1);
  s.run.hp = 10;
  s.run.fuel = 5;
  const flask = s.levelData.items.find((/** @type {any} */ i) => i.kind === 'oil' && !i.taken);
  assert.ok(flask !== undefined);
  s.player.x = flask.x;
  s.player.y = flask.y;
  s.player.px = flask.x;
  s.player.py = flask.y;
  tick(s, 1);
  assert.equal(flask.taken, true);
  assert.equal(s.run.hp, 10 + COMBAT.HEAL_PER_OIL);
  // At full health a flask still refuels and does not overflow health.
  s.run.hp = s.run.hpMax;
  s.run.fuel = 5;
  const flask2 = s.levelData.items.find((/** @type {any} */ i) => i.kind === 'oil' && !i.taken);
  if (flask2 !== undefined) {
    s.player.x = flask2.x;
    s.player.y = flask2.y;
    s.player.px = flask2.x;
    s.player.py = flask2.y;
    tick(s, 1);
    assert.equal(s.run.hp, s.run.hpMax, 'health never exceeds the maximum');
  }
});

// ─── Mode plumbing ───────────────────────────────────────────────────────────────────────────

test('modes: each keeps its own purse, ranks and record, and they never mix', () => {
  const s = createInitialState();
  s.profiles.classic.progress.purse = 500;
  s.profiles.combat.progress.purse = 20;
  s.profiles.classic.best.score = 9000;

  reducer(s, { type: 'newGame', seed: 1, mode: 'combat' });
  assert.equal(s.mode, 'combat');
  assert.equal(s.progress, s.profiles.combat.progress, 'progress is the live combat profile');
  assert.equal(s.best, s.profiles.combat.best);
  assert.equal(s.progress.purse, 20);

  // Gems picked up in New Descent go into the New Descent purse and nowhere near the other one.
  reducer(s, { type: 'levelReady', data: level(1, 1) });
  const gem = s.levelData.items.find((/** @type {any} */ i) => i.kind === 'gem' && !i.taken);
  s.player.x = gem.x;
  s.player.y = gem.y;
  s.player.px = gem.x;
  s.player.py = gem.y;
  tick(s, 1);
  assert.ok(s.profiles.combat.progress.purse > 20, 'the combat purse grew');
  assert.equal(s.profiles.classic.progress.purse, 500, 'the classic purse did not');

  // And switching back re-points the live references. (`toTitle` is honoured from `paused`, not
  // from `playing`: a run in progress is abandoned deliberately — §4.2.)
  reducer(s, { type: 'pause' });
  reducer(s, { type: 'toTitle' });
  reducer(s, { type: 'newGame', seed: 1, mode: 'classic' });
  assert.equal(s.progress.purse, 500);
  assert.equal(s.best.score, 9000);
});

test('modes: the Shrine is shut on the title now that each mode owns a purse', () => {
  const s = createInitialState();
  s.profiles.classic.progress.purse = 9999;
  reducer(s, { type: 'buyUnlock', id: 'reservoir' });
  assert.equal(s.progress.purse, 9999, 'a purchase from the title buys nothing (§4.11)');
  s.phase = 'gameOver';
  reducer(s, { type: 'buyUnlock', id: 'reservoir' });
  assert.ok(s.progress.purse < 9999, 'game over is one of the two screens it IS open from');
});

test('modes: an enemy kind index is stable, because saves store it', () => {
  assert.deepEqual([...ENEMY_KINDS], ['crawler', 'wraith']);
});
