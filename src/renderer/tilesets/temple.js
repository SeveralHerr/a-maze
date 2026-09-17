// @ts-check
/**
 * @file Sunken Temple tileset — an ancient temple buried under the sand.
 *
 * - **Walls** — large pale limestone ashlar under a moulded cornice and a carved frieze: a running
 *   key (meander) pattern in raised relief over a recessed ground. Every variant keeps the frieze
 *   and both ashlar courses on the same rows, so the band runs along a corridor and no joint lands
 *   on eye-level row 32. Variants: worn turquoise/terracotta inlay with a carved cartouche of
 *   abstract glyphs; cracked blocks split by roots pushing down from above with sand heaped at the
 *   foot; and, rarely, a sunk relief panel of a winged sun disc raying down onto a stepped pyramid
 *   between two painted columns.
 * - **Floor** — polished terracotta-and-cream diamond mosaic, worn and chipped; a sand-drifted
 *   limestone paving slab, diamond-shaped along the mosaic's grout, set into it under rippled
 *   dunes; rarely an inlaid sun-disc mosaic ringed into the diamond pattern.
 * - **Ceiling** — stone coffers with lapis-painted panels and gilt rosettes; the band variant is a
 *   massive lintel beam carved with a gilt zigzag.
 *
 * Tiling: texels are tied to world position and any two variants can sit side by side, so the
 * variants share everything that touches a tile edge (see `./index.js`). Walls: the frieze has a
 * 16-texel period and every variant paints the same ashlar layout, cornice and the block that wraps
 * across the tile edge from one shared seed; variants differ in the interior block of each course and
 * in decor, which is kept or faded out of the outer columns. Floors: every variant is the same
 * diamond mosaic (16-texel period) around its border, with its slab or sun disc inset in the middle.
 * Ceilings: the lintel is painted over the plain coffers and stays clear of rows 0 and 63.
 *
 * Node-safe: no DOM access.
 */

import { createRng } from '../../core/rng.js';
import { RAMPS, ramp } from '../palette.js';
import { SIZE, MASK, AREA, put, rampPickChunky, rampPickFlat, h01, vnoise, fbmChunky } from '../textures.js';

/** @typedef {import('../../core/rng.js').Rng} Rng */

const SAND = ramp(
  'temSandShadow',
  'temSandMortar',
  'temSandDeep',
  'temSandDark',
  'temSandMid',
  'temSandBase',
  'temSandLight',
  'temSandBright',
  'temSandHilite',
);
const DUNE = ramp('temSandDeep', 'temDuneDark', 'temDuneMid', 'temDuneLight');
const TERRA = ramp('temTerraShadow', 'temTerraDark', 'temTerraMid', 'temTerraBase', 'temTerraLight');
const TURQ = ramp('temTurqDeep', 'temTurqMid', 'temTurqLight', 'temTurqPale');
const LAPIS = ramp('temSandShadow', 'temLapisDeep', 'temLapisMid');
const GOLD = RAMPS.gold;
const WOOD = RAMPS.wood;

// ─── Relief ────────────────────────────────────────────────────────────────────────────────────

/** Paint kinds for carved relief. */
const K_STONE = 0;
const K_GOLD = 1;
const K_TURQ = 2;
const K_TERRA = 3;
const K_LAPIS = 4;
const KIND_RAMP = [SAND, GOLD, TURQ, TERRA, LAPIS];
/** Base ramp step of a raised (surface-level) texel of each kind. */
const KIND_RAISED = [5, 2, 2, 3, 2];
/** Base ramp step of a recessed texel of each kind. */
const KIND_RECESS = [3, 1, 1, 2, 1];

/** Relief map: 0 untouched, 1 recessed, 2 raised. Scratch, cleared per surface. */
const REL = new Uint8Array(AREA);
/** Paint kind per relief texel. */
const PNT = new Uint8Array(AREA);

const R_RECESS = 1;
const R_RAISED = 2;

/**
 * @param {number} x
 * @param {number} y
 * @param {number} rel
 * @param {number} pnt
 */
function mark(x, y, rel, pnt) {
  const i = ((y & MASK) << 6) | (x & MASK);
  REL[i] = rel;
  PNT[i] = pnt;
}

/**
 * Shade every marked relief texel: raised texels catch light on their top/left rims and fall off
 * on their bottom/right; recessed texels take a cast shadow under a raised edge. Paint flakes off
 * in chunky 2×2 patches where `wear` says so, showing the stone beneath.
 * @param {Uint8Array} buf
 * @param {number} seed
 * @param {number} wear 0..1 fraction of painted texels worn back to stone
 */
function shadeRelief(buf, seed, wear) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      const rel = REL[i];
      if (rel === 0) continue;
      let kind = PNT[i];
      if (kind !== K_STONE && h01(x >> 1, y >> 1, seed ^ (0xa11 + kind)) < wear) kind = K_STONE;
      const up = y > 0 ? REL[i - SIZE] : 0;
      const down = y < SIZE - 1 ? REL[i + SIZE] : 0;
      const left = REL[(y << 6) | ((x - 1) & MASK)];
      const right = REL[(y << 6) | ((x + 1) & MASK)];
      const n = fbmChunky(x, y, seed ^ 0x3e1);
      const r = KIND_RAMP[kind];
      let step;
      if (rel === R_RAISED) {
        step = KIND_RAISED[kind];
        if (kind === K_STONE) step += n > 0.62 ? 1 : n < 0.38 ? -1 : 0;
        if (up === R_RECESS || left === R_RECESS) step += 1;
        if (down === R_RECESS || right === R_RECESS) step -= 1;
      } else {
        step = KIND_RECESS[kind];
        if (kind === K_STONE && n > 0.6) step += 1;
        if (up === R_RAISED) step -= kind === K_STONE ? 2 : 1;
        else if (left === R_RAISED) step -= 1;
      }
      buf[i] = r[step < 0 ? 0 : step >= r.length ? r.length - 1 : step];
    }
  }
}

