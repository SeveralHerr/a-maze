// Headless-Chrome verification for A-MAZE (ARCHITECTURE.md §5).
//
// Boots the real page at /?headless=1, plays it with an autopilot that pathfinds along the maze
// (detouring to collect items), and asserts the things a player would notice: no console/page
// errors, a real frame rate, a render budget, no heap growth over a soak, and that every phase of
// the game is reachable. Writes logs/<tag>.json plus screenshots of every screen, and exits
// non-zero when any gate fails.
//
//   node tools/verify.mjs [--tag integ] [--url http://localhost:5173] [--out logs]
//                         [--seed 1337] [--soak 20] [--fps 5] [--keep-open]
//
// Requires the dev server (`npm run serve`) and a Chrome/Edge binary (CHROME_PATH overrides).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};

const TAG = opt('--tag', 'verify');
const URL = opt('--url', 'http://localhost:5173').replace(/\/$/, '');
const OUT = path.resolve(ROOT, opt('--out', 'logs'));
const SEED = Number(opt('--seed', '1337')) >>> 0;
const SOAK_S = Number(opt('--soak', '20'));
const FPS_S = Number(opt('--fps', '5'));
const KEEP_OPEN = args.includes('--keep-open');

// Gates (ARCHITECTURE.md §5).
const MIN_FPS = 55;
const MAX_RENDER_MS_AVG = 8;
const MAX_RENDER_MS_P99 = 16;
const MAX_HEAP_GROWTH_MB = 5;
// Level 1 is the lean 10×10-cell first floor; level 2 is 24×24. There is no sprint (§1), so the
// autopilot walks at the one walking speed with item detours; these stay generous multiples of the
// measured time rather than a tight fit. They are *wall-clock* budgets for the test, not
// gameplay targets — the gameplay budget is the torch, and that is asserted separately.
/** Wall-clock budget for the autopilot to finish level 1, seconds. */
const LEVEL1_BUDGET_S = 400;
/** Wall-clock budget for the autopilot to finish a later level, seconds. */
const LEVEL2_BUDGET_S = 500;
/** The level the deep-descent phase forces its way down to — the size cap (`balance.CAP_LEVEL`). */
const CAP_LEVEL = 15;
/** Seconds the autopilot drives the maximum-size level while fps/step/heap are sampled. */
const CAP_SOAK_S = 60;
/**
 * Longest gap between animation frames tolerated while a level is generated and installed,
 * in milliseconds. A 128×128-cell build runs in a worker, so the main thread only pays the
 * structured-clone deserialisation and the `levelReady` reducer; anything approaching 50 ms would
 * be a visible hitch on the loading screen.
 */
const MAX_BUILD_RAF_GAP_MS = 50;
/** Minimum times the autopilot's torch must visibly refill for the economy to count as working. */
const MIN_REFUELS = 2;

// ── The mid-tier device phase ─────────────────────────────────────────────────────────────────
// Every number above is measured on a developer machine with the GPU frame limiter disabled, which
// reads as enormous margin (600+ fps, render ~1.2 ms against an 8 ms gate) and says nothing about
// the hardware the game ships to. This phase re-runs the same sampling with the renderer's CPU
// slowed by `THROTTLE_RATE`, so the budgets carry evidence for a phone or a five-year-old laptop.
// Measured at rate 4 on the cap level in an otherwise idle browser: render ~8.8 ms avg, ~84 fps
// loop, longest frame gap ~30 ms, 0 steps discarded (rate 1: 2.4 ms; rate 2: 3.8-4.9 ms). The
// budgets below sit ~35 % above that and well below "a player would notice", so a regression that
// eats the real margin fails here long before it fails the unthrottled gates.
//
// CPU throttling multiplies whatever else the host is doing, so the phase also samples the same
// scene unthrottled immediately before it (`throttled.baseline`). A failure whose control is itself
// far above the cap soak's numbers is a loaded machine, not a regression — the report says which.
/** CDP CPU throttling factor for the throttled phase (1 = no throttling). */
const THROTTLE_RATE = 4;
/** Seconds sampled while throttled. */
const THROTTLE_SOAK_S = 10;
const THROTTLED_MIN_FPS = 50;
const THROTTLED_MAX_RENDER_MS_AVG = 12;
/** Longest tolerated gap between animation frames while throttled, ms (≈6 dropped frames). */
const THROTTLED_MAX_GAP_MS = 100;
/**
 * Steps the catch-up clamp may discard while throttled. Non-zero is legitimate here — a frame over
 * ~83 ms owes more than `maxCatchUp` steps and the clamp *should* drop the overflow rather than
 * queue it — but a growing count means the sim is losing ground, which is the death-spiral
 * regression `skippedSteps` exists to catch. Unthrottled phases are gated at exactly zero.
 */
const THROTTLED_MAX_SKIPPED_STEPS = 5;
/** Seconds of unthrottled sampling taken just before throttling, as the phase's control. */
const THROTTLE_BASELINE_S = 3;
/**
 * Steps an *unthrottled* soak may discard. A death spiral — the regression `skippedSteps` exists to
 * catch — discards steps every frame, hundreds per second. A single stall of the whole process (an
 * OS preemption, a major GC, another Chrome on the same cores) discards one to four and is not a
 * property of the game. Five separates the two without ever excusing the first.
 */
const MAX_STALL_SKIPPED_STEPS = 5;

fs.mkdirSync(OUT, { recursive: true });

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

const report = {
  tag: TAG,
  url: URL,
  seed: SEED,
  startedAt: new Date().toISOString(),
  chrome: null,
  loadMs: 0,
  errors: [],
  warnings: [],
  pageErrors: [],
  requestFailures: [],
  phases: [],
  screenshots: [],
  level1: null,
  level2: null,
  pickups: null,
  /** The biggest level in the game, played for real (massive-maze gate). */
  capLevel: null,
  /** Longest animation-frame gap while that level was generated and installed. */
  buildGap: null,
  /** Oil flasks burned and fuel-seconds recovered across the whole run. */
  fuelEconomy: null,
  /** The cap level re-sampled with the CPU throttled to `THROTTLE_RATE` (the real margin). */
  throttled: null,
  fps: null,
  fpsUncapped: null,
  loopStats: null,
  render: null,
  heap: null,
  mobile: null,
  gameErrors: [],
  pass: false,
  failReasons: [],
};

