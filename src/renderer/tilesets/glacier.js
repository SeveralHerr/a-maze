// @ts-check
/**
 * @file Frozen Depths tileset — a maze cut into a glacier and the frozen rock under it.
 *
 * - **Walls** — blue-black rock blocks in a running bond (the Keep's course rows, so joints run
 *   unbroken along a corridor), glazed with translucent ice sheets that flow down from the top of a
 *   block, frost crystals feathering the joints and icicles dripping from every course ledge.
 *   Every variant shares one course layout and the painting of the blocks that straddle the tile
 *   edge; a variant repaints only the interior block of each course. Variants: [1] a column of thick
 *   clear blue ice in fractured planes with bubbles and white cracks, the rock joints ghosting
 *   through, set in the frame of the shared edge blocks; [2] hoarfrost-rimed interior stone with
 *   snow packed into its joints; [3] the showpiece — the ice column with a sword and a skull frozen
 *   inside it, silhouettes only.
 * - **Floors** — [0] frosted flagstones with snow drifted into the gaps, [1] a frozen pool of
 *   polished ice plates split by white crack lines, [2] a hoarfrost rune circle. [1] and [2] lie on
 *   floor[0]'s own flagstones and stay clear of the tile edges.
 * - **Ceiling** — rough frozen rock with icicle clusters seen tip-on; [1] adds an ice-crusted rock
 *   rib across the tile. Both share the rock and the clusters along the top/bottom edge.
 *
 * Ice mid-tones sit deliberately light (the ice ramp's middle is brighter than the rock's top) so
 * the warm torch reads on cold ice instead of the whole floor sinking into navy.
 *
 * Invariants (see `../textures.js`): row-major 64×64, no index 0, floors/ceilings toroidal, walls
 * wrap horizontally, deterministic per seed, Node-safe.
 */

import { createRng } from '../../core/rng.js';
import { RAMPS, ramp } from '../palette.js';
import { SIZE, MASK, AREA, put, rampPickChunky, rampPickFlat, h01, vnoise, fbmChunky } from '../textures.js';

/** @typedef {import('../../core/rng.js').Rng} Rng */

// ─── Ramps ─────────────────────────────────────────────────────────────────────────────────────

const ROCK = ramp('glaRockShadow', 'glaRockDeep', 'glaRockDark', 'glaRockMid', 'glaRockBase', 'glaRockLight', 'glaRockBright');
const ICE = ramp(
  'glaIceAbyss',
  'glaIceDeep',
  'glaIceDark',
  'glaIceMid',
  'glaIceBase',
  'glaIceLight',
  'glaIceBright',
  'glaIcePale',
  'glaIceSpec',
);
const SNOW = ramp('glaSnowShadow', 'glaSnowMid', 'glaSnowLight', 'glaSnowWhite');
/** Flagstones reuse the shared blue-grey stone ramp: frost-pale slate, free of the block budget. */
const FLAG = RAMPS.stone;

/** Step `d` along `r` from palette index `idx` (clamped); an index not on `r` maps to its middle. */
function shift(r, idx, d) {
  let s = r.indexOf(idx);
  if (s < 0) s = r.length >> 1;
  s += d;
  return r[s < 0 ? 0 : s >= r.length ? r.length - 1 : s];
}

/** Palette index of step `s` on ramp `r` (clamped). */
function step(r, s) {
  return r[s < 0 ? 0 : s >= r.length ? r.length - 1 : s | 0];
}

// ─── Toroidal Voronoi ──────────────────────────────────────────────────────────────────────────

/** Reused result of {@link voronoi} (paint time only, single-threaded). */
const VOR = { d1: 0, d2: 0, id1: 0, id2: 0, fx: 0, fy: 0 };

/**
 * Nearest two jittered feature points on a wrapping `cells × cells` lattice (cells divides 64).
 * @param {number} x
 * @param {number} y
 * @param {number} cells
 * @param {number} seed
 */
function voronoi(x, y, cells, seed) {
  const span = SIZE / cells;
  const m = cells - 1;
  const cx0 = Math.floor(x / span);
  const cy0 = Math.floor(y / span);
  let d1 = 1e9;
  let d2 = 1e9;
  let id1 = 0;
  let id2 = 0;
  let fx = 0;
  let fy = 0;
  for (let gy = cy0 - 1; gy <= cy0 + 1; gy++) {
    for (let gx = cx0 - 1; gx <= cx0 + 1; gx++) {
      const wx = gx & m;
      const wy = gy & m;
      const jx = (gx + 0.12 + 0.76 * h01(wx, wy, seed)) * span;
      const jy = (gy + 0.12 + 0.76 * h01(wx, wy, seed ^ 0x1234)) * span;
      const dx = x - jx;
      const dy = y - jy;
      const d = dx * dx + dy * dy;
      const id = wy * cells + wx;
      if (d < d1) {
        d2 = d1;
        id2 = id1;
        d1 = d;
        id1 = id;
        fx = dx;
        fy = dy;
      } else if (d < d2) {
        d2 = d;
        id2 = id;
      }
    }
  }
  VOR.d1 = Math.sqrt(d1);
  VOR.d2 = Math.sqrt(d2);
  VOR.id1 = id1;
  VOR.id2 = id2;
  VOR.fx = fx;
  VOR.fy = fy;
}

// ─── Walls: shared course layout ───────────────────────────────────────────────────────────────

/** First course row. Same phase as the Keep: row 32 (eye level) falls inside a block face. */
const COURSE_PHASE = 8;
const COURSE_H = 16;
const COURSE_COUNT = 4;
const MORTAR = 3;
const FACE_H = COURSE_H - MORTAR;

/** @typedef {{x:number, y:number, w:number, edge:boolean}} Block */

/**
 * The one running-bond layout every wall variant shares (painted from the tileset's `edge` seed):
 * 4 courses, each an interior block `[L, R)` that stays clear of the tile edges and an edge block
 * `[R, L + 64)` that straddles the seam. The head joints alternate course to course (L ≈ 6–11 / 16–21,
 * R ≈ 38–43 / 48–55), so the bond still staggers, and the edge block is always at least 6 texels
 * wide on each side of the seam — the seam never lands on a joint and never slices a thin sliver.
 * @param {Rng} rng
 * @returns {Block[]}
 */
function layoutCourses(rng) {
  const out = [];
  const flip = rng.chance(0.5) ? 1 : 0;
  for (let r = 0; r < COURSE_COUNT; r++) {
    const y = COURSE_PHASE + r * COURSE_H;
    const hi = (r + flip) & 1;
    const L = hi ? 16 + rng.int(6) : 6 + rng.int(6);
    const R = hi ? 48 + rng.int(8) : 38 + rng.int(6);
    out.push({ x: L, y, w: R - L, edge: false });
    out.push({ x: R, y, w: SIZE - (R - L), edge: true });
  }
  return out;
}

