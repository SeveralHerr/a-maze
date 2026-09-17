// @ts-check
/**
 * @file Unit tests for src/ui/menus.js — the navigation state machine, pointer hit-testing maths,
 * slider quantisation, and the callback contract with `src/main.js`.
 * Run: `node src/ui/menus.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cellsForLevel, createMenus, hitTest, menuStep, sliderValueAt } from './menus.js';
import { resetMapMode, setMapMode } from './map.js';

// ─── Pure helpers ────────────────────────────────────────────────────────────────────────────

test('menuStep moves, wraps and skips disabled rows', () => {
  const all = [true, true, true];
  assert.equal(menuStep(all, 0, 1), 1);
  assert.equal(menuStep(all, 1, 1), 2);
  assert.equal(menuStep(all, 2, 1), 0, 'wraps forward');
  assert.equal(menuStep(all, 0, -1), 2, 'wraps backward');
  assert.equal(menuStep(all, 2, -1), 1);

  const gappy = [true, false, false, true, false];
  assert.equal(menuStep(gappy, 0, 1), 3, 'skips the disabled run');
  assert.equal(menuStep(gappy, 3, 1), 0, 'wraps past the trailing disabled run');
  assert.equal(menuStep(gappy, 0, -1), 3);
  assert.equal(menuStep(gappy, 3, -1), 0);

  // A selection sitting on a disabled row still moves to the next enabled one.
  assert.equal(menuStep(gappy, 1, 1), 3);
  assert.equal(menuStep(gappy, 2, -1), 0);
});

test('menuStep is total: empty lists, all-disabled lists and junk indices', () => {
  assert.equal(menuStep([], 0, 1), 0);
  assert.equal(menuStep([false, false], 1, 1), 1, 'nothing selectable leaves the index alone');
  assert.equal(menuStep([true, true, true], -1, 1), 0, 'a fresh screen enters at the first row');
  assert.equal(menuStep([true, true, true], 99, 1), 0);
  assert.equal(menuStep([true, true, true], -1, -1), 2, 'and at the last row going backwards');
  assert.equal(menuStep([false, true, false], 0, 1), 1);
  assert.equal(menuStep([true], 0, 1), 0, 'a single row is its own neighbour');
});

test('menuStep honours the count argument (reused buffers)', () => {
  const buffer = [true, true, true, false, false, false, false, false];
  assert.equal(menuStep(buffer, 2, 1, 3), 0, 'wraps at the live length, not the buffer length');
  assert.equal(menuStep(buffer, 0, -1, 3), 2);
  assert.equal(menuStep(buffer, 0, 1, 0), 0, 'a zero count changes nothing');
  assert.equal(menuStep(buffer, 0, 1, 99), 1, 'a count past the end is clamped');
});

test('hitTest finds the rectangle under a point, with half-open edges', () => {
  // Two stacked rows, 100 wide and 20 tall, with a 4-pixel gap.
  const rects = new Float64Array([10, 10, 100, 20, 10, 34, 100, 20, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(hitTest(rects, 2, 10, 10), 0, 'top-left corner is inside');
  assert.equal(hitTest(rects, 2, 109, 29), 0, 'bottom-right pixel is inside');
  assert.equal(hitTest(rects, 2, 110, 20), -1, 'right edge is exclusive');
  assert.equal(hitTest(rects, 2, 60, 30), -1, 'the gap belongs to nobody');
  assert.equal(hitTest(rects, 2, 60, 34), 1);
  assert.equal(hitTest(rects, 2, 9, 20), -1);
  assert.equal(hitTest(rects, 0, 60, 20), -1, 'a stale layout hits nothing');
  assert.equal(hitTest(rects, 2, NaN, NaN), -1);
});

test('sliderValueAt maps a drag onto a quantised, clamped value', () => {
  // A 100-wide track for a 0..1 setting in tenths.
  assert.equal(sliderValueAt(0, 0, 100, 0, 1, 0.1), 0);
  assert.equal(sliderValueAt(50, 0, 100, 0, 1, 0.1), 0.5);
  assert.equal(sliderValueAt(100, 0, 100, 0, 1, 0.1), 1);
  assert.equal(sliderValueAt(-40, 0, 100, 0, 1, 0.1), 0, 'dragging off the left pins to min');
  assert.equal(sliderValueAt(400, 0, 100, 0, 1, 0.1), 1, 'and off the right pins to max');
  assert.equal(sliderValueAt(54, 0, 100, 0, 1, 0.1), 0.5, 'quantised to the step');
  assert.equal(sliderValueAt(56, 0, 100, 0, 1, 0.1), 0.6);

  // The sensitivity slider: 0.2‥3 in tenths, on a track that does not start at zero.
  const v = sliderValueAt(150, 100, 100, 0.2, 3, 0.1);
  assert.equal(v, 1.6);
  assert.ok(Number.isFinite(v));
  assert.equal(sliderValueAt(100, 100, 100, 0.2, 3, 0.1), 0.2);
  assert.equal(sliderValueAt(200, 100, 100, 0.2, 3, 0.1), 3);
  // Floating point must not leak into the settings.
  for (let x = 0; x <= 100; x++) {
    const value = sliderValueAt(x, 0, 100, 0, 1, 0.1);
    assert.equal(Math.round(value * 1000) / 1000, value, `value ${value} at x=${x}`);
    assert.ok(value >= 0 && value <= 1);
  }
  assert.equal(sliderValueAt(10, 0, 0, 0.2, 3, 0.1), 0.2, 'a zero-width track returns the minimum');
  assert.equal(sliderValueAt(37, 0, 100, 0, 1, 0), 0.37, 'a zero step is continuous');
});

// ─── The menu object ─────────────────────────────────────────────────────────────────────────

/**
 * A complete `GameState` (§3) for driving the menus headlessly.
 * @param {string} phase
 * @returns {any}
 */
