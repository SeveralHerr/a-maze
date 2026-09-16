# A-MAZE — Architecture

A retro, first-person, torch-lit dungeon maze crawler. Plain HTML5 + CSS3 + native ES modules.
**Zero runtime dependencies, zero build step.** `index.html` loads `src/main.js` directly; the same
tree is served locally (`npm run serve`) and uploaded to itch.io by CI.

> This file is the **binding contract** between subsystems. Builders code against the signatures
> below. If a contract must change, the **integrator** changes it here first, then updates every
> consumer. No subsystem edits another subsystem's folder.
>
> **Status: reconciled with the shipped code**, through the **massive-mazes** wave. Every signature
> below has been checked against `src/`; where a builder's delivered design was better than the
> sketch it replaced, this document was changed to match the code, and the reason is recorded next
> to it. Where the two genuinely disagreed, the code was fixed. Sections marked
> _(integrator decision)_ resolve a seam that two modules saw differently.
>
> **The massive-mazes change is the largest revision this file has had.** Levels went from 6×6 cells
> to 16×16→128×128, and the torch went from a budget for the whole level to a tank you refill. Two
> pieces of the old contract are **dead** and were replaced rather than amended: the §4.4 fuel seam
> (`balance.js` supplying a size-based floor over a path-derived budget) and the §6 assumption that
> fuel is sized at ~4× the optimal route. The invariant that replaces them, and that every future
> change has to respect, is in §6: **nothing may be O(items) or O(tiles) per frame or per step.**

---

## 1. Game design (what we are building)

- **Look:** chunky pixel-art dungeon in the style of *Labyrinth: The Wizard's Cat* (see
  `docs/art-reference.png`): blue-grey stone block walls with dark mortar and creeping green moss/vines,
  irregular cobblestone floor with moss in the cracks, dark wooden plank ceiling with beams,
  flickering wall torches casting warm orange light, deep cool-blue shadows. Warm
  gold/parchment gothic pixel lettering for titles and menus. All art is **procedurally
  generated pixel textures** at load (no image assets), low internal resolution, upscaled with
  nearest-neighbour, optional CRT scanline + vignette overlay.
- **Loop (arcade):** each level is a procedurally generated **massive** maze. The player carries a
  **torch whose fuel is the timer**. Fuel drains in real time; when it runs low the light radius
  visibly shrinks and the screen edges darken. Collect **gems** (+score) and **oil flasks** (+fuel);
  reach the glowing **exit portal** to descend. Each descent grows the maze (to a cap) and
  multiplies score. Fuel hits 0 → game over → score summary → high score saved.
- **Size curve _(massive mazes)_:** level 1 is **16×16 cells = 33×33 tiles**, growing **+8 cells per
  side per level** to a cap of **128×128 cells = 257×257 tiles = 16 384 cells ≈ 33 000 floor tiles**,
  reached at level 15. `LEVEL.MAX_CELLS` in `balance.js` is the **single documented size knob** and
  the cap level is *derived* from it (`CAP_LEVEL`), never typed twice. Past the cap, levels get
  **harder, not bigger**: braid keeps rising (0→0.6 over 17 levels, square-root shaped, 0.6 from
  level 18), the torch drains 3 % faster per level (`FUEL.DRAIN_PER_LEVEL`) from
  `LEVEL.DRAIN_RAMP_START` (level 5, so the ramp is felt inside the size curve) to a 1.35× ceiling
  (`FUEL.DRAIN_MAX`, 1.30× at the cap, 1.35× from level 17), and oil thins from one flask per 20
  cells to one per 34 (`LEVEL.OIL_CELLS_END`). Levels run ~3.5 minutes at level 1 to ~13 minutes at the deepest.
- **Torch economy _(a tank you keep refilling, not a budget)_:** `fuelMax` is a **tank** of
  110 s (level 1) → 150 s (the cap), **independent of maze area** — 64× the area buys 1.36× the
  tank. Oil flasks are the economy: their **count scales with area** so density is roughly constant
  (≈ one per 20 cells early, thinning to one per 34 past the cap), each restoring **35 % of the
  tank on level 1, climbing to 44 % on the cap's tank** (`FUEL.OIL_FRACTION` →
  `FUEL.OIL_FRACTION_END`, clamped 25–70 s ⇒ 38–66 s in practice) — bigger, rarer refills deeper
  down are the shape of the tension curve. A level takes **7–22 refuels** to cross and the
  player is never more than ~60–90 s from darkness, whatever the depth. Gems scale with area too
  (≈ one per 50–60 cells), still favouring dead ends, and remain the score currency.
  A flask is only consumed when at least `FUEL.OIL_MIN_USEFUL_FRACTION` (0.55) of its value would
  land in the tank — otherwise it stays on the floor — and the low-fuel alarm fires at
  `FUEL.LOW_FRACTION` (0.25) of the tank.
  **Placement guarantee:** walking the solution path, the gap between consecutive *reachable* oil
  flasks (on the path or within `LEVEL.OIL_REACH_TILES` = 3 tiles of it) never exceeds
  `levelParams().oilTargetGap` — the path distance one flask pays for at a 2.0× wander factor with
  `gapSafety(level)` headroom — 30 % on level 1 (`FUEL.GAP_SAFETY` 0.7), easing to 20 % at the cap
  (`FUEL.GAP_SAFETY_END` 0.8). `src/maze/populate.js` places to it, `walkRefuelChain()` verifies it,
  `tools/validate-mazes.mjs` asserts it for levels 1…30 × 25 seeds, and `src/state/feasibility.test.mjs`
  proves it end-to-end by walking 250 real levels with an autopilot. A level a competent player
  cannot chain refuels through is a **blocker**, not a balance note.
- **Score:** gem = `100 × level`; level clear = `500 × level + floor(fuelRemaining) × 10 × level`.
  _Consequence of the tank (deliberate, see `SCORE`):_ the clear bonus is roughly constant per level
  because the tank no longer grows, while gems scale with area (6 at level 1 → 273 at the cap), so
  the incentive tips from "get out fast" to "explore" as the labyrinth grows.
- **Controls:** WASD/arrows move + turn, mouse look with pointer lock, Shift sprint (fast but
  wasteful: drains fuel 2× at 1.6× speed, so a sprinted tile costs 1.25× a walked one), M cycles the map **off → corner → full**, Esc/P pause, Enter/Space confirm. Touch: left
  virtual stick move, right half drag to turn, tap buttons for pause/map. Gamepad: standard mapping.
- **Feedback cues:** head bob, footstep sounds synced to bob, wall-bump thud + tiny camera
  shake, gem sparkle particles + chime + score pop, fuel pickup whoosh + light flare, low-fuel
  heartbeat + red vignette pulse, exit portal hum growing with proximity, level-complete fanfare
  + iris-wipe transition.

## 2. Folder map & dependency graph

```
index.html ─► src/main.js  (composition root — integrator territory)
                 │
   ┌─────────────┼───────────────┬──────────────┬──────────────┬──────────────┐
   ▼             ▼               ▼              ▼              ▼              ▼
src/core     src/state       src/input      src/maze      src/renderer     src/ui
(no deps)   (core, maze*)   (core)         (core)        (core)           (core)
```

Allowed imports (anything else is a contract violation the integrator must reject):

| Module          | May import                                   | DOM? | Runs in Node? |
|-----------------|----------------------------------------------|------|---------------|
| `src/core`      | nothing                                      | `loop.js` only (guarded) | yes |
| `src/maze`      | `src/core`                                   | no (worker-safe)          | **yes** |
| `src/state`     | `src/core`, `src/maze/constants.js` (tile ids only) | no                 | **yes** |
| `src/input`     | `src/core`                                   | yes                       | no (tests use fakes) |
| `src/renderer`  | `src/core`, `src/maze/constants.js`          | yes (canvas)              | textures/raycast math yes |
| `src/ui`        | `src/core`                                   | yes                       | font/format yes |
| `src/main.js`   | everything                                   | yes                       | no |
| `tools/*.mjs`   | everything (see below)                       | no                        | **yes** |

**Tools may import across module lines.** `tools/validate-mazes.mjs` and `tools/stress.mjs` import
`levelParams` / `LEVEL` from `src/state/balance.js` to drive `src/maze` with the *real* level curve.
That is deliberate and is the opposite of a violation: the alternative — the hand-matched copy of
the curve those tools used to carry — is a gate that silently stops testing the shipped game the
moment balance is re-tuned. The runtime rule is untouched: `src/maze` still may not import
`src/state`. The same exemption is what lets `src/state`'s `perf.test.mjs` and `feasibility.test.mjs`
build real mazes (§5); a feasibility proof over fake mazes would prove nothing.

Data flow is **strictly unidirectional**:

```
 Input.poll() ──► InputFrame ──► store.dispatch({type:'tick'}) ──► reducer mutates GameState
                                                                   │  emits GameEvent[] (queue)
                                                                   ▼
                        renderer.render(view)   hud.render(state)   audio.handle(events)
                        (read-only)             (read-only)          (read-only)
 UI buttons ──► ui callbacks ──► main.js ──► store.dispatch(action)   (never mutate state directly)
 Maze worker ──► Promise<LevelData> ──► main.js ──► store.dispatch({type:'levelReady'})
```

Game logic runs on a **fixed 60 Hz step**; rendering runs on `requestAnimationFrame` with
interpolation. Maze generation for large grids runs in a **module Web Worker** so it can never
stall the frame loop (sync fallback for tiny grids / no-worker environments).

The page is four stacked layers, in this order (`index.html`, positioned by `styles.css` and sized
by `main.js`):

| Layer      | Owner                       | Notes                                                        |
|------------|-----------------------------|--------------------------------------------------------------|
| `#view`    | `src/renderer/raycaster.js` | 240-row framebuffer, upscaled with `image-rendering: pixelated` |
| `#post`    | `src/renderer/post.js`      | scanlines, vignette, low-fuel pulse, flash, iris — sized to `#view` |
| `#overlay` | `src/ui/hud.js` + `menus.js`| one shared `Surface`; also the input target (pointer lock, touch) |
| `#touch`   | `src/input/touch-overlay.js`| virtual stick + MAP/PAUSE, only on a touch device; `pointer-events: none` |

