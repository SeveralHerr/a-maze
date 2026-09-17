// @ts-check
/**
 * @file Ossuary tileset — floor 3, the catacombs.
 *
 * ART DIRECTION:
 * - **Walls** — rough ochre/umber sandstone blocks in a running bond: chipped corners, faint
 *   horizontal bedding strata, honeycomb pits, bone chips wedged in the dusty mortar. Variants: old
 *   plaster flaking off the blocks with a faded red-ochre band; a burial niche with bones laid on its
 *   sill; and the rare showpiece, a wall of packed long-bone ends around a row of skulls.
 * - **Floors** — cracked sandstone flags half-buried in packed dusty earth, scattered with bone
 *   fragments and pebbles (two mixes, mostly-flag and mostly-earth, so tile seams read as patchy
 *   ground rather than as a checkerboard); the rare tile a carved limestone grave slab.
 * - **Ceiling** — low rough-hewn rock in planar facets with chisel marks; the band variant adds a
 *   heavy timber lintel.
 *
 * Every wall variant shares {@link COURSES}, so bed joints run unbroken along a corridor, and none
 * of them sits on the eye-level row 32. Floors and ceilings are painted toroidally.
 *
 * Seamless across variants (the raycaster puts any variant beside any other with no offset): each
 * surface has a shared `…Edge` seed that paints its layout (block bond, flag grid, facet sites) and
 * everything that touches a tile edge, while the variant seed paints the interior. Decor — plaster,
 * the niche, the bone panel, floor scatter, the grave slab, the lintel — stays inside the tile.
 *
 * Node-safe: no DOM access.
 */

import { createRng } from '../../core/rng.js';
import { C, RAMPS, ramp } from '../palette.js';
import {
  AREA,
  MASK,
  SIZE,
  fbmChunky,
  h01,
  put,
  rampPickChunky,
  rampPickFlat,
  vnoise,
} from '../textures.js';

/** @typedef {import('../../core/rng.js').Rng} Rng */

const SAND = ramp(
  'ossSandShadow',
  'ossSandMortar',
  'ossSandDeep',
  'ossSandDark',
  'ossSandMid',
  'ossSandBase',
  'ossSandLight',
  'ossSandBright',
  'ossSandHilite',
);
const BONE = ramp('ossBoneShadow', 'ossBoneDark', 'ossBoneMid', 'ossBoneBase', 'ossBoneLight', 'ossBonePale');
const EARTH = ramp('ossEarthGap', 'ossEarthShadow', 'ossEarthDark', 'ossEarthMid', 'ossEarthBase', 'ossEarthLight');
const PLASTER = ramp('ossSandDeep', 'ossPlasterShadow', 'ossPlasterDark', 'ossPlasterMid', 'ossPlasterLight');

// ─── Walls ─────────────────────────────────────────────────────────────────────────────────────

/** Course boundaries shared by every wall variant; slid 8 rows so row 32 is inside a face. */
const COURSES = Int32Array.of(8, 24, 40, 56, 72);
const MORTAR = 3;

/** 1 = mortar/background texel, 0 = block face. Shared scratch, painting is sequential. */
const mask = new Uint8Array(AREA);

/**
 * Paint one rough sandstone block.
 * @param {Uint8Array} buf
 * @param {number} bx
 * @param {number} by
 * @param {number} bw cell width incl. mortar
 * @param {number} bh cell height incl. mortar
 * @param {number} seed
 * @param {Rng} rng
 */
function paintSandBlock(buf, bx, by, bw, bh, seed, rng) {
  const fw = bw - MORTAR;
  const fh = bh - MORTAR;
  const baseT = 0.54 + rng.range(-0.22, 0.2);
  const bevel = rng.range(0.55, 1.15);
  // Chipped corners: how many texels each corner loses (a small stepped triangle).
  const chip = [rng.int(3), rng.int(3), rng.int(3), rng.int(4)];
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const cxl = x, cxr = fw - 1 - x, cyt = y, cyb = fh - 1 - y;
      if (cxl + cyt < chip[0] || cxr + cyt < chip[1] || cxl + cyb < chip[2] || cxr + cyb < chip[3]) continue;
      const gx = bx + x;
      const gy = by + y;
      let t = baseT + (fbmChunky(gx, gy, seed) - 0.5) * 0.32;
      // Worn arris: short runs of the lit top edge are knocked back a step. (Knocking them all the
      // way to mortar read as dark drips on a grazing wall, where a texel column stretches tall.)
      if (y === 0 && vnoise(gx & MASK, 0, 4, seed ^ 0x3e1) < 0.3) t -= 0.2 * bevel;
      // Bedding strata: noise squashed vertically streaks along the block.
      t += (vnoise(gx & ~1, (gy & MASK) * 4, 16, seed ^ 0x5a17) - 0.5) * 0.2;
      if (y === 0 || x === 0) t += 0.26 * bevel;
      else if (y === 1 || x === 1) t += 0.11 * bevel;
      if (y >= fh - 2 || x >= fw - 2) t -= 0.17;
      if (y === fh - 1 || x === fw - 1) t -= 0.12;
      put(buf, gx, gy, rampPickFlat(SAND, t));
      mask[((gy & MASK) << 6) | (gx & MASK)] = 0;
    }
  }
  // Weathered patches: flat off-tone slabs of the neighbouring step.
  const patches = 2 + rng.int(3);
  for (let i = 0; i < patches; i++) {
    const px = 2 + rng.int(Math.max(1, fw - 8));
    const py = 2 + rng.int(Math.max(1, fh - 6));
    const pw = 4 + rng.int(4);
    const ph = 2 + rng.int(3);
    const dt = rng.chance(0.55) ? -0.125 : 0.125;
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        if (px + x >= fw - 2 || py + y >= fh - 2) continue;
        put(buf, bx + px + x, by + py + y, rampPickFlat(SAND, baseT + dt));
      }
    }
  }
  // Honeycomb pits: sandstone erodes into small pockets, shadowed top-left, lit bottom-right lip.
  const pits = 2 + rng.int(4);
  for (let i = 0; i < pits; i++) {
    const px = 2 + rng.int(Math.max(1, fw - 6));
    const py = 2 + rng.int(Math.max(1, fh - 5));
    const big = rng.chance(0.4);
    put(buf, bx + px, by + py, C.ossSandDeep);
    put(buf, bx + px + 1, by + py, C.ossSandDark);
    if (big) {
      put(buf, bx + px, by + py + 1, C.ossSandDark);
      put(buf, bx + px + 1, by + py + 1, C.ossSandMid);
      put(buf, bx + px + 2, by + py + 1, rampPickFlat(SAND, baseT + 0.14));
    } else {
      put(buf, bx + px + 1, by + py + 1, rampPickFlat(SAND, baseT + 0.14));
    }
  }
  // Grain flecks, one step off.
  const flecks = 6 + rng.int(6);
  for (let i = 0; i < flecks; i++) {
    const fx = 2 + rng.int(Math.max(1, fw - 4));
    const fy = 2 + rng.int(Math.max(1, fh - 4));
    const at = (((by + fy) & MASK) << 6) | ((bx + fx) & MASK);
    const step = SAND.indexOf(buf[at]);
    const next = rng.chance(0.3) ? step + 1 : step - 1;
    if (step < 0 || next < 2 || next >= SAND.length) continue;
    buf[at] = SAND[next];
  }
}

