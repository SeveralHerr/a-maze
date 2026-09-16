// @ts-check
/**
 * @file Fixed-timestep game loop with interpolated rendering and rolling frame statistics.
 *
 * Why fixed timestep: the sim (movement, collision, fuel) must be deterministic and stable no
 * matter what the display refresh rate is — 60 Hz, 144 Hz, or a throttled background tab. The
 * loop accumulates real time and runs whole 1/hz steps, then renders once per frame with an
 * `alpha` in [0,1) so the renderer can interpolate between the previous and current sim state.
 * (Glenn Fiedler, "Fix Your Timestep!")
 *
 * Invariants:
 * - `step(dt)` always receives exactly `1/hz` seconds. Never a variable dt.
 * - At most `maxCatchUp` steps run per frame; time beyond that is *discarded*, never queued, so a
 *   long stall (tab switch, GC pause, breakpoint) can never trigger a death spiral where each
 *   frame owes more steps than the last.
 * - Zero allocations per frame: the tick callback, the stats object and the ring buffers are all
 *   created once, at construction.
 * - DOM access is guarded: with no `document`/`requestAnimationFrame` (Node, worker) the module
 *   still imports and runs, driven by `setTimeout`, and `stepOnce()` works with no clock at all.
 *
 * All durations in the public API are **seconds**, except `FrameStats` fields ending in `Ms`.
 */

import { createLogger } from './log.js';

/** Frames kept in the rolling statistics window (≈2 s at 60 fps). */
const WINDOW = 120;

/** Default simulation rate in steps per second. */
const DEFAULT_HZ = 60;

/** Default cap on simulation steps executed in a single frame. */
const DEFAULT_MAX_CATCH_UP = 5;

/**
 * Default vsync snapping tolerance in milliseconds. Frame deltas within this distance of a whole
 * number of steps are treated as exactly that many steps, which removes the 1-step/2-step
 * stuttering that raw rAF jitter (±0.2 ms) causes on a display running at exactly the sim rate.
 */
const DEFAULT_SNAP_MS = 0.4;

/** Hard ceiling on `stepOnce(n)` so a bad argument cannot hang the page (≈27 min of sim). */
const MAX_MANUAL_STEPS = 100000;

/**
 * How often a suspended loop re-reads `document.hidden`, in milliseconds.
 *
 * The way *into* suspension is defended twice — the `visibilitychange` listener *and* a per-frame
 * re-check in `tick()` — precisely because some embedders (itch.io's iframe, older Safari) fire
 * that event unreliably. The way *out* must be defended the same way, or an embedder that drops
 * the event on the way back leaves the loop suspended with no frame pending and nothing left to
 * re-check it: a permanent freeze that only a reload clears. 250 ms is four checks a second, far
 * below anything a player perceives as a stall, at a cost of one boolean read per tick while
 * suspended (and nothing at all while running).
 */
const VISIBILITY_POLL_MS = 250;

/**
 * Rolling frame statistics over the last `samples` frames (≤ 120). The object returned by
 * `stats()` is **reused** — copy the fields you need to keep.
 * @typedef {Object} FrameStats
 * @property {number} fps            frames per second, averaged over the window (0 with no data)
 * @property {number} frameMsAvg     mean wall time between frames, ms
 * @property {number} frameMsP99     99th-percentile frame interval in the window, ms
 * @property {number} stepMsAvg      mean wall time of one `step()` call, ms (0 if no steps ran)
 * @property {number} renderMsAvg    mean wall time of one `render()` call, ms
 * @property {number} droppedFrames  frames missed in the window, estimated from frame intervals
 * @property {number} samples        frames currently in the window (0…120)
 * @property {number} skippedSteps   sim steps discarded by the catch-up clamp since `start()`
 */

