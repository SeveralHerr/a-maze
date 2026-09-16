// @ts-check
/**
 * @file Unit tests for src/ui/hud.js — the surface's pixel maths, pointer mapping, the sprite
 * compiler, and graceful behaviour with no DOM at all.
 * Run: `node src/ui/hud.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ICON_SIZE,
  MAP_FOUND_TEXT,
  compileArt,
  createHud,
  createSurface,
  fitScale,
  mapPointer,
  withAlpha,
} from './hud.js';
import { clearFontCache } from './font.js';
import { countExplored } from './map.js';
import { collectLayout, installFakeDocument } from './layout-audit.test-util.mjs';

/**
 * A minimal stand-in for a canvas element: enough for the surface to size itself, with no 2-D
 * context (`getContext` returns null), which is exactly the degraded case the UI must survive.
 * @param {number} cssW
 * @param {number} cssH
 * @returns {any}
 */
function fakeCanvas(cssW, cssH) {
  return {
    width: 0,
    height: 0,
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssW, height: cssH }),
  };
}

test('surface sizes itself to device pixels with an integer scale', () => {
  const surface = createSurface(fakeCanvas(1280, 720));
  assert.equal(surface.resize(1280, 720, 1), true);
  const m = surface.metrics;
  assert.equal(m.devW, 1280);
  assert.equal(m.devH, 720);
  assert.equal(Number.isInteger(m.px), true);
  assert.ok(m.px >= 1);
  assert.equal(m.w, Math.floor(m.devW / m.px));
  assert.equal(m.h, Math.floor(m.devH / m.px));
  // Every UI pixel is a whole number of device pixels, and the leftover is split as a margin.
  assert.ok(m.originX >= 0 && m.originX < m.px);
  assert.ok(m.originY >= 0 && m.originY < m.px);
  assert.equal(m.w * m.px + m.originX * 2 <= m.devW + 1, true);
  assert.equal(surface.canvas.width, 1280, 'the backing store follows the device size');
});

test('surface keeps the UI a constant fraction of the screen from phone to desktop', () => {
  const sizes = [
    [360, 640, 1],
    [390, 844, 3],
    [768, 1024, 2],
    [1280, 720, 1],
    [1920, 1080, 1],
    [2560, 1440, 1],
    [1440, 900, 2],
  ];
  for (const [w, h, dpr] of sizes) {
    const surface = createSurface(fakeCanvas(w, h));
    surface.resize(w, h, dpr);
    const m = surface.metrics;
    assert.ok(m.u >= 1 && m.u <= 6, `${w}x${h}@${dpr}: u=${m.u}`);
    // One line of HUD text (7 font pixels tall) as a fraction of the screen height.
    const textFraction = (7 * m.u * m.px) / m.devH;
    assert.ok(
      textFraction > 0.02 && textFraction < 0.075,
      `${w}x${h}@${dpr}: HUD text is ${(textFraction * 100).toFixed(1)}% of the height`,
    );
    // The backing store stays inside the budget whatever the device pixel ratio claims.
    assert.ok(m.devW * m.devH <= 4.3e6, `${w}x${h}@${dpr}: ${m.devW * m.devH} device pixels`);
    // A phone in portrait must take the stacked layouts; a desktop must not.
    if (w <= 400) assert.equal(m.narrow, true, `${w}x${h} should be narrow`);
    if (w >= 1280) assert.equal(m.narrow, false, `${w}x${h} should not be narrow`);
  }
});

test('surface ignores degenerate sizes', () => {
  const surface = createSurface(fakeCanvas(800, 600));
  surface.resize(800, 600, 1);
  const before = surface.metrics.w;
  assert.equal(surface.resize(0, 600, 1), false);
  assert.equal(surface.resize(800, 0, 1), false);
  assert.equal(surface.resize(NaN, NaN, 1), false);
  assert.equal(surface.metrics.w, before, 'a bad resize leaves the metrics alone');
});

test('surfaces are shared per canvas element', () => {
  const canvas = fakeCanvas(640, 480);
  assert.equal(createSurface(canvas), createSurface(canvas), 'hud and menus must agree');
  assert.notEqual(createSurface(fakeCanvas(1, 1)), createSurface(fakeCanvas(1, 1)));
  const inert = createSurface(null);
  assert.equal(inert.ctx, null);
  assert.equal(inert.beginFrame(), null, 'a DOM-less surface draws nothing and throws nothing');
});

