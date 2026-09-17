// @ts-check
/**
 * @file Auto Explore (ARCHITECTURE.md §4.10): the autopilot drives real levels through the real
 * reducer, plays the fog honestly, and costs nothing per step.
 *
 * Cross-module note: like `feasibility.test.mjs`, this builds real mazes with `src/maze` (test-only).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';

import { buildLevel } from '../maze/level.js';
import { ATTRACT, AUTO, FUEL, PLAYER, levelParams } from './balance.js';
import { AUTO_DRAIN_SCALE } from './sim.js';
import { createInitialState, reducer } from './game.js';
import { createAutopilot } from './autopilot.js';

/**
 * A `gc()` handle without `--expose-gc` (the same trick as `perf.test.mjs`); null if disallowed.
 * @returns {(() => void)|null}
 */
function getGc() {
  try {
    v8.setFlagsFromString('--expose-gc');
    const fn = vm.runInNewContext('gc');
    v8.setFlagsFromString('--no-expose-gc');
    return typeof fn === 'function' ? fn : null;
  } catch {
    return null;
  }
}

/**
 * A state playing `level` of a run seeded `seed`.
 * @param {number} level
 * @param {number} seed
 */
function playing(level, seed) {
  const s = createInitialState();
  reducer(s, { type: 'newGame', seed });
  s.level = level;
  reducer(s, { type: 'levelReady', data: buildLevel(levelParams(level), seed * 7919 + level) });
  assert.equal(s.phase, 'playing');
  return s;
}

/** A frame the autopilot writes into, shaped like `InputFrame`. */
function frame() {
  return { moveX: 0, moveY: 0, turn: 0, lookDX: 0, pressed: new Set() };
}

/**
 * Drive until the phase leaves `playing` or `maxSeconds` of sim time pass.
 * @param {any} s
 * @param {ReturnType<typeof createAutopilot>} ap
 * @param {number} maxSeconds
 * @param {(s:any) => void} [each]
 */
function drive(s, ap, maxSeconds, each) {
  const f = frame();
  // `auto: true`, exactly as main.js marks a step the pilot drove (the torch burns at its pace).
  const tick = { type: 'tick', dt: 1 / 60, input: f, auto: true };
  let steps = 0;
  while (s.phase === 'playing' && steps < maxSeconds * 60) {
    ap.step(s, f);
    reducer(s, tick);
    if (each) each(s);
    steps++;
  }
  return steps;
}

test('clears the first floor on its own, for several seeds', () => {
  for (const seed of [1, 2, 3, 4]) {
    const s = playing(1, seed);
    const ap = createAutopilot();
    let gems = 0;
    drive(s, ap, 600, (st) => {
      for (const e of st.events) if (e.type === 'pickup' && e.kind === 'gem') gems++;
    });
    assert.equal(s.phase, 'levelComplete', `seed ${seed}: the autopilot should clear level 1 (${JSON.stringify(ap.info())})`);
    assert.ok(gems > 0, `seed ${seed}: it should pick up at least one gem it walked near`);
  }
});

test('explores rather than dithering: a deep floor keeps uncovering new ground', () => {
  const s = playing(10, 5);
  const ap = createAutopilot();
  drive(s, ap, 120);
  let seen = 0;
  for (let i = 0; i < s.explored.length; i++) seen += s.explored[i];
  // Two minutes at the calm ~1.2 tiles/s average (the title camera's pace, slowing into corners)
  // reveals a few hundred tiles; a pilot thrashing between two frontiers reveals a few dozen.
  assert.ok(seen > 250, `explored only ${seen} tiles in two minutes`);
  assert.ok(s.run.distance > 100, `walked only ${s.run.distance.toFixed(0)} tiles`);
});