// ─── Walls ─────────────────────────────────────────────────────────────────────────────────────

/** Frieze relief field rows (inclusive start, exclusive end); the key pattern sits inside. */
const FRIEZE_Y0 = 10;
const FRIEZE_Y1 = 22;
/** First row of the key pattern (10 rows tall). */
const KEY_Y = 11;

/**
 * Running key, 8 × 5 cells of 2 texels ⇒ a 16-texel period (divides 64).
 * @type {ReadonlyArray<string>}
 */
const KEY = ['#######.', '#.....#.', '#.###.#.', '#.#...#.', '#.######'];

/** Ashlar course cells `[y0, y1)`; the bottom `MORTAR` rows of each are the joint. */
const COURSES = [
  [24, 42],
  [42, 64],
];
/**
 * Joint width. Ashlar is fitted stone, so the joints are thin and only a couple of steps below the
 * face: an earlier three rows of near-black joint read in game as the gaps between drawer fronts.
 */
const MORTAR = 2;

/** Cartouche glyphs, 5 × 5, abstract (not letters). */
const GLYPHS = [
  ['.###.', '#...#', '#.#.#', '#...#', '.###.'],
  ['#.#.#', '.#.#.', '.....', '#.#.#', '.#.#.'],
  ['..#..', '.###.', '#####', '.....', '#####'],
  ['##...', '.###.', '..###', '.###.', '##...'],
];

/**
 * @typedef {Object} Face
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * One ashlar block face: per-block tone, flat tonal patches, a lit top/left bevel, a dark
 * bottom/right roll-off, and single-texel grain.
 * @param {Uint8Array} buf
 * @param {number} bx
 * @param {number} by
 * @param {number} fw
 * @param {number} fh
 * @param {number} seed
 * @param {Rng} rng
 */
function paintBlock(buf, bx, by, fw, fh, seed, rng) {
  const baseT = 0.6 + rng.range(-0.16, 0.14);
  const bevel = rng.range(0.6, 1.1);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const gx = bx + x;
      const gy = by + y;
      let t = baseT + (fbmChunky(gx, gy, seed) - 0.5) * 0.3;
      if (y === 0 || x === 0) t += 0.25 * bevel;
      else if (y === 1 || x === 1) t += 0.12 * bevel;
      if (y === fh - 1 || x === fw - 1) t -= 0.14;
      else if (y === fh - 2 || x === fw - 2) t -= 0.06;
      put(buf, gx, gy, rampPickFlat(SAND, t));
    }
  }
  // Weathered patches one whole step off the block's tone.
  const clusters = 3 + rng.int(3);
  for (let i = 0; i < clusters; i++) {
    const cx = 2 + rng.int(fw - 6);
    const cy = 2 + rng.int(fh - 5);
    const cw = 4 + rng.int(4);
    const ch = 2 + rng.int(3);
    const c = rampPickFlat(SAND, baseT + (rng.chance(0.55) ? -0.125 : 0.125));
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (cx + x >= fw - 2 || cy + y >= fh - 2) continue;
        put(buf, bx + cx + x, by + cy + y, c);
      }
    }
  }
  // Grain: pits and bright crystals, kept off the bevels.
  const flecks = 10 + rng.int(8);
  for (let i = 0; i < flecks; i++) {
    const fx = 2 + rng.int(fw - 5);
    const fy = 2 + rng.int(fh - 4);
    const at = (((by + fy) & MASK) << 6) | ((bx + fx) & MASK);
    const step = SAND.indexOf(buf[at]);
    const next = rng.chance(0.25) ? step + 1 : step - 1;
    if (step < 0 || next < 3 || next >= SAND.length) continue;
    buf[at] = SAND[next];
  }
}

/**
 * Hairline crack across a block face.
 * @param {Uint8Array} buf
 * @param {Face} f
 * @param {Rng} rng
 */
function paintCrack(buf, f, rng) {
  let cx = 2 + rng.int(f.w - 4);
  let cy = rng.chance(0.5) ? 0 : f.h - 1;
  const dy = cy === 0 ? 1 : -1;
  const drift = rng.chance(0.5) ? 1 : -1;
  const len = Math.min(f.h, 6 + rng.int(f.h));
  for (let i = 0; i < len; i++) {
    if (cx < 0 || cx >= f.w) break;
    put(buf, f.x + cx, f.y + cy, rng.chance(0.7) ? SAND[1] : SAND[0]);
    if (rng.chance(0.3)) put(buf, f.x + cx - drift, f.y + cy, SAND[7]); // lit lip of the crack
    cy += dy;
    if (cy < 0 || cy >= f.h) break;
    if (rng.chance(0.45)) cx += drift;
    else if (rng.chance(0.12)) cx -= drift;
  }
}

