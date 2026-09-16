// @ts-check
/**
 * @file Unit tests for src/state/balance.js — the difficulty curve, the score formulas pinned by
 * ARCHITECTURE.md §1, and settings validation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTRACT,
  BUMP,
  FUEL,
  LEVEL,
  PLAYER,
  SCORE,
  SETTING_KEYS,
  WORLD,
  coerceSetting,
  defaultSettings,
  gemScore,
  levelBonus,
  levelParams,
  oilFuel,
  sanitizeBest,
  sanitizeSettings,
} from './balance.js';

// ─── Invariants the sim depends on ───────────────────────────────────────────────────────────

test('constants: the invariants the collision solver and feel depend on', () => {
  assert.ok(PLAYER.RADIUS < 0.5, 'the body must fit in a 1-tile corridor');
  assert.ok(PLAYER.MAX_SUBSTEP < PLAYER.RADIUS, 'a substep must not out-run the body radius');
  assert.ok(PLAYER.MAX_SUBSTEP < 1, 'a substep must not skip a wall tile');
  assert.ok(
    Math.abs(PLAYER.ACCEL * PLAYER.TIME_TO_TOP_SPEED - PLAYER.WALK_SPEED) < 1e-9,
    'ACCEL is derived from TIME_TO_TOP_SPEED',
  );
  assert.ok(PLAYER.FRICTION > PLAYER.ACCEL, 'stopping is at least as snappy as starting');
  assert.ok(WORLD.EXIT_RADIUS > WORLD.PICKUP_RADIUS, 'the portal is easier to hit than an item');
  assert.ok(FUEL.REARM_FRACTION > FUEL.LOW_FRACTION, 'the low-fuel cue needs hysteresis');
  assert.ok(BUMP.MIN_FRACTION > 0 && BUMP.MIN_FRACTION <= 1);
  assert.ok(ATTRACT.SPEED < PLAYER.WALK_SPEED, 'the title camera is calmer than the player');
  assert.ok(Object.isFrozen(PLAYER) && Object.isFrozen(FUEL) && Object.isFrozen(SCORE));
});

// ─── levelParams ─────────────────────────────────────────────────────────────────────────────

test('levelParams: level 1 is a 6×6 perfect maze with a generous tank', () => {
  const p = levelParams(1);
  assert.equal(p.cols, 6);
  assert.equal(p.rows, 6);
  assert.equal(p.braid, 0, 'level 1 is a perfect maze');
  assert.ok(p.fuelSeconds >= 90, `a forgiving first tank (${p.fuelSeconds} s)`);
  assert.equal(p.par, Math.round(p.fuelSeconds * FUEL.PAR_FRACTION));
  assert.ok(p.gems >= LEVEL.GEM_MIN);
  assert.ok(p.oil >= LEVEL.OIL_MIN);
});

test('levelParams: the curve grows, braids and tightens monotonically, then caps', () => {
  let prev = levelParams(1);
  for (let lv = 2; lv <= 60; lv++) {
    const p = levelParams(lv);
    assert.ok(p.cols >= prev.cols, `size never shrinks (level ${lv})`);
    assert.ok(p.braid >= prev.braid - 1e-12, `braid never falls (level ${lv})`);
    assert.ok(p.fuelPerCell <= prev.fuelPerCell + 1e-12, `per-cell fuel never rises (level ${lv})`);
    assert.equal(p.cols, p.rows, 'mazes are square');
    assert.ok(p.cols <= LEVEL.MAX_CELLS, 'size is capped');
    assert.ok(p.braid <= LEVEL.BRAID_MAX + 1e-12, 'braid is capped');
    assert.ok(p.gems >= LEVEL.GEM_MIN && p.gems <= LEVEL.GEM_MAX);
    assert.ok(p.oil >= LEVEL.OIL_MIN && p.oil <= LEVEL.OIL_MAX);
    assert.ok(Number.isInteger(p.gems) && Number.isInteger(p.oil));
    assert.ok(Number.isInteger(p.fuelSeconds) && Number.isInteger(p.par));
    assert.ok(p.fuelSeconds > 0 && p.fuelPerPathTile > 0);
    prev = p;
  }
  assert.equal(levelParams(18).cols, LEVEL.MAX_CELLS, 'the size cap is reached by level 18');
  assert.equal(levelParams(200).cols, LEVEL.MAX_CELLS);
  assert.ok(levelParams(11).braid >= LEVEL.BRAID_MAX - 1e-12, 'braid tops out on the ramp');
});

test('levelParams: garbage input degrades to level 1 instead of producing NaN', () => {
  for (const bad of [0, -5, NaN, Infinity, -Infinity, /** @type {any} */ ('7'), undefined, null]) {
    const p = levelParams(/** @type {any} */ (bad));
    assert.equal(p.cols, LEVEL.BASE_CELLS, `level ${String(bad)} → level 1`);
    assert.ok(Number.isFinite(p.fuelSeconds));
  }
  assert.equal(levelParams(3.9).cols, levelParams(3).cols, 'fractional levels floor');
});

