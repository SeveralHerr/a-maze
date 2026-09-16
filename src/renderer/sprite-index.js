// @ts-check
/**
 * @file Uniform-grid spatial index over a level's point decoration (ARCHITECTURE.md §4.5).
 *
 * ## Why this exists
 * A level used to carry a handful of items and a couple of dozen torches, so the renderer could
 * afford to walk every one of them twice a frame (once to pick the eight nearest wall torches as
 * point lights, once to queue billboards). With the MASSIVE-maze curve a 128×128-cell level carries
 * **~850 items and ~1300 torches**, and `src/maze/populate.js` will hand out up to `MAX_TORCHES`
 * (4096) on a bigger grid. At that size an O(all items) pass is both a frame cost that grows with
 * the maze and a correctness hazard: the renderer's sprite queue filled up with *distant* torches
 * before the gem at the player's feet was ever considered.
 *
 * So the points are bucketed **once per level** into a uniform grid of `cell`-tile squares, and
 * every frame the renderer walks only the buckets that overlap its draw disc. Cost becomes
 * proportional to what is actually near the camera — i.e. to the fog radius — not to the maze.
 *
 * ## Shape of the data
 * A counting sort produces three parallel arrays, all in bucket order:
 *
 * ```
 *   cellStart[c] … cellStart[c+1]     the slice of `entries` living in bucket c
 *   entries[k]                        index of the point in the caller's own array
 *   px[k], py[k]                      that point's position, copied out
 * ```
 *
 * The positions are **copied into flat typed arrays** rather than read back through
 * `items[entries[k]].x`: the distance test then touches two contiguous float arrays instead of
 * chasing a pointer into a thousand small objects, and the object is only dereferenced for the
 * points that survive. That is the difference between a cache miss per candidate and a cache line
 * per eight candidates.
 *
 * ## Allocation contract
 * `build()` allocates only when it needs **more** room than last time. Level sizes climb to a
 * documented cap (`LEVEL.MAX_CELLS`) and then stop, so after a few levels the index reaches its
 * high-water mark and never allocates again — which is what keeps a 20-minute run flat. Queries
 * allocate nothing at all: the caller reads the public typed arrays directly.
 *
 * Pure data structure: no DOM, no imports, Node-safe, unit-testable.
 */

/**
 * Bucket pitch in tiles.
 *
 * WHY 8: the renderer's draw radius is ~21 tiles, so a query touches at most 6×6 buckets — few
 * enough that the per-bucket loop overhead stays negligible — while a bucket at the densest
 * measured population (one point per ~31 tiles) holds ~2 points, so almost every candidate the
 * query looks at is one it actually wanted. Smaller buckets pay more loop overhead for the same
 * candidates; larger ones drag in points the caller will only reject.
 * @type {number}
 */
export const INDEX_CELL = 8;

/**
 * @typedef {Object} SpriteIndex
 * @property {number} cell        bucket pitch in tiles
 * @property {number} cols        buckets across
 * @property {number} rows        buckets down
 * @property {number} count       points indexed
 * @property {Int32Array} cellStart  `cols*rows+1` prefix offsets into `entries` (bucket `c` owns
 *                                   `[cellStart[c], cellStart[c+1])`)
 * @property {Int32Array} entries   caller-array index of each point, in bucket order
 * @property {Float32Array} px      x of each point, in bucket order
 * @property {Float32Array} py      y of each point, in bucket order
 * @property {(count:number, readX:(i:number)=>number, readY:(i:number)=>number, tilesW:number, tilesH:number) => void} build
 */

/**
 * Create an empty spatial index. One instance is reused for the life of the renderer; `build`
 * re-points it at a new level's points.
 * @param {number} [cell] bucket pitch in tiles (defaults to `INDEX_CELL`)
 * @returns {SpriteIndex}
 */
export function createSpriteIndex(cell = INDEX_CELL) {
  const pitch = cell > 0 ? cell : INDEX_CELL;

  /** Prefix offsets, length `cols*rows+1`. Only the live prefix is meaningful. */
  let cellStart = new Int32Array(1);
  /** Write cursors during the scatter pass; same capacity as `cellStart`. */
  let cursor = new Int32Array(1);
  let entries = new Int32Array(0);
  let px = new Float32Array(0);
  let py = new Float32Array(0);

  const self = /** @type {SpriteIndex} */ ({
    cell: pitch,
    cols: 0,
    rows: 0,
    count: 0,
    get cellStart() {
      return cellStart;
    },
    get entries() {
      return entries;
    },
    get px() {
      return px;
    },
    get py() {
      return py;
    },
    build,
  });

  /**
   * Re-index a level's points. Call it when the level changes, never per frame.
   *
   * Positions outside the tile grid are clamped into the edge buckets rather than dropped: a point
   * the renderer can still see must stay findable, and a malformed one must not corrupt the index.
   * @param {number} count number of points
   * @param {(i:number) => number} readX x of point `i`, in tiles
   * @param {(i:number) => number} readY y of point `i`, in tiles
   * @param {number} tilesW maze width in tiles
   * @param {number} tilesH maze height in tiles
   * @returns {void}
   */
  function build(count, readX, readY, tilesW, tilesH) {
    const n = count > 0 ? count | 0 : 0;
    const cols = tilesW > 0 ? Math.ceil(tilesW / pitch) : 1;
    const rows = tilesH > 0 ? Math.ceil(tilesH / pitch) : 1;
    const nCells = cols * rows;

    if (cellStart.length < nCells + 1) {
      cellStart = new Int32Array(nCells + 1);
      cursor = new Int32Array(nCells + 1);
    }
    if (entries.length < n) {
      entries = new Int32Array(n);
      px = new Float32Array(n);
      py = new Float32Array(n);
    }
    self.cols = cols;
    self.rows = rows;
    self.count = n;

    // Pass 1 — histogram. `cellStart[c+1]` counts bucket c, so the prefix sum below lands the
    // offsets in place with no second array.
    cellStart.fill(0, 0, nCells + 1);
    for (let i = 0; i < n; i++) {
      cellStart[bucketOf(readX(i), readY(i), cols, rows) + 1]++;
    }
    // Pass 2 — prefix sum into start offsets, copied into the write cursors.
    let acc = 0;
    for (let c = 0; c < nCells; c++) {
      cursor[c] = acc;
      acc += cellStart[c + 1];
      cellStart[c + 1] = acc;
    }
    cellStart[0] = 0;
    // Pass 3 — scatter. `readX/readY` are called a second time rather than cached in a scratch
    // array: this runs once per level, and a scratch array would be one more thing to grow.
    for (let i = 0; i < n; i++) {
      const x = readX(i);
      const y = readY(i);
      const k = cursor[bucketOf(x, y, cols, rows)]++;
      entries[k] = i;
      px[k] = x;
      py[k] = y;
    }
  }

  /**
   * Bucket index for a world position, clamped into the grid.
   * @param {number} x tiles
   * @param {number} y tiles
   * @param {number} cols
   * @param {number} rows
   * @returns {number}
   */
  function bucketOf(x, y, cols, rows) {
    // `|0` after a `Math.floor` guard: a NaN coordinate must land in bucket 0, not poison the sort.
    let cx = Math.floor(x / pitch);
    let cy = Math.floor(y / pitch);
    if (!(cx >= 0)) cx = 0;
    else if (cx >= cols) cx = cols - 1;
    if (!(cy >= 0)) cy = 0;
    else if (cy >= rows) cy = rows - 1;
    return (cy | 0) * cols + (cx | 0);
  }

  return self;
}
