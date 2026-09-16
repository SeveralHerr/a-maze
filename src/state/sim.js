// @ts-check
/**
 * @file Pure simulation step logic (ARCHITECTURE.md §4.2) — movement, collision, pickups, fuel,
 * fog-of-war reveal, derived values and event emission.
 *
 * Everything here **mutates the store-owned `GameState` in place**. Nothing in this file creates an
 * object in the steady state: the only objects created are `GameEvent`s, and only on the frames
 * where something actually happens (a footstep every ~0.3 s, a pickup, a phase change). All vector
 * scratch lives in module-level typed arrays, reused across calls — safe because a step is a
 * single synchronous call and the game is single-threaded.
 *
 * That includes most **number boxing**, which is the easy one to miss. JS calls use a tagged
 * convention, so a non-integer passed as an argument to a function the compiler does not inline
 * becomes a fresh HeapNumber on every call. The big per-step functions (`stepPlaying`,
 * `stepAttract`, `moveCircle`, `hasLineOfSight`) are therefore thin exported wrappers that park their
 * floats in module-level `Float64Array` slots and call a body that reads them back, and the reducer
 * hands `dt` over the same way (`stepDt`), and the reducer empties `state.events` without releasing
 * its backing store (`game.js` `clearEvents`). Measured without GC over 400 000-tick chunks, a step
 * standing still or turning in place allocates < 1 B (it was 48–64 B, and ~9 B more while turning);
 * what remains while walking is the footstep `GameEvent` itself, ~2–4 B/tick averaged. That is
 * short-lived young-generation garbage; `perf.test.mjs` pins turning < 2 B/tick and walking below
 * the cost of one object per step, and separately proves that 100 000 steps retain nothing.
 *
 * ## Coordinate invariants
 * - World units are tiles; tile (tx,ty) spans [tx,tx+1)×[ty,ty+1) and its centre is (tx+.5, ty+.5).
 * - `angle` is radians, 0 = +x (east), π/2 = +y (south) — y grows downward, so the player's
 *   **right** vector is (−sin a, cos a) and **forward** is (cos a, sin a).
 * - Out-of-bounds tiles are treated as solid, so the body can never leave the map even if a maze
 *   arrives with an unsealed border.
 *
 * ## The collision guarantee
 * `moveCircle` is exact circle-vs-tile, resolved axis by axis, and sub-steps any displacement
 * longer than `PLAYER.MAX_SUBSTEP` (0.2 tiles). Since the body radius is 0.22 and every wall is a
 * full 1×1 block, a substep can neither cross a wall nor push the centre past a wall's mid-plane:
 * **tunnelling is impossible at any dt and any speed**, which `sim.test.mjs` asserts by brute force
 * over a matrix of angles, speeds and dt values.
 *
 * ## Cost per step is independent of the level's size (massive-maze invariant)
 * A level now carries up to ~820 items and a 257×257 tile grid, so nothing here may be O(items) or
 * O(tiles) per step:
 * - **Pickups** query a uniform bucket grid (`buildItemGrid`, built once per level in the
 *   `levelReady` reducer, flat `Int32Array`s reused across levels). The pickup capsule (the step's
 *   swept segment, ≤ 1.28 tiles, grown by the 0.75 radius) is at most 2.78 tiles across and a
 *   bucket is 4, so a step touches at most 2×2 buckets — a handful of items.
 * - **Fog of war** probes at most `WORLD.REVEAL_BUDGET` tiles inside a fixed 7×7 window.
 * - **`explored`** is allocated once per level (and reused from a pool across levels).
 * Everything else is O(1). `perf.test.mjs` pins this on real generated levels: a step on a 128×128
 * level with 819 items measured 0.68 µs against 0.64 µs for the old 6×6 level with six.
 */

import { TILE } from '../maze/constants.js';
import {
  TAU,
  angleDiff,
  clamp,
  clamp01,
  damp,
  dist,
  dist2,
  mod,
  smoothstep,
  wrapAngle,
} from '../core/math.js';
import { createRng } from '../core/rng.js';
import { ATTRACT, BOB, BUMP, FUEL, PLAYER, SCORE, WORLD, gemScore, levelBonus, oilFuel } from './balance.js';

/** @typedef {import('../core/types.js').GameState} GameState */
/** @typedef {import('../core/types.js').Maze} Maze */
/** @typedef {import('../core/types.js').LevelData} LevelData */
/** @typedef {import('../core/types.js').Item} Item */
/** @typedef {import('../core/types.js').Phase} Phase */
/** @typedef {import('../core/types.js').Rng} Rng */

/**
 * Normalised per-step input. `stepPlaying` takes this rather than a raw `InputFrame` so every
 * field is guaranteed finite and in range (`game.js` does the coercion once per tick).
 * @typedef {Object} SimInput
 * @property {number} moveX   strafe −1..1 (right +)
 * @property {number} moveY   forward −1..1 (forward +)
 * @property {number} turn    keyboard/stick turn −1..1 (right +)
 * @property {number} lookDX  mouse/touch yaw delta in radians for this step
 * @property {boolean} sprint
 */

/**
 * Internal, non-contract simulation scratch stored at `state.sim`.
 *
 * These are genuine pieces of simulation state (they must survive between steps and must be part
 * of the state for determinism), but they are implementation detail: no consumer outside
 * `src/state` reads them. See ARCHITECTURE.md §4.2 (sim scratch).
 * @typedef {Object} SimScratch
 * @property {number} turnVel      smoothed keyboard turn rate, rad/s
 * @property {number} bumpCd       seconds until another bump event may fire
 * @property {number} footCount    alternating footstep counter (0/1 → `foot`)
 * @property {boolean} lowFuelArmed true while the one-shot `lowFuel` event is still pending
 * @property {number} combo        consecutive gems inside `SCORE.COMBO_WINDOW`
 * @property {number} comboTimer   seconds left on the combo window
 * @property {number} revealCursor resume index for the budgeted fog-of-war reveal
 * @property {number} runBestScore best score at the moment the run started (for `newBest`)
 * @property {number} drain        the level's fuel drain multiplier (`balance.drainRate`)
 * @property {LevelData|null} gridFor the level the item grid was built for (identity check)
 * @property {number} gridW        item-grid buckets across
 * @property {number} gridH        item-grid buckets down
 * @property {Int32Array|null} gridStart  bucket → first slot in `gridItems`, length gridW*gridH+1
 * @property {Int32Array|null} gridItems  item indices, grouped by bucket
 * @property {Int32Array|null} gridCursor scratch used while filling `gridItems` (build only)
 * @property {Uint8Array|null} exploredPool grow-only backing store for `state.explored`
 * @property {boolean} atValid     attract camera has a valid target tile
 * @property {number} atTx         attract target tile x
 * @property {number} atTy         attract target tile y
 * @property {number} atFromX      attract previous tile x (never immediately backtracked into)
 * @property {number} atFromY      attract previous tile y
 * @property {number} atSway       attract idle-sway phase, seconds
 * @property {number} atTurnVel    attract camera's smoothed turn rate, rad/s
 * @property {number} atSpeed      attract camera's smoothed forward speed, tiles/s
 * @property {Rng|null} rng        attract-mode wander stream (seeded from the demo maze)
 */

/**
 * A `GameState` carrying the simulation scratch. Structurally a `GameState`, so every consumer
 * typed against the contract accepts it; the sim uses this alias internally because it also reads
 * and writes `state.sim`.
 * @typedef {GameState & {sim: SimScratch}} SimState
 */

// ─── Module-level scratch (reused; never escapes a synchronous call) ─────────────────────────

