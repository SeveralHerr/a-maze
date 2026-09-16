// @ts-check
/**
 * @file Procedurally painted 64×64 pixel-art textures (ARCHITECTURE.md §4.5).
 *
 * Every surface and sprite in the game is painted here from `palette.js` indices — there are no
 * image assets, so the download is a few kilobytes of code and the art is reproducible from a
 * seed. Painting the whole set costs roughly 10–20 ms once at load.
 *
 * ART DIRECTION (docs/art-reference.png):
 * - **Walls** — big landscape blue-grey stone blocks (~2:1) in a running bond, each face a few flat
 *   hard-edged tonal patches rather than a dithered gradient, dark navy mortar grooves, a light
 *   bevel on the top/left edge of every block, granular flecks, hairline cracks, and variants where
 *   moss creeps out of the mortar and vines hang down the face. Every variant shares one course
 *   table, so bed joints run unbroken along a wall.
 * - **Floor** — irregular rounded cobbles (a jittered Voronoi) in neutral grey with near-black
 *   gaps, moss tufts in the gaps, plus an occasional iron grate tile.
 * - **Ceiling** — dark brown planks with grain, nails and knots, and a heavier cross beam every
 *   few tiles.
 * - **Sprites** — iron sconce with a 4-frame flame, a swirling violet/cyan portal, a faceted
 *   spinning gem, an amber oil flask, a sparkle, and a rolled parchment map scroll tied with a red
 *   ribbon (deliberately dim — it is hidden, not a beacon).
 *
 * INVARIANTS (the raycaster depends on all of these):
 * - Textures are `SIZE × SIZE` with `SIZE = 64`, **row-major**: `index = (y << 6) | x`.
 * - `indices[i]` is a palette index; `pixels[i]` is the same texel already packed for the
 *   framebuffer. Index 0 is the transparency key and is never drawn.
 * - World-surface textures (wall/floor/ceiling) must be **seamless**: floor and ceiling tile on
 *   both axes (a tile repeats in x and y), and walls tile horizontally. Every wall variant puts its
 *   bed joints on the same rows (`COURSES`, asserted in `textures.test.mjs`), so wall tiles of any
 *   variant line up across a seam, and none of those rows is the eye-level row 32 (`COURSE_PHASE`).
 *   Every noise function here is toroidal on a 64 px period, and block layouts wrap in both axes,
 *   which is what makes that true.
 * - `stipple[i] === 1` marks a texel the renderer draws only on odd screen-space `(x+y)` parity —
 *   a 1-bit "half transparent" used for flame and portal glow. It is screen-space on purpose, so
 *   the dissolve stays a fixed checker no matter how large the sprite is drawn.
 *
 * Node-safe: no DOM access, so the whole set can be painted and asserted in unit tests.
 */

import { createRng, hash2 } from '../core/rng.js';
import { C, PALETTE, RAMPS } from './palette.js';

/** Texture edge length in texels. 64 matches the reference's chunk size at 240p internal res. */
export const SIZE = 64;

/** `x & MASK` / `y & MASK` wraps a coordinate into the texture — the source of seamlessness. */
const MASK = SIZE - 1;

/** Texels per texture. */
const AREA = SIZE * SIZE;

/** 1 / 2^32 — turns a uint32 hash into a float in [0,1). */
const INV_U32 = 2.3283064365386963e-10;

/**
 * 4×4 ordered (Bayer) dither thresholds, pre-divided so each value sits in [0,1) at the centre of
 * its bucket. `floor(value + threshold)` is then an unbiased quantisation: it is what lets an
 * 8-step ramp fake ~32 steps without the banding a hard `round()` would produce.
 */
const BAYER = Float32Array.from(
  [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5],
  (v) => (v + 0.5) / 16,
);

/**
 * One painted texture.
 * @typedef {Object} Texture
 * @property {number} w              always `SIZE`
 * @property {number} h              always `SIZE`
 * @property {Uint8Array} indices    row-major palette indices, `(y<<6)|x`; 0 = transparent
 * @property {Uint32Array} pixels    the same texels packed for the framebuffer (alpha 0 at index 0)
 * @property {Uint8Array|null} stipple 1 = draw on odd screen `(x+y)` parity only; null = solid
 * @property {boolean} emissive      true when the art is its own light source (flame, portal)
 */

/**
 * The full texture set. Every field is an array so the renderer can index variants (walls, floor)
 * and animation frames (torch, gem, oil, portal, sparkle) through the same code path.
 * @typedef {Object} TextureSet
 * @property {number} seed          the seed it was painted from
 * @property {number} size          `SIZE`
 * @property {Texture[]} wall       4 variants: plain, cracked, mossy, vined
 * @property {Texture[]} floor      3 variants: cobbles A, cobbles B, iron grate
 * @property {Texture[]} ceiling    2 variants: planks, planks + cross beam
 * @property {Texture[]} torch      4 flame frames (sconce baked in), emissive
 * @property {Texture[]} portal     8 swirl frames, emissive
 * @property {Texture[]} gem        8 spin frames
 * @property {Texture[]} oil        4 bob frames
 * @property {Texture[]} sparkle    4 frames, emissive
 * @property {Texture[]} map        1 frame: the hidden map scroll (§4.8), solid, not emissive
 */

/** Scratch mask reused by the wall painter (mortar map). Painting is single-threaded and
 *  sequential, so one shared buffer is safe and keeps load-time allocation flat. */
const scratchMask = new Uint8Array(AREA);

// ─── Low-level painting primitives ─────────────────────────────────────────────────────────────

/**
 * Write a texel, wrapping both axes (toroidal paint = seamless tiling).
 * @param {Uint8Array} buf
 * @param {number} x
 * @param {number} y
 * @param {number} c palette index
 * @returns {void}
 */
function put(buf, x, y, c) {
  buf[((y & MASK) << 6) | (x & MASK)] = c;
}

/**
 * Write a texel only when it lands inside the texture (used by sprite art, which must not wrap).
 * @param {Uint8Array} buf
 * @param {number} x
 * @param {number} y
 * @param {number} c palette index
 * @returns {void}
 */
function putClip(buf, x, y, c) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  buf[(y << 6) | x] = c;
}

/**
 * Ordered-dither pick from a ramp.
 * @param {Uint8Array} ramp dark → light palette indices
 * @param {number} t 0..1 position along the ramp (clamped)
 * @param {number} x texel x (dither phase)
 * @param {number} y texel y (dither phase)
 * @returns {number} palette index
 */
function rampPick(ramp, t, x, y) {
  const last = ramp.length - 1;
  const f = (t <= 0 ? 0 : t >= 1 ? 1 : t) * last;
  let i = (f + BAYER[((y & 3) << 2) | (x & 3)]) | 0;
  if (i > last) i = last;
  return ramp[i];
}

/**
 * Ordered-dither pick with the dither phase taken at **2×2 block granularity**.
 *
 * WHY: a per-texel Bayer pattern on a large surface reads as TV static once it is magnified by the
 * raycaster, which is exactly the "programmer art" look the reference avoids. Snapping the dither
 * phase to 2×2 blocks turns the same gradient into the chunky pixel clusters the reference is
 * built from — the art direction's "2–3 px pixel clusters" — while still killing ramp banding.
 * Every large flat surface (walls, cobbles, planks, glass) uses this; small sprites that need
 * per-texel detail (flame, portal) use `rampPick`.
 * @param {Uint8Array} ramp dark → light palette indices
 * @param {number} t 0..1 position along the ramp (clamped)
 * @param {number} x texel x
 * @param {number} y texel y
 * @returns {number} palette index
 */
