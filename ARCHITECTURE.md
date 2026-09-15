# A-MAZE — Architecture

A retro, first-person, torch-lit dungeon maze crawler. Plain HTML5 + CSS3 + native ES modules.
**Zero runtime dependencies, zero build step.** `index.html` loads `src/main.js` directly; the same
tree is served locally (`npm run serve`) and uploaded to itch.io by CI.

> This file is the **binding contract** between subsystems. Builders code against the signatures
> below. If a contract must change, the **integrator** changes it here first, then updates every
> consumer. No subsystem edits another subsystem's folder.

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
 * @property {number}  pathLength      shortest path length in tiles (-1 if unsolvable)
 * @property {number}  floorCount
 * @property {number}  deadEnds
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
 * @property {GameEvent[]} events     events emitted by the LAST step (cleared at start of each step)
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
- `types.js` — the typedefs above.
- `loop.js` — `createLoop({ step:(dt:number)=>void, render:(alpha:number, frameDt:number)=>void, hz?:60, maxCatchUp?:5 }) → { start(), stop(), running:boolean, stats():FrameStats, stepOnce(n?:number) }`.
  Fixed-timestep accumulator, clamps huge gaps (tab switch) to `maxCatchUp` steps, pauses
  when `document.hidden`. `FrameStats = {fps, frameMsAvg, frameMsP99, stepMsAvg, renderMsAvg, droppedFrames}` over a rolling 120-frame window, zero allocations per frame.
- `events.js` — `createEmitter() → { on(type, fn):()=>void, off(type, fn), emit(type, payload) }`.
- `rng.js` — `createRng(seed:number) → { next():number /*[0,1)*/, int(n):number, range(a,b):number, pick(arr), shuffle(arr), fork(salt):Rng, state():number }` (sfc32/mulberry32; deterministic in Node & browser). `hashString(s):number`, `hash2(x,y,seed):number /*uint32*/`.
- `math.js` — `clamp, lerp, lerpAngle, wrapAngle, smoothstep, approach(v,target,delta), dist2`.
- `pool.js` — `createPool(factory, reset, size)` for particles (optional helper).
- `log.js` — `createLogger(tag)`; in `?debug=1` logs, otherwise silent; `errors` ring buffer surfaced to `window.__game.errors`.

### 4.2 `src/state` (Wave 1)
- `store.js` — `createStore(initial:GameState, reducer:(s:GameState, a:Action)=>void) → { getState():Readonly<GameState>, dispatch(a:Action):void, subscribe(fn:(s, a)=>void):()=>void }`.
  The reducer **mutates the store-owned state in place** (no per-tick allocation); nothing
  outside `src/state` writes to it. Dispatch during dispatch is queued, never re-entrant.
- `game.js` — `createInitialState(settings?, best?) → GameState` and `reducer(state, action)`.
- `sim.js` — pure step logic called by the reducer on `tick`: movement with acceleration/friction,
  **circle-vs-tile collision with wall sliding** (radius 0.22), head bob & footsteps, item
  pickups (radius 0.45), fuel drain, exit detection (within 0.55 of exit centre), explored-tile
  reveal (radius 3 with line-of-sight via DDA), `derived` fields, event emission.
- `balance.js` — every tuning number: speeds, fuel per level, maze size per level
  (`levelParams(level) → {cols, rows, braid, gems, oil, fuelSeconds, par}`), score formulas.
- `save.js` — `loadPersist() → {best, settings}` / `savePersist({best, settings})`; wraps
  `localStorage` in try/catch; validates shape; key `amaze.v1`. (DOM-optional: no-ops in Node.)
- **Actions** (`Action` union):
  `{type:'tick', dt, input:InputFrame}` · `{type:'newGame', seed}` · `{type:'levelReady', data:LevelData}` ·
  `{type:'pause'}` · `{type:'resume'}` · `{type:'nextLevel'}` · `{type:'toTitle'}` ·
  `{type:'setSetting', key, value}` · `{type:'debugWin'}` (headless tools only).
- Phase machine: `title --newGame--> loading --levelReady--> playing <--pause/resume--> paused`;
  `playing --exit reached--> levelComplete --nextLevel--> loading`; `playing --fuel 0--> gameOver --toTitle--> title`.
  In `title` the sim runs an **attract-mode camera** wandering the title maze (main.js dispatches
  `levelReady` for a small demo maze at boot with phase kept at `title`).

