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
import { C } from './palette.js';
import { POSES, PREVIEW_TORCHES, buildPreviewMaze, previewItems } from './preview-scene.js';

/** Painting textures costs ~20 ms; every test shares one set. */
const textures = createTextures(7);

/** The same painted set with every torch frame blanked to the transparency key. */
const noTorchArt = {
  ...textures,
  torch: textures.torch.map((t) => ({ ...t, indices: new Uint8Array(t.indices.length) })),
};

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
 * @param {Omit<Partial<import('../core/types.js').RenderView>, 'player'> & {player?:Partial<import('../core/types.js').RenderView['player']>}} [over]
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

// ── Colour measurement helpers ───────────────────────────────────────────────────────────────
// The art-direction tests measure rendered frames the way the critic measured the reference: mean
// red-minus-blue (warmth) and luminance over wall and floor regions picked by geometry.

/**
 * @typedef {{buf:Uint32Array, w:number, h:number, z:Float32Array}} Frame
 */

/**
 * Render one frame of a scene at 16:9 and return a copy of it with its depth buffer.
 * @param {import('../core/types.js').Maze} maze
 * @param {Parameters<typeof makeView>[1]} over
 * @param {import('./textures.js').TextureSet} [set]
 * @returns {Frame}
 */
function renderScene(maze, over, set) {
  const { canvas, read } = fakeCanvas();
  const rc = createRaycaster(canvas, { textures: set || textures });
  rc.resize(960, 540, 1);
  rc.render(makeView(maze, { time: 2, ...over }));
  return { buf: read().slice(), w: rc.internalSize.w, h: rc.internalSize.h, z: rc.depth().slice(0, rc.internalSize.w) };
}

/**
 * @param {Frame} f
 * @param {number} x
 * @param {number} y
 * @returns {number} Rec. 601 luminance
 */
function lumAt(f, x, y) {
  const c = f.buf[y * f.w + x];
  return 0.299 * (c & 255) + 0.587 * ((c >>> 8) & 255) + 0.114 * ((c >>> 16) & 255);
}

/**
 * @param {Frame} f
 * @returns {number} mean luminance of the whole frame
 */
function meanLum(f) {
  let sum = 0;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) sum += lumAt(f, x, y);
  return sum / (f.w * f.h);
}

/**
 * @param {Frame} f
 * @param {number} x
 * @param {number} y
 * @returns {boolean} the pixel lies on the wall span of its column
 */
function isWallPx(f, x, y) {
  const lh = f.h / f.z[x];
  return Math.abs(y + 0.5 - (f.h >> 1)) < lh / 2 - 1;
}

/**
 * @param {Frame} f
 * @param {number} x
 * @param {number} y
 * @returns {boolean} the pixel shows floor
 */
function isFloorPx(f, x, y) {
  return y > f.h >> 1 && !isWallPx(f, x, y) && y + 0.5 - (f.h >> 1) > f.h / f.z[x] / 2 + 1;
}

/**
 * @param {Frame} f
 * @param {number} y a floor row
 * @returns {number} distance of that floor row from the eye, tiles
 */
function rowDistOf(f, y) {
  const half = f.h >> 1;
  return half / (y - half + 0.5);
}

/**
 * Warmth and brightness of a region.
 * @param {Frame} f
 * @param {(x:number, y:number) => boolean} pick
 * @returns {{rb:number, lum:number, lumP50:number, n:number}}
 */
function regionStats(f, pick) {
  let rb = 0;
  /** @type {number[]} */
  const lums = [];
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      if (!pick(x, y)) continue;
      const c = f.buf[y * f.w + x];
      rb += (c & 255) - ((c >>> 16) & 255);
      lums.push(lumAt(f, x, y));
    }
  }
  assert.ok(lums.length > 50, 'sampled region is empty');
  const lum = lums.reduce((a, b) => a + b, 0) / lums.length;
  lums.sort((a, b) => a - b);
  return { rb: rb / lums.length, lum, lumP50: lums[lums.length >> 1], n: lums.length };
}

/**
 * Rows of one screen column that are mortar: clearly darker than the column's median.
 * @param {Frame} f
 * @param {number} x
 * @param {number} y0
 * @param {number} y1
 * @returns {Set<number>}
 */
function darkRows(f, x, y0, y1) {
  const lums = [];
  for (let y = y0; y < y1; y++) lums.push(lumAt(f, x, y));
  const med = [...lums].sort((a, b) => a - b)[lums.length >> 1];
  /** @type {Set<number>} */
  const out = new Set();
  lums.forEach((l, i) => {
    if (l < med * 0.55) out.add(y0 + i);
  });
  // A column that is mostly dark is a head joint running down the seam, not a bed-joint profile.
  return out.size > lums.length * 0.5 ? new Set() : out;
}

/**
 * Parallel east-west corridors, one per listed row, each `length - 2` tiles long, separated by solid
 * rows and sealed at both ends.
 * @param {number[]} rows odd tile rows to open
 * @param {number} [length]
 * @returns {import('../core/types.js').Maze}
 */
function corridors(rows, length = 23) {
  const height = Math.max(...rows) + 2;
  const tiles = new Uint8Array(length * height).fill(1);
  for (const r of rows) for (let x = 1; x < length - 2; x++) tiles[r * length + x] = 0;
  return { width: length, height, cols: (length - 1) >> 1, rows: (height - 1) >> 1, tiles, start: { x: 1, y: rows[0] }, exit: { x: 1, y: rows[0] }, seed: 1 };
}

/**
 * The same maze mirrored across its diagonal, so east-west corridors become north-south ones.
 * @param {import('../core/types.js').Maze} m
 * @returns {import('../core/types.js').Maze}
 */
function transposeMaze(m) {
  const tiles = new Uint8Array(m.width * m.height);
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) tiles[x * m.height + y] = m.tiles[y * m.width + x];
  return { width: m.height, height: m.width, cols: m.rows, rows: m.cols, tiles, start: { x: m.start.y, y: m.start.x }, exit: { x: m.exit.y, y: m.exit.x }, seed: m.seed };
}

/**
 * The exact scene `preview.html?pose=N&t=12.5&light=1` shows.
 * @param {number} pose
 * @returns {{maze:import('../core/types.js').Maze, view:Parameters<typeof makeView>[1]}}
 */
function previewScene(pose) {
  const maze = buildPreviewMaze();
  const [x, y, angle] = POSES[pose];
  return {
    maze,
    view: { player: { x, y, angle }, items: previewItems(), torches: PREVIEW_TORCHES.slice(), time: 12.5, light: 1 },
  };
}

