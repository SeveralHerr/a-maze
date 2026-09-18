// @ts-check
/**
 * @file Master palette — every pixel A-MAZE draws comes from this table (ARCHITECTURE.md §4.5).
 *
 * WHY an *indexed* palette rather than free-form colours: the raycaster shades pixels through a
 * Doom-style **colormap** — a precomputed `LEVELS × PALETTE_SIZE` table of already-packed RGBA
 * words (see `raycaster.js`). Shading one texel is then a single typed-array lookup instead of
 * three float multiplies plus a pack, which is what keeps a 480×240 frame inside ~3 ms of plain
 * JS. That only works if every texel is a palette *index*, so all art in `textures.js` is painted
 * with the `C.*` indices exported here, and nothing anywhere invents an off-palette colour.
 *
 * Colours were sampled from `docs/art-reference.png`: cool blue-grey stone, grey
 * cobbles, dark brown ceiling timber, creeping green moss, and a warm fire ramp that is the only
 * saturated warm light in the scene. Each material is a *ramp* (a short ordered run of related
 * shades) so textures can dither between neighbouring steps instead of banding.
 *
 * Units & invariants:
 * - Index `0` is the **transparency key**: fully transparent, never drawn by any blit. Sprite art
 *   leaves it as the background; wall/floor/ceiling art must never use it.
 * - `PALETTE[i]` is a 32-bit word in **native byte order**, ready to store straight into a
 *   `Uint32Array` view of `ImageData.data` (RGBA bytes). Endianness is detected at load, so the
 *   engine is correct on a big-endian host too, even though every shipping target is little-endian.
 * - `PALETTE_SIZE` must stay ≤ 256: the colormap indexes with `(level << 8) | paletteIndex`.
 * - Ramps are ordered **dark → light**.
 *
 * This module has no state and no DOM dependency, so it imports cleanly in Node for unit tests.
 */

/**
 * True when the host stores the low byte of a 32-bit word first. A `Uint32Array` view over
 * `ImageData.data` then reads/writes bytes in the order R,G,B,A ⇒ the packed word is 0xAABBGGRR.
 * @type {boolean}
 */
export const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Pack a colour into one native-endian word suitable for a `Uint32Array` view of `ImageData`.
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @param {number} [a] 0..255, default 255 (opaque)
 * @returns {number} uint32
 */
export function pack(r, g, b, a = 255) {
  const rr = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  const gg = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  const bb = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  const aa = a < 0 ? 0 : a > 255 ? 255 : a | 0;
  return LITTLE_ENDIAN
    ? ((aa << 24) | (bb << 16) | (gg << 8) | rr) >>> 0
    : ((rr << 24) | (gg << 16) | (bb << 8) | aa) >>> 0;
}

import CISTERN from './tilesets/cistern.palette.js';
import OSSUARY from './tilesets/ossuary.palette.js';
import GROTTO from './tilesets/grotto.palette.js';
import TEMPLE from './tilesets/temple.palette.js';
import GLACIER from './tilesets/glacier.palette.js';
import FORGE from './tilesets/forge.palette.js';

/**
 * Most palette slots one tileset's block may take (`src/renderer/tilesets/*.palette.js`). Six blocks
 * of 28 on top of the ~80 shared entries stays inside the 256 the colormap can index.
 */
export const TILESET_PALETTE_MAX = 28;

/**
 * Authored palette: `[name, 0xRRGGBB]`, in ramp order. The array order *is* the index order, so
 * inserting a colour in the middle renumbers everything — append to a ramp's end instead, or
 * accept that saved screenshots change (nothing is persisted by index, so that is safe).
 * @type {ReadonlyArray<readonly [string, number]>}
 */
