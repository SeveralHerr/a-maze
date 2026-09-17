// @ts-check
/**
 * @file The labyrinth map: a three-state view (OFF → CORNER → FULL) over the fog-of-war grid,
 * and the incremental rasteriser that makes it free to draw at any maze size.
 *
 * ## Why this module exists
 * A-MAZE's mazes are now **massive**: 16×16 cells on depth 1 growing to 128×128 cells (257×257
 * tiles, ~66 000 of them, ~16 000 cells) at the cap. The old HUD minimap drew one pixel per tile
 * into a corner box, rebuilt the whole raster whenever the explored count changed, and counted the
 * explored set — a full 66 k scan — *every frame*. At the new sizes that is ~0.4 ms of pure
 * bookkeeping per frame for a map that would be 257 px across in a 360 px tall overlay: unreadable
 * and unaffordable at the same time. So the map is now three things, each with its own job:
 *
 * | Mode     | What it answers                                | Resolution                       |
 * |----------|------------------------------------------------|----------------------------------|
 * | `off`    | nothing — the screen is the game               | —                                |
 * | `corner` | "what is around me right now?"                 | a ~25×25 **tile** window, zoomed |
 * | `full`   | "where have I been, where is the exit?"        | the whole labyrinth, fitted      |
 *
 * ## How it stays cheap (the load-bearing part)
 * One offscreen canvas holds the tile raster (one pixel per tile, explored tiles only). It is
 * **never rebuilt wholesale** during play:
 *
 * 1. `src/state/sim.js` only ever reveals tiles within `REVEAL_RADIUS` (3) of the player, so each
 *    frame we rescan a small box around the player — grown by however far the player moved since
 *    the last update, so a slow frame cannot outrun it.
 * 2. A **rolling sweep** of `SWEEP_BUDGET` tile indices per frame walks the whole grid on a cycle
 *    (66 k tiles → ~16 frames), which catches anything a contract change upstream might reveal
 *    outside that box. In normal play it finds nothing and costs one array read per tile.
 * 3. The raster itself is the dirty-state: a tile is drawn iff its pixel is non-zero, so no shadow
 *    copy of "what have I already painted" is needed, and `exploredCount` is maintained as an
 *    increment instead of a scan.
 * 4. Only the union of the touched pixels is pushed to the canvas, via the dirty-rectangle form of
 *    `putImageData`.
 *
 * Items are **baked into the raster** rather than drawn per frame: with hundreds of flasks and
 * gems per level, anything O(items) per frame is exactly what this wave forbids. A taken item is
 * noticed by a low-frequency prune (twice a second) that repaints its one pixel.
 *
 * ## Full-map resolution
 * ARCHITECTURE's brief for the full map is "one pixel per **cell**", which for 128×128 cells is a
 * 128 px square — comfortable anywhere. But at cell resolution the walls are thinner than a pixel,
 * so the labyrinth degrades to a silhouette of where you have been. Tile resolution (2 px per
 * cell, the raster we already maintain) shows the real corridors, and it *fits* on a desktop
 * overlay even at the 128-cell cap. So the scale adapts: {@link chooseFullScale} takes tile
 * resolution whenever one whole pixel per tile fits the box, and falls back to cell resolution
 * otherwise (only a very large maze on a phone). Both are pixel-exact integer scales.
 *
 * ## Mode storage
 * The chosen mode is a single UI-wide preference, shadowing `settings.minimap`. See
 * {@link readMapMode} for the compatibility rules — this module works whether `src/state` keeps
 * `minimap` as a boolean or adopts a `mapMode` string.
 */

import { clamp, clamp01 } from '../core/math.js';
import { createLogger } from '../core/log.js';
import { COLOR, drawAt, heightAt, measureAt } from './font.js';
import {
  createTextMemo,
  formatClock,
  formatCount,
  formatDistance,
  formatPercent,
  formatLabyrinth,
} from './format.js';
import {
  ARROWS,
  ARROW_PALETTE,
  drawArt,
  drawGemIcon,
  drawOilIcon,
  drawPanel,
  drawPortalIcon,
  fillDisc,
  fillRing,
  hexToRgb,
  ICON_SIZE,
  withAlpha,
  withAlphaStep,
} from './pixels.js';

/** @typedef {import('../core/types.js').GameState} GameState */
/** @typedef {import('../core/types.js').Maze} Maze */
/** @typedef {import('../core/types.js').Item} Item */
/** @typedef {import('../core/types.js').Settings} Settings */
/** @typedef {import('./pixels.js').Art} Art */

const log = createLogger('ui/map');

/** 45°, the player arrow's heading step. */
const QUARTER_TURN = Math.PI / 4;

/** The legend's name for the player marker. */
const YOU_LABEL = 'YOU';

/** Heading the legend's player swatch points in: north (index 6 of `ARROWS`, which starts east). */
const YOU_OCTANT = 6;

/** The player arrow's blink tone: the outline and body swapped (see `drawPlayerArrow`). */
const ARROW_PALETTE_INVERTED = Object.freeze([null, COLOR.fireCore, COLOR.void]);

// ─── Mode ────────────────────────────────────────────────────────────────────────────────────

/**
 * The three map states, in cycle order. The `map` action (M / Tab / the touch MAP button) steps
 * through this list.
 * @type {ReadonlyArray<'off'|'corner'|'full'>}
 */
export const MAP_MODES = Object.freeze(/** @type {const} */ (['off', 'corner', 'full']));

/** @typedef {'off'|'corner'|'full'} MapMode */

/** Human labels for the options screen. */
export const MAP_MODE_LABEL = Object.freeze({ off: 'Off', corner: 'Corner', full: 'Full' });

/**
 * Coerce anything to a legal mode.
 * @param {unknown} value
 * @returns {MapMode|null} null when it is not one of the three modes
 */
export function normalizeMapMode(value) {
  return value === 'off' || value === 'corner' || value === 'full' ? value : null;
}

/**
 * The mode after this one in the cycle.
 * @param {unknown} mode current mode (anything illegal behaves like `'off'`)
 * @returns {MapMode}
 */
export function nextMapMode(mode) {
  const m = normalizeMapMode(mode);
  if (m === 'off') return 'corner';
  if (m === 'corner') return 'full';
  if (m === 'full') return 'off';
  return 'corner';
}

/**
 * The part of `Settings` the map reads. Deliberately loose: the settings object may come from a
 * state module that predates `mapMode`, or from persisted storage, and every reader here treats
 * both fields as untrusted.
 * @typedef {{mapMode?:unknown, minimap?:unknown}} MapSettings
 */

/**
 * What the *settings* say the mode is, ignoring any local choice.
 *
 * `settings.mapMode` wins when `src/state` carries it. Otherwise the legacy boolean
 * `settings.minimap` maps to off/corner, which is what every build before this wave stored.
 * @param {MapSettings|null|undefined} settings
 * @returns {MapMode}
 */
export function mapModeFromSettings(settings) {
  if (settings === null || settings === undefined) return 'corner';
  const explicit = normalizeMapMode(/** @type {any} */ (settings).mapMode);
  if (explicit !== null) return explicit;
  return /** @type {any} */ (settings).minimap === false ? 'off' : 'corner';
}

/**
 * The live UI-wide mode, and the settings-derived mode it was last reconciled against.
 *
 * WHY a module-level value rather than per-HUD instance state: the HUD draws the map, the options
 * screen edits it and `src/main.js` cycles it from the `map` hotkey — three call sites that must
 * agree, exactly like the settings field this shadows. There is one overlay per page.
 * @type {MapMode}
 */
let localMode = 'corner';
/** @type {MapMode} */
let lastSettingsMode = 'corner';
let localModeArmed = false;

/**
 * The mode to draw right now.
 *
 * Reconciliation rule: a **change** in what the settings say wins (the player edited the option,
 * or a fresh run loaded a persisted preference); otherwise the local choice stands. That is what
 * makes the three-state cycle work even while `src/state` still stores only a boolean: cycling
 * `corner → full` writes `minimap: true`, the settings-derived mode does not change, and the local
 * `full` survives. See ARCHITECTURE.md §4.6 / the contract note in this wave's report.
 *
 * @param {MapSettings|null|undefined} settings
 * @returns {MapMode}
 */
export function readMapMode(settings) {
  const derived = mapModeFromSettings(settings);
  if (!localModeArmed) {
    localMode = derived;
    lastSettingsMode = derived;
    localModeArmed = true;
    return localMode;
  }
  if (derived !== lastSettingsMode) {
    lastSettingsMode = derived;
    localMode = derived;
  }
  return localMode;
}

/**
 * Force the mode (the options screen, and tests).
 * @param {unknown} mode
 * @returns {MapMode} the mode now in force
 */
export function setMapMode(mode) {
  const m = normalizeMapMode(mode);
  if (m !== null) {
    localMode = m;
    localModeArmed = true;
  }
  return localMode;
}

/**
 * Advance the cycle. The caller (main.js / the options screen) should then persist it with
 * `setSetting('mapMode', mode)` **and** `setSetting('minimap', mode !== 'off')`, so the preference
 * survives whichever shape `src/state` stores.
 * @param {MapSettings|null|undefined} settings
 * @returns {MapMode} the new mode
 */
export function cycleMapMode(settings) {
  return setMapMode(nextMapMode(readMapMode(settings)));
}

/**
 * Reset the module-level mode (tests, and `hud.reset()` on a brand-new run).
 * @returns {void}
 */
export function resetMapMode() {
  localMode = 'corner';
  lastSettingsMode = 'corner';
  localModeArmed = false;
}

// ─── Tuning ──────────────────────────────────────────────────────────────────────────────────

/**
 * Map tuning. Every number here is a measured trade-off rather than a taste call; the comments
 * say against what.
 * @type {Readonly<Record<string, number>>}
 */
