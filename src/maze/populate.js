// @ts-check
/**
 * @file Level population: gems, oil flasks, wall torches, and the fuel/par budget
 * (ARCHITECTURE.md §4.4). Pure, deterministic, Node- and worker-safe.
 *
 * Everything here is a function of `(maze, validation, params, seed)` only — no clocks, no
 * `Math.random`, no DOM — so a level is byte-identical on every machine and can be rebuilt from a
 * seed instead of stored.
 *
 * ## Placement rules (the "why", the "what" is in each function)
 * - **Gems** go at dead ends, farthest from the start first: the reward for the risk of leaving
 *   the solution path. Never on the first three tiles of the path (no free points for standing
 *   still), never on the start or exit tile, and spread out so a single dead end never holds two.
 * - **Oil flasks** sit on *branches off* the solution path, at even intervals along it. A player
 *   who runs straight for the exit can still see and grab them with a short detour, so the fuel
 *   economy is a choice ("is that two-second detour worth it?") rather than a lottery.
 * - **Torches** are mounted on corridor walls at least `TORCH_SPACING` tiles apart, so the
 *   renderer's point lights never stack up into a flat, evenly lit room, and so the count stays
 *   proportional to floor area rather than to tile count.
 *
 * ## Fuel budget formula (the guarantee this module owes the game)
 * The torch *is* the timer, so the fuel handed to a level has to be tied to that level's actual
 * shortest route, not to its nominal size — two 24×24 mazes can differ by 3× in path length.
 *
 *     directTime = pathLength · CORNER_FACTOR / WALK_SPEED          (seconds, no pickups, no detours)
 *     usage      = clamp(USAGE_COEFF · pathLength^USAGE_EXPONENT, USAGE_MIN, USAGE_MAX)
 *     fuel       = max(directTime / usage, MIN_FUEL)
 *
 * `usage` is the fraction of the starting fuel a flawless direct run burns. It *rises* with path
 * length (exponent < 1 ⇒ fuel grows more slowly than the route), which is precisely the difficulty
 * ramp the design asks for:
 *
 * | level | maze  | typical path | usage |
 * |-------|-------|--------------|-------|
 * | 1     | 6×6   | ~55 tiles    | ~50 % |
 * | 5     | 14×14 | ~167 tiles   | ~76 % |
 * | 10    | 24×24 | ~250 tiles   | ~85 % |
 * | 11+   | 26×26+| ≥ 277 tiles  | 88 % (ceiling) |
 *
 * The level-1 bound is *provable*, not statistical: a shortest path is simple, so it visits each
 * of the 36 cells at most once and `pathLength ≤ 2·36−1 = 71` tiles; with the constants below,
 * `usage(71) = 54.9 % ≤ 55 %`. `USAGE_MAX = 0.88` keeps even a 40×40 outlier maze winnable
 * without a single pickup, leaving gems and oil as score/fuel *upside* rather than a requirement.
 *
 * `WALK_SPEED` and `CORNER_FACTOR` are gameplay constants that duplicate knowledge owned by
 * `src/state/balance.js`; `src/maze` may not import `src/state` (ARCHITECTURE.md §2), so they live
 * here as documented, independently tunable values. If balance.js changes the player's speed, the
 * override path below (`params.fuelSeconds`) exists so the state module can impose its own budget
 * without this file changing.
 */

import { createRng, hash2 } from '../core/rng.js';
import { clamp } from '../core/math.js';
import { TILE, DIR_COUNT, DIR_DX, DIR_DY, DIR_OPPOSITE } from './constants.js';

/** @typedef {import('../core/types.js').Maze} Maze */
/** @typedef {import('../core/types.js').Validation} Validation */
/** @typedef {import('../core/types.js').Item} Item */
/** @typedef {import('../core/types.js').Torch} Torch */

