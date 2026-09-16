// @ts-check
/**
 * Unit tests for src/core/loop.js — run with `node src/core/loop.test.mjs`.
 *
 * The loop is driven by an injected fake clock, fake scheduler and fake document, so the
 * accumulator maths is tested exactly (no sleeping, no flakiness). Two separate fake clocks are
 * used on purpose: `frameT` feeds the scheduler timestamps (the animation frame times) while
 * `workT` feeds `now()` (the wall time consumed inside step/render), which is how the real browser
 * behaves and lets the statistics be asserted precisely.
 *
 * The fake loop runs at 64 Hz rather than 60 so that the step period (15.625 ms) and the step dt
 * (1/64) are exact in binary floating point. With vsync snapping switched off, a 1000/60 ms frame
 * delta lands a fraction of an ulp below 1/60 s and whether it triggers a step is a coin toss —
 * which is precisely the jitter the default snapping exists to absorb (see the snapping test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createLoop } from './loop.js';
import { clearErrors, errors } from './log.js';

/**
 * @typedef {Object} Harness
 * @property {import('./loop.js').Loop} loop
 * @property {(ms:number) => void} frame        advance the frame clock and run the pending frame
 * @property {() => boolean} pending            is a frame scheduled?
 * @property {number[]} stepDts                 dt of every step() call
 * @property {Array<[number, number]>} renders  [alpha, frameDt] of every render() call
 * @property {{hidden:boolean, fire:() => void, listenerCount:number}} doc
 * @property {(stepMs:number, renderMs:number) => void} setWorkCost
 * @property {number} cafCount
 */

/**
 * Build a loop wired to fakes.
 * @param {Partial<import('./loop.js').LoopOptions>} [options]
 * @returns {Harness}
 */
function harness(options = {}) {
  let frameT = 1000; // scheduler timestamps (ms)
  let workT = 0; // monotonic clock used for step/render measurements (ms)
  let stepCost = 0;
  let renderCost = 0;
  /** @type {((ts:number) => void)|null} */
  let scheduled = null;
  let nextId = 1;
  let cafCount = 0;

  /** @type {number[]} */
  const stepDts = [];
  /** @type {Array<[number, number]>} */
  const renders = [];
  /** @type {Array<Function>} */
  const visibilityListeners = [];

  const doc = {
    hidden: false,
    /** @param {string} type @param {Function} fn */
    addEventListener(type, fn) {
      if (type === 'visibilitychange') visibilityListeners.push(fn);
    },
    /** @param {string} type @param {Function} fn */
    removeEventListener(type, fn) {
      const i = visibilityListeners.indexOf(fn);
      if (i >= 0) visibilityListeners.splice(i, 1);
    },
    fire() {
      for (const fn of visibilityListeners.slice()) fn();
    },
    get listenerCount() {
      return visibilityListeners.length;
    },
  };

  const loop = createLoop({
    step: (dt) => {
      stepDts.push(dt);
      workT += stepCost;
    },
    render: (alpha, frameDt) => {
      renders.push([alpha, frameDt]);
      workT += renderCost;
    },
    hz: 64, // exact binary step period; see the file header
    vsyncSnapMs: 0, // snapping off unless a test asks for it, so the maths is exact
    now: () => workT,
    raf: (cb) => {
      scheduled = cb;
      return nextId++;
    },
    caf: () => {
      cafCount++;
      scheduled = null;
    },
    doc,
    ...options,
  });

  return {
    loop,
    frame(ms) {
      frameT += ms;
      const cb = scheduled;
      scheduled = null;
      if (cb) cb(frameT);
    },
    pending: () => scheduled !== null,
    stepDts,
    renders,
    doc: /** @type {any} */ (doc),
    setWorkCost(stepMs, renderMs) {
      stepCost = stepMs;
      renderCost = renderMs;
    },
    get cafCount() {
      return cafCount;
    },
  };
}

const STEP_MS = 1000 / 64; // 15.625 ms, exactly representable
const STEP_DT = 1 / 64;

