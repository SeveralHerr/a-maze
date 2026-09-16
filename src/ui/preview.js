// @ts-check
/**
 * @file Standalone harness for `src/ui` — every screen, over a painted stand-in for the 3-D view,
 * driven by a hand-built `GameState`.
 *
 * It exists so the interface can be judged and screenshotted without the rest of the game, and it
 * doubles as executable documentation of the UI seam: this file wires the HUD and the menus exactly
 * the way `src/main.js` has to (resize → `hud.render` → `menus.render`, input through
 * `handleInput`/`handlePointer`, settings written back through `onSetting`).
 *
 * It imports only `src/core` and `src/ui` — the same budget the shipped modules have
 * (ARCHITECTURE.md §2) — so the maze it shows is generated here rather than borrowed from
 * `src/maze`.
 *
 * Not shipped: `index.html` loads `src/main.js`, not this page.
 */

import { createRng } from '../core/rng.js';
import { clamp, clamp01, wrapAngle } from '../core/math.js';
import { createHud } from './hud.js';
import { createMenus } from './menus.js';
import { COLOR, drawText, faceInfo, fontMetrics, glyphMask } from './font.js';

/** @typedef {import('../core/types.js').GameState} GameState */
/** @typedef {import('../core/types.js').InputFrame} InputFrame */
/** @typedef {import('../core/types.js').InputAction} InputAction */

// ─── Query parameters ────────────────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const screenParam = params.get('screen') || 'hud';
const timeParam = params.get('t');
const frozen = timeParam !== null;
const levelParam = Number(params.get('level') || '3');
const lowFuel = params.get('low') === '1';
const mapParam = params.get('map');
/** Cells per side of the demo maze. `?cells=128` shoots the 128×128 cap — the worst case. */
const cellsParam = Number(params.get('cells') || '24');
const reducedMotion = params.get('reduced') === '1';
const showHint = params.get('hint') === '1';

// ─── A hand-built level ──────────────────────────────────────────────────────────────────────

/**
 * Logical cells per side of the demo maze.
 *
 * The default (24) is depth 2 of the shipped curve; `?cells=128` builds the 128×128 cap — 257×257
 * tiles, the worst case the map has to stay legible and under a millisecond at.
 */
const CELLS = Number.isFinite(cellsParam) ? clamp(Math.round(cellsParam), 4, 200) : 24;
/** Tile map size for a "thick wall" maze of `CELLS` cells (ARCHITECTURE.md §6). */
const MAP_W = CELLS * 2 + 1;
const MAP_H = CELLS * 2 + 1;

/**
 * Carve a perfect maze with an iterative randomized depth-first search — the same algorithm
 * `src/maze/generator.js` uses, reimplemented in twenty lines because the UI module may not import
 * the maze module.
 * @param {number} seed
 * @returns {Uint8Array} tiles, 1 = wall
 */
function carve(seed) {
  const rng = createRng(seed);
  const tiles = new Uint8Array(MAP_W * MAP_H).fill(1);
  const stack = new Int32Array(CELLS * CELLS * 2);
  const seen = new Uint8Array(CELLS * CELLS);
  let sp = 0;
  stack[sp++] = 0;
  stack[sp++] = 0;
  seen[0] = 1;
  tiles[1 * MAP_W + 1] = 0;
  const dirs = new Int32Array([1, 0, 0, 1, -1, 0, 0, -1]);
  const order = new Int32Array([0, 1, 2, 3]);
  while (sp > 0) {
    const cy = stack[--sp];
    const cx = stack[--sp];
    rng.shuffle(order);
    let advanced = false;
    for (let k = 0; k < 4; k++) {
      const d = order[k];
      const nx = cx + dirs[d * 2];
      const ny = cy + dirs[d * 2 + 1];
      if (nx < 0 || ny < 0 || nx >= CELLS || ny >= CELLS) continue;
      if (seen[ny * CELLS + nx] !== 0) continue;
      seen[ny * CELLS + nx] = 1;
      tiles[(cy * 2 + 1 + dirs[d * 2 + 1]) * MAP_W + (cx * 2 + 1 + dirs[d * 2])] = 0;
      tiles[(ny * 2 + 1) * MAP_W + (nx * 2 + 1)] = 0;
      stack[sp++] = cx;
      stack[sp++] = cy;
      stack[sp++] = nx;
      stack[sp++] = ny;
      advanced = true;
      break;
    }
    if (!advanced && sp === 0) break;
  }
  return tiles;
}