/**
 * Hairline crack down a block face.
 * @param {Uint8Array} buf
 * @param {number} bx
 * @param {number} by
 * @param {number} fw
 * @param {number} fh
 * @param {Rng} rng
 */
function paintCrack(buf, bx, by, fw, fh, rng) {
  let cx = 2 + rng.int(Math.max(1, fw - 4));
  let cy = 0;
  const drift = rng.chance(0.5) ? 1 : -1;
  const len = 6 + rng.int(fh);
  for (let i = 0; i < len && cy < fh; i++) {
    if (cx < 1 || cx >= fw - 1) break;
    put(buf, bx + cx, by + cy, rng.chance(0.7) ? C.ossSandMortar : C.ossSandDeep);
    if (rng.chance(0.25)) put(buf, bx + cx + 1, by + cy, C.ossSandLight);
    cy++;
    if (rng.chance(0.4)) cx += drift;
    else if (rng.chance(0.1)) cx -= drift;
  }
}

/**
 * Does the run `[x, x + w)` (unwrapped columns or rows) touch a tile edge, line 0 or line 63?
 * @param {number} x
 * @param {number} w
 * @returns {boolean}
 */
function touchesEdge(x, w) {
  for (let k = x; k < x + w; k++) if ((k & MASK) === 0 || (k & MASK) === MASK) return true;
  return false;
}

/**
 * Distance of a line from the nearer tile edge: 0 on lines 0 and 63, 31 in the middle.
 * @param {number} v 0..63
 * @returns {number}
 */
const edgeDist = (v) => Math.min(v, MASK - v);

/**
 * A per-block stream, so one block's painting never shifts another's.
 * @param {number} seed
 * @param {number} a
 * @param {number} b
 * @returns {Rng}
 */
const blockRng = (seed, a, b) => createRng((seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0);

/**
 * Mortar bed plus the full running bond of sandstone blocks.
 *
 * Seamless across variants: the mortar bed and the block layout come from the shared `edge` seed, as
 * does the whole painting (tone, bevel, grain, cracks) of every block that touches column 0 or 63 —
 * so any variant's right edge meets any other's left edge in the middle of the same block. Only the
 * interior blocks take the variant's own seed, and bone chips stay out of the edge zone.
 * @param {number} seed variant seed
 * @param {number} edge seed shared by every wall variant
 * @param {Rng} rng variant stream (chips)
 * @param {number} cracks chance per interior block
 * @param {number} chips bone chips wedged in the joints
 * @returns {Uint8Array}
 */
function paintMasonry(seed, edge, rng, cracks, chips) {
  const buf = new Uint8Array(AREA);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const n = fbmChunky(x, y, edge ^ 0x9a11);
      buf[(y << 6) | x] = rampPickChunky(SAND, 0.02 + n * 0.2, x, y);
      mask[(y << 6) | x] = 1;
    }
  }
  const layout = createRng(edge ^ 0x1a7);
  for (let r = 0; r < COURSES.length - 1; r++) {
    const y0 = COURSES[r];
    const bh = COURSES[r + 1] - y0;
    let x = layout.int(SIZE);
    let remaining = SIZE;
    for (let k = 0; remaining > 0; k++) {
      let bw = remaining <= 40 ? remaining : 21 + layout.int(14);
      if (remaining - bw > 0 && remaining - bw < 20) bw = remaining - 20;
      const shared = touchesEdge(x, bw);
      const bs = shared ? edge : seed;
      const brng = blockRng(bs, r, k);
      paintSandBlock(buf, x, y0, bw, bh, bs, brng);
      if (brng.chance(shared ? 0.22 : cracks)) paintCrack(buf, x, y0, bw - MORTAR, bh - MORTAR, brng);
      x += bw;
      remaining -= bw;
    }
  }
  // Bone chips pressed into the mortar: short pale slivers sitting in the bed joints, kept 4 texels
  // clear of the tile edges (a chip cut in half by the next variant reads as a seam).
  for (let i = 0, tries = 0; i < chips && tries < 200; tries++) {
    const len = 2 + rng.int(3);
    const x = 4 + rng.int(SIZE - 8 - len);
    const course = rng.int(COURSES.length - 1);
    const y = COURSES[course + 1] - 2; // middle of the 3-texel joint
    let ok = true;
    for (let k = 0; k < len; k++) if (mask[((y & MASK) << 6) | ((x + k) & MASK)] !== 1) ok = false;
    if (!ok) continue;
    for (let k = 0; k < len; k++) {
      put(buf, x + k, y, k === 0 ? C.ossBoneLight : C.ossBoneBase);
      put(buf, x + k, y + 1, C.ossBoneDark);
    }
    i++;
  }
  return buf;
}

