// @ts-check
/**
 * @file Flooded Cistern tileset — floor 2, the first step down from the Old Keep.
 *
 * ART DIRECTION:
 * - **Walls** — small green-grey brick (eight 8-texel courses, three bricks a tile) with dark wet
 *   mortar, each brick a flat tone with a lit top edge. Drip streaks run down from the joints, a
 *   chalky limescale tideline crosses every wall at the same height below eye level, and the bricks
 *   under it are darker and colonised by slime from the mortar up. Variants: [1] wetter, spalled and
 *   blooming with limescale; [2] a rusting iron mooring ring; [3] a barred drain outlet spilling
 *   slime down to the floor.
 * - **Floor** — worn grey-green flagstones in staggered rows, chipped corners, cracks, slime in the
 *   joints and standing puddles that throw back a lighter teal with pale glints. [2] is a square
 *   iron drain grate over black water.
 * - **Ceiling** — a brick barrel vault (courses run along the corridor, the crown lit and the
 *   springings dark) with calcite spots; [1] adds a ribbed stone arch across the tile with limescale
 *   drips hanging off it.
 *
 * Seamless as `textures.js` requires: every wall variant shares one course table (`COURSE_PHASE`
 * keeps eye-level row 32 inside a brick face), widths sum to 64, noise is toroidal, and every
 * write wraps through `put`.
 *
 * Seamless ACROSS variants too (the raycaster puts any two side by side, untransformed): all wall
 * variants share one brick layout from `seedOf('wallEdge')`, and every brick that comes within
 * `EDGE_ZONE` of the left/right edge is painted whole from that shared seed, as are the mortar, both
 * tidelines and the slime baseline at the edges. All three floors share one flagstone layout from
 * `seedOf('floorEdge')` and every slab touching the border; puddles and joint slime fade from a
 * shared baseline at the border to each variant's own over `EDGE_FADE` texels. Variants differ in
 * their interior bricks/slabs and in their decor, which is kept clear of the edge zone (the grate is
 * inset in the middle of the common floor). Both ceilings share one seed and differ only by the rib,
 * which sits inside the tile.
 */

import { createRng } from '../../core/rng.js';
import { C, RAMPS, ramp } from '../palette.js';
import { SIZE, MASK, AREA, put, rampPickChunky, rampPickFlat, h01, vnoise, fbmChunky } from '../textures.js';

const BRICK = ramp(
  'cisBrickShadow',
  'cisBrickMortar',
  'cisBrickDeep',
  'cisBrickDark',
  'cisBrickMid',
  'cisBrickBase',
  'cisBrickLight',
  'cisBrickHilite',
);
const SLIME = ramp('cisSlimeDeep', 'cisSlimeMid', 'cisSlimeLight', 'cisSlimeTip');
const FLAG = ramp('cisFlagGap', 'cisFlagShadow', 'cisFlagDark', 'cisFlagMid', 'cisFlagBase', 'cisFlagLight', 'cisFlagBright');
const IRON = RAMPS.iron;

/** palette index → step in BRICK / FLAG, or -1. */
const BRICK_STEP = new Int8Array(256).fill(-1);
for (let i = 0; i < BRICK.length; i++) BRICK_STEP[BRICK[i]] = i;
const FLAG_STEP = new Int8Array(256).fill(-1);
for (let i = 0; i < FLAG.length; i++) FLAG_STEP[FLAG[i]] = i;

/** Brick courses: 8 texels tall (6 face + 2 bed joint), starting at row 5 so row 32 is mid-face. */
const COURSE_PHASE = 5;
const COURSE_H = 8;
const BED = 2;
const HEAD = 2;
/** Row the limescale tideline sits on, in every wall variant. */
const TIDE = 47;

/** Texels either side of a tile edge whose structure and detail every variant shares. */
const EDGE_ZONE = 4;
/** Texels past `EDGE_ZONE` over which per-variant puddles and slime fade in from the shared baseline. */
const EDGE_FADE = 10;
/** Shared baselines painted at the edges, between the variants' own settings. */
const EDGE_WALL = { damp: 0.12, slime: 0.6 };
const EDGE_FLOOR = { puddle: 0.1, slime: 0.45, cracks: 0.27 };

/** Distance from coordinate `v` to the nearest tile edge (0 on column 0 and 63). @param {number} v */
function edgeDist(v) {
  const m = v & MASK;
  return m < MASK - m ? m : MASK - m;
}

