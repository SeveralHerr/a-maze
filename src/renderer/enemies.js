// @ts-check
/**
 * @file New Descent's art: the two creatures and the player's sword (ARCHITECTURE.md §4.11).
 *
 * Deliberately **not** part of `createTextures`. A Classic Descent session never fights anything, so
 * it must never pay for painting monsters; `createCombatTextures` is called lazily the first time a
 * combat run needs it and installed with `raycaster.setCombatTextures(set)`, beside the tileset's
 * `TextureSet` rather than inside it — which is what keeps the per-floor tileset swap (§4.5)
 * untouched by a set that is painted once for the whole session.
 *
 * Everything here is **modelled** (`models.js`) and rasterised into ordinary 64×64 palette sprites,
 * exactly like the oil flask and the wall sconce: there is no per-frame geometry anywhere in the
 * renderer, only an index into a frame array.
 *
 * ## How the two creatures are told apart
 * At 240p, down a corridor lit by a failing torch, hue is not a distinction a player can read —
 * shape and *temperature* are. So the two are separated on both:
 *
 * |          | crawler                          | wraith                             |
 * |----------|----------------------------------|------------------------------------|
 * | silhouette | wide, low, legs out past the body | narrow, tall, a vertical column   |
 * | motion   | six legs in a scuttling gait      | a hem that drifts, no legs at all  |
 * | colour   | warm chitin, takes the firelight  | cold shroud, refuses it            |
 * | eyes     | a low cluster of ember points     | two cold points high in a black hood |
 *
 * ## Frame layout
 * A creature's frames are `[views × gait] ++ [poses]`:
 * - `ENEMY_VIEWS` (6) yaws around the full turn, so a monster that has not noticed you is seen from
 *   behind and one hunting you is seen face on;
 * - `ENEMY_FRAMES` (4) gait frames per view;
 * - then the pose frames (`ENEMY_POSE`), rendered **front-on only** — a creature that is winding up,
 *   striking, staggering or dying is looking at the player by definition, and rendering four more
 *   poses × six views would quadruple the paint cost to cover a case that does not occur.
 *
 * `enemyFrameIndex(view, pose)` is the one formula, exported so the renderer and its test cannot
 * disagree about it.
 *
 * Node-safe and deterministic, like `textures.js`: no DOM, all randomness from `src/core/rng.js`.
 */

import { createRng } from '../core/rng.js';
import { C, RAMPS } from './palette.js';
import { box, createMesh, lathe, projectPoint, renderMesh, tube } from './models.js';
import {
  AREA,
  SIZE,
  finish,
  finishStippled,
  h01,
  putClip,
  rampPickChunky,
  rampPickFlat,
} from './textures.js';

/** @typedef {import('./textures.js').Texture} Texture */
/** @typedef {import('../core/types.js').EnemyKind} EnemyKind */
/** @typedef {import('./models.js').Mesh} Mesh */

/**
 * Yaw views around the full turn. Six is the fewest that still reads as *turning* rather than as
 * snapping: 60° apart, so the silhouette changes on every second step of a circle round the player.
 */
export const ENEMY_VIEWS = 6;

/** Gait frames per view. Four, phase-locked to the enemy's `anim` exactly as footsteps are. */
export const ENEMY_FRAMES = 4;

/**
 * The pose frames, after the gait grid. Order is part of `enemyFrameIndex`.
 * @type {Readonly<Record<string, number>>}
 */
export const ENEMY_POSE = Object.freeze({
  WIND: 0,
  STRIKE: 1,
  STAGGER: 2,
  DIE_A: 3,
  DIE_B: 4,
});

/** How many pose frames follow the gait grid. */
export const ENEMY_POSE_COUNT = 5;

/** Total frames per creature. */
export const ENEMY_FRAME_COUNT = ENEMY_VIEWS * ENEMY_FRAMES + ENEMY_POSE_COUNT;

/**
 * Index of a creature frame.
 *
 * The one formula both the painter and the renderer use. `pose` of −1 asks for the gait grid;
 * anything else asks for a pose frame and `view` is ignored, because poses are painted front-on
 * (see the file header).
 * @param {number} view 0…`ENEMY_VIEWS`−1
 * @param {number} pose −1 for the gait, else an `ENEMY_POSE` value
 * @param {number} [gait] 0…`ENEMY_FRAMES`−1 when `pose` is −1
 * @returns {number} an index into the creature's frame array, always in range
 */
export function enemyFrameIndex(view, pose, gait = 0) {
  if (pose >= 0) {
    const p = pose < ENEMY_POSE_COUNT ? pose | 0 : ENEMY_POSE_COUNT - 1;
    return ENEMY_VIEWS * ENEMY_FRAMES + p;
  }
  let v = view | 0;
  v = ((v % ENEMY_VIEWS) + ENEMY_VIEWS) % ENEMY_VIEWS;
  let g = gait | 0;
  g = ((g % ENEMY_FRAMES) + ENEMY_FRAMES) % ENEMY_FRAMES;
  return v * ENEMY_FRAMES + g;
}

/** Sword poses, in swing order. The renderer picks one from the attack state machine. */
export const SWORD_FRAMES = 8;

