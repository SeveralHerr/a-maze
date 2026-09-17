// @ts-check
/**
 * @file Transient-garbage probe for `perf.test.mjs` — run in a **fresh child process**, never
 * imported by the game (the name deliberately does not end in `.test.mjs`, so `npm test` does not
 * run it on its own).
 *
 * ## Why a child process, twice
 * Whether a step allocates used to depend on what the JIT had already seen. In a fresh process the
 * reducer inlined its float helpers and allocated ~0 B/tick; after the same process had dispatched
 * other input shapes it did not, and turning in place allocated 5.5–8.8 B/tick. A gate measured in
 * the test process's own, arbitrary JIT state flaked 1 run in 3. The parent runs this probe once
 * with default flags and once with `--no-turbo-inlining` — the worst case, where no helper is
 * inlined and any double crossing a call boundary is boxed — and both must pass. The probe also
 * pollutes the type feedback on purpose first (an `{}` input frame, a `null` one, varied `dt`,
 * pause/resume, Auto Explore ticks, a wandering walk), so what is measured is the code a long
 * browser session runs, not the monomorphic best case.
 *
 * ## Why scavenges, not `heapUsed`
 * `heapUsed` and the new-space statistics move in allocation-buffer and page steps (0.15–1.2 MB on
 * Node 24), so a 300 000-tick chunk read anywhere between 0.5 and 4 B/tick for the *same* code
 * depending on where the chunk boundaries fell — a second source of flakes. V8's sampling heap
 * profiler is worse: measured against a loop allocating a known 2.4 B/iteration it reported 0.018.
 * What is exact is the **number of scavenges**: with `--max-semi-space-size=1` the young generation
 * fills every ~0.5 MB, so counting minor GCs over two million ticks measures the garbage to within
 * half a megabyte — a loop allocating 2.4 B/iteration produced 9, one allocating 0.24 B produced 1,
 * and one allocating 0.02 B produced none. The parent passes that flag; without it the probe still
 * runs, with a coarser young generation.
 *
 * Output: one JSON line, `{sim, dispatch, ticks, youngBytes}`, where `sim` and `dispatch` each carry
 * `{turning:{gcs,perTick,steps}, walking:{…}}` — the simulation step on its own, and the whole
 * `tick` dispatch, which also pays for the doubles it reads out of the action and the input frame.
 * Usage: `node --max-semi-space-size=1 [--no-turbo-inlining] src/state/perf.alloc-probe.mjs [ticks]`.
 * `AMAZE_NO_POLLUTE=1` skips the warm-up above, for comparing a clean process against a used one.
 */

import { PerformanceObserver, constants } from 'node:perf_hooks';

import { buildLevel } from '../maze/level.js';
import { levelParams } from './balance.js';
import { createInitialState, reducer } from './game.js';
import { stepPlaying } from './sim.js';

const TICKS = Number(process.argv[2]) > 0 ? Math.floor(Number(process.argv[2])) : 2_000_000;

/**
 * Bytes of young generation a scavenge stands for. Measured on Node 24 with
 * `--max-semi-space-size=1`: a loop allocating a known 2.4 B/iteration over 2 000 000 iterations
 * (4.8 MB) triggered 9 scavenges. Only used to turn the count into a comparable rate; the gate in
 * `perf.test.mjs` is on the count.
 */
const BYTES_PER_SCAVENGE = 524_288;

let minor = 0;
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    const detail = /** @type {any} */ (e).detail;
    if (detail && detail.kind === constants.NODE_PERFORMANCE_GC_MINOR) minor++;
  }
});
obs.observe({ entryTypes: ['gc'] });

const data = buildLevel(levelParams(15), 20_240_607);
// The exit moves onto a sealed corner so the level cannot end mid-measurement (see perf.test.mjs).
data.maze.exit = { x: 0, y: 0 };
const state = createInitialState();
reducer(state, { type: 'newGame', seed: 20_240_607 });
state.level = 15;
reducer(state, { type: 'levelReady', data });

// ── Pollute: the shapes a real session feeds the reducer ──
const wander = { moveX: 0, moveY: 1, turn: 0, lookDX: 0 };
const dts = [1 / 60, 1 / 144, 0.1, 1 / 30];
const POLLUTE = process.env.AMAZE_NO_POLLUTE === '1' ? 0 : 60_000;
for (let i = 0; i < POLLUTE; i++) {
  state.run.fuel = state.run.fuelMax;
  wander.turn = Math.sin(i / 50);
  wander.moveX = i % 700 < 60 ? -1 : 0;
  wander.lookDX = i % 9 === 0 ? 0.3 : 0;
  reducer(state, { type: 'tick', dt: dts[i & 3], input: i % 97 === 0 ? {} : wander, auto: i % 5000 < 500 });
  if (i % 5000 === 0) {
    reducer(state, { type: 'pause' });
    reducer(state, { type: 'tick', dt: 1 / 60, input: null });
    reducer(state, { type: 'resume' });
  }
}

const input = { moveX: 0, moveY: 0, turn: 1, lookDX: 0.02 };
const tick = { type: 'tick', dt: 1 / 60, input };

/**
 * Run `n` steps, either straight into the simulation or through the reducer's `tick` action.
 * @param {number} n
 * @param {boolean} viaReducer
 * @returns {void}
 */
function drive(n, viaReducer) {
  for (let i = 0; i < n; i++) {
    state.run.fuel = state.run.fuelMax;
    if (viaReducer) reducer(state, tick);
    else stepPlaying(state, 1 / 60, input);
  }
}

/**
 * Drive `TICKS` steps and count the scavenges they cost.
 * @param {number} moveY 0 = turning in place, 1 = walking
 * @param {boolean} viaReducer measure the whole dispatch, or only the simulation step
 * @returns {Promise<{gcs:number, perTick:number, steps:number}>}
 */
async function measure(moveY, viaReducer) {
  input.moveY = moveY;
  drive(100_000, viaReducer);
  // The observer is asynchronous: let the warm-up's entries land before the window opens.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const before = minor;
  drive(TICKS, viaReducer);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const gcs = minor - before;
  return { gcs, perTick: (gcs * BYTES_PER_SCAVENGE) / TICKS, steps: TICKS };
}

const sim = { turning: await measure(0, false), walking: await measure(1, false) };
const dispatch = { turning: await measure(0, true), walking: await measure(1, true) };
obs.disconnect();
process.stdout.write(`${JSON.stringify({ sim, dispatch, ticks: TICKS, youngBytes: BYTES_PER_SCAVENGE })}\n`);
