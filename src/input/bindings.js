// @ts-check
/**
 * @file Default control bindings and the pure lookup tables `input.js` reads in its hot path.
 *
 * Everything here is data plus two pure functions: no DOM, no state, no allocation. Keeping the
 * maps out of `input.js` means the binding scheme can be inspected (and, later, re-bound by an
 * options screen) without touching the event plumbing, and it lets the tables be unit tested on
 * their own.
 *
 * Design decisions that are invariants, not preferences:
 *
 * - **Physical keys, not characters.** Every keyboard table is keyed by `KeyboardEvent.code`
 *   (`KeyW`, `ArrowUp`, …) so the layout is identical on QWERTY, AZERTY, Dvorak and Colemak.
 *   `event.key` is deliberately never consulted except by the `codeFromKey` fallback below.
 * - **Actions are a 9-bit mask.** The nine `InputAction` values map to bits 0…8 (`ACTION_BIT`),
 *   so an entire poll's worth of edge-triggered actions is one integer. Accumulating input from
 *   three devices into a number instead of a `Set` is what makes `poll()` allocation-free; the
 *   `Set` in `InputFrame` is filled from the mask once per poll.
 * - **Holds are slot counters.** A held key contributes to one of seven analogue "slots"
 *   (`HOLD.*`). `input.js` keeps an `Int32Array(HOLD_COUNT)` of press counts, so `W` and `↑` held
 *   together still mean "forward = 1" and releasing one of them does not stop the player.
 * - A single physical key may appear in *both* tables and may carry several action bits: `Escape`
 *   is `back | pause` (menus consume `back`, gameplay consumes `pause`), and `ArrowLeft` both
 *   turns the camera and moves a menu cursor left. Disambiguating by context is the consumer's
 *   job — the input module reports what the player did, never what it meant.
 *
 * Layout (ARCHITECTURE.md §1 "Controls"): arrows turn, `WASD` moves, `A`/`D` strafe, `Q`/`E` also
 * turn, `Shift` sprints.
 *
 * @see ARCHITECTURE.md §4.3
 */

/** @typedef {import('../core/types.js').InputAction} InputAction */

// ─── Actions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Canonical order of `InputAction` values. The index of an action here **is** its bit position in
 * every mask in this file, so this array must never be reordered without re-checking consumers
 * that persist a mask (none do today — masks are per-poll only).
 * @type {readonly InputAction[]}
 */
export const ACTIONS = Object.freeze([
  'confirm', // 0
  'back', // 1
  'pause', // 2
  'map', // 3
  'up', // 4
  'down', // 5
  'left', // 6
  'right', // 7
  'mute', // 8
]);

/** Number of distinct actions (= number of meaningful bits in an action mask). */
export const ACTION_COUNT = ACTIONS.length;

/**
 * Action name → single-bit mask. Null-prototype so an unknown key such as `'constructor'` reads
 * as `undefined` rather than inheriting something from `Object.prototype`.
 * @type {Record<string, number>}
 */
export const ACTION_BIT = /** @type {Record<string, number>} */ (Object.create(null));
for (let i = 0; i < ACTIONS.length; i++) ACTION_BIT[ACTIONS[i]] = 1 << i;
Object.freeze(ACTION_BIT);

/**
 * The four menu-navigation bits. They are special-cased twice: OS key auto-repeat is allowed to
 * re-fire only these (so holding ↓ scrolls a menu but holding `W` does not spam `confirm`), and
 * gamepad d-pad/stick directions get software auto-repeat with the same feel.
 */
export const NAV_MASK = ACTION_BIT.up | ACTION_BIT.down | ACTION_BIT.left | ACTION_BIT.right;

// ─── Analogue hold slots ─────────────────────────────────────────────────────────────────────

/**
 * Slot indices for held (non edge-triggered) controls. Values are array indices, so they are
 * dense and start at 0.
 * @type {{FORWARD:0, BACK:1, STRAFE_L:2, STRAFE_R:3, TURN_L:4, TURN_R:5, SPRINT:6}}
 */
