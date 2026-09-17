// @ts-check
/**
 * @file The in-game HUD, plus the overlay surface and the pixel-art primitives the menus share
 * (ARCHITECTURE.md §4.6).
 *
 * Three things live here, in dependency order:
 *
 * 1. **`createSurface`** — the overlay canvas manager. It sizes the backing store to the real
 *    device pixels and installs an *integer* scale transform, so every UI pixel is an exact,
 *    axis-aligned block of device pixels. One surface is shared per canvas element (see
 *    `SURFACES`), so `hud.js` and `menus.js` draw into the same coordinate system without having
 *    to be told about each other.
 * 2. **Pixel primitives** — re-exported from `./pixels.js`, which owns them now. `menus.js` and
 *    the tests keep importing them from here, so §4.6's published surface is unchanged; the split
 *    exists only so `map.js` can use them without an import cycle (see that file's header).
 * 3. **`createHud`** — the playing-phase readouts.
 *
 * ## Coordinate systems
 * - *CSS pixels* — what pointer events carry.
 * - *device pixels* — the canvas backing store (`cssPx × dpr`).
 * - *surface pixels* ("UI px") — what every draw call here uses. One surface pixel is
 *   `metrics.px` device pixels, always an integer ≥ 1.
 * The surface is sized so that its height is ≈ `TARGET_H` surface pixels on any display, which is
 * what keeps the HUD the same *fraction* of the screen from a 360×640 phone to a 2560×1440 monitor.
 *
 * ## Frame protocol (important for the integrator)
 * `hud.render()` **clears the whole overlay**; `menus.render()` does not, unless nothing cleared
 * before it. ARCHITECTURE.md §4.7 already renders in the order `hud` → `menus`, which is exactly
 * the order this expects. Either call alone is also safe.
 *
 * ## Hot path
 * A frame costs a few dozen canvas calls and allocates nothing: text goes through the scalar
 * `drawAt`/`measureAt` forms (an options literal per call was ~2 kB of garbage a frame), and panel
 * options are one reused object. The
 * formatted readouts are **memoised on their quantised inputs** (`createTextMemo`: whole seconds,
 * the rounded percentage, the integer score), so a readout allocates a string only on the frames
 * where its text actually changes — **nothing that scales with the size of
 * the maze or with the number of items in it**, which is the hard rule for the massive-maze wave:
 * a level now holds up to ~900 items and a 257×257 explored grid. Everything that would scale is
 * precomputed: glyphs come from a pre-coloured atlas, colour strings are memoised, the score pops
 * live in a fixed-size pool, panels and icons draw from run-length-merged rectangles, and the map
 * is an incrementally-maintained offscreen raster (see `map.js`) that costs one `drawImage`.
 * Measured at 0.1–0.2 ms per frame for the whole overlay at 1280×720, map included.
 */

import { clamp, clamp01 } from '../core/math.js';
import { createLogger, isDebug } from '../core/log.js';
import { COLOR, drawAt, heightAt, measureAt, probeLayout } from './font.js';
import {
  createCounter,
  createTextMemo,
  formatCount,
  formatDepth,
  formatInt,
  formatLabyrinth,
  formatSigned,
  formatTime,
} from './format.js';
import { createMapView, cycleMapMode, readMapMode } from './map.js';
import {
  ARROWS as NEEDLE_ARROWS,
  ARROW_PALETTE as NEEDLE_PALETTE,
  drawArt,
  drawGemIcon,
  drawOilIcon,
  drawPanel,
  drawTorchIcon,
  drawUnlockIcon,
  drawWell,
  ICON_SIZE,
  strokeRect,
  UNLOCK_ICON,
  withAlpha,
  withAlphaStep,
} from './pixels.js';

/** @typedef {import('../core/types.js').GameState} GameState */
/** @typedef {import('../core/types.js').FrameStats} FrameStats */
/** @typedef {import('./font.js').TextOptions} TextOptions */
/** @typedef {import('./map.js').MapMode} MapMode */

const log = createLogger('ui/hud');

// The pixel-art primitives live in `./pixels.js` now (see the file header). Re-exported here
// verbatim so `menus.js`, the preview harness and the tests keep the import path ARCHITECTURE.md
// §4.6 documents.
export {
  ARROWS,
  ARROW_PALETTE,
  compileArt,
  createArtSprite,
  drawArt,
  drawFlame,
  drawGemIcon,
  drawOilIcon,
  drawPanel,
  drawPortalIcon,
  drawTorchIcon,
  drawUnlockIcon,
  drawWell,
  fillDisc,
  fillRing,
  fitScale,
  fitScaleAt,
  hasUnlockIcon,
  hexToRgb,
  ICON_SIZE,
  strokeRect,
  UNLOCK_ICON,
  withAlpha,
  withAlphaStep,
} from './pixels.js';

// The map's mode helpers are re-exported for `menus.js` (the options row) and `src/main.js` (the
// `map` hotkey), so neither has to know that the map moved into its own module.
export {
  MAP_MODES,
  MAP_MODE_LABEL,
  cycleMapMode,
  mapModeFromSettings,
  nextMapMode,
  normalizeMapMode,
  readMapMode,
  resetMapMode,
  setMapMode,
} from './map.js';

// ─── Surface ─────────────────────────────────────────────────────────────────────────────────

/**
 * Target surface height in UI pixels. The renderer's framebuffer is 240 rows tall (§4.5) and the
 * overlay is specified at ×2 of it, so 480 is the reference; the real height lands within a factor
 * of the integer pixel scale of it, which is why every layout below is expressed relative to
 * `surface.h` and `surface.u` rather than in absolute numbers.
 */
const TARGET_H = 480;

/** Hard cap on the backing store, in device pixels. Beyond ~4 MP the per-frame clear starts to
 * cost more than everything else the overlay does, and no UI detail is gained. */
const MAX_DEVICE_PIXELS = 4.2e6;

/** Largest device-pixels-per-UI-pixel ratio. */
const MAX_PIXEL_SCALE = 8;

/**
 * Overlay metrics. All fields are integers.
 * @typedef {Object} SurfaceMetrics
 * @property {number} cssW   element width in CSS pixels
 * @property {number} cssH   element height in CSS pixels
 * @property {number} devW   backing-store width in device pixels
 * @property {number} devH   backing-store height in device pixels
 * @property {number} px     device pixels per surface pixel (integer ≥ 1)
 * @property {number} w      surface width in UI pixels
 * @property {number} h      surface height in UI pixels
 * @property {number} originX left edge of the UI area within the backing store, device pixels
 * @property {number} originY top edge of the UI area within the backing store, device pixels
 * @property {number} u      layout unit: UI pixels per "design pixel" (text scale, border width)
 * @property {boolean} narrow true when the surface is too narrow for the side-by-side layouts —
 *   a phone in portrait, or a very small window. Both the HUD and the menus switch to stacked
 *   arrangements on it.
 * @property {number} viewX  left edge of the 3-D world view, UI pixels (0 when unknown)
 * @property {number} viewY  top edge of the world view, UI pixels (0 when unknown)
 * @property {number} viewW  width of the world view, UI pixels (the surface width when unknown)
 * @property {number} viewH  height of the world view, UI pixels (the surface height when unknown).
 *   On a portrait phone the world is a 4:3 band with a deck above and below it (ARCHITECTURE.md
 *   §4.7 "Layout"); a layout that ignores the band puts a menu row across its edge.
 */

/**
 * The overlay canvas, wrapped.
 * @typedef {Object} Surface
 * @property {HTMLCanvasElement|null} canvas
 * @property {CanvasRenderingContext2D|null} ctx
 * @property {SurfaceMetrics} metrics  live object — read it, never write it
 * @property {(cssW:number, cssH:number, dpr?:number) => boolean} resize  returns true if the
 *   backing store or the transform changed
 * @property {() => CanvasRenderingContext2D|null} beginFrame  clear, reset the transform, open the frame
 * @property {() => CanvasRenderingContext2D|null} beginFrameIfClosed  as above, but only if nothing
 *   has opened a frame since the last `endFrame`
 * @property {() => void} endFrame  close the frame (the next `beginFrameIfClosed` will clear)
 * @property {(clientX:number, clientY:number, out:Float64Array) => boolean} fromClient  map a
 *   pointer event's client coordinates into UI pixels; false when the element has no layout
 * @property {(cssX:number, cssY:number, cssW:number, cssH:number) => void} setViewRect  where the
 *   3-D view sits, in CSS pixels relative to the overlay's top-left corner. Optional: until it is
 *   called the surface measures the page's `#view` element itself on every resize (see
 *   `measureView`); calling it with a zero width reverts to that.
 */

/**
 * One surface per canvas element, so every UI module shares the same transform and frame state.
 * A `WeakMap` because the canvas may be removed from the document by the host page.
 * @type {WeakMap<object, Surface>}
 */
const SURFACES = new WeakMap();

/**
 * Get (creating once) the shared surface for a canvas.
 *
 * A null/DOM-less canvas yields an inert surface whose `ctx` is null: every draw call in this file
 * and in `menus.js` no-ops, so the UI can be constructed in a test or a headless tool without
 * special cases.
 *
 * @param {HTMLCanvasElement|null|undefined} canvas
 * @returns {Surface}
 */
