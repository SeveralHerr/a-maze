// @ts-check
/**
 * @file **The acceptance test for the massive-maze torch economy.**
 *
 * The design change makes the torch a small tank (110–150 s) that must be refilled from oil flasks
 * scattered through a maze that can be 257×257 tiles. That is only a game if a competent player can
 * *chain* refuels: every level must be finishable by someone who walks the solution path but,
 * because they cannot see it, covers twice its length on the way.
 *
 * So this file builds **real levels** — the shipped `levelParams`, the shipped generator, validator
 * and populate — and walks each one with an autopilot held to exactly that standard:
 *
 * - it follows the validator's shortest path from start to exit;
 * - it burns `FUEL.WANDER` (2.0) × the path length in total travel: one path-length of route plus
 *   one path-length of detour, every tile of it paid for out of the torch;
 * - it detours to oil flasks that lie on the path or within `LEVEL.OIL_REACH_TILES` of it, paying
 *   the round trip out of that same wander budget, and only when the flask is actually worth taking
 *   (the sim itself refuses a flask that would overflow the tank);
 * - it drains fuel at the level's `drain` rate, over `FUEL.TRAVEL_OVERHEAD`-inflated walking time.
 *
 * A level where that run cannot reach the exit with fuel to spare is a **blocker**, and the failure
 * message carries the level and seed needed to reproduce it.
 *
 * Cross-module note: this test imports `src/maze` (test-only). The runtime dependency rule in
 * ARCHITECTURE.md §2 is unchanged — `src/state` still imports nothing from `src/maze` but
 * `constants.js` — but a feasibility proof that used a fake maze would prove nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLevel } from '../maze/level.js';
import { TILE, DIR_COUNT, DIR_DX, DIR_DY } from '../maze/constants.js';
import { FUEL, LEVEL, PLAYER, levelParams, oilFuel, travelTiles } from './balance.js';

/** Levels to prove. 25 covers the whole size ramp (caps at 15) and ten levels past it. */
const MAX_LEVEL = 25;

/** Seeds per level. Path length varies ±40 % between seeds, so one seed proves nothing. */
const SEEDS = 10;

/**
 * Seconds of fuel one tile of walking costs at a given drain, including the turning and
 * re-acceleration overhead a real corridor run pays.
 * @param {number} drain
 * @returns {number} seconds per tile
 */
function secondsPerTile(drain) {
  return (FUEL.TRAVEL_OVERHEAD * drain) / PLAYER.WALK_SPEED;
}

/**
 * One autopilot run over a built level.
 * @typedef {Object} RunResult
 * @property {boolean} reachedExit
 * @property {number} fuel          fuel-seconds left at the exit (or where it died)
 * @property {number} fuelMax
 * @property {number} pathLength    tiles on the solution path
 * @property {number} route         tile-to-tile moves along it (pathLength − 1)
 * @property {number} travelled     tiles actually walked (= FUEL.WANDER × route)
 * @property {number} refuels       flasks consumed
 * @property {number} flasksReachable flasks on or within reach of the path
 * @property {number} maxGap        longest stretch of path (tiles) between reachable flasks
 * @property {number} leadGap       stretch of path before the first reachable flask
 * @property {number} diedAt        path index where the torch died, −1 if it did not
 * @property {number} minFuel       lowest the torch ever got, fuel-seconds
 */

/**
 * Distance from the solution path to every floor tile within `LEVEL.OIL_REACH_TILES`, plus which
 * path position that shortest hop starts from.
 *
 * A single multi-source BFS seeded with every path tile: O(floor tiles) once per level, which is
 * what keeps 250 levels of proof inside a few seconds even at 33 000 floor tiles each.
 * @param {import('../core/types.js').Maze} maze
 * @param {Uint32Array} path tile indices, start → exit
 * @returns {{dist: Int32Array, anchor: Int32Array}} −1 where out of reach
 */