const SHARED_ENTRIES = /** @type {ReadonlyArray<readonly [string, number, boolean?]>} */ ([
  // 0 — transparency key. Its RGB is irrelevant (alpha 0) but kept as the fog colour so a
  // careless opaque blit of index 0 degrades to "distant darkness" rather than to a magenta hole.
  ['empty', 0x0a0e18],

  // ── Stone: cool blue-grey blocks, the dominant material (walls). ─────────────────────────────
  ['stoneShadow', 0x11161f], // inside the mortar groove
  ['stoneMortar', 0x1d2433], // mortar line (dark navy, as in the reference)
  ['stoneDeep', 0x2b3446],
  ['stoneDark', 0x3e4b5f],
  ['stoneMid', 0x56657a],
  ['stoneBase', 0x6d7d92], // average block face
  ['stoneLight', 0x8a9bb0],
  ['stoneBright', 0xa6b5c7],
  ['stoneHilite', 0xc3ced9], // top-left bevel

  // ── Moss & vines: the only cool-green in the scene, grows out of mortar and floor gaps. ──────
  ['mossShadow', 0x12200f],
  ['mossDeep', 0x27491f],
  ['mossMid', 0x3d672a],
  ['mossLight', 0x5e8a37],
  ['mossTip', 0x86a852],

  // ── Cobbles: stone-grey floor with near-black gaps. ──────────────────────────────────────────
  // A barely warm grey, not brown: the reference's cobbles read warm only where torchlight falls on
  // them (r−b ≈ +9 overall), and the sconce tint in the colormap supplies that. The old brown ramp
  // under a warm-by-brightness colormap read as tan sand (r−b +48…+83 on the lit floor).
  ['cobGap', 0x100f0f],
  ['cobShadow', 0x1f1d1c],
  ['cobDark', 0x32302e],
  ['cobMid', 0x464442],
  ['cobBase', 0x5a5855],
  ['cobLight', 0x72706c],
  ['cobBright', 0x8a8883],
  ['cobHilite', 0xa4a19c], // worn/wet top of a stone

  // ── Timber: ceiling planks and beams. ────────────────────────────────────────────────────────
  ['woodShadow', 0x140c06],
  ['woodDark', 0x22160c],
  ['woodMid', 0x3a2618],
  ['woodBase', 0x4a3020],
  ['woodLight', 0x5a3a22],
  ['woodBright', 0x7a5230],
  ['woodHilite', 0x96683c],

  // ── Iron: sconces, floor grates, bolts. ──────────────────────────────────────────────────────
  ['ironShadow', 0x0f1116],
  ['ironDark', 0x1c1f26],
  ['ironBase', 0x2f343d],
  ['ironLight', 0x474d58],
  ['ironHilite', 0x6b7280],

  // ── Fire: torch flames. Emissive — drawn at full colormap level. ─────────────────────────────
  ['fireDeep', 0x7a2408],
  ['fireEmber', 0xc2410c],
  ['fireMid', 0xff8a1e],
  ['fireHot', 0xffcf4a],
  ['fireCore', 0xfff3c4],

  // ── Arcane: the exit portal's violet→cyan swirl. ─────────────────────────────────────────────
  ['arcDeep', 0x1b0f3a],
  ['arcViolet', 0x4c1d95],
  ['arcMid', 0x7c3aed],
  ['arcLight', 0xa78bfa],
  ['arcCyan', 0x22d3ee],
  ['arcPale', 0xa5f3fc],

  // ── Gem: faceted cyan crystal with an emerald core. ──────────────────────────────────────────
  ['gemDeep', 0x06323f],
  ['gemMid', 0x0e7490],
  ['gemBright', 0x22d3ee],
  ['gemPale', 0xa5f3fc],
  ['gemSpec', 0xecfeff],
  ['emeraldDeep', 0x064e3b],
  ['emeraldMid', 0x10b981],

  // ── Oil flask: amber glass. ──────────────────────────────────────────────────────────────────
  ['oilDeep', 0x33190a],
  ['oilDark', 0x7c3f0a],
  ['oilMid', 0xc97a16],
  ['oilLight', 0xf0b040],
  ['oilPale', 0xffe6a8],

  // ── Gold / parchment: gothic lettering and UI trim (§4.6 samples these). ─────────────────────
  ['goldDark', 0x3a2a0d],
  ['goldMid', 0x8a6520],
  ['goldBase', 0xc9962f],
  ['goldLight', 0xe8c24a],
  ['goldPale', 0xf7e3a1],

  // ── Ambient: what "no light" looks like, plus a pure white for speculars/particles. ──────────
  ['fog', 0x0a0e18], // cool blue-black the colormap fades everything into
  ['void', 0x05070c], // deepest shadow, below fog
  ['white', 0xffffff],

  // ── Map scroll: aged parchment rolled and tied with a red wax-sealed ribbon (§4.8). ──────────
  // Appended after the ambient block rather than slotted in beside gold, so no existing index moves.
  // Deliberately desaturated and a notch darker than `gold*`: the scroll is the one pickup that is
  // meant to be *looked for*, so it must not read as a warm light source down a torch-lit corridor.
  ['mapShadow', 0x2e1d10], // the hollow of the roll and the underside that touches the floor
  ['mapDark', 0x5c4127], // tan in shadow
  ['mapMid', 0x8f7049], // tan body
  ['mapLight', 0xa98e63], // cream-tan lit face
  ['mapPale', 0xcbb68c], // worn cream highlight along the top of the roll
  ['sealShadow', 0x240808], // knot crease, wax rim
  ['sealDark', 0x4a0f0d], // ribbon in shadow
  ['sealMid', 0x7a1a14], // ribbon & wax body
  ['sealLight', 0xa8352a], // the one lit bead on the wax

  // ── Chalk: the player's A-MAZE scrawls on the walls (§4.9). Appended, so no index moves. ─────
  // Bone white rather than pure white or blue-grey: the blue-grey faded into the cold stone at a
  // corridor's length, and a pure white read as a light source rather than a mark on the wall.
  ['chalkDust', 0x76726a], // powder smeared around a stroke
  ['chalkSmudge', 0xa7a398], // a stroke's broken edge
  ['chalkMid', 0xd5d1c5], // the body of a stroke
  ['chalkPale', 0xf4f0e3], // where the chalk bit hardest

  // ── New Descent (§4.11). Appended, so no existing index moves. ──────────────────────────────
  // The two creatures are separated on the WARM/COOL axis rather than by hue alone, because at 240p
  // under a guttering torch that is the only difference a player can read at corridor distance: the
  // crawler takes the firelight like the cobbles do, the wraith refuses it.
  ['chitinShadow', 0x1b0f0a], // under the carapace, and the outline
  ['chitinDark', 0x3a2014],
  ['chitinMid', 0x5e3720], // the body
  ['chitinLight', 0x8a5430],
  ['chitinPale', 0xb8793f], // the wet highlight along the shell's ridge
  ['shroudShadow', 0x14161f], // the hollow of the hood — the darkest thing in the game
  ['shroudDark', 0x2a3040],
  ['shroudMid', 0x4a5468], // the robe
  ['shroudLight', 0x7d8798],
  ['shroudPale', 0xb9c2cd], // the one cold highlight on a shoulder
  // Two bright steps on top of the existing `iron` ramp: a blade has to out-shine every wall in the
  // frame or it reads as a grey stick held in front of the camera.
  ['steelPale', 0xcdd6e0],
  ['steelGlint', 0xf2f6fb],
  // Eyes, and the ONLY two glow colours outside a tileset block. `PALETTE_GLOW` stops the colormap
  // shading them below `GLOW_MIN_LIGHT`, so a creature's eyes stay lit at the edge of the torch
  // while the body around them goes to fog — which is what lets a thing resolve out of the dark
  // eyes-first instead of arriving fully painted (§4.11). They are their own entries rather than
  // `fireCore`/`arcPale` because marking those would make every flame and every gem self-lit too.
  ['eyeEmber', 0xffb648, true],
  ['eyeCold', 0x9beaf6, true],
  // The gauntlet holding the sword: dark leather over steel, so the hand reads against the blade.
  ['gauntShadow', 0x15171d],
  ['gauntDark', 0x2a2f3a],
  ['gauntMid', 0x454c5a],
  ['gauntLight', 0x6b7486],
]);

