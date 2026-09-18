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
npm test                          # every src/*/*.test.mjs in its own Node process (864 tests in 46 files)
node tools/validate-mazes.mjs     # 81k mazes + the 750-level campaign incl. the refuel chain; --quick
node tools/stress.mjs             # extreme grid sizes + the gameplay maximum + leak loops; --quick
node tools/shot-ui.mjs --tag x     # phone/landscape/desktop UI shots → logs/ui-x/ + an OVERLAP report
                                  #   --desktop adds the 1280x720 set; --only play,slain,… narrows it
                                  #   needs `npm run serve` running and Chrome (CHROME_PATH)
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
- The torch is a **tank you refill** (95–150 s, independent of maze area), not a budget for the
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


# Agent Instructions
Always create the below checklist for every prompt:

## Checklist Manifesto
Always use your checklist or todo list tool to track items. Do not leave it to chance that you will remember later.
Immediately before implementing any prompts set up the following tasks as a checklist.
- Preparatory Unit Test Coverage
- Make it easy to change (which may be hard) (refactoring)
- Make the easy change
- Security Review
- Scout Rule
- Trust the Evidence Last
- Single Loop Learning
- Double Loop Learning
- Canary


## Preparatory Unit Test Coverage
Ensure the area that will be changed has approrpriate characterization tests making it safe to refactor.
Ensure characterization tests pass before starting any refactoring. 

## Make it easy to change (which may be hard)
Refactor to common computer science grounded design patterns.
The resulting code should be easy to read, limited in file length, appropriately decoupled, and cohesive.

## Make the easy change
Complete the prompt considering YAGNI and DRY concepts in software development. 

## Security Review
Evaluate for common OWASP pitfalls.
Run automated audits like pip audit, npm audit and correct package issues.
Evaluate for harder to detect problems with the system such as IDOR vulnerabilities.

## Scout Rule
Always leave the code better than you found it. Perform one of the following in priority order each time a prompt leads you to this area of the code.
- Evaluate Code Coverage and add more complete tests
- File length gate, reduce the file length of the files when over 500 lines by refactoring
- Mutation testing, use a analysis tool to perform mutant hunting on the modified files. For example Cosmic Ray in Python or Striker in Angular.

## Trust the Evidence Last
Before believing what a screenshot, a gate or a metric says, check that it is measuring what
you think. Three ways this has actually gone wrong here:
- **A failing gate is guilty until proven innocent.** `verify.mjs`'s combat phase reported
  "23 swings, 0 connected, 0 wakes" and that read as a combat bug; it was the harness dropping
  the player inside a wall. Suspect the harness before the code, especially a harness you just
  wrote.
- **Screenshots go stale silently.** A shot taken before the change it is evidence for looks
  exactly like one taken after. Re-capture after every change, tag the output, and never reuse
  an older tag to illustrate a newer claim.
- **Look at the artefact at the scale its defects live at.** Sprite art reviewed at sheet scale
  is not reviewed; see the `pixel-art-texel-review` skill.
- **A PASSING gate is guilty too.** `tools/shot-ui.mjs`'s first run reported "0 overlapping
  control pair(s)" for a screen whose buttons were sitting squarely on the minimap: it read
  `r.width` on a rect that reports `w`. A green result from a gate you have never seen go red is
  not evidence. Before trusting a new check, make it fail on purpose — run it against the commit
  the bug is still in.

## Layout is arithmetic, not photography
A screenshot answers "does this look wrong" only if the defect happens to be where you looked.
"Does this button cover that panel" is a subtraction, so do the subtraction: have the UI report
its rectangles (`hud.rects()` → `window.__game.hudRects()`), compare them in the tool, and fail
the run on an intersection. The same applies to clearances a thumb depends on —
`touch-overlay.test.mjs` computes the control row's left edge against `STICK_ZONE_FRACTION` at
four real viewport widths, and caught a 320 px phone that no screenshot in the set covered.
Corollary: any size a layout promise rests on must be **fixed**, not `min-`. A `min-width` hands
the promise to whatever font the device substituted.

## Look at the screen you changed, in the states you changed it for
Three of this wave's defects — labels riding the top border of every button that can be hidden,
an 8 px health-bar stub drawn through the first digit of `100/100`, an ATTACK button with no
swing feedback — were invisible to 864 passing tests and visible in the first screenshot. Budget
a look at the real thing, at the real viewport, in each state the change touches (both
orientations, both modes, mid-run *and* end-of-run), and write the test once the screenshot has
told you what to assert.

## Single Loop Learning
Learn from the tasks you complete:
Always end all of our chats with a list of skills that you used.
Always create new skills in your skills folder that you wish you had before starting the prompt. Actually write the file now.

## Double Loop Learning
Learn from the process improvement opportunities:
Always evaluate the the process used here using a lens of Lean Software Development, Agile, Systems Thinking, Safety, Security, and Continuous Improvement. 
Always make the changes to the AGENTS.md with these changes. Update this very list you are reading now.

## Canary
Always end all of our chats with "# 🪁" Emoji. It should render as a markdown header so the Emoji will be large.