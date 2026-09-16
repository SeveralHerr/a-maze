// @ts-check
/**
 * @file Unit tests for the master palette (run: `node src/renderer/palette.test.mjs`).
 *
 * The palette is load-bearing in a way that is easy to miss: the raycaster indexes its colormap
 * with `(level << 8) | paletteIndex`, so the table must stay within 256 entries, index 0 must stay
 * the transparency key, and every ramp must be monotonic or the textures' ordered dithering would
 * produce visible reversals instead of smooth gradients.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  C,
  LITTLE_ENDIAN,
  PALETTE,
  PALETTE_NAMES,
  PALETTE_RGB,
  PALETTE_SIZE,
  RAMPS,
  TRANSPARENT,
  hex,
  isPaletteColor,
  nearestIndex,
  pack,
  rgba,
} from './palette.js';

/**
 * Unpack a packed word back to RGBA, honouring the host's byte order.
 * @param {number} c
 * @returns {{r:number, g:number, b:number, a:number}}
 */
function unpack(c) {
  const v = c >>> 0;
  return LITTLE_ENDIAN
    ? { r: v & 255, g: (v >>> 8) & 255, b: (v >>> 16) & 255, a: (v >>> 24) & 255 }
    : { r: (v >>> 24) & 255, g: (v >>> 16) & 255, b: (v >>> 8) & 255, a: v & 255 };
}

test('palette fits the colormap addressing scheme', () => {
  assert.ok(PALETTE_SIZE > 32, 'palette should be rich enough for the art');
  assert.ok(PALETTE_SIZE <= 256, 'palette must fit in one colormap row (level << 8 | index)');
  assert.equal(PALETTE.length, PALETTE_SIZE);
  assert.equal(PALETTE_RGB.length, PALETTE_SIZE * 3);
  assert.equal(PALETTE_NAMES.length, PALETTE_SIZE);
});

test('index 0 is the transparency key and nothing else is transparent', () => {
  assert.equal(TRANSPARENT, 0);
  assert.equal(unpack(PALETTE[0]).a, 0);
  for (let i = 1; i < PALETTE_SIZE; i++) {
    assert.equal(unpack(PALETTE[i]).a, 255, `palette[${i}] (${PALETTE_NAMES[i]}) must be opaque`);
  }
});

test('packed words agree with the RGB table', () => {
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const { r, g, b } = unpack(PALETTE[i]);
    assert.equal(r, PALETTE_RGB[i * 3], `r mismatch at ${PALETTE_NAMES[i]}`);
    assert.equal(g, PALETTE_RGB[i * 3 + 1], `g mismatch at ${PALETTE_NAMES[i]}`);
    assert.equal(b, PALETTE_RGB[i * 3 + 2], `b mismatch at ${PALETTE_NAMES[i]}`);
  }
});

test('names are unique and C maps each to its index', () => {
  const seen = new Set();
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const name = PALETTE_NAMES[i];
    assert.ok(!seen.has(name), `duplicate palette name "${name}"`);
    seen.add(name);
    assert.equal(C[name], i, `C.${name} should be ${i}`);
  }
  assert.equal(Object.isFrozen(C), true, 'C must be frozen so typos read as undefined');
  assert.equal(C.nonexistentColour, undefined);
});

test('every ramp is ordered dark → light', () => {
  for (const [name, ramp] of Object.entries(RAMPS)) {
    assert.ok(ramp.length >= 4, `${name} ramp needs enough steps to dither between`);
    let prev = -1;
    for (let i = 0; i < ramp.length; i++) {
      const idx = ramp[i];
      assert.ok(idx > 0 && idx < PALETTE_SIZE, `${name}[${i}] out of range`);
      // Rec. 601 luma: the ordering the eye actually perceives.
      const lum =
        0.299 * PALETTE_RGB[idx * 3] +
        0.587 * PALETTE_RGB[idx * 3 + 1] +
        0.114 * PALETTE_RGB[idx * 3 + 2];
      assert.ok(lum > prev, `${name} ramp is not monotonic at step ${i} (${lum} <= ${prev})`);
      prev = lum;
    }
  }
});