/**
 * Collision I/O block for `moveCircleIO`: in [x, y, dx, dy, r], out [x, y, lostDx, lostDy].
 *
 * The hot paths pass their floats through this array instead of as call arguments on purpose. JS
 * calls use a tagged convention, so every non-integer argument to a function the compiler does not
 * inline (and `moveCircle` is far too big to inline) is boxed into a fresh HeapNumber on each call —
 * measured at 48–64 B per step, ~3–4 kB/s of garbage at 60 Hz, from this one call. Typed-array
 * slots are read back as raw doubles and cost nothing.
 * @type {Float64Array}
 */
const _move = new Float64Array(5);

/**
 * The current step's `dt`, handed to the step bodies through a typed-array slot rather than as a
 * call argument (see `_move`). Written and read within one synchronous call. Exported for the
 * reducer only (`game.js` writes it and calls `stepPlayingBody` / `stepAttractBody` directly, so
 * the value is never boxed whether or not the compiler inlines the public wrappers).
 * @type {Float64Array}
 */
export const stepDt = new Float64Array(1);
const _dt = stepDt;

/** Attract-mode candidate tiles, packed x,y pairs (≤ 4 candidates). @type {Int32Array} */
const _cand = new Int32Array(8);

/** Attract-mode candidate weights. @type {Int32Array} */
const _candW = new Int32Array(4);

/**
 * Absolute floor, in fuel-seconds, on the useful gain that makes an oil flask worth consuming. The
 * real threshold is `FUEL.OIL_MIN_USEFUL_FRACTION` of the flask's value; this only stops a
 * degenerate level (a zero-second flask) from making the test vacuous.
 */
const OIL_MIN_GAIN = 1;

/**
 * Longest per-axis displacement, in tiles, that `collectAround` will sweep. The real maximum is
 * `WALK_SPEED × SPRINT_MULT × SIM.MAX_DT` = 1.28; anything beyond this is a teleport (a test or tool
 * moving the player by hand) and is treated as a point test at the destination, which also keeps
 * the bucket box within 2×2 whatever `px/py` hold.
 */
const MAX_SWEEP = 1.5;

/** Bit returned by `moveCircle` when the x axis was blocked. */
const BLOCKED_X = 1;
/** Bit returned by `moveCircle` when the y axis was blocked. */
const BLOCKED_Y = 2;

// ─── Scratch lifecycle ───────────────────────────────────────────────────────────────────────

/**
 * Create the `state.sim` scratch block.
 * @returns {SimScratch}
 */
export function createSimScratch() {
  return {
    turnVel: 0,
    bumpCd: 0,
    footCount: 0,
    lowFuelArmed: true,
    combo: 0,
    comboTimer: 0,
    revealCursor: 0,
    runBestScore: 0,
    drain: 1,
    gridFor: null,
    gridW: 0,
    gridH: 0,
    gridStart: null,
    gridItems: null,
    gridCursor: null,
    exploredPool: null,
    atValid: false,
    atTx: 0,
    atTy: 0,
    atFromX: 0,
    atFromY: 0,
    atSway: 0,
    atTurnVel: 0,
    atSpeed: 0,
    rng: null,
  };
}

/**
 * Reset the per-level parts of the scratch. Called whenever a level is installed so nothing leaks
 * across levels (a pending low-fuel cue, a half-finished reveal sweep, a bump cooldown, an item
 * grid describing the level that just ended).
 *
 * The pooled buffers (`gridStart`/`gridItems`/`gridCursor`/`exploredPool`) are deliberately kept:
 * they are re-filled, not re-read, so a long run neither allocates nor grows.
 * @param {SimScratch} sim
 * @returns {void}
 */
export function resetSimScratch(sim) {
  sim.turnVel = 0;
  sim.bumpCd = 0;
  sim.footCount = 0;
  sim.lowFuelArmed = true;
  sim.combo = 0;
  sim.comboTimer = 0;
  sim.revealCursor = 0;
  sim.drain = 1;
  // Drops the reference to the previous level's data — and forces a rebuild before the next query.
  sim.gridFor = null;
  sim.gridW = 0;
  sim.gridH = 0;
  sim.atValid = false;
  sim.atSway = 0;
  sim.atTurnVel = 0;
  sim.atSpeed = 0;
}

// ─── Item lookup grid ────────────────────────────────────────────────────────────────────────

/**
 * Return an `Int32Array` of at least `length` entries, reusing `existing` when it is big enough.
 *
 * Grow-only pooling: a run that descends 30 levels allocates these buffers once each, at the size
 * of the largest level it reaches, instead of once per level.
 * @param {Int32Array|null} existing
 * @param {number} length
 * @returns {Int32Array}
 */
function ensureInt32(existing, length) {
  const n = Math.max(1, length | 0);
  if (existing !== null && existing.length >= n) return existing;
  return new Int32Array(n);
}

/**
 * Bucket index of an item, clamped into the grid.
 *
 * Non-finite coordinates land in bucket 0 rather than poisoning the index — a malformed item must
 * cost one wasted comparison per step, not corrupt the lookup for every other item.
 * @param {number} x item x in tiles
 * @param {number} y item y in tiles
 * @param {number} gw buckets across
 * @param {number} gh buckets down
 * @returns {number} 0 … gw*gh-1
 */
function bucketOf(x, y, gw, gh) {
  const cell = WORLD.ITEM_GRID_TILES;
  let bx = Math.floor(x / cell);
  let by = Math.floor(y / cell);
  if (!(bx >= 0)) bx = 0;
  else if (bx >= gw) bx = gw - 1;
  if (!(by >= 0)) by = 0;
  else if (by >= gh) by = gh - 1;
  return by * gw + bx;
}

/**
 * Build the uniform item lookup grid for the currently installed level.
 *
 * Called once per level from the `levelReady` reducer (and, defensively, the first time a step
 * finds the grid describing a different level). A counting sort over the items produces a CSR
 * layout — `gridStart[b] … gridStart[b+1]` are the slots of bucket `b` in `gridItems` — which is
 * two flat typed arrays, no per-bucket objects, and no allocation at all once the pools are big
 * enough. Taken items stay in the grid: the pickup pass skips them, and rebuilding on every pickup
 * would be exactly the O(items) work this replaces.
 *
 * @param {SimState} state
 * @returns {void}
 */
export function buildItemGrid(state) {
  const sim = state.sim;
  const level = state.levelData;
  sim.gridFor = level;
  if (level === null) {
    sim.gridW = 0;
    sim.gridH = 0;
    return;
  }
  const items = level.items;
  const n = Array.isArray(items) ? items.length : 0;
  const maze = level.maze;
  const cell = WORLD.ITEM_GRID_TILES;
  const gw = Math.max(1, Math.ceil(maze.width / cell));
  const gh = Math.max(1, Math.ceil(maze.height / cell));
  const buckets = gw * gh;
  sim.gridW = gw;
  sim.gridH = gh;

  const start = ensureInt32(sim.gridStart, buckets + 1);
  const cursor = ensureInt32(sim.gridCursor, buckets + 1);
  const order = ensureInt32(sim.gridItems, Math.max(1, n));
  sim.gridStart = start;
  sim.gridCursor = cursor;
  sim.gridItems = order;
  start.fill(0, 0, buckets + 1);
  if (n === 0) return;

  // Counts land at b+1 so the prefix sum turns them straight into start offsets.
  for (let i = 0; i < n; i++) {
    const it = items[i];
    start[bucketOf(it.x, it.y, gw, gh) + 1]++;
  }
  for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
  cursor.set(start.subarray(0, buckets));
  for (let i = 0; i < n; i++) {
    const it = items[i];
    order[cursor[bucketOf(it.x, it.y, gw, gh)]++] = i;
  }
}

/**
 * Give `state.explored` a zeroed `Uint8Array` of exactly `length` bytes.
 *
 * Backed by a grow-only pool in the sim scratch, because the array is 66 kB on a 257×257 level and
 * a deep run installs one per level; the view handed out is always exactly `length` long, so every
 * consumer indexes it exactly as before. The caller owns the returned view only until the next
 * level is installed.
 * @param {SimState} state
 * @param {number} length tiles in the level (width × height)
 * @returns {Uint8Array} zeroed, length `length`
 */