test('mapPointer converts client coordinates into UI pixels', () => {
  const m = {
    cssW: 640,
    cssH: 360,
    devW: 1280,
    devH: 720,
    px: 2,
    w: 640,
    h: 360,
    originX: 0,
    originY: 0,
    u: 2,
    narrow: false,
    viewX: 0,
    viewY: 0,
    viewW: 640,
    viewH: 360,
  };
  const out = new Float64Array(2);

  // The canvas is displayed at 640×360 CSS px with a 1280×720 backing store scaled by 2 → the UI
  // grid is exactly the CSS grid here.
  assert.equal(mapPointer(m, 0, 0, 640, 360, 0, 0, out), true);
  assert.deepEqual([out[0], out[1]], [0, 0]);

  mapPointer(m, 0, 0, 640, 360, 320, 180, out);
  assert.deepEqual([out[0], out[1]], [320, 180], 'centre maps to centre');

  // An element offset in the page, and stretched to twice its backing size.
  mapPointer(m, 100, 50, 1280, 720, 100 + 640, 50 + 360, out);
  assert.deepEqual([out[0], out[1]], [320, 180], 'stretch and offset are both undone');

  // Outside the surface reports false but still returns usable coordinates for drag handling.
  assert.equal(mapPointer(m, 0, 0, 640, 360, -10, 5, out), false);
  assert.equal(out[0], -10);
  assert.equal(mapPointer(m, 0, 0, 640, 360, 640, 180, out), false, 'the right edge is exclusive');
  assert.equal(mapPointer(m, 0, 0, 0, 0, 10, 10, out), false, 'an unlaid-out element maps nothing');
});

test('mapPointer accounts for the letterbox margin', () => {
  const m = {
    cssW: 500,
    cssH: 300,
    devW: 500,
    devH: 300,
    px: 3,
    w: 166,
    h: 100,
    originX: 1,
    originY: 0,
    u: 1,
    narrow: true,
    viewX: 0,
    viewY: 0,
    viewW: 166,
    viewH: 100,
  };
  const out = new Float64Array(2);
  mapPointer(m, 0, 0, 500, 300, 1, 0, out);
  assert.deepEqual([out[0], out[1]], [0, 0], 'the margin is not part of the UI grid');
  mapPointer(m, 0, 0, 500, 300, 4, 3, out);
  assert.deepEqual([out[0], out[1]], [1, 1]);
});

test('compileArt parses indexed pixel rows', () => {
  const art = compileArt(['012', '340'], 'test');
  assert.equal(art.w, 3);
  assert.equal(art.h, 2);
  assert.deepEqual(Array.from(art.data), [0, 1, 2, 3, 4, 0]);
  // A ragged row is padded rather than throwing.
  const ragged = compileArt(['11', '1'], 'ragged');
  assert.equal(ragged.w, 2);
  assert.deepEqual(Array.from(ragged.data), [1, 1, 1, 0]);
});

test('icon sizes are sane and the art tables compiled', () => {
  assert.ok(ICON_SIZE.flameW >= 5 && ICON_SIZE.flameW <= 16);
  assert.ok(ICON_SIZE.torchH > ICON_SIZE.flameH);
  assert.ok(ICON_SIZE.gem >= 5);
  assert.ok(ICON_SIZE.arrow >= 5);
});

test('withAlpha memoises and clamps', () => {
  assert.equal(withAlpha('#ff8800', 1), '#ff8800', 'opaque passes the hex through');
  assert.equal(withAlpha('#ff8800', 0.5), 'rgba(255,136,0,0.5)');
  assert.equal(withAlpha('#ff8800', -1), 'rgba(255,136,0,0)');
  assert.equal(withAlpha('#ff8800', 2), '#ff8800');
  assert.equal(withAlpha('#ff8800', 0.5), withAlpha('#ff8800', 0.5), 'stable across calls');
  // Alpha is quantised, so a fade cannot fill the cache with a new string every frame.
  assert.equal(withAlpha('#ff8800', 0.5001), withAlpha('#ff8800', 0.5));
});

