// @ts-check
/**
 * @file Screen-space post effects driven entirely by CSS (ARCHITECTURE.md §4.5).
 *
 * Scanlines, vignette, the low-fuel red pulse, the pickup flash and the level-transition iris are
 * all *full-screen* effects. Doing them in the raycaster would cost a second pass over every pixel
 * of the framebuffer every frame; doing them as five stacked, `pointer-events: none` layers costs
 * the compositor a few blends on the GPU and the main thread nothing at all.
 *
 * The one rule that makes that true: **touch the DOM only when a value actually changes.** Every
 * setter compares against a cached number first, and continuous values are quantised (alpha to
 * 1/128, the iris to 0.5 %) so an animating effect writes a style perhaps twenty times a second
 * instead of sixty. `set()` is therefore safe to call unconditionally from the render loop.
 *
 * The scanline pitch is derived from the renderer's internal resolution: exactly one dark line per
 * internal pixel row, so the pattern is locked to the rows it darkens. A pitch that is a whole
 * number of CSS pixels is drawn with whole-pixel stops (crisp); any other pitch — 1080 CSS px over
 * 240 rows is 4.5 — is drawn at its true fractional period rather than rounded, because a rounded
 * period drifts against the rows and beats into moiré across the screen.
 *
 * Owns its own stylesheet because `styles.css` is integrator territory; the sheet is injected once
 * per document and is namespaced under `.amaze-post-*`.
 */

import { hex, rgba, C } from './palette.js';

/** Style element id, so a hot reload or a second renderer does not inject the sheet twice. */
const STYLE_ID = 'amaze-post-style';

/** Alpha quantisation step — finer than the eye can see, coarse enough to stop style churn. */
const ALPHA_STEP = 1 / 128;

/** Iris radius quantisation, in percent of the screen diagonal. */
const IRIS_STEP = 0.5;

/**
 * Everything `set()` understands. Omitted fields keep their previous value, so callers can drive
 * one effect without restating the others.
 * @typedef {Object} PostOptions
 * @property {boolean} [scanlines]      CRT scanline overlay (a user setting)
 * @property {number} [vignette]        0..1 strength of the corner darkening
 * @property {number} [lowFuelPulse]    0..1 red pulse; drive it with a sine of the sim clock
 * @property {import('../core/types.js').Flash} [flash]  full-screen tint, `a` 0..1
 * @property {number} [iris]            1 = fully open, 0 = closed (level transition wipe)
 */

/**
 * @typedef {Object} Post
 * @property {(opts:PostOptions) => void} set
 * @property {(cssW:number, cssH:number, internalH:number) => void} resize
 * @property {() => void} destroy
 */

/**
 * Inject the effect stylesheet once per document.
 * @param {Document} doc
 * @returns {void}
 */
function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  // `will-change: opacity` keeps the pulse and flash layers on their own compositor layer, so an
  // opacity change never repaints the page. Every layer is inert to input.
  style.textContent = `
.amaze-post-layer{position:absolute;inset:0;pointer-events:none;}
.amaze-post-scan{opacity:0;mix-blend-mode:multiply;}
.amaze-post-vig{opacity:0;background:radial-gradient(ellipse 78% 78% at 50% 50%,rgba(0,0,0,0) 38%,${rgba(
    C.void,
    0.92,
  )} 100%);}
.amaze-post-low{opacity:0;will-change:opacity;background:radial-gradient(ellipse 85% 85% at 50% 50%,rgba(0,0,0,0) 30%,rgba(168,28,20,0.85) 100%);}
.amaze-post-flash{opacity:0;will-change:opacity;background:#fff;}
.amaze-post-iris{opacity:0;background:radial-gradient(circle at 50% 50%,rgba(0,0,0,0) 0 100%,${hex(
    C.void,
  )} 100%);}
`;
  doc.head.appendChild(style);
}

/** A `Post` that does nothing — returned when there is no DOM to drive. */
const NULL_POST = Object.freeze({
  set() {},
  resize() {},
  destroy() {},
});