/**
 * Shade a lit rounded blob texel (bone end, skull dome). Light from the top-left.
 * @param {number} nx -1..1 across
 * @param {number} ny -1..1 down
 * @param {number} tone base position on the bone ramp
 * @returns {number} palette index
 */
function boneShade(nx, ny, tone) {
  const d = nx * nx + ny * ny;
  let t = tone - (nx * 0.5 + ny * 0.7) * 0.28 - d * 0.12;
  if (d > 0.72) t -= 0.2;
  return rampPickFlat(BONE, t);
}

/**
 * A long bone seen end-on: a round or two-lobed knuckle.
 * @param {Uint8Array} buf
 * @param {number} cx
 * @param {number} cy
 * @param {number} r radius
 * @param {number} tone
 * @param {number} kind 0 round, 1 two-lobed condyle, 2 broken (hollow)
 */
function paintBoneEnd(buf, cx, cy, r, tone, kind) {
  const R = Math.ceil(r) + 1;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      let nx = dx / r;
      let ny = dy / (r * 0.9);
      let inside = nx * nx + ny * ny <= 1;
      if (kind === 1) {
        // Two overlapping lobes side by side.
        const lx = (Math.abs(dx) - r * 0.45) / (r * 0.62);
        const ly = dy / (r * 0.78);
        inside = lx * lx + ly * ly <= 1 || (Math.abs(dx) < r * 0.5 && Math.abs(dy) < r * 0.55);
        nx = dx / (r * 1.05);
        ny = dy / (r * 0.8);
      }
      if (!inside) continue;
      let c = boneShade(nx, ny, tone);
      if (kind === 2 && nx * nx + ny * ny < 0.2) c = nx + ny < 0 ? C.ossBoneShadow : C.ossBoneDark;
      if (kind === 1 && dx === 0 && dy < 0) c = C.ossBoneDark; // notch between the lobes
      put(buf, cx + dx, cy + dy, c);
    }
  }
}

/**
 * A skull, facing out of the wall. Symmetric, so horizontal mirroring is harmless.
 * @param {Uint8Array} buf
 * @param {number} cx centre column
 * @param {number} cy row of the eye sockets
 * @param {number} tone
 * @param {boolean} jaw has a lower jaw
 */
function paintSkull(buf, cx, cy, tone, jaw) {
  // Cranium: a dome from cy-7 to cy+2.
  for (let dy = -7; dy <= 3; dy++) {
    for (let dx = -7; dx <= 7; dx++) {
      const nx = dx / 6.8;
      const ny = (dy + 1.5) / 6.2;
      if (nx * nx + ny * ny > 1) continue;
      put(buf, cx + dx, cy + dy, boneShade(nx, ny * 0.9, tone + 0.08));
    }
  }
  // Maxilla/cheekbones and teeth: narrower block below.
  for (let dy = 3; dy <= (jaw ? 7 : 5); dy++) {
    const half = dy <= 4 ? 5 : 4;
    for (let dx = -half; dx <= half; dx++) {
      const nx = dx / (half + 1);
      put(buf, cx + dx, cy + dy, boneShade(nx, 0.35 + (dy - 3) * 0.12, tone));
    }
  }
  // Cheekbone shadow under the dome edge.
  put(buf, cx - 6, cy + 3, C.ossBoneShadow);
  put(buf, cx + 6, cy + 3, C.ossBoneShadow);
  // Eye sockets: 3×3 dark with a deeper core, brow lit above.
  for (const s of [-1, 1]) {
    const ex = cx + s * 3;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) === 2 && dy > 0) continue;
        put(buf, ex + dx, cy + dy, dy === -1 ? C.ossBoneShadow : C.ossSandShadow);
      }
    }
    put(buf, ex - 1, cy - 2, C.ossBonePale);
    put(buf, ex, cy - 2, C.ossBoneLight);
    put(buf, ex + 1, cy + 1, C.ossBoneMid); // lit lower rim of the socket
  }
  // Nasal cavity: an inverted notch.
  put(buf, cx, cy + 2, C.ossSandShadow);
  put(buf, cx, cy + 3, C.ossBoneShadow);
  put(buf, cx - 1, cy + 2, C.ossBoneDark);
  // Teeth: alternating bone / gap along the tooth line.
  const ty = cy + 5;
  for (let dx = -3; dx <= 3; dx++) put(buf, cx + dx, ty, (dx & 1) === 0 ? C.ossBoneLight : C.ossBoneShadow);
  if (jaw) for (let dx = -3; dx <= 3; dx++) put(buf, cx + dx, ty + 1, (dx & 1) === 0 ? C.ossBoneMid : C.ossBoneDark);
  // Contact shadow under the skull.
  for (let dx = -4; dx <= 4; dx++) put(buf, cx + dx, cy + (jaw ? 8 : 6), C.ossSandShadow);
}

/**
 * A long bone lying horizontally: a shaft with knobbed ends.
 * @param {Uint8Array} buf
 * @param {number} x0 left end
 * @param {number} y centre row
 * @param {number} len
 * @param {number} tone
 */
function paintLongBone(buf, x0, y, len, tone) {
  for (let k = 0; k < len; k++) {
    const end = k < 3 || k >= len - 3;
    put(buf, x0 + k, y - 1, rampPickFlat(BONE, tone + 0.22));
    put(buf, x0 + k, y, rampPickFlat(BONE, tone));
    put(buf, x0 + k, y + 1, rampPickFlat(BONE, tone - 0.28));
    if (end) {
      put(buf, x0 + k, y - 2, rampPickFlat(BONE, tone + 0.12));
      put(buf, x0 + k, y + 2, C.ossBoneShadow);
    }
  }
  // A notch in each knuckle.
  put(buf, x0 + 1, y - 2, C.ossBoneDark);
  put(buf, x0 + len - 2, y - 2, C.ossBoneDark);
}