/**
 * Distance from the nearer left/right tile edge (0 on columns 0 and 63).
 * @param {number} x
 * @returns {number}
 */
function edgeDist(x) {
  const c = x & MASK;
  return c < SIZE - 1 - c ? c : SIZE - 1 - c;
}

/**
 * Whether a per-variant paint reaches this texel: never within `EDGE_KEEP` columns of a tile edge,
 * always from `EDGE_FULL` in, and a chunky flaked fade in between — so every variant meets the
 * others on the plain stone they all share.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {boolean}
 */
function inPaintZone(x, y, seed) {
  const d = edgeDist(x);
  if (d < EDGE_KEEP) return false;
  if (d >= EDGE_FULL) return true;
  return h01(x >> 1, y >> 1, seed ^ 0x7a9) < (d - EDGE_KEEP) / (EDGE_FULL - EDGE_KEEP);
}

/** Columns from a tile edge that every wall variant leaves exactly as the shared painting. */
const EDGE_KEEP = 4;
/** Columns from a tile edge where per-variant paint is at full strength. */
const EDGE_FULL = 14;

/**
 * The part every wall variant shares, painted from `edgeSeed` alone: joint bed, cornice, frieze
 * fillets, the ashlar layout, and each course's edge-crossing block (tone, bevel, patches, grain).
 * Each course holds one interior block, which the variant paints from its own `seed`, and one block
 * that wraps across the tile edge, identical in every variant — so a corridor mixing variants reads
 * as one continuous run of masonry. Leaves the relief maps holding the frieze.
 * @param {number} edgeSeed
 * @param {number} seed
 * @param {Rng} rng
 * @param {number} cracks chance per interior block
 * @returns {{buf: Uint8Array, faces: Face[]}} the interior block faces, top course first
 */
function paintWallBase(edgeSeed, seed, rng, cracks) {
  const buf = new Uint8Array(AREA);
  const shared = createRng(edgeSeed);
  REL.fill(0);
  PNT.fill(0);

  // Joint bed.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      buf[(y << 6) | x] = rampPickChunky(SAND, 0.17 + fbmChunky(x, y, edgeSeed ^ 0x51a7) * 0.12, x, y);
    }
  }

  // Cornice: shadow under the ceiling, a lit lip, a rounded moulding, a groove.
  const corniceJoint = shared.int(32);
  for (let x = 0; x < SIZE; x++) {
    const n = fbmChunky(x, 3, edgeSeed ^ 0x77c);
    const d = n > 0.6 ? 1 : n < 0.4 ? -1 : 0;
    put(buf, x, 0, SAND[1]);
    put(buf, x, 1, SAND[2]);
    put(buf, x, 2, SAND[7]);
    put(buf, x, 3, SAND[6 + (d > 0 ? 1 : 0)]);
    put(buf, x, 4, SAND[5 + d]);
    put(buf, x, 5, SAND[4 + (d < 0 ? -1 : 0)]);
    put(buf, x, 6, SAND[2]);
    // Frieze border fillets above and below the relief field.
    put(buf, x, 7, SAND[7]);
    put(buf, x, 8, SAND[6 + (d < 0 ? -1 : 0)]);
    put(buf, x, 9, SAND[4]);
    put(buf, x, 22, SAND[6 + (d > 0 ? 0 : -1)]);
    put(buf, x, 23, SAND[2]);
  }
  for (const jx of [corniceJoint, corniceJoint + 32]) {
    for (let y = 2; y < 6; y++) put(buf, jx, y, SAND[2]);
  }

  // Frieze relief field.
  for (let y = FRIEZE_Y0; y < FRIEZE_Y1; y++) {
    const ky = y - KEY_Y;
    for (let x = 0; x < SIZE; x++) {
      const raised = ky >= 0 && ky < 10 && KEY[ky >> 1][(x & 15) >> 1] === '#';
      mark(x, y, raised ? R_RAISED : R_RECESS, K_STONE);
    }
  }

  // Ashlar courses, two big blocks each: an interior block [x0, x0 + a) kept clear of the edge zone,
  // and the block that wraps across the tile edge. The courses' joints are staggered.
  /** @type {Face[]} */
  const faces = [];
  /** @type {number[]} */
  const joints = [];
  for (let c = 0; c < COURSES.length; c++) {
    const [y0, y1] = COURSES[c];
    let x0 = 0;
    let a = 0;
    for (let tries = 0; tries < 12; tries++) {
      a = 28 + shared.int(9);
      x0 = EDGE_KEEP + shared.int(SIZE - 2 * EDGE_KEEP - a + 1);
      if (joints.every((j) => Math.abs(j - x0) >= 8 && Math.abs(j - (x0 + a)) >= 8)) break;
    }
    joints.push(x0, x0 + a);
    const fh = y1 - y0 - MORTAR;
    const edge = { x: x0 + a, y: y0, w: SIZE - a - MORTAR, h: fh };
    const edgeRng = createRng(edgeSeed ^ (0xb10c + c));
    paintBlock(buf, edge.x, edge.y, edge.w, edge.h, edgeSeed, edgeRng);
    if (edgeRng.chance(0.12)) paintCrack(buf, edge, edgeRng);
    const face = { x: x0, y: y0, w: a - MORTAR, h: fh };
    paintBlock(buf, face.x, face.y, face.w, face.h, seed, rng);
    if (rng.chance(cracks)) paintCrack(buf, face, rng);
    faces.push(face);
  }
  return { buf, faces };
}