/**
 * Which texels a wall variant owns: 1 inside an interior block's cell (its face, the bed joint above
 * it and the head joint before it), 0 in the shared edge cells. The cells tile the texture exactly.
 * @param {Block[]} blocks
 * @returns {Uint8Array}
 */
function ownerMask(blocks) {
  const m = new Uint8Array(AREA);
  for (const b of blocks) {
    if (b.edge) continue;
    for (let y = -MORTAR; y < FACE_H; y++) {
      for (let x = -MORTAR; x < b.w - MORTAR; x++) m[(((b.y + y) & MASK) << 6) | ((b.x + x) & MASK)] = 1;
    }
  }
  return m;
}

/**
 * Where an ice wall's sheet sits: every interior block face, bridged through the bed joint wherever
 * two interior faces overlap — a staggered column of ice held in a frame of the shared rock blocks.
 * @param {Block[]} blocks
 * @returns {Uint8Array}
 */
function iceMask(blocks) {
  const m = new Uint8Array(AREA);
  const inner = blocks.filter((b) => !b.edge);
  for (let r = 0; r < inner.length; r++) {
    const b = inner[r];
    const above = inner[(r + inner.length - 1) % inner.length];
    for (let x = b.x; x < b.x + b.w - MORTAR; x++) {
      for (let y = 0; y < FACE_H; y++) m[(((b.y + y) & MASK) << 6) | (x & MASK)] = 1;
      if (x < above.x || x >= above.x + above.w - MORTAR) continue;
      for (let y = -MORTAR; y < 0; y++) m[(((b.y + y) & MASK) << 6) | (x & MASK)] = 1;
    }
  }
  return m;
}

/**
 * 1 on joint texels of a layout (bed and head joints), 0 on block faces.
 * @param {Block[]} blocks
 * @returns {Uint8Array}
 */
function jointMask(blocks) {
  const mask = new Uint8Array(AREA).fill(1);
  for (const b of blocks) {
    for (let y = 0; y < FACE_H; y++) {
      for (let x = 0; x < b.w - MORTAR; x++) mask[(((b.y + y) & MASK) << 6) | ((b.x + x) & MASK)] = 0;
    }
  }
  return mask;
}

/**
 * Paint one frozen rock block face: flat tonal patches, a split into two rough planes, bevel, grain.
 * @param {Uint8Array} buf
 * @param {{x:number, y:number, w:number}} b
 * @param {number} seed
 * @param {Rng} rng
 * @param {number} lift tone offset for the whole block (frost-rimed stone is paler)
 */
function paintRockBlock(buf, b, seed, rng, lift) {
  const fw = b.w - MORTAR;
  const fh = FACE_H;
  const baseT = 0.5 + lift + rng.range(-0.2, 0.18);
  const bevel = rng.range(0.6, 1.2);
  // Rough-hewn: a random line splits the face into two planes that catch light differently.
  const px = rng.range(fw * 0.25, fw * 0.75);
  const ax = rng.range(-1, 1);
  const planeD = rng.chance(0.5) ? 0.15 : -0.15;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const gx = b.x + x;
      const gy = b.y + y;
      let t = baseT + (fbmChunky(gx, gy, seed) - 0.5) * 0.34;
      if (x - px + (y - fh / 2) * ax > 0) t += planeD;
      if (y === 0 || x === 0) t += 0.26 * bevel;
      else if (y === 1 || x === 1) t += 0.1 * bevel;
      if (y >= fh - 2 || x >= fw - 2) t -= 0.17;
      if (y === fh - 1 || x === fw - 1) t -= 0.12;
      put(buf, gx, gy, rampPickFlat(ROCK, t));
    }
  }
  // Weathering patches, one whole step off.
  const patches = 2 + rng.int(3);
  for (let i = 0; i < patches; i++) {
    const cx = 2 + rng.int(fw - 8);
    const cy = 2 + rng.int(fh - 6);
    const cw = 4 + rng.int(4);
    const ch = 2 + rng.int(3);
    const d = rng.chance(0.5) ? 1 : -1;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const at = (((b.y + cy + y) & MASK) << 6) | ((b.x + cx + x) & MASK);
        buf[at] = shift(ROCK, buf[at], d);
      }
    }
  }
  // Grain: crisp single-texel pits and mica glints.
  const flecks = 7 + rng.int(6);
  for (let i = 0; i < flecks; i++) {
    const at = (((b.y + 2 + rng.int(fh - 4)) & MASK) << 6) | ((b.x + 2 + rng.int(fw - 5)) & MASK);
    const s = ROCK.indexOf(buf[at]);
    const n = rng.chance(0.25) ? s + 1 : s - 1;
    if (s >= 0 && n >= 1 && n < ROCK.length) buf[at] = ROCK[n];
  }
}

/**
 * Mortar bed: dark rock grooves across the whole tile.
 * @param {Uint8Array} buf
 * @param {number} seed
 */
function paintMortar(buf, seed) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      buf[(y << 6) | x] = rampPickChunky(ROCK, 0.02 + fbmChunky(x, y, seed ^ 0x51a7) * 0.26, x, y);
    }
  }
}

/**
 * A translucent ice sheet flowing down from the top of a block face, tinted by the rock under it.
 * @param {Uint8Array} buf
 * @param {{x:number, y:number, w:number}} b
 * @param {number} seed
 * @param {Rng} rng
 */
