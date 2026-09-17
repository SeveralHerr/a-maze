// Art-review harness for New Descent's sprites (ARCHITECTURE.md §4.11): dumps every creature and
// sword frame `src/renderer/enemies.js` paints, straight to a PNG sheet. No browser and no dev
// server — the painter is Node-safe by contract, so looking at what it produced should not need
// either, and a round trip through Chrome is the slowest part of iterating on a sprite.
//
//   node tools/shot-combat.mjs [--out logs/combat] [--scale 4] [--seed 0xa11a2e] [--bg 0x101018]
//
// Writes <out>/crawler.png, wraith.png, sword.png and combat-sheet.png (all three stacked), and
// prints the paths plus each frame's bounding box, which is how a frame that has drifted off its
// 64-texel card is caught (`enemies.test.mjs` asserts the same thing).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { PALETTE_RGB } from '../src/renderer/palette.js';
import {
  ENEMY_FRAMES,
  ENEMY_VIEWS,
  SHADOW_INDEX,
  createCombatTextures,
} from '../src/renderer/enemies.js';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const OUT = arg('out', 'logs/combat');
const SCALE = Math.max(1, Number(arg('scale', '4')) | 0);
const SEED = Number(arg('seed', String(0xa11a2e)));
const BG = Number(arg('bg', String(0x101018)));
fs.mkdirSync(OUT, { recursive: true });

/** Minimal PNG encoder: 8-bit RGB, one filter byte per row, one deflate block. */
function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const to = y * (width * 3 + 1);
    raw[to] = 0; // filter: none
    rgb.copy(raw, to + 1, y * width * 3, (y + 1) * width * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Lay frames out in a grid and rasterise them into an RGB buffer at `SCALE`. */
function sheet(frames, cols, label) {
  const rows = Math.ceil(frames.length / cols);
  const cell = 64 * SCALE;
  const gap = SCALE;
  const w = cols * (cell + gap) + gap;
  const h = rows * (cell + gap) + gap;
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    // A checker behind the art, so a transparent texel is obvious and a dark sprite still reads.
    const x = i % w;
    const y = (i / w) | 0;
    const checker = (((x / (4 * SCALE)) | 0) + ((y / (4 * SCALE)) | 0)) & 1;
    const base = checker ? BG : BG + 0x0a0a0c;
    rgb[i * 3] = (base >> 16) & 255;
    rgb[i * 3 + 1] = (base >> 8) & 255;
    rgb[i * 3 + 2] = base & 255;
  }
  const boxes = [];
  frames.forEach((tex, k) => {
    const ox = gap + (k % cols) * (cell + gap);
    const oy = gap + ((k / cols) | 0) * (cell + gap);
    let x0 = 99;
    let y0 = 99;
    let x1 = -1;
    let y1 = -1;
    for (let ty = 0; ty < 64; ty++) {
      for (let tx = 0; tx < 64; tx++) {
        const idx = tex.indices[(ty << 6) | tx];
        if (idx === 0) continue;
        // The bounding box measures the creature, not the shadow it casts: a shadow is allowed to
        // run off the card, and counting it made every frame look clipped (`enemies.test.mjs`
        // draws the same distinction).
        if (idx !== SHADOW_INDEX) {
          if (tx < x0) x0 = tx;
          if (tx > x1) x1 = tx;
          if (ty < y0) y0 = ty;
          if (ty > y1) y1 = ty;
        }
        const r = PALETTE_RGB[idx * 3];
        const g = PALETTE_RGB[idx * 3 + 1];
        const b = PALETTE_RGB[idx * 3 + 2];
        for (let sy = 0; sy < SCALE; sy++) {
          for (let sx = 0; sx < SCALE; sx++) {
            const px = ox + tx * SCALE + sx;
            const py = oy + ty * SCALE + sy;
            const o = (py * w + px) * 3;
            rgb[o] = r;
            rgb[o + 1] = g;
            rgb[o + 2] = b;
          }
        }
      }
    }
    boxes.push({ frame: k, n: x1 < 0 ? 0 : 1, x0, y0, x1, y1 });
  });
  return { w, h, rgb, boxes, label };
}

const set = createCombatTextures(SEED);
const written = [];
const parts = [
  sheet(set.crawler, ENEMY_FRAMES, 'crawler'),
  sheet(set.wraith, ENEMY_FRAMES, 'wraith'),
  sheet(set.sword, 4, 'sword'),
];
for (const part of parts) {
  const file = path.join(OUT, `${part.label}.png`);
  fs.writeFileSync(file, encodePng(part.w, part.h, part.rgb));
  written.push(file);
  const clipped = part.boxes.filter((b) => b.x1 >= 0 && (b.x0 <= 0 || b.x1 >= 63 || b.y0 <= 0));
  console.log(
    `${part.label}: ${part.boxes.length} frames, ${part.w}×${part.h}` +
      (clipped.length ? ` — ${clipped.length} touch a card edge (${clipped.map((b) => b.frame).join(',')})` : ''),
  );
}
// One stacked sheet, so the two creatures can be compared side by side at a glance.
const totalW = Math.max(...parts.map((p) => p.w));
const totalH = parts.reduce((a, p) => a + p.h, 0);
const all = Buffer.alloc(totalW * totalH * 3);
let yo = 0;
for (const part of parts) {
  for (let y = 0; y < part.h; y++) {
    part.rgb.copy(all, ((yo + y) * totalW) * 3, y * part.w * 3, (y + 1) * part.w * 3);
  }
  yo += part.h;
}
const sheetFile = path.join(OUT, 'combat-sheet.png');
fs.writeFileSync(sheetFile, encodePng(totalW, totalH, all));
written.push(sheetFile);
console.log(`\nviews ${ENEMY_VIEWS} × gait ${ENEMY_FRAMES} then the poses; rows are views.`);
for (const f of written) console.log(f);
