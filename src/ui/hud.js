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
 * A frame costs a few dozen canvas calls and the option objects handed to `drawText`. The
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
import { COLOR, drawText, measureLine, textHeight } from './font.js';
import {
  createCounter,
  createTextMemo,
  formatClock,
  formatCount,
  formatDepth,
  formatDistance,
  formatInt,
  formatLabyrinth,
  formatPercent,
  formatSigned,
  formatTime,
} from './format.js';
import { createMapView, cycleMapMode, readMapMode } from './map.js';
import {
  drawGemIcon,
  drawOilIcon,
  drawPanel,
  drawTorchIcon,
  drawWell,
  fillDisc,
  fillRing,
  fitScale,
  ICON_SIZE,
  strokeRect,
  withAlpha,
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
  drawArt,
  drawFlame,
  drawGemIcon,
  drawOilIcon,
  drawPanel,
  drawPortalIcon,
  drawTorchIcon,
  drawWell,
  fillDisc,
  fillRing,
  fitScale,
  hexToRgb,
  ICON_SIZE,
  strokeRect,
  withAlpha,
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
  };

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
    return changed;
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

/** Most gems the compass ever asks for, whatever the level holds. */
const COMPASS_GEM_CAP = 8;

/** Fraction of a level's gems the compass asks for, under the cap. */
const COMPASS_GEM_FRACTION = 0.15;

/**
 * Gems needed before the compass and the exit-distance readout are earned, from depth 3 on.
 *
 * An **absolute** count that does not scale with the maze's area: see `drawCompass`. Exported for
 * the unit test, which pins it against the real gem curve (6 gems on depth 1 → 273 at the cap) so
 * a future balance change cannot quietly make the instrument unreachable again.
 * @param {number} gemsTotal gems on this level
 * @returns {number} gems required
 */
