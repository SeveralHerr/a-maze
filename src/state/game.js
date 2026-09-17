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
 * **Abandoning a run keeps its score.** `best` is folded in (`sim.recordBest`) on a level clear and
 * on game over; `toTitle` and `newGame` from `paused` fold it in too, before the run is discarded,
 * so quitting a ten-minute level from the pause menu cannot throw away the gems already collected
 * or a record the run had already beaten. (main.js persists on `levelComplete`/`gameOver`; the
 * quit path reaches storage on main.js's next persist unless it also persists on entering `title`.)
 *
 * ## Events
 * `state.events` is cleared at the top of **every** dispatch, not only on `tick`. The contract only
 * requires clearing each step; clearing per action is a strict superset and it means the array
 * always holds exactly the events of the action just dispatched, so a store subscriber can route
 * them once with no risk of double-delivery or of a UI-driven event being silently dropped before
 * the next tick. The array identity never changes (it is emptied in place), so consumers may hold a
 * reference to it.
 */

import { clamp, damp } from '../core/math.js';
import { createLogger } from '../core/log.js';
import { applyMid, sanitizeRunSave } from './runsave.js';
import {
  BOB,
  SETTING_KEYS,
  SIM,
  coerceSetting,
  computePerks,
  drainRate,
  oilFuel,
  resolveTank,
  sanitizeBest,
  sanitizeProgress,
  sanitizeSettings,
  unlockCost,
  unlockDef,
} from './balance.js';
import {
  allocExplored,
  buildItemGrid,
  completeLevel,
  createSimScratch,
  placePlayerAtStart,
  recordBest,
  resetSimScratch,
  revealAround,
  setPhase,
  startAttract,
  stepAttractBody,
  stepDt,
  stepPlayingBody,
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
const _input = { moveX: 0, moveY: 0, turn: 0, lookDX: 0, chalk: false, auto: false };

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
 * Phases in which the Shrine is open for `buyUnlock` (ARCHITECTURE.md §4.9): the title and the two
 * end screens. Never mid-level — a purchase changes the perks, and perks are fixed for a level.
 * @type {ReadonlyArray<string>}
 */
const SHRINE_FROM = Object.freeze(['title', 'levelComplete', 'gameOver']);

/**
 * Build a fresh `GameState`.
 *
 * Both arguments are treated as untrusted (they normally come from `localStorage` via `save.js`):
 * anything missing or out of range degrades to the factory default rather than poisoning the run.
 *
 * @param {unknown} [settings] persisted settings, or undefined for factory defaults
 * @param {unknown} [best] persisted best score, or undefined for a clean slate
 * @param {unknown} [progress] persisted unlocks and purse (§4.9), or undefined for none
 * @returns {State} a state in phase `title` with no level loaded (a valid `GameState`)
 */
export function createInitialState(settings, best, progress) {
  const sanitizedBest = sanitizeBest(best);
  const sanitizedProgress = sanitizeProgress(progress);
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
      // No level is loaded yet, so there is no scroll to find; `levelReady` sets it (§4.8).
      mapFound: true,
      // Unlocks wave (§4.9): chalk charges left, siphon reserve, and this level's ember spent.
      chalk: 0,
      reserve: 0,
      emberUsed: false,
    },
    best: sanitizedBest,
    settings: sanitizeSettings(settings),
    derived: { exitDist: Infinity, nearExit: 0, lowFuel: false, scrollSense: 0 },
    progress: sanitizedProgress,
    perks: computePerks(sanitizedProgress.ranks),
    offer: { open: false, level: 0, ids: [] },
    marks: [],
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
  clearEvents(state.events);

  switch (type) {
    case 'tick':
      applyTick(state, /** @type {number} */ (a.dt), a.input, a.auto === true);
      return;
    case 'newGame':
      applyNewGame(state, a.seed);
      return;
    case 'continueRun':
      applyContinueRun(state, a.save);
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
        // An unclaimed boon is forfeited, not banked: `progress.boonLevel` is untouched, so the same
        // depth offers one again on a later run (§4.9).
        closeOffer(state);
        state.level++;
        setPhase(state, 'loading');
      }
      return;
    case 'buyUnlock':
      applyBuyUnlock(state, a.id);
      return;
    case 'claimBoon':
      applyClaimBoon(state, a.id);
      return;
    case 'toTitle':
      if (TO_TITLE_FROM.indexOf(state.phase) >= 0) {
        closeOffer(state);
        // Quitting from pause abandons a live run: its points still count toward the record.
        if (state.phase === 'paused') recordBest(state);
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

/**
 * Empty the events array in place, **keeping its backing store**.
 *
 * `events.length = 0` makes V8 swap the elements for the shared empty store, so the next `push`
 * (a footstep every ~18 ticks while walking) allocates a fresh 17-slot backing store — measured at
 * ~3–6 B/tick of garbage from that alone. Popping trims nothing below V8's slack threshold, so the
 * capacity survives and a push reuses it. A dispatch carries a handful of events at most, so the
 * loop is a few iterations; the array identity never changes either way.
 * @param {Array<unknown>} events
 * @returns {void}
 */
function clearEvents(events) {
  while (events.length > 0) events.pop();
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
    _input.chalk = false;
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
  const pressed = /** @type {any} */ (f.pressed);
  _input.chalk = pressed !== null && typeof pressed === 'object' && typeof pressed.has === 'function' && pressed.has('chalk') === true;
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
 * @param {boolean} auto the frame was written by Auto Explore (§4.10): the torch burns at its pace
 * @returns {void}
 */
function applyTick(state, rawDt, rawInput, auto) {
  // A zero, negative or non-finite dt advances nothing — including the interpolation snapshot, so a
  // paused frame does not collapse the renderer's alpha blend.
  if (typeof rawDt !== 'number' || !(rawDt > 0) || rawDt === Infinity) return;
  const dt = rawDt > SIM.MAX_DT ? SIM.MAX_DT : rawDt;
  // `dt` reaches the step through a typed-array slot, not as an argument: a double passed to a call
  // the compiler does not inline is boxed into a new HeapNumber every tick (sim.js `_move`).
  stepDt[0] = dt;

  state.time += dt;
  state.phaseTime += dt;

  const phase = state.phase;
  if (phase === 'playing') {
    const input = readInput(rawInput);
    input.auto = auto;
    stepPlayingBody(state, input);
    return;
  }
  if (phase === 'title') {
    stepAttractBody(state);
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
  // Restarting from pause abandons a live run; fold it into `best` before the run is reset.
  if (state.phase === 'paused') recordBest(state);

  const seed =
    typeof rawSeed === 'number' && Number.isFinite(rawSeed) ? rawSeed >>> 0 : state.seed >>> 0;
  state.seed = seed;
  state.level = 1;
  resetRun(state);
  // `newBest` is measured against the record this run started with (see sim.recordBest).
  state.sim.runBestScore = state.best.score;
  setPhase(state, 'loading');
}

/**
 * Pick a saved run back up (ARCHITECTURE.md §4.10). Only from the title, and only for a save that
 * sanitises. The run's totals are restored now; the level is built by main.js exactly as for a
 * descent, and `levelReady` puts a mid-level snapshot back onto it (see `applyLevelReady`).
 * @param {State} state
 * @param {unknown} rawSave
 * @returns {void}
 */
function applyContinueRun(state, rawSave) {
  if (state.phase !== 'title') return;
  const save = sanitizeRunSave(rawSave);
  if (save === null) {
    log.warn('continueRun ignored: malformed save');
    return;
  }
  state.seed = save.seed;
  state.level = save.level;
  resetRun(state);
  const run = state.run;
  run.score = save.totals.score;
  run.totalTime = save.totals.totalTime;
  run.distance = save.totals.distance;
  run.bestCombo = save.totals.bestCombo;
  state.sim.runBestScore = save.runBest;
  state.sim.resume = save;
  setPhase(state, 'loading');
}

/**
 * Zero the run (score, counters, perks snapshot, offer, marks, sim scratch) for a run starting at
 * `state.level`. Shared by `newGame` and `continueRun`; neither changes the phase here.
 * @param {State} state
 * @returns {void}
 */
function resetRun(state) {
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
  run.chalk = 0;
  run.reserve = 0;
  run.emberUsed = false;
  // A run's perks are the ranks owned when it starts (the Shrine is closed mid-run anyway).
  refreshPerks(state);
  closeOffer(state);
  clearMarks(state);
  // Locked until `levelReady` decides (§4.8). `false`, not `true`: the HUD shows "MAP FOUND" on a
  // false→true delta, so resetting to true here would flash that banner at the start of every run
  // that follows one where the scroll was never found.
  run.mapFound = false;

  resetSimScratch(state.sim);
  state.sim.rng = null;
  state.sim.resume = null;

  state.derived.lowFuel = false;
}

// ─── levelReady ──────────────────────────────────────────────────────────────────────────────

/**
 * Cap on how many `items`/`torches` entries `isLevelData` will inspect. A real level carries ~820
 * items and ~1 300 torches at the 128×128 cap (ARCHITECTURE.md §4.2); 8 192 is an order of
 * magnitude of headroom, and anything past it is not a level this build produced.
 */
const MAX_VALIDATED_ENTRIES = 8192;

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
  // Element-level validation, not just "is an array". `buildItemGrid` dereferences `items[i].x` and
  // `applyLevelReady` writes `items[i].taken`, so a null or a number in there throws *after* the
  // state has been half-installed — which breaks the "never throws for any input" contract in this
  // file's header and in ARCHITECTURE.md §4.2. The scan is capped so a hostile payload cannot cost
  // a frame; past the cap the payload is rejected outright rather than partially trusted.
  if (d.items.length > MAX_VALIDATED_ENTRIES || d.torches.length > MAX_VALIDATED_ENTRIES) return false;
  for (let i = 0; i < d.items.length; i++) {
    const it = d.items[i];
    if (it === null || typeof it !== 'object') return false;
    if (!Number.isFinite(it.x) || !Number.isFinite(it.y)) return false;
    if (it.kind !== 'gem' && it.kind !== 'oil' && it.kind !== 'map') return false;
  }
  for (let i = 0; i < d.torches.length; i++) {
    const t = d.torches[i];
    if (t === null || typeof t !== 'object') return false;
  }
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
  // A saved run being continued (§4.10). Taken before `resetSimScratch`, and consumed either way:
  // one save is applied to exactly one level install.
  const resume = phase === 'loading' ? state.sim.resume : null;
  state.sim.resume = null;

  state.levelData = level;
  // Sized to the new maze; allocated together with levelData so the pair is always consistent.
  // A 257×257 level needs 66 kB of it, so it comes from a pool rather than the allocator.
  state.explored = allocExplored(state, maze.width * maze.height);
  resetSimScratch(state.sim);
  // Once per level, never per step: a level carries up to ~820 items (ARCHITECTURE.md §4.2).
  buildItemGrid(state);

  const run = state.run;
  // Items are state-owned once installed; reset `taken` so a replayed/cached level is playable.
  // The same pass decides whether the map is locked (§4.8): a level with a scroll starts locked, a
  // level without one (fixtures, previews, older cached levels) must not lock the map for ever.
  const items = level.items;
  const playable = phase === 'loading';
  let gems = 0;
  let hasMap = false;
  for (let i = 0; i < items.length; i++) {
    const kind = items[i].kind;
    if (playable) items[i].taken = false;
    if (kind === 'gem') gems++;
    else if (kind === 'map') {
      hasMap = true;
      // Cached once per level so Scroll Sense costs one distance per step (§4.9).
      state.sim.scrollIdx = i;
    }
  }
  run.mapFound = !hasMap;
  clearMarks(state);

  if (phase === 'title') {
    startAttract(state);
    return;
  }

  // The tank is `src/state`'s number, not the maze's (see balance.resolveTank): the torch economy
  // depends on it being small and independent of the maze's area.
  const fuel = resolveTank(state.level, level.fuel);
  // Unlocks only ever ADD to the base economy the level was built for (§4.9): the tank grows, the
  // flask is priced off the base tank, and the drain can only fall.
  refreshPerks(state);
  const perks = state.perks;
  const tank = Math.max(fuel, Math.round(fuel * perks.tankMult));
  run.fuelMax = tank;
  run.fuel = tank;
  run.chalk = perks.chalk;
  run.reserve = 0;
  run.emberUsed = false;
  run.gems = 0;
  run.gemsTotal = gems;
  run.levelTime = 0;
  run.levelScore = 0;
  // Refuels are a per-level statistic (the HUD's TANK ×N tally); `distance` is per run and is
  // deliberately *not* reset here, so "WALKED" on the game-over screen covers the whole descent.
  run.refuels = 0;

  state.sim.drain = drainRate(state.level) * Math.min(1, perks.drainMult);
  state.sim.flaskBase = oilFuel(fuel);
  state.sim.rng = null;
  placePlayerAtStart(state);
  if (resume !== null && resume.mid !== null && resume.level === state.level) {
    // A mismatch (the generator changed since the save) leaves the level as freshly installed: the
    // run's totals survive and the floor starts over, which is the most a save can promise.
    // (A low tank restored this way re-sounds the low-fuel cue once: a fair reminder on resuming.)
    if (!applyMid(state, resume.mid)) log.warn('saved level does not match the level built; starting it fresh');
  }
  revealAround(state);
  updateDerived(state);
  setPhase(state, 'playing');
  state.events.push({ type: 'levelStart', level: state.level });
}

// ─── Unlocks (ARCHITECTURE.md §4.9) ──────────────────────────────────────────────────────────

/**
 * Recompute `state.perks` from `state.progress.ranks`, in place. A state built by hand without the
 * unlock blocks (an old fixture) gets them here rather than throwing.
 * @param {State} state
 * @returns {void}
 */
function refreshPerks(state) {
  if (!state.progress) state.progress = sanitizeProgress(null);
  if (!state.perks) state.perks = computePerks(state.progress.ranks);
  else computePerks(state.progress.ranks, state.perks);
}

/**
 * Close any pending boon offer.
 * @param {State} state
 * @returns {void}
 */
function closeOffer(state) {
  if (!state.offer) {
    state.offer = { open: false, level: 0, ids: [] };
    return;
  }
  state.offer.open = false;
}

/**
 * Empty the level's chalk marks. A fresh array rather than `length = 0`, so the renderer — which
 * keys its chalk mask on the array's identity — can never mistake the new level's marks for an
 * extension of the old one's.
 * @param {State} state
 * @returns {void}
 */
function clearMarks(state) {
  if (!Array.isArray(state.marks) || state.marks.length > 0) state.marks = [];
}

/**
 * Buy the next rank of an unlock at the Shrine. Ignored outside `SHRINE_FROM`, for an unknown id, a
 * maxed unlock, or a purse that cannot pay.
 * @param {State} state
 * @param {unknown} id
 * @returns {void}
 */
function applyBuyUnlock(state, id) {
  if (SHRINE_FROM.indexOf(state.phase) < 0) return;
  const def = unlockDef(id);
  if (def === undefined) return;
  refreshPerks(state);
  const progress = state.progress;
  const rank = progress.ranks[def.id] | 0;
  const cost = unlockCost(def.id, rank);
  if (!(cost <= progress.purse)) return;
  progress.purse -= cost;
  progress.ranks[def.id] = rank + 1;
  computePerks(progress.ranks, state.perks);
  state.events.push({ type: 'unlock', id: def.id, rank: rank + 1, boon: false });
}

/**
 * Claim one of the open boon's unlocks for free. Ignored unless a boon is open in `levelComplete`
 * and `id` is one of the offered ids and still below its max.
 * @param {State} state
 * @param {unknown} id
 * @returns {void}
 */
function applyClaimBoon(state, id) {
  if (state.phase !== 'levelComplete') return;
  const offer = state.offer;
  if (!offer || !offer.open || typeof id !== 'string' || offer.ids.indexOf(id) < 0) return;
  const def = unlockDef(id);
  if (def === undefined) return;
  refreshPerks(state);
  const progress = state.progress;
  const rank = progress.ranks[def.id] | 0;
  if (rank >= def.max) return;
  progress.ranks[def.id] = rank + 1;
  if (offer.level > progress.boonLevel) progress.boonLevel = offer.level;
  offer.open = false;
  computePerks(progress.ranks, state.perks);
  state.events.push({ type: 'unlock', id: def.id, rank: rank + 1, boon: true });
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
