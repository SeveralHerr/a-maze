// UI review harness: drives the real game in headless Chrome and dumps a named PNG per screen, at
// a phone viewport by default, so the overlay can be *looked at* at the size its defects live at.
//
//   node tools/shot-ui.mjs --tag before                # the phone set
//   node tools/shot-ui.mjs --tag after --desktop       # and the 1280x720 set too
//   node tools/shot-ui.mjs --only play,slain           # a subset while iterating
//
// Writes logs/ui-<tag>/<shot>.png and prints a one-line geometry report per shot: the client rect
// of every touch control and of the HUD's corner map, plus any pair of them that OVERLAPS. That
// report is the point. A screenshot shows a collision only if you happen to look at the right
// 40 px; the rectangles say so arithmetically, every run, which is the same reason
// `layout-audit.test-util.mjs` exists for the canvas overlay.
//
// Needs `npm run serve` running and a Chrome/Edge binary (CHROME_PATH overrides).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const has = (name) => args.includes('--' + name);

const TAG = arg('tag', 'ui');
const URL_BASE = arg('url', 'http://localhost:5173');
const SEED = Number(arg('seed', '1337'));
const ONLY = arg('only', '');
const WANT = ONLY ? new Set(ONLY.split(',').map((s) => s.trim())) : null;
const OUT = path.join(ROOT, 'logs', 'ui-' + TAG);
fs.mkdirSync(OUT, { recursive: true });

/** iPhone 14-ish portrait, the viewport the touch overlay is tuned for. */
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
/** A short landscape phone — the layout's worst case: almost no vertical room. */
const PHONE_LANDSCAPE = { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESKTOP = { width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false };

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found; set CHROME_PATH');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a predicate inside the page. Used instead of a fixed sleep wherever the thing being waited
 * for is observable, which is nearly everywhere `window.__game` is exposed.
 */
async function waitFor(page, fn, timeout, label) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return;
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for ' + label);
    await sleep(60);
  }
}

/**
 * Every rectangle the UI review cares about, in CSS pixels: each touch control by its aria-label,
 * and the HUD's corner map, which is painted on the canvas and so has to be reported by the HUD
 * itself rather than measured from the DOM.
 */
function probeRects() {
  /** @type {Record<string, {x:number,y:number,w:number,h:number}>} */
  const rects = {};
  // A DOMRect reports `width`/`height`; `hud.rects()` reports `w`/`h`. Accept both — reading one
  // shape and being handed the other is how the first version of this reported "0 overlaps" for a
  // screen whose buttons were sitting squarely on the map.
  const push = (name, r) => {
    if (!r) return;
    const w = r.width === undefined ? r.w : r.width;
    const h = r.height === undefined ? r.h : r.height;
    if (!(w > 0) || !(h > 0)) return;
    rects[name] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(w), h: Math.round(h) };
  };
  const touch = document.getElementById('touch');
  if (touch) {
    for (const el of touch.querySelectorAll('[role="button"]')) {
      const label = el.getAttribute('aria-label') || 'button';
      if (el.offsetParent === null && getComputedStyle(el).display === 'none') continue;
      push(label, el.getBoundingClientRect());
    }
  }
  const hud = window.__game && window.__game.hudRects ? window.__game.hudRects() : null;
  if (hud) for (const k of Object.keys(hud)) push(k, hud[k]);
  return rects;
}

/** Pairs of rectangles that intersect by more than a hairline. */
function overlaps(rects) {
  const names = Object.keys(rects);
  const out = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = rects[names[i]];
      const b = rects[names[j]];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 1 && oy > 1) out.push(`${names[i]} x ${names[j]} (${ox}x${oy}px)`);
    }
  }
  return out;
}

const report = { tag: TAG, seed: SEED, shots: [], errors: [] };

async function shot(page, name) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  const rects = await page.evaluate(probeRects);
  const clashes = overlaps(rects);
  report.shots.push({ name, rects, overlaps: clashes });
  const list = Object.entries(rects)
    .map(([k, r]) => `${k}@${r.x},${r.y} ${r.w}x${r.h}`)
    .join(' · ');
  console.log(`[shot] ${name}`);
  if (list) console.log(`        ${list}`);
  if (clashes.length) console.log(`        OVERLAP: ${clashes.join(' | ')}`);
}

