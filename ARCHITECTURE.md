# A-MAZE — Architecture

A retro, first-person, torch-lit dungeon maze crawler. Plain HTML5 + CSS3 + native ES modules.
**Zero runtime dependencies, zero build step.** `index.html` loads `src/main.js` directly; the same
tree is served locally (`npm run serve`) and uploaded to itch.io by CI.

> This file is the **binding contract** between subsystems. Builders code against the signatures
> below. If a contract must change, the **integrator** changes it here first, then updates every
> consumer. No subsystem edits another subsystem's folder.
>
> **Status: reconciled with the shipped code.** Every signature below has been checked against
> `src/`; where a builder's delivered design was better than the sketch it replaced, this document
> was changed to match the code, and the reason is recorded next to it. Where the two genuinely
> disagreed, the code was fixed. Sections marked _(integrator decision)_ resolve a seam that two
> modules saw differently.

---

## 1. Game design (what we are building)

- **Look:** chunky pixel-art dungeon in the style of *Labyrinth: The Wizard's Cat* (see
  `docs/art-reference.png`): blue-grey stone block walls with dark mortar and creeping green moss/vines,
  irregular cobblestone floor with moss in the cracks, dark wooden plank ceiling with beams,
  flickering wall torches casting warm orange light, deep cool-blue shadows. Warm
  gold/parchment gothic pixel lettering for titles and menus. All art is **procedurally
  generated pixel textures** at load (no image assets), low internal resolution, upscaled with
  nearest-neighbour, optional CRT scanline + vignette overlay.
- **Loop (arcade):** each level is a procedurally generated maze. The player carries a **torch
  whose fuel is the timer**. Fuel drains in real time; when it runs low the light radius visibly
  shrinks and the screen edges darken. Collect **gems** (+score) and **oil flasks** (+fuel)
  scattered through dead ends; reach the glowing **exit portal** to descend. Each descent grows
  the maze, lowers the fuel budget per cell, and multiplies score. Fuel hits 0 → game over →
  score summary → high score saved.
- **Score:** gem = `100 × level`; level clear = `500 × level + floor(fuelRemaining) × 10 × level`.
- **Controls:** WASD/arrows move + turn, mouse look with pointer lock, Shift sprint (drains fuel
  1.5×), M toggles minimap, Esc/P pause, Enter/Space confirm. Touch: left virtual stick move,
  right half drag to turn, tap buttons for pause/map. Gamepad: standard mapping.
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
 * @property {number} fuel            starting fuel seconds for the level
 * @property {number} par             par time seconds (for the summary screen)
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
 * @typedef {Object} Settings
 * @property {number} volume 0..1  @property {number} music 0..1  @property {number} sensitivity 0.2..3
 * @property {boolean} scanlines  @property {boolean} minimap  @property {boolean} reducedMotion  @property {boolean} invertLook
 * @typedef {Object} GameState
 * @property {Phase} phase
 * @property {number} time            total sim seconds since boot (monotonic)
 * @property {number} phaseTime       seconds since phase changed
 * @property {number} level           1-based
 * @property {number} seed            run seed
 * @property {LevelData|null} levelData
 * @property {Player} player
 * @property {Uint8Array|null} explored   width*height, 1 = seen (minimap fog of war)
 * @property {{score:number, gems:number, gemsTotal:number, fuel:number, fuelMax:number, levelTime:number, totalTime:number, levelScore:number, bestCombo:number}} run
 * @property {{score:number, level:number}} best
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
- `loop.js` — `createLoop({ step:(dt)=>void, render:(alpha, frameDt)=>void, hz?:60, maxCatchUp?:5, vsyncSnapMs?:0.4, onError?, now?, raf?, caf?, doc? }) → { start(), stop(), running, suspended, hz, stepDt, stats():FrameStats, resetStats(), stepOnce(n?:number):number }`.
  Fixed-timestep accumulator, clamps huge gaps (tab switch) to `maxCatchUp` steps and **discards**
  the overflow (no death spiral), auto-pauses when `document.hidden` and resumes without replaying
  the hidden time. `FrameStats = {fps, frameMsAvg, frameMsP99, stepMsAvg, renderMsAvg, droppedFrames, samples, skippedSteps}`
  over a rolling 120-frame window, **reused object**, zero allocations per frame.
  `now/raf/caf/doc` are injectable so the loop is testable in Node; `doc: null` disables the
  visibility pause. `vsyncSnapMs` snaps frame intervals within 0.4 ms of a whole step to that step,
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
- `sim.js` — pure step logic called by the reducer on `tick`: movement with acceleration/friction,
  **circle-vs-tile collision with wall sliding** (radius 0.22, sub-stepped at 0.2 tiles so
  tunnelling is impossible at any dt), head bob & footsteps, item pickups (radius 0.45), fuel
  drain, exit detection (within 0.55 of exit centre), explored-tile reveal (radius 3 with
  line-of-sight via DDA, budgeted per step), `derived` fields, event emission. Exports the pieces
  main.js and the tools need by name: `moveCircle`, `hasLineOfSight`, `solidAt`, `stepPlaying`,
  `stepAttract`, `startAttract`, `updateDerived`, `revealAround`, `placePlayerAtStart`, `setPhase`,
  `completeLevel`, `endRun`, `recordBest`, `createSimScratch`, `resetSimScratch`.
  The exit is tested **before** the fuel-out test, so arriving on the frame the torch dies is a win.
