// @ts-check
/**
 * @file Unit tests for the raycaster (run: `node src/renderer/raycaster.test.mjs`).
 *
 * The renderer needs a canvas, so these tests drive it through a minimal fake 2-D context. That is
 * deliberate: it exercises the *real* render path — DDA, floor casting, sprites, particles, the
 * flash pass — rather than a re-implementation, and lets the maths be asserted against closed-form
 * answers.
 *
 * The properties worth locking down:
 * - **DDA distances** match analytic geometry, including the no-fisheye invariant (a wall square to
 *   the view has the same perpendicular distance in every column).
 * - **The z-buffer never holds a NaN.** `0 * Infinity` is NaN, and a player standing exactly on a
 *   tile edge while facing a cardinal direction produces exactly that product in the naive
 *   formulation. A single NaN there silently deletes a column of sprites, so the cardinal angles
 *   and edge positions are tested explicitly (ARCHITECTURE §4.5).
 * - **Graceful failure**: no 2-D context, or a malformed view, must not throw during boot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRaycaster } from './raycaster.js';
import { createTextures } from './textures.js';

/** Painting textures costs ~20 ms; every test shares one set. */
const textures = createTextures(7);

/**
 * Minimal stand-in for a canvas with a 2-D context. `img` holds the last `ImageData` created, so a
 * test can read back exactly what the renderer wrote.
 * @returns {{canvas:any, read:() => Uint32Array}}
 */
function fakeCanvas() {
  const ctx = {
    /** @type {any} */
    img: null,
    /**
     * @param {number} w
     * @param {number} h
     * @returns {any}
     */
    createImageData(w, h) {
      this.img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      return this.img;
    },
    putImageData() {},
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  return { canvas, read: () => new Uint32Array(ctx.img.data.buffer) };
}

/**
 * A 5×5 room: solid border, open interior. Tile (tx,ty) spans [tx,tx+1)×[ty,ty+1), so the inner
 * faces sit at x=1, x=4, y=1 and y=4.
 * @returns {import('../core/types.js').Maze}
 */
function room() {
  const width = 5;
  const height = 5;
  const tiles = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles[y * width + x] = x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 1 : 0;
    }
  }
  return {
    width,
    height,
    cols: 2,
    rows: 2,
    tiles,
    start: { x: 1, y: 1 },
    exit: { x: 3, y: 3 },
    seed: 1,
  };
}

/**
 * Build a render view over a maze.
 * @param {import('../core/types.js').Maze} maze
 * @param {Partial<import('../core/types.js').RenderView> & {player?:Partial<import('../core/types.js').RenderView['player']>}} [over]
 * @returns {import('../core/types.js').RenderView}
 */
function makeView(maze, over = {}) {
  return {
    player: { x: 2.5, y: 2.5, angle: 0, bob: 0, bobAmp: 0, shake: 0, ...(over.player || {}) },
    maze,
    items: over.items || [],
    torches: over.torches || [],
    exit: over.exit || maze.exit,
    time: over.time === undefined ? 1 : over.time,
    light: over.light === undefined ? 1 : over.light,
    flash: over.flash || { r: 255, g: 255, b: 255, a: 0 },
    portalOpen: over.portalOpen !== false,
    reducedMotion: over.reducedMotion === true,
  };
}

/**
 * Create a renderer at a known internal size.
 * @param {number} [cssW]
 * @param {number} [cssH]
 * @returns {{rc:ReturnType<typeof createRaycaster>, read:() => Uint32Array}}
 */
function makeRenderer(cssW = 960, cssH = 540) {
  const { canvas, read } = fakeCanvas();
  const rc = createRaycaster(canvas, { textures });
  rc.resize(cssW, cssH, 1);
  return { rc, read };
}

test('internal resolution is 240 rows, even, and clamped to 320…560 columns', () => {
  const { rc } = makeRenderer();
  assert.equal(rc.internalSize.h, 240);
  assert.equal(rc.internalSize.w, 426, '16:9 → 240 × 16/9 = 426.67, rounded down to an even 426');

  rc.resize(10000, 240, 1); // absurdly wide
  assert.equal(rc.internalSize.w, 560, 'clamped to MAX_W');
  rc.resize(100, 1000, 1); // taller than wide
  assert.equal(rc.internalSize.w, 320, 'clamped to MIN_W');
  rc.resize(0, 0, 1); // degenerate: fall back to 16:9 rather than divide by zero
  assert.ok(rc.internalSize.w >= 320 && rc.internalSize.w <= 560);
  assert.equal(rc.internalSize.w % 2, 0, 'width stays even so the centre column is cameraX = 0');
});

