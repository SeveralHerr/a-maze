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
  createTextMemo,
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

/** Rows a screen may lay out (the options screen, at nine, is the longest). */
const MAX_ROWS = 16;

/** Values one `choice` row may show as separately clickable words. */
const MAX_CHOICE_VALUES = 4;

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
  { id: 'controls', label: 'Controls', kind: 'action' },
  { id: 'credits', label: 'Credits', kind: 'action' },
]);

/** Pause screen. */
const PAUSE_ITEMS = /** @type {ReadonlyArray<MenuItem>} */ ([
  { id: 'resume', label: 'Resume', kind: 'action' },
  { id: 'options', label: 'Options', kind: 'action' },
  { id: 'controls', label: 'Controls', kind: 'action' },
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

/** Controls screen — one row out, same shape as Credits. */
const CONTROLS_ITEMS = /** @type {ReadonlyArray<MenuItem>} */ ([
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

/** The game-over record line. */
const NEW_BEST_TEXT = 'NEW BEST!';

/** Loading screen — nothing to select. */
const NO_ITEMS = /** @type {ReadonlyArray<MenuItem>} */ ([]);

/** Every screen by id. */
const SCREENS = Object.freeze({
  title: Object.freeze({ id: 'title', items: TITLE_ITEMS }),
  pause: Object.freeze({ id: 'pause', items: PAUSE_ITEMS }),
  options: Object.freeze({ id: 'options', items: OPTION_ITEMS }),
  credits: Object.freeze({ id: 'credits', items: CREDITS_ITEMS }),
  controls: Object.freeze({ id: 'controls', items: CONTROLS_ITEMS }),
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

/**
 * One line of the Controls panel.
 * @typedef {{label:string, keys:string, pad?:string}} ControlHint
 */

/** Most hint rows the Controls panel will draw. */
const MAX_CONTROL_ROWS = 12;

/**
 * What the game is played with, in display order.
 *
 * This mirrors `CONTROL_HINTS` in `src/input/bindings.js`, which is the authority on the bindings
 * themselves — `src/ui` may not import `src/input` (§2), so the composition root can hand the real
 * table in through `createMenus(canvas, {controls})` and this table is the fallback for a harness,
 * a preview or a host that passes nothing. A drift shows up as a wrong hint on one panel and
 * nowhere else; the keys themselves are never read from here.
 *
 * Written in ASCII on purpose: the bitmap faces cover 0x20…0x7E plus `© × … ·` (§4.6), so the
 * arrow glyphs the input module's own table uses would silently drop out. {@link sanitizeHints}
 * translates them for an override that carries them.
 * @type {ReadonlyArray<ControlHint>}
 */
const DEFAULT_CONTROL_HINTS = Object.freeze([
  Object.freeze({ label: 'Move', keys: 'W S  ·  UP DOWN', pad: 'Left stick' }),
  Object.freeze({ label: 'Strafe', keys: 'A D', pad: 'Left stick' }),
  Object.freeze({ label: 'Turn', keys: 'Q E  ·  LEFT RIGHT', pad: 'Right stick' }),
  Object.freeze({ label: 'Look', keys: 'MOUSE', pad: 'Right stick' }),
  Object.freeze({ label: 'Sprint', keys: 'SHIFT', pad: 'Triggers' }),
  Object.freeze({ label: 'Map', keys: 'M  ·  TAB', pad: 'View' }),
  Object.freeze({ label: 'Pause', keys: 'ESC  ·  P', pad: 'Menu' }),
  Object.freeze({ label: 'Mute', keys: 'N', pad: '—' }),
  Object.freeze({ label: 'Confirm', keys: 'ENTER  ·  SPACE', pad: 'A' }),
  Object.freeze({ label: 'Back', keys: 'ESC  ·  BACKSPACE', pad: 'B' }),
]);

/** The line under the keyboard table, for a player who will pick the game up on a phone later. */
const TOUCH_HINT = 'Touch: left stick moves, drag the right half to look.';

/**
 * What a phone is played with (`src/input/touch-overlay.js` + the touch path of `input.js`).
 *
 * A player holding a phone has no W key, no Shift and no Tab, so the keyboard table told them
 * nothing they could use — and its one touch line did not fit a phone's panel. On a device whose
 * primary pointer is a finger the panel shows this table instead. Sprint is an outward *flick* of
 * the stick, not a deflection (see `TOUCH_SPRINT_FLICK_RATIO` in `input.js`), and the two buttons
 * carry the labels `MAP` and `PAUSE`.
 * @type {ReadonlyArray<ControlHint>}
 */
const TOUCH_CONTROL_HINTS = Object.freeze([
  Object.freeze({ label: 'Move', keys: 'LEFT STICK' }),
  Object.freeze({ label: 'Sprint', keys: 'FLICK THE STICK' }),
  Object.freeze({ label: 'Look', keys: 'DRAG RIGHT SIDE' }),
  Object.freeze({ label: 'Map', keys: 'MAP BUTTON' }),
  Object.freeze({ label: 'Pause', keys: 'PAUSE BUTTON' }),
  Object.freeze({ label: 'Choose', keys: 'TAP' }),
]);

/** The footer under the touch table. */
const KEYBOARD_HINT = 'A keyboard or gamepad works too.';

/** Characters the bitmap faces cannot draw, and what to say instead. */
const GLYPH_FALLBACK = Object.freeze({
  '↑': 'UP',
  '↓': 'DOWN',
  '←': 'LEFT',
  '→': 'RIGHT',
  '—': '-',
  '–': '-',
});

/**
 * Make a caller-supplied hint table safe to draw: strings only, unrenderable glyphs translated,
 * and a hard cap so a hostile table cannot make the panel taller than the screen.
 *
 * Runs **once**, when the menus are created — never per frame.
 * @param {unknown} hints
 * @returns {ReadonlyArray<ControlHint>}
 */
function sanitizeHints(hints) {
  if (!Array.isArray(hints) || hints.length === 0) return DEFAULT_CONTROL_HINTS;
  /** @type {ControlHint[]} */
  const out = [];
  for (let i = 0; i < hints.length && out.length < MAX_CONTROL_ROWS; i++) {
    const h = hints[i];
    if (h === null || typeof h !== 'object') continue;
    const label = typeof h.label === 'string' ? h.label : '';
    const keys = typeof h.keys === 'string' ? h.keys : '';
    if (label === '' || keys === '') continue;
    out.push({ label: translateGlyphs(label), keys: translateGlyphs(keys) });
  }
  return out.length === 0 ? DEFAULT_CONTROL_HINTS : out;
}

/**
 * Replace the characters the faces have no glyph for (a missing glyph is dropped silently, which
 * would turn `'W S / ↑ ↓'` into `'W S / '`).
 * @param {string} text
 * @returns {string}
 */
function translateGlyphs(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const sub = /** @type {any} */ (GLYPH_FALLBACK)[ch];
    out += sub === undefined ? ch : sub;
  }
  return out;
}

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
 * @property {ReadonlyArray<ControlHint>} [controls] what the Controls panel lists. The composition
 *   root passes `CONTROL_HINTS` from `src/input/bindings.js` — the module that owns the bindings —
 *   because `src/ui` may not import `src/input` (§2). Omitted, the mirrored default is used.
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
  /**
   * The Controls panel's contents, resolved once. `src/ui` may not import `src/input`, so the
   * composition root passes `CONTROL_HINTS` in; anything missing or malformed falls back to the
   * mirrored table above.
   * @type {ReadonlyArray<ControlHint>}
   */
  const controlHints = sanitizeHints(/** @type {any} */ (cb).controls);

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
  const rowRects = new Float64Array(4 * MAX_ROWS);
  /** Flat slider-track rectangles, parallel to `rowRects`. */
  const trackRects = new Float64Array(4 * MAX_ROWS);
  /**
   * Flat rectangles of the individual words of a `choice` row, keyed by
   * `(row * MAX_CHOICE_VALUES + value) * 4` — the same trick as `trackRects`, one level deeper.
   *
   * WHY it exists: `drawOptions` paints Off/Corner/Full as three separately highlighted targets,
   * so a pointer landing on one of them must write **that** value. Without these rectangles the
   * click fell through to the keyboard path (`stepChoice`), which advances the cycle and therefore
   * gave the wrong answer two times out of three — and on a touch device this row is the only way
   * to change the setting at all.
   */
  const choiceRects = new Float64Array(4 * MAX_ROWS * MAX_CHOICE_VALUES);
  /** How many of a row's words were laid out (0 for every row that is not a wide `choice`). */
  const choiceCounts = new Int32Array(MAX_ROWS);
  /** Number of rows laid out last frame. */
  let rowCount = 0;

  // ── Label text, rebuilt only when the numbers behind it change ──
  // Every screen here re-renders every frame, and a template literal or `formatX()` call allocates
  // a new string each time even when the text is identical to the last frame's. These memos key on
  // the (already integer) inputs, so a screen that is standing still allocates no strings at all.
  const bestMemo = createTextMemo((score, level) => 'BEST ' + formatInt(score) + '  ·  DEPTH ' + level);
  const statusMemo = createTextMemo((level, score) => 'DEPTH ' + level + '  ·  ' + formatInt(score));
  const bannerMemo = createTextMemo((level, side) => formatLevelBanner(level, side, side));
  const cellsMemo = createTextMemo((cells) => formatInt(cells) + ' CELLS');
  const gemsRowMemo = createTextMemo(
    (gems, total, level) => 'GEMS ' + formatCount(gems, total) + ' × ' + SCORE_RULES.GEM_BASE * level,
  );
  const torchRowMemo = createTextMemo((sec) => 'TORCH LEFT ' + formatTime(sec));
  const clearedMemo = createTextMemo((level) => 'Depth ' + level + ' Cleared');
  const levelMemo = createTextMemo((level) => String(level));
  /** One integer memo per tally row (final value) and per rolling counter (shown value). */
  const tallyFinalMemos = [0, 1, 2, 3].map(() => createTextMemo((v) => formatInt(v)));
  const tallyShownMemos = [0, 1, 2, 3].map(() => createTextMemo((v) => formatInt(v)));
  const scoreMemo = createTextMemo((v) => formatInt(v));
  const bestScoreMemo = createTextMemo((v) => formatInt(v));
  const labyrinthMemo = createTextMemo((c, r) => formatLabyrinth(c, r));
  const exploredMemo = createTextMemo((pct) => formatPercent(pct / 100));
  const refuelsMemo = createTextMemo((n) => formatInt(n));
  const walkedMemo = createTextMemo((d) => formatDistance(d));
  /** Slider value text per options row, keyed on the value in thousandths (what `adjust` rounds to). */
  const sliderMemos = Array.from({ length: MAX_ROWS }, () =>
    createTextMemo((milli, mult, max) =>
      mult === 1 ? (milli / 1000).toFixed(1) + '×' : formatPercent(max > 0 ? milli / 1000 / max : 0),
    ),
  );
  /** Enabled flags for the rows laid out last frame. @type {boolean[]} */
  const rowEnabled = new Array(MAX_ROWS).fill(true);
  /** Pointer mapping scratch. */
  const ptr = new Float64Array(2);
  /** Row the pointer went down on, for click-release matching. */
  let pressedRow = -1;
  /** Row whose slider is being dragged, or −1. */
  let dragRow = -1;

  /**
   * The sub-screen open over the title or pause screen, or null.
   * @returns {Screen|null}
   */
  function subScreen() {
    if (sub === 'options') return SCREENS.options;
    if (sub === 'credits') return SCREENS.credits;
    if (sub === 'controls') return SCREENS.controls;
    return null;
  }

  /**
   * Which screen should be showing for this state.
   * @param {GameState} state
   * @returns {Screen}
   */
  function screenFor(state) {
    switch (state.phase) {
      case 'title':
        return subScreen() === null ? SCREENS.title : /** @type {Screen} */ (subScreen());
      case 'paused':
        return subScreen() === null ? SCREENS.pause : /** @type {Screen} */ (subScreen());
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
      case 'controls':
        sound('uiConfirm');
        openSub('controls');
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
   * Write one `choice` value directly (the pointer path: the player clicked a word, so the answer
   * is that word — not "the next one along", which is what the keyboard means by confirm).
   * @param {MenuItem} item
   * @param {string} value one of `item.values`
   * @returns {boolean} true when the write ran
   */
  function writeChoice(item, value) {
    const write = item.write;
    if (write === undefined) {
      sound('uiDeny');
      return false;
    }
    sound('uiConfirm');
    try {
      write(value, (key, v) => invoke(cb.onSetting, 'onSetting', key, v));
    } catch (err) {
      log.error('choice write failed', err);
      return false;
    }
    return true;
  }

  /**
   * Which word of a `choice` row the pointer is over, or −1.
   * @param {number} row
   * @param {number} x UI pixels
   * @param {number} y UI pixels
   * @returns {number} index into the row's `values`, or −1
   */
  function choiceHit(row, x, y) {
    if (row < 0 || row >= MAX_ROWS) return -1;
    const n = choiceCounts[row];
    if (n <= 0) return -1;
    const base = row * MAX_CHOICE_VALUES * 4;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    for (let v = 0; v < n; v++) {
      const o = base + v * 4;
      const rx = choiceRects[o];
      const ry = choiceRects[o + 1];
      if (x < rx || y < ry) continue;
      if (x >= rx + choiceRects[o + 2] || y >= ry + choiceRects[o + 3]) continue;
      return v;
    }
    return -1;
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
        // A `choice` row paints its values as separate words: a click on one of them means that
        // value. Only a click on the row but off every word falls through to `activate`, which
        // steps the cycle the way confirm does.
        const item = screen.items[row];
        if (item !== undefined && item.kind === 'choice') {
          const word = choiceHit(row, ptr[0], ptr[1]);
          const values = item.values;
          if (word >= 0 && values !== undefined && word < values.length) {
            writeChoice(item, values[word]);
            return true;
          }
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
        // Reduced motion means reduced motion: rows arriving one at a time over ~1.8 s with four
        // counters rolling is exactly the effect the setting asks to turn off, and suppressing
        // only the 160 ms row punch left the animation that matters running.
        if (state.settings !== undefined && state.settings.reducedMotion === true) {
          finishTally(state);
        }
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
      case 'controls':
        drawControls(ctx, m, state, screen, enter, reduced);
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
  let columnW = -1;
  let columnH = -1;
  let columnHalf = -1;

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
    if (columnGradient === null || columnW !== m.w || columnH !== m.h || columnHalf !== halfW) {
      const g = ctx.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
      g.addColorStop(0, withAlpha(COLOR.void, 0));
      g.addColorStop(0.22, withAlpha(COLOR.void, 0.55));
      g.addColorStop(0.78, withAlpha(COLOR.void, 0.55));
      g.addColorStop(1, withAlpha(COLOR.void, 0));
      columnGradient = g;
      columnW = m.w;
      columnH = m.h;
      columnHalf = halfW;
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
    // Likewise the per-word targets: a row that is not a wide `choice` has none, so a stale
    // layout can never hand a click to a word that is no longer on screen.
    choiceCounts[i] = 0;
  }

  /**
   * Record one word of a `choice` row as its own pointer target.
   * @param {number} i row index
   * @param {number} v value index
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @returns {void}
   */
  function recordChoiceWord(i, v, x, y, w, h) {
    if (i < 0 || i >= MAX_ROWS || v < 0 || v >= MAX_CHOICE_VALUES) return;
    const o = (i * MAX_CHOICE_VALUES + v) * 4;
    choiceRects[o] = x;
    choiceRects[o + 1] = y;
    choiceRects[o + 2] = w;
    choiceRects[o + 3] = h;
    if (v + 1 > choiceCounts[i]) choiceCounts[i] = v + 1;
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
    // The menu never outranks the wordmark. On a phone the logo is width-bound (62 % of 234 UI
    // pixels) while the height cap still allowed scale 4 rows, so the four menu words came out
    // bigger than "A-MAZE" itself — the title screen's hierarchy upside down.
    const itemScale = fitScale(
      'Descend',
      colW * 0.7,
      { font: 'display' },
      Math.max(1, Math.min(scaleCap(m, 110), heightCap, logoScale - 1)),
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
      const bestText = bestMemo(best.score, best.level);
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
    const status = statusMemo(state.level, Math.floor(state.run.score));
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
    // A phone keeps the ON/OFF word (an unlabelled switch on a narrow panel is genuinely
    // ambiguous), and pays for it out of the switch's width rather than the label's: the whole row
    // is the tap target, so a narrower switch costs nothing to hit and the word costs nothing to
    // read. `wordSize`/`wordW` are the column that word needs.
    const wordSize = stacked ? Math.max(1, u - 1) : u;
    const wordW = stacked ? measureLine('OFF', { font: 'hud', size: wordSize }) : valueW;
    const switchW = stacked
      ? Math.min(8 * u, Math.round(inner * 0.18))
      : Math.min(18 * u, Math.round(inner * 0.3));
    const trackW = stacked
      ? inner - valueW - 3 * u
      : Math.max(10 * u, Math.round(inner * 0.34));

    // One scale for every label, so the list reads as a column rather than as a ransom note.
    const controlW = stacked
      ? switchW + wordW + 3 * u
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
        // The word sits in the value column the sliders use, so the three columns line up down the
        // panel. A phone shrinks it (and the switch) rather than dropping it.
        const bx = right - wordW - 3 * u - bw;
        const by = rowY + Math.round(labelH / 2) - Math.round(bh / 2);
        const half = Math.round(bw / 2);
        // BOTH states get a track the eye can see. An OFF switch drawn in stone-shadow on a
        // near-black panel had no track at all, so the knob was a grey blob with nothing to judge
        // its position against — iron against a dark border reads as an empty channel, and the
        // gold of the ON state then reads as "filled".
        drawWell(ctx, bx, by, bw, bh, u, on ? COLOR.goldMid : COLOR.ironBase, COLOR.stoneDark);
        // The knob slides to the side the state is on, so the switch reads from its shape and
        // colour before any word is parsed — the convention every touch UI already taught.
        ctx.fillStyle = on ? COLOR.goldPale : COLOR.stoneBright;
        ctx.fillRect(on ? bx + half : bx + u, by + u, half - u, bh - 2 * u);
        drawText(ctx, on ? 'ON' : 'OFF', right, by + Math.round(bh / 2), {
          font: 'hud',
          size: wordSize,
          color: on ? (selected ? 'hud' : 'hudGold') : 'hudDim',
          align: 'right',
          baseline: 'middle',
        });
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
        // Each word is also recorded as its own pointer target: they are drawn as three separate
        // choices, so clicking one has to mean that one (see `choiceRects`).
        let cxw = right;
        // Each word's *target* runs from its own left padding to the next word's, so the gaps
        // between them and the trailing margin belong to a word rather than being dead slivers
        // that fall through to the cycle. The painted highlight is unchanged; only the hit box
        // grows, which is what a thumb needs.
        let wordEdge = right + 3 * u;
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
          // Full row height, so a thumb aiming at a word does not have to find the text's own box.
          const wordX = cxw - wOfWord - 2 * u;
          recordChoiceWord(i, v, wordX, rowY - 2 * u, wordEdge - wordX, rowH - u);
          wordEdge = wordX;
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

      const valueText = sliderMemos[i](Math.round(raw * 1000), item.format === 'mult' ? 1 : 0, max);
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

    // The hint lives under the panel. When the panel has taken the whole height (a phone held
    // sideways) the hint is left out rather than drawn across the panel's bottom frame, which is
    // what tucking it against the screen edge used to do: the rows are the content, and the hint
    // only names the controls the rows already respond to.
    const promptH = textHeight({ font: 'hud', size: u });
    const promptY = py + panelH + 4 * u;
    if (promptY + promptH <= m.h - u) {
      drawPrompt(
        ctx,
        m,
        primaryPointerIsCoarse() ? 'TAP OR DRAG TO ADJUST' : 'ARROWS ADJUST  ·  ESC BACK',
        promptY,
        reduced,
      );
    }
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

  // ── Controls ──

  /**
   * What the game is played with. `src/input/bindings.js` owns the bindings and exports the table
   * (`CONTROL_HINTS`); it is drawn here in the same panel style as Credits, because a first-person
   * maze whose player never learns about sprint, the map key or mouse look is a harder game than
   * it was designed to be.
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {GameState} state
   * @param {Screen} screen
   * @param {number} enter
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawControls(ctx, m, state, screen, enter, reduced) {
    const u = m.u;
    const cx = Math.round(m.w / 2);
    drawScrim(ctx, m, state.phase === 'paused' ? 0.76 : 0.7);

    const touch = primaryPointerIsCoarse();
    const hints = touch ? TOUCH_CONTROL_HINTS : controlHints;
    const footer = touch ? KEYBOARD_HINT : TOUCH_HINT;
    const panelW = Math.min(m.w - 4 * u, Math.max(110 * u, m.w * 0.74));
    const colW = panelW - 14 * u;
    const headScale = fitScale('Controls', panelW * 0.6, { font: 'display' }, Math.max(2, u * 2), 1);
    const headH = textHeight({ font: 'display', size: headScale });
    const itemScale = Math.max(1, u);
    const rowH = textHeight({ font: 'display', size: itemScale }) + 4 * u;

    // One scale for every key/action pair, then the whole panel is shrunk until it fits the
    // surface — ten rows is taller than the options screen, so a short window is the normal case
    // rather than the exception.
    let size = fitHintScale(hints, colW, Math.max(1, u));
    let lineH = 0;
    let footH = 0;
    let panelH = 0;
    for (;;) {
      lineH = textHeight({ font: 'hud', size }) + 2 * u;
      footH = textHeight({ font: 'hud', size: Math.max(1, size - 1) }) + 3 * u;
      panelH = headH + 11 * u + hints.length * lineH + footH + rowH + 7 * u;
      if (panelH <= m.h - 4 * u || size <= 1) break;
      size--;
    }
    const px = Math.round(cx - panelW / 2);
    const py = Math.max(2 * u, Math.round((m.h - panelH) / 2)) + panelSlide(enter, u, reduced);

    drawPanel(ctx, px, py, panelW, panelH, u, { frame: 'wood', alpha: 0.9 });
    drawText(ctx, 'Controls', cx, py + 4 * u, {
      font: 'display',
      size: headScale,
      color: 'gothic',
      align: 'center',
    });
    drawRule(ctx, cx, py + 4 * u + headH + 2 * u, Math.round(panelW * 0.3), u);

    const left = px + 7 * u;
    const right = px + panelW - 7 * u;
    let y = py + headH + 11 * u;
    for (let i = 0; i < hints.length; i++) {
      drawRow(ctx, hints[i].label, hints[i].keys, left, right, Math.round(y), size, 'hudGold', 'hud');
      y += lineH;
    }
    // One line for the other kind of device, at the smallest size on the panel — and only if it
    // fits: at one font pixel per UI pixel a 53-character sentence is twice the width of a phone's
    // panel, and a footer running off both edges of the screen is worse than no footer.
    const footSize = fitScale(footer, colW, { font: 'hud' }, Math.max(1, size - 1), 1);
    if (measureLine(footer, { font: 'hud', size: footSize }) <= colW) {
      drawText(ctx, footer, cx, Math.round(y + u), {
        font: 'hud',
        size: footSize,
        color: 'hudDim',
        align: 'center',
      });
    }
    y += footH;
    drawItemList(ctx, m, state, screen, Math.round(y + 2 * u), itemScale, rowH, reduced);
  }

  /**
   * The largest scale at which every hint's `label + gap + keys` fits the column.
   * @param {ReadonlyArray<ControlHint>} hints
   * @param {number} width
   * @param {number} maxScale
   * @returns {number}
   */
  function fitHintScale(hints, width, maxScale) {
    let scale = maxScale;
    for (let i = 0; i < hints.length; i++) {
      const fit = fitOneRowScale(hints[i].label, hints[i].keys, width, scale);
      if (fit < scale) scale = fit;
    }
    return Math.max(1, scale);
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
    const banner = bannerMemo(state.level, side);
    const bannerSize = fitScale(banner, m.w * 0.9, { font: 'hud' }, Math.max(1, u), 1);
    drawText(ctx, banner, cx, y + 8 * u, {
      font: 'hud',
      size: bannerSize,
      color: 'hudGold',
      align: 'center',
    });
    const cells = side * side;
    drawText(ctx, cellsMemo(cells), cx, y + 8 * u + textHeight({ font: 'hud', size: bannerSize }) + 2 * u, {
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
  /** @type {object|null} */
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
      statValues[statCount] = labyrinthMemo(maze.cols, maze.rows);
      statCount++;

      const total = maze.width * maze.height;
      if (state.explored !== null && state.explored !== undefined && total > 0) {
        if (statLevelRef !== level) {
          statExplored = countExplored(state.explored, total);
          statLevelRef = level;
        }
        statLabels[statCount] = 'EXPLORED';
        statValues[statCount] = exploredMemo(Math.round(clamp01(statExplored / total) * 100));
        statCount++;
      }
    }
    if (typeof run.refuels === 'number' && Number.isFinite(run.refuels) && statCount < statLabels.length) {
      statLabels[statCount] = 'REFUELS';
      statValues[statCount] = refuelsMemo(Math.floor(run.refuels));
      statCount++;
    }
    if (typeof run.distance === 'number' && Number.isFinite(run.distance) && statCount < statLabels.length) {
      statLabels[statCount] = 'WALKED';
      statValues[statCount] = walkedMemo(Math.round(run.distance));
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
    const pitch = statRowPitch(u, size);
    const perRow = statCount >= 3 ? 2 : statCount;
    const colW = Math.floor((right - left) / perRow);
    const rows = Math.ceil(statCount / perRow);
    for (let i = 0; i < statCount; i++) {
      const col = i % perRow;
      const row = (i / perRow) | 0;
      const x = left + col * colW;
      const ry = y + row * pitch;
      drawText(ctx, statLabels[i], x, ry, { font: 'hud', size, color: 'hudDim', alpha });
      // The value sits a clear 2u under its label: at u = 2 the old single unit made
      // LABYRINTH/16×16 read as one cramped block rather than as a label and a number.
      drawText(ctx, statValues[i], x, ry + lineH + 2 * u, {
        font: 'hud',
        size,
        color: 'hudBright',
        alpha,
      });
    }
    return rows * pitch;
  }

  /**
   * Vertical pitch of one stat row. **One** definition, used by the draw loop, by its return value
   * and by both callers' panel measurements — they disagreed by 2u before, which left the second
   * row sitting above its reserved slot and a stray gap under the strip.
   * @param {number} u
   * @param {number} size text scale
   * @returns {number}
   */
  function statRowPitch(u, size) {
    return textHeight({ font: 'hud', size }) * 2 + 4 * u;
  }

  /**
   * Height the expedition strip will occupy, including the rule above it.
   * @param {number} rows how many stat rows were filled
   * @param {number} u
   * @param {number} size text scale
   * @returns {number}
   */
  function statStripHeight(rows, u, size) {
    if (rows === 0) return 0;
    return (rows >= 3 ? 2 : 1) * statRowPitch(u, size) + 4 * u;
  }

  // ── Level complete ──

  /**
   * Tally scratch. Hoisted for the same reason `statLabels` is: these screens re-render every
   * frame, and the file's own rule (see "Layout scratch") is that a frame allocates nothing.
   * @type {number[]}
   */
  const tallyTargets = [0, 0, 0, 0];
  /** @type {string[]} */
  const tallyLabels = ['', '', '', ''];
  /** @type {string[]} */
  const tallyFinals = ['', '', '', ''];
  /** @type {string[]} */
  const endLabels = ['', '', ''];
  /** @type {string[]} */
  const endValues = ['', '', ''];
  /** One-element scratch for the single-row `fitRowScale` calls. @type {string[]} */
  const oneLabel = [''];
  /** @type {string[]} */
  const oneValue = [''];

  /**
   * The largest scale at which one label/value pair fits, without allocating a pair of arrays.
   * @param {string} label
   * @param {string} value
   * @param {number} width
   * @param {number} maxScale
   * @returns {number}
   */
  function fitOneRowScale(label, value, width, maxScale) {
    oneLabel[0] = label;
    oneValue[0] = value;
    return fitRowScale(oneLabel, oneValue, width, maxScale);
  }

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
    const targets = tallyTargets;
    targets[0] = run.gems * SCORE_RULES.GEM_BASE * level;
    targets[1] = fuelBonusOf(state);
    targets[2] = SCORE_RULES.CLEAR_BASE * level;
    targets[3] = run.score;
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

    const labels = tallyLabels;
    labels[0] = gemsRowMemo(run.gems, run.gemsTotal, level);
    labels[1] = torchRowMemo(Math.floor(run.fuel));
    labels[2] = 'DEPTH BONUS';
    labels[3] = 'TOTAL';
    // Measure against the *final* values so the column does not shift while the counters roll.
    const finals = tallyFinals;
    for (let i = 0; i < TALLY_ROWS; i++) finals[i] = tallyFinalMemos[i](Math.floor(targets[i]));

    const panelW = Math.min(m.w - 4 * u, Math.max(100 * u, m.w * 0.68));
    const headText = clearedMemo(level);
    const headScale = fitScale(headText, panelW * 0.86, { font: 'display' }, Math.max(2, u * 2), 1);
    const headH = textHeight({ font: 'display', size: headScale });
    const colW = panelW - 14 * u;
    // The expedition summary sits between the tally and the buttons: it is the record of the maze
    // you just walked, which at these sizes is a bigger story than the score.
    const statRows = buildRunStats(state);
    // The panel is *fitted*, exactly as the options panel is (see `drawOptions`): computing a
    // height once and centring it lets an oversized panel run off the bottom of the surface, which
    // is what cut this frame off at 1280×720 (m.h = 360 against a 362-pixel panel). Shrink the
    // rows first, then give up the expedition strip, then the buttons — in that order, because
    // that is the order of what the screen is for.
    let rowScale = fitRowScale(labels, finals, colW, u);
    let itemScale = fitScale('Quit to Title', panelW * 0.7, { font: 'display' }, scaleCap(m, 150), 1);
    let statsShown = statRows > 0;
    let totalScale = 0;
    let lineH = 0;
    let rowH = 0;
    let statH = 0;
    let panelH = 0;
    for (;;) {
      totalScale = Math.min(rowScale + 1, fitOneRowScale(labels[3], finals[3], colW, u + 1));
      lineH = textHeight({ font: 'hud', size: totalScale }) + 4 * u;
      rowH = textHeight({ font: 'display', size: itemScale }) + 4 * u;
      statH = statsShown ? statStripHeight(statRows, u, rowScale) : 0;
      panelH =
        headH + 13 * u + lineH * TALLY_ROWS + 4 * u + statH + rowH * screen.items.length + 6 * u;
      if (panelH <= m.h - 4 * u) break;
      if (rowScale > 1) {
        rowScale--;
        continue;
      }
      if (statsShown) {
        statsShown = false;
        continue;
      }
      if (itemScale > 1) {
        itemScale--;
        continue;
      }
      break;
    }
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
        tallyShownMemos[i](tallyCounters[i].value),
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
      // The strip fades in with the last tally row rather than arriving with the panel, so the
      // eye finishes the score before it is offered the expedition numbers — and its divider fades
      // with it, instead of hanging across an empty panel while the first rows are still due.
      const statAlpha = tallyDone ? 1 : clamp01((tallyT - TALLY_DELAY - TALLY_ROWS * TALLY_STAGGER) * 2);
      if (statAlpha > 0) {
        ctx.fillStyle = withAlpha(COLOR.stoneDark, 0.5 * statAlpha);
        ctx.fillRect(left, Math.round(y) - 2 * u, right - left, Math.max(1, u >> 1));
        drawStatStrip(ctx, left, right, Math.round(y + 2 * u), u, rowScale, statAlpha);
      }
      y += statH;
    }
    if (tallyDone) {
      drawItemList(ctx, m, state, screen, Math.round(y), itemScale, rowH, reduced);
    } else {
      // The whole panel is one hit target while the tally runs, so a click or a tap skips it —
      // `handlePointer` bails out early when no row was laid out, which used to make its own skip
      // branch unreachable and left a phone player being told to press a key it does not have.
      recordRow(0, px, py, panelW, panelH);
      rowEnabled[0] = true;
      rowCount = 1;
      drawPrompt(ctx, m, skipPrompt(), Math.round(y + rowH / 2), reduced);
    }
  }

  /**
   * What to tell the player to do to skip the tally, in the terms of the device they are holding:
   * the old copy named the Enter key to a phone, which has none.
   * @returns {string}
   */
  function skipPrompt() {
    return primaryPointerIsCoarse() ? 'TAP TO SKIP' : 'CLICK OR PRESS ENTER TO SKIP';
  }

  /**
   * Is the device's **primary** pointer a finger?
   *
   * WHY the media query and not `maxTouchPoints` / `'ontouchstart' in window`: those report touch
   * *capability*, which every touchscreen laptop — and headless desktop Chrome — has, so a player
   * sitting at a keyboard was told to tap. `(pointer: coarse)` describes the input the device is
   * actually driven with. Anything unavailable (Node, an old browser) reads as a desktop.
   * @returns {boolean}
   */
  function primaryPointerIsCoarse() {
    if (coarsePointer === -1) coarsePointer = queryCoarsePointer() ? 1 : 0;
    return coarsePointer === 1;
  }

  /** Cached answer of {@link queryCoarsePointer}: −1 not asked yet, 0 no, 1 yes. */
  let coarsePointer = -1;

  /**
   * The media query behind {@link primaryPointerIsCoarse}, asked once.
   * @returns {boolean}
   */
  function queryCoarsePointer() {
    try {
      const mm = /** @type {any} */ (globalThis).matchMedia;
      return typeof mm === 'function' && mm.call(globalThis, '(pointer: coarse)').matches === true;
    } catch (err) {
      return false;
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
    const labels = endLabels;
    labels[0] = 'SCORE';
    labels[1] = 'DEPTH REACHED';
    labels[2] = newBest ? NEW_BEST_TEXT : 'BEST';
    const values = endValues;
    values[0] = scoreMemo(Math.floor(run.score));
    values[1] = levelMemo(state.level);
    // A new record *is* the score printed directly above it, so the row carries no number: it is
    // one centred line of celebration rather than the same six digits twice.
    values[2] = newBest ? '' : bestScoreMemo(Math.floor(best.score));

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
    const statRows = buildRunStats(state);
    // Fitted, for the reason spelled out in `drawComplete`: a panel measured once and centred runs
    // off a short surface instead of shrinking to it.
    let rowScale = fitRowScale(labels, values, colW, u);
    let itemScale = fitScale('Try Again', panelW * 0.6, { font: 'display' }, scaleCap(m, 150), 1);
    let statsShown = statRows > 0;
    let scoreScale = 0;
    let bestScale = 0;
    let scoreH = 0;
    let depthH = 0;
    let bestH = 0;
    let rowH = 0;
    let statH = 0;
    let panelH = 0;
    for (;;) {
      scoreScale = Math.min(rowScale + 1, fitOneRowScale(labels[0], values[0], colW, u + 1));
      // The record line is drawn at the score's size whenever it fits the column there — on a
      // phone as well, now that it no longer has to share the line with a number.
      bestScale = newBest ? fitScale(NEW_BEST_TEXT, colW, { font: 'hud' }, scoreScale, 1) : rowScale;
      // Each row is spaced for its own size: one pitch for all three left a small DEPTH REACHED
      // floating in a gap measured for the score's double-height digits.
      scoreH = textHeight({ font: 'hud', size: scoreScale }) + 4 * u;
      depthH = textHeight({ font: 'hud', size: rowScale }) + 4 * u;
      bestH = textHeight({ font: 'hud', size: bestScale }) + 4 * u;
      rowH = textHeight({ font: 'display', size: itemScale }) + 4 * u;
      statH = statsShown ? statStripHeight(statRows, u, rowScale) : 0;
      panelH = headH + 14 * u + scoreH + depthH + bestH + 2 * u + statH + rowH * screen.items.length + 6 * u;
      if (panelH <= m.h - 4 * u) break;
      if (rowScale > 1) {
        rowScale--;
        continue;
      }
      if (statsShown) {
        statsShown = false;
        continue;
      }
      if (itemScale > 1) {
        itemScale--;
        continue;
      }
      break;
    }
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
    y += scoreH;
    drawRow(ctx, labels[1], values[1], left, right, Math.round(y), rowScale, 'hudDim', 'hudGold');
    y += depthH;
    if (newBest) {
      // A new record is celebrated; an old one is stated quietly. The celebration is carried by
      // **weight** — the score's size, gold, centred on the panel — and the pulse only breathes
      // across the top fifth of the alpha range: dropping to 40 % made the one line the screen
      // exists to celebrate read as a *disabled* row next to a fully opaque "DEPTH REACHED".
      const flash = reduced ? 1 : 0.82 + 0.18 * (0.5 + 0.5 * Math.sin(clock * 7));
      drawText(ctx, NEW_BEST_TEXT, cx, Math.round(y), {
        font: 'hud',
        size: bestScale,
        color: 'hudGold',
        align: 'center',
        alpha: flash,
      });
    } else {
      drawRow(ctx, labels[2], values[2], left, right, Math.round(y), bestScale, 'hudDim', 'hudGold');
    }
    y += bestH + 2 * u;

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
