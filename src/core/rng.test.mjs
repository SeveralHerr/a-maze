// @ts-check
/**
 * Unit tests for src/core/rng.js — run with `node src/core/rng.test.mjs`.
 *
 * Determinism is a hard requirement of the whole game (a seed must rebuild the same maze in the
 * browser, in the worker and in `tools/validate-mazes.mjs`), so the suite pins golden outputs as
 * well as checking statistical sanity: a generator that is "random enough" but drifts between
 * versions would silently invalidate every saved seed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng, hashString, hash2, hash3, randomSeed } from './rng.js';

/**
 * Chi-square goodness-of-fit against a uniform distribution.
 * @param {number[]} counts observed counts per bucket
 * @returns {number} chi-square statistic
 */
function chiSquare(counts) {
  const n = counts.reduce((a, b) => a + b, 0);
  const expected = n / counts.length;
  let x2 = 0;
  for (const c of counts) {
    const d = c - expected;
    x2 += (d * d) / expected;
  }
  return x2;
}

test('same seed → identical stream; different seeds → different streams', () => {
  const a = createRng(1234);
  const b = createRng(1234);
  const c = createRng(1235);
  const av = [];
  const bv = [];
  const cv = [];
  for (let i = 0; i < 1000; i++) {
    av.push(a.next());
    bv.push(b.next());
    cv.push(c.next());
  }
  assert.deepEqual(av, bv, 'same seed must replay bit-identically');
  assert.notDeepEqual(av, cv, 'adjacent seeds must not share a stream');
  // Adjacent seeds must diverge immediately, not after a warm-up.
  assert.notEqual(av[0], cv[0]);
});

test('golden values pin the generator (changing them invalidates every saved seed)', () => {
  // Regenerate deliberately if the algorithm ever changes — and then bump the persistence key.
  const r = createRng(42);
  const got = [r.u32(), r.u32(), r.u32(), r.u32()];
  assert.deepEqual(got, [1380658083, 163369035, 1219090034, 4113539493]);
  assert.equal(createRng(42).next(), 1380658083 / 4294967296);
});

test('next() is in [0,1), uniform, and uses the full 32-bit range', () => {
  const r = createRng(7);
  const buckets = new Array(20).fill(0);
  let min = 1;
  let max = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1, `next() out of range: ${v}`);
    buckets[Math.floor(v * 20)]++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // 19 degrees of freedom: χ² < 43.8 at p = 0.999.
  assert.ok(chiSquare(buckets) < 43.8, `bucket distribution looks skewed: χ²=${chiSquare(buckets)}`);
  assert.ok(min < 0.0005 && max > 0.9995, `range not covered: [${min}, ${max}]`);
  // Mean of a uniform [0,1) is 0.5; 200k samples put the standard error at ~0.0006.
  let sum = 0;
  const r2 = createRng(8);
  for (let i = 0; i < N; i++) sum += r2.next();
  assert.ok(Math.abs(sum / N - 0.5) < 0.005, `mean drifted: ${sum / N}`);
});

test('int(n) respects its bounds for every shape of n', () => {
  const r = createRng(99);
  for (const n of [2, 3, 6, 7, 10, 1000, 65536, 0x7fffffff, 4294967296, 1e12]) {
    for (let i = 0; i < 2000; i++) {
      const v = r.int(n);
      assert.ok(Number.isInteger(v), `int(${n}) returned a non-integer: ${v}`);
      assert.ok(v >= 0 && v < n, `int(${n}) out of range: ${v}`);
    }
  }
  // Degenerate bounds never throw and never consume randomness.
  const before = r.state();
  for (const n of [1, 0, -5, NaN, Infinity, undefined]) {
    assert.equal(r.int(/** @type {number} */ (n)), 0, `int(${n}) should be 0`);
  }
  assert.equal(r.state(), before, 'degenerate int(n) must not advance the stream');
  // Non-integer bounds floor: int(3.9) ∈ {0,1,2}.
  for (let i = 0; i < 500; i++) assert.ok(r.int(3.9) < 3);
});

test('int(n) is unbiased across buckets', () => {
  const r = createRng(2024);
  const counts = new Array(6).fill(0);
  const N = 120000;
  for (let i = 0; i < N; i++) counts[r.int(6)]++;
  // 5 degrees of freedom: χ² < 20.5 at p = 0.999.
  assert.ok(chiSquare(counts) < 20.5, `int(6) biased: ${counts} χ²=${chiSquare(counts)}`);
});

test('range() and chance() behave', () => {
  const r = createRng(5);
  for (let i = 0; i < 10000; i++) {
    const v = r.range(-2.5, 4);
    assert.ok(v >= -2.5 && v < 4, `range out of bounds: ${v}`);
  }
  assert.equal(r.range(3, 3), 3);
  let hits = 0;
  const N = 40000;
  for (let i = 0; i < N; i++) if (r.chance(0.25)) hits++;
  assert.ok(Math.abs(hits / N - 0.25) < 0.01, `chance(0.25) fired ${hits / N}`);
  assert.equal(r.chance(0), false);
  assert.equal(r.chance(1), true);
});