test('a wall square to the view has the same perpendicular distance in every column', () => {
  // This is the no-fisheye invariant: the camera plane formulation projects onto the view
  // direction, so a flat wall must read as one distance across the whole screen.
  const { rc } = makeRenderer();
  rc.render(makeView(room(), { player: { x: 2.5, y: 2.5, angle: 0 } }));
  const z = rc.depth();
  for (let x = 0; x < rc.internalSize.w; x++) {
    assert.ok(
      Math.abs(z[x] - 1.5) < 1e-6,
      `column ${x} read ${z[x]}, expected the east wall at x=4 from x=2.5 → 1.5`,
    );
  }
});

test('DDA distances match closed-form geometry for angled and axis-aligned rays', () => {
  const { rc } = makeRenderer();
  const mid = rc.internalSize.w >> 1; // even width ⇒ cameraX is exactly 0 here

  /**
   * @param {number} angle
   * @param {number} px
   * @param {number} py
   * @param {number} expected
   * @param {string} why
   * @returns {void}
   */
  const check = (angle, px, py, expected, why) => {
    rc.render(makeView(room(), { player: { x: px, y: py, angle } }));
    assert.ok(Math.abs(rc.depth()[mid] - expected) < 1e-6, `${why}: got ${rc.depth()[mid]}`);
  };

  check(0, 2.5, 2.5, 1.5, 'east wall face at x=4');
  check(Math.PI, 2.5, 2.5, 1.5, 'west wall face at x=1');
  check(Math.PI / 2, 2.5, 2.5, 1.5, 'south wall face at y=4 (angle +π/2 is +y)');
  check(-Math.PI / 2, 2.5, 2.5, 1.5, 'north wall face at y=1');
  check(0, 1.25, 2.5, 2.75, 'off-centre start, east wall');
  // Angled ray: it crosses x=4 after 1.5/cos θ of travel, still short of y=4, so the east face wins.
  check(0.3, 2.5, 2.5, 1.5 / Math.cos(0.3), 'angled ray hits the east face');
  check(-0.4, 2.5, 2.5, 1.5 / Math.cos(0.4), 'angled the other way, still the east face');
  // Steeper than 45°, so the south face is reached first.
  check(1.2, 2.5, 2.5, 1.5 / Math.cos(Math.PI / 2 - 1.2), 'steep ray hits the south face');
});

test('the z-buffer is finite and in range for cardinal angles on tile edges', () => {
  // The dangerous combination: a ray direction with an exactly-zero component (cardinal angle)
  // *and* a position exactly on a tile boundary, which makes the naive `0 * Infinity` appear.
  const { rc } = makeRenderer();
  const maze = room();
  const angles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, -Math.PI / 2, 2 * Math.PI];
  const positions = [
    [2, 2],
    [2, 2.5],
    [2.5, 2],
    [1, 1],
    [3.999999, 2],
    [2.5, 2.5],
  ];
  for (const angle of angles) {
    for (const [px, py] of positions) {
      rc.render(makeView(maze, { player: { x: px, y: py, angle } }));
      const z = rc.depth();
      for (let x = 0; x < rc.internalSize.w; x++) {
        assert.ok(
          Number.isFinite(z[x]),
          `NaN/∞ in the z-buffer at column ${x}, angle ${angle}, pos ${px},${py}`,
        );
        assert.ok(z[x] > 0, `non-positive depth ${z[x]} at column ${x}`);
        assert.ok(z[x] <= 30, `depth ${z[x]} beyond the far plane at column ${x}`);
      }
    }
  }
});

test('the frame is fully painted with opaque pixels', () => {
  const { rc, read } = makeRenderer();
  rc.render(
    makeView(room(), {
      player: { x: 2.5, y: 2.5, angle: 0.5 },
      torches: [{ x: 4, y: 2, face: 2 }],
      items: [{ id: 1, kind: 'gem', x: 3.5, y: 2.5, taken: false }],
    }),
  );
  const buf = read();
  const seen = new Set();
  for (let i = 0; i < buf.length; i++) {
    // Alpha lives in the top byte on every little-endian host (all shipping targets).
    assert.equal((buf[i] >>> 24) & 255, 255, `pixel ${i} is not opaque`);
    seen.add(buf[i]);
  }
  assert.ok(seen.size > 40, `only ${seen.size} distinct colours — the scene is not being shaded`);
});

