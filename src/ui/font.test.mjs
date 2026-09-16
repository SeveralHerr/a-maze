// @ts-check
/**
 * @file Unit tests for src/ui/font.js — glyph coverage, measurement, wrapping and the drawing
 * path's graceful failure in a DOM-less environment.
 * Run: `node src/ui/font.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLOR,
  FONT_STYLES,
  catchesLight,
  clearFontCache,
  drawText,
  drawTextBlock,
  faceInfo,
  fontMetrics,
  glyphMask,
  hasGlyph,
  measureLine,
  measureText,
  wrapText,
} from './font.js';

/** Every printable ASCII character, in order. */
const ASCII = (() => {
  let s = '';
  for (let c = 0x20; c <= 0x7e; c++) s += String.fromCharCode(c);
  return s;
})();

test('both faces cover all printable ASCII plus the punctuation the UI uses', () => {
  for (const font of /** @type {const} */ (['hud', 'display'])) {
    for (const ch of ASCII) {
      assert.ok(hasGlyph(font, ch), `${font} is missing ${JSON.stringify(ch)}`);
    }
    for (const ch of ['©', '×', '…', '·']) {
      assert.ok(hasGlyph(font, ch), `${font} is missing ${JSON.stringify(ch)}`);
    }
    assert.equal(hasGlyph(font, '中'), false, 'unmapped code points report honestly');
    assert.equal(hasGlyph(font, ''), false);
  }
});

test('face metrics are the documented shape', () => {
  const hud = faceInfo('hud');
  assert.equal(hud.height, 8, '7 rows above the baseline plus one descender row');
  assert.equal(hud.ascent, 7);
  assert.equal(hud.descent, 1);
  assert.equal(hud.maxWidth, 5, 'the HUD face is 5 columns wide');
  assert.equal(hud.monospace, true);
  assert.ok(hud.glyphCount >= 95);

  const display = faceInfo('display');
  assert.equal(display.height, 12);
  assert.equal(display.ascent, 10);
  assert.equal(display.descent, 2);
  assert.equal(display.monospace, false);
  assert.ok(display.glyphCount >= 95);
});

test('every glyph mask is rectangular, non-empty and inside the face height', () => {
  for (const font of /** @type {const} */ (['hud', 'display'])) {
    const h = faceInfo(font).height;
    let inked = 0;
    for (const ch of ASCII) {
      const g = glyphMask(font, ch);
      assert.ok(g !== null, `${font} ${ch}`);
      assert.equal(g.h, h, `${font} ${ch} height`);
      assert.equal(g.mask.length, g.w * g.h, `${font} ${ch} mask size`);
      assert.ok(g.w >= 1 && g.w <= 12, `${font} ${ch} width ${g.w}`);
      let ink = 0;
      for (let i = 0; i < g.mask.length; i++) ink += g.mask[i];
      if (ch !== ' ') {
        assert.ok(ink > 0, `${font} ${JSON.stringify(ch)} has no ink`);
        inked++;
      } else {
        assert.equal(ink, 0, 'space must be blank');
      }
    }
    assert.ok(inked >= 93);
  }
});

test('the HUD face is monospace: every line width is a multiple of the advance', () => {
  const one = measureLine('M', { font: 'hud' });
  const two = measureLine('MM', { font: 'hud' });
  const advance = two - one;
  assert.equal(one, 5, 'a glyph is 5 columns of ink');
  assert.equal(advance, 6, '5 columns plus one of spacing');
  assert.equal(measureLine('0123456789', { font: 'hud' }), 10 * advance - 1);
  // Digits must all advance identically or a rolling counter jitters.
  for (const d of '0123456789') {
    assert.equal(measureLine(d, { font: 'hud' }), one, `digit ${d}`);
  }
});

test('measureLine scales, ignores nothing and never returns a negative', () => {
  assert.equal(measureLine('', { font: 'hud' }), 0);
  assert.equal(measureLine('AB', { font: 'hud', size: 3 }), measureLine('AB', { font: 'hud' }) * 3);
  assert.equal(measureLine('AB', { font: 'hud', scale: 3 }), measureLine('AB', { font: 'hud', size: 3 }));
  assert.ok(measureLine('   ', { font: 'hud' }) > 0, 'spaces take room');
  // An unknown glyph falls back to a space advance rather than vanishing.
  assert.ok(measureLine('中', { font: 'hud' }) > 0);
  // Tracking widens the line by one per gap.
  const plain = measureLine('ABCD', { font: 'hud' });
  assert.equal(measureLine('ABCD', { font: 'hud', tracking: 2 }), plain + 2 * 3);
});

test('display face is proportional: an M is wider than an i', () => {
  const m = measureLine('M', { font: 'display' });
  const i = measureLine('i', { font: 'display' });
  assert.ok(m > i, `${m} > ${i}`);
  // …but digits are uniform, so tallies do not dance.
  const widths = new Set();
  for (const d of '0123456789') widths.add(measureLine(d, { font: 'display' }));
  assert.equal(widths.size, 1, 'display digits must share one width');
});

