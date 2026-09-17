<p align="center">
  <img src="docs/screenshots/banner.png" alt="A-MAZE" width="960">
</p>

<h1 align="center">A-MAZE</h1>

<p align="center">
  <em>The Torchlit Descent</em>
</p>

<p align="center">
  <a href="https://severalherr.itch.io/a-maze"><img src="https://img.shields.io/badge/play-itch.io-fa5c5c?style=for-the-badge&logo=itch.io&logoColor=white" alt="Play on itch.io"></a>
  <img src="https://img.shields.io/badge/dependencies-0%20at%20runtime-38bdf8?style=for-the-badge" alt="No runtime dependencies">
</p>

---

**[Play it in the browser &rarr;](https://severalherr.itch.io/a-maze)**

A retro, first-person dungeon crawler. Every level is a new maze, and each one is bigger than the last.
Your torch is running out, so keep finding oil and find the way down.

<details>
<summary><strong>The prompt this repo was built from</strong> (Opus 5 experiment)</summary>

  #### Directive

  Build an arcade-quality, retro 3D raycaster/tile-based maze wanderer in plain vanilla HTML5, CSS3, and native ES modules. Zero runtime dependencies, zero build steps, and zero framework bloat. Run it entirely client-side with high-performance WebGL/Canvas 2D rendering locked at a buttery 60fps.

  #### Architecture & Engineering Standards

  * **Modularity:** Establish strict subsystem separation (`/src/core`, `/src/maze`, `/src/renderer`, `/src/input`, `/src/state`, `/src/ui`). Write an initial `ARCHITECTURE.md` mapping out the dependency graph before dropping code.
  * **State Isolation:** Enforce a strict unidirectional data flow. Game logic must never block the render loop. If a procedural generation tick chokes, isolate the worker/async loop to prevent main-thread jank.
  * **Procedural Math:** Implement a guaranteed-solvable maze generation algorithm (e.g., randomized Prim’s, Recursive Backtracking with enforced path carving, or Eller's algorithm) paired with a headless verification runner that mathematically validates 100% solvability upon generation.

  #### Multi-Agent Orchestration Protocol

  Operate in a tightly managed swarming wave structure. Persist all state, metrics, and blocking errors to `docs/STATUS.json` after every step so iterations resume from the exact point of failure, never from scratch.

  1. **Wave 1 (Foundations):** Core state store, input handler, and the high-performance rendering canvas shell.
  2. **Wave 2 (Generation & Validation):** Procedural maze generator and automated pathfinding validator.
  3. **Wave 3 (HUD & Polish):** Timer, score tracking, responsive retro UI overlays, and audio/visual feedback cues.
  4. **The Integrator:** Handles cross-module wiring, seam repairs, and regression fixes. No module edits its neighbors directly; all inter-subsystem contracts go through the integrator.

  #### The Quality Gauntlet

  Every module must survive an automated critic pass scored out of 10 against top-tier web arcade games:

  * **Passing Grade:**  8.5 with zero console errors, steady 60fps frame budgets, and zero memory leaks.
  * **Feedback Loop:** If a module scores 8.5, the builder agent receives structured critique data and auto-revises up to 4 times.
  * **Final Stress Gate:** Run a dimensional stress test pushing grid scales to extreme limits to ensure zero infinite loops, stack overflows, or frame drops.

  #### Execution Rules

  * **No Programmer Art:** Clean, high-contrast, cohesive retro aesthetics, crisp scanline/pixel-grid scaling, and satisfying movement feedback.
  * **Autonomous Execution:** Do not ask clarifying questions or pause for design approvals. Make architectural decisions, document assumptions inline, and keep the dev server hot.
  * **Ultracode:** Output production-ready, heavily typed (via JSDoc), impeccably commented, bulletproof code.

  /loop until every critic passes with a score >= 8.5.

  #### Art Direction Example
  I love this pixel art style, please aim for this type of vibe.
  ![Art direction reference](docs/art-reference.png)

  #### Itch.io setup
  Use skill /itch-store-page to setup https://severalherr.itch.io/a-maze when youre done.

  #### Github Workflow example
  Use the CICD from C:\Users\gotmi\Documents\GitHub\incremental-city-builder\.github

  Ultracode.

  ---

  Follow-up mid-run: *"I want the mazes to be massive. Are they?"* They were not (6×6 up to 40×40
  cells), which led to the size curve, the refillable-torch economy and the full map below.

</details>

## Screenshots

| | |
|---|---|
| <img src="docs/screenshots/01-title.png" alt="Title screen: gold A-MAZE logo over a stone corridor" width="420"> | <img src="docs/screenshots/02-depth-15.png" alt="A torch-lit corridor at depth 15" width="420"> |
| **The title screen.** | **Deep in the dungeon.** |
| <img src="docs/screenshots/03-full-map.png" alt="Full map of a 128x128 labyrinth, 4% explored" width="420"> | <img src="docs/screenshots/04-depth-cleared.png" alt="Depth 1 cleared tally screen" width="420"> |
| **The map fills in as you explore.** | **Level cleared.** |

## How to play

Find the glowing portal to go down a level. Your torch burns out over time, so pick up oil
flasks to refill it and grab gems for points. Each level is a bigger maze than the last.

Gems also fill a purse you keep between runs. Spend it at the **Shrine** (title, level cleared and
game over screens) on unlocks such as a bigger tank, richer oil, a slower wick, a magnet for gems or
chalk to mark the walls. The first time you clear a new depth, you also pick one **Boon** for free.

| Key | Action |
|---|---|
| `WASD` / arrows | Move and turn |
| Mouse | Look (click the game to lock the mouse) |
| `C` | Chalk the wall ahead (once unlocked) |
| `M` | Map |
| `O` | Auto Explore: the game wanders the maze on its own, calmly (or click the AUTO button) |
| `Esc` | Pause |

Gamepad and touch controls work too.

Deep runs don't have to be abandoned: **Save & Quit** from the pause menu (or after clearing a
depth) and pick it up later with **Continue** on the title screen. The game also saves when you
pause or switch away, and the save is gone once that run's torch goes out.

## Run it locally

```sh
npm install
npm run serve     # then open http://localhost:5173
```

Run `npm test` to check it. How it's built is in [ARCHITECTURE.md](ARCHITECTURE.md).
