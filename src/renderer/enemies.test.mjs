// @ts-check
/**
 * @file New Descent's art (ARCHITECTURE.md §4.11).
 *
 * Sprites cannot be asserted on beauty, so this asserts the things that made them *wrong* while
 * they were being drawn, each of which produced a plausible-looking frame and a broken one on
 * screen: art that runs off the edge of its card, a creature that fills a fifth of the sprite it is
 * given, a frame index the renderer and the painter disagree about, and a palette index nothing in
 * the game can draw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENEMY_ART,
  ENEMY_FRAMES,
  ENEMY_FRAME_COUNT,
  ENEMY_POSE,
  ENEMY_POSE_COUNT,
  ENEMY_VIEWS,
  SHADOW_INDEX,
  SWORD_FRAMES,
  SWORD_SMEAR_FRAMES,
  createCombatTextures,
  enemyFrameIndex,
} from './enemies.js';
import { PALETTE_SIZE } from './palette.js';
import { SIZE } from './textures.js';

/** Painted once: it is ~100 ms, and every test below reads the same set. */
const SET = createCombatTextures();

/**
 * The bounding box of a frame's non-transparent texels, or null when it is empty.
 * @param {any} tex
 * @param {boolean} [bodyOnly] ignore the ground shadow, which is allowed to run off the card
 */
