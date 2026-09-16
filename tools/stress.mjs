// @ts-check
/**
 * @file `node tools/stress.mjs` — extreme-grid stress test (ARCHITECTURE.md §4.4, §5).
 *
 * Three things are being proven here, none of which the unit tests can show:
 *
 *   1. **No recursion anywhere.** 1000×1000 and 2000×2000 cells (1 M and 4 M cells) would blow a
 *      recursive backtracker's call stack long before finishing. A `RangeError: Maximum call stack
 *      size exceeded` — or any throw at all — fails the run.
 *   2. **Bounded, predictable memory.** Peak RSS and the `ArrayBuffer` total are reported per case
 *      so a regression that starts allocating per cell shows up as a number, not as a crash on
 *      someone's 8 GB laptop.
 *   3. **No leak in the common path.** 2000 small levels are built back to back; if anything is
 *      retained per level (a closure over a tile buffer, a growing module-scoped cache), the heap
 *      delta after a forced GC makes it obvious. Since the massive-maze change the same loop runs
 *      at the *gameplay* maximum too, where one level is ~66 000 tiles and ~800 items: a run that
 *      lasts thirty levels must not grow.
 *   4. **The gameplay maximum is cheap enough to be a loading screen.** `MAX_CELLS` (128 per side)
 *      with full braid, fully populated, over 100 seeds: ms and heap per `buildLevel`, plus the
 *      measured cost of one `Item`. This is the number that decides whether the size cap is a
 *      balance decision or an engineering one — it is a balance decision.
 *
 * Timing is *reported*, not asserted, except for a 60 s per-maze sanity ceiling: this runs on CI
 * machines of wildly different speed, and a flaky performance gate is worse than none.
 *
 * Results are written to `logs/stress.json`. Exit code is 1 on any failure.
 * Flags: `--quick` (stop at 1000×1000, 200 small levels and 20 gameplay-max builds).
 */

import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { generateMaze } from '../src/maze/generator.js';
import { validateMaze } from '../src/maze/validator.js';
import { buildLevel } from '../src/maze/level.js';
import { levelParams, LEVEL } from '../src/state/balance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');

/** Per-maze wall-clock ceiling, milliseconds. Generous on purpose — see the file header. */
const MAX_MS_PER_MAZE = 60000;

/** Number of small levels built in the leak loop. */
const LEAK_ITERATIONS = QUICK ? 200 : 2000;

/** Seeds built at the gameplay maximum. */
const GAMEPLAY_SEEDS = QUICK ? 20 : 100;

/**
 * Levels built back to back at the gameplay maximum, to prove a long run does not grow. Thirty is
 * the campaign length `tools/validate-mazes.mjs` sweeps, i.e. "someone played all the way down".
 */
const GAMEPLAY_LEAK_ITERATIONS = QUICK ? 5 : 30;

/** Heap growth over the leak loop that counts as a leak, in MiB. */
const LEAK_LIMIT_MB = 24;

/** The big cases: [cols, rows, braid]. */
const CASES = QUICK
  ? [[500, 500, 0], [1000, 1000, 0.25]]
  : [
      [1000, 1000, 0],
      [1000, 1000, 0.25],
      [2000, 2000, 0],
      [2000, 2000, 0.25],
    ];

/** @type {string[]} */
const failures = [];

/**
 * Best-effort access to V8's garbage collector so the leak measurement is not pure noise.
 * @returns {(() => void)|null}
 */
function tryEnableGc() {
  if (typeof (/** @type {{gc?:() => void}} */ (globalThis).gc) === 'function') {
    return /** @type {{gc:() => void}} */ (globalThis).gc;
  }
  try {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    v8.setFlagsFromString('--no-expose-gc');
    return typeof gc === 'function' ? gc : null;
  } catch {
    return null;
  }
}

const gc = tryEnableGc();