export function allocExplored(state, length) {
  const n = Math.max(0, Math.floor(length));
  const sim = state.sim;
  let pool = sim.exploredPool;
  if (pool === null || pool.length < n) {
    pool = new Uint8Array(n);
    sim.exploredPool = pool;
    return pool;
  }
  pool.fill(0, 0, n);
  return pool.length === n ? pool : pool.subarray(0, n);
}

// ─── Phase ───────────────────────────────────────────────────────────────────────────────────

/**
 * Switch phase, reset `phaseTime` and emit the `phase` event. A no-op when already in `to`, so
 * callers can be idempotent without emitting spurious events.
 *
 * Lives here rather than in `game.js` so the sim can end a run without importing the reducer
 * (keeping the dependency edge one-way: game.js → sim.js).
 * @param {SimState} state
 * @param {Phase} to
 * @returns {boolean} true if the phase actually changed
 */
export function setPhase(state, to) {
  const from = state.phase;
  if (from === to) return false;
  state.phase = to;
  state.phaseTime = 0;
  state.events.push({ type: 'phase', from, to });
  return true;
}

// ─── Tile queries ────────────────────────────────────────────────────────────────────────────

/**
 * Is tile (tx,ty) solid? Out-of-bounds counts as solid (see file header), and any tile value that
 * is not `TILE.FLOOR` counts as solid, so a future tile id can never accidentally be walkable.
 * @param {Uint8Array} tiles row-major, length w*h
 * @param {number} w tile columns
 * @param {number} h tile rows
 * @param {number} tx integer tile column
 * @param {number} ty integer tile row
 * @returns {boolean}
 */
export function solidAt(tiles, w, h, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= w || ty >= h) return true;
  return tiles[ty * w + tx] !== TILE.FLOOR;
}

// ─── Collision ───────────────────────────────────────────────────────────────────────────────

/**
 * Move a circle through the tile grid with wall sliding, and report what it lost to the walls.
 *
 * The move is split into substeps no longer than `PLAYER.MAX_SUBSTEP`; each substep resolves x
 * then y, and each axis is limited by the **exact** circle-vs-tile constraint:
 *
 * - a wall tile whose row spans the circle's centre limits the centre to `tx − r` (flat face);
 * - a wall tile offset by `d < r` in the other axis limits it to `tx − √(r² − d²)` (the corner),
 *   which is what makes the body round a convex corner smoothly instead of catching on it;
 * - a tile further than `r` away in the other axis does not constrain at all;
 * - and only tiles the body is approaching **from the correct side** constrain at all: a solid tile
 *   the centre is already level with belongs to the other axis, and applying this axis's
 *   constraint to it would shove the body back down the corridor it came from.
 *
 * Resolving x first with the old y and then y with the *new* x is what produces sliding: the
 * component into the wall is removed, the component along it survives.
 *
 * If the centre starts inside a solid tile (a level authored badly, or a teleport), the body is
 * allowed to move freely until it is out — failing open beats trapping the player forever.
 *
 * This is the public, argument-passing form (ARCHITECTURE.md §4.2) for tools and tests. The sim's
 * own hot paths call `moveCircleIO`, which is the same solver with its floats passed through a typed
 * array so that a step boxes nothing (see `_move`).
 *
 * @param {Uint8Array} tiles row-major tile array
 * @param {number} w tile columns
 * @param {number} h tile rows
 * @param {number} x centre x (tiles)
 * @param {number} y centre y (tiles)
 * @param {number} dx requested displacement x (tiles)
 * @param {number} dy requested displacement y (tiles)
 * @param {number} r body radius (tiles); must be < 0.5 — see `PLAYER.RADIUS`
 * @param {Float64Array} out length ≥ 4; receives [newX, newY, lostDx, lostDy] (lost = requested
 *   minus achieved displacement, i.e. what the walls absorbed)
 * @returns {number} bitmask: 1 = x axis was blocked, 2 = y axis was blocked
 */
export function moveCircle(tiles, w, h, x, y, dx, dy, r, out) {
  const io = _moveArgs;
  io[0] = x;
  io[1] = y;
  io[2] = dx;
  io[3] = dy;
  io[4] = r;
  const blocked = moveCircleIO(tiles, w, h, io);
  out[0] = io[0];
  out[1] = io[1];
  out[2] = io[2];
  out[3] = io[3];
  return blocked;
}

/** Private I/O block for the argument-passing `moveCircle`, so it never clobbers `_move`. */
const _moveArgs = new Float64Array(5);

/**
 * `moveCircle` with its floats passed through `io` (see `_move` for why).
 * @param {Uint8Array} tiles row-major tile array
 * @param {number} w tile columns
 * @param {number} h tile rows
 * @param {Float64Array} io length ≥ 5. In: [x, y, dx, dy, r]. Out: [newX, newY, lostDx, lostDy]
 *   (slot 4 is left as it was)
 * @returns {number} bitmask: 1 = x axis was blocked, 2 = y axis was blocked
 */
function moveCircleIO(tiles, w, h, io) {
  const x = io[0];
  const y = io[1];
  const dx = io[2];
  const dy = io[3];
  const r = io[4];
  const out = io;
  let cx = x;
  let cy = y;
  let blocked = 0;

  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0 || !Number.isFinite(len)) {
    out[0] = cx;
    out[1] = cy;
    out[2] = 0;
    out[3] = 0;
    return 0;
  }

  // Sub-step count: enough that no substep exceeds MAX_SUBSTEP, capped so a pathological dt costs
  // bounded work. If the cap binds, the displacement is scaled down instead of being taken in
  // unsafe jumps — a capped move is always preferable to a move through a wall.
  let n = Math.ceil(len / PLAYER.MAX_SUBSTEP);
  if (n < 1) n = 1;
  if (n > PLAYER.MAX_SUBSTEPS) n = PLAYER.MAX_SUBSTEPS;
  let sx = dx / n;
  let sy = dy / n;
  const sLen = len / n;
  if (sLen > PLAYER.MAX_SUBSTEP) {
    const k = PLAYER.MAX_SUBSTEP / sLen;
    sx *= k;
    sy *= k;
  }

  const r2 = r * r;

  for (let i = 0; i < n; i++) {
    // Escape hatch: a centre inside a wall has no valid resolution, so let it walk out.
    if (solidAt(tiles, w, h, Math.floor(cx), Math.floor(cy))) {
      cx += sx;
      cy += sy;
      continue;
    }

    // ── x axis (rows spanned by the body at the current y) ──
    if (sx !== 0) {
      const nx = cx + sx;
      const ty0 = Math.floor(cy - r);
      const ty1 = Math.floor(cy + r);
      if (sx > 0) {
        let lim = Infinity;
        const c0 = Math.floor(cx + r);
        const c1 = Math.floor(nx + r);
        for (let tx = c0; tx <= c1; tx++) {
          // Only tiles the body is approaching *from the west* constrain an eastward move; a solid
          // tile the centre already sits level with (or past) is the y axis's problem, and
          // applying the x constraint to it would shove the body backwards through the corridor.
          if (tx < cx) continue;
          for (let ty = ty0; ty <= ty1; ty++) {
            if (!solidAt(tiles, w, h, tx, ty)) continue;
            const d = cy < ty ? ty - cy : cy > ty + 1 ? cy - (ty + 1) : 0;
            if (d >= r) continue;
            const l = tx - Math.sqrt(r2 - d * d);
            if (l < lim) lim = l;
          }
        }
        if (nx > lim) {
          cx = lim;
          blocked |= BLOCKED_X;
        } else {
          cx = nx;
        }
      } else {
        let lim = -Infinity;
        const c0 = Math.floor(cx - r);
        const c1 = Math.floor(nx - r);
        for (let tx = c0; tx >= c1; tx--) {
          if (tx + 1 > cx) continue; // approached from the east only — see the eastward branch
          for (let ty = ty0; ty <= ty1; ty++) {
            if (!solidAt(tiles, w, h, tx, ty)) continue;
            const d = cy < ty ? ty - cy : cy > ty + 1 ? cy - (ty + 1) : 0;
            if (d >= r) continue;
            const l = tx + 1 + Math.sqrt(r2 - d * d);
            if (l > lim) lim = l;
          }
        }
        if (nx < lim) {
          cx = lim;
          blocked |= BLOCKED_X;
        } else {
          cx = nx;
        }
      }
    }

    // ── y axis (columns spanned by the body at the *resolved* x) ──
    if (sy !== 0) {
      const ny = cy + sy;
      const tx0 = Math.floor(cx - r);
      const tx1 = Math.floor(cx + r);
      if (sy > 0) {
        let lim = Infinity;
        const r0 = Math.floor(cy + r);
        const r1 = Math.floor(ny + r);
        for (let ty = r0; ty <= r1; ty++) {
          if (ty < cy) continue; // approached from the north only — see the eastward branch
          for (let tx = tx0; tx <= tx1; tx++) {
            if (!solidAt(tiles, w, h, tx, ty)) continue;
            const d = cx < tx ? tx - cx : cx > tx + 1 ? cx - (tx + 1) : 0;
            if (d >= r) continue;
            const l = ty - Math.sqrt(r2 - d * d);
            if (l < lim) lim = l;
          }
        }
        if (ny > lim) {
          cy = lim;
          blocked |= BLOCKED_Y;
        } else {
          cy = ny;
        }
      } else {
        let lim = -Infinity;
        const r0 = Math.floor(cy - r);
        const r1 = Math.floor(ny - r);
        for (let ty = r0; ty >= r1; ty--) {
          if (ty + 1 > cy) continue; // approached from the south only — see the eastward branch
          for (let tx = tx0; tx <= tx1; tx++) {
            if (!solidAt(tiles, w, h, tx, ty)) continue;
            const d = cx < tx ? tx - cx : cx > tx + 1 ? cx - (tx + 1) : 0;
            if (d >= r) continue;
            const l = ty + 1 + Math.sqrt(r2 - d * d);
            if (l > lim) lim = l;
          }
        }
        if (ny < lim) {
          cy = lim;
          blocked |= BLOCKED_Y;
        } else {
          cy = ny;
        }
      }
    }
  }

  out[0] = cx;
  out[1] = cy;
  out[2] = x + dx - cx;
  out[3] = y + dy - cy;
  return blocked;
}