/** 0 inside the shared edge zone, easing to 1 (all variant) `EDGE_FADE` texels further in. @param {number} d */
function variantWeight(d) {
  const t = (d - EDGE_ZONE) / EDGE_FADE;
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** Whether the wrapping span [start, start+len) reaches into the edge zone. @param {number} start @param {number} len */
function spanTouchesEdge(start, len) {
  for (let k = 0; k < len; k++) if (edgeDist(start + k) < EDGE_ZONE) return true;
  return false;
}

/** A per-element seed derived from `seed`, independent of how many elements came before. @param {number} seed @param {number} k */
function subSeed(seed, k) {
  return (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
}

/**
 * Move a brick texel `delta` ramp steps, never into or out of the mortar tones.
 * @param {Uint8Array} buf
 * @param {number} x
 * @param {number} y
 * @param {number} delta
 */
function shiftBrick(buf, x, y, delta) {
  const i = ((y & MASK) << 6) | (x & MASK);
  const s = BRICK_STEP[buf[i]];
  if (s < 2) return;
  let n = s + delta;
  if (n < 2) n = 2;
  if (n > BRICK.length - 1) n = BRICK.length - 1;
  buf[i] = BRICK[n];
}

/**
 * Move a flagstone face texel `delta` ramp steps (joints are left alone).
 * @param {Uint8Array} buf
 * @param {number} x
 * @param {number} y
 * @param {number} delta
 */
function shiftFlag(buf, x, y, delta) {
  const i = ((y & MASK) << 6) | (x & MASK);
  const s = FLAG_STEP[buf[i]];
  if (s < 2) return;
  let n = s + delta;
  if (n < 2) n = 2;
  if (n > FLAG.length - 1) n = FLAG.length - 1;
  buf[i] = FLAG[n];
}

// ─── Brick field (walls and vault) ──────────────────────────────────────────────────────────────

/**
 * One brick: flat tone, lit top edge, shadowed bottom, a weathered patch and a few flecks.
 * @param {Uint8Array} buf
 * @param {number} bx
 * @param {number} by
 * @param {number} bw cell width including the head joint
 * @param {number} seed
 * @param {import('../../core/rng.js').Rng} rng
 * @param {Float32Array} rowTone per-row tone offset
 * @param {number} damp chance the brick is a darker wet one
 */
function paintBrick(buf, bx, by, bw, seed, rng, rowTone, damp) {
  const fw = bw - HEAD;
  const fh = COURSE_H - BED;
  let baseT = 0.62 + rng.range(-0.17, 0.17);
  if (rng.chance(damp)) baseT -= 0.15;
  const bevel = rng.range(0.6, 1.15);
  const lo = 2 / 7;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const gx = bx + x;
      const gy = by + y;
      let t = baseT + rowTone[gy & MASK] + (fbmChunky(gx, gy, seed) - 0.5) * 0.24;
      if (y === 0) t += 0.2 * bevel;
      else if (x === 0) t += 0.1 * bevel;
      if (y === fh - 1) t -= 0.16;
      else if (x === fw - 1) t -= 0.1;
      put(buf, gx, gy, rampPickFlat(BRICK, t < lo ? lo : t));
    }
  }
  // A worn patch one step off the face, kept off the bevel row.
  if (rng.chance(0.7)) {
    const pw = 3 + rng.int(4);
    const px = 1 + rng.int(Math.max(1, fw - pw - 1));
    const py = 1 + rng.int(3);
    const d = rng.chance(0.55) ? -1 : 1;
    for (let y = py; y < Math.min(fh - 1, py + 2 + rng.int(2)); y++) {
      for (let x = px; x < px + pw && x < fw - 1; x++) shiftBrick(buf, bx + x, by + y, d);
    }
  }
  const flecks = 2 + rng.int(4);
  for (let i = 0; i < flecks; i++) {
    shiftBrick(buf, bx + 1 + rng.int(fw - 2), by + 1 + rng.int(fh - 2), rng.chance(0.25) ? 1 : -1);
  }
}

/**
 * Toroidal running bond of small bricks: 8 courses, 3 bricks a course. The layout and mortar come
 * from `edgeSeed`, and so does every brick that reaches the left/right edge zone; only bricks wholly
 * inside the tile are painted from `seed` — so textures sharing an `edgeSeed` meet brick for brick.
 * @param {Uint8Array} buf
 * @param {number} edgeSeed
 * @param {number} seed
 * @param {Float32Array} rowTone
 * @param {number} damp chance an interior brick is a darker wet one
 * @param {number} edgeDamp the same for the shared edge bricks
 */
function paintBricks(buf, edgeSeed, seed, rowTone, damp, edgeDamp) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      buf[(y << 6) | x] = rampPickChunky(BRICK, 0.03 + fbmChunky(x, y, edgeSeed ^ 0x3e11) * 0.14, x, y);
    }
  }
  const layout = createRng(edgeSeed ^ 0x1a70);
  for (let r = 0; r < SIZE / COURSE_H; r++) {
    const y0 = COURSE_PHASE + r * COURSE_H;
    const w1 = 18 + layout.int(8);
    const w2 = 18 + layout.int(8);
    const widths = [w1, w2, SIZE - w1 - w2];
    let x = layout.int(SIZE);
    for (let b = 0; b < widths.length; b++) {
      const bw = widths[b];
      const shared = spanTouchesEdge(x, bw);
      const bs = shared ? edgeSeed : seed;
      paintBrick(buf, x, y0, bw, bs, createRng(subSeed(bs, r * 3 + b)), rowTone, shared ? edgeDamp : damp);
      x += bw;
    }
  }
}

// ─── Walls ──────────────────────────────────────────────────────────────────────────────────────

/**
 * A water stain running down from a joint: darkens the brick it crosses, with a rare wet glint.
 * @param {Uint8Array} buf
 * @param {number} x0
 * @param {number} y0
 * @param {number} len
 * @param {number} seed
 * @param {boolean} wide
 */
