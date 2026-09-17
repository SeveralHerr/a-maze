// @ts-check
// Tileset registry: every floor's surfaces obey the texture invariants the raycaster relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, PALETTE_NAMES, PALETTE_RGB, PALETTE_SIZE, TILESET_PALETTE_MAX } from './palette.js';
import { SIZE } from './textures.js';
import { TILESETS, createTilesetTextures, tilesetIndexById, tilesetIndexForLevel } from './tilesets/index.js';

const SHAPE = { wall: 4, floor: 3, ceiling: 2 };

test('floors walk through the tilesets in order and wrap', () => {
  assert.equal(tilesetIndexForLevel(1), 0);
  for (let l = 1; l <= TILESETS.length * 2 + 1; l++) assert.equal(tilesetIndexForLevel(l), (l - 1) % TILESETS.length);
  assert.equal(tilesetIndexForLevel(3, 2), 1, 'two floors per tileset');
  assert.equal(tilesetIndexForLevel(NaN), 0);
  assert.equal(tilesetIndexById('forge'), TILESETS.findIndex((t) => t.id === 'forge'));
  assert.equal(tilesetIndexById('nope'), -1);
});

test('palette stays inside 256 and each tileset block inside its budget', () => {
  assert.ok(PALETTE_SIZE <= 256, `palette has ${PALETTE_SIZE}`);
  for (const t of TILESETS) {
    if (t.id === 'keep') continue;
    const prefix = t.fog.slice(0, 3);
    const own = PALETTE_NAMES.filter((n) => n.startsWith(prefix) && n[3] === n[3].toUpperCase());
    assert.ok(own.length <= TILESET_PALETTE_MAX, `${t.id} uses ${own.length}`);
    assert.ok(C[t.fog] !== undefined, `${t.id} fog colour ${t.fog} is in the palette`);
  }
});

for (const [i, def] of TILESETS.entries()) {
  test(`tileset ${def.id}: surfaces have the documented shape, are opaque and deterministic`, () => {
    const a = createTilesetTextures(i, 1234);
    const b = createTilesetTextures(i, 1234);
    assert.equal(a.tileset, def.id);
    assert.equal(a.fog, C[def.fog]);
    for (const [key, n] of Object.entries(SHAPE)) {
      assert.equal(a[key].length, n, `${def.id}.${key} count`);
      for (let v = 0; v < n; v++) {
        const tex = a[key][v];
        assert.equal(tex.indices.length, SIZE * SIZE);
        for (let k = 0; k < tex.indices.length; k++) {
          const ix = tex.indices[k];
          if (ix === 0 || ix >= PALETTE_SIZE) assert.fail(`${def.id}.${key}[${v}] texel ${k} is ${ix}`);
        }
        assert.deepEqual(tex.indices, b[key][v].indices, `${def.id}.${key}[${v}] is deterministic`);
      }
    }
    // Variants must actually differ, or the per-tile hashing buys nothing.
    for (const key of Object.keys(SHAPE)) {
      for (let v = 1; v < a[key].length; v++) {
        assert.notDeepEqual(a[key][v].indices, a[key][0].indices, `${def.id}.${key}[${v}] differs from [0]`);
      }
    }
  });
}

// ─── Seams ─────────────────────────────────────────────────────────────────────────────────────
//
// The raycaster ties texels to world position — no per-tile offset, mirror or flip — and picks a
// variant per tile by hash, so any two variants of a surface end up side by side. Two things make
// that seamless, and both are measured on every tileset:
//   1. each texture wraps onto itself (its last line flows into its first), and
//   2. the variants AGREE along their edges: the outer `EDGE_BAND` lines on each side are (nearly)
//      the same texels in every variant, so variant a's last line meets variant b's first exactly as
//      it would meet its own. Surface detail (moss, cracks, relics) may differ a little there.
// Walls only meet horizontally. Floors meet on both axes, the special tile included — a grate or
// a rune is set INTO the floor around it. Ceilings meet the other variant only along y: the band
// variant is chosen per row of tiles across a corridor, so its x neighbours always wear it too.

/** Lines on each side of a tile edge that every variant must share. */
const EDGE_BAND = 2;
/** Mean |Δ luminance| allowed between two variants' edge bands (0–255 scale). */
const BAND_TOLERANCE = 6;
/**
 * A texture's own wrap step may be at most this multiple of its 90th-percentile interior step — or
 * that multiple of its loudest interior step, when the wrap lands on a structural joint (a plank seam
 * whose two planks happen to be the most contrasting pair).
 */
