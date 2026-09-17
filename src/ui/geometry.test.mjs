// @ts-check
/**
 * @file Layout geometry of the whole overlay, audited headlessly at real viewports.
 *
 * Every screen and every HUD mode is rendered through the real code at desktop, phone (dpr 3 and 2)
 * and landscape-phone sizes, with the layout probe recording each line of text, art blit and panel.
 * The rules asserted are the ones the overlay's shipped layout bugs broke: no line overprints
 * another, nothing leaves the surface, text that touches a panel sits inside its frame, and on a
 * portrait phone nothing straddles the edge of the letterboxed world band.
 *
 * A fake `document` lets the glyph atlases and the map raster really be built, so the full map and
 * every glyph blit run here too, not only the arithmetic before them.
 * Run: `node src/ui/geometry.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIEWPORTS,
  auditLayout,
  collectLayout,
  drawableCanvas,
  installFakeDocument,
  intersects,
  playingState,
  portraitBand,
  UNLOCK_FIXTURE,
} from './layout-audit.test-util.mjs';

installFakeDocument();

const { createHud } = await import('./hud.js');
const { createMenus } = await import('./menus.js');
const { resetMapMode } = await import('./map.js');

/**
 * @param {{w:number, h:number}} vp
 * @returns {boolean}
 */
const isPortrait = (vp) => vp.h > vp.w * 1.15;

/**
 * A HUD on a canvas of this viewport, with the world band set on a portrait phone.
 * @param {{w:number, h:number, dpr:number}} vp
 * @param {'off'|'corner'|'full'} mode
 * @returns {any}
 */
function hudAt(vp, mode) {
  resetMapMode();
  const hud = createHud(drawableCanvas(vp.w, vp.h), { map: mode });
  hud.resize(vp.w, vp.h, vp.dpr);
  if (isPortrait(vp)) hud.surface.setViewRect(...portraitBand(vp.w, vp.h));
  return hud;
}

/**
 * Menus on a canvas of this viewport, with the world band set on a portrait phone.
 * @param {{w:number, h:number, dpr:number}} vp
 * @returns {any}
 */
function menusAt(vp) {
  const menus = createMenus(drawableCanvas(vp.w, vp.h), {});
  menus.resize(vp.w, vp.h, vp.dpr);
  if (isPortrait(vp)) menus.surface.setViewRect(...portraitBand(vp.w, vp.h));
  return menus;
}

/**
 * @param {any} menus
 * @param {any} state
 * @param {string} action
 * @returns {void}
 */
function press(menus, state, action) {
  menus.handleInput({ pressed: new Set([action]) }, state);
}

/**
 * Advance the menus' clock through `seconds` of frames (entry fades, tally rows).
 * @param {any} menus
 * @param {any} state
 * @param {number} seconds
 * @returns {void}
 */
function settle(menus, state, seconds) {
  for (let t = 0; t < seconds; t += 1 / 30) {
    state.time += 1 / 30;
    menus.render(state);
  }
}

/**
 * Put a fresh menus/state pair on a screen and return the boxes of one settled frame.
 * @param {{w:number, h:number, dpr:number}} vp
 * @param {string} screen
 * @param {(state:any) => void} [tweak]
 * @returns {{boxes:import('./layout-audit.test-util.mjs').LayoutBox[], menus:any, state:any}}
 */
