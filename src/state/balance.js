// @ts-check
/**
 * @file Every tuning number in A-MAZE (ARCHITECTURE.md §4.2).
 *
 * This is the single source of truth for game feel: speeds, accelerations, radii, fuel economy,
 * score formulas and per-level maze parameters. Nothing here reads state and nothing here
 * allocates on a hot path — the groups are frozen plain objects so the JIT sees a stable shape
 * and the values inline.
 *
 * ## Units (invariants — every consumer assumes them)
 * - **Distance: tiles.** One tile is 1×1 world units; a corridor is exactly 1 tile wide.
 * - **Time: seconds.** `dt` is seconds, fuel is seconds, `par` is seconds.
 * - **Angles: radians.** 0 = +x (east); +y is south because y grows downward (screen-style).
 * - **Rates suffixed `_RATE` are 1/seconds** and feed `damp()` (exponential smoothing);
 *   rates named `ACCEL`/`FRICTION` are tiles/second².
 *
 * ## Why the numbers are what they are
 * The feel target is "arcade, not simulation": the player reaches full speed in a sixth of a
 * second and stops about as fast, so corridors can be threaded precisely at 60 Hz without
 * momentum fighting the input. Everything else (bob cadence, bump threshold, torch economy) is
 * derived from `PLAYER.WALK_SPEED` so re-tuning the walk speed keeps the game coherent.
 */

import { clamp, clamp01, lerp } from '../core/math.js';

/** @typedef {import('../core/types.js').Settings} Settings */
/** @typedef {import('../core/types.js').BestScore} BestScore */

// ─── Player locomotion ───────────────────────────────────────────────────────────────────────

/**
 * Body and locomotion constants.
 *
 * `RADIUS` must stay < 0.5 tiles: the collision solver assumes a substep can cross at most one
 * tile boundary per axis, which only holds while the body fits inside a single corridor.
 * `ACCEL` is derived from `TIME_TO_TOP_SPEED` so the two can never drift apart.
 * @type {Readonly<Record<string, number>>}
 */
export const PLAYER = Object.freeze({
  /** Collision radius in tiles. 0.22 leaves 0.28 of clearance each side of a 1-tile corridor. */
  RADIUS: 0.22,
  /** Ground speed in tiles/second with no sprint. ~3.2 reads as a brisk jog at this scale. */
  WALK_SPEED: 3.2,
  /** Multiplier applied to `WALK_SPEED` while sprinting. */
  SPRINT_MULT: 1.6,
  /** Seconds to go from standstill to `WALK_SPEED` under full input. */
  TIME_TO_TOP_SPEED: 0.15,
  /** Acceleration in tiles/s², derived: WALK_SPEED / TIME_TO_TOP_SPEED. */
  ACCEL: 3.2 / 0.15,
  /** Deceleration in tiles/s² when there is no move input (friction stop ≈ 0.11 s). */
  FRICTION: 30,
  /** Peak keyboard/stick turn rate in radians/second. */
  TURN_SPEED: 2.8,
  /**
   * Smoothing rate (1/s) applied to the commanded keyboard turn rate. High enough to feel
   * immediate, low enough to round off the first and last frame of a tap — the "slight ease".
   */
  TURN_EASE_RATE: 18,
  /** Speed (tiles/s) above which holding sprint actually counts as sprinting for fuel drain. */
  SPRINT_MIN_SPEED: 0.6,
  /**
   * Maximum displacement per collision substep, in tiles. Must be < RADIUS so that a body flush
   * against a wall can never push its centre past the wall's mid-plane in one substep, and well
   * under 1 so it can never skip a wall tile entirely (the anti-tunnelling invariant).
   */
  MAX_SUBSTEP: 0.2,
  /** Hard cap on substeps per move, so an absurd dt costs bounded work instead of hanging. */
  MAX_SUBSTEPS: 512,
});

/**
 * Wall-impact ("bump") detection. A bump fires only when a *meaningful head-on* impact happens:
 * the collision must destroy both a large absolute amount of speed and a large fraction of the
 * speed the body had. Grazing a wall while sliding only removes the small normal component, so it
 * stays silent — which is exactly what keeps corridor running from sounding like a drum solo.
 * @type {Readonly<Record<string, number>>}
 */
export const BUMP = Object.freeze({
  /** Minimum speed (tiles/s) removed by the collision to count as an impact. */
  MIN_SPEED: 1.5,
  /** Minimum fraction of the pre-impact speed removed to count as head-on (0..1). */
  MIN_FRACTION: 0.5,
  /** Seconds before another bump can fire — stops a wall-hugging player machine-gunning thuds. */
  COOLDOWN: 0.35,
  /** Camera shake added per unit of impact speed (result is clamped to 0..1). */
  SHAKE_PER_SPEED: 0.16,
});

