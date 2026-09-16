// @ts-check
/**
 * @file Unit tests for src/ui/map.js — the three-state mode machine, the raster maths, and the
 * incremental update that has to stay cheap at 257×257 tiles with ~900 items.
 * Run: `node src/ui/map.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAP,
  MAP_MODES,
  chooseFullScale,
  cornerWindow,
  countExplored,
  createMapView,
  cycleMapMode,
  fitBeats,
  mapModeFromSettings,
  nextMapMode,
  normalizeMapMode,
  paintTiles,
  readMapMode,
  resetMapMode,
  setMapMode,
} from './map.js';

// ─── Test doubles ────────────────────────────────────────────────────────────────────────────

/**
 * A canvas good enough for the map view: it records `putImageData` dirty rects and `drawImage`
 * calls, which is exactly what the cost assertions below are about.
 * @param {number} w
 * @param {number} h
 * @returns {any}
 */
function fakeCanvas(w, h) {
  const calls = { put: [], draws: 0, fills: 0 };
  const ctx = {
    calls,
    createImageData: (cw, ch) => ({
      width: cw,
      height: ch,
      data: new Uint8ClampedArray(cw * ch * 4),
    }),
    putImageData: (img, dx, dy, sx, sy, sw, sh) => {
      calls.put.push(sw === undefined ? [0, 0, img.width, img.height] : [sx, sy, sw, sh]);
    },
    drawImage: () => {
      calls.draws++;
    },
    fillRect: () => {
      calls.fills++;
    },
    set fillStyle(_v) {},
    get fillStyle() {
      return '#000';
    },
    globalAlpha: 1,
  };
  return { width: w, height: h, getContext: () => ctx, __ctx: ctx };
}

/**
 * A "thick wall" maze of `cols × rows` cells with every wall knocked out on the even rows — the
 * shape does not matter here, only that floors and walls both exist.
 * @param {number} cols
 * @param {number} rows
 * @returns {any}
 */
function makeMaze(cols, rows) {
  const width = cols * 2 + 1;
  const height = rows * 2 + 1;
  const tiles = new Uint8Array(width * height).fill(1);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      tiles[(cy * 2 + 1) * width + cx * 2 + 1] = 0;
      if (cx + 1 < cols) tiles[(cy * 2 + 1) * width + cx * 2 + 2] = 0;
    }
    if (cy + 1 < rows) tiles[(cy * 2 + 2) * width + 1] = 0;
  }
  return {
    width,
    height,
    cols,
    rows,
    tiles,
    start: { x: 1, y: 1 },
    exit: { x: width - 2, y: height - 2 },
    seed: 1,
  };
}

/**
 * A GameState-shaped object with a maze, a fog grid and some items.
 * @param {number} cols
 * @param {number} rows
 * @param {number} [itemCount]
 * @returns {any}
 */
function makeState(cols, rows, itemCount = 0) {
  const maze = makeMaze(cols, rows);
  /** @type {any[]} */
  const items = [];
  for (let i = 0; i < itemCount; i++) {
    const cx = i % cols;
    const cy = ((i / cols) | 0) % rows;
    items.push({
      id: i,
      kind: i % 3 === 0 ? 'oil' : 'gem',
      x: cx * 2 + 1.5,
      y: cy * 2 + 1.5,
      taken: false,
    });
  }
  return {
    phase: 'playing',
    time: 0,
    level: 1,
    levelData: { maze, validation: {}, items, torches: [], fuel: 100, par: 50 },
    player: { x: 1.5, y: 1.5, angle: 0 },
    explored: new Uint8Array(maze.width * maze.height),
    run: { score: 0, gems: 0, gemsTotal: 1, fuel: 100, fuelMax: 100, levelTime: 0 },
    derived: { exitDist: 10, nearExit: 0, lowFuel: false },
    settings: { minimap: true, reducedMotion: false },
  };
}

