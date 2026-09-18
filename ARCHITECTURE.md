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
  reach the glowing **exit portal** to descend. The **map is locked** on every level until the player finds that level's hidden **map scroll** (§4.8). Each descent grows the maze (to a cap) and
  multiplies score. Fuel hits 0 → game over → score summary → high score saved.
- **Progression _(unlocks wave — §4.9)_:** the world keeps getting harsher while **the player gets
  stronger**. Gems are also a **persisted purse**; clearing a depth deeper than any boon already
  claimed offers a free **Boon** (pick 1 of 3 unlock ranks), and the **Shrine** (title, level
  complete, game over) spends gems on ranks. Unlocks **carry across runs**. The oil placement
  guarantee is computed from **base stats only**, so every unlock is pure slack on top of it.
- **Size curve _(massive mazes)_:** level 1 is a lean **10×10-cell** first floor (`LEVEL.FIRST_CELLS`,
  a 95 s tank, thinner flasks and gems — `LEVEL.FIRST_*`); from level 2 the curve is the one below
  unchanged, as if level 1 were **16×16 cells = 33×33 tiles**, growing **+8 cells per
  side per level** to a cap of **128×128 cells = 257×257 tiles = 16 384 cells ≈ 33 000 floor tiles**,
  reached at level 15. `LEVEL.MAX_CELLS` in `balance.js` is the **single documented size knob** and
  the cap level is *derived* from it (`CAP_LEVEL`), never typed twice. Past the cap, levels get
  **harder, not bigger**: every level (level 1 included) also gets one cross-section **shortcut**
  per `LEVEL.SHORTCUT_CELLS_START` (8) cells on level 1 rising to one per `SHORTCUT_CELLS_END` (4) at
  `CAP_LEVEL`, with the detour (6 → 4 cells) and route guard (0.85 → 0.70) relaxing along the same
  ramp, so long cul-de-sacs usually have a back door and deeper floors loop more;
  braid keeps rising (0→0.6 over 17 levels, square-root shaped, 0.6 from
  level 18), the torch drains 3.5 % faster per level (`FUEL.DRAIN_PER_LEVEL`) from
  `LEVEL.DRAIN_RAMP_START` (level 3, so the ramp is felt inside the size curve) to a 1.45× ceiling
  (`FUEL.DRAIN_MAX`, 1.42× at the cap, 1.45× from level 16), and oil thins from one flask per 20
  cells to one per 34 (`LEVEL.OIL_CELLS_END`). Levels run ~1–1.5 minutes on the lean first floor,
  ~4 minutes at level 2, to ~13 minutes at the deepest.
