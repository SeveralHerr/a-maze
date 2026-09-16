// @ts-check
/**
 * Unit tests for src/core/log.js — run with `node src/core/log.test.mjs`.
 * Two promises are load-bearing for the shipped game: absolute console silence without `?debug=1`
 * (tools/verify.mjs fails the build on any console error) and an error ring buffer that survives
 * a failure storm without losing its history.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearErrors, createLogger, errors, installGlobalErrorCapture, isDebug, setDebug } from './log.js';

/**
 * Run `fn` with the console replaced by a recorder.
 * @param {(calls:Array<[string, any[]]>) => void} fn
 * @returns {void}
 */
function withCapturedConsole(fn) {
  /** @type {Array<[string, any[]]>} */
  const calls = [];
  const real = { debug: console.debug, log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const level of /** @type {const} */ (['debug', 'log', 'info', 'warn', 'error'])) {
    console[level] = (...args) => calls.push([level, args]);
  }
  try {
    fn(calls);
  } finally {
    Object.assign(console, real);
  }
}

test('loggers are completely silent when debug is off', () => {
  setDebug(false);
  clearErrors();
  withCapturedConsole((calls) => {
    const log = createLogger('silent');
    assert.equal(log.enabled, false);
    log.debug('a', 1);
    log.info('b');
    log.warn('c');
    log.error('d');
    assert.deepEqual(calls, [], 'a shipped build must not write to the console at all');
  });
  assert.equal(errors.length, 1, 'errors are still captured for the headless verifier');
  clearErrors();
});

test('debug mode routes every level to the console with a [tag] prefix', () => {
  clearErrors();
  withCapturedConsole((calls) => {
    const log = createLogger('boot');
    setDebug(true);
    assert.equal(isDebug(), true);
    assert.equal(log.enabled, true, 'existing loggers are re-bound when the flag flips');
    log.debug('starting');
    log.info('ready');
    log.warn('slow');
    log.error('broken');
    assert.equal(calls.length, 4);
    for (const [, args] of calls) assert.equal(args[0], '[boot]');
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['debug', 'info', 'warn', 'error'],
    );
    setDebug(false);
    log.debug('quiet again');
    assert.equal(calls.length, 4);
    assert.equal(log.enabled, false);
  });
  assert.equal(errors.length, 1, 'the error was recorded exactly once, not twice');
  clearErrors();
});

test('error entries carry tag, message, stack and timestamp', () => {
  setDebug(false);
  clearErrors();
  const log = createLogger('sim');
  const err = new Error('collision exploded');
  log.error('step failed', err, { tile: 12 });
  assert.equal(errors.length, 1);
  const e = errors[0];
  assert.equal(e.tag, 'sim');
  assert.equal(e.message, 'step failed Error: collision exploded {"tile":12}');
  assert.match(e.stack, /collision exploded/);
  assert.ok(e.t >= 0 && Number.isFinite(e.t));
  assert.equal(e.count, 1);
  clearErrors();
});

test('consecutive identical errors collapse instead of flushing the history', () => {
  setDebug(false);
  clearErrors();
  const log = createLogger('loop');
  log.error('first');
  for (let i = 0; i < 5000; i++) log.error('every frame'); // a failure that repeats per frame
  assert.equal(errors.length, 2, 'the storm collapses into a single counted entry');
  assert.equal(errors[0].message, 'first', 'the original failure is still there');
  assert.equal(errors[1].count, 5000);
  log.error('different');
  assert.equal(errors.length, 3);
  clearErrors();
});

test('the ring buffer is bounded and keeps the newest entries', () => {
  setDebug(false);
  clearErrors();
  const log = createLogger('flood');
  for (let i = 0; i < 500; i++) log.error(`failure ${i}`);
  assert.equal(errors.length, 64, 'capacity is bounded so a long soak cannot leak memory');
  assert.equal(errors[errors.length - 1].message, 'failure 499');
  assert.equal(errors[0].message, 'failure 436');
  clearErrors();
  assert.equal(errors.length, 0);
});

test('message formatting never throws on hostile values', () => {
  setDebug(false);
  clearErrors();
  const log = createLogger('fmt');
  /** @type {any} */
  const cyclic = { name: 'maze' };
  cyclic.self = cyclic;
  const hostile = {
    get boom() {
      throw new Error('getter exploded');
    },
  };
  log.error('values:', cyclic, hostile, undefined, null, 42, true, 9007199254740993n, Symbol('s'));
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.length > 0);
  // Long messages are truncated so one entry cannot hold a whole maze dump.
  log.error('x'.repeat(5000));
  assert.ok(errors[1].message.length <= 401, `message not truncated: ${errors[1].message.length}`);
  clearErrors();
});

test('installGlobalErrorCapture records window errors and rejections, and uninstalls cleanly', () => {
  setDebug(false);
  clearErrors();
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  const fakeWindow = {
    /** @param {string} type @param {Function} fn */
    addEventListener(type, fn) {
      const l = listeners.get(type) || [];
      l.push(fn);
      listeners.set(type, l);
    },
    /** @param {string} type @param {Function} fn */
    removeEventListener(type, fn) {
      const l = listeners.get(type) || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    /** @param {string} type @param {any} ev */
    fire(type, ev) {
      for (const fn of (listeners.get(type) || []).slice()) fn(ev);
    },
  };

  const uninstall = installGlobalErrorCapture(fakeWindow);
  fakeWindow.fire('error', { message: 'boom', filename: 'src/main.js', lineno: 12, error: new Error('boom') });
  fakeWindow.fire('unhandledrejection', { reason: new Error('promise died') });
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /uncaught: boom \(src\/main\.js:12\)/);
  assert.match(errors[0].stack, /boom/);
  assert.match(errors[1].message, /unhandled rejection/);

  uninstall();
  uninstall(); // idempotent
  fakeWindow.fire('error', { message: 'after uninstall' });
  assert.equal(errors.length, 2, 'no listeners remain after uninstall');
  assert.equal([...listeners.values()].flat().length, 0);
  clearErrors();

  // A target without addEventListener (plain Node global) is a safe no-op.
  assert.equal(typeof installGlobalErrorCapture(/** @type {any} */ ({})), 'function');
});

test('logging with debug off is cheap enough for hot paths', () => {
  setDebug(false);
  const log = createLogger('hot');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1e6; i++) log.debug('never formatted', i, { skipped: true });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 250, `1e6 disabled log calls took ${ms.toFixed(1)} ms`);
});
