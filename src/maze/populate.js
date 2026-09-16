// @ts-check
/**
 * @file Level population: oil flasks, gems, wall torches, and the torch **tank** + par budget
 * (ARCHITECTURE.md §4.4). Pure, deterministic, Node- and worker-safe.
 *
 * Everything here is a function of `(maze, validation, params, seed)` only — no clocks, no
 * `Math.random`, no DOM — so a level is byte-identical on every machine and can be rebuilt from a
 * seed instead of stored.
 *
 * ## The massive-maze torch economy (why this file was rewritten)
 * Levels now run from 16×16 cells (33×33 tiles) to 128×128 cells (257×257 tiles, 16 384 cells,
 * ~33 000 floor tiles). A tank sized to cover a whole level would turn a 20-minute labyrinth into
 * one long countdown that is decided in its first minute. So the torch is a **small tank you must
 * keep refilling**:
 *
 * - `fuel` is a **tank size**, independent of maze area (~110 s early, ~150 s at the size cap).
 *   `src/state/balance.js` owns the curve and passes it as `params.fuelSeconds`; this file only
 *   supplies a documented fallback for callers that do not (tests, tools, the title demo).
 * - **Oil flasks are the economy.** Their count scales with *area* so their density is roughly
 *   constant (~1 per 20 cells early, thinning to ~1 per 30 at the cap), and each restores ~35 % of
 *   the tank. The player therefore meets the "I need oil" moment every 60–90 s at every maze size.
 * - The **refuel chain** below is the guarantee that makes that fair.
 *
 * ## Placement rules (the "why"; the "what" is on each function)
 * - **Oil flasks** are placed in two passes. The *chain* pass walks the solution path and drops a
 *   flask (on the path, or on a side passage within {@link OIL_BRANCH_RADIUS} tiles of it) before
 *   the gap since the last one could ever exceed the tank's honest reach. The *scatter* pass then
 *   tops the level up to its density quota, preferring branches just off the route, so exploring
 *   pays and the route itself is never a fuel desert.
 * - **Gems** are the score currency: dead ends first, then tiles far from the solution path — the
 *   reward for the risk of leaving the route. They are scattered by area density so a 128×128 maze
 *   is not a 16×16 maze with the same handful of gems in it.
 * - **The map scroll** (exactly one, §4.8) is placed last, at the end of a dead-end branch off the
 *   solution path — see {@link placeMapScroll}. It is not oil, so the refuel chain and
 *   {@link walkRefuelChain} never see it, and its own RNG fork leaves oil/gem placement unchanged.
 * - **Torches** are mounted on corridor walls at least {@link TORCH_SPACING} tiles apart, so the
 *   renderer's point lights never stack up into a flat, evenly lit room, and so the count stays
 *   proportional to floor area rather than to tile count.
 *
 * ## THE REFUEL CHAIN GUARANTEE (proof)
 * Let
 *   - `T`  = tank size in seconds (`fuel`),
 *   - `R`  = seconds one flask restores (~0.35·T, clamped — mirrors `FUEL.OIL_*` in balance.js),
 *   - `spt` = fuel-seconds burned per tile actually walked = `c/v · drain`, where `v` =
 *            {@link WALK_SPEED}, `c` = {@link CORNER_FACTOR} (turn/accel overhead) and `drain` is
 *            the level's torch-drain multiplier (1 up to the size cap, `params.drain` past it),
 *   - `w`  = {@link WANDER_FACTOR} = 2.0, the "competent player who cannot see the maze" factor:
 *            advancing one tile *along the solution path* costs `w` tiles of actual walking,
 *   - `k`  ≤ {@link OIL_BRANCH_RADIUS} = the flask's distance off the path (walked out and back, so
 *            `2k` extra tiles, at no wander penalty — the player can see the flask by then).
 *
 * Advancing `d` path tiles and detouring `k` off it costs `t(d,k) = (d·w + 2k)·spt` fuel-seconds.
 * The chain pass places flasks so that **every** consecutive pair — and the start→first and
 * last→exit segments — satisfies
 *
 *     Δq = (path index advanced) ≤ G,   where  G = ⌊(R·S/spt − 2·OIL_BRANCH_RADIUS) / w⌋
 *
 * (`S` = {@link CHAIN_SAFETY}; `G` is `params.oilTargetGap` when the state module supplies a
 * *tighter* one — see {@link resolveGap}). By construction `t(G, k) ≤ R·S ≤ R` for every `k ≤ 3`.
 *
 * **Claim.** A player who walks the solution path with wander factor `w` and takes each chain flask
 * never runs dry.
 * **Proof.** Induction over the chain. Fuel at the start (q = 0) is `T`. If fuel on reaching flask
 * `i` is `T`, the walk to flask `i+1` costs `t(Δq, k) ≤ R ≤ 0.35·T < T`, so the player arrives with
 * `T − t ≥ T − R > 0` — never zero — and the flask restores `min(T, (T−t) + R) = T`, re-establishing
 * the hypothesis. The final segment costs `≤ R` as well, so the exit is reached with `≥ T − R > 0`. ∎
 *
 * Two notes on rigour. (1) The flask a player actually picks up first is the one reachable at the
 * *smallest* path index, which is exactly what {@link nearestPathFrom} measures, so placement and
 * verification agree on where a flask "is". (2) Extra scatter flasks can only shrink a gap: they
 * split `Δq` and add fuel, and fuel is clamped to the tank, so they can never invalidate the chain.
 * `tools/validate-mazes.mjs` re-checks both the gap bound and a walked-fuel simulation for levels
 * 1..30 across ≥ 25 seeds each; a level where the chain cannot be walked is a release blocker.
 *
 * ## Cost at the gameplay maximum (128×128 cells = 257×257 tiles)
 * Five `Int32Array(width·height)` scratch buffers (~1.3 MB, all released on return), a handful of
 * O(tiles) passes, and ≤ {@link MAX_ITEMS_PER_KIND} items per kind. No pass is O(items²).
 *
 * `WALK_SPEED`, `CORNER_FACTOR` and the oil-refuel constants duplicate knowledge owned by
 * `src/state/balance.js`; `src/maze` may not import `src/state` (ARCHITECTURE.md §2), so they live
 * here as documented, independently tunable **mirrors**. `params.fuelSeconds`, `params.oilRefuelSeconds`
 * and `params.oilTargetGap` are the seams through which the state module overrides them.
 */