export const HOLD = Object.freeze({
  FORWARD: 0,
  BACK: 1,
  STRAFE_L: 2,
  STRAFE_R: 3,
  TURN_L: 4,
  TURN_R: 5,
  SPRINT: 6,
});

/** Number of hold slots; the size of the press-count array in `input.js`. */
export const HOLD_COUNT = 7;

// ─── Keyboard tables ─────────────────────────────────────────────────────────────────────────

/**
 * `KeyboardEvent.code` → hold slot. Absent codes are not movement keys.
 * @type {Record<string, number>}
 */
export const KEY_HOLD = /** @type {Record<string, number>} */ (Object.assign(Object.create(null), {
  KeyW: HOLD.FORWARD,
  ArrowUp: HOLD.FORWARD,
  KeyS: HOLD.BACK,
  ArrowDown: HOLD.BACK,
  KeyA: HOLD.STRAFE_L,
  KeyD: HOLD.STRAFE_R,
  KeyQ: HOLD.TURN_L,
  ArrowLeft: HOLD.TURN_L,
  KeyE: HOLD.TURN_R,
  ArrowRight: HOLD.TURN_R,
  ShiftLeft: HOLD.SPRINT,
  ShiftRight: HOLD.SPRINT,
}));

/**
 * `KeyboardEvent.code` → action bitmask (edge-triggered on key *down*).
 *
 * Note the deliberate overlaps: `Escape` is both `back` and `pause` because the same key closes a
 * submenu and opens the pause menu depending on phase, and the movement keys double as menu
 * cursor keys so a player never has to move their hand to navigate.
 * @type {Record<string, number>}
 */
export const KEY_ACTION_MASK = /** @type {Record<string, number>} */ (Object.assign(Object.create(null), {
  Enter: ACTION_BIT.confirm,
  NumpadEnter: ACTION_BIT.confirm,
  Space: ACTION_BIT.confirm,
  Escape: ACTION_BIT.back | ACTION_BIT.pause,
  Backspace: ACTION_BIT.back,
  KeyP: ACTION_BIT.pause,
  KeyM: ACTION_BIT.map,
  Tab: ACTION_BIT.map,
  KeyN: ACTION_BIT.mute,
  ArrowUp: ACTION_BIT.up,
  KeyW: ACTION_BIT.up,
  ArrowDown: ACTION_BIT.down,
  KeyS: ACTION_BIT.down,
  ArrowLeft: ACTION_BIT.left,
  KeyA: ACTION_BIT.left,
  ArrowRight: ACTION_BIT.right,
  KeyD: ACTION_BIT.right,
}));

/**
 * Codes whose browser default we swallow while the game has focus: arrows and `Space` scroll the
 * page, `Tab` moves focus out of the canvas, `Backspace` used to navigate back in older browsers.
 *
 * `input.js` additionally refuses to `preventDefault` while a text field is focused and whenever a
 * modifier is held, so browser shortcuts (Ctrl+R, Cmd+L, Alt+Tab…) always survive.
 * @type {Set<string>}
 */
export const PREVENT_DEFAULT_CODES = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Tab',
  'Backspace',
]);

/**
 * Best-effort `event.code` for browsers/synthetic events that only provide `event.key`.
 *
 * Only the cases the game binds are covered; anything else returns `''` (meaning "unbound"), which
 * is strictly better than guessing. Single characters become `Key<UPPER>` / `Digit<n>`, which is
 * *layout dependent* — that is the whole reason it is a fallback and not the primary path.
 * @param {string|undefined|null} key  the `KeyboardEvent.key` value
 * @returns {string} a `KeyboardEvent.code`-shaped string, or `''` when unmappable
 */