test('fitScale picks the largest integer scale that fits', () => {
  const opts = { font: /** @type {const} */ ('hud') };
  // "AB" is 11 font pixels wide (5 + 1 + 5).
  assert.equal(fitScale('AB', 11, opts, 8), 1);
  assert.equal(fitScale('AB', 22, opts, 8), 2);
  assert.equal(fitScale('AB', 21, opts, 8), 1);
  assert.equal(fitScale('AB', 1000, opts, 4), 4, 'never exceeds the requested maximum');
  assert.equal(fitScale('AB', 1, opts, 8), 1, 'never returns zero');
  assert.equal(fitScale('AB', 1, opts, 8, 3), 3, 'honours the floor');
  assert.equal(fitScale('', 100, opts, 5), 5, 'an empty string always fits');
});

test('createHud is inert but safe without a DOM', () => {
  const hud = createHud(null);
  assert.equal(typeof hud.render, 'function');
  assert.doesNotThrow(() => hud.resize(1280, 720, 1));
  const state = {
    phase: 'playing',
    time: 1,
    phaseTime: 1,
    level: 3,
    seed: 1,
    levelData: null,
    player: { x: 1.5, y: 1.5, angle: 0, px: 1.5, py: 1.5, pangle: 0, vx: 0, vy: 0, bob: 0, bobAmp: 0, shake: 0 },
    explored: null,
    run: { score: 100, gems: 1, gemsTotal: 4, fuel: 30, fuelMax: 60, levelTime: 5, totalTime: 5, levelScore: 0, bestCombo: 0 },
    best: { score: 0, level: 0 },
    settings: { volume: 1, music: 1, sensitivity: 1, scanlines: true, minimap: true, reducedMotion: false, invertLook: false },
    derived: { exitDist: 5, nearExit: 0, lowFuel: false },
    events: [],
  };
  assert.doesNotThrow(() => hud.render(/** @type {any} */ (state), null, 0));
  assert.doesNotThrow(() => hud.render(/** @type {any} */ (null), null, 0));
  assert.doesNotThrow(() => hud.pop(100, 'gem'));
  assert.doesNotThrow(() => hud.reset());
  assert.doesNotThrow(() => hud.dispose());
});

// ─── Recording context: the layout code actually runs ─────────────────────────────────────────

/**
 * A 2-D context that records every fill it is asked for. Glyph blits no-op in Node (the font
 * atlas needs a canvas), but every layout calculation, panel, bar segment and marker runs for
 * real — which is what makes this a regression test for the gauge and the map plumbing rather
 * than a smoke test.
 * @returns {any}
 */
function recordingCtx() {
  const calls = { fills: 0, draws: 0, transforms: 0, clears: 0, rects: [] };
  return {
    calls,
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    fillStyle: '#000',
    setTransform: () => {
      calls.transforms++;
    },
    clearRect: () => {
      calls.clears++;
    },
    fillRect: (x, y, w, h) => {
      calls.fills++;
      if (calls.rects.length < 4096) calls.rects.push([x, y, w, h]);
    },
    drawImage: () => {
      calls.draws++;
    },
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    rect: () => {},
    clip: () => {},
  };
}

/**
 * A canvas whose context records.
 * @param {number} cssW
 * @param {number} cssH
 * @returns {any}
 */
function drawableCanvas(cssW, cssH) {
  const ctx = recordingCtx();
  return {
    width: 0,
    height: 0,
    __ctx: ctx,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssW, height: cssH }),
  };
}

/**
 * A playable state over a small thick-wall maze.
 * @param {object} [over] fields to merge into `run`
 * @returns {any}
 */
function playingState(over) {
  const cols = 16;
  const width = cols * 2 + 1;
  const tiles = new Uint8Array(width * width).fill(1);
  for (let cy = 0; cy < cols; cy++) {
    for (let cx = 0; cx < cols; cx++) tiles[(cy * 2 + 1) * width + cx * 2 + 1] = 0;
  }
  const explored = new Uint8Array(width * width);
  for (let i = 0; i < 200; i++) explored[i] = 1;
  return {
    phase: 'playing',
    time: 3,
    phaseTime: 3,
    level: 4,
    seed: 1,
    levelData: {
      maze: {
        width,
        height: width,
        cols,
        rows: cols,
        tiles,
        start: { x: 1, y: 1 },
        exit: { x: width - 2, y: width - 2 },
        seed: 1,
      },
      validation: {},
      items: [],
      torches: [],
      fuel: 110,
      par: 55,
    },
    player: { x: 1.5, y: 1.5, angle: 0.3, px: 1.5, py: 1.5, pangle: 0.3, vx: 0, vy: 0, bob: 0, bobAmp: 0, shake: 0 },
    explored,
    run: Object.assign(
      { score: 4200, gems: 6, gemsTotal: 12, fuel: 60, fuelMax: 110, levelTime: 42, totalTime: 90, levelScore: 0, bestCombo: 2 },
      over,
    ),
    best: { score: 9000, level: 5 },
    settings: { volume: 1, music: 1, sensitivity: 1, scanlines: true, minimap: true, reducedMotion: false, invertLook: false },
    derived: { exitDist: 37.2, nearExit: 0, lowFuel: false },
    events: [],
  };
}

