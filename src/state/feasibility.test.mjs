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
import { angleDiff, clamp } from '../core/math.js';
import { FUEL, LEVEL, PLAYER, gapSafety, levelParams, oilFuel, travelTiles } from './balance.js';
import { createInitialState, reducer } from './game.js';

/** Levels to prove. 25 covers the whole size ramp (caps at 15) and ten levels past it. */
const MAX_LEVEL = 25;

/**
 * The modelled player walks off the route for a flask only when at least this much of it would land.
 * The sim tops off from any flask the player walks over (`FUEL.OIL_MIN_ROOM`); this is the player's
 * judgement about detours, not a sim rule.
 */
const FEAS_DETOUR_FRACTION = 0.55;

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
        // The sim drinks a flask whenever the tank has room (sim.js takeItem), so one on the route is
        // always taken; a competent player still does not walk off the route for a sip.
        if (deficit < FUEL.OIL_MIN_ROOM) continue;
        if (trip > 0 && deficit < flask * FEAS_DETOUR_FRACTION) continue;
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
    // The distance one flask *strictly* pays for: `oilTargetGap` is this with `gapSafety(level)`
    // headroom. A stretch longer than this cannot be chained however well the player plays, so it is
    // the blocker line; the headroom is the target `populate.js` aims at, reported below.
    const chainLimit = params.oilTargetGap / gapSafety(level);
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
      `(all within the ${(1 / FUEL.GAP_SAFETY_END).toFixed(2)}–${(1 / FUEL.GAP_SAFETY).toFixed(2)}× chainable limit).`,
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

// ─── The tension curve, on the real reducer ──────────────────────────────────────────────────

/**
 * A walking route over a built level, as tile indices: the solution path, plus — for a wanderer —
 * side excursions of up to 20 tiles (walked out and back) spread along it until the route is about
 * `wander` × the path. A path-only walker (`wander` 1) never steps off the path, so it ignores every
 * flask that is not on it; a wanderer passes whatever lies down the side passages it explores.
 * Deterministic for a given `seed`.
 * @param {import('../core/types.js').LevelData} data
 * @param {number} wander
 * @param {number} seed
 * @returns {number[]}
 */
function walkingRoute(data, wander, seed) {
  const maze = data.maze;
  const w = maze.width;
  const path = Array.from(/** @type {Uint32Array} */ (data.validation.path));
  const onPath = new Set(path);
  const visited = new Set(path);
  /** @type {number[]} */
  const route = [];
  const target = (wander - 1) * path.length;
  let extra = 0;
  let rs = seed >>> 0 || 1;
  const rnd = () => (rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < path.length; i++) {
    const t = path[i];
    route.push(t);
    if (target * ((i + 1) / path.length) - extra <= 0) continue;
    const tx = t % w;
    const ty = (t - tx) / w;
    for (let dir = 0; dir < DIR_COUNT; dir++) {
      const n = (ty + DIR_DY[dir]) * w + tx + DIR_DX[dir];
      if (maze.tiles[n] !== TILE.FLOOR || visited.has(n)) continue;
      /** @type {number[]} */
      const trail = [n];
      visited.add(n);
      let cur = n;
      while (trail.length < 20) {
        const cx = cur % w;
        const cy = (cur - cx) / w;
        /** @type {number[]} */
        const options = [];
        for (let d2 = 0; d2 < DIR_COUNT; d2++) {
          const m = (cy + DIR_DY[d2]) * w + cx + DIR_DX[d2];
          if (maze.tiles[m] === TILE.FLOOR && !visited.has(m) && !onPath.has(m)) options.push(m);
        }
        if (options.length === 0) break;
        cur = options[Math.floor(rnd() * options.length)];
        visited.add(cur);
        trail.push(cur);
      }
      for (const k of trail) route.push(k);
      for (let k = trail.length - 2; k >= 0; k--) route.push(trail[k]);
      route.push(t);
      extra += trail.length * 2;
      break;
    }
  }
  return route;
}

/**
 * Walk a route through the **real reducer** at 60 Hz, steering like a mouse player (yaw flick
 * capped at 0.25 rad per step, forward held when roughly aligned), and report how low the tank got.
 * @param {number} level
 * @param {number} seed
 * @param {number} wander
 * @returns {{won:boolean, minFraction:number, lowFuelCues:number}}
 */
