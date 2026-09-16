// @ts-check
/**
 * Unit tests for src/maze/level.js and src/maze/worker.js — run with `node src/maze/level.test.mjs`.
 *
 * `buildLevel` is the seam every other subsystem sees, so these tests pin the exact shape of
 * `LevelData` (ARCHITECTURE.md §3) as well as the promise that an invalid maze can never escape it.
 * The worker's message protocol is tested through `handleMazeRequest`, which is the whole of its
 * logic — the listener around it is three lines of plumbing, exercised in the browser by
 * `tools/verify.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLevel, levelTransferList, assertMazeValid } from './level.js';
import { generateMaze } from './generator.js';
import { validateMaze } from './validator.js';
import { handleMazeRequest } from './worker.js';
import { TILE } from './constants.js';

/** Typical mid-game level parameters. */
const PARAMS = { cols: 12, rows: 12, braid: 0.2, gems: 8, oil: 3 };

test('buildLevel returns a complete LevelData with every contract field', () => {
  const data = buildLevel(PARAMS, 4242);
  assert.equal(data.maze.cols, 12);
  assert.equal(data.maze.rows, 12);
  assert.equal(data.maze.width, 25);
  assert.equal(data.maze.height, 25);
  assert.equal(data.maze.seed, 4242);
  assert.ok(data.maze.tiles instanceof Uint8Array);
  assert.deepEqual(data.validation.errors, []);
  assert.ok(data.validation.solvable && data.validation.fullyConnected && data.validation.bordersSealed);
  assert.equal(data.items.filter((i) => i.kind === 'gem').length, 8);
  assert.equal(data.items.filter((i) => i.kind === 'oil').length, 3);
  assert.ok(data.torches.length > 0);
  assert.ok(data.fuel > 0 && Number.isFinite(data.fuel));
  assert.ok(data.par > 0 && data.par <= data.fuel);
  assert.equal(data.maze.tiles[data.maze.start.y * data.maze.width + data.maze.start.x], TILE.FLOOR);
  assert.equal(data.maze.tiles[data.maze.exit.y * data.maze.width + data.maze.exit.x], TILE.FLOOR);
});

test('buildLevel is deterministic for a (params, seed) pair', () => {
  const a = buildLevel(PARAMS, 7);
  const b = buildLevel(PARAMS, 7);
  assert.deepEqual(Array.from(a.maze.tiles), Array.from(b.maze.tiles));
  assert.deepEqual(a.items, b.items);
  assert.deepEqual(a.torches, b.torches);
  assert.equal(a.fuel, b.fuel);
  assert.equal(a.par, b.par);
  assert.notDeepEqual(Array.from(buildLevel(PARAMS, 8).maze.tiles), Array.from(a.maze.tiles));
});

test('buildLevel rejects nonsense parameters with RangeError', () => {
  assert.throws(() => buildLevel({ cols: 0, rows: 5 }, 1), RangeError);
  assert.throws(() => buildLevel({ cols: 5, rows: NaN }, 1), RangeError);
  assert.throws(() => buildLevel({ cols: 5, rows: 99999 }, 1), RangeError);
  assert.throws(() => buildLevel(/** @type {never} */ (null), 1), RangeError);
});

test('an invalid maze is refused with an error that names every failure and the seed', () => {
  const maze = generateMaze({ cols: 6, rows: 6, seed: 1234, braid: 0.25 });
  assert.doesNotThrow(() => assertMazeValid(maze, validateMaze(maze), 0.25));

  // Wall off the exit: the level is now unwinnable and must never reach the player.
  maze.tiles[maze.exit.y * maze.width + maze.exit.x - 1] = TILE.WALL;
  maze.tiles[(maze.exit.y - 1) * maze.width + maze.exit.x] = TILE.WALL;
  maze.tiles[(maze.exit.y + 1) * maze.width + maze.exit.x] = TILE.WALL;
  maze.tiles[maze.exit.y * maze.width + maze.exit.x + 1] = TILE.WALL;
  const broken = validateMaze(maze);
  assert.throws(
    () => assertMazeValid(maze, broken, 0.25),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /6×6/);
      assert.match(err.message, /seed=1234/);
      assert.match(err.message, /braid=0\.25/);
      assert.match(err.message, /no path/);
      return true;
    },
  );
});

test('every size from 1×1 upward produces a playable level', () => {
  for (const [cols, rows] of [[1, 1], [1, 2], [2, 1], [2, 2], [3, 7], [7, 3], [40, 40]]) {
    const data = buildLevel({ cols, rows, braid: 0.3, gems: 4, oil: 2 }, cols * 31 + rows);
    assert.deepEqual(data.validation.errors, [], `${cols}×${rows} failed validation`);
    assert.ok(data.fuel >= 20);
    for (const item of data.items) {
      assert.equal(data.maze.tiles[(item.y - 0.5) * data.maze.width + (item.x - 0.5)], TILE.FLOOR);
    }
  }
});

test('levelTransferList hands over the tile and path buffers exactly once', () => {
  const data = buildLevel(PARAMS, 3);
  const list = levelTransferList(data);
  assert.ok(list.includes(data.maze.tiles.buffer));
  assert.ok(list.includes(/** @type {Uint32Array} */ (data.validation.path).buffer));
  assert.equal(new Set(list).size, list.length, 'a buffer may not appear twice');
  assert.deepEqual(levelTransferList(/** @type {never} */ ({})), []);
  assert.deepEqual(levelTransferList(/** @type {never} */ (null)), []);
});

test('the worker protocol answers a request with the same id and a transferable level', () => {
  const res = handleMazeRequest({ id: 17, params: PARAMS, seed: 99 });
  assert.ok(res, 'a well-formed request must be answered');
  assert.equal(res.message.id, 17);
  assert.ok(res.message.data, 'success carries data');
  assert.equal(res.message.error, undefined);
  assert.ok(res.transfer.length >= 1);
  // The answer is identical to a synchronous build — the worker adds no nondeterminism.
  const local = buildLevel(PARAMS, 99);
  assert.deepEqual(Array.from(/** @type {Uint8Array} */ (res.message.data?.maze.tiles)), Array.from(local.maze.tiles));
  assert.deepEqual(res.message.data?.items, local.items);
});

test('the worker reports build failures as messages, never as exceptions', () => {
  const res = handleMazeRequest({ id: 5, params: { cols: -3, rows: 4 }, seed: 1 });
  assert.ok(res);
  assert.equal(res.message.id, 5);
  assert.equal(res.message.data, undefined);
  assert.equal(res.message.name, 'RangeError');
  assert.match(String(res.message.error), /cols/);
  assert.deepEqual(res.transfer, []);
});

test('the worker stays silent for messages that are not maze requests', () => {
  for (const junk of [null, undefined, 42, 'hello', {}, { id: 'abc' }, { params: {} }]) {
    assert.equal(handleMazeRequest(junk), null, `${JSON.stringify(junk)} should be ignored`);
  }
});

test('importing the worker module in Node installs nothing and touches no globals', () => {
  // The guard in worker.js must keep it inert outside a worker scope — otherwise every Node-side
  // tool that imports level.js transitively would try to register a message listener.
  assert.equal(typeof (/** @type {{onmessage?:unknown}} */ (globalThis).onmessage), 'undefined');
  assert.equal(typeof (/** @type {{postMessage?:unknown}} */ (globalThis).postMessage), 'undefined');
});