test('the HUD draws the tank, and the depth panel without a map', () => {
  const canvas = drawableCanvas(1280, 720);
  const hud = createHud(canvas, { map: 'off' });
  hud.resize(1280, 720, 1);
  const state = playingState();
  hud.render(state, null, 0);
  const calls = canvas.__ctx.calls;
  assert.ok(calls.clears >= 1, 'the overlay frame is cleared');
  assert.ok(calls.fills > 40, `the HUD drew something substantial (${calls.fills} fills)`);
  assert.equal(calls.draws, 0, 'no map means no blit');
});

test('a refill flares the gauge and counts as a refuel', () => {
  const canvas = drawableCanvas(1280, 720);
  const hud = createHud(canvas, { map: 'off' });
  hud.resize(1280, 720, 1);
  const state = playingState({ fuel: 40 });
  hud.render(state, null, 0);
  const quiet = canvas.__ctx.calls.fills;

  // A flask lands: the bar surges and the panel edge flares, so the frame after a pickup must be
  // visibly busier than the frame before it.
  state.time += 0.016;
  state.run.fuel = 78;
  hud.render(state, null, 0);
  assert.ok(canvas.__ctx.calls.fills - quiet > 0, 'the refill frame drew more, not less');
  // The pop carries the gained fuel, so the HUD must not have been reset by it.
  assert.doesNotThrow(() => hud.render(state, null, 0));
});

test('the map hotkey cycles the three states and reports the new one', () => {
  const hud = createHud(null);
  const settings = { minimap: true };
  assert.equal(hud.mapMode(settings), 'corner');
  assert.equal(hud.cycleMap(settings), 'full');
  assert.equal(hud.cycleMap(settings), 'off');
  assert.equal(hud.cycleMap(settings), 'corner');
  assert.equal(hud.mapMode(settings), 'corner');
});

test('a forced map mode ignores the settings (the preview harness)', () => {
  const hud = createHud(null, { map: 'full' });
  assert.equal(hud.mapMode({ minimap: false }), 'full');
  // The legacy boolean option still means "corner".
  const legacy = createHud(null, { minimap: true });
  assert.equal(legacy.mapMode({ minimap: false }), 'corner');
});

test('map statistics are exposed and start empty', () => {
  const hud = createHud(null);
  const stats = hud.mapStats();
  assert.equal(typeof stats.updateMs, 'number');
  assert.equal(stats.explored, 0);
  assert.equal(hud.mapStats(), stats, 'the stats object is reused, never reallocated');
});

test('every map mode renders without throwing at both layouts', () => {
  for (const mode of /** @type {const} */ (['off', 'corner', 'full'])) {
    for (const [w, h, dpr] of [[1280, 720, 1], [390, 844, 3]]) {
      const canvas = drawableCanvas(w, h);
      const hud = createHud(canvas, { map: mode });
      hud.resize(w, h, dpr);
      const state = playingState();
      assert.doesNotThrow(() => hud.render(state, null, 0), `${mode} @ ${w}x${h}`);
      state.phase = 'paused';
      assert.doesNotThrow(() => hud.render(state, null, 0), `${mode} paused @ ${w}x${h}`);
    }
  }
});

test('there is no compass: nothing is drawn at the bottom centre, however many gems', () => {
  /**
   * Fills in the bottom-centre area where the (removed) exit compass used to sit.
   * @param {any} run
   * @returns {number}
   */
  const dialFills = (run) => {
    const canvas = drawableCanvas(1280, 720);
    const hud = createHud(canvas, { map: 'off' });
    hud.resize(1280, 720, 1);
    const state = playingState(run);
    state.level = 9;
    hud.render(state, null, 0);
    const m = hud.surface.metrics;
    let n = 0;
    for (const [x, y, w] of canvas.__ctx.calls.rects) {
      if (y < m.h * 0.6) continue;
      if (Math.abs(x + w / 2 - m.w / 2) > 14 * m.u) continue;
      n++;
    }
    return n;
  };
  assert.equal(dialFills({ gems: 0, gemsTotal: 120 }), dialFills({ gems: 120, gemsTotal: 120 }));
  const early = dialFills({ gems: 0, gemsTotal: 6 });
  assert.equal(early, 0, 'no dial and no exit-distance readout');
});