`#touch` (and every layer above the overlay) **must stay `pointer-events: none`** or no click ever
reaches `#overlay` and both pointer lock and the virtual stick die silently.

## 3. Shared types (`src/core/types.js` — JSDoc only, no runtime code besides `export {}`)

```js
/** @typedef {{x:number, y:number}} Vec2 */
/**
 * Tile map. Tiles are 1×1 world units. Tile (tx,ty) spans [tx,tx+1)×[ty,ty+1).
 * @typedef {Object} Maze
 * @property {number} width          tile columns  (= cols*2+1)
 * @property {number} height         tile rows     (= rows*2+1)
 * @property {number} cols           logical cell columns
 * @property {number} rows           logical cell rows
 * @property {Uint8Array} tiles      width*height, index = ty*width+tx, values = TILE.*
 * @property {Vec2} start            tile coords of start (odd, odd)
 * @property {Vec2} exit             tile coords of exit (odd, odd)
 * @property {number} seed
 */
/**
 * @typedef {'gem'|'oil'} ItemKind
 * @typedef {{id:number, kind:ItemKind, x:number, y:number, taken:boolean}} Item   x,y = tile centre (tx+0.5)
 * @typedef {{x:number, y:number, face:0|1|2|3}} Torch  wall tile + face (0=E,1=S,2=W,3=N) the flame is mounted on
 */
/**
 * @typedef {Object} Validation
 * @property {boolean} solvable        start → exit path exists
 * @property {boolean} fullyConnected  every floor tile reachable from start
 * @property {boolean} bordersSealed   outer ring is all wall
 * @property {number}  pathLength      shortest path in TILES, both endpoints included
 *                                     (start===exit ⇒ 1); -1 if unsolvable
 * @property {number}  floorCount
 * @property {number}  deadEnds        FLOOR tiles with exactly one FLOOR orthogonal neighbour
 * @property {number}  loops           edges - (nodes - 1) over the cell graph (0 = perfect maze)
 * @property {Uint32Array|null} path   tile indices start→exit (null if unsolvable)
 * @property {string[]} errors         human-readable failures (empty when valid)
 */
/**
 * @typedef {Object} LevelData
 * @property {Maze} maze
 * @property {Validation} validation
 * @property {Item[]} items
 * @property {Torch[]} torches
 * @property {number} fuel            the level's TANK in seconds (`run.fuelMax`). `src/state` clamps
 *                                    it DOWN with `balance.resolveTank`: level data may offer a
 *                                    smaller tank (tutorial/demo/fixture), never a larger one.
 * @property {number} par             par time seconds for the whole level (summary screen). MAY
 *                                    exceed one tank — a level now takes 7–22 refuels to cross.
 */
/**
 * @typedef {Object} InputFrame       one poll, consumed by one sim step
 * @property {number} moveX           strafe  -1..1 (right +)
 * @property {number} moveY           forward -1..1 (forward +)
 * @property {number} turn            keyboard/stick turn -1..1 (right +), scaled by dt in sim
 * @property {number} lookDX          accumulated mouse/touch yaw delta in radians since last poll (already sensitivity-scaled)
 * @property {boolean} sprint
 * @property {Set<InputAction>} pressed   edge-triggered this poll
 * @typedef {'confirm'|'back'|'pause'|'map'|'up'|'down'|'left'|'right'|'mute'} InputAction
 */
/**
 * @typedef {Object} Player
 * @property {number} x @property {number} y      world position (tile units)
 * @property {number} angle                         radians, 0 = +x (east), π/2 = +y (south)
 * @property {number} px @property {number} py @property {number} pangle   previous-step values for interpolation
 * @property {number} vx @property {number} vy     velocity
 * @property {number} bob                           head-bob phase (radians)
 * @property {number} bobAmp                        0..1 current bob amplitude
 * @property {number} shake                         0..1 camera shake (decays)
 */
/**
 * @typedef {'title'|'loading'|'playing'|'paused'|'levelComplete'|'gameOver'} Phase
 * @typedef {'off'|'corner'|'full'} MapMode           the three-state map (§4.6)
 * @typedef {Object} Settings
 * @property {number} volume 0..1  @property {number} music 0..1  @property {number} sensitivity 0.2..3
 * @property {boolean} scanlines  @property {boolean} reducedMotion  @property {boolean} invertLook
 * @property {MapMode} mapMode    what the map restores to (default 'corner')
 * @property {boolean} minimap    LEGACY mirror of `mapMode !== 'off'`, kept because audio, touch and
 *   older call sites still read it. main.js and the options row write BOTH on every change.
 * @typedef {Object} GameState
 * @property {Phase} phase
 * @property {number} time            total sim seconds since boot (monotonic)
 * @property {number} phaseTime       seconds since phase changed
 * @property {number} level           1-based
 * @property {number} seed            run seed
 * @property {LevelData|null} levelData
 * @property {Player} player
 * @property {Uint8Array|null} explored   width*height, 1 = seen (map fog of war). Up to 257×257 =
 *   66 049 bytes, so it is a VIEW onto a grow-only pool (`sim.allocExplored`) — exact length,
 *   zeroed, indexed identically by every consumer, one buffer for a whole 30-level run.
 * @property {{score:number, gems:number, gemsTotal:number, fuel:number, fuelMax:number, levelTime:number, totalTime:number, levelScore:number, bestCombo:number, refuels:number, distance:number}} run
 *   `refuels` = oil flasks burned THIS LEVEL (reset by `levelReady`); `distance` = tiles actually
 *   walked this RUN (reset by `newGame` only). Both exist because on a 14-minute labyrinth those
 *   are the statistics that describe the run; the HUD shows the refuel tally live and the
 *   level-complete / game-over screens show both.
 * @property {{score:number, level:number}} best   `best.level` is the **deepest level reached** (the
 *   level the run was on when it was folded in), not the deepest cleared. Folded in by
 *   `sim.recordBest` on a level clear, on game over, and when a paused run is abandoned through
 *   `toTitle` or `newGame` — abandoning a run keeps its score.
 * @property {Settings} settings
 * @property {{exitDist:number, nearExit:number, lowFuel:boolean}} derived   recomputed each step for renderer/hud/audio
 *   (`exitDist` is Infinity and `nearExit` 0 while no level is loaded — an honest "unknown")
 * @property {GameEvent[]} events     events emitted by the action just dispatched. Cleared at the
 *   top of EVERY dispatch, not only on `tick`, so a subscriber sees each event exactly once and a
 *   UI-driven `phase` event cannot be clobbered by the following tick. The array identity is
 *   stable (`length = 0`), so consumers may hold a reference.
 * @property {Object} sim             simulation scratch owned by `src/state/sim.js` (smoothed turn
 *   rate, bump cooldown, footstep parity, low-fuel arming, combo window, fog-of-war cursor,
 *   attract-walk target + RNG, best score at run start). Not part of the cross-module contract —
 *   nothing outside `src/state` may read it — but it IS part of the state, because every field
 *   must survive between steps for the sim to stay deterministic.
 */
/**
 * @typedef {{type:'footstep', foot:0|1} | {type:'bump', strength:number} | {type:'pickup', kind:ItemKind, x:number, y:number, value:number}
 *   | {type:'levelStart', level:number} | {type:'levelComplete', level:number, bonus:number}
 *   | {type:'lowFuel'} | {type:'gameOver', score:number, newBest:boolean} | {type:'phase', from:Phase, to:Phase}
 *   | {type:'uiMove'} | {type:'uiConfirm'} } GameEvent
 */
```

## 4. Subsystem contracts

### 4.1 `src/core` (Wave 1)
- `types.js` — the typedefs above, plus named aliases for the inline shapes (`RunStats`,
  `BestScore`, `Derived`) and mirrors of `Action`, `RenderView` and `Flash`, because those cross
  module seams and `src/core` is the only module everyone may import. JSDoc only; `export {}`.
- `loop.js` — `createLoop({ step:(dt)=>void, render:(alpha, frameDt)=>void, hz?:60, maxCatchUp?:5, vsyncSnapMs?:0.4, onError?, now?, raf?, caf?, doc?, setTimer?, clearTimer? }) → { start(), stop(), running, suspended, hz, stepDt, stats():FrameStats, resetStats(), stepOnce(n?:number):number }`.
  Fixed-timestep accumulator, clamps huge gaps (tab switch) to `maxCatchUp` steps and **discards**
  the overflow (no death spiral), auto-pauses when `document.hidden` and resumes without replaying
  the hidden time. `FrameStats = {fps, frameMsAvg, frameMsP99, stepMsAvg, renderMsAvg, droppedFrames, samples, skippedSteps}`
  over a rolling 120-frame window, **reused object**, zero allocations per frame.
  `now/raf/caf/doc/setTimer/clearTimer` are injectable so the loop is testable in Node (`setTimer`/
  `clearTimer` default to `setTimeout`/`clearTimeout`); `doc: null` disables the visibility pause.
  A suspended loop does not trust `visibilitychange` alone: it **polls `document.hidden` every
  250 ms** and also resumes on `pageshow` (back/forward cache restore) and window `focus`, so a
  missed event can never freeze the game until a reload. `vsyncSnapMs` snaps frame intervals within 0.4 ms of a whole step to that step,
  which removes 1-step/2-step stutter on a display running at the sim rate.
- `events.js` — `createEmitter({onError?}) → { on(type, fn):()=>void, once, off, emit, clear, count }`.
  Duplicate `(type, fn)` registration is idempotent; a throwing listener is caught and reported and
  the others still run.
- `rng.js` — `createRng(seed:number) → { next():number /*[0,1)*/, u32(), int(n), range(a,b), chance(p), pick(arr), shuffle(arr), fork(salt):Rng, state():number, saveState(out?), restoreState(words) }`
  (sfc32 seeded from splitmix32; deterministic in Node & browser; golden values pinned by a test).
  `fork(salt)` depends on the seed identity and the salt **only**, never on how many draws the
  parent has made, so adding draws in one subsystem cannot reshuffle another.
  Also `hashString(s)`, `hash2(x,y,seed)`, `hash3(x,y,z,seed)` (uint32) and `randomSeed()`.
  `state()` is a uint32 fingerprint for desync checks — use `saveState`/`restoreState` to snapshot.