/**
 * Run the collector until external memory has actually been released.
 *
 * One `gc()` is not enough to get a trustworthy `arrayBuffers` reading: a typed array's *wrapper*
 * dies in the first cycle but its backing store is freed by the next, so a loop that allocates a
 * megabyte per iteration reports its whole transient footprint as "retained" after a single pass.
 * Measured here: 30 × `buildLevel(128×128)` reads as +48.9 MB of `ArrayBuffer` after one `gc()`,
 * and 0.0 MB after three — nothing is leaking, the accounting is just one cycle behind. Every leak
 * measurement below therefore drains first, so a real regression is not hidden in that noise.
 *
 * @param {number} [passes=3]
 * @returns {void}
 */
function collect(passes = 3) {
  if (!gc) return;
  for (let i = 0; i < passes; i++) gc();
}

/**
 * Bytes → MiB, one decimal.
 * @param {number} bytes
 * @returns {number}
 */
function mb(bytes) {
  return Math.round((bytes / 1048576) * 10) / 10;
}

/**
 * Generate + validate one maze, timing each half and capturing memory afterwards.
 * @param {number} cols
 * @param {number} rows
 * @param {number} braid
 * @returns {{cols:number, rows:number, braid:number, cells:number, tiles:number, genMs:number,
 *   validateMs:number, totalMs:number, rssMb:number, heapMb:number, buffersMb:number,
 *   pathLength:number, floorCount:number, deadEnds:number, loops:number, ok:boolean, error:string|null}}
 */
function runCase(cols, rows, braid) {
  const label = `${cols}×${rows} braid=${braid}`;
  const result = {
    cols,
    rows,
    braid,
    cells: cols * rows,
    tiles: (cols * 2 + 1) * (rows * 2 + 1),
    genMs: 0,
    validateMs: 0,
    totalMs: 0,
    rssMb: 0,
    heapMb: 0,
    buffersMb: 0,
    pathLength: -1,
    floorCount: 0,
    deadEnds: 0,
    loops: 0,
    ok: false,
    error: /** @type {string|null} */ (null),
  };

  try {
    const t0 = performance.now();
    const maze = generateMaze({ cols, rows, seed: cols * 31 + rows, braid });
    const t1 = performance.now();
    const v = validateMaze(maze);
    const t2 = performance.now();

    result.genMs = Math.round(t1 - t0);
    result.validateMs = Math.round(t2 - t1);
    result.totalMs = Math.round(t2 - t0);
    const mem = process.memoryUsage();
    result.rssMb = mb(mem.rss);
    result.heapMb = mb(mem.heapUsed);
    result.buffersMb = mb(mem.arrayBuffers);
    result.pathLength = v.pathLength;
    result.floorCount = v.floorCount;
    result.deadEnds = v.deadEnds;
    result.loops = v.loops;

    if (v.errors.length > 0) failures.push(`${label}: ${v.errors.join('; ')}`);
    if (braid === 0 && v.loops !== 0) failures.push(`${label}: perfect maze reported ${v.loops} loops`);
    if (result.totalMs > MAX_MS_PER_MAZE) {
      failures.push(`${label}: took ${result.totalMs} ms, over the ${MAX_MS_PER_MAZE} ms ceiling`);
    }
    result.ok = v.errors.length === 0;
  } catch (err) {
    // A RangeError here is the stack-overflow signature the iterative rewrite exists to prevent.
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    failures.push(`${label}: threw ${result.error}`);
  }
  return result;
}

console.log(`\nA-MAZE generation stress${QUICK ? ' (quick)' : ''}  —  node ${process.version}, gc ${gc ? 'available' : 'unavailable'}\n`);
console.log(`  ${'case'.padEnd(20)}${'cells'.padStart(10)}${'tiles'.padStart(12)}${'gen ms'.padStart(9)}${'val ms'.padStart(8)}${'rss MB'.padStart(9)}${'bufs MB'.padStart(9)}`);
console.log(`  ${'-'.repeat(77)}`);

