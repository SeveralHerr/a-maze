// @ts-check
/**
 * @file Standalone harness for `src/renderer` — a hand-built 15×15 maze, a walking camera, and
 * the full effect stack, so the look can be judged and screenshotted without the rest of the game.
 *
 * It doubles as executable documentation of the renderer seam: this file builds a `RenderView`
 * exactly the way `src/main.js` will have to, drives it from `src/core/loop.js` at a fixed 60 Hz
 * with interpolated rendering, and never mutates renderer-owned state.
 *
 * Not shipped: `index.html` loads `src/main.js`, not this page.
 */

import { createLoop } from '../core/loop.js';
import { createRng } from '../core/rng.js';
import { lerpAngle, wrapAngle, clamp01 } from '../core/math.js';
import { DIR_DX, DIR_DY } from '../maze/constants.js';
import { createRaycaster } from './raycaster.js';
import { createPost } from './post.js';
import { PARTICLE, PARTICLE_COLORS } from './particles.js';

// ─── The test maze ─────────────────────────────────────────────────────────────────────────────

/**
 * Three concentric corridors joined by three doorways, with the exit portal in the middle. Chosen
 * over a generated maze because every feature the renderer has to get right is visible from a
 * short walk: long straight runs (texture perspective), inside and outside corners (wall shading),
 * doorways (sprite occlusion), and a dead centre to look back out of.
 * Legend: `#` wall, `.` floor. 15×15 tiles, sealed border, 7×7 logical cells.
 */
const MAP = [
  '###############',
  '#.............#',
  '#.#####.#####.#',
  '#.#.........#.#',
  '#.#.#######.#.#',
  '#.#.#.....#.#.#',
  '#.#.#.###.#.#.#',
  '#.#.#.#.#...#.#',
  '#.#.#.#.#.#.#.#',
  '#.#.#.....#.#.#',
  '#.#.#######.#.#',
  '#.#.........#.#',
  '#.###########.#',
  '#.............#',
  '###############',
];

/**
 * Build the `Maze` the renderer reads.
 * @returns {import('../core/types.js').Maze}
 */
function buildMaze() {
  const height = MAP.length;
  const width = MAP[0].length;
  const tiles = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = MAP[y];
    if (row.length !== width) throw new Error(`preview: map row ${y} is ${row.length} wide`);
    for (let x = 0; x < width; x++) tiles[y * width + x] = row.charCodeAt(x) === 35 ? 1 : 0;
  }
  return {
    width,
    height,
    cols: (width - 1) / 2,
    rows: (height - 1) / 2,
    tiles,
    start: { x: 1, y: 1 },
    exit: { x: 7, y: 7 },
    seed: 1,
  };
}

const maze = buildMaze();

/**
 * True when the tile is walkable.
 * @param {number} x tile x
 * @param {number} y tile y
 * @returns {boolean}
 */
function isFloor(x, y) {
  return (
    x >= 0 && y >= 0 && x < maze.width && y < maze.height && maze.tiles[y * maze.width + x] === 0
  );
}

/**
 * Wall-mounted torches. Each entry is validated below: the tile must be a wall and the tile it
 * faces must be floor, or the torch would be buried inside the masonry.
 * @type {import('../core/types.js').Torch[]}
 */
const torches = /** @type {import('../core/types.js').Torch[]} */ ([
  { x: 4, y: 0, face: 1 },
  { x: 10, y: 0, face: 1 },
  { x: 0, y: 7, face: 0 },
  { x: 14, y: 7, face: 2 },
  { x: 7, y: 14, face: 3 },
  { x: 4, y: 4, face: 3 },
  { x: 8, y: 4, face: 3 },
  { x: 2, y: 5, face: 0 },
  { x: 12, y: 5, face: 2 },
  { x: 6, y: 6, face: 3 },
  { x: 8, y: 6, face: 3 },
  { x: 6, y: 8, face: 1 },
  { x: 8, y: 8, face: 1 },
  { x: 2, y: 9, face: 0 },
  { x: 12, y: 11, face: 2 },
  { x: 4, y: 12, face: 1 },
  { x: 10, y: 12, face: 1 },
]).filter(
  // A sconce must be bolted to a wall tile and face an open one, or it would be buried inside the
  // masonry. `Torch.face` uses the maze module's direction numbering, so its tables apply directly.
  (t) => !isFloor(t.x, t.y) && isFloor(t.x + DIR_DX[t.face], t.y + DIR_DY[t.face]),
);

/**
 * Collectibles at tile centres.
 * @type {import('../core/types.js').Item[]}
 */