### 4.3 `src/input` (Wave 1)
- `input.js` — `createInput(canvasEl:HTMLElement, opts?:{sensitivity:number, invertLook:boolean}) → { poll():InputFrame, setOptions(o), requestPointerLock(), destroy(), isTouch:boolean }`.
  Keyboard (`code`-based, layout independent), mouse w/ pointer lock, gamepad (deadzone 0.18),
  touch (virtual stick left 40% of screen, drag-look on right, rendered by `touch-overlay.js`).
  `poll()` reuses one frame object (no alloc). Clears stuck keys on `blur`. Never calls
  `preventDefault` on keys when a text field is focused.
- `bindings.js` — default key map (`KeyW`/`ArrowUp` → forward, etc.).
- `touch-overlay.js` — `createTouchOverlay(root) → { update(state), destroy() }` draws the stick
  and pause/map buttons as DOM/CSS elements only when `isTouch`.

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
- `populate.js` — `populateLevel(maze, validation, params, seed) → {items, torches}`: gems at dead
  ends (farthest first, never on the path's first 3 tiles), oil flasks spaced along/near the
  solution path so a competent run can finish, torches on corridor walls spaced ≥ 6 tiles.
- `level.js` — `buildLevel(params:{cols,rows,braid,gems,oil,fuelSeconds,par}, seed) → LevelData`
  (generate → validate → **throw if invalid** → populate). Deterministic for a given seed.
- `worker.js` — module worker: `onmessage {id, params, seed}` → `postMessage {id, data}` with
  `tiles` buffer transferred; errors posted as `{id, error}`.
- `client.js` — `createMazeClient() → { build(params, seed):Promise<LevelData>, dispose() }`:
  uses the worker when `cols*rows > 400` and `Worker` exists, else sync; 10 s timeout → sync
  fallback; never throws uncaught.
- **Headless verification runner:** `tools/validate-mazes.mjs` generates thousands of mazes across
  seeds and sizes (1×1 … 512×512, braid 0…1) and asserts `solvable && fullyConnected &&
  bordersSealed` for **100%** of them, plus perfect-maze `loops===0` when `braid===0`. Exit code
  ≠ 0 on any failure. `tools/stress.mjs` pushes 2000×2000 (4M cells) for time/memory.

### 4.5 `src/renderer` (Wave 1 shell, Wave 3 polish)
- `palette.js` — the master palette (≈32 colours) sampled from the art reference. All textures
  and UI colours come from here.
- `textures.js` — `createTextures(seed) → TextureSet` procedurally paints 64×64 pixel-art
  textures into `Uint32Array`s (ABGR little-endian): `wall` (≥ 3 variants: plain stone blocks,
  mossy, vines), `floor` (cobblestone + moss + occasional grate), `ceiling` (wooden planks +
  beams), `portal` (animated frames), sprites `torch` (4 flame frames), `gem`, `oil`,
  `sparkle`. Node-safe (no DOM) so it can be unit tested.
- `raycaster.js` — `createRaycaster(canvas:HTMLCanvasElement) → { resize(cssW, cssH, dpr), render(view:RenderView), stats():{ms:number}, internalSize:{w,h} }`.
  Canvas 2D `ImageData` + `Uint32Array` framebuffer at **low internal resolution** (height 240,
  width from aspect, clamped 320…560), upscaled with CSS `image-rendering: pixelated`.
  DDA wall casting with textured walls, perspective floor/ceiling casting, per-column z-buffer,
  sorted billboard sprites (items, portal, torch flames) with z-test, **dynamic lighting**:
  player torch radius = f(fuel) with flicker + wall torches as point lights + distance fog to a
  cool blue-black. Head bob offsets the horizon. Zero allocations per frame.
- `RenderView` = `{ player:{x,y,angle,bob,bobAmp,shake}, maze:Maze, items:Item[], torches:Torch[], exit:Vec2, time:number, light:number /*0..1 torch strength*/, flash:{r,g,b,a}, portalOpen:boolean, reducedMotion:boolean }`
- `post.js` — `createPost(rootEl) → { set({scanlines, vignette, lowFuelPulse, flash}) }` CSS/overlay
  canvas effects (scanlines, vignette, red low-fuel pulse, white pickup flash, iris wipe).
- `particles.js` — screen-space pixel particles for sparkles/embers (pooled).

### 4.6 `src/ui` (Wave 3)
- `font.js` — built-in **bitmap pixel font** (gothic-ish display face for titles + clean 5×7 face
  for HUD), `drawText(ctx, text, x, y, {size, color, shadow, align, font:'display'|'hud'})`,
  `measureText`. Rendered on an overlay canvas at the renderer's internal resolution ×2 so
  lettering is pixel-crisp.
- `hud.js` — `createHud(overlayCanvas) → { render(state, frameStats, alpha), resize(w,h) }`: fuel
  gauge (torch icon + burning bar), score with rolling counter + pop-up deltas, gem count,
  level, level timer, compass needle toward exit (only after 50% gems or always on L1–2),
  minimap (explored tiles, player arrow, exit when seen), FPS in `?debug=1`.
- `menus.js` — `createMenus(overlayCanvas, callbacks:{onNewGame, onResume, onQuit, onSetting, onNextLevel}) → { render(state), handleInput(frame:InputFrame, state), handlePointer(ev) }`:
  title (logo "A-MAZE" in gold gothic lettering + "Descend", "Options", "Credits"),
  pause, options (volume, music, sensitivity, scanlines, minimap, reduced motion), level complete
  (tally animation: gems, fuel bonus, score), game over (score, best, "Try again").
  Keyboard/gamepad navigable **and** mouse/touch clickable.
- `audio.js` — `createAudio() → { unlock(), handle(events:GameEvent[], state), setVolume(v, music), update(state) }`
  **WebAudio-synthesized** SFX (footsteps, bump, gem chime, oil whoosh, portal hum by
  proximity, heartbeat on low fuel, UI blips, fanfare) and a soft generative dungeon drone. No
  audio files. Lazy-unlocked on first user gesture.
- `styles.css` lives at `/styles.css` (integrator) — layout, pixelated scaling, safe areas.

### 4.7 `src/main.js` (Integrator)
Composition root: boot → load persist → create store/input/renderer/hud/menus/audio/maze client
→ build demo level for title → create loop. `step(dt)`: `store.dispatch({type:'tick', dt, input: input.poll()})`,
then route `state.events` to audio/post/particles, trigger `mazeClient.build` when phase enters
`loading`, persist best/settings on change. `render(alpha)`: build `RenderView` with interpolated
player, `raycaster.render`, `hud.render`, `menus.render`.
`?headless=1` exposes `window.__game = { ready, state:()=>state, dispatch, stepOnce(n), stats(), errors, input:{inject(frame)} }` for tools.

## 5. Quality gates (automated)
- `npm test` — every `src/*/*.test.mjs` (node:test) in its own process.
- `node tools/validate-mazes.mjs` — 100% solvability across the seed/size matrix.
- `node tools/stress.mjs` — extreme grid sizes: no throw, no stack overflow, bounded time.
- `node tools/verify.mjs --tag x` — headless Chrome: boots, plays with an autopilot that follows
  the validator's path, asserts **zero console/page errors**, fps ≥ 55 (real rAF), avg frame
  render < 8 ms, heap growth < 5 MB over a 20 s soak (leak check), no stuck phases; writes
  `logs/x.json` + screenshots (title, play, minimap, level complete, game over, mobile).
- Critic gauntlet (`.claude/workflows/gauntlet.js`): per-module score ≥ 8.5 vs top-tier web
  arcade games, zero attributable errors, up to 4 revise rounds. Results in `docs/STATUS.json`.

## 6. Assumptions (documented, autonomous decisions)
- Canvas 2D software raycaster rather than WebGL: at 240p internal resolution a typed-array
  raycaster costs ~2–4 ms/frame, is pixel-exact for the retro look, and works everywhere.
- Mazes are "thick-wall" tile mazes (`cols*2+1`) so walls are full blocks, like the reference.
- Level 1 = 6×6 cells, growing ~+2 per level, capped at 40×40 for gameplay; stress tests go far beyond.
- itch.io target `severalherr/a-maze:html5`, deployed from `main`.