/**
 * Head bob and footsteps. The bob phase advances with *distance travelled*, never with time, so
 * the cadence stays locked to the feet at any speed and stops dead when the player does.
 * @type {Readonly<Record<string, number>>}
 */
export const BOB = Object.freeze({
  /**
   * Tiles covered per full bob cycle (2π). Two footsteps per cycle, so at WALK_SPEED this is
   * 3.2 / 1.9 × 2 ≈ 3.4 steps per second — a believable jog cadence.
   */
  STRIDE_TILES: 1.9,
  /** Smoothing rate (1/s) for the bob amplitude ramping in and out. */
  AMP_RATE: 9,
  /** Decay rate (1/s) of camera shake toward 0. */
  SHAKE_DECAY: 6,
});

// ─── World interaction ───────────────────────────────────────────────────────────────────────

/**
 * Distances and budgets for interacting with the level.
 * @type {Readonly<Record<string, number>>}
 */
export const WORLD = Object.freeze({
  /** Pickup radius in tiles (ARCHITECTURE.md §4.2). Generous so items never feel sticky. */
  PICKUP_RADIUS: 0.45,
  /** Distance to the exit tile centre that counts as "reached" (§4.2). */
  EXIT_RADIUS: 0.55,
  /** Fog-of-war reveal radius in tiles. */
  REVEAL_RADIUS: 3,
  /**
   * Maximum line-of-sight probes per step. The reveal pass only probes tiles that are still
   * unexplored, so in steady state it costs nothing; the budget bounds the worst case (entering a
   * large open area) and the cursor resumes where it stopped so nothing is starved.
   */
  REVEAL_BUDGET: 24,
  /** Hard cap on DDA cells walked by one line-of-sight probe (safety valve, never reached). */
  LOS_MAX_CELLS: 64,
  /** Distance in tiles at which `derived.nearExit` starts ramping up from 0. */
  NEAR_EXIT_RANGE: 8,
});

// ─── Simulation limits ───────────────────────────────────────────────────────────────────────

/**
 * Guard rails applied to whatever the outside world hands the reducer.
 * @type {Readonly<Record<string, number>>}
 */
export const SIM = Object.freeze({
  /** Largest dt (seconds) a single tick will integrate; larger values are clamped, never split. */
  MAX_DT: 0.25,
  /**
   * Largest mouse yaw delta (radians) accepted from one poll. A genuine fast flick at 60 Hz is
   * well under 1 rad; anything past this is a driver/pointer-lock glitch and would teleport the
   * view, so it is clamped rather than trusted.
   */
  MAX_LOOK_DX: Math.PI / 2,
});

// ─── Fuel economy ────────────────────────────────────────────────────────────────────────────

/**
 * The torch: fuel *is* the timer, so this table is the difficulty curve.
 * @type {Readonly<Record<string, number>>}
 */
export const FUEL = Object.freeze({
  /** Base drain in fuel-seconds per real second. */
  DRAIN: 1,
  /** Drain multiplier while sprinting (ARCHITECTURE.md §1). */
  SPRINT_MULT: 1.5,
  /** Fraction of `fuelMax` at or below which `derived.lowFuel` is true. */
  LOW_FRACTION: 0.2,
  /**
   * Fraction of `fuelMax` the player must climb back above before the one-shot `lowFuel` event
   * re-arms. The gap (0.26 vs 0.20) is hysteresis: without it, hovering at exactly 20 % would
   * re-fire the heartbeat cue every few frames.
   */
  REARM_FRACTION: 0.26,
  /** Fuel-seconds an oil flask restores, as a fraction of the level's `fuelMax`. */
  OIL_FRACTION: 0.16,
  /** Lower clamp on an oil flask's value, in fuel-seconds. */
  OIL_MIN: 12,
  /** Upper clamp on an oil flask's value, in fuel-seconds. */
  OIL_MAX: 45,
  /** Flat fuel-seconds granted to every level regardless of size (the "get oriented" budget). */
  BASE_SECONDS: 55,
  /** Fuel-seconds per cell on level 1 — deliberately generous while the player is learning. */
  PER_CELL_START: 1.15,
  /**
   * Fuel-seconds per cell once the difficulty curve has fully ramped.
   *
   * Calibrated against real generated mazes (`logs/state-integration.mjs`): the resulting budget
   * is ~4.8× the time a *direct* run down the solution path takes on level 1, settling to ~2.2–2.6×
   * from level 6 on. Since a player cannot see the path, that multiplier is the real difficulty
   * knob — it is how much wandering the torch pays for.
   */
  PER_CELL_END: 0.22,
  /** Levels over which the per-cell budget decays from PER_CELL_START to PER_CELL_END. */
  DECAY_LEVELS: 12,
  /** Fuel-seconds per tile of the *solution path* on level 1 (used by maze/populate.js). */
  PER_PATH_TILE_START: 1.6,
  /** Fuel-seconds per tile of the solution path once fully ramped. */
  PER_PATH_TILE_END: 0.75,
  /** Par time as a fraction of the level's fuel budget (the summary screen's target). */
  PAR_FRACTION: 0.5,
});

