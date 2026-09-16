// @ts-check
/**
 * @file `createMazeClient` — the main thread's door to level generation (ARCHITECTURE.md §4.4).
 *
 * Generation for a big maze is tens of milliseconds of pure CPU. On the main thread that is a
 * visible hitch in a 60 Hz loop, so anything above `WORKER_CELL_THRESHOLD` cells goes to a module
 * Web Worker; smaller mazes are built inline, because the worker round-trip would cost more than
 * the work itself.
 *
 * ## Failure policy: the worker is an optimisation, never a dependency
 * Every way the worker can let us down — the environment has no `Worker`, construction throws
 * (file:// origins, strict CSP), the script fails to parse, the worker goes silent, a message
 * arrives malformed — degrades to a synchronous build on the main thread. The player gets one
 * stutter instead of a dead game. The only thing that reaches the caller as a rejection is a
 * *genuine* build failure (invalid params, or a maze that fails validation), reproduced
 * synchronously so the error the caller sees is the real one with a real stack.
 *
 * `build()` therefore never throws synchronously, and never rejects for infrastructure reasons.
 */

import { createLogger } from '../core/log.js';
import { WORKER_CELL_THRESHOLD } from './constants.js';
import { buildLevel } from './level.js';

/** @typedef {import('../core/types.js').LevelData} LevelData */
/** @typedef {import('./level.js').LevelParams} LevelParams */

/**
 * Minimal structural type of the `Worker` instances this client drives. Declared structurally so
 * the client can be unit-tested with a fake in Node.
 * @typedef {Object} WorkerLike
 * @property {(message:unknown) => void} postMessage
 * @property {() => void} terminate
 * @property {((ev:{data:unknown}) => void)|null} [onmessage]
 * @property {((ev:unknown) => void)|null} [onerror]
 * @property {((ev:unknown) => void)|null} [onmessageerror]
 */

/**
 * Options for {@link createMazeClient}.
 * @typedef {Object} MazeClientOptions
 * @property {number} [threshold=400] cell count (`cols*rows`) above which the worker is used
 * @property {number} [timeoutMs=10000] how long to wait for a worker answer before giving up on it
 * @property {'auto'|'always'|'never'} [mode='auto'] force the worker on or off (tests, diagnostics)
 * @property {new (url:URL|string, opts?:{type?:string}) => WorkerLike} [WorkerCtor] worker
 *   constructor override; defaults to the global `Worker` when one exists
 */

/**
 * The maze client returned by {@link createMazeClient}.
 * @typedef {Object} MazeClient
 * @property {(params:LevelParams, seed:number) => Promise<LevelData>} build
 * @property {() => void} dispose
 * @property {() => 'worker'|'sync'|'disposed'} mode   what the *next* large build would use
 * @property {() => number} pending                    in-flight worker requests
 */

/** Default time budget for a worker answer, milliseconds (ARCHITECTURE.md §4.4). */
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Coerce an unknown thrown value into an `Error` without losing information.
 * @param {unknown} err
 * @returns {Error}
 */
function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Create a maze client. One per game; call `dispose()` on teardown.
 *
 * @param {MazeClientOptions} [options]
 * @returns {MazeClient}
 */