- `math.js` — `clamp, clamp01, lerp, invLerp, lerpAngle, wrapAngle, angleDiff, smoothstep,
  approach(v,target,delta), damp(v,target,rate,dt), dist, dist2, mod`, plus `TAU` and `HALF_PI`.
- `pool.js` — `createPool(factory, reset, size) → { items, count, capacity, free, acquire, release,
  releaseAt, retain, clear }`. `reset` runs on release (drop references there), never on acquire.
- `log.js` — `createLogger(tag)`; in `?debug=1` (or `AMAZE_DEBUG=1` in Node) logs, otherwise
  **completely silent**. `errors` is a live 64-entry ring buffer (consecutive identical messages
  collapse into one entry with a `count`) surfaced as `window.__game.errors`; `error()` is recorded
  whether or not debug is on. `installGlobalErrorCapture()` routes uncaught errors and unhandled
  rejections into it; `setDebug`/`isDebug`/`clearErrors` complete the surface.

### 4.2 `src/state` (Wave 1)
- `store.js` — `createStore(initial:GameState, reducer:(s:GameState, a:Action)=>void) → { getState():Readonly<GameState>, dispatch(a:Action):void, subscribe(fn:(s, a)=>void):()=>void }`.
  The reducer **mutates the store-owned state in place** (no per-tick allocation); nothing
  outside `src/state` writes to it. Dispatch during dispatch is queued (FIFO), never re-entrant.
  A throwing reducer or subscriber is caught and recorded in the core error ring buffer; the other
  subscribers still run. A runaway chain is cut off at 4096 actions per outer dispatch.
- `game.js` — `createInitialState(settings?, best?) → GameState` and `reducer(state, action)`.
  Both arguments are treated as untrusted (they come from `localStorage`) and sanitised. The
  reducer **never throws for any input**: a non-object action, an unknown type, a NaN `dt`, a null
  input frame or a malformed `levelReady` payload are all ignored.
  `levelReady` additionally installs `explored` from the pool, builds the item grid once, sets
  `sim.drain` from `balance.drainRate(level)`, resets the per-level `run.refuels`, and takes the
  tank through `balance.resolveTank(level, LevelData.fuel)` — the clamp that keeps the maze module
  from ever raising the tank (§4.4). `run.distance` is the run odometer and is reset only by
  `newGame`; `sim.js` accumulates it from the distance actually covered after collision, so
  scraping along a wall cannot inflate it.
- `sim.js` — pure step logic called by the reducer on `tick`: movement with acceleration/friction,
  **circle-vs-tile collision with wall sliding** (radius 0.22, sub-stepped at 0.2 tiles so
  tunnelling is impossible at any dt), head bob & footsteps, item pickups (radius 0.45), fuel
  drain, exit detection (within 0.55 of exit centre), explored-tile reveal (radius 3 with
  line-of-sight via DDA, budgeted per step), `derived` fields, event emission. Exports the pieces
  main.js and the tools need by name: `moveCircle`, `hasLineOfSight`, `solidAt`, `stepPlaying`,
  `stepAttract`, `startAttract`, `updateDerived`, `revealAround`, `placePlayerAtStart`, `setPhase`,
  `completeLevel`, `endRun`, `recordBest`, `createSimScratch`, `resetSimScratch`, plus
  `buildItemGrid(state)` and `allocExplored(state, length)` (below).
  The exit is tested **before** the fuel-out test, so arriving on the frame the torch dies is a win.
  **Nothing is O(items) or O(tiles) per step** — required, now that a level carries ~820 items and
  66 049 tiles:
  - **Pickups** query a uniform 4-tile bucket grid in CSR form (`WORLD.ITEM_GRID_TILES`, two flat
    `Int32Array`s, grow-only pooled), built **once per level** by `buildItemGrid` in the `levelReady`
    reducer and never per step. `collectAround` visits at most the 2×2 buckets overlapping the pickup
    disc. Taken items stay in the grid (removing them would be the O(items) work being avoided), and
    a non-finite player position bails early so the clamp can never degenerate into a full scan.
    Measured: 0.675 µs/step on a 128×128 level with 819 items vs 0.635 µs on the old 6×6 level with
    6 — a ratio of 1.06×, where a naive scan of the same 819 items costs 1.695 µs on its own.
  - **Reveal** is size-independent by construction: a fixed 7×7 window and ≤ `WORLD.REVEAL_BUDGET`
    (24) DDA probes, whatever the map measures.
  - **`state.explored`** comes from `allocExplored`, a grow-only pool, so a 30-level run allocates
    one 66 kB buffer rather than thirty.
  - `sim.drain` is the level's drain multiplier, installed by `levelReady` from `balance.drainRate`.
  The sim scratch additionally carries the item grid (`gridFor/gridW/gridH/gridStart/gridItems/
  gridCursor`), `exploredPool` and `drain` — still nothing outside `src/state` may read it.
- `balance.js` — every tuning number: speeds, the torch economy, maze size per level, score
  formulas, the settings spec, and
  `levelParams(level) → {cols, rows, braid, gems, oil, fuelSeconds, par, fuelBase, fuelPerCell,
  fuelPerPathTile, cells, drain, oilTargetGap, oilDensity, gemDensity, oilRefuelSeconds, pathTiles}`.
  - **`fuelSeconds` IS the tank** (110→150 s, independent of area), not `base + cells × perCell`.
  - **`par` is a FLOOR only** — `src/maze/populate.js` knows the real shortest path and derives the
    honest par from it, taking the larger.
  - `fuelBase` / `fuelPerCell` / `fuelPerPathTile` are retained for compatibility but are now
    **derived from** the tank rather than inputs to it.
  - `drain`, `oilTargetGap`, `oilDensity`, `gemDensity`, `oilRefuelSeconds`, `pathTiles` are what
    `populate.js` needs to place the economy (§4.4).
  Also `gemScore`, `levelBonus`, `oilFuel`, `coerceSetting`, `defaultSettings`, `sanitizeSettings`,
  `sanitizeBest`, `MAP_MODES`, and the new derived helpers `CAP_LEVEL`, `tankSeconds(level)`,
  `drainRate(level)`, `travelTiles(seconds, drain)`, `estimatedPathTiles(level)` and
  `resolveTank(level, offered)`, and `gapSafety(level)` (the refuel-chain headroom multiplier,
  `FUEL.GAP_SAFETY` 0.7 on level 1 → `FUEL.GAP_SAFETY_END` 0.8 at the cap, applied to
  `oilTargetGap`). `FUEL.LOW_FRACTION` (0.25) is the `lowFuel` threshold;
  `FUEL.OIL_MIN_USEFUL_FRACTION` (0.55) is how much of a flask must be usable before the sim consumes
  it (the same rule `feasibility.test.mjs` models); `LEVEL.DRAIN_RAMP_START` (5) is the last level
  that burns at 1× before `drainRate` climbs by `FUEL.DRAIN_PER_LEVEL`. Frozen tables `PLAYER / BUMP / BOB / WORLD / SIM / FUEL / SCORE /
  ATTRACT / LEVEL`. Removed with the old economy (nothing referenced them): `FUEL.BASE_SECONDS`,
  `PER_CELL_START/END`, `DECAY_LEVELS`, `PER_PATH_TILE_START/END`, `PAR_FRACTION`,
  `LEVEL.GEM_PER_DEAD_END`, `LEVEL.OIL_PER_DEAD_END`.
  **`SETTING_SPEC` gained a third kind, `'enum'`** (`{kind, def, values}`): `mapMode` is
  `'off'|'corner'|'full'`, default `'corner'`. `coerceSetting` takes only a listed string and
  **ignores** anything else rather than snapping to the default, so a garbage `setSetting` leaves
  the player's choice alone. `minimap` stays as the legacy boolean mirror (§3).
- `save.js` — `loadPersist() → {best, settings}` / `savePersist({best, settings})` / `clearPersist()`;
  wraps `localStorage` in try/catch; validates shape; key `amaze.v1`, payload version 1. Every
  failure mode (absent storage, throwing storage, quota, non-JSON, foreign record, version
  mismatch, oversized payload) degrades to factory defaults rather than throwing. All three take an
  optional trailing `storage` argument so tests can inject a fake. (DOM-optional: no-ops in Node.)
- **Actions** (`Action` union):
  `{type:'tick', dt, input:InputFrame}` · `{type:'newGame', seed}` · `{type:'levelReady', data:LevelData}` ·
  `{type:'pause'}` · `{type:'resume'}` · `{type:'nextLevel'}` · `{type:'toTitle'}` ·
  `{type:'setSetting', key, value}` · `{type:'debugWin'}` (headless tools only).
- Phase machine: `title --newGame--> loading --levelReady--> playing <--pause/resume--> paused`;
  `playing --exit reached--> levelComplete --nextLevel--> loading`; `playing --fuel 0--> gameOver --toTitle--> title`.
  In `title` the sim runs an **attract-mode camera** wandering the title maze (main.js dispatches
  `levelReady` for a small demo maze at boot with phase kept at `title`).
  Edges the sketch left open, now pinned _(integrator decision)_:
  `newGame` is honoured from `title|gameOver|levelComplete|paused` but **ignored in `playing` and
  `loading`** — a run in progress is abandoned deliberately, through pause. `toTitle` is honoured
  from `gameOver|levelComplete|paused` only. `toTitle` and `newGame` from `paused` fold the
  abandoned run into `best` through `recordBest` first (§3), so quitting never loses a record. There is **no exit from `loading`**: `src/main.js`
  owns that recovery instead (stale-build tokens, one reseeded retry, and a 12 s watchdog), which
  keeps the phase machine total and the failure handling in the one place that knows about workers.
  `levelData` and `explored` are deliberately preserved during `loading` so the renderer keeps a
  coherent backdrop behind the loading screen; `levelReady` swaps both atomically.

