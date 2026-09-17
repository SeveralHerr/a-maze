// Record New Descent actually being played, as an animated GIF (ARCHITECTURE.md §4.11).
// Needs `npm run serve` and Chrome (CHROME_PATH overrides).
//
//   node tools/record-descent.mjs [--out logs/descent] [--name descent.gif] [--level 2]
//                                 [--seconds 8] [--fps 12] [--width 640] [--seed 1337]
//
// Drives a real run through `window.__game`'s input injection — walking, turning, swinging — and
// grabs the whole page frame by frame over CDP's screencast. GIF rather than a video container
// because the game is already indexed-colour pixel art: a 256-entry palette is lossless enough to
// be honest, it plays in an <img> anywhere, and it needs no encoder beyond this file.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const OUT = arg('out', 'logs/descent');
const NAME = arg('name', 'descent.gif');
const LEVEL = Math.max(1, Number(arg('level', '2')) | 0);
const SECONDS = Math.max(1, Number(arg('seconds', '8')));
const FPS = Math.max(2, Math.min(25, Number(arg('fps', '12')) | 0));
const WIDTH = Math.max(160, Number(arg('width', '640')) | 0);
const SEED = Number(arg('seed', '1337')) >>> 0;
const URL = arg('url', 'http://localhost:5173').replace(/\/$/, '');
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

// ─── GIF encoding ─────────────────────────────────────────────────────────────────────────────

/**
 * Median-cut quantiser over the frames actually captured.
 *
 * The game paints from a fixed indexed palette, but what reaches the screen has been through the
 * post stack (scanlines, vignette, the low-fuel pulse) in CSS, so the pixels arriving here are not
 * on that palette any more. Quantising the real frames is both simpler and more faithful than
 * trying to invert the compositing.
 * @param {Uint8Array[]} frames RGB, `w*h*3` each
 * @returns {{palette:Uint8Array, index:(r:number,g:number,b:number)=>number}}
 */
function quantise(frames) {
  // Sample rather than read every pixel: 8 frames × every 7th pixel describes the distribution
  // perfectly well and keeps this to a fraction of a second.
  /** @type {number[][]} */
  const sample = [];
  const step = 7 * 3;
  for (let f = 0; f < frames.length; f += Math.max(1, Math.floor(frames.length / 8))) {
    const buf = frames[f];
    for (let i = 0; i < buf.length - 2; i += step) sample.push([buf[i], buf[i + 1], buf[i + 2]]);
  }

  /** Split the widest channel of the biggest box until there are 256 boxes. */
  let boxes = [sample];
  while (boxes.length < 256) {
    let bi = -1;
    let best = 1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length > best) {
        best = boxes[i].length;
        bi = i;
      }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    let ch = 0;
    let spread = -1;
    for (let c = 0; c < 3; c++) {
      let lo = 255;
      let hi = 0;
      for (const p of box) {
        if (p[c] < lo) lo = p[c];
        if (p[c] > hi) hi = p[c];
      }
      if (hi - lo > spread) {
        spread = hi - lo;
        ch = c;
      }
    }
    if (spread <= 0) break;
    box.sort((a, b) => a[ch] - b[ch]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  boxes = boxes.filter((b) => b.length > 0);

  const palette = new Uint8Array(256 * 3);
  boxes.forEach((box, i) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const p of box) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    palette[i * 3] = Math.round(r / box.length);
    palette[i * 3 + 1] = Math.round(g / box.length);
    palette[i * 3 + 2] = Math.round(b / box.length);
  });
  const n = boxes.length;

  // A 32³ cache over the RGB cube: the nearest-entry search is the slow part, and a 5-bit key hits
  // almost every time on pixel art.
  const cache = new Int16Array(32 * 32 * 32).fill(-1);
  const index = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = cache[key];
    if (hit >= 0) return hit;
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = r - palette[i * 3];
      const dg = g - palette[i * 3 + 1];
      const db = b - palette[i * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    cache[key] = bestI;
    return bestI;
  };
  return { palette, index };
}