/**
 * Tuning knobs for {@link populateLevel}. Extra properties (the rest of the §4.4 `params` object)
 * are ignored.
 * @typedef {Object} PopulateParams
 * @property {number} [gems=0]        number of gems to place
 * @property {number} [oil=0]         number of oil flasks to place
 * @property {number} [fuelSeconds=0] optional floor for the computed fuel budget, in seconds;
 *   ≤ 0 or non-finite means "derive it entirely from the path" (the normal case)
 * @property {number} [par=0]         optional floor for the computed par time, in seconds
 */

/**
 * What {@link populateLevel} produces. `fuel`/`par` are seconds and are copied straight into
 * `LevelData` by `buildLevel`.
 * @typedef {Object} Population
 * @property {Item[]} items
 * @property {Torch[]} torches
 * @property {number} fuel
 * @property {number} par
 */

/** Nominal sustained walking speed, tiles per second (no sprint). Mirrors src/state/balance.js. */
const WALK_SPEED = 3.2;

/** Multiplier on the direct route time for turning, acceleration and wall-hugging overhead. */
const CORNER_FACTOR = 1.18;

/** Coefficient of the usage curve — calibrated so a worst-case 6×6 level 1 lands at 54.9 %. */
const USAGE_COEFF = 0.1255;

/** Exponent of the usage curve — < 1, so deeper (longer) levels get proportionally less fuel. */
const USAGE_EXPONENT = 0.346;

/** Never demand more than this fraction of the fuel for a direct run: every level stays winnable. */
const USAGE_MAX = 0.88;

/** Never hand out an absurdly generous budget on a trivially short maze. */
const USAGE_MIN = 0.25;

/** Absolute floor on a level's fuel, seconds — enough to orient even in a 1×1 test maze. */
const MIN_FUEL = 20;

/** Absolute ceiling on a level's fuel, seconds (a 4096×4096 maze would otherwise ask for hours). */
const MAX_FUEL = 3600;

/** Par = a competent run: the direct route plus this much exploration overhead. */
const PAR_FACTOR = 1.6;

/** Minimum Chebyshev tile distance between two torches. */
const TORCH_SPACING = 6;

/** Hard cap on torches so a huge maze cannot produce a million sprite objects. */
const MAX_TORCHES = 4096;

/** Hard cap on items of one kind, for the same reason. */
const MAX_ITEMS_PER_KIND = 1024;

/** Stand-in for the distance field when no gems are requested and the BFS is skipped. */
const EMPTY_DIST = new Int32Array(0);

/** Gem separation attempts, in tiles: try well-spread first, relax until the quota is met. */
const GEM_SEPARATIONS = Int32Array.of(8, 5, 3, 0);

/** How far off the solution path an oil flask may be planted (tiles). */
const OIL_BRANCH_RADIUS = 3;

/** Upper bound on the bounded BFS used to find branch tiles along a stretch of path. */
const OIL_SCRATCH = 1024;

/** Longest half-window of path tiles seeded into one flask's branch search. */
const OIL_WINDOW_MAX = 96;

/**
 * Fuel and par budget for a level, derived from its shortest path. Exported so `src/state` and
 * the headless tools can reason about the curve without re-deriving it.
 *
 * @param {number} pathLength shortest start→exit distance in tiles (`Validation.pathLength`);
 *   values ≤ 0 (unsolvable maze) are treated as 1
 * @param {PopulateParams} [params] optional per-level floors (`fuelSeconds`, `par`)
 * @returns {{fuel:number, par:number, directTime:number, usage:number}} seconds (fuel/par/directTime)
 *   and the fraction of the fuel a direct run burns (usage)
 */
