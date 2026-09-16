// @ts-check
/**
 * @file Every full-screen interface in A-MAZE: title, options, credits, pause, loading, level
 * complete and game over (ARCHITECTURE.md §4.6).
 *
 * The menus are an **immediate-mode** layer: `render` lays the current screen out from scratch
 * every frame and records the rectangle of each interactive row as it goes; `handlePointer` then
 * hit-tests that recorded layout. There is no retained widget tree to keep in sync with the game
 * state, which is what makes "the pause menu is live while the world is still visible behind it"
 * free rather than fiddly.
 *
 * ## What it owns and what it does not
 * The menus own exactly one piece of state: which row is selected, and which sub-screen is open.
 * Everything else is read from the `GameState` and written back through the callbacks — a menu
 * never mutates game state, never dispatches, and never keeps its own copy of a setting
 * (ARCHITECTURE.md §2: "UI buttons → ui callbacks → main.js → store.dispatch").
 *
 * ## Frame protocol
 * `render` opens the overlay frame only if the HUD did not (see `hud.js`), so the documented order
 * `hud.render(); menus.render();` draws the menus over the HUD, and either call on its own also
 * works.
 *
 * ## Constants mirrored from `src/state`
 * `src/ui` may not import `src/state` (§2), so the score formulas of §1 and the settings ranges of
 * §4.2 are mirrored in `SCORE_RULES` and the slider definitions below. They are reported as a
 * contract deviation; if `balance.js` changes, they must change with it.
 */

import { clamp, clamp01 } from '../core/math.js';
import { createLogger } from '../core/log.js';
import { COLOR, drawText, lineHeight, measureLine, textHeight } from './font.js';
import {
  createCounter,
  formatCount,
  formatDistance,
  formatInt,
  formatLabyrinth,
  formatLevelBanner,
  formatPercent,
  formatTime,
} from './format.js';
import {
  MAP_MODES,
  MAP_MODE_LABEL,
  countExplored,
  readMapMode,
  setMapMode,
} from './map.js';
import {
  createSurface,
  drawArt,
  compileArt,
  drawFlame,
  drawPanel,
  drawWell,
  fitScale,
  withAlpha,
  ICON_SIZE,
} from './hud.js';

/** @typedef {import('../core/types.js').GameState} GameState */
/** @typedef {import('../core/types.js').InputFrame} InputFrame */
/** @typedef {import('../core/types.js').InputAction} InputAction */
/** @typedef {import('../core/types.js').Settings} Settings */
/** @typedef {import('./hud.js').Surface} Surface */
/** @typedef {import('./hud.js').SurfaceMetrics} SurfaceMetrics */

const log = createLogger('ui/menus');

// ─── Mirrored balance constants ──────────────────────────────────────────────────────────────

/**
 * The score formulas from ARCHITECTURE.md §1, mirrored because `src/ui` may not import
 * `src/state/balance.js`. Only the level-complete tally uses them, and it cross-checks itself
 * against `run.levelScore` (which the sim computed) so a drift here shows up as a wrong *split*,
 * never as a wrong total.
 * @type {Readonly<Record<string, number>>}
 */
const SCORE_RULES = Object.freeze({
  /** Points per gem, before ×level. */
  GEM_BASE: 100,
  /** Flat points for clearing a level, before ×level. */
  CLEAR_BASE: 500,
  /** Points per whole fuel-second left, before ×level. */
  FUEL_UNIT: 10,
});

/**
 * The maze size curve of `LEVEL` in `src/state/balance.js`, mirrored for the **loading screen**.
 *
 * WHY it has to be mirrored rather than read: during `loading` the state deliberately still holds
 * the *previous* level's `levelData` (ARCHITECTURE.md §4.2), so the size of the labyrinth being
 * carved is not in the state at all — it is a function of `state.level`. And `src/ui` may not
 * import `src/state` (§2). Every other size readout in the UI (the HUD's depth panel, the map
 * header, the end screens) uses the real `maze.cols`/`maze.rows`; this mirror is used for exactly
 * one line of text, so a drift shows up as a wrong banner on the loading screen and nowhere else.
 * It must be updated together with `balance.js`.
 * @type {Readonly<Record<string, number>>}
 */
const LEVEL_RULES = Object.freeze({
  /** `LEVEL.BASE_CELLS` — cells per side on depth 1. */
  BASE_CELLS: 16,
  /** `LEVEL.GROWTH` — cells added per side per depth. */
  GROWTH: 8,
  /** `LEVEL.MAX_CELLS` — the single size knob; past it, levels get harder, not bigger. */
  MAX_CELLS: 128,
});

/**
 * Cells per side of the labyrinth at a given depth (the mirror of `levelParams().cols`).
 * @param {number} level 1-based
 * @returns {number}
 */
export function cellsForLevel(level) {
  const lv = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  return Math.min(LEVEL_RULES.MAX_CELLS, LEVEL_RULES.BASE_CELLS + (lv - 1) * LEVEL_RULES.GROWTH);
}

// ─── Timing ──────────────────────────────────────────────────────────────────────────────────

/** Seconds a screen takes to fade/slide in. */
const ENTER_TIME = 0.26;
/** Seconds between two tally rows starting to roll. */
const TALLY_STAGGER = 0.42;
/** Seconds the tally waits before the first row appears. */
const TALLY_DELAY = 0.5;
/** Largest clock delta integrated in one frame. */
const MAX_FRAME_DT = 0.25;
/** Rows the tally has. */
const TALLY_ROWS = 4;

// ─── Menu model ──────────────────────────────────────────────────────────────────────────────

/**
 * One row of a menu.
 * @typedef {Object} MenuItem
 * @property {string} id            stable identifier; `activate` switches on it
 * @property {string} label         display text
 * @property {'action'|'slider'|'toggle'|'choice'|'back'} kind
 * @property {keyof Settings} [key] the setting a slider/toggle edits
 * @property {number} [min]         slider minimum
 * @property {number} [max]         slider maximum
 * @property {number} [step]        slider increment per keypress
 * @property {'percent'|'mult'} [format] how a slider's value is written
 * @property {ReadonlyArray<string>} [values] `choice`: the cycle, in order
 * @property {(v:string) => string} [labelOf] `choice`: value → display word
 * @property {(state:GameState) => string} [read] `choice`: the value in force
 * @property {(v:string, set:(key:string, value:unknown) => void) => void} [write] `choice`: apply a
 *   value. It is handed the settings writer rather than calling `onSetting` itself, so a choice
 *   that shadows more than one stored field (the map does — see `map.js`) stays declarative.
 * @property {(state:GameState) => boolean} [enabled] defaults to always enabled
 */

/**
 * A screen: an id and its rows.
 * @typedef {{id:string, items:ReadonlyArray<MenuItem>}} Screen
 */

/** Title screen. */
const TITLE_ITEMS = /** @type {ReadonlyArray<MenuItem>} */ ([
  { id: 'descend', label: 'Descend', kind: 'action' },
  { id: 'options', label: 'Options', kind: 'action' },
  { id: 'credits', label: 'Credits', kind: 'action' },
]);

/** Pause screen. */
const PAUSE_ITEMS = /** @type {ReadonlyArray<MenuItem>} */ ([
  { id: 'resume', label: 'Resume', kind: 'action' },
  { id: 'options', label: 'Options', kind: 'action' },
  { id: 'quit', label: 'Quit to Title', kind: 'action' },
]);

/**
 * Options screen. The ranges mirror `SETTING_SPEC` in `src/state/balance.js` (see the file
 * header); `onSetting` values outside them would simply be clamped by the reducer, so a drift
 * here degrades to a short slider, never to an illegal setting.
 */
const OPTION_ITEMS = /** @type {ReadonlyArray<MenuItem>} */ ([
  { id: 'volume', label: 'Sound', kind: 'slider', key: 'volume', min: 0, max: 1, step: 0.1, format: 'percent' },
  { id: 'music', label: 'Music', kind: 'slider', key: 'music', min: 0, max: 1, step: 0.1, format: 'percent' },
  { id: 'sensitivity', label: 'Look Speed', kind: 'slider', key: 'sensitivity', min: 0.2, max: 3, step: 0.1, format: 'mult' },
  { id: 'scanlines', label: 'Scanlines', kind: 'toggle', key: 'scanlines' },
  {
    // The map is three states now (off → corner → full), so it cannot be a switch any more.
    // `write` shadows both the new `mapMode` string and the legacy `minimap` boolean, which is
    // what lets the cycle work whichever of the two `src/state` actually stores.
    id: 'map',
    label: 'Map',
    kind: 'choice',
    key: 'minimap',
    values: MAP_MODES,
    labelOf: (v) => /** @type {any} */ (MAP_MODE_LABEL)[v] || v,
    read: (state) => readMapMode(state.settings),
    write: (v, set) => {
      setMapMode(v);
      set('mapMode', v);
      set('minimap', v !== 'off');
    },
  },
  { id: 'reducedMotion', label: 'Reduced Motion', kind: 'toggle', key: 'reducedMotion' },
  { id: 'invertLook', label: 'Invert Look', kind: 'toggle', key: 'invertLook' },
  { id: 'back', label: 'Back', kind: 'back' },
]);

/** Credits screen — one row out. */
const CREDITS_ITEMS = /** @type {ReadonlyArray<MenuItem>} */ ([
  { id: 'back', label: 'Back', kind: 'back' },
]);

/** Level-complete screen. */
const COMPLETE_ITEMS = /** @type {ReadonlyArray<MenuItem>} */ ([
  { id: 'next', label: 'Descend', kind: 'action' },
  { id: 'quit', label: 'Quit to Title', kind: 'action' },
]);

/** Game-over screen. */
const GAMEOVER_ITEMS = /** @type {ReadonlyArray<MenuItem>} */ ([
  { id: 'retry', label: 'Try Again', kind: 'action' },
  { id: 'quit', label: 'Title', kind: 'action' },
]);

/** Loading screen — nothing to select. */
const NO_ITEMS = /** @type {ReadonlyArray<MenuItem>} */ ([]);

