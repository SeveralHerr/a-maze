// @ts-check
/**
 * @file Unit tests for the procedural texture painter (run: `node src/renderer/textures.test.mjs`).
 *
 * What these guard, and why each one matters:
 * - **Determinism** — the same seed must repaint byte-identically in Node and in the browser, or
 *   a saved seed would not replay the same dungeon.
 * - **Palette purity** — the raycaster shades through an indexed colormap, so a texel that is not
 *   a palette index would render as an arbitrary colour or a transparent hole.
 * - **Seamlessness** — floor and ceiling tiles repeat on both axes and walls repeat horizontally.
 *   A seam shows up in game as a hard line down every tile edge, so it is measured here rather
 *   than left to the eye.
 * - **Alpha discipline** — world surfaces must be fully opaque; sprites must have a transparent
 *   background, or they would be drawn as squares.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PALETTE, PALETTE_RGB, PALETTE_SIZE, isPaletteColor } from './palette.js';
import { SIZE, createTextures } from './textures.js';

const AREA = SIZE * SIZE;

/** Surfaces that tile against their neighbours; sprites are excluded. */
const SURFACE_KEYS = /** @type {const} */ (['wall', 'floor', 'ceiling']);
const SPRITE_KEYS = /** @type {const} */ (['torch', 'portal', 'gem', 'oil', 'sparkle']);
const ALL_KEYS = [...SURFACE_KEYS, ...SPRITE_KEYS];

const set = createTextures(1234);

/**
 * Perceived luminance of a texel, for seam measurement.
 * @param {Uint8Array} indices
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function lum(indices, x, y) {
  const i = indices[(y << 6) | x];
  return (
    0.299 * PALETTE_RGB[i * 3] + 0.587 * PALETTE_RGB[i * 3 + 1] + 0.114 * PALETTE_RGB[i * 3 + 2]
  );
}

/**
 * Mean absolute luminance step between two rows or columns.
 * @param {Uint8Array} indices
 * @param {'x'|'y'} axis 'x' compares two columns, 'y' two rows
 * @param {number} a first line index
 * @param {number} b second line index
 * @returns {number} mean |Δ luminance| along the line
 */
function edgeStep(indices, axis, a, b) {
  let sum = 0;
  for (let k = 0; k < SIZE; k++) {
    sum +=
      axis === 'x'
        ? Math.abs(lum(indices, a, k) - lum(indices, b, k))
        : Math.abs(lum(indices, k, a) - lum(indices, k, b));
  }
  return sum / SIZE;
}

/**
 * Seam step divided by the mean step between interior neighbours. A texture whose wrap is smooth
 * scores ≈ 1; a broken wrap scores several times that.
 *
 * Only valid for textures without structure aligned to the texture edge — see `periodicSeamStep`
 * for the ones that do have it.
 * @param {Uint8Array} indices
 * @param {'x'|'y'} axis
 * @returns {number}
 */
function seamRatio(indices, axis) {
  let interior = 0;
  for (let i = 0; i < SIZE - 1; i++) interior += edgeStep(indices, axis, i, i + 1);
  const interiorMean = interior / (SIZE - 1);
  return interiorMean > 0 ? edgeStep(indices, axis, SIZE - 1, 0) / interiorMean : 0;
}

/**
 * Seamlessness check for a texture with a hard-edged repeating structure whose period divides the
 * texture size — plank joints every 16 rows, grate bars every 16 columns.
 *
 * For those, "seamless" does not mean "smooth across the wrap": the wrap is a joint, exactly like
 * the interior joints. So the right question is whether the wrap looks like *the same kind of
 * edge* the interior ones are, which is what this compares.
 * @param {Uint8Array} indices
 * @param {'x'|'y'} axis
 * @param {number} period structural period in texels (must divide SIZE)
 * @returns {{seam:number, worstInterior:number}}
 */
function periodicSeamStep(indices, axis, period) {
  let worstInterior = 0;
  for (let k = 1; k < SIZE / period; k++) {
    const step = edgeStep(indices, axis, k * period - 1, k * period);
    if (step > worstInterior) worstInterior = step;
  }
  return { seam: edgeStep(indices, axis, SIZE - 1, 0), worstInterior };
}

