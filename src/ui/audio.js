// @ts-check
/**
 * A-MAZE — audio (ARCHITECTURE.md §4.6).
 *
 * Every sound in the game is **synthesised at runtime** with WebAudio; there is not a single audio
 * file in the repository. The module owns one `AudioContext` and one fixed mixer graph:
 *
 * ```
 *   one-shot voices ─┬─► sfxBus ──┬─────────────► master ─► compressor ─► limiter ─► destination
 *   portal hum ──────┤            └─► sfxSend ─► [delay ⇄ feedback ─► damp] ─┘ (return into sfxBus)
 *   torch flame ─────┘
 *   music plucks ────┬─► musicBus ┬─────────────►
 *   dungeon drone ───┘            └─► musicSend ─► [delay ⇄ feedback ─► damp] (return into musicBus)
 * ```
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
 *   to finishing, and only from an equal-or-lower priority.
 * - **Leak-free.** Every voice disconnects all of its nodes on `ended`, and a per-frame reap
 *   releases any voice whose scheduled end time has passed (belt and braces: `onended` does not
 *   fire while a context is suspended).
 * - **Allocation-free per frame.** `update()` touches only numbers and pre-allocated objects; it
 *   allocates nothing unless it actually schedules a new sound (music pluck / heartbeat), which
 *   happens at most a few times per second.
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
   * Footstep gain at a standstill-crawl vs. at full sprint. Pre-filter amplitudes: a band-pass on
   * white noise throws most of the energy away, so these sit higher than they look.
   */
  STEP_GAIN: Object.freeze({ min: 0.22, max: 0.46 }),
  /** Speeds (tiles/s) that map to STEP_GAIN.min / max. Mirrors balance.js WALK_SPEED 3.2×1.6. */
  STEP_SPEED: Object.freeze({ min: 1.4, max: 5.1 }),
  /** Seconds between gems that still counts as a combo (audio-side, purely cosmetic). */
  COMBO_WINDOW: 1.6,
  /** Highest combo step that still raises the arpeggio pitch. */
  COMBO_MAX: 7,
  /** Heartbeat period (seconds) at the low-fuel threshold and at empty. */
  HEART: Object.freeze({ slow: 1.15, fast: 0.44, split: 0.26 }),
  /** Portal hum: gain and filter cutoff at `nearExit` 0 → 1, and how far it pans off-centre. */
  PORTAL: Object.freeze({ gain: 0.21, cutMin: 170, cutMax: 1500, pan: 0.8 }),
  /** Torch fire bed: constant hiss level and the gap between crackle pops, seconds. */
  TORCH: Object.freeze({ bed: 0.016, gapMin: 0.07, gapMax: 0.5 }),
  /** Generative music: seconds between plucks, and the pentatonic degrees in semitones over A3. */
  MUSIC: Object.freeze({ gapMin: 1.5, gapMax: 4.4, root: 220, droneHz: 55 }),
  /** Smoothing time constants for the continuously-driven parameters. */
  TC: Object.freeze({ mix: 0.05, portal: 0.14, music: 0.6 }),
});

/** A minor pentatonic over the root, in semitones (plus two upper-octave degrees). */
const PENTATONIC = Object.freeze([0, 3, 5, 7, 10, 12, 15, 17, 19, 24]);

/** Level-start bell, Hz: A5 · E5 · C5 · A4 — an A-minor triad falling into the dark. */
const BELL_NOTES = Object.freeze([880, 659.25, 523.25, 440]);
/** Level-complete run-up, Hz: C5 · E5 · G5 · C6. */
const FANFARE_ARP = Object.freeze([523.25, 659.25, 783.99, 1046.5]);
/** …resolving onto a held C-major triad. */
const FANFARE_CHORD = Object.freeze([523.25, 659.25, 783.99]);

