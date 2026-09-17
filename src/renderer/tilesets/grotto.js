// @ts-check
/**
 * @file Fungal Grotto tileset — the maze has broken into natural caves.
 *
 * - **Walls** — natural cave rock: irregular boulder-like masses with curved and diagonal fractures,
 *   warped slate layers that swell and pinch out across them, eroded pockets. Two bedding-plane
 *   crevices (`ANCHORS`) run on along a corridor; neither sits on eye-level row 32.
 *   Variants add glowing lichen and hanging roots, clusters of bioluminescent mushrooms standing
 *   on the ledges, and the rare showpiece a tiered shelf-fungus colony.
 * - **Floor** — damp loam with scattered stones and moss, a slab-rock floor with mossy seams, and
 *   the rare fairy ring of glowing mushrooms set into the stony loam. Glowing spore specks on all.
 * - **Ceiling** — lumpy cave roof with stalactite tips; the band variant a thick twisted root.
 *
 * Every texture is painted toroidally (`put` wraps, noise cells divide 64), so floors and ceilings
 * tile on both axes and walls tile horizontally. Glow texels are kept to a few percent of a surface.
 *
 * **Seams across variants.** The raycaster puts any two variants side by side, so everything that
 * touches a tile edge comes from a per-surface EDGE seed shared by every variant: the rock masses and
 * floor cells whose regions reach the edge, the anchors, some faults, pockets, tips and spores. The
 * noise fields (warp, bedding, tone, moss) are blended from the edge seed near the edge to the
 * variant's own seed inside (`mixNoise`, `edgeWeight`), and per-variant structure and decor are kept
 * inside the tile or tapered to a shared baseline, so nothing stops dead at a tile line.
 *
 * Node-safe: no DOM access.
 */

import { createRng } from '../../core/rng.js';
import { C, RAMPS, ramp } from '../palette.js';
import { SIZE, MASK, AREA, put, rampPickChunky, rampPickFlat, h01, vnoise, fbmChunky } from '../textures.js';

const ROCK = ramp('groRock0', 'groRock1', 'groRock2', 'groRock3', 'groRock4', 'groRock5', 'groRock6', 'groRock7', 'groRock8');
const SLATE = ramp('groRock0', 'groRock1', 'groSlate0', 'groSlate1', 'groSlate2', 'groSlate3', 'groSlate4', 'groRock8');
const LOAM = ramp('groRock0', 'groLoam0', 'groLoam1', 'groLoam2', 'groLoam3', 'groRock5');
const WOOD = RAMPS.wood;
const MOSS = RAMPS.moss;

const TAU = Math.PI * 2;

// ─── Cross-variant seams ───────────────────────────────────────────────────────────────────────

/**
 * Distance of line `k` from the nearer tile edge (0 on lines 0 and 63).
 * @param {number} k @returns {number}
 */
function edgeDist(k) {
  return Math.min(k, SIZE - 1 - k);
}

/**
 * How much a texel belongs to the shared edge zone: 1 within `inner` lines of an edge, 0 beyond
 * `outer`, smooth between.
 * @param {number} e distance from the edge @param {number} inner @param {number} outer
 * @returns {number}
 */
function edgeWeight(e, inner, outer) {
  if (e <= inner) return 1;
  if (e >= outer) return 0;
  const t = (outer - e) / (outer - inner);
  return t * t * (3 - 2 * t);
}

/**
 * Blend a shared-seed noise sample `a` with a variant-seed sample `b` by weight `w`, rescaled about
 * 0.5 so the blend keeps the contrast of either (a plain lerp of two independent noises goes flat).
 * @param {number} a @param {number} b @param {number} w @returns {number}
 */
function mixNoise(a, b, w) {
  if (w >= 1) return a;
  if (w <= 0) return b;
  const k = Math.sqrt(w * w + (1 - w) * (1 - w));
  return 0.5 + (a * w + b * (1 - w) - 0.5) / k;
}

/** @param {number} a @param {number} b @param {number} t @returns {number} */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ─── Walls ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Two eroded bedding planes every wall variant shares, identical texel for texel, so they run on
 * along a corridor. The rest of the rock is natural cave rock rather than courses: shared where it
 * reaches the tile's left/right edges, the variant's own in the middle. Neither is near row 32.
 */
const ANCHORS = Int32Array.of(19, 47);
/** Shared seed for the anchors' wobble, so every variant's crevices sit on the same texels. */
const ANCHOR_SEED = 0x6a0770;
/** Walls: fully shared within `WALL_EDGE_IN` columns of an edge, the variant's own past `WALL_EDGE_OUT`. */
const WALL_EDGE_IN = 6;
const WALL_EDGE_OUT = 18;

/**
 * Row of anchor crevice `a` at column `x`.
 * @param {number} a 0 or 1
 * @param {number} x
 * @returns {number}
 */
function anchorY(a, x) {
  return ANCHORS[a] + Math.round((vnoise(x & MASK, 0, 16, ANCHOR_SEED + a * 977) - 0.5) * 2.6);
}

/** Crack map of the wall being painted (1 = crack texel). Rebuilt by `paintRock`, read by decor. */
const crackMask = new Uint8Array(AREA);

/** @param {number} x @param {number} y @returns {boolean} */
function isCrack(x, y) {
  return crackMask[((y & MASK) << 6) | (x & MASK)] === 1;
}

/** Ramp step of a rock texel, or -1. @param {number} c @returns {[Uint8Array|null, number]} */
function rockStep(c) {
  let s = ROCK.indexOf(c);
  if (s >= 0) return [ROCK, s];
  s = SLATE.indexOf(c);
  if (s >= 0) return [SLATE, s];
  return [null, -1];
}

/**
 * Nudge a rock texel along its own ramp (light cast by fungus, pits, crystals).
 * @param {Uint8Array} buf @param {number} x @param {number} y @param {number} d
 */
function shiftRock(buf, x, y, d) {
  const i = ((y & MASK) << 6) | (x & MASK);
  const [r, s] = rockStep(buf[i]);
  if (!r) return;
  const n = Math.max(1, Math.min(r.length - 1, s + d));
  buf[i] = r[n];
}