const fail = (r) => report.failReasons.push(r);
const shot = async (page, name) => {
  const file = path.join(OUT, `shot-${TAG}-${name}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(path.relative(ROOT, file).replace(/\\/g, '/'));
  return file;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Put the three-state map (§4.6) into one state, the way the game does it.
 *
 * Both keys are written because both exist: `mapMode` is what the map restores from, `minimap` is
 * the legacy boolean other consumers still read. Driving it through `setSetting` rather than a UI
 * call means the test exercises the same path the `map` hotkey does.
 * @param {import('puppeteer-core').Page} page
 * @param {'off'|'corner'|'full'} mode
 */
const setMap = (page, mode) =>
  page.evaluate((m) => {
    window.__game.dispatch({ type: 'setSetting', key: 'mapMode', value: m });
    window.__game.dispatch({ type: 'setSetting', key: 'minimap', value: m !== 'off' });
  }, mode);

/**
 * Wait until the camera is looking down an open corridor rather than at a wall a foot away.
 * The autopilot scrapes corners, and a screenshot taken at that instant shows masonry filling the
 * frame — true, but useless for judging how the game looks.
 */
async function clearView(page, maxMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const ok = await page.evaluate(() => {
      const s = window.__game.state();
      if (s.phase !== 'playing' || !s.levelData) return false;
      const m = s.levelData.maze;
      const p = s.player;
      const cx = Math.cos(p.angle);
      const cy = Math.sin(p.angle);
      for (let d = 1; d <= 3; d++) {
        const tx = Math.floor(p.x + cx * d);
        const ty = Math.floor(p.y + cy * d);
        if (tx < 0 || ty < 0 || tx >= m.width || ty >= m.height) return false;
        if (m.tiles[ty * m.width + tx] !== 0) return false;
      }
      return true;
    });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

// ── The in-page autopilot ────────────────────────────────────────────────────────────────────
// Installed once per page load. It pathfinds through the maze with a BFS over floor tiles, steers
// with the *real* input path (window.__game.input.inject → the same InputFrame the sim consumes),
// and detours to any uncollected item within reach so the pickup code is exercised for real.
function installAutopilot() {
  const g = window.__game;
  const TAU = Math.PI * 2;
  const wrap = (a) => {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  };

  const ap = {
    on: false,
    goal: null, // {x, y, kind}
    route: [],
    step: 0,
    stuckFrames: 0,
    lastX: 0,
    lastY: 0,
    replans: 0,
    frames: 0,
    pickupsWanted: 2,
    /** Fraction of the tank below which finding a flask outranks reaching the exit. */
    refuelAt: 0.55,
    /** Manhattan tiles the low-tank search looks over. Wide: a big maze is mostly not nearby. */
    refuelRange: 40,
    log: [],
  };

  /** BFS over floor tiles from (sx,sy) to (gx,gy); returns a list of tile coords or null. */
  function route(maze, sx, sy, gx, gy) {
    const { width: w, height: h, tiles } = maze;
    if (sx === gx && sy === gy) return [[gx, gy]];
    const prev = new Int32Array(w * h).fill(-1);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    const start = sy * w + sx;
    const goal = gy * w + gx;
    queue[tail++] = start;
    prev[start] = start;
    while (head < tail) {
      const i = queue[head++];
      if (i === goal) break;
      const x = i % w;
      const y = (i / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + (d === 0 ? 1 : d === 2 ? -1 : 0);
        const ny = y + (d === 1 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (prev[ni] !== -1 || tiles[ni] !== 0) continue;
        prev[ni] = i;
        queue[tail++] = ni;
      }
    }
    if (prev[goal] === -1) return null;
    const out = [];
    for (let i = goal; i !== start; i = prev[i]) out.push([i % w, (i / w) | 0]);
    out.reverse();
    return out;
  }

  /**
   * Choose the next goal.
   *
   * Three rules, in order — this is the whole difference between an autopilot that proves a small
   * maze and one that proves a massive one:
   * 1. **Refuel when the tank is low.** Below `REFUEL_AT` of the tank the nearest reachable oil
   *    flask becomes the goal, searched over a wide radius. That is what a competent player does in
   *    a labyrinth they cannot cross on one tank, and it is the behaviour the placement guarantee
   *    in `src/maze/populate.js` is written against.
   * 2. A nearby item while we still want pickups (exercises the pickup path for real).
   * 3. Otherwise the exit.
   */
  function chooseGoal(s) {
    const maze = s.levelData.maze;
    const px = Math.floor(s.player.x);
    const py = Math.floor(s.player.y);
    const items = s.levelData.items;

    const tank = s.run.fuelMax > 0 ? s.run.fuel / s.run.fuelMax : 1;
    if (tank < ap.refuelAt) {
      let best = null;
      let bestD = Infinity;
      for (const it of items) {
        if (it.taken || it.kind !== 'oil') continue;
        const d = Math.abs(it.x - s.player.x) + Math.abs(it.y - s.player.y);
        if (d < ap.refuelRange && d < bestD) {
          bestD = d;
          best = it;
        }
      }
      if (best !== null) {
        const r = route(maze, px, py, Math.floor(best.x), Math.floor(best.y));
        if (r !== null) return { kind: 'oil', x: Math.floor(best.x), y: Math.floor(best.y), route: r };
      }
    }

    if (ap.pickupsWanted > 0) {
      let best = null;
      let bestD = Infinity;
      for (const it of items) {
        if (it.taken) continue;
        const d = Math.abs(it.x - s.player.x) + Math.abs(it.y - s.player.y);
        // Only a genuine detour: something close enough that a player would obviously grab it.
        if (d < 9 && d < bestD) {
          bestD = d;
          best = it;
        }
      }
      if (best !== null) {
        const r = route(maze, px, py, Math.floor(best.x), Math.floor(best.y));
        if (r !== null) return { kind: 'item', x: Math.floor(best.x), y: Math.floor(best.y), route: r };
      }
    }
    const r = route(maze, px, py, maze.exit.x, maze.exit.y);
    return r === null ? null : { kind: 'exit', x: maze.exit.x, y: maze.exit.y, route: r };
  }

  function plan(s) {
    const goal = chooseGoal(s);
    ap.replans++;
    if (goal === null) {
      ap.goal = null;
      ap.route = [];
      return;
    }
    ap.goal = goal;
    ap.route = goal.route;
    ap.step = 0;
  }

  function frame() {
    if (!ap.on) return;
    const s = g.state();
    if (s.phase !== 'playing' || !s.levelData) {
      g.input.clear();
      return;
    }
    ap.frames++;
    const p = s.player;

    // Replan when the goal is gone (item collected), the route ran out, or we are stuck — and
    // whenever the tank crosses the refuel threshold, so heading for the exit on fumes is
    // interrupted by a trip to a flask (and a full tank goes back to heading for the exit).
    // The 0.15 of hysteresis stops the two rules alternating every frame at the boundary.
    const tank = s.run.fuelMax > 0 ? s.run.fuel / s.run.fuelMax : 1;
    const wantsFuel = ap.goal !== null && ap.goal.kind === 'oil';
    if (
      ap.goal === null ||
      ap.step >= ap.route.length ||
      ((ap.goal.kind === 'item' || ap.goal.kind === 'oil') && itemTaken(s, ap.goal)) ||
      (!wantsFuel && tank < ap.refuelAt) ||
      (wantsFuel && tank > ap.refuelAt + 0.15)
    ) {
      plan(s);
    }
    if (Math.abs(p.x - ap.lastX) + Math.abs(p.y - ap.lastY) < 0.004) {
      ap.stuckFrames++;
      if (ap.stuckFrames > 45) {
        ap.stuckFrames = 0;
        plan(s);
      }
    } else {
      ap.stuckFrames = 0;
    }
    ap.lastX = p.x;
    ap.lastY = p.y;
    if (ap.goal === null || ap.route.length === 0) {
      g.input.clear();
      return;
    }

    // Advance along the route; skip waypoints we are already on top of.
    while (ap.step < ap.route.length - 1) {
      const wp = ap.route[ap.step];
      const dx = wp[0] + 0.5 - p.x;
      const dy = wp[1] + 0.5 - p.y;
      if (dx * dx + dy * dy < 0.16) ap.step++;
      else break;
    }
    const wp = ap.route[ap.step];
    const tx = wp[0] + 0.5;
    const ty = wp[1] + 0.5;
    const err = wrap(Math.atan2(ty - p.y, tx - p.x) - p.angle);
    const aligned = Math.cos(err);
    // Turn with the keyboard/stick axis (the real control path), walk forward only when the
    // heading is roughly right.
    g.input.inject({
      turn: Math.max(-1, Math.min(1, err * 2.6)),
      moveY: aligned > 0.35 ? 1 : aligned > -0.2 ? 0.45 : 0,
      moveX: 0,
    });
  }

  function itemTaken(s, goal) {
    for (const it of s.levelData.items) {
      if (Math.floor(it.x) === goal.x && Math.floor(it.y) === goal.y) return it.taken;
    }
    return true;
  }

  const tick = () => {
    try {
      frame();
    } catch (e) {
      ap.log.push(String((e && e.message) || e));
      ap.on = false;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.__ap = {
    start(pickups) {
      ap.pickupsWanted = pickups === undefined ? 2 : pickups;
      ap.goal = null;
      ap.route = [];
      ap.step = 0;
      ap.stuckFrames = 0;
      ap.frames = 0;
      ap.on = true;
    },
    stop() {
      ap.on = false;
      g.input.clear();
    },
    notePickup() {
      if (ap.pickupsWanted > 0) ap.pickupsWanted--;
    },
    info: () => ({
      on: ap.on,
      goal: ap.goal ? ap.goal.kind : null,
      route: ap.route.length,
      step: ap.step,
      replans: ap.replans,
      frames: ap.frames,
      wanted: ap.pickupsWanted,
      log: ap.log.slice(0, 3),
    }),
  };

  // Phase trace, taken from the store rather than sampled per frame: a small level builds
  // synchronously, so `loading` can last less than one animation frame and a sampler would miss it.
  window.__trace = [{ phase: g.state().phase, level: g.state().level, t: 0 }];

  // The torch economy, observed rather than assumed. `pickup`/oil events are the sim telling us a
  // flask was burned; `gained` is the fuel it actually put back. A massive maze is only playable
  // if this happens repeatedly, so the run records every one.
  const fuel = { refuels: 0, gained: 0, gems: 0, byLevel: {}, lowFuelEvents: 0 };
  window.__fuel = fuel;

  g.subscribe((s) => {
    for (const ev of s.events) {
      if (ev.type === 'phase') {
        window.__trace.push({ phase: ev.to, level: s.level, t: +performance.now().toFixed(0) });
      } else if (ev.type === 'pickup' && ev.kind === 'oil') {
        // Deliberately does NOT spend the autopilot's detour budget: refuelling is the low-tank
        // rule's job and is unlimited, while `pickupsWanted` exists to make it take a couple of
        // deliberate detours for *gems*, which is the pickup path a player chooses rather than needs.
        fuel.refuels++;
        fuel.gained += ev.value;
        fuel.byLevel[s.level] = (fuel.byLevel[s.level] || 0) + 1;
      } else if (ev.type === 'pickup' && ev.kind === 'gem') {
        fuel.gems++;
        if (window.__ap) window.__ap.notePickup();
      } else if (ev.type === 'lowFuel') {
        fuel.lowFuelEvents++;
      }
    }
  });

  // Animation-frame gap sampler, used to prove that carving a 128×128-cell level never stalls the
  // frame loop. Sampling rAF deltas is the only honest measure: it sees the worker hand-off, the
  // structured-clone deserialisation and the `levelReady` reducer exactly as a player's eye does.
  const gaps = { on: false, max: 0, count: 0, over16: 0, last: 0 };
  const gapTick = () => {
    if (gaps.on) {
      const now = performance.now();
      if (gaps.last > 0) {
        const d = now - gaps.last;
        gaps.count++;
        if (d > gaps.max) gaps.max = d;
        if (d > 16.7 * 2) gaps.over16++;
      }
      gaps.last = now;
    }
    requestAnimationFrame(gapTick);
  };
  requestAnimationFrame(gapTick);
  window.__gaps = {
    start() {
      gaps.on = true;
      gaps.max = 0;
      gaps.count = 0;
      gaps.over16 = 0;
      gaps.last = 0;
    },
    stop() {
      gaps.on = false;
      return { maxMs: +gaps.max.toFixed(2), frames: gaps.count, longFrames: gaps.over16 };
    },
  };
}

/** Wait until the page's game state satisfies `fn`, or reject. Extra args are passed to `fn`. */
async function waitForState(page, fn, timeoutMs, what, ...args) {
  await page.waitForFunction(fn, { timeout: timeoutMs, polling: 'raf' }, ...args).catch(() => {
    throw new Error(`timed out waiting for ${what}`);
  });
}

/** Run the autopilot until the level is complete (or the budget runs out). */
async function playLevel(page, budgetS, onTick) {
  const t0 = Date.now();
  let lastGems = -1;
  while (Date.now() - t0 < budgetS * 1000) {
    const s = await page.evaluate(() => {
      const st = window.__game.state();
      return {
        phase: st.phase,
        level: st.level,
        gems: st.run.gems,
        gemsTotal: st.run.gemsTotal,
        score: st.run.score,
        fuel: +st.run.fuel.toFixed(2),
        fuelMax: +st.run.fuelMax.toFixed(2),
        exitDist: Number.isFinite(st.derived.exitDist) ? +st.derived.exitDist.toFixed(2) : null,
        x: +st.player.x.toFixed(2),
        y: +st.player.y.toFixed(2),
      };
    });
    if (s.gems !== lastGems && s.gems > 0) {
      lastGems = s.gems;
      await page.evaluate(() => window.__ap.notePickup());
    }
    if (onTick) await onTick(s, Date.now() - t0);
    if (s.phase === 'levelComplete') return { done: true, ...s, seconds: (Date.now() - t0) / 1000 };
    if (s.phase === 'gameOver') return { done: false, ...s, seconds: (Date.now() - t0) / 1000 };
    await sleep(250);
  }
  const s = await page.evaluate(() => {
    const st = window.__game.state();
    return { phase: st.phase, gems: st.run.gems, fuel: +st.run.fuel.toFixed(2) };
  });
  return { done: false, timedOut: true, ...s, seconds: (Date.now() - t0) / 1000 };
}

/**
 * Measure the frame rate in a browser with the compositor's frame limiter left ON.
 *
 * The main run disables vsync so the render budget can be measured without the 60 Hz ceiling
 * hiding it; that inflates the reported fps to whatever the machine can produce. This second,
 * short run is the honest "is the game smooth on a normal display" number, so both are recorded.
 * @param {string} executablePath
 * @returns {Promise<{fps:number|null, frameMsP99:number|null, note:string}>}
 */
async function measureVsyncFps(executablePath) {
  let b = null;
  try {
    b = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--window-size=1280,760'],
    });
    const p = await b.newPage();
    await p.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await p.goto(`${URL}/?headless=1`, { waitUntil: 'load', timeout: 30000 });
    await waitForState(p, () => window.__game && window.__game.ready === true, 20000, 'vsync run ready');
    await p.evaluate(installAutopilot);
    await p.evaluate((seed) => window.__game.dispatch({ type: 'newGame', seed }), SEED);
    await waitForState(p, () => window.__game.state().phase === 'playing', 15000, 'vsync run playing');
    await p.evaluate(() => window.__ap.start(1));
    await sleep(1200);
    const out = await p.evaluate(
      (seconds) =>
        new Promise((resolve) => {
          let frames = 0;
          const t0 = performance.now();
          const f = () => {
            frames++;
            if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(f);
            else {
              const ls = window.__game.stats();
              resolve({
                fps: +((frames * 1000) / (performance.now() - t0)).toFixed(1),
                frameMsP99: +ls.frameMsP99.toFixed(2),
              });
            }
          };
          requestAnimationFrame(f);
        }),
      FPS_S,
    );
    return { ...out, note: 'compositor frame limiter enabled (realistic display cap)' };
  } catch (e) {
    return { fps: null, frameMsP99: null, note: `failed: ${(e && e.message) || e}` };
  } finally {
    if (b) await b.close();
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────

const executablePath = findChrome();
report.chrome = executablePath;
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,760',
  ],
});

let page;
try {
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') report.errors.push(m.text());
    else if (t === 'warning' || t === 'warn') report.warnings.push(m.text());
  });
  page.on('pageerror', (e) => report.pageErrors.push(String((e && e.stack) || e)));
  page.on('requestfailed', (r) =>
    report.requestFailures.push(`${r.url()} ${(r.failure() && r.failure().errorText) || ''}`),
  );

  const client = await page.createCDPSession();
  await client.send('Performance.enable').catch(() => {});
  await client.send('HeapProfiler.enable').catch(() => {});
  const heapMB = async () => {
    await client.send('HeapProfiler.collectGarbage').catch(() => {});
    const { metrics } = await client.send('Performance.getMetrics');
    const m = metrics.find((x) => x.name === 'JSHeapUsedSize');
    return m ? +(m.value / 1048576).toFixed(2) : null;
  };

  // ── Boot ──
  const t0 = Date.now();
  await page.goto(`${URL}/?headless=1`, { waitUntil: 'load', timeout: 30000 });
  await waitForState(page, () => window.__game && window.__game.ready === true, 20000, 'window.__game.ready');
  report.loadMs = Date.now() - t0;
  await page.evaluate(installAutopilot);

  // Let the attract camera walk a couple of seconds so the title shot has depth behind it.
  await sleep(1800);
  await shot(page, 'title');
  report.title = await page.evaluate(() => {
    const s = window.__game.state();
    return {
      phase: s.phase,
      hasDemoLevel: s.levelData !== null,
      attractMoved: +(Math.abs(s.player.x - 1.5) + Math.abs(s.player.y - 1.5)).toFixed(2),
      docTitle: document.title,
      bodyOverflow: document.body.scrollWidth > innerWidth + 1 || document.body.scrollHeight > innerHeight + 1,
    };
  });

  // ── Options screen ──
  // The Map row changed from a two-state toggle to a three-state `choice` (§4.6), so the browser
  // gate has to actually open the menu and step it. Driven through the real input path — the same
  // `InputFrame` a keyboard produces — so this exercises `menus.handleInput`, not a private hook.
  const press = async (action, times = 1) => {
    for (let i = 0; i < times; i++) {
      await page.evaluate((a) => window.__game.input.inject({ pressed: [a] }), action);
      await sleep(120);
    }
  };
  await press('down', 2); // Descend → Shrine → Options
  await press('confirm');
  await sleep(400);
  report.options = await page.evaluate(() => ({
    screen: window.__game.screen(),
    mapMode: window.__game.state().settings.mapMode,
    minimap: window.__game.state().settings.minimap,
  }));
  await shot(page, 'options');
  // Step the Map row and confirm both settings keys move together. Left and right are walked
  // (a `choice` row wraps at both ends, so this passes through all three states twice) and every
  // stop is checked, because the failure this guards against is silent: `mapMode` advancing while
  // the legacy `minimap` mirror does not, which desynchronises the preference on the next reload.
  await press('down', 4); // Sound → Music → Look Speed → Scanlines → Map
  const cycle = [];
  const readSetting = () =>
    page.evaluate(() => {
      const s = window.__game.state().settings;
      return { mapMode: s.mapMode, minimap: s.minimap };
    });
  for (const dir of /** @type {const} */ (['left', 'left', 'right', 'right'])) {
    await press(dir);
    cycle.push(await readSetting());
  }
  report.options.cycle = cycle;
  await shot(page, 'options-map');
  await press('back');
  await sleep(300);

  // ── Audio unlock ──
  // A click anywhere is the gesture the audio engine waits for; nothing may be constructed before
  // it (Chrome prints an autoplay warning, and the console gate would catch that).
  report.audioBeforeGesture = await page.evaluate(() => window.__game.audioStats().state);
  await page.mouse.click(12, 708); // empty corner: no menu row, no pointer lock
  await sleep(500);
  report.audio = await page.evaluate(() => {
    const s = window.__game.audioStats();
    return { state: s.state, voices: s.voices, maxVoices: s.maxVoices, failures: s.failures };
  });

  // ── Level 1 ──
  await page.evaluate((seed) => window.__game.dispatch({ type: 'newGame', seed }), SEED);
  await waitForState(page, () => window.__game.state().phase === 'playing', 15000, 'phase playing (level 1)');
  await page.evaluate(() => window.__ap.start(2));

  let midShot = false;
  let mapShot = false;
  report.level1 = await playLevel(page, LEVEL1_BUDGET_S, async (s, ms) => {
    if (!midShot && ms > 3500) {
      midShot = true;
      await clearView(page, 4000);
      await shot(page, 'play');
    }
    if (!mapShot && ms > 12000) {
      // Twelve seconds of walking means a real stretch of corridor is on the map. The old trigger
      // was "a gem is in the bag", which no longer works: level 1 is now 16×16 cells with 6 gems
      // in it, and a direct run can finish without passing one — the shots then landed on the
      // level-complete screen. Time is the honest proxy for "how much has been explored".
      // CORNER is the state the player runs with; FULL is the one they stop to read.
      mapShot = true;
      await setMap(page, 'corner');
      await sleep(400);
      await clearView(page, 4000);
      await shot(page, 'minimap');
      await setMap(page, 'full');
      await sleep(600);
      await shot(page, 'fullmap');
      await setMap(page, 'corner');
    }
  });
  if (!midShot) await shot(page, 'play');
  // Fallback only if the level ended inside 12 s: the map is only drawn while playing, so shooting
  // it on the level-complete screen would produce a picture of the tally, not of the map.
  if (!mapShot && (await page.evaluate(() => window.__game.state().phase === 'playing'))) {
    await setMap(page, 'corner');
    await shot(page, 'minimap');
    await setMap(page, 'full');
    await sleep(500);
    await shot(page, 'fullmap');
    await setMap(page, 'corner');
  }
  report.autopilot = await page.evaluate(() => window.__ap.info());
  await page.evaluate(() => window.__ap.stop());

  report.pickups = await page.evaluate(() => {
    const s = window.__game.state();
    let taken = 0;
    for (const it of s.levelData.items) if (it.taken) taken++;
    return { taken, total: s.levelData.items.length, gems: s.run.gems, score: s.run.score };
  });

  if (report.level1.done) {
    // The tally staggers four rows in over ~2.2 s; shoot it once every row has landed.
    await sleep(2600);
    await shot(page, 'complete');
  }

  // ── Level 2 ──
  await page.evaluate(() => window.__game.dispatch({ type: 'nextLevel' }));
  // The loading screen is a real screen again (main.js holds a built level for MIN_LOAD_S so the
  // iris can complete its wipe), and it is the only place the game tells the player how big the
  // labyrinth they are about to enter is. Shoot it while it is up.
  await sleep(380);
  report.loading = await page.evaluate(() => {
    const s = window.__game.state();
    return { phase: s.phase, level: s.level };
  });
  if (report.loading.phase === 'loading') await shot(page, 'loading');
  await waitForState(
    page,
    () => window.__game.state().phase === 'playing' && window.__game.state().level === 2,
    20000,
    'phase playing (level 2)',
  );
  await page.evaluate(() => window.__ap.start(1));
  await sleep(2500);
  await clearView(page, 5000);
  await shot(page, 'level2');

  // ── Frame rate (real rAF, while the autopilot is driving) ──
  report.fps = await page.evaluate(
    (seconds) =>
      new Promise((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        const f = () => {
          frames++;
          if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(f);
          else resolve(+((frames * 1000) / (performance.now() - t0)).toFixed(1));
        };
        requestAnimationFrame(f);
      }),
    FPS_S,
  );

  // ── Render cost + heap soak ──
  const heapBefore = await heapMB();
  const soak = await page.evaluate(
    (seconds) =>
      new Promise((resolve) => {
        const g = window.__game;
        const samples = [];
        const t0 = performance.now();
        // Cumulative since start(), so the phase's own figure is the difference.
        const skipped0 = g.stats().skippedSteps;
        let frames = 0;
        const f = () => {
          frames++;
          samples.push(g.renderStats().ms);
          if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(f);
          else {
            samples.sort((a, b) => a - b);
            const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
            const p99 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.99) - 1)];
            const ls = g.stats();
            resolve({
              seconds: +((performance.now() - t0) / 1000).toFixed(2),
              frames,
              rafFps: +((frames * 1000) / (performance.now() - t0)).toFixed(1),
              worldMsAvg: +avg.toFixed(3),
              worldMsP99: +p99.toFixed(3),
              worldMsMax: +samples[samples.length - 1].toFixed(3),
              loop: {
                fps: +ls.fps.toFixed(1),
                frameMsAvg: +ls.frameMsAvg.toFixed(3),
                frameMsP99: +ls.frameMsP99.toFixed(3),
                stepMsAvg: +ls.stepMsAvg.toFixed(4),
                renderMsAvg: +ls.renderMsAvg.toFixed(3),
                droppedFrames: ls.droppedFrames,
                skippedSteps: ls.skippedSteps,
                skippedStepsDuringSoak: ls.skippedSteps - skipped0,
              },
            });
          }
        };
        requestAnimationFrame(f);
      }),
    SOAK_S,
  );
  const heapAfter = await heapMB();
  report.fpsUncapped = soak.rafFps;
  report.loopStats = soak.loop;
  report.render = {
    worldMsAvg: soak.worldMsAvg,
    worldMsP99: soak.worldMsP99,
    worldMsMax: soak.worldMsMax,
    fullRenderMsAvg: soak.loop.renderMsAvg,
    stepMsAvg: soak.loop.stepMsAvg,
    frames: soak.frames,
  };
  report.heap = {
    beforeMB: heapBefore,
    afterMB: heapAfter,
    growthMB: heapBefore !== null && heapAfter !== null ? +(heapAfter - heapBefore).toFixed(2) : null,
    soakSeconds: soak.seconds,
  };

  // Finish level 2 if the autopilot still can, so `nextLevel → playing → complete` is proven twice.
  report.level2 = await playLevel(page, LEVEL2_BUDGET_S);
  await page.evaluate(() => window.__ap.stop());

  // ── Deep descent, all the way to the size cap ──
  // Every level from 2 on crosses the worker threshold (cols*rows > 400), so this exercises the
  // module-worker path, the big-maze fog-of-war and five-figure scores. The last hop is measured
  // with an animation-frame sampler: carving 16 384 cells and shipping ~900 items plus a 66 kB tile
  // buffer across a structured clone must not stall the frame loop.
  if (report.level2.done) {
    const t0 = Date.now();
    let reached = 2;
    for (let level = 3; level <= CAP_LEVEL && Date.now() - t0 < 120000; level++) {
      // Sample animation-frame gaps across the build of the biggest level in the game.
      if (level === CAP_LEVEL) await page.evaluate(() => window.__gaps.start());
      await page.evaluate(() => window.__game.dispatch({ type: 'nextLevel' }));
      await waitForState(
        page,
        (lv) => window.__game.state().phase === 'playing' && window.__game.state().level === lv,
        25000,
        `phase playing (level ${level})`,
        level,
      ).catch(() => {});
      if (level === CAP_LEVEL) {
        await sleep(600); // let the first few frames of the new level land in the sampler
        report.buildGap = await page.evaluate(() => window.__gaps.stop());
      }
      const st = await page.evaluate(() => {
        const s = window.__game.state();
        return { phase: s.phase, level: s.level, cols: s.levelData ? s.levelData.maze.cols : 0 };
      });
      if (st.phase !== 'playing' || st.level !== level) break;
      reached = level;
      if (level < CAP_LEVEL) await page.evaluate(() => window.__game.dispatch({ type: 'debugWin' }));
    }
    report.deepDescent = {
      reached,
      ms: Date.now() - t0,
      ...(await page.evaluate(() => {
        const s = window.__game.state();
        return {
          phase: s.phase,
          score: s.run.score,
          cols: s.levelData ? s.levelData.maze.cols : 0,
          tiles: s.levelData ? s.levelData.maze.width : 0,
          items: s.levelData ? s.levelData.items.length : 0,
          torches: s.levelData ? s.levelData.torches.length : 0,
          explored: s.explored ? s.explored.length : 0,
          fuelMax: Math.round(s.run.fuelMax),
          pathLength: s.levelData ? s.levelData.validation.pathLength : 0,
        };
      })),
    };

    // ── The maximum-size level, driven for real ──
    // 128×128 cells, ~900 items and ~1300 torches live, with the autopilot walking it and refuelling
    // from flasks. Everything that could scale with maze size — the sim step, the sprite pass, the
    // map raster, the fog grid — is under load here and nowhere else.
    if (reached === CAP_LEVEL) {
      const capHeapBefore = await heapMB();
      await page.evaluate(() => window.__ap.start(4));
      await sleep(2500);
      await clearView(page, 5000);
      await shot(page, 'deep');

      const capStart = await page.evaluate(() => ({
        refuels: window.__fuel.refuels,
        fuel: window.__game.state().run.fuel,
        distance: window.__game.state().run.distance,
      }));
      const capSoak = await page.evaluate(
        (seconds) =>
          new Promise((resolve) => {
            const g = window.__game;
            const render = [];
            const t0 = performance.now();
            const skipped0 = g.stats().skippedSteps;
            let frames = 0;
            let fuelRises = 0;
            let lastFuel = g.state().run.fuel;
            const f = () => {
              frames++;
              render.push(g.renderStats().ms);
              const now = g.state().run.fuel;
              if (now > lastFuel + 0.5) fuelRises++;
              lastFuel = now;
              if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(f);
              else {
                render.sort((a, b) => a - b);
                const ls = g.stats();
                const s = g.state();
                resolve({
                  seconds: +((performance.now() - t0) / 1000).toFixed(2),
                  frames,
                  fuelRises,
                  rafFps: +((frames * 1000) / (performance.now() - t0)).toFixed(1),
                  loopFps: +ls.fps.toFixed(1),
                  stepMsAvg: +ls.stepMsAvg.toFixed(4),
                  frameMsP99: +ls.frameMsP99.toFixed(2),
                  renderMsAvg: +ls.renderMsAvg.toFixed(3),
                  worldMsAvg: +(render.reduce((a, b) => a + b, 0) / render.length).toFixed(3),
                  worldMsP99: +render[Math.min(render.length - 1, Math.ceil(render.length * 0.99) - 1)].toFixed(3),
                  droppedFrames: ls.droppedFrames,
                  skippedSteps: ls.skippedSteps - skipped0,
                  phase: s.phase,
                  level: s.level,
                  items: s.levelData ? s.levelData.items.length : 0,
                  itemsTaken: s.levelData ? s.levelData.items.filter((i) => i.taken).length : 0,
                  fuel: +s.run.fuel.toFixed(1),
                  fuelMax: Math.round(s.run.fuelMax),
                  levelRefuels: s.run.refuels,
                  // Same counter as `capStart.refuels` — the run-cumulative one — so the difference
                  // below is a difference. `run.refuels` is per LEVEL (§3) and is reported beside it.
                  refuels: window.__fuel.refuels,
                  distance: Math.round(s.run.distance),
                  mapped: s.explored ? s.explored.reduce((a, b) => a + b, 0) : 0,
                });
              }
            };
            requestAnimationFrame(f);
          }),
        CAP_SOAK_S,
      );
      const capHeapAfter = await heapMB();
      report.capLevel = {
        ...capSoak,
        refuelsDuringSoak: capSoak.refuels - capStart.refuels,
        walkedDuringSoak: capSoak.distance - Math.round(capStart.distance),
        heap: {
          beforeMB: capHeapBefore,
          afterMB: capHeapAfter,
          growthMB:
            capHeapBefore !== null && capHeapAfter !== null
              ? +(capHeapAfter - capHeapBefore).toFixed(2)
              : null,
        },
      };
      await clearView(page, 5000);
      await shot(page, 'cap-play');

      // ── The same level, on a mid-tier device ──
      // Slow the renderer's CPU by THROTTLE_RATE and sample it again. This is the only phase that
      // says anything about the margin a player actually has: the unthrottled numbers are measured
      // with the frame limiter off on a developer machine.
      let throttled = null;
      try {
        /** @param {number} seconds */
        const sampleFrames = (seconds) =>
          page.evaluate(
            (seconds) =>
              new Promise((resolve) => {
                const g = window.__game;
                const render = [];
                const t0 = performance.now();
                const skipped0 = g.stats().skippedSteps;
                let frames = 0;
                let last = t0;
                let gapMax = 0;
                let longGaps = 0;
                const f = () => {
                  const now = performance.now();
                  const gap = now - last;
                  last = now;
                  if (frames > 0) {
                    if (gap > gapMax) gapMax = gap;
                    if (gap > 33) longGaps++;
                  }
                  frames++;
                  render.push(g.renderStats().ms);
                  if (now - t0 < seconds * 1000) requestAnimationFrame(f);
                  else {
                    render.sort((a, b) => a - b);
                    const ls = g.stats();
                    const s = g.state();
                    resolve({
                      seconds: +((performance.now() - t0) / 1000).toFixed(2),
                      frames,
                      rafFps: +((frames * 1000) / (performance.now() - t0)).toFixed(1),
                      loopFps: +ls.fps.toFixed(1),
                      stepMsAvg: +ls.stepMsAvg.toFixed(4),
                      frameMsP99: +ls.frameMsP99.toFixed(2),
                      renderMsAvg: +ls.renderMsAvg.toFixed(3),
                      worldMsAvg: +(render.reduce((a, b) => a + b, 0) / render.length).toFixed(3),
                      worldMsP99: +render[Math.min(render.length - 1, Math.ceil(render.length * 0.99) - 1)].toFixed(3),
                      gapMaxMs: +gapMax.toFixed(1),
                      gapsOver33Ms: longGaps,
                      droppedFrames: ls.droppedFrames,
                      skippedSteps: ls.skippedSteps - skipped0,
                      phase: s.phase,
                      level: s.level,
                    });
                  }
                };
                requestAnimationFrame(f);
              }),
            seconds,
          );
        // Control first: the same scene at rate 1, seconds before, on the same host load.
        const baseline = await sampleFrames(THROTTLE_BASELINE_S);
        await client.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE_RATE });
        await sleep(1500); // the loop's 120-frame window has to refill at the new speed
        throttled = { ...(await sampleFrames(THROTTLE_SOAK_S)), baseline };
      } finally {
        // Never leave the page throttled: every measurement after this one would be wrong.
        await client.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
      }
      report.throttled = throttled === null ? null : { rate: THROTTLE_RATE, ...throttled };
      await sleep(600); // let the window refill at full speed before anything else is measured

      // (c) Both map states on the biggest maze in the game, shot AFTER the soak so there is
      // something on them — a minute of walking is the "just arrived" state a player sees.
      for (const mode of /** @type {const} */ (['corner', 'full'])) {
        await setMap(page, mode);
        await sleep(800);
        await shot(page, `cap-map-${mode}`);
      }

      // The map state that actually has to be legible is a player HALF WAY through a 12-minute
      // labyrinth, and no test run has twelve minutes. So the fog is filled in along the real
      // solution path exactly as walking it would fill it: every tile within REVEAL_RADIUS of the
      // first 60 % of `validation.path`. This runs after every measurement, so it cannot move a
      // single gate — it exists only so the full map can be judged at the size it is drawn at.
      report.capMapReveal = await page.evaluate(() => {
        const s = window.__game.state();
        const m = s.levelData.maze;
        const path = s.levelData.validation.path;
        const ex = s.explored;
        if (!path || !ex) return null;
        const R = 3;
        const upto = Math.floor(path.length * 0.6);
        for (let i = 0; i < upto; i++) {
          const ti = path[i];
          const px = ti % m.width;
          const py = (ti / m.width) | 0;
          for (let dy = -R; dy <= R; dy++) {
            const y = py + dy;
            if (y < 0 || y >= m.height) continue;
            for (let dx = -R; dx <= R; dx++) {
              const x = px + dx;
              if (x < 0 || x >= m.width) continue;
              if (dx * dx + dy * dy > R * R) continue;
              ex[y * m.width + x] = 1;
            }
          }
        }
        let n = 0;
        for (let i = 0; i < ex.length; i++) n += ex[i];
        return { pathTiles: path.length, revealedUpTo: upto, explored: n, tiles: ex.length };
      });
      // The map reconciles anything revealed outside the player's box with a 4 096-index rolling
      // sweep (§4.6), i.e. ~16 frames for a 66 049-tile grid. A second is an order of magnitude more.
      await sleep(1200);
      await shot(page, 'cap-map-full-explored');
      await setMap(page, 'corner');
      await sleep(400);
      await shot(page, 'cap-map-corner-explored');
      report.capMapStats = await page.evaluate(() => {
        const st = window.__game.state();
        return { mapped: st.explored ? st.explored.reduce((a, b) => a + b, 0) : 0 };
      });
      await setMap(page, 'corner');
      await page.evaluate(() => window.__ap.stop());
    }
  }

  // Read the economy HERE, before the torch is burned out with `stepOnce` below. That drain is an
  // artificial one — the sim stepped with no input — and folding its inevitable `lowFuel` event in
  // would make these numbers describe the harness rather than the game. What is wanted is what
  // happened while the autopilot was actually playing.
  report.fuelEconomy = await page.evaluate(() => ({ ...window.__fuel }));

  // ── Game over: burn the torch out ──
  // `stepOnce` runs the real fixed step without waiting for wall clock, so a full tank can be
  // drained in a fraction of a second with exactly the code path a slow player would take.
  const burn = await page.evaluate(() => {
    const g = window.__game;
    let steps = 0;
    for (let i = 0; i < 120 && g.state().phase === 'playing'; i++) {
      steps += g.stepOnce(600); // 10 s of sim per chunk, standing still: fuel drains at 1/s
    }
    const s = g.state();
    return { steps, phase: s.phase, score: s.run.score, best: { ...s.best }, level: s.level };
  });
  report.gameOver = burn;
  await sleep(900);
  await shot(page, 'gameover');

  report.phases = await page.evaluate(() => window.__trace.slice());
  report.gameErrors = await page.evaluate(() =>
    window.__game.errors.map((e) => `${e.tag}: ${e.message}${e.count > 1 ? ` (x${e.count})` : ''}`),
  );
  report.dom = await page.evaluate(() => ({
    nodes: document.querySelectorAll('*').length,
    horizontalOverflow: document.body.scrollWidth > innerWidth + 1,
    verticalOverflow: document.body.scrollHeight > innerHeight + 1,
    viewBox: (() => {
      const r = document.getElementById('view').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    overlayBacking: (() => {
      const c = document.getElementById('overlay');
      return { w: c.width, h: c.height };
    })(),
  }));

  // ── Mobile ──
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${URL}/?headless=1`, { waitUntil: 'load', timeout: 30000 });
  await waitForState(page, () => window.__game && window.__game.ready === true, 20000, 'mobile ready');
  await page.evaluate(installAutopilot);
  await sleep(1500);
  await shot(page, 'mobile-title');
  await page.evaluate((seed) => window.__game.dispatch({ type: 'newGame', seed }), SEED);
  await waitForState(page, () => window.__game.state().phase === 'playing', 15000, 'mobile playing');
  await page.evaluate(() => window.__ap.start(1));
  await sleep(4000);
  await clearView(page, 5000);
  await shot(page, 'mobile-play');
  report.mobile = await page.evaluate(() => {
    const s = window.__game.state();
    const r = document.getElementById('view').getBoundingClientRect();
    return {
      phase: s.phase,
      fps: +window.__game.stats().fps.toFixed(1),
      renderMsAvg: +window.__game.renderStats().msAvg.toFixed(2),
      viewBox: { w: Math.round(r.width), h: Math.round(r.height) },
      internal: { w: window.__game.renderStats().w, h: window.__game.renderStats().h },
      horizontalOverflow: document.body.scrollWidth > innerWidth + 1,
      errors: window.__game.errors.length,
    };
  });
  await page.evaluate(() => window.__ap.stop());
} catch (e) {
  report.errors.push(`verify.mjs: ${(e && e.stack) || e}`);
} finally {
  if (!KEEP_OPEN) await browser.close();
}

