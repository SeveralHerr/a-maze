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
 * 2. **Pixel primitives** — indexed-colour sprite art, stone/wood panels, icons. `menus.js`
 *    imports these; nothing else does.
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
 * A frame costs a few dozen canvas calls and about a dozen short-lived strings (the formatted
 * readouts and the option objects handed to `drawText`) — nothing that scales with the size of the
 * maze or with the number of glyphs drawn. Everything that *would* scale is precomputed: glyphs
 * come from a pre-coloured atlas, colour strings are memoised, the score pops live in a fixed-size
 * pool, panels and icons draw from run-length-merged rectangles, and the minimap is rasterised into
 * an offscreen canvas that is rebuilt only when the explored set actually grows. Measured at
 * 0.1–0.2 ms per frame for the whole overlay at 1280×720.
 */

import { clamp, clamp01 } from '../core/math.js';
import { createLogger, isDebug } from '../core/log.js';
import { COLOR, drawText, measureLine, textHeight } from './font.js';
import {
  createCounter,
  formatClock,
  formatCount,
  formatDepth,
  formatInt,
  formatSigned,
  formatTime,
} from './format.js';

/** @typedef {import('../core/types.js').GameState} GameState */
/** @typedef {import('../core/types.js').FrameStats} FrameStats */
/** @typedef {import('./font.js').TextOptions} TextOptions */

const log = createLogger('ui/hud');

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

// ─── Colour helpers ──────────────────────────────────────────────────────────────────────────

/**
 * Memoised `rgba()` strings. Building one per fill per frame would allocate thousands of short
 * strings a second; the UI uses a few dozen distinct (colour, alpha) pairs in total.
 * @type {Map<string, string>}
 */
const alphaColors = new Map();

/**
 * `#rrggbb` + alpha → `rgba(r,g,b,a)`, memoised. Alpha is quantised to 1/64 so a fading element
 * cannot fill the cache with 60 new strings a second.
 * @param {string} hex `#rrggbb`
 * @param {number} alpha 0..1
 * @returns {string} a CSS colour
 */
export function withAlpha(hex, alpha) {
  const a = alpha <= 0 ? 0 : alpha >= 1 ? 1 : Math.round(alpha * 64) / 64;
  if (a >= 1) return hex;
  const key = hex + a;
  const hit = alphaColors.get(key);
  if (hit !== undefined) return hit;
  const r = parseInt(hex.slice(1, 3), 16) || 0;
  const g = parseInt(hex.slice(3, 5), 16) || 0;
  const b = parseInt(hex.slice(5, 7), 16) || 0;
  const css = `rgba(${r},${g},${b},${a})`;
  if (alphaColors.size < 512) alphaColors.set(key, css);
  return css;
}

// ─── Indexed pixel art ───────────────────────────────────────────────────────────────────────

/**
 * A small indexed-colour sprite: one byte per pixel, index 0 transparent.
 * @typedef {{w:number, h:number, data:Uint8Array}} Art
 */

/**
 * Compile rows of digits (`0`–`9`, where 0 = transparent) into an {@link Art}.
 *
 * Rows of unequal length are a data error in this file; the sprite is padded to the widest row and
 * the problem is recorded, because a half-drawn icon is better than a dead frame.
 * @param {ReadonlyArray<string>} rows
 * @param {string} [name] for diagnostics
 * @returns {Art}
 */
export function compileArt(rows, name) {
  let w = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i].length > w) w = rows[i].length;
  const h = rows.length;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    if (row.length !== w) log.error(`art ${name || '?'}: row ${y} is ${row.length}, expected ${w}`);
    for (let x = 0; x < row.length; x++) {
      const c = row.charCodeAt(x) - 48;
      if (c > 0 && c < 10) data[y * w + x] = c;
    }
  }
  return { w, h, data };
}

/**
 * Blit indexed art at an integer scale, merging horizontal runs of one colour into a single
 * `fillRect` (typically 3–5× fewer canvas calls than one rect per pixel).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Art} art
 * @param {number} x left edge in UI pixels (rounded)
 * @param {number} y top edge in UI pixels (rounded)
 * @param {number} scale integer UI pixels per art pixel (≥ 1)
 * @param {ReadonlyArray<string|null>} palette index → CSS colour; `null` or a missing entry skips
 * @returns {void}
 */
