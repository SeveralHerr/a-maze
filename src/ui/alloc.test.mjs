// @ts-check
/**
 * @file Allocation regression test for the overlay's per-frame path.
 *
 * The HUD and every menu screen re-render every frame. A critic measured 1.4–2.2 kB of garbage per
 * frame here — a `{font, size, color}` literal handed to every text call, and a colour memo that built
 * its key string on every lookup — and no test noticed. This one renders thousands of frames of every
 * HUD mode and every menu screen through the real code, with a fake `document` so the glyph atlases
 * and the map raster exist and every glyph blit runs, and measures **bytes allocated per frame** with
 * V8's sampling heap profiler, counting objects the young-generation collector has already freed.
 * (Heap growth alone cannot see garbage: it is gone by the time the heap is measured.)
 *
 * Measured after the fix (Node 24, this file): 0–113 B per frame across every HUD mode and menu
 * screen at 1280×720 and 390×844 — the odd boxed number where a fractional value crosses a call V8
 * does not inline. The budget below is comfortably above that and far below the option-literal
 * pattern it guards against; the last test proves the measurement can see that pattern (~970 B).
 * Run: `node src/ui/alloc.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { drawableCanvas, installFakeDocument, playingState, UNLOCK_FIXTURE } from './layout-audit.test-util.mjs';

installFakeDocument();

const { createHud } = await import('./hud.js');
const { createMenus } = await import('./menus.js');
const { resetMapMode, setMapMode } = await import('./map.js');

/** Bytes a frame may allocate. The regression this guards against allocated 1 400–2 200. */
const BUDGET_BYTES_PER_FRAME = 256;

/** Frames sampled per case. */
const FRAMES = 3000;

/** Frames run first, so the profile measures optimised code rather than the interpreter. */
const WARM_FRAMES = 6000;

/** @type {any} */
let session = null;
try {
  const inspector = await import('node:inspector/promises');
  session = new inspector.Session();
  session.connect();
  await session.post('HeapProfiler.enable');
} catch {
  session = null;
}

/**
 * Bytes allocated per frame by `frame`, from a sampling heap profile that includes objects already
 * collected by the minor and major GCs.
 * @param {() => void} frame
 * @returns {Promise<number>}
 */
async function bytesPerFrame(frame) {
  for (let i = 0; i < WARM_FRAMES; i++) frame();
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 32,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < FRAMES; i++) frame();
  const { profile } = await session.post('HeapProfiler.stopSampling');
  let total = 0;
  /**
   * Only allocations made **by the frame** count: samples in a `src/ui` or `src/core` frame (this
   * file's frame closures included — V8 may inline overlay code into them), and in a builtin (no
   * URL — `Math.max`, a boxed number) called directly from one. That leaves out the profiler's
   * plumbing: stopping the sampler serialises the profile while sampling is still on, a per-case
   * constant that would otherwise be charged to the frames.
   * @param {any} node
   * @param {boolean} parentIsUi
   */
  const walk = (node, parentIsUi) => {
    const url = String(node.callFrame.url);
    const isUi = /\/src\/(ui|core)\/[^/]+\.m?js$/.test(url) && node.callFrame.functionName !== 'bytesPerFrame';
    const inUi = isUi || (parentIsUi && url === '');
    if (inUi) {
      total += node.selfSize;
      if (process.env.ALLOC_TRACE && node.selfSize > 0) {
        const where = `${node.callFrame.functionName} ${url.split('/').pop()}:${node.callFrame.lineNumber + 1}`;
        console.log(`    ${(node.selfSize / FRAMES).toFixed(1)} B/frame  ${where}`);
      }
    }
    for (const child of node.children) walk(child, isUi);
  };
  walk(profile.head, false);
  return total / FRAMES;
}

const skip = session === null ? 'node:inspector is unavailable' : false;

test('the HUD stays inside the per-frame allocation budget in every map mode, locked or not', { skip }, async () => {
  for (const [w, h, dpr] of [[1280, 720, 1], [390, 844, 3]]) {
    // One HUD per page, as in the game: the mode changes through the settings, not by building a
    // new HUD (a dozen instances sharing one module is a different optimisation profile from the
    // one the shipped page runs).
    resetMapMode();
    const hud = createHud(drawableCanvas(w, h));
    hud.resize(w, h, dpr);
    const state = playingState();
    // A low tank, so the alarm pulse, the flicker and the LOW chip animate every frame too.
    state.run.fuel = 20;
    for (const mode of /** @type {const} */ (['off', 'corner', 'full'])) {
      setMapMode(mode);
      state.settings.mapMode = mode;
      state.settings.minimap = mode !== 'off';
      const bytes = await bytesPerFrame(() => {
        state.time += 1 / 60;
        hud.render(state, null, 0);
      });
      assert.equal(hud.mapMode(state.settings), mode);
      assert.ok(
        bytes <= BUDGET_BYTES_PER_FRAME,
        `hud ${mode} ${w}x${h}: ${bytes.toFixed(1)} B allocated per frame (budget ${BUDGET_BYTES_PER_FRAME})`,
      );
    }

    // The hidden map scroll (§4.8), on the same HUD — see the note above about one instance.
    for (const mode of /** @type {const} */ (['corner', 'full'])) {
      setMapMode(mode);
      state.settings.mapMode = mode;
      state.settings.minimap = true;

      // Locked, with the "no map" notice kept up by pressing the map key about once a second —
      // far more often than a player would, so fade-ins are a fifth of the measured frames.
      state.run.mapFound = false;
      let frame = 0;
      const locked = await bytesPerFrame(() => {
        state.time += 1 / 60;
        if ((frame++ & 63) === 0) hud.notice('NO MAP - FIND THE SCROLL');
        hud.render(state, null, 0);
      });
      assert.ok(hud.mapLocked(state));
      assert.ok(
        locked <= BUDGET_BYTES_PER_FRAME,
        `hud locked ${mode} ${w}x${h}: ${locked.toFixed(1)} B allocated per frame (budget ${BUDGET_BYTES_PER_FRAME})`,
      );

      // A pathological case: the scroll "found" again every ~1 s — the gothic banner raised and
      // fading in, the map's one-off catch-up scan and the lock/unlock layout switch, over and
      // over. (It happens once per level in the real game.)
      frame = 0;
      const found = await bytesPerFrame(() => {
        state.time += 1 / 60;
        state.run.mapFound = (frame++ & 63) >= 32;
        hud.render(state, null, 0);
      });
      assert.ok(
        found <= BUDGET_BYTES_PER_FRAME,
        `hud map-found ${mode} ${w}x${h}: ${found.toFixed(1)} B allocated per frame (budget ${BUDGET_BYTES_PER_FRAME})`,
      );
    }
    state.run.mapFound = true;
  }
});

