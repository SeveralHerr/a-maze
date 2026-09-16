// @ts-check
/**
 * @file The game state factory and the reducer — the whole phase machine (ARCHITECTURE.md §4.2).
 *
 * The reducer **mutates the store-owned state in place**; it never returns a new object and never
 * allocates per tick. It is total: any action at all can be dispatched at any time, and anything
 * that is not a legal transition for the current phase is ignored silently. That is what makes the
 * UI layer simple — a menu can dispatch `resume` without first checking whether it is paused.
 *
 * ## Phase machine (ARCHITECTURE.md §4.2)
 * ```
 *   title ──newGame──► loading ──levelReady──► playing ◄──pause/resume──► paused
 *                          ▲                     │  │
 *          nextLevel ──────┘                     │  └──fuel 0──► gameOver ──toTitle──► title
 *                          ▲                     └──exit──► levelComplete ──nextLevel──┘
 *                          │                                        └──────toTitle─────► title
 *   title ──levelReady──► title   (demo maze for the attract camera; phase is *kept*)
 * ```
 * `newGame` is also accepted from `gameOver`, `levelComplete` and `paused` (every place a UI
 * offers "restart"), but never from `playing` or `loading`: a run in progress can only be
 * abandoned deliberately, via pause.
 *
 * ## Events
 * `state.events` is cleared at the top of **every** dispatch, not only on `tick`. The contract only
 * requires clearing each step; clearing per action is a strict superset and it means the array
 * always holds exactly the events of the action just dispatched, so a store subscriber can route
 * them once with no risk of double-delivery or of a UI-driven event being silently dropped before
 * the next tick. The array identity never changes (`length = 0`), so consumers may hold a
 * reference to it.
 */

import { clamp, damp } from '../core/math.js';
import { createLogger } from '../core/log.js';
import {
  BOB,
  SETTING_KEYS,
  SIM,
  coerceSetting,
  drainRate,
  resolveTank,
  sanitizeBest,
  sanitizeSettings,
} from './balance.js';
import {
  allocExplored,
  buildItemGrid,
  completeLevel,
  createSimScratch,
  placePlayerAtStart,
  resetSimScratch,
  revealAround,
  setPhase,
  startAttract,
  stepAttract,
  stepPlaying,
  updateDerived,
} from './sim.js';

/** @typedef {import('../core/types.js').Action} Action */
/** @typedef {import('../core/types.js').GameState} GameState */
/** @typedef {import('../core/types.js').InputFrame} InputFrame */
/** @typedef {import('../core/types.js').LevelData} LevelData */
/** @typedef {import('../core/types.js').Settings} Settings */
/** @typedef {import('../core/types.js').BestScore} BestScore */
/** @typedef {import('./sim.js').SimInput} SimInput */
/**
 * The state this module builds and reduces: a `GameState` (ARCHITECTURE.md §3) plus the sim's
 * private scratch block. Structurally still a `GameState`, so every consumer typed against the
 * contract accepts it unchanged.
 * @typedef {import('./sim.js').SimState} State
 */

const log = createLogger('state');

/**
 * Reused, normalised input for one step. Module-level so `tick` allocates nothing; it never
 * escapes the synchronous reducer call.
 * @type {SimInput}
 */
const _input = { moveX: 0, moveY: 0, turn: 0, lookDX: 0, sprint: false };

/**
 * Phases from which `newGame` is honoured. See the phase-machine note in the file header.
 * @type {ReadonlyArray<string>}
 */
const NEW_GAME_FROM = Object.freeze(['title', 'gameOver', 'levelComplete', 'paused']);

/**
 * Phases from which `toTitle` is honoured.
 * @type {ReadonlyArray<string>}
 */
const TO_TITLE_FROM = Object.freeze(['gameOver', 'levelComplete', 'paused']);

/**
 * Build a fresh `GameState`.
 *
 * Both arguments are treated as untrusted (they normally come from `localStorage` via `save.js`):
 * anything missing or out of range degrades to the factory default rather than poisoning the run.
 *
 * @param {unknown} [settings] persisted settings, or undefined for factory defaults
 * @param {unknown} [best] persisted best score, or undefined for a clean slate
 * @returns {State} a state in phase `title` with no level loaded (a valid `GameState`)
 */