test('pick() stays inside the array and handles the empty case', () => {
  const r = createRng(11);
  const arr = ['a', 'b', 'c', 'd'];
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const v = r.pick(arr);
    assert.ok(arr.includes(/** @type {string} */ (v)));
    seen.add(v);
  }
  assert.equal(seen.size, 4, 'every element should eventually be picked');
  assert.equal(r.pick([]), undefined);
  assert.equal(r.pick(['solo']), 'solo');
  assert.equal(r.pick(new Uint8Array([7])), 7);
});

test('shuffle() is an in-place permutation, deterministic, and works on typed arrays', () => {
  const source = Array.from({ length: 200 }, (_, i) => i);
  const a = source.slice();
  const returned = createRng(3).shuffle(a);
  assert.equal(returned, a, 'shuffle must return the same array instance');
  assert.notDeepEqual(a, source, '200 elements should not come back in order');
  assert.deepEqual([...a].sort((x, y) => x - y), source, 'shuffle must be a permutation');

  const b = source.slice();
  createRng(3).shuffle(b);
  assert.deepEqual(a, b, 'same seed must produce the same permutation');

  const typed = new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8]);
  createRng(4).shuffle(typed);
  assert.deepEqual([...typed].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8]);

  // Degenerate sizes are no-ops rather than errors.
  assert.deepEqual(createRng(1).shuffle([]), []);
  assert.deepEqual(createRng(1).shuffle([9]), [9]);
});

test('shuffle() produces every permutation roughly equally often', () => {
  const r = createRng(777);
  /** @type {Record<string, number>} */
  const counts = {};
  const N = 60000;
  for (let i = 0; i < N; i++) {
    const key = r.shuffle([0, 1, 2]).join('');
    counts[key] = (counts[key] || 0) + 1;
  }
  const keys = Object.keys(counts).sort();
  assert.deepEqual(keys, ['012', '021', '102', '120', '201', '210']);
  // 5 degrees of freedom: χ² < 20.5 at p = 0.999.
  const x2 = chiSquare(keys.map((k) => counts[k]));
  assert.ok(x2 < 20.5, `permutation distribution skewed: χ²=${x2}`);
});

test('fork() is deterministic, salt-sensitive and independent of parent draw position', () => {
  const parent = createRng(1000);
  const early = parent.fork('maze').next();

  const parent2 = createRng(1000);
  for (let i = 0; i < 137; i++) parent2.next(); // unrelated code drew from the parent
  const late = parent2.fork('maze').next();
  assert.equal(early, late, 'fork must depend on the seed, not on the draw count');

  assert.notEqual(parent.fork('maze').next(), parent.fork('items').next(), 'salts must differ');
  assert.notEqual(createRng(1000).fork(1).next(), createRng(1000).fork(2).next());
  assert.notEqual(createRng(1000).fork('a').next(), createRng(1001).fork('a').next());

  // Forking does not disturb the parent stream.
  const p3 = createRng(55);
  const expect = [p3.next(), p3.next()];
  const p4 = createRng(55);
  p4.fork('noise');
  assert.deepEqual([p4.next(), p4.next()], expect);

  // Forks nest and are order-sensitive, so sub-systems can namespace freely.
  const ab = createRng(9).fork('a').fork('b').next();
  const ba = createRng(9).fork('b').fork('a').next();
  assert.notEqual(ab, ba);
  assert.equal(createRng(9).fork('a').fork('b').next(), ab);

  // A child is a fully independent stream, not an alias of the parent.
  const p5 = createRng(123);
  assert.notEqual(p5.fork('x').next(), createRng(123).next());
});

test('seeds of every numeric shape select distinct streams', () => {
  const seeds = [0, 1, -1, 4294967295, 4294967296, -4294967296, 2 ** 40, 0.5, 0.25, -0.5, 1e-9, Number.MAX_SAFE_INTEGER];
  const first = new Map();
  for (const s of seeds) {
    const v = createRng(s).u32();
    assert.ok(!first.has(v), `seed ${s} collided with seed ${first.get(v)}`);
    first.set(v, s);
    assert.equal(createRng(s).u32(), v, `seed ${s} must be reproducible`);
  }
  // Non-finite seeds are documented to behave like 0 instead of throwing.
  assert.equal(createRng(NaN).u32(), createRng(0).u32());
  assert.equal(createRng(Infinity).u32(), createRng(0).u32());
});

test('u32() spans the whole 32-bit range with balanced bits', () => {
  const r = createRng(31337);
  const bitCounts = new Array(32).fill(0);
  const N = 50000;
  for (let i = 0; i < N; i++) {
    const v = r.u32();
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff, `u32 out of range: ${v}`);
    for (let b = 0; b < 32; b++) if ((v >>> b) & 1) bitCounts[b]++;
  }
  for (let b = 0; b < 32; b++) {
    const ratio = bitCounts[b] / N;
    assert.ok(Math.abs(ratio - 0.5) < 0.02, `bit ${b} is biased: ${ratio}`);
  }
});

