// @ts-check
/**
 * @file Test-only helpers for rendering the overlay headlessly and auditing its layout.
 *
 * Not a test file itself (`tools/test.mjs` runs `*.test.mjs`; this is `*.test-util.mjs`, the same
 * convention as `src/input/fake-dom.test-util.mjs`).
 *
 * What it provides:
 * - {@link installFakeDocument} — a `document.createElement('canvas')` whose 2-D context accepts
 *   the calls the UI makes. With it the glyph atlases and the map raster are built in Node, so the
 *   **whole** draw path runs (every glyph blit, the full map), not just the layout arithmetic.
 * - {@link drawableCanvas} — an overlay canvas stand-in with a no-op context and a bounding rect.
 * - {@link collectLayout} / {@link auditLayout} — record every line of text, every art blit and
 *   every panel through `font.setLayoutProbe`, then check the rules a readable overlay depends on:
 *   no two lines of text intersect, nothing leaves the surface, and any text that touches a panel
 *   sits entirely inside that panel's frame (drop shadow and, for the display face, outline
 *   included).
 * - {@link playingState} / {@link menuState} — complete `GameState`s for driving it.
 */

import { setLayoutProbe } from './font.js';

/** A 2-D context that accepts every call the overlay makes and draws nothing. @returns {any} */
export function noopContext() {
  const noop = () => {};
  return {
    globalAlpha: 1,
    fillStyle: '',
    imageSmoothingEnabled: false,
    setTransform: noop,
    clearRect: noop,
    fillRect: noop,
    drawImage: noop,
    save: noop,
    restore: noop,
    beginPath: noop,
    rect: noop,
    clip: noop,
    putImageData: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createImageData: (/** @type {number} */ w, /** @type {number} */ h) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
}

/**
 * Give Node a `document` that can make canvases, so atlases and map rasters are really built.
 * @returns {() => void} restores the previous global
 */
export function installFakeDocument() {
  const g = /** @type {any} */ (globalThis);
  const had = Object.prototype.hasOwnProperty.call(g, 'document');
  const previous = g.document;
  g.document = {
    createElement: () => {
      const ctx = noopContext();
      return { width: 0, height: 0, getContext: () => ctx };
    },
  };
  return () => {
    if (had) g.document = previous;
    else delete g.document;
  };
}

/**
 * An overlay canvas laid out at `cssW × cssH` at the page origin.
 * @param {number} cssW
 * @param {number} cssH
 * @returns {any}
 */
export function drawableCanvas(cssW, cssH) {
  const ctx = noopContext();
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssW, height: cssH }),
  };
}

/**
 * The world band a portrait phone letterboxes into, in CSS pixels: a 4:3 box the width of the
 * screen, centred at 42 % of the height (ARCHITECTURE.md §4.7 "Layout").
 * @param {number} cssW
 * @param {number} cssH
 * @returns {[number, number, number, number]} x, y, w, h
 */
export function portraitBand(cssW, cssH) {
  const h = Math.round((cssW * 3) / 4);
  return [0, Math.round(cssH * 0.42 - h / 2), cssW, h];
}

/**
 * One recorded box.
 * @typedef {{kind:string, x:number, y:number, w:number, h:number, unit:number, label:string}} LayoutBox
 */

/**
 * Run `draw` with the layout probe installed and return every box it reported.
 * @param {() => void} draw
 * @returns {LayoutBox[]}
 */
export function collectLayout(draw) {
  /** @type {LayoutBox[]} */
  const boxes = [];
  setLayoutProbe((kind, x, y, w, h, unit, label) => boxes.push({ kind, x, y, w, h, unit, label }));
  try {
    draw();
  } finally {
    setLayoutProbe(null);
  }
  return boxes;
}

/**
 * Check a frame's boxes against the layout rules. Returns human-readable problems (empty = clean).
 * @param {LayoutBox[]} boxes
 * @param {{w:number, h:number}} surface UI-pixel size of the surface
 * @returns {string[]}
 */
