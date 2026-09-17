// @ts-check
/**
 * @file Infernal Forge tileset — a dwarven forge at the roots of the world.
 *
 * - **Walls** — black basalt blocks with conchoidal obsidian facets and cool grey bevels, thin
 *   magma veins glowing in a few joints; a cracked variant whose cracks carry lava; riveted
 *   soot-black iron plates set into the basalt courses; and, rarely, an iron furnace mouth with a
 *   barred, glowing interior. Every variant keeps the Old Keep's course rows, so bed joints run
 *   unbroken along a corridor and none of them lands on eye-level row 32.
 * - **Floor** — cracked basalt slabs with hairline lava seams; the same slabs with a riveted iron
 *   plate let into one; rarely an iron grate over a pit of magma, set where two slabs would be.
 * - **Ceiling** — soot-blackened stone with an iron pipe; the band variant is a riveted iron girder
 *   with a chain slung beneath it.
 *
 * Seams: the raycaster puts any variant beside any other, so everything touching a tile edge comes
 * from one shared seed (`seedOf('edge')`): the wall bond (`wallLayout`) and the block straddling
 * each course's left/right edge, the floor slab layout (`slabLayout`) and every slab touching the
 * border, and the ceiling's first and last courses. Variants differ only inside that frame, and
 * their decor (veins, lava cracks, plates, furnace, grate) never reaches the edge.
 *
 * Glow texels (the `forLava*` ramp) stay a thin fraction of every surface but the rare grate and
 * furnace, so they read as light leaking through rock rather than as a lit wall.
 *
 * Node-safe: no DOM access.
 */

import { createRng } from '../../core/rng.js';
import { C, ramp } from '../palette.js';
import { SIZE, MASK, AREA, put, rampPickChunky, rampPickFlat, h01, vnoise, fbmChunky } from '../textures.js';

/** @typedef {import('../../core/rng.js').Rng} Rng */

const BAS = ramp(
  'forBasShadow',
  'forBasJoint',
  'forBasDeep',
  'forBasDark',
  'forBasMid',
  'forBasBase',
  'forBasLight',
  'forBasBright',
  'forBasHilite',
);
const IRON = ramp('forIronShadow', 'forIronDark', 'forIronBase', 'forIronMid', 'forIronLight', 'forIronHilite');
const LAVA = ramp('forLavaDeep', 'forLavaRed', 'forLavaOrange', 'forLavaHot', 'forLavaCore');
const HEAT = ramp('forScorchDark', 'forScorch', 'forEmber');

/** Same course table as the Old Keep: joints at rows 21–23, 37–39, 53–55, 5–7; row 32 is a face. */
const COURSE_PHASE = 8;
const COURSE_H = 16;
const MORTAR = 3;

// ─── Shared helpers ────────────────────────────────────────────────────────────────────────────

/**
 * A glowing magma texel: mostly red, some orange, the odd hot speck, chosen by hash so it is
 * deterministic and not a dither pattern.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @param {number} heat 0..1 bias toward the hot end
 * @returns {number}
 */
function lavaAt(x, y, seed, heat) {
  const r = h01(x & MASK, y & MASK, seed) + heat * 0.5;
  return r < 0.18 ? C.forLavaDeep : r < 0.72 ? C.forLavaRed : r < 1.02 ? C.forLavaOrange : r < 1.3 ? C.forLavaHot : C.forLavaCore;
}

/**
 * A hairline crack as a biased random walk. `lava` makes the core self-lit with a scorched rim.
 * @param {Uint8Array} buf
 * @param {number} x0
 * @param {number} y0
 * @param {number} len
 * @param {boolean} vertical main direction (else horizontal)
 * @param {boolean} lava
 * @param {number} seed
 * @param {Rng} rng
 * @param {(x:number, y:number) => boolean} [inside] clip test in texture coordinates
 * @returns {void}
 */
function crack(buf, x0, y0, len, vertical, lava, seed, rng, inside) {
  let x = x0;
  let y = y0;
  const drift = rng.chance(0.5) ? 1 : -1;
  for (let i = 0; i < len; i++) {
    if (inside && !inside(x, y)) break;
    const heat = lava ? 0.5 - Math.abs(i / len - 0.5) : 0; // hottest mid-crack, cooling to the tips
    if (lava) {
      put(buf, x, y, i < 2 || i >= len - 2 ? C.forEmber : lavaAt(x, y, seed, heat));
      // Scorched rim on one side: the rock the heat leaks into.
      const rx = vertical ? x + drift : x;
      const ry = vertical ? y : y - 1;
      if (!inside || inside(rx, ry)) put(buf, rx, ry, rng.chance(0.6) ? C.forScorch : C.forScorchDark);
    } else {
      put(buf, x, y, rng.chance(0.7) ? C.forBasDeep : C.forBasJoint);
    }
    if (vertical) {
      y += 1;
      if (rng.chance(0.42)) x += drift;
      else if (rng.chance(0.14)) x -= drift;
    } else {
      x += 1;
      if (rng.chance(0.38)) y += drift;
      else if (rng.chance(0.14)) y -= drift;
    }
  }
}

/**
 * A 2×2 dome rivet: lit top-left, shadowed bottom-right.
 * @param {Uint8Array} buf
 * @param {number} x
 * @param {number} y
 * @returns {void}
 */
function rivet(buf, x, y) {
  put(buf, x, y, C.forIronHilite);
  put(buf, x + 1, y, C.forIronLight);
  put(buf, x, y + 1, C.forIronMid);
  put(buf, x + 1, y + 1, C.forIronShadow);
}

// ─── Walls ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Paint one basalt block face: per-block tone, an obsidian facet split, cool bevel, grain, glints.
 * @param {Uint8Array} buf
 * @param {Uint8Array} mask 1 = mortar; cleared on face texels
 * @param {number} bx
 * @param {number} by
 * @param {number} bw cell width including mortar
 * @param {number} bh cell height including mortar
 * @param {number} seed
 * @param {Rng} rng
 * @returns {void}
 */