/** Voice priorities. A new sound may only steal a voice of equal or lower priority. */
const PRI = Object.freeze({ MUSIC: 0, STEP: 1, UI: 2, CUE: 3, STING: 4 });

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
  /** @type {AnyNode} */ let torchGain = null;
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
  let failures = 0;
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
  let lastUpdateT = -1; // ctx time of the previous update(), -1 = never

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

  if (doc) {
    addListener(doc, 'visibilitychange', onVisibility);
    if (autoUnlock) {
      addListener(doc, 'pointerdown', onGesture);
      addListener(doc, 'keydown', onGesture);
      addListener(doc, 'touchend', onGesture);
      gestureAttached = true;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Error handling
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Swallow an internal error. Recorded once in the core ring buffer (the logger collapses
   * repeats), and after a burst of failures audio switches itself off for good rather than
   * limping along making noise in the console.
   * @param {unknown} err
   */
  function fail(err) {
    failures++;
    log.error('audio error', err);
    if (failures >= 12 && !dead) {
      dead = true;
      teardown();
    }
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
      if (victim === null || v.end < victim.end) victim = v;
    }
    if (victim === null) {
      dropped++;
      return null;
    }
    stolen++;
    releaseVoice(victim);
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
   * @template T
   * @param {Voice} v
   * @param {T} node
   * @returns {T} the same node, for chaining
   */
  function own(v, node) {
    if (v.n < MAX_NODES) v.nodes[v.n++] = node;
    return node;
  }

  /**
   * Stop and disconnect everything the voice owns. Idempotent: `onended` and the per-frame reap
   * both call it, and a stolen voice is released before it is reused.
   * @param {Voice} v
   */
  function releaseVoice(v) {
    if (!v.active) return;
    v.active = false;
    liveVoices--;
    for (let i = 0; i < v.n; i++) {
      const node = v.nodes[i];
      v.nodes[i] = null;
      if (!node) continue;
      try {
        if (typeof node.stop === 'function') node.stop();
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
    v.n = 0;
  }

  /**
   * Release voices whose scheduled end has passed. Required because `onended` does not fire while
   * the context is suspended (tab hidden) — without this a backgrounded tab would leak nodes.
   * @param {number} t ctx time
   */
  function reap(t) {
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

    // Feedback-delay "reverb" per bus. Separate networks so muting music also mutes its tails.
    sfxSend = buildReverb(sfxBus, 0.12, 0.3, 2600);
    musicSend = buildReverb(musicBus, 0.3, 0.52, 1900);

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
   * A cheap Schroeder-ish tail: one delay line with damped feedback. WHY not a convolver: an
   * impulse response is either a file (banned) or a multi-second noise buffer to synthesise; this
   * costs three nodes and sounds right for a stone dungeon.
   * @param {AnyNode} bus destination bus (the return lands here, so the bus gain rules the tail)
   * @param {number} time delay time in seconds
   * @param {number} feedback 0..1 loop gain (<1 or it never decays)
   * @param {number} damp low-pass cutoff inside the loop, Hz
   * @returns {AnyNode} the send node callers connect voices into
   */
  function buildReverb(bus, time, feedback, damp) {
    const send = keep(newGain(1));
    const delay = keep(ctx.createDelay(1));
    pSet(delay.delayTime, time, 0);
    const fb = keep(newGain(clamp(feedback, 0, 0.92)));
    const tone = keep(newFilter('lowpass', damp, 0.7));
    connect(send, delay);
    connect(delay, tone);
    connect(tone, fb);
    connect(fb, delay); // the loop
    connect(tone, bus); // the return
    return send;
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
   */
  function buildPortal() {
    portalGain = keep(newGain(0));
    portalFilter = keep(newFilter('lowpass', AUDIO.PORTAL.cutMin, 6));
    connect(portalFilter, portalGain);
    // Panning the hum turns it into a navigation aid: near the exit the player can hear which way
    // to turn. Optional node — a context without StereoPanner just gets a centred hum.
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
    const a = keep(newOsc('sawtooth', 61.7)); // B1 — a tritone-ish drone against the A music root
    const b = keep(newOsc('sawtooth', 61.7 * 1.006)); // beating at ~0.37 Hz
    const c = keep(newOsc('triangle', 123.4));
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

  /** Low sustained drone under the generative plucks. */
  function buildDrone() {
    droneGain = keep(newGain(0.11));
    const tone = keep(newFilter('lowpass', 320, 0.8));
    connect(tone, droneGain);
    connect(droneGain, musicBus);

    const t = now();
    const root = AUDIO.MUSIC.droneHz;
    const a = keep(newOsc('sawtooth', root));
    const b = keep(newOsc('sawtooth', root * 1.004));
    const fifth = keep(newOsc('sine', root * 1.4983)); // just fifth: cleaner than equal temperament
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
  ) {
    const v = acquireVoice(pri, t + dur + 0.02);
    if (!v) return false;
    const g = own(v, newGain(0));
    connect(g, bus);
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
   * @returns {boolean}
   */
  function noiseBurst(filterType, f0, f1, q, t, attack, dur, amp, bus, send, sendAmt, pri) {
    const v = acquireVoice(pri, t + dur + 0.02);
    if (!v) return false;
    const g = own(v, newGain(0));
    connect(g, bus);
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
   * @returns {boolean}
   */
  function sfx(type, f0, f1, t, attack, dur, amp, pri, send = 0, partial = 0, partialAmp = 0.3) {
    const to = send > 0 ? sfxSend : null;
    return tone(type, f0, f1, t, attack, dur, amp, sfxBus, to, send, pri, partial, partialAmp);
  }

  /**
   * `noiseBurst()` on the SFX bus.
   * @param {string} filterType @param {number} f0 @param {number} f1 @param {number} q
   * @param {number} t @param {number} attack @param {number} dur @param {number} amp
   * @param {number} pri @param {number} [send] 0..1 reverb send
   * @returns {boolean}
   */
  function sfxNoise(filterType, f0, f1, q, t, attack, dur, amp, pri, send = 0) {
    const to = send > 0 ? sfxSend : null;
    return noiseBurst(filterType, f0, f1, q, t, attack, dur, amp, sfxBus, to, send, pri);
  }

  /**
   * Footstep: a short band-passed grit burst plus a soft low thump for body weight.
   * Alternating feet get different centre frequencies so a walk cycle has a left/right feel, and
   * every step is detuned a few percent so a corridor sprint never turns into a drum machine.
   * @param {0|1} foot
   * @param {number} intensity 0 = crawl, 1 = full sprint
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
    sfx('sine', 82 * rng.range(0.95, 1.06), 54, t, 0.004, 0.1, amp * 0.5, PRI.STEP);
  }

  /**
   * Wall bump: a low sine thud that sags a fifth, plus a dull noise slap. Scales with the impact,
   * so scraping a corner is a tap and running head-first into stone is a wallop.
   * @param {number} strength 0..1 from the sim
   */
  function playBump(strength) {
    const s = clamp01(strength);
    const t = now();
    const amp = lerp(0.14, 0.46, s);
    sfx('sine', 126, 46, t, 0.004, lerp(0.18, 0.3, s), amp, PRI.CUE, 0.12);
    sfxNoise('lowpass', 420, 130, 0.9, t, 0.003, 0.13, amp * 0.5, PRI.CUE);
  }

  /**
   * Gem pickup: a bright major arpeggio with an octave shimmer and a sparkle hiss.
   * Rapid successive pickups raise the whole figure two semitones per combo step, so sweeping a
   * dead end rewards the player with a rising melody instead of the same chime nine times.
   */
  function playGem() {
    const t = now();
    comboCount = t < comboUntil ? Math.min(comboCount + 1, AUDIO.COMBO_MAX) : 0;
    comboUntil = t + AUDIO.COMBO_WINDOW;
    const root = 659.25 * semitone(comboCount * 2); // E5 upward
    // Major triad: unambiguously "good", against the minor ambience underneath.
    sfx('triangle', root, root, t, 0.004, 0.26, 0.17, PRI.CUE, 0.25, 2, 0.22);
    sfx('triangle', root * 1.26, root * 1.26, t + 0.06, 0.004, 0.24, 0.15, PRI.CUE, 0.25, 2, 0.2);
    sfx('triangle', root * 1.5, root * 1.5, t + 0.12, 0.004, 0.34, 0.15, PRI.CUE, 0.3, 2, 0.24);
    sfxNoise('highpass', 5200, 9000, 0.7, t, 0.008, 0.22, 0.05, PRI.STEP, 0.2);
  }

  /** Oil flask: an upward noise sweep (the whoosh) over a warm rising tone (the refill). */
  function playOil() {
    const t = now();
    sfxNoise('bandpass', 320, 3600, 1.1, t, 0.09, 0.42, 0.2, PRI.CUE, 0.18);
    sfx('triangle', 196, 294, t, 0.02, 0.5, 0.17, PRI.CUE, 0.22, 2, 0.18);
    sfx('sine', 392, 587, t + 0.04, 0.03, 0.42, 0.08, PRI.CUE);
  }

  /** Low fuel: a detuned minor-second swell that arrives just before the first heartbeat. */
  function playLowFuel() {
    const t = now();
    sfx('sawtooth', 146.8, 138, t, 0.12, 1.1, 0.09, PRI.STING, 0.4);
    sfx('sawtooth', 155.6, 146, t + 0.05, 0.14, 1.0, 0.07, PRI.STING, 0.4);
    armHeartbeat(t + 0.35);
  }

  /** Level start: a descending reverberant bell figure — "you are deeper now". */
  function playLevelStart() {
    const t = now();
    for (let i = 0; i < BELL_NOTES.length; i++) {
      // 2.76 is the classic inharmonic bell partial; the long decay feeds the dungeon reverb.
      sfx(
        'sine',
        BELL_NOTES[i],
        BELL_NOTES[i],
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

  /** Level complete: a fast ascending retro arpeggio capped with a held major chord. */
  function playFanfare() {
    const t = now();
    for (let i = 0; i < FANFARE_ARP.length; i++) {
      const f = FANFARE_ARP[i];
      sfx('square', f, f, t + i * 0.075, 0.004, 0.2, 0.1, PRI.STING, 0.25);
    }
    for (let i = 0; i < FANFARE_CHORD.length; i++) {
      const f = FANFARE_CHORD[i];
      sfx('triangle', f, f, t + 0.32, 0.01, 1.1, 0.11, PRI.STING, 0.45, 2, 0.25);
    }
    duck = 0.35; // let the fanfare own the mix; update() restores music over ~1 s
  }

  /** Game over: two sagging detuned tones plus the torch being snuffed out. */
  function playGameOver() {
    const t = now();
    sfx('sawtooth', 330, 82.4, t, 0.03, 1.5, 0.12, PRI.STING, 0.5);
    sfx('sawtooth', 392, 98, t + 0.14, 0.03, 1.45, 0.1, PRI.STING, 0.5);
    sfx('sine', 165, 41, t + 0.05, 0.02, 1.7, 0.09, PRI.STING);
    // The snuff: broadband hiss collapsing to nothing, like a flame pinched out.
    sfxNoise('lowpass', 5200, 260, 0.8, t, 0.01, 0.55, 0.22, PRI.STING, 0.3);
    duck = 0.25;
  }

  /**
   * UI blips. Deliberately plain square waves: a menu should read as the machine talking back,
   * not as another dungeon sound.
   * @param {'move'|'confirm'|'back'} kind
   */
  function playUiSound(kind) {
    const t = now();
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
   * @param {number} t
   * @param {number} period current beat period (seconds) — the split scales with it
   * @param {number} urgency 0..1 (0 = just hit the threshold, 1 = about to go dark)
   */
  function scheduleHeartbeat(t, period, urgency) {
    const amp = lerp(0.2, 0.4, urgency);
    const split = period * AUDIO.HEART.split;
    sfx('sine', 68, 40, t, 0.006, 0.19, amp, PRI.CUE);
    sfx('sine', 62, 36, t + split, 0.006, 0.16, amp * 0.66, PRI.CUE);
    sfxNoise('lowpass', 200, 90, 0.7, t, 0.004, 0.1, amp * 0.28, PRI.STEP);
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
    sfxNoise('bandpass', f, f * 0.6, 2.6, t, 0.002, rng.range(0.02, 0.06), amp, PRI.MUSIC);
  }

  // ── Generative music ────────────────────────────────────────────────────────────────────────

  /**
   * Schedule one pluck (sometimes a dyad) from the minor pentatonic, with a long reverb send.
   * A quarter of the notes drop an octave so the line does not sit in one register.
   * @param {number} t
   */
  function schedulePluck(t) {
    const st = PENTATONIC[rng.int(PENTATONIC.length)];
    const f = AUDIO.MUSIC.root * semitone(st) * (rng.chance(0.25) ? 0.5 : 1);
    const dur = rng.range(1.6, 2.6);
    tone('triangle', f, f, t, 0.012, dur, 0.085, musicBus, musicSend, 0.75, PRI.MUSIC, 2, 0.14);
    if (rng.chance(0.3)) {
      const f2 = f * semitone(7); // a fifth above: consonant with anything else in the scale
      tone('triangle', f2, f2, t + 0.09, 0.012, 1.5, 0.05, musicBus, musicSend, 0.75, PRI.MUSIC);
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
        built = buildGraph();
      }
      resumeContext();
      const running = live() && ctx.state !== 'suspended';
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

  function resumeContext() {
    if (!ctx || dead) return;
    if (ctx.state === 'suspended' || ctx.state === undefined) {
      const p = callSafe(ctx, 'resume');
      // resume() rejects when the gesture was not user-initiated — expected, and not an error.
      if (p && typeof p.catch === 'function') p.catch(noop);
    }
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
          case 'pickup':
            if (!muted) {
              if (e.kind === 'oil') playOil();
              else playGem();
            }
            break;
          case 'lowFuel':
            if (!muted) playLowFuel();
            else armHeartbeat(now() + 0.35);
            break;
          case 'levelStart':
            comboCount = 0;
            comboUntil = 0;
            disarmHeartbeat();
            if (!muted) playLevelStart();
            break;
          case 'levelComplete':
            disarmHeartbeat();
            if (!muted) playFanfare();
            break;
          case 'gameOver':
            disarmHeartbeat();
            if (!muted) playGameOver();
            break;
          case 'phase':
            onPhase(e.from, e.to, muted);
            break;
          case 'uiMove':
            if (!muted) playUiSound('move');
            break;
          case 'uiConfirm':
            if (!muted) playUiSound('confirm');
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
   */
  function onPhase(from, to, muted) {
    if (to === 'paused') {
      disarmHeartbeat();
      if (!muted) playUiSound('back');
    } else if (to === 'playing' && from === 'paused') {
      if (!muted) playUiSound('confirm');
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
          const urgency = 1 - clamp01(frac / 0.2);
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
      const droneWant = musicOn ? 0.11 : 0;
      if (droneWant !== droneAt) {
        droneAt = droneWant;
        pTarget(droneGain.gain, droneWant, t, AUDIO.TC.music);
      }
      if (pluckNext < t) pluckNext = t + rng.range(0.2, 0.9);
      while (pluckNext < t + AUDIO.LOOKAHEAD) {
        if (musicOn) schedulePluck(pluckNext);
        pluckNext += rng.range(AUDIO.MUSIC.gapMin, AUDIO.MUSIC.gapMax);
      }
    } catch (err) {
      fail(err);
    }
  }

  /**
   * How hard the current footstep should land, from the player's ground speed.
   * WHY speed and not `input.sprint`: sprinting into a wall should not sound like a full stride.
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
      if (ctx && !dead) callSafe(ctx, 'suspend');
    } catch (err) {
      fail(err);
    }
  }

  /** Resume after `suspend()`. No-op before the first `unlock()`. */
  function resume() {
    try {
      hiddenSuspended = false;
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
      return live() && ctx.state !== 'suspended';
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
 * Call an optional context method (`resume`/`suspend`/`close`) without caring whether it exists or
 * returns a promise.
 * @param {any} obj
 * @param {string} method
 * @returns {any} whatever the method returned, or undefined
 */
function callSafe(obj, method) {
  try {
    if (obj && typeof obj[method] === 'function') return obj[method]();
  } catch {
    /* suspend() on an already-closed context throws — harmless */
  }
  return undefined;
}