const cases = [];
for (const [cols, rows, braid] of CASES) {
  const r = runCase(cols, rows, braid);
  cases.push(r);
  console.log(
    `  ${`${cols}×${rows} b=${braid}`.padEnd(20)}${String(r.cells).padStart(10)}${String(r.tiles).padStart(12)}` +
      `${String(r.genMs).padStart(9)}${String(r.validateMs).padStart(8)}${String(r.rssMb).padStart(9)}${String(r.buffersMb).padStart(9)}` +
      `${r.error ? `   ${r.error}` : ''}`,
  );
  // Let the previous case's buffers go before the next one allocates its own.
  collect();
}

// ── The gameplay maximum ───────────────────────────────────────────────────────────────────────
// The extreme cases above prove the engine does not fall over. This one proves the *shipped* size
// cap is comfortable: a fully populated `MAX_CELLS` level, with full braid (the worst case for
// population — braiding destroys the dead ends the gem pass prefers, so every fallback runs).

/**
 * Parameters for the deepest shipped level, forced to full braid.
 *
 * `LEVEL.MAX_CELLS` is the single documented size knob (`src/state/balance.js`); the `max(128, …)`
 * keeps this case measuring at least the documented 128×128 ceiling even if the knob is lowered,
 * so the report never quietly stops covering it.
 * @returns {import('../src/maze/level.js').LevelParams & {cells:number}}
 */
function gameplayMaxParams() {
  const deep = levelParams(200); // far past the cap: the deepest parameters the curve produces
  const side = Math.max(128, LEVEL.MAX_CELLS, deep.cols);
  return { ...deep, cols: side, rows: side, braid: 1, cells: side * side };
}

/**
 * Build `seeds` levels at the gameplay maximum and report time, memory and item cost.
 *
 * The `items` arrays (and only those) are retained across the loop so the heap delta afterwards is
 * an honest measurement of what a `LevelData`'s item list costs — the tile buffer is deliberately
 * let go, because it is a `Uint8Array` whose size is arithmetic, not a question.
 *
 * @param {number} seeds
 * @returns {{side:number, cells:number, tiles:number, seeds:number, msAvg:number, msP95:number,
 *   msMax:number, items:number, gems:number, oils:number, torches:number, path:number,
 *   itemBytes:number, heapPerLevelKb:number, buffersMb:number}}
 */
function runGameplayMax(seeds) {
  const params = gameplayMaxParams();
  const times = new Float64Array(seeds);
  /** @type {import('../src/core/types.js').Item[][]} */
  const kept = [];
  let items = 0;
  let gems = 0;
  let oils = 0;
  let torches = 0;
  let path = 0;
  let tiles = 0;

  collect();
  const before = process.memoryUsage();
  for (let s = 0; s < seeds; s++) {
    const t0 = performance.now();
    const data = buildLevel(params, s * 2654435761 + 17);
    times[s] = performance.now() - t0;
    kept.push(data.items);
    items += data.items.length;
    for (const it of data.items) {
      if (it.kind === 'gem') gems++;
      else if (it.kind === 'oil') oils++; // the one 'map' scroll per level (§4.8) is neither
    }
    torches += data.torches.length;
    path += data.validation.pathLength;
    tiles = data.maze.width * data.maze.height;
    if (data.validation.errors.length > 0) {
      failures.push(`gameplay max seed ${s}: ${data.validation.errors.join('; ')}`);
    }
  }
  collect();
  const after = process.memoryUsage();
  const heapDelta = after.heapUsed - before.heapUsed;

  const sorted = Array.from(times).sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const result = {
    side: params.cols,
    cells: params.cells,
    tiles,
    seeds,
    msAvg: Math.round((sum / seeds) * 100) / 100,
    msP95: Math.round(sorted[Math.min(seeds - 1, Math.floor(seeds * 0.95))] * 100) / 100,
    msMax: Math.round(sorted[seeds - 1] * 100) / 100,
    items: Math.round(items / seeds),
    gems: Math.round(gems / seeds),
    oils: Math.round(oils / seeds),
    torches: Math.round(torches / seeds),
    path: Math.round(path / seeds),
    itemBytes: items > 0 ? Math.round(heapDelta / items) : 0,
    heapPerLevelKb: Math.round(heapDelta / seeds / 1024),
    buffersMb: mb(after.arrayBuffers - before.arrayBuffers),
  };
  kept.length = 0; // release before the leak loop measures anything
  return result;
}