export const MAP = Object.freeze({
  /** Tiles across the corner window on a roomy surface. 25 ≈ four corridors each way. */
  CORNER_TILES: 25,
  /** Tiles across it on a narrow (phone) surface, where the box is physically smaller. */
  CORNER_TILES_NARROW: 19,
  /** Minimum UI pixels per tile in the corner window — below 2 the walls stop reading. */
  CORNER_MIN_ZOOM: 2,
  /** Maximum, so the window does not become a magnifying glass on a 4 K display. */
  CORNER_MAX_ZOOM: 6,
  /**
   * Tile indices the rolling reconciliation sweep visits per update. 4096 covers a 257×257 grid
   * in 17 frames (0.28 s) and costs ~4 k array reads — under 10 µs, measured.
   */
  SWEEP_BUDGET: 4096,
  /**
   * The widest reveal radius the sim can use, mirrored: the local box must cover it. That is the
   * Cartographer unlock's top rank (`UNLOCK_FX.cartographer`, 5), not the base `WORLD.REVEAL_RADIUS`
   * (3) — a box sized for the base radius would leave a maxed Cartographer's outer ring to the
   * rolling sweep, a visible lag at the edge of what the player just saw (§4.9).
   */
  REVEAL_RADIUS: 5,
  /** Extra tiles of slack on the local box, for rounding and for a pickup flash. */
  BOX_SLACK: 2,
  /** Seconds between item-liveness prunes. Twice a second is imperceptible and O(live items). */
  PRUNE_INTERVAL: 0.5,
  /**
   * Seconds of not being updated after which the next update does a full rescan instead of a box
   * scan. Covers the map being switched off for a while, a tab switch, or a teleport.
   */
  STALE_AFTER: 0.4,
  /**
   * Side margin of the full map, in **device** pixels. The full map is fitted on the device grid
   * (see `drawFull`), so its margin is too. Paid in UI pixels it cost `3u × m.px` a side — 30 device
   * pixels on a 412×915 phone at dpr 2.625, which was the difference between 3 and 4 device pixels
   * per tile across the 257-tile cap (771 vs 1 028 px, 71 % vs 95 % of the screen width).
   */
  MARGIN_DEV: 6,
});

/** Shorthand for `MAP.MARGIN_DEV`, used on the full map's hot path. */
const MAP_MARGIN_DEV = MAP.MARGIN_DEV;

/** Side margin of a frameless (narrow) full map, in device pixels: a hairline's worth. */
const BARE_MARGIN_DEV = 2;

/** Between the two halves of the strips header, when they sit close enough to run together. */
const HEAD_SEPARATOR = '·';

/**
 * Borders `drawPanel` paints: the outer edge and the bevelled frame body. Mirrored from `hud.js`
 * (which is *above* this module in the import graph — `font/format/core → pixels → map → hud`), so
 * a map window's contents can be inset clear of its own frame the way every HUD readout is.
 */
const FRAME_BORDERS = 2;

// ─── Raster colours ──────────────────────────────────────────────────────────────────────────

/**
 * Packed little-endian-agnostic RGBA for the raster. Index order must match {@link PAINT}.
 * @type {Uint32Array}
 */
const PACKED = new Uint32Array(8);

/** Symbolic indices into {@link PACKED}. */
const PAINT = Object.freeze({
  WALL: 0,
  FLOOR: 1,
  GEM: 2,
  OIL: 3,
  EXIT: 4,
  PATH: 5,
});

/**
 * Colours the raster is painted in. Deliberately *not* the world palette: a map is a diagram, so
 * the floor has to be the bright shape and the wall the ground, which is the opposite of how the
 * 3-D view reads.
 */
const RASTER_COLORS = Object.freeze([
  { hex: '#151b26', a: 240 }, // WALL  — near-black cool stone: at one pixel per tile the map is
  //                                   mostly wall, so the contrast against the floor has to be
  //                                   brutal or the whole thing reads as noise
  { hex: '#6e6455', a: 240 }, // FLOOR — warm cobble, the corridors you can walk
  { hex: COLOR.gemBright, a: 255 }, // GEM
  { hex: COLOR.oilLight, a: 255 }, // OIL
  { hex: COLOR.arcPale, a: 255 }, // EXIT
  // There is deliberately no START colour. It was gold (#e8c24a), and at 1–4 device pixels a tile
  // that is indistinguishable from an oil flask (#f0b040) — a gold square the legend could not
  // explain, which read as a flask at the entrance. The player marker says where you are; where you
  // came in is not a question the map needs to answer.
  { hex: '#8d8170', a: 240 }, // PATH — a floor tile you have actually stood on (unused reserve)
]);

(() => {
  // Pack once. A Uint32Array view over a Uint8 buffer is byte-order dependent, so the byte order
  // is measured rather than assumed — a big-endian host would otherwise get its channels mirrored.
  const probe = new Uint8Array(4);
  new Uint32Array(probe.buffer)[0] = 0x0a0b0c0d;
  const littleEndian = probe[0] === 0x0d;
  const rgb = new Uint8Array(3);
  for (let i = 0; i < RASTER_COLORS.length; i++) {
    hexToRgb(RASTER_COLORS[i].hex, rgb);
    const a = RASTER_COLORS[i].a;
    PACKED[i] = littleEndian
      ? (a << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]
      : ((rgb[0] << 24) | (rgb[1] << 16) | (rgb[2] << 8) | a) >>> 0;
    PACKED[i] >>>= 0;
  }
})();

/** Item layer codes. */
const ITEM_NONE = 0;
const ITEM_GEM = 1;
const ITEM_OIL = 2;

// ─── Pure raster maths (unit-tested) ─────────────────────────────────────────────────────────

/**
 * Paint every *newly explored* tile in a box into the raster.
 *
 * "Newly explored" is `explored[i] !== 0 && out32[i] === 0`: the raster is its own dirty-state, so
 * no second buffer is needed and the pass is idempotent. Pure and DOM-free, which is why it can be
 * tested in Node against a plain `Uint32Array`.
 *
 * @param {Uint32Array} out32 raster, `mw*mh` pixels, index = ty*mw+tx
 * @param {number} mw raster width in tiles
 * @param {number} mh raster height in tiles
 * @param {number} x0 inclusive left of the box (clamped internally)
 * @param {number} y0 inclusive top
 * @param {number} x1 inclusive right
 * @param {number} y1 inclusive bottom
 * @param {Uint8Array} tiles the maze tiles (0 = floor)
 * @param {Uint8Array} explored the fog-of-war grid
 * @param {Uint8Array|null} itemLayer per-tile item code, or null for none
 * @param {number} exitIdx tile index of the exit (−1 for none)
 * @param {Int32Array} bounds length ≥ 4, in/out dirty rect `[x0,y0,x1,y1]`; an empty rect is
 *   `[mw, mh, -1, -1]` and is expanded in place
 * @returns {number} how many pixels were painted
 */
export function paintTiles(
  out32,
  mw,
  mh,
  x0,
  y0,
  x1,
  y1,
  tiles,
  explored,
  itemLayer,
  exitIdx,
  bounds,
) {
  const lx = x0 < 0 ? 0 : x0;
  const ly = y0 < 0 ? 0 : y0;
  const hx = x1 >= mw ? mw - 1 : x1;
  const hy = y1 >= mh ? mh - 1 : y1;
  if (lx > hx || ly > hy) return 0;
  let painted = 0;
  for (let ty = ly; ty <= hy; ty++) {
    const row = ty * mw;
    for (let tx = lx; tx <= hx; tx++) {
      const idx = row + tx;
      if (explored[idx] === 0 || out32[idx] !== 0) continue;
      out32[idx] = colorFor(idx, tiles, itemLayer, exitIdx);
      painted++;
      if (tx < bounds[0]) bounds[0] = tx;
      if (ty < bounds[1]) bounds[1] = ty;
      if (tx > bounds[2]) bounds[2] = tx;
      if (ty > bounds[3]) bounds[3] = ty;
    }
  }
  return painted;
}

/**
 * The packed colour one explored tile should have.
 * @param {number} idx tile index
 * @param {Uint8Array} tiles
 * @param {Uint8Array|null} itemLayer
 * @param {number} exitIdx
 * @returns {number} packed RGBA (never 0, so it doubles as "painted")
 */
function colorFor(idx, tiles, itemLayer, exitIdx) {
  if (idx === exitIdx) return PACKED[PAINT.EXIT];
  if (tiles[idx] !== 0) return PACKED[PAINT.WALL];
  if (itemLayer !== null) {
    const it = itemLayer[idx];
    if (it === ITEM_GEM) return PACKED[PAINT.GEM];
    if (it === ITEM_OIL) return PACKED[PAINT.OIL];
  }
  return PACKED[PAINT.FLOOR];
}

/**
 * Count the explored tiles. O(n) — call it on a screen transition, never per frame (the map view
 * maintains the same number incrementally while it is open).
 * @param {Uint8Array|null|undefined} explored
 * @param {number} [limit] only consider the first `limit` entries (the maze may be smaller than
 *   the buffer); defaults to the whole buffer
 * @returns {number}
 */
export function countExplored(explored, limit) {
  if (explored === null || explored === undefined) return 0;
  const n = limit === undefined ? explored.length : Math.min(limit, explored.length);
  let seen = 0;
  for (let i = 0; i < n; i++) seen += explored[i] !== 0 ? 1 : 0;
  return seen;
}

/**
 * Pick the resolution and integer scale for the full-screen map.
 *
 * Prefers **tile** resolution (walls are real pixels, the map reads as a labyrinth) and falls back
 * to **cell** resolution (one pixel per maze cell: the explored silhouette, walls sub-pixel) only
 * when a whole pixel per tile will not fit the box. See the file header for why.
 *
 * @param {number} cols maze cells across
 * @param {number} rows maze cells down
 * @param {number} boxW available width, in the units the caller draws in (the full map passes
 *   **device** pixels — see `drawFull`)
 * @param {number} boxH available height, same units
 * @param {FullFit} [out] filled in place and returned when given — the full map compares two
 *   candidate layouts every frame and must not allocate to do it
 * @returns {FullFit} `scale` is target pixels per raster pixel (an integer ≥ 1); `w`/`h` are the
 *   drawn size in the same units as `boxW`/`boxH`
 */