### 4.3 `src/input` (Wave 1)
- `input.js` — `createInput(canvasEl:HTMLElement, opts?:{sensitivity?, invertLook?, shouldLockPointer?, touchRoot?, touchOverlay?, bindings?, env?}) → { poll():InputFrame, setOptions(o), requestPointerLock(), updateOverlay(state), setBindings(tables), destroy(), isTouch:boolean, pointerLocked:boolean, wantsPointer:boolean }`.
  _Additive (gauntlet round 2):_ `bindings` is a `BindingTables` from `createBindings(overrides)`
  (default layout when omitted); `setBindings(tables)` swaps the keyboard layout at runtime (null or
  garbage restores the defaults) and releases every held key, because a key held across the swap
  would decrement a different slot on keyup; `wantsPointer` is true while the game wants mouse look
  but does not own the pointer (playing, not touch, lock supported, not locked) — the hook for a
  "click to look" prompt.
  Keyboard (`code`-based, layout independent), mouse w/ pointer lock, gamepad (deadzone 0.18),
  touch (virtual stick left 40% of screen, drag-look on right, rendered by `touch-overlay.js`).
  `poll()` reuses one frame object **and one `pressed` Set** (no alloc) — never retain either.
  Clears stuck keys on `blur`, `visibilitychange`, pointer-lock loss and `touchcancel`. Never calls
  `preventDefault` on keys when a text field is focused or a modifier is held.
  `shouldLockPointer()` is consulted on every canvas click: main.js returns `phase === 'playing'`,
  so clicking a menu never swallows the cursor. `env` injects globals for Node tests.
  A gamepad's right stick feeds `frame.turn` (a rate), **not** `lookDX` (a displacement): the
  input module does not know the sim's `dt`, and routing a sustained deflection through `turn` is
  the only dt-correct option. Escape deliberately emits both `back` and `pause` in one frame; M and
  Tab both emit `map`; WASD and the arrows also emit `up/down/left/right` for menus. Consumers
  disambiguate by phase.
- `bindings.js` — default key map (`KeyW`/`ArrowUp` → forward, etc.) plus the lookup tables
  (`KEY_HOLD`, `KEY_ACTION_MASK`, `GAMEPAD_BUTTON_*`), the deadzone helpers and `CONTROL_HINTS`.
  Remappable keyboard layer: `DEFAULT_KEY_BINDINGS` (code → names, in the JSON-safe vocabulary of
  `HOLD_NAMES` + `InputAction`), `createBindings(overrides?) → BindingTables {keyHold, keyActionMask}`
  (total on garbage; an override replaces that code's binding wholesale; `Escape` cannot be
  remapped, so a bad remap can never lock a player out of the pause menu), `DEFAULT_BINDINGS`
  (the default tables, built once; `KEY_HOLD`/`KEY_ACTION_MASK` are its two halves),
  `keyLabel(code)` (keycap text) and `describeControls(tables?)` (the Controls-screen rows generated
  from the tables, so hints follow a remap; `CONTROL_HINTS === describeControls(DEFAULT_BINDINGS)`).
  **Persistence is deferred** _(integrator decision)_: nothing in the game edits a remap yet, so
  `Settings` has no `keyBindings` field and main.js passes the default `CONTROL_HINTS`. When a remap
  screen lands, add `keyBindings: BindingOverrides` to §3 `Settings` (sanitised in `balance.js`), and
  main.js calls `input.setBindings(createBindings(settings.keyBindings))` and hands
  `describeControls(thoseTables)` to the menus.
- `touch-overlay.js` — `createTouchOverlay(root, {onAction?, document?}) → { update(state), setStick(...), destroy(), element }`
  draws the stick and pause/map buttons as DOM/CSS elements. `input.js` owns it and creates it
  lazily on the first real touch; `{touchOverlay:false}` opts out. The button bar carries the class
  `amaze-touch-bar` so `styles.css` (integrator) can keep it clear of the HUD's top-right panel.

### 4.4 `src/maze` (Wave 2)
- `constants.js` — `TILE = { FLOOR:0, WALL:1 }`, `DIRS`.
- `generator.js` — `generateMaze({cols, rows, seed, braid=0}) → Maze`. **Iterative randomized
  recursive backtracker** with an explicit `Int32Array` stack (no recursion → no stack overflow at
  any size), followed by optional **braiding** (remove `braid` fraction of dead ends by knocking a
  wall into a neighbouring corridor — keeps solvability, adds loops). Start = cell (0,0); exit =
  the cell **farthest from start** by BFS distance (guarantees a long route). Must handle
  1×1 up to 2000×2000 cells in bounded memory/time (O(n)).
- `validator.js` — `validateMaze(maze) → Validation` via iterative BFS over tiles (typed-array
  queue). Checks solvable, fully connected, sealed border, tile values in range, start/exit on
  floor; computes shortest path, dead ends, loop count. Pure, Node-safe.
- `populate.js` — `populateLevel(maze, validation, params, seed) → {items, torches, fuel, par}`.
  Reads (every one optional, with a documented fallback): `gems`, `oil`, `gemDensity`, `oilDensity`,
  `oilTargetGap`, `oilRefuelSeconds`, `drain`, `cells`, `fuelSeconds`, `par`. `params.oil` is a
  **floor** (the refuel chain may place more); `gems`/`oil` set to `0` means zero, not "unspecified".
  - **The refuel chain (the placement guarantee of §1).** A first pass walks `validation.path` and
    drops a flask — on the path, or on a side passage within `OIL_BRANCH_RADIUS` (3) tiles — before
    the advance since the last *reachable* flask could exceed `G`, the distance one flask pays for:
    `G = floor((R·S/spt − 2·radius)/w)` with `R` the flask value, `S` a 0.9 safety factor, `spt` the
    fuel-seconds per walked tile (including `params.drain`) and `w` the 2.0 wander factor. Placement
    and verification agree on *where along the route a flask counts* through one primitive
    (`nearestPathFrom`: the smallest path index reachable within 3 tiles, plus its depth) — without
    that, a flask whose corridor doubles back near the start would be counted where it was placed
    and picked up much earlier. The induction proof (fuel at every chain flask is `T`; each hop
    costs ≤ `R` ≤ 0.35 `T`) is a header comment in the file.
  - **Gap ownership:** `params.oilTargetGap` may only **tighten** populate's own sustainable bound,
    never loosen it (`resolveGap`). A balance change that wants a longer leash must raise the tank
    or the flask value — a state-side retune can never silently break the guarantee.
  - **Counts are area-driven:** explicit `gems`/`oil` win, else `gemDensity`/`oilDensity` (read
    defensively in either unit: ≤ 1 = items per cell, > 1 = cells per item), else a built-in
    size-keyed curve. Hard cap `MAX_ITEMS_PER_KIND` = 4096 per kind (bounded memory; a tool building
    far past the shipped curve gets a clamped, sparser set — deliberate, and a cliff rather than a ramp).
  - **Scatter is stratified bucket sampling** (≈ quota square buckets, best-scoring free tile per
    bucket, seeded bucket order, stride fallback): O(tiles), even coverage, no O(items²) separation
    test and no global sort. Oil scores toward `pathDist ≈ 2` (a visible side pocket); **gems are
    ranked by "far from the solution path" plus a dead-end preference** — the old "farthest from
    start" BFS is gone (one BFS and 264 kB saved at the cap).
  - Torches on corridor walls spaced ≥ 6 tiles (`face` uses the same direction numbering as `DIRS`,
    0=E,1=S,2=W,3=N).
  - `fuelBudget(pathLength, params, cells?) → {fuel, par, directTime, usage, reach, refuel, gap}`
    (`cells` also falls back to `params.cells`). `usage` now means **"tanks a perfect run burns"**
    and is routinely > 1 on a big maze; `par` is a target time and is **no longer clamped to `fuel`**.
  - `walkRefuelChain(maze, validation, items, params) → {flasks, maxGap, gap, tank, refuel, walked,
    minFuel, minFuelFraction, ok}` — the **verification twin** of the chain placement, so the gate
    and the unit tests share one definition of the promise. Tool/test helper only: it allocates
    O(tiles); the game never calls it.
  - **Fuel seam _(integrator decision — the old one is dead)_:** `params.fuelSeconds` **IS the tank**,
    owned by `balance.js`. The previous text — "balance.js supplies a size-based floor
    `55 + cells × perCell` that is larger than the path-derived budget, so the floor wins" — described
    an economy that no longer exists. There is exactly one owner of the tank, and `populate.js` no
    longer derives one from the path. Belt and braces in the other direction: `src/state` clamps
    `LevelData.fuel` **down** to the tank through `balance.resolveTank`, so level data may lower the
    tank (tutorial, demo, fixture) but never raise it — a stale worker build or a future path-derived
    budget (~650 s on a 128×128 level) can never inflate the economy. Retune from `FUEL.*` and
    `LEVEL.*` in `balance.js`.
- `level.js` — `buildLevel(params:{cols,rows,braid,gems,oil,fuelSeconds,par}, seed) → LevelData`
  (generate → validate → **throw if invalid** → populate). Deterministic for a given seed.
  Also `assertMazeValid(maze, validation, braid?)` (the guard, exported so its message is testable)
  and `levelTransferList(data) → ArrayBuffer[]` (the buffers to hand to `postMessage`).
- `worker.js` — module worker: `onmessage {id, params, seed}` → `postMessage {id, data}` with the
  `tiles` and `path` buffers transferred; errors posted as `{id, error, name}`. The listener is
  installed only inside a real worker scope, so the file imports inertly in Node and the pure
  `handleMazeRequest(msg)` stays unit-testable. It must be served from the same directory as
  `client.js` (resolved with `new URL('./worker.js', import.meta.url)`, started with `{type:'module'}`).
- `client.js` — `createMazeClient(options?) → { build(params, seed):Promise<LevelData>, dispose(), mode(), pending() }`:
  uses the worker when `cols*rows > 400` and `Worker` exists, else sync; 10 s timeout → sync
  fallback; never throws uncaught. **Every** infrastructure failure (no `Worker`, constructor
  throws, `onerror`, `onmessageerror`, malformed answer, uncloneable message, timeout) degrades to
  a synchronous rebuild; only a genuine build failure rejects. `options` (`threshold`, `timeoutMs`,
  `mode`, `WorkerCtor`) exists so those paths can be tested; calling it with no arguments behaves
  exactly as specified above.
- The `LevelData` that reaches main.js **owns** the transferred buffers: do not post the same
  object onward without calling `levelTransferList()` again.