export function createMazeClient(options) {
  const log = createLogger('maze/client');
  const opts = options || {};
  const threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : WORKER_CELL_THRESHOLD;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
    ? Number(opts.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const mode = opts.mode === 'always' || opts.mode === 'never' ? opts.mode : 'auto';
  const WorkerCtor =
    opts.WorkerCtor ||
    (typeof (/** @type {{Worker?:unknown}} */ (globalThis).Worker) === 'function'
      ? /** @type {new (url:URL|string, o?:{type?:string}) => WorkerLike} */ (
          /** @type {unknown} */ (/** @type {{Worker:unknown}} */ (globalThis).Worker)
        )
      : null);

  /**
   * One in-flight worker request.
   * @typedef {Object} Pending
   * @property {(data:LevelData) => void} resolve
   * @property {(err:Error) => void} reject
   * @property {LevelParams} params
   * @property {number} seed
   * @property {ReturnType<typeof setTimeout>} timer
   */

  /** @type {Map<number, Pending>} */
  const pending = new Map();
  /** @type {WorkerLike|null} */
  let worker = null;
  /** Once true the worker is never retried for the lifetime of this client. */
  let workerUnavailable = false;
  let disposed = false;
  let nextId = 1;

  /**
   * Build synchronously on the calling thread, converting a throw into a rejection so `build`
   * always hands back a promise.
   * @param {LevelParams} params
   * @param {number} seed
   * @returns {Promise<LevelData>}
   */
  function buildSync(params, seed) {
    try {
      return Promise.resolve(buildLevel(params, seed));
    } catch (err) {
      return Promise.reject(toError(err));
    }
  }

  /**
   * Settle one pending request by rebuilding it synchronously. Used for every infrastructure
   * failure (timeout, worker crash, worker-reported error).
   * @param {number} id
   * @param {string} why  human-readable reason, logged in debug builds
   * @returns {void}
   */
  function fallbackToSync(id, why) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    log.warn(`worker request ${id} ${why}; rebuilding synchronously`);
    try {
      p.resolve(buildLevel(p.params, p.seed));
    } catch (err) {
      p.reject(toError(err));
    }
  }

  /**
   * Retire the worker and re-run everything still in flight on this thread.
   * @param {string} why
   * @returns {void}
   */
  function retireWorker(why) {
    workerUnavailable = true;
    const w = worker;
    worker = null;
    if (w) {
      try {
        w.terminate();
      } catch {
        // A worker that cannot even be terminated is already gone; nothing useful to do.
      }
    }
    for (const id of Array.from(pending.keys())) fallbackToSync(id, why);
  }

  /**
   * Handle a message from the worker. Unknown ids are ignored (a late answer to a request that
   * already timed out and was rebuilt synchronously).
   * @param {{data:unknown}} ev
   * @returns {void}
   */
  function onMessage(ev) {
    const msg = ev && typeof ev.data === 'object' && ev.data !== null ? /** @type {Record<string, unknown>} */ (ev.data) : null;
    if (!msg) return;
    const id = Number(msg.id);
    const p = pending.get(id);
    if (!p) return;

    if (typeof msg.error === 'string') {
      // A real build failure. Reproduce it synchronously so the caller gets a proper Error with a
      // stack, and so a transient worker glitch cannot fail a level that would build fine here.
      fallbackToSync(id, `reported "${msg.error}"`);
      return;
    }
    const data = /** @type {LevelData|undefined} */ (msg.data);
    if (!data || !data.maze || !ArrayBuffer.isView(data.maze.tiles)) {
      fallbackToSync(id, 'returned a malformed level');
      return;
    }
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(data);
  }

  /**
   * Create the worker on first use. Returns null when workers are unavailable in this environment
   * or have already failed once.
   * @returns {WorkerLike|null}
   */
  function ensureWorker() {
    if (worker || workerUnavailable || !WorkerCtor) return worker;
    try {
      // The specifier must be resolved against this module's URL — the worker file sits next to
      // it, and a bare './worker.js' would be resolved against the *page* instead.
      const w = new WorkerCtor(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = onMessage;
      w.onerror = () => retireWorker('crashed');
      w.onmessageerror = () => retireWorker('sent an uncloneable message');
      worker = w;
      log.debug('module worker started');
    } catch (err) {
      workerUnavailable = true;
      worker = null;
      log.warn('worker unavailable, using synchronous generation:', toError(err).message);
    }
    return worker;
  }

  /**
   * Build a level. Never throws; rejects only when the level genuinely cannot be built.
   * @param {LevelParams} params
   * @param {number} seed
   * @returns {Promise<LevelData>}
   */
  function build(params, seed) {
    if (disposed) return Promise.reject(new Error('maze client: build() called after dispose()'));

    const cells = Number(params?.cols) * Number(params?.rows);
    const wantsWorker = mode === 'always' || (mode === 'auto' && Number.isFinite(cells) && cells > threshold);
    const w = wantsWorker ? ensureWorker() : null;
    if (!w) return buildSync(params, seed);

    const id = nextId++;
    return new Promise((resolve, reject) => {
      // A worker that misses its deadline is treated as dead, not slow: it is terminated and every
      // request riding on it (not just this one) is rebuilt here. Anything else risks a queue of
      // levels all waiting on a worker that will never answer.
      const timer = setTimeout(() => retireWorker(`timed out after ${timeoutMs} ms`), timeoutMs);
      // Do not let a pending timeout hold a Node process (or a test run) open.
      if (typeof (/** @type {{unref?:() => void}} */ (timer).unref) === 'function') {
        /** @type {{unref:() => void}} */ (timer).unref();
      }
      pending.set(id, { resolve, reject, params, seed, timer });
      try {
        w.postMessage({ id, params, seed });
      } catch (err) {
        // postMessage can throw if `params` is not cloneable (a function slipped into balance.js).
        pending.delete(id);
        clearTimeout(timer);
        log.warn('postMessage failed, using synchronous generation:', toError(err).message);
        buildSync(params, seed).then(resolve, reject);
      }
    });
  }

  /**
   * Terminate the worker and reject anything still in flight. Idempotent.
   * @returns {void}
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    const w = worker;
    worker = null;
    if (w) {
      try {
        w.terminate();
      } catch {
        // Already gone.
      }
    }
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('maze client disposed while a level was still building'));
    }
    pending.clear();
  }

  return {
    build,
    dispose,
    mode: () => (disposed ? 'disposed' : mode !== 'never' && WorkerCtor && !workerUnavailable ? 'worker' : 'sync'),
    pending: () => pending.size,
  };
}