export function drawArt(ctx, art, x, y, scale, palette) {
  const s = scale < 1 ? 1 : Math.round(scale);
  const ox = Math.round(x);
  const oy = Math.round(y);
  const { w, h, data } = art;
  for (let py = 0; py < h; py++) {
    let px = 0;
    while (px < w) {
      const idx = data[py * w + px];
      if (idx === 0) {
        px++;
        continue;
      }
      let run = 1;
      while (px + run < w && data[py * w + px + run] === idx) run++;
      const color = palette[idx];
      if (color !== undefined && color !== null) {
        ctx.fillStyle = color;
        ctx.fillRect(ox + px * s, oy + py * s, run * s, s);
      }
      px += run;
    }
  }
}

// ─── Panels ──────────────────────────────────────────────────────────────────────────────────

/**
 * Panel options.
 * @typedef {Object} PanelOptions
 * @property {'stone'|'wood'|'iron'} [frame]  border material (default `'stone'`)
 * @property {number} [alpha]   background opacity 0..1 (default 0.72)
 * @property {boolean} [rivets] draw corner rivets (default true for stone)
 * @property {number} [border]  border thickness in UI pixels (default `u`)
 * @property {boolean} [texture] draw the masonry courses inside the panel (default true)
 */

/** Border tone triples: [outer shadow, body, top-left highlight]. */
const FRAME_TONES = Object.freeze({
  stone: Object.freeze([COLOR.stoneShadow, COLOR.stoneDark, COLOR.stoneLight]),
  wood: Object.freeze([COLOR.woodShadow, COLOR.woodMid, COLOR.woodBright]),
  iron: Object.freeze([COLOR.ironShadow, COLOR.ironBase, COLOR.ironHilite]),
});

/**
 * Draw a framed panel: a dark translucent ground inside a two-tone bevelled border, with optional
 * corner rivets. This is the "stone/wood pixel panel" the HUD and every menu sit on.
 *
 * All edges are integer UI pixels, so the bevel stays a crisp single pixel at any scale.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x left edge (UI px)
 * @param {number} y top edge
 * @param {number} w width
 * @param {number} h height
 * @param {number} u layout unit (border thickness)
 * @param {PanelOptions} [opts]
 * @returns {void}
 */
export function drawPanel(ctx, x, y, w, h, u, opts) {
  const px = Math.round(x);
  const py = Math.round(y);
  const pw = Math.max(2, Math.round(w));
  const ph = Math.max(2, Math.round(h));
  const b = Math.max(1, Math.round(opts !== undefined && opts.border !== undefined ? opts.border : u));
  const kind = opts !== undefined && opts.frame !== undefined ? opts.frame : 'stone';
  const tones = FRAME_TONES[kind] !== undefined ? FRAME_TONES[kind] : FRAME_TONES.stone;
  const alpha = opts !== undefined && opts.alpha !== undefined ? clamp01(opts.alpha) : 0.72;

  // Outer edge, then the frame body, then the interior ground.
  ctx.fillStyle = withAlpha(COLOR.void, Math.min(1, alpha + 0.2));
  ctx.fillRect(px, py, pw, ph);
  ctx.fillStyle = tones[1];
  ctx.fillRect(px + b, py + b, pw - b * 2, ph - b * 2);
  // Bevel: light along the top and left of the frame body, dark along the bottom and right.
  ctx.fillStyle = tones[2];
  ctx.fillRect(px + b, py + b, pw - b * 2, b);
  ctx.fillRect(px + b, py + b, b, ph - b * 2);
  ctx.fillStyle = tones[0];
  ctx.fillRect(px + b, py + ph - b * 2, pw - b * 2, b);
  ctx.fillRect(px + pw - b * 2, py + b, b, ph - b * 2);
  // Interior, plus a hint of masonry: one course line every 7 units with staggered vertical
  // joints. Kept at a low alpha — it has to read as depth behind the text, never as noise in it.
  const inset = b * 2;
  const iw = pw - inset * 2;
  const ih = ph - inset * 2;
  if (iw > 0 && ih > 0) {
    ctx.fillStyle = withAlpha(COLOR.fog, alpha);
    ctx.fillRect(px + inset, py + inset, iw, ih);
    if (opts === undefined || opts.texture !== false) {
      const course = 7 * b;
      const joint = Math.max(1, b >> 1);
      ctx.fillStyle = withAlpha(COLOR.stoneDeep, alpha * 0.5);
      let row = 0;
      for (let yy = py + inset + course; yy < py + inset + ih - 1; yy += course, row++) {
        ctx.fillRect(px + inset, yy, iw, joint);
        // Alternate courses offset by half a block, the way a wall is actually laid.
        const step = course * 2;
        for (let xx = px + inset + (row % 2 === 0 ? step : step / 2); xx < px + inset + iw - 1; xx += step) {
          ctx.fillRect(xx, yy - course + joint, joint, course - joint);
        }
      }
    }
  }

  const rivets = opts !== undefined && opts.rivets !== undefined ? opts.rivets : kind !== 'iron';
  if (rivets && pw > b * 8 && ph > b * 8) {
    ctx.fillStyle = COLOR.ironHilite;
    const d = b;
    ctx.fillRect(px + b * 2, py + b * 2, d, d);
    ctx.fillRect(px + pw - b * 3, py + b * 2, d, d);
    ctx.fillRect(px + b * 2, py + ph - b * 3, d, d);
    ctx.fillRect(px + pw - b * 3, py + ph - b * 3, d, d);
  }
}