- **Headless verification runner:** `tools/validate-mazes.mjs` generates thousands of mazes across
  seeds and sizes (1×1 … 512×512, braid 0…1) and asserts `solvable && fullyConnected &&
  bordersSealed` for **100%** of them, plus perfect-maze `loops===0` when `braid===0`. It then
  builds the **real campaign** (levels 1…30 × 25 seeds) and asserts, per level: the refuel chain gap
  ≤ `oilTargetGap`, the torch never reaching 0 on the simulated walk, walked-feasibility < 1, items
  on floor / tile centre / unique / reachable from start, the exit being **exactly** the BFS-farthest
  cell, valid torches, and a bit-identical replay from the seed. It imports the real `levelParams`
  from `src/state/balance.js` — **a tool may import state** (`src/maze` still may not), which killed
  the hand-matched copy of the level curve that used to live inside it. Exit code ≠ 0 on any failure.
  `tools/stress.mjs` pushes 2000×2000 (4M cells) for time/memory, and adds the **gameplay-maximum**
  case (128×128 braid 1, populated, 100 seeds) plus a 30-level campaign leak loop; its leak
  measurement drains the collector three times, because one `gc()` leaves a full loop's transient
  `ArrayBuffer`s on the books (48.9 MB → 0.0 MB, measured).

### 4.5 `src/renderer` (Wave 1 shell, Wave 3 polish)
- `palette.js` — the master palette (**66 colours**, hard limit 256) sampled from the art
  reference; every material needs a 5–9 step ramp for the ordered dither to avoid banding at 240p.
  All textures and UI colours come from here. Exports `PALETTE`, `PALETTE_RGB`, `C` (name → index),
  `RAMPS`, `pack`, `hex`, `rgba`, `nearestIndex`.
- `textures.js` — `createTextures(seed) → TextureSet` procedurally paints 64×64 pixel-art
  textures (indices + packed pixels + a stipple mask): `wall[4]` (plain, cracked, mossy, vined),
  `floor[3]` (two cobbles + iron grate), `ceiling[2]` (planks, planks + beam), `portal[8]`,
  `torch[4]`, `gem[8]`, `oil[4]`, `sparkle[4]`. **Every field is an array** — consumers index them,
  and the raycaster picks a per-tile variant by hash. Deterministic and Node-safe (no DOM) so it
  can be unit tested; ~20 ms for a full set.
- `sprite-index.js` — `createSpriteIndex(cell = INDEX_CELL) → SpriteIndex` with
  `build(count, readX, readY, tilesW, tilesH)` and the public typed arrays `cellStart` / `entries` /
  `px` / `py` plus `cell` / `cols` / `rows` / `count`. A uniform-grid (counting-sort) bucketing of a
  level's point decoration, exported `INDEX_CELL` = 8 tiles. Positions are copied into flat
  `Float32Array`s so the per-frame distance test never dereferences an item or torch object; a
  rebuild allocates only above the previous high-water mark. Pure data structure: no DOM, Node-safe,
  imports nothing.
- `raycaster.js` — `createRaycaster(canvas, {textures?, seed?}) → { resize(cssW, cssH, dpr), render(view:RenderView), stats():RenderStats, internalSize:{w,h}, particles, textures, setTextures(set), depth(), lights(), dispose() }`.
  Canvas 2D `ImageData` + `Uint32Array` framebuffer at **low internal resolution** (height 240,
  width from aspect, clamped 320…560 and made even), upscaled with CSS `image-rendering: pixelated`.
  DDA wall casting with textured walls, one perspective row-walk serving floor **and** ceiling,
  per-column z-buffer, sorted billboard sprites (items, portal, torch flames) with z-test,
  **dynamic lighting**: player torch radius = `lerp(2.5, 7, view.light)` with two octaves of
  flicker + the eight nearest wall torches as point lights (each occluded by the plane of the wall
  it is bolted to) + distance fog to a cool blue-black. Head bob offsets the horizon, quantised to
  whole pixels so the wall base and the floor rows cannot disagree by a pixel and shimmer.
  Shading is a Doom-style **colormap** (64 levels × 256 entries of pre-packed RGBA) plus a 4×4
  Bayer dither: one array lookup per pixel. Zero allocations per frame; `stats()` and
  `internalSize` are reused objects. Never throws: a missing context, a null maze or a NaN time
  degrade to a fog-filled frame.
  `RenderStats = {ms, msAvg, w, h, dpr, sprites, lights, particles, frames}`.
  **Massive-maze culling — the sprite and light passes are O(sprites near the camera), not
  O(level):**
  - Both gather passes walk a `sprite-index.js` grid instead of the level arrays. The index is
    rebuilt **only on a level change**, detected by the **identity** of `view.maze` / `view.items` /
    `view.torches` (plus their lengths). _This is a load-bearing assumption about main.js:_ those
    three fields must be re-assigned from the new `levelData` on a level change and the arrays must
    not be mutated in place. If that ever stops holding, add an explicit `levelToken:number` to
    `RenderView` and key off it instead. Pickups never trigger a rebuild — a taken item keeps its
    bucket and is skipped at query time. Measured: 95 µs to rebuild both indexes for 2 098 points.
  - Sprites are culled at a derived **`SPRITE_FAR` (≈ 21.1 tiles)** rather than at `FAR` (30): past
    it `illum × fog(d) × 63` truncates to 0, which is literally the fog colour the frame was cleared
    to. `SPRITE_FAR` is computed at module load from the same fog formula the shading uses, so
    retuning the fog moves the cull automatically (and a test asserts byte-identical frames at
    22/24/27/29 tiles and a *changed* frame at 18, so an over-aggressive retune fails loudly).
    `FAR` still governs walls, floor/ceiling and the DDA. `inFrustum(dx,dy)` (exact horizontal
    frustum test + 1.0 slack) keeps off-screen sprites out of the distance sort.
  - **`MAX_SPRITES` is 384 (was 192) and overflow now evicts the *farthest* queued sprite** instead
    of dropping the next one offered. This fixed a real bug at scale: torches are queued before
    items and a level-15 neighbourhood holds up to 197 sprites within `FAR`, so the queue used to
    fill with distant flames and the gem at your feet silently vanished. Covered by a regression test.
  - `gatherLights` is an expanding-ring kNN over the torch index (ring `r` is at least `(r−1)·cell`
    from the focus, so once 8 lights are held and the 8th is nearer than that bound the search
    stops — 2–3 rings typically). Provably the same answer as the exhaustive scan, asserted against
    a brute-force sort over 600 torches.
  - **Tile-keyed texture variety** for 257-tile corridors with no new textures: one extra bit of the
    existing per-tile hash mirrors a wall's course horizontally (4 paintings × 64 offsets × 2 mirrors
    = 512 looks, one comparison per column); because a floor texel index is `(v<<6)|u` with both
    fields 6 bits, a per-tile XOR mask of `(63<<6)|63` gives all four dihedral flips for **one xor
    per pixel** (2 cobble paintings → 8 looks). The ceiling is deliberately left unflipped so its
    beams stay aligned.
  - **The DDA is bounded by fog, not by maze size.** Measured over 480 columns × 8 headings × 40
    stations: ~1.0 steps/column and ~15 distinct `maze.tiles` reads per frame at 33², 129², 257²,
    1025² *and* 2001² tiles; the loop always exits on `dist > FAR`, never on `MAX_DDA_STEPS` (160).
    There are no level-sized tables in the renderer.
  - `lights() → {n:number, x:Float32Array, y:Float32Array}` returns the wall torches selected as
    point lights on the last frame, as world positions of the flames (already offset off their
    wall). Reused object and live arrays, exactly like `depth()`; **diagnostic only**, no consumer
    in main.js — it is the seam the nearest-8 equivalence test needs.
- `RenderView` = `{ player:{x,y,angle,bob,bobAmp,shake}, maze:Maze, items:Item[], torches:Torch[], exit:Vec2, time:number, light:number /*0..1 torch strength*/, flash:{r,g,b,a}, portalOpen:boolean, reducedMotion:boolean }`
  — built once by main.js and mutated in place. `time` is the sim clock in seconds: it drives every
  animation and is differenced internally for particle timing, so pausing the sim freezes effects.
- `post.js` — `createPost(rootEl) → { set({scanlines?, vignette?, lowFuelPulse?, flash?, iris?}), resize(cssW, cssH, internalH), destroy() }`
  CSS overlay effects (scanlines, vignette, red low-fuel pulse, flash tint, iris wipe: 1 = open,
  0 = closed). `resize` is **required** for correct scanlines — the pitch must be a whole number of
  CSS pixels per internal row or the pattern moirés. Omitted fields keep their previous value and
  nothing is written to the DOM unless a value actually changed (alpha quantised to 1/128), so
  `set()` is safe to call every frame. A null/DOM-less root returns an inert no-op.
- `particles.js` — pooled world-space pixel particles for sparkles/embers:
  `createParticles(capacity?) → { spawn, burst, update(dt), draw(buf, w, h, zbuf, cam), clear, count, capacity }`.
  The raycaster owns one instance and exposes it as `raycaster.particles`, so `RenderView` needs no
  particle field. Units are tiles and tiles/second; `z` is height above the floor (0.5 = eye).
- **Two flash paths, never both for one event:** `view.flash` tints the 3-D framebuffer only (use
  it for a pickup, inside the world); `post.set({flash})` tints everything the post layer covers
  (use it for level complete / game over). Using both doubles the brightness.

### 4.6 `src/ui` (Wave 3)
- `font.js` — built-in **bitmap pixel font**: a gothic display face (12 rows, proportional, uniform
  digit width) for titles and a clean 5×7 HUD face in an 8-row cell (one descender row) — both
  covering 0x20…0x7E plus `© × … ·`. `drawText(ctx, text, x, y, {font, size, color, shadow, align,
  baseline, tracking, lineHeight, alpha})`, `drawTextBlock`, `measureLine`, `measureText`,
  `wrapText`, `fontMetrics`, `lineHeight`, `textHeight`, `catchesLight(glyph, x, y)` (the rim-light
  rule for the gothic face, exported for its test), plus `COLOR` and `FONT_STYLES`.
  **`size` is an integer pixel scale** (1 = one font pixel per surface pixel), not a point size;
  `measureText` returns `{width, height, lines}`. Glyphs are blitted from per-(face,style) atlases
  built on first use. The overlay canvas is sized at the renderer's internal resolution ×2, so
  lettering is pixel-crisp.
  _Additive:_ a **scalar per-frame API** that takes no options object — `drawAt(ctx, text, x, y,
  font, size, color, align, baseline, alpha)`, `measureAt(text, font, size)`, `heightAt(font, size)`
  — so the HUD and menus allocate nothing per frame; `setLayoutProbe(fn)` / `probeLayout(kind, x, y,
  w, h, unit, label)` (a test hook the geometry/layout audits install to record every laid-out box;
  a no-op when unset) and `fontCacheSize()` / `clearFontCache()` (atlas-cache introspection for the
  allocation tests). Also `hasGlyph`, `faceInfo`, `glyphMask`.
