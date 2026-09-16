// @ts-check
/**
 * @file Minimal typed event emitter used for cross-cutting notifications (settings changed,
 * level built, audio unlocked). Per-step gameplay events travel through `GameState.events`
 * instead — this emitter is for one-off signals, not for the hot event stream.
 *
 * Design notes:
 * - **Emitting allocates nothing.** Listener lists are plain arrays of small records; `emit`
 *   walks the live array and skips records that were detached.
 * - **Mutation during emit is safe and predictable.** A listener removed during dispatch is *not*
 *   called afterwards in that same dispatch (unlike the DOM and Node, which iterate a snapshot
 *   taken up front), and a listener added during dispatch is not called until the next emit.
 *   Lists are compacted only after the outermost dispatch returns, so indices never shift under
 *   the loop — the classic "removing a listener skips the next one" bug is structurally absent.
 * - **One throwing listener cannot starve the others.** Exceptions are caught, reported through
 *   the core error ring buffer (or a supplied `onError`), and the remaining listeners still run.
 */

import { createLogger } from './log.js';

/**
 * @template {Record<string, any>} M event map: type name → payload type
 * @typedef {Object} Emitter
 * @property {<K extends keyof M & string>(type:K, fn:(payload:M[K]) => void) => (() => void)} on
 *   subscribe; returns an unsubscribe function (idempotent)
 * @property {<K extends keyof M & string>(type:K, fn:(payload:M[K]) => void) => (() => void)} once
 *   subscribe for a single delivery
 * @property {<K extends keyof M & string>(type:K, fn:(payload:M[K]) => void) => void} off
 * @property {<K extends keyof M & string>(type:K, payload:M[K]) => void} emit
 * @property {(type?:string) => void} clear   remove listeners of one type, or all of them
 * @property {(type?:string) => number} count live listeners of one type, or of all types
 */

/**
 * @typedef {Object} ListenerRecord
 * @property {Function|null} fn  the callback, or null once detached
 * @property {boolean} once
 */

/** Shared no-op, returned when a non-function is passed to `on`/`once`. */
const noop = () => {};

/**
 * Create an emitter.
 *
 * The optional type parameter is erased at runtime; annotate the variable with
 * `Emitter<{levelReady: LevelData, muted: boolean}>` to get checked event names and payloads.
 * @template {Record<string, any>} [M=Record<string, any>]
 * @param {{onError?:(err:unknown, type:string) => void}} [options]
 * @returns {Emitter<M>}
 */
export function createEmitter(options) {
  /** @type {Map<string, ListenerRecord[]>} */
  const map = new Map();
  const log = createLogger('events');
  const onError =
    options && typeof options.onError === 'function'
      ? options.onError
      : /** @param {unknown} err @param {string} type */ (err, type) =>
          log.error(`listener for "${type}" threw`, err);

  /** Nesting depth of `emit`; while > 0, detached records are nulled but kept in place. */
  let depth = 0;
  /** Set when a detach happened during dispatch, so the lists are compacted afterwards. */
  let needsCompact = false;

  /**
   * @param {string} type
   * @param {Function} fn
   * @param {boolean} once
   * @returns {() => void} unsubscribe
   */
  function add(type, fn, once) {
    if (typeof fn !== 'function') return noop;
    let list = map.get(type);
    if (list === undefined) {
      list = [];
      map.set(type, list);
    }
    // Registering the same callback twice for one type is a bug (it would fire twice while a
    // single `off` could only remove one), so registration is idempotent.
    for (let i = 0; i < list.length; i++) {
      const existing = list[i];
      if (existing.fn === fn) return () => detach(type, existing);
    }
    /** @type {ListenerRecord} */
    const rec = { fn, once };
    list.push(rec);
    return () => detach(type, rec);
  }

  /**
   * Detach one record. Nulling `fn` is what makes removal take effect immediately, even mid-emit;
   * the array slot is reclaimed by `compact()` once dispatch has unwound.
   * @param {string} type
   * @param {ListenerRecord} rec
   * @returns {void}
   */
  function detach(type, rec) {
    if (rec.fn === null) return;
    rec.fn = null;
    if (depth > 0) {
      needsCompact = true;
      return;
    }
    const list = map.get(type);
    if (list === undefined) return;
    const i = list.indexOf(rec);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) map.delete(type);
  }

  /**
   * Drop nulled records from every list. Runs at most once per outermost emit, and only when
   * something was actually removed during it. In-place, so it allocates nothing.
   * @returns {void}
   */
  function compact() {
    needsCompact = false;
    for (const [type, list] of map) {
      let w = 0;
      for (let r = 0; r < list.length; r++) {
        if (list[r].fn !== null) list[w++] = list[r];
      }
      if (w === list.length) continue;
      list.length = w;
      if (w === 0) map.delete(type);
    }
  }

  return /** @type {Emitter<M>} */ ({
    /** @param {string} type @param {Function} fn @returns {() => void} */
    on(type, fn) {
      return add(String(type), fn, false);
    },
    /** @param {string} type @param {Function} fn @returns {() => void} */
    once(type, fn) {
      return add(String(type), fn, true);
    },
    /** @param {string} type @param {Function} fn @returns {void} */
    off(type, fn) {
      const key = String(type);
      const list = map.get(key);
      if (list === undefined) return;
      for (let i = 0; i < list.length; i++) {
        if (list[i].fn === fn) {
          detach(key, list[i]);
          return;
        }
      }
    },
    /** @param {string} type @param {any} payload @returns {void} */
    emit(type, payload) {
      const list = map.get(type);
      if (list === undefined || list.length === 0) return;
      depth++;
      // `n` is fixed up front: listeners added by a listener run on the next emit, not this one.
      const n = list.length;
      for (let i = 0; i < n; i++) {
        const rec = list[i];
        const fn = rec.fn;
        if (fn === null) continue; // detached before we reached it
        if (rec.once) detach(type, rec);
        try {
          fn(payload);
        } catch (err) {
          onError(err, type);
        }
      }
      depth--;
      if (depth === 0 && needsCompact) compact();
    },
    /** @param {string} [type] @returns {void} */
    clear(type) {
      if (type === undefined) {
        for (const list of map.values()) {
          for (let i = 0; i < list.length; i++) list[i].fn = null;
        }
        if (depth > 0) needsCompact = true;
        else map.clear();
        return;
      }
      const list = map.get(type);
      if (list === undefined) return;
      for (let i = 0; i < list.length; i++) list[i].fn = null;
      if (depth > 0) needsCompact = true;
      else map.delete(type);
    },
    /** @param {string} [type] @returns {number} */
    count(type) {
      let n = 0;
      if (type !== undefined) {
        const list = map.get(type);
        if (list === undefined) return 0;
        for (let i = 0; i < list.length; i++) if (list[i].fn !== null) n++;
        return n;
      }
      for (const list of map.values()) {
        for (let i = 0; i < list.length; i++) if (list[i].fn !== null) n++;
      }
      return n;
    },
  });
}