function makeState(phase) {
  return {
    phase,
    time: 0,
    phaseTime: 0,
    level: 3,
    seed: 1,
    levelData: null,
    player: { x: 1.5, y: 1.5, angle: 0, px: 1.5, py: 1.5, pangle: 0, vx: 0, vy: 0, bob: 0, bobAmp: 0, shake: 0 },
    explored: null,
    run: { score: 4820, gems: 7, gemsTotal: 12, fuel: 40, fuelMax: 120, levelTime: 30, totalTime: 30, levelScore: 3840, bestCombo: 2 },
    best: { score: 12750, level: 6 },
    settings: {
      volume: 0.8,
      music: 0.55,
      sensitivity: 1,
      scanlines: true,
      minimap: true,
      reducedMotion: false,
      invertLook: false,
      fullscreen: true,
    },
    derived: { exitDist: 8, nearExit: 0, lowFuel: false },
    events: [],
  };
}

/**
 * An input frame with one action pressed.
 * @param {string} action
 * @returns {any}
 */
function press(action) {
  return { moveX: 0, moveY: 0, turn: 0, lookDX: 0, pressed: new Set([action]) };
}

/**
 * Menus wired to recording callbacks.
 * @returns {{menus:any, log:string[], settings:Array<[string, any]>}}
 */
function harness() {
  /** @type {string[]} */
  const log = [];
  /** @type {Array<[string, any]>} */
  const settings = [];
  const menus = createMenus(null, {
    onNewGame: () => log.push('newGame'),
    onResume: () => log.push('resume'),
    onQuit: () => log.push('quit'),
    onNextLevel: () => log.push('nextLevel'),
    onSetting: (k, v) => {
      settings.push([String(k), v]);
      log.push(`setting:${String(k)}`);
    },
    onUiSound: (t) => log.push(`sfx:${t}`),
  });
  return { menus, log, settings };
}

test('title navigation reaches every item and wraps', () => {
  const { menus, log } = harness();
  const state = makeState('title');
  // `render` is the observation point: it is what commits the screen the player is looking at.
  menus.render(state);
  assert.equal(menus.screen(), 'title');

  // The first row starts a run.
  menus.handleInput(press('confirm'), state);
  assert.ok(log.includes('newGame'));
  assert.ok(log.includes('sfx:uiConfirm'));

  // Down past the Shrine to Options, confirm, and back out again.
  assert.equal(menus.handleInput(press('down'), state), true);
  menus.handleInput(press('down'), state);
  assert.ok(log.includes('sfx:uiMove'));
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  assert.equal(menus.screen(), 'options');
  assert.equal(menus.handleInput(press('back'), state), true);
  assert.ok(log.includes('sfx:uiBack'));
  menus.render(state);
  assert.equal(menus.screen(), 'title', 'and the title list remembers where it was');

  // Up from Options past the Shrine to Descend, then up again wraps round to Credits.
  menus.handleInput(press('up'), state);
  menus.handleInput(press('up'), state);
  menus.handleInput(press('up'), state);
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  assert.equal(menus.screen(), 'credits', 'selection wrapped to the last row');

  menus.handleInput(press('back'), state);
  menus.render(state);
  assert.equal(menus.screen(), 'title');
});

test('playing consumes nothing; loading consumes nothing', () => {
  const { menus } = harness();
  assert.equal(menus.handleInput(press('confirm'), makeState('playing')), false);
  assert.equal(menus.handleInput(press('down'), makeState('playing')), false);
  assert.equal(menus.handleInput(press('confirm'), makeState('loading')), false);
});

test('pause: back resumes, and the rows do what they say', () => {
  const { menus, log } = harness();
  const state = makeState('paused');
  menus.handleInput(press('confirm'), state); // Resume (first row)
  assert.ok(log.includes('resume'));

  log.length = 0;
  // Rows: Resume, Options, Controls, Quit to Title.
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state); // Quit to Title
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  assert.equal(log.includes('quit'), false, 'Quit to Title asks first');
  assert.equal(menus.screen(), 'confirm');
  // The dialog opens on its safe answer: a second Enter keeps the run.
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  assert.equal(menus.screen(), 'pause');
  assert.equal(log.includes('quit'), false);
  // Back on Quit to Title (the row is remembered), then Abandon.
  menus.handleInput(press('confirm'), state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  assert.deepEqual(log.filter((e) => e === 'quit'), ['quit'], 'Abandon quits exactly once');

  log.length = 0;
  menus.render(state);
  assert.equal(menus.handleInput(press('back'), state), true);
  assert.ok(log.includes('resume'), 'Esc on the pause screen resumes');
});

test('the abandon dialog: back and the first row both keep the run', () => {
  const { menus, log } = harness();
  const state = makeState('paused');
  menus.render(state);
  for (let i = 0; i < 3; i++) menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  assert.equal(menus.screen(), 'confirm');
  // Escape arrives as back + pause in one frame (§4.3): one close, no resume, no quit.
  menus.handleInput({ pressed: new Set(['back', 'pause']) }, state);
  menus.render(state);
  assert.equal(menus.screen(), 'pause', 'Escape cancels the dialog');
  assert.equal(log.includes('quit') || log.includes('resume'), false);
});