function screenBoxes(vp, screen, tweak) {
  const menus = menusAt(vp);
  const phase =
    screen === 'pause' || screen === 'confirm'
      ? 'paused'
      : screen === 'complete' || screen === 'tally'
        ? 'levelComplete'
        : screen === 'gameover'
          ? 'gameOver'
          : screen === 'loading'
            ? 'loading'
            : 'title';
  const state = playingState(phase);
  if (tweak !== undefined) tweak(state);
  menus.render(state);
  if (screen === 'options') {
    press(menus, state, 'down');
    press(menus, state, 'down');
    press(menus, state, 'confirm');
  } else if (screen === 'controls') {
    press(menus, state, 'down');
    press(menus, state, 'down');
    press(menus, state, 'down');
    press(menus, state, 'confirm');
  } else if (screen === 'credits') {
    press(menus, state, 'up');
    press(menus, state, 'confirm');
  } else if (screen === 'confirm') {
    press(menus, state, 'up');
    press(menus, state, 'confirm');
  }
  settle(menus, state, screen === 'tally' ? 1 : 3);
  if (screen === 'complete') press(menus, state, 'confirm');
  const boxes = collectLayout(() => {
    state.time += 1 / 60;
    menus.render(state);
  });
  return { boxes, menus, state };
}

// ─── HUD ─────────────────────────────────────────────────────────────────────────────────────

test('HUD: no readout overprints another or sits on its panel frame, in every map mode', () => {
  for (const vp of VIEWPORTS) {
    for (const mode of /** @type {const} */ (['off', 'corner', 'full'])) {
      for (const phase of ['playing', 'paused']) {
        const hud = hudAt(vp, mode);
        const state = playingState(phase);
        hud.render(state, null, 0);
        state.time += 1;
        const boxes = collectLayout(() => hud.render(state, null, 0));
        const m = hud.surface.metrics;
        const texts = boxes.filter((b) => b.kind === 'text');
        assert.ok(texts.length >= 2, `${vp.name} ${mode} ${phase}: the HUD drew its readouts (${texts.length})`);
        assert.deepEqual(auditLayout(boxes, m), [], `${vp.name} ${mode} ${phase}`);
      }
    }
  }
});

test('HUD: the depth plaque fits at the 128×128 cap and on depth 1, at every viewport', () => {
  for (const vp of VIEWPORTS) {
    for (const [level, cols] of [[1, 16], [15, 128], [30, 128]]) {
      const hud = hudAt(vp, 'off');
      const state = playingState();
      state.level = level;
      state.levelData.maze.cols = cols;
      state.levelData.maze.rows = cols;
      state.run.score = level === 1 ? 0 : 1234567;
      hud.render(state, null, 0);
      const boxes = collectLayout(() => hud.render(state, null, 0));
      assert.deepEqual(auditLayout(boxes, hud.surface.metrics), [], `${vp.name} depth ${level}`);
      assert.ok(
        boxes.some((b) => b.kind === 'text' && b.label === `${cols}×${cols}`),
        `${vp.name}: the labyrinth size is on screen at depth ${level}`,
      );
    }
  }
});

test('HUD: on a portrait phone the top panels end above the world band', () => {
  for (const vp of VIEWPORTS.filter(isPortrait)) {
    const hud = hudAt(vp, 'corner');
    const state = playingState();
    hud.render(state, null, 0);
    const boxes = collectLayout(() => hud.render(state, null, 0));
    const m = hud.surface.metrics;
    assert.ok(m.viewY > 0 && m.viewH > 0, `${vp.name}: the band is known`);
    const top = boxes.filter((b) => b.kind === 'panel' && b.y < m.viewY);
    assert.ok(top.length >= 3, `${vp.name}: fuel, score and depth panels sit in the upper deck`);
    for (const p of top) {
      assert.ok(p.y + p.h <= m.viewY, `${vp.name}: ${p.label} panel ends at ${p.y + p.h}, band starts at ${m.viewY}`);
    }
  }
});

