// @ts-check
/**
 * @file Software raycaster: the whole 3-D view (ARCHITECTURE.md §4.5).
 *
 * A textured DDA raycaster drawing into a `Uint32Array` view of one `ImageData` at a low internal
 * resolution (height 240, width from the aspect ratio clamped to 320…560), upscaled by the browser
 * with `image-rendering: pixelated`. Everything is plain JS on typed arrays: no WebGL, no shaders,
 * works everywhere, and is pixel-exact for the retro look.
 *
 * ── Frame structure ───────────────────────────────────────────────────────────────────────────
 *   1. clear to fog            — guarantees a defined pixel even if a later pass skips it
 *   2. wall pass (per column)  — DDA, textured, fills the z-buffer and the wall span arrays
 *   3. floor + ceiling pass    — one perspective row walk serving *both* surfaces at once
 *   4. sprite pass             — items, portal, torch flames; back-to-front, z-tested, alpha-keyed
 *   5. particles               — embers and sparks, z-tested
 *   6. flash                   — full-screen additive tint, only when the view asks for one
 *
 * ── How the light works ───────────────────────────────────────────────────────────────────────
 * Shading never touches floating point per pixel. A **colormap** (Doom's trick) holds
 * `64 levels × 256 palette entries` of already-packed RGBA: level 63 is the texel lit warm and
 * full, level 0 is the cool blue-black fog colour, and the ramp between them is per-channel
 * gamma'd so shadows drift blue while highlights stay warm. Shading a pixel is therefore
 * `colormap[(level << 8) | paletteIndex]` — one lookup.
 *
 * The *level* is computed once per wall column and once per 12-pixel segment along each
 * floor/ceiling row, and interpolated in between — light is smooth, so that is indistinguishable
 * from evaluating it per pixel and an order of magnitude cheaper. It sums: a small ambient, the
 * player's torch (radius `lerp(2.5, 7, view.light)` with two octaves of flicker), and the nearest
 * eight wall torches as point lights. Each of those lights only the half-space in front of the
 * wall it is bolted to, which is what stops light leaking through masonry. The sum is multiplied
 * by a distance-fog LUT, and wall columns additionally fall off toward the floor and ceiling
 * (lights sit at eye height, so the edges of a wall are further from all of them than its middle).
 * A 4×4 Bayer value is added to the fixed-point level before truncation, dithering away the
 * banding that 64 discrete levels would otherwise show.
 *
 * ── Performance contract ──────────────────────────────────────────────────────────────────────
 * Zero allocations per frame: every buffer, light slot, sprite slot and camera struct is allocated
 * in `createRaycaster` or in `resize` and reused forever. `stats().ms` reports the measured render
 * time. The budget is < 4 ms at 480×240 on a desktop; the current build measures ≈1.3 ms there in
 * headless Chrome, with the floor/ceiling pass the dominant cost (it is the only pass that touches
 * every pixel of the frame).
 *
 * Coordinates: world units are tiles; `angle` 0 = +x (east), π/2 = +y (south), y grows downward
 * (screen-style), matching `src/core/types.js`.
 */

import { hash2, createRng } from '../core/rng.js';
import { DIR_DX, DIR_DY, TILE } from '../maze/constants.js';
import { C, LITTLE_ENDIAN, PALETTE_RGB, PALETTE_SIZE, pack } from './palette.js';
import { createTextures, SIZE as TEX } from './textures.js';
import { createParticles, PARTICLE, PARTICLE_COLORS } from './particles.js';
import { createSpriteIndex } from './sprite-index.js';

// ─── Tunables ──────────────────────────────────────────────────────────────────────────────────

/** Internal framebuffer height in pixels. Fixed: it *is* the art's pixel size. */
const INTERNAL_H = 240;

/** Internal width bounds. Narrower than 320 crops the view; wider than 560 costs fill rate. */
const MIN_W = 320;
const MAX_W = 560;

/** Shade levels in the colormap. 64 + ordered dither is indistinguishable from continuous. */
const LEVELS = 64;
const LEVEL_MAX = LEVELS - 1;

/** Colormap row stride. 256 lets the index be `(level << 8) | paletteIndex`. */
const CM_STRIDE = 256;

/** Maximum distance in tiles anything is drawn at. Fog has fully closed well before this. */
const FAR = 30;

/** DDA safety cap: a ray crossing 30 tiles diagonally touches ≈ 60 boundaries. */
const MAX_DDA_STEPS = 160;

/** Wall torches considered as point lights, nearest first (ARCHITECTURE §4.5). */
const MAX_LIGHTS = 8;

/**
 * Sprite slots.
 *
 * Sized against the worst neighbourhood measured on a real 128×128-cell level (the gameplay cap):
 * ~850 items + ~1300 torches, densest disc of radius `SPRITE_FAR` holding ~130 of them. 384 is
 * three times that, and the queue degrades by dropping the *farthest* sprite rather than the next
 * one offered (see `addSprite`), so even an overflow can only cost distant decoration.
 */
const MAX_SPRITES = 384;

/**
 * Radius in tiles inside which a billboard can still change a pixel.
 *
 * Derived, not guessed: a sprite's shade level is `illum × fog(d) × 63` truncated (sprites carry no
 * dither), the brightest thing any sprite is given is `illum = 1.25` (a gem), and level 0 of the
 * colormap *is* the fog colour — which is exactly what the frame was cleared to and what every
 * surface at that distance already shades to. So once `fog(d) × 1.3 × 63 < 1` a sprite can only
 * paint fog onto fog. Solving `exp(-(d/9)^1.9) < 1/(1.3×63)` gives ≈19.6 tiles; the margin below
 * rounds that up. Culling here instead of at `FAR` (30) shrinks the queried area by 2.2×.
 */
const SPRITE_FAR = (() => {
  for (let i = 0; i < 4096; i++) {
    const d = i * 0.02;
    if (Math.exp(-Math.pow(d / 9, 1.9)) * 1.3 * (LEVELS - 1) < 1) return Math.min(d + 1.5, FAR);
  }
  return FAR;
})();

/**
 * Positional slack, in tiles, between a torch's **bucket key** and the points derived from it.
 *
 * The spatial index buckets a torch by its tile centre, but its flame sprite sits `0.5 + 0.02`
 * outward and its light `0.5 + 0.22` outward. Queries widen by this so a torch whose derived point
 * falls inside the search radius can never be missed because its tile centre fell outside.
 */
const TORCH_SLACK = 0.75;

/**
 * Slack, in camera-plane units, on the horizontal frustum test in `inFrustum`.
 *
 * A billboard is on screen while `|tX| ≤ tY + height×scale/width`. The tallest sprite is the portal
 * (scale 0.95) and the narrowest internal buffer is 320×240, so that term never exceeds 0.72; 1.0
 * keeps the test conservative at every window shape.
 */
const FRUSTUM_MARGIN = 1;

/**
 * Pixels between full lighting evaluations along a floor/ceiling row. Light varies smoothly, so
 * the level is interpolated in between; 12 px is the point where the error disappears under the
 * ordered dither and the lighting cost stops dominating the pass.
 */
const LIGHT_SEG = 12;

/** Reach of one wall torch, tiles. */
const TORCH_RADIUS = 4.6;
const TORCH_RADIUS2 = TORCH_RADIUS * TORCH_RADIUS;
const INV_TORCH_RADIUS = 1 / TORCH_RADIUS;

/**
 * How far in front of its wall a torch's *light* sits, in tiles — the flame burns in the corridor,
 * not inside the masonry. It also has to be greater than zero for the wall the sconce is bolted to
 * to receive any light at all: the Lambert term for a point on that wall is exactly this offset
 * divided by the distance, so at zero the sconce would float in front of unlit stone.
 */
const TORCH_LIGHT_OFFSET = 0.22;

/** Light that exists with no torch at all, so unlit geometry is fog-blue rather than black. */
const AMBIENT = 0.055;

/** Player torch radius at `view.light` 0 and 1, tiles (ARCHITECTURE §4.5). */
const TORCH_MIN_R = 2.5;
const TORCH_MAX_R = 7;

/**
 * Ceiling on what the player's own torch alone can light a surface to.
 *
 * WHY it is below 1: the colormap's warm tint is concentrated in its top few levels, so whatever
 * reaches level 63 is what reads as "standing in firelight". Reserving that top fifth for the
 * *wall* torches is what gives them visible warm pools instead of being washed flat by the torch
 * the player is carrying — the reference's defining lighting cue.
 */
const PLAYER_TORCH_CEILING = 0.78;

/** Ceilings receive less bounce light than floors — torches are mounted below them. */
const CEIL_DIM = 0.72;

/** North/south wall faces are drawn darker; the classic raycaster cue that reads as form. */
const SIDE_SHADE = 0.76;

/** Head-bob amplitude in pixels at the internal resolution, at `bobAmp` 1. */
const BOB_PIXELS = 5;

/** Camera-shake amplitude in pixels at `shake` 1. */
const SHAKE_PIXELS = 7;

/** Shake also jitters yaw slightly, radians at `shake` 1. */
const SHAKE_YAW = 0.02;

/** Fog LUT resolution over [0, FAR] tiles. */
const FOG_LUT_N = 512;
const FOG_SCALE = FOG_LUT_N / FAR;
const FOG_LUT_MAX = FOG_LUT_N - 1;

/** Attenuation LUT resolution over [0, radius]. */
const ATT_LUT_N = 256;

/** Torch sprite stands this far in front of the wall face it is mounted on (ARCHITECTURE §4.5). */
const TORCH_OFFSET = 0.02;