function paintDrip(buf, x0, y0, len, seed, wide) {
  let x = x0;
  const end = Math.min(SIZE, y0 + len);
  const xMin = EDGE_ZONE;
  const xMax = MASK - EDGE_ZONE - 1; // leaves room for the wide streak's second column
  for (let y = y0; y < end; y++) {
    const tail = end - y <= 3;
    shiftBrick(buf, x, y, tail ? -1 : -2);
    if (wide && !tail) shiftBrick(buf, x + 1, y, -1);
    if (h01(x0, y, seed ^ 0x61d) > 0.9) {
      const i = ((y & MASK) << 6) | (x & MASK);
      if (BRICK_STEP[buf[i]] >= 2) buf[i] = C.cisWaterGlint;
    }
    if (h01(y, x0, seed ^ 0x2b7) > 0.93) x += h01(x0, y + 99, seed) > 0.5 ? 1 : -1;
    if (x < xMin) x = xMin;
    else if (x > xMax) x = xMax;
  }
}

/**
 * Paint a cistern wall variant. Decor (spalls, drips, blooms, ring, drain) stays clear of the
 * shared edge zone; slime fades to the shared baseline there.
 * @param {number} edgeSeed shared by every wall variant
 * @param {number} seed
 * @param {{drips:number, slime:number, damp:number, spall:number, bloom:number,
 *   ring:boolean, drain:boolean}} o
 * @returns {Uint8Array}
 */
function paintWall(edgeSeed, seed, o) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);

  // Below the waterline the brick is darker, and darker still near the floor.
  const rowTone = new Float32Array(SIZE);
  for (let y = 0; y < SIZE; y++) rowTone[y] = y > TIDE ? -0.07 - ((y - TIDE) / (SIZE - TIDE)) * 0.1 : 0;
  paintBricks(buf, edgeSeed, seed, rowTone, o.damp, EDGE_WALL.damp);

  // Spalled bricks: a recessed, broken patch with a shadowed top and a lit lower lip.
  for (let s = 0; s < o.spall; s++) {
    const w = 5 + rng.int(6);
    const x0 = EDGE_ZONE + rng.int(SIZE - 2 * EDGE_ZONE - w);
    const y0 = COURSE_PHASE + rng.int(5) * COURSE_H + 1;
    for (let y = 0; y < 4; y++) {
      const inset = y === 0 || y === 3 ? 1 : 0;
      for (let x = inset; x < w - inset; x++) shiftBrick(buf, x0 + x, y0 + y, y === 0 ? -3 : y === 3 ? 1 : -2);
    }
  }

  // Drip streaks from the bed joints.
  for (let d = 0; d < o.drips; d++) {
    const row = rng.int(5);
    const y0 = row === 0 ? 0 : COURSE_PHASE + row * COURSE_H - BED + 2;
    paintDrip(buf, EDGE_ZONE + 5 + rng.int(SIZE - 2 * (EDGE_ZONE + 5)), y0, 10 + rng.int(28), seed ^ d, rng.chance(0.4));
  }

  // Limescale bloom: a chalky fan weeping from a bed joint above the waterline.
  for (let b = 0; b < o.bloom; b++) {
    const bx = EDGE_ZONE + 6 + rng.int(SIZE - 2 * (EDGE_ZONE + 6));
    const by = COURSE_PHASE + (1 + rng.int(3)) * COURSE_H - BED;
    for (let y = 0; y < 9; y++) {
      const half = 5 - (y >> 1);
      for (let x = -half; x <= half; x++) {
        const n = h01(bx + x, by + y, seed ^ 0xb100);
        if (n < 0.25 + y * 0.07) continue;
        const edge = Math.abs(x) === half;
        put(buf, bx + x, by + y, y < 2 && !edge ? C.cisLimePale : edge || y > 5 ? C.cisLimeDark : C.cisLimeMid);
      }
    }
  }

  // An older, fainter tideline above eye level. Both tidelines run the length of every corridor, so
  // they come from the shared seed and continue unbroken across any mix of variants.
  for (let x = 0; x < SIZE; x++) {
    const n = h01(x >> 2, 5, edgeSeed ^ 0x0de1);
    if (n > 0.45) put(buf, x, 22 + (n > 0.8 ? 1 : 0), C.cisLimeDark);
  }

  // The tideline: a broken, uneven crust of limescale rather than a clean line — a continuous pale
  // row lit by a warm torch read as a brass handrail running down every corridor. Crust comes in
  // 2-texel clumps of varying thickness with gaps, mostly mid/dark lime, pale only in rare knots,
  // with lime runs weeping below it.
  for (let x = 0; x < SIZE; x++) {
    const wob = vnoise(x, 0, 16, edgeSeed ^ 0x7de) > 0.62 ? -1 : 0;
    const ty = TIDE + wob;
    const cov = vnoise(x & ~1, 0, 8, edgeSeed ^ 0x7c0);
    const n = h01(x >> 1, 3, edgeSeed ^ 0x71de);
    if (cov < 0.34) {
      // Gap in the crust: only a stain.
      shiftBrick(buf, x, ty, -1);
      continue;
    }
    const thick = cov > 0.62 ? 2 : 1;
    if (thick === 2 && n > 0.5) put(buf, x, ty - 1, C.cisLimeDark);
    put(buf, x, ty, n > 0.9 ? C.cisLimePale : n > 0.35 ? C.cisLimeMid : C.cisLimeDark);
    if (thick === 2) put(buf, x, ty + 1, n > 0.6 ? C.cisLimeMid : C.cisLimeDark);
    if (h01(x, 9, edgeSeed ^ 0x71de) > 0.86) {
      const len = 2 + ((n * 5) | 0);
      for (let k = 0; k < len; k++) put(buf, x, ty + thick + k, k === len - 1 ? C.cisWaterGlint : C.cisLimeDark);
    }
  }

  // Slime: grows out of the mortar below the waterline, thickest at the floor. Near the edges both
  // the growth pattern and its amount ease to the shared baseline.
  for (let y = TIDE + 2; y < SIZE; y++) {
    const depth = (y - TIDE) / (SIZE - TIDE);
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      const s = BRICK_STEP[buf[i]];
      if (s < 0) continue;
      const w = variantWeight(edgeDist(x));
      const groove = s <= 1 ? 1.32 : 0.86;
      const nE = fbmChunky(x + 13, y + 7, edgeSeed ^ 0x51e1);
      const nV = w > 0 ? fbmChunky(x + 13, y + 7, seed ^ 0x51e1) : nE;
      const n = (nE + (nV - nE) * w) * groove * (0.6 + 0.95 * depth);
      const thr = 1 - (EDGE_WALL.slime + (o.slime - EDGE_WALL.slime) * w) * 0.62;
      if (n > thr) buf[i] = rampPickChunky(SLIME, 0.12 + (n - thr) * 3.2, x, y);
    }
  }

  if (o.ring) paintRing(buf, rng, seed);
  if (o.drain) paintDrain(buf, rng, seed);
  return buf;
}