export function createInitialState(settings, best) {
  const sanitizedBest = sanitizeBest(best);
  return {
    phase: 'title',
    time: 0,
    phaseTime: 0,
    level: 1,
    seed: 0,
    levelData: null,
    player: {
      x: 1.5,
      y: 1.5,
      angle: 0,
      px: 1.5,
      py: 1.5,
      pangle: 0,
      vx: 0,
      vy: 0,
      bob: 0,
      bobAmp: 0,
      shake: 0,
    },
    explored: null,
    run: {
      score: 0,
      gems: 0,
      gemsTotal: 0,
      fuel: 0,
      fuelMax: 0,
      levelTime: 0,
      totalTime: 0,
      levelScore: 0,
      bestCombo: 0,
      // Massive-maze statistics (§3 RunStats): flasks burned this level, tiles walked this run.
      // On a 14-minute labyrinth these are what describe the run; the HUD shows the refuel tally
      // live and the end screens show both.
      refuels: 0,
      distance: 0,
    },
    best: sanitizedBest,
    settings: sanitizeSettings(settings),
    derived: { exitDist: Infinity, nearExit: 0, lowFuel: false },
    events: [],
    // Non-contract simulation scratch — see SimScratch in sim.js.
    sim: createSimScratch(),
  };
}

/**
 * The reducer (ARCHITECTURE.md §4.2). Mutates `state` in place; returns nothing.
 *
 * Never throws for any input: a non-object action, a missing `type`, an unknown `type`, a `tick`
 * with a NaN `dt` or a null input frame, a `levelReady` carrying malformed data — all are ignored.
 *
 * @param {State} state the store-owned state
 * @param {Action|{type:string}|unknown} action
 * @returns {void}
 */
export function reducer(state, action) {
  if (state === null || typeof state !== 'object') return;
  if (action === null || typeof action !== 'object') return;
  const a = /** @type {Record<string, unknown>} */ (action);
  const type = a.type;
  if (typeof type !== 'string') return;

  // Events always describe exactly the action being dispatched (see file header).
  state.events.length = 0;

  switch (type) {
    case 'tick':
      applyTick(state, /** @type {number} */ (a.dt), a.input);
      return;
    case 'newGame':
      applyNewGame(state, a.seed);
      return;
    case 'levelReady':
      applyLevelReady(state, a.data);
      return;
    case 'pause':
      // Only meaningful while playing; pausing a menu is a no-op, not an error.
      if (state.phase === 'playing') setPhase(state, 'paused');
      return;
    case 'resume':
      if (state.phase === 'paused') setPhase(state, 'playing');
      return;
    case 'nextLevel':
      if (state.phase === 'levelComplete') {
        state.level++;
        setPhase(state, 'loading');
      }
      return;
    case 'toTitle':
      if (TO_TITLE_FROM.indexOf(state.phase) >= 0) {
        setPhase(state, 'title');
        // Re-seed the wander so the title camera starts from the maze start, whatever maze the
        // run left loaded. main.js may replace it with the demo maze via `levelReady`.
        startAttract(state);
      }
      return;
    case 'setSetting':
      applySetSetting(state, a.key, a.value);
      return;
    case 'debugWin':
      // Headless tools only (§4.2): win the current level outright.
      if (state.phase === 'playing') completeLevel(state);
      return;
    default:
      // Unknown action types are ignored by design — forward compatibility with new UI actions.
      return;
  }
}

// ─── tick ────────────────────────────────────────────────────────────────────────────────────

/**
 * Coerce an untrusted `InputFrame` into the reused `_input` block. Every field is forced finite
 * and in range so no downstream arithmetic can produce NaN from bad input.
 * @param {unknown} src
 * @returns {SimInput} the module-level block (do not retain)
 */