const gameplay = runGameplayMax(GAMEPLAY_SEEDS);
console.log(
  `\n  gameplay maximum: ${gameplay.side}×${gameplay.side} cells (${gameplay.cells} cells, ${gameplay.tiles} tiles), braid 1, ` +
    `${gameplay.seeds} seeds\n` +
    `    buildLevel ${gameplay.msAvg} ms avg, ${gameplay.msP95} ms p95, ${gameplay.msMax} ms max\n` +
    `    per level: ${gameplay.items} items (${gameplay.gems} gems + ${gameplay.oils} oil), ` +
    `${gameplay.torches} torches, ${gameplay.path}-tile route\n` +
    `    item cost: ~${gameplay.itemBytes} B each, ~${gameplay.heapPerLevelKb} KB of items retained per level`,
);

// ── Guard rails ────────────────────────────────────────────────────────────────────────────────
// The deepest carve possible at the documented size limit: a 1×4096 corridor forces a 4096-deep
// backtracker stack, which is exactly the shape a recursive implementation dies on. And one cell
// past the limit must be refused rather than attempted.

const guards = { deepCorridorMs: 0, deepCorridorOk: false, oversizeRejected: false };
try {
  const t0 = performance.now();
  const corridor = generateMaze({ cols: 1, rows: 4096, seed: 1 });
  const cv = validateMaze(corridor);
  guards.deepCorridorMs = Math.round(performance.now() - t0);
  guards.deepCorridorOk = cv.errors.length === 0 && cv.pathLength === 4096 * 2 - 1;
  if (!guards.deepCorridorOk) failures.push(`1×4096 corridor: ${cv.errors.join('; ') || `path ${cv.pathLength}`}`);
} catch (err) {
  failures.push(`1×4096 corridor threw ${String(err)}`);
}
try {
  generateMaze({ cols: 4097, rows: 4, seed: 1 });
  failures.push('a 4097-column maze was accepted; the size guard is not working');
} catch (err) {
  guards.oversizeRejected = err instanceof RangeError;
  if (!guards.oversizeRejected) failures.push(`oversize maze threw ${String(err)} instead of RangeError`);
}
console.log(
  `\n  guards: 1×4096 corridor ${guards.deepCorridorOk ? 'ok' : 'FAILED'} in ${guards.deepCorridorMs} ms, ` +
    `oversize ${guards.oversizeRejected ? 'refused with RangeError' : 'NOT refused'}`,
);

// ── Leak loop ──────────────────────────────────────────────────────────────────────────────────

collect();
const before = process.memoryUsage();
const leakT0 = performance.now();
let checksum = 0;
for (let i = 0; i < LEAK_ITERATIONS; i++) {
  const data = buildLevel({ cols: 8, rows: 8, braid: 0.2, gems: 5, oil: 2 }, i);
  // Touch the result so nothing can be optimised away, without retaining it.
  checksum = (checksum + data.maze.tiles[data.maze.tiles.length >> 1] + data.items.length) | 0;
}
const leakMs = Math.round(performance.now() - leakT0);
collect();
const after = process.memoryUsage();
const heapDeltaMb = mb(after.heapUsed - before.heapUsed);
const bufferDeltaMb = mb(after.arrayBuffers - before.arrayBuffers);

console.log(
  `\n  leak loop: ${LEAK_ITERATIONS} × buildLevel(8×8) in ${leakMs} ms ` +
    `(${(leakMs / LEAK_ITERATIONS).toFixed(2)} ms each), heap ${heapDeltaMb >= 0 ? '+' : ''}${heapDeltaMb} MB, ` +
    `buffers ${bufferDeltaMb >= 0 ? '+' : ''}${bufferDeltaMb} MB, checksum ${checksum}`,
);

