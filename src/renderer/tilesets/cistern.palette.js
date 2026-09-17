// @ts-check
/**
 * @file Flooded Cistern palette block — appended to the master palette by `../palette.js`.
 *
 * `[name, 0xRRGGBB, glow?]`, at most `TILESET_PALETTE_MAX` (28) entries, every name prefixed
 * `cis` so no two tilesets collide. `glow: true` marks a self-lit colour (use sparingly). Ramps are
 * built in `./cistern.js` with `ramp()` from the palette, dark → light.
 *
 * Green-grey/teal brick, a worn grey-green flagstone, algae slime, chalky limescale and a dark teal
 * water ramp whose top step is the pale glint a puddle throws back. No glow colours: nothing in a
 * cistern gives off light of its own.
 *
 * PURE DATA: this file must not import anything (palette.js imports it).
 */
export default /** @type {Array<[string, number, boolean?]>} */ ([
  ['cisFog', 0x0a1917], // deep green-teal murk the distance fades into

  // ── Brick: small slimy green-grey bricks; steps 0–1 are the wet mortar. ─────────────────────
  ['cisBrickShadow', 0x0b1818],
  ['cisBrickMortar', 0x142623],
  ['cisBrickDeep', 0x203a35],
  ['cisBrickDark', 0x2f5047],
  ['cisBrickMid', 0x41675b],
  ['cisBrickBase', 0x578070],
  ['cisBrickLight', 0x719a88],
  ['cisBrickHilite', 0x93b6a4],

  // ── Slime: blue-green algae below the waterline and in floor joints. ────────────────────────
  ['cisSlimeDeep', 0x14331f],
  ['cisSlimeMid', 0x225a2f],
  ['cisSlimeLight', 0x3a8042],
  ['cisSlimeTip', 0x68a856],

  // ── Limescale: the chalky tideline crust and calcite drips. ─────────────────────────────────
  ['cisLimeDark', 0x6b7669],
  ['cisLimeMid', 0x979f90],
  ['cisLimePale', 0xc3c8b5],

  // ── Flagstone: worn grey-green floor slabs and the stone of the vault ribs. ─────────────────
  ['cisFlagGap', 0x0f1413],
  ['cisFlagShadow', 0x1f2624],
  ['cisFlagDark', 0x303d39],
  ['cisFlagMid', 0x44544e],
  ['cisFlagBase', 0x5a6b64],
  ['cisFlagLight', 0x72857c],
  ['cisFlagBright', 0x90a198],

  // ── Water: standing puddles, the drain's black water, the glint of a drip. ──────────────────
  ['cisWaterDeep', 0x152a2b],
  ['cisWaterMid', 0x3a6164],
  ['cisWaterLight', 0x62938f],
  ['cisWaterGlint', 0xa6d2c8],

  // ── Rust bleeding from iron rings and grates (the dark step borrows the shared oilDark). ────
  ['cisRust', 0x7a4a26],
]);