test('the map scroll has a parchment ramp and a dark red seal ramp (§4.8)', () => {
  assert.ok(RAMPS.map instanceof Uint8Array && RAMPS.map.length >= 5, 'map ramp: shadow, dark, mid, light, pale');
  assert.ok(RAMPS.seal instanceof Uint8Array && RAMPS.seal.length >= 3, 'seal ramp for ribbon and wax');
  const rgb = (/** @type {number} */ i) => [PALETTE_RGB[i * 3], PALETTE_RGB[i * 3 + 1], PALETTE_RGB[i * 3 + 2]];
  // Parchment is warm and desaturated: red ≥ green ≥ blue, and never as bright as the UI's gold.
  for (const i of RAMPS.map) {
    const [r, g, b] = rgb(i);
    assert.ok(r >= g && g >= b, `${PALETTE_NAMES[i]} is not a warm parchment tone`);
  }
  const top = rgb(RAMPS.map[RAMPS.map.length - 1]);
  const gold = rgb(C.goldPale);
  assert.ok(top[0] + top[1] + top[2] < gold[0] + gold[1] + gold[2], 'the scroll must be dimmer than goldPale');
  // Seal: clearly red, dark.
  for (const i of RAMPS.seal) {
    const [r, g, b] = rgb(i);
    assert.ok(r > g * 2 && r > b * 2 && r < 200, `${PALETTE_NAMES[i]} is not a dark red`);
  }
});

test('isPaletteColor recognises exactly the palette', () => {
  for (let i = 0; i < PALETTE_SIZE; i++) assert.equal(isPaletteColor(PALETTE[i]), true);
  assert.equal(isPaletteColor(pack(1, 2, 3, 255)), false);
  assert.equal(isPaletteColor(pack(255, 0, 255, 255)), false, 'magenta must never be on-palette');
});

test('pack clamps and respects host byte order', () => {
  const c = pack(300, -5, 128, 255);
  const u = unpack(c);
  assert.deepEqual(u, { r: 255, g: 0, b: 128, a: 255 });
  // Default alpha is opaque.
  assert.equal(unpack(pack(10, 20, 30)).a, 255);
});

test('hex and rgba produce valid CSS', () => {
  assert.match(hex(C.stoneBase), /^#[0-9a-f]{6}$/);
  assert.equal(hex(C.white), '#ffffff');
  // Out-of-range indices degrade to fog rather than throwing.
  assert.equal(hex(-1), hex(C.fog));
  assert.equal(hex(PALETTE_SIZE + 99), hex(C.fog));
  assert.match(rgba(C.fog, 0.5), /^rgba\(\d+,\d+,\d+,0\.5\)$/);
  assert.match(rgba(C.fog, 5), /,1\)$/, 'alpha clamps to 1');
  assert.match(rgba(C.fog, -1), /,0\)$/, 'alpha clamps to 0');
});

test('nearestIndex finds exact palette matches and never returns the key', () => {
  for (let i = 1; i < PALETTE_SIZE; i++) {
    const found = nearestIndex(PALETTE_RGB[i * 3], PALETTE_RGB[i * 3 + 1], PALETTE_RGB[i * 3 + 2]);
    // Duplicated colours (fog and the key share one) may map to either slot — compare the value.
    assert.equal(PALETTE_RGB[found * 3], PALETTE_RGB[i * 3]);
    assert.equal(PALETTE_RGB[found * 3 + 1], PALETTE_RGB[i * 3 + 1]);
    assert.equal(PALETTE_RGB[found * 3 + 2], PALETTE_RGB[i * 3 + 2]);
  }
  assert.ok(nearestIndex(0, 0, 0) >= 1, 'index 0 is a key, not a colour');
});
