// @ts-check
/**
 * @file Saved runs (ARCHITECTURE.md §4.10): snapshot → storage → `continueRun` → `levelReady` puts
 * the run back exactly where it was, and every way a save can be wrong degrades safely.
 *
 * Cross-module note: builds real mazes with `src/maze` (test-only), like `feasibility.test.mjs`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLevel } from '../maze/level.js';
import { levelParams } from './balance.js';
import { createInitialState, reducer } from './game.js';
import { createAutopilot } from './autopilot.js';
import { clearRun, loadRun, RUN_KEY, saveRun } from './save.js';
import {
  decodeBits,
  encodeBits,
  sanitizeRunSave,
  snapshotCheckpoint,
  snapshotMidLevel,
  summarizeRunSave,
  tileHash,
} from './runsave.js';

/** In-memory `StorageLike`. */
function memoryStorage() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return {
    getItem: (/** @type {string} */ k) => (m.has(k) ? /** @type {string} */ (m.get(k)) : null),
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => void m.set(k, v),
    removeItem: (/** @type {string} */ k) => void m.delete(k),
    map: m,
  };
}

/** The maze seed main.js would use for `level` of a run (any fixed function works for the test). */
const mazeSeedFor = (/** @type {number} */ seed, /** @type {number} */ level) => (seed * 7919 + level) >>> 0;

/**
 * A run on `level`, played by the autopilot for `seconds`, then paused.
 * @param {number} level
 * @param {number} seed
 * @param {number} seconds
 */
function playedAndPaused(level, seed, seconds) {
  const s = createInitialState();
  reducer(s, { type: 'newGame', seed });
  s.level = level;
  reducer(s, { type: 'levelReady', data: buildLevel(levelParams(level), mazeSeedFor(seed, level)) });
  const ap = createAutopilot();
  const f = { moveX: 0, moveY: 0, turn: 0, lookDX: 0, pressed: new Set() };
  const tick = { type: 'tick', dt: 1 / 60, input: f };
  for (let i = 0; i < seconds * 60 && s.phase === 'playing'; i++) {
    ap.step(s, f);
    reducer(s, tick);
  }
  assert.equal(s.phase, 'playing', 'the fixture run should still be going');
  reducer(s, { type: 'pause' });
  return s;
}

/**
 * A fresh title-screen state that continues `save`, with its level built from `mazeSeed`.
 * @param {any} save
 * @param {number} mazeSeed
 */
function continued(save, mazeSeed) {
  const s = createInitialState();
  reducer(s, { type: 'continueRun', save });
  assert.equal(s.phase, 'loading');
  reducer(s, { type: 'levelReady', data: buildLevel(levelParams(s.level), mazeSeed) });
  return s;
}

test('bits round-trip through base64 at every length, including the cap level grid', () => {
  for (const count of [0, 1, 7, 8, 9, 23, 24, 25, 820, 257 * 257]) {
    const src = new Uint8Array(count);
    for (let i = 0; i < count; i++) src[i] = (Math.imul(i, 2654435761) >>> 29) & 1;
    const text = encodeBits((i) => src[i] === 1, count);
    assert.deepEqual(decodeBits(text, count), src, `count ${count}`);
  }
  assert.equal(decodeBits('AAA', 8), null, 'wrong length');
  assert.equal(decodeBits('A!A=', 8), null, 'bad character');
  assert.equal(decodeBits(42, 8), null, 'not a string');
});

test('a mid-level save puts the run back exactly where it was paused', () => {
  const store = memoryStorage();
  const a = playedAndPaused(4, 77, 75);
  const save = snapshotMidLevel(a);
  assert.ok(save !== null);
  assert.equal(saveRun(save, store), true);

  const loaded = loadRun(store);
  assert.ok(loaded !== null);
  const b = continued(loaded, loaded.mazeSeed ?? -1);
  assert.equal(b.phase, 'playing');
  assert.equal(b.level, a.level);
  assert.equal(b.seed, a.seed);
  assert.equal(b.player.x, a.player.x);
  assert.equal(b.player.y, a.player.y);
  assert.equal(b.player.angle, a.player.angle);
  assert.equal(b.run.score, a.run.score);
  assert.equal(b.run.fuel, a.run.fuel);
  assert.equal(b.run.fuelMax, a.run.fuelMax);
  assert.equal(b.run.gems, a.run.gems);
  assert.equal(b.run.levelTime, a.run.levelTime);
  assert.equal(b.run.totalTime, a.run.totalTime);
  assert.equal(b.run.distance, a.run.distance);
  assert.equal(b.run.refuels, a.run.refuels);
  assert.equal(b.run.mapFound, a.run.mapFound);
  assert.deepEqual(
    b.levelData.items.map((/** @type {any} */ it) => it.taken),
    a.levelData.items.map((/** @type {any} */ it) => it.taken),
  );
  assert.ok(a.levelData.items.some((/** @type {any} */ it) => it.taken), 'the fixture should have taken something');
  assert.deepEqual(b.explored, a.explored);
  assert.deepEqual(b.marks, a.marks);
  assert.equal(b.sim.runBestScore, a.sim.runBestScore);
});