function paintIceSheet(buf, b, seed, rng) {
  const fw = b.w - MORTAR;
  // Broad sheets: most of the block, so at distance a glazed block reads as one pale plane rather
  // than as ragged scraps (v1's narrow, rock-tinted sheets turned into camouflage patches).
  const sx = rng.int(Math.max(1, Math.floor(fw * 0.3)));
  const sw = Math.max(12, fw - sx - rng.int(Math.max(1, Math.floor(fw * 0.25))));
  const reach = rng.range(0.6, 1.0);
  const tone = rng.chance(0.5) ? 4 : 5;
  for (let x = 0; x < sw && sx + x < fw; x++) {
    const gx = b.x + sx + x;
    const taper = Math.min(1, (x + 1) / 4, (sw - x) / 4);
    const flow = 0.62 * vnoise(gx & MASK, b.y, 16, seed ^ 0x1ce) + 0.38 * vnoise(gx & MASK, b.y, 4, seed ^ 0x1cf);
    let dep = Math.max(2, Math.round(FACE_H * reach * taper * (0.5 + 0.7 * flow)));
    // A drip finger now and then runs past the face into the groove.
    const finger = flow > 0.68 && taper === 1;
    if (finger) dep = FACE_H + 2;
    const streak = vnoise(gx & MASK, 3, 4, seed ^ 0x57a) > 0.6 ? 1 : 0;
    for (let y = 0; y < dep; y++) {
      const at = (((b.y + y) & MASK) << 6) | (gx & MASK);
      const s = ROCK.indexOf(buf[at]);
      // Translucent, but only a hint of the rock: one step down where the stone under it is dark.
      let is = tone + streak - (s >= 0 && s <= 2 ? 1 : 0);
      if (y < 2) is += 1; // thick lip where the sheet leaves the ledge
      if (x === 0) is += 1; // lit left edge
      else if (x === sw - 1) is -= 1;
      if (y === dep - 1) is = finger ? 8 : Math.max(is, 6); // bright drip front
      buf[at] = step(ICE, is);
    }
    if (dep < FACE_H) {
      const at = (((b.y + dep) & MASK) << 6) | (gx & MASK);
      buf[at] = shift(ROCK, buf[at], -1); // wet shadow under the front
    }
  }
  const glints = 1 + rng.int(2);
  for (let i = 0; i < glints; i++) {
    const gx = b.x + sx + 1 + rng.int(Math.max(1, sw - 4));
    const gy = b.y + 2 + rng.int(3);
    put(buf, gx, gy, ICE[8]);
    put(buf, gx + 1, gy, ICE[8]);
    put(buf, gx, gy + 1, ICE[7]);
  }
}

/**
 * A feathered frost star (used sparingly, on the rimed wall and the rune floor only).
 * @param {Uint8Array} buf
 * @param {number} cx
 * @param {number} cy
 * @param {boolean} big
 */
function crystal(buf, cx, cy, big) {
  put(buf, cx, cy, SNOW[3]);
  put(buf, cx - 1, cy, SNOW[2]);
  put(buf, cx + 1, cy, SNOW[1]);
  put(buf, cx, cy - 1, SNOW[2]);
  put(buf, cx, cy + 1, SNOW[1]);
  if (big) {
    put(buf, cx - 2, cy, SNOW[1]);
    put(buf, cx + 2, cy, SNOW[0]);
    put(buf, cx, cy - 2, SNOW[1]);
    put(buf, cx, cy + 2, SNOW[0]);
    put(buf, cx - 1, cy - 1, SNOW[0]);
    put(buf, cx + 1, cy + 1, SNOW[0]);
    put(buf, cx + 1, cy - 1, SNOW[0]);
    put(buf, cx - 1, cy + 1, SNOW[0]);
  }
}

/**
 * Rime crust along every bed joint: chunky runs of frost on the groove and the block's top lip,
 * rising into taller tufts where the noise peaks. Runs, not dots — single-texel crystals read as a
 * field of "+" stitches once the raycaster shrinks a wall to a few pixels per block.
 * @param {Uint8Array} buf
 * @param {Block[]} blocks
 * @param {number} seed noise seed
 * @param {number} amount 0..1
 */
function paintJointFrost(buf, blocks, seed, amount) {
  const thr = 1 - 0.55 * amount;
  for (const b of blocks) {
    for (let x = -MORTAR; x < b.w - MORTAR; x++) {
      const gx = (b.x + x) & MASK;
      const n = 0.7 * vnoise(gx, b.y, 8, seed ^ 0xf057) + 0.3 * vnoise(gx, b.y, 4, seed ^ 0xf058);
      if (n < thr) continue;
      const k = (n - thr) / (1 - thr);
      put(buf, gx, b.y - 1, k > 0.35 ? SNOW[2] : SNOW[0]);
      if (x >= 0) put(buf, gx, b.y, k > 0.55 ? SNOW[3] : SNOW[1]);
      if (k > 0.5) put(buf, gx, b.y - 2, SNOW[1]);
      if (k > 0.75) put(buf, gx, b.y - 3, SNOW[0]);
      if (x >= 0 && k > 0.7) put(buf, gx, b.y + 1, SNOW[0]);
    }
  }
}

/**
 * Icicles hanging from each course ledge down across the groove and onto the block below: a
 * glassy root 3–4 texels wide tapering to a single-texel tip, lit left, shadowed right.
 * Only icicles whose whole footprint lies where `region` equals `want` are hung, so an icicle is
 * never cut in half where one variant's texels meet the shared ones.
 * @param {Uint8Array} buf
 * @param {Rng} rng
 * @param {number} perCourse average count per course
 * @param {number} maxLen
 * @param {Uint8Array} region
 * @param {number} want
 */
function paintIcicles(buf, rng, perCourse, maxLen, region, want) {
  const fits = (/** @type {number} */ x, /** @type {number} */ top, /** @type {number} */ len, /** @type {number} */ root) => {
    for (let k = 0; k <= len; k++) {
      for (let j = 0; j <= root; j++) if (region[(((top + k) & MASK) << 6) | ((x + j) & MASK)] !== want) return false;
    }
    return true;
  };
  for (let r = 0; r < COURSE_COUNT; r++) {
    const top = COURSE_PHASE + r * COURSE_H + FACE_H - 1; // the ledge: last row of the face
    const n = Math.max(1, Math.round(perCourse * rng.range(0.7, 1.3)));
    let x = rng.int(SIZE);
    for (let i = 0; i < n; i++) {
      x += 6 + rng.int(Math.max(1, Math.floor(SIZE / n) - 6));
      const len = 6 + rng.int(Math.max(1, maxLen - 5));
      const root = rng.chance(0.4) ? 4 : 3;
      let tries = 0;
      while (tries < SIZE && !fits(x, top, len, root)) {
        x++;
        tries++;
      }
      if (tries === SIZE) break;
      for (let k = 0; k <= len; k++) {
        const y = top + k;
        const w = Math.max(1, Math.round(root * (1 - k / (len + 1)) + 0.3));
        for (let j = 0; j < w; j++) {
          const c = k === len ? ICE[8] : j === 0 ? ICE[7] : j === w - 1 && w > 2 ? ICE[4] : ICE[6];
          put(buf, x + j, y, c);
        }
        const at = ((y & MASK) << 6) | ((x + w) & MASK);
        if (k > 0 && ROCK.indexOf(buf[at]) >= 0) buf[at] = shift(ROCK, buf[at], -1);
      }
      put(buf, x, top + 1, ICE[8]); // highlight running down the lit side
      put(buf, x, top + 2, ICE[8]);
    }
  }
}

