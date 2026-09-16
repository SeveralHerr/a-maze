// @ts-check
/**
 * @file `node tools/validate-mazes.mjs` — the 100 %-solvability gate (ARCHITECTURE.md §4.4, §5).
 *
 * Generates thousands of mazes across a size × braid × seed matrix and asserts, for every single
 * one, the properties the rest of the game takes for granted:
 *
 *   • `solvable`, `fullyConnected`, `bordersSealed`, and an empty `errors[]`
 *   • start and exit on FLOOR tiles, on the odd cell lattice, inside the grid
 *   • `loops === 0` whenever `braid === 0` (a perfect maze is a spanning tree)
 *   • determinism: the same seed replays a bit-identical tile map
 *
 * Then it builds real levels for 1..30 with the balance curve from ARCHITECTURE.md §6 and asserts
 * items land on floor tiles, never twice on the same tile, and that the fuel budget keeps its
 * difficulty promise (level 1 ≤ 55 % of the fuel for a direct run, level 10 ≈ 85 %, never > 88 %).
 *
 * Exit code is 1 on any failure. Results are written to `logs/validate-mazes.json`.
 * The run is bounded to ~60 s: if the deadline hits, the remaining matrix cells are skipped and
 * the report is marked `truncated` (still a pass — the gate is about failures, not coverage count).
 *
 * Flags: `--quick` (a small matrix, for a fast local loop), `--seeds=N` (override the seed budget).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMaze } from '../src/maze/generator.js';
import { validateMaze } from '../src/maze/validator.js';
import { buildLevel } from '../src/maze/level.js';
import { fuelBudget } from '../src/maze/populate.js';
import { TILE } from '../src/maze/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');
const SEED_OVERRIDE = Number((process.argv.find((a) => a.startsWith('--seeds=')) || '').slice(8));

/** Wall-clock budget for the whole matrix, milliseconds. */
const TIME_BUDGET_MS = QUICK ? 8000 : 60000;

/** The size matrix (cols × rows), from the degenerate extremes up to 512×512. */
const SIZES = QUICK
  ? [[1, 1], [2, 2], [6, 6], [17, 31], [64, 64]]
  : [[1, 1], [1, 2], [2, 1], [2, 2], [3, 7], [6, 6], [10, 10], [17, 31], [40, 40], [64, 64], [128, 128], [256, 256], [512, 512]];

/** Braid fractions: 0 must give a perfect maze, 1 must still be fully connected. */
const BRAIDS = [0, 0.1, 0.5, 1];

/** Levels built end-to-end through `buildLevel`. */
const LEVELS = 30;

/** Seeds per level in the buildLevel sweep. */
const LEVEL_SEEDS = QUICK ? 4 : 25;

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
 * @param {import('../core/types.js').Maze} maze
 * @param {number} braid
 * @param {string} where
 * @returns {void}
 */
