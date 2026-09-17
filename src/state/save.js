// @ts-check
/**
 * @file Persistence for what is worth keeping between sessions — the best score, the user's
 * settings and the unlock progression (ARCHITECTURE.md §4.2, §4.9).
 *
 * Everything here is defensive on purpose. `localStorage` can be absent (Node, a worker), can
 * throw on *access* (a sandboxed iframe, Safari with cookies blocked), can throw on write (quota
 * exceeded, private mode), and can contain anything at all (another game on the same origin, an
 * older build, a user editing devtools). None of that may stop the game booting, so every path
 * degrades to factory defaults and reports `false` rather than throwing.
 *
 * ## Key / versioning
 * The key is `amaze.v1` and the payload carries `v: 1`. Bump **both** if the stored shape changes
 * incompatibly or if the RNG stream changes — stored seeds replay differently after an RNG change,
 * so an old record would refer to a maze that no longer exists. `progress` was added *inside*
 * version 1 on purpose: it is optional, a record without it loads empty progress, and bumping the
 * version would have wiped every existing player's best score and settings for nothing.
 */

import { createLogger } from '../core/log.js';
import { defaultProgress, defaultSettings, sanitizeBest, sanitizeProgress, sanitizeSettings } from './balance.js';
import { sanitizeRunSave } from './runsave.js';

/** @typedef {import('../core/types.js').Settings} Settings */
/** @typedef {import('../core/types.js').BestScore} BestScore */
/** @typedef {import('../core/types.js').Progress} Progress */

/**
 * The minimal slice of the Web Storage API this module uses. Declared structurally so tests (and
 * any future backend) can pass a plain object.
 * @typedef {Object} StorageLike
 * @property {(key: string) => string|null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 */

/**
 * What is persisted, and what `loadPersist` always returns (fully populated, always valid).
 * @typedef {{best: BestScore, settings: Settings, progress: Progress}} Persist
 */

const log = createLogger('save');

/** Storage key (ARCHITECTURE.md §4.2). Bump with `PERSIST_VERSION`. */
export const PERSIST_KEY = 'amaze.v1';

/** Payload schema version stored inside the record. */
export const PERSIST_VERSION = 1;

/**
 * Upper bound on the serialised payload, in characters. The real record is ~550 chars with every
 * unlock listed; anything
 * this large is corruption or someone else's data under our key, and parsing it is a waste of a
 * frame during boot.
 */
const MAX_PAYLOAD_CHARS = 4096;

/**
 * The ambient `localStorage`, or `null` when there is none or touching it throws.
 *
 * Resolved on every call rather than cached at module load: `src/state` must import cleanly in
 * Node, and a cached probe would also miss a storage that becomes available later.
 * @returns {StorageLike|null}
 */
export function getDefaultStorage() {
  try {
    // `globalThis.localStorage` can throw on mere access in a sandboxed iframe, hence the try.
    const ls = /** @type {any} */ (globalThis).localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
      return /** @type {StorageLike} */ (ls);
    }
  } catch (err) {
    log.debug('localStorage unavailable', err);
  }
  return null;
}

/**
 * Fresh factory-default persist record.
 * @returns {Persist}
 */
export function defaultPersist() {
  return { best: { score: 0, level: 0 }, settings: defaultSettings(), progress: defaultProgress() };
}

/**
 * Load the persisted best score and settings.
 *
 * Always returns a complete, valid `Persist`: missing storage, absent key, non-JSON text, a JSON
 * value that is not an object, a version mismatch, or individual fields out of range all fall
 * back to factory defaults (per field, so one bad setting does not discard the rest).
 *
 * @param {StorageLike|null} [storage] storage to read from; defaults to `localStorage` when present
 * @returns {Persist} never null, never partial
 */