/**
 * How big each creature's billboard stands in the world, and which texel row of its card is the
 * floor it stands on.
 *
 * These live here, with the art, rather than in `balance.js`: they are **not** gameplay balance,
 * they are a property of the painting — move the origin row and the same numbers would put the
 * creature underground. `src/renderer` may not import `src/state` anyway (§2), and the map scroll
 * already works exactly this way (`MAP_FLOOR_ROW` + `MAP_SPRITE_SCALE`, §4.5). `raycaster.js`
 * derives the vertical offset from the pair with the scroll's formula.
 *
 * `scale` is the card's height in tiles. A creature fills roughly half its card, so the number is
 * larger than the height it reads at: the crawler stands about knee-high, the wraith a head taller
 * than the player.
 * @type {Readonly<Record<string, {scale:number, floorRow:number}>>}
 */
export const ENEMY_ART = Object.freeze({
  // The crawler's card fill was pulled back (1.55 → 1.38) because its antennae reached the card's
  // edge at the diagonal yaws and were clipped off; `scale` is raised in step, so the creature is
  // the same size in the world and simply has a margin to turn around in.
  crawler: { scale: 1.55, floorRow: 54 },
  // 1.15, not 1.55: a wraith fills three quarters of its card, so 1.55 made it 1.16 tiles tall —
  // TALLER THAN THE CORRIDOR. Its hood was cut off by the top of the view at the range it is
  // actually fought, which is the one part of it a player needs to see. At 1.15 it stands about
  // 0.85 tiles: a head above the player's eye, comfortably under the ceiling.
  wraith: { scale: 1.15, floorRow: 60 },
});

/**
 * The combat art set.
 * @typedef {Object} CombatTextures
 * @property {number} seed
 * @property {Texture[]} crawler  `ENEMY_FRAME_COUNT` frames, indexed by `enemyFrameIndex`
 * @property {Texture[]} wraith   the same layout
 * @property {Texture[]} sword    `SWORD_FRAMES` first-person poses, idle → recover
 */

// ─── Mesh helpers ────────────────────────────────────────────────────────────────────────────

/**
 * Rotate a mesh about the z axis (the screen plane) and translate it, in place.
 *
 * `models.js` renders a yaw and a pitch but no **roll**, and a sword swing is very largely a roll:
 * the blade comes over high and right and falls across the view. Baking the roll into the geometry
 * before rasterising is what buys it, and it costs nothing at runtime — these meshes are built once,
 * at paint time, and thrown away.
 * @param {Mesh} m
 * @param {number} angle radians, positive = anticlockwise on screen
 * @param {number} dx texels
 * @param {number} dy texels
 * @returns {Mesh} the same mesh
 */
function rollMesh(m, angle, dx, dy) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let i = 0; i < m.p.length; i += 3) {
    const x = m.p[i];
    const y = m.p[i + 1];
    m.p[i] = x * c - y * s + dx;
    m.p[i + 1] = x * s + y * c + dy;
    const nx = m.n[i];
    const ny = m.n[i + 1];
    m.n[i] = nx * c - ny * s;
    m.n[i + 1] = nx * s + ny * c;
  }
  return m;
}

/**
 * Scale a whole mesh about the model origin, in place.
 *
 * The creatures are authored at whatever size reads well as geometry and then scaled to **fill the
 * 64-texel card**, because the card's rows are the creature's resolution: the first pass of the
 * crawler used 18 of 64 rows, so three quarters of its sprite was empty air and the thing that
 * reached the screen was 18 texels of detail stretched over a monster. Filling the card is worth
 * more than any amount of tuning the billboard's world height.
 * @param {Mesh} m
 * @param {number} k
 * @returns {Mesh} the same mesh
 */
function scaleMesh(m, k) {
  for (let i = 0; i < m.p.length; i++) m.p[i] *= k;
  return m;
}

/**
 * A rounded limb: a tube whose ends are closed by a short taper, so a leg does not end in a
 * visible open pipe at the two or three screen pixels it occupies.
 * @param {Mesh} m
 * @param {ReadonlyArray<readonly [number, number, number]>} path
 * @param {number} radius
 * @param {number} mat
 * @returns {void}
 */
function limb(m, path, radius, mat) {
  tube(m, path, radius, mat, 6);
}

// ─── The crawler ─────────────────────────────────────────────────────────────────────────────

/**
 * Palette index the ground shadow is painted in.
 *
 * Exported so `enemies.test.mjs` can measure a creature's BODY separately from the shadow it casts:
 * the body must stay inside its card (a monster with a flank clipped off is a bug), while the
 * shadow is allowed to run off the edge (a clipped shadow is just a shadow).
 */
export const SHADOW_INDEX = C.void;

/** Texel row of the crawler's model-space origin (the floor its legs stand on). */
const CRAWLER_ORIGIN_ROW = ENEMY_ART.crawler.floorRow;

/** How much the crawler's mesh is scaled up to fill its card. See {@link scaleMesh}. */
const CRAWLER_FILL = 1.38;

/** The wraith is already nearly card-height; it only needs a nudge. */
const WRAITH_FILL = 1.12;

/** @type {import('./models.js').Material[]} */
const CRAWLER_MATS = [
  // 0 carapace: waxy, with a HARD narrow specular — a high `shine` keeps the highlight to a band
  // along the shell's ridge instead of a broad sheen, and that band is the only thing separating
  // three domes from one orange blob at the size the creature is actually seen.
  { ramp: RAMPS.chitin, albedo: 0.58, spec: 1.25, shine: 42, ambient: 0.2 },
  // 1 legs and underside: matte, and DARKER THAN THE SHELL BUT NOT DARK. Pushing this to 0.2 to
  // separate the legs did the exact opposite at corridor distance: the colormap crushes its dark end,
  // so legs, body shadow, outline and cast shadow all landed on the same two ramp steps and the
  // creature became a brown blob with two orange eyes. A lit leg has to sit a couple of ramp steps
  // ABOVE `chitinShadow`; the one-texel dark outline is what separates one limb from the next.
  { ramp: RAMPS.chitin, albedo: 0.46, spec: 0.25, shine: 18, ambient: 0.26 },
  // 2 mandibles: bone-pale against the shell, which is what makes the front end read as a head.
  { ramp: RAMPS.map, albedo: 0.92, spec: 0.5, shine: 20, ambient: 0.38 },
];