test('options: arrows adjust settings without mutating state', () => {
  const { menus, log, settings } = harness();
  const state = makeState('title');
  menus.handleInput(press('down'), state); // Shrine
  menus.handleInput(press('down'), state); // Options
  menus.handleInput(press('confirm'), state);

  // First row is the Sound slider.
  menus.handleInput(press('left'), state);
  assert.deepEqual(settings.at(-1), ['volume', 0.7]);
  assert.equal(state.settings.volume, 0.8, 'the menu never writes to the state itself');

  menus.handleInput(press('right'), state);
  assert.deepEqual(settings.at(-1), ['volume', 0.9]);

  // Clamping: pushing past the end reports nothing new and plays the "denied" cue.
  state.settings.volume = 1;
  log.length = 0;
  menus.handleInput(press('right'), state);
  assert.equal(settings.at(-1)[1], 0.9, 'no new setting emitted at the maximum');
  assert.ok(log.includes('sfx:uiDeny'));

  // Walk down to the first toggle and flip it.
  for (let i = 0; i < 3; i++) menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  assert.deepEqual(settings.at(-1), ['scanlines', false]);

  // Left/right set a toggle absolutely rather than flipping it.
  state.settings.scanlines = false;
  menus.handleInput(press('right'), state);
  assert.deepEqual(settings.at(-1), ['scanlines', true]);
  state.settings.scanlines = true;
  menus.handleInput(press('left'), state);
  assert.deepEqual(settings.at(-1), ['scanlines', false]);
});

test('options: the Fullscreen row sits above Back and toggles the fullscreen setting', () => {
  const { menus, settings } = harness();
  const state = makeState('title');
  menus.handleInput(press('down'), state); // Shrine
  menus.handleInput(press('down'), state); // Options
  menus.handleInput(press('confirm'), state);
  // Up from the first row wraps to Back; one more up is the last setting row.
  menus.handleInput(press('up'), state);
  menus.handleInput(press('up'), state);
  menus.handleInput(press('confirm'), state);
  assert.deepEqual(settings.at(-1), ['fullscreen', false]);
  state.settings.fullscreen = false;
  menus.handleInput(press('right'), state);
  assert.deepEqual(settings.at(-1), ['fullscreen', true]);
});

test('options: the sensitivity slider stays inside its own range', () => {
  const { menus, settings } = harness();
  const state = makeState('title');
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state); // Look Speed

  state.settings.sensitivity = 0.2;
  menus.handleInput(press('left'), state);
  assert.equal(settings.length, 0, 'already at the minimum');
  menus.handleInput(press('right'), state);
  assert.deepEqual(settings.at(-1), ['sensitivity', 0.3]);

  state.settings.sensitivity = 3;
  menus.handleInput(press('right'), state);
  assert.deepEqual(settings.at(-1), ['sensitivity', 0.3], 'no emission past the maximum');
});

test('level complete: confirm skips the tally, then descends', () => {
  const { menus, log } = harness();
  const state = makeState('levelComplete');
  // A render is what starts the tally clock; with no canvas it still runs the state machine.
  menus.render(state);
  assert.equal(menus.screen(), 'complete');

  menus.handleInput(press('confirm'), state);
  assert.equal(log.filter((e) => e === 'nextLevel').length, 0, 'the first confirm only skips');
  menus.handleInput(press('confirm'), state);
  assert.equal(log.filter((e) => e === 'nextLevel').length, 1);

  log.length = 0;
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  assert.equal(menus.screen(), 'confirm', 'Quit to Title from a cleared depth asks first');
  assert.equal(log.includes('quit'), false);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  assert.ok(log.includes('quit'));
});

test('Escape on level complete never abandons the run', () => {
  const { menus, log } = harness();
  const state = makeState('levelComplete');
  menus.render(state);
  state.time = 0.3;
  menus.render(state);

  // Escape, Backspace and pad B all arrive as `back`; Escape also carries `pause`.
  for (const frame of [{ pressed: new Set(['back', 'pause']) }, press('back'), press('pause')]) {
    menus.handleInput(frame, state);
    menus.render(state);
    assert.equal(log.includes('quit'), false, 'no single keypress quits from the tally');
    assert.equal(menus.screen(), 'complete');
  }
  // The first Escape finished the tally and moved the cursor onto Quit to Title: confirm now opens
  // the dialog rather than descending.
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  assert.equal(menus.screen(), 'confirm');
  assert.equal(log.includes('nextLevel'), false);

  // Cancelling returns to the finished tally — it must not roll again.
  menus.handleInput(press('back'), state);
  state.time = 0.35;
  menus.render(state);
  assert.equal(menus.screen(), 'complete');
  menus.handleInput(press('up'), state);
  menus.handleInput(press('up'), state);
  log.length = 0;
  menus.handleInput(press('confirm'), state);
  assert.deepEqual(log.filter((e) => e === 'nextLevel'), ['nextLevel'], 'the tally stayed finished');
});

test('game over: back is still a direct exit (that run is already over)', () => {
  const { menus, log } = harness();
  const state = makeState('gameOver');
  menus.render(state);
  menus.handleInput(press('back'), state);
  assert.deepEqual(log.filter((e) => e === 'quit'), ['quit']);
  // …and so is its Title row: no dialog.
  log.length = 0;
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  assert.deepEqual(log.filter((e) => e === 'quit'), ['quit']);
});

test('the next level-complete screen opens on Descend, whatever was selected last time', () => {
  const { menus, log } = harness();
  const state = makeState('levelComplete');
  menus.render(state);
  menus.handleInput(press('back'), state); // finish the tally, cursor to Quit to Title
  menus.render(state);
  state.phase = 'loading';
  state.time = 2;
  menus.render(state);
  state.phase = 'levelComplete';
  state.time = 4;
  menus.render(state);
  menus.handleInput(press('confirm'), state); // skip
  log.length = 0;
  menus.handleInput(press('confirm'), state);
  assert.deepEqual(log.filter((e) => e === 'nextLevel'), ['nextLevel']);
});