test('nothing runs before start(); start/stop are idempotent', () => {
  const h = harness();
  assert.equal(h.loop.running, false);
  assert.equal(h.pending(), false);
  h.loop.stop(); // no-op, must not throw
  h.loop.start();
  h.loop.start();
  assert.equal(h.loop.running, true);
  assert.equal(h.pending(), true);
  assert.equal(h.doc.listenerCount, 1, 'exactly one visibilitychange listener');
  h.loop.stop();
  h.loop.stop();
  assert.equal(h.loop.running, false);
  assert.equal(h.pending(), false);
  assert.equal(h.doc.listenerCount, 0, 'listener must be detached on stop');
  assert.equal(h.stepDts.length, 0);
});

test('the first frame primes the clock: renders, never simulates the start-up gap', () => {
  const h = harness();
  h.loop.start();
  h.frame(5000); // a long pause between start() and the first animation frame
  assert.equal(h.stepDts.length, 0, 'the gap before the first frame is not game time');
  assert.deepEqual(h.renders, [[0, 0]]);
  assert.equal(h.pending(), true, 'the next frame is scheduled up front');
});

test('frames at exactly the step period produce exactly one step each with a fixed dt', () => {
  const h = harness();
  h.loop.start();
  h.frame(0); // prime
  for (let i = 0; i < 10; i++) h.frame(STEP_MS);
  assert.equal(h.stepDts.length, 10);
  for (const dt of h.stepDts) assert.equal(dt, STEP_DT);
  assert.equal(h.renders.length, 11, 'one render per frame, including the priming frame');
  for (const [alpha] of h.renders) assert.ok(alpha >= 0 && alpha < 1, `alpha out of range: ${alpha}`);
});

test('the accumulator carries the remainder and reports it as alpha', () => {
  const h = harness();
  h.loop.start();
  h.frame(0);

  h.frame(STEP_MS * 2.5); // 2 steps, half a step left over
  assert.equal(h.stepDts.length, 2);
  const [alpha, frameDt] = h.renders[h.renders.length - 1];
  assert.ok(Math.abs(alpha - 0.5) < 1e-9, `alpha ${alpha}`);
  assert.ok(Math.abs(frameDt - (STEP_MS * 2.5) / 1000) < 1e-12, `frameDt ${frameDt}`);

  h.frame(STEP_MS * 0.25); // 0.75 of a step accumulated: no step this frame
  assert.equal(h.stepDts.length, 2, 'a short frame must not force a step');
  assert.ok(Math.abs(h.renders[h.renders.length - 1][0] - 0.75) < 1e-9);

  h.frame(STEP_MS * 0.5); // now 1.25 steps are owed
  assert.equal(h.stepDts.length, 3);
  assert.ok(Math.abs(h.renders[h.renders.length - 1][0] - 0.25) < 1e-9);
});

test('slow frames are clamped to maxCatchUp steps and the overflow is discarded', () => {
  const h = harness({ maxCatchUp: 5 });
  h.loop.start();
  h.frame(0);

  h.frame(1000); // a one-second stall (tab switch, GC, breakpoint)
  assert.equal(h.stepDts.length, 5, 'never more than maxCatchUp steps in one frame');
  const stats = h.loop.stats();
  // 1000 ms owed 64 steps; 5 ran, so the remaining 59 were dropped rather than queued.
  assert.equal(stats.skippedSteps, 59);

  // The very next normal frame must be back to a single step — no death spiral.
  h.frame(STEP_MS);
  assert.equal(h.stepDts.length, 6);
});

test('a non-monotonic or duplicated timestamp cannot rewind the accumulator', () => {
  const h = harness();
  h.loop.start();
  h.frame(0);
  h.frame(STEP_MS);
  assert.equal(h.stepDts.length, 1);
  h.frame(0); // same timestamp again (browsers do this for two callbacks in one frame)
  h.frame(-50); // clock went backwards
  assert.equal(h.stepDts.length, 1, 'no steps and no negative accumulation');
  h.frame(STEP_MS * 2);
  assert.equal(h.stepDts.length, 3, 'and the loop keeps working afterwards');
});

