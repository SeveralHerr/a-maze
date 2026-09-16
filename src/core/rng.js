// @ts-check
/**
 * @file Deterministic pseudo-random numbers and integer hashes.
 *
 * Everything procedural in A-MAZE (maze layout, item placement, textures, attract-mode camera)
 * must be reproducible from a seed, in Node and in every browser, so nothing here touches
 * `Math.random`. All arithmetic is 32-bit integer math via `Math.imul`, `|0` and `>>>0`, which is
 * bit-exact across JS engines.
 *
 * Generators:
 * - **sfc32** (Chris Doty-Humphrey's Small Fast Counting generator, 128-bit state) for streams.
 *   It passes PractRand to multiple terabytes and is ~2× faster than a float-based LCG in V8.
 * - **splitmix32** expands a seed into the four sfc32 state words, so similar seeds (1, 2, 3…)
 *   produce unrelated streams.
 * - **FNV-1a (32-bit)** over UTF-8 for `hashString` — the canonical definition, so values match
 *   any other FNV-1a implementation (useful for seed strings shared between tools and the game).
 * - **MurmurHash3 x86-32** block mixing for `hash2` / `hash3` — stateless, O(1), ideal for
 *   per-pixel texture noise and per-tile variation.
 */

/** 2^32 as a float; dividing a uint32 by it yields [0, 1). */
const U32 = 4294967296;

/** Golden-ratio increment used by splitmix32 (⌊2^32/φ⌋). */
const GOLDEN = 0x9e3779b9 | 0;

/** Scratch views for reading the IEEE-754 bits of non-integer numbers without allocating. */
const f64 = new Float64Array(1);
const f64Words = new Uint32Array(f64.buffer);
// Float64Array uses platform endianness; every browser/Node target is little-endian, but detect
// it anyway so the seed derivation is correct (and identical) on any host.
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const LO_WORD = LITTLE_ENDIAN ? 0 : 1;
const HI_WORD = LITTLE_ENDIAN ? 1 : 0;

/**
 * A deterministic random stream. Methods are bound closures, so they may be passed around
 * detached (`const next = rng.next`).
 * @typedef {Object} Rng
 * @property {() => number} next              float in [0, 1) with 32 bits of resolution
 * @property {() => number} u32               raw uint32 in [0, 2^32)
 * @property {(n:number) => number} int       integer in [0, n), unbiased; 0 when n ≤ 1
 * @property {(a:number, b:number) => number} range   float in [a, b)
 * @property {(p:number) => boolean} chance   true with probability p (clamped to [0,1])
 * @property {<T>(arr:ArrayLike<T>) => (T|undefined)} pick   uniform element; undefined if empty
 * @property {<A extends {length:number, [i:number]:any}>(arr:A) => A} shuffle   in-place Fisher–Yates; returns arr
 * @property {(salt:number|string) => Rng} fork   child stream derived from this stream's seed + salt
 * @property {() => number} state              uint32 digest of the current internal state
 * @property {(out?:Uint32Array) => Uint32Array} saveState   copy the 4 state words (into `out` if given)
 * @property {(words:ArrayLike<number>) => void} restoreState   resume from `saveState` output
 */

/**
 * MurmurHash3 fmix32 finaliser: full avalanche of a 32-bit value.
 * @param {number} h int32/uint32
 * @returns {number} int32
 */
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

/**
 * One splitmix32 output for counter value `s` (the caller advances `s` by GOLDEN between calls).
 * Constants from the widely used 32-bit splitmix variant (Vigna's splitmix64 scaled to 32 bits).
 * @param {number} s int32 counter
 * @returns {number} int32
 */
function splitmix32(s) {
  let z = s;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) | 0;
}

/**
 * Low 32 bits of a finite number's canonical 64-bit identity. Integers use two's-complement
 * words (so small integer seeds behave exactly as uint32 seeds); non-integers use their IEEE-754
 * bits so 0.25 and 0.5 give different seeds. Non-finite values (NaN, ±Infinity) collapse to 0.
 * @param {number} x
 * @returns {number} low word as int32; the high word is left in the module-scoped `seedHi`
 *   (read it immediately — the next call overwrites it)
 */
function splitNumber(x) {
  if (!Number.isFinite(x)) {
    seedHi = 0;
    return 0;
  }
  if (Number.isInteger(x) && Math.abs(x) <= Number.MAX_SAFE_INTEGER) {
    // Floor division keeps negative integers distinct from their uint32 aliases:
    // -1 → (lo 0xFFFFFFFF, hi 0xFFFFFFFF) but 4294967295 → (lo 0xFFFFFFFF, hi 0).
    seedHi = Math.floor(x / U32) | 0;
    return x | 0;
  }
  f64[0] = x === 0 ? 0 : x; // (unreachable for -0, which is an integer, but kept explicit)
  seedHi = f64Words[HI_WORD] | 0;
  return f64Words[LO_WORD] | 0;
}

/** Second return value of `splitNumber` (module-scoped to avoid allocating a tuple). */
let seedHi = 0;

/**
 * Fold any number to a well-mixed uint32 (used for numeric fork salts).
 * @param {number} x
 * @returns {number} int32
 */