- **Torch economy _(a tank you keep refilling, not a budget)_:** `fuelMax` is a **tank** of
  95 s (level 1), 113 s (level 2) → 150 s (the cap), **independent of maze area** — 64× the area buys 1.36× the
  tank. Oil flasks are the economy: their **count scales with area** so density is roughly constant
  (≈ one per 20 cells early, thinning to one per 34 past the cap), each restoring **35 % of the
  tank on level 1, climbing to 44 % on the cap's tank** (`FUEL.OIL_FRACTION` →
  `FUEL.OIL_FRACTION_END`, clamped 25–70 s ⇒ 33–66 s in practice) — bigger, rarer refills deeper
  down are the shape of the tension curve. A level takes **7–22 refuels** to cross and the
  player is never more than ~60–90 s from darkness, whatever the depth. Gems scale with area too
  (≈ one per 50–60 cells), still favouring dead ends, and remain the score currency.
  Walking over a flask tops the tank off whenever it has at least `FUEL.OIL_MIN_ROOM` (1 s) of
  room — the over-fill is lost, and only a brim-full tank leaves it on the floor — and the low-fuel alarm fires at
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
- **Controls:** WASD/arrows move + turn, mouse look (always live while playing; pointer lock when captured, plain mouse movement otherwise — it sums with arrow-key turning). **There is no sprint**
  (removed in the unlocks wave: one walking speed, so the torch is the only clock). C chalks the
  wall ahead once the Chalk unlock is owned (pad X, touch CHALK button). M cycles the map **off → corner → full** (once this level's map scroll is found), O toggles
**Auto Explore** (§4.10), Esc/P pause, Enter/Space confirm. A run can be **saved and continued**
(pause → Save & Quit, title → Continue; §4.10). Touch: left
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
| `#touch`   | `src/input/touch-overlay.js`| virtual stick + the bottom-right thumb deck (§4.12), only on a touch device; `pointer-events: none` |

Above all four, `#splash` (`src/splash.js`, integrator) is the Jamcraft studio logo intro: static
markup in `index.html`, loaded as its own module script so a `main.js` failure cannot strand it,
removed about 2 s after load (any key/click/touch/gamepad button skips; `?headless=1` and
`?splash=0` remove it at once). `images/jamcraft_logo.png` is the one image file the game ships — a
studio mark, not game art, so §1's "no image assets" for the world still holds. The skipping press
is swallowed by window capture listeners so it never reaches the title menu.

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
 * @typedef {'gem'|'oil'|'map'} ItemKind   'map' = the level's hidden map scroll (§4.8)
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
 * @property {Set<InputAction>} pressed   edge-triggered this poll   (no `sprint`: removed, §1)
 * @typedef {'confirm'|'back'|'pause'|'map'|'up'|'down'|'left'|'right'|'mute'|'chalk'|'auto'|'attack'} InputAction
 *   `auto` is bit 10 (§4.10), `attack` bit 11 — the sword swing of New Descent (§4.11)
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
 * @typedef {'classic'|'combat'} Mode                 which game mode this run is (§4.11)
 * @typedef {'torch'|'slain'} EndCause                how a run ended (§4.11) — a dead torch, or killed
 * @typedef {{best:BestScore, progress:Progress}} Profile   one mode's saved record and purse (§4.11)
 * @typedef {'off'|'corner'|'full'} MapMode           the three-state map (§4.6)
 * @typedef {Object} Settings
 * @property {number} volume 0..1  @property {number} music 0..1  @property {number} sensitivity 0.2..3
 * @property {boolean} scanlines  @property {boolean} reducedMotion  @property {boolean} invertLook
 * @property {MapMode} mapMode    what the map restores to (default 'corner')
 * @property {boolean} minimap    LEGACY mirror of `mapMode !== 'off'`, kept because audio, touch and
 *   older call sites still read it. main.js and the options row write BOTH on every change.
 * @property {boolean} fullscreen go fullscreen on the gesture that starts/resumes a run when embedded
 *   (default true; §4.3 `fullscreen.js`, §4.7). Turning it off also leaves fullscreen.
 * @typedef {Object} GameState
 * @property {Phase} phase
 * @property {Mode} mode              which mode this run is (§4.11). `'classic'` is the game as
 *   §1–§4.10 describe it; `'combat'` is New Descent. Not a setting and not persisted as a
 *   preference — it is chosen by the title row that starts the run and stored in the `RunSave`.
 * @property {{classic:Profile, combat:Profile}} profiles  per-mode record and purse (§4.11).
 *   `state.best` and `state.progress` are LIVE REFERENCES into `profiles[mode]`, so every consumer
 *   written against them is unchanged and the two purses can never mix.
 * @property {Enemy[]} enemies        live enemies this level (empty in `'classic'`) — a pooled,
 *   fixed-capacity array (`COMBAT.MAX_ENEMIES`), never reallocated per level (§4.11)
 * @property {{st:number, t:number, hits:number}} attack   the player's sword state (§4.11)
 * @property {number} time            total sim seconds since boot (monotonic)
 * @property {number} phaseTime       seconds since phase changed
 * @property {number} level           1-based
 * @property {number} seed            run seed
 * @property {LevelData|null} levelData
 * @property {Player} player
 * @property {Uint8Array|null} explored   width*height, 1 = seen (map fog of war). Up to 257×257 =
 *   66 049 bytes, so it is a VIEW onto a grow-only pool (`sim.allocExplored`) — exact length,
 *   zeroed, indexed identically by every consumer, one buffer for a whole 30-level run.
 * @property {{score:number, gems:number, gemsTotal:number, fuel:number, fuelMax:number, levelTime:number, totalTime:number, levelScore:number, bestCombo:number, refuels:number, distance:number, mapFound:boolean}} run
 *   `mapFound` = this level's map scroll has been picked up (reset by `levelReady`, §4.8).
 *   `refuels` = oil flasks burned THIS LEVEL (reset by `levelReady`); `distance` = tiles actually
 *   walked this RUN (reset by `newGame` only). Both exist because on a 14-minute labyrinth those
 *   are the statistics that describe the run; the HUD shows the refuel tally live and the
 *   level-complete / game-over screens show both.
 * @property {{score:number, level:number}} best   `best.level` is the **deepest level reached** (the
 *   level the run was on when it was folded in), not the deepest cleared. Folded in by
 *   `sim.recordBest` on a level clear, on game over, and when a paused run is abandoned through
 *   `toTitle` or `newGame` — abandoning a run keeps its score.
 * @property {Settings} settings
 * @property {{exitDist:number, nearExit:number, lowFuel:boolean, threat:number}} derived   recomputed each step for renderer/hud/audio
 *   (`threat` is 0..1, the nearest awake enemy's proximity — 0 outside `'combat'`, §4.11)
 *   (`exitDist` is Infinity and `nearExit` 0 while no level is loaded — an honest "unknown")
 * @property {Progress} progress       persisted meta progression (§4.9): `{purse, ranks, boonLevel}`
 * @property {Perks} perks             flat numbers derived from `progress.ranks` (§4.9), read-only outside src/state
 * @property {BoonOffer} offer         `{open, level, ids}` — the pick-1-of-3 pending on a level clear
 * @property {ChalkMark[]} marks       chalk marks on THIS level `{x, y, face, seed}` (wall tile + face)
 *   `run` also gains `chalk` (charges left this level), `reserve` (siphon seconds) and `emberUsed`;
 *   `derived` gains `scrollSense` (0..1, proximity of the unfound map scroll).
 *   `run.endCause` is an `EndCause` — `'torch'` (the default, and what a fresh run carries) or
 *   `'slain'`, written by `endRun` and read by the game-over screen so it can say what killed you.
 *   A run that is still going carries the field but nothing reads it before `gameOver`.
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
 *   | {type:'lowFuel'} | {type:'gameOver', score:number, newBest:boolean, cause:EndCause} | {type:'phase', from:Phase, to:Phase}
 *   | {type:'uiMove'} | {type:'uiConfirm'}
 *   | {type:'chalk', ok:boolean, x:number, y:number} | {type:'ember', seconds:number}
 *   | {type:'unlock', id:string, rank:number, boon:boolean}
 *   | {type:'swing', hit:boolean}
 *   | {type:'enemyHit', kind:EnemyKind, x:number, y:number, damage:number, killed:boolean}
 *   | {type:'playerHit', kind:EnemyKind, damage:number, x:number, y:number}
 *   | {type:'enemyWake', kind:EnemyKind, x:number, y:number} } GameEvent
 *   (the last four: New Descent, §4.11 — never emitted in `'classic'`)
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
  tunnelling is impossible at any dt), head bob & footsteps, item pickups (radius 0.75 — see §4.8 for why), fuel
  drain, exit detection (within 0.8 of exit centre), explored-tile reveal (radius 3 with
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
    reducer and never per step. `collectAround` visits at most the 2×2 buckets (3×3 with the Gem Magnet) overlapping the swept pickup
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
  `levelParams(level) → {cols, rows, braid, shortcuts, shortcutDetour, shortcutRouteKeep, gems, oil, fuelSeconds, par, fuelBase, fuelPerCell,
  fuelPerPathTile, cells, drain, oilTargetGap, oilDensity, gemDensity, oilRefuelSeconds, pathTiles}`.
  - **`fuelSeconds` IS the tank** (95 s on level 1, 113→150 s from level 2, independent of area),
    not `base + cells × perCell`.
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
  `FUEL.OIL_MIN_ROOM` (1 s) is the tank room below which the sim leaves a flask on the floor
  (`feasibility.test.mjs` also models a player who skips off-route flasks for a sip); `LEVEL.DRAIN_RAMP_START` (3) is the last level
  that burns at 1× before `drainRate` climbs by `FUEL.DRAIN_PER_LEVEL` (3.5 %/level, ceiling
  `FUEL.DRAIN_MAX` 1.45×). Also `swayAt(t, err, speed)` — the idle yaw sway, in radians, full at
  cruise on a settled heading and nothing while turning into a corner or standing still. It lives
  in `balance.js` with the numbers because **both** the title camera (`sim.js` `stepAttractBody`)
  and Auto Explore (`autopilot.js`) sway, and §4.10 requires the pilot to move like the title
  camera — which it cannot do if the two compute their sway differently. Frozen tables `PLAYER / BUMP / BOB / WORLD / SIM / FUEL / SCORE /
  ATTRACT / LEVEL`. `PLAYER` gained **`TURN_RELEASE_RATE` (45/s)**, the smoothing rate used instead
  of `TURN_EASE_RATE` (18/s) when the keyboard turn command drops or reverses: with one shared 18/s
  ease a released turn key coasted the view on by `TURN_SPEED / 18` = 0.22 rad (10.9° measured off a
  90° turn), and in a game made of 90° corners that is an overshoot to correct on every one, where
  Wolfenstein and Doom stop dead. At 45/s the coast is ≈ 0.09 rad (≈ 5°) — rounded, not a snap —
  and `sim.test.mjs` pins it under 6°. Removed with the old economy (nothing referenced them): `FUEL.BASE_SECONDS`,
  `PER_CELL_START/END`, `DECAY_LEVELS`, `PER_PATH_TILE_START/END`, `PAR_FRACTION`,
  `LEVEL.GEM_PER_DEAD_END`, `LEVEL.OIL_PER_DEAD_END`.
  **`SETTING_SPEC` gained a third kind, `'enum'`** (`{kind, def, values}`): `mapMode` is
  `'off'|'corner'|'full'`, default `'corner'`. `coerceSetting` takes only a listed string and
  **ignores** anything else rather than snapping to the default, so a garbage `setSetting` leaves
  the player's choice alone. `minimap` stays as the legacy boolean mirror (§3).
- `save.js` — `loadPersist() → {best, settings, progress}` / `savePersist({best, settings, progress})` / `clearPersist()`
  (`progress` is additive inside payload version 1: an older record without it loads fresh progress);
  wraps `localStorage` in try/catch; validates shape; key `amaze.v1`, payload version 1. Every
  failure mode (absent storage, throwing storage, quota, non-JSON, foreign record, version
  mismatch, oversized payload) degrades to factory defaults rather than throwing. All three take an
  optional trailing `storage` argument so tests can inject a fake. (DOM-optional: no-ops in Node.)
- **Actions** (`Action` union):
  `{type:'tick', dt, input:InputFrame, auto?:boolean}` (`auto`: Auto Explore drove this step — §4.10) · `{type:'newGame', seed, mode?:Mode}` (the mode the title row picked — §4.11; omitted keeps the current one) · `{type:'levelReady', data:LevelData}` ·
  `{type:'pause'}` · `{type:'resume'}` · `{type:'nextLevel'}` · `{type:'toTitle'}` ·
  `{type:'setSetting', key, value}` · `{type:'debugWin'}` (headless tools only) ·
  `{type:'buyUnlock', id}` (title | levelComplete | gameOver; needs the purse and a rank to buy) ·
  `{type:'claimBoon', id}` (levelComplete with an open offer naming `id`) — §4.9 ·
  `{type:'continueRun', save}` (title only; picks a saved run back up) — §4.10.
  `createInitialState(settings?, best?, progress?)` takes the persisted progress as a third argument.
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
  _Mouse look without a click:_ while `shouldLockPointer()` is true and the mouse is in control,
  `mousemove.movementX` turns the camera whether or not the pointer is locked.
  _Touch vs mouse (hybrid devices):_ `isTouch` (overlay shown) is latched by a real touch **or** the
  `(pointer: coarse)` hint, but the hint never disables the mouse — Windows Chrome on a touchscreen
  laptop reports `pointer: coarse` with no fine pointer while a real mouse is in use. The mouse is
  in control unless a real touch happened more recently than a real mouse event; mouse events
  synthesised from a touch (`sourceCapabilities.firesTouchEvents`, or within
  `TOUCH_GHOST_MOUSE_MS` of a touch) are ignored. Pointer lock is requested on a primary mouse
  `pointerdown`/`mousedown` while playing (before main.js's fullscreen request in the same event,
  which consumes the gesture) and again on `click`. Pointer lock is
  still requested (canvas click, or automatically after a recent keyboard **or mouse** gesture —
  starting a level from a menu row counts) because it removes the screen edge and hides the cursor.
  Unlocked, the first move after a gap of `FREE_MOVE_REARM_MS` is dropped (the cursor re-entering
  the frame reports its jump as one delta). `lookDX` sums with keyboard/pad `turn` in the sim.
  Keyboard (`code`-based, layout independent), mouse (locked or free), gamepad (deadzone 0.18),
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
- `touch-overlay.js` — `createTouchOverlay(root, {onAction?, onHold?, document?}) → { update(state), setStick(...), destroy(), element }`
  draws the stick and the on-screen buttons as DOM/CSS elements. `input.js` owns it and creates it
  lazily on the first real touch; `{touchOverlay:false}` opts out.

  **The thumb deck (§4.12).** Every button is anchored to the **bottom right**, never the top: the
  top belongs to the HUD's panels and to the corner map, and a control a thumb cannot reach without
  regripping the phone is not a control. Two right-aligned rows:

  | row | contents | size |
  |-----|----------|------|
  | primary (bottom) | **ATTACK** in `'combat'`, **AUTO** in `'classic'` — the mode's one constantly-pressed button | `PRIMARY_W × PRIMARY_H` (112×92 CSS px) |
  | system (above it) | **CHALK** (only with the unlock) · **MAP** · **PAUSE** | `SYS_MIN_W × SYS_MIN_H` (58×44) |

  Both rows are **right-aligned**, so a button appearing on the left of a row (CHALK) never moves
  one already there — the same rule the old top bar had, and the reason a second tap still lands.
  The system row is held clear of the left `STICK_ZONE_FRACTION` of the screen in portrait *and*
  landscape, so a thumb planted to walk can never hit PAUSE. The bar carries the class
  `amaze-touch-deck` as the only hook `styles.css` (integrator) has; nothing in the module depends
  on it.
- `fullscreen.js` — `createFullscreen({root?, env?}) → { request():boolean, exit(), readonly active:boolean, readonly supported:boolean, onChange(fn) → unsubscribe, destroy() }`
  plus the pure `shouldAutoFullscreen({param, headless, embedded, setting}) → boolean`.
  `root` defaults to `document.documentElement`. `request()` **never throws** and swallows the
  promise rejection a browser returns outside a user gesture (or inside a sandboxed iframe without
  `allowfullscreen`); it is a no-op (returns false) when unsupported, `fullscreenEnabled === false`,
  already active or destroyed. It falls back to `webkitRequestFullscreen` / `webkitExitFullscreen` /
  `webkitFullscreenElement` / `webkitfullscreenchange` (Safari). `onChange(fn)` subscribes `fn(active)`
  to transitions, de-duplicated on `active` because Chrome fires both the prefixed and unprefixed
  event; `destroy()` removes the document listeners and subscribers. `env` injects `{document}` for
  Node tests.
  `shouldAutoFullscreen`: `param === '1'` → true, `param === '0'` → false, otherwise
  `!headless && embedded && setting` — fullscreen is only automatic inside an embed (itch.io), where
  the iframe is small; a top-level tab already owns the window, and `?headless=1` tools never get it
  unless they ask with `?fullscreen=1`.

### 4.4 `src/maze` (Wave 2)
- `constants.js` — `TILE = { FLOOR:0, WALL:1 }`, `DIRS`.
- `generator.js` — `generateMaze({cols, rows, seed, braid=0, shortcuts=0, shortcutDetour=12,
  shortcutRouteKeep=0.85, braidRouteKeep=BRAID_ROUTE_KEEP}) → Maze`. **Iterative randomized
  recursive backtracker** with an explicit `Int32Array` stack (no recursion → no stack overflow at
  any size), followed by optional **shortcuts** (knock through up to `shortcuts` walls whose two
  cells are ≥ `shortcutDetour` cells apart by path — a bounded BFS on the live tiles — while keeping
  the start→exit route ≥ `shortcutRouteKeep` of the carved one; connects separate sections so a
  cul-de-sac can have a back door) and optional **braiding** (remove `braid` fraction of dead ends by knocking a
  wall into a neighbouring corridor, under its own route guard `braidRouteKeep` — the fraction of
  the *post-shortcut* route the braid pass must keep. It defaults to **0** (`BRAID_ROUTE_KEEP`, no
  floor) and nothing in the shipped curve passes it, because braiding **is** the route brake rather
  than a threat to it: `LEVEL.BRAID_MAX` exists precisely because a perfect 128×128 maze carries a
  ~10 600-tile route. The knob is there so a curve that wants longer deep levels can ask for a floor
  instead of the generator guessing — measured at the cap, the final route runs 715 tiles at 0,
  1 016 at 0.12 and 1 956 at 0.25). Both only remove walls — keeps solvability, adds loops.
  Streams: `maze.carve`, `maze.connect`, `maze.braid`. Start = cell (0,0); exit =
  the cell **farthest from start** by BFS distance (guarantees a long route). Must handle
  1×1 up to 2000×2000 cells in bounded memory/time (O(n)). **The route guard is exact up to a
  per-cell repair budget** (`SHORTCUT_REPAIR_BUDGET`, cells lowered per maze cell) and falls back
  past it to a repair-free 1-Lipschitz test that keeps the *identical* guarantee — no opened wall
  can shorten the route below the keep fraction — while placing fewer shortcuts at stress sizes.
  Repairing both distance fields after every opened wall is what would otherwise make this pass
  superlinear; the budget is what keeps the whole generator O(cells).
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
- `level.js` — `buildLevel(params:{cols,rows,braid,shortcuts?,shortcutDetour?,shortcutRouteKeep?,braidRouteKeep?,gems,oil,fuelSeconds,par}, seed) → LevelData`
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
- `palette.js` — the master palette (**79 shared colours** plus one block of ≤ `TILESET_PALETTE_MAX` (28) per deeper tileset, appended from `tilesets/<id>.palette.js`; hard limit 256; `map` parchment + `seal` red ramps for the scroll, `chalk` for the wall lettering) sampled from the art
  reference; every material needs a 5–9 step ramp for the ordered dither to avoid banding at 240p.
  All textures and UI colours come from here. Exports `PALETTE`, `PALETTE_RGB`, `C` (name → index),
  `RAMPS`, `ramp`, `pack`, `hex`, `rgba`, `nearestIndex`, and `PALETTE_GLOW` (1 = a self-lit tileset
  colour: the colormap never shades it below `GLOW_MIN_LIGHT`, so lava or fungus stays visible in the dark).
- `tilesets/` _(tilesets wave)_ — **every floor wears a different tileset**: `index.js` exports
  `TILESETS` (keep, cistern, ossuary, grotto, temple, glacier, forge — floor order),
  `tilesetIndexForLevel(level, floorsPer = WORLD.FLOORS_PER_TILESET)` (cycles past the end),
  `tilesetIndexById(id)` and `createTilesetTextures(index, seed?, base?) → TextureSet`. A tileset module
  `<id>.js` exports `TILESET {id, name, fog, paint(seedOf) → {wall[4], floor[3], ceiling[2]}}` of raw
  palette-index buffers with the Keep's variant semantics and texture invariants; sprites are shared
  from the Keep set. `TextureSet` gains optional `tileset` (id), `fog` (palette index), `warmth` (0..1 torch tint strength). **Variants are seamless against each other:** texels are tied to world position (no per-tile offset, mirror or flip), so every wall variant meets every other horizontally, all three floors meet on both axes (the special tile is set *into* the common floor) and the two ceilings meet along y — variants share their structure along the tile edges and differ inside (`tilesets.test.mjs` measures the edge bands for every tileset, the Keep included);
  `raycaster.setTextures(set)` rebuilds the colormap when the set's fog differs (once per floor).
  `main.js` swaps sets when `state.level` changes (cached per tileset; the title wears floor 1), and
  `?tileset=<id>` pins one for review. Each tileset's palette file is pure data (palette.js imports it).
  `tilesets/sheet.html?tileset=<id>` and `node tools/shot-tileset.mjs --tileset <id> [--poses 0,…,6] [--views N --depth D]` are the art-review harnesses.
- `textures.js` — `createTextures(seed) → TextureSet` procedurally paints 64×64 pixel-art
  textures (indices + packed pixels + a stipple mask): `wall[4]` (plain, cracked, mossy, vined),
  `floor[3]` (two cobbles + iron grate), `ceiling[2]` (planks, planks + beam), `portal[8]`,
  `torch[TORCH_VIEWS × TORCH_FRAMES]` (7 views × 4 flame frames; `torch[view * TORCH_FRAMES + frame]`,
  views fanned over ±`TORCH_YAW_MAX` across the wall), `gem[8]`, `oil[1]` (the modelled flask as one
  still 3/4 view at `OIL_YAW`, with its floor shadow; it neither spins nor bobs), `map[1]` (the scroll; `MAP_FLOOR_ROW` export rests it on the floor), `sparkle[4]`. **Every field is an array** — consumers index them,
  and the raycaster picks a per-tile variant by hash. Deterministic and Node-safe (no DOM) so it
  can be unit tested; ~35 ms for a full set.
- `models.js` — load-time low-poly mesh rasteriser: `createMesh()`, `lathe`, `box`, `tube`,
  `renderMesh(mesh, materials, {yaw, pitch, originRow, light, outline?, shadows?, ground?}, pick, out)` and
  `projectPoint`. Orthographic, z-buffered, Lambert + Blinn + glass transmission, quantised through
  palette ramps by the caller's `pick`. `shadows` adds a self-shadow map; `ground: {index, contact,
  stipple}` paints a cast + contact shadow on y = 0 into empty texels, solid at the core with a
  stippled edge (the flask's `oil` frame therefore carries a stipple mask; Oil Sense's ghost skips
  stippled texels). `textures.js` uses it to render the oil flask and the wall
  sconce into ordinary sprite frames; nothing here runs per frame. Imports nothing.
- `enemies.js` _(modes wave, §4.11)_ — `createCombatTextures(seed) → CombatTextures` plus
  `ENEMY_VIEWS`, `ENEMY_FRAMES`, `ENEMY_POSE` and `enemyFrameIndex(view, pose)`. The two creatures
  and the sword, modelled with `models.js` and rasterised into ordinary 64×64 sprite frames. **Not
  part of `createTextures`**: it is painted lazily the first time a combat run needs it and installed
  with `raycaster.setCombatTextures(set)`, so a Classic Descent session never pays for it and the
  per-floor tileset swap is untouched. Deterministic and Node-safe, like `textures.js`.
- `sprite-index.js` — `createSpriteIndex(cell = INDEX_CELL) → SpriteIndex` with
  `build(count, readX, readY, tilesW, tilesH)` and the public typed arrays `cellStart` / `entries` /
  `px` / `py` plus `cell` / `cols` / `rows` / `count`. A uniform-grid (counting-sort) bucketing of a
  level's point decoration, exported `INDEX_CELL` = 8 tiles. Positions are copied into flat
  `Float32Array`s so the per-frame distance test never dereferences an item or torch object; a
  rebuild allocates only above the previous high-water mark. Pure data structure: no DOM, Node-safe,
  imports nothing.
- `raycaster.js` — `createRaycaster(canvas, {textures?, seed?}) → { resize(cssW, cssH, dpr), render(view:RenderView), stats():RenderStats, internalSize:{w,h}, particles, textures, setTextures(set), depth(), lights(), dispose() }`.
  Canvas 2D `ImageData` + `Uint32Array` framebuffer at **low internal resolution** (height 240,
  width from aspect, clamped 320…560 and made even; narrower than 4:3 the width holds at 320 and
  the height grows to at most 400 rows, projection scale still 240, so the horizontal FOV never
  shrinks), upscaled with CSS `image-rendering: pixelated`.
  DDA wall casting with textured walls, one perspective row-walk serving floor **and** ceiling,
  per-column z-buffer, sorted billboard sprites (items, portal, torch flames) with z-test,
  **dynamic lighting**: player torch radius = `lerp(2.5, 7, view.light)` with two octaves of
  flicker; its brightness and a warm firelight core around the player also fall with
  `view.light`, and below 0.4 it gutters (so the oil left reads in the world, not only on the
  HUD) + the eight nearest wall torches as point lights (each masked by a **baked per-torch
  line-of-sight window** — `bakeTorchVisibility` fills a byte per tile in a `VIS_SPAN`² (11×11)
  window around the flame, lazily and once per torch per level, and a lit surface outside that
  window is skipped. This replaced a test against the plane of the wall the sconce is bolted to,
  which passed for any tile on the flame's side of that plane and so leaked light through masonry
  round a corner) + distance fog to a cool blue-black. Head bob offsets the horizon, quantised to
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
  - **Tile-keyed texture variety** comes from the variant hash alone. A per-tile wall u offset, a
    wall mirror bit and per-tile floor flips used to multiply the looks, but each one cut a block or
    a cobble in half at the tile seam; they are gone, and the paintings share their edges instead
    (see `tilesets/`).
  - **The DDA is bounded by fog, not by maze size.** Measured over 480 columns × 8 headings × 40
    stations: ~1.0 steps/column and ~15 distinct `maze.tiles` reads per frame at 33², 129², 257²,
    1025² *and* 2001² tiles; the loop always exits on `dist > FAR`, never on `MAX_DDA_STEPS` (160).
    There are no level-sized tables in the renderer.
  - `lights() → {n:number, x:Float32Array, y:Float32Array}` returns the wall torches selected as
    point lights on the last frame, as world positions of the flames (already offset off their
    wall). Reused object and live arrays, exactly like `depth()`; **diagnostic only**, no consumer
    in main.js — it is the seam the nearest-8 equivalence test needs.
- `RenderView` = `{ player:{x,y,angle,bob,bobAmp,shake}, maze:Maze, items:Item[], torches:Torch[], exit:Vec2, time:number, light:number /*0..1 torch strength*/, flash:{r,g,b,a}, portalOpen:boolean, reducedMotion:boolean, marks:ChalkMark[], flame:number /*torch radius ×*/, oilSense:number /*tiles*/, whisper:number /*dead-end depth, 0 off*/ }`
  plus `enemies:Enemy[]` and `weapon:{st,phase,kick}|null` (New Descent, §4.11; empty/null in Classic)
  (`marks`/`flame`/`oilSense`/`whisper` are the unlocks wave, §4.9; omitted fields mean "no unlock")
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
- `font.js` — built-in **bitmap pixel font**, **three faces** (`FontName` = `'hud' | 'display' |
  'text'`): a gothic **display** face (12 rows, proportional, uniform digit width) for titles, a
  clean 5×7 **hud** face in an 8-row cell (one descender row) for readouts, and a proportional
  **text** face (the prose face — the hud cell with per-glyph advances, so a sentence sets tighter
  and reads as prose rather than as a gauge) used by `menus.js` for credits and blurbs and by
  `hud.js` for notice banners. All three cover 0x20…0x7E plus `© × … ·`; per-face details are
  documented in-file. `drawText(ctx, text, x, y, {font, size, color, shadow, align,
  baseline, tracking, lineHeight, alpha})`, `drawTextBlock`, `measureLine`, `measureText`,
  `wrapText`, `fontMetrics`, `lineHeight`, `textHeight`, `catchesLight(glyph, x, y)` (the rim-light
  rule for the gothic face, exported for its test), plus `COLOR` and `FONT_STYLES`.
  **`size` is an integer pixel scale** (1 = one font pixel per surface pixel), not a point size;
  `measureText` returns `{width, height, lines}`. Glyphs are blitted from per-(face,style) atlases
  built on first use, capped at `MAX_ATLASES` = **24** (was 16, raised with the third face: three
  faces × the styles in steady use is 13, and the cap must sit above what one frame draws or an
  eviction becomes a rebuild inside that frame). The overlay canvas is sized at the renderer's
  internal resolution ×2, so lettering is pixel-crisp.
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
  (`drawCorner` takes a trailing `corner` of `'br'` (default, Classic) or `'tr'` (New Descent, where
  the bottom right belongs to the attack button — §4.11); `MAP.CORNER_TOP_GAP` is the clearance it
  leaves under the score plaque),
  `countExplored`, `chooseFullScale(cols, rows, boxW, boxH, out?)`, `fitBeats(a, b)`,
  `cornerWindow(px, py, span, mw, mh, out, pad?)`.
  - **OFF → CORNER → FULL**, cycled by the existing `map` action. CORNER is a 25-tile (19 on a phone)
    window centred on the player, zoomed 2–6×. `cornerWindow`'s optional `pad` is an **overscan**:
    how many tiles the window may slide past the maze edge, so a player pinned against a wall still
    sits somewhere near the middle of the panel instead of being shoved to its rim. It defaults to
    **0**, which is exactly the old behaviour, so the pinned tests are unchanged. The corner panel's
    drawable box is inset by **two** panel borders (the frame is drawn, then the map is clipped
    inside it — insetting by one let a tile bleed under the frame's inner edge). FULL is a full-screen labyrinth map: header
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
    On a **narrow** screen the full map may draw **frameless** — the panel frame dropped for a
    hairline margin (`BARE_MARGIN_DEV`, 2 device px, in place of `MAP.MARGIN_DEV`) — whenever
    losing the frame buys a whole extra device pixel per tile. On a phone that is the difference
    between a readable labyrinth and a smudge, so the trade is taken in the map's favour; the outer
    wall is still stroked, or the labyrinth's edge would bleed into the page.
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
- `hud.js` — _(unlocks wave: also draws the chalk/scroll-sense chips, the lodestone needle and the siphon reserve, §4.9)_ `createHud(overlayCanvas, {map?:'off'|'corner'|'full', minimap?:boolean|MapMode}) → { render(state, frameStats?, alpha?), resize(cssW, cssH, dpr?), surface, pop(value, kind?), cycleMap(settings?), mapMode(settings?), mapStats(), mapLocked(state), notice(text), reset(), dispose() }`
  (`minimap: true` still means `'corner'`, so an older call site keeps working):
  fuel gauge, score with rolling counter + pop-up deltas, gem count, depth, level timer, the map
  (via `map.js`), FPS in
  `?debug=1`. There is **no compass** and no distance-to-exit readout (removed: finding the way is
  the map scroll's job, and a needle toward the exit made the maze moot). `cycleMap` advances OFF → CORNER → FULL and returns the new mode; `mapMode` reports the
  one in force; `mapStats()` returns a reused
  `{updateMs, drawMs, painted, scanned, flushes, explored, tiles, rebuilds}` (**stale while the mode
  is `'off'`** — no update runs, so it keeps its last numbers rather than zeroing).
  **The gauge reads as a tank, not a countdown** (this is the massive-maze change in the HUD):
  quarter-tank graduations every 4 segments, a refill surge (the bar sweeps up from where the eye
  last saw it with a white-hot leading edge, the panel edge flares, the torch icon relights for the
  flare even at 3 % fuel), a recurring low-tank alarm (pulsing red outline, cooled flame, `LOW OIL`
  / `LOW` label), and an `OIL` label that becomes an `OIL ×N` refuel tally where the bar has room.
  The HUD itself raises two notices: a once-per-session oil explanation on level 1 and a
  once-per-level `Torch Low - Find Oil` on the crossing into low fuel (never over "Map Found"). The depth panel is one line, `DEPTH n · C×R` (two lines on a
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
- `menus.js` — `createMenus(overlayCanvas, callbacks:{onNewGame, onResume, onQuit, onNextLevel, onSetting, onUiSound, controls?, onBuy?, onClaimBoon?, unlocks?})` (the last three: §4.9) → { render(state), handleInput(frame:InputFrame, state):boolean, handlePointer(ev):boolean, resize(cssW, cssH, dpr?), surface, screen(), dispose() }`:
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
  `FUEL.LOW_FRACTION` is **0.25**: on the tank that is a 23.8 s (level 1) to 37.5 s (cap) warning,
  comfortably more than one `oilTargetGap`, so the sim's `lowFuel` event, the red gauge and the
  heartbeat ramp all start at the same quarter-tank mark. Retuning it means changing `balance.js`,
  `hud.js` and `audio.js` **together**.