function basaltBlock(buf, mask, bx, by, bw, bh, seed, rng) {
  const fw = bw - MORTAR;
  const fh = bh - MORTAR;
  // Darker than the Keep's stone; the facet plane and the bevel carry the light instead.
  const baseT = 0.4 + rng.range(-0.12, 0.12);
  const bevel = rng.range(0.6, 1.2);
  // Conchoidal fracture: a straight facet line across the face, one side a ramp step apart.
  const ang = rng.range(0, Math.PI);
  const nx = Math.cos(ang);
  const ny = Math.sin(ang) * 2.2; // steeper in y: the face is landscape
  const cx = rng.range(fw * 0.25, fw * 0.75);
  const cy = rng.range(fh * 0.25, fh * 0.75);
  const facet = 0.2;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const gx = bx + x;
      const gy = by + y;
      let t = baseT + (fbmChunky(gx, gy, seed) - 0.5) * 0.34;
      const d = (x - cx) * nx + (y - cy) * ny;
      if (d > 0) t += facet;
      // A crisp glassy ridge where the lit fracture plane breaks away.
      if (d > 0 && d < 1.2 && x > 1 && y > 1 && x < fw - 2 && y < fh - 2) t += 0.24;
      if (y === 0 || x === 0) t += 0.3 * bevel;
      else if (y === 1 || x === 1) t += 0.14 * bevel;
      if (y >= fh - 2 || x >= fw - 2) t -= 0.16;
      if (y === fh - 1 || x === fw - 1) t -= 0.12;
      put(buf, gx, gy, rampPickFlat(BAS, t));
      mask[((gy & MASK) << 6) | (gx & MASK)] = 0;
    }
  }
  // Grain: dark pits, one step down, off the bevel rows.
  const pits = 6 + rng.int(6);
  for (let i = 0; i < pits; i++) {
    const at = (((by + 2 + rng.int(fh - 4)) & MASK) << 6) | ((bx + 2 + rng.int(fw - 5)) & MASK);
    const step = BAS.indexOf(buf[at]);
    if (step > 3) buf[at] = BAS[step - 1];
  }
  // Obsidian glints: a bright texel with a softer diagonal neighbour.
  const glints = rng.chance(0.3) ? 1 : 0;
  for (let i = 0; i < glints; i++) {
    const gx = bx + 3 + rng.int(fw - 6);
    const gy = by + 3 + rng.int(fh - 6);
    put(buf, gx, gy, C.forBasHilite);
    put(buf, gx + 1, gy + 1, C.forBasBright);
  }
}

/**
 * @typedef {Object} WallCourse
 * @property {number} y0     first row of the course (its bed joint is the last `MORTAR` rows)
 * @property {number} left   columns `0..left-1` belong to the edge block (its head joint at the end)
 * @property {number} right  columns `SIZE-right..SIZE-1` belong to the edge block
 * @property {Array<[number, number]>} inner  interior cells as [x, w], all inside `left..SIZE-right`
 */

/**
 * Minimum circular distance between two columns.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function colDist(a, b) {
  const d = Math.abs(a - b) & MASK;
  return Math.min(d, SIZE - d);
}

/**
 * The bond every wall variant shares, drawn from the tileset's edge seed. Each course has one block
 * straddling the tile's left/right edge and two interior blocks between; head joints of adjacent
 * courses stay at least 5 columns apart. Because every variant lays this same bond and paints the
 * straddling block from the same seed, any variant meets any other at a tile seam; variants differ
 * only in the interior blocks and what is set into them.
 * @param {number} edgeSeed
 * @returns {WallCourse[]}
 */
function wallLayout(edgeSeed) {
  const rng = createRng(edgeSeed ^ 0x1a70);
  /** @type {WallCourse[]} */
  const courses = [];
  /** @type {number[]|null} */
  let prev = null;
  for (let r = 0; r < 4; r++) {
    for (let tries = 0; ; tries++) {
      const right = 7 + rng.int(7);
      const left = 7 + rng.int(7);
      const span = SIZE - left - right;
      const w1 = (span >> 1) + rng.int(7) - 3;
      const joints = [left, left + w1, SIZE - right]; // first column after each head joint
      if (prev && tries < 40 && joints.some((j) => /** @type {number[]} */ (prev).some((p) => colDist(p, j) < 5))) continue;
      prev = joints;
      courses.push({ y0: COURSE_PHASE + r * COURSE_H, left, right, inner: [[left, w1], [left + w1, span - w1]] });
      break;
    }
  }
  return courses;
}

/**
 * Deterministic stream for one shared block, independent of how much any variant drew before it.
 * @param {number} edgeSeed
 * @param {number} k
 * @returns {Rng}
 */