- `pixels.js` — the leaf pixel-art primitives, moved out of `hud.js` to break a would-be import
  cycle (`hud → map → hud`): `withAlpha`, `hexToRgb`, `compileArt`, `drawArt`, `drawPanel`,
  `drawWell`, `strokeRect`, `drawTorchIcon`, `drawGemIcon`, `drawOilIcon`, `drawPortalIcon`,
  `drawFlame`, `fillDisc`, `fillRing`, `fitScale`, `ICON_SIZE`, `ARROWS`, `ARROW_PALETTE`, plus the
  additive `withAlphaStep(hex, step)` (`withAlpha` with the alpha pre-quantised to 64ths, 0…64,
  so an animated alpha on the per-frame path passes a small integer and allocates nothing), `fitScaleAt(text, maxWidth, font, maxScale, minScale?)` (the scalar
  twin of `fitScale`) and `createArtSprite(art, palette)` (large art such as the title wordmark, rasterised
  lazily once so a draw is one `drawImage` instead of a `fillRect` per colour run).
  **`hud.js` re-exports every one of them verbatim**, so §4.6's published surface and every existing
  import path are unchanged. Module graph stays a strict DAG: `font/format/core → pixels → map →
  hud → menus`.
- `map.js` — the **three-state map** (the massive-maze replacement for the minimap). Exports `MAP`,
  `MAP_MODES`, `MAP_MODE_LABEL`, `MapMode`, `normalizeMapMode`, `nextMapMode`, `mapModeFromSettings`,
  `readMapMode`, `setMapMode`, `cycleMapMode`, `resetMapMode`, `createMapView`, `paintTiles`,
  `countExplored`, `chooseFullScale(cols, rows, boxW, boxH, out?)`, `fitBeats(a, b)`, `cornerWindow`.
  - **OFF → CORNER → FULL**, cycled by the existing `map` action. CORNER is a 25-tile (19 on a phone)
    window centred on the player, zoomed 2–6×. FULL is a full-screen labyrinth map: header
    (`DEPTH n · 128×128`, `MAPPED %`), the fitted map, and a legend (gems n/total, OIL, EXIT,
    distance to the exit once seen). The fuel gauge stays on screen in FULL, so the torch keeps
    burning while you read it. The view's internal `drawFull(ctx, m, state, clock, reduced,
    gaugeRight?, gaugeBottom?)` lays the page out two ways — **strips** (header above, legend below)
    and, on a wide screen, **rails** (header and legend in the side gutters, the map gets the whole
    height) — fits both with `chooseFullScale` (the optional `out` fills a reused fit, so comparing
    them allocates nothing) and keeps whichever draws bigger by `fitBeats`; a tie goes to the rails.
  - **Resolution _(deviation from "one pixel per cell", deliberate and measured)_:** cell resolution
    loses the walls entirely — they are thinner than a pixel. `chooseFullScale()` takes **tile**
    resolution whenever a whole pixel per tile fits and falls back to cell resolution otherwise, and
    it fits in **device** pixels rather than the chunky UI pixels (the UI grid is 5 device px per
    unit on a phone). That turns a 128-cell map on a 390×844 phone from 128 px of wall-less
    silhouette into 1 028 device px — 88 % of the screen width — of real labyrinth. At the shipped
    128-cell cap neither target layout needs the cell fallback; it is kept, documented and
    unit-tested because it is what a smaller viewport or a raised `MAX_CELLS` would hit.
  - **One incremental offscreen raster, blitted with a single `drawImage`.** The old minimap scanned
    all 66 049 explored bytes *every frame* just to decide whether to rebuild. Now: the sim only
    reveals within radius 3, so each frame rescans a small box around the player grown by the
    distance moved; a 4 096-index rolling sweep reconciles anything revealed outside that box within
    ~0.3 s; the raster is its own dirty-state (a tile is drawn iff its pixel is non-zero) so
    `exploredCount` is an increment rather than a scan; and only the touched sub-rect is pushed via
    the dirty-rect form of `putImageData`. Items are **baked into the raster** (zero per-frame item
    work at 1 024 items) and a taken flask is noticed by a prune running twice a second.
    Measured at the worst case (257×257 fully explored, 1 024 items, 1280×720): CORNER ≈ 0.022 ms
    and FULL ≈ 0.017 ms per frame against a 1 ms budget; **4 263 tile reads per frame, constant in
    maze size**, where the old path read 66 049 for the count alone; 0 pixels painted and 0
    `putImageData` calls in steady state. One-off: 1 ms per level to allocate and rasterise.
  - The mode is a **module-level singleton**, deliberately: the HUD draws it, the options screen
    edits it and main.js cycles it, and all three must agree (there is one overlay per page).
    `resetMapMode()` is exported for tests; `hud.reset()` does **not** reset it — a new run should
    not silently turn the map back on.
  - `map.js` mirrors `WORLD.REVEAL_RADIUS = 3` as `MAP.REVEAL_RADIUS`; the incremental update's
    correctness depends on it. If the sim ever reveals further, the local box would miss tiles — the
    rolling sweep still catches them within ~0.3 s, so it degrades to a slight lag rather than a
    hole, but the constant must be raised to match.
- `hud.js` — `createHud(overlayCanvas, {map?:'off'|'corner'|'full', minimap?:boolean|MapMode}) → { render(state, frameStats?, alpha?), resize(cssW, cssH, dpr?), surface, pop(value, kind?), cycleMap(settings?), mapMode(settings?), mapStats(), reset(), dispose() }`
  (`minimap: true` still means `'corner'`, so an older call site keeps working):
  fuel gauge, score with rolling counter + pop-up deltas, gem count, depth, level timer, compass
  needle toward the exit **plus a distance-to-exit readout in tiles** — both free on depths 1–2 and
  from depth 3 earned at `compassGems(gemsTotal)` = `min(8, ceil(15 % of gemsTotal))` gems, an
  absolute count so the instrument stays reachable at the cap (exported and pinned by a test), the map (via `map.js`), FPS in
  `?debug=1`. `cycleMap` advances OFF → CORNER → FULL and returns the new mode; `mapMode` reports the
  one in force; `mapStats()` returns a reused
  `{updateMs, drawMs, painted, scanned, flushes, explored, tiles, rebuilds}` (**stale while the mode
  is `'off'`** — no update runs, so it keeps its last numbers rather than zeroing).
  **The gauge reads as a tank, not a countdown** (this is the massive-maze change in the HUD):
  quarter-tank graduations every 4 segments, a refill surge (the bar sweeps up from where the eye
  last saw it with a white-hot leading edge, the panel edge flares, the torch icon relights for the
  flare even at 3 % fuel), a recurring low-tank alarm (pulsing red outline, cooled flame, `LOW` chip)
  and a `TANK ×N` refuel tally. The depth panel is one line, `DEPTH n · C×R` (two lines on a
  phone); the level clock and `MAPPED %` live on the full-map header and the pause screen.
  It prefers `run.refuels` (§3) and falls back to its own tally of rendered fuel rises.
  Also exports the shared overlay `createSurface(canvas)` — whose `Surface` gained
  `setViewRect(cssX, cssY, cssW, cssH)` (where the 3-D view sits inside the overlay, CSS px; a
  zero width reverts to measuring `#view` on resize) and whose `SurfaceMetrics` gained
  `viewX/viewY/viewW/viewH` (that rect in UI pixels, the whole surface when unknown), so layouts
  keep rows off the edge of a portrait phone's world band — `mapPointer`, the `pixels.js` primitives
  re-exported verbatim, and the map-mode helpers (`MAP_MODES`, `MAP_MODE_LABEL`, `readMapMode`,
  `setMapMode`, `cycleMapMode`, `nextMapMode`, `normalizeMapMode`, `mapModeFromSettings`,
  `resetMapMode`) so main.js and `menus.js` need not know the map moved.
  The full-screen map briefly switches the canvas transform to device-pixel space
  (`save → setTransform → clip → blit → restore`) and always restores before returning, on every
  exit path including the early return, so `menus.render()` is unaffected.
  `render()` **clears the whole overlay**, then draws only in `playing` (full) and `paused`
  (dimmed to 45 %). Score/fuel pops are derived from `GameState` deltas, not from `state.events`:
  the HUD renders per frame while events are per dispatch, so events would be missed on a
  double-step frame and replayed on a double-render one. main.js must therefore **not** also pop
  on `pickup` events.