// ─── Score ───────────────────────────────────────────────────────────────────────────────────

/**
 * Score constants. The formulas are fixed by ARCHITECTURE.md §1:
 * `gem = 100 × level`, `clear = 500 × level + floor(fuelRemaining) × 10 × level`.
 * @type {Readonly<Record<string, number>>}
 */
export const SCORE = Object.freeze({
  /** Points per gem, before the ×level multiplier. */
  GEM_BASE: 100,
  /** Flat points for clearing a level, before the ×level multiplier. */
  CLEAR_BASE: 500,
  /** Points per whole fuel-second remaining at the exit, before the ×level multiplier. */
  FUEL_UNIT: 10,
  /**
   * Seconds between gems that still counts as a combo. Combo is a *display* statistic
   * (`run.bestCombo`) only — it never multiplies score, because §1 pins the score formulas.
   */
  COMBO_WINDOW: 4,
});

// ─── Attract mode (title screen camera) ──────────────────────────────────────────────────────

/**
 * The title-screen camera that wanders the demo maze. It walks corridor centre to corridor
 * centre, so it can never scrape a wall; the only thing that has to feel good is the turning.
 * @type {Readonly<Record<string, number>>}
 */
export const ATTRACT = Object.freeze({
  /** Cruise speed in tiles/second — slower than the player, so the title reads as calm. */
  SPEED: 1.7,
  /** Maximum turn rate in radians/second while steering toward the next corridor tile. */
  TURN_RATE: 2.2,
  /**
   * Proportional gain on the heading error. Above ~TURN_RATE/GAIN radians of error the camera
   * turns at the rate cap; below it the turn eases off, so the shot settles instead of snapping.
   */
  TURN_GAIN: 3.5,
  /** Distance to the target tile centre (tiles) at which the next tile is chosen. */
  ARRIVE: 0.3,
  /**
   * Forward speed is scaled by `max(0, cos(headingError))^SPEED_FALLOFF`, so the camera slows
   * into a turn and accelerates out of it instead of strafing sideways through a junction.
   */
  SPEED_FALLOFF: 2,
  /** Amplitude (radians) of the idle yaw sway that keeps the shot from feeling rail-mounted. */
  SWAY_AMP: 0.045,
  /** Frequency (Hz) of the idle yaw sway. */
  SWAY_HZ: 0.13,
  /** Relative weight given to "keep going straight" when choosing the next corridor tile. */
  STRAIGHT_WEIGHT: 3,
  /** Relative weight given to a turn. */
  TURN_WEIGHT: 1,
});

// ─── Level progression ───────────────────────────────────────────────────────────────────────

/**
 * Maze size / contents curve.
 * @type {Readonly<Record<string, number>>}
 */
export const LEVEL = Object.freeze({
  /** Logical cells per side on level 1 (ARCHITECTURE.md §6). */
  BASE_CELLS: 6,
  /** Cells added per side per level. */
  GROWTH: 2,
  /** Cap on cells per side (§6) — beyond this a level grows in difficulty, not in area. */
  MAX_CELLS: 40,
  /** Braid fraction (dead ends removed) once the ramp completes. */
  BRAID_MAX: 0.25,
  /** Levels over which braid ramps from 0 to BRAID_MAX. */
  BRAID_RAMP_LEVELS: 10,
  /**
   * Dead ends as a fraction of cells, for a randomized-DFS maze before braiding. Empirically the
   * recursive backtracker leaves ~10 % of cells as dead ends; item counts are derived from this
   * estimate so they scale with how much *hiding space* a level actually has.
   */
  DEAD_END_RATIO: 0.1,
  /** Gems requested per estimated dead end. */
  GEM_PER_DEAD_END: 0.55,
  /** Oil flasks requested per estimated dead end. */
  OIL_PER_DEAD_END: 0.22,
  /** Clamps on the requested item counts (populate may place fewer if the maze has no room). */
  GEM_MIN: 4,
  GEM_MAX: 40,
  OIL_MIN: 2,
  OIL_MAX: 14,
});

