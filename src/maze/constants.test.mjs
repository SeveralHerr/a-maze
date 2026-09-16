// @ts-check
/**
 * Unit tests for src/maze/constants.js — run with `node src/maze/constants.test.mjs`.
 *
 * These values are shared across a module boundary (`src/renderer` imports this file), so the
 * tests pin the exact numbers: a silent change to `TILE.WALL` or to the direction order would
 * desync the renderer's torch faces from the maze's without any error anywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE,
  DIRS,
  DIR_COUNT,
  DIR_DX,
  DIR_DY,
  DIR_OPPOSITE,
  DIR_E,
  DIR_S,
  DIR_W,
  DIR_N,
  MAX_CELLS_PER_SIDE,
  WORKER_CELL_THRESHOLD,
  MAP_MIN_DETOUR_TILES,
  cellToTile,
  tileToCell,
} from './constants.js';

test('tile ids match the contract and the object is frozen', () => {
  assert.equal(TILE.FLOOR, 0);
  assert.equal(TILE.WALL, 1);
  assert.ok(Object.isFrozen(TILE));
});

test('directions are E, S, W, N in that order, with y growing downward', () => {
  assert.equal(DIR_COUNT, 4);
  assert.deepEqual([DIR_E, DIR_S, DIR_W, DIR_N], [0, 1, 2, 3]);
  assert.deepEqual(Array.from(DIR_DX), [1, 0, -1, 0]);
  assert.deepEqual(Array.from(DIR_DY), [0, 1, 0, -1]);
  for (let d = 0; d < DIR_COUNT; d++) {
    // `===` rather than assert.equal: strict equality treats 0 and -0 as the same, Object.is does not.
    assert.ok(DIR_DX[DIR_OPPOSITE[d]] === -DIR_DX[d], `direction ${d} has a wrong opposite (x)`);
    assert.ok(DIR_DY[DIR_OPPOSITE[d]] === -DIR_DY[d], `direction ${d} has a wrong opposite (y)`);
    assert.equal(DIR_OPPOSITE[DIR_OPPOSITE[d]], d, 'opposite must be an involution');
  }
});

test('the DIRS bundle exposes the same tables', () => {
  assert.ok(Object.isFrozen(DIRS));
  assert.equal(DIRS.count, DIR_COUNT);
  assert.equal(DIRS.dx, DIR_DX);
  assert.equal(DIRS.dy, DIR_DY);
  assert.equal(DIRS.opposite, DIR_OPPOSITE);
  assert.deepEqual([DIRS.E, DIRS.S, DIRS.W, DIRS.N], [0, 1, 2, 3]);
});

test('cell ↔ tile mapping is the odd lattice and round-trips', () => {
  for (let c = 0; c < 50; c++) {
    assert.equal(cellToTile(c), c * 2 + 1);
    assert.equal(cellToTile(c) & 1, 1, 'cell tiles are always odd');
    assert.equal(tileToCell(cellToTile(c)), c);
  }
  assert.equal(tileToCell(2), 0, 'an even (gap) tile maps to the lower cell');
  assert.equal(tileToCell(4), 1);
});

test('the size guard and worker threshold are the documented values', () => {
  assert.equal(MAX_CELLS_PER_SIDE, 4096);
  assert.equal(WORKER_CELL_THRESHOLD, 400);
});

test('the map scroll minimum detour is the §4.8 value', () => {
  assert.equal(MAP_MIN_DETOUR_TILES, 4);
});
