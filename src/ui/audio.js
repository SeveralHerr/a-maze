// @ts-check
/**
 * A-MAZE — audio (ARCHITECTURE.md §4.6).
 *
 * Every sound in the game is **synthesised at runtime** with WebAudio; there is not a single audio
 * file in the repository. The module owns one `AudioContext` and one fixed mixer graph:
 *
 * ```
 *   one-shot voices ─┬─► sfxBus ──────────────────────► master ─► compressor ─► limiter ─► destination
 *   portal hum ──────┤     ▲
 *   torch flame ─────┘     └── [convolver: 1.3 s synthetic stone-room IR] ◄─ sfxSend ◄─ voice sends
 *   music plucks ────┬─► musicBus ────────────────────►
 *   dungeon drone ───┘     ▲
 *                          └── [convolver: 2.2 s darker hall IR] ◄─ musicSend ◄─ pluck sends
 * ```
 *
 * WHY a convolver with a *generated* impulse response: a single feedback delay line is an echo
 * (discrete repeats every 120 ms read as flutter on a bell), not a room. Real diffusion needs either
 * a bank of combs and allpasses or an IR; the IR is built once at unlock from the seeded RNG
 * (early reflections + exponentially decaying stereo noise that darkens as it decays), so there is
 * still not a single audio file in the repository.
 *
 * WHY a compressor and a limiter in front of the destination: a level-complete fanfare landing on
 * top of a portal hum, a heartbeat and four footsteps sums past 0 dBFS (measured: 1.32 on a
 * 60-event burst) and clips audibly on laptop speakers. The compressor rides the level so cues can
 * stay lively; the tanh limiter behind it makes a sample above 1.0 arithmetically impossible.
 *
 * WHY buses: `setVolume(volume, music)` must move music independently of SFX, and the phase of the
 * game ducks music (paused, game over) without touching cue levels.
 *
 * ## Invariants
 * - **Never throws.** Every public method has a guard; a missing/blocked `AudioContext` degrades
 *   the whole object to a silent no-op that still satisfies the interface.
 * - **Lazy.** No `AudioContext` is constructed until `unlock()` is called from a user gesture.
 *   Constructing one earlier makes Chrome print an autoplay warning — console noise we refuse.
 * - **Bounded.** At most `maxVoices` one-shot voices exist at once (default 24). Voices are a
 *   pre-allocated pool; a new sound that cannot find a free slot steals the voice that is closest
 *   to finishing, and only from a lower priority — or from an equal one that would have finished
 *   first. A stolen voice is faded over ~8 ms (`AUDIO.STEAL_FADE`) rather than cut, so stealing
 *   cannot click.
 * - **Leak-free.** Every voice disconnects all of its nodes on `ended`, and a per-frame reap
 *   releases any voice whose scheduled end time has passed (belt and braces: `onended` does not
 *   fire while a context is suspended) and disposes the short-lived tails of stolen voices.
 * - **One sound per action.** Several paths can answer the same input (the menus blip *and* the
 *   resulting phase change), so the phase handler defers to a menu blip it can see (`uiAnswered`).
 * - **Allocation-free per frame.** `update()` touches only numbers and pre-allocated objects; it
 *   allocates nothing unless it actually schedules a new sound (music pluck / heartbeat), which
 *   happens at most a few times per second. Voice stealing reuses a fixed ring of retiring slots,
 *   and the phrase engine plays from pre-allocated typed arrays.
 * - **Audible on small speakers.** Phone speakers roll off below ~250 Hz and laptops below ~150 Hz,
 *   so every body cue (heartbeat, bump, footstep) pairs its low thump with a transient or harmonic
 *   above 200 Hz. A gameplay warning that only exists at 40–68 Hz does not exist on a phone.
 * - **In key.** Every pitched cue that sounds over the ambience (gem ladder, bell, fanfare, record
 *   chord) is derived from the current level key, so nothing rubs against the drone.
 *
 * ## Units
 * - All times are **seconds on the `AudioContext` clock** (`ctx.currentTime`), never wall clock.
 * - Frequencies are Hz, gains are linear amplitude (pre-master), `tc` values are `setTargetAtTime`
 *   time constants in seconds (~3·tc to reach the target).
 *
 * Allowed imports per §2: `src/core` only.
 */

import { clamp, clamp01, lerp } from '../core/math.js';
import { createRng, randomSeed } from '../core/rng.js';
import { createLogger } from '../core/log.js';

/** @typedef {import('../core/types.js').GameEvent} GameEvent */
/** @typedef {import('../core/types.js').GameState} GameState */
/** @typedef {import('../core/types.js').Phase} Phase */
/** @typedef {import('../core/types.js').Rng} Rng */

/**
 * A minimal structural view of the WebAudio surface this module uses. Typed loosely on purpose:
 * the module is written to survive partial implementations (and test fakes) that are missing
 * optional pieces such as `createStereoPanner` or `exponentialRampToValueAtTime`.
 * @typedef {any} AnyNode
 * @typedef {any} AnyParam
 * @typedef {any} AnyCtx
 */

/**
 * @typedef {Object} AudioOptions
 * @property {() => AnyCtx|null} [contextFactory]  builds the AudioContext; return null when
 *   unavailable. Default: `new (AudioContext||webkitAudioContext)({latencyHint:'interactive'})`.
 * @property {Document|{addEventListener:Function,removeEventListener:Function,hidden?:boolean}|null} [doc]
 *   document used for the hidden/visible + first-gesture listeners. Default: global `document`
 *   when present; pass `null` to disable both.
 * @property {number} [volume]      master volume 0..1 (default 0.8, matches Settings.volume)
 * @property {number} [music]       music volume 0..1 (default 0.55, matches Settings.music)
 * @property {number} [maxVoices]   concurrent one-shot voices, clamped 4..64 (default 24)
 * @property {number} [seed]        RNG seed for the noise buffer and generative music
 * @property {boolean} [autoUnlock] attach one-shot gesture listeners that call `unlock()`
 *   themselves (default true when a document is available)
 */

/**
 * @typedef {Object} AudioStats
 * @property {number} voices     live one-shot voices
 * @property {number} maxVoices  pool capacity
 * @property {number} stolen     voices stolen since boot (a tuning signal: steady growth = cap too low)
 * @property {number} dropped    sounds dropped because no voice could be stolen
 * @property {number} time       `ctx.currentTime` in seconds (0 before unlock)
 * @property {number} failures   internal errors swallowed since boot
 * @property {string} state      'absent' | 'suspended' | 'running' | 'closed' | 'failed'
 */

/**
 * @typedef {Object} Audio
 * @property {() => boolean} unlock                 idempotent; true once the context is running
 * @property {(events: ReadonlyArray<GameEvent>|null|undefined, state: GameState|null|undefined) => void} handle
 * @property {(state: GameState|null|undefined) => void} update
 * @property {(volume: number, music?: number) => void} setVolume
 * @property {(kind: 'move'|'confirm'|'back') => void} playUi
 * @property {() => void} suspend
 * @property {() => void} resume
 * @property {() => void} dispose
 * @property {() => AudioStats} stats                REUSED object — copy fields you keep
 * @property {boolean} unlocked                      (getter) context exists and is not suspended
 * @property {boolean} available                     (getter) audio can still make sound
 */

const log = createLogger('audio');

/**
 * Synthesis tuning. These live here rather than in `src/state/balance.js` because `src/ui` may not
 * import `src/state` (§2); they are audio-internal constants, not gameplay balance.
 */
export const AUDIO = Object.freeze({
  /** Length of the shared white-noise buffer, seconds. Long enough that loops are inaudible. */
  NOISE_SECONDS: 2,
  /** Scheduling safety margin: never schedule exactly at `currentTime` (causes clicks). */
  LEAD: 0.008,
  /**
   * Resting gain of the ambient drone, and how much of itself the nearest awake creature adds to it
   * (New Descent, §4.11). 1.4 is loud enough to be felt under a fight and quiet enough that it is
   * never mistaken for a cue with a meaning of its own.
   */
  DRONE_GAIN: 0.11,
  THREAT_SWELL: 1.4,
  /** Look-ahead window for the generative scheduler, seconds. */
  LOOKAHEAD: 0.3,
  /** Master compressor. Transparent until cues stack up. */
  COMP: Object.freeze({ threshold: -16, knee: 22, ratio: 3.5, attack: 0.004, release: 0.22 }),
  /**
   * Soft-clip knee of the final limiter: `y = tanh(k·x)/k`. Unity gain for quiet signals, hard
   * ceiling at `tanh(k)/k` (≈0.70 at k=1.2) for anything the compressor's 4 ms attack lets through.
   */
  LIMIT_K: 1.2,
  /** Perceptual curve applied to the 0..1 volume sliders (equal-ish loudness steps). */
  VOLUME_EXP: 1.7,
  /**
   * Footstep gain at a crawl vs. at a full stride. Pre-filter amplitudes: a band-pass on white
   * noise throws most of the energy away, so these sit higher than they look.
   */
  STEP_GAIN: Object.freeze({ min: 0.22, max: 0.46 }),
  /**
   * Speeds (tiles/s) that map to STEP_GAIN.min / max. The top mirrors balance.js `WALK_SPEED` (3.2):
   * there is no sprint any more (§1), so a full stride is the loudest step.
   */
  STEP_SPEED: Object.freeze({ min: 1, max: 3.2 }),
  /** Seconds between gems that still counts as a combo (audio-side, purely cosmetic). */
  COMBO_WINDOW: 1.6,
  /** Highest combo step that still raises the arpeggio (one pentatonic scale step per combo). */
  COMBO_MAX: 7,
  /**
   * Heartbeat period (seconds) at the low-fuel threshold and at empty, plus the fuel fraction the
   * urgency curve is measured against.
   * `lowFraction` **mirrors `balance.js` FUEL.LOW_FRACTION** (§2 forbids `src/ui` importing
   * `src/state`) — retune both together, or the beat reaches maximum urgency at the wrong moment.
   */
  HEART: Object.freeze({ slow: 1.15, fast: 0.44, split: 0.26, lowFraction: 0.25 }),
  /** Portal hum: gain and filter cutoff at `nearExit` 0 → 1, and how far it pans off-centre. */
  PORTAL: Object.freeze({ gain: 0.21, cutMin: 170, cutMax: 1500, pan: 0.8 }),
  /** Torch fire bed: constant hiss level and the gap between crackle pops, seconds. */
  TORCH: Object.freeze({ bed: 0.016, gapMin: 0.07, gapMax: 0.5 }),
  /**
   * Generative music. `root`/`droneHz` are the level-1 key (A); deeper levels transpose both by
   * `MUSIC_KEYS` and scale the phrase gaps (see `PHRASE`) toward `gapFloor`, reaching the floor at
   * `depthSpan`. `depthSpan` is approximately the level the maze stops growing — being a level out
   * changes nothing audible, so it is deliberately NOT a mirror of a gameplay constant.
   */
  MUSIC: Object.freeze({
    root: 220,
    droneHz: 55,
    depthSpan: 15,
    gapFloor: 0.55,
    droneCut: 320,
    droneCutFloor: 0.65,
  }),
  /**
   * Phrase engine for the generative line. `pulse` is the slow grid every onset sits on; a phrase
   * is a `motifMin..motifMax`-note motif moving by scale steps, notes 1..`noteMaxPulses` pulses
   * apart (the cadence note held `noteMaxPulses`), then a rest of `restMin..restMax` pulses scaled
   * by depth. Every `evolveEvery` phrases the motif itself mutates, so a 13-minute deep level is
   * never one loop. Degrees index the extended pentatonic above `root/2` (degree 5 = `root`).
   */
  PHRASE: Object.freeze({
    pulse: 0.75,
    motifMin: 4,
    motifMax: 7,
    noteMaxPulses: 3,
    restMin: 4,
    restMax: 8,
    evolveEvery: 4,
    degreeLo: 2,
    degreeHi: 13,
  }),
  /**
   * Synthetic reverb impulse responses: tail length (RT60-ish, seconds), a one-pole damping
   * coefficient that closes further as the tail decays (0..1, higher = darker), the pre-delay and
   * the energy the IR is normalised to (≈ the old echo loop's gain, so wet levels stay put).
   */
  REVERB: Object.freeze({
    sfx: Object.freeze({ seconds: 1.3, damp: 0.35, dampEnd: 0.8, pre: 0.011, energy: 1.0 }),
    music: Object.freeze({ seconds: 2.2, damp: 0.5, dampEnd: 0.88, pre: 0.02, energy: 1.25 }),
  }),
  /**
   * Error budget: audio switches itself off only if `burst` internal errors land within `window`
   * seconds. Isolated failures spread over a long run decay instead of adding up to a silent game.
   */
  FAIL: Object.freeze({ burst: 12, window: 10 }),
  /** How far a stolen voice is faded before it is cut, seconds (see `fadeSteal`). */
  STEAL_FADE: 0.008,
  /**
   * A UI blip inside this window counts as "the menus already answered that action", so the phase
   * handler stays quiet instead of flamming a second identical square figure on top of it.
   */
  UI_ECHO: 0.25,
  /**
   * Map-scroll cue (§4.8): parchment crackles in the rustle, when the chime enters after the cue
   * starts (seconds), and the shortest gap between two map cues (seconds).
   */
  MAP: Object.freeze({ crackles: 4, chimeAt: 0.2, minGap: 0.5 }),
  /** Smoothing time constants for the continuously-driven parameters. */
  TC: Object.freeze({ mix: 0.05, portal: 0.14, music: 0.6, key: 0.45 }),
});

/** One octave of the minor pentatonic, in semitones. Degrees above 4 wrap into higher octaves. */
const PENTATONIC = Object.freeze([0, 3, 5, 7, 10]);

/**
 * Semitones above the scale origin for a (possibly negative) pentatonic degree.
 * @param {number} degree integer
 * @returns {number}
 */
function degreeSemis(degree) {
  const oct = Math.floor(degree / 5);
  return PENTATONIC[degree - oct * 5] + 12 * oct;
}

/**
 * The key each depth is played in, semitones from the level-1 root (A). One 10-note bag in one
 * register for the ~13 minutes a deep level runs is the length at which any generative line starts
 * to sound like a loop, so the whole ambience — drone, portal, plucks and the descent bell —
 * transposes every level: A → G → C → E → A… Level 1 keeps the shipped A so the game still opens
 * on the sound it was tuned with, and the rotation is bounded (never a running descent) so the
 * drone cannot walk off the bottom of the spectrum over a 30-level run.
 */