/** Rock-mass lattice: 4 columns of 16 texels (wraps in x), 4 staggered rows (clamped in y). */
const MASS_COLS = 4;
const MASS_W = SIZE / MASS_COLS;
const MASS_ROWS = 4;
const MASS_H = SIZE / MASS_ROWS;

/**
 * Whether lattice slot (gx, gy) holds an edge mass. Odd rows are staggered half a column right, so
 * the slots whose points can land near x = 0/63 are columns 0 and 3 on even rows, 2 and 3 on odd.
 * @param {number} gx @param {number} gy @returns {boolean}
 */
function isEdgeMass(gx, gy) {
  return gy & 1 ? gx >= 2 : gx === 0 || gx === 3;
}

/**
 * The bare cave rock every wall variant starts from: irregular boulder-like masses (a domain-warped,
 * sheared, weighted Voronoi — so outlines are curved and fractures run diagonally), warped slate
 * layers that swell, pinch out and cross the masses, broken laminations, a few long diagonal
 * fractures, eroded pockets, and the two shared anchor crevices.
 *
 * The masses whose regions reach the left/right edges, the anchors, one fault, some pockets and
 * grain come from `edgeSeed`, the same for every variant; the middle masses, the other faults and
 * pockets from `seed`; the noise fields blend between the two across the edge zone.
 * @param {number} seed
 * @param {number} edgeSeed
 * @returns {Uint8Array}
 */
function paintRock(seed, edgeSeed) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  const erng = createRng(edgeSeed);
  crackMask.fill(0);

  // Per-mass shape: jitter, shear (diagonal fracture lines), weight (size), tone. Edge masses draw
  // from the shared stream; the variant's middle masses are kept clear of the edge zone.
  const n = MASS_COLS * MASS_ROWS;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const shear = new Float64Array(n);
  const weight = new Float64Array(n);
  const tone = new Float64Array(n);
  const edgeMass = new Uint8Array(n);
  for (let gy = 0; gy < MASS_ROWS; gy++) {
    for (let gx = 0; gx < MASS_COLS; gx++) {
      const id = gy * MASS_COLS + gx;
      const shared = isEdgeMass(gx, gy);
      const r = shared ? erng : rng;
      edgeMass[id] = shared ? 1 : 0;
      let x = (gx + (gy & 1) * 0.5 + 0.1 + r.next() * 0.8) * MASS_W;
      if (!shared) x = Math.max(16, Math.min(48, x));
      px[id] = x;
      py[id] = (gy + 0.15 + r.next() * 0.7) * MASS_H;
      shear[id] = r.range(-0.9, 0.9);
      weight[id] = shared ? r.range(0, 5) : r.range(0, 3.5);
      tone[id] = r.range(-0.1, 0.1);
    }
  }

  for (let x = 0; x < SIZE; x++) {
    const w = edgeWeight(edgeDist(x), WALL_EDGE_IN, WALL_EDGE_OUT);
    for (let y = 0; y < SIZE; y++) {
      const i = (y << 6) | x;
      // Domain warp: bends every outline so nothing reads as a rectangle.
      const wx = x + (mixNoise(vnoise(x, y, 16, edgeSeed ^ 0x3a1), vnoise(x, y, 16, seed ^ 0x3a1), w) - 0.5) * 9;
      const wy = y + (mixNoise(vnoise(x, y, 16, edgeSeed ^ 0x3a2), vnoise(x, y, 16, seed ^ 0x3a2), w) - 0.5) * 6;
      const cy0 = Math.floor(wy / MASS_H);
      const cx0 = Math.floor(wx / MASS_W);
      let d1 = 1e9;
      let d2 = 1e9;
      let id1 = 0;
      let id2 = 0;
      let fx = 0;
      let fy = 0;
      for (let gy = cy0 - 1; gy <= cy0 + 1; gy++) {
        if (gy < 0 || gy >= MASS_ROWS) continue;
        for (let gx = cx0 - 2; gx <= cx0 + 2; gx++) {
          const cxw = gx & (MASS_COLS - 1);
          const id = gy * MASS_COLS + cxw;
          const dx = wx - (px[id] + (gx - cxw) * MASS_W);
          const dy = wy - py[id];
          const ex = dx - dy * shear[id];
          const d = Math.sqrt(ex * ex * 0.5 + dy * dy * 1.4) - weight[id];
          if (d < d1) {
            d2 = d1;
            id2 = id1;
            d1 = d;
            id1 = id;
            fx = ex;
            fy = dy;
          } else if (d < d2) {
            d2 = d;
            id2 = id;
          }
        }
      }
      const edge = d2 - d1;

      // Warped bedding: slate layers that swell, thin and pinch out along x.
      const bedA = (vnoise(x, 0, 32, edgeSeed ^ 0x5e1) - 0.5) * 18 + (vnoise(x, y & ~1, 16, edgeSeed ^ 0x5e2) - 0.5) * 7;
      const bedB = (vnoise(x, 0, 32, seed ^ 0x5e1) - 0.5) * 18 + (vnoise(x, y & ~1, 16, seed ^ 0x5e2) - 0.5) * 7;
      const bed = y + lerp(bedB, bedA, w);
      const slateN = mixNoise(
        vnoise(5, bed, 8, edgeSeed ^ 0x5e3) + (vnoise(x, bed, 16, edgeSeed ^ 0x5e4) - 0.5) * 0.7,
        vnoise(5, bed, 8, seed ^ 0x5e3) + (vnoise(x, bed, 16, seed ^ 0x5e4) - 0.5) * 0.7,
        w,
      );
      const r = slateN > 0.6 ? SLATE : ROCK;

      // Fracture between masses; some neighbours are fused, leaving only a faint seam.
      const lo = Math.min(id1, id2);
      const hi = Math.max(id1, id2);
      const pairSeed = edgeMass[lo] && edgeMass[hi] ? edgeSeed : seed;
      const fused = lo !== hi && h01(lo, hi, pairSeed ^ 0xf05) < 0.45;
      // Fractures die out and resume along their length instead of closing every mass.
      const broken = mixNoise(vnoise(x, y, 8, edgeSeed ^ 0xb0c), vnoise(x, y, 8, seed ^ 0xb0c), w) < 0.3;
      const width = 0.5 + mixNoise(vnoise(x, y, 8, edgeSeed ^ 0x77d), vnoise(x, y, 8, seed ^ 0x77d), w) * 1.5;
      if (!fused && !broken && edge < width) {
        buf[i] = r[edge < width * 0.45 ? 0 : 1];
        crackMask[i] = 1;
        continue;
      }

      let t = 0.5 + tone[id1] + (mixNoise(fbmChunky(x, y, edgeSeed), fbmChunky(x, y, seed), w) - 0.5) * 0.4;
      t -= Math.max(-6, Math.min(6, fy)) * 0.018; // boulders catch the light on their upper half
      if (!fused && !broken && edge < width + 1.6) t += fy + fx * 0.25 < 0 ? 0.24 : -0.22; // lit lip / shadowed underside
      else if ((fused || broken) && edge < 1) t -= 0.1;
      // Lamination: broken hairlines following the warped bedding.
      const lam = bed / 4.6 - Math.floor(bed / 4.6);
      if (lam < 0.2 && mixNoise(vnoise(x, y & ~3, 8, edgeSeed ^ 0x1a1), vnoise(x, y & ~3, 8, seed ^ 0x1a1), w) > 0.5) t -= 0.12;
      buf[i] = rampPickFlat(r, t);
    }
  }

  // Long diagonal fractures cutting across masses and layers: one shared (it may cross the tile
  // edge), and the variant's own, which start in the middle and head inward so they end inside.
  paintFault(buf, erng, erng.int(SIZE), 12 + erng.int(20), 0);
  const faults = 1 + rng.int(2);
  for (let f = 0; f < faults; f++) {
    const x0 = 18 + rng.int(28);
    paintFault(buf, rng, x0, 12 + rng.int(12), x0 < 32 ? 1 : -1);
  }

  // The two shared anchor crevices: 1–3 rows deep, lit ledge below, undercut above.
  for (let a = 0; a < ANCHORS.length; a++) {
    for (let x = 0; x < SIZE; x++) {
      const ay = anchorY(a, x);
      const cn = vnoise(x, a * 16, 8, ANCHOR_SEED ^ 0xc4e);
      const thick = 1 + (cn > 0.5 ? 1 : 0) + (cn > 0.8 ? 1 : 0);
      shiftRock(buf, x, ay - 1, -2);
      for (let k = 0; k < thick; k++) {
        const i = (((ay + k) & MASK) << 6) | x;
        const [rr] = rockStep(buf[i]);
        buf[i] = (rr || ROCK)[k === 0 && h01(x, a, ANCHOR_SEED ^ 0x3c3) < 0.75 ? 0 : 1];
        crackMask[i] = 1;
      }
      if (vnoise(x, a * 8, 16, ANCHOR_SEED ^ 0x1ed) > 0.3) {
        shiftRock(buf, x, ay + thick, 3);
        shiftRock(buf, x, ay + thick + 1, 1);
      }
    }
  }

  // Eroded pockets: shared ones anywhere, the variant's own inside the tile.
  const shared = 2 + erng.int(2);
  for (let p = 0; p < shared; p++) paintPocket(buf, erng.int(SIZE), erng.int(SIZE), 2 + erng.int(3), 1 + erng.int(2));
  const pockets = 3 + rng.int(3);
  for (let p = 0; p < pockets; p++) paintPocket(buf, 10 + rng.int(45), rng.int(SIZE), 2 + rng.int(3), 1 + rng.int(2));

  // Grain: single-texel pits and mica glints — shared across the tile, plus the variant's inside it.
  for (let g = 0; g < 150; g++) {
    const own = g >= 90;
    const r = own ? rng : erng;
    const x = own ? 4 + r.int(56) : r.int(SIZE);
    const y = r.int(SIZE);
    const lift = r.chance(0.25);
    if (isCrack(x, y) || isCrack(x, y - 1)) continue;
    shiftRock(buf, x, y, lift ? 1 : -1);
  }
  return buf;
}