export function auditLayout(boxes, surface) {
  const texts = boxes.filter((b) => b.kind === 'text' || b.kind === 'art');
  const panels = boxes.filter((b) => b.kind === 'panel');
  /** @type {string[]} */
  const problems = [];
  for (let i = 0; i < texts.length; i++) {
    const a = texts[i];
    if (a.x < 0 || a.y < 0 || a.x + a.w > surface.w || a.y + a.h > surface.h) {
      problems.push(`"${a.label}" leaves the ${surface.w}×${surface.h} surface at ${a.x},${a.y} ${a.w}×${a.h}`);
    }
    for (let j = i + 1; j < texts.length; j++) {
      const b = texts[j];
      if (intersects(a, b)) problems.push(`"${a.label}" overprints "${b.label}"`);
    }
    for (const p of panels) {
      if (!intersects(a, p)) continue;
      // Ink box: the HUD face adds a one-pixel drop shadow right; the display face (12 rows per
      // scale step) adds an outline all round plus its shadow.
      const s = a.unit;
      const display = a.kind === 'text' && a.h === 12 * s;
      const x0 = display ? a.x - s : a.x;
      const y0 = display ? a.y - s : a.y;
      const x1 = a.x + a.w + (display ? 2 * s : s);
      const y1 = a.y + a.h + (display ? 2 * s : 0);
      // `drawPanel` paints a border and a bevel: two borders of frame.
      const ix0 = p.x + 2 * p.unit;
      const iy0 = p.y + 2 * p.unit;
      const ix1 = p.x + p.w - 2 * p.unit;
      const iy1 = p.y + p.h - 2 * p.unit;
      if (x0 < ix0 || y0 < iy0 || x1 > ix1 || y1 > iy1) {
        problems.push(
          `"${a.label}" [${x0},${y0}–${x1},${y1}] is not inside its ${p.label} panel's frame [${ix0},${iy0}–${ix1},${iy1}]`,
        );
      }
    }
  }
  return problems;
}

/**
 * Half-open rectangle intersection.
 * @param {{x:number, y:number, w:number, h:number}} a
 * @param {{x:number, y:number, w:number, h:number}} b
 * @returns {boolean}
 */
export function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * A playing state over a 16×16-cell thick-wall maze with a fog grid, a big score and every optional
 * run field present — the widest readouts the HUD lays out.
 * @param {string} [phase]
 * @returns {any}
 */
export function playingState(phase = 'playing') {
  const cols = 16;
  const width = cols * 2 + 1;
  const tiles = new Uint8Array(width * width).fill(1);
  for (let cy = 0; cy < cols; cy++) {
    for (let cx = 0; cx < cols; cx++) tiles[(cy * 2 + 1) * width + cx * 2 + 1] = 0;
  }
  const explored = new Uint8Array(width * width);
  for (let i = 0; i < 300; i++) explored[i] = 1;
  return {
    phase,
    time: 3,
    phaseTime: 3,
    level: 15,
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
      fuel: 150,
      par: 55,
    },
    player: { x: 1.5, y: 1.5, angle: 0.3, px: 1.5, py: 1.5, pangle: 0.3, vx: 0, vy: 0, bob: 0, bobAmp: 0, shake: 0 },
    explored,
    run: {
      score: 193740,
      gems: 12,
      gemsTotal: 273,
      fuel: 60,
      fuelMax: 150,
      levelTime: 642,
      totalTime: 3900,
      levelScore: 30000,
      bestCombo: 2,
      refuels: 14,
      distance: 12400,
    },
    best: { score: 250000, level: 16 },
    settings: {
      volume: 0.8,
      music: 0.55,
      sensitivity: 1,
      scanlines: true,
      minimap: true,
      mapMode: 'corner',
      reducedMotion: false,
      invertLook: false,
    },
    derived: { exitDist: 137.2, nearExit: 0, lowFuel: false },
    events: [],
  };
}

/** The viewports every layout is audited at: desktop 720p, a phone at dpr 3 and 2, and a phone on its side. */
export const VIEWPORTS = Object.freeze([
  Object.freeze({ w: 1280, h: 720, dpr: 1, name: '1280x720' }),
  Object.freeze({ w: 390, h: 844, dpr: 3, name: '390x844@3' }),
  Object.freeze({ w: 390, h: 844, dpr: 2, name: '390x844@2' }),
  Object.freeze({ w: 844, h: 390, dpr: 3, name: '844x390@3' }),
  Object.freeze({ w: 1920, h: 1080, dpr: 1, name: '1920x1080' }),
]);

