// @ts-check
/**
 * @file The single input funnel: keyboard, mouse (pointer lock), gamepad and touch collapsed into
 * one `InputFrame` per simulation step.
 *
 * Contract (ARCHITECTURE.md §4.3): `createInput(canvasEl, opts?) → { poll(), setOptions(o),
 * requestPointerLock(), updateOverlay(state), destroy(), isTouch, pointerLocked }`, plus two
 * additive members — `setBindings(tables)` (keyboard remap) and `wantsPointer` (for a
 * "click to look" prompt) — documented on the {@link Input} typedef below.
 *
 * ## Invariants this module guarantees
 *
 * 1. **`poll()` allocates nothing.** One `InputFrame` object and one `Set` are created at
 *    construction and reused forever; actions travel as a 9-bit integer mask until the moment they
 *    are written into that `Set`. The only allocation left in the poll path is the array
 *    `navigator.getGamepads()` builds, which is the browser's, not ours: Chrome returns a fresh
 *    4-element array on **every** call, plugged in or not, so while no pad has been seen the poll
 *    probes only once every `PAD_PROBE_POLLS + 1` polls (≈ twice a second) instead of 60 times a
 *    second, and a `gamepadconnected` event promotes it to per-poll sampling immediately.
 *    Consumers must **not retain the frame** across steps.
 * 2. **No stuck keys.** `blur`, `visibilitychange`, pointer-lock loss and `touchcancel` all clear
 *    every held state. A key released while the tab was hidden can never leave the player walking
 *    into a wall forever.
 * 3. **`destroy()` leaks nothing.** Every listener is registered through one helper that records
 *    it; `destroy()` removes all of them, drops the overlay, restores the styles it changed and
 *    releases pointer lock.
 * 4. **The page keeps working.** `preventDefault` is called only for keys the game actually binds,
 *    only when no modifier is held, and never while a text field has focus — browser shortcuts,
 *    dev tools and any future text entry all keep working. Scroll/zoom suppression is scoped to
 *    the game element, never the document.
 * 5. **Testable without a DOM.** Every global is reached through an injectable `opts.env`
 *    (`{window, document, navigator, performance}`), so `input.test.mjs` drives the whole module
 *    with fake event targets in plain Node.
 *
 * ## Units
 * `moveX/moveY/turn` are dimensionless -1..1 (the sim scales them by speed and `dt`). `lookDX` is
 * **radians** already multiplied by sensitivity and invert — it is applied to the player's yaw
 * directly, not scaled by `dt`, because a mouse delta is a displacement, not a rate.
 */

import { clamp } from '../core/math.js';
import { createLogger } from '../core/log.js';
import { createTouchOverlay } from './touch-overlay.js';
import {
  ACTIONS,
  ACTION_BIT,
  ACTION_COUNT,
  NAV_MASK,
  HOLD,
  HOLD_COUNT,
  DEFAULT_BINDINGS,
  PREVENT_DEFAULT_CODES,
  GAMEPAD_BUTTON_ACTION,
  GAMEPAD_BUTTON_HOLD,
  DEADZONE,
  radialDeadzone,
  axisDeadzone,
  codeFromKey,
} from './bindings.js';

/** @typedef {import('../core/types.js').InputFrame} InputFrame */
/** @typedef {import('../core/types.js').InputAction} InputAction */

// ─── Tuning (units in the name; everything here is a considered constant, not a magic number) ──

/**
 * Yaw radians per pixel of mouse movement at sensitivity 1.0. 0.0024 rad/px ≈ 0.138°/px, which
 * puts a 180° turn at ~1300 px — close to the classic Quake feel at 400 dpi and comfortable at the
 * 0.2…3 sensitivity range the options screen offers.
 */
const MOUSE_RAD_PER_PX = 0.0024;

/**
 * Yaw radians per pixel of touch drag at sensitivity 1.0. Hotter than the mouse because a thumb
 * can only sweep a fraction of the screen before it runs out of travel: ~800 px for a full 180°.
 */
const TOUCH_RAD_PER_PX = 0.0038;

/**
 * Milliseconds after pointer lock engages during which `mousemove` is ignored; the very first move
 * after engagement is always ignored too. That is where Chrome delivers its one bogus jumbo delta
 * (the cursor's jump from wherever it was to the lock origin). Guarding the *moment* rather than
 * clamping *every* event matters: Chrome coalesces `mousemove` per animation frame and sums
 * `movementX`, and with `unadjustedMovement` those are raw device counts, so a 1600–3200 DPI mouse
 * legitimately reports several hundred counts in one frame of an ordinary flick. A per-event clamp
 * silently capped fast turns for exactly the players most likely to care. Losing one frame of real
 * motion on engagement is imperceptible.
 */
const LOCK_SETTLE_MS = 50;

/**
 * A single `movementX` larger than this, in pixels, is discarded (not clamped) as a driver or wake
 * glitch. 2000 counts in one ~16 ms frame is ~120 000 counts/s — beyond any real sensor and hand —
 * so nothing a human does is touched, while a garbage value is dropped rather than turned into a
 * maximum-size spin. {@link MAX_LOOK_PER_POLL} still backstops a flood of plausible values.
 */
const MAX_MOUSE_EVENT_PX = 2000;

/**
 * Hard ceiling on the yaw accumulated between two polls, in radians. Half a turn per sim step is
 * already beyond any deliberate flick; anything larger is a bug or a hostile input source.
 */
const MAX_LOOK_PER_POLL = Math.PI;

/** Radius of the virtual stick in CSS px. Must match `RING_RADIUS` in `touch-overlay.js`. */
const STICK_RADIUS_PX = 60;

/** Fraction of the viewport width reserved for the virtual stick (ARCHITECTURE.md §4.3). */
const STICK_ZONE_FRACTION = 0.4;

/** Deadzone for the virtual stick. Smaller than a gamepad's: a thumb has no spring return. */
const TOUCH_DEADZONE = 0.12;

/**
 * Sprint on touch is an **outward flick**, not a deflection threshold.
 *
 * The stick's origin slides (see {@link updateStick}), so *any* drag past the ring pins the
 * magnitude at exactly 1 — a thumb dragged naturally across the glass would otherwise sprint
 * permanently and burn fuel 1.5× with no way to walk except holding inside a moving 60 px window.
 * Instead: travel this multiple of the ring radius away from the point the thumb **landed**,
 * within {@link TOUCH_SPRINT_FLICK_MS}, and sprint latches; bring the thumb back inside the ring
 * (relative to that same landing point) and it unlatches. Sprint becomes a decision again.
 */
const TOUCH_SPRINT_FLICK_RATIO = 1.4;