- **Harness-only, never shipped:** `preview.js` + `preview.html` are the module harness
  (`/src/ui/preview.html?screen=…`), and `preview-nav.js` holds the walk that reaches each
  `?screen=` value. The sub-screens are internal to `menus.js` — there is no `openScreen(id)` in
  this contract — so the harness reaches them the way a player does, by moving the selection and
  confirming, which is fragile by nature: when that walk broke, `?screen=options` silently
  screenshotted the loading screen instead. Extracting it gives `preview-nav.test.mjs` something it
  can prove in Node against the real menus (`PREVIEW_SCREENS` maps every documented value to the id
  `menus.screen()` must report). **`src/main.js` never imports either file**, so neither reaches the
  shipped page.
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
portrait phone (viewport taller than 1.25× its width), where the 4:3 framebuffer letterboxes and the deeper deck below the world holds
the minimap and the thumb on the virtual stick. `#overlay` and `#touch` are inset by
the safe-area insets instead, so a notch never sits on the fuel gauge. After sizing, `layout()` hands the band to the shared overlay surface with
`hud.surface.setViewRect(...)` (overlay-relative CSS px) before `hud.resize`/`menus.resize`, so the UI
lays out around the world band without measuring the DOM itself.

**Focus:** losing window focus or the tab being hidden while `playing` dispatches `pause` (focus and
pointer-lock loss excepted while Auto Explore drives — §4.10); the
cursor is hidden only while the pointer is locked (`body.locked`).

