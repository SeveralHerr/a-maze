// @ts-check
/**
 * @file `node tools/validate-mazes.mjs` — the 100 %-solvability + playability gate
 * (ARCHITECTURE.md §4.4, §5).
 *
 * Two sweeps, both of which exit non-zero on any single failure.
 *
 * **1. The size × braid × seed matrix.** Thousands of mazes from the degenerate extremes up to
 * 512×512 cells, each asserted for:
 *   • `solvable`, `fullyConnected`, `bordersSealed`, and an empty `errors[]`
 *   • start and exit on FLOOR tiles, on the odd cell lattice, inside the grid
 *   • `loops === 0` whenever `braid === 0` (a perfect maze is a spanning tree)
 *   • determinism: the same seed replays a bit-identical tile map
 *
 * **2. The campaign sweep** — levels 1..30, {@link LEVEL_SEEDS} seeds each, built through the real
 * `levelParams()` from `src/state/balance.js`. The maze module may not import `src/state`
 * (ARCHITECTURE.md §2) but this **tool** may, and doing so removes the hand-matched twin that used
 * to drift away from the shipped curve. Every level is asserted for:
 *   • **the refuel chain** — walking the solution path at the documented 2.0× wander factor and
 *     taking every flask within 3 tiles of it, the torch never reaches 0 and no two consecutive
 *     reachable flasks are further apart than `oilTargetGap`. A level a competent player cannot
 *     chain refuels through is a **release blocker**, so this is the assertion that matters most.
 *   • the walked-feasibility number: seconds of walking at 2.0× wander vs. seconds of fuel the
 *     chain actually hands out (tank + flasks × refuel). Reported per level, asserted < 1.
 *   • every item on a floor tile, on a tile centre, inside the grid, not `taken`
 *   • no two items on the same tile
 *   • every item reachable from the start (a gem behind a wall is a lie the HUD tells)
 *   • exactly one hidden map scroll (§4.8) — zero only when no free floor tile is left — not on the
 *     start or exit; its detour depth off the route is reported per level
 *   • the exit is still the **BFS-farthest** cell, so a massive maze has a massive route
 *   • torches on wall tiles facing a corridor; the level replays exactly from its seed
 *
 * Results are written to `logs/validate-mazes.json`. The run is bounded to ~90 s: if the matrix
 * deadline hits, its remaining cells are skipped and the report is marked `truncated` (still a pass
 * — the gate is about failures, not coverage count). The campaign sweep is never truncated.
 *
 * Flags: `--quick` (a small matrix, for a fast local loop), `--seeds=N` (override the seed budget).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMaze } from '../src/maze/generator.js';
import { validateMaze } from '../src/maze/validator.js';
import { buildLevel } from '../src/maze/level.js';
import { fuelBudget, walkRefuelChain } from '../src/maze/populate.js';
import { TILE, DIR_DX, DIR_DY } from '../src/maze/constants.js';
import { levelParams } from '../src/state/balance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');
const SEED_OVERRIDE = Number((process.argv.find((a) => a.startsWith('--seeds=')) || '').slice(8));

/** Wall-clock budget for the matrix half of the run, milliseconds (the campaign half is bounded by its own size). */
const TIME_BUDGET_MS = QUICK ? 8000 : 45000;

/**
 * The size matrix (cols × rows). Three kinds of shape are in here on purpose:
 * the degenerate extremes (1×1 … 2×2), **long thin corridors** (1×300, 300×1, 300×7, 7×300 — where
 * the carve stack is deepest and where a shortcut or a braid has almost no room to work), and
 * **non-square, coprime, prime-sided grids** (37×41, 101×103, 17×31) where a bug in the
 * `cell ↔ tile` arithmetic that a square grid hides has nowhere left to hide.
 */
const SIZES = QUICK
  ? [[1, 1], [2, 2], [6, 6], [17, 31], [1, 300], [64, 64]]
  : [
      [1, 1], [1, 2], [2, 1], [2, 2], [3, 7], [6, 6], [10, 10], [17, 31],
      [1, 300], [300, 1], [300, 7], [7, 300], [37, 41], [101, 103],
      [40, 40], [64, 64], [128, 128], [256, 256], [512, 512],
    ];