test('internal resolution is 240 rows (up to 400 below 4:3), even, and clamped to 320…560 columns', () => {
  const { rc } = makeRenderer();
  assert.equal(rc.internalSize.h, 240);
  assert.equal(rc.internalSize.w, 426, '16:9 → 240 × 16/9 = 426.67, rounded down to an even 426');

  rc.resize(10000, 240, 1); // absurdly wide
  assert.equal(rc.internalSize.w, 560, 'clamped to MAX_W');
  rc.resize(100, 1000, 1); // taller than wide
  assert.equal(rc.internalSize.w, 320, 'clamped to MIN_W');
  assert.equal(rc.internalSize.h, 400, 'grows rows up to MAX_H instead of narrowing further');
  rc.resize(1000, 1000, 1); // square, like a foldable's inner screen
  assert.equal(rc.internalSize.w, 320);
  assert.equal(rc.internalSize.h, 320, 'a square view fills with a square buffer');
  rc.resize(1600, 900, 1);
  assert.equal(rc.internalSize.h, 240, '4:3 and wider keep exactly 240 rows');
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

/**
 * A copy of the shared texture set with the named sprite fields blanked to the transparency key, so a
 * test can tell which art a sprite was drawn with.
 * @param {...('gem'|'oil'|'map')} keys
 * @returns {import('./textures.js').TextureSet}
 */
function blankArt(...keys) {
  /** @type {any} */
  const out = { ...textures };
  for (const k of keys) {
    out[k] = textures[k].map((t) => ({ ...t, indices: new Uint8Array(t.indices.length) }));
  }
  return out;
}

test('a map item is drawn with the scroll art, and only with it (§4.8)', () => {
  const maze = room();
  const player = { x: 1.6, y: 2.5, angle: 0 };
  const scroll = [{ id: 1, kind: /** @type {const} */ ('map'), x: 2.6, y: 2.5, taken: false }];
  // The exit portal at (3,3) is always queued, so compare against the same scene without the item.
  const empty = renderScene(maze, { player, items: [] });
  const shown = renderScene(maze, { player, items: scroll });
  assert.notDeepEqual(shown.buf, empty.buf, 'the scroll must put pixels on screen');

  // Blanking the gem and flask art changes nothing: the scroll borrows neither.
  const noGemOil = renderScene(maze, { player, items: scroll }, blankArt('gem', 'oil'));
  assert.deepEqual(noGemOil.buf, shown.buf, 'a map item must not be drawn with gem or oil art');
  // Blanking the scroll art removes it entirely.
  const noMap = renderScene(maze, { player, items: scroll }, blankArt('map'));
  assert.deepEqual(noMap.buf, empty.buf, 'the map item must be drawn with textures.map');

  const { rc } = makeRenderer();
  rc.render(makeView(maze, { player, items: [] }));
  const base = rc.stats().sprites;
  rc.render(makeView(maze, { player, items: scroll }));
  assert.equal(rc.stats().sprites, base + 1, 'one scroll, one sprite');
  rc.render(makeView(maze, { player, items: [{ ...scroll[0], taken: true }] }));
  assert.equal(rc.stats().sprites, base, 'a taken scroll disappears');
});

test('the scroll lies on the floor and is not lifted to gem height', () => {
  // The lowest scroll pixel on screen must sit at the floor line of its distance: the horizon plus
  // half a wall height (eye height 0.5 tiles). A gem hovers; the scroll must not.
  const maze = room();
  const player = { x: 1.6, y: 2.5, angle: 0 };
  const dist = 1;
  const empty = renderScene(maze, { player, items: [] });
  const shown = renderScene(maze, {
    player,
    items: [{ id: 1, kind: 'map', x: player.x + dist, y: 2.5, taken: false }],
  });
  let lowest = -1;
  let highest = shown.h;
  for (let y = 0; y < shown.h; y++) {
    for (let x = 0; x < shown.w; x++) {
      if (shown.buf[y * shown.w + x] !== empty.buf[y * shown.w + x]) {
        if (y > lowest) lowest = y;
        if (y < highest) highest = y;
      }
    }
  }
  const floorLine = (shown.h >> 1) + shown.h / dist / 2;
  assert.ok(Math.abs(lowest + 1 - floorLine) <= 2, `scroll bottom at row ${lowest}, floor line at ${floorLine}`);
  assert.ok(highest > shown.h >> 1, `the scroll (top row ${highest}) must stay below the eye line`);
});

test('an unknown item kind is skipped, not drawn as a gem', () => {
  const maze = room();
  const player = { x: 1.6, y: 2.5, angle: 0 };
  const empty = renderScene(maze, { player, items: [] });
  const bogus = /** @type {any} */ ([{ id: 1, kind: 'relic', x: 2.6, y: 2.5, taken: false }]);
  const drawn = renderScene(maze, { player, items: bogus });
  assert.deepEqual(drawn.buf, empty.buf, 'an unknown kind must draw nothing');

  const { rc } = makeRenderer();
  rc.render(makeView(maze, { player, items: [] }));
  const base = rc.stats().sprites;
  rc.render(makeView(maze, { player, items: bogus }));
  assert.equal(rc.stats().sprites, base);
});

test('the scroll does not twinkle: no sparkle motes, unlike a gem', () => {
  const maze = room();
  const player = { x: 1.6, y: 2.5, angle: 0 };
  /**
   * @param {'gem'|'map'} kind
   * @returns {number} live particles after two simulated seconds
   */
  const motes = (kind) => {
    const { rc } = makeRenderer();
    const items = [{ id: 1, kind, x: 2.6, y: 2.5, taken: false }];
    for (let f = 0; f <= 120; f++) rc.render(makeView(maze, { player, items, time: 1 + f / 60 }));
    return rc.stats().particles;
  };
  assert.ok(motes('gem') > 0, 'control: a gem nearby emits sparkle motes');
  assert.equal(motes('map'), 0, 'the scroll must not draw attention to itself');
});

test('preview pose 6 shows the map scroll, and no other pose can see it', () => {
  const withoutMap = (/** @type {number} */ pose) => {
    const { maze, view } = previewScene(pose);
    return renderScene(maze, { ...view, items: previewItems().filter((i) => i.kind !== 'map') });
  };
  for (let pose = 0; pose < POSES.length; pose++) {
    const { maze, view } = previewScene(pose);
    const frame = renderScene(maze, view);
    const control = withoutMap(pose);
    const same = frame.buf.every((c, i) => c === control.buf[i]);
    if (pose === 6) assert.equal(same, false, 'pose 6 must show the scroll');
    else assert.equal(same, true, `pose ${pose} changed when the scroll was added to the scene`);
  }
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
   * Mean luminance of the frame at the weakest player torch, so the sconce is most of the light.
   * @param {number} py which corridor to stand in
   * @param {import('../core/types.js').Torch[]} torches
   * @returns {number}
   */
  const brightness = (py, torches) => meanLum(renderScene(maze, { player: { x: 2.5, y: py, angle: 0 }, torches, light: 0 }));

  const lit = brightness(1.5, torch);
  const litBare = brightness(1.5, []);
  const behind = brightness(3.5, torch);
  const behindBare = brightness(3.5, []);
  assert.ok(lit > litBare * 1.25, `the torch's own corridor must be clearly lit by it (${litBare.toFixed(1)} → ${lit.toFixed(1)})`);
  assert.ok(
    Math.abs(behind - behindBare) < behindBare * 0.01,
    `the corridor behind the torch's wall must not gain light (${behindBare.toFixed(1)} → ${behind.toFixed(1)})`,
  );
});

// ── Wall-mounted billboards ──────────────────────────────────────────────────────────────────────
// A billboard carries one depth across its width, but a sconce's wall recedes across that width, so
// an honest z-test used to slice every torch seen at a grazing angle along a hard vertical line (50
// of 109 columns gone at 1.1 tiles). These tests measure a torch's on-screen footprint *exactly*:
// the frame is rendered twice with identical lighting and particles, once with invisible torch art,
// and the columns that differ are the ones the billboard painted.

/**
 * Columns the wall torches painted in a frame.
 * @param {import('../core/types.js').Maze} maze
 * @param {import('../core/types.js').Torch[]} torches
 * @param {{x:number, y:number, angle:number}} player
 * @returns {boolean[]} one flag per internal column
 */
function torchColumns(maze, torches, player) {
  const view = () => makeView(maze, { torches, player, exit: { x: 1, y: 1 }, time: 2, light: 0.9 });
  const lit = makeRenderer();
  lit.rc.render(view());
  const bare = fakeCanvas();
  const rcBare = createRaycaster(bare.canvas, { textures: noTorchArt });
  rcBare.resize(960, 540, 1);
  rcBare.render(view());
  const a = lit.read();
  const b = bare.read();
  const w = lit.rc.internalSize.w;
  const h = lit.rc.internalSize.h;
  /** @type {boolean[]} */
  const cols = [];
  for (let x = 0; x < w; x++) {
    let hit = false;
    for (let y = 0; y < h && !hit; y++) hit = a[y * w + x] !== b[y * w + x];
    cols.push(hit);
  }
  return cols;
}

/**
 * A 3-tile-wide open strip with a solid wall along row 0 and row 4, and optionally with the north
 * wall row removed (the "no wall to slice against" reference footprint).
 * @param {boolean} northWall
 * @returns {import('../core/types.js').Maze}
 */
function strip(northWall) {
  const width = 16;
  const height = 7;
  const tiles = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const border = x === 0 || x === width - 1 || y === 0 || y === height - 1;
      tiles[y * width + x] = border || (y === 2 && northWall) ? 1 : 0;
    }
  }
  return { width, height, cols: 7, rows: 3, tiles, start: { x: 1, y: 3 }, exit: { x: 1, y: 1 }, seed: 1 };
}