/**
 * Create the post-effect stack inside `rootEl` (the page's `#post` div).
 *
 * Fails soft: without a usable element (Node, a missing `#post`) it returns a no-op object, so
 * main.js never needs to branch on whether effects are available.
 * @param {Element|null|undefined} rootEl
 * @returns {Post}
 */
export function createPost(rootEl) {
  const doc = rootEl && rootEl.ownerDocument;
  if (!rootEl || !doc || typeof doc.createElement !== 'function') return NULL_POST;
  ensureStyle(doc);

  /**
   * @param {string} cls
   * @returns {HTMLElement}
   */
  const layer = (cls) => {
    const el = doc.createElement('div');
    el.className = `amaze-post-layer ${cls}`;
    rootEl.appendChild(el);
    return /** @type {HTMLElement} */ (el);
  };

  // Stacking order is the insertion order: scanlines sit under the vignette, which sits under the
  // warning pulse, then the flash, then the iris on top of everything.
  const scanEl = layer('amaze-post-scan');
  const vigEl = layer('amaze-post-vig');
  const lowEl = layer('amaze-post-low');
  const flashEl = layer('amaze-post-flash');
  const irisEl = layer('amaze-post-iris');

  // Cached state: the whole point of this module is to not write these unless they change.
  let scanOn = /** @type {boolean|null} */ (null);
  let scanPitch = -1;
  let vigVal = -1;
  let lowVal = -1;
  let flashA = -1;
  let flashRGB = -1;
  let irisVal = -1;

  /**
   * Quantise a 0..1 value so continuous animation does not write a style every frame.
   * @param {number} v
   * @param {number} step
   * @returns {number}
   */
  function quant(v, step) {
    const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
    return Math.round(c / step) * step;
  }

  /**
   * Rebuild the scanline gradient for the current display size.
   *
   * `pitch` is how many CSS pixels one internal framebuffer row occupies. It used to be rounded to
   * a whole number, which is exact at 720p (3 px) but at 1080p put a 5 px period over 4.5 px rows,
   * and the dark line then walked through the rows in a 9-row beat — the moiré the rounding was
   * meant to prevent. Now a fractional pitch is drawn at its true period. Chrome snaps each hard
   * one-pixel stop to a device row, so the lines land 4 and 5 px apart in turn — exactly the rows
   * the pixelated upscale gives the framebuffer — and stay locked to them top to bottom (measured
   * at 1917×1080: 240 lines for 240 rows, every line within half a pixel of its row, 234 of 240 a
   * single row of identical weight). A whole pitch keeps whole-pixel stops. Below 2 CSS pixels per
   * row there is no room for a line, so the overlay switches itself off.
   * @param {number} pitch CSS pixels per internal row (whole, or rounded to 1/1000)
   * @returns {void}
   */
  function applyScanPitch(pitch) {
    scanPitch = pitch;
    if (!(pitch >= 2)) {
      scanEl.style.backgroundImage = 'none';
      return;
    }
    const whole = pitch === Math.round(pitch);
    const band = Math.round(pitch);
    // One dark line per internal row: a single CSS pixel up to a 6 px pitch, two beyond.
    const thick = band >= 6 ? 2 : 1;
    // Strength scales with the pitch. At a wide pitch the dark line is one row in six and reads as
    // CRT character; at the shipped 3 px pitch (1280×720 over a 240-row buffer) it is one row in
    // THREE, and at 0.42 that cost ~14 % of the mean luminance plus hard banding straight across
    // every wall face — measurably more wall detail than the effect was buying.
    const lineDark = band >= 6 ? 0.42 : band >= 5 ? 0.34 : band >= 4 ? 0.28 : 0.22;
    // A fractional pitch keeps the mean darkening (`alpha × thick / pitch`) of its nearest whole
    // pitch, so 4.5 px rows read neither lighter nor darker than 4 or 5 px ones.
    const dark = whole ? lineDark : Math.round(((lineDark * pitch) / band) * 1000) / 1000;
    // The gap is fully transparent. It used to carry a faint white "lift", but this layer blends
    // with `multiply`, and multiplying by white leaves the picture exactly as it was.
    scanEl.style.backgroundImage =
      `repeating-linear-gradient(to bottom,` +
      `rgba(0,0,0,${dark}) 0px, rgba(0,0,0,${dark}) ${thick}px,` +
      `rgba(0,0,0,0) ${thick}px, rgba(0,0,0,0) ${pitch}px)`;
  }

  /**
   * Tell the overlay how big the display is and how many internal rows it is showing.
   * @param {number} cssW display width in CSS pixels (unused today; part of the contract shape)
   * @param {number} cssH display height in CSS pixels
   * @param {number} internalH renderer internal height in pixels
   * @returns {void}
   */
  function resize(cssW, cssH, internalH) {
    const rows = internalH > 0 ? internalH : 240;
    const rowPx = (cssH > 0 ? cssH : rows) / rows;
    const nearest = Math.round(rowPx);
    // Snap only when the rounding error, accumulated over every row, stays under about one CSS
    // pixel top to bottom — too little to form a beat — since whole-pixel stops are crisper.
    const pitch = Math.abs(rowPx - nearest) * rows <= 1 ? nearest : Math.round(rowPx * 1000) / 1000;
    if (pitch !== scanPitch) applyScanPitch(pitch);
  }

  /**
   * Apply an effect state. Every field is optional and independently cached.
   * @param {PostOptions} opts
   * @returns {void}
   */
  function set(opts) {
    if (!opts) return;

    if (opts.scanlines !== undefined) {
      const on = opts.scanlines === true;
      if (on !== scanOn) {
        scanOn = on;
        if (scanPitch < 0) applyScanPitch(3); // sensible default until the first resize()
        scanEl.style.opacity = on ? '1' : '0';
      }
    }

    if (opts.vignette !== undefined) {
      const v = quant(opts.vignette, ALPHA_STEP);
      if (v !== vigVal) {
        vigVal = v;
        vigEl.style.opacity = String(v);
      }
    }

    if (opts.lowFuelPulse !== undefined) {
      const v = quant(opts.lowFuelPulse, ALPHA_STEP);
      if (v !== lowVal) {
        lowVal = v;
        lowEl.style.opacity = String(v);
      }
    }

    if (opts.flash !== undefined) {
      const f = opts.flash;
      const a = f ? quant(f.a, ALPHA_STEP) : 0;
      if (a !== flashA) {
        flashA = a;
        flashEl.style.opacity = String(a);
      }
      if (a > 0 && f) {
        // Colour only matters while the layer is visible, so it is written at most as often.
        const key = (((f.r | 0) & 255) << 16) | (((f.g | 0) & 255) << 8) | ((f.b | 0) & 255);
        if (key !== flashRGB) {
          flashRGB = key;
          flashEl.style.backgroundColor = `rgb(${(key >> 16) & 255},${(key >> 8) & 255},${key & 255})`;
        }
      }
    }

    if (opts.iris !== undefined) {
      const v = quant(opts.iris, IRIS_STEP / 100);
      if (v !== irisVal) {
        irisVal = v;
        if (v >= 1) {
          // Fully open: hide the layer entirely so the compositor can drop it.
          irisEl.style.opacity = '0';
        } else {
          // A hard-stop radial gradient is a real iris: transparent inside the circle, solid
          // outside. `clip-path` cannot cut a hole, and a second element would cost another layer.
          const r = (v * 78).toFixed(1);
          irisEl.style.opacity = '1';
          irisEl.style.background =
            `radial-gradient(circle at 50% 50%,` +
            `rgba(0,0,0,0) 0 ${r}%, ${rgba(C.void, 0.55)} ${r}%, ${hex(C.void)} ${(
              Number(r) + 6
            ).toFixed(1)}%)`;
        }
      }
    }
  }

  /** Remove every layer this instance added. The shared stylesheet stays; it is inert. */
  function destroy() {
    for (const el of [scanEl, vigEl, lowEl, flashEl, irisEl]) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
  }

  return { set, resize, destroy };
}