test('game over: retry and title', () => {
  const { menus, log } = harness();
  const state = makeState('gameOver');
  menus.render(state);
  assert.equal(menus.screen(), 'gameover');
  menus.handleInput(press('confirm'), state);
  assert.ok(log.includes('newGame'));
  log.length = 0;
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  assert.ok(log.includes('quit'));
});

test('a phase change closes any open sub-screen', () => {
  const { menus } = harness();
  const title = makeState('title');
  menus.render(title);
  menus.handleInput(press('down'), title);
  menus.handleInput(press('down'), title);
  menus.handleInput(press('confirm'), title);
  menus.render(title);
  assert.equal(menus.screen(), 'options');

  const over = makeState('gameOver');
  over.time = 1;
  menus.render(over);
  assert.equal(menus.screen(), 'gameover', 'the options panel does not survive the transition');
});

test('menus never throw on junk input or a throwing callback', () => {
  const menus = createMenus(null, {
    onNewGame: () => {
      throw new Error('boom');
    },
    onUiSound: () => {
      throw new Error('boom');
    },
  });
  const state = makeState('title');
  assert.doesNotThrow(() => menus.render(state));
  assert.doesNotThrow(() => menus.handleInput(null, state));
  assert.doesNotThrow(() => menus.handleInput(/** @type {any} */ ({}), state));
  assert.doesNotThrow(() => menus.handleInput(/** @type {any} */ ({ pressed: 7 }), state));
  assert.doesNotThrow(() => menus.handleInput(press('confirm'), state), 'a throwing callback is contained');
  assert.equal(menus.handleInput(press('confirm'), /** @type {any} */ (null)), false);
  assert.doesNotThrow(() => menus.render(/** @type {any} */ (null)));
  assert.equal(menus.handlePointer(/** @type {any} */ ({ type: 'pointerdown' })), false);
  assert.equal(menus.handlePointer(/** @type {any} */ (null)), false);
  assert.doesNotThrow(() => menus.resize(800, 600, 1));
  assert.doesNotThrow(() => menus.dispose());
});

test('menus built with no callbacks at all are inert, not broken', () => {
  const menus = createMenus(null);
  const state = makeState('title');
  assert.doesNotThrow(() => menus.render(state));
  assert.equal(menus.handleInput(press('confirm'), state), true, 'still consumes the key');
});

// ─── The three-state map option ──────────────────────────────────────────────────────────────

test('the map row cycles through its three states and writes both settings shapes', () => {
  resetMapMode();
  const { menus, settings } = harness();
  const state = makeState('title');
  // Walk into Options and down to the Map row.
  menus.render(state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  assert.equal(menus.screen(), 'options');

  // Rows: Sound, Music, Look Speed, Scanlines, Map, …
  for (let i = 0; i < 4; i++) menus.handleInput(press('down'), state);
  settings.length = 0;
  menus.handleInput(press('confirm'), state);

  // One confirm must write the new-style string *and* the legacy boolean, so the preference
  // survives whichever of the two `src/state` actually stores.
  const keys = settings.map(([k]) => k);
  assert.ok(keys.includes('mapMode'), `expected a mapMode write, got ${keys.join(',')}`);
  assert.ok(keys.includes('minimap'), 'the legacy boolean is kept in step');
  const mode = settings.find(([k]) => k === 'mapMode')[1];
  assert.equal(mode, 'full', 'corner → full');
  assert.equal(settings.find(([k]) => k === 'minimap')[1], true);

  // Again: full → off, and the boolean follows it down.
  settings.length = 0;
  menus.handleInput(press('confirm'), state);
  assert.equal(settings.find(([k]) => k === 'mapMode')[1], 'off');
  assert.equal(settings.find(([k]) => k === 'minimap')[1], false);
  resetMapMode();
});

test('left and right step the map row in both directions and wrap', () => {
  resetMapMode();
  const { menus, settings } = harness();
  const state = makeState('title');
  menus.render(state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  for (let i = 0; i < 4; i++) menus.handleInput(press('down'), state);

  settings.length = 0;
  menus.handleInput(press('left'), state);
  assert.equal(settings.find(([k]) => k === 'mapMode')[1], 'off', 'corner → off going back');
  settings.length = 0;
  menus.handleInput(press('left'), state);
  assert.equal(settings.find(([k]) => k === 'mapMode')[1], 'full', 'and wraps past the start');
  resetMapMode();
});

// ─── Pointer interaction ─────────────────────────────────────────────────────────────────────
//
// These drive the real layout: a canvas with a 2-D context (so `render` lays rows out and records
// their rectangles) plus a `getBoundingClientRect`, then genuine client coordinates through
// `handlePointer`. Keyboard navigation was covered thoroughly and the pointer paths were not,
// which is how a `choice` row that wrote the wrong value and a tally nobody could skip by touch
// both shipped.

/**
 * A 2-D context that accepts every call the menus make and draws nothing. Node has no canvas, so
 * the font atlas cannot be built and `drawText` no-ops — the *layout*, which is what the pointer
 * hit-tests against, runs in full.
 * @returns {any}
 */
function fakeCtx() {
  return {
    globalAlpha: 1,
    fillStyle: '',
    imageSmoothingEnabled: false,
    setTransform() {},
    clearRect() {},
    fillRect() {},
    drawImage() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
  };
}

/**
 * A canvas that lays out at `cssW × cssH` at the page origin and hands back {@link fakeCtx}.
 * @param {number} cssW
 * @param {number} cssH
 * @returns {any}
 */
function liveCanvas(cssW, cssH) {
  const ctx = fakeCtx();
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssW, height: cssH }),
  };
}

/**
 * Menus on a real-sized surface, sitting on the options screen.
 * @param {number} cssW
 * @param {number} cssH
 * @param {number} dpr
 * @returns {{menus:any, state:any, settings:Array<[string, any]>, log:string[], click:(x:number, y:number) => void, surface:any}}
 */
