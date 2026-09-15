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
npm test                          # every src/*/*.test.mjs in its own Node process
node tools/validate-mazes.mjs     # headless 100%-solvability runner (exit≠0 on any failure)
node tools/stress.mjs             # extreme grid sizes: time/memory/no stack overflow
node tools/verify.mjs --tag x     # headless Chrome autopilot run → logs/x.json + screenshots
```

## Rules that are not obvious from the code
- `ARCHITECTURE.md` is the binding contract (types, signatures, allowed imports). Change it first, then code.
- **Module isolation:** a builder edits only its own `src/<module>/`. `src/main.js`, `index.html`, `styles.css`, `tools/`, `ARCHITECTURE.md` and cross-module seams are integrator territory.
- `src/core`, `src/maze`, `src/state` must run in Node (no DOM at import time).
- The reducer mutates store-owned state in place; renderer/ui/audio are read-only consumers.
- Zero allocations per frame in the raycaster and sim hot paths; all tuning numbers live in `src/state/balance.js`; all colours in `src/renderer/palette.js`.
- `?headless=1` exposes `window.__game` for tools; `?debug=1` shows FPS/logs.
- `docs/STATUS.json` records waves, critic scores, open issues and blockers — read it before choosing work, update it after every step.
