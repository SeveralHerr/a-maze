// @ts-check
/**
 * @file Tiny low-poly meshes rasterised into 64×64 palette sprites at load (ARCHITECTURE.md §4.5).
 *
 * The raycaster only knows billboards, so a "3D model" here is a mesh rendered **once per view
 * angle** into ordinary sprite textures: the oil flask as one still 3/4 view, the wall
 * sconce as a fan of views across its wall. The renderer picks a frame per sprite, which costs an
 * index calculation — no per-frame geometry, no allocation, no assets.
 *
 * The rasteriser is deliberately small: orthographic projection (a sprite is a flat card anyway),
 * yaw then pitch, a z-buffer, barycentric normals, Lambert + Blinn specular + a transmission term
 * for glass, a one-texel dark outline so the silhouette survives the magnification and the dark
 * corridors, and optional shadows: a shadow map for the model on itself (a handle shading the
 * body) and a stippled cast + contact shadow on the ground plane y = 0. Tones are quantised through the palette ramps by the caller's picker, so a model
 * texel is always a palette index like every other texture.
 *
 * Model space is in **texels**: x right, y up, z toward the viewer at yaw 0. Screen column 32 is
 * x = 0 and `originRow` is y = 0.
 *
 * Node-safe: no DOM access.
 */

/** Texture edge length (mirrors `textures.js` SIZE without importing it — no cycle). */
const S = 64;

/**
 * Surface description. `ramp` is dark → light palette indices.
 * @typedef {Object} Material
 * @property {Uint8Array} ramp
 * @property {number} albedo     0..1 base position along the ramp at full light
 * @property {number} [spec]     specular strength added to the tone
 * @property {number} [shine]    Blinn exponent
 * @property {number} [trans]    glass transmission: tone added where the surface faces the eye
 * @property {number} [ambient]  unlit floor, default 0.22
 */

/**
 * Mutable mesh under construction.
 * @typedef {Object} Mesh
 * @property {number[]} p   vertex positions, xyz triplets
 * @property {number[]} n   vertex normals, xyz triplets
 * @property {number[]} t   triangles: i, j, k, material
 */

/** @returns {Mesh} */
export function createMesh() {
  return { p: [], n: [], t: [] };
}

/**
 * @param {Mesh} m
 * @param {number} x @param {number} y @param {number} z
 * @param {number} nx @param {number} ny @param {number} nz
 * @returns {number} vertex index
 */
function vert(m, x, y, z, nx, ny, nz) {
  const l = Math.hypot(nx, ny, nz) || 1;
  m.p.push(x, y, z);
  m.n.push(nx / l, ny / l, nz / l);
  return m.p.length / 3 - 1;
}

/**
 * Surface of revolution about a vertical axis through `(cx, cz)`, smooth-shaded along the profile.
 * @param {Mesh} m
 * @param {ReadonlyArray<readonly [number, number]>} profile `[radius, y]` bottom → top
 * @param {number} mat material id
 * @param {{cx?: number, cz?: number, segs?: number, a0?: number, a1?: number, capBottom?: boolean, capTop?: boolean}} [o]
 *   `a0..a1` limits the sweep (radians) for a partial shell such as a label
 * @returns {void}
 */