// ─── Score (ARCHITECTURE.md §1) ──────────────────────────────────────────────────────────────

test('score: the formulas match the design document exactly', () => {
  for (let lv = 1; lv <= 12; lv++) {
    assert.equal(gemScore(lv), 100 * lv);
    for (const fuel of [0, 1, 12.9, 240]) {
      assert.equal(levelBonus(lv, fuel), 500 * lv + Math.floor(fuel) * 10 * lv);
    }
  }
  assert.equal(SCORE.GEM_BASE, 100);
  assert.equal(SCORE.CLEAR_BASE, 500);
  assert.equal(SCORE.FUEL_UNIT, 10);
});

test('score: degenerate arguments never produce NaN or negative points', () => {
  assert.equal(gemScore(NaN), 100);
  assert.equal(gemScore(0), 100);
  assert.equal(levelBonus(NaN, NaN), 500);
  assert.equal(levelBonus(1, -50), 500, 'negative fuel counts as none');
  assert.equal(levelBonus(2, Infinity), 1000, 'infinite fuel is ignored, not multiplied');
});

test('oilFuel: scales with the tank and stays inside its clamps', () => {
  assert.equal(oilFuel(0), FUEL.OIL_MIN);
  assert.equal(oilFuel(NaN), FUEL.OIL_MIN);
  assert.equal(oilFuel(1e9), FUEL.OIL_MAX);
  const mid = oilFuel(200);
  assert.ok(mid > FUEL.OIL_MIN && mid < FUEL.OIL_MAX, `a mid-size tank scales (${mid})`);
  assert.ok(oilFuel(300) >= oilFuel(200), 'monotonic in the tank size');
});

// ─── Settings ────────────────────────────────────────────────────────────────────────────────

test('defaultSettings: a complete, fresh, in-range object every call', () => {
  const a = defaultSettings();
  const b = defaultSettings();
  assert.notEqual(a, b, 'callers own the object');
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a).sort(), [...SETTING_KEYS].sort());
  assert.ok(a.volume >= 0 && a.volume <= 1);
  assert.ok(a.sensitivity >= 0.2 && a.sensitivity <= 3);
});

test('coerceSetting: clamps numbers, is strict about booleans, rejects unknown keys', () => {
  assert.equal(coerceSetting('volume', 0.5), 0.5);
  assert.equal(coerceSetting('volume', 4), 1);
  assert.equal(coerceSetting('volume', -4), 0);
  assert.equal(coerceSetting('volume', NaN), undefined);
  assert.equal(coerceSetting('volume', '0.5'), undefined, 'strings are not coerced');
  assert.equal(coerceSetting('sensitivity', 0.01), 0.2);
  assert.equal(coerceSetting('sensitivity', 99), 3);
  assert.equal(coerceSetting('scanlines', true), true);
  assert.equal(coerceSetting('scanlines', 1), true);
  assert.equal(coerceSetting('scanlines', 0), false);
  assert.equal(coerceSetting('scanlines', 'true'), undefined);
  assert.equal(coerceSetting('scanlines', 2), undefined);
  assert.equal(coerceSetting('nope', 1), undefined);
  assert.equal(coerceSetting('toString', 1), undefined, 'inherited properties are not settings');
  assert.equal(coerceSetting('volume', Infinity), undefined);
});

test('sanitizeSettings: fills gaps, drops junk, survives any input', () => {
  assert.deepEqual(sanitizeSettings(undefined), defaultSettings());
  assert.deepEqual(sanitizeSettings(null), defaultSettings());
  assert.deepEqual(sanitizeSettings(42), defaultSettings());
  assert.deepEqual(sanitizeSettings('{}'), defaultSettings());
  const s = sanitizeSettings({ volume: 0.25, minimap: false, sensitivity: 100, junk: 'x' });
  assert.equal(s.volume, 0.25);
  assert.equal(s.minimap, false);
  assert.equal(s.sensitivity, 3);
  assert.equal(s.music, defaultSettings().music, 'untouched keys keep their default');
  assert.equal(/** @type {any} */ (s).junk, undefined);
  assert.deepEqual(Object.keys(s).sort(), [...SETTING_KEYS].sort());
});

test('sanitizeBest: only non-negative integers survive', () => {
  assert.deepEqual(sanitizeBest(undefined), { score: 0, level: 0 });
  assert.deepEqual(sanitizeBest({ score: 1200.7, level: 3.9 }), { score: 1200, level: 3 });
  assert.deepEqual(sanitizeBest({ score: -5, level: -1 }), { score: 0, level: 0 });
  assert.deepEqual(sanitizeBest({ score: '900', level: null }), { score: 0, level: 0 });
  assert.deepEqual(sanitizeBest({ score: NaN, level: Infinity }), { score: 0, level: 0 });
  assert.deepEqual(sanitizeBest([1, 2]), { score: 0, level: 0 });
});