// ─── Line of sight ───────────────────────────────────────────────────────────────────────────

/**
 * Grid line-of-sight between two world points (Amanatides & Woo DDA).
 *
 * A tile blocks sight only if it is entered *strictly before* the destination tile, so a wall can
 * see itself — that is what lets the minimap reveal the wall faces of a lit corridor. Allocation
 * free; the step count is bounded by `WORLD.LOS_MAX_CELLS` as a safety valve (the geometry can
 * never reach it for a 3-tile radius, but a NaN input must not spin).
 *
 * @param {Uint8Array} tiles row-major tile array
 * @param {number} w tile columns
 * @param {number} h tile rows
 * @param {number} x0 eye x (tiles)
 * @param {number} y0 eye y (tiles)
 * @param {number} x1 target x (tiles)
 * @param {number} y1 target y (tiles)
 * @returns {boolean} true when nothing solid lies strictly between the two tiles
 */
export function hasLineOfSight(tiles, w, h, x0, y0, x1, y1) {
  // Tiny wrapper so the compiler inlines it; the floats reach the body unboxed (see `_move`).
  const io = _los;
  io[0] = x0;
  io[1] = y0;
  io[2] = x1;
  io[3] = y1;
  return lineOfSightIO(tiles, w, h, io);
}

/**
 * Line-of-sight scratch for `hasLineOfSight`: [x0, y0, x1, y1].
 * @type {Float64Array}
 */
const _los = new Float64Array(4);

/**
 * The body of `hasLineOfSight`, reading its endpoints from `io`.
 * @param {Uint8Array} tiles
 * @param {number} w
 * @param {number} h
 * @param {Float64Array} io [x0, y0, x1, y1]
 * @returns {boolean}
 */
function lineOfSightIO(tiles, w, h, io) {
  const x0 = io[0];
  const y0 = io[1];
  const x1 = io[2];
  const y1 = io[3];
  let tx = Math.floor(x0);
  let ty = Math.floor(y0);
  const gx = Math.floor(x1);
  const gy = Math.floor(y1);
  if (tx === gx && ty === gy) return true;

  const dx = x1 - x0;
  const dy = y1 - y0;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  // Ray parameter t runs 0 → 1 over the segment; tDelta is t per tile crossed on that axis.
  const tDeltaX = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
  const tDeltaY = dy !== 0 ? 1 / Math.abs(dy) : Infinity;
  let tMaxX = dx !== 0 ? (dx > 0 ? tx + 1 - x0 : x0 - tx) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (dy > 0 ? ty + 1 - y0 : y0 - ty) * tDeltaY : Infinity;

  for (let guard = 0; guard < WORLD.LOS_MAX_CELLS; guard++) {
    if (tMaxX < tMaxY) {
      if (tMaxX > 1) return true; // segment ends before the next crossing
      tx += stepX;
      tMaxX += tDeltaX;
    } else {
      if (tMaxY > 1) return true;
      ty += stepY;
      tMaxY += tDeltaY;
    }
    if (tx === gx && ty === gy) return true;
    if (solidAt(tiles, w, h, tx, ty)) return false;
  }
  return false;
}

// ─── Fog of war ──────────────────────────────────────────────────────────────────────────────

/**
 * Reveal the tiles the player can currently see, within `WORLD.REVEAL_RADIUS`.
 *
 * Only *unexplored* tiles are probed, so once an area is known the pass costs one array read per
 * tile in the window. The number of line-of-sight probes per step is capped by
 * `WORLD.REVEAL_BUDGET`; the cursor remembers where the sweep stopped so no tile is starved.
 *
 * **The cost is the same on a 257×257 maze as on a 13×13 one**: the window is
 * `(2·REVEAL_RADIUS+1)² = 49` tiles wide whatever the map measures, so the loop below runs at most
 * 49 times and performs at most `REVEAL_BUDGET` (24) DDA probes, each of them bounded by
 * `WORLD.LOS_MAX_CELLS`. The only size-dependent quantity is the `explored` array itself, which is
 * allocated once per level by `allocExplored` in the `levelReady` reducer — never here.
 * @param {SimState} state
 * @returns {void}
 */
export function revealAround(state) {
  const level = state.levelData;
  const explored = state.explored;
  if (level === null || explored === null) return;
  const maze = level.maze;
  const w = maze.width;
  const h = maze.height;
  const tiles = maze.tiles;
  const px = state.player.x;
  const py = state.player.y;
  const R = WORLD.REVEAL_RADIUS;

  // Always know the tile you are standing on, even if it somehow fails the LOS probe.
  const ownX = Math.floor(px);
  const ownY = Math.floor(py);
  if (ownX >= 0 && ownY >= 0 && ownX < w && ownY < h) explored[ownY * w + ownX] = 1;

  const x0 = Math.max(0, Math.floor(px - R));
  const x1 = Math.min(w - 1, Math.floor(px + R));
  const y0 = Math.max(0, Math.floor(py - R));
  const y1 = Math.min(h - 1, Math.floor(py + R));
  const span = x1 - x0 + 1;
  const total = span * (y1 - y0 + 1);
  if (total <= 0) return;

  const r2 = R * R;
  let budget = WORLD.REVEAL_BUDGET;
  let cursor = state.sim.revealCursor;
  if (!(cursor >= 0) || cursor >= total) cursor = 0;

  for (let k = 0; k < total; k++) {
    let i = cursor + k;
    if (i >= total) i -= total;
    const tx = x0 + (i % span);
    const ty = y0 + ((i / span) | 0);
    const idx = ty * w + tx;
    if (explored[idx] !== 0) continue;
    if (dist2(px, py, tx + 0.5, ty + 0.5) > r2) continue;
    if (budget <= 0) {
      state.sim.revealCursor = i; // resume here next step
      return;
    }
    budget--;
    // The unboxed form (see `_move`): a tile that is in range but hidden is re-probed every step,
    // so boxing four doubles per probe here was up to ~100 B of garbage per step.
    _los[0] = px;
    _los[1] = py;
    _los[2] = tx + 0.5;
    _los[3] = ty + 0.5;
    if (lineOfSightIO(tiles, w, h, _los)) explored[idx] = 1;
  }
  state.sim.revealCursor = 0;
}