function checkMaze(maze, braid, where) {
  const v = validateMaze(maze);
  if (v.errors.length > 0) fail(where, `validation errors: ${v.errors.join('; ')}`);
  if (!v.solvable) fail(where, 'not solvable');
  if (!v.fullyConnected) fail(where, 'not fully connected');
  if (!v.bordersSealed) fail(where, 'border not sealed');
  if (braid === 0 && v.loops !== 0) fail(where, `perfect maze reported ${v.loops} loops`);
  if (v.loops < 0) fail(where, `negative loop count ${v.loops}`);

  for (const [name, p] of /** @type {const} */ ([['start', maze.start], ['exit', maze.exit]])) {
    if (!(p.x & 1) || !(p.y & 1)) fail(where, `${name} (${p.x},${p.y}) is off the odd cell lattice`);
    if (p.x < 0 || p.y < 0 || p.x >= maze.width || p.y >= maze.height) fail(where, `${name} out of bounds`);
    else if (maze.tiles[p.y * maze.width + p.x] !== TILE.FLOOR) fail(where, `${name} is not on a floor tile`);
  }
  if (v.pathLength > 0 && v.pathLength > 2 * maze.cols * maze.rows - 1) {
    fail(where, `path of ${v.pathLength} tiles is longer than the maze has cells`);
  }
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

    outer: for (const braid of BRAIDS) {
      for (let s = 0; s < seeds; s++) {
        if (performance.now() > deadline) {
          truncated = true;
          break outer;
        }
        const seed = s * 2654435761 + cells;
        const where = `${key} braid=${braid} seed=${seed}`;
        let maze;
        try {
          maze = generateMaze({ cols, rows, seed, braid });
        } catch (err) {
          fail(where, `generateMaze threw ${String(err)}`);
          continue;
        }
        checkMaze(maze, braid, where);
        mazes++;
        entry.mazes++;

        // Determinism: re-roll the first seed of each combination, plus a periodic sample.
        if (s === 0 || s % 17 === 0) {
          const again = generateMaze({ cols, rows, seed, braid });
          if (hashTiles(maze.tiles) !== hashTiles(again.tiles)) fail(where, 'same seed produced different tiles');
          if (again.exit.x !== maze.exit.x || again.exit.y !== maze.exit.y) fail(where, 'same seed produced a different exit');
        }
      }
    }
    entry.ms = Math.round(performance.now() - t0);
    entry.failures = failures.length - failuresBefore;
  }
  return { mazes, truncated };
}

/**
 * Level parameters matching ARCHITECTURE.md §6 (level 1 = 6×6, +2 cells per level, capped at
 * 40×40). `src/state/balance.js` owns the real curve; this is the hand-matched twin used to prove
 * the maze module behaves across the whole campaign.
 * @param {number} level 1-based
 * @returns {import('../src/maze/level.js').LevelParams}
 */
function levelParams(level) {
  const side = Math.min(40, 6 + 2 * (level - 1));
  return {
    cols: side,
    rows: side,
    braid: Math.min(0.4, 0.06 * (level - 1)),
    gems: 3 + level,
    oil: 1 + Math.floor(level / 3),
    fuelSeconds: 0,
    par: 0,
  };
}

/**
 * Build every level 1..30 several times and assert the population and fuel guarantees.
 * @returns {{levels:Array<{level:number, size:string, path:number, fuel:number, usage:number, items:number, torches:number}>, built:number}}
 */