import { createRng, hash2 } from '../core/rng.js';
import { clamp } from '../core/math.js';
import { TILE, DIR_COUNT, DIR_DX, DIR_DY, DIR_OPPOSITE, MAP_MIN_DETOUR_TILES } from './constants.js';

/** @typedef {import('../core/types.js').Maze} Maze */
/** @typedef {import('../core/types.js').Validation} Validation */
/** @typedef {import('../core/types.js').Item} Item */
/** @typedef {import('../core/types.js').ItemKind} ItemKind */
/** @typedef {import('../core/types.js').Torch} Torch */

/**
 * Tuning knobs for {@link populateLevel}, as produced by `levelParams(level)` in
 * `src/state/balance.js`. **Every field is optional**: this module is never blocked by a state
 * module that has not shipped a field yet, it falls back to the documented curves below. Extra
 * properties are ignored.
 * @typedef {Object} PopulateParams
 * @property {number} [cells]        logical cell count (`cols·rows`); only used to size fallbacks
 * @property {number} [gems]         gem count. Preferred over `gemDensity` — see {@link resolveCount}
 * @property {number} [oil]          flask count, a **floor**: the refuel chain may place more when
 *   the level needs them
 * @property {number} [gemDensity]   gems per cell (≤ 1) **or** cells per gem (> 1); used when no
 *   explicit `gems` is given
 * @property {number} [oilDensity]   flasks per cell (≤ 1) **or** cells per flask (> 1); used when no
 *   explicit `oil` is given
 * @property {number} [oilTargetGap] maximum path tiles between consecutive reachable flasks. Honoured
 *   when it is *tighter* than this module's sustainable bound (see {@link resolveGap}).
 * @property {number} [oilRefuelSeconds] seconds one flask restores (mirror of `oilFuel(fuelMax)`)
 * @property {number} [drain]        torch-drain multiplier (> 1 past the size cap); 1 when absent
 * @property {number} [fuelSeconds]  **the tank size in seconds.** ≤ 0 or non-finite ⇒ use the
 *   fallback curve in {@link tankFor}
 * @property {number} [par=0]        floor for the derived par time, in seconds
 */

/**
 * What {@link populateLevel} produces. `fuel`/`par` are seconds and are copied straight into
 * `LevelData` by `buildLevel`.
 * @typedef {Object} Population
 * @property {Item[]} items
 * @property {Torch[]} torches
 * @property {number} fuel    tank size in seconds (`run.fuelMax`)
 * @property {number} par
 */

/**
 * Fuel/par budget and the numbers the refuel chain is built from.
 * @typedef {Object} FuelBudget
 * @property {number} fuel       tank size, seconds
 * @property {number} par        target completion time, seconds (a `w`-wander run down the path)
 * @property {number} directTime seconds a *perfect* run down the solution path takes
 * @property {number} usage      `directTime / fuel` — **tanks burned by a perfect run.** Above 1.0
 *   for any large maze; that is the design, not a bug (the player refuels on the way).
 * @property {number} reach      path tiles one full tank covers at `WANDER_FACTOR` and this level's drain
 * @property {number} refuel     seconds one flask restores
 * @property {number} gap        the refuel-chain gap actually used, in path tiles
 */

// ─── Mirrored gameplay constants (see the file header) ───────────────────────────────────────

/** Nominal sustained walking speed, tiles per second (no sprint). Mirrors `PLAYER.WALK_SPEED`. */
const WALK_SPEED = 3.2;

/** Multiplier on the direct route time for turning, acceleration and wall-hugging overhead. */
const CORNER_FACTOR = 1.18;

/**
 * How much a competent player who cannot see the maze actually walks per tile of progress along
 * the solution path. 2.0 = "one wrong turn, discovered and reversed, per corridor". Every fuel
 * promise in this file is made at this factor; the validator re-checks them at it.
 */
const WANDER_FACTOR = 2;

/** Safety margin applied to the refuel-chain gap: the wander model is nominal, players are not. */
const CHAIN_SAFETY = 0.9;

/** Tank size on the smallest gameplay maze, seconds (side ≤ {@link TANK_SIDE_LO} cells). */
const TANK_MIN_SECONDS = 110;

/** Tank size at and past the size cap, seconds (side ≥ {@link TANK_SIDE_HI} cells). */
const TANK_MAX_SECONDS = 150;

/** Cell side at which the fallback tank curve starts (level 1 of the shipped curve). */
const TANK_SIDE_LO = 16;

/** Cell side at which the fallback tank curve tops out (the shipped `LEVEL.MAX_CELLS`). */
const TANK_SIDE_HI = 128;

/** Fraction of the tank one oil flask restores. Mirrors `FUEL.OIL_FRACTION`. */
const OIL_REFUEL_FRACTION = 0.35;

/** Lower clamp on a flask's value, seconds. Mirrors `FUEL.OIL_MIN`. */
const OIL_REFUEL_MIN = 25;

/** Upper clamp on a flask's value, seconds. Mirrors `FUEL.OIL_MAX`. */
const OIL_REFUEL_MAX = 60;

/**
 * Measured ratio between a maze's optimal route and its side in cells (13 path tiles per cell of
 * side, across the whole shipped size range). Only used to guess `cells` when a caller gives
 * neither `params.cells` nor a maze — i.e. in `fuelBudget()` called bare from a tool or a test.
 */
const PATH_TILES_PER_CELL_SIDE = 13;

// ─── Population knobs ───────────────────────────────────────────────────────────────────────

/** Fallback flask density on a small maze: one per this many cells. */
const OIL_CELLS_PER_FLASK_LO = 20;

/** Fallback flask density at the size cap: one per this many cells (the economy thins with depth). */
const OIL_CELLS_PER_FLASK_HI = 30;

/** Fallback gem density on a small maze: one per this many cells. */
const GEM_CELLS_PER_GEM_LO = 50;

/** Fallback gem density at the size cap: one per this many cells. */
const GEM_CELLS_PER_GEM_HI = 60;

/** How far off the solution path an oil flask may be planted (tiles). */
const OIL_BRANCH_RADIUS = 3;

/**
 * Hard cap on items of one kind. The gameplay maximum needs ~550 flasks and ~300 gems; 4096 leaves
 * three levels of headroom for a tool building something far past the shipped curve while keeping
 * the worst case bounded (4096 items ≈ 260 KB of `Item` objects in V8 — see `tools/stress.mjs`).
 */
const MAX_ITEMS_PER_KIND = 4096;

/** Minimum Chebyshev tile distance between two torches. */
const TORCH_SPACING = 6;

/** Hard cap on torches so a huge maze cannot produce a million sprite objects. */
const MAX_TORCHES = 4096;

