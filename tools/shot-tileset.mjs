// Screenshot one tileset for art review: its texture sheet, several renderer preview poses, and the
// real game on floor 1 wearing it. Needs `npm run serve` and Chrome (CHROME_PATH overrides).
//
//   node tools/shot-tileset.mjs --tileset forge [--out logs/tilesets] [--url http://localhost:5173]
//                               [--poses 0,2,4,5] [--views 0] [--depth 3]
//
// Writes <out>/<id>-sheet.png, <id>-pose<N>.png, <id>-game.png (floor 1, as the player spawns) and,
// with --views N, <id>-view<K>.png: N in-game shots on floor --depth, each from a different spot
// looking down one of the level's longest straight corridors. Prints the paths.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const ID = arg('tileset', 'keep');
const OUT = arg('out', 'logs/tilesets');
const URL = arg('url', 'http://localhost:5173').replace(/\/$/, '');
const POSES = arg('poses', '0,2,4,5').split(',').map(Number);
const VIEWS = Math.max(0, Number(arg('views', '0')) | 0);
const DEPTH = Math.max(1, Number(arg('depth', '3')) | 0);
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
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.setViewport({ width: 1400, height: 760 });
  await page.goto(`${URL}/src/renderer/tilesets/sheet.html?tileset=${ID}&scale=3`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sheetReady === true, { timeout: 15000 });
  let file = path.join(OUT, `${ID}-sheet.png`);
  await page.screenshot({ path: file, fullPage: true });
  written.push(file);

  await page.setViewport({ width: 960, height: 540 });
  for (const p of POSES) {
    await page.goto(`${URL}/src/renderer/preview.html?tileset=${ID}&pose=${p}&t=6&light=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__preview !== undefined, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 400));
    file = path.join(OUT, `${ID}-pose${p}.png`);
    await page.screenshot({ path: file });
    written.push(file);
  }

  await page.goto(`${URL}/?headless=1&tileset=${ID}&seed=1337`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, { timeout: 20000 });
  await page.evaluate(() => window.__game.dispatch({ type: 'newGame', seed: 1337 }));
  await page.waitForFunction(() => window.__game.state().phase === 'playing', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1500));
  file = path.join(OUT, `${ID}-game.png`);
  await page.screenshot({ path: file });
  written.push(file);

  if (VIEWS > 0) {
    // Descend to a bigger floor (the tileset stays pinned), then park the camera at spots with long
    // sightlines. The player is moved by writing the store-owned state directly: headless tools only.
    for (let d = 1; d < DEPTH; d++) {
      await page.evaluate(() => window.__game.dispatch({ type: 'debugWin' }));
      await page.waitForFunction(() => window.__game.state().phase === 'levelComplete', { timeout: 10000 });
      await page.evaluate(() => window.__game.dispatch({ type: 'nextLevel' }));
      await page.waitForFunction(() => window.__game.state().phase === 'playing', { timeout: 30000 });
    }
    // Let the descent's score pops and the level-start notice fade before shooting.
    await new Promise((r) => setTimeout(r, 4500));
    const spots = await page.evaluate((count) => {
      const st = window.__game.state();
      const m = st.levelData.maze;
      const at = (x, y) => x >= 0 && y >= 0 && x < m.width && y < m.height && m.tiles[y * m.width + x] === 0;
      const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
      const cands = [];
      for (let y = 1; y < m.height - 1; y++) {
        for (let x = 1; x < m.width - 1; x++) {
          if (!at(x, y)) continue;
          for (const [dx, dy] of dirs) {
            if (at(x - dx, y - dy)) continue; // start with a wall at our back
            let run = 0;
            while (at(x + dx * (run + 1), y + dy * (run + 1))) run++;
            if (run >= 4) cands.push({ x, y, dx, dy, run });
          }
        }
      }
      cands.sort((a, b) => b.run - a.run);
      const picked = [];
      for (const c of cands) {
        if (picked.every((p) => Math.abs(p.x - c.x) + Math.abs(p.y - c.y) > 10)) picked.push(c);
        if (picked.length >= count) break;
      }
      return picked;
    }, VIEWS);
    for (let k = 0; k < spots.length; k++) {
      const c = spots[k];
      await page.evaluate((c) => {
        const p = window.__game.state().player;
        p.x = p.px = c.x + 0.5 - c.dx * 0.2;
        p.y = p.py = c.y + 0.5 - c.dy * 0.2;
        p.angle = p.pangle = Math.atan2(c.dy, c.dx) + (c.x % 2 ? 0.18 : -0.18);
      }, c);
      await new Promise((r) => setTimeout(r, 500));
      file = path.join(OUT, `${ID}-view${k}.png`);
      await page.screenshot({ path: file });
      written.push(file);
    }
  }
} finally {
  await browser.close();
}
for (const f of written) console.log(f);
if (errors.length) {
  console.log('PAGE ERRORS:\n' + errors.join('\n'));
  process.exitCode = 1;
}