function optionsHarness(cssW, cssH, dpr) {
  /** @type {string[]} */
  const log = [];
  /** @type {Array<[string, any]>} */
  const settings = [];
  const canvas = liveCanvas(cssW, cssH);
  const menus = createMenus(canvas, {
    onNewGame: () => log.push('newGame'),
    onResume: () => log.push('resume'),
    onQuit: () => log.push('quit'),
    onNextLevel: () => log.push('nextLevel'),
    onSetting: (k, v) => {
      settings.push([String(k), v]);
      // The reducer would write the value back into the state; do the same, so the next frame
      // reads what the player just chose.
      state.settings[String(k)] = v;
    },
    onUiSound: (t) => log.push(`sfx:${t}`),
  });
  menus.resize(cssW, cssH, dpr);
  const state = makeState('title');
  menus.render(state);
  menus.handleInput(press('down'), state); // Descend → Shrine
  menus.handleInput(press('down'), state); // → Options
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  /**
   * One complete press at a point in **client** coordinates.
   * @param {number} x
   * @param {number} y
   * @returns {void}
   */
  const click = (x, y) => {
    menus.handlePointer({ type: 'pointerdown', clientX: x, clientY: y });
    menus.handlePointer({ type: 'pointerup', clientX: x, clientY: y });
    menus.render(state);
  };
  return { menus, state, settings, log, click, surface: menus.surface };
}

/**
 * Put the map back to a known state before a probe, so a write is always observable.
 * @param {ReturnType<typeof optionsHarness>} h
 * @param {string} mode
 * @returns {void}
 */
function armMap(h, mode) {
  setMapMode(mode);
  h.state.settings.mapMode = mode;
  h.state.settings.minimap = mode !== 'off';
  h.settings.length = 0;
}

/**
 * Client y of a row, found by clicking down the panel until one writes `key`. The x fractions are
 * tried right to left because that is where the controls live; nothing about the panel's measured
 * geometry is assumed.
 * @param {ReturnType<typeof optionsHarness>} h
 * @param {string} key
 * @returns {number} client y, or −1
 */
function findRowY(h, key) {
  const m = h.surface.metrics;
  const toClientY = (uiY) => ((uiY + 0.5) * m.px * m.cssH) / m.devH;
  const toClientX = (uiX) => ((uiX + 0.5) * m.px * m.cssW) / m.devW;
  for (let uiY = 0; uiY < m.h; uiY++) {
    const clientY = toClientY(uiY);
    for (const frac of [0.8, 0.72, 0.62, 0.5]) {
      armMap(h, 'off');
      h.click(toClientX(Math.round(m.w * frac)), clientY);
      if (h.settings.some(([k]) => k === key)) return clientY;
      if (h.menus.screen() !== 'options') return -1; // walked onto Back: gone too far
    }
  }
  return -1;
}

test('options: clicking a word of the Map row writes THAT value, not the next one', () => {
  resetMapMode();
  const h = optionsHarness(1280, 720, 1);
  assert.equal(h.menus.screen(), 'options');
  const rowY = findRowY(h, 'mapMode');
  assert.ok(rowY > 0, 'the Map row is reachable by pointer at all');

  // Sweep the row and record what each x writes, always starting from 'off'. That is what makes
  // the answers distinguishable: a blind step of the cycle writes 'corner' from 'off' wherever it
  // is clicked, so a 'full' can only have come from hitting the word "Full".
  /** @type {Array<{x:number, value:string}>} */
  const hits = [];
  for (let clientX = 0; clientX < 1280; clientX += 4) {
    armMap(h, 'off');
    h.click(clientX, rowY);
    const wrote = h.settings.find(([k]) => k === 'mapMode');
    if (wrote !== undefined) hits.push({ x: clientX, value: String(wrote[1]) });
  }
  const seen = [...new Set(hits.map((hit) => hit.value))].join(',');
  assert.ok(hits.some((hit) => hit.value === 'off'), `some x writes 'off' (saw ${seen})`);
  assert.ok(hits.some((hit) => hit.value === 'corner'), `some x writes 'corner' (saw ${seen})`);
  assert.ok(hits.some((hit) => hit.value === 'full'), `some x writes 'full' (saw ${seen})`);

  // The words read Off · Corner · Full left to right and end at the value column, so their bands
  // end in that order. (The bare left of the row is the documented fallback — a click there means
  // "step the cycle" and writes 'corner' from 'off', which is why the *last* x of each value is
  // the one that identifies its word.)
  const lastX = (v) => {
    let x = -1;
    for (const hit of hits) if (hit.value === v) x = hit.x;
    return x;
  };
  assert.ok(lastX('off') < lastX('corner'), 'the Off word sits left of Corner');
  assert.ok(lastX('corner') < lastX('full'), 'the Corner word sits left of Full');

  // The two measured regressions, asserted directly: 'off' + click "Full" used to give 'corner',
  // and 'corner' + click "Corner" used to give 'full'.
  armMap(h, 'off');
  h.click(lastX('full'), rowY);
  assert.equal(h.settings.find(([k]) => k === 'mapMode')[1], 'full', "off + click Full → full");
  assert.equal(h.settings.find(([k]) => k === 'minimap')[1], true, 'the legacy mirror follows');

  armMap(h, 'corner');
  h.click(lastX('corner'), rowY);
  assert.equal(h.settings.find(([k]) => k === 'mapMode')[1], 'corner', 'corner + click Corner → corner');

  armMap(h, 'full');
  h.click(lastX('off'), rowY);
  assert.equal(h.settings.find(([k]) => k === 'mapMode')[1], 'off', 'full + click Off → off');
  assert.equal(h.settings.find(([k]) => k === 'minimap')[1], false);

  // And the fallback still works: the bare part of the row steps the cycle.
  armMap(h, 'off');
  h.click(hits[0].x, rowY);
  assert.equal(h.settings.find(([k]) => k === 'mapMode')[1], 'corner', 'a bare click steps the cycle');
  resetMapMode();
});

