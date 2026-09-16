// @ts-check
/**
 * @file Shared type vocabulary for every A-MAZE subsystem (ARCHITECTURE.md §3).
 *
 * This module is JSDoc only: it has no runtime code besides `export {}` so that importing it
 * for types costs nothing and can never create a cycle. Consumers pull a type in with a typedef
 * of the form `import('../core/types.js').GameState` (see any subsystem file for an example).
 *
 * Conventions used throughout (they are invariants, not suggestions):
 * - **World units are tiles.** Tile (tx,ty) spans [tx,tx+1)×[ty,ty+1); its centre is (tx+0.5, ty+0.5).
 * - **Angles are radians**, 0 = +x (east), π/2 = +y (south) — screen-style, y grows downward.
 * - **Time is seconds** in simulation data (`dt`, `fuel`, `time`); milliseconds only appear in
 *   frame-timing statistics (`FrameStats`) where that is the industry-standard unit.
 * - Tile arrays are row-major: `index = ty * width + tx`.
 *
 * Section 3 of the contract writes some properties several-per-line; they are split one per line
 * here (identical names and types) because TypeScript's JSDoc parser only honours one `@property`
 * per line. The shapes are otherwise verbatim.
 *
 * `Action` (§4.2) and `RenderView` (§4.5) are mirrored here too, because both cross module seams
 * (main.js builds them; state/renderer consume them) and `src/core` is the only module every
 * other module is allowed to import.
 */

// ─── Geometry ────────────────────────────────────────────────────────────────────────────────

/**
 * A 2-D point or vector. Units depend on context (tile coords for maze positions, world units for
 * positions, pixels for screen space) — each use site documents which.
 * @typedef {{x:number, y:number}} Vec2
 */

// ─── Maze & level data ───────────────────────────────────────────────────────────────────────

/**
 * Tile map. Tiles are 1×1 world units. Tile (tx,ty) spans [tx,tx+1)×[ty,ty+1).
 * "Thick-wall" layout: logical cell (cx,cy) lives at tile (2cx+1, 2cy+1); the tiles between
 * cells are walls or carved passages.
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

/** @typedef {'gem'|'oil'} ItemKind */

/**
 * A collectible. `x,y` are the tile centre (tx+0.5, ty+0.5) in world units.
 * @typedef {{id:number, kind:ItemKind, x:number, y:number, taken:boolean}} Item
 */

/**
 * A wall-mounted torch: the wall tile (x,y) plus the face (0=E,1=S,2=W,3=N) the flame is mounted
 * on, i.e. the side of the wall block that faces the corridor.
 * @typedef {{x:number, y:number, face:0|1|2|3}} Torch
 */

/**
 * Result of `validateMaze`. A maze is playable iff `errors.length === 0`.
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
 * Everything needed to play one level. Deterministic for a given (params, seed).
 * @typedef {Object} LevelData
 * @property {Maze} maze
 * @property {Validation} validation
 * @property {Item[]} items
 * @property {Torch[]} torches
 * @property {number} fuel            starting fuel seconds for the level
 * @property {number} par             par time seconds (for the summary screen)
 */

// ─── Input ───────────────────────────────────────────────────────────────────────────────────

/**
 * Edge-triggered semantic actions (menu navigation and toggles).
 * @typedef {'confirm'|'back'|'pause'|'map'|'up'|'down'|'left'|'right'|'mute'} InputAction
 */

/**
 * One poll of all input devices, consumed by exactly one sim step. The input module reuses a
 * single instance (zero allocation), so consumers must not retain it across steps.
 * @typedef {Object} InputFrame
 * @property {number} moveX           strafe  -1..1 (right +)
 * @property {number} moveY           forward -1..1 (forward +)
 * @property {number} turn            keyboard/stick turn -1..1 (right +), scaled by dt in sim
 * @property {number} lookDX          accumulated mouse/touch yaw delta in radians since last poll (already sensitivity-scaled)
 * @property {boolean} sprint
 * @property {Set<InputAction>} pressed   edge-triggered this poll
 */

// ─── Game state ──────────────────────────────────────────────────────────────────────────────

/**
 * The player avatar. Current values are the result of the latest sim step; `px/py/pangle` hold
 * the values from the step before so the renderer can interpolate with the loop's `alpha`.
 * @typedef {Object} Player
 * @property {number} x              world position (tile units)
 * @property {number} y              world position (tile units)
 * @property {number} angle          radians, 0 = +x (east), π/2 = +y (south)
 * @property {number} px             previous-step x, for interpolation
 * @property {number} py             previous-step y, for interpolation
 * @property {number} pangle         previous-step angle, for interpolation
 * @property {number} vx             velocity (tiles/second)
 * @property {number} vy             velocity (tiles/second)
 * @property {number} bob            head-bob phase (radians)
 * @property {number} bobAmp         0..1 current bob amplitude
 * @property {number} shake          0..1 camera shake (decays)
 */