/**
 * A plain filled rectangle with a 1-unit inner outline — the slider tracks and bar wells.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} u
 * @param {string} fill CSS colour
 * @param {string} edge CSS colour
 * @returns {void}
 */
export function drawWell(ctx, x, y, w, h, u, fill, edge) {
  const b = Math.max(1, Math.round(u));
  ctx.fillStyle = edge;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  ctx.fillStyle = fill;
  ctx.fillRect(
    Math.round(x) + b,
    Math.round(y) + b,
    Math.max(0, Math.round(w) - b * 2),
    Math.max(0, Math.round(h) - b * 2),
  );
}

// ─── Icon art ────────────────────────────────────────────────────────────────────────────────

/**
 * Torch: three flame frames over a shared handle. Palette indices:
 * 1 ember, 2 mid, 3 hot, 4 core, 5 wood dark, 6 wood light, 7 iron.
 * @type {ReadonlyArray<Art>}
 */
const TORCH_FRAMES = Object.freeze([
  compileArt(
    ['....4....', '...343...', '..32323..', '..21312..', '..112211.', '...1221..', '....1....'],
    'torch0',
  ),
  compileArt(
    ['...4.....', '..343....', '.32333...', '.213112..', '..112211.', '...121...', '....1....'],
    'torch1',
  ),
  compileArt(
    ['.....4...', '....343..', '...33323.', '..213132.', '.1122121.', '...1221..', '....1....'],
    'torch2',
  ),
]);

/** The torch handle, drawn under every flame frame. */
const TORCH_HANDLE = compileArt(
  ['..77777..', '...656...', '...656...', '...656...', '...757...'],
  'handle',
);

/** Fire + wood palette for the torch icon. */
const TORCH_PALETTE = Object.freeze([
  null,
  COLOR.fireEmber,
  COLOR.fireMid,
  COLOR.fireHot,
  COLOR.fireCore,
  COLOR.woodDark,
  COLOR.woodBright,
  COLOR.ironLight,
]);

/** Gem icon, 7×7. 1 deep, 2 mid, 3 bright, 4 pale. */
const GEM_ART = compileArt(
  ['..343..', '.34443.', '3444443', '1344431', '.13331.', '..131..', '...1...'],
  'gem',
);

/** Gem palette. */
const GEM_PALETTE = Object.freeze([null, COLOR.gemDeep, COLOR.gemMid, COLOR.gemBright, COLOR.gemPale]);

/** Oil flask icon, 7×9. 1 dark, 2 mid, 3 light, 4 pale, 5 cork. */
const OIL_ART = compileArt(
  ['..555..', '..151..', '..121..', '.12321.', '1233321', '1233321', '1222321', '.12221.', '..111..'],
  'oil',
);

/** Oil palette. */
const OIL_PALETTE = Object.freeze([
  null,
  COLOR.oilDeep,
  COLOR.oilDark,
  COLOR.oilMid,
  COLOR.oilPale,
  COLOR.woodBright,
]);

/** Torch palette with the hot tones removed — a torch that is nearly out. */
const TORCH_PALETTE_DIM = Object.freeze([
  null,
  COLOR.fireDeep,
  COLOR.fireEmber,
  COLOR.fireMid,
  COLOR.fireHot,
]);

/**
 * Minimap player arrow pointing "north" (up the screen), 7×7. 1 = outline, 2 = body.
 * The seven other headings are produced by rotating this and the diagonal variant at load, which
 * is exact for 90° steps and therefore stays pixel-perfect.
 */
const ARROW_N = compileArt(
  ['...1...', '..121..', '.12221.', '1222221', '.11211.', '...1...', '.......'],
  'arrowN',
);

/** The 45° variant, pointing north-east. */
const ARROW_NE = compileArt(
  ['..11111', '...1221', '..12221', '.122211', '12211.1', '.11....', '1......'],
  'arrowNE',
);

/**
 * Rotate indexed art 90° clockwise.
 * @param {Art} art
 * @returns {Art}
 */