const WRAP_TOLERANCE = 1.5;

/** @param {Uint8Array} ix @param {number} x @param {number} y @returns {number} */
function lum(ix, x, y) {
  const i = ix[((y & 63) << 6) | (x & 63)] * 3;
  return 0.299 * PALETTE_RGB[i] + 0.587 * PALETTE_RGB[i + 1] + 0.114 * PALETTE_RGB[i + 2];
}

/**
 * Mean |Δ luminance| between line `ka` of A and line `kb` of B. Axis 'x' compares columns.
 * @param {Uint8Array} a @param {Uint8Array} b @param {'x'|'y'} axis @param {number} ka @param {number} kb
 */
function lineStep(a, b, axis, ka, kb) {
  let sum = 0;
  for (let t = 0; t < SIZE; t++) sum += Math.abs(axis === 'x' ? lum(a, ka, t) - lum(b, kb, t) : lum(a, t, ka) - lum(b, t, kb));
  return sum / SIZE;
}

/** Mean edge-band difference between two variants. @param {Uint8Array} a @param {Uint8Array} b @param {'x'|'y'} axis */
function bandDiff(a, b, axis) {
  let sum = 0;
  for (let k = 0; k < EDGE_BAND; k++) sum += lineStep(a, b, axis, k, k) + lineStep(a, b, axis, SIZE - 1 - k, SIZE - 1 - k);
  return sum / (2 * EDGE_BAND);
}

/**
 * Own wrap step over what the interior allows (see `WRAP_TOLERANCE`); ≤ 1 passes.
 * @param {Uint8Array} a @param {'x'|'y'} axis
 */
function wrapRatio(a, axis) {
  const steps = [];
  for (let k = 0; k < SIZE - 1; k++) steps.push(lineStep(a, a, axis, k, k + 1));
  steps.sort((p, q) => p - q);
  const allowed = Math.max(1, steps[Math.floor(steps.length * 0.9)] * WRAP_TOLERANCE, steps[steps.length - 1] * WRAP_TOLERANCE);
  return lineStep(a, a, axis, SIZE - 1, 0) / allowed;
}

/** Which variants must agree on which axes. */
const SEAM_RULES = /** @type {const} */ ([
  { key: 'wall', axes: ['x'], wrapAxes: ['x'] },
  { key: 'floor', axes: ['x', 'y'], wrapAxes: ['x', 'y'] },
  { key: 'ceiling', axes: ['y'], wrapAxes: ['x', 'y'] },
]);

for (const [i, def] of TILESETS.entries()) {
  test(`tileset ${def.id}: every variant meets every other seamlessly`, () => {
    const set = createTilesetTextures(i, 1234);
    const problems = [];
    for (const rule of SEAM_RULES) {
      const list = set[rule.key];
      for (let a = 0; a < list.length; a++) {
        for (const axis of rule.wrapAxes) {
          const r = wrapRatio(list[a].indices, axis);
          if (r > 1) problems.push(`${rule.key}[${a}] wraps badly in ${axis} (${r.toFixed(2)}× the allowance)`);
        }
        for (let b = a + 1; b < list.length; b++) {
          for (const axis of rule.axes) {
            const d = bandDiff(list[a].indices, list[b].indices, axis);
            if (d > BAND_TOLERANCE) problems.push(`${rule.key}[${a}]/[${b}] edges disagree in ${axis} (${d.toFixed(1)})`);
          }
        }
      }
    }
    assert.deepEqual(problems, []);
  });
}

test('the seam detector has teeth: unrelated paintings and a shifted copy both fail', () => {
  const keep = createTilesetTextures(0, 1234);
  const forge = createTilesetTextures(tilesetIndexById('forge'), 1234);
  assert.ok(bandDiff(keep.wall[0].indices, forge.wall[0].indices, 'x') > BAND_TOLERANCE * 2);
  const src = keep.floor[0].indices;
  const shifted = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) shifted[(y << 6) | x] = src[(y << 6) | ((x + 13) & 63)];
  assert.ok(bandDiff(src, shifted, 'x') > BAND_TOLERANCE, 'a copy slid 13 texels no longer shares its edges');
});