/** Every screen by id. */
const SCREENS = Object.freeze({
  title: Object.freeze({ id: 'title', items: TITLE_ITEMS }),
  pause: Object.freeze({ id: 'pause', items: PAUSE_ITEMS }),
  options: Object.freeze({ id: 'options', items: OPTION_ITEMS }),
  credits: Object.freeze({ id: 'credits', items: CREDITS_ITEMS }),
  complete: Object.freeze({ id: 'complete', items: COMPLETE_ITEMS }),
  gameover: Object.freeze({ id: 'gameover', items: GAMEOVER_ITEMS }),
  loading: Object.freeze({ id: 'loading', items: NO_ITEMS }),
  none: Object.freeze({ id: 'none', items: NO_ITEMS }),
});

/** Credits copy. Lines are wrapped to the panel width at draw time. */
const CREDITS_LINES = Object.freeze([
  'A-MAZE',
  '',
  'Design, code and pixel art',
  'SeveralHerr',
  '',
  'Engine, maze generator, bitmap fonts',
  'and every sound: hand-rolled,',
  'no dependencies, no build step.',
  '',
  'Built with Claude Code.',
  '',
  'Thank you for descending.',
]);

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────────────────────

/**
 * Move a menu selection.
 *
 * Wraps at both ends and skips disabled rows. If nothing is selectable the index is returned
 * unchanged, so a screen whose rows are all disabled cannot hang the caller in a loop.
 *
 * @param {ReadonlyArray<boolean>} enabled one flag per row
 * @param {number} index current selection (any integer; out-of-range is treated as "before the
 *   start" when moving forward and "after the end" when moving back)
 * @param {number} dir +1 down, −1 up (any positive/negative number works)
 * @param {number} [count] how many entries of `enabled` are valid (default: all of them) — lets a
 *   caller pass a reused, over-long buffer instead of allocating a slice per keypress
 * @returns {number} the new index, or `index` when no row is selectable
 */
export function menuStep(enabled, index, dir, count) {
  const n = count === undefined ? enabled.length : Math.max(0, Math.min(count, enabled.length));
  if (n === 0) return index;
  const step = dir >= 0 ? 1 : -1;
  let i = index;
  if (!(i >= 0) || i >= n) i = step > 0 ? -1 : n;
  for (let k = 0; k < n; k++) {
    i = (((i + step) % n) + n) % n;
    if (enabled[i]) return i;
  }
  return index;
}

/**
 * Index of the first rectangle containing (x, y), or −1.
 *
 * Rectangles are stored flat — `[x, y, w, h, x, y, w, h, …]` — so the layout pass can fill a
 * preallocated typed array without allocating an object per row.
 *
 * Edges are half-open (`x ≤ px < x + w`), so two rows that share an edge cannot both claim a
 * pointer.
 *
 * @param {Float64Array} rects flat rectangles
 * @param {number} count how many rectangles are valid
 * @param {number} x
 * @param {number} y
 * @returns {number} rectangle index, or −1
 */
export function hitTest(rects, count, x, y) {
  // A NaN coordinate would pass every `<` and `>=` test below and "hit" the first rectangle.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const rx = rects[o];
    const ry = rects[o + 1];
    if (x < rx || y < ry) continue;
    if (x >= rx + rects[o + 2] || y >= ry + rects[o + 3]) continue;
    return i;
  }
  return -1;
}

/**
 * Value of a slider whose track spans `[trackX, trackX + trackW)` when the pointer is at `x`.
 *
 * Quantised to `step` so dragging produces the same values as the arrow keys; clamped to the
 * slider's range, so a drag that leaves the track pins to an end instead of going out of range.
 *
 * @param {number} x pointer x in UI pixels
 * @param {number} trackX track left edge
 * @param {number} trackW track width (values ≤ 0 return `min`)
 * @param {number} min
 * @param {number} max
 * @param {number} step quantisation; ≤ 0 means continuous
 * @returns {number}
 */
export function sliderValueAt(x, trackX, trackW, min, max, step) {
  if (!(trackW > 0)) return min;
  const t = clamp01((x - trackX) / trackW);
  let v = min + (max - min) * t;
  if (step > 0) v = Math.round(v / step) * step;
  // Rounding at the extremes can leave 0.30000000000000004; snap to a sane number of decimals.
  v = Math.round(v * 1000) / 1000;
  return clamp(v, min, max);
}

// ─── Loading art ─────────────────────────────────────────────────────────────────────────────

/** A chisel/pick, for the loading screen. 1 dark iron, 2 iron, 3 hilite, 4 wood. */
const PICK_ART = compileArt(
  [
    '.......33',
    '......332',
    '.....3321',
    '....33211',
    '...44211.',
    '..4441...',
    '.444.....',
    '444......',
    '44.......',
  ],
  'pick',
);

/** Pick palette. */
const PICK_PALETTE = Object.freeze([
  null,
  COLOR.ironShadow,
  COLOR.ironBase,
  COLOR.ironHilite,
  COLOR.woodBase,
]);

// ─── The menus ───────────────────────────────────────────────────────────────────────────────

/**
 * Callbacks into the composition root. Every one is optional; a missing callback makes the
 * corresponding row inert rather than throwing.
 * @typedef {Object} MenuCallbacks
 * @property {() => void} [onNewGame]    start a run (title "Descend", game-over "Try Again")
 * @property {() => void} [onResume]     leave the pause screen
 * @property {() => void} [onQuit]       abandon the run and return to the title
 * @property {(key:keyof Settings, value:number|boolean) => void} [onSetting]
 * @property {() => void} [onNextLevel]  descend after a level-complete tally
 * @property {(type:'uiMove'|'uiConfirm'|'uiBack'|'uiDeny') => void} [onUiSound]
 */

/**
 * The menus.
 * @typedef {Object} Menus
 * @property {(state:GameState) => void} render
 * @property {(frame:InputFrame|null|undefined, state:GameState) => boolean} handleInput
 *   returns true when the frame was consumed by a menu
 * @property {(ev:{type:string, clientX?:number, clientY?:number}) => boolean} handlePointer
 *   returns true when the event was consumed
 * @property {(cssW:number, cssH:number, dpr?:number) => void} resize
 * @property {Surface} surface
 * @property {() => string} screen  the id of the screen currently showing
 * @property {() => void} dispose
 */

/**
 * Create the menu layer.
 *
 * @param {HTMLCanvasElement|null} overlayCanvas the overlay canvas (shared with the HUD)
 * @param {MenuCallbacks} [callbacks]
 * @returns {Menus}
 */