/**
 * Milliseconds the flick above must complete in. Long enough for a deliberate shove (a thumb
 * covers ~85 px in well under a fifth of a second), short enough that slowly dragging the stick
 * around while exploring never trips it.
 */
const TOUCH_SPRINT_FLICK_MS = 260;

/**
 * Deflection the thumb must keep to stay sprinting once the flick has latched it. Easing back off
 * the rim drops to a walk, which is the same gesture a stick-and-trigger player would make.
 */
const TOUCH_SPRINT_HOLD = 0.9;

/** Seconds a menu direction must be held before it starts repeating. */
const NAV_REPEAT_DELAY_S = 0.42;

/** Seconds between repeats once repeating has started (~9/s: fast but still countable). */
const NAV_REPEAT_INTERVAL_S = 0.11;

/** Stick deflection that starts a menu move, and the lower value that must be crossed to re-arm. */
const NAV_ON = 0.55;
const NAV_OFF = 0.35;

/** Upper bound on the measured inter-poll delta, in seconds (a hidden tab can stall for minutes). */
const MAX_POLL_DT_S = 0.25;

/** Clamp for the `sensitivity` option, matching `Settings.sensitivity` in ARCHITECTURE.md §3. */
const SENS_MIN = 0.2;
const SENS_MAX = 3;

/**
 * Right-stick yaw response: `mix·x³ + (1-mix)·x`. The cubic term buys fine control near centre
 * (where a player aims) while keeping full rate at the rim (where they spin).
 */
const STICK_CURVE_MIX = 0.7;

/**
 * Number of polls skipped between `getGamepads()` probes while no pad has ever been seen.
 * 30 ⇒ one probe every ~0.5 s at 60 Hz, which is far below the time it takes a human to plug a
 * controller in and reach for it, and 97 % fewer throwaway arrays than probing every frame.
 */
const PAD_PROBE_POLLS = 30;

/**
 * Axes tracked for the non-standard-mapping baseline guard. Standard mapping defines 4; 8 covers
 * the wheels/flight sticks that report a hat or a clutch as extra axes without growing the arrays.
 */
const PAD_AXIS_MAX = 8;

/**
 * Longest a user gesture is assumed to still authorise a pointer-lock request, in ms. Chrome's
 * transient activation window is 5 s; asking at 4 s leaves margin for a slow frame and means a
 * keyboard resume (Enter on the pause menu) can re-lock on the following step rather than leaving
 * the mouse silently dead until the player thinks to click.
 */
const GESTURE_GRACE_MS = 4000;

/**
 * Minimum gap between two *automatic* pointer-lock requests while one is still awaiting a verdict
 * (or none has been refused yet), in ms. A click always goes now.
 */
const AUTO_LOCK_COOLDOWN_MS = 1200;

/**
 * Gap before retrying after an automatic request was **refused**, in ms. Chrome refuses a lock
 * requested within about a second of the player releasing it with Escape, which is exactly the
 * Esc-pause → Enter-resume path; waiting the full cooldown after that refusal left the mouse dead
 * for ~1.2 s. Short steps land the lock as soon as the browser allows it.
 */
const AUTO_LOCK_RETRY_MS = 250;

/**
 * Consecutive refusals after which the automatic request gives up until the next successful lock
 * or click. 8 retries at {@link AUTO_LOCK_RETRY_MS} cover ~2 s — past Chrome's post-Escape window —
 * while an environment that refuses every time (an iframe without `allow="pointer-lock"`) is left
 * alone after that instead of being asked forever. {@link GESTURE_GRACE_MS} bounds it as well.
 */
const AUTO_LOCK_MAX_FAILS = 8;

// ─── Public types ────────────────────────────────────────────────────────────────────────────

/**
 * Injectable globals. Every one defaults to the real global; Node tests pass fakes. Supplying a
 * partial object is fine — missing members fall back individually.
 * @typedef {Object} InputEnv
 * @property {any} [window]
 * @property {any} [document]
 * @property {any} [navigator]
 * @property {any} [performance]
 */

/**
 * @typedef {Object} InputOptions
 * @property {number} [sensitivity]   look multiplier, clamped to 0.2…3 (default 1)
 * @property {boolean} [invertLook]   flip the yaw direction of mouse/touch look (default false)
 * @property {() => boolean} [shouldLockPointer]
 *   Predicate asked on every canvas click: return true only while the player is actually playing,
 *   so clicking a menu never swallows the cursor. Default: always false (main.js opts in).
 * @property {HTMLElement|null} [touchRoot]
 *   Container for the on-screen controls. Defaults to `#touch`, else the canvas's parent.
 * @property {boolean} [touchOverlay]  set false to suppress the on-screen controls entirely
 * @property {import('./bindings.js').BindingTables|null} [bindings]
 *   keyboard layout from `createBindings(overrides)`; the default layout when omitted
 * @property {InputEnv} [env]          injectable globals (tests)
 */

/**
 * @typedef {Object} Input
 * @property {() => InputFrame} poll                one reused frame; never retain it
 * @property {(o: InputOptions) => void} setOptions partial update; unknown keys ignored
 * @property {() => void} requestPointerLock        safe to call any time; no-ops when unsupported
 * @property {(state: {phase?: string, settings?: {mapMode?: string}}|null|undefined) => void} updateOverlay
 *   Forwards the phase — and the map mode, which decides where the button bar sits — to the touch
 *   overlay (no-op without one). Pass the whole `GameState`; call it once per frame.
 * @property {(tables: import('./bindings.js').BindingTables|null|undefined) => void} setBindings
 *   swap the keyboard layout (`createBindings(overrides)`; null restores the defaults). Held keys
 *   are released, because a key held across the swap would decrement a different slot on keyup.
 * @property {() => void} destroy                   removes every listener and DOM node
 * @property {boolean} isTouch                      true once the device has proven it is touch
 * @property {boolean} pointerLocked                true while the canvas owns the pointer
 * @property {boolean} wantsPointer
 *   true while the game wants mouse look but does not have the pointer (playing, not touch, lock
 *   supported, not locked) — the HUD can show "CLICK TO LOOK" from it. Covers the gap while the
 *   browser refuses an automatic re-lock right after an Escape.
 */

// ─── Implementation ──────────────────────────────────────────────────────────────────────────

/**
 * Create the input funnel bound to `canvasEl`.
 *
 * @param {HTMLElement|any} canvasEl  the element that owns pointer lock and touch gestures
 *   (`#overlay` in `index.html` — the topmost canvas, which covers the viewport)
 * @param {InputOptions} [opts]
 * @returns {Input}
 */