/**
 * The crawler: three domed segments front to back, six legs out past the body, two mandibles and
 * a pair of antennae.
 *
 * The segments are separate lathes rather than one long body because a lathe is radially symmetric,
 * and a single dome would look identical from every yaw — the offsets along z are what make the
 * six views actually different. The legs do the rest.
 * @param {number} gait 0..1 phase through one stride
 * @param {number} rear 0..1 how far the front is reared up (a wind-up and a strike rear)
 * @returns {Mesh}
 */
function crawlerMesh(gait, rear) {
  const m = createMesh();
  const lift = rear * 5;
  // Abdomen, thorax, head — decreasing domes along +z (forward).
  lathe(m, [[0, 1], [7, 1.5], [9.6, 3.5], [10.2, 7], [8.6, 10], [5, 12], [0, 12.6]], 0, { segs: 16, cz: -8.5 });
  lathe(m, [[0, 1.5], [6.5, 2], [8.4, 4.5], [8.6, 8], [6.8, 10.6], [3.6, 12], [0, 12.4]], 0, { segs: 16, cz: 0.5 });
  lathe(m, [[0, 2 + lift], [4.6, 2.6 + lift], [5.8, 5 + lift], [5.4, 7.8 + lift], [3.4, 9.4 + lift], [0, 10 + lift]], 0, {
    segs: 14,
    cz: 9,
  });

  // Six legs, three a side, alternating tripod gait: a real insect moves 1/3/5 with 2/4/6, which is
  // what stops four frames of leg animation reading as a shuffle.
  for (let side = 0; side < 2; side++) {
    const sx = side === 0 ? -1 : 1;
    for (let k = 0; k < 3; k++) {
      const tripod = (k + side) & 1;
      const ph = (gait + tripod * 0.5) * Math.PI * 2;
      const swing = Math.sin(ph);
      const step = Math.max(0, Math.cos(ph)) * 2.6;
      const zRoot = 5 - k * 6.5;
      const zTip = zRoot + swing * 4.5;
      const knee = 9 + step * 0.4;
      limb(
        m,
        [
          [sx * 5, 6, zRoot],
          [sx * 11, knee, zRoot + swing * 1.6],
          [sx * 15.5, 5.5 + step, zTip],
          [sx * 17, 0.6 + step * 1.1, zTip + swing * 1.2],
        ],
        1.35,
        1,
      );
    }
  }

  // Mandibles: forward and slightly down, opening as the creature rears.
  const open = 0.9 + rear * 2.4;
  for (let side = 0; side < 2; side++) {
    const sx = side === 0 ? -1 : 1;
    limb(
      m,
      [
        [sx * 2.4, 5 + lift, 12],
        [sx * (2.6 + open), 4 + lift, 15.5],
        [sx * (1.6 + open * 0.6), 3 + lift, 18.5],
      ],
      1.15,
      2,
    );
  }
  // Antennae: thin, swept back, and they sway with the gait — the one soft thing on it. Kept SHORT
  // and swept upward rather than outward: at the diagonal yaws a longer pair swung out past the
  // 64-texel card and had its tips clipped, which is the one part of a silhouette nobody notices is
  // missing and everybody notices is wrong.
  for (let side = 0; side < 2; side++) {
    const sx = side === 0 ? -1 : 1;
    const sway = Math.sin(gait * Math.PI * 2 + side) * 1.2;
    limb(
      m,
      [
        [sx * 2.6, 10 + lift, 11],
        [sx * 4.6, 14 + lift, 13 + sway],
        [sx * 6.4, 17 + lift, 14.5 + sway * 1.4],
      ],
      0.7,
      1,
    );
  }
  return m;
}

// ─── The wraith ──────────────────────────────────────────────────────────────────────────────

/** Texel row of the wraith's model-space origin (the floor its hem drifts over). */
const WRAITH_ORIGIN_ROW = ENEMY_ART.wraith.floorRow;

/** @type {import('./models.js').Material[]} */
const WRAITH_MATS = [
  // 0 robe: matte and cold, with a low ambient so the folds go genuinely black in the creases.
  { ramp: RAMPS.shroud, albedo: 0.52, spec: 0.08, ambient: 0.18 },
  // 1 hood: darker still — the cowl has to read as a hole, not as a hat.
  { ramp: RAMPS.shroud, albedo: 0.26, spec: 0.05, ambient: 0.12 },
  // 2 hands: bone, and the palest thing on the creature. It is the only part with any warmth, so it
  // is where the eye goes after the cowl — which is right, because it is the part that reaches.
  { ramp: RAMPS.map, albedo: 1.0, spec: 0.45, shine: 16, ambient: 0.45 },
];

/**
 * The wraith: a tall robed column with no legs, a deep cowl, and two long arms.
 *
 * It is built around a single vertical lathe because that is exactly what it is — a hanging robe —
 * and the asymmetry that makes its six views differ comes from the arms and the cowl's opening.
 * @param {number} gait 0..1 drift phase
 * @param {number} reach 0..1 how far the arms are thrown forward (a wind-up and a strike reach)
 * @returns {Mesh}
 */