test('options: dragging a slider track quantises and clamps', () => {
  resetMapMode();
  const h = optionsHarness(1280, 720, 1);
  const m = h.surface.metrics;
  const rowY = findRowY(h, 'volume');
  assert.ok(rowY > 0, 'the Sound row is reachable by pointer');
  const startX = ((Math.round(m.w * 0.72) + 0.5) * m.px * m.cssW) / m.devW;

  // A press-drag-release across the whole width: every value quantised to the row's 0.1 step,
  // inside the 0‥1 range, and following the pointer.
  /** @type {number[]} */
  const seen = [];
  h.settings.length = 0;
  h.state.settings.volume = 0.5;
  assert.equal(
    h.menus.handlePointer({ type: 'pointerdown', clientX: startX, clientY: rowY }),
    true,
    'the press lands on the slider row',
  );
  for (let x = 1280; x >= 0; x -= 16) {
    h.menus.handlePointer({ type: 'pointermove', clientX: x, clientY: rowY });
  }
  for (let x = 0; x <= 1280; x += 16) {
    h.menus.handlePointer({ type: 'pointermove', clientX: x, clientY: rowY });
  }
  h.menus.handlePointer({ type: 'pointerup', clientX: 1280, clientY: rowY });
  for (const [key, value] of h.settings) {
    if (key !== 'volume') continue;
    assert.equal(typeof value, 'number');
    assert.ok(value >= 0 && value <= 1, `volume ${value} inside range`);
    assert.equal(Math.round(value * 10) / 10, value, `volume ${value} quantised`);
    seen.push(value);
  }
  assert.ok(seen.length >= 4, `the drag produced several values (${seen.join(',')})`);
  assert.equal(Math.min(...seen), 0, 'dragging off the left pins to the minimum');
  assert.equal(seen[seen.length - 1], 1, 'dragging past the right pins to the maximum');
  // A release outside the track must not leave the drag armed.
  h.settings.length = 0;
  h.menus.handlePointer({ type: 'pointermove', clientX: 40, clientY: rowY });
  assert.equal(h.settings.length, 0, 'the pointer no longer owns the slider after release');
  resetMapMode();
});

test('level complete: the tally can be skipped by pointer, not only by Enter', () => {
  /** @type {string[]} */
  const log = [];
  const canvas = liveCanvas(1280, 720);
  const menus = createMenus(canvas, {
    onNextLevel: () => log.push('nextLevel'),
    onQuit: () => log.push('quit'),
    onUiSound: (t) => log.push(`sfx:${t}`),
  });
  menus.resize(1280, 720, 1);
  const state = makeState('levelComplete');
  menus.render(state);
  assert.equal(menus.screen(), 'complete');
  // A quarter of a second in: the tally is still rolling, which is exactly when a player reaches
  // for the screen.
  state.time = 0.25;
  menus.render(state);

  const down = menus.handlePointer({ type: 'pointerdown', clientX: 640, clientY: 360 });
  const up = menus.handlePointer({ type: 'pointerup', clientX: 640, clientY: 360 });
  assert.equal(down, true, 'the panel accepts the press');
  assert.equal(up, true, 'and consumes the release');
  menus.render(state);

  // The tally is finished, so the NEXT confirm descends instead of skipping — the same two-step
  // contract the keyboard has.
  log.length = 0;
  menus.handleInput(press('confirm'), state);
  assert.deepEqual(
    log.filter((e) => e === 'nextLevel'),
    ['nextLevel'],
    'the click finished the tally, so confirm descends',
  );
});

test('the end panels fit inside the surface at every tested size', () => {
  // The level-complete panel used to be measured once and centred, so at 1280×720 it computed 362
  // UI pixels against a 360-pixel surface and its bottom frame fell off the screen. The fit is
  // asserted through the public surface: the panel's own hit rectangle (recorded while the tally
  // runs) must lie inside it.
  const sizes = [
    [1280, 720, 1],
    [1280, 620, 1],
    [1024, 768, 1],
    [390, 844, 3],
    [800, 480, 1],
  ];
  for (const [w, hgt, dpr] of sizes) {
    const canvas = liveCanvas(w, hgt);
    const menus = createMenus(canvas, {});
    menus.resize(w, hgt, dpr);
    const state = makeState('levelComplete');
    // The tally has to still be running (that is when the whole panel is the hit target), but the
    // entry slide has to be over, so the rectangle probed is the resting one.
    menus.render(state);
    state.time = 0.25;
    menus.render(state);
    state.time = 0.5;
    menus.render(state);
    const m = menus.surface.metrics;

    /**
     * @param {number} uiY
     * @returns {boolean} is the panel under the middle of this row of the surface?
     */
    const hitAt = (uiY) =>
      menus.handlePointer({
        type: 'pointermove',
        clientX: w / 2,
        clientY: ((uiY + 0.5) * m.px * hgt) / m.devH,
      });

    let top = -1;
    let bottom = -1;
    for (let uiY = 0; uiY < m.h; uiY++) {
      if (!hitAt(uiY)) continue;
      if (top < 0) top = uiY;
      bottom = uiY;
    }
    assert.ok(top >= 0, `${w}x${hgt}@${dpr}: the complete panel is on screen at all`);
    // The real assertion: there is surface left under the panel. An overflowing panel is clamped
    // to the top by `Math.max(2u, …)` and runs off the bottom, so its last hit row is the last row
    // of the surface — which is exactly what 1280×720 did before the panel was fitted.
    assert.ok(
      bottom < m.h - 1,
      `${w}x${hgt}@${dpr}: the panel's bottom (${bottom}) must sit inside the surface (${m.h})`,
    );
    assert.ok(top >= 1, `${w}x${hgt}@${dpr}: the panel's top (${top}) must sit inside the surface`);
  }
});