export function createInput(canvasEl, opts) {
  const log = createLogger('input');
  const o = opts || {};
  const env = o.env || {};

  /** @type {any} */
  const win = env.window || (typeof window !== 'undefined' ? window : null);
  /** @type {any} */
  const doc = env.document || (win && win.document) || (typeof document !== 'undefined' ? document : null);
  /** @type {any} */
  const nav = env.navigator || (win && win.navigator) || (typeof navigator !== 'undefined' ? navigator : null);
  /** @type {any} */
  const perf = env.performance || (win && win.performance) || (typeof performance !== 'undefined' ? performance : null);

  /** Monotonic ms clock; only ever used for *differences*, so a `Date.now` fallback is fine. */
  const now = perf && typeof perf.now === 'function' ? () => perf.now() : () => Date.now();

  /**
   * The element gestures are bound to. Falling back to `document.body` keeps a mis-wired boot
   * playable with the keyboard instead of throwing on the composition root's first line.
   * @type {any}
   */
  const target = canvasEl && typeof canvasEl.addEventListener === 'function' ? canvasEl : doc ? doc.body : null;
  if (!target) log.warn('no DOM target: input is inert');

  // ── Options ───────────────────────────────────────────────────────────────────────────────
  let sensitivity = clamp(typeof o.sensitivity === 'number' ? o.sensitivity : 1, SENS_MIN, SENS_MAX);
  let invertSign = o.invertLook === true ? -1 : 1;
  /** @type {() => boolean} */
  let shouldLockPointer = typeof o.shouldLockPointer === 'function' ? o.shouldLockPointer : () => false;

  /** Active keyboard tables; swapped whole by `setBindings`, read with one property lookup each. */
  let keyHold = DEFAULT_BINDINGS.keyHold;
  let keyActionMask = DEFAULT_BINDINGS.keyActionMask;

  // ── Reused frame (invariant 1) ────────────────────────────────────────────────────────────
  /** @type {Set<InputAction>} */
  const pressed = new Set();
  /** @type {InputFrame} */
  const frame = { moveX: 0, moveY: 0, turn: 0, lookDX: 0, sprint: false, pressed };

  // ── Device state ──────────────────────────────────────────────────────────────────────────
  /** Press counts per hold slot: two keys bound to the same slot must both be released to stop. */
  const hold = new Int32Array(HOLD_COUNT);
  /**
   * Codes currently down, so a repeated `keydown` is idempotent and every `keyup` is symmetric.
   * @type {Set<string>}
   */
  const heldCodes = new Set();
  /** Edge-triggered actions accumulated since the last poll, as a bitmask. */
  let pendingMask = 0;
  /** Yaw radians accumulated from mouse/touch since the last poll (sensitivity already applied). */
  let lookAccum = 0;
  /** True while a non-locked left-button drag is steering (pointer-lock fallback). */
  let dragging = false;

  // Touch gesture state. `-1` identifiers mean "no touch claimed".
  let stickId = -1;
  let stickOriginX = 0;
  let stickOriginY = 0;
  let stickX = 0; // normalised -1..1, right positive
  let stickY = 0; // normalised -1..1, forward positive
  /** Where the thumb first landed (the sliding origin moves; this does not) and when. */
  let stickDownX = 0;
  let stickDownY = 0;
  let stickDownMs = 0;
  /** Latched by an outward flick; see {@link TOUCH_SPRINT_FLICK_RATIO}. */
  let stickSprint = false;
  let lookId = -1;
  let lookLastX = 0;
  let touchDetected = false;

  // Gamepad state.
  /** Previous pressed bits, for edge detection. 32 covers every standard-mapping pad. */
  const padPrev = new Uint8Array(32);
  let padIndex = -1;
  /** Set after any discontinuity (blur, (re)connect): the next poll re-baselines without edges. */
  let padResync = true;
  /** True when the adopted pad reports W3C `mapping: 'standard'` — i.e. its indices mean anything. */
  let padStandard = true;
  /** Resting axis values captured on the resync poll, for the non-standard baseline guard. */
  const padAxisBase = new Float64Array(PAD_AXIS_MAX);
  /** 1 once a non-standard axis has moved away from its baseline and may be trusted. */
  const padAxisLive = new Uint8Array(PAD_AXIS_MAX);
  /** 1 once a non-standard button has been observed *released* and may be trusted. */
  const padBtnLive = new Uint8Array(32);
  /** True once a pad has been seen connected; gates the per-poll `getGamepads()` allocation. */
  let padSeen = false;
  /** Polls left to skip before the next probe while `padSeen` is false. */
  let padProbeSkips = 0;
  /** Directions currently held on d-pad/stick, for software auto-repeat. */
  let navHoldMask = 0;
  let navRepeatTimer = 0;
  /** Scratch vector for `radialDeadzone` — module-level so the poll path allocates nothing. */
  const stickScratch = new Float64Array(2);

  // Per-poll gamepad contributions (module-scope to avoid returning objects from helpers).
  let padMoveX = 0;
  let padMoveY = 0;
  let padTurn = 0;
  let padSprint = false;

  let lastPollMs = now();
  let destroyed = false;

  // Pointer-lock re-acquisition state (see maybeAutoLock).
  /** Timestamp of the last user gesture, which is what authorises a pointer-lock request. */
  let lastGestureMs = -1e9;
  /** Timestamp of the last *automatic* request, for the cooldown. */
  let lastAutoLockMs = -1e9;
  /** True between an automatic request and its verdict, so only its failures are counted. */
  let autoLockPending = false;
  /** Consecutive automatic refusals; at AUTO_LOCK_MAX_FAILS the module stops asking. */
  let autoLockFails = 0;
  /** When the pointer lock last engaged; mouse moves inside LOCK_SETTLE_MS of it are dropped. */
  let lockEngagedMs = -1e9;
  /** True until the first mouse move after the lock engaged has been seen (and dropped). */
  let lockFirstMove = false;

  // ── Listener bookkeeping (invariant 3) ────────────────────────────────────────────────────
  /** @type {{t:any, type:string, fn:Function, opt:any}[]} */
  const bound = [];
  /**
   * @param {any} t
   * @param {string} type
   * @param {Function} fn
   * @param {any} [opt]
   */
  function listen(t, type, fn, opt) {
    if (!t || typeof t.addEventListener !== 'function') return;
    t.addEventListener(type, fn, opt);
    bound.push({ t, type, fn, opt });
  }

  // ── Touch overlay ─────────────────────────────────────────────────────────────────────────
  /** @type {import('./touch-overlay.js').TouchOverlay|null} */
  let overlay = null;

  /** Route an overlay button press into the same edge-triggered mask the keyboard uses. */
  const fireAction = (/** @type {InputAction} */ action) => {
    pendingMask |= ACTION_BIT[action] | 0;
  };

  /**
   * Create the on-screen controls the first time we are sure the device is touch-driven.
   * Deferred (rather than built at construction) so a desktop with a touchscreen never gets a
   * joystick drawn over its dungeon until a finger actually lands on the glass.
   */
  function ensureOverlay() {
    if (overlay || o.touchOverlay === false || !doc) return;
    const root =
      o.touchRoot ||
      (typeof doc.getElementById === 'function' ? doc.getElementById('touch') : null) ||
      (target && target.parentNode) ||
      doc.body;
    if (!root) return;
    overlay = createTouchOverlay(root, { onAction: fireAction, document: doc });
    log.debug('touch overlay created');
  }

  /**
   * Latch "this is a touch device" on the first real touch. `maxTouchPoints`/media queries are
   * only used as a hint at construction because both lie on hybrid laptops.
   */
  function markTouch() {
    if (touchDetected) return;
    touchDetected = true;
    ensureOverlay();
  }

  // Touch-primary devices (phones/tablets) get the controls immediately so the player sees them
  // on the title screen rather than after a mystery first tap.
  if (win && typeof win.matchMedia === 'function') {
    try {
      const coarse = win.matchMedia('(pointer: coarse)');
      const fine = win.matchMedia('(any-pointer: fine)');
      if (coarse && coarse.matches && !(fine && fine.matches)) markTouch();
    } catch {
      // matchMedia can throw on an invalid query in very old engines; the lazy path still works.
    }
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────────────────────

  /** True when focus is inside a text-entry control, where the game must not steal keys. */
  function textFieldFocused() {
    if (!doc) return false;
    const el = doc.activeElement;
    if (!el) return false;
    if (el.isContentEditable === true) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  /** @param {any} e */
  function onKeyDown(e) {
    if (!e) return;
    // Let every browser/OS shortcut through untouched: a modified key is never a game binding.
    if (e.ctrlKey || e.metaKey || e.altKey) {
      // Known browser quirk: while Cmd is down, macOS/WebKit swallow the `keyup` of other keys, so
      // a key released during a Cmd combo would stay "held" forever. Dropping the held state the
      // moment Cmd appears costs nothing (the player is talking to the OS, not the game).
      if (e.metaKey) clearHeld();
      return;
    }
    // An unmodified keypress is a user gesture, and a gesture is what a pointer-lock request
    // needs. Recorded for every key (bound or not) so resuming a paused game from the keyboard can
    // take the pointer back on the next step — see maybeAutoLock. Deliberately *only* the
    // keyboard: a mouse player's click already locks directly in `onClick`, and treating clicks as
    // standing authorisation would have the module asking for the pointer behind gestures the
    // player aimed at something else.
    lastGestureMs = now();

    const code = e.code || codeFromKey(e.key);
    if (!code) return;

    const slot = keyHold[code];
    const mask = keyActionMask[code] | 0;
    if (slot === undefined && mask === 0) return; // not ours: leave the default alone

    const first = !heldCodes.has(code);
    if (first) {
      heldCodes.add(code);
      if (slot !== undefined) hold[slot]++;
    }
    if (mask !== 0) {
      // A held key must not machine-gun `confirm`; menu directions, however, *should* repeat, and
      // the OS repeat rate is exactly the cadence players expect from a list.
      pendingMask |= first && !e.repeat ? mask : mask & NAV_MASK;
    }
    if (PREVENT_DEFAULT_CODES.has(code) && !textFieldFocused() && e.cancelable !== false) {
      // `Tab` is the one entry in that set whose default is a keyboard user's ONLY way to move
      // focus off the canvas (WCAG 2.1.2, "No Keyboard Trap"). Swallow it just where the binding
      // earns it — during actual play, where it is a second name for the map — and never for
      // Shift+Tab, so focus can always walk back out. `M` covers the map everywhere else.
      const focusEscape = code === 'Tab' && (e.shiftKey === true || !shouldLockPointer());
      if (!focusEscape && typeof e.preventDefault === 'function') e.preventDefault();
    }
  }

  /** @param {any} e */
  function onKeyUp(e) {
    if (!e) return;
    const code = e.code || codeFromKey(e.key);
    if (!code || !heldCodes.delete(code)) return;
    const slot = keyHold[code];
    if (slot !== undefined && hold[slot] > 0) hold[slot]--;
  }

  // ── Focus / visibility (invariant 2) ──────────────────────────────────────────────────────

  /**
   * Drop every continuous input. Edge-triggered actions already queued are kept: the player did
   * press them, and swallowing a `pause` on the way out of focus would be its own bug.
   */
  function clearHeld() {
    heldCodes.clear();
    hold.fill(0);
    lookAccum = 0;
    dragging = false;
    releaseStick();
    lookId = -1;
    navHoldMask = 0;
    navRepeatTimer = 0;
    // A button still down when focus returns would otherwise read as a fresh press.
    padResync = true;
  }

  const onBlur = () => clearHeld();
  const onVisibility = () => {
    if (doc && doc.hidden) clearHeld();
  };

  // ── Mouse ─────────────────────────────────────────────────────────────────────────────────

  /** True while the canvas owns the pointer. */
  function isLocked() {
    return !!doc && doc.pointerLockElement === target;
  }

  /**
   * Accumulate a yaw delta in radians, applying sensitivity and the invert setting once, here, so
   * every look source stays consistent.
   * @param {number} radians
   */
  function addLook(radians) {
    lookAccum += radians * sensitivity * invertSign;
  }

  /** @param {any} e */
  function onMouseMove(e) {
    if (!e) return;
    if (!isLocked() && !(dragging && shouldLockPointer())) return;
    const dx = e.movementX;
    if (typeof dx !== 'number' || !Number.isFinite(dx)) return;
    // Engagement spike guard (see LOCK_SETTLE_MS): only right after the lock lands.
    if (lockFirstMove) {
      lockFirstMove = false;
      return;
    }
    if (now() - lockEngagedMs < LOCK_SETTLE_MS) return;
    // Glitch guard (see MAX_MOUSE_EVENT_PX): discarded, never clamped into a maximum-size turn.
    if (dx > MAX_MOUSE_EVENT_PX || dx < -MAX_MOUSE_EVENT_PX) return;
    addLook(dx * MOUSE_RAD_PER_PX);
  }

  /** @param {any} e */
  function onMouseDown(e) {
    if (e && e.button === 0) dragging = true;
  }

  const onMouseUp = () => {
    dragging = false;
  };

  /**
   * Pointer lock may only be requested from a user gesture. A click is the most direct one, and it
   * asks only while the predicate says the player is playing.
   */
  const onClick = () => {
    // A deliberate click is also the player telling us to try again after we gave up.
    autoLockFails = 0;
    if (touchDetected || isLocked() || !shouldLockPointer()) return;
    requestPointerLock();
  };

  /** Record that an automatic request was refused, and stop asking once it is clearly hopeless. */
  function noteLockRefused() {
    if (!autoLockPending) return;
    autoLockPending = false;
    autoLockFails++;
  }

  const onPointerLockChange = () => {
    // Either direction is a discontinuity: releasing the pointer (Esc) abandons a half-gesture the
    // player has stopped watching, and *acquiring* it is where browsers are known to deliver one
    // bogus jumbo delta. Drop whatever has accumulated and start the next poll clean.
    dragging = false;
    lookAccum = 0;
    if (isLocked()) {
      autoLockPending = false;
      autoLockFails = 0;
      lockEngagedMs = now();
      lockFirstMove = true;
    } else {
      lockFirstMove = false;
    }
  };

  const onPointerLockError = () => {
    noteLockRefused();
    log.debug('pointer lock refused');
  };

  /**
   * Take the pointer back when the game is being played without it.
   *
   * Pointer lock is released on every exit from `playing` (main.js does that so a menu gets its
   * cursor back), and it is only ever *re-*acquired by a canvas click. A player who resumes the
   * pause menu with Enter — or starts a game from the title screen with the keyboard — therefore
   * lands back in the dungeon with a mouse that silently does nothing, with no prompt to click.
   * (A player who resumes by *clicking* the menu row is already fine: the phase has flipped by the
   * time `click` fires, so `onClick` locks.) Asking here, once per step, fixes the keyboard case:
   * a keydown grants transient activation that is still valid on the following frame, so the
   * request succeeds — the gesture is real, just one frame old. Guarded three ways so it can never turn
   * into a request storm: only with a recent gesture, at most once per {@link AUTO_LOCK_COOLDOWN_MS},
   * and never again after {@link AUTO_LOCK_MAX_FAILS} refusals until a lock actually lands.
   */
  function maybeAutoLock() {
    if (destroyed || touchDetected || autoLockFails >= AUTO_LOCK_MAX_FAILS) return;
    if (!target || typeof target.requestPointerLock !== 'function') return;
    if (isLocked() || !shouldLockPointer()) return;
    const t = now();
    if (t - lastGestureMs > GESTURE_GRACE_MS) return;
    // A request still awaiting its verdict gets the full cooldown; a refused one is retried soon.
    const gap = autoLockPending || autoLockFails === 0 ? AUTO_LOCK_COOLDOWN_MS : AUTO_LOCK_RETRY_MS;
    if (t - lastAutoLockMs < gap) return;
    lastAutoLockMs = t;
    autoLockPending = true;
    requestPointerLock();
  }

  // ── Touch ─────────────────────────────────────────────────────────────────────────────────

  /** Forget the virtual stick and hide it. */
  function releaseStick() {
    stickId = -1;
    stickX = 0;
    stickY = 0;
    stickSprint = false;
    if (overlay) overlay.setStick(false, 0, 0, 0, 0, false);
  }

  /**
   * Recompute the stick vector from a thumb position, moving the origin when the thumb travels
   * past the ring. A sliding origin is what stops a long drag from pinning the stick at full
   * deflection with no way back — the ring follows the thumb like a real stick's gate.
   * @param {number} x client X in CSS px
   * @param {number} y client Y in CSS px
   */
  function updateStick(x, y) {
    let dx = x - stickOriginX;
    let dy = y - stickOriginY;
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag > STICK_RADIUS_PX) {
      const k = STICK_RADIUS_PX / mag;
      // Drag the origin so the thumb sits exactly on the rim.
      stickOriginX = x - dx * k;
      stickOriginY = y - dy * k;
      dx *= k;
      dy *= k;
    }
    const nx = dx / STICK_RADIUS_PX;
    const ny = dy / STICK_RADIUS_PX;
    const deflection = radialDeadzone(nx, ny, TOUCH_DEADZONE, stickScratch);

    // Sprint latches on a shove and holds while the thumb stays out at the rim.
    //
    // It is judged against the point the thumb LANDED on, which the sliding origin above has by
    // then left behind — that displacement is the only part of the gesture the rim clamp does not
    // throw away, so it is the only place "the player shoved forward" can honestly be read from.
    // Deflection alone cannot say it: past the ring the deflection is *always* exactly 1.
    if (stickSprint) {
      if (deflection < TOUCH_SPRINT_HOLD) stickSprint = false;
    } else {
      const tdx = x - stickDownX;
      const tdy = y - stickDownY;
      const travel = Math.sqrt(tdx * tdx + tdy * tdy);
      if (
        travel >= STICK_RADIUS_PX * TOUCH_SPRINT_FLICK_RATIO &&
        now() - stickDownMs <= TOUCH_SPRINT_FLICK_MS
      ) {
        stickSprint = true;
      }
    }

    stickX = stickScratch[0];
    // Screen Y grows downward; forward is up the screen.
    stickY = -stickScratch[1];
    if (overlay) {
      overlay.setStick(true, stickOriginX, stickOriginY, stickOriginX + dx, stickOriginY + dy, stickSprint);
    }
  }

  /** @param {any} e */
  function onTouchStart(e) {
    markTouch();
    if (!e || !e.changedTouches) return;
    // The game element owns its gestures: no scrolling, no pinch-zoom, no double-tap-zoom, and no
    // long-press selection. Scoped to this element, so the rest of the page is untouched.
    if (e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();

    const rect = target && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
    const left = rect ? rect.left : 0;
    const width = rect && rect.width > 0 ? rect.width : win && win.innerWidth ? win.innerWidth : 1;
    const zone = left + width * STICK_ZONE_FRACTION;

    const list = e.changedTouches;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      if (t.clientX < zone) {
        if (stickId !== -1) continue; // one thumb per stick
        stickId = t.identifier;
        stickOriginX = t.clientX;
        stickOriginY = t.clientY;
        stickDownX = t.clientX;
        stickDownY = t.clientY;
        stickDownMs = now();
        stickSprint = false;
        updateStick(t.clientX, t.clientY);
      } else {
        if (lookId !== -1) continue;
        lookId = t.identifier;
        lookLastX = t.clientX;
      }
    }
  }

  /** @param {any} e */
  function onTouchMove(e) {
    if (!e || !e.changedTouches) return;
    if (e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
    const list = e.changedTouches;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      if (t.identifier === stickId) {
        updateStick(t.clientX, t.clientY);
      } else if (t.identifier === lookId) {
        const dx = t.clientX - lookLastX;
        lookLastX = t.clientX;
        if (Number.isFinite(dx)) addLook(dx * TOUCH_RAD_PER_PX);
      }
    }
  }

  /** @param {any} e */
  function onTouchEnd(e) {
    if (!e || !e.changedTouches) return;
    const list = e.changedTouches;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      if (t.identifier === stickId) releaseStick();
      else if (t.identifier === lookId) lookId = -1;
    }
  }

  /** iOS pinch-zoom gestures and the context menu are never wanted over the play area. */
  const swallow = (/** @type {any} */ e) => {
    if (e && e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
  };

  // ── Gamepad ───────────────────────────────────────────────────────────────────────────────

  const onGamepadConnected = () => {
    padResync = true;
    padSeen = true; // promote the poll from probing to sampling immediately
    padProbeSkips = 0;
    log.debug('gamepad connected');
  };
  const onGamepadDisconnected = () => {
    padIndex = -1;
    padPrev.fill(0);
    padResync = true;
    // Fall back to probing. A reconnect fires `gamepadconnected` again in every engine, and the
    // probe would find the pad within half a second even if one did not.
    padSeen = false;
    padProbeSkips = 0;
  };

  /**
   * Drive the software auto-repeat for menu directions coming from the d-pad/stick, which — unlike
   * a keyboard — get no repeat from the OS.
   * @param {number} mask  directions currently held (subset of NAV_MASK)
   * @param {number} dt    seconds since the previous poll
   */
  function updateNavRepeat(mask, dt) {
    const fresh = mask & ~navHoldMask;
    if (fresh !== 0) {
      pendingMask |= fresh;
      navRepeatTimer = NAV_REPEAT_DELAY_S;
    } else if (mask !== 0) {
      navRepeatTimer -= dt;
      if (navRepeatTimer <= 0) {
        pendingMask |= mask;
        navRepeatTimer = NAV_REPEAT_INTERVAL_S;
      }
    }
    navHoldMask = mask;
  }

  /**
   * Turn a normalised axis pair into held menu directions, with hysteresis so a thumb resting near
   * the threshold does not chatter between "held" and "released".
   * @param {number} x
   * @param {number} y  forward-positive
   * @returns {number} subset of NAV_MASK
   */
  function navBitsFromAxes(x, y) {
    let m = 0;
    const onX = navHoldMask & (ACTION_BIT.left | ACTION_BIT.right) ? NAV_OFF : NAV_ON;
    const onY = navHoldMask & (ACTION_BIT.up | ACTION_BIT.down) ? NAV_OFF : NAV_ON;
    if (x >= onX) m |= ACTION_BIT.right;
    else if (x <= -onX) m |= ACTION_BIT.left;
    if (y >= onY) m |= ACTION_BIT.up;
    else if (y <= -onY) m |= ACTION_BIT.down;
    return m;
  }

  /**
   * Fold one hold slot reported by a gamepad button into this poll's analogue contributions.
   * @param {number} slot
   */
  function applyPadHold(slot) {
    switch (slot) {
      case HOLD.FORWARD:
        padMoveY += 1;
        break;
      case HOLD.BACK:
        padMoveY -= 1;
        break;
      case HOLD.STRAFE_L:
        padMoveX -= 1;
        break;
      case HOLD.STRAFE_R:
        padMoveX += 1;
        break;
      case HOLD.TURN_L:
        padTurn -= 1;
        break;
      case HOLD.TURN_R:
        padTurn += 1;
        break;
      case HOLD.SPRINT:
        padSprint = true;
        break;
      default:
        break;
    }
  }

  /**
   * Yaw rate for a right-stick deflection, shaped by the response curve and then by the look
   * sensitivity — **without moving the ceiling**.
   *
   * A pad stick is a *rate* (`frame.turn` is clamped to ±1 and the sim multiplies it by
   * `TURN_SPEED`), where the mouse's `lookDX` is a *displacement*. Multiplying a rate by the mouse
   * slider is therefore wrong in both directions: at 3× the rate saturated at ~0.66 deflection and
   * the outer third of the stick's travel did nothing, and at 0.2× a full-stick 180° turn took
   * 4.4 s. Sensitivity bends the curve instead — the exponent `1/√s` makes the middle of the
   * travel quicker or gentler while `|x| = 1` always maps to exactly 1, so full deflection is full
   * rate at every setting and s = 1 is bit-identical to the plain cubic blend.
   *
   * @param {number} rx deadzoned axis value, -1..1
   * @returns {number} turn rate, -1..1
   */
  function padTurnResponse(rx) {
    const shaped = STICK_CURVE_MIX * rx * rx * rx + (1 - STICK_CURVE_MIX) * rx;
    let m = shaped < 0 ? -shaped : shaped;
    if (m === 0) return 0;
    if (m > 1) m = 1;
    const out = sensitivity === 1 ? m : Math.pow(m, 1 / Math.sqrt(sensitivity));
    return shaped < 0 ? -out : out;
  }

  /**
   * Value of a pad axis, guarded for pads the browser could not map.
   *
   * Chrome reports `mapping: ''` for any HID device it does not recognise — generic USB pads,
   * arcade sticks, wheels, flight sticks — and on those the axis order is whatever the device says
   * it is. Axis 2 is very often a trigger that **rests at -1**, which under the standard-mapping
   * assumption is a right stick held hard left: the camera spins at the full turn rate forever and
   * the game is unplayable for a keyboard player who merely has a cheap pad plugged in. So a
   * non-standard axis stays at 0 until it has moved more than a deadzone away from the value it
   * was resting at when the pad was adopted, at which point it has proven it is a real control.
   *
   * @param {any} axes
   * @param {number} i
   * @returns {number}
   */
  function padAxis(axes, i) {
    const raw = axes[i];
    const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    if (padStandard) return v;
    if (i >= PAD_AXIS_MAX) return 0;
    if (padAxisLive[i]) return v;
    const d = v - padAxisBase[i];
    if ((d < 0 ? -d : d) > DEADZONE) {
      padAxisLive[i] = 1;
      return v;
    }
    return 0;
  }

  /**
   * Adopt `pads[i]` as the active pad, resetting every piece of per-pad state.
   * @param {any} pad
   * @param {number} i
   */
  function adoptPad(pad, i) {
    if (padIndex === i) {
      padStandard = pad.mapping === 'standard';
      return;
    }
    padIndex = i;
    padStandard = pad.mapping === 'standard';
    padPrev.fill(0);
    padBtnLive.fill(0);
    padAxisLive.fill(0);
    padResync = true;
    log.debug('gamepad adopted', i, padStandard ? 'standard' : 'non-standard');
  }

  /**
   * Sample the active gamepad. Called once per poll; writes into the `pad*` scratch variables.
   * @param {number} dt seconds since the previous poll
   */
  function pollGamepad(dt) {
    padMoveX = 0;
    padMoveY = 0;
    padTurn = 0;
    padSprint = false;

    if (!nav || typeof nav.getGamepads !== 'function') {
      updateNavRepeat(0, dt);
      return;
    }
    // Every `getGamepads()` call allocates a fresh array in Chrome whether or not anything is
    // plugged in, so while nothing has been seen we look twice a second instead of sixty times.
    if (!padSeen) {
      if (padProbeSkips > 0) {
        padProbeSkips--;
        updateNavRepeat(0, dt);
        return;
      }
      padProbeSkips = PAD_PROBE_POLLS;
    }
    /** @type {any} */
    let pads = null;
    try {
      pads = nav.getGamepads();
    } catch {
      // Firefox throws here when the page is not focused / permission is absent.
      pads = null;
    }
    if (!pads || typeof pads.length !== 'number') {
      updateNavRepeat(0, dt);
      return;
    }

    // Selection, in priority order: the pad we are already on if it is standard (a second
    // controller must not hijack the game mid-run), else the lowest-index **standard** pad, else
    // the one we are already on, else the lowest connected index at all. A standard pad therefore
    // always wins over a non-standard one, whatever order the browser lists them in — otherwise an
    // arcade stick at index 0 would lock out the Xbox pad at index 1.
    /** @type {any} */
    let pad = null;
    /** @type {any} */
    const current = padIndex >= 0 && padIndex < pads.length ? pads[padIndex] : null;
    const currentOk = !!current && current.connected !== false;
    if (currentOk && current.mapping === 'standard') {
      pad = current;
      adoptPad(pad, padIndex);
    } else {
      let fallback = -1;
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (!p || p.connected === false) continue;
        if (p.mapping === 'standard') {
          pad = p;
          adoptPad(p, i);
          break;
        }
        if (fallback < 0) fallback = i;
      }
      if (!pad && currentOk) {
        pad = current;
        adoptPad(pad, padIndex);
      } else if (!pad && fallback >= 0) {
        pad = pads[fallback];
        adoptPad(pad, fallback);
      }
    }
    if (!pad) {
      if (padIndex !== -1) {
        padIndex = -1;
        padPrev.fill(0);
        padResync = true;
      }
      padSeen = false;
      padProbeSkips = PAD_PROBE_POLLS;
      updateNavRepeat(0, dt);
      return;
    }
    padSeen = true;

    const axes = pad.axes;
    let navMask = 0;

    if (axes && typeof axes.length === 'number') {
      if (padResync && !padStandard) {
        // Baseline for the guard in `padAxis`: whatever the device is reporting at rest, now.
        const n = axes.length < PAD_AXIS_MAX ? axes.length : PAD_AXIS_MAX;
        padAxisBase.fill(0);
        padAxisLive.fill(0);
        for (let i = 0; i < n; i++) {
          const raw = axes[i];
          padAxisBase[i] = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
        }
      }
      if (axes.length >= 2) {
        radialDeadzone(padAxis(axes, 0), padAxis(axes, 1), DEADZONE, stickScratch);
        padMoveX += stickScratch[0];
        padMoveY -= stickScratch[1]; // pads report "up" as -1
      }
      // The right stick is read from axis 2 **only under standard mapping**. On an unmapped device
      // that index is as likely to be a trigger, a hat or a rudder, and a wrong guess here spins
      // the camera rather than merely doing nothing.
      //
      // A radial deadzone over the whole right stick (only its X is used), so a thumb pushing
      // slightly off-horizontal loses turn speed exactly the way the left stick loses move speed.
      if (padStandard && axes.length >= 4) {
        radialDeadzone(axes[2], axes[3], DEADZONE, stickScratch);
        padTurn += padTurnResponse(stickScratch[0]);
      } else if (padStandard && axes.length === 3) {
        padTurn += padTurnResponse(axisDeadzone(axes[2], DEADZONE));
      }
    }

    const buttons = pad.buttons;
    if (buttons && typeof buttons.length === 'number') {
      const n = buttons.length < padPrev.length ? buttons.length : padPrev.length;
      for (let i = 0; i < n; i++) {
        const b = buttons[i];
        // GamepadButton objects, but some polyfills/remote pads report plain numbers.
        const down =
          b == null
            ? 0
            : typeof b === 'number'
              ? b > 0.5
                ? 1
                : 0
              : b.pressed === true || (typeof b.value === 'number' && b.value > 0.5)
                ? 1
                : 0;
        // Same guard as the axes, for the same reason: an unmapped pad whose resting trigger reads
        // as "button 6 pressed" would otherwise sprint forever. A button counts only once it has
        // been observed released at least once.
        if (!down) padBtnLive[i] = 1;
        const trusted = padStandard || padBtnLive[i] === 1;
        if (down && trusted) {
          const am = GAMEPAD_BUTTON_ACTION[i] | 0;
          if (am !== 0) {
            navMask |= am & NAV_MASK;
            const nonNav = am & ~NAV_MASK;
            // Edge-triggered, and suppressed entirely on the first poll after a (re)connect so a
            // button already held when the pad appears cannot fire a phantom press.
            if (nonNav !== 0 && padPrev[i] === 0 && !padResync) pendingMask |= nonNav;
          }
          const hs = GAMEPAD_BUTTON_HOLD[i];
          if (hs !== undefined) applyPadHold(hs);
        }
        padPrev[i] = down;
      }
    }

    padMoveX = clamp(padMoveX, -1, 1);
    padMoveY = clamp(padMoveY, -1, 1);
    // Clamped BEFORE it meets the keyboard's contribution, so a stick and a d-pad pushing the same
    // way cannot make the sum saturate earlier than full deflection does on its own.
    padTurn = clamp(padTurn, -1, 1);
    navMask |= navBitsFromAxes(padMoveX, padMoveY);
    updateNavRepeat(navMask, dt);
    padResync = false;
  }

  // ── poll ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Collapse every device into the shared frame. Called exactly once per simulation step.
   * @returns {InputFrame} the module's single frame instance — read it, never store it
   */
  function poll() {
    const t = now();
    let dt = (t - lastPollMs) / 1000;
    lastPollMs = t;
    // Guard both directions: a non-monotonic clock (Date.now fallback across an NTP step) or a
    // stalled tab must not make the menu cursor jump.
    if (!(dt > 0)) dt = 0;
    else if (dt > MAX_POLL_DT_S) dt = MAX_POLL_DT_S;

    pollGamepad(dt);
    maybeAutoLock();

    // Keyboard contributions are booleans per slot, so two keys on one slot still mean "1".
    const kx = (hold[HOLD.STRAFE_R] > 0 ? 1 : 0) - (hold[HOLD.STRAFE_L] > 0 ? 1 : 0);
    const ky = (hold[HOLD.FORWARD] > 0 ? 1 : 0) - (hold[HOLD.BACK] > 0 ? 1 : 0);
    const kt = (hold[HOLD.TURN_R] > 0 ? 1 : 0) - (hold[HOLD.TURN_L] > 0 ? 1 : 0);

    frame.moveX = clamp(kx + padMoveX + stickX, -1, 1);
    frame.moveY = clamp(ky + padMoveY + stickY, -1, 1);
    frame.turn = clamp(kt + padTurn, -1, 1);
    frame.sprint = hold[HOLD.SPRINT] > 0 || padSprint || stickSprint;

    frame.lookDX = clamp(lookAccum, -MAX_LOOK_PER_POLL, MAX_LOOK_PER_POLL);
    lookAccum = 0;

    pressed.clear();
    if (pendingMask !== 0) {
      for (let i = 0; i < ACTION_COUNT; i++) {
        if (pendingMask & (1 << i)) pressed.add(ACTIONS[i]);
      }
      pendingMask = 0;
    }
    return frame;
  }

  // ── Public methods ────────────────────────────────────────────────────────────────────────

  /**
   * Ask for pointer lock. Must be called from a user gesture to succeed; failures are silent by
   * design (the player can still turn with the keyboard, and a thrown error at this seam would
   * take down the frame that handled the click).
   */
  function requestPointerLock() {
    if (destroyed || !target || typeof target.requestPointerLock !== 'function' || isLocked()) return;
    try {
      // `unadjustedMovement` disables OS pointer acceleration — the difference between "fine" and
      // "swimmy" aiming. Unsupported engines reject the promise (or ignore the argument), so we
      // retry plainly.
      const p = target.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          if (destroyed || isLocked()) return;
          try {
            const q = target.requestPointerLock();
            if (q && typeof q.catch === 'function') q.catch(noteLockRefused);
          } catch {
            /* refused twice: keyboard turning remains */
            noteLockRefused();
          }
        });
      }
    } catch {
      try {
        const q = target.requestPointerLock();
        if (q && typeof q.catch === 'function') q.catch(noteLockRefused);
      } catch {
        /* nothing else to try */
        noteLockRefused();
      }
    }
  }

  /**
   * Update options in place. Only recognised keys are read, and each is validated, so a settings
   * object straight out of `localStorage` can be passed without sanitising it first.
   * @param {InputOptions} next
   */
  function setOptions(next) {
    if (!next) return;
    if (typeof next.sensitivity === 'number') sensitivity = clamp(next.sensitivity, SENS_MIN, SENS_MAX);
    if (typeof next.invertLook === 'boolean') invertSign = next.invertLook ? -1 : 1;
    if (typeof next.shouldLockPointer === 'function') shouldLockPointer = next.shouldLockPointer;
  }

  /**
   * Swap the keyboard layout. Anything that is not a table pair restores the defaults.
   * @param {import('./bindings.js').BindingTables|null|undefined} tables
   */
  function setBindings(tables) {
    const ok =
      !!tables &&
      typeof tables === 'object' &&
      !!tables.keyHold &&
      typeof tables.keyHold === 'object' &&
      !!tables.keyActionMask &&
      typeof tables.keyActionMask === 'object';
    keyHold = ok && tables ? tables.keyHold : DEFAULT_BINDINGS.keyHold;
    keyActionMask = ok && tables ? tables.keyActionMask : DEFAULT_BINDINGS.keyActionMask;
    // A key held across the swap would release a different slot than it pressed.
    heldCodes.clear();
    hold.fill(0);
  }

  /** Remove every listener, node and style this module added (invariant 3). */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (let i = 0; i < bound.length; i++) {
      const b = bound[i];
      try {
        b.t.removeEventListener(b.type, b.fn, b.opt);
      } catch {
        // A target can already be gone during teardown; the listener dies with it.
      }
    }
    bound.length = 0;
    if (overlay) {
      overlay.destroy();
      overlay = null;
    }
    if (touchStyleApplied && target && target.style) target.style.touchAction = previousTouchAction;
    if (isLocked() && doc && typeof doc.exitPointerLock === 'function') {
      try {
        doc.exitPointerLock();
      } catch {
        /* already released */
      }
    }
    clearHeld();
    pendingMask = 0;
  }

  if (o.bindings) setBindings(o.bindings);

  // ── Wiring ────────────────────────────────────────────────────────────────────────────────

  // Belt-and-braces against browser gesture handling on the play surface. `styles.css` already
  // sets this globally; doing it here too means the module is correct even if that file changes,
  // and the previous value is restored on destroy so nothing is left behind.
  let previousTouchAction = '';
  let touchStyleApplied = false;
  if (target && target.style && typeof target.style === 'object') {
    previousTouchAction = typeof target.style.touchAction === 'string' ? target.style.touchAction : '';
    target.style.touchAction = 'none';
    touchStyleApplied = true;
  }

  // Keys are listened for on the window: the canvas is not focusable, and a game that only
  // responds after you click it is a bug report waiting to happen.
  listen(win, 'keydown', onKeyDown);
  listen(win, 'keyup', onKeyUp);
  listen(win, 'blur', onBlur);
  listen(doc, 'visibilitychange', onVisibility);
  listen(win, 'gamepadconnected', onGamepadConnected);
  listen(win, 'gamepaddisconnected', onGamepadDisconnected);

  listen(doc, 'mousemove', onMouseMove);
  listen(doc, 'mouseup', onMouseUp);
  listen(doc, 'pointerlockchange', onPointerLockChange);
  listen(doc, 'pointerlockerror', onPointerLockError);
  listen(target, 'mousedown', onMouseDown);
  listen(target, 'click', onClick);

  listen(target, 'touchstart', onTouchStart, { passive: false });
  listen(target, 'touchmove', onTouchMove, { passive: false });
  listen(target, 'touchend', onTouchEnd, { passive: true });
  listen(target, 'touchcancel', onTouchEnd, { passive: true });
  listen(target, 'contextmenu', swallow);
  listen(target, 'dblclick', swallow);
  // Safari-only pinch gestures; harmless no-ops elsewhere.
  listen(target, 'gesturestart', swallow, { passive: false });
  listen(target, 'gesturechange', swallow, { passive: false });
  listen(target, 'gestureend', swallow, { passive: false });

  return {
    poll,
    setOptions,
    requestPointerLock,
    setBindings,
    updateOverlay(state) {
      if (overlay) overlay.update(state);
    },
    destroy,
    get isTouch() {
      return touchDetected;
    },
    get pointerLocked() {
      return isLocked();
    },
    get wantsPointer() {
      if (destroyed || touchDetected || !target || typeof target.requestPointerLock !== 'function') return false;
      return !isLocked() && shouldLockPointer() === true;
    },
  };
}
