// @ts-check
/**
 * @file Every documented `?screen=` value of the preview harness really lands on that screen.
 *
 * This is the check that was missing when `?screen=options` and `?screen=credits` both ended on the
 * loading screen: the harness walked the title list, the walk was overwritten by the menus' own row
 * memory, and it eventually confirmed row 0 — *Descend* — and started a run. Nothing threw, so the
 * screenshots were simply of the wrong screen.
 *
 * Run: `node src/ui/preview-nav.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { drawableCanvas, installFakeDocument, UNLOCK_FIXTURE } from './layout-audit.test-util.mjs';
import { PREVIEW_SCREENS, reachScreen } from './preview-nav.js';

installFakeDocument();

const { createMenus } = await import('./menus.js');

/** One reusable input frame, as `src/input` hands them over (§4.3). */
const frame = { moveX: 0, moveY: 0, turn: 0, lookDX: 0, pressed: new Set() };

/**
 * @param {string} action
 * @returns {any}
 */
function frameWith(action) {
  frame.pressed.clear();
  frame.pressed.add(action);
  return frame;
}

/**
 * A state shaped like the preview's: a cleared depth, a purse, and a boon waiting.
 * @returns {any}
 */
function previewState() {
  return {
    phase: 'playing',
    time: 0,
    phaseTime: 0,
    level: 3,
    seed: 1,
    levelData: null,
    player: { x: 1.5, y: 1.5, angle: 0, px: 1.5, py: 1.5, pangle: 0, vx: 0, vy: 0, bob: 0, bobAmp: 0, shake: 0 },
    explored: null,
    run: { score: 4820, gems: 7, gemsTotal: 12, fuel: 78, fuelMax: 120, levelTime: 97, totalTime: 320, levelScore: 3840, bestCombo: 3, refuels: 4, distance: 1240, mapFound: true },
    best: { score: 12750, level: 6 },
    settings: {
      volume: 0.8,
      music: 0.55,
      sensitivity: 1,
      scanlines: true,
      minimap: true,
      mapMode: 'corner',
      reducedMotion: false,
      invertLook: false,
      autoExplore: false,
      fullscreen: true,
    },
    derived: { exitDist: 14, nearExit: 0.2, lowFuel: false },
    events: [],
    progress: { purse: 140, ranks: { reservoir: 2, chalk: 3 }, boonLevel: 0 },
    offer: { open: true, level: 3, ids: ['whisper', 'appraiser', 'ember'] },
  };
}

test('every ?screen= value the preview documents reaches that screen, at desktop and phone sizes', () => {
  for (const vp of [
    { w: 1280, h: 720, dpr: 1, name: '1280x720' },
    { w: 390, h: 844, dpr: 2, name: '390x844@2' },
  ]) {
    for (const name of Object.keys(PREVIEW_SCREENS)) {
      const menus = createMenus(drawableCanvas(vp.w, vp.h), { unlocks: UNLOCK_FIXTURE });
      menus.resize(vp.w, vp.h, vp.dpr);
      const state = previewState();
      const reached = reachScreen(menus, state, name, frameWith);
      const want = /** @type {any} */ (PREVIEW_SCREENS)[name];
      assert.equal(reached, want, `${vp.name}: ?screen=${name}`);
      // And the walk must not have started a run on the way (row 0 of the title is Descend).
      if (name !== 'loading') assert.notEqual(state.phase, 'loading', `${vp.name}: ?screen=${name} started a run`);
      // The screen is still there on the next frame, not one frame of it.
      menus.render(state);
      assert.equal(menus.screen(), want, `${vp.name}: ?screen=${name} is stable`);
    }
  }
});

test('a title with a saved run is walked just as safely (Continue is row 0 there)', () => {
  for (const name of ['options', 'controls', 'credits', 'shrine']) {
    let continued = false;
    const menus = createMenus(drawableCanvas(1280, 720), {
      unlocks: UNLOCK_FIXTURE,
      savedRun: () => ({ level: 7, score: 9000 }),
      onContinue: () => {
        continued = true;
      },
      onNewGame: () => {
        continued = true;
      },
    });
    menus.resize(1280, 720, 1);
    const state = previewState();
    const reached = reachScreen(menus, state, name, frameWith);
    assert.equal(reached, name, `?screen=${name} with a saved run`);
    assert.equal(continued, false, `?screen=${name} never picks up the run on the way`);
  }
});
