// @ts-check
/**
 * @file Auto Explore (ARCHITECTURE.md §4.10) — an autopilot that plays a level through the same
 * `InputFrame` a keyboard produces. It never writes the state: `src/main.js` hands its axes to the
 * reducer on the ordinary `tick`, so every rule of the sim (collision, fuel, pickups, the exit)
 * applies to it exactly as it does to a player.
 *
 * ## What it does
 * It explores the fog of war at random. A plan is one breadth-first search over floor tiles from
 * the player, which collects, nearest first:
 * - the nearest **seen** oil flask, when the tank is below `AUTO.REFUEL_AT` *or* too low for the
 *   distance: a flask is only worth passing while the torch still covers `AUTO.REFUEL_MARGIN` times
 *   the way there plus `REFUEL_RESERVE_TILES` of slack (half a tank is plenty three tiles from a
 *   flask and nowhere near enough eighty tiles from one);
 * - the nearest **seen** gem or map scroll within `AUTO.ITEM_DETOUR` path tiles;
 * - the nearest **frontier** tile (explored floor with an unexplored floor neighbour), a tie between
 *   frontiers within `AUTO.FRONTIER_TIE` path tiles — a junction's branches — broken at random. A
 *   frontier reached by first stepping *behind* the player costs `AUTO.BACKTRACK_COST` extra tiles,
 *   so uncovering a goal early does not turn it round on a corridor that still leads on;
 * - the exit, once it has been seen and the level has been wandered for a rolled share of its par
 *   time (or nothing is left to explore, or the torch is nearly out). Past that share with the exit
 *   still unseen, the frontier choice turns greedy toward the exit's position instead of random.
 * It only ever targets what the reveal has uncovered, so it plays the same fog the player does —
 * with one deliberate exception, the **survival valve**: below `AUTO.SMELL_AT` with no flask on any
 * explored tile, it walks to the nearest flask on the level whether the fog has lifted off it or not.
 * A watch mode that runs the torch dry costs the player their saved run (main.js clears it on
 * `gameOver`), and a fog-bound explorer in a 128×128 labyrinth strands itself reliably: over levels
 * 1–10 × 8 seeds it cleared 74 % of runs. With the valve, the distance rule above and a `TOPUP_AT`
 * low enough that a detour for a flask is not spent filling a quarter of one, it clears 79 of those
 * 80 runs (and 39 of 40 on the test's own seeds), which `autopilot.test.mjs` gates at 95 %.
 *
 * ## How it moves: like the title screen
 * Auto Explore is for watching, so it walks with the title camera's calm rather than a player's
 * urgency, and borrows its numbers from `ATTRACT` directly so the two cannot drift apart: cruise
 * at `ATTRACT.SPEED` (about half the walking pace), a commanded turn rate capped at
 * `ATTRACT.TURN_RATE` and eased at `TURN_EASE_RATE`, a speed that falls off with the heading error
 * and eases at `SPEED_EASE_RATE`, waypoints passed `ARRIVE` early, and the same slow sway. The aim
 * is its own: pure pursuit, `AUTO.PURSUIT` tiles along the route, so it turns before a corner. Speed and turn rate survive a replan, so a new goal bends
 * the path instead of stopping the walk. The torch still drains in real time, so the slower pace
 * costs oil per tile — a deliberate trade for a watching mode.
 *
 * ## Cost (the massive-maze rule, §6)
 * Steering is O(1) per step. The search is O(tiles) and runs **only on a replan** — a route
 * finished, a goal vanished, the tank crossed a threshold, or the body got stuck — and never twice
 * within `AUTO.REPLAN_COOLDOWN_STEPS` unless the route ran out. Every buffer is a grow-only typed
 * array (a `visited` generation stamp avoids clearing), so a plan allocates nothing and a step
 * allocates nothing.
 */