const tiles = carve(0x5eed);

/**
 * Flood the explored set out from the start, so the minimap shows a believable, connected,
 * partially-revealed region rather than a perfect rectangle.
 * @param {number} budget tiles to reveal
 * @returns {Uint8Array}
 */
function floodExplored(budget) {
  const explored = new Uint8Array(MAP_W * MAP_H);
  const queue = new Int32Array(MAP_W * MAP_H);
  let head = 0;
  let tail = 0;
  queue[tail++] = 1 * MAP_W + 1;
  explored[1 * MAP_W + 1] = 1;
  let revealed = 0;
  while (head < tail && revealed < budget) {
    const i = queue[head++];
    revealed++;
    const x = i % MAP_W;
    const y = (i / MAP_W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 2 ? -1 : 0);
      const ny = y + (d === 1 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      const ni = ny * MAP_W + nx;
      if (explored[ni] !== 0) continue;
      explored[ni] = 1;
      // Walls are revealed but not walked through — exactly what the real fog-of-war does.
      if (tiles[ni] === 0) queue[tail++] = ni;
    }
  }
  return explored;
}

/** Items scattered on floor tiles, for the gem counter and the tally. */
const items = (() => {
  /** @type {Array<{id:number, kind:'gem'|'oil', x:number, y:number, taken:boolean}>} */
  const out = [];
  const rng = createRng(0xbeef);
  let id = 1;
  // Density, not a fixed handful: the shipped curve puts one flask per ~20 cells and one gem
  // per ~50, so a 128-cell level carries ~900 items. The preview matches that, because "nothing
  // may be O(items) per frame" is only tested by actually having the items.
  const wanted = Math.max(8, Math.round((CELLS * CELLS) / 16));
  for (let i = 0; i < wanted; i++) {
    for (let tries = 0; tries < 40; tries++) {
      const tx = 1 + rng.int(MAP_W - 2);
      const ty = 1 + rng.int(MAP_H - 2);
      if (tiles[ty * MAP_W + tx] !== 0) continue;
      out.push({
        id: id++,
        kind: i % 5 === 4 ? 'oil' : 'gem',
        x: tx + 0.5,
        y: ty + 0.5,
        taken: i < 5,
      });
      break;
    }
  }
  return out;
})();

const gemsTotal = items.reduce((n, it) => n + (it.kind === 'gem' ? 1 : 0), 0);

/** The demo level, shaped exactly like `LevelData` (§3). */
const levelData = {
  maze: {
    width: MAP_W,
    height: MAP_H,
    cols: CELLS,
    rows: CELLS,
    tiles,
    start: { x: 1, y: 1 },
    exit: { x: MAP_W - 2, y: MAP_H - 2 },
    seed: 0x5eed,
  },
  validation: {
    solvable: true,
    fullyConnected: true,
    bordersSealed: true,
    pathLength: 60,
    floorCount: 200,
    deadEnds: 12,
    loops: 0,
    path: null,
    errors: [],
  },
  items,
  torches: [],
  fuel: 120,
  par: 60,
};

// ─── The fake state ──────────────────────────────────────────────────────────────────────────

/**
 * A complete `GameState` (§3), built by hand. Every field the UI reads is present and plausible;
 * the preview mutates it directly, which is the one place that is allowed to, because there is no
 * store here.
 * @type {GameState}
 */