/**
 * Wall[1]: sandstone with old plaster flaking off it and a faded ochre band.
 * @param {Uint8Array} buf
 * @param {number} seed
 * @param {Rng} rng
 */
function paintPlaster(buf, seed, rng) {
  const cover = new Uint8Array(AREA);
  // Plaster clings in broad patches; blocky 2×2 noise gives flaked, hard-edged outlines. Weighted
  // toward the upper wall, out of reach of scuffing. The threshold is the noise's own 55th
  // percentile, so every seed leaves ~45 % plastered and the rest bare masonry — a fixed threshold
  // swung from a few specks to a flat grey pillar depending on the seed.
  const field = new Float32Array(AREA);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const n = 0.62 * vnoise(x & ~1, y & ~1, 32, seed ^ 0x71a) + 0.38 * vnoise(x & ~1, y & ~1, 8, seed ^ 0x1c3);
      field[(y << 6) | x] = n + (y < 40 ? 0.05 : -0.05);
    }
  }
  const cut = Float32Array.from(field).sort()[(AREA * 0.55) | 0];
  // The coat has flaked back from the tile edges: coverage is pulled down over the outer 12 columns
  // and gone from the outer 3, so the bare shared masonry meets the neighbouring variant.
  for (let i = 0; i < AREA; i++) {
    const d = edgeDist(i & MASK);
    const taper = d < 3 ? 1 : d < 12 ? ((12 - d) / 9) * 0.35 : 0;
    cover[i] = field[i] - taper > cut ? 1 : 0;
  }
  const bandY = 12 + rng.int(3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      if (!cover[i]) {
        // The raw edge of the missing plaster: a lit lip on the stone right where the coat broke off.
        // Only a thin cast shadow under the coat: outlining every flake edge in near-black read as
        // scribbles once a grazing wall stretched them.
        if (cover[(((y - 1) & MASK) << 6) | x] && mask[i]) buf[i] = C.ossSandShadow;
        else if (cover[(((y - 1) & MASK) << 6) | x]) buf[i] = C.ossSandDark;
        continue;
      }
      const below = cover[(((y + 1) & MASK) << 6) | x];
      const right = cover[(y << 6) | ((x + 1) & MASK)];
      let t = 0.62 + (fbmChunky(x, y, seed ^ 0x4b2) - 0.5) * 0.35;
      // Stains running down from the top.
      t -= vnoise(x, y & ~3, 4, seed ^ 0x8d) > 0.8 ? 0.2 : 0;
      if (!below) t -= 0.3; // plaster edge thickness, in shadow
      else if (!right) t -= 0.14;
      let c = rampPickFlat(PLASTER, t);
      // Faded ochre band: dithered away where the pigment wore off.
      if (y >= bandY && y < bandY + 4 && below && right) {
        const fade = fbmChunky(x + 9, y, seed ^ 0x0c4e);
        if (fade > 0.45) c = y === bandY || y === bandY + 3 ? C.ossSandMid : C.ossOchre;
        else if (fade > 0.38 && ((x + y) & 1) === 0) c = C.ossOchre;
      }
      buf[i] = c;
    }
  }
  // Hairline crazing across the plaster.
  for (let k = 0; k < 4; k++) {
    let x = rng.int(SIZE);
    let y = rng.int(SIZE);
    const dx = rng.chance(0.5) ? 1 : -1;
    for (let s = 0; s < 10 + rng.int(10); s++) {
      if (cover[((y & MASK) << 6) | (x & MASK)]) put(buf, x, y, C.ossPlasterShadow);
      if (rng.chance(0.6)) y++;
      else x += dx;
    }
  }
}

/**
 * Wall[2]: an arched burial niche cut into the masonry, bones on its sill.
 * @param {Uint8Array} buf
 * @param {number} seed
 * @param {Rng} rng
 */
function paintNiche(buf, seed, rng) {
  const w = 32 + rng.int(5);
  // The frame and sill reach 3 texels past the opening; keep all of it ≥ 4 texels inside the tile so
  // the niche never meets a tile edge.
  const x0 = 7 + rng.int(57 - w - 7 + 1);
  const spring = 25; // where the arch starts
  const peak = 17;
  const sill = 53; // first row of the sill
  const half = w / 2;
  /** @param {number} lx */
  const top = (lx) => {
    const u = (lx + 0.5 - half) / half;
    return spring - (spring - peak) * Math.sqrt(Math.max(0, 1 - u * u));
  };
  // Dressed frame: a two-texel ring of pale cut stone around the opening.
  for (let lx = -3; lx < w + 3; lx++) {
    for (let y = peak - 3; y < sill; y++) {
      const cl = Math.max(0, Math.min(w - 1, lx));
      if (lx >= 0 && lx < w && y >= top(lx)) continue;
      const dist = Math.max(lx < 0 ? -lx : lx >= w ? lx - w + 1 : 0, Math.ceil(top(cl) - y));
      if (dist > 3) continue;
      const lit = lx < half; // left half of the frame faces the light
      let t = 0.66 + (lit ? 0.08 : -0.04) + (fbmChunky(x0 + lx, y, seed ^ 0x2f) - 0.5) * 0.2;
      if (dist === 3) t -= 0.35; // groove around the frame
      else if (dist === 1) t += 0.12;
      put(buf, x0 + lx, y, rampPickFlat(SAND, t));
    }
  }
  // The recess.
  for (let lx = 0; lx < w; lx++) {
    const tp = top(lx);
    for (let y = Math.floor(tp); y < sill; y++) {
      if (y < tp) continue;
      const dl = lx;
      const dr = w - 1 - lx;
      const dt = y - tp;
      let c;
      if (dt < 3) c = dt < 1.5 ? C.ossSandShadow : C.ossEarthGap; // soffit in shadow
      else if (dr < 3) c = dr === 0 ? C.ossSandMid : C.ossSandDark; // right reveal catches light
      else if (dl < 2) c = C.ossSandShadow;
      else c = rampPickChunky(EARTH, 0.06 + fbmChunky(x0 + lx, y, seed ^ 0x611) * 0.3 + (y - peak) * 0.004, x0 + lx, y);
      put(buf, x0 + lx, y, c);
    }
  }
  // Sill: a projecting lip, lit on top, shadow beneath.
  for (let lx = -3; lx < w + 3; lx++) {
    put(buf, x0 + lx, sill, C.ossSandHilite);
    put(buf, x0 + lx, sill + 1, rampPickFlat(SAND, 0.68 + (h01((x0 + lx) & MASK, 1, seed) - 0.5) * 0.15));
    put(buf, x0 + lx, sill + 2, C.ossSandDeep);
    put(buf, x0 + lx, sill + 3, C.ossSandShadow);
  }
  // Contents: stacked long bones along the sill and a skull resting at one end.
  const skullLeft = rng.chance(0.5);
  const tone = 0.52;
  paintLongBone(buf, x0 + 3 + rng.int(3), sill - 3, w - 8 - rng.int(4), tone);
  paintLongBone(buf, x0 + 5 + rng.int(4), sill - 7, w - 14 - rng.int(5), tone - 0.06);
  paintLongBone(buf, x0 + (skullLeft ? 14 : 5), sill - 11, 12 + rng.int(5), tone - 0.12);
  paintSkull(buf, x0 + (skullLeft ? 8 : w - 9), sill - 15, tone - 0.04, false);
}

