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

test('the exit is EXACTLY a BFS-farthest cell, at every size the game ships', () => {
  // The whole premise of a massive maze is a massive route, and that rests on this one property:
  // the exit is the cell at maximum BFS distance from the start *in the final, braided maze*.
  // Checked exhaustively (every cell, not a sample) across the shipped size range.
  for (const [cols, rows, braid] of [[16, 16, 0], [40, 40, 0.3], [128, 128, 0.6], [128, 128, 1], [64, 33, 0.15]]) {
    const m = generateMaze({ cols, rows, seed: cols * 31 + rows, braid });
    const total = m.width * m.height;
    const dist = new Int32Array(total).fill(-1);
    const queue = new Int32Array(total);
    const dx = [1, 0, -1, 0];
    const dy = [0, 1, 0, -1];
    let head = 0;
    let tail = 0;
    const from = m.start.y * m.width + m.start.x;
    dist[from] = 0;
    queue[tail++] = from;
    while (head < tail) {
      const idx = queue[head++];
      const x = idx % m.width;
      const y = (idx - x) / m.width;
      for (let d = 0; d < 4; d++) {
        const nx = x + dx[d];
        const ny = y + dy[d];
        if (nx < 0 || ny < 0 || nx >= m.width || ny >= m.height) continue;
        const n = ny * m.width + nx;
        if (m.tiles[n] !== TILE.FLOOR || dist[n] >= 0) continue;
        dist[n] = dist[idx] + 1;
        queue[tail++] = n;
      }
    }
    let farthest = -1;
    for (let cy = 0; cy < rows; cy++) {
      const row = (cy * 2 + 1) * m.width;
      for (let cx = 0; cx < cols; cx++) farthest = Math.max(farthest, dist[row + cx * 2 + 1]);
    }
    assert.equal(
      dist[m.exit.y * m.width + m.exit.x],
      farthest,
      `${cols}×${rows} braid ${braid}: the exit is not the farthest cell`,
    );
    assert.ok(farthest > 0);
  }
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

// ─── Cross-section shortcuts ─────────────────────────────────────────────────────────────────

/**
 * BFS cell distances over open corridors.
 * @param {import('../core/types.js').Maze} m
 * @param {number} from cell index
 * @returns {Int32Array}
 */
function cellDistances(m, from) {
  const n = m.cols * m.rows;
  const dist = new Int32Array(n).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h];
    const cx = c % m.cols;
    const cy = (c - cx) / m.cols;
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= m.cols || ny >= m.rows) continue;
      if (m.tiles[(cy * 2 + 1 + dy) * m.width + (cx * 2 + 1 + dx)] !== TILE.FLOOR) continue;
      const nc = ny * m.cols + nx;
      if (dist[nc] >= 0) continue;
      dist[nc] = dist[c] + 1;
      queue.push(nc);
    }
  }
  return dist;
}

test('shortcuts only remove walls, add exactly one loop each, and never exceed the request', () => {
  for (const [cols, rows, count] of [[16, 16, 5], [40, 40, 33], [64, 33, 40], [128, 128, 341]]) {
    for (let seed = 1; seed <= 4; seed++) {
      const base = generateMaze({ cols, rows, seed });
      const m = generateMaze({ cols, rows, seed, shortcuts: count });
      let opened = 0;
      for (let i = 0; i < base.tiles.length; i++) {
        if (base.tiles[i] === TILE.FLOOR) assert.equal(m.tiles[i], TILE.FLOOR, `tile ${i} filled back in`);
        else if (m.tiles[i] === TILE.FLOOR) opened++;
      }
      const v = validateMaze(m);
      assert.ok(v.solvable && v.fullyConnected && v.bordersSealed, `${cols}×${rows} seed ${seed}`);
      assert.equal(v.loops, opened, 'each opened wall is one extra cycle');
      assert.ok(opened > 0, `${cols}×${rows} seed ${seed}: at least one shortcut placed`);
      assert.ok(opened <= count, `${cols}×${rows} seed ${seed}: ${opened} > ${count} requested`);
    }
  }
});

test('every shortcut joins cells that were far apart, and the route keeps its guaranteed length', () => {
  const detour = 12;
  const keep = 0.9;
  for (let seed = 1; seed <= 6; seed++) {
    const tree = generateMaze({ cols: 32, rows: 32, seed });
    const m = generateMaze({ cols: 32, rows: 32, seed, shortcuts: 40, shortcutDetour: detour, shortcutRouteKeep: keep });
    const treeRoute = validateMaze(tree).pathLength;
    // pathLength counts tiles (2 per cell step + 1); the guarantee is stated in cell steps.
    const route = validateMaze(m).pathLength;
    assert.ok((route - 1) / 2 >= Math.ceil(((treeRoute - 1) / 2) * keep),
      `seed ${seed}: route ${route} fell below ${keep} of ${treeRoute}`);
    assert.ok(validateMaze(m).loops > 0, 'the shortcuts did something');

    // Replay: each opened wall, checked against the tree plus the walls opened before it, is a
    // stronger claim than the generator makes (it checks against the live maze in its own order),
    // so check the weaker, order-free one: in the *tree*, the two cells were ≥ detour apart.
    for (let i = 0; i < m.tiles.length; i++) {
      if (tree.tiles[i] !== TILE.WALL || m.tiles[i] !== TILE.FLOOR) continue;
      const tx = i % m.width;
      const ty = (i - tx) / m.width;
      const a = tx % 2 === 0 ? [(tx - 2) / 2, (ty - 1) / 2] : [(tx - 1) / 2, (ty - 2) / 2];
      const b = tx % 2 === 0 ? [tx / 2, (ty - 1) / 2] : [(tx - 1) / 2, ty / 2];
      const d = cellDistances(tree, a[1] * m.cols + a[0])[b[1] * m.cols + b[0]];
      assert.ok(d >= detour, `seed ${seed}: shortcut at tile (${tx},${ty}) joins cells only ${d} apart`);
    }
  }
});

test('shortcuts draw from their own stream: the carve is untouched and results are deterministic', () => {
  const a = generateMaze({ cols: 24, rows: 24, seed: 77, shortcuts: 12 });
  const b = generateMaze({ cols: 24, rows: 24, seed: 77, shortcuts: 12 });
  assert.deepEqual(a.tiles, b.tiles);
  const none = generateMaze({ cols: 24, rows: 24, seed: 77, shortcuts: 0 });
  assert.equal(validateMaze(none).loops, 0, 'shortcuts: 0 is still a perfect maze');
  for (const bad of [-3, NaN, 'x', undefined, null]) {
    assert.deepEqual(generateMaze({ cols: 24, rows: 24, seed: 77, shortcuts: /** @type {any} */ (bad) }).tiles, none.tiles);
  }
  // Degenerate grids have no qualifying wall and must not throw.
  for (const [cols, rows] of [[1, 1], [1, 40], [2, 2], [3, 1]]) {
    const m = generateMaze({ cols, rows, seed: 5, shortcuts: 10 });
    assert.ok(validateMaze(m).fullyConnected, `${cols}×${rows}`);
  }
});