/**
 * Options for `createLoop`. `now`/`raf`/`caf`/`doc` are the injectable host bindings: they default
 * to `performance.now`, `requestAnimationFrame`, `cancelAnimationFrame` and the global `document`
 * where those exist, and tests/headless tools pass fakes instead.
 * @typedef {Object} LoopOptions
 * @property {(dt:number) => void} step        advance the sim by exactly `dt` seconds
 * @property {(alpha:number, frameDt:number) => void} render
 *   draw one frame. `alpha` ∈ [0,1) is the fraction of a step elapsed since the last one
 *   (interpolate previous → current state by it); `frameDt` is the real seconds since the
 *   previous frame, clamped to `maxCatchUp` steps, for frame-rate independent effects.
 * @property {number} [hz=60]                  simulation steps per second (1…1000)
 * @property {number} [maxCatchUp=5]           max steps per frame (≥ 1)
 * @property {number} [vsyncSnapMs=0.4]        frame-interval snapping tolerance, ms (0 disables)
 * @property {(err:unknown, phase:'step'|'render') => void} [onError]
 *   called when a step/render callback throws; the loop keeps running. Defaults to logging into
 *   the core error ring buffer.
 * @property {() => number} [now]
 * @property {(cb:(ts:number)=>void) => number} [raf]
 * @property {(id:number) => void} [caf]
 * @property {{hidden:boolean, addEventListener:Function, removeEventListener:Function}|null} [doc]
 * @property {(fn:() => void, ms:number) => any} [setTimer]
 *   schedules the visibility re-check while suspended; defaults to `setTimeout`. `null`/absent
 *   host timers simply disable the poll (the `visibilitychange` listener still works).
 * @property {(id:any) => void} [clearTimer]  counterpart of `setTimer`; defaults to `clearTimeout`
 */

/**
 * @typedef {Object} Loop
 * @property {() => void} start           begin ticking (idempotent)
 * @property {() => void} stop            stop ticking and detach listeners (idempotent)
 * @property {boolean} running            true between `start()` and `stop()` (getter)
 * @property {boolean} suspended          true while paused by `document.hidden` (getter)
 * @property {number} hz                  simulation rate, steps/second (getter)
 * @property {number} stepDt              seconds per step = 1/hz (getter)
 * @property {() => FrameStats} stats     rolling statistics (reused object)
 * @property {() => void} resetStats      clear the statistics window
 * @property {(n?:number) => number} stepOnce  run n steps + one render synchronously; returns steps run
 */

/**
 * Create a fixed-timestep loop. Nothing is scheduled until `start()`.
 * @param {LoopOptions} options
 * @returns {Loop}
 */