export function fuelBudget(pathLength, params) {
  const len = Number.isFinite(pathLength) && pathLength > 0 ? pathLength : 1;
  const directTime = (len * CORNER_FACTOR) / WALK_SPEED;
  const usage = clamp(USAGE_COEFF * Math.pow(len, USAGE_EXPONENT), USAGE_MIN, USAGE_MAX);

  let fuel = clamp(directTime / usage, MIN_FUEL, MAX_FUEL);
  const fuelFloor = Number(params?.fuelSeconds);
  if (Number.isFinite(fuelFloor) && fuelFloor > fuel) fuel = Math.min(fuelFloor, MAX_FUEL);

  // Par must stay inside the fuel budget — a par you cannot physically reach is not a target.
  let par = Math.min(directTime * PAR_FACTOR, fuel * 0.95);
  const parFloor = Number(params?.par);
  if (Number.isFinite(parFloor) && parFloor > par) par = Math.min(parFloor, fuel);

  return {
    fuel: round1(fuel),
    par: round1(par),
    directTime: round1(directTime),
    usage: Math.round((directTime / fuel) * 1e4) / 1e4,
  };
}

/**
 * Round to one decimal place (fuel and par are displayed to a tenth of a second).
 * @param {number} v
 * @returns {number}
 */
function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Clamp an item/torch count to a sane integer.
 * @param {unknown} v
 * @param {number} max
 * @returns {number}
 */
function count(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), max);
}

/**
 * Place items and torches, and compute the level's fuel/par budget.
 *
 * Deterministic for a given `(maze, validation, params, seed)`. Items are placed on FLOOR tiles
 * only and never twice on the same tile — `tools/validate-mazes.mjs` asserts both for every level
 * it builds. Runs in O(width·height + k log k) where k is a bounded candidate set.
 *
 * @param {Maze} maze
 * @param {Validation} validation result of `validateMaze(maze)` (its `path` drives oil placement)
 * @param {PopulateParams} params
 * @param {number} seed
 * @returns {Population}
 * @throws {TypeError} when `maze` is not a usable tile map (programmer error — `buildLevel`
 *   validates before calling, so this cannot fire in the normal flow)
 */
export function populateLevel(maze, validation, params, seed) {
  if (!maze || !ArrayBuffer.isView(maze.tiles) || !(maze.width > 0) || !(maze.height > 0)) {
    throw new TypeError('populateLevel: maze must be a generated Maze with a tiles buffer');
  }
  if (!maze.start || !maze.exit || !Number.isInteger(maze.start.x) || !Number.isInteger(maze.exit.x)) {
    throw new TypeError('populateLevel: maze.start and maze.exit must be integer tile coordinates');
  }
  const { width, height, tiles, start, exit } = maze;
  const total = width * height;
  if (tiles.length !== total) {
    throw new TypeError(`populateLevel: tiles length ${tiles.length} does not match ${width}×${height}`);
  }

  const gemQuota = count(params?.gems, MAX_ITEMS_PER_KIND);
  const oilQuota = count(params?.oil, MAX_ITEMS_PER_KIND);
  const rootSeed = Number.isFinite(Number(seed)) ? Number(seed) : 0;
  const root = createRng(rootSeed);
  const gemRng = root.fork('items.gem');
  const oilRng = root.fork('items.oil');
  const torchSeed = root.fork('torches').u32() | 0;

  const startIdx = start.y * width + start.x;
  const exitIdx = exit.y * width + exit.x;

  // `occupied` is the single source of truth for "something is already on this tile": it starts
  // out reserving the tiles gameplay needs kept clear, so no later pass can double-book a tile.
  const occupied = new Uint8Array(total);
  const onPath = new Uint8Array(total);
  const path = validation && validation.path ? validation.path : null;
  if (path) {
    for (let i = 0; i < path.length; i++) onPath[path[i]] = 1;
    // No pickups on the first three tiles of the route: they would be free score at spawn.
    for (let i = 0; i < 3 && i < path.length; i++) occupied[path[i]] = 1;
  }
  occupied[startIdx] = 1;
  occupied[exitIdx] = 1;

  // Only gem ranking needs distances, and the BFS costs a full Int32Array over the grid — skip it
  // entirely for a level without gems (the title-screen demo maze, for one).
  const dist = gemQuota > 0 ? bfsDistances(tiles, width, height, startIdx) : EMPTY_DIST;

  /** @type {Item[]} */
  const items = [];
  placeGems(items, gemQuota, tiles, width, height, dist, occupied, gemRng);
  placeOil(items, oilQuota, tiles, width, height, path, onPath, occupied, oilRng);

  const torches = placeTorches(tiles, width, height, torchSeed);

  const pathLength = validation && validation.pathLength > 0 ? validation.pathLength : 1;
  const budget = fuelBudget(pathLength, params);

  return { items, torches, fuel: budget.fuel, par: budget.par };
}