/** Absolute floor on a level's tank, seconds — enough to orient even in a 1×1 test maze. */
const MIN_FUEL = 20;

/** Absolute ceiling on a level's tank, seconds (a stress-test maze would otherwise ask for hours). */
const MAX_FUEL = 3600;

/**
 * Capacity of the bounded-BFS scratch used by the chain pass. A radius-3 flood over a thick-wall
 * maze can reach at most 25 tiles (the L1 ball), so 64 is more than twice the headroom needed and
 * every push is still bounds-checked.
 */
const PROBE_SCRATCH = 64;

/**
 * The map scroll's branch must leave the solution path within this fraction of the route (by path
 * index), so the map is found while there is still most of the level left to use it on (§4.8).
 */
const MAP_JUNCTION_WINDOW = 0.6;

// ─── Fuel budget ─────────────────────────────────────────────────────────────────────────────

/**
 * Round to one decimal place (fuel and par are displayed to a tenth of a second).
 * @param {number} v
 * @returns {number}
 */
function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Fallback tank size for a maze of `cells` cells, seconds.
 *
 * The tank is deliberately **almost** flat: it is a tank, not a level budget. The small rise with
 * size buys the deeper levels a slightly longer leash between flasks, which is what keeps a 257×257
 * maze from feeling like the same 110 s panic with more corners.
 *
 * @param {number} cells logical cell count
 * @returns {number} seconds in [TANK_MIN_SECONDS, TANK_MAX_SECONDS]
 */
function tankFor(cells) {
  const side = Math.sqrt(Math.max(1, cells));
  const t = clamp((side - TANK_SIDE_LO) / (TANK_SIDE_HI - TANK_SIDE_LO), 0, 1);
  return TANK_MIN_SECONDS + (TANK_MAX_SECONDS - TANK_MIN_SECONDS) * t;
}

/**
 * Seconds one oil flask restores on a level with tank `tank`.
 * @param {PopulateParams|undefined} params
 * @param {number} tank
 * @returns {number} seconds in (0, tank]
 */
function resolveRefuel(params, tank) {
  const given = Number(params?.oilRefuelSeconds);
  if (Number.isFinite(given) && given > 0) return Math.min(given, tank);
  return Math.min(tank, clamp(tank * OIL_REFUEL_FRACTION, OIL_REFUEL_MIN, OIL_REFUEL_MAX));
}

/**
 * Fuel-seconds burned per tile actually walked, at the level's drain multiplier.
 *
 * Past the size cap a level gets harder by burning the torch faster (`drain > 1`), which shortens
 * every distance this module reasons about. Read defensively: a missing or nonsensical `drain` is
 * 1, which is the shipped value for every level up to the cap.
 *
 * @param {PopulateParams|undefined} params
 * @returns {number} seconds per walked tile
 */
function secondsPerTile(params) {
  const drain = Number(/** @type {{drain?:number}} */ (params)?.drain);
  const d = Number.isFinite(drain) && drain > 0 ? drain : 1;
  return (CORNER_FACTOR * d) / WALK_SPEED;
}

/**
 * The refuel-chain gap: the largest path advance allowed between two consecutive reachable flasks.
 *
 * Derivation (file header): one flask must pay for the walk to the next one, including the worst
 * legal detour off the path, at {@link WANDER_FACTOR} and the level's drain:
 *
 *     (G·w + 2·OIL_BRANCH_RADIUS)·spt ≤ R·S   ⇒   G = ⌊(R·S/spt − 2·OIL_BRANCH_RADIUS) / w⌋
 *
 * `params.oilTargetGap` (owned by `src/state/balance.js`) may **tighten** this, never loosen it:
 * a looser gap would silently break the guarantee this module exists to make, and an unwalkable
 * chain is a blocker, not a balance choice. A state module that wants a longer leash must hand out
 * a bigger tank or richer flasks — both of which move `G` honestly.
 *
 * @param {PopulateParams|undefined} params
 * @param {number} refuel seconds one flask restores
 * @returns {number} integer ≥ 1, path tiles
 */
function resolveGap(params, refuel) {
  const spt = secondsPerTile(params);
  const sustainable = Math.max(
    1,
    Math.floor(((refuel * CHAIN_SAFETY) / spt - 2 * OIL_BRANCH_RADIUS) / WANDER_FACTOR),
  );
  const asked = Number(params?.oilTargetGap);
  if (Number.isFinite(asked) && asked >= 1) return Math.max(1, Math.min(Math.floor(asked), sustainable));
  return sustainable;
}

/**
 * Tank, par and the chain numbers for a level. Exported so `src/state` and the headless tools can
 * reason about the economy without re-deriving it.
 *
 * **Contract change (massive mazes):** `fuel` is now a *tank size*, not a level budget, and
 * `params.fuelSeconds` **is** that tank (it used to be a floor under a path-derived budget). A
 * caller that supplies no `fuelSeconds` gets the documented fallback curve in {@link tankFor}.
 * `usage` therefore means "tanks a perfect run burns" and is routinely > 1 — see {@link FuelBudget}.
 *
 * @param {number} pathLength shortest start→exit distance in tiles (`Validation.pathLength`);
 *   values ≤ 0 (unsolvable maze) are treated as 1
 * @param {PopulateParams} [params] per-level overrides
 * @param {number} [cells] logical cell count; defaults to `params.cells`, then to an estimate from
 *   `pathLength` ({@link PATH_TILES_PER_CELL_SIDE})
 * @returns {FuelBudget}
 */
export function fuelBudget(pathLength, params, cells) {
  const len = Number.isFinite(pathLength) && pathLength > 0 ? pathLength : 1;
  const directTime = (len * CORNER_FACTOR) / WALK_SPEED;

  let n = Number(cells);
  if (!Number.isFinite(n) || n <= 0) n = Number(params?.cells);
  if (!Number.isFinite(n) || n <= 0) {
    const side = Math.max(1, len / PATH_TILES_PER_CELL_SIDE);
    n = side * side;
  }

  const asked = Number(params?.fuelSeconds);
  const fuel = clamp(Number.isFinite(asked) && asked > 0 ? asked : tankFor(n), MIN_FUEL, MAX_FUEL);
  const refuel = resolveRefuel(params, fuel);
  const gap = resolveGap(params, refuel);

  // Par is what a competent run costs: the optimal route walked at the same wander factor every
  // fuel promise in this file is made at. It is NOT clamped to the tank any more — on a big maze a
  // run legitimately spans several tanks.
  let par = directTime * WANDER_FACTOR;
  const parFloor = Number(params?.par);
  if (Number.isFinite(parFloor) && parFloor > par) par = parFloor;

  return {
    fuel: round1(fuel),
    par: round1(par),
    directTime: round1(directTime),
    usage: Math.round((directTime / fuel) * 1e4) / 1e4,
    reach: Math.floor(fuel / (WANDER_FACTOR * secondsPerTile(params))),
    refuel: round1(refuel),
    gap,
  };
}