/**
 * An iron mooring ring on a bolted plate, casting a shadow and bleeding rust to the floor.
 * @param {Uint8Array} buf
 * @param {import('../../core/rng.js').Rng} rng
 * @param {number} seed
 */
function paintRing(buf, rng, seed) {
  const cx = EDGE_ZONE + 8 + rng.int(SIZE - 2 * EDGE_ZONE - 18); // shadow and plate span cx-8..cx+9
  const py = 35;
  const rcy = py + 12;
  const rx = 6.5;
  const ry = 7.5;
  /** @param {number} dx @param {number} dy */
  const ringD = (dx, dy) => Math.sqrt((dx / rx) * (dx / rx) + (dy / ry) * (dy / ry));
  // Shadow first, offset down-right.
  for (let dy = -9; dy <= 9; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      const d = ringD(dx, dy);
      if (d > 0.72 && d < 1.24) {
        shiftBrick(buf, cx + dx + 1, rcy + dy + 2, -3);
      }
    }
  }
  for (let y = py; y < py + 7; y++) for (let x = cx - 4; x <= cx + 5; x++) shiftBrick(buf, x, y + 1, -2);
  // Ring.
  for (let dy = -9; dy <= 9; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      const d = ringD(dx, dy);
      if (d <= 0.72 || d >= 1.24) continue;
      const lit = dx + dy < -2 ? (d < 0.95 ? 4 : 3) : dx + dy > 3 ? (d > 1.0 ? 0 : 1) : 2;
      put(buf, cx + dx, rcy + dy, IRON[lit]);
    }
  }
  // Plate with a bolt, drawn over the top of the ring.
  for (let y = py; y < py + 6; y++) {
    for (let x = cx - 4; x <= cx + 4; x++) {
      const t = y === py || x === cx - 4 ? 3 : y === py + 5 || x === cx + 4 ? 0 : 2;
      put(buf, x, y, IRON[t]);
    }
  }
  put(buf, cx, py + 2, C.ironHilite);
  put(buf, cx + 1, py + 2, C.ironLight);
  put(buf, cx, py + 3, C.ironBase);
  put(buf, cx + 1, py + 3, C.ironShadow);
  put(buf, cx - 3, py + 4, C.cisRust);
  put(buf, cx + 3, py + 1, C.oilDark);
  // Rust on the ring's lowest arc, and a rust run down to the floor.
  for (let dx = -3; dx <= 3; dx++) if (h01(dx, 1, seed) > 0.4) put(buf, cx + dx, rcy + 7, C.cisRust);
  let x = cx;
  for (let y = rcy + 9; y < SIZE; y++) {
    put(buf, x, y, h01(x, y, seed ^ 0x505) > 0.35 ? C.cisRust : C.oilDark);
    if (y < rcy + 12) put(buf, x + 1, y, C.oilDark);
    if (h01(y, 7, seed ^ 0x505) > 0.8) x += 1;
  }
}

/**
 * A barred drain outlet: a stone-framed arch over black water, slime spilling from its sill.
 * @param {Uint8Array} buf
 * @param {import('../../core/rng.js').Rng} rng
 * @param {number} seed
 */
