// @ts-check
/**
 * @file Unit tests for src/ui/menus.js — the navigation state machine, pointer hit-testing maths,
 * slider quantisation, and the callback contract with `src/main.js`.
 * Run: `node src/ui/menus.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cellsForLevel, createMenus, hitTest, menuStep, sliderValueAt } from './menus.js';
import { resetMapMode } from './map.js';

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
  return { moveX: 0, moveY: 0, turn: 0, lookDX: 0, sprint: false, pressed: new Set([action]) };
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

  // Down to Options, confirm, and back out again.
  assert.equal(menus.handleInput(press('down'), state), true);
  assert.ok(log.includes('sfx:uiMove'));
  menus.handleInput(press('confirm'), state);
  menus.render(state);
  assert.equal(menus.screen(), 'options');
  assert.equal(menus.handleInput(press('back'), state), true);
  assert.ok(log.includes('sfx:uiBack'));
  menus.render(state);
  assert.equal(menus.screen(), 'title', 'and the title list remembers where it was');

  // Up from Options to Descend, then up again wraps round to Credits.
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
  menus.handleInput(press('down'), state);
  menus.handleInput(press('down'), state); // Quit to Title
  menus.handleInput(press('confirm'), state);
  assert.ok(log.includes('quit'));

  log.length = 0;
  assert.equal(menus.handleInput(press('back'), state), true);
  assert.ok(log.includes('resume'), 'Esc on the pause screen resumes');
});

test('options: arrows adjust settings without mutating state', () => {
  const { menus, log, settings } = harness();
  const state = makeState('title');
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

test('options: the sensitivity slider stays inside its own range', () => {
  const { menus, settings } = harness();
  const state = makeState('title');
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
  menus.handleInput(press('confirm'), state);
  assert.ok(log.includes('quit'));
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
  menus.handleInput(press('confirm'), state);
  assert.ok(log.includes('quit'));
});

test('a phase change closes any open sub-screen', () => {
  const { menus } = harness();
  const title = makeState('title');
  menus.render(title);
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

test('the loading screen size mirror matches the shipped curve', () => {
  // These are the numbers ARCHITECTURE.md §6 / balance.js LEVEL publish: 16 + 8 per depth, capped
  // at 128 (depth 15). If balance.js moves, this test is the tripwire.
  assert.equal(cellsForLevel(1), 16);
  assert.equal(cellsForLevel(2), 24);
  assert.equal(cellsForLevel(8), 72);
  assert.equal(cellsForLevel(15), 128);
  assert.equal(cellsForLevel(30), 128, 'past the cap a level gets harder, not bigger');
  assert.equal(cellsForLevel(0), 16);
  assert.equal(cellsForLevel(NaN), 16);
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