function reachFromPath(maze, path) {
  const total = maze.width * maze.height;
  const dist = new Int32Array(total).fill(-1);
  const anchor = new Int32Array(total).fill(-1);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    if (dist[idx] >= 0) continue; // a path that revisits a tile keeps its earliest position
    dist[idx] = 0;
    anchor[idx] = i;
    queue[tail++] = idx;
  }
  while (head < tail) {
    const idx = queue[head++];
    const d = dist[idx];
    if (d >= LEVEL.OIL_REACH_TILES) continue;
    const x = idx % maze.width;
    const y = (idx - x) / maze.width;
    for (let dir = 0; dir < DIR_COUNT; dir++) {
      const nx = x + DIR_DX[dir];
      const ny = y + DIR_DY[dir];
      if (nx < 0 || ny < 0 || nx >= maze.width || ny >= maze.height) continue;
      const nIdx = ny * maze.width + nx;
      if (maze.tiles[nIdx] !== TILE.FLOOR || dist[nIdx] >= 0) continue;
      dist[nIdx] = d + 1;
      anchor[nIdx] = anchor[idx];
      queue[tail++] = nIdx;
    }
  }
  return { dist, anchor };
}

/**
 * Walk one level with the autopilot described in the file header.
 *
 * @param {import('../core/types.js').LevelData} data
 * @param {number} level 1-based, for the tank and drain
 * @returns {RunResult}
 */
function autopilot(data, level) {
  const params = levelParams(level);
  const maze = data.maze;
  const path = data.validation.path;
  assert.ok(path !== null && path.length > 0, 'the validator must hand back a path');
  const L = path.length;
  const perTile = secondsPerTile(params.drain);
  const fuelMax = params.fuelSeconds;
  const flask = oilFuel(fuelMax);

  const { dist, anchor } = reachFromPath(maze, /** @type {Uint32Array} */ (path));

  // Bucket the reachable items by the path position they hang off, so the walk can consume them in
  // order without re-scanning the item list (the same reason the sim has a bucket grid).
  /** @type {Array<Array<{dist:number, kind:string}>>} */
  const atStep = new Array(L);
  let flasksReachable = 0;
  for (let i = 0; i < data.items.length; i++) {
    const it = data.items[i];
    const tx = Math.floor(it.x);
    const ty = Math.floor(it.y);
    if (tx < 0 || ty < 0 || tx >= maze.width || ty >= maze.height) continue;
    const idx = ty * maze.width + tx;
    const d = dist[idx];
    if (d < 0) continue; // out of reach of the route: a wanderer might find it, a walker will not
    const a = anchor[idx];
    if (atStep[a] === undefined) atStep[a] = [];
    atStep[a].push({ dist: d, kind: it.kind });
    if (it.kind === 'oil') flasksReachable++;
  }
  for (let i = 0; i < L; i++) if (atStep[i] !== undefined) atStep[i].sort((a, b) => a.dist - b.dist);

  // The longest run of path with no reachable flask — the number `oilTargetGap` bounds. The stretch
  // *before* the first flask is measured separately (`leadGap`): it is the one leg the player walks
  // on a full tank rather than on one flask, so it is allowed to be much longer.
  let maxGap = 0;
  let leadGap = 0;
  let sinceFlask = 0;
  let seenFlask = false;
  for (let i = 0; i < L; i++) {
    const here = atStep[i];
    let has = false;
    if (here !== undefined) for (let k = 0; k < here.length; k++) if (here[k].kind === 'oil') has = true;
    if (has) {
      if (!seenFlask) leadGap = sinceFlask;
      seenFlask = true;
      sinceFlask = 0;
    } else {
      sinceFlask++;
      if (seenFlask && sinceFlask > maxGap) maxGap = sinceFlask;
    }
  }
  if (!seenFlask) leadGap = sinceFlask; // no flask at all: the whole path is the first leg

  let fuel = fuelMax;
  let minFuel = fuel;
  let travelled = 0;
  let refuels = 0;
  let diedAt = -1;
  // A path of L tiles is L−1 tile-to-tile moves. One further route-length of aimless wandering is
  // spread over the walk and re-spread whenever a detour spends some of it, so the total travel is
  // always exactly FUEL.WANDER × the route.
  const route = L - 1;
  let wander = (FUEL.WANDER - 1) * route;

  for (let i = 0; i < L; i++) {
    // Detours available from this path tile, cheapest first.
    const here = atStep[i];
    if (here !== undefined) {
      for (let k = 0; k < here.length; k++) {
        const item = here[k];
        const trip = 2 * item.dist;
        if (item.kind !== 'oil') continue;
        const deficit = fuelMax - fuel;
        // The sim itself refuses a flask that would overflow the tank; a competent player also does
        // not walk three tiles off-route for a sip. Half a flask's worth of room is the threshold.
        if (deficit < Math.max(1, flask * 0.5)) continue;
        if (trip > wander) continue; // no budget left for the round trip
        wander -= trip;
        travelled += trip;
        fuel -= trip * perTile;
        if (fuel <= 0) {
          diedAt = i;
          break;
        }
        if (fuel < minFuel) minFuel = fuel;
        fuel = Math.min(fuelMax, fuel + flask);
        refuels++;
      }
      if (diedAt >= 0) break;
    }

    if (i === L - 1) break; // standing on the exit

    // One tile of route, plus this step's share of whatever wander budget is still unspent.
    const share = wander / (L - 1 - i);
    wander -= share;
    const step = 1 + share;
    travelled += step;
    fuel -= step * perTile;
    if (fuel < minFuel) minFuel = fuel;
    if (fuel <= 0) {
      diedAt = i;
      break;
    }
  }

  return {
    reachedExit: diedAt < 0,
    fuel,
    fuelMax,
    pathLength: L,
    route,
    leadGap,
    travelled,
    refuels,
    flasksReachable,
    maxGap,
    diedAt,
    minFuel,
  };
}