export function createSurface(canvas) {
  if (canvas !== null && canvas !== undefined) {
    const existing = SURFACES.get(canvas);
    if (existing !== undefined) return existing;
  }

  /** @type {SurfaceMetrics} */
  const metrics = {
    cssW: 0,
    cssH: 0,
    devW: 0,
    devH: 0,
    px: 1,
    w: 0,
    h: 0,
    originX: 0,
    originY: 0,
    u: 1,
    narrow: false,
    viewX: 0,
    viewY: 0,
    viewW: 0,
    viewH: 0,
  };

  /**
   * The world view's rectangle in overlay CSS pixels, as last given to `setViewRect` (`explicit`)
   * or measured from the page. `w === 0` means unknown: the whole surface is treated as the view.
   */
  const viewCss = { x: 0, y: 0, w: 0, h: 0, explicit: false };

  /** @type {CanvasRenderingContext2D|null} */
  let ctx = null;
  if (canvas !== null && canvas !== undefined && typeof canvas.getContext === 'function') {
    try {
      ctx = canvas.getContext('2d', { alpha: true });
    } catch (err) {
      log.error('overlay 2d context unavailable', err);
      ctx = null;
    }
  }

  let frameOpen = false;

  /**
   * @param {number} cssW
   * @param {number} cssH
   * @param {number} [dpr]
   * @returns {boolean}
   */
  function resize(cssW, cssH, dpr) {
    const w = Number.isFinite(cssW) && cssW > 0 ? Math.round(cssW) : 0;
    const h = Number.isFinite(cssH) && cssH > 0 ? Math.round(cssH) : 0;
    if (w === 0 || h === 0) return false;

    let ratio = typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    ratio = clamp(ratio, 0.5, 4);
    // Keep the backing store inside the budget by trading away device resolution, never UI size.
    const budget = Math.sqrt(MAX_DEVICE_PIXELS / (w * h));
    if (ratio > budget) ratio = budget < 0.5 ? 0.5 : budget;

    const devW = Math.max(1, Math.round(w * ratio));
    const devH = Math.max(1, Math.round(h * ratio));
    const px = clamp(Math.round(devH / TARGET_H), 1, MAX_PIXEL_SCALE);
    const uiW = Math.max(1, Math.floor(devW / px));
    const uiH = Math.max(1, Math.floor(devH / px));

    const changed =
      metrics.devW !== devW || metrics.devH !== devH || metrics.px !== px || metrics.cssW !== w;
    metrics.cssW = w;
    metrics.cssH = h;
    metrics.devW = devW;
    metrics.devH = devH;
    metrics.px = px;
    metrics.w = uiW;
    metrics.h = uiH;
    // Any device pixels left over by the integer scale become a margin, split evenly, so the UI
    // stays centred and every UI pixel keeps its exact `px × px` footprint.
    metrics.originX = (devW - uiW * px) >> 1;
    metrics.originY = (devH - uiH * px) >> 1;
    // Layout unit: one "design pixel". Derived from the surface height so the HUD occupies the
    // same fraction of the screen at any resolution (see TARGET_H).
    metrics.u = clamp(Math.round(uiH / 200), 1, 6);
    // 200 design units is what the side-by-side layouts actually need: a fuel gauge (≈55), a depth
    // readout (≈56) and a six-figure score at double height (≈90) laid across the top with margins
    // — measured, not guessed, because a tablet in portrait sits right on the boundary.
    metrics.narrow = uiW < 200 * metrics.u;

    if (changed && canvas !== null && canvas !== undefined) {
      canvas.width = devW;
      canvas.height = devH;
    }
    if (!viewCss.explicit) measureView();
    applyView();
    return changed;
  }

  /**
   * Measure the world view from the page when the composition root has not said where it is.
   *
   * WHY a fallback exists at all: the band a portrait phone letterboxes the world into is decided
   * by `src/main.js` (§4.7 "Layout"), which sizes `#view` and *then* resizes the overlay — so by the
   * time `resize` runs, the element's box is already final. Reading it here means the title and the
   * HUD respect the band on the shipped page today; `setViewRect` is the explicit seam, and once it
   * has been called this measurement is never taken again. Read-only, and only on resize.
   * @returns {void}
   */
  function measureView() {
    viewCss.w = 0;
    if (canvas === null || canvas === undefined) return;
    try {
      const doc = /** @type {any} */ (canvas).ownerDocument;
      if (doc === null || doc === undefined || typeof doc.getElementById !== 'function') return;
      const view = doc.getElementById('view');
      if (view === null || view === canvas || typeof view.getBoundingClientRect !== 'function') return;
      const r = view.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && c.width > 0 && c.height > 0)) return;
      viewCss.x = r.left - c.left;
      viewCss.y = r.top - c.top;
      viewCss.w = r.width;
      viewCss.h = r.height;
    } catch (err) {
      viewCss.w = 0;
    }
  }

  /**
   * Convert the view rectangle to UI pixels, clamped to the surface.
   * @returns {void}
   */
  function applyView() {
    const m = metrics;
    if (!(viewCss.w > 0 && viewCss.h > 0 && m.cssW > 0 && m.cssH > 0 && m.px > 0)) {
      m.viewX = 0;
      m.viewY = 0;
      m.viewW = m.w;
      m.viewH = m.h;
      return;
    }
    const sx = m.devW / m.cssW / m.px;
    const sy = m.devH / m.cssH / m.px;
    const x0 = clamp(Math.round(viewCss.x * sx - m.originX / m.px), 0, m.w);
    const y0 = clamp(Math.round(viewCss.y * sy - m.originY / m.px), 0, m.h);
    const x1 = clamp(Math.round((viewCss.x + viewCss.w) * sx - m.originX / m.px), x0, m.w);
    const y1 = clamp(Math.round((viewCss.y + viewCss.h) * sy - m.originY / m.px), y0, m.h);
    m.viewX = x0;
    m.viewY = y0;
    m.viewW = x1 - x0;
    m.viewH = y1 - y0;
  }

  /**
   * @param {number} cssX
   * @param {number} cssY
   * @param {number} cssW
   * @param {number} cssH
   * @returns {void}
   */
  function setViewRect(cssX, cssY, cssW, cssH) {
    const ok = Number.isFinite(cssX) && Number.isFinite(cssY) && cssW > 0 && cssH > 0;
    viewCss.explicit = ok;
    viewCss.x = ok ? cssX : 0;
    viewCss.y = ok ? cssY : 0;
    viewCss.w = ok ? cssW : 0;
    viewCss.h = ok ? cssH : 0;
    if (!ok) measureView();
    applyView();
  }

  /**
   * @returns {CanvasRenderingContext2D|null}
   */
  function beginFrame() {
    if (ctx === null) return null;
    const m = metrics;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, m.devW, m.devH);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(m.px, 0, 0, m.px, m.originX, m.originY);
    frameOpen = true;
    return ctx;
  }

  /**
   * @returns {CanvasRenderingContext2D|null}
   */
  function beginFrameIfClosed() {
    if (frameOpen) {
      if (ctx !== null) {
        // The HUD may have left a transform or alpha behind mid-frame; normalise before the menus
        // draw, without clearing what the HUD already put down.
        ctx.globalAlpha = 1;
        ctx.setTransform(metrics.px, 0, 0, metrics.px, metrics.originX, metrics.originY);
      }
      return ctx;
    }
    return beginFrame();
  }

  /**
   * @returns {void}
   */
  function endFrame() {
    frameOpen = false;
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {Float64Array} out length ≥ 2; receives the UI coordinates
   * @returns {boolean}
   */
  function fromClient(clientX, clientY, out) {
    if (canvas === null || canvas === undefined || typeof canvas.getBoundingClientRect !== 'function') {
      return false;
    }
    const rect = canvas.getBoundingClientRect();
    return mapPointer(metrics, rect.left, rect.top, rect.width, rect.height, clientX, clientY, out);
  }

  /** @type {Surface} */
  const surface = {
    canvas: canvas === undefined ? null : canvas,
    ctx,
    metrics,
    resize,
    beginFrame,
    beginFrameIfClosed,
    endFrame,
    fromClient,
    setViewRect,
  };
  if (canvas !== null && canvas !== undefined) SURFACES.set(canvas, surface);
  return surface;
}

/**
 * Map a pointer position from CSS/client coordinates to UI pixels.
 *
 * Pure arithmetic, exported so the mapping can be unit-tested without a DOM: the canvas is
 * stretched to `rectW × rectH` CSS pixels, its backing store is `devW × devH`, and the UI area sits
 * inside that at `origin*` scaled by `px`.
 *
 * Coordinates outside the UI area are still written to `out` (clamped to nothing — the caller may
 * want the overshoot for drag handling); the return value reports containment.
 *
 * @param {SurfaceMetrics} metrics
 * @param {number} rectLeft element's left edge in client coordinates
 * @param {number} rectTop element's top edge
 * @param {number} rectW element's rendered width in CSS pixels
 * @param {number} rectH element's rendered height
 * @param {number} clientX pointer x
 * @param {number} clientY pointer y
 * @param {Float64Array} out length ≥ 2; receives [uiX, uiY]
 * @returns {boolean} true when the point lies inside the UI area
 */
export function mapPointer(metrics, rectLeft, rectTop, rectW, rectH, clientX, clientY, out) {
  if (!(rectW > 0) || !(rectH > 0) || metrics.px <= 0) {
    out[0] = 0;
    out[1] = 0;
    return false;
  }
  const devX = ((clientX - rectLeft) / rectW) * metrics.devW;
  const devY = ((clientY - rectTop) / rectH) * metrics.devH;
  const uiX = (devX - metrics.originX) / metrics.px;
  const uiY = (devY - metrics.originY) / metrics.px;
  out[0] = uiX;
  out[1] = uiY;
  return uiX >= 0 && uiY >= 0 && uiX < metrics.w && uiY < metrics.h;
}

// ─── HUD ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Segments in the fuel bar. The torch is a **tank you refill**, not a level timer, so the bar is
 * read as "how many swigs left" — 16 segments with a heavier tick every 4 gives the eye a quarter-
 * tank grid to judge against without counting.
 */
const FUEL_SEGMENTS = 16;

/** Segments between the heavy quarter-tank ticks. */
const FUEL_TICK_EVERY = 4;

/** Fraction of `fuelMax` at or below which the gauge goes red (mirrors `FUEL.LOW_FRACTION`). */
const LOW_FUEL_FRACTION = 0.25;

/**
 * Seconds the refill flare lasts. Long enough to be felt as an event, short enough that chaining
 * two flasks does not leave the gauge permanently white.
 */
const REFILL_FLARE_TIME = 0.75;

/** Fuel-seconds gained in one frame below which a rise is drain jitter rather than a refuel. */
const REFILL_MIN = 0.5;

/** Score pops live in a fixed pool; more than this on screen at once is unreadable anyway. */
const MAX_POPS = 8;

/** Seconds a score pop is visible. */
const POP_LIFE = 1.15;