test('the Controls panel is reachable from the title and from pause', () => {
  const { menus, log } = harness();
  const title = makeState('title');
  menus.render(title);
  // Title rows: Descend, Shrine, Options, Controls, Credits.
  menus.handleInput(press('down'), title);
  menus.handleInput(press('down'), title);
  menus.handleInput(press('down'), title);
  menus.handleInput(press('confirm'), title);
  menus.render(title);
  assert.equal(menus.screen(), 'controls');
  assert.doesNotThrow(() => menus.render(title), 'the panel draws with the built-in hints');
  menus.handleInput(press('back'), title);
  menus.render(title);
  assert.equal(menus.screen(), 'title');

  // Pause rows: Resume, Options, Controls, Quit to Title.
  const paused = makeState('paused');
  paused.time = 1;
  menus.render(paused);
  menus.handleInput(press('down'), paused);
  menus.handleInput(press('down'), paused);
  log.length = 0;
  menus.handleInput(press('confirm'), paused);
  menus.render(paused);
  assert.equal(menus.screen(), 'controls');
  assert.equal(log.includes('resume'), false, 'opening Controls does not resume the run');
  menus.handleInput(press('back'), paused);
  menus.render(paused);
  assert.equal(menus.screen(), 'pause');
});

test('a caller-supplied control table is used, sanitised and never trusted blindly', () => {
  const menus = createMenus(null, {
    controls: /** @type {any} */ ([
      { label: 'Move', keys: 'W S / ↑ ↓' },
      { label: '', keys: 'dropped: no label' },
      null,
      { label: 'Junk', keys: 7 },
      { label: 'Map', keys: 'M' },
    ]),
  });
  const state = makeState('title');
  menus.render(state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  assert.doesNotThrow(() => menus.render(state));
  assert.equal(menus.screen(), 'controls');
  // And a table that is entirely unusable falls back to the built-in one rather than drawing an
  // empty panel.
  const empty = createMenus(null, { controls: /** @type {any} */ ([null, 3, {}]) });
  assert.doesNotThrow(() => empty.render(state));
});

test('reduced motion finishes the level-complete tally instead of rolling it', () => {
  const { menus, log } = harness();
  const state = makeState('levelComplete');
  state.settings.reducedMotion = true;
  menus.render(state);
  assert.equal(menus.screen(), 'complete');
  // No skip needed: the first confirm descends, because there is no animation to interrupt.
  menus.handleInput(press('confirm'), state);
  assert.deepEqual(log.filter((e) => e === 'nextLevel'), ['nextLevel']);
});

test('the loading screen size mirror matches the shipped curve', () => {
  // These are the numbers ARCHITECTURE.md §1 / balance.js LEVEL publish: the lean 10×10 first floor,
  // then 16 + 8 per depth, capped at 128 (depth 15). If balance.js moves, this test is the tripwire.
  assert.equal(cellsForLevel(1), 10);
  assert.equal(cellsForLevel(2), 24);
  assert.equal(cellsForLevel(8), 72);
  assert.equal(cellsForLevel(15), 128);
  assert.equal(cellsForLevel(30), 128, 'past the cap a level gets harder, not bigger');
  assert.equal(cellsForLevel(0), 10);
  assert.equal(cellsForLevel(NaN), 10);
});

test('NEW BEST is measured against the record the run started with, strictly', async () => {
  const { setLayoutProbe } = await import('./font.js');
  /**
   * Play a run through the menus' eyes and report the record line game over shows.
   * @param {number} startBest the stored best on the title screen
   * @param {Array<[string, number, number, number]>} steps [phase, level, score, best] per frame
   * @returns {string}
   */
  const recordLine = (startBest, steps) => {
    const menus = createMenus(liveCanvas(1280, 720), {});
    menus.resize(1280, 720, 1);
    const state = makeState('title');
    state.best.score = startBest;
    state.run.score = 0;
    menus.render(state);
    for (const [phase, level, score, best] of steps) {
      state.phase = phase;
      state.level = level;
      state.run.score = score;
      state.best.score = best;
      state.time += 1;
      menus.render(state);
    }
    /** @type {string[]} */
    const labels = [];
    setLayoutProbe((kind, _x, _y, _w, _h, _u, label) => {
      if (kind === 'text') labels.push(label);
    });
    try {
      state.time += 1;
      menus.render(state);
    } finally {
      setLayoutProbe(null);
    }
    return labels.includes('NEW BEST!') ? 'NEW BEST!' : labels.includes('BEST') ? 'BEST' : '?';
  };

  // Tying the record is not a new record (`recordBest` has already folded the run into `best`).
  assert.equal(recordLine(5000, [['loading', 1, 0, 5000], ['gameOver', 3, 5000, 5000]]), 'BEST');
  // Beating it is.
  assert.equal(recordLine(5000, [['loading', 1, 0, 5000], ['gameOver', 3, 5100, 5100]]), 'NEW BEST!');
  // A record set at an earlier level complete still counts at game over, even though the stored
  // best already equals the final score by then.
  assert.equal(
    recordLine(5000, [
      ['loading', 1, 0, 5000],
      ['levelComplete', 1, 6000, 6000],
      ['loading', 2, 6000, 6000],
      ['gameOver', 2, 6000, 6000],
    ]),
    'NEW BEST!',
  );
  // "Try Again" starts a new run from game over: the reference moves to the new record.
  assert.equal(
    recordLine(5000, [
      ['gameOver', 3, 6000, 6000],
      ['loading', 1, 0, 6000],
      ['gameOver', 1, 6000, 6000],
    ]),
    'BEST',
  );
});

test('the end screens survive a run with no optional stat fields', () => {
  const { menus } = harness();
  for (const phase of ['levelComplete', 'gameOver']) {
    const state = makeState(phase);
    assert.doesNotThrow(() => menus.render(state), `${phase} with no levelData`);
    // And with a maze and a fog grid, which is when the stat strip actually appears.
    const width = 33;
    state.levelData = {
      maze: {
        width,
        height: width,
        cols: 16,
        rows: 16,
        tiles: new Uint8Array(width * width),
        start: { x: 1, y: 1 },
        exit: { x: 31, y: 31 },
        seed: 1,
      },
      validation: {},
      items: [],
      torches: [],
      fuel: 110,
      par: 55,
    };
    state.explored = new Uint8Array(width * width);
    for (let i = 0; i < 300; i++) state.explored[i] = 1;
    assert.doesNotThrow(() => menus.render(state), `${phase} with a maze`);
    // Optional fields the integrator may add later must not break anything when they appear.
    state.run.refuels = 4;
    state.run.distance = 1240;
    assert.doesNotThrow(() => menus.render(state), `${phase} with refuels and distance`);
  }
});

// ─── Unlocks wave: Shrine and Boon (ARCHITECTURE.md §4.9) ────────────────────────────────────

const CATALOGUE = [
  { id: 'reservoir', name: 'Reservoir', group: 'torch', costs: [15, 30], blurb: 'A deeper tank.', ranks: ['Tank +10%', 'Tank +20%'] },
  { id: 'chalk', name: 'Chalk', group: 'fortune', costs: [10], blurb: 'Mark walls.', ranks: ['4 marks per floor'] },
  { id: 'magnet', name: 'Gem Magnet', group: 'fortune', costs: [15, 40], blurb: 'Pull gems.', ranks: ['Pull 1.2', 'Pull 1.6'] },
];

/** @param {string} phase @param {number} purse @param {Record<string, number>} ranks */
function unlockHarness(phase, purse, ranks) {
  const log = [];
  const menus = createMenus(null, {
    unlocks: CATALOGUE,
    onBuy: (id) => log.push(`buy:${id}`),
    onClaimBoon: (id) => log.push(`claim:${id}`),
    onNextLevel: () => log.push('nextLevel'),
    onUiSound: (t) => log.push(`sfx:${t}`),
  });
  const state = /** @type {any} */ (makeState(phase));
  state.progress = { purse, ranks, boonLevel: 0 };
  state.offer = { open: false, level: 0, ids: [] };
  return { menus, state, log };
}

test('shrine: reached from the title, buys what the purse can pay for, refuses the rest', () => {
  const { menus, state, log } = unlockHarness('title', 20, { chalk: 1 });
  menus.render(state);
  menus.handleInput(press('down'), state); // Shrine
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  assert.equal(menus.screen(), 'shrine');
  menus.handleInput(press('confirm'), state); // Reservoir, 15 of 20
  assert.deepEqual(log.filter((e) => e.startsWith('buy')), ['buy:reservoir']);
  log.length = 0;
  menus.handleInput(press('down'), state); // Chalk, already maxed
  menus.handleInput(press('confirm'), state);
  menus.handleInput(press('down'), state); // Magnet, 15 — but pretend the purse is spent
  state.progress.purse = 5;
  menus.handleInput(press('confirm'), state);
  assert.equal(log.some((e) => e.startsWith('buy')), false, 'maxed and unaffordable rows never buy');
  assert.equal(log.filter((e) => e === 'sfx:uiDeny').length, 2);
  menus.handleInput(press('back'), state);
  menus.render(state);
  assert.equal(menus.screen(), 'title');
});

test('shrine: open from level complete and game over too', () => {
  for (const [phase, base] of [['levelComplete', 'complete'], ['gameOver', 'gameover']]) {
    const { menus, state } = unlockHarness(phase, 0, {});
    state.settings.reducedMotion = true; // no tally to skip
    menus.render(state);
    menus.handleInput(press('down'), state);
    menus.handleInput(press('confirm'), state);
    menus.render(state);
    assert.equal(menus.screen(), 'shrine', `from ${phase}`);
    menus.handleInput(press('back'), state);
    menus.render(state);
    assert.equal(menus.screen(), base);
  }
});

test('boon: opens itself after the tally, claims the chosen card, and Descend never skips it', () => {
  const { menus, state, log } = unlockHarness('levelComplete', 0, {});
  state.offer = { open: true, level: 3, ids: ['reservoir', 'chalk', 'magnet'] };
  menus.render(state);
  menus.handleInput(press('confirm'), state); // skip the tally
  menus.render(state);
  assert.equal(menus.screen(), 'boon', 'the boon opens itself');
  menus.handleInput(press('back'), state); // Decide Later
  menus.render(state);
  assert.equal(menus.screen(), 'complete');
  // First row is now "Choose a Boon"; Descend (second row) shows the boon instead of forfeiting it.
  menus.handleInput(press('down'), state);
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  assert.equal(log.includes('nextLevel'), false);
  assert.equal(menus.screen(), 'boon');
  menus.handleInput(press('right'), state);
  menus.handleInput(press('confirm'), state);
  assert.deepEqual(log.filter((e) => e.startsWith('claim')), ['claim:chalk']);
  state.offer.open = false;
  menus.render(state);
  assert.equal(menus.screen(), 'complete');
  menus.handleInput(press('confirm'), state);
  assert.ok(log.includes('nextLevel'), 'with the boon claimed, Descend descends');
});