/**
 * Reveal a disc of tiles, the way `revealAround` does.
 * @param {any} state
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @returns {void}
 */
function reveal(state, cx, cy, r) {
  const { width, height } = state.levelData.maze;
  for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x++) {
      state.explored[y * width + x] = 1;
    }
  }
}

/**
 * A map view backed by fake canvases and a controllable clock.
 * @returns {any}
 */
function makeView() {
  /** @type {any[]} */
  const canvases = [];
  const view = createMapView({
    createCanvas: (w, h) => {
      const c = fakeCanvas(w, h);
      canvases.push(c);
      return c;
    },
    now: () => 0,
  });
  return { view, canvases };
}

// ─── Mode machine ────────────────────────────────────────────────────────────────────────────

test('the map cycles OFF → CORNER → FULL and back', () => {
  assert.deepEqual(Array.from(MAP_MODES), ['off', 'corner', 'full']);
  assert.equal(nextMapMode('off'), 'corner');
  assert.equal(nextMapMode('corner'), 'full');
  assert.equal(nextMapMode('full'), 'off');
  // Anything illegal lands on a visible state rather than on nothing.
  assert.equal(nextMapMode('banana'), 'corner');
  assert.equal(nextMapMode(undefined), 'corner');
  assert.equal(normalizeMapMode('full'), 'full');
  assert.equal(normalizeMapMode('FULL'), null);
  assert.equal(normalizeMapMode(1), null);
});

test('settings map to a mode with the legacy boolean still working', () => {
  assert.equal(mapModeFromSettings({ minimap: true }), 'corner');
  assert.equal(mapModeFromSettings({ minimap: false }), 'off');
  assert.equal(mapModeFromSettings({ minimap: true, mapMode: 'full' }), 'full');
  // A garbage mapMode falls back to the boolean rather than to nothing.
  assert.equal(mapModeFromSettings({ minimap: false, mapMode: 'huge' }), 'off');
  assert.equal(mapModeFromSettings(null), 'corner');
});

test('the local mode survives a settings write that cannot represent it', () => {
  resetMapMode();
  // A state module that only stores `minimap`: corner → full writes `minimap: true`, which does
  // not change the settings-derived mode, so the local choice must stand.
  const settings = { minimap: true };
  assert.equal(readMapMode(settings), 'corner');
  assert.equal(cycleMapMode(settings), 'full');
  assert.equal(readMapMode(settings), 'full', 'the boolean cannot say "full", so the UI remembers');
  // Turning the map off is representable, so the settings and the local mode agree again.
  assert.equal(cycleMapMode(settings), 'off');
  settings.minimap = false;
  assert.equal(readMapMode(settings), 'off');
  // An external change to the settings (a fresh run loading a saved preference) wins.
  settings.minimap = true;
  assert.equal(readMapMode(settings), 'corner');
  resetMapMode();
});

test('a state module that stores mapMode drives the UI directly', () => {
  resetMapMode();
  const settings = { minimap: true, mapMode: 'off' };
  assert.equal(readMapMode(settings), 'off');
  settings.mapMode = 'full';
  assert.equal(readMapMode(settings), 'full');
  assert.equal(setMapMode('corner'), 'corner');
  assert.equal(readMapMode(settings), 'corner', 'a local set stands until the settings move again');
  resetMapMode();
});

// ─── Raster maths ────────────────────────────────────────────────────────────────────────────