function wraithMesh(gait, reach) {
  const m = createMesh();
  const phase = gait * Math.PI * 2;
  // TWO phases, a quarter cycle apart. With one, `sin(0)` and `sin(π)` are both zero and gait frames
  // 0 and 2 came out byte-identical: the wraith had a four-frame walk with two frames in it, which
  // reads as a stutter rather than as drifting. The hover rides the sine, the sway rides the cosine,
  // so all four frames are distinct and the motion still loops seamlessly.
  const drift = Math.sin(phase);
  const sway = Math.cos(phase);
  const hover = 2 + drift * 0.9;
  // Robe: a wide, ragged hem narrowing to the shoulders. The hem's radius breathes with the drift,
  // which at 240p is the whole of "it is floating".
  const hem = 10.5 + sway * 0.8;
  lathe(
    m,
    [
      [hem, hover],
      [9.6, hover + 4],
      [8.2, hover + 10],
      [7.2, hover + 17],
      [7, hover + 23],
      [7.6, hover + 28],
      [6.4, hover + 31],
    ],
    0,
    { segs: 18 },
  );
  // Shoulders and cowl. The cowl is swept only across the back and sides (`a0`/`a1`), so the front
  // of the hood is a genuine hole in the geometry rather than a dark-painted face — which is what
  // makes the two eyes inside it read as being *in* something.
  lathe(m, [[6.4, hover + 31], [7.4, hover + 34], [7, hover + 39], [4.4, hover + 43], [0, hover + 45]], 1, {
    segs: 16,
    a0: 0.55,
    a1: Math.PI * 2 - 0.55,
  });
  // The inner face of the cowl, so looking into it shows a lining rather than the world behind.
  lathe(m, [[0, hover + 33], [5, hover + 34.5], [5.4, hover + 39], [3.4, hover + 42]], 1, { segs: 14 });

  // Folds: thin ribs standing a little proud of the robe, running from the hem to the shoulder.
  // A lathe is radially symmetric, so without these the robe rasterises as ONE smooth gradient —
  // a flat blue-grey slab with a silhouette and nothing inside it. The ribs break the light into
  // vertical bands, which is what cloth looks like at this resolution.
  for (let k = 0; k < 7; k++) {
    // Spread across the front and sides only; the back of a robe nobody sees need not have folds.
    const a = -2.1 + (k / 6) * 4.2 + sway * 0.09;
    const sn = Math.sin(a);
    const cs = Math.cos(a);
    // Each fold leans a little, so they are not seven parallel stripes.
    const lean = ((k % 3) - 1) * 0.18;
    limb(
      m,
      [
        [sn * (hem - 0.6), hover + 1.5, cs * (hem - 0.6)],
        [sn * 8.6 + lean, hover + 11, cs * 8.6],
        [sn * 7.4 + lean * 1.6, hover + 21, cs * 7.4],
        [sn * 7.1, hover + 29, cs * 7.1],
      ],
      1.15,
      0,
    );
  }

  // Arms: out of the shoulders, forward and down, thrown out as it reaches.
  for (let side = 0; side < 2; side++) {
    const sx = side === 0 ? -1 : 1;
    // The two arms swing in opposition, and on the cosine, so an arm is at its extreme exactly when
    // the hover is at its middle — which is what makes the drift read as a gait rather than a bob.
    const swayY = sway * 1.4 * (side === 0 ? 1 : -1);
    const fz = reach * 11;
    limb(
      m,
      [
        [sx * 5.5, hover + 30, 1],
        [sx * (8.5 - reach * 1.5), hover + 24 + swayY + reach * 4, 3 + fz * 0.45],
        [sx * (9.4 - reach * 3), hover + 18 + swayY + reach * 9, 5.5 + fz],
      ],
      2.4,
      0,
    );
    // The hand: bigger than the first pass and pushed clear of the sleeve, which read as a pocket
    // sewn to the robe rather than as something reaching for you. Splayed fingers make the shape
    // read as a HAND at the half-dozen texels it occupies — a plain blob does not.
    const hx = sx * (9.6 - reach * 3.2);
    const hy = hover + 15.8 + swayY + reach * 9.6;
    const hz = 7.4 + fz * 1.1;
    limb(m, [[hx, hy + 2.2, hz - 1], [hx, hy, hz]], 2.1, 2);
    for (let f = 0; f < 3; f++) {
      const spread = (f - 1) * 1.9;
      limb(m, [[hx + spread * 0.6, hy - 0.4, hz + 0.4], [hx + spread, hy - 3.2, hz + 1.2]], 0.85, 2);
    }
  }
  return m;
}

// ─── Painting ────────────────────────────────────────────────────────────────────────────────

/**
 * Ramp picker for a creature: flat on the big smooth lathes, chunky-dithered elsewhere.
 *
 * Same reasoning as the oil flask's `oilPick` — a dither across a large curved body alternates two
 * ramp steps over the whole surface, and at the two or three screen pixels a texel covers that reads
 * as a checkerboard painted on the shell rather than as a gradient.
 * @param {Uint8Array} ramp
 * @param {number} t
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function creaturePick(ramp, t, x, y) {
  return ramp === RAMPS.chitin || ramp === RAMPS.shroud ? rampPickFlat(ramp, t) : rampPickChunky(ramp, t, x, y);
}

/**
 * Paint glowing eyes into a finished creature buffer.
 *
 * Eyes are painted rather than modelled on purpose: they are one or two texels each, they must land
 * on the silhouette's front whatever the yaw, and a modelled eye at this size is a dark dot. Painted
 * points from the `fire` / `arcane` ramps are a **light** in the sprite, which is what a player
 * actually tracks down a corridor.
 * @param {Uint8Array} buf
 * @param {number} cx texel column of the head centre (projected, not guessed — see `eyeAnchor`)
 * @param {number} cy texel row of the head centre
 * @param {number} spread texels between the two eyes, already foreshortened by the projection
 * @param {number} bright palette index of the core
 * @param {number} halo palette index of the surrounding bloom
 * @param {number} facing 0..1 how front-on the view is (eyes vanish as it turns away)
 * @returns {void}
 */
