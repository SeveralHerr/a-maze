// @ts-check
/**
 * Unit tests for src/core/events.js — run with `node src/core/events.test.mjs`.
 * The interesting cases are all about mutation during dispatch, which is where hand-rolled
 * emitters usually break (skipping a listener after a removal, or calling a detached one).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createEmitter } from './events.js';
import { clearErrors, errors } from './log.js';

test('on/emit delivers the payload to every listener, in registration order', () => {
  const bus = createEmitter();
  /** @type {string[]} */
  const seen = [];
  bus.on('ping', (v) => seen.push(`a:${v}`));
  bus.on('ping', (v) => seen.push(`b:${v}`));
  bus.emit('ping', 7);
  assert.deepEqual(seen, ['a:7', 'b:7']);
  bus.emit('other', 1); // unknown type is a silent no-op
  assert.deepEqual(seen, ['a:7', 'b:7']);
});

test('the unsubscribe function returned by on() removes exactly that listener', () => {
  const bus = createEmitter();
  let a = 0;
  let b = 0;
  const offA = bus.on('t', () => a++);
  bus.on('t', () => b++);
  bus.emit('t', null);
  offA();
  offA(); // idempotent
  bus.emit('t', null);
  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.equal(bus.count('t'), 1);
});

test('off() removes by reference and tolerates unknown types and functions', () => {
  const bus = createEmitter();
  let n = 0;
  const fn = () => n++;
  bus.on('t', fn);
  bus.off('t', () => {}); // not registered
  bus.off('nope', fn); // unknown type
  bus.emit('t', null);
  bus.off('t', fn);
  bus.emit('t', null);
  assert.equal(n, 1);
  assert.equal(bus.count(), 0);
});

test('registering the same function twice for one type is idempotent', () => {
  const bus = createEmitter();
  let n = 0;
  const fn = () => n++;
  const off1 = bus.on('t', fn);
  const off2 = bus.on('t', fn);
  assert.equal(bus.count('t'), 1);
  bus.emit('t', null);
  assert.equal(n, 1);
  off2();
  bus.emit('t', null);
  assert.equal(n, 1, 'either unsubscribe handle removes the single registration');
  off1();
});

test('once() fires exactly once, even when it re-emits its own type', () => {
  const bus = createEmitter();
  let n = 0;
  bus.once('t', () => {
    n++;
    if (n < 5) bus.emit('t', null); // re-entrant emit must not re-deliver
  });
  bus.emit('t', null);
  assert.equal(n, 1);
  assert.equal(bus.count('t'), 0);
  bus.emit('t', null);
  assert.equal(n, 1);
});

test('a listener removed during dispatch is not called in that same dispatch', () => {
  const bus = createEmitter();
  /** @type {string[]} */
  const seen = [];
  /** @type {() => void} */
  let removeB = () => {};
  bus.on('t', () => {
    seen.push('a');
    removeB(); // b is still ahead of us in the list
  });
  removeB = bus.on('t', () => seen.push('b'));
  bus.on('t', () => seen.push('c'));

  bus.emit('t', null);
  assert.deepEqual(seen, ['a', 'c'], 'b was removed before it was reached');
  assert.equal(bus.count('t'), 2, 'the list is compacted after dispatch');
  seen.length = 0;
  bus.emit('t', null);
  assert.deepEqual(seen, ['a', 'c']);
});

test('a listener that removes itself does not skip the next listener', () => {
  // The classic splice-during-iteration bug: removing the current element shifts the rest down.
  const bus = createEmitter();
  /** @type {string[]} */
  const seen = [];
  /** @type {() => void} */
  let offSelf = () => {};
  offSelf = bus.on('t', () => {
    seen.push('self');
    offSelf();
  });
  bus.on('t', () => seen.push('next'));
  bus.on('t', () => seen.push('last'));
  bus.emit('t', null);
  assert.deepEqual(seen, ['self', 'next', 'last']);
  seen.length = 0;
  bus.emit('t', null);
  assert.deepEqual(seen, ['next', 'last']);
});