function paintDrain(buf, rng, seed) {
  const cx = EDGE_ZONE + 11 + rng.int(SIZE - 2 * EDGE_ZONE - 22); // frame spans cx-11..cx+11
  const r = 7;
  const top = 30;
  const springY = top + r; // arch centre row
  const sill = 51;
  const frame = 3;
  /** distance from the arch outline: <0 inside, grows outward. @param {number} dx @param {number} y */
  const outside = (dx, y) => (y < springY ? Math.sqrt(dx * dx + (y - springY) * (y - springY)) - r : Math.abs(dx) - r);
  // Stone frame (voussoirs) and dark interior.
  for (let y = top - frame - 1; y <= sill; y++) {
    for (let dx = -r - frame - 1; dx <= r + frame + 1; dx++) {
      const o = outside(dx + 0.5, y + 0.5);
      if (o > frame + 0.3) continue;
      const x = cx + dx;
      if (o > 0) {
        // Voussoirs: joints radiate every ~40° on the arch, courses on the jambs.
        const ang = y < springY ? Math.atan2(y + 0.5 - springY, dx + 0.5) : 0;
        const joint = y < springY ? Math.abs(((ang / 0.7) % 1 + 1) % 1 - 0.5) > 0.44 : (y - springY) % 7 === 6;
        let t = o < 1.2 ? 0.28 : o > frame - 0.6 ? 0.52 : 0.75;
        if (dx + y - springY < -4 && o > 1.2) t += 0.12;
        put(buf, x, y, joint ? C.cisFlagShadow : rampPickFlat(FLAG, t));
      } else {
        const depth = -o;
        let c = depth < 1.2 ? C.cisFlagGap : C.void;
        if (y >= sill - 4) c = y === sill - 4 ? C.cisWaterMid : h01(dx, y, seed) > 0.8 ? C.cisWaterLight : C.cisWaterDeep;
        put(buf, x, y, c);
      }
    }
  }
  // Iron bars.
  for (const bxo of [-4, 0, 4]) {
    for (let y = top; y < sill; y++) {
      if (outside(bxo + 0.5, y + 0.5) > -0.2) continue;
      put(buf, cx + bxo, y, C.ironLight);
      put(buf, cx + bxo + 1, y, C.ironDark);
    }
  }
  for (let dx = -r + 1; dx < r; dx++) {
    put(buf, cx + dx, springY + 2, C.ironLight);
    put(buf, cx + dx, springY + 3, C.ironShadow);
  }
  // Sill lip.
  for (let dx = -r - frame; dx <= r + frame; dx++) {
    put(buf, cx + dx, sill, C.cisFlagBright);
    put(buf, cx + dx, sill + 1, C.cisFlagMid);
    put(buf, cx + dx, sill + 2, C.cisFlagShadow);
  }
  // Slime tongue spilling to the floor, widening as it falls, with a wet highlight down its middle.
  for (let y = sill; y < SIZE; y++) {
    const half = 3 + ((y - sill) >> 2);
    for (let dx = -half; dx <= half; dx++) {
      const edge = Math.abs(dx) >= half - (h01(dx, y, seed ^ 0x77) > 0.5 ? 1 : 0);
      if (edge && h01(dx + 50, y, seed) > 0.5) continue;
      const t = edge ? 0.1 : Math.abs(dx) <= 1 ? 0.8 : 0.45;
      put(buf, cx + dx, y + (y === sill ? 0 : 0), rampPickChunky(SLIME, t, cx + dx, y));
    }
    if (h01(y, 3, seed ^ 0x77) > 0.75) put(buf, cx + (h01(y, 4, seed) > 0.5 ? 1 : 0), y, C.cisWaterGlint);
  }
}

// ─── Floor ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Paint worn flagstones with puddles and slime in the joints. The slab layout, the mortar and every
 * slab touching the border come from `edgeSeed`; puddles and joint slime ease from the shared
 * `EDGE_FLOOR` baseline at the border to this variant's own settings further in.
 * @param {number} edgeSeed shared by every floor variant
 * @param {number} seed
 * @param {{puddle:number, slime:number, cracks:number}} o `puddle` is the share of the tile under water
 *   (0..1)
 * @returns {Uint8Array}
 */
function paintFloor(edgeSeed, seed, o) {
  const buf = new Uint8Array(AREA);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      buf[(y << 6) | x] = rampPickChunky(FLAG, 0.02 + fbmChunky(x, y, edgeSeed ^ 0x9a9) * 0.16, x, y);
    }
  }

  const layout = createRng(edgeSeed ^ 0xf1a6);
  const heights = layout.chance(0.5) ? [22, 20, 22] : [20, 24, 20];
  let y0 = layout.int(SIZE);
  for (let r = 0; r < heights.length; r++) {
    const bh = heights[r];
    const w1 = 18 + layout.int(9);
    const w2 = 18 + layout.int(9);
    const widths = [w1, w2, SIZE - w1 - w2];
    let x0 = layout.int(SIZE);
    for (let b = 0; b < widths.length; b++) {
      const bw = widths[b];
      const shared = spanTouchesEdge(x0, bw) || spanTouchesEdge(y0, bh);
      const bs = shared ? edgeSeed : seed;
      paintFlag(buf, x0, y0, bw, bh, bs, createRng(subSeed(bs, r * 3 + b)), shared ? EDGE_FLOOR.cracks : o.cracks);
      x0 += bw;
    }
    y0 += bh;
  }

  // Puddles: a toroidal noise field sampled on 2×2 cells, so edges step like pixel art. The
  // threshold is taken at a coverage quantile of the field, not a fixed noise level — a fixed level
  // drowned one seed's floor and left another's bone dry. Depth is normalised per field, then eased
  // from the shared field at the border to this variant's inside.
  const psE = edgeSeed ^ 0x9dd1e;
  const psV = seed ^ 0x9dd1e;
  const depthE = puddleDepth(psE, EDGE_FLOOR.puddle);
  const depthV = puddleDepth(psV, o.puddle);
  for (let y = 0; y < SIZE; y++) {
    const wy = variantWeight(edgeDist(y));
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      const wx = variantWeight(edgeDist(x));
      const w = wx < wy ? wx : wy;
      const d = depthE[i] + (depthV[i] - depthE[i]) * w; // 0 at the shore, 1 at the deepest point
      if (d < -0.12) continue;
      if (d < 0) {
        shiftFlag(buf, x, y, -1); // wet rim
        continue;
      }
      const gap = FLAG_STEP[buf[i]] >= 0 && FLAG_STEP[buf[i]] <= 1;
      if (d < 0.07) {
        buf[i] = C.cisWaterDeep;
        continue;
      }
      // Flat reflective body, lighter than the stone, with the drowned joints showing through and
      // a few broad bands of reflected light broken into 4-texel dashes of glint — flat patches that
      // hold up at a distance, not per-texel speckle.
      const sE = vnoise(x & ~1, y * 4, 16, psE ^ 0x5f);
      const s = w > 0 ? sE + (vnoise(x & ~1, y * 4, 16, psV ^ 0x5f) - sE) * w : sE;
      let c = gap ? C.cisWaterMid : C.cisWaterLight;
      if (!gap && s < 0.36) c = C.cisWaterMid;
      if (s > 0.68 && d > 0.2 && h01(x >> 2, y, w < 0.5 ? psE : psV) > 0.4) c = C.cisWaterGlint;
      buf[i] = c;
    }
  }

  // Slime in the dry joints.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      const s = FLAG_STEP[buf[i]];
      if (s < 0 || s > 1) continue;
      const wx = variantWeight(edgeDist(x));
      const wy = variantWeight(edgeDist(y));
      const w = wx < wy ? wx : wy;
      const nE = fbmChunky(x + 21, y + 3, edgeSeed ^ 0x51a);
      const n = w > 0 ? nE + (fbmChunky(x + 21, y + 3, seed ^ 0x51a) - nE) * w : nE;
      const thr = 1 - (EDGE_FLOOR.slime + (o.slime - EDGE_FLOOR.slime) * w) * 0.6;
      if (n > thr) buf[i] = rampPickChunky(SLIME, 0.1 + (n - thr) * 3, x, y);
    }
  }
  return buf;
}