// ─── Pickups ─────────────────────────────────────────────────────────────────────────────────

/**
 * Collect every item whose centre is within `WORLD.PICKUP_RADIUS` of the segment the player's
 * centre travelled this step (`player.px,py` → `player.x,y`; ARCHITECTURE.md §4.8).
 *
 * Testing the swept segment rather than only the end point means a fast step (sprint at the
 * `SIM.MAX_DT` clamp covers 1.28 tiles) cannot hop over an item. The segment is a chord between two
 * positions the collision solver produced, so it cannot reach through a wall either: an item behind
 * a one-tile wall is ≥ 1.72 from both end points, and a chord no longer than 1.28 between them stays
 * ≥ √(1.72² − 0.64²) ≈ 1.60 from it — more than twice the radius.
 *
 * Only the buckets overlapping the capsule's bounding box are visited (2×2 at most), so the cost does not
 * depend on how many items the level holds — the difference between a 6×6 level with 4 items and a
 * 128×128 level with 820. The grid is built by `buildItemGrid`; if it describes a different level
 * (a consumer swapped `levelData` without going through the reducer) it is rebuilt once here rather
 * than silently missing every pickup.
 *
 * Allocation free apart from the `pickup` events it emits, which only happen on the frames where
 * something is actually collected.
 * @param {SimState} state must be in `playing` with `levelData` installed
 * @returns {void}
 */
function collectAround(state) {
  const level = state.levelData;
  if (level === null) return;
  const sim = state.sim;
  if (sim.gridFor !== level) buildItemGrid(state);
  const start = sim.gridStart;
  const order = sim.gridItems;
  const gw = sim.gridW;
  const gh = sim.gridH;
  if (start === null || order === null || gw === 0 || gh === 0) return;

  const items = level.items;
  const p = state.player;
  // A non-finite position would clamp to the whole grid below and turn this into the O(items) scan
  // the grid exists to avoid. It cannot happen (the reducer sanitises input and `moveCircle` only
  // returns finite values), which is exactly why the guard is one comparison rather than a fix-up.
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  const x1 = p.x;
  const y1 = p.y;
  // Segment start = where this step began (`stepPlayingBody` snapshots px/py before moving). A
  // non-finite or implausibly distant snapshot degrades to the plain disc test at the end point, so
  // the bounding box below can never grow into a scan of the whole grid.
  let x0 = p.px;
  let y0 = p.py;
  if (!(Math.abs(x1 - x0) <= MAX_SWEEP) || !(Math.abs(y1 - y0) <= MAX_SWEEP)) {
    x0 = x1;
    y0 = y1;
  }
  const sx = x1 - x0;
  const sy = y1 - y0;
  const len2 = sx * sx + sy * sy;
  const r = WORLD.PICKUP_RADIUS;
  const pr2 = r * r;
  const cell = WORLD.ITEM_GRID_TILES;

  // The capsule's bounding box in bucket coordinates. Segment + 2r < cell, so at most 2×2 buckets.
  let bx0 = Math.floor(((x0 < x1 ? x0 : x1) - r) / cell);
  let bx1 = Math.floor(((x0 < x1 ? x1 : x0) + r) / cell);
  let by0 = Math.floor(((y0 < y1 ? y0 : y1) - r) / cell);
  let by1 = Math.floor(((y0 < y1 ? y1 : y0) + r) / cell);
  if (!(bx0 >= 0)) bx0 = 0;
  if (!(by0 >= 0)) by0 = 0;
  if (!(bx1 < gw)) bx1 = gw - 1;
  if (!(by1 < gh)) by1 = gh - 1;

  for (let by = by0; by <= by1; by++) {
    const row = by * gw;
    for (let bx = bx0; bx <= bx1; bx++) {
      const b = row + bx;
      const to = start[b + 1];
      for (let k = start[b]; k < to; k++) {
        const it = items[order[k]];
        if (it === undefined || it.taken) continue;
        // Written as "not inside" rather than "outside" so a NaN distance REJECTS. An item with
        // non-finite coordinates is filed into bucket 0 by `bucketOf` — tiles 0…3 × 0…3, which is
        // where the player spawns — and `NaN > pr2` is false, so the old form auto-collected it on
        // the first frame of the level. Same comparison count, opposite answer for garbage.
        // Closest point on the segment: t = clamp(((item − start) · seg) / |seg|², 0, 1). A NaN t
        // (garbage item, or a zero-length step) falls to 0, and the distance below is then NaN for
        // a garbage item — still rejected — or the plain end-point distance for a still player.
        const ix = it.x;
        const iy = it.y;
        let t = len2 > 0 ? ((ix - x0) * sx + (iy - y0) * sy) / len2 : 0;
        if (!(t > 0)) t = 0;
        else if (t > 1) t = 1;
        const cx = ix - (x0 + sx * t);
        const cy = iy - (y0 + sy * t);
        if (!(cx * cx + cy * cy <= pr2)) continue;
        takeItem(state, it);
      }
    }
  }
}

/**
 * Apply one item pickup: score a gem, refill the torch from a flask, or unlock the map.
 * @param {SimState} state
 * @param {Item} it the item under the player (not yet taken)
 * @returns {void}
 */
function takeItem(state, it) {
  const run = state.run;
  const sim = state.sim;
  if (it.kind === 'map') {
    // The level's hidden map scroll (ARCHITECTURE.md §4.8): always taken, unlocks the map, and is
    // worth nothing — no score, no combo, never part of `gemsTotal`.
    it.taken = true;
    run.mapFound = true;
    state.events.push({ type: 'pickup', kind: 'map', x: it.x, y: it.y, value: 0 });
    return;
  }
  if (it.kind === 'gem') {
    it.taken = true;
    run.gems++;
    const value = gemScore(state.level);
    run.score += value;
    // Combo is a display statistic only — §1 pins the score formula, so it must not multiply.
    sim.combo = sim.comboTimer > 0 ? sim.combo + 1 : 1;
    sim.comboTimer = SCORE.COMBO_WINDOW;
    if (sim.combo > run.bestCombo) run.bestCombo = sim.combo;
    state.events.push({ type: 'pickup', kind: 'gem', x: it.x, y: it.y, value });
    return;
  }
  // An unknown kind is data corruption, not an oil flask. Defaulting to oil here would hand a free
  // refuel to any malformed item that reached the level (`{}` used to be treated as a flask).
  if (it.kind !== 'oil') return;
  // Walking over a flask with a near-full tank would burn most of it for nothing, which reads as a
  // bug to the player: a flask is 38–53 s and the tank is 110–150 s, so a 1 s top-up destroys ~97 %
  // of the pickup. Leave it on the floor until at least half of it would land — it is still there
  // on the way back, and that is the rule `feasibility.test.mjs` proves the level curve against.
  const gain = oilFuel(run.fuelMax);
  const useful = Math.max(OIL_MIN_GAIN, gain * FUEL.OIL_MIN_USEFUL_FRACTION);
  if (run.fuelMax - run.fuel < useful) return;
  it.taken = true;
  const before = run.fuel;
  run.fuel = Math.min(run.fuelMax, run.fuel + gain);
  // The refuel tally is a per-level statistic (§3 RunStats): on a labyrinth that takes 7–22 flasks
  // to cross, "how many times did I refill" is the number that describes the level.
  run.refuels++;
  state.events.push({ type: 'pickup', kind: 'oil', x: it.x, y: it.y, value: run.fuel - before });
}