/**
 * The unlock catalogue as the menus receive it (ARCHITECTURE.md §4.9). A mirror of `UNLOCKS` in
 * `src/state/balance.js` — `src/ui` tests may not import state — kept to the real strings, because
 * the layout audit is only honest against the longest names and effects that actually ship.
 */
export const UNLOCK_FIXTURE = Object.freeze([
  { id: 'reservoir', name: 'Reservoir', group: 'torch', costs: [15, 30, 55, 90, 140], blurb: 'A deeper oil tank for your torch.', ranks: ['Tank +10%', 'Tank +20%', 'Tank +30%', 'Tank +40%', 'Tank +50%'] },
  { id: 'richOil', name: 'Rich Oil', group: 'torch', costs: [15, 35, 65, 110], blurb: 'Every flask burns longer.', ranks: ['Flasks +12%', 'Flasks +24%', 'Flasks +36%', 'Flasks +48%'] },
  { id: 'slowWick', name: 'Slow Wick', group: 'torch', costs: [20, 45, 85, 140], blurb: 'The flame drinks oil more slowly.', ranks: ['Burn -6%', 'Burn -12%', 'Burn -18%', 'Burn -24%'] },
  { id: 'ember', name: 'Ember Reserve', group: 'torch', costs: [25, 60, 120], blurb: 'Once per floor, a dead torch rekindles.', ranks: ['Rekindle for 10s', 'Rekindle for 18s', 'Rekindle for 28s'] },
  { id: 'siphon', name: 'Siphon', group: 'torch', costs: [20, 50, 100], blurb: 'Spilled oil is saved and poured back in.', ranks: ['Store 15s of overflow', 'Store 30s of overflow', 'Store 50s of overflow'] },
  { id: 'wideFlame', name: 'Wide Flame', group: 'sight', costs: [15, 35, 70], blurb: 'Your torch throws its light further.', ranks: ['Light +15%', 'Light +30%', 'Light +45%'] },
  { id: 'cartographer', name: 'Cartographer', group: 'sight', costs: [30, 80], blurb: 'Map what you see from further away.', ranks: ['Reveal 4 tiles', 'Reveal 5 tiles'] },
  { id: 'oilSense', name: 'Oil Sense', group: 'sight', costs: [20, 50, 100], blurb: 'Nearby flasks glow through the walls.', ranks: ['Sense within 5 tiles', 'Sense within 8 tiles', 'Sense within 12 tiles'] },
  { id: 'scrollSense', name: 'Scroll Sense', group: 'sight', costs: [15, 40], blurb: 'Feel the map scroll when it is near.', ranks: ['Sense within 14 tiles', 'Sense within 28 tiles'] },
  { id: 'whisper', name: 'Dead-End Whisper', group: 'sight', costs: [40, 100, 180], blurb: 'Passages that lead nowhere grow dark.', ranks: ['Last 4 tiles darken', 'Last 10 tiles darken', 'Whole dead ends darken'] },
  { id: 'lodestone', name: 'Lodestone', group: 'sight', costs: [150], blurb: 'Once the map is found, a needle finds the exit.', ranks: ['Needle points to the exit'] },
  { id: 'chalk', name: 'Chalk', group: 'fortune', costs: [10, 30, 70], blurb: 'Scrawl A-MAZE on a wall to mark your way.', ranks: ['4 marks per floor', '8 marks per floor', '16 marks per floor'] },
  { id: 'magnet', name: 'Gem Magnet', group: 'fortune', costs: [15, 40, 80], blurb: 'Gems in sight leap into your hand.', ranks: ['Pull within 1.2 tiles', 'Pull within 1.6 tiles', 'Pull within 2 tiles'] },
  { id: 'appraiser', name: 'Appraiser', group: 'fortune', costs: [45, 120, 240], blurb: 'Each gem is worth more at the Shrine.', ranks: ['2 shrine gems per gem', '3 shrine gems per gem', '4 shrine gems per gem'] },
]);