/**
 * Breadth-first distance in tiles from `fromIdx` over FLOOR tiles.
 * @param {Uint8Array} tiles
 * @param {number} width
 * @param {number} height
 * @param {number} fromIdx
 * @returns {Int32Array} distance per tile, −1 where unreachable (including every wall tile)
 */
function bfsDistances(tiles, width, height, fromIdx) {
  const total = width * height;
  const dist = new Int32Array(total).fill(-1);
  if (tiles[fromIdx] !== TILE.FLOOR) return dist;

  let floorCount = 0;
  for (let i = 0; i < total; i++) if (tiles[i] === TILE.FLOOR) floorCount++;
  const queue = new Int32Array(floorCount);
  let head = 0;
  let tail = 0;
  dist[fromIdx] = 0;
  queue[tail++] = fromIdx;

  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;
    const nd = dist[idx] + 1;
    for (let d = 0; d < DIR_COUNT; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (tiles[nIdx] !== TILE.FLOOR || dist[nIdx] >= 0) continue;
      dist[nIdx] = nd;
      queue[tail++] = nIdx;
    }
  }
  return dist;
}

/**
 * Number of orthogonal FLOOR neighbours of a floor tile. Border tiles are handled by the caller
 * (the scan never reaches them on a sealed maze).
 * @param {Uint8Array} tiles
 * @param {number} width
 * @param {number} idx
 * @returns {number} 0..4
 */
function floorNeighbours(tiles, width, idx) {
  let n = 0;
  if (tiles[idx + 1] === TILE.FLOOR) n++;
  if (tiles[idx - 1] === TILE.FLOOR) n++;
  if (tiles[idx + width] === TILE.FLOOR) n++;
  if (tiles[idx - width] === TILE.FLOOR) n++;
  return n;
}

/**
 * Gems: dead ends first, farthest from the start first, well separated.
 *
 * Candidate selection is O(tiles) even on a 4096² maze: a histogram of dead-end distances yields a
 * distance cutoff that keeps only the farthest `CANDIDATE_BUDGET` dead ends, and only those are
 * sorted. Ties in distance are broken by a position hash so two equally distant dead ends are
 * chosen in a seed-dependent — but reproducible — order.
 *
 * @param {Item[]} out         items are appended here (ids are assigned from `out.length`)
 * @param {number} quota
 * @param {Uint8Array} tiles
 * @param {number} width
 * @param {number} height
 * @param {Int32Array} dist    BFS distance from start, −1 = unreachable
 * @param {Uint8Array} occupied mutated: accepted tiles are marked
 * @param {import('../core/rng.js').Rng} rng
 * @returns {void}
 */