test('HUD: the score drops to single height once it would take a quarter of the screen', () => {
  const vp = VIEWPORTS[0];
  const sizeOfScore = (/** @type {number} */ score) => {
    const hud = hudAt(vp, 'off');
    const state = playingState();
    state.run.score = score;
    hud.render(state, null, 0);
    // Let the rolling counter arrive.
    for (let i = 0; i < 90; i++) {
      state.time += 1 / 60;
      hud.render(state, null, 0);
    }
    const boxes = collectLayout(() => hud.render(state, null, 0));
    const box = boxes.find((b) => b.kind === 'text' && /^[\d,]+$/.test(b.label) && b.label.replace(/,/g, '') === String(score));
    assert.ok(box !== undefined, `score ${score} drawn`);
    return { unit: box.unit, u: hud.surface.metrics.u };
  };
  const small = sizeOfScore(4820);
  assert.equal(small.unit, 2 * small.u, 'a four-figure score is double height');
  const big = sizeOfScore(193740);
  assert.equal(big.unit, big.u, 'a six-figure score is not the loudest thing on screen');
});

// ─── Menus ───────────────────────────────────────────────────────────────────────────────────

const SCREENS = ['title', 'pause', 'confirm', 'options', 'controls', 'credits', 'loading', 'tally', 'complete', 'gameover'];

test('menus: every screen is clean at every viewport', () => {
  for (const vp of VIEWPORTS) {
    for (const screen of SCREENS) {
      const { boxes, menus } = screenBoxes(vp, screen);
      const expected = screen === 'tally' ? 'complete' : screen;
      assert.equal(menus.screen(), expected, `${vp.name}: reached ${screen}`);
      assert.ok(boxes.some((b) => b.kind === 'text'), `${vp.name} ${screen}: drew text`);
      assert.deepEqual(auditLayout(boxes, menus.surface.metrics), [], `${vp.name} ${screen}`);
    }
  }
});

test('game over on a phone: every expedition label fits its own column (no "LABYRINTEXPLORED")', () => {
  for (const vp of VIEWPORTS.filter(isPortrait)) {
    for (const newRecord of [false, true]) {
      const { boxes, menus } = screenBoxes(vp, 'gameover', (s) => {
        if (newRecord) s.best.score = s.run.score;
      });
      const m = menus.surface.metrics;
      assert.equal(m.w, vp.dpr === 3 ? 234 : 195, `${vp.name}: the surface the critic measured`);
      const panel = boxes.find((b) => b.kind === 'panel');
      assert.ok(panel !== undefined);
      const left = panel.x + 7 * m.u;
      const colW = Math.floor((panel.w - 14 * m.u) / 2);
      const stats = ['LABYRINTH', 'EXPLORED', 'REFUELS', 'WALKED'];
      for (const label of stats) {
        const box = boxes.find((b) => b.kind === 'text' && b.label === label);
        assert.ok(box !== undefined, `${vp.name}: ${label} is shown`);
        const col = Math.round((box.x - left) / colW);
        assert.ok(
          box.x + box.w + box.unit <= left + (col + 1) * colW,
          `${vp.name}: ${label} (${box.w} px at ×${box.unit}) fits its ${colW}-pixel column`,
        );
      }
      const texts = boxes.filter((b) => b.kind === 'text');
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
          assert.equal(intersects(texts[i], texts[j]), false, `"${texts[i].label}" / "${texts[j].label}"`);
        }
      }
    }
  }
});