import { angleDiff, clamp, damp } from '../core/math.js';
import { createRng } from '../core/rng.js';
import { TILE } from '../maze/constants.js';
import { ATTRACT, AUTO, PLAYER, drainRate, swayAt, travelTiles } from './balance.js';

/** @typedef {import('../core/types.js').GameState} GameState */
/** @typedef {import('../core/types.js').LevelData} LevelData */
/** @typedef {import('../core/rng.js').Rng} Rng */

/**
 * The axes an autopilot step writes (a subset of `InputFrame`).
 * @typedef {{moveX:number, moveY:number, turn:number}} AutoAxes
 */

/**
 * @typedef {Object} Autopilot
 * @property {(state: Readonly<GameState>, out: AutoAxes, dt?: number) => boolean} step
 *   write this step's axes into `out` (`dt` defaults to the 1/60 s sim step); false when there is
 *   nothing to drive and the pilot has coasted to a stop
 * @property {() => void} interrupt  drop the route (the player took the controls); the next step plans again
 * @property {() => void} reset      forget the level entirely
 * @property {() => {goal:string, tile:number, route:number, plans:number}} info  for tools and tests
 */

/** Goal kinds, as small integers so a step compares numbers rather than strings. */
const GOAL_NONE = 0;
const GOAL_OIL = 1;
const GOAL_ITEM = 2;
const GOAL_FRONTIER = 3;
const GOAL_EXIT = 4;
const GOAL_NAMES = Object.freeze(['none', 'oil', 'item', 'frontier', 'exit']);

/** The sim's fixed step (§4.1), used when a caller does not pass `dt`. */
const DEFAULT_DT = 1 / 60;

/**
 * Does a route whose first step is onto tile `step` (−1: the route starts where it is) leave from
 * `start` against the facing `(faceX, faceY)`?
 * @param {number} step
 * @param {number} start
 * @param {number} w
 * @param {number} faceX
 * @param {number} faceY
 * @returns {boolean}
 */
function behind(step, start, w, faceX, faceY) {
  if (step < 0) return false;
  const dx = (step % w) - (start % w);
  const dy = ((step / w) | 0) - ((start / w) | 0);
  return dx * faceX + dy * faceY < AUTO.BACKTRACK_DOT;
}

/**
 * A frontier's path distance, plus `AUTO.BACKTRACK_COST` when its route starts behind the player.
 * @param {number} f
 * @param {number} start
 * @param {number} w
 * @param {Int32Array} dst
 * @param {Int32Array} fst
 * @param {number} faceX
 * @param {number} faceY
 * @returns {number}
 */
function frontierCost(f, start, w, dst, fst, faceX, faceY) {
  return dst[f] + (behind(fst[f], start, w, faceX, faceY) ? AUTO.BACKTRACK_COST : 0);
}

/**
 * Grow-only `Int32Array`.
 * @param {Int32Array|null} a
 * @param {number} n
 * @returns {Int32Array}
 */
function ensure(a, n) {
  return a !== null && a.length >= n ? a : new Int32Array(n);
}

/**
 * Create an autopilot. One per page; it follows whatever level the state holds.
 * @returns {Autopilot}
 */
