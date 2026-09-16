// @ts-check
/**
 * @file Tagged logging that is silent in production and an error ring buffer for tooling.
 *
 * Rules this implements (ARCHITECTURE.md §4.1):
 * - `?debug=1` (or `AMAZE_DEBUG=1` in Node) routes `debug/info/warn/error` to the console with a
 *   `[tag]` prefix. Without it the console is **completely silent** — a shipped game that chatters
 *   in the console looks broken, and `tools/verify.mjs` asserts zero console errors.
 * - Errors are always captured into a bounded ring buffer regardless of the debug flag, so
 *   `window.__game.errors` can be inspected after the fact by the headless verifier.
 *
 * Cost when disabled: the logger's methods are swapped for a shared no-op with a fixed arity, so a
 * disabled `log.debug(...)` call site does not build an arguments array — safe to leave in hot
 * paths. `log.enabled` lets callers skip expensive message construction entirely.
 */

/** Maximum entries kept in the error ring buffer; oldest are dropped first. */
const ERROR_CAPACITY = 64;

/** Maximum characters of a single formatted message (defends against dumping a whole maze). */
const MAX_MESSAGE_CHARS = 400;

/**
 * One captured error. Timestamps are milliseconds from the monotonic clock (`performance.now`
 * where available), so they line up with `FrameStats` timings.
 * @typedef {Object} ErrorEntry
 * @property {number} t        ms since page/process start
 * @property {string} tag      logger tag that reported it
 * @property {string} message  formatted message (arguments joined with a space)
 * @property {string} stack    stack trace of the first Error argument, or '' if none
 * @property {number} count    consecutive identical repeats collapsed into this entry (≥ 1)
 */

/**
 * A tagged logger. The four level methods accept any arguments (formatted lazily).
 * @typedef {Object} Logger
 * @property {string} tag
 * @property {boolean} enabled              true while debug output is on (read-only mirror)
 * @property {(...args:any[]) => void} debug
 * @property {(...args:any[]) => void} info
 * @property {(...args:any[]) => void} warn
 * @property {(...args:any[]) => void} error always recorded in the ring buffer
 */

/**
 * Live, chronologically ordered error ring buffer. Exported as a stable array reference so the
 * composition root can expose it directly (`window.__game.errors = errors`) before any error has
 * happened. Treat it as read-only; use `clearErrors()` to empty it.
 * @type {ErrorEntry[]}
 */
export const errors = [];

/** Every logger ever created, so `setDebug` can re-bind their methods. */
const loggers = new Set();

/** Shared no-op. Declared with no parameters so calls with arguments allocate nothing. */
const noop = () => {};

let debugEnabled = detectDebug();

/** Lazily created logger used by `installGlobalErrorCapture`. @type {Logger|null} */
let windowLogger = null;

/**
 * Detect the debug flag from the URL (`?debug=1`) in a browser or `AMAZE_DEBUG=1` in Node.
 * Every access is guarded: this module is imported by Node tools, workers and sandboxed iframes
 * where `location`, `URLSearchParams` or `process` may be missing or throw.
 * @returns {boolean}
 */
function detectDebug() {
  try {
    const loc = /** @type {any} */ (globalThis).location;
    if (loc && typeof loc.search === 'string' && loc.search.length > 1) {
      const v = new URLSearchParams(loc.search).get('debug');
      if (v !== null) return v !== '0' && v !== 'false';
    }
  } catch {
    // Unparseable location (e.g. some srcdoc iframes): fall through to the env check.
  }
  try {
    const env = /** @type {any} */ (globalThis).process?.env;
    if (env && (env.AMAZE_DEBUG === '1' || env.AMAZE_DEBUG === 'true')) return true;
  } catch {
    // No `process`, or a getter that throws: debug stays off.
  }
  return false;
}

/** Monotonic ms clock, mirroring loop.js's preference for `performance.now`. @returns {number} */
function nowMs() {
  const perf = /** @type {any} */ (globalThis).performance;
  return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
}

/**
 * Format one logged argument into a short, safe string. Never throws: a getter that explodes or a
 * cyclic object degrades to a placeholder rather than taking down the caller.
 * @param {unknown} v
 * @returns {string}
 */
function formatArg(v) {
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    const json = JSON.stringify(v);
    if (typeof json === 'string') return json;
    return String(v);
  } catch {
    // Cyclic structures, BigInt fields, throwing toJSON — a tag is more useful than a crash.
    return Object.prototype.toString.call(v);
  }
}

/**
 * Join arguments into one message, truncated to `MAX_MESSAGE_CHARS`.
 * @param {any[]} args
 * @returns {string}
 */
function formatMessage(args) {
  let out = '';
  for (let i = 0; i < args.length; i++) {
    if (i > 0) out += ' ';
    out += formatArg(args[i]);
    if (out.length > MAX_MESSAGE_CHARS) return out.slice(0, MAX_MESSAGE_CHARS) + '…';
  }
  return out;
}