test('a wall torch seen at a grazing angle is not sliced by the wall it is mounted on', () => {
  // Torch bolted to the south face of the wall row y=2, flame just in front of y=3. Every pose looks
  // down the corridor at a grazing angle from 1.1-2.5 tiles, from both ends, so both halves of the
  // billboard get their turn at swinging into the masonry.
  const torches = [{ x: 7, y: 2, face: /** @type {1} */ (1) }];
  const poses = [
    { x: 6.3, y: 3.5, angle: -0.35 }, // 1.3 tiles, approaching from the west
    { x: 5.9, y: 3.35, angle: -0.2 }, // closer to the wall: steeper grazing
    { x: 5.2, y: 3.6, angle: -0.15 },
    { x: 8.7, y: 3.5, angle: Math.PI + 0.35 }, // the mirrored facing, from the east
    { x: 9.1, y: 3.35, angle: Math.PI + 0.2 },
  ];
  for (const player of poses) {
    const walled = torchColumns(strip(true), torches, player);
    // Without the wall row there is nothing that could occlude the flame at all, so this is the
    // billboard's true silhouette on screen.
    const open = torchColumns(strip(false), torches, player);
    const want = open.filter(Boolean).length;
    const got = walled.filter(Boolean).length;
    assert.ok(want > 20, `pose ${JSON.stringify(player)} should put the torch well on screen (${want} cols)`);
    let missing = 0;
    for (let x = 0; x < open.length; x++) if (open[x] && !walled[x]) missing++;
    assert.ok(
      missing <= 1,
      `torch sliced at ${JSON.stringify(player)}: ${missing} of its ${want} columns dropped (drew ${got})`,
    );
  }
});

test('a wall torch is still hidden by geometry genuinely in front of it', () => {
  // The fix must defeat only the sconce's OWN wall. Here the flame is round a corner (hidden by the
  // wall row between), and from the far side of its own wall (hidden by that wall's back).
  const width = 12;
  const height = 9;
  const tiles = new Uint8Array(width * height).fill(1);
  const open = (/** @type {number} */ x, /** @type {number} */ y) => {
    tiles[y * width + x] = 0;
  };
  for (let x = 1; x <= 10; x++) open(x, 1); // corridor along row 1
  for (let y = 1; y <= 7; y++) open(10, y); // turning south at x=10
  for (let x = 1; x <= 9; x++) open(x, 5); // a parallel corridor behind the torch's wall row
  /** @type {import('../core/types.js').Maze} */
  const maze = { width, height, cols: 5, rows: 4, tiles, start: { x: 1, y: 1 }, exit: { x: 1, y: 1 }, seed: 1 };

  // Sconce on the north face of the solid row 6 at x=5, lighting corridor row 5.
  const torches = [{ x: 5, y: 6, face: /** @type {3} */ (3) }];
  // From the row-1 corridor, looking straight at where the flame is: rows 2-4 are solid between.
  const behindRows = torchColumns(maze, torches, { x: 3.5, y: 1.5, angle: Math.atan2(5.98 - 1.5, 5.5 - 3.5) });
  assert.equal(behindRows.filter(Boolean).length, 0, 'a torch behind solid rows must not be drawn');

  // Sconce on the WEST face of the east wall of the south-running corridor, seen from the row-1
  // corridor around the corner at a grazing angle: the corner tile (9,2) is in front of it.
  const corner = [{ x: 11, y: 5, face: /** @type {2} */ (2) }];
  const aroundCorner = torchColumns(maze, corner, { x: 4.5, y: 1.3, angle: Math.atan2(5.5 - 1.3, 10.98 - 4.5) });
  assert.equal(aroundCorner.filter(Boolean).length, 0, 'a torch round a corner must not be drawn');

  // Sanity: from inside its own corridor the same torch IS drawn, so the zeros above are occlusion.
  const inView = torchColumns(maze, corner, { x: 10.3, y: 2.2, angle: Math.PI / 2 - 0.25 });
  assert.ok(inView.filter(Boolean).length > 10, 'the corner torch must be visible from its corridor');

  // From BEHIND its own wall. Two parallel north-south corridors (x=1 and x=3) share the solid
  // column x=2; the sconce hangs on that column's west face, lighting x=1, and the camera stands in
  // x=3. A depth bias sized for grazing views gets this wrong — the eye is on the far side of the
  // mounting plane, so any bias at all shows the flame straight through a whole tile of stone.
  const twin = new Uint8Array(5 * 10).fill(1);
  for (let y = 1; y <= 8; y++) {
    twin[y * 5 + 1] = 0;
    twin[y * 5 + 3] = 0;
  }
  /** @type {import('../core/types.js').Maze} */
  const twinMaze = { width: 5, height: 10, cols: 2, rows: 4, tiles: twin, start: { x: 1, y: 1 }, exit: { x: 1, y: 1 }, seed: 1 };
  const westFace = [{ x: 2, y: 4, face: /** @type {2} */ (2) }];
  for (const angle of [-Math.PI / 2, -Math.PI / 2 - 0.35]) {
    const through = torchColumns(twinMaze, westFace, { x: 3.5, y: 7.5, angle });
    assert.equal(through.filter(Boolean).length, 0, `a torch must not show through the back of its wall (heading ${angle.toFixed(2)})`);
  }
  // …and from its own corridor it is on screen, so the zero is the wall doing its job.
  const ownSide = torchColumns(twinMaze, westFace, { x: 1.4, y: 7.5, angle: -Math.PI / 2 + 0.12 });
  assert.ok(ownSide.filter(Boolean).length > 10, 'the twin-corridor torch must be visible from its side');
});

