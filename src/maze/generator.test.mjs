// @ts-check
/**
 * Unit tests for src/maze/generator.js — run with `node src/maze/generator.test.mjs`.
 *
 * The generator's promise is a *mathematical* one (see the proof in its file header), so these
 * tests check the theorem's consequences directly — spanning-tree edge count, connectivity,
 * sealed border — rather than eyeballing a few mazes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMaze } from './generator.js';
import { validateMaze } from './validator.js';
import { TILE, MAX_CELLS_PER_SIDE } from './constants.js';

/**
 * Count open edges of the cell graph (one per carved gap tile between adjacent cells).
 * @param {import('../core/types.js').Maze} m
 * @returns {number}
 */
function edgeCount(m) {
  let edges = 0;
  for (let cy = 0; cy < m.rows; cy++) {
    const ty = cy * 2 + 1;
    for (let cx = 0; cx < m.cols; cx++) {
      const tx = cx * 2 + 1;
      if (cx + 1 < m.cols && m.tiles[ty * m.width + tx + 1] === TILE.FLOOR) edges++;
      if (cy + 1 < m.rows && m.tiles[(ty + 1) * m.width + tx] === TILE.FLOOR) edges++;
    }
  }
  return edges;
}

test('dimensions follow the thick-wall rule and every cell is carved', () => {
  for (const [cols, rows] of [[1, 1], [1, 2], [2, 1], [3, 7], [12, 5]]) {
    const m = generateMaze({ cols, rows, seed: 1 });
    assert.equal(m.width, cols * 2 + 1);
    assert.equal(m.height, rows * 2 + 1);
    assert.equal(m.tiles.length, m.width * m.height);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        assert.equal(m.tiles[(cy * 2 + 1) * m.width + cx * 2 + 1], TILE.FLOOR, `cell ${cx},${cy} uncarved`);
      }
    }
  }
});

test('the carve pass produces exactly a spanning tree (n-1 edges, connected, no loops)', () => {
  for (const [cols, rows] of [[1, 1], [2, 2], [6, 6], [9, 4], [31, 17]]) {
    for (let seed = 0; seed < 8; seed++) {
      const m = generateMaze({ cols, rows, seed });
      assert.equal(edgeCount(m), cols * rows - 1, `${cols}x${rows} seed ${seed}: wrong edge count`);
      const v = validateMaze(m);
      assert.deepEqual(v.errors, []);
      assert.equal(v.loops, 0, 'a spanning tree has no independent cycles');
      assert.ok(v.fullyConnected);
    }
  }
});

test('the outer ring is always wall', () => {
  const m = generateMaze({ cols: 9, rows: 6, seed: 4, braid: 1 });
  for (let x = 0; x < m.width; x++) {
    assert.equal(m.tiles[x], TILE.WALL);
    assert.equal(m.tiles[(m.height - 1) * m.width + x], TILE.WALL);
  }
  for (let y = 0; y < m.height; y++) {
    assert.equal(m.tiles[y * m.width], TILE.WALL);
    assert.equal(m.tiles[y * m.width + m.width - 1], TILE.WALL);
  }
});

test('start is cell (0,0) and the exit is a farthest cell on the odd lattice', () => {
  const m = generateMaze({ cols: 10, rows: 10, seed: 77 });
  assert.deepEqual(m.start, { x: 1, y: 1 });
  assert.equal(m.exit.x & 1, 1);
  assert.equal(m.exit.y & 1, 1);
  assert.equal(m.tiles[m.exit.y * m.width + m.exit.x], TILE.FLOOR);

  // The validator's shortest path must be at least as long as any other cell's distance.
  const v = validateMaze(m);
  const cellPath = (v.pathLength - 1) / 2; // tiles → cell steps
  const other = generateMaze({ cols: 10, rows: 10, seed: 77 });
  other.exit = { x: 1, y: 3 };
  const v2 = validateMaze(other);
  assert.ok(cellPath >= (v2.pathLength - 1) / 2, 'exit is not farther than an arbitrary neighbour cell');
});

test('braiding only removes walls, so it can never disconnect a maze', () => {
  const base = generateMaze({ cols: 14, rows: 11, seed: 5, braid: 0 });
  for (const braid of [0.1, 0.5, 1]) {
    const m = generateMaze({ cols: 14, rows: 11, seed: 5, braid });
    for (let i = 0; i < base.tiles.length; i++) {
      if (base.tiles[i] === TILE.FLOOR) {
        assert.equal(m.tiles[i], TILE.FLOOR, `braid ${braid} filled tile ${i} back in`);
      }
    }
    const v = validateMaze(m);
    assert.deepEqual(v.errors, []);
    assert.ok(v.loops > 0, `braid ${braid} should add cycles`);
  }
});