function rampPickChunky(ramp, t, x, y) {
  const last = ramp.length - 1;
  const f = (t <= 0 ? 0 : t >= 1 ? 1 : t) * last;
  let i = (f + BAYER[(((y >> 1) & 3) << 2) | ((x >> 1) & 3)]) | 0;
  if (i > last) i = last;
  return ramp[i];
}

/**
 * Nearest ramp step, **no dither at all**.
 *
 * WHY a third variant: an ordered dither turns a smooth tone gradient into two alternating ramp
 * steps, and on a wall one tile from the eye a texel is six screen pixels, so those two steps read
 * as a checkerboard painted across the stone. The reference's masonry has no gradients in it — a
 * block face is a handful of *flat* irregular patches of a few greys with hard edges between them,
 * which is exactly what quantising the face's noise without a dither produces. Used for wall block
 * faces and their weathering; the mortar bed, the moss and every other surface keep their dither,
 * where the magnification is lower or the gradient is the point.
 * @param {Uint8Array} ramp dark → light palette indices
 * @param {number} t 0..1 position along the ramp (clamped)
 * @returns {number} palette index
 */
function rampPickFlat(ramp, t) {
  const last = ramp.length - 1;
  const f = (t <= 0 ? 0 : t >= 1 ? 1 : t) * last;
  let i = (f + 0.5) | 0;
  if (i > last) i = last;
  return ramp[i];
}

/**
 * Hash-derived float in [0,1) for a lattice point.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number}
 */
function h01(x, y, seed) {
  return hash2(x, y, seed) * INV_U32;
}

/**
 * Tileable value noise. The lattice wraps every `SIZE / cell` points, so the result is seamless on
 * a 64-texel torus for any `cell` that divides 64.
 * @param {number} x
 * @param {number} y
 * @param {number} cell lattice spacing in texels (must divide SIZE)
 * @param {number} seed
 * @returns {number} 0..1
 */
function vnoise(x, y, cell, seed) {
  const n = SIZE / cell;
  const m = n - 1;
  const fx = x / cell;
  const fy = y / cell;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  // Smoothstep keeps the lattice invisible; a linear blend shows diamond artefacts at this scale.
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const x0 = ix & m;
  const y0 = iy & m;
  const x1 = (ix + 1) & m;
  const y1 = (iy + 1) & m;
  const a = h01(x0, y0, seed);
  const b = h01(x1, y0, seed);
  const c = h01(x0, y1, seed);
  const d = h01(x1, y1, seed);
  const top = a + (b - a) * sx;
  const bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}

/**
 * Three-octave tileable fractal noise, sampled on a 2-texel grid so the result comes out in the
 * chunky 2×2 clusters the reference art is built from rather than as smooth per-pixel grain.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number} 0..1
 */
function fbmChunky(x, y, seed) {
  const qx = x & ~1;
  const qy = y & ~1;
  return (
    0.52 * vnoise(qx, qy, 16, seed) +
    0.31 * vnoise(qx, qy, 8, seed ^ 0x5bd1) +
    0.17 * vnoise(qx, qy, 4, seed ^ 0x27d4)
  );
}

/**
 * Fill a wrapping rectangle with a constant index.
 * @param {Uint8Array} buf
 * @param {number} x0
 * @param {number} y0
 * @param {number} w
 * @param {number} h
 * @param {number} c
 * @returns {void}
 */
function fillRect(buf, x0, y0, w, h, c) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(buf, x0 + x, y0 + y, c);
}

// ─── Walls ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Texel row the first course starts on, i.e. how far the whole bond is slid down the wall.
 *
 * WHY not 0: the eye is at exactly half the wall height, so texel row 32 lands on the horizon at
 * every distance, and so does whatever is painted there. With the courses starting at row 0 that was
 * a mortar joint over a lit bevel — one dead-straight line across every wall on screen, near or far,
 * that perspective could never bend (and head bob moves the texture with the horizon, so it never
 * moved either). Sliding the bond 8 rows puts the eye line inside a block face, where the reference
 * has it, and lets the floor and ceiling cut the top and bottom courses part-way up a block, the way
 * real masonry meets a floor.
 */
const COURSE_PHASE = 8;

/**
 * Course (block row) boundaries, shared by **every** wall variant.
 *
 * WHY one table: the raycaster ties texel rows to world height, so with a shared table the bed
 * joints of every wall tile sit at the same four heights and run unbroken along a wall and round
 * its corners — the reference's masonry. An earlier round gave each variant its own phase and slid
 * tiles vertically to stop the lit top bevels fusing into bright rails down a long corridor; that
 * broke the rails, but the joints then jumped height at every tile seam and each metre of wall read
 * as its own slab. The rails are now broken where they come from instead: every block paints its
 * bevel at its own strength and its face at its own tone (`paintBlock`).
 *
 * Four courses of 16 texels: with `MORTAR` taken off, a face is ~13 texels tall against ~29 wide —
 * the reference's landscape proportion (~2:1). The table spans exactly `SIZE` rows, so the last
 * course wraps round the bottom of the texture into its top and the painting stays seamless.
 * @type {Int32Array}
 */
const COURSES = Int32Array.of(0, 16, 32, 48, 64).map((y) => y + COURSE_PHASE);

/** Mortar groove width in texels — the dark navy line between blocks. */
const MORTAR = 3;

/**
 * Block cell width in texels, including the mortar groove: `BLOCK_W_MIN … +BLOCK_W_SPREAD-1`.
 *
 * Two blocks across a 64-texel tile face, so a face is ~29 × 13 texels (≈2.2:1 landscape). On a
 * grazing corridor wall a tile's 64 texels of width compress to 10–25 screen pixels while its 64
 * texels of height occupy 60–240, so a *square* texel block lands on screen as a 1:5 portrait
 * sliver; starting from 2.2:1 is what keeps it reading as a block after that foreshortening.
 */
const BLOCK_W_MIN = 28;
const BLOCK_W_SPREAD = 12;

/**
 * Paint one stone block face, its bevel, cracks and speckle.
 * @param {Uint8Array} buf  index buffer
 * @param {Uint8Array} mask mortar mask (set to 0 on painted face texels)
 * @param {number} bx block origin x (may exceed SIZE; wraps)
 * @param {number} by block origin y
 * @param {number} bw block cell width including the mortar groove
 * @param {number} bh block cell height including the mortar groove
 * @param {number} seed
 * @param {import('../core/rng.js').Rng} rng layout randomness
 * @returns {void}
 */