// ─── Item counts ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve one item count from the level parameters — a count, a density, or neither.
 *
 * Priority, and why:
 * 1. **An explicit count** (`params.gems` / `params.oil`) — *including an explicit 0*, which means
 *    "none", not "unspecified". `src/state/balance.js` derives the count from its own density and
 *    then clamps it (`GEM_MIN`…`GEM_MAX`), so the count it ships is the density *plus* information
 *    this module does not have. Re-deriving from the raw density would quietly undo those clamps.
 * 2. **The density**, read defensively in both plausible units because the field is owned by a
 *    module that ships in parallel: a value ≤ 1 is read as *items per cell* (0.05 ⇒ one per 20
 *    cells) and a value > 1 as *cells per item* (20 ⇒ the same). The two agree at 1.0, so there is
 *    no ambiguous case.
 * 3. **The fallback curve below**, keyed on maze size, so a level is never under-populated just
 *    because a parameter has not landed yet.
 *
 * Whatever comes out is a *floor* for oil: the refuel chain may place more (see the file header).
 *
 * @param {unknown} density  `params.gemDensity` / `params.oilDensity`
 * @param {unknown} explicit `params.gems` / `params.oil`
 * @param {number} cells     logical cell count
 * @param {number} perLo     fallback cells-per-item on a small maze
 * @param {number} perHi     fallback cells-per-item at the size cap
 * @returns {number} integer in [0, MAX_ITEMS_PER_KIND]
 */
function resolveCount(density, explicit, cells, perLo, perHi) {
  const e = Number(explicit);
  if (explicit !== undefined && explicit !== null && Number.isFinite(e) && e >= 0) {
    return clamp(Math.floor(e), 0, MAX_ITEMS_PER_KIND);
  }
  const d = Number(density);
  if (Number.isFinite(d) && d > 0) {
    const n = d <= 1 ? cells * d : cells / d;
    return clamp(Math.round(n), 0, MAX_ITEMS_PER_KIND);
  }

  // Fallback: the same "thins out with depth" curve the design asks for, keyed on cell side so it
  // tracks the size cap rather than a level number this module does not know.
  const side = Math.sqrt(Math.max(1, cells));
  const t = clamp((side - TANK_SIDE_LO) / (TANK_SIDE_HI - TANK_SIDE_LO), 0, 1);
  const per = perLo + (perHi - perLo) * t;
  return clamp(Math.round(cells / per), 0, MAX_ITEMS_PER_KIND);
}

// ─── Population ──────────────────────────────────────────────────────────────────────────────

/**
 * The per-call working set. One fixed-shape object so every helper below stays monomorphic, and
 * one place to see the entire transient memory cost of a build.
 * @typedef {Object} Ctx
 * @property {Uint8Array} tiles
 * @property {number} width
 * @property {number} height
 * @property {number} total          `width · height`
 * @property {Uint8Array} occupied   1 = reserved or already carrying an item
 * @property {Int32Array} pathDist   tiles to the nearest solution-path tile; −1 = wall/unreachable
 * @property {Int32Array} pathIndexOf index into `validation.path`, −1 when the tile is not on it
 * @property {Int32Array} stamp      visited marker for the bounded probes (one id per probe)
 * @property {number} stampId
 * @property {Int32Array} frontier      probe BFS queue (tile index)
 * @property {Int32Array} frontierDist  probe BFS queue (depth)
 * @property {Int32Array} cand          candidate tiles collected by one chain probe
 * @property {Int32Array} out2          two-slot return buffer (tile index, path index)
 */

/**
 * Place items and torches, and compute the level's tank/par budget.
 *
 * Deterministic for a given `(maze, validation, params, seed)`. Items are placed on FLOOR tiles
 * only and never twice on the same tile — `tools/validate-mazes.mjs` asserts both, plus the refuel
 * chain, for every level it builds.
 *
 * Cost: O(width·height) plus O(path length) — no pass is quadratic in the item count.
 *
 * @param {Maze} maze
 * @param {Validation} validation result of `validateMaze(maze)` (its `path` drives the refuel chain)
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

  // Cell count: from the maze itself (authoritative), not from params — a caller may hand us
  // `cells` from a different level entirely and the densities must follow the maze in front of us.
  const cols = Number.isFinite(maze.cols) && maze.cols > 0 ? maze.cols : (width - 1) >> 1;
  const rows = Number.isFinite(maze.rows) && maze.rows > 0 ? maze.rows : (height - 1) >> 1;
  const cells = Math.max(1, cols * rows);

  const rootSeed = Number.isFinite(Number(seed)) ? Number(seed) : 0;
  const root = createRng(rootSeed);
  const chainRng = root.fork('items.oil.chain');
  const oilRng = root.fork('items.oil');
  const gemRng = root.fork('items.gem');
  // `fork` depends only on the root identity and the salt, never on draws, so this stream is
  // independent of — and invisible to — the oil and gem streams above.
  const mapSeed = root.fork('items.map').u32() | 0;
  const torchSeed = root.fork('torches').u32() | 0;

  const budget = fuelBudget(validation && validation.pathLength > 0 ? validation.pathLength : 1, params, cells);

  const path = validation && validation.path && validation.path.length > 0 ? validation.path : null;

  /** @type {Ctx} */
  const ctx = {
    tiles,
    width,
    height,
    total,
    occupied: new Uint8Array(total),
    pathDist: new Int32Array(total),
    pathIndexOf: new Int32Array(total),
    stamp: new Int32Array(total),
    stampId: 0,
    frontier: new Int32Array(PROBE_SCRATCH),
    frontierDist: new Int32Array(PROBE_SCRATCH),
    cand: new Int32Array(PROBE_SCRATCH),
    out2: new Int32Array(2),
  };

  // `occupied` is the single source of truth for "something is already on this tile": it starts out
  // reserving the tiles gameplay needs kept clear, so no later pass can double-book a tile.
  const occupied = ctx.occupied;
  occupied[start.y * width + start.x] = 1;
  occupied[exit.y * width + exit.x] = 1;
  if (path) {
    // No pickups on the first three tiles of the route: they would be free score at spawn.
    for (let i = 0; i < 3 && i < path.length; i++) occupied[path[i]] = 1;
  }

  buildPathFields(ctx, path);

  /** @type {Item[]} */
  const items = [];

  // 1. The guarantee first — it has the only hard constraint, so it gets first pick of the tiles.
  const chain = path ? placeRefuelChain(items, ctx, path, budget.gap, chainRng) : 0;

  // 2. Density top-up. `oil`/`gems` from params are floors, never ceilings: the chain may already
  //    have placed more flasks than a stale count asked for, and we never take one away.
  const oilTopUp =
    resolveCount(params?.oilDensity, params?.oil, cells, OIL_CELLS_PER_FLASK_LO, OIL_CELLS_PER_FLASK_HI) - chain;
  const oil = scatterByBuckets(items, 'oil', oilTopUp, ctx, false, oilRng);
  if (oil < oilTopUp) fillByStride(items, 'oil', oilTopUp - oil, ctx, oilRng);

  // 3. Gems: dead ends first, then anywhere off the beaten track.
  const gemQuota = resolveCount(params?.gemDensity, params?.gems, cells, GEM_CELLS_PER_GEM_LO, GEM_CELLS_PER_GEM_HI);
  let gems = scatterByBuckets(items, 'gem', gemQuota, ctx, true, gemRng);
  if (gems < gemQuota) gems += scatterByBuckets(items, 'gem', gemQuota - gems, ctx, false, gemRng);
  if (gems < gemQuota) fillByStride(items, 'gem', gemQuota - gems, ctx, gemRng);

  // 4. The hidden map scroll (§4.8) — last, so it can never displace a flask or a gem, and on its
  //    own forked stream so adding it left every oil/gem position for a given seed unchanged.
  const askedGap = Number(params?.oilTargetGap);
  const mapGap = Number.isFinite(askedGap) && askedGap >= 1 ? Math.floor(askedGap) : budget.gap;
  placeMapScroll(items, ctx, path, Math.floor(mapGap / 4), mapSeed);

  const torches = placeTorches(tiles, width, height, torchSeed);

  return { items, torches, fuel: budget.fuel, par: budget.par };
}