/** Largest simulation delta the HUD will integrate in one frame (tab-switch guard). */
const MAX_FRAME_DT = 0.25;

/**
 * The headline shown when the level's map scroll is picked up (ARCHITECTURE.md §4.8). Title case
 * because it is set in the gothic display face, which the menus also set in title case ("Paused",
 * "Options") — blackletter capitals in a row are hard to read.
 */
export const MAP_FOUND_TEXT = 'Map Found';

/** Seconds the "Map Found" banner stays up. Longer than a notice: it is a reward, not a hint. */
const MAP_FOUND_LIFE = 2.4;

/** Seconds a `notice(text)` stays up (§4.8: ~1.6 s). */
const NOTICE_LIFE = 1.6;

/**
 * The words under the fuel bar. Playtesters found the old `TANK` confusing: nothing on screen said
 * *what* was in the tank or that the torch burns it. `OIL` names the thing the flasks refill, and
 * sits beside the torch icon and the time left, so the panel reads "torch · oil · 1:16".
 */
const OIL_LABEL = 'OIL';

/** The label once flasks have been drunk this level: `OIL ×3`. Falls back to {@link OIL_LABEL}. */
const OIL_TALLY_PREFIX = 'OIL ×';

/** The label while the oil is low. Falls back to {@link LOW_SHORT_LABEL} where the bar is narrow. */
const LOW_OIL_LABEL = 'LOW OIL';

/** The low label on a bar too narrow for {@link LOW_OIL_LABEL}. */
const LOW_SHORT_LABEL = 'LOW';

/**
 * The one-time explanation of the fuel mechanic, raised shortly after the first level of a session
 * starts. Title case like the other notices (`'No Map - Find the Scroll'` in `src/main.js`).
 */
const OIL_HINT_TEXT = 'Your torch burns oil - grab flasks to refill';

/** {@link OIL_HINT_TEXT} for a view too narrow to hold it (a portrait phone). */
const OIL_HINT_SHORT = 'Torch burns oil - find flasks';

/** Seconds the oil hint stays up: it is a sentence to read, not a two-word notice. */
const OIL_HINT_LIFE = 4.5;

/** Raised the first time on each level the oil drops to the low mark. */
const LOW_OIL_TEXT = 'Torch Low - Find Oil';

/** Seconds the low-oil notice stays up. */
const LOW_OIL_LIFE = 2.2;

/** A banner's fade (and, with motion on, drop) in, in 64ths of a second (≈ 0.19 s). */
const BANNER_IN_64 = 12;

/** A banner's fade out at the end of its life, in 64ths of a second (0.4 s). */
const BANNER_OUT_64 = 26;

/** How long the "Map Found" plaque's gold edge flare lasts, in 64ths of a second (≈ 0.6 s). */
const BANNER_FLARE_64 = 38;

/** Banner kinds. */
const BANNER_NONE = 0;
const BANNER_MAP_FOUND = 1;
const BANNER_NOTICE = 2;

/**
 * A panel's painted frame, in borders: `drawPanel` draws a border **and** a bevel inside it, so the
 * stone a readout must clear is two borders thick, not one.
 */
const FRAME_BORDERS = 2;

/** Between the depth and the labyrinth size on the depth plaque. */
const DEPTH_SEPARATOR = '·';

/** The Auto Explore plaque's text (§4.10). */
const AUTO_TEXT = 'AUTO';

/** Font pixels either side of that separator — a glyph's worth, so "3 · 24×24" never reads "3·24". */
const DEPTH_GAP = 4;

/** Ink width of one HUD glyph at scale 1. */
const HUD_GLYPH_W = measureAt('0', 'hud', 1);

/** Pen advance of the monospace HUD face at scale 1 (glyph plus its spacing column). */
const HUD_ADVANCE = measureAt('00', 'hud', 1) - HUD_GLYPH_W;

/** Cap height of the HUD face in font rows (its 8-row cell less the descender row). */
const HUD_CAP_ROWS = 7;

/**
 * Width of an integer as `formatInt` prints it (`1,234,567`), without formatting it: the HUD face
 * is monospace, so the width is a function of the character count alone.
 * @param {number} n
 * @param {number} size text scale
 * @returns {number} UI pixels
 */
function intWidth(n, size) {
  const v = Number.isFinite(n) ? Math.floor(Math.abs(n)) : 0;
  let digits = 1;
  for (let x = v; x >= 10; x = Math.floor(x / 10)) digits++;
  const chars = digits + Math.floor((digits - 1) / 3) + (n < 0 ? 1 : 0);
  return ((chars - 1) * HUD_ADVANCE + HUD_GLYPH_W) * size;
}

/**
 * One floating "+100".
 * @typedef {Object} Pop
 * @property {number} t      seconds since it spawned; < 0 means free
 * @property {number} x      UI x at spawn
 * @property {number} y      UI y at spawn
 * @property {number} drift  horizontal drift in UI px over its life
 * @property {string} text   pre-formatted label
 * @property {string} color  a `FONT_STYLES` name
 * @property {0|1|2} icon    0 none, 1 gem, 2 oil flask
 */

/**
 * The HUD.
 * @typedef {Object} Hud
 * @property {(state:GameState, frameStats?:FrameStats|null, alpha?:number) => void} render
 * @property {(cssW:number, cssH:number, dpr?:number) => void} resize
 * @property {Surface} surface  the shared overlay surface
 * @property {(value:number, kind?:'score'|'fuel'|'gem') => void} pop  spawn a floating delta
 * @property {() => void} reset  forget animation state (level change, new run)
 * @property {(settings?:any) => MapMode} cycleMap  advance the map OFF → CORNER → FULL and return
 *   the new mode (the `map` hotkey; `src/main.js` then persists it — see the module header)
 * @property {(settings?:any) => MapMode} mapMode  the mode in force right now
 * @property {() => import('./map.js').MapStats} mapStats  live map cost accounting (reused object)
 * @property {(state:GameState|null|undefined) => boolean} mapLocked  true while this level's map
 *   scroll has not been found (`state.run.mapFound === false`, §4.8). A missing field reads as
 *   found, so an older state never locks. While locked the map draws nothing in any mode and the
 *   HUD lays out as for `'off'`; `mapMode()` still reports the player's preference.
 * @property {(text:string) => void} notice  show a short centred one-line notice (~1.6 s) — e.g.
 *   `'NO MAP - FIND THE SCROLL'` when the map hotkey is pressed while locked. Replaces whatever
 *   banner is up. Store a constant string: the HUD keeps the reference, it does not copy it.
 * @property {() => void} dispose
 */

/**
 * Create the HUD.
 *
 * @param {HTMLCanvasElement|null} overlayCanvas the overlay canvas (may be null in tests/tools)
 * @param {{minimap?:boolean|MapMode, map?:MapMode}} [options] `map` (or the legacy `minimap`)
 *   forces a map mode regardless of the settings — the preview harness uses it to shoot every mode.
 * @returns {Hud}
 */
