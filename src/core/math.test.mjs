// @ts-check
/**
 * Unit tests for src/core/math.js — run with `node src/core/math.test.mjs`.
 * Focus: the documented edge cases (NaN, reversed/zero-width ranges, angle wrap boundaries),
 * because those are what silently corrupt a sim when they regress.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAU,
  HALF_PI,
  clamp,
  clamp01,
  lerp,
  invLerp,
  wrapAngle,
  angleDiff,
  lerpAngle,
  smoothstep,
  approach,
  damp,
  dist,
  dist2,
  mod,
} from './math.js';

/** Assert two floats are equal within `eps`. @param {number} a @param {number} b @param {number} [eps] @param {string} [msg] */
function near(a, b, eps = 1e-12, msg = '') {
  assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} ≈ ${b} (±${eps})`);
}

test('constants', () => {
  assert.equal(TAU, Math.PI * 2);
  assert.equal(HALF_PI, Math.PI / 2);
});

test('clamp keeps values inside bounds and maps NaN to lo', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(0, 0, 0), 0);
  assert.equal(clamp(NaN, 3, 10), 3);
  assert.equal(clamp(-Infinity, 0, 1), 0);
  assert.equal(clamp(Infinity, 0, 1), 1);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(-0.2), 0);
  assert.equal(clamp01(1.2), 1);
  assert.equal(clamp01(NaN), 0);
});

test('lerp is exact at both endpoints and extrapolates', () => {
  assert.equal(lerp(2, 8, 0), 2);
  assert.equal(lerp(2, 8, 1), 8);
  assert.equal(lerp(2, 8, 0.5), 5);
  assert.equal(lerp(2, 8, 2), 14);
  assert.equal(lerp(2, 8, -1), -4);
  // Equal endpoints are bit-exact for any t (no sub-ulp drift while standing still).
  assert.equal(lerp(0.1, 0.1, 0.37), 0.1);
  // Exactness at t = 1 is the reason for the (1-t)/t form.
  assert.equal(lerp(0.1, 0.7, 1), 0.7);
});

test('invLerp inverts lerp and survives a zero-width range', () => {
  near(invLerp(2, 8, 5), 0.5);
  assert.equal(invLerp(3, 3, 7), 0);
  for (const t of [0, 0.25, 1, 1.5]) near(invLerp(-4, 6, lerp(-4, 6, t)), t, 1e-12);
});

test('wrapAngle maps into [-π, π) with π folding to -π', () => {
  assert.equal(wrapAngle(0), 0);
  near(wrapAngle(0.4), 0.4);
  assert.equal(wrapAngle(Math.PI), -Math.PI);
  assert.equal(wrapAngle(-Math.PI), -Math.PI);
  near(wrapAngle(Math.PI + 0.1), -Math.PI + 0.1, 1e-12);
  near(wrapAngle(-Math.PI - 0.1), Math.PI - 0.1, 1e-12);
  near(wrapAngle(TAU), 0, 1e-12);
  near(wrapAngle(-TAU), 0, 1e-12);
  assert.ok(Number.isNaN(wrapAngle(NaN)));
  assert.ok(Number.isNaN(wrapAngle(Infinity)));
});

test('wrapAngle stays in range for pathological inputs', () => {
  const samples = [
    Math.PI,
    -Math.PI,
    3.1415926535897936, // one ulp above π
    -3.1415926535897936,
    1e7 * Math.PI,
    -1e7 * Math.PI,
    1e12,
    -1e12,
  ];
  for (const a of samples) {
    const r = wrapAngle(a);
    assert.ok(r >= -Math.PI && r < Math.PI, `wrapAngle(${a}) = ${r} escaped [-π, π)`);
    // The wrapped angle must point the same direction as the input. Skipped past 1e8 rad, where
    // the input's own ulp is larger than the tolerance (a float limit, not a wrapping error).
    if (Math.abs(a) <= 1e8) {
      near(Math.cos(r), Math.cos(a), 1e-6, `cos mismatch for ${a}`);
      near(Math.sin(r), Math.sin(a), 1e-6, `sin mismatch for ${a}`);
    }
  }
  // Random fuzz across many turns.
  let seed = 12345;
  for (let i = 0; i < 20000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const a = ((seed >>> 0) / 4294967296 - 0.5) * 400;
    const r = wrapAngle(a);
    assert.ok(r >= -Math.PI && r < Math.PI, `wrapAngle(${a}) = ${r} escaped [-π, π)`);
  }
});

test('angleDiff returns the shortest signed difference', () => {
  near(angleDiff(0, 0.5), 0.5);
  near(angleDiff(0.5, 0), -0.5);
  near(angleDiff(-3, 3), -0.28318530717958623, 1e-12); // the short way, across ±π
  assert.equal(angleDiff(0, Math.PI), -Math.PI); // documented tie-break
});

test('lerpAngle takes the short arc and stays wrapped', () => {
  near(lerpAngle(0, 1, 0), 0);
  near(lerpAngle(0, 1, 1), 1);
  near(lerpAngle(0, 1, 0.5), 0.5);
  // Across the ±π seam: from 3.0 rad to -3.0 rad the short arc is +0.28, not -6.0.
  // Midpoint of 3 and -3 sits exactly on the seam (±π), and wrapping pins it to -π.
  const mid = lerpAngle(3, -3, 0.5);
  near(Math.abs(mid), Math.PI, 1e-9);
  assert.equal(mid, -Math.PI);
  // A quarter of the way across the seam is past +π and wraps to the negative side.
  near(lerpAngle(3, -3, 0.25), 3 + 0.28318530717958623 * 0.25, 1e-9);
  // Opposite angles: deterministic tie-break toward the negative direction.
  near(lerpAngle(0, Math.PI, 0.5), -Math.PI / 2);
  // Result is always in range, for any t and any input magnitude.
  for (let t = -2; t <= 2; t += 0.13) {
    const r = lerpAngle(17.3, -42.1, t);
    assert.ok(r >= -Math.PI && r < Math.PI, `lerpAngle escaped range at t=${t}: ${r}`);
  }
});

test('smoothstep is clamped, symmetric and handles degenerate edges', () => {
  assert.equal(smoothstep(0, 1, -1), 0);
  assert.equal(smoothstep(0, 1, 2), 1);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  near(smoothstep(0, 1, 0.25) + smoothstep(0, 1, 0.75), 1, 1e-12);
  assert.equal(smoothstep(5, 5, 4.9), 0);
  assert.equal(smoothstep(5, 5, 5), 1);
  // Reversed edges mirror the curve (GLSL behaviour).
  near(smoothstep(1, 0, 0.25), smoothstep(0, 1, 0.75), 1e-12);
  assert.equal(smoothstep(0, 1, NaN), 0);
});

test('approach never overshoots and ignores the sign of delta', () => {
  assert.equal(approach(0, 10, 3), 3);
  assert.equal(approach(9, 10, 3), 10);
  assert.equal(approach(10, 0, 3), 7);
  assert.equal(approach(1, 0, 3), 0);
  assert.equal(approach(1, 0, -3), 0);
  assert.equal(approach(5, 5, 1), 5);
  assert.equal(approach(5, 10, 0), 5);
  // Repeated application converges exactly, with no oscillation.
  let v = 0;
  for (let i = 0; i < 100; i++) v = approach(v, 1, 0.07);
  assert.equal(v, 1);
});

test('damp closes the documented fraction of the gap and is dt-composable', () => {
  near(damp(0, 1, 1, 1), 1 - Math.exp(-1), 1e-12);
  assert.equal(damp(4, 9, 3, 0), 4); // no time, no movement
  // Two half steps equal one whole step (this is why damp is used instead of lerp(v,t,0.1)).
  const once = damp(0, 1, 5, 0.2);
  const twice = damp(damp(0, 1, 5, 0.1), 1, 5, 0.1);
  near(once, twice, 1e-12);
});

test('dist/dist2 agree and dist2 avoids the square root', () => {
  assert.equal(dist2(0, 0, 3, 4), 25);
  assert.equal(dist(0, 0, 3, 4), 5);
  assert.equal(dist2(1.5, -2, 1.5, -2), 0);
  near(dist(-1, -1, 2, 3), 5, 1e-12);
});

test('mod is euclidean and never returns the modulus itself', () => {
  assert.equal(mod(7, 4), 3);
  assert.equal(mod(-1, 4), 3);
  assert.equal(mod(-4, 4), 0);
  assert.equal(mod(0, 4), 0);
  near(mod(-0.25, 1), 0.75, 1e-12);
  // A remainder that rounds up to the modulus must fold back to 0, not escape the range.
  const tiny = -Number.MIN_VALUE;
  const r = mod(tiny, 1);
  assert.ok(r >= 0 && r < 1, `mod escaped [0,1): ${r}`);
});