**Fullscreen** _(itch.io embed)_: browsers only honour `requestFullscreen` inside a user gesture, so
main.js asks on the player's **first gesture of any kind** (window capture `keydown` other than
Escape, mouse `pointerdown`, touch/pen `pointerup`, plus `splash:gesture` — a `CustomEvent` whose
`detail` is the input event, dispatched by `src/splash.js` for every input it swallows), until
fullscreen has been entered once; then those listeners are removed. It also asks on the gestures
that start or resume play: first thing in the menus' `onNewGame`,
`onResume` and `onNextLevel` callbacks (a pointer confirm is inside the event; a keyboard confirm is
polled on the next step, which is still inside the browser's transient-activation window), and on
`pointerdown` over `#overlay` while `playing` — registered before the click that takes pointer
lock. Each ask is gated by `shouldAutoFullscreen({param: ?fullscreen=, headless: ?headless=1,
embedded: window.self !== window.top, setting: settings.fullscreen})` and skipped when already
active. A `fullscreenchange` relayouts, and **leaving fullscreen while `playing` pauses** (Escape
leaves fullscreen without delivering the key, exactly like pointer lock). Turning the `fullscreen`
setting off exits fullscreen. `shutdown()` destroys the controller.

`?headless=1` (or `?debug=1`) exposes
`window.__game = { ready, state(), dispatch(action), subscribe(fn), stepOnce(n), stats(), renderStats(), audioStats(), screen(), mapMode(), hudRects(), autopilot(), savedRun(), errors, input:{inject(partialFrame), clear()} }`
(`screen()` is `menus.screen()` and `mapMode()` is `hud.mapMode(settings)`: a tool driving the menus
through the real input path has no other way to tell whether a keypress landed, and "the options
screen opened" is the kind of thing a gate should assert rather than assume. `hudRects()` is
`hud.rects()` — the client-space rectangle of each HUD widget that a touch control could collide
with, `{cornerMap, attack}`, empty when the widget was not drawn. It exists for `tools/shot-ui.mjs`,
which checks arithmetically that no on-screen button overlaps the corner map: a collision on a phone
is 40 px of a screenshot nobody looks at twice, and it shipped once already)
for tools. `inject` merges into the real device frame: axes persist until changed, `lookDX` and
`pressed` are consumed by the next step exactly like a real device's edges. `?seed=N` pins the run
seed. `?debug=1` additionally turns on the logger and the HUD's FPS readout. `?fatal=1` throws
during boot on purpose, so the failure screen — the one path playing the game cannot reach — can be
looked at.

### 4.8 Pickup reach and the hidden map scroll (cross-module seam)

**Pickup reach.** `WORLD.PICKUP_RADIUS` is **0.75**. At 0.45 the player could walk past an item:
cutting an L-turn or junction keeps the player's centre `PLAYER.RADIUS` (0.22) from the wall corner,
which is √0.5 ≈ 0.707 from the tile centre, so the closest approach was ≈ 0.49 > 0.45. Walls are
whole tiles, so an item behind a wall is always ≥ 1.72 away: any radius below ~1.5 cannot grab
through a wall, and 0.75 still keeps the pickup disc inside the 2×2 bucket query (3×3 with the Gem Magnet, §4.9). `WORLD.EXIT_RADIUS`
stays larger than `PICKUP_RADIUS` (0.8). `collectAround` also tests the swept segment from the
previous step's position (`player.px/py`) to the current one, so a long step can never skip an
item — still no allocation, still ≤ 2 buckets per axis without the Gem Magnet (the longest step is 0.8 tiles at `MAX_DT`, and 0.8 + 2×0.75 < 4; ≤ 3 with a rank-3 magnet's 2-tile reach; a jump over 1.5 tiles per axis — a teleport — falls back to the plain disc test).
The "oil only when ≥ 55 % would land" rule is unchanged.

**Map scroll.**
- `ItemKind` gains `'map'`. `populateLevel` places **exactly one** map item per level, on a
  reachable floor tile that is not the start, not the exit and not shared with another item.
  "Hidden" means: at the end of a **dead-end branch off the solution path** (not on the path),
  preferring branches whose detour (off-path depth) is meaningful but affordable — at least
  `MAP_MIN_DETOUR_TILES` = 4 (exported from `src/maze/constants.js`; maze may not import balance) and at most
  a quarter of `params.oilTargetGap` each way — and whose junction with the path lies in the first
  60 % of the path, so the map is still worth having when found. Deterministic per seed (own `items.map` RNG
  fork, so oil/gem placement is byte-identical with or without it). Fallback tiers: any junction
  position → the shallowest off-path dead end past the cap → the farthest-from-path free floor tile;
  a maze with no free floor (1×1, 1×2) gets no scroll. The first 3 path tiles stay reserved. Placed **after** oil and
  gems, never displacing an oil flask (the refuel guarantee is untouched). `validate-mazes.mjs`
  asserts exactly one map item per level, reachable, not on start/exit, not stacked.
- `src/state`: `run.mapFound` is reset by `levelReady` to **`true` if the level has no map item**
  (fixtures, previews, older cached levels) and `false` otherwise, in `title` too. The initial state
  is `true`; `newGame` sets it `false` so a restart never shows a spurious false→true "MAP FOUND".
  `takeItem` always consumes a map item: `taken = true`, `run.mapFound = true`, emits
  `{type:'pickup', kind:'map', x, y, value:0}`. It does not score and does not count toward
  `gemsTotal`. `isLevelData` accepts `'map'`.
- `src/ui/hud.js` + `map.js`: while `state.run.mapFound` is false the map draws **nothing** in any
  mode (corner and full), and the layout behaves as if the mode were `'off'`. The HUD
  derives a **"Map Found"** banner (`MAP_FOUND_TEXT`, title case like every gothic label; `MapView.invalidate()` does the one catch-up rescan on unlock) from the `mapFound` false→true delta (same rule as the score
  pops — not from the event). `hud.mapLocked(state) → boolean` is exported for main.js.
  `hud.notice(text)` shows a short centred one-line notice (~1.6 s, reduced-motion aware).
  `map.js`'s item layer ignores `'map'` items (they are never drawn as gems). `mapStats()` unchanged.
- `src/ui/audio.js`: a distinct parchment-unroll/chime cue for `pickup` with `kind:'map'`.
- `src/renderer`: a **rolled parchment scroll** billboard sprite for `'map'` items (texture in
  `textures.js`, colours in `palette.js` under a `map` ramp), deliberately dim — no glow, no light
  source — so it has to be looked for. `raycaster.js` must not treat an unknown kind as a gem.
- `src/input/touch-overlay.js`: `update(state)` sets `data-map-locked="1"` on the bar while
  `state.run.mapFound === false` and dims the MAP button (opacity only — position never changes).
- `src/main.js`: on the `map` hotkey while `hud.mapLocked(state)`, it does **not** cycle or persist
  the mode; it calls `hud.notice('No Map - Find the Scroll')`. `routeEvents` gives `kind:'map'` its
  own particle burst colour and world flash. The persisted `mapMode` preference is untouched by the
  lock, so the map comes back in the player's chosen mode the moment the scroll is found.

### 4.9 Unlocks, Boons, the Shrine and chalk _(unlocks wave — cross-module seam)_

**Catalogue & numbers (`src/state/balance.js`).** `UNLOCKS` is the frozen catalogue — one entry per
unlock `{id, name, group:'torch'|'sight'|'fortune', max, costs:number[], ranks:string[]}` (`ranks[r]`
is the player-facing effect of owning rank `r+1`). Effect magnitudes live in `UNLOCK_FX`, and
`computePerks(ranks, out?) → Perks` turns ranks into flat numbers:
`{tankMult, oilMult, drainMult, emberSeconds, siphonCap, flame, reveal, oilSense, scrollSense, whisper,
lodestone, chalk, magnet, gemPurse}`. Also `sanitizeProgress`, `defaultProgress`, `unlockCost(id, rank)`,
`boonCandidates(progress)`. `src/ui` may not import state, so **main.js passes `UNLOCKS` to the menus**
(`createMenus(canvas, {unlocks})`), the same seam `CONTROL_HINTS` uses; HUD and renderer read the
computed `state.perks` / `RenderView` fields and never the catalogue's numbers.

| id | effect per rank (max) |
|----|------------------------|
| `reservoir` | tank +10 % (5) · `richOil` flask +12 % (4) · `slowWick` drain −6 % (4) |
| `ember` | once per level, a dead torch rekindles for 10/18/28 s (3) · `siphon` flask overflow stored, 15/30/50 s, pours in below half a tank (3) |
| `wideFlame` | torch light radius +15 % (3) · `oilSense` flasks within 5/8/12 tiles show through walls (3) · `whisper` walls of dead-end branches darken, 4/10/all tiles deep (3) |
| _retired_ | `cartographer` (fog reveal 3→4→5), `scrollSense` (HUD pulse near the unfound scroll), `lodestone` (exit needle once the scroll is found) — **removed from the catalogue for now**: buying a map upgrade before ever finding the map was awkward. `RETIRED_UNLOCK_COSTS` keeps their prices; `sanitizeProgress` refunds owned ranks to the purse and drops them. Their `UNLOCK_FX` tables, `Perks` fields and HUD drawing stay wired at rank 0. |
| `chalk` | 4/8/16 chalk marks per level (3) · `magnet` gems within 1.2/1.6/2.0 tiles with line of sight are pulled in (3) · `appraiser` +1 purse gem per gem per rank (3) |

**State.** `progress = {purse, ranks:{id→rank}, boonLevel}` is persisted by `save.js`. `perks` is
recomputed on boot, `newGame`, `levelReady`, `buyUnlock` and `claimBoon` — never per step. On a gem
pickup `progress.purse += perks.gemPurse` (abandoned runs keep their gems). `completeLevel` opens
`offer` when `level > progress.boonLevel` and some unlock is below its max: up to 3 ids drawn by
`createRng(seed).fork('boon' + level)`. `claimBoon` raises that rank by one, sets `boonLevel = level`
and closes the offer; `nextLevel` with an open offer forfeits it (the depth can be boon'd again later).
`buyUnlock` costs `unlockCost(id, rank)` from the purse. Both emit `unlock`.
- **The guarantee is untouched:** `levelParams` / `populate.js` never see perks. Perks only raise the
  tank (`fuelMax = resolveTank × tankMult`), the flask (`oilFuel × oilMult`), lower the drain
  (`drainRate × drainMult`), or add fuel (ember, siphon) — every one is ≥ the base the chain was built for.
- **Nothing per step became O(items/tiles):** the magnet widens the pickup capsule to ≤ 2.0 tiles
  (the bucket query stays ≤ 3×3 buckets; walking is ≤ 0.8 tiles per clamped step) and pays one DDA
  line-of-sight probe per candidate gem; the reveal window grows to 11×11 with a budget of only
  `REVEAL_BUDGET + 4 × rank` (+16 measured as a 2× step cost at rank 2); scroll sense is one distance to an index cached at `levelReady`.
- **Chalk:** a `chalk` press while playing casts a DDA ray ≤ `CHALK.REACH` (2.5) tiles along the view;
  the first wall face hit gets a mark (one per face; a charge is spent) and `{type:'chalk', ok:true}`,
  otherwise `ok:false` (no charge, out of reach or already marked). `run.chalk = perks.chalk` on
  `levelReady`; `marks` is emptied there.
- **Ember / siphon:** the fuel-out test rekindles once per level before `endRun` (`ember` event);
  the siphon stores the overflow of a flask (and lets a brim-full tank take a flask while the reserve
  has room for at least a quarter of it) and pours `SIPHON.POUR_RATE` s/s while the tank is below `SIPHON.POUR_BELOW` of full.

**Renderer.** `textures.chalk[8]` are 64×64 masks (0 clear, 1 stroke, 2 dust) of the word **A-MAZE**
lettered big and diagonally at a random ±20–50° slant with chalky dropout. `raycaster.js` keeps a
per-level `Uint8Array(tiles)` of chalked face bits (rebuilt on a level change, appended when
`view.marks.length` grows) and, only on a column whose hit face is chalked, overrides the texel with
the chalk ramp (variant = hash of tile and face; `u` runs along the viewer's right so the word always
reads left to right). `view.whisper` builds a dead-end mask once per level (leaf-peeling BFS that never
peels the start or exit) and dims wall faces bordering a marked floor tile. `view.oilSense` draws flasks
within range through walls as a stippled ghost. `view.flame` scales the player torch radius.

**UI.** `menus.js` gains two sub-screens: **`boon`** (three cards: icon, name, rank pips, the next rank's
effect; opens itself `BOON_HOLD_S` (3.5 s) after the level-complete tally is done while `offer.open`, so
the floor's score can be read first — the *Choose a Boon* row opens it sooner; *Descend* with an open
offer opens it instead of forfeiting, **on the first attempt only**: once the player has seen the
cards and chosen *Decide Later* (or backed out), Descend and Save & Quit instead raise a confirm —
heading *Forfeit the boon?*, note `THE GIFT IS LOST` — whose safe answer returns to the cards.
Without that, *Decide Later* led nowhere, because both ways off the tally simply reopened the cards
it had just dismissed. The dialog shares the confirm screen id, so `screen()` reports `'confirm'`
for it) and **`shrine`** (reachable from title, level complete and game
over: the purse, a scrolling list of every unlock with rank pips and cost, and a detail panel with the
current → next effect; confirm buys). Callbacks `onBuy(id)` and `onClaimBoon(id)`. `screen()` may also
return `'boon' | 'shrine'`. `hud.js` draws a chalk-charges chip, the siphon reserve under the fuel gauge,
the scroll-sense pulse and the lodestone needle; main.js raises notices for `ember` and a failed `chalk`.
`audio.js` voices `chalk` (a scrape), `ember` (a rekindle) and `unlock` (a chime).
`touch-overlay.js` shows a CHALK button only while `state.perks.chalk > 0`.

### 4.10 Auto Explore and saved runs _(cross-module seam)_

**Auto Explore — `src/state/autopilot.js`.** `createAutopilot() → { step(state, out:{moveX,moveY,turn}) → boolean, interrupt(), reset(), info() → {goal, tile, route, plans} }`.
An autopilot that plays through the **real input path**: main.js hands its axes to the reducer on
the ordinary `tick`, so collision, fuel, pickups and the exit apply exactly as for a player. It lives
in `src/state` because it is pure and Node-testable (it imports `core/rng`, `maze/constants` and
`balance`). It plays the **fog honestly** — it only targets items on explored tiles, with exactly
one documented exception, the **survival valve** below. A plan is one
BFS over floor tiles from the player collecting, nearest first: a seen oil flask when the tank is
below `AUTO.REFUEL_AT` (and any seen flask within `ITEM_DETOUR` below `TOPUP_AT`), a seen gem or map
scroll within `AUTO.ITEM_DETOUR`, and frontier tiles (explored floor with an unexplored floor
neighbour). Goal order: oil (when wanted) → exit (once seen and the level has been wandered for a
rolled `EXPLORE_PAR_MIN…MAX` × par, or the tank is below `DESPERATE_AT`) → nearby item → nearest
frontier, ties within `FRONTIER_TIE` tiles broken by `createRng(seed ^ level·φ).fork('auto')`. A frontier
whose route starts **behind** the player (first step against its facing) costs `BACKTRACK_COST` extra
path tiles, so a goal uncovered early does not turn it round on a corridor that still leads on. Past the
wander budget with the exit still unseen (or low on oil with none in sight) the frontier choice turns
greedy toward the exit's position over `SEEK_CHOICES` candidates (with the same backtrack cost).
- **Oil is wanted on distance as well as on fraction.** A tank fraction alone is the wrong question:
  half a tank is plenty three tiles from a flask and nowhere near enough eighty tiles from one. So a
  flask is also wanted whenever the torch no longer covers `AUTO.REFUEL_MARGIN` (1.5×) the path to it
  plus `AUTO.REFUEL_RESERVE_TILES` (16) of slack — one trip length, plus the leg out of that flask
  toward the next one that the §1 placement guarantee sizes from a full flask, plus the turning and
  backtracking a route costs over its path length.
- **The survival valve** is the one place Auto Explore looks past the fog: below `AUTO.SMELL_AT`
  (0.75) with no flask on any *explored* tile, it walks to the nearest flask **on the level**,
  revealed or not. A fog-bound explorer in a 128×128 labyrinth strands itself reliably — it drinks
  its neighbourhood dry, then explores until the torch dies with no flask in sight — and a watch
  mode that runs the torch dry costs the player their saved run (main.js clears it on `gameOver`).
  The threshold is high and measured: over levels 1–10 × 8 seeds, 74 % of runs cleared with no
  valve, 91 % at 0.35, 95 % at 0.65, 98.75 % at 0.75. Higher still and it fetches oil it does not
  need yet and stops exploring, which is what the mode is *for*.
- **It moves like the title camera** (`step(state, out, dt)`), for watching rather than racing, and
  reads the `ATTRACT` table directly so the two cannot drift: cruise `ATTRACT.SPEED` (1.7 tiles/s, about
  half walking pace) scaled by `cos(err)^SPEED_FALLOFF` and eased at `SPEED_EASE_RATE`; a commanded
  turn rate `err × TURN_GAIN` capped at `TURN_RATE` and eased at `TURN_EASE_RATE`, plus the idle yaw
  from the shared `balance.swayAt(t, err, speed)` — the one function both it and `sim.js`'s title
  camera call, so the sway cannot drift between them (§4.2). Unlike the title camera it aims by **pure pursuit**: the furthest point on the route's
  centre-line polyline `AUTO.PURSUIT` (1.1) tiles from the body, so a corner pulls the aim round it and
  the turn starts before the corner (the older past-the-waypoint aim walked on toward the far wall and
  pivoted there: median 0.15 tiles past the corner centre, now ≈ −0.07; `autopilot.test.mjs` gates
  median < 0, p90 < 0.05). Waypoints are passed `ARRIVE` early along the leg (the `attractArrived`
  rule) or on stepping onto the next waypoint's tile, since a cut corner may never meet that rule. Written out as the player's axes
  (`turn = rate / PLAYER.TURN_SPEED`, `moveY = speed / PLAYER.WALK_SPEED`). Eased speed and rate
  survive a replan (a new goal bends the walk rather than stopping it); `interrupt()` resets them.
  Measured on level 3: turn reversals ~65 → ~11 a minute, peak angular acceleration 124 → ≤ 12 rad/s²,
  average speed 2.6 → 1.2 tiles/s; `autopilot.test.mjs` gates < 25 reversals/min and < 30 rad/s².
- **The torch burns at its pace:** a tick carries `auto: true` when main.js's `autoFrame` drove that
  step, and the sim multiplies the drain by `AUTO_DRAIN_SCALE = ATTRACT.SPEED / PLAYER.WALK_SPEED`
  (exported from `sim.js`, derived so retuning either speed keeps it honest) — a tile costs the same oil
  at either pace. A step where the player took over is an ordinary step at the full burn.
- **Cost:** O(1) per step. The BFS is O(tiles) and runs only on a **replan** — route finished, goal
  item taken, frontier goal uncovered, the tank crossing `REFUEL_AT` (an edge, not a level), exit
  budget reached, or `STUCK_STEPS` without moving — and non-forced replans wait
  `REPLAN_COOLDOWN_STEPS`. Buffers are grow-only `Int32Array`s with a generation stamp (no clearing);
  `autopilot.test.mjs` asserts nothing survives a GC across 30 000 steps and hundreds of plans at the cap.
- **Honest limit:** it is a way to watch the game, not a solver — it wanders further than the 2.0×
  feasibility model the flask chain is built for, and it slows into corners below the cruise the
  burn is scaled to. Measured in Node, it now clears **79 of 80 runs over levels 1–10 × 8 seeds**
  (39 of 40 on the test's own seeds), which `autopilot.test.mjs` gates at **95 %**. That is the
  distance rule, `TOPUP_AT` and the survival valve together; the fraction rule alone cleared 74 %.
- **Setting & controls:** `Settings.autoExplore` (boolean, default false, persisted) with an Options
  row; the `auto` `InputAction` (bit 10) on **O** toggles it in play with a HUD notice. On screen for the
  whole of play:
  - **HUD button** (mouse): `hud.js` draws an **AUTO** button at the bottom centre of the world band —
    dim when off, gold, outlined and breathing when on — and records its rectangle;
    `hud.hitAuto(clientX, clientY)` hit-tests the last frame's button, `hud.setAutoButton(on)` suppresses
    it. It is not drawn while paused, in the full map, in a **narrow** layout (a phone's band is ~130 UI
    px, where the bottom centre belongs to the unlock chips and score pops) or when suppressed —
    **nor while the pointer is locked with Auto Explore off**, where a fading `O  AUTO` key hint
    (held, then dissolved; Reduced Motion cuts it) takes its place and `hitAuto` reports false. A
    locked cursor is captured by the world and cannot reach the plaque, so for most of a mouse
    player's session it was permanent clutter that no click could ever hit. Switching Auto Explore
    *on* releases the lock, so the full button — the one that turns it off — is on screen exactly
    when it can be clicked. A browser with no pointer-lock API reads as "not locked" and draws the
    button, which is the safe way to be wrong. `main.js`'s `hud.setAutoButton(!input.isTouch)` call
    is unchanged; the rule lives entirely inside `hud.js`.
  - **Touch bar** (touch): `touch-overlay.js` has an **AUTO** button, leftmost (so it never moves MAP or
    PAUSE), firing the `auto` action; dim (`0.7`) when off, full opacity with a gold `outline` and
    `aria-pressed="true"` when on — `outline`, because the press/release styling never touches it.
  - **Pause menu:** second row *Auto Explore* / *Stop Auto Explore* (`SCREENS.pauseAuto` while on),
    which calls `onToggleAuto` and then `onResume`. A mouse player's pointer is normally locked, and a
    locked cursor cannot aim at the HUD button, so Esc → *Auto Explore* is their way in; once it drives,
    the cursor is free (below) and the HUD button turns it off.
- **main.js:** calls `hud.setAutoButton(!input.isTouch)` each frame. The HUD button is taken by
  **window capture** listeners: a primary `pointerdown` on `hud.hitAuto` toggles, and the rest of that
  press (`mousedown`, `pointerup`, `mouseup`, `click`, `touchstart`, `touchend` within 600 ms) is stopped
  before `input.js` can turn it into pointer lock or a look-drag. `shouldLockPointer()` is
  `playing && !autoExplore`, which (every lock request and all unlocked mouse-look in `input.js` are
  gated on it) keeps the cursor free and the camera still under a drifting mouse while the pilot
  drives; switching Auto Explore on also releases a held lock. The O key, the touch bar and the HUD
  button share `toggleAuto()`.
- **main.js (driving):** `driveAuto(frame, state, dt)` substitutes a reused `autoFrame` while `autoExplore` and
  `playing`; any real move/turn/look input that step is used instead and calls `interrupt()` (the
  player can always take over); action presses pass through. `applySettings` calls `interrupt()`
  whenever `autoExplore` changes, however it was switched. On `levelComplete` it dispatches
  `nextLevel` after `AUTO.NEXT_LEVEL_DELAY` s on the tally (`'complete'`) or `AUTO.BOON_DELAY` s on
  boon cards that opened themselves (`'boon'` — with Reduced Motion they open before the tally delay);
  never from the Shrine or a dialog. An unclaimed boon is forfeited as usual (§4.9). While it drives, window **blur and pointer-lock
  loss do not pause** (a player stepping back to watch); a hidden tab and leaving fullscreen still do.

**Saved runs — `src/state/runsave.js` + `save.js`.** A run can be put down and picked up again. A
level is not stored: `(params, seed)` rebuilds it (§4.4), so a save records only what play changed.
`RunSave = {v:1, seed, level, mazeSeed|null, runBest, totals:{score, totalTime, distance, bestCombo}, mid|null}`.
- **Mid-level** (`snapshotMidLevel(state)`, from `playing`/`paused`): `mid = {w, h, items, hash, x, y,
  angle, fuel, gems, levelTime, refuels, chalk, reserve, emberUsed, mapFound, taken, explored, marks}` —
  `taken` and `explored` are one bit per item/tile, base64 (`encodeBits`/`decodeBits`), `hash` is
  FNV-1a of the tiles (`tileHash`). ~11.5 kB of JSON at the 257×257 cap.
- **Checkpoint** (`snapshotCheckpoint(state)`, from `levelComplete`): `level + 1`, `mid: null`,
  `mazeSeed: null` — the next depth is built fresh.
- `sanitizeRunSave(raw) → RunSave|null` rebuilds every field or rejects; `summarizeRunSave → {level, score, mid}|null`.
- **Storage:** `loadRun() / saveRun(save) / clearRun()` under its own key **`amaze.run.v1`**, separate
  from `amaze.v1` so a quota error on a big save can never cost the settings/progress record. Same
  defensive contract as `loadPersist` (absent/throwing/corrupt storage → null/false).
- **Action** `{type:'continueRun', save}` — **title only**; a save that does not sanitise is ignored.
  Resets the run like `newGame`, restores `seed`, `level`, the totals and `sim.runBestScore`, parks the
  save in `sim.resume` and enters `loading`. The next `levelReady` in `loading` consumes `sim.resume`:
  after the normal install it calls `applyMid(state, mid)`, which **refuses** (and the level starts
  fresh with the totals intact) unless width, height, item count and tile hash all match and the pose
  is on floor — the case of a generator that changed between save and load. Fuel is clamped to the
  (possibly Shrine-grown) tank.
- **main.js** keeps a cached `savedSummary` for the menus and writes/clears through `writeRun`/`dropRun`:
  **save** on `playing → paused` (blur and a hidden tab both pause, so a closed tab keeps its run), on
  `levelComplete` (checkpoint), on `pagehide` while `playing`/`paused`, and on the menus' *Save & Quit*
  (which only leaves for the title when the write succeeded; otherwise it stays and raises a notice);
  **clear** on `gameOver`, on *Abandon Run*, and on a *New Descent* from the title. `onContinue` reloads
  the save from storage, sets `resumeMazeSeed = save.mazeSeed` (used by that level's first build only;
  a salted retry builds a different maze and falls back to fresh), and dispatches `continueRun`.
- **Menus:** callbacks `onContinue`, `onSaveQuit`, `savedRun() → {level, score}|null`. With a save the
  title rows are *Continue · New Descent · Shrine · Options · Controls · Credits* (Continue selected),
  the record line reads `SAVED RUN · DEPTH n · score`, and New Descent opens the confirm dialog
  (*Keep It* / *Start Over*, note `YOUR SAVED RUN ENDS HERE`). Pause is *Resume · Auto Explore · Options · Controls ·
  Save & Quit · Abandon Run* (Abandon keeps the existing confirm). Level complete is *(Choose a Boon ·)
  Descend · Shrine · Save & Quit* — no abandon there, which also keeps the expedition strip on the panel
  at 1280×720; Escape on the tally moves the cursor to Save & Quit, and Save & Quit shows a waiting boon
  first, like Descend — or, after a *Decide Later*, the forfeit confirm (§4.9).
- `window.__game` additionally exposes `autopilot()` (= `autopilot.info()`) and `savedRun()`.

### 4.11 Game modes — Classic Descent and New Descent _(modes wave — cross-module seam)_

The game ships **two modes**, chosen from the title screen and never mixed:

| mode | `state.mode` | what it is |
|------|--------------|------------|
| Classic Descent | `'classic'` | everything §1–§4.10 describes, unchanged. No enemies, no weapon, Auto Explore available. |
| New Descent | `'combat'` | the same labyrinth with **two enemy types** and a **sword**. No Auto Explore. |

**The mode is a property of the run, not a setting.** It is not in `Settings` and it is not persisted
as a preference: it is chosen by the title row that starts the run, carried on `GameState.mode`, and
saved inside the `RunSave`. `state.mode` while in `title` is whatever the last run used (`'classic'`
on a fresh profile) and means nothing — the title's own rows are the only way to pick one.

**Classic Descent must not regress.** Every number, every event and every draw call in §1–§4.10 is
reached by exactly the same code path in `'classic'` as before this wave; the mode is read as an
early-out at the head of the new work (`if (state.mode !== 'combat') return`), never as a branch
threaded through an existing hot loop. `combat.test.mjs` and `game.test.mjs` both pin that a classic
step emits no combat event and allocates no enemy.

#### Profiles: each mode owns its purse, its ranks and its record

```js
/** @typedef {'classic'|'combat'} Mode */
/** @typedef {{best:BestScore, progress:Progress}} Profile */
```

- `GameState` gains `mode:Mode` and `profiles:{classic:Profile, combat:Profile}`.
- **`state.best` and `state.progress` stay exactly where they were** — they are *live references*
  into `profiles[state.mode]`, re-pointed by `setMode` (on `newGame`, `continueRun` and boot).
  Every existing consumer (the HUD's record line, the Shrine, `recordBest`, `savePersist`) is
  untouched, and it is impossible for a gem picked up in one mode to reach the other purse, because
  there is only ever one live `progress` object and it belongs to the mode being played.
- `balance.js` gains `defaultProfiles()` and `sanitizeProfiles(src) → {classic, progress…}`;
  `sanitizeProgress` / `sanitizeBest` are unchanged and are what it is built from.
- **Persistence is additive inside payload version 1** (§4.2 `save.js`), exactly like `progress`
  was: the record gains `modes:{classic:{best,progress}, combat:{best,progress}}`, and the legacy
  flat `best`/`progress` keys are **still written** as a mirror of the classic profile. A record from
  before this wave has no `modes`, so `loadPersist` folds its flat `best`/`progress` into
  `modes.classic` and starts `modes.combat` empty — an existing player keeps their purse, their
  ranks and their high score, and finds New Descent at rank zero. A record written by this build and
  read by an older one still finds the flat keys it expects. `loadPersist()` therefore returns
  `{best, settings, progress, profiles}`, where `best`/`progress` remain the classic profile's, so
  no existing caller changes.

#### The Shrine moves inside the modes

The Shrine is **removed from the title screen**. It is reached only from within a mode — the
level-complete and game-over screens, which is where a purse that mode earned is spent. `SHRINE_FROM`
drops `'title'` accordingly, so `buyUnlock` dispatched from the title is ignored rather than
silently spending the last-played mode's purse.

#### New Descent: the two enemies

`src/state/combat.js` owns every enemy. It is pure and Node-testable (it imports `core/math`,
`core/rng`, `maze/constants` and `balance`, exactly like `autopilot.js`).

```js
/** @typedef {'crawler'|'wraith'} EnemyKind */
/**
 * @typedef {Object} Enemy
 * @property {number} id            stable within a level (its pool slot)
 * @property {EnemyKind} kind
 * @property {number} x @property {number} y        world position, tiles
 * @property {number} px @property {number} py      previous-step values, for render interpolation
 * @property {number} angle         facing, radians (same convention as Player)
 * @property {number} hp @property {number} hpMax
 * @property {EnemyState} st        see below
 * @property {number} t             seconds spent in `st`
 * @property {number} cool          seconds until it may attack again
 * @property {number} anim          gait phase, radians — advanced by distance walked, like head bob
 * @property {number} lkx @property {number} lky    last position the player was seen at
 * @property {number} hurt          0..1 hit flash, decays
 */
/** @typedef {0|1|2|3|4|5|6} EnemyState  0 idle · 1 chase · 2 windUp · 3 strike · 4 recover · 5 stagger · 6 dead */
```

| | `crawler` | `wraith` |
|---|---|---|
| read | low, wide, many-legged; skitters | tall, narrow, hooded; drifts |
| palette | warm chitin (`RAMPS.chitin`) | cold pale shroud (`RAMPS.shroud`) |
| numbers | `COMBAT.CRAWLER` | `COMBAT.WRAITH` |
| behaviour | fast, short reach, light hit, short recovery | slow, long reach, heavy hit, long telegraph |

Everything above lives in `balance.js`'s frozen `COMBAT` table: `MAX_ENEMIES` (40), `WAKE_TILES`,
`LOSE_TILES`, `PLAYER_HP`, `HEAL_PER_OIL`, `KILL_SCORE`, `DENSITY_START`/`DENSITY_END` (enemies per
100 cells, ramped to `CAP_LEVEL`), `SWING` and the two per-kind blocks (`hp`, `speed`, `radius`,
`reach`, `damage`, `windUp`, `strike`, `recover`, `stagger`, `score`). **How big a creature stands
on screen is NOT here**: `ENEMY_ART` in `src/renderer/enemies.js` owns the billboard scale and the
card's floor row, because those are properties of the painting rather than of the balance — move the
origin row and the same numbers would put the creature underground — and `src/renderer` may not
import `src/state` in any case (§2). `raycaster.js` derives the vertical offset from that pair with
the map scroll's formula (§4.5), so the art and its placement cannot drift apart. `combatParams(level) →
{count, hpMult, damageMult}` is the per-level curve, and it is the **only** thing that scales with
depth — the flask chain and the tank are untouched, so §1's placement guarantee is exactly as valid
in New Descent as in Classic.

**Enemies never pathfind.** A BFS per enemy per replan would be O(tiles) × O(enemies), which §6
forbids. Instead an awake enemy **seeks with wall sliding**: it steers toward the player (or, with no
line of sight, toward `lkx/lky` and then idles), and its move goes through the same `moveCircle`
solver the player uses, so a corridor wall turns it down the corridor. One `hasLineOfSight` DDA per
awake enemy per step, bounded by `WORLD.LOS_MAX_CELLS`. That is a dumber hunter than a pathfinder and
deliberately so: in a corridor maze the corridor *is* the path, and a monster that solves the
labyrinth to reach you is not a monster a torch-lit corridor game wants.

**Cost per step is O(awake enemies), and `MAX_ENEMIES` is a constant.** Enemies outside
`COMBAT.WAKE_TILES` cost one squared-distance test and nothing else; the pool is a fixed-capacity
array of reused objects allocated once per run (`ensureEnemyPool`), so a level change re-seeds slots
rather than allocating. Nothing here is O(items), O(tiles) or O(level).

**The player's sword.** `state.attack = {st, t, hits}` (`st`: 0 idle · 1 windUp · 2 strike · 3
recover). `startAttack(state)` opens a swing when idle and the phase is `playing`; the strike window
resolves **once**, against every enemy inside `SWING.REACH` tiles and within `SWING.ARC` radians of
the view, requiring line of sight. `run.hp` / `run.hpMax` are the player's health (0 outside
`'combat'`); reaching 0 ends the run through the same `endRun` as a dead torch — so the torch is
still the clock and a monster is what makes the clock hurt. An oil flask also mends
`COMBAT.HEAL_PER_OIL`, so the existing economy is the healing economy too.

**Events** (§3 `GameEvent`): `{type:'swing', hit:boolean}`, `{type:'enemyHit', kind, x, y, damage,
killed}`, `{type:'playerHit', kind, damage, x, y}` and `{type:'enemyWake', kind, x, y}` — the last
is a creature *noticing* the player, which is the only warning the mode gives before something
arrives out of the dark, and it is why waking is an event rather than a flag flip. `derived` gains
`threat` (0..1, nearest awake enemy's proximity) for audio and the post stack.

**Impact.** A landed blow is not a number going down: it takes `COMBAT.HITSTOP` (0.055 s, 0.1 on a
kill, 0.09 when the player is hit) of **hitstop** — `sim.hitStop` holds the whole world still while
the render loop keeps drawing, so the frozen frames are the ones carrying the white flash, the
sparks and the shake. Through a freeze the torch still burns and the camera shake still decays,
because neither is the blow: a frozen shake is a photograph of a shake, and a torch that stopped
during every exchange would make fighting free. The struck creature is thrown `COMBAT.KNOCKBACK`
tiles/second along the blow for `KNOCKBACK_TIME`, and the player's camera takes
`HIT_SHAKE_DEALT` (or `KILL_SHAKE`).

#### Renderer

- `RenderView` gains `enemies:Enemy[]` (`NO_ENEMIES` outside combat) and
  `weapon:{st:number, phase:number, kick:number}|null`.
- **Enemies go through the sprite spatial index like everything else.** `raycaster.js` holds a third
  `createSpriteIndex()` and **rebuilds it every frame** — which is legal precisely because the
  population is capped at `COMBAT.MAX_ENEMIES` (40) rather than by the level: the rebuild is
  O(enemies) with a constant bound, it allocates nothing above the first level's high-water mark
  (§4.5 allocation contract), and the gather pass then queries it with the identical
  `queryCells(…, SPRITE_FAR)` walk the items use. The item and torch indexes keep their
  rebuild-on-level-change rule; only the enemy index is per-frame, and only because its points move.
- **`src/renderer/enemies.js`** paints the combat art, and is **not** part of `createTextures`:
  `createCombatTextures(seed) → CombatTextures {crawler:Texture[], wraith:Texture[], sword:Texture[],
  ENEMY_VIEWS, ENEMY_FRAMES}` is called lazily, the first time a combat run needs it, and cached by
  main.js. A Classic Descent session never pays for it. Both creatures are **modelled** with
  `models.js` and rasterised per view (`ENEMY_VIEWS` = 5 yaws over the full turn, mirrored for the
  other half) × per gait frame (`ENEMY_FRAMES` = 4), plus a wind-up, a strike, a stagger and two
  death frames. Frame index: `enemyFrameIndex(view, pose)`, exported so the renderer and its test
  agree on one formula.
- `raycaster.setCombatTextures(set)` installs them; they are held **beside** `textures`, not merged
  into a `TextureSet`, so the per-floor tileset swap (§4.5) is untouched and a set painted once
  survives every floor.
- **The weapon is a screen-space pass**, `renderWeapon(view)`, run after the sprites and the
  particles and before the flash: one 64×64 sword frame blitted at an integer scale into the
  bottom-right of the framebuffer, offset by the swing's kick and lunge, shaded through the same
  colormap row the player's torch produces, alpha-keyed on palette index 0. No z-test (it is in
  front of everything), no allocation, and it draws nothing when `view.weapon` is null.

#### UI

- `hud.js` — in `'combat'` it additionally draws a **health bar** under the fuel gauge (the same
  panel language, labelled `LIFE n/max` — it is the only readout on screen and a bar with neither a
  label nor a number reads as a second, broken loading bar), and an **ATTACK** plaque at the
  **bottom centre** of the world band, lifted `ATTACK_LIFT` units clear of its bottom edge
  (`hud.hitAttack(clientX, clientY)`, `hud.setAttackButton(on)` — main.js suppresses it on touch,
  where the touch bar owns it). Centre and not the bottom **right**, which is where it started: the
  right is where the sword is drawn, so the plaque sat under the blade and the one moment it was
  most worth looking at — mid-swing — was the one moment it was behind the weapon. It is also the
  slot the AUTO button vacates, since New Descent never draws that one.
  `hud.hurtFrom(bearing)` records which way a blow came from and the HUD draws a fading red wedge on
  that edge of the world band: being hit from behind otherwise looked identical to being hit from in
  front, in a mode whose whole threat is things arriving out of the dark.
  The **AUTO button is never drawn in `'combat'`**, key hint included, and the phone's Controls
  screen swaps its AUTO row for an **Attack** one, because `touch-overlay.js` swaps the buttons.
- **The corner map moves to the top right in `'combat'`** — tucked under the score panel — because
  the bottom right now belongs to the attack button. In `'classic'` it stays exactly where it was
  (bottom right) **on a mouse**; §4.12 moves it top right in both modes on a touch device, where the
  bottom belongs to the thumb deck. `map.js` `drawCorner` gains a `corner` argument (`'br'` default, `'tr'`), and
  `MAP.CORNER_TOP_GAP` is the clearance it leaves for the score plaque.
- `menus.js` — the title is **New Descent · Classic Descent**, then *Continue* when a run is saved,
  then Options · Controls · Credits. **Nothing sits above the two mode rows**, and the Shrine row is
  gone from the title. `onNewGame(mode)` carries the mode. Starting either mode while a save exists
  raises the existing *Start Over?* confirm. The pause screen drops its *Auto Explore* row in
  `'combat'`, and the Options screen's Auto Explore toggle is disabled there.
- `audio.js` — voices `swing`, `enemyHit`, `playerHit` and a kill; `derived.threat` rides the drone.
- `touch-overlay.js` — an **ATTACK** button, shown only while `state.mode === 'combat'`; the AUTO
  button is hidden there. Superseded by §4.12: the two share the one big bottom-right slot, because
  they are never both on screen and it is the slot a thumb actually rests on.

#### Saved runs

`RunSave` gains `mode:Mode` (absent ⇒ `'classic'`, so every existing save still loads), and a
combat `mid` gains `foes:number[]` — four numbers per live enemy (`kindIndex`, `x*64|0`, `y*64|0`,
`hp`), so a 40-enemy floor costs ~160 numbers. `applyMid` restores them when the level fingerprint
matches and simply leaves the freshly spawned set alone when `foes` is absent. `continueRun` sets
the mode before the level is requested, so the right profile is live before the first `levelReady`.

#### Auto Explore is off in New Descent

`Settings.autoExplore` is **ignored** in `'combat'`: `main.js`'s `driveAuto` returns the real frame,
the `auto` action is swallowed, `shouldLockPointer()` no longer consults the setting, and both
buttons and the pause row are hidden. The setting itself is left alone — a player who turns it on in
Classic still has it on in Classic.

### 4.12 The thumb deck and how a run ends _(mobile wave — cross-module seam)_

Two problems, one cause: **everything wanted the top right.** The score plaque is there, the corner
map moved there in `'combat'` (§4.11), and the touch button bar was there too — pushed down by a
`15vh` margin and a 64 px inline drop that were tuned against a HUD that has grown twice since. On a
390×844 phone the bar sat squarely on top of the corner map the moment the map scroll was found, and
ATTACK — the button pressed more than every other control combined — was at the far top right, the
one place a thumb cannot reach without regripping.

**The rule: the top is instruments, the bottom is controls.**

- **`touch-overlay.js` anchors every button bottom-right**, in the two right-aligned rows tabled in
  §4.3. Nothing is top-anchored any more, `BAR_DROP_PX` is gone, and `styles.css` no longer needs a
  `margin-top` to push the bar clear of a panel — the class (`amaze-touch-deck`) survives only as a
  hook, now used to hold the deck above the home indicator.
- **The primary button is the mode's:** ATTACK in `'combat'`, AUTO in `'classic'`. They are never
  both present, so they share the one big bottom-right slot instead of competing for the row. This
  replaces §4.11's "AUTO is hidden and ATTACK is rightmost and larger".
- **The system row is held out of the stick zone.** `input.js` reserves the left
  `STICK_ZONE_FRACTION` (0.4) of the width for the virtual stick at *any* height, so a right-aligned
  row of three 58 px buttons clears it on a 390 px-wide portrait phone with room to spare. This is
  asserted, not assumed: `touch-overlay.test.mjs` computes the row's left edge and compares it to the
  zone at both orientations.
- **On touch the corner map is always top right**, in `'classic'` as well as `'combat'`:
  `hud.setTouchLayout(on)` (main.js passes `input.isTouch`, exactly as it already does for
  `setAttackButton`). Classic's bottom-right corner map would otherwise sit underneath the new deck.
  On a mouse both modes are unchanged, down to the pixel.

**How a run ended.** `run.endCause` is an `EndCause` (§3): `'torch'` or `'slain'`. `endRun(state,
cause)` writes it and puts it on the `gameOver` event; `newGame` and `continueRun` reset it to
`'torch'`. It exists because `run.hp` reaching 0 and `run.fuel` reaching 0 deliberately end a run
through **one** code path (§4.11), which is right for the score, the record and the save — and wrong
for the sentence on the screen. A player killed by a crawler was told *"Your torch has gone out"*,
which is not a death message, it is the wrong death message. `menus.js` picks its heading off the
field: `HEADING_OUT` for `'torch'`, `HEADING_SLAIN` for `'slain'`.

## 5. Quality gates (automated)
- `npm test` — every `src/*/*.test.mjs` (node:test) in its own process (**864 tests in 46 files** —
  core 86, input 105, maze 94, renderer 129, state 210, ui 240).
  Two of those files, `src/state/perf.test.mjs` and `src/state/feasibility.test.mjs`, import
  `src/maze` as a **test-only** dependency: the §2 runtime rule is unchanged (`src/state` still
  imports only `src/maze/constants.js` at runtime), but a feasibility proof over fake mazes would
  prove nothing. `perf.test.mjs` pins the step cost against the massive-maze curve (a 128×128 level
  with 819 items must stay within 1.5× of the old 6×6 level; measured 1.06×) and the allocation
  budget (100 000 ticks on a max-size level: < 1 MB, measured +2 kB). `feasibility.test.mjs` walks
  250 real levels (1…25 × 10 seeds) with a 2.0× wander autopilot and requires **250/250** to reach
  the exit, with a negative control (the same autopilot on a flask-stripped level must die).
- `node tools/validate-mazes.mjs` — 100 % solvability across the seed/size matrix plus the refuel
  chain over the real campaign (**81 434 mazes + 750 levels, ~63 s**). `--quick` for a smoke.
  The matrix is **shapes, not counts**: it sweeps the degenerate extremes (1×1…2×2), long thin
  corridors (1×300, 300×1, 300×7, 7×300 — deepest carve stack, least room for a shortcut or a
  braid) and non-square prime/coprime grids (37×41, 101×103, 17×31, where a `cell ↔ tile`
  arithmetic bug a square grid hides has nowhere to go), and it now sweeps **shortcut density**
  beside the braid fractions, because every campaign level runs the shortcut pass and a matrix that
  never passes `shortcuts` is not testing what the game builds. The total fell from 117 306 because
  16 000 seeds of a 1×1/2×2 grid were 55 % of the old count and proved nothing the first 200 had
  not; the time rose because shortcut builds cost several times a plain carve.
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
  raycaster costs ~0.6 ms/frame in Node and ~2.2 ms in the browser on a real cap-size level
  (measured), is pixel-exact for the retro look, and works everywhere.
- Mazes are "thick-wall" tile mazes (`cols*2+1`) so walls are full blocks, like the reference.
- **Massive mazes.** Level 1 = 16×16 cells (33×33 tiles), +8 cells per side per level, capped at
  128×128 cells (257×257 tiles, 16 384 cells) at level 15; stress tests go to 2000×2000.
  `LEVEL.MAX_CELLS` is the single knob and `CAP_LEVEL` is derived from
  `BASE_CELLS`/`GROWTH`/`MAX_CELLS`. Past the cap the maze stops growing and difficulty comes from
  braid (which keeps rising to 0.6), a drain rising 3.5 %/level from level 3 to 1.45×, thinning oil and the score
  multiplier — not from area. Size is purely a balance decision: generating **and** validating
  128×128 costs ~5 ms and a full `buildLevel` ~12–14 ms.
  _Measured caveat that shaped the braid ramp:_ the "~13 tiles per cell-side" path law only holds
  for **braided** mazes. A perfect maze's farthest-cell route is superlinear (~side^1.6): 72×72 at
  braid 0 measures 3 903 path tiles (≈ 48 minutes at a 2× wander) against 907 at braid 0.25, and
  128×128 at braid 0 measures 10 612. With a slow linear braid ramp, levels 3–8 would have been
  **longer than level 15**. The shipped fix is `BRAID_MAX` 0.6 over a 17-level ramp shaped by
  `BRAID_RAMP_SHAPE` 0.5 (square root, front-loaded), which also satisfies "braid keeps rising past
  the cap" and yields a smooth curve on real mazes: ~4 minutes at level 2 (the lean first floor is
  shorter still, ~1–1.5) to ~13.5 at the deepest.
  _One constant reads stale on purpose:_ `LEVEL.PATH_TILES_PER_SIDE = 13` overestimates the shipped
  route at the deepest braid (≈ 7.1 tiles per cell-side measured at braid 0.6). It feeds only
  balance's `par` **floor**, and `populate.js` computes the real par from the real path and takes
  the larger — so overestimating is the safe direction and nothing is wrong today. Anyone reaching
  for it as a *route-length estimate* should measure instead.
- **Fuel is a tank you keep refilling, not a budget for the level** (§1, §4.4). The superseded
  assumption — "fuel is sized for a player who cannot see the maze, ~4× the optimal route, settling
  to ~3×" — cannot survive a 33 000-tile level: a budget that covers the maze turns it into one long
  countdown where the first two minutes are free and the last thirty seconds are the game. The tank
  is 95–150 s **independent of maze area** (64× the area buys 1.36× the tank), a flask is 35 % of
  it, and a level takes 7–22 refuels. Feasibility is proven rather than argued: 250/250 real levels
  cleared by a 2.0× wander autopilot, worst torch reserve 70 % of the tank across 750 campaign
  levels, and the same autopilot on a flask-stripped level correctly dies.
- **Nothing may be O(items) or O(tiles) per frame or per step.** A level now carries hundreds to
  ~820 items, ~1 300 torches and a 66 049-byte `explored` grid, and a run is long. Every consumer
  had to be re-cut for it: pickups query a bucket grid (§4.2), the sprite and light passes walk a
  spatial index (§4.5), and the map maintains an incremental raster (§4.6). This is the single
  invariant the massive-maze change rests on; a new feature that scans a level array per frame
  regresses it invisibly on level 1 and visibly at the cap.
- **The world letterboxes rather than stretching.** The framebuffer is 240 rows at 4:3 and wider, the width
  clamped to 320…560 and the height to 240…400 (§4.5), so it can be anywhere from 4:5 to 21:9: a
  foldable's near-square inner screen fills edge to edge. A portrait phone (taller than 5:4 in CSS
  px) is deliberately handed a 4:3 buffer and shows a 4:3 band with a control deck below it, and a 21:9 monitor shows
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
- **Two modes, one game.** New Descent (§4.11) is the same generator, the same torch economy and
  the same placement guarantee with enemies and a sword added on top — not a second game sharing a
  menu. The alternative (a combat-tuned level curve) would have forked `populate.js` and with it the
  refuel proof that §1 rests on; instead `combatParams(level)` scales only the enemies, and
  `levelParams` never learns the mode exists. The cost is that a New Descent floor is a Classic floor
  you have to fight across, which is exactly the intent: the torch is still the clock.
- **Enemies are capped, not level-scaled.** `COMBAT.MAX_ENEMIES` is 40 whatever the maze measures, so
  every per-step and per-frame enemy pass is O(1) in the level — the §6 invariant above holds by
  construction rather than by care. It is also why the renderer may rebuild the enemy spatial index
  every frame while the item and torch indexes are rebuilt only on a level change.
- itch.io target `severalherr/a-maze:html5`, deployed from `main` after the quality gate passes.