function paintEyes(buf, cx, cy, spread, bright, halo, facing) {
  if (facing <= 0.08) return;
  const half = Math.max(1, Math.round(spread * 0.5));
  for (let side = -1; side <= 1; side += 2) {
    const ex = Math.round(cx + side * half);
    // A ONE-texel core with a cross-shaped bloom — not the 3×3 block the first pass drew. At the
    // range a crawler is actually fought its card is magnified several times, and a 3×3 block of
    // flat fire became two glowing red *squares*: the creature read as having windows rather than
    // eyes. A point with arms is still a point when it is six screen pixels across.
    // The bloom is painted only over the creature itself, so an eye never spills into the
    // transparency key and leaves a dot floating beside the silhouette.
    for (const [dx, dy] of EYE_BLOOM) {
      const x = ex + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      if (buf[(y << 6) | x] === 0) continue;
      putClip(buf, x, y, halo);
    }
    if (buf[(cy << 6) | ex] !== 0 || facing > 0.6) putClip(buf, ex, cy, bright);
  }
}

/** Where an eye's bloom lands: the four orthogonal neighbours only, so the glow stays a point. */
const EYE_BLOOM = Object.freeze([[-1, 0], [1, 0], [0, -1], [0, 1]]);

/**
 * Sink a dark ellipse into the hood, so the cowl reads as an opening rather than as a dark hat.
 *
 * Painted over the creature only — never into the transparency key — so the hole stays inside the
 * silhouette however the hood is turned.
 * @param {Uint8Array} buf
 * @param {number} cx @param {number} cy centre, texels
 * @param {number} rx @param {number} ry radii, texels
 * @returns {void}
 */
function voidCowl(buf, cx, cy, rx, ry) {
  if (!(rx > 0.5) || !(ry > 0.5)) return;
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(SIZE - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(SIZE - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y << 6) | x;
      if (buf[i] === 0) continue;
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      // Black at the centre, the robe's own deepest shadow at the rim, so the hole has a lip.
      buf[i] = d > 0.55 ? C.shroudShadow : C.void;
    }
  }
}

/**
 * Tatter the bottom edge of a shape so a robe ends in rags rather than on a clean arc.
 * @param {Uint8Array} buf
 * @param {number} seed
 * @param {number} fromRow first row to erode
 * @returns {void}
 */
function tatterHem(buf, seed, fromRow, stipple) {
  for (let x = 0; x < SIZE; x++) {
    // How deep this column's rag is cut, from a smooth-ish noise so neighbouring columns agree.
    const cut = Math.floor(h01(x, 0, seed) * 5 + h01(x >> 1, 7, seed) * 3);
    for (let k = 0; k < cut; k++) {
      const y = fromRow + 6 - k;
      if (y < fromRow || y >= SIZE) continue;
      const i = (y << 6) | x;
      // Cut the robe, never the shadow underneath it: a stippled texel is the ground shadow's
      // penumbra, and eating it would leave the creature hovering over a hole.
      if (stipple[i] === 1) continue;
      buf[i] = 0;
    }
  }
}

/**
 * Rasterise one creature frame.
 * @param {'crawler'|'wraith'} kind
 * @param {number} yaw radians
 * @param {number} gait 0..1
 * @param {number} action 0..1 rear/reach
 * @param {number} seed
 * @param {number} tilt extra pitch, radians (a dying creature falls toward the camera)
 * @returns {Uint8Array}
 */