/**
 * Walk a populated level the way the guarantee promises and report what actually happens.
 *
 * This is the **verification twin** of {@link placeRefuelChain}, and it ships in the module rather
 * than in the tool on purpose: a guarantee is only as good as the agreement between the code that
 * makes it and the code that checks it, and "where along the route is this flask?" is exactly the
 * kind of definition two files drift on. `tools/validate-mazes.mjs` and `populate.test.mjs` both
 * call this, so there is one answer.
 *
 * The simulated player walks the solution path at {@link WANDER_FACTOR}, and picks up every flask
 * the moment it comes within {@link OIL_BRANCH_RADIUS} tiles of them (paying `2·depth` tiles for
 * the detour). Flasks further off the route are ignored — they are exploration upside, and counting
 * them would weaken the very bound this function exists to measure.
 *
 * Allocates O(width·height); it is a tool/test helper, never called by the game.
 *
 * @param {Maze} maze
 * @param {Validation} validation
 * @param {Item[]} items
 * @param {PopulateParams} [params] the same params the level was built with
 * @returns {{flasks:number, maxGap:number, gap:number, tank:number, refuel:number, walked:number,
 *   minFuel:number, minFuelFraction:number, ok:boolean}} `walked` is in tiles; `ok` is the verdict
 *   (`maxGap ≤ gap` and the torch never reached 0). An unsolvable maze reports `ok:false`.
 */
export function walkRefuelChain(maze, validation, items, params) {
  const width = maze.width;
  const total = width * maze.height;
  const path = validation && validation.path && validation.path.length > 0 ? validation.path : null;
  const cols = Number.isFinite(maze.cols) && maze.cols > 0 ? maze.cols : (width - 1) >> 1;
  const rows = Number.isFinite(maze.rows) && maze.rows > 0 ? maze.rows : (maze.height - 1) >> 1;
  const budget = fuelBudget(validation ? validation.pathLength : 1, params, Math.max(1, cols * rows));
  const empty = {
    flasks: 0,
    maxGap: -1,
    gap: budget.gap,
    tank: budget.fuel,
    refuel: budget.refuel,
    walked: 0,
    minFuel: budget.fuel,
    minFuelFraction: 1,
    ok: false,
  };
  if (!path) return empty;

  /** @type {Ctx} */
  const ctx = {
    tiles: maze.tiles,
    width,
    height: maze.height,
    total,
    occupied: new Uint8Array(0),
    pathDist: new Int32Array(total),
    pathIndexOf: new Int32Array(total),
    stamp: new Int32Array(total),
    stampId: 0,
    frontier: new Int32Array(PROBE_SCRATCH),
    frontierDist: new Int32Array(PROBE_SCRATCH),
    cand: new Int32Array(PROBE_SCRATCH),
    out2: new Int32Array(2),
  };
  buildPathFields(ctx, path);

  // Collect (path index, detour) for every flask the route passes, then sort by path index: the
  // order the player meets them in.
  const hits = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== 'oil') continue;
    const idx = (it.y - 0.5) * width + (it.x - 0.5);
    if (!Number.isInteger(idx) || idx < 0 || idx >= total) continue;
    const packed = nearestPathFrom(ctx, idx, OIL_BRANCH_RADIUS);
    if (packed < 0) continue;
    hits.push({ q: (packed / 4) | 0, d: packed & 3 });
  }
  hits.sort((a, b) => a.q - b.q || a.d - b.d);

  const secPerTile = secondsPerTile(params);
  const last = path.length - 1;
  let fuel = budget.fuel;
  let minFuel = fuel;
  let walked = 0;
  let maxGap = 0;
  let prev = 0;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (h.q < prev) continue; // already passed (two flasks on the same stretch)
    const tiles = (h.q - prev) * WANDER_FACTOR + 2 * h.d;
    if (h.q - prev > maxGap) maxGap = h.q - prev;
    walked += tiles;
    fuel -= tiles * secPerTile;
    if (fuel < minFuel) minFuel = fuel;
    fuel = Math.min(budget.fuel, fuel + budget.refuel);
    prev = h.q;
  }
  const tail = last - prev;
  if (tail > maxGap) maxGap = tail;
  walked += tail * WANDER_FACTOR;
  fuel -= tail * WANDER_FACTOR * secPerTile;
  if (fuel < minFuel) minFuel = fuel;

  return {
    flasks: hits.length,
    maxGap,
    gap: budget.gap,
    tank: budget.fuel,
    refuel: budget.refuel,
    walked: Math.round(walked),
    minFuel: round1(minFuel),
    minFuelFraction: Math.round((minFuel / budget.fuel) * 1e4) / 1e4,
    ok: maxGap <= budget.gap && minFuel > 0,
  };
}