function bbox(tex, bodyOnly) {
  let x0 = SIZE;
  let y0 = SIZE;
  let x1 = -1;
  let y1 = -1;
  let n = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const idx = tex.indices[(y << 6) | x];
      if (idx === 0) continue;
      if (bodyOnly === true && idx === SHADOW_INDEX) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return n === 0 ? null : { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const KINDS = /** @type {const} */ (['crawler', 'wraith']);

// ─── Frame indexing ──────────────────────────────────────────────────────────────────────────

test('enemyFrameIndex is total, in range, and one-to-one over the gait grid', () => {
  const seen = new Set();
  for (let v = 0; v < ENEMY_VIEWS; v++) {
    for (let g = 0; g < ENEMY_FRAMES; g++) {
      const i = enemyFrameIndex(v, -1, g);
      assert.ok(i >= 0 && i < ENEMY_FRAME_COUNT, `(${v},${g}) in range`);
      assert.equal(seen.has(i), false, `(${v},${g}) is its own slot`);
      seen.add(i);
    }
  }
  assert.equal(seen.size, ENEMY_VIEWS * ENEMY_FRAMES);
  // Poses sit past the grid and ignore the view (they are painted front-on).
  for (const pose of Object.values(ENEMY_POSE)) {
    const i = enemyFrameIndex(0, pose);
    assert.ok(i >= ENEMY_VIEWS * ENEMY_FRAMES && i < ENEMY_FRAME_COUNT);
    assert.equal(enemyFrameIndex(4, pose), i, 'a pose is the same frame from every view');
  }
  assert.equal(ENEMY_FRAME_COUNT, ENEMY_VIEWS * ENEMY_FRAMES + ENEMY_POSE_COUNT);
});

test('enemyFrameIndex never indexes off the array, whatever it is handed', () => {
  for (const [v, p, g] of [[-99, -1, -99], [999, -1, 999], [0, 99, 0], [NaN, -1, NaN], [1.7, -1, 2.9]]) {
    const i = enemyFrameIndex(v, p, g);
    assert.ok(Number.isInteger(i) && i >= 0 && i < ENEMY_FRAME_COUNT, `(${v},${p},${g}) → ${i}`);
  }
});

// ─── The creatures ───────────────────────────────────────────────────────────────────────────

test('every creature frame is painted, on palette, and inside its card', () => {
  for (const kind of KINDS) {
    const frames = SET[kind];
    assert.equal(frames.length, ENEMY_FRAME_COUNT, `${kind}: every frame`);
    frames.forEach((tex, i) => {
      assert.equal(tex.w, SIZE);
      assert.equal(tex.h, SIZE);
      const box = bbox(tex, true);
      assert.ok(box !== null, `${kind} frame ${i} drew nothing`);
      // Every texel is a real palette index — index 0 is the transparency key, never a colour.
      for (let k = 0; k < tex.indices.length; k++) {
        assert.ok(tex.indices[k] < PALETTE_SIZE, `${kind} frame ${i} has an off-palette index`);
      }
      // The BODY must not touch any edge: a creature whose head or flank is cut off by its own
      // sprite is the bug this catches, and it looks entirely fine in the painter. The shadow it
      // casts is excluded (`bodyOnly`) — a clipped shadow is just a shadow.
      assert.ok(box.y0 > 0, `${kind} frame ${i} is cut off at the top (y0 ${box.y0})`);
      assert.ok(box.x0 > 0, `${kind} frame ${i} is cut off on the left`);
      assert.ok(box.x1 < SIZE - 1, `${kind} frame ${i} is cut off on the right`);
    });
  }
});

test('a creature FILLS its card — the sprite is its resolution', () => {
  // The first pass of the crawler used 18 of 64 rows, so three quarters of every frame was empty
  // air and what reached the screen was 18 texels of detail magnified over a monster.
  //
  // Measured on the LONG axis, not on both: the card is square and these creatures are not. A
  // crawler is twice as wide as it is tall, so demanding 40 % of the card in both directions would
  // demand a crawler that does not fit in it — which is how the first fix of this drove the sprite
  // back down again. The property that matters is that the art is not floating in empty space.
  for (const kind of KINDS) {
    const box = bbox(SET[kind][enemyFrameIndex(0, -1, 0)], true);
    assert.ok(box !== null);
    const long = Math.max(box.w, box.h);
    assert.ok(long >= SIZE * 0.6, `${kind} spans only ${long}/${SIZE} on its long axis`);
    assert.ok(box.w * box.h >= SIZE * SIZE * 0.2, `${kind} covers too little of its card`);
  }
});

test('the two creatures are told apart by silhouette, not only by colour', () => {
  // §4.11: at 240p under a guttering torch, shape is the distinction a player can actually read.
  const crawler = bbox(SET.crawler[enemyFrameIndex(0, -1, 0)], true);
  const wraith = bbox(SET.wraith[enemyFrameIndex(0, -1, 0)], true);
  assert.ok(crawler !== null && wraith !== null);
  assert.ok(crawler.w / crawler.h > 1.4, `the crawler is wide and low (${crawler.w}×${crawler.h})`);
  assert.ok(wraith.h / wraith.w > 1.1, `the wraith is a tall column (${wraith.w}×${wraith.h})`);
});

test('the gait animates: no two frames of a view are the same picture', () => {
  for (const kind of KINDS) {
    for (let v = 0; v < ENEMY_VIEWS; v++) {
      for (let g = 1; g < ENEMY_FRAMES; g++) {
        const a = SET[kind][enemyFrameIndex(v, -1, 0)].indices;
        const b = SET[kind][enemyFrameIndex(v, -1, g)].indices;
        let diff = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
        assert.ok(diff > 20, `${kind} view ${v} frame ${g} differs from frame 0 by only ${diff} texels`);
      }
    }
  }
});

test('the views actually turn: facing away is a different picture from facing you', () => {
  for (const kind of KINDS) {
    const front = SET[kind][enemyFrameIndex(0, -1, 0)].indices;
    const back = SET[kind][enemyFrameIndex(ENEMY_VIEWS >> 1, -1, 0)].indices;
    let diff = 0;
    for (let i = 0; i < front.length; i++) if (front[i] !== back[i]) diff++;
    assert.ok(diff > 150, `${kind}: front and back differ by only ${diff} texels`);
  }
});

test('the billboard stands ON the floor: the art’s floor row is inside its own card', () => {
  for (const kind of KINDS) {
    const art = ENEMY_ART[kind];
    assert.ok(art.scale > 0 && art.scale < 3, `${kind} scale ${art.scale}`);
    assert.ok(art.floorRow > SIZE / 2 && art.floorRow < SIZE, `${kind} floorRow ${art.floorRow}`);
    // The vertical offset the raycaster derives from this pair (the map scroll's formula, §4.5)
    // must keep the sprite's centre near eye height rather than underground or in the ceiling.
    const vOff = 0.5 - (art.scale * (art.floorRow + 1 - SIZE / 2)) / SIZE;
    assert.ok(Math.abs(vOff) < 0.6, `${kind} vOff ${vOff.toFixed(3)} is off the wall`);
  }
});

test('a wraith is not taller than the corridor it walks down', () => {
  // It was, at first: 1.16 tiles, so its hood was cut off by the top of the view at exactly the
  // range it is fought — the one part of the creature a player needs to see.
  const art = ENEMY_ART.wraith;
  const box = bbox(SET.wraith[enemyFrameIndex(0, -1, 0)], true);
  assert.ok(box !== null);
  const tiles = (box.h / SIZE) * art.scale;
  assert.ok(tiles < 1, `a wraith stands ${tiles.toFixed(2)} tiles tall`);
  assert.ok(tiles > 0.6, `…and is still taller than the player's eye (${tiles.toFixed(2)})`);
});

// ─── The sword ───────────────────────────────────────────────────────────────────────────────

test('every sword pose keeps its point and its edge on the card', () => {
  assert.equal(SET.sword.length, SWORD_FRAMES);
  SET.sword.forEach((tex, i) => {
    const box = bbox(tex);
    assert.ok(box !== null, `sword frame ${i} drew nothing`);
    // Left and top must be clear: that is where the BLADE goes, and a blade with no point reads as
    // a broken stick. The right and bottom are meant to run off — that is the hand.
    assert.ok(box.x0 > 0, `sword frame ${i} clips the point off on the left`);
    assert.ok(box.y0 > 0, `sword frame ${i} clips the point off at the top`);
    assert.ok(box.n > 120, `sword frame ${i} has almost nothing in it (${box.n} texels)`);
    for (let k = 0; k < tex.indices.length; k++) {
      assert.ok(tex.indices[k] < PALETTE_SIZE, `sword frame ${i} has an off-palette index`);
    }
  });
});

test('the sword reads as a sword: mostly blade, and it moves through the swing', () => {
  const rest = bbox(SET.sword[0]);
  assert.ok(rest !== null);
  assert.ok(rest.h > rest.w, `the rest pose is longer than it is wide (${rest.w}×${rest.h})`);
  // The cut's fast frames carry a motion smear; nothing else does. Checked against the painter's
  // own list, so re-timing the arc cannot leave this asserting stale frame numbers.
  const stippled = SET.sword.map((t) => (t.stipple === null ? 0 : t.stipple.reduce((a, b) => a + b, 0)));
  const smeared = stippled.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
  for (const i of smeared) {
    assert.ok(SWORD_SMEAR_FRAMES.includes(i), `frame ${i} smears but is not a cut frame`);
  }
  assert.ok(smeared.length >= 3, `the cut smears (${stippled.join(',')})`);
  assert.equal(stippled[0], 0, 'the rest pose does not');
  // And every pose is a different picture — eight frames of the same sword is not an animation.
  for (let i = 1; i < SWORD_FRAMES; i++) {
    const a = SET.sword[0].indices;
    const b = SET.sword[i].indices;
    let diff = 0;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) diff++;
    assert.ok(diff > 60, `sword frame ${i} is barely different from rest (${diff} texels)`);
  }
});

// ─── Determinism ─────────────────────────────────────────────────────────────────────────────

test('the same seed paints byte-identical art', () => {
  const a = createCombatTextures(0x1234);
  const b = createCombatTextures(0x1234);
  for (const kind of KINDS) {
    for (let i = 0; i < ENEMY_FRAME_COUNT; i++) {
      assert.deepEqual(a[kind][i].indices, b[kind][i].indices, `${kind} frame ${i}`);
    }
  }
  for (let i = 0; i < SWORD_FRAMES; i++) assert.deepEqual(a.sword[i].indices, b.sword[i].indices);
});

test('painting the set is affordable on a loading screen', () => {
  const t0 = performance.now();
  createCombatTextures(0x99);
  const ms = performance.now() - t0;
  // It runs once per session, inside `MIN_LOAD_S` (800 ms). Generous, because CI hardware varies —
  // this catches an order-of-magnitude regression (another view, a shadow map on both creatures),
  // not a slow machine.
  assert.ok(ms < 600, `painting took ${ms.toFixed(0)} ms`);
});