export function createLoop(options) {
  const opts = options || /** @type {LoopOptions} */ ({});
  if (typeof opts.step !== 'function' || typeof opts.render !== 'function') {
    throw new TypeError('createLoop: { step, render } functions are required');
  }
  const step = opts.step;
  const render = opts.render;
  const log = createLogger('loop');

  // ── Configuration (validated once; bad values fall back to the documented defaults) ──────────
  const hz = clampInt(opts.hz, 1, 1000, DEFAULT_HZ);
  const maxCatchUp = clampInt(opts.maxCatchUp, 1, 1000, DEFAULT_MAX_CATCH_UP);
  const stepDt = 1 / hz;
  const stepMs = 1000 / hz;
  const maxFrameMs = stepMs * maxCatchUp;
  const snapMs = Number.isFinite(opts.vsyncSnapMs) ? Math.max(0, /** @type {number} */ (opts.vsyncSnapMs)) : DEFAULT_SNAP_MS;
  const onError = typeof opts.onError === 'function' ? opts.onError : defaultOnError;

  // ── Host bindings (all optional, so the module imports and runs under Node) ──────────────────
  const now = typeof opts.now === 'function' ? opts.now : defaultNow();
  const raf = typeof opts.raf === 'function' ? opts.raf : defaultRaf();
  const caf = typeof opts.caf === 'function' ? opts.caf : defaultCaf();
  /** `undefined` means "use the global document"; explicit `null` disables visibility pausing. */
  const doc =
    opts.doc !== undefined
      ? opts.doc
      : typeof document !== 'undefined'
        ? /** @type {any} */ (document)
        : null;
  const setTimer = typeof opts.setTimer === 'function' ? opts.setTimer : defaultSetTimer();
  const clearTimer = typeof opts.clearTimer === 'function' ? opts.clearTimer : defaultClearTimer();

  // ── Loop state ───────────────────────────────────────────────────────────────────────────────
  let running = false;
  let suspended = false;
  /** Scheduler handle of the pending frame, or 0 when none is pending. */
  let frameHandle = 0;
  /** Timer handle of the visibility poll that runs while suspended, or `null` when none. */
  let pollHandle = /** @type {any} */ (null);
  /** Timestamp of the previous frame, ms. NaN means "next frame only primes the clock". */
  let lastTs = NaN;
  /** Unconsumed simulation time, seconds. */
  let acc = 0;
  let skippedSteps = 0;

  // ── Statistics (preallocated ring buffers — no per-frame allocation) ─────────────────────────
  const frameMsRing = new Float64Array(WINDOW);
  const stepMsRing = new Float64Array(WINDOW); // total step() time in that frame
  const stepCountRing = new Float64Array(WINDOW); // steps executed in that frame
  const renderMsRing = new Float64Array(WINDOW);
  let ringHead = 0;
  let ringCount = 0;

  /** @type {FrameStats} Reused result object; `stats()` overwrites it in place. */
  const statsOut = {
    fps: 0,
    frameMsAvg: 0,
    frameMsP99: 0,
    stepMsAvg: 0,
    renderMsAvg: 0,
    droppedFrames: 0,
    samples: 0,
    skippedSteps: 0,
  };

  /**
   * Fallback error sink: record into the core error ring buffer (surfaced as
   * `window.__game.errors`) instead of throwing away the frame or spamming the console.
   * @param {unknown} err
   * @param {'step'|'render'} phase
   * @returns {void}
   */
  function defaultOnError(err, phase) {
    log.error(`${phase}() threw`, err);
  }

  /**
   * Run the pending simulation steps and one render for this frame.
   * Called by the scheduler; never re-entrant (the next frame is requested up front, and the
   * scheduler cannot re-enter a synchronous callback).
   * @param {number} ts frame timestamp in ms from the scheduler (rAF's DOMHighResTimeStamp)
   * @returns {void}
   */
  function tick(ts) {
    frameHandle = 0;
    if (!running) return;

    // Re-check visibility every frame: some embedders (itch.io's iframe, older Safari) fire
    // `visibilitychange` unreliably, and burning frames on an invisible canvas wastes battery.
    if (doc && doc.hidden) {
      suspend();
      return;
    }

    // Schedule the next frame before doing any work, so an exception anywhere below cannot break
    // the chain. `stop()` inside step/render cancels it again.
    frameHandle = raf(tick);

    const t = Number.isFinite(ts) ? ts : now();

    if (Number.isNaN(lastTs)) {
      // First frame after start()/resume: establish the clock, draw the current state, do not
      // simulate the (arbitrarily long) gap since start() was called.
      lastTs = t;
      runRender(0, 0);
      return;
    }

    let frameMs = t - lastTs;
    lastTs = t;
    // Guard against a non-monotonic or duplicated timestamp (some browsers repeat the rAF
    // timestamp for two callbacks in the same frame).
    if (!(frameMs > 0)) frameMs = 0;
    const rawFrameMs = frameMs;
    if (frameMs > maxFrameMs) {
      // Discard the stall instead of queueing it (see the death-spiral invariant) and record how
      // much simulated time was thrown away, for the debug HUD and the headless verifier.
      skippedSteps += Math.floor((frameMs - maxFrameMs) / stepMs);
      frameMs = maxFrameMs;
    } else if (snapMs > 0) {
      frameMs = snapToStep(frameMs);
    }

    acc += frameMs / 1000;

    let steps = 0;
    let stepTotalMs = 0;
    while (acc >= stepDt && steps < maxCatchUp) {
      const t0 = now();
      try {
        step(stepDt);
      } catch (err) {
        onError(err, 'step');
      }
      stepTotalMs += now() - t0;
      acc -= stepDt;
      steps++;
    }
    if (acc >= stepDt) {
      // Defence in depth: the clamp above already bounds the owed time to `maxCatchUp` steps, so
      // this cannot trigger today. It stays as one comparison per frame so that a future change
      // to the clamp can never resurrect the death spiral — drop whole steps, keep the sub-step
      // remainder so the interpolation phase stays continuous.
      const whole = Math.floor(acc / stepDt);
      skippedSteps += whole;
      acc -= whole * stepDt;
    }

    const rt0 = now();
    // alpha ∈ [0,1): how far the renderer should interpolate from the previous sim state toward
    // the current one. Clamped defensively — float drift must never hand the renderer 1.0000001.
    runRender(acc >= stepDt ? 0.999999 : acc / stepDt, frameMs / 1000);
    const renderMs = now() - rt0;

    recordFrame(rawFrameMs, stepTotalMs, steps, renderMs);
  }

  /**
   * Invoke the render callback, isolating exceptions.
   * @param {number} alpha 0..1
   * @param {number} frameDt seconds
   * @returns {void}
   */
  function runRender(alpha, frameDt) {
    try {
      render(alpha, frameDt);
    } catch (err) {
      onError(err, 'render');
    }
  }

  /**
   * Snap a frame interval to a whole number of steps when it is within `snapMs` of one. Keeps a
   * display running at (or near) the sim rate producing exactly one step per frame.
   * @param {number} ms raw frame interval
   * @returns {number} snapped interval
   */
  function snapToStep(ms) {
    const k = Math.round(ms / stepMs);
    if (k < 1) return ms;
    const snapped = k * stepMs;
    return Math.abs(ms - snapped) <= snapMs ? snapped : ms;
  }

  /**
   * Push one frame's measurements into the ring buffers.
   * @param {number} frameMs raw (unclamped) interval since the previous frame
   * @param {number} stepMsTotal total time spent inside step() this frame
   * @param {number} steps steps executed this frame
   * @param {number} renderMs time spent inside render() this frame
   * @returns {void}
   */
  function recordFrame(frameMs, stepMsTotal, steps, renderMs) {
    frameMsRing[ringHead] = frameMs;
    stepMsRing[ringHead] = stepMsTotal;
    stepCountRing[ringHead] = steps;
    renderMsRing[ringHead] = renderMs;
    ringHead = ringHead + 1 === WINDOW ? 0 : ringHead + 1;
    if (ringCount < WINDOW) ringCount++;
  }

  /** Pause because the document became hidden; keeps `running` true. @returns {void} */
  function suspend() {
    if (suspended) return;
    suspended = true;
    cancelFrame();
    // Forget the clock and the pending sim time: the wall time spent hidden is not game time.
    lastTs = NaN;
    acc = 0;
    // No frame is pending now, so `tick()`'s per-frame visibility re-check is gone with it. The
    // poll is what replaces it until the document is visible again (see VISIBILITY_POLL_MS).
    startVisibilityPoll();
  }

  /** Resume after the document became visible again. @returns {void} */
  function resume() {
    if (!running || !suspended) return;
    suspended = false;
    stopVisibilityPoll();
    lastTs = NaN; // next frame re-primes the clock instead of catching up on the hidden period
    requestFrame();
  }

  /** @returns {void} */
  function onVisibilityChange() {
    if (!running) return;
    if (doc && doc.hidden) suspend();
    else resume();
  }

  /**
   * Schedule the next visibility re-check. Idempotent, and a no-op where the host has no timers.
   * @returns {void}
   */
  function startVisibilityPoll() {
    if (pollHandle !== null || setTimer === null || !doc) return;
    pollHandle = setTimer(pollVisible, VISIBILITY_POLL_MS);
  }

  /** @returns {void} */
  function stopVisibilityPoll() {
    if (pollHandle === null) return;
    if (clearTimer !== null) clearTimer(pollHandle);
    pollHandle = null;
  }

  /**
   * Re-read `doc.hidden` while suspended and resume the moment it is false, whether or not the
   * embedder ever delivered the `visibilitychange` event that would have said so.
   * @returns {void}
   */
  function pollVisible() {
    pollHandle = null;
    if (!running || !suspended) return;
    if (doc && !doc.hidden) resume();
    else startVisibilityPoll();
  }

  /** @returns {void} */
  function requestFrame() {
    if (frameHandle === 0) frameHandle = raf(tick);
  }

  /** @returns {void} */
  function cancelFrame() {
    if (frameHandle !== 0) {
      caf(frameHandle);
      frameHandle = 0;
    }
  }

  /** @returns {void} */
  function start() {
    if (running) return;
    running = true;
    suspended = false;
    lastTs = NaN;
    acc = 0;
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', onVisibilityChange, false);
    }
    // A window that is focused or restored from the back/forward cache is visible, whatever the
    // document last said. Cheap, symmetrical belt and braces alongside the poll; absent in Node
    // and in the tests' fake documents, which have no `defaultView`.
    const win = viewOf(doc);
    if (win) {
      win.addEventListener('pageshow', onVisibilityChange, false);
      win.addEventListener('focus', onVisibilityChange, false);
    }
    if (doc && doc.hidden) {
      suspended = true;
      startVisibilityPoll();
    } else {
      requestFrame();
    }
  }

  /** @returns {void} */
  function stop() {
    if (!running) return;
    running = false;
    suspended = false;
    cancelFrame();
    stopVisibilityPoll();
    lastTs = NaN;
    acc = 0;
    if (doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', onVisibilityChange, false);
    }
    const win = viewOf(doc);
    if (win) {
      win.removeEventListener('pageshow', onVisibilityChange, false);
      win.removeEventListener('focus', onVisibilityChange, false);
    }
  }

  /**
   * Compute the rolling statistics. Allocation-free: the result object and the percentile scratch
   * buffer are reused, so the HUD may call this every frame.
   * @returns {FrameStats}
   */
  function stats() {
    const n = ringCount;
    statsOut.samples = n;
    statsOut.skippedSteps = skippedSteps;
    if (n === 0) {
      statsOut.fps = 0;
      statsOut.frameMsAvg = 0;
      statsOut.frameMsP99 = 0;
      statsOut.stepMsAvg = 0;
      statsOut.renderMsAvg = 0;
      statsOut.droppedFrames = 0;
      return statsOut;
    }
    let frameSum = 0;
    let stepSum = 0;
    let stepCount = 0;
    let renderSum = 0;
    let dropped = 0;
    for (let i = 0; i < n; i++) {
      const f = frameMsRing[i];
      frameSum += f;
      stepSum += stepMsRing[i];
      stepCount += stepCountRing[i];
      renderSum += renderMsRing[i];
      // A frame that took ~k step periods missed about k-1 refreshes at the target rate.
      const k = Math.round(f / stepMs) - 1;
      if (k > 0) dropped += k;
    }
    const avg = frameSum / n;
    statsOut.frameMsAvg = avg;
    statsOut.fps = avg > 0 ? 1000 / avg : 0;
    statsOut.stepMsAvg = stepCount > 0 ? stepSum / stepCount : 0;
    statsOut.renderMsAvg = renderSum / n;
    statsOut.droppedFrames = dropped;
    statsOut.frameMsP99 = percentile99(frameMsRing, n);
    return statsOut;
  }

  /** @returns {void} */
  function resetStats() {
    ringHead = 0;
    ringCount = 0;
    skippedSteps = 0;
  }

  /**
   * Run `n` simulation steps back to back, then render once showing the final state
   * (`alpha` = 1). For headless tools and tests; independent of the accumulator, so it is safe to
   * call whether or not the loop is running. Non-finite or negative `n` runs nothing; `n` is
   * floored and capped at 100000 steps.
   * @param {number} [n=1]
   * @returns {number} steps actually executed
   */
  function stepOnce(n = 1) {
    const count = Number.isFinite(n) ? Math.min(Math.floor(/** @type {number} */ (n)), MAX_MANUAL_STEPS) : 0;
    if (count <= 0) return 0;
    for (let i = 0; i < count; i++) {
      try {
        step(stepDt);
      } catch (err) {
        onError(err, 'step');
      }
    }
    // Clamp the reported frame time the same way the real loop does, so time-based effects do not
    // jump when a tool fast-forwards thousands of steps.
    runRender(1, Math.min(count * stepDt, maxFrameMs / 1000));
    return count;
  }

  return {
    start,
    stop,
    get running() {
      return running;
    },
    get suspended() {
      return suspended;
    },
    get hz() {
      return hz;
    },
    get stepDt() {
      return stepDt;
    },
    stats,
    resetStats,
    stepOnce,
  };
}