// ─── Derived values ──────────────────────────────────────────────────────────────────────────

/**
 * Recompute `state.derived` (consumed by renderer, HUD and audio).
 *
 * `exitDist` is `Infinity` when no level is loaded — an honest "unknown" that a consumer can test
 * with `Number.isFinite` instead of a magic distance.
 * @param {SimState} state
 * @returns {void}
 */
export function updateDerived(state) {
  const d = state.derived;
  const level = state.levelData;
  if (level !== null) {
    const ex = level.maze.exit.x + 0.5;
    const ey = level.maze.exit.y + 0.5;
    d.exitDist = dist(state.player.x, state.player.y, ex, ey);
    // Reversed edges: 0 at NEAR_EXIT_RANGE tiles away, 1 once standing on the portal.
    d.nearExit = smoothstep(WORLD.NEAR_EXIT_RANGE, WORLD.EXIT_RADIUS, d.exitDist);
  } else {
    d.exitDist = Infinity;
    d.nearExit = 0;
  }
  const run = state.run;
  d.lowFuel = run.fuelMax > 0 && run.fuel <= run.fuelMax * FUEL.LOW_FRACTION;
}

// ─── Placement ───────────────────────────────────────────────────────────────────────────────

/**
 * Put the player on the maze start tile, facing the first open neighbour (E, S, W, N order) so the
 * first frame never looks into a wall. Clears velocity, bob and shake, and syncs the interpolation
 * snapshot so the renderer does not lerp across the teleport.
 * @param {SimState} state must have `levelData`
 * @returns {void}
 */
export function placePlayerAtStart(state) {
  const level = state.levelData;
  if (level === null) return;
  const maze = level.maze;
  const sx = Math.floor(maze.start.x);
  const sy = Math.floor(maze.start.y);
  const p = state.player;
  p.x = sx + 0.5;
  p.y = sy + 0.5;
  p.vx = 0;
  p.vy = 0;
  p.bob = 0;
  p.bobAmp = 0;
  p.shake = 0;

  // E, S, W, N — matches DIR_* in maze/constants.js.
  let angle = 0;
  const w = maze.width;
  const h = maze.height;
  const tiles = maze.tiles;
  if (!solidAt(tiles, w, h, sx + 1, sy)) angle = 0;
  else if (!solidAt(tiles, w, h, sx, sy + 1)) angle = Math.PI / 2;
  else if (!solidAt(tiles, w, h, sx - 1, sy)) angle = Math.PI;
  else if (!solidAt(tiles, w, h, sx, sy - 1)) angle = -Math.PI / 2;
  p.angle = angle;

  p.px = p.x;
  p.py = p.y;
  p.pangle = p.angle;
}

// ─── Run bookkeeping ─────────────────────────────────────────────────────────────────────────

/**
 * Fold the current run into `state.best`.
 *
 * `best.level` means **the deepest level reached** (the level the run was on when it was folded
 * in), not the deepest level cleared: dying on level 4 after clearing level 3 records 4, the same
 * as clearing level 4. That matches what the menus show ("DEPTH") and is pinned in `game.test.mjs`.
 * It is called on a level clear, on game over, and when a run is abandoned from pause, so a quit
 * never throws away points already earned. Idempotent: folding the same run twice changes nothing.
 *
 * `newBest` is measured against the best recorded **when the run started** (`sim.runBestScore`),
 * not against the live record — otherwise a mid-run update (level complete) would make the
 * game-over banner claim "no new best" for a run that beat the record several levels earlier.
 * @param {SimState} state
 * @returns {boolean} true if this run has beaten the record it started with
 */
export function recordBest(state) {
  const run = state.run;
  const best = state.best;
  if (run.score > best.score) best.score = run.score;
  if (state.level > best.level) best.level = state.level;
  return run.score > state.sim.runBestScore;
}

/**
 * End the level successfully: award the clear bonus (ARCHITECTURE.md §1) and move to
 * `levelComplete`. Used by the exit check and by the `debugWin` action.
 * @param {SimState} state
 * @returns {void}
 */
export function completeLevel(state) {
  const run = state.run;
  const bonus = levelBonus(state.level, run.fuel);
  run.levelScore = bonus;
  run.score += bonus;
  recordBest(state);
  const p = state.player;
  p.vx = 0;
  p.vy = 0;
  setPhase(state, 'levelComplete');
  state.events.push({ type: 'levelComplete', level: state.level, bonus });
}

/**
 * End the run: record the best score and move to `gameOver`.
 * @param {SimState} state
 * @returns {void}
 */
export function endRun(state) {
  const newBest = recordBest(state);
  const p = state.player;
  p.vx = 0;
  p.vy = 0;
  setPhase(state, 'gameOver');
  state.events.push({ type: 'gameOver', score: state.run.score, newBest });
}

// ─── The playing step ────────────────────────────────────────────────────────────────────────

/**
 * Advance one fixed simulation step of gameplay.
 *
 * Order matters and is deliberate: aim → velocity → collide → bob → pickups → fuel → reveal →
 * exit → fuel-out → derived.
 * - The reveal runs before the exit test, so the tile the player is standing on when the level ends
 *   is already on the minimap for the summary screen.
 * - The exit is tested *before* the fuel-out test, so arriving on the very frame the torch dies is
 *   a win, not a loss.
 * - Pickups run *before* the drain, so a flask collected on the frame the torch would die saves it.
 *
 * Fuel drains at `FUEL.DRAIN × sim.drain × (FUEL.SPRINT_MULT while sprinting)`, where `sim.drain` is
 * the level's multiplier: 1 through `LEVEL.DRAIN_RAMP_START`, then climbing `FUEL.DRAIN_PER_LEVEL`
 * per level to `FUEL.DRAIN_MAX` (`balance.drainRate`, installed by the `levelReady` reducer).
 *
 * @param {SimState} state must be in phase `playing` with `levelData` loaded
 * @param {number} dt seconds, finite and > 0 (clamped by the caller)
 * @param {SimInput} input normalised input for this step
 * @returns {void}
 */
export function stepPlaying(state, dt, input) {
  // A deliberately tiny wrapper: the compiler inlines it into the reducer, so `dt` travels to the
  // body through a typed-array slot instead of being boxed as a call argument (see `_move`).
  _dt[0] = dt;
  stepPlayingBody(state, input);
}

/**
 * The body of `stepPlaying`, reading `dt` from `stepDt[0]` (internal to `src/state`).
 * @param {SimState} state
 * @param {SimInput} input
 * @returns {void}
 */
