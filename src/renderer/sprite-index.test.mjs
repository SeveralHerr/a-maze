// @ts-check
/**
 * @file Unit tests for the sprite spatial index (run: `node src/renderer/sprite-index.test.mjs`).
 *
 * The index is the thing standing between the renderer and an O(all items) frame, so what has to
 * be locked down is that querying it returns *exactly* what a brute-force scan would:
 * - every point inside the queried disc is found (a miss is a sprite that vanishes),
 * - buckets of one grid row are contiguous in `entries` (the renderer walks a row as one span),
 * - rebuilding reuses its buffers (a 20-minute run must not grow), and
 * - garbage input (NaN, out-of-grid) lands somewhere valid instead of corrupting the sort.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSpriteIndex, INDEX_CELL } from './sprite-index.js';

/**
 * Deterministic pseudo-random points over a tile grid.
 * @param {number} n
 * @param {number} w
 * @param {number} h
 * @param {number} seed
 * @returns {{x:number, y:number}[]}
 */
function points(n, w, h, seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out = [];
  for (let i = 0; i < n; i++) out.push({ x: next() * w, y: next() * h });
  return out;
}

/**
 * Query the index for every point within `r` of (cx,cy), using the same bucket walk the renderer
 * does, and return the caller-array indices it found.
 * @param {import('./sprite-index.js').SpriteIndex} index
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @returns {Set<number>}
 */
function queryDisc(index, cx, cy, r) {
  const found = new Set();
  const inv = 1 / index.cell;
  let x0 = Math.floor((cx - r) * inv);
  let x1 = Math.floor((cx + r) * inv);
  let y0 = Math.floor((cy - r) * inv);
  let y1 = Math.floor((cy + r) * inv);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > index.cols - 1) x1 = index.cols - 1;
  if (y1 > index.rows - 1) y1 = index.rows - 1;
  for (let cy2 = y0; cy2 <= y1; cy2++) {
    const base = cy2 * index.cols;
    // The renderer relies on one row's buckets being one contiguous span; query it the same way.
    const end = index.cellStart[base + x1 + 1];
    for (let k = index.cellStart[base + x0]; k < end; k++) {
      const dx = index.px[k] - cx;
      const dy = index.py[k] - cy;
      if (dx * dx + dy * dy <= r * r) found.add(index.entries[k]);
    }
  }
  return found;
}

test('a disc query returns exactly what a brute-force scan returns', () => {
  const index = createSpriteIndex();
  for (const [n, w, h] of [
    [1, 5, 5],
    [40, 33, 33],
    [844, 257, 257],
    [1278, 257, 257],
    [300, 61, 13], // strongly non-square grid: row stride mistakes show up here
  ]) {
    const pts = points(n, w, h, n * 7 + w);
    index.build(
      pts.length,
      (i) => pts[i].x,
      (i) => pts[i].y,
      w,
      h,
    );
    assert.equal(index.count, n);
    for (let t = 0; t < 12; t++) {
      const cx = ((t * 13) % w) + 0.5;
      const cy = ((t * 29) % h) + 0.5;
      const r = 1 + (t % 5) * 6;
      const got = queryDisc(index, cx, cy, r);
      /** @type {Set<number>} */
      const want = new Set();
      for (let i = 0; i < pts.length; i++) {
        const dx = pts[i].x - cx;
        const dy = pts[i].y - cy;
        // Float32 storage rounds the position, so a point sitting exactly on the radius may fall
        // either side; only assert on points comfortably inside and comfortably outside.
        if (dx * dx + dy * dy <= (r - 0.01) * (r - 0.01)) want.add(i);
      }
      for (const i of want) {
        assert.ok(got.has(i), `point ${i} inside r=${r} of (${cx},${cy}) was missed (n=${n})`);
      }
      for (const i of got) {
        const dx = pts[i].x - cx;
        const dy = pts[i].y - cy;
        assert.ok(dx * dx + dy * dy <= (r + 0.01) * (r + 0.01), `point ${i} returned but outside`);
      }
    }
  }
});

test('every point lands in exactly one bucket and the buckets partition the entries', () => {
  const index = createSpriteIndex();
  const pts = points(500, 129, 65, 99);
  index.build(
    pts.length,
    (i) => pts[i].x,
    (i) => pts[i].y,
    129,
    65,
  );
  const nCells = index.cols * index.rows;
  assert.equal(index.cellStart[0], 0);
  assert.equal(index.cellStart[nCells], 500, 'the prefix sum must end at the point count');
  /** @type {Set<number>} */
  const seen = new Set();
  for (let c = 0; c < nCells; c++) {
    assert.ok(index.cellStart[c] <= index.cellStart[c + 1], 'prefix offsets must be monotonic');
    const cx = c % index.cols;
    const cy = (c / index.cols) | 0;
    for (let k = index.cellStart[c]; k < index.cellStart[c + 1]; k++) {
      seen.add(index.entries[k]);
      assert.equal(Math.floor(index.px[k] / index.cell), cx, 'entry is in the wrong bucket column');
      assert.equal(Math.floor(index.py[k] / index.cell), cy, 'entry is in the wrong bucket row');
    }
  }
  assert.equal(seen.size, 500, 'every point must appear exactly once');
});

test('rebuilding reuses its buffers once the high-water mark is reached', () => {
  const index = createSpriteIndex();
  const big = points(900, 257, 257, 5);
  index.build(
    big.length,
    (i) => big[i].x,
    (i) => big[i].y,
    257,
    257,
  );
  const entries = index.entries;
  const px = index.px;
  const cellStart = index.cellStart;
  // A later level is never bigger than the cap, so every rebuild from here must be allocation-free.
  for (let round = 0; round < 5; round++) {
    const pts = points(400 + round, 257, 257, round);
    index.build(
      pts.length,
      (i) => pts[i].x,
      (i) => pts[i].y,
      257,
      257,
    );
    assert.equal(index.entries, entries, 'entries buffer was reallocated');
    assert.equal(index.px, px, 'position buffer was reallocated');
    assert.equal(index.cellStart, cellStart, 'bucket buffer was reallocated');
    assert.equal(index.count, 400 + round);
  }
});

test('an empty level and garbage coordinates are indexed without throwing', () => {
  const index = createSpriteIndex();
  index.build(0, () => 0, () => 0, 33, 33);
  assert.equal(index.count, 0);
  assert.equal(index.cellStart[index.cols * index.rows], 0);

  const bad = [
    { x: Number.NaN, y: 3 },
    { x: -100, y: -100 },
    { x: 1e9, y: 1e9 },
    { x: 4.5, y: 4.5 },
  ];
  index.build(
    bad.length,
    (i) => bad[i].x,
    (i) => bad[i].y,
    33,
    33,
  );
  assert.equal(index.count, 4);
  assert.equal(index.cellStart[index.cols * index.rows], 4, 'every point must still be placed');
  // The one well-formed point must still be findable where it belongs.
  assert.ok(queryDisc(index, 4.5, 4.5, 1).has(3));
});

test('a zero-size maze still produces a usable one-bucket grid', () => {
  const index = createSpriteIndex();
  index.build(2, (i) => i, () => 0, 0, 0);
  assert.equal(index.cols, 1);
  assert.equal(index.rows, 1);
  assert.equal(index.cellStart[1], 2);
});

test('the bucket pitch is the documented default', () => {
  assert.equal(createSpriteIndex().cell, INDEX_CELL);
  assert.equal(createSpriteIndex(4).cell, 4);
  assert.equal(createSpriteIndex(0).cell, INDEX_CELL, 'a nonsense pitch falls back to the default');
});
