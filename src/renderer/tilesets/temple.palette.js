// @ts-check
/**
 * @file Sunken Temple palette block — appended to the master palette by `../palette.js`.
 *
 * `[name, 0xRRGGBB, glow?]`, at most `TILESET_PALETTE_MAX` (28) entries, every name prefixed
 * `tem` so no two tilesets collide. `glow: true` marks a self-lit colour (use sparingly). Ramps are
 * built in `./temple.js` with `ramp()` from the palette, dark → light.
 *
 * Pale limestone ashlar (the dominant material), a yellower drift sand, terracotta floor tiles,
 * and the worn pigments of the temple's painted inlay: turquoise and lapis. Gold leaf borrows the
 * shared `gold*` ramp. Fog is a dusky teal-grey so the warm stone separates from the distance. No
 * glow colours: nothing buried here gives off light of its own.
 *
 * PURE DATA: this file must not import anything (palette.js imports it).
 */
export default /** @type {Array<[string, number, boolean?]>} */ ([
  ['temFog', 0x0c1517], // dusky teal-grey the distance fades into

  // ── Limestone: pale ashlar, cornice, coffers; steps 0–1 are joints and deep recesses. ───────
  // Only faintly warm (r−b ≈ +16): the torch colormap supplies the rest. A sandy-orange ramp under
  // that tint read in game as varnished timber panelling rather than stone.
  ['temSandShadow', 0x151310],
  ['temSandMortar', 0x27231e],
  ['temSandDeep', 0x3d3831],
  ['temSandDark', 0x565048],
  ['temSandMid', 0x716a5f],
  ['temSandBase', 0x8c8579],
  ['temSandLight', 0xa69f92],
  ['temSandBright', 0xc0b9ab],
  ['temSandHilite', 0xd9d3c5],

  // ── Drift sand: yellower than the stone, piled in joints and against the walls. ────────────
  ['temDuneDark', 0x6b5634],
  ['temDuneMid', 0x917846],
  ['temDuneLight', 0xb59b5f],

  // ── Terracotta: floor mosaic tiles and red-ochre paint. ────────────────────────────────────
  ['temTerraShadow', 0x2e140c],
  ['temTerraDark', 0x542617],
  ['temTerraMid', 0x7b3a22],
  ['temTerraBase', 0x9d5231],
  ['temTerraLight', 0xbb7049],

  // ── Turquoise: worn painted inlay in the frieze and the sun mosaic. ────────────────────────
  ['temTurqDeep', 0x0f3434],
  ['temTurqMid', 0x1d605b],
  ['temTurqLight', 0x348c80],
  ['temTurqPale', 0x6cbca8],

  // ── Lapis: the deep blue of the wing feathers and mosaic ground. ───────────────────────────
  ['temLapisDeep', 0x141d3a],
  ['temLapisMid', 0x243a6e],
]);