export function codeFromKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '';
  // These key values are already identical to their code.
  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') return key;
  if (key === 'Escape' || key === 'Enter' || key === 'Tab' || key === 'Backspace') return key;
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key === 'Shift') return 'ShiftLeft';
  if (key.length === 1) {
    const c = key.charCodeAt(0);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) return 'Key' + key.toUpperCase();
    if (c >= 48 && c <= 57) return 'Digit' + key;
  }
  return '';
}

// ─── Gamepad tables (W3C "standard" mapping) ─────────────────────────────────────────────────

/**
 * Radial deadzone for both analogue sticks (ARCHITECTURE.md §4.3). 0.18 is the smallest value that
 * reliably swallows the resting drift of worn console pads without eating deliberate slow nudges.
 */
export const DEADZONE = 0.18;

/**
 * Standard-mapping button index → action bitmask.
 * `0` A/Cross = confirm, `1` B/Circle = back, `8` Select/Back/View = map, `9` Start/Menu = pause,
 * `12…15` d-pad = menu navigation (also movement, see `GAMEPAD_BUTTON_HOLD`).
 * Sparse array: missing entries are `undefined` and treated as 0 by the caller.
 * @type {number[]}
 */
export const GAMEPAD_BUTTON_ACTION = [];
GAMEPAD_BUTTON_ACTION[0] = ACTION_BIT.confirm;
GAMEPAD_BUTTON_ACTION[1] = ACTION_BIT.back;
GAMEPAD_BUTTON_ACTION[8] = ACTION_BIT.map;
GAMEPAD_BUTTON_ACTION[9] = ACTION_BIT.pause;
GAMEPAD_BUTTON_ACTION[12] = ACTION_BIT.up;
GAMEPAD_BUTTON_ACTION[13] = ACTION_BIT.down;
GAMEPAD_BUTTON_ACTION[14] = ACTION_BIT.left;
GAMEPAD_BUTTON_ACTION[15] = ACTION_BIT.right;
Object.freeze(GAMEPAD_BUTTON_ACTION);

/**
 * Standard-mapping button index → hold slot. The d-pad mirrors the arrow keys exactly (up/down
 * move, left/right turn) and both triggers plus L3 sprint, which covers every common convention.
 * Sparse array: missing entries are `undefined`.
 * @type {number[]}
 */
export const GAMEPAD_BUTTON_HOLD = [];
GAMEPAD_BUTTON_HOLD[4] = HOLD.SPRINT; // LB
GAMEPAD_BUTTON_HOLD[6] = HOLD.SPRINT; // LT
GAMEPAD_BUTTON_HOLD[7] = HOLD.SPRINT; // RT
GAMEPAD_BUTTON_HOLD[10] = HOLD.SPRINT; // L3 (stick click)
GAMEPAD_BUTTON_HOLD[12] = HOLD.FORWARD;
GAMEPAD_BUTTON_HOLD[13] = HOLD.BACK;
GAMEPAD_BUTTON_HOLD[14] = HOLD.TURN_L;
GAMEPAD_BUTTON_HOLD[15] = HOLD.TURN_R;
Object.freeze(GAMEPAD_BUTTON_HOLD);

// ─── Pure math shared by every analogue source ───────────────────────────────────────────────

/**
 * Apply a **radial** deadzone with magnitude rescaling to a stick vector.
 *
 * Radial (not per-axis) because a per-axis deadzone leaves the diagonals live at rest and makes
 * the reachable area a square with notches: pushing full-diagonal would exceed unit length. Here
 * the input disc is remapped so that magnitude `deadzone` → 0 and magnitude 1 → 1, which keeps the
 * stick's direction exactly and makes the first millimetre past the deadzone continuous rather
 * than a jump to 0.18 of full speed.
 *
 * Writes into `out` instead of returning a vector so the caller can keep a single scratch array
 * and allocate nothing per poll. Non-finite inputs are treated as 0.
 *
 * @param {number} x        raw axis, nominally -1..1
 * @param {number} y        raw axis, nominally -1..1
 * @param {number} deadzone 0..<1; values outside that range are clamped
 * @param {{0:number, 1:number}} out  two-element sink; receives the rescaled vector
 * @returns {number} the rescaled magnitude, 0..1 (0 when inside the deadzone)
 */