export function createHud(overlayCanvas, options) {
  const surface = createSurface(overlayCanvas);
  /**
   * A forced map mode, or null to follow the settings. `minimap: true` is still accepted so an
   * older caller keeps working; it means "corner".
   * @type {MapMode|null}
   */
  const forcedMap =
    options === undefined
      ? null
      : typeof options.map === 'string'
        ? options.map
        : options.minimap === true
          ? 'corner'
          : typeof options.minimap === 'string'
            ? /** @type {MapMode} */ (options.minimap)
            : null;
  const mapView = createMapView();

  // ── Animation state ──
  const scoreCounter = createCounter(0);
  /**
   * The HUD's fractional per-frame numbers, as fields of one object rather than closure `let`s.
   *
   * WHY: a closure variable holding a non-integer is a boxed number, and every store boxes a new
   * one — six of them advanced every frame were ~80 bytes of garbage a frame on their own. An
   * object's number fields are updated in place.
   */
  const anim = {
    /** Last `state.time` seen (plus the interpolation offset); −1 before the first frame. */
    lastTime: -1,
    /** Seconds since boot, advanced by the clamped delta of `state.time`; see the file header. */
    clock: 0,
    /** Smoothed fuel fraction, so an oil pickup sweeps the bar up instead of snapping. */
    fuelShown: 1,
    /** 0..1 ramp that fades the whole HUD in when a level starts. */
    intro: 0,
    /**
     * Refill flare: 1 at the instant a flask lands, decaying to 0 over `REFILL_FLARE_TIME`. This is
     * the tank economy's whole feedback loop — the player must *feel* the tank fill, because the
     * thing they are managing is no longer a level timer but a chain of refuels.
     */
    refillFlare: 0,
    /** Bar fraction the last refill started from, so the surge can be drawn as a sweep. */
    refillFrom: 0,
  };
  let lastScore = 0;
  let lastFuel = 0;
  let lastGems = 0;
  let lastLevel = 0;
  /** Refuels taken this level (a fallback for when `state.run` does not carry the count). */
  let refuelCount = 0;

  // ── Oil hints ──
  /** Whether this HUD has explained the oil yet. Once per session: a reminder every run is nagging. */
  let oilHintShown = false;
  /** Whether the oil was at or under the low mark last frame (true fraction, not the smoothed bar). */
  let lastLowOil = false;
  /** Whether the low-oil notice has been raised on this level. */
  let lowOilNoticed = false;

  // ── Map scroll (§4.8) ──
  /** `run.mapFound` as last seen; the banner fires on its false → true edge only. */
  let lastMapFound = true;
  /** The level the map-found tracker was synced against; a new `levelData` resyncs, never fires. */
  /** @type {object|null} */
  let mapFoundLevel = null;
  /** Set by `reset()`: the next frame adopts `mapFound` as-is instead of reading a delta. */
  let mapFoundSync = true;
  /** Whether the last drawn frame had the map hidden by the lock, so unlocking can catch up. */
  let mapWasLocked = false;

  /**
   * The one banner slot, shared by "Map Found" and `notice()` — the newest wins, because two
   * centred banners stacked over the corridor are one too many.
   */
  const banner = { kind: BANNER_NONE, t: -1, life: 0, text: '' };
  // ── Panel geometry, recomputed once per frame by `layoutTopRow` ──
  // Every number below is in UI pixels. They live in the closure rather than in a returned box so
  // laying the top row out allocates nothing, and so the full map can read the gauge's box.
  /** Border thickness handed to `drawPanel`; the painted frame is `FRAME_BORDERS` of these. */
  let border = 1;
  /** Frame + padding between a panel's outer edge and its content, horizontally. */
  let insetX = 1;
  /** Frame + padding, vertically. */
  let insetY = 1;
  /** The fuel panel's box and its parts. */
  let fuelPanelW = 0;
  let fuelPanelH = 0;
  let fuelBarW = 0;
  let fuelBarH = 0;
  let fuelIconScale = 1;
  let fuelTextSize = 1;
  let fuelContentH = 0;
  /** The score panel's box and its parts. */
  let scorePanelW = 0;
  let scoreSize = 1;
  let gemSize = 1;
  let scoreContentH = 0;

  /** Options handed to `drawPanel`, mutated per call instead of a literal per call per frame. */
  /** @type {{frame:'stone'|'wood'|'iron', border:number, rivets:boolean, texture:boolean, alpha:number}} */
  const panelOpts = { frame: 'stone', border: 1, rivets: true, texture: false, alpha: 0.72 };

  // ── Readout text, rebuilt only when the number behind it changes (see the file header) ──
  const fuelText = createTextMemo((sec) => formatTime(sec));
  const refuelText = createTextMemo((n) => OIL_TALLY_PREFIX + n);
  const scoreText = createTextMemo((v) => formatInt(v));
  const gemsText = createTextMemo((g, t) => formatCount(g, t));
  const depthText = createTextMemo((lv) => formatDepth(lv));
  const sizeText = createTextMemo((c, r) => formatLabyrinth(c, r));
  const chalkText = createTextMemo((n) => '×' + n);

  /** @type {Pop[]} */
  const pops = new Array(MAX_POPS);
  for (let i = 0; i < MAX_POPS; i++) {
    pops[i] = { t: -1, x: 0, y: 0, drift: 0, text: '', color: 'hudBright', icon: 0 };
  }
  let popCursor = 0;

  /**
   * @param {number} value
   * @param {'score'|'fuel'|'gem'} [kind]
   * @returns {void}
   */
  function pop(value, kind) {
    const m = surface.metrics;
    const p = pops[popCursor];
    popCursor = (popCursor + 1) % MAX_POPS;
    p.t = 0;
    // Pops rise from just below the centre of the *world view*: close enough to the action to be
    // noticed, far enough down that they never sit over the crosshair region. The view, not the
    // surface — on a portrait phone the world is a band at 42 % of the height, and a pop centred on
    // the surface rose out of the band's bottom edge into the control deck.
    p.x = m.viewX + m.viewW * 0.5;
    p.y = m.viewY + m.viewH * 0.58;
    // Deterministic spread from the pool cursor — no RNG, no allocation, never two on top of
    // each other.
    p.drift = (popCursor % 2 === 0 ? 1 : -1) * (6 + (popCursor % 3) * 5) * m.u;
    if (kind === 'fuel') {
      p.text = '+' + formatTime(value);
      p.color = 'hudGold';
      p.icon = 2;
    } else if (kind === 'gem') {
      p.text = formatSigned(value);
      p.color = 'hudGem';
      p.icon = 1;
    } else {
      p.text = formatSigned(value);
      p.color = 'hudBright';
      p.icon = 0;
    }
  }

  /**
   * @returns {void}
   */
  function reset() {
    scoreCounter.snap(0);
    lastScore = 0;
    lastFuel = 0;
    lastGems = 0;
    anim.fuelShown = 1;
    anim.intro = 0;
    anim.refillFlare = 0;
    anim.refillFrom = 0;
    refuelCount = 0;
    lastLowOil = false;
    lowOilNoticed = false;
    for (let i = 0; i < MAX_POPS; i++) pops[i].t = -1;
    // A new run starts locked on a fresh level: that is not a discovery, so the next frame adopts
    // `mapFound` rather than comparing it against the old run's value.
    mapFoundSync = true;
    mapWasLocked = false;
    banner.kind = BANNER_NONE;
    banner.t = -1;
    mapView.reset();
  }

  /**
   * @param {GameState|null|undefined} state
   * @returns {boolean}
   */
  function mapLocked(state) {
    if (state === null || state === undefined || typeof state !== 'object') return false;
    const run = state.run;
    return run !== null && run !== undefined && /** @type {any} */ (run).mapFound === false;
  }

  /**
   * @param {string} text
   * @returns {void}
   */
  function notice(text) {
    if (typeof text !== 'string' || text === '') return;
    showNotice(text, NOTICE_LIFE);
  }

  /**
   * @param {string} text a constant string (the HUD keeps the reference)
   * @param {number} life seconds
   * @returns {void}
   */
  function showNotice(text, life) {
    banner.kind = BANNER_NOTICE;
    banner.text = text;
    banner.life = life;
    banner.t = 0;
  }

  /**
   * Explain the oil once, and warn when it runs low.
   *
   * The hint waits until the HUD has faded in on the first level of the session and the banner slot
   * is free, so it never replaces a notice the player asked for. The low warning fires on the
   * crossing into the low mark — once per level, and never on a level's first frame (a level that
   * *starts* low is not news) — and never over "Map Found", which is a reward worth reading.
   * @param {GameState} state
   * @param {boolean} levelChanged
   * @returns {void}
   */
  function trackOil(state, levelChanged) {
    const run = state.run;
    const low = run.fuelMax > 0 && run.fuel <= run.fuelMax * LOW_FUEL_FRACTION;
    if (levelChanged || state.phase !== 'playing') {
      if (levelChanged) lowOilNoticed = false;
      lastLowOil = low;
      return;
    }
    if (!oilHintShown && state.level === 1 && anim.intro >= 1 && banner.kind === BANNER_NONE) {
      oilHintShown = true;
      // The banner steps its text down to scale 1 and no further, so a sentence wider than the view
      // at scale 1 (its frame and margins included) would run off a phone: use the short form there.
      const m = surface.metrics;
      const fits = measureAt(OIL_HINT_TEXT, 'hud', 1) + 24 * m.u <= m.viewW;
      showNotice(fits ? OIL_HINT_TEXT : OIL_HINT_SHORT, OIL_HINT_LIFE);
    }
    if (low && !lastLowOil && !lowOilNoticed) {
      // A crossing under "Map Found" is held, not spent: leaving `lastLowOil` false re-offers it
      // every frame until the banner clears.
      if (banner.kind === BANNER_MAP_FOUND) return;
      lowOilNoticed = true;
      showNotice(LOW_OIL_TEXT, LOW_OIL_LIFE);
    }
    lastLowOil = low;
  }

  /**
   * Track `run.mapFound` and raise the "Map Found" banner on its false → true edge.
   *
   * Derived from the state, never from the `pickup` event, for the same reason as the score pops
   * (see `advance`). Three things resync the tracker without firing, so only a real pickup can:
   * a new `levelData` (`levelReady` installs the level and sets `mapFound` in one dispatch — to
   * false for a level with a scroll, to true for one without), a `reset()` (a new run), and any
   * frame outside `playing` (the scroll is only ever collected while playing).
   * @param {GameState} state
   * @returns {void}
   */
  function trackMapFound(state) {
    const found = !mapLocked(state);
    const level = state.levelData === undefined ? null : state.levelData;
    if (mapFoundSync || level !== mapFoundLevel || state.phase !== 'playing') {
      mapFoundSync = false;
      mapFoundLevel = level;
      lastMapFound = found;
      return;
    }
    if (found && !lastMapFound) {
      banner.kind = BANNER_MAP_FOUND;
      banner.text = MAP_FOUND_TEXT;
      banner.life = MAP_FOUND_LIFE;
      banner.t = 0;
    }
    lastMapFound = found;
  }

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
   * Advance every animation from the state's own clock.
   * @param {GameState} state
   * @param {number} alpha interpolation factor
   * @returns {void} (no return value: a fractional return from a call V8 does not inline is a boxed
   *   number, which was garbage every frame for a value nobody read)
   */
  function advance(state, alpha) {
    const now = state.time + (Number.isFinite(alpha) ? clamp01(alpha) : 0) / 60;
    let dt = anim.lastTime < 0 ? 0 : now - anim.lastTime;
    if (!(dt >= 0) || dt > MAX_FRAME_DT) dt = dt > MAX_FRAME_DT ? MAX_FRAME_DT : 0;
    anim.lastTime = now;
    anim.clock += dt;

    const run = state.run;

    // A new level (or a new run) resets the readouts rather than rolling them across the cut.
    const levelChanged = state.level !== lastLevel;
    if (levelChanged) {
      lastLevel = state.level;
      lastGems = run.gems;
      lastFuel = run.fuel;
      anim.fuelShown = run.fuelMax > 0 ? clamp01(run.fuel / run.fuelMax) : 0;
      anim.intro = 0;
      anim.refillFlare = 0;
      refuelCount = 0;
      for (let i = 0; i < MAX_POPS; i++) pops[i].t = -1;
    }
    if (run.score < lastScore) {
      // Score only ever decreases when a new run starts.
      scoreCounter.snap(run.score);
      lastScore = run.score;
    }

    // Score pops are derived from state deltas rather than from `state.events`, because the HUD
    // renders on frames, not on steps: an event array would be missed on a double-step frame and
    // replayed on a double-render one. A delta is idempotent and always exact.
    if (state.phase === 'playing') {
      const gained = run.score - lastScore;
      if (gained > 0) pop(gained, run.gems > lastGems ? 'gem' : 'score');
      const fuelGained = run.fuel - lastFuel;
      if (fuelGained > REFILL_MIN) {
        pop(fuelGained, 'fuel');
        // Arm the surge from wherever the bar currently *reads*, not from the true fuel: the bar
        // is smoothed, and the flare has to start where the eye last saw the level.
        anim.refillFrom = anim.fuelShown;
        anim.refillFlare = 1;
        refuelCount++;
      }
      if (anim.intro < 1) anim.intro = clamp01(anim.intro + dt * 2.2);
    } else if (state.phase === 'paused') {
      // Hold the intro at full while paused so resuming does not re-fade the HUD in.
      anim.intro = 1;
    }
    lastScore = run.score;
    lastFuel = run.fuel;
    lastGems = run.gems;

    scoreCounter.set(run.score);
    scoreCounter.update(dt);

    const fuelTarget = run.fuelMax > 0 ? clamp01(run.fuel / run.fuelMax) : 0;
    // Exponential smoothing; the constant is a rate in 1/s, chosen so a full flask sweeps the bar
    // up in roughly a third of a second.
    anim.fuelShown += (fuelTarget - anim.fuelShown) * (1 - Math.exp(-9 * dt));
    if (Math.abs(fuelTarget - anim.fuelShown) < 0.002) anim.fuelShown = fuelTarget;

    if (anim.refillFlare > 0) anim.refillFlare = Math.max(0, anim.refillFlare - dt / REFILL_FLARE_TIME);

    for (let i = 0; i < MAX_POPS; i++) {
      const p = pops[i];
      if (p.t < 0) continue;
      p.t += dt;
      if (p.t >= POP_LIFE) p.t = -1;
    }

    if (banner.t >= 0) {
      banner.t += dt;
      if (banner.t >= banner.life) {
        banner.t = -1;
        banner.kind = BANNER_NONE;
      }
    }
    // After the aging, so a banner raised this frame starts at t = 0.
    trackOil(state, levelChanged);
    trackMapFound(state);
  }

  /**
   * @param {GameState} state
   * @param {FrameStats|null} [frameStats]
   * @param {number} [alpha]
   * @returns {void}
   */
  function render(state, frameStats, alpha) {
    const ctx = surface.beginFrame();
    if (ctx === null || state === null || typeof state !== 'object') return;

    advance(state, alpha === undefined ? 0 : alpha);

    const phase = state.phase;
    if (phase !== 'playing' && phase !== 'paused') return;

    const m = surface.metrics;
    if (m.w < 32 || m.h < 32) return;

    // The HUD dims behind the pause menu instead of vanishing: the player is still reading it.
    const globalAlpha = (phase === 'paused' ? 0.45 : 1) * (0.25 + 0.75 * anim.intro);
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * globalAlpha;

    const reduced = state.settings !== undefined && state.settings.reducedMotion === true;
    // Until this level's map scroll is found (§4.8) the map does not exist: no corner window, no
    // full map, and every layout below behaves exactly as for 'off'. The player's chosen mode is
    // untouched, so the map returns in that mode the moment the scroll is picked up.
    const locked = mapLocked(state);
    const mode = locked ? 'off' : forcedMap !== null ? forcedMap : readMapMode(state.settings);

    // The raster is maintained before anything is drawn, so the map and the "% mapped" readout
    // agree within the same frame. It is skipped entirely when the map is off — switching it back
    // on costs one rescan, not a frame of stale pixels. Coming out of the lock forces that rescan
    // explicitly rather than trusting the stale-gap timer, so everything explored while the map
    // was hidden is on the raster on the unlock frame itself — once, not per frame.
    if (mapWasLocked && !locked) mapView.invalidate();
    mapWasLocked = locked;
    if (mode !== 'off') mapView.update(state, anim.clock);

    // The full map takes the screen: drawing the play HUD under it would be noise over a diagram,
    // so only the gauges that answer "can I afford to stand here reading this" stay.
    // Measure the top row before anything is drawn: the full map needs the gauge's box to lay its
    // header out clear of it, and the corner panels share one height.
    layoutTopRow(state, m, mode !== 'full');

    if (mode === 'full') {
      // The map's ground covers the whole surface, so the gauge is drawn *after* it — but the map
      // needs the gauge's box first (beside it on a wide screen, under it on a phone), which is
      // why the measurement above is separate from the drawing.
      mapView.drawFull(ctx, m, state, anim.clock, reduced, 3 * m.u + fuelPanelW, 3 * m.u + fuelPanelH);
      drawFuelGauge(ctx, state, m, reduced);
      // No score pops over the full map: the player opened a diagram in order to read it, and a
      // pop is drawn at the *centre* of the screen, straight across the corridors they are
      // tracing. The gauge is the one readout the argument above keeps. A banner is the exception:
      // it is short-lived, and "Map Found" lands exactly when the full map snaps open.
      drawBanner(ctx, m, reduced);
      if (isDebug()) drawDebug(ctx, state, m, frameStats === undefined ? null : frameStats);
      ctx.globalAlpha = prevAlpha;
      return;
    }

    drawFuelGauge(ctx, state, m, reduced);
    drawScorePanel(ctx, state, m);
    drawDepthPanel(ctx, state, m);
    drawPerkChips(ctx, state, m, reduced);
    drawAutoChip(ctx, state, m, reduced);
    drawLodestone(ctx, state, m, reduced);
    if (mode === 'corner') mapView.drawCorner(ctx, m, state, anim.clock, reduced);
    drawPops(ctx, m, reduced);
    drawBanner(ctx, m, reduced);
    if (isDebug()) drawDebug(ctx, state, m, frameStats === undefined ? null : frameStats);

    ctx.globalAlpha = prevAlpha;
  }

  /**
   * The centred one-line banner: "Map Found" in gold gothic lettering on a timber plaque, or a
   * `notice()` in the HUD face on stone.
   *
   * It sits in the upper part of the **world view** (not the surface — a portrait phone's world is
   * a band) where it reads without covering the crosshair region or the pops rising from below
   * centre. It fades in and out; with motion on it also drops a few pixels into place and the
   * "Map Found" plaque's edge flares gold for its first moments. Reduced motion keeps the fades
   * only. Allocation-free: the text is a stored reference and the panel options object is reused.
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawBanner(ctx, m, reduced) {
    if (banner.t < 0 || banner.kind === BANNER_NONE) return;
    const u = m.u;
    // Every animated quantity is taken in integer 64ths here: a fractional value handed across a
    // call V8 does not inline is a boxed number, i.e. garbage every frame the banner is up.
    const t64 = (banner.t * 64) | 0;
    // Starts at a quarter rather than at zero, so the frame that raised it already shows it.
    const in64 = t64 < BANNER_IN_64 ? 16 + ((48 * t64) / BANNER_IN_64) | 0 : 64;
    const left64 = ((banner.life - banner.t) * 64) | 0;
    const out64 = left64 < BANNER_OUT_64 ? ((64 * left64) / BANNER_OUT_64) | 0 : 64;
    const alpha64 = in64 < out64 ? in64 : out64;
    if (alpha64 <= 0) return;

    const gothic = banner.kind === BANNER_MAP_FOUND;
    const font = gothic ? 'display' : 'hud';
    const maxW = Math.max(16 * u, m.viewW - 12 * u);
    // Largest integer scale whose plaque fits the view: 2u for the headline on a desktop, a unit
    // for a notice; stepped down on a phone.
    let size = gothic ? (m.narrow ? u : 2 * u) : m.narrow ? Math.max(1, u - 1) : u;
    const frame = Math.max(1, m.narrow ? u - 1 : u);
    // Clear space inside the painted frame (`FRAME_BORDERS` borders) for the lettering's ink: the
    // display face carries an outline all round plus a two-pixel shadow, the HUD face a one-pixel
    // shadow — both scale with the text.
    let padX = 0;
    let padY = 0;
    for (;;) {
      const ink = gothic ? 2 * size : size;
      padX = FRAME_BORDERS * frame + ink + 3 * u;
      padY = FRAME_BORDERS * frame + ink + u;
      if (size <= 1 || measureAt(banner.text, font, size) + 2 * padX <= maxW) break;
      size--;
    }
    const textW = measureAt(banner.text, font, size);
    const textH = heightAt(font, size);
    const w = textW + 2 * padX;
    const h = textH + 2 * padY;
    const x = m.viewX + ((m.viewW - w) >> 1);
    const drop = reduced || in64 >= 64 ? 0 : ((64 - in64) * 6 * u) >> 6;
    const y = m.viewY + ((m.viewH * 13) >> 6) - drop;

    // The context alpha is only touched while fading: once the banner is fully up it costs no
    // floating-point load or store at all (a double read off the context is a fresh heap number
    // in V8's lower tiers).
    const fading = alpha64 < 64;
    const before = fading ? ctx.globalAlpha : 1;
    if (fading) ctx.globalAlpha = (before * alpha64) / 64;
    panelOpts.frame = gothic ? 'wood' : 'stone';
    panelOpts.border = frame;
    panelOpts.rivets = gothic;
    drawPanel(ctx, x, y, w, h, u, panelOpts);
    if (gothic && !reduced && t64 < BANNER_FLARE_64) {
      ctx.fillStyle = withAlphaStep(COLOR.goldLight, ((BANNER_FLARE_64 - t64) * 58) / BANNER_FLARE_64 | 0);
      strokeRect(ctx, x, y, w, h, Math.max(1, u));
    }
    drawAt(ctx, banner.text, x + (w >> 1), y + padY, font, size, gothic ? 'gothic' : 'hudBright', 'center');
    if (fading) ctx.globalAlpha = before;
  }

  /**
   * Lay out the top row — the fuel panel and the score panel — without drawing it.
   *
   * Pure arithmetic on the metrics and the run, writing closure fields rather than allocating a
   * box, so the full map can reserve space for the gauge before the gauge is drawn over it, and so
   * the two corner panels can share one height (two plaques of different heights in the same row
   * read as an accident).
   *
   * **Padding.** `drawPanel` paints a border *and* a bevel, so its frame is `FRAME_BORDERS` borders
   * thick; content starts `insetX`/`insetY` in from the outer edge — the whole frame plus 3u (2u on a
   * phone) of clear space. The first version allowed ~4u for a 2u frame, so a readout's shadow sat on
   * the bevel on desktop and the depth panel's last line ran over its bottom frame on a phone.
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @param {boolean} withScore false while the full map is open (only the gauge is drawn)
   * @returns {void}
   */
  function layoutTopRow(state, m, withScore) {
    const u = m.u;
    const pad = 3 * u;
    // A phone's panels get a thinner frame: at u = 3 a full-unit border is 6 UI pixels of stone —
    // 30 device pixels — around a readout that is itself only a few characters wide.
    border = m.narrow ? Math.max(1, u - 1) : u;
    insetX = FRAME_BORDERS * border + (m.narrow ? 2 * u : 3 * u);
    insetY = FRAME_BORDERS * border + 2 * u;

    // ── Fuel ──
    fuelIconScale = m.narrow ? Math.max(1, u - 1) : u;
    fuelTextSize = m.narrow ? Math.max(1, u - 1) : u;
    fuelBarH = (m.narrow ? 5 : 7) * u;
    const iconW = ICON_SIZE.flameW * fuelIconScale;
    const iconH = ICON_SIZE.torchH * fuelIconScale;
    const fixedW = 2 * insetX + iconW + 3 * u;
    // On a narrow surface the gauge and the score panel share one row, and the score panel needs
    // more than half of it — so the whole gauge is capped at 44 % of the width rather than being
    // allowed to slide under the score (measured at 390×844: the two used to overlap).
    const cap = m.narrow ? Math.floor(m.w * 0.44) - fixedW : Infinity;
    fuelBarW = Math.round(Math.max(8 * u, Math.min(64 * u, Math.max(20 * u, m.w * 0.28), cap)));
    fuelPanelW = fixedW + fuelBarW;
    fuelContentH = Math.max(iconH, fuelBarH + 2 * u + heightAt('hud', fuelTextSize));

    // ── Score ──
    scoreContentH = 0;
    scorePanelW = 0;
    if (withScore) {
      const run = state.run;
      const scoreLine = scoreText(scoreCounter.value);
      const gemsLine = gemsText(run.gems, run.gemsTotal);
      if (m.narrow) {
        // Fitted to the room the gauge leaves: with the massive-maze item counts the gem line is
        // "8/820" rather than "8/12".
        scoreSize = Math.max(1, u - 1);
        gemSize = scoreSize;
        const room = m.w - 3 * pad - fuelPanelW - 2 * insetX;
        for (;;) {
          const need = Math.max(scoreWidth(scoreLine, run.score, scoreSize), gemsWidth(gemsLine, gemSize));
          if (need <= room) break;
          if (scoreSize > gemSize && scoreSize > 1) scoreSize--;
          else if (gemSize > 1) gemSize--;
          else if (scoreSize > 1) scoreSize--;
          else break;
        }
      } else {
        // One step above the gem line, whatever the score. It used to be 2u until the number took a
        // quarter of the screen and u from then on, so at 1280×720 the readout halved in size in the
        // middle of a run as it crossed ~100,000 — which looked like a glitch. At u + 1 a seven-figure
        // score still takes about a quarter of the width, and the tank the player is actually
        // managing stays the heavier panel.
        gemSize = u;
        scoreSize = u + 1;
      }
      scoreContentH = heightAt('hud', scoreSize) + u + heightAt('hud', gemSize);
      scorePanelW =
        2 * insetX +
        Math.max(scoreWidth(scoreLine, run.score, scoreSize), gemsWidth(gemsLine, gemSize), 16 * u);
    }
    fuelPanelH = 2 * insetY + Math.max(fuelContentH, scoreContentH);
  }

  /**
   * Width of the score readout: the wider of what is showing and what it is rolling to, so the
   * panel grows once when a digit arrives instead of breathing while the counter rolls.
   * @param {string} line the rolling value, formatted
   * @param {number} target the true score
   * @param {number} size
   * @returns {number}
   */
  function scoreWidth(line, target, size) {
    return Math.max(measureAt(line, 'hud', size), intWidth(target, size));
  }

  /**
   * Width of the gem line: icon, a gap and the count.
   * @param {string} line
   * @param {number} size
   * @returns {number}
   */
  function gemsWidth(line, size) {
    return measureAt(line, 'hud', size) + (ICON_SIZE.gem + 2) * size;
  }

  /**
   * Top-left: the torch **tank** — torch icon, segmented bar with quarter-tank ticks, the `OIL`
   * label (`OIL ×N` flasks drunk where there is room, `LOW OIL` when low), remaining time.
   *
   * WHY it is drawn as a tank and not as a timer: `fuelMax` no longer scales with the maze, so the
   * bar is a small vessel the player refills every 60–90 s rather than a countdown to the exit.
   * Three things carry that reading: the quarter ticks (a tank has graduations), the refill surge
   * (a flask visibly *fills* it — the bar sweeps up from where it was with a hot leading edge and
   * the panel flares), and the low-tank alarm (the frame pulses red, the flame cools, a LOW chip
   * appears) which now recurs many times per level instead of once per run.
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @param {boolean} reduced reduced motion
   * @returns {void}
   */
  function drawFuelGauge(ctx, state, m, reduced) {
    const u = m.u;
    const pad = 3 * u;
    const iconW = ICON_SIZE.flameW * fuelIconScale;
    const iconH = ICON_SIZE.torchH * fuelIconScale;
    const barW = fuelBarW;
    const barH = fuelBarH;
    const panelW = fuelPanelW;
    const panelH = fuelPanelH;

    const low = anim.fuelShown <= LOW_FUEL_FRACTION;
    const flare = reduced ? 0 : anim.refillFlare;
    // The flame flickers on its own cycle; when the tank is low it stutters, which is the first
    // cue the player gets that the next flask has become urgent.
    // The flicker noise (two incommensurable sines) is written out here: a fractional argument per
    // frame to a call that is not inlined is a boxed number per frame.
    const nt = anim.clock * (low ? 17 : 9);
    const flicker = reduced ? 0.5 : 0.5 + 0.25 * Math.sin(nt) + 0.25 * Math.sin(nt * 1.7 + 1.3);
    const frame = reduced ? 0 : ((anim.clock * (low ? 14 : 8)) | 0) % 3;

    panelOpts.frame = 'stone';
    panelOpts.border = border;
    panelOpts.rivets = true;
    drawPanel(ctx, pad, pad, panelW, panelH, u, panelOpts);
    // Alarm and flare both live on the panel edge, where they are visible in peripheral vision:
    // the player is looking down a corridor, not at the gauge.
    if (low && !reduced) {
      const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(anim.clock * 6));
      ctx.fillStyle = withAlphaStep(COLOR.alarm, (pulse * 0.7 * 64) | 0);
      strokeRect(ctx, pad, pad, panelW, panelH, Math.max(1, border >> 1));
    } else if (flare > 0) {
      ctx.fillStyle = withAlphaStep(COLOR.fireCore, (flare * 0.8 * 64) | 0);
      strokeRect(ctx, pad, pad, panelW, panelH, Math.max(1, border >> 1));
    }

    // Content is centred vertically in the shared row height.
    const top = pad + insetY + ((panelH - 2 * insetY - fuelContentH) >> 1);
    const iconX = pad + insetX;
    const iconY = top + ((fuelContentH - iconH) >> 1);
    // A refill relights the torch: the icon goes to full strength for the length of the flare
    // however low the tank was, which is the reward for the pickup.
    drawTorchIcon(ctx, iconX, iconY, fuelIconScale, frame, low && flare < 0.2 ? 0.3 : 1);

    // Bar well.
    const barX = iconX + iconW + 3 * u;
    const barY = top;
    drawWell(ctx, barX, barY, barW, barH, u, COLOR.void, low ? COLOR.fireDeep : COLOR.ironDark);

    const inner = barW - 2 * u;
    const gap = Math.max(1, u >> 1);
    // The surge: for the length of the flare the bar is drawn as if it were still filling, so the
    // eye sees the level *travel* even though the state changed in a single step.
    const surge = flare > 0 ? anim.refillFrom + (anim.fuelShown - anim.refillFrom) * (1 - flare * flare) : anim.fuelShown;
    const shown = flare > 0 ? Math.min(anim.fuelShown, surge) : anim.fuelShown;
    const lit = shown * FUEL_SEGMENTS;
    const fullSegs = Math.floor(lit);
    for (let i = 0; i < FUEL_SEGMENTS; i++) {
      // Segment edges are derived from the exact fraction rather than from a floored width, so the
      // sixteen of them fill the well to the pixel at any bar size.
      const sx = barX + u + Math.round((i * inner) / FUEL_SEGMENTS);
      const segW = Math.max(
        1,
        barX + u + Math.round(((i + 1) * inner) / FUEL_SEGMENTS) - sx - gap,
      );
      if (i < fullSegs) {
        // Solid part of the flame: hotter at the base of the bar, cooler at the tip, so the gauge
        // reads like burning fuel rather than a health bar.
        const t = i / FUEL_SEGMENTS;
        const leadingEdge = flare > 0 && i === fullSegs - 1;
        ctx.fillStyle = leadingEdge
          ? COLOR.fireCore
          : low
            ? i === fullSegs - 1 && !reduced && flicker > 0.55
              ? COLOR.fireMid
              : COLOR.alarm
            : t < 0.55
              ? COLOR.fireMid
              : COLOR.fireHot;
        ctx.fillRect(sx, barY + u, segW, barH - 2 * u);
        // Highlight the top row of each lit segment.
        ctx.fillStyle = low && flare <= 0 ? COLOR.fireEmber : COLOR.fireCore;
        ctx.fillRect(sx, barY + u, segW, gap);
      } else if (i === fullSegs) {
        // The burning edge: a partial segment whose brightness flickers.
        const frac = lit - fullSegs;
        if (frac > 0.08) {
          const wSeg = Math.max(1, Math.round(segW * frac));
          ctx.fillStyle =
            flare > 0 ? COLOR.fireCore : low ? COLOR.alarm : flicker > 0.5 ? COLOR.fireHot : COLOR.fireEmber;
          ctx.fillRect(sx, barY + u, wSeg, barH - 2 * u);
        }
      }
      // Quarter-tank graduations, drawn over the segments so a full bar still shows them.
      if (i > 0 && i % FUEL_TICK_EVERY === 0) {
        ctx.fillStyle = withAlpha(COLOR.void, 0.75);
        ctx.fillRect(sx - gap, barY + u, Math.max(1, gap), barH - 2 * u);
      }
    }

    // Under the bar: how much is left (right, where the eye goes first) and how many flasks this
    // level has cost (left) — the two numbers the refill economy is played on.
    const run = state.run;
    // Siphon (§4.9): the stored overflow is a thin pale line along the well's floor, so the tank
    // still reads as a tank and the reserve as "more, waiting".
    const perks = /** @type {any} */ (state).perks;
    if (perks && perks.siphonCap > 0 && run.reserve > 0) {
      const reserveW = Math.max(u, Math.round((inner * Math.min(run.reserve, perks.siphonCap)) / perks.siphonCap));
      const lineH = Math.max(1, u);
      ctx.fillStyle = COLOR.void;
      ctx.fillRect(barX + u, barY + barH - u - lineH - 1, inner, lineH + 1);
      ctx.fillStyle = COLOR.oilPale;
      ctx.fillRect(barX + u, barY + barH - u - lineH, reserveW, lineH);
    }
    const textY = barY + barH + 2 * u;
    const size = fuelTextSize;
    // Keyed on whole seconds, the resolution `formatTime` prints at.
    const timeText = fuelText(Math.floor(run.fuel));
    drawAt(ctx, timeText, barX + barW, textY, 'hud', size, low ? 'hudAlarm' : flare > 0 ? 'hudBright' : 'hudDim', 'right');
    const refuels = refuelsOf(state);
    // "OIL" until the first flask, then "OIL ×N" — the flasks drunk this level — and "LOW OIL" when
    // it is time to find one. Where the bar is too narrow for the long form the short one is used,
    // and the word is dropped rather than allowed to collide with the clock (a phone may have room
    // for neither).
    // At least two blank glyphs between the label and the clock: "OIL ×4 1:16" read as one number.
    const labelGap = Math.max(3 * u, 2 * HUD_ADVANCE * size);
    const timeW = measureAt(timeText, 'hud', size) + labelGap;
    let tankLabel = low ? LOW_OIL_LABEL : refuels > 0 ? refuelText(refuels) : OIL_LABEL;
    let labelW = measureAt(tankLabel, 'hud', size);
    if (labelW + timeW > barW) {
      tankLabel = low ? LOW_SHORT_LABEL : OIL_LABEL;
      labelW = measureAt(tankLabel, 'hud', size);
    }
    if (labelW + timeW <= barW) {
      drawAt(ctx, tankLabel, barX, textY, 'hud', size, low ? 'hudAlarm' : 'hudDim');
      return;
    }
    // No room for the word (a phone at dpr 3 — the most common phone there is): the flask icon says
    // the same thing in a third of the width, so the gauge is never an unlabelled bar and a clock.
    // The largest whole scale whose flask clears the clock (by a unit less one: the phone that needs
    // this has exactly that to spare), centred on the digits' cap.
    const clockW = measureAt(timeText, 'hud', size);
    for (let s = size; s >= 1; s--) {
      if (ICON_SIZE.oilW * s + Math.max(2, u - 1) + clockW > barW) continue;
      const flaskY = textY + ((HUD_CAP_ROWS * size - ICON_SIZE.oilH * s) >> 1);
      // Reported to the layout audits like a line of text: it stands in for one.
      probeLayout('art', barX, flaskY, ICON_SIZE.oilW * s, ICON_SIZE.oilH * s, s, 'oil-flask');
      drawOilIcon(ctx, barX, flaskY, s);
      break;
    }
  }

  /**
   * Refuels taken on this level.
   *
   * Prefers the sim's own count (`run.refuels`) when `src/state` carries one — see the integrator
   * note in this wave's report — and otherwise falls back to the HUD's own tally of fuel rises,
   * which is exact for every pickup the HUD has actually rendered through.
   * @param {GameState} state
   * @returns {number}
   */
  function refuelsOf(state) {
    const fromRun = /** @type {any} */ (state.run).refuels;
    return typeof fromRun === 'number' && Number.isFinite(fromRun) ? Math.max(0, fromRun | 0) : refuelCount;
  }

  /**
   * Top-right: rolling score and the gem tally, sized by {@link layoutTopRow}.
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @returns {void}
   */
  function drawScorePanel(ctx, state, m) {
    const u = m.u;
    const pad = 3 * u;
    const run = state.run;
    const scoreLine = scoreText(scoreCounter.value);
    const gemsLine = gemsText(run.gems, run.gemsTotal);
    const px = m.w - pad - scorePanelW;

    panelOpts.frame = 'stone';
    panelOpts.border = border;
    panelOpts.rivets = true;
    drawPanel(ctx, px, pad, scorePanelW, fuelPanelH, u, panelOpts);

    const right = px + scorePanelW - insetX;
    const top = pad + insetY + ((fuelPanelH - 2 * insetY - scoreContentH) >> 1);
    drawAt(ctx, scoreLine, right, top, 'hud', scoreSize, 'hudGold', 'right');
    const gemY = top + heightAt('hud', scoreSize) + u;
    drawAt(ctx, gemsLine, right, gemY, 'hud', gemSize, 'hudGem', 'right');
    drawGemIcon(ctx, right - gemsWidth(gemsLine, gemSize), gemY, gemSize);
  }

  /**
   * Top-centre: which depth this is and how big its labyrinth is — **one line**, `DEPTH 4 · 40×40`.
   *
   * The size is not decoration: `16×16` and `128×128` are two different games, and a player who has
   * just descended needs to know which one they are standing in without opening the map. The
   * level clock and the mapped share used to ride along on two more lines; they now live where a
   * player goes to read them (the full map and the pause screen), because a four-line plaque in the
   * middle of the top row made it the heaviest panel on screen for the least actionable facts.
   *
   * On a wide surface it is centred between the corner panels (or tucks under the gauge when a
   * narrow window leaves no gap). On a phone it sits in the column under the gauge — the column is
   * all it may use, because the touch overlay's MAP/PAUSE bar sits under the score panel — splitting
   * onto two lines when one does not fit, and shrinking until it ends above the world band.
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @returns {void}
   */
  function drawDepthPanel(ctx, state, m) {
    const u = m.u;
    const pad = 3 * u;
    const level = state.levelData;
    const hasMaze = level !== null && level !== undefined && level.maze !== undefined;
    const depth = depthText(state.level);
    const dims = hasMaze ? sizeText(level.maze.cols, level.maze.rows) : '';

    let size = m.narrow ? Math.max(1, u - 1) : u;
    let twoLines = false;
    let px = 0;
    let py = pad;
    let panelW = 0;
    let panelH = 0;
    if (!m.narrow) {
      // Centred in the gap between the corner panels, at the largest size that fits there.
      const gapL = pad + fuelPanelW + 2 * u;
      const gapR = m.w - pad - scorePanelW - 2 * u;
      for (;;) {
        panelW = 2 * insetX + depthLineWidth(depth, dims, size);
        px = Math.round((m.w - panelW) / 2);
        if ((px >= gapL && px + panelW <= gapR) || size <= Math.max(1, u - 1)) break;
        size--;
      }
      if (px < gapL || px + panelW > gapR) {
        // No gap at all (a 4:3 window near the narrow boundary): under the gauge instead.
        px = pad;
        py = pad + fuelPanelH + 2 * u;
      }
      panelH = 2 * insetY + heightAt('hud', size);
    } else {
      const column = fuelPanelW;
      // The band's top edge, when the page has told the surface where the world is.
      const floor = m.viewY > py + fuelPanelH ? m.viewY - 2 * u : m.h;
      py = pad + fuelPanelH + 2 * u;
      for (;;) {
        const oneW = 2 * insetX + depthLineWidth(depth, dims, size);
        twoLines = hasMaze && oneW > column;
        panelW = twoLines
          ? 2 * insetX + Math.max(measureAt(depth, 'hud', size), measureAt(dims, 'hud', size))
          : oneW;
        panelH = 2 * insetY + (twoLines ? 2 * heightAt('hud', size) + u : heightAt('hud', size));
        if ((panelW <= column && py + panelH <= floor) || size <= 1) break;
        size--;
      }
      px = pad;
    }

    panelOpts.frame = 'wood';
    panelOpts.border = border;
    panelOpts.rivets = false;
    drawPanel(ctx, px, py, panelW, panelH, u, panelOpts);
    const cx = px + (panelW >> 1);
    const top = py + insetY;
    if (twoLines) {
      drawAt(ctx, depth, cx, top, 'hud', size, 'hudGold', 'center');
      drawAt(ctx, dims, cx, top + heightAt('hud', size) + u, 'hud', size, 'hudBright', 'center');
      return;
    }
    // One line in three runs — depth in gold, a quiet separator, the size in bright — laid out from
    // the measured widths so the group is centred as a whole.
    let x = cx - (depthLineWidth(depth, dims, size) >> 1);
    drawAt(ctx, depth, x, top, 'hud', size, 'hudGold');
    if (dims === '') return;
    x += measureAt(depth, 'hud', size) + DEPTH_GAP * size;
    drawAt(ctx, DEPTH_SEPARATOR, x, top, 'hud', size, 'hudDim');
    x += measureAt(DEPTH_SEPARATOR, 'hud', size) + DEPTH_GAP * size;
    drawAt(ctx, dims, x, top, 'hud', size, 'hudBright');
  }

  /**
   * Bottom-left of the world view: the unlock readouts that need one (§4.9) — the chalk charges
   * left on this level, and the Scroll Sense plaque, whose scroll glows and whose frame beats faster
   * the nearer the unfound map scroll is. Nothing is drawn for a player without those unlocks, so the
   * first-floor HUD is exactly the one it always was.
   *
   * In the world band rather than the top row: the top row is full on a phone, and a thumb on the
   * virtual stick sits below the band, not over its corner.
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawPerkChips(ctx, state, m, reduced) {
    const perks = /** @type {any} */ (state).perks;
    if (!perks) return;
    const run = state.run;
    const showChalk = perks.chalk > 0;
    const showSense = perks.scrollSense > 0 && run.mapFound === false;
    if (!showChalk && !showSense) return;
    const u = m.u;
    const size = m.narrow ? Math.max(1, u - 1) : u;
    const iconW = UNLOCK_ICON * size;
    const chipH = 2 * insetY + Math.max(iconW, heightAt('hud', size));
    const y = m.viewY + m.viewH - 3 * u - chipH;
    let x = m.viewX + 3 * u;
    panelOpts.frame = 'stone';
    panelOpts.border = border;
    panelOpts.rivets = false;
    if (showChalk) {
      const charges = run.chalk > 0 ? run.chalk | 0 : 0;
      const text = chalkText(charges);
      const w = 2 * insetX + iconW + 2 * u + measureAt(text, 'hud', size);
      drawPanel(ctx, x, y, w, chipH, u, panelOpts);
      drawUnlockIcon(ctx, 'chalk', x + insetX, y + ((chipH - iconW) >> 1), size);
      drawAt(ctx, text, x + insetX + iconW + 2 * u, y + (chipH >> 1), 'hud', size, charges > 0 ? 'hudBright' : 'hudDim', 'left', 'middle');
      x += w + 2 * u;
    }
    if (showSense) {
      // 0 out of range → 64 standing on it. Integer 64ths throughout (see `drawBanner`).
      const sense = /** @type {any} */ (state.derived).scrollSense;
      const near64 = Number.isFinite(sense) ? Math.max(0, Math.min(64, (sense * 64) | 0)) : 0;
      const w = 2 * insetX + iconW;
      drawPanel(ctx, x, y, w, chipH, u, panelOpts);
      const beat64 = reduced ? 64 : (32 + 32 * Math.sin(anim.clock * (2 + (near64 * 9) / 64))) | 0;
      const glow64 = (near64 * beat64) >> 6;
      const before = ctx.globalAlpha;
      // Out of range the scroll is a dim outline of itself; in range it brightens toward full.
      ctx.globalAlpha = before * (0.3 + (0.7 * (near64 > glow64 ? glow64 : near64)) / 64);
      drawUnlockIcon(ctx, 'scrollSense', x + insetX, y + ((chipH - iconW) >> 1), size);
      ctx.globalAlpha = before;
      if (glow64 > 4) {
        ctx.fillStyle = withAlphaStep(COLOR.goldLight, glow64);
        strokeRect(ctx, x, y, w, chipH, Math.max(1, border >> 1));
      }
    }
  }

  /**
   * Auto Explore (§4.10): while the autopilot has the level, a small AUTO plaque sits at the bottom
   * centre of the world band, breathing slowly, so a player who walks back to the screen knows at a
   * glance that nobody is at the keys.
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawAutoChip(ctx, state, m, reduced) {
    if (state.settings === undefined || state.settings.autoExplore !== true || state.phase !== 'playing') return;
    const u = m.u;
    const size = m.narrow ? Math.max(1, u - 1) : u;
    const chipH = 2 * insetY + heightAt('hud', size);
    const w = 2 * insetX + measureAt(AUTO_TEXT, 'hud', size);
    const x = m.viewX + ((m.viewW - w) >> 1);
    const y = m.viewY + m.viewH - 3 * u - chipH;
    panelOpts.frame = 'stone';
    panelOpts.border = border;
    panelOpts.rivets = false;
    drawPanel(ctx, x, y, w, chipH, u, panelOpts);
    const before = ctx.globalAlpha;
    if (!reduced) ctx.globalAlpha = before * (0.7 + 0.3 * Math.sin(anim.clock * 2.4));
    drawAt(ctx, AUTO_TEXT, x + (w >> 1), y + (chipH >> 1), 'hud', size, 'hudGold', 'center', 'middle');
    ctx.globalAlpha = before;
  }

  /**
   * Lodestone (§4.9): once this level's map is found, a needle under the top row points toward the
   * exit relative to where the player faces — straight up means straight ahead. Eight headings from
   * the map's own pixel arrows: a bearing, never a route, so the maze still has to be walked.
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawLodestone(ctx, state, m, reduced) {
    const perks = /** @type {any} */ (state).perks;
    if (!perks || !(perks.lodestone > 0) || state.run.mapFound !== true) return;
    const level = state.levelData;
    if (level === null || level === undefined || level.maze === undefined) return;
    const p = state.player;
    const exit = level.maze.exit;
    const dx = exit.x + 0.5 - p.x;
    const dy = exit.y + 0.5 - p.y;
    if (dx * dx + dy * dy < 1) return;
    // Screen convention: forward is up. `ARROWS` is indexed with 0 = east and +y down, so the
    // relative bearing is turned a quarter back before it is rounded to one of eight.
    const rel = Math.atan2(dy, dx) - p.angle - Math.PI / 2;
    const idx = Math.round(rel / (Math.PI / 4)) & 7;
    const u = m.u;
    const scale = m.narrow ? Math.max(1, u - 1) : u;
    const artW = ICON_SIZE.arrow * scale;
    const box = artW + 2 * insetY;
    const x = m.viewX + ((m.viewW - box) >> 1);
    const top = m.narrow ? m.viewY + 2 * u : Math.max(m.viewY + 2 * u, 3 * u + fuelPanelH + 2 * u);
    const bob = reduced ? 0 : Math.round(Math.sin(anim.clock * 2.4) * 0.5 * u);
    panelOpts.frame = 'iron';
    panelOpts.border = border;
    panelOpts.rivets = false;
    drawPanel(ctx, x, top, box, box, u, panelOpts);
    drawArt(ctx, NEEDLE_ARROWS[idx], x + insetY, top + insetY + bob, scale, NEEDLE_PALETTE);
  }

  /**
   * Width of `DEPTH n · C×R` drawn as three runs (see {@link drawDepthPanel}).
   * @param {string} depth
   * @param {string} dims empty when no maze is loaded
   * @param {number} size
   * @returns {number}
   */
  function depthLineWidth(depth, dims, size) {
    const w = measureAt(depth, 'hud', size);
    if (dims === '') return w;
    return w + 2 * DEPTH_GAP * size + measureAt(DEPTH_SEPARATOR, 'hud', size) + measureAt(dims, 'hud', size);
  }

  /**
   * Floating score pops.
   * @param {CanvasRenderingContext2D} ctx
   * @param {SurfaceMetrics} m
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawPops(ctx, m, reduced) {
    const u = m.u;
    // A pop is sized against the **surface**, not against the layout unit. `u + 1` is a fraction
    // of a desktop's 640 UI pixels and a quarter of a phone's 234, so "+1,500" arrived four times
    // its relative desktop size on a phone; `m.w / 90` keeps it the same share of the screen and
    // the old value stays the ceiling.
    const size = clamp(Math.round(m.w / 90), 1, u + 1);
    for (let i = 0; i < MAX_POPS; i++) {
      const p = pops[i];
      if (p.t < 0) continue;
      const t = p.t / POP_LIFE;
      // Ease-out rise: fast off the mark, drifting to a stop, fading over the last third.
      const rise = (1 - (1 - t) * (1 - t)) * 22 * u;
      const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      const x = Math.round(p.x + (reduced ? 0 : p.drift * t));
      const y = Math.round(p.y - (reduced ? 12 * u * t : rise));
      // Fade through the context rather than through a fractional argument (see `withAlphaStep`).
      const before = ctx.globalAlpha;
      ctx.globalAlpha = before * clamp01(alpha);
      drawAt(ctx, p.text, x, y, 'hud', size, p.color, 'center');
      ctx.globalAlpha = before;
      // The icon rides beside the number so a glance tells you *what* you picked up without
      // reading the value.
      if (p.icon !== 0) {
        const iconScale = Math.max(1, u);
        const iconW = (p.icon === 1 ? ICON_SIZE.gem : ICON_SIZE.oilW) * iconScale;
        const iconX = Math.round(x - measureAt(p.text, 'hud', size) / 2 - iconW - u);
        const prev = ctx.globalAlpha;
        ctx.globalAlpha = prev * clamp01(alpha);
        if (p.icon === 1) drawGemIcon(ctx, iconX, y, iconScale);
        else drawOilIcon(ctx, iconX, y - u, iconScale);
        ctx.globalAlpha = prev;
      }
    }
  }

  /**
   * `?debug=1` only: one line of frame statistics, bottom-left, out of everyone's way.
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @param {FrameStats|null} stats
   * @returns {void}
   */
  function drawDebug(ctx, state, m, stats) {
    const u = m.u;
    // Deliberately the smallest text on screen: diagnostics must never crowd the game.
    const size = Math.max(1, u - 1);
    const lineH = heightAt('hud', size);
    const line =
      stats !== null && stats !== undefined
        ? `${stats.fps.toFixed(0)} FPS ${stats.frameMsAvg.toFixed(1)}MS P99 ${stats.frameMsP99.toFixed(1)} DROP ${stats.droppedFrames}`
        : 'NO FRAME STATS';
    const pos = `${state.player.x.toFixed(1)},${state.player.y.toFixed(1)} ${m.w}X${m.h}@${m.px}`;
    drawAt(ctx, line, 3 * u, m.h - 3 * u - lineH * 2 - size, 'hud', size, 'hudDim');
    drawAt(ctx, pos, 3 * u, m.h - 3 * u - lineH, 'hud', size, 'hudDim');
  }

  /**
   * @returns {void}
   */
  function dispose() {
    mapView.dispose();
  }

  /**
   * Advance the map OFF → CORNER → FULL.
   *
   * `src/main.js` calls this from the `map` action instead of toggling `settings.minimap`, then
   * persists the result (see the integrator note): `setSetting('mapMode', mode)` **and**
   * `setSetting('minimap', mode !== 'off')`. Passing the current settings lets the cycle start
   * from whatever a fresh run loaded.
   * @param {any} [settings]
   * @returns {MapMode}
   */
  function cycleMap(settings) {
    return cycleMapMode(settings);
  }

  /**
   * @param {any} [settings]
   * @returns {MapMode}
   */
  function mapMode(settings) {
    return forcedMap !== null ? forcedMap : readMapMode(settings);
  }

  return {
    render,
    resize,
    surface,
    pop,
    reset,
    cycleMap,
    mapMode,
    mapStats: () => mapView.stats(),
    mapLocked,
    notice,
    dispose,
  };
}