test('the HUD survives a level with no data and a low tank', () => {
  const canvas = drawableCanvas(1280, 720);
  const hud = createHud(canvas, { map: 'corner' });
  hud.resize(1280, 720, 1);
  const state = playingState({ fuel: 3 });
  state.levelData = null;
  state.explored = null;
  assert.doesNotThrow(() => hud.render(state, null, 0));
});

// ─── The hidden map scroll (ARCHITECTURE.md §4.8) ─────────────────────────────────────────────

/**
 * Text labels drawn by one frame.
 * @param {any} hud
 * @param {any} state
 * @returns {string[]}
 */
function frameTexts(hud, state) {
  return collectLayout(() => hud.render(state, null, 0))
    .filter((b) => b.kind === 'text')
    .map((b) => b.label);
}

/**
 * Advance the sim clock one frame and return the frame's text labels.
 * @param {any} hud
 * @param {any} state
 * @param {number} [dt]
 * @returns {string[]}
 */
function step(hud, state, dt = 1 / 60) {
  state.time += dt;
  return frameTexts(hud, state);
}

/**
 * Run `body` with a fake `document`, so the map raster (and the glyph atlases) really exist, then
 * restore Node's globals and drop the atlases built against the fake canvases, so the tests above
 * that count blits keep running against a DOM-less font.
 * @param {() => void} body
 */
function withRaster(body) {
  const restore = installFakeDocument();
  try {
    body();
  } finally {
    restore();
    clearFontCache();
  }
}

test('mapLocked reads run.mapFound, and a missing field is found', () => {
  const hud = createHud(null);
  assert.equal(hud.mapLocked(playingState({ mapFound: false })), true);
  assert.equal(hud.mapLocked(playingState({ mapFound: true })), false);
  assert.equal(hud.mapLocked(playingState()), false, 'an older state without the field never locks');
  assert.equal(hud.mapLocked(/** @type {any} */ (null)), false);
  assert.equal(hud.mapLocked(/** @type {any} */ ({})), false);
  assert.equal(hud.mapLocked(/** @type {any} */ ({ run: null })), false);
  // The lock never rewrites the player's preference.
  assert.equal(hud.mapMode({ mapMode: 'full' }), 'full');
});

test('a locked map draws nothing in corner or full and lays out exactly as for off', () => {
  withRaster(() => {
    for (const [w, h, dpr] of [[1280, 720, 1], [390, 844, 3]]) {
      for (const phase of ['playing', 'paused']) {
        /** @param {'off'|'corner'|'full'} mode @param {boolean} locked */
        const shoot = (mode, locked) => {
          const canvas = drawableCanvas(w, h);
          const hud = createHud(canvas, { map: mode });
          hud.resize(w, h, dpr);
          const state = playingState({ mapFound: !locked });
          state.phase = phase;
          hud.render(state, null, 0);
          const { fills, draws, rects } = canvas.__ctx.calls;
          return { fills, draws, rects: JSON.stringify(rects), explored: hud.mapStats().explored };
        };
        const off = shoot('off', false);
        for (const mode of /** @type {const} */ (['corner', 'full'])) {
          const open = shoot(mode, false);
          assert.ok(open.draws > off.draws, `${w}x${h} ${phase} ${mode}: sanity — the unlocked map blits`);
          const locked = shoot(mode, true);
          assert.equal(locked.draws, off.draws, `${w}x${h} ${phase} ${mode}: no map blit while locked`);
          assert.equal(locked.fills, off.fills, `${w}x${h} ${phase} ${mode}: same fills as off`);
          assert.equal(locked.rects, off.rects, `${w}x${h} ${phase} ${mode}: identical layout to off`);
          assert.equal(locked.explored, 0, 'no raster work while locked');
        }
      }
    }
  });
});