function paintCreature(kind, yaw, gait, action, seed, tilt, stipple) {
  const buf = new Uint8Array(AREA);
  const crawler = kind === 'crawler';
  const mesh = scaleMesh(
    crawler ? crawlerMesh(gait, action) : wraithMesh(gait, action),
    crawler ? CRAWLER_FILL : WRAITH_FILL,
  );
  renderMesh(
    mesh,
    crawler ? CRAWLER_MATS : WRAITH_MATS,
    {
      yaw,
      // Seen from a little above: the player's eye is half a tile up and these stand on the floor.
      // A dying creature is pitched further over, so it reads as falling rather than as shrinking.
      pitch: 0.2 + tilt,
      originRow: crawler ? CRAWLER_ORIGIN_ROW : WRAITH_ORIGIN_ROW,
      // Lit from high and to the left, matching the flask and the sconce, so a creature standing
      // beside a dropped flask is lit from the same place it is.
      light: [-0.55, 1, 0.5],
      // Self-shadowing on the crawler only: its legs and mandibles cross its own shell, which is
      // what makes a lump of chitin read as a body with limbs in front of it. The wraith is one
      // smooth robe with nothing to cast onto it, and the shadow map is the expensive half of a
      // frame's paint.
      shadows: crawler,
      outline: true,
      // A cast + contact shadow on the floor, exactly as the oil flask has (§4.5 `models.js`). The
      // first pass had none, and a creature with no contact shadow reads as *pasted onto* the
      // cobbles rather than standing on them — the single thing that most made these look like
      // sprites rather than things in the room.
      // `contact` is the solid core of the shadow, in MODEL texels — and the mesh has just been
      // scaled up to fill the card, so the first pass's 13 became a black slab wider than the
      // creature standing on it. A contact shadow should read as the dark where a body meets the
      // floor, never as a hole in it.
      ground: { index: SHADOW_INDEX, contact: crawler ? 7 : 5.5, stipple },
    },
    creaturePick,
    buf,
  );

  // How front-on this view is: 1 looking straight at the camera, 0 directly away. The mesh is built
  // facing +z (toward the eye at yaw 0), so this is just the cosine.
  const facing = Math.max(0, Math.cos(yaw));
  const pitch = 0.2 + tilt;
  if (crawler) {
    // Eye anchors are MODEL-space points run through the same projection the mesh was rasterised
    // with (`projectPoint`, §4.5 — the hook `textures.js` uses to hang the flame on the sconce).
    // The first pass guessed a texel row from a formula, and on the wraith the guess landed the eyes
    // in mid-air above the hood: a pair of cyan dots floating off the top of the creature.
    const lift = action * 5;
    const k = CRAWLER_FILL;
    const l = projectPoint(-3.2 * k, (7.5 + lift) * k, 12.5 * k, yaw, pitch, CRAWLER_ORIGIN_ROW);
    const r = projectPoint(3.2 * k, (7.5 + lift) * k, 12.5 * k, yaw, pitch, CRAWLER_ORIGIN_ROW);
    paintEyes(
      buf,
      Math.round((l.sx + r.sx) * 0.5),
      Math.round((l.sy + r.sy) * 0.5),
      Math.abs(r.sx - l.sx),
      C.fireCore,
      C.fireEmber,
      facing,
    );
  } else {
    tatterHem(buf, seed ^ 0x51aa, WRAITH_ORIGIN_ROW - 6, stipple);
    const k = WRAITH_FILL;
    const hover = 2 + Math.sin(gait * Math.PI * 2) * 0.9;
    // Just inside the mouth of the cowl, which is the one place on this creature a viewer looks.
    const eyeY = (hover + 37.5) * k;
    const l = projectPoint(-2.6 * k, eyeY, 3.6 * k, yaw, pitch, WRAITH_ORIGIN_ROW);
    const r = projectPoint(2.6 * k, eyeY, 3.6 * k, yaw, pitch, WRAITH_ORIGIN_ROW);
    const ex = (l.sx + r.sx) * 0.5;
    const ey = (l.sy + r.sy) * 0.5;
    // The cowl is a HOLE, and a hole has to be painted as one: a dark ellipse sunk into the hood
    // before the eyes go in. Without it the hood was a flat dark lump with two lights stuck on the
    // front, and the whole point of this creature is that you cannot see what is inside it.
    if (facing > 0.12) voidCowl(buf, ex, ey, 6.2 * k * facing, 4.6 * k);
    paintEyes(buf, Math.round(ex), Math.round(ey), Math.abs(r.sx - l.sx), C.arcPale, C.arcCyan, facing);
  }
  return buf;
}

// ─── The sword ───────────────────────────────────────────────────────────────────────────────

/**
 * The sword's anchor and its length, in texels.
 *
 * The origin is the pommel. It sits a little below the card so the fist is out of frame, but only a
 * little: pushing it to row 68 of a 64-row sprite spent every row on steel and took the crossguard
 * and grip with it, and what reached the screen was a blade sliding in from the corner with nothing
 * holding it. A sword reads as a sword because it has a guard. The swing rolls the whole thing about
 * this origin, so the tip traces a circle of radius `SWORD_REACH`, and 44 is the longest blade whose
 * point stays on the card across the whole arc — `enemies.test.mjs` pins it, because a pose that
 * clips is invisible as a bug and very visible as a sword with no point.
 */
const SWORD_ORIGIN_ROW = 61;
const SWORD_REACH = 44;

/** @type {import('./models.js').Material[]} */
const SWORD_MATS = [
  // 0 blade: bright, with a HARD NARROW specular. 0.92/1.3/0.62 parked the whole flat at the top of
  // the steel ramp and produced a paper-white shape with no form at all — the correction for a blade
  // that was too dark overshot into a blade that was not a solid. The ramp has seven steps; the
  // point of the material is to use several of them, with the glint confined to the edge.
  { ramp: RAMPS.steel, albedo: 0.66, spec: 1.5, shine: 52, ambient: 0.4 },
  // 1 fuller (the groove down the blade): the same metal, a step darker.
  { ramp: RAMPS.steel, albedo: 0.42, spec: 0.5, shine: 26, ambient: 0.3 },
  // 2 guard and pommel: brass.
  { ramp: RAMPS.gold, albedo: 0.78, spec: 0.7, shine: 20, ambient: 0.34 },
  // 3 grip: bound leather.
  { ramp: RAMPS.wood, albedo: 0.5, spec: 0.1, ambient: 0.3 },
];

/**
 * The sword, built pointing up the screen with its pommel at the model origin. The swing rolls and
 * slides the whole thing (see {@link rollMesh}), so the geometry itself never changes.
 * @returns {Mesh}
 */