function blockRng(edgeSeed, k) {
  return createRng((edgeSeed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0);
}

/**
 * Lay the basalt bond: a joint bed then the shared courses. The edge blocks (and the joint bed) are
 * painted from `edgeSeed` so they are identical in every variant; interior blocks from `seed`/`rng`.
 * Cracks are clipped to their block's face, so nothing spills into a neighbour or across the seam.
 * @param {Uint8Array} buf
 * @param {Uint8Array} mask
 * @param {WallCourse[]} layout
 * @param {number} edgeSeed
 * @param {number} seed
 * @param {Rng} rng
 * @param {number} [cracks] chance per interior block of a plain hairline crack
 * @param {number} [lavaCracks] chance per interior block of a lava-filled crack
 * @returns {void}
 */
function basaltWall(buf, mask, layout, edgeSeed, seed, rng, cracks = 0.2, lavaCracks = 0) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const n = fbmChunky(x, y, edgeSeed ^ 0x51a7);
      buf[(y << 6) | x] = rampPickChunky(BAS, 0.01 + n * 0.16, x, y);
      mask[(y << 6) | x] = 1;
    }
  }
  const fh = COURSE_H - MORTAR;
  for (let r = 0; r < layout.length; r++) {
    const c = layout[r];
    const y0 = c.y0;
    /** @type {(bx:number, fw:number) => (px:number, py:number) => boolean} */
    const faceOf = (bx, fw) => (px, py) => py < y0 + fh && ((px - bx) & MASK) < fw;
    // The straddling block, shared: same tone, facet, grain, glint and crack in every variant.
    const ex = SIZE - c.right;
    const ew = c.left + c.right;
    const erng = blockRng(edgeSeed, r);
    basaltBlock(buf, mask, ex, y0, ew, COURSE_H, edgeSeed, erng);
    if (erng.chance(0.18)) crack(buf, ex + 2 + erng.int(ew - MORTAR - 4), y0, 5 + erng.int(fh), true, false, edgeSeed, erng, faceOf(ex, ew - MORTAR));
    for (const [x, bw] of c.inner) {
      basaltBlock(buf, mask, x, y0, bw, COURSE_H, seed, rng);
      const fw = bw - MORTAR;
      if (rng.chance(lavaCracks)) {
        crack(buf, x + 3 + rng.int(fw - 6), y0, fh, true, true, seed ^ 0x1a7a, rng, faceOf(x, fw));
      } else if (rng.chance(cracks)) {
        crack(buf, x + 2 + rng.int(fw - 4), y0, 5 + rng.int(fh), true, false, seed, rng, faceOf(x, fw));
      }
    }
  }
}

/** Columns decor may touch on a wall: clear of the shared edge blocks' outer texels. */
const DECOR_MIN = 4;
const DECOR_MAX = SIZE - 5;

/**
 * Magma leaking through bed joints: 1-texel glowing seams along the middle row of a joint, tapering
 * to cooled ember, with the block edge above it heat-stained. Kept inside `DECOR_MIN..DECOR_MAX` so
 * the glow never reaches a tile seam, where the neighbouring variant would cut it off.
 * @param {Uint8Array} buf
 * @param {Uint8Array} mask
 * @param {number} count seams
 * @param {number} seed
 * @param {Rng} rng
 * @returns {void}
 */
function jointVeins(buf, mask, count, seed, rng) {
  for (let v = 0; v < count; v++) {
    const course = rng.int(4);
    const row = COURSE_PHASE + course * COURSE_H + COURSE_H - 2; // middle of the joint
    const len = 14 + rng.int(16);
    const sx = DECOR_MIN + 1 + rng.int(DECOR_MAX - DECOR_MIN - len - 1);
    let rose = false;
    for (let k = 0; k < len; k++) {
      const x = sx + k;
      if (mask[((row & MASK) << 6) | (x & MASK)] !== 1) continue;
      const tip = k < 2 || k >= len - 2;
      put(buf, x, row, tip ? C.forEmber : lavaAt(x, row, seed ^ 0x3e1, 0.25 - Math.abs(k / len - 0.5) * 0.5));
      if (!tip) {
        if (mask[(((row + 1) & MASK) << 6) | (x & MASK)] === 1) put(buf, x, row + 1, C.forScorchDark);
        if (mask[(((row - 1) & MASK) << 6) | (x & MASK)] === 1) put(buf, x, row - 1, C.forScorch);
        // Heat on the bottom lip of the block above: one continuous stain, a darker tail at each end
        // (a per-texel coin flip here read as a row of teeth up close).
        if (mask[(((row - 2) & MASK) << 6) | (x & MASK)] === 0) put(buf, x, row - 2, k < 4 || k >= len - 4 ? C.forScorchDark : C.forScorch);
        // Where the seam meets a head joint, let it climb: veins branch, they do not stop dead.
        const up = row - 6;
        if (!rose && k > 3 && k < len - 4 && mask[((up & MASK) << 6) | (x & MASK)] === 1 && mask[((up & MASK) << 6) | ((x - 1) & MASK)] === 1) {
          rose = true;
          const climb = 5 + rng.int(7);
          for (let j = 1; j <= climb; j++) {
            const yy = row - 1 - j;
            if (mask[((yy & MASK) << 6) | (x & MASK)] !== 1) break;
            put(buf, x, yy, j >= climb - 1 ? C.forEmber : lavaAt(x, yy, seed ^ 0x3e2, 0.1));
            if (mask[((yy & MASK) << 6) | ((x + 1) & MASK)] === 1) put(buf, x + 1, yy, C.forScorchDark);
          }
        }
      }
    }
  }
}

/**
 * Riveted soot-black iron plate spanning one course cell.
 * @param {Uint8Array} buf
 * @param {number} bx
 * @param {number} by
 * @param {number} bw
 * @param {number} bh
 * @param {number} seed
 * @param {Rng} rng
 * @returns {void}
 */
function ironPlate(buf, bx, by, bw, bh, seed, rng) {
  const fw = bw - MORTAR;
  const fh = bh - MORTAR;
  const tone = 0.42 + rng.range(-0.1, 0.1);
  const heatRow = rng.chance(0.5) ? fh - 4 - rng.int(3) : 99; // heat-blued/scorched lower band
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const gx = bx + x;
      const gy = by + y;
      // Soot streaks run down the plate: per-column hash plus slow vertical noise.
      const streak = h01((gx & MASK) >> 1, 7, seed) * 0.6 + vnoise(gx & MASK, gy & MASK, 16, seed ^ 0x5007) * 0.4;
      let t = tone + (streak - 0.5) * 0.3;
      if (y === 0 || x === 0) t += 0.32;
      else if (y === 1 || x === 1) t += 0.12;
      if (y === fh - 1 || x === fw - 1) t -= 0.3;
      put(buf, gx, gy, rampPickFlat(IRON, t));
      if (y >= heatRow && x > 1 && x < fw - 1 && y < fh - 1 && h01(gx & MASK, gy & MASK, seed ^ 0xbeef) < 0.55) {
        put(buf, gx, gy, y === fh - 2 ? C.forScorchDark : C.forScorch);
      }
    }
  }
  // Rivets along top and bottom edges.
  const pitch = 7;
  const n = Math.max(2, Math.floor((fw - 4) / pitch) + 1);
  const span = fw - 6;
  for (let i = 0; i < n; i++) {
    const rx = bx + 2 + Math.round((span * i) / (n - 1));
    rivet(buf, rx, by + 2);
    rivet(buf, rx, by + fh - 4);
  }
}