test('level complete: the tally is never the smallest text on the screen', () => {
  for (const vp of VIEWPORTS) {
    const tally = screenBoxes(vp, 'tally').boxes.filter((b) => b.kind === 'text');
    // (0.3 s + 1 s of settle: the first row is due at 0.5 s and the prompt shows until ~2.3 s.)
    const prompt = tally.find((b) => /SKIP/.test(b.label));
    const firstRow = tally.find((b) => b.label.startsWith('GEMS'));
    assert.ok(prompt !== undefined && firstRow !== undefined, `${vp.name}: prompt and first row are up`);
    assert.ok(prompt.h <= firstRow.h, `${vp.name}: the skip prompt (${prompt.h}) is not louder than the rows (${firstRow.h})`);

    const { boxes, menus } = screenBoxes(vp, 'complete');
    const m = menus.surface.metrics;
    const texts = boxes.filter((b) => b.kind === 'text');
    const row = texts.find((b) => b.label.startsWith('TORCH LEFT'));
    const total = texts.find((b) => b.label === 'TOTAL');
    const heading = texts.find((b) => b.label.startsWith('Depth'));
    assert.ok(row !== undefined && total !== undefined && heading !== undefined);
    assert.ok(heading.unit >= total.unit, `${vp.name}: heading ×${heading.unit} ≥ total ×${total.unit}`);
    assert.ok(total.unit >= row.unit, `${vp.name}: total ×${total.unit} ≥ rows ×${row.unit}`);
    if (!m.narrow) assert.equal(row.unit, m.u, `${vp.name}: on a desktop the rows keep their full size`);
    const smallest = Math.min(...texts.filter((b) => b.kind === 'text').map((b) => b.h));
    const statLabel = texts.find((b) => b.label === 'LABYRINTH');
    // Only the expedition strip (the secondary block) may be smaller than the tally.
    for (const b of texts) {
      if (b.h < row.h) {
        assert.ok(
          statLabel !== undefined && b.unit <= statLabel.unit && /^[A-Z\d×,%m]+$/.test(b.label),
          `${vp.name}: only the expedition strip is smaller than the tally rows, not "${b.label}" (${b.h} < ${row.h}, smallest ${smallest})`,
        );
      }
    }
  }
});

test('title on a portrait phone: wordmark above the world band, menu below it, nothing across it', () => {
  for (const vp of VIEWPORTS.filter(isPortrait)) {
    const { boxes, menus } = screenBoxes(vp, 'title');
    const m = menus.surface.metrics;
    const bandTop = m.viewY;
    const bandBottom = m.viewY + m.viewH;
    const mark = boxes.find((b) => b.kind === 'art');
    assert.ok(mark !== undefined, `${vp.name}: the wordmark is drawn`);
    assert.ok(mark.y + mark.h <= bandTop, `${vp.name}: wordmark ends at ${mark.y + mark.h}, band at ${bandTop}`);
    for (const label of ['Descend', 'Options', 'Controls', 'Credits']) {
      const row = boxes.find((b) => b.kind === 'text' && b.label === label);
      assert.ok(row !== undefined, `${vp.name}: ${label}`);
      assert.ok(row.y >= bandBottom, `${vp.name}: ${label} at ${row.y} sits in the deck below ${bandBottom}`);
    }
    for (const b of boxes.filter((x) => x.kind !== 'panel')) {
      const crossesTop = b.y < bandTop && b.y + b.h > bandTop;
      const crossesBottom = b.y < bandBottom && b.y + b.h > bandBottom;
      assert.equal(crossesTop || crossesBottom, false, `${vp.name}: "${b.label}" straddles the band edge`);
    }
  }
});

/**
 * Cap height of a recorded line in UI pixels: 10 rows a step for the display face, 7 for the HUD face.
 * @param {import('./layout-audit.test-util.mjs').LayoutBox} b
 * @returns {number}
 */
const capOf = (b) => (b.h === 12 * b.unit ? 10 : 7) * b.unit;

test('title: the menu outranks the record line and the footer at every viewport', () => {
  for (const vp of VIEWPORTS) {
    const { boxes } = screenBoxes(vp, 'title');
    const texts = boxes.filter((b) => b.kind === 'text');
    const menu = texts.filter((b) => ['Descend', 'Options', 'Controls', 'Credits'].includes(b.label));
    assert.equal(menu.length, 4, `${vp.name}: four menu rows`);
    const menuCap = Math.min(...menu.map(capOf));
    for (const label of [/^BEST /, /^v0\./, /^©/]) {
      const line = texts.find((b) => label.test(b.label));
      assert.ok(line !== undefined, `${vp.name}: ${label} is drawn`);
      assert.ok(
        capOf(line) < menuCap,
        `${vp.name}: "${line.label}" cap ${capOf(line)} must be quieter than the menu's ${menuCap}`,
      );
    }
    const mark = boxes.find((b) => b.kind === 'art');
    assert.ok(mark !== undefined && mark.h > menuCap * 2, `${vp.name}: the wordmark still leads`);
  }
});

