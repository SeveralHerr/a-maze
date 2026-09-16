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
import { createRaycaster } from './raycaster.js';
import { createPost } from './post.js';
import { PARTICLE, PARTICLE_COLORS } from './particles.js';
import { POSES, PREVIEW_TORCHES, buildPreviewMaze, previewItems } from './preview-scene.js';

// ─── The test scene ────────────────────────────────────────────────────────────────────────────
// The maze, torches, items and poses live in `preview-scene.js` so Node tests can render exactly
// the frames this page shows.

const maze = buildPreviewMaze();
const torches = PREVIEW_TORCHES.slice();
const items = previewItems();

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