function rotateArt(art) {
  const { w, h, data } = art;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // (x,y) → (h-1-y, x) in a w×h → h×w rotation; the arrows are square, so w === h.
      out[x * h + (h - 1 - y)] = data[y * w + x];
    }
  }
  return { w: h, h: w, data: out };
}

/**
 * Player arrows for the 8 compass headings, indexed by `round(angle / 45°) & 7` with 0 = east,
 * matching the sim's angle convention (0 = +x, +y = south).
 * @type {ReadonlyArray<Art>}
 */
const ARROWS = (() => {
  const n = ARROW_N;
  const ne = ARROW_NE;
  const e = rotateArt(n);
  const se = rotateArt(ne);
  const s = rotateArt(e);
  const sw = rotateArt(se);
  const w = rotateArt(s);
  const nw = rotateArt(sw);
  // Index order: E, SE, S, SW, W, NW, N, NE.
  return Object.freeze([e, se, s, sw, w, nw, n, ne]);
})();

/** Arrow palette: outline then body. */
const ARROW_PALETTE = Object.freeze([null, COLOR.void, COLOR.fireCore]);

/**
 * Draw the animated torch icon.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x left edge (UI px)
 * @param {number} y top edge
 * @param {number} scale integer pixels per art pixel
 * @param {number} frame 0..2
 * @param {number} strength 0..1 — below ~0.35 the flame is drawn in embers only
 * @returns {void}
 */
export function drawTorchIcon(ctx, x, y, scale, frame, strength) {
  const f = TORCH_FRAMES[((frame | 0) % TORCH_FRAMES.length + TORCH_FRAMES.length) % TORCH_FRAMES.length];
  drawArt(ctx, TORCH_HANDLE, x, y + f.h * scale, scale, TORCH_PALETTE);
  if (strength <= 0.02) return;
  if (strength < 0.35) {
    // A dying torch: the hot core and the bright mid-tone drop out first, so the icon visibly
    // cools rather than just shrinking.
    drawArt(ctx, f, x, y, scale, TORCH_PALETTE_DIM);
    return;
  }
  drawArt(ctx, f, x, y, scale, TORCH_PALETTE);
}

/**
 * Draw the gem icon.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} scale
 * @returns {void}
 */
export function drawGemIcon(ctx, x, y, scale) {
  drawArt(ctx, GEM_ART, x, y, scale, GEM_PALETTE);
}

/**
 * Draw the oil flask icon.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} scale
 * @returns {void}
 */
export function drawOilIcon(ctx, x, y, scale) {
  drawArt(ctx, OIL_ART, x, y, scale, OIL_PALETTE);
}

/**
 * Draw a standalone flame (the menu cursor and the loading screen torch). Same art as the HUD
 * torch, without the handle.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x left edge
 * @param {number} y top edge
 * @param {number} scale
 * @param {number} frame animation frame
 * @returns {void}
 */
export function drawFlame(ctx, x, y, scale, frame) {
  const i = ((frame | 0) % TORCH_FRAMES.length + TORCH_FRAMES.length) % TORCH_FRAMES.length;
  drawArt(ctx, TORCH_FRAMES[i], x, y, scale, TORCH_PALETTE);
}

/** Size of the flame/torch art in art pixels, so callers can lay out around it. */
export const ICON_SIZE = Object.freeze({
  flameW: TORCH_FRAMES[0].w,
  flameH: TORCH_FRAMES[0].h,
  torchH: TORCH_FRAMES[0].h + TORCH_HANDLE.h,
  gem: GEM_ART.w,
  oilW: OIL_ART.w,
  oilH: OIL_ART.h,
  arrow: ARROW_N.w,
});

// ─── HUD ─────────────────────────────────────────────────────────────────────────────────────

/** Number of segments in the fuel bar. 16 reads as a gauge; more looks like a progress bar. */
const FUEL_SEGMENTS = 16;

/** Fraction of `fuelMax` at or below which the gauge goes red (mirrors `FUEL.LOW_FRACTION`). */
const LOW_FUEL_FRACTION = 0.2;

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
 * @property {() => void} dispose
 */

/**
 * Create the HUD.
 *
 * @param {HTMLCanvasElement|null} overlayCanvas the overlay canvas (may be null in tests/tools)
 * @param {{minimap?:boolean}} [options] reserved for future overrides; `minimap` forces the map on
 *   regardless of `state.settings.minimap` (used by the preview harness)
 * @returns {Hud}
 */