export function createAutopilot() {
  /** The level the buffers below describe. @type {LevelData|null} */
  let levelFor = null;
  /** Tile → item index + 1 (0 = no item). Built once per level. @type {Int32Array|null} */
  let itemAt = null;
  /** BFS generation stamp per tile. @type {Int32Array|null} */
  let seen = null;
  /** BFS parent per tile, valid where `seen[i] === gen`. @type {Int32Array|null} */
  let prev = null;
  /** BFS distance per tile, valid where `seen[i] === gen`. @type {Int32Array|null} */
  let dist = null;
  /** BFS queue. @type {Int32Array|null} */
  let queue = null;
  /** BFS first step out of the start tile on the path to each tile, valid where `seen[i] === gen`. @type {Int32Array|null} */
  let first = null;
  /** The route, as tile indices from the first step to the goal. @type {Int32Array|null} */
  let route = null;
  /** Frontier candidates collected by the last search. */
  const frontier = new Int32Array(Math.max(AUTO.FRONTIER_CAP, AUTO.SEEK_CHOICES));
  let gen = 0;
  /** @type {Rng|null} */
  let rng = null;

  // Per-step numbers live in one object, not closure `let`s: a fractional closure variable boxes a
  // new heap number on every write (see the same note in `src/ui/hud.js`).
  const s = {
    routeLen: 0,
    routeStep: 0,
    goal: GOAL_NONE,
    goalTile: -1,
    /** Item index the goal is, or −1. */
    goalItem: -1,
    /** Steps since the last plan. */
    sincePlan: 1e9,
    stuck: 0,
    lastX: 0,
    lastY: 0,
    plans: 0,
    /** Level time (s) after which the exit, once seen, becomes the goal. */
    exploreFor: 0,
    /** Whether the last plan was made wanting fuel. */
    plannedLow: false,
    /** The tile the current route starts from (the leg into its first waypoint begins here). */
    fromTile: -1,
    /** Eased turn rate the pilot is commanding, rad/s. */
    turnRate: 0,
    /** Eased forward speed the pilot is commanding, tiles/s. */
    speed: 0,
    /** This step's pursuit aim point (tiles), written by `aimAt`. */
    aimX: 0,
    aimY: 0,
  };

  /** Forget the eased motion, so the next drive starts gently from a standstill. @returns {void} */
  function settle() {
    s.turnRate = 0;
    s.speed = 0;
  }

  /**
   * The tile the leg into the current waypoint starts from.
   * @param {Int32Array} r
   * @returns {number}
   */
  function legFrom(r) {
    return s.routeStep > 0 ? r[s.routeStep - 1] : s.fromTile;
  }

  /**
   * Has the body reached waypoint `i`, walking in from tile `from`? On the waypoint's tile and at
   * most `ATTRACT.ARRIVE` short of its centre along the leg (the title camera's rule); a zero leg
   * (the route starts on the waypoint) needs the centre within that radius.
   * @param {number} x
   * @param {number} y
   * @param {number} i
   * @param {number} from
   * @param {number} w
   * @returns {boolean}
   */
  function arrived(x, y, i, from, w) {
    const tx = i % w;
    const ty = (i / w) | 0;
    const cx = tx + 0.5;
    const cy = ty + 0.5;
    const legX = from < 0 ? 0 : tx - (from % w);
    const legY = from < 0 ? 0 : ty - ((from / w) | 0);
    if (legX === 0 && legY === 0) {
      return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= ATTRACT.ARRIVE * ATTRACT.ARRIVE;
    }
    if (Math.floor(x) !== tx || Math.floor(y) !== ty) return false;
    return (x - cx) * legX + (y - cy) * legY >= -ATTRACT.ARRIVE;
  }

  /**
   * Pure-pursuit aim point, written to `s.aimX/aimY`: the furthest point along the route's
   * centre-line polyline (the current leg, then the waypoints after it) that lies `AUTO.PURSUIT`
   * tiles from the body. On a straight run that is a point ahead on the centre line; as a corner
   * comes within reach the point slides round it, so the turn begins *before* the corner and the
   * body arcs through it — rather than walking at the far wall and pivoting there. Near the goal the
   * aim settles on the goal's centre. O(1): only the few legs within reach are looked at.
   * @param {number} x
   * @param {number} y
   * @param {Int32Array} r
   * @param {number} w
   * @returns {void}
   */
  function aimAt(x, y, r, w) {
    const L = AUTO.PURSUIT;
    const last = Math.min(s.routeLen - 1, s.routeStep + Math.ceil(L) + 2);
    let from = legFrom(r);
    // Fallback when the body is off the polyline by more than L: the current waypoint's centre.
    s.aimX = (r[s.routeStep] % w) + 0.5;
    s.aimY = ((r[s.routeStep] / w) | 0) + 0.5;
    for (let k = s.routeStep; k <= last; k++) {
      const to = r[k];
      const bx = (to % w) + 0.5;
      const by = ((to / w) | 0) + 0.5;
      if (from < 0) {
        from = to;
        continue;
      }
      const ax = (from % w) + 0.5;
      const ay = ((from / w) | 0) + 0.5;
      const dx = bx - ax;
      const dy = by - ay;
      from = to;
      if (dx === 0 && dy === 0) continue;
      // |A + t·d − p| = L on a unit leg: t² + 2t(q·d) + |q|² − L² = 0, q = A − p; the larger root.
      const qx = ax - x;
      const qy = ay - y;
      const qd = qx * dx + qy * dy;
      const disc = qd * qd - (qx * qx + qy * qy) + L * L;
      if (disc < 0) continue;
      const t = -qd + Math.sqrt(disc);
      if (t < 0) continue;
      if (t >= 1) {
        // The leg's end is within reach; the aim lies further on (or is the route's end).
        s.aimX = bx;
        s.aimY = by;
      } else {
        s.aimX = ax + t * dx;
        s.aimY = ay + t * dy;
      }
    }
  }

  /** @returns {void} */
  function dropRoute() {
    s.routeLen = 0;
    s.routeStep = 0;
    s.goal = GOAL_NONE;
    s.goalTile = -1;
    s.goalItem = -1;
  }

  /**
   * Adopt a newly installed level: size the buffers, index its items, roll its exploration budget.
   * Once per level; this is where the O(tiles + items) work that planning needs is paid.
   * @param {Readonly<GameState>} state
   * @returns {void}
   */
  function adopt(state) {
    const level = /** @type {LevelData} */ (state.levelData);
    const maze = level.maze;
    const n = maze.width * maze.height;
    levelFor = level;
    itemAt = ensure(itemAt, n);
    itemAt.fill(0, 0, n);
    seen = ensure(seen, n);
    seen.fill(0, 0, n);
    gen = 0;
    prev = ensure(prev, n);
    dist = ensure(dist, n);
    queue = ensure(queue, n);
    first = ensure(first, n);
    route = ensure(route, n);
    const items = level.items;
    for (let i = 0; i < items.length; i++) {
      const tx = Math.floor(items[i].x);
      const ty = Math.floor(items[i].y);
      if (tx >= 0 && ty >= 0 && tx < maze.width && ty < maze.height) itemAt[ty * maze.width + tx] = i + 1;
    }
    rng = createRng((state.seed ^ Math.imul(state.level | 0, 0x9e3779b1)) >>> 0).fork('auto');
    const par = level.par > 0 ? level.par : 120;
    s.exploreFor = par * (AUTO.EXPLORE_PAR_MIN + (AUTO.EXPLORE_PAR_MAX - AUTO.EXPLORE_PAR_MIN) * rng.next());
    dropRoute();
    s.sincePlan = 1e9;
    s.stuck = 0;
  }

  /**
   * Is tile `i` a frontier — explored floor with an unexplored floor neighbour?
   * @param {Uint8Array} tiles
   * @param {Uint8Array} explored
   * @param {number} w
   * @param {number} h
   * @param {number} i
   * @returns {boolean}
   */
  function isFrontier(tiles, explored, w, h, i) {
    if (explored[i] === 0) return false;
    const x = i % w;
    const y = (i / w) | 0;
    if (x + 1 < w && tiles[i + 1] === TILE.FLOOR && explored[i + 1] === 0) return true;
    if (x > 0 && tiles[i - 1] === TILE.FLOOR && explored[i - 1] === 0) return true;
    if (y + 1 < h && tiles[i + w] === TILE.FLOOR && explored[i + w] === 0) return true;
    if (y > 0 && tiles[i - w] === TILE.FLOOR && explored[i - w] === 0) return true;
    return false;
  }

  /**
   * Plan: one bounded breadth-first search, then pick a goal and write its route.
   * @param {Readonly<GameState>} state
   * @returns {void}
   */
  function plan(state) {
    s.plans++;
    s.sincePlan = 0;
    s.stuck = 0;
    dropRoute();
    const level = /** @type {LevelData} */ (state.levelData);
    const explored = state.explored;
    if (explored === null) return;
    const maze = level.maze;
    const w = maze.width;
    const h = maze.height;
    const tiles = maze.tiles;
    const items = level.items;
    const vis = /** @type {Int32Array} */ (seen);
    const par = /** @type {Int32Array} */ (prev);
    const dst = /** @type {Int32Array} */ (dist);
    const q = /** @type {Int32Array} */ (queue);
    const at = /** @type {Int32Array} */ (itemAt);
    const fst = /** @type {Int32Array} */ (first);

    const px = Math.floor(state.player.x);
    const py = Math.floor(state.player.y);
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const start = py * w + px;
    s.fromTile = start;
    const exitIdx = maze.exit.y * w + maze.exit.x;

    const run = state.run;
    const tank = run.fuelMax > 0 ? run.fuel / run.fuelMax : 1;
    // Tiles the torch still buys at this level's drain. Auto Explore walks at `ATTRACT.SPEED` and
    // burns at `AUTO_DRAIN_SCALE` (= ATTRACT.SPEED / WALK_SPEED) times the rate, so a tile costs it
    // exactly what it costs a walker: `travelTiles` is the right arithmetic for both.
    // `drainRate` rather than the installed `sim.drain`, which is not part of the public state: the
    // only difference is Slow Wick, which lowers the real drain, so the estimate is conservative.
    const reach = travelTiles(run.fuel, drainRate(state.level));
    // Fuel is wanted on a *distance*, not only on a fraction: half a tank is plenty three tiles from
    // a flask and not nearly enough eighty tiles from one. The fraction stays as the floor (a flask
    // passed at half a tank is still worth taking); the distance rule is what stops the pilot
    // strolling past the last flask it can still reach. Set once the search finds the nearest flask.
    let wantFuel = tank < AUTO.REFUEL_AT;
    const exitSeen = explored[exitIdx] !== 0;
    const wandered = run.levelTime >= s.exploreFor;
    const wantExit = exitSeen && (wandered || tank < AUTO.DESPERATE_AT);
    // Wandered long enough but the exit is still in the fog: search toward it instead of at random.
    const seek = wandered && !exitSeen;
    const choices = seek || wantFuel ? AUTO.SEEK_CHOICES : AUTO.FRONTIER_CHOICES;
    // Past `choices`, keep collecting (up to the buffer) until one frontier is not behind the player.
    const cap = seek || wantFuel ? AUTO.SEEK_CHOICES : AUTO.FRONTIER_CAP;
    const faceX = Math.cos(state.player.angle);
    const faceY = Math.sin(state.player.angle);

    if (++gen === 0x7fffffff) {
      vis.fill(0);
      gen = 1;
    }
    let head = 0;
    let tail = 0;
    q[tail++] = start;
    vis[start] = gen;
    par[start] = start;
    dst[start] = 0;
    fst[start] = -1;

    let oil = -1;
    /** Nearest untaken flask whatever the fog says — the survival valve below. */
    let smell = -1;
    let item = -1;
    let frontiers = 0;
    let ahead = false;
    let exitReached = false;
    // Below this the pilot may walk to a flask it has not uncovered yet (see `AUTO.SMELL_AT`).
    const desperate = tank < AUTO.SMELL_AT;
    while (head < tail) {
      const i = q[head++];
      const d = dst[i];
      if (i === exitIdx) exitReached = true;
      if (desperate && smell < 0) {
        const k = at[i] - 1;
        if (k >= 0 && items[k].taken !== true && items[k].kind === 'oil') smell = i;
      }
      if (explored[i] !== 0) {
        const k = at[i] - 1;
        if (k >= 0 && items[k].taken !== true) {
          const kind = items[k].kind;
          if (kind === 'oil') {
            if (oil < 0) {
              oil = i;
              // The trip there and the slack to reach the one after it: a flask is only worth
              // walking to while the tank still covers `REFUEL_MARGIN` times the way plus a margin.
              if (reach < d * AUTO.REFUEL_MARGIN + AUTO.REFUEL_RESERVE_TILES) wantFuel = true;
            }
            // A flask close by is worth topping up from before the tank is low: it may be far
            // behind by the time it is needed.
            if (item < 0 && tank < AUTO.TOPUP_AT && d <= AUTO.ITEM_DETOUR) item = i;
          } else if (item < 0 && d <= AUTO.ITEM_DETOUR) {
            item = i;
          }
        }
        if (frontiers < cap && (frontiers < choices || !ahead) && isFrontier(tiles, explored, w, h, i)) {
          frontier[frontiers++] = i;
          if (!behind(fst[i], start, w, faceX, faceY)) ahead = true;
        }
      }
      // Stop as soon as the goal this plan will pick is decided. Distances are non-decreasing in a
      // BFS, so nothing found later could beat what is already in hand.
      if (wantFuel && oil >= 0) break;
      // Nothing uncovered to drink and a flask found in the fog: that is this plan's goal, and a
      // BFS is nearest-first, so nothing further on could beat it.
      if (desperate && smell >= 0 && oil < 0) break;
      if (wantExit && exitReached) break;
      // A frontier further than the nearest one plus the backtrack cost could not win either.
      if (
        !wantFuel &&
        !wantExit &&
        !(desperate && smell < 0) &&
        frontiers >= choices &&
        d > AUTO.ITEM_DETOUR &&
        (ahead || frontiers >= cap || d > dst[frontier[0]] + AUTO.BACKTRACK_COST + AUTO.FRONTIER_TIE)
      ) {
        break;
      }

      const x = i % w;
      const y = (i / w) | 0;
      for (let dir = 0; dir < 4; dir++) {
        let ni = -1;
        if (dir === 0 && x + 1 < w) ni = i + 1;
        else if (dir === 1 && y + 1 < h) ni = i + w;
        else if (dir === 2 && x > 0) ni = i - 1;
        else if (dir === 3 && y > 0) ni = i - w;
        if (ni < 0 || vis[ni] === gen || tiles[ni] !== TILE.FLOOR) continue;
        vis[ni] = gen;
        par[ni] = i;
        dst[ni] = d + 1;
        fst[ni] = i === start ? ni : fst[i];
        q[tail++] = ni;
      }
    }

    let goal = GOAL_NONE;
    let tile = -1;
    if (wantFuel && oil >= 0) {
      goal = GOAL_OIL;
      tile = oil;
    } else if (desperate && smell >= 0) {
      // The survival valve: on a nearly dead torch with nothing uncovered to refill it from, the
      // pilot walks to the nearest flask on the level rather than exploring until it dies. This is
      // the one place it looks past the fog, and it exists because Auto Explore is a *watch* mode
      // whose death costs the player their saved run (main.js clears it on gameOver). Measured over
      // levels 1–10 × 8 seeds it is most of the difference between clearing 74 % of runs and 99 %.
      goal = GOAL_OIL;
      tile = smell;
    } else if (wantExit && exitReached) {
      goal = GOAL_EXIT;
      tile = exitIdx;
    } else if (item >= 0) {
      goal = GOAL_ITEM;
      tile = item;
    } else if (frontiers > 0 && (seek || (wantFuel && !exitSeen))) {
      // Greedy best-first toward the exit: path distance there plus straight-line distance onward.
      // Also taken on a low tank with no flask in sight: flasks are laid along the way to the exit
      // (§1 placement guarantee), so that is where a player low on oil goes looking.
      let best = 0;
      let bestScore = Infinity;
      const ex = maze.exit.x;
      const ey = maze.exit.y;
      for (let r = 0; r < frontiers; r++) {
        const f = frontier[r];
        const score =
          frontierCost(f, start, w, dst, fst, faceX, faceY) +
          AUTO.SEEK_WEIGHT * (Math.abs((f % w) - ex) + Math.abs(((f / w) | 0) - ey));
        if (score < bestScore) {
          bestScore = score;
          best = r;
        }
      }
      goal = GOAL_FRONTIER;
      tile = frontier[best];
    } else if (frontiers > 0) {
      // Nearest first, which walks a corridor to its end rather than thrashing between far-apart
      // frontiers; ties (a junction's branches, within FRONTIER_TIE tiles) are broken at random.
      // Distances carry the backtrack cost, so the corridor ahead beats a branch just passed.
      let lowest = Infinity;
      for (let r = 0; r < frontiers; r++) lowest = Math.min(lowest, frontierCost(frontier[r], start, w, dst, fst, faceX, faceY));
      const limit = lowest + AUTO.FRONTIER_TIE;
      let ties = 0;
      for (let r = 0; r < frontiers; r++) if (frontierCost(frontier[r], start, w, dst, fst, faceX, faceY) <= limit) ties++;
      let pick = ties > 1 ? /** @type {Rng} */ (rng).int(ties) : 0;
      tile = frontier[0];
      for (let r = 0; r < frontiers; r++) {
        if (frontierCost(frontier[r], start, w, dst, fst, faceX, faceY) > limit) continue;
        if (pick-- === 0) {
          tile = frontier[r];
          break;
        }
      }
      goal = GOAL_FRONTIER;
    } else if (exitReached) {
      // Nothing left to explore that can be reached: leave.
      goal = GOAL_EXIT;
      tile = exitIdx;
    }
    if (goal === GOAL_NONE) return;
    // "This plan is a refuel trip": the replan edges below are what stop a trip being re-planned
    // every cooldown while the tank keeps falling, which used to flip the pilot between two flasks
    // until the torch died with neither reached.
    s.plannedLow = goal === GOAL_OIL;

    // Walk the parents back from the goal, then reverse in place.
    const r = /** @type {Int32Array} */ (route);
    let len = 0;
    for (let i = tile; i !== start; i = par[i]) r[len++] = i;
    if (len === 0) r[len++] = start;
    for (let a = 0, b = len - 1; a < b; a++, b--) {
      const t = r[a];
      r[a] = r[b];
      r[b] = t;
    }
    s.routeLen = len;
    s.routeStep = 0;
    s.goal = goal;
    s.goalTile = tile;
    s.goalItem = goal === GOAL_OIL || goal === GOAL_ITEM ? at[tile] - 1 : -1;
  }

  /**
   * Should the current route be thrown away?
   * @param {Readonly<GameState>} state
   * @returns {boolean}
   */
  function wantsReplan(state) {
    if (s.goal === GOAL_NONE || s.routeStep >= s.routeLen) return true;
    const level = /** @type {LevelData} */ (state.levelData);
    if (s.goalItem >= 0 && level.items[s.goalItem].taken === true) return true;
    const run = state.run;
    const tank = run.fuelMax > 0 ? run.fuel / run.fuelMax : 1;
    const cooled = s.sincePlan >= AUTO.REPLAN_COOLDOWN_STEPS;
    if (!cooled) return false;
    // Edges, not levels: a low tank with no flask in sight must not search again every cooldown.
    if (!s.plannedLow && tank < AUTO.REFUEL_AT) return true;
    if (s.plannedLow && tank > AUTO.REFUEL_AT + AUTO.REFUEL_HYSTERESIS) return true;
    if (s.goal === GOAL_FRONTIER && state.explored !== null) {
      const maze = level.maze;
      // The frontier was uncovered on the way (the reveal reaches 3 tiles ahead): pick another.
      if (!isFrontier(maze.tiles, state.explored, maze.width, maze.height, s.goalTile)) return true;
    }
    if (s.goal !== GOAL_EXIT && state.explored !== null) {
      const maze = level.maze;
      const exitIdx = maze.exit.y * maze.width + maze.exit.x;
      if (state.explored[exitIdx] !== 0 && run.levelTime >= s.exploreFor && s.sincePlan > 60) return true;
    }
    return false;
  }

  /**
   * @param {AutoAxes} out
   * @returns {false}
   */
  function idle(out) {
    out.moveX = 0;
    out.moveY = 0;
    out.turn = 0;
    return false;
  }

  return {
    step(state, out, dt = DEFAULT_DT) {
      if (state.phase !== 'playing' || state.levelData === null || state.explored === null) {
        settle();
        return idle(out);
      }
      if (state.levelData !== levelFor) adopt(state);
      s.sincePlan++;

      const p = state.player;
      if (Math.abs(p.x - s.lastX) + Math.abs(p.y - s.lastY) < 0.004) s.stuck++;
      else s.stuck = 0;
      s.lastX = p.x;
      s.lastY = p.y;

      if (wantsReplan(state) || s.stuck > AUTO.STUCK_STEPS) plan(state);

      const maze = /** @type {LevelData} */ (state.levelData).maze;
      const w = maze.width;
      const r = /** @type {Int32Array} */ (route);
      // Pass waypoints the title camera's way (`attractArrived` in sim.js), or on stepping onto the
      // next waypoint's tile: the pursuit aim below cuts corners, so the body can leave a corner tile
      // without ever standing `ARRIVE` short of its centre.
      while (
        s.routeStep < s.routeLen &&
        (arrived(p.x, p.y, r[s.routeStep], legFrom(r), w) ||
          (s.routeStep + 1 < s.routeLen && Math.floor(p.x) === r[s.routeStep + 1] % w && Math.floor(p.y) === ((r[s.routeStep + 1] / w) | 0)))
      ) {
        s.routeStep++;
      }

      // No route (nothing to do, or the goal was just reached): coast to a stop rather than halting.
      let want = 0;
      let command = 0;
      if (s.routeStep < s.routeLen) {
        aimAt(p.x, p.y, r, w);
        const aimErr = angleDiff(p.angle, Math.atan2(s.aimY - p.y, s.aimX - p.x));
        // The title camera's sway, from the title camera's own function: faded out while turning and
        // in with the walking speed, so it never fights the pursuit aim (`balance.js` `swayAt`).
        const err = aimErr + swayAt(state.time, aimErr, s.speed);
        command = clamp(err * ATTRACT.TURN_GAIN, -ATTRACT.TURN_RATE, ATTRACT.TURN_RATE);
        const align = Math.cos(err);
        want = align > 0 ? ATTRACT.SPEED * Math.pow(align, ATTRACT.SPEED_FALLOFF) : 0;
      }
      // Both eased, never assigned: a corner or a replan changes the command, not the motion.
      s.turnRate = damp(s.turnRate, command, ATTRACT.TURN_EASE_RATE, dt);
      s.speed = damp(s.speed, want, ATTRACT.SPEED_EASE_RATE, dt);
      // Written as the player's own axes: the sim turns at `turn × PLAYER.TURN_SPEED` and walks at
      // `moveY × PLAYER.WALK_SPEED`, so every rule of play (collision, fuel, pickups) still applies.
      out.turn = clamp(s.turnRate / PLAYER.TURN_SPEED, -1, 1);
      out.moveY = clamp(s.speed / PLAYER.WALK_SPEED, 0, 1);
      out.moveX = 0;
      return s.routeLen > 0 || s.speed > 0.01;
    },

    interrupt() {
      dropRoute();
      s.stuck = 0;
      settle();
    },

    reset() {
      levelFor = null;
      dropRoute();
    },

    info() {
      return { goal: GOAL_NAMES[s.goal], tile: s.goalTile, route: s.routeLen - s.routeStep, plans: s.plans };
    },
  };
}