function placeGems(out, quota, tiles, width, height, dist, occupied, rng) {
  if (quota <= 0) return;
  const candidateBudget = Math.min(4096, Math.max(64, quota * 16));
  const tieSeed = rng.u32() | 0;

  // Pass 1 — histogram of dead-end distances (index = distance, value = how many).
  let maxDist = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i] > maxDist) maxDist = dist[i];
  const histogram = new Int32Array(maxDist + 1);
  let deadTotal = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      if (tiles[idx] !== TILE.FLOOR || occupied[idx] !== 0 || dist[idx] < 0) continue;
      if (floorNeighbours(tiles, width, idx) !== 1) continue;
      histogram[dist[idx]]++;
      deadTotal++;
    }
  }

  // Pass 2 — walk the histogram down from the farthest distance until the budget is covered.
  let cutoff = 0;
  let kept = 0;
  for (let d = maxDist; d >= 0; d--) {
    kept += histogram[d];
    if (kept >= candidateBudget) {
      cutoff = d;
      break;
    }
  }
  if (kept < candidateBudget) kept = deadTotal; // budget never reached: keep them all

  // Pass 3 — collect the survivors and order them farthest-first.
  const candidates = [];
  if (kept > 0) {
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const idx = row + x;
        if (tiles[idx] !== TILE.FLOOR || occupied[idx] !== 0 || dist[idx] < cutoff) continue;
        if (floorNeighbours(tiles, width, idx) !== 1) continue;
        candidates.push(idx);
      }
    }
    candidates.sort((a, b) => dist[b] - dist[a] || hash2(a, 0, tieSeed) - hash2(b, 0, tieSeed) || a - b);
  }

  let placed = 0;
  // Relaxing separation passes: prefer well-spread gems, but always meet the quota if tiles exist.
  for (let s = 0; s < GEM_SEPARATIONS.length && placed < quota; s++) {
    const sep = GEM_SEPARATIONS[s];
    for (let i = 0; i < candidates.length && placed < quota; i++) {
      const idx = candidates[i];
      if (occupied[idx] !== 0) continue;
      if (sep > 0 && !isFarFromItems(out, idx, width, sep)) continue;
      pushItem(out, occupied, 'gem', idx, width);
      placed++;
    }
  }

  // Degenerate mazes (1×2, 2×2 with a large gem quota) may not have enough dead ends; fall back to
  // any free floor tile so the level still contains the promised number of gems.
  for (let idx = 0; idx < tiles.length && placed < quota; idx++) {
    if (tiles[idx] !== TILE.FLOOR || occupied[idx] !== 0 || dist[idx] < 0) continue;
    pushItem(out, occupied, 'gem', idx, width);
    placed++;
  }
}

/**
 * True when `idx` is at least `sep` tiles (Chebyshev) from every item already placed.
 * O(items); the item list is bounded by `MAX_ITEMS_PER_KIND`, so this stays cheap.
 * @param {Item[]} items
 * @param {number} idx
 * @param {number} width
 * @param {number} sep
 * @returns {boolean}
 */
function isFarFromItems(items, idx, width, sep) {
  const x = idx % width;
  const y = (idx - x) / width;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // Item coordinates are tile centres, hence the −0.5 to recover the tile index.
    const dx = Math.abs(it.x - 0.5 - x);
    const dy = Math.abs(it.y - 0.5 - y);
    if (dx < sep && dy < sep) return false;
  }
  return true;
}

/**
 * Append an item at a tile index and mark the tile occupied.
 * @param {Item[]} out
 * @param {Uint8Array} occupied
 * @param {import('../core/types.js').ItemKind} kind
 * @param {number} idx
 * @param {number} width
 * @returns {void}
 */
function pushItem(out, occupied, kind, idx, width) {
  const x = idx % width;
  const y = (idx - x) / width;
  occupied[idx] = 1;
  out.push({ id: out.length, kind, x: x + 0.5, y: y + 0.5, taken: false });
}

/**
 * Oil flasks: on branches hanging off the solution path, spaced evenly along it.
 *
 * Flask k of n is anchored at the path tile at fraction (k+1)/(n+1) and searches the *stretch* of
 * path around that anchor (a non-overlapping window, so the flasks stay spread along the route).
 * A multi-source BFS seeded with every path tile in the window expands `OIL_BRANCH_RADIUS` tiles
 * and collects floor tiles that are **not** on the path; the closest of those wins. The flask
 * therefore lands on a side passage that opens off the route the player is already walking —
 * visible, one or two steps off, optional.
 *
 * Searching a window rather than a single tile matters: a long serpentine path can fill its own
 * neighbourhood completely, so a point search finds no branch at all surprisingly often.
 *
 * Fallbacks, in order: a free path tile near the anchor (a stretch that genuinely has no side
 * passage is a plain corridor, and a flask standing in it is still correct), then any free floor
 * tile (only reachable when the maze has no usable path at all).
 *
 * @param {Item[]} out
 * @param {number} quota
 * @param {Uint8Array} tiles
 * @param {number} width
 * @param {number} height
 * @param {Uint32Array|null} path
 * @param {Uint8Array} onPath
 * @param {Uint8Array} occupied
 * @param {import('../core/rng.js').Rng} rng
 * @returns {void}
 */