/**
 * Fill `pathIndexOf` (tile → index along the solution path) and `pathDist` (tiles to the nearest
 * path tile) with one multi-source BFS seeded from every path tile.
 *
 * Both fields exist because at 16 000 cells "near the route" and "off the beaten track" are the
 * only meaningful ways to rank a tile: distance from the *start* stopped being informative once a
 * level became a labyrinth rather than an out-and-back.
 *
 * With no path (an unsolvable maze — only reachable through a hand-built test fixture, since
 * `buildLevel` refuses to populate one) every tile reports distance 0 and index −1, which degrades
 * the scatter passes to "spread evenly, no preference" instead of throwing.
 *
 * @param {Ctx} ctx
 * @param {Uint32Array|null} path
 * @returns {void}
 */
function buildPathFields(ctx, path) {
  const { tiles, width, height, total, pathDist, pathIndexOf } = ctx;
  pathIndexOf.fill(-1);
  if (!path || path.length === 0) {
    pathDist.fill(0);
    return;
  }
  pathDist.fill(-1);

  // The queue holds at most every floor tile once; sizing it at `total` costs 4 bytes per tile for
  // the duration of one BFS and removes the need to count floors first.
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    if (idx < 0 || idx >= total) continue;
    pathIndexOf[idx] = i;
    if (pathDist[idx] < 0) {
      pathDist[idx] = 0;
      queue[tail++] = idx;
    }
  }
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;
    const nd = pathDist[idx] + 1;
    for (let d = 0; d < DIR_COUNT; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (tiles[nIdx] !== TILE.FLOOR || pathDist[nIdx] >= 0) continue;
      pathDist[nIdx] = nd;
      queue[tail++] = nIdx;
    }
  }
}

/**
 * Smallest path index reachable from `idx` within `radius` tiles, and the depth at which it was
 * found — i.e. **where the player first meets this tile while walking the route**, which is the
 * only sensible answer to "how far along is this flask?" when a corridor doubles back on itself.
 *
 * Packed into one number (`q * 4 + depth`, `depth ≤ 3 < 4`) to stay allocation-free in a helper
 * that runs once per candidate tile. `q` is bounded by the path length (≤ 2·4096² ≈ 3.4e7), so the
 * product stays far inside int32.
 *
 * @param {Ctx} ctx
 * @param {number} idx    tile index to probe from
 * @param {number} radius maximum BFS depth (≤ 3 — see the packing above)
 * @returns {number} `q * 4 + depth`, or −1 when no path tile is within `radius`
 */
function nearestPathFrom(ctx, idx, radius) {
  const { tiles, width, height, pathIndexOf, stamp, frontier, frontierDist } = ctx;
  const id = ++ctx.stampId;
  let head = 0;
  let tail = 0;
  stamp[idx] = id;
  frontier[0] = idx;
  frontierDist[0] = 0;
  tail = 1;

  let bestQ = -1;
  let bestDepth = 0;
  while (head < tail) {
    const t = frontier[head];
    const d = frontierDist[head];
    head++;
    const q = pathIndexOf[t];
    // BFS order means the first visit to a tile is at its minimal depth, so the depth recorded
    // alongside the minimal path index is that index's true detour cost.
    if (q >= 0 && (bestQ < 0 || q < bestQ)) {
      bestQ = q;
      bestDepth = d;
    }
    if (d >= radius) continue;
    const x = t % width;
    const y = (t - x) / width;
    for (let dir = 0; dir < DIR_COUNT; dir++) {
      const nx = x + DIR_DX[dir];
      const ny = y + DIR_DY[dir];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (tiles[nIdx] !== TILE.FLOOR || stamp[nIdx] === id || tail >= PROBE_SCRATCH) continue;
      stamp[nIdx] = id;
      frontier[tail] = nIdx;
      frontierDist[tail] = d + 1;
      tail++;
    }
  }
  return bestQ < 0 ? -1 : bestQ * 4 + bestDepth;
}

/**
 * Collect the free floor tiles within {@link OIL_BRANCH_RADIUS} of path tile `p` into `ctx.cand`.
 *
 * Kept separate from the evaluation below because both use `ctx.stamp`: the probe must be finished
 * before {@link nearestPathFrom} starts stamping the same buffer with a newer id.
 *
 * @param {Ctx} ctx
 * @param {number} from tile index of the path tile to fan out from
 * @returns {number} number of candidates written to `ctx.cand`
 */
function collectBranchCandidates(ctx, from) {
  const { tiles, width, height, occupied, stamp, frontier, frontierDist, cand } = ctx;
  const id = ++ctx.stampId;
  let head = 0;
  let tail = 1;
  let n = 0;
  stamp[from] = id;
  frontier[0] = from;
  frontierDist[0] = 0;

  while (head < tail) {
    const t = frontier[head];
    const d = frontierDist[head];
    head++;
    if (occupied[t] === 0 && n < PROBE_SCRATCH) {
      cand[n] = t;
      n++;
    }
    if (d >= OIL_BRANCH_RADIUS) continue;
    const x = t % width;
    const y = (t - x) / width;
    for (let dir = 0; dir < DIR_COUNT; dir++) {
      const nx = x + DIR_DX[dir];
      const ny = y + DIR_DY[dir];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (tiles[nIdx] !== TILE.FLOOR || stamp[nIdx] === id || tail >= PROBE_SCRATCH) continue;
      stamp[nIdx] = id;
      frontier[tail] = nIdx;
      frontierDist[tail] = d + 1;
      tail++;
    }
  }
  return n;
}

/**
 * Best flask spot hanging off path tile `p`, or none.
 *
 * "Best" prefers, in order: a tile **off** the path (a side pocket the player can see from the
 * route and choose to step into), then the one furthest along the route (so one flask covers as
 * much of the chain as the gap allows), then the shallowest detour. Candidates whose first
 * reachable path index is not past `lastQ` are rejected outright — a flask the player would have
 * walked past *before* the previous one buys the chain nothing.
 *
 * @param {Ctx} ctx
 * @param {Uint32Array} path
 * @param {number} p      path index to fan out from
 * @param {number} lastQ  path index of the previous chain flask (0 = the start, full tank)
 * @param {number} gap    maximum allowed advance (`q − lastQ`)
 * @param {import('../core/rng.js').Rng} rng
 * @returns {boolean} true when `ctx.out2` holds `[tileIndex, q]`
 */