/** @typedef {'title'|'loading'|'playing'|'paused'|'levelComplete'|'gameOver'} Phase */

/**
 * Persisted user preferences.
 * @typedef {Object} Settings
 * @property {number} volume         0..1
 * @property {number} music          0..1
 * @property {number} sensitivity    0.2..3
 * @property {boolean} scanlines
 * @property {boolean} minimap
 * @property {boolean} reducedMotion
 * @property {boolean} invertLook
 */

/**
 * Per-run counters (the `GameState.run` shape, named so consumers can reference it).
 * @typedef {{score:number, gems:number, gemsTotal:number, fuel:number, fuelMax:number, levelTime:number, totalTime:number, levelScore:number, bestCombo:number}} RunStats
 */

/**
 * Persisted high score (the `GameState.best` shape).
 * @typedef {{score:number, level:number}} BestScore
 */

/**
 * Values recomputed every step for renderer/hud/audio (the `GameState.derived` shape).
 * @typedef {{exitDist:number, nearExit:number, lowFuel:boolean}} Derived
 */

/**
 * The single authoritative game state, owned and mutated in place by the store.
 * @typedef {Object} GameState
 * @property {Phase} phase
 * @property {number} time            total sim seconds since boot (monotonic)
 * @property {number} phaseTime       seconds since phase changed
 * @property {number} level           1-based
 * @property {number} seed            run seed
 * @property {LevelData|null} levelData
 * @property {Player} player
 * @property {Uint8Array|null} explored   width*height, 1 = seen (minimap fog of war)
 * @property {RunStats} run
 * @property {BestScore} best
 * @property {Settings} settings
 * @property {Derived} derived        recomputed each step for renderer/hud/audio
 * @property {GameEvent[]} events     events emitted by the LAST step (cleared at start of each step)
 */

/**
 * Discrete things that happened during a step; consumed by audio/particles/post effects.
 * @typedef {{type:'footstep', foot:0|1} | {type:'bump', strength:number} | {type:'pickup', kind:ItemKind, x:number, y:number, value:number}
 *   | {type:'levelStart', level:number} | {type:'levelComplete', level:number, bonus:number}
 *   | {type:'lowFuel'} | {type:'gameOver', score:number, newBest:boolean} | {type:'phase', from:Phase, to:Phase}
 *   | {type:'uiMove'} | {type:'uiConfirm'}} GameEvent
 */

// ─── Cross-seam shapes mirrored from §4.2 / §4.5 ─────────────────────────────────────────────

/**
 * Store actions (ARCHITECTURE.md §4.2). `setSetting` is keyed by a `Settings` property name.
 * @typedef {{type:'tick', dt:number, input:InputFrame} | {type:'newGame', seed:number} | {type:'levelReady', data:LevelData}
 *   | {type:'pause'} | {type:'resume'} | {type:'nextLevel'} | {type:'toTitle'}
 *   | {type:'setSetting', key:keyof Settings, value:number|boolean} | {type:'debugWin'}} Action
 */

/**
 * Additive colour flash overlay; channels 0..255 for r/g/b, 0..1 for alpha.
 * @typedef {{r:number, g:number, b:number, a:number}} Flash
 */

/**
 * Everything the raycaster needs for one frame (ARCHITECTURE.md §4.5). Built by main.js from the
 * interpolated player; read-only for the renderer.
 * @typedef {Object} RenderView
 * @property {{x:number, y:number, angle:number, bob:number, bobAmp:number, shake:number}} player
 * @property {Maze} maze
 * @property {Item[]} items
 * @property {Torch[]} torches
 * @property {Vec2} exit
 * @property {number} time            seconds
 * @property {number} light           0..1 torch strength
 * @property {Flash} flash
 * @property {boolean} portalOpen
 * @property {boolean} reducedMotion
 */

// ─── Core module shapes (re-exported for one-stop type imports) ──────────────────────────────

/** @typedef {import('./loop.js').FrameStats} FrameStats */
/** @typedef {import('./loop.js').Loop} Loop */
/** @typedef {import('./loop.js').LoopOptions} LoopOptions */
/** @typedef {import('./rng.js').Rng} Rng */
/** @typedef {import('./log.js').Logger} Logger */
/** @typedef {import('./log.js').ErrorEntry} ErrorEntry */

export {};