function paintBlock(buf, mask, bx, by, bw, bh, seed, rng) {
  const fw = bw - MORTAR;
  const fh = bh - MORTAR;
  if (fw < 5 || fh < 5) return;

  // Per-block base tone: real masonry is not one colour, and this variation is most of what makes
  // the wall read as blocks rather than as noise. The spread is wide (±0.2 of the ramp) because a
  // narrower one measured only ~60 % of the reference's p95−p5 luminance range over a matched wall
  // region — the difference between chiselled stone and a flat fill.
  const baseT = 0.5 + rng.range(-0.24, 0.26);
  // Per-block bevel strength. Every course shares its joint heights (`COURSES`), so a uniform lit
  // top edge would fuse along a corridor into one bright rail per course; blocks that catch the
  // light at different strengths break that rail into chiselled edges, as worn stone does.
  const bevel = rng.range(0.5, 1.2);

  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const gx = bx + x;
      const gy = by + y;
      let t = baseT + (fbmChunky(gx, gy, seed) - 0.5) * 0.3;
      // Bevel: light catches the top and left edges, the bottom and right fall into shadow. Two
      // steps, so the block still reads as chiselled at the 1–3 px sizes the raycaster shows.
      if (y === 0 || x === 0) t += 0.28 * bevel;
      else if (y === 1 || x === 1) t += 0.13 * bevel;
      if (y >= fh - 2 || x >= fw - 2) t -= 0.19;
      if (y === fh - 1 || x === fw - 1) t -= 0.12;
      put(buf, gx, gy, rampPickFlat(RAMPS.stone, t));
      mask[((gy & MASK) << 6) | (gx & MASK)] = 0;
    }
  }

  // Weathering: chunky 4–7 × 3–5 patches of off-tone stone. They are deliberately larger than the
  // 2×2 speckle they replace — at corridor distance a 2×2 patch dissolves into the Bayer dither and
  // reads as mush, where a 4–7 texel patch survives both the colormap crush and the 3× upscale and
  // still reads as a weathered face, exactly as in the reference.
  const clusters = 3 + rng.int(3);
  for (let i = 0; i < clusters; i++) {
    const cx = 1 + rng.int(fw - 3);
    const cy = 1 + rng.int(fh - 3);
    const cw = 4 + rng.int(3);
    const ch = 3 + rng.int(2);
    // One whole ramp step either way (the stone ramp has nine): a flat patch of the neighbouring
    // grey, not a dithered blend that would read as a checkerboard once magnified.
    const dt = rng.chance(0.5) ? 0.125 : -0.125;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const gx = bx + cx + x;
        const gy = by + cy + y;
        if (cx + x >= fw - 1 || cy + y >= fh - 1) continue;
        put(buf, gx, gy, rampPickFlat(RAMPS.stone, baseT + dt));
      }
    }
  }

  // Grain: 8–14 undithered 1×1 and 2×1 flecks per block, one ramp step off the texel under them —
  // mostly pits, a few bright crystals. Within a tile and a half of the eye a block face covers
  // hundreds of screen pixels, and the flat patches above alone read there as smeared concrete; the
  // reference's stone is granular at exactly that range. Kept off the two bevel rows and columns so
  // the chiselled edge stays clean, and never dithered, so each fleck stays one crisp texel.
  const stone = RAMPS.stone;
  const flecks = 8 + rng.int(7);
  for (let i = 0; i < flecks; i++) {
    const fx = 2 + rng.int(fw - 5);
    const fy = 2 + rng.int(fh - 4);
    const bright = rng.chance(0.22);
    const len = rng.chance(0.35) ? 2 : 1;
    for (let k = 0; k < len; k++) {
      const at = (((by + fy) & MASK) << 6) | ((bx + fx + k) & MASK);
      const step = stone.indexOf(buf[at]);
      const next = bright ? step + 1 : step - 1;
      // Never into the mortar tones (steps 0–1): a pit must not read as a hole in the joint grid.
      if (step < 0 || next < 2 || next >= stone.length) continue;
      buf[at] = stone[next];
    }
  }
}

/**
 * Trace a hairline crack across a block face: a biased random walk, one texel wide with the
 * occasional widening, painted two ramp steps below the surrounding stone.
 * @param {Uint8Array} buf
 * @param {number} bx block origin x
 * @param {number} by block origin y
 * @param {number} fw face width
 * @param {number} fh face height
 * @param {import('../core/rng.js').Rng} rng
 * @returns {void}
 */
function paintCrack(buf, bx, by, fw, fh, rng) {
  let cx = 1 + rng.int(fw - 2);
  let cy = rng.chance(0.5) ? 0 : fh - 1;
  const dy = cy === 0 ? 1 : -1;
  const drift = rng.chance(0.5) ? 1 : -1;
  const len = Math.min(fh, 6 + rng.int(fh));
  for (let i = 0; i < len; i++) {
    if (cx < 0 || cx >= fw) break;
    put(buf, bx + cx, by + cy, rng.chance(0.75) ? C.stoneDeep : C.stoneMortar);
    if (rng.chance(0.28)) put(buf, bx + cx + drift, by + cy, C.stoneDark);
    cy += dy;
    if (cy < 0 || cy >= fh) break;
    if (rng.chance(0.42)) cx += drift;
    else if (rng.chance(0.12)) cx -= drift;
  }
}

/**
 * Paint a wall variant.
 * @param {number} seed
 * @param {{moss:number, vines:number, cracks:number}} opts
 *   `moss` 0..1 coverage, `vines` strand count, `cracks` 0..1 chance per block
 * @returns {Uint8Array} index buffer
 */
function paintWall(seed, opts) {
  const courses = COURSES;
  const buf = new Uint8Array(AREA);
  const mask = scratchMask;
  const rng = createRng(seed);

  // 1. Mortar bed. Everything starts as a dark navy groove; blocks are laid on top.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const n = fbmChunky(x, y, seed ^ 0x51a7);
      buf[(y << 6) | x] = rampPickChunky(RAMPS.stone, 0.015 + n * 0.14, x, y);
      mask[(y << 6) | x] = 1;
    }
  }

  // 2. Courses of blocks in a running bond (each course starts at its own offset, so no seam runs
  //    top to bottom). Widths are drawn to sum to exactly 64 so the row wraps seamlessly, and they
  //    are wide — two landscape blocks across a tile face, as the reference's masonry is — rather
  //    than three squares that foreshorten into portrait slivers on a grazing corridor wall.
  const rows = courses.length - 1;
  for (let r = 0; r < rows; r++) {
    const y0 = courses[r];
    const bh = courses[r + 1] - y0;
    let x = rng.int(SIZE);
    let remaining = SIZE;
    while (remaining > 0) {
      let bw = remaining <= 50 ? remaining : BLOCK_W_MIN + rng.int(BLOCK_W_SPREAD);
      // Never leave a sliver: if the remainder would be unusably thin, take it now.
      if (remaining - bw > 0 && remaining - bw < BLOCK_W_MIN) bw = remaining - BLOCK_W_MIN;
      paintBlock(buf, mask, x, y0, bw, bh, seed, rng);
      if (opts.cracks > 0 && rng.chance(opts.cracks)) {
        paintCrack(buf, x, y0, bw - MORTAR, bh - MORTAR, rng);
      }
      x += bw;
      remaining -= bw;
    }
  }

  // 3. Moss. It grows out of the mortar grooves and drapes from the top of the tile, so the mask
  //    biases toward groove texels and toward the upper third.
  if (opts.moss > 0) {
    for (let y = 0; y < SIZE; y++) {
      const topBias = 1 - y / SIZE; // 1 at the top, 0 at the bottom
      for (let x = 0; x < SIZE; x++) {
        const i = (y << 6) | x;
        // Moss favours the grooves themselves, then the texels touching one, and only sparsely
        // colonises the open face of a block.
        const groove =
          mask[i] === 1
            ? 1.32
            : mask[(((y - 1) & MASK) << 6) | x] === 1 || mask[(((y + 1) & MASK) << 6) | x] === 1
              ? 1.08
              : 0.74;
        const n = fbmChunky(x + 37, y + 11, seed ^ 0x9e37) * groove * (0.55 + 0.75 * topBias);
        if (n > 1 - opts.moss * 0.55) {
          // Lighter tips where the noise is strongest: moss catches light on its outer growth.
          const t = (n - (1 - opts.moss * 0.55)) * 3.4;
          buf[i] = rampPickChunky(RAMPS.moss, 0.15 + t, x, y);
        }
      }
    }
  }

  // 4. Vines: strands hanging from the top edge, wobbling as they fall, with paired leaves.
  for (let v = 0; v < opts.vines; v++) {
    const startX = rng.int(SIZE);
    const len = 26 + rng.int(34);
    let fx = startX;
    for (let y = 0; y < len; y++) {
      fx += (h01(startX, y, seed ^ 0x4c11) - 0.5) * 1.15;
      const ix = Math.round(fx);
      put(buf, ix, y, C.mossDeep);
      if ((y & 3) !== 3) put(buf, ix + 1, y, y & 1 ? C.mossMid : C.mossShadow);
      if (y % 6 === 2 && y < len - 3) {
        // A leaf pair: two 2×2 blobs either side of the stem.
        const side = rng.chance(0.5) ? 1 : -1;
        put(buf, ix + side * 2, y, C.mossMid);
        put(buf, ix + side * 3, y, C.mossLight);
        put(buf, ix + side * 2, y + 1, C.mossLight);
        put(buf, ix + side * 3, y + 1, C.mossMid);
        put(buf, ix - side * 2, y + 1, C.mossDeep);
        put(buf, ix - side * 2, y + 2, C.mossMid);
      }
    }
    // A brighter growing tip so the strand does not just stop.
    put(buf, Math.round(fx), len, C.mossTip);
    put(buf, Math.round(fx), len + 1, C.mossLight);
  }

  return buf;
}