test('title: the menu is one size whether or not a best score has been saved', () => {
  for (const vp of VIEWPORTS) {
    /** @param {boolean} fresh @returns {number[]} */
    const units = (fresh) => {
      const { boxes } = screenBoxes(vp, 'title', (s) => {
        if (fresh) s.best = { score: 0, level: 0 };
      });
      const menu = boxes.filter((b) => b.kind === 'text' && ['Descend', 'Options', 'Controls', 'Credits'].includes(b.label));
      const sub = boxes.find((b) => b.kind === 'text' && b.label === 'The Torchlit Descent');
      assert.ok(sub !== undefined && menu.length === 4, `${vp.name}: subtitle and menu drawn`);
      if (!isPortrait(vp)) {
        for (const row of menu) assert.ok(row.unit <= sub.unit, `${vp.name}: "${row.label}" ×${row.unit} over a ×${sub.unit} subtitle`);
      }
      return menu.map((b) => b.unit);
    };
    assert.deepEqual(units(true), units(false), `${vp.name}: fresh profile vs saved record`);
  }
});

test('end screens: each stat value sits closer to its own label than to the next one', () => {
  for (const vp of VIEWPORTS) {
    for (const screen of ['complete', 'gameover']) {
      const { boxes } = screenBoxes(vp, screen);
      const find = (/** @type {string|RegExp} */ l) =>
        boxes.find((b) => b.kind === 'text' && (typeof l === 'string' ? b.label === l : l.test(b.label)));
      const label = find('LABYRINTH');
      const value = find(/^\d+×\d+$/);
      const next = find('REFUELS');
      assert.ok(label !== undefined && value !== undefined && next !== undefined, `${vp.name} ${screen}: strip drawn`);
      const own = value.y - (label.y + label.h);
      const toNext = next.y - (value.y + value.h);
      assert.ok(own < toNext, `${vp.name} ${screen}: label→value ${own} px must be < value→next label ${toNext} px`);
    }
  }
});

test('title and panel headings stay within 2× of a world texel on desktop (no mixels)', () => {
  for (const vp of VIEWPORTS.filter((v) => !isPortrait(v))) {
    for (const screen of ['title', 'pause', 'options', 'complete', 'gameover']) {
      const { boxes, menus } = screenBoxes(vp, screen);
      const m = menus.surface.metrics;
      // The world is 240 rows tall, stretched over the device height.
      const texel = m.devH / 240;
      for (const b of boxes) {
        const display = b.kind === 'art' || (b.kind === 'text' && b.h === 12 * b.unit);
        if (!display) continue;
        const devicePx = b.unit * m.px;
        assert.ok(
          devicePx <= 2 * texel + 1e-9,
          `${vp.name} ${screen}: "${b.label || 'wordmark'}" at ${devicePx} device px per pixel vs a ${texel} px texel`,
        );
      }
    }
  }
});

test('options on a phone: every value word is drawn at one size', () => {
  for (const vp of VIEWPORTS.filter(isPortrait)) {
    const { boxes } = screenBoxes(vp, 'options');
    const words = boxes.filter(
      (b) => b.kind === 'text' && /^(ON|OFF|Off|Corner|Full|\d+%|\d+\.\d×)$/.test(b.label),
    );
    assert.ok(words.length >= 6, `${vp.name}: sliders, switches and the map value (${words.map((w) => w.label)})`);
    const units = new Set(words.map((w) => w.unit));
    assert.equal(units.size, 1, `${vp.name}: value sizes ${[...units].join(', ')}`);
  }
});

