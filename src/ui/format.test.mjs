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
  formatClock,
  formatCount,
  formatDepth,
  formatDistance,
  formatInt,
  formatPercent,
  formatScore,
  formatSigned,
  formatTime,
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