function placeOil(out, quota, tiles, width, height, path, onPath, occupied, rng) {
  if (quota <= 0) return;
  const total = width * height;
  const stamp = new Int32Array(total); // visited marker for the bounded BFS (stamp id per anchor)
  const frontier = new Int32Array(OIL_SCRATCH);
  const frontierDist = new Int32Array(OIL_SCRATCH);
  const found = new Int32Array(OIL_SCRATCH);
  const foundDist = new Int32Array(OIL_SCRATCH);
  let stampId = 0;
  let placed = 0;

  if (path && path.length > 0) {
    // Half-width of each flask's stretch of path: windows tile the route without overlapping.
    const half = Math.min(OIL_WINDOW_MAX, Math.max(0, Math.floor(path.length / (2 * (quota + 1)))));
    for (let k = 0; k < quota; k++) {
      const anchorPos = Math.min(path.length - 1, Math.round(((k + 1) * path.length) / (quota + 1)));
      stampId++;

      // Seed the multi-source BFS with the whole stretch of path around the anchor.
      let head = 0;
      let tail = 0;
      let nFound = 0;
      for (let i = Math.max(0, anchorPos - half); i <= Math.min(path.length - 1, anchorPos + half); i++) {
        const idx = path[i];
        if (stamp[idx] === stampId || tail >= OIL_SCRATCH) continue;
        stamp[idx] = stampId;
        frontier[tail] = idx;
        frontierDist[tail] = 0;
        tail++;
      }
      while (head < tail && nFound < OIL_SCRATCH) {
        const idx = frontier[head];
        const d0 = frontierDist[head];
        head++;
        if (d0 >= OIL_BRANCH_RADIUS) continue;
        const x = idx % width;
        const y = (idx - x) / width;
        for (let d = 0; d < DIR_COUNT; d++) {
          const nx = x + DIR_DX[d];
          const ny = y + DIR_DY[d];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (tiles[nIdx] !== TILE.FLOOR || stamp[nIdx] === stampId) continue;
          stamp[nIdx] = stampId;
          if (tail < OIL_SCRATCH) {
            frontier[tail] = nIdx;
            frontierDist[tail] = d0 + 1;
            tail++;
          }
          if (onPath[nIdx] === 0 && occupied[nIdx] === 0 && nFound < OIL_SCRATCH) {
            found[nFound] = nIdx;
            foundDist[nFound] = d0 + 1;
            nFound++;
          }
        }
      }

      if (nFound > 0) {
        // Keep only the closest branch tiles, then draw one: the flask ends up on the nearest
        // side passage rather than wherever the BFS happened to wander.
        let nearest = foundDist[0];
        for (let i = 1; i < nFound; i++) if (foundDist[i] < nearest) nearest = foundDist[i];
        let nClosest = 0;
        for (let i = 0; i < nFound; i++) if (foundDist[i] === nearest) found[nClosest++] = found[i];
        pushItem(out, occupied, 'oil', found[rng.int(nClosest)], width);
        placed++;
        continue;
      }
      // No branch nearby: walk outward along the path for the closest free tile.
      let fallback = -1;
      for (let step = 0; step < path.length && fallback < 0; step++) {
        const a = anchorPos + step;
        const b = anchorPos - step;
        if (a < path.length && occupied[path[a]] === 0) fallback = path[a];
        else if (b >= 0 && occupied[path[b]] === 0) fallback = path[b];
      }
      if (fallback >= 0) {
        pushItem(out, occupied, 'oil', fallback, width);
        placed++;
      }
    }
  }

  // Last resort (unsolvable maze, or a path with no room left): any free floor tile.
  for (let idx = 0; idx < total && placed < quota; idx++) {
    if (tiles[idx] !== TILE.FLOOR || occupied[idx] !== 0) continue;
    pushItem(out, occupied, 'oil', idx, width);
    placed++;
  }
}

