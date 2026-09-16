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
 *      delta after a forced GC makes it obvious.
 *
 * Timing is *reported*, not asserted, except for a 60 s per-maze sanity ceiling: this runs on CI
 * machines of wildly different speed, and a flaky performance gate is worse than none.
 *
 * Results are written to `logs/stress.json`. Exit code is 1 on any failure.
 * Flags: `--quick` (stop at 1000×1000 and 200 small levels).
 */

import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { generateMaze } from '../src/maze/generator.js';
import { validateMaze } from '../src/maze/validator.js';
import { buildLevel } from '../src/maze/level.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');

/** Per-maze wall-clock ceiling, milliseconds. Generous on purpose — see the file header. */
const MAX_MS_PER_MAZE = 60000;

/** Number of small levels built in the leak loop. */
const LEAK_ITERATIONS = QUICK ? 200 : 2000;

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
  if (gc) gc();
}

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

if (gc) gc();
const before = process.memoryUsage();
const leakT0 = performance.now();
let checksum = 0;
for (let i = 0; i < LEAK_ITERATIONS; i++) {
  const data = buildLevel({ cols: 8, rows: 8, braid: 0.2, gems: 5, oil: 2 }, i);
  // Touch the result so nothing can be optimised away, without retaining it.
  checksum = (checksum + data.maze.tiles[data.maze.tiles.length >> 1] + data.items.length) | 0;
}
const leakMs = Math.round(performance.now() - leakT0);
if (gc) gc();
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
if (!gc) {
  console.log('  note: run with `node --expose-gc tools/stress.mjs` for a meaningful leak verdict.');
}

// ── Report ─────────────────────────────────────────────────────────────────────────────────────

const report = {
  ok: failures.length === 0,
  failures,
  cases,
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
