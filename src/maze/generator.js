// @ts-check
/**
 * @file Maze generation: iterative randomized depth-first search ("recursive backtracker"),
 * optional braiding, and farthest-cell exit selection (ARCHITECTURE.md §4.4).
 *
 * ## Why the backtracker
 * It produces long, winding, low-branching corridors — exactly the "lost in a dungeon" feel the
 * game wants — where Kruskal/Prim produce bushier, more uniform mazes. It is also O(n) in both
 * time and memory with a trivially explicit stack.
 *
 * ## Mathematical guarantee: the carve pass always yields a spanning tree
 * Let the *cell graph* G have one node per logical cell and an edge between orthogonally adjacent
 * cells. The carve loop maintains three invariants:
 *
 *   I1. A cell is pushed on the stack exactly when it is first marked visited, and it is never
 *       marked visited twice (the only write to `visited` is guarded by `visited[n] === 0`).
 *       Therefore **every cell is visited at most once** and the stack holds distinct cells, so
 *       `stack` needs at most `cols*rows` slots — no recursion, no stack overflow at any size.
 *   I2. Every carve opens the wall between the current cell (already visited) and a neighbour that
 *       was *not* visited. So each carved edge joins a new node to the already-built structure:
 *       after k carves the visited set is connected and contains k+1 cells, and **no carve can
 *       ever close a cycle** (a cycle would need both endpoints already visited).
 *   I3. The loop only pops a cell when it has no unvisited neighbours, and only terminates when
 *       the stack is empty — i.e. when no visited cell has an unvisited neighbour. Since the grid
 *       graph is connected, an unvisited cell would have to be adjacent to some visited cell
 *       (walk any grid path from the start cell to it and take the first crossing), contradiction.
 *       Therefore **every cell is visited** on termination.
 *
 * From I1+I3 the visited set is all n = cols*rows cells; from I2 the carved edges number exactly
 * n−1 and form a connected acyclic subgraph. A connected acyclic spanning subgraph *is* a spanning
 * tree, hence: every cell reachable from every other cell, by exactly one simple path, with
 * `loops = edges − (nodes − 1) = 0`. That is what `validateMaze` asserts and what
 * `tools/validate-mazes.mjs` checks for 100 % of the braid-0 matrix.
 *
 * ## Why braiding cannot break any of that
 * Braiding **only ever turns a WALL tile into a FLOOR tile** (`carveEdge`); it never fills a
 * corridor back in. Adding an edge to a connected graph leaves it connected, so solvability and
 * full connectivity survive by construction — braiding can only *increase* `loops` (each removed
 * wall adds one edge to a graph whose node count is unchanged) and *decrease* the number of dead
 * ends. No re-validation of connectivity is needed after braiding; it is a theorem, not a hope.
 *
 * ## Units & conventions
 * Tile coordinates, row-major indexing, thick walls and direction numbering are all defined in
 * `constants.js`. Cell (cx,cy) ⇒ tile (2cx+1, 2cy+1); the gap tile toward direction d is
 * (2cx+1+dx[d], 2cy+1+dy[d]).
 */

import { createRng } from '../core/rng.js';
import { clamp } from '../core/math.js';
import { TILE, DIR_COUNT, DIR_DX, DIR_DY, MAX_CELLS_PER_SIDE } from './constants.js';

/** @typedef {import('../core/types.js').Maze} Maze */

/**
 * Parameters for {@link generateMaze}.
 * @typedef {Object} GenerateParams
 * @property {number} cols   logical cell columns, 1..4096 (`MAX_CELLS_PER_SIDE`)
 * @property {number} rows   logical cell rows, 1..4096
 * @property {number} seed   any finite number; NaN/±Infinity are treated as 0
 * @property {number} [braid=0] fraction of dead ends to open up, clamped to 0..1
 */

/**
 * Validate one grid dimension. Non-integers are floored (a caller computing `cols` from a curve
 * should not have to round), but genuinely nonsensical values throw rather than being silently
 * clamped, because a clamped NaN would hide the bug that produced it.
 * @param {unknown} value
 * @param {'cols'|'rows'} name
 * @returns {number} integer in 1..MAX_CELLS_PER_SIDE
 * @throws {RangeError} when `value` is not finite, below 1, or above `MAX_CELLS_PER_SIDE`
 */