export function lathe(m, profile, mat, o = {}) {
  const cx = o.cx || 0;
  const cz = o.cz || 0;
  const segs = o.segs || 20;
  const a0 = o.a0 ?? 0;
  const a1 = o.a1 ?? Math.PI * 2;
  const closed = o.a0 === undefined && o.a1 === undefined;
  const cols = closed ? segs : segs + 1;
  const rows = profile.length;
  const base = m.p.length / 3;
  for (let r = 0; r < rows; r++) {
    const prev = profile[Math.max(0, r - 1)];
    const next = profile[Math.min(rows - 1, r + 1)];
    // Outward normal of the profile: perpendicular to its tangent (dr, dy).
    const dr = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const pr = dy;
    const py = -dr;
    for (let s = 0; s < cols; s++) {
      const a = a0 + ((a1 - a0) * s) / segs;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      vert(m, cx + profile[r][0] * sn, profile[r][1], cz + profile[r][0] * c, pr * sn, py, pr * c);
    }
  }
  for (let r = 0; r + 1 < rows; r++) {
    for (let s = 0; s < segs; s++) {
      const s1 = closed ? (s + 1) % segs : s + 1;
      const i0 = base + r * cols + s;
      const i1 = base + r * cols + s1;
      const i2 = base + (r + 1) * cols + s;
      const i3 = base + (r + 1) * cols + s1;
      m.t.push(i0, i1, i3, mat, i0, i3, i2, mat);
    }
  }
  const cap = (/** @type {number} */ r, /** @type {number} */ ny) => {
    const [rad, y] = profile[r];
    if (rad <= 0) return;
    const c0 = vert(m, cx, y, cz, 0, ny, 0);
    const ring = [];
    for (let s = 0; s < segs; s++) {
      const a = (Math.PI * 2 * s) / segs;
      ring.push(vert(m, cx + rad * Math.sin(a), y, cz + rad * Math.cos(a), 0, ny, 0));
    }
    for (let s = 0; s < segs; s++) m.t.push(c0, ring[s], ring[(s + 1) % segs], mat);
  };
  if (o.capBottom) cap(0, -1);
  if (o.capTop) cap(rows - 1, 1);
}

/**
 * Axis-aligned box with flat faces.
 * @param {Mesh} m
 * @param {number} x0 @param {number} y0 @param {number} z0
 * @param {number} x1 @param {number} y1 @param {number} z1
 * @param {number} mat
 * @returns {void}
 */
