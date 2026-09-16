// @ts-check
/**
 * Unit tests for src/core/pool.js — run with `node src/core/pool.test.mjs`.
 * The pool exists to keep the particle system allocation-free, so the tests check both the
 * bookkeeping (swap-remove correctness) and the promise that nothing is allocated at runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createPool } from './pool.js';

/** @typedef {{id:number, life:number, ref:object|null}} Particle */

let nextId = 0;
/** @returns {Particle} */
const factory = () => ({ id: nextId++, life: 0, ref: null });
/** @param {Particle} p */
const reset = (p) => {
  p.life = 0;
  p.ref = null;
};

test('a pool preallocates everything up front and starts empty', () => {
  let made = 0;
  const pool = createPool(
    () => {
      made++;
      return { v: 0 };
    },
    () => {},
    8,
  );
  assert.equal(made, 8, 'every object is created at construction, never during play');
  assert.equal(pool.capacity, 8);
  assert.equal(pool.count, 0);
  assert.equal(pool.free, 8);
  assert.equal(pool.items.length, 8);
});

test('acquire hands out distinct objects until the pool is exhausted', () => {
  const pool = createPool(factory, reset, 3);
  const a = pool.acquire();
  const b = pool.acquire();
  const c = pool.acquire();
  assert.ok(a && b && c);
  assert.equal(new Set([a, b, c]).size, 3, 'no object is handed out twice');
  assert.equal(pool.count, 3);
  assert.equal(pool.acquire(), null, 'exhaustion returns null instead of allocating');
  assert.equal(pool.count, 3);
  // The live region of `items` is exactly what was acquired.
  assert.deepEqual(pool.items.slice(0, pool.count).sort(), [a, b, c].sort());
});

test('release returns objects to the pool and resets them', () => {
  const pool = createPool(factory, reset, 3);
  const a = /** @type {Particle} */ (pool.acquire());
  a.life = 5;
  a.ref = { big: 'payload' };
  assert.equal(pool.release(a), true);
  assert.equal(pool.count, 0);
  assert.equal(a.life, 0, 'reset must run on release');
  assert.equal(a.ref, null, 'references are dropped so they can be collected');
  assert.equal(pool.release(a), false, 'double release is reported, not silently accepted');
  const again = pool.acquire();
  assert.equal(again, a, 'a released object is reused');
});

test('release of a foreign object is rejected', () => {
  const pool = createPool(factory, reset, 2);
  assert.equal(pool.release(/** @type {any} */ ({ id: -1 })), false);
  assert.equal(pool.release(/** @type {any} */ (null)), false);
  assert.equal(pool.count, 0);
});

test('releaseAt swap-removes without losing or duplicating any object', () => {
  const pool = createPool(factory, reset, 6);
  const acquired = [];
  for (let i = 0; i < 6; i++) acquired.push(pool.acquire());
  assert.equal(pool.releaseAt(2), true);
  assert.equal(pool.count, 5);
  assert.equal(pool.releaseAt(0), true);
  assert.equal(pool.count, 4);
  // Out-of-range indices are refused rather than corrupting the live region.
  assert.equal(pool.releaseAt(4), false, 'index >= count is not live');
  assert.equal(pool.releaseAt(-1), false);
  assert.equal(pool.releaseAt(NaN), false);
  // The pool as a whole still holds every object exactly once.
  assert.equal(new Set(pool.items).size, 6);
  // And the freed ones come back out of acquire().
  const back = [pool.acquire(), pool.acquire()];
  assert.equal(new Set([...pool.items.slice(0, pool.count)]).size, 6);
  assert.ok(back.every((o) => o !== null));
});

test('retain visits every live object exactly once while releasing', () => {
  const pool = createPool(factory, reset, 10);
  for (let i = 0; i < 10; i++) {
    const p = /** @type {Particle} */ (pool.acquire());
    p.life = i; // 0..9
  }
  /** @type {number[]} */
  const visited = [];
  pool.retain((p) => {
    visited.push(p.life);
    return p.life % 2 === 1; // keep the odd ones
  });
  assert.equal(visited.length, 10, 'every live object is visited exactly once');
  assert.deepEqual([...visited].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(pool.count, 5);
  const alive = pool.items.slice(0, pool.count).map((p) => p.life).sort((a, b) => a - b);
  assert.deepEqual(alive, [1, 3, 5, 7, 9]);

  // Releasing everything through retain leaves a consistent, fully reusable pool.
  pool.retain(() => false);
  assert.equal(pool.count, 0);
  assert.equal(pool.free, 10);
  for (let i = 0; i < 10; i++) assert.notEqual(pool.acquire(), null);
});

test('clear releases everything and resets each object', () => {
  const pool = createPool(factory, reset, 4);
  for (let i = 0; i < 4; i++) /** @type {Particle} */ (pool.acquire()).life = 9;
  pool.clear();
  assert.equal(pool.count, 0);
  for (const p of pool.items) assert.equal(p.life, 0);
  pool.clear(); // idempotent
  assert.equal(pool.count, 0);
});

test('degenerate sizes and bad callbacks fail loudly at construction, not during play', () => {
  const empty = createPool(factory, reset, 0);
  assert.equal(empty.capacity, 0);
  assert.equal(empty.acquire(), null);
  assert.equal(createPool(factory, reset, -5).capacity, 0);
  assert.equal(createPool(factory, reset, 3.7).capacity, 3, 'fractional sizes floor');
  assert.equal(createPool(factory, reset, /** @type {any} */ ('x')).capacity, 0);
  assert.throws(() => createPool(/** @type {any} */ (null), reset, 1), TypeError);
  assert.throws(() => createPool(factory, /** @type {any} */ (null), 1), TypeError);
});

test('a heavy acquire/release cycle allocates nothing', () => {
  const gc = tryEnableGc();
  if (!gc) return;
  const pool = createPool(factory, reset, 256);
  /** @param {number} rounds */
  const churn = (rounds) => {
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < 256; i++) {
        const p = pool.acquire();
        if (p) p.life = i;
      }
      pool.retain((p) => p.life % 3 === 0);
      pool.clear();
    }
  };
  churn(200); // warm up
  gc();
  const before = process.memoryUsage().heapUsed;
  churn(2000);
  gc();
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(growth < 256 * 1024, `heap grew ${(growth / 1024).toFixed(1)} KiB during churn`);
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