test('every menu screen stays inside the per-frame allocation budget', { skip }, async () => {
  const cases = [
    ['title', 'title', []],
    ['title', 'options', ['down', 'down', 'confirm']],
    ['title', 'controls', ['back', 'down', 'confirm']],
    ['title', 'credits', ['back', 'down', 'confirm']],
    ['paused', 'pause', []],
    ['paused', 'confirm', ['up', 'confirm']],
    ['loading', 'loading', []],
    ['levelComplete', 'complete', ['confirm']],
    ['gameOver', 'gameover', []],
  ];
  for (const [w, h, dpr] of [[1280, 720, 1], [390, 844, 3]]) {
    const menus = createMenus(drawableCanvas(w, h), {});
    menus.resize(w, h, dpr);
    const state = playingState('title');
    for (const [phase, screen, keys] of cases) {
      state.phase = phase;
      state.time += 1;
      menus.render(state);
      for (const key of /** @type {string[]} */ (keys)) {
        menus.handleInput(/** @type {any} */ ({ pressed: new Set([key]) }), state);
        menus.render(state);
      }
      // Past the entry fade and, on level complete, the finished tally's last roll.
      for (let i = 0; i < 240; i++) {
        state.time += 1 / 60;
        menus.render(state);
      }
      assert.equal(menus.screen(), screen);
      const bytes = await bytesPerFrame(() => {
        state.time += 1 / 60;
        menus.render(state);
      });
      assert.ok(
        bytes <= BUDGET_BYTES_PER_FRAME,
        `menus ${screen} ${w}x${h}: ${bytes.toFixed(1)} B allocated per frame (budget ${BUDGET_BYTES_PER_FRAME})`,
      );
    }
  }
});

test('the Shrine and the Boon stay inside the budget too (the busiest screens there are)', { skip }, async () => {
  // Both lay out a catalogue every frame — wrapped prose, fitted columns, pips — which is exactly
  // the kind of screen a per-frame `wrapText` or a fresh options literal hides in.
  for (const [w, h, dpr] of [[1280, 720, 1], [390, 844, 3]]) {
    for (const screen of ['shrine', 'boon']) {
      const menus = createMenus(drawableCanvas(w, h), { unlocks: UNLOCK_FIXTURE });
      menus.resize(w, h, dpr);
      const state = /** @type {any} */ (playingState(screen === 'boon' ? 'levelComplete' : 'title'));
      state.progress = { purse: 140, ranks: { reservoir: 2, chalk: 1 }, boonLevel: 0 };
      state.offer =
        screen === 'boon'
          ? { open: true, level: 15, ids: ['whisper', 'appraiser', 'ember'] }
          : { open: false, level: 0, ids: [] };
      menus.render(state);
      if (screen === 'shrine') {
        menus.handleInput(/** @type {any} */ ({ pressed: new Set(['down']) }), state);
        menus.handleInput(/** @type {any} */ ({ pressed: new Set(['confirm']) }), state);
      } else {
        menus.handleInput(/** @type {any} */ ({ pressed: new Set(['confirm']) }), state); // skip the tally
      }
      // Past the entry fade, the tally and (for the boon) the hold before the cards open themselves.
      for (let i = 0; i < 60 * 6; i++) {
        state.time += 1 / 60;
        menus.render(state);
      }
      assert.equal(menus.screen(), screen, `${w}x${h}: reached ${screen}`);
      const bytes = await bytesPerFrame(() => {
        state.time += 1 / 60;
        menus.render(state);
      });
      assert.ok(
        bytes <= BUDGET_BYTES_PER_FRAME,
        `menus ${screen} ${w}x${h}: ${bytes.toFixed(1)} B allocated per frame (budget ${BUDGET_BYTES_PER_FRAME})`,
      );
    }
  }
});

test('the budget is meaningful: a frame that builds an options literal per text call exceeds it', { skip }, async () => {
  // The negative control. Twenty `{font, size, color, align}` objects a frame — the pattern the
  // overlay used to have — must fail the same measurement the real frames pass.
  // The objects have to be made *inside* overlay code to be measured the way the old pattern was:
  // `measureText` returns a fresh `{width, height, lines}` per call, so twenty kept results a frame
  // stand in for twenty options literals.
  const { measureText } = await import('./font.js');
  /** @type {any[]} */
  const kept = [null, null, null, null];
  const bytes = await bytesPerFrame(() => {
    for (let i = 0; i < 20; i++) kept[i & 3] = measureText('4,820', { font: 'hud', size: 1 + (i % 3) });
  });
  assert.ok(kept[0] !== null);
  assert.ok(bytes > BUDGET_BYTES_PER_FRAME, `the control allocated ${bytes.toFixed(1)} B per frame`);
});