// A second, short run with vsync left on: the fps number a player would actually see.
report.fpsVsync = await measureVsyncFps(executablePath);

// ── Gate ─────────────────────────────────────────────────────────────────────────────────────
if (report.errors.length) fail(`${report.errors.length} console errors (first: ${report.errors[0]})`);
if (report.warnings.length) fail(`${report.warnings.length} console warnings (first: ${report.warnings[0]})`);
if (report.pageErrors.length) fail(`${report.pageErrors.length} page errors (first: ${report.pageErrors[0]})`);
if (report.requestFailures.length) fail(`${report.requestFailures.length} failed requests`);
if (report.gameErrors.length) fail(`${report.gameErrors.length} guarded runtime errors: ${report.gameErrors[0]}`);

if (!report.title || !report.title.hasDemoLevel) fail('title screen has no attract-mode level');
if (report.title && report.title.attractMoved < 0.2) fail('attract camera never moved on the title screen');
if (report.title && report.title.bodyOverflow) fail('page scrolls (body overflows the viewport)');

if (report.audioBeforeGesture !== 'absent') {
  fail(`an AudioContext existed before the first gesture (${report.audioBeforeGesture})`);
}
if (report.audio && report.audio.state !== 'running') {
  fail(`audio did not unlock on a user gesture (${report.audio.state})`);
}
if (report.audio && report.audio.failures > 0) fail(`${report.audio.failures} audio failures`);