- `menus.js` — `createMenus(overlayCanvas, callbacks:{onNewGame, onResume, onQuit, onNextLevel, onSetting, onUiSound, controls?}) → { render(state), handleInput(frame:InputFrame, state):boolean, handlePointer(ev):boolean, resize(cssW, cssH, dpr?), surface, screen(), dispose() }`:
  title (logo "A-MAZE" in gold gothic lettering + "Descend", "Options", "Controls", "Credits"),
  pause (which also gains a "Controls" row), a **Controls** sub-screen, options (volume, music, sensitivity, scanlines, **Map** — a three-state `choice` row, not a
  toggle — reduced motion, invert look), loading, level complete (staggered tally: gems, fuel bonus,
  depth bonus, total), game over (score, best, "Try again").
  Keyboard/gamepad navigable **and** mouse/touch clickable.
  `controls` is the `ControlHint[]` the Controls screen lists; main.js passes `CONTROL_HINTS` from
  `src/input/bindings.js` (the owner of the bindings — `src/ui` may not import `src/input`), and
  menus.js spells the arrow glyphs out as words for the bitmap font. Omitted (a harness), a mirrored
  fallback table is shown.
  Massive-maze additions: a new `MenuItem` kind **`'choice'`** (fields `values`, `labelOf`, `read`,
  `write`; `write` is handed the settings writer rather than calling `onSetting` itself, so one row
  can shadow both `mapMode` and the legacy `minimap`); the **loading screen** names what is being
  carved (`DEPTH 8 · 72×72 LABYRINTH`, `5 184 CELLS`) — which needs the mirrored `LEVEL_RULES`
  below, because during `loading` the state still holds the *previous* level's `levelData` (§4.2), so
  the incoming size is not in the state at all; and the level-complete / game-over screens gained an
  **expedition strip** (`LABYRINTH`, `EXPLORED %`, `REFUELS`, `WALKED`), whose rows are omitted
  rather than shown as `--` when the data is absent. Also exports `cellsForLevel(level)`.
  `handleInput` returns **false** in `playing` and `loading` so main.js keeps its own
  pause/map/mute hotkeys, and true on every menu screen.
  **Back / quit semantics _(gauntlet round 2)_:** back on `paused` resumes (`onResume`). Back on
  `levelComplete` **never** leaves: it finishes the tally if one is rolling and moves the cursor to
  *Quit to Title*. *Quit to Title* on the pause and level-complete screens opens a **`'confirm'`**
  sub-screen ("Abandon the descent?", rows *Keep Going* / *Abandon*); only *Abandon* calls
  `onQuit`, and back on it closes the dialog. Game over is unchanged: back calls `onQuit` (that run
  is already over). `screen()` returns `'title' | 'options' | 'controls' | 'credits' | 'pause' |
  'loading' | 'complete' | 'gameover' | 'confirm' | 'none'`. `onUiSound` may also carry `'uiBack'` and
  `'uiDeny'` (main.js plays both as the back blip). `handlePointer` returns true when it
  consumed the event (main.js then suppresses the default, and no pointer lock is requested).
- **Frame protocol:** `hud.render(state, stats, alpha)` **then** `menus.render(state)`. The HUD
  opens (and clears) the shared overlay frame; the menus only open one if nothing else did. The
  reverse order would erase the menu.
- `audio.js` — `createAudio(options?) → { unlock(), handle(events:GameEvent[], state), setVolume(v, music), update(state), playUi(kind), suspend(), resume(), dispose(), stats(), unlocked, available }`
  **WebAudio-synthesized** SFX (footsteps, bump, gem chime with a combo pitch ladder, oil whoosh,
  portal hum panned by the **straight-line bearing to the exit, through walls** — "where is it", not
  "which way is the path"; the sim exposes no next-path cell to pan toward — heartbeat on low fuel, UI blips, level fanfare, game-over snuff)
  and a soft generative dungeon drone, through sfx/music buses with per-bus reverb into a
  compressor and a tanh limiter (output can never clip). No audio files. No `AudioContext` is
  constructed until the first gesture — the module attaches its own one-shot gesture listeners, so
  `unlock()` from main.js is belt-and-braces. It adopts `settings.volume`/`.music` from the state
  whenever they change, suspends on `document.hidden` and rebases its scheduler on return.
  `setVolume(0)` is a hard mute that allocates **no** WebAudio nodes at all.
  Synthesis constants live in the exported `AUDIO` table rather than in `balance.js`, because §2
  forbids `src/ui` from importing `src/state`; they are audio-internal, not gameplay balance.
- `format.js` — also gained `formatLabyrinth(cols, rows)` (`128×128` with a real multiplication
  sign), `formatLevelBanner(level, cols, rows)` and `formatUnits(n, unit)`; `formatDistance` now
  groups thousands (`1,240m`), because a walk across a 128-cell maze runs to four figures.
  `createTextMemo(build)` returns an allocation-free memo keyed on up to three quantised numbers, so
  the HUD re-formats a readout only when its text would change. The rolling score counter is a
  **fixed-length ease-out** (`ROLL.DURATION` 0.55 s whatever the gap, never slower than
  `ROLL.MIN_RATE` units/s).
- **Mirrored constants:** `src/ui` may not import `src/state`, so `menus.js` mirrors the §1 score
  formulas, the slider ranges of `SETTING_SPEC`, and now **`LEVEL_RULES`** (`BASE_CELLS` 16,
  `GROWTH` 8, `MAX_CELLS` 128, for the loading banner only); `hud.js` (`LOW_FUEL_FRACTION`) and `audio.js`
  (`AUDIO.HEART.lowFraction`) both mirror `FUEL.LOW_FRACTION`;
  `map.js` mirrors `WORLD.REVEAL_RADIUS`. All of them cross-check against state the sim computed
  (the tally is derived from `run.levelScore`, every other size reading uses the real
  `maze.cols`/`maze.rows`), so a drift shows up as a wrong split or a wrong loading banner, never as
  a wrong total — but they must be updated together with `balance.js`.
  `FUEL.LOW_FRACTION` is **0.25**: on the tank that is a 27.5 s (level 1) to 37.5 s (cap) warning,
  comfortably more than one `oilTargetGap`, so the sim's `lowFuel` event, the red gauge and the
  heartbeat ramp all start at the same quarter-tank mark. Retuning it means changing `balance.js`,
  `hud.js` and `audio.js` **together**.
- `styles.css` lives at `/styles.css` (integrator) — layout, pixelated scaling, safe areas.

### 4.7 `src/main.js` (Integrator)

Composition root. Boot is wrapped in a `try/catch` that paints a **styled fatal panel** (inline
styles, so it renders even if `styles.css` is what failed) instead of leaving a black page.

**Boot:** `installGlobalErrorCapture()` → `loadPersist()` → `createStore(createInitialState(settings, best), reducer)`
→ raycaster on `#view`, post on `#post`, HUD + menus on `#overlay`, input on `#overlay` (touch
overlay into `#touch`), audio, maze client → `store.subscribe(routeEvents)` → request the demo
level for the title → `layout()` → `loop.start()`.

**`step(dt)`** (fixed 60 Hz): poll input **once**, offer the frame to `menus.handleInput`, and if it
was not consumed apply the composition root's own hotkeys (pause, **map cycle**, mute toggle); then
`store.dispatch({type:'tick', dt, input})`; then advance the loading watchdog and install a queued
level. The `map` hotkey calls `hud.cycleMap(state.settings)` — the HUD owns the cycle because it
owns the overlay that draws it — and main.js persists the result with **both**
`setSetting('mapMode', mode)` and `setSetting('minimap', mode !== 'off')` (§3). The touch overlay's
MAP button emits the same `map` action, so it gets all three states for free.

**`render(alpha, frameDt)`**: mutate the single `RenderView` with the interpolated player
(`lerp`/`lerpAngle` by `alpha`), `raycaster.render(view)`, `hud.render(state, loop.stats(), alpha)`,
`menus.render(state)`, `post.set({...})`, `audio.update(state)`, `input.updateOverlay(state)`.
Torch strength is `pow(fuel/fuelMax, 0.65)` — readable for most of a level, closing in hard over
the last fifth.

**`routeEvents(state, action)`** runs from the store subscriber, not after the tick, because
`state.events` is cleared at the top of every dispatch (§4.2). It hands the whole array to
`audio.handle`, bursts particles and sets the world flash on `pickup`, sets the page flash on
`levelComplete`/`gameOver`, starts the level build and releases pointer lock on `phase`, and
persists immediately on `gameOver`/`levelComplete`. `setSetting` saves are **debounced**: a change
only marks the settings dirty and `step()` flushes at most once every 0.5 s of sim time, so a slider
drag or the map hotkey's two dispatches become one storage write.

**Teardown:** `pagehide` with `persisted === true` (bfcache) only writes a pending setting — the loop
suspends itself and resumes on `pageshow` (§4.1). A real `pagehide` runs `shutdown()` once: persist
now, stop the loop, remove every listener main.js registered, and dispose the maze client, input,
audio, raycaster, post, HUD and menus, each guarded so one throwing teardown cannot stop the rest.

**Level requests:** every build carries a token; an answer whose token is stale, or that arrives in
another phase, is dropped. A genuine build failure retries twice with a reseeded maze before the
fatal panel; a level that has not arrived in `LOAD_TIMEOUT_S` (12 s) is requested again. Per-level
seed is `createRng(runSeed).fork('level' + level).u32()`, so a run replays exactly from its seed.
_(massive mazes)_ A completed build is **queued, not installed**: the promise stores it in
`pendingLevel` and `step()` dispatches `levelReady` once the loading phase has lasted `MIN_LOAD_S`
(0.8 s), re-checking the token because a retry may have superseded the answer while it waited, and
dropping it outright if the phase left `loading`. Two reasons. First, a 128×128-cell level comes
back from the worker in ~25–60 ms, so without the floor the loading screen would exist for three
frames — the iris would start its wipe and snap back open, and the banner naming the depth and size
of the labyrinth you are about to enter would never be readable. Second, `levelReady` is O(items)
plus a 66 kB allocation at the size cap, which belongs on a sim step rather than in a promise
callback landing mid-render. It is a **floor on the loading phase, never a delay added to a slow
build** — the request still goes out immediately. Measured: the longest animation-frame gap across
the generation *and* installation of a level-15 maze is asserted under 50 ms by `tools/verify.mjs`.
`DEMO_LEVEL` is **1** (16×16 cells): already a substantial labyrinth for a camera that walks one
corridor at a time, under the maze client's 400-cell worker threshold so the title costs no worker
spin-up at boot, and the smallest item/torch load for the pass the renderer sorts every frame.

**Transitions:** the iris (post) is closed while a level is being carved and after a run ends, and
opens over ~0.4 s when a level starts — the §1 iris wipe.

**Layout** _(integrator decision)_: the DOM order is `#view` → `#post` → `#overlay` → `#touch`, so
the post effects frame the **world** and never darken the HUD or the menus. `#view` and `#post` are
sized in JS to the largest box that preserves the framebuffer's aspect, snapped to a whole pixel
multiple when that costs < 3 % (exact 3× at 720p), and centred — at 42 % of the height on a
portrait phone, where the 4:3 framebuffer must letterbox and the deeper deck below the world holds
the compass, the minimap and the thumb on the virtual stick. `#overlay` and `#touch` are inset by
the safe-area insets instead, so a notch never sits on the fuel gauge. After sizing, `layout()` hands the band to the shared overlay surface with
`hud.surface.setViewRect(...)` (overlay-relative CSS px) before `hud.resize`/`menus.resize`, so the UI
lays out around the world band without measuring the DOM itself.

