// @ts-check
/**
 * @file Fungal Grotto palette block — appended to the master palette by `../palette.js`.
 *
 * `[name, 0xRRGGBB, glow?]`, at most `TILESET_PALETTE_MAX` (28) entries, every name prefixed
 * `gro` so no two tilesets collide. `glow: true` marks a self-lit colour (use sparingly). Ramps are
 * built in `./grotto.js` with `ramp()` from the palette, dark → light.
 *
 * Cave rock is a purple-brown ramp with a cooler slate ramp for the alternate strata; the floor is
 * a brown loam; four glow colours (cyan and violet, each with a pale core) are the fungus and spore
 * light, backed by two unlit cap shades and a pale stem ramp.
 *
 * PURE DATA: this file must not import anything (palette.js imports it).
 */
export default /** @type {Array<[string, number, boolean?]>} */ ([
  ['groFog', 0x0c0a16], // deep indigo-violet black the cave fades into

  // ── Cave rock: purple-brown, dark → light. ──────────────────────────────────────────────────
  ['groRock0', 0x140f18],
  ['groRock1', 0x221a27],
  ['groRock2', 0x322735],
  ['groRock3', 0x443545],
  ['groRock4', 0x574556],
  ['groRock5', 0x6b5767],
  ['groRock6', 0x826b7b],
  ['groRock7', 0x9c8591],
  ['groRock8', 0xb9a3ab],

  // ── Slate strata: the cooler bands between the purple-brown ones. ───────────────────────────
  ['groSlate0', 0x2c2e40],
  ['groSlate1', 0x3e4155],
  ['groSlate2', 0x53576c],
  ['groSlate3', 0x6a6f85],
  ['groSlate4', 0x878ca0],

  // ── Damp loam: the cave floor's earth. ──────────────────────────────────────────────────────
  ['groLoam0', 0x1e1714],
  ['groLoam1', 0x30251e],
  ['groLoam2', 0x45362b],
  ['groLoam3', 0x5c4a3b],

  // ── Fungus: stems, unlit caps and lichen, and the four self-lit glow colours. ───────────────
  ['groStemDark', 0x8a7f73],
  ['groStemPale', 0xd4cab4],
  ['groCapTeal', 0x1f5d66],
  ['groCapPurple', 0x4d2e72],
  ['groGlowCyan', 0x3fe6d2, true],
  ['groGlowMint', 0xc4fff2, true],
  ['groGlowViolet', 0xae72ff, true],
  ['groGlowLilac', 0xe6c8ff, true],
]);