/** Wall[3]'s bone panel: columns `[BONE_X0, BONE_X1)`, dressed jambs included. */
const BONE_X0 = 6;
const BONE_X1 = 58;

/**
 * Wall[3]: the showpiece — a panel packed with long-bone ends around a row of three skulls, between
 * the top and bottom sandstone courses, framed by dressed stone jambs. The panel stops 6 texels short
 * of each tile edge so the shared masonry carries on into the neighbouring wall.
 * @param {Uint8Array} wall
 * @param {number} seed
 */
function paintBoneWall(wall, seed) {
  const Y0 = COURSES[0];
  const Y1 = COURSES[3];
  const buf = Uint8Array.from(wall); // paint the bones freely, then copy back only the panel's inside
  // Dark packed-earth recess behind the bones.
  for (let y = Y0; y < Y1; y++) {
    for (let x = 0; x < SIZE; x++) {
      put(buf, x, y, rampPickChunky(EARTH, fbmChunky(x, y, seed ^ 0x5e) * 0.22, x, y));
    }
  }
  const off = 0;
  /** @param {number} cy @param {number} phase @param {number} r */
  const endsRow = (cy, phase, r) => {
    for (let k = 0; k < 8; k++) {
      const cx = off + phase + k * 8 + (h01(k, cy, seed) < 0.3 ? 1 : 0);
      const tone = 0.42 + h01(k, cy, seed ^ 0x77) * 0.32;
      const roll = h01(k, cy, seed ^ 0x99);
      const kind = roll < 0.3 ? 1 : roll < 0.42 ? 2 : 0;
      paintBoneEnd(buf, cx, cy + (h01(cy, k, seed) < 0.25 ? 1 : 0), r, tone, kind);
    }
  };
  // Upper course: two staggered rows of knuckles.
  endsRow(Y0 + 4, 4, 3.6);
  endsRow(Y0 + 11, 8, 3.6);
  // Skull course, with small bone ends packed into the gaps.
  endsRow(Y0 + 18, 4, 2.6);
  endsRow(Y0 + 30, 4, 2.6);
  // A lintel of long bones laid lengthwise above and below the skulls.
  for (let k = 0; k < 4; k++) {
    paintLongBone(buf, off + k * 16 + 1, Y0 + 15, 15, 0.5 + h01(k, 3, seed) * 0.15);
    paintLongBone(buf, off + k * 16 + 9, Y0 + 33, 15, 0.46 + h01(k, 5, seed) * 0.15);
  }
  for (let k = 0; k < 3; k++) {
    const tone = 0.5 + h01(k, 21, seed) * 0.2;
    paintSkull(buf, off + (k + 1) * 16, Y0 + 23, tone, h01(k, 22, seed) < 0.5);
  }
  // Lower course: two staggered rows of knuckles.
  endsRow(Y0 + 38, 8, 3.6);
  endsRow(Y0 + 45, 4, 3.4);
  // Shadow under the top course's lip.
  for (let x = 0; x < SIZE; x++) if (h01(x, 7, seed) < 0.6) put(buf, x, Y0, C.ossEarthGap);
  for (let y = Y0; y < Y1; y++) {
    for (let x = BONE_X0 + 3; x < BONE_X1 - 3; x++) wall[(y << 6) | x] = buf[(y << 6) | x];
  }
  // Dressed jambs: a groove against the masonry, a lit face, then a shadowed reveal into the bones.
  for (let y = Y0; y < Y1; y++) {
    for (let j = 0; j < 3; j++) {
      const n = (fbmChunky(BONE_X0 + j, y, seed ^ 0x2f) - 0.5) * 0.2;
      const tl = j === 0 ? 0.3 : j === 1 ? 0.82 : 0.64;
      const tr = j === 0 ? 0.3 : j === 1 ? 0.6 : 0.42;
      put(wall, BONE_X0 + j, y, rampPickFlat(SAND, tl + n));
      put(wall, BONE_X1 - 1 - j, y, rampPickFlat(SAND, tr + (fbmChunky(BONE_X1 - 1 - j, y, seed ^ 0x2f) - 0.5) * 0.2));
    }
  }
}

/**
 * @param {number} seed variant seed
 * @param {number} edge seed shared by every wall variant
 * @param {number} kind 0 plain, 1 plaster, 2 niche, 3 bone wall
 * @returns {Uint8Array}
 */
function paintWall(seed, edge, kind) {
  const rng = createRng(seed);
  const buf = paintMasonry(seed, edge, rng, kind === 0 ? 0.18 : 0.3, kind === 0 ? 3 : 1);
  if (kind === 1) paintPlaster(buf, seed, rng);
  else if (kind === 2) paintNiche(buf, seed, rng);
  else if (kind === 3) paintBoneWall(buf, seed);
  return buf;
}