/**
 * One long diagonal fracture running down the wall.
 * @param {Uint8Array} buf @param {import('../../core/rng.js').Rng} rng @param {number} x0
 * @param {number} len @param {number} dir 1 / -1 to force its drift, 0 for either
 */
function paintFault(buf, rng, x0, len, dir) {
  let x = x0;
  let y = rng.int(SIZE);
  const side = dir || (rng.chance(0.5) ? 1 : -1);
  const sx = side * (dir ? rng.range(0.5, 0.9) : rng.range(0.5, 1.3));
  for (let k = 0; k < len; k++) {
    const ix = Math.round(x);
    const i = ((y & MASK) << 6) | (ix & MASK);
    const [rr] = rockStep(buf[i]);
    if (rr) buf[i] = rr[1];
    crackMask[i] = 1;
    shiftRock(buf, ix - Math.sign(sx), y, 2);
    shiftRock(buf, ix + Math.sign(sx), y, -1);
    y++;
    x += sx + (rng.next() - 0.5) * 0.8;
  }
}

/**
 * An eroded pocket: a dark hollow with a lit lower lip.
 * @param {Uint8Array} buf @param {number} cx @param {number} cy @param {number} rx @param {number} ry
 */
function paintPocket(buf, cx, cy, rx, ry) {
  for (let yy = -ry; yy <= ry + 1; yy++) {
    for (let xx = -rx; xx <= rx; xx++) {
      if (isCrack(cx + xx, cy + yy)) continue;
      const d = (xx * xx) / (rx * rx) + (yy * yy) / (ry * ry);
      if (d <= 0.55) shiftRock(buf, cx + xx, cy + yy, -3);
      else if (d <= 1) shiftRock(buf, cx + xx, cy + yy, yy > 0 ? 2 : -1);
    }
  }
}

/**
 * Damp moss hugging the ledges: the texels just below a crack. Toward the tile edges both the moss
 * noise and its amount settle to a shared baseline, so a ledge's moss runs on into the next tile.
 * @param {Uint8Array} buf @param {number} seed @param {number} edgeSeed @param {number} amount 0..1
 */