export function stepPlayingBody(state, input) {
  const dt = _dt[0];
  const level = state.levelData;
  if (level === null) return;
  const p = state.player;
  const sim = state.sim;
  const run = state.run;
  const maze = level.maze;
  const w = maze.width;
  const h = maze.height;

  // Snapshot for render interpolation before anything moves.
  p.px = p.x;
  p.py = p.y;
  p.pangle = p.angle;

  run.levelTime += dt;
  run.totalTime += dt;
  if (sim.bumpCd > 0) sim.bumpCd = Math.max(0, sim.bumpCd - dt);
  // Shake decays at the top of the step, so an impulse added by a bump below lands at full
  // strength this frame and only starts fading on the next one.
  p.shake = damp(p.shake, 0, BOB.SHAKE_DECAY, dt);
  if (sim.comboTimer > 0) {
    sim.comboTimer -= dt;
    if (sim.comboTimer <= 0) {
      sim.comboTimer = 0;
      sim.combo = 0;
    }
  }

  // ── Aim ──────────────────────────────────────────────────────────────────────────────────
  // Mouse yaw is applied raw: smoothing a pointer delta is indistinguishable from input lag.
  // The keyboard/stick turn gets a short ease so tapping a turn key does not snap.
  const turnTop = PLAYER.TURN_SPEED * (input.sprint ? PLAYER.SPRINT_TURN_MULT : 1);
  sim.turnVel = damp(sim.turnVel, input.turn * turnTop, PLAYER.TURN_EASE_RATE, dt);
  p.angle = wrapAngle(p.angle + input.lookDX + sim.turnVel * dt);

  // ── Velocity ─────────────────────────────────────────────────────────────────────────────
  let ix = input.moveX;
  let iy = input.moveY;
  const mag2 = ix * ix + iy * iy;
  if (mag2 > 1) {
    // Normalise so diagonal input is not √2 times faster than cardinal input.
    const inv = 1 / Math.sqrt(mag2);
    ix *= inv;
    iy *= inv;
  }
  const top = PLAYER.WALK_SPEED * (input.sprint ? PLAYER.SPRINT_MULT : 1);
  const cosA = Math.cos(p.angle);
  const sinA = Math.sin(p.angle);
  // forward = (cos, sin); right = (−sin, cos) because y grows downward.
  const tvx = (cosA * iy - sinA * ix) * top;
  const tvy = (sinA * iy + cosA * ix) * top;

  // Isotropic approach toward the target velocity: accelerate under input, brake without it.
  const rate = (mag2 > 0 ? PLAYER.ACCEL : PLAYER.FRICTION) * dt;
  const ddx = tvx - p.vx;
  const ddy = tvy - p.vy;
  const dd = Math.sqrt(ddx * ddx + ddy * ddy);
  if (dd <= rate || dd === 0) {
    p.vx = tvx;
    p.vy = tvy;
  } else {
    const k = rate / dd;
    p.vx += ddx * k;
    p.vy += ddy * k;
  }

  // ── Collide ──────────────────────────────────────────────────────────────────────────────
  const speedBefore = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  _move[0] = p.x;
  _move[1] = p.y;
  _move[2] = p.vx * dt;
  _move[3] = p.vy * dt;
  _move[4] = PLAYER.RADIUS;
  const blocked = moveCircleIO(maze.tiles, w, h, _move);
  const movedX = _move[0] - p.x;
  const movedY = _move[1] - p.y;
  p.x = _move[0];
  p.y = _move[1];

  if (blocked !== 0) {
    const invDt = 1 / dt;
    // Drop the velocity the wall absorbed, so the body does not keep pressing into it (and so the
    // head bob, which follows distance travelled, stops while you scrape along).
    if ((blocked & BLOCKED_X) !== 0) p.vx = movedX * invDt;
    if ((blocked & BLOCKED_Y) !== 0) p.vy = movedY * invDt;
    const lost = Math.sqrt(_move[2] * _move[2] + _move[3] * _move[3]) * invDt;
    // A head-on impact loses most of the speed the body had; a graze loses only the small normal
    // component, so both tests together keep wall-running silent.
    if (
      sim.bumpCd <= 0 &&
      lost >= BUMP.MIN_SPEED &&
      speedBefore > 0 &&
      lost >= speedBefore * BUMP.MIN_FRACTION
    ) {
      sim.bumpCd = BUMP.COOLDOWN;
      const strength = clamp01(lost / (PLAYER.WALK_SPEED * PLAYER.SPRINT_MULT));
      p.shake = clamp01(p.shake + lost * BUMP.SHAKE_PER_SPEED);
      state.events.push({ type: 'bump', strength });
    }
  }

  // ── Head bob & footsteps ─────────────────────────────────────────────────────────────────
  const moved = Math.sqrt(movedX * movedX + movedY * movedY);
  // Odometer for the run (§3 RunStats). This is the distance *actually covered* after collision,
  // not the distance commanded, so scraping along a wall does not inflate it.
  run.distance += moved;
  const speedNow = moved / dt;
  p.bobAmp = damp(p.bobAmp, clamp01(speedNow / PLAYER.WALK_SPEED), BOB.AMP_RATE, dt);
  if (moved > 0) {
    const before = p.bob;
    const after = before + moved * (TAU / BOB.STRIDE_TILES);
    // One footstep per half cycle; `before` is always in [0, 2π) so the half index is 0 or 1.
    if (Math.floor(after / Math.PI) > Math.floor(before / Math.PI)) {
      const foot = /** @type {0|1} */ (sim.footCount & 1);
      sim.footCount = (sim.footCount + 1) & 0x3fffffff;
      state.events.push({ type: 'footstep', foot });
    }
    p.bob = mod(after, TAU);
  }

  // ── Pickups ──────────────────────────────────────────────────────────────────────────────
  collectAround(state);

  // ── Fuel ─────────────────────────────────────────────────────────────────────────────────
  const sprinting = input.sprint && speedNow > PLAYER.SPRINT_MIN_SPEED;
  run.fuel -= dt * FUEL.DRAIN * sim.drain * (sprinting ? FUEL.SPRINT_MULT : 1);
  if (run.fuel < 0) run.fuel = 0;
  if (run.fuelMax > 0) {
    if (sim.lowFuelArmed) {
      if (run.fuel <= run.fuelMax * FUEL.LOW_FRACTION) {
        sim.lowFuelArmed = false;
        state.events.push({ type: 'lowFuel' });
      }
    } else if (run.fuel > run.fuelMax * FUEL.REARM_FRACTION) {
      sim.lowFuelArmed = true; // re-armed by an oil flask; hysteresis stops cue flutter
    }
  }

  // ── Exit, then fuel-out ──────────────────────────────────────────────────────────────────
  revealAround(state);
  const ex = maze.exit.x + 0.5;
  const ey = maze.exit.y + 0.5;
  if (dist2(p.x, p.y, ex, ey) <= WORLD.EXIT_RADIUS * WORLD.EXIT_RADIUS) {
    completeLevel(state);
    updateDerived(state);
    return;
  }
  if (run.fuel <= 0) {
    endRun(state);
    updateDerived(state);
    return;
  }

  updateDerived(state);
}

// ─── Attract mode (title screen) ─────────────────────────────────────────────────────────────

/**
 * Choose the next corridor tile for the attract camera.
 *
 * The walk never immediately backtracks (unless it is standing in a dead end, where backtracking
 * is the only option) and is weighted toward carrying straight on, which reads as purposeful
 * exploration rather than a drunkard's walk.
 * @param {SimState} state
 * @param {boolean} initial true when seeding the walk from the player's current tile
 * @returns {void}
 */
