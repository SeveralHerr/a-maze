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
 *
 * ## Massive mazes (design change)
 * Levels are now 10×10 cells on the lean first floor and 24×24 (49×49 tiles) at level 2, growing to
 * 128×128 cells (257×257 tiles, ≈ 33 000 floor tiles) at `CAP_LEVEL`, and the torch is a **small tank
 * you keep refilling** (95 s on level 1, 113 s on level 2, 150 s at the cap) rather than a budget for
 * the whole level. The two tables that carry that change are `LEVEL` (size, braid, item
 * densities) and `FUEL` (tank, flask value, the chainability arithmetic). Read those two doc
 * comments before touching a number in either.
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
 */
export const PLAYER = Object.freeze({
  /** Collision radius in tiles. 0.22 leaves 0.28 of clearance each side of a 1-tile corridor. */
  RADIUS: 0.22,
  /**
   * Ground speed in tiles/second. ~3.2 reads as a brisk jog at this scale. There is only one speed:
   * sprint was removed in the unlocks wave (ARCHITECTURE.md §1), so the torch is the only clock and a
   * tile always costs the same fuel.
   */
  WALK_SPEED: 3.2,
  /** Seconds to go from standstill to `WALK_SPEED` under full input. */
  TIME_TO_TOP_SPEED: 0.15,
  /** Acceleration in tiles/s², derived: WALK_SPEED / TIME_TO_TOP_SPEED. */
  ACCEL: 3.2 / 0.15,
  /** Deceleration in tiles/s² when there is no move input (friction stop ≈ 0.11 s). */
  FRICTION: 30,
  /**
   * Peak keyboard/stick turn rate in radians/second. 4.0 rad/s ≈ 229 °/s, so a 90° corner takes
   * ~0.39 s including the `TURN_EASE_RATE` ramp. At the old 2.8 (160 °/s) one corner cost 617 ms
   * measured from a standstill — in a game built entirely out of 90° corners, with ~760 path tiles
   * at the size cap, a keyboard player spent a large fraction of the level mid-turn while a mouse
   * player (raw `lookDX`) paid none of it. The benchmark sits here too: Doom's fast keyboard turn
   * is ~246 °/s. `TURN_EASE_RATE` is unchanged, so a tap still rounds instead of snapping.
   */
  TURN_SPEED: 4,
  /**
   * Smoothing rate (1/s) applied to the commanded keyboard turn rate. High enough to feel
   * immediate, low enough to round off the first and last frame of a tap — the "slight ease".
   */
  TURN_EASE_RATE: 18,
  /**
   * Smoothing rate (1/s) used instead of `TURN_EASE_RATE` when the turn command drops or reverses
   * (the key was let go, or the other one pressed). With one shared 18/s ease a released turn key
   * coasted the view on by `TURN_SPEED / 18` = 0.22 rad (10.9° measured from a 90° turn) — in a game
   * made of 90° corners that is an overshoot to correct on every one, where Wolfenstein and Doom stop
   * dead. At 45/s the coast is `4 / 45` ≈ 0.09 rad (≈ 5°), still rounded rather than a snap.
   * `sim.test.mjs` pins the coast under 6°.
   */
  TURN_RELEASE_RATE: 45,
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
 */
export const WORLD = Object.freeze({
  /**
   * Floors each tileset lasts before the dungeon changes its look (`src/renderer/tilesets/`). 1 =
   * every floor wears a different tileset, cycling through the list past its end.
   */
  FLOORS_PER_TILESET: 1,
  /**
   * Pickup radius in tiles (ARCHITECTURE.md §4.2, §4.8). It was 0.45, and the player could walk
   * straight past an item: cutting an L-turn keeps the body's centre `PLAYER.RADIUS` (0.22) from the
   * wall corner, which is √0.5 ≈ 0.707 from the corner tile's centre, so the closest approach was
   * ≈ 0.49. 0.75 covers that with margin, and still cannot reach through a wall — an item behind a
   * one-tile wall is always ≥ 1.72 from any position the body can occupy.
   */
  PICKUP_RADIUS: 0.75,
  /** Distance to the exit tile centre that counts as "reached" (§4.2). Kept above `PICKUP_RADIUS`. */
  EXIT_RADIUS: 0.8,
  /** Fog-of-war reveal radius in tiles. */
  REVEAL_RADIUS: 3,
  /**
   * Maximum line-of-sight probes per step. The reveal pass only probes tiles that are still
   * unexplored, so in steady state it costs nothing; the budget bounds the worst case (entering a
   * large open area) and the cursor resumes where it stopped so nothing is starved.
   *
   * **Size-independent by construction** (massive-maze audit): the pass only ever visits the
   * `(2·REVEAL_RADIUS+1)² = 49` tiles of the window around the player, and probes at most
   * `REVEAL_BUDGET` of them, whether the maze is 33×33 tiles or 257×257.
   */
  REVEAL_BUDGET: 24,
  /** Hard cap on DDA cells walked by one line-of-sight probe (safety valve, never reached). */
  LOS_MAX_CELLS: 64,
  /** Distance in tiles at which `derived.nearExit` starts ramping up from 0. */
  NEAR_EXIT_RANGE: 8,
  /**
   * Side of one bucket of the item lookup grid, in tiles (`sim.js`).
   *
   * A level now carries hundreds of items (≈ 820 at the size cap), so the pickup test may not scan
   * them. The grid is built once per level and queried with the buckets that can overlap the
   * pickup capsule (the step's swept segment grown by the radius). 4 tiles is the sweet spot: the
   * longest step (`WALK_SPEED × SIM.MAX_DT` = 0.8) plus twice `PICKUP_RADIUS` (0.75)
   * is 2.3 tiles, below it so without the Gem Magnet the query touches at most 2 buckets per axis (its 2-tile reach makes it 0.8 + 2×2.0 = 4.8, i.e. 3), while a bucket still covers only 16 tiles and
   * therefore holds a handful of items at any density the level curve can produce.
   */
  ITEM_GRID_TILES: 4,
});

// ─── Simulation limits ───────────────────────────────────────────────────────────────────────

/**
 * Guard rails applied to whatever the outside world hands the reducer.
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
 * The torch: a **small tank you must keep refilling**, not a budget for the whole level.
 *
 * ## Why the tank is independent of maze area (the massive-maze design change)
 * A tank sized to cover a level turns a big maze into one long countdown: the first two minutes
 * are free and the last thirty seconds are the game. With mazes up to 128×128 cells (≈ 33 000
 * floor tiles) that failure mode is total — a level-15 budget would have to be ~11 minutes of
 * fuel, and nothing would ever be tense. So the tank is **fixed at 95 s on the lean first floor,
 * 113 s on level 2 and 150 s at the size cap** whatever the maze measures (a flask is 33 s on
 * level 1, 40 s on level 2 and 66 s at the cap), and *oil flasks are the economy*: their
 * count scales with area so their density is roughly constant, and the player is always 60–90 s
 * from darkness no matter how deep they are.
 *
 * ## The arithmetic that makes a level chainable
 * Measured on the real generator (`logs/state-braidlaw.mjs`), the optimal route of a level at the
 * shipped braid is ≈ `PATH_TILES_PER_SIDE` tiles per cell-side. A player who cannot see the maze
 * walks `WANDER` (2.0) times that. Walking a tile costs `TRAVEL_OVERHEAD / PLAYER.WALK_SPEED`
 * seconds (the overhead covers turning and re-acceleration at junctions), multiplied by the
 * level's `drain`. So one flask, worth `oilFuel(tank)` seconds, pays for
 *
 *     gap = oilSeconds · WALK_SPEED / (TRAVEL_OVERHEAD · drain · WANDER)      tiles of *path*
 *
 * and `oilTargetGap` is that distance with `GAP_SAFETY` headroom. As long as the gap between
 * consecutive reachable flasks never exceeds it, a competent player can chain refuels for ever —
 * which is exactly the placement guarantee `src/maze/populate.js` owes the game and
 * `feasibility.test.mjs` proves end-to-end on real mazes.
 */
export const FUEL = Object.freeze({
  /** Base drain in fuel-seconds per real second, before the per-level `drain` multiplier. */
  DRAIN: 1,
  /**
   * Fraction of `fuelMax` at or below which `derived.lowFuel` is true (mirrored by `src/ui/hud.js`
   * as `LOW_FUEL_FRACTION` — §4.6; raise both together).
   * On the tank that is 24 s at level 1 and 37 s at the cap — ~78–120 tiles of walking, i.e.
   * a warning long enough to reach the next flask but short enough to feel like an alarm.
   * Raised from 0.20: measured on real levels the tank bottomed out at 24–41 % on a competent run,
   * so at 0.20 the heartbeat, the red vignette, the HUD LOW chip and the torch-radius collapse were
   * **never seen**. The alarm has to be reachable or the whole tension vocabulary is dead content.
   */
  LOW_FRACTION: 0.25,
  /**
   * Fraction of `fuelMax` the player must climb back above before the one-shot `lowFuel` event
   * re-arms. The gap (0.32 vs 0.25) is hysteresis: without it, hovering at exactly 25 % would
   * re-fire the heartbeat cue every few frames. One flask (35 % of the tank) always clears it,
   * so every refuel re-arms the alarm — that is the 60–90 s tension loop.
   */
  REARM_FRACTION: 0.32,
  /**
   * Fuel-seconds an oil flask restores, as a fraction of the tank, **on level 1's tank**
   * (`TANK_START`). The fraction climbs to `OIL_FRACTION_END` as the tank grows to `TANK_END`, so a
   * flask is 40 s on level 2 and 66 s at the size cap (see `oilFuel`). The lean first floor has its
   * own, smaller tank (`LEVEL.FIRST_TANK`, 95 s), so a flask there is 33 s.
   */
  OIL_FRACTION: 0.35,
  /**
   * Flask fraction on the size cap's tank (`TANK_END`). Bigger, rarer refills deeper down are the
   * *shape* of the tension curve: the placement guarantee spaces chain flasks by what one flask pays
   * for, so a bigger flask means longer dark stretches between them and a deeper dip in the tank
   * before the next one — while the chain still provably closes (`oilTargetGap` is derived from
   * the same value).
   */
  OIL_FRACTION_END: 0.44,
  /**
   * Room, in fuel-seconds, the tank must have before walking over a flask drinks it; the gain is
   * clamped to the tank, so only a brim-full tank leaves a flask on the floor.
   *
   * It used to be a fraction of the flask (0.55): the flask stayed down until 55 % of it would land,
   * which kept the low-oil alarm reachable. Playtesting read that as "I cannot pick up oil to top
   * off" — a flask you walk over and cannot take looks like a bug — so topping off wins and the
   * over-fill is lost. `feasibility.test.mjs` still models a player who does not walk *off* the
   * route for a sip (`FEAS_DETOUR_FRACTION` there); flasks on the route are always drunk.
   */
  OIL_MIN_ROOM: 1,
  /** Lower clamp on an oil flask's value, in fuel-seconds. */
  OIL_MIN: 25,
  /** Upper clamp on an oil flask's value, in fuel-seconds (above the curve's 66 s at the cap). */
  OIL_MAX: 70,
  /**
   * Tank size the size curve starts from, in fuel-seconds — **level 2's tank**, not level 1's: the
   * lean first floor has its own, shorter one (`LEVEL.FIRST_TANK`, 95 s) and level 2 sits one step
   * up the ramp at 113 s. `oilFuel` prices a flask against this number too.
   */
  TANK_START: 110,
  /** Tank size once the maze stops growing (`CAP_LEVEL`), in fuel-seconds. */
  TANK_END: 150,
  /**
   * Extra drain per level once the ramp starts (`LEVEL.DRAIN_RAMP_START`): 1.25× on level 10 and
   * `DRAIN_MAX` (1.35×) from level 13.
   *
   * The ramp used to start at `CAP_LEVEL`, which meant drain was exactly 1 across the entire
   * playable curve — and because the tank (110→150 s) and the flask (35 % of the tank) scale
   * together while oil density only thinned from 1/20 to 1/30 cells, the refuel loop was *identical*
   * at every depth. Measured: the minimum tank fraction over levels 1…12 wandered 24–41 % with no
   * trend, and the `lowFuel` cue fired **zero** times over a full 15-level descent. Starting the
   * ramp mid-curve is what lets depth read as tighter rather than just longer: the same route costs
   * 15 % more torch at level 10 and 30 % more at the cap. (It was 0.015 — 1.075× at level 10 — and
   * with the rest of the old economy that measured as no trend at all.)
   *
   * Drain alone cannot make a level tense: `oilTargetGap` is derived from it, so a faster burn also
   * packs the chain flasks closer. The drain shortens the *un-guaranteed* stretches (detours, the
   * scatter flasks); the depth trend proper comes from `OIL_FRACTION_END`, `GAP_SAFETY_END`,
   * and `LEVEL.OIL_CELLS_END` together.
   *
   * Retuned (0.015 → 0.03 → 0.035, and the ramp's start `CAP_LEVEL` → 5 → 3) because the curve
   * measured flat *and out of order*. Over levels 1–12 (3 seeds each, driven through the real
   * reducer with keyboard turning, a 2× wanderer making 16-tile side excursions) the lowest tank was
   * 0.49 on level 1, 0.65–0.74 on levels 2–4 and 0.40–0.56 on levels 5–11: the lean first floor was
   * the tightest of the early floors, level 10 was no tenser than level 5, and the `lowFuel` alarm
   * never fired between levels 2 and 11.
   *
   * With the ramp starting at level 3 at 0.035 — and the first floor's tank and flask density raised
   * (`LEVEL.FIRST_TANK`, `LEVEL.FIRST_OIL_CELLS`) and the chain headroom flattened (`GAP_SAFETY`) —
   * the same measurement reads 0.62 on level 1, 0.65–0.73 on levels 2–4, 0.38–0.59 on levels 5–8 and
   * 0.36–0.49 on levels 11–12, with the alarm firing from level 6 down. `feasibility.test.mjs` pins
   * the trend and that every 2× wanderer still wins.
   *
   * Steeper measured as unfair rather than tense: at 0.045 from level 2, a walker who never steps off
   * the solution path — and so never takes a flask one tile beside it — lost 3 of 3 runs on levels 11
   * and 12, against 2 of 36 runs here.
   */
  DRAIN_PER_LEVEL: 0.035,
  /**
   * Hard ceiling on the drain multiplier — past this the game is unreadable, not hard. Raised from
   * 1.35 with the earlier, steeper ramp: at 1.35 the drain saturated at level 13, *before* the size
   * cap, so every floor past the cap burned exactly the same and `oilTargetGap` stopped narrowing.
   * At 1.45 the ramp finishes at level 16, one floor past the cap, which keeps the post-cap tail
   * (where the maze can no longer grow) tightening for one more floor before density and braid are
   * all that is left.
   */
  DRAIN_MAX: 1.45,
  /**
   * How far a player who cannot see the maze walks, as a multiple of the optimal route. 2.0 is
   * the figure the feasibility autopilot is held to: it walks the real solution path and spends
   * one further path-length on detours.
   */
  WANDER: 2,
  /**
   * Multiplier on the direct route time for turning, acceleration and wall-scraping overhead.
   * Mirrors `CORNER_FACTOR` in `src/maze/populate.js` (§2 forbids importing it from here).
   */
  TRAVEL_OVERHEAD: 1.18,
  /**
   * Headroom on `oilTargetGap` **on level 1**: the placement guarantee is 38 % tighter than the
   * distance a flask strictly pays for, so a new player who arrives at a flask on fumes still has
   * slack for the next leg. Ramps to `GAP_SAFETY_END` over the size curve (`gapSafety`).
   *
   * Tightened from 0.7/0.8, and flattened, when the drain ramp took over the depth trend: the chain
   * is what a player who walks the route actually lives on, and spending its generosity at depth
   * *and* burning faster at depth is the same lever pulled twice. At 0.62 flat the deep floors keep
   * their tension from the drain (lowest tank 0.36–0.49 on levels 11–12) while the path-only
   * walker's losses fell from 3 runs in 36 to 2 (see `DRAIN_PER_LEVEL`).
   */
  GAP_SAFETY: 0.62,
  /**
   * Headroom on `oilTargetGap` at the size cap. Always < 1, so the guarantee still closes with slack
   * at every depth. `src/maze/populate.js` applies its own 0.9 chain safety under this (it may only
   * tighten), so values above ~0.9 buy nothing, and 0.85 measured as deaths for a flask-blind walker
   * past the cap (see `DRAIN_PER_LEVEL`). Equal to `GAP_SAFETY` now that the drain carries the depth
   * trend; they stay two knobs because `gapSafety` ramps between them.
   */
  GAP_SAFETY_END: 0.62,
  /**
   * Par-time wander factor. `levelParams().par` is only a **floor** — `src/maze/populate.js` knows
   * the level's real shortest path and derives the honest par from it — so this stays deliberately
   * conservative (a competent, non-omniscient run is nearer `WANDER`).
   */
  PAR_WANDER: 1,
});

// ─── Score ───────────────────────────────────────────────────────────────────────────────────

/**
 * Score constants. The formulas are fixed by ARCHITECTURE.md §1:
 * `gem = 100 × level`, `clear = 500 × level + floor(fuelRemaining) × 10 × level`.
 *
 * ## What the massive-maze change does to the pacing (deliberately left alone)
 * The clear bonus is dominated by `fuelRemaining`, and the tank no longer grows with the maze, so
 * clearing a level is worth roughly `500·lv + 1000·lv` however big it is — while gems scale with
 * area (6 on level 1, 273 at the cap). The mix therefore tips from "get out fast" early to
 * "explore" deep, which is the right incentive for a 14-minute labyrinth: the fuel bonus rewards
 * efficiency on a small map and the gems reward covering a big one. The formulas themselves are
 * pinned by §1 and mirrored in `src/ui/menus.js`, so changing them is an integrator decision.
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
 * Auto Explore (ARCHITECTURE.md §4.10): the autopilot that plays a level on its own through the real
 * input path. It explores fog-of-war frontiers at random, grabs what it has *seen* (never an item on
 * a tile it has not revealed), refuels when the tank runs low and heads for the exit once it has
 * wandered for a rolled share of the level's par time.
 */
export const AUTO = Object.freeze({
  /** Tank fraction below which the nearest known oil flask outranks everything else. */
  REFUEL_AT: 0.5,
  /**
   * Tank fraction below which a seen flask within `ITEM_DETOUR` is picked up on the way. Not higher:
   * a flask drunk into a nearly full tank loses the overflow (`takeItem` clamps the gain to the
   * tank), and at 0.9 the pilot spent its detours filling a quarter of a flask at a time — measured
   * over levels 1–10 × 8 seeds that alone dropped the clear rate from 74 % to 60 %.
   */
  TOPUP_AT: 0.6,
  /**
   * How many times the distance to the nearest known flask the tank must still cover for the pilot
   * to keep exploring instead of going for it. The trip is one length; the second is the leg out of
   * the flask toward the next one, which the placement guarantee (§1) sizes from a full flask.
   */
  REFUEL_MARGIN: 1.5,
  /**
   * Tiles of slack added to that rule, for the turning and backtracking a route costs over its path
   * length. Measured over levels 1–10 × 8 seeds, the fraction rule alone cleared 74 % of runs; the
   * distance rule, this margin, `TOPUP_AT` and the `SMELL_AT` valve together clear 79 of 80.
   */
  REFUEL_RESERVE_TILES: 16,
  /** Hysteresis above `REFUEL_AT` at which a refuel trip is abandoned (the tank is fine again). */
  REFUEL_HYSTERESIS: 0.15,
  /** Tank fraction below which, with no known flask, the exit (if seen) is taken at once. */
  DESPERATE_AT: 0.2,
  /**
   * Tank fraction below which, with no flask on any *explored* tile, the pilot walks to the nearest
   * flask on the level whether or not the fog has lifted off it (autopilot.js's survival valve). The
   * one place Auto Explore looks past the fog: a watch mode that runs the torch dry costs the player
   * their saved run, and a fog-bound explorer in a 128×128 labyrinth reliably strands itself — it
   * drinks its neighbourhood dry, then explores until the torch dies with no flask in sight.
   *
   * High, and measured: over levels 1–10 × 8 seeds the clear rate went 74 % (no valve) → 91 % at
   * 0.35 → 95 % at 0.65 → 98.75 % at 0.75. Above that it fetches oil it does not need yet and
   * stops exploring, which is what the mode is *for*.
   */
  SMELL_AT: 0.75,
  /** Path tiles a seen gem or the map scroll may be off the way to still be worth a detour. */
  ITEM_DETOUR: 14,
  /** Nearest frontier tiles the planner collects before choosing among the tied ones. */
  FRONTIER_CHOICES: 6,
  /** Path tiles within the nearest frontier's distance that count as a tie, chosen between at random. */
  FRONTIER_TIE: 2,
  /**
   * Extra path tiles charged to a frontier whose route starts behind the player (its first step is
   * against the facing). Without it, a frontier uncovered a tile early made the replan pick a branch
   * just passed about as often as the corridor ahead: ~4.5 mid-corridor U-turns a minute.
   */
  BACKTRACK_COST: 8,
  /** Facing·first-step below which a route counts as starting behind the player (−0.5 ≈ beyond 120°). */
  BACKTRACK_DOT: -0.5,
  /** Frontier candidates a plan may hold while it keeps looking for one that is not behind. */
  FRONTIER_CAP: 24,
  /** Frontier tiles collected once the pilot is searching toward the unseen exit. */
  SEEK_CHOICES: 48,
  /** Weight of the straight-line tiles still to the exit when searching toward it. */
  SEEK_WEIGHT: 1.5,
  /**
   * Share of the level's par time spent exploring before the exit (once seen) becomes the goal,
   * rolled per level between MIN and MAX so no two floors are walked the same way.
   */
  EXPLORE_PAR_MIN: 0.2,
  EXPLORE_PAR_MAX: 0.8,
  /**
   * Steps without movement before the route is thrown away and planned again. Long, because the
   * calm steering (it walks like the title camera — `ATTRACT`) turns round in place for well over a
   * second at a dead end, and that is not being stuck.
   */
  STUCK_STEPS: 150,
  /**
   * Pure-pursuit reach in tiles: the pilot aims at the point this far from the body along its route's
   * centre line, so a corner pulls the aim round it and the turn begins before the corner instead of
   * at the far wall.
   */
  PURSUIT: 1.1,
  /** Minimum steps between two plans that were not forced by finishing a route (bounds the BFS). */
  REPLAN_COOLDOWN_STEPS: 12,
  /** Seconds the level-complete tally is shown before Auto Explore descends on its own. */
  NEXT_LEVEL_DELAY: 4,
  /** Seconds into the clear before Auto Explore descends past boon cards that opened themselves. */
  BOON_DELAY: 12,
});

/**
 * The title-screen camera that wanders the demo maze. It walks corridor centre to corridor
 * centre, so it can never scrape a wall; the only thing that has to feel good is the turning.
 */
export const ATTRACT = Object.freeze({
  /** Cruise speed in tiles/second — slower than the player, so the title reads as calm. */
  SPEED: 1.7,
  /** Maximum turn rate in radians/second while steering toward the next corridor tile. */
  TURN_RATE: 2.2,
  /**
   * Proportional gain (1/s) on the heading error, giving the *commanded* turn rate. Above
   * TURN_RATE/GAIN ≈ 0.9 rad of error the command is at the rate cap; below it the turn eases off,
   * so the shot settles instead of snapping. Lowered from 3.5 together with the rate smoothing
   * (`TURN_EASE_RATE`): at 3.5 the eased loop was under-damped and wobbled out of each corner.
   */
  TURN_GAIN: 2.5,
  /**
   * How far short of the target tile's centre, measured along the leg being walked (tiles), the
   * camera counts as arrived and picks the next tile. Picking a little early starts the turn before
   * the centre, so the eased turn rounds the corner instead of overshooting toward the far wall.
   */
  ARRIVE: 0.3,
  /**
   * Tiles past the target tile's centre, along the current leg, that the camera aims at. Keeps the
   * aim point on the corridor's centre line, so reaching a tile on a straight run does not move the
   * heading target sideways (the old per-tile re-aim was a visible hitch every 0.6 s).
   */
  LOOKAHEAD: 1.5,
  /**
   * Smoothing rate (1/s) of the actual turn rate toward the commanded one — the attract camera's
   * `PLAYER.TURN_EASE_RATE`. Bounds angular acceleration to `TURN_EASE_RATE × 2 · TURN_RATE`
   * (22 rad/s²) even for a full reversal of the command, so there is no single-frame snap into a
   * corner; measured on real demo mazes at 30/60/144 Hz the peak is ≈ 11 rad/s² (it was 152). With
   * `TURN_GAIN` 2.5 the loop is well damped, so a corner does not overshoot and wobble back.
   */
  TURN_EASE_RATE: 5,
  /** Smoothing rate (1/s) of forward speed toward the cos-falloff target (≤ ~9 tiles/s² at 1.7 t/s). */
  SPEED_EASE_RATE: 5,
  /**
   * Forward speed is scaled by `max(0, cos(headingError))^SPEED_FALLOFF`, so the camera slows
   * into a turn and accelerates out of it instead of strafing sideways through a junction.
   */
  SPEED_FALLOFF: 2,
  /** Amplitude (radians) of the idle yaw sway that keeps the shot from feeling rail-mounted. */
  SWAY_AMP: 0.045,
  /** Frequency (Hz) of the idle yaw sway. */
  SWAY_HZ: 0.13,
  /**
   * Heading error (radians) beyond which the sway has faded out completely (`swayAt`): the sway is a
   * breath on a shot already on its line, not a second steering input, so it contributes nothing
   * while the camera is turning into a corner or standing still (it fades in with speed too).
   *
   * Measured, in case the same suspicion comes round again: the title camera's turn rate reverses
   * ~35 times a minute over six minutes of a real level-3 demo maze — with the sway gated (35.2),
   * added flat as it used to be (34.8) and switched off entirely (34.8). Those reversals are the
   * *maze's corners* (470 tiles walked, a turn every two or three), not the sway and not hunting;
   * `sim.test.mjs` therefore gates the hunting where it would actually show, on a long straight,
   * where the only sign changes left are the sway's own two per period.
   */
  SWAY_SETTLED: 0.1,
  /** Relative weight given to "keep going straight" when choosing the next corridor tile. */
  STRAIGHT_WEIGHT: 3,
  /** Relative weight given to a turn. */
  TURN_WEIGHT: 1,
});

// ─── Level progression ───────────────────────────────────────────────────────────────────────

/**
 * Maze size / contents curve — **massive mazes** (supersedes the 6×6…40×40 curve).
 *
 * Level 1 is the lean first floor — 10×10 cells (21×21 tiles), cleared in about 1–1.5 minutes. The
 * curve proper starts at level 2 with `BASE_CELLS + GROWTH` = 24×24 cells and adds 8 cells per side
 * per level up to `MAX_CELLS` = 128 (257×257 tiles, 16 384 cells, ≈ 33 000 floor tiles), reached at
 * `CAP_LEVEL`. Generating **and** validating a 128×128 maze measures ~5 ms, and
 * `tools/stress.mjs` proves the engine to 2000×2000 cells, so the cap is purely a balance
 * decision: `MAX_CELLS` is the single documented knob for it.
 */
export const LEVEL = Object.freeze({
  /**
   * Cells per side the size curve starts from: level L is `BASE_CELLS + (L − 1) × GROWTH`. Level 1
   * itself is overridden by the lean first floor (`FIRST_CELLS`); level 2 onward is unchanged.
   */
  BASE_CELLS: 16,
  /**
   * The first floor (unlocks wave, ARCHITECTURE.md §1): a small 10×10-cell labyrinth with thinner
   * pickings than the curve, cleared in about 1–1.5 minutes, so a new player learns the torch loop
   * quickly and the first boon arrives soon after. Only level 1 reads the `FIRST_*` numbers.
   */
  FIRST_CELLS: 10,
  /**
   * Tank on the first floor, seconds (the curve's `FUEL.TANK_START` resumes on level 2). Raised from
   * 80: at 80 the *first* floor was the tightest of the first four — a 2× wanderer's lowest tank
   * averaged 0.49 there against 0.65–0.74 on levels 2–4, and one seed reached 16 % — which is the
   * wrong end of the curve to put the first squeeze on. At 95 it measures 0.62, the most generous
   * floor in the game, as the first floor should be (`FUEL.DRAIN_PER_LEVEL` has the measurements).
   */
  FIRST_TANK: 95,
  /**
   * Cells per scatter flask on the first floor (the refuel chain still places what it needs).
   * Denser than the curve's `OIL_CELLS_START` on purpose: a 10×10 floor is 100 cells, so this is the
   * difference between three scatter flasks and four on the floor where the player is still learning
   * what a flask is for.
   */
  FIRST_OIL_CELLS: 26,
  /** Scatter-flask floor on the first floor (the level curve's `OIL_MIN` is 6). */
  FIRST_OIL_MIN: 3,
  /** Gem floor on the first floor (the level curve's `GEM_MIN` is 6). */
  FIRST_GEM_MIN: 4,
  /** Cells added per side per level. */
  GROWTH: 8,
  /**
   * Cap on cells per side — **the single size knob**. Past `CAP_LEVEL` a level grows in
   * difficulty (braid, drain, thinner flasks), never in area.
   */
  MAX_CELLS: 128,
  /** Braid fraction (dead ends opened) once the ramp completes. */
  BRAID_MAX: 0.6,
  /**
   * One cross-section shortcut requested per this many cells, on every level (level 1 included).
   * A shortcut is a wall knocked through between two cells that are at least `SHORTCUT_DETOUR`
   * cells apart by path, so a long cul-de-sac sometimes has a back door and corridors that look
   * like they should meet sometimes do — less forced backtracking, and a maze you can get lost in
   * because it is no longer a tree. Braid cannot do this: it opens dead-end *tips*, mostly into a
   * sibling twig. Doubled from 48 in a playtest pass that asked for "a bunch" more: placed per
   * maze size (10 seeds) went 2 → 7 at 16×16, 8 → 20 at 24×24, 13 → 33 at 32×32,
   * 66 → 164 at 64×64 and 325 → 683 at the cap. Small grids accept fewer than requested (≈7 of 11
   * on level 1): the detour and route rules run out of candidates. Halved again to 12 (with
   * `SHORTCUT_DETOUR` 12 → 8) when a later playtest asked for more still. Density alone moved
   * nothing — at detour 12 the candidates were already spent — so the detour is the real lever:
   * placed (6 seeds) went 2 → 4 at 10×10, 19 → 35 at 24×24, 34 → 60 at 32×32, 91 → 152 at 48×48.
   * Then 12 → 8 (detour 8 → 6) for "more" once more: 4 → 6, 35 → 52, 60 → 89, 152 → 223. Detour 4
   * would place ~60 % more again, but at 8 tiles it mostly joins sibling corridors.
   *
   * Since a playtest asked for more again, "especially as they get higher", all three shortcut knobs
   * ramp over the size curve (level 1 → `CAP_LEVEL`): `_START` on level 1, `_END` at the cap. At 8/6
   * the route guard was the binding rule on every floor from 3 up (the route sat at exactly 0.85),
   * so density alone could not add more; the detour is the big lever on a large grid and the guard
   * the second. Measured (2 seeds, before braid) at 8/6/0.85 → 4/4/0.70: 64×64 389 → 752,
   * 96×96 973 → 1742, 128×128 1991 → 3555.
   */
  SHORTCUT_CELLS_START: 8,
  SHORTCUT_CELLS_END: 4,
  /**
   * Minimum path distance, in cells, between the two cells a shortcut joins (so each one spares at
   * least 12 tiles of backtracking; 24 at the original 12). Lowered from 24 to 12 with the doubled density: at 24 or 16 the
   * candidates run out and half the requests go unplaced (32×32: 25 of 51 at 16). Re-measured in
   * `feasibility.test.mjs` (10 seeds per level) the lowest tank is still 0.70 on levels 1–2 against
   * 0.53 deep, so the "L1 generous, L10 tense" curve survives.
   */
  SHORTCUT_DETOUR_START: 6,
  /** Detour at the cap: 4 cells = 8 tiles. Rounded to whole cells along the ramp. */
  SHORTCUT_DETOUR_END: 4,
  /**
   * Fraction of the carved start→exit route shortcuts must leave intact. They exist to spare
   * backtracking, not to hand out a faster exit: unguarded, four of them halve a 16×16 route.
   * At 0.85 the level-1 route drops at most 15 %; at 0.9 the guard alone rejected ~40 % of the
   * requests on a 32×32 level. Relaxed toward the cap (see `SHORTCUT_CELLS_START`): a 128×128
   * route is ~700 tiles, so 70 % of it is still a long walk, and it is what lets the denser
   * shortcuts deep in the curve actually land.
   */
  SHORTCUT_ROUTE_KEEP_START: 0.85,
  SHORTCUT_ROUTE_KEEP_END: 0.7,
  /**
   * Levels over which braid ramps from 0 to `BRAID_MAX`. Longer than the size ramp on purpose, so
   * braid **keeps rising past the size cap** (0.49 at `CAP_LEVEL`, 0.6 from level 18).
   *
   * The ramp is steep early for a measured reason: in a *perfect* maze the farthest-cell route
   * grows ~`side^1.6`, so an unbraided 72×72 level would carry a 3 900-tile route (≈ 48 minutes at
   * the 2× wander factor) — longer than the level cap. Braiding cuts shortcuts into it and brings
   * the route back to ≈ `PATH_TILES_PER_SIDE · side`, which is what keeps the curve monotone in
   * *feel* instead of exploding in the middle. Measured: 72×72 at braid 0 = 3 903 tiles,
   * at braid 0.25 = 907 (`logs/state-braidlaw.mjs`).
   */
  BRAID_RAMP_LEVELS: 17,
  /**
   * Shape of the braid ramp: `braid = BRAID_MAX · t^BRAID_RAMP_SHAPE` with `t` the linear ramp
   * position. Below 1 it front-loads the braid, which is what removes the mid-curve hump the
   * measurements exposed: with a linear ramp, levels 3–4 carried 765- and 1048-tile routes (up to
   * 18 minutes) against level 15's 1014, because the maze was still nearly perfect while the side
   * was already 32–40 cells. A square-root ramp brings those two down to ≈ 490 and ≈ 505 tiles and
   * leaves the curve rising from ~1–1.5 minutes (the lean first floor) and ~4 (level 2) to ~14 (the cap).
   */
  BRAID_RAMP_SHAPE: 0.5,
  /**
   * Dead ends as a fraction of cells, for a randomized-DFS maze before braiding. Empirically the
   * recursive backtracker leaves ~10 % of cells as dead ends. Item counts no longer derive from
   * this (they are density-based now), but it is what makes the gem quota *placeable*: at the cap
   * a braided level still offers ≈ 835 dead ends for ≈ 273 gems.
   */
  DEAD_END_RATIO: 0.1,
  /**
   * Optimal route length in tiles per cell-side, at the shipped braid. Measured across the size
   * curve (`logs/state-braidlaw.mjs`): 16×16 → 321 tiles, 40×40 → 790, 96×96 → 1 060,
   * 128×128 → 1 100. Used only for *estimates* (par floor, the documented reach arithmetic); the
   * real path is known to `src/maze/populate.js` and to `Validation.pathLength`.
   */
  PATH_TILES_PER_SIDE: 13,
  /**
   * How far off the solution path a flask may sit and still count as *reachable* while walking it
   * (tiles). Mirrors `OIL_BRANCH_RADIUS` in `src/maze/populate.js`: a flask one to three tiles down
   * a side passage is visible from the route and worth a two-second detour; one six tiles away is
   * a different expedition. The chainability guarantee is stated in terms of this radius.
   */
  OIL_REACH_TILES: 3,
  /**
   * First level at which the torch's drain multiplier starts climbing (`FUEL.DRAIN_PER_LEVEL`).
   * Levels 1…`DRAIN_RAMP_START` burn at exactly 1×, which is the "generous" half of the curve;
   * from here on the same route costs measurably more torch. Lowered from 5 to 3: at 5 the pressure
   * only actually arrived at level 12, so levels 5–10 all played the same
   * (`FUEL.DRAIN_PER_LEVEL` carries the measurements). Three floors at 1× is the teaching run — the
   * lean first floor and the two full-size ones after it.
   */
  DRAIN_RAMP_START: 3,
  /** Cells per oil flask on level 1 (density ≈ one flask per 20 cells). */
  OIL_CELLS_START: 20,
  /**
   * Cells per oil flask once the density ramp completes — the *scatter* flasks thin out with depth.
   * Raised modestly from 30: the scatter layer on top of the refuel chain is what kept an explorer
   * topped up at every depth, but it is also what a player who walks straight past the chain's
   * off-path flasks lives on, and 36–60 measured as deaths for exactly that player deep in the
   * curve. The chain itself is placed by path distance, so the placement guarantee does not depend
   * on this number (see `FUEL.DRAIN_PER_LEVEL` for the measurements).
   */
  OIL_CELLS_END: 34,
  /** Cells per gem on level 1. */
  GEM_CELLS_START: 50,
  /** Cells per gem once the density ramp completes. */
  GEM_CELLS_END: 60,
  /** Levels over which the item densities ramp from START to END (matches the size ramp). */
  DENSITY_RAMP_LEVELS: 14,
  /**
   * Clamps on the requested item counts (populate may place fewer if the maze has no room).
   * The maxima are safety rails on memory and on the renderer's sprite list, not balance: the
   * shipped curve tops out at 482 flasks and 273 gems, so they never bind unless `MAX_CELLS` is
   * raised past ~150.
   */
  GEM_MIN: 6,
  GEM_MAX: 512,
  OIL_MIN: 6,
  OIL_MAX: 768,
});

/**
 * The first level at which the maze reaches `LEVEL.MAX_CELLS` cells per side (15 as shipped).
 * Derived, never typed in twice, so `MAX_CELLS` stays the one size knob.
 * @type {number}
 */
export const CAP_LEVEL =
  1 + Math.max(0, Math.ceil((LEVEL.MAX_CELLS - LEVEL.BASE_CELLS) / LEVEL.GROWTH));

/**
 * Coerce an untrusted level number to a 1-based integer. `levelParams` and friends are called from
 * the UI and from tools as well as from the reducer.
 * @param {number} level
 * @returns {number} an integer ≥ 1
 */
function levelNumber(level) {
  return Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
}

/**
 * The torch's tank for a level, in fuel-seconds — **independent of the maze's size**.
 * @param {number} level 1-based
 * @returns {number} seconds, `FUEL.TANK_START`…`FUEL.TANK_END`
 */
export function tankSeconds(level) {
  // The lean first floor has its own, shorter tank (see `LEVEL.FIRST_TANK`).
  if (levelNumber(level) === 1) return LEVEL.FIRST_TANK;
  // The tank finishes ramping exactly when the maze stops growing, so one knob moves both.
  return lerp(FUEL.TANK_START, FUEL.TANK_END, sizeRamp(level));
}

/**
 * Drain multiplier for a level. 1 through `LEVEL.DRAIN_RAMP_START`; past it the torch burns faster
 * every level, to a `FUEL.DRAIN_MAX` ceiling.
 *
 * The ramp starts **inside** the size curve rather than at `CAP_LEVEL`, because the tank and the
 * flask scale together and the oil density barely thins, so without it the refuel loop is bit-for-bit
 * the same at level 1 and level 12 (see `FUEL.DRAIN_PER_LEVEL`). `oilTargetGap` is derived from this
 * number, so raising the ramp automatically tightens the placement guarantee that
 * `tools/validate-mazes.mjs` and `feasibility.test.mjs` assert — a ramp that is too steep fails loudly.
 *
 * Non-decreasing in `level` (relied on by `levelParams`'s ordering guarantee).
 * @param {number} level 1-based
 * @returns {number} ≥ 1, at most `FUEL.DRAIN_MAX`
 */
export function drainRate(level) {
  const lv = levelNumber(level);
  const past = Math.max(0, lv - LEVEL.DRAIN_RAMP_START);
  return Math.min(FUEL.DRAIN_MAX, 1 + past * FUEL.DRAIN_PER_LEVEL);
}

/**
 * The idle yaw sway to add to a heading error, in radians: full amplitude on a settled shot at
 * cruise, nothing while the camera is turning into a corner or standing still.
 *
 * Lives here, with the numbers, because both the title camera (`sim.js` `stepAttractBody`) and Auto
 * Explore (`autopilot.js`) sway — and ARCHITECTURE.md §4.10 requires the pilot to move like the
 * title camera, which it cannot do if the two compute their sway differently.
 * @param {number} t seconds of sway clock
 * @param {number} err heading error, radians
 * @param {number} speed current forward speed, tiles/s
 * @returns {number} radians
 */
export function swayAt(t, err, speed) {
  const e = err < 0 ? -err : err;
  if (!(e < ATTRACT.SWAY_SETTLED)) return 0;
  const settled = 1 - e / ATTRACT.SWAY_SETTLED;
  const moving = clamp01(speed / ATTRACT.SPEED);
  return Math.sin(t * Math.PI * 2 * ATTRACT.SWAY_HZ) * ATTRACT.SWAY_AMP * settled * moving;
}

/**
 * Position of a level on the size ramp: 0 on level 1, 1 from `CAP_LEVEL` on. The tank, the flask
 * fraction and the gap headroom all ramp on this one number, so they finish together.
 * @param {number} level 1-based
 * @returns {number} 0..1
 */
function sizeRamp(level) {
  return clamp01((levelNumber(level) - 1) / Math.max(1, CAP_LEVEL - 1));
}

/**
 * Headroom applied to the refuel-chain gap on a level (`FUEL.GAP_SAFETY` → `FUEL.GAP_SAFETY_END`).
 * Always < 1, so every level keeps a chain a 2×-wander player provably closes; the deeper the level,
 * the less spare fuel that chain leaves in hand.
 * @param {number} level 1-based
 * @returns {number} in [GAP_SAFETY, GAP_SAFETY_END]
 */
export function gapSafety(level) {
  return lerp(FUEL.GAP_SAFETY, FUEL.GAP_SAFETY_END, sizeRamp(level));
}

/**
 * Tiles of *travel* the player can cover with `seconds` of fuel, at walking speed and including
 * the turning/acceleration overhead.
 * @param {number} seconds fuel-seconds
 * @param {number} [drain=1] the level's drain multiplier
 * @returns {number} tiles
 */
export function travelTiles(seconds, drain = 1) {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const d = Number.isFinite(drain) && drain > 0 ? drain : 1;
  return (s * PLAYER.WALK_SPEED) / (FUEL.TRAVEL_OVERHEAD * d);
}

/**
 * Estimated optimal route of a level, in tiles. See `LEVEL.PATH_TILES_PER_SIDE`.
 * @param {number} level 1-based
 * @returns {number} tiles (≥ 1)
 */
export function estimatedPathTiles(level) {
  const side = sideCells(level);
  return Math.max(1, Math.round(side * LEVEL.PATH_TILES_PER_SIDE));
}

/**
 * Cells per side of a level's labyrinth: the lean first floor, then the massive-maze curve.
 * @param {number} level 1-based
 * @returns {number}
 */
export function sideCells(level) {
  const lv = levelNumber(level);
  if (lv === 1) return LEVEL.FIRST_CELLS;
  return Math.min(LEVEL.MAX_CELLS, LEVEL.BASE_CELLS + (lv - 1) * LEVEL.GROWTH);
}

/**
 * Per-level maze parameters (ARCHITECTURE.md §4.2).
 *
 * `fuelSeconds` is now the **tank** (see `FUEL`): a fixed number of seconds the torch holds, not a
 * budget for the level. `oilTargetGap`, `oilDensity` and `gemDensity` are what `src/maze/populate.js`
 * needs to place the economy: scatter by density over the *area*, and never leave a stretch of the
 * solution path longer than `oilTargetGap` tiles without a reachable flask.
 *
 * Total ordering guarantees (relied on by tests and by the difficulty curve): size is
 * non-decreasing in `level`, braid is non-decreasing, the tank is non-decreasing, drain is
 * non-decreasing, and per-cell fuel is non-increasing (the tank grows far more slowly than the area).
 *
 * @param {number} level 1-based level number; non-finite or < 1 is treated as 1
 * @returns {{cols:number, rows:number, braid:number, shortcuts:number, shortcutDetour:number,
 *   shortcutRouteKeep:number, gems:number, oil:number, fuelSeconds:number,
 *   par:number, fuelBase:number, fuelPerCell:number, fuelPerPathTile:number, cells:number,
 *   drain:number, oilTargetGap:number, oilDensity:number, gemDensity:number,
 *   oilRefuelSeconds:number, pathTiles:number}}
 */
export function levelParams(level) {
  const lv = levelNumber(level);

  const side = sideCells(lv);
  const cells = side * side;
  const first = lv === 1;

  const braid =
    Math.pow(clamp01((lv - 1) / LEVEL.BRAID_RAMP_LEVELS), LEVEL.BRAID_RAMP_SHAPE) * LEVEL.BRAID_MAX;
  // Shortcut ramp over the size curve: level 1 → the cap (see `LEVEL.SHORTCUT_CELLS_START`).
  const ts = CAP_LEVEL > 1 ? clamp01((lv - 1) / (CAP_LEVEL - 1)) : 1;
  const shortcuts = Math.round(cells / lerp(LEVEL.SHORTCUT_CELLS_START, LEVEL.SHORTCUT_CELLS_END, ts));
  const shortcutDetour = Math.round(lerp(LEVEL.SHORTCUT_DETOUR_START, LEVEL.SHORTCUT_DETOUR_END, ts));
  const shortcutRouteKeep = lerp(LEVEL.SHORTCUT_ROUTE_KEEP_START, LEVEL.SHORTCUT_ROUTE_KEEP_END, ts);

  // Density ramp: t = 0 on level 1, 1 once the maze has stopped growing.
  const t = clamp01((lv - 1) / LEVEL.DENSITY_RAMP_LEVELS);
  const oilDensity = 1 / (first ? LEVEL.FIRST_OIL_CELLS : lerp(LEVEL.OIL_CELLS_START, LEVEL.OIL_CELLS_END, t));
  const gemDensity = 1 / lerp(LEVEL.GEM_CELLS_START, LEVEL.GEM_CELLS_END, t);
  const gems = clamp(Math.round(cells * gemDensity), first ? LEVEL.FIRST_GEM_MIN : LEVEL.GEM_MIN, LEVEL.GEM_MAX);
  const oil = clamp(Math.round(cells * oilDensity), first ? LEVEL.FIRST_OIL_MIN : LEVEL.OIL_MIN, LEVEL.OIL_MAX);

  const fuelSeconds = Math.round(tankSeconds(lv));
  const drain = drainRate(lv);
  const pathTiles = estimatedPathTiles(lv);

  // One flask buys `travelTiles(oilFuel(tank))` tiles of walking; at WANDER× the optimal route
  // that is `/ WANDER` tiles of *path*, and the guarantee keeps `gapSafety(lv)` in hand.
  const oilTargetGap = Math.max(
    1,
    Math.floor((travelTiles(oilFuel(fuelSeconds), drain) / FUEL.WANDER) * gapSafety(lv)),
  );

  // Par is a floor only (see FUEL.PAR_WANDER): the direct traversal time of the estimated route.
  const par = Math.round((pathTiles * FUEL.PAR_WANDER * FUEL.TRAVEL_OVERHEAD) / PLAYER.WALK_SPEED);

  return {
    cols: side,
    rows: side,
    braid,
    shortcuts,
    shortcutDetour,
    shortcutRouteKeep,
    gems,
    oil,
    fuelSeconds,
    par,
    // Retained §4.2 fields, now *derived from* the tank rather than inputs to it: the whole tank is
    // the flat budget, and the two rates are what it works out to per cell / per path tile.
    fuelBase: fuelSeconds,
    fuelPerCell: fuelSeconds / cells,
    fuelPerPathTile: fuelSeconds / pathTiles,
    cells,
    drain,
    oilTargetGap,
    oilDensity,
    gemDensity,
    oilRefuelSeconds: oilFuel(fuelSeconds),
    pathTiles,
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
 *
 * The fraction of the tank ramps from `FUEL.OIL_FRACTION` on a `TANK_START` tank to
 * `FUEL.OIL_FRACTION_END` on a `TANK_END` one (the tank *is* the depth signal — it grows exactly
 * over the size curve — so the signature needs no level). A tank below `TANK_START` (a tutorial or
 * test maze) uses the level-1 fraction. The clamps stop a flask being trivial or a whole level.
 * @param {number} fuelMax the level's starting fuel in seconds
 * @returns {number} fuel-seconds (> 0), non-decreasing in `fuelMax`
 */
export function oilFuel(fuelMax) {
  const max = Number.isFinite(fuelMax) ? Math.max(0, fuelMax) : 0;
  const t = clamp01((max - FUEL.TANK_START) / (FUEL.TANK_END - FUEL.TANK_START));
  return clamp(max * lerp(FUEL.OIL_FRACTION, FUEL.OIL_FRACTION_END, t), FUEL.OIL_MIN, FUEL.OIL_MAX);
}

/**
 * The tank a level actually starts with, given what the level data offers.
 *
 * `src/state` owns the tank now. A `LevelData` may hand the sim a **smaller** one — a tutorial
 * maze, the title demo, a test fixture — but never a larger one: the torch economy's whole premise
 * is a small tank that is independent of maze area, and `src/maze/populate.js` still derives a
 * path-sized budget (`fuelBudget`) that would be ~650 s on a 128×128 level. Clamping here means the
 * two modules cannot drift into an unbalanced game, whichever one is re-tuned first.
 *
 * @param {number} level 1-based level number
 * @param {number} [offered] `LevelData.fuel` as built by `src/maze`; ignored when not a positive
 *   finite number
 * @returns {number} fuel-seconds > 0
 */
export function resolveTank(level, offered) {
  const tank = Math.round(tankSeconds(level));
  if (typeof offered !== 'number' || !Number.isFinite(offered) || offered <= 0) return tank;
  return Math.min(offered, tank);
}

// ─── Settings ────────────────────────────────────────────────────────────────────────────────

/**
 * Legal values of `settings.mapMode`, in cycle order. Mirrors `MAP_MODES` in `src/ui/map.js`
 * (§2 forbids `src/ui` from importing this file, so the list exists on both sides); the UI owns the
 * behaviour of each state, `src/state` only owns persisting the choice.
 * @type {ReadonlyArray<string>}
 */
export const MAP_MODES = Object.freeze(['off', 'corner', 'full']);

/**
 * Validation spec for every `Settings` key. `min`/`max` apply to numbers only, `values` to enums;
 * `def` is both the factory default and the fallback for a value that cannot be coerced.
 * @type {Readonly<Record<string, {kind:'number'|'boolean'|'enum', def:number|boolean|string, min?:number, max?:number, values?:ReadonlyArray<string>}>>}
 */
export const SETTING_SPEC = Object.freeze({
  volume: Object.freeze({ kind: 'number', def: 0.8, min: 0, max: 1 }),
  music: Object.freeze({ kind: 'number', def: 0.55, min: 0, max: 1 }),
  sensitivity: Object.freeze({ kind: 'number', def: 1, min: 0.2, max: 3 }),
  scanlines: Object.freeze({ kind: 'boolean', def: true }),
  // Legacy two-state switch, kept in lockstep with `mapMode` by main.js and the options row: audio,
  // touch and any older call site still read it, and dropping it would silently change their
  // behaviour. `mapMode` is the value the three-state map actually restores from.
  minimap: Object.freeze({ kind: 'boolean', def: true }),
  mapMode: Object.freeze({ kind: 'enum', def: 'corner', values: MAP_MODES }),
  reducedMotion: Object.freeze({ kind: 'boolean', def: false }),
  invertLook: Object.freeze({ kind: 'boolean', def: false }),
  // On by default: the itch.io embed is a small iframe, and a first-person maze played through a
  // letterbox is a worse game. Only acted on when embedded (see `src/input/fullscreen.js`).
  fullscreen: Object.freeze({ kind: 'boolean', def: true }),
  // Auto Explore (§4.10): the autopilot walks the level. Persisted, so an idle player who left it on
  // comes back to it on; the HUD shows an AUTO tag whenever it is driving.
  autoExplore: Object.freeze({ kind: 'boolean', def: false }),
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
 * a garbage `setSetting` is ignored instead of writing `"yes"` into the state. Enums accept only a
 * string listed in `spec.values` — an unknown one is rejected rather than snapped to the default,
 * because silently rewriting a value the caller chose is worse than ignoring it.
 *
 * @param {string} key a `Settings` property name
 * @param {unknown} value candidate value
 * @returns {number|boolean|string|undefined} the coerced value, or `undefined` if the key is unknown
 *   or the value cannot be coerced (the caller must then leave the setting untouched)
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
  if (spec.kind === 'enum') {
    if (typeof value !== 'string') return undefined;
    const values = spec.values;
    return values !== undefined && values.indexOf(value) >= 0 ? value : undefined;
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
    mapMode: /** @type {import('../core/types.js').MapMode} */ (
      /** @type {any} */ (SETTING_SPEC.mapMode.def)
    ),
    reducedMotion: /** @type {boolean} */ (SETTING_SPEC.reducedMotion.def),
    invertLook: /** @type {boolean} */ (SETTING_SPEC.invertLook.def),
    fullscreen: /** @type {boolean} */ (SETTING_SPEC.fullscreen.def),
    autoExplore: /** @type {boolean} */ (SETTING_SPEC.autoExplore.def),
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

// ─── Unlocks (ARCHITECTURE.md §4.9) ──────────────────────────────────────────────────────────

/**
 * One unlock in the catalogue. `costs[r]` is the purse price of rank `r + 1`; `ranks[r]` is what
 * owning rank `r + 1` does, in the player's words (the Shrine and the Boon cards print it). The
 * catalogue is **data the UI shows**; the numbers the sim uses live in {@link UNLOCK_FX} and must be
 * edited together with the `ranks` text.
 * @typedef {Object} UnlockDef
 * @property {string} id
 * @property {string} name
 * @property {'torch'|'sight'|'fortune'} group
 * @property {number} max
 * @property {ReadonlyArray<number>} costs
 * @property {ReadonlyArray<string>} ranks
 * @property {string} blurb one line describing the unlock as a whole
 */

/** @typedef {import('../core/types.js').Progress} Progress */
/** @typedef {import('../core/types.js').Perks} Perks */

/**
 * Effect magnitudes per rank, indexed by rank (index 0 = not owned). Every number here is
 * **slack on top of the base economy**: the oil placement guarantee is built from `levelParams`
 * alone, which never sees these, so no value in this table can make a level unfinishable — the
 * worst a mistuned entry can do is make the game easier than intended.
 */
export const UNLOCK_FX = Object.freeze({
  /** × tank. 5 ranks of +10 %. */
  reservoir: Object.freeze([1, 1.1, 1.2, 1.3, 1.4, 1.5]),
  /** × flask value. 4 ranks of +12 %. */
  richOil: Object.freeze([1, 1.12, 1.24, 1.36, 1.48]),
  /** × drain. 4 ranks of −6 %. */
  slowWick: Object.freeze([1, 0.94, 0.88, 0.82, 0.76]),
  /** Seconds the ember rekindles a dead torch with, once per level. */
  ember: Object.freeze([0, 10, 18, 28]),
  /** Seconds of flask overflow the siphon reserve holds. */
  siphon: Object.freeze([0, 15, 30, 50]),
  /** × player torch light radius. */
  wideFlame: Object.freeze([1, 1.15, 1.3, 1.45]),
  /** Fog-of-war reveal radius, tiles. `src/ui/map.js` mirrors the maximum as `MAP.REVEAL_RADIUS`. */
  cartographer: Object.freeze([3, 4, 5]),
  /** Flask x-ray range, tiles. */
  oilSense: Object.freeze([0, 5, 8, 12]),
  /** Scroll-sense range, tiles. */
  scrollSense: Object.freeze([0, 14, 28]),
  /** Dead-end branch depth that darkens, tiles (255 = every branch, however deep). */
  whisper: Object.freeze([0, 4, 10, 255]),
  /** 1 = exit needle. */
  lodestone: Object.freeze([0, 1]),
  /** Chalk charges per level. */
  chalk: Object.freeze([0, 4, 8, 16]),
  /** Gem pull radius, tiles. Must stay ≤ 2.0 (see `WORLD.ITEM_GRID_TILES`). */
  magnet: Object.freeze([0, 1.2, 1.6, 2]),
  /** Purse gems per gem picked up. */
  appraiser: Object.freeze([1, 2, 3, 4]),
});

/**
 * The unlock catalogue, in Shrine order (torch, sight, fortune). Prices climb steeply per rank so
 * the first rank of anything is one or two floors of gems (level 2 carries ~11, level 5 ~43) while
 * a maxed build is a long-term goal across many runs.
 * @type {ReadonlyArray<UnlockDef>}
 */
export const UNLOCKS = Object.freeze([
  unlock('reservoir', 'Reservoir', 'torch', [15, 30, 55, 90, 140], 'A deeper oil tank for your torch.', [
    'Tank +10%', 'Tank +20%', 'Tank +30%', 'Tank +40%', 'Tank +50%']),
  unlock('richOil', 'Rich Oil', 'torch', [15, 35, 65, 110], 'Every flask burns longer.', [
    'Flasks +12%', 'Flasks +24%', 'Flasks +36%', 'Flasks +48%']),
  unlock('slowWick', 'Slow Wick', 'torch', [20, 45, 85, 140], 'The flame drinks oil more slowly.', [
    'Burn -6%', 'Burn -12%', 'Burn -18%', 'Burn -24%']),
  unlock('ember', 'Ember Reserve', 'torch', [25, 60, 120], 'Once per floor, a dead torch rekindles.', [
    'Rekindle for 10s', 'Rekindle for 18s', 'Rekindle for 28s']),
  unlock('siphon', 'Siphon', 'torch', [20, 50, 100], 'Spilled oil is saved and poured back in.', [
    'Store 15s of overflow', 'Store 30s of overflow', 'Store 50s of overflow']),
  unlock('wideFlame', 'Wide Flame', 'sight', [15, 35, 70], 'Your torch throws its light further.', [
    'Light +15%', 'Light +30%', 'Light +45%']),
  unlock('oilSense', 'Oil Sense', 'sight', [20, 50, 100], 'Nearby flasks glow through the walls.', [
    'Sense within 5 tiles', 'Sense within 8 tiles', 'Sense within 12 tiles']),
  unlock('whisper', 'Dead-End Whisper', 'sight', [40, 100, 180], 'Passages that lead nowhere grow dark.', [
    'Last 4 tiles darken', 'Last 10 tiles darken', 'Whole dead ends darken']),
  unlock('chalk', 'Chalk', 'fortune', [10, 30, 70], 'Scrawl A-MAZE on a wall to mark your way.', [
    '4 marks per floor', '8 marks per floor', '16 marks per floor']),
  unlock('magnet', 'Gem Magnet', 'fortune', [15, 40, 80], 'Gems in sight leap into your hand.', [
    'Pull within 1.2 tiles', 'Pull within 1.6 tiles', 'Pull within 2 tiles']),
  unlock('appraiser', 'Appraiser', 'fortune', [45, 120, 240], 'Each gem is worth more at the Shrine.', [
    '2 shrine gems per gem', '3 shrine gems per gem', '4 shrine gems per gem']),
]);

/**
 * Map unlocks retired from the catalogue for now: buying a map upgrade before the player has ever
 * found the map scroll was awkward. Their effects (`UNLOCK_FX`, `computePerks`, the HUD's scroll
 * sense and lodestone needle) stay wired but sit at rank 0. A save that owns ranks of one is
 * refunded the gems it paid (`sanitizeProgress`), once, because the ranks are dropped on that load.
 * Keyed by id; the value is the price list the catalogue charged.
 * @type {Readonly<Record<string, ReadonlyArray<number>>>}
 */
export const RETIRED_UNLOCK_COSTS = Object.freeze({
  cartographer: Object.freeze([30, 80]),
  scrollSense: Object.freeze([15, 40]),
  lodestone: Object.freeze([150]),
});

/**
 * Build one frozen catalogue entry.
 * @param {string} id
 * @param {string} name
 * @param {'torch'|'sight'|'fortune'} group
 * @param {number[]} costs
 * @param {string} blurb
 * @param {string[]} ranks
 * @returns {UnlockDef}
 */
function unlock(id, name, group, costs, blurb, ranks) {
  return Object.freeze({
    id,
    name,
    group,
    max: costs.length,
    costs: Object.freeze(costs.slice()),
    ranks: Object.freeze(ranks.slice()),
    blurb,
  });
}

/** Unlock ids in catalogue order. @type {ReadonlyArray<string>} */
export const UNLOCK_IDS = Object.freeze(UNLOCKS.map((u) => u.id));

/**
 * Catalogue entry by id, or undefined.
 * @param {unknown} id
 * @returns {UnlockDef|undefined}
 */
export function unlockDef(id) {
  if (typeof id !== 'string') return undefined;
  for (let i = 0; i < UNLOCKS.length; i++) if (UNLOCKS[i].id === id) return UNLOCKS[i];
  return undefined;
}

/**
 * Purse price of buying the rank after `rank`, or `Infinity` when there is none.
 * @param {string} id
 * @param {number} rank the rank currently owned
 * @returns {number}
 */
export function unlockCost(id, rank) {
  const def = unlockDef(id);
  const r = Number.isFinite(rank) ? Math.max(0, Math.floor(rank)) : 0;
  if (def === undefined || r >= def.max) return Infinity;
  return def.costs[r];
}

/**
 * Fresh, empty progression.
 * @returns {Progress}
 */
export function defaultProgress() {
  /** @type {Record<string, number>} */
  const ranks = {};
  for (let i = 0; i < UNLOCK_IDS.length; i++) ranks[UNLOCK_IDS[i]] = 0;
  return { purse: 0, ranks, boonLevel: 0 };
}

/**
 * Build a legal `Progress` from anything (it normally comes from `localStorage`): unknown ids are
 * dropped, ranks are clamped to each unlock's max, the purse and boon level to non-negative integers.
 * @param {unknown} src
 * @returns {Progress} a fresh object
 */
export function sanitizeProgress(src) {
  const out = defaultProgress();
  if (src === null || typeof src !== 'object') return out;
  const obj = /** @type {Record<string, unknown>} */ (src);
  const purse = obj.purse;
  if (typeof purse === 'number' && Number.isFinite(purse) && purse > 0) {
    out.purse = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(purse));
  }
  const boon = obj.boonLevel;
  if (typeof boon === 'number' && Number.isFinite(boon) && boon > 0) {
    out.boonLevel = Math.min(1e6, Math.floor(boon));
  }
  const ranks = obj.ranks;
  if (ranks !== null && typeof ranks === 'object' && !Array.isArray(ranks)) {
    const r = /** @type {Record<string, unknown>} */ (ranks);
    for (let i = 0; i < UNLOCKS.length; i++) {
      const def = UNLOCKS[i];
      const v = Object.prototype.hasOwnProperty.call(r, def.id) ? r[def.id] : undefined;
      if (typeof v === 'number' && Number.isFinite(v)) out.ranks[def.id] = clamp(Math.floor(v), 0, def.max);
    }
    // Refund the ranks of retired unlocks: the gems go back in the purse and the ranks are dropped.
    for (const id of Object.keys(RETIRED_UNLOCK_COSTS)) {
      const v = Object.prototype.hasOwnProperty.call(r, id) ? r[id] : undefined;
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const costs = RETIRED_UNLOCK_COSTS[id];
      const owned = clamp(Math.floor(v), 0, costs.length);
      for (let k = 0; k < owned; k++) out.purse = Math.min(Number.MAX_SAFE_INTEGER, out.purse + costs[k]);
    }
  }
  return out;
}

/**
 * Turn unlock ranks into the flat numbers the sim, HUD and renderer read (ARCHITECTURE.md §4.9).
 * Called on boot, `newGame`, `levelReady`, `buyUnlock` and `claimBoon` — never per step.
 * @param {Record<string, number>|null|undefined} ranks
 * @param {Perks} [out] filled in place when given (the state's own `perks` object)
 * @returns {Perks}
 */
export function computePerks(ranks, out) {
  const p = out || /** @type {Perks} */ ({});
  p.tankMult = perkFx(ranks, 'reservoir');
  p.oilMult = perkFx(ranks, 'richOil');
  p.drainMult = perkFx(ranks, 'slowWick');
  p.emberSeconds = perkFx(ranks, 'ember');
  p.siphonCap = perkFx(ranks, 'siphon');
  p.flame = perkFx(ranks, 'wideFlame');
  p.reveal = perkFx(ranks, 'cartographer');
  p.oilSense = perkFx(ranks, 'oilSense');
  p.scrollSense = perkFx(ranks, 'scrollSense');
  p.whisper = perkFx(ranks, 'whisper');
  p.lodestone = perkFx(ranks, 'lodestone');
  p.chalk = perkFx(ranks, 'chalk');
  p.magnet = perkFx(ranks, 'magnet');
  p.gemPurse = perkFx(ranks, 'appraiser');
  return p;
}

/**
 * The effect value of one unlock at the rank `ranks` holds (clamped into the table).
 * @param {Record<string, number>|null|undefined} ranks
 * @param {keyof typeof UNLOCK_FX} id
 * @returns {number}
 */
function perkFx(ranks, id) {
  const table = UNLOCK_FX[id];
  const raw = ranks && typeof ranks[id] === 'number' ? ranks[id] : 0;
  const r = Number.isFinite(raw) ? clamp(Math.floor(raw), 0, table.length - 1) : 0;
  return table[r];
}

/**
 * Unlock ids a boon may offer: everything still below its max rank, in catalogue order.
 * @param {Progress} progress
 * @returns {string[]}
 */
export function boonCandidates(progress) {
  /** @type {string[]} */
  const out = [];
  const ranks = progress && progress.ranks ? progress.ranks : {};
  for (let i = 0; i < UNLOCKS.length; i++) {
    const def = UNLOCKS[i];
    const r = typeof ranks[def.id] === 'number' ? ranks[def.id] : 0;
    if (r < def.max) out.push(def.id);
  }
  return out;
}

/** How many unlocks a boon offers. */
export const BOON_CHOICES = 3;

/**
 * Siphon reserve behaviour (Siphon unlock). The reserve pours back while the tank is below
 * `POUR_BELOW` of full, at `POUR_RATE` fuel-seconds per second — fast enough to matter within a
 * corridor, slow enough that the gauge visibly climbs rather than jumping.
 */
export const SIPHON = Object.freeze({
  POUR_BELOW: 0.5,
  POUR_RATE: 4,
});

/**
 * Chalk (Chalk unlock). `REACH` is how far the chalk hand reaches along the view, in tiles: far
 * enough to mark the wall closing a short stub, never across a junction.
 */
export const CHALK = Object.freeze({
  REACH: 2.5,
  /** DDA cells walked at most by the chalk ray (safety valve; 2.5 tiles cross at most 6 cells). */
  MAX_CELLS: 8,
});

/**
 * Reveal budget per step for a reveal radius. It grows by only 4 probes per extra tile of radius:
 * scaling it with the window's area (+16 per tile) measured as a 2.0× step cost at rank 2, and the
 * rolling cursor fills the wider ring within a few steps without it.
 * @param {number} radius tiles
 * @returns {number}
 */
export function revealBudget(radius) {
  const extra = Math.max(0, Math.floor(radius) - WORLD.REVEAL_RADIUS);
  return WORLD.REVEAL_BUDGET + 4 * extra;
}
