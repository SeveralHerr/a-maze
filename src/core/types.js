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

/**
 * A chalk mark on one face of a wall tile (ARCHITECTURE.md §4.9). `face` uses the torch numbering
 * (0=E, 1=S, 2=W, 3=N: the outward normal of the chalked side); `seed` picks the lettering variant.
 * @typedef {{x:number, y:number, face:0|1|2|3, seed:number}} ChalkMark
 */

/**
 * Persisted meta progression (§4.9): gems banked across runs, unlock ranks by id, and the deepest
 * level a boon has been claimed for.
 * @typedef {{purse:number, ranks:Record<string, number>, boonLevel:number}} Progress
 */

/**
 * Flat per-run numbers derived from `Progress.ranks` by `balance.computePerks` (§4.9). Multipliers
 * are 1 and everything else is 0 with no unlocks.
 * @typedef {Object} Perks
 * @property {number} tankMult      × the level's tank
 * @property {number} oilMult       × a flask's value
 * @property {number} drainMult     × the level's drain
 * @property {number} emberSeconds  fuel a dead torch rekindles with, once per level (0 = none)
 * @property {number} siphonCap     seconds of flask overflow the reserve holds (0 = none)
 * @property {number} flame         × the player torch's light radius
 * @property {number} reveal        fog-of-war reveal radius, tiles
 * @property {number} oilSense      flasks within this many tiles show through walls (0 = none)
 * @property {number} scrollSense   the HUD pulses within this many tiles of the scroll (0 = none)
 * @property {number} whisper       dead-end branch depth that darkens (0 = none, 255 = all)
 * @property {number} lodestone     1 = exit needle once the scroll is found
 * @property {number} chalk         chalk charges per level
 * @property {number} magnet        gem pull radius, tiles (0 = none)
 * @property {number} gemPurse      purse gems per gem picked up
 */

/**
 * The pick-one-of-three offered on clearing a new record depth (§4.9).
 * @typedef {{open:boolean, level:number, ids:string[]}} BoonOffer
 */

/** @typedef {'gem'|'oil'|'map'} ItemKind  'map' = the level's hidden map scroll (ARCHITECTURE.md §4.8) */

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
 * `chalk` marks the wall ahead (§4.9).
 * @typedef {'confirm'|'back'|'pause'|'map'|'up'|'down'|'left'|'right'|'mute'|'chalk'|'auto'|'attack'} InputAction
 */

/**
 * One poll of all input devices, consumed by exactly one sim step. The input module reuses a
 * single instance (zero allocation), so consumers must not retain it across steps.
 * @typedef {Object} InputFrame
 * @property {number} moveX           strafe  -1..1 (right +)
 * @property {number} moveY           forward -1..1 (forward +)
 * @property {number} turn            keyboard/stick turn -1..1 (right +), scaled by dt in sim
 * @property {number} lookDX          accumulated mouse/touch yaw delta in radians since last poll (already sensitivity-scaled)
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
 * Which game the run is (ARCHITECTURE.md §4.11). `'classic'` is Classic Descent — everything
 * §1–§4.10 describes, unchanged. `'combat'` is New Descent: the same labyrinth with two enemy types
 * and a sword, and no Auto Explore.
 *
 * It is deliberately **not** a `Settings` key: it belongs to the run, is chosen by the title row
 * that starts it, and travels in the `RunSave`.
 * @typedef {'classic'|'combat'} Mode
 */

/**
 * One mode's persisted record and purse (§4.11). The two never mix: `GameState.best` and
 * `GameState.progress` are live references into the profile of the mode being played.
 * @typedef {{best:BestScore, progress:Progress}} Profile
 */

/** @typedef {'crawler'|'wraith'} EnemyKind */

/**
 * An enemy's state machine (§4.11). `dead` slots stay in the pool until the corpse timer frees them.
 * @typedef {0|1|2|3|4|5|6} EnemyState  0 idle · 1 chase · 2 windUp · 3 strike · 4 recover · 5 stagger · 6 dead
 */

