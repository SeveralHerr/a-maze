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
 *   4. sprite pass             — items, portal, torch flames (visible to `FAR`: they make their own
 *                                light); back-to-front, z-tested, alpha-keyed
 *   5. particles               — embers and sparks, z-tested
 *   6. flash                   — full-screen additive tint, only when the view asks for one
 *
 * ── How the light works ───────────────────────────────────────────────────────────────────────
 * Shading never touches floating point per pixel. A **colormap** (Doom's trick) holds
 * `8 sconce tints × 64 levels × 256 palette entries` of already-packed RGBA. Along the level axis,
 * level 0 is the cool blue-black fog colour and level 63 is `ILLUM_MAX` (over-bright headroom only
 * wall sconces reach), with per-channel gammas so shadow drifts blue. Along the tint axis, 0 is
 * light from the player's own torch (stone stays blue-grey) and 7 is pure sconce light (amber).
 * Shading a pixel is therefore `colormap[(tint << 14) | (level << 8) | paletteIndex]` — one lookup.
 *
 * Level and tint are computed once per wall column and once per 12-pixel segment along each
 * floor/ceiling row, and interpolated in between — light is smooth, so that is indistinguishable
 * from evaluating it per pixel and an order of magnitude cheaper. The level sums a small ambient,
 * the player's torch (radius `lerp(2.5, 7, view.light)` with two octaves of flicker) and the
 * nearest eight wall torches as point lights; the tint is the sconces' share of that sum. A torch
 * lights only the tiles its flame can see — a per-torch visibility window, baked the first time the
 * torch becomes a light and kept for the level — which is what stops light leaking through masonry
 * into the next corridor. The sum is multiplied
 * by a distance-fog LUT, and wall columns additionally fall off toward the floor and ceiling
 * (lights sit at eye height, so the edges of a wall are further from all of them than its middle).
 * 4×4 Bayer values (one matrix for the level, a shifted one for the tint) are added before
 * truncation, dithering away the banding the discrete steps would otherwise show.
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

/**
 * Sconce-tint steps in the colormap: step 0 is a surface lit only by the player's own torch and the
 * ambient, step `WARM_STEPS - 1` is one lit entirely by wall sconces.
 *
 * WHY a second axis on the table rather than a warmer ramp: the first colormaps warmed every
 * material by *brightness*, so whatever the player's torch lit hardest went orange — measured, the
 * cobbles 1–2 tiles ahead read r−b +48…+83 (tan sand) and the stone beside the player was neutral
 * grey, while a sconce three tiles away only made its wall brighter (r−b −12 → −3). The reference
 * is the other way round: blue-grey stone and grey cobbles, with the orange living in the pools
 * *around the wall torches*. So warmth is now a property of **which light** reaches a surface, and a
 * shade level alone never makes anything orange.
 *
 * Eight steps, ordered-dithered between (with a Bayer table decorrelated from the level dither, see
 * `BAYER_W`), are indistinguishable from a continuous blend and keep the lookup a single read:
 * `colormap[(warm << WARM_SHIFT) | (level << 8) | paletteIndex]`. Step 0 occupies the first
 * `LEVELS × CM_STRIDE` entries, so `(level << 8) | index` — what `particles.js` uses — still reads
 * the untinted table.
 */
const WARM_STEPS = 8;

/** Bit position of the sconce-tint step in a colormap index (above 6 level bits + 8 index bits). */
const WARM_SHIFT = 14;

/** Largest sconce-tint value in 16.16 fixed point; `(warm + dither) >> 16` stays < `WARM_STEPS`. */
const WARM_FX_MAX = ((WARM_STEPS - 1) << 16) - 1;

/**
 * Multiplier on a sconce's share of a surface's light before it becomes a tint step, so the share at
 * which a surface reads fully firelit is `1 / SCONCE_WARM_GAIN` (≈ 60 %). Above 1 because a pool is
 * never lit by the sconce alone near the player: where the sconce is the larger part of the light it
 * should already read as firelight, which is what the pools under the reference's torches look like.
 */
const SCONCE_WARM_GAIN = 1.6;

/**
 * Upper clamp on summed illumination before fog.
 *
 * WHY above 1: the player's torch alone tops out at `PLAYER_TORCH_CEILING`, and a clamp at 1 left a
 * sconce next to a full tank almost nothing to add — measured +25 % luminance on the wall beside it,
 * with no colour. With headroom a sconce still brightens a surface the player is standing next to,
 * and one down the corridor survives the fog.
 */
const ILLUM_MAX = 1.3;
const INV_ILLUM_MAX = 1 / ILLUM_MAX;

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
 * Derived, not guessed: a sprite's shade level is `illum × fog(d) × 63 / ILLUM_MAX` truncated
 * (sprites below one whole level skip the ordered dither — see `BAYER_NONE`), the brightest thing
 * any sprite is given is a gem at `1.25 × ILLUM_MAX` (level `1.25 × fog × 63`), and level 0 of every
 * tint block of the colormap *is* the fog colour — which is exactly what the frame was cleared to
 * and what every surface at that distance already shades to. So once `fog(d) × 1.3 × 63 < 1` a
 * sprite can only paint fog onto fog. Solving `exp(-(d/9)^1.9) < 1/(1.3×63)` gives ≈19.6 tiles; the
 * margin below rounds that up. Culling here instead of at `FAR` (30) shrinks the queried area by
 * 2.2×. Wall-torch flames are the exception: see `FLAME_FOG_SCALE`.
 */
const SPRITE_FAR = (() => {
  for (let i = 0; i < 4096; i++) {
    const d = i * 0.02;
    if (Math.exp(-Math.pow(d / 9, 1.9)) * 1.3 * (LEVELS - 1) < 1) return Math.min(d + 1.5, FAR);
  }
  return FAR;
})();

/**
 * Distance scale on the fog a wall-torch **flame** is seen through: a flame 20 tiles away is shaded
 * as a lit surface 6 tiles away would be.
 *
 * WHY: the fog here is darkness, not haze — it stands for light that never reached a surface. A
 * flame makes its own light, so its brightness hardly depends on distance (only its size does), and
 * a torch down a dark corridor is a bright point in blackness — exactly the reference's back-wall
 * sconces, burning yellow against stone at median luminance 10. Shaded like a surface, a flame had
 * faded out by ~10 tiles and dimmed to blue-grey on the way (a sconce 12 tiles off measured mean
 * r−b −9). The small remainder of fog is haze, and keeps a far flame a step dimmer than a near one.
 */
const FLAME_FOG_SCALE = 0.3;

/**
 * Flames fade smoothly to nothing between this distance and `FAR`, so the cull at `FAR` (past which
 * the wall a sconce hangs on is no longer drawn either) can never pop a flame into view.
 */
const FLAME_FADE_FROM = 21;

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

/**
 * Strength of one wall sconce relative to the player's torch at full tank. Below 1 on purpose: the
 * torch in your hand is the brightest light in your own pool, so the stone beside you stays
 * blue-grey, and the sconces' amber shows where the reference shows it — in the pools further down
 * the corridor, and around the flame as you walk up to it.
 */
const SCONCE_POWER = 0.6;

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

/**
 * Side, in tiles, of the square window a wall torch's **visibility mask** covers, centred on the
 * tile its flame burns in (see `bakeTorchVisibility`). The light reaches `TORCH_RADIUS` (4.6) from a
 * flame that sits 0.28 behind that tile's centre, so every surface it can touch lies within ±5 tiles.
 */
const VIS_SPAN = 11;
const VIS_HALF = (VIS_SPAN - 1) >> 1;
const VIS_AREA = VIS_SPAN * VIS_SPAN;

/**
 * Points inside a tile, as `[x, y]` offsets, sampled for line of sight from a flame. A tile counts as
 * lit when *any* of them is visible: the mask is per tile, so demanding the centre alone would cut a
 * pool off at the first tile boundary of a side corridor even where most of that tile is in view.
 */
const VIS_SAMPLES = Float64Array.of(0.5, 0.5, 0.12, 0.12, 0.88, 0.12, 0.12, 0.88, 0.88, 0.88);

/** Light that exists with no torch at all, so unlit geometry is fog-blue rather than black. */
const AMBIENT = 0.055;

/** Player torch radius at `view.light` 0 and 1, tiles (ARCHITECTURE §4.5). */
const TORCH_MIN_R = 2.5;
const TORCH_MAX_R = 7;

/**
 * Ceiling on what the player's own torch alone can light a surface to.
 *
 * A wall sconce must be able to add visibly on top of the light the player carries, or its pool
 * disappears whenever the tank is full — the reference's defining lighting cue. With the sum clamped
 * at 1 (the old model) a sconce beside a full tank added +25 % luminance and nothing else. That
 * headroom now comes from `ILLUM_MAX` above this ceiling, and the sconce's *colour* from the tint
 * axis (`WARM_STEPS`), so the player's torch is not the thing that has to give: lowering this to 0.8
 * dropped near stone at preview pose 0 from median luminance 43 to 38, further under the reference's
 * 55–73.
 */
const PLAYER_TORCH_CEILING = 0.95;

/**
 * Ceiling light, relative to walls. Above `FLOOR_DIM` although the ceiling is further from every
 * flame, because the timber ramp is already the darkest material in the palette: at 0.72 the near
 * ceiling at preview pose 0 measures median luminance 32 and r−b +17, against the reference's dark
 * planks at 28 and +13.
 */
const CEIL_DIM = 0.72;

/**
 * Floors are dimmed too. A floor point has no Lambert term for the player's
 * torch (it is lit from roughly overhead), so undimmed the cobbles ahead came out brighter than the
 * stone beside the player — the reverse of the reference, whose floor sits a step darker than its
 * walls (median luminance 24–40 against 55–73) and reads as the ground the light falls on, not a
 * lamp. At 0.8 the near floor still measured median 64 against near walls at 42 (preview pose 0);
 * 0.64 brings it to 51 against 44, with the far floor in step.
 */
const FLOOR_DIM = 0.64;

/**
 * Weight of the Lambert term in the player's light on a wall: `lambert × dot + (1 − lambert)`.
 * The side walls of a corridor are seen at grazing incidence (dot ≈ 0.25 two tiles along), so at
 * 0.4 they sat at 70 % of a face-on wall and the corridor read darker at its sides than at its floor.
 * 0.3 keeps corners legible while the stone stays the brightest thing in the player's pool.
 */
const WALL_LAMBERT = 0.3;

/** North/south wall faces are drawn darker; the classic raycaster cue that reads as form. */
const SIDE_SHADE = 0.76;

/** Head-bob amplitude in pixels at the internal resolution, at `bobAmp` 1. */
const BOB_PIXELS = 5;

/** Camera-shake amplitude in pixels at `shake` 1. */
const SHAKE_PIXELS = 7;

/** Shake also jitters yaw slightly, radians at `shake` 1. */
const SHAKE_YAW = 0.02;

/**
 * Shade level (as a fraction of the ramp) at which the player-torch tint is fully applied.
 * See `buildColormap`.
 */
const WARM_FULL = 0.7;

/**
 * Per-channel multipliers the player's own torch applies at full strength (`tint` at
 * `WARM_FULL`). Deliberately small: tintR ≤ 1.08 and tintB ≥ 0.88 keep the stone ramp's blue alive
 * at full light (stoneBase lands near r−b −15), so the near field reads as firelit *blue-grey*
 * masonry, the way the reference's pillars do, not as warm grey concrete.
 */
const PLAYER_TINT_R = 1.04;
const PLAYER_TINT_G = 1.0;
const PLAYER_TINT_B = 0.94;

/**
 * Colour of wall-sconce light, as multipliers on top of the player tint at full sconce share —
 * `fireMid` from the palette, desaturated to what a lit stone surface can plausibly reflect.
 *
 * Deliberately short of the flame's own saturation, and paired with a weaker `SCONCE_POWER` and the
 * `OVERBRIGHT_SLOPE` shoulder. At r×1.45 g×0.74 b×0.3 with power 0.7 and linear over-bright, stone a
 * step from a sconce washed out to peach and the cobbles went tan (near wall r−b +31 at luminance
 * p95 131, near floor +51, preview pose 3) — light you could no longer tell was falling on stone.
 * Here the same wall is firelit tan-grey (+25, p95 ≤ 135 with the shoulder), the cobbles
 * warm brown (+32), and the stone past the pool keeps its blue.
 */
const SCONCE_TINT_R = 1.38;
const SCONCE_TINT_G = 0.86;
const SCONCE_TINT_B = 0.45;

/**
 * Per-channel colormap gammas `[r, g, b]` for untinted light and for full sconce light. Untinted,
 * red falls off fastest and blue slowest, so darkness drifts to the reference's deep blue. Under a
 * sconce the order reverses — a dim surface lit by a flame is dim *amber*, not blue — which is what
 * lets a pool still read as firelight at the edge of its radius instead of only next to the flame.
 */
const GAMMA_COOL_R = 1.55;
const GAMMA_COOL_G = 1.35;
const GAMMA_COOL_B = 1.1;
const GAMMA_FIRE_R = 1.22;
const GAMMA_FIRE_G = 1.3;
const GAMMA_FIRE_B = 1.45;

/**
 * Slope of the colormap above light 1 (the over-bright headroom only sconces reach), as a fraction
 * of linear. Linear let a wall the player hugs next to a sconce reach 1.3× its texel colour, which
 * clipped the bright stone steps to cream; a shoulder keeps the brightening visible and the stone.
 */
const OVERBRIGHT_SLOPE = 0.55;

/**
 * Exponent of a wall sconce's falloff past its flat core (`buildAttLut`: full strength over the
 * first 12 % of `TORCH_RADIUS`, then `(1 − u)^k`). The core keeps the flame's surroundings lit as a
 * pool rather than a pinpoint; the square keeps the pool from washing the whole 4.6-tile radius down
 * a corridor. Either way the light reaches exactly zero at the radius, so culling is unaffected.
 */
const ATT_EXPONENT = 2.0;

/**
 * Fraction of the player's torch radius lit at full strength before the falloff begins.
 *
 * The torch the player carries does not use the sconces' power curve. A power curve starts falling
 * the moment it leaves its core, so the floor three tiles ahead already sat below colormap level 25,
 * where the blue-drifting channel gammas take over: the lit pool ended ~1.5 tiles out and the
 * corridor read uniformly dark. A lantern's pool is a plateau with a soft edge — `1 − smoothstep`
 * from this core out to the radius — which carries the light to ~3 tiles at a full tank and still
 * shrinks with `view.light`, so the fuel gauge stays readable in the world itself.
 */
const PLAYER_TORCH_CORE = 0.1;

/** Height of a sconce's flame above the floor, tiles — for the incidence term on flat surfaces. */
const FLAME_Z = 0.62;

/**
 * Share of a sconce's light a floor or ceiling point receives even at grazing incidence: bounce
 * light off the walls of a one-tile corridor, which is what keeps the far edge of a pool from
 * reading as a hard cut-off.
 */
const FLAT_INCIDENCE_MIN = 0.2;

/** Fog LUT resolution over [0, FAR] tiles. */
const FOG_LUT_N = 512;
const FOG_SCALE = FOG_LUT_N / FAR;
const FOG_LUT_MAX = FOG_LUT_N - 1;

/** Attenuation LUT resolution over [0, radius]. */
const ATT_LUT_N = 256;

/** Torch sprite stands this far in front of the wall face it is mounted on (ARCHITECTURE §4.5). */
const TORCH_OFFSET = 0.02;

/** World height (and width) of a wall-torch billboard, in tiles. */
const TORCH_SPRITE_SCALE = 0.5;

/**
 * Slack, in tiles, on a wall sprite's per-column mounting-plane depth (see `renderSprites`). The
 * plane depth and the wall pass's DDA distance describe the *same* ray/plane intersection, so they
 * differ only by float32 rounding in the z-buffer (≈1e-6 at 30 tiles); a hundredth of a tile
 * absorbs that with four orders of magnitude to spare and is still far too thin for any real
 * occluder — the nearest other geometry is a whole tile face — to slip through.
 */
const SPRITE_WALL_EPS = 0.01;

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

/**
 * The same 4×4 Bayer thresholds shifted one column, for the **sconce-tint** dither.
 *
 * WHY a second ordering: dithering the tint step with the very thresholds that dither the level
 * would correlate the two, so wherever both sit between steps the brighter pixels would also be
 * the warmer ones and a flat pool would break into a high-contrast orange/blue checker. A shifted
 * matrix puts the two quantisation errors on different pixels.
 */
const BAYER_W = Int32Array.from({ length: 16 }, (_, k) => BAYER16[(k & 12) | (((k & 3) + 1) & 3)]);

/**
 * Half-amplitude level dither for floor and ceiling rows close to the camera.
 *
 * Near the eye one internal pixel is 3–6 screen pixels and the light barely changes across a row, so
 * a full ±½-level Bayer pattern there is not smoothing a gradient — it is painting a 12-px
 * checkerboard onto the cobbles. Half the amplitude, re-centred on the same mean (the full table's
 * mean is ½ level; this one is ¼ + ¼), keeps the banding away without the texture noise.
 */
const BAYER_NEAR = Int32Array.from(BAYER16, (v) => (v >> 1) + (FX_ONE >> 2));

/**
 * All-zero stand-in for `BAYER16`, used by a sprite whose shade level is below one whole level.
 * Such a sprite truncates to level 0 — exactly the fog colour — on every pixel, which is the premise
 * `SPRITE_FAR` is derived from; dithering it would lift scattered pixels to level 1 and make the
 * fog cull visible (by one RGB step, but no longer byte-exact). Swapping tables keeps the pixel
 * loop branch-free.
 */
const BAYER_NONE = new Int32Array(16);

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
 * Fill the `WARM_STEPS × 64 × 256` colormap.
 *
 * For shade level `t` ∈ [0,1] and sconce share `s` ∈ [0,1] a texel becomes
 * `colour × tint(t, s) × gamma(t, s) + fog × (1 − gamma(t, s))`.
 *
 * - **Level** (`t`) is how much light arrives. Untinted, the three channels fall off with different
 *   gammas so darkness drifts to the reference's deep blue-black rather than to neutral grey.
 * - **Sconce share** (`s`, the table's first axis) is how much of that light comes from wall
 *   torches. It blends the tint toward firelight and reverses the gamma order, so a pool reads as
 *   amber all the way to its edge.
 *
 * The player's own torch gets only a slight warm lift at the bright end (`PLAYER_TINT_*`). The
 * history matters here: two earlier versions tied warmth to brightness alone — first parking it in
 * the top few levels no light but a point-blank sconce reached (everything read cool), then
 * saturating it by 70 % of the ramp (the player's pool turned the cobbles tan and the stone neutral
 * grey; measured near-floor r−b +48…+83 against the reference's +9, near walls −5…+3 against
 * −20…−27). Measure the preview poses before retuning any of these numbers.
 * @param {Uint32Array} out length `WARM_STEPS * LEVELS * CM_STRIDE`
 * @returns {void}
 */
function buildColormap(out) {
  const fogR = PALETTE_RGB[C.fog * 3];
  const fogG = PALETTE_RGB[C.fog * 3 + 1];
  const fogB = PALETTE_RGB[C.fog * 3 + 2];
  const fogPacked = pack(fogR, fogG, fogB, 255);
  for (let k = 0; k < WARM_STEPS; k++) {
    const s = k / (WARM_STEPS - 1);
    const expR = GAMMA_COOL_R + (GAMMA_FIRE_R - GAMMA_COOL_R) * s;
    const expG = GAMMA_COOL_G + (GAMMA_FIRE_G - GAMMA_COOL_G) * s;
    const expB = GAMMA_COOL_B + (GAMMA_FIRE_B - GAMMA_COOL_B) * s;
    const fireR = 1 + (SCONCE_TINT_R - 1) * s;
    const fireG = 1 + (SCONCE_TINT_G - 1) * s;
    const fireB = 1 + (SCONCE_TINT_B - 1) * s;
    for (let l = 0; l < LEVELS; l++) {
      // Level 63 is `ILLUM_MAX` of light, not 1: the top of the table is over-bright headroom only
      // sconces reach (see `ILLUM_MAX`). Light 1 is still the texel's own colour.
      const t = (l / LEVEL_MAX) * ILLUM_MAX;
      // Over-bright light scales all three channels alike, on a shoulder (`OVERBRIGHT_SLOPE`).
      // Continuing the per-channel gammas past 1 would grow blue fastest under a sconce (its
      // exponent is the largest there) and bleach the hottest part of every pool from amber to cream.
      const over = 1 + (t - 1) * OVERBRIGHT_SLOPE;
      const gR = t < 1 ? Math.pow(t, expR) : over;
      const gG = t < 1 ? Math.pow(t, expG) : over;
      const gB = t < 1 ? Math.pow(t, expB) : over;
      // The player tint eases in with a smoothstep up to `WARM_FULL`, so shadow keeps the palette's
      // own hue and only the lit end of the ramp picks up the torch's slight warmth.
      const wu = t >= WARM_FULL ? 1 : t / WARM_FULL;
      const warm = wu * wu * (3 - 2 * wu);
      const tintR = (1 + (PLAYER_TINT_R - 1) * warm) * fireR;
      const tintG = (1 + (PLAYER_TINT_G - 1) * warm) * fireG;
      const tintB = (1 + (PLAYER_TINT_B - 1) * warm) * fireB;
      const base = (k << WARM_SHIFT) | (l << 8);
      for (let i = 0; i < PALETTE_SIZE; i++) {
        // Past light 1 the fog term is gone entirely rather than subtracted.
        const r = PALETTE_RGB[i * 3] * tintR * gR + (gR < 1 ? fogR * (1 - gR) : 0);
        const g = PALETTE_RGB[i * 3 + 1] * tintG * gG + (gG < 1 ? fogG * (1 - gG) : 0);
        const b = PALETTE_RGB[i * 3 + 2] * tintB * gB + (gB < 1 ? fogB * (1 - gB) : 0);
        out[base + i] = pack(r, g, b, 255);
      }
      // Slots past the palette can only be reached by a corrupt index; make them opaque fog rather
      // than transparent black so such a bug shows as a dark patch, never as a see-through hole.
      for (let i = PALETTE_SIZE; i < CM_STRIDE; i++) out[base + i] = fogPacked;
    }
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
 * Normalised distance → attenuation for a point light, `(1-t)^ATT_EXPONENT` with a small
 * unattenuated core. Reaches exactly 0 at the radius, so a light can be culled by distance with no
 * visible edge.
 * @param {Float32Array} out length `ATT_LUT_N + 1`
 * @returns {void}
 */
function buildAttLut(out) {
  for (let i = 0; i <= ATT_LUT_N; i++) {
    const t = i / ATT_LUT_N;
    const k = t < 0.12 ? 1 : 1 - (t - 0.12) / 0.88;
    out[i] = Math.pow(k < 0 ? 0 : k, ATT_EXPONENT);
  }
}

/**
 * `buildAttLut` times the angle of incidence on a floor or ceiling: a flame at `FLAME_Z` above the
 * surface lights the patch under it square-on and the cobbles three tiles away at a grazing ~13°.
 *
 * Without it a sconce lit the floor as if every cobble faced the flame, so the pool on the floor was
 * brighter than on the wall the torch hangs from and ran the full 4.6-tile radius down the corridor
 * — a wash of tan instead of a pool. Baked into its own table, so it costs nothing per sample.
 * @param {Float32Array} att the wall attenuation table
 * @param {Float32Array} out length `ATT_LUT_N + 1`
 * @returns {void}
 */
function buildAttFlatLut(att, out) {
  for (let i = 0; i <= ATT_LUT_N; i++) {
    const d = (i / ATT_LUT_N) * TORCH_RADIUS;
    const cos = FLAME_Z / Math.sqrt(FLAME_Z * FLAME_Z + d * d);
    out[i] = att[i] * (FLAT_INCIDENCE_MIN + (1 - FLAT_INCIDENCE_MIN) * cos);
  }
}

/**
 * Normalised distance → attenuation for the player's own torch: a lit plateau with a smooth
 * shoulder, `1 − smoothstep(PLAYER_TORCH_CORE, 1, t)`. Exactly 0 at the radius, like `buildAttLut`.
 * @param {Float32Array} out length `ATT_LUT_N + 1`
 * @returns {void}
 */
function buildPlayerAttLut(out) {
  for (let i = 0; i <= ATT_LUT_N; i++) {
    let u = (i / ATT_LUT_N - PLAYER_TORCH_CORE) / (1 - PLAYER_TORCH_CORE);
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    out[i] = 1 - u * u * (3 - 2 * u);
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
  /**
   * The two ceiling paintings transposed (u ↔ v), for east-west corridors — see `renderFlats`.
   * Derived here rather than painted in `textures.js` so the `TextureSet` contract is unchanged;
   * rebuilt only when the texture set is swapped.
   */
  const ceilAcross = [new Uint8Array(TEX * TEX), new Uint8Array(TEX * TEX)];
  transposeCeilings(textures);

  // ── Shade tables (built once; independent of resolution) ──
  const colormap = new Uint32Array(WARM_STEPS * LEVELS * CM_STRIDE);
  buildColormap(colormap);
  const fogLut = new Float32Array(FOG_LUT_N);
  buildFogLut(fogLut);
  const attLut = new Float32Array(ATT_LUT_N + 1);
  buildAttLut(attLut);
  const attFlatLut = new Float32Array(ATT_LUT_N + 1);
  buildAttFlatLut(attLut, attFlatLut);
  const playerAttLut = new Float32Array(ATT_LUT_N + 1);
  buildPlayerAttLut(playerAttLut);
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
  /** Index into `view.torches` of the torch in each slot. */
  const lightTorch = new Int32Array(MAX_LIGHTS);
  /** Tile coordinate of the top-left corner of each slot's visibility window. */
  const lightOX = new Int32Array(MAX_LIGHTS);
  const lightOY = new Int32Array(MAX_LIGHTS);
  let lightN = 0;
  /**
   * Sconce part of the illumination the last `illumFlat`/`illumWall` call summed, expressed as a
   * 16.16 sconce-tint value in `[0, WARM_FX_MAX]`. A closure slot instead of a second return value
   * is what keeps those two calls allocation-free.
   */
  let illumWarmFx = 0;

  // ── Per-torch light visibility ──
  // One `VIS_AREA`-byte window per torch of the current level, baked lazily the first time the torch
  // is chosen as a light (see `bakeTorchVisibility`). Sized to the level's torch count on a level
  // change and grown only past its high-water mark, so play never allocates.
  let torchVis = new Uint8Array(0);
  /** 1 once a torch's window has been baked for the current level. */
  let torchVisReady = new Uint8Array(0);
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
  /** 16.16 sconce-tint value per sprite (0 for emissive art, which carries its own colour). */
  const sprWarm = new Int32Array(MAX_SPRITES);
  /**
   * Mounting-wall plane of a wall sprite, in the form the sprite pass needs per column: a ray with
   * camera-plane coordinate `cx` meets the plane at depth `sprWallK / (sprWallA + sprWallB·cx)`.
   * `sprWallK < 0` marks a wall sprite; free-standing sprites carry 0 and z-test honestly. Float64
   * because a grazing ray divides by a small denominator. See `renderSprites` for why.
   */
  const sprWallK = new Float64Array(MAX_SPRITES);
  const sprWallA = new Float64Array(MAX_SPRITES);
  const sprWallB = new Float64Array(MAX_SPRITES);
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
    levelFull: LEVEL_MAX * INV_ILLUM_MAX,
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
    // Visibility windows belong to a level: forget every bake, and grow the store only past its
    // high-water mark (a level-change cost, like the index build above).
    if (torchVisReady.length < torches.length) {
      torchVisReady = new Uint8Array(torches.length);
      torchVis = new Uint8Array(torches.length * VIS_AREA);
    } else {
      torchVisReady.fill(0, 0, torches.length);
    }
  }

  /**
   * Is the straight segment from `(ax, ay)` to `(bx, by)` free of solid tiles?
   *
   * A grid walk (Amanatides–Woo) from the start tile to the end tile, failing on the first non-floor
   * tile it enters or on leaving the map. Only ever called while baking a visibility window, never
   * per frame.
   * @param {Uint8Array} tiles
   * @param {number} mw maze width in tiles
   * @param {number} mh maze height in tiles
   * @param {number} ax
   * @param {number} ay
   * @param {number} bx
   * @param {number} by
   * @returns {boolean}
   */
  function segmentClear(tiles, mw, mh, ax, ay, bx, by) {
    let mx = Math.floor(ax);
    let my = Math.floor(ay);
    const ex = Math.floor(bx);
    const ey = Math.floor(by);
    const dx = bx - ax;
    const dy = by - ay;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : 1e30;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : 1e30;
    let tmx = (dx > 0 ? mx + 1 - ax : ax - mx) * tdx;
    let tmy = (dy > 0 ? my + 1 - ay : ay - my) * tdy;
    // A window is 11 tiles across, so no segment inside it crosses more than ~22 tile boundaries.
    for (let n = 0; n < 4 * VIS_SPAN; n++) {
      if (mx === ex && my === ey) return true;
      if (tmx < tmy) {
        tmx += tdx;
        mx += stepX;
      } else {
        tmy += tdy;
        my += stepY;
      }
      if (mx < 0 || my < 0 || mx >= mw || my >= mh || tiles[my * mw + mx] !== TILE_FLOOR) return false;
    }
    return false;
  }

  /**
   * Bake which tiles around a wall torch its flame can actually see.
   *
   * WHY: the per-light occlusion used to be only the half-space in front of the torch's own wall, so
   * a sconce lit every parallel corridor on its facing side within `TORCH_RADIUS` straight through a
   * one-tile wall — measured in game, +12.6 % luminance and a warm cast in a corridor with no torch
   * in it. Tracing real line of sight per lit pixel is out of the question, but walls never move, so
   * the answer per *tile* is a constant of the level: a byte per tile in an `VIS_SPAN`² window.
   *
   * Surfaces map onto the window by the floor tile they face: wall hits are nudged 0.02 into the
   * corridor before they are lit, and floor and ceiling points already lie in one. Baking is lazy —
   * a torch is baked the first frame it becomes one of the eight lights — so a frame bakes at most
   * `MAX_LIGHTS` windows. Measured on a real 128×128-cell level: ≈20 µs a window, so a frame that
   * turns over all eight lights costs ≈0.2 ms more. Baking all 1 290 of that level's torches when it
   * loads would instead put ≈25 ms into the level install, which `tools/verify.mjs` gates at 50 ms.
   * @param {number} ti index into the indexed torch array
   * @returns {void}
   */
  function bakeTorchVisibility(ti) {
    const t = idxTorches[ti];
    const maze = idxMaze;
    const tiles = maze.tiles;
    const mw = maze.width;
    const mh = maze.height;
    const face = (t.face | 0) & 3;
    const fx = t.x + 0.5 + DIR_DX[face] * (0.5 + TORCH_LIGHT_OFFSET);
    const fy = t.y + 0.5 + DIR_DY[face] * (0.5 + TORCH_LIGHT_OFFSET);
    const ox = t.x + DIR_DX[face] - VIS_HALF;
    const oy = t.y + DIR_DY[face] - VIS_HALF;
    const base = ti * VIS_AREA;
    for (let j = 0; j < VIS_SPAN; j++) {
      const ty = oy + j;
      for (let i = 0; i < VIS_SPAN; i++) {
        const tx = ox + i;
        let vis = 0;
        if (tx >= 0 && ty >= 0 && tx < mw && ty < mh && tiles[ty * mw + tx] === TILE_FLOOR) {
          // Nearest point of the tile to the flame: a tile wholly out of reach needs no rays.
          const nx = fx < tx ? tx : fx > tx + 1 ? tx + 1 : fx;
          const ny = fy < ty ? ty : fy > ty + 1 ? ty + 1 : fy;
          if ((nx - fx) * (nx - fx) + (ny - fy) * (ny - fy) <= TORCH_RADIUS2) {
            for (let s = 0; s < VIS_SAMPLES.length; s += 2) {
              if (segmentClear(tiles, mw, mh, fx, fy, tx + VIS_SAMPLES[s], ty + VIS_SAMPLES[s + 1])) {
                vis = 1;
                break;
              }
            }
          }
        }
        torchVis[base + j * VIS_SPAN + i] = vis;
      }
    }
    torchVisReady[ti] = 1;
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

    // Only the torches that won a slot are ever baked, and each at most once per level.
    for (let i = 0; i < lightN; i++) {
      if (torchVisReady[lightTorch[i]] === 0) bakeTorchVisibility(lightTorch[i]);
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
      considerLight(torches, entries[k], focusX, focusY, maxR2, time);
    }
  }

  /**
   * Offer one torch to the eight light slots, updating `lightWorstD2`.
   * @param {import('../core/types.js').Torch[]} torches
   * @param {number} ti index of the torch in `torches`
   * @param {number} focusX
   * @param {number} focusY
   * @param {number} maxR2 squared cut-off distance
   * @param {number} time seconds
   * @returns {void}
   */
  function considerLight(torches, ti, focusX, focusY, maxR2, time) {
    const t = torches[ti];
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
    lightTorch[slot] = ti;
    lightOX[slot] = t.x + nx - VIS_HALF;
    lightOY[slot] = t.y + ny - VIS_HALF;
    // Each torch flickers on its own phase, seeded from its tile so it is stable frame to frame.
    const phase = (t.x * 7 + t.y * 13) & 63;
    lightPow[slot] = SCONCE_POWER * (0.85 + 0.32 * tnoise(time * 6.2 + phase, 0x71c5));

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
   * given row (see `cullRowLights`). Also leaves the sconce tint of the point in `illumWarmFx`.
   * @param {number} wx world x
   * @param {number} wy world y
   * @param {Int32Array} list light indices
   * @param {number} n entries in `list`
   * @returns {number} 0..ILLUM_MAX before fog
   */
  function illumFlat(wx, wy, list, n) {
    const dx = wx - camX;
    const dy = wy - camY;
    const d = Math.sqrt(dx * dx + dy * dy);
    let t = d * torchInvR;
    if (t > 1) t = 1;
    const own = AMBIENT + playerAttLut[(t * ATT_LUT_N) | 0] * torchPower;
    let sconce = 0;
    // Tile of the point, for the visibility windows. `| 0` truncates rather than floors, which only
    // differs west or north of the map, where every window already reads "not visible".
    const tx = wx | 0;
    const ty = wy | 0;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      const lx = lightX[i] - wx;
      const ly = lightY[i] - wy;
      const d2 = lx * lx + ly * ly;
      if (d2 > TORCH_RADIUS2) continue;
      // Out of the flame's line of sight — through a wall into a parallel corridor, round a corner,
      // or behind the sconce's own wall. See `bakeTorchVisibility`. (This replaced a test against
      // the mounting wall's plane, which leaked through every other wall and also cut a hard line
      // across the floor wherever a corridor opened beside the sconce.)
      const vx = tx - lightOX[i];
      const vy = ty - lightOY[i];
      if (vx >>> 0 >= VIS_SPAN || vy >>> 0 >= VIS_SPAN) continue;
      if (torchVis[lightTorch[i] * VIS_AREA + vy * VIS_SPAN + vx] === 0) continue;
      const dl = Math.sqrt(d2);
      sconce += attFlatLut[(dl * INV_TORCH_RADIUS * ATT_LUT_N) | 0] * lightPow[i];
    }
    return mixLight(own, sconce);
  }

  /**
   * Sum the player's and the sconces' light, record the sconce tint in `illumWarmFx`, and clamp.
   * @param {number} own ambient + player torch
   * @param {number} sconce sum of wall-torch contributions
   * @returns {number} 0..ILLUM_MAX
   */
  function mixLight(own, sconce) {
    const total = own + sconce;
    if (sconce > 0 && total > 0) {
      let share = (sconce / total) * SCONCE_WARM_GAIN;
      if (share > 1) share = 1;
      // Smoothstep, not linear: a sconce that is a minor part of the light — the stone beside the
      // player, lit mostly by the torch in hand — barely tints it, while a surface the sconce
      // dominates goes fully amber. That contrast is what makes a pool read as a pool.
      illumWarmFx = (share * share * (3 - 2 * share) * WARM_FX_MAX) | 0;
    } else {
      illumWarmFx = 0;
    }
    // A NaN (a corrupt light) must not reach the level maths: the comparison fails and it becomes 0.
    return total < ILLUM_MAX ? (total > 0 ? total : 0) : ILLUM_MAX;
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
   * lit edge-on stays dark — without it, corridors look like flat cutouts. Also leaves the sconce
   * tint of the point in `illumWarmFx`.
   * @param {number} wx world x (already nudged off the face into the tile it faces)
   * @param {number} wy world y
   * @param {number} nx normal x (-1, 0 or 1)
   * @param {number} ny normal y (-1, 0 or 1)
   * @returns {number} 0..ILLUM_MAX before fog
   */
  function illumWall(wx, wy, nx, ny) {
    const dx = camX - wx;
    const dy = camY - wy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const inv = d > 1e-4 ? 1 / d : 0;
    let lam = (dx * inv * nx + dy * inv * ny) * WALL_LAMBERT + (1 - WALL_LAMBERT);
    if (lam < 0) lam = 0;
    let t = d * torchInvR;
    if (t > 1) t = 1;
    const own = AMBIENT + playerAttLut[(t * ATT_LUT_N) | 0] * torchPower * lam;
    let sconce = 0;
    const tx = wx | 0;
    const ty = wy | 0;
    for (let i = 0; i < lightN; i++) {
      const lx = lightX[i] - wx;
      const ly = lightY[i] - wy;
      const d2 = lx * lx + ly * ly;
      if (d2 > TORCH_RADIUS2) continue;
      // In the flame's line of sight? (see illumFlat) Faces turned away are the Lambert term's job.
      const vx = tx - lightOX[i];
      const vy = ty - lightOY[i];
      if (vx >>> 0 >= VIS_SPAN || vy >>> 0 >= VIS_SPAN) continue;
      if (torchVis[lightTorch[i] * VIS_AREA + vy * VIS_SPAN + vx] === 0) continue;
      const dl = Math.sqrt(d2);
      const li = dl > 1e-4 ? 1 / dl : 0;
      // Lambert: a face turned away from the flame stays dark, which is what makes a corner read.
      let face = (lx * li * nx + ly * li * ny) * 0.82 + 0.18;
      if (face <= 0) continue;
      if (face > 1) face = 1;
      sconce += attLut[(dl * INV_TORCH_RADIUS * ATT_LUT_N) | 0] * lightPow[i] * face;
    }
    return mixLight(own, sconce);
  }

  /**
   * Convert an illumination and a distance into a clamped 16.16 shade level.
   * @param {number} illum 0..ILLUM_MAX
   * @param {number} dist tiles from the eye
   * @param {number} scale extra multiplier (side shading, ceiling dimming)
   * @returns {number} level in [0, LEVEL_FX_MAX]
   */
  function levelFx(illum, dist, scale) {
    let fi = (dist * FOG_SCALE) | 0;
    if (fi < 0) fi = 0;
    else if (fi > FOG_LUT_MAX) fi = FOG_LUT_MAX;
    const v = illum * fogLut[fi] * scale * INV_ILLUM_MAX;
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
      // Sconce tint for the whole column: which light reaches a wall does not change up its height.
      const warmFx = illumWarmFx;
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
      const variant = WALL_VARIANT[hv & 15];
      const tIdx = wallTex[variant].indices;
      // A third use of the same hash: mirror the course horizontally on half the tiles. Four wall
      // paintings across 64 offsets already gave plenty of variety in a 13-tile corridor; at 257
      // tiles the eye starts to recognise individual blocks, and mirroring doubles the vocabulary
      // for one comparison per column — far cheaper than painting more textures, and it cannot
      // break the tiling, because the offset above has already displaced every joint anyway.
      if (hv & 0x100000) texX = TEX - 1 - texX;
      texX = (texX + ((hv >>> 8) & (TEX - 1))) & (TEX - 1);
      // No per-tile VERTICAL offset, deliberately. One used to slide each tile by whole 8-texel
      // steps to break up bright bevel "rails" along the course joints, but it made the joints jump
      // height at every tile seam, so each metre of wall read as a separate slab. Every variant now
      // shares one course table (`textures.js`) and texel rows are tied to world height, so courses
      // run unbroken along a wall — and round its corners — the way the reference's masonry does;
      // the rails are broken up by per-block bevel strength and tone in the painting instead.

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
        if (warmFx === 0) {
          // No sconce reaches this column — most of them, most frames — so skip the tint dither.
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
        } else {
          for (let y = from; y < to; y++) {
            const ty = (texPos >> 16) & (TEX - 1);
            texPos += stepFx;
            // As above, plus `(warm + dither') >> 16`: the tint block the level row sits in.
            const bk = ((y & 3) << 2) | bayerCol;
            let level = (cur + BAYER16[bk]) >> 16;
            if (level < 0) level = 0;
            else if (level > LEVEL_MAX) level = LEVEL_MAX;
            buf[pi] =
              colormap[(((warmFx + BAYER_W[bk]) >> 16) << WARM_SHIFT) | (level << 8) | tIdx[(ty << 6) | texX]];
            cur += curStep;
            pi += w;
          }
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
   * @param {import('../core/types.js').Maze} maze
   * @returns {void}
   */
  function renderFlats(maze) {
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
    const tiles = maze.tiles;
    const mw = maze.width;
    const mh = maze.height;
    const maxD = (horizon > h - horizon ? horizon : h - horizon) | 0;
    // Rows this far from the horizon are within ~1.5 tiles of the eye (see `BAYER_NEAR`).
    const nearD = (maxD * 0.7) | 0;

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
      // Picked per row, so the pixel loop gains no branch.
      const bayer = d > nearD ? BAYER_NEAR : BAYER16;
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
      let warm = illumWarmFx;
      let levF = levelFx(illum, rowDist, FLOOR_DIM);
      let levC = levelFx(illum, rowDist, CEIL_DIM);
      while (segStart < w) {
        let segEnd = segStart + LIGHT_SEG;
        if (segEnd > w) segEnd = w;
        const n = segEnd - segStart;
        const ex = wx + stepX * n;
        const ey = wy + stepY * n;
        const illum2 = illumFlat(ex, ey, rowLights, rowN);
        const warm2 = illumWarmFx;
        const levF2 = levelFx(illum2, rowDist, FLOOR_DIM);
        const levC2 = levelFx(illum2, rowDist, CEIL_DIM);
        // Light is smooth; interpolating it across the segment is indistinguishable from
        // evaluating it per pixel and an order of magnitude cheaper.
        const slopeF = ((levF2 - levF) / n) | 0;
        const slopeC = ((levC2 - levC) / n) | 0;
        const slopeW = ((warm2 - warm) / n) | 0;
        // With no sconce on either end of the segment the tint term is 0 on every pixel; a zero
        // dither table keeps it 0 without a second copy of this loop.
        const bayerW = (warm | warm2) === 0 ? BAYER_NONE : BAYER_W;

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
              flatMask = ((hv >>> 20) & 1 ? 63 << 6 : 0) | ((hv >>> 21) & 1 ? 63 : 0);
              // Ceiling timber runs ACROSS the corridor, with a beam every third tile along it. The
              // painting runs its planks and beam along +x, which is across a north-south corridor;
              // an east-west one (solid to the north and south) takes the transposed copy and counts
              // its beams along x instead — otherwise every third such corridor had a beam running
              // down its whole length, and all of them had lengthwise plank stripes.
              const inside = cx >= 0 && cy > 0 && cx < mw && cy < mh - 1;
              const eastWest =
                inside && tiles[(cy - 1) * mw + cx] !== TILE_FLOOR && tiles[(cy + 1) * mw + cx] !== TILE_FLOOR;
              const along = eastWest ? cx : cy;
              const beam = along - 3 * Math.floor(along / 3) === 0 ? 1 : 0;
              cIdx = eastWest ? ceilAcross[beam] : ceilTex[beam].indices;
            }
            const ti = (((fy >> 10) & 63) << 6) | ((fx >> 10) & 63);
            if (drawF) {
              const bk = bayerF | (x & 3);
              buf[rowF + x] =
                colormap[
                  (((warm + bayerW[bk]) >> 16) << WARM_SHIFT) |
                    (((levF + bayer[bk]) >> 16) << 8) |
                    fIdx[ti ^ flatMask]
                ];
            }
            if (drawC) {
              const bk = bayerC | (x & 3);
              buf[rowC + x] =
                colormap[
                  (((warm + bayerW[bk]) >> 16) << WARM_SHIFT) | (((levC + bayer[bk]) >> 16) << 8) | cIdx[ti]
                ];
            }
          }
          fx += fxStep;
          fy += fyStep;
          levF += slopeF;
          levC += slopeC;
          warm += slopeW;
        }

        wx = ex;
        wy = ey;
        levF = levF2;
        levC = levC2;
        warm = warm2;
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
   * @param {number} warm 16.16 sconce tint (0 for emissive art)
   * @param {number} dist2 squared distance from the camera, for sorting
   * @param {number} face mounting wall's outward-normal direction (0=E 1=S 2=W 3=N, as `Torch.face`),
   *   or -1 for a free-standing sprite
   * @param {number} off tiles the sprite stands in front of its mounting face (ignored when `face` is -1)
   * @returns {void}
   */
  function addSprite(x, y, tex, scale, vOff, level, warm, dist2, face, off) {
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
    sprWarm[i] = warm;
    sprDist[i] = dist2;
    sprWallK[i] = 0;
    if (face >= 0) {
      const nx = DIR_DX[face & 3];
      const ny = DIR_DY[face & 3];
      // Signed distance from the eye to the mounting face along its outward normal. Only an eye in
      // front of the wall can see the sconce at all; from behind, the wall itself hides it and the
      // honest z-test is already right.
      const eyeToWall = (camX - x) * nx + (camY - y) * ny + off;
      if (eyeToWall > 0) {
        sprWallK[i] = -eyeToWall;
        sprWallA[i] = dirX * nx + dirY * ny;
        sprWallB[i] = planeX * nx + planeY * ny;
      }
    }
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
    const flameFar2 = FAR * FAR;

    // Wall torches. The query radius is widened by `TORCH_SLACK` because the index keys a torch by
    // its tile centre while the flame hangs just outside the wall face. Flames reach `FAR`, not
    // `SPRITE_FAR` (see `FLAME_FOG_SCALE`).
    const torches = view.torches;
    const tReach = FAR + TORCH_SLACK;
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
          if (d2 > flameFar2 || !inFrustum(dx, dy)) continue;
          const phase = (t.x * 3 + t.y * 5) & 7;
          const frame = ((time * 11 + phase) | 0) & 3;
          // Emissive: the flame is a light source, so only distance dims it — through a thinner fog
          // than surfaces see (`FLAME_FOG_SCALE`), so a sconce down a dark corridor stays a beacon.
          const flick = 0.88 + 0.12 * tnoise(time * 9 + phase, 0x2c1a);
          const dist = Math.sqrt(d2);
          let fi = (dist * FLAME_FOG_SCALE * FOG_SCALE) | 0;
          if (fi > FOG_LUT_MAX) fi = FOG_LUT_MAX;
          let vis = fogLut[fi];
          if (dist > FLAME_FADE_FROM) {
            let u = (dist - FLAME_FADE_FROM) / (FAR - FLAME_FADE_FROM);
            if (u > 1) u = 1;
            vis *= 1 - u * u * (3 - 2 * u);
          }
          // Dimmed with the surface gammas, a distant flame drifted to the blue-grey of shadow. Fire
          // dims to deeper orange instead, so the flame moves along the tint axis as it recedes; up
          // close (visibility 1) it keeps its painted white-hot core.
          const flameWarm = ((1 - vis) * WARM_FX_MAX) | 0;
          // Scale 0.5 makes the sconce about half a tile tall; the offset lifts the flame to head
          // height, where a real wall bracket sits. Passing the mounting face is what stops the
          // billboard being sliced by the wall it is bolted to at a grazing angle (see
          // `renderSprites`).
          addSprite(
            x,
            y,
            textures.torch[frame],
            TORCH_SPRITE_SCALE,
            -0.17,
            levelFx(flick * vis, 0, 1), // distance 0: `vis` already carries the flame's own fog
            flameWarm,
            d2,
            face,
            TORCH_OFFSET,
          );
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
          // A flask under a sconce picks up the pool's amber like the cobbles around it. A gem does
          // not: its cyan is how a player spots one down a corridor, and under a full sconce tint
          // (blue × 0.3) it went olive — so it keeps its own colour, like the emissive sprites.
          const warm = isGem ? 0 : illumWarmFx;
          // Gems hover at knee height and bob; flasks stand on the floor. `vOff` is `0.5 - z`,
          // the world height of the sprite's centre below the eye.
          // Face -1: a gem or a flask stands free in the middle of a tile, so there is no mounting
          // surface to see past — it must z-test honestly.
          addSprite(
            it.x,
            it.y,
            frames[spin],
            isGem ? 0.34 : 0.42,
            (isGem ? 0.2 : 0.375) - bobZ,
            lvl,
            warm,
            d2,
            -1,
            0,
          );
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
          0, // emissive: the vortex is its own light
          d2,
          -1, // free-standing in the exit tile: no mounting surface
          0,
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
   *
   * ── Wall sprites and the z-test ──
   * A billboard carries one depth, `tY`, across its whole width, because it always turns to face
   * the eye. The wall a sconce is bolted to does not turn: at anything but a head-on view the half
   * of the billboard on the far side of the flame swings *behind* the wall plane, so an honest
   * `tY >= zbuf[x]` test rejects those columns against the very wall the torch hangs on and the
   * flame is cut off along a hard vertical line. Measured before this existed: a torch 1.1 tiles
   * away at a grazing heading lost 50 of its 109 columns and read as an orange rectangle, at exactly
   * the range a player reads a corridor torch.
   *
   * A constant depth bias would hide that, but it also lets real occluders within the bias through,
   * and the bias a grazing view needs grows with distance. The fix here is exact instead: for a wall
   * sprite each column tests `min(tY, depth at which this column's ray meets the mounting plane)`.
   * A billboard texel behind the wall plane is thereby drawn as if projected onto the wall (a decal,
   * which is what a flush-mounted flame looks like), and only geometry *in front of that plane* can
   * hide it. The mounting wall itself — and nothing else — stops counting as an occluder. It costs
   * one division per on-screen column of a wall sprite.
   * @returns {number} sprites that put at least one column on screen
   */
  function renderSprites() {
    const w = width;
    const h = height;
    const invW = 1 / w;
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
      // 16.16 shade level carried into the pixel loop so it can be ordered-dithered exactly like
      // the wall and flat passes. Quantising it once per sprite made a gem walked toward step
      // visibly between shade bands — the banding the 4×4 Bayer matrix exists everywhere else to
      // prevent. The cost is one table read and an add per sprite texel.
      const lvFx = sprLevel[i];
      const dither = lvFx >= FX_ONE ? BAYER16 : BAYER_NONE;
      const warmFx = sprWarm[i];
      const wallK = sprWallK[i];
      const wallA = sprWallA[i];
      const wallB = sprWallB[i];
      const stepFx = ((TEX / size) * FX_ONE) | 0;
      let texFx = ((x0 - leftF) * (TEX / size) * FX_ONE) | 0;
      const texYStart = ((y0 - topF) * (TEX / size) * FX_ONE) | 0;
      let any = false;

      for (let x = x0; x < x1; x++) {
        const tx = texFx >> 16;
        texFx += stepFx;
        if (tx < 0 || tx >= TEX) continue;
        let depthTest = tY;
        if (wallK < 0) {
          // Where this column's ray meets the mounting plane (same `cameraX` as the wall pass). A
          // ray running parallel to or away from the wall never meets it and keeps plain `tY`.
          const den = wallA + wallB * (2 * x * invW - 1);
          if (den < 0) {
            const onWall = wallK / den - SPRITE_WALL_EPS;
            if (onWall < depthTest) depthTest = onWall;
          }
        }
        if (depthTest >= zbuf[x]) continue; // hidden behind nearer geometry
        any = true;
        const bayerCol = x & 3;
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
            const bk = ((y & 3) << 2) | bayerCol;
            let level = (lvFx + dither[bk]) >> 16;
            if (level < 0) level = 0;
            else if (level > LEVEL_MAX) level = LEVEL_MAX;
            // Level 0 is the fog colour in every tint block, so a fogged-out sprite stays byte-exact
            // fog whatever its tint (the premise of `SPRITE_FAR`).
            buf[pi] = colormap[(((warmFx + BAYER_W[bk]) >> 16) << WARM_SHIFT) | (level << 8) | idx];
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
    renderFlats(maze);
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
    transposeCeilings(set);
  }

  /**
   * Fill `ceilAcross` with the set's plain and beamed ceilings mirrored across their diagonal. A set
   * with a single ceiling painting uses it for both.
   * @param {TextureSet} set
   * @returns {void}
   */
  function transposeCeilings(set) {
    const list = set.ceiling;
    for (let k = 0; k < 2; k++) {
      const src = list[k < list.length ? k : 0].indices;
      const out = ceilAcross[k];
      for (let v = 0; v < TEX; v++) {
        for (let u = 0; u < TEX; u++) out[(v << 6) | u] = src[(u << 6) | v];
      }
    }
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