function chainSpotNear(ctx, path, p, lastQ, gap, rng) {
  const n = collectBranchCandidates(ctx, path[p]);
  if (n === 0) return false;

  let bestScore = -0x7fffffff;
  let bestTile = -1;
  let bestQ = -1;
  let ties = 0;
  for (let i = 0; i < n; i++) {
    const tile = ctx.cand[i];
    const packed = nearestPathFrom(ctx, tile, OIL_BRANCH_RADIUS);
    if (packed < 0) continue;
    const q = (packed / 4) | 0;
    const depth = packed & 3;
    if (q <= lastQ || q - lastQ > gap) continue;

    // Off-path outranks everything (a flask in the corridor is a fallback, not a design); the
    // ×8 then puts a tile further along the route ahead of a shallower detour, without either term
    // ever being able to overflow the other (q − lastQ ≤ gap, depth ≤ 3).
    const score = (ctx.pathIndexOf[tile] < 0 ? 1 << 20 : 0) + Math.min(65535, q - lastQ) * 8 - depth;
    if (score > bestScore) {
      bestScore = score;
      bestTile = tile;
      bestQ = q;
      ties = 1;
    } else if (score === bestScore) {
      // Reservoir tie-break: every equally good spot is equally likely, without sorting or
      // allocating a candidate list.
      ties++;
      if (rng.int(ties) === 0) {
        bestTile = tile;
        bestQ = q;
      }
    }
  }
  if (bestTile < 0) return false;
  ctx.out2[0] = bestTile;
  ctx.out2[1] = bestQ;
  return true;
}

/**
 * The refuel chain (see the proof in the file header).
 *
 * Walks the solution path placing a flask whenever the remaining distance to the exit exceeds
 * `gap`, always as far along the route as a legal spot allows, so the chain uses the fewest flasks
 * that satisfy the guarantee and the density pass is free to spend the rest on exploration.
 *
 * Termination: every iteration sets `lastQ` to a strictly larger path index, so the loop runs at
 * most `path.length` times; the `guard` is belt and braces against a future edit breaking that.
 * Failure to find any spot (every tile within a whole `gap` of the route already occupied — only
 * possible on a degenerate maze) stops the chain rather than looping; `tools/validate-mazes.mjs`
 * turns the resulting gap into a loud failure instead of a quiet one.
 *
 * @param {Item[]} out
 * @param {Ctx} ctx
 * @param {Uint32Array} path
 * @param {number} gap
 * @param {import('../core/rng.js').Rng} rng
 * @returns {number} flasks placed
 */
function placeRefuelChain(out, ctx, path, gap, rng) {
  const last = path.length - 1;
  if (last < 1 || gap < 1) return 0;

  let lastQ = 0;
  let placed = 0;
  let guard = 0;
  while (last - lastQ > gap && placed < MAX_ITEMS_PER_KIND) {
    if (++guard > path.length) break;
    const aim = Math.min(last - 1, lastQ + gap);
    let found = false;
    for (let p = aim; p > lastQ; p--) {
      if (chainSpotNear(ctx, path, p, lastQ, gap, rng)) {
        found = true;
        break;
      }
    }
    if (!found) break;
    pushItem(out, ctx.occupied, 'oil', ctx.out2[0], ctx.width);
    lastQ = ctx.out2[1];
    placed++;
  }
  return placed;
}

/**
 * Place the level's single hidden map scroll (ARCHITECTURE.md §4.8).
 *
 * One multi-source BFS from the solution path labels every floor tile with the path index of the
 * junction it hangs off (`ctx.stamp` is reused for that: the chain probes are finished), then one
 * scan over the grid keeps the best free tile of each fallback tier:
 *
 * 1. a **dead end off the path**, detour (`pathDist`) in [{@link MAP_MIN_DETOUR_TILES}, `maxDetour`],
 *    junction in the first {@link MAP_JUNCTION_WINDOW} of the route — uniformly by seeded hash;
 * 2. the same with any junction;
 * 3. a dead end off the path deeper than `maxDetour` — the shallowest such, ties by hash;
 * 4. the **farthest-from-path** free floor tile — ties by hash (also the only tier when there is no
 *    path, e.g. an unsolvable test fixture).
 *
 * The first non-empty tier wins. Free = FLOOR and not `occupied` (so never the start, the exit, the
 * first three route tiles, or a tile that already carries an item). No free floor ⇒ no map item,
 * which `src/state` reads as "the map is unlocked". Cost: one BFS + one scan, O(tiles), one queue.
 *
 * @param {Item[]} out
 * @param {Ctx} ctx
 * @param {Uint32Array|null} path
 * @param {number} maxDetour largest preferred detour, tiles (`floor(oilTargetGap / 4)`)
 * @param {number} seed int32 hash seed from the level's `items.map` stream
 * @returns {number} the chosen tile index, or −1 when nothing was placed
 */