const want = (name) => !WANT || WANT.has(name);

const executablePath = findChrome();
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-vsync', '--autoplay-policy=no-user-gesture-required'],
});

/** Boot a fresh page at `viewport` and start a run in `mode`. */
async function boot(page, viewport, mode) {
  await page.setViewport(viewport);
  await page.goto(`${URL_BASE}/?headless=1&seed=${SEED}`, { waitUntil: 'load', timeout: 30000 });
  await waitFor(page, () => window.__game && window.__game.ready === true, 20000, 'ready');
  await page.evaluate(
    ({ seed, mode }) => window.__game.dispatch({ type: 'newGame', seed, mode }),
    { seed: SEED, mode }
  );
  await waitFor(page, () => window.__game.state().phase === 'playing', 20000, 'playing');
  await sleep(700);
}

/** Give the run the things whose *presence* is what crowds the layout: the map, chalk, some score. */
async function enrich(page) {
  await page.evaluate(() => {
    const s = window.__game.state();
    s.run.mapFound = true;
    s.run.score = 4820;
    s.run.chalk = 3;
    if (s.perks) s.perks.chalk = 2;
    if (s.settings) s.settings.mapMode = 'corner';
  });
  await sleep(400);
}

let page;
try {
  page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(m.text());
  });
  page.on('pageerror', (e) => report.errors.push(String((e && e.stack) || e)));

  // ── Phone, New Descent: the crowded case (corner map + every touch button) ──
  if (want('play') || want('slain') || want('torch') || want('map')) {
    await boot(page, PHONE, 'combat');
    await enrich(page);
    if (want('play')) await shot(page, 'phone-play');

    if (want('map')) {
      await page.evaluate(() => {
        window.__game.state().settings.mapMode = 'full';
      });
      await sleep(400);
      await shot(page, 'phone-map-full');
      await page.evaluate(() => {
        window.__game.state().settings.mapMode = 'corner';
      });
      await sleep(300);
    }

    // Killed by a creature: health to zero, then let the sim notice on its next step.
    if (want('slain')) {
      await page.evaluate(() => {
        window.__game.state().run.hp = 0;
      });
      await waitFor(page, () => window.__game.state().phase === 'gameOver', 8000, 'slain gameOver');
      await sleep(1400);
      await shot(page, 'phone-gameover-slain');
    }
  }

  // The torch running out is a *separate run*: the phase is already over above.
  if (want('torch')) {
    await boot(page, PHONE, 'combat');
    await enrich(page);
    await page.evaluate(() => {
      const s = window.__game.state();
      s.run.emberUsed = true; // skip Ember Reserve so the torch really ends the run
      s.run.fuel = 0.0001;
    });
    await waitFor(page, () => window.__game.state().phase === 'gameOver', 8000, 'torch gameOver');
    await sleep(1400);
    await shot(page, 'phone-gameover-torch');
  }

  // ── Phone, landscape: the same layout with a third of the height ──
  if (want('landscape')) {
    await boot(page, PHONE_LANDSCAPE, 'combat');
    await enrich(page);
    await shot(page, 'phone-landscape-play');
  }

  // ── Classic Descent on a phone: AUTO replaces ATTACK, corner map goes bottom-right ──
  if (want('classic')) {
    await boot(page, PHONE, 'classic');
    await enrich(page);
    await shot(page, 'phone-classic-play');
  }

  // ── Desktop, for the mouse layout ──
  if (has('desktop') && want('desktop')) {
    await boot(page, DESKTOP, 'combat');
    await enrich(page);
    await shot(page, 'desktop-play');
  }
} finally {
  if (page) await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

const outFile = path.join(OUT, 'report.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
const clashes = report.shots.reduce((n, s) => n + s.overlaps.length, 0);
console.log(`[shot-ui] ${report.shots.length} shots -> ${path.relative(ROOT, OUT).replace(/\\/g, '/')}`);
console.log(`[shot-ui] ${clashes} overlapping control pair(s) · ${report.errors.length} console error(s)`);
if (report.errors.length) for (const e of report.errors.slice(0, 5)) console.log('  ! ' + e);
process.exit(clashes > 0 || report.errors.length > 0 ? 1 : 0);