test('every texture has the documented shape', () => {
  for (const key of ALL_KEYS) {
    const list = set[key];
    assert.ok(Array.isArray(list) && list.length > 0, `${key} must be a non-empty array`);
    for (const [i, tex] of list.entries()) {
      assert.equal(tex.w, SIZE, `${key}[${i}].w`);
      assert.equal(tex.h, SIZE, `${key}[${i}].h`);
      assert.equal(tex.indices.length, AREA, `${key}[${i}].indices length`);
      assert.equal(tex.pixels.length, AREA, `${key}[${i}].pixels length`);
      assert.ok(tex.indices instanceof Uint8Array);
      assert.ok(tex.pixels instanceof Uint32Array);
      assert.ok(tex.stipple === null || tex.stipple.length === AREA);
      assert.equal(typeof tex.emissive, 'boolean');
    }
  }
  assert.ok(set.wall.length >= 3, 'ARCHITECTURE §4.5 requires at least 3 wall variants');
  assert.equal(set.torch.length, 4, 'four flame frames');
  assert.ok(set.portal.length >= 4, 'portal must be animated');
  assert.equal(set.size, SIZE);
  assert.equal(set.seed, 1234);
});

test('texels are palette indices and pixels are the matching packed colours', () => {
  for (const key of ALL_KEYS) {
    for (const [i, tex] of set[key].entries()) {
      for (let p = 0; p < AREA; p++) {
        const idx = tex.indices[p];
        assert.ok(idx < PALETTE_SIZE, `${key}[${i}] texel ${p} index ${idx} out of palette`);
        assert.equal(tex.pixels[p], PALETTE[idx], `${key}[${i}] texel ${p} pixel/index mismatch`);
        assert.equal(isPaletteColor(tex.pixels[p]), true);
      }
    }
  }
});

test('world surfaces are fully opaque; sprites have transparent backgrounds', () => {
  for (const key of SURFACE_KEYS) {
    for (const [i, tex] of set[key].entries()) {
      const holes = tex.indices.reduce((n, v) => n + (v === 0 ? 1 : 0), 0);
      assert.equal(holes, 0, `${key}[${i}] has ${holes} transparent texels — walls cannot show through`);
    }
  }
  for (const key of SPRITE_KEYS) {
    for (const [i, tex] of set[key].entries()) {
      let opaque = 0;
      for (let p = 0; p < AREA; p++) if (tex.indices[p] !== 0) opaque++;
      // The last sparkle frame is deliberately almost gone — it is the tail of a fade.
      assert.ok(opaque > 40, `${key}[${i}] is nearly empty (${opaque} texels)`);
      assert.ok(opaque < AREA * 0.92, `${key}[${i}] has no transparent surround`);
    }
  }
});

test('organic surfaces wrap smoothly', () => {
  // A wall face is exactly one texture tall, so only its horizontal wrap has to match; cobbles
  // repeat on both axes. Neither has structure aligned to the texture edge, so a broken wrap would
  // show up immediately as an outlier step.
  for (const [i, tex] of set.wall.entries()) {
    assert.ok(seamRatio(tex.indices, 'x') < 2.5, `wall[${i}] has a visible vertical seam`);
  }
  for (const i of [0, 1]) {
    assert.ok(seamRatio(set.floor[i].indices, 'x') < 2.5, `floor[${i}] seam in x`);
    assert.ok(seamRatio(set.floor[i].indices, 'y') < 2.5, `floor[${i}] seam in y`);
  }
  // Plank grain runs along x with no vertical structure, so the ceiling's x wrap is organic too.
  for (const [i, tex] of set.ceiling.entries()) {
    assert.ok(seamRatio(tex.indices, 'x') < 2.5, `ceiling[${i}] seam in x`);
  }
});

test('structured surfaces wrap on their period', () => {
  // Planks are 16 rows tall and grate bars 16 columns apart; 16 divides 64, so the wrap lands on a
  // joint exactly like the interior ones. The assertion is that the wrap *is* one of those joints:
  // comfortably above a mid-plank difference and no worse than the loudest interior joint. (Plank
  // tone is randomised per plank, so the joints legitimately differ in strength by up to ~2×.)
  /** Minimum luminance step that counts as a joint rather than as mid-plank grain. */
  const JOINT_MIN = 12;

  /**
   * @param {string} label
   * @param {Uint8Array} indices
   * @param {'x'|'y'} axis
   * @returns {void}
   */
  const assertPeriodicWrap = (label, indices, axis) => {
    const { seam, worstInterior } = periodicSeamStep(indices, axis, 16);
    assert.ok(
      seam <= worstInterior * 2,
      `${label}: wrap joint (${seam.toFixed(1)}) is harsher than every interior joint (${worstInterior.toFixed(1)})`,
    );
    assert.ok(
      seam >= JOINT_MIN,
      `${label}: wrap (${seam.toFixed(1)}) is not a joint at all — the structure does not line up`,
    );
  };

  for (const [i, tex] of set.ceiling.entries()) assertPeriodicWrap(`ceiling[${i}]`, tex.indices, 'y');
  assertPeriodicWrap('grate x', set.floor[2].indices, 'x');
  assertPeriodicWrap('grate y', set.floor[2].indices, 'y');

  // The detector has to have teeth: shifting a texture off its period must fail the same check.
  const rolled = new Uint8Array(AREA);
  const SHIFT = 3;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) rolled[(y << 6) | x] = set.ceiling[0].indices[(((y + SHIFT) & 63) << 6) | x];
  }
  assert.ok(
    periodicSeamStep(rolled, 'y', 16).seam < JOINT_MIN,
    'control: a texture shifted off its period must fail the same check',
  );
});