const MUSIC_KEYS = Object.freeze([0, -2, 3, -5]);

/** Level-start bell, Hz: A5 · E5 · C5 · A4 — a minor triad falling into the dark (key at level 1). */
const BELL_NOTES = Object.freeze([880, 659.25, 523.25, 440]);
/** Level-complete run-up, Hz: C5 · E5 · G5 · C6. */
const FANFARE_ARP = Object.freeze([523.25, 659.25, 783.99, 1046.5]);
/** …resolving onto a held C-major triad. */
const FANFARE_CHORD = Object.freeze([523.25, 659.25, 783.99]);
/**
 * The "you beat your own record" chord that follows the game-over snuff: C5 · E5 · G5, rising —
 * the relative major of the level-1 key, transposed with the key like the fanfare.
 */
const NEW_BEST_TRIAD = Object.freeze([523.25, 659.25, 783.99]);

/**
 * Voice priorities. A new sound may only steal a voice of equal or lower priority, and at *equal*
 * priority only one that finishes sooner than the newcomer (see `acquireVoice`).
 * `AMBIENT` exists so the torch crackle — scheduled several times a second by `update()` — sits
 * below the music plucks it used to share a rank with and can never truncate a 2.6 s note.
 */
const PRI = Object.freeze({ AMBIENT: 0, MUSIC: 1, STEP: 2, UI: 3, CUE: 4, STING: 5 });

/** Max WebAudio nodes a single voice may own. Keeps the pool's backing arrays fixed-size. */
const MAX_NODES = 8;

/** Semitone ratio helper — `2^(n/12)` without a `Math.pow` string table. */
function semitone(n) {
  return Math.pow(2, n / 12);
}

/**
 * Default context factory. Kept out of `createAudio` so it can be replaced wholesale in tests.
 * @returns {AnyCtx|null} null when the platform has no WebAudio at all
 */
function defaultContextFactory() {
  const g = /** @type {any} */ (globalThis);
  const Ctor = g.AudioContext || g.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  // 'interactive' asks for the smallest buffer the device will give us: footsteps that lag behind
  // the head bob by 40 ms read as broken.
  try {
    return new Ctor({ latencyHint: 'interactive' });
  } catch {
    return new Ctor();
  }
}

/**
 * Create the game's audio engine.
 *
 * The returned object is always valid: with no WebAudio (Node, locked-down browser, blocked
 * context) every method is a silent no-op and `available` is false.
 *
 * @param {AudioOptions} [options]
 * @returns {Audio}
 */