export function createHud(overlayCanvas, options) {
  const surface = createSurface(overlayCanvas);
  const forceMinimap = options !== undefined && options.minimap === true;

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

  /** @type {Pop[]} */
  const pops = new Array(MAX_POPS);
  for (let i = 0; i < MAX_POPS; i++) {
    pops[i] = { t: -1, x: 0, y: 0, drift: 0, text: '', color: 'hudBright', icon: 0 };
  }
  let popCursor = 0;

  // ── Minimap cache ──
  /** @type {HTMLCanvasElement|null} */
  let mapCanvas = null;
  /** @type {CanvasRenderingContext2D|null} */
  let mapCtx = null;
  let mapW = 0;
  let mapH = 0;
  let mapExplored = -1;
  /** @type {object|null} */
  let mapLevelRef = null;

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
    for (let i = 0; i < MAX_POPS; i++) pops[i].t = -1;
    mapExplored = -1;
    mapLevelRef = null;
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
      if (fuelGained > 0.5) pop(fuelGained, 'fuel');
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
    // On a narrow surface the three top clusters cannot sit side by side, so the depth readout
    // tucks under the fuel gauge instead of holding the centre.
    const fuelH = drawFuelGauge(ctx, state, m, reduced);
    drawScorePanel(ctx, state, m);
    drawDepthPanel(ctx, state, m, fuelH);
    drawCompass(ctx, state, m, reduced);
    if (forceMinimap || (state.settings !== undefined && state.settings.minimap === true)) {
      drawMinimap(ctx, state, m, reduced);
    }
    drawPops(ctx, m, reduced);
    if (isDebug()) drawDebug(ctx, state, m, frameStats === undefined ? null : frameStats);

    ctx.globalAlpha = prevAlpha;
  }

  /**
   * Top-left: torch icon + segmented burning bar + remaining time.
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
    const barW = Math.min(64 * u, Math.max(26 * u, m.w * (m.narrow ? 0.34 : 0.28)));
    const barH = 7 * u;
    const lineH = textHeight({ font: 'hud', size: u });
    const panelW = iconW + barW + 7 * u;
    // Tall enough for the torch beside the bar *and* the remaining-time line under it.
    const panelH = Math.max(ICON_SIZE.torchH * iconScale + 4 * u, barH + lineH + 8 * u);

    const low = fuelShown <= LOW_FUEL_FRACTION;
    // The flame flickers on its own cycle; when the torch is low it stutters, which is the first
    // cue the player gets that the run is nearly over.
    const flicker = reduced ? 0.5 : noise(clock * (low ? 17 : 9));
    const frame = reduced ? 0 : ((clock * (low ? 14 : 8)) | 0) % 3;

    drawPanel(ctx, pad, pad, panelW, panelH, u, { frame: 'stone' });

    const iconX = pad + 3 * u;
    const iconY = pad + 2 * u;
    drawTorchIcon(ctx, iconX, iconY, iconScale, frame, low ? 0.3 : 1);

    // Bar well.
    const barX = pad + iconW + 5 * u;
    const barY = pad + 3 * u;
    drawWell(ctx, barX, barY, barW, barH, u, COLOR.void, COLOR.ironDark);

    const inner = barW - 2 * u;
    const gap = Math.max(1, u >> 1);
    const lit = fuelShown * FUEL_SEGMENTS;
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
        ctx.fillStyle = low
          ? i === fullSegs - 1 && !reduced && flicker > 0.55
            ? COLOR.fireMid
            : COLOR.alarm
          : t < 0.55
            ? COLOR.fireMid
            : COLOR.fireHot;
        ctx.fillRect(sx, barY + u, segW, barH - 2 * u);
        // Highlight the top row of each lit segment.
        ctx.fillStyle = low ? COLOR.fireEmber : COLOR.fireCore;
        ctx.fillRect(sx, barY + u, segW, gap);
      } else if (i === fullSegs) {
        // The burning edge: a partial segment whose brightness flickers.
        const frac = lit - fullSegs;
        if (frac > 0.08) {
          const wSeg = Math.max(1, Math.round(segW * frac));
          ctx.fillStyle = low ? COLOR.alarm : flicker > 0.5 ? COLOR.fireHot : COLOR.fireEmber;
          ctx.fillRect(sx, barY + u, wSeg, barH - 2 * u);
        }
      }
    }

    // Remaining time, under the bar and right-aligned with it — never over the segments, which
    // would make both unreadable exactly when the gauge matters most.
    const run = state.run;
    drawText(ctx, formatTime(run.fuel), barX + barW, barY + barH + 2 * u, {
      font: 'hud',
      size: u,
      color: low ? 'hudAlarm' : 'hudDim',
      align: 'right',
    });
    return panelH;
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
    const scoreText = formatInt(scoreCounter.value);
    const gemsText = formatCount(run.gems, run.gemsTotal);
    // A six-figure score at double size does not fit beside the fuel gauge on a phone.
    const scoreSize = m.narrow ? u : 2 * u;
    const scoreH = textHeight({ font: 'hud', size: scoreSize });
    const gemH = textHeight({ font: 'hud', size: u });

    const scoreW = measureLine(scoreText, { font: 'hud', size: scoreSize });
    const gemsTextW = measureLine(gemsText, { font: 'hud', size: u });
    const gemsW = gemsTextW + (ICON_SIZE.gem + 2) * u;
    const inner = Math.max(scoreW, gemsW, 20 * u);
    const panelW = inner + 8 * u;
    const panelH = scoreH + gemH + 9 * u;
    const px = m.w - pad - panelW;

    drawPanel(ctx, px, pad, panelW, panelH, u, { frame: 'stone' });

    const right = m.w - pad - 4 * u;
    drawText(ctx, scoreText, right, pad + 3 * u, {
      font: 'hud',
      size: scoreSize,
      color: 'hudGold',
      align: 'right',
    });

    const gemY = pad + 3 * u + scoreH + 2 * u;
    drawText(ctx, gemsText, right, gemY, { font: 'hud', size: u, color: 'hudGem', align: 'right' });
    drawGemIcon(ctx, right - gemsW, gemY, u);
  }

  /**
   * Top-centre: the depth and the level clock. Deliberately small — the middle of the screen is
   * where the game is.
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @param {number} fuelH height of the fuel panel, for the stacked (narrow) layout
   * @returns {void}
   */
  function drawDepthPanel(ctx, state, m, fuelH) {
    const u = m.u;
    const pad = 3 * u;
    const depth = formatDepth(state.level);
    const clockText = formatClock(state.run.levelTime);
    const lineH = textHeight({ font: 'hud', size: u });
    const w = Math.max(
      measureLine(depth, { font: 'hud', size: u }),
      measureLine(clockText, { font: 'hud', size: u }),
    );
    const panelW = w + 8 * u;
    const panelH = lineH * 2 + 9 * u;
    // Centre on a wide screen; stack under the fuel gauge when there is no room between the two
    // top clusters.
    const px = m.narrow ? pad : Math.round((m.w - panelW) / 2);
    const py = m.narrow ? pad + fuelH + 2 * u : pad;

    drawPanel(ctx, px, py, panelW, panelH, u, { frame: 'wood', rivets: false });
    const cx = px + Math.round(panelW / 2);
    drawText(ctx, depth, cx, py + 4 * u, {
      font: 'hud',
      size: u,
      color: 'hudGold',
      align: 'center',
    });
    drawText(ctx, clockText, cx, py + 4 * u + lineH + 2 * u, {
      font: 'hud',
      size: u,
      color: 'hudDim',
      align: 'center',
    });
  }

  /**
   * Bottom-centre: a dial whose needle points at the exit, in *view-relative* terms (up = straight
   * ahead), because a north-up compass in a first-person maze is a puzzle rather than a help.
   *
   * It only appears once the player has earned it: always on the first two depths while the rules
   * are still being learned, and from depth 3 only after half the gems are collected
   * (ARCHITECTURE.md §4.6).
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawCompass(ctx, state, m, reduced) {
    const level = state.levelData;
    if (level === null) return;
    const run = state.run;
    const earned = state.level <= 2 || (run.gemsTotal > 0 && run.gems * 2 >= run.gemsTotal);
    if (!earned) return;

    const u = m.u;
    const r = 9 * u;
    const cx = Math.round(m.w / 2);
    const cy = Math.round(m.h - 4 * u - r);

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
  }

  /**
   * Bottom-right: the explored map.
   *
   * The tile grid is rasterised once into an offscreen canvas at one pixel per tile and then blitted
   * at an integer zoom, so a 81×81 maze costs one `drawImage` per frame instead of 6 561 fills. It
   * is rebuilt only when the explored count changes (the set only ever grows, so the count is an
   * exact dirty check) or when the level changes.
   * @param {CanvasRenderingContext2D} ctx
   * @param {GameState} state
   * @param {SurfaceMetrics} m
   * @param {boolean} reduced
   * @returns {void}
   */
  function drawMinimap(ctx, state, m, reduced) {
    const level = state.levelData;
    const explored = state.explored;
    if (level === null || explored === null) return;
    const maze = level.maze;
    const mw = maze.width;
    const mh = maze.height;
    // A mismatched explored buffer would be read out of bounds below (and `undefined !== 0` would
    // paint the whole map as seen), so a malformed pair simply hides the map.
    if (mw < 1 || mh < 1 || explored.length < mw * mh) return;

    const u = m.u;
    const pad = 3 * u;
    // ≤ 30 % of the screen height (§4.6), and never more than a third of the width.
    const maxH = Math.floor(m.h * 0.3);
    const maxW = Math.floor(m.w * 0.32);
    const zoom = Math.max(1, Math.min(Math.floor(maxW / mw), Math.floor(maxH / mh)));
    const drawW = mw * zoom;
    const drawH = mh * zoom;
    const frame = 2 * u;
    const px = m.w - pad - drawW - frame * 2;
    const py = m.h - pad - drawH - frame * 2;

    if (!ensureMapCanvas(mw, mh)) return;
    const count = countExplored(explored);
    if (count !== mapExplored || mapLevelRef !== level) {
      rebuildMap(maze, explored);
      mapExplored = count;
      mapLevelRef = level;
    }

    drawPanel(ctx, px, py, drawW + frame * 2, drawH + frame * 2, u, {
      frame: 'stone',
      alpha: 0.82,
      border: u,
      rivets: false,
      // No masonry behind the map: the courses would read as corridors.
      texture: false,
    });

    const ox = px + frame;
    const oy = py + frame;
    if (mapCanvas !== null) {
      ctx.drawImage(mapCanvas, 0, 0, mw, mh, ox, oy, drawW, drawH);
    }

    // Exit portal, once its tile has been seen.
    const exitIdx = maze.exit.y * mw + maze.exit.x;
    if (explored[exitIdx] !== 0) {
      const pulse = reduced ? 1 : 0.55 + 0.45 * Math.sin(clock * 4);
      ctx.fillStyle = withAlpha(COLOR.arcCyan, pulse);
      const ez = Math.max(2, zoom + u);
      ctx.fillRect(
        Math.round(ox + (maze.exit.x + 0.5) * zoom - ez / 2),
        Math.round(oy + (maze.exit.y + 0.5) * zoom - ez / 2),
        ez,
        ez,
      );
    }

    // Player arrow, blinking so the eye finds it instantly on a busy map. Mostly on, briefly off:
    // a marker that is missing half the time is a marker you have to hunt for.
    const blink = reduced ? true : clock % 1.1 < 0.82;
    if (blink) {
      const p = state.player;
      const octant = (Math.round(p.angle / (Math.PI / 4)) & 7) >>> 0;
      const arrow = ARROWS[octant];
      const scale = Math.max(1, Math.round(zoom / 2));
      drawArt(
        ctx,
        arrow,
        Math.round(ox + p.x * zoom - (arrow.w * scale) / 2),
        Math.round(oy + p.y * zoom - (arrow.h * scale) / 2),
        scale,
        ARROW_PALETTE,
      );
    }
  }

  /**
   * Make sure the offscreen minimap buffer exists and is the right size.
   * @param {number} w tiles
   * @param {number} h tiles
   * @returns {boolean} false when no canvas implementation is available
   */
  function ensureMapCanvas(w, h) {
    if (mapCanvas !== null && mapW === w && mapH === h) return true;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      return false;
    }
    try {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const context = c.getContext('2d');
      if (context === null) return false;
      mapCanvas = c;
      mapCtx = context;
      mapW = w;
      mapH = h;
      mapExplored = -1;
      return true;
    } catch (err) {
      log.error('minimap canvas unavailable', err);
      return false;
    }
  }

  /**
   * Repaint the offscreen minimap: one pixel per tile, explored only.
   * @param {import('../core/types.js').Maze} maze
   * @param {Uint8Array} explored
   * @returns {void}
   */
  function rebuildMap(maze, explored) {
    if (mapCtx === null || mapCanvas === null) return;
    const w = maze.width;
    const h = maze.height;
    const tiles = maze.tiles;
    const img = mapCtx.createImageData(w, h);
    const px = img.data;
    for (let i = 0, n = w * h; i < n; i++) {
      if (explored[i] === 0) continue;
      const o = i * 4;
      if (tiles[i] === 0) {
        // Explored floor: warm cobble grey.
        px[o] = 0x5b;
        px[o + 1] = 0x57;
        px[o + 2] = 0x51;
        px[o + 3] = 235;
      } else {
        // Explored wall: cool stone, dark enough that corridors read as the bright shape.
        px[o] = 0x2b;
        px[o + 1] = 0x34;
        px[o + 2] = 0x46;
        px[o + 3] = 235;
      }
    }
    mapCtx.putImageData(img, 0, 0);
  }

  /**
   * Count explored tiles. The explored set only grows, so its cardinality is a perfect and cheap
   * dirty check (a 40×40 maze is 6 561 byte reads — a few microseconds).
   * @param {Uint8Array} explored
   * @returns {number}
   */
  function countExplored(explored) {
    let n = 0;
    for (let i = 0; i < explored.length; i++) n += explored[i] !== 0 ? 1 : 0;
    return n;
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
    for (let i = 0; i < MAX_POPS; i++) {
      const p = pops[i];
      if (p.t < 0) continue;
      const t = p.t / POP_LIFE;
      // Ease-out rise: fast off the mark, drifting to a stop, fading over the last third.
      const rise = (1 - (1 - t) * (1 - t)) * 22 * u;
      const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      const size = Math.max(1, u + 1);
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
    mapCanvas = null;
    mapCtx = null;
    mapW = 0;
    mapH = 0;
  }

  return { render, resize, surface, pop, reset, dispose };
}

