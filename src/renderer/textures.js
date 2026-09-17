// @ts-check
/**
 * @file Procedurally painted 64×64 pixel-art textures (ARCHITECTURE.md §4.5).
 *
 * Every surface and sprite in the game is painted here from `palette.js` indices — there are no
 * image assets, so the download is a few kilobytes of code and the art is reproducible from a
 * seed. Painting the whole set costs roughly 30–40 ms once at load (the modelled sprites are ~15 ms).
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
 * - **Sprites** — a modelled iron sconce (`models.js`, one view per angle across its wall) with a
 *   4-frame flame, a swirling violet/cyan portal, a faceted spinning gem, a modelled amber oil flask
 *   (one still view), a sparkle, and a rolled parchment map scroll tied with a red
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
import { box, createMesh, lathe, projectPoint, renderMesh, tube } from './models.js';

/** Texture edge length in texels. 64 matches the reference's chunk size at 240p internal res. */
export const SIZE = 64;

/** `x & MASK` / `y & MASK` wraps a coordinate into the texture — the source of seamlessness. */
export const MASK = SIZE - 1;

/** Texels per texture. */
export const AREA = SIZE * SIZE;

/** 1 / 2^32 — turns a uint32 hash into a float in [0,1). */
const INV_U32 = 2.3283064365386963e-10;

/**
 * 4×4 ordered (Bayer) dither thresholds, pre-divided so each value sits in [0,1) at the centre of
 * its bucket. `floor(value + threshold)` is then an unbiased quantisation: it is what lets an
 * 8-step ramp fake ~32 steps without the banding a hard `round()` would produce.
 */