/**
 * Largest values tracked by {@link percentile99}. The wanted rank counted from the top is
 * `n - (ceil(0.99n) - 1) ≤ 0.01n + 1`, which is 2 for a full 120-frame window and never more than
 * 3 for any `n ≤ WINDOW`; 4 leaves a slot of headroom and the function falls back to a sort if a
 * future, much larger window ever needed more.
 */
const TOP_K = 4;

/**
 * Scratch for the top-K selection. Module-level and shared by every loop on the page, which is
 * safe because `percentile99` is synchronous, non-reentrant and leaves nothing behind between
 * calls — and it keeps `stats()` allocation-free, which is a contract promise (§4.1).
 */
const topScratch = new Float64Array(TOP_K);

/**
 * 99th percentile of the first `n` entries of `buf`, read-only.
 *
 * A full sort is the obvious implementation and the wrong one. `stats()` is called every frame
 * (main.js hands it to `hud.render`), the ring is refilled from arbitrary frame intervals — *not*
 * nearly sorted, whatever an earlier comment here claimed — and only the top handful of entries
 * can ever be the answer. So this keeps the K largest values in a fixed 4-slot buffer in one
 * linear pass: O(n·K) with K ≤ 4 instead of O(n²), no allocation, and the buffer it reads is left
 * untouched.
 * @param {Float64Array} buf
 * @param {number} n
 * @returns {number} ms
 */