/** Ambient embers emitted per second per visible torch. */
const EMBER_RATE = 2.6;

/** Sparkle motes emitted per second per nearby uncollected gem. */
const GEM_SPARKLE_RATE = 1.1;

/** Gems only twinkle within this distance, in tiles — beyond it the motes are sub-pixel. */
const GEM_SPARKLE_RANGE2 = 64;

/**
 * Walkable tile id, from the maze module's own vocabulary (§2 allows `src/renderer` to import
 * `src/maze/constants.js`, and only that file). The renderer treats **any non-floor tile as
 * solid**, so a tile id added later (door, secret wall) renders as a wall rather than as a hole in
 * the world while the rest of the engine catches up.
 */
const TILE_FLOOR = TILE.FLOOR;

/** 16.16 fixed point: one whole unit. */
const FX_ONE = 65536;

/**
 * Largest shade level in 16.16 fixed point. Levels are carried as fixed point so the inner loops
 * can interpolate and dither them with integer adds; `(level + dither) >> 16` is the shade row.
 */
const LEVEL_FX_MAX = (LEVEL_MAX << 16) - 1;

/** 4×4 Bayer thresholds pre-scaled to 16.16 of one shade level. */
const BAYER16 = Int32Array.from([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], (v) =>
  Math.round(((v + 0.5) / 16) * FX_ONE),
);

/** Channel shifts inside a packed pixel, for the flash pass. */
const SH_R = LITTLE_ENDIAN ? 0 : 24;
const SH_G = LITTLE_ENDIAN ? 8 : 16;
const SH_B = LITTLE_ENDIAN ? 16 : 8;
const ALPHA_MASK = LITTLE_ENDIAN ? 0xff000000 : 0x000000ff;

/** 1 / 2^32 — hash → [0,1). */
const INV_U32 = 2.3283064365386963e-10;

/**
 * Wall variant per tile: 16 buckets hashed from the tile coordinate. Plain stone dominates (half
 * the tiles), a third is weathered and cracked, and the mossy and vined walls are rare accents —
 * greenery reads as decoration only while it stays the exception, exactly as in the reference.
 */
const WALL_VARIANT = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 3);

/** Stand-ins for a view with no items/torches, so the index never sees `null` or a fresh `[]`. */
const EMPTY_ITEMS = /** @type {import('../core/types.js').Item[]} */ ([]);
const EMPTY_TORCHES = /** @type {import('../core/types.js').Torch[]} */ ([]);

// ─── Lookup-table construction ─────────────────────────────────────────────────────────────────

/**
 * Fill the 64×256 colormap.
 *
 * For shade level `t` ∈ [0,1] a texel becomes `colour × tint(t) × gamma(t) + fog × (1 − gamma(t))`.
 * The three channels use different gammas so darkness cools (blue survives longest) and light
 * warms — the reference's deep blue shadows and orange torchlight fall straight out of this.
 * @param {Uint32Array} out length `LEVELS * CM_STRIDE`
 * @returns {void}
 */
function buildColormap(out) {
  const fogR = PALETTE_RGB[C.fog * 3];
  const fogG = PALETTE_RGB[C.fog * 3 + 1];
  const fogB = PALETTE_RGB[C.fog * 3 + 2];
  const fogPacked = pack(fogR, fogG, fogB, 255);
  for (let l = 0; l < LEVELS; l++) {
    const t = l / LEVEL_MAX;
    // Per-channel gamma: red falls off fastest, blue slowest, so unlit stone drifts to the
    // reference's deep blue-grey instead of going neutral grey.
    const gR = Math.pow(t, 1.55);
    const gG = Math.pow(t, 1.35);
    const gB = Math.pow(t, 1.1);
    // Tint: what is bright in this game is bright because a *flame* is lighting it, so the top of
    // the ramp warms and the bottom cools. The `t²` curve concentrates the warmth in the last few
    // levels — right next to a torch — instead of bleaching the blue out of the stone everywhere,
    // which is what keeps lit walls reading as the reference's blue-grey masonry.
    const t2 = t * t;
    const tintR = 0.84 + 0.26 * t2;
    const tintG = 0.86 + 0.13 * t2;
    const tintB = 1.06 - 0.17 * t2;
    const base = l * CM_STRIDE;
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const r = PALETTE_RGB[i * 3] * tintR * gR + fogR * (1 - gR);
      const g = PALETTE_RGB[i * 3 + 1] * tintG * gG + fogG * (1 - gG);
      const b = PALETTE_RGB[i * 3 + 2] * tintB * gB + fogB * (1 - gB);
      out[base + i] = pack(r, g, b, 255);
    }
    // Slots past the palette can only be reached by a corrupt index; make them opaque fog rather
    // than transparent black so such a bug shows as a dark patch, never as a see-through hole.
    for (let i = PALETTE_SIZE; i < CM_STRIDE; i++) out[base + i] = fogPacked;
  }
}

/**
 * Distance → visibility. `exp(-(d/9)^1.9)`: barely any loss in the first couple of tiles, then a
 * fast close-down so a corridor reads as "the torch is all you have".
 * @param {Float32Array} out length `FOG_LUT_N`
 * @returns {void}
 */
function buildFogLut(out) {
  for (let i = 0; i < FOG_LUT_N; i++) {
    const d = i / FOG_SCALE;
    out[i] = Math.exp(-Math.pow(d / 9, 1.9));
  }
}

/**
 * Normalised distance → attenuation for a point light, `(1-t)^1.7` with a small unattenuated
 * core. Reaches exactly 0 at the radius, so a light can be culled by distance with no visible
 * edge.
 * @param {Float32Array} out length `ATT_LUT_N + 1`
 * @returns {void}
 */
function buildAttLut(out) {
  for (let i = 0; i <= ATT_LUT_N; i++) {
    const t = i / ATT_LUT_N;
    const k = t < 0.12 ? 1 : 1 - (t - 0.12) / 0.88;
    out[i] = Math.pow(k < 0 ? 0 : k, 1.7);
  }
}

/**
 * Smooth 1-D value noise over time — flame flicker, camera shake. Allocation-free and
 * deterministic for a given `t`, so two clients at the same sim time flicker identically.
 * @param {number} t
 * @param {number} seed
 * @returns {number} 0..1
 */
function tnoise(t, seed) {
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  const a = hash2(i, 0, seed) * INV_U32;
  const b = hash2(i + 1, 0, seed) * INV_U32;
  return a + (b - a) * s;
}

// ─── Public types ──────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {import('../core/types.js').RenderView} RenderView
 * @typedef {import('./textures.js').TextureSet} TextureSet
 * @typedef {import('./textures.js').Texture} Texture
 * @typedef {import('./particles.js').ParticleSystem} ParticleSystem
 */

/**
 * Per-frame timings and counters. The object is **reused** — read the fields, do not stash it.
 * @typedef {Object} RenderStats
 * @property {number} ms         last frame's render time in milliseconds
 * @property {number} msAvg      smoothed render time (≈20-frame moving average), milliseconds
 * @property {number} w          internal framebuffer width
 * @property {number} h          internal framebuffer height
 * @property {number} dpr        device pixel ratio last passed to `resize`
 * @property {number} sprites    sprites drawn last frame
 * @property {number} lights     wall torches used as point lights last frame
 * @property {number} particles  particles drawn last frame
 * @property {number} frames     frames rendered since construction
 */

/**
 * @typedef {Object} Raycaster
 * @property {(cssW:number, cssH:number, dpr:number) => void} resize
 * @property {(view:RenderView) => void} render
 * @property {() => RenderStats} stats
 * @property {{w:number, h:number}} internalSize  live object, updated by `resize`
 * @property {ParticleSystem} particles           effect pool; main.js spawns pickup bursts here
 * @property {TextureSet} textures                the painted set in use
 * @property {(set:TextureSet) => void} setTextures
 * @property {() => Float32Array} depth           per-column wall distance from the last frame
 * @property {() => {n:number, x:Float32Array, y:Float32Array}} lights  wall torches lighting the
 *   last frame (reused object and arrays; diagnostic)
 * @property {() => void} dispose
 */

/**
 * @typedef {Object} RaycasterOptions
 * @property {TextureSet} [textures]  reuse an already-painted set (skips ~15 ms of painting)
 * @property {number} [seed]          seed for the textures painted when `textures` is omitted
 */

// ─── Factory ───────────────────────────────────────────────────────────────────────────────────

/**
 * Create the renderer for a canvas.
 *
 * Fails soft: a canvas without a 2-D context (very old browser, lost context, a stub in a test)
 * yields a renderer whose `render` is a no-op and whose stats stay zero, instead of throwing
 * during boot.
 * @param {HTMLCanvasElement} canvas
 * @param {RaycasterOptions} [options]
 * @returns {Raycaster}
 */