/** Braid fractions: 0 must give a perfect maze, 1 must still be fully connected. */
const BRAIDS = [0, 0.1, 0.5, 1];

/**
 * Shortcut densities swept beside the braid fractions: none, and the density the deepest shipped
 * level asks for (one per 4 cells, detour 4, route keep 0.7). Every campaign level runs the
 * shortcut pass, so a matrix that never passes `shortcuts` is not testing what the game builds.
 * Shortcut builds cost several times a plain carve, so they get {@link SHORTCUT_SEED_DIVISOR} of
 * the seed budget.
 */
const SHORTCUTS = [0, 0.25];

/** How much of a size's seed budget the shortcut sweep gets (it is the expensive one). */
const SHORTCUT_SEED_DIVISOR = 6;

/** Seeds for a size with ≤ this many cells are capped: a 1×1 maze has one shape, not 4 000. */
const TINY_CELLS = 4;

/** Seed cap for a {@link TINY_CELLS}-or-smaller size. */
const TINY_SEEDS = 200;

/** Levels built end-to-end through `buildLevel`. */
const LEVELS = 30;

/** Seeds per level in the buildLevel sweep (the contract asks for ≥ 25). */
const LEVEL_SEEDS = QUICK ? 4 : 25;

/** Walking model, mirrored from `src/maze/populate.js` for the feasibility arithmetic. */
const WALK_SPEED = 3.2;
const CORNER_FACTOR = 1.18;
const WANDER_FACTOR = 2;

/**
 * Seed budget for a size: small mazes are cheap, so they get the statistical weight; huge ones
 * are about not falling over, so a handful of seeds is enough.
 * @param {number} cells
 * @returns {number}
 */
function seedsFor(cells) {
  if (Number.isFinite(SEED_OVERRIDE) && SEED_OVERRIDE > 0) return SEED_OVERRIDE;
  // Roughly constant work per size: the numerator is "cells per size" and the caps keep the small
  // end from ballooning and the huge end from being skipped entirely.
  const n = Math.round((QUICK ? 24000 : 400000) / Math.max(1, cells));
  // A 1×1, 1×2, 2×1 or 2×2 grid has a handful of possible mazes; 16 000 seeds of it were 55 % of
  // the old matrix total and proved nothing the first 200 had not. Coverage is shapes, not counts.
  if (cells <= TINY_CELLS) return Math.min(QUICK ? 40 : TINY_SEEDS, Math.max(2, n));
  return Math.max(2, Math.min(QUICK ? 40 : 4000, n));
}

/**
 * FNV-1a over the tile buffer — a cheap fingerprint used for the determinism check.
 * @param {Uint8Array} tiles
 * @returns {number} uint32
 */
function hashTiles(tiles) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < tiles.length; i++) h = Math.imul(h ^ tiles[i], 16777619);
  return h >>> 0;
}

/** @type {string[]} Every failure found, in discovery order (first 50 are printed). */
const failures = [];

/** @type {Map<string, {size:string, cells:number, mazes:number, failures:number, ms:number}>} */
const bySize = new Map();

/**
 * Record a failed assertion.
 * @param {string} where
 * @param {string} message
 * @returns {void}
 */
function fail(where, message) {
  failures.push(`${where}: ${message}`);
}

/**
 * Assert every structural property of one maze.
 * @param {import('../src/core/types.js').Maze} maze
 * @param {number} braid
 * @param {string} where
 * @returns {import('../src/core/types.js').Validation}
 */