if (!report.level1 || !report.level1.done) {
  fail(`autopilot did not finish level 1 (${report.level1 ? report.level1.phase : 'no data'})`);
}
if (report.pickups && report.pickups.taken < 1) fail('autopilot collected no items');
if (report.level1 && report.level1.done && report.level1.fuel <= 0) fail('level 1 finished with no fuel left');
if (!report.level2 || !report.level2.done) {
  fail(`autopilot did not finish level 2 (${report.level2 ? report.level2.phase : 'no data'})`);
}
if (!report.gameOver || report.gameOver.phase !== 'gameOver') {
  fail(`fuel-out did not reach gameOver (${report.gameOver ? report.gameOver.phase : 'no data'})`);
}
// Levels past the worker threshold are the only ones that exercise the module worker.
if (report.deepDescent) {
  if (report.deepDescent.reached < CAP_LEVEL) {
    fail(`deep descent stalled at level ${report.deepDescent.reached} (wanted ${CAP_LEVEL})`);
  }
  // The size cap: 128×128 cells = 257×257 tiles. Anything less means the curve is not shipping.
  if (report.deepDescent.cols < 128) {
    fail(`level ${CAP_LEVEL} maze is only ${report.deepDescent.cols} cells wide, expected 128`);
  }
  if (report.deepDescent.items < 600) {
    fail(`level ${CAP_LEVEL} carries only ${report.deepDescent.items} items, expected ~800`);
  }
}