function paintLedgeMoss(buf, seed, edgeSeed, amount) {
  for (let x = 0; x < SIZE; x++) {
    const w = edgeWeight(edgeDist(x), WALL_EDGE_IN, WALL_EDGE_OUT);
    const amt = lerp(amount, LEDGE_MOSS_EDGE, w);
    for (let y = 0; y < SIZE; y++) {
      const i = (y << 6) | x;
      const dy = crackMask[i] ? 0 : isCrack(x, y - 1) ? 1 : isCrack(x, y - 2) ? 2 : isCrack(x, y - 3) ? 3 : 9;
      if (dy > 3) continue;
      const nn = mixNoise(fbmChunky(x + 13, y * 3, edgeSeed ^ 0x77e), fbmChunky(x + 13, y * 3, seed ^ 0x77e), w) * (dy === 0 ? 1.2 : 1.35 - dy * 0.18);
      if (nn > 1 - amt * 0.5) buf[i] = rampPickChunky(MOSS, 0.15 + (nn - (1 - amt * 0.5)) * 4, x, y);
    }
  }
}

/** Ledge moss amount every wall variant shares at its left and right edges. */
const LEDGE_MOSS_EDGE = 0.26;

/**
 * Lichen clusters: a scatter of dim teal/purple dots with a few glowing texels, kept inside the
 * tile (columns 8–56) so no cluster is cut by the edge of a neighbouring variant.
 * @param {Uint8Array} buf @param {import('../../core/rng.js').Rng} rng @param {number} count
 */
function paintLichen(buf, rng, count) {
  for (let n = 0; n < count; n++) {
    const cx = 12 + rng.int(41);
    const cy = rng.int(SIZE);
    const violet = rng.chance(0.45);
    const dim = violet ? C.groCapPurple : C.groCapTeal;
    const glow = violet ? C.groGlowViolet : C.groGlowCyan;
    const core = violet ? C.groGlowLilac : C.groGlowMint;
    const dots = 6 + rng.int(6);
    for (let d = 0; d < dots; d++) {
      const x = cx + Math.round((rng.next() - 0.5) * 8);
      const y = cy + Math.round((rng.next() - 0.5) * 5);
      if (isCrack(x, y)) continue;
      put(buf, x, y, dim);
      if (rng.chance(0.5)) put(buf, x + 1, y, dim);
    }
    const glows = 2 + rng.int(3);
    for (let g = 0; g < glows; g++) {
      const x = cx + Math.round((rng.next() - 0.5) * 6);
      const y = cy + Math.round((rng.next() - 0.5) * 4);
      put(buf, x, y, g === 0 ? core : glow);
      put(buf, x + 1, y, glow);
      if (g === 0) put(buf, x, y + 1, glow);
    }
  }
}

/**
 * Roots hanging from the top of the wall: wobbling 1–2 texel strands with little side rootlets,
 * hanging inside the tile (their wobble is held within columns 6–56).
 * @param {Uint8Array} buf @param {import('../../core/rng.js').Rng} rng @param {number} count
 * @param {number} seed
 */
function paintRoots(buf, rng, count, seed) {
  for (let v = 0; v < count; v++) {
    const sx = 12 + rng.int(39);
    const len = 14 + rng.int(26);
    const thick = rng.chance(0.6);
    let fx = sx;
    for (let y = 0; y < len; y++) {
      fx = Math.max(6, Math.min(54, fx + (h01(sx, y, seed ^ 0x2007) - 0.5) * 1.1));
      const ix = Math.round(fx);
      const taper = y > len * 0.6;
      put(buf, ix, y, (y & 3) === 1 ? C.woodBright : C.woodLight);
      if (thick && !taper) put(buf, ix + 1, y, C.woodDark);
      else put(buf, ix + 1, y, C.woodShadow);
      if (y % 7 === 4 && y < len - 4) {
        const side = h01(sx, y, seed ^ 0x51) < 0.5 ? -1 : 1;
        put(buf, ix + side, y + 1, C.woodBase);
        put(buf, ix + side * 2, y + 2, C.woodBase);
        put(buf, ix + side * 3, y + 3, C.woodMid);
      }
    }
    put(buf, Math.round(fx), len, C.woodMid);
  }
}

/**
 * A single bioluminescent mushroom standing on row `by`, cap glowing, with its light cast on the
 * surrounding rock.
 * @param {Uint8Array} buf @param {number} mx @param {number} by @param {number} h stem height
 * @param {number} capW 3..7 @param {boolean} violet
 */
function paintMushroom(buf, mx, by, h, capW, violet) {
  const glow = violet ? C.groGlowViolet : C.groGlowCyan;
  const core = violet ? C.groGlowLilac : C.groGlowMint;
  const under = violet ? C.groCapPurple : C.groCapTeal;
  const half = capW >> 1;
  const capH = capW >= 7 ? 4 : capW >= 5 ? 3 : 2;
  const top = by - h - capH + 1;
  // Light spill onto the rock around the cap.
  const sr = half + 4;
  for (let yy = -sr; yy <= sr; yy++) {
    for (let xx = -sr; xx <= sr; xx++) {
      if (xx * xx + yy * yy * 2 > sr * sr) continue;
      shiftRock(buf, mx + xx, top + capH - 1 + yy, xx * xx + yy * yy * 2 < (sr * sr) / 3 ? 2 : 1);
    }
  }
  for (let i = 0; i < h; i++) {
    put(buf, mx, by - i, C.groStemPale);
    if (capW >= 5) put(buf, mx + 1, by - i, C.groStemDark);
  }
  put(buf, mx - 1, by, C.groStemDark);
  if (capW >= 5) put(buf, mx + 2, by, C.groStemDark);
  // Domed cap: narrow top, full width at the rim, a dim gill line underneath.
  for (let r = 0; r < capH; r++) {
    const f = (capH - 1 - r) / capH;
    const w = Math.max(1, Math.round(half * Math.sqrt(1 - f * f)));
    for (let xx = -w; xx <= w; xx++) {
      const underside = r === capH - 1;
      put(buf, mx + xx, top + r, underside ? (((xx + w) & 1) === 0 ? under : glow) : glow);
    }
  }
  // Pale glints: the lit crown of the cap.
  put(buf, mx - 1, top + (capH > 2 ? 1 : 0), core);
  if (capW >= 5) put(buf, mx, top, core);
  if (capW >= 7) put(buf, mx - 2, top + 2, core);
}