test('controls: a connected gamepad adds a clean PAD column', () => {
  const g = /** @type {any} */ (globalThis);
  const saved = Object.getOwnPropertyDescriptor(g, 'navigator');
  Object.defineProperty(g, 'navigator', {
    value: { getGamepads: () => [null, { connected: true }] },
    configurable: true,
    writable: true,
  });
  try {
    for (const vp of VIEWPORTS.filter((v) => !isPortrait(v))) {
      const { boxes, menus } = screenBoxes(vp, 'controls');
      assert.ok(boxes.some((b) => b.label === 'PAD'), `${vp.name}: the PAD heading is shown`);
      assert.ok(boxes.some((b) => b.label === 'B'), `${vp.name}: a pad binding is shown`);
      assert.deepEqual(auditLayout(boxes, menus.surface.metrics), [], vp.name);
    }
  } finally {
    if (saved !== undefined) Object.defineProperty(g, 'navigator', saved);
    else delete g.navigator;
  }
});

// ─── Unlocks wave: Shrine, Boon and the perk HUD (ARCHITECTURE.md §4.9) ─────────────────────

/**
 * A title/level-complete state carrying progress and an open boon.
 * @param {string} phase
 * @returns {any}
 */
function unlockState(phase) {
  const state = playingState(phase);
  state.progress = { purse: 260, ranks: { reservoir: 2, richOil: 1, siphon: 2, oilSense: 3, whisper: 3, chalk: 3 }, boonLevel: 0 };
  state.offer = { open: true, level: 15, ids: ['whisper', 'appraiser', 'ember'] };
  return state;
}

test('shrine and boon: clean at every viewport, scrolled or not, with the longest shipped strings', () => {
  for (const vp of VIEWPORTS) {
    for (const [screen, phase, downs] of [['shrine', 'title', 0], ['shrine', 'title', 12], ['boon', 'levelComplete', 0]]) {
      const menus = createMenus(drawableCanvas(vp.w, vp.h), { unlocks: UNLOCK_FIXTURE });
      menus.resize(vp.w, vp.h, vp.dpr);
      if (isPortrait(vp)) menus.surface.setViewRect(...portraitBand(vp.w, vp.h));
      const state = unlockState(phase);
      menus.render(state);
      if (screen === 'shrine') {
        press(menus, state, 'down');
        press(menus, state, 'confirm');
        for (let i = 0; i < downs; i++) press(menus, state, 'down');
      } else {
        press(menus, state, 'confirm'); // skip the tally; the boon opens itself
      }
      // The boon holds 3.5 s after the tally before it opens itself.
      settle(menus, state, screen === 'boon' ? 4.5 : 2);
      assert.equal(menus.screen(), screen, `${vp.name}: reached ${screen}`);
      const boxes = collectLayout(() => {
        state.time += 1 / 60;
        menus.render(state);
      });
      const texts = boxes.filter((b) => b.kind === 'text');
      assert.ok(texts.length >= 6, `${vp.name} ${screen}: drew its text (${texts.length})`);
      assert.deepEqual(auditLayout(boxes, menus.surface.metrics), [], `${vp.name} ${screen} after ${downs} downs`);
    }
  }
});

test('HUD: the chalk chip, scroll sense and lodestone are clean at every viewport', () => {
  for (const vp of VIEWPORTS) {
    for (const found of [false, true]) {
      const hud = hudAt(vp, 'corner');
      const state = playingState();
      state.perks = { chalk: 16, scrollSense: 28, lodestone: 1, siphonCap: 50, flame: 1, oilSense: 0, whisper: 0 };
      state.run.chalk = 12;
      state.run.reserve = 30;
      state.run.mapFound = found;
      state.derived.scrollSense = 0.6;
      hud.render(state, null, 0);
      state.time += 1;
      const boxes = collectLayout(() => hud.render(state, null, 0));
      assert.ok(boxes.some((b) => b.kind === 'text' && b.label === '×12'), `${vp.name}: the chalk count is on screen`);
      assert.deepEqual(auditLayout(boxes, hud.surface.metrics), [], `${vp.name} scroll found=${found}`);
    }
  }
});