export function createMenus(overlayCanvas, callbacks) {
  const surface = createSurface(overlayCanvas);
  const cb = callbacks === undefined || callbacks === null ? {} : callbacks;

  /** Sub-screen open over the title or pause screen, or null. @type {string|null} */
  let sub = null;
  /** Selected row on the current screen. */
  let index = 0;
  /** Selected row remembered per screen id, so leaving Options returns you where you were. */
  /** @type {Record<string, number>} */
  const savedIndex = Object.create(null);
  /** Phase seen on the previous render, to detect transitions. */
  let lastPhase = '';
  /** Screen id seen on the previous render. */
  let lastScreen = '';
  /** Seconds since the current screen appeared. */
  let enterT = 0;
  /** Animation clock, advanced from `state.time`. */
  let clock = 0;
  let lastTime = -1;

  // ── Tally state (level complete) ──
  const tallyCounters = [createCounter(0), createCounter(0), createCounter(0), createCounter(0)];
  /** Seconds since the tally started; −1 while no tally is running. */
  let tallyT = -1;
  /** True once the player has skipped/finished the tally animation. */
  let tallyDone = false;

  // ── Layout scratch (no per-frame allocation) ──
  /** Flat row rectangles from the last layout pass: [x,y,w,h] per row. */
  const rowRects = new Float64Array(4 * 16);
  /** Flat slider-track rectangles, parallel to `rowRects`. */
  const trackRects = new Float64Array(4 * 16);
  /** Number of rows laid out last frame. */
  let rowCount = 0;
  /** Enabled flags for the rows laid out last frame. @type {boolean[]} */
  const rowEnabled = new Array(16).fill(true);
  /** Pointer mapping scratch. */
  const ptr = new Float64Array(2);
  /** Row the pointer went down on, for click-release matching. */
  let pressedRow = -1;
  /** Row whose slider is being dragged, or −1. */
  let dragRow = -1;

  /**
   * Which screen should be showing for this state.
   * @param {GameState} state
   * @returns {Screen}
   */
  function screenFor(state) {
    switch (state.phase) {
      case 'title':
        return sub === 'options' ? SCREENS.options : sub === 'credits' ? SCREENS.credits : SCREENS.title;
      case 'paused':
        return sub === 'options' ? SCREENS.options : SCREENS.pause;
      case 'loading':
        return SCREENS.loading;
      case 'levelComplete':
        return SCREENS.complete;
      case 'gameOver':
        return SCREENS.gameover;
      default:
        return SCREENS.none;
    }
  }

  /**
   * Is a row selectable?
   * @param {MenuItem} item
   * @param {GameState} state
   * @returns {boolean}
   */
  function itemEnabled(item, state) {
    return item.enabled === undefined ? true : item.enabled(state) === true;
  }

  /**
   * Fill `rowEnabled` for a screen and return its length.
   * @param {Screen} screen
   * @param {GameState} state
   * @returns {number}
   */
  function syncEnabled(screen, state) {
    const items = screen.items;
    for (let i = 0; i < items.length && i < rowEnabled.length; i++) {
      rowEnabled[i] = itemEnabled(items[i], state);
    }
    return Math.min(items.length, rowEnabled.length);
  }

  /**
   * Emit a UI sound, tolerating a missing callback.
   * @param {'uiMove'|'uiConfirm'|'uiBack'|'uiDeny'} type
   * @returns {void}
   */
  function sound(type) {
    if (typeof cb.onUiSound === 'function') {
      try {
        cb.onUiSound(type);
      } catch (err) {
        log.error('onUiSound threw', err);
      }
    }
  }

  /**
   * Call a callback, tolerating a missing one and containing a throwing one: a menu must never be
   * able to break the frame loop.
   * @param {Function|undefined} fn
   * @param {string} name
   * @param {unknown} [a]
   * @param {unknown} [b]
   * @returns {boolean} true when a callback actually ran
   */
  function invoke(fn, name, a, b) {
    if (typeof fn !== 'function') return false;
    try {
      fn(a, b);
      return true;
    } catch (err) {
      log.error(`${name} threw`, err);
      return true;
    }
  }

  /**
   * Open a sub-screen (options/credits) and remember where we were.
   * @param {string} id
   * @returns {void}
   */
  function openSub(id) {
    savedIndex[currentScreenId] = index;
    sub = id;
    index = savedIndex[id] !== undefined ? savedIndex[id] : 0;
  }

  /**
   * Close the current sub-screen.
   * @returns {void}
   */
  function closeSub() {
    if (sub === null) return;
    savedIndex[sub] = index;
    sub = null;
    index = savedIndex[currentBaseId] !== undefined ? savedIndex[currentBaseId] : 0;
  }

  /** Id of the screen drawn last frame (used by openSub/closeSub for the index memory). */
  let currentScreenId = 'title';
  /** Id of the base screen (title or pause) under any open sub-screen. */
  let currentBaseId = 'title';

  /**
   * Run a row's action.
   * @param {Screen} screen
   * @param {number} row
   * @param {GameState} state
   * @returns {boolean} true when something happened
   */
  function activate(screen, row, state) {
    const item = screen.items[row];
    if (item === undefined || !itemEnabled(item, state)) {
      sound('uiDeny');
      return false;
    }
    switch (item.kind) {
      case 'toggle': {
        const key = /** @type {keyof Settings} */ (item.key);
        const next = state.settings[key] !== true;
        sound('uiConfirm');
        invoke(cb.onSetting, 'onSetting', key, next);
        return true;
      }
      case 'choice':
        // Confirm steps the cycle forward, exactly like the `map` hotkey does in-game.
        stepChoice(item, state, 1, true);
        return true;
      case 'slider':
        // Confirm on a slider nudges it up and wraps at the top, which is the only way to change
        // it on a device with no left/right (a d-pad-less gamepad, a single-button remote).
        adjust(screen, row, 1, state, true);
        return true;
      case 'back':
        sound('uiBack');
        closeSub();
        return true;
      default:
        break;
    }

    switch (item.id) {
      case 'descend':
      case 'retry':
        sound('uiConfirm');
        invoke(cb.onNewGame, 'onNewGame');
        return true;
      case 'options':
        sound('uiConfirm');
        openSub('options');
        return true;
      case 'credits':
        sound('uiConfirm');
        openSub('credits');
        return true;
      case 'resume':
        sound('uiConfirm');
        invoke(cb.onResume, 'onResume');
        return true;
      case 'quit':
        sound('uiConfirm');
        invoke(cb.onQuit, 'onQuit');
        return true;
      case 'next':
        sound('uiConfirm');
        invoke(cb.onNextLevel, 'onNextLevel');
        return true;
      default:
        sound('uiDeny');
        return false;
    }
  }

  /**
   * Nudge a slider or flip a toggle with left/right.
   * @param {Screen} screen
   * @param {number} row
   * @param {number} dir −1 or +1
   * @param {GameState} state
   * @param {boolean} [wrap] wrap past the maximum back to the minimum (used by `confirm`)
   * @returns {boolean} true when a setting changed
   */
  function adjust(screen, row, dir, state, wrap) {
    const item = screen.items[row];
    if (item === undefined || !itemEnabled(item, state)) return false;
    if (item.kind === 'choice') return stepChoice(item, state, dir, wrap === true);
    if (item.kind === 'toggle') {
      const key = /** @type {keyof Settings} */ (item.key);
      const next = dir > 0;
      if (state.settings[key] === next) return false;
      sound('uiMove');
      invoke(cb.onSetting, 'onSetting', key, next);
      return true;
    }
    if (item.kind !== 'slider') return false;
    const key = /** @type {keyof Settings} */ (item.key);
    const min = item.min === undefined ? 0 : item.min;
    const max = item.max === undefined ? 1 : item.max;
    const step = item.step === undefined ? 0.1 : item.step;
    const cur = typeof state.settings[key] === 'number' ? Number(state.settings[key]) : min;
    let next = cur + step * dir;
    if (wrap === true && next > max + 1e-6) next = min;
    next = clamp(Math.round(next * 1000) / 1000, min, max);
    if (Math.abs(next - cur) < 1e-6) {
      sound('uiDeny');
      return false;
    }
    sound('uiMove');
    invoke(cb.onSetting, 'onSetting', key, next);
    return true;
  }

  /**
   * Step a `choice` row by `dir`, wrapping at both ends.
   *
   * Left/right at the ends wrap too: a three-state cycle read out of a list of words has no
   * meaningful "end", and a dead key on a three-item cycle just reads as broken.
   * @param {MenuItem} item
   * @param {GameState} state
   * @param {number} dir −1 or +1
   * @param {boolean} confirm true when this came from `confirm` (a different sound)
   * @returns {boolean} true when the value changed
   */
  function stepChoice(item, state, dir, confirm) {
    const values = item.values;
    const read = item.read;
    const write = item.write;
    if (values === undefined || values.length === 0 || read === undefined || write === undefined) {
      sound('uiDeny');
      return false;
    }
    let current = 0;
    try {
      const v = read(state);
      const at = values.indexOf(v);
      current = at < 0 ? 0 : at;
    } catch (err) {
      log.error('choice read failed', err);
    }
    const step = dir < 0 ? -1 : 1;
    const next = values[(current + step + values.length) % values.length];
    sound(confirm ? 'uiConfirm' : 'uiMove');
    try {
      write(next, (key, value) => invoke(cb.onSetting, 'onSetting', key, value));
    } catch (err) {
      log.error('choice write failed', err);
      return false;
    }
    return true;
  }

  /**
   * @param {InputFrame|null|undefined} frame
   * @param {InputAction} action
   * @returns {boolean}
   */
  function pressed(frame, action) {
    if (frame === null || frame === undefined) return false;
    const set = frame.pressed;
    if (set === null || set === undefined || typeof set.has !== 'function') return false;
    return set.has(action) === true;
  }

  /**
   * Keyboard/gamepad navigation.
   * @param {InputFrame|null|undefined} frame
   * @param {GameState} state
   * @returns {boolean} true when the menus consumed the frame
   */
  function handleInput(frame, state) {
    if (state === null || typeof state !== 'object') return false;
    const screen = screenFor(state);
    if (screen.id === 'none') return false;
    // Nothing is selectable while a level is being carved; the frame belongs to whoever else wants
    // it (the composition root still gets its pause/mute hotkeys).
    if (screen.id === 'loading') return false;

    const count = syncEnabled(screen, state);
    let consumed = false;

    if (pressed(frame, 'up') || pressed(frame, 'down')) {
      const next = menuStep(rowEnabled, index, pressed(frame, 'down') ? 1 : -1, count);
      if (next !== index) {
        index = next;
        sound('uiMove');
      }
      consumed = true;
    }
    if (pressed(frame, 'left')) {
      adjust(screen, index, -1, state);
      consumed = true;
    }
    if (pressed(frame, 'right')) {
      adjust(screen, index, 1, state);
      consumed = true;
    }
    if (pressed(frame, 'confirm')) {
      if (screen.id === 'complete' && !tallyDone) {
        // First confirm finishes the tally instantly; the second one descends. Nobody should have
        // to watch an animation twice.
        finishTally(state);
        sound('uiConfirm');
      } else {
        activate(screen, index, state);
      }
      consumed = true;
    }
    if (pressed(frame, 'back') || pressed(frame, 'pause')) {
      if (sub !== null) {
        sound('uiBack');
        closeSub();
      } else if (screen.id === 'pause') {
        sound('uiBack');
        invoke(cb.onResume, 'onResume');
      } else if (screen.id === 'gameover' || screen.id === 'complete') {
        // `back` on an end screen is "leave", not "resume" — the run is already over.
        sound('uiBack');
        invoke(cb.onQuit, 'onQuit');
      }
      consumed = true;
    }
    return consumed;
  }

  /**
   * Pointer (mouse / touch / pen) interaction against the layout recorded by the last `render`.
   * @param {{type:string, clientX?:number, clientY?:number}} ev
   * @returns {boolean} true when the event was consumed
   */
  function handlePointer(ev) {
    if (ev === null || typeof ev !== 'object') return false;
    const type = ev.type;
    if (type === 'pointerleave' || type === 'pointercancel' || type === 'mouseleave') {
      pressedRow = -1;
      dragRow = -1;
      return false;
    }
    if (rowCount === 0) return false;
    const x = ev.clientX;
    const y = ev.clientY;
    if (typeof x !== 'number' || typeof y !== 'number') return false;
    if (!surface.fromClient(x, y, ptr)) {
      // Outside the UI area entirely (letterbox margin): drop any in-flight press.
      if (type === 'pointerup' || type === 'mouseup') {
        pressedRow = -1;
        dragRow = -1;
      }
      return false;
    }

    const state = lastState;
    if (state === null) return false;
    const screen = screenFor(state);
    if (screen.id === 'none' || screen.id === 'loading') return false;

    // A slider drag owns the pointer until it is released, even outside the track.
    if (dragRow >= 0 && (type === 'pointermove' || type === 'mousemove')) {
      applySliderDrag(screen, dragRow, state);
      return true;
    }

    const row = hitTest(rowRects, rowCount, ptr[0], ptr[1]);

    switch (type) {
      case 'pointermove':
      case 'mousemove':
        if (row >= 0 && row !== index && rowEnabled[row]) {
          index = row;
          sound('uiMove');
        }
        return row >= 0;
      case 'pointerdown':
      case 'mousedown':
        if (row < 0 || !rowEnabled[row]) return false;
        index = row;
        pressedRow = row;
        if (screen.items[row].kind === 'slider') {
          dragRow = row;
          applySliderDrag(screen, row, state);
        }
        return true;
      case 'pointerup':
      case 'mouseup':
      case 'click': {
        const wasDrag = dragRow >= 0;
        dragRow = -1;
        if (wasDrag) {
          pressedRow = -1;
          return true;
        }
        const armed = pressedRow;
        pressedRow = -1;
        if (row < 0 || row !== armed) return false;
        if (screen.id === 'complete' && !tallyDone) {
          finishTally(state);
          sound('uiConfirm');
          return true;
        }
        activate(screen, row, state);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Apply the current pointer position to a slider row.
   * @param {Screen} screen
   * @param {number} row
   * @param {GameState} state
   * @returns {void}
   */
  function applySliderDrag(screen, row, state) {
    const item = screen.items[row];
    if (item === undefined || item.kind !== 'slider') return;
    const o = row * 4;
    const key = /** @type {keyof Settings} */ (item.key);
    const min = item.min === undefined ? 0 : item.min;
    const max = item.max === undefined ? 1 : item.max;
    const step = item.step === undefined ? 0.1 : item.step;
    const value = sliderValueAt(ptr[0], trackRects[o], trackRects[o + 2], min, max, step);
    const cur = typeof state.settings[key] === 'number' ? Number(state.settings[key]) : min;
    if (Math.abs(value - cur) < 1e-6) return;
    sound('uiMove');
    invoke(cb.onSetting, 'onSetting', key, value);
  }

  /** The state passed to the last `render`, so pointer events can be resolved between frames. */
  /** @type {GameState|null} */
  let lastState = null;

  /**
   * @param {number} cssW
   * @param {number} cssH
   * @param {number} [dpr]
   * @returns {void}
   */
  function resize(cssW, cssH, dpr) {
    surface.resize(cssW, cssH, dpr);
  }

  /**
   * Snap every tally counter to its final value.
   * @param {GameState} state
   * @returns {void}
   */
  function finishTally(state) {
    const level = state.level;
    const run = state.run;
    tallyCounters[0].snap(run.gems * SCORE_RULES.GEM_BASE * level);
    tallyCounters[1].snap(fuelBonusOf(state));
    tallyCounters[2].snap(SCORE_RULES.CLEAR_BASE * level);
    tallyCounters[3].snap(run.score);
    tallyT = TALLY_DELAY + TALLY_STAGGER * TALLY_ROWS + 1;
    tallyDone = true;
  }

  /**
   * The fuel half of the level bonus.
   *
   * `run.levelScore` is what the sim actually awarded (`levelBonus()` in `balance.js`), so the
   * fuel component is taken as the remainder after the flat depth bonus: the two rows then always
   * add up to the number that was really added to the score, even if the depth constant mirrored
   * here ever drifts.
   * @param {GameState} state
   * @returns {number}
   */
  function fuelBonusOf(state) {
    const depth = SCORE_RULES.CLEAR_BASE * state.level;
    const rest = state.run.levelScore - depth;
    if (rest >= 0) return rest;
    // Fall back to the published formula if `levelScore` is not what we expect.
    return Math.floor(Math.max(0, state.run.fuel)) * SCORE_RULES.FUEL_UNIT * state.level;
  }

  /**
   * Advance the animation clock and per-screen timers.
   * @param {GameState} state
   * @param {Screen} screen
   * @returns {number} the frame delta in seconds
   */
  function advance(state, screen) {
    const now = state.time;
    let dt = lastTime < 0 ? 0 : now - lastTime;
    if (!(dt >= 0) || dt > MAX_FRAME_DT) dt = dt > MAX_FRAME_DT ? MAX_FRAME_DT : 0;
    lastTime = now;
    clock += dt;

    if (state.phase !== lastPhase) {
      // Every phase change closes any sub-screen: arriving at "game over" with the options panel
      // still open would be a dead end. The very first frame is not a transition — a harness (or
      // a deep link) may legitimately have opened a sub-screen before anything was rendered.
      if (lastPhase !== '') {
        sub = null;
        pressedRow = -1;
        dragRow = -1;
      }
      lastPhase = state.phase;
    }
    if (screen.id !== lastScreen) {
      lastScreen = screen.id;
      enterT = 0;
      index = savedIndex[screen.id] !== undefined ? savedIndex[screen.id] : 0;
      const count = syncEnabled(screen, state);
      if (count > 0 && !rowEnabled[index]) index = menuStep(rowEnabled, -1, 1, count);
      if (screen.id === 'complete') {
        tallyT = 0;
        tallyDone = false;
        for (let i = 0; i < tallyCounters.length; i++) tallyCounters[i].snap(0);
      } else {
        tallyT = -1;
      }
    }
    enterT += dt;
    if (tallyT >= 0) {
      tallyT += dt;
      for (let i = 0; i < tallyCounters.length; i++) tallyCounters[i].update(dt);
    }
    return dt;
  }

  /**
   * Draw the current screen.
   * @param {GameState} state
   * @returns {void}
   */
  function render(state) {
    if (state === null || typeof state !== 'object') return;
    lastState = state;
    const screen = screenFor(state);
    currentScreenId = screen.id;
    currentBaseId = state.phase === 'paused' ? 'pause' : 'title';
    advance(state, screen);

    const ctx = surface.beginFrameIfClosed();
    if (ctx === null) {
      rowCount = 0;
      return;
    }
    const m = surface.metrics;
    if (screen.id === 'none' || m.w < 32 || m.h < 32) {
      rowCount = 0;
      surface.endFrame();
      return;
    }

    const reduced = state.settings !== undefined && state.settings.reducedMotion === true;
    const enter = reduced ? 1 : clamp01(enterT / ENTER_TIME);
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * (0.15 + 0.85 * enter);

    rowCount = 0;
    switch (screen.id) {
      case 'title':
        drawTitle(ctx, m, state, screen, enter, reduced);
        break;
      case 'pause':
        drawPause(ctx, m, state, screen, enter, reduced);
        break;
      case 'options':
        drawOptions(ctx, m, state, screen, enter, reduced);
        break;
      case 'credits':
        drawCredits(ctx, m, state, screen, enter, reduced);
        break;
      case 'loading':
        drawLoading(ctx, m, state, reduced);
        break;
      case 'complete':
        drawComplete(ctx, m, state, screen, enter, reduced);
        break;
      case 'gameover':
        drawGameOver(ctx, m, state, screen, enter, reduced);
        break;
      default:
        break;
    }

    ctx.globalAlpha = prevAlpha;
    surface.endFrame();
  }

  // ── Shared drawing ──

  /**
   * Dim everything behind the menu.
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {number} strength 0..1
   * @returns {void}
   */
  function drawScrim(ctx, m, strength) {
    ctx.fillStyle = withAlpha(COLOR.void, clamp01(strength));
    ctx.fillRect(0, 0, m.w, m.h);
  }

  /**
   * Cap on the text scale of a menu row, derived from the surface height so a list of items is
   * the same fraction of the screen on a phone and on a 1440p monitor. `fitScale` then reduces it
   * further if the longest label does not fit the column.
   * @param {SurfaceMetrics} m
   * @param {number} per UI pixels of height one design step is worth
   * @returns {number}
   */
  function scaleCap(m, per) {
    return clamp(Math.round(m.h / per), 2, 8);
  }

  /**
   * How far a panel still has to rise into place, in UI pixels. Panels come up a few pixels as
   * their screen appears; reduced motion pins them where they belong from the first frame.
   * @param {number} enter 0..1 entry progress
   * @param {number} u layout unit
   * @param {boolean} reduced
   * @returns {number}
   */
  function panelSlide(enter, u, reduced) {
    return reduced ? 0 : Math.round((1 - enter) * 5 * u);
  }

  /** Cached title-column gradient; rebuilt only when the surface size changes. */
  /** @type {CanvasGradient|null} */
  let columnGradient = null;
  let columnKey = '';

  /**
   * The soft vertical band of shade the title lettering sits on. A gradient rather than a
   * rectangle so the attract-mode dungeon fades out behind the type instead of being cut by a
   * visible seam. The `CanvasGradient` is cached because building one per frame would allocate.
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {number} halfW half the band's width in UI pixels
   * @returns {void}
   */
  function drawColumnShade(ctx, m, halfW) {
    const cx = Math.round(m.w / 2);
    const key = `${m.w}x${m.h}x${halfW}`;
    if (columnGradient === null || columnKey !== key) {
      const g = ctx.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
      g.addColorStop(0, withAlpha(COLOR.void, 0));
      g.addColorStop(0.22, withAlpha(COLOR.void, 0.55));
      g.addColorStop(0.78, withAlpha(COLOR.void, 0.55));
      g.addColorStop(1, withAlpha(COLOR.void, 0));
      columnGradient = g;
      columnKey = key;
    }
    ctx.fillStyle = columnGradient;
    ctx.fillRect(cx - halfW, 0, halfW * 2, m.h);
  }

  /**
   * A horizontal rule with a diamond in the middle — the divider under every heading.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx centre x
   * @param {number} y
   * @param {number} halfW half the rule's width
   * @param {number} u
   * @returns {void}
   */
  function drawRule(ctx, cx, y, halfW, u) {
    const yy = Math.round(y);
    ctx.fillStyle = COLOR.goldMid;
    ctx.fillRect(Math.round(cx - halfW), yy, Math.round(halfW * 2), u);
    ctx.fillStyle = COLOR.goldLight;
    for (let i = 0; i < 3; i++) {
      const s = (3 - i) * u;
      ctx.fillRect(Math.round(cx - s / 2), yy - Math.round(s / 2) + Math.round(u / 2), s, s);
    }
    ctx.fillStyle = COLOR.goldPale;
    ctx.fillRect(Math.round(cx - u / 2), yy, u, u);
  }

  /**
   * Lay out and draw a vertical list of rows, recording their hit rectangles.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {GameState} state
   * @param {Screen} screen
   * @param {number} top first row's top edge
   * @param {number} scale text scale for the row labels
   * @param {number} rowH row pitch in UI px
   * @param {boolean} reduced
   * @returns {number} y below the last row
   */
  function drawItemList(ctx, m, state, screen, top, scale, rowH, reduced) {
    const items = screen.items;
    const u = m.u;
    const cx = Math.round(m.w / 2);
    const count = syncEnabled(screen, state);
    let y = top;
    for (let i = 0; i < count; i++) {
      const item = items[i];
      const selected = i === index;
      const enabled = rowEnabled[i];
      const label = item.label;
      const style = !enabled ? 'gothicOff' : selected ? 'gothicHot' : 'gothic';
      const w = measureLine(label, { font: 'display', size: scale });
      // A selected row breathes very slightly — one pixel of lift, no more; a jumping menu is a
      // toy, a menu that leans toward you is a game.
      const lift = selected && !reduced ? Math.round(Math.sin(clock * 3.4) * u * 0.5) : 0;
      drawText(ctx, label, cx, y + lift, {
        font: 'display',
        size: scale,
        color: style,
        align: 'center',
      });

      if (selected) {
        const fs = Math.max(1, Math.round(scale * 0.8));
        const fw = ICON_SIZE.flameW * fs;
        const frame = reduced ? 0 : ((clock * 11) | 0) % 3;
        drawFlame(ctx, cx - Math.round(w / 2) - fw - 2 * u, y + lift - fs, fs, frame);
        drawFlame(ctx, cx + Math.round(w / 2) + 2 * u, y + lift - fs, fs, frame + 1);
      }

      const rowW = Math.max(w + 16 * u, m.w * 0.5);
      recordRow(i, cx - rowW / 2, y - u, rowW, rowH);
      y += rowH;
    }
    rowCount = count;
    return y;
  }

  /**
   * Record one row's hit rectangle.
   * @param {number} i row index
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @returns {void}
   */
  function recordRow(i, x, y, w, h) {
    if (i < 0 || i * 4 + 3 >= rowRects.length) return;
    const o = i * 4;
    rowRects[o] = x;
    rowRects[o + 1] = y;
    rowRects[o + 2] = w;
    rowRects[o + 3] = h;
    // Sliders overwrite this with their track; other rows get an empty track.
    trackRects[o] = 0;
    trackRects[o + 1] = 0;
    trackRects[o + 2] = 0;
    trackRects[o + 3] = 0;
  }

  /**
   * A blinking prompt line ("PRESS ENTER…").
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {string} text
   * @param {number} y
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawPrompt(ctx, m, text, y, reduced) {
    const alpha = reduced ? 1 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(clock * 3.6));
    drawText(ctx, text, Math.round(m.w / 2), Math.round(y), {
      font: 'hud',
      size: fitScale(text, m.w - 8 * m.u, { font: 'hud' }, m.u),
      color: 'hudDim',
      align: 'center',
      alpha,
    });
  }

  /**
   * Draw a label/value pair across a panel, at the largest size at which both columns fit.
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} label
   * @param {string} value
   * @param {number} left
   * @param {number} right
   * @param {number} y
   * @param {number} size text scale
   * @param {string} labelColor a `FONT_STYLES` name
   * @param {string} valueColor a `FONT_STYLES` name
   * @param {number} [alpha]
   * @returns {void}
   */
  function drawRow(ctx, label, value, left, right, y, size, labelColor, valueColor, alpha) {
    drawText(ctx, label, left, y, { font: 'hud', size, color: labelColor, alpha });
    drawText(ctx, value, right, y, { font: 'hud', size, color: valueColor, align: 'right', alpha });
  }

  /**
   * The largest scale at which every `label + gap + value` pair fits the column.
   * @param {ReadonlyArray<string>} labels
   * @param {ReadonlyArray<string>} values
   * @param {number} width available UI pixels
   * @param {number} maxScale
   * @returns {number}
   */
  function fitRowScale(labels, values, width, maxScale) {
    let scale = maxScale;
    for (let i = 0; i < labels.length; i++) {
      const unit =
        measureLine(labels[i], { font: 'hud', size: 1 }) +
        measureLine(values[i], { font: 'hud', size: 1 }) +
        6;
      if (unit <= 0) continue;
      const fits = Math.floor(width / unit);
      if (fits < scale) scale = fits;
    }
    return Math.max(1, scale);
  }

  // ── Title ──

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {GameState} state
   * @param {Screen} screen
   * @param {number} enter
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawTitle(ctx, m, state, screen, enter, reduced) {
    const u = m.u;
    const cx = Math.round(m.w / 2);

    // A soft column of shade behind the lettering, so the attract-mode dungeon stays visible at
    // the edges but never fights the type.
    const colW = Math.min(m.w, Math.max(m.w * 0.62, 120 * u));
    drawScrim(ctx, m, 0.3);
    drawColumnShade(ctx, m, Math.round(colW / 2));

    // The logo is a fixed fraction of the width at every resolution — the one element that should
    // look identical on a phone and on a 1440p monitor.
    const logoScale = fitScale('A-MAZE', m.w * 0.62, { font: 'display' }, 10, 2);
    const subScale = fitScale(
      'The Torchlit Descent',
      m.w * 0.88,
      { font: 'display' },
      Math.max(1, Math.round(logoScale / 3)),
    );
    const slide = reduced ? 0 : Math.round((1 - enter) * 6 * u);

    const logoY = Math.round(m.h * 0.11) - slide;
    drawText(ctx, 'A-MAZE', cx, logoY, {
      font: 'display',
      size: logoScale,
      color: 'gothic',
      align: 'center',
      tracking: 1,
    });
    const logoH = textHeight({ font: 'display', size: logoScale });
    drawText(ctx, 'The Torchlit Descent', cx, logoY + logoH + u, {
      font: 'display',
      size: subScale,
      color: 'gothicDim',
      align: 'center',
    });
    const subH = textHeight({ font: 'display', size: subScale });
    const ruleY = logoY + logoH + subH + 4 * u;
    drawRule(ctx, cx, ruleY, Math.round(colW * 0.34), u);

    // The list sits at a comfortable 46 % of the height, but never crowds the rule above it or
    // the best-score and footer lines below: on a very short window it is the list that gives way.
    const listTop = Math.max(Math.round(m.h * 0.46), ruleY + 9 * u);
    const rows = screen.items.length;
    const availH = m.h - listTop - 26 * u;
    const heightCap = Math.max(1, Math.floor((availH / Math.max(1, rows) - 6 * u) / 12));
    const itemScale = fitScale(
      'Descend',
      colW * 0.7,
      { font: 'display' },
      Math.min(scaleCap(m, 110), heightCap),
      1,
    );
    const rowH = textHeight({ font: 'display', size: itemScale }) + 6 * u;
    drawItemList(ctx, m, state, screen, listTop, itemScale, rowH, reduced);

    // Footer: version left, copyright right — at whatever size lets both sit on one line with a
    // gap, which on a phone is one font pixel per UI pixel.
    const version = 'v0.1';
    const copyright = '© 2026 SeveralHerr';
    const footScale = fitRowScale([version], [copyright], m.w - 8 * u, u);
    const footH = textHeight({ font: 'hud', size: footScale });
    const footY = m.h - 3 * u;
    drawText(ctx, version, 3 * u, footY, {
      font: 'hud',
      size: footScale,
      color: 'hudDim',
      baseline: 'bottom',
    });
    drawText(ctx, copyright, m.w - 3 * u, footY, {
      font: 'hud',
      size: footScale,
      color: 'hudDim',
      align: 'right',
      baseline: 'bottom',
    });

    // Best score sits on its own line above the footer, never across it.
    const best = state.best;
    if (best !== undefined && best.score > 0) {
      const bestText = `BEST ${formatInt(best.score)}  ·  DEPTH ${best.level}`;
      drawText(ctx, bestText, cx, footY - footH - 3 * u, {
        font: 'hud',
        size: fitScale(bestText, m.w - 8 * u, { font: 'hud' }, u),
        color: 'hudGold',
        align: 'center',
        baseline: 'bottom',
      });
    }
  }

  // ── Pause ──

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {GameState} state
   * @param {Screen} screen
   * @param {number} enter
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawPause(ctx, m, state, screen, enter, reduced) {
    const u = m.u;
    const cx = Math.round(m.w / 2);
    drawScrim(ctx, m, 0.66);

    const panelW = Math.min(m.w - 8 * u, Math.max(90 * u, m.w * 0.56));
    const headScale = fitScale('Paused', panelW * 0.7, { font: 'display' }, Math.max(2, u * 2), 1);
    const itemScale = fitScale('Quit to Title', panelW * 0.8, { font: 'display' }, scaleCap(m, 150), 1);
    const rowH = textHeight({ font: 'display', size: itemScale }) + 5 * u;
    const headH = textHeight({ font: 'display', size: headScale });
    const statusH = textHeight({ font: 'hud', size: u });
    const panelH = headH + 13 * u + rowH * screen.items.length + statusH + 6 * u;
    const px = Math.round(cx - panelW / 2);
    const py = Math.round((m.h - panelH) / 2) + panelSlide(enter, u, reduced);

    drawPanel(ctx, px, py, panelW, panelH, u, { frame: 'stone', alpha: 0.86 });
    drawText(ctx, 'Paused', cx, py + 5 * u, {
      font: 'display',
      size: headScale,
      color: 'gothic',
      align: 'center',
    });
    drawRule(ctx, cx, py + 5 * u + headH + 3 * u, Math.round(panelW * 0.32), u);
    drawItemList(ctx, m, state, screen, py + headH + 13 * u, itemScale, rowH, reduced);
    const status = `DEPTH ${state.level}  ·  ${formatInt(state.run.score)}`;
    drawText(ctx, status, cx, py + panelH - 3 * u, {
      font: 'hud',
      size: fitScale(status, panelW - 8 * u, { font: 'hud' }, u),
      color: 'hudDim',
      align: 'center',
      baseline: 'bottom',
    });
  }

  // ── Options ──

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {GameState} state
   * @param {Screen} screen
   * @param {number} enter
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawOptions(ctx, m, state, screen, enter, reduced) {
    const u = m.u;
    const cx = Math.round(m.w / 2);
    drawScrim(ctx, m, state.phase === 'paused' ? 0.74 : 0.6);

    const items = screen.items;
    const count = syncEnabled(screen, state);
    // Wide: label on the left, control on the right. Narrow: the slider track moves to its own
    // line under the label, which also makes it a thumb-sized drag target on a phone.
    const stacked = m.narrow;
    const panelW = Math.min(m.w - 4 * u, Math.max(stacked ? 92 * u : 110 * u, m.w * (stacked ? 0.88 : 0.74)));
    const inner = panelW - 12 * u;
    // Three columns: label, control, value. The value column has to hold "100%" at full size, and
    // a toggle's ON/OFF word shares it so sliders and switches line up down the panel.
    const valueW = measureLine('100%', { font: 'hud', size: u });
    const switchW = Math.min(18 * u, Math.round(inner * 0.3));
    const trackW = stacked
      ? inner - valueW - 3 * u
      : Math.max(10 * u, Math.round(inner * 0.34));

    // One scale for every label, so the list reads as a column rather than as a ransom note.
    const controlW = stacked
      ? switchW
      : Math.max(switchW + valueW + 3 * u, trackW + valueW + 3 * u);
    const labelColW = inner - controlW - 3 * u;
    let labelScale = Math.max(1, u);
    for (let i = 0; i < count; i++) {
      const fit = fitScale(items[i].label, labelColW, { font: 'display' }, labelScale);
      if (fit < labelScale) labelScale = fit;
    }

    const headScale = fitScale('Options', panelW * 0.6, { font: 'display' }, Math.max(2, u * 2), 1);
    const headH = textHeight({ font: 'display', size: headScale });
    const trackH = 5 * u;

    // Eight rows is the tallest screen in the game; on a short window (a phone held sideways) the
    // label scale comes down until the whole panel fits rather than running off the bottom.
    let labelH = 0;
    let flatRowH = 0;
    let stackedRowH = 0;
    let bodyH = 0;
    let panelH = 0;
    for (;;) {
      labelH = textHeight({ font: 'display', size: labelScale });
      flatRowH = labelH + 5 * u;
      stackedRowH = labelH + trackH + 8 * u;
      bodyH = 0;
      for (let i = 0; i < count; i++) {
        bodyH += stacked && items[i].kind === 'slider' ? stackedRowH : flatRowH;
      }
      panelH = headH + 12 * u + bodyH + 5 * u;
      if (panelH <= m.h - 4 * u || labelScale <= 1) break;
      labelScale--;
    }

    /**
     * Height of one row, which depends on its kind only in the stacked layout.
     * @param {MenuItem} item
     * @returns {number}
     */
    const rowHeightOf = (item) => (stacked && item.kind === 'slider' ? stackedRowH : flatRowH);
    const px = Math.round(cx - panelW / 2);
    const py = Math.max(2 * u, Math.round((m.h - panelH) / 2)) + panelSlide(enter, u, reduced);

    drawPanel(ctx, px, py, panelW, panelH, u, { frame: 'stone', alpha: 0.9 });
    drawText(ctx, 'Options', cx, py + 4 * u, {
      font: 'display',
      size: headScale,
      color: 'gothic',
      align: 'center',
    });
    drawRule(ctx, cx, py + 4 * u + headH + 2 * u, Math.round(panelW * 0.3), u);

    const left = px + 6 * u;
    const right = px + panelW - 6 * u;
    let y = py + headH + 12 * u;

    for (let i = 0; i < count; i++) {
      const item = items[i];
      const selected = i === index;
      const enabled = rowEnabled[i];
      const rowY = Math.round(y);
      const rowH = rowHeightOf(item);
      const labelColor = !enabled ? 'gothicOff' : selected ? 'gothicHot' : 'gothic';

      if (selected) {
        // Selection is a warm wash plus a gold edge — a full highlight bar would fight the panel.
        ctx.fillStyle = withAlpha(COLOR.goldMid, 0.22);
        ctx.fillRect(left - 3 * u, rowY - 2 * u, right - left + 6 * u, rowH - u);
        ctx.fillStyle = COLOR.goldBase;
        ctx.fillRect(left - 3 * u, rowY - 2 * u, u, rowH - u);
      }
      recordRow(i, left - 3 * u, rowY - 2 * u, right - left + 6 * u, rowH - u);

      if (item.kind === 'back') {
        const w = measureLine(item.label, { font: 'display', size: labelScale });
        drawText(ctx, item.label, cx, rowY, {
          font: 'display',
          size: labelScale,
          color: labelColor,
          align: 'center',
        });
        if (selected) {
          const fs = Math.max(1, Math.round(labelScale * 0.8));
          drawFlame(
            ctx,
            cx - Math.round(w / 2) - ICON_SIZE.flameW * fs - 2 * u,
            rowY - fs,
            fs,
            reduced ? 0 : ((clock * 11) | 0) % 3,
          );
        }
        y += rowH;
        continue;
      }

      drawText(ctx, item.label, left, rowY, {
        font: 'display',
        size: labelScale,
        color: labelColor,
        align: 'left',
      });

      const key = /** @type {keyof Settings} */ (item.key);

      if (item.kind === 'toggle') {
        const on = state.settings[key] === true;
        const bw = switchW;
        const bh = 7 * u;
        // Wide screens put the word in the same value column the sliders use, so the three columns
        // line up down the panel; a phone drops the word and keeps the switch.
        const bx = stacked ? right - bw : right - valueW - 3 * u - bw;
        const by = rowY + Math.round(labelH / 2) - Math.round(bh / 2);
        const half = Math.round(bw / 2);
        drawWell(ctx, bx, by, bw, bh, u, on ? COLOR.goldMid : COLOR.stoneShadow, COLOR.ironDark);
        // The knob slides to the side the state is on, so the switch reads from its shape and
        // colour before any word is parsed — the convention every touch UI already taught.
        ctx.fillStyle = on ? COLOR.goldPale : COLOR.stoneDark;
        ctx.fillRect(on ? bx + half : bx + u, by + u, half - u, bh - 2 * u);
        if (!stacked) {
          drawText(ctx, on ? 'ON' : 'OFF', right, by + Math.round(bh / 2), {
            font: 'hud',
            size: u,
            color: on ? (selected ? 'hud' : 'hudGold') : 'hudDim',
            align: 'right',
            baseline: 'middle',
          });
        }
        y += rowH;
        continue;
      }

      if (item.kind === 'choice') {
        // A cycle reads best as its three words with the live one lit: the player sees what the
        // other states are without pressing anything, which a switch can never show.
        const values = item.values === undefined ? [] : item.values;
        const labelOf = item.labelOf;
        const readFn = item.read;
        let current = '';
        try {
          current = readFn === undefined ? '' : readFn(state);
        } catch (err) {
          log.error('choice read failed', err);
        }
        const cy2 = rowY + Math.round(labelH / 2);
        if (stacked) {
          // A phone has no room for three words beside the label, so it shows the live one only —
          // the same trade the toggle makes when it drops its ON/OFF word.
          const word = labelOf === undefined ? current : labelOf(current);
          const wOfWord = measureLine(word, { font: 'hud', size: u });
          ctx.fillStyle = withAlpha(COLOR.goldMid, selected ? 0.5 : 0.32);
          ctx.fillRect(right - wOfWord - 2 * u, cy2 - Math.round(labelH / 2) + u, wOfWord + 4 * u, labelH);
          drawText(ctx, word, right, cy2, {
            font: 'hud',
            size: u,
            color: selected ? 'hud' : 'hudGold',
            align: 'right',
            baseline: 'middle',
          });
          y += rowH;
          continue;
        }
        // Right-aligned, laid out back to front so the live word always ends at the value column.
        let cxw = right;
        for (let v = values.length - 1; v >= 0; v--) {
          const word = labelOf === undefined ? values[v] : labelOf(values[v]);
          const wOfWord = measureLine(word, { font: 'hud', size: u });
          const on = values[v] === current;
          if (on) {
            ctx.fillStyle = withAlpha(COLOR.goldMid, selected ? 0.5 : 0.32);
            ctx.fillRect(cxw - wOfWord - 2 * u, cy2 - Math.round(labelH / 2) + u, wOfWord + 4 * u, labelH);
          }
          drawText(ctx, word, cxw, cy2, {
            font: 'hud',
            size: u,
            color: on ? (selected ? 'hud' : 'hudGold') : 'hudDim',
            align: 'right',
            baseline: 'middle',
          });
          cxw -= wOfWord + 5 * u;
        }
        y += rowH;
        continue;
      }

      // Slider.
      const min = item.min === undefined ? 0 : item.min;
      const max = item.max === undefined ? 1 : item.max;
      const raw = typeof state.settings[key] === 'number' ? Number(state.settings[key]) : min;
      const t = max > min ? clamp01((raw - min) / (max - min)) : 0;
      // The value always sits in its own column at the right edge; the track ends before it.
      const trackX = stacked ? left : right - valueW - 3 * u - trackW;
      const ty = stacked
        ? rowY + labelH + 3 * u
        : rowY + Math.round(labelH / 2) - Math.round(trackH / 2);

      drawWell(ctx, trackX, ty, trackW, trackH, u, COLOR.stoneShadow, COLOR.ironDark);
      const fillW = Math.round((trackW - 2 * u) * t);
      if (fillW > 0) {
        ctx.fillStyle = selected ? COLOR.fireHot : COLOR.goldBase;
        ctx.fillRect(trackX + u, ty + u, fillW, trackH - 2 * u);
      }
      // Knob: a chunky block, the one moving part.
      const knobW = 3 * u;
      const knobX = clamp(trackX + u + fillW - Math.round(knobW / 2), trackX, trackX + trackW - knobW);
      ctx.fillStyle = COLOR.void;
      ctx.fillRect(knobX, ty - u, knobW, trackH + 2 * u);
      ctx.fillStyle = selected ? COLOR.goldPale : COLOR.stoneBright;
      ctx.fillRect(
        knobX + Math.max(1, u >> 1),
        ty - u + Math.max(1, u >> 1),
        knobW - Math.max(1, u >> 1) * 2,
        trackH + 2 * u - Math.max(1, u >> 1) * 2,
      );

      const valueText =
        item.format === 'mult' ? raw.toFixed(1) + '×' : formatPercent(max > 0 ? raw / max : 0);
      drawText(ctx, valueText, right, ty + Math.round(trackH / 2), {
        font: 'hud',
        size: u,
        color: selected ? 'hud' : 'hudDim',
        align: 'right',
        baseline: 'middle',
      });

      // The draggable region is the track, padded so a thumb can find it.
      const o = i * 4;
      trackRects[o] = trackX + u;
      trackRects[o + 1] = ty - 2 * u;
      trackRects[o + 2] = trackW - 2 * u;
      trackRects[o + 3] = trackH + 4 * u;
      y += rowH;
    }
    rowCount = count;

    // The hint lives under the panel, or tucked against the bottom edge when there is no room.
    const promptH = textHeight({ font: 'hud', size: u });
    drawPrompt(
      ctx,
      m,
      'ARROWS ADJUST  ·  ESC BACK',
      Math.min(py + panelH + 5 * u, m.h - promptH - 2 * u),
      reduced,
    );
  }

  // ── Credits ──

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {GameState} state
   * @param {Screen} screen
   * @param {number} enter
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawCredits(ctx, m, state, screen, enter, reduced) {
    const u = m.u;
    const cx = Math.round(m.w / 2);
    drawScrim(ctx, m, 0.7);

    const panelW = Math.min(m.w - 6 * u, Math.max(110 * u, m.w * 0.7));
    const lineScale = u;
    const lineH = lineHeight({ font: 'hud', size: lineScale });
    const headScale = fitScale('Credits', panelW * 0.6, { font: 'display' }, Math.max(2, u * 2), 1);
    const headH = textHeight({ font: 'display', size: headScale });
    const bodyH = CREDITS_LINES.length * lineH;
    const itemScale = Math.max(1, u);
    const rowH = textHeight({ font: 'display', size: itemScale }) + 4 * u;
    const panelH = headH + 10 * u + bodyH + rowH + 8 * u;
    const px = Math.round(cx - panelW / 2);
    const py = Math.max(2 * u, Math.round((m.h - panelH) / 2)) + panelSlide(enter, u, reduced);

    drawPanel(ctx, px, py, panelW, panelH, u, { frame: 'wood', alpha: 0.9 });
    drawText(ctx, 'Credits', cx, py + 4 * u, {
      font: 'display',
      size: headScale,
      color: 'gothic',
      align: 'center',
    });
    drawRule(ctx, cx, py + 4 * u + headH + 2 * u, Math.round(panelW * 0.3), u);

    let y = py + headH + 11 * u;
    for (let i = 0; i < CREDITS_LINES.length; i++) {
      const line = CREDITS_LINES[i];
      if (line.length > 0) {
        drawText(ctx, line, cx, Math.round(y), {
          font: 'hud',
          size: lineScale,
          color: i === 0 ? 'hudGold' : 'hud',
          align: 'center',
        });
      }
      y += lineH;
    }
    drawItemList(ctx, m, state, screen, Math.round(y + 3 * u), itemScale, rowH, reduced);
  }

  // ── Loading ──

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {GameState} state
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawLoading(ctx, m, state, reduced) {
    const u = m.u;
    const cx = Math.round(m.w / 2);
    const cy = Math.round(m.h / 2);
    drawScrim(ctx, m, 0.82);

    const headText = 'Carving the labyrinth…';
    const headScale = fitScale(headText, m.w * 0.86, { font: 'display' }, Math.max(2, u + 1), 1);
    const headH = textHeight({ font: 'display', size: headScale });
    const artScale = Math.max(3, Math.round(u * 2.5));
    const artH = (ICON_SIZE.flameH + 2) * artScale;

    // Composition: a lit torch with a chisel swinging at it, the line of text, then the dots.
    // Everything is measured from the group's top so it stays centred at any size.
    const groupH = artH + headH + 16 * u;
    let y = Math.round(cy - groupH / 2);

    const swing = reduced ? 0 : Math.round(Math.sin(clock * 5.5) * 1.5 * u);
    // Centre the *pair*, not the torch: the chisel hangs off its left, so centring the flame alone
    // would leave the whole group sitting left of the heading.
    const pickW = PICK_ART.w * artScale + 2 * u;
    const torchX = cx - Math.round((ICON_SIZE.flameW * artScale) / 2) + Math.round(pickW / 2);
    drawFlame(ctx, torchX, y, artScale, reduced ? 0 : ((clock * 12) | 0) % 3);
    drawArt(
      ctx,
      PICK_ART,
      torchX - PICK_ART.w * artScale - 2 * u + swing,
      y + 2 * u - swing,
      artScale,
      PICK_PALETTE,
    );
    y += artH + 4 * u;

    drawText(ctx, headText, cx, y, {
      font: 'display',
      size: headScale,
      color: 'gothic',
      align: 'center',
    });
    y += headH + 6 * u;

    // Progress dots: honest about being indeterminate (the maze worker reports no progress), so
    // they cycle rather than pretending to fill a bar.
    const dots = 5;
    const lit = reduced ? dots : ((clock * 6) | 0) % (dots + 1);
    const dotSize = 2 * u;
    const gap = 3 * u;
    const totalW = dots * dotSize + (dots - 1) * gap;
    for (let i = 0; i < dots; i++) {
      ctx.fillStyle = i < lit ? COLOR.goldLight : COLOR.stoneDark;
      ctx.fillRect(Math.round(cx - totalW / 2 + i * (dotSize + gap)), y, dotSize, dotSize);
    }

    // What is being carved, in the numbers that matter: which depth, and how big. A player who
    // has just taken the stairs down into a 96×96 labyrinth should learn that here and not by
    // walking for ten minutes.
    const side = cellsForLevel(state.level);
    const banner = formatLevelBanner(state.level, side, side);
    const bannerSize = fitScale(banner, m.w * 0.9, { font: 'hud' }, Math.max(1, u), 1);
    drawText(ctx, banner, cx, y + 8 * u, {
      font: 'hud',
      size: bannerSize,
      color: 'hudGold',
      align: 'center',
    });
    const cells = side * side;
    drawText(ctx, `${formatInt(cells)} CELLS`, cx, y + 8 * u + textHeight({ font: 'hud', size: bannerSize }) + 2 * u, {
      font: 'hud',
      size: bannerSize,
      color: 'hudDim',
      align: 'center',
    });
    rowCount = 0;
  }

  // ── Run statistics (shared by level complete and game over) ──

  /**
   * Labels and values of the expedition summary, filled by {@link buildRunStats}. Fixed-size
   * arrays, reused: these screens re-render every frame like everything else here.
   * @type {string[]}
   */
  const statLabels = ['', '', '', ''];
  /** @type {string[]} */
  const statValues = ['', '', '', ''];
  let statCount = 0;
  /** Cache key for the explored count: the level object identity it was measured on. */
  let statLevelRef = null;
  let statExplored = 0;

  /**
   * Collect the "what did that expedition cost" rows.
   *
   * Only rows whose data actually exists are emitted — a summary with four `--` in it reads as a
   * broken screen, not as an honest one. Maze size and the mapped fraction are always available
   * (the maze and the fog grid are both in the state); refuels and distance walked need
   * `run.refuels` / `run.distance`, which `src/state` does not carry yet (see the integrator note
   * in this wave's report) and which appear automatically the day it does.
   *
   * The explored count is an O(tiles) scan, so it is taken **once per screen entry** and cached on
   * the level's identity — never per frame, which at 66 000 tiles would cost more than the rest of
   * the screen put together.
   * @param {GameState} state
   * @returns {number} how many rows were filled
   */
  function buildRunStats(state) {
    statCount = 0;
    const level = state.levelData;
    const run = /** @type {any} */ (state.run);
    if (level !== null && level !== undefined && level.maze !== undefined) {
      const maze = level.maze;
      statLabels[statCount] = 'LABYRINTH';
      statValues[statCount] = formatLabyrinth(maze.cols, maze.rows);
      statCount++;

      const total = maze.width * maze.height;
      if (state.explored !== null && state.explored !== undefined && total > 0) {
        if (statLevelRef !== level) {
          statExplored = countExplored(state.explored, total);
          statLevelRef = level;
        }
        statLabels[statCount] = 'EXPLORED';
        statValues[statCount] = formatPercent(statExplored / total);
        statCount++;
      }
    }
    if (typeof run.refuels === 'number' && Number.isFinite(run.refuels) && statCount < statLabels.length) {
      statLabels[statCount] = 'REFUELS';
      statValues[statCount] = formatInt(run.refuels);
      statCount++;
    }
    if (typeof run.distance === 'number' && Number.isFinite(run.distance) && statCount < statLabels.length) {
      statLabels[statCount] = 'WALKED';
      statValues[statCount] = formatDistance(run.distance);
      statCount++;
    }
    return statCount;
  }

  /**
   * Draw the stat rows as a two-column strip: label above value, so four numbers fit on one line
   * of a phone and two lines of a desktop panel without a table.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} left
   * @param {number} right
   * @param {number} y top edge
   * @param {number} u
   * @param {number} size text scale
   * @param {number} alpha
   * @returns {number} the height drawn
   */
  function drawStatStrip(ctx, left, right, y, u, size, alpha) {
    if (statCount === 0) return 0;
    const lineH = textHeight({ font: 'hud', size });
    const perRow = statCount >= 3 ? 2 : statCount;
    const colW = Math.floor((right - left) / perRow);
    const rows = Math.ceil(statCount / perRow);
    for (let i = 0; i < statCount; i++) {
      const col = i % perRow;
      const row = (i / perRow) | 0;
      const x = left + col * colW;
      const ry = y + row * (lineH * 2 + 2 * u);
      drawText(ctx, statLabels[i], x, ry, { font: 'hud', size, color: 'hudDim', alpha });
      drawText(ctx, statValues[i], x, ry + lineH + u, { font: 'hud', size, color: 'hudBright', alpha });
    }
    return rows * (lineH * 2 + 4 * u);
  }

  // ── Level complete ──

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {GameState} state
   * @param {Screen} screen
   * @param {number} enter
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawComplete(ctx, m, state, screen, enter, reduced) {
    const u = m.u;
    const cx = Math.round(m.w / 2);
    drawScrim(ctx, m, 0.72);

    const run = state.run;
    const level = state.level;
    const targets = [
      run.gems * SCORE_RULES.GEM_BASE * level,
      fuelBonusOf(state),
      SCORE_RULES.CLEAR_BASE * level,
      run.score,
    ];
    // Rows arrive one at a time; each starts rolling `TALLY_STAGGER` after the one before it.
    let allDone = true;
    for (let i = 0; i < TALLY_ROWS; i++) {
      const due = TALLY_DELAY + i * TALLY_STAGGER;
      if (tallyT >= due) {
        tallyCounters[i].set(targets[i]);
      } else {
        allDone = false;
      }
      if (!tallyCounters[i].done) allDone = false;
    }
    if (allDone) tallyDone = true;

    const labels = [
      `GEMS ${formatCount(run.gems, run.gemsTotal)} × ${SCORE_RULES.GEM_BASE * level}`,
      `TORCH LEFT ${formatTime(run.fuel)}`,
      'DEPTH BONUS',
      'TOTAL',
    ];
    // Measure against the *final* values so the column does not shift while the counters roll.
    const finals = [
      formatInt(targets[0]),
      formatInt(targets[1]),
      formatInt(targets[2]),
      formatInt(targets[3]),
    ];

    const panelW = Math.min(m.w - 4 * u, Math.max(100 * u, m.w * 0.68));
    const headText = `Depth ${level} Cleared`;
    const headScale = fitScale(headText, panelW * 0.86, { font: 'display' }, Math.max(2, u * 2), 1);
    const headH = textHeight({ font: 'display', size: headScale });
    const colW = panelW - 14 * u;
    const rowScale = fitRowScale(labels, finals, colW, u);
    const totalScale = Math.min(rowScale + 1, fitRowScale([labels[3]], [finals[3]], colW, u + 1));
    const lineH = textHeight({ font: 'hud', size: totalScale }) + 4 * u;
    const itemScale = fitScale('Quit to Title', panelW * 0.7, { font: 'display' }, scaleCap(m, 150), 1);
    const rowH = textHeight({ font: 'display', size: itemScale }) + 4 * u;
    // The expedition summary sits between the tally and the buttons: it is the record of the maze
    // you just walked, which at these sizes is a bigger story than the score.
    const statRows = buildRunStats(state);
    const statH = statRows === 0 ? 0 : (statRows >= 3 ? 2 : 1) * (textHeight({ font: 'hud', size: rowScale }) * 2 + 4 * u) + 4 * u;
    const panelH =
      headH + 13 * u + lineH * TALLY_ROWS + 4 * u + statH + rowH * screen.items.length + 6 * u;
    const px = Math.round(cx - panelW / 2);
    const py = Math.max(2 * u, Math.round((m.h - panelH) / 2)) + panelSlide(enter, u, reduced);

    drawPanel(ctx, px, py, panelW, panelH, u, { frame: 'stone', alpha: 0.9 });
    drawText(ctx, headText, cx, py + 4 * u, {
      font: 'display',
      size: headScale,
      color: 'gothic',
      align: 'center',
    });
    drawRule(ctx, cx, py + 4 * u + headH + 2 * u, Math.round(panelW * 0.34), u);

    const left = px + 7 * u;
    const right = px + panelW - 7 * u;
    let y = py + headH + 13 * u;
    for (let i = 0; i < TALLY_ROWS; i++) {
      const due = TALLY_DELAY + i * TALLY_STAGGER;
      if (tallyT < due) {
        y += lineH;
        continue;
      }
      const isTotal = i === TALLY_ROWS - 1;
      if (isTotal) {
        ctx.fillStyle = COLOR.goldMid;
        ctx.fillRect(left, Math.round(y - 3 * u), right - left, Math.max(1, u >> 1));
      }
      // A row pops in a touch higher, then settles — 160 ms, just enough to feel struck.
      const age = tallyT - due;
      const punch = reduced || age > 0.16 ? 0 : Math.round((1 - age / 0.16) * u);
      drawRow(
        ctx,
        labels[i],
        formatInt(tallyCounters[i].value),
        left,
        right,
        Math.round(y) - punch,
        isTotal ? totalScale : rowScale,
        isTotal ? 'hudGold' : 'hud',
        isTotal ? 'hudBright' : 'hudGold',
      );
      y += lineH;
    }

    y += 4 * u;
    if (statH > 0) {
      ctx.fillStyle = withAlpha(COLOR.stoneDark, 0.5);
      ctx.fillRect(left, Math.round(y) - 2 * u, right - left, Math.max(1, u >> 1));
      // The strip fades in with the last tally row rather than arriving with the panel, so the
      // eye finishes the score before it is offered the expedition numbers.
      const statAlpha = tallyDone ? 1 : clamp01((tallyT - TALLY_DELAY - TALLY_ROWS * TALLY_STAGGER) * 2);
      if (statAlpha > 0) drawStatStrip(ctx, left, right, Math.round(y + 2 * u), u, rowScale, statAlpha);
      y += statH;
    }
    if (tallyDone) {
      drawItemList(ctx, m, state, screen, Math.round(y), itemScale, rowH, reduced);
    } else {
      rowCount = 0;
      drawPrompt(ctx, m, 'PRESS ENTER TO SKIP', Math.round(y + rowH / 2), reduced);
    }
  }

  // ── Game over ──

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {GameState} state
   * @param {Screen} screen
   * @param {number} enter
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawGameOver(ctx, m, state, screen, enter, reduced) {
    const u = m.u;
    const cx = Math.round(m.w / 2);
    // The screen fades to near-black over the first second: the torch has gone out.
    const fade = reduced ? 0.86 : 0.55 + 0.35 * clamp01(enterT / 1.2);
    drawScrim(ctx, m, fade);

    const run = state.run;
    const best = state.best;
    // `recordBest` has already folded the run into `best` by the time this screen shows, so a run
    // that set the record is the one whose score *is* the record.
    const newBest = run.score > 0 && run.score >= best.score;

    const headText = 'Your torch has gone out';
    const scoreText = formatInt(run.score);
    const bestText = formatInt(best.score);
    const labels = ['SCORE', 'DEPTH REACHED', newBest ? 'NEW BEST' : 'BEST'];
    const values = [scoreText, String(state.level), bestText];

    const panelW = Math.min(m.w - 4 * u, Math.max(100 * u, m.w * 0.7));
    const headScale = fitScale(
      headText,
      panelW * 0.9,
      { font: 'display' },
      Math.max(2, Math.round(u * 1.6)),
      1,
    );
    const headH = textHeight({ font: 'display', size: headScale });
    const colW = panelW - 14 * u;
    const rowScale = fitRowScale(labels, values, colW, u);
    const scoreScale = Math.min(rowScale + 1, fitRowScale([labels[0]], [values[0]], colW, u + 1));
    const lineH = textHeight({ font: 'hud', size: scoreScale }) + 4 * u;
    const itemScale = fitScale('Try Again', panelW * 0.6, { font: 'display' }, scaleCap(m, 150), 1);
    const rowH = textHeight({ font: 'display', size: itemScale }) + 4 * u;
    const statRows = buildRunStats(state);
    const statH = statRows === 0 ? 0 : (statRows >= 3 ? 2 : 1) * (textHeight({ font: 'hud', size: rowScale }) * 2 + 4 * u) + 4 * u;
    const panelH = headH + 14 * u + lineH * 3 + statH + rowH * screen.items.length + 6 * u;
    const px = Math.round(cx - panelW / 2);
    const py = Math.max(2 * u, Math.round((m.h - panelH) / 2)) + panelSlide(enter, u, reduced);

    drawPanel(ctx, px, py, panelW, panelH, u, { frame: 'stone', alpha: 0.92 });

    drawText(ctx, headText, cx, py + 4 * u, {
      font: 'display',
      size: headScale,
      color: 'gothic',
      align: 'center',
    });
    drawRule(ctx, cx, py + 4 * u + headH + 2 * u, Math.round(panelW * 0.34), u);

    const left = px + 7 * u;
    const right = px + panelW - 7 * u;
    let y = py + headH + 14 * u;
    drawRow(ctx, labels[0], values[0], left, right, Math.round(y), scoreScale, 'hud', 'hudBright');
    y += lineH;
    drawRow(ctx, labels[1], values[1], left, right, Math.round(y), rowScale, 'hudDim', 'hudGold');
    y += lineH;
    // A new record flashes; an old one is stated quietly.
    const flash = newBest ? (reduced ? 1 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(clock * 7))) : 1;
    drawRow(
      ctx,
      labels[2],
      values[2],
      left,
      right,
      Math.round(y),
      rowScale,
      newBest ? 'hudBright' : 'hudDim',
      newBest ? 'hudBright' : 'hudGold',
      flash,
    );
    y += lineH + 2 * u;

    // Where the torch went out: how big the labyrinth was and how much of it was ever seen. On a
    // 128×128 level "explored 31 %" is the whole story of the run in one number.
    if (statH > 0) {
      ctx.fillStyle = withAlpha(COLOR.stoneDark, 0.5);
      ctx.fillRect(left, Math.round(y) - 2 * u, right - left, Math.max(1, u >> 1));
      drawStatStrip(ctx, left, right, Math.round(y + 2 * u), u, rowScale, 1);
      y += statH;
    }

    drawItemList(ctx, m, state, screen, Math.round(y), itemScale, rowH, reduced);
  }

  /**
   * @returns {void}
   */
  function dispose() {
    lastState = null;
    rowCount = 0;
  }

  return {
    render,
    handleInput,
    handlePointer,
    resize,
    surface,
    screen: () => currentScreenId,
    dispose,
  };
}