export function box(m, x0, y0, z0, x1, y1, z1, mat) {
  /** @type {[number, number, number, number[][]][]} */
  const faces = [
    [1, 0, 0, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
    [-1, 0, 0, [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
    [0, 1, 0, [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
    [0, -1, 0, [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
    [0, 0, 1, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    [0, 0, -1, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
  ];
  for (const [nx, ny, nz, q] of faces) {
    const i = q.map((v) => vert(m, v[0], v[1], v[2], nx, ny, nz));
    m.t.push(i[0], i[1], i[2], mat, i[0], i[2], i[3], mat);
  }
}

/**
 * A round tube swept along a polyline (handles, arms, twine). Frames are built from the path
 * tangent and a fixed helper axis, which is stable for the gentle bends used here.
 * @param {Mesh} m
 * @param {ReadonlyArray<readonly [number, number, number]>} path
 * @param {number} radius
 * @param {number} mat
 * @param {number} [sides]
 * @returns {void}
 */
export function tube(m, path, radius, mat, sides = 8) {
  const base = m.p.length / 3;
  const n = path.length;
  for (let k = 0; k < n; k++) {
    const a = path[Math.max(0, k - 1)];
    const b = path[Math.min(n - 1, k + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    let tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // Helper axis: whichever world axis is least parallel to the tangent.
    let hx = 0;
    let hy = 0;
    let hz = 0;
    if (Math.abs(tx) < 0.6) hx = 1;
    else hy = 1;
    // u = normalize(h × t), v = t × u
    let ux = hy * tz - hz * ty;
    let uy = hz * tx - hx * tz;
    let uz = hx * ty - hy * tx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = ty * uz - tz * uy;
    const vy = tz * ux - tx * uz;
    const vz = tx * uy - ty * ux;
    for (let s = 0; s < sides; s++) {
      const ang = (Math.PI * 2 * s) / sides;
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const nx = ux * c + vx * sn;
      const ny = uy * c + vy * sn;
      const nz = uz * c + vz * sn;
      const p = path[k];
      vert(m, p[0] + nx * radius, p[1] + ny * radius, p[2] + nz * radius, nx, ny, nz);
    }
  }
  for (let k = 0; k + 1 < n; k++) {
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      const i0 = base + k * sides + s;
      const i1 = base + k * sides + s1;
      const i2 = base + (k + 1) * sides + s;
      const i3 = base + (k + 1) * sides + s1;
      m.t.push(i0, i1, i3, mat, i0, i3, i2, mat);
    }
  }
}

/**
 * Where a model-space point lands on the texture for a given view — used to hang 2D art (the
 * flame) on a 3D anchor.
 * @param {number} x @param {number} y @param {number} z
 * @param {number} yaw @param {number} pitch @param {number} originRow
 * @returns {{sx: number, sy: number}}
 */
export function projectPoint(x, y, z, yaw, pitch, originRow) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const y2 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
  return { sx: S / 2 + x1, sy: originRow - y2 };
}

// Scratch buffers shared by every render: painting is single-threaded and sequential.
const zbuf = new Float32Array(S * S);
const nbuf = new Float32Array(S * S * 3);
const mbuf = new Int16Array(S * S);
const gmask = new Uint8Array(S * S);

/** Shadow-map edge, in map cells, and cells per model texel. Covers ±64 texels around the origin. */
const SM = 256;
const SM_SCALE = 2;
const smap = new Float32Array(SM * SM);

/** Width, texels, of the dithered edge around a ground shadow. */
const PENUMBRA = 2.5;

/** Depth slack before a surface counts as behind the shadow caster, texels. */
const SHADOW_BIAS = 1.6;

/**
 * Visit every pixel centre of a `size × size` grid inside a screen triangle.
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} ys
 * @param {number} a @param {number} b @param {number} c vertex indices
 * @param {number} size grid edge
 * @param {(px: number, py: number, w0: number, w1: number, w2: number, area: number) => void} visit
 * @returns {void}
 */
function fillTri(xs, ys, a, b, c, size, visit) {
  const area = (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]);
  if (Math.abs(area) < 1e-6) return;
  const minX = Math.max(0, Math.floor(Math.min(xs[a], xs[b], xs[c])));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(xs[a], xs[b], xs[c])));
  const minY = Math.max(0, Math.floor(Math.min(ys[a], ys[b], ys[c])));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(ys[a], ys[b], ys[c])));
  const inv = 1 / area;
  for (let py = minY; py <= maxY; py++) {
    const fy = py + 0.5;
    for (let px = minX; px <= maxX; px++) {
      const fx = px + 0.5;
      const w0 = ((xs[b] - fx) * (ys[c] - fy) - (ys[b] - fy) * (xs[c] - fx)) * inv;
      const w1 = ((xs[c] - fx) * (ys[a] - fy) - (ys[c] - fy) * (xs[a] - fx)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      visit(px, py, w0, w1, w2, area);
    }
  }
}

/**
 * Ground shadow options. The shadow is painted only on texels the model leaves transparent, in
 * `index`: solid under the cast shadow and inside the contact radius, and a `PENUMBRA`-texel
 * dithered edge around both, marked in `stipple` so the renderer draws it on half the screen
 * pixels — the same half-shade trick the flame halo uses. (A fully stippled shadow was measured
 * invisible on dark cobbles at play distance.)
 * @typedef {Object} GroundShadow
 * @property {number} index        palette index of the shadow
 * @property {number} contact      radius, texels, of the contact shadow around the base
 * @property {Uint8Array} stipple  out: 1 on half-shade texels
 */

/**
 * Rasterise a mesh into `out` (palette indices, 0 = untouched/transparent).
 * @param {Mesh} mesh
 * @param {ReadonlyArray<Material>} mats
 * @param {{yaw: number, pitch: number, originRow: number, light: readonly [number, number, number], outline?: boolean, shadows?: boolean, ground?: GroundShadow}} view
 *   `light` is the direction *toward* the light in view space (x right, y up, z toward the eye).
 *   `shadows` lets the model shadow itself; `ground` adds a cast shadow on the plane y = 0 (it
 *   needs `pitch > 0`, or the ground is seen edge-on)
 * @param {(ramp: Uint8Array, t: number, x: number, y: number) => number} pick ramp quantiser
 * @param {Uint8Array} out 64×64 row-major index buffer, painted over where the model covers it
 * @returns {void}
 */
export function renderMesh(mesh, mats, view, pick, out) {
  const { yaw, pitch, originRow } = view;
  const cyw = Math.cos(yaw);
  const syw = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const nv = mesh.p.length / 3;
  const sx = new Float32Array(nv);
  const sy = new Float32Array(nv);
  const sz = new Float32Array(nv);
  const vn = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const x = mesh.p[i * 3];
    const y = mesh.p[i * 3 + 1];
    const z = mesh.p[i * 3 + 2];
    const x1 = x * cyw + z * syw;
    const z1 = -x * syw + z * cyw;
    sx[i] = S / 2 + x1;
    sy[i] = originRow - (y * cp - z1 * sp);
    sz[i] = y * sp + z1 * cp;
    const nx = mesh.n[i * 3];
    const ny = mesh.n[i * 3 + 1];
    const nz = mesh.n[i * 3 + 2];
    const nx1 = nx * cyw + nz * syw;
    const nz1 = -nx * syw + nz * cyw;
    vn[i * 3] = nx1;
    vn[i * 3 + 1] = ny * cp - nz1 * sp;
    vn[i * 3 + 2] = ny * sp + nz1 * cp;
  }

  zbuf.fill(-Infinity);
  mbuf.fill(-1);
  const t = mesh.t;
  for (let k = 0; k < t.length; k += 4) {
    const a = t[k];
    const b = t[k + 1];
    const c = t[k + 2];
    const mat = t[k + 3];
    fillTri(sx, sy, a, b, c, S, (px, py, w0, w1, w2, area) => {
      const z = w0 * sz[a] + w1 * sz[b] + w2 * sz[c];
      const i = py * S + px;
      if (z <= zbuf[i]) return;
      zbuf[i] = z;
      mbuf[i] = mat;
      // Screen y points down, so a front face (counter-clockwise seen from the eye) has negative
      // area. Back faces are still drawn (open shells: the inside of a cup) with their normal flipped.
      const flip = area > 0 ? -1 : 1;
      nbuf[i * 3] = flip * (w0 * vn[a * 3] + w1 * vn[b * 3] + w2 * vn[c * 3]);
      nbuf[i * 3 + 1] = flip * (w0 * vn[a * 3 + 1] + w1 * vn[b * 3 + 1] + w2 * vn[c * 3 + 1]);
      nbuf[i * 3 + 2] = flip * (w0 * vn[a * 3 + 2] + w1 * vn[b * 3 + 2] + w2 * vn[c * 3 + 2]);
    });
  }

  const [lx0, ly0, lz0] = view.light;
  const ll = Math.hypot(lx0, ly0, lz0) || 1;
  const lx = lx0 / ll;
  const ly = ly0 / ll;
  const lz = lz0 / ll;
  // Blinn half-vector with the eye at +z.
  const hl = Math.hypot(lx, ly, lz + 1) || 1;
  const hx = lx / hl;
  const hy = ly / hl;
  const hz = (lz + 1) / hl;

  // ── Self-shadow map ── an orthographic depth map seen from the light, in view space. Basis
  // (ax, 0, az) ⟂ light and (bx, by, bz) = a × light span the map; depth grows toward the light.
  const shadows = view.shadows === true;
  let ax = -lz;
  let az = lx;
  const al = Math.hypot(ax, az);
  if (al < 1e-3) {
    ax = 1;
    az = 0;
  } else {
    ax /= al;
    az /= al;
  }
  const bx = -az * ly;
  const by = az * lx - ax * lz;
  const bz = ax * ly;
  if (shadows) {
    const mu = new Float32Array(nv);
    const mv = new Float32Array(nv);
    const md = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      const vx = sx[i] - S / 2;
      const vy = originRow - sy[i];
      const vz = sz[i];
      mu[i] = (vx * ax + vz * az) * SM_SCALE + SM / 2;
      mv[i] = (vx * bx + vy * by + vz * bz) * SM_SCALE + SM / 2;
      md[i] = vx * lx + vy * ly + vz * lz;
    }
    smap.fill(-Infinity);
    for (let k = 0; k < t.length; k += 4) {
      const a = t[k];
      const b = t[k + 1];
      const c = t[k + 2];
      fillTri(mu, mv, a, b, c, SM, (px, py, w0, w1, w2) => {
        const d = w0 * md[a] + w1 * md[b] + w2 * md[c];
        const j = py * SM + px;
        if (d > smap[j]) smap[j] = d;
      });
    }
  }

  for (let i = 0; i < S * S; i++) {
    const mi = mbuf[i];
    if (mi < 0) continue;
    const mat = mats[mi];
    let nx = nbuf[i * 3];
    let ny = nbuf[i * 3 + 1];
    let nz = nbuf[i * 3 + 2];
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    let lit = 1;
    if (shadows) {
      const vx = (i % S) + 0.5 - S / 2;
      const vy = originRow - (((i / S) | 0) + 0.5);
      const vz = zbuf[i];
      const u = Math.floor((vx * ax + vz * az) * SM_SCALE + SM / 2);
      const v = Math.floor((vx * bx + vy * by + vz * bz) * SM_SCALE + SM / 2);
      if (u >= 0 && v >= 0 && u < SM && v < SM && vx * lx + vy * ly + vz * lz < smap[v * SM + u] - SHADOW_BIAS) lit = 0;
    }
    const diff = lit * Math.max(0, nx * lx + ny * ly + nz * lz);
    const amb = mat.ambient ?? 0.22;
    let tone = mat.albedo * (amb + (1 - amb) * diff);
    if (mat.spec && lit) tone += mat.spec * Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), mat.shine || 16);
    if (mat.trans) tone += mat.trans * (Math.max(0, nz) - 0.5);
    out[i] = pick(mat.ramp, tone, i % S, (i / S) | 0);
  }

  if (view.outline !== false) {
    // One-texel outline in each covering material's darkest step, on transparent neighbours only.
    for (let i = 0; i < S * S; i++) {
      if (mbuf[i] >= 0 || out[i] !== 0) continue;
      const x = i % S;
      const y = (i / S) | 0;
      let src = -1;
      if (x > 0 && mbuf[i - 1] >= 0) src = mbuf[i - 1];
      else if (x < S - 1 && mbuf[i + 1] >= 0) src = mbuf[i + 1];
      else if (y > 0 && mbuf[i - S] >= 0) src = mbuf[i - S];
      else if (y < S - 1 && mbuf[i + S] >= 0) src = mbuf[i + S];
      if (src >= 0) out[i] = mats[src].ramp[0];
    }
  }

  const ground = view.ground;
  if (ground && sp > 1e-3) {
    // The light in model space (undo pitch, then yaw), and every vertex slid along it onto y = 0.
    const z1 = -ly * sp + lz * cp;
    const gy = ly * cp + lz * sp;
    const gx = lx * cyw - z1 * syw;
    const gz = lx * syw + z1 * cyw;
    gmask.fill(0);
    if (gy > 0.05) {
      const px = new Float32Array(nv);
      const py = new Float32Array(nv);
      for (let i = 0; i < nv; i++) {
        const y = mesh.p[i * 3 + 1];
        const x = mesh.p[i * 3] - (gx * y) / gy;
        const z = mesh.p[i * 3 + 2] - (gz * y) / gy;
        const zr = -x * syw + z * cyw;
        px[i] = S / 2 + x * cyw + z * syw;
        py[i] = originRow + zr * sp;
      }
      for (let k = 0; k < t.length; k += 4) {
        fillTri(px, py, t[k], t[k + 1], t[k + 2], S, (qx, qy) => {
          gmask[qy * S + qx] = 1;
        });
      }
    }
    for (let i = 0; i < S * S; i++) {
      if (out[i] !== 0) continue;
      // Where this texel's ray meets the ground, and how far that is from the model's axis.
      const x1 = (i % S) + 0.5 - S / 2;
      const zr = (((i / S) | 0) + 0.5 - originRow) / sp;
      const r = Math.hypot(x1 * cyw - zr * syw, x1 * syw + zr * cyw);
      if (gmask[i] === 1 || r < ground.contact) {
        out[i] = ground.index;
        continue;
      }
      // Penumbra: near the contact ring, or a texel away from the cast shadow on any side.
      const x = i % S;
      const y = (i / S) | 0;
      const nearCast =
        (x > 0 && gmask[i - 1] === 1) || (x < S - 1 && gmask[i + 1] === 1) || (y > 0 && gmask[i - S] === 1) || (y < S - 1 && gmask[i + S] === 1);
      if (nearCast || r < ground.contact + PENUMBRA) {
        out[i] = ground.index;
        ground.stipple[i] = 1;
      }
    }
  }
}