test('never heads for an item on a tile it has not revealed', () => {
  const s = playing(3, 9);
  const ap = createAutopilot();
  const f = frame();
  // `auto: true`, exactly as main.js marks a step the pilot drove (the torch burns at its pace).
  const tick = { type: 'tick', dt: 1 / 60, input: f, auto: true };
  const w = s.levelData.maze.width;
  let targeted = 0;
  for (let i = 0; i < 60 * 90 && s.phase === 'playing'; i++) {
    ap.step(s, f);
    const info = ap.info();
    if (info.goal === 'item' || info.goal === 'oil') {
      assert.notEqual(s.explored[info.tile], 0, `goal ${info.goal} at tile ${info.tile} is still in the fog`);
      targeted++;
    }
    reducer(s, tick);
  }
  assert.ok(targeted > 0, 'the run should have targeted at least one item, or this proves nothing');
  // Direct check on the planner: with nothing explored but the start, the only goals are frontiers.
  const fresh = playing(3, 9);
  fresh.explored.fill(0);
  const sx = Math.floor(fresh.player.x);
  const sy = Math.floor(fresh.player.y);
  fresh.explored[sy * w + sx] = 1;
  const ap2 = createAutopilot();
  ap2.step(fresh, frame());
  assert.equal(ap2.info().goal, 'frontier');
});

test('is deterministic for a given run seed and level', () => {
  const a = playing(2, 21);
  const b = playing(2, 21);
  drive(a, createAutopilot(), 60);
  drive(b, createAutopilot(), 60);
  assert.equal(a.player.x, b.player.x);
  assert.equal(a.player.y, b.player.y);
  assert.equal(a.run.score, b.run.score);
});

test('drives nothing outside play, and stops for an interrupt', () => {
  const s = playing(1, 3);
  const ap = createAutopilot();
  const f = frame();
  s.phase = 'paused';
  assert.equal(ap.step(s, f), false);
  assert.equal(f.moveY, 0);
  s.phase = 'playing';
  assert.equal(ap.step(s, f), true);
  ap.interrupt();
  assert.equal(ap.info().route, 0);
});

test('stepping the pilot on a max-size level leaves nothing behind (massive-maze rule)', () => {
  const gc = getGc();
  const s = playing(15, 2);
  const ap = createAutopilot();
  const f = frame();
  // `auto: true`, exactly as main.js marks a step the pilot drove (the torch burns at its pace).
  const tick = { type: 'tick', dt: 1 / 60, input: f, auto: true };
  // Warm up: adopt the level, plan many times, let the JIT settle.
  for (let i = 0; i < 6000 && s.phase === 'playing'; i++) {
    ap.step(s, f);
    reducer(s, tick);
  }
  if (gc !== null) gc();
  const before = process.memoryUsage().heapUsed;
  // The pilot alone, standing still: the stuck rule replans every AUTO.STUCK_STEPS steps, so this is
  // hundreds of searches of a 257×257 level as well as 30 000 steering steps.
  const plans = ap.info().plans;
  for (let i = 0; i < 30000; i++) ap.step(s, f);
  if (gc !== null) gc();
  const grown = process.memoryUsage().heapUsed - before;
  assert.ok(ap.info().plans - plans > 30000 / (AUTO.STUCK_STEPS + 2) / 2, 'the loop should have replanned repeatedly');
  assert.ok(grown < 256 * 1024, `autopilot steps grew the heap by ${(grown / 1024).toFixed(1)} KiB`);
});