test('unlocking shows everything explored while locked on that frame, with one catch-up scan', () => {
  withRaster(() => {
    const hud = createHud(drawableCanvas(1280, 720), { map: 'corner' });
    hud.resize(1280, 720, 1);
    // A 64-cell maze: 129×129 = 16 641 tiles, four times the rolling sweep's per-frame budget, so
    // only an exact rescan can put a far-away reveal on the raster within one frame.
    const cols = 64;
    const width = cols * 2 + 1;
    const state = playingState({ mapFound: true });
    const tiles = new Uint8Array(width * width).fill(1);
    for (let cy = 0; cy < cols; cy++) {
      for (let cx = 0; cx < cols; cx++) tiles[(cy * 2 + 1) * width + cx * 2 + 1] = 0;
    }
    Object.assign(state.levelData.maze, {
      width,
      height: width,
      cols,
      rows: cols,
      tiles,
      exit: { x: width - 2, y: width - 2 },
    });
    state.explored = new Uint8Array(width * width);
    for (let i = 0; i < 200; i++) state.explored[i] = 1;

    step(hud, state);
    const stats = hud.mapStats();
    assert.equal(stats.explored, countExplored(state.explored));
    const rebuilds = stats.rebuilds;

    // Lock for a handful of frames — well inside the view's stale-gap timer — and explore the far
    // corner meanwhile.
    state.run.mapFound = false;
    for (let i = 0; i < 5; i++) step(hud, state);
    for (let y = width - 20; y < width; y++) {
      for (let x = width - 20; x < width; x++) state.explored[y * width + x] = 1;
    }
    step(hud, state);
    assert.equal(stats.rebuilds, rebuilds, 'nothing is scanned while locked');

    state.run.mapFound = true;
    step(hud, state);
    assert.equal(stats.explored, countExplored(state.explored), 'the unlock frame is complete');
    assert.equal(stats.rebuilds, rebuilds + 1, 'by exactly one catch-up scan');
    for (let i = 0; i < 10; i++) step(hud, state);
    assert.equal(stats.rebuilds, rebuilds + 1, 'and none after it');
    assert.ok(stats.scanned < width * width, 'back on the incremental path');
  });
});

test('"Map Found" fires once, on the false → true edge of run.mapFound only', () => {
  const hud = createHud(drawableCanvas(1280, 720), { map: 'corner' });
  hud.resize(1280, 720, 1);
  const count = (/** @type {string[]} */ t) => t.filter((s) => s === MAP_FOUND_TEXT).length;

  // A level that starts locked: no banner.
  const state = playingState({ mapFound: false });
  assert.equal(count(step(hud, state)), 0);
  for (let i = 0; i < 30; i++) assert.equal(count(step(hud, state)), 0, 'locked is not an event');

  // The pickup.
  state.run.mapFound = true;
  assert.equal(count(step(hud, state)), 1, 'the banner is raised on the edge');
  let shown = 1;
  for (let i = 0; i < 60 * 4; i++) shown += count(step(hud, state)) > 0 ? 1 : 0;
  assert.ok(shown > 60 && shown < 60 * 3, `it stays up for a couple of seconds (${shown} frames)`);
  for (let i = 0; i < 60; i++) assert.equal(count(step(hud, state)), 0, 'and goes away; true stays quiet');

  // A new level: installed and locked in one dispatch (a new levelData). No banner.
  state.levelData = { ...state.levelData };
  state.level++;
  state.run.mapFound = false;
  assert.equal(count(step(hud, state)), 0);

  // A level with no map item: found from its first frame. No banner, even though the previous
  // frame was locked.
  state.levelData = { ...state.levelData };
  state.level++;
  state.run.mapFound = true;
  for (let i = 0; i < 10; i++) assert.equal(count(step(hud, state)), 0, 'a level without a scroll never fires');

  // A new run: reset(), and its first level is unlocked on the same level number and data.
  state.run.mapFound = false;
  step(hud, state);
  hud.reset();
  state.run.mapFound = true;
  assert.equal(count(step(hud, state)), 0, 'reset() resyncs without firing');

  // Outside `playing` the delta is adopted silently.
  state.run.mapFound = false;
  step(hud, state);
  state.phase = 'paused';
  state.run.mapFound = true;
  assert.equal(count(step(hud, state)), 0);
  state.phase = 'playing';
  assert.equal(count(step(hud, state)), 0);

  // And the real edge still fires after all of that.
  state.run.mapFound = false;
  step(hud, state);
  state.run.mapFound = true;
  assert.equal(count(step(hud, state)), 1);
});

