// @ts-check
/**
 * @file Pooled pixel particles drawn straight into the raycaster's framebuffer
 * (ARCHITECTURE.md §4.5: "screen-space pixel particles for sparkles/embers (pooled)").
 *
 * WHY particles live in **world space** here even though they are drawn as screen-space pixels:
 * embers have to rise out of a specific torch and sparkles have to burst at the tile where a gem
 * was taken. Projecting them through the same camera as the sprites (and z-testing against the
 * same wall z-buffer) makes them belong to the scene — they go behind corners, they shrink with
 * distance, and they fade into the fog exactly like every other surface. A purely screen-space
 * system cannot do any of that.
 *
 * WHY a struct-of-arrays pool instead of `src/core/pool.js`: a particle is nine scalars. Holding
 * them in nine typed arrays means the whole live set is a handful of contiguous cache lines with
 * no object headers, no property lookups and no `Map` bookkeeping on release. `createPool` is the
 * right tool for heterogeneous objects with references; this is not that. Either way the promise
 * is the same and is kept: **zero allocation after construction**.
 *
 * Units: positions and velocities are in tiles and tiles/second; `z` is height above the floor
 * where the floor is 0, the ceiling 1 and the camera eye 0.5. Life is in seconds.
 */

import { C } from './palette.js';

/**
 * Particle behaviours. The kind only selects the motion model — colour is passed at spawn, so a
 * caller can emit a green ember or a violet spark without new code here.
 * @readonly
 * @enum {number}
 */
export const PARTICLE = Object.freeze({
  /** Rises, slows, drifts sideways — torch embers and smoke motes. */
  EMBER: 0,
  /** Ballistic with gravity and a slight drag — gem pickup bursts. */
  SPARK: 1,
  /** Near-weightless, drifts on an invisible draught — dust in the torchlight. */
  DUST: 2,
});

/** Gravity applied to `SPARK`, in tiles/s². Tuned so a 2 tiles/s pop arcs over in ~0.4 s. */
const SPARK_GRAVITY = 2.6;

/** Per-second velocity retention of each kind (drag). Applied as `v *= pow(DRAG, dt)`. */
const DRAG = Float32Array.of(0.12, 0.55, 0.7);

/** Buoyancy of an ember, tiles/s². Positive is up. */
const EMBER_LIFT = 0.55;

/**
 * The subset of camera state a particle draw needs. The raycaster owns exactly one of these and
 * refills it every frame, so nothing is allocated per frame on this path.
 * @typedef {Object} ParticleCamera
 * @property {number} px            camera x (tiles)
 * @property {number} py            camera y (tiles)
 * @property {number} dirX          view direction
 * @property {number} dirY
 * @property {number} planeX        camera plane (half the view width at distance 1)
 * @property {number} planeY
 * @property {number} invDet        1 / (planeX*dirY - dirX*planeY), precomputed once per frame
 * @property {number} horizon       screen row of the eye level, in pixels
 * @property {Uint32Array} colormap shade table, `(level << 8) | paletteIndex`
 * @property {Float32Array} fogLut  distance → 0..1 visibility
 * @property {number} fogScale      multiply a distance in tiles by this to index `fogLut`
 * @property {number} fogLutMax     last valid `fogLut` index
 */

/**
 * @typedef {Object} ParticleSystem
 * @property {number} count               live particles (getter)
 * @property {number} capacity            pool size (getter)
 * @property {(kind:number, x:number, y:number, z:number, vx:number, vy:number, vz:number, life:number, color:number, size:number) => boolean} spawn
 * @property {(kind:number, x:number, y:number, z:number, n:number, speed:number, life:number, color:number, rnd:() => number) => number} burst
 * @property {(dt:number) => void} update
 * @property {(buf:Uint32Array, w:number, h:number, zbuf:Float32Array, cam:ParticleCamera) => number} draw
 * @property {() => void} clear
 */

/**
 * Create a particle pool.
 *
 * The pool never grows: `spawn` returns `false` when it is full, which is the correct behaviour
 * for an effects system (dropping the 385th ember is invisible; a GC pause is not).
 * @param {number} [capacity] maximum simultaneous particles (floored, ≥ 0)
 * @returns {ParticleSystem}
 */
