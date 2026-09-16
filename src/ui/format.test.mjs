// @ts-check
/**
 * @file Unit tests for src/ui/format.js — number/time formatting and the rolling counter.
 * Run: `node src/ui/format.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLL,
  createCounter,
  createTextMemo,
  formatClock,
  formatCount,
  formatDepth,
  formatDistance,
  formatInt,
  formatLabyrinth,
  formatLevelBanner,
  formatPercent,
  formatScore,
  formatSigned,
  formatTime,
  formatUnits,
  padLeft,
  safeInt,
} from './format.js';

test('safeInt coerces anything to a displayable integer', () => {
  assert.equal(safeInt(12), 12);
  assert.equal(safeInt(12.9), 12);
  assert.equal(safeInt(-12.1), -13, 'floors toward -Infinity');
  assert.equal(safeInt(NaN), 0);
  assert.equal(safeInt(Infinity), 0, 'non-finite is an unknown, not a huge number');
  assert.equal(safeInt(-Infinity), 0);
  assert.equal(safeInt(1e12), 999999999, 'finite but absurd is clamped');
  assert.equal(safeInt(-1e12), -999999999);
  assert.equal(safeInt(/** @type {any} */ ('4')), 0, 'strings are not numbers');
  assert.equal(safeInt(/** @type {any} */ (null)), 0);
  assert.equal(safeInt(/** @type {any} */ (undefined)), 0);
});

test('formatInt groups thousands', () => {
  assert.equal(formatInt(0), '0');
  assert.equal(formatInt(7), '7');
  assert.equal(formatInt(999), '999');
  assert.equal(formatInt(1000), '1,000');
  assert.equal(formatInt(12345), '12,345');
  assert.equal(formatInt(999999), '999,999');
  assert.equal(formatInt(1234567), '1,234,567');
  assert.equal(formatInt(-1234), '-1,234');
  assert.equal(formatInt(1234.99), '1,234');
  assert.equal(formatScore(1234567), formatInt(1234567));
});

test('formatSigned always shows the sign for a gain', () => {
  assert.equal(formatSigned(100), '+100');
  assert.equal(formatSigned(0), '+0');
  assert.equal(formatSigned(-50), '-50');
  assert.equal(formatSigned(2500), '+2,500');
});

test('padLeft pads to width and never truncates', () => {
  assert.equal(padLeft('7', 2), '07');
  assert.equal(padLeft('7', 4, ' '), '   7');
  assert.equal(padLeft('1234', 2), '1234');
  assert.equal(padLeft('x', 0), 'x');
  assert.equal(padLeft('x', 3, ''), 'x', 'an empty pad cannot loop forever');
});

test('formatClock is zero-padded mm:ss and saturates', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(0.99), '00:00', 'seconds are floored like a stopwatch');
  assert.equal(formatClock(1), '00:01');
  assert.equal(formatClock(59.9), '00:59');
  assert.equal(formatClock(60), '01:00');
  assert.equal(formatClock(187), '03:07');
  assert.equal(formatClock(-5), '00:00');
  assert.equal(formatClock(NaN), '00:00');
  assert.equal(formatClock(1e9), '99:59');
});

test('formatTime drops the leading zero on minutes', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(9), '0:09');
  assert.equal(formatTime(187), '3:07');
  assert.equal(formatTime(-1), '0:00');
});

test('labels', () => {
  assert.equal(formatCount(3, 12), '3/12');
  assert.equal(formatCount(NaN, 12), '0/12');
  assert.equal(formatDepth(3), 'DEPTH 3');
  assert.equal(formatDepth(0), 'DEPTH 1', 'levels are 1-based');
  assert.equal(formatDepth(NaN), 'DEPTH 1');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(0.834), '83%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(4), '100%', 'clamped');
  assert.equal(formatPercent(NaN), '0%');
  assert.equal(formatDistance(11.4), '11m');
  assert.equal(formatDistance(Infinity), '--', 'no level loaded');
  assert.equal(formatDistance(-3), '0m');
});

test('counter rolls toward its target and stops exactly on it', () => {
  const c = createCounter(0);
  assert.equal(c.value, 0);
  assert.equal(c.done, true);

  c.set(2100);
  assert.equal(c.done, false);
  assert.equal(c.value, 0, 'set does not move the display');

  let t = 0;
  let guard = 0;
  while (!c.done && guard++ < 10000) {
    c.update(1 / 60);
    t += 1 / 60;
    assert.ok(c.value <= 2100, 'never overshoots');
  }
  assert.equal(c.value, 2100);
  assert.ok(t > 0.3 && t < 4, `should take a beat, not a moment or an age (took ${t.toFixed(2)}s)`);
});

test('counter handles snap, retarget mid-roll and downward rolls', () => {
  const c = createCounter(500);
  c.snap(1000);
  assert.equal(c.value, 1000);
  assert.equal(c.done, true);

  c.set(2000);
  c.update(0.1);
  const mid = c.value;
  assert.ok(mid > 1000 && mid < 2000, 'mid-roll');
  c.set(1200);
  let guard = 0;
  while (!c.done && guard++ < 10000) c.update(1 / 60);
  assert.equal(c.value, 1200, 'retargeting mid-roll lands on the new target');

  c.set(0);
  guard = 0;
  while (!c.done && guard++ < 10000) {
    c.update(1 / 60);
    assert.ok(c.value >= 0, 'never undershoots');
  }
  assert.equal(c.value, 0);
});