/**
 * Knock 2×2 chips out of the raised key pattern, away from the tile edges.
 * @param {number} n
 * @param {Rng} rng
 */
function chipFrieze(n, rng) {
  for (let i = 0; i < n; i++) {
    const x = EDGE_KEEP + rng.int(SIZE - 2 * EDGE_KEEP - 1);
    const y = KEY_Y + rng.int(9);
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) mark(x + dx, y + dy, R_RECESS, K_STONE);
  }
}

/**
 * Paint the frieze fillets as worn terracotta, fading out toward the tile edges.
 * @param {Uint8Array} buf
 * @param {number} seed
 */
function paintFillets(buf, seed) {
  for (let x = 0; x < SIZE; x++) {
    if (h01(x >> 1, 0, seed ^ 0xf11) > 0.3 && inPaintZone(x, 0, seed)) {
      put(buf, x, 7, TERRA[4]);
      put(buf, x, 8, TERRA[3]);
      put(buf, x, 9, TERRA[2]);
    }
    if (h01(x >> 1, 1, seed ^ 0xf11) > 0.3 && inPaintZone(x, 1, seed)) put(buf, x, 22, TERRA[3]);
  }
}

/**
 * A carved cartouche (raised gilt ring, recessed ground, raised painted glyphs) on a block face.
 * @param {Face} f
 * @param {Rng} rng
 */
function markCartouche(f, rng) {
  const W = 25;
  const H = 11;
  const x0 = f.x + ((f.w - W) >> 1);
  const y0 = f.y + 2;
  const order = [0, 1, 2, 3];
  rng.shuffle(order);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if ((i < 1 || i > W - 2) && (j < 1 || j > H - 2)) continue; // rounded corners
      const border = i < 2 || i > W - 3 || j < 2 || j > H - 3;
      if (border) {
        mark(x0 + i, y0 + j, R_RAISED, K_GOLD);
        continue;
      }
      let raised = false;
      let kind = K_STONE;
      const gj = j - 3;
      if (gj >= 0 && gj < 5) {
        for (let k = 0; k < 3; k++) {
          const gi = i - (3 + k * 7);
          if (gi >= 0 && gi < 5 && GLYPHS[order[k]][gj][gi] === '#') {
            raised = true;
            kind = k === 1 ? K_TERRA : K_TURQ;
          }
        }
      }
      mark(x0 + i, y0 + j, raised ? R_RAISED : R_RECESS, kind);
    }
  }
}

/**
 * The showpiece: a sunk relief panel — winged sun disc, rays, stepped pyramid, two columns.
 * @param {Uint8Array} buf
 * @param {number} seed
 * @param {Rng} rng
 */
function markReliefPanel(buf, seed, rng) {
  const W = 44;
  const H = 34;
  // Set into the middle of the tile: the edge blocks either side stay whole in every variant.
  const px = 8 + rng.int(SIZE - W - 15);
  const py = 26;
  const cx = (W - 1) / 2; // 21.5
  const WING = [15, 14, 13, 11, 9, 7, 5]; // rows 7..13
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      // Stone ground under the carving (covers the course joint).
      put(buf, px + i, py + j, rampPickFlat(SAND, 0.58 + (fbmChunky(px + i, py + j, seed ^ 0x9a) - 0.5) * 0.2));
      if (i < 3 || i >= W - 3 || j < 3 || j >= H - 3) {
        mark(px + i, py + j, R_RAISED, K_STONE);
        continue;
      }
      const m = i <= cx ? i : W - 1 - i; // mirrored column, 3..21
      const dx = i - cx;
      let rel = R_RECESS;
      let kind = K_STONE;
      // Sun disc.
      const dd = dx * dx + (j - 10) * (j - 10);
      // Sun disc: solid, so it cannot read as a ring on a stick (an earlier ringed disc over a
      // centre ray looked like a glyph).
      if (dd <= 22) {
        rel = R_RAISED;
        kind = K_GOLD;
      }
      // Wings.
      if (j >= 7 && j <= 13) {
        const span = WING[j - 7];
        const inner = cx - 6;
        const from = inner - span;
        if (m >= Math.max(4, from) && m <= inner) {
          const f = inner - m;
          rel = j > 8 && f % 3 === 2 ? R_RECESS : R_RAISED;
          kind = j <= 8 ? K_GOLD : ((f / 3) | 0) % 2 ? K_TURQ : K_LAPIS;
        }
      }
      // Rays.
      if (j >= 15 && j <= 21) {
        const s = (j - 15) / 7;
        for (let k = 1; k <= 3; k++) {
          if (Math.abs(Math.abs(dx) - (1.5 + k * 3.2 * s)) < 0.5 + s * 0.6) {
            rel = R_RAISED;
            kind = K_GOLD;
          }
        }
      }
      // Stepped pyramid.
      if (j >= 22 && j <= 30) {
        const step = (30 - j) >> 1;
        if (Math.abs(dx) <= 13 - step * 3) {
          rel = R_RAISED;
          kind = step === 4 ? K_GOLD : K_STONE;
          if (Math.abs(dx) <= 1.5 && j >= 27) rel = R_RECESS;
        }
      }
      // Columns with papyrus capitals.
      if (j >= 16 && j <= 30) {
        if (j <= 18 ? m >= 4 && m <= 8 : m >= 5 && m <= 7) {
          rel = R_RAISED;
          kind = j <= 18 ? K_TURQ : K_TERRA;
        }
      }
      mark(px + i, py + j, rel, kind);
    }
  }
}

