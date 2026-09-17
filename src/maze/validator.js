// @ts-check
/**
 * @file Maze validation: structural checks plus one iterative BFS over the tile grid
 * (ARCHITECTURE.md §4.4). Pure, allocation-bounded, Node- and worker-safe.
 *
 * The validator is the game's safety net: `buildLevel` refuses to ship a level that fails it, and
 * `tools/validate-mazes.mjs` runs it over thousands of mazes to prove the generator's guarantee.
 * It therefore **never throws** — malformed input is reported through `errors[]` like any other
 * failure, so a corrupt save or a hand-written test map degrades into "unplayable level" instead
 * of an unhandled exception mid-frame.
 *
 * ## Definitions (these are the contract's, spelled out)
 * - `pathLength` — number of **tiles** in the shortest start→exit path, counting both endpoints.
 *   A start that *is* the exit has `pathLength === 1`. Because adjacent cells are two tiles apart
 *   (cell, gap, cell), a k-cell route is `2k-1` tiles, which is also its length in world units
 *   travelled, since tiles are 1×1.
 * - `deadEnds` — FLOOR tiles with exactly one FLOOR orthogonal neighbour. Gap tiles always have
 *   two, so this counts corridor ends, i.e. logical cells. A completely isolated floor tile has
 *   zero neighbours and is *not* counted (it is reported as a connectivity error instead).
 * - `loops` — `edges - (nodes - 1)` over the **cell** graph: 0 for a perfect maze, one per
 *   independent cycle otherwise. Can go negative only if the maze is disconnected, which always
 *   comes with a `fullyConnected` error. It describes the real topology only while the thick-wall
 *   lattice holds, which is why a floor tile on a (even, even) pillar position is an error of its
 *   own: such a tile joins corridors the cell graph knows nothing about.
 *
 * ## Cost
 * Time O(width·height). Memory: `Int32Array(width·height)` for BFS parents plus
 * `Int32Array(floorCount)` for the queue (sized exactly after a counting pass, so the queue never
 * over-allocates on a maze that is mostly wall) plus the returned path.
 */

import { TILE, DIR_COUNT, DIR_DX, DIR_DY } from './constants.js';

/** @typedef {import('../core/types.js').Maze} Maze */
/** @typedef {import('../core/types.js').Validation} Validation */

/** Sentinel in the BFS parent array meaning "not reached yet". */
const UNVISITED = -1;

/**
 * Build the all-failed result used when the input is too broken to flood-fill.
 * @param {string[]} errors
 * @returns {Validation}
 */
function failed(errors) {
  return {
    solvable: false,
    fullyConnected: false,
    bordersSealed: false,
    pathLength: -1,
    floorCount: 0,
    deadEnds: 0,
    loops: 0,
    path: null,
    errors,
  };
}

/**
 * True when `v` is a finite integer in [lo, hi].
 * @param {unknown} v
 * @param {number} lo
 * @param {number} hi
 * @returns {boolean}
 */
