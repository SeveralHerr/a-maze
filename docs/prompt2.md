# Prompt: New Descent game mode

Add a second game mode. The title screen offers two entries — **New Descent** and **Classic
Descent** — and nothing else above them.

## Mode split
- **Classic Descent** is today's game, unchanged. No behaviour regressions.
- **New Descent** is the combat mode described below.
- Each mode has its own Shrine, its own boons and its own saved progress (purse, ranks, boon
  level). They never share a purse. Remove the Shrine from the title screen — you reach a mode's
  Shrine only from inside that mode.

## New Descent
- Two enemy types, high-quality animated sprites.
- The player has an animated sword with a real attack animation, driven by an on-screen attack
  button.
- Move the minimap to the top right to make room for the attack button.
- No Auto Explore in this mode — hide the button, ignore the setting, and don't let the
  autopilot path run.

## How to build it
Implement in this order, and after each of the three pieces — enemy type 1, enemy type 2, the
player attack — run this loop **twice**:

1. Take a screenshot of it in the running game.
2. Look at the screenshot and pick the three weakest things.
3. Fix those three things.

So six screenshot-and-improve rounds total.

## Rules to respect
- Update `ARCHITECTURE.md` first (types, signatures, allowed imports), then write the code.
- Keep module isolation: cross-module seams, `src/main.js`, `index.html` and `styles.css` are
  integrator territory.
- Zero allocations per frame in the raycaster and sim hot paths. Enemies go through the existing
  sprite spatial index — nothing O(items) or O(tiles) per frame or per step, at the 128×128 cap.
- All tuning numbers in `src/state/balance.js`, all colours in `src/renderer/palette.js`.
- Tests alongside the code, in the owning module.

## Done means
1. `npm test`, `node tools/validate-mazes.mjs --quick`, `node tools/stress.mjs --quick` all green.
2. A lightweight gauntlet run (`/amaze-gauntlet`).
3. A Claude artifact with the screenshots and a gameplay video of New Descent.

Show me the artifact and wait for my go-ahead before pushing.