test('measureText handles newlines and reports line counts', () => {
  const one = measureText('AAA', { font: 'hud', size: 2 });
  assert.equal(one.lines, 1);
  assert.equal(one.height, 8 * 2);
  assert.equal(one.width, measureLine('AAA', { font: 'hud', size: 2 }));

  const two = measureText('AAA\nBBBBB', { font: 'hud', size: 2 });
  assert.equal(two.lines, 2);
  assert.equal(two.width, measureLine('BBBBB', { font: 'hud', size: 2 }), 'widest line wins');
  assert.equal(two.height, (8 + 8 + 1) * 2, 'height adds one line pitch');

  const empty = measureText('', { font: 'hud' });
  assert.equal(empty.lines, 1);
  assert.equal(empty.width, 0);
});

test('fontMetrics reports the scaled box', () => {
  const m = fontMetrics({ font: 'display', size: 3 });
  assert.equal(m.height, 36);
  assert.equal(m.ascent, 30);
  assert.equal(m.descent, 6);
  assert.equal(m.lineHeight, (12 + 3) * 3);
  assert.equal(m.scale, 3);
  assert.equal(fontMetrics({ font: 'hud', size: 0 }).scale, 1, 'sub-pixel scales are not allowed');
  assert.equal(fontMetrics({ font: 'hud', size: -4 }).scale, 1);
  assert.equal(fontMetrics().height, 8, 'defaults to the HUD face at scale 1');
});

test('wrapText fits every line inside the limit', () => {
  const opts = { font: /** @type {const} */ ('hud'), size: 1 };
  const text = 'Engine, maze generator, bitmap fonts and every sound: hand-rolled.';
  for (const limit of [40, 60, 120, 300]) {
    const lines = wrapText(text, limit, opts);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(
        measureLine(line, opts) <= limit,
        `"${line}" is ${measureLine(line, opts)} wide, limit ${limit}`,
      );
      assert.ok(!line.startsWith(' ') && !line.endsWith(' '), 'no dangling spaces');
    }
    // Characters are preserved exactly; only the whitespace moves (a mid-word break at a tight
    // limit turns into a line boundary rather than a space).
    assert.equal(
      lines.join(' ').replace(/\s+/g, ''),
      text.replace(/\s+/g, ''),
      'no characters lost or duplicated',
    );
    if (limit >= 120) {
      assert.equal(lines.join(' '), text, 'no mid-word breaks when the words all fit');
    }
  }
});

test('wrapText honours hard newlines and breaks over-long words', () => {
  const opts = { font: /** @type {const} */ ('hud'), size: 1 };
  assert.deepEqual(wrapText('a\nb', 1000, opts), ['a', 'b']);
  const long = wrapText('ABCDEFGHIJKLMNOP', 30, opts);
  assert.ok(long.length > 1, 'a word longer than the line is split, not overflowed');
  for (const line of long) assert.ok(measureLine(line, opts) <= 30);
  assert.equal(long.join(''), 'ABCDEFGHIJKLMNOP');
  assert.deepEqual(wrapText('', 100, opts), ['']);
  assert.deepEqual(wrapText('hello', 0, opts), ['hello'], 'a zero limit means no wrapping');
});

test('drawText degrades gracefully with no canvas and no context', () => {
  // Node has neither OffscreenCanvas nor document, so the atlas cannot be built: the call must
  // still return a sane width and must not throw.
  const fakeCtx = /** @type {any} */ ({
    globalAlpha: 1,
    drawImage() {
      throw new Error('should not be reached without an atlas');
    },
  });
  assert.equal(drawText(fakeCtx, 'HELLO', 0, 0, { font: 'hud' }), 0);
  assert.equal(drawText(/** @type {any} */ (null), 'HELLO', 0, 0), 0);
  assert.equal(drawText(fakeCtx, '', 0, 0), 0);
  assert.doesNotThrow(() => drawTextBlock(fakeCtx, 'A\nB', 0, 0, { font: 'display' }));
  assert.doesNotThrow(() => clearFontCache());
});