/**
 * Per-level maze parameters (ARCHITECTURE.md §4.2).
 *
 * `fuelSeconds` here is a **size-based budget**: base + cells × per-cell, with the per-cell rate
 * decaying as the player descends. `src/maze/populate.js` may refine it once the real solution
 * path is known, using `fuelBase + pathLength × fuelPerPathTile`; both are returned so the two
 * sites cannot drift. The extra fields are additive — the seven contract fields are unchanged.
 *
 * Total ordering guarantees (relied on by tests and by the difficulty curve):
 * size is non-decreasing in `level`, braid is non-decreasing, per-cell fuel is non-increasing.
 *
 * @param {number} level 1-based level number; non-finite or < 1 is treated as 1
 * @returns {{cols:number, rows:number, braid:number, gems:number, oil:number, fuelSeconds:number,
 *   par:number, fuelBase:number, fuelPerCell:number, fuelPerPathTile:number, cells:number}}
 */
export function levelParams(level) {
  // Defensive coercion: this is called from UI/tools as well as the reducer.
  const lv = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;

  const side = Math.min(LEVEL.MAX_CELLS, LEVEL.BASE_CELLS + (lv - 1) * LEVEL.GROWTH);
  const cells = side * side;

  const braid = clamp01((lv - 1) / LEVEL.BRAID_RAMP_LEVELS) * LEVEL.BRAID_MAX;

  // Braiding removes dead ends, so the item budget shrinks with it — fewer hiding places.
  const deadEnds = cells * LEVEL.DEAD_END_RATIO * (1 - braid);
  const gems = clamp(Math.round(deadEnds * LEVEL.GEM_PER_DEAD_END), LEVEL.GEM_MIN, LEVEL.GEM_MAX);
  const oil = clamp(Math.round(deadEnds * LEVEL.OIL_PER_DEAD_END), LEVEL.OIL_MIN, LEVEL.OIL_MAX);

  // Difficulty ramp: t = 0 on level 1, 1 once DECAY_LEVELS levels have been cleared.
  const t = clamp01((lv - 1) / FUEL.DECAY_LEVELS);
  const fuelPerCell = lerp(FUEL.PER_CELL_START, FUEL.PER_CELL_END, t);
  const fuelPerPathTile = lerp(FUEL.PER_PATH_TILE_START, FUEL.PER_PATH_TILE_END, t);
  const fuelSeconds = Math.round(FUEL.BASE_SECONDS + cells * fuelPerCell);
  const par = Math.round(fuelSeconds * FUEL.PAR_FRACTION);

  return {
    cols: side,
    rows: side,
    braid,
    gems,
    oil,
    fuelSeconds,
    par,
    fuelBase: FUEL.BASE_SECONDS,
    fuelPerCell,
    fuelPerPathTile,
    cells,
  };
}

/**
 * Points for one gem on a given level (ARCHITECTURE.md §1: `100 × level`).
 * @param {number} level 1-based
 * @returns {number} integer points
 */
export function gemScore(level) {
  const lv = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  return SCORE.GEM_BASE * lv;
}

/**
 * Points for clearing a level (ARCHITECTURE.md §1:
 * `500 × level + floor(fuelRemaining) × 10 × level`).
 * @param {number} level 1-based
 * @param {number} fuelRemaining fuel-seconds left when the exit was reached (negatives count as 0)
 * @returns {number} integer points
 */
export function levelBonus(level, fuelRemaining) {
  const lv = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  const fuel = Number.isFinite(fuelRemaining) ? Math.max(0, fuelRemaining) : 0;
  return SCORE.CLEAR_BASE * lv + Math.floor(fuel) * SCORE.FUEL_UNIT * lv;
}

/**
 * Fuel-seconds one oil flask restores on a level whose full tank is `fuelMax`.
 * Scaling with the tank keeps a flask worth roughly the same *fraction* of the timer at every
 * depth, while the clamps stop it from being trivial on level 1 or a full refill later on.
 * @param {number} fuelMax the level's starting fuel in seconds
 * @returns {number} fuel-seconds (> 0)
 */
export function oilFuel(fuelMax) {
  const max = Number.isFinite(fuelMax) ? Math.max(0, fuelMax) : 0;
  return clamp(max * FUEL.OIL_FRACTION, FUEL.OIL_MIN, FUEL.OIL_MAX);
}

// ─── Settings ────────────────────────────────────────────────────────────────────────────────