/**
 * Glazed rock wall over the shared layout. Painted whole; {@link paint} keeps only the texels the
 * variant owns. `edge` = true paints the shared edge blocks' decor (sheets, icicles) and skips the
 * interior block's, false the reverse.
 * @param {number} seed
 * @param {{sheets:number, frost:number, rime:boolean, icicles:number}} o
 * @param {Block[]} blocks
 * @param {number} shared the tileset's edge seed (mortar noise, continuous across cells)
 * @param {Uint8Array} owner {@link ownerMask}
 * @param {boolean} edge
 * @returns {Uint8Array}
 */
function paintRockWall(seed, o, blocks, shared, owner, edge) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  paintMortar(buf, shared);
  for (const b of blocks) paintRockBlock(buf, b, seed, rng, o.rime ? 0.06 : 0);

  if (o.rime) {
    // Hoarfrost growing out of the joints: snow packs the grooves, rime creeps over the faces.
    const joints = jointMask(blocks);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = (y << 6) | x;
        const n = fbmChunky(x, y, seed ^ 0x7105);
        if (joints[i]) {
          if (n > 0.46) buf[i] = rampPickFlat(SNOW, (n - 0.46) * 2.6);
          continue;
        }
        // Distance to the nearest joint (capped at 5), along both axes.
        let d = 5;
        for (let k = 1; k < 5 && k < d; k++) {
          if (joints[(y << 6) | ((x + k) & MASK)] || joints[(y << 6) | ((x - k) & MASK)] || joints[(((y + k) & MASK) << 6) | x] || joints[(((y - k) & MASK) << 6) | x]) d = k;
        }
        const v = n + (5 - d) * 0.1;
        if (v > 0.9) buf[i] = rampPickFlat(SNOW, (v - 0.9) * 3);
        else if (v > 0.8) buf[i] = shift(ROCK, buf[i], 1);
      }
    }
    // Feathered star crystals, in the bed joint above an interior block (clear of the shared cells).
    const stars = 2 + rng.int(2);
    const inner = blocks.filter((b) => !b.edge);
    for (let i = 0; i < stars; i++) {
      const b = inner[rng.int(inner.length)];
      crystal(buf, b.x + 2 + rng.int(Math.max(1, b.w - MORTAR - 4)), b.y - 2, true);
    }
  }

  for (const b of blocks) if (rng.chance(o.sheets) && b.edge === edge) paintIceSheet(buf, b, seed, rng);
  paintJointFrost(buf, blocks, seed, o.frost);
  // Half the icicles hang from the shared edge cells and half from the variant's own.
  paintIcicles(buf, rng, o.icicles / 2, 11, owner, edge ? 0 : 1);
  return buf;
}

// ─── Walls: thick ice ──────────────────────────────────────────────────────────────────────────

/**
 * Wander a white crack across ice: a bright hairline with a dark refracted shadow under it.
 * @param {Uint8Array} buf
 * @param {Rng} rng
 * @param {number} x
 * @param {number} y
 * @param {number} len
 * @param {number} depth branch depth
 */
function iceCrack(buf, rng, x, y, len, depth) {
  let ang = rng.range(0, Math.PI * 2);
  let fx = x;
  let fy = y;
  for (let i = 0; i < len; i++) {
    const ix = Math.round(fx);
    const iy = Math.round(fy);
    put(buf, ix, iy, i % 5 === 2 ? ICE[8] : SNOW[2]);
    const at = (((iy + 1) & MASK) << 6) | ((ix + 1) & MASK);
    if (ICE.indexOf(buf[at]) >= 0) buf[at] = shift(ICE, buf[at], -2);
    ang += rng.range(-0.45, 0.45);
    fx += Math.cos(ang);
    fy += Math.sin(ang);
    if (depth > 0 && rng.chance(0.07)) iceCrack(buf, rng, ix, iy, (len - i) >> 1, depth - 1);
  }
}

/**
 * Bubble frozen in ice: a ring lit top-left, dark bottom-right, lighter core.
 * @param {Uint8Array} buf
 * @param {number} cx
 * @param {number} cy
 * @param {number} r 0 = single texel
 */
function bubble(buf, cx, cy, r) {
  if (r === 0) {
    put(buf, cx, cy, ICE[7]);
    put(buf, cx + 1, cy + 1, ICE[2]);
    return;
  }
  for (let dy = -r - 1; dy <= r + 1; dy++) {
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      const at = (((cy + dy) & MASK) << 6) | ((cx + dx) & MASK);
      if (d > r + 0.5) continue;
      if (d > r - 0.5) buf[at] = dx + dy < 0 ? ICE[8] : dx + dy > 0 ? ICE[2] : ICE[6];
      else buf[at] = shift(ICE, buf[at], 1);
    }
  }
  put(buf, cx - Math.max(0, r - 1), cy - Math.max(0, r - 1), ICE[8]);
}

/**
 * A point inside `region`, by rejection (falls back to the last candidate).
 * @param {Rng} rng
 * @param {Uint8Array} region
 * @returns {[number, number]}
 */
function pointIn(rng, region) {
  let x = 0;
  let y = 0;
  for (let k = 0; k < 24; k++) {
    x = rng.int(SIZE);
    y = rng.int(SIZE);
    if (region[(y << 6) | x]) break;
  }
  return [x, y];
}

/**
 * Thick clear ice wall (variant 1) and the frozen-relic showpiece (variant 3). Painted whole; the
 * sheet only shows inside {@link iceMask}, framed by the shared rock blocks at the tile edges.
 * @param {number} seed
 * @param {boolean} relic freeze a sword and a skull into the sheet
 * @param {Block[]} blocks
 * @param {Uint8Array} ice {@link iceMask}
 * @returns {Uint8Array}
 */