function readInput(src) {
  if (src === null || typeof src !== 'object') {
    _input.moveX = 0;
    _input.moveY = 0;
    _input.turn = 0;
    _input.lookDX = 0;
    _input.sprint = false;
    return _input;
  }
  const f = /** @type {Record<string, unknown>} */ (src);
  _input.moveX = axis(f.moveX);
  _input.moveY = axis(f.moveY);
  _input.turn = axis(f.turn);
  const look = f.lookDX;
  _input.lookDX =
    typeof look === 'number' && Number.isFinite(look)
      ? clamp(look, -SIM.MAX_LOOK_DX, SIM.MAX_LOOK_DX)
      : 0;
  _input.sprint = f.sprint === true;
  return _input;
}

/**
 * Coerce one analogue axis to a finite value in [-1, 1].
 * @param {unknown} v
 * @returns {number}
 */
function axis(v) {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, -1, 1) : 0;
}

/**
 * Advance the simulation by one fixed step.
 * @param {State} state
 * @param {unknown} rawDt seconds
 * @param {unknown} rawInput
 * @returns {void}
 */
function applyTick(state, rawDt, rawInput) {
  const dt =
    typeof rawDt === 'number' && Number.isFinite(rawDt) ? clamp(rawDt, 0, SIM.MAX_DT) : 0;
  // A zero or negative dt advances nothing — including the interpolation snapshot, so a paused
  // frame does not collapse the renderer's alpha blend.
  if (dt <= 0) return;

  state.time += dt;
  state.phaseTime += dt;

  const phase = state.phase;
  if (phase === 'playing') {
    stepPlaying(state, dt, readInput(rawInput));
    return;
  }
  if (phase === 'title') {
    stepAttract(state, dt);
    return;
  }

  // loading / paused / levelComplete / gameOver: the world is frozen, but the camera settles so a
  // bump that ended the level does not leave the view locked mid-shake.
  const p = state.player;
  p.px = p.x;
  p.py = p.y;
  p.pangle = p.angle;
  p.shake = damp(p.shake, 0, BOB.SHAKE_DECAY, dt);
  p.bobAmp = damp(p.bobAmp, 0, BOB.AMP_RATE, dt);
}

// ─── newGame ─────────────────────────────────────────────────────────────────────────────────

/**
 * Start a new run at level 1 and enter `loading`. `levelData` and `explored` are deliberately left
 * in place so the renderer keeps a coherent backdrop behind the loading screen until
 * `levelReady` swaps both atomically.
 * @param {State} state
 * @param {unknown} rawSeed
 * @returns {void}
 */
function applyNewGame(state, rawSeed) {
  if (NEW_GAME_FROM.indexOf(state.phase) < 0) return;

  const seed =
    typeof rawSeed === 'number' && Number.isFinite(rawSeed) ? rawSeed >>> 0 : state.seed >>> 0;
  state.seed = seed;
  state.level = 1;

  const run = state.run;
  run.score = 0;
  run.gems = 0;
  run.gemsTotal = 0;
  run.fuel = 0;
  run.fuelMax = 0;
  run.levelTime = 0;
  run.totalTime = 0;
  run.levelScore = 0;
  run.bestCombo = 0;
  run.refuels = 0;
  run.distance = 0;

  resetSimScratch(state.sim);
  state.sim.rng = null;
  // `newBest` is measured against the record this run started with (see sim.recordBest).
  state.sim.runBestScore = state.best.score;

  state.derived.lowFuel = false;
  setPhase(state, 'loading');
}

// ─── levelReady ──────────────────────────────────────────────────────────────────────────────

/**
 * Cheap structural check on level data arriving from the maze worker. A malformed payload is
 * dropped rather than installed, because a maze with a mis-sized tile array would corrupt every
 * downstream index.
 * @param {unknown} data
 * @returns {data is LevelData}
 */