/**
 * The deeper floors' tilesets (`src/renderer/tilesets/`), appended in floor order after the shared
 * entries. Each block is `[name, 0xRRGGBB, glow?]`; `glow` marks a self-lit texel (lava, fungus,
 * rune light) that the colormap keeps bright in the dark (see `PALETTE_GLOW`).
 */
const TILESET_BLOCKS = [CISTERN, OSSUARY, GROTTO, TEMPLE, GLACIER, FORGE];
for (const block of TILESET_BLOCKS) {
  if (block.length > TILESET_PALETTE_MAX) throw new Error(`palette: a tileset block has ${block.length} > ${TILESET_PALETTE_MAX} entries`);
}

/** Shared entries, then every tileset block. @type {ReadonlyArray<readonly [string, number, boolean?]>} */
const ENTRIES = SHARED_ENTRIES.concat(...TILESET_BLOCKS);
if (ENTRIES.length > 256) throw new Error(`palette: ${ENTRIES.length} entries exceed the 256 the colormap indexes`);

/** Number of palette slots, including the transparency key at index 0. */
export const PALETTE_SIZE = ENTRIES.length;

/** Palette colours packed for direct framebuffer stores. `PALETTE[0]` is transparent (alpha 0). */
export const PALETTE = new Uint32Array(PALETTE_SIZE);