test('sprites in view are drawn, and sprites behind the camera are not', () => {
  const { rc } = makeRenderer();
  const maze = room();
  const torches = [{ x: 4, y: 2, face: /** @type {2} */ (2) }];
  const items = [
    { id: 1, kind: /** @type {const} */ ('gem'), x: 3.2, y: 2.5, taken: false },
    { id: 2, kind: /** @type {const} */ ('oil'), x: 3.2, y: 2.2, taken: false },
  ];
  rc.render(makeView(maze, { player: { x: 2.5, y: 2.5, angle: 0 }, torches, items }));
  assert.ok(rc.stats().sprites >= 3, `expected torch + 2 items, drew ${rc.stats().sprites}`);

  // Facing the other way: everything is behind the camera.
  rc.render(makeView(maze, { player: { x: 2.5, y: 2.5, angle: Math.PI }, torches, items }));
  assert.equal(rc.stats().sprites, 0);

  // A collected item is not drawn. The exit portal always is, so compare the two counts rather
  // than expecting zero.
  rc.render(
    makeView(maze, {
      player: { x: 2.5, y: 2.5, angle: 0 },
      items: [{ id: 1, kind: 'gem', x: 3.2, y: 2.5, taken: false }],
    }),
  );
  const withItem = rc.stats().sprites;
  rc.render(
    makeView(maze, {
      player: { x: 2.5, y: 2.5, angle: 0 },
      items: [{ id: 1, kind: 'gem', x: 3.2, y: 2.5, taken: true }],
    }),
  );
  assert.equal(rc.stats().sprites, withItem - 1, 'a taken item must disappear');
});

test('wall torches light the wall they are mounted on and not the far side of it', () => {
  // The lighting model's subtlest rule: a sconce must pool light on its own wall (the flame stands
  // slightly proud of it) while contributing nothing through the masonry to the corridor behind.
  const width = 9;
  const height = 5;
  const tiles = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Two parallel corridors (y=1 and y=3) separated by a solid wall row at y=2.
      tiles[y * width + x] = y === 0 || y === 2 || y === 4 ? 1 : 0;
      if (x === 0 || x === width - 1) tiles[y * width + x] = 1;
    }
  }
  const maze = {
    width,
    height,
    cols: 4,
    rows: 2,
    tiles,
    start: { x: 1, y: 1 },
    exit: { x: 7, y: 3 },
    seed: 1,
  };
  const torch = [{ x: 4, y: 2, face: /** @type {3} */ (3) }]; // north face: lights the y=1 corridor

  /**
   * Mean luminance of the frame, with the player's own torch off so only the sconce is lighting.
   * @param {number} py which corridor to stand in
   * @returns {number}
   */
  const brightness = (py) => {
    const { rc, read } = makeRenderer(640, 360);
    rc.render(makeView(maze, { player: { x: 2.5, y: py, angle: 0 }, torches: torch, light: 0 }));
    const buf = read();
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      sum += (buf[i] & 255) + ((buf[i] >>> 8) & 255) + ((buf[i] >>> 16) & 255);
    }
    return sum / buf.length / 3;
  };

  const lit = brightness(1.5);
  const dark = brightness(3.5);
  assert.ok(lit > dark * 1.5, `the torch's own corridor (${lit.toFixed(1)}) should be clearly brighter than the one behind its wall (${dark.toFixed(1)})`);
});

test('reduced motion removes camera shake entirely', () => {
  const maze = room();
  const a = makeRenderer();
  const b = makeRenderer();
  const view = { player: { x: 2.5, y: 2.5, angle: 0.4, shake: 1 }, reducedMotion: true };
  a.rc.render(makeView(maze, view));
  b.rc.render(makeView(maze, { player: { ...view.player, shake: 0 }, reducedMotion: true }));
  assert.deepEqual(a.read(), b.read(), 'shake must have no effect when reducedMotion is set');

  // …and does have an effect otherwise.
  const c = makeRenderer();
  c.rc.render(makeView(maze, { player: { x: 2.5, y: 2.5, angle: 0.4, shake: 1 } }));
  assert.notDeepEqual(c.read(), b.read());
});