/**
 * A cluster of mushrooms on a ledge: small ones first, the big one last so it stands in front.
 * With its light spill it spans cx ± 16, so callers keep cx within 22–42.
 * @param {Uint8Array} buf @param {import('../../core/rng.js').Rng} rng
 * @param {number} a anchor crevice they stand on @param {number} cx
 */
function paintMushroomCluster(buf, rng, a, cx) {
  const n = 3 + rng.int(3);
  const violet = rng.chance(0.4);
  for (let m = n - 1; m >= 0; m--) {
    const big = m === 0;
    const mx = cx + (big ? 0 : (m & 1 ? -1 : 1) * (4 + rng.int(5)));
    const by = anchorY(a, mx & MASK);
    const capW = big ? 7 + 2 * rng.int(2) : 3 + 2 * rng.int(2);
    const h = big ? 4 + rng.int(3) : 2 + rng.int(3);
    paintMushroom(buf, mx, by, h, capW, rng.chance(0.2) ? !violet : violet);
  }
}

/**
 * A tiered shelf-fungus colony: overlapping brackets with ringed tan tops and glowing gill rims.
 * The tiers span cx − 16 … cx + 15, so the colony is centred within 22–42 and stays inside the tile.
 * @param {Uint8Array} buf @param {import('../../core/rng.js').Rng} rng
 */
function paintShelfColony(buf, rng) {
  const cx = 22 + rng.int(21);
  const tiers = [
    { dx: 2, y: 11, w: 11 },
    { dx: -8, y: 21, w: 15 },
    { dx: 7, y: 29, w: 13 },
    { dx: -4, y: 43, w: 19 },
    { dx: 9, y: 53, w: 11 },
  ];
  for (const s of tiers) {
    const bx = cx + s.dx;
    const hw = s.w >> 1;
    const hh = 3 + (s.w > 12 ? 1 : 0) + (s.w > 16 ? 1 : 0);
    // Violet light spilling down the rock under the gills, and the bracket's shadow right below.
    for (let yy = 1; yy <= 6; yy++) {
      for (let xx = -hw - 1; xx <= hw + 1; xx++) {
        if (yy <= 2 && Math.abs(xx) < hw - 1) shiftRock(buf, bx + xx, s.y + yy + 1, -2);
        else if (yy > 2 && Math.abs(xx) < hw + 2 - yy) shiftRock(buf, bx + xx, s.y + yy, 1);
      }
    }
    // Upper half-ellipse: ringed bracket top.
    for (let yy = -hh; yy <= 0; yy++) {
      for (let xx = -hw; xx <= hw; xx++) {
        const d = (xx * xx) / (hw * hw) + (yy * yy) / (hh * hh);
        if (d > 1) continue;
        const ring = Math.floor(d * 4);
        let c = ring % 2 === 0 ? C.mapLight : C.mapMid;
        if (d > 0.72) c = C.mapPale; // pale growing edge
        if (yy === 0 && d > 0.5) c = C.mapMid;
        if (xx > hw * 0.5 && yy > -hh + 1 && d <= 0.72) c = C.mapDark; // shaded right flank
        put(buf, bx + xx, s.y + yy, c);
      }
    }
    // Underside: dark gills with a glowing violet rim, and a few luminous drips below it.
    for (let xx = -hw + 1; xx <= hw - 1; xx++) {
      put(buf, bx + xx, s.y + 1, (xx & 1) === 0 ? C.groGlowViolet : C.groCapPurple);
      if ((xx & 3) === 1 && Math.abs(xx) < hw - 2) put(buf, bx + xx, s.y + 2, C.groCapPurple);
    }
    put(buf, bx - hw + 2, s.y + 1, C.groGlowLilac);
    put(buf, bx + 1, s.y + 1, C.groGlowLilac);
    put(buf, bx - hw, s.y, C.mapShadow);
    put(buf, bx + hw, s.y, C.mapShadow);
  }
}

/**
 * @param {number} seed the variant's own seed
 * @param {number} edgeSeed shared by every wall variant
 * @param {number} variant 0..3
 * @returns {Uint8Array}
 */
function paintWall(seed, edgeSeed, variant) {
  const buf = paintRock(seed, edgeSeed);
  const rng = createRng(seed ^ 0x9e3779b9);
  if (variant === 0) {
    paintLedgeMoss(buf, seed, edgeSeed, 0.18);
  } else if (variant === 1) {
    paintLedgeMoss(buf, seed, edgeSeed, 0.3);
    paintLichen(buf, rng, 4);
    paintRoots(buf, rng, 3, seed);
  } else if (variant === 2) {
    paintLedgeMoss(buf, seed, edgeSeed, 0.35);
    paintLichen(buf, rng, 1);
    // One cluster on each ledge, set apart along the wall.
    const x1 = 22 + rng.int(8);
    paintMushroomCluster(buf, rng, 0, x1);
    paintMushroomCluster(buf, rng, 1, x1 + 7 + rng.int(7));
  } else {
    paintLedgeMoss(buf, seed, edgeSeed, 0.4);
    paintRoots(buf, rng, 2, seed);
    paintShelfColony(buf, rng);
    paintLichen(buf, rng, 2);
  }
  return buf;
}

// ─── Floors ────────────────────────────────────────────────────────────────────────────────────

const CELLS = 4;
const SPAN = SIZE / CELLS;
/** Floors: fully shared within `FLOOR_EDGE_IN` lines of any edge, the variant's own past `FLOOR_EDGE_OUT`. */
const FLOOR_EDGE_IN = 1;
const FLOOR_EDGE_OUT = 8;

/**
 * Whether a floor cell touches the tile border (the 12 outer cells of the 4×4 lattice). Their
 * points, presence, size and tone come from the shared edge seed, so every floor variant lays the
 * same stones along its edges; only the 4 middle cells are the variant's own.
 * @param {number} wx @param {number} wy @returns {boolean}
 */
function isBorderCell(wx, wy) {
  return wx === 0 || wy === 0 || wx === CELLS - 1 || wy === CELLS - 1;
}