const state = {
  phase: 'playing',
  time: 0,
  phaseTime: 0,
  level: Number.isFinite(levelParam) ? clamp(Math.round(levelParam), 1, 40) : 3,
  seed: 0x5eed,
  levelData: /** @type {any} */ (levelData),
  player: { x: 1.5, y: 1.5, angle: 0, px: 1.5, py: 1.5, pangle: 0, vx: 0, vy: 0, bob: 0, bobAmp: 0, shake: 0 },
  explored: floodExplored(Math.round(MAP_W * MAP_H * 0.45)),
  run: {
    score: 4820,
    gems: 7,
    gemsTotal,
    fuel: lowFuel ? 16 : 78,
    fuelMax: 120,
    levelTime: 97,
    totalTime: 320,
    levelScore: 0,
    bestCombo: 3,
    // Optional fields the end screens show when `src/state` carries them (see the integrator note
    // for this wave). The preview supplies them so the four-row summary layout is exercised.
    refuels: 4,
    distance: 1240,
  },
  best: { score: 12750, level: 6 },
  settings: {
    volume: 0.8,
    music: 0.55,
    sensitivity: 1,
    scanlines: true,
    minimap: mapParam !== 'off',
    reducedMotion,
    invertLook: false,
  },
  derived: { exitDist: 14, nearExit: 0.2, lowFuel: lowFuel },
  events: [],
};

// ─── Wiring ──────────────────────────────────────────────────────────────────────────────────

const backCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('back'));
const overlay = /** @type {HTMLCanvasElement} */ (document.getElementById('overlay'));
const hintEl = document.getElementById('hint');

const hud = createHud(overlay, mapParam === null ? undefined : { map: /** @type {any} */ (mapParam) });
const menus = createMenus(overlay, {
  onNewGame: () => {
    state.phase = 'loading';
    state.phaseTime = 0;
    state.level = 1;
    state.run.score = 0;
    state.run.gems = 0;
    state.run.fuel = state.run.fuelMax;
    // The real game waits for the maze worker; the preview just counts to one second.
    setTimeout(() => {
      if (state.phase === 'loading') {
        state.phase = 'playing';
        state.phaseTime = 0;
      }
    }, 1200);
  },
  onResume: () => {
    state.phase = 'playing';
    state.phaseTime = 0;
  },
  onQuit: () => {
    state.phase = 'title';
    state.phaseTime = 0;
  },
  onNextLevel: () => {
    state.level++;
    state.phase = 'loading';
    state.phaseTime = 0;
    setTimeout(() => {
      if (state.phase === 'loading') {
        state.phase = 'playing';
        state.phaseTime = 0;
        state.run.fuel = state.run.fuelMax;
        state.run.levelTime = 0;
      }
    }, 1200);
  },
  onSetting: (key, value) => {
    // Stands in for `store.dispatch({type:'setSetting'})`.
    /** @type {any} */ (state.settings)[key] = value;
  },
  onUiSound: (type) => {
    uiSounds.push(type);
    uiSoundCount++;
    if (uiSounds.length > 8) uiSounds.shift();
  },
});

/** Ring of the last few UI sound requests, shown by `?hint=1` (stands in for `audio.js`). */
/** @type {string[]} */
const uiSounds = [];

/** Monotonic count of UI sounds — the screenshot driver uses it to find the menu rows. */
let uiSoundCount = 0;

/**
 * Put the preview into one of the screens.
 * @param {string} name
 * @returns {void}
 */
function setScreen(name) {
  switch (name) {
    case 'title':
      state.phase = 'title';
      break;
    case 'loading':
      state.phase = 'loading';
      break;
    case 'pause':
      state.phase = 'paused';
      break;
    case 'complete':
      state.phase = 'levelComplete';
      state.run.levelScore = 500 * state.level + Math.floor(state.run.fuel) * 10 * state.level;
      state.run.score += state.run.levelScore;
      break;
    case 'gameover':
      state.phase = 'gameOver';
      state.run.fuel = 0;
      state.run.score = 13100;
      state.best.score = 13100;
      break;
    case 'options':
    case 'credits': {
      // The sub-screens are internal to `menus`; reach them the way a player does — by pressing
      // Down to the row and confirming.
      state.phase = 'title';
      const steps = name === 'options' ? 1 : 2;
      for (let i = 0; i < steps; i++) menus.handleInput(frameWith('down'), state);
      menus.handleInput(frameWith('confirm'), state);
      break;
    }
    case 'font':
      break;
    default:
      state.phase = 'playing';
      break;
  }
  state.phaseTime = 0;
}

/** One reusable input frame, mirroring the no-allocation contract of `src/input` (§4.3). */
/** @type {InputFrame} */
const frame = {
  moveX: 0,
  moveY: 0,
  turn: 0,
  lookDX: 0,
  sprint: false,
  pressed: new Set(),
};

