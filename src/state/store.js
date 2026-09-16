// @ts-check
/**
 * @file The store (ARCHITECTURE.md §4.2) — the only thing allowed to hold the game state.
 *
 * Deliberately tiny and un-clever. The reducer mutates one long-lived state object in place, so
 * there is no snapshotting, no structural sharing and no per-tick allocation; subscribers are
 * notified after each action and read the live object.
 *
 * ## Guarantees
 * - **Never re-entrant.** A `dispatch` made from inside a reducer or a subscriber is queued and
 *   run after the current one finishes, in FIFO order. The state is therefore never observed
 *   half-way through an action.
 * - **Never throws for the caller.** A malformed action is ignored; a reducer or subscriber that
 *   throws is caught, reported to the core error ring buffer, and the rest of the run continues.
 *   A crash in the audio subscriber must not take the game loop with it.
 * - **Zero allocation per dispatch.** No arrays are copied, no closures are created; the listener
 *   list is iterated in place with tombstones for removals.
 *
 * ## Subscriber semantics
 * A listener registered during a dispatch is not called for that dispatch (it runs from the next
 * one); a listener removed during a dispatch is not called afterwards in that dispatch. Both
 * match the behaviour of `src/core/events.js`, so the two feel the same from the outside.
 */

import { createLogger } from '../core/log.js';

/** @typedef {import('../core/types.js').GameState} GameState */
/** @typedef {import('../core/types.js').Action} Action */

/**
 * @template S
 * @typedef {Object} Store
 * @property {() => Readonly<S>} getState the live state object — read only, never mutate it
 * @property {(action: Action|{type:string}) => void} dispatch run an action through the reducer
 * @property {(fn: (state: Readonly<S>, action: Action|{type:string}) => void) => (() => void)} subscribe
 *   register a listener; returns an idempotent unsubscribe
 */

const log = createLogger('store');

/**
 * Hard cap on actions *pending* at any moment during a single dispatch. Bounds memory when a
 * listener fans out into many actions at once.
 */
const MAX_QUEUE = 256;

/**
 * Hard cap on actions *drained* by one outer `dispatch`. This is the one that matters: a reducer
 * or subscriber that dispatches exactly one action every time keeps the pending depth at 1 forever,
 * so only a total budget can stop the loop. Reaching it drops the queue and reports the problem
 * rather than hanging the frame.
 */
const MAX_CHAIN = 4096;

/**
 * Create a store around a state object and a mutating reducer.
 *
 * @template {object} S
 * @param {S} initial the state object the store will own (it is not copied)
 * @param {(state: S, action: any) => void} reducer mutates `state` in place
 * @returns {Store<S>}
 * @throws {TypeError} if `initial` is not an object or `reducer` is not a function
 */
export function createStore(initial, reducer) {
  if (initial === null || typeof initial !== 'object') {
    throw new TypeError('createStore: initial state must be an object');
  }
  if (typeof reducer !== 'function') {
    throw new TypeError('createStore: reducer must be a function');
  }

  const state = initial;
  /** Live listeners; removed entries become null and are compacted between dispatches. */
  const listeners = /** @type {Array<((s:any, a:any) => void)|null>} */ ([]);
  /** Pending actions dispatched during a dispatch. */
  const queue = /** @type {any[]} */ ([]);
  let queueHead = 0;
  let dispatching = false;
  let holes = 0;

  /**
   * Remove tombstoned listeners. Only ever runs outside a dispatch, so indices can shift safely.
   * @returns {void}
   */
  function compact() {
    if (holes === 0) return;
    let w = 0;
    for (let i = 0; i < listeners.length; i++) {
      const fn = listeners[i];
      if (fn !== null) listeners[w++] = fn;
    }
    listeners.length = w;
    holes = 0;
  }

  /**
   * Run one action through the reducer and notify listeners.
   * @param {any} action
   * @returns {void}
   */
  function run(action) {
    try {
      reducer(state, action);
    } catch (err) {
      // Swallowing keeps the loop alive; the entry lands in window.__game.errors for tools.
      log.error('reducer threw for action', action && action.type, err);
    }
    // Snapshot the length, not the array: listeners added by a listener run from the next action.
    const n = listeners.length;
    for (let i = 0; i < n; i++) {
      const fn = listeners[i];
      if (fn === null) continue;
      try {
        fn(state, action);
      } catch (err) {
        log.error('store subscriber threw for action', action && action.type, err);
      }
    }
  }

  return {
    getState() {
      return /** @type {Readonly<S>} */ (state);
    },

    dispatch(action) {
      if (action === null || typeof action !== 'object' || typeof (/** @type {any} */ (action).type) !== 'string') {
        log.warn('dispatch ignored: action must be an object with a string `type`');
        return;
      }
      if (dispatching) {
        // Re-entrant dispatch: queue it so the current action completes atomically.
        if (queue.length - queueHead >= MAX_QUEUE) {
          log.error('dispatch queue overflow; dropping action', /** @type {any} */ (action).type);
          return;
        }
        queue.push(action);
        return;
      }
      dispatching = true;
      try {
        run(action);
        let drained = 0;
        while (queueHead < queue.length) {
          if (++drained > MAX_CHAIN) {
            log.error('dispatch chain exceeded', MAX_CHAIN, 'actions; dropping the queue');
            break;
          }
          const next = queue[queueHead];
          queue[queueHead] = undefined; // release the reference as we go
          queueHead++;
          run(next);
        }
      } finally {
        queue.length = 0;
        queueHead = 0;
        dispatching = false;
        compact();
      }
    },

    subscribe(fn) {
      if (typeof fn !== 'function') {
        throw new TypeError('store.subscribe: listener must be a function');
      }
      listeners.push(fn);
      let live = true;
      return function unsubscribe() {
        if (!live) return; // idempotent
        live = false;
        const i = listeners.indexOf(fn);
        if (i >= 0) {
          // Tombstone rather than splice: a dispatch may be iterating this array right now.
          listeners[i] = null;
          holes++;
          if (!dispatching) compact();
        }
      };
    },
  };
}