- `balance.js` — every tuning number: speeds, fuel per level, maze size per level, score formulas,
  the settings spec, and `levelParams(level) → {cols, rows, braid, gems, oil, fuelSeconds, par,
  fuelBase, fuelPerCell, fuelPerPathTile, cells}` (the last four are additive; see §4.4 on fuel).
  Also `gemScore`, `levelBonus`, `oilFuel`, `coerceSetting`, `defaultSettings`, `sanitizeSettings`,
  `sanitizeBest`, and the frozen tables `PLAYER / BUMP / BOB / WORLD / SIM / FUEL / SCORE /
  ATTRACT / LEVEL`.
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
  from `gameOver|levelComplete|paused` only. There is **no exit from `loading`**: `src/main.js`
  owns that recovery instead (stale-build tokens, one reseeded retry, and a 12 s watchdog), which
  keeps the phase machine total and the failure handling in the one place that knows about workers.
  `levelData` and `explored` are deliberately preserved during `loading` so the renderer keeps a
  coherent backdrop behind the loading screen; `levelReady` swaps both atomically.

### 4.3 `src/input` (Wave 1)
- `input.js` — `createInput(canvasEl:HTMLElement, opts?:{sensitivity?, invertLook?, shouldLockPointer?, touchRoot?, touchOverlay?, env?}) → { poll():InputFrame, setOptions(o), requestPointerLock(), updateOverlay(state), destroy(), isTouch:boolean, pointerLocked:boolean }`.
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
- `populate.js` — `populateLevel(maze, validation, params, seed) → {items, torches, fuel, par}`:
  gems at dead ends (farthest first, never on the path's first 3 tiles), oil flasks spaced
  along/near the solution path so a competent run can finish, torches on corridor walls spaced
  ≥ 6 tiles (`face` uses the same direction numbering as `DIRS`, 0=E,1=S,2=W,3=N).
  It also owns the **path-derived fuel budget**, exported separately as
  `fuelBudget(pathLength, params) → {fuel, par, directTime, usage}`: this is the only place that
  knows the level's real shortest path, so it is the only place that can size the torch honestly.
  `params.fuelSeconds` / `params.par` act as **floors** on the derived numbers.
  **Fuel seam _(integrator decision)_:** `balance.js` supplies a size-based floor
  (`55 + cells × perCell`) that is larger than the path-derived budget at every level, so the floor
  wins in the shipped game. Measured: a direct run down the (unseen) solution path costs ~23 % of
  the torch on level 1 and ~35 % from level 6 on, i.e. the player can wander ~3× the optimal route
  and still make it. The path-derived curve alone would leave level 10 at ~1.2× optimal, which is
  only winnable by a player who already knows the maze — unplayable for a game whose premise is
  that you cannot see it. Both numbers stay in the code: `populate.js` keeps deriving its budget
  (and `tools/validate-mazes.mjs` keeps proving it is feasible), `balance.js` keeps raising it to
  something a human can play. Retune from `FUEL.*` in `balance.js`, not from `populate.js`.
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
  bordersSealed` for **100%** of them, plus perfect-maze `loops===0` when `braid===0`. Exit code
  ≠ 0 on any failure. `tools/stress.mjs` pushes 2000×2000 (4M cells) for time/memory.

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
- `raycaster.js` — `createRaycaster(canvas, {textures?, seed?}) → { resize(cssW, cssH, dpr), render(view:RenderView), stats():RenderStats, internalSize:{w,h}, particles, textures, setTextures(set), depth(), dispose() }`.
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
  `wrapText`, `fontMetrics`, `lineHeight`, `textHeight`, plus `COLOR` and `FONT_STYLES`.
  **`size` is an integer pixel scale** (1 = one font pixel per surface pixel), not a point size;
  `measureText` returns `{width, height, lines}`. Glyphs are blitted from per-(face,style) atlases
  built on first use. The overlay canvas is sized at the renderer's internal resolution ×2, so
  lettering is pixel-crisp.
- `hud.js` — `createHud(overlayCanvas, {minimap?}) → { render(state, frameStats?, alpha?), resize(cssW, cssH, dpr?), surface, pop(value, kind?), reset(), dispose() }`:
  fuel gauge (torch icon + 16-segment burning bar, red and flickering under 20 %), score with
  rolling counter + pop-up deltas, gem count, depth, level timer, compass needle toward the exit
  (level ≤ 2 or ≥ 50 % gems), minimap (explored tiles, player arrow, exit when seen), FPS in
  `?debug=1`. Also exports the shared overlay `createSurface(canvas)` and the pixel-art primitives
  `menus.js` draws with (`drawPanel`, `drawWell`, `drawArt`, `compileArt`, the icons, `fitScale`,
  `withAlpha`, `mapPointer`).
  `render()` **clears the whole overlay**, then draws only in `playing` (full) and `paused`
  (dimmed to 45 %). Score/fuel pops are derived from `GameState` deltas, not from `state.events`:
  the HUD renders per frame while events are per dispatch, so events would be missed on a
  double-step frame and replayed on a double-render one. main.js must therefore **not** also pop
  on `pickup` events.
- `menus.js` — `createMenus(overlayCanvas, callbacks:{onNewGame, onResume, onQuit, onNextLevel, onSetting, onUiSound}) → { render(state), handleInput(frame:InputFrame, state):boolean, handlePointer(ev):boolean, resize(cssW, cssH, dpr?), surface, screen(), dispose() }`:
  title (logo "A-MAZE" in gold gothic lettering + "Descend", "Options", "Credits"),
  pause, options (volume, music, sensitivity, scanlines, minimap, reduced motion, invert look),
  loading, level complete (staggered tally: gems, fuel bonus, depth bonus, total), game over
  (score, best, "Try again"). Keyboard/gamepad navigable **and** mouse/touch clickable.
  `handleInput` returns **false** in `playing` and `loading` so main.js keeps its own
  pause/map/mute hotkeys, and true on every menu screen. `handlePointer` returns true when it
  consumed the event (main.js then suppresses the default, and no pointer lock is requested).
- **Frame protocol:** `hud.render(state, stats, alpha)` **then** `menus.render(state)`. The HUD
  opens (and clears) the shared overlay frame; the menus only open one if nothing else did. The
  reverse order would erase the menu.
- `audio.js` — `createAudio(options?) → { unlock(), handle(events:GameEvent[], state), setVolume(v, music), update(state), playUi(kind), suspend(), resume(), dispose(), stats(), unlocked, available }`
  **WebAudio-synthesized** SFX (footsteps, bump, gem chime with a combo pitch ladder, oil whoosh,
  portal hum panned by bearing, heartbeat on low fuel, UI blips, level fanfare, game-over snuff)
  and a soft generative dungeon drone, through sfx/music buses with per-bus reverb into a
  compressor and a tanh limiter (output can never clip). No audio files. No `AudioContext` is
  constructed until the first gesture — the module attaches its own one-shot gesture listeners, so
  `unlock()` from main.js is belt-and-braces. It adopts `settings.volume`/`.music` from the state
  whenever they change, suspends on `document.hidden` and rebases its scheduler on return.
  `setVolume(0)` is a hard mute that allocates **no** WebAudio nodes at all.
  Synthesis constants live in the exported `AUDIO` table rather than in `balance.js`, because §2
  forbids `src/ui` from importing `src/state`; they are audio-internal, not gameplay balance.
- **Mirrored constants:** `src/ui` may not import `src/state`, so `menus.js` mirrors the §1 score
  formulas and the slider ranges of `SETTING_SPEC`, and `hud.js` mirrors `FUEL.LOW_FRACTION`. Both
  cross-check themselves against state that the sim computed (the tally is derived from
  `run.levelScore`), so a drift shows up as a wrong split, never as a wrong total — but they must
  be updated together with `balance.js`.
- `styles.css` lives at `/styles.css` (integrator) — layout, pixelated scaling, safe areas.

### 4.7 `src/main.js` (Integrator)

Composition root. Boot is wrapped in a `try/catch` that paints a **styled fatal panel** (inline
styles, so it renders even if `styles.css` is what failed) instead of leaving a black page.

**Boot:** `installGlobalErrorCapture()` → `loadPersist()` → `createStore(createInitialState(settings, best), reducer)`
→ raycaster on `#view`, post on `#post`, HUD + menus on `#overlay`, input on `#overlay` (touch
overlay into `#touch`), audio, maze client → `store.subscribe(routeEvents)` → request the demo
level for the title → `layout()` → `loop.start()`.