test('paintTiles paints only newly explored tiles and reports the dirty rect', () => {
  const maze = makeMaze(3, 3); // 7×7 tiles
  const w = maze.width;
  const h = maze.height;
  const explored = new Uint8Array(w * h);
  const out = new Uint32Array(w * h);
  const bounds = new Int32Array([w, h, -1, -1]);

  explored[1 * w + 1] = 1;
  explored[1 * w + 2] = 1;
  const first = paintTiles(out, w, h, 0, 0, w - 1, h - 1, maze.tiles, explored, null, -1, -1, bounds);
  assert.equal(first, 2);
  assert.deepEqual(Array.from(bounds), [1, 1, 2, 1]);
  assert.notEqual(out[1 * w + 1], 0);

  // Idempotent: a second pass over the same region paints nothing and leaves the rect alone.
  bounds.set([w, h, -1, -1]);
  assert.equal(
    paintTiles(out, w, h, 0, 0, w - 1, h - 1, maze.tiles, explored, null, -1, -1, bounds),
    0,
  );
  assert.deepEqual(Array.from(bounds), [w, h, -1, -1]);

  // Floors and walls are different colours — that is the whole point of the map.
  explored[0] = 1;
  paintTiles(out, w, h, 0, 0, w - 1, h - 1, maze.tiles, explored, null, -1, -1, bounds);
  assert.notEqual(out[0], out[1 * w + 1], 'wall and floor must not be the same pixel');
});

test('paintTiles clamps a box that runs off the raster', () => {
  const maze = makeMaze(2, 2);
  const w = maze.width;
  const h = maze.height;
  const explored = new Uint8Array(w * h).fill(1);
  const out = new Uint32Array(w * h);
  const bounds = new Int32Array([w, h, -1, -1]);
  const n = paintTiles(out, w, h, -50, -50, 500, 500, maze.tiles, explored, null, -1, -1, bounds);
  assert.equal(n, w * h, 'every tile, none out of bounds');
  assert.deepEqual(Array.from(bounds), [0, 0, w - 1, h - 1]);
  // A box entirely off the raster is a no-op, not a throw.
  assert.equal(paintTiles(out, w, h, 100, 100, 200, 200, maze.tiles, explored, null, -1, -1, bounds), 0);
});

test('items and the exit get their own colours in the raster', () => {
  const maze = makeMaze(3, 3);
  const w = maze.width;
  const explored = new Uint8Array(w * maze.height).fill(1);
  const out = new Uint32Array(w * maze.height);
  const itemLayer = new Uint8Array(w * maze.height);
  itemLayer[1 * w + 1] = 1; // gem
  itemLayer[1 * w + 3] = 2; // oil
  const exitIdx = 5 * w + 5;
  const bounds = new Int32Array([w, maze.height, -1, -1]);
  paintTiles(out, w, maze.height, 0, 0, w - 1, maze.height - 1, maze.tiles, explored, itemLayer, exitIdx, -1, bounds);
  const gem = out[1 * w + 1];
  const oil = out[1 * w + 3];
  const exit = out[exitIdx];
  const floor = out[3 * w + 1];
  assert.equal(new Set([gem, oil, exit, floor]).size, 4, 'four distinguishable colours');
});

test('countExplored counts only the live part of the buffer', () => {
  const grid = new Uint8Array(100);
  grid[0] = 1;
  grid[50] = 1;
  grid[99] = 1;
  assert.equal(countExplored(grid), 3);
  assert.equal(countExplored(grid, 51), 2, 'a pooled buffer may be longer than the maze');
  assert.equal(countExplored(null), 0);
  assert.equal(countExplored(undefined), 0);
});

test('the full map prefers tile resolution and falls back to cells', () => {
  // A desktop overlay (640×360 UI px) fits a 128-cell maze at one pixel per tile.
  const desktop = chooseFullScale(128, 128, 620, 300);
  assert.equal(desktop.res, 'tile');
  assert.equal(desktop.scale, 1);
  assert.equal(desktop.w, 257);

  // A phone overlay cannot, so it drops to one pixel per cell — the documented fallback.
  const phone = chooseFullScale(128, 128, 180, 380);
  assert.equal(phone.res, 'cell');
  assert.equal(phone.scale, 1);
  assert.equal(phone.w, 128);
  assert.ok(phone.w <= 180, 'the map fits the box it was given');

  // A small maze gets a big integer zoom rather than a postage stamp.
  const small = chooseFullScale(16, 16, 620, 300);
  assert.equal(small.res, 'tile');
  assert.ok(small.scale >= 8, `expected a chunky zoom, got ${small.scale}`);
  assert.ok(small.h <= 300);

  // Degenerate boxes never produce a zero or negative scale.
  const tiny = chooseFullScale(128, 128, 4, 4);
  assert.ok(tiny.scale >= 1);
});