function requireSide(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new RangeError(`generateMaze: ${name} must be a finite number, got ${String(value)}`);
  }
  const i = Math.floor(n);
  if (i < 1 || i > MAX_CELLS_PER_SIDE) {
    throw new RangeError(`generateMaze: ${name} must be 1..${MAX_CELLS_PER_SIDE}, got ${n}`);
  }
  return i;
}

/**
 * Normalise the seed. `createRng` already maps NaN/±Infinity to stream 0, but `Maze.seed` is part
 * of the save format and must be a plain finite number, so it is normalised here too.
 * @param {unknown} value
 * @returns {number} finite number (0 when the input is not finite)
 */
function normalizeSeed(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalise the braid fraction: clamp to 0..1, treat anything non-numeric as 0 (no braiding is
 * the safe default — it can never make a maze less playable).
 * @param {unknown} value
 * @returns {number} 0..1
 */
function normalizeBraid(value) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0, 1) : 0;
}

/**
 * Generate a thick-wall maze.
 *
 * Deterministic: the same `(cols, rows, seed, braid)` always produces bit-identical `tiles`, in
 * Node and in every browser. The carve and braid passes draw from two *forked* streams
 * (`maze.carve`, `maze.braid`), so changing the braid fraction never reshuffles the base maze.
 *
 * Cost: O(cols·rows) time; memory is the tile buffer ((2c+1)(2r+1) bytes) plus ~9 bytes per cell
 * of scratch, all released on return. 2000×2000 cells ≈ 16 MiB of tiles + ~52 MiB of scratch.
 *
 * @param {GenerateParams} params
 * @returns {Maze} a fully carved maze whose `start` is cell (0,0) and whose `exit` is the cell at
 *   maximum BFS distance from the start *in the final (post-braid) maze*
 * @throws {RangeError} when `params` is not an object, or `cols`/`rows` are not 1..4096
 */
export function generateMaze(params) {
  if (params === null || typeof params !== 'object') {
    throw new RangeError(`generateMaze: params must be an object, got ${String(params)}`);
  }
  const cols = requireSide(params.cols, 'cols');
  const rows = requireSide(params.rows, 'rows');
  const seed = normalizeSeed(params.seed);
  const braid = normalizeBraid(params.braid);

  const width = cols * 2 + 1;
  const height = rows * 2 + 1;

  // Start from solid rock and carve. (Uint8Array is zero-filled = FLOOR, so the fill is required.)
  const tiles = new Uint8Array(width * height).fill(TILE.WALL);

  const rng = createRng(seed);
  carve(tiles, width, cols, rows, rng.fork('maze.carve'));
  if (braid > 0) braidDeadEnds(tiles, width, cols, rows, braid, rng.fork('maze.braid'));

  const exitCell = farthestCell(tiles, width, cols, rows, 0);
  const ex = exitCell % cols;
  const ey = (exitCell - ex) / cols;

  return {
    width,
    height,
    cols,
    rows,
    tiles,
    start: { x: 1, y: 1 },
    exit: { x: ex * 2 + 1, y: ey * 2 + 1 },
    seed,
  };
}

/**
 * Carve a spanning tree with an iterative randomized DFS (see the file header for the proof).
 * Allocates exactly three typed arrays (visited, stack, 4-slot candidate scratch) and nothing at
 * all inside the loop.
 * @param {Uint8Array} tiles   width*height tile buffer, pre-filled with WALL (mutated)
 * @param {number} width       tile columns
 * @param {number} cols        cell columns
 * @param {number} rows        cell rows
 * @param {import('../core/rng.js').Rng} rng
 * @returns {void}
 */
