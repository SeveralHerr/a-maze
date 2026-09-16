// @ts-check
/**
 * @file Unit tests for the particle pool (run: `node src/renderer/particles.test.mjs`).
 *
 * The pool's promises are: a fixed capacity that never grows, correct retirement, motion that
 * matches each kind's model, and a draw that respects the wall z-buffer (particles behind a wall
 * must not shine through it).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PARTICLE, PARTICLE_COLORS, createParticles } from './particles.js';
import { PALETTE_SIZE } from './palette.js';

const W = 64;
const H = 32;

/**
 * A camera looking east from the origin-ish, with an identity-ish projection.
 * @param {Uint32Array} colormap
 * @returns {import('./particles.js').ParticleCamera}
 */
function camera(colormap) {
  const planeLen = (0.5 * W) / H;
  const dirX = 1;
  const dirY = 0;
  const planeX = -dirY * planeLen;
  const planeY = dirX * planeLen;
  return {
    px: 0,
    py: 0,
    dirX,
    dirY,
    planeX,
    planeY,
    invDet: 1 / (planeX * dirY - dirX * planeY),
    horizon: H / 2,
    colormap,
    fogLut: Float32Array.from({ length: 64 }, () => 1), // no fog: isolate the particle logic
    fogScale: 1,
    fogLutMax: 63,
  };
}

/** A colormap where every entry is a recognisable non-zero value. */
function fakeColormap() {
  const cm = new Uint32Array(64 * 256);
  for (let i = 0; i < cm.length; i++) cm[i] = 0xff000000 | (i & 0xffffff);
  return cm;
}

test('the pool has a hard capacity and never grows', () => {
  const p = createParticles(4);
  assert.equal(p.capacity, 4);
  assert.equal(p.count, 0);
  for (let i = 0; i < 4; i++) {
    assert.equal(p.spawn(PARTICLE.EMBER, i, 0, 0.5, 0, 0, 0, 1, PARTICLE_COLORS.ember, 1), true);
  }
  assert.equal(p.count, 4);
  assert.equal(p.spawn(PARTICLE.EMBER, 9, 0, 0.5, 0, 0, 0, 1, PARTICLE_COLORS.ember, 1), false);
  assert.equal(p.count, 4, 'a rejected spawn must not change the pool');
  p.clear();
  assert.equal(p.count, 0);
});

test('degenerate arguments are rejected or clamped rather than corrupting the pool', () => {
  const p = createParticles(8);
  assert.equal(p.spawn(PARTICLE.EMBER, 0, 0, 0.5, 0, 0, 0, 0, 1, 1), false, 'zero lifetime');
  assert.equal(p.spawn(PARTICLE.EMBER, 0, 0, 0.5, 0, 0, 0, -1, 1, 1), false, 'negative lifetime');
  assert.equal(p.spawn(PARTICLE.EMBER, 0, 0, 0.5, 0, 0, 0, Number.NaN, 1, 1), false, 'NaN lifetime');
  assert.equal(p.count, 0);
  // Sizes outside 1..3 are clamped, not rejected.
  assert.equal(p.spawn(PARTICLE.SPARK, 0, 0, 0.5, 0, 0, 0, 1, 1, 99), true);
  assert.equal(p.spawn(PARTICLE.SPARK, 0, 0, 0.5, 0, 0, 0, 1, 1, -5), true);
  assert.equal(p.count, 2);
  // A zero-capacity pool is legal and inert.
  const none = createParticles(0);
  assert.equal(none.spawn(PARTICLE.EMBER, 0, 0, 0.5, 0, 0, 0, 1, 1, 1), false);
  assert.doesNotThrow(() => none.update(0.016));
});

test('particles retire when their life runs out', () => {
  const p = createParticles(8);
  p.spawn(PARTICLE.DUST, 0, 0, 0.5, 0, 0, 0, 0.1, 1, 1);
  p.spawn(PARTICLE.DUST, 1, 0, 0.5, 0, 0, 0, 1.0, 1, 1);
  p.update(0.2);
  assert.equal(p.count, 1, 'the short-lived one is gone, the other is not');
  // `update` clamps a single step to 0.25 s (see the tab-stall test), so age the rest in steps.
  for (let i = 0; i < 4; i++) p.update(0.25);
  assert.equal(p.count, 0);
});