/**
 * Jittered toroidal Voronoi: nearest feature id, offset to it, the edge distance, and the seed that
 * owns the nearest cell (`edgeSeed` for a border cell, `seed` for a middle one).
 * @param {number} x @param {number} y @param {number} seed @param {number} edgeSeed
 * @param {Float64Array} out [id, fx, fy, edge, cellSeed]
 */
function voronoi(x, y, seed, edgeSeed, out) {
  let d1 = 1e9;
  let d2 = 1e9;
  const cx0 = Math.floor(x / SPAN);
  const cy0 = Math.floor(y / SPAN);
  for (let gy = cy0 - 1; gy <= cy0 + 1; gy++) {
    for (let gx = cx0 - 1; gx <= cx0 + 1; gx++) {
      const wx = gx & (CELLS - 1);
      const wy = gy & (CELLS - 1);
      const cs = isBorderCell(wx, wy) ? edgeSeed : seed;
      const jx = (gx + 0.2 + 0.6 * h01(wx, wy, cs)) * SPAN;
      const jy = (gy + 0.2 + 0.6 * h01(wx, wy, cs ^ 0x1234)) * SPAN;
      const dx = x - jx;
      const dy = y - jy;
      const d = dx * dx + dy * dy;
      if (d < d1) {
        d2 = d1;
        d1 = d;
        out[0] = (wy << 2) | wx;
        out[1] = dx;
        out[2] = dy;
        out[4] = cs;
      } else if (d < d2) d2 = d;
    }
  }
  out[3] = Math.sqrt(d2) - Math.sqrt(d1);
}

/**
 * Scatter tiny glowing spores: single texels, some with a dim halo texel, between `lo` and `hi`
 * on both axes (0 and 64 for anywhere; the halo may wrap).
 * @param {Uint8Array} buf @param {import('../../core/rng.js').Rng} rng @param {number} count
 * @param {number} [lo] @param {number} [hi]
 */
function paintSpores(buf, rng, count, lo = 0, hi = SIZE) {
  for (let n = 0; n < count; n++) {
    const x = lo + rng.int(hi - lo);
    const y = lo + rng.int(hi - lo);
    const violet = rng.chance(0.4);
    put(buf, x, y, violet ? C.groGlowViolet : C.groGlowCyan);
    if (rng.chance(0.5)) put(buf, x + 1, y, violet ? C.groCapPurple : C.groCapTeal);
    if (rng.chance(0.3)) put(buf, x, y + 1, violet ? C.groCapPurple : C.groCapTeal);
  }
}

/**
 * How a floor variant dresses its middle; the border wears `FLOOR_EDGE` whatever the variant.
 * @typedef {Object} FloorStyle
 * @property {number} cover  chance a middle cell holds a stone
 * @property {number} rMin   stone radius (texels) …
 * @property {number} rVar   … plus up to this much per cell; a huge radius fills the cell (slabs)
 * @property {number} gap    minimum seam between neighbouring stones …
 * @property {number} gapVar … plus up to this much with the noise
 * @property {number} moss   how much of the loam between stones is moss
 * @property {number} loamT  ramp position of that loam (lower = darker, wetter)
 * @property {boolean} [ring] the fairy ring: stones shrink away toward the middle of the tile
 */

/** The stony loam every floor variant shares along its edges: flat stones set in damp loam. @type {FloorStyle} */
const FLOOR_EDGE = Object.freeze({ cover: 0.8, rMin: 6.5, rVar: 3.5, gap: 1.4, gapVar: 1.2, moss: 0.34, loamT: 0.34 });
/** Loam floor: scattered half-buried stones. @type {FloorStyle} */
const LOAM_FLOOR = Object.freeze({ cover: 0.55, rMin: 5, rVar: 4, gap: 0.6, gapVar: 0, moss: 0.3, loamT: 0.42 });
/** Slab floor: stones grown into slabs that fill their cells, with mossy seams. @type {FloorStyle} */
const SLAB_FLOOR = Object.freeze({ cover: 1, rMin: 40, rVar: 0, gap: 1.8, gapVar: 2.2, moss: 0.85, loamT: 0.22 });
/** Fairy ring: bare mossy loam in the middle, the shared stones only round the outside. @type {FloorStyle} */
const RING_FLOOR = Object.freeze({ cover: 0, rMin: 0, rVar: 0, gap: 1.4, gapVar: 1.2, moss: 0.45, loamT: 0.42, ring: true });

/**
 * Stones on damp loam — the one floor painter behind all three floor variants. Border cells and the
 * noise near the edges are shared (see `isBorderCell`, `FLOOR_EDGE`); stone size, seam width, moss
 * and loam tone blend per texel from the edge style to the variant's, so a stone that reaches into
 * the middle of a slab floor swells into a slab rather than being cut.
 * @param {number} seed @param {number} edgeSeed @param {FloorStyle} style
 * @returns {Uint8Array}
 */