// ─── Floor ─────────────────────────────────────────────────────────────────────────────────────

/** Voronoi feature grid: 4×4 cells of 16 texels ⇒ ~16 cobbles per tile. */
const COB_CELLS = 4;
const COB_SPAN = SIZE / COB_CELLS;

/**
 * Paint a cobblestone floor: a toroidal jittered-Voronoi diagram where each region is one rounded
 * stone shaded from its centre outward, separated by near-black gaps with moss in them.
 * @param {number} seed
 * @param {{moss:number, wet:number}} opts moss coverage 0..1, wet-stone highlight chance 0..1
 * @returns {Uint8Array}
 */
function paintFloor(seed, opts) {
  const buf = new Uint8Array(AREA);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Find the nearest and second-nearest feature points across the wrapping 3×3 neighbourhood.
      let d1 = 1e9;
      let d2 = 1e9;
      let id1 = 0;
      let f1x = 0;
      let f1y = 0;
      const cx0 = Math.floor(x / COB_SPAN);
      const cy0 = Math.floor(y / COB_SPAN);
      for (let gy = cy0 - 1; gy <= cy0 + 1; gy++) {
        for (let gx = cx0 - 1; gx <= cx0 + 1; gx++) {
          const wx = gx & (COB_CELLS - 1);
          const wy = gy & (COB_CELLS - 1);
          // Jitter comes from the *wrapped* cell so opposite edges agree; the feature position
          // uses the unwrapped cell so distances stay continuous across the seam.
          const jx = (gx + 0.18 + 0.64 * h01(wx, wy, seed)) * COB_SPAN;
          const jy = (gy + 0.18 + 0.64 * h01(wx, wy, seed ^ 0x1234)) * COB_SPAN;
          const dx = x - jx;
          const dy = y - jy;
          const d = dx * dx + dy * dy;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            id1 = (wy << 2) | wx;
            f1x = dx;
            f1y = dy;
          } else if (d < d2) {
            d2 = d;
          }
        }
      }

      const edge = Math.sqrt(d2) - Math.sqrt(d1); // 0 on a cell border, grows inward
      const noise = fbmChunky(x, y, seed ^ 0x77a1);
      const gapWidth = 2.1 + noise * 1.7; // irregular, so gaps are not machine-cut

      if (edge < gapWidth) {
        // Gap between stones: nearly black, with moss tufts sprouting in the wider parts.
        const deep = 1 - edge / gapWidth; // 1 at the very centre of the gap
        const mossN = fbmChunky(x + 19, y + 5, seed ^ 0x2f5a);
        if (mossN * (0.5 + deep) > 1 - opts.moss * 0.72) {
          buf[(y << 6) | x] = rampPickChunky(RAMPS.moss, 0.1 + (mossN - 0.5) * 1.6, x, y);
        } else {
          buf[(y << 6) | x] = rampPickChunky(RAMPS.cobble, 0.06 * (1 - deep) + noise * 0.09, x, y);
        }
        continue;
      }

      // Stone face: brighter toward the middle of the cobble (rounded), plus per-stone tone.
      const r = Math.sqrt(f1x * f1x + f1y * f1y) / (COB_SPAN * 0.78);
      const stoneTone = 0.34 + h01(id1 & 3, id1 >> 2, seed ^ 0xabc) * 0.3;
      let t = stoneTone + (1 - r * r) * 0.22 + (noise - 0.5) * 0.17;
      // Light comes from above-left in texture space, matching the wall bevel.
      t += (-f1x - f1y) * 0.012;
      if (edge < gapWidth + 1.6) t -= 0.14; // dark contact shadow at the stone's rim
      if (opts.wet > 0 && noise > 1 - opts.wet * 0.18 && r < 0.55) t += 0.3; // wet sheen
      buf[(y << 6) | x] = rampPickChunky(RAMPS.cobble, t, x, y);
    }
  }

  return buf;
}

/**
 * Paint an iron floor grate: a lattice of bars over a black void, rusted and mossy at the edges.
 * Used on ~1 tile in 16 (see the raycaster's variant hash) exactly as in the reference art.
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintGrate(seed) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Void below: almost black, with a faint cool glimmer so it is not a flat hole.
      const n = fbmChunky(x, y, seed ^ 0x0d0d);
      buf[(y << 6) | x] = n > 0.72 ? C.stoneShadow : C.void;
    }
  }

  // Bars every 16 texels, 6 wide, with a lit top-left edge and a dark bottom-right edge so the
  // lattice reads as round iron rather than as a flat grid.
  const BAR = 6;
  /** @type {number[]} across-bar shading, light → dark (the bar's cylindrical roll-off) */
  const barShade = [C.ironLight, C.ironHilite, C.ironBase, C.ironBase, C.ironDark, C.ironShadow];
  for (let b = 0; b < SIZE; b += 16) {
    for (let k = 0; k < SIZE; k++) {
      for (let t = 0; t < BAR; t++) {
        // Horizontal bars sit on top of vertical ones at the crossings (drawn second).
        put(buf, b + t, k, barShade[t]);
      }
    }
  }
  for (let b = 0; b < SIZE; b += 16) {
    for (let k = 0; k < SIZE; k++) {
      for (let t = 0; t < BAR; t++) {
        const cross = (k & 15) < BAR;
        // At a crossing the horizontal bar is lifted one step so the joint is legible.
        put(buf, k, b + t, cross && t > 0 && t < BAR - 1 ? C.ironLight : barShade[t]);
      }
    }
  }

  // Rust, wear and moss at the joints — otherwise the lattice looks like a CAD drawing.
  for (let i = 0; i < 90; i++) {
    const x = rng.int(SIZE);
    const y = rng.int(SIZE);
    const onBar = (x & 15) < 4 || (y & 15) < 4;
    if (!onBar) continue;
    const roll = rng.next();
    put(buf, x, y, roll < 0.45 ? C.ironHilite : roll < 0.78 ? C.oilDark : C.mossDeep);
  }
  return buf;
}