function isInt(v, lo, hi) {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

/**
 * Validate a maze: connectivity, solvability, sealed border, tile sanity, and the derived
 * statistics the rest of the game needs (shortest path, dead ends, loop count).
 *
 * @param {Maze} maze
 * @returns {Validation} `errors` is empty **iff** the maze is playable; every other field is
 *   filled in as far as the input allowed (see the file header for definitions)
 */
export function validateMaze(maze) {
  /** @type {string[]} */
  const errors = [];

  // ── Structural checks ──────────────────────────────────────────────────────────────────────
  if (maze === null || typeof maze !== 'object') {
    return failed([`maze must be an object, got ${String(maze)}`]);
  }
  const { width, height, cols, rows, tiles, start, exit } = maze;

  if (!isInt(cols, 1, 1 << 24) || !isInt(rows, 1, 1 << 24)) {
    return failed([`cols/rows must be positive integers, got ${String(cols)}×${String(rows)}`]);
  }
  if (width !== cols * 2 + 1 || height !== rows * 2 + 1) {
    return failed([
      `thick-wall invariant violated: width/height must be ${cols * 2 + 1}×${rows * 2 + 1} for ` +
        `${cols}×${rows} cells, got ${String(width)}×${String(height)}`,
    ]);
  }
  // Accept any single-byte view (cross-realm structured clones are not `instanceof Uint8Array`).
  if (!ArrayBuffer.isView(tiles) || tiles.BYTES_PER_ELEMENT !== 1 || tiles.length !== width * height) {
    return failed([
      `tiles must be a ${width * height}-byte typed array, got ${
        ArrayBuffer.isView(tiles) ? `${tiles.constructor.name}(${tiles.length})` : String(tiles)
      }`,
    ]);
  }
  if (!start || !exit || !isInt(start.x, 0, width - 1) || !isInt(start.y, 0, height - 1)) {
    return failed([`start must be an in-bounds integer tile, got ${describePoint(start)}`]);
  }
  if (!isInt(exit.x, 0, width - 1) || !isInt(exit.y, 0, height - 1)) {
    return failed([`exit must be an in-bounds integer tile, got ${describePoint(exit)}`]);
  }

  const total = width * height;
  const startIdx = start.y * width + start.x;
  const exitIdx = exit.y * width + exit.x;

  if ((start.x & 1) === 0 || (start.y & 1) === 0) {
    errors.push(`start ${describePoint(start)} is not on the odd cell lattice`);
  }
  if ((exit.x & 1) === 0 || (exit.y & 1) === 0) {
    errors.push(`exit ${describePoint(exit)} is not on the odd cell lattice`);
  }

  // ── Pass 1: tile values, floor count, sealed border ────────────────────────────────────────
  let floorCount = 0;
  let badValues = 0;
  for (let i = 0; i < total; i++) {
    const t = tiles[i];
    if (t === TILE.FLOOR) floorCount++;
    else if (t !== TILE.WALL) badValues++;
  }
  if (badValues > 0) {
    errors.push(`${badValues} tile(s) hold values other than FLOOR(0)/WALL(1)`);
  }

  // Pillars: the thick-wall lattice puts a permanent wall block at every (even, even) tile. A FLOOR
  // there joins corridors *diagonally past* the cell graph, so `edges`/`loops` below would no
  // longer describe the maze's real topology and the "perfect maze" assertion could pass on a map
  // that is not one. The generator cannot produce one; a hand-built or corrupted map can. The
  // outer ring is skipped — it is the border check's business, and reporting it twice helps nobody.
  let pillarHoles = 0;
  for (let y = 2; y < height - 1; y += 2) {
    const row = y * width;
    for (let x = 2; x < width - 1; x += 2) {
      if (tiles[row + x] === TILE.FLOOR) pillarHoles++;
    }
  }
  if (pillarHoles > 0) {
    errors.push(`${pillarHoles} pillar tile(s) are floor: the thick-wall lattice is broken`);
  }

  let borderHoles = 0;
  for (let x = 0; x < width; x++) {
    if (tiles[x] !== TILE.WALL) borderHoles++;
    if (tiles[(height - 1) * width + x] !== TILE.WALL) borderHoles++;
  }
  for (let y = 1; y < height - 1; y++) {
    if (tiles[y * width] !== TILE.WALL) borderHoles++;
    if (tiles[y * width + width - 1] !== TILE.WALL) borderHoles++;
  }
  const bordersSealed = borderHoles === 0;
  if (!bordersSealed) errors.push(`border is not sealed: ${borderHoles} non-wall tile(s) on the outer ring`);

  if (tiles[startIdx] !== TILE.FLOOR) errors.push(`start ${describePoint(start)} is not a floor tile`);
  if (tiles[exitIdx] !== TILE.FLOOR) errors.push(`exit ${describePoint(exit)} is not a floor tile`);

  // ── Pass 2: every logical cell must actually be carved ─────────────────────────────────────
  // (Cheap, and it catches a whole class of generator bugs that connectivity alone would miss on
  // a maze that happens to be split into two valid halves.)
  let uncarved = 0;
  for (let cy = 0; cy < rows; cy++) {
    const ty = cy * 2 + 1;
    for (let cx = 0; cx < cols; cx++) {
      if (tiles[ty * width + cx * 2 + 1] !== TILE.FLOOR) uncarved++;
    }
  }
  if (uncarved > 0) errors.push(`${uncarved} logical cell(s) were never carved`);

  // ── Pass 3: dead ends, and loops over the cell graph ───────────────────────────────────────
  // The scan skips the outer ring: on a sealed maze it is all wall anyway, and skipping it lets
  // the neighbour lookups run without bounds checks. An unsealed border is already an error above.
  let deadEnds = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      if (tiles[row + x] !== TILE.FLOOR) continue;
      let n = 0;
      if (tiles[row + x + 1] === TILE.FLOOR) n++;
      if (tiles[row + x - 1] === TILE.FLOOR) n++;
      if (tiles[row + width + x] === TILE.FLOOR) n++;
      if (tiles[row - width + x] === TILE.FLOOR) n++;
      if (n === 1) deadEnds++;
    }
  }

  // Edges: one per open gap tile between two edge-adjacent cells. Counting only east and south
  // gaps visits each edge exactly once.
  let edges = 0;
  for (let cy = 0; cy < rows; cy++) {
    const ty = cy * 2 + 1;
    for (let cx = 0; cx < cols; cx++) {
      const tx = cx * 2 + 1;
      if (cx + 1 < cols && tiles[ty * width + tx + 1] === TILE.FLOOR) edges++;
      if (cy + 1 < rows && tiles[(ty + 1) * width + tx] === TILE.FLOOR) edges++;
    }
  }
  const loops = edges - (cols * rows - 1);

  // ── Pass 4: BFS from start over floor tiles ────────────────────────────────────────────────
  let solvable = false;
  let fullyConnected = false;
  let pathLength = -1;
  /** @type {Uint32Array|null} */
  let path = null;

  if (tiles[startIdx] === TILE.FLOOR && floorCount > 0) {
    const parent = new Int32Array(total).fill(UNVISITED);
    const queue = new Int32Array(floorCount); // exact: each floor tile is enqueued at most once
    let head = 0;
    let tail = 0;
    parent[startIdx] = startIdx; // self-parent marks the root and doubles as "visited"
    queue[tail++] = startIdx;
    let reached = 1;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      for (let d = 0; d < DIR_COUNT; d++) {
        const nx = x + DIR_DX[d];
        const ny = y + DIR_DY[d];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (tiles[nIdx] !== TILE.FLOOR || parent[nIdx] !== UNVISITED) continue;
        parent[nIdx] = idx;
        queue[tail++] = nIdx;
        reached++;
      }
    }

    fullyConnected = reached === floorCount;
    if (!fullyConnected) {
      errors.push(
        `maze is not fully connected: ${floorCount - reached} of ${floorCount} floor tiles are unreachable from start`,
      );
    }

    solvable = parent[exitIdx] !== UNVISITED;
    if (solvable) {
      // Walk the parent chain twice: once to measure, once to fill (so the array is sized exactly
      // and written start→exit without reversing a temporary).
      let n = 1;
      for (let i = exitIdx; i !== startIdx; i = parent[i]) n++;
      path = new Uint32Array(n);
      let w = n - 1;
      for (let i = exitIdx; i !== startIdx; i = parent[i]) path[w--] = i;
      path[0] = startIdx;
      pathLength = n;
    } else {
      errors.push(`no path from start ${describePoint(start)} to exit ${describePoint(exit)}`);
    }
  } else if (floorCount === 0) {
    errors.push('maze has no floor tiles');
  }

  return { solvable, fullyConnected, bordersSealed, pathLength, floorCount, deadEnds, loops, path, errors };
}

/**
 * Format a point for an error message without throwing on malformed input.
 * @param {unknown} p
 * @returns {string}
 */
function describePoint(p) {
  if (p === null || typeof p !== 'object') return String(p);
  const v = /** @type {{x?:unknown, y?:unknown}} */ (p);
  return `(${String(v.x)},${String(v.y)})`;
}