**`step(dt)`** (fixed 60 Hz): poll input **once**, offer the frame to `menus.handleInput`, and if it
was not consumed apply the composition root's own hotkeys (pause, map toggle, mute toggle); then
`store.dispatch({type:'tick', dt, input})`; then advance the loading watchdog.

**`render(alpha, frameDt)`**: mutate the single `RenderView` with the interpolated player
(`lerp`/`lerpAngle` by `alpha`), `raycaster.render(view)`, `hud.render(state, loop.stats(), alpha)`,
`menus.render(state)`, `post.set({...})`, `audio.update(state)`, `input.updateOverlay(state)`.
Torch strength is `pow(fuel/fuelMax, 0.65)` — readable for most of a level, closing in hard over
the last fifth.

**`routeEvents(state, action)`** runs from the store subscriber, not after the tick, because
`state.events` is cleared at the top of every dispatch (§4.2). It hands the whole array to
`audio.handle`, bursts particles and sets the world flash on `pickup`, sets the page flash on
`levelComplete`/`gameOver`, starts the level build and releases pointer lock on `phase`, and
persists on `gameOver`/`levelComplete`/`setSetting`.

**Level requests:** every build carries a token; an answer whose token is stale, or that arrives in
another phase, is dropped. A genuine build failure retries twice with a reseeded maze before the
fatal panel; a level that has not arrived in 12 s is requested again. Per-level seed is
`createRng(runSeed).fork('level' + level).u32()`, so a run replays exactly from its seed.