if (gc && heapDeltaMb > LEAK_LIMIT_MB) {
  failures.push(`leak loop retained ${heapDeltaMb} MB of heap (limit ${LEAK_LIMIT_MB} MB)`);
}
if (gc && bufferDeltaMb > LEAK_LIMIT_MB) {
  failures.push(`leak loop retained ${bufferDeltaMb} MB of ArrayBuffers (limit ${LEAK_LIMIT_MB} MB)`);
}

// The same question at the size that actually matters now: a whole campaign of 128×128 levels,
// built and dropped. A per-level retention of even 1 MB here would be 30 MB by the end of a run.
collect();
const deepBefore = process.memoryUsage();
const deepT0 = performance.now();
const deepParams = gameplayMaxParams();
let deepChecksum = 0;
for (let i = 0; i < GAMEPLAY_LEAK_ITERATIONS; i++) {
  const data = buildLevel(deepParams, 900000 + i);
  deepChecksum = (deepChecksum + data.items.length + data.maze.tiles[data.maze.tiles.length >> 1]) | 0;
}
const deepLeakMs = Math.round(performance.now() - deepT0);
collect();
const deepAfter = process.memoryUsage();
const deepHeapDeltaMb = mb(deepAfter.heapUsed - deepBefore.heapUsed);
const deepBufferDeltaMb = mb(deepAfter.arrayBuffers - deepBefore.arrayBuffers);
console.log(
  `  campaign loop: ${GAMEPLAY_LEAK_ITERATIONS} × buildLevel(${deepParams.cols}×${deepParams.rows}) in ${deepLeakMs} ms ` +
    `(${(deepLeakMs / GAMEPLAY_LEAK_ITERATIONS).toFixed(1)} ms each), heap ${deepHeapDeltaMb >= 0 ? '+' : ''}${deepHeapDeltaMb} MB, ` +
    `buffers ${deepBufferDeltaMb >= 0 ? '+' : ''}${deepBufferDeltaMb} MB, checksum ${deepChecksum}`,
);
if (gc && deepHeapDeltaMb > LEAK_LIMIT_MB) {
  failures.push(`campaign loop retained ${deepHeapDeltaMb} MB of heap (limit ${LEAK_LIMIT_MB} MB)`);
}
if (gc && deepBufferDeltaMb > LEAK_LIMIT_MB) {
  failures.push(`campaign loop retained ${deepBufferDeltaMb} MB of ArrayBuffers (limit ${LEAK_LIMIT_MB} MB)`);
}
if (!gc) {
  console.log('  note: run with `node --expose-gc tools/stress.mjs` for a meaningful leak verdict.');
}

// ── Report ─────────────────────────────────────────────────────────────────────────────────────

const report = {
  ok: failures.length === 0,
  failures,
  cases,
  gameplayMax: gameplay,
  guards,
  leak: {
    iterations: LEAK_ITERATIONS,
    ms: leakMs,
    msPerLevel: Math.round((leakMs / LEAK_ITERATIONS) * 1000) / 1000,
    heapDeltaMb,
    bufferDeltaMb,
    gcAvailable: Boolean(gc),
    limitMb: LEAK_LIMIT_MB,
  },
  campaignLeak: {
    iterations: GAMEPLAY_LEAK_ITERATIONS,
    size: `${deepParams.cols}x${deepParams.rows}`,
    ms: deepLeakMs,
    msPerLevel: Math.round((deepLeakMs / GAMEPLAY_LEAK_ITERATIONS) * 1000) / 1000,
    heapDeltaMb: deepHeapDeltaMb,
    bufferDeltaMb: deepBufferDeltaMb,
  },
  peakRssMb: mb(process.memoryUsage().rss),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  at: new Date().toISOString(),
};
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'logs', 'stress.json'), `${JSON.stringify(report, null, 2)}\n`);

if (failures.length > 0) {
  console.log(`\n  ${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`    ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`\n  OK — no throws, no stack overflow, ${cases.length} extreme mazes → logs/stress.json\n`);