/**
 * A straight 38-tile corridor with no sconces, so only the player's torch and the fog light it.
 * @returns {import('../core/types.js').Maze}
 */
function bareCorridor() {
  const width = 40;
  const height = 3;
  const tiles = new Uint8Array(width * height).fill(1);
  for (let x = 1; x < width - 1; x++) tiles[width + x] = 0;
  return { width, height, cols: 19, rows: 1, tiles, start: { x: 1, y: 1 }, exit: { x: 1, y: 1 }, seed: 1 };
}

test("the player's torch throws a warm pool around the player that fades to cool shadow", () => {
  // Playtest feedback: "the player doesn't appear to be emitting any light". The torch in hand used
  // to be deliberately untinted, so the corridor beside the player was the same blue-grey as the
  // shadow — it read as ambient light, not as a flame being carried. Guards against both that and
  // the older overcorrection that warmed every material by brightness until the cobbles ahead read
  // r−b +48…+83 (tan sand) and the whole corridor went orange.
  const maze = bareCorridor();
  const frame = renderScene(maze, { player: { x: 1.5, y: 1.5, angle: 0 }, exit: { x: 38, y: 1 }, light: 0.9 });
  const floorNear = regionStats(frame, (x, y) => isFloorPx(frame, x, y) && rowDistOf(frame, y) >= 1 && rowDistOf(frame, y) < 2.5);
  const floorDark = regionStats(frame, (x, y) => isFloorPx(frame, x, y) && rowDistOf(frame, y) >= 4.5 && rowDistOf(frame, y) < 7);
  const wallNear = regionStats(frame, (x, y) => frame.z[x] < 1.6 && isWallPx(frame, x, y));
  const wallMid = regionStats(frame, (x, y) => frame.z[x] >= 2.5 && frame.z[x] < 4 && isWallPx(frame, x, y));
  const wallFar = regionStats(frame, (x, y) => frame.z[x] > 6 && frame.z[x] < 12 && isWallPx(frame, x, y));
  // A pool: bright near, falling off with distance.
  assert.ok(floorNear.lum > floorDark.lum * 1.4, `the floor pool must fall off (${floorNear.lum.toFixed(1)} → ${floorDark.lum.toFixed(1)})`);
  assert.ok(wallNear.lum > wallMid.lum * 1.25, `near stone must be lit harder than stone 3 tiles on (${wallNear.lum.toFixed(1)} vs ${wallMid.lum.toFixed(1)})`);
  // …that is visibly firelight beside the player (measured: near walls r−b ≈ +8, floor ≈ +14)…
  assert.ok(wallNear.rb >= 0, `stone beside the player must be warmed by the torch in hand (r-b ${wallNear.rb.toFixed(1)})`);
  assert.ok(wallNear.rb >= wallFar.rb + 15, `the warmth must come from the player, not the whole corridor (near ${wallNear.rb.toFixed(1)} vs far ${wallFar.rb.toFixed(1)})`);
  assert.ok(floorNear.rb > 0 && floorNear.rb < 30, `the lit floor is warm cobble, not tan sand (r-b ${floorNear.rb.toFixed(1)})`);
  // …and fades back to the blue-grey shadow outside the pool.
  for (const [name, r] of /** @type {const} */ ([['mid', wallMid], ['far', wallFar]])) {
    assert.ok(r.rb <= -8, `${name} walls outside the pool must stay blue-grey (r-b ${r.rb.toFixed(1)})`);
  }
});

test("the player's pool dims, shrinks and cools as the oil runs out", () => {
  // The oil is the light: the world itself must show how much is left, not only the HUD gauge.
  // Before this, the stone beside the player measured the same r−b (−26) at every fuel level and
  // lost only ~20 % of its luminance between a full and an empty tank.
  const maze = bareCorridor();
  /** @param {number} light */
  const near = (light) => {
    const f = renderScene(maze, { player: { x: 1.5, y: 1.5, angle: 0 }, exit: { x: 38, y: 1 }, light });
    return {
      wall: regionStats(f, (x, y) => f.z[x] < 1.6 && isWallPx(f, x, y)),
      mid: regionStats(f, (x, y) => f.z[x] >= 2.5 && f.z[x] < 4 && isWallPx(f, x, y)),
      far: regionStats(f, (x, y) => f.z[x] > 8 && f.z[x] < 14 && isWallPx(f, x, y)),
    };
  };
  const full = near(1);
  const half = near(0.5);
  const low = near(0.1);
  // Stone far past the pool shows only the ambient light every frame shares; subtracting it compares
  // the torch's own contribution.
  const own = (/** @type {number} */ l) => l - low.far.lum;
  assert.ok(own(low.wall.lum) < own(full.wall.lum) * 0.55, `an empty tank must visibly dim the stone beside the player (${full.wall.lum.toFixed(1)} → ${low.wall.lum.toFixed(1)})`);
  assert.ok(full.wall.lum > half.wall.lum && half.wall.lum > low.wall.lum, 'brightness must fall steadily with the oil');
  assert.ok(full.wall.rb >= low.wall.rb + 15, `the pool must cool as the flame weakens (r-b ${full.wall.rb.toFixed(1)} → ${low.wall.rb.toFixed(1)})`);
  assert.ok(full.mid.lum > low.mid.lum * 1.4, `the pool must shrink: stone 3 tiles out goes dark (${full.mid.lum.toFixed(1)} → ${low.mid.lum.toFixed(1)})`);
});

