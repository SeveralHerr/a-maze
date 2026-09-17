// @ts-check
/**
 * @file Unit tests for src/state/save.js — round trips, and every way persistence can go wrong:
 * absent storage, storage that throws, corrupt JSON, foreign records, version drift, quota.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSIST_KEY,
  PERSIST_VERSION,
  clearPersist,
  defaultPersist,
  getDefaultStorage,
  loadPersist,
  savePersist,
} from './save.js';
import { defaultSettings } from './balance.js';

/**
 * A minimal in-memory `localStorage` stand-in, with optional failure injection.
 * @param {{ getThrows?: boolean, setThrows?: boolean, removeThrows?: boolean, seed?: Record<string,string> }} [opts]
 */
function fakeStorage(opts = {}) {
  /** @type {Map<string, string>} */
  const map = new Map(Object.entries(opts.seed ?? {}));
  return {
    map,
    /** @param {string} k */
    getItem(k) {
      if (opts.getThrows) throw new DOMException('SecurityError');
      return map.has(k) ? /** @type {string} */ (map.get(k)) : null;
    },
    /** @param {string} k @param {string} v */
    setItem(k, v) {
      if (opts.setThrows) throw new DOMException('QuotaExceededError');
      map.set(k, String(v));
    },
    /** @param {string} k */
    removeItem(k) {
      if (opts.removeThrows) throw new DOMException('SecurityError');
      map.delete(k);
    },
  };
}

// ─── Round trip ──────────────────────────────────────────────────────────────────────────────

test('round trip: what goes in comes back out', () => {
  const store = fakeStorage();
  const settings = { ...defaultSettings(), volume: 0.25, sensitivity: 2.5, scanlines: false };
  const best = { score: 12345, level: 7 };
  assert.equal(savePersist({ best, settings }, store), true);
  assert.equal(store.map.size, 1);
  assert.ok(store.map.has(PERSIST_KEY), 'written under the contract key');

  const loaded = loadPersist(store);
  assert.deepEqual(loaded.best, best);
  assert.deepEqual(loaded.settings, settings);
});

test('round trip: the stored record carries its schema version', () => {
  const store = fakeStorage();
  savePersist({ best: { score: 1, level: 1 }, settings: defaultSettings() }, store);
  const raw = JSON.parse(/** @type {string} */ (store.map.get(PERSIST_KEY)));
  assert.equal(raw.v, PERSIST_VERSION);
  assert.equal(PERSIST_KEY, 'amaze.v1');
});

test('round trip: values are sanitised on the way in and on the way out', () => {
  const store = fakeStorage();
  savePersist(
    { best: { score: -9, level: 4.8 }, settings: { volume: 12, sensitivity: -1, minimap: 'yes' } },
    store,
  );
  const loaded = loadPersist(store);
  assert.deepEqual(loaded.best, { score: 0, level: 4 });
  assert.equal(loaded.settings.volume, 1);
  assert.equal(loaded.settings.sensitivity, 0.2);
  assert.equal(loaded.settings.minimap, defaultSettings().minimap, 'junk fell back to the default');
});

// ─── Corruption & hostile input ──────────────────────────────────────────────────────────────

test('load: corrupted JSON falls back to defaults instead of throwing', () => {
  for (const raw of [
    '{ not json',
    '',
    'null',
    'undefined',
    '[]',
    '"amaze"',
    '42',
    '{"v":1}',
    '{"v":1,"best":"nope","settings":7}',
    '{"v":2,"best":{"score":99999,"level":9}}',
    '{"best":{"score":99999,"level":9}}',
  ]) {
    const store = fakeStorage({ seed: { [PERSIST_KEY]: raw } });
    const loaded = loadPersist(store);
    assert.deepEqual(loaded.settings, defaultSettings(), `settings for ${raw}`);
    assert.ok(loaded.best.score >= 0 && Number.isInteger(loaded.best.score));
    if (raw.indexOf('"v":1') < 0) {
      assert.deepEqual(loaded.best, { score: 0, level: 0 }, `a foreign record is discarded: ${raw}`);
    }
  }
});

test('load: an implausibly large record is ignored rather than parsed', () => {
  const store = fakeStorage({ seed: { [PERSIST_KEY]: `{"v":1,"pad":"${'x'.repeat(8000)}"}` } });
  assert.deepEqual(loadPersist(store), defaultPersist());
});

test('load: a partially valid record keeps what it can', () => {
  const store = fakeStorage({
    seed: {
      [PERSIST_KEY]: JSON.stringify({ v: 1, best: { score: 500, level: 2 }, settings: { volume: 0.1 } }),
    },
  });
  const loaded = loadPersist(store);
  assert.deepEqual(loaded.best, { score: 500, level: 2 });
  assert.equal(loaded.settings.volume, 0.1);
  assert.equal(loaded.settings.music, defaultSettings().music);
});

test('load: prototype-polluting payloads cannot poison the result', () => {
  const store = fakeStorage({
    seed: {
      [PERSIST_KEY]: '{"v":1,"best":{"__proto__":{"pwned":1},"score":5,"level":1},"settings":{"__proto__":{"pwned":1}}}',
    },
  });
  const loaded = loadPersist(store);
  assert.equal(/** @type {any} */ ({}).pwned, undefined, 'Object.prototype is clean');
  assert.equal(loaded.best.score, 5);
  assert.deepEqual(loaded.settings, defaultSettings());
});