function percentile99(buf, n) {
  if (n <= 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(0.99 * n) - 1));
  const k = n - idx; // rank from the top: 1 = the maximum
  if (k > TOP_K) return percentileBySort(buf, n, idx);
  // topScratch[0..k-1] holds the k largest seen so far, descending.
  let held = 0;
  for (let i = 0; i < n; i++) {
    const v = buf[i];
    if (held === k && v <= topScratch[k - 1]) continue;
    let j = held < k ? held : k - 1;
    while (j > 0 && topScratch[j - 1] < v) {
      topScratch[j] = topScratch[j - 1];
      j--;
    }
    topScratch[j] = v;
    if (held < k) held++;
  }
  return topScratch[k - 1];
}

/**
 * Fallback for a window large enough that the wanted rank is deeper than {@link TOP_K}.
 * Unreachable at `WINDOW` = 120 and kept only so a future window size cannot silently return a
 * wrong number; it copies into a fresh array, which is why the top-K path exists at all.
 * @param {Float64Array} buf
 * @param {number} n
 * @param {number} idx ascending index of the wanted value
 * @returns {number} ms
 */
function percentileBySort(buf, n, idx) {
  const copy = Array.prototype.slice.call(buf, 0, n);
  copy.sort((a, b) => a - b);
  return copy[idx];
}