/**
 * The shared frame with exactly one action pressed.
 * @param {InputAction} action
 * @returns {InputFrame}
 */
function frameWith(action) {
  frame.pressed.clear();
  frame.pressed.add(action);
  return frame;
}

// ── Keyboard ──
/** @type {Record<string, InputAction>} */
const KEYS = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Enter: 'confirm',
  Space: 'confirm',
  Escape: 'back',
  KeyP: 'pause',
  KeyM: 'map',
};

window.addEventListener('keydown', (ev) => {
  const action = KEYS[ev.code];
  if (action === undefined) return;
  ev.preventDefault();
  if (state.phase === 'playing' && (action === 'back' || action === 'pause')) {
    state.phase = 'paused';
    state.phaseTime = 0;
    return;
  }
  menus.handleInput(frameWith(action), state);
  frame.pressed.clear();
});

// ── Pointer ──
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerleave']) {
  overlay.addEventListener(type, (ev) => {
    if (menus.handlePointer(/** @type {PointerEvent} */ (ev))) ev.preventDefault();
  });
}

// ─── Backdrop ────────────────────────────────────────────────────────────────────────────────

/**
 * Paint a cheap stand-in for the raycaster: a dark corridor with a warm pool of torchlight, so the
 * overlay is judged over something with the right values and colours instead of flat black.
 * @param {number} t seconds
 * @returns {void}
 */
function drawBackdrop(t) {
  const ctx = backCanvas.getContext('2d');
  if (ctx === null) return;
  const w = backCanvas.width;
  const h = backCanvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;

  // Ceiling timber → wall stone → cobble floor.
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#140c06');
  sky.addColorStop(0.34, '#1d2433');
  sky.addColorStop(0.56, '#2b3446');
  sky.addColorStop(0.62, '#211e1b');
  sky.addColorStop(1, '#0d0c0b');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Receding block courses, dark to light toward the vanishing point.
  const cx = w / 2;
  const cy = h * 0.55;
  const blocks = 7;
  for (let i = blocks; i >= 1; i--) {
    const k = i / blocks;
    const bw = w * 0.5 * k;
    const bh = h * 0.62 * k;
    const shade = 0.18 + 0.1 * (1 - k);
    ctx.strokeStyle = `rgba(138,155,176,${shade.toFixed(3)})`;
    ctx.lineWidth = Math.max(1, Math.round(h / 240));
    ctx.strokeRect(Math.round(cx - bw), Math.round(cy - bh * 0.62), Math.round(bw * 2), Math.round(bh));
  }

  // Torchlight pool, breathing slightly.
  const flicker = 0.86 + 0.14 * Math.sin(t * 7.3) * Math.sin(t * 3.1);
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, h * 0.75 * flicker);
  glow.addColorStop(0, 'rgba(255,170,60,0.30)');
  glow.addColorStop(0.35, 'rgba(194,65,12,0.16)');
  glow.addColorStop(1, 'rgba(10,14,24,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // Edge darkening, the way the post stack will do it for real.
  const vig = ctx.createRadialGradient(cx, cy, h * 0.2, cx, cy, h * 0.95);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(3,4,8,0.85)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
}

// ─── Font proof sheet ────────────────────────────────────────────────────────────────────────

/**
 * `?screen=font`: every glyph of both faces, so the atlas pipeline can be eyeballed.
 * @returns {void}
 */