// ─── Missing / hostile storage ───────────────────────────────────────────────────────────────

test('storage: absent storage yields defaults and a false save', () => {
  assert.deepEqual(loadPersist(null), defaultPersist());
  assert.equal(savePersist({ best: { score: 1, level: 1 } }, null), false);
  assert.equal(clearPersist(null), false);
  assert.deepEqual(loadPersist(/** @type {any} */ ({})), defaultPersist(), 'a shapeless storage is refused');
  assert.equal(savePersist({}, /** @type {any} */ ({})), false);
});

test('storage: a storage that throws is handled on every path', () => {
  assert.deepEqual(loadPersist(fakeStorage({ getThrows: true })), defaultPersist());
  assert.equal(savePersist({ best: { score: 1, level: 1 } }, fakeStorage({ setThrows: true })), false);
  assert.equal(clearPersist(fakeStorage({ removeThrows: true })), false);
});

test('save: garbage input is normalised rather than rejected', () => {
  const store = fakeStorage();
  assert.equal(savePersist(null, store), true);
  assert.deepEqual(loadPersist(store), defaultPersist());
  assert.equal(savePersist(/** @type {any} */ ('nope'), store), true);
  assert.deepEqual(loadPersist(store), defaultPersist());
  assert.equal(savePersist({ best: { score: Infinity, level: NaN } }, store), true);
  assert.deepEqual(loadPersist(store).best, { score: 0, level: 0 });
});

test('clear: removes only our key', () => {
  const store = fakeStorage({ seed: { 'someone.else': 'keep me' } });
  savePersist({ best: { score: 7, level: 1 }, settings: defaultSettings() }, store);
  assert.equal(store.map.size, 2);
  assert.equal(clearPersist(store), true);
  assert.equal(store.map.has(PERSIST_KEY), false);
  assert.equal(store.map.get('someone.else'), 'keep me');
  assert.deepEqual(loadPersist(store), defaultPersist());
});

// ─── Node / DOM-less environment ─────────────────────────────────────────────────────────────

test('node: the module is a safe no-op with no ambient localStorage', () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  assert.equal(had, false, 'this test assumes a DOM-less Node process');
  assert.equal(getDefaultStorage(), null);
  assert.deepEqual(loadPersist(), defaultPersist());
  assert.equal(savePersist({ best: { score: 1, level: 1 } }), false);
  assert.equal(clearPersist(), false);
});

test('node: an ambient storage that throws on access is tolerated', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('SecurityError');
    },
  });
  try {
    assert.equal(getDefaultStorage(), null);
    assert.deepEqual(loadPersist(), defaultPersist());
  } finally {
    delete (/** @type {any} */ (globalThis).localStorage);
  }
});

test('node: an ambient storage is used when one exists', () => {
  const store = fakeStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  try {
    assert.equal(savePersist({ best: { score: 3, level: 3 }, settings: defaultSettings() }), true);
    assert.deepEqual(loadPersist().best, { score: 3, level: 3 });
    assert.equal(clearPersist(), true);
    assert.equal(store.map.size, 0);
  } finally {
    delete (/** @type {any} */ (globalThis).localStorage);
  }
});

// ─── Unlock progression (ARCHITECTURE.md §4.9) ───────────────────────────────────────────────

test('progress: purse, ranks and boon level survive a round trip, sanitised both ways', () => {
  const store = fakeStorage();
  const progress = { purse: 87, ranks: { reservoir: 2, chalk: 1, lodestone: 7 }, boonLevel: 3 };
  assert.equal(savePersist({ best: { score: 1, level: 1 }, settings: defaultSettings(), progress }, store), true);
  const loaded = loadPersist(store);
  assert.equal(loaded.progress.purse, 87);
  assert.equal(loaded.progress.ranks.reservoir, 2);
  assert.equal(loaded.progress.ranks.chalk, 1);
  assert.equal(loaded.progress.ranks.lodestone, 1, 'an impossible rank is clamped before it is written');
  assert.equal(loaded.progress.boonLevel, 3);
});

test('progress: a version-1 record from before the unlocks wave keeps its best and settings', () => {
  const settings = { ...defaultSettings(), volume: 0.3 };
  const legacy = JSON.stringify({ v: PERSIST_VERSION, best: { score: 900, level: 4 }, settings });
  const store = fakeStorage({ seed: { [PERSIST_KEY]: legacy } });
  const loaded = loadPersist(store);
  assert.deepEqual(loaded.best, { score: 900, level: 4 }, 'no wipe for existing players');
  assert.equal(loaded.settings.volume, 0.3);
  assert.equal(loaded.progress.purse, 0, 'progress simply starts empty');
});

test('progress: a save that omits progress keeps the progress already stored', () => {
  const store = fakeStorage();
  savePersist({ best: { score: 1, level: 1 }, settings: defaultSettings(), progress: { purse: 42, ranks: { chalk: 2 }, boonLevel: 1 } }, store);
  savePersist({ best: { score: 5, level: 2 }, settings: defaultSettings() }, store);
  const loaded = loadPersist(store);
  assert.equal(loaded.best.score, 5);
  assert.equal(loaded.progress.purse, 42, 'a settings-only write never wipes the purse');
  assert.equal(loaded.progress.ranks.chalk, 2);
});