/**
 * @param {WallCourse[]} layout
 * @param {number} edgeSeed
 * @param {number} seed
 * @param {{veins:number, cracks:number, lavaCracks:number}} opts
 * @returns {Uint8Array}
 */
function paintBasaltWall(layout, edgeSeed, seed, opts) {
  const buf = new Uint8Array(AREA);
  const mask = new Uint8Array(AREA);
  const rng = createRng(seed);
  basaltWall(buf, mask, layout, edgeSeed, seed, rng, opts.cracks, opts.lavaCracks);
  jointVeins(buf, mask, opts.veins, seed, rng);
  return buf;
}

/**
 * Iron plates in the interior cells of the three middle courses, framed at the tile's edges by the
 * shared basalt edge blocks; the course that wraps top/bottom stays basalt (plinth and lintel).
 * @param {WallCourse[]} layout
 * @param {number} edgeSeed
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintIronWall(layout, edgeSeed, seed) {
  const buf = new Uint8Array(AREA);
  const mask = new Uint8Array(AREA);
  const rng = createRng(seed);
  basaltWall(buf, mask, layout, edgeSeed, seed, rng, 0.25, 0);
  // Plate courses start at rows 8, 24, 40; the course from 56 stays basalt.
  for (let r = 0; r < 3; r++) {
    const c = layout[r];
    const y0 = c.y0;
    for (const [x, bw] of c.inner) {
      // Seam gaps: iron-dark rather than basalt, so the plates read as one armoured band.
      for (let y = y0; y < y0 + COURSE_H; y++) {
        for (let k = 0; k < bw; k++) {
          const gap = y - y0 >= COURSE_H - MORTAR || k >= bw - MORTAR;
          if (gap) put(buf, x + k, y, y - y0 === COURSE_H - MORTAR || k === bw - MORTAR ? C.forIronShadow : C.forIronDark);
        }
      }
      ironPlate(buf, x, y0, bw, COURSE_H, seed, rng);
    }
  }
  // A seam of magma glowing through one plate joint.
  const c = layout[rng.int(3)];
  const row = c.y0 + COURSE_H - 2;
  const sx = c.left + 2 + rng.int(Math.max(1, SIZE - c.left - c.right - 14));
  for (let k = 0; k < 10; k++) put(buf, sx + k, row, k < 2 || k > 7 ? C.forEmber : lavaAt(sx + k, row, seed, 0.1));
  return buf;
}

/**
 * The showpiece: an iron-framed, arched furnace mouth with a barred glowing interior, set between
 * the shared edge blocks so it never reaches a tile seam.
 * @param {WallCourse[]} layout
 * @param {number} edgeSeed
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintFurnaceWall(layout, edgeSeed, seed) {
  const buf = new Uint8Array(AREA);
  const mask = new Uint8Array(AREA);
  const rng = createRng(seed);
  basaltWall(buf, mask, layout, edgeSeed, seed, rng, 0.2, 0);
  jointVeins(buf, mask, 1, seed, rng);

  const x0 = 7 + rng.int(15); // frame spans x0..x0+35, inside 7..56
  const W = 36; // frame width
  const top = 14;
  const bottom = 58;
  const archR = W / 2;
  const acx = W / 2 - 0.5;
  const acy = top + archR;
  // Frame: iron, arched top.
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < W; x++) {
      if (y < acy) {
        const dx = x - acx;
        const dy = y - acy;
        if (dx * dx + dy * dy > archR * archR) continue;
      }
      const n = vnoise((x0 + x) & MASK, y, 8, seed ^ 0xf00d);
      put(buf, x0 + x, y, rampPickFlat(IRON, 0.4 + (n - 0.5) * 0.3 + (x < 2 ? 0.25 : x >= W - 2 ? -0.25 : 0)));
    }
  }
  // Arch rim bevel: light on the upper-left of the curve, dark on the right.
  for (let a = 0; a < 64; a++) {
    const th = Math.PI + (a / 63) * Math.PI;
    const px = Math.round(acx + Math.cos(th) * (archR - 0.5));
    const py = Math.round(acy + Math.sin(th) * (archR - 0.5));
    put(buf, x0 + px, py, a < 34 ? C.forIronHilite : C.forIronShadow);
  }
  // Opening.
  const ix0 = 6;
  const iw = W - 12;
  const itop = top + 7;
  const ibot = bottom - 7;
  const ir = iw / 2;
  const icx = ix0 + ir - 0.5;
  const icy = itop + ir;
  for (let y = itop; y < ibot; y++) {
    for (let x = ix0; x < ix0 + iw; x++) {
      if (y < icy) {
        const dx = x - icx;
        const dy = y - icy;
        if (dx * dx + dy * dy > ir * ir) continue;
      }
      const gx = x0 + x;
      const depth = (y - itop) / (ibot - itop); // 0 top of the chamber, 1 the coal bed
      const n = fbmChunky(gx & MASK, y, seed ^ 0xc0a1);
      let c;
      if (depth < 0.32) c = rampPickFlat(HEAT, depth * 2.2 + (n - 0.5) * 0.6); // smoky, unlit crown
      else {
        const t = (depth - 0.32) * 1.25 + (n - 0.5) * 0.6;
        c = t < 0.08 ? C.forEmber : rampPickFlat(LAVA, t);
      }
      put(buf, gx, y, c);
      // Inner reveal: the frame's thickness, shadowed on the left, lit by the fire on the right.
      if (x === ix0 || (y < icy && (x - 1 - icx) ** 2 + (y - icy) ** 2 > ir * ir)) put(buf, gx, y, C.forIronShadow);
    }
  }
  // Coals: dark crusted lumps sitting on the bed.
  for (let i = 0; i < 9; i++) {
    const cx = ix0 + 1 + rng.int(iw - 4);
    const cy = ibot - 2 - rng.int(4);
    put(buf, x0 + cx, cy, C.forIronDark);
    put(buf, x0 + cx + 1, cy, C.forScorchDark);
    put(buf, x0 + cx, cy + 1, C.forEmber);
  }
  // Bars: vertical, round-shaded.
  for (let b = ix0 + 3; b < ix0 + iw - 1; b += 5) {
    for (let y = itop; y < ibot; y++) {
      const gx = x0 + b;
      const i = ((y & MASK) << 6) | (gx & MASK);
      const cell = buf[i];
      if (cell === C.forIronShadow || cell === C.forIronBase || cell === C.forIronMid || cell === C.forIronLight) {
        if (y < icy) continue; // outside the arch
      }
      put(buf, gx, y, C.forIronLight);
      put(buf, gx + 1, y, C.forIronShadow);
    }
  }
  // Sill: a lit iron lip under the mouth, and rivets up the frame posts.
  for (let x = 2; x < W - 2; x++) {
    put(buf, x0 + x, ibot, C.forIronHilite);
    put(buf, x0 + x, ibot + 1, C.forIronMid);
    put(buf, x0 + x, ibot + 2, C.forIronShadow);
  }
  for (let y = top + 20; y < bottom - 3; y += 8) {
    rivet(buf, x0 + 2, y);
    rivet(buf, x0 + W - 4, y);
  }
  // Heat glare on the sill and soot plume above the crown.
  for (let x = ix0 + 2; x < ix0 + iw - 2; x += 2) put(buf, x0 + x, ibot, C.forEmber);
  for (let y = 0; y < top + 2; y++) {
    for (let x = 8; x < W - 8; x++) {
      const gx = x0 + x;
      const i = ((y & MASK) << 6) | (gx & MASK);
      if (mask[i] === 1) continue;
      const w = (W / 2 - 8) * (0.4 + (y / (top + 2)) * 0.6);
      if (Math.abs(x - acx) > w) continue;
      if (h01(gx & MASK, y, seed ^ 0x5007) < 0.25 + (y / top) * 0.5) {
        const step = BAS.indexOf(buf[i]);
        if (step > 2) buf[i] = BAS[step - 2];
      }
    }
  }
  return buf;
}

// ─── Floors ────────────────────────────────────────────────────────────────────────────────────

/** Joint width between floor slabs. */
const GAP = 2;

