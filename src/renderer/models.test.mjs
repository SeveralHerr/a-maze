// @ts-check
/**
 * @file Unit tests for the load-time mesh rasteriser (run: `node src/renderer/models.test.mjs`).
 * It turns meshes into palette sprites, so these check coverage, depth order, the outline and the
 * projection helper the flame is anchored with.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { box, createMesh, lathe, projectPoint, renderMesh } from './models.js';

const A = Uint8Array.of(5, 10, 11, 12);
const B = Uint8Array.of(6, 20, 21, 22);
/** @type {(ramp: Uint8Array, t: number) => number} */
const pick = (ramp, t) => ramp[Math.max(1, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))))];
const LIGHT = /** @type {const} */ ([0, 0, 1]);

test('a head-on box covers its footprint exactly and gets an outline', () => {
  const m = createMesh();
  box(m, -4, -4, -4, 4, 4, 4, 0);
  const out = new Uint8Array(64 * 64);
  renderMesh(m, [{ ramp: A, albedo: 1, ambient: 1 }], { yaw: 0, pitch: 0, originRow: 32, light: LIGHT }, pick, out);
  let filled = 0;
  for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) filled += out[y * 64 + x] > 10 ? 1 : 0;
  assert.equal(filled, 64, 'the 8×8 face is fully covered');
  assert.equal(out[32 * 64 + 27], A[0], 'outline uses the ramp\'s darkest step');
  assert.equal(out[32 * 64 + 25], 0, 'nothing beyond the outline');
});

test('the nearer surface wins the z-test whatever the draw order', () => {
  const m = createMesh();
  box(m, -3, -3, 5, 3, 3, 6, 1); // near
  box(m, -6, -6, -6, 6, 6, -5, 0); // far, drawn second
  const out = new Uint8Array(64 * 64);
  const mats = [{ ramp: A, albedo: 1, ambient: 1 }, { ramp: B, albedo: 1, ambient: 1 }];
  renderMesh(m, mats, { yaw: 0, pitch: 0, originRow: 32, light: LIGHT }, pick, out);
  assert.ok(B.includes(out[32 * 64 + 32]), 'centre shows the near box');
  assert.ok(A.includes(out[27 * 64 + 27]), 'the far box shows around it');
});

test('yaw turns the model: a lathe offset along +z moves sideways, and projectPoint agrees', () => {
  const m = createMesh();
  lathe(m, [[2, -2], [2, 2]], 0, { cz: 12, segs: 12, capTop: true });
  for (const yaw of [-1, 1]) {
    const out = new Uint8Array(64 * 64);
    renderMesh(m, [{ ramp: A, albedo: 1, ambient: 1 }], { yaw, pitch: 0, originRow: 32, light: LIGHT, outline: false }, pick, out);
    const { sx } = projectPoint(0, 0, 12, yaw, 0, 32);
    assert.ok(out[32 * 64 + Math.floor(sx)] !== 0, `the lathe is where projectPoint says at yaw ${yaw}`);
    assert.ok(Math.sign(sx - 32) === Math.sign(yaw), 'positive yaw carries +z to the right');
  }
});

test('a ground shadow is painted only on empty texels, solid at its core with a dithered edge', () => {
  const m = createMesh();
  lathe(m, [[6, 0], [6, 20]], 0, { segs: 16, capTop: true });
  const out = new Uint8Array(64 * 64);
  const stipple = new Uint8Array(64 * 64);
  const SHADOW = 99;
  renderMesh(
    m,
    [{ ramp: A, albedo: 1, ambient: 1 }],
    { yaw: 0, pitch: 0.3, originRow: 44, light: [1, 1, 0], ground: { index: SHADOW, contact: 7, stipple } },
    pick,
    out,
  );
  let solid = 0;
  let dithered = 0;
  let right = 0;
  let left = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== SHADOW) {
      assert.equal(stipple[i], 0, 'stipple only marks shadow texels');
      continue;
    }
    if (stipple[i]) dithered++;
    else solid++;
    if (i % 64 > 38) right++;
    if (i % 64 < 26) left++;
  }
  assert.ok(solid > 20 && dithered > 10, `solid ${solid}, dithered ${dithered}`);
  // Light from screen-right: the cast shadow falls to the left.
  assert.ok(left > right + 10, `the shadow falls away from the light (left ${left}, right ${right})`);
});

test('self-shadowing darkens a surface hidden from the light by another part', () => {
  // A wide lid floating over a post, lit from above and in front: the lid shades the post's front
  // face, which the eye (level, head-on) can still see below the lid.
  const scene = (/** @type {boolean} */ lid) => {
    const m = createMesh();
    box(m, -3, -10, -3, 3, 0, 3, 0);
    if (lid) box(m, -12, 8, -20, 12, 9, 20, 1);
    const out = new Uint8Array(64 * 64);
    const mats = [{ ramp: A, albedo: 1, ambient: 0.1 }, { ramp: B, albedo: 1, ambient: 0.1 }];
    renderMesh(m, mats, { yaw: 0, pitch: 0, originRow: 32, light: [0, 1, 1], shadows: true, outline: false }, pick, out);
    return out[(32 + 5) * 64 + 32]; // the post's front face
  };
  assert.ok(A.indexOf(scene(true)) < A.indexOf(scene(false)), `shadowed ${scene(true)} vs lit ${scene(false)}`);
});