function pickAttractTarget(state, initial) {
  const level = state.levelData;
  if (level === null) return;
  const maze = level.maze;
  const sim = state.sim;
  const w = maze.width;
  const h = maze.height;
  const tiles = maze.tiles;

  // The tile we are standing on / have just reached, and the one we came from.
  const cx = initial ? Math.floor(state.player.x) : sim.atTx;
  const cy = initial ? Math.floor(state.player.y) : sim.atTy;
  const fromX = initial ? cx : sim.atFromX;
  const fromY = initial ? cy : sim.atFromY;
  const dirX = cx - fromX;
  const dirY = cy - fromY;

  let count = 0;
  let totalW = 0;
  for (let d = 0; d < 4; d++) {
    // E, S, W, N
    const nx = cx + (d === 0 ? 1 : d === 2 ? -1 : 0);
    const ny = cy + (d === 1 ? 1 : d === 3 ? -1 : 0);
    if (solidAt(tiles, w, h, nx, ny)) continue;
    if (!initial && nx === fromX && ny === fromY) continue; // no immediate backtracking
    const straight = nx - cx === dirX && ny - cy === dirY;
    const weight = straight ? ATTRACT.STRAIGHT_WEIGHT : ATTRACT.TURN_WEIGHT;
    _cand[count * 2] = nx;
    _cand[count * 2 + 1] = ny;
    _candW[count] = weight;
    totalW += weight;
    count++;
  }

  if (count === 0) {
    // Dead end (or a 1-tile maze): turn around if we can, otherwise stand and sway.
    if (!initial && !solidAt(tiles, w, h, fromX, fromY)) {
      sim.atFromX = cx;
      sim.atFromY = cy;
      sim.atTx = fromX;
      sim.atTy = fromY;
      sim.atValid = true;
    } else {
      sim.atFromX = cx;
      sim.atFromY = cy;
      sim.atTx = cx;
      sim.atTy = cy;
      sim.atValid = true;
    }
    return;
  }

  const rng = sim.rng;
  let roll = rng !== null ? rng.next() * totalW : totalW * 0.5;
  let chosen = count - 1;
  for (let i = 0; i < count; i++) {
    roll -= _candW[i];
    if (roll < 0) {
      chosen = i;
      break;
    }
  }
  sim.atFromX = cx;
  sim.atFromY = cy;
  sim.atTx = _cand[chosen * 2];
  sim.atTy = _cand[chosen * 2 + 1];
  sim.atValid = true;
}

/**
 * Has the attract camera reached its current target tile?
 *
 * Measured **along the leg** rather than as a radius around the tile centre: the camera eases its
 * turns, so it can come into a tile a little off the centre line, and a radius test could then be
 * missed entirely and leave it pressing on toward the wall beyond. "Standing in the target tile and
 * no more than `ARRIVE` short of its centre along the direction of travel" cannot be missed, since a
 * step (≤ 0.43 tiles at the `SIM.MAX_DT` clamp) is shorter than the part of the tile it covers.
 * A zero-length leg (a 1-tile maze, standing still) falls back to the radius test.
 * @param {SimState} state
 * @returns {boolean}
 */
function attractArrived(state) {
  const sim = state.sim;
  const p = state.player;
  const cx = sim.atTx + 0.5;
  const cy = sim.atTy + 0.5;
  const legX = sim.atTx - sim.atFromX;
  const legY = sim.atTy - sim.atFromY;
  if (legX === 0 && legY === 0) return dist2(p.x, p.y, cx, cy) <= ATTRACT.ARRIVE * ATTRACT.ARRIVE;
  if (Math.floor(p.x) !== sim.atTx || Math.floor(p.y) !== sim.atTy) return false;
  return (p.x - cx) * legX + (p.y - cy) * legY >= -ATTRACT.ARRIVE;
}

/**
 * Advance the title-screen attract camera one step.
 *
 * It walks corridor centre to corridor centre, so it physically cannot scrape a wall; the collision
 * solver still runs as a belt-and-braces guard against a malformed demo maze. Forward speed falls
 * off with the cosine of the heading error, so the camera slows into a junction and accelerates out
 * of it — the motion a person would produce, and far calmer than strafing round the corner.
 * @param {SimState} state
 * @param {number} dt seconds, finite and > 0
 * @returns {void}
 */
export function stepAttract(state, dt) {
  _dt[0] = dt; // see stepPlaying: keeps `dt` unboxed across the call
  stepAttractBody(state);
}

/**
 * The body of `stepAttract`, reading `dt` from `stepDt[0]` (internal to `src/state`).
 * @param {SimState} state
 * @returns {void}
 */
export function stepAttractBody(state) {
  const dt = _dt[0];
  const level = state.levelData;
  if (level === null) return;
  const p = state.player;
  const sim = state.sim;
  const maze = level.maze;

  p.px = p.x;
  p.py = p.y;
  p.pangle = p.angle;

  if (!sim.atValid) pickAttractTarget(state, true);
  if (attractArrived(state)) pickAttractTarget(state, false);

  // Aim point: the target tile centre pushed LOOKAHEAD tiles further along the leg being walked.
  // Aiming at the bare centre made every tile a step change in the target — the heading error
  // flipped sign on each arrival along a straight corridor. A point ahead on the corridor's centre
  // line moves only along that line when the next tile is picked, so a straight walk no longer
  // re-aims; a corner still jumps the aim, which the rate smoothing below absorbs.
  const legX = sim.atTx - sim.atFromX;
  const legY = sim.atTy - sim.atFromY;
  const ax = sim.atTx + 0.5 + legX * ATTRACT.LOOKAHEAD;
  const ay = sim.atTy + 0.5 + legY * ATTRACT.LOOKAHEAD;

  sim.atSway += dt;
  const sway = Math.sin(sim.atSway * TAU * ATTRACT.SWAY_HZ) * ATTRACT.SWAY_AMP;
  const err = angleDiff(p.angle, Math.atan2(ay - p.y, ax - p.x) + sway);
  // Second-order steering. The proportional term is the *commanded* turn rate (rad/s, capped at
  // TURN_RATE); the actual rate eases toward it at TURN_EASE_RATE, exactly like the player's
  // keyboard turn. Assigning the command directly (the old controller) put a step change in the
  // turn rate at every corner and every tile — measured 152 rad/s² peaks and 45 reversals in three
  // minutes — which reads as a snap into each corner. Easing bounds the angular acceleration to
  // TURN_EASE_RATE × 2·TURN_RATE whatever the maze does.
  const command = clamp(err * ATTRACT.TURN_GAIN, -ATTRACT.TURN_RATE, ATTRACT.TURN_RATE);
  sim.atTurnVel = damp(sim.atTurnVel, command, ATTRACT.TURN_EASE_RATE, dt);
  p.angle = wrapAngle(p.angle + sim.atTurnVel * dt);

  // Forward speed eases toward the cos-falloff target instead of being assigned it, for the same
  // reason: a corner used to cut the speed from cruise to zero in one frame.
  const align = Math.cos(err);
  const want = align > 0 ? ATTRACT.SPEED * Math.pow(align, ATTRACT.SPEED_FALLOFF) : 0;
  sim.atSpeed = damp(sim.atSpeed, want, ATTRACT.SPEED_EASE_RATE, dt);
  const speed = sim.atSpeed;
  p.vx = Math.cos(p.angle) * speed;
  p.vy = Math.sin(p.angle) * speed;
  _move[0] = p.x;
  _move[1] = p.y;
  _move[2] = p.vx * dt;
  _move[3] = p.vy * dt;
  _move[4] = PLAYER.RADIUS;
  moveCircleIO(maze.tiles, maze.width, maze.height, _move);
  const movedX = _move[0] - p.x;
  const movedY = _move[1] - p.y;
  p.x = _move[0];
  p.y = _move[1];

  const moved = Math.sqrt(movedX * movedX + movedY * movedY);
  p.bobAmp = damp(p.bobAmp, clamp01(moved / dt / PLAYER.WALK_SPEED), BOB.AMP_RATE, dt);
  if (moved > 0) p.bob = mod(p.bob + moved * (TAU / BOB.STRIDE_TILES), TAU);
  p.shake = damp(p.shake, 0, BOB.SHAKE_DECAY, dt);

  updateDerived(state);
}

/**
 * Seed the attract walk for a freshly installed demo maze. Deterministic: the stream depends only
 * on the maze seed, so the title screen replays identically for a given demo level.
 * @param {SimState} state
 * @returns {void}
 */
export function startAttract(state) {
  const level = state.levelData;
  const sim = state.sim;
  sim.atValid = false;
  sim.atSway = 0;
  if (level === null) {
    sim.rng = null;
    return;
  }
  sim.rng = createRng(level.maze.seed | 0).fork('attract');
  placePlayerAtStart(state);
  pickAttractTarget(state, true);
  updateDerived(state);
}

export { BLOCKED_X, BLOCKED_Y };