function isLevelData(data) {
  if (data === null || typeof data !== 'object') return false;
  const d = /** @type {Record<string, unknown>} */ (data);
  const maze = d.maze;
  if (maze === null || typeof maze !== 'object') return false;
  const m = /** @type {Record<string, unknown>} */ (maze);
  const w = m.width;
  const h = m.height;
  if (typeof w !== 'number' || typeof h !== 'number') return false;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return false;
  const tiles = m.tiles;
  if (!(tiles instanceof Uint8Array) || tiles.length !== w * h) return false;
  // start/exit must be in-bounds integer tiles: `placePlayerAtStart` floors them straight into the
  // player position, so a missing coordinate would spawn the player at NaN and poison every step
  // downstream — the one malformed field that cannot be allowed through.
  if (!isTileCoord(m.start, w, h) || !isTileCoord(m.exit, w, h)) return false;
  if (!Array.isArray(d.items) || !Array.isArray(d.torches)) return false;
  return true;
}

/**
 * Is `v` a `{x, y}` naming a tile inside a w×h map?
 * @param {unknown} v
 * @param {number} w
 * @param {number} h
 * @returns {boolean}
 */
function isTileCoord(v, w, h) {
  if (v === null || typeof v !== 'object') return false;
  const p = /** @type {Record<string, unknown>} */ (v);
  const x = p.x;
  const y = p.y;
  if (typeof x !== 'number' || typeof y !== 'number') return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= 0 && y >= 0 && x < w && y < h;
}

/**
 * Install a level. In `loading` it starts the level and enters `playing`; in `title` it becomes
 * the demo maze for the attract camera and the phase is kept (ARCHITECTURE.md §4.2). Any other
 * phase ignores it, so a late worker response for an abandoned level cannot hijack the run.
 * @param {State} state
 * @param {unknown} data
 * @returns {void}
 */
function applyLevelReady(state, data) {
  const phase = state.phase;
  if (phase !== 'loading' && phase !== 'title') return;
  if (!isLevelData(data)) {
    log.warn('levelReady ignored: malformed level data');
    return;
  }
  const level = /** @type {LevelData} */ (data);
  const maze = level.maze;

  state.levelData = level;
  // Sized to the new maze; allocated together with levelData so the pair is always consistent.
  // A 257×257 level needs 66 kB of it, so it comes from a pool rather than the allocator.
  state.explored = allocExplored(state, maze.width * maze.height);
  resetSimScratch(state.sim);
  // Once per level, never per step: a level carries up to ~820 items (ARCHITECTURE.md §4.2).
  buildItemGrid(state);

  if (phase === 'title') {
    startAttract(state);
    return;
  }

  // Items are state-owned once installed; reset `taken` so a replayed/cached level is playable.
  const items = level.items;
  let gems = 0;
  for (let i = 0; i < items.length; i++) {
    items[i].taken = false;
    if (items[i].kind === 'gem') gems++;
  }

  const run = state.run;
  // The tank is `src/state`'s number, not the maze's (see balance.resolveTank): the torch economy
  // depends on it being small and independent of the maze's area.
  const fuel = resolveTank(state.level, level.fuel);
  run.fuelMax = fuel;
  run.fuel = fuel;
  run.gems = 0;
  run.gemsTotal = gems;
  run.levelTime = 0;
  run.levelScore = 0;
  // Refuels are a per-level statistic (the HUD's TANK ×N tally); `distance` is per run and is
  // deliberately *not* reset here, so "WALKED" on the game-over screen covers the whole descent.
  run.refuels = 0;

  state.sim.drain = drainRate(state.level);
  state.sim.rng = null;
  placePlayerAtStart(state);
  revealAround(state);
  updateDerived(state);
  setPhase(state, 'playing');
  state.events.push({ type: 'levelStart', level: state.level });
}

// ─── setSetting ──────────────────────────────────────────────────────────────────────────────

/**
 * Validate and apply one settings change. Unknown keys and uncoercible values are ignored, so the
 * settings object can never leave its declared ranges (ARCHITECTURE.md §3).
 * @param {State} state
 * @param {unknown} key
 * @param {unknown} value
 * @returns {void}
 */
function applySetSetting(state, key, value) {
  if (typeof key !== 'string') return;
  if (SETTING_KEYS.indexOf(/** @type {keyof Settings} */ (key)) < 0) return;
  const coerced = coerceSetting(key, value);
  if (coerced === undefined) return;
  // @ts-expect-error — key is a validated Settings key and coerced matches its declared type.
  state.settings[key] = coerced;
}