const items = [
  { id: 1, kind: /** @type {const} */ ('gem'), x: 5.5, y: 1.5, taken: false },
  { id: 2, kind: /** @type {const} */ ('gem'), x: 13.5, y: 5.5, taken: false },
  { id: 3, kind: /** @type {const} */ ('gem'), x: 5.5, y: 13.5, taken: false },
  { id: 4, kind: /** @type {const} */ ('gem'), x: 9.5, y: 3.5, taken: false },
  { id: 5, kind: /** @type {const} */ ('gem'), x: 5.5, y: 9.5, taken: false },
  { id: 6, kind: /** @type {const} */ ('gem'), x: 11.5, y: 9.5, taken: false },
  { id: 7, kind: /** @type {const} */ ('oil'), x: 1.5, y: 5.5, taken: false },
  { id: 8, kind: /** @type {const} */ ('oil'), x: 13.5, y: 11.5, taken: false },
  { id: 9, kind: /** @type {const} */ ('oil'), x: 7.5, y: 11.5, taken: false },
];

// ─── Camera ────────────────────────────────────────────────────────────────────────────────────

/**
 * Patrol route through every corridor ring and into the portal chamber. The camera ping-pongs
 * along it, so the walk never teleports.
 * @type {number[][]}
 */
const ROUTE = [
  [1.5, 1.5],
  [7.5, 1.5],
  [13.5, 1.5],
  [13.5, 13.5],
  [1.5, 13.5],
  [1.5, 1.5],
  [7.5, 1.5],
  [7.5, 3.5],
  [11.5, 3.5],
  [11.5, 7.5],
  [9.5, 7.5],
  [9.5, 9.5],
  [7.5, 9.5],
  [7.5, 7.5],
];

/**
 * Fixed camera poses for deterministic screenshots (`?pose=N`): `[x, y, angleRadians]`. Chosen so
 * that between them they show every feature the renderer has: long-run perspective, wall torches
 * and their light pools, both item types, the portal, and an inside corner.
 * 0 long corridor · 1 lit hall · 2 portal chamber · 3 torch close-up · 4 oil flask · 5 corner turn.
 */
const POSES = [
  [1.5, 6.5, -Math.PI / 2],
  [1.7, 1.5, 0],
  [7.5, 10.2, -Math.PI / 2],
  [3.4, 1.5, 0],
  [13.5, 13.0, -Math.PI / 2],
  [3.5, 13.5, Math.PI],
];

/** Walking speed, tiles per second. */
const SPEED = 1.35;

/** Player-ish state, mirroring `types.js` `Player` (the sim's shape). */
const player = {
  x: ROUTE[0][0],
  y: ROUTE[0][1],
  angle: 0,
  px: ROUTE[0][0],
  py: ROUTE[0][1],
  pangle: 0,
  vx: 0,
  vy: 0,
  bob: 0,
  bobAmp: 0,
  shake: 0,
};

let leg = 0;
let legDir = 1;
let simTime = 0;

/**
 * Advance the patrol by one fixed step.
 * @param {number} dt seconds (always 1/60 from the loop)
 * @returns {void}
 */
function step(dt) {
  simTime += dt;
  player.px = player.x;
  player.py = player.y;
  player.pangle = player.angle;

  const target = ROUTE[leg];
  const dx = target[0] - player.x;
  const dy = target[1] - player.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.05) {
    // Reached the waypoint: walk the route forward, then back, forever.
    leg += legDir;
    if (leg >= ROUTE.length) {
      leg = ROUTE.length - 2;
      legDir = -1;
    } else if (leg < 0) {
      leg = 1;
      legDir = 1;
    }
    return;
  }

  const stepLen = Math.min(SPEED * dt, d);
  player.x += (dx / d) * stepLen;
  player.y += (dy / d) * stepLen;
  player.vx = (dx / d) * SPEED;
  player.vy = (dy / d) * SPEED;

  // Turn toward the direction of travel over ~0.5 s, so corners read as a head turn.
  player.angle = wrapAngle(lerpAngle(player.angle, Math.atan2(dy, dx), 1 - Math.pow(0.02, dt)));

  // Head bob is driven by distance walked, not by time: it stays in step with the footfalls.
  player.bob += stepLen * 9.5;
  player.bobAmp = 0.85;
}

// ─── Wiring ────────────────────────────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const poseParam = params.get('pose');
const timeParam = params.get('t');
const lightParam = params.get('light');
const seedParam = params.get('seed');
const showStats = params.get('stats') === '1';
const scanlines = params.get('scan') !== '0';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('view'));
const postRoot = document.getElementById('post');
const statsEl = document.getElementById('stats');

const raycaster = createRaycaster(canvas, {
  seed: seedParam !== null ? Number(seedParam) : undefined,
});
const post = createPost(postRoot);