/**
 * Validation spec for every `Settings` key. `min`/`max` apply to numbers only; `def` is both the
 * factory default and the fallback for a value that cannot be coerced.
 * @type {Readonly<Record<string, {kind:'number'|'boolean', def:number|boolean, min?:number, max?:number}>>}
 */
export const SETTING_SPEC = Object.freeze({
  volume: Object.freeze({ kind: 'number', def: 0.8, min: 0, max: 1 }),
  music: Object.freeze({ kind: 'number', def: 0.55, min: 0, max: 1 }),
  sensitivity: Object.freeze({ kind: 'number', def: 1, min: 0.2, max: 3 }),
  scanlines: Object.freeze({ kind: 'boolean', def: true }),
  minimap: Object.freeze({ kind: 'boolean', def: true }),
  reducedMotion: Object.freeze({ kind: 'boolean', def: false }),
  invertLook: Object.freeze({ kind: 'boolean', def: false }),
});

/**
 * Every settings key, in a stable order (menus iterate this).
 * @type {ReadonlyArray<keyof Settings>}
 */
export const SETTING_KEYS = Object.freeze(
  /** @type {Array<keyof Settings>} */ (Object.keys(SETTING_SPEC)),
);

/**
 * Coerce one setting value to a legal one.
 *
 * Numbers are clamped into range (non-finite → the default). Booleans accept `true`/`false` and
 * `1`/`0` (the shapes a URL parameter or a persisted JSON can take) and reject everything else, so
 * a garbage `setSetting` is ignored instead of writing `"yes"` into the state.
 *
 * @param {string} key a `Settings` property name
 * @param {unknown} value candidate value
 * @returns {number|boolean|undefined} the coerced value, or `undefined` if the key is unknown or
 *   the value cannot be coerced (the caller must then leave the setting untouched)
 */
export function coerceSetting(key, value) {
  const spec = Object.prototype.hasOwnProperty.call(SETTING_SPEC, key)
    ? SETTING_SPEC[/** @type {keyof typeof SETTING_SPEC} */ (key)]
    : undefined;
  if (spec === undefined) return undefined;
  if (spec.kind === 'boolean') {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return clamp(value, /** @type {number} */ (spec.min), /** @type {number} */ (spec.max));
}

/**
 * Factory-default settings (a fresh object every call — the caller owns it).
 * @returns {Settings}
 */
export function defaultSettings() {
  return {
    volume: /** @type {number} */ (SETTING_SPEC.volume.def),
    music: /** @type {number} */ (SETTING_SPEC.music.def),
    sensitivity: /** @type {number} */ (SETTING_SPEC.sensitivity.def),
    scanlines: /** @type {boolean} */ (SETTING_SPEC.scanlines.def),
    minimap: /** @type {boolean} */ (SETTING_SPEC.minimap.def),
    reducedMotion: /** @type {boolean} */ (SETTING_SPEC.reducedMotion.def),
    invertLook: /** @type {boolean} */ (SETTING_SPEC.invertLook.def),
  };
}

/**
 * Build a complete, legal `Settings` from anything at all: unknown keys are dropped, missing or
 * uncoercible values fall back to the factory default. Never throws, never returns a partial.
 * @param {unknown} src candidate settings (e.g. parsed from localStorage)
 * @returns {Settings} a fresh, fully populated object
 */
export function sanitizeSettings(src) {
  const out = defaultSettings();
  if (src === null || typeof src !== 'object') return out;
  const obj = /** @type {Record<string, unknown>} */ (src);
  for (let i = 0; i < SETTING_KEYS.length; i++) {
    const key = SETTING_KEYS[i];
    const coerced = coerceSetting(key, obj[key]);
    if (coerced !== undefined) {
      // @ts-expect-error — key/value types line up by construction (SETTING_SPEC mirrors Settings).
      out[key] = coerced;
    }
  }
  return out;
}

/**
 * Build a legal `BestScore` from anything at all. Scores are non-negative integers; a corrupted or
 * absurd value degrades to 0 rather than poisoning the HUD with NaN.
 * @param {unknown} src candidate best-score record
 * @returns {BestScore} a fresh object
 */
export function sanitizeBest(src) {
  const out = { score: 0, level: 0 };
  if (src === null || typeof src !== 'object') return out;
  const obj = /** @type {Record<string, unknown>} */ (src);
  const score = obj.score;
  const level = obj.level;
  if (typeof score === 'number' && Number.isFinite(score) && score > 0) {
    out.score = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(score));
  }
  if (typeof level === 'number' && Number.isFinite(level) && level > 0) {
    out.level = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(level));
  }
  return out;
}