**Focus:** losing window focus or the tab being hidden while `playing` dispatches `pause`; the
cursor is hidden only while the pointer is locked (`body.locked`).

`?headless=1` (or `?debug=1`) exposes
`window.__game = { ready, state(), dispatch(action), subscribe(fn), stepOnce(n), stats(), renderStats(), audioStats(), screen(), mapMode(), errors, input:{inject(partialFrame), clear()} }`
(`screen()` is `menus.screen()` and `mapMode()` is `hud.mapMode(settings)`: a tool driving the menus
through the real input path has no other way to tell whether a keypress landed, and "the options
screen opened" is the kind of thing a gate should assert rather than assume)
for tools. `inject` merges into the real device frame: axes persist until changed, `lookDX` and
`pressed` are consumed by the next step exactly like a real device's edges. `?seed=N` pins the run
seed. `?debug=1` additionally turns on the logger and the HUD's FPS readout. `?fatal=1` throws
during boot on purpose, so the failure screen — the one path playing the game cannot reach — can be
looked at.

## 5. Quality gates (automated)
- `npm test` — every `src/*/*.test.mjs` (node:test) in its own process (**578 tests in 35 files**).
  Two of those files, `src/state/perf.test.mjs` and `src/state/feasibility.test.mjs`, import
  `src/maze` as a **test-only** dependency: the §2 runtime rule is unchanged (`src/state` still
  imports only `src/maze/constants.js` at runtime), but a feasibility proof over fake mazes would
  prove nothing. `perf.test.mjs` pins the step cost against the massive-maze curve (a 128×128 level
  with 819 items must stay within 1.5× of the old 6×6 level; measured 1.06×) and the allocation
  budget (100 000 ticks on a max-size level: < 1 MB, measured +2 kB). `feasibility.test.mjs` walks
  250 real levels (1…25 × 10 seeds) with a 2.0× wander autopilot and requires **250/250** to reach
  the exit, with a negative control (the same autopilot on a flask-stripped level must die).
- `node tools/validate-mazes.mjs` — 100 % solvability across the seed/size matrix plus the refuel
  chain over the real campaign (**117 306 mazes + 750 levels, ~14 s**). `--quick` for a smoke.
- `node tools/stress.mjs` — extreme grid sizes (2000×2000), the gameplay maximum (128×128 braid 1,
  populated, 100 seeds), a 30-level campaign leak loop, a 1×4096 deepest-possible carve and the
  oversize `RangeError`: no throw, no stack overflow, bounded time and memory.
- `node tools/verify.mjs --tag x` — headless Chrome against the dev server. Boots `/?headless=1`,
  screenshots the title, plays **level 1 with an autopilot that BFS-pathfinds through the real
  maze**, detours for items, and **breaks off to find an oil flask whenever the tank drops below
  55 %** — the behaviour the placement guarantee of §1 is written against. Screenshots play, both
  map states and level complete; descends **to the size cap (level 15)**; then drives that
  maximum-size level for 60 s with ~820 items and ~1 300 torches live while sampling fps, step ms,
  render ms and heap, and screenshots the corner and full maps on it. Measures fps and render cost,
  soaks for a leak check, burns the torch out with `stepOnce` to reach game over, then repeats the
  boot at 390×844 for the mobile shots. Gates:
  **zero console errors _and warnings_**, zero page errors, zero failed requests, zero entries in
  the game's own error ring buffer, every phase reached (`title`, `loading`, `playing`,
  `levelComplete`, `gameOver`), both levels cleared by the autopilot, at least one item collected,
  fps ≥ 55 **measured with the compositor's frame limiter on** (a second short run — the main run
  disables vsync so the render budget is visible, which inflates fps to several hundred),
  full render callback < 8 ms average, world render p99 < 16 ms, heap growth < 5 MB over a 20 s
  soak with a forced GC either side, no page overflow on desktop or mobile — plus the massive-maze
  gates: the descent reaching level 15 at **128 cells per side with ≥ 600 items**, the longest
  animation-frame gap across that level's generation *and* installation **< 50 ms**, the 60 s
  cap-level soak holding fps/render/heap to the same budgets while the autopilot actually walks it
  (and discarding **≤ 5** sim steps — `skippedSteps` — so a single process stall passes but a
  death spiral cannot),
  a **4× CPU-throttled cap-level phase** (CDP `Emulation.setCPUThrottlingRate`, 10 s, preceded by a
  3 s unthrottled control sample printed beside every failure so a loaded host is distinguishable
  from a regression) gated at fps ≥ 50, render avg ≤ 12 ms, longest frame gap ≤ 100 ms and
  ≤ 5 discarded steps,
  and the **torch refilling at least twice** with a positive fuel gain (a torch that never refills
  is a countdown, not an economy).
  The wall-clock budgets for clearing a level are 400 s / 500 s: level 1 is now a ~290-tile maze
  that the autopilot walks in ~150 s. Those are test budgets, not gameplay targets — the gameplay
  budget is the torch, and it is gated separately.
  Writes `logs/x.json` + `logs/shot-x-*.png`.
- CI (`.github/workflows/deploy-to-itchio.yml`) runs the first three before every itch.io deploy;
  `verify.mjs` is local-only because it needs a browser and a server.
- Critic gauntlet (`.claude/workflows/gauntlet.js`): per-module score ≥ 8.5 vs top-tier web
  arcade games, zero attributable errors, up to 4 revise rounds. Results in `docs/STATUS.json`.

## 6. Assumptions (documented, autonomous decisions)
- Canvas 2D software raycaster rather than WebGL: at 240p internal resolution a typed-array
  raycaster costs ~1 ms/frame (measured), is pixel-exact for the retro look, and works everywhere.
- Mazes are "thick-wall" tile mazes (`cols*2+1`) so walls are full blocks, like the reference.
- **Massive mazes.** Level 1 = 16×16 cells (33×33 tiles), +8 cells per side per level, capped at
  128×128 cells (257×257 tiles, 16 384 cells) at level 15; stress tests go to 2000×2000.
  `LEVEL.MAX_CELLS` is the single knob and `CAP_LEVEL` is derived from
  `BASE_CELLS`/`GROWTH`/`MAX_CELLS`. Past the cap the maze stops growing and difficulty comes from
  braid (which keeps rising to 0.6), a drain rising 1.5 %/level from level 5 to 1.35×, thinning oil and the score
  multiplier — not from area. Size is purely a balance decision: generating **and** validating
  128×128 costs ~5 ms and a full `buildLevel` ~12–14 ms.
  _Measured caveat that shaped the braid ramp:_ the "~13 tiles per cell-side" path law only holds
  for **braided** mazes. A perfect maze's farthest-cell route is superlinear (~side^1.6): 72×72 at
  braid 0 measures 3 903 path tiles (≈ 48 minutes at a 2× wander) against 907 at braid 0.25, and
  128×128 at braid 0 measures 10 612. With a slow linear braid ramp, levels 3–8 would have been
  **longer than level 15**. The shipped fix is `BRAID_MAX` 0.6 over a 17-level ramp shaped by
  `BRAID_RAMP_SHAPE` 0.5 (square root, front-loaded), which also satisfies "braid keeps rising past
  the cap" and yields a smooth 3.6 → 13.5 minute curve on real mazes.
  _One constant reads stale on purpose:_ `LEVEL.PATH_TILES_PER_SIDE = 13` overestimates the shipped
  route at the deepest braid (≈ 7.1 tiles per cell-side measured at braid 0.6). It feeds only
  balance's `par` **floor**, and `populate.js` computes the real par from the real path and takes
  the larger — so overestimating is the safe direction and nothing is wrong today. Anyone reaching
  for it as a *route-length estimate* should measure instead.
- **Fuel is a tank you keep refilling, not a budget for the level** (§1, §4.4). The superseded
  assumption — "fuel is sized for a player who cannot see the maze, ~4× the optimal route, settling
  to ~3×" — cannot survive a 33 000-tile level: a budget that covers the maze turns it into one long
  countdown where the first two minutes are free and the last thirty seconds are the game. The tank
  is 110–150 s **independent of maze area** (64× the area buys 1.36× the tank), a flask is 35 % of
  it, and a level takes 7–22 refuels. Feasibility is proven rather than argued: 250/250 real levels
  cleared by a 2.0× wander autopilot, worst torch reserve 70 % of the tank across 750 campaign
  levels, and the same autopilot on a flask-stripped level correctly dies.
- **Nothing may be O(items) or O(tiles) per frame or per step.** A level now carries hundreds to
  ~820 items, ~1 300 torches and a 66 049-byte `explored` grid, and a run is long. Every consumer
  had to be re-cut for it: pickups query a bucket grid (§4.2), the sprite and light passes walk a
  spatial index (§4.5), and the map maintains an incremental raster (§4.6). This is the single
  invariant the massive-maze change rests on; a new feature that scans a level array per frame
  regresses it invisibly on level 1 and visibly at the cap.
- **The world letterboxes rather than stretching.** The framebuffer is 240 rows with the width
  clamped to 320…560 (§4.5), so it can be anywhere from 4:3 to 21:9 but never taller than 4:3. A
  portrait phone therefore shows a 4:3 band with a control deck below it, and a 21:9 monitor shows
  the world with hairline bars. Cropping to fill instead would cut the horizontal FOV to a slit.
- **The loading screen has a floor, not a spinner** (`MIN_LOAD_S`, §4.7). Generation got *faster*
  relative to the level's size, not slower: a 128×128 build lands in ~25–60 ms, which is three
  frames. A transition screen that exists for three frames is a flicker — the iris starts its wipe
  and snaps back — and the one moment the game has to tell the player how big this labyrinth is
  would be unreadable. So the answer is held rather than the request delayed, and `verify.mjs` gates
  that the screen is still up 380 ms after `nextLevel`.
- Audio is never heard before a gesture, and the console is silent in production: both are hard
  gates in `tools/verify.mjs`, because a game that chatters in the console or autoplays reads as
  broken.
- itch.io target `severalherr/a-maze:html5`, deployed from `main` after the quality gate passes.
