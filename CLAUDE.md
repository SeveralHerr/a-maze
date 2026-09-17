# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is
"A-MAZE": a retro torch-lit first-person raycaster maze crawler in plain HTML/CSS + native ES
modules. No build step, no framework, no runtime dependencies (`puppeteer-core` is a dev-only
tool dependency). `index.html` loads `src/main.js`. Deployed to itch.io
(`severalherr/a-maze:html5`) by `.github/workflows/deploy-to-itchio.yml` on push to `main`.

## Commands
```sh
npm run serve                     # static dev server http://localhost:5173 — keep it running
npm test                          # every src/*/*.test.mjs in its own Node process (740 tests)
node tools/validate-mazes.mjs     # 117k mazes + the 750-level campaign incl. the refuel chain; --quick
node tools/stress.mjs             # extreme grid sizes + the gameplay maximum + leak loops; --quick
node tools/verify.mjs --tag x     # headless Chrome autopilot run → logs/x.json + logs/shot-x-*.png
                                  #   descends to the size cap and drives it for 60s (~8 min total)
                                  #   needs `npm run serve` running and Chrome (CHROME_PATH)
                                  #   --seed N --soak 20 --fps 5 --url ... --keep-open
```
Useful URLs while the dev server is up:
`/` · `/?debug=1` (FPS + logging) · `/?headless=1` (exposes `window.__game`) · `/?seed=1337`
(pins the run seed) · `/?fatal=1` (shows the boot failure screen) · `/src/renderer/preview.html`
and `/src/ui/preview.html` (module harnesses).

## Rules that are not obvious from the code
- `ARCHITECTURE.md` is the binding contract (types, signatures, allowed imports). Change it first, then code.
- **Module isolation:** a builder edits only its own `src/<module>/`. `src/main.js`, `index.html`, `styles.css`, `tools/`, `ARCHITECTURE.md` and cross-module seams are integrator territory.
- `src/core`, `src/maze`, `src/state` must run in Node (no DOM at import time).
- The reducer mutates store-owned state in place; renderer/ui/audio are read-only consumers.
- Zero allocations per frame in the raycaster and sim hot paths; all tuning numbers live in `src/state/balance.js`; all colours in `src/renderer/palette.js`.
- **Massive mazes:** a level is up to 128×128 cells (257×257 tiles, ~820 items, ~1 300 torches, a
  66 kB `explored` grid). **Nothing may be O(items) or O(tiles) per frame or per step** — pickups
  use a bucket grid, sprites and lights use a spatial index, the map keeps an incremental raster.
  A scan added here looks free on level 1 and costs the frame at the cap.
- The torch is a **tank you refill** (110–150 s, independent of maze area), not a budget for the
  level; oil flasks are the economy and their placement guarantee is a hard gate, not a balance note.
- `tools/` and `src/state`'s `perf`/`feasibility` tests may import across module lines (they drive
  the real curve against real mazes on purpose); runtime modules may not.
- `?headless=1` exposes `window.__game` for tools; `?debug=1` shows FPS/logs.
- Events are routed from a **store subscriber**, never after the tick dispatch: `state.events` is
  cleared at the top of every dispatch, so anything read later has already been clobbered.
- The HUD derives its score/fuel pops from state deltas, so main.js must not also pop on `pickup`.
- `hud.render()` clears the overlay and `menus.render()` draws over it — that order is required.
- Page layer order is `#view` → `#post` → `#overlay` → `#touch`; every layer above `#overlay` must
  keep `pointer-events: none` or pointer lock and the virtual stick die silently.
- CI runs `npm test`, `validate-mazes` and `stress` before every itch.io deploy; `verify.mjs` is
  local-only (it needs a browser and the dev server).
- `docs/STATUS.json` records waves, critic scores, open issues and blockers — read it before choosing work, update it after every step.
