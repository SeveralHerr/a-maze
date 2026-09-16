// @ts-check
/**
 * @file `buildLevel` — the one entry point the rest of the game uses to turn level parameters into
 * a playable `LevelData` (ARCHITECTURE.md §4.4): generate → validate → **throw if invalid** →
 * populate.
 *
 * The throw is deliberate and load-bearing. A maze that fails validation is unwinnable, and an
 * unwinnable level is worse than a missing one: the player burns their torch out in a sealed
 * pocket with no way to tell that the game, not they, was at fault. `createMazeClient` turns the
 * throw into a rejected promise that `main.js` can surface, and `tools/validate-mazes.mjs` proves
 * across thousands of seeds that it never fires in practice.
 *
 * Pure and Node-safe: no DOM, no timers, no globals. Same `(params, seed)` ⇒ identical level.
 */

import { generateMaze } from './generator.js';
import { validateMaze } from './validator.js';
import { populateLevel } from './populate.js';

/** @typedef {import('../core/types.js').LevelData} LevelData */

/**
 * Level parameters, as produced by `src/state/balance.js` `levelParams(level)`.
 * @typedef {Object} LevelParams
 * @property {number} cols           logical cell columns, 1..4096
 * @property {number} rows           logical cell rows, 1..4096
 * @property {number} [braid=0]      fraction of dead ends to open, 0..1
 * @property {number} [gems=0]       gems to scatter
 * @property {number} [oil=0]        oil flasks to scatter
 * @property {number} [fuelSeconds=0] floor for the derived fuel budget (0 = derive entirely)
 * @property {number} [par=0]        floor for the derived par time (0 = derive entirely)
 */

/**
 * Build one complete, validated, populated level.
 *
 * @param {LevelParams} params
 * @param {number} seed any finite number; the same seed always yields the same level
 * @returns {LevelData}
 * @throws {RangeError} when `cols`/`rows` are missing or outside 1..4096 (from `generateMaze`)
 * @throws {Error} when the generated maze fails validation — the message lists every failure and
 *   the exact `(cols, rows, braid, seed)` needed to reproduce it
 */
export function buildLevel(params, seed) {
  if (params === null || typeof params !== 'object') {
    throw new RangeError(`buildLevel: params must be an object, got ${String(params)}`);
  }
  const maze = generateMaze({ cols: params.cols, rows: params.rows, seed, braid: params.braid });
  const validation = validateMaze(maze);
  assertMazeValid(maze, validation, params.braid);
  const { items, torches, fuel, par } = populateLevel(maze, validation, params, seed);
  return { maze, validation, items, torches, fuel, par };
}

/**
 * The guard `buildLevel` applies between validation and population.
 *
 * Exported so the failure path can be exercised directly: inside `buildLevel` it is (provably, and
 * as `tools/validate-mazes.mjs` re-checks over thousands of mazes) unreachable, and a test that
 * cannot reach a `throw` cannot check that its message is useful when it finally fires.
 *
 * @param {import('../core/types.js').Maze} maze
 * @param {import('../core/types.js').Validation} validation
 * @param {number} [braid] braid fraction, reported so a failure can be reproduced exactly
 * @returns {void}
 * @throws {Error} when `validation.errors` is non-empty
 */
export function assertMazeValid(maze, validation, braid) {
  if (validation.errors.length === 0) return;
  throw new Error(
    `buildLevel: generated maze failed validation ` +
      `(${maze.cols}×${maze.rows}, braid=${braid ?? 0}, seed=${maze.seed}): ` +
      validation.errors.join('; '),
  );
}

/**
 * The transferable buffers inside a `LevelData`, for `postMessage(data, transferList)`.
 *
 * Transferring (rather than copying) the tile map is what keeps worker hand-off cheap: a 512×512
 * level moves 1 MiB of tiles, and a structured *clone* of that would cost a full copy on both
 * sides. After transfer the buffers are detached in the sender, so the worker must not touch the
 * level again — it never does, it posts and forgets.
 *
 * Duplicates are filtered out: `postMessage` throws `DataCloneError` if the same buffer appears
 * twice, which could otherwise happen if a future change made `path` a view of the tile buffer.
 *
 * @param {LevelData} data
 * @returns {ArrayBuffer[]} buffers to hand over (possibly empty — never null)
 */
export function levelTransferList(data) {
  /** @type {ArrayBuffer[]} */
  const list = [];
  const tiles = data && data.maze ? data.maze.tiles : null;
  if (tiles && tiles.buffer instanceof ArrayBuffer) list.push(tiles.buffer);
  const path = data && data.validation ? data.validation.path : null;
  if (path && path.buffer instanceof ArrayBuffer && !list.includes(path.buffer)) list.push(path.buffer);
  return list;
}