export function createParticles(capacity = 384) {
  const cap = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0;

  const px = new Float32Array(cap);
  const py = new Float32Array(cap);
  const pz = new Float32Array(cap);
  const vx = new Float32Array(cap);
  const vy = new Float32Array(cap);
  const vz = new Float32Array(cap);
  const life = new Float32Array(cap);
  const life0 = new Float32Array(cap);
  const kind = new Uint8Array(cap);
  const color = new Uint8Array(cap);
  const size = new Uint8Array(cap);

  let count = 0;

  /**
   * Swap-remove: the last live particle takes the dead one's slot. Live order is not stable,
   * which no effect cares about, and it keeps removal O(1) with no holes to skip.
   * @param {number} i
   * @returns {void}
   */
  function removeAt(i) {
    const last = --count;
    if (i !== last) {
      px[i] = px[last];
      py[i] = py[last];
      pz[i] = pz[last];
      vx[i] = vx[last];
      vy[i] = vy[last];
      vz[i] = vz[last];
      life[i] = life[last];
      life0[i] = life0[last];
      kind[i] = kind[last];
      color[i] = color[last];
      size[i] = size[last];
    }
  }

  /**
   * Emit one particle.
   * @param {number} k one of `PARTICLE.*`
   * @param {number} x world x (tiles)
   * @param {number} y world y (tiles)
   * @param {number} z height above the floor (0 = floor, 1 = ceiling)
   * @param {number} dx velocity x (tiles/s)
   * @param {number} dy velocity y (tiles/s)
   * @param {number} dz velocity z (tiles/s)
   * @param {number} ttl lifetime in seconds (ignored when ≤ 0)
   * @param {number} colorIndex palette index to draw with
   * @param {number} pxSize side of the drawn square in framebuffer pixels (1..3)
   * @returns {boolean} false when the pool is full or `ttl` is not positive
   */
  function spawn(k, x, y, z, dx, dy, dz, ttl, colorIndex, pxSize) {
    if (count >= cap || !(ttl > 0)) return false;
    const i = count++;
    px[i] = x;
    py[i] = y;
    pz[i] = z;
    vx[i] = dx;
    vy[i] = dy;
    vz[i] = dz;
    life[i] = ttl;
    life0[i] = ttl;
    kind[i] = k;
    color[i] = colorIndex;
    size[i] = pxSize < 1 ? 1 : pxSize > 3 ? 3 : pxSize | 0;
    return true;
  }

  /**
   * Emit `n` particles in a spherical spray. `rnd` is injected (rather than a module-level RNG) so
   * the caller controls determinism — the raycaster passes its seeded stream.
   * @param {number} k one of `PARTICLE.*`
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} n particles requested
   * @param {number} speed peak speed, tiles/s
   * @param {number} ttl lifetime seconds (each particle gets 60–100 % of it)
   * @param {number} colorIndex
   * @param {() => number} rnd uniform [0,1) source
   * @returns {number} particles actually emitted
   */
  function burst(k, x, y, z, n, speed, ttl, colorIndex, rnd) {
    let made = 0;
    for (let i = 0; i < n; i++) {
      // Uniform-ish direction on a sphere, squashed vertically so bursts read as a fan not a ball.
      const a = rnd() * Math.PI * 2;
      const s = speed * (0.35 + 0.65 * rnd());
      const up = (rnd() - 0.2) * speed * 0.9;
      if (!spawn(k, x, y, z, Math.cos(a) * s, Math.sin(a) * s, up, ttl * (0.6 + 0.4 * rnd()), colorIndex, 1)) {
        break;
      }
      made++;
    }
    return made;
  }

  /**
   * Advance every live particle and retire the expired ones.
   * @param {number} dt seconds (clamped to 0..0.25 so a tab-switch cannot teleport particles)
   * @returns {void}
   */
  function update(dt) {
    const d = dt > 0 ? (dt > 0.25 ? 0.25 : dt) : 0;
    if (d === 0) return;
    // Drag is exponential in time; one `pow` per kind per frame, not one per particle.
    const dragE = Math.pow(DRAG[0], d);
    const dragS = Math.pow(DRAG[1], d);
    const dragD = Math.pow(DRAG[2], d);
    for (let i = count - 1; i >= 0; i--) {
      const t = life[i] - d;
      if (t <= 0) {
        removeAt(i);
        continue;
      }
      life[i] = t;
      const k = kind[i];
      if (k === PARTICLE.EMBER) {
        vz[i] = vz[i] * dragE + EMBER_LIFT * d;
        vx[i] *= dragE;
        vy[i] *= dragE;
      } else if (k === PARTICLE.SPARK) {
        vz[i] = vz[i] * dragS - SPARK_GRAVITY * d;
        vx[i] *= dragS;
        vy[i] *= dragS;
      } else {
        vz[i] *= dragD;
        vx[i] *= dragD;
        vy[i] *= dragD;
      }
      px[i] += vx[i] * d;
      py[i] += vy[i] * d;
      pz[i] += vz[i] * d;
      // Particles that sink through the floor or escape through the ceiling die early rather than
      // drawing inside geometry.
      if (pz[i] < 0.02 || pz[i] > 0.99) removeAt(i);
    }
  }

  /**
   * Project and blit every live particle.
   *
   * Each is a 1–3 px square, z-tested against the wall depth buffer so particles disappear behind
   * corners, and shaded through the same colormap + fog LUT as the world, so they never look
   * pasted on. Particles are emissive: they start at the brightest shade level and fade out with
   * their remaining life.
   * @param {Uint32Array} buf framebuffer
   * @param {number} w framebuffer width
   * @param {number} h framebuffer height
   * @param {Float32Array} zbuf per-column wall distance
   * @param {ParticleCamera} cam
   * @returns {number} particles actually drawn
   */
  function draw(buf, w, h, zbuf, cam) {
    let drawn = 0;
    const halfW = w * 0.5;
    for (let i = 0; i < count; i++) {
      const sx = px[i] - cam.px;
      const sy = py[i] - cam.py;
      // Same inverse camera matrix the sprite pass uses; `tY` is the perpendicular depth.
      const tY = cam.invDet * (-cam.planeY * sx + cam.planeX * sy);
      if (tY < 0.12) continue; // behind the eye or in the near-clip zone
      const tX = cam.invDet * (cam.dirY * sx - cam.dirX * sy);
      const scrX = (halfW * (1 + tX / tY)) | 0;
      if (scrX < 0 || scrX >= w) continue;
      if (tY >= zbuf[scrX]) continue; // occluded by a wall
      const scrY = (cam.horizon + ((0.5 - pz[i]) / tY) * h) | 0;
      if (scrY < 0 || scrY >= h) continue;

      const fade = life[i] / life0[i]; // 1 → 0 across the lifetime
      let fi = (tY * cam.fogScale) | 0;
      if (fi > cam.fogLutMax) fi = cam.fogLutMax;
      let level = (63 * cam.fogLut[fi] * (0.35 + 0.65 * fade)) | 0;
      if (level < 0) level = 0;
      else if (level > 63) level = 63;
      const rgba = cam.colormap[(level << 8) | color[i]];

      // Squares shrink with distance so a near ember is a chunky 3 px and a far one a single dot.
      let s = size[i];
      if (tY > 3) s = 1;
      else if (tY > 1.5 && s > 2) s = 2;
      for (let dy = 0; dy < s; dy++) {
        const yy = scrY + dy;
        if (yy < 0 || yy >= h) continue;
        const row = yy * w;
        for (let dx = 0; dx < s; dx++) {
          const xx = scrX + dx;
          if (xx < 0 || xx >= w) continue;
          // Re-test depth per column: a 3 px square can straddle a wall edge.
          if (tY >= zbuf[xx]) continue;
          buf[row + xx] = rgba;
        }
      }
      drawn++;
    }
    return drawn;
  }

  /** Retire everything (level change, phase reset). */
  function clear() {
    count = 0;
  }

  return {
    get count() {
      return count;
    },
    get capacity() {
      return cap;
    },
    spawn,
    burst,
    update,
    draw,
    clear,
  };
}

/**
 * Palette indices the game's stock effects use, exported so main.js does not have to import the
 * palette to emit a pickup burst.
 * @type {Readonly<{ember:number, emberHot:number, spark:number, sparkPale:number, dust:number, arcane:number}>}
 */
export const PARTICLE_COLORS = Object.freeze({
  ember: C.fireEmber,
  emberHot: C.fireHot,
  spark: C.gemBright,
  sparkPale: C.gemSpec,
  dust: C.cobLight,
  arcane: C.arcLight,
});