/**
 * One enemy in New Descent (§4.11). Pooled: `GameState.enemies` is a fixed-capacity array of these
 * objects, reused across levels and runs, so a level change re-seeds slots rather than allocating.
 * @typedef {Object} Enemy
 * @property {number} id             stable within a level (its pool slot)
 * @property {EnemyKind} kind
 * @property {number} x              world position, tiles
 * @property {number} y              world position, tiles
 * @property {number} px             previous-step x, for render interpolation
 * @property {number} py             previous-step y, for render interpolation
 * @property {number} angle          facing, radians (same convention as `Player.angle`)
 * @property {number} hp
 * @property {number} hpMax
 * @property {EnemyState} st
 * @property {number} t              seconds spent in `st`
 * @property {number} cool           seconds until it may open another attack
 * @property {number} anim           gait phase, radians — advanced by distance walked, like head bob
 * @property {number} lkx            x the player was last seen at
 * @property {number} lky            y the player was last seen at
 * @property {number} hunt           seconds left of walking to `lkx/lky` after losing sight
 * @property {number} hurt           0..1 hit flash, decays
 * @property {number} damage         damage one of its hits does on this level
 * @property {boolean} awake         the player has been noticed
 */

/**
 * The player's sword (§4.11). `st`: 0 idle · 1 windUp · 2 strike · 3 recover; `hits` is how many
 * enemies the open swing has already touched, so a strike window resolves exactly once.
 * @typedef {{st:0|1|2|3, t:number, hits:number}} AttackState
 */

/**
 * Persisted user preferences.
 * @typedef {Object} Settings
 * @property {number} volume         0..1
 * @property {number} music          0..1
 * @property {number} sensitivity    0.2..3
 * @property {boolean} scanlines
 * @property {boolean} minimap       legacy two-state map switch; kept as a mirror of
 *   `mapMode !== 'off'` so audio/touch and any older call site keep working
 * @property {MapMode} mapMode       three-state map: off → corner → full (§4.6)
 * @property {boolean} reducedMotion
 * @property {boolean} invertLook
 * @property {boolean} fullscreen     go fullscreen on the gesture that starts/resumes a run when the
 *   game is embedded (itch.io iframe); default true (ARCHITECTURE.md §4.3 `fullscreen.js`)
 * @property {boolean} autoExplore   the autopilot plays the level (ARCHITECTURE.md §4.10); default false
 */

/**
 * The map overlay's three states (`src/ui/map.js` owns the behaviour; this is the persisted value).
 * @typedef {'off'|'corner'|'full'} MapMode
 */

/**
 * Per-run counters (the `GameState.run` shape, named so consumers can reference it).
 *
 * `refuels` and `distance` exist for the massive-maze HUD and end screens: on a 14-minute labyrinth
 * "how many times did I refill the torch" and "how far did I walk" are the statistics that describe
 * the run, where a small maze was fully described by time and gems. `refuels` counts flasks burned
 * **this level** (reset by `levelReady`); `distance` accumulates tiles walked over the whole **run**.
 * `mapFound` is true once this level's map scroll is picked up (or the level has none); the map is
 * locked until then (ARCHITECTURE.md §4.8). `chalk` = chalk charges left this level, `reserve` = siphon
 * seconds stored, `emberUsed` = this level's ember has rekindled the torch (§4.9).
 * `hp`/`hpMax` are the player's health in New Descent (§4.11) and are 0 in Classic Descent;
 * `kills` counts enemies felled this run; `iframes` is the invulnerability left after a hit.
 * @typedef {{score:number, gems:number, gemsTotal:number, fuel:number, fuelMax:number, levelTime:number, totalTime:number, levelScore:number, bestCombo:number, refuels:number, distance:number, mapFound:boolean, chalk:number, reserve:number, emberUsed:boolean, hp:number, hpMax:number, kills:number, iframes:number}} RunStats
 */

/**
 * Persisted high score (the `GameState.best` shape).
 * @typedef {{score:number, level:number}} BestScore
 */

/**
 * Values recomputed every step for renderer/hud/audio (the `GameState.derived` shape).
 * `threat` is 0..1, the nearest awake enemy's proximity — always 0 in Classic Descent (§4.11).
 * @typedef {{exitDist:number, nearExit:number, lowFuel:boolean, scrollSense:number, threat:number}} Derived
 */

