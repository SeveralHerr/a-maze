// @ts-check
/**
 * Unit tests for src/maze/validator.js — run with `node src/maze/validator.test.mjs`.
 *
 * The validator is the gate that stops an unplayable level from reaching the player, so the tests
 * concentrate on the failure modes: every kind of broken maze must be *reported*, never thrown on
 * and never silently accepted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMaze } from './validator.js';
import { generateMaze } from './generator.js';
import { TILE } from './constants.js';

/**
 * Build a maze by hand from an ASCII map ('#' = wall, anything else = floor).
 * @param {string[]} rowsText
 * @param {{start?:{x:number,y:number}, exit?:{x:number,y:number}}} [over]
 * @returns {import('../core/types.js').Maze}
 */
function fromAscii(rowsText, over) {
  const height = rowsText.length;
  const width = rowsText[0].length;
  const tiles = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) tiles[y * width + x] = rowsText[y][x] === '#' ? TILE.WALL : TILE.FLOOR;
  }
  return {
    width,
    height,
    cols: (width - 1) / 2,
    rows: (height - 1) / 2,
    tiles,
    start: over?.start ?? { x: 1, y: 1 },
    exit: over?.exit ?? { x: width - 2, y: height - 2 },
    seed: 0,
  };
}

test('a generated maze validates clean and reports consistent statistics', () => {
  const m = generateMaze({ cols: 8, rows: 8, seed: 11 });
  const v = validateMaze(m);
  assert.deepEqual(v.errors, []);
  assert.ok(v.solvable && v.fullyConnected && v.bordersSealed);
  assert.equal(v.loops, 0);
  assert.equal(v.floorCount, Array.from(m.tiles).filter((t) => t === TILE.FLOOR).length);
  assert.ok(v.path instanceof Uint32Array);
  assert.equal(v.pathLength, /** @type {Uint32Array} */ (v.path).length);
});

test('the reported path is a real walk from start to exit over floor tiles', () => {
  const m = generateMaze({ cols: 12, rows: 9, seed: 3, braid: 0.2 });
  const v = validateMaze(m);
  const path = /** @type {Uint32Array} */ (v.path);
  assert.equal(path[0], m.start.y * m.width + m.start.x);
  assert.equal(path[path.length - 1], m.exit.y * m.width + m.exit.x);
  for (let i = 0; i < path.length; i++) {
    assert.equal(m.tiles[path[i]], TILE.FLOOR, 'path crosses a wall');
    if (i === 0) continue;
    const ax = path[i - 1] % m.width;
    const ay = (path[i - 1] - ax) / m.width;
    const bx = path[i] % m.width;
    const by = (path[i] - bx) / m.width;
    assert.equal(Math.abs(ax - bx) + Math.abs(ay - by), 1, 'path teleports');
  }
});

test('path length is the number of tiles, so start === exit gives 1', () => {
  const m = generateMaze({ cols: 1, rows: 1, seed: 0 });
  const v = validateMaze(m);
  assert.deepEqual(v.errors, []);
  assert.equal(v.pathLength, 1);
  assert.deepEqual(Array.from(/** @type {Uint32Array} */ (v.path)), [m.width + 1]);
});

test('an unsolvable maze is reported, not thrown on', () => {
  // Two cells, no gap between them: the exit is walled off from the start.
  const m = fromAscii(['#####', '#.#.#', '#####'], { exit: { x: 3, y: 1 } });
  const v = validateMaze(m);
  assert.equal(v.solvable, false);
  assert.equal(v.pathLength, -1);
  assert.equal(v.path, null);
  assert.ok(v.errors.some((e) => e.includes('no path')));
});

test('a disconnected pocket fails fullyConnected even when the exit is reachable', () => {
  const m = fromAscii(['#######', '#...#.#', '#######'], { exit: { x: 3, y: 1 } });
  const v = validateMaze(m);
  assert.equal(v.solvable, true);
  assert.equal(v.fullyConnected, false);
  assert.ok(v.errors.some((e) => e.includes('not fully connected')));
});

test('a hole in the border is reported', () => {
  const m = generateMaze({ cols: 4, rows: 4, seed: 1 });
  m.tiles[0 * m.width + 3] = TILE.FLOOR;
  const v = validateMaze(m);
  assert.equal(v.bordersSealed, false);
  assert.ok(v.errors.some((e) => e.includes('border is not sealed')));
});

test('start or exit off the cell lattice, off the floor, or out of bounds is reported', () => {
  const base = () => generateMaze({ cols: 4, rows: 4, seed: 2 });

  const even = base();
  even.start = { x: 2, y: 2 };
  assert.ok(validateMaze(even).errors.some((e) => e.includes('odd cell lattice')));

  const onWall = base();
  onWall.exit = { x: 1, y: 1 };
  onWall.tiles[1 * onWall.width + 1] = TILE.WALL;
  const v = validateMaze(onWall);
  assert.ok(v.errors.some((e) => e.includes('is not a floor tile')));

  const outside = base();
  outside.exit = { x: 99, y: 1 };
  assert.ok(validateMaze(outside).errors.some((e) => e.includes('exit must be an in-bounds')));
});