test('notice(text) shows a centred one-line banner for about 1.6 s, reduced motion included', () => {
  const text = 'NO MAP - FIND THE SCROLL';
  for (const reducedMotion of [false, true]) {
    for (const [w, h, dpr] of [[1280, 720, 1], [390, 844, 3]]) {
      const hud = createHud(drawableCanvas(w, h), { map: 'off' });
      hud.resize(w, h, dpr);
      const state = playingState({ mapFound: false });
      state.settings.reducedMotion = reducedMotion;
      step(hud, state);
      hud.notice(text);
      const m = hud.surface.metrics;
      let frames = 0;
      /** @type {number[]} */
      const ys = [];
      for (let i = 0; i < 60 * 3; i++) {
        state.time += 1 / 60;
        const boxes = collectLayout(() => hud.render(state, null, 0)).filter(
          (b) => b.kind === 'text' && b.label === text,
        );
        if (boxes.length === 0) continue;
        frames++;
        const b = boxes[0];
        ys.push(b.y);
        assert.ok(Math.abs(b.x + b.w / 2 - (m.viewX + m.viewW / 2)) <= 2, `${w}x${h}: centred on the view`);
        assert.ok(b.x >= 0 && b.x + b.w <= m.w, `${w}x${h}: on screen`);
      }
      assert.ok(frames >= 85 && frames <= 100, `${w}x${h} reduced=${reducedMotion}: ${frames} frames ≈ 1.6 s`);
      if (reducedMotion) assert.equal(new Set(ys).size, 1, 'reduced motion: the banner does not move');
    }
  }
  const hud = createHud(null);
  assert.doesNotThrow(() => hud.notice(''));
  assert.doesNotThrow(() => hud.notice(/** @type {any} */ (null)));
});

// ─── The oil: labels and hints ────────────────────────────────────────────────────────────────

test('the fuel readout is labelled OIL, never TANK, and never crowds the clock', () => {
  // Playtest: "'TANK' is a bit confusing". The label names what the flasks refill. The flask tally
  // ("OIL ×3") is drawn only where there is room for it *and* a clear gap before the clock: at 1280
  // wide "OIL ×4 1:16" read as one run of numbers.
  const allowed = ['OIL', 'OIL ×3', 'LOW', 'LOW OIL'];
  for (const [w, h, dpr] of [[1920, 1080, 1], [1280, 720, 1], [390, 844, 3]]) {
    const hud = createHud(drawableCanvas(w, h), { map: 'off' });
    hud.resize(w, h, dpr);
    const state = playingState({ fuel: 80 });
    /**
     * The gauge's label and clock boxes this frame.
     * @returns {{label:any, clock:any, all:string[]}}
     */
    const shoot = () => {
      state.time += 1 / 60;
      const boxes = collectLayout(() => hud.render(state, null, 0)).filter((b) => b.kind === 'text');
      const clock = boxes.find((b) => /^\d+:\d\d$/.test(b.label));
      const label = boxes.find((b) => allowed.includes(b.label));
      return { label, clock, all: boxes.map((b) => b.label) };
    };
    /** @param {ReturnType<typeof shoot>} f @param {string} what */
    const check = (f, what) => {
      assert.ok(!f.all.some((t) => /TANK/.test(t)), `${w}x${h} ${what}: no TANK anywhere (${f.all.join(' | ')})`);
      assert.ok(f.clock, `${w}x${h} ${what}: the clock is drawn (${f.all.join(" | ")})`);
      if (f.label === undefined) return; // a bar with no room for any word drops it
      const m = hud.surface.metrics;
      const glyph = f.label.w / f.label.label.length;
      assert.ok(f.clock.x - (f.label.x + f.label.w) >= Math.min(2 * glyph, 3 * m.u) - 1, `${w}x${h} ${what}: "${f.label.label}" crowds the clock`);
    };
    const plain = shoot();
    check(plain, 'full');
    if (w >= 1280) assert.equal(plain.label && plain.label.label, 'OIL', `${w}x${h}: the gauge says OIL`);
    state.run.refuels = 3;
    const tally = shoot();
    check(tally, 'after flasks');
    if (w >= 1280) assert.ok(tally.label && ['OIL', 'OIL ×3'].includes(tally.label.label), `${w}x${h}: tally or plain OIL`);
    state.run.fuel = 10;
    // The gauge reads the smoothed bar, which takes a moment to fall.
    for (let i = 0; i < 60; i++) shoot();
    const low = shoot();
    check(low, 'low');
    if (w >= 1280) assert.ok(low.label && ['LOW', 'LOW OIL'].includes(low.label.label), `${w}x${h}: the alarm replaces the tally (${low.all.join(' | ')})`);
  }
});