function foldNumber(x) {
  const lo = splitNumber(x);
  return fmix32(lo ^ fmix32(seedHi + GOLDEN));
}

/**
 * FNV-1a 32-bit hash of a string's UTF-8 encoding. Lone UTF-16 surrogates are encoded as U+FFFD,
 * matching `TextEncoder`, so the result equals FNV-1a over `new TextEncoder().encode(s)`.
 * Encodes on the fly — no intermediate byte array is allocated.
 * @param {string} s
 * @returns {number} uint32
 */
export function hashString(s) {
  const str = String(s);
  let h = 0x811c9dc5 | 0;
  const n = str.length;
  for (let i = 0; i < n; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      // Surrogate: combine a valid high+low pair into one code point; anything else is U+FFFD.
      const next = i + 1 < n ? str.charCodeAt(i + 1) : 0;
      if (cp <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    }
    if (cp < 0x80) {
      h = Math.imul(h ^ cp, 16777619);
    } else if (cp < 0x800) {
      h = Math.imul(h ^ (0xc0 | (cp >> 6)), 16777619);
      h = Math.imul(h ^ (0x80 | (cp & 0x3f)), 16777619);
    } else if (cp < 0x10000) {
      h = Math.imul(h ^ (0xe0 | (cp >> 12)), 16777619);
      h = Math.imul(h ^ (0x80 | ((cp >> 6) & 0x3f)), 16777619);
      h = Math.imul(h ^ (0x80 | (cp & 0x3f)), 16777619);
    } else {
      h = Math.imul(h ^ (0xf0 | (cp >> 18)), 16777619);
      h = Math.imul(h ^ (0x80 | ((cp >> 12) & 0x3f)), 16777619);
      h = Math.imul(h ^ (0x80 | ((cp >> 6) & 0x3f)), 16777619);
      h = Math.imul(h ^ (0x80 | (cp & 0x3f)), 16777619);
    }
  }
  return h >>> 0;
}

/**
 * MurmurHash3 x86-32 block step: mixes one 32-bit block `k` into running hash `h`.
 * @param {number} h int32
 * @param {number} k int32
 * @returns {number} int32
 */
function murmurBlock(h, k) {
  k = Math.imul(k, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/**
 * Stateless integer hash of a 2-D lattice point — MurmurHash3 x86-32 over the blocks (x, y) with
 * `seed` as the initial hash. Arguments are truncated to int32 (`|0`), so pass integer tile or
 * pixel coordinates; hash a float seed with `hashString`/`createRng(seed).u32()` first if needed.
 * Allocation-free and branch-free: safe for per-pixel texture loops.
 * @param {number} x int32
 * @param {number} y int32
 * @param {number} seed int32/uint32
 * @returns {number} uint32
 */
export function hash2(x, y, seed) {
  let h = murmurBlock(seed | 0, x | 0);
  h = murmurBlock(h, y | 0);
  return fmix32(h ^ 8) >>> 0; // 8 = total input length in bytes, per MurmurHash3
}

/**
 * Stateless integer hash of a 3-D lattice point (e.g. x, y, animation frame). See `hash2`.
 * @param {number} x int32
 * @param {number} y int32
 * @param {number} z int32
 * @param {number} seed int32/uint32
 * @returns {number} uint32
 */
export function hash3(x, y, z, seed) {
  let h = murmurBlock(seed | 0, x | 0);
  h = murmurBlock(h, y | 0);
  h = murmurBlock(h, z | 0);
  return fmix32(h ^ 12) >>> 0;
}

/**
 * A fresh non-deterministic uint32 seed for starting a new run. Uses `crypto.getRandomValues`
 * where available (browsers, Node ≥ 19, workers) and falls back to time + Math.random mixing.
 * @returns {number} uint32
 */
export function randomSeed() {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function') {
      return c.getRandomValues(new Uint32Array(1))[0] >>> 0;
    }
  } catch {
    // Some sandboxed iframes expose `crypto` but throw on use; fall through to the weak source.
  }
  const t = typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
  return fmix32(foldNumber(Date.now()) ^ foldNumber(t) ^ ((Math.random() * U32) | 0)) >>> 0;
}

/**
 * Create a deterministic random stream.
 *
 * Any number is a valid seed: integers (including negatives and values beyond 2^32 up to
 * `Number.MAX_SAFE_INTEGER`) and fractions each select a distinct stream; NaN/±Infinity are
 * treated as 0. The same seed yields a bit-identical sequence on every JS engine.
 * @param {number} seed
 * @returns {Rng}
 */
export function createRng(seed) {
  const lo = splitNumber(Number(seed));
  return fromSeedWords(lo, seedHi);
}

/**
 * Build a stream from a 64-bit seed identity (two int32 words). Separated from `createRng` so
 * `fork` can derive child identities without a round-trip through floats.
 * @param {number} idLo int32 low word of the 64-bit seed identity
 * @param {number} idHi int32 high word of the 64-bit seed identity
 * @returns {Rng}
 */