function swordMesh() {
  const m = createMesh();
  // Blade: a flat tapered bar, four stacked boxes of narrowing width. A taper made of steps reads
  // as a taper at 64 texels and costs nothing; a lathe would make it round, and a round sword reads
  // as a pipe. It runs from the guard at 14 to the point at `SWORD_REACH`, so the steel is three
  // quarters of the sprite — the proportion that separates a sword from a dagger at a glance.
  box(m, -4.0, 14, -1.2, 4.0, 26, 1.2, 0);
  box(m, -3.6, 26, -1.05, 3.6, 36, 1.05, 0);
  box(m, -2.9, 36, -0.9, 2.9, SWORD_REACH - 6, 0.9, 0);
  box(m, -1.5, SWORD_REACH - 6, -0.6, 1.5, SWORD_REACH, 0.6, 0); // the point
  // Fuller: a shallow groove down the middle of the front face, so the flat is not a blank rectangle.
  box(m, -0.7, 16, 1.1, 0.7, SWORD_REACH - 10, 1.28, 1);
  // Crossguard. Narrow — a guard as wide as the blade is long reads as a crucifix, which is what
  // the first pass of this sprite looked like.
  box(m, -7.0, 11.5, -1.5, 7.0, 14.2, 1.5, 2);
  box(m, -8.2, 12.2, -1.2, -6.4, 16.5, 1.2, 2);
  box(m, 6.4, 12.2, -1.2, 8.2, 16.5, 1.2, 2);
  // Grip: long enough for two hands, bound leather, with a brass pommel under it.
  lathe(m, [[2.2, 0], [2.6, 1.8], [2.3, 5], [2.5, 9], [2.3, 12]], 3, { segs: 10, capBottom: true });
  lathe(m, [[0, -4.2], [2.8, -3.2], [3.6, -0.8], [2.7, 1.2], [0, 2]], 2, { segs: 12 });
  return m;
}

/**
 * Where the sword sits for one frame of the swing.
 *
 * The eight poses are the whole animation, and the shape of the list is the feel of the weapon:
 * one resting pose, two of the blade coming up and back (the wind-up the player learns to read),
 * two fast frames across the middle of the view, then three of it settling back — so the swing
 * accelerates into the cut and decelerates out of it rather than running at a constant rate.
 * `kick` is what the renderer adds on top as screen-space recoil.
 * @param {number} i 0…`SWORD_FRAMES`−1
 * @returns {{roll:number, dx:number, dy:number, yaw:number}}
 */
function swordPose(i) {
  /** @type {ReadonlyArray<readonly [number, number, number, number]>} */
  const poses = [
    // roll (radians, + = anticlockwise on screen), dx, dy (texels), yaw (how much of the flat is
    // turned toward the eye). Every one is chosen so the rolled tip and the quillons stay inside
    // the 64-texel card — `enemies.test.mjs` asserts it, because a pose that clips is invisible
    // as a bug and very visible as a sword with no point.
    [0.50, 16, -6, 0.5], // 0 rest: grip low-right, blade up across the view
    [0.28, 20, -10, 0.4], // 1 wind-up: drawn back and to the right
    [0.02, 23, -12, 0.3], // 2 wind-up peak: cocked upright, clear of the view
    [0.88, 12, -4, 0.6], // 3 strike: swept up and across the middle of the view
    [1.15, 16, 6, 0.85], // 4 follow-through: low and across, the flat turned to the eye
    [1.00, 17, 2, 0.8], // 5 recover
    [0.78, 17, -2, 0.65], // 6 recover
    [0.62, 16, -4, 0.55], // 7 recover, nearly home
  ];
  const p = poses[i < 0 ? 0 : i >= poses.length ? poses.length - 1 : i];
  return { roll: p[0], dx: p[1], dy: p[2], yaw: p[3] };
}

/**
 * Paint one sword pose.
 * @param {number} i frame
 * @param {Uint8Array} stipple out-param for the motion trail
 * @returns {Uint8Array}
 */
function paintSword(i, stipple) {
  const buf = new Uint8Array(AREA);
  const pose = swordPose(i);
  const mesh = rollMesh(swordMesh(), pose.roll, pose.dx, pose.dy);
  renderMesh(
    mesh,
    SWORD_MATS,
    {
      yaw: pose.yaw,
      pitch: 0.12,
      originRow: SWORD_ORIGIN_ROW,
      // Lit from the player's own torch: below and in front, which is the one light source the
      // first-person view actually has and the reason the blade's underside catches the most.
      light: [-0.35, 0.55, 1],
      shadows: true,
      outline: true,
    },
    (ramp, t, x, y) => (ramp === RAMPS.steel ? rampPickFlat(ramp, t) : rampPickChunky(ramp, t, x, y)),
    buf,
  );
  // A stippled arc trailing the two fast frames: half-shaded, like the flame's halo, so it reads as
  // speed rather than as a second blade.
  if (i === 3 || i === 4) trailArc(buf, stipple, i);
  return buf;
}

/**
 * Smear a half-shaded arc behind the blade on the frames where it is moving fastest.
 * @param {Uint8Array} buf
 * @param {Uint8Array} stipple
 * @param {number} frame
 * @returns {void}
 */