/**
 * Record an error in the ring buffer. Consecutive identical messages from the same tag are
 * collapsed into one entry with a `count`, so a failure that repeats every frame cannot flush the
 * buffer's history away.
 * @param {string} tag
 * @param {any[]} args
 * @returns {void}
 */
function recordError(tag, args) {
  const message = formatMessage(args);
  let stack = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a instanceof Error && typeof a.stack === 'string') {
      stack = a.stack.length > 1200 ? a.stack.slice(0, 1200) + '…' : a.stack;
      break;
    }
  }
  const last = errors.length > 0 ? errors[errors.length - 1] : null;
  if (last && last.tag === tag && last.message === message) {
    last.count++;
    last.t = nowMs();
    return;
  }
  errors.push({ t: nowMs(), tag, message, stack, count: 1 });
  if (errors.length > ERROR_CAPACITY) errors.splice(0, errors.length - ERROR_CAPACITY);
}

/**
 * Point a logger's methods at either the console (debug on) or the no-op (debug off).
 * @param {Logger} logger
 * @returns {void}
 */
function bind(logger) {
  const tag = logger.tag;
  const prefix = `[${tag}]`;
  logger.enabled = debugEnabled;
  const c = /** @type {any} */ (globalThis).console;
  if (debugEnabled && c) {
    const out = typeof c.debug === 'function' ? c.debug : c.log;
    logger.debug = (...args) => out.call(c, prefix, ...args);
    logger.info = (...args) => (c.info || c.log).call(c, prefix, ...args);
    logger.warn = (...args) => (c.warn || c.log).call(c, prefix, ...args);
    logger.error = (...args) => {
      recordError(tag, args);
      (c.error || c.log).call(c, prefix, ...args);
    };
  } else {
    logger.debug = noop;
    logger.info = noop;
    logger.warn = noop;
    // Errors are captured even when silent — that is the whole point of the ring buffer.
    logger.error = (...args) => recordError(tag, args);
  }
}

/**
 * Create a tagged logger. Loggers are cheap; create one per module at import time and keep it.
 * @param {string} tag short module name, e.g. 'loop'
 * @returns {Logger}
 */
export function createLogger(tag) {
  /** @type {Logger} */
  const logger = {
    tag: String(tag || 'game'),
    enabled: debugEnabled,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  bind(logger);
  loggers.add(logger);
  return logger;
}

/**
 * Turn debug output on/off at runtime (used by tests and by an in-game debug toggle). Errors keep
 * being recorded either way.
 * @param {boolean} on
 * @returns {void}
 */
export function setDebug(on) {
  const next = !!on;
  if (next === debugEnabled) return;
  debugEnabled = next;
  for (const logger of loggers) bind(logger);
}

/** @returns {boolean} whether debug output is currently on */
export function isDebug() {
  return debugEnabled;
}

/**
 * Empty the error ring buffer in place (keeping the exported array identity).
 * @returns {void}
 */
export function clearErrors() {
  errors.length = 0;
}

/**
 * Capture uncaught errors and unhandled promise rejections into the ring buffer. The composition
 * root calls this once at boot so the headless verifier sees failures that happen outside our own
 * try/catch. Safe to call in Node (no-op when the target has no `addEventListener`).
 * @param {{addEventListener?:Function, removeEventListener?:Function}} [target=globalThis]
 * @returns {() => void} uninstall function (idempotent)
 */
export function installGlobalErrorCapture(target = /** @type {any} */ (globalThis)) {
  const t = /** @type {any} */ (target);
  if (!t || typeof t.addEventListener !== 'function') return noop;
  // Reuse one logger across calls so repeated install/uninstall cycles cannot grow the registry.
  const log = (windowLogger ||= createLogger('window'));

  /** @param {any} ev */
  const onErrorEvent = (ev) => {
    const err = ev && ev.error instanceof Error ? ev.error : null;
    const where = ev && ev.filename ? ` (${ev.filename}:${ev.lineno ?? 0})` : '';
    log.error(`uncaught: ${(ev && ev.message) || 'unknown error'}${where}`, err);
  };
  /** @param {any} ev */
  const onRejection = (ev) => {
    const reason = ev ? ev.reason : undefined;
    log.error('unhandled rejection:', reason instanceof Error ? reason : formatArg(reason));
  };

  t.addEventListener('error', onErrorEvent);
  t.addEventListener('unhandledrejection', onRejection);

  let removed = false;
  return () => {
    if (removed || typeof t.removeEventListener !== 'function') return;
    removed = true;
    t.removeEventListener('error', onErrorEvent);
    t.removeEventListener('unhandledrejection', onRejection);
  };
}