function drawFontSheet() {
  const ctx = hud.surface.beginFrame();
  if (ctx === null) return;
  const m = hud.surface.metrics;
  ctx.fillStyle = withAlphaLocal(COLOR.void, 0.72);
  ctx.fillRect(0, 0, m.w, m.h);

  const u = m.u;
  const rows = [
    'ABCDEFGHIJKLM',
    'NOPQRSTUVWXYZ',
    'abcdefghijklm',
    'nopqrstuvwxyz',
    '0123456789 ©×…',
    '!"#$%&\'()*+,-./',
    ':;<=>?@[\\]^_`{|}~',
  ];
  const info = faceInfo('display');
  const hudInfo = faceInfo('hud');

  // Lay the sheet out from its measured height, shrinking the specimen size until it fits.
  const title = fontMetrics({ font: 'display', size: Math.max(2, u * 2) });
  let scale = Math.max(1, u);
  let dispLine = 0;
  let hudLine = 0;
  let footer = 0;
  let total = 0;
  for (;;) {
    dispLine = fontMetrics({ font: 'display', size: scale }).lineHeight;
    hudLine = fontMetrics({ font: 'hud', size: scale }).lineHeight;
    footer = fontMetrics({ font: 'hud', size: scale }).height;
    total = title.height + 4 * u + rows.length * (dispLine + hudLine) + 4 * u + footer;
    if (total <= m.h - 4 * u || scale <= 1) break;
    scale--;
  }
  let y = Math.max(2 * u, Math.round((m.h - total) / 2));

  drawText(ctx, 'A-MAZE', Math.round(m.w / 2), y, {
    font: 'display',
    size: Math.max(2, u * 2),
    color: 'gothic',
    align: 'center',
  });
  y += title.height + 4 * u;
  for (let i = 0; i < rows.length; i++) {
    drawText(ctx, rows[i], 3 * u, y, { font: 'display', size: scale, color: 'gothic' });
    y += dispLine;
  }
  for (let i = 0; i < rows.length; i++) {
    drawText(ctx, rows[i], 3 * u, y, { font: 'hud', size: scale, color: 'hud' });
    y += hudLine;
  }
  drawText(
    ctx,
    `display ${info.glyphCount} glyphs h${info.height}  ·  hud ${hudInfo.glyphCount} glyphs h${hudInfo.height}`,
    3 * u,
    y + 4 * u,
    { font: 'hud', size: scale, color: 'hudDim' },
  );
  hud.surface.endFrame();
  // Reference the glyph API so the harness fails loudly if it ever disappears.
  if (glyphMask('display', 'A') === null) throw new Error('preview: display face lost its A');
}

/**
 * Local copy of `withAlpha` (hud.js exports it, but the font sheet is the only user here and
 * importing it would pull the HUD's whole surface machinery into this path anyway).
 * @param {string} hex
 * @param {number} a
 * @returns {string}
 */
function withAlphaLocal(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ─── Simulated play ──────────────────────────────────────────────────────────────────────────

/** Where the demo camera is heading, in tiles. */
let targetX = 1.5;
let targetY = 1.5;
let scoreTimer = 0;

/**
 * Walk the demo player along open corridors so the minimap arrow and the compass move.
 * @param {number} dt seconds
 * @returns {void}
 */
function walk(dt) {
  const p = state.player;
  const dx = targetX - p.x;
  const dy = targetY - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.08) {
    // Pick an adjacent open tile, preferring not to turn back.
    const options = [];
    for (let dir = 0; dir < 4; dir++) {
      const nx = Math.floor(p.x) + (dir === 0 ? 1 : dir === 2 ? -1 : 0);
      const ny = Math.floor(p.y) + (dir === 1 ? 1 : dir === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      if (tiles[ny * MAP_W + nx] !== 0) continue;
      options.push([nx + 0.5, ny + 0.5]);
    }
    if (options.length > 0) {
      const pick = options[(state.time * 3.7) % options.length | 0];
      targetX = pick[0];
      targetY = pick[1];
    }
    return;
  }
  const speed = 2.2;
  p.px = p.x;
  p.py = p.y;
  p.pangle = p.angle;
  p.x += (dx / d) * Math.min(speed * dt, d);
  p.y += (dy / d) * Math.min(speed * dt, d);
  const want = Math.atan2(dy, dx);
  p.angle = wrapAngle(p.angle + wrapAngle(want - p.angle) * Math.min(1, dt * 6));
  p.bob += speed * dt * 9;
  p.bobAmp = 0.8;

  const idx = Math.floor(p.y) * MAP_W + Math.floor(p.x);
  if (state.explored !== null) state.explored[idx] = 1;

  state.run.levelTime += dt;
  state.run.fuel = Math.max(0, state.run.fuel - dt * (lowFuel ? 0.4 : 0.6));
  state.derived.exitDist = Math.hypot(
    levelData.maze.exit.x + 0.5 - p.x,
    levelData.maze.exit.y + 0.5 - p.y,
  );
  state.derived.nearExit = clamp01(1 - state.derived.exitDist / 8);
  state.derived.lowFuel = state.run.fuel <= state.run.fuelMax * 0.2;

  // A pickup every few seconds, so the rolling score and the "+N" pops are always on show.
  scoreTimer += dt;
  if (scoreTimer > 3.2) {
    scoreTimer = 0;
    state.run.score += 100 * state.level;
    if (state.run.gems < state.run.gemsTotal) state.run.gems++;
  }
}

// ─── Frame loop ──────────────────────────────────────────────────────────────────────────────

let lastTs = 0;

/**
 * Frame statistics in the shape `src/core/loop.js` reports, so the `?debug=1` HUD line is exercised
 * exactly as it will be in the game. Reused, never reallocated — same contract as the real one.
 * @type {import('../core/types.js').FrameStats}
 */
const frameStats = {
  fps: 60,
  frameMsAvg: 16.7,
  frameMsP99: 18.2,
  stepMsAvg: 0.4,
  renderMsAvg: 2.1,
  droppedFrames: 0,
  samples: 120,
  skippedSteps: 0,
};

/**
 * Size both canvases to the window.
 * @returns {void}
 */
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  backCanvas.width = Math.max(1, Math.round(w * dpr));
  backCanvas.height = Math.max(1, Math.round(h * dpr));
  hud.resize(w, h, dpr);
  menus.resize(w, h, dpr);
}
window.addEventListener('resize', onResize, { passive: true });
onResize();