// ─── Floors ────────────────────────────────────────────────────────────────────────────────────

/** Flag row heights, summing to SIZE. */
const FLAG_ROWS = [22, 20, 22];

/**
 * A bone fragment lying on the floor: a short 2-texel-thick sliver in any of 4 directions.
 * @param {Uint8Array} buf
 * @param {Rng} rng
 * @param {number} x
 * @param {number} y
 */
function paintFragment(buf, rng, x, y) {
  const len = 3 + rng.int(4);
  const dir = rng.int(4); // 0 →, 1 ↓, 2 ↘, 3 ↗
  const sx = dir === 1 ? 0 : 1;
  const sy = dir === 0 ? 0 : dir === 3 ? -1 : 1;
  for (let k = 0; k < len; k++) {
    const px = x + sx * k;
    const py = y + sy * k;
    const knob = (k === 0 || k === len - 1) && rng.chance(0.5);
    put(buf, px, py, k === 0 ? C.ossBonePale : C.ossBoneLight);
    put(buf, px + (dir === 1 ? 1 : 0), py + (dir === 1 ? 0 : 1), C.ossBoneMid);
    put(buf, px + 1, py + 1 + (dir === 1 ? 0 : 1), C.ossEarthGap); // contact shadow
    if (knob) put(buf, px - (dir === 1 ? 1 : 0), py - (dir === 1 ? 0 : 1), C.ossBoneBase);
  }
}

/** Where the flag rows start: row 0 straddles the tile's top/bottom edge, rows 1–2 are interior. */
const FLAG_Y0 = SIZE - (FLAG_ROWS[0] >> 1);
/** Earth cover every floor variant shares along the tile edges (see {@link paintFloor}). */
const EDGE_EARTH = 0.42;
/** Scatter (pebbles, bone fragments) stays this far inside the tile. */
const SCATTER_MARGIN = 4;

/**
 * Cracked sandstone flags sunk in packed earth.
 *
 * Seamless across variants: the ground, the flag layout, and the full painting of every flag that
 * touches a tile edge come from the shared `edge` seed; the earth drift blends from a shared field
 * and cover ({@link EDGE_EARTH}) at the border to the variant's own over the outer 12 lines; pebbles
 * and bone fragments stay inside the tile. Interior flags, the interior drift and the scatter are
 * the variant's own.
 * @param {number} seed variant seed
 * @param {number} edge seed shared by every floor variant
 * @param {{earth:number, bones:number, pebbles:number}} opts `earth` 0..1 how much ground covers the flags
 * @returns {Uint8Array}
 */
function paintFloor(seed, edge, opts) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  const slab = new Uint8Array(AREA); // 1 = flag face texel

  // Ground everywhere first: packed dusty earth in flat mottled patches.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const n = fbmChunky(x, y, edge ^ 0xea7);
      const m = vnoise(x & ~3, y & ~3, 16, edge ^ 0x3131);
      // Flat, hard-edged patches (no dither): an ordered dither on a floor this dark read as a
      // checkerboard of two browns. Single-texel grit gives it the granular read instead.
      let t = 0.4 + (n - 0.5) * 0.6 + (m - 0.5) * 0.35;
      const g = h01(x, y, edge ^ 0x6e17);
      if (g < 0.05) t -= 0.2;
      else if (g > 0.97) t += 0.2;
      buf[(y << 6) | x] = rampPickFlat(EARTH, t);
    }
  }

  // Flags: rows of irregular slabs, each row with its own offset; the layout wraps both ways.
  const layout = createRng(edge ^ 0xf1a6);
  let y0 = FLAG_Y0;
  for (let r = 0; r < FLAG_ROWS.length; r++) {
    const bh = FLAG_ROWS[r];
    let x = layout.int(SIZE);
    let remaining = SIZE;
    for (let k = 0; remaining > 0; k++) {
      let bw = remaining <= 34 ? remaining : 16 + layout.int(14);
      if (remaining - bw > 0 && remaining - bw < 14) bw = remaining - 14;
      const shared = touchesEdge(x, bw) || touchesEdge(y0, bh);
      const ss = shared ? edge : seed;
      const srng = blockRng(ss, r, k);
      const fw = bw - 2;
      const fh = bh - 2 - srng.int(2);
      const baseT = 0.42 + srng.range(-0.14, 0.14);
      const chipA = srng.int(4);
      const chipB = srng.int(4);
      for (let yy = 0; yy < fh; yy++) {
        for (let xx = 0; xx < fw; xx++) {
          if (xx + yy < chipA || fw - 1 - xx + (fh - 1 - yy) < chipB) continue;
          const gx = x + xx;
          const gy = y0 + yy;
          let t = baseT + (fbmChunky(gx, gy, ss) - 0.5) * 0.28;
          if (yy === 0 || xx === 0) t += 0.16;
          if (yy === fh - 1 || xx === fw - 1) t -= 0.2;
          put(buf, gx, gy, rampPickFlat(SAND, t));
          slab[((gy & MASK) << 6) | (gx & MASK)] = 1;
        }
      }
      // A crack across the slab.
      if (srng.chance(0.55)) {
        let cx = srng.int(fw);
        let cy = 0;
        const drift = srng.chance(0.5) ? 1 : -1;
        while (cy < fh && cx >= 0 && cx < fw) {
          put(buf, x + cx, y0 + cy, C.ossEarthShadow);
          if (srng.chance(0.3)) put(buf, x + cx + 1, y0 + cy, C.ossSandDeep);
          cy++;
          if (srng.chance(0.45)) cx += drift;
        }
      }
      x += bw;
      remaining -= bw;
    }
    y0 += bh;
  }

  // Earth drifts over the flags: where the drift noise is high, the ground covers the stone. Near the
  // tile edges both the drift field and its threshold ease to the shared ones.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      if (!slab[i]) continue;
      const w = Math.max(0, Math.min(1, (Math.min(edgeDist(x), edgeDist(y)) - 2) / 10));
      const ds = 0.7 * vnoise(x & ~1, y & ~1, 32, edge ^ 0xd21f) + 0.3 * vnoise(x & ~1, y & ~1, 8, edge ^ 0x77);
      const dv = w > 0 ? 0.7 * vnoise(x & ~1, y & ~1, 32, seed ^ 0xd21f) + 0.3 * vnoise(x & ~1, y & ~1, 8, seed ^ 0x77) : 0;
      const d = ds + (dv - ds) * w;
      const thresh = 1 - (EDGE_EARTH + (opts.earth - EDGE_EARTH) * w);
      if (d > thresh) {
        slab[i] = 0;
        buf[i] = rampPickFlat(EARTH, 0.5 + (fbmChunky(x, y, edge ^ 0x19) - 0.5) * 0.5 + (h01(x, y, edge ^ 0x6e17) < 0.05 ? -0.2 : 0));
      } else if (d > thresh - 0.04) {
        buf[i] = rampPickFlat(EARTH, h01(x, y, edge ^ 0xd05) < 0.5 ? 0.8 : 1); // dust on the stone at the drift's edge
      }
    }
  }

  // Pebbles.
  const span = SIZE - 2 * SCATTER_MARGIN;
  for (let i = 0; i < opts.pebbles; i++) {
    const x = SCATTER_MARGIN + rng.int(span - 1);
    const y = SCATTER_MARGIN + rng.int(span - 1);
    put(buf, x, y, C.ossSandLight);
    put(buf, x + 1, y, C.ossSandMid);
    put(buf, x, y + 1, C.ossSandDark);
    put(buf, x + 1, y + 1, C.ossEarthGap);
  }
  // Bone fragments scattered over everything (a fragment reaches 8 texels right, 6 up and 8 down).
  for (let i = 0; i < opts.bones; i++) {
    paintFragment(buf, rng, SCATTER_MARGIN + rng.int(span - 8), SCATTER_MARGIN + 6 + rng.int(span - 14));
  }
  return buf;
}