test('the corner window follows the player and clamps at the edges', () => {
  const out = new Int32Array(2);
  cornerWindow(50, 50, 25, 257, 257, out);
  assert.deepEqual(Array.from(out), [38, 38], 'centred on the player');
  cornerWindow(1, 1, 25, 257, 257, out);
  assert.deepEqual(Array.from(out), [0, 0], 'never scrolls past the top-left');
  cornerWindow(256, 256, 25, 257, 257, out);
  assert.deepEqual(Array.from(out), [232, 232], 'nor past the bottom-right');
  // A maze smaller than the window is centred instead of pinned.
  cornerWindow(5, 5, 25, 11, 11, out);
  assert.deepEqual(Array.from(out), [-7, -7]);
});

// ─── The view ────────────────────────────────────────────────────────────────────────────────

test('the first update rasterises the level once, then only the player box', () => {
  const { view } = makeView();
  const state = makeState(24, 24); // 49×49 tiles
  reveal(state, 1, 1, 3);
  view.update(state, 0);
  const first = view.stats();
  assert.equal(first.rebuilds, 1, 'the level is adopted with one full scan');
  assert.equal(first.scanned, 49 * 49);
  assert.equal(view.exploredCount(), countExplored(state.explored));

  // A later frame must not rescan the grid: the box plus the rolling sweep, nothing more.
  state.player.x = 1.6;
  view.update(state, 0.1);
  const second = view.stats();
  assert.equal(second.rebuilds, 1, 'no second full rebuild');
  const boxed = (2 * (MAP.REVEAL_RADIUS + 1 + MAP.BOX_SLACK) + 1) ** 2;
  assert.ok(
    second.scanned <= boxed + MAP.SWEEP_BUDGET,
    `steady-state scan ${second.scanned} must stay inside the box + sweep budget`,
  );
  assert.equal(second.painted, 0, 'nothing new was revealed');
});

test('newly revealed tiles are picked up from the player box within one frame', () => {
  const { view } = makeView();
  const state = makeState(24, 24);
  reveal(state, 1, 1, 3);
  view.update(state, 0);
  const before = view.exploredCount();

  // Walk two tiles and reveal around the new position, exactly like the sim does.
  state.player.x = 3.5;
  reveal(state, 3, 1, 3);
  view.update(state, 0.05);
  assert.ok(view.exploredCount() > before, 'the box caught the new tiles');
  assert.equal(view.exploredCount(), countExplored(state.explored));
  assert.equal(view.stats().rebuilds, 1, 'without falling back to a rebuild');
});

test('a gap in updates (map switched off) forces one exact rescan', () => {
  const { view } = makeView();
  const state = makeState(16, 16);
  reveal(state, 1, 1, 3);
  view.update(state, 0);
  // Reveal a region far from the player while the map is "off" — no update runs.
  reveal(state, 20, 20, 4);
  view.update(state, 5);
  assert.equal(view.stats().rebuilds, 2, 'the stale gap triggered a rescan');
  assert.equal(view.exploredCount(), countExplored(state.explored));
});

test('the rolling sweep reconciles a reveal the box could never have seen', () => {
  const { view } = makeView();
  const state = makeState(16, 16); // 33×33 = 1089 tiles, under one sweep budget
  reveal(state, 1, 1, 3);
  view.update(state, 0);
  // Cheat: reveal the far corner with no update gap, so only the sweep can find it.
  reveal(state, 30, 30, 1);
  view.update(state, 0.016);
  assert.equal(view.stats().rebuilds, 1, 'no rebuild — the sweep did it');
  assert.equal(view.exploredCount(), countExplored(state.explored));
});