test('vsync snapping absorbs rAF jitter around the step period', () => {
  // 16.9 ms frames: 0.23 ms above a step. Without snapping the surplus accumulates and every
  // ~72nd frame runs two steps, which is visible as a stutter.
  const jitter = STEP_MS + 0.23;
  const off = harness({ vsyncSnapMs: 0 });
  off.loop.start();
  off.frame(0);
  let doubles = 0;
  for (let i = 0; i < 200; i++) {
    const before = off.stepDts.length;
    off.frame(jitter);
    if (off.stepDts.length - before === 2) doubles++;
  }
  assert.ok(doubles > 0, 'sanity: unsnapped jitter does produce double-step frames');

  const on = harness({ vsyncSnapMs: 0.4 });
  on.loop.start();
  on.frame(0);
  for (let i = 0; i < 200; i++) {
    const before = on.stepDts.length;
    on.frame(jitter);
    assert.equal(on.stepDts.length - before, 1, `frame ${i} ran more than one step`);
  }
  // Snapping must not fire on genuinely different refresh rates (double-rate display).
  const fast = harness({ vsyncSnapMs: 0.4 });
  fast.loop.start();
  fast.frame(0);
  for (let i = 0; i < 20; i++) fast.frame(STEP_MS / 2);
  assert.equal(fast.stepDts.length, 10, 'a double-rate display still averages one step per two frames');
});

test('document.hidden pauses the loop and resuming does not replay the hidden time', () => {
  const h = harness();
  h.loop.start();
  h.frame(0);
  h.frame(STEP_MS);
  assert.equal(h.stepDts.length, 1);

  h.doc.hidden = true;
  h.doc.fire();
  assert.equal(h.loop.suspended, true);
  assert.equal(h.loop.running, true, 'suspension is not a stop');
  assert.equal(h.pending(), false, 'no frame is scheduled while hidden');

  h.frame(60000); // a minute in a background tab
  assert.equal(h.stepDts.length, 1, 'hidden time is not game time');

  h.doc.hidden = false;
  h.doc.fire();
  assert.equal(h.loop.suspended, false);
  assert.equal(h.pending(), true);
  h.frame(10); // the first frame back only re-primes the clock
  assert.equal(h.stepDts.length, 1);
  h.frame(STEP_MS);
  assert.equal(h.stepDts.length, 2, 'and then resumes at one step per frame');
});

test('a hidden document detected inside a frame also suspends (unreliable visibility events)', () => {
  const h = harness();
  h.loop.start();
  h.frame(0);
  h.doc.hidden = true;
  h.frame(STEP_MS);
  assert.equal(h.stepDts.length, 0);
  assert.equal(h.loop.suspended, true);
  assert.equal(h.pending(), false);
});

test('starting while already hidden waits for visibility instead of burning frames', () => {
  const h = harness();
  h.doc.hidden = true;
  h.loop.start();
  assert.equal(h.loop.running, true);
  assert.equal(h.loop.suspended, true);
  assert.equal(h.pending(), false);
  h.doc.hidden = false;
  h.doc.fire();
  assert.equal(h.pending(), true);
});

test('doc: null disables visibility handling entirely (workers, headless tools)', () => {
  const h = harness({ doc: null });
  h.loop.start();
  h.frame(0);
  h.frame(STEP_MS);
  assert.equal(h.stepDts.length, 1);
  h.loop.stop();
});

test('stop() during a step cancels the already-scheduled frame', () => {
  /** @type {import('./loop.js').Loop} */
  let loop;
  const h = harness({
    step: () => {
      loop.stop();
    },
  });
  loop = h.loop;
  loop.start();
  h.frame(0);
  h.frame(STEP_MS);
  assert.equal(h.pending(), false, 'the pre-scheduled frame must be cancelled');
  assert.equal(loop.running, false);
});

