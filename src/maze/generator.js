// @ts-check
/**
 * @file Maze generation: iterative randomized depth-first search ("recursive backtracker"),
 * optional cross-section shortcuts, optional braiding, and farthest-cell exit selection
 * (ARCHITECTURE.md §4.4).
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
 * The shortcut pass (`connectSections`) is the same kind of operation — WALL → FLOOR between two
 * cells — so the same argument covers it.
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
 * @property {number} [shortcuts=0] walls to knock through between cells that are far apart by
 *   path (see {@link connectSections}); floored, clamped to ≥ 0
 * @property {number} [shortcutDetour=SHORTCUT_DETOUR] minimum path distance, in cells, between the
 *   two cells a shortcut joins; floored, clamped to ≥ 2
 * @property {number} [shortcutRouteKeep=SHORTCUT_ROUTE_KEEP] fraction (0..1) of the start→exit
 *   route length that shortcuts must leave intact
 */

/**
 * Default minimum detour a shortcut must save, in cells. Two neighbours this far apart by path sit
 * in genuinely different sections of the maze, so the opening turns a long backtrack into a loop;
 * a smaller value would mostly join sibling corridors and change nothing the player can feel.
 */
export const SHORTCUT_DETOUR = 24;

/**
 * Default fraction of the carved start→exit route that shortcuts must preserve. Shortcuts exist to
 * spare the player long backtracks, not to trivialise the level: unguarded, four shortcuts halve
 * a 16×16 route (measured 314 → 150 tiles).
 */
export const SHORTCUT_ROUTE_KEEP = 0.9;

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
 * Normalise a non-negative integer parameter: floor, clamp to `min`, and treat anything
 * non-numeric as `fallback`.
 * @param {unknown} value
 * @param {number} min
 * @param {number} fallback
 * @returns {number}
 */
function normalizeCount(value, min, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
}

/**
 * Generate a thick-wall maze.
 *
 * Deterministic: the same `(cols, rows, seed, braid, shortcuts, shortcutDetour)` always produces
 * bit-identical `tiles`, in Node and in every browser. The carve, shortcut and braid passes draw
 * from three *forked* streams (`maze.carve`, `maze.connect`, `maze.braid`), so changing either
 * knob never reshuffles the base maze.
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
  const shortcuts = normalizeCount(params.shortcuts, 0, 0);
  const shortcutDetour = normalizeCount(params.shortcutDetour, 2, SHORTCUT_DETOUR);
  const routeKeep = Number.isFinite(Number(params.shortcutRouteKeep ?? NaN))
    ? clamp(Number(params.shortcutRouteKeep), 0, 1)
    : SHORTCUT_ROUTE_KEEP;

  const width = cols * 2 + 1;
  const height = rows * 2 + 1;

  // Start from solid rock and carve. (Uint8Array is zero-filled = FLOOR, so the fill is required.)
  const tiles = new Uint8Array(width * height).fill(TILE.WALL);

  const rng = createRng(seed);
  carve(tiles, width, cols, rows, rng.fork('maze.carve'));
  if (shortcuts > 0) {
    connectSections(tiles, width, cols, rows, shortcuts, shortcutDetour, routeKeep, rng.fork('maze.connect'));
  }
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
 * Shortcut pass: knock through up to `count` interior walls whose two cells are at least `detour`
 * cells apart by path, joining separate sections of the maze.
 *
 * Braiding only opens dead ends, and its dead-end-to-dead-end preference mostly joins neighbouring
 * twigs of the same branch — the player still walks out of a long cul-de-sac the way they came in.
 * This pass instead picks walls at random and keeps one only when a **bounded BFS** from one side
 * cannot reach the other in fewer than `detour` steps, i.e. the wall separates two places the
 * current maze (earlier shortcuts included) keeps far apart. That gives dead-end sections an
 * occasional back door and lets corridors that "should" meet actually meet — so the player's
 * mental map stops being a tree, and getting lost becomes possible.
 *
 * Because each test runs on the live tiles, a new shortcut is never placed where an earlier one
 * already brought the two sides close: shortcuts spread out without an explicit spacing rule.
 *
 * **Route guard.** The pass takes the farthest cell of the carved tree as a reference exit and
 * rejects any wall that would bring it closer than `routeKeep` of its original distance. A shortest
 * path crosses a new edge (a,b) at most once, so with `ds`/`de` the current distances from the
 * start and from the reference exit, the route through it is `min(ds[a]+1+de[b], ds[b]+1+de[a])`;
 * both distance fields are repaired incrementally after every accepted wall. The final exit is still chosen
 * afterwards as the farthest cell, which is at least as far as the reference exit — so the shipped
 * route is ≥ `routeKeep` of the carved one (before braiding, which shortens it as it always has).
 *
 * Cost: one shuffle of ≈ 2·cols·rows candidate walls; per candidate a BFS capped at `detour` steps
 * (a maze is tree-like, so that is a few dozen cells); per accepted wall a repair of the two
 * distance fields that touches only the cells the new edge brought closer.
 * Stops at `count` successes or when the candidates run out — never more than `count`.
 *
 * @param {Uint8Array} tiles   mutated in place
 * @param {number} width
 * @param {number} cols
 * @param {number} rows
 * @param {number} count       maximum walls to open
 * @param {number} detour      minimum path distance (cells) between the two joined cells, ≥ 2
 * @param {number} routeKeep   0..1 fraction of the start→exit route to preserve
 * @param {import('../core/rng.js').Rng} rng
 * @returns {number} number of walls actually removed
 */