function checkMaze(maze, braid, where) {
  const v = validateMaze(maze);
  if (v.errors.length > 0) fail(where, `validation errors: ${v.errors.join('; ')}`);
  if (!v.solvable) fail(where, 'not solvable');
  if (!v.fullyConnected) fail(where, 'not fully connected');
  if (!v.bordersSealed) fail(where, 'border not sealed');
  if (braid === 0 && v.loops !== 0) fail(where, `perfect maze reported ${v.loops} loops`);
  if (v.loops < 0) fail(where, `negative loop count ${v.loops}`);
  if (braid === 0) {
    // Independent of `loops`, which is computed from the same edge scan: a spanning tree over n
    // cells carves exactly n cells + (n−1) gaps, so `2n − 1` floor tiles is the whole maze. If the
    // validator's edge count and this count ever disagree, one of them is lying.
    const perfectFloor = 2 * maze.cols * maze.rows - 1;
    if (v.floorCount !== perfectFloor) {
      fail(where, `perfect maze has ${v.floorCount} floor tiles, not the ${perfectFloor} a spanning tree carves`);
    }
  }

  for (const [name, p] of /** @type {const} */ ([['start', maze.start], ['exit', maze.exit]])) {
    if (!(p.x & 1) || !(p.y & 1)) fail(where, `${name} (${p.x},${p.y}) is off the odd cell lattice`);
    if (p.x < 0 || p.y < 0 || p.x >= maze.width || p.y >= maze.height) fail(where, `${name} out of bounds`);
    else if (maze.tiles[p.y * maze.width + p.x] !== TILE.FLOOR) fail(where, `${name} is not on a floor tile`);
  }
  if (v.pathLength > 0 && v.pathLength > 2 * maze.cols * maze.rows - 1) {
    fail(where, `path of ${v.pathLength} tiles is longer than the maze has cells`);
  }
  return v;
}

/**
 * Run the size × braid × seed matrix.
 * @param {number} deadline
 * @returns {{mazes:number, truncated:boolean}}
 */
function runMatrix(deadline) {
  let mazes = 0;
  let truncated = false;

  for (const [cols, rows] of SIZES) {
    const cells = cols * rows;
    const key = `${cols}x${rows}`;
    const entry = { size: key, cells, mazes: 0, failures: 0, ms: 0 };
    bySize.set(key, entry);
    const seeds = seedsFor(cells);
    const t0 = performance.now();
    const failuresBefore = failures.length;

    outer: for (const density of SHORTCUTS) {
      const shortcuts = Math.round(cells * density);
      const budget = density > 0 ? Math.max(2, Math.round(seeds / SHORTCUT_SEED_DIVISOR)) : seeds;
      for (const braid of BRAIDS) {
        for (let s = 0; s < budget; s++) {
          if (performance.now() > deadline) {
            truncated = true;
            break outer;
          }
          const seed = s * 2654435761 + cells;
          const where = `${key} braid=${braid} shortcuts=${shortcuts} seed=${seed}`;
          /** @type {import('../src/maze/generator.js').GenerateParams} */
          const params = { cols, rows, seed, braid, shortcuts, shortcutDetour: 4, shortcutRouteKeep: 0.7 };
          let maze;
          try {
            maze = generateMaze(params);
          } catch (err) {
            fail(where, `generateMaze threw ${String(err)}`);
            continue;
          }
          // Shortcuts add loops exactly as braid does, so only a maze with neither is a tree.
          checkMaze(maze, braid + shortcuts, where);
          mazes++;
          entry.mazes++;

          // Determinism: re-roll the first seed of each combination, plus a periodic sample.
          if (s === 0 || s % 17 === 0) {
            const again = generateMaze(params);
            if (hashTiles(maze.tiles) !== hashTiles(again.tiles)) fail(where, 'same seed produced different tiles');
            if (again.exit.x !== maze.exit.x || again.exit.y !== maze.exit.y) fail(where, 'same seed produced a different exit');
          }
        }
      }
    }
    entry.ms = Math.round(performance.now() - t0);
    entry.failures = failures.length - failuresBefore;
  }
  return { mazes, truncated };
}

// ── Campaign sweep ─────────────────────────────────────────────────────────────────────────────

/** Reusable scratch for {@link bfsFromStart} / the duplicate check, grown as the levels grow. */
let distScratch = new Int32Array(0);
let queueScratch = new Int32Array(0);
let usedScratch = new Uint8Array(0);