/**
 * Puddle depth field: toroidal noise normalised so 0 is the shore at the `share` coverage quantile
 * and 1 the deepest point (negative is dry).
 * @param {number} ps
 * @param {number} share 0..1 of the tile under water
 * @returns {Float32Array}
 */
function puddleDepth(ps, share) {
  const field = new Float32Array(AREA);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const qx = x & ~1;
      const qy = y & ~1;
      field[(y << 6) | x] = 0.55 * vnoise(qx, qy, 32, ps) + 0.3 * vnoise(qx, qy, 16, ps ^ 1) + 0.15 * vnoise(qx, qy, 8, ps ^ 2);
    }
  }
  const sorted = Float32Array.from(field).sort();
  const thr = sorted[Math.min(AREA - 1, Math.floor(AREA * (1 - share)))];
  const span = sorted[AREA - 1] - thr || 1;
  for (let i = 0; i < AREA; i++) field[i] = (field[i] - thr) / span;
  return field;
}

/**
 * One flagstone: flat worn tone, bevelled edges, chipped corners, grain and an optional crack.
 * @param {Uint8Array} buf
 * @param {number} bx
 * @param {number} by
 * @param {number} bw
 * @param {number} bh
 * @param {number} seed
 * @param {import('../../core/rng.js').Rng} rng
 * @param {number} crackChance
 */
function paintFlag(buf, bx, by, bw, bh, seed, rng, crackChance) {
  const fw = bw - 2;
  const fh = bh - 2;
  const baseT = 0.58 + rng.range(-0.17, 0.14);
  const chip = [rng.int(4), rng.int(4), rng.int(4), rng.int(4)];
  const lo = 2 / 6;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const rx = fw - 1 - x;
      const ry = fh - 1 - y;
      if (x + y < chip[0] || rx + y < chip[1] || x + ry < chip[2] || rx + ry < chip[3]) continue;
      const gx = bx + x;
      const gy = by + y;
      let t = baseT + (fbmChunky(gx, gy, seed ^ 0x1f) - 0.5) * 0.16;
      if (y === 0 || x === 0) t += 0.16;
      if (y === fh - 1 || x === fw - 1) t -= 0.18;
      put(buf, gx, gy, rampPickFlat(FLAG, t < lo ? lo : t));
    }
  }
  const patches = 1 + rng.int(3);
  for (let p = 0; p < patches; p++) {
    const pw = 4 + rng.int(5);
    const ph = 2 + rng.int(3);
    const px = 2 + rng.int(Math.max(1, fw - pw - 3));
    const py = 2 + rng.int(Math.max(1, fh - ph - 3));
    const d = rng.chance(0.5) ? -1 : 1;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) shiftFlag(buf, bx + px + x, by + py + y, d);
  }
  const flecks = 3 + rng.int(4);
  for (let i = 0; i < flecks; i++) {
    shiftFlag(buf, bx + 2 + rng.int(fw - 4), by + 2 + rng.int(fh - 4), rng.chance(0.3) ? 1 : -1);
  }
  if (rng.chance(crackChance)) {
    let cx = 2 + rng.int(fw - 4);
    let cy = 0;
    const drift = rng.chance(0.5) ? 1 : -1;
    const len = 6 + rng.int(fh);
    for (let k = 0; k < len && cy < fh && cx >= 0 && cx < fw; k++) {
      put(buf, bx + cx, by + cy, rng.chance(0.8) ? C.cisFlagShadow : C.cisFlagGap);
      if (rng.chance(0.3)) shiftFlag(buf, bx + cx + 1, by + cy, -1);
      cy++;
      if (rng.chance(0.4)) cx += drift;
    }
  }
}