/** Flat RGB bytes, `i*3 + {0,1,2}` — what the colormap builder reads. */
export const PALETTE_RGB = new Uint8Array(PALETTE_SIZE * 3);

/** Palette names in index order (diagnostics, tests, the preview's swatch sheet). */
export const PALETTE_NAMES = /** @type {ReadonlyArray<string>} */ (ENTRIES.map((e) => e[0]));

/**
 * 1 = a self-lit colour: the colormap never shades it below `GLOW_MIN_LIGHT` (raycaster.js), so a
 * lava seam or a glowing fungus stays visible down a dark corridor. Only tileset blocks set it.
 */
export const PALETTE_GLOW = new Uint8Array(PALETTE_SIZE);

/** @type {Record<string, number>} */
const indexByName = Object.create(null);

for (let i = 0; i < PALETTE_SIZE; i++) {
  const [name, rgb, glow] = ENTRIES[i];
  if (indexByName[name] !== undefined) throw new Error(`palette: duplicate colour name "${name}"`);
  PALETTE_GLOW[i] = glow === true ? 1 : 0;
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  PALETTE[i] = i === 0 ? pack(r, g, b, 0) : pack(r, g, b, 255);
  PALETTE_RGB[i * 3] = r;
  PALETTE_RGB[i * 3 + 1] = g;
  PALETTE_RGB[i * 3 + 2] = b;
  indexByName[name] = i;
}

/**
 * Palette indices by name — the vocabulary `textures.js` paints with, e.g. `C.stoneMid`.
 * Frozen so a typo like `C.stonMid` reads as `undefined` and blows up loudly in a test rather
 * than silently painting index 0 (a transparent hole) into a wall.
 * @type {Readonly<Record<string, number>>}
 */
export const C = Object.freeze(indexByName);

/** The transparency key. Sprites leave it untouched; `blit` skips it. */
export const TRANSPARENT = 0;

/**
 * Build a ramp (ordered dark → light) from palette names.
 * @param {...string} names
 * @returns {Uint8Array} palette indices
 */
export function ramp(...names) {
  const out = new Uint8Array(names.length);
  for (let i = 0; i < names.length; i++) {
    const idx = indexByName[names[i]];
    // A missing name is a programming error in this file; fail at load, not at paint time.
    if (idx === undefined) throw new Error(`palette: unknown colour "${names[i]}"`);
    out[i] = idx;
  }
  return out;
}

/**
 * Material ramps, dark → light. Textures pick a step with `rampPick()` (ordered dither), which is
 * why every ramp is an evenly-spaced perceptual run: dithering between neighbours must not show a
 * hue jump.
 * `map` is the parchment of the hidden map scroll; `seal` is its dark red ribbon and wax accent.
 * `chalk` is the player's wall lettering (§4.9).
 * @type {Readonly<Record<'stone'|'moss'|'cobble'|'wood'|'iron'|'fire'|'arcane'|'gem'|'oil'|'gold'|'map'|'seal'|'chalk', Uint8Array>>}
 */