test('a nearly empty torch gutters, a full one only flickers', () => {
  const maze = bareCorridor();
  // One renderer for the whole time series, the way the game drives it. (A fresh renderer per frame
  // is dozens of closures over the same code, which costs V8 its per-instance specialisation and
  // made the allocation test later in this file measure the JIT rather than the renderer.)
  const { canvas, read } = fakeCanvas();
  const rc = createRaycaster(canvas, { textures });
  rc.resize(960, 540, 1);
  /**
   * Spread of the near-wall luminance over six seconds of flame.
   * @param {number} light
   * @param {boolean} [reducedMotion]
   * @returns {{min:number, max:number}}
   */
  const spread = (light, reducedMotion = false) => {
    let min = Infinity;
    let max = -Infinity;
    // Off the integers on purpose: a view whose `time` is a small integer is stored as a Smi, and
    // mixing that representation into the renderer's type feedback made the allocation test later
    // in this file measure V8's field generalisation instead of the renderer.
    for (let t = 0.13; t < 6; t += 0.25) {
      rc.render(makeView(maze, { player: { x: 1.5, y: 1.5, angle: 0 }, exit: { x: 38, y: 1 }, light, time: t, reducedMotion }));
      /** @type {Frame} */
      const f = { buf: read(), w: rc.internalSize.w, h: rc.internalSize.h, z: rc.depth() };
      const l = regionStats(f, (x, y) => f.z[x] < 1.6 && isWallPx(f, x, y)).lum;
      if (l < min) min = l;
      if (l > max) max = l;
    }
    return { min, max };
  };
  const full = spread(1);
  const low = spread(0.1);
  const lowCalm = spread(0.1, true);
  assert.ok(full.max - full.min <= 5, `a full tank must burn steadily (lum ${full.min.toFixed(1)}…${full.max.toFixed(1)})`);
  assert.ok(low.max - low.min >= 6 && low.max - low.min > 1.5 * (full.max - full.min), `a nearly empty torch must sputter (lum ${low.min.toFixed(1)}…${low.max.toFixed(1)})`);
  assert.ok(lowCalm.max - lowCalm.min < low.max - low.min, 'reduced motion must soften the guttering');
});

test('the colour temperature of the preview corridor matches the reference', () => {
  // `preview.html?pose=0` at a full tank: a long corridor with a sconce a tile behind the eye. The
  // reference measures shadowed walls r−b −20…−27 with median luminance ~56 and floor r−b ≈ +9.
  // Before the tint axis existed the same frame measured floor +48…+83 (tan sand). The stone beside
  // the player is now warmed by the torch in hand and the sconce behind (measured +31, floor +45) —
  // firelit stone, but still stone: the corridor ahead falls back to the reference's blue (−16).
  const scene = previewScene(0);
  const frame = renderScene(scene.maze, scene.view);
  const wallNear = regionStats(frame, (x, y) => frame.z[x] < 2 && isWallPx(frame, x, y));
  const wallFar = regionStats(frame, (x, y) => frame.z[x] > 4 && isWallPx(frame, x, y));
  const floorNear = regionStats(frame, (x, y) => isFloorPx(frame, x, y) && rowDistOf(frame, y) < 2.5);
  assert.ok(wallNear.rb > 0 && wallNear.rb <= 45, `near stone must read firelit, not peach (r-b ${wallNear.rb.toFixed(1)})`);
  assert.ok(wallFar.rb <= -8, `stone past the pool must fall back to blue-grey (r-b ${wallFar.rb.toFixed(1)})`);
  assert.ok(floorNear.rb <= 50, `the near floor must not read as tan sand (r-b ${floorNear.rb.toFixed(1)})`);
  assert.ok(
    wallNear.lumP50 >= 35 && wallNear.lumP50 <= 75,
    `near stone keeps the reference's mid-grey brightness (median luminance ${wallNear.lumP50.toFixed(0)})`,
  );
});

test('a wall sconce throws an amber pool that stands out even beside a full tank', () => {
  // The reference's defining lighting cue. Rendered with and without the sconce — lighting only, the
  // flame art itself blanked — so every difference is the sconce's light. It used to only brighten
  // (wall r−b −12 → −3, neutral) and, clamped at the same ceiling as the player's torch, add almost
  // nothing at a full tank.
  const maze = corridors([3]);
  const torches = [{ x: 21, y: 3, face: /** @type {2} */ (2) }]; // on the end wall, facing the camera
  const view = { player: { x: 18.3, y: 3.5, angle: 0 }, torches, light: 1, exit: { x: 1, y: 3 } };
  const lit = renderScene(maze, view, noTorchArt);
  const bare = renderScene(maze, { ...view, torches: [] }, noTorchArt);
  // The pool: the last tile of the corridor and the end wall the sconce hangs on (1.6+ tiles out).
  // The side walls beside the player are the player's own torch's, and must not decide this.
  const wallPool = (/** @type {Frame} */ f) => (/** @type {number} */ x, /** @type {number} */ y) => f.z[x] >= 1.6 && isWallPx(f, x, y);
  const floorPool = (/** @type {Frame} */ f) => (/** @type {number} */ x, /** @type {number} */ y) => isFloorPx(f, x, y) && rowDistOf(f, y) >= 1.6;
  const regions = [
    { name: 'wall', a: regionStats(lit, wallPool(lit)), b: regionStats(bare, wallPool(bare)), whole: [regionStats(lit, (x, y) => isWallPx(lit, x, y)), regionStats(bare, (x, y) => isWallPx(bare, x, y))] },
    { name: 'floor', a: regionStats(lit, floorPool(lit)), b: regionStats(bare, floorPool(bare)), whole: [regionStats(lit, (x, y) => isFloorPx(lit, x, y)), regionStats(bare, (x, y) => isFloorPx(bare, x, y))] },
  ];
  for (const { name, a, b, whole } of regions) {
    // Measured when this was written: wall −25 → +28, floor −11 → +30. Before the tint axis existed
    // the same pool went −12 → −3 (brighter, but still neutral). Since the torch in hand warms the
    // near field too, the bare pool starts warmer (wall ≈ +4) and the sconce must still add a
    // clearly hotter amber on top of it (measured: pool wall +4 → +31, walls in view +11 → +22).
    assert.ok(a.rb >= b.rb + 20 && a.rb > 25, `the ${name} under a sconce must turn amber (r-b ${b.rb.toFixed(1)} → ${a.rb.toFixed(1)})`);
    assert.ok(a.lum >= b.lum * 1.15, `the sconce must still brighten the ${name} at a full tank (${b.lum.toFixed(1)} → ${a.lum.toFixed(1)})`);
    // …and the warmth shows in the frame as a whole, not only in a few pixels next to the flame.
    assert.ok(whole[0].rb >= whole[1].rb + 8, `the ${name}s in view barely warm (r-b ${whole[1].rb.toFixed(1)} → ${whole[0].rb.toFixed(1)})`);
  }
  // …and the pool is the warm thing in the frame: well away from the sconce, past the player's own
  // small warm pool, the stone stays cool.
  const far = renderScene(maze, { ...view, player: { x: 6.5, y: 3.5, angle: Math.PI } }, noTorchArt);
  const farRb = regionStats(far, (x, y) => far.z[x] > 3 && isWallPx(far, x, y)).rb;
  assert.ok(farRb <= -12, `stone 12 tiles from the sconce must stay blue-grey (r-b ${farRb.toFixed(1)})`);
});