test('stats() reports fps, averages, p99 and dropped frames over a 120-frame window', () => {
  const h = harness();
  h.setWorkCost(2, 3); // every step costs 2 ms, every render 3 ms
  h.loop.start();
  h.frame(0);

  // 118 frames at 20 ms + 2 spikes of 100 ms = 120 recorded frames.
  for (let i = 0; i < 118; i++) h.frame(20);
  h.frame(100);
  h.frame(100);

  const s = h.loop.stats();
  assert.equal(s.samples, 120, 'the window holds at most 120 frames');
  const expectedAvg = (118 * 20 + 2 * 100) / 120;
  assert.ok(Math.abs(s.frameMsAvg - expectedAvg) < 1e-9, `frameMsAvg ${s.frameMsAvg}`);
  assert.ok(Math.abs(s.fps - 1000 / expectedAvg) < 1e-9, `fps ${s.fps}`);
  assert.equal(s.frameMsP99, 100, 'p99 must surface the spikes, not the median');
  assert.equal(s.stepMsAvg, 2, 'mean wall time of a single step() call');
  assert.equal(s.renderMsAvg, 3);
  // 20 ms ≈ 1 step period → 0 dropped; 100 ms ≈ 6 step periods → 5 dropped, twice.
  assert.equal(s.droppedFrames, 10);

  // The result object is reused (zero allocation per frame for the debug HUD).
  assert.equal(h.loop.stats(), s);

  // The window is rolling: 120 calm frames evict the spikes.
  for (let i = 0; i < 120; i++) h.frame(16);
  const s2 = h.loop.stats();
  assert.ok(Math.abs(s2.frameMsAvg - 16) < 1e-9, `frameMsAvg after eviction ${s2.frameMsAvg}`);
  assert.equal(s2.frameMsP99, 16);

  h.loop.resetStats();
  const s3 = h.loop.stats();
  assert.equal(s3.samples, 0);
  assert.equal(s3.fps, 0);
  assert.equal(s3.frameMsAvg, 0);
  assert.equal(s3.frameMsP99, 0);
  assert.equal(s3.skippedSteps, 0);
});

test('stats() on a fresh loop is all zeros rather than NaN', () => {
  const h = harness();
  const s = h.loop.stats();
  assert.deepEqual(
    { ...s },
    { fps: 0, frameMsAvg: 0, frameMsP99: 0, stepMsAvg: 0, renderMsAvg: 0, droppedFrames: 0, samples: 0, skippedSteps: 0 },
  );
});

test('stepOnce(n) advances the sim headlessly and renders the final state', () => {
  const h = harness();
  assert.equal(h.loop.running, false);
  assert.equal(h.loop.stepOnce(), 1, 'defaults to a single step');
  assert.equal(h.stepDts.length, 1);
  assert.equal(h.stepDts[0], STEP_DT);
  assert.deepEqual(h.renders[0], [1, STEP_DT], 'alpha = 1 shows the state just computed');

  assert.equal(h.loop.stepOnce(60), 60);
  assert.equal(h.stepDts.length, 61);
  // frameDt is clamped the same way a real slow frame is, so time-based effects cannot jump.
  assert.equal(h.renders[1][1], 5 * STEP_DT, 'frameDt is capped at maxCatchUp steps');

  // Degenerate arguments do nothing at all (no step, no render).
  const before = h.renders.length;
  for (const n of [0, -1, NaN, Infinity, undefined]) {
    if (n === undefined) continue;
    assert.equal(h.loop.stepOnce(n), 0, `stepOnce(${n})`);
  }
  assert.equal(h.renders.length, before);
  // Absurd counts are capped instead of hanging the page.
  assert.equal(h.loop.stepOnce(1e9), 100000);
});

test('stepOnce does not disturb a running loop`s accumulator', () => {
  const h = harness();
  h.loop.start();
  h.frame(0);
  h.frame(STEP_MS * 0.5);
  h.loop.stepOnce(3);
  assert.equal(h.stepDts.length, 3);
  h.frame(STEP_MS * 0.5); // the accumulator reaches one step exactly
  assert.equal(h.stepDts.length, 4);
});