export function createRaycaster(canvas, options) {
  const opts = options || {};
  /** @type {CanvasRenderingContext2D|null} */
  let ctx = null;
  try {
    ctx =
      canvas && typeof canvas.getContext === 'function'
        ? /** @type {CanvasRenderingContext2D|null} */ (canvas.getContext('2d', { alpha: false }))
        : null;
  } catch {
    ctx = null; // A canvas already bound to another context type throws; degrade to no-op.
  }

  /** @type {TextureSet} */
  let textures = opts.textures || createTextures(opts.seed);
  /** Seed used for per-tile variant hashing; stable per texture set. */
  let variantSeed = (textures.seed | 0) ^ 0x5eed;

  // ── Shade tables (built once; independent of resolution) ──
  const colormap = new Uint32Array(LEVELS * CM_STRIDE);
  buildColormap(colormap);
  const fogLut = new Float32Array(FOG_LUT_N);
  buildFogLut(fogLut);
  const attLut = new Float32Array(ATT_LUT_N + 1);
  buildAttLut(attLut);
  const fogPacked = colormap[C.fog]; // level 0 of any index is exactly the fog colour

  // ── Framebuffer state ──
  let width = 0;
  let height = 0;
  let dpr = 1;
  /** @type {ImageData|null} */
  let image = null;
  /** @type {Uint32Array} */
  let buf = new Uint32Array(0);

  // ── Per-column scratch, sized to MAX_W so `resize` never reallocates ──
  const zbuf = new Float32Array(MAX_W);
  const wallTop = new Int32Array(MAX_W);
  const wallBot = new Int32Array(MAX_W);

  // ── Light slots ──
  const lightX = new Float32Array(MAX_LIGHTS);
  const lightY = new Float32Array(MAX_LIGHTS);
  const lightNX = new Float32Array(MAX_LIGHTS);
  const lightNY = new Float32Array(MAX_LIGHTS);
  const lightPow = new Float32Array(MAX_LIGHTS);
  const lightD2 = new Float32Array(MAX_LIGHTS);
  let lightN = 0;
  /**
   * Largest squared distance among the slots currently held. Only meaningful once all
   * `MAX_LIGHTS` slots are full; it is the radius the ring search prunes against.
   */
  let lightWorstD2 = Infinity;
  /** Per-row subset of `light*`, refilled by `cullRowLights`. */
  const rowLights = new Int32Array(MAX_LIGHTS);
  /** The identity list `[0..MAX_LIGHTS)`, for callers that want every light. */
  const allLights = Int32Array.from({ length: MAX_LIGHTS }, (_, i) => i);

  // ── Sprite slots ──
  const sprX = new Float32Array(MAX_SPRITES);
  const sprY = new Float32Array(MAX_SPRITES);
  const sprScale = new Float32Array(MAX_SPRITES);
  const sprVOff = new Float32Array(MAX_SPRITES);
  const sprDist = new Float32Array(MAX_SPRITES);
  const sprLevel = new Int32Array(MAX_SPRITES);
  const sprOrder = new Int32Array(MAX_SPRITES);
  /** @type {Texture[]} reused slots; assignment only, never a fresh array */
  const sprTex = new Array(MAX_SPRITES);
  let sprN = 0;

  // ── Spatial index over the level's decoration ──
  // Rebuilt only when the level changes (see `syncIndexes`); every frame after that, the light and
  // sprite passes walk buckets near the camera instead of the whole level.
  const itemIndex = createSpriteIndex();
  const torchIndex = createSpriteIndex();
  /** @type {import('../core/types.js').Item[]} */
  let idxItems = EMPTY_ITEMS;
  /** @type {import('../core/types.js').Torch[]} */
  let idxTorches = EMPTY_TORCHES;
  /** Level identity last indexed. `null` forces a rebuild on the first real frame. */
  let idxMaze = /** @type {any} */ (null);
  let idxItemCount = -1;
  let idxTorchCount = -1;
  // Stable readers so `build` never allocates a closure. They read the *indexed* arrays, which are
  // assigned immediately before the build call.
  const readItemX = (/** @type {number} */ i) => idxItems[i].x;
  const readItemY = (/** @type {number} */ i) => idxItems[i].y;
  const readTorchX = (/** @type {number} */ i) => idxTorches[i].x + 0.5;
  const readTorchY = (/** @type {number} */ i) => idxTorches[i].y + 0.5;
  /** Bucket window of the current query, written by `queryCells`. */
  let qx0 = 0;
  let qy0 = 0;
  let qx1 = -1;
  let qy1 = -1;

  // ── Flash LUTs ──
  const flashR = new Uint8Array(256);
  const flashG = new Uint8Array(256);
  const flashB = new Uint8Array(256);
  /**
   * Cache key for the three flash LUTs: the packed (r,g,b,a) of the flash last built. It starts as
   * NaN rather than as a sentinel number because the key's byte-packing can legitimately produce
   * any 32-bit value — a full white flash at alpha 1 packs to exactly -1, which as a sentinel would
   * have left the tables zeroed and turned the screen black.
   */
  let flashKey = Number.NaN;

  // ── Particles ──
  const particles = createParticles(384);
  const emberRng = createRng(0x513f1a);
  let emberAcc = 0;
  let sparkleAcc = 0;
  /** Seconds since the previous frame, published for the sprite pass's emitters. */
  let frameDt = 0;

  /** @type {import('./particles.js').ParticleCamera} reused every frame */
  const partCam = {
    px: 0,
    py: 0,
    dirX: 1,
    dirY: 0,
    planeX: 0,
    planeY: 1,
    invDet: 1,
    horizon: 0,
    colormap,
    fogLut,
    fogScale: FOG_SCALE,
    fogLutMax: FOG_LUT_MAX,
  };

  // ── Camera state for the current frame ──
  let camX = 0;
  let camY = 0;
  let dirX = 1;
  let dirY = 0;
  let planeX = 0;
  let planeY = 1;
  /** Half the view width at unit distance — the camera plane's length. Set once per frame. */
  let planeLen = 1;
  let horizon = 0;
  let torchInvR = 1 / TORCH_MAX_R;
  let torchPower = 1;
  let lastTime = 0;

  /** @type {RenderStats} reused */
  const statsObj = {
    ms: 0,
    msAvg: 0,
    w: 0,
    h: 0,
    dpr: 1,
    sprites: 0,
    lights: 0,
    particles: 0,
    frames: 0,
  };

  /** Live object handed out once; mutated by `resize` so holders always see the truth. */
  const internalSize = { w: 0, h: 0 };

  const now =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now();

  // ── Resize ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Point the renderer at a new CSS size. The internal buffer keeps height `INTERNAL_H` whatever
   * the display or device-pixel ratio is — that fixed pixel size *is* the art direction, and it
   * is what makes the cost independent of the window size.
   * @param {number} cssW CSS pixels
   * @param {number} cssH CSS pixels
   * @param {number} devicePixelRatio recorded for diagnostics; the low-res buffer ignores it
   * @returns {void}
   */
  function resize(cssW, cssH, devicePixelRatio) {
    dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const aspect = cssW > 0 && cssH > 0 ? cssW / cssH : 16 / 9;
    let w = Math.round(INTERNAL_H * aspect);
    if (w < MIN_W) w = MIN_W;
    else if (w > MAX_W) w = MAX_W;
    w &= ~1; // even width keeps the centre of the screen at cameraX === 0 exactly
    statsObj.dpr = dpr;
    if (w === width && INTERNAL_H === height && image) return;

    width = w;
    height = INTERNAL_H;
    internalSize.w = width;
    internalSize.h = height;
    statsObj.w = width;
    statsObj.h = height;
    if (!ctx) return;
    canvas.width = width;
    canvas.height = height;
    image = ctx.createImageData(width, height);
    buf = new Uint32Array(image.data.buffer);
    buf.fill(fogPacked);
  }

  // ── Spatial index ───────────────────────────────────────────────────────────────────────────

  /**
   * Re-bucket the level's items and torches if — and only if — the level changed.
   *
   * There is no explicit level token on `RenderView`, so identity *is* the token: `src/main.js`
   * assigns `view.maze`, `view.items` and `view.torches` straight from `state.levelData`, which the
   * reducer swaps atomically on `levelReady`. Comparing the three array identities (plus their
   * lengths, in case a future producer mutates an array in place rather than replacing it) detects
   * a new level exactly, and costs five comparisons on every other frame.
   *
   * Item pickups do **not** invalidate the index: a taken item keeps its position and is skipped at
   * query time, so play never rebuilds anything.
   * @param {RenderView} view
   * @returns {void}
   */
  function syncIndexes(view) {
    const maze = view.maze;
    const items = view.items || EMPTY_ITEMS;
    const torches = view.torches || EMPTY_TORCHES;
    if (
      maze === idxMaze &&
      items === idxItems &&
      torches === idxTorches &&
      items.length === idxItemCount &&
      torches.length === idxTorchCount
    ) {
      return;
    }
    idxMaze = maze;
    idxItems = items;
    idxTorches = torches;
    idxItemCount = items.length;
    idxTorchCount = torches.length;
    itemIndex.build(items.length, readItemX, readItemY, maze.width, maze.height);
    torchIndex.build(torches.length, readTorchX, readTorchY, maze.width, maze.height);
  }

  /**
   * Clip the axis-aligned square `(cx±r, cy±r)` to `index`'s buckets, into `qx0…qy1`.
   *
   * Writing the window into closure variables rather than returning a rectangle is what keeps the
   * query allocation-free; the two callers read it immediately.
   * @param {import('./sprite-index.js').SpriteIndex} index
   * @param {number} cx tiles
   * @param {number} cy tiles
   * @param {number} r tiles
   * @returns {boolean} false when the square misses the grid entirely
   */
  function queryCells(index, cx, cy, r) {
    const inv = 1 / index.cell;
    qx0 = Math.floor((cx - r) * inv);
    qx1 = Math.floor((cx + r) * inv);
    qy0 = Math.floor((cy - r) * inv);
    qy1 = Math.floor((cy + r) * inv);
    if (qx0 < 0) qx0 = 0;
    if (qy0 < 0) qy0 = 0;
    if (qx1 > index.cols - 1) qx1 = index.cols - 1;
    if (qy1 > index.rows - 1) qy1 = index.rows - 1;
    // NaN camera coordinates make every comparison false, so test for a *valid* window positively.
    return qx1 >= qx0 && qy1 >= qy0;
  }

  // ── Lighting ────────────────────────────────────────────────────────────────────────────────

  /**
   * Pick the wall torches that matter this frame: the `MAX_LIGHTS` nearest to a point 2.5 tiles
   * *ahead* of the camera, so the lights that survive are the ones lighting what is on screen
   * rather than the one behind the player's shoulder.
   *
   * At the new scale a level carries up to `MAX_TORCHES` (4096) sconces, so this walks the spatial
   * index in **expanding rings** of buckets around the focus point instead of scanning them all.
   * Every bucket on ring `r` is at least `(r-1) × cell` from the focus (the focus can sit anywhere
   * inside its own bucket), so once eight lights are held and the eighth is nearer than that bound,
   * no later ring can improve the set and the search stops — typically after two or three rings.
   * The answer is identical to the exhaustive scan it replaces, just without the scan.
   * @param {RenderView} view
   * @param {number} time seconds
   * @returns {void}
   */
  function gatherLights(view, time) {
    lightN = 0;
    const torches = view.torches;
    const index = torchIndex;
    if (!torches || index.count === 0) return;
    const focusX = camX + dirX * 2.5;
    const focusY = camY + dirY * 2.5;
    const cell = index.cell;
    const cols = index.cols;
    const rows = index.rows;
    const cellStart = index.cellStart;
    const entries = index.entries;
    // Same hard cut as the exhaustive version: a torch further than this can reach nothing drawn.
    const maxR = TORCH_RADIUS + FAR;
    const maxR2 = maxR * maxR;
    let fcx = Math.floor(focusX / cell);
    let fcy = Math.floor(focusY / cell);
    if (!(fcx >= 0)) fcx = 0;
    else if (fcx > cols - 1) fcx = cols - 1;
    if (!(fcy >= 0)) fcy = 0;
    else if (fcy > rows - 1) fcy = rows - 1;
    lightWorstD2 = Infinity;
    const maxRing = (cols > rows ? cols : rows) + 1;

    for (let r = 0; r <= maxRing; r++) {
      // Lower bound on the distance from the focus to anything in this ring or any ring beyond it.
      const ringMin = (r - 1) * cell - TORCH_SLACK;
      if (ringMin > 0) {
        if (ringMin > maxR) break;
        if (lightN >= MAX_LIGHTS && ringMin * ringMin >= lightWorstD2) break;
      }
      const cx0 = fcx - r;
      const cx1 = fcx + r;
      const cy0 = fcy - r;
      const cy1 = fcy + r;
      // Once the ring encloses the whole grid there is nothing further out to find.
      if (r > 0 && cx0 < 0 && cy0 < 0 && cx1 >= cols && cy1 >= rows) break;

      const yFrom = cy0 < 0 ? 0 : cy0;
      const yTo = cy1 > rows - 1 ? rows - 1 : cy1;
      for (let cy = yFrom; cy <= yTo; cy++) {
        const rowBase = cy * cols;
        if (cy === cy0 || cy === cy1) {
          // Top/bottom edge of the ring: every bucket in the row belongs to it.
          const xFrom = cx0 < 0 ? 0 : cx0;
          const xTo = cx1 > cols - 1 ? cols - 1 : cx1;
          for (let cx = xFrom; cx <= xTo; cx++) {
            scanLightBucket(cellStart, entries, torches, rowBase + cx, focusX, focusY, maxR2, time);
          }
        } else {
          // Interior row: only the two side buckets are new this ring.
          if (cx0 >= 0) {
            scanLightBucket(cellStart, entries, torches, rowBase + cx0, focusX, focusY, maxR2, time);
          }
          if (cx1 < cols && cx1 !== cx0) {
            scanLightBucket(cellStart, entries, torches, rowBase + cx1, focusX, focusY, maxR2, time);
          }
        }
      }
    }
  }

  /**
   * Offer every torch in one index bucket to the light slots.
   * @param {Int32Array} cellStart
   * @param {Int32Array} entries
   * @param {import('../core/types.js').Torch[]} torches
   * @param {number} c bucket index
   * @param {number} focusX
   * @param {number} focusY
   * @param {number} maxR2 squared cut-off distance
   * @param {number} time seconds
   * @returns {void}
   */
  function scanLightBucket(cellStart, entries, torches, c, focusX, focusY, maxR2, time) {
    const to = cellStart[c + 1];
    for (let k = cellStart[c]; k < to; k++) {
      considerLight(torches[entries[k]], focusX, focusY, maxR2, time);
    }
  }

  /**
   * Offer one torch to the eight light slots, updating `lightWorstD2`.
   * @param {import('../core/types.js').Torch} t
   * @param {number} focusX
   * @param {number} focusY
   * @param {number} maxR2 squared cut-off distance
   * @param {number} time seconds
   * @returns {void}
   */
  function considerLight(t, focusX, focusY, maxR2, time) {
    // `Torch.face` uses the maze module's direction numbering (0=E, 1=S, 2=W, 3=N), so its
    // tables give the outward normal of the mounting wall face directly. `& 3` keeps a malformed
    // face from indexing off the end.
    const face = (t.face | 0) & 3;
    const nx = DIR_DX[face];
    const ny = DIR_DY[face];
    const lx = t.x + 0.5 + nx * (0.5 + TORCH_LIGHT_OFFSET);
    const ly = t.y + 0.5 + ny * (0.5 + TORCH_LIGHT_OFFSET);
    const dx = lx - focusX;
    const dy = ly - focusY;
    const d2 = dx * dx + dy * dy;
    if (d2 > maxR2) return;

    // Insertion into the fixed slot array: no allocation, and `lightN` is at most 8 so rescanning
    // for the farthest entry is cheaper than maintaining a heap.
    let slot;
    if (lightN < MAX_LIGHTS) {
      slot = lightN++;
    } else {
      let worst = 0;
      for (let k = 1; k < MAX_LIGHTS; k++) if (lightD2[k] > lightD2[worst]) worst = k;
      if (lightD2[worst] <= d2) return;
      slot = worst;
    }
    lightX[slot] = lx;
    lightY[slot] = ly;
    lightNX[slot] = nx;
    lightNY[slot] = ny;
    lightD2[slot] = d2;
    // Each torch flickers on its own phase, seeded from its tile so it is stable frame to frame.
    const phase = (t.x * 7 + t.y * 13) & 63;
    lightPow[slot] = 0.85 + 0.32 * tnoise(time * 6.2 + phase, 0x71c5);

    if (lightN < MAX_LIGHTS) {
      lightWorstD2 = Infinity;
      return;
    }
    let w = lightD2[0];
    for (let k = 1; k < MAX_LIGHTS; k++) if (lightD2[k] > w) w = lightD2[k];
    lightWorstD2 = w;
  }

  /**
   * Illumination of a flat (floor/ceiling) surface point, considering only the lights in `list`.
   *
   * The caller passes a pre-culled list because this runs once per 12-pixel segment of every
   * floor/ceiling row — several thousand times a frame — and most lights are irrelevant to any
   * given row (see `cullRowLights`).
   * @param {number} wx world x
   * @param {number} wy world y
   * @param {Int32Array} list light indices
   * @param {number} n entries in `list`
   * @returns {number} 0..1 before fog
   */
  function illumFlat(wx, wy, list, n) {
    const dx = wx - camX;
    const dy = wy - camY;
    const d = Math.sqrt(dx * dx + dy * dy);
    let t = d * torchInvR;
    if (t > 1) t = 1;
    let illum = AMBIENT + attLut[(t * ATT_LUT_N) | 0] * torchPower;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      const lx = lightX[i] - wx;
      const ly = lightY[i] - wy;
      const d2 = lx * lx + ly * ly;
      if (d2 > TORCH_RADIUS2) continue;
      // Occlusion model: a torch lights the half-space in front of the wall it is mounted on and
      // nothing behind it. Testing against the *wall plane* (not against the light position) is
      // what lets the mounting wall itself be lit while the corridor on the far side stays dark.
      if (lx * lightNX[i] + ly * lightNY[i] > TORCH_LIGHT_OFFSET) continue;
      const dl = Math.sqrt(d2);
      illum += attLut[(dl * INV_TORCH_RADIUS * ATT_LUT_N) | 0] * lightPow[i];
    }
    return illum > 1 ? 1 : illum;
  }

  /**
   * Narrow the frame's lights down to the ones that can reach a floor/ceiling row.
   *
   * A row is a straight segment in world space, so a light matters only if it lies within
   * `TORCH_RADIUS` of that segment. Testing eight lights once per row (about 2 000 cheap tests a
   * frame) removes them from the per-segment inner loop, where they would cost twenty times more.
   * @param {number} ax segment start x
   * @param {number} ay segment start y
   * @param {number} bx segment end x
   * @param {number} by segment end y
   * @returns {number} number of entries written into `rowLights`
   */
  function cullRowLights(ax, ay, bx, by) {
    const ex = bx - ax;
    const ey = by - ay;
    const len2 = ex * ex + ey * ey;
    const invLen2 = len2 > 1e-9 ? 1 / len2 : 0;
    let n = 0;
    for (let i = 0; i < lightN; i++) {
      const px = lightX[i] - ax;
      const py = lightY[i] - ay;
      // Clamped projection onto the segment, then the perpendicular distance from it.
      let t = (px * ex + py * ey) * invLen2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const qx = px - ex * t;
      const qy = py - ey * t;
      if (qx * qx + qy * qy <= TORCH_RADIUS2) rowLights[n++] = i;
    }
    return n;
  }

  /**
   * Illumination of a wall point with outward normal `(nx, ny)`. Adds a Lambert term so a face
   * lit edge-on stays dark — without it, corridors look like flat cutouts.
   * @param {number} wx world x
   * @param {number} wy world y
   * @param {number} nx normal x (-1, 0 or 1)
   * @param {number} ny normal y (-1, 0 or 1)
   * @returns {number} 0..1 before fog
   */
  function illumWall(wx, wy, nx, ny) {
    const dx = camX - wx;
    const dy = camY - wy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const inv = d > 1e-4 ? 1 / d : 0;
    let lam = (dx * inv * nx + dy * inv * ny) * 0.4 + 0.6;
    if (lam < 0) lam = 0;
    let t = d * torchInvR;
    if (t > 1) t = 1;
    let illum = AMBIENT + attLut[(t * ATT_LUT_N) | 0] * torchPower * lam;
    for (let i = 0; i < lightN; i++) {
      const lx = lightX[i] - wx;
      const ly = lightY[i] - wy;
      const d2 = lx * lx + ly * ly;
      if (d2 > TORCH_RADIUS2) continue;
      // In front of the plane the sconce is mounted on? (see illumFlat)
      if (lx * lightNX[i] + ly * lightNY[i] > TORCH_LIGHT_OFFSET) continue;
      const dl = Math.sqrt(d2);
      const li = dl > 1e-4 ? 1 / dl : 0;
      // Lambert: a face turned away from the flame stays dark, which is what makes a corner read.
      let face = (lx * li * nx + ly * li * ny) * 0.82 + 0.18;
      if (face <= 0) continue;
      if (face > 1) face = 1;
      illum += attLut[(dl * INV_TORCH_RADIUS * ATT_LUT_N) | 0] * lightPow[i] * face;
    }
    return illum > 1 ? 1 : illum;
  }

  /**
   * Convert an illumination and a distance into a clamped 16.16 shade level.
   * @param {number} illum 0..1
   * @param {number} dist tiles from the eye
   * @param {number} scale extra multiplier (side shading, ceiling dimming)
   * @returns {number} level in [0, LEVEL_FX_MAX]
   */
  function levelFx(illum, dist, scale) {
    let fi = (dist * FOG_SCALE) | 0;
    if (fi < 0) fi = 0;
    else if (fi > FOG_LUT_MAX) fi = FOG_LUT_MAX;
    const v = illum * fogLut[fi] * scale;
    const fx = (v * LEVEL_MAX * FX_ONE) | 0;
    // A NaN here would poison a whole column, so clamp with a comparison that NaN fails.
    return fx > 0 ? (fx > LEVEL_FX_MAX ? LEVEL_FX_MAX : fx) : 0;
  }

  // ── Wall pass ───────────────────────────────────────────────────────────────────────────────

  /**
   * DDA-cast one column per screen x, draw the textured wall strip, and record the depth and the
   * wall's vertical span for the floor/ceiling pass.
   * @param {RenderView} view
   * @returns {void}
   */
  function renderWalls(view) {
    const maze = view.maze;
    const tiles = maze.tiles;
    const mw = maze.width;
    const mh = maze.height;
    const w = width;
    const h = height;
    const invW = 1 / w;
    const startMapX = Math.floor(camX);
    const startMapY = Math.floor(camY);
    const wallTex = textures.wall;

    for (let x = 0; x < w; x++) {
      const cameraX = 2 * x * invW - 1;
      const rdx = dirX + planeX * cameraX;
      const rdy = dirY + planeY * cameraX;

      // 1e30 rather than Infinity: `0 * Infinity` is NaN, and a player standing exactly on a tile
      // edge makes that product happen. A huge finite number keeps every later step finite.
      const ddx = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
      const ddy = rdy === 0 ? 1e30 : Math.abs(1 / rdy);

      let mapX = startMapX;
      let mapY = startMapY;
      let stepX;
      let stepY;
      let sdx;
      let sdy;
      if (rdx < 0) {
        stepX = -1;
        sdx = (camX - mapX) * ddx;
      } else {
        stepX = 1;
        sdx = (mapX + 1 - camX) * ddx;
      }
      if (rdy < 0) {
        stepY = -1;
        sdy = (camY - mapY) * ddy;
      } else {
        stepY = 1;
        sdy = (mapY + 1 - camY) * ddy;
      }

      let side = 0;
      let hit = false;
      for (let steps = 0; steps < MAX_DDA_STEPS; steps++) {
        if (sdx < sdy) {
          sdx += ddx;
          mapX += stepX;
          side = 0;
        } else {
          sdy += ddy;
          mapY += stepY;
          side = 1;
        }
        if (mapX < 0 || mapY < 0 || mapX >= mw || mapY >= mh) break; // left the map
        if ((side === 0 ? sdx - ddx : sdy - ddy) > FAR) break; // beyond the fog
        if (tiles[mapY * mw + mapX] !== TILE_FLOOR) {
          hit = true;
          break;
        }
      }

      if (!hit) {
        // Open sky (only reachable in an unsealed map): no wall, all floor and ceiling.
        zbuf[x] = FAR;
        wallTop[x] = h;
        wallBot[x] = -1;
        continue;
      }

      // Perpendicular distance without a division — and clamped with comparisons that NaN fails,
      // which is what guarantees the z-buffer never holds a NaN (see raycaster.test.mjs).
      let dist = side === 0 ? sdx - ddx : sdy - ddy;
      if (!(dist > 0.0001)) dist = 0.0001;
      else if (dist > FAR) dist = FAR;
      zbuf[x] = dist;

      // Texture column: where along the wall face the ray landed.
      let wallX = side === 0 ? camY + dist * rdy : camX + dist * rdx;
      wallX -= Math.floor(wallX);
      let texX = (wallX * TEX) | 0;
      // Mirror two of the four facings so neighbouring faces of the same block agree.
      if (side === 0 ? rdx > 0 : rdy < 0) texX = TEX - 1 - texX;
      if (texX < 0) texX = 0;
      else if (texX >= TEX) texX = TEX - 1;

      const nx = side === 0 ? -stepX : 0;
      const ny = side === 1 ? -stepY : 0;
      const hitX = camX + dist * rdx + nx * 0.02;
      const hitY = camY + dist * rdy + ny * 0.02;
      const shade = side === 1 ? SIDE_SHADE : 1;
      const illum = illumWall(hitX, hitY, nx, ny);
      const lvl = levelFx(illum, dist, shade);
      // Vertical falloff. Lights live at eye height, so the top and bottom of a wall are further
      // from every one of them than its middle is: the extra distance for a point half a tile off
      // centre is `0.5/dist` in relative terms, and applying that as an inverse-square factor is
      // what stops a near wall reading as one flat rectangle of colour. The effect vanishes with
      // distance on its own, which is exactly right.
      const edgeFactor = 1 / (1 + 1.2 * (0.25 / (dist * dist)));
      const lvlEdge = levelFx(illum * edgeFactor, dist, shade);
      const drop = lvl - lvlEdge;

      // One hash per column serves two purposes: which wall variant this tile wears, and a
      // per-tile horizontal texture offset. The offset is what stops a corridor looking like the
      // same photograph repeated — the block courses still line up, but the joints no longer do.
      const hv = hash2(mapX, mapY, variantSeed);
      const tIdx = wallTex[WALL_VARIANT[hv & 15]].indices;
      // A third use of the same hash: mirror the course horizontally on half the tiles. Four wall
      // paintings across 64 offsets already gave plenty of variety in a 13-tile corridor; at 257
      // tiles the eye starts to recognise individual blocks, and mirroring doubles the vocabulary
      // for one comparison per column — far cheaper than painting more textures, and it cannot
      // break the tiling, because the offset above has already displaced every joint anyway.
      if (hv & 0x100000) texX = TEX - 1 - texX;
      texX = (texX + ((hv >>> 8) & (TEX - 1))) & (TEX - 1);

      const lineH = h / dist;
      const topF = horizon - lineH * 0.5;
      let y0 = topF < 0 ? 0 : topF | 0;
      let y1 = (horizon + lineH * 0.5) | 0;
      if (y1 > h) y1 = h;
      wallTop[x] = y0;
      wallBot[x] = y1 - 1;
      if (y1 <= y0) continue;

      // 16.16 texture walk: `stepTex` texels per screen row, starting at the wall's true top even
      // when that is off-screen.
      const stepTex = TEX / lineH;
      const stepFx = (stepTex * FX_ONE) | 0;
      const bayerCol = x & 3;
      // Level ramp for the vertical falloff, in level units per screen row. The column is drawn in
      // two runs — above and below the horizon — because the ramp mirrors there; writing it as two
      // runs of one loop body keeps a per-pixel `abs` (and a branch) out of the inner loop.
      // The upper half falls off harder than the lower half: the ceiling is timber and unlit, the
      // floor bounces the torch back, and the reference shows exactly that asymmetry.
      const rampUp = lineH > 1 ? ((drop * 1.3) / (lineH * 0.5)) | 0 : 0;
      const rampDown = lineH > 1 ? ((drop * 0.7) / (lineH * 0.5)) | 0 : 0;
      for (let run = 0; run < 2; run++) {
        const from = run === 0 ? y0 : horizon > y0 ? horizon : y0;
        const to = run === 0 ? (horizon < y1 ? horizon : y1) : y1;
        if (to <= from) continue;
        let texPos = ((from - topF) * stepTex * FX_ONE) | 0;
        const rampStep = run === 0 ? rampUp : rampDown;
        // Start at the level this row has, then walk toward (run 0) or away from (run 1) the peak.
        let cur = lvl - (run === 0 ? horizon - from : from - horizon) * rampStep;
        const curStep = run === 0 ? rampStep : -rampStep;
        let pi = from * w + x;
        for (let y = from; y < to; y++) {
          const ty = (texPos >> 16) & (TEX - 1);
          texPos += stepFx;
          // `(level + dither) >> 16 << 8` is the colormap row; the palette index picks the column.
          let level = (cur + BAYER16[((y & 3) << 2) | bayerCol]) >> 16;
          if (level < 0) level = 0;
          else if (level > LEVEL_MAX) level = LEVEL_MAX;
          buf[pi] = colormap[(level << 8) | tIdx[(ty << 6) | texX]];
          cur += curStep;
          pi += w;
        }
      }
    }
  }

  // ── Floor + ceiling pass ────────────────────────────────────────────────────────────────────

  /**
   * Perspective-correct floor and ceiling.
   *
   * WHY one loop for both: with the eye at exactly half the room height, the floor row `horizon+d`
   * and the ceiling row `horizon-1-d` sample the *same* world point at the *same* distance. One
   * world-space walk therefore feeds two rows, halving the most expensive pass in the frame.
   * @returns {void}
   */
  function renderFlats() {
    const w = width;
    const h = height;
    const posZ = 0.5 * h;
    const ray0X = dirX - planeX;
    const ray0Y = dirY - planeY;
    const ray1X = dirX + planeX;
    const ray1Y = dirY + planeY;
    const spanX = (ray1X - ray0X) / w;
    const spanY = (ray1Y - ray0Y) / w;
    const floorTex = textures.floor;
    const ceilTex = textures.ceiling;
    const maxD = (horizon > h - horizon ? horizon : h - horizon) | 0;

    for (let d = 0; d < maxD; d++) {
      const yF = horizon + d;
      const yC = horizon - 1 - d;
      const onF = yF >= 0 && yF < h;
      const onC = yC >= 0 && yC < h;
      if (!onF && !onC) continue;

      const rowDist = posZ / (d + 0.5);
      if (rowDist > FAR) continue; // already fog; the frame was cleared to exactly that colour

      const stepX = rowDist * spanX;
      const stepY = rowDist * spanY;
      let wx = camX + rowDist * ray0X;
      let wy = camY + rowDist * ray0Y;
      const fxStep = Math.round(stepX * FX_ONE);
      const fyStep = Math.round(stepY * FX_ONE);
      let fx = Math.floor(wx * FX_ONE);
      let fy = Math.floor(wy * FX_ONE);

      const rowF = yF * w;
      const rowC = yC * w;
      const bayerF = (yF & 3) << 2;
      const bayerC = (yC & 3) << 2;
      // Off-screen rows are handled by poisoning the comparison rather than by a per-pixel flag:
      // `wallBot` is ≥ -1 and `wallTop` is ≤ h, so these values can never pass the test.
      const yFc = onF ? yF : -1;
      const yCc = onC ? yC : h;

      const rowN = cullRowLights(wx, wy, wx + stepX * w, wy + stepY * w);

      // Cache the tile the row is currently over: the variant hash is far too expensive per pixel
      // but changes only when the walk crosses a tile boundary.
      let lastCX = 0x7fffffff;
      let lastCY = 0x7fffffff;
      /** @type {Uint8Array} */
      let fIdx = floorTex[0].indices;
      /** @type {Uint8Array} */
      let cIdx = ceilTex[0].indices;
      /**
       * Per-tile XOR applied to the floor's texel index. Because the index is `(v << 6) | u` with
       * both fields 6 bits, XOR-ing with `(63 << 6)` flips v and `63` flips u — so one mask gives
       * the four dihedral flips of a cobble tile for a single operation per pixel. Two cobble
       * paintings became eight looks, which is what stops a 257-tile floor reading as wallpaper.
       * The ceiling is deliberately left unflipped: its beams have to stay aligned across tiles.
       */
      let flatMask = 0;

      let segStart = 0;
      let illum = illumFlat(wx, wy, rowLights, rowN);
      let levF = levelFx(illum, rowDist, 1);
      let levC = levelFx(illum, rowDist, CEIL_DIM);
      while (segStart < w) {
        let segEnd = segStart + LIGHT_SEG;
        if (segEnd > w) segEnd = w;
        const n = segEnd - segStart;
        const ex = wx + stepX * n;
        const ey = wy + stepY * n;
        const illum2 = illumFlat(ex, ey, rowLights, rowN);
        const levF2 = levelFx(illum2, rowDist, 1);
        const levC2 = levelFx(illum2, rowDist, CEIL_DIM);
        // Light is smooth; interpolating it across the segment is indistinguishable from
        // evaluating it per pixel and an order of magnitude cheaper.
        const slopeF = ((levF2 - levF) / n) | 0;
        const slopeC = ((levC2 - levC) / n) | 0;

        for (let x = segStart; x < segEnd; x++) {
          const drawF = yFc > wallBot[x];
          const drawC = yCc < wallTop[x];
          // Pixels hidden behind a wall skip the tile lookup entirely and only pay the walk.
          if (drawF || drawC) {
            const cx = fx >> 16;
            const cy = fy >> 16;
            if (cx !== lastCX || cy !== lastCY) {
              lastCX = cx;
              lastCY = cy;
              const hv = hash2(cx, cy, variantSeed);
              // 1 tile in 16 is an iron grate, as in the reference's entrance hall.
              fIdx = floorTex[(hv & 15) === 5 ? 2 : (hv >>> 4) & 1].indices;
              // Beams every third row of tiles read as structure rather than as noise.
              cIdx = ceilTex[cy - 3 * Math.floor(cy / 3) === 0 ? 1 : 0].indices;
              flatMask = ((hv >>> 20) & 1 ? 63 << 6 : 0) | ((hv >>> 21) & 1 ? 63 : 0);
            }
            const ti = (((fy >> 10) & 63) << 6) | ((fx >> 10) & 63);
            if (drawF) {
              buf[rowF + x] =
                colormap[(((levF + BAYER16[bayerF | (x & 3)]) >> 16) << 8) | fIdx[ti ^ flatMask]];
            }
            if (drawC) {
              buf[rowC + x] = colormap[(((levC + BAYER16[bayerC | (x & 3)]) >> 16) << 8) | cIdx[ti]];
            }
          }
          fx += fxStep;
          fy += fyStep;
          levF += slopeF;
          levC += slopeC;
        }

        wx = ex;
        wy = ey;
        levF = levF2;
        levC = levC2;
        segStart = segEnd;
      }
    }
  }

  // ── Sprites ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Queue one billboard.
   *
   * When the slot array is full the **farthest** queued sprite is evicted rather than the new one
   * dropped. That ordering matters at the new scale: torches are queued before items, and a level
   * with ~1300 sconces used to fill the queue with distant flames and then silently discard the gem
   * at the player's feet. Eviction costs a scan of the slots, but only in an overflow the sizing of
   * `MAX_SPRITES` makes rare, and it turns "the pickup vanished" into "a speck in the fog vanished".
   * @param {number} x world x
   * @param {number} y world y
   * @param {Texture} tex
   * @param {number} scale world height in tiles
   * @param {number} vOff world-space vertical offset; positive moves the sprite *down*
   * @param {number} level 16.16 shade level
   * @param {number} dist2 squared distance from the camera, for sorting
   * @returns {void}
   */
  function addSprite(x, y, tex, scale, vOff, level, dist2) {
    let i;
    if (sprN < MAX_SPRITES) {
      i = sprN++;
    } else {
      let worst = 0;
      for (let k = 1; k < MAX_SPRITES; k++) if (sprDist[k] > sprDist[worst]) worst = k;
      if (sprDist[worst] <= dist2) return;
      i = worst;
    }
    sprX[i] = x;
    sprY[i] = y;
    sprTex[i] = tex;
    sprScale[i] = scale;
    sprVOff[i] = vOff;
    sprLevel[i] = level;
    sprDist[i] = dist2;
    sprOrder[i] = i;
  }

  /**
   * Would a billboard at this camera-relative offset put anything on screen?
   *
   * A sprite outside the horizontal frustum is invisible, but it would still be queued, shaded and
   * carried through the distance sort. At the new scale the camera sits inside a disc holding
   * ~130 sprites while the 90°-ish view shows a quarter of them, so this test is what keeps the
   * sort small. The horizontal bound is exact up to `FRUSTUM_MARGIN`, which covers the widest
   * sprite (the portal) at the narrowest internal aspect — it can over-accept, never over-reject.
   * @param {number} dx world x minus camera x
   * @param {number} dy world y minus camera y
   * @returns {boolean}
   */
  function inFrustum(dx, dy) {
    // `tY` here is exactly `renderSprites`' depth term: with the plane perpendicular to the view
    // direction the transform collapses to the dot product with `dir`.
    const tY = dx * dirX + dy * dirY;
    if (tY < 0.18) return false; // behind the eye or inside the near plane
    const tX = (dirX * dy - dirY * dx) / planeLen;
    const bound = tY + FRUSTUM_MARGIN;
    return tX < bound && tX > -bound;
  }

  /**
   * Collect every billboard for this frame: wall torches, uncollected items, and the exit portal.
   *
   * Both item and torch passes walk the spatial index, so the cost tracks the number of sprites
   * within `SPRITE_FAR` of the camera — a constant set by the fog — rather than the level's
   * population. At 128×128 cells that is ~130 candidates out of ~2100.
   * @param {RenderView} view
   * @param {number} time seconds
   * @returns {void}
   */
  function gatherSprites(view, time) {
    sprN = 0;
    const far2 = SPRITE_FAR * SPRITE_FAR;

    // Wall torches. The query radius is widened by `TORCH_SLACK` because the index keys a torch by
    // its tile centre while the flame hangs just outside the wall face.
    const torches = view.torches;
    const tReach = SPRITE_FAR + TORCH_SLACK;
    const tReach2 = tReach * tReach;
    if (torches && torchIndex.count > 0 && queryCells(torchIndex, camX, camY, tReach)) {
      const cellStart = torchIndex.cellStart;
      const entries = torchIndex.entries;
      const tpx = torchIndex.px;
      const tpy = torchIndex.py;
      const cols = torchIndex.cols;
      for (let cy = qy0; cy <= qy1; cy++) {
        const rowBase = cy * cols;
        // Buckets within one row are contiguous in `entries`, so the row's whole window of buckets
        // is a single flat walk rather than one loop per bucket.
        const kEnd = cellStart[rowBase + qx1 + 1];
        for (let k = cellStart[rowBase + qx0]; k < kEnd; k++) {
          // Reject on the flat position arrays first: most candidates never touch their object,
          // which is what keeps a thousand-torch level out of the cache.
          const bx = tpx[k] - camX;
          const by = tpy[k] - camY;
          if (bx * bx + by * by > tReach2) continue;
          const t = torches[entries[k]];
          const face = (t.face | 0) & 3;
          const nx = DIR_DX[face];
          const ny = DIR_DY[face];
          const x = t.x + 0.5 + nx * (0.5 + TORCH_OFFSET);
          const y = t.y + 0.5 + ny * (0.5 + TORCH_OFFSET);
          const dx = x - camX;
          const dy = y - camY;
          const d2 = dx * dx + dy * dy;
          if (d2 > far2 || !inFrustum(dx, dy)) continue;
          const phase = (t.x * 3 + t.y * 5) & 7;
          const frame = ((time * 11 + phase) | 0) & 3;
          // Emissive: the flame is a light source, so only distance fog dims it.
          const flick = 0.88 + 0.12 * tnoise(time * 9 + phase, 0x2c1a);
          // Scale 0.5 makes the sconce about half a tile tall; the offset lifts the flame to head
          // height, where a real wall bracket sits.
          addSprite(x, y, textures.torch[frame], 0.5, -0.17, levelFx(flick, Math.sqrt(d2), 1), d2);
        }
      }
    }

    // Items. Taken flasks and gems keep their slot in the index (their position never changes), so
    // a pickup costs a boolean test here instead of a rebuild.
    const items = view.items;
    if (items && itemIndex.count > 0 && queryCells(itemIndex, camX, camY, SPRITE_FAR)) {
      const cellStart = itemIndex.cellStart;
      const entries = itemIndex.entries;
      const ipx = itemIndex.px;
      const ipy = itemIndex.py;
      const cols = itemIndex.cols;
      for (let cy = qy0; cy <= qy1; cy++) {
        const rowBase = cy * cols;
        const kEnd = cellStart[rowBase + qx1 + 1];
        for (let k = cellStart[rowBase + qx0]; k < kEnd; k++) {
          const dx = ipx[k] - camX;
          const dy = ipy[k] - camY;
          const d2 = dx * dx + dy * dy;
          if (d2 > far2) continue;
          const it = items[entries[k]];
          if (it.taken) continue;
          const isGem = it.kind === 'gem';
          const d = Math.sqrt(d2);
          // Gems twinkle: a slow mote drifting off the crystal. In a corridor lit only by a failing
          // torch, that movement is what makes a pickup readable from a distance. Emitted before
          // the frustum test so a gem just off-screen still seeds the motes that drift into view.
          if (isGem && d2 < GEM_SPARKLE_RANGE2) {
            sparkleAcc += frameDt * GEM_SPARKLE_RATE;
            if (sparkleAcc >= 1) {
              sparkleAcc -= 1;
              particles.spawn(
                PARTICLE.DUST,
                it.x + emberRng.range(-0.12, 0.12),
                it.y + emberRng.range(-0.12, 0.12),
                0.24 + emberRng.range(0, 0.16),
                0,
                0,
                emberRng.range(0.08, 0.2),
                emberRng.range(0.5, 1.1),
                emberRng.chance(0.35) ? PARTICLE_COLORS.sparkPale : PARTICLE_COLORS.spark,
                1,
              );
            }
          }
          if (!inFrustum(dx, dy)) continue;
          const frames = isGem ? textures.gem : textures.oil;
          const phase = (it.id | 0) * 0.7;
          // Gentle bob and a slow spin — enough life that a pickup catches the eye down a corridor.
          const spin = ((time * (isGem ? 6 : 3) + phase) | 0) % frames.length;
          const bobZ = Math.sin(time * 2.2 + phase) * 0.045;
          const lvl = levelFx(illumFlat(it.x, it.y, allLights, lightN) * (isGem ? 1.25 : 1.1), d, 1);
          // Gems hover at knee height and bob; flasks stand on the floor. `vOff` is `0.5 - z`,
          // the world height of the sprite's centre below the eye.
          addSprite(it.x, it.y, frames[spin], isGem ? 0.34 : 0.42, (isGem ? 0.2 : 0.375) - bobZ, lvl, d2);
        }
      }
    }

    const exit = view.exit;
    if (exit) {
      const ex = exit.x + 0.5;
      const ey = exit.y + 0.5;
      const dx = ex - camX;
      const dy = ey - camY;
      const d2 = dx * dx + dy * dy;
      if (d2 <= far2) {
        const frame = ((time * 9) | 0) % textures.portal.length;
        const open = view.portalOpen !== false;
        addSprite(
          ex,
          ey,
          textures.portal[frame],
          open ? 0.95 : 0.7,
          0.02,
          levelFx(open ? 1 : 0.45, Math.sqrt(d2), 1),
          d2,
        );
      }
    }

    // Back-to-front insertion sort over the index array. Sprite counts are tens, where insertion
    // sort beats every asymptotically better algorithm and allocates nothing.
    for (let i = 1; i < sprN; i++) {
      const v = sprOrder[i];
      const key = sprDist[v];
      let j = i - 1;
      while (j >= 0 && sprDist[sprOrder[j]] < key) {
        sprOrder[j + 1] = sprOrder[j];
        j--;
      }
      sprOrder[j + 1] = v;
    }
  }

  /**
   * Draw the queued billboards, far to near, z-tested per column and alpha-keyed per texel.
   * @returns {number} sprites that put at least one column on screen
   */
  function renderSprites() {
    const w = width;
    const h = height;
    const halfW = w * 0.5;
    const invDet = 1 / (planeX * dirY - dirX * planeY);
    let drawn = 0;

    for (let s = 0; s < sprN; s++) {
      const i = sprOrder[s];
      const rx = sprX[i] - camX;
      const ry = sprY[i] - camY;
      const tY = invDet * (-planeY * rx + planeX * ry);
      if (tY < 0.18) continue; // behind the eye / inside the near plane
      const tX = invDet * (dirY * rx - dirX * ry);

      const scale = sprScale[i];
      const size = Math.abs((h / tY) * scale);
      if (size < 1) continue;
      const screenX = halfW * (1 + tX / tY);
      const vMove = (sprVOff[i] / tY) * h;
      const topF = horizon - size * 0.5 + vMove;
      const leftF = screenX - size * 0.5;

      let x0 = Math.ceil(leftF);
      let x1 = Math.ceil(leftF + size);
      if (x0 < 0) x0 = 0;
      if (x1 > w) x1 = w;
      if (x1 <= x0) continue;
      let y0 = Math.ceil(topF);
      let y1 = Math.ceil(topF + size);
      if (y0 < 0) y0 = 0;
      if (y1 > h) y1 = h;
      if (y1 <= y0) continue;

      const tex = sprTex[i];
      const ind = tex.indices;
      const stip = tex.stipple;
      const levBase = (sprLevel[i] >> 16) << 8;
      const stepFx = ((TEX / size) * FX_ONE) | 0;
      let texFx = ((x0 - leftF) * (TEX / size) * FX_ONE) | 0;
      const texYStart = ((y0 - topF) * (TEX / size) * FX_ONE) | 0;
      let any = false;

      for (let x = x0; x < x1; x++) {
        const tx = texFx >> 16;
        texFx += stepFx;
        if (tx < 0 || tx >= TEX) continue;
        if (tY >= zbuf[x]) continue; // hidden behind a wall
        any = true;
        let tp = texYStart;
        let pi = y0 * w + x;
        for (let y = y0; y < y1; y++) {
          const ty = tp >> 16;
          tp += stepFx;
          if (ty < 0 || ty >= TEX) {
            pi += w;
            continue;
          }
          const ti = (ty << 6) | tx;
          const idx = ind[ti];
          // Index 0 is the transparency key; stippled texels drop every other screen pixel.
          if (idx !== 0 && !(stip !== null && stip[ti] === 1 && ((x + y) & 1) === 0)) {
            buf[pi] = colormap[levBase | idx];
          }
          pi += w;
        }
      }
      if (any) drawn++;
    }
    return drawn;
  }

  // ── Flash ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Blend the whole framebuffer toward a colour. Runs only while a flash is active, and builds its
   * three 256-entry channel LUTs only when the flash colour actually changes, so the per-pixel
   * cost is three lookups and a pack.
   * @param {number} r 0..255
   * @param {number} g 0..255
   * @param {number} b 0..255
   * @param {number} a 0..1
   * @returns {void}
   */
  function applyFlash(r, g, b, a) {
    // A non-finite channel would poison the LUTs (Uint8Array turns NaN into 0) and flash the
    // screen black, so sanitise here rather than trusting the caller's arithmetic.
    const rr = Number.isFinite(r) ? r : 255;
    const gg = Number.isFinite(g) ? g : 255;
    const bb = Number.isFinite(b) ? b : 255;
    const key = (((rr | 0) << 24) ^ ((gg | 0) << 16) ^ ((bb | 0) << 8) ^ ((a * 255) | 0)) | 0;
    if (key !== flashKey) {
      flashKey = key;
      for (let v = 0; v < 256; v++) {
        flashR[v] = v + (rr - v) * a;
        flashG[v] = v + (gg - v) * a;
        flashB[v] = v + (bb - v) * a;
      }
    }
    const n = width * height;
    for (let i = 0; i < n; i++) {
      const c = buf[i];
      buf[i] =
        ((c & ALPHA_MASK) |
          (flashR[(c >>> SH_R) & 255] << SH_R) |
          (flashG[(c >>> SH_G) & 255] << SH_G) |
          (flashB[(c >>> SH_B) & 255] << SH_B)) >>>
        0;
    }
  }

  // ── Ambient effects ─────────────────────────────────────────────────────────────────────────

  /**
   * Trickle embers up from the torches that are currently lighting the scene. Rate-based and
   * frame-rate independent; the accumulator carries the fractional remainder between frames.
   * @param {number} dt seconds
   * @returns {void}
   */
  function emitEmbers(dt) {
    if (lightN === 0) return;
    emberAcc += dt * EMBER_RATE * lightN;
    if (emberAcc > 8) emberAcc = 8; // a long stall must not dump the whole pool at once
    while (emberAcc >= 1) {
      emberAcc -= 1;
      const i = emberRng.int(lightN);
      const spread = 0.06;
      particles.spawn(
        PARTICLE.EMBER,
        lightX[i] + emberRng.range(-spread, spread) - lightNX[i] * 0.05,
        lightY[i] + emberRng.range(-spread, spread) - lightNY[i] * 0.05,
        0.74,
        emberRng.range(-0.15, 0.15),
        emberRng.range(-0.15, 0.15),
        emberRng.range(0.1, 0.45),
        emberRng.range(0.7, 1.6),
        emberRng.chance(0.4) ? PARTICLE_COLORS.emberHot : PARTICLE_COLORS.ember,
        1,
      );
    }
  }

  // ── Frame ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Draw one frame.
   *
   * Read-only with respect to `view` — the renderer never writes back into game state. A malformed
   * view (no maze, zero-size canvas) clears to fog and returns instead of throwing, so a boot-order
   * mistake in main.js shows as a blank screen rather than a dead page.
   * @param {RenderView} view
   * @returns {void}
   */
  function render(view) {
    if (!ctx || !image || width === 0) return;
    const t0 = now();

    const maze = view && view.maze;
    if (!maze || !maze.tiles || maze.width <= 0 || maze.height <= 0 || !view.player) {
      buf.fill(fogPacked);
      ctx.putImageData(image, 0, 0);
      statsObj.ms = now() - t0;
      statsObj.frames++;
      return;
    }

    const p = view.player;
    // Clamped to ≥ 0 as well as to finite: animation frames are picked with `time % frameCount`,
    // and a negative clock would index off the front of a frame array.
    const time = Number.isFinite(view.time) && view.time > 0 ? view.time : 0;
    // The loop drives us with wall-clock frames; derive dt from the view's own clock so effects
    // stay in step with the simulation even when frames are dropped.
    let dt = time - lastTime;
    if (!(dt > 0)) dt = 0;
    else if (dt > 0.25) dt = 0.25;
    lastTime = time;
    frameDt = dt;

    camX = p.x;
    camY = p.y;
    const reduced = view.reducedMotion === true;
    const shake = reduced ? 0 : Math.max(0, Math.min(1, p.shake || 0));
    const angle = p.angle + (shake > 0 ? (tnoise(time * 43, 0x9f31) - 0.5) * SHAKE_YAW * shake : 0);
    dirX = Math.cos(angle);
    dirY = Math.sin(angle);
    // Plane length = half the view width at unit distance. Tying it to the aspect ratio keeps
    // pixels square at every window shape (vertical FOV is fixed at 2·atan(0.5) ≈ 53°).
    planeLen = (0.5 * width) / height;
    planeX = -dirY * planeLen;
    planeY = dirX * planeLen;

    const bobPx = Math.sin(p.bob || 0) * (p.bobAmp || 0) * BOB_PIXELS;
    const shakePx = shake > 0 ? (tnoise(time * 37, 0x51ab) - 0.5) * 2 * SHAKE_PIXELS * shake : 0;
    horizon = Math.round(height * 0.5 + bobPx + shakePx);
    // Keep the horizon on screen: both passes index rows relative to it.
    if (horizon < 1) horizon = 1;
    else if (horizon > height - 1) horizon = height - 1;

    const light = Number.isFinite(view.light) ? Math.max(0, Math.min(1, view.light)) : 1;
    torchInvR = 1 / (TORCH_MIN_R + (TORCH_MAX_R - TORCH_MIN_R) * light);
    // Flicker: two octaves, halved for players who asked for reduced motion.
    const flickAmp = reduced ? 0.5 : 1;
    torchPower =
      PLAYER_TORCH_CEILING *
      (0.86 + 0.14 * light) *
      (1 - flickAmp * (0.09 * (1 - tnoise(time * 6.7, 0x3c2f)) + 0.05 * (1 - tnoise(time * 15.3, 0x77b1))));

    buf.fill(fogPacked);
    // Cheap identity check; a real rebuild happens only on a level change (§4.5).
    syncIndexes(view);
    gatherLights(view, time);
    renderWalls(view);
    renderFlats();
    gatherSprites(view, time);
    const spritesDrawn = renderSprites();

    emitEmbers(dt);
    particles.update(dt);
    partCam.px = camX;
    partCam.py = camY;
    partCam.dirX = dirX;
    partCam.dirY = dirY;
    partCam.planeX = planeX;
    partCam.planeY = planeY;
    partCam.invDet = 1 / (planeX * dirY - dirX * planeY);
    partCam.horizon = horizon;
    const partsDrawn = particles.draw(buf, width, height, zbuf, partCam);

    const flash = view.flash;
    if (flash && flash.a > 0.004) {
      applyFlash(flash.r, flash.g, flash.b, flash.a > 1 ? 1 : flash.a);
    }

    ctx.putImageData(image, 0, 0);

    const ms = now() - t0;
    statsObj.ms = ms;
    statsObj.sprites = spritesDrawn;
    statsObj.lights = lightN;
    statsObj.particles = partsDrawn;
    statsObj.frames++;
    // Exponential moving average (≈20-frame time constant). Unlike a windowed mean it is
    // meaningful from the very first frame, which matters for the headless verifier.
    statsObj.msAvg = statsObj.frames <= 1 ? ms : statsObj.msAvg + (ms - statsObj.msAvg) * 0.05;
  }

  // ── Public surface ──────────────────────────────────────────────────────────────────────────

  /**
   * Swap in a different texture set (e.g. repainted for a new run seed). The colormap does not
   * depend on the textures, so nothing else has to be rebuilt.
   * @param {TextureSet} set
   * @returns {void}
   */
  function setTextures(set) {
    if (!set || !set.wall || set.wall.length === 0) return;
    textures = set;
    variantSeed = (set.seed | 0) ^ 0x5eed;
  }

  /**
   * Per-column perpendicular wall distance from the last frame, in tiles. Diagnostic (the tests
   * assert it is finite for every angle), and usable by main.js for effects that need depth.
   * @returns {Float32Array} the live buffer, first `internalSize.w` entries are valid
   */
  function depth() {
    return zbuf;
  }

  /** @type {{n:number, x:Float32Array, y:Float32Array}} reused; see `lights()` */
  const lightsObj = { n: 0, x: lightX, y: lightY };

  /**
   * The wall torches selected as point lights on the last frame, as world positions of the
   * *flames* (already offset off their wall).
   *
   * Diagnostic, and the seam the tests need: the nearest-8 selection now runs through the spatial
   * index, and the only way to prove it still answers what the exhaustive scan answered is to read
   * the answer. The object and both arrays are **reused** — read `n` entries, do not stash them.
   * @returns {{n:number, x:Float32Array, y:Float32Array}}
   */
  function lights() {
    lightsObj.n = lightN;
    return lightsObj;
  }

  /** Drop the framebuffer references. The canvas itself belongs to the page. */
  function dispose() {
    image = null;
    buf = new Uint32Array(0);
    ctx = null;
    particles.clear();
  }

  // Size once at construction so the renderer is usable before the page's first resize event.
  // `clientWidth` is 0 for a detached canvas and undefined in Node, hence the fallbacks.
  const bootW = (canvas && (canvas.clientWidth || canvas.width)) || 960;
  const bootH = (canvas && (canvas.clientHeight || canvas.height)) || 540;
  resize(bootW, bootH, 1);

  return {
    resize,
    render,
    stats: () => statsObj,
    internalSize,
    particles,
    get textures() {
      return textures;
    },
    setTextures,
    depth,
    lights,
    dispose,
  };
}
