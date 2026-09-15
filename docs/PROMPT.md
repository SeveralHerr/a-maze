## Directive

Build an arcade-quality, retro 3D raycaster/tile-based maze wanderer in plain vanilla HTML5, CSS3, and native ES modules. Zero runtime dependencies, zero build steps, and zero framework bloat. Run it entirely client-side with high-performance WebGL/Canvas 2D rendering locked at a buttery 60fps.

## Architecture & Engineering Standards

* **Modularity:** Establish strict subsystem separation (`/src/core`, `/src/maze`, `/src/renderer`, `/src/input`, `/src/state`, `/src/ui`). Write an initial `ARCHITECTURE.md` mapping out the dependency graph before dropping code.
* **State Isolation:** Enforce a strict unidirectional data flow. Game logic must never block the render loop. If a procedural generation tick chokes, isolate the worker/async loop to prevent main-thread jank.
* **Procedural Math:** Implement a guaranteed-solvable maze generation algorithm (e.g., randomized Prim’s, Recursive Backtracking with enforced path carving, or Eller's algorithm) paired with a headless verification runner that mathematically validates 100% solvability upon generation.

## Multi-Agent Orchestration Protocol

Operate in a tightly managed swarming wave structure. Persist all state, metrics, and blocking errors to `docs/STATUS.json` after every step so iterations resume from the exact point of failure, never from scratch.

1. **Wave 1 (Foundations):** Core state store, input handler, and the high-performance rendering canvas shell.
2. **Wave 2 (Generation & Validation):** Procedural maze generator and automated pathfinding validator.
3. **Wave 3 (HUD & Polish):** Timer, score tracking, responsive retro UI overlays, and audio/visual feedback cues.
4. **The Integrator:** Handles cross-module wiring, seam repairs, and regression fixes. No module edits its neighbors directly; all inter-subsystem contracts go through the integrator.

## The Quality Gauntlet

Every module must survive an automated critic pass scored out of 10 against top-tier web arcade games:

* **Passing Grade:**  8.5 with zero console errors, steady 60fps frame budgets, and zero memory leaks.
* **Feedback Loop:** If a module scores 8.5, the builder agent receives structured critique data and auto-revises up to 4 times.
* **Final Stress Gate:** Run a dimensional stress test pushing grid scales to extreme limits to ensure zero infinite loops, stack overflows, or frame drops.

## Execution Rules

* **No Programmer Art:** Clean, high-contrast, cohesive retro aesthetics, crisp scanline/pixel-grid scaling, and satisfying movement feedback.
* **Autonomous Execution:** Do not ask clarifying questions or pause for design approvals. Make architectural decisions, document assumptions inline, and keep the dev server hot.
* **Ultracode:** Output production-ready, heavily typed (via JSDoc), impeccably commented, bulletproof code.

/loop until every critic passes with a score >= 8.5.

## Art Direction Example
I love this pixel art style, please aim for this type of vibe. 
![alt text](image.png)

## Itch.io setup
Use skill /itch-store-page to setup https://severalherr.itch.io/a-maze when youre done. 

## Github Workflow example
Use the CICD from C:\Users\gotmi\Documents\GitHub\incremental-city-builder\.github


Ultracode. 