/**
 * Roots forcing their way down from above, splitting the stone beside them. Kept (with their side
 * shoots) inside the tile, clear of the edge columns every variant shares.
 * @param {Uint8Array} buf
 * @param {number} seed
 * @param {Rng} rng
 * @param {number} count
 */
function paintRoots(buf, seed, rng, count) {
  for (let r = 0; r < count; r++) {
    const startX = 14 + rng.int(SIZE - 28);
    const len = 32 + rng.int(26);
    let fx = startX;
    for (let y = 0; y < len; y++) {
      fx += (h01(startX, y, seed ^ 0x7007) - 0.5) * 1.3;
      if (fx < EDGE_KEEP + 2) fx = EDGE_KEEP + 2;
      else if (fx > SIZE - EDGE_KEEP - 6) fx = SIZE - EDGE_KEEP - 6;
      const ix = Math.round(fx);
      const w = y < len * 0.45 ? 3 : y < len * 0.8 ? 2 : 1;
      put(buf, ix - 1, y, SAND[0]);
      put(buf, ix + w, y, SAND[1]);
      for (let k = 0; k < w; k++) put(buf, ix + k, y, WOOD[k === 0 ? 5 : k === w - 1 ? 1 : 3]);
      if (y > 6 && y % 7 === 3 && rng.chance(0.6)) {
        const side = rng.chance(0.5) ? 1 : -1;
        const L = 4 + rng.int(6);
        for (let s = 1; s <= L; s++) {
          const bx = side > 0 ? ix + w - 1 + s : ix - s;
          const by = y + (s >> 1);
          if (edgeDist(bx) < EDGE_KEEP) break;
          put(buf, bx, by, s === L ? WOOD[1] : WOOD[3]);
          put(buf, bx, by + 1, SAND[1]);
        }
      }
    }
    put(buf, Math.round(fx), len, WOOD[2]);
  }
}

/**
 * Sand heaped against the foot of the wall, sloping away to nothing before the tile edges so the
 * shared course and joint there stay bare.
 * @param {Uint8Array} buf
 * @param {number} seed
 * @param {number} height max mound height
 */
function paintSandHeap(buf, seed, height) {
  for (let x = 0; x < SIZE; x++) {
    const d = edgeDist(x);
    if (d < EDGE_KEEP) continue;
    const taper = d >= EDGE_FULL ? 1 : (d - EDGE_KEEP + 1) / (EDGE_FULL - EDGE_KEEP + 1);
    const h = Math.round((2 + vnoise(x, 0, 16, seed ^ 0x5a) * height) * taper);
    for (let y = SIZE - h; y < SIZE; y++) {
      const e = y - (SIZE - h);
      const t = e === 0 ? 1 : e === 1 ? 0.78 : 0.55 - (e / height) * 0.3 + (fbmChunky(x, y, seed ^ 0xd1) - 0.5) * 0.3;
      buf[(y << 6) | x] = rampPickChunky(DUNE, t, x, y);
    }
  }
}

/**
 * @param {number} edgeSeed shared by every wall variant (see {@link paintWallBase})
 * @param {number} seed
 * @param {number} variant 0 plain, 1 painted inlay + cartouche, 2 root-split, 3 relief panel
 * @returns {Uint8Array}
 */
function paintWall(edgeSeed, seed, variant) {
  const rng = createRng(seed);
  const cracks = variant === 2 ? 0.6 : 0.12;
  const { buf, faces } = paintWallBase(edgeSeed, seed, rng, cracks);
  let wear = 0.3;
  if (variant === 0) chipFrieze(4, rng);
  if (variant === 1) {
    chipFrieze(3, rng);
    for (let y = FRIEZE_Y0; y < FRIEZE_Y1; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = (y << 6) | x;
        if (REL[i] === R_RECESS && inPaintZone(x, y, seed)) PNT[i] = K_TURQ;
      }
    }
    paintFillets(buf, seed);
    const courseA = faces[0].w >= faces[1].w ? faces[0] : faces[1];
    markCartouche(courseA, rng);
  }
  if (variant === 2) chipFrieze(14, rng);
  if (variant === 3) {
    chipFrieze(3, rng);
    for (let y = FRIEZE_Y0; y < FRIEZE_Y1; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = (y << 6) | x;
        if (REL[i] === R_RAISED && inPaintZone(x, y, seed)) PNT[i] = K_GOLD;
      }
    }
    markReliefPanel(buf, seed, rng);
    wear = 0.22;
  }
  // Shaded with the shared seed: the painted kinds are already faded out at the edges, so the stone
  // there comes out identical in every variant.
  shadeRelief(buf, edgeSeed, wear);
  if (variant === 2) {
    paintRoots(buf, seed, rng, 2);
    paintSandHeap(buf, seed, 10);
  }
  return buf;
}

// ─── Floors ────────────────────────────────────────────────────────────────────────────────────