// ─── Small geometry helpers ──────────────────────────────────────────────────────────────────

/**
 * Deterministic 0..1 flicker noise. Two incommensurable sines: cheap, allocation free, and it
 * never repeats on a visible period — which is exactly what a flame needs.
 * @param {number} t seconds
 * @returns {number} 0..1
 */
function noise(t) {
  return 0.5 + 0.25 * Math.sin(t) + 0.25 * Math.sin(t * 1.7 + 1.3);
}

/**
 * Fill a disc out of horizontal pixel runs (`fillRect` per scanline), so the edge is a hard pixel
 * staircase like the rest of the art instead of an anti-aliased arc.
 * @param {CanvasRenderingContext2D} ctx fill style must already be set
 * @param {number} cx centre x (UI px)
 * @param {number} cy centre y
 * @param {number} r radius
 * @param {number} step scanline height in UI px (the pixel size)
 * @returns {void}
 */
export function fillDisc(ctx, cx, cy, r, step) {
  const s = Math.max(1, Math.round(step));
  for (let y = -r; y <= r; y += s) {
    const half = Math.sqrt(Math.max(0, r * r - y * y));
    if (half < 0.5) continue;
    ctx.fillRect(Math.round(cx - half), Math.round(cy + y), Math.round(half * 2), s);
  }
}