test('braiding removes dead ends monotonically with the fraction', () => {
  const counts = [0, 0.25, 0.5, 1].map((braid) => validateMaze(generateMaze({ cols: 20, rows: 20, seed: 3, braid })).deadEnds);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] <= counts[i - 1], `dead ends rose from ${counts[i - 1]} to ${counts[i]}`);
  }
  assert.ok(counts[3] < counts[0] / 2, 'braid=1 should remove most dead ends');
  assert.equal(counts[3], 0, 'braid=1 leaves no dead end that has a wall it could open');
});

test('the same seed reproduces the maze bit for bit, and different seeds do not', () => {
  const a = generateMaze({ cols: 17, rows: 13, seed: 2024, braid: 0.3 });
  const b = generateMaze({ cols: 17, rows: 13, seed: 2024, braid: 0.3 });
  assert.deepEqual(Array.from(a.tiles), Array.from(b.tiles));
  assert.deepEqual(a.exit, b.exit);
  const c = generateMaze({ cols: 17, rows: 13, seed: 2025, braid: 0.3 });
  assert.notDeepEqual(Array.from(a.tiles), Array.from(c.tiles));
});

test('the braid fraction never perturbs the underlying carve (separate rng streams)', () => {
  const plain = generateMaze({ cols: 12, rows: 12, seed: 9, braid: 0 });
  const braided = generateMaze({ cols: 12, rows: 12, seed: 9, braid: 0.4 });
  let extra = 0;
  for (let i = 0; i < plain.tiles.length; i++) {
    if (plain.tiles[i] !== braided.tiles[i]) extra++;
  }
  assert.ok(extra > 0, 'braiding should change something');
  // Every difference must be a wall that became floor — the carve itself is untouched.
  for (let i = 0; i < plain.tiles.length; i++) {
    if (plain.tiles[i] !== braided.tiles[i]) {
      assert.equal(plain.tiles[i], TILE.WALL);
      assert.equal(braided.tiles[i], TILE.FLOOR);
    }
  }
});

test('nonsense parameters throw RangeError instead of producing a broken maze', () => {
  for (const bad of [NaN, 0, -1, Infinity, -Infinity, MAX_CELLS_PER_SIDE + 1, undefined, null, 'ten']) {
    assert.throws(
      () => generateMaze({ cols: /** @type {number} */ (/** @type {unknown} */ (bad)), rows: 4, seed: 1 }),
      RangeError,
      `cols=${String(bad)} should throw`,
    );
    assert.throws(
      () => generateMaze({ cols: 4, rows: /** @type {number} */ (/** @type {unknown} */ (bad)), seed: 1 }),
      RangeError,
      `rows=${String(bad)} should throw`,
    );
  }
  assert.throws(() => generateMaze(/** @type {never} */ (null)), RangeError);
  assert.throws(() => generateMaze(/** @type {never} */ ('6x6')), RangeError);
});

test('fractional sizes are floored and the extremes of the braid range are clamped', () => {
  const m = generateMaze({ cols: 6.9, rows: 4.2, seed: 1 });
  assert.equal(m.cols, 6);
  assert.equal(m.rows, 4);
  for (const braid of [-5, NaN, 'x', undefined]) {
    const b = generateMaze({ cols: 8, rows: 8, seed: 1, braid: /** @type {number} */ (/** @type {unknown} */ (braid)) });
    assert.equal(validateMaze(b).loops, 0, `braid=${String(braid)} must behave as 0`);
  }
  const over = generateMaze({ cols: 8, rows: 8, seed: 1, braid: 99 });
  assert.equal(validateMaze(over).deadEnds, 0, 'braid > 1 must behave as 1');
});

test('a non-finite seed is normalised to 0 rather than poisoning the stream', () => {
  const zero = generateMaze({ cols: 5, rows: 5, seed: 0 });
  const nan = generateMaze({ cols: 5, rows: 5, seed: NaN });
  assert.equal(nan.seed, 0);
  assert.deepEqual(Array.from(nan.tiles), Array.from(zero.tiles));
});

test('a long thin maze (the deepest possible recursion) never overflows the stack', () => {
  // 1×4000 forces a carve depth of 4000 and a 500 000-cell maze forces ~500 000 frames if the
  // algorithm were recursive. Both complete because the stack is an Int32Array.
  const thin = generateMaze({ cols: 1, rows: 4000, seed: 1 });
  assert.deepEqual(validateMaze(thin).errors, []);
  assert.equal(thin.exit.y, 4000 * 2 - 1, 'the far end of a corridor is the farthest cell');
  const big = generateMaze({ cols: 700, rows: 700, seed: 1 });
  assert.deepEqual(validateMaze(big).errors, []);
});