test('state() fingerprints progress; saveState/restoreState replay exactly', () => {
  const r = createRng(64);
  const s0 = r.state();
  assert.ok(Number.isInteger(s0) && s0 >= 0 && s0 <= 0xffffffff);
  r.next();
  assert.notEqual(r.state(), s0, 'state must change as the stream advances');
  // Two streams at the same position agree.
  const a = createRng(64);
  const b = createRng(64);
  for (let i = 0; i < 10; i++) {
    a.next();
    b.next();
  }
  assert.equal(a.state(), b.state());

  const saved = a.saveState();
  const expected = [a.next(), a.next(), a.next()];
  a.restoreState(saved);
  assert.deepEqual([a.next(), a.next(), a.next()], expected);
  // Reusing a caller-provided buffer avoids an allocation.
  const buf = new Uint32Array(4);
  assert.equal(a.saveState(buf), buf);
  // Malformed input is ignored rather than corrupting the stream.
  const before = a.state();
  a.restoreState([1, 2]);
  a.restoreState(/** @type {any} */ (null));
  assert.equal(a.state(), before);
});

test('hashString matches canonical FNV-1a over UTF-8', () => {
  // Published FNV-1a 32-bit test vectors.
  assert.equal(hashString(''), 0x811c9dc5);
  assert.equal(hashString('a'), 0xe40c292c);
  assert.equal(hashString('foobar'), 0xbf9cf968);
  // Non-ASCII must agree with a TextEncoder-based reference (multi-byte + surrogate pairs).
  const enc = new TextEncoder();
  for (const s of ['é', 'ünïcøde', '日本語', '🎮 torch', 'a\u{1F600}b', '\uD800lone', 'tail\uDC00']) {
    let h = 0x811c9dc5 | 0;
    for (const byte of enc.encode(s)) h = Math.imul(h ^ byte, 16777619);
    assert.equal(hashString(s), h >>> 0, `mismatch for ${JSON.stringify(s)}`);
  }
  // Distinct short strings must not collide (used for fork salts).
  const names = ['maze', 'items', 'torches', 'textures', 'attract', 'audio', 'particles'];
  assert.equal(new Set(names.map(hashString)).size, names.length);
  assert.ok(hashString('maze') !== hashString('mazf'));
});

test('hash2/hash3 are deterministic, uint32, and well distributed', () => {
  assert.equal(hash2(3, 7, 1), hash2(3, 7, 1));
  assert.notEqual(hash2(3, 7, 1), hash2(7, 3, 1), 'must not be symmetric in x/y');
  assert.notEqual(hash2(3, 7, 1), hash2(3, 7, 2), 'seed must matter');
  assert.notEqual(hash3(1, 2, 3, 0), hash2(1, 2, 0));
  assert.notEqual(hash3(1, 2, 3, 0), hash3(1, 2, 4, 0));

  const bitCounts = new Array(32).fill(0);
  const buckets = new Array(16).fill(0);
  let n = 0;
  for (let y = -32; y < 32; y++) {
    for (let x = -32; x < 32; x++) {
      const h = hash2(x, y, 12345);
      assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
      for (let b = 0; b < 32; b++) if ((h >>> b) & 1) bitCounts[b]++;
      buckets[h >>> 28]++;
      n++;
    }
  }
  for (let b = 0; b < 32; b++) {
    const ratio = bitCounts[b] / n;
    assert.ok(Math.abs(ratio - 0.5) < 0.06, `hash2 bit ${b} biased: ${ratio}`);
  }
  // 15 degrees of freedom: χ² < 37.7 at p = 0.999.
  assert.ok(chiSquare(buckets) < 37.7, `hash2 top nibble skewed: χ²=${chiSquare(buckets)}`);

  // Adjacent lattice points must not be correlated — the whole point of per-pixel noise.
  let sameTopBit = 0;
  for (let x = 0; x < 4096; x++) if (hash2(x, 0, 9) >>> 31 === hash2(x + 1, 0, 9) >>> 31) sameTopBit++;
  assert.ok(Math.abs(sameTopBit / 4096 - 0.5) < 0.05, `neighbour correlation: ${sameTopBit / 4096}`);

  // Float arguments truncate to int32 (documented), so callers cannot silently get noise.
  assert.equal(hash2(3.9, 7.2, 1), hash2(3, 7, 1));
});

test('randomSeed returns a fresh uint32', () => {
  const seen = new Set();
  for (let i = 0; i < 64; i++) {
    const s = randomSeed();
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff, `bad seed: ${s}`);
    seen.add(s);
  }
  assert.ok(seen.size > 60, 'randomSeed should rarely repeat');
});

test('a forked stream is statistically sound too (no seeding shortcut)', () => {
  const child = createRng(2).fork('textures');
  const buckets = new Array(10).fill(0);
  const N = 100000;
  for (let i = 0; i < N; i++) buckets[child.int(10)]++;
  // 9 degrees of freedom: χ² < 27.9 at p = 0.999.
  assert.ok(chiSquare(buckets) < 27.9, `forked stream biased: χ²=${chiSquare(buckets)}`);
});