// ─── The proof ───────────────────────────────────────────────────────────────────────────────

test(`feasibility: levels 1..${MAX_LEVEL} × ${SEEDS} seeds are winnable at a ${FUEL.WANDER}× wander factor`, () => {
  /** @type {Array<{level:number, seed:number, r:RunResult}>} */
  const runs = [];
  /** @type {string[]} */
  const overTarget = [];
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const params = levelParams(level);
    // The distance one flask *strictly* pays for: `oilTargetGap` is this with GAP_SAFETY headroom.
    // A stretch longer than this cannot be chained however well the player plays, so it is the
    // blocker line; the headroom is the target `populate.js` aims at, reported below.
    const chainLimit = params.oilTargetGap / FUEL.GAP_SAFETY;
    // How far the player can get from the start line, before any flask exists to help.
    const tankReach = travelTiles(params.fuelSeconds, params.drain) / FUEL.WANDER;
    for (let s = 0; s < SEEDS; s++) {
      const seed = 1_000_003 * (level + 1) + s * 7919;
      const data = buildLevel(params, seed);
      const r = autopilot(data, level);
      runs.push({ level, seed, r });

      assert.ok(
        r.reachedExit,
        `BLOCKER — level ${level}, seed ${seed}: the torch died at path tile ${r.diedAt}/${r.pathLength} ` +
          `after ${r.refuels} refuels (tank ${r.fuelMax} s, ${r.flasksReachable} reachable flasks, ` +
          `longest flask-free stretch ${r.maxGap} tiles vs a ${params.oilTargetGap}-tile guarantee)`,
      );
      assert.ok(
        r.fuel > 0,
        `level ${level}, seed ${seed}: reached the exit on ${r.fuel.toFixed(2)} s of fuel`,
      );
      assert.ok(
        Math.abs(r.travelled - FUEL.WANDER * r.route) < 1e-6,
        `level ${level}, seed ${seed}: the autopilot must walk exactly ${FUEL.WANDER}× the route ` +
          `(${r.travelled.toFixed(1)} vs ${(FUEL.WANDER * r.route).toFixed(1)} tiles)`,
      );
      assert.ok(
        r.maxGap <= chainLimit,
        `BLOCKER — level ${level}, seed ${seed}: ${r.maxGap} tiles of solution path with no flask ` +
          `on it or within ${LEVEL.OIL_REACH_TILES} tiles of it. One flask (${oilFuel(params.fuelSeconds).toFixed(0)} s) ` +
          `only pays for ${chainLimit.toFixed(0)} tiles at a ${FUEL.WANDER}× wander, so src/maze/populate.js ` +
          `must keep consecutive reachable flasks within levelParams(${level}).oilTargetGap = ${params.oilTargetGap} tiles.`,
      );
      // The one leg walked on a full tank rather than on a flask: the start of the level.
      assert.ok(
        r.leadGap <= tankReach,
        `BLOCKER — level ${level}, seed ${seed}: the first ${r.leadGap} tiles of path carry no ` +
          `reachable flask, and a full ${params.fuelSeconds} s tank only covers ${tankReach.toFixed(0)}.`,
      );
      if (r.maxGap > params.oilTargetGap) {
        overTarget.push(`level ${level} seed ${seed}: ${r.maxGap} > ${params.oilTargetGap}`);
      }
    }
  }

  // Report the shape of the curve the proof just walked: this is the balance evidence.
  /** @type {string[]} */
  const lines = [
    'level  side   path  min(2×)  refuels  flasks  maxGap  lead  target  endFuel%  lowest%',
  ];
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const p = levelParams(level);
    const mine = runs.filter((r) => r.level === level).map((r) => r.r);
    const avg = (/** @type {(r:RunResult)=>number} */ f) =>
      mine.reduce((a, r) => a + f(r), 0) / mine.length;
    const minutes = (avg((r) => r.travelled) * secondsPerTile(p.drain)) / 60;
    lines.push(
      `${String(level).padStart(5)}  ${String(p.cols).padStart(4)}  ` +
        `${String(Math.round(avg((r) => r.pathLength))).padStart(5)}  ` +
        `${minutes.toFixed(1).padStart(7)}  ${avg((r) => r.refuels).toFixed(1).padStart(7)}  ` +
        `${String(Math.round(avg((r) => r.flasksReachable))).padStart(6)}  ` +
        `${String(Math.max(...mine.map((r) => r.maxGap))).padStart(6)}  ` +
        `${String(Math.max(...mine.map((r) => r.leadGap))).padStart(5)}  ` +
        `${String(p.oilTargetGap).padStart(6)}  ` +
        `${((avg((r) => r.fuel) / p.fuelSeconds) * 100).toFixed(0).padStart(8)}  ` +
        `${((avg((r) => r.minFuel) / p.fuelSeconds) * 100).toFixed(0).padStart(7)}`,
    );
  }
  lines.push(
    `${runs.length} runs, all won. ${overTarget.length} exceeded the soft oilTargetGap target ` +
      `(all within the ${(1 / FUEL.GAP_SAFETY).toFixed(2)}× chainable limit).`,
  );
  console.log(lines.join('\n'));
});

test('feasibility: a level with no flasks at all is correctly judged unwinnable', () => {
  // The autopilot only proves something if it can fail. Strip the flasks from a real level and it
  // must die, which is what rules out "the test passes because it never checks".
  const params = levelParams(10);
  const data = buildLevel(params, 24_601);
  data.items = data.items.filter((it) => it.kind !== 'oil');
  const r = autopilot(data, 10);
  assert.equal(r.reachedExit, false, 'a 88×88 maze cannot be crossed on one tank');
  assert.equal(r.refuels, 0);
  assert.ok(r.diedAt > 0 && r.diedAt < r.pathLength);
});