test('the grate lattice has a period that divides the texture, so it tiles exactly', () => {
  const grate = set.floor[2].indices;
  // A column is "on a bar" when most of it is dark iron rather than the void behind it.
  /** @param {number} x @returns {boolean} */
  const isBarColumn = (x) => {
    let iron = 0;
    for (let y = 0; y < SIZE; y++) {
      const l = lum(grate, x, y);
      if (l > 14) iron++; // the void is near-black; every iron shade is brighter
    }
    return iron > SIZE * 0.6;
  };
  for (let x = 0; x < SIZE; x++) {
    assert.equal(
      isBarColumn(x),
      isBarColumn((x + 16) % SIZE),
      `grate column ${x} does not repeat at period 16 — it would not tile`,
    );
  }
  assert.equal(isBarColumn(0), true, 'a bar should start at the texture origin');
  assert.equal(isBarColumn(10), false, 'there should be a gap between bars');
});

test('painting is deterministic for a seed and different across seeds', () => {
  const a = createTextures(99);
  const b = createTextures(99);
  for (const key of ALL_KEYS) {
    for (let i = 0; i < a[key].length; i++) {
      assert.deepEqual(a[key][i].indices, b[key][i].indices, `${key}[${i}] is not deterministic`);
      assert.deepEqual(a[key][i].pixels, b[key][i].pixels, `${key}[${i}] pixels differ`);
    }
  }
  const c = createTextures(100);
  assert.notDeepEqual(a.wall[0].indices, c.wall[0].indices, 'different seeds must paint differently');
});

test('a non-finite seed falls back to the shipping look instead of throwing', () => {
  const nan = createTextures(Number.NaN);
  const dflt = createTextures();
  assert.deepEqual(nan.wall[0].indices, dflt.wall[0].indices);
});

test('animation frames actually differ from each other', () => {
  for (const key of /** @type {const} */ (['torch', 'portal', 'gem', 'oil', 'sparkle'])) {
    const frames = set[key];
    for (let i = 1; i < frames.length; i++) {
      assert.notDeepEqual(
        frames[i].indices,
        frames[i - 1].indices,
        `${key} frames ${i - 1} and ${i} are identical — the animation would stall`,
      );
    }
  }
});

test('emissive art is flagged, and only glow art carries a stipple mask', () => {
  for (const t of set.torch) assert.equal(t.emissive, true);
  for (const t of set.portal) assert.equal(t.emissive, true);
  for (const t of set.wall) assert.equal(t.emissive, false);
  // The flame and the portal both have a stippled halo; the gem does not.
  assert.ok(set.torch.some((t) => t.stipple !== null), 'flame halo should be stippled');
  assert.ok(set.portal.every((t) => t.stipple !== null), 'portal glow should be stippled');
  assert.ok(set.gem.every((t) => t.stipple === null), 'gems are solid');
  // A stippled texel must be a drawn texel, or the mask would do nothing.
  for (const t of set.portal) {
    const st = /** @type {Uint8Array} */ (t.stipple);
    for (let p = 0; p < AREA; p++) {
      if (st[p] === 1) assert.notEqual(t.indices[p], 0, `stipple on a transparent texel at ${p}`);
    }
  }
});

test('walls use the whole stone ramp (blocks, mortar and bevels are all present)', () => {
  // A wall that came out flat would still pass every structural test above, so assert the tonal
  // spread the art direction calls for: dark mortar, mid faces and light bevels.
  const hist = new Set(set.wall[0].indices);
  assert.ok(hist.size >= 8, `wall[0] uses only ${hist.size} colours — too flat for stonework`);
  let dark = 0;
  let light = 0;
  for (const idx of set.wall[0].indices) {
    const l = 0.299 * PALETTE_RGB[idx * 3] + 0.587 * PALETTE_RGB[idx * 3 + 1] + 0.114 * PALETTE_RGB[idx * 3 + 2];
    if (l < 45) dark++;
    else if (l > 120) light++;
  }
  assert.ok(dark > AREA * 0.05, 'no mortar grooves');
  assert.ok(light > AREA * 0.05, 'no lit block faces');
});