function carve(tiles, width, cols, rows, rng) {
  const nCells = cols * rows;
  const visited = new Uint8Array(nCells);
  const stack = new Int32Array(nCells); // I1: each cell is pushed at most once ⇒ this always fits
  const candidates = new Int32Array(DIR_COUNT);

  let top = 0;
  stack[0] = 0;
  visited[0] = 1;
  tiles[1 * width + 1] = TILE.FLOOR; // cell (0,0)

  while (top >= 0) {
    const cell = stack[top];
    const cx = cell % cols;
    const cy = (cell - cx) / cols;

    // Collect the unvisited neighbours. Four iterations, no allocation, no sorting.
    let k = 0;
    for (let d = 0; d < DIR_COUNT; d++) {
      const nx = cx + DIR_DX[d];
      const ny = cy + DIR_DY[d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (visited[ny * cols + nx] !== 0) continue;
      candidates[k++] = d;
    }

    if (k === 0) {
      // Dead end for the walker: backtrack. (I3: we only stop when nothing is reachable.)
      top--;
      continue;
    }

    // `rng.int(1)` consumes no draw, so a forced choice keeps the stream aligned with a maze that
    // happened to have several options — determinism does not depend on branch counts.
    const d = candidates[rng.int(k)];
    const tx = cx * 2 + 1;
    const ty = cy * 2 + 1;
    tiles[(ty + DIR_DY[d]) * width + (tx + DIR_DX[d])] = TILE.FLOOR; // the wall between the cells
    const nx = cx + DIR_DX[d];
    const ny = cy + DIR_DY[d];
    tiles[(ny * 2 + 1) * width + (nx * 2 + 1)] = TILE.FLOOR; // the neighbour cell itself
    const nCell = ny * cols + nx;
    visited[nCell] = 1;
    stack[++top] = nCell;
  }
}

/**
 * Count a cell's open edges (corridors leaving it) and record the walled, in-bounds directions.
 * @param {Uint8Array} tiles
 * @param {number} width
 * @param {number} cols
 * @param {number} rows
 * @param {number} cx
 * @param {number} cy
 * @param {Int32Array} walledOut  4-slot scratch, filled with the closed in-bounds directions
 * @returns {number} packed result: `openCount | (walledCount << 8)` — packing avoids allocating a
 *   pair in a loop that runs once per dead end
 */
function probeCell(tiles, width, cols, rows, cx, cy, walledOut) {
  const tx = cx * 2 + 1;
  const ty = cy * 2 + 1;
  let open = 0;
  let walled = 0;
  for (let d = 0; d < DIR_COUNT; d++) {
    const nx = cx + DIR_DX[d];
    const ny = cy + DIR_DY[d];
    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
    if (tiles[(ty + DIR_DY[d]) * width + (tx + DIR_DX[d])] === TILE.FLOOR) open++;
    else walledOut[walled++] = d;
  }
  return open | (walled << 8);
}

/**
 * Braid pass: open a wall at `braid` (0..1) of the maze's dead ends, turning the perfect maze into
 * one with loops. Only removes walls, so connectivity is preserved by construction.
 *
 * Choice policy (classic Jamis-Buck braiding): among a dead end's walled neighbours, prefer one
 * that is *itself* a dead end — that removes two dead ends with one wall and produces more
 * natural-looking loops than a purely random pick. Ties are broken by the braid stream.
 *
 * A dead end whose only walled neighbours are out of bounds (e.g. the tip of a 1×N corridor)
 * cannot be braided and is skipped; that is why the achieved count can be lower than requested for
 * degenerate shapes. It is never higher.
 *
 * @param {Uint8Array} tiles  mutated in place
 * @param {number} width
 * @param {number} cols
 * @param {number} rows
 * @param {number} braid      0..1 fraction of dead ends to open
 * @param {import('../core/rng.js').Rng} rng
 * @returns {number} number of walls actually removed
 */
function braidDeadEnds(tiles, width, cols, rows, braid, rng) {
  const nCells = cols * rows;
  if (nCells < 2) return 0; // a single cell has no wall that could be removed without unsealing

  const walled = new Int32Array(DIR_COUNT); // closed directions of the dead end being processed
  const preferred = new Int32Array(DIR_COUNT); // subset of `walled` leading to another dead end
  const probeScratch = new Int32Array(DIR_COUNT); // throwaway output when probing a neighbour

  // Pass 1: count dead ends so the index list can be sized exactly (no growing array).
  let deadCount = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if ((probeCell(tiles, width, cols, rows, cx, cy, walled) & 0xff) === 1) deadCount++;
    }
  }
  if (deadCount === 0) return 0;

  // Pass 2: collect them, shuffle, and process the first `target`.
  const deadEnds = new Int32Array(deadCount);
  let w = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if ((probeCell(tiles, width, cols, rows, cx, cy, walled) & 0xff) === 1) {
        deadEnds[w++] = cy * cols + cx;
      }
    }
  }
  rng.shuffle(deadEnds);

  const target = Math.round(deadCount * braid);
  let removed = 0;
  for (let i = 0; i < target; i++) {
    const cell = deadEnds[i];
    const cx = cell % cols;
    const cy = (cell - cx) / cols;
    const probe = probeCell(tiles, width, cols, rows, cx, cy, walled);
    // An earlier braid may already have opened this cell up; skip it rather than over-braiding.
    if ((probe & 0xff) !== 1) continue;
    const walledCount = probe >> 8;
    if (walledCount === 0) continue; // corridor tip against the outer border

    // Prefer a walled neighbour that is itself a dead end.
    let deadNeighbours = 0;
    for (let j = 0; j < walledCount; j++) {
      const d = walled[j];
      const nx = cx + DIR_DX[d];
      const ny = cy + DIR_DY[d];
      if ((probeCell(tiles, width, cols, rows, nx, ny, probeScratch) & 0xff) === 1) {
        preferred[deadNeighbours++] = d;
      }
    }
    const chosen = deadNeighbours > 0 ? preferred[rng.int(deadNeighbours)] : walled[rng.int(walledCount)];

    const tx = cx * 2 + 1;
    const ty = cy * 2 + 1;
    tiles[(ty + DIR_DY[chosen]) * width + (tx + DIR_DX[chosen])] = TILE.FLOOR;
    removed++;
  }
  return removed;
}