// Massive mazes: building the biggest level in the game must not stall the frame loop.
if (report.buildGap && report.buildGap.maxMs > MAX_BUILD_RAF_GAP_MS) {
  fail(`level ${CAP_LEVEL} build stalled a frame for ${report.buildGap.maxMs}ms > ${MAX_BUILD_RAF_GAP_MS}ms`);
}

// The maximum-size level, played for real with ~900 items live.
if (report.capLevel) {
  const c = report.capLevel;
  if (c.phase !== 'playing') fail(`cap-level soak ended in phase ${c.phase}`);
  if (c.loopFps < MIN_FPS) fail(`cap-level fps ${c.loopFps} < ${MIN_FPS}`);
  if (c.renderMsAvg > MAX_RENDER_MS_AVG) {
    fail(`cap-level render avg ${c.renderMsAvg}ms > ${MAX_RENDER_MS_AVG}ms`);
  }
  if (c.worldMsP99 > MAX_RENDER_MS_P99) {
    fail(`cap-level world render p99 ${c.worldMsP99}ms > ${MAX_RENDER_MS_P99}ms`);
  }
  if (c.heap.growthMB !== null && c.heap.growthMB > MAX_HEAP_GROWTH_MB) {
    fail(`cap-level heap grew ${c.heap.growthMB}MB over ${c.seconds}s > ${MAX_HEAP_GROWTH_MB}MB`);
  }
  if (c.walkedDuringSoak < 20) fail(`autopilot barely moved on the cap level (${c.walkedDuringSoak} tiles)`);
  // The catch-up clamp discarding steps steadily on an unthrottled machine means the sim cannot keep
  // up with a 60 Hz budget it has 500× the headroom for — the death-spiral regression this counter
  // exists to catch. A one-off process stall is allowed for (MAX_STALL_SKIPPED_STEPS).
  if (c.skippedSteps > MAX_STALL_SKIPPED_STEPS) {
    fail(`cap-level soak discarded ${c.skippedSteps} sim steps (> ${MAX_STALL_SKIPPED_STEPS}: the sim is losing ground)`);
  }
} else if (report.level2 && report.level2.done) {
  fail('the maximum-size level was never reached, so nothing proved the massive-maze load');
}