export const RAMPS = Object.freeze({
  stone: ramp(
    'stoneShadow',
    'stoneMortar',
    'stoneDeep',
    'stoneDark',
    'stoneMid',
    'stoneBase',
    'stoneLight',
    'stoneBright',
    'stoneHilite',
  ),
  moss: ramp('mossShadow', 'mossDeep', 'mossMid', 'mossLight', 'mossTip'),
  cobble: ramp(
    'cobGap',
    'cobShadow',
    'cobDark',
    'cobMid',
    'cobBase',
    'cobLight',
    'cobBright',
    'cobHilite',
  ),
  wood: ramp(
    'woodShadow',
    'woodDark',
    'woodMid',
    'woodBase',
    'woodLight',
    'woodBright',
    'woodHilite',
  ),
  iron: ramp('ironShadow', 'ironDark', 'ironBase', 'ironLight', 'ironHilite'),
  fire: ramp('fireDeep', 'fireEmber', 'fireMid', 'fireHot', 'fireCore'),
  arcane: ramp('arcDeep', 'arcViolet', 'arcMid', 'arcLight', 'arcCyan', 'arcPale'),
  gem: ramp('gemDeep', 'gemMid', 'gemBright', 'gemPale', 'gemSpec'),
  oil: ramp('oilDeep', 'oilDark', 'oilMid', 'oilLight', 'oilPale'),
  gold: ramp('goldDark', 'goldMid', 'goldBase', 'goldLight', 'goldPale'),
  map: ramp('mapShadow', 'mapDark', 'mapMid', 'mapLight', 'mapPale'),
  seal: ramp('sealShadow', 'sealDark', 'sealMid', 'sealLight'),
  chalk: ramp('chalkDust', 'chalkSmudge', 'chalkMid', 'chalkPale'),
  // New Descent (§4.11). `steel` extends `iron` rather than replacing it, so the sword and the
  // dungeon's ironwork stay the same metal — it is just polished.
  chitin: ramp('chitinShadow', 'chitinDark', 'chitinMid', 'chitinLight', 'chitinPale'),
  shroud: ramp('shroudShadow', 'shroudDark', 'shroudMid', 'shroudLight', 'shroudPale'),
  steel: ramp('ironShadow', 'ironDark', 'ironBase', 'ironLight', 'ironHilite', 'steelPale', 'steelGlint'),
  gauntlet: ramp('gauntShadow', 'gauntDark', 'gauntMid', 'gauntLight'),
});

/** Every packed colour, for O(1) "is this on-palette?" checks in tests. */
const PACKED_SET = new Set(PALETTE);

/**
 * True when `color` is one of the packed palette words. Used by the texture tests to prove no
 * blending or off-palette colour ever reaches a texture buffer.
 * @param {number} color uint32 in native byte order
 * @returns {boolean}
 */
export function isPaletteColor(color) {
  return PACKED_SET.has(color >>> 0);
}

/**
 * `#rrggbb` string for a palette index — for CSS-side consumers (post.js, the preview page) that
 * cannot use packed words. Out-of-range indices return the fog colour rather than throwing, so a
 * bad index degrades to "dark" instead of breaking a style string.
 * @param {number} index
 * @returns {string}
 */
export function hex(index) {
  const i = index >= 0 && index < PALETTE_SIZE ? index | 0 : C.fog;
  const r = PALETTE_RGB[i * 3];
  const g = PALETTE_RGB[i * 3 + 1];
  const b = PALETTE_RGB[i * 3 + 2];
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * `rgba(r,g,b,a)` string for a palette index at a given alpha — the form post.js needs for
 * gradients and tints.
 * @param {number} index
 * @param {number} alpha 0..1 (clamped)
 * @returns {string}
 */
export function rgba(index, alpha) {
  const i = index >= 0 && index < PALETTE_SIZE ? index | 0 : C.fog;
  const a = alpha <= 0 ? 0 : alpha >= 1 ? 1 : alpha;
  return `rgba(${PALETTE_RGB[i * 3]},${PALETTE_RGB[i * 3 + 1]},${PALETTE_RGB[i * 3 + 2]},${
    Math.round(a * 1000) / 1000
  })`;
}

/**
 * Nearest palette index to an RGB triple by squared Euclidean distance in sRGB. Authoring aid
 * (never used per frame): lets a texture routine quantise a computed colour onto the palette.
 * Index 0 is excluded — it is a transparency key, not a colour.
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @returns {number} palette index ≥ 1
 */
export function nearestIndex(r, g, b) {
  let best = 1;
  let bestD = Infinity;
  for (let i = 1; i < PALETTE_SIZE; i++) {
    const dr = r - PALETTE_RGB[i * 3];
    const dg = g - PALETTE_RGB[i * 3 + 1];
    const db = b - PALETTE_RGB[i * 3 + 2];
    // Weighted to match human luminance sensitivity; plain Euclidean picks muddy greens.
    const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