export function loadPersist(storage) {
  const out = defaultPersist();
  const store = storage === undefined ? getDefaultStorage() : storage;
  if (store === null || typeof store.getItem !== 'function') return out;

  /** @type {string|null} */
  let raw = null;
  try {
    raw = store.getItem(PERSIST_KEY);
  } catch (err) {
    log.debug('read failed', err);
    return out;
  }
  if (typeof raw !== 'string' || raw.length === 0) return out;
  if (raw.length > MAX_PAYLOAD_CHARS) {
    log.warn('persisted record is implausibly large; ignoring it');
    return out;
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('persisted record is not valid JSON; using defaults', err);
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;

  const rec = /** @type {Record<string, unknown>} */ (parsed);
  if (rec.v !== PERSIST_VERSION) {
    // A record from another schema version is dropped, not migrated: there is only one version.
    log.info('persisted record version mismatch; using defaults');
    return out;
  }
  out.best = sanitizeBest(rec.best);
  out.settings = sanitizeSettings(rec.settings);
  out.progress = sanitizeProgress(rec.progress);
  return out;
}

/**
 * Persist the best score and settings.
 *
 * The record is sanitised before writing, so a corrupted in-memory state cannot be laundered into
 * storage; the write itself is wrapped because quota errors are routine in private-browsing modes.
 *
 * @param {{best?: unknown, settings?: unknown, progress?: unknown}|null|undefined} data typically
 *   `{best, settings, progress}`; an omitted `progress` keeps the progress already stored
 * @param {StorageLike|null} [storage] storage to write to; defaults to `localStorage` when present
 * @returns {boolean} true when the record was written
 */
export function savePersist(data, storage) {
  const store = storage === undefined ? getDefaultStorage() : storage;
  if (store === null || typeof store.setItem !== 'function') return false;

  const src = data === null || typeof data !== 'object' ? {} : data;
  // A caller that does not mention progress keeps what is stored: writing empty progress would wipe
  // a player's purse and unlocks from any save path that only meant to store a setting.
  const progress = src.progress === undefined ? loadPersist(store).progress : sanitizeProgress(src.progress);
  const record = {
    v: PERSIST_VERSION,
    best: sanitizeBest(src.best),
    settings: sanitizeSettings(src.settings),
    progress,
  };
  try {
    store.setItem(PERSIST_KEY, JSON.stringify(record));
    return true;
  } catch (err) {
    // Quota exceeded / storage disabled mid-session: the game carries on, unsaved.
    log.warn('persist failed', err);
    return false;
  }
}

// ─── Saved runs (ARCHITECTURE.md §4.10) ──────────────────────────────────────────────────────

/**
 * Storage key for the one saved run. Separate from `PERSIST_KEY` on purpose: the run save is tens of
 * kilobytes at the size cap and is rewritten on every pause, and the settings/progress record must
 * never be lost to a quota error on it (or parsed through it at boot).
 */
export const RUN_KEY = 'amaze.run.v1';

/**
 * Upper bound on a saved run, in characters. The cap level's save is ~11.5 kB; the generator's
 * 4096² limit would be ~2.8 MB, far past anything the level curve builds.
 */
const MAX_RUN_CHARS = 3 * 1024 * 1024;

/**
 * Load the saved run, if there is a valid one.
 * @param {StorageLike|null} [storage]
 * @returns {import('./runsave.js').RunSave|null}
 */
export function loadRun(storage) {
  const store = storage === undefined ? getDefaultStorage() : storage;
  if (store === null || typeof store.getItem !== 'function') return null;
  /** @type {string|null} */
  let raw = null;
  try {
    raw = store.getItem(RUN_KEY);
  } catch (err) {
    log.debug('run read failed', err);
    return null;
  }
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RUN_CHARS) return null;
  try {
    return sanitizeRunSave(JSON.parse(raw));
  } catch (err) {
    log.warn('saved run is not valid JSON; ignoring it', err);
    return null;
  }
}

/**
 * Write the saved run (replacing any previous one). The save is sanitised first, so an in-memory
 * snapshot that is somehow malformed is refused rather than stored.
 * @param {unknown} save a `RunSave` from `snapshotMidLevel` / `snapshotCheckpoint`
 * @param {StorageLike|null} [storage]
 * @returns {boolean} true when it was written
 */
export function saveRun(save, storage) {
  const store = storage === undefined ? getDefaultStorage() : storage;
  if (store === null || typeof store.setItem !== 'function') return false;
  const clean = sanitizeRunSave(save);
  if (clean === null) {
    log.warn('saveRun refused a malformed snapshot');
    return false;
  }
  try {
    store.setItem(RUN_KEY, JSON.stringify(clean));
    return true;
  } catch (err) {
    log.warn('run save failed', err);
    return false;
  }
}

/**
 * Delete the saved run (the run ended, or a new one replaced it).
 * @param {StorageLike|null} [storage]
 * @returns {boolean} true when the key was removed
 */
export function clearRun(storage) {
  const store = storage === undefined ? getDefaultStorage() : storage;
  if (store === null || typeof store.removeItem !== 'function') return false;
  try {
    store.removeItem(RUN_KEY);
    return true;
  } catch (err) {
    log.warn('run clear failed', err);
    return false;
  }
}

/**
 * Remove the persisted record (used by a "reset progress" control and by tests).
 * @param {StorageLike|null} [storage]
 * @returns {boolean} true when the key was removed
 */
export function clearPersist(storage) {
  const store = storage === undefined ? getDefaultStorage() : storage;
  if (store === null || typeof store.removeItem !== 'function') return false;
  try {
    store.removeItem(PERSIST_KEY);
    return true;
  } catch (err) {
    log.warn('clear failed', err);
    return false;
  }
}