function paintIceWall(seed, relic, blocks, ice) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  const joints = jointMask(blocks);
  const cells = 4;
  const lift = relic ? 0.05 : 0;
  /** @type {number[]} */
  const cellTone = [];
  /** @type {number[]} */
  const cellGx = [];
  /** @type {number[]} */
  const cellGy = [];
  for (let i = 0; i < cells * cells; i++) {
    cellTone.push(0.38 + lift + rng.range(-0.12, 0.16));
    const a = rng.range(0, Math.PI * 2);
    cellGx.push(Math.cos(a) * 0.011);
    cellGy.push(Math.sin(a) * 0.011);
  }

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      voronoi(x, y, cells, seed ^ 0x1ce0);
      const id = VOR.id1;
      // Fractured planes: each cell a flat-ish plate with its own tone and a gentle tilt.
      let t = cellTone[id] + VOR.fx * cellGx[id] + VOR.fy * cellGy[id];
      t += (fbmChunky(x, y, seed) - 0.5) * 0.14;
      if (vnoise(x, y, 16, seed ^ 0xdee) > 0.68) t -= 0.12; // a deep blue core
      // The rock joints ghost through the ice.
      if (joints[i]) t -= 0.16;
      else if (joints[(((y - 1) & MASK) << 6) | x] || joints[(((y + 1) & MASK) << 6) | x]) t -= 0.05;
      const edge = VOR.d2 - VOR.d1;
      if (edge < 1.2 && h01(Math.min(id, VOR.id2), Math.max(id, VOR.id2), seed ^ 0xed9e) > 0.35) {
        t += VOR.fy < 0 ? 0.24 : -0.12; // a refracted edge: bright on one side of the fracture plane
      }
      buf[i] = rampPickFlat(ICE, t);
    }
  }

  if (relic) paintRelics(buf, rng, ice);

  // Bubble trails and loose bubbles.
  const trails = relic ? 2 : 4;
  for (let k = 0; k < trails; k++) {
    let [bx, by] = pointIn(rng, ice);
    const count = 3 + rng.int(3);
    for (let j = 0; j < count; j++) {
      bubble(buf, bx, by, j === count - 1 ? 1 : 0);
      by -= 3 + rng.int(3);
      if (rng.chance(0.4)) bx += rng.chance(0.5) ? 1 : -1;
    }
  }
  const loose = relic ? 3 : 6;
  for (let k = 0; k < loose; k++) {
    const [bx, by] = pointIn(rng, ice);
    bubble(buf, bx, by, rng.int(3));
  }

  // White cracks.
  const cracks = relic ? 2 : 3;
  for (let k = 0; k < cracks; k++) {
    const [cx, cy] = pointIn(rng, ice);
    iceCrack(buf, rng, cx, cy, 14 + rng.int(18), 2);
  }

  // Frost and icicles on the ghost ledges keep the course rhythm of the rock walls.
  paintJointFrost(buf, blocks, seed, 0.4);
  paintIcicles(buf, rng, 1.5, 8, ice, 1);
  return buf;
}

/**
 * Seat an ice wall's sheet in the shared rock frame: take the ice texels, keep `base` elsewhere, and
 * give the sheet a lit lip along its top and left rims and a dark refracted rim bottom and right.
 * @param {Uint8Array} base
 * @param {Uint8Array} sheet
 * @param {Uint8Array} ice {@link iceMask}
 * @returns {Uint8Array}
 */
function frameIce(base, sheet, ice) {
  const out = base.slice();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      if (!ice[i]) continue;
      let c = sheet[i];
      if (ICE.indexOf(c) >= 0) {
        if (!ice[(((y - 1) & MASK) << 6) | x] || !ice[(y << 6) | ((x - 1) & MASK)]) c = shift(ICE, c, 2);
        else if (!ice[(((y + 1) & MASK) << 6) | x] || !ice[(y << 6) | ((x + 1) & MASK)]) c = shift(ICE, c, -2);
      }
      out[i] = c;
    }
  }
  return out;
}

/**
 * Take `variant` where `owner` is set and `base` elsewhere.
 * @param {Uint8Array} base
 * @param {Uint8Array} variant
 * @param {Uint8Array} owner
 * @returns {Uint8Array}
 */
function blend(base, variant, owner) {
  const out = base.slice();
  for (let i = 0; i < AREA; i++) if (owner[i]) out[i] = variant[i];
  return out;
}

/**
 * Freeze a sword and a skull into an ice sheet: dark silhouettes with a darker halo of murk. Each
 * shape is slid to wherever it sits most fully inside the ice column (`ice`), searching from a
 * random start so the seed still moves them, and anything left over the rock frame is cut off.
 * @param {Uint8Array} buf
 * @param {Rng} rng
 * @param {Uint8Array} ice {@link iceMask}
 */
function paintRelics(buf, rng, ice) {
  const mask = new Uint8Array(AREA);
  /** @type {Uint8Array} */
  let target = mask;
  const mark = (/** @type {number} */ x, /** @type {number} */ y) => {
    target[((y & MASK) << 6) | (x & MASK)] = 1;
  };
  const span = (/** @type {number} */ y, /** @type {number} */ x0, /** @type {number} */ x1) => {
    for (let x = x0; x <= x1; x++) mark(x, y);
  };
  /** @type {number[][]} */
  let holes = [];
  const probe = new Uint8Array(AREA);
  /**
   * Best of `candidates` by how many of the shape's texels land in fresh ice.
   * @param {Array<number[]>} candidates
   * @param {(...a:number[]) => void} draw
   */
  const place = (candidates, draw) => {
    let best = candidates[0];
    let bestScore = -1e9;
    const start = rng.int(candidates.length);
    for (let c = 0; c < candidates.length; c++) {
      const args = candidates[(start + c) % candidates.length];
      probe.fill(0);
      target = probe;
      draw(...args);
      let score = 0;
      for (let i = 0; i < AREA; i++) if (probe[i]) score += ice[i] && !mask[i] ? 1 : -3;
      if (score > bestScore) {
        bestScore = score;
        best = args;
      }
    }
    target = mask;
    draw(...best);
  };

  // Sword, point down, leaning a little.
  /** @type {Array<number[]>} */
  const swords = [];
  for (let x = 0; x < SIZE; x++) swords.push([x, 1], [x, -1]);
  place(swords, drawSword);
  // Skull and a long bone beside it.
  /** @type {Array<number[]>} */
  const skulls = [];
  for (let y = 12; y <= 40; y += 2) for (let x = 0; x < SIZE; x++) skulls.push([x, y]);
  place(skulls, drawSkull);
  /** @type {Array<number[]>} */
  const femurs = [];
  for (let y = 36; y <= 46; y += 2) for (let x = 0; x < SIZE; x += 2) femurs.push([x, y, 1], [x, y, -1]);
  place(femurs, drawFemur);

  /** @param {number} sx @param {number} lean */
  function drawSword(sx, lean) {
    for (let y = 8; y <= 57; y++) {
      const x = sx + lean * Math.floor((y - 8) / 16);
      if (y <= 10) span(y, x - 1, x + 2); // pommel
      else if (y <= 16) span(y, x, x + 1); // grip
      else if (y <= 18) span(y, x - 6, x + 7); // crossguard
      else if (y === 19) {
        span(y, x - 1, x + 2);
        mark(x - 6, y);
        mark(x + 7, y); // drooping quillon tips
      } else if (y <= 50) span(y, x - 1, x + 2); // blade
      else if (y <= 54) span(y, x, x + 1);
      else if (y <= 56) mark(x, y);
    }
  }

  /** @param {number} kx @param {number} ky */
  function drawSkull(kx, ky) {
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        if ((dx * dx) / 22 + (dy * dy) / 20 <= 1) mark(kx + dx, ky + dy);
      }
    }
    span(ky + 5, kx - 2, kx + 2);
    span(ky + 6, kx - 2, kx + 2); // jaw
    holes = [
      [kx - 3, ky + 1], [kx - 2, ky + 1], [kx - 3, ky + 2], [kx - 2, ky + 2],
      [kx + 1, ky + 1], [kx + 2, ky + 1], [kx + 1, ky + 2], [kx + 2, ky + 2],
      [kx, ky + 4],
    ];
  }

  /** Femur lying diagonally. @param {number} fx0 @param {number} fy0 @param {number} fdir */
  function drawFemur(fx0, fy0, fdir) {
    for (let k = 0; k <= 14; k++) {
      const x = fx0 + k;
      const y = fy0 + Math.round((k * fdir * 8) / 14);
      mark(x, y);
      mark(x, y + 1);
    }
    for (const [ex, ey] of [[fx0, fy0], [fx0 + 14, fy0 + fdir * 8]]) {
      mark(ex - 1, ey - 1);
      mark(ex + 1, ey - 1);
      mark(ex - 1, ey + 2);
      mark(ex + 1, ey + 2);
      span(ey, ex - 1, ex + 1);
      span(ey + 1, ex - 1, ex + 1);
    }
  }

  for (let i = 0; i < AREA; i++) if (!ice[i]) mask[i] = 0;
  holes = holes.filter(([hx, hy]) => ice[((hy & MASK) << 6) | (hx & MASK)]);

  // Halo of murk around the shapes (distance 1–2), then the silhouette itself.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      if (mask[i]) continue;
      let near = 0;
      for (let dy = -2; dy <= 2 && near < 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!mask[(((y + dy) & MASK) << 6) | ((x + dx) & MASK)]) continue;
          near = Math.max(near, Math.abs(dx) <= 1 && Math.abs(dy) <= 1 ? 2 : 1);
        }
      }
      if (near) buf[i] = shift(ICE, buf[i], -near);
    }
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      if (!mask[i]) continue;
      // Edge texels read through a little ice; the core is black rock-dark.
      const edge =
        !mask[(y << 6) | ((x - 1) & MASK)] ||
        !mask[(y << 6) | ((x + 1) & MASK)] ||
        !mask[(((y - 1) & MASK) << 6) | x] ||
        !mask[(((y + 1) & MASK) << 6) | x];
      buf[i] = edge ? ICE[0] : ROCK[0];
    }
  }
  for (const [hx, hy] of holes) put(buf, hx, hy, ICE[2]);
}