export function compassGems(gemsTotal) {
  if (!Number.isFinite(gemsTotal) || gemsTotal <= 0) return 0;
  return Math.min(COMPASS_GEM_CAP, Math.ceil(gemsTotal * COMPASS_GEM_FRACTION));
}

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
  /** Wall-ish clock taken from `state.time`; see the file header on why the HUD has no dt. */
  let lastTime = -1;
  /** Seconds since boot, advanced by the clamped delta of `state.time`. */
  let clock = 0;
  let lastScore = 0;
  let lastFuel = 0;
  let lastGems = 0;
  let lastLevel = 0;
  /** Smoothed fuel fraction, so an oil pickup sweeps the bar up instead of snapping. */
  let fuelShown = 1;
  /** 0..1 ramp that fades the whole HUD in when a level starts. */
  let intro = 0;
  /**
   * Refill flare: 1 at the instant a flask lands, decaying to 0 over `REFILL_FLARE_TIME`. This is
   * the tank economy's whole feedback loop — the player must *feel* the tank fill, because the
   * thing they are managing is no longer a level timer but a chain of refuels.
   */
  let refillFlare = 0;
  /** Bar fraction the last refill started from, so the surge can be drawn as a sweep. */
  let refillFrom = 0;
  /** Refuels taken this level (a fallback for when `state.run` does not carry the count). */
  let refuelCount = 0;
  /** Fuel panel box, from {@link measureFuelPanel}, so the full map can lay out clear of it. */
  let fuelPanelW = 0;
  let fuelPanelH = 0;
  let fuelBarW = 0;

  // ── Readout text, rebuilt only when the number behind it changes (see the file header) ──
  const fuelText = createTextMemo((sec) => formatTime(sec));
  const refuelText = createTextMemo((n) => '×' + n);
  const scoreText = createTextMemo((v) => formatInt(v));
  const gemsText = createTextMemo((g, t) => formatCount(g, t));
  const depthText = createTextMemo((lv) => formatDepth(lv));
  const sizeText = createTextMemo((c, r) => formatLabyrinth(c, r));
  const clockText = createTextMemo((sec) => formatClock(sec));
  const mappedMemo = createTextMemo((pct) => 'MAPPED ' + formatPercent(pct / 100));
  const tailMemo = createTextMemo((sec, pct) => formatClock(sec) + '  MAPPED ' + formatPercent(pct / 100));
  const distText = createTextMemo((d) => formatDistance(d));
  /** The depth panel's lines, filled in place every frame instead of a fresh array. */
  const depthLines = ['', '', '', ''];
  /** Their colours, per slot. @type {string[]} */
  const depthColors = ['hudGold', 'hudBright', 'hudDim', 'hudDim'];

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
    // Pops rise from just below the centre of the view: close enough to the action to be noticed,
    // far enough down that they never sit over the crosshair region of the screen.
    p.x = m.w * 0.5;
    p.y = m.h * 0.58;
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
    fuelShown = 1;
    intro = 0;
    refillFlare = 0;
    refillFrom = 0;
    refuelCount = 0;
    for (let i = 0; i < MAX_POPS; i++) pops[i].t = -1;
    mapView.reset();
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
   * @returns {number} the frame delta actually applied, in seconds
   */
  function advance(state, alpha) {
    const now = state.time + (Number.isFinite(alpha) ? clamp01(alpha) : 0) / 60;
    let dt = lastTime < 0 ? 0 : now - lastTime;
    if (!(dt >= 0) || dt > MAX_FRAME_DT) dt = dt > MAX_FRAME_DT ? MAX_FRAME_DT : 0;
    lastTime = now;
    clock += dt;

    const run = state.run;

    // A new level (or a new run) resets the readouts rather than rolling them across the cut.
    if (state.level !== lastLevel) {
      lastLevel = state.level;
      lastGems = run.gems;
      lastFuel = run.fuel;
      fuelShown = run.fuelMax > 0 ? clamp01(run.fuel / run.fuelMax) : 0;
      intro = 0;
      refillFlare = 0;
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
        refillFrom = fuelShown;
        refillFlare = 1;
        refuelCount++;
      }
      if (intro < 1) intro = clamp01(intro + dt * 2.2);
    } else if (state.phase === 'paused') {
      // Hold the intro at full while paused so resuming does not re-fade the HUD in.
      intro = 1;
    }
    lastScore = run.score;
    lastFuel = run.fuel;
    lastGems = run.gems;

    scoreCounter.set(run.score);
    scoreCounter.update(dt);

    const fuelTarget = run.fuelMax > 0 ? clamp01(run.fuel / run.fuelMax) : 0;
    // Exponential smoothing; the constant is a rate in 1/s, chosen so a full flask sweeps the bar
    // up in roughly a third of a second.
    fuelShown += (fuelTarget - fuelShown) * (1 - Math.exp(-9 * dt));
    if (Math.abs(fuelTarget - fuelShown) < 0.002) fuelShown = fuelTarget;

    if (refillFlare > 0) refillFlare = Math.max(0, refillFlare - dt / REFILL_FLARE_TIME);

    for (let i = 0; i < MAX_POPS; i++) {
      const p = pops[i];
      if (p.t < 0) continue;
      p.t += dt;
      if (p.t >= POP_LIFE) p.t = -1;
    }
    return dt;
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
    const globalAlpha = (phase === 'paused' ? 0.45 : 1) * (0.25 + 0.75 * intro);
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * globalAlpha;

    const reduced = state.settings !== undefined && state.settings.reducedMotion === true;
    const mode = forcedMap !== null ? forcedMap : readMapMode(state.settings);

    // The raster is maintained before anything is drawn, so the map and the "% mapped" readout
    // agree within the same frame. It is skipped entirely when the map is off — switching it back
    // on costs one rescan, not a frame of stale pixels.
    if (mode !== 'off') mapView.update(state, clock);

    // The full map takes the screen: drawing the play HUD under it would be noise over a diagram,
    // so only the gauges that answer "can I afford to stand here reading this" stay.
    if (mode === 'full') {
      // The map's ground covers the whole surface, so the gauge is drawn *after* it — but the map
      // needs the gauge's box first to lay its header out clear of it (beside it on a wide screen,
      // under it on a phone). Hence the measurement is a pure function of the metrics, separate
      // from the drawing.
      measureFuelPanel(m);
      mapView.drawFull(
        ctx,
        m,
        state,
        clock,
        reduced,
        // The gauge box, from the corner it is drawn in: the map lays its text out clear of it.
        3 * m.u + fuelPanelW,
        3 * m.u + fuelPanelH,
      );
      drawFuelGauge(ctx, state, m, reduced);
      // No score pops over the full map: the player opened a diagram in order to read it, and a
      // pop is drawn at the *centre* of the screen, straight across the corridors they are
      // tracing. The gauge is the one readout the argument above keeps.
      if (isDebug()) drawDebug(ctx, state, m, frameStats === undefined ? null : frameStats);
      ctx.globalAlpha = prevAlpha;
      return;
    }

    // On a narrow surface the three top clusters cannot sit side by side, so the depth readout
    // tucks under the fuel gauge instead of holding the centre.
    const fuelH = drawFuelGauge(ctx, state, m, reduced);
    // `drawFuelGauge` has just published `fuelPanelW`, which the score panel needs to know how much
    // of the top row is left for it.
    drawScorePanel(ctx, state, m);
    drawDepthPanel(ctx, state, m, fuelH);
    const mapH = mode === 'corner' ? mapView.drawCorner(ctx, m, state, clock, reduced) : 0;
    drawCompass(ctx, state, m, reduced, mapH);
    drawPops(ctx, m, reduced);
    if (isDebug()) drawDebug(ctx, state, m, frameStats === undefined ? null : frameStats);

    ctx.globalAlpha = prevAlpha;
  }

  /**
   * Size the fuel panel without drawing it.
   *
   * Pure arithmetic on the metrics, so the full map can reserve space for the gauge before the
   * gauge is drawn on top of it. Writes the three closure fields rather than allocating a box.
   * @param {SurfaceMetrics} m
   * @returns {void}
   */
  function measureFuelPanel(m) {
    const u = m.u;
    const iconW = ICON_SIZE.flameW * u;
    const barH = 7 * u;
    const lineH = textHeight({ font: 'hud', size: u });
    // On a narrow surface the gauge and the score panel share one row, and the score panel needs
    // more than half of it for a six-figure number plus the gem tally — so the gauge is capped at
    // 44 % of the width rather than being allowed to slide under it (measured at 390×844: the two
    // panels used to overlap by ~35 UI pixels, eating the tank's own readout).
    const cap = m.narrow ? m.w * 0.44 - iconW - 7 * u : Infinity;
    fuelBarW = Math.min(64 * u, Math.max(20 * u, m.w * 0.28), cap);
    fuelPanelW = iconW + fuelBarW + 7 * u;
    // Tall enough for the torch beside the bar *and* the readout line under it.
    fuelPanelH = Math.max(ICON_SIZE.torchH * u + 4 * u, barH + lineH + 8 * u);
  }

  /**
   * Top-left: the torch **tank** — torch icon, segmented bar with quarter-tank ticks, refuel
   * count, remaining time.
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
   * @returns {number} the panel's height in UI pixels, so the next cluster can stack under it
   */
  function drawFuelGauge(ctx, state, m, reduced) {
    const u = m.u;
    const pad = 3 * u;
    const iconScale = u;
    const iconW = ICON_SIZE.flameW * iconScale;
    measureFuelPanel(m);
    const barW = fuelBarW;
    const barH = 7 * u;
    const lineH = textHeight({ font: 'hud', size: u });
    const panelW = fuelPanelW;
    const panelH = fuelPanelH;

    const low = fuelShown <= LOW_FUEL_FRACTION;
    const flare = reduced ? 0 : refillFlare;
    // The flame flickers on its own cycle; when the tank is low it stutters, which is the first
    // cue the player gets that the next flask has become urgent.
    const flicker = reduced ? 0.5 : noise(clock * (low ? 17 : 9));
    const frame = reduced ? 0 : ((clock * (low ? 14 : 8)) | 0) % 3;

    drawPanel(ctx, pad, pad, panelW, panelH, u, { frame: 'stone' });
    // Alarm and flare both live on the panel edge, where they are visible in peripheral vision:
    // the player is looking down a corridor, not at the gauge.
    if (low && !reduced) {
      const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(clock * 6));
      ctx.fillStyle = withAlpha(COLOR.alarm, pulse * 0.7);
      strokeRect(ctx, pad, pad, panelW, panelH, Math.max(1, u >> 1));
    } else if (flare > 0) {
      ctx.fillStyle = withAlpha(COLOR.fireCore, flare * 0.8);
      strokeRect(ctx, pad, pad, panelW, panelH, Math.max(1, u >> 1));
    }

    const iconX = pad + 3 * u;
    const iconY = pad + 2 * u;
    // A refill relights the torch: the icon goes to full strength for the length of the flare
    // however low the tank was, which is the reward for the pickup.
    drawTorchIcon(ctx, iconX, iconY, iconScale, frame, low && flare < 0.2 ? 0.3 : 1);

    // Bar well.
    const barX = pad + iconW + 5 * u;
    const barY = pad + 3 * u;
    drawWell(ctx, barX, barY, barW, barH, u, COLOR.void, low ? COLOR.fireDeep : COLOR.ironDark);

    const inner = barW - 2 * u;
    const gap = Math.max(1, u >> 1);
    // The surge: for the length of the flare the bar is drawn as if it were still filling, so the
    // eye sees the level *travel* even though the state changed in a single step.
    const surge = flare > 0 ? refillFrom + (fuelShown - refillFrom) * (1 - flare * flare) : fuelShown;
    const shown = flare > 0 ? Math.min(fuelShown, surge) : fuelShown;
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
    const textY = barY + barH + 2 * u;
    // Keyed on whole seconds, the resolution `formatTime` prints at.
    const timeText = fuelText(Math.floor(run.fuel));
    drawText(ctx, timeText, barX + barW, textY, {
      font: 'hud',
      size: u,
      color: low ? 'hudAlarm' : flare > 0 ? 'hudBright' : 'hudDim',
      align: 'right',
    });
    const refuels = refuelsOf(state);
    // "TANK" until the first flask, then a tally of them. The word is dropped rather than allowed
    // to collide with the clock when the bar is narrow (a phone at u = 3 has no room for both).
    const tankLabel = low ? 'LOW' : refuels > 0 ? refuelText(refuels) : 'TANK';
    const timeW = measureLine(timeText, { font: 'hud', size: u });
    const labelW = measureLine(tankLabel, { font: 'hud', size: u });
    if (labelW + timeW + 3 * u <= barW) {
      drawText(ctx, tankLabel, barX, textY, {
        font: 'hud',
        size: u,
        color: low ? 'hudAlarm' : 'hudDim',
      });
    }
    return panelH;
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
   * Top-right: rolling score and the gem tally.
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
    // A six-figure score at double size does not fit beside the fuel gauge on a phone — and with
    // the massive-maze item counts the gem line is now "8/820" rather than "8/12", so the panel is
    // fitted to the room the gauge actually leaves instead of being assumed to fit. Measured at
    // 390×844: the two panels used to overlap by ~35 UI pixels and ate the tank's own readout.
    let scoreSize = m.narrow ? u : 2 * u;
    let gemSize = u;
    const room = m.narrow ? m.w - 3 * pad - fuelPanelW : m.w;
    for (;;) {
      const need =
        Math.max(
          measureLine(scoreLine, { font: 'hud', size: scoreSize }),
          measureLine(gemsLine, { font: 'hud', size: gemSize }) + (ICON_SIZE.gem + 2) * gemSize,
        ) + 8 * u;
      if (need <= room) break;
      if (scoreSize > gemSize && scoreSize > 1) scoreSize--;
      else if (gemSize > 1) gemSize--;
      else if (scoreSize > 1) scoreSize--;
      else break;
    }
    const scoreH = textHeight({ font: 'hud', size: scoreSize });
    const gemH = textHeight({ font: 'hud', size: gemSize });

    const scoreW = measureLine(scoreLine, { font: 'hud', size: scoreSize });
    const gemsTextW = measureLine(gemsLine, { font: 'hud', size: gemSize });
    const gemsW = gemsTextW + (ICON_SIZE.gem + 2) * gemSize;
    const inner = Math.max(scoreW, gemsW, 20 * u);
    const panelW = inner + 8 * u;
    const panelH = scoreH + gemH + 9 * u;
    const px = m.w - pad - panelW;

    drawPanel(ctx, px, pad, panelW, panelH, u, { frame: 'stone' });

    const right = m.w - pad - 4 * u;
    drawText(ctx, scoreLine, right, pad + 3 * u, {
      font: 'hud',
      size: scoreSize,
      color: 'hudGold',
      align: 'right',
    });

    const gemY = pad + 3 * u + scoreH + 2 * u;
    drawText(ctx, gemsLine, right, gemY, { font: 'hud', size: gemSize, color: 'hudGem', align: 'right' });
    drawGemIcon(ctx, right - gemsW, gemY, gemSize);
  }

  /**
   * Top-centre: the depth, how big this labyrinth is, how much of it is mapped, and the level
   * clock. Deliberately small — the middle of the screen is where the game is.
   *
   * The size line is new for the massive-maze wave and it is not decoration: `16×16` and `128×128`
   * are two different games, and a player who has just descended needs to know which one they are
   * standing in without opening the map. `MAPPED %` is free — `map.js` maintains the count
   * incrementally — and it is the only honest progress bar a maze this size can offer.
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @param {number} fuelH height of the fuel panel, for the stacked (narrow) layout
   * @returns {void}
   */
  function drawDepthPanel(ctx, state, m, fuelH) {
    const u = m.u;
    const pad = 3 * u;
    const level = state.levelData;
    const hasMaze = level !== null && level !== undefined && level.maze !== undefined;
    const pct = mappedPercent(state);
    const seconds = Math.floor(state.run.levelTime);
    // Wide: the clock and the mapped percentage share one row. Narrow: they get a row each, and
    // the whole panel drops a text size — a phone at u = 3 cannot hold "01:42  MAPPED 94%" on one
    // line and would otherwise run off the screen (measured at 390×844).
    const stacked = m.narrow && pct >= 0;
    // Filled in place: a fresh `[depth, size, tail]` array every frame was garbage for nothing.
    const lines = depthLines;
    let rows = 0;
    lines[rows++] = depthText(state.level);
    if (hasMaze) lines[rows++] = sizeText(level.maze.cols, level.maze.rows);
    lines[rows++] = stacked || pct < 0 ? clockText(seconds) : tailMemo(seconds, pct);
    if (stacked) lines[rows++] = mappedMemo(pct);
    // Never wider than the screen: the size that fits wins over the size that was asked for.
    const maxW = m.w - 2 * pad - 8 * u;
    let size = m.narrow ? Math.max(1, u - 1) : u;
    for (let i = 0; i < rows; i++) {
      const fit = fitScale(lines[i], maxW, { font: 'hud' }, size, 1);
      if (fit < size) size = fit;
    }
    const lineH = textHeight({ font: 'hud', size });
    let w = 0;
    for (let i = 0; i < rows; i++) {
      const lw = measureLine(lines[i], { font: 'hud', size });
      if (lw > w) w = lw;
    }
    const panelW = Math.min(m.w - 2 * pad, w + 8 * u);
    const panelH = lineH * rows + (rows + 1) * 2 * u + u;
    // Centre on a wide screen; stack under the fuel gauge when there is no room between the two
    // top clusters.
    const px = m.narrow ? pad : Math.round((m.w - panelW) / 2);
    const py = m.narrow ? pad + fuelH + 2 * u : pad;

    drawPanel(ctx, px, py, panelW, panelH, u, { frame: 'wood', rivets: false });
    const cx = px + Math.round(panelW / 2);
    // Depth is gold, the size is the bright fact under it, the rest is quiet.
    const colors = depthColors;
    colors[1] = hasMaze ? 'hudBright' : 'hudDim';
    let y = py + 4 * u;
    for (let i = 0; i < rows; i++) {
      drawText(ctx, lines[i], cx, y, { font: 'hud', size, color: colors[i], align: 'center' });
      y += lineH + 2 * u;
    }
  }

  /**
   * The whole-number percentage of the level mapped — exactly the number `formatPercent` prints —
   * or −1 when there is nothing to report (no level, or the map has never been opened so the
   * incremental count has not been primed). A number rather than a string, so the readout can be
   * memoised on it.
   * @param {GameState} state
   * @returns {number}
   */
  function mappedPercent(state) {
    const level = state.levelData;
    if (level === null || level === undefined || level.maze === undefined) return -1;
    const total = level.maze.width * level.maze.height;
    const seen = mapView.exploredCount();
    if (total <= 0 || seen <= 0) return -1;
    return Math.round(clamp01(seen / total) * 100);
  }

  /**
   * Bottom-centre: a dial whose needle points at the exit, in *view-relative* terms (up = straight
   * ahead), because a north-up compass in a first-person maze is a puzzle rather than a help.
   *
   * It only appears once the player has earned it: always on the first two depths while the rules
   * are still being learned, and from depth 3 after a **fixed** handful of gems (ARCHITECTURE.md
   * §4.6).
   *
   * WHY a fixed count and not a fraction: the gate used to be "half the gems", which was written
   * for a 6-gem level. Gems scale with area now — 29 at depth 3, 273 at the cap — so a fraction
   * meant the compass *and* the distance readout were unreachable from depth 3 onward, i.e. an
   * entire instrument was dead content for 13 of the 15 depths. `min(8, 15 % of the level)` keeps
   * the early-game lesson ("collect things and the dungeon tells you more") and reaches it in a
   * few minutes at any size.
   *
   * Under the dial sits the **distance to the exit in tiles**. In a 6×6 maze the needle alone was
   * enough; across a 128×128 labyrinth "which way" without "how far" is nearly useless — 40 m and
   * 900 m are the difference between pushing on and turning back to hunt for a flask. It is shown
   * whenever the compass is (the compass is the earned instrument), and marked as a straight-line
   * distance by being an `m` reading rather than a route.
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @param {boolean} reduced
   * @param {number} mapH height of the corner map, so the dial can step aside on a narrow screen
   * @returns {void}
   */
  function drawCompass(ctx, state, m, reduced, mapH) {
    const level = state.levelData;
    if (level === null) return;
    const run = state.run;
    const earned = state.level <= 2 || run.gems >= compassGems(run.gemsTotal);
    if (!earned) return;

    const u = m.u;
    const r = 9 * u;
    const lineH = textHeight({ font: 'hud', size: u });
    const cx = Math.round(m.w / 2);
    // The readout hangs below the dial, so the dial itself lifts by a line. On a narrow surface the
    // corner map is directly to the right; lift again so the two never touch.
    const bottom = m.narrow && mapH > 0 ? m.h - mapH - 5 * u : m.h - 4 * u;
    const cy = Math.round(bottom - lineH - 2 * u - r);

    // Dial: a ring of iron with a dark face.
    ctx.fillStyle = withAlpha(COLOR.void, 0.8);
    fillDisc(ctx, cx, cy, r + u, u);
    ctx.fillStyle = COLOR.ironBase;
    fillRing(ctx, cx, cy, r, u);
    ctx.fillStyle = withAlpha(COLOR.stoneShadow, 0.85);
    fillDisc(ctx, cx, cy, r - u, u);

    // Cardinal ticks, so the dial reads as an instrument even when the needle is still.
    ctx.fillStyle = COLOR.ironHilite;
    ctx.fillRect(cx - Math.round(u / 2), cy - r, Math.max(1, u), u);
    ctx.fillRect(cx - Math.round(u / 2), cy + r - u, Math.max(1, u), u);
    ctx.fillRect(cx - r, cy - Math.round(u / 2), u, Math.max(1, u));
    ctx.fillRect(cx + r - u, cy - Math.round(u / 2), u, Math.max(1, u));

    const ex = level.maze.exit.x + 0.5;
    const ey = level.maze.exit.y + 0.5;
    const p = state.player;
    // Screen-relative bearing: subtract the player's yaw, then rotate so that "ahead" is up.
    const bearing = Math.atan2(ey - p.y, ex - p.x) - p.angle - Math.PI / 2;
    const dirX = Math.cos(bearing);
    const dirY = Math.sin(bearing);

    // The needle is plotted as a run of square pixels along the bearing — a rotated pixel line,
    // which stays crisp where a stroked path would blur.
    const len = r - 2 * u;
    const step = Math.max(1, Math.round(u / 2));
    const near = clamp01(state.derived !== undefined ? state.derived.nearExit : 0);
    for (let d = -Math.round(len * 0.45); d <= len; d += step) {
      const t = d / len;
      const size = t < 0 ? u : Math.max(1, Math.round(u * (t > 0.8 ? 1.6 : 1.2)));
      ctx.fillStyle =
        t < 0
          ? COLOR.stoneMid
          : t > 0.72
            ? near > 0.5 && !reduced && noise(clock * 6) > 0.5
              ? COLOR.arcPale
              : COLOR.arcCyan
            : COLOR.arcMid;
      ctx.fillRect(
        Math.round(cx + dirX * d - size / 2),
        Math.round(cy + dirY * d - size / 2),
        size,
        size,
      );
    }
    // Hub.
    ctx.fillStyle = COLOR.goldLight;
    ctx.fillRect(cx - u, cy - u, 2 * u, 2 * u);

    // Distance to the exit. `derived.exitDist` is Infinity while no level is loaded, which
    // `formatDistance` prints as "--" rather than as a lie.
    const dist = state.derived !== undefined ? state.derived.exitDist : Infinity;
    // Keyed on the whole tile count `formatDistance` prints; Infinity is a stable key.
    const distLine = distText(Math.round(dist));
    const distY = cy + r + 2 * u;
    const distW = measureLine(distLine, { font: 'hud', size: u });
    ctx.fillStyle = withAlpha(COLOR.void, 0.72);
    ctx.fillRect(Math.round(cx - distW / 2) - 2 * u, distY - u, distW + 4 * u, lineH + 2 * u);
    drawText(ctx, distLine, cx, distY, {
      font: 'hud',
      size: u,
      // Close to the exit the readout turns arcane, matching the needle tip and the portal hum.
      color: near > 0.5 ? 'hudBright' : 'hudDim',
      align: 'center',
    });
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
      const textW = drawText(ctx, p.text, x, y, {
        font: 'hud',
        size,
        color: p.color,
        align: 'center',
        alpha,
      });
      // The icon rides beside the number so a glance tells you *what* you picked up without
      // reading the value.
      if (p.icon !== 0) {
        const iconScale = Math.max(1, u);
        const iconW = (p.icon === 1 ? ICON_SIZE.gem : ICON_SIZE.oilW) * iconScale;
        const iconX = Math.round(x - textW / 2 - iconW - u);
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
    const lineH = textHeight({ font: 'hud', size });
    const line =
      stats !== null && stats !== undefined
        ? `${stats.fps.toFixed(0)} FPS ${stats.frameMsAvg.toFixed(1)}MS P99 ${stats.frameMsP99.toFixed(1)} DROP ${stats.droppedFrames}`
        : 'NO FRAME STATS';
    const pos = `${state.player.x.toFixed(1)},${state.player.y.toFixed(1)} ${m.w}X${m.h}@${m.px}`;
    drawText(ctx, line, 3 * u, m.h - 3 * u - lineH * 2 - size, {
      font: 'hud',
      size,
      color: 'hudDim',
    });
    drawText(ctx, pos, 3 * u, m.h - 3 * u - lineH, { font: 'hud', size, color: 'hudDim' });
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
    dispose,
  };
}

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────

/**
 * Deterministic 0..1 flicker noise. Two incommensurable sines: cheap, allocation free, and it
 * never repeats on a visible period — which is exactly what a flame needs.
 * @param {number} t seconds
 * @returns {number} 0..1
 */
function noise(t) {
  return 0.5 + 0.25 * Math.sin(t) + 0.25 * Math.sin(t * 1.7 + 1.3);
}
