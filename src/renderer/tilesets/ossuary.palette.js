// @ts-check
/**
 * @file Ossuary palette block — appended to the master palette by `../palette.js`.
 *
 * `[name, 0xRRGGBB, glow?]`, at most `TILESET_PALETTE_MAX` (28) entries, every name prefixed
 * `oss` so no two tilesets collide. `glow: true` marks a self-lit colour (use sparingly). Ramps are
 * built in `./ossuary.js` with `ramp()` from the palette, dark → light.
 *
 * Catacombs: ochre/umber sandstone, ivory bone, dusty umber earth, a cool faded plaster (so it
 * separates from bone under warm torchlight) and one faded red-ochre pigment. Nothing glows.
 *
 * PURE DATA: this file must not import anything (palette.js imports it).
 */
export default /** @type {Array<[string, number, boolean?]>} */ ([
  ['ossFog', 0x110d0a], // warm dusty brown-black the distance fades into

  // Sandstone: walls, flagstones, hewn ceiling rock. Nine even steps, dark → light.
  ['ossSandShadow', 0x16110d],
  ['ossSandMortar', 0x251d17],
  ['ossSandDeep', 0x3a2e24],
  ['ossSandDark', 0x534335],
  ['ossSandMid', 0x6c5b48],
  ['ossSandBase', 0x86745d],
  ['ossSandLight', 0xa08d73],
  ['ossSandBright', 0xb8a68a],
  ['ossSandHilite', 0xcfbfa3],

  // Bone: skulls, long-bone ends, fragments. Yellower than plaster.
  ['ossBoneShadow', 0x2e2519],
  ['ossBoneDark', 0x5a4b36],
  ['ossBoneMid', 0x8a7a5f],
  ['ossBoneBase', 0xb2a283],
  ['ossBoneLight', 0xd2c5a3],
  ['ossBonePale', 0xece2c4],

  // Packed earth: floor dust, gaps between flags.
  ['ossEarthGap', 0x120d0a],
  ['ossEarthShadow', 0x21180f],
  ['ossEarthDark', 0x342619],
  ['ossEarthMid', 0x4a3824],
  ['ossEarthBase', 0x5f4a33],
  ['ossEarthLight', 0x786045],

  // Faded plaster / limestone grave slab: a cooler grey.
  ['ossPlasterShadow', 0x5b544a],
  ['ossPlasterDark', 0x7a7266],
  ['ossPlasterMid', 0x989082],
  ['ossPlasterLight', 0xb4ab9a],

  // Red-ochre pigment, the faded painted band on old plaster.
  ['ossOchre', 0x7d3b1f],
]);
