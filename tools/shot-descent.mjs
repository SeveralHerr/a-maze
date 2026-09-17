// Screenshot New Descent in the running game (ARCHITECTURE.md §4.11) — the art-review loop for the
// enemies and the sword. Needs `npm run serve` and Chrome (CHROME_PATH overrides).
//
//   node tools/shot-descent.mjs [--tag r1] [--out logs/descent] [--level 2] [--seed 1337]
//                               [--url http://localhost:5173] [--shots title,crawler,wraith,swing,hud]
//
// Drives the real game through `window.__game`: starts a New Descent run, walks the player up to a
// chosen enemy kind through the real sim, and screenshots it at a few ranges plus mid-swing. Writes
// <out>/<tag>-<name>.png and prints the paths.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const TAG = arg('tag', 'r1');
const OUT = arg('out', 'logs/descent');
const URL = arg('url', 'http://localhost:5173').replace(/\/$/, '');
const LEVEL = Math.max(1, Number(arg('level', '2')) | 0);
const SEED = Number(arg('seed', '1337')) >>> 0;
const SHOTS = arg('shots', 'title,crawler,wraith,swing,hud').split(',');
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
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found; set CHROME_PATH');
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const written = [];
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`${m.type()}: ${m.text()}`));
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${URL}/?headless=1&splash=0&seed=${SEED}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, { timeout: 20000 });
  // Let the title's demo maze land, so the attract camera has something to wander.
  await page.waitForFunction(() => window.__game.state().levelData !== null, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));

  const shot = async (name) => {
    const file = path.join(OUT, `${TAG}-${name}.png`);
    await page.screenshot({ path: file });
    written.push(file);
  };

  if (SHOTS.includes('title')) await shot('title');

  // Start a New Descent run and descend to the requested depth.
  await page.evaluate((lvl) => {
    const g = window.__game;
    g.dispatch({ type: 'newGame', seed: 1337, mode: 'combat' });
    window.__want = lvl;
  }, LEVEL);
  await page.waitForFunction(() => window.__game.state().phase === 'playing', { timeout: 20000 });
  for (let l = 1; l < LEVEL; l++) {
    await page.evaluate(() => {
      window.__game.dispatch({ type: 'debugWin' });
      window.__game.dispatch({ type: 'nextLevel' });
    });
    await page.waitForFunction(() => window.__game.state().phase === 'playing', { timeout: 20000 });
  }
  await new Promise((r) => setTimeout(r, 300));

  /**
   * Put the player a set distance in front of the nearest living enemy of `kind`, looking at it,
   * then let the sim settle so the creature notices and starts moving.
   */
  const faceEnemy = async (kind, dist) =>
    page.evaluate(
      ({ kind, dist }) => {
        const g = window.__game;
        const st = g.state();
        const foes = st.enemies.filter((e) => e.st !== 6 && (kind === 'any' || e.kind === kind));
        if (foes.length === 0) return false;
        const e = foes[0];
        const p = st.player;
        // Approach along whichever axis has room: the corridor the creature is standing in.
        const tiles = st.levelData.maze.tiles;
        const w = st.levelData.maze.width;
        const solid = (x, y) => tiles[Math.floor(y) * w + Math.floor(x)] !== 0;
        // Step BACK from the creature a tile at a time and stop at the last clear one: taking
        // `dist` in one jump put the camera inside the masonry behind it, and the screenshot was of
        // a wall. The walk also keeps the creature in line of sight, which is the whole point.
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        let best = null;
        let bestReach = 0;
        for (const [dx, dy] of dirs) {
          let reach = 0;
          for (let d = 0.5; d <= dist; d += 0.5) {
            const x = e.x + dx * d;
            const y = e.y + dy * d;
            if (x < 1 || y < 1 || solid(x, y)) break;
            reach = d;
          }
          if (reach > bestReach) {
            bestReach = reach;
            const x = e.x + dx * reach;
            const y = e.y + dy * reach;
            best = [x, y, Math.atan2(e.y - y, e.x - x)];
          }
        }
        if (best === null) return false;
        p.x = best[0];
        p.y = best[1];
        p.px = p.x;
        p.py = p.y;
        p.angle = best[2];
        p.pangle = p.angle;
        e.awake = true;
        return true;
      },
      { kind, dist },
    );

  for (const [name, kind, dist] of [['crawler', 'crawler', 2.2], ['wraith', 'wraith', 2.6]]) {
    if (!SHOTS.includes(name)) continue;
    const ok = await faceEnemy(kind, dist);
    if (!ok) {
      console.log(`no ${kind} on level ${LEVEL} — skipped`);
      continue;
    }
    await page.evaluate(() => window.__game.stepOnce(20));
    await new Promise((r) => setTimeout(r, 250));
    await shot(name);
    // Closer, so the sprite is read at the distance a fight actually happens at.
    await faceEnemy(kind, 1.3);
    await page.evaluate(() => window.__game.stepOnce(6));
    await new Promise((r) => setTimeout(r, 200));
    await shot(`${name}-near`);
  }

  if (SHOTS.includes('swing')) {
    await faceEnemy('any', 1.4);
    // The swing is 0.44 s end to end and the loop keeps running between `stepOnce` and the capture,
    // so stepping INTO the strike and then waiting screenshots the recovery instead — which is how
    // the first pass came back with a sword at rest and no motion trail. Park the attack state at
    // the top of the strike window instead: it lasts ~5 frames, which comfortably covers the one or
    // two the capture costs.
    const holdSwing = (t) =>
      page.evaluate((tt) => {
        const st = window.__game.state();
        st.attack.st = 2; // SW_STRIKE
        st.attack.t = tt;
        st.attack.hits = 1;
      }, t);
    await holdSwing(0.005);
    await shot('swing');
    await holdSwing(0.055);
    await shot('swing-follow');
    await page.evaluate(() => {
      const st = window.__game.state();
      st.attack.st = 0;
      st.attack.t = 0;
    });
    await new Promise((r) => setTimeout(r, 120));
    await shot('swing-rest');
  }

  if (SHOTS.includes('hud')) {
    // The full HUD with the map open, so the top-right minimap and the attack plaque are both in shot.
    await page.evaluate(() => {
      const g = window.__game;
      const st = g.state();
      st.run.mapFound = true;
      st.run.hp = Math.round(st.run.hpMax * 0.42);
      st.settings.mapMode = 'corner';
      st.settings.minimap = true;
      g.stepOnce(2);
    });
    await new Promise((r) => setTimeout(r, 300));
    await shot('hud');
    // And the full map, where the fuel gauge and the health bar are the only readouts kept.
    await page.evaluate(() => {
      const g = window.__game;
      g.state().settings.mapMode = 'full';
      g.stepOnce(2);
    });
    await new Promise((r) => setTimeout(r, 300));
    await shot('hud-full');
  }

  console.log(errors.length ? `console/page issues:\n  ${errors.join('\n  ')}` : 'no console errors');
} finally {
  await browser.close();
}
for (const f of written) console.log(f);