// ─── Floors ────────────────────────────────────────────────────────────────────────────────────

/** Flagstone row heights (sum 64). */
const FLAG_ROWS = [15, 17, 14, 18];
const FLAG_GAP = 2;

/**
 * Frosted flagstones with snow drifted into the gaps. Toroidal.
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintFlagstones(seed) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  let y0 = rng.int(SIZE);
  for (const h of FLAG_ROWS) {
    let x0 = rng.int(SIZE);
    let remaining = SIZE;
    while (remaining > 0) {
      const w = remaining <= 32 ? remaining : 16 + rng.int(Math.min(17, remaining - 31));
      paintFlag(buf, x0, y0, w, h, seed, rng);
      x0 += w;
      remaining -= w;
    }
    y0 += h;
  }
  return buf;
}

/**
 * One flagstone and the gap on its top and left.
 * @param {Uint8Array} buf
 * @param {number} bx
 * @param {number} by
 * @param {number} w
 * @param {number} h
 * @param {number} seed
 * @param {Rng} rng
 */
function paintFlag(buf, bx, by, w, h, seed, rng) {
  const baseT = 0.52 + rng.range(-0.14, 0.12);
  const fw = w - FLAG_GAP;
  const fh = h - FLAG_GAP;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = (bx + x) & MASK;
      const gy = (by + y) & MASK;
      const i = (gy << 6) | gx;
      const drift = fbmChunky(gx, gy, seed ^ 0x5a0);
      if (x < FLAG_GAP || y < FLAG_GAP) {
        // Gap: snow drifted in clumps, bare dark crack between them.
        // Head joints (x) hold less snow than bed joints, or they line up into bright posts tile after tile.
        const lim = y < FLAG_GAP ? 0.46 : 0.58;
        buf[i] = drift > lim ? rampPickFlat(SNOW, (drift - lim) * 3) : drift > lim - 0.08 ? ROCK[2] : ROCK[1];
        continue;
      }
      const fx = x - FLAG_GAP;
      const fy = y - FLAG_GAP;
      const d = Math.min(fx, fy, fw - 1 - fx, fh - 1 - fy);
      // Drift spilling over the rim of the stone.
      if (drift + Math.max(0, 2 - d) * 0.12 > 0.74) {
        buf[i] = rampPickFlat(SNOW, (drift - 0.5) * 2.2);
        continue;
      }
      let t = baseT + (fbmChunky(gx, gy, seed) - 0.5) * 0.3;
      if (fx === 0 || fy === 0) t += 0.16;
      if (fx === fw - 1 || fy === fh - 1) t -= 0.2;
      // Frost bloom on the face.
      const frost = vnoise(gx, gy, 8, seed ^ 0xf2) * 0.6 + vnoise(gx, gy, 4, seed ^ 0xf3) * 0.4;
      if (frost > 0.66) {
        buf[i] = frost > 0.75 ? SNOW[1] : SNOW[0];
        continue;
      }
      if (frost > 0.56) t += 0.14;
      buf[i] = rampPickFlat(FLAG, t);
    }
  }
  // Now and then a crack across the stone.
  if (rng.chance(0.35)) {
    let cx = bx + FLAG_GAP + 2 + rng.int(Math.max(1, fw - 4));
    const drift = rng.chance(0.5) ? 1 : -1;
    for (let y = by + FLAG_GAP; y < by + h; y++) {
      put(buf, cx, y, FLAG[2]);
      if (rng.chance(0.4)) cx += drift;
    }
  }
}

/** A frozen pool's rounded-square outline: inset from each tile edge, corner radius. */
const POOL_INSET = 9;
const POOL_R = 14;