/**
 * The rare floor tile: a square iron drain grate in a stone collar over black water, set into the
 * middle of the common floor so its border meets the other floors.
 * @param {number} edgeSeed shared by every floor variant
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintGrate(edgeSeed, seed) {
  const buf = paintFloor(edgeSeed, seed, { puddle: 0.18, slime: 0.5, cracks: 0.2 });
  const rng = createRng(seed ^ 0x6a7e);
  const c0 = 13;
  const c1 = 50; // collar spans c0..c1
  const g0 = 18;
  const g1 = 45; // grate opening g0..g1
  // Wet darkening around the drain, stopping short of the shared edge zone.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - 31.5;
      const dy = y - 31.5;
      if (dx * dx + dy * dy < 26 * 26) shiftFlag(buf, x, y, -1);
    }
  }
  for (let y = c0; y <= c1; y++) {
    for (let x = c0; x <= c1; x++) {
      const e = Math.min(x - c0, y - c0, c1 - x, c1 - y);
      if (e === 0) {
        put(buf, x, y, C.cisFlagGap);
        continue;
      }
      let t = 0.72 + (fbmChunky(x, y, seed ^ 0xc011) - 0.5) * 0.25;
      if (y - c0 === 1 || x - c0 === 1) t += 0.16;
      if (c1 - y === 1 || c1 - x === 1) t -= 0.2;
      if (e >= 4) t -= 0.35; // inner lip in shadow
      put(buf, x, y, rampPickFlat(FLAG, t));
    }
  }
  // Water below.
  for (let y = g0; y <= g1; y++) {
    for (let x = g0; x <= g1; x++) {
      const s = vnoise(x, y * 4, 16, seed ^ 0xd4a1);
      put(buf, x, y, s > 0.66 ? C.cisWaterMid : h01(x, y, seed) > 0.97 ? C.cisWaterGlint : C.void);
    }
  }
  // Bars running along y, 2 wide, every 5 texels; two straps across.
  for (let x = g0 + 1; x <= g1 - 1; x += 5) {
    for (let y = g0; y <= g1; y++) {
      put(buf, x, y, C.ironLight);
      put(buf, x + 1, y, C.ironDark);
    }
  }
  for (const sy of [g0 + 6, g1 - 8]) {
    for (let x = g0 - 1; x <= g1 + 1; x++) {
      put(buf, x, sy, C.ironHilite);
      put(buf, x, sy + 1, C.ironBase);
      put(buf, x, sy + 2, C.ironShadow);
    }
  }
  // Frame edge bars.
  for (let k = g0 - 1; k <= g1 + 1; k++) {
    put(buf, k, g0 - 1, C.ironLight);
    put(buf, g0 - 1, k, C.ironLight);
    put(buf, k, g1 + 1, C.ironShadow);
    put(buf, g1 + 1, k, C.ironShadow);
  }
  // Rust, slime at the corners, corner bolts.
  for (let i = 0; i < 40; i++) {
    const x = g0 + rng.int(g1 - g0 + 1);
    const y = g0 + rng.int(g1 - g0 + 1);
    const b = buf[(y << 6) | x];
    if (b === C.ironLight || b === C.ironDark || b === C.ironBase || b === C.ironHilite) {
      put(buf, x, y, rng.chance(0.6) ? C.cisRust : C.oilDark);
    }
  }
  for (const [kx, ky] of [
    [g0, g0],
    [g1, g0],
    [g0, g1],
    [g1, g1],
  ]) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (h01(kx + dx, ky + dy, seed ^ 0x5117) > 0.45) put(buf, kx + dx, ky + dy, rampPickChunky(SLIME, 0.3 + h01(dx, dy, seed) * 0.5, kx + dx, ky + dy));
      }
    }
  }
  for (const [kx, ky] of [
    [c0 + 2, c0 + 2],
    [c1 - 3, c0 + 2],
    [c0 + 2, c1 - 3],
    [c1 - 3, c1 - 3],
  ]) {
    put(buf, kx, ky, C.ironHilite);
    put(buf, kx + 1, ky, C.ironBase);
    put(buf, kx, ky + 1, C.ironBase);
    put(buf, kx + 1, ky + 1, C.ironShadow);
  }
  return buf;
}

// ─── Ceiling ────────────────────────────────────────────────────────────────────────────────────

/**
 * Crown-lit barrel vault tone across the corridor (x in the final painting).
 * @param {number} x
 */
function vaultTone(x) {
  const d = (x - 31.5) / 32;
  return 0.05 - 0.17 * d * d;
}

/**
 * Brick barrel vault; `rib` adds a ribbed stone arch across the tile.
 * @param {number} seed
 * @param {boolean} rib
 * @returns {Uint8Array}
 */