function paintStoneFloor(seed, edgeSeed, style) {
  const buf = new Uint8Array(AREA);
  const v = new Float64Array(5);
  const E = FLOOR_EDGE;
  for (let y = 0; y < SIZE; y++) {
    const ey = edgeDist(y);
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      const w = edgeWeight(Math.min(edgeDist(x), ey), FLOOR_EDGE_IN, FLOOR_EDGE_OUT);
      voronoi(x, y, seed, edgeSeed, v);
      const id = v[0];
      const cs = v[4];
      const border = isBorderCell(id & 3, id >> 2);
      const noise = mixNoise(fbmChunky(x, y, edgeSeed ^ 0x5a5), fbmChunky(x, y, seed ^ 0x5a5), w);

      // Stone shape: a Chebyshev/Euclid blend gives flat-sided, angular stones rather than round domes.
      const ax = Math.abs(v[1]);
      const ay = Math.abs(v[2]);
      const r = 0.55 * Math.max(ax, ay) + 0.45 * Math.sqrt(ax * ax + ay * ay) + (ax + ay) * 0.12;
      const present = border ? h01(id, 7, cs ^ 0xbee) < E.cover : h01(id, 7, cs ^ 0xbee) < style.cover;
      const rEdge = E.rMin + h01(id, 3, cs) * E.rVar;
      let rOwn = style.rMin + h01(id, 3, cs) * style.rVar;
      if (style.ring) {
        const dx = x - 31.5;
        const dy = y - 31.5;
        rOwn = rEdge * Math.max(0, Math.min(1, (Math.sqrt(dx * dx + dy * dy) - 23) / 7));
      }
      const radius = lerp(rOwn, rEdge, w) + (noise - 0.5) * 4;
      const gap = lerp(style.gap + noise * style.gapVar, E.gap + noise * E.gapVar, w);
      const inStone = present && r <= radius && v[3] >= gap;

      if (!inStone) {
        if (present && (r <= radius + 1.2 && v[3] >= gap - 1)) {
          buf[i] = LOAM[1]; // damp contact ring
          continue;
        }
        const m = mixNoise(fbmChunky(x + 23, y + 7, edgeSeed ^ 0x2f5), fbmChunky(x + 23, y + 7, seed ^ 0x2f5), w);
        const n = mixNoise(fbmChunky(x, y, edgeSeed ^ 0x10a), fbmChunky(x, y, seed ^ 0x10a), w);
        const moss = lerp(style.moss, E.moss, w);
        const loamT = lerp(style.loamT, E.loamT, w);
        buf[i] =
          m > 1 - moss * 0.6
            ? rampPickChunky(MOSS, Math.min(0.6, 0.2 + (m - (1 - moss * 0.6)) * 3.2), x, y)
            : rampPickChunky(LOAM, loamT + (n - 0.5) * 0.7, x, y);
        continue;
      }
      const lip = v[1] + v[2]; // < 0 toward the top-left, where the light is
      let t = 0.4 + h01(id, 9, cs) * 0.22 + (noise - 0.5) * 0.24 - lip * 0.006;
      if (r > radius - 1.6 || v[3] < gap + 1.5) t += lip < 0 ? 0.2 : -0.16; // lit upper edge, shaded lower edge
      buf[i] = rampPickFlat(h01(id, 2, cs ^ 0x51a7) < 0.3 ? SLATE : ROCK, t);
    }
  }
  return buf;
}

/**
 * Loam floor with half-buried angular stones.
 * @param {number} seed @param {number} edgeSeed
 * @returns {Uint8Array}
 */
function paintLoamFloor(seed, edgeSeed) {
  const buf = paintStoneFloor(seed, edgeSeed, LOAM_FLOOR);
  paintSpores(buf, createRng(edgeSeed), 3);
  paintSpores(buf, createRng(seed), 5, 4, 60);
  return buf;
}

/**
 * Slab-rock floor: flat stones grown together, with mossy, loamy seams.
 * @param {number} seed @param {number} edgeSeed
 * @returns {Uint8Array}
 */
function paintSlabFloor(seed, edgeSeed) {
  const buf = paintStoneFloor(seed, edgeSeed, SLAB_FLOOR);
  paintSpores(buf, createRng(edgeSeed), 3);
  paintSpores(buf, createRng(seed), 4, 4, 60);
  return buf;
}

/**
 * Rare floor: a fairy ring of glowing mushrooms seen from above, on mossy loam set into the shared
 * stony border.
 * @param {number} seed @param {number} edgeSeed
 * @returns {Uint8Array}
 */
function paintFairyRing(seed, edgeSeed) {
  const buf = paintStoneFloor(seed, edgeSeed, RING_FLOOR);
  const rng = createRng(seed);
  const RING = 17;
  // The ring of darker, trampled earth the caps grow in.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - 32;
      const dy = y - 32;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs(d - RING) < 3.2 + fbmChunky(x, y, seed ^ 0x99) * 1.5) {
        buf[(y << 6) | x] = rampPickChunky(LOAM, 0.12 + fbmChunky(x, y, seed) * 0.2, x, y);
      }
    }
  }
  const n = 9;
  for (let m = 0; m < n; m++) {
    const a = (m / n) * TAU + rng.range(-0.18, 0.18);
    const rr = RING + rng.range(-1.5, 1.5);
    const cx = Math.round(32 + Math.cos(a) * rr);
    const cy = Math.round(32 + Math.sin(a) * rr);
    const big = rng.chance(0.5);
    const rad = big ? 3 : 2;
    const violet = m % 3 === 2;
    const glow = violet ? C.groGlowViolet : C.groGlowCyan;
    const core = violet ? C.groGlowLilac : C.groGlowMint;
    const rim = violet ? C.groCapPurple : C.groCapTeal;
    // Shadow down-right, then the round cap.
    for (let yy = -rad; yy <= rad + 1; yy++) {
      for (let xx = -rad; xx <= rad + 1; xx++) {
        const d = (xx - 1) * (xx - 1) + (yy - 1) * (yy - 1);
        if (d <= rad * rad) put(buf, cx + xx, cy + yy, LOAM[0]);
      }
    }
    for (let yy = -rad; yy <= rad; yy++) {
      for (let xx = -rad; xx <= rad; xx++) {
        const d = xx * xx + yy * yy;
        if (d > rad * rad + 1) continue;
        put(buf, cx + xx, cy + yy, d >= rad * rad - 1 ? rim : glow);
      }
    }
    put(buf, cx - 1, cy - 1, core);
    if (big) put(buf, cx, cy - 1, core);
  }
  paintSpores(buf, createRng(edgeSeed), 3);
  paintSpores(buf, rng, 7, 10, 54);
  return buf;
}

// ─── Ceilings ──────────────────────────────────────────────────────────────────────────────────

/** Ceilings: rows within `CEIL_EDGE_IN` of the top/bottom edge are shared, past `CEIL_EDGE_OUT` the variant's own. */
const CEIL_EDGE_IN = 4;
const CEIL_EDGE_OUT = 16;

/**
 * Lumpy cave roof with stalactite tips; optionally a thick twisted root crossing along x. The two
 * ceilings meet along y, so the lumps and a few tips near the top/bottom rows come from the shared
 * `edgeSeed`, the variant's own tips stay clear of those rows, and the root keeps to rows 11–49.
 * @param {number} seed
 * @param {number} edgeSeed shared by both ceilings
 * @param {boolean} root
 * @returns {Uint8Array}
 */