function placeMapScroll(out, ctx, path, maxDetour, seed) {
  const { tiles, width, height, total, occupied, pathDist, pathIndexOf } = ctx;
  const junction = ctx.stamp;
  const hasPath = path !== null && path.length > 0;
  let lastJunction = -1;

  if (hasPath) {
    junction.fill(-1);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < path.length; i++) {
      const idx = path[i];
      if (idx < 0 || idx >= total || junction[idx] >= 0) continue;
      junction[idx] = i;
      queue[tail++] = idx;
    }
    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      for (let d = 0; d < DIR_COUNT; d++) {
        const nx = x + DIR_DX[d];
        const ny = y + DIR_DY[d];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (tiles[nIdx] !== TILE.FLOOR || junction[nIdx] >= 0) continue;
        junction[nIdx] = junction[idx];
        queue[tail++] = nIdx;
      }
    }
    lastJunction = Math.floor(MAP_JUNCTION_WINDOW * (path.length - 1));
  }

  // Best tile and score per tier (index 0..3). Scores are < 2^48, exact in a double.
  let t0 = -1, t1 = -1, t2 = -1, t3 = -1;
  let s0 = -1, s1 = -1, s2 = -1, s3 = -1;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      if (tiles[idx] !== TILE.FLOOR || occupied[idx] !== 0) continue;
      const pd = pathDist[idx];
      if (hasPath && pd < 0) continue; // unreachable from the route (fixtures only)
      const h = hash2(x, y, seed);

      if (hasPath && pd >= MAP_MIN_DETOUR_TILES && pathIndexOf[idx] < 0 && floorNeighbours(tiles, width, idx) === 1) {
        if (pd <= maxDetour) {
          if (junction[idx] >= 0 && junction[idx] <= lastJunction) {
            if (h > s0) { s0 = h; t0 = idx; }
          } else if (h > s1) { s1 = h; t1 = idx; }
        } else {
          const s = (65535 - Math.min(pd, 65535)) * 4294967296 + h;
          if (s > s2) { s2 = s; t2 = idx; }
        }
      }
      const s = Math.min(Math.max(pd, 0), 65535) * 4294967296 + h;
      if (s > s3) { s3 = s; t3 = idx; }
    }
  }

  const chosen = t0 >= 0 ? t0 : t1 >= 0 ? t1 : t2 >= 0 ? t2 : t3;
  if (chosen < 0) return -1;
  pushItem(out, occupied, 'map', chosen, width);
  return chosen;
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
 * Scatter `quota` items by **stratified sampling**: cut the grid into roughly `quota` square
 * buckets, keep the best-scoring eligible tile in each, then take buckets in a seeded order.
 *
 * This is the pass that makes density mean something at 16 000 cells. Ranking every candidate
 * globally (the old farthest-first sort) concentrates items wherever the metric happens to peak and
 * costs O(n log n) on a candidate set that is now tens of thousands of tiles; bucketing gives an
 * even spread over the whole maze for two O(tiles) passes and `O(buckets)` memory, and the
 * per-bucket score still decides *which* tile in that neighbourhood gets the item:
 *
 * - **oil** prefers `pathDist ≈ 2`: a visible side pocket one step off the route.
 * - **gems** prefer a large `pathDist`: off the beaten track, where the risk is.
 *
 * Ties (very common — a whole corridor can share a distance) are broken by a position hash so the
 * choice is seed-dependent but reproducible.
 *
 * @param {Item[]} out
 * @param {ItemKind} kind
 * @param {number} quota
 * @param {Ctx} ctx
 * @param {boolean} deadEndOnly only accept dead-end tiles (used for the gems' first pass)
 * @param {import('../core/rng.js').Rng} rng
 * @returns {number} items placed
 */
function scatterByBuckets(out, kind, quota, ctx, deadEndOnly, rng) {
  if (quota <= 0) return 0;
  const { tiles, width, height, occupied, pathDist } = ctx;
  // `floor` (not `ceil`): it errs toward *more* buckets than the quota, so the usual case is a
  // choice of spots rather than a shortfall the stride fallback has to mop up.
  const side = Math.max(1, Math.floor(Math.sqrt((width * height) / quota)));
  const gw = Math.ceil(width / side);
  const gh = Math.ceil(height / side);
  const buckets = gw * gh;
  const best = new Int32Array(buckets).fill(-1);
  const bestScore = new Int32Array(buckets);
  const tieSeed = rng.u32() | 0;
  const isGem = kind === 'gem';

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    const bRow = ((y / side) | 0) * gw;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      if (tiles[idx] !== TILE.FLOOR || occupied[idx] !== 0) continue;
      if (deadEndOnly && floorNeighbours(tiles, width, idx) !== 1) continue;
      const pd = pathDist[idx] < 0 ? 0 : pathDist[idx];
      const rank = isGem ? Math.min(pd, 255) : 255 - Math.min(Math.abs(pd - 2), 255);
      const score = (rank << 6) | (hash2(x, y, tieSeed) & 63);
      const b = bRow + ((x / side) | 0);
      if (best[b] < 0 || score > bestScore[b]) {
        best[b] = idx;
        bestScore[b] = score;
      }
    }
  }

  // Take the buckets in a shuffled order: when there are fewer usable buckets than the quota (a
  // maze that is mostly wall), a row-major sweep would crowd every leftover item into the top rows.
  const order = new Int32Array(buckets);
  for (let i = 0; i < buckets; i++) order[i] = i;
  rng.shuffle(order);

  let placed = 0;
  for (let i = 0; i < buckets && placed < quota; i++) {
    const idx = best[order[i]];
    if (idx < 0 || occupied[idx] !== 0) continue;
    pushItem(out, occupied, kind, idx, width);
    placed++;
  }
  return placed;
}

/**
 * Last-resort fill: take every `stride`-th free floor tile until the quota is met.
 *
 * Only runs when the bucket passes could not meet the quota — a degenerate or tiny maze, or a
 * caller asking for more items than the level has interesting tiles. Striding (rather than taking
 * the first N) keeps even that case spread out instead of piling items in the first corridor.
 *
 * @param {Item[]} out
 * @param {ItemKind} kind
 * @param {number} quota
 * @param {Ctx} ctx
 * @param {import('../core/rng.js').Rng} rng
 * @returns {number} items placed
 */
function fillByStride(out, kind, quota, ctx, rng) {
  if (quota <= 0) return 0;
  const { tiles, width, total, occupied } = ctx;
  let free = 0;
  for (let i = 0; i < total; i++) if (tiles[i] === TILE.FLOOR && occupied[i] === 0) free++;
  if (free === 0) return 0;

  const stride = Math.max(1, Math.floor(free / quota));
  const offset = rng.int(stride);
  let seen = 0;
  let placed = 0;
  for (let i = 0; i < total && placed < quota; i++) {
    if (tiles[i] !== TILE.FLOOR || occupied[i] !== 0) continue;
    if (seen++ % stride === offset) {
      pushItem(out, occupied, kind, i, width);
      placed++;
    }
  }
  // Integer division can leave the quota a few short; mop up whatever is left, in order.
  for (let i = 0; i < total && placed < quota; i++) {
    if (tiles[i] !== TILE.FLOOR || occupied[i] !== 0) continue;
    pushItem(out, occupied, kind, i, width);
    placed++;
  }
  return placed;
}

/**
 * Append an item at a tile index and mark the tile occupied.
 *
 * The `Item` shape is fixed by ARCHITECTURE.md §3 and deliberately flat: five own properties, no
 * nested objects, one interned string. At the gameplay maximum a level carries ~850 of them
 * (~55 KB in V8), which is why the renderer/sim contract is "never iterate items per frame" rather
 * than "keep items small" — they are already as small as the contract allows.
 *
 * @param {Item[]} out
 * @param {Uint8Array} occupied
 * @param {ItemKind} kind
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