/**
 * Fill a ring (a disc with a `step`-thick rim).
 * @param {CanvasRenderingContext2D} ctx fill style must already be set
 * @param {number} cx
 * @param {number} cy
 * @param {number} r outer radius
 * @param {number} step rim thickness and scanline height
 * @returns {void}
 */
export function fillRing(ctx, cx, cy, r, step) {
  const s = Math.max(1, Math.round(step));
  const inner = r - s;
  for (let y = -r; y <= r; y += s) {
    const outerHalf = Math.sqrt(Math.max(0, r * r - y * y));
    if (outerHalf < 0.5) continue;
    const innerHalf = Math.abs(y) <= inner ? Math.sqrt(Math.max(0, inner * inner - y * y)) : 0;
    if (innerHalf < 0.5) {
      ctx.fillRect(Math.round(cx - outerHalf), Math.round(cy + y), Math.round(outerHalf * 2), s);
      continue;
    }
    const left = Math.round(cx - outerHalf);
    const right = Math.round(cx + outerHalf);
    const il = Math.round(cx - innerHalf);
    const ir = Math.round(cx + innerHalf);
    ctx.fillRect(left, Math.round(cy + y), il - left, s);
    ctx.fillRect(ir, Math.round(cy + y), right - ir, s);
  }
}

/**
 * The largest integer text scale at which `text` fits `maxWidth` UI pixels.
 *
 * Used everywhere a title or a menu label has to survive a 360-pixel-wide phone without being
 * clipped: the layout asks for the size it wants and takes what fits.
 * @param {string} text
 * @param {number} maxWidth UI pixels
 * @param {TextOptions} opts measured with this face (its `size` is ignored)
 * @param {number} maxScale the size the layout would like
 * @param {number} [minScale] floor, default 1
 * @returns {number} an integer scale in [minScale, maxScale]
 */
export function fitScale(text, maxWidth, opts, maxScale, minScale = 1) {
  const lo = Math.max(1, Math.round(minScale));
  const hi = Math.max(lo, Math.round(maxScale));
  const unit = measureLine(text, { font: opts.font, size: 1, tracking: opts.tracking });
  if (unit <= 0) return hi;
  const fits = Math.floor(maxWidth / unit);
  return clamp(fits, lo, hi);
}