/**
 * A frozen pool of polished ice lying over the shared flagstones (floor variant 1). The pool keeps a
 * wobbling 5–13 texel margin of the same flagstones as floor[0] at every tile edge, so it meets any
 * floor variant on either axis; a packed-snow rim seats it on the stone.
 * @param {Uint8Array} flags floor[0]
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintIcePool(flags, seed) {
  const ice = paintIceFloor(seed);
  const out = flags.slice();
  const half = 31.5 - POOL_INSET - POOL_R;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const qx = Math.abs(x - 31.5) - half;
      const qy = Math.abs(y - 31.5) - half;
      const sdf = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - POOL_R;
      const s = sdf + (vnoise(x, y, 16, seed ^ 0x9001) - 0.5) * 7 + (vnoise(x, y, 4, seed ^ 0x9002) - 0.5) * 2;
      const i = (y << 6) | x;
      if (s < -1.2) out[i] = s > -2.4 && ICE.indexOf(ice[i]) >= 0 ? shift(ICE, ice[i], 1) : ice[i];
      else if (s < 0.4) out[i] = h01(x, y, seed ^ 0x9003) > 0.3 ? SNOW[2] : SNOW[1];
      else if (s < 1.4 && FLAG.indexOf(out[i]) >= 0) out[i] = shift(FLAG, out[i], -1); // wet stone
    }
  }
  return out;
}

/**
 * Polished ice plates split by white crack lines. Toroidal.
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintIceFloor(seed) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  const streakA = rng.int(SIZE);
  const streakB = (streakA + 20 + rng.int(20)) & MASK;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      voronoi(x, y, 4, seed);
      const id = VOR.id1;
      let t = 0.46 + h01(id, 7, seed ^ 0x70) * 0.24 + (VOR.fx - VOR.fy) * 0.005;
      t += (fbmChunky(x, y, seed ^ 0x11) - 0.5) * 0.16;
      if (vnoise(x, y, 32, seed ^ 0xdeed) < 0.34) t -= 0.14; // dark water deep under the ice
      // Polish: two diagonal reflection streaks, broken up by noise.
      const u = (x - y) & MASK;
      if ((((u - streakA) & MASK) < 3 || ((u - streakB) & MASK) < 2) && vnoise(x, y, 16, seed ^ 0x5e) > 0.42) t += 0.2;
      const edge = VOR.d2 - VOR.d1;
      const cracked = h01(Math.min(id, VOR.id2), Math.max(id, VOR.id2), seed ^ 0xc4) > 0.22;
      const i = (y << 6) | x;
      if (cracked && edge < 1.1) {
        buf[i] = h01(x, y, seed ^ 0x3) > 0.8 ? SNOW[3] : SNOW[2];
        continue;
      }
      if (cracked && edge < 2.4) t -= 0.16; // the crack's depth shadow
      buf[i] = rampPickFlat(ICE, t);
    }
  }
  // Fine cracks spidering off the big ones.
  for (let k = 0; k < 4; k++) iceCrack(buf, rng, rng.int(SIZE), rng.int(SIZE), 8 + rng.int(10), 1);
  return buf;
}

/**
 * Bresenham line with a callback-free put.
 * @param {Uint8Array} buf
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {Uint8Array} mask receives 1 on every texel drawn
 */
function markLine(buf, x0, y0, x1, y1, mask) {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    mask[((y0 & MASK) << 6) | (x0 & MASK)] = 1;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * A hoarfrost rune circle laid over the shared flagstones (the rare floor tile). The outer ring stays
 * 6 texels clear of every tile edge, so the stones around it are floor[0]'s own.
 * @param {Uint8Array} flags floor[0]
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintRuneFloor(flags, seed) {
  const buf = flags.slice();
  const rng = createRng(seed ^ 0x2a2a);
  const bright = new Uint8Array(AREA); // 1 = frost line
  const cx = 31.5;
  const cy = 31.5;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const r = Math.hypot(x - cx, y - cy);
      if ((r > 23 && r < 25.6) || (r > 15.3 && r < 16.7)) bright[(y << 6) | x] = 1;
    }
  }
  // Hexagram inside the inner ring.
  for (let tri = 0; tri < 2; tri++) {
    for (let k = 0; k < 3; k++) {
      const a0 = (tri * Math.PI) / 3 + (k * Math.PI * 2) / 3 - Math.PI / 2;
      const a1 = a0 + (Math.PI * 2) / 3;
      markLine(buf, cx + Math.cos(a0) * 15, cy + Math.sin(a0) * 15, cx + Math.cos(a1) * 15, cy + Math.sin(a1) * 15, bright);
    }
  }
  // Eight runes in the band between the rings.
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4 + Math.PI / 8;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const px = -sa;
    const py = ca;
    markLine(buf, cx + ca * 18, cy + sa * 18, cx + ca * 22, cy + sa * 22, bright);
    const kind = (k + rng.int(2)) % 3;
    if (kind === 0) markLine(buf, cx + ca * 20 - px * 2, cy + sa * 20 - py * 2, cx + ca * 20 + px * 2, cy + sa * 20 + py * 2, bright);
    else if (kind === 1) {
      markLine(buf, cx + ca * 18 + px * 2, cy + sa * 18 + py * 2, cx + ca * 20, cy + sa * 20, bright);
      markLine(buf, cx + ca * 22 + px * 2, cy + sa * 22 + py * 2, cx + ca * 20, cy + sa * 20, bright);
    } else {
      markLine(buf, cx + ca * 19 - px * 2, cy + sa * 19 - py * 2, cx + ca * 21 + px * 2, cy + sa * 21 + py * 2, bright);
    }
  }
  // Frost fuzz around every line, then the lines themselves.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y << 6) | x;
      if (bright[i]) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        for (let dx = -1; dx <= 1; dx++) if (bright[(((y + dy) & MASK) << 6) | ((x + dx) & MASK)]) near = true;
      }
      if (near && h01(x, y, seed ^ 0xfa22) > 0.45) buf[i] = SNOW[0];
      else if (Math.hypot(x - cx, y - cy) < 25 && FLAG.indexOf(buf[i]) >= 0) buf[i] = shift(FLAG, buf[i], -1);
    }
  }
  for (let i = 0; i < AREA; i++) {
    if (bright[i]) buf[i] = h01(i & MASK, i >> 6, seed ^ 0x77) > 0.15 ? SNOW[3] : SNOW[1];
  }
  crystal(buf, 32, 32, true);
  return buf;
}

// ─── Ceiling ───────────────────────────────────────────────────────────────────────────────────

/**
 * An icicle seen tip-on from below: a glassy disc with a bright core.
 * @param {Uint8Array} buf
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 */
function icicleTip(buf, cx, cy, r) {
  for (let dy = -r - 1; dy <= r + 1; dy++) {
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r + 0.6) {
        if (d < r + 1.6 && dx + dy > 0) {
          const at = (((cy + dy) & MASK) << 6) | ((cx + dx) & MASK);
          if (ROCK.indexOf(buf[at]) >= 0) buf[at] = ROCK[0];
        }
        continue;
      }
      put(buf, cx + dx, cy + dy, d < 0.6 ? ICE[8] : dx + dy < 0 ? ICE[7] : d > r - 0.4 && dx + dy > 0 ? ICE[3] : ICE[5]);
    }
  }
}