test('counter survives bad deltas', () => {
  const c = createCounter(0);
  c.set(100);
  assert.equal(c.update(/** @type {any} */ ('x')), false);
  assert.equal(c.update(-1), false);
  assert.equal(c.update(NaN), false);
  assert.equal(c.value, 0, 'a garbage dt advances nothing');
  // A huge dt finishes the roll rather than overshooting.
  c.update(10);
  assert.equal(c.value, 100);
  assert.equal(c.done, true);
});

test('counter sanitises its target', () => {
  const c = createCounter(/** @type {any} */ ('nope'));
  assert.equal(c.value, 0);
  c.set(/** @type {any} */ (NaN));
  assert.equal(c.target, 0);
  c.set(12.7);
  assert.equal(c.target, 12, 'targets are floored, never rounded up');
});

test('ROLL constants are sane', () => {
  assert.ok(ROLL.DURATION > 0 && ROLL.DURATION < 2);
  assert.ok(ROLL.MIN_RATE > 0);
  assert.ok(ROLL.SNAP_EPSILON > 0 && ROLL.SNAP_EPSILON < 1);
});

// ─── Massive-maze labels ─────────────────────────────────────────────────────────────────────

test('formatLabyrinth writes a cell size with a real multiplication sign', () => {
  assert.equal(formatLabyrinth(16, 16), '16×16');
  assert.equal(formatLabyrinth(128, 128), '128×128');
  // Degenerate input still reads as a maze rather than as "0×0" or "NaN×NaN".
  assert.equal(formatLabyrinth(0, -4), '1×1');
  assert.equal(formatLabyrinth(NaN, Infinity), '1×1');
});

test('formatLevelBanner is the loading screen line', () => {
  assert.equal(formatLevelBanner(7, 64, 64), 'DEPTH 7 · 64×64 LABYRINTH');
  assert.equal(formatLevelBanner(0, 16, 16), 'DEPTH 1 · 16×16 LABYRINTH', 'depth is 1-based');
});

test('formatDistance groups four-figure walks', () => {
  assert.equal(formatDistance(12), '12m');
  assert.equal(formatDistance(1240.4), '1,240m');
  assert.equal(formatDistance(-5), '0m');
  assert.equal(formatDistance(Infinity), '--', 'an unknown distance is not a number');
  assert.equal(formatDistance(NaN), '--');
});

test('formatUnits pluralises', () => {
  assert.equal(formatUnits(1, 'REFUEL'), '1 REFUEL');
  assert.equal(formatUnits(0, 'REFUEL'), '0 REFUELS');
  assert.equal(formatUnits(12, 'REFUEL'), '12 REFUELS');
});

test('createTextMemo rebuilds only when a key changes', () => {
  let builds = 0;
  const memo = createTextMemo((a, b) => {
    builds++;
    return formatCount(a, b);
  });
  assert.equal(memo(3, 12), '3/12');
  const first = memo(3, 12);
  assert.equal(builds, 1, 'the same keys hand back the cached string');
  assert.equal(memo(3, 12), first);
  assert.equal(memo(4, 12), '4/12');
  assert.equal(builds, 2);
  // NaN and Infinity are stable keys (an unloaded level's exit distance is Infinity).
  const dist = createTextMemo((d) => {
    builds++;
    return formatDistance(d);
  });
  builds = 0;
  assert.equal(dist(Infinity), '--');
  assert.equal(dist(Infinity), '--');
  assert.equal(dist(NaN), '--');
  assert.equal(dist(NaN), '--');
  assert.equal(builds, 2);
  // Omitted keys default to 0, and a key of 0 after a primed call still counts as a change.
  const one = createTextMemo((a) => String(a));
  assert.equal(one(0), '0');
  assert.equal(one(5), '5');
  assert.equal(one(0), '0');
  // Total: a throwing builder yields an empty string instead of an exception mid-render.
  const bad = createTextMemo(() => {
    throw new Error('boom');
  });
  assert.equal(bad(1), '');
});

test('a roll lands in one fixed beat whatever the gap, and small changes do not crawl', () => {
  /**
   * @param {number} to
   * @returns {number} seconds to arrive at 60 Hz
   */
  const secondsTo = (to) => {
    const c = createCounter(0);
    c.set(to);
    let t = 0;
    let prev = 0;
    while (!c.done && t < 10) {
      c.update(1 / 60);
      t += 1 / 60;
      assert.ok(c.value >= prev, 'monotone: an upward roll never steps back');
      prev = c.value;
    }
    return t;
  };
  // The exponential roll this replaced took ~2.8 s for a level total and ~1 s for a gem.
  const big = secondsTo(8531);
  const gem = secondsTo(300);
  assert.ok(big <= ROLL.DURATION + 1 / 30, `a level total lands in one beat (${big.toFixed(2)} s)`);
  assert.ok(Math.abs(big - gem) < 1 / 20, `and so does a gem (${gem.toFixed(2)} s vs ${big.toFixed(2)} s)`);
  // A +10 is a quick tick, not a 0.55 s fade.
  assert.ok(secondsTo(10) <= 10 / ROLL.MIN_RATE + 1 / 30);
  // Most of the distance is covered early: ease-out, not linear.
  const c = createCounter(0);
  c.set(1000);
  for (let i = 0; i < Math.round((ROLL.DURATION * 60) / 3); i++) c.update(1 / 60);
  assert.ok(c.value > 550, `a third of the way in, well over half the distance (${c.value})`);
});