/** GIF's variable-width LZW, as the spec defines it (8-bit minimum code size). */
function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  /** @type {number[]} */
  const out = [];
  let cur = 0;
  let bits = 0;
  let width = minCodeSize + 1;
  const emit = (/** @type {number} */ code) => {
    cur |= code << bits;
    bits += width;
    while (bits >= 8) {
      out.push(cur & 255);
      cur >>= 8;
      bits -= 8;
    }
  };
  /** @type {Map<string, number>} */
  let dict = new Map();
  const reset = () => {
    dict = new Map();
    for (let i = 0; i < clear; i++) dict.set(String(i), i);
  };
  reset();
  let next = eoi + 1;
  emit(clear);
  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const combined = `${prefix},${k}`;
    if (dict.has(combined)) {
      prefix = combined;
      continue;
    }
    emit(/** @type {number} */ (dict.get(prefix)));
    dict.set(combined, next++);
    if (next > (1 << width)) {
      if (width < 12) {
        width++;
      } else {
        emit(clear);
        reset();
        next = eoi + 1;
        width = minCodeSize + 1;
      }
    }
    prefix = String(k);
  }
  emit(/** @type {number} */ (dict.get(prefix)));
  emit(eoi);
  if (bits > 0) out.push(cur & 255);
  return out;
}

/** Assemble the frames into a looping GIF89a. */
function encodeGif(w, h, frames, delayCs) {
  const { palette, index } = quantise(frames);
  /** @type {number[]} */
  const b = [];
  const push = (...xs) => b.push(...xs);
  const str = (/** @type {string} */ s) => {
    for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i));
  };
  str('GIF89a');
  push(w & 255, w >> 8, h & 255, h >> 8);
  push(0xf7, 0, 0); // global table, 256 entries, 8 bits per channel
  for (let i = 0; i < 256 * 3; i++) b.push(palette[i]);
  // Netscape looping extension.
  push(0x21, 0xff, 11);
  str('NETSCAPE2.0');
  push(3, 1, 0, 0, 0);

  for (const frame of frames) {
    push(0x21, 0xf9, 4, 0, delayCs & 255, delayCs >> 8, 0, 0); // graphic control
    push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0); // image descriptor
    const px = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < px.length; i++, p += 3) px[i] = index(frame[p], frame[p + 1], frame[p + 2]);
    push(8);
    const data = lzw(px, 8);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      push(chunk.length, ...chunk);
    }
    push(0);
  }
  push(0x3b);
  return Buffer.from(b);
}

// ─── PNG decoding (puppeteer hands back PNG; the GIF encoder wants RGB) ───────────────────────

/** Decode the 8-bit truecolour / truecolour-alpha PNG Chrome produces. */
function decodePng(buf) {
  let p = 8;
  let w = 0;
  let h = 0;
  let colour = 0;
  /** @type {Buffer[]} */
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colour = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  const bpp = colour === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 3);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let ri = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[ri++];
    for (let i = 0; i < stride; i++) {
      const x = raw[ri + i];
      const a = i >= bpp ? line[i - bpp] : 0;
      const bb = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + bb;
      else if (filter === 3) v = x + ((a + bb) >> 1);
      else if (filter === 4) {
        const pa = Math.abs(bb - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + bb - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c);
      }
      line[i] = v & 255;
    }
    ri += stride;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      out[o] = line[x * bpp];
      out[o + 1] = line[x * bpp + 1];
      out[o + 2] = line[x * bpp + 2];
    }
    prev.set(line);
  }
  return { w, h, rgb: out };
}

// ─── Record ───────────────────────────────────────────────────────────────────────────────────