/**
 * Wall torches on corridor walls, at least `TORCH_SPACING` tiles apart.
 *
 * Two scans of the floor tiles: the first only accepts tiles whose position hash passes a 1-in-4
 * test (this jitters *which* tile in a region carries the torch, killing the top-left bias a plain
 * row-major scan would produce), the second fills any region the first left dark.
 *
 * Spacing is measured between the **mount (wall) tiles**, which is where the renderer puts the
 * light, and the candidate's mount is therefore chosen *before* the spacing test. Because any two
 * accepted mounts differ by ≥ `TORCH_SPACING` on at least one axis, a bucket grid of exactly that
 * pitch holds at most one torch per bucket, and testing the 3×3 bucket neighbourhood is not an
 * approximation but an exact answer — O(1) per tile, O(tiles) overall.
 *
 * @param {Uint8Array} tiles
 * @param {number} width
 * @param {number} height
 * @param {number} seed int32 hash seed
 * @returns {Torch[]}
 */
function placeTorches(tiles, width, height, seed) {
  /** @type {Torch[]} */
  const torches = [];
  const gw = Math.ceil(width / TORCH_SPACING);
  const gh = Math.ceil(height / TORCH_SPACING);
  const grid = new Int32Array(gw * gh).fill(-1);

  for (let pass = 0; pass < 2; pass++) {
    for (let y = 1; y < height - 1 && torches.length < MAX_TORCHES; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1 && torches.length < MAX_TORCHES; x++) {
        const idx = row + x;
        if (tiles[idx] !== TILE.FLOOR) continue;
        const h = hash2(x, y, seed);
        if (pass === 0 && (h & 3) !== 0) continue;

        // Pick the mount: the first walled side, starting from a hash-chosen direction so straight
        // corridors alternate sides instead of lighting one wall for their whole length.
        const startDir = (h >>> 8) & 3;
        let wx = -1;
        let wy = -1;
        let face = 0;
        for (let i = 0; i < DIR_COUNT; i++) {
          const d = (startDir + i) & 3;
          const cx = x + DIR_DX[d];
          const cy = y + DIR_DY[d];
          if (tiles[cy * width + cx] !== TILE.WALL) continue;
          wx = cx;
          wy = cy;
          face = DIR_OPPOSITE[d];
          break;
        }
        if (wx < 0) continue; // an open junction with no wall to mount on

        if (!torchSpotFree(torches, grid, gw, gh, wx, wy)) continue;
        grid[((wy / TORCH_SPACING) | 0) * gw + ((wx / TORCH_SPACING) | 0)] = torches.length;
        torches.push({ x: wx, y: wy, face: /** @type {0|1|2|3} */ (face) });
      }
    }
  }
  return torches;
}

/**
 * True when no existing torch lies within `TORCH_SPACING` tiles (Chebyshev) of the mount (x,y).
 * @param {Torch[]} torches
 * @param {Int32Array} grid   bucket → torch index, −1 when empty
 * @param {number} gw
 * @param {number} gh
 * @param {number} x          mount (wall) tile x
 * @param {number} y          mount (wall) tile y
 * @returns {boolean}
 */
function torchSpotFree(torches, grid, gw, gh, x, y) {
  const gx = (x / TORCH_SPACING) | 0;
  const gy = (y / TORCH_SPACING) | 0;
  for (let by = gy - 1; by <= gy + 1; by++) {
    if (by < 0 || by >= gh) continue;
    for (let bx = gx - 1; bx <= gx + 1; bx++) {
      if (bx < 0 || bx >= gw) continue;
      const t = grid[by * gw + bx];
      if (t < 0) continue;
      const other = torches[t];
      if (Math.abs(other.x - x) < TORCH_SPACING && Math.abs(other.y - y) < TORCH_SPACING) return false;
    }
  }
  return true;
}
