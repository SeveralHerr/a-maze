// @ts-check
/**
 * @file Tile vocabulary and direction tables shared by every maze file (ARCHITECTURE.md §4.4).
 *
 * This module is imported by `src/renderer` as well (the only `src/maze` file it is allowed to
 * touch), so it must stay dependency-free, DOM-free and side-effect-free.
 *
 * ## Coordinate conventions (invariants — the rest of the module assumes them)
 * - **Tile space** is row-major: `index = ty * width + tx`, tile (tx,ty) spans [tx,tx+1)×[ty,ty+1).
 * - Mazes are **thick-wall**: a maze of `cols × rows` logical cells is `(cols*2+1) × (rows*2+1)`
 *   tiles. Logical cell (cx,cy) lives at tile (2cx+1, 2cy+1) — always an *odd* pair — and the tile
 *   between two edge-adjacent cells is the "gap" tile that carving turns from WALL into FLOOR.
 *   Consequence: the outer ring (even coordinates 0 and width-1 / height-1) is never a cell and
 *   never a gap, so it stays WALL — that is what `Validation.bordersSealed` checks.
 * - **Directions** are indices 0..3 = E, S, W, N. The same numbering is used by `Torch.face`
 *   (§3: 0=E, 1=S, 2=W, 3=N), so a direction index can be stored straight into a torch face.
 *   y grows *downward* (screen-style), hence S = +y.
 */

/**
 * Tile values stored in `Maze.tiles`. Only these two values are legal; the validator rejects
 * anything else. FLOOR is 0 so a freshly allocated `Uint8Array` reads as "all floor", and carving
 * code always writes explicit values rather than relying on that.
 * @type {Readonly<{FLOOR: 0, WALL: 1}>}
 */
export const TILE = Object.freeze({ FLOOR: /** @type {0} */ (0), WALL: /** @type {1} */ (1) });

/** Number of orthogonal directions / torch faces. */
export const DIR_COUNT = 4;

/** Direction index: east (+x). Also `Torch.face` 0. */
export const DIR_E = 0;
/** Direction index: south (+y — y grows downward). Also `Torch.face` 1. */
export const DIR_S = 1;
/** Direction index: west (−x). Also `Torch.face` 2. */
export const DIR_W = 2;
/** Direction index: north (−y). Also `Torch.face` 3. */
export const DIR_N = 3;

/**
 * x component of each direction, indexed by direction 0..3 (E, S, W, N).
 * Typed (Int8Array) so tight carve/flood loops index a contiguous, unboxed buffer.
 * **Treat as read-only** — typed arrays cannot be frozen by `Object.freeze` (it throws on views),
 * so immutability here is a convention enforced by review, not by the runtime.
 * @type {Int8Array}
 */
export const DIR_DX = Int8Array.of(1, 0, -1, 0);

/**
 * y component of each direction, indexed by direction 0..3 (E, S, W, N). Read-only by convention.
 * @type {Int8Array}
 */
export const DIR_DY = Int8Array.of(0, 1, 0, -1);

/**
 * Opposite direction index, indexed by direction 0..3: E↔W, S↔N. Read-only by convention.
 * Used to turn "the wall I stepped into, seen from the corridor" into a torch face.
 * @type {Uint8Array}
 */
export const DIR_OPPOSITE = Uint8Array.of(DIR_W, DIR_N, DIR_E, DIR_S);

/**
 * Bundle of the direction tables, for consumers that prefer one import.
 * The object itself is frozen; the typed arrays inside are read-only by convention (see `DIR_DX`).
 * @type {Readonly<{count:number, dx:Int8Array, dy:Int8Array, opposite:Uint8Array, E:0, S:1, W:2, N:3}>}
 */
export const DIRS = Object.freeze({
  count: DIR_COUNT,
  dx: DIR_DX,
  dy: DIR_DY,
  opposite: DIR_OPPOSITE,
  E: /** @type {0} */ (DIR_E),
  S: /** @type {1} */ (DIR_S),
  W: /** @type {2} */ (DIR_W),
  N: /** @type {3} */ (DIR_N),
});

/**
 * Hard upper bound on `cols` / `rows` accepted by the generator.
 *
 * Rationale (why 4096 and not "whatever fits"): a 4096×4096 maze is 8193×8193 = 67,125,249 tiles —
 * a 64 MiB `Uint8Array` for the tiles plus ~256 MiB of Int32 scratch for the validator's parent
 * array. Measured end to end (Node 24, desktop): ~12 s to generate, ~12 s to validate, ~490 MiB
 * RSS. That is the point where the next doubling stops being merely slow and starts failing to
 * allocate in a browser tab. Anything larger is a caller bug (a NaN that floored to a huge number,
 * a unit mix-up), so the generator throws `RangeError` rather than trying and dying with OOM.
 * Gameplay sizes are three orders of magnitude below this (ARCHITECTURE.md §6: up to 40×40).
 */
export const MAX_CELLS_PER_SIDE = 4096;

/**
 * Cell-count threshold above which `createMazeClient` prefers the Web Worker (ARCHITECTURE.md
 * §4.4). Below it, generation costs well under a frame and the worker round-trip would dominate.
 */
export const WORKER_CELL_THRESHOLD = 400;

/**
 * Minimum detour, in tiles, from the solution path to the level's hidden map scroll
 * (ARCHITECTURE.md §4.8): the scroll sits at the end of a dead-end branch at least this deep, so it
 * is out of sight from the route and finding it is a decision, not an accident. The upper bound is
 * `floor(oilTargetGap / 4)` each way, which keeps the detour affordable on one tank. It lives here
 * rather than in `src/state/balance.js` because `src/maze` may not import `src/state`.
 */
export const MAP_MIN_DETOUR_TILES = 4;

/**
 * Tile coordinate of a logical cell coordinate (the "odd lattice" mapping).
 * @param {number} c cell column or row index (0-based)
 * @returns {number} tile column or row index (always odd)
 */
export function cellToTile(c) {
  return c * 2 + 1;
}

/**
 * Logical cell coordinate containing a tile coordinate. Exact for odd (cell) coordinates; for an
 * even coordinate it returns the lower of the two neighbouring cells, which is what gap-tile
 * lookups want.
 * @param {number} t tile column or row index
 * @returns {number} cell column or row index
 */
export function tileToCell(t) {
  return (t - 1) >> 1;
}
