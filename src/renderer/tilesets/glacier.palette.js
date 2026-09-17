// @ts-check
/**
 * @file Frozen Depths palette block — appended to the master palette by `../palette.js`.
 *
 * `[name, 0xRRGGBB, glow?]`, at most `TILESET_PALETTE_MAX` (28) entries, every name prefixed
 * `gla` so no two tilesets collide. `glow: true` marks a self-lit colour (use sparingly). Ramps are
 * built in `./glacier.js` with `ramp()` from the palette, dark → light.
 *
 * Three ramps: a blue-black frozen rock, a translucent glacier ice that runs from an abyssal blue
 * up to a near-white glint (its middle steps are kept light on purpose, so warm torchlight has
 * something to catch), and a cold snow/hoarfrost ramp. Nothing glows: ice reflects, it does not shine.
 *
 * PURE DATA: this file must not import anything (palette.js imports it).
 */
export default /** @type {Array<[string, number, boolean?]>} */ ([
  ['glaFog', 0x081420], // cold deep navy-cyan the distance fades into

  // ── Frozen rock: blue-black blocks, a notch darker than the Keep's stone. ────────────────────
  ['glaRockShadow', 0x0b1019],
  ['glaRockDeep', 0x161e2b],
  ['glaRockDark', 0x232d3d],
  ['glaRockMid', 0x323f52],
  ['glaRockBase', 0x435368],
  ['glaRockLight', 0x566a82],
  ['glaRockBright', 0x6c839c],

  // ── Glacier ice: abyssal blue → pale glint. ──────────────────────────────────────────────────
  // Blue with green held near red, not cyan: sconce light multiplies r×1.38 g×0.86 b×0.45, and a
  // cyan ice (g ≫ r) came out of that as olive drab. This ramp lands on steel grey → pale gold.
  ['glaIceAbyss', 0x151f38],
  ['glaIceDeep', 0x203256],
  ['glaIceDark', 0x2d4a72],
  ['glaIceMid', 0x40648f],
  ['glaIceBase', 0x567fab],
  ['glaIceLight', 0x719cc4],
  ['glaIceBright', 0x91b8d8],
  ['glaIcePale', 0xb5d3e9],
  ['glaIceSpec', 0xdcecf7],

  // ── Snow & hoarfrost: drifted into gaps, rimed on stone. ─────────────────────────────────────
  ['glaSnowShadow', 0x71869b],
  ['glaSnowMid', 0x98aabc],
  ['glaSnowLight', 0xbecbd8],
  ['glaSnowWhite', 0xe4ecf3],
]);