/**
 * @typedef {Object} Slab
 * @property {number} x      start within its band, in band-local columns
 * @property {number} w      width including the joint
 * @property {boolean} split halved across its height
 * @property {number} tone
 * @property {boolean} iron
 * @property {boolean} edge  touches the tile's border: shared by every floor variant
 */

/**
 * @typedef {Object} FloorLayout
 * @property {number} py     first row of band 0
 * @property {Array<{off:number, slabs:Slab[]}>} bands  two 32-row bands; band 0 lies clear of the
 *   tile's top/bottom edges, band 1 straddles them
 * @property {number} left   band 0's straddling slab covers columns `0..left-1` (joint at its end)
 * @property {number} right  ...and columns `SIZE-right..SIZE-1`
 */

/**
 * The slab layout every floor variant shares, drawn from the edge seed. Band 1 straddles the tile's
 * top/bottom edges and band 0 has one slab straddling its left/right edges, so every slab that
 * touches the border is in the shared set; band 0's two interior slabs are what the variants vary
 * (cracks, an iron plate, the magma grate). Head joints of the two bands stay 5 columns apart.
 * Toroidal on both axes.
 * @param {number} edgeSeed
 * @returns {FloorLayout}
 */
function slabLayout(edgeSeed) {
  const rng = createRng(edgeSeed ^ 0xf100);
  const py = 12 + rng.int(9); // band 0 rows py..py+31, clear of rows 0–1 and 62–63
  const right = 8 + rng.int(7);
  const left = 8 + rng.int(7);
  const span = SIZE - left - right;
  const w1 = (span >> 1) + rng.int(7) - 3;
  /** @type {Slab[]} */
  const inner0 = [
    { x: 0, w: left + right, split: rng.chance(0.3), tone: rng.range(-0.1, 0.1), iron: false, edge: true },
    { x: left + right, w: w1, split: false, tone: 0, iron: false, edge: false },
    { x: left + right + w1, w: span - w1, split: false, tone: 0, iron: false, edge: false },
  ];
  const joints0 = [left, left + w1, SIZE - right];
  let off = 0;
  /** @type {Slab[]} */
  let slabs = [];
  for (let tries = 0; tries < 40; tries++) {
    off = rng.int(SIZE);
    slabs = [];
    let x = 0;
    while (x < SIZE) {
      let w = SIZE - x <= 40 ? SIZE - x : 20 + rng.int(14);
      if (SIZE - x - w > 0 && SIZE - x - w < 20) w = SIZE - x - 20;
      slabs.push({ x, w, split: rng.chance(0.3), tone: rng.range(-0.1, 0.1), iron: false, edge: true });
      x += w;
    }
    if (!slabs.some((s) => joints0.some((j) => colDist(off + s.x, j) < 5))) break;
  }
  return { py, left, right, bands: [{ off: SIZE - right, slabs: inner0 }, { off, slabs }] };
}

/**
 * Cracked basalt slab floor. Shared slabs are painted from `edgeSeed` (tone, noise, cracks); the two
 * interior slabs from `seed`, optionally one of them an iron plate, optionally left bare for a grate.
 * @param {FloorLayout} layout
 * @param {number} edgeSeed
 * @param {number} seed
 * @param {{lavaSeams:number, ironPlates:number, cracks?:boolean}} opts
 * @returns {Uint8Array}
 */
