// @ts-check
/**
 * @file Scalar math helpers used by the sim, renderer and UI hot paths.
 *
 * Every function takes and returns plain numbers (never objects) so calls inline cleanly in V8
 * and allocate nothing. Angles are radians. Functions are total: they never throw, and their
 * behaviour for degenerate input (NaN, reversed bounds, zero-width ranges) is documented and
 * covered by `math.test.mjs`.
 */

/** Full turn in radians (2π). */
export const TAU = Math.PI * 2;

/** Quarter turn in radians (π/2). */
export const HALF_PI = Math.PI / 2;

/**
 * Clamp `v` into [lo, hi].
 *
 * NaN is mapped to `lo` (rather than propagated) because clamp is the usual last line of defence
 * when sanitising values that feed typed-array indices or persisted settings. Assumes lo ≤ hi; if
 * the bounds are reversed the result is `hi` for any v ≥ hi and `lo` otherwise.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(v, lo, hi) {
  // `!(v >= lo)` is true for NaN as well as v < lo.
  return !(v >= lo) ? lo : v > hi ? hi : v;
}

/**
 * Clamp into [0, 1] (NaN → 0).
 * @param {number} v
 * @returns {number}
 */
export function clamp01(v) {
  return !(v >= 0) ? 0 : v > 1 ? 1 : v;
}

/**
 * Linear interpolation; `t` is not clamped (t outside [0,1] extrapolates).
 * Uses the `a*(1-t) + b*t` form so that t = 1 returns exactly `b` (the `a + (b-a)*t` form can be
 * off by one ulp at t = 1, so an interpolated position would never quite reach the step result).
 * @param {number} a value at t = 0
 * @param {number} b value at t = 1
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
  // Equal endpoints short-circuit so a stationary value is returned bit-exact for every t.
  return a === b ? a : a * (1 - t) + b * t;
}

/**
 * Inverse of `lerp`: where `v` sits between `a` and `b` (unclamped). Returns 0 when a === b so a
 * zero-width range never produces NaN/Infinity.
 * @param {number} a
 * @param {number} b
 * @param {number} v
 * @returns {number}
 */
export function invLerp(a, b, v) {
  const d = b - a;
  return d === 0 ? 0 : (v - a) / d;
}

/**
 * Wrap an angle into the half-open interval [-π, π).
 *
 * Exactly π maps to -π (the interval is closed at the bottom), so the representation of a given
 * direction is unique. Non-finite input yields NaN — an infinite angle has no direction and a
 * NaN is easy to detect upstream, whereas silently returning 0 would hide the bug.
 * @param {number} a radians, any magnitude
 * @returns {number} radians in [-π, π)
 */
export function wrapAngle(a) {
  const r = a - TAU * Math.floor((a + Math.PI) / TAU);
  // Rounding in the subtraction above can land exactly on +π for inputs a hair below -π (or at
  // huge magnitudes); fold that back so the documented half-open range always holds.
  return r >= Math.PI ? r - TAU : r < -Math.PI ? r + TAU : r;
}

/**
 * Shortest signed angular difference `b - a`, in [-π, π). Positive means b is clockwise from a in
 * screen space (since +y points south).
 * @param {number} a radians
 * @param {number} b radians
 * @returns {number} radians in [-π, π)
 */
export function angleDiff(a, b) {
  return wrapAngle(b - a);
}

/**
 * Interpolate between two angles along the shortest arc, result wrapped into [-π, π).
 *
 * When the two angles are exactly opposite (difference of π) the arc is ambiguous; the tie is
 * broken deterministically toward the negative direction because `wrapAngle(π) === -π`.
 * `t` is not clamped.
 * @param {number} a radians at t = 0
 * @param {number} b radians at t = 1
 * @param {number} t
 * @returns {number} radians in [-π, π)
 */
export function lerpAngle(a, b, t) {
  return wrapAngle(a + wrapAngle(b - a) * t);
}

/**
 * Hermite smoothstep: 0 at/below `edge0`, 1 at/above `edge1`, smooth 3t²−2t³ in between.
 * A zero-width range degrades to a hard step at the edge (x < edge → 0, else 1) instead of NaN.
 * Reversed edges (edge0 > edge1) produce the mirrored curve, as in GLSL implementations.
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number} 0..1
 */
export function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Move `v` toward `target` by at most `|delta|`, never overshooting. Ideal for rate-limited values
 * (fuel gauge needle, fade alphas). Sign of `delta` is ignored.
 * @param {number} v current value
 * @param {number} target
 * @param {number} delta maximum change (units of v)
 * @returns {number}
 */
export function approach(v, target, delta) {
  const d = delta < 0 ? -delta : delta;
  if (v < target) return v + d >= target ? target : v + d;
  if (v > target) return v - d <= target ? target : v - d;
  return target;
}

/**
 * Frame-rate independent exponential smoothing: moves `v` toward `target`, closing the fraction
 * `1 - e^(-rate·dt)` of the gap. `rate` is in 1/seconds (higher = snappier), `dt` in seconds.
 * @param {number} v
 * @param {number} target
 * @param {number} rate 1/s, ≥ 0
 * @param {number} dt seconds, ≥ 0
 * @returns {number}
 */
export function damp(v, target, rate, dt) {
  return lerp(v, target, 1 - Math.exp(-rate * dt));
}

/**
 * Squared Euclidean distance between (ax,ay) and (bx,by). Prefer this over `dist` for radius
 * comparisons (compare against r*r) — it avoids the square root.
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {number}
 */
export function dist2(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/**
 * Euclidean distance between (ax,ay) and (bx,by).
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {number}
 */
export function dist(ax, ay, bx, by) {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

/**
 * Euclidean modulo: result always in [0, m) for m > 0 (unlike `%`, which keeps the dividend's
 * sign). Used for wrapping texture coordinates and animation frame indices. Returns 0 for NaN
 * input, and never returns -0, so the result is always a valid array index for integer arguments.
 * @param {number} v
 * @param {number} m modulus, > 0
 * @returns {number} in [0, m)
 */
export function mod(v, m) {
  const r = v % m;
  if (r > 0) return r;
  if (r === 0) return 0; // normalises -0 (produced by e.g. mod(-4, 4)) to +0
  const w = r + m;
  // A tiny negative remainder can round up to exactly m, which would escape [0, m).
  return w < m ? w : 0;
}