function runLevels() {
  const levels = [];
  let built = 0;

  for (let level = 1; level <= LEVELS; level++) {
    const params = levelParams(level);
    let pathSum = 0;
    let fuelSum = 0;
    let usageSum = 0;
    let worstUsage = 0;
    let items = 0;
    let torches = 0;

    for (let s = 0; s < LEVEL_SEEDS; s++) {
      const seed = level * 7919 + s * 104729;
      const where = `level ${level} seed ${seed}`;
      let data;
      try {
        data = buildLevel(params, seed);
      } catch (err) {
        fail(where, `buildLevel threw ${String(err)}`);
        continue;
      }
      built++;
      checkMaze(data.maze, params.braid ?? 0, where);

      // Items: on floor, inside the grid, on a tile centre, never duplicated.
      const used = new Set();
      for (const item of data.items) {
        const tx = item.x - 0.5;
        const ty = item.y - 0.5;
        if (!Number.isInteger(tx) || !Number.isInteger(ty)) fail(where, `item ${item.id} is not on a tile centre`);
        if (tx < 0 || ty < 0 || tx >= data.maze.width || ty >= data.maze.height) {
          fail(where, `item ${item.id} is outside the maze`);
          continue;
        }
        const idx = ty * data.maze.width + tx;
        if (data.maze.tiles[idx] !== TILE.FLOOR) fail(where, `item ${item.id} is inside a wall`);
        if (used.has(idx)) fail(where, `two items share tile ${idx}`);
        used.add(idx);
        if (item.taken) fail(where, `item ${item.id} starts taken`);
      }
      const gems = data.items.filter((i) => i.kind === 'gem').length;
      const oils = data.items.filter((i) => i.kind === 'oil').length;
      if (gems !== params.gems) fail(where, `expected ${params.gems} gems, got ${gems}`);
      if (oils !== params.oil) fail(where, `expected ${params.oil} oil flasks, got ${oils}`);

      // Torches: on wall tiles, facing a corridor.
      const dx = [1, 0, -1, 0];
      const dy = [0, 1, 0, -1];
      for (const t of data.torches) {
        if (data.maze.tiles[t.y * data.maze.width + t.x] !== TILE.WALL) fail(where, 'torch is not on a wall tile');
        else if (data.maze.tiles[(t.y + dy[t.face]) * data.maze.width + (t.x + dx[t.face])] !== TILE.FLOOR) {
          fail(where, 'torch faces solid rock');
        }
      }

      // Fuel budget: winnable without pickups, and tightening with depth.
      const budget = fuelBudget(data.validation.pathLength, params);
      if (Math.abs(budget.fuel - data.fuel) > 1e-9) fail(where, 'LevelData.fuel disagrees with fuelBudget');
      if (!(data.par > 0 && data.par <= data.fuel)) fail(where, `par ${data.par} does not fit inside fuel ${data.fuel}`);
      if (budget.usage > 0.881) fail(where, `a direct run needs ${(budget.usage * 100).toFixed(1)} % of the fuel`);
      if (level === 1 && budget.usage > 0.55) fail(where, `level 1 usage ${(budget.usage * 100).toFixed(1)} % exceeds 55 %`);

      pathSum += data.validation.pathLength;
      fuelSum += data.fuel;
      usageSum += budget.usage;
      worstUsage = Math.max(worstUsage, budget.usage);
      items = data.items.length;
      torches = data.torches.length;

      // Determinism of the whole level, not just the maze.
      if (s === 0) {
        const again = buildLevel(params, seed);
        if (hashTiles(again.maze.tiles) !== hashTiles(data.maze.tiles)) fail(where, 'level tiles are not deterministic');
        if (JSON.stringify(again.items) !== JSON.stringify(data.items)) fail(where, 'level items are not deterministic');
        if (JSON.stringify(again.torches) !== JSON.stringify(data.torches)) fail(where, 'level torches are not deterministic');
      }
    }

    const n = Math.max(1, LEVEL_SEEDS);
    levels.push({
      level,
      size: `${params.cols}x${params.rows}`,
      path: Math.round(pathSum / n),
      fuel: Math.round((fuelSum / n) * 10) / 10,
      usage: Math.round((usageSum / n) * 1000) / 1000,
      items,
      torches,
    });
  }

  // The campaign-level promise: level 10 should be tight but fair.
  const l10 = levels[9];
  if (l10 && !(l10.usage > 0.78 && l10.usage <= 0.881)) {
    fail('campaign', `level 10 average usage is ${(l10.usage * 100).toFixed(1)} %, expected ~85 %`);
  }
  const l1 = levels[0];
  if (l1 && !(l1.usage <= 0.55)) fail('campaign', `level 1 average usage is ${(l1.usage * 100).toFixed(1)} %`);

  return { levels, built };
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────

const started = performance.now();
const matrix = runMatrix(started + TIME_BUDGET_MS);
const campaign = runLevels();
const ms = Math.round(performance.now() - started);

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

console.log(`\n  levels (${LEVEL_SEEDS} seeds each, averages)\n`);
console.log(`  ${'lvl'.padEnd(5)}${'size'.padEnd(9)}${'path'.padStart(7)}${'fuel s'.padStart(9)}${'usage'.padStart(8)}${'items'.padStart(7)}${'torches'.padStart(9)}`);
console.log(`  ${'-'.repeat(54)}`);
for (const l of campaign.levels) {
  if (l.level > 12 && l.level % 6 !== 0 && l.level !== LEVELS) continue; // keep the table readable
  console.log(
    `  ${String(l.level).padEnd(5)}${l.size.padEnd(9)}${String(l.path).padStart(7)}${l.fuel.toFixed(1).padStart(9)}${`${(l.usage * 100).toFixed(1)}%`.padStart(8)}${String(l.items).padStart(7)}${String(l.torches).padStart(9)}`,
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