test('a listener added during dispatch waits for the next emit', () => {
  const bus = createEmitter();
  /** @type {string[]} */
  const seen = [];
  bus.on('t', () => {
    seen.push('a');
    bus.on('t', () => seen.push('added'));
  });
  bus.emit('t', null);
  assert.deepEqual(seen, ['a'], 'the newly added listener must not run in this dispatch');
  seen.length = 0;
  bus.emit('t', null);
  assert.deepEqual(seen, ['a', 'added']);
});

test('clear() removes one type or all of them, even mid-dispatch', () => {
  const bus = createEmitter();
  let a = 0;
  let b = 0;
  bus.on('x', () => a++);
  bus.on('y', () => b++);
  bus.clear('x');
  bus.emit('x', null);
  bus.emit('y', null);
  assert.equal(a, 0);
  assert.equal(b, 1);
  bus.clear();
  bus.emit('y', null);
  assert.equal(b, 1);
  assert.equal(bus.count(), 0);

  /** @type {string[]} */
  const seen = [];
  bus.on('z', () => {
    seen.push('first');
    bus.clear();
  });
  bus.on('z', () => seen.push('second'));
  bus.emit('z', null);
  assert.deepEqual(seen, ['first'], 'clear() during dispatch stops the remaining listeners');
  assert.equal(bus.count(), 0);
});

test('a throwing listener is isolated: the others still run', () => {
  /** @type {string[]} */
  const reported = [];
  const bus = createEmitter({ onError: (err, type) => reported.push(`${type}:${/** @type {Error} */ (err).message}`) });
  /** @type {string[]} */
  const seen = [];
  bus.on('t', () => {
    throw new Error('bad listener');
  });
  bus.on('t', () => seen.push('survivor'));
  bus.emit('t', null);
  assert.deepEqual(seen, ['survivor']);
  assert.deepEqual(reported, ['t:bad listener']);
});

test('without an onError handler, listener failures go to the core error buffer', () => {
  clearErrors();
  const bus = createEmitter();
  bus.on('boom', () => {
    throw new Error('listener exploded');
  });
  bus.emit('boom', null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].tag, 'events');
  assert.match(errors[0].message, /listener for "boom" threw .*listener exploded/);
  assert.ok(errors[0].stack.length > 0, 'the stack of the original Error is captured');
  clearErrors();
});

test('non-function listeners are ignored instead of blowing up at emit time', () => {
  const bus = createEmitter();
  const off = bus.on('t', /** @type {any} */ (null));
  assert.equal(typeof off, 'function');
  off();
  bus.emit('t', null);
  assert.equal(bus.count(), 0);
});

test('count() reports live listeners per type and in total', () => {
  const bus = createEmitter();
  assert.equal(bus.count(), 0);
  assert.equal(bus.count('missing'), 0);
  bus.on('a', () => {});
  bus.on('a', () => {});
  bus.on('b', () => {});
  assert.equal(bus.count('a'), 2);
  assert.equal(bus.count('b'), 1);
  assert.equal(bus.count(), 3);
});

test('emit allocates nothing in the steady state', () => {
  const gc = tryEnableGc();
  if (!gc) return; // measurement impossible without the gc hook; behaviour is covered elsewhere
  const bus = createEmitter();
  let sink = 0;
  bus.on('tick', (v) => {
    sink += v;
  });
  bus.on('tick', (v) => {
    sink -= v;
  });
  for (let i = 0; i < 20000; i++) bus.emit('tick', i); // warm up
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200000; i++) bus.emit('tick', i);
  gc();
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(growth < 256 * 1024, `heap grew ${(growth / 1024).toFixed(1)} KiB over 200k emits`);
  assert.equal(sink, 0);
});

/**
 * Best-effort access to V8's gc hook under a plain `node file` run.
 * @returns {(() => void)|null}
 */
function tryEnableGc() {
  if (typeof globalThis.gc === 'function') return globalThis.gc;
  try {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    v8.setFlagsFromString('--no-expose-gc');
    return typeof gc === 'function' ? gc : null;
  } catch {
    return null;
  }
}