function trailArc(buf, stipple, frame) {
  // A SOLID tapering band, not a scatter. The first pass gated each texel on a hash and then
  // `renderWeapon` dropped every other screen pixel again for stippled texels — random scatter times
  // a 50 % screen stipple is white noise, and it read as dead pixels rather than as a swing. The
  // screen-space stipple alone is the translucency; this only has to describe the path.
  const pose = swordPose(frame);
  const cx = SIZE / 2 + pose.dx;
  const cy = SWORD_ORIGIN_ROW - pose.dy;
  const here = pose.roll;
  const from = swordPose(frame - 1).roll;
  const steps = 26;
  // Only the OUTER part of the blade leaves a smear, and only a couple of texels of it. Sweeping the
  // whole length across the whole arc fills a solid sector — which is what the first solid version
  // drew: a white wedge over a quarter of the screen that read as fog rather than as a blade. What a
  // fast blade actually leaves is a thin crescent trailing its tip.
  const inner = SWORD_REACH * 0.62;
  for (let k = 0; k <= steps; k++) {
    const u = k / steps;
    const a = from + (here - from) * u;
    const sn = Math.sin(a);
    const cs = Math.cos(a);
    // Brightest at the leading edge, dissolving back toward where the blade came from.
    const lead = u > 0.82;
    for (let r = inner; r < SWORD_REACH; r += 1) {
      const along = (r - inner) / (SWORD_REACH - inner);
      // One texel through most of it, two at the very tip.
      const thick = along > 0.72 ? 1 : 0;
      for (let w = -thick; w <= thick; w++) {
        const x = Math.round(cx - sn * r + cs * w);
        const y = Math.round(cy - cs * r - sn * w);
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        const i = (y << 6) | x;
        if (buf[i] !== 0) continue;
        buf[i] = lead ? C.steelPale : C.ironBase;
        stipple[i] = 1;
      }
    }
  }
}

// ─── Public surface ──────────────────────────────────────────────────────────────────────────

/**
 * Paint the whole combat art set (ARCHITECTURE.md §4.11).
 *
 * Called lazily — once per session, on the loading screen of the first New Descent floor — so a
 * Classic Descent session never pays for it. Deterministic for a given seed, in Node and in every
 * browser, exactly like `createTextures`.
 * @param {number} [seed]
 * @returns {CombatTextures}
 */
export function createCombatTextures(seed = 0xa11a2e) {
  const job = startCombatTextures(seed);
  while (!job.done) job.step(Infinity);
  return job.set;
}

/**
 * Begin painting the set, a few frames at a time.
 *
 * The whole set is ~130 ms of rasterising, and painting it in one go inside a simulation step froze
 * the main thread for 233 ms and lost eight steps the first time a player chose New Descent — against
 * this project's own rule that nothing discards a step in unthrottled play. So it is a **budgeted
 * job**, like the fog-of-war reveal and the map's rolling sweep: `main.js` spends a few frames of it
 * per step on the loading screen, which has an 800 ms floor to hide it behind, and the set is ready
 * before the first frame of play.
 *
 * `set` is filled in progressively and is safe to install at any point — a frame that has not been
 * painted yet is simply absent, and the renderer falls back to frame 0 — but `done` is what says
 * every pose exists.
 * @param {number} [seed]
 * @returns {{set: CombatTextures, done: boolean, step: (budget: number) => boolean, total: number, painted: number}}
 */
export function startCombatTextures(seed = 0xa11a2e) {
  const usedSeed = Number.isFinite(seed) ? Number(seed) : 0xa11a2e;
  const root = createRng(usedSeed);
  const fork = (/** @type {string} */ name) => root.fork(name).u32();
  const crawlerSeed = fork('crawler');
  const wraithSeed = fork('wraith');

  /** @type {CombatTextures} */
  const set = { seed: usedSeed, crawler: new Array(ENEMY_FRAME_COUNT), wraith: new Array(ENEMY_FRAME_COUNT), sword: new Array(SWORD_FRAMES) };
  // One flat list of thunks, so the budget is simply "how many of these to run".
  /** @type {Array<() => void>} */
  const work = [];
  for (const [kind, kseed] of /** @type {const} */ ([['crawler', crawlerSeed], ['wraith', wraithSeed]])) {
    for (let v = 0; v < ENEMY_VIEWS; v++) {
      const yaw = (v / ENEMY_VIEWS) * Math.PI * 2;
      for (let g = 0; g < ENEMY_FRAMES; g++) {
        const idx = enemyFrameIndex(v, -1, g);
        const gait = g / ENEMY_FRAMES;
        work.push(() => {
          set[kind][idx] = finishStippled((st) => paintCreature(kind, yaw, gait, 0, kseed, 0, st), false);
        });
      }
    }
    /** @type {Array<[number, number, number, number, number]>} */
    const poses = [
      [ENEMY_POSE.WIND, 0, 0, 0.55, 0],
      [ENEMY_POSE.STRIKE, 0, 0.5, 1, 0],
      [ENEMY_POSE.STAGGER, 0.35, 0.25, 0.2, -0.12],
      [ENEMY_POSE.DIE_A, 0.7, 0.5, 0.1, 0.45],
      [ENEMY_POSE.DIE_B, 1.1, 0.75, 0, 0.95],
    ];
    for (const [pose, yaw, gait, action, tilt] of poses) {
      const idx = enemyFrameIndex(0, pose);
      work.push(() => {
        set[kind][idx] = finishStippled((st) => paintCreature(kind, yaw, gait, action, kseed, tilt, st), false);
      });
    }
  }
  for (let i = 0; i < SWORD_FRAMES; i++) {
    work.push(() => {
      set.sword[i] = finishStippled((st) => paintSword(i, st), false);
    });
  }

  let cursor = 0;
  const job = {
    set,
    total: work.length,
    painted: 0,
    done: false,
    /**
     * Paint up to `budget` more frames.
     * @param {number} budget
     * @returns {boolean} true once every frame exists
     */
    step(budget) {
      const n = budget > 0 ? budget : 1;
      for (let k = 0; k < n && cursor < work.length; k++) work[cursor++]();
      job.painted = cursor;
      job.done = cursor >= work.length;
      return job.done;
    },
  };
  return job;
}