test('a throwing step or render is reported but keeps the loop alive', () => {
  /** @type {Array<[unknown, string]>} */
  const seen = [];
  let boom = true;
  const h = harness({
    step: () => {
      if (boom) throw new Error('step exploded');
    },
    render: () => {
      if (boom) throw new Error('render exploded');
    },
    onError: (err, phase) => seen.push([err, phase]),
  });
  h.loop.start();
  h.frame(0); // priming render throws
  h.frame(STEP_MS); // step + render throw
  assert.equal(h.loop.running, true, 'the loop must not die on a callback exception');
  assert.equal(h.pending(), true, 'the frame chain must survive');
  assert.deepEqual(
    seen.map((e) => e[1]),
    ['render', 'step', 'render'],
  );
  boom = false;
  h.frame(STEP_MS);
  assert.equal(seen.length, 3, 'no further errors once the callbacks recover');
});

test('without an onError callback, failures land in the core error ring buffer', () => {
  clearErrors();
  const h = harness({
    step: () => {
      throw new Error('kaboom');
    },
  });
  h.loop.start();
  h.frame(0);
  h.frame(STEP_MS);
  h.frame(STEP_MS);
  assert.ok(errors.length >= 1, 'the failure must be recorded for window.__game.errors');
  const entry = errors[errors.length - 1];
  assert.equal(entry.tag, 'loop');
  assert.match(entry.message, /step\(\) threw .*kaboom/);
  assert.equal(entry.count, 2, 'repeats collapse instead of flooding the buffer');
  clearErrors();
});

test('invalid options fall back to the documented defaults', () => {
  const h = harness({ hz: /** @type {any} */ ('nonsense'), maxCatchUp: /** @type {any} */ (undefined) });
  assert.equal(h.loop.hz, 60);
  assert.ok(Math.abs(h.loop.stepDt - 1 / 60) < 1e-15);
  h.loop.start();
  h.frame(0);
  h.frame(1000);
  assert.equal(h.stepDts.length, 5, 'default maxCatchUp of 5');

  const fast = harness({ hz: 128 });
  assert.equal(fast.loop.hz, 128);
  fast.loop.start();
  fast.frame(0);
  fast.frame(1000 / 128);
  assert.equal(fast.stepDts[0], 1 / 128);

  assert.throws(() => createLoop(/** @type {any} */ ({})), TypeError);
  assert.throws(() => createLoop(/** @type {any} */ ({ step: () => {} })), TypeError);
});

test('runs on the default host bindings (no DOM, no rAF) — the Node/worker path', async () => {
  let steps = 0;
  let renders = 0;
  const loop = createLoop({
    step: () => {
      steps++;
    },
    render: () => {
      renders++;
    },
  });
  loop.start();
  assert.equal(loop.running, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  loop.stop();
  assert.ok(steps > 0, 'the setTimeout fallback must drive the sim');
  assert.ok(renders > 0);
  const stats = loop.stats();
  assert.ok(stats.samples > 0 && stats.fps > 0, `stats came back empty: ${JSON.stringify(stats)}`);
  const stepsAfterStop = steps;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(steps, stepsAfterStop, 'stop() must really stop');
});

test('the steady state allocates nothing per frame', () => {
  const gc = globalThis.gc ?? tryEnableGc();
  if (!gc) {
    // Without --expose-gc the measurement is meaningless; the rest of the suite still covers
    // behaviour, so skip rather than report a false failure.
    return;
  }
  const h = harness();
  h.loop.start();
  h.frame(0);
  for (let i = 0; i < 5000; i++) h.frame(STEP_MS); // warm up and let V8 optimise
  // The fake harness itself records every step/render, which does allocate; drop that history.
  h.stepDts.length = 0;
  h.renders.length = 0;
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 20000; i++) {
    h.frame(STEP_MS);
    h.loop.stats();
    h.stepDts.length = 0;
    h.renders.length = 0;
  }
  gc();
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(growth < 512 * 1024, `heap grew ${(growth / 1024).toFixed(1)} KiB over 20k frames`);
});

/**
 * Best-effort access to V8's gc hook so the allocation test can run under a plain `node file`.
 * @returns {(() => void)|null}
 */
function tryEnableGc() {
  try {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    v8.setFlagsFromString('--no-expose-gc');
    return typeof gc === 'function' ? gc : null;
  } catch {
    return null;
  }
}