function paintSlabFloor(layout, edgeSeed, seed, opts) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  // Per-variant copy: interior slabs take this variant's tones, splits and plates.
  const L = {
    py: layout.py,
    bands: layout.bands.map((b) => ({ off: b.off, slabs: b.slabs.map((s) => ({ ...s })) })),
  };
  const inner = L.bands[0].slabs.filter((s) => !s.edge);
  for (const s of inner) {
    s.tone = rng.range(-0.1, 0.1);
    s.split = rng.chance(0.3);
  }
  // Plates go into the wider interior slab first: a plate in a narrow slab reads as a strip.
  const byWidth = inner.slice().sort((p, q) => q.w - p.w);
  for (let p = 0; p < Math.min(opts.ironPlates, byWidth.length); p++) {
    const s = byWidth[p];
    s.iron = true;
    s.split = false;
  }
  for (let y = 0; y < SIZE; y++) {
    const yy = (y - L.py) & MASK;
    const band = L.bands[yy >> 5];
    const ly = yy & 31;
    for (let x = 0; x < SIZE; x++) {
      const xx = (x - band.off) & MASK;
      let s = band.slabs[0];
      for (const c of band.slabs) if (xx >= c.x && xx < c.x + c.w) s = c;
      const lx = xx - s.x;
      let h = 32;
      let sy = ly;
      if (s.split) {
        h = 16;
        sy = ly & 15;
      }
      const i = (y << 6) | x;
      const nseed = s.edge ? edgeSeed : seed;
      const n = fbmChunky(x, y, nseed ^ 0x77a1);
      if (lx >= s.w - GAP || sy >= h - GAP) {
        buf[i] = rampPickChunky(BAS, 0.04 + n * 0.12, x, y);
        continue;
      }
      if (s.iron) {
        const streak = vnoise(x, y, 16, seed ^ 0x1e0) * 0.5 + fbmChunky(x, y, seed ^ 0x2e0) * 0.5;
        let t = 0.44 + (streak - 0.5) * 0.36;
        if (lx === 0 || sy === 0) t += 0.3;
        if (lx === s.w - GAP - 1 || sy === h - GAP - 1) t -= 0.3;
        buf[i] = rampPickFlat(IRON, t);
        const tx = lx - 4;
        const ty = sy - 4;
        if (tx >= 0 && ty >= 0 && lx < s.w - GAP - 4 && sy < h - GAP - 5) {
          // Diamond plate: short raised lugs on a 6-texel grid, alternating orientation.
          const m = (((tx / 6) | 0) + ((ty / 6) | 0)) & 1;
          const ux = tx % 6;
          const uy = ty % 6;
          if (m === 0 ? uy === 2 && ux >= 1 && ux <= 3 : ux === 2 && uy >= 1 && uy <= 3) buf[i] = C.forIronLight;
          else if (m === 0 ? uy === 3 && ux >= 1 && ux <= 3 : ux === 3 && uy >= 1 && uy <= 3) buf[i] = C.forIronShadow;
        }
        continue;
      }
      let t = 0.46 + s.tone + (n - 0.5) * 0.4;
      if (lx === 0 || sy === 0) t += 0.26;
      else if (lx === 1 || sy === 1) t += 0.1;
      if (lx >= s.w - GAP - 1 || sy >= h - GAP - 1) t -= 0.2;
      buf[i] = rampPickFlat(BAS, t);
    }
  }
  // Rivets on iron plates, and cracks on basalt slabs (shared slabs crack from the shared seed).
  for (let b = 0; b < 2; b++) {
    const band = L.bands[b];
    for (let k = 0; k < band.slabs.length; k++) {
      const s = band.slabs[k];
      const ox = band.off + s.x;
      const oy = L.py + b * 32;
      if (s.iron) {
        for (const [rx, ry] of [
          [2, 2],
          [s.w - 6, 2],
          [2, 26],
          [s.w - 6, 26],
        ])
          rivet(buf, ox + rx, oy + ry);
        // Scorch pooled in one corner.
        const cx = ox + 4 + rng.int(s.w - 10);
        for (let q = 0; q < 14; q++) {
          const px = cx + rng.int(6);
          const pyy = oy + 6 + rng.int(18);
          if (h01(px & MASK, pyy & MASK, seed) < 0.6) put(buf, px, pyy, C.forScorchDark);
        }
        continue;
      }
      if (!s.edge && opts.cracks === false) continue;
      const crng = s.edge ? blockRng(edgeSeed, 100 + b * 10 + k) : rng;
      const cseed = s.edge ? edgeSeed : seed;
      const inside = (/** @type {number} */ px, /** @type {number} */ pyy) => {
        const lx = (px - ox) & MASK;
        const ly = (pyy - oy) & MASK;
        return lx < s.w - GAP - 1 && ly < 32 - GAP - 1 && lx > 0 && ly > 0 && (!s.split || ((ly & 15) < 14 && (ly & 15) > 0));
      };
      const nCracks = crng.int(2);
      for (let c = 0; c < nCracks; c++) {
        crack(buf, ox + 3 + crng.int(s.w - 8), oy + 1, 10 + crng.int(18), true, false, cseed, crng, inside);
      }
    }
  }
  // Hairline lava seams: long cracks across the interior slabs and the joint between them, kept
  // inside band 0's interior so the glow never reaches a tile edge.
  const x0 = layout.left;
  const x1 = SIZE - layout.right - GAP; // exclusive
  const y0 = L.py;
  const y1 = L.py + 32 - GAP;
  const within = (/** @type {number} */ px, /** @type {number} */ pyy) => px > x0 && px < x1 - 1 && pyy > y0 && pyy < y1 - 1;
  for (let k = 0; k < opts.lavaSeams; k++) {
    const vertical = rng.chance(0.5);
    const sx = x0 + 2 + rng.int(x1 - x0 - (vertical ? 4 : 20));
    const sy = y0 + 2 + rng.int(vertical ? 4 : 24);
    crack(buf, sx, sy, 14 + rng.int(12), vertical, true, seed ^ 0x9a9a, rng, within);
  }
  return buf;
}