// ─── Ceiling ───────────────────────────────────────────────────────────────────────────────────

/**
 * Paint dark timber planks running along +x, with grain, nails and knots; optionally a heavier
 * cross beam. Seamless on both axes (4 planks of 16 texels).
 * @param {number} seed
 * @param {boolean} beam add a structural cross beam
 * @returns {Uint8Array}
 */
function paintCeiling(seed, beam) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);

  for (let p = 0; p < 4; p++) {
    const y0 = p * 16;
    const plankTone = 0.34 + h01(p, 0, seed) * 0.26;
    for (let y = y0; y < y0 + 16; y++) {
      const edge = y - y0;
      for (let x = 0; x < SIZE; x++) {
        // Grain: noise stretched 6× along the plank so it streaks lengthwise.
        const grain =
          vnoise(x & ~1, (y & ~1) * 6, 16, seed ^ (p * 977)) * 0.62 +
          vnoise(x & ~1, (y & ~1) * 6, 8, seed ^ 0x33) * 0.38;
        let t = plankTone + (grain - 0.5) * 0.3;
        if (edge === 0) t -= 0.4; // shadowed joint between planks
        else if (edge === 1) t -= 0.16;
        else if (edge === 15) t += 0.14; // lit lower lip of the plank above
        buf[(y << 6) | x] = rampPickChunky(RAMPS.wood, t, x, y);
      }
    }
    // Knots: a dark ellipse with one lighter ring, twice per plank at most.
    const knots = rng.int(3);
    for (let k = 0; k < knots; k++) {
      const kx = rng.int(SIZE);
      const ky = y0 + 5 + rng.int(7);
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = (dx * dx) / 16 + (dy * dy) / 9;
          if (d > 1) continue;
          put(buf, kx + dx, ky + dy, d > 0.55 ? C.woodDark : d > 0.2 ? C.woodShadow : C.woodDark);
        }
      }
    }
    // Nail heads near the plank ends.
    for (let n = 0; n < 2; n++) {
      const nx = n * 32 + 6 + rng.int(6);
      put(buf, nx, y0 + 4, C.ironLight);
      put(buf, nx + 1, y0 + 4, C.ironBase);
      put(buf, nx, y0 + 5, C.ironBase);
      put(buf, nx + 1, y0 + 5, C.ironShadow);
    }
  }

  if (beam) {
    // A 14-texel beam across the planks: dark face, lit top edge, deep shadow underneath, bolts.
    const by = 24;
    for (let y = by; y < by + 14; y++) {
      const edge = y - by;
      for (let x = 0; x < SIZE; x++) {
        const grain = vnoise(x & ~1, (y & ~1) * 5, 16, seed ^ 0x8e1) - 0.5;
        let t = 0.2 + grain * 0.22;
        if (edge === 0) t += 0.34;
        else if (edge === 1) t += 0.16;
        else if (edge >= 12) t -= 0.18;
        buf[(y << 6) | x] = rampPickChunky(RAMPS.wood, t, x, y);
      }
    }
    // Cast shadow on the plank just below the beam.
    for (let x = 0; x < SIZE; x++) {
      put(buf, x, by + 14, C.woodShadow);
      put(buf, x, by + 15, C.woodDark);
      put(buf, x, by - 1, C.woodDark);
    }
    for (let bolt = 0; bolt < 4; bolt++) {
      const bx = 8 + bolt * 16;
      fillRect(buf, bx, by + 4, 3, 3, C.ironBase);
      put(buf, bx, by + 4, C.ironHilite);
      put(buf, bx + 2, by + 6, C.ironShadow);
    }
  }

  return buf;
}

// ─── Sprites ───────────────────────────────────────────────────────────────────────────────────

/**
 * Paint an iron wall sconce with a burning flame. The sconce is identical in every frame; only
 * the flame animates, so the four frames cycle without the bracket appearing to twitch.
 * @param {number} seed
 * @param {number} frame 0..3
 * @param {Uint8Array} stipple out-param: halo texels are marked 1
 * @returns {Uint8Array}
 */
function paintTorch(seed, frame, stipple) {
  const buf = new Uint8Array(AREA);
  const cx = 32;

  // ── Iron sconce ──
  // Wall plate with rivets.
  for (let y = 40; y < 54; y++) {
    for (let x = 26; x < 38; x++) {
      const t = x < 28 ? 0.72 : x > 35 ? 0.16 : y < 42 ? 0.6 : 0.42;
      putClip(buf, x, y, rampPickChunky(RAMPS.iron, t, x, y));
    }
  }
  putClip(buf, 28, 43, C.ironHilite);
  putClip(buf, 35, 43, C.ironShadow);
  putClip(buf, 28, 51, C.ironHilite);
  putClip(buf, 35, 51, C.ironShadow);
  // Shaft rising from the plate to the cup.
  for (let y = 30; y < 44; y++) {
    putClip(buf, cx - 2, y, C.ironLight);
    putClip(buf, cx - 1, y, C.ironBase);
    putClip(buf, cx, y, C.ironBase);
    putClip(buf, cx + 1, y, C.ironDark);
  }
  // Cup: a flared bowl holding the pitch.
  for (let y = 25; y < 32; y++) {
    const halfW = 8 - (y - 25);
    for (let x = cx - halfW; x <= cx + halfW; x++) {
      const t = x < cx - halfW + 2 ? 0.8 : x > cx + halfW - 2 ? 0.1 : 0.45;
      putClip(buf, x, y, rampPickChunky(RAMPS.iron, t, x, y));
    }
  }
  // Glowing coals inside the cup.
  for (let x = cx - 5; x <= cx + 5; x++) {
    putClip(buf, x, 25, ((x + frame) & 3) === 0 ? C.fireHot : C.fireEmber);
    putClip(buf, x, 26, ((x + frame) & 1) === 0 ? C.fireEmber : C.fireDeep);
  }

  // ── Flame ──
  // A teardrop that narrows to a tip, wobbling per frame. `t` runs 0 at the tip → 1 at the base.
  const tip = 3 + (frame & 1);
  const base = 26;
  for (let y = tip; y <= base; y++) {
    const t = (y - tip) / (base - tip);
    const wob = (h01(y, frame * 7 + 1, seed) - 0.5) * 2;
    const flameX = cx + wob * 2.6 * (1 - t) * (1 - t);
    // Widest around 70 % of the way down, then tucks back into the cup.
    const halfW = Math.sin(Math.pow(t, 0.72) * Math.PI * 0.86) * 8.4 + 0.6 + wob * 0.5;
    const from = Math.round(flameX - halfW);
    const to = Math.round(flameX + halfW);
    for (let x = from; x <= to; x++) {
      const r = halfW > 0.01 ? Math.abs(x - flameX) / halfW : 1;
      // Hot core, cooler edge, cooler tip: the classic 4-band flame read.
      const heat = (1 - r * r * 0.92) * (0.52 + 0.58 * t) + (1 - t) * 0.12;
      putClip(buf, x, y, rampPick(RAMPS.fire, heat, x, y + frame));
    }
  }

  // ── Halo ── stippled warm glow so the light source reads even at distance.
  for (let y = 0; y < 40; y++) {
    for (let x = 12; x < 52; x++) {
      const i = (y << 6) | x;
      if (buf[i] !== 0) continue;
      const dx = (x - cx) / 15;
      const dy = (y - 16) / 17;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      const n = h01(x >> 1, (y >> 1) + frame * 13, seed ^ 0xf1a3);
      if (n < d * 0.9) continue;
      buf[i] = d > 0.55 ? C.fireDeep : d > 0.24 ? C.fireEmber : C.fireMid;
      stipple[i] = 1;
    }
  }

  return buf;
}