test('the flash pass tints without corrupting pixels', () => {
  const { rc, read } = makeRenderer();
  const maze = room();
  rc.render(makeView(maze, { player: { x: 2.5, y: 2.5, angle: 0 } }));
  const plain = read().slice();
  rc.render(makeView(maze, { player: { x: 2.5, y: 2.5, angle: 0 }, flash: { r: 255, g: 255, b: 255, a: 1 } }));
  const flashed = read();
  for (let i = 0; i < flashed.length; i++) {
    assert.equal((flashed[i] >>> 24) & 255, 255, 'flash must preserve alpha');
    assert.equal(flashed[i] & 255, 255, 'a full white flash saturates every channel');
  }
  // A zero-alpha flash is a no-op.
  rc.render(makeView(maze, { player: { x: 2.5, y: 2.5, angle: 0 }, flash: { r: 255, g: 0, b: 0, a: 0 } }));
  assert.deepEqual(read(), plain);
});

test('failure modes degrade instead of throwing', () => {
  // No 2-D context at all (ancient browser, lost context, a stub).
  const noCtx = createRaycaster(/** @type {any} */ ({ getContext: () => null }));
  noCtx.resize(800, 600, 1);
  assert.doesNotThrow(() => noCtx.render(makeView(room())));
  assert.equal(noCtx.stats().ms, 0);

  // A canvas that throws from getContext (already bound to another context type).
  const throwing = createRaycaster(
    /** @type {any} */ ({
      getContext() {
        throw new Error('already bound to webgl');
      },
    }),
  );
  assert.doesNotThrow(() => throwing.render(makeView(room())));

  // Malformed views.
  const { rc } = makeRenderer();
  assert.doesNotThrow(() => rc.render(/** @type {any} */ ({})));
  assert.doesNotThrow(() =>
    rc.render(/** @type {any} */ ({ maze: null, player: { x: 0, y: 0, angle: 0 } })),
  );
  assert.doesNotThrow(() =>
    rc.render(/** @type {any} */ ({ maze: room(), player: null, time: 0, light: 1 })),
  );
  assert.doesNotThrow(() =>
    rc.render(makeView(room(), { time: Number.NaN, light: Number.NaN })),
  );
  // …and a well-formed view still renders afterwards.
  rc.render(makeView(room(), { player: { x: 2.5, y: 2.5, angle: 0 } }));
  assert.ok(Math.abs(rc.depth()[0] - 1.5) < 1e-6);

  // Disposal is idempotent and leaves render a no-op.
  rc.dispose();
  assert.doesNotThrow(() => rc.render(makeView(room())));
  assert.doesNotThrow(() => rc.dispose());
});

test('stats and internalSize are reused objects, not fresh allocations', () => {
  const { rc } = makeRenderer();
  const s1 = rc.stats();
  rc.render(makeView(room()));
  assert.equal(rc.stats(), s1, 'stats() must hand back the same object every frame');
  const size = rc.internalSize;
  rc.resize(1280, 720, 1);
  assert.equal(rc.internalSize, size, 'internalSize is a live object');
  assert.equal(size.w, 426);
});

test('rendering does not allocate per frame', () => {
  // A gross regression (an array or object created inside the frame) shows up as steady heap
  // growth. This is a smoke test with a generous bound, not a precise allocation counter.
  const { rc } = makeRenderer(640, 360);
  const maze = room();
  const view = makeView(maze, {
    player: { x: 2.5, y: 2.5, angle: 0 },
    torches: [{ x: 4, y: 2, face: 2 }],
    items: [{ id: 1, kind: 'gem', x: 3.2, y: 2.5, taken: false }],
  });
  for (let i = 0; i < 200; i++) {
    view.time = i * 0.016;
    rc.render(view);
  }
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 2000; i++) {
    view.time = 3.2 + i * 0.016;
    view.player.angle = i * 0.003;
    rc.render(view);
  }
  const grown = process.memoryUsage().heapUsed - before;
  assert.ok(grown < 3_000_000, `heap grew ${(grown / 1e6).toFixed(2)} MB over 2000 frames`);
});

test('a texture set can be swapped in without rebuilding the renderer', () => {
  const { rc, read } = makeRenderer();
  const maze = room();
  rc.render(makeView(maze, { player: { x: 2.5, y: 2.5, angle: 0 } }));
  const before = read().slice();
  rc.setTextures(createTextures(4242));
  rc.render(makeView(maze, { player: { x: 2.5, y: 2.5, angle: 0 } }));
  assert.notDeepEqual(read(), before, 'new textures should change the image');
  // Rubbish is ignored rather than breaking the renderer.
  rc.setTextures(/** @type {any} */ (null));
  assert.doesNotThrow(() => rc.render(makeView(maze)));
});