/**
 * The rare floor: the shared slabs all round, and where band 0's two interior slabs would be, an
 * iron-framed grate over a pit of flowing magma — set into the floor, not painted across it.
 * @param {FloorLayout} layout
 * @param {number} edgeSeed
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintMagmaGrate(layout, edgeSeed, seed) {
  const buf = paintSlabFloor(layout, edgeSeed, seed, { lavaSeams: 0, ironPlates: 0, cracks: false });
  const rng = createRng(seed ^ 0x6a7e);
  const X0 = layout.left;
  const Y0 = layout.py;
  const W = SIZE - layout.left - layout.right - GAP;
  const H = 32 - GAP;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = X0 + x;
      const gy = Y0 + y;
      const i = ((gy & MASK) << 6) | (gx & MASK);
      const e = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (e === 0) {
        // Angle-iron frame: lit on the top/left lip, shadowed bottom/right.
        const lit = x === 0 || y === 0 ? 0.32 : 0;
        const dark = x === W - 1 || y === H - 1 ? 0.34 : 0;
        buf[i] = rampPickFlat(IRON, 0.5 + lit - dark + (vnoise(gx & MASK, gy & MASK, 8, seed ^ 0xf4a) - 0.5) * 0.2);
        continue;
      }
      if (e === 1) {
        buf[i] = x === 1 || y === 1 ? C.forIronShadow : C.forIronDark;
        continue;
      }
      // Cooled crust rafts (a jittered Voronoi, 12-texel cells) floating on the melt: dark plates,
      // glowing fissures between them, hottest only in the fissure cores.
      let d1 = 1e9;
      let d2 = 1e9;
      for (let cy = ((y / 12) | 0) - 1; cy <= ((y / 12) | 0) + 1; cy++) {
        for (let cx = ((x / 12) | 0) - 1; cx <= ((x / 12) | 0) + 1; cx++) {
          const jx = (cx + 0.2 + 0.6 * h01(cx & 7, cy & 7, seed)) * 12;
          const jy = (cy + 0.2 + 0.6 * h01(cx & 7, cy & 7, seed ^ 0x1234)) * 12;
          const dd = (x - jx) * (x - jx) + (y - jy) * (y - jy);
          if (dd < d1) {
            d2 = d1;
            d1 = dd;
          } else if (dd < d2) d2 = dd;
        }
      }
      const edge = Math.sqrt(d2) - Math.sqrt(d1);
      const n = fbmChunky(gx & MASK, gy & MASK, seed ^ 0x22);
      // Heat: 0 against the frame, 1 in the middle of the pit.
      const dist = e - 2;
      const heat = dist < 1 ? 0 : dist > 7 ? 1 : (dist - 1) / 6;
      const w = (2.3 + n * 2.2) * (0.4 + 0.6 * heat);
      if (edge < w && heat > 0.2) {
        const core = 1 - edge / w;
        buf[i] = rampPickFlat(LAVA, core * core * heat * 1.05 + (n - 0.5) * 0.2 - 0.05);
      } else if (edge < w + 1.2) buf[i] = heat > 0.15 ? C.forEmber : C.forScorch;
      else buf[i] = rampPickFlat(HEAT, (n - 0.5) * 0.9 + (edge < w + 3 ? 0.35 * heat : -0.25));
    }
  }
  // Grate: round bars along y, 5 wide and evenly spaced, and one strap across the middle on top.
  const shade = [C.forIronLight, C.forIronHilite, C.forIronMid, C.forIronDark, C.forIronShadow];
  const bars = Math.max(2, Math.round((W - 4) / 11));
  const space = (W - 4 - bars * 5) / (bars + 1);
  /** @type {number[]} */
  const barX = [];
  for (let b = 0; b < bars; b++) barX.push(2 + Math.round(space + b * (5 + space)));
  for (const bx0 of barX) {
    for (let y = 2; y < H - 2; y++) for (let t = 0; t < 5; t++) put(buf, X0 + bx0 + t, Y0 + y, shade[t]);
  }
  const sy = (H >> 1) - 2;
  for (let x = 2; x < W - 2; x++) {
    const onBar = barX.some((b) => x - b >= 0 && x - b < 5);
    for (let t = 0; t < 5; t++) put(buf, X0 + x, Y0 + sy + t, onBar && t > 0 && t < 4 ? C.forIronMid : shade[t]);
  }
  // Underglow: bar edges that face the melt pick up an ember tint.
  for (let k = 0; k < 40; k++) {
    const x = X0 + 3 + rng.int(W - 6);
    const y = Y0 + 3 + rng.int(H - 6);
    const i = ((y & MASK) << 6) | (x & MASK);
    if (buf[i] === C.forIronShadow || buf[i] === C.forIronDark) buf[i] = C.forEmber;
  }
  return buf;
}

// ─── Ceilings ──────────────────────────────────────────────────────────────────────────────────

/**
 * Soot-blackened rough stone, with an iron pipe (plain) or a riveted girder and chain (band).
 * The ashlar is 4 courses of 16 rows, blocks 32 wide in a running bond. The first and last courses
 * (the ones meeting the tile's top/bottom edges) are painted from `edgeSeed`, so both variants meet
 * along y; the two middle courses, the pipe and the girder are the variant's own.
 * @param {number} edgeSeed
 * @param {number} seed
 * @param {boolean} band
 * @returns {Uint8Array}
 */