if (poseParam !== null) {
  const pose = POSES[Math.max(0, Math.min(POSES.length - 1, Number(poseParam) | 0))];
  player.x = player.px = pose[0];
  player.y = player.py = pose[1];
  player.angle = player.pangle = pose[2];
  player.bobAmp = 0;
}
if (timeParam !== null) simTime = Number(timeParam) || 0;

/** The single reusable view object — allocating one per frame is exactly what §4.5 forbids. */
/** @type {import('../core/types.js').RenderView} */
const view = {
  player: { x: 0, y: 0, angle: 0, bob: 0, bobAmp: 0, shake: 0 },
  maze,
  items,
  torches,
  exit: maze.exit,
  time: 0,
  light: 1,
  flash: { r: 255, g: 240, b: 200, a: 0 },
  portalOpen: true,
  reducedMotion: false,
};

/** Deterministic randomness for the demo sparkle bursts, so screenshots reproduce. */
const burstRng = createRng(0x5a4c);

/** Seconds since the page opened; drives the intro iris and the demo pulses. */
let wallTime = 0;

/**
 * Resize the canvas backing store and tell the post stack the new scanline pitch.
 * @returns {void}
 */
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  raycaster.resize(w, h, window.devicePixelRatio || 1);
  post.resize(w, h, raycaster.internalSize.h);
}
window.addEventListener('resize', onResize, { passive: true });
onResize();

if (statsEl) statsEl.hidden = !showStats;

/**
 * Build the view for this frame and draw it.
 * @param {number} alpha interpolation factor in [0,1)
 * @param {number} frameDt seconds since the previous frame
 * @returns {void}
 */
function render(alpha, frameDt) {
  wallTime += frameDt;
  const vp = view.player;
  const fixed = poseParam !== null;
  vp.x = fixed ? player.x : player.px + (player.x - player.px) * alpha;
  vp.y = fixed ? player.y : player.py + (player.y - player.py) * alpha;
  vp.angle = fixed ? player.angle : lerpAngle(player.pangle, player.angle, alpha);
  vp.bob = player.bob;
  vp.bobAmp = player.bobAmp;
  vp.shake = player.shake;
  view.time = timeParam !== null ? simTime : simTime + alpha * (1 / 60);

  // Torch strength sweeps slowly so a screenshot sequence shows the light radius changing, unless
  // the caller pinned it.
  view.light =
    lightParam !== null
      ? clamp01(Number(lightParam))
      : 0.55 + 0.45 * Math.sin(view.time * 0.22);

  // A pickup flash every eight seconds, and a gem sparkle burst with it, to exercise both paths.
  const flashPhase = view.time % 8;
  view.flash.a = flashPhase < 0.22 ? (1 - flashPhase / 0.22) * 0.5 : 0;
  if (flashPhase < 1 / 60 && items.length > 0) {
    const it = items[((view.time / 8) | 0) % items.length];
    raycaster.particles.burst(
      PARTICLE.SPARK,
      it.x,
      it.y,
      0.45,
      22,
      2.4,
      0.7,
      PARTICLE_COLORS.spark,
      burstRng.next,
    );
  }

  raycaster.render(view);

  post.set({
    scanlines,
    vignette: 0.72,
    // Low-fuel warning breathes when the torch is weak — the real game drives this from fuel.
    lowFuelPulse: view.light < 0.35 ? 0.25 + 0.2 * Math.sin(view.time * 6) : 0,
    flash: view.flash,
    // Opening iris for the first 1.1 s, so the transition effect is visible on load. A frozen
    // clock renders exactly one frame, so the iris must start open there or it would mask it.
    iris: timeParam !== null ? 1 : wallTime < 1.1 ? wallTime / 1.1 : 1,
  });

  if (showStats && statsEl) {
    const s = raycaster.stats();
    statsEl.textContent =
      `${s.w}×${s.h}  render ${s.ms.toFixed(2)} ms (avg ${s.msAvg.toFixed(2)})\n` +
      `fps ${loop.stats().fps.toFixed(0)}  frame ${loop.stats().frameMsAvg.toFixed(2)} ms\n` +
      `sprites ${s.sprites}  lights ${s.lights}  particles ${s.particles}\n` +
      `pos ${vp.x.toFixed(2)},${vp.y.toFixed(2)}  yaw ${((vp.angle * 180) / Math.PI).toFixed(0)}°  light ${view.light.toFixed(2)}`;
  }
}

const loop = createLoop({ step: poseParam !== null ? () => {} : step, render });

if (timeParam !== null) {
  // Frozen clock: draw exactly one frame so a screenshot is byte-reproducible.
  render(0, 0);
} else {
  loop.start();
}

// Expose the pieces for the screenshot driver and for hand-poking in devtools.
/** @type {any} */ (window).__preview = { raycaster, post, loop, view, player, maze, POSES };