/**
 * An icicle cluster: a big tip and a few smaller ones within ±4 texels (reach ±8 with shadows).
 * @param {Uint8Array} buf
 * @param {Rng} rng
 * @param {number} cx
 * @param {number} cy
 */
function icicleCluster(buf, rng, cx, cy) {
  const n = 3 + rng.int(4);
  for (let j = 0; j < n; j++) icicleTip(buf, cx + rng.int(9) - 4, cy + rng.int(9) - 4, j === 0 ? 2 : rng.int(2) + 1);
}

/**
 * The ceiling both variants share: rough frozen rock, frost patches, and the icicle clusters that
 * straddle the top/bottom edge (rows 56–63 and 0–8). Toroidal.
 * @param {number} seed
 * @returns {Uint8Array}
 */
function paintCeilingBase(seed) {
  const buf = new Uint8Array(AREA);
  const rng = createRng(seed);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const n = fbmChunky(x, y, seed);
      const nb = fbmChunky(x + 2, y + 2, seed);
      let t = 0.4 + (n - 0.5) * 0.6 + (n - nb) * 2.6; // embossed relief
      const fis = vnoise(x, y, 16, seed ^ 0xf155) - 0.5;
      if (Math.abs(fis) < 0.025) t = 0.02; // dark fissure
      let c = rampPickFlat(ROCK, t);
      if (t > 0.74) c = SNOW[0]; // frost on the knuckles
      buf[(y << 6) | x] = c;
    }
  }
  // Frost patches.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const fr = fbmChunky(x, y, seed ^ 0xab);
      if (fr > 0.7) buf[(y << 6) | x] = fr > 0.76 ? SNOW[1] : SNOW[0];
    }
  }
  const edgeClusters = 2 + rng.int(2);
  let ex = rng.int(SIZE);
  for (let k = 0; k < edgeClusters; k++) {
    icicleCluster(buf, rng, ex, rng.int(3) - 1);
    ex += 14 + rng.int(Math.max(1, Math.floor(SIZE / edgeClusters) - 12));
  }
  return buf;
}

/**
 * Plain frozen-rock ceiling, or the one with an ice-crusted rock rib across the tile, over the shared
 * base. Everything a variant adds stays within rows 11–53, so the two meet along y.
 * @param {Uint8Array} base {@link paintCeilingBase}
 * @param {number} seed
 * @param {boolean} rib
 * @returns {Uint8Array}
 */
function paintCeiling(base, seed, rib) {
  const buf = base.slice();
  const rng = createRng(seed);

  const RIB_Y = 23;
  const RIB_H = 18;
  if (rib) {
    for (let x = 0; x < SIZE; x++) {
      const top = RIB_Y + Math.round((vnoise(x, 0, 8, seed ^ 0x71b) - 0.5) * 3);
      const bot = RIB_Y + RIB_H + Math.round((vnoise(x, 5, 8, seed ^ 0x72b) - 0.5) * 3);
      put(buf, x, top - 1, ROCK[0]);
      put(buf, x, top - 2, ROCK[1]);
      for (let y = top; y < bot; y++) {
        const e = (y - top) / (bot - top);
        let t = 0.72 - e * 0.45 + (fbmChunky(x, y, seed ^ 0x3b) - 0.5) * 0.3;
        if (y === top) t += 0.2;
        if (y >= bot - 2) t -= 0.25;
        let c = rampPickFlat(ROCK, t);
        // Ice crust sagging along the underside half of the rib.
        const crust = vnoise(x, y, 8, seed ^ 0x1c) + e * 0.35;
        if (crust > 0.78) c = rampPickFlat(ICE, 0.35 + (crust - 0.78) * 1.4 + (y === bot - 1 ? -0.15 : 0));
        if (crust > 0.78 && crust < 0.82 && h01(x, y, seed ^ 0x4) > 0.5) c = ICE[7];
        put(buf, x, y, c);
      }
      put(buf, x, bot, ROCK[0]);
      put(buf, x, bot + 1, ROCK[1]);
    }
    // Icicles along both lips of the rib, seen tip-on.
    for (let x = rng.int(6); x < SIZE; x += 5 + rng.int(5)) icicleTip(buf, x, RIB_Y + RIB_H + 2 + rng.int(2), rng.chance(0.3) ? 2 : 1);
    for (let x = rng.int(6); x < SIZE; x += 8 + rng.int(8)) icicleTip(buf, x, RIB_Y - 3, 1);
  }

  // The plain ceiling's own clusters, clear of the shared edge rows (the rib variant has no room).
  if (!rib) {
    const clusters = 3 + rng.int(2);
    for (let k = 0; k < clusters; k++) icicleCluster(buf, rng, rng.int(SIZE), 11 + rng.int(43));
  }
  return buf;
}

// ─── Tileset ───────────────────────────────────────────────────────────────────────────────────

/**
 * @param {(name:string) => number} seedOf
 * @returns {import('./index.js').TilesetSurfaces}
 */
function paint(seedOf) {
  // Walls: one course layout and one painting of the seam-straddling edge blocks for every variant;
  // each variant repaints only the cells it owns (see `ownerMask`, `iceMask`).
  const edge = seedOf('edge');
  const blocks = layoutCourses(createRng(edge));
  const owner = ownerMask(blocks);
  const ice = iceMask(blocks);
  const PLAIN = { sheets: 0.55, frost: 0.75, rime: false, icicles: 2 };
  const base = paintRockWall(edge, PLAIN, blocks, edge, owner, true);
  const rock = (/** @type {string} */ name, /** @type {typeof PLAIN} */ o) =>
    blend(base, paintRockWall(seedOf(name), o, blocks, edge, owner, false), owner);
  const iceWall = (/** @type {string} */ name, /** @type {boolean} */ relic) =>
    frameIce(base, paintIceWall(seedOf(name), relic, blocks, ice), ice);

  const flags = paintFlagstones(seedOf('floor0'));
  const ceiling = paintCeilingBase(seedOf('ceiling'));
  return {
    wall: [
      rock('wall0', PLAIN),
      iceWall('wall1', false),
      rock('wall2', { sheets: 0.15, frost: 1, rime: true, icicles: 2.5 }),
      iceWall('wall3', true),
    ],
    floor: [flags, paintIcePool(flags, seedOf('floor1')), paintRuneFloor(flags, seedOf('floor2'))],
    ceiling: [paintCeiling(ceiling, seedOf('ceiling0'), false), paintCeiling(ceiling, seedOf('ceiling1'), true)],
  };
}

/** @type {import('./index.js').TilesetDef} */
export const TILESET = Object.freeze({
  id: 'glacier',
  name: 'Frozen Depths',
  fog: 'glaFog',
  paint,
});