// The refuel economy, observed end-to-end: a torch that never refills is a countdown, not an economy.
if (!report.fuelEconomy || report.fuelEconomy.refuels < MIN_REFUELS) {
  fail(
    `the torch refilled only ${report.fuelEconomy ? report.fuelEconomy.refuels : 0} time(s), ` +
      `wanted ≥ ${MIN_REFUELS}`,
  );
}
if (report.fuelEconomy && report.fuelEconomy.refuels >= MIN_REFUELS && report.fuelEconomy.gained <= 0) {
  fail('oil flasks were collected but restored no fuel');
}

const seen = new Set((report.phases || []).map((p) => p.phase));
for (const p of ['title', 'loading', 'playing', 'levelComplete', 'gameOver']) {
  if (!seen.has(p)) fail(`phase never reached: ${p}`);
}

// The vsync-limited run is the honest frame rate; the unlimited one only shows the headroom.
const gateFps = report.fpsVsync && report.fpsVsync.fps !== null ? report.fpsVsync.fps : report.fps;
if (gateFps !== null && gateFps < MIN_FPS) fail(`fps ${gateFps} < ${MIN_FPS}`);
if (report.render) {
  if (report.render.fullRenderMsAvg > MAX_RENDER_MS_AVG) {
    fail(`render avg ${report.render.fullRenderMsAvg}ms > ${MAX_RENDER_MS_AVG}ms`);
  }
  if (report.render.worldMsP99 > MAX_RENDER_MS_P99) {
    fail(`world render p99 ${report.render.worldMsP99}ms > ${MAX_RENDER_MS_P99}ms`);
  }
}
if (report.heap && report.heap.growthMB !== null && report.heap.growthMB > MAX_HEAP_GROWTH_MB) {
  fail(`heap grew ${report.heap.growthMB}MB over ${report.heap.soakSeconds}s > ${MAX_HEAP_GROWTH_MB}MB`);
}
if (report.loopStats && report.loopStats.skippedStepsDuringSoak > MAX_STALL_SKIPPED_STEPS) {
  fail(
    `the ${SOAK_S}s soak discarded ${report.loopStats.skippedStepsDuringSoak} sim steps ` +
      `(> ${MAX_STALL_SKIPPED_STEPS}: the sim is losing ground)`,
  );
}