/**
 * One texel of the polished diamond mosaic: terracotta diamonds centred on each 16-cell, cream
 * diamonds between them, 1-texel grout. A 16-texel period, so it wraps onto itself and every floor
 * variant painted from the same seed shares it along the tile border.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number} palette index
 */
function mosaicAt(x, y, seed) {
  const p = (x & 15) - 7.5;
  const q = (y & 15) - 7.5;
  const m = Math.abs(p) + Math.abs(q);
  if (m === 8) return h01(x, y, seed ^ 0x6a) < 0.22 ? DUNE[1] : SAND[1];
  const terra = m < 8;
  let pp = p;
  let qq = q;
  let mm = m;
  let id;
  if (terra) {
    id = h01((x >> 4) & 3, (y >> 4) & 3, seed ^ 0x1d);
  } else {
    pp = ((x + 8) & 15) - 7.5;
    qq = ((y + 8) & 15) - 7.5;
    mm = Math.abs(pp) + Math.abs(qq);
    id = h01(((x + 8) >> 4) & 3, ((y + 8) >> 4) & 3, seed ^ 0x2d);
  }
  let step = 0;
  if (id < 0.25) step -= 1;
  if (mm === 7) step += pp + qq < 0 ? 1 : -1; // bevel
  else if (pp < 0 && pp === qq && mm >= 3 && mm <= 5) step += 1; // polish glint
  if (fbmChunky(x, y, seed ^ 0x4e) < 0.36) step -= 1; // worn
  // Chips at the tile rims show the bedding beneath.
  if (mm >= 5 && vnoise(x, y, 8, seed ^ 0xc41) + h01(x >> 1, y >> 1, seed ^ 0xc42) * 0.25 > 0.9) {
    return mm === 5 ? SAND[3] : SAND[2];
  }
  if (terra) {
    const s = 3 + step;
    return TERRA[s < 1 ? 1 : s > 4 ? 4 : s];
  }
  if (mm <= 1) return TERRA[2]; // inset dot in the cream diamond
  const s = 7 + step;
  return SAND[s < 5 ? 5 : s > 8 ? 8 : s];
}

/**
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintMosaicFloor(seed) {
  const buf = new Uint8Array(AREA);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let c = mosaicAt(x, y, seed);
      // A little blown sand dusting the polish.
      const d = fbmChunky(x + 21, y + 9, seed ^ 0xd05);
      if (d > 0.7) c = rampPickChunky(DUNE, 0.35 + (d - 0.7) * 3, x, y);
      buf[(y << 6) | x] = c;
    }
  }
  return buf;
}

/**
 * 0 on a tile's outer rows/columns rising to 1 by `FLOOR_FULL` texels in: how strongly a floor
 * variant's own detail shows at a texel. Near the border every floor is the shared mosaic.
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function floorTaper(x, y) {
  const dx = x < SIZE - 1 - x ? x : SIZE - 1 - x;
  const dy = y < SIZE - 1 - y ? y : SIZE - 1 - y;
  const d = (dx < dy ? dx : dy) - FLOOR_KEEP;
  return d <= 0 ? 0 : d >= FLOOR_FULL - FLOOR_KEEP ? 1 : d / (FLOOR_FULL - FLOOR_KEEP);
}

/** Texels from a tile edge where every floor variant is exactly the shared mosaic. */
const FLOOR_KEEP = 3;
/** Texels from a tile edge where a floor variant's own drifts reach full strength. */
const FLOOR_FULL = 16;