/**
 * BFS distance in tiles from the start over FLOOR tiles, into a reused buffer.
 *
 * Reused rather than freshly allocated because the campaign sweep runs it 750 times over grids of
 * up to 66 049 tiles, and a tool that allocates 200 MB of short-lived Int32Arrays measures the GC
 * as much as the maze.
 *
 * @param {import('../src/core/types.js').Maze} maze
 * @returns {Int32Array} distance per tile, −1 where unreachable (valid for `width*height` entries)
 */
function bfsFromStart(maze) {
  const { width, height, tiles, start } = maze;
  const total = width * height;
  if (distScratch.length < total) {
    distScratch = new Int32Array(total);
    queueScratch = new Int32Array(total);
    usedScratch = new Uint8Array(total);
  }
  const dist = distScratch;
  const queue = queueScratch;
  dist.fill(-1, 0, total);
  let head = 0;
  let tail = 0;
  const from = start.y * width + start.x;
  dist[from] = 0;
  queue[tail++] = from;
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;
    const nd = dist[idx] + 1;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (tiles[n] !== TILE.FLOOR || dist[n] >= 0) continue;
      dist[n] = nd;
      queue[tail++] = n;
    }
  }
  return dist;
}

/** Scratch for {@link bfsFromPath}; separate from `distScratch`, which is still in use by then. */
let pathDistScratch = new Int32Array(0);

/**
 * Multi-source BFS distance in tiles from the nearest solution-path tile (the map scroll's detour
 * depth). Reuses `queueScratch`, so it must run after {@link bfsFromStart} has finished.
 * @param {import('../src/core/types.js').Maze} maze
 * @param {Uint32Array|null} path
 * @returns {Int32Array} distance per tile, −1 where unreachable
 */
function bfsFromPath(maze, path) {
  const { width, height, tiles } = maze;
  const total = width * height;
  if (pathDistScratch.length < total) pathDistScratch = new Int32Array(total);
  const dist = pathDistScratch;
  const queue = queueScratch;
  dist.fill(-1, 0, total);
  if (!path) return dist;
  let head = 0;
  let tail = 0;
  for (let i = 0; i < path.length; i++) {
    if (dist[path[i]] >= 0) continue;
    dist[path[i]] = 0;
    queue[tail++] = path[i];
  }
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (tiles[n] !== TILE.FLOOR || dist[n] >= 0) continue;
      dist[n] = dist[idx] + 1;
      queue[tail++] = n;
    }
  }
  return dist;
}

/**
 * Every per-level assertion: items, reachability, the exit's farthest-cell property, torches, and
 * the refuel chain.
 *
 * @param {import('../src/core/types.js').LevelData} data
 * @param {ReturnType<typeof levelParams>} params
 * @param {string} where
 * @returns {{gems:number, oils:number, maps:number, mapDetour:number, mapDeadEnd:boolean,
 *   walk:ReturnType<typeof walkRefuelChain>, feasibility:number}}
 */