// The mid-tier device: the same level, the same code, a CPU THROTTLE_RATE× slower.
if (report.throttled) {
  const t = report.throttled;
  const b = t.baseline;
  // Printed beside every throttled failure: the same scene, seconds earlier, at rate 1.
  const ctl = b ? ` (unthrottled control: render ${b.renderMsAvg}ms, ${b.loopFps}fps, gap max ${b.gapMaxMs}ms)` : '';
  if (t.phase !== 'playing') fail(`throttled phase ended in phase ${t.phase}`);
  if (t.loopFps < THROTTLED_MIN_FPS) fail(`throttled (${t.rate}×) fps ${t.loopFps} < ${THROTTLED_MIN_FPS}${ctl}`);
  if (t.renderMsAvg > THROTTLED_MAX_RENDER_MS_AVG) {
    fail(`throttled (${t.rate}×) render avg ${t.renderMsAvg}ms > ${THROTTLED_MAX_RENDER_MS_AVG}ms${ctl}`);
  }
  if (t.gapMaxMs > THROTTLED_MAX_GAP_MS) {
    fail(`throttled (${t.rate}×) longest frame gap ${t.gapMaxMs}ms > ${THROTTLED_MAX_GAP_MS}ms${ctl}`);
  }
  if (t.skippedSteps > THROTTLED_MAX_SKIPPED_STEPS) {
    fail(`throttled (${t.rate}×) discarded ${t.skippedSteps} sim steps > ${THROTTLED_MAX_SKIPPED_STEPS}${ctl}`);
  }
} else if (report.capLevel) {
  fail('the cap level was never sampled under CPU throttling, so no gate covers a mid-tier device');
}
// The options screen's Map row is a three-state choice now, and cycling it must move BOTH the
// `mapMode` enum and the legacy `minimap` mirror, or the preference desynchronises on reload.
if (report.options && report.options.screen !== 'options') {
  fail(`the options screen did not open from the title (screen is '${report.options.screen}')`);
}
if (report.options && report.options.cycle) {
  const modes = report.options.cycle.map((c) => c.mapMode);
  if (new Set(modes).size < 3) {
    fail(`the options Map row did not reach three states (saw ${JSON.stringify(modes)})`);
  }
  for (const c of report.options.cycle) {
    if (c.minimap !== (c.mapMode !== 'off')) {
      fail(`mapMode '${c.mapMode}' and the legacy minimap mirror (${c.minimap}) disagree`);
    }
  }
}

