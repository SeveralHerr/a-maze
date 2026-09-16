// @ts-check
/**
 * @file Surface-independent pixel-art primitives: indexed sprites, stone/wood panels, the icon
 * set, and the small geometry helpers every overlay module draws with.
 *
 * WHY this module exists: `hud.js` used to own all of this, which forced `map.js` (the new
 * three-state labyrinth map) either to duplicate the primitives or to import `hud.js` — and
 * `hud.js` imports `map.js`, so that would have been an import cycle. Splitting the leaf
 * primitives out makes the module graph a strict DAG:
 *
 * ```
 * font.js ─┐
 * format.js┼─► pixels.js ─► map.js ─► hud.js ─► menus.js
 * core/*  ─┘
 * ```
 *
 * `hud.js` re-exports everything here verbatim, so the public surface described by
 * ARCHITECTURE.md §4.6 (`drawPanel`, `drawWell`, `drawArt`, `compileArt`, the icons, `withAlpha`)
 * is unchanged for `menus.js` and for the tests.
 *
 * Nothing in here touches a canvas *element*, a surface or game state: every function takes a
 * 2-D context and integer UI pixels. That is what makes the whole file testable in Node with a
 * recording stub context.
 */

import { clamp, clamp01 } from '../core/math.js';
import { createLogger } from '../core/log.js';
import { COLOR, measureLine } from './font.js';

/** @typedef {import('./font.js').TextOptions} TextOptions */

const log = createLogger('ui/pixels');

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

/**
 * `#rrggbb` → the three 8-bit channels, written into `out`.
 *
 * Exported for the map rasteriser, which needs the numbers rather than a CSS string: it writes
 * straight into an `ImageData` buffer.
 * @param {string} hex `#rrggbb`
 * @param {Uint8Array|number[]} out length ≥ 3; receives r, g, b
 * @returns {void}
 */
export function hexToRgb(hex, out) {
  out[0] = parseInt(hex.slice(1, 3), 16) || 0;
  out[1] = parseInt(hex.slice(3, 5), 16) || 0;
  out[2] = parseInt(hex.slice(5, 7), 16) || 0;
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
 * The exit portal glyph, 7×7 — a ring with a bright core. Used by the map legend and by the
 * full-screen map at large scales, where a single pixel would be lost.
 * 1 rim, 2 mid, 3 core.
 */
const PORTAL_ART = compileArt(
  ['..111..', '.12221.', '1233321', '1233321', '1233321', '.12221.', '..111..'],
  'portal',
);

/** Portal palette: violet rim → cyan core. */
const PORTAL_PALETTE = Object.freeze([null, COLOR.arcViolet, COLOR.arcMid, COLOR.arcPale]);

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
 * Player arrows for the 8 compass headings, indexed by `round(angle / 45°) & 7` with 0 = east,
 * matching the sim's angle convention (0 = +x, +y = south).
 * @type {ReadonlyArray<Art>}
 */
export const ARROWS = (() => {
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
export const ARROW_PALETTE = Object.freeze([null, COLOR.void, COLOR.fireCore]);

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
 * Draw the exit-portal glyph (map legend, large-scale map marker).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} scale
 * @returns {void}
 */
export function drawPortalIcon(ctx, x, y, scale) {
  drawArt(ctx, PORTAL_ART, x, y, scale, PORTAL_PALETTE);
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
  portal: PORTAL_ART.w,
});

// ─── Small geometry helpers ──────────────────────────────────────────────────────────────────

/**
 * A hollow rectangle drawn as four fills, so the outline is exactly `t` UI pixels thick and lands
 * on whole pixels. `ctx.strokeRect` would straddle the path by half a line width and blur at an
 * integer scale, which is the one thing this whole overlay is built to avoid.
 * @param {CanvasRenderingContext2D} ctx fill style must already be set
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} t thickness in UI pixels (≥ 1)
 * @returns {void}
 */
export function strokeRect(ctx, x, y, w, h, t) {
  const b = Math.max(1, Math.round(t));
  const px = Math.round(x);
  const py = Math.round(y);
  const pw = Math.round(w);
  const ph = Math.round(h);
  ctx.fillRect(px, py, pw, b);
  ctx.fillRect(px, py + ph - b, pw, b);
  ctx.fillRect(px, py + b, b, ph - b * 2);
  ctx.fillRect(px + pw - b, py + b, b, ph - b * 2);
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