test('a checkpoint save starts the next depth fresh with the run totals intact', () => {
  const store = memoryStorage();
  const a = playedAndPaused(1, 5, 5);
  reducer(a, { type: 'resume' });
  reducer(a, { type: 'debugWin' });
  assert.equal(a.phase, 'levelComplete');
  assert.equal(saveRun(snapshotCheckpoint(a), store), true);
  const loaded = /** @type {any} */ (loadRun(store));
  assert.equal(loaded.level, 2);
  assert.equal(loaded.mid, null);
  const b = continued(loaded, mazeSeedFor(5, 2));
  assert.equal(b.phase, 'playing');
  assert.equal(b.level, 2);
  assert.equal(b.run.score, a.run.score);
  assert.equal(b.run.fuel, b.run.fuelMax, 'a new depth starts on a full tank');
  assert.equal(b.run.gems, 0);
});

test('a save whose maze no longer matches starts the level fresh instead of misapplying bits', () => {
  const a = playedAndPaused(3, 11, 40);
  const save = /** @type {any} */ (snapshotMidLevel(a));
  // A different maze seed stands in for a generator that changed between save and load.
  const b = continued(save, (save.mazeSeed + 1) >>> 0);
  assert.equal(b.phase, 'playing');
  assert.equal(b.run.score, a.run.score, 'totals survive');
  assert.equal(b.run.levelTime, 0, 'the floor starts over');
  assert.ok(b.levelData.items.every((/** @type {any} */ it) => !it.taken));
});

test('continueRun is honoured only from the title, and never for garbage', () => {
  const a = playedAndPaused(2, 3, 10);
  const save = snapshotMidLevel(a);
  for (const phase of ['playing', 'paused', 'loading', 'levelComplete', 'gameOver']) {
    const s = /** @type {any} */ (createInitialState());
    s.phase = phase;
    reducer(s, { type: 'continueRun', save });
    assert.equal(s.phase, phase, `ignored in ${phase}`);
  }
  for (const garbage of [null, 7, 'x', [], {}, { ...save, v: 99 }, { ...save, level: -1 }, { ...save, totals: null }]) {
    const s = createInitialState();
    reducer(s, { type: 'continueRun', save: garbage });
    assert.equal(s.phase, 'title', `ignored for ${JSON.stringify(garbage)?.slice(0, 40)}`);
  }
});

test('sanitizeRunSave rejects every malformed mid-level field and copies nothing by reference', () => {
  const a = playedAndPaused(2, 8, 20);
  const save = /** @type {any} */ (snapshotMidLevel(a));
  const good = sanitizeRunSave(JSON.parse(JSON.stringify(save)));
  assert.ok(good !== null);
  assert.notEqual(good.mid, save.mid);
  const bad = [
    { x: -1 },
    { y: Number.NaN },
    { fuel: -5 },
    { gems: save.mid.items + 1 },
    { taken: save.mid.taken.slice(1) },
    { explored: 'AAAA' },
    { marks: [[1, 2, 7, 0]] },
    { marks: 'no' },
    { w: 0 },
  ];
  for (const patch of bad) {
    const broken = { ...save, mid: { ...save.mid, ...patch } };
    assert.equal(sanitizeRunSave(broken), null, `rejects ${JSON.stringify(patch).slice(0, 40)}`);
  }
  assert.equal(sanitizeRunSave({ ...save, mazeSeed: null }), null, 'a mid-level save needs its maze seed');
});

test('storage: absent, throwing, corrupt and cleared all degrade to "no saved run"', () => {
  assert.equal(loadRun(null), null);
  assert.equal(saveRun({ v: 1 }, null), false);
  const throwing = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(loadRun(throwing), null);
  const a = playedAndPaused(1, 2, 5);
  assert.equal(saveRun(snapshotMidLevel(a), throwing), false);
  assert.equal(clearRun(throwing), false);

  const store = memoryStorage();
  store.setItem(RUN_KEY, '{not json');
  assert.equal(loadRun(store), null);
  assert.equal(saveRun(snapshotMidLevel(a), store), true);
  assert.ok(loadRun(store) !== null);
  assert.equal(clearRun(store), true);
  assert.equal(loadRun(store), null);
});

test('a save at the size cap stays small, and the summary names depth and score', () => {
  const a = playedAndPaused(15, 4, 20);
  const save = /** @type {any} */ (snapshotMidLevel(a));
  const text = JSON.stringify(save);
  assert.ok(text.length < 16 * 1024, `cap-level save is ${text.length} chars`);
  assert.equal(save.mid.hash, tileHash(a.levelData.maze.tiles));
  assert.deepEqual(summarizeRunSave(save), { level: 15, score: a.run.score, mid: true });
  assert.equal(summarizeRunSave(null), null);
});