function fromSeedWords(idLo, idHi) {
  // Expand the seed with splitmix32 so neighbouring seeds give unrelated states. `hi` seeds the
  // counter word through its own splitmix chain so the full 64-bit identity reaches the state.
  let s = idLo | 0;
  s = (s + GOLDEN) | 0;
  let a = splitmix32(s);
  s = (s + GOLDEN) | 0;
  let b = splitmix32(s);
  s = (s + GOLDEN) | 0;
  let c = splitmix32(s);
  let d = splitmix32((idHi ^ 0x6a09e667) + GOLDEN);

  /**
   * Advance sfc32 once.
   * @returns {number} int32 output
   */
  function step() {
    const t0 = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const t = (t0 + d) | 0;
    c = (c + t) | 0;
    return t;
  }

  // Discard the first outputs: sfc32's authors recommend ~12 rounds so the counter word has
  // diffused into the whole state before any value is observed.
  for (let i = 0; i < 15; i++) step();

  /** @returns {number} */
  function next() {
    return (step() >>> 0) / U32;
  }

  /** @returns {number} */
  function u32() {
    return step() >>> 0;
  }

  /**
   * Unbiased integer in [0, n). Uses rejection sampling rather than `floor(next()*n)`, whose bias
   * (up to n/2^32) would skew very large ranges such as tile indices in 2000×2000 stress mazes.
   * Expected draws per call < 2 for every n; n ≤ 1, NaN and Infinity return 0 without drawing.
   * n is floored; values above 2^32 are served from 53-bit floats (bias < n/2^53, negligible).
   * @param {number} n exclusive upper bound
   * @returns {number}
   */
  function int(n) {
    const m = Math.floor(n);
    if (!(m > 1)) return 0;
    if (m <= U32) {
      // Accept u in [0, limit) where limit is the largest multiple of m ≤ 2^32.
      const limit = U32 - (U32 % m);
      let u = step() >>> 0;
      while (u >= limit) u = step() >>> 0;
      return u % m;
    }
    if (m === Infinity) return 0;
    // 53 random bits: 21 high + 32 low.
    const hi = (step() >>> 11) * U32;
    const r53 = (hi + (step() >>> 0)) / 9007199254740992;
    return Math.floor(r53 * m);
  }

  /**
   * @param {number} lo inclusive
   * @param {number} hi exclusive
   * @returns {number}
   */
  function range(lo, hi) {
    return lo + (hi - lo) * next();
  }

  /**
   * @param {number} p probability 0..1
   * @returns {boolean}
   */
  function chance(p) {
    // Always consumes exactly one draw so the stream stays aligned regardless of p.
    return next() < p;
  }

  /**
   * @template T
   * @param {ArrayLike<T>} arr
   * @returns {T|undefined}
   */
  function pick(arr) {
    const n = arr.length;
    return n > 0 ? arr[int(n)] : undefined;
  }

  /**
   * In-place Fisher–Yates (Durstenfeld) shuffle; every permutation equally likely.
   * @template {{length:number, [i:number]:any}} A
   * @param {A} arr
   * @returns {A}
   */
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /**
   * Derive an independent child stream. The child depends only on this stream's *seed identity*
   * and `salt` — not on how many values have been drawn — so named sub-systems (e.g.
   * `rng.fork('textures')`) stay stable when unrelated code adds or removes draws. Forking twice
   * with the same salt returns two identical, independent streams; forks nest
   * (`fork('a').fork('b')` differs from `fork('b').fork('a')`).
   * @param {number|string} salt
   * @returns {Rng}
   */
  function fork(salt) {
    const k = typeof salt === 'string' ? hashString(salt) | 0 : foldNumber(Number(salt));
    const childLo = fmix32(idLo ^ fmix32(k + GOLDEN));
    const childHi = fmix32((idHi + Math.imul(k ^ 0x5bd1e995, 0x27d4eb2d)) ^ childLo);
    return fromSeedWords(childLo, childHi);
  }

  /**
   * uint32 digest of the 128-bit state. Changes after every draw; two streams with the same seed
   * and draw count report the same digest, which makes it a cheap desync / determinism check.
   * It is a fingerprint, not a restorable snapshot — use `saveState` for that.
   * @returns {number}
   */
  function state() {
    let h = murmurBlock(a, b);
    h = murmurBlock(h, c);
    h = murmurBlock(h, d);
    return fmix32(h ^ 16) >>> 0;
  }

  /**
   * @param {Uint32Array} [out] length ≥ 4; allocated when omitted
   * @returns {Uint32Array}
   */
  function saveState(out) {
    const o = out && out.length >= 4 ? out : new Uint32Array(4);
    o[0] = a;
    o[1] = b;
    o[2] = c;
    o[3] = d;
    return o;
  }

  /**
   * Resume from `saveState` output. Invalid input (fewer than 4 words) is ignored.
   * @param {ArrayLike<number>} words
   * @returns {void}
   */
  function restoreState(words) {
    if (!words || words.length < 4) return;
    a = words[0] | 0;
    b = words[1] | 0;
    c = words[2] | 0;
    d = words[3] | 0;
  }

  return { next, u32, int, range, chance, pick, shuffle, fork, state, saveState, restoreState };
}