/**
 * Paint one frame of the exit portal: a three-armed violet/cyan vortex with a white-hot core and
 * a stippled glow ring. The pattern has 3-fold symmetry and each frame advances it by 1/8 of a
 * third of a turn, so frame 8 lands exactly on frame 0 — the loop is seamless.
 * @param {number} seed
 * @param {number} frame 0..7
 * @param {Uint8Array} stipple out-param
 * @returns {Uint8Array}
 */
function paintPortal(seed, frame, stipple) {
  const buf = new Uint8Array(AREA);
  const cx = 31.5;
  const cy = 31.5;
  const R = 26;
  const phase = (frame / 8) * ((Math.PI * 2) / 3);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      const i = (y << 6) | x;
      if (r > R + 5) continue;

      if (r > R) {
        // Outer glow: stippled so it dissolves into the wall instead of ending on a hard edge.
        if (h01(x >> 1, (y >> 1) + frame, seed) > (r - R) / 5) {
          buf[i] = C.arcViolet;
          stipple[i] = 1;
        }
        continue;
      }

      const ang = Math.atan2(dy, dx);
      // Spiral: the radial term bends the arms; the 3× angular term gives the three-fold vortex.
      const swirl = Math.sin(3 * (ang - phase) + r * 0.46);
      const rn = r / R;
      let v = 0.5 + 0.5 * swirl;
      v *= 1 - rn * 0.55; // arms fade toward the rim
      v += (1 - rn) * (1 - rn) * 0.85; // core blooms
      v += (h01(x, y, seed ^ frame) - 0.5) * 0.08; // a little sparkle in the plasma
      buf[i] = rampPick(RAMPS.arcane, v, x, y);
      if (r < 4.5) buf[i] = v > 0.85 ? C.white : C.arcPale;
      // Rim: a crisp cyan edge, the way the reference's magic reads against stone.
      if (r > R - 2) buf[i] = ((x + y + frame) & 1) === 0 ? C.arcCyan : C.arcMid;
    }
  }
  return buf;
}

/**
 * Paint one spin frame of a gem: a faceted crystal whose apparent width follows |cos θ| so eight
 * frames read as a full rotation, with the specular highlight tracking the facet that faces the
 * light.
 * @param {number} seed
 * @param {number} frame 0..7
 * @returns {Uint8Array}
 */
function paintGem(seed, frame) {
  const buf = new Uint8Array(AREA);
  const theta = (frame / 8) * Math.PI * 2;
  const cosT = Math.cos(theta);
  const cx = 32;
  const topY = 16;
  const midY = 30;
  const botY = 47;
  const halfW = 4 + Math.abs(cosT) * 8; // 4..12 texels — never edge-on, so it stays readable
  const crease = cx + cosT * halfW * 0.45; // the vertical facet edge sweeps across the face

  for (let y = topY; y <= botY; y++) {
    // Width profile: a pointed crown above the girdle, a tapered pavilion below.
    const w =
      y < midY
        ? (halfW * (y - topY)) / (midY - topY)
        : (halfW * (botY - y)) / (botY - midY + 0.001);
    const from = Math.round(cx - w);
    const to = Math.round(cx + w);
    for (let x = from; x <= to; x++) {
      const left = x < crease;
      // Two big facets lit differently, plus a darker pavilion so the stone has depth.
      let t = left ? 0.62 : 0.34;
      if (y > midY) t -= 0.16;
      if (y < topY + 4) t += 0.12;
      t += (h01(x, y, seed ^ frame) - 0.5) * 0.12;
      const idx = rampPick(RAMPS.gem, t, x, y);
      putClip(buf, x, y, idx);
      // Emerald heart: the core reads green, the shell cyan (the "cyan/emerald" brief).
      if (Math.abs(x - cx) < w * 0.32 && y > midY - 5 && y < midY + 6) {
        putClip(buf, x, y, ((x + y) & 1) === 0 ? C.emeraldMid : C.emeraldDeep);
      }
    }
    // Outline: one dark texel each side keeps the silhouette crisp at 2 px on screen.
    putClip(buf, from - 1, y, C.gemDeep);
    putClip(buf, to + 1, y, C.gemDeep);
  }

  // Specular: a hard 2×2 white pixel cluster on the lit facet, the signature pixel-art gem read.
  const sx = Math.round(cx - halfW * 0.42);
  const sy = midY - 7;
  putClip(buf, sx, sy, C.gemSpec);
  putClip(buf, sx + 1, sy, C.gemPale);
  putClip(buf, sx, sy + 1, C.gemPale);
  putClip(buf, sx + 1, sy + 1, C.gemBright);
  // Girdle flash on the opposite side.
  putClip(buf, Math.round(cx + halfW * 0.6), midY + 2, C.gemPale);

  return buf;
}

/**
 * Paint one frame of the amber oil flask. Frames differ only in the bubble position and the
 * highlight, which makes the bottle look alive without any motion of the silhouette.
 * @param {number} seed
 * @param {number} frame 0..3
 * @returns {Uint8Array}
 */