/**
 * Floor[2]: a carved limestone grave slab set into the flags. It fills the two interior flag rows
 * and stops 10 texels short of the side edges, so the shared edge flags ring it on every side.
 * @param {number} seed
 * @param {number} edge seed shared by every floor variant
 * @returns {Uint8Array}
 */
function paintGraveSlab(seed, edge) {
  const buf = paintFloor(seed ^ 0x6a7e, edge, { earth: 0.35, bones: 3, pebbles: 4 });
  const rng = createRng(seed ^ 0x51ab);
  const X0 = 12;
  const Y0 = FLAG_Y0 + FLAG_ROWS[0] - SIZE + 1; // 12: the bedding gap (rows 10–53) takes the two interior flag rows
  // Even sizes: the cross's groove walls are found at half-texel offsets from the centre.
  const W = 40;
  const H = 40;
  // Dark bedding gap around the slab.
  for (let y = -2; y < H + 2; y++) {
    for (let x = -2; x < W + 2; x++) {
      if (x >= 0 && x < W && y >= 0 && y < H) continue;
      put(buf, X0 + x, Y0 + y, x >= W || y >= H ? C.ossEarthGap : C.ossEarthShadow);
    }
  }
  const cxm = W / 2;
  const cym = H / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = X0 + x;
      const gy = Y0 + y;
      let t = 0.6 + (fbmChunky(gx, gy, seed ^ 0x4e) - 0.5) * 0.3;
      if (x === 0 || y === 0) t += 0.25;
      else if (x === W - 1 || y === H - 1) t -= 0.35;
      else if (x === W - 2 || y === H - 2) t -= 0.15;
      // Inset carved border groove, 4 texels in: shadowed on its top/left wall, lit on bottom/right.
      const bx = Math.min(x, W - 1 - x);
      const by = Math.min(y, H - 1 - y);
      const b = Math.min(bx, by);
      if (b === 4) t = (x < cxm && bx === 4) || (y < cym && by === 4) ? 0.08 : 0.2;
      else if (b === 5) t = (x >= cxm && bx === 5) || (y >= cym && by === 5) ? 0.9 : t - 0.15;
      // Carved cross: a groove with a lit lower-right wall.
      const ax = Math.abs(x + 0.5 - cxm);
      const ay = Math.abs(y + 0.5 - cym);
      const inV = ax < 3 && ay < 12;
      const inH = ay < 3 && ax < 9;
      if (inV || inH) {
        const edgeTL = (inV && x + 0.5 - cxm < -2) || (inH && !inV && y + 0.5 - cym < -2) || (inV && !inH && y + 0.5 - cym < -11);
        const edgeBR = (inV && x + 0.5 - cxm > 2) || (inH && !inV && y + 0.5 - cym > 2) || (inV && !inH && y + 0.5 - cym > 11);
        t = edgeTL ? 0.05 : edgeBR ? 0.85 : 0.3;
      }
      put(buf, gx, gy, rampPickFlat(PLASTER, t));
    }
  }
  // A crack across one corner, and dust gathered in the carved grooves.
  let cx = rng.int(12);
  for (let y = 0; y < 20 && cx < W; y++) {
    put(buf, X0 + W - 1 - cx, Y0 + H - 1 - y, C.ossPlasterShadow);
    if (rng.chance(0.5)) cx++;
  }
  for (let i = 0; i < 20; i++) {
    const x = 5 + rng.int(W - 10);
    const y = rng.chance(0.5) ? 4 : H - 5;
    put(buf, X0 + x, Y0 + y, C.ossEarthMid);
  }
  paintFragment(buf, rng, X0 + 7 + rng.int(5), Y0 + 28 + rng.int(3));
  return buf;
}

// ─── Ceiling ───────────────────────────────────────────────────────────────────────────────────

const ROCK_CELLS = 4;
const ROCK_SPAN = SIZE / ROCK_CELLS;