test('a sconce far down a dark corridor is still a visible orange flame', () => {
  // Shaded through the same fog as the stone, a flame used to fade out by ~10 tiles, and dimmed
  // through the surface gammas it faded to blue-grey rather than to ember-orange. A flame is its own
  // light, so it must stay a beacon at corridor distances — and still vanish before `FAR`, where the
  // walls it hangs on stop being drawn.
  /**
   * Pixels the flame art changes, with their mean warmth, for a sconce on the end wall `dist` ahead.
   * @param {number} dist tiles from the eye to the end wall
   * @returns {{n:number, rb:number}}
   */
  const flame = (dist) => {
    const length = Math.ceil(3.5 + dist) + 2;
    const maze = corridors([3], length);
    const endWall = length - 2;
    const view = { player: { x: endWall - dist, y: 3.5, angle: 0 }, torches: [{ x: endWall, y: 3, face: /** @type {2} */ (2) }], light: 1, exit: { x: 1, y: 3 } };
    const a = renderScene(maze, view);
    const b = renderScene(maze, view, noTorchArt);
    let n = 0;
    let rb = 0;
    for (let i = 0; i < a.buf.length; i++) {
      if (a.buf[i] === b.buf[i]) continue;
      n++;
      rb += (a.buf[i] & 255) - ((a.buf[i] >>> 16) & 255);
    }
    return { n, rb: n ? rb / n : 0 };
  };
  for (const dist of [12, 17]) {
    const f = flame(dist);
    assert.ok(f.n >= 6, `a sconce ${dist} tiles away must still show (${f.n} pixels)`);
    assert.ok(f.rb >= 30, `a sconce ${dist} tiles away must read as fire, not grey (mean r-b ${f.rb.toFixed(1)})`);
  }
  assert.equal(flame(31.5).n, 0, 'a flame beyond the far plane must not be drawn');
});

test('torch light does not leak through walls into parallel corridors', () => {
  // Reproduced in game before the fix: a sconce lit the next corridor over straight through a
  // one-tile wall (+12.6 % luminance and a warm cast with no visible source). Three parallel
  // corridors, the sconce in the middle one; each outer corridor must look exactly as it does with
  // no torch at all, at every heading.
  const maze = corridors([1, 3, 5]);
  const torches = [
    { x: 10, y: 2, face: /** @type {1} */ (1) }, // north wall of the middle corridor, facing south
    { x: 12, y: 4, face: /** @type {3} */ (3) }, // south wall of the middle corridor, facing north
  ];
  const middle = renderScene(maze, { player: { x: 7.5, y: 3.5, angle: 0 }, torches, light: 0.4 }, noTorchArt);
  const middleBare = renderScene(maze, { player: { x: 7.5, y: 3.5, angle: 0 }, torches: [], light: 0.4 }, noTorchArt);
  assert.ok(meanLum(middle) > meanLum(middleBare) * 1.1, 'sanity: the middle corridor is lit by its sconces');
  for (const py of [1.5, 5.5]) {
    for (const angle of [0, 0.35, -0.35, Math.PI - 0.3]) {
      const player = { x: 8.5, y: py, angle };
      const withT = meanLum(renderScene(maze, { player, torches, light: 0.4 }, noTorchArt));
      const without = meanLum(renderScene(maze, { player, torches: [], light: 0.4 }, noTorchArt));
      assert.ok(
        Math.abs(withT - without) <= without * 0.01,
        `corridor y=${py - 0.5} at heading ${angle.toFixed(2)} gained light through the wall (${without.toFixed(2)} → ${withT.toFixed(2)})`,
      );
    }
  }
});

test('mortar courses run unbroken across wall tile seams', () => {
  // A per-tile vertical texture offset used to make the bed joints jump height at every tile seam,
  // so each metre of a long wall read as its own slab. The painted variants share one course table
  // (asserted in textures.test.mjs); this asserts the raycaster keeps those rows at the same world
  // height on every tile. The wall art is replaced by pure course stripes — mortar on the last three
  // texel rows of every 16 — so per-tile mirroring, horizontal offsets and variant choice cannot
  // hide a jump, and the dark rows either side of each seam must coincide.
  const stripes = new Uint8Array(64 * 64);
  for (let y = 0; y < 64; y++) stripes.fill((y & 15) >= 13 ? C.stoneShadow : C.stoneBright, y * 64, (y + 1) * 64);
  const striped = { ...textures, wall: textures.wall.map((t) => ({ ...t, indices: stripes })) };
  const maze = corridors([3, 4, 5], 40); // a three-tile-deep hall: its north wall face is y = 3
  let seams = 0;
  let continuous = 0;
  for (const camX of [6.1, 9.6, 13.1, 16.6]) {
    const frame = renderScene(maze, { player: { x: camX, y: 5.5, angle: -Math.PI / 2 }, light: 1 }, striped);
    const { w, h } = frame;
    const dist = frame.z[w >> 1];
    const top = Math.ceil((h >> 1) - h / dist / 2) + 1;
    const bot = Math.floor((h >> 1) + h / dist / 2) - 1;
    // Facing north, screen right is +x: the column where world x crosses an integer is a seam.
    const planeLen = (0.5 * w) / h;
    for (let tx = Math.ceil(camX - 3); tx <= camX + 3; tx++) {
      const sx = Math.round((w / 2) * (1 + (tx - camX) / (dist * planeLen)));
      if (sx < 4 || sx > w - 5) continue;
      const left = darkRows(frame, sx - 3, top, bot);
      const right = darkRows(frame, sx + 2, top, bot);
      assert.ok(left.size > 0 && right.size > 0, `no mortar rows found beside the seam at x=${tx}`);
      seams++;
      let shared = 0;
      for (const y of left) if (right.has(y)) shared++;
      if (shared >= left.size * 0.9 && shared >= right.size * 0.9) continuous++;
    }
  }
  assert.ok(seams >= 12, `expected to measure at least 12 seams, found ${seams}`);
  assert.equal(continuous, seams, `bed joints continue across only ${continuous} of ${seams} seams`);
});

test('ceiling timber runs across the corridor whichever way the corridor runs', () => {
  // The planks and beam are painted along +x, which is across a north-south corridor. East-west
  // corridors used to get lengthwise plank stripes and, every third one, a beam down their length;
  // they now take a transposed copy. Across-corridor timber reads as horizontal bands on screen, so
  // each ceiling row is nearly uniform along x while the rows differ from each other.
  /**
   * @param {Frame} f
   * @returns {number} mean within-row variance ÷ variance of the row means, over the near ceiling
   */
  const streakiness = (f) => {
    const { w, h } = f;
    const half = h >> 1;
    const means = [];
    let within = 0;
    let n = 0;
    for (let y = 0; y < half - 40; y++) {
      const xs = [];
      for (let x = Math.round(w * 0.3); x < Math.round(w * 0.7); x++) if (!isWallPx(f, x, y)) xs.push(lumAt(f, x, y));
      if (xs.length < 40) continue;
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      means.push(m);
      within += xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
      n++;
    }
    const mm = means.reduce((a, b) => a + b, 0) / means.length;
    const between = means.reduce((a, b) => a + (b - mm) * (b - mm), 0) / means.length;
    return within / n / Math.max(1e-6, between);
  };
  const ew = corridors([3], 40);
  const ns = transposeMaze(ew);
  const alongX = streakiness(renderScene(ew, { player: { x: 5.5, y: 3.5, angle: 0 }, light: 1 }));
  const alongY = streakiness(renderScene(ns, { player: { x: 3.5, y: 5.5, angle: Math.PI / 2 }, light: 1 }));
  assert.ok(alongX < alongY * 1.6, `east-west ceiling is streaked along the corridor (${alongX.toFixed(2)} vs ${alongY.toFixed(2)} north-south)`);
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
    // A nearly empty tank, so the guttering branch of the player's torch is on the measured path.
    light: 0.15,
  });
  for (let i = 0; i < 200; i++) {
    view.time = i * 0.016;
    rc.render(view);
  }
  /**
   * Heap growth over one 2000-frame block.
   * @param {number} t0 clock offset so each block animates differently
   * @returns {number} bytes
   */
  function block(t0) {
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 2000; i++) {
      view.time = t0 + i * 0.016;
      view.player.angle = i * 0.003;
      rc.render(view);
    }
    return process.memoryUsage().heapUsed - before;
  }
  // Up to six blocks, and the smallest counts. A single sample is at the mercy of where the collector
  // happened to be, and of how far V8 has tiered the frame up: while hot helpers still run in a
  // middle tier their doubles are boxed as short-lived garbage, and under CPU load (the runner
  // starts every test file at once) that lasted past two blocks with no scavenge in between —
  // 7–17 MB of `heapUsed` on a renderer that allocates nothing once optimised. A real per-frame
  // allocation leaks in *every* block, so the minimum keeps the signal and drops that noise; the
  // loop stops at the first clean block, so a passing run still measures only one or two.
  let grown = Infinity;
  for (let b = 0; b < 6 && grown >= 3_000_000; b++) grown = Math.min(grown, block(3.2 + b * 37.5));
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

