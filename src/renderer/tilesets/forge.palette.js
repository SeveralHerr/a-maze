// @ts-check
/**
 * @file Infernal Forge palette block — appended to the master palette by `../palette.js`.
 *
 * `[name, 0xRRGGBB, glow?]`, at most `TILESET_PALETTE_MAX` (28) entries, every name prefixed
 * `for` so no two tilesets collide. `glow: true` marks a self-lit colour (use sparingly). Ramps are
 * built in `./forge.js` with `ramp()` from the palette, dark → light.
 *
 * Basalt is a cool blue-black so the warm torchlight and the lava both separate from it; its top
 * steps are cool greys, because a bevel that only ever reaches dark grey turns the whole floor into a
 * black void once the colormap has shaded it. The lava ramp is the only glow in the set.
 *
 * PURE DATA: this file must not import anything (palette.js imports it).
 */
export default /** @type {Array<[string, number, boolean?]>} */ ([
  // ── Basalt / obsidian: cool blue-black stone, dark → light. ──────────────────────────────────
  ['forBasShadow', 0x09090c], // deepest joint
  ['forBasJoint', 0x131318],
  ['forBasDeep', 0x1e1f25],
  ['forBasDark', 0x2b2c34],
  ['forBasMid', 0x3a3c45],
  ['forBasBase', 0x4b4e58],
  ['forBasLight', 0x60646f],
  ['forBasBright', 0x7a7f8a],
  ['forBasHilite', 0x989ea8], // obsidian glint, bevel catch-light

  // ── Soot iron: warm near-black plate, dark → light. ──────────────────────────────────────────
  ['forIronShadow', 0x0d0b0b],
  ['forIronDark', 0x1a1716],
  ['forIronBase', 0x2a2624],
  ['forIronMid', 0x3c3633],
  ['forIronLight', 0x544c47],
  ['forIronHilite', 0x7a7069],

  // ── Heat stain: rock and iron discoloured by the magma beside it (NOT self-lit). ─────────────
  ['forScorchDark', 0x221009],
  ['forScorch', 0x3d170c],
  ['forEmber', 0x5e1f0c],

  // ── Magma: self-lit, the only glow on this floor. Thin seams and specks only. ────────────────
  ['forLavaDeep', 0x8a1a06, true],
  ['forLavaRed', 0xc8340a, true],
  ['forLavaOrange', 0xf06a14, true],
  ['forLavaHot', 0xffab33, true],
  ['forLavaCore', 0xffe38a, true],

  // ── Brass: pipe flanges and girder collars. ──────────────────────────────────────────────────
  ['forBrassDark', 0x3b2a16],
  ['forBrassMid', 0x6b4c26],
  ['forBrassLight', 0x9c7640],

  ['forFog', 0x140807], // smoky oxblood black the distance fades into
]);