/**
 * A sand-drifted limestone paving slab set into the diamond mosaic: a big diamond whose edges run
 * along the mosaic's own grout lines (x + y ≡ 7, x − y ≡ 8 mod 16), split into flagstones, with
 * rippled dunes blown across it. The mosaic around it is the shared floor, so this tile meets every
 * other floor variant seamlessly; the dunes fade out before the border.
 * @param {number} edgeSeed the shared mosaic's seed
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintFlagFloor(edgeSeed, seed) {
  const buf = paintMosaicFloor(edgeSeed);
  const rng = createRng(seed);
  // The slab: 39 < x + y < 87 and |x − y| < 24 (its bounding grout lines stay mosaic grout).
  const inSlab = (/** @type {number} */ x, /** @type {number} */ y) => x + y > 39 && x + y < 87 && x - y < 24 && y - x < 24;
  // Joints across the slab: one along each diagonal, one of them dropped at random.
  const along = rng.int(3); // 0 both, 1 only x + y, 2 only x − y
  const isJoint = (/** @type {number} */ x, /** @type {number} */ y) =>
    (along !== 2 && x + y === 63) || (along !== 1 && x === y);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      const slab = inSlab(x, y);
      const taper = floorTaper(x, y);
      // Drifts: flat undithered sand (a dither over a whole drift read as mud at corridor
      // distance), a dark feathered rim, and crisp wind ripples one step lighter.
      // Drifts pile on the slab and only spill a few texels onto the mosaic around it.
      const out = Math.max(Math.abs(x + y - 63) - 24, Math.abs(x - y) - 24);
      const drift = fbmChunky(x + 13, y + 7, seed ^ 0xd00) + (out > 0 ? -out * 0.06 : 0) - (1 - taper) * 0.5;
      if (drift > 0.63) {
        const k = (vnoise(x, y, 16, seed ^ 0x71) * 12) | 0;
        const ripple = ((y + k) & 7) === 0;
        const shade = ((y + k) & 7) === 1;
        let step = drift < 0.65 ? 1 : drift > 0.72 ? 3 : 2;
        if (ripple && step > 1) step = 3;
        else if (shade && step > 1) step -= 1;
        buf[i] = DUNE[step];
        continue;
      }
      if (!slab) continue;
      if (isJoint(x, y)) {
        buf[i] = h01(x, y, seed ^ 0x3b) < 0.4 ? DUNE[1] : SAND[1];
        continue;
      }
      // Which flagstone: the side of each diagonal joint.
      const stone = (along !== 2 && x + y > 63 ? 1 : 0) | (along !== 1 && x > y ? 2 : 0);
      let t = 0.56 + h01(stone, 7, seed ^ 0x51) * 0.16 + (fbmChunky(x, y, seed ^ 0x99) - 0.5) * 0.22;
      // Bevel: lit where the grout or a joint lies above/left, shaded where one lies below/right.
      const up = !inSlab(x, y - 1) || isJoint(x, y - 1);
      const left = !inSlab(x - 1, y) || isJoint(x - 1, y);
      const down = !inSlab(x, y + 1) || isJoint(x, y + 1);
      const right = !inSlab(x + 1, y) || isJoint(x + 1, y);
      if (up || left) t += 0.12;
      if (down || right) t -= 0.12;
      buf[i] = rampPickFlat(SAND, t);
    }
  }
  // Hairline cracks across the slab.
  for (let c = 0; c < 2; c++) {
    let cx = 20 + rng.int(24);
    let cy = 20 + rng.int(12);
    const drift = rng.chance(0.5) ? 1 : -1;
    for (let i = 0; i < 10 + rng.int(8); i++) {
      if (!inSlab(cx, cy)) break;
      const at = (cy << 6) | cx;
      if (SAND.indexOf(buf[at]) >= 3) buf[at] = SAND[2];
      cy += 1;
      if (rng.chance(0.5)) cx += drift;
    }
  }
  return buf;
}

/**
 * The rare tile: a sun disc mosaic in 2×2 tesserae, sixteen alternating gold and terracotta rays
 * on a lapis ground, ringed in terracotta and cream and set into the shared diamond mosaic — inset
 * well clear of the border, so the mosaic around it meets the neighbouring floors seamlessly.
 * @param {number} edgeSeed the shared mosaic's seed
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintSunFloor(edgeSeed, seed) {
  const buf = new Uint8Array(AREA);
  const SECTOR = Math.PI / 8;
  /** The rays and medallion are drawn in a 25.5-texel design, shrunk inside the 26-texel rings. */
  const SUN_SCALE = 25.5 / 21.5;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const qx = (x & ~1) - 31;
      const qy = (y & ~1) - 31;
      const rr = Math.sqrt(qx * qx + qy * qy);
      const r = rr * SUN_SCALE;
      const tj = h01(x >> 1, y >> 1, seed ^ 0x5e);
      const jit = tj < 0.28 ? -1 : tj > 0.86 ? 1 : 0;
      let c;
      if (rr >= 26) {
        c = mosaicAt(x, y, edgeSeed);
        const d = fbmChunky(x + 21, y + 9, edgeSeed ^ 0xd05); // the mosaic floor's sand dusting
        if (d > 0.7) c = rampPickChunky(DUNE, 0.35 + (d - 0.7) * 3, x, y);
      } else if (rr >= 24) {
        c = SAND[7 + (jit < 0 ? -1 : 0)];
      } else if (rr >= 21.5) {
        c = TERRA[2 + (jit > 0 ? 1 : 0)];
      } else if (r < 5) {
        c = GOLD[4 + (jit < 0 ? -1 : 0)];
      } else if (r < 9.5) {
        c = GOLD[3 + (jit < 0 ? -1 : 0)];
      } else if (r < 11.5) {
        c = GOLD[1];
      } else {
        const a = Math.atan2(qy, qx) / SECTOR;
        const sector = Math.round(a);
        const frac = Math.abs(a - sector);
        const long = (sector & 1) === 0;
        const len = long ? 25.5 : 20;
        const width = 0.5 * (1 - (r - 11.5) / (len - 11.5));
        if (r < len && frac < width) {
          const edge = frac > width - 0.14;
          c = long ? GOLD[(edge ? 1 : 2) + (jit > 0 ? 1 : 0)] : TERRA[(edge ? 2 : 3) + (jit > 0 ? 1 : 0)];
        } else {
          c = LAPIS[2 + (jit < 0 ? -1 : 0)];
          if (tj > 0.97) c = TURQ[2]; // a stray turquoise tessera
        }
      }
      buf[(y << 6) | x] = c;
    }
  }
  return buf;
}

// ─── Ceilings ──────────────────────────────────────────────────────────────────────────────────