// ── MASSIVE-maze scale: the spatial index ─────────────────────────────────────────────────────
// A 128×128-cell level carries ~850 items and ~1300 torches, so the light and sprite passes now
// walk a uniform grid instead of the whole level. These tests assert the index answers what the
// exhaustive scan answered, and that flooding a level with decoration cannot push the sprite the
// player is standing next to out of the queue — the failure the old fixed-size queue actually had.

/**
 * An open hall: solid border, empty interior. Big enough to park decoration outside every draw
 * radius, which is what makes "far things change nothing" testable.
 * @param {number} size tiles per side (odd)
 * @returns {import('../core/types.js').Maze}
 */
function hall(size) {
  const tiles = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      tiles[y * size + x] = x === 0 || y === 0 || x === size - 1 || y === size - 1 ? 1 : 0;
    }
  }
  return {
    width: size,
    height: size,
    cols: (size - 1) / 2,
    rows: (size - 1) / 2,
    tiles,
    start: { x: 1, y: 1 },
    exit: { x: size - 2, y: size - 2 },
    seed: 3,
  };
}

/**
 * Deterministic pseudo-random stream, local to these tests.
 * @param {number} seed
 * @returns {() => number} 0..1
 */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Scatter torches on distinct tile coordinates inside a hall.
 * @param {number} n
 * @param {number} size hall size in tiles
 * @param {number} seed
 * @param {(x:number, y:number) => boolean} [keep] filter on tile coordinates
 * @returns {import('../core/types.js').Torch[]}
 */
function scatterTorches(n, size, seed, keep) {
  const rnd = prng(seed);
  /** @type {import('../core/types.js').Torch[]} */
  const out = [];
  /** @type {Set<number>} */
  const used = new Set();
  let guard = 0;
  while (out.length < n && guard++ < n * 60) {
    const x = 1 + ((rnd() * (size - 2)) | 0);
    const y = 1 + ((rnd() * (size - 2)) | 0);
    const key = y * size + x;
    if (used.has(key)) continue; // distinct tiles keep the nearest-8 comparison tie-free
    if (keep && !keep(x, y)) continue;
    used.add(key);
    out.push({ x, y, face: /** @type {0|1|2|3} */ ((rnd() * 4) | 0) });
  }
  return out;
}

/**
 * Scatter items on a ring or a disc around a point.
 * @param {number} n
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 * @returns {import('../core/types.js').Item[]}
 */
function ringItems(n, cx, cy, radius) {
  /** @type {import('../core/types.js').Item[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({
      id: i + 1,
      kind: /** @type {'gem'|'oil'} */ (i % 2 ? 'gem' : 'oil'),
      x: cx + Math.cos(a) * radius,
      y: cy + Math.sin(a) * radius,
      taken: false,
    });
  }
  return out;
}

test('the nearest-eight light selection through the index matches an exhaustive scan', () => {
  const { rc } = makeRenderer(640, 360);
  const size = 129;
  const maze = hall(size);
  const torches = scatterTorches(600, size, 20250915);
  // The renderer offsets a flame off its wall by exactly this before measuring distance.
  const OFF = 0.5 + 0.22;
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const view = makeView(maze, { torches, player: { x: 0, y: 0, angle: 0 }, exit: { x: 1, y: 1 } });

  for (const [px, py, angle] of [
    [64.5, 64.5, 0],
    [20.5, 90.5, 1.1],
    [100.5, 30.5, -2.4],
    [3.5, 3.5, 0.7], // hard against a corner: the ring search must not walk off the grid
    [125.5, 125.5, 3.9],
  ]) {
    view.player.x = px;
    view.player.y = py;
    view.player.angle = angle;
    view.time = 2;
    rc.render(view);

    // Brute force: the eight nearest flames to the focus point 2.5 tiles ahead of the camera.
    const fx = px + Math.cos(angle) * 2.5;
    const fy = py + Math.sin(angle) * 2.5;
    const ranked = torches
      .map((t) => {
        const lx = t.x + 0.5 + DX[t.face] * OFF;
        const ly = t.y + 0.5 + DY[t.face] * OFF;
        const dx = lx - fx;
        const dy = ly - fy;
        return { lx, ly, d2: dx * dx + dy * dy };
      })
      .sort((a, b) => a.d2 - b.d2)
      .slice(0, 8);

    const got = rc.lights();
    assert.equal(got.n, 8, `expected 8 lights at (${px},${py})`);
    /** @type {Set<string>} */
    const gotKeys = new Set();
    for (let i = 0; i < got.n; i++) gotKeys.add(`${got.x[i].toFixed(3)},${got.y[i].toFixed(3)}`);
    for (const e of ranked) {
      assert.ok(
        gotKeys.has(`${e.lx.toFixed(3)},${e.ly.toFixed(3)}`),
        `light at d=${Math.sqrt(e.d2).toFixed(2)} was missed from (${px},${py})`,
      );
    }
  }
});

test('decoration beyond the draw radius cannot change a single pixel', () => {
  const size = 161;
  const maze = hall(size);
  const near = scatterTorches(6, size, 11, (x, y) => Math.hypot(x - 80, y - 80) < 12);
  // Everything else sits past TORCH_RADIUS + FAR (34.6 tiles), so it can be neither light nor
  // sprite. Two renderers, so neither accumulates the other's ember history.
  const far = scatterTorches(1500, size, 12, (x, y) => Math.hypot(x - 80, y - 80) > 50);
  const items = ringItems(900, 80.5, 80.5, 60);
  const player = { x: 80.5, y: 80.5, angle: 0.4 };

  const a = makeRenderer(640, 360);
  a.rc.render(makeView(maze, { torches: near, player, exit: { x: 1, y: 1 }, time: 5 }));
  const lean = a.read().slice();

  const b = makeRenderer(640, 360);
  b.rc.render(
    makeView(maze, { torches: near.concat(far), items, player, exit: { x: 1, y: 1 }, time: 5 }),
  );
  assert.deepEqual(b.read(), lean, '1500 distant torches and 900 distant items must be invisible');
  assert.equal(b.rc.lights().n, near.length, 'only the near torches may be selected as lights');
});