/**
 * Low rough-hewn rock: toroidal Voronoi facets, each a tilted plane, with chisel marks.
 *
 * Seamless across variants: the facet sites come from the shared `edge` seed, and so does the whole
 * shading (tilt, tone, chisel, grain) of the facets in the top and bottom rows of sites — the ones
 * that reach rows 0 and 63. The two middle rows of facets take the variant's seed.
 * @param {number} seed variant seed
 * @param {number} edge seed shared by both ceiling variants
 * @returns {Uint8Array}
 */
function paintRock(seed, edge) {
  const buf = new Uint8Array(AREA);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let d1 = 1e9;
      let d2 = 1e9;
      let id = 0;
      let fx = 0;
      let fy = 0;
      const cx0 = Math.floor(x / ROCK_SPAN);
      const cy0 = Math.floor(y / ROCK_SPAN);
      for (let gy = cy0 - 1; gy <= cy0 + 1; gy++) {
        for (let gx = cx0 - 1; gx <= cx0 + 1; gx++) {
          const wx = gx & (ROCK_CELLS - 1);
          const wy = gy & (ROCK_CELLS - 1);
          const jx = (gx + 0.1 + 0.8 * h01(wx, wy, edge)) * ROCK_SPAN;
          const jy = (gy + 0.1 + 0.8 * h01(wx, wy, edge ^ 0x2468)) * ROCK_SPAN;
          const dx = x - jx;
          const dy = y - jy;
          const d = dx * dx + dy * dy;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            id = (wy << 2) | wx;
            fx = dx;
            fy = dy;
          } else if (d < d2) d2 = d;
        }
      }
      const crease = Math.sqrt(d2) - Math.sqrt(d1);
      const wy = id >> 2;
      const fs = wy === 0 || wy === ROCK_CELLS - 1 ? edge : seed;
      const ang = h01(id, 7, fs ^ 0xacc) * Math.PI * 2;
      const tone = 0.3 + h01(id, 9, fs ^ 0xb0b) * 0.16;
      let t = tone + (fx * Math.cos(ang) + fy * Math.sin(ang)) * 0.012 + (fbmChunky(x, y, fs ^ 0x3c) - 0.5) * 0.14;
      // Chisel marks: parallel diagonal grooves per facet.
      const dir = id & 1 ? x + y : x - y;
      if (((dir + id * 3) & 7) === 0 && h01(x >> 2, y >> 2, fs ^ id) < 0.55) t -= 0.12;
      if (crease < 1.2) t -= 0.22; // crease between facets
      else if (crease < 2.4) t += 0.1; // lit arris
      buf[(y << 6) | x] = rampPickFlat(SAND, t);
    }
  }
  return buf;
}

/**
 * Rock with a heavy timber lintel across it (rows 23–39, well inside the tile).
 * @param {number} seed variant seed
 * @param {number} edge seed shared by both ceiling variants
 * @returns {Uint8Array}
 */
function paintLintel(seed, edge) {
  const buf = paintRock(seed, edge);
  const by = 24;
  const bh = 14;
  const wood = RAMPS.wood;
  for (let y = by; y < by + bh; y++) {
    const e = y - by;
    for (let x = 0; x < SIZE; x++) {
      const grain = vnoise(x & ~1, (y & ~1) * 5, 16, seed ^ 0x8e1) * 0.7 + vnoise(x, y * 6, 8, seed ^ 0x2e) * 0.3;
      let t = 0.46 + (grain - 0.5) * 0.35;
      if (e === 0) t += 0.36;
      else if (e === 1) t += 0.18;
      else if (e >= bh - 2) t -= 0.28;
      buf[(y << 6) | x] = rampPickFlat(wood, t);
    }
  }
  // Seasoning checks along the grain.
  const rng = createRng(seed ^ 0x11);
  for (let k = 0; k < 3; k++) {
    const x = rng.int(SIZE);
    const y = by + 4 + rng.int(bh - 7);
    const len = 8 + rng.int(14);
    for (let i = 0; i < len; i++) put(buf, x + i, y + (i > len / 2 ? 1 : 0), C.woodShadow);
  }
  // Iron pegs.
  for (let k = 0; k < 2; k++) {
    const x = 12 + k * 32;
    put(buf, x, by + 6, C.ironHilite);
    put(buf, x + 1, by + 6, C.ironLight);
    put(buf, x, by + 7, C.ironBase);
    put(buf, x + 1, by + 7, C.ironShadow);
  }
  // Shadow where the lintel meets the rock.
  for (let x = 0; x < SIZE; x++) {
    put(buf, x, by - 1, C.ossSandShadow);
    put(buf, x, by + bh, C.ossSandShadow);
    put(buf, x, by + bh + 1, h01(x, 0, seed) < 0.5 ? C.ossSandShadow : C.ossSandMortar);
  }
  return buf;
}

/** @type {import('./index.js').TilesetDef} */
export const TILESET = Object.freeze({
  id: 'ossuary',
  name: 'Ossuary',
  fog: 'ossFog',
  paint(seedOf) {
    const wallEdge = seedOf('wallEdge');
    const floorEdge = seedOf('floorEdge');
    const ceilEdge = seedOf('ceilEdge');
    return {
      wall: [
        paintWall(seedOf('wall0'), wallEdge, 0),
        paintWall(seedOf('wall1'), wallEdge, 1),
        paintWall(seedOf('wall2'), wallEdge, 2),
        paintWall(seedOf('wall3'), wallEdge, 3),
      ],
      floor: [
        paintFloor(seedOf('floor0'), floorEdge, { earth: 0.3, bones: 4, pebbles: 8 }),
        paintFloor(seedOf('floor1'), floorEdge, { earth: 0.62, bones: 7, pebbles: 12 }),
        paintGraveSlab(seedOf('floor2'), floorEdge),
      ],
      ceiling: [paintRock(seedOf('ceil0'), ceilEdge), paintLintel(seedOf('ceil1'), ceilEdge)],
    };
  },
});