/**
 * Stone coffers, 32 texels each: ribs with bosses at the crossings, two stepped bevels, and a
 * recessed lapis panel with a gilt rosette (flaking on some coffers).
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintCoffers(seed) {
  const buf = new Uint8Array(AREA);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 12) & 31;
      const v = (y + 12) & 31;
      const du = u - 19.5;
      const dv = v - 19.5;
      const ad = Math.abs(du);
      const av = Math.abs(dv);
      const d = ad > av ? ad : av;
      const n = fbmChunky(x, y, seed ^ 0xce1);
      const nd = n > 0.62 ? 1 : n < 0.38 ? -1 : 0;
      /** Faces toward the light: the far (bottom/right) inner walls of the coffer. */
      const litFace = du > av || dv > ad;
      let c;
      if (d >= 12) {
        const bu = Math.abs(u - 3.5);
        const bv = Math.abs(v - 3.5);
        if (bu <= 1.5 && bv <= 1.5) c = SAND[bu + bv <= 1 ? 7 : 6]; // boss
        else c = SAND[5 + nd];
      } else if (d >= 10) {
        c = SAND[litFace ? 5 : 2];
      } else if (d >= 7) {
        c = SAND[4 + nd];
      } else if (d >= 6) {
        c = SAND[litFace ? 4 : 1];
      } else {
        const coffer = (((x + 12) >> 5) & 1) | ((((y + 12) >> 5) & 1) << 1);
        const flake = fbmChunky(x + 5, y + 3, seed ^ (0x1f0 + coffer)) > 0.63;
        const petal = (ad < 1 && av < 4.5) || (av < 1 && ad < 4.5);
        const dot = ad === 2.5 && av === 2.5;
        if (ad < 1 && av < 1) c = GOLD[4];
        else if (petal) c = GOLD[ad + av > 3 ? 2 : 3];
        else if (dot) c = GOLD[2];
        else if (flake) c = SAND[3];
        else c = LAPIS[d >= 5 ? 1 : 2];
      }
      buf[(y << 6) | x] = c;
    }
  }
  return buf;
}

/**
 * Coffers crossed by a massive carved lintel running along +x. The coffers are the plain
 * ceiling's own painting, and the beam (with its cast shadows, rows 16–48) stays inside the tile, so
 * rows 0 and 63 meet the plain ceiling exactly.
 * @param {number} edgeSeed the plain coffers' seed
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintLintel(edgeSeed, seed) {
  const buf = paintCoffers(edgeSeed);
  const rng = createRng(seed ^ 0x11e7);
  const Y0 = 18;
  const Y1 = 46; // exclusive
  REL.fill(0);
  PNT.fill(0);
  for (let y = Y0; y < Y1; y++) {
    const e = y - Y0;
    for (let x = 0; x < SIZE; x++) {
      let t = 0.5 + (fbmChunky(x, y, seed ^ 0xbea) - 0.5) * 0.28;
      if (e === 0) t += 0.3;
      else if (e === 1) t += 0.14;
      else if (e === Y1 - Y0 - 2) t -= 0.14;
      else if (e === Y1 - Y0 - 1) t -= 0.26;
      buf[(y << 6) | x] = rampPickFlat(SAND, t);
    }
  }
  // Cast shadow either side of the beam.
  for (let x = 0; x < SIZE; x++) {
    put(buf, x, Y0 - 1, SAND[1]);
    put(buf, x, Y0 - 2, SAND[2]);
    put(buf, x, Y1, SAND[0]);
    put(buf, x, Y1 + 1, SAND[1]);
    put(buf, x, Y1 + 2, SAND[2]);
  }
  // Carved zigzag band down the middle of the soffit, fillets either side.
  const B0 = 26;
  const B1 = 38; // exclusive
  for (let x = 0; x < SIZE; x++) {
    put(buf, x, B0 - 1, SAND[7]);
    put(buf, x, B1, SAND[3]);
    for (let y = B0; y < B1; y++) {
      const z = Math.abs((x & 15) - 7.5); // 0.5..7.5
      const target = 9.5 - z; // 2..9: a chevron per 16 texels
      const raised = Math.abs(y - B0 - target) < 1.1;
      mark(x, y, raised ? R_RAISED : R_RECESS, raised ? K_GOLD : K_TURQ);
    }
  }
  shadeRelief(buf, seed, 0.4);
  // A long settling crack across the beam.
  let cx = rng.int(SIZE);
  let cy = Y0 + 2;
  while (cy < B0 - 1) {
    put(buf, cx, cy, SAND[1]);
    cy += 1;
    if (rng.chance(0.5)) cx += 1;
  }
  return buf;
}

// ─── Tileset ───────────────────────────────────────────────────────────────────────────────────

/** @type {import('./index.js').TilesetDef} */
export const TILESET = Object.freeze({
  id: 'temple',
  name: 'Sunken Temple',
  fog: 'temFog',
  paint(seedOf) {
    // Shared seeds: everything a variant has in common with its siblings along the tile edges.
    const wallEdge = seedOf('wallEdge');
    const floorEdge = seedOf('floorEdge');
    const ceilEdge = seedOf('ceilEdge');
    return {
      wall: [
        paintWall(wallEdge, seedOf('wall0'), 0),
        paintWall(wallEdge, seedOf('wall1'), 1),
        paintWall(wallEdge, seedOf('wall2'), 2),
        paintWall(wallEdge, seedOf('wall3'), 3),
      ],
      floor: [
        paintMosaicFloor(floorEdge),
        paintFlagFloor(floorEdge, seedOf('floor1')),
        paintSunFloor(floorEdge, seedOf('floor2')),
      ],
      ceiling: [paintCoffers(ceilEdge), paintLintel(ceilEdge, seedOf('ceil1'))],
    };
  },
});