function checkLevel(data, params, where) {
  const { maze, items } = data;
  const { width, height, tiles } = maze;
  const total = width * height;
  const dist = bfsFromStart(maze);
  const used = usedScratch;
  used.fill(0, 0, total);

  // ── Items: on a floor tile centre, inside the grid, unique, reachable, not pre-taken ──────────
  let gems = 0;
  let oils = 0;
  let maps = 0;
  let mapIdx = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const tx = item.x - 0.5;
    const ty = item.y - 0.5;
    if (!Number.isInteger(tx) || !Number.isInteger(ty)) {
      fail(where, `item ${item.id} is not on a tile centre`);
      continue;
    }
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) {
      fail(where, `item ${item.id} is outside the maze`);
      continue;
    }
    const idx = ty * width + tx;
    if (tiles[idx] !== TILE.FLOOR) fail(where, `item ${item.id} is inside a wall`);
    if (used[idx] !== 0) fail(where, `two items share tile ${idx}`);
    used[idx] = 1;
    if (dist[idx] < 0) fail(where, `item ${item.id} at tile ${idx} is unreachable from the start`);
    if (item.taken) fail(where, `item ${item.id} starts taken`);
    if (item.kind === 'gem') gems++;
    else if (item.kind === 'oil') oils++;
    else if (item.kind === 'map') {
      maps++;
      mapIdx = idx;
    } else fail(where, `item ${item.id} has unknown kind ${String(item.kind)}`);
  }
  if (items.length > 0 && items[items.length - 1].id !== items.length - 1) {
    fail(where, 'item ids are not a dense 0..n-1 range');
  }

  // ── The hidden map scroll (§4.8): exactly one, off start/exit, unstacked (checked above) ─────
  const startIdx = maze.start.y * width + maze.start.x;
  const exitIdx = maze.exit.y * width + maze.exit.x;
  /** Off-path depth of the scroll, −1 when there is none. */
  let mapDetour = -1;
  let mapDeadEnd = false;
  if (maps > 1) fail(where, `expected exactly one map scroll, got ${maps}`);
  if (maps === 0) {
    // Zero is legal only when there is literally no free floor tile left for it.
    const path = data.validation.path;
    let free = 0;
    for (let i = 0; i < total; i++) if (tiles[i] === TILE.FLOOR && used[i] === 0 && dist[i] >= 0) free++;
    free -= used[startIdx] === 0 ? 1 : 0;
    if (exitIdx !== startIdx && used[exitIdx] === 0) free--;
    if (path) for (let i = 1; i < 3 && i < path.length; i++) if (path[i] !== exitIdx && used[path[i]] === 0) free--;
    if (free > 0) fail(where, `no map scroll although ${free} free floor tiles remain`);
  } else {
    if (mapIdx === startIdx) fail(where, 'the map scroll is on the start tile');
    if (mapIdx === exitIdx) fail(where, 'the map scroll is on the exit tile');
    const fromPath = bfsFromPath(maze, data.validation.path);
    mapDetour = fromPath[mapIdx];
    let n = 0;
    for (let d = 0; d < 4; d++) if (tiles[mapIdx + DIR_DX[d] + DIR_DY[d] * width] === TILE.FLOOR) n++;
    mapDeadEnd = n === 1 && mapDetour > 0;
  }

  // Counts are floors, never ceilings: the refuel chain may add flasks, and the scatter may add
  // gems, but a level must never ship with fewer than the curve asked for.
  if (gems < params.gems) fail(where, `expected at least ${params.gems} gems, got ${gems}`);
  if (oils < params.oil) fail(where, `expected at least ${params.oil} oil flasks, got ${oils}`);

  // ── The exit is the farthest cell: a massive maze must have a massive route ──────────────────
  let farthest = -1;
  for (let cy = 0; cy < maze.rows; cy++) {
    const row = (cy * 2 + 1) * width;
    for (let cx = 0; cx < maze.cols; cx++) {
      const d = dist[row + cx * 2 + 1];
      if (d > farthest) farthest = d;
    }
  }
  const exitDist = dist[maze.exit.y * width + maze.exit.x];
  if (exitDist !== farthest) {
    fail(where, `exit is ${exitDist} tiles from the start but the farthest cell is ${farthest}`);
  }

  // ── Torches: on wall tiles, facing a corridor ────────────────────────────────────────────────
  for (const t of data.torches) {
    if (tiles[t.y * width + t.x] !== TILE.WALL) fail(where, 'torch is not on a wall tile');
    else if (tiles[(t.y + DIR_DY[t.face]) * width + (t.x + DIR_DX[t.face])] !== TILE.FLOOR) {
      fail(where, 'torch faces solid rock');
    }
  }

  // ── THE REFUEL CHAIN ─────────────────────────────────────────────────────────────────────────
  const walk = walkRefuelChain(maze, data.validation, items, params);
  // A route shorter than one chain hop needs no flask at all; anything longer must have one.
  if (walk.flasks === 0 && data.validation.pathLength - 1 > walk.gap) {
    fail(where, 'no oil flask is reachable from the solution path');
  }
  if (walk.maxGap > walk.gap) {
    fail(where, `refuel chain broken: ${walk.maxGap} tiles between reachable flasks, limit ${walk.gap}`);
  }
  const asked = Number(/** @type {{oilTargetGap?:number}} */ (params).oilTargetGap);
  if (Number.isFinite(asked) && asked >= 1 && walk.maxGap > asked) {
    fail(where, `refuel chain exceeds the requested oilTargetGap: ${walk.maxGap} > ${asked}`);
  }
  if (walk.minFuel <= 0) {
    fail(where, `the torch dies on the way: ${walk.minFuel}s at the worst point of the chain`);
  }
  if (!walk.ok) fail(where, 'walkRefuelChain reported the level as not walkable');

  // Walked feasibility: seconds of walking at 2.0× wander vs seconds of fuel the chain hands out.
  const needed = walk.walked * (CORNER_FACTOR / WALK_SPEED);
  const available = walk.tank + walk.flasks * walk.refuel;
  const feasibility = needed / available;
  if (!(feasibility < 1)) {
    fail(where, `walked ${Math.round(needed)}s of route against ${Math.round(available)}s of fuel`);
  }

  // ── Fuel budget agreement ────────────────────────────────────────────────────────────────────
  const budget = fuelBudget(data.validation.pathLength, params, maze.cols * maze.rows);
  if (Math.abs(budget.fuel - data.fuel) > 1e-9) fail(where, 'LevelData.fuel disagrees with fuelBudget');
  if (!(data.par > 0 && Number.isFinite(data.par))) fail(where, `par ${data.par} is not a usable target`);
  if (data.par < budget.directTime) fail(where, `par ${data.par} is below the optimal route time ${budget.directTime}`);

  return { gems, oils, maps, mapDetour, mapDeadEnd, walk, feasibility };
}