function paintCeiling(edgeSeed, seed, band) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  const erng = createRng(edgeSeed ^ 0xce11);
  const offs = [erng.int(SIZE), rng.int(SIZE), rng.int(SIZE), erng.int(SIZE)];
  const tones = new Float32Array(8);
  for (let k = 0; k < 8; k++) tones[k] = (k >> 1 === 0 || k >> 1 === 3 ? erng : rng).range(-0.08, 0.08);
  for (let y = 0; y < SIZE; y++) {
    const row = y >> 4;
    const ly = y & 15;
    const cseed = row === 0 || row === 3 ? edgeSeed : seed;
    for (let x = 0; x < SIZE; x++) {
      const xx = (x - offs[row]) & MASK;
      const lx = xx & 31;
      const blk = (row << 1) | (xx >> 5);
      const i = (y << 6) | x;
      const n = fbmChunky(x, y, cseed);
      if (ly >= 14 || lx >= 30) {
        buf[i] = rampPickChunky(BAS, 0.02 + n * 0.1, x, y);
        continue;
      }
      const soot = vnoise(x, y, 32, cseed ^ 0x5007);
      let t = 0.36 + tones[blk] + (n - 0.5) * 0.36 - soot * 0.16;
      if (ly === 0 || lx === 0) t += 0.2;
      if (ly === 13 || lx === 29) t -= 0.14;
      buf[i] = rampPickFlat(BAS, t);
    }
  }
  if (!band) {
    // A thin iron pipe along x with brass collars at the tile's two joints.
    const py = 4 + rng.int(8);
    const pipe = [C.forIronLight, C.forIronHilite, C.forIronMid, C.forIronBase, C.forIronDark, C.forIronShadow];
    const cx = rng.int(SIZE);
    for (let x = 0; x < SIZE; x++) {
      for (let t = 0; t < 6; t++) put(buf, x, py + t, pipe[t]);
      put(buf, x, py + 6, C.forBasShadow); // cast shadow
    }
    for (let c = 0; c < 2; c++) {
      const bx = cx + c * 32;
      for (let t = -1; t < 7; t++) {
        put(buf, bx, py + t, t < 1 ? C.forBrassLight : t < 5 ? C.forBrassMid : C.forBrassDark);
        put(buf, bx + 1, py + t, t < 5 ? C.forBrassMid : C.forBrassDark);
        put(buf, bx + 2, py + t, C.forBrassDark);
      }
    }
    return buf;
  }
  // Riveted I-girder, rows 24..39: flanges top and bottom, recessed web between.
  const gy = 24;
  for (let y = gy; y < gy + 16; y++) {
    const e = y - gy;
    for (let x = 0; x < SIZE; x++) {
      const n = vnoise(x, y, 16, seed ^ 0x61d) - 0.5;
      let t;
      if (e < 4) t = 0.55 + n * 0.2 + (e === 0 ? 0.3 : e === 3 ? -0.22 : 0); // top flange
      else if (e >= 12) t = 0.5 + n * 0.2 + (e === 12 ? 0.28 : e === 15 ? -0.3 : 0); // bottom flange
      else t = 0.2 + n * 0.2 + (e === 4 ? -0.2 : 0); // web in the flange's shadow
      put(buf, x, y, rampPickFlat(IRON, t));
    }
  }
  for (let x = 0; x < SIZE; x++) {
    put(buf, x, gy - 1, C.forBasShadow);
    put(buf, x, gy + 16, C.forBasShadow);
    put(buf, x, gy + 17, C.forBasJoint);
  }
  for (let r = 0; r < 8; r++) {
    rivet(buf, 3 + r * 8, gy + 1);
    rivet(buf, 3 + r * 8, gy + 13);
  }
  // Web stiffeners every 32 texels with a brass collar.
  for (let s = 0; s < 2; s++) {
    const sx = 14 + s * 32;
    for (let y = gy + 4; y < gy + 12; y++) {
      put(buf, sx, y, C.forIronLight);
      put(buf, sx + 1, y, C.forIronMid);
      put(buf, sx + 2, y, C.forIronShadow);
    }
  }
  // A chain slung along the web: 8-texel links alternating face-on rings and edge-on bars.
  const cy = gy + 6;
  for (let x = 0; x < SIZE; x += 8) {
    // Face-on ring, 6×4 with a dark hole.
    for (let k = 1; k < 5; k++) {
      put(buf, x + k, cy, C.forIronHilite);
      put(buf, x + k, cy + 3, C.forIronShadow);
    }
    put(buf, x, cy + 1, C.forIronLight);
    put(buf, x, cy + 2, C.forIronMid);
    put(buf, x + 5, cy + 1, C.forIronMid);
    put(buf, x + 5, cy + 2, C.forIronDark);
    for (let k = 1; k < 5; k++) {
      put(buf, x + k, cy + 1, C.forBasShadow);
      put(buf, x + k, cy + 2, C.forBasShadow);
    }
    // Edge-on link threading the ring to the next one.
    for (let k = 4; k < 10; k++) {
      put(buf, x + k, cy + 1, k === 4 || k === 9 ? C.forIronMid : C.forIronLight);
      put(buf, x + k, cy + 2, C.forIronShadow);
    }
  }
  return buf;
}

/** @type {import('./index.js').TilesetDef} */
export const TILESET = Object.freeze({
  id: 'forge',
  name: 'Infernal Forge',
  fog: 'forFog',
  paint(seedOf) {
    // One seed for everything that touches a tile edge, so every variant meets every other.
    const edge = seedOf('edge');
    const bond = wallLayout(edge);
    const slabs = slabLayout(edge);
    return {
      wall: [
        paintBasaltWall(bond, edge, seedOf('wall0'), { veins: 1, cracks: 0.12, lavaCracks: 0 }),
        paintBasaltWall(bond, edge, seedOf('wall1'), { veins: 2, cracks: 0.2, lavaCracks: 0.28 }),
        paintIronWall(bond, edge, seedOf('wall2')),
        paintFurnaceWall(bond, edge, seedOf('wall3')),
      ],
      floor: [
        paintSlabFloor(slabs, edge, seedOf('floor0'), { lavaSeams: 1, ironPlates: 0 }),
        paintSlabFloor(slabs, edge, seedOf('floor1'), { lavaSeams: 0, ironPlates: 1 }),
        paintMagmaGrate(slabs, edge, seedOf('floor2')),
      ],
      ceiling: [paintCeiling(edge, seedOf('ceil0'), false), paintCeiling(edge, seedOf('ceil1'), true)],
    };
  },
});