const height = Math.round((WIDTH * 9) / 16);
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`${m.type()}: ${m.text()}`));
  await page.setViewport({ width: WIDTH, height, deviceScaleFactor: 1 });
  await page.goto(`${URL}/?headless=1&splash=0&seed=${SEED}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, { timeout: 20000 });
  await page.waitForFunction(() => window.__game.state().levelData !== null, { timeout: 20000 });

  await page.evaluate(() => window.__game.dispatch({ type: 'newGame', seed: 1337, mode: 'combat' }));
  await page.waitForFunction(() => window.__game.state().phase === 'playing', { timeout: 20000 });
  for (let l = 1; l < LEVEL; l++) {
    await page.evaluate(() => {
      window.__game.dispatch({ type: 'debugWin' });
      window.__game.dispatch({ type: 'nextLevel' });
    });
    await page.waitForFunction(() => window.__game.state().phase === 'playing', { timeout: 20000 });
  }
  // Stand the player in front of a creature so the recording opens on a fight rather than on a
  // corridor, and hand them the map so the HUD in shot is the full one.
  await page.evaluate(() => {
    const st = window.__game.state();
    // Unlocked before the settle below, so the banner it raises has expired by the first frame.
    st.run.mapFound = true;
    const foes = st.enemies.filter((e) => e.st !== 6);
    if (foes.length === 0) return;
    const e = foes[0];
    const tiles = st.levelData.maze.tiles;
    const w = st.levelData.maze.width;
    const solid = (x, y) => tiles[Math.floor(y) * w + Math.floor(x)] !== 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let reach = 0;
      for (let d = 0.5; d <= 3.5; d += 0.5) {
        if (solid(e.x + dx * d, e.y + dy * d)) break;
        reach = d;
      }
      if (reach >= 2) {
        const p = st.player;
        p.x = e.x + dx * reach;
        p.y = e.y + dy * reach;
        p.px = p.x;
        p.py = p.y;
        p.angle = Math.atan2(e.y - p.y, e.x - p.x);
        p.pangle = p.angle;
        break;
      }
    }
  });

  // Let the scene settle before the first frame: the iris is still wiping open for ~0.4 s after a
  // level installs, and the "Map Found" banner runs for ~1.6 s. Recording through either means a
  // second of black and a caption over the gameplay.
  await new Promise((r) => setTimeout(r, 3800));

  const client = await page.createCDPSession();
  const frames = [];
  const total = Math.round(SECONDS * FPS);
  const stepMs = 1000 / FPS;

  // A little script of real input, played through the same injection path a tool uses: walk in,
  // swing, back off, look around. Everything the sim does with it is ordinary gameplay.
  const beat = (i) => {
    const t = i / total;
    if (t < 0.18) return { moveY: 1 };
    if (t < 0.3) return { pressed: ['attack'] };
    if (t < 0.38) return { moveY: 0, turn: 0.35 };
    if (t < 0.5) return { pressed: ['attack'], turn: 0 };
    if (t < 0.62) return { moveY: -1 };
    if (t < 0.72) return { moveY: 0, turn: -0.5 };
    if (t < 0.84) return { moveY: 1, turn: 0 };
    return { pressed: ['attack'] };
  };

  for (let i = 0; i < total; i++) {
    await page.evaluate((b) => window.__game.input.inject(b), beat(i));
    const shot = await page.screenshot({ type: 'png', optimizeForSpeed: true });
    frames.push(decodePng(Buffer.from(shot)).rgb);
    await new Promise((r) => setTimeout(r, stepMs));
  }
  await client.detach().catch(() => {});
  await page.evaluate(() => window.__game.input.clear());

  const gif = encodeGif(WIDTH, height, frames, Math.round(100 / FPS));
  const file = path.join(OUT, NAME);
  fs.writeFileSync(file, gif);
  console.log(errors.length ? `console/page issues:\n  ${errors.join('\n  ')}` : 'no console errors');
  console.log(`${file}  ${WIDTH}×${height}, ${frames.length} frames @ ${FPS} fps, ${(gif.length / 1024).toFixed(0)} kB`);
} finally {
  await browser.close();
}