/**
 * Draw one frame.
 * @param {number} dt seconds of simulated time to advance first
 * @returns {void}
 */
function step(dt) {
  state.time += dt;
  state.phaseTime += dt;
  if (state.phase === 'playing') walk(dt);

  drawBackdrop(state.time);
  if (screenParam === 'font') {
    drawFontSheet();
    return;
  }
  hud.render(state, frameStats, 0);
  menus.render(state);

  if (showHint && hintEl !== null) {
    hintEl.hidden = false;
    const m = hud.surface.metrics;
    const ms = hud.mapStats();
    hintEl.textContent =
      `screen ${menus.screen()}  phase ${state.phase}  map ${hud.mapMode(state.settings)}
` +
      `ui ${m.w}x${m.h} @${m.px}  u${m.u}  dpr${(m.devW / m.cssW).toFixed(2)}
` +
      `maze ${CELLS}x${CELLS} (${MAP_W}x${MAP_H} tiles)  items ${items.length}
` +
      `map upd ${ms.updateMs.toFixed(3)}ms draw ${ms.drawMs.toFixed(3)}ms  scan ${ms.scanned} paint ${ms.painted} seen ${ms.explored}/${ms.tiles}
` +
      `sfx ${uiSounds.join(' ')}`;
  }
}

setScreen(screenParam);

if (frozen) {
  // Deterministic single frame for screenshots: advance the clock in fixed steps so animations
  // land in exactly the same place every time.
  const target = Number(timeParam) || 0;
  const fixed = 1 / 60;
  for (let t = 0; t < target; t += fixed) step(fixed);
  step(0);
} else {
  /**
   * @param {number} ts milliseconds
   * @returns {void}
   */
  const tick = (ts) => {
    const dt = lastTs === 0 ? 1 / 60 : Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    step(dt);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Expose the pieces for the screenshot driver and for poking in devtools.
/** @type {any} */ (window).__ui = {
  state,
  hud,
  menus,
  setScreen,
  step,
  sfx: uiSounds,
  sfxCount: () => uiSoundCount,
  /** Map cost accounting, for the screenshot driver's performance assertions. */
  mapStats: () => hud.mapStats(),
  /** Force a map state without walking the options screen. */
  setMap: (mode) => {
    let now = hud.mapMode(state.settings);
    for (let i = 0; i < 3 && now !== mode; i++) now = hud.cycleMap(state.settings);
    return now;
  },
  /** What the demo level actually is, so the driver can label its measurements. */
  maze: { cells: CELLS, tiles: MAP_W, items: items.length },
};