/**
 * The single authoritative game state, owned and mutated in place by the store.
 * @typedef {Object} GameState
 * @property {Phase} phase
 * @property {Mode} mode              which mode this run is (§4.11)
 * @property {{classic:Profile, combat:Profile}} profiles  per-mode record and purse (§4.11);
 *   `best` and `progress` below are LIVE REFERENCES into `profiles[mode]`
 * @property {Enemy[]} enemies        live enemies this level — pooled, capacity `COMBAT.MAX_ENEMIES`,
 *   always empty in Classic Descent (§4.11)
 * @property {AttackState} attack     the player's sword (§4.11)
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
 * @property {Progress} progress      persisted unlocks and purse (§4.9)
 * @property {Perks} perks            numbers derived from `progress` (§4.9)
 * @property {BoonOffer} offer        the boon pending on a level clear (§4.9)
 * @property {ChalkMark[]} marks      chalk marks on this level (§4.9)
 * @property {GameEvent[]} events     events emitted by the LAST step (cleared at start of each step)
 */

/**
 * Discrete things that happened during a step; consumed by audio/particles/post effects.
 * @typedef {{type:'footstep', foot:0|1} | {type:'bump', strength:number} | {type:'pickup', kind:ItemKind, x:number, y:number, value:number}
 *   | {type:'levelStart', level:number} | {type:'levelComplete', level:number, bonus:number}
 *   | {type:'lowFuel'} | {type:'gameOver', score:number, newBest:boolean} | {type:'phase', from:Phase, to:Phase}
 *   | {type:'uiMove'} | {type:'uiConfirm'}
 *   | {type:'chalk', ok:boolean, x:number, y:number} | {type:'ember', seconds:number}
 *   | {type:'unlock', id:string, rank:number, boon:boolean}
 *   | {type:'swing', hit:boolean}
 *   | {type:'enemyHit', kind:EnemyKind, x:number, y:number, damage:number, killed:boolean}
 *   | {type:'playerHit', kind:EnemyKind, damage:number, x:number, y:number}} GameEvent
 */

// ─── Cross-seam shapes mirrored from §4.2 / §4.5 ─────────────────────────────────────────────

/**
 * Store actions (ARCHITECTURE.md §4.2). `setSetting` is keyed by a `Settings` property name.
 * @typedef {{type:'tick', dt:number, input:InputFrame, auto?:boolean} | {type:'newGame', seed:number, mode?:Mode} | {type:'levelReady', data:LevelData}
 *   | {type:'pause'} | {type:'resume'} | {type:'nextLevel'} | {type:'toTitle'}
 *   | {type:'setSetting', key:keyof Settings, value:number|boolean|string} | {type:'debugWin'}
 *   | {type:'buyUnlock', id:string} | {type:'claimBoon', id:string} | {type:'continueRun', save:unknown}} Action
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
 * @property {ChalkMark[]} [marks]   chalk marks on the level (§4.9); identity + length drive the rebuild
 * @property {number} [flame]         × the player torch radius (Wide Flame, default 1)
 * @property {number} [oilSense]      flasks within this many tiles draw through walls (default 0)
 * @property {number} [whisper]       dead-end branch depth to darken (default 0 = off)
 * @property {Enemy[]} [enemies]      live enemies to billboard (New Descent, §4.11; empty otherwise)
 * @property {{st:number, phase:number, kick:number}|null} [weapon]  the first-person sword: its
 *   state, 0..1 progress through that state, and a 0..1 recoil — null draws nothing (§4.11)
 */

// ─── Core module shapes (re-exported for one-stop type imports) ──────────────────────────────

/** @typedef {import('./loop.js').FrameStats} FrameStats */
/** @typedef {import('./loop.js').Loop} Loop */
/** @typedef {import('./loop.js').LoopOptions} LoopOptions */
/** @typedef {import('./rng.js').Rng} Rng */
/** @typedef {import('./log.js').Logger} Logger */
/** @typedef {import('./log.js').ErrorEntry} ErrorEntry */

export {};
