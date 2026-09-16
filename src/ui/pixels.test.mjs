// @ts-check
/**
 * @file Unit tests for src/ui/pixels.js — the indexed-sprite blitter, the panel geometry and the
 * pixel-exact outline helper the HUD's tank alarm draws with.
 * Run: `node src/ui/pixels.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARROWS,
  ICON_SIZE,
  compileArt,
  drawArt,
  drawPanel,
  drawPortalIcon,
  hexToRgb,
  strokeRect,
  withAlpha,
} from './pixels.js';

/**
 * A context that records every fill as `[x, y, w, h, style]`.
 * @returns {any}
 */
function rec() {
  /** @type {Array<[number, number, number, number, string]>} */
  const rects = [];
  return {
    rects,
    fillStyle: '#000',
    fillRect(x, y, w, h) {
      rects.push([x, y, w, h, this.fillStyle]);
    },
  };
}

test('drawArt merges horizontal runs into one fill each', () => {
  const art = compileArt(['1111', '1221'], 'run');
  const ctx = rec();
  drawArt(ctx, art, 0, 0, 1, [null, '#a', '#b']);
  // Row 0 is one run; row 1 is three (1 | 22 | 1). Four fills, not eight pixels.
  assert.equal(ctx.rects.length, 4);
  assert.deepEqual(ctx.rects[0], [0, 0, 4, 1, '#a']);
  assert.deepEqual(ctx.rects[2], [1, 1, 2, 1, '#b']);
});

test('drawArt honours the integer scale and the transparent index', () => {
  const art = compileArt(['010'], 'dot');
  const ctx = rec();
  drawArt(ctx, art, 10, 20, 3, [null, '#c']);
  assert.equal(ctx.rects.length, 1, 'index 0 draws nothing');
  assert.deepEqual(ctx.rects[0], [13, 20, 3, 3, '#c']);
  // A sub-1 scale is clamped rather than producing a zero-size fill.
  ctx.rects.length = 0;
  drawArt(ctx, art, 0, 0, 0, [null, '#c']);
  assert.equal(ctx.rects[0][2], 1);
});

test('drawArt skips indices with no colour instead of throwing', () => {
  const art = compileArt(['123'], 'gap');
  const ctx = rec();
  assert.doesNotThrow(() => drawArt(ctx, art, 0, 0, 1, [null, '#a']));
  assert.equal(ctx.rects.length, 1, 'only the index that has a colour is drawn');
});

test('strokeRect is a pixel-exact outline, never a stroked path', () => {
  const ctx = rec();
  strokeRect(ctx, 5, 5, 20, 10, 2);
  assert.equal(ctx.rects.length, 4, 'four sides');
  assert.deepEqual(ctx.rects[0], [5, 5, 20, 2, '#000'], 'top');
  assert.deepEqual(ctx.rects[1], [5, 13, 20, 2, '#000'], 'bottom');
  assert.deepEqual(ctx.rects[2], [5, 7, 2, 6, '#000'], 'left, between the caps');
  assert.deepEqual(ctx.rects[3], [23, 7, 2, 6, '#000'], 'right');
  // Every coordinate is an integer, at any input.
  ctx.rects.length = 0;
  strokeRect(ctx, 5.4, 5.6, 20.2, 10.7, 0);
  for (const r of ctx.rects) for (let i = 0; i < 4; i++) assert.equal(Number.isInteger(r[i]), true);
});

test('drawPanel draws inside its box at any size', () => {
  const ctx = rec();
  drawPanel(ctx, 10, 10, 60, 40, 2, { frame: 'stone' });
  assert.ok(ctx.rects.length > 6, 'ground, frame, bevel, interior');
  for (const [x, y, w, h] of ctx.rects) {
    assert.ok(x >= 10 && y >= 10, `fill at ${x},${y} escaped the panel`);
    assert.ok(x + w <= 70 + 1 && y + h <= 50 + 1, `fill ${x},${y},${w},${h} overflowed`);
  }
  // A degenerate panel is clamped, not negative.
  ctx.rects.length = 0;
  assert.doesNotThrow(() => drawPanel(ctx, 0, 0, 1, 1, 4));
});

test('the arrow table covers all eight headings and stays square', () => {
  assert.equal(ARROWS.length, 8);
  for (const a of ARROWS) {
    assert.equal(a.w, ICON_SIZE.arrow);
    assert.equal(a.h, ICON_SIZE.arrow);
    assert.ok(a.data.some((v) => v !== 0), 'a heading with no pixels would be an invisible player');
  }
});

test('the portal glyph exists for the map legend', () => {
  const ctx = rec();
  drawPortalIcon(ctx, 0, 0, 2);
  assert.ok(ctx.rects.length > 4);
  assert.equal(ICON_SIZE.portal >= 5, true);
});

test('hexToRgb splits the channels the raster needs', () => {
  const out = new Uint8Array(3);
  hexToRgb('#22d3ee', out);
  assert.deepEqual(Array.from(out), [0x22, 0xd3, 0xee]);
  hexToRgb('#zzzzzz', out);
  assert.deepEqual(Array.from(out), [0, 0, 0], 'garbage degrades to black, never to NaN');
});

test('withAlpha still memoises after the move', () => {
  assert.equal(withAlpha('#ff8800', 1), '#ff8800');
  assert.equal(withAlpha('#ff8800', 0.25), 'rgba(255,136,0,0.25)');
  assert.equal(withAlpha('#ff8800', 0.25), withAlpha('#ff8800', 0.25));
});