function paintCeiling(seed, edgeSeed, root) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  const erng = createRng(edgeSeed);
  for (let y = 0; y < SIZE; y++) {
    const w = edgeWeight(edgeDist(y), CEIL_EDGE_IN, CEIL_EDGE_OUT);
    for (let x = 0; x < SIZE; x++) {
      const lump = mixNoise(vnoise(x & ~1, y & ~1, 16, edgeSeed ^ 0x707), vnoise(x & ~1, y & ~1, 16, seed ^ 0x707), w);
      const fine = mixNoise(fbmChunky(x, y, edgeSeed), fbmChunky(x, y, seed), w);
      // Ridge where the lump noise crosses mid-level: a dark seam between bulges.
      const seam = Math.abs(lump - 0.5) < 0.03;
      let t = 0.26 + lump * 0.3 + (fine - 0.5) * 0.25;
      if (seam) t -= 0.18;
      buf[(y << 6) | x] = rampPickFlat(ROCK, t);
    }
  }
  // Stalactite tips: an irregular cone seen from below — lit on the upper-left, a dark shadow
  // smeared down-right, a bright wet point. Sizes and shapes vary so they never read as rivets.
  // Shared tips may sit on the top/bottom edge; the variant's own (a tip spans ±6) stay inside.
  const sharedTips = 3;
  const tips = sharedTips + (root ? 4 : 6) + rng.int(3);
  for (let n = 0; n < tips; n++) {
    const own = n >= sharedTips;
    const r = own ? rng : erng;
    const cx = r.int(SIZE);
    // (the root variant keeps its own tips off the root and its shadow, rows 17–43)
    const cy = !own ? (r.int(16) - 8) & MASK : root ? (r.chance(0.5) ? 10 + r.int(7) : 44 + r.int(10)) : 10 + r.int(44);
    const rad = 1.6 + r.next() * 2.2;
    const sx = r.range(0.7, 1.4); // squash so no two cones share an outline
    for (let yy = -5; yy <= 6; yy++) {
      for (let xx = -5; xx <= 6; xx++) {
        const ex = xx / sx;
        const d = Math.sqrt(ex * ex + yy * yy) + (h01(cx + xx, cy + yy, (own ? seed : edgeSeed) ^ 0x5717) - 0.5) * 0.9;
        const sh = Math.sqrt((ex - 1.5) * (ex - 1.5) + (yy - 1.5) * (yy - 1.5));
        if (d <= rad) {
          const lit = -ex - yy;
          put(buf, cx + xx, cy + yy, d < rad * 0.4 ? C.groRock6 : lit > 0.5 ? C.groRock5 : lit < -1.2 ? C.groRock2 : C.groRock4);
        } else if (sh <= rad + 0.6) {
          shiftRock(buf, cx + xx, cy + yy, -2);
        }
      }
    }
    put(buf, cx, cy, rad > 2.6 ? C.groRock8 : C.groRock7);
    if (r.chance(0.3)) put(buf, cx, cy, r.chance(0.5) ? C.groGlowCyan : C.groGlowMint); // glowing drip
  }

  if (root) {
    // Two strands twisting round each other, period 32 so the root tiles along x.
    const cyA = 30;
    for (let x = 0; x < SIZE; x++) {
      const s = Math.sin((x / 32) * TAU);
      const centres = [cyA + s * 3.2, cyA - s * 3.2];
      const front = Math.cos((x / 32) * TAU) > 0 ? 0 : 1;
      // Cast shadow on the rock either side.
      for (let yy = cyA - 11; yy <= cyA + 11; yy++) {
        const near = Math.min(Math.abs(yy - centres[0]), Math.abs(yy - centres[1]));
        if (near > 4.5 && near < 7.5) shiftRock(buf, x, yy, near < 6 ? -2 : -1);
      }
      for (const order of [1 - front, front]) {
        const c = centres[order];
        for (let yy = Math.floor(c - 5); yy <= Math.ceil(c + 5); yy++) {
          const d = (yy - c) / 4.6;
          if (Math.abs(d) > 1) continue;
          const bark = vnoise(x & ~1, (yy & ~1) * 4, 8, seed ^ (0x22 + order)) - 0.5;
          let t = 0.62 - d * 0.32 - d * d * 0.3 + bark * 0.3;
          if (order !== front) t -= 0.12;
          if (Math.abs(d) > 0.82) t = 0.08;
          put(buf, x, yy, rampPickChunky(WOOD, t, x, yy));
        }
      }
    }
    // Rootlets splaying out onto the rock.
    for (let n = 0; n < 7; n++) {
      let fx = rng.int(SIZE);
      let fy = cyA + (rng.chance(0.5) ? 5 : -5);
      const dir = fy > cyA ? 1 : -1;
      const len = 5 + rng.int(9);
      for (let k = 0; k < len; k++) {
        put(buf, Math.round(fx), fy, k < 3 ? C.woodBase : C.woodMid);
        put(buf, Math.round(fx) + 1, fy, C.woodShadow);
        fy += dir;
        fx += rng.range(-0.8, 0.8);
      }
    }
    // A few glow specks in the bark.
    for (let n = 0; n < 4; n++) put(buf, rng.int(SIZE), cyA - 2 + rng.int(5), C.groGlowCyan);
  }
  return buf;
}

// ─── Tileset ───────────────────────────────────────────────────────────────────────────────────

/** @type {import('./index.js').TilesetDef} */
export const TILESET = Object.freeze({
  id: 'grotto',
  name: 'Fungal Grotto',
  fog: 'groFog',
  paint(seedOf) {
    return {
      wall: [
        paintWall(seedOf('wall0'), seedOf('wallEdge'), 0),
        paintWall(seedOf('wall1'), seedOf('wallEdge'), 1),
        paintWall(seedOf('wall2'), seedOf('wallEdge'), 2),
        paintWall(seedOf('wall3'), seedOf('wallEdge'), 3),
      ],
      floor: [
        paintLoamFloor(seedOf('floor0'), seedOf('floorEdge')),
        paintSlabFloor(seedOf('floor1'), seedOf('floorEdge')),
        paintFairyRing(seedOf('floor2'), seedOf('floorEdge')),
      ],
      ceiling: [paintCeiling(seedOf('ceil0'), seedOf('ceilEdge'), false), paintCeiling(seedOf('ceil1'), seedOf('ceilEdge'), true)],
    };
  },
});