function paintOil(seed, frame) {
  const buf = new Uint8Array(AREA);
  const cx = 32;

  // Body: a rounded flask, wider at the bottom.
  for (let y = 26; y <= 50; y++) {
    const t = (y - 26) / 24;
    const w = Math.round(5 + Math.sin(t * Math.PI * 0.85) * 5 + t * 3);
    for (let x = cx - w; x <= cx + w; x++) {
      const r = (x - cx) / w;
      // Glass: dark rim, bright body, a vertical specular band on the left.
      let tone = 0.55 - Math.abs(r) * 0.42 + (0.5 - t) * 0.1;
      if (r < -0.62) tone += 0.18;
      if (r > 0.55) tone -= 0.14;
      putClip(buf, x, y, rampPickChunky(RAMPS.oil, tone, x, y));
    }
    putClip(buf, cx - w - 1, y, C.oilDeep);
    putClip(buf, cx + w + 1, y, C.oilDeep);
  }
  // Fill line: oil does not reach the shoulder.
  for (let x = cx - 7; x <= cx + 7; x++) putClip(buf, x, 31, C.oilLight);

  // Neck: a tall narrow throat so the silhouette reads as a bottle, not a pot.
  for (let y = 15; y < 27; y++) {
    const w = y > 24 ? 5 : y > 22 ? 4 : 3;
    for (let x = cx - w; x <= cx + w; x++) {
      const tone = x < cx - w + 2 ? 0.66 : x > cx + w - 2 ? 0.16 : 0.4;
      putClip(buf, x, y, rampPickChunky(RAMPS.oil, tone, x, y));
    }
    putClip(buf, cx - w - 1, y, C.oilDeep);
    putClip(buf, cx + w + 1, y, C.oilDeep);
  }
  // A collar ring where the neck meets the shoulder.
  for (let x = cx - 5; x <= cx + 5; x++) putClip(buf, x, 16, C.oilLight);
  // Cork: proud of the neck, lighter than the glass so it separates.
  for (let y = 9; y < 16; y++) {
    for (let x = cx - 4; x <= cx + 4; x++) {
      const tone = x < cx - 2 ? 0.72 : x > cx + 2 ? 0.24 : 0.5;
      putClip(buf, x, y, rampPickChunky(RAMPS.wood, tone, x, y));
    }
    putClip(buf, cx - 5, y, C.woodShadow);
    putClip(buf, cx + 5, y, C.woodShadow);
  }
  for (let x = cx - 4; x <= cx + 4; x++) putClip(buf, x, 9, C.woodHilite);

  // Rising bubble + moving specular.
  const by = 46 - frame * 3;
  putClip(buf, cx + 2, by, C.oilPale);
  putClip(buf, cx + 3, by, C.oilLight);
  putClip(buf, cx + 2, by + 1, C.oilLight);
  for (let y = 34 + (frame & 1); y < 44; y += 2) {
    putClip(buf, cx - 5, y, C.oilPale);
    putClip(buf, cx - 4, y, C.oilLight);
  }
  return buf;
}

/**
 * Texel row the map scroll's art rests on (the bottom of its ribbon tails). The raycaster anchors
 * this row to the floor, so it is exported rather than re-derived there.
 */
export const MAP_FLOOR_ROW = 55;

/**
 * Paint the hidden map scroll (§4.8): a roll of aged parchment lying on its side, tied round the
 * middle with a dark red ribbon, a wax seal on the knot and two ribbon tails splayed on the floor.
 *
 * Read order at 240p, which is what the shapes are sized for: the long pale cylinder with a dark
 * outline says "roll"; the spiral on the left end cap says "rolled sheet" rather than "log" or
 * "bone"; the red band and seal say "scroll". There is no halo and no stipple — the scroll is meant
 * to be found, not to announce itself — and the parchment ramp sits below `gold*` in brightness.
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintMap(seed) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  const map = RAMPS.map;
  const seal = RAMPS.seal;

  const x0 = 9; // left end cap centre column
  const x1 = 53; // right end cap centre column
  const yc = 44; // roll axis row
  const r = 8; // roll radius: rows yc-r .. yc+r
  const capW = 3; // half-width of the end-cap ellipse (the roll is seen slightly from the left)

  // ── Body: a cylinder lit from above-left. Flat bands, not a dither — at 2–6 px per texel a
  // dithered gradient reads as noise, where three hard bands read as a round thing.
  for (let y = yc - r; y <= yc + r; y++) {
    const v = (y - yc) / r; // -1 top … +1 bottom
    let t = 0.78 - 0.62 * ((v + 1) / 2);
    if (v < -0.55 && v > -0.95) t += 0.2; // specular strip along the top of the roll
    for (let x = x0; x <= x1; x++) {
      // Fibres: sparse single-texel flecks one step darker, plus a couple of faint age stains.
      const n = h01(x, y, seed);
      const tt = t - (n > 0.9 ? 0.25 : 0) - (vnoise(x, y, 8, seed ^ 0x3a7) > 0.72 ? 0.18 : 0);
      putClip(buf, x, y, rampPickFlat(map, tt));
    }
  }

  // ── Outer sheet edge: where the last turn of parchment ends, a dark seam with a lit lip under it,
  // running the length of the roll. It is the single cue that separates a scroll from a rod.
  const seamY = yc + 3;
  for (let x = x0 + 2; x <= x1 - 2; x++) {
    // The lip wanders by a texel so it reads as paper, not as a machined groove.
    const dy = h01(x >> 3, 7, seed ^ 0x51) > 0.6 ? 1 : 0;
    putClip(buf, x, seamY + dy, C.mapShadow);
    putClip(buf, x, seamY + dy + 1, C.mapLight);
  }

  // ── Right end: a rounded, shaded cap so the roll has volume.
  for (let y = yc - r; y <= yc + r; y++) {
    const v = (y - yc) / r;
    const half = Math.round(capW * Math.sqrt(Math.max(0, 1 - v * v)));
    for (let x = x1 + 1; x <= x1 + half; x++) putClip(buf, x, y, v < -0.3 ? C.mapMid : C.mapDark);
    putClip(buf, x1 + half + 1, y, C.mapShadow);
  }

  // ── Left end: the cut face of the roll, showing the spiral of rolled sheets.
  for (let y = yc - r; y <= yc + r; y++) {
    const v = (y - yc) / r;
    const half = Math.round(capW * Math.sqrt(Math.max(0, 1 - v * v)));
    for (let x = x0 - half; x <= x0 + half; x++) {
      const ex = (x - x0) / (capW + 0.5);
      const ey = (y - yc) / (r + 0.5);
      const d = Math.sqrt(ex * ex + ey * ey); // 0 centre … 1 rim of the ellipse
      // Alternating paper and gap rings; a slow angular drift turns concentric rings into a spiral.
      const ring = ((d * 4.2 + Math.atan2(ey, ex) / (Math.PI * 2)) | 0) & 1;
      putClip(buf, x, y, d < 0.2 ? C.mapShadow : ring ? C.mapDark : C.mapPale);
    }
    putClip(buf, x0 - half - 1, y, C.mapShadow);
  }

  // ── Silhouette outline along the top and bottom of the roll.
  for (let x = x0; x <= x1; x++) {
    putClip(buf, x, yc - r - 1, C.mapShadow);
    putClip(buf, x, yc + r + 1, C.mapShadow);
  }

  // ── Ribbon band round the middle, shaded with the same cylinder light as the paper.
  const rx = 30 + rng.int(3);
  for (let y = yc - r; y <= yc + r; y++) {
    const v = (y - yc) / r;
    const t = v < -0.4 ? 0.95 : v < 0.35 ? 0.6 : 0.3;
    putClip(buf, rx - 1, y, rampPickFlat(seal, t - 0.3));
    putClip(buf, rx, y, rampPickFlat(seal, t));
    putClip(buf, rx + 1, y, rampPickFlat(seal, t - 0.3));
  }
  // Band edges bite into the outline so the ribbon visibly wraps *round* the roll.
  for (let x = rx - 1; x <= rx + 1; x++) {
    putClip(buf, x, yc - r - 1, C.sealShadow);
    putClip(buf, x, yc + r + 1, C.sealShadow);
  }

  // ── Ribbon tails: from the knot down the front of the roll, splaying out onto the floor, with a
  // swallowtail notch at each end.
  const ky = yc + 1;
  for (const side of [-1, 1]) {
    let x = rx + side;
    for (let y = ky; y <= MAP_FLOOR_ROW; y++) {
      if (y > yc + r - 1) x += side; // below the roll the tail lies flat and fans outward
      putClip(buf, x, y, C.sealMid);
      putClip(buf, x + side, y, C.sealDark);
    }
    // Notched end: a texel of floor showing between the two points.
    putClip(buf, x + side * 2, MAP_FLOOR_ROW, C.sealDark);
    putClip(buf, x + side, MAP_FLOOR_ROW, 0);
    putClip(buf, x + side * 2, MAP_FLOOR_ROW - 1, C.sealMid);
  }

  // ── Knot loops either side of the seal.
  for (const side of [-1, 1]) {
    for (let dy = -3; dy <= 1; dy++) {
      for (let dx = 2; dx <= 6; dx++) {
        const edge = dx === 6 || dy === -3 || dy === 1;
        putClip(buf, rx + side * dx, ky - 1 + dy, edge ? C.sealDark : dy < 0 ? C.sealLight : C.sealMid);
      }
    }
    putClip(buf, rx + side * 4, ky - 1, C.sealShadow); // the hole through the loop
    putClip(buf, rx + side * 5, ky - 1, C.sealShadow);
  }

  // ── Wax seal: a lumpy disc on the knot, one lit bead top-left, dark rim.
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const d = dx * dx + dy * dy;
      if (d > 10) continue;
      const c = d > 6 ? C.sealShadow : dx + dy < -1 ? C.sealMid : C.sealDark;
      putClip(buf, rx + dx, ky - 1 + dy, c);
    }
  }
  putClip(buf, rx - 1, ky - 2, C.sealLight);
  putClip(buf, rx, ky - 1, C.sealMid);

  return buf;
}

/**
 * Paint one frame of a four-point sparkle (gem pickup, portal motes).
 * @param {number} frame 0..3
 * @param {Uint8Array} stipple out-param
 * @returns {Uint8Array}
 */