**Transitions:** the iris (post) is closed while a level is being carved and after a run ends, and
opens over ~0.4 s when a level starts — the §1 iris wipe.

**Layout** _(integrator decision)_: the DOM order is `#view` → `#post` → `#overlay` → `#touch`, so
the post effects frame the **world** and never darken the HUD or the menus. `#view` and `#post` are
sized in JS to the largest box that preserves the framebuffer's aspect, snapped to a whole pixel
multiple when that costs < 3 % (exact 3× at 720p), and centred — at 42 % of the height on a
portrait phone, where the 4:3 framebuffer must letterbox and the deeper deck below the world holds
the compass, the minimap and the thumb on the virtual stick. `#overlay` and `#touch` are inset by
the safe-area insets instead, so a notch never sits on the fuel gauge.

**Focus:** losing window focus or the tab being hidden while `playing` dispatches `pause`; the
cursor is hidden only while the pointer is locked (`body.locked`).

`?headless=1` (or `?debug=1`) exposes
`window.__game = { ready, state(), dispatch(action), subscribe(fn), stepOnce(n), stats(), renderStats(), audioStats(), errors, input:{inject(partialFrame), clear()} }`
for tools. `inject` merges into the real device frame: axes persist until changed, `lookDX` and
`pressed` are consumed by the next step exactly like a real device's edges. `?seed=N` pins the run
seed. `?debug=1` additionally turns on the logger and the HUD's FPS readout. `?fatal=1` throws
during boot on purpose, so the failure screen — the one path playing the game cannot reach — can be
looked at.