export function createAudio(options) {
  const opts = options && typeof options === 'object' ? options : {};

  const factory =
    typeof opts.contextFactory === 'function' ? opts.contextFactory : defaultContextFactory;
  const doc = resolveDoc(opts.doc);
  const maxVoices = Math.round(clamp(numberOr(opts.maxVoices, 24), 4, 64));
  const seed = Number.isFinite(opts.seed) ? /** @type {number} */ (opts.seed) >>> 0 : randomSeed();
  const autoUnlock = opts.autoUnlock !== false;

  /** @type {Rng} */
  const rng = createRng(seed);

  // ── Mixer state (mirrored in plain numbers so nothing needs to read back from WebAudio) ─────
  let volume = clamp01(numberOr(opts.volume, 0.8));
  let music = clamp01(numberOr(opts.music, 0.55));
  /** Music level factor from the game phase (0..1), smoothed into the bus. */
  let phaseMusic = 1;
  /** Extra music duck (0..1, 1 = no duck) that recovers over a second after a big sting. */
  let duck = 1;
  /** Last values actually written to the buses — lets update() skip redundant scheduling. */
  let lastMaster = -1;
  let lastMusic = -1;
  /**
   * The `Settings` values `update()` last adopted. WHY: the settings are the source of truth, but
   * only when they *change* — otherwise a direct `setVolume()` (a mute hotkey that has not been
   * written back to settings yet) would be undone by the very next frame.
   */
  let seenVolumeSetting = NaN;
  let seenMusicSetting = NaN;
  /** True once `setVolume()` was called explicitly — the very first observation then defers to it. */
  let volumeTouched = false;

  // ── Context & graph ─────────────────────────────────────────────────────────────────────────
  /** @type {AnyCtx|null} */
  let ctx = null;
  /** @type {AnyNode} */ let master = null;
  /** @type {AnyNode} */ let sfxBus = null;
  /** @type {AnyNode} */ let musicBus = null;
  /** @type {AnyNode} */ let sfxSend = null;
  /** @type {AnyNode} */ let musicSend = null;
  /** @type {AnyNode} */ let noiseBuffer = null;
  /** @type {AnyNode} */ let portalGain = null;
  /** @type {AnyNode} */ let portalFilter = null;
  /** @type {AnyNode} */ let portalPan = null;
  /** @type {AnyNode} */ let droneGain = null;
  /** @type {AnyNode} */ let droneTone = null;
  /** @type {AnyNode} */ let torchGain = null;
  /**
   * Frequency params that follow the level key, and their level-1 frequency in Hz (two parallel
   * flat arrays so `setDepth` retunes them without walking objects). The portal is in here too:
   * its fundamental is locked to the drone, so the two sustained lows can never drift into a beat.
   * @type {AnyParam[]}
   */
  const keyedParams = [];
  /** @type {number[]} */
  const keyedHz = [];
  /**
   * Always-on nodes (buses, hum, drone, fire bed). They live outside the voice pool, so teardown
   * has to disconnect them explicitly.
   * @type {AnyNode[]}
   */
  const persistent = [];

  /** True once the graph exists. */
  let built = false;
  /** True when audio is permanently off (no WebAudio, disposed, or too many internal errors). */
  let dead = false;
  /** Suspended because the document is hidden (distinct from "not yet unlocked"). */
  let hiddenSuspended = false;
  /** Suspended by an explicit `suspend()` call — the OS-interruption recovery must not undo it. */
  let userSuspended = false;
  /** Lifetime count of swallowed errors (telemetry only). */
  let failures = 0;
  /** Errors in the current burst window, and when that window opened (see `fail`). */
  let burstFailures = 0;
  let burstStart = NaN;
  let disposed = false;

  // ── Continuous-cue state ────────────────────────────────────────────────────────────────────
  let portalTarget = -1; // last written portal amount, -1 = never written
  let portalPanAt = 0; //  last written portal pan, -1..1
  let torchTarget = -1; // last written fire-bed amount
  let droneAt = -1; //    last written drone level
  let heartNext = 0; //  next heartbeat time on the ctx clock (0 = disarmed)
  let pluckNext = 0; //  next music pluck time on the ctx clock
  let crackleNext = 0; // next torch crackle time on the ctx clock
  let comboCount = 0;
  let comboUntil = 0; //  ctx time at which the gem combo lapses
  let lastStepAt = -1; //  rate limit so a stuck footstep event storm cannot machine-gun
  let lastMapAt = -Infinity; //  rate limit for the map-scroll cue (see `playMap`)
  let lastUpdateT = -1; // ctx time of the previous update(), -1 = never
  let lastUiSoundAt = -1; // ctx time of the last UI blip, whatever path played it
  let depthLevel = 0; //   level the ambience is currently keyed to (0 = never set)
  let musicKey = 1; //     frequency multiplier for that level's key
  let gapScale = 1; //     pluck-gap multiplier: deeper levels are denser

  // ── Phrase engine (generative line) ─────────────────────────────────────────────────────────
  /**
   * The level's motif (scale degrees) and its rhythm (pulses to the next note), plus the phrase
   * currently being played — a copy of the motif with this pass's variation applied. All fixed-size
   * typed arrays: generating or varying a phrase allocates nothing.
   */
  const MOTIF_CAP = 8;
  const motif = new Int8Array(MOTIF_CAP);
  const motifPulses = new Uint8Array(MOTIF_CAP);
  let motifLen = 0; //      0 = no motif yet (generated lazily on the first note)
  const phrase = new Int8Array(MOTIF_CAP);
  let phraseStep = 0; //    index of the next note in `phrase`
  let phraseCount = 0; //   phrases played since the motif was (re)generated
  let lastDegree = 7; //    previous note, so a new motif starts near where the line left off
  // ── Voice pool ──────────────────────────────────────────────────────────────────────────────
  /**
   * @typedef {Object} Voice
   * @property {boolean} active
   * @property {number} pri   PRI.*
   * @property {number} end   ctx time when the voice is finished and may be released
   * @property {number} n     nodes in use
   * @property {AnyNode[]} nodes fixed-length MAX_NODES backing store
   * @property {() => void} onended pre-bound release callback (no per-voice closure at runtime)
   */
  /** @type {Voice[]} */
  const voices = new Array(maxVoices);
  for (let i = 0; i < maxVoices; i++) {
    /** @type {Voice} */
    const v = {
      active: false,
      pri: 0,
      end: 0,
      n: 0,
      nodes: new Array(MAX_NODES).fill(null),
      onended: noop,
    };
    v.onended = () => releaseVoice(v);
    voices[i] = v;
  }
  let liveVoices = 0;
  let stolen = 0;
  let dropped = 0;
  /**
   * Nodes of stolen voices, still connected while their few-millisecond fade plays out. A fixed
   * ring of `maxVoices` slots (the first `retireCount` are in use), each with its own MAX_NODES
   * backing array, so a steal copies references instead of allocating; `reap` swap-removes.
   * @typedef {{nodes: AnyNode[], n: number, at: number}} RetireSlot
   * @type {RetireSlot[]}
   */
  const retiring = new Array(maxVoices);
  for (let i = 0; i < maxVoices; i++) {
    retiring[i] = { nodes: new Array(MAX_NODES).fill(null), n: 0, at: 0 };
  }
  let retireCount = 0;

  /** Reused stats object — §4.1 house style: never allocate for telemetry. */
  const statsOut = {
    voices: 0,
    maxVoices,
    stolen: 0,
    dropped: 0,
    time: 0,
    failures: 0,
    state: 'absent',
  };

  // ── Listeners ───────────────────────────────────────────────────────────────────────────────
  const onVisibility = () => {
    try {
      if (!ctx || dead) return;
      if (isHidden()) {
        hiddenSuspended = true;
        callSafe(ctx, 'suspend');
      } else if (hiddenSuspended) {
        hiddenSuspended = false;
        resumeContext();
      }
    } catch (err) {
      fail(err);
    }
  };
  const onGesture = () => {
    unlock();
  };
  let gestureAttached = false;

  /**
   * The context changed state on its own. WHY: iOS Safari moves a running context to
   * 'interrupted' on a phone call or Siri, and any platform can suspend it on an audio-device
   * change — while the page stays visible. The gesture listeners are long gone by then, so without
   * this the game would stay silent until a reload. Re-arm them (a resume usually needs a fresh
   * gesture) and try a resume straight away in case the platform allows it.
   */
  const onStateChange = () => {
    try {
      if (!ctx || dead) return;
      if (isRunning()) {
        detachGestures();
        return;
      }
      if (ctx.state === 'closed' || isHidden() || hiddenSuspended || userSuspended) return;
      attachGestures();
      resumeContext();
    } catch (err) {
      fail(err);
    }
  };

  if (doc) addListener(doc, 'visibilitychange', onVisibility);
  attachGestures();

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Error handling
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Swallow an internal error. Recorded once in the core ring buffer (the logger collapses
   * repeats), and after a *burst* of failures — `AUDIO.FAIL.burst` within `AUDIO.FAIL.window`
   * seconds — audio switches itself off for good rather than limping along. WHY a window and not
   * a lifetime total: a handful of rare transient failures over a 30-level run must not add up to
   * a silent game; only something failing every frame should.
   * @param {unknown} err
   */
  function fail(err) {
    failures++;
    log.error('audio error', err);
    const t = failClock();
    if (!(Math.abs(t - burstStart) <= AUDIO.FAIL.window)) {
      burstStart = t;
      burstFailures = 0;
    }
    burstFailures++;
    if (burstFailures >= AUDIO.FAIL.burst && !dead) {
      dead = true;
      teardown();
    }
  }

  /**
   * Seconds for the failure window: the audio clock when there is one (deterministic in tests),
   * wall clock otherwise.
   * @returns {number}
   */
  function failClock() {
    const t = ctx ? ctx.currentTime : NaN;
    if (typeof t === 'number' && Number.isFinite(t)) return t;
    const perf = /** @type {any} */ (globalThis).performance;
    return (perf && typeof perf.now === 'function' ? perf.now() : Date.now()) / 1000;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // WebAudio helpers — every one tolerates a partial implementation
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /** @returns {number} the earliest safe scheduling time */
  function now() {
    const t = ctx ? ctx.currentTime : 0;
    return (typeof t === 'number' && Number.isFinite(t) ? t : 0) + AUDIO.LEAD;
  }

  /** @param {AnyNode} a @param {AnyNode} b */
  function connect(a, b) {
    if (a && b && typeof a.connect === 'function') a.connect(b);
  }

  /** @param {AnyParam} p @param {number} v @param {number} t */
  function pSet(p, v, t) {
    if (!p) return;
    if (typeof p.setValueAtTime === 'function') p.setValueAtTime(v, t);
    else p.value = v;
  }

  /** Linear ramp with an implicit anchor — callers always `pSet` first. */
  function pLin(p, v, t) {
    if (!p) return;
    if (typeof p.linearRampToValueAtTime === 'function') p.linearRampToValueAtTime(v, t);
    else p.value = v;
  }

  /**
   * Exponential ramp. WebAudio forbids 0 (and sign changes), so the target is floored at a value
   * that is inaudible anyway; envelopes therefore end with a tiny DC offset which the following
   * `stop()` removes.
   */
  function pExp(p, v, t) {
    if (!p) return;
    const safe = v > 1e-4 ? v : 1e-4;
    if (typeof p.exponentialRampToValueAtTime === 'function') {
      p.exponentialRampToValueAtTime(safe, t);
    } else p.value = safe;
  }

  /** @param {AnyParam} p @param {number} v @param {number} t @param {number} tc */
  function pTarget(p, v, t, tc) {
    if (!p) return;
    if (typeof p.setTargetAtTime === 'function') p.setTargetAtTime(v, t, tc);
    else p.value = v;
  }

  /**
   * @param {number} v initial gain
   * @returns {AnyNode}
   */
  function newGain(v) {
    const g = ctx.createGain();
    pSet(g.gain, v, now());
    return g;
  }

  /**
   * @param {string} type biquad type
   * @param {number} freq Hz
   * @param {number} [q]
   * @returns {AnyNode}
   */
  function newFilter(type, freq, q) {
    const f = ctx.createBiquadFilter();
    try {
      f.type = type;
    } catch {
      /* some fakes expose `type` as read-only — the routing is what matters */
    }
    pSet(f.frequency, freq, now());
    if (q !== undefined) pSet(f.Q, q, now());
    return f;
  }

  /**
   * @param {string} type oscillator type
   * @param {number} freq Hz
   * @returns {AnyNode}
   */
  function newOsc(type, freq) {
    const o = ctx.createOscillator();
    try {
      o.type = type;
    } catch {
      /* ignore — see newFilter */
    }
    pSet(o.frequency, freq, now());
    return o;
  }

  /**
   * A looping white-noise source. One shared buffer, random read offset per voice so repeated
   * bursts never sound identical.
   * @returns {AnyNode}
   */
  function newNoise() {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer;
    s.loop = true;
    return s;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Voice pool
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Reserve a voice.
   *
   * WHY stealing by *soonest end* rather than oldest start: the voice closest to silence is the
   * one whose truncation is least audible, so the engine degrades gracefully under load instead
   * of chopping the sound the player is currently listening to.
   *
   * WHY the equal-priority guard: "soonest end" alone compares the candidates with each other but
   * never with the newcomer, so a 0.03 s torch crackle could evict a 2.6 s music pluck of the same
   * rank and cut two seconds of tail. At equal priority a sound may only displace one that would
   * have finished *before it does*; anything longer is left alone and the request is dropped.
   *
   * @param {number} pri PRI.*
   * @param {number} end ctx time the sound is done
   * @returns {Voice|null} null when the request must be dropped
   */
  function acquireVoice(pri, end) {
    for (let i = 0; i < maxVoices; i++) {
      const v = voices[i];
      if (!v.active) return startVoice(v, pri, end);
    }
    /** @type {Voice|null} */
    let victim = null;
    for (let i = 0; i < maxVoices; i++) {
      const v = voices[i];
      if (v.pri > pri) continue;
      if (v.pri === pri && v.end > end) continue; // never trade a long note for a short one
      if (victim === null || v.end < victim.end) victim = v;
    }
    if (victim === null) {
      dropped++;
      return null;
    }
    stolen++;
    releaseVoice(victim, now());
    return startVoice(victim, pri, end);
  }

  /** @param {Voice} v @param {number} pri @param {number} end @returns {Voice} */
  function startVoice(v, pri, end) {
    v.active = true;
    v.pri = pri;
    v.end = end;
    v.n = 0;
    liveVoices++;
    return v;
  }

  /**
   * Hand a node to the voice so it is stopped and disconnected on release.
   *
   * `nodes[0]` is by convention the voice's **head gain** — the one node every cue owns and the one
   * `fadeSteal` ramps. Both primitives create it first; a future cue must do the same.
   * @template T
   * @param {Voice} v
   * @param {T} node
   * @returns {T} the same node, for chaining
   */
  function own(v, node) {
    if (v.n < MAX_NODES) {
      v.nodes[v.n++] = node;
    } else {
      // A dropped node is never stopped or disconnected — i.e. exactly the leak this module
      // promises not to have. Unreachable with the shipped cues (the widest uses 6 of 8); it is
      // recorded loudly so that *adding* a partial or a panner cannot leak silently.
      log.error('voice node overflow: a cue needs more than MAX_NODES nodes');
    }
    return node;
  }

  /**
   * Stop and disconnect everything the voice owns. Idempotent: `onended` and the per-frame reap
   * both call it, and a stolen voice is released before it is reused.
   * @param {Voice} v
   * @param {number} [fadeAt] set only when the voice is being **stolen**: instead of cutting the
   *   waveform dead (a click, because the sample jumps to 0 from wherever the envelope was), the
   *   head gain is ramped to silence over ~8 ms and the nodes are handed to `retiring` for the
   *   reap a few milliseconds later.
   */
  function releaseVoice(v, fadeAt) {
    if (!v.active) return;
    v.active = false;
    liveVoices--;
    if (fadeAt !== undefined && v.n > 0 && fadeSteal(v, fadeAt)) {
      v.n = 0;
      return;
    }
    disposeNodes(v.nodes, v.n);
    v.n = 0;
  }

  /**
   * Stop, unhook and disconnect a run of nodes. The array slots are nulled so a pooled voice never
   * keeps a WebAudio node alive after it is done with it.
   * @param {AnyNode[]} nodes
   * @param {number} n how many entries are in use
   * @param {number} [stopAt] explicit stop time; omitted = stop immediately
   */
  function disposeNodes(nodes, n, stopAt) {
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      nodes[i] = null;
      if (!node) continue;
      try {
        if (typeof node.stop === 'function') {
          if (stopAt === undefined) node.stop();
          else node.stop(stopAt);
        }
      } catch {
        /* already stopped, or never started — both are fine */
      }
      try {
        node.onended = null;
      } catch {
        /* read-only onended on an exotic implementation */
      }
      try {
        if (typeof node.disconnect === 'function') node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }

  /**
   * Fade a stolen voice out instead of cutting it. The nodes must stay connected for the length of
   * the ramp, so they cannot be disconnected here — they move to `retiring` and the next `reap`
   * (or teardown) disposes them once their stop time has passed.
   * @param {Voice} v
   * @param {number} t ctx time the steal happens
   * @returns {boolean} false when the voice has no head gain to ramp (caller cuts it instead)
   */
  function fadeSteal(v, t) {
    const head = v.nodes[0];
    const g = head ? head.gain : null;
    if (!g) return false;
    const stopAt = t + AUDIO.STEAL_FADE;
    try {
      // Hold whatever the envelope had reached, then slide to silence. `cancelAndHold` is the
      // exact tool; older implementations get cancel + an explicit anchor at the current value.
      if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(t);
      else {
        if (typeof g.cancelScheduledValues === 'function') g.cancelScheduledValues(t);
        pSet(g, typeof g.value === 'number' && g.value > 1e-4 ? g.value : 1e-4, t);
      }
      pExp(g, 1e-4, t + AUDIO.STEAL_FADE * 0.75);
    } catch {
      return false; // a param that refuses ramps: the hard cut is still correct, just clickier
    }
    // Bounded by construction: a steal storm cannot hold more than one pool's worth of tails. When
    // the ring is full the tail closest to done (its fade is ~8 ms long, so all of them are nearly
    // silent) is disposed to make room.
    if (retireCount === maxVoices) {
      let oldest = 0;
      for (let i = 1; i < retireCount; i++) {
        if (retiring[i].at < retiring[oldest].at) oldest = i;
      }
      retireOne(oldest);
    }
    const slot = retiring[retireCount++];
    slot.at = stopAt;
    slot.n = v.n;
    for (let i = 0; i < v.n; i++) {
      const node = v.nodes[i];
      slot.nodes[i] = node;
      v.nodes[i] = null;
      try {
        if (node) node.onended = null; // the voice is about to be reused: no late release
      } catch {
        /* read-only onended */
      }
      try {
        if (node && typeof node.stop === 'function') node.stop(stopAt);
      } catch {
        /* never started */
      }
    }
    return true;
  }

  /**
   * Dispose one retiring slot and swap-remove it (the last in-use slot takes its place), so the
   * ring never shifts or allocates.
   * @param {number} i index into `retiring`, < retireCount
   */
  function retireOne(i) {
    const slot = retiring[i];
    disposeNodes(slot.nodes, slot.n);
    slot.n = 0;
    const last = retireCount - 1;
    if (i !== last) {
      retiring[i] = retiring[last];
      retiring[last] = slot;
    }
    retireCount = last;
  }

  /**
   * Release voices whose scheduled end has passed. Required because `onended` does not fire while
   * the context is suspended (tab hidden) — without this a backgrounded tab would leak nodes.
   * @param {number} t ctx time
   */
  function reap(t) {
    // Walking down is safe with swap-remove: the slot moved into `i` was already visited.
    for (let i = retireCount - 1; i >= 0; i--) {
      if (retiring[i].at <= t) retireOne(i);
    }
    if (liveVoices === 0) return;
    for (let i = 0; i < maxVoices; i++) {
      const v = voices[i];
      if (v.active && v.end <= t) releaseVoice(v);
    }
  }

  /**
   * Start a source and wire its lifetime to the voice.
   * @param {Voice} v
   * @param {AnyNode} src an OscillatorNode or AudioBufferSourceNode
   * @param {number} t start time
   * @param {number} stopAt stop time
   * @param {number} [offset] buffer read offset (noise only)
   */
  function fire(v, src, t, stopAt, offset) {
    try {
      src.onended = v.onended;
    } catch {
      /* ignore */
    }
    if (typeof src.start === 'function') {
      if (offset !== undefined) src.start(t, offset);
      else src.start(t);
    }
    if (typeof src.stop === 'function') src.stop(stopAt);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Graph construction
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Build the fixed mixer graph plus the three always-on generators (portal hum, torch flame,
   * music drone). Called once, from the first successful `unlock()`.
   * @returns {boolean} false when the graph could not be built
   */
  function buildGraph() {
    const comp = keep(ctx.createDynamicsCompressor());
    pSet(comp.threshold, AUDIO.COMP.threshold, 0);
    pSet(comp.knee, AUDIO.COMP.knee, 0);
    pSet(comp.ratio, AUDIO.COMP.ratio, 0);
    pSet(comp.attack, AUDIO.COMP.attack, 0);
    pSet(comp.release, AUDIO.COMP.release, 0);

    // Final safety net. The compressor's 4 ms attack lets a transient through when a dozen cues
    // land on the same frame (measured: 1.32 peak on a 60-event stress burst), and a sample above
    // 1.0 is a hard digital click on the way out. tanh soft-clips it with no audible effect below
    // the knee. Optional: a context without createWaveShaper simply keeps the compressor's output.
    const limiter = buildLimiter();
    if (limiter) {
      connect(comp, keep(limiter));
      connect(limiter, ctx.destination);
    } else {
      connect(comp, ctx.destination);
    }

    master = keep(newGain(0));
    connect(master, comp);

    sfxBus = keep(newGain(1));
    connect(sfxBus, master);
    musicBus = keep(newGain(0));
    connect(musicBus, master);

    // One reverb per bus, so muting music also mutes its tails. The SFX room is short and fairly
    // bright (stone corridor); the music hall is longer and darker so the plucks bloom behind it.
    sfxSend = buildReverb(sfxBus, AUDIO.REVERB.sfx);
    musicSend = buildReverb(musicBus, AUDIO.REVERB.music);

    noiseBuffer = buildNoiseBuffer();

    buildPortal();
    buildTorch();
    buildDrone();

    lastMaster = -1;
    lastMusic = -1;
    applyMix(now(), 0.001); // snap to the current slider values, no fade-in ramp on boot
    return true;
  }

  /**
   * Build the tanh soft-clipper. The curve is generated once (2049 points, odd so that 0 maps
   * exactly to 0 and no DC offset is introduced).
   * @returns {AnyNode|null} null when the context has no WaveShaper
   */
  function buildLimiter() {
    if (typeof ctx.createWaveShaper !== 'function') return null;
    const ws = ctx.createWaveShaper();
    const n = 2049;
    const curveData = new Float32Array(n);
    const k = AUDIO.LIMIT_K;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1; // -1 … 1
      curveData[i] = Math.tanh(k * x) / k;
    }
    ws.curve = curveData;
    try {
      ws.oversample = '4x'; // the knee generates harmonics; oversampling keeps them from aliasing
    } catch {
      /* optional property */
    }
    return ws;
  }

  /**
   * A diffuse room: one `ConvolverNode` fed a synthetic impulse response (see `buildImpulse`).
   * A few hundred thousand floats built once at unlock; the convolver then runs on the browser's
   * own optimised (and, for long tails, background-threaded) path.
   *
   * Fallback for a context with no `createConvolver`: a damped feedback delay. It is an echo rather
   * than a room, but a dry game would be worse, and no shipping browser takes this path.
   * @param {AnyNode} bus destination bus (the return lands here, so the bus gain rules the tail)
   * @param {{seconds:number, damp:number, dampEnd:number, pre:number, energy:number}} spec
   * @returns {AnyNode} the send node callers connect voices into
   */
  function buildReverb(bus, spec) {
    const send = keep(newGain(1));
    if (typeof ctx.createConvolver === 'function' && typeof ctx.createBuffer === 'function') {
      const conv = keep(ctx.createConvolver());
      try {
        conv.normalize = false; // the IR carries its own calibrated energy; must precede `buffer`
      } catch {
        /* optional property */
      }
      conv.buffer = buildImpulse(spec);
      connect(send, conv);
      connect(conv, bus);
      return send;
    }
    const delay = keep(ctx.createDelay(1));
    pSet(delay.delayTime, spec.seconds * 0.12, 0);
    const fb = keep(newGain(0.4));
    const tone = keep(newFilter('lowpass', 2200, 0.7));
    connect(send, delay);
    connect(delay, tone);
    connect(tone, fb);
    connect(fb, delay); // the loop
    connect(tone, bus); // the return
    return send;
  }

  /**
   * Synthesise a stereo room impulse response.
   *
   * - **Pre-delay** of a few ms of silence, so the dry hit stays distinct from its room.
   * - **Early reflections:** six sparse taps at mutually prime millisecond offsets, alternating
   *   sides — the "walls close by" cue a stone corridor has and a smooth noise tail lacks.
   * - **Diffuse tail:** independent white noise per channel (decorrelated L/R is what makes it
   *   wide), under an exponential envelope reaching -60 dB at `seconds`, through a one-pole low-pass
   *   whose coefficient slides from `damp` to `dampEnd`: stone absorbs highs faster than lows, so the
   *   tail darkens as it decays instead of hissing out.
   * - Scaled so the IR's total energy (per channel) is `energy`: the wet level is a tuning number,
   *   independent of length and sample rate.
   *
   * Uses its own RNG stream (seeded from the module seed) so building the IR does not shift the
   * sequence the music and noise draw from.
   * @param {{seconds:number, damp:number, dampEnd:number, pre:number, energy:number}} spec
   * @returns {AnyNode} an AudioBuffer
   */
  function buildImpulse(spec) {
    const sr = Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : 44100;
    const len = Math.max(2, Math.floor(sr * spec.seconds));
    const buf = ctx.createBuffer(2, len, sr);
    const irRng = createRng((seed ^ 0x5eed1e55) >>> 0);
    const pre = Math.min(len - 1, Math.floor(sr * spec.pre));
    // ln(1000) = 6.9: amplitude reaches 1/1000 (-60 dB) at the end of the buffer.
    const decay = 6.907755 / Math.max(1, len - pre);
    /** Early reflection offsets (ms after the pre-delay) and gains. */
    const ER_MS = [7, 11, 17, 23, 31, 41];
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      let lp = 0;
      let energy = 0;
      for (let i = pre; i < len; i++) {
        const k = (i - pre) / (len - pre);
        const a = lerp(spec.damp, spec.dampEnd, k);
        lp = lp * a + (irRng.next() * 2 - 1) * (1 - a);
        // The tail swells in over ~25 ms behind the early reflections instead of starting at full.
        const onset = Math.min(1, (i - pre) / (sr * 0.025));
        const v = lp * Math.exp(-decay * (i - pre)) * onset;
        data[i] = v;
        energy += v * v;
      }
      // A single-sample tap carries almost no energy next to a 50 000-sample tail, so the taps are
      // sized against the tail's RMS-over-its-effective-length rather than as absolute numbers:
      // each one stands a few times above the noise around it, which is what makes it read as a wall.
      const tailRms = Math.sqrt(energy * 2 * decay);
      for (let e = 0; e < ER_MS.length; e++) {
        const at = pre + Math.floor((ER_MS[e] * sr) / 1000) + c * Math.floor(sr * 0.0013);
        if (at >= len) continue;
        const sign = (e + c) % 2 === 0 ? 1 : -1;
        const tap = sign * (4 - e * 0.5) * tailRms;
        const before = data[at];
        data[at] = before + tap;
        energy += data[at] * data[at] - before * before;
      }
      const scale = energy > 0 ? Math.sqrt(spec.energy / energy) : 0;
      for (let i = 0; i < len; i++) data[i] *= scale;
    }
    return buf;
  }

  /**
   * Shared white noise. Deterministic from the module seed so a seeded run is byte-identical —
   * useful when comparing recordings between machines.
   * @returns {AnyNode}
   */
  function buildNoiseBuffer() {
    const sr = Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : 44100;
    const len = Math.max(1, Math.floor(sr * AUDIO.NOISE_SECONDS));
    const buf = ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = rng.next() * 2 - 1;
    return buf;
  }

  /**
   * The exit portal hum: two detuned saws plus an octave, through a low-pass that opens as the
   * player approaches. Always running (three oscillators cost ~nothing) with the gain parked at 0,
   * because starting/stopping it would click and would need its own state machine.
   *
   * WHY the fundamental is an octave above the music drone: the hum and the drone are the only two
   * *sustained* lows in the mix and they overlap at the loudest moment of the game (`nearExit` 1).
   * Anything but a simple ratio between them beats — the shipped 61.7 Hz sat 6.7 Hz above the
   * 55 Hz drone, which is not the "tritone-ish" unease its comment claimed but a slow throb inside
   * one critical band, i.e. mud. At 2:1 the hum fuses with the drone instead, and the unease is
   * carried by what it is actually made of: a detuned saw pair beating against *itself* at 0.66 Hz,
   * a filter that only opens as you close in, and the slow LFO wobble below.
   */
  function buildPortal() {
    portalGain = keep(newGain(0));
    portalFilter = keep(newFilter('lowpass', AUDIO.PORTAL.cutMin, 6));
    connect(portalFilter, portalGain);
    // Panning the hum gives it a direction: near the exit the player hears which side it is on.
    // It is the straight-line bearing *through walls* (the sim exposes no path), i.e. "where is it",
    // not "which corridor leads there" — honest for a portal you can hear through stone, and the
    // hum only blooms inside NEAR_EXIT_RANGE where the two rarely disagree for long.
    // Optional node — a context without StereoPanner just gets a centred hum.
    portalPan = typeof ctx.createStereoPanner === 'function' ? keep(ctx.createStereoPanner()) : null;
    if (portalPan) {
      connect(portalGain, portalPan);
      connect(portalPan, sfxBus);
    } else {
      connect(portalGain, sfxBus);
    }
    const mix = keep(newGain(0.34));
    connect(mix, portalFilter);

    const t = now();
    const base = AUDIO.MUSIC.droneHz * 2; // 110 Hz (A2) at level 1, and it follows the level key
    const a = keyed(keep(newOsc('sawtooth', base)), base);
    const b = keyed(keep(newOsc('sawtooth', base * 1.006)), base * 1.006); // beats at ~0.66 Hz
    const c = keyed(keep(newOsc('triangle', base * 2)), base * 2);
    connect(a, mix);
    connect(b, mix);
    connect(c, mix);
    startNode(a, t);
    startNode(b, t);
    startNode(c, t);

    // Slow filter wobble so a stationary player still hears the portal breathe.
    const lfo = keep(newOsc('sine', 0.19));
    const lfoAmt = keep(newGain(90));
    connect(lfo, lfoAmt);
    connect(lfoAmt, portalFilter.frequency);
    startNode(lfo, t);
  }

  /**
   * The torch the player is carrying: a quiet band-passed noise bed (the flame) that the sparse
   * crackle pops in `update()` sit on top of. Level follows the fuel, so a dying torch also
   * *sounds* thin — a second channel for the information the shrinking light radius carries.
   */
  function buildTorch() {
    torchGain = keep(newGain(0));
    const body = keep(newFilter('bandpass', 760, 0.55));
    connect(body, torchGain);
    connect(torchGain, sfxBus);
    const src = keep(newNoise());
    connect(src, body);
    const t = now();
    if (typeof src.start === 'function') src.start(t, rng.range(0, AUDIO.NOISE_SECONDS * 0.5));

    // Breathing flame: slow random-ish movement of the band, two LFOs at incommensurate rates so
    // the pattern never audibly repeats.
    const lfoA = keep(newOsc('sine', 0.31));
    const ampA = keep(newGain(180));
    connect(lfoA, ampA);
    connect(ampA, body.frequency);
    startNode(lfoA, t);
    const lfoB = keep(newOsc('sine', 0.073));
    const ampB = keep(newGain(90));
    connect(lfoB, ampB);
    connect(ampB, body.frequency);
    startNode(lfoB, t);
  }

  /**
   * Register an always-on node for teardown.
   * @template T
   * @param {T} node
   * @returns {T}
   */
  function keep(node) {
    persistent.push(node);
    return node;
  }

  /**
   * Register an always-on oscillator whose pitch follows the level key.
   * @template T
   * @param {T} node an oscillator
   * @param {number} hz its frequency in the level-1 key
   * @returns {T}
   */
  function keyed(node, hz) {
    keyedParams.push(/** @type {any} */ (node).frequency);
    keyedHz.push(hz);
    return node;
  }

  /**
   * Key the ambience to a depth: transpose the sustained layers, tighten the pluck gaps and darken
   * the drone's filter. Called from the `levelStart` event and from `update()` (whichever notices
   * the new level first); a repeat call for the same level does nothing.
   *
   * Everything glides over `TC.key` rather than jumping, so the key change lands under the descent
   * bell as "the dungeon shifting" instead of as an edit.
   * @param {number} level 1-based
   */
  function setDepth(level) {
    const lv = Number.isFinite(level) && level >= 1 ? Math.floor(level) : 1;
    if (lv === depthLevel) return;
    depthLevel = lv;
    musicKey = semitone(MUSIC_KEYS[(lv - 1) % MUSIC_KEYS.length]);
    const depth01 = clamp01((lv - 1) / Math.max(1, AUDIO.MUSIC.depthSpan - 1));
    // Deeper levels run longer, so the line has to arrive more often to cover the same minutes.
    gapScale = lerp(1, AUDIO.MUSIC.gapFloor, depth01);
    // A new depth gets a new motif (composed lazily on its first note, so no RNG is spent here).
    motifLen = 0;
    phraseStep = 0;
    if (!live()) return;
    const t = now();
    for (let i = 0; i < keyedParams.length; i++) {
      pTarget(keyedParams[i], keyedHz[i] * musicKey, t, AUDIO.TC.key);
    }
    if (droneTone) {
      pTarget(
        droneTone.frequency,
        AUDIO.MUSIC.droneCut * lerp(1, AUDIO.MUSIC.droneCutFloor, depth01),
        t,
        AUDIO.TC.key,
      );
    }
  }

  /** Low sustained drone under the generative plucks. */
  function buildDrone() {
    droneGain = keep(newGain(AUDIO.DRONE_GAIN));
    const tone = keep(newFilter('lowpass', AUDIO.MUSIC.droneCut, 0.8));
    droneTone = tone;
    connect(tone, droneGain);
    connect(droneGain, musicBus);

    const t = now();
    const root = AUDIO.MUSIC.droneHz;
    const a = keyed(keep(newOsc('sawtooth', root)), root);
    const b = keyed(keep(newOsc('sawtooth', root * 1.004)), root * 1.004);
    // 3:2 exactly. The equal-tempered fifth (2^(7/12) = 1.498307) is what used to be here under a
    // comment claiming just intonation; a drone is the one place the pure ratio is free, because
    // nothing modulates and the fifth's own second harmonic then lands exactly on the saws' third.
    const fifth = keyed(keep(newOsc('sine', root * 1.5)), root * 1.5);
    const mix = keep(newGain(0.3));
    connect(a, mix);
    connect(b, mix);
    connect(fifth, mix);
    connect(mix, tone);
    startNode(a, t);
    startNode(b, t);
    startNode(fifth, t);

    const lfo = keep(newOsc('sine', 0.045));
    const lfoAmt = keep(newGain(120));
    connect(lfo, lfoAmt);
    connect(lfoAmt, tone.frequency);
    startNode(lfo, t);
  }

  /** @param {AnyNode} node @param {number} t */
  function startNode(node, t) {
    if (typeof node.start === 'function') node.start(t);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Mixing
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Push the volume sliders, phase factor and duck into the buses.
   * Writes only when a value actually moved, so calling it every frame schedules nothing.
   * @param {number} t ctx time
   * @param {number} tc smoothing time constant, seconds
   */
  function applyMix(t, tc) {
    const m = curve(volume);
    if (Math.abs(m - lastMaster) > 0.0015) {
      pTarget(master.gain, m, t, tc);
      lastMaster = m;
    }
    const mus = curve(music) * phaseMusic * duck;
    if (Math.abs(mus - lastMusic) > 0.0015) {
      pTarget(musicBus.gain, mus, t, tc);
      lastMusic = mus;
    }
  }

  /** Perceptual slider curve: linear gain sliders feel dead in their upper half. */
  function curve(v) {
    return Math.pow(clamp01(v), AUDIO.VOLUME_EXP);
  }

  /** True when a cue would be inaudible anyway — skip the nodes entirely. */
  function silent() {
    return volume <= 0.0005;
  }

  /** @returns {boolean} the engine can schedule sound right now */
  function live() {
    return built && !dead && ctx !== null;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Sound primitives
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Insert a per-voice stereo panner in front of `bus`, or return the bus unchanged when the sound
   * is centred (the overwhelming majority) or the context has no `createStereoPanner`. One node,
   * owned by the voice, so it is disconnected with the rest of it.
   * @param {Voice} v
   * @param {AnyNode} bus
   * @param {number} pan -1..1
   * @param {number} t ctx time
   * @returns {AnyNode} what the voice's head gain should connect to
   */
  function panned(v, bus, pan, t) {
    if (!pan || !Number.isFinite(pan) || typeof ctx.createStereoPanner !== 'function') return bus;
    const p = own(v, ctx.createStereoPanner());
    pSet(p.pan, clamp(pan, -1, 1), t);
    connect(p, bus);
    return p;
  }

  /**
   * One synthesised tone with an attack/exponential-decay envelope and an optional pitch glide.
   * The workhorse behind bells, plucks, arpeggios and falling game-over tones.
   *
   * @param {string} type oscillator waveform
   * @param {number} f0 start frequency, Hz
   * @param {number} f1 end frequency, Hz (=== f0 for no glide)
   * @param {number} t start time (ctx clock)
   * @param {number} attack seconds to peak
   * @param {number} dur total seconds
   * @param {number} amp peak linear amplitude (pre-master)
   * @param {AnyNode} bus destination bus
   * @param {AnyNode|null} send reverb send for this bus, or null
   * @param {number} sendAmt 0..1 send level
   * @param {number} pri PRI.*
   * @param {number} [partial] extra partial as a frequency ratio (0 = none), e.g. 2.76 for a bell
   * @param {number} [partialAmp] amplitude of that partial relative to `amp`
   * @param {number} [pan] stereo position -1..1 (0 = centred, no panner node is created)
   * @returns {boolean} false when the sound was dropped (no voice available)
   */
  function tone(
    type,
    f0,
    f1,
    t,
    attack,
    dur,
    amp,
    bus,
    send,
    sendAmt,
    pri,
    partial = 0,
    partialAmp = 0.3,
    pan = 0,
  ) {
    const v = acquireVoice(pri, t + dur + 0.02);
    if (!v) return false;
    const g = own(v, newGain(0));
    connect(g, panned(v, bus, pan, t));
    if (send && sendAmt > 0) {
      const s = own(v, newGain(sendAmt));
      connect(g, s);
      connect(s, send);
    }
    const o = own(v, newOsc(type, f0));
    connect(o, g);
    if (f1 !== f0) {
      pSet(o.frequency, f0, t);
      pExp(o.frequency, f1, t + dur * 0.92);
    }
    if (partial > 0) {
      const o2 = own(v, newOsc('sine', f0 * partial));
      const g2 = own(v, newGain(partialAmp));
      connect(o2, g2);
      connect(g2, g);
      if (f1 !== f0) {
        pSet(o2.frequency, f0 * partial, t);
        pExp(o2.frequency, f1 * partial, t + dur * 0.92);
      }
      fire(v, o2, t, t + dur);
    }
    pSet(g.gain, 0, t);
    pLin(g.gain, amp, t + attack);
    pExp(g.gain, 0.0004, t + dur);
    fire(v, o, t, t + dur);
    return true;
  }

  /**
   * One filtered noise burst — footstep grit, whooshes, thuds, the torch snuff.
   *
   * @param {string} filterType 'bandpass' | 'lowpass' | 'highpass'
   * @param {number} f0 filter cutoff at the start, Hz
   * @param {number} f1 filter cutoff at the end, Hz
   * @param {number} q filter Q
   * @param {number} t start time
   * @param {number} attack seconds to peak
   * @param {number} dur total seconds
   * @param {number} amp peak amplitude
   * @param {AnyNode} bus
   * @param {AnyNode|null} send
   * @param {number} sendAmt
   * @param {number} pri
   * @param {number} [pan] stereo position -1..1 (0 = centred, no panner node is created)
   * @returns {boolean}
   */
  function noiseBurst(filterType, f0, f1, q, t, attack, dur, amp, bus, send, sendAmt, pri, pan = 0) {
    const v = acquireVoice(pri, t + dur + 0.02);
    if (!v) return false;
    const g = own(v, newGain(0));
    connect(g, panned(v, bus, pan, t));
    if (send && sendAmt > 0) {
      const s = own(v, newGain(sendAmt));
      connect(g, s);
      connect(s, send);
    }
    const f = own(v, newFilter(filterType, f0, q));
    connect(f, g);
    if (f1 !== f0) {
      pSet(f.frequency, f0, t);
      pExp(f.frequency, f1, t + dur * 0.9);
    }
    const src = own(v, newNoise());
    connect(src, f);
    pSet(g.gain, 0, t);
    pLin(g.gain, amp, t + attack);
    pExp(g.gain, 0.0004, t + dur);
    // Random read offset keeps repeated bursts from phasing into an obvious loop.
    fire(v, src, t, t + dur, rng.range(0, AUDIO.NOISE_SECONDS * 0.5));
    return true;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Cues
  //
  // Every cue is built from two primitives bound to the SFX bus: `sfx()` (a tone) and `sfxNoise()`
  // (a filtered noise burst). `send` is how much of the voice goes to the dungeon reverb.
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * `tone()` on the SFX bus.
   * @param {string} type @param {number} f0 @param {number} f1 @param {number} t
   * @param {number} attack @param {number} dur @param {number} amp @param {number} pri
   * @param {number} [send] 0..1 reverb send @param {number} [partial] @param {number} [partialAmp]
   * @param {number} [pan] -1..1
   * @returns {boolean}
   */
  function sfx(
    type,
    f0,
    f1,
    t,
    attack,
    dur,
    amp,
    pri,
    send = 0,
    partial = 0,
    partialAmp = 0.3,
    pan = 0,
  ) {
    const to = send > 0 ? sfxSend : null;
    return tone(type, f0, f1, t, attack, dur, amp, sfxBus, to, send, pri, partial, partialAmp, pan);
  }

  /**
   * `noiseBurst()` on the SFX bus.
   * @param {string} filterType @param {number} f0 @param {number} f1 @param {number} q
   * @param {number} t @param {number} attack @param {number} dur @param {number} amp
   * @param {number} pri @param {number} [send] 0..1 reverb send @param {number} [pan] -1..1
   * @returns {boolean}
   */
  function sfxNoise(filterType, f0, f1, q, t, attack, dur, amp, pri, send = 0, pan = 0) {
    const to = send > 0 ? sfxSend : null;
    return noiseBurst(filterType, f0, f1, q, t, attack, dur, amp, sfxBus, to, send, pri, pan);
  }

  /**
   * Footstep: a short band-passed grit burst plus a soft low thump for body weight.
   * Alternating feet get different centre frequencies so a walk cycle has a left/right feel, and
   * every step is detuned a few percent so a long corridor never turns into a drum machine.
   * @param {0|1} foot
   * @param {number} intensity 0 = crawl, 1 = full stride
   */
  function playFootstep(foot, intensity) {
    const t = now();
    // Hard rate limit: the sim emits one step per half bob cycle, but a pathological dt storm
    // must never turn that into a machine gun.
    if (t - lastStepAt < 0.08) return;
    lastStepAt = t;
    const amp = lerp(AUDIO.STEP_GAIN.min, AUDIO.STEP_GAIN.max, clamp01(intensity));
    const base = (foot === 0 ? 540 : 430) * rng.range(0.94, 1.07);
    const dur = lerp(0.1, 0.14, intensity);
    sfxNoise('bandpass', base, base * 0.55, 1.3, t, 0.005, dur, amp, PRI.STEP);
    // The thump carries a 2nd harmonic (164 → 108 Hz) so its weight survives a laptop speaker.
    sfx('sine', 82 * rng.range(0.95, 1.06), 54, t, 0.004, 0.1, amp * 0.5, PRI.STEP, 0, 2, 0.45);
  }

  /**
   * Wall bump: a low sine thud that sags, a dull noise body, and a short band-passed *slap* around
   * 650 Hz — the stone-contact transient, and the part of the cue a phone speaker can actually
   * play. Scales with the impact, so scraping a corner is a tap and running head-first into stone
   * is a wallop.
   * @param {number} strength 0..1 from the sim
   */
  function playBump(strength) {
    const s = clamp01(strength);
    const t = now();
    const amp = lerp(0.14, 0.46, s);
    // Inharmonic 2.3× partial: a knock on stone, not a tuned drum.
    sfx('sine', 126, 46, t, 0.004, lerp(0.18, 0.3, s), amp, PRI.CUE, 0.12, 2.3, 0.4);
    sfxNoise('lowpass', 420, 130, 0.9, t, 0.003, 0.13, amp * 0.5, PRI.CUE);
    // Band-passed white noise keeps only ~5 % of its power, hence the pre-filter gain above 1×.
    sfxNoise('bandpass', 700, 450, 0.8, t, 0.002, lerp(0.05, 0.08, s), amp * 2.2, PRI.CUE, 0.1);
  }

  /**
   * Frequency of a pentatonic degree in the current level key. Degree 0 is `root/2` (A3 at level 1),
   * degree 5 is `root`, degree 10 is `root·2`.
   * @param {number} degree integer, may be negative
   * @returns {number} Hz
   */
  function degreeHz(degree) {
    return AUDIO.MUSIC.root * 0.5 * musicKey * semitone(degreeSemis(degree));
  }

  /**
   * Gem pickup: a bright three-note arpeggio with an octave shimmer and a sparkle hiss, **in the
   * level key**. Degree 13 at level 1 is E5 (the chime this game shipped with); the figure is
   * `degree, degree+3, degree+5`, which from E spells C-major-over-E and from every other scale
   * step a fifth or a sixth plus the octave — always consonant, never outside the drone's scale.
   * Rapid successive pickups climb *one scale step* per combo, so sweeping a dead end plays a
   * rising pentatonic melody instead of the same chime nine times, or a whole-tone ladder that
   * leaves the key on its second rung.
   * @param {number} [pan] -1..1, where the gem was relative to the player's facing
   */
  function playGem(pan = 0) {
    const t = now();
    comboCount = t < comboUntil ? Math.min(comboCount + 1, AUDIO.COMBO_MAX) : 0;
    comboUntil = t + AUDIO.COMBO_WINDOW;
    const d = 13 + comboCount;
    const f0 = degreeHz(d);
    const f1 = degreeHz(d + 3);
    const f2 = degreeHz(d + 5);
    // The octave shimmer fades out as the ladder climbs, so a x7 combo does not turn to glass.
    const shimmer = lerp(0.22, 0.1, comboCount / AUDIO.COMBO_MAX);
    sfx('triangle', f0, f0, t, 0.004, 0.26, 0.17, PRI.CUE, 0.25, 2, shimmer, pan);
    sfx('triangle', f1, f1, t + 0.06, 0.004, 0.24, 0.15, PRI.CUE, 0.25, 2, shimmer * 0.9, pan);
    sfx('triangle', f2, f2, t + 0.12, 0.004, 0.34, 0.15, PRI.CUE, 0.3, 2, shimmer * 1.1, pan);
    sfxNoise('highpass', 5200, 9000, 0.7, t, 0.008, 0.22, 0.05, PRI.STEP, 0.2, pan);
  }

  /**
   * Oil flask: an upward noise sweep (the whoosh) over a warm rising tone (the refill).
   * @param {number} [pan] -1..1, where the flask was relative to the player's facing
   */
  function playOil(pan = 0) {
    const t = now();
    sfxNoise('bandpass', 320, 3600, 1.1, t, 0.09, 0.42, 0.2, PRI.CUE, 0.18, pan);
    sfx('triangle', 196, 294, t, 0.02, 0.5, 0.17, PRI.CUE, 0.22, 2, 0.18, pan);
    sfx('sine', 392, 587, t + 0.04, 0.03, 0.42, 0.08, PRI.CUE, 0, 0, 0.3, pan);
  }

  /**
   * Map scroll (§4.8): parchment unrolling, then a soft rising chime.
   *
   * The rustle is a run of short band-passed noise crackles climbing from ~1.8 to ~4.6 kHz over a
   * papery low-passed swish — the sound of dry vellum opening — and it deliberately has no tonal
   * body, which is what keeps it from being mistaken for the oil whoosh. The chime enters as the
   * scroll finishes opening: three soft sines rising through the level key (degrees 10 → 12 → 15,
   * i.e. root·2, a fourth up, an octave up) with a faint bell partial, slower and gentler than the
   * gem arpeggio and on its own register, so "the map" and "a gem" never read as the same event.
   * It does not touch the gem combo ladder. Rate-limited like the footsteps, although a level only
   * holds one scroll — a replayed event must never stack two.
   * @param {number} [pan] -1..1, where the scroll was relative to the player's facing
   */
  function playMap(pan = 0) {
    const t = now();
    if (t - lastMapAt < AUDIO.MAP.minGap) return;
    lastMapAt = t;
    // Parchment: the swish first, then the crackles, each a little later, brighter and quieter.
    sfxNoise('lowpass', 900, 2600, 0.6, t, 0.04, 0.36, 0.12, PRI.CUE, 0.12, pan);
    const n = AUDIO.MAP.crackles;
    for (let i = 0; i < n; i++) {
      const f = lerp(1800, 4600, i / (n - 1)) * rng.range(0.92, 1.08);
      const at = t + i * 0.055 + rng.range(0, 0.018);
      sfxNoise('bandpass', f, f * 0.8, 2.2, at, 0.003, 0.05, 0.3 - i * 0.04, PRI.CUE, 0.08, pan);
    }
    // The chime, once the scroll is open.
    const c = t + AUDIO.MAP.chimeAt;
    sfx('sine', degreeHz(10), degreeHz(10), c, 0.02, 0.7, 0.09, PRI.CUE, 0.4, 2.76, 0.12, pan);
    sfx('sine', degreeHz(12), degreeHz(12), c + 0.11, 0.02, 0.7, 0.085, PRI.CUE, 0.4, 2.76, 0.12, pan);
    sfx('sine', degreeHz(15), degreeHz(15), c + 0.22, 0.03, 1.1, 0.08, PRI.CUE, 0.5, 2.76, 0.1, pan);
  }

  /**
   * Chalk (§4.9): the scrape of a stick across stone — four short, bright, band-passed strokes, one
   * per stroke of the lettering, each a little higher and quieter, over a dry grit bed. No tone at
   * all, so it can never be mistaken for a pickup.
   * @param {number} [pan]
   */
  function playChalk(pan = 0) {
    const t = now();
    sfxNoise('highpass', 1800, 2400, 0.7, t, 0.004, 0.32, 0.06, PRI.CUE, 0.05, pan);
    for (let i = 0; i < 4; i++) {
      const f = (2600 + i * 420) * rng.range(0.9, 1.1);
      const at = t + i * 0.07 + rng.range(0, 0.02);
      sfxNoise('bandpass', f, f * 1.25, 3.2, at, 0.006, 0.06, 0.22 - i * 0.03, PRI.CUE, 0.06, pan);
    }
  }

  /** A chalk press that marked nothing: one dull, dry tap on stone. */
  function playChalkDeny() {
    const t = now();
    sfxNoise('lowpass', 700, 400, 0.8, t, 0.002, 0.08, 0.14, PRI.CUE, 0.04);
  }

  /**
   * Ember Reserve (§4.9): the torch was dead and catches again — a breath of air drawn in (a
   * low-passed noise swell), a crackle of catching wick, and a warm rising fifth underneath.
   */
  function playEmber() {
    const t = now();
    sfxNoise('lowpass', 300, 1800, 0.7, t, 0.25, 0.7, 0.2, PRI.STING, 0.2);
    for (let i = 0; i < 5; i++) {
      const f = 2200 * rng.range(0.8, 1.3);
      sfxNoise('bandpass', f, f, 2.5, t + 0.3 + i * 0.06 + rng.range(0, 0.03), 0.002, 0.04, 0.18, PRI.CUE, 0.1);
    }
    sfx('triangle', degreeHz(3), degreeHz(7), t + 0.25, 0.08, 0.9, 0.12, PRI.STING, 0.4);
  }

  // ─── New Descent (ARCHITECTURE.md §4.11) ───────────────────────────────────────────────────

  /**
   * The sword cutting air: one short band-passed noise sweep falling in pitch, which is what a
   * swung blade actually is. Deliberately quiet and dry — it fires several times a second in a
   * fight, so anything with a tail or a tone in it becomes a machine gun inside two exchanges.
   * A swing that connects is not voiced here; the impact speaks for it.
   * @param {boolean} hit
   */
  function playSwing(hit) {
    const t = now();
    const top = 2600 * rng.range(0.92, 1.08);
    sfxNoise('bandpass', top, top * 0.3, 1.1, t, 0.006, hit ? 0.09 : 0.15, hit ? 0.1 : 0.14, PRI.CUE, 0.03);
  }

  /**
   * The sword landing. Two different impacts, because the two creatures are two different
   * materials and the mode's whole read is telling them apart: a crawler is a dry shell that
   * CRACKS, a wraith is cloth and cold air that gives with a low sigh and no crack at all.
   * A kill adds a longer, lower tail underneath so a death is audibly a death and not a fourth hit.
   * @param {'crawler'|'wraith'} kind
   * @param {boolean} killed
   * @param {number} [pan]
   */
  function playEnemyHit(kind, killed, pan = 0) {
    const t = now();
    if (kind === 'wraith') {
      sfxNoise('lowpass', 900, 260, 0.9, t, 0.004, 0.2, 0.2, PRI.STING, 0.16, pan);
      sfx('sine', 190, 120, t, 0.006, 0.22, 0.1, PRI.CUE, 0.2, 0, 0, pan);
    } else {
      // The crack: a hard, short, high burst over a dry body thump.
      sfxNoise('bandpass', 3100 * rng.range(0.9, 1.1), 900, 2.4, t, 0.001, 0.07, 0.24, PRI.STING, 0.08, pan);
      sfxNoise('lowpass', 420, 180, 0.9, t, 0.002, 0.13, 0.2, PRI.CUE, 0.06, pan);
    }
    if (killed) {
      // A falling minor third into the reverb, in the level's key, so a kill reads as resolved.
      sfx('triangle', degreeHz(3), degreeHz(0), t + 0.03, 0.01, 0.55, 0.13, PRI.STING, 0.42, 0, 0, pan);
      sfxNoise('lowpass', 500, 120, 0.7, t + 0.02, 0.01, 0.42, 0.16, PRI.CUE, 0.24, pan);
    }
  }

  /**
   * A creature noticing the player, from wherever it is standing.
   *
   * The most important sound in the mode and the quietest: it is the only warning that something
   * outside the torchlight has started coming, and it has to carry from across a corridor without
   * telling the player what or exactly where. A crawler's is a dry chitinous rattle; a wraith's is
   * a cold intake of breath that rises. Both are panned, so at least the SIDE is knowable.
   * @param {'crawler'|'wraith'} kind
   * @param {number} [pan]
   */
  function playWake(kind, pan = 0) {
    const t = now();
    if (kind === 'wraith') {
      // A rising, breathy band of noise — air moving where there is no mouth.
      sfxNoise('bandpass', 420, 1450, 1.6, t, 0.16, 0.62, 0.15, PRI.CUE, 0.34, pan);
      sfx('sine', degreeHz(1), degreeHz(6), t + 0.04, 0.12, 0.5, 0.055, PRI.CUE, 0.4, 0, 0, pan);
    } else {
      // Six fast dry ticks: legs finding purchase on stone.
      for (let i = 0; i < 6; i++) {
        const f = 1900 * rng.range(0.85, 1.2);
        sfxNoise('bandpass', f, f * 0.7, 3.4, t + i * 0.035 + rng.range(0, 0.012), 0.001, 0.035, 0.12, PRI.CUE, 0.12, pan);
      }
      sfxNoise('lowpass', 300, 200, 0.9, t, 0.01, 0.2, 0.07, PRI.CUE, 0.2, pan);
    }
  }

  /**
   * Something landing a blow on the PLAYER. The one cue in the mode that must never be missed, so
   * it is the loudest thing in it and sits where nothing else does: a hard low thud with a detuned
   * minor second over it — the same interval the low-fuel warning uses, because both mean the same
   * thing to a player, which is that the run is in danger.
   * @param {number} [pan]
   */
  function playPlayerHit(pan = 0) {
    const t = now();
    sfxNoise('lowpass', 260, 90, 1.1, t, 0.001, 0.26, 0.42, PRI.STING, 0.12, pan);
    sfx('sawtooth', 124, 96, t, 0.002, 0.3, 0.16, PRI.STING, 0.3, 0, 0, pan);
    sfx('sawtooth', 131, 101, t + 0.01, 0.002, 0.28, 0.12, PRI.STING, 0.3, 0, 0, pan);
  }

  /**
   * An unlock gained (§4.9): a bright climbing arpeggio in the level key with a bell partial — a
   * boon rings a step higher and one note longer than a Shrine purchase, because it is a gift.
   * @param {boolean} boon
   */
  function playUnlock(boon) {
    const t = now();
    const steps = boon ? [7, 9, 12, 14, 17] : [7, 10, 12, 14];
    for (let i = 0; i < steps.length; i++) {
      const last = i === steps.length - 1;
      sfx('sine', degreeHz(steps[i]), degreeHz(steps[i]), t + i * 0.075, 0.01, last ? 1.2 : 0.4, 0.1, PRI.STING, 0.45, 2.76, 0.14);
    }
    sfxNoise('highpass', 5000, 7000, 0.7, t, 0.01, 0.5, 0.05, PRI.CUE, 0.3);
  }

  /** Low fuel: a detuned minor-second swell that arrives just before the first heartbeat. */
  function playLowFuel() {
    const t = now();
    sfx('sawtooth', 146.8, 138, t, 0.12, 1.1, 0.09, PRI.STING, 0.4);
    sfx('sawtooth', 155.6, 146, t + 0.05, 0.14, 1.0, 0.07, PRI.STING, 0.4);
    armHeartbeat(t + 0.35);
  }

  /**
   * Level start: a descending reverberant bell figure — "you are deeper now". Transposed into the
   * level's key, so the bell is what *states* the new key before the first pluck arrives and level
   * 15 no longer sounds identical to level 1.
   */
  function playLevelStart() {
    const t = now();
    for (let i = 0; i < BELL_NOTES.length; i++) {
      const f = BELL_NOTES[i] * musicKey;
      // 2.76 is the classic inharmonic bell partial; the long decay feeds the dungeon reverb.
      sfx(
        'sine',
        f,
        f,
        t + i * 0.17,
        0.005,
        1.5 + i * 0.25,
        0.13 - i * 0.012,
        PRI.STING,
        0.55,
        2.76,
        0.3,
      );
    }
  }

  /**
   * Level complete: a fast ascending retro arpeggio capped with a held major chord — transposed
   * with everything else, so the cadence resolves in the key the level was actually played in.
   */
  function playFanfare() {
    const t = now();
    for (let i = 0; i < FANFARE_ARP.length; i++) {
      const f = FANFARE_ARP[i] * musicKey;
      sfx('square', f, f, t + i * 0.075, 0.004, 0.2, 0.1, PRI.STING, 0.25);
    }
    for (let i = 0; i < FANFARE_CHORD.length; i++) {
      const f = FANFARE_CHORD[i] * musicKey;
      sfx('triangle', f, f, t + 0.32, 0.01, 1.1, 0.11, PRI.STING, 0.45, 2, 0.25);
    }
    duck = 0.35; // let the fanfare own the mix; update() restores music over ~1 s
  }

  /**
   * Game over: two sagging detuned tones plus the torch being snuffed out.
   * @param {boolean} [newBest] the run beat the stored record — the only moment in the game worth
   *   a major chord, and until now a record run sounded exactly like a bad one.
   */
  function playGameOver(newBest) {
    const t = now();
    sfx('sawtooth', 330, 82.4, t, 0.03, 1.5, 0.12, PRI.STING, 0.5);
    sfx('sawtooth', 392, 98, t + 0.14, 0.03, 1.45, 0.1, PRI.STING, 0.5);
    sfx('sine', 165, 41, t + 0.05, 0.02, 1.7, 0.09, PRI.STING);
    // The snuff: broadband hiss collapsing to nothing, like a flame pinched out.
    sfxNoise('lowpass', 5200, 260, 0.8, t, 0.01, 0.55, 0.22, PRI.STING, 0.3);
    if (newBest) {
      // Placed after the snuff, not over it: the torch dies, *then* the score speaks.
      for (let i = 0; i < NEW_BEST_TRIAD.length; i++) {
        const f = NEW_BEST_TRIAD[i] * musicKey; // relative major of the key the run ended in
        sfx('triangle', f, f, t + 1 + i * 0.1, 0.006, 0.8, 0.09, PRI.STING, 0.4, 2, 0.2);
      }
    }
    duck = 0.25;
  }

  /**
   * UI blips. Deliberately plain square waves: a menu should read as the machine talking back,
   * not as another dungeon sound.
   * @param {'move'|'confirm'|'back'} kind
   */
  function playUiSound(kind) {
    const t = now();
    // Every path that blips — the menus through `playUi()`, a uiMove/uiConfirm event, or the phase
    // handler itself — records it here, which is what lets `onPhase` tell "nobody has answered
    // this action yet" from "the menus already did" (see `handle`).
    lastUiSoundAt = t;
    if (kind === 'confirm') {
      sfx('square', 659.25, 659.25, t, 0.003, 0.07, 0.11, PRI.UI);
      sfx('square', 987.77, 987.77, t + 0.06, 0.003, 0.12, 0.12, PRI.UI, 0.2);
    } else if (kind === 'back') {
      sfx('square', 440, 330, t, 0.003, 0.11, 0.1, PRI.UI);
    } else {
      sfx('square', 740, 700, t, 0.002, 0.05, 0.085, PRI.UI);
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────────────────────────

  /** @param {number} t time of the first beat; ignored when the heartbeat is already running */
  function armHeartbeat(t) {
    if (heartNext === 0) heartNext = t;
  }

  function disarmHeartbeat() {
    heartNext = 0;
  }

  /**
   * One lub-dub. Two sine thuds a fraction of the period apart, the second softer, with a scrap of
   * low noise for the body blow.
   *
   * WHY the harmonics and the click: the thuds live at 36–68 Hz, which a phone speaker (roll-off
   * ~250 Hz) and most laptops (~150 Hz) cannot reproduce — the low-fuel warning used to be all but
   * silent on exactly the devices the touch layout targets. Each thud therefore carries a 3rd
   * harmonic (204 / 186 Hz at 0.45×) that the ear fuses with the fundamental (the missing-
   * fundamental effect keeps it sounding low), and the lub gets a short (~10 ms audible) band-passed noise
   * transient around 1 kHz: the valve "tick" that reads as a heartbeat on any speaker at all.
   * @param {number} t
   * @param {number} period current beat period (seconds) — the split scales with it
   * @param {number} urgency 0..1 (0 = just hit the threshold, 1 = about to go dark)
   */
  function scheduleHeartbeat(t, period, urgency) {
    const amp = lerp(0.2, 0.4, urgency);
    const split = period * AUDIO.HEART.split;
    sfx('sine', 68, 40, t, 0.006, 0.19, amp, PRI.CUE, 0, 3, 0.45);
    sfx('sine', 62, 36, t + split, 0.006, 0.16, amp * 0.66, PRI.CUE, 0, 3, 0.45);
    sfxNoise('lowpass', 200, 90, 0.7, t, 0.004, 0.1, amp * 0.28, PRI.STEP);
    // The tick: brighter and a touch longer as the torch dies, so urgency is audible up top too.
    // Pre-filter gain is high because a Q 0.8 band keeps only a few percent of white noise's power.
    sfxNoise('bandpass', 1000, 650, 0.8, t, 0.001, lerp(0.02, 0.03, urgency), amp * 2.4, PRI.CUE);
  }

  /**
   * One tiny resin pop from the carried torch. Lowest priority: a crackle must never steal the
   * voice of a gem chime.
   * @param {number} t
   * @param {number} fuelFrac 0..1 — a low torch pops lower and softer
   */
  function scheduleCrackle(t, fuelFrac) {
    const f = rng.range(1400, 4200) * lerp(0.6, 1, fuelFrac);
    const amp = rng.range(0.02, 0.07) * lerp(0.5, 1, fuelFrac);
    sfxNoise('bandpass', f, f * 0.6, 2.6, t, 0.002, rng.range(0.02, 0.06), amp, PRI.AMBIENT);
  }

  // ── Generative music ────────────────────────────────────────────────────────────────────────

  /**
   * The home degree (the root or the fifth, in any octave) a phrase whose penultimate note is `d`
   * resolves to. Phrases cadence there, which is what makes a run of notes sound like a sentence
   * ending. The nearest home *other than `d` itself* — a phrase that simply repeats its last note
   * does not land, it stalls — preferring the one below on a tie, because falling cadences settle.
   * @param {number} d
   * @returns {number}
   */
  function cadenceNear(d) {
    let best = AUDIO.PHRASE.degreeLo;
    let bestDist = Infinity;
    for (let c = AUDIO.PHRASE.degreeLo; c <= AUDIO.PHRASE.degreeHi; c++) {
      const pc = ((c % 5) + 5) % 5;
      if (c === d || (pc !== 0 && pc !== 3)) continue; // degree 0 = root, degree 3 = fifth
      const dist = Math.abs(c - d);
      if (dist < bestDist || (dist === bestDist && c < d)) {
        best = c;
        bestDist = dist;
      }
    }
    return best;
  }

  /** @param {number} d @returns {number} */
  function clampDegree(d) {
    return d < AUDIO.PHRASE.degreeLo
      ? AUDIO.PHRASE.degreeLo
      : d > AUDIO.PHRASE.degreeHi
        ? AUDIO.PHRASE.degreeHi
        : d;
  }

  /**
   * Move one inner note of `arr` a scale step, in whichever direction keeps it a *step* from both
   * neighbours: different from each (a repeated note sounds like a stuck key, not a new idea) and
   * no more than two degrees away (so variations accumulated over a long level can never drift the
   * motif into leaps). When neither direction qualifies the note is left alone.
   * @param {Int8Array} arr
   * @param {number} i 1..motifLen-2
   */
  function nudge(arr, i) {
    const dir = rng.chance(0.5) ? 1 : -1;
    for (let k = 0; k < 2; k++) {
      const cand = clampDegree(arr[i] + (k === 0 ? dir : -dir));
      const a = cand - arr[i - 1];
      const b = cand - arr[i + 1];
      if (cand !== arr[i] && a !== 0 && b !== 0 && a <= 2 && a >= -2 && b <= 2 && b >= -2) {
        arr[i] = cand;
        return;
      }
    }
  }

  /**
   * Compose (or, with `evolve`, mutate) the level's motif: a short random *walk* through the scale
   * that ends on the root or the fifth, with a rhythm on the pulse grid whose final note is held
   * longest. Writes the pre-allocated arrays only.
   *
   * The walk follows the two oldest rules of melody writing: move mostly by step (one degree two
   * times in three, two degrees most of the rest), and allow at most **one leap** per motif, which
   * is immediately answered by a step the other way (gap fill). It never repeats a note in place.
   * @param {boolean} evolve keep the shape of the current motif, change its interior
   */
  function composeMotif(evolve) {
    const P = AUDIO.PHRASE;
    if (evolve && motifLen > 0) {
      // Nudge one or two inner notes and maybe shift the whole figure a degree: the listener
      // still recognises the idea, but it has moved on.
      const moves = 1 + rng.int(2);
      for (let m = 0; m < moves; m++) nudge(motif, 1 + rng.int(Math.max(1, motifLen - 2)));
      if (rng.chance(0.4)) {
        const shift = rng.chance(0.5) ? 1 : -1;
        let fits = true;
        for (let i = 0; i < motifLen; i++) {
          const moved = motif[i] + shift;
          if (moved < P.degreeLo || moved > P.degreeHi) fits = false;
        }
        if (fits) for (let i = 0; i < motifLen; i++) motif[i] += shift;
      }
      motif[motifLen - 1] = cadenceNear(motif[motifLen - 2]);
      return;
    }
    motifLen = P.motifMin + rng.int(P.motifMax - P.motifMin + 1);
    const mid = (P.degreeLo + P.degreeHi) * 0.5;
    let d = clampDegree(lastDegree + rng.int(5) - 2);
    let leapt = false;
    let fill = 0; // direction the next note must step in after a leap (0 = free)
    for (let i = 0; i < motifLen; i++) {
      motif[i] = d;
      motifPulses[i] = 1 + rng.int(P.noteMaxPulses - 1); // 1..noteMaxPulses-1 inside the phrase
      let size;
      let up;
      if (fill !== 0) {
        size = 1;
        up = fill > 0;
        fill = 0;
      } else {
        const r = rng.next();
        size = r < 0.66 ? 1 : r < 0.95 || leapt ? 2 : 3;
        // Lean back toward the middle of the range so the walk does not pin itself to an edge.
        up = rng.next() < 0.5 + (mid - d) * 0.06;
        if (size === 3) {
          leapt = true;
          fill = up ? -1 : 1;
        }
      }
      let next = clampDegree(d + (up ? size : -size));
      if (next === d) next = clampDegree(d + (up ? -size : size)); // bounced off an edge
      d = next;
    }
    motif[motifLen - 1] = cadenceNear(motif[motifLen - 2]);
    motifPulses[motifLen - 1] = P.noteMaxPulses; // the cadence note is held longest
    phraseCount = 0;
  }

  /**
   * Load the next pass of the motif into `phrase`. Even passes state the motif; odd passes vary it
   * (a sequence one degree up or down, or one inner note answered a step away), always keeping the
   * cadence on a home degree. Every `evolveEvery` passes the motif itself evolves.
   */
  function beginPhrase() {
    if (motifLen === 0) composeMotif(false);
    else if (phraseCount > 0 && phraseCount % AUDIO.PHRASE.evolveEvery === 0) composeMotif(true);
    for (let i = 0; i < motifLen; i++) phrase[i] = motif[i];
    if (phraseCount % 2 === 1) {
      if (rng.chance(0.5)) {
        // A sequence: the same shape a degree higher or lower (only if it fits the range intact).
        const shift = rng.chance(0.5) ? 1 : -1;
        let fits = true;
        for (let i = 0; i < motifLen - 1; i++) {
          const moved = phrase[i] + shift;
          if (moved < AUDIO.PHRASE.degreeLo || moved > AUDIO.PHRASE.degreeHi) fits = false;
        }
        if (fits) for (let i = 0; i < motifLen - 1; i++) phrase[i] += shift;
      } else {
        nudge(phrase, 1 + rng.int(Math.max(1, motifLen - 2)));
      }
      phrase[motifLen - 1] = cadenceNear(phrase[motifLen - 2]);
    }
    phraseCount++;
    phraseStep = 0;
  }

  /**
   * Advance the phrase engine by one note: schedule it at `t` (unless `audible` is false — the line
   * keeps its place while music is muted) and return the gap to the next onset, in seconds, on the
   * pulse grid.
   * @param {number} t
   * @param {boolean} audible
   * @returns {number}
   */
  function nextPluck(t, audible) {
    if (motifLen === 0 || phraseStep >= motifLen) beginPhrase();
    const i = phraseStep++;
    const degree = phrase[i];
    lastDegree = degree;
    const cadence = i === motifLen - 1;
    if (audible) schedulePluck(t, degree, cadence);
    const P = AUDIO.PHRASE;
    let pulses = motifPulses[i];
    // Deeper levels shorten the *rests between phrases* (gapScale < 1) — the phrase itself keeps
    // its rhythm, so the line gets more frequent without turning into a stream of eighth notes.
    if (cadence) {
      const rest = P.restMin + rng.int(P.restMax - P.restMin + 1);
      pulses += Math.max(1, Math.round(rest * gapScale));
    }
    return P.pulse * pulses;
  }

  /**
   * One pluck with a long reverb send. The last note of a phrase is longer and gains a consonant
   * dyad beneath it (two scale steps down: a fourth under the root, a third under the fifth), so
   * the cadence *lands*.
   * @param {number} t
   * @param {number} degree pentatonic degree (see `degreeHz`)
   * @param {boolean} cadence
   */
  function schedulePluck(t, degree, cadence) {
    const f = degreeHz(degree);
    const dur = cadence ? rng.range(2.4, 3) : rng.range(1.5, 2.2);
    const amp = cadence ? 0.09 : 0.08;
    tone('triangle', f, f, t, 0.012, dur, amp, musicBus, musicSend, 0.75, PRI.MUSIC, 2, 0.14);
    if (cadence) {
      const f2 = degreeHz(degree - 2);
      tone('triangle', f2, f2, t + 0.09, 0.02, dur * 0.8, 0.045, musicBus, musicSend, 0.75, PRI.MUSIC);
    }
  }

  /**
   * How loud the ambience should be in each phase. Music is atmosphere, not a soundtrack: it sits
   * back during play (the torch, steps and portal carry the tension) and comes forward on menus.
   * @param {Phase|''} phase
   * @returns {number} 0..1
   */
  function phaseMusicLevel(phase) {
    switch (phase) {
      case 'title':
        return 1;
      case 'loading':
        return 0.75;
      case 'playing':
        return 0.62;
      case 'paused':
        return 0.42;
      case 'levelComplete':
        return 0.7;
      case 'gameOver':
        return 0.3;
      default:
        return 0.6;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Public surface
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Create (first call) and resume the AudioContext. Safe to call on every gesture.
   * @returns {boolean} true when the context exists and is not suspended
   */
  function unlock() {
    if (dead || disposed) return false;
    try {
      if (ctx === null) {
        const made = factory();
        if (!made || typeof made.createGain !== 'function') {
          // No WebAudio at all: settle into the silent no-op shape once and stop trying.
          dead = true;
          detachGestures();
          return false;
        }
        ctx = made;
        try {
          ctx.onstatechange = onStateChange;
        } catch {
          /* no statechange support: interruption recovery is simply unavailable */
        }
        built = buildGraph();
      }
      userSuspended = false; // a gesture is the player asking for sound
      resumeContext();
      const running = live() && isRunning();
      // Keep the gesture listeners until the context is genuinely running: a programmatic unlock()
      // before any gesture leaves the context suspended, and the next real tap must still reach us.
      if (running) detachGestures();
      return running;
    } catch (err) {
      fail(err);
      // A context that blew up mid-build must not be half-wired into the destination.
      if (!built) {
        dead = true;
        teardown();
      }
      return false;
    }
  }

  /**
   * Resume the context from any resumable state. WHY not just 'suspended': iOS Safari parks a
   * context in 'interrupted' after a call or Siri, and future states may appear; everything except
   * 'running' and 'closed' is worth a resume() attempt. (A rejected resume — no user gesture — is
   * expected and swallowed inside `callSafe`.)
   */
  function resumeContext() {
    if (!ctx || dead) return;
    const st = ctx.state;
    if (st !== 'running' && st !== 'closed') callSafe(ctx, 'resume');
    // Scheduler clocks are stale after a suspension: rebase them onto the live clock so the
    // look-ahead loops do not try to fill a multi-minute gap all at once.
    const t = now();
    if (heartNext !== 0 && heartNext < t) heartNext = t + 0.1;
    if (pluckNext < t) pluckNext = t + rng.range(0.4, 1.4);
  }

  /**
   * Route one step's worth of game events to cues.
   * @param {ReadonlyArray<GameEvent>|null|undefined} events
   * @param {GameState|null|undefined} state
   * @returns {void}
   */
  function handle(events, state) {
    if (!live() || !events || typeof events.length !== 'number') return;
    try {
      const muted = silent();
      // WHY this pre-scan: *unpausing from the menu answers one action twice*. menus.js plays a
      // confirm blip through main.js -> playUi('confirm'), and the same key press dispatches
      // `resume`, whose phase event reaches `onPhase` below. Two identical square figures one
      // frame apart sum phase-coherently — about +6 dB with a comb notch — which is an audible
      // flam on the most common interaction in the game. `uiAnswered` says "a menu already spoke
      // for this input", either just now (any blip within AUDIO.UI_ECHO, which covers the direct
      // `playUi` path main.js uses) or somewhere in *this* batch (the event path), and `onPhase`
      // then stays quiet. A programmatic resume with no UI sound anywhere still gets its blip.
      let uiAnswered = now() - lastUiSoundAt < AUDIO.UI_ECHO;
      for (let i = 0; i < events.length && !uiAnswered; i++) {
        const e = events[i];
        if (e && (e.type === 'uiConfirm' || e.type === 'uiMove')) uiAnswered = true;
      }
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (!e || typeof e.type !== 'string') continue;
        switch (e.type) {
          case 'footstep':
            if (!muted) playFootstep(e.foot === 1 ? 1 : 0, footIntensity(state));
            break;
          case 'bump':
            if (!muted) playBump(numberOr(e.strength, 0.5));
            break;
          case 'pickup': {
            if (!muted) {
              // The event carries the item's world position, so a gem on your left can sound as
              // if it were on your left. Same bearing maths as the portal hum.
              const pan = pickupPan(e.x, e.y, state);
              // Every kind is routed explicitly: the map scroll has its own cue (and must not
              // advance the gem combo ladder), and an unknown future kind stays silent rather than
              // passing itself off as a gem (a kind-less pickup keeps the old gem default).
              if (e.kind === 'oil') playOil(pan);
              else if (e.kind === 'map') playMap(pan);
              else if (e.kind === 'gem' || e.kind === undefined) playGem(pan);
            }
            break;
          }
          case 'lowFuel':
            if (!muted) playLowFuel();
            else armHeartbeat(now() + 0.35);
            break;
          case 'levelStart':
            comboCount = 0;
            comboUntil = 0;
            disarmHeartbeat();
            // Key the ambience to the new depth BEFORE the bell, so the bell states the new key.
            setDepth(numberOr(e.level, depthLevel || 1));
            if (!muted) playLevelStart();
            break;
          case 'levelComplete':
            disarmHeartbeat();
            if (!muted) playFanfare();
            break;
          case 'gameOver':
            disarmHeartbeat();
            if (!muted) playGameOver(e.newBest === true);
            break;
          case 'phase':
            onPhase(e.from, e.to, muted, uiAnswered);
            break;
          case 'uiMove':
            if (!muted) playUiSound('move');
            break;
          case 'uiConfirm':
            if (!muted) playUiSound('confirm');
            break;
          case 'chalk':
            if (!muted) {
              if (e.ok === true) playChalk(pickupPan(e.x, e.y, state));
              else playChalkDeny();
            }
            break;
          case 'ember':
            if (!muted) playEmber();
            break;
          // New Descent (§4.11). Positioned like every other world event, off the bearing helper the
          // pickups and the portal already share, so a creature on your left dies on your left.
          case 'swing':
            if (!muted) playSwing(e.hit === true);
            break;
          case 'enemyHit':
            if (!muted) {
              playEnemyHit(e.kind === 'wraith' ? 'wraith' : 'crawler', e.killed === true, pickupPan(e.x, e.y, state));
            }
            break;
          case 'playerHit':
            if (!muted) playPlayerHit(pickupPan(e.x, e.y, state));
            break;
          case 'enemyWake':
            if (!muted) {
              playWake(e.kind === 'wraith' ? 'wraith' : 'crawler', pickupPan(e.x, e.y, state));
            }
            break;
          case 'unlock':
            if (!muted) playUnlock(e.boon === true);
            break;
          default:
            break; // forward-compatible: unknown event types are simply not audible
        }
      }
    } catch (err) {
      fail(err);
    }
  }

  /**
   * Phase-change side effects that are not covered by a dedicated event.
   * Uses the event's own `from` rather than a cached phase so it does not depend on whether
   * `update()` ran before or after `handle()` this frame.
   * @param {Phase} from
   * @param {Phase} to
   * @param {boolean} muted
   * @param {boolean} uiAnswered a menu already blipped for this input (see `handle`) — the phase
   *   blips exist for *programmatic* transitions (a pointer-lock loss, a lost window focus, a
   *   headless `dispatch`), never to double up on one the player heard already.
   */
  function onPhase(from, to, muted, uiAnswered) {
    if (to === 'paused') {
      disarmHeartbeat();
      if (!muted && !uiAnswered) playUiSound('back');
    } else if (to === 'playing' && from === 'paused') {
      if (!muted && !uiAnswered) playUiSound('confirm');
    } else if (to === 'title' || to === 'loading') {
      disarmHeartbeat();
      comboCount = 0;
      comboUntil = 0;
    }
  }

  /**
   * Continuous, per-frame audio: mixer smoothing, portal proximity, heartbeat and the music
   * scheduler. Allocation-free unless it schedules a sound.
   * @param {GameState|null|undefined} state
   * @returns {void}
   */
  function update(state) {
    if (!live()) return;
    try {
      const t = now();
      reap(t);

      const s = state && typeof state === 'object' ? state : null;
      const phase = /** @type {Phase|''} */ (s && typeof s.phase === 'string' ? s.phase : '');

      // Depth keys the ambience (§ setDepth). Read from the state as well as from the levelStart
      // event because `state.level` already holds the new depth during `loading`, so the drone
      // glides into the new key while the labyrinth is being carved — and because it is the one
      // reading that cannot be missed by an event that arrived before the first gesture unlocked
      // the context. A repeat for the same level costs one number comparison.
      if (s && typeof s.level === 'number' && s.level !== depthLevel) setDepth(s.level);

      // Settings are the source of truth; reading them here means main.js cannot forget to call
      // setVolume() after an options change. Only *changes* are adopted (see seenVolumeSetting).
      const set = s ? s.settings : null;
      if (set) {
        const sv = set.volume;
        if (typeof sv === 'number' && Number.isFinite(sv) && sv !== seenVolumeSetting) {
          // The first observation is only adopted when nobody has set a level by hand yet.
          const deferToCaller = volumeTouched && Number.isNaN(seenVolumeSetting);
          seenVolumeSetting = sv;
          if (!deferToCaller) volume = clamp01(sv);
        }
        const sm = set.music;
        if (typeof sm === 'number' && Number.isFinite(sm) && sm !== seenMusicSetting) {
          const deferToCaller = volumeTouched && Number.isNaN(seenMusicSetting);
          seenMusicSetting = sm;
          if (!deferToCaller) music = clamp01(sm);
        }
      }
      phaseMusic = phaseMusicLevel(phase);
      // Frame-rate independent duck recovery (~1.1 s), measured on the audio clock rather than
      // counted in frames: a 144 Hz display must not bring the music back twice as fast.
      const dt = lastUpdateT < 0 ? 1 / 60 : clamp(t - lastUpdateT, 0, 0.25);
      lastUpdateT = t;
      if (duck < 1) duck = Math.min(1, duck + dt * 0.9);
      applyMix(t, AUDIO.TC.mix);

      const playing = phase === 'playing';
      const d = s ? s.derived : null;
      const run = s ? s.run : null;

      // ── Portal hum ───────────────────────────────────────────────────────────────────────
      const near =
        d && typeof d.nearExit === 'number' && Number.isFinite(d.nearExit) ? clamp01(d.nearExit) : 0;
      // Squared so the hum stays subliminal across the room and blooms in the last few tiles.
      const want = (playing || phase === 'levelComplete') && !silent() ? near * near : 0;
      if (Math.abs(want - portalTarget) > 0.004) {
        portalTarget = want;
        pTarget(portalGain.gain, want * AUDIO.PORTAL.gain, t, AUDIO.TC.portal);
        pTarget(
          portalFilter.frequency,
          lerp(AUDIO.PORTAL.cutMin, AUDIO.PORTAL.cutMax, want),
          t,
          AUDIO.TC.portal,
        );
      }
      if (portalPan && want > 0.002) {
        // sin(bearing) is 0 dead ahead and behind, ±1 abeam: exactly the cue a player needs to
        // know which way to turn, with no front/back ambiguity to resolve (there is none in stereo).
        const p = s.player;
        const mz = s.levelData ? s.levelData.maze : null;
        if (p && mz && mz.exit) {
          const rel = Math.atan2(mz.exit.y + 0.5 - p.y, mz.exit.x + 0.5 - p.x) - p.angle;
          const pan = clamp(Math.sin(rel) * AUDIO.PORTAL.pan, -1, 1);
          if (Math.abs(pan - portalPanAt) > 0.01) {
            portalPanAt = pan;
            pTarget(portalPan.pan, pan, t, AUDIO.TC.portal);
          }
        }
      }

      // ── Carried torch: flame bed + crackle ───────────────────────────────────────────────
      const fuelFrac =
        run && run.fuelMax > 0 ? clamp01(run.fuel / run.fuelMax) : playing ? 1 : 0;
      // A guttering torch is quieter and sparser, so the ear learns the fuel state too.
      const torchWant = playing && !silent() ? AUDIO.TORCH.bed * lerp(0.45, 1, fuelFrac) : 0;
      if (Math.abs(torchWant - torchTarget) > 0.0005) {
        torchTarget = torchWant;
        pTarget(torchGain.gain, torchWant, t, 0.3);
      }
      if (torchWant > 0) {
        if (crackleNext < t) crackleNext = t + 0.05; // rebase after a pause, never catch up
        while (crackleNext < t + AUDIO.LOOKAHEAD) {
          scheduleCrackle(crackleNext, fuelFrac);
          // A dying torch spits less often as well as less loudly.
          crackleNext += rng.range(AUDIO.TORCH.gapMin, AUDIO.TORCH.gapMax) * lerp(2.2, 1, fuelFrac);
        }
      } else {
        crackleNext = 0; // stale; the branch above rebases it when the torch is lit again
      }

      // ── Low-fuel heartbeat ───────────────────────────────────────────────────────────────
      const lowFuel = !!(d && d.lowFuel) && playing;
      if (!lowFuel) {
        disarmHeartbeat();
      } else {
        if (heartNext === 0) heartNext = t + 0.2;
        if (heartNext < t) heartNext = t; // catch up after a stall instead of firing a burst
        if (!silent()) {
          // urgency 0 at the low-fuel threshold, 1 at an empty tank.
          const max = run && run.fuelMax > 0 ? run.fuelMax : 0;
          const frac = max > 0 ? clamp01(run.fuel / max) : 0;
          // AUDIO.HEART.lowFraction mirrors balance.js FUEL.LOW_FRACTION — the fraction the sim
          // sets `derived.lowFuel` at. If the two drift, the beat either starts at full urgency or
          // never reaches it, which is the whole point of the cue.
          const urgency = 1 - clamp01(frac / AUDIO.HEART.lowFraction);
          const period = lerp(AUDIO.HEART.slow, AUDIO.HEART.fast, urgency);
          while (heartNext < t + AUDIO.LOOKAHEAD) {
            scheduleHeartbeat(heartNext, period, urgency);
            heartNext += period;
          }
        } else {
          heartNext = t + 0.5;
        }
      }

      // ── Generative ambience ──────────────────────────────────────────────────────────────
      const musicOn = music > 0.0005 && !silent() && phaseMusic > 0.05;
      // New Descent (§4.11): the drone swells with the nearest awake creature. It is the mode's only
      // warning that something has noticed you and is behind you — the corridor gives no other —
      // and it rides the ambience that is already there rather than adding a stinger, so it reads
      // as the room changing rather than as a sound effect. Always 0 in Classic Descent.
      const threat =
        playing && d && typeof d.threat === 'number' && Number.isFinite(d.threat) ? clamp01(d.threat) : 0;
      // Squared, like the portal hum: subliminal across a room, unmistakable in the last few tiles.
      const droneWant = musicOn ? AUDIO.DRONE_GAIN * (1 + AUDIO.THREAT_SWELL * threat * threat) : 0;
      if (Math.abs(droneWant - droneAt) > 0.002) {
        droneAt = droneWant;
        pTarget(droneGain.gain, droneWant, t, AUDIO.TC.music);
      }
      if (pluckNext < t) pluckNext = t + rng.range(0.2, 0.9);
      while (pluckNext < t + AUDIO.LOOKAHEAD) {
        pluckNext += nextPluck(pluckNext, musicOn);
      }
    } catch (err) {
      fail(err);
    }
  }

  /**
   * Where a picked-up item was, as a stereo position. `sin(bearing)` is 0 dead ahead and behind and
   * ±1 abeam — the same cue as the portal hum, at 0.6 so a pickup never jumps fully into one ear.
   * @param {number} x item world x @param {number} y item world y
   * @param {GameState|null|undefined} state
   * @returns {number} -1..1, 0 when the position or the player is unusable
   */
  function pickupPan(x, y, state) {
    const p = state && typeof state === 'object' ? state.player : null;
    if (!p || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.angle)) return 0;
    const dx = x - p.x;
    const dy = y - p.y;
    if (dx === 0 && dy === 0) return 0; // standing exactly on it: no bearing to speak of
    return clamp(Math.sin(Math.atan2(dy, dx) - p.angle) * 0.6, -1, 1);
  }

  /**
   * How hard the current footstep should land, from the player's ground speed.
   * WHY speed and not the input: walking into a wall should not sound like a full stride.
   * @param {GameState|null|undefined} state
   * @returns {number} 0..1
   */
  function footIntensity(state) {
    const p = state && typeof state === 'object' ? state.player : null;
    if (!p) return 0.5;
    const vx = typeof p.vx === 'number' ? p.vx : 0;
    const vy = typeof p.vy === 'number' ? p.vy : 0;
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (!Number.isFinite(speed)) return 0.5;
    return clamp01(
      (speed - AUDIO.STEP_SPEED.min) / (AUDIO.STEP_SPEED.max - AUDIO.STEP_SPEED.min),
    );
  }

  /**
   * Set the mixer levels. Both are 0..1 (`Settings.volume` / `Settings.music`); `volume` is the
   * master, so `setVolume(0)` is a full mute including music. The value holds until the player
   * actually moves the corresponding slider in `state.settings` (see `update()`).
   * @param {number} v master 0..1
   * @param {number} [m] music 0..1 (unchanged when omitted)
   * @returns {void}
   */
  function setVolume(v, m) {
    try {
      volumeTouched = true;
      if (typeof v === 'number' && Number.isFinite(v)) volume = clamp01(v);
      if (typeof m === 'number' && Number.isFinite(m)) music = clamp01(m);
      if (live()) applyMix(now(), AUDIO.TC.mix);
    } catch (err) {
      fail(err);
    }
  }

  /**
   * Play a UI sound directly (menus that do not go through the event queue).
   * @param {'move'|'confirm'|'back'} kind
   * @returns {void}
   */
  function playUi(kind) {
    if (!live() || silent()) return;
    try {
      playUiSound(kind === 'confirm' || kind === 'back' ? kind : 'move');
    } catch (err) {
      fail(err);
    }
  }

  /** Suspend the context (also done automatically while the document is hidden). */
  function suspend() {
    try {
      if (ctx && !dead) {
        userSuspended = true;
        callSafe(ctx, 'suspend');
      }
    } catch (err) {
      fail(err);
    }
  }

  /** Resume after `suspend()`. No-op before the first `unlock()`. */
  function resume() {
    try {
      hiddenSuspended = false;
      userSuspended = false;
      resumeContext();
    } catch (err) {
      fail(err);
    }
  }

  /** Release every node and listener. Idempotent; the object stays callable (and silent). */
  function dispose() {
    disposed = true;
    dead = true;
    teardown();
  }

  function teardown() {
    try {
      for (let i = 0; i < maxVoices; i++) releaseVoice(voices[i]);
      while (retireCount > 0) retireOne(retireCount - 1);
      if (ctx) {
        try {
          ctx.onstatechange = null;
        } catch {
          /* read-only on an exotic implementation */
        }
      }
      keyedParams.length = 0;
      keyedHz.length = 0;
      for (let i = 0; i < persistent.length; i++) {
        const node = persistent[i];
        if (!node) continue;
        try {
          if (typeof node.stop === 'function') node.stop();
        } catch {
          /* not a source */
        }
        try {
          if (typeof node.disconnect === 'function') node.disconnect();
        } catch {
          /* already gone */
        }
      }
      persistent.length = 0;
      if (doc) {
        removeListener(doc, 'visibilitychange', onVisibility);
        detachGestures();
      }
      const c = ctx;
      ctx = null;
      built = false;
      if (c) {
        callSafe(c, 'close');
      }
    } catch {
      // teardown is best-effort by definition: there is nothing left to degrade to.
    }
  }

  /** Attach the one-shot unlock listeners (at boot, and again after an OS interruption). */
  function attachGestures() {
    if (gestureAttached || !doc || !autoUnlock || disposed) return;
    addListener(doc, 'pointerdown', onGesture);
    addListener(doc, 'keydown', onGesture);
    addListener(doc, 'touchend', onGesture);
    gestureAttached = true;
  }

  /** @returns {boolean} the context is producing sound (a context with no `state` is assumed to) */
  function isRunning() {
    const st = ctx ? ctx.state : 'closed';
    return st === undefined || st === 'running';
  }

  function detachGestures() {
    if (!gestureAttached || !doc) return;
    gestureAttached = false;
    removeListener(doc, 'pointerdown', onGesture);
    removeListener(doc, 'keydown', onGesture);
    removeListener(doc, 'touchend', onGesture);
  }

  /** @returns {boolean} */
  function isHidden() {
    return !!(doc && /** @type {any} */ (doc).hidden);
  }

  /**
   * Engine telemetry. The returned object is REUSED — copy any field you intend to keep.
   * @returns {AudioStats}
   */
  function stats() {
    statsOut.voices = liveVoices;
    statsOut.stolen = stolen;
    statsOut.dropped = dropped;
    statsOut.failures = failures;
    statsOut.time = ctx && typeof ctx.currentTime === 'number' ? ctx.currentTime : 0;
    statsOut.state = dead ? 'failed' : !ctx ? 'absent' : String(ctx.state || 'running');
    return statsOut;
  }

  return {
    unlock,
    handle,
    update,
    setVolume,
    playUi,
    suspend,
    resume,
    dispose,
    stats,
    get unlocked() {
      return live() && isRunning();
    },
    get available() {
      return !dead && !disposed;
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Module-level helpers (no engine state)
// ══════════════════════════════════════════════════════════════════════════════════════════════

function noop() {}

/**
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * @param {unknown} d explicit document option
 * @returns {any|null} an object with add/removeEventListener, or null
 */
function resolveDoc(d) {
  if (d === null) return null;
  const candidate =
    d === undefined ? /** @type {any} */ (globalThis).document : /** @type {any} */ (d);
  if (!candidate || typeof candidate.addEventListener !== 'function') return null;
  return candidate;
}

/** @param {any} target @param {string} type @param {Function} fn */
function addListener(target, type, fn) {
  try {
    target.addEventListener(type, fn, { passive: true });
  } catch {
    try {
      target.addEventListener(type, fn);
    } catch {
      /* a document that refuses listeners just means no auto-unlock / no auto-suspend */
    }
  }
}

/** @param {any} target @param {string} type @param {Function} fn */
function removeListener(target, type, fn) {
  try {
    if (typeof target.removeEventListener === 'function') target.removeEventListener(type, fn);
  } catch {
    /* ignore */
  }
}

/**
 * Call an optional context method (`resume`/`suspend`/`close`) without caring whether it exists,
 * throws, or returns a promise that rejects. WHY the rejection handler lives here: every one of
 * these can reject in normal operation (resume without a gesture, suspend/close on a closed
 * context), and an unhandled rejection is console output production must not print.
 * @param {any} obj
 * @param {string} method
 * @returns {any} whatever the method returned (with its rejection already handled), or undefined
 */
function callSafe(obj, method) {
  try {
    if (obj && typeof obj[method] === 'function') {
      const p = obj[method]();
      if (p && typeof p.catch === 'function') p.catch(noop);
      return p;
    }
  } catch {
    /* suspend() on an already-closed context throws — harmless */
  }
  return undefined;
}