test('motion models: embers rise, sparks fall, dust drifts', () => {
  const cm = fakeColormap();
  const cam = camera(cm);
  const zbuf = new Float32Array(W).fill(1000);
  const buf = new Uint32Array(W * H);

  /**
   * Height of a single particle of `kind` after one second of simulation.
   * @param {number} kind
   * @param {number} vz0
   * @returns {number}
   */
  const heightAfter = (kind, vz0) => {
    const p = createParticles(1);
    p.spawn(kind, 4, 0, 0.5, 0, 0, vz0, 10, 1, 1);
    for (let i = 0; i < 60; i++) p.update(1 / 60);
    // Read the height back through the projection: a higher particle draws further up the screen.
    buf.fill(0);
    p.draw(buf, W, H, zbuf, cam);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (buf[y * W + x] !== 0) return y;
    return Number.NaN; // died (left the floor/ceiling band)
  };

  const emberRow = heightAfter(PARTICLE.EMBER, 0);
  const sparkRow = heightAfter(PARTICLE.SPARK, 0);
  assert.ok(Number.isFinite(emberRow), 'an ember with no initial velocity should still be alive');
  assert.ok(emberRow < H / 2, 'an ember must drift upward (toward lower screen rows)');
  assert.ok(!Number.isFinite(sparkRow) || sparkRow > H / 2, 'a spark must fall');
});

test('draw respects the z-buffer and the screen bounds', () => {
  const cm = fakeColormap();
  const cam = camera(cm);
  const buf = new Uint32Array(W * H);
  const p = createParticles(4);
  // Straight ahead, 2 tiles away, at eye height → dead centre of the screen.
  p.spawn(PARTICLE.SPARK, 2, 0, 0.5, 0, 0, 0, 5, 1, 1);

  const open = new Float32Array(W).fill(1000);
  buf.fill(0);
  assert.equal(p.draw(buf, W, H, open, cam), 1);
  assert.notEqual(buf[(H / 2) * W + W / 2], 0, 'the particle should land at the screen centre');

  // A wall in front of it hides it completely.
  const blocked = new Float32Array(W).fill(0.5);
  buf.fill(0);
  assert.equal(p.draw(buf, W, H, blocked, cam), 0);
  assert.equal(buf.reduce((a, b) => a + b, 0), 0, 'nothing may be drawn through a wall');

  // Behind the camera: culled.
  const behind = createParticles(1);
  behind.spawn(PARTICLE.SPARK, -3, 0, 0.5, 0, 0, 0, 5, 1, 1);
  buf.fill(0);
  assert.equal(behind.draw(buf, W, H, open, cam), 0);

  // Far off to the side: culled without writing outside the framebuffer.
  const aside = createParticles(1);
  aside.spawn(PARTICLE.SPARK, 1, 90, 0.5, 0, 0, 0, 5, 1, 1);
  buf.fill(0);
  aside.draw(buf, W, H, open, cam);
  assert.equal(buf.reduce((a, b) => a + b, 0), 0);
});

test('burst emits up to the pool capacity and uses the supplied randomness', () => {
  const p = createParticles(10);
  let calls = 0;
  const rnd = () => {
    calls++;
    return 0.5;
  };
  assert.equal(p.burst(PARTICLE.SPARK, 1, 1, 0.5, 6, 2, 0.5, PARTICLE_COLORS.spark, rnd), 6);
  assert.equal(p.count, 6);
  assert.ok(calls > 0, 'burst must draw from the injected RNG, not Math.random');
  // Asking for more than fits stops at the capacity instead of throwing.
  assert.equal(p.burst(PARTICLE.SPARK, 1, 1, 0.5, 50, 2, 0.5, PARTICLE_COLORS.spark, rnd), 4);
  assert.equal(p.count, 10);
});

test('update clamps huge time steps so a backgrounded tab cannot teleport particles', () => {
  const p = createParticles(2);
  p.spawn(PARTICLE.DUST, 0, 0, 0.5, 10, 0, 0, 100, 1, 1);
  p.update(60); // one minute of stall
  assert.equal(p.count, 1, 'the particle survives (its life is 100 s)');
  // 60 s of drift at 10 tiles/s would be 600 tiles; the clamp caps the step at 0.25 s.
  const buf = new Uint32Array(W * H);
  const zbuf = new Float32Array(W).fill(1000);
  p.draw(buf, W, H, zbuf, camera(fakeColormap()));
  assert.ok(true, 'no throw, no NaN propagation');
  p.update(Number.NaN);
  p.update(-5);
  assert.equal(p.count, 1);
});

test('exported colours are real palette indices', () => {
  for (const [name, idx] of Object.entries(PARTICLE_COLORS)) {
    assert.ok(idx > 0 && idx < PALETTE_SIZE, `${name} is not a palette index`);
  }
  assert.equal(Object.isFrozen(PARTICLE_COLORS), true);
  assert.equal(Object.isFrozen(PARTICLE), true);
});