function connectSections(tiles, width, cols, rows, count, detour, routeKeep, rng) {
  const nCells = cols * rows;
  const nWalls = (cols - 1) * rows + cols * (rows - 1);
  if (nWalls === 0) return 0;

  // Candidate walls, encoded `cell * 2 + d` (d = DIR_E 0 or DIR_S 1). After the carve n−1 of them
  // are open tree edges; those are skipped when reached rather than filtered up front.
  const walls = new Int32Array(nWalls);
  let w = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const cell = cy * cols + cx;
      if (cx + 1 < cols) walls[w++] = cell * 2;
      if (cy + 1 < rows) walls[w++] = cell * 2 + 1;
    }
  }
  rng.shuffle(walls);

  // Bounded-BFS scratch; `stamp` avoids clearing `mark` between searches.
  const mark = new Int32Array(nCells);
  const dist = new Int32Array(nCells);
  const queue = new Int32Array(nCells);
  let stamp = 0;

  const ds = new Int32Array(nCells);
  const de = new Int32Array(nCells);
  const exitCell = distancesFrom(tiles, width, cols, rows, 0, ds, queue);
  distancesFrom(tiles, width, cols, rows, exitCell, de, queue);
  const minRoute = Math.ceil(ds[exitCell] * routeKeep);

  let removed = 0;
  for (let i = 0; i < nWalls && removed < count; i++) {
    const cell = walls[i] >> 1;
    const d = walls[i] & 1;
    const cx = cell % cols;
    const cy = (cell - cx) / cols;
    const gap = (cy * 2 + 1 + DIR_DY[d]) * width + (cx * 2 + 1 + DIR_DX[d]);
    if (tiles[gap] === TILE.FLOOR) continue;
    const target = (cy + DIR_DY[d]) * cols + (cx + DIR_DX[d]);
    if (ds[cell] + 1 + de[target] < minRoute || ds[target] + 1 + de[cell] < minRoute) continue;

    // Is `target` reachable from `cell` in fewer than `detour` steps?
    stamp++;
    let head = 0;
    let tail = 0;
    mark[cell] = stamp;
    dist[cell] = 0;
    queue[tail++] = cell;
    let near = false;
    search: while (head < tail) {
      const c = queue[head++];
      const nd = dist[c] + 1;
      if (nd >= detour) break; // BFS order: every cell still queued is at least this far
      const qx = c % cols;
      const qy = (c - qx) / cols;
      const tx = qx * 2 + 1;
      const ty = qy * 2 + 1;
      for (let k = 0; k < DIR_COUNT; k++) {
        const nx = qx + DIR_DX[k];
        const ny = qy + DIR_DY[k];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        if (tiles[(ty + DIR_DY[k]) * width + (tx + DIR_DX[k])] !== TILE.FLOOR) continue;
        const n = ny * cols + nx;
        if (mark[n] === stamp) continue;
        if (n === target) {
          near = true;
          break search;
        }
        mark[n] = stamp;
        dist[n] = nd;
        queue[tail++] = n;
      }
    }
    if (near) continue;

    tiles[gap] = TILE.FLOOR;
    removed++;
    relaxDistances(tiles, width, cols, rows, ds, cell, target, queue);
    relaxDistances(tiles, width, cols, rows, de, cell, target, queue);
  }
  return removed;
}

/**
 * Repair a BFS distance field after the edge (a,b) was opened. Opening an edge can only shorten
 * distances, and only through that edge, so it is enough to seed the farther endpoint with its
 * improved distance and propagate improvements outward — the work is proportional to the cells
 * that actually got closer, not to the maze.
 * @param {Uint8Array} tiles
 * @param {number} width
 * @param {number} cols
 * @param {number} rows
 * @param {Int32Array} dist  a complete distance field (no -1 entries: the maze is connected); mutated
 * @param {number} a
 * @param {number} b
 * @param {Int32Array} queue cols*rows slots of scratch
 * @returns {void}
 */
function relaxDistances(tiles, width, cols, rows, dist, a, b, queue) {
  let head = 0;
  let tail = 0;
  if (dist[a] + 1 < dist[b]) {
    dist[b] = dist[a] + 1;
    queue[tail++] = b;
  } else if (dist[b] + 1 < dist[a]) {
    dist[a] = dist[b] + 1;
    queue[tail++] = a;
  }
  // Every enqueue strictly lowers a distance and the queue is FIFO over a BFS frontier, so a cell
  // is enqueued at most once per call and `tail` never exceeds the scratch capacity.
  while (head < tail) {
    const c = queue[head++];
    const nd = dist[c] + 1;
    const cx = c % cols;
    const cy = (c - cx) / cols;
    const tx = cx * 2 + 1;
    const ty = cy * 2 + 1;
    for (let k = 0; k < DIR_COUNT; k++) {
      const nx = cx + DIR_DX[k];
      const ny = cy + DIR_DY[k];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (tiles[(ty + DIR_DY[k]) * width + (tx + DIR_DX[k])] !== TILE.FLOOR) continue;
      const n = ny * cols + nx;
      if (dist[n] <= nd) continue;
      dist[n] = nd;
      queue[tail++] = n;
    }
  }
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
  // every cell is enqueued at most once ⇒ exact capacity
  return distancesFrom(tiles, width, cols, rows, fromCell, new Int32Array(nCells), new Int32Array(nCells));
}

/**
 * Fill `dist` with the BFS distance (in cells) of every cell from `fromCell`, -1 for unreachable.
 * @param {Uint8Array} tiles
 * @param {number} width
 * @param {number} cols
 * @param {number} rows
 * @param {number} fromCell
 * @param {Int32Array} dist   cols*rows slots, overwritten
 * @param {Int32Array} queue  cols*rows slots of scratch
 * @returns {number} cell index of the first cell discovered at the maximum distance
 */
function distancesFrom(tiles, width, cols, rows, fromCell, dist, queue) {
  dist.fill(-1);
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