test('malformed input is reported rather than throwing', () => {
  const cases = [
    null,
    undefined,
    42,
    {},
    { cols: 2, rows: 2, width: 5, height: 5, tiles: null, start: { x: 1, y: 1 }, exit: { x: 1, y: 1 } },
    { cols: 2, rows: 2, width: 4, height: 5, tiles: new Uint8Array(20), start: { x: 1, y: 1 }, exit: { x: 1, y: 1 } },
    { cols: 2, rows: 2, width: 5, height: 5, tiles: new Uint8Array(5), start: { x: 1, y: 1 }, exit: { x: 1, y: 1 } },
    { cols: 0, rows: 2, width: 1, height: 5, tiles: new Uint8Array(5), start: { x: 1, y: 1 }, exit: { x: 1, y: 1 } },
  ];
  for (const bad of cases) {
    const v = validateMaze(/** @type {never} */ (bad));
    assert.ok(v.errors.length > 0, `${JSON.stringify(bad)} should be rejected`);
    assert.equal(v.solvable, false);
    assert.equal(v.path, null);
  }
});

test('tile values outside {FLOOR, WALL} are reported', () => {
  const m = generateMaze({ cols: 3, rows: 3, seed: 1 });
  m.tiles[m.width + 1] = 7;
  const v = validateMaze(m);
  assert.ok(v.errors.some((e) => e.includes('values other than')));
});

test('loops counts independent cycles on the cell graph', () => {
  // 2×2 cells with all four connections carved = exactly one cycle.
  const ring = fromAscii(['#####', '#...#', '#.#.#', '#...#', '#####']);
  const v = validateMaze(ring);
  assert.deepEqual(v.errors, []);
  assert.equal(v.loops, 1);
  assert.equal(v.deadEnds, 0);

  const braided = validateMaze(generateMaze({ cols: 15, rows: 15, seed: 8, braid: 0.5 }));
  assert.ok(braided.loops > 0);
});

test('deadEnds counts corridor ends, not gap tiles', () => {
  // A single 3-cell corridor: two ends, no branches.
  const corridor = fromAscii(['#########', '#.......#', '#########'], { exit: { x: 7, y: 1 } });
  assert.equal(validateMaze(corridor).deadEnds, 2);
});

test('an uncarved cell is caught even when the rest of the maze is consistent', () => {
  const m = generateMaze({ cols: 5, rows: 5, seed: 6 });
  // Seal off the far corner cell entirely: it becomes wall, so it was "never carved".
  const idx = 9 * m.width + 9;
  m.tiles[idx] = TILE.WALL;
  m.tiles[idx - 1] = TILE.WALL;
  m.tiles[idx - m.width] = TILE.WALL;
  m.exit = { x: 1, y: 1 };
  const v = validateMaze(m);
  assert.ok(v.errors.some((e) => e.includes('never carved')));
});

test('validation is allocation-bounded and fast on a large maze', () => {
  const m = generateMaze({ cols: 300, rows: 300, seed: 1, braid: 0.2 });
  const t0 = performance.now();
  const v = validateMaze(m);
  const ms = performance.now() - t0;
  assert.deepEqual(v.errors, []);
  assert.ok(ms < 2000, `validation took ${ms.toFixed(0)} ms`);
});

test('a floor tile on a pillar position is reported: the thick-wall lattice is a contract', () => {
  // `loops` counts edges of the *cell* graph. A FLOOR at an (even, even) pillar joins corridors
  // outside that graph, so a map with one is not the maze its loop count claims — even when it is
  // still connected and solvable. The generator never makes one (117 k mazes checked); a corrupt
  // save or a hand-built fixture can.
  const maze = generateMaze({ cols: 6, rows: 6, seed: 4, braid: 1 });
  assert.deepEqual(validateMaze(maze).errors, []);
  const pillar = 2 * maze.width + 2; // tile (2,2)
  maze.tiles[pillar] = TILE.FLOOR;
  const v = validateMaze(maze);
  assert.equal(v.errors.length, 1, v.errors.join('; '));
  assert.match(v.errors[0], /1 pillar tile\(s\) are floor/);
  assert.ok(v.solvable, 'the map is still walkable — the lattice error is the only complaint');

  // Several, and the count is right; the outer ring stays the border check's business.
  maze.tiles[4 * maze.width + 4] = TILE.FLOOR;
  assert.match(validateMaze(maze).errors[0], /2 pillar tile\(s\) are floor/);
  const sealed = generateMaze({ cols: 5, rows: 5, seed: 2 });
  sealed.tiles[0] = TILE.FLOOR; // a corner of the border, not an interior pillar
  const border = validateMaze(sealed).errors;
  assert.equal(border.filter((e) => e.includes('pillar')).length, 0);
  assert.equal(border.filter((e) => e.includes('border is not sealed')).length, 1);
});