export const BAYER = Float32Array.from(
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
 * @property {Texture[]} torch      `TORCH_VIEWS × TORCH_FRAMES`: the modelled sconce per view across its
 *   wall, 4 flame frames each (`torch[view * TORCH_FRAMES + frame]`), emissive
 * @property {Texture[]} portal     8 swirl frames, emissive
 * @property {Texture[]} gem        8 spin frames
 * @property {Texture[]} oil        1 frame: the modelled flask, a still 3/4 view (`OIL_YAW`) with its shadow
 * @property {Texture[]} sparkle    4 frames, emissive
 * @property {Texture[]} map        1 frame: the hidden map scroll (§4.8), solid, not emissive
 * @property {Texture[]} chalk      {@link CHALK_VARIANTS} wall decals: the word A-MAZE scrawled big and
 *   diagonally in chalk (§4.9). Index 0 = bare wall; drawn over a wall face, never as a sprite
 * @property {string} [tileset]     id of the tileset whose surfaces these are (`tilesets/index.js`)
 * @property {number} [fog]         palette index distance fades into (default `C.fog`)
 * @property {number} [warmth]      0..1 firelight tint strength (default 1, the Keep's amber)
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
export function put(buf, x, y, c) {
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
export function putClip(buf, x, y, c) {
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
export function rampPick(ramp, t, x, y) {
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
export function rampPickChunky(ramp, t, x, y) {
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
export function rampPickFlat(ramp, t) {
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
export function h01(x, y, seed) {
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
export function vnoise(x, y, cell, seed) {
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
export function fbmChunky(x, y, seed) {
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
export function fillRect(buf, x0, y0, w, h, c) {
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
 * **Three** blocks across a 64-texel tile face, so a face is 17–21 × 13 texels (1.3–1.6:1). That is
 * the reference's proportion, measured off its pillars (~1.4–1.6:1). Two blocks across (28–39 cells,
 * faces 25–36 × 13, i.e. 2.2–3:1) read as long slabs or bricks rather than as masonry.
 *
 * The range is not free: a course has to sum to exactly 64 for the painting to wrap, so widths must
 * divide 64 into three parts. 20–24 does (the first block leaves 40–44, which is at least two more
 * minimum blocks); 22–29, say, does not — three minimum blocks would already be 66. On a grazing
 * corridor wall a tile's 64 texels of width compress to 10–25 screen pixels while its 64 texels of
 * height occupy 60–240, so the *courses* are what survive foreshortening; the blocks read face-on,
 * which is where the eye judges their shape.
 */
const BLOCK_W_MIN = 20;
const BLOCK_W_SPREAD = 5;

/**
 * Texels from a tile edge inside which every variant of a surface paints the same thing.
 *
 * WHY: the raycaster ties texels to world position and picks a variant per tile, so any two
 * variants end up side by side. Whatever touches a tile edge (the block that straddles it, the
 * cobbles along it, the moss and wet sheen near it) is painted from the set's shared `edgeSeed`,
 * and per-variant decoration fades out over this distance. Variants differ only inside.
 */
const EDGE_ZONE = 10;

/**
 * 0 at a tile edge, rising to 1 at `EDGE_ZONE` texels in: how much of a variant's own decoration
 * survives at texel `x` (pass `y` too for a surface that meets its neighbours on both axes).
 * @param {number} x
 * @param {number} [y]
 * @returns {number}
 */
function edgeFade(x, y) {
  let d = Math.min(x, SIZE - 1 - x);
  if (y !== undefined) d = Math.min(d, y, SIZE - 1 - y);
  const t = d / EDGE_ZONE;
  return t >= 1 ? 1 : t * t * (3 - 2 * t);
}

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
      // Never into the mortar tones (steps 0–1): on a dark block the shadowed bottom rows would
      // otherwise merge with the joint below into one thick dark band.
      if (t < 0.19) t = 0.19;
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

  // A stain: one larger, darker blotch per block, two ramp steps down and irregular at the edges —
  // the damp patch or soot smear every worn block in the reference carries somewhere on its face.
  // Bigger than the weathering clusters and darker than them, so it breaks the face's flat middle.
  const stone = RAMPS.stone;
  {
    const sw = 4 + rng.int(5);
    const sh = 3 + rng.int(3);
    const sx = 2 + rng.int(Math.max(1, fw - sw - 3));
    const sy = 2 + rng.int(Math.max(1, fh - sh - 2));
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        // Ragged corners: a rectangle reads as a sticker, a chewed edge as a stain.
        if ((x === 0 || x === sw - 1) && (y === 0 || y === sh - 1)) continue;
        if (sx + x >= fw - 1 || sy + y >= fh - 1) continue;
        const at = (((by + sy + y) & MASK) << 6) | ((bx + sx + x) & MASK);
        const step = stone.indexOf(buf[at]);
        if (step < 4) continue; // already dark: a stain on shadow is invisible and only muddies it
        buf[at] = stone[step - 2];
      }
    }
  }

  // Grain: 22–37 undithered flecks per block, one ramp step off the texel under them — mostly pits
  // (1×1, 2×1 and the occasional 2×2), a few bright crystals. Within a tile and a half of the eye a
  // block face covers hundreds of screen pixels, and the flat patches above alone read there as
  // smeared concrete; the reference's stone is pitted granite at exactly that range, which is what
  // this density buys (8–14 flecks left the faces smooth enough for the gauntlet to call them out).
  // Kept off the two bevel rows and columns so the chiselled edge stays clean, and never dithered,
  // so each fleck stays a crisp texel.
  const flecks = 22 + rng.int(16);
  for (let i = 0; i < flecks; i++) {
    const fx = 2 + rng.int(fw - 5);
    const fy = 2 + rng.int(fh - 4);
    const bright = rng.chance(0.22);
    const wide = rng.chance(0.35);
    const tall = !bright && rng.chance(0.3); // 2×2 pits only, so a crystal stays a spark
    for (let k = 0; k < (wide ? 2 : 1); k++) {
      for (let j = 0; j < (tall ? 2 : 1); j++) {
        if (fy + j >= fh - 1) continue;
        const at = (((by + fy + j) & MASK) << 6) | ((bx + fx + k) & MASK);
        const step = stone.indexOf(buf[at]);
        const next = bright ? step + 1 : step - 1;
        // Never into the mortar tones (steps 0–1): a pit must not read as a hole in the joint grid.
        if (step < 0 || next < 2 || next >= stone.length) continue;
        buf[at] = stone[next];
      }
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
 *
 * Every variant lays the same bond (`edgeSeed` draws the block widths and each course's start) and
 * paints the blocks at the tile edges identically, so any variant meets any other at a tile seam
 * with the block running straight through. The variant's own `seed` paints the interior blocks'
 * tone, weathering and cracks, and its moss and vines, which fade out toward the edges.
 * @param {number} seed
 * @param {{moss:number, vines:number, cracks:number}} opts
 *   `moss` 0..1 coverage, `vines` strand count, `cracks` 0..1 chance per block
 * @param {number} edgeSeed shared by every wall variant of the set
 * @returns {Uint8Array} index buffer
 */
function paintWall(seed, opts, edgeSeed) {
  const courses = COURSES;
  const buf = new Uint8Array(AREA);
  const mask = scratchMask;
  const rng = createRng(seed);
  const layout = createRng(edgeSeed);

  // 1. Mortar bed. Everything starts as a dark navy groove; blocks are laid on top.
  //    Undithered (`rampPickFlat`): the bed sits between ramp steps 0 and 1, so an ordered dither
  //    there is not smoothing a gradient — it paints a 2×2-texel checkerboard into every joint,
  //    which at one tile from the eye is a 6–12 px chessboard running along the wall. Quantising the
  //    (already chunky) noise instead gives flat `stoneMortar` with scattered `stoneShadow` pits,
  //    for the same reason the block faces are undithered (see `rampPickFlat`).
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const n = fbmChunky(x, y, edgeSeed ^ 0x51a7);
      buf[(y << 6) | x] = rampPickFlat(RAMPS.stone, 0.015 + n * 0.14);
      mask[(y << 6) | x] = 1;
    }
  }

  // 2. Courses of blocks in a running bond (each course starts at its own offset, so no seam runs
  //    top to bottom). Widths are drawn to sum to exactly 64 so the row wraps seamlessly, and they
  //    are wide — two landscape blocks across a tile face, as the reference's masonry is — rather
  //    than three squares that foreshorten into portrait slivers on a grazing corridor wall.
  //    The bond comes from `layout` (shared). A block reaching within `MORTAR` texels of a tile
  //    edge is painted from a shared stream of its own, so it is the same stone in every variant.
  const rows = courses.length - 1;
  for (let r = 0; r < rows; r++) {
    const y0 = courses[r];
    const bh = courses[r + 1] - y0;
    let x = layout.int(SIZE);
    let remaining = SIZE;
    let b = 0;
    while (remaining > 0) {
      let bw =
        remaining <= BLOCK_W_MIN + BLOCK_W_SPREAD - 1 ? remaining : BLOCK_W_MIN + layout.int(BLOCK_W_SPREAD);
      // Never leave a sliver: if the remainder would be unusably thin, take it now.
      if (remaining - bw > 0 && remaining - bw < BLOCK_W_MIN) bw = remaining - BLOCK_W_MIN;
      const x0 = x & MASK;
      if (x0 <= MORTAR || x0 + bw >= SIZE - MORTAR) {
        const shared = createRng((edgeSeed ^ Math.imul(r * 8 + b + 1, 0x9e3779b1)) >>> 0);
        paintBlock(buf, mask, x, y0, bw, bh, edgeSeed, shared);
      } else {
        paintBlock(buf, mask, x, y0, bw, bh, seed, rng);
        if (opts.cracks > 0 && rng.chance(opts.cracks)) {
          paintCrack(buf, x, y0, bw - MORTAR, bh - MORTAR, rng);
        }
      }
      x += bw;
      remaining -= bw;
      b++;
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
        const moss = opts.moss * edgeFade(x); // the plain wall has none, so moss thins out at a seam
        if (moss > 0 && n > 1 - moss * 0.55) {
          // Lighter tips where the noise is strongest: moss catches light on its outer growth.
          const t = (n - (1 - moss * 0.55)) * 3.4;
          buf[i] = rampPickChunky(RAMPS.moss, 0.15 + t, x, y);
        }
      }
    }
  }

  // 4. Vines: strands hanging from the top edge, wobbling as they fall, with paired leaves. They
  //    start far enough inside the tile that wobble and leaves never reach a neighbour's edge.
  for (let v = 0; v < opts.vines; v++) {
    const startX = EDGE_ZONE + 4 + rng.int(SIZE - 2 * (EDGE_ZONE + 4));
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
 * Is feature cell (cx, cy) on the outer ring of the grid, i.e. a cobble along a tile edge?
 * @param {number} cx
 * @param {number} cy
 * @returns {boolean}
 */
function isRingCell(cx, cy) {
  return cx === 0 || cy === 0 || cx === COB_CELLS - 1 || cy === COB_CELLS - 1;
}

/** Moss and wet sheen every floor variant eases to at a tile edge (see `EDGE_ZONE`). */
const FLOOR_EDGE = Object.freeze({ moss: 0.3, wet: 0.3 });

/**
 * Paint a cobblestone floor: a toroidal jittered-Voronoi diagram where each region is one rounded
 * stone shaded from its centre outward, separated by near-black gaps with moss in them.
 *
 * The outer ring of feature cells, the texture noise and the moss noise come from `edgeSeed`, and
 * moss and wetness ease to `FLOOR_EDGE` at the border, so every floor variant has the same cobbles
 * along its four edges and meets any other without a break. Only the four inner stones and the
 * variant's own moss and wetness differ.
 * @param {number} seed
 * @param {{moss:number, wet:number}} opts moss coverage 0..1, wet-stone highlight chance 0..1
 * @param {number} edgeSeed shared by every floor variant of the set
 * @returns {Uint8Array}
 */
function paintFloor(seed, opts, edgeSeed) {
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
          const js = isRingCell(wx, wy) ? edgeSeed : seed;
          const jx = (gx + 0.18 + 0.64 * h01(wx, wy, js)) * COB_SPAN;
          const jy = (gy + 0.18 + 0.64 * h01(wx, wy, js ^ 0x1234)) * COB_SPAN;
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
      const noise = fbmChunky(x, y, edgeSeed ^ 0x77a1);
      const gapWidth = 2.1 + noise * 1.7; // irregular, so gaps are not machine-cut
      const own = edgeFade(x, y);
      const moss = FLOOR_EDGE.moss + (opts.moss - FLOOR_EDGE.moss) * own;
      const wet = FLOOR_EDGE.wet + (opts.wet - FLOOR_EDGE.wet) * own;

      if (edge < gapWidth) {
        // Gap between stones: nearly black, with moss tufts sprouting in the wider parts.
        const deep = 1 - edge / gapWidth; // 1 at the very centre of the gap
        const mossN = fbmChunky(x + 19, y + 5, edgeSeed ^ 0x2f5a);
        if (mossN * (0.5 + deep) > 1 - moss * 0.72) {
          buf[(y << 6) | x] = rampPickChunky(RAMPS.moss, 0.1 + (mossN - 0.5) * 1.6, x, y);
        } else {
          buf[(y << 6) | x] = rampPickChunky(RAMPS.cobble, 0.06 * (1 - deep) + noise * 0.09, x, y);
        }
        continue;
      }

      // Stone face: brighter toward the middle of the cobble (rounded), plus per-stone tone.
      const r = Math.sqrt(f1x * f1x + f1y * f1y) / (COB_SPAN * 0.78);
      const toneSeed = isRingCell(id1 & 3, id1 >> 2) ? edgeSeed : seed;
      const stoneTone = 0.34 + h01(id1 & 3, id1 >> 2, toneSeed ^ 0xabc) * 0.3;
      let t = stoneTone + (1 - r * r) * 0.22 + (noise - 0.5) * 0.17;
      // Light comes from above-left in texture space, matching the wall bevel.
      t += (-f1x - f1y) * 0.012;
      if (edge < gapWidth + 1.6) t -= 0.14; // dark contact shadow at the stone's rim
      if (wet > 0 && noise > 1 - wet * 0.18 && r < 0.55) t += 0.3; // wet sheen
      buf[(y << 6) | x] = rampPickChunky(RAMPS.cobble, t, x, y);
    }
  }

  return buf;
}

/**
 * Paint an iron floor grate set into the cobbles: the shared cobble border every floor variant has
 * (so the grate tile meets its neighbours without a break), and in the middle a framed lattice of
 * round bars over a black void, rusted and mossy at the joints.
 * Used on ~1 tile in 16 (see the raycaster's variant hash) exactly as in the reference art.
 * @param {number} seed
 * @param {number} edgeSeed shared by every floor variant of the set
 * @returns {Uint8Array}
 */
function paintGrate(seed, edgeSeed) {
  const buf = paintFloor(edgeSeed ^ 0x6a7e, FLOOR_EDGE, edgeSeed);
  const rng = createRng(seed);
  const lo = GRATE_LO;
  const hi = GRATE_HI;

  // A dark contact line where the cobbles were cut back for the frame.
  for (let k = lo - 1; k <= hi; k++) {
    put(buf, k, lo - 1, C.cobGap);
    put(buf, k, hi, C.cobGap);
    put(buf, lo - 1, k, C.cobGap);
    put(buf, hi, k, C.cobGap);
  }

  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      const fx = Math.min(x - lo, hi - 1 - x);
      const fy = Math.min(y - lo, hi - 1 - y);
      let c;
      if (fx < GRATE_FRAME || fy < GRATE_FRAME) {
        // Frame: lit on its top and left outer edges, dark on the bottom and right.
        const lit = (y - lo === 0 && x < hi - 1) || (x - lo === 0 && y < hi - 1);
        const dark = y === hi - 1 || x === hi - 1;
        c = lit ? C.ironLight : dark ? C.ironShadow : C.ironBase;
      } else {
        // Void below: almost black, with a faint cool glimmer so it is not a flat hole.
        c = fbmChunky(x, y, seed ^ 0x0d0d) > 0.72 ? C.stoneShadow : C.void;
      }
      buf[(y << 6) | x] = c;
    }
  }

  // Bars across the opening, horizontal ones laid over vertical ones, each shaded as a round bar.
  const inner = lo + GRATE_FRAME;
  const span = hi - GRATE_FRAME - inner;
  const gap = (span - 2 * GRATE_BAR) / 3;
  /** @type {number[]} across-bar shading, light → dark (the bar's cylindrical roll-off) */
  const barShade = [C.ironHilite, C.ironLight, C.ironDark, C.ironShadow];
  for (let n = 1; n <= 2; n++) {
    const b = inner + Math.round(n * gap + (n - 1) * GRATE_BAR);
    for (let k = inner; k < hi - GRATE_FRAME; k++) {
      for (let t = 0; t < GRATE_BAR; t++) put(buf, b + t, k, barShade[t]);
    }
  }
  for (let n = 1; n <= 2; n++) {
    const b = inner + Math.round(n * gap + (n - 1) * GRATE_BAR);
    for (let k = inner; k < hi - GRATE_FRAME; k++) {
      for (let t = 0; t < GRATE_BAR; t++) put(buf, k, b + t, barShade[t]);
    }
  }

  // Rust, wear and moss on the iron, otherwise the lattice looks like a CAD drawing.
  const iron = new Set([C.ironShadow, C.ironDark, C.ironBase, C.ironLight, C.ironHilite]);
  for (let i = 0; i < 40; i++) {
    const x = lo + rng.int(hi - lo);
    const y = lo + rng.int(hi - lo);
    if (!iron.has(buf[(y << 6) | x])) continue;
    const roll = rng.next();
    put(buf, x, y, roll < 0.45 ? C.ironHilite : roll < 0.78 ? C.oilDark : C.mossDeep);
  }
  return buf;
}

/** The grate's iron frame spans texels `GRATE_LO … GRATE_HI - 1`: inside the shared cobble ring. */
const GRATE_LO = 16;
const GRATE_HI = 48;
/** Frame and bar thickness in texels. */
const GRATE_FRAME = 3;
const GRATE_BAR = 4;

// ─── Ceiling ───────────────────────────────────────────────────────────────────────────────────

/**
 * Paint dark timber planks running along +x, with grain, nails and knots; optionally a heavier
 * cross beam. Seamless on both axes (4 planks of 16 texels). The plank tones and grain come from
 * `plankSeed`, shared by both ceilings, so a beamed tile and a plain one meet without a break.
 * @param {number} seed
 * @param {boolean} beam add a structural cross beam
 * @param {number} plankSeed shared by both ceiling variants
 * @returns {Uint8Array}
 */
function paintCeiling(seed, beam, plankSeed) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);

  for (let p = 0; p < 4; p++) {
    const y0 = p * 16;
    const plankTone = 0.34 + h01(p, 0, plankSeed) * 0.26;
    for (let y = y0; y < y0 + 16; y++) {
      const edge = y - y0;
      for (let x = 0; x < SIZE; x++) {
        // Grain: noise stretched 6× along the plank so it streaks lengthwise.
        const grain =
          vnoise(x & ~1, (y & ~1) * 6, 16, plankSeed ^ (p * 977)) * 0.62 +
          vnoise(x & ~1, (y & ~1) * 6, 8, plankSeed ^ 0x33) * 0.38;
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
      const ky = y0 + 5 + rng.int(p === 3 ? 5 : 7); // off the last plank's lower edge rows
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

/** Views of the wall sconce, fanned across its wall from `-TORCH_YAW_MAX` to `+TORCH_YAW_MAX`. */
export const TORCH_VIEWS = 7;

/** Yaw of the outermost sconce view, radians. Beyond it the raycaster keeps the last view. */
export const TORCH_YAW_MAX = 1.25;

/** Flame frames per sconce view: `torch[view * TORCH_FRAMES + frame]`. */
export const TORCH_FRAMES = 4;

/** Texel row of the sconce's model-space origin (y = 0). */
const TORCH_ORIGIN_ROW = 32;

/**
 * Where the wall plane sits in the sconce's model space, in texels: the billboard hangs 0.02 tiles
 * in front of the wall at 128 texels per tile (`TORCH_OFFSET`, `TORCH_SPRITE_SCALE` in the raycaster).
 */
const TORCH_WALL_Z = -2.5;

/** Model-space centre of the cup's mouth, where the flame is rooted. */
const TORCH_CUP = /** @type {const} */ ([0, 6, 12]);

/** @type {import('./models.js').Material[]} */
const TORCH_MATS = [
  { ramp: RAMPS.iron, albedo: 0.78, spec: 0.55, shine: 14, ambient: 0.28 }, // 0 forged iron
  { ramp: RAMPS.iron, albedo: 0.95, spec: 0.8, shine: 22, ambient: 0.4 }, // 1 rolled rim, rivets
  { ramp: RAMPS.fire, albedo: 0.42, ambient: 0.8 }, // 2 coals
];

/** @type {import('./models.js').Mesh|null} */
let torchMesh = null;

/**
 * The sconce: a riveted wall plate, an arm that runs out of the wall and bends up into a flared
 * cup, a brace under it, and a rolled rim. Built once and shared by every view.
 * @returns {import('./models.js').Mesh}
 */
function sconceMesh() {
  if (torchMesh) return torchMesh;
  const m = createMesh();
  const wz = TORCH_WALL_Z;
  box(m, -6, -22, wz, 6, -8, wz + 2, 0);
  for (const [rx, ry] of [[-4, -10], [4, -10], [-4, -20], [4, -20]]) box(m, rx - 1, ry - 1, wz + 2, rx + 1, ry + 1, wz + 3, 1);
  tube(m, [[0, -13, wz + 1], [0, -13, 4], [0, -11.5, 8.5], [0, -7.5, 11.4], [0, -2, 12]], 1.7, 0, 8);
  tube(m, [[0, -20, wz + 1], [0, -17, 3], [0, -12, 8]], 1.1, 0, 6);
  const [cx, cy, cz] = TORCH_CUP;
  lathe(m, [[2.5, cy - 8], [4, cy - 6], [6, cy - 3], [7.6, cy]], 0, { cx, cz, segs: 16, capBottom: true });
  /** @type {[number, number, number][]} */
  const rim = [];
  for (let k = 0; k <= 16; k++) {
    const a = (Math.PI * 2 * k) / 16;
    rim.push([cx + 7.8 * Math.sin(a), cy, cz + 7.8 * Math.cos(a)]);
  }
  tube(m, rim, 0.9, 1, 6);
  lathe(m, [[7, cy - 1.2], [0, cy - 0.6]], 2, { cx, cz, segs: 16 });
  torchMesh = m;
  return m;
}

/**
 * Paint one frame of the flame and its stippled halo, rooted at `(cx, base)`. The flame stays 2D
 * art over the modelled cup: fire has no surface to model, and a billboard flame is what the
 * reference shows.
 * @param {Uint8Array} buf
 * @param {Uint8Array} stipple
 * @param {number} seed
 * @param {number} frame 0..3
 * @param {number} cx texel column of the flame's axis
 * @param {number} base texel row of the flame's root
 * @returns {void}
 */
function paintFlame(buf, stipple, seed, frame, cx, base) {
  // A teardrop that narrows to a tip, wobbling per frame. `t` runs 0 at the tip → 1 at the base.
  const tip = base - 23 + (frame & 1);
  for (let y = tip; y <= base; y++) {
    const t = (y - tip) / (base - tip);
    const wob = (h01(y - base + 26, frame * 7 + 1, seed) - 0.5) * 2;
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
  const hy = base - 10;
  const hx = Math.round(cx);
  for (let y = Math.max(0, hy - 17); y < Math.min(SIZE, hy + 17); y++) {
    for (let x = Math.max(0, hx - 15); x < Math.min(SIZE, hx + 16); x++) {
      const i = (y << 6) | x;
      if (buf[i] !== 0) continue;
      const dx = (x - cx) / 15;
      const dy = (y - hy) / 17;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      const n = h01(x >> 1, (y >> 1) + frame * 13, seed ^ 0xf1a3);
      if (n < d * 0.9) continue;
      buf[i] = d > 0.55 ? C.fireDeep : d > 0.24 ? C.fireEmber : C.fireMid;
      stipple[i] = 1;
    }
  }
}

/**
 * Paint the modelled iron sconce seen from one view across its wall, with a burning flame.
 * @param {number} seed
 * @param {number} frame 0..TORCH_FRAMES-1 flame frame
 * @param {number} view 0..TORCH_VIEWS-1 across the wall
 * @param {Uint8Array} stipple out-param: halo texels are marked 1
 * @returns {Uint8Array}
 */
function paintTorch(seed, frame, view, stipple) {
  const buf = new Uint8Array(AREA);
  const yaw = TORCH_VIEWS > 1 ? -TORCH_YAW_MAX + (2 * TORCH_YAW_MAX * view) / (TORCH_VIEWS - 1) : 0;
  const pitch = -0.14; // the sconce hangs above eye level: a glimpse of the cup's underside
  renderMesh(sconceMesh(), TORCH_MATS, { yaw, pitch, originRow: TORCH_ORIGIN_ROW, light: [0, 0.9, 0.45] }, rampPickChunky, buf);
  const [cx, cy, cz] = TORCH_CUP;
  const at = projectPoint(cx, cy, cz, yaw, pitch, TORCH_ORIGIN_ROW);
  paintFlame(buf, stipple, seed, frame, at.sx - 0.5, Math.round(at.sy));
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
 * light, inside a stippled cyan halo.
 *
 * Sized for the range it matters at: the billboard is 0.34 tiles, so four to six tiles down a
 * corridor the whole sprite is 14–20 screen pixels tall. At the old 8–24 texels of width that left a
 * 5–8 px sliver, which read as a figurine rather than a gem; 12–30 texels plus the halo (which the
 * flame and the portal already use to be seen from a distance) keeps the crystal shape and its glow
 * readable there, and the silhouette still narrows as it turns.
 * @param {number} seed
 * @param {number} frame 0..7
 * @param {Uint8Array} stipple out-param: halo texels are marked 1
 * @returns {Uint8Array}
 */
function paintGem(seed, frame, stipple) {
  const buf = new Uint8Array(AREA);
  const theta = (frame / 8) * Math.PI * 2;
  const cosT = Math.cos(theta);
  const cx = 32;
  const topY = 16;
  const midY = 30;
  const botY = 47;
  const halfW = 6 + Math.abs(cosT) * 9; // 6..15 texels — never edge-on, so it stays readable
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

  // ── Halo ── a stippled cyan glow, thickest around the girdle, exactly like the flame's: it is
  // what carries the pickup out of the gloom at the distance a player decides to walk over to it.
  const hy = (topY + botY) >> 1;
  const rx = halfW + 9;
  const ry = 21;
  for (let y = Math.max(0, hy - ry); y < Math.min(SIZE, hy + ry); y++) {
    for (let x = Math.max(0, cx - rx) | 0; x < Math.min(SIZE, cx + rx + 1); x++) {
      const i = (y << 6) | x;
      if (buf[i] !== 0) continue;
      const dx = (x - cx) / rx;
      const dy = (y - hy) / ry;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      // Thinning outward: the noise threshold rises with the distance, so the glow dissolves
      // rather than ending on a ring.
      if (h01(x >> 1, (y >> 1) + frame * 11, seed ^ 0x3b1f) < d * 0.95) continue;
      buf[i] = d > 0.5 ? C.gemDeep : d > 0.22 ? C.gemMid : C.gemBright;
      stipple[i] = 1;
    }
  }

  return buf;
}

/**
 * Yaw of the flask's single still view, radians: a 3/4 turn that shows the handle looping out on
 * the right and the sealed label on the front-left. A still image rather than a turntable — the
 * flask stands on the floor with its shadow baked in, so it must not spin or bob off it.
 */
export const OIL_YAW = Math.PI / 6;

/** Texel row of the flask's model-space origin (its base, y = 0). */
const OIL_ORIGIN_ROW = 49;

/** @type {import('./models.js').Material[]} */
const OIL_MATS = [
  { ramp: RAMPS.oil, albedo: 0.66, spec: 0.7, shine: 26, trans: 0.3, ambient: 0.34 }, // 0 glass full of oil
  { ramp: RAMPS.oil, albedo: 0.38, spec: 0.75, shine: 30, trans: 0.12, ambient: 0.3 }, // 1 glass above the oil
  { ramp: RAMPS.wood, albedo: 0.95, spec: 0.1, ambient: 0.35 }, // 2 cork
  { ramp: RAMPS.wood, albedo: 0.7, spec: 0.15, ambient: 0.3 }, // 3 twine and handle
  { ramp: RAMPS.map, albedo: 0.9, ambient: 0.35 }, // 4 parchment label
  { ramp: RAMPS.seal, albedo: 0.95, spec: 0.3, ambient: 0.35 }, // 5 wax seal
];

/** @type {import('./models.js').Mesh|null} */
let oilMesh = null;

/**
 * The flask: a round-shouldered amber bottle filled to the shoulder, a corked neck bound with
 * twine, a looped handle on one side and a sealed parchment label on another. The asymmetric
 * parts are what make the still view read as a solid object rather than a flat bottle shape.
 * @returns {import('./models.js').Mesh}
 */
function flaskMesh() {
  if (oilMesh) return oilMesh;
  const m = createMesh();
  const FILL = 15;
  lathe(m, [[0, 0], [8, 0], [10.5, 1.2], [12.2, 3.6], [13, 7.5], [12.7, 11.5], [11.8, FILL]], 0, { segs: 22 });
  lathe(m, [[11.8, FILL], [10, 17.8], [7, 20.6], [4.6, 22.6], [4, 25], [4, 30], [5.2, 31], [5.2, 32.4], [3.6, 33.2]], 1, { segs: 22 });
  lathe(m, [[3.3, 30], [3.5, 34], [3.1, 38.5]], 2, { segs: 12, capTop: true });
  /** @type {[number, number, number][]} */
  const ring = [];
  for (let k = 0; k <= 14; k++) {
    const a = (Math.PI * 2 * k) / 14;
    ring.push([4.5 * Math.sin(a), 27, 4.5 * Math.cos(a)]);
  }
  tube(m, ring, 1, 3, 6);
  tube(m, [[4.2, 28, 0], [9, 28.6, 0], [13, 26, 0], [14.6, 21, 0], [13.4, 15.5, 0], [12, 13, 0]], 1.4, 3, 6);
  lathe(m, [[13.35, 4], [13.4, 7.5], [13.1, 11.2]], 4, { segs: 6, a0: -0.62 - Math.PI / 2, a1: 0.62 - Math.PI / 2 });
  box(m, -14.4, 6, -1.6, -13.2, 9, 1.6, 5);
  oilMesh = m;
  return m;
}

/** Radius, texels, of the flask's solid contact shadow: the widest part of the body (13) plus a skirt. */
const OIL_CONTACT = 14.5;

/**
 * Ramp picker for the flask: undithered on the **glass** (materials 0 and 1, the only ones painted
 * from `RAMPS.oil`), chunky-dithered on everything else.
 *
 * WHY: the bottle is a big smooth lathe, so a dither across its amber body alternates two ramp steps
 * over the whole surface — at one or two tiles from the eye each texel is 3–6 screen pixels, so that
 * reads as a checkerboard painted onto the glass rather than as a gradient. Quantising instead gives
 * the flat banded highlight pixel-art glass is made of. The cork, twine, label and seal are small
 * and matte, where the dither still buys smoothness.
 * @param {Uint8Array} ramp
 * @param {number} t
 * @param {number} x
 * @param {number} y
 * @returns {number} palette index
 */
function oilPick(ramp, t, x, y) {
  return ramp === RAMPS.oil ? rampPickFlat(ramp, t) : rampPickChunky(ramp, t, x, y);
}

/**
 * Paint the modelled oil flask, shadowed: the handle, twine and cork shade the bottle, and the
 * flask casts a shadow on the floor with a darker contact ring under its base.
 * @param {Uint8Array} stipple out-param: half-shade shadow texels are marked 1
 * @returns {Uint8Array}
 */
function paintOil(stipple) {
  const buf = new Uint8Array(AREA);
  const yaw = OIL_YAW;
  // Seen from a little above: the player's eye is half a tile up and the flask stands on the floor.
  // Lit from high up and to the left, so the cast shadow falls short and to the right and stays
  // inside the 64-texel card.
  renderMesh(
    flaskMesh(),
    OIL_MATS,
    {
      yaw,
      pitch: 0.28,
      originRow: OIL_ORIGIN_ROW,
      light: [-0.5, 1, 0.45],
      shadows: true,
      ground: { index: C.void, contact: OIL_CONTACT, stipple },
    },
    oilPick,
    buf,
  );
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

// ─── Chalk lettering (ARCHITECTURE.md §4.9) ────────────────────────────────────────────────────

/** How many differently slanted A-MAZE scrawls the set carries. */
export const CHALK_VARIANTS = 8;

/**
 * The chalk hand: five-by-seven capitals for the only word the player ever writes. Upright,
 * uniform strokes — a chalk stick has no thick and thin — with the M's middle stroke dropped to the
 * baseline the way it is written fast.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const CHALK_GLYPHS = Object.freeze({
  A: Object.freeze(['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#']),
  '-': Object.freeze(['.....', '.....', '.....', '.###.', '.....', '.....', '.....']),
  M: Object.freeze(['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#']),
  Z: Object.freeze(['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####']),
  E: Object.freeze(['#####', '#....', '#....', '####.', '#....', '#....', '#####']),
});

/** The word. */
const CHALK_WORD = 'A-MAZE';
/** Texels per glyph pixel: big enough to read across a corridor, small enough to fit the slant. */
const CHALK_SCALE = 2;
/** Glyph advance in texels (5 pixels × scale + a 2-texel gap, so M and A never touch). */
const CHALK_ADVANCE = 5 * CHALK_SCALE + 2;

/**
 * Paint one A-MAZE scrawl: the word rotated to a random diagonal (36–45° either way, which is as
 * shallow as the 70-texel line can lie and still fit the 64-texel face), each letter nudged off the
 * baseline like handwriting, the strokes broken where chalk skips on stone, and a little powder
 * around them. Index 0 is bare wall.
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintChalk(seed) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  const slant = rng.range(36, 45) * (Math.PI / 180) * (rng.chance(0.5) ? -1 : 1);
  const cos = Math.cos(slant);
  const sin = Math.sin(slant);
  const cx = 32 + rng.range(-0.5, 0.5);
  const cy = 32 + rng.range(-0.5, 0.5);
  const textW = CHALK_WORD.length * CHALK_ADVANCE - 1;
  const textH = 7 * CHALK_SCALE;
  /** Per-letter baseline wobble, in texels. */
  const wobble = new Float32Array(CHALK_WORD.length);
  for (let i = 0; i < wobble.length; i++) wobble[i] = rng.range(-1.2, 1.2);

  // Pass 1: the stroke mask, sampled back through the rotation (nearest texel, so every stroke is a
  // solid run two texels thick at any slant).
  const core = new Uint8Array(AREA);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = dx * cos + dy * sin + textW / 2;
      const v = -dx * sin + dy * cos + textH / 2;
      // Four sub-samples half a texel apart: a stroke sampled at one point per texel broke into
      // stairs at a slant ("A-MAZE" read as "A-HAPZE" up close); any hit inks the texel, which
      // thickens every stroke by about half a texel and keeps it continuous.
      for (let k = 0; k < 4; k++) {
        const su = u + (k & 1) * 0.5 - 0.25;
        const sv = v + ((k >> 1) & 1) * 0.5 - 0.25;
        if (su < 0 || su >= textW) continue;
        const letter = Math.floor(su / CHALK_ADVANCE);
        const lx = su - letter * CHALK_ADVANCE;
        if (letter < 0 || letter >= CHALK_WORD.length || lx >= 5 * CHALK_SCALE) continue;
        const lv = sv - wobble[letter];
        if (lv < 0 || lv >= textH) continue;
        const rows = CHALK_GLYPHS[CHALK_WORD.charAt(letter)];
        if (rows[Math.floor(lv / CHALK_SCALE)].charCodeAt(Math.floor(lx / CHALK_SCALE)) === 35) {
          core[(y << 6) | x] = 1;
          break;
        }
      }
    }
  }

  // Pass 2: tone. The heart of a stroke is pale, a stroke skips here and there, and its broken edge
  // smudges into powder. Nothing is drawn away from the letters: a mark must read as writing, and
  // specks across the whole face read as a dirty texture instead.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      if (core[i] === 1) {
        const r = rng.next();
        buf[i] = r < 0.03 ? C.chalkSmudge : r < 0.22 ? C.chalkMid : C.chalkPale;
        continue;
      }
      let near = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
          near += core[(ny << 6) | nx];
        }
      }
      if (near > 0) {
        const r = rng.next();
        if (r < 0.14) buf[i] = C.chalkSmudge;
        else if (r < 0.2) buf[i] = C.chalkDust;
      }
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
export function finish(indices, stipple, emissive) {
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

  // Variants of a surface share their edges (`COURSES`, the bond and the edge blocks; the cobble
  // ring; the planks), so any variant meets any other at a tile seam whatever the mix.
  const wallEdge = s('wallEdge');
  /** @type {Texture[]} */
  const wall = [
    finish(paintWall(s('wall0'), { moss: 0, vines: 0, cracks: 0.22 }, wallEdge), null, false),
    finish(paintWall(s('wall1'), { moss: 0.12, vines: 0, cracks: 0.7 }, wallEdge), null, false),
    finish(paintWall(s('wall2'), { moss: 0.42, vines: 0, cracks: 0.35 }, wallEdge), null, false),
    finish(paintWall(s('wall3'), { moss: 0.34, vines: 2, cracks: 0.3 }, wallEdge), null, false),
  ];

  const floorEdge = s('floorEdge');
  /** @type {Texture[]} */
  const floor = [
    finish(paintFloor(s('floor0'), { moss: 0.22, wet: 0.45 }, floorEdge), null, false),
    finish(paintFloor(s('floor1'), { moss: 0.5, wet: 0.2 }, floorEdge), null, false),
    finish(paintGrate(s('grate'), floorEdge), null, false),
  ];

  const planks = s('planks');
  /** @type {Texture[]} */
  const ceiling = [
    finish(paintCeiling(s('ceil0'), false, planks), null, false),
    finish(paintCeiling(s('ceil1'), true, planks), null, false),
  ];

  const torchSeed = s('torch');
  /** @type {Texture[]} */
  const torch = [];
  for (let v = 0; v < TORCH_VIEWS; v++) {
    for (let f = 0; f < TORCH_FRAMES; f++) torch.push(finishStippled((st) => paintTorch(torchSeed, f, v, st), true));
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
  for (let f = 0; f < 8; f++) gem.push(finishStippled((st) => paintGem(gemSeed, f, st), false));

  // One still frame (`OIL_YAW`), an array like every other field.
  /** @type {Texture[]} */
  const oil = [finishStippled(paintOil, false)];

  /** @type {Texture[]} */
  const sparkle = [];
  for (let f = 0; f < 4; f++) sparkle.push(finishStippled((st) => paintSparkle(f, st), true));

  // One still frame: the scroll lies on the floor and neither spins nor glows (§4.8). Still an
  // array, like every other field, so the raycaster indexes it through the same path.
  /** @type {Texture[]} */
  const map = [finish(paintMap(s('map')), null, false)];

  // The player's chalk marks (§4.9): every variant a different slant and hand.
  const chalkSeed = s('chalk');
  /** @type {Texture[]} */
  const chalk = [];
  for (let v = 0; v < CHALK_VARIANTS; v++) chalk.push(finish(paintChalk((chalkSeed + v * 0x9e3779b9) >>> 0), null, false));

  return { seed: usedSeed, size: SIZE, wall, floor, ceiling, torch, portal, gem, oil, sparkle, map, chalk };
}