export function chooseFullScale(cols, rows, boxW, boxH, out) {
  const fit = out === undefined ? { res: /** @type {'tile'|'cell'} */ ('tile'), scale: 0, w: 0, h: 0 } : out;
  const c = Math.max(1, Math.floor(cols));
  const r = Math.max(1, Math.floor(rows));
  const tw = c * 2 + 1;
  const th = r * 2 + 1;
  const tileScale = Math.min(Math.floor(boxW / tw), Math.floor(boxH / th));
  if (tileScale >= 1) {
    fit.res = 'tile';
    fit.scale = tileScale;
    fit.w = tw * tileScale;
    fit.h = th * tileScale;
    return fit;
  }
  const cellScale = Math.max(1, Math.min(Math.floor(boxW / c), Math.floor(boxH / r)));
  fit.res = 'cell';
  fit.scale = cellScale;
  fit.w = c * cellScale;
  fit.h = r * cellScale;
  return fit;
}

/**
 * Does fit `a` draw a better full map than fit `b`? Tile resolution beats cell resolution (walls
 * are the point of the map), then the larger drawn area wins, and a tie goes to `a`.
 * @param {FullFit} a
 * @param {FullFit} b
 * @returns {boolean}
 */
export function fitBeats(a, b) {
  if (a.res !== b.res) return a.res === 'tile';
  return a.w * a.h >= b.w * b.h;
}

/**
 * One way of fitting the maze into a box.
 * @typedef {{res:'tile'|'cell', scale:number, w:number, h:number}} FullFit
 */

/**
 * The tile window the corner map shows, clamped so it never scrolls past the edges of a small
 * maze (a 33×33 level-1 maze would otherwise sit in the corner of a mostly-empty box).
 *
 * @param {number} px player tile x
 * @param {number} py player tile y
 * @param {number} span tiles across the window
 * @param {number} mw raster width
 * @param {number} mh raster height
 * @param {Int32Array} out length ≥ 2; receives the window's top-left tile
 * @param {number} [pad] tiles of ground the window may show **beyond** the raster's edge. The start
 *   tile is (1, 1) and the exit is usually on the far edge, so a window clamped hard to the raster
 *   drew the player's arrow half outside its own frame; one or two tiles of slack keeps a marker on
 *   a border tile fully inside the window. Defaults to 0 (the exact clamp the tests pin).
 * @returns {void}
 */
export function cornerWindow(px, py, span, mw, mh, out, pad) {
  const half = (span - 1) / 2;
  const slack = pad === undefined || !(pad > 0) ? 0 : Math.floor(pad);
  let x = Math.round(px - half);
  let y = Math.round(py - half);
  // A maze narrower than the window is centred rather than pinned to 0.
  x = mw <= span ? Math.floor((mw - span) / 2) : clamp(x, -slack, mw - span + slack);
  y = mh <= span ? Math.floor((mh - span) / 2) : clamp(y, -slack, mh - span + slack);
  out[0] = x;
  out[1] = y;
}

// ─── The view ────────────────────────────────────────────────────────────────────────────────

/**
 * Per-frame cost accounting, surfaced by `?debug=1` and by the verification tools.
 * @typedef {Object} MapStats
 * @property {number} updateMs   raster maintenance cost, sampled one frame in 32
 * @property {number} drawMs     draw cost, sampled one frame in 32
 * @property {number} painted    pixels painted by the last update
 * @property {number} scanned    tile indices read by the last update
 * @property {number} flushes    dirty-rect uploads in the last update (0 or 1)
 * @property {number} explored   tiles currently explored
 * @property {number} tiles      tiles in the level
 * @property {number} rebuilds   full rescans since the last reset
 */

/**
 * @typedef {Object} MapView
 * @property {(state:GameState, clock:number) => void} update  maintain the raster; call once per
 *   frame while the map is visible, before drawing
 * @property {(ctx:CanvasRenderingContext2D, m:any, state:GameState, clock:number, reduced:boolean) => number}
 *   drawCorner  draw the corner window; returns its height in UI pixels (0 if it drew nothing)
 * @property {(ctx:CanvasRenderingContext2D, m:any, state:GameState, clock:number, reduced:boolean, gaugeRight?:number, gaugeBottom?:number) => void}
 *   drawFull  draw the full-screen labyrinth map, laying its text out clear of the fuel gauge box
 *   the HUD keeps on screen over it (right and bottom edges, UI pixels)
 * @property {() => number} exploredCount  explored tiles, maintained incrementally
 * @property {() => MapStats} stats  live, reused object — never retain a copy
 * @property {() => void} invalidate  make the next `update` one exact full rescan (O(tiles), once)
 *   instead of the incremental box — the HUD calls it when a hidden map becomes visible again, so
 *   whatever was explored while it was hidden appears on that very frame (§4.8)
 * @property {() => void} reset
 * @property {() => void} dispose
 */

/**
 * Create the map view.
 *
 * @param {{createCanvas?:(w:number,h:number)=>HTMLCanvasElement|null, now?:()=>number}} [options]
 *   injectables for tests and for headless tools; both default to the browser's.
 * @returns {MapView}
 */