/**
 * The window a document belongs to, when it has one (`defaultView` is absent in Node and in the
 * unit tests' fake documents).
 * @param {any} d
 * @returns {{addEventListener:Function, removeEventListener:Function}|null}
 */
function viewOf(d) {
  const win = d && d.defaultView;
  return win && typeof win.addEventListener === 'function' && typeof win.removeEventListener === 'function'
    ? win
    : null;
}

/**
 * `setTimeout` when the host has one, else `null` (the visibility poll is simply disabled).
 * @returns {((fn:() => void, ms:number) => any)|null}
 */
function defaultSetTimer() {
  const g = /** @type {any} */ (globalThis);
  return typeof g.setTimeout === 'function' ? (fn, ms) => g.setTimeout(fn, ms) : null;
}

/**
 * Counterpart of {@link defaultSetTimer}.
 * @returns {((id:any) => void)|null}
 */
function defaultClearTimer() {
  const g = /** @type {any} */ (globalThis);
  return typeof g.clearTimeout === 'function' ? (id) => g.clearTimeout(id) : null;
}

/**
 * Validate an optional integer option.
 * @param {number|undefined} v
 * @param {number} lo
 * @param {number} hi
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(v, lo, hi, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const i = Math.round(v);
  return i < lo ? lo : i > hi ? hi : i;
}

/**
 * Monotonic millisecond clock, preferring `performance.now` (monotonic, sub-ms) over `Date.now`
 * (wall clock, can jump backwards when the system clock is adjusted).
 * @returns {() => number}
 */
function defaultNow() {
  const perf = /** @type {{now?:() => number}|undefined} */ (/** @type {any} */ (globalThis).performance);
  const perfNow = perf && typeof perf.now === 'function' ? perf.now.bind(perf) : null;
  return perfNow !== null ? perfNow : () => Date.now();
}

/**
 * `requestAnimationFrame` when the host has one, otherwise a `setTimeout` pacer so the loop also
 * runs in Node and in workers (used by headless tools).
 * @returns {(cb:(ts:number)=>void) => number}
 */
function defaultRaf() {
  const g = /** @type {any} */ (globalThis);
  if (typeof g.requestAnimationFrame === 'function') {
    return (cb) => g.requestAnimationFrame(cb);
  }
  const clock = defaultNow();
  /** @type {((ts:number) => void)|null} Pending callback; the loop only ever schedules one. */
  let pending = null;
  // Reading the clock when the timer *fires* (not when it is scheduled) keeps frame deltas
  // honest under timer throttling. Hoisted out of the scheduling function so no closure is
  // allocated per frame.
  const fire = () => {
    const cb = pending;
    pending = null;
    if (cb) cb(clock());
  };
  // 16 ms ≈ 60 Hz. Timers are the only option off-screen; the accumulator absorbs their jitter.
  return (cb) => {
    pending = cb;
    return /** @type {any} */ (setTimeout(fire, 16));
  };
}

/**
 * Counterpart of `defaultRaf`.
 * @returns {(id:number) => void}
 */
function defaultCaf() {
  const g = /** @type {any} */ (globalThis);
  if (typeof g.cancelAnimationFrame === 'function') {
    return (id) => g.cancelAnimationFrame(id);
  }
  return (id) => clearTimeout(/** @type {any} */ (id));
}