test('a crowd of torches cannot evict the item in front of the camera', () => {
  // The regression: the sprite queue used to fill with far torches (gathered first) and then
  // silently drop every item, so gems and oil flasks vanished on a big, well-lit level.
  const size = 129;
  const maze = hall(size);
  const torches = scatterTorches(900, size, 77, (x, y) => Math.hypot(x - 64, y - 64) < 22);
  const gem = { id: 1, kind: /** @type {'gem'} */ ('gem'), x: 66.1, y: 64.5, taken: false };
  const player = { x: 64.5, y: 64.5, angle: 0 };
  const opts = { torches, items: [gem], player, exit: { x: 1, y: 1 }, time: 4 };

  const { rc, read } = makeRenderer(640, 360);
  rc.render(makeView(maze, opts));
  const withGem = read().slice();
  const drawn = rc.stats().sprites;
  assert.ok(drawn > 8, `expected a crowd of flames on screen, drew ${drawn}`);

  gem.taken = true;
  rc.render(makeView(maze, opts));
  assert.notDeepEqual(read(), withGem, 'the gem right in front of the camera must be drawn');
});

test('a pickup needs no index rebuild, and a new level does get one', () => {
  const size = 65;
  const mazeA = hall(size);
  const mazeB = hall(size);
  const torchesA = scatterTorches(200, size, 5);
  const torchesB = scatterTorches(200, size, 6);
  const items = [
    { id: 1, kind: /** @type {'gem'} */ ('gem'), x: 33.6, y: 32.5, taken: false },
    { id: 2, kind: /** @type {'oil'} */ ('oil'), x: 34.6, y: 32.5, taken: false },
  ];
  const player = { x: 32.5, y: 32.5, angle: 0 };
  const { rc, read } = makeRenderer(640, 360);

  // One view object, mutated in place, exactly as main.js drives it.
  const view = makeView(mazeA, { torches: torchesA, items, player, exit: { x: 1, y: 1 }, time: 3 });
  rc.render(view);
  const lightsA = Array.from(rc.lights().x.slice(0, rc.lights().n)).join(',');
  const bothItems = read().slice();

  // Taking an item only flips a flag; the index keeps its slot and the sprite must disappear.
  items[0].taken = true;
  rc.render(view);
  assert.notDeepEqual(read(), bothItems, 'a taken gem must disappear without a rebuild');
  items[0].taken = false;

  // A new level swaps the arrays: the index must follow, and coming back must reproduce the
  // original light selection exactly.
  view.maze = mazeB;
  view.torches = torchesB;
  rc.render(view);
  const lightsB = Array.from(rc.lights().x.slice(0, rc.lights().n)).join(',');
  assert.notEqual(lightsB, lightsA, 'a different torch set must light the scene differently');

  view.maze = mazeA;
  view.torches = torchesA;
  rc.render(view);
  assert.equal(
    Array.from(rc.lights().x.slice(0, rc.lights().n)).join(','),
    lightsA,
    'returning to a level must re-index it, not keep the other level"s buckets',
  );
});

test('render cost does not grow with the maze around the camera', () => {
  // The contract the index exists to keep: with the same local geometry and the same *density* of
  // decoration, a 513-tile level must cost what a 65-tile one costs. Wall-clock timing in a unit
  // test is noisy, so the bound is generous — but a linear scan does ~60× the gather work at 513
  // tiles and could not meet it.
  /**
   * @param {number} size
   * @returns {{ms:number, lights:number}}
   */
  function measure(size) {
    const maze = hall(size);
    const c = (size >> 1) + 0.5;
    const n = Math.max(8, ((size * size) / 40) | 0);
    const torches = scatterTorches(n, size, 31);
    const rnd = prng(size * 2654435761);
    /** @type {import('../core/types.js').Item[]} */
    const items = [];
    for (let i = 0; i < n; i++) {
      items.push({
        id: i + 1,
        kind: /** @type {'gem'|'oil'} */ (i % 2 ? 'gem' : 'oil'),
        x: 1.5 + rnd() * (size - 3),
        y: 1.5 + rnd() * (size - 3),
        taken: false,
      });
    }
    const { rc } = makeRenderer(480, 240);
    const view = makeView(maze, {
      torches,
      items,
      player: { x: c, y: c, angle: 0 },
      exit: { x: 1, y: 1 },
      time: 1,
    });
    for (let i = 0; i < 90; i++) {
      view.time = 1 + i * 0.016;
      view.player.angle = i * 0.1;
      rc.render(view);
    }
    const t0 = performance.now();
    for (let i = 0; i < 150; i++) {
      view.time = 4 + i * 0.016;
      view.player.angle = i * 0.05;
      rc.render(view);
    }
    return { ms: (performance.now() - t0) / 150, lights: rc.stats().lights };
  }

  const small = measure(65);
  const huge = measure(513); // 263 k tiles, ~6 500 torches and ~6 500 items
  assert.equal(huge.lights, 8);
  assert.ok(
    huge.ms < small.ms * 2 + 1,
    `render cost must not track maze size: ${small.ms.toFixed(3)} ms at 65 tiles vs ` +
      `${huge.ms.toFixed(3)} ms at 513 tiles`,
  );
});

test('the sprite draw radius is where fog has already swallowed a billboard', () => {
  // `SPRITE_FAR` (~21 tiles) is derived from the fog curve rather than tuned: past it a sprite's
  // shade level truncates to 0, which *is* the fog colour the frame was cleared to. If that
  // derivation were wrong, items would pop out of existence in mid-corridor — so assert directly
  // that a ring of items sitting between the sprite radius and the wall radius (`FAR` = 30) leaves
  // the frame byte-identical. Items are used rather than torches because an item can never also be
  // a light, which keeps the comparison about culling alone.
  const size = 161;
  const maze = hall(size);
  const torches = scatterTorches(9, size, 43, (x, y) => Math.hypot(x - 80, y - 80) < 9);
  const player = { x: 80.5, y: 80.5, angle: 0.9 };
  const base = { torches, player, exit: { x: 1, y: 1 }, time: 6 };

  const a = makeRenderer(640, 360);
  a.rc.render(makeView(maze, base));
  const empty = a.read().slice();

  for (const radius of [22, 24, 27, 29]) {
    const r = makeRenderer(640, 360);
    r.rc.render(makeView(maze, { ...base, items: ringItems(400, 80.5, 80.5, radius) }));
    assert.deepEqual(r.read(), empty, `items at ${radius} tiles must be pure fog`);
  }

  // …and the radius is not so conservative that a sprite the player should see is dropped: one at
  // 18 tiles still changes the frame.
  const visible = makeRenderer(640, 360);
  visible.rc.render(makeView(maze, { ...base, items: ringItems(400, 80.5, 80.5, 18) }));
  assert.notDeepEqual(visible.read(), empty, 'items at 18 tiles must still be drawn');
});