function paintSparkle(frame, stipple) {
  const buf = new Uint8Array(AREA);
  const cx = 32;
  const cy = 32;
  const arm = 13 - frame * 3; // the star collapses as it fades
  for (let i = 0; i <= arm; i++) {
    const t = 1 - i / (arm + 1);
    const c = t > 0.66 ? C.white : t > 0.35 ? C.gemPale : C.gemBright;
    putClip(buf, cx + i, cy, c);
    putClip(buf, cx - i, cy, c);
    putClip(buf, cx, cy + i, c);
    putClip(buf, cx, cy - i, c);
    if (i < arm * 0.45) {
      // Short diagonal arms give the star its four-point shape rather than a plus sign.
      putClip(buf, cx + i, cy + i, C.gemBright);
      putClip(buf, cx - i, cy + i, C.gemBright);
      putClip(buf, cx + i, cy - i, C.gemBright);
      putClip(buf, cx - i, cy - i, C.gemBright);
    }
  }
  // Soft stippled bloom.
  for (let y = cy - arm; y <= cy + arm; y++) {
    for (let x = cx - arm; x <= cx + arm; x++) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      const i = (y << 6) | x;
      if (buf[i] !== 0) continue;
      const d = Math.hypot(x - cx, y - cy) / (arm + 1);
      if (d > 1) continue;
      buf[i] = C.gemMid;
      stipple[i] = 1;
    }
  }
  return buf;
}

// ─── Assembly ──────────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an index buffer as a `Texture`, deriving the packed pixels.
 * @param {Uint8Array} indices
 * @param {Uint8Array|null} stipple
 * @param {boolean} emissive
 * @returns {Texture}
 */
function finish(indices, stipple, emissive) {
  const pixels = new Uint32Array(AREA);
  for (let i = 0; i < AREA; i++) pixels[i] = PALETTE[indices[i]];
  return { w: SIZE, h: SIZE, indices, pixels, stipple, emissive };
}

/**
 * Paint a sprite that needs a stipple mask, allocating the mask only if the painter used it.
 * @param {(stipple:Uint8Array) => Uint8Array} paint
 * @param {boolean} emissive
 * @returns {Texture}
 */
function finishStippled(paint, emissive) {
  const stipple = new Uint8Array(AREA);
  const indices = paint(stipple);
  let used = false;
  for (let i = 0; i < AREA; i++) {
    if (stipple[i] !== 0) {
      used = true;
      break;
    }
  }
  return finish(indices, used ? stipple : null, emissive);
}

/**
 * Paint the whole texture set. Deterministic: the same seed always produces byte-identical
 * buffers, in Node and in every browser (all randomness comes from `src/core/rng.js`).
 *
 * Each texture draws from its own `rng.fork(name)` stream, so adding detail to one texture can
 * never reshuffle another — a change to the gem cannot alter the walls.
 * @param {number} [seed] any finite number; defaults to the shipping look
 * @returns {TextureSet}
 */
export function createTextures(seed = 0xa11a2e) {
  const usedSeed = Number.isFinite(seed) ? Number(seed) : 0xa11a2e;
  const root = createRng(usedSeed);
  const s = (/** @type {string} */ name) => root.fork(name).u32();

  // Every variant shares `COURSES`, so bed joints line up across tile seams whatever the mix.
  /** @type {Texture[]} */
  const wall = [
    finish(paintWall(s('wall0'), { moss: 0, vines: 0, cracks: 0.22 }), null, false),
    finish(paintWall(s('wall1'), { moss: 0.12, vines: 0, cracks: 0.7 }), null, false),
    finish(paintWall(s('wall2'), { moss: 0.42, vines: 0, cracks: 0.35 }), null, false),
    finish(paintWall(s('wall3'), { moss: 0.34, vines: 2, cracks: 0.3 }), null, false),
  ];

  /** @type {Texture[]} */
  const floor = [
    finish(paintFloor(s('floor0'), { moss: 0.22, wet: 0.45 }), null, false),
    finish(paintFloor(s('floor1'), { moss: 0.5, wet: 0.2 }), null, false),
    finish(paintGrate(s('grate')), null, false),
  ];

  /** @type {Texture[]} */
  const ceiling = [
    finish(paintCeiling(s('ceil0'), false), null, false),
    finish(paintCeiling(s('ceil1'), true), null, false),
  ];

  const torchSeed = s('torch');
  /** @type {Texture[]} */
  const torch = [];
  for (let f = 0; f < 4; f++) {
    torch.push(finishStippled((st) => paintTorch(torchSeed, f, st), true));
  }

  const portalSeed = s('portal');
  /** @type {Texture[]} */
  const portal = [];
  for (let f = 0; f < 8; f++) {
    portal.push(finishStippled((st) => paintPortal(portalSeed, f, st), true));
  }

  const gemSeed = s('gem');
  /** @type {Texture[]} */
  const gem = [];
  for (let f = 0; f < 8; f++) gem.push(finish(paintGem(gemSeed, f), null, false));

  const oilSeed = s('oil');
  /** @type {Texture[]} */
  const oil = [];
  for (let f = 0; f < 4; f++) oil.push(finish(paintOil(oilSeed, f), null, false));

  /** @type {Texture[]} */
  const sparkle = [];
  for (let f = 0; f < 4; f++) sparkle.push(finishStippled((st) => paintSparkle(f, st), true));

  // One still frame: the scroll lies on the floor and neither spins nor glows (§4.8). Still an
  // array, like every other field, so the raycaster indexes it through the same path.
  /** @type {Texture[]} */
  const map = [finish(paintMap(s('map')), null, false)];

  return { seed: usedSeed, size: SIZE, wall, floor, ceiling, torch, portal, gem, oil, sparkle, map };
}