function paintCeiling(seed, rib) {
  const tmp = new Uint8Array(AREA);
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  // Paint courses along x in a scratch buffer, then transpose so they run along the corridor.
  const rowTone = new Float32Array(SIZE);
  for (let y = 0; y < SIZE; y++) rowTone[y] = vaultTone(y) - 0.04;
  paintBricks(tmp, seed, seed, rowTone, 0.2, 0.2); // both ceilings share `seed`, so they meet along y
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) buf[(y << 6) | x] = tmp[(x << 6) | y];

  // Damp patches.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) if (fbmChunky(x, y, seed ^ 0xda3b) > 0.64) shiftBrick(buf, x, y, -1);
  }
  // Slime creeping up from the springings.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const edge = Math.min(x, SIZE - 1 - x);
      if (edge > 7) continue;
      const i = (y << 6) | x;
      const n = fbmChunky(x, y + 17, seed ^ 0x5171) * (1.25 - edge * 0.07);
      if (n > 0.78) buf[i] = rampPickChunky(SLIME, (n - 0.78) * 3, x, y);
    }
  }
  // Calcite spots where water seeps through the joints.
  const spots = 7 + rng.int(4);
  for (let s = 0; s < spots; s++) {
    const x = rng.int(SIZE);
    const y = rng.int(SIZE);
    put(buf, x, y, C.cisLimeMid);
    put(buf, x + 1, y, C.cisLimeDark);
    put(buf, x, y + 1, C.cisLimeDark);
    if (rng.chance(0.5)) put(buf, x + 1, y + 1, C.cisWaterGlint);
  }

  if (rib) {
    const r0 = 22;
    const r1 = 41;
    // Cast shadow on the vault either side of the rib.
    for (let x = 0; x < SIZE; x++) {
      shiftBrick(buf, x, r0 - 1, -2);
      shiftBrick(buf, x, r0 - 2, -1);
      shiftBrick(buf, x, r1 + 1, -3);
      shiftBrick(buf, x, r1 + 2, -2);
      shiftBrick(buf, x, r1 + 3, -1);
    }
    let x0 = rng.int(SIZE);
    let remaining = SIZE;
    while (remaining > 0) {
      let w = remaining <= 22 ? remaining : 11 + rng.int(5);
      if (remaining - w > 0 && remaining - w < 11) w = remaining - 11;
      const baseT = 0.6 + rng.range(-0.1, 0.1);
      for (let x = 0; x < w; x++) {
        const gx = x0 + x;
        for (let y = r0; y <= r1; y++) {
          const e = y - r0;
          let c;
          if (y === r0 || y === r1 || x === 0) c = C.cisFlagGap;
          else if (x === 1) c = C.cisFlagShadow;
          else {
            let t = baseT + vaultTone(gx & MASK) + (fbmChunky(gx, y, seed ^ 0x41b) - 0.5) * 0.2;
            // Moulded profile: lit upper fillet, a raised central roll, shadowed lower chamfer.
            if (e === 1) t += 0.22;
            else if (e === 2) t += 0.1;
            else if (e >= 7 && e <= 9) t += 0.14;
            else if (e === 10) t += 0.26;
            else if (e === 11) t -= 0.18;
            else if (e === 12) t -= 0.08;
            else if (e >= 17) t -= 0.24;
            if (x === w - 1) t -= 0.12;
            c = rampPickFlat(FLAG, t < 0.34 ? 0.34 : t);
          }
          put(buf, gx, y, c);
        }
      }
      x0 += w;
      remaining -= w;
    }
    // Wet stains and limescale drips hanging off the rib's lower edge.
    for (let x = 0; x < SIZE; x++) {
      const n = h01(x, 11, seed ^ 0xd41b);
      if (n > 0.62) {
        const len = 1 + ((n - 0.62) * 10) | 0;
        for (let k = 0; k < len; k++) put(buf, x, r1 + 1 + k, k === len - 1 ? C.cisWaterGlint : C.cisLimeMid);
      }
      if (h01(x, 12, seed ^ 0xd41b) > 0.8) put(buf, x, r1 - 1, C.cisLimeDark);
      if (vnoise(x, 0, 8, seed ^ 0x3e7) > 0.66) for (let y = r0 + 13; y < r1; y++) shiftFlag(buf, x, y, -1);
    }
  }
  return buf;
}

/** @type {import('./index.js').TilesetDef} */
export const TILESET = Object.freeze({
  id: 'cistern',
  name: 'Flooded Cistern',
  fog: 'cisFog',
  paint(seedOf) {
    const wallEdge = seedOf('wallEdge');
    const floorEdge = seedOf('floorEdge');
    return {
      wall: [
        paintWall(wallEdge, seedOf('wall0'), { drips: 3, slime: 0.45, damp: 0.08, spall: 0, bloom: 0, ring: false, drain: false }),
        paintWall(wallEdge, seedOf('wall1'), { drips: 6, slime: 0.72, damp: 0.25, spall: 2, bloom: 1, ring: false, drain: false }),
        paintWall(wallEdge, seedOf('wall2'), { drips: 4, slime: 0.55, damp: 0.12, spall: 0, bloom: 0, ring: true, drain: false }),
        paintWall(wallEdge, seedOf('wall3'), { drips: 3, slime: 0.8, damp: 0.15, spall: 1, bloom: 0, ring: false, drain: true }),
      ],
      floor: [
        paintFloor(floorEdge, seedOf('floor0'), { puddle: 0.22, slime: 0.35, cracks: 0.2 }),
        paintFloor(floorEdge, seedOf('floor1'), { puddle: 0.4, slime: 0.6, cracks: 0.35 }),
        paintGrate(floorEdge, seedOf('floor2')),
      ],
      ceiling: [paintCeiling(seedOf('ceil'), false), paintCeiling(seedOf('ceil'), true)],
    };
  },
});