export function radialDeadzone(x, y, deadzone, out) {
  const ax = Number.isFinite(x) ? x : 0;
  const ay = Number.isFinite(y) ? y : 0;
  const dz = deadzone > 0 ? (deadzone < 0.99 ? deadzone : 0.99) : 0;
  // Math.hypot is noticeably slower than the direct form in V8 and we do not need its overflow
  // protection for values in [-1,1].
  const mag = Math.sqrt(ax * ax + ay * ay);
  if (mag <= dz) {
    out[0] = 0;
    out[1] = 0;
    return 0;
  }
  // Rescale magnitude from (dz,1] onto (0,1], then clamp: some pads report slightly >1 on the
  // diagonals, and letting that through would make diagonal movement faster than cardinal.
  let scaled = (mag - dz) / (1 - dz);
  if (scaled > 1) scaled = 1;
  const k = scaled / mag;
  out[0] = ax * k;
  out[1] = ay * k;
  return scaled;
}

/**
 * One-dimensional deadzone with rescaling, for a single axis used on its own (the right stick's
 * yaw). Sign is preserved; the result is clamped to -1..1.
 * @param {number} v        raw axis value
 * @param {number} deadzone 0..<1
 * @returns {number} -1..1, exactly 0 inside the deadzone
 */
export function axisDeadzone(v, deadzone) {
  const a = Number.isFinite(v) ? v : 0;
  const dz = deadzone > 0 ? (deadzone < 0.99 ? deadzone : 0.99) : 0;
  const mag = a < 0 ? -a : a;
  if (mag <= dz) return 0;
  let scaled = (mag - dz) / (1 - dz);
  if (scaled > 1) scaled = 1;
  return a < 0 ? -scaled : scaled;
}

// ─── Human-readable summary (for the options/credits screens) ────────────────────────────────

/**
 * Player-facing description of the default scheme, in display order. `src/ui` renders this
 * verbatim on the Options screen's Controls panel instead of duplicating the binding knowledge.
 *
 * **Wiring (the seam, because `src/ui` may not import `src/input` — §2):** the composition root
 * passes it across — `createMenus(overlay, { …, controls: CONTROL_HINTS })`. `src/ui/menus.js`
 * carries an ASCII fallback for a preview/harness that passes nothing, so a missing wire shows up
 * as a stale hint row rather than an empty panel; this table stays the authority on the bindings
 * themselves, and any rebinding UI would write back through here.
 * @type {readonly {label:string, keys:string, pad:string}[]}
 */
export const CONTROL_HINTS = Object.freeze([
  Object.freeze({ label: 'Move', keys: 'W S / ↑ ↓', pad: 'Left stick / D-pad' }),
  Object.freeze({ label: 'Strafe', keys: 'A D', pad: 'Left stick' }),
  Object.freeze({ label: 'Turn', keys: '← → / Q E', pad: 'Right stick' }),
  Object.freeze({ label: 'Look', keys: 'Mouse', pad: 'Right stick' }),
  Object.freeze({ label: 'Sprint', keys: 'Shift', pad: 'Triggers / L3' }),
  Object.freeze({ label: 'Map', keys: 'M / Tab', pad: 'View' }),
  Object.freeze({ label: 'Pause', keys: 'Esc / P', pad: 'Menu' }),
  Object.freeze({ label: 'Mute', keys: 'N', pad: '—' }),
  Object.freeze({ label: 'Confirm', keys: 'Enter / Space', pad: 'A' }),
  Object.freeze({ label: 'Back', keys: 'Esc / Backspace', pad: 'B' }),
]);