test('taken items are repainted without ever scanning the item list per frame', () => {
  const { view, canvases } = makeView();
  const state = makeState(20, 20, 400);
  for (let y = 0; y < state.levelData.maze.height; y++) {
    for (let x = 0; x < state.levelData.maze.width; x++) state.explored[y * state.levelData.maze.width + x] = 1;
  }
  view.update(state, 0);
  const seen = view.exploredCount();
  const puts = canvases[0].__ctx.calls.put.length;

  // Take a flask. The prune runs on its own interval, so it needs a clock step to notice.
  state.levelData.items[3].taken = true;
  view.update(state, MAP.PRUNE_INTERVAL + 0.01);
  assert.equal(view.exploredCount(), seen, 'a repaint is not a new explored tile');
  assert.ok(canvases[0].__ctx.calls.put.length > puts, 'the repaint was flushed');

  // And the frames after it cost nothing extra.
  view.update(state, MAP.PRUNE_INTERVAL + 0.02);
  assert.equal(view.stats().painted, 0);
});

test('a mismatched explored buffer is refused rather than read out of bounds', () => {
  const { view } = makeView();
  const state = makeState(8, 8);
  state.explored = new Uint8Array(4);
  assert.doesNotThrow(() => view.update(state, 0));
  assert.equal(view.exploredCount(), 0);
});

test('the view is inert and safe with no canvas at all', () => {
  const view = createMapView({ createCanvas: () => null, now: () => 0 });
  const state = makeState(8, 8);
  reveal(state, 1, 1, 3);
  assert.doesNotThrow(() => view.update(state, 0));
  assert.equal(view.exploredCount(), 0);
  assert.doesNotThrow(() => view.reset());
  assert.doesNotThrow(() => view.dispose());
});

test('switching levels rebuilds against the new maze', () => {
  const { view } = makeView();
  const a = makeState(8, 8);
  reveal(a, 1, 1, 3);
  view.update(a, 0);
  const firstCount = view.exploredCount();
  assert.ok(firstCount > 0);

  const b = makeState(12, 12);
  reveal(b, 1, 1, 2);
  view.update(b, 0.02);
  assert.equal(view.exploredCount(), countExplored(b.explored), 'counted against the new level');
  assert.equal(view.stats().tiles, b.levelData.maze.width * b.levelData.maze.height);
});

test('update never throws on a half-built state', () => {
  const { view } = makeView();
  assert.doesNotThrow(() => view.update(/** @type {any} */ (null), 0));
  assert.doesNotThrow(() => view.update(/** @type {any} */ ({}), 0));
  assert.doesNotThrow(() => view.update(/** @type {any} */ ({ levelData: null, explored: null }), 0));
  assert.doesNotThrow(() =>
    view.update(/** @type {any} */ ({ levelData: { maze: null }, explored: new Uint8Array(4) }), 0),
  );
});

test('chooseFullScale fills a caller-owned result, and fitBeats ranks tile resolution first', () => {
  const out = { res: /** @type {'tile'|'cell'} */ ('cell'), scale: 0, w: 0, h: 0 };
  const same = chooseFullScale(128, 128, 1100, 1100, out);
  assert.equal(same, out, 'the result object is the one passed in (no per-frame allocation)');
  assert.deepEqual({ ...out }, { res: 'tile', scale: 4, w: 1028, h: 1028 });
  const cell = chooseFullScale(128, 128, 200, 200);
  assert.equal(cell.res, 'cell');
  assert.equal(fitBeats(out, cell), true, 'tiles beat cells');
  assert.equal(fitBeats(cell, out), false);
  const smaller = chooseFullScale(128, 128, 800, 800);
  assert.equal(fitBeats(out, smaller), true, 'the bigger map wins');
  assert.equal(fitBeats(smaller, out), false);
  assert.equal(fitBeats(out, { ...out }), true, 'a tie goes to the first candidate');
});