/**
 * Breadth-first search over the cell graph from `fromCell`, returning the index of the cell at
 * maximum distance. BFS dequeues in non-decreasing distance order, so "first cell discovered at
 * the maximum distance" is a deterministic tie-break given the fixed E,S,W,N neighbour order.
 *
 * Runs on the *final* tiles, so with braiding the exit is farthest in the braided maze (shortcuts
 * included) rather than in the tree that preceded it.
 *
 * @param {Uint8Array} tiles
 * @param {number} width
 * @param {number} cols
 * @param {number} rows
 * @param {number} fromCell  source cell index (`cy*cols + cx`)
 * @returns {number} cell index of a farthest cell (equals `fromCell` for a 1×1 maze)
 */
function farthestCell(tiles, width, cols, rows, fromCell) {
  const nCells = cols * rows;
  const dist = new Int32Array(nCells).fill(-1);
  const queue = new Int32Array(nCells); // every cell is enqueued at most once ⇒ exact capacity
  let head = 0;
  let tail = 0;
  dist[fromCell] = 0;
  queue[tail++] = fromCell;

  let best = fromCell;
  let bestDist = 0;

  while (head < tail) {
    const cell = queue[head++];
    const cx = cell % cols;
    const cy = (cell - cx) / cols;
    const nd = dist[cell] + 1;
    const tx = cx * 2 + 1;
    const ty = cy * 2 + 1;
    for (let d = 0; d < DIR_COUNT; d++) {
      const nx = cx + DIR_DX[d];
      const ny = cy + DIR_DY[d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (tiles[(ty + DIR_DY[d]) * width + (tx + DIR_DX[d])] !== TILE.FLOOR) continue;
      const nCell = ny * cols + nx;
      if (dist[nCell] >= 0) continue;
      dist[nCell] = nd;
      queue[tail++] = nCell;
      if (nd > bestDist) {
        bestDist = nd;
        best = nCell;
      }
    }
  }
  return best;
}