test('the first level of a session explains the oil once, on screen at both layouts', () => {
  for (const [w, h, dpr, hint] of /** @type {const} */ ([
    [1280, 720, 1, 'Your torch burns oil - grab flasks to refill'],
    [390, 844, 3, 'Torch burns oil - find flasks'],
  ])) {
    const hud = createHud(drawableCanvas(w, h), { map: 'off' });
    hud.resize(w, h, dpr);
    const state = playingState({ fuel: 110 });
    state.level = 1;
    const m = hud.surface.metrics;
    let frames = 0;
    for (let i = 0; i < 60 * 8; i++) {
      state.time += 1 / 60;
      const boxes = collectLayout(() => hud.render(state, null, 0)).filter((b) => b.kind === 'text' && b.label === hint);
      if (boxes.length === 0) continue;
      frames++;
      const b = boxes[0];
      assert.ok(b.x >= 0 && b.x + b.w <= m.w, `${w}x${h}: the hint fits on screen (${b.x}..${b.x + b.w} of ${m.w})`);
    }
    assert.ok(frames > 60 * 3 && frames < 60 * 5, `${w}x${h}: the hint stays up long enough to read (${frames} frames)`);
    // A second run in the same session does not repeat it.
    hud.reset();
    state.level = 2;
    step(hud, state);
    state.level = 1;
    let again = 0;
    for (let i = 0; i < 60 * 3; i++) again += step(hud, state).includes(hint) ? 1 : 0;
    assert.equal(again, 0, 'explained once per session');
  }
  // Deeper levels never raise it.
  const hud = createHud(drawableCanvas(1280, 720), { map: 'off' });
  hud.resize(1280, 720, 1);
  const state = playingState();
  let shown = 0;
  for (let i = 0; i < 60 * 3; i++) shown += step(hud, state).some((t) => /burns oil/.test(t)) ? 1 : 0;
  assert.equal(shown, 0);
});

test('running low on oil raises a notice once per level, on the crossing only', () => {
  const warn = 'Torch Low - Find Oil';
  const hud = createHud(drawableCanvas(1280, 720), { map: 'off' });
  hud.resize(1280, 720, 1);
  const count = (/** @type {string[]} */ t) => t.filter((s) => s === warn).length;
  const state = playingState({ fuel: 40, fuelMax: 110 });
  for (let i = 0; i < 10; i++) assert.equal(count(step(hud, state)), 0, 'plenty of oil: quiet');
  state.run.fuel = 27; // under a quarter
  assert.equal(count(step(hud, state)), 1, 'the crossing raises it');
  let shown = 1;
  for (let i = 0; i < 60 * 4; i++) shown += count(step(hud, state));
  assert.ok(shown > 60 && shown < 60 * 3, `it stays up about two seconds (${shown} frames)`);
  // Refill and drain again on the same level: not again.
  state.run.fuel = 90;
  step(hud, state);
  state.run.fuel = 20;
  for (let i = 0; i < 30; i++) assert.equal(count(step(hud, state)), 0, 'once per level');
  // A new level that starts low is not news…
  state.level++;
  for (let i = 0; i < 30; i++) assert.equal(count(step(hud, state)), 0, 'a level starting low is quiet');
  // …but crossing on it is.
  state.run.fuel = 90;
  step(hud, state);
  state.run.fuel = 20;
  assert.equal(count(step(hud, state)), 1, 'a new level can warn again');
  // It never replaces "Map Found".
  state.level++;
  state.run.fuel = 90;
  state.run.mapFound = false;
  step(hud, state);
  state.run.mapFound = true;
  assert.equal(step(hud, state).filter((s) => s === MAP_FOUND_TEXT).length, 1);
  state.run.fuel = 20;
  const t = step(hud, state);
  assert.equal(count(t), 0, 'the reward banner is not clobbered');
  assert.equal(t.filter((s) => s === MAP_FOUND_TEXT).length, 1);
  // …but the warning is only deferred, not lost: it shows once the reward banner has gone.
  let late = 0;
  for (let i = 0; i < 60 * 5; i++) late += count(step(hud, state)) > 0 ? 1 : 0;
  assert.ok(late > 0, 'a crossing under "Map Found" still warns after the banner clears');
});