export function createMapView(options) {
  const makeCanvas =
    options !== undefined && typeof options.createCanvas === 'function'
      ? options.createCanvas
      : defaultCreateCanvas;
  const now =
    options !== undefined && typeof options.now === 'function'
      ? options.now
      : typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? () => performance.now()
        : () => Date.now();

  // ── Tile raster (one pixel per tile, incrementally maintained) ──
  /** @type {HTMLCanvasElement|null} */
  let tileCanvas = null;
  /** @type {CanvasRenderingContext2D|null} */
  let tileCtx = null;
  /** @type {ImageData|null} */
  let tileImg = null;
  /** @type {Uint32Array|null} */
  let tile32 = null;
  let mw = 0;
  let mh = 0;

  // ── Cell raster (one pixel per cell; rebuilt on demand, only for the full map) ──
  /** @type {HTMLCanvasElement|null} */
  let cellCanvas = null;
  /** @type {CanvasRenderingContext2D|null} */
  let cellCtx = null;
  /** @type {ImageData|null} */
  let cellImg = null;
  /** @type {Uint32Array|null} */
  let cell32 = null;
  let cellCols = 0;
  let cellRows = 0;
  let cellStamp = -1;

  // ── Level bookkeeping ──
  /** @type {object|null} */
  let levelRef = null;
  /** @type {Uint8Array|null} */
  let itemLayer = null;
  /** @type {Int32Array} */
  let liveIdx = new Int32Array(0);
  /** @type {Item[]} */
  let liveItems = [];
  let liveCount = 0;
  let exitIdx = -1;

  let explored = 0;
  let sweepCursor = 0;
  let lastPlayerX = 0;
  let lastPlayerY = 0;
  let lastUpdate = -1;
  let lastPrune = -1;
  let needsFullScan = true;

  /** Dirty rect of the raster, `[x0,y0,x1,y1]`; empty when `[mw,mh,-1,-1]`. */
  const dirty = new Int32Array(4);
  /** Scratch for {@link cornerWindow}. */
  const win = new Int32Array(2);

  /** Frame counter for the sampled cost timings; see `update`. */
  let timingTick = 0;
  /** Whether this frame's update and draw are timed. */
  let timing = true;

  /** @type {MapStats} */
  const stats = {
    updateMs: 0,
    drawMs: 0,
    painted: 0,
    scanned: 0,
    flushes: 0,
    explored: 0,
    tiles: 0,
    rebuilds: 0,
  };

  /**
   * @param {number} w
   * @param {number} h
   * @returns {HTMLCanvasElement|null}
   */
  function defaultCreateCanvas(w, h) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    try {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    } catch (err) {
      log.error('map canvas unavailable', err);
      return null;
    }
  }

  /**
   * @returns {void}
   */
  function clearDirty() {
    dirty[0] = mw;
    dirty[1] = mh;
    dirty[2] = -1;
    dirty[3] = -1;
  }

  /**
   * Point the view at a level, allocating the raster and the item index.
   *
   * Everything that is O(maze) or O(items) happens here — once per level, never per frame.
   * @param {object} level the `LevelData`
   * @param {Maze} maze
   * @returns {boolean} false when no raster could be created (no DOM)
   */
  function adoptLevel(level, maze) {
    // Ask the device question again per level: a hybrid device may have gained or lost a mouse.
    closeHintText = '';
    const w = maze.width;
    const h = maze.height;
    if (!(w > 0) || !(h > 0)) return false;

    if (tileCanvas === null || mw !== w || mh !== h) {
      const c = makeCanvas(w, h);
      if (c === null) return false;
      c.width = w;
      c.height = h;
      let context = null;
      try {
        context = c.getContext('2d');
      } catch (err) {
        log.error('map 2d context unavailable', err);
        return false;
      }
      if (context === null) return false;
      tileCanvas = c;
      tileCtx = context;
      tileImg = context.createImageData(w, h);
      tile32 = new Uint32Array(tileImg.data.buffer);
      mw = w;
      mh = h;
      // The cell raster is per-level too; drop it so it is rebuilt at the new size.
      cellCanvas = null;
      cellCtx = null;
      cellImg = null;
      cell32 = null;
      cellCols = 0;
      cellRows = 0;
    } else if (tile32 !== null) {
      tile32.fill(0);
    }

    levelRef = level;
    exitIdx = maze.exit.y * w + maze.exit.x;
    explored = 0;
    sweepCursor = 0;
    cellStamp = -1;
    needsFullScan = true;
    stats.tiles = w * h;
    buildItemIndex(/** @type {any} */ (level).items, w, h);
    clearDirty();
    return true;
  }

  /**
   * Build the per-tile item layer and the live-item list.
   * @param {Item[]|undefined} items
   * @param {number} w
   * @param {number} h
   * @returns {void}
   */
  function buildItemIndex(items, w, h) {
    const n = w * h;
    if (itemLayer === null || itemLayer.length < n) itemLayer = new Uint8Array(n);
    else itemLayer.fill(0, 0, n);
    liveCount = 0;
    if (!Array.isArray(items)) return;
    if (liveIdx.length < items.length) liveIdx = new Int32Array(items.length);
    liveItems.length = items.length;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it === null || it === undefined || it.taken === true) continue;
      // Only gems and flasks are charted. The map scroll (§4.8) is deliberately absent — a map that
      // marked where the map is would defeat the hunt, and it is taken before the map can be read
      // anyway — and any kind this module does not know is skipped rather than drawn as a gem.
      const kind = it.kind === 'oil' ? ITEM_OIL : it.kind === 'gem' ? ITEM_GEM : ITEM_NONE;
      if (kind === ITEM_NONE) continue;
      const tx = Math.floor(it.x);
      const ty = Math.floor(it.y);
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const idx = ty * w + tx;
      itemLayer[idx] = kind;
      liveIdx[liveCount] = idx;
      liveItems[liveCount] = it;
      liveCount++;
    }
    liveItems.length = liveCount;
  }

  /**
   * Drop taken items from the layer and repaint their pixels.
   *
   * O(live items), run twice a second — not per frame, and never per item per frame. Each item is
   * removed exactly once over a level, so the amortised cost is nothing.
   * @param {Uint8Array} tiles
   * @returns {void}
   */
  function pruneItems(tiles) {
    if (itemLayer === null || tile32 === null) return;
    let write = 0;
    for (let i = 0; i < liveCount; i++) {
      const it = liveItems[i];
      const idx = liveIdx[i];
      if (it !== undefined && it !== null && it.taken !== true) {
        if (write !== i) {
          liveIdx[write] = idx;
          liveItems[write] = it;
        }
        write++;
        continue;
      }
      // Taken: the tile goes back to being ordinary floor. Repaint in place rather than clearing,
      // so `tile32[idx] !== 0` stays exactly equivalent to "counted as explored".
      itemLayer[idx] = ITEM_NONE;
      if (tile32[idx] !== 0) {
        tile32[idx] = colorFor(idx, tiles, itemLayer, exitIdx);
        markDirty(idx % mw, (idx / mw) | 0);
      }
    }
    liveCount = write;
    liveItems.length = write;
  }

  /**
   * @param {number} tx
   * @param {number} ty
   * @returns {void}
   */
  function markDirty(tx, ty) {
    if (tx < dirty[0]) dirty[0] = tx;
    if (ty < dirty[1]) dirty[1] = ty;
    if (tx > dirty[2]) dirty[2] = tx;
    if (ty > dirty[3]) dirty[3] = ty;
  }

  /**
   * Maintain the raster. Safe to call with any state; it simply does nothing when there is no
   * level, no explored grid or no canvas.
   * @param {GameState} state
   * @param {number} clock seconds (the HUD's smoothed sim clock)
   * @returns {void}
   */
  function update(state, clock) {
    // One frame in 32 is timed: the timings are diagnostics, and calling the clock twice per pass
    // boxed a fresh number per call on every frame the map was open.
    timingTick = (timingTick + 1) & 31;
    timing = timingTick === 1;
    const t0 = timing ? now() : 0;
    stats.painted = 0;
    stats.scanned = 0;
    stats.flushes = 0;

    const level = state === null || state === undefined ? null : state.levelData;
    const grid = state === null || state === undefined ? null : state.explored;
    if (level === null || level === undefined || grid === null || grid === undefined) {
      if (timing) stats.updateMs = now() - t0;
      return;
    }
    const maze = level.maze;
    if (maze === null || maze === undefined) {
      if (timing) stats.updateMs = now() - t0;
      return;
    }
    if (level !== levelRef && !adoptLevel(level, maze)) {
      if (timing) stats.updateMs = now() - t0;
      return;
    }
    if (tile32 === null || grid.length < mw * mh) {
      // A mismatched explored buffer would be read out of bounds; refuse rather than guess.
      if (timing) stats.updateMs = now() - t0;
      return;
    }

    const tiles = maze.tiles;
    const p = state.player;
    const px = p.x;
    const py = p.y;

    // A gap in updates (map switched off, tab hidden, a teleport) invalidates the local box, so
    // fall back to the exact answer.
    const stale = lastUpdate < 0 || clock - lastUpdate > MAP.STALE_AFTER || clock < lastUpdate;
    if (needsFullScan || stale) {
      stats.painted += paintTiles(
        tile32, mw, mh, 0, 0, mw - 1, mh - 1, tiles, grid, itemLayer, exitIdx, dirty,
      );
      stats.scanned += mw * mh;
      explored += stats.painted;
      needsFullScan = false;
      stats.rebuilds++;
    } else {
      // Local box: the reveal radius plus however far the player travelled since the last update,
      // so a 10 fps frame or a long step cannot leave a hole behind.
      const moved = Math.max(Math.abs(px - lastPlayerX), Math.abs(py - lastPlayerY));
      const r = MAP.REVEAL_RADIUS + Math.ceil(moved) + MAP.BOX_SLACK;
      const bx = Math.floor(px);
      const by = Math.floor(py);
      const before = stats.painted;
      stats.painted += paintTiles(
        tile32, mw, mh, bx - r, by - r, bx + r, by + r, tiles, grid, itemLayer, exitIdx, dirty,
      );
      const span = 2 * r + 1;
      stats.scanned += span * span;
      explored += stats.painted - before;

      // Rolling reconciliation: a slice of the grid per frame, so anything revealed outside the
      // box (a contract change upstream, a prefilled grid) still lands within a fraction of a
      // second. In steady state this paints nothing.
      const total = mw * mh;
      let budget = MAP.SWEEP_BUDGET > total ? total : MAP.SWEEP_BUDGET;
      let cursor = sweepCursor;
      let swept = 0;
      while (budget-- > 0) {
        if (cursor >= total) cursor = 0;
        if (grid[cursor] !== 0 && tile32[cursor] === 0) {
          tile32[cursor] = colorFor(cursor, tiles, itemLayer, exitIdx);
          markDirty(cursor % mw, (cursor / mw) | 0);
          explored++;
          stats.painted++;
        }
        cursor++;
        swept++;
      }
      sweepCursor = cursor;
      stats.scanned += swept;
    }

    if (lastPrune < 0 || clock - lastPrune >= MAP.PRUNE_INTERVAL || clock < lastPrune) {
      pruneItems(tiles);
      lastPrune = clock;
    }

    lastPlayerX = px;
    lastPlayerY = py;
    lastUpdate = clock;
    stats.explored = explored;

    // Push only what changed. `putImageData`'s dirty-rectangle form uploads that sub-rect alone,
    // which is the difference between ~200 µs and ~2 µs at 257×257.
    if (dirty[2] >= dirty[0] && dirty[3] >= dirty[1] && tileCtx !== null && tileImg !== null) {
      tileCtx.putImageData(
        tileImg, 0, 0, dirty[0], dirty[1], dirty[2] - dirty[0] + 1, dirty[3] - dirty[1] + 1,
      );
      stats.flushes = 1;
      clearDirty();
      // Any raster change invalidates the cell downsample.
      cellStamp = -1;
    }
    if (timing) stats.updateMs = now() - t0;
  }

  /**
   * Rebuild the cell-resolution raster from the tile raster.
   *
   * Only the full map at its smallest scale needs this, and only when the explored set has moved,
   * so it is an on-demand `cols*rows` pass (16 k for the 128-cell cap, ~25 µs measured) rather
   * than another incremental structure to keep correct.
   * @param {number} cols
   * @param {number} rows
   * @returns {boolean}
   */
  function ensureCellRaster(cols, rows) {
    if (tile32 === null) return false;
    if (cellCanvas === null || cellCols !== cols || cellRows !== rows) {
      const c = makeCanvas(cols, rows);
      if (c === null) return false;
      c.width = cols;
      c.height = rows;
      let context = null;
      try {
        context = c.getContext('2d');
      } catch (err) {
        log.error('cell raster context unavailable', err);
        return false;
      }
      if (context === null) return false;
      cellCanvas = c;
      cellCtx = context;
      cellImg = context.createImageData(cols, rows);
      cell32 = new Uint32Array(cellImg.data.buffer);
      cellCols = cols;
      cellRows = rows;
      cellStamp = -1;
    }
    if (cellStamp === explored || cell32 === null || cellCtx === null || cellImg === null) {
      return cell32 !== null;
    }
    // Cell (cx,cy) lives at tile (2cx+1, 2cy+1) in a thick-wall maze (ARCHITECTURE.md §6).
    for (let cy = 0; cy < rows; cy++) {
      const trow = (cy * 2 + 1) * mw;
      const crow = cy * cols;
      for (let cx = 0; cx < cols; cx++) {
        cell32[crow + cx] = tile32[trow + cx * 2 + 1];
      }
    }
    cellCtx.putImageData(cellImg, 0, 0);
    cellStamp = explored;
    return true;
  }

  // ── Drawing ──

  /**
   * The corner window: a zoomed, player-centred slice of the raster.
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} m surface metrics
   * @param {GameState} state
   * @param {number} clock
   * @param {boolean} reduced reduced motion
   * @returns {number} the box height in UI pixels, 0 when nothing was drawn
   */
  function drawCorner(ctx, m, state, clock, reduced) {
    if (tileCanvas === null || levelRef === null || levelRef !== state.levelData) return 0;
    const t0 = timing ? now() : 0;
    const u = m.u;
    const pad = 3 * u;
    const span = m.narrow ? MAP.CORNER_TILES_NARROW : MAP.CORNER_TILES;
    // The box is bounded by both axes: a third of the width, under a third of the height — the
    // stone frame included, so framing the window did not make the widget bigger.
    const frame = Math.max(1, u);
    const room = Math.min(Math.floor(m.w * 0.34), Math.floor(m.h * 0.32)) - frame * FRAME_BORDERS * 2;
    const zoom = clamp(Math.floor(room / span), MAP.CORNER_MIN_ZOOM, MAP.CORNER_MAX_ZOOM);
    const size = span * zoom;
    // `drawPanel` paints an outer edge, then the bevelled frame body: two borders thick, exactly like
    // every other HUD panel. The window used to be blitted at one border in, straight over the bevel,
    // so the corner map was the one panel on screen with no stone frame at all — a flat dark
    // rectangle beside the gauge and the score plaque.
    const chrome = frame * FRAME_BORDERS;
    const box = size + chrome * 2;
    const bx = m.w - pad - box;
    const by = m.h - pad - box;

    // Stone, not iron: on a phone the corner map sits on the black control deck below the world,
    // where an iron frame (#2f343d) is invisible. The stone bevel's highlight reads on both the
    // lit corridor of a desktop layout and that black deck.
    // No masonry behind a map (the courses read as corridors), no rivets. Reused options object:
    // a literal here was a heap allocation every frame the corner map was open.
    cornerPanel.border = frame;
    drawPanel(ctx, bx, by, box, box, u, cornerPanel);

    const ox = bx + chrome;
    const oy = by + chrome;
    const p = state.player;
    // Whole tiles in: `span` is odd, so the window's `round(px - half)` equals `round(px) - half`,
    // and an integer argument is not boxed on the way into the call the way a position is.
    // The overscan is the player marker's half-width in tiles: at a maze corner the window stops
    // scrolling, and without it the arrow (three zoom steps wide) was cut by the frame.
    cornerWindow(Math.round(p.x), Math.round(p.y), span, mw, mh, win, 2);
    blitWindow(ctx, ox, oy, size, win[0], win[1], span, zoom);

    // Exit, once its tile has been seen — it is the one thing worth over-drawing.
    const maze = /** @type {any} */ (state.levelData).maze;
    if (state.explored !== null && state.explored[exitIdx] !== 0) {
      const ex = maze.exit.x - win[0];
      const ey = maze.exit.y - win[1];
      if (ex >= 0 && ey >= 0 && ex < span && ey < span) {
        const pulse = reduced ? 1 : 0.6 + 0.4 * Math.sin(clock * 4);
        ctx.fillStyle = withAlphaStep(COLOR.arcCyan, (pulse * 64) | 0);
        const s = Math.max(2, zoom);
        ctx.fillRect(ox + ex * zoom, oy + ey * zoom, s, s);
      }
    }

    drawPlayerArrow(
      ctx,
      Math.round((ox + (p.x - win[0]) * zoom) * 2),
      Math.round((oy + (p.y - win[1]) * zoom) * 2),
      (Math.round(p.angle / QUARTER_TURN) & 7) >>> 0,
      zoom * 3,
      !reduced && clock % 1.1 >= 0.82,
    );
    if (timing) stats.drawMs = now() - t0;
    return box;
  }

  /**
   * Blit a tile window, clipped to the raster, over a void ground.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} ox destination left (UI px)
   * @param {number} oy destination top
   * @param {number} size destination size (UI px)
   * @param {number} wx window left in tiles
   * @param {number} wy window top in tiles
   * @param {number} span window size in tiles
   * @param {number} zoom UI pixels per tile
   * @returns {void}
   */
  function blitWindow(ctx, ox, oy, size, wx, wy, span, zoom) {
    // Unexplored ground is a dark stone grey, not black: at the start of a level the window is
    // almost entirely unknown, and on a phone the map sits on a black control deck — a black
    // rectangle there reads as a broken widget rather than as fog. It stays far enough below the
    // explored floor tone (#6e6455) that corridors still read as the bright shape.
    ctx.fillStyle = withAlpha(COLOR.stoneShadow, 0.88);
    ctx.fillRect(ox, oy, size, size);
    if (tileCanvas === null) return;
    const sx = wx < 0 ? 0 : wx;
    const sy = wy < 0 ? 0 : wy;
    const ex = Math.min(mw, wx + span);
    const ey = Math.min(mh, wy + span);
    const sw = ex - sx;
    const sh = ey - sy;
    if (sw <= 0 || sh <= 0) return;
    ctx.drawImage(
      tileCanvas, sx, sy, sw, sh,
      ox + (sx - wx) * zoom, oy + (sy - wy) * zoom, sw * zoom, sh * zoom,
    );
  }

  /** Fit scratch for the full map's two candidate layouts ({@link chooseFullScale} fills them). */
  /** @type {FullFit} */
  const stackFit = { res: 'tile', scale: 0, w: 0, h: 0 };
  /** @type {FullFit} */
  const railFit = { res: 'tile', scale: 0, w: 0, h: 0 };

  // ── Full-map label text, rebuilt only when the numbers behind it change ──
  const headMemo = createTextMemo((lv, c, r) => 'DEPTH ' + lv + '  ·  ' + formatLabyrinth(c, r));
  const depthMemo = createTextMemo((lv) => 'DEPTH ' + lv);
  const sizeMemo = createTextMemo((c, r) => formatLabyrinth(c, r));
  const mappedMemo = createTextMemo((pct) => 'MAPPED ' + formatPercent(pct / 100));
  const gemsMemo = createTextMemo((g, t) => formatCount(g, t));
  const exitMemo = createTextMemo((d) => 'EXIT ' + formatDistance(d));
  const distMemo = createTextMemo((d) => formatDistance(d));
  const clockMemo = createTextMemo((sec) => formatClock(sec));

  /** `drawPanel` options for the two map frames, mutated per call instead of built per frame. */
  /** @type {{frame:'stone', alpha:number, border:number, rivets:boolean, texture:boolean}} */
  const cornerPanel = { frame: 'stone', alpha: 0.9, border: 1, rivets: false, texture: false };
  /** @type {{frame:'stone', alpha:number, border:number, rivets:boolean, texture:boolean}} */
  const fullPanel = { frame: 'stone', alpha: 0.92, border: 1, rivets: true, texture: false };

  /**
   * Whole seconds on the level clock — the resolution `formatClock` prints, so the memo key only
   * changes when the text does.
   * @param {GameState} state
   * @returns {number}
   */
  function clockSeconds(state) {
    const t = state.run !== undefined ? state.run.levelTime : 0;
    return Number.isFinite(t) && t > 0 ? Math.floor(t) : 0;
  }

  /**
   * The full-screen labyrinth map: the fitted map, what it is (depth, size, how much is mapped) and
   * a legend.
   *
   * **Two layouts, and whichever draws the bigger map wins** — measured every frame from the real
   * text widths, because the targets are wildly different boxes:
   * - **Strips** (a phone, and the fallback): a header strip on top, the legend strip underneath and
   *   the map centred between them. A phone at dpr 3 is 234×506 UI pixels; it has no side room.
   * - **Rails** (a wide screen): the header stacks down the left gutter under the fuel gauge, the
   *   legend down the right gutter, and the map gets the whole height. On 16:9 the strips spent
   *   ~24 % of the height on two lines of text while the left and right thirds of the screen sat
   *   empty; at 1920×1080 the rails draw the 257-tile cap at 4 device pixels per tile (1 028 px)
   *   where the strips managed 3 (771 px).
   * A tie goes to the rails: the same map, with the text moved out of the way of it.
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} m surface metrics
   * @param {GameState} state
   * @param {number} clock
   * @param {boolean} reduced
   * @param {number} [gaugeRight] right edge of the fuel gauge the HUD keeps on screen over the map,
   *   in UI pixels (0 when there is none)
   * @param {number} [gaugeBottom] bottom edge of that gauge, in UI pixels
   * @returns {void}
   */
  function drawFull(ctx, m, state, clock, reduced, gaugeRight, gaugeBottom) {
    const level = /** @type {any} */ (state.levelData);
    if (tileCanvas === null || level === null || level !== levelRef) return;
    const t0 = timing ? now() : 0;
    const maze = level.maze;
    const u = m.u;

    // Ground: dark enough that the corridors glow, translucent enough that the world behind still
    // says "you are standing in a maze with the torch burning".
    ctx.fillStyle = withAlpha(COLOR.void, 0.88);
    ctx.fillRect(0, 0, m.w, m.h);

    const margin = 3 * u;
    const dev = Math.max(1, m.px);
    let frame = Math.max(1, u);
    if (m.narrow) {
      // A phone's full map is width-bound, and the fit is quantised to whole **device** pixels per
      // tile: the stone frame costs `2 × frame × m.px` device pixels a side, which across a
      // 257-tile map is a whole pixel per tile (2 instead of 3 — 66 % of a 390-pixel screen instead
      // of 97 %). Where the frame is what costs that step it gives way to the map: the diagram is
      // what the screen is for, and it draws its own hairline edge instead (below).
      const across = maze.cols * 2 + 1;
      const framed = Math.floor(((m.w - frame * 2) * dev - 2 * MAP_MARGIN_DEV) / across);
      const bare = Math.floor((m.w * dev - 2 * BARE_MARGIN_DEV) / across);
      if (bare > framed) frame = 0;
    }
    /** Side margin in device pixels: a frameless map keeps a hairline's worth. */
    const marginDev = frame > 0 ? MAP_MARGIN_DEV : BARE_MARGIN_DEV;
    const gR = typeof gaugeRight === 'number' && gaugeRight > 0 ? gaugeRight : 0;
    const gB = typeof gaugeBottom === 'number' && gaugeBottom > 0 ? gaugeBottom : 0;
    const total = mw * mh;
    const mapped = mappedMemo(total > 0 ? Math.round(clamp01(explored / total) * 100) : 0);

    // ── Candidate 1: strips ──
    const head = headMemo(state.level, maze.cols, maze.rows);
    // Beside the gauge on a wide screen, under it on a phone — and under it on a wide screen too
    // when beside it the header would have to shrink (a 4:3 window): a header at half the size of
    // the legend under the map reads as an afterthought, and the row under the gauge is free.
    const under =
      m.narrow || headerScale(head, mapped, m.w - Math.max(margin, gR + 3 * u) - margin, u) < Math.max(1, u);
    const hx = under ? margin : Math.max(margin, gR + 3 * u);
    const headY = under ? Math.max(margin, gB + 2 * u) : margin;
    const headSize = headerScale(head, mapped, m.w - hx - margin, u);
    const headH = heightAt('hud', headSize);
    // Never louder than the header over the map: on a phone two lines would buy the legend a size the
    // one-line header above it cannot have, and the key to the map outshouted what the map is.
    fitLegend(m, state, u, headSize);
    const legendSize = legendFit.size;
    const legendH = heightAt('hud', legendSize);
    // One line, or two on a phone: the swatches, then the exit distance (or the close hint) under them.
    const legendY = m.h - margin - legendFit.lines * legendH - (legendFit.lines - 1) * 2 * u;
    const boxTop = headY + headH + 3 * u;
    const boxH = legendY - 3 * u - boxTop - frame * 2;
    // The side margin is paid in **device** pixels, not in UI pixels. A 3-UI-pixel margin costs
    // `3u × m.px` device pixels a side, and the fit below is quantised to whole device pixels per
    // tile, so a margin paid on the chunky grid can cost a whole pixel per tile across a 257-tile
    // map (see `MAP.MARGIN_DEV` for the phone where it did). The map is a diagram measured on the device grid (see the note
    // under this one); its margin has to be measured there too.
    const boxWDev = (m.w - frame * 2) * dev - 2 * marginDev;
    const stripsOk = boxWDev >= 16 * dev && boxH >= 16;

    // The map is fitted in **device** pixels rather than in UI pixels.
    //
    // WHY: the overlay's UI grid is deliberately chunky (one UI pixel is `m.px` device pixels — 5
    // of them on a 390×844 phone at dpr 3) because that is what keeps the lettering pixel-art. A
    // map is a diagram, not lettering: measuring it in UI pixels there would cap a 128-cell maze
    // at 128 UI pixels — 55 % of the screen width, and *below* tile resolution, so the corridors
    // vanish. Fitting in device pixels gives the same maze 4 device pixels per tile: the whole
    // labyrinth, walls and all, across 88 % of the screen. It stays pixel-exact because the scale
    // is still an integer number of device pixels per raster pixel; the grid is simply finer than
    // the font's. On a desktop (`m.px` = 2) this changes nothing — the arithmetic gives the same
    // answer it did in UI pixels.
    if (stripsOk) chooseFullScale(maze.cols, maze.rows, boxWDev, boxH * dev, stackFit);

    // ── Candidate 2: rails (a wide screen only) ──
    const railSize = Math.max(1, u);
    const railLineH = heightAt('hud', railSize);
    let rail = false;
    let railLeft = 0;
    let railRight = 0;
    let railWDev = 0;
    let railHDev = 0;
    if (!m.narrow) {
      // The left rail is already as wide as the gauge above it, so the close hint lives at its foot
      // rather than widening the legend rail on the other side of the map.
      const textW = Math.max(
        measureAt(depthMemo(state.level), 'hud', railSize),
        measureAt(sizeMemo(maze.cols, maze.rows), 'hud', railSize),
        measureAt(mapped, 'hud', railSize),
        measureAt(clockMemo(clockSeconds(state)), 'hud', railSize),
        measureAt(closeHint(), 'hud', railSize),
      );
      railLeft = Math.max(gR, margin + textW) + 4 * u;
      railRight = legendColumnWidth(state, railSize, u) + margin + 4 * u;
      railWDev = (m.w - railLeft - railRight - frame * 2) * dev;
      railHDev = (m.h - margin * 2 - frame * 2) * dev;
      // Both rails must actually hold their text: four lines under the gauge plus the close hint
      // at the foot on the left; on the right four legend rows (gems, flasks, you, the exit) and the
      // distance line under the last of them.
      const leftFits = gB + 4 * u + 4 * (railLineH + 2 * u) + 2 * u + railLineH <= m.h - margin;
      const rightFits = margin + u + 3 * legendRowPitch(railSize, u) + 2 * railLineH + 2 * u <= m.h - margin;
      if (railWDev >= 16 * dev && railHDev >= 16 * dev && leftFits && rightFits) {
        chooseFullScale(maze.cols, maze.rows, railWDev, railHDev, railFit);
        rail = !stripsOk || fitBeats(railFit, stackFit);
      }
    }
    if (!rail && !stripsOk) {
      if (timing) stats.drawMs = now() - t0;
      return;
    }

    const fit = rail ? railFit : stackFit;
    const drawW = fit.w;
    const drawH = fit.h;

    // ── Markers, sized on the device grid ──
    // The markers are the reason the map is opened, so they are sized in device pixels with a floor,
    // never in tiles alone: at the 128×128 cap a tile is 2 device pixels on a desktop, and a player
    // arrow "four tiles wide" was an 8-pixel sliver, the exit a 4-pixel dot.
    /** Raster pixels per tile (device pixels). A cell is two tiles wide in the tile grid. */
    const perTile = fit.res === 'tile' ? fit.scale : fit.scale / 2;
    const arm = clamp(Math.round(perTile * 8), 8 * dev, 20 * dev);
    const marker = clamp(Math.round(perTile * 4), 9 * dev, 16 * dev);
    // Inset. The start is always tile (1, 1) and the exit is the farthest cell, usually on the far
    // edge, so both markers sit on the raster's outermost tiles — and a clip at the raster's edge cut
    // them to a quarter. The raster is set in from the frame by the reach of the exit's crosshair
    // arms (which covers the player's arrow and halo too), paid only out of the room the integer fit
    // left over: the inset never costs a device pixel per tile.
    const reach = Math.max(arm, (marker >> 1) + 2 * dev);
    const insetX = clamp(Math.floor(((rail ? railWDev : boxWDev) - drawW) / 2), 0, reach);
    const insetY = clamp(Math.floor(((rail ? railHDev : boxH * dev) - drawH) / 2), 0, reach);

    // The frame is drawn on the UI grid around the device-space raster, so it is the enclosing
    // whole number of UI pixels; the raster is then centred inside it.
    const panelW = Math.ceil((drawW + 2 * insetX) / dev) + frame * 2;
    const panelH = Math.ceil((drawH + 2 * insetY) / dev) + frame * 2;
    let px = 0;
    let py = 0;
    if (rail) {
      // Centred on the screen when the rails leave room for that — the world behind is centred —
      // and nudged clear of the wider rail when they do not.
      px = clamp(Math.round((m.w - panelW) / 2), railLeft, Math.max(railLeft, m.w - railRight - panelW));
      py = Math.round((m.h - panelH) / 2);
      drawRailHeader(ctx, m, state, maze, margin, gB + 4 * u, railSize, railLineH + 2 * u, mapped);
    } else {
      px = Math.round((m.w - panelW) / 2);
      py = Math.round(boxTop + (boxH + frame * 2 - panelH) / 2);
      drawAt(ctx, head, hx, headY, 'hud', headSize, 'hudGold');
      drawAt(ctx, mapped, m.w - margin, headY, 'hud', headSize, 'hudDim', 'right');
      // A separator when the two runs are close enough to read as one ("128×128 MAPPED 91%"), in the
      // same dot the depth plaque and this header's own `DEPTH n · size` use.
      const headEnd = hx + measureAt(head, 'hud', headSize);
      const mappedStart = m.w - margin - measureAt(mapped, 'hud', headSize);
      const gap = mappedStart - headEnd;
      if (gap > 4 * headSize && gap < 14 * headSize) {
        drawAt(ctx, HEAD_SEPARATOR, Math.round((headEnd + mappedStart) / 2), headY, 'hud', headSize, 'hudDim', 'center');
      }
    }

    // ── The map ──
    if (frame > 0) {
      fullPanel.border = frame;
      drawPanel(ctx, px, py, panelW, panelH, u, fullPanel);
    }
    ctx.fillStyle = withAlpha(COLOR.stoneShadow, 0.92);
    ctx.fillRect(px + frame, py + frame, panelW - frame * 2, panelH - frame * 2);

    // Raster space: identity transform, offset by the surface's letterbox origin, so one unit is
    // one device pixel. Everything inside the frame is drawn here and the UI transform is put back
    // immediately afterwards — `menus.render()` and the rest of the HUD depend on it.
    const ox = (px + frame) * dev + (((panelW - frame * 2) * dev - drawW) >> 1);
    const oy = (py + frame) * dev + (((panelH - frame * 2) * dev - drawH) >> 1);
    // `save`/`restore` brackets it, which also puts the UI transform back. The clip is the panel's
    // **outer** edge: a marker on a tile the inset could not fully clear (a phone whose fit left no
    // room) runs onto the stone frame instead of being cut off, and the crosshair's arms still never
    // draw a stray line across the legend.
    // A frameless map (a phone, filling the width) has no stone to run a marker onto and only a
    // couple of device pixels of inset, so the clip is grown by half a marker: the player's arrow on
    // the maze's outermost tile stands proud of the map's edge instead of being cut in half. Half a
    // marker only — the exit crosshair's long arms still stop at the edge rather than striping the
    // black deck around it.
    const clipPad = frame === 0 ? (marker >> 1) + dev : 0;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, m.originX, m.originY);
    ctx.beginPath();
    ctx.rect(px * dev - clipPad, py * dev - clipPad, panelW * dev + clipPad * 2, panelH * dev + clipPad * 2);
    ctx.clip();

    if (fit.res === 'tile') {
      ctx.drawImage(tileCanvas, 0, 0, mw, mh, ox, oy, drawW, drawH);
    } else if (ensureCellRaster(maze.cols, maze.rows) && cellCanvas !== null) {
      ctx.drawImage(cellCanvas, 0, 0, cellCols, cellRows, ox, oy, drawW, drawH);
    } else {
      ctx.restore();
      if (timing) stats.drawMs = now() - t0;
      return;
    }

    // A frameless (narrow) map still needs an edge, or the labyrinth's outer wall bleeds into the
    // black deck around it. One device pixel, drawn in raster space: at 3 device pixels per tile a
    // UI-pixel frame would cover a tile of the maze.
    if (frame === 0) {
      ctx.fillStyle = withAlphaStep(COLOR.stoneBright, 26);
      ctx.fillRect(ox - 1, oy - 1, drawW + 2, 1);
      ctx.fillRect(ox - 1, oy + drawH, drawW + 2, 1);
      ctx.fillRect(ox - 1, oy, 1, drawH);
      ctx.fillRect(ox + drawW, oy, 1, drawH);
    }

    // Exit: a real glyph when there is room for one, otherwise a pulsing block **inside a
    // crosshair** — at one pixel per cell a two-pixel dot in a 128-pixel field of noise is
    // genuinely impossible to find, and finding the exit is the entire point of opening the map.
    if (state.explored !== null && state.explored[exitIdx] !== 0) {
      const exx = ox + (maze.exit.x - (fit.res === 'cell' ? 1 : 0)) * perTile;
      const exy = oy + (maze.exit.y - (fit.res === 'cell' ? 1 : 0)) * perTile;
      const pulse = reduced ? 1 : 0.55 + 0.45 * Math.sin(clock * 4);
      // A crosshair first, always: a few bright pixels somewhere in a 66 000-tile field are
      // invisible, and "where is the way out" is the question the map exists to answer. The arms
      // reach out of the maze texture, so the eye finds them from across the screen.
      const thick = Math.max(2, Math.round(dev));
      // Dark backing first: the map's floor is a light warm grey, so a thin cyan line alone would
      // half disappear into it. Two passes cost four fills and make the marker read on any ground.
      ctx.fillStyle = withAlpha(COLOR.void, 0.85);
      ctx.fillRect(Math.round(exx - arm), Math.round(exy - thick), arm * 2, thick * 2);
      ctx.fillRect(Math.round(exx - thick), Math.round(exy - arm), thick * 2, arm * 2);
      // Never dimmer than 60 %: the arms are what the eye catches first, so they do not fade out.
      ctx.fillStyle = withAlphaStep(COLOR.arcCyan, ((0.6 + 0.4 * pulse) * 64) | 0);
      ctx.fillRect(Math.round(exx - arm), Math.round(exy - thick / 2), arm * 2, thick);
      ctx.fillRect(Math.round(exx - thick / 2), Math.round(exy - arm), thick, arm * 2);
      // The glyph has a device-pixel floor too (7 art pixels at `dev` each): on the cap's 2-pixel
      // tiles it was a 7-device-pixel speck.
      const glyph = Math.max(Math.round(perTile * 4), ICON_SIZE.portal * dev);
      if (glyph >= ICON_SIZE.portal) {
        const s = Math.max(1, Math.floor(glyph / ICON_SIZE.portal));
        drawPortalIcon(
          ctx,
          Math.round(exx - (ICON_SIZE.portal * s) / 2),
          Math.round(exy - (ICON_SIZE.portal * s) / 2),
          s,
        );
      } else {
        ctx.fillStyle = withAlphaStep(COLOR.arcPale, (pulse * 64) | 0);
        const s = Math.max(2 * dev, Math.round(perTile * 2));
        ctx.fillRect(Math.round(exx - s / 2), Math.round(exy - s / 2), s, s);
      }
    }

    // Player: a dark halo that lifts the arrow off the maze texture, a ring that pulses outward from
    // it so the eye finds it from across the screen (held still under reduced motion), and the arrow.
    const p = state.player;
    const ax2 = Math.round((ox + (p.x - (fit.res === 'cell' ? 1 : 0)) * perTile) * 2);
    const ay2 = Math.round((oy + (p.y - (fit.res === 'cell' ? 1 : 0)) * perTile) * 2);
    const pcx = ax2 >> 1;
    const pcy = ay2 >> 1;
    const halo = (marker >> 1) + dev;
    ctx.fillStyle = withAlphaStep(COLOR.void, 44);
    fillDisc(ctx, pcx, pcy, halo, dev);
    // Pulse phase in 64ths of a 1.2 s cycle: an integer, so nothing fractional crosses a call.
    const phase64 = reduced ? 16 : ((clock * 53.3) | 0) & 63;
    ctx.fillStyle = withAlphaStep(COLOR.fireCore, reduced ? 40 : ((64 - phase64) * 7) >> 3);
    fillRing(ctx, pcx, pcy, halo + dev + ((phase64 * 6 * dev) >> 6), dev);
    drawPlayerArrow(ctx, ax2, ay2, (Math.round(p.angle / QUARTER_TURN) & 7) >>> 0, marker, !reduced && clock % 1.1 >= 0.82);

    // Back to the UI grid (and out of the clip) before anything else draws.
    ctx.restore();

    // ── Legend ──
    if (rail) drawLegendColumn(ctx, m, state, m.w - railRight + 4 * u, margin, railSize);
    else drawLegend(ctx, m, state, margin, legendY, legendSize, legendFit.lines);
    if (timing) stats.drawMs = now() - t0;
  }

  /**
   * One text scale for both halves of the strips header (`DEPTH n · size` on the left, `MAPPED n%`
   * on the right): the largest, up to `u`, at which the two fit side by side in `room`.
   * @param {string} head
   * @param {string} mapped
   * @param {number} room UI pixels
   * @param {number} u
   * @returns {number}
   */
  function headerScale(head, mapped, room, u) {
    let size = Math.max(1, u);
    for (;;) {
      const hw = measureAt(head, 'hud', size);
      const mwid = measureAt(mapped, 'hud', size);
      if (hw + mwid + 4 * u <= room || size <= 1) return size;
      size--;
    }
  }

  /**
   * The left rail of the wide full map: depth, labyrinth size, mapped share and the level clock —
   * one fact a line, under the fuel gauge — and how to close the map, at its foot. (The clock moved
   * here from the play HUD's depth plaque, which now carries only depth and size.)
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} m
   * @param {GameState} state
   * @param {{cols:number, rows:number}} maze
   * @param {number} x
   * @param {number} y top of the first line
   * @param {number} size text scale
   * @param {number} pitch line pitch
   * @param {string} mapped the `MAPPED n%` line
   * @returns {void}
   */
  function drawRailHeader(ctx, m, state, maze, x, y, size, pitch, mapped) {
    drawAt(ctx, depthMemo(state.level), x, y, 'hud', size, 'hudGold');
    drawAt(ctx, sizeMemo(maze.cols, maze.rows), x, y + pitch, 'hud', size, 'hudBright');
    drawAt(ctx, mapped, x, y + pitch * 2, 'hud', size, 'hudDim');
    drawAt(ctx, clockMemo(clockSeconds(state)), x, y + pitch * 3, 'hud', size, 'hudDim');
    drawAt(ctx, closeHint(), x, m.h - x, 'hud', size, 'hudDim', 'left', 'bottom');
  }

  /**
   * Has the exit been seen? The map must not leak where it is before then — the exit is
   * found, not given (ARCHITECTURE.md §4.6).
   * @param {GameState} state
   * @returns {boolean}
   */
  function exitSeen(state) {
    return state.explored !== null && exitIdx >= 0 && state.explored[exitIdx] !== 0;
  }

  /** Cached close hint; the device question is asked once per level (see `adoptLevel`). */
  let closeHintText = '';

  /**
   * How to close the map, in the terms of the device in hand: the M key on a keyboard, the MAP
   * button of the touch overlay on a phone (a phone has no M key to press).
   * @returns {string}
   */
  function closeHint() {
    if (closeHintText === '') {
      let coarse = false;
      try {
        const mm = /** @type {any} */ (globalThis).matchMedia;
        coarse = typeof mm === 'function' && mm.call(globalThis, '(pointer: coarse)').matches === true;
      } catch (err) {
        coarse = false;
      }
      closeHintText = coarse ? 'MAP TO CLOSE' : 'M TO CLOSE';
    }
    return closeHintText;
  }

  /**
   * The exit readout of the legend, keyed on the whole metres `formatDistance` prints.
   * @param {GameState} state
   * @returns {string}
   */
  function exitText(state) {
    const d = state.derived !== undefined ? state.derived.exitDist : Infinity;
    return exitMemo(Math.round(d));
  }

  /** The legend strip's fit, filled by {@link fitLegend}: text scale and one or two lines. */
  const legendFit = { size: 1, lines: 1 };

  /**
   * Fit the legend strip: the largest text scale, up to `u`, at which it fits the width on one line
   * — or, on a narrow surface, on two (the swatches, then the distance or close hint under them).
   *
   * Measured, not guessed: at u = 3 on a phone the full strip is nearly twice the width of the
   * screen, and a legend that overlaps itself is worse than no legend. A portrait phone's map is
   * width-bound, so the second line costs it nothing; a wide surface keeps one line, because there
   * the height is what the map is fitted to.
   * @param {any} m
   * @param {GameState} state
   * @param {number} u
   * @param {number} maxSize the largest scale allowed (the header's)
   * @returns {void}
   */
  function fitLegend(m, state, u, maxSize) {
    const room = m.w - 6 * u;
    // Widths have two parts: text and icons (linear in `size`) and the `u`-based gaps (which are
    // not), so the fit is solved by trying the sizes — `u` is at most 6, so this is at most a dozen
    // measurements of five short strings.
    for (let size = Math.max(1, Math.min(u, maxSize)); size >= 1; size--) {
      const swatches = legendSwatchesWidth(state, size, u);
      const right =
        measureAt(legendRightText(state), 'hud', size) +
        (exitSeen(state) ? ICON_SIZE.portal * size + 2 * u : 0);
      if (swatches + 5 * u + right <= room) {
        legendFit.size = size;
        legendFit.lines = 1;
        return;
      }
      if (m.narrow && swatches <= room && right <= room) {
        legendFit.size = size;
        legendFit.lines = 2;
        return;
      }
    }
    legendFit.size = 1;
    legendFit.lines = m.narrow ? 2 : 1;
  }

  /**
   * Width of the legend's swatches (gems, flasks, the exit while unseen, you) at a text scale, gaps
   * between them included and none after the last.
   * @param {GameState} state
   * @param {number} size
   * @param {number} u
   * @returns {number} UI pixels
   */
  function legendSwatchesWidth(state, size, u) {
    const run = state.run;
    let w = ICON_SIZE.gem * size + 2 * u + measureAt(gemsMemo(run.gems, run.gemsTotal), 'hud', size) + 5 * u;
    w += ICON_SIZE.oilW * size + 2 * u + measureAt('OIL', 'hud', size) + 5 * u;
    if (!exitSeen(state)) {
      w += ICON_SIZE.portal * size + 2 * u + measureAt('EXIT', 'hud', size) + 5 * u;
    }
    w += ICON_SIZE.arrow * size + 2 * u + measureAt(YOU_LABEL, 'hud', size);
    return w;
  }

  /**
   * The strip's right-hand text: the distance to the exit once it has been seen, how to close the
   * map before then.
   * @param {GameState} state
   * @returns {string}
   */
  function legendRightText(state) {
    return exitSeen(state) ? exitText(state) : closeHint();
  }

  /**
   * The legend strip under the full map: what the colours and markers mean, plus the number a
   * player in a 16 000-cell labyrinth actually wants — how far away the exit is.
   *
   * The EXIT swatch is shown only while the exit has *not* been found: once it has, the distance
   * readout on the right says the same thing better, and the two together overflow a phone.
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} m
   * @param {GameState} state
   * @param {number} x left edge
   * @param {number} y top edge
   * @param {number} size text scale
   * @param {number} lines 1, or 2 to put the right-hand text on a line of its own (see `fitLegend`)
   * @returns {void}
   */
  function drawLegend(ctx, m, state, x, y, size, lines) {
    const u = m.u;
    const iconScale = Math.max(1, size);
    let cx = x;
    const run = state.run;
    const seen = exitSeen(state);

    const gemText = gemsMemo(run.gems, run.gemsTotal);
    const rightText = legendRightText(state);
    const rightY = lines > 1 ? y + heightAt('hud', size) + 2 * u : y;
    // Even at size 1 a very small surface can be too narrow for the whole strip. Something then gives
    // way rather than overlapping: the YOU swatch first (the arrow on the map explains itself), then
    // — on one line — the close hint while the exit is unseen (the MAP button says the same thing),
    // then the OIL swatch; the exit distance, the reason to open the map, is never dropped.
    let limit = lines > 1 ? m.w - x : m.w - x - measureAt(rightText, 'hud', size) - 3 * u;
    let end = x + legendSwatchesWidth(state, size, u);
    let showYou = true;
    let showOil = true;
    let showRight = true;
    if (end > limit) {
      showYou = false;
      end -= 5 * u + ICON_SIZE.arrow * iconScale + 2 * u + measureAt(YOU_LABEL, 'hud', size);
    }
    if (end > limit && lines === 1 && !seen) {
      showRight = false;
      limit = m.w - x;
    }
    if (end > limit) showOil = false;

    // Gems, then flasks, then the exit, then you — the order they are looked for in.
    drawGemIcon(ctx, cx, y, iconScale);
    cx += ICON_SIZE.gem * iconScale + 2 * u;
    drawAt(ctx, gemText, cx, y, 'hud', size, 'hudGem');
    cx += measureAt(gemText, 'hud', size) + 5 * u;

    if (showOil) {
      drawOilIcon(ctx, cx, y - u, iconScale);
      cx += ICON_SIZE.oilW * iconScale + 2 * u;
      drawAt(ctx, 'OIL', cx, y, 'hud', size, 'hudGold');
      cx += measureAt('OIL', 'hud', size) + 5 * u;
    }

    if (!seen) {
      drawPortalIcon(ctx, cx, y, iconScale);
      cx += ICON_SIZE.portal * iconScale + 2 * u;
      drawAt(ctx, 'EXIT', cx, y, 'hud', size, 'hudBright');
      cx += measureAt('EXIT', 'hud', size) + 5 * u;
    }

    if (showYou) {
      drawArt(ctx, ARROWS[YOU_OCTANT], cx, y, iconScale, ARROW_PALETTE);
      cx += ICON_SIZE.arrow * iconScale + 2 * u;
      drawAt(ctx, YOU_LABEL, cx, y, 'hud', size, 'hudBright');
    }

    if (showRight) {
      // Once the exit is known the swatch is dropped for room, but the distance still names it —
      // so the icon travels with the number and the strip keeps its key to the crosshair on the map.
      if (seen) {
        const rightW = measureAt(rightText, 'hud', size);
        const iconX = m.w - x - rightW - ICON_SIZE.portal * iconScale - 2 * u;
        if (iconX > cx + 3 * u) drawPortalIcon(ctx, iconX, rightY, iconScale);
      }
      drawAt(ctx, rightText, m.w - x, rightY, 'hud', size, seen ? 'hudBright' : 'hudDim', 'right');
    }
  }

  /**
   * Row pitch of the legend column: the tallest icon (the 9-row flask) plus a gap.
   * @param {number} size
   * @param {number} u
   * @returns {number}
   */
  function legendRowPitch(size, u) {
    return ICON_SIZE.oilH * Math.max(1, size) + 3 * u;
  }

  /**
   * Width of the legend column (the right rail of the wide layout) at a given text scale.
   * @param {GameState} state
   * @param {number} size
   * @param {number} u
   * @returns {number} UI pixels
   */
  function legendColumnWidth(state, size, u) {
    const run = state.run;
    const icon = Math.max(ICON_SIZE.gem, ICON_SIZE.oilW, ICON_SIZE.portal, ICON_SIZE.arrow) * Math.max(1, size) + 2 * u;
    // Every label sits right of the icon column, the distance included, so the rail is exactly as
    // wide as its longest label: "12/273" or "1,240m" — never "EXIT 1,240m" on one line.
    let w = measureAt(gemsMemo(run.gems, run.gemsTotal), 'hud', size);
    w = Math.max(w, measureAt('EXIT', 'hud', size), measureAt(YOU_LABEL, 'hud', size));
    if (exitSeen(state)) w = Math.max(w, measureAt(distText(state), 'hud', size));
    return icon + w;
  }

  /**
   * The bare distance to the exit (`"1,240m"`), keyed on the whole metres it prints.
   * @param {GameState} state
   * @returns {string}
   */
  function distText(state) {
    const d = state.derived !== undefined ? state.derived.exitDist : Infinity;
    return distMemo(Math.round(d));
  }

  /**
   * The legend as a column down the right rail: gems, flasks, the player marker and the exit swatch,
   * with the distance to the exit under the swatch once the exit has been seen (the exit is last so
   * that line has the rail below it to itself).
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} m
   * @param {GameState} state
   * @param {number} x left edge of the column
   * @param {number} y top edge
   * @param {number} size text scale
   * @returns {void}
   */
  function drawLegendColumn(ctx, m, state, x, y, size) {
    const u = m.u;
    const iconScale = Math.max(1, size);
    const run = state.run;
    const seen = exitSeen(state);
    const pitch = legendRowPitch(size, u);
    // Icons share one column so the labels line up whatever each icon's own width is.
    const textX = x + Math.max(ICON_SIZE.gem, ICON_SIZE.oilW, ICON_SIZE.portal, ICON_SIZE.arrow) * iconScale + 2 * u;
    let ry = y + u;

    drawGemIcon(ctx, x, ry, iconScale);
    drawAt(ctx, gemsMemo(run.gems, run.gemsTotal), textX, ry, 'hud', size, 'hudGem');
    ry += pitch;

    drawOilIcon(ctx, x, ry - u, iconScale);
    drawAt(ctx, 'OIL', textX, ry, 'hud', size, 'hudGold');
    ry += pitch;

    drawArt(ctx, ARROWS[YOU_OCTANT], x, ry, iconScale, ARROW_PALETTE);
    drawAt(ctx, YOU_LABEL, textX, ry, 'hud', size, 'hudBright');
    ry += pitch;

    drawPortalIcon(ctx, x, ry, iconScale);
    drawAt(ctx, 'EXIT', textX, ry, 'hud', size, seen ? 'hudDim' : 'hudBright');
    if (seen) {
      // Found: the number that matters, under its swatch and in the brightest style in the rail.
      drawAt(ctx, distText(state), textX, ry + heightAt('hud', size) + 2 * u, 'hud', size, 'hudBright');
    }
  }

  /**
   * The player marker: the 8-heading arrow, **always drawn**. It blinks by swapping its two tones —
   * a cream arrow in a dark outline, then a dark arrow in a cream outline — so the eye still catches
   * the movement on a busy map, but the "you are here" marker is never missing. (It used to vanish
   * for 0.28 s of every 1.1 s, and two separate screenshots of the full map caught it gone.)
   *
   * Every argument is an integer, computed by the caller: this runs every frame the map is open, and
   * a fractional position, angle or clock handed to a call that is not inlined is a boxed number.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx2 centre x in half pixels (twice the coordinate, rounded)
   * @param {number} cy2 centre y in half pixels
   * @param {number} octant heading, `round(angle / 45°) & 7` with 0 = east
   * @param {number} sizePx how wide the marker should be, in the units the caller is drawing in
   * @param {boolean} inverted draw the blink tone
   * @returns {void}
   */
  function drawPlayerArrow(ctx, cx2, cy2, octant, sizePx, inverted) {
    const arrow = ARROWS[octant & 7];
    const scale = Math.max(1, Math.round(sizePx / arrow.w));
    drawArt(
      ctx,
      arrow,
      Math.round((cx2 - arrow.w * scale) / 2),
      Math.round((cy2 - arrow.h * scale) / 2),
      scale,
      inverted ? ARROW_PALETTE_INVERTED : ARROW_PALETTE,
    );
  }

  /**
   * @returns {void}
   */
  function reset() {
    levelRef = null;
    explored = 0;
    sweepCursor = 0;
    lastUpdate = -1;
    lastPrune = -1;
    needsFullScan = true;
    cellStamp = -1;
    liveCount = 0;
    liveItems.length = 0;
    stats.rebuilds = 0;
    if (tile32 !== null) tile32.fill(0);
    clearDirty();
  }

  /**
   * @returns {void}
   */
  function dispose() {
    reset();
    tileCanvas = null;
    tileCtx = null;
    tileImg = null;
    tile32 = null;
    cellCanvas = null;
    cellCtx = null;
    cellImg = null;
    cell32 = null;
    mw = 0;
    mh = 0;
    itemLayer = null;
    liveIdx = new Int32Array(0);
  }

  /**
   * Force the next update onto the exact path. The raster itself stays valid (it only ever gains
   * pixels for explored tiles), so this is a catch-up, not a rebuild from zero: `paintTiles` paints
   * just the tiles revealed while nobody was looking.
   * @returns {void}
   */
  function invalidate() {
    needsFullScan = true;
  }

  return {
    update,
    drawCorner,
    drawFull,
    exploredCount: () => explored,
    stats: () => stats,
    invalidate,
    reset,
    dispose,
  };
}