// The loading screen must actually exist to be read (main.js MIN_LOAD_S, §4.7). If a build now
// lands in three frames again, the iris snaps and the labyrinth banner is never seen.
if (!report.loading || report.loading.phase !== 'loading') {
  fail(`the loading screen was already gone 380ms after nextLevel (${report.loading ? report.loading.phase : 'no data'})`);
}
if (report.mobile) {
  if (report.mobile.phase !== 'playing') fail('mobile run never reached playing');
  if (report.mobile.horizontalOverflow) fail('mobile layout overflows horizontally');
  if (report.mobile.errors > 0) fail('mobile run recorded runtime errors');
}

report.pass = report.failReasons.length === 0;
report.finishedAt = new Date().toISOString();

const outFile = path.join(OUT, `${TAG}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

const l1 = report.level1 || {};
const l2 = report.level2 || {};
const cap = report.capLevel;
console.log(
  `[verify] ${report.pass ? 'PASS' : 'FAIL'} ` +
    `L1 ${l1.done ? `cleared in ${l1.seconds?.toFixed(1)}s, ${l1.fuel}/${l1.fuelMax} fuel left` : l1.phase} · ` +
    `L2 ${l2.done ? `cleared in ${l2.seconds?.toFixed(1)}s` : l2.phase} · ` +
    `items ${report.pickups ? `${report.pickups.taken}/${report.pickups.total}` : '?'} · ` +
    `depth ${report.deepDescent ? report.deepDescent.reached : '?'} · ` +
    `fps ${report.fpsVsync && report.fpsVsync.fps !== null ? report.fpsVsync.fps : '?'} vsync / ${report.fps} unlimited · ` +
    `render ${report.render ? `${report.render.fullRenderMsAvg}ms avg, world p99 ${report.render.worldMsP99}ms` : '?'} · ` +
    `heap +${report.heap ? report.heap.growthMB : '?'}MB · ` +
    `errors ${report.errors.length + report.pageErrors.length + report.gameErrors.length}`,
);
console.log(
  `[verify] massive: ` +
    `cap L${report.deepDescent ? report.deepDescent.reached : '?'} ` +
    `${report.deepDescent ? `${report.deepDescent.cols}×${report.deepDescent.cols} cells / ${report.deepDescent.tiles}² tiles, ${report.deepDescent.items} items, ${report.deepDescent.torches} torches` : '?'} · ` +
    `build gap max ${report.buildGap ? `${report.buildGap.maxMs}ms` : '?'} · ` +
    (cap
      ? `soak ${cap.seconds}s @ ${cap.loopFps}fps, step ${cap.stepMsAvg}ms, render ${cap.renderMsAvg}ms avg / world p99 ${cap.worldMsP99}ms, heap +${cap.heap.growthMB}MB, walked ${cap.walkedDuringSoak} tiles, ${cap.refuelsDuringSoak} refuels · `
      : 'no cap soak · ') +
    `refuels ${report.fuelEconomy ? report.fuelEconomy.refuels : '?'} (+${report.fuelEconomy ? Math.round(report.fuelEconomy.gained) : '?'}s)`,
);
const thr = report.throttled;
console.log(
  `[verify] mid-tier: ` +
    (thr
      ? `CPU ${thr.rate}× · ${thr.loopFps}fps loop / ${thr.rafFps} wall · render ${thr.renderMsAvg}ms avg, ` +
        `world p99 ${thr.worldMsP99}ms · frame p99 ${thr.frameMsP99}ms · gap max ${thr.gapMaxMs}ms ` +
        `(${thr.gapsOver33Ms} over 33ms) · skipped steps ${thr.skippedSteps}` +
        (thr.baseline ? ` · control at 1×: render ${thr.baseline.renderMsAvg}ms, ${thr.baseline.loopFps}fps` : '')
      : 'not sampled'),
);
if (!report.pass) for (const r of report.failReasons) console.log(`[verify]   ✗ ${r}`);
console.log(`[verify] ${report.screenshots.length} screenshots · wrote ${path.relative(ROOT, outFile)}`);
process.exit(report.pass ? 0 : 1);