test('it moves like the title camera: title-screen pace, no snapping turns, few reversals', () => {
  const s = playing(3, 1);
  const ap = createAutopilot();
  const f = frame();
  const tick = { type: 'tick', dt: 1 / 60, input: f, auto: true };
  let lastAngle = s.player.angle;
  let lastRate = 0;
  let peakAcc = 0;
  let flips = 0;
  let lastSign = 0;
  let speedSum = 0;
  let peakSpeed = 0;
  const steps = 60 * 90;
  for (let i = 0; i < steps && s.phase === 'playing'; i++) {
    ap.step(s, f, 1 / 60);
    reducer(s, tick);
    let da = s.player.angle - lastAngle;
    da = (((da + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    lastAngle = s.player.angle;
    const rate = da * 60;
    if (i > 5) peakAcc = Math.max(peakAcc, Math.abs(rate - lastRate) * 60);
    lastRate = rate;
    const sign = Math.abs(rate) > 0.5 ? Math.sign(rate) : 0;
    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) flips++;
    if (sign !== 0) lastSign = sign;
    const speed = Math.hypot(s.player.vx, s.player.vy);
    speedSum += speed;
    peakSpeed = Math.max(peakSpeed, speed);
  }
  // Measured: the old player-speed pilot peaked at 124 rad/s² with ~65 turn reversals a minute; the
  // title camera's own documented peak is ~11 rad/s².
  assert.ok(peakAcc < 30, `peak angular acceleration ${peakAcc.toFixed(0)} rad/s²`);
  assert.ok(flips / 1.5 < 25, `${(flips / 1.5).toFixed(0)} turn reversals a minute`);
  assert.ok(peakSpeed <= ATTRACT.SPEED + 0.05, `peak speed ${peakSpeed.toFixed(2)} tiles/s`);
  assert.ok(speedSum / steps > 0.6, 'but it does keep walking');
});

test('turns before a corner rather than walking at the wall beyond it', () => {
  // For every L-turn walked, how far the body got past the corner tile's centre along the direction
  // it came in. Measured before pursuit steering (aim past the waypoint, turn on arrival): median
  // +0.15, p90 +0.19 — it carried on toward the far wall and pivoted there. Pursuit: ≈ −0.07 / −0.03.
  const past = [];
  for (const [level, seed] of [[1, 1], [5, 2], [20, 3], [5, 4], [20, 5], [10, 6]]) {
    const s = playing(level, seed);
    const ap = createAutopilot();
    const w = s.levelData.maze.width;
    let cur = -1;
    let inX = 0;
    let inY = 0;
    let far = -1;
    drive(s, ap, 90, (st) => {
      const tx = Math.floor(st.player.x);
      const ty = Math.floor(st.player.y);
      if (ty * w + tx !== cur) {
        if (cur >= 0) {
          const outX = tx - (cur % w);
          const outY = ty - ((cur / w) | 0);
          if ((inX !== 0 || inY !== 0) && outX * inX + outY * inY === 0) past.push(far);
          inX = outX;
          inY = outY;
        }
        cur = ty * w + tx;
        far = -1;
      }
      far = Math.max(far, (st.player.x - tx - 0.5) * inX + (st.player.y - ty - 0.5) * inY);
    });
  }
  past.sort((a, b) => a - b);
  assert.ok(past.length > 100, `only ${past.length} corners walked`);
  const median = past[past.length >> 1];
  const p90 = past[Math.floor(past.length * 0.9)];
  assert.ok(median < 0, `median ${median.toFixed(3)} tiles past the corner centre`);
  assert.ok(p90 < 0.05, `p90 ${p90.toFixed(3)} tiles past the corner centre`);
});

test('the torch burns at the pilot’s pace only on steps the pilot drove', () => {
  assert.ok(Math.abs(AUTO_DRAIN_SCALE - ATTRACT.SPEED / PLAYER.WALK_SPEED) < 1e-12);
  const burn = (/** @type {boolean} */ auto) => {
    const s = playing(1, 3);
    const before = s.run.fuel;
    const tick = { type: 'tick', dt: 1 / 60, input: frame(), auto };
    for (let i = 0; i < 60; i++) reducer(s, tick);
    return before - s.run.fuel;
  };
  const normal = burn(false);
  const auto = burn(true);
  assert.ok(Math.abs(normal - FUEL.DRAIN) < 1e-6, `a second of play burns ${normal}`);
  assert.ok(Math.abs(auto - normal * AUTO_DRAIN_SCALE) < 1e-6, `a second of Auto Explore burns ${auto}`);
});