## 5. Quality gates (automated)
- `npm test` — every `src/*/*.test.mjs` (node:test) in its own process (359 tests).
- `node tools/validate-mazes.mjs` — 100 % solvability across the seed/size matrix (117 306 mazes,
  ~5 s). `--quick` for a 784-maze smoke.
- `node tools/stress.mjs` — extreme grid sizes (2000×2000), a 1×4096 deepest-possible carve and the
  oversize `RangeError`: no throw, no stack overflow, bounded time and memory.
- `node tools/verify.mjs --tag x` — headless Chrome against the dev server. Boots `/?headless=1`,
  screenshots the title, plays **level 1 with an autopilot that BFS-pathfinds through the real
  maze** and detours to collect items, screenshots play + minimap + level complete, descends,
  measures fps and render cost, soaks for a leak check, burns the torch out with `stepOnce` to
  reach game over, then repeats the boot at 390×844 for the mobile shots. Gates:
  **zero console errors _and warnings_**, zero page errors, zero failed requests, zero entries in
  the game's own error ring buffer, every phase reached (`title`, `loading`, `playing`,
  `levelComplete`, `gameOver`), both levels cleared by the autopilot, at least one item collected,
  fps ≥ 55 **measured with the compositor's frame limiter on** (a second short run — the main run
  disables vsync so the render budget is visible, which inflates fps to several hundred),
  full render callback < 8 ms average, world render p99 < 16 ms, heap growth < 5 MB over a 20 s
  soak with a forced GC either side, no page overflow on desktop or mobile.
  Writes `logs/x.json` + `logs/shot-x-*.png`.
- CI (`.github/workflows/deploy-to-itchio.yml`) runs the first three before every itch.io deploy;
  `verify.mjs` is local-only because it needs a browser and a server.
- Critic gauntlet (`.claude/workflows/gauntlet.js`): per-module score ≥ 8.5 vs top-tier web
  arcade games, zero attributable errors, up to 4 revise rounds. Results in `docs/STATUS.json`.

## 6. Assumptions (documented, autonomous decisions)
- Canvas 2D software raycaster rather than WebGL: at 240p internal resolution a typed-array
  raycaster costs ~1 ms/frame (measured), is pixel-exact for the retro look, and works everywhere.
- Mazes are "thick-wall" tile mazes (`cols*2+1`) so walls are full blocks, like the reference.
- Level 1 = 6×6 cells, growing ~+2 per level, capped at 40×40 for gameplay; stress tests go far beyond.
  Beyond level ~18 the maze stops growing and difficulty comes from braiding (loops, fewer dead
  ends, less landmark value) and from the score multiplier, not from area.
- **Fuel is sized for a player who cannot see the maze** (§4.4): ~4× the optimal route on level 1,
  settling to ~3× from level 6. The tighter path-derived curve was measured as unplayable.
- **The world letterboxes rather than stretching.** The framebuffer is 240 rows with the width
  clamped to 320…560 (§4.5), so it can be anywhere from 4:3 to 21:9 but never taller than 4:3. A
  portrait phone therefore shows a 4:3 band with a control deck below it, and a 21:9 monitor shows
  the world with hairline bars. Cropping to fill instead would cut the horizontal FOV to a slit.
- Audio is never heard before a gesture, and the console is silent in production: both are hard
  gates in `tools/verify.mjs`, because a game that chatters in the console or autoplays reads as
  broken.
- itch.io target `severalherr/a-maze:html5`, deployed from `main` after the quality gate passes.