/**
 * A 2-D context for `drawFull`: everything it calls, recording the map blit.
 * @returns {any}
 */
function fullMapCtx() {
  const calls = { blit: /** @type {number[]|null} */ (null), transforms: 0, restores: 0 };
  return {
    calls,
    globalAlpha: 1,
    fillStyle: '#000',
    fillRect() {},
    save() {},
    restore() {
      calls.restores++;
    },
    setTransform() {
      calls.transforms++;
    },
    beginPath() {},
    rect() {},
    clip() {},
    drawImage(...args) {
      // The map blit is the only nine-argument draw from a raster canvas.
      if (args.length === 9) calls.blit = args.slice(5);
    },
  };
}

test('the wide full map moves its text into side rails and gets the whole height', () => {
  const state = makeState(128, 128);
  reveal(state, 1, 1, 3);
  state.level = 15;

  /**
   * Draw the full map at a surface size and return the blit rectangle in device pixels.
   * @param {any} m
   * @param {number} gaugeRight
   * @param {number} gaugeBottom
   * @returns {number[]}
   */
  const blitAt = (m, gaugeRight, gaugeBottom) => {
    const { view } = makeView();
    view.update(state, 0);
    const ctx = fullMapCtx();
    view.drawFull(ctx, m, state, 0, true, gaugeRight, gaugeBottom);
    assert.ok(ctx.calls.blit !== null, 'the map was drawn');
    assert.equal(ctx.calls.restores, 1, 'the UI transform is always put back');
    return /** @type {number[]} */ (ctx.calls.blit);
  };

  // 1920×1080 at dpr 1: the surface is 960×540 UI px at 2 device px each. Strips on top and
  // bottom left 3 device px per tile; the rails give the map the full height, and 4.
  const hd = { w: 960, h: 540, px: 2, u: 3, narrow: false, originX: 0, originY: 0 };
  const [hx, hy, hw, hh] = blitAt(hd, 237, 54);
  assert.equal(hw, 1028, `257 tiles × 4 device px (got ${hw})`);
  assert.equal(hh, 1028);
  assert.ok(hx >= 237 * 2, 'the map sits clear of the fuel gauge column');
  assert.ok(hx + hw <= hd.w * hd.px, 'and inside the screen on the right');
  assert.ok(hy >= 0 && hy + hh <= hd.h * hd.px, 'and inside it vertically');

  // 1280×720: the cap is height-bound either way (2 px per tile); the tie goes to the rails, so the
  // text still leaves the strips and the map is centred on the whole height.
  const wide = { w: 640, h: 360, px: 2, u: 2, narrow: false, originX: 0, originY: 0 };
  const [wx, wy, ww, wh] = blitAt(wide, 158, 42);
  assert.equal(ww, 514);
  assert.ok(wx >= 158 * 2);
  const frame = 2 * 2;
  assert.ok(Math.abs(wy - frame - (720 - (wh + frame * 2)) / 2) <= 2, `centred vertically (y=${wy})`);

  // A phone keeps the stacked strips: no room at the sides at all.
  const phone = { w: 234, h: 506, px: 5, u: 3, narrow: true, originX: 0, originY: 0 };
  const [px, , pw] = blitAt(phone, 120, 60);
  assert.equal(pw, 1028, 'a 390×844 phone at dpr 3 still gets 4 device px per tile');
  assert.ok(px >= 0 && px + pw <= phone.w * phone.px);

  // 412×915 at dpr 2.625: the side margin is paid in device pixels, which is what buys the fourth
  // device pixel per tile here (a UI-pixel margin cost 30 device px a side and left 3).
  const pixel = { w: 216, h: 480, px: 5, u: 2, narrow: true, originX: 1, originY: 1 };
  const [, , qw] = blitAt(pixel, 110, 50);
  assert.equal(qw, 1028, `257 tiles × 4 device px on a 1 082-px-wide phone (got ${qw})`);
});
