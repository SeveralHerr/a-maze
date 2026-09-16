// @ts-check
/**
 * @file Module Web Worker that builds levels off the main thread (ARCHITECTURE.md §4.4).
 *
 * Protocol (both directions are plain structured-cloneable objects):
 *
 *   main → worker   `{ id:number, params:LevelParams, seed:number }`
 *   worker → main   `{ id:number, data:LevelData }`                        on success
 *                   `{ id:number, error:string, name:string }`             on failure
 *
 * The tile buffer (and the validator's path buffer) are **transferred**, not copied, so handing a
 * 512×512 level back costs a pointer hand-off instead of a megabyte memcpy. The worker never
 * touches a level after posting it — the buffers are detached at that moment.
 *
 * Errors are never allowed to escape: an exception here would surface as an opaque `ErrorEvent`
 * on the client with no way to tell which request died, so `handleMazeRequest` catches everything
 * and answers with the same id. `client.js` still installs an `onerror` handler as a second line
 * of defence (e.g. if this module fails to load at all).
 *
 * Importable in Node: the message listener is only installed when the module really is running
 * inside a worker global scope, which keeps `handleMazeRequest` unit-testable.
 */

import { buildLevel, levelTransferList } from './level.js';

/** @typedef {import('../core/types.js').LevelData} LevelData */
/** @typedef {import('./level.js').LevelParams} LevelParams */

/**
 * A request as it arrives from `client.js`.
 * @typedef {{id:number, params:LevelParams, seed:number}} MazeRequest
 */

/**
 * The worker's answer plus the buffers to transfer with it.
 * @typedef {Object} MazeResponse
 * @property {{id:number, data?:LevelData, error?:string, name?:string}} message   what to post
 * @property {ArrayBuffer[]} transfer   buffers to hand over (empty on error)
 */

/**
 * Turn one request into one response. Total function: it never throws, whatever `msg` contains.
 * Exported so the protocol can be unit-tested in Node without spawning a worker.
 *
 * @param {unknown} msg the raw `MessageEvent.data`
 * @returns {MazeResponse|null} `null` when the message is not a maze request at all (no usable
 *   id), in which case the caller must stay silent rather than answering an unknown correspondent
 */
export function handleMazeRequest(msg) {
  if (msg === null || typeof msg !== 'object') return null;
  const req = /** @type {Partial<MazeRequest>} */ (msg);
  const id = Number(req.id);
  if (!Number.isFinite(id)) return null;

  try {
    const data = buildLevel(/** @type {LevelParams} */ (req.params), Number(req.seed));
    return { message: { id, data }, transfer: levelTransferList(data) };
  } catch (err) {
    const e = /** @type {Error} */ (err);
    return {
      message: {
        id,
        error: e && e.message ? String(e.message) : String(err),
        name: e && e.name ? String(e.name) : 'Error',
      },
      transfer: [],
    };
  }
}

/**
 * True when this module is executing inside a dedicated worker: it has `postMessage` and
 * `addEventListener` at global scope but no `document`. Checked defensively (rather than with
 * `instanceof DedicatedWorkerGlobalScope`) so the module also imports cleanly in Node and in
 * test harnesses that fake a worker scope.
 * @returns {boolean}
 */
function inWorkerScope() {
  const g = /** @type {{postMessage?:unknown, addEventListener?:unknown, document?:unknown}} */ (
    /** @type {unknown} */ (globalThis)
  );
  return typeof g.postMessage === 'function' && typeof g.addEventListener === 'function' && g.document === undefined;
}

if (inWorkerScope()) {
  const scope = /** @type {{postMessage:(m:unknown, t?:ArrayBuffer[])=>void, addEventListener:Function}} */ (
    /** @type {unknown} */ (globalThis)
  );
  scope.addEventListener('message', (/** @type {MessageEvent} */ ev) => {
    const res = handleMazeRequest(ev && ev.data);
    if (res === null) return; // not ours (extension noise, a ping from devtools, …)
    scope.postMessage(res.message, res.transfer);
  });
}