test('the middle dot is a dot, not a dash', () => {
  // The HUD separator used to be a 3×2 block, as wide as the hyphen, so "DEPTH 2 · 24×24" read as
  // "DEPTH 2 - 24×24" everywhere it appeared.
  for (const font of /** @type {const} */ (['hud', 'display'])) {
    const dot = /** @type {{w:number, h:number, mask:Uint8Array}} */ (glyphMask(font, '·'));
    let minX = Infinity;
    let maxX = -1;
    let minY = Infinity;
    let maxY = -1;
    for (let y = 0; y < dot.h; y++) {
      for (let x = 0; x < dot.w; x++) {
        if (dot.mask[y * dot.w + x] === 0) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    assert.ok(maxX >= 0, `${font}: the dot has ink`);
    assert.ok(maxX - minX + 1 <= 2, `${font}: ink is ${maxX - minX + 1} columns wide`);
    assert.ok(maxY - minY + 1 <= 2, `${font}: ink is ${maxY - minY + 1} rows tall`);
    const face = faceInfo(font);
    assert.ok(minY > 0 && maxY < face.ascent - 1, `${font}: the dot floats at mid height (rows ${minY}–${maxY})`);
    // Narrower than the hyphen it used to be mistaken for.
    const dash = /** @type {{w:number, h:number, mask:Uint8Array}} */ (glyphMask(font, '-'));
    let dashInk = 0;
    for (let x = 0; x < dash.w; x++) for (let y = 0; y < dash.h; y++) dashInk = Math.max(dashInk, dash.mask[y * dash.w + x] ? x + 1 : 0);
    assert.ok(maxX - minX + 1 < dashInk, `${font}: dot narrower than the hyphen`);
  }
});

test('the atlas cache stays bounded however many raw colours are drawn', async () => {
  // Build real atlases: give Node a document that can make canvases.
  const g = /** @type {any} */ (globalThis);
  const noop = () => {};
  g.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (/** @type {number} */ w, /** @type {number} */ h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: noop,
      }),
    }),
  };
  try {
    const { fontCacheSize } = await import('./font.js');
    clearFontCache();
    const ctx = /** @type {any} */ ({ globalAlpha: 1, drawImage: noop });
    for (let i = 0; i < 40; i++) {
      const hex = `#${(i * 37).toString(16).padStart(2, '0')}40${(255 - i).toString(16).padStart(2, '0')}`;
      drawText(ctx, 'A', 0, 0, { font: i % 2 === 0 ? 'hud' : 'display', color: hex });
      assert.ok(fontCacheSize() <= 16, `after ${i + 1} colours the cache holds ${fontCacheSize()} atlases`);
    }
    // Named styles in steady use survive the churn of one-off colours.
    drawText(ctx, 'A', 0, 0, { font: 'hud', color: 'hud' });
    const before = fontCacheSize();
    for (let i = 0; i < 20; i++) drawText(ctx, 'A', 0, 0, { font: 'hud', color: `#0000${(i + 16).toString(16)}` });
    assert.ok(fontCacheSize() <= 16);
    assert.ok(before <= 16);
  } finally {
    delete g.document;
    clearFontCache();
  }
});

test('styles and colours are complete and well-formed', () => {
  for (const name of Object.keys(FONT_STYLES)) {
    const style = FONT_STYLES[name];
    assert.match(style.fill, /^#[0-9a-f]{6}$/i, `${name} fill`);
    for (const key of /** @type {const} */ (['outline', 'highlight', 'shadow'])) {
      const v = style[key];
      if (v !== null) assert.match(v, /^#[0-9a-f]{6}$/i, `${name} ${key}`);
    }
    assert.ok(Number.isFinite(style.shadowX) && Number.isFinite(style.shadowY));
  }
  for (const name of Object.keys(COLOR)) {
    assert.match(COLOR[name], /^#[0-9a-f]{6}$/i, `COLOR.${name}`);
  }
  // The art direction for the display face (ARCHITECTURE.md §4.6).
  assert.equal(COLOR.gold, '#d9a441');
  assert.equal(COLOR.goldDeep, '#7a4a1a');
  assert.equal(COLOR.parchment, '#e8d3a0');
});

test('the display face catches light on stroke tops only, so gold dominates the wordmark', () => {
  /**
   * Share of inked cells drawn in the highlight tone.
   * @param {string} text
   * @returns {number}
   */
  const share = (text) => {
    let lit = 0;
    let ink = 0;
    for (const ch of text) {
      const g = glyphMask('display', ch);
      if (g === null) continue;
      for (let y = 0; y < g.h; y++) {
        for (let x = 0; x < g.w; x++) {
          if (g.mask[y * g.w + x] === 0) continue;
          ink++;
          if (catchesLight(g, x, y)) lit++;
        }
      }
    }
    return ink === 0 ? 0 : lit / ink;
  };
  // docs/art-reference.png: gold letters under a thin top rim. The first rule lit ~60 % of the
  // wordmark, which read as parchment blocks outlined in brown.
  assert.ok(share('A-MAZE') < 0.25, `wordmark highlight share ${share('A-MAZE').toFixed(2)}`);
  assert.ok(share('Depth 3 Cleared') < 0.25);
  assert.ok(share('A-MAZE') > 0.05, 'but there is still a rim to read the carving by');

  const a = /** @type {{w:number, h:number, mask:Uint8Array}} */ (glyphMask('display', 'A'));
  const z = /** @type {{w:number, h:number, mask:Uint8Array}} */ (glyphMask('display', 'Z'));
  // Nothing on the bottom row of a glyph is ever lit: that would be light from underneath.
  for (const g of [a, z]) {
    let bottom = -1;
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.mask[y * g.w + x] !== 0) bottom = y;
    for (let x = 0; x < g.w; x++) assert.equal(catchesLight(g, x, bottom), false, `bottom row x=${x}`);
  }
  // Empty cells and out-of-range probes are never lit.
  assert.equal(catchesLight(a, -1, 0), false);
  assert.equal(catchesLight(a, 0, 0), false);
  assert.equal(catchesLight(a, a.w, a.h), false);
});