function reducerWalk(level, seed, wander) {
  const data = buildLevel(levelParams(level), seed);
  const route = walkingRoute(data, wander, seed);
  const w = data.maze.width;
  const s = createInitialState();
  reducer(s, { type: 'newGame', seed });
  s.level = level;
  reducer(s, { type: 'levelReady', data });
  const input = { moveX: 0, moveY: 0, turn: 0, lookDX: 0 };
  const tick = { type: 'tick', dt: 1 / 60, input };
  const tank = s.run.fuelMax;
  let wp = 0;
  let min = s.run.fuel;
  let cues = 0;
  let stall = 0;
  let last = -1;
  while (s.phase === 'playing' && s.run.levelTime < 3600) {
    for (;;) {
      const t = route[wp];
      const tx = (t % w) + 0.5;
      const ty = Math.floor(t / w) + 0.5;
      if (wp < route.length - 1 && Math.hypot(s.player.x - tx, s.player.y - ty) < 0.3) wp++;
      else break;
    }
    if (wp !== last) {
      last = wp;
      stall = 0;
    } else if (++stall > 600) {
      assert.fail(`level ${level}, seed ${seed}: the reducer autopilot stalled at waypoint ${wp}`);
    }
    const t = route[wp];
    const aimX = (t % w) + 0.5;
    const aimY = Math.floor(t / w) + 0.5;
    const err = angleDiff(s.player.angle, Math.atan2(aimY - s.player.y, aimX - s.player.x));
    input.lookDX = clamp(err, -0.25, 0.25);
    input.moveY = Math.abs(err) < 0.5 ? 1 : 0.2;
    reducer(s, tick);
    for (let i = 0; i < s.events.length; i++) if (s.events[i].type === 'lowFuel') cues++;
    if (s.run.fuel < min) min = s.run.fuel;
  }
  return { won: s.phase === 'levelComplete', minFraction: min / tank, lowFuelCues: cues };
}

test('tension: the torch runs measurably lower deep in the curve, and every walk still wins', () => {
  // Regression. With the old economy an explorer was topped up by a flask the moment the tank fell
  // below ~82 %, the drain ramp was 1.075× at level 10 and every flask was 35 % of the tank, so the
  // lowest tank of a 2×-wander run averaged 0.71 on level 1 and 0.64 on level 10, and `lowFuel`
  // fired 0 times in 36 wandering runs: "L1 generous, L10 tense" was not delivered. This drives the
  // shipped reducer — not a model of it — over two bands of real levels, with a wanderer and with a
  // walker who never leaves the solution path (the one a thinner economy kills first).
  const SEEDS_PER_LEVEL = 5;
  /**
   * @param {number[]} levels
   * @param {number} wander
   * @returns {{avgMin:number, cues:number}}
   */
  function band(levels, wander) {
    let sum = 0;
    let cues = 0;
    let runs = 0;
    for (const level of levels) {
      for (let k = 0; k < SEEDS_PER_LEVEL; k++) {
        const seed = 7_919 * (level + 3) + 104_729 * k;
        const r = reducerWalk(level, seed, wander);
        assert.ok(
          r.won,
          `BLOCKER — level ${level}, seed ${seed}: a ${wander}× walker on the real reducer ran out of torch`,
        );
        sum += r.minFraction;
        cues += r.lowFuelCues;
        runs++;
      }
    }
    return { avgMin: sum / runs, cues };
  }
  // Level 1 is the lean first floor (unlocks wave, `LEVEL.FIRST_*`): deliberately tight, so it is
  // held to "every walk wins" only, and the generous band the depth trend is measured from is the
  // start of the real size curve, levels 2–3.
  band([1], FUEL.WANDER);
  band([1], 1);
  const EARLY = [2, 3];
  const DEEP = [10, 11, 12];
  const early2 = band(EARLY, FUEL.WANDER);
  const deep2 = band(DEEP, FUEL.WANDER);
  const early1 = band(EARLY, 1);
  const deep1 = band(DEEP, 1);
  console.log(
    `lowest tank, ${FUEL.WANDER}× wander: L${EARLY.join('/')} ${early2.avgMin.toFixed(3)} → ` +
      `L${DEEP.join('/')} ${deep2.avgMin.toFixed(3)} (${deep2.cues} lowFuel cues)  ·  ` +
      `path only: ${early1.avgMin.toFixed(3)} → ${deep1.avgMin.toFixed(3)} (${deep1.cues} cues)`,
  );
  assert.ok(
    // 0.08 rather than 0.12 since the band moved from levels 1–2 to 2–3 (the old 16×16 level 1 was
    // the most generous level in the game; measured at the same seeds: 0.705 → 0.609). The path-only
    // walker below, the player a thinner economy kills first, still has to show the full 0.12.
    deep2.avgMin <= early2.avgMin - 0.08,
    `a wandering player's lowest tank must fall with depth: ${early2.avgMin.toFixed(3)} → ${deep2.avgMin.toFixed(3)}`,
  );
  assert.ok(
    deep1.avgMin <= early1.avgMin - 0.12,
    `a direct player's lowest tank must fall with depth: ${early1.avgMin.toFixed(3)} → ${deep1.avgMin.toFixed(3)}`,
  );
  assert.equal(early2.cues + early1.cues, 0, 'the early levels are generous: no low-fuel alarm');
  // No longer asserted: "the deep levels reach the low-fuel alarm at least sometimes". Topping off
  // from any flask (`FUEL.OIL_MIN_ROOM`, a playtest request) lifted the deep band's lowest tank from
  // ~0.47 to ~0.55 and the alarm stopped firing in these runs; the easier curve was accepted. The
  // depth trend above is still enforced.
});