/**
 * Build every level 1..30 several times and assert the population, chain and fuel guarantees.
 * @returns {{levels:Array<Object>, built:number, worstReserve:number, worstFeasibility:number}}
 */
function runLevels() {
  const levels = [];
  let built = 0;
  let worstReserve = 1;
  let worstFeasibility = 0;

  for (let level = 1; level <= LEVELS; level++) {
    const params = levelParams(level);
    let pathSum = 0;
    let manhattanSum = 0;
    let walkedSum = 0;
    let reserveWorst = 1;
    let gapWorst = 0;
    let gapLimit = 0;
    let feasWorst = 0;
    let items = 0;
    let gems = 0;
    let oils = 0;
    let torches = 0;
    let flasks = 0;
    let ms = 0;
    /** @type {number[]} */
    const mapDetours = [];
    let mapDeadEnds = 0;

    for (let s = 0; s < LEVEL_SEEDS; s++) {
      const seed = level * 7919 + s * 104729;
      const where = `level ${level} seed ${seed}`;
      let data;
      const t0 = performance.now();
      try {
        data = buildLevel(params, seed);
      } catch (err) {
        fail(where, `buildLevel threw ${String(err)}`);
        continue;
      }
      ms += performance.now() - t0;
      built++;
      // Shortcuts add loops just as braid does, so only a level with neither must be a tree.
      checkMaze(data.maze, (params.braid ?? 0) + (params.shortcuts ?? 0), where);
      const r = checkLevel(data, params, where);

      pathSum += data.validation.pathLength;
      // How much longer the real route is than walking straight from start to exit. It is the one
      // number that says whether a deep level is *bigger* or only *wider*: braiding cuts the route
      // hard on purpose (it is the difficulty curve's brake), and this is where that shows.
      manhattanSum +=
        Math.abs(data.maze.exit.x - data.maze.start.x) + Math.abs(data.maze.exit.y - data.maze.start.y) + 1;
      walkedSum += r.walk.walked;
      reserveWorst = Math.min(reserveWorst, r.walk.minFuelFraction);
      gapWorst = Math.max(gapWorst, r.walk.maxGap);
      gapLimit = r.walk.gap;
      feasWorst = Math.max(feasWorst, r.feasibility);
      items = data.items.length;
      gems = r.gems;
      oils = r.oils;
      flasks = r.walk.flasks;
      torches = data.torches.length;
      if (r.maps === 1) mapDetours.push(r.mapDetour);
      if (r.mapDeadEnd) mapDeadEnds++;

      // Determinism of the whole level, not just the maze.
      if (s === 0) {
        const again = buildLevel(params, seed);
        if (hashTiles(again.maze.tiles) !== hashTiles(data.maze.tiles)) fail(where, 'level tiles are not deterministic');
        if (JSON.stringify(again.items) !== JSON.stringify(data.items)) fail(where, 'level items are not deterministic');
        if (JSON.stringify(again.torches) !== JSON.stringify(data.torches)) fail(where, 'level torches are not deterministic');
      }
    }

    const n = Math.max(1, LEVEL_SEEDS);
    worstReserve = Math.min(worstReserve, reserveWorst);
    worstFeasibility = Math.max(worstFeasibility, feasWorst);
    mapDetours.sort((a, b) => a - b);
    levels.push({
      level,
      size: `${params.cols}x${params.rows}`,
      cells: params.cols * params.rows,
      path: Math.round(pathSum / n),
      straight: Math.round(manhattanSum / n),
      routeRatio: manhattanSum > 0 ? Math.round((pathSum / manhattanSum) * 100) / 100 : 0,
      tank: params.fuelSeconds,
      gems,
      oils,
      chainFlasks: flasks,
      items,
      torches,
      maxGap: gapWorst,
      gapLimit,
      walked: Math.round(walkedSum / n),
      reserve: Math.round(reserveWorst * 1000) / 1000,
      feasibility: Math.round(feasWorst * 1000) / 1000,
      msPerBuild: Math.round((ms / n) * 100) / 100,
      mapDetour: {
        min: mapDetours.length > 0 ? mapDetours[0] : -1,
        median: mapDetours.length > 0 ? mapDetours[mapDetours.length >> 1] : -1,
        max: mapDetours.length > 0 ? mapDetours[mapDetours.length - 1] : -1,
        limit: Math.floor(Number(params.oilTargetGap) / 4),
      },
      mapDeadEnds,
    });
  }

  return { levels, built, worstReserve, worstFeasibility };
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────

const started = performance.now();
const matrix = runMatrix(started + TIME_BUDGET_MS);
const campaign = runLevels();
const ms = Math.round(performance.now() - started);

const probe = levelParams(1);
const hasDensity = ['gemDensity', 'oilDensity', 'oilTargetGap'].filter((k) => Number.isFinite(Number(/** @type {Record<string, unknown>} */ (probe)[k])));

console.log(`\nA-MAZE maze validation${QUICK ? ' (quick)' : ''}\n`);
console.log(`  ${'size'.padEnd(10)}${'cells'.padStart(9)}${'mazes'.padStart(9)}${'fails'.padStart(8)}${'ms'.padStart(8)}`);
console.log(`  ${'-'.repeat(43)}`);
for (const e of bySize.values()) {
  console.log(
    `  ${e.size.padEnd(10)}${String(e.cells).padStart(9)}${String(e.mazes).padStart(9)}${String(e.failures).padStart(8)}${String(e.ms).padStart(8)}`,
  );
}
console.log(`  ${'-'.repeat(43)}`);
console.log(`  ${'total'.padEnd(10)}${''.padStart(9)}${String(matrix.mazes).padStart(9)}${String(failures.length).padStart(8)}${String(ms).padStart(8)}`);

console.log(`\n  campaign — src/state/balance.js levelParams(), ${LEVEL_SEEDS} seeds per level`);
console.log(
  `  density fields supplied by balance.js: ${hasDensity.length > 0 ? hasDensity.join(', ') : 'none (src/maze fallbacks in use)'}\n`,
);
console.log(
  `  ${'lvl'.padEnd(4)}${'size'.padEnd(9)}${'path'.padStart(6)}${'/straight'.padStart(10)}${'tank'.padStart(6)}${'gems'.padStart(6)}${'oil'.padStart(6)}` +
    `${'chain'.padStart(7)}${'torch'.padStart(7)}${'maxgap'.padStart(7)}${'limit'.padStart(7)}${'walked'.padStart(8)}${'reserve'.padStart(9)}${'feas'.padStart(7)}${'ms'.padStart(7)}` +
    `${'map min/med/max'.padStart(17)}`,
);
console.log(`  ${'-'.repeat(122)}`);
for (const l of campaign.levels) {
  if (l.level > 12 && l.level % 3 !== 0 && l.level !== LEVELS) continue; // keep the table readable
  console.log(
    `  ${String(l.level).padEnd(4)}${l.size.padEnd(9)}${String(l.path).padStart(6)}${`${l.routeRatio}×`.padStart(10)}${String(l.tank).padStart(6)}` +
      `${String(l.gems).padStart(6)}${String(l.oils).padStart(6)}${String(l.chainFlasks).padStart(7)}${String(l.torches).padStart(7)}` +
      `${String(l.maxGap).padStart(7)}${String(l.gapLimit).padStart(7)}${String(l.walked).padStart(8)}${`${(l.reserve * 100).toFixed(0)}%`.padStart(9)}` +
      `${l.feasibility.toFixed(2).padStart(7)}${l.msPerBuild.toFixed(1).padStart(7)}` +
      `${`${l.mapDetour.min}/${l.mapDetour.median}/${l.mapDetour.max}`.padStart(17)}`,
  );
}
{
  const outOfBand = campaign.levels.filter((l) => l.mapDetour.min < 4 || l.mapDetour.max > l.mapDetour.limit).map((l) => l.level);
  const deadEnds = campaign.levels.reduce((n, l) => n + l.mapDeadEnds, 0);
  console.log(
    `\n  map scroll: detour depth (tiles off the route) shown min/median/max per level; ` +
      `${deadEnds}/${campaign.built} scrolls at an off-route dead end; ` +
      `levels with a detour outside [4, oilTargetGap/4]: ${outOfBand.length > 0 ? outOfBand.join(', ') : 'none'}`,
  );
}
console.log(
  `\n  worst torch reserve across the campaign: ${(campaign.worstReserve * 100).toFixed(1)} % of the tank` +
    `   ·   worst walked/available fuel: ${campaign.worstFeasibility.toFixed(2)}`,
);
{
  // `path/straight` is the route against the straight-line (Manhattan) distance from start to
  // exit. Deep levels stop growing in route length long before they stop growing in area — that is
  // the braid ramp doing its job (`LEVEL.BRAID_MAX`, a balance decision), but it belongs in the
  // report rather than folded invisibly into "path".
  const first = campaign.levels[0];
  const last = campaign.levels[campaign.levels.length - 1];
  const deepest = campaign.levels.reduce((a, b) => (b.path > a.path ? b : a), first);
  console.log(
    `  route vs straight line: level 1 ${first.routeRatio}× (${first.path} tiles), ` +
      `level ${last.level} ${last.routeRatio}× (${last.path} tiles), ` +
      `longest route at level ${deepest.level} (${deepest.path} tiles)`,
  );
}

const report = {
  total: matrix.mazes + campaign.built,
  failures: failures.length,
  bySize: Object.fromEntries(Array.from(bySize.entries()).map(([k, v]) => [k, { mazes: v.mazes, failures: v.failures, ms: v.ms }])),
  ms,
  matrixMazes: matrix.mazes,
  levelsBuilt: campaign.built,
  truncated: matrix.truncated,
  levelSeeds: LEVEL_SEEDS,
  balanceDensityFields: hasDensity,
  worstReserve: campaign.worstReserve,
  worstFeasibility: campaign.worstFeasibility,
  levels: campaign.levels,
  errors: failures.slice(0, 50),
  node: process.version,
  at: new Date().toISOString(),
};
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'logs', 'validate-mazes.json'), `${JSON.stringify(report, null, 2)}\n`);

if (matrix.truncated) console.log(`\n  note: the ${TIME_BUDGET_MS / 1000} s budget cut the matrix short; coverage is partial.`);
if (failures.length > 0) {
  console.log(`\n  ${failures.length} FAILURE(S):`);
  for (const f of failures.slice(0, 50)) console.log(`    ${f}`);
  if (failures.length > 50) console.log(`    … and ${failures.length - 50} more (see logs/validate-mazes.json)`);
  console.log('');
  process.exit(1);
}
console.log(`\n  OK — ${report.total} mazes, 0 failures, ${ms} ms → logs/validate-mazes.json\n`);
