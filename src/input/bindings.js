// @ts-check
/**
 * @file Default control bindings and the pure lookup tables `input.js` reads in its hot path.
 *
 * Everything here is data plus two pure functions: no DOM, no state, no allocation. Keeping the
 * maps out of `input.js` means the binding scheme can be inspected — and re-bound, through
 * `createBindings(overrides)` → `input.setBindings(tables)` — without touching the event plumbing,
 * and it lets the tables be unit tested on their own. `describeControls(tables)` turns any layout
 * back into the Controls panel's rows, so the hints follow a remap.
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
 * Serialisable names for the hold slots, in slot order. These (together with the `InputAction`
 * names) are the vocabulary of a {@link BindingOverrides} map, so a remap can be stored as plain
 * JSON in `Settings` without leaking slot indices into persistence. The backward slot is named
 * `backward` so it can never be confused with the `back` action.
 * @type {readonly string[]}
 */
export const HOLD_NAMES = Object.freeze(['forward', 'backward', 'strafeLeft', 'strafeRight', 'turnLeft', 'turnRight', 'sprint']);

/**
 * A keyboard remap: `KeyboardEvent.code` → the controls that key drives, by name (a hold name from
 * {@link HOLD_NAMES} and/or any `InputAction`). An entry **replaces** that code's default binding
 * wholesale; an empty array unbinds the key. Codes not mentioned keep their defaults. Unknown
 * names are ignored, and a key can drive at most one hold slot (the first hold name listed wins),
 * because a keydown increments exactly one press counter.
 * @typedef {Record<string, readonly string[]>} BindingOverrides
 */

/**
 * The lookup tables `input.js` reads in its key handlers. Both are null-prototype objects, so a
 * lookup is one property read with no allocation — exactly as cheap as the frozen defaults were.
 * @typedef {Object} BindingTables
 * @property {Record<string, number>} keyHold        code → hold slot index
 * @property {Record<string, number>} keyActionMask  code → action bitmask
 */

/**
 * The default layout, in the same vocabulary as {@link BindingOverrides}. Order matters only for
 * {@link describeControls}, which lists keys in this order.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const DEFAULT_KEY_BINDINGS = Object.freeze({
  KeyW: Object.freeze(['forward', 'up']),
  ArrowUp: Object.freeze(['forward', 'up']),
  KeyS: Object.freeze(['backward', 'down']),
  ArrowDown: Object.freeze(['backward', 'down']),
  KeyA: Object.freeze(['strafeLeft', 'left']),
  KeyD: Object.freeze(['strafeRight', 'right']),
  KeyQ: Object.freeze(['turnLeft']),
  ArrowLeft: Object.freeze(['turnLeft', 'left']),
  KeyE: Object.freeze(['turnRight']),
  ArrowRight: Object.freeze(['turnRight', 'right']),
  ShiftLeft: Object.freeze(['sprint']),
  ShiftRight: Object.freeze(['sprint']),
  Enter: Object.freeze(['confirm']),
  NumpadEnter: Object.freeze(['confirm']),
  Space: Object.freeze(['confirm']),
  Escape: Object.freeze(['back', 'pause']),
  Backspace: Object.freeze(['back']),
  KeyP: Object.freeze(['pause']),
  KeyM: Object.freeze(['map']),
  Tab: Object.freeze(['map']),
  KeyN: Object.freeze(['mute']),
});

/**
 * Codes a remap may not change. `Escape` is the one key every player tries when they are lost,
 * and a stored remap that unbound it could strand someone with no way into the pause menu to undo
 * the remap, so overrides naming it are ignored.
 */
const LOCKED_CODES = Object.freeze(['Escape']);

/** Hold name → slot index (null prototype). */
const HOLD_BY_NAME = /** @type {Record<string, number>} */ (Object.create(null));
for (let i = 0; i < HOLD_NAMES.length; i++) HOLD_BY_NAME[HOLD_NAMES[i]] = i;

/**
 * Build the lookup tables for a layout: the defaults with `overrides` applied.
 *
 * Total: garbage in (a non-object, non-array entries, non-string names, codes that are not
 * strings) is skipped rather than thrown on, because the overrides normally come straight out of
 * `localStorage`.
 *
 * @param {BindingOverrides|null|undefined} [overrides]
 * @returns {BindingTables}
 */
export function createBindings(overrides) {
  /** @type {Record<string, readonly string[]>} */
  const merged = Object.create(null);
  const defCodes = Object.keys(DEFAULT_KEY_BINDINGS);
  for (let i = 0; i < defCodes.length; i++) merged[defCodes[i]] = DEFAULT_KEY_BINDINGS[defCodes[i]];
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    const codes = Object.keys(overrides);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (typeof code !== 'string' || code.length === 0 || code.length > 32) continue;
      if (LOCKED_CODES.indexOf(code) !== -1) continue;
      const names = /** @type {any} */ (overrides)[code];
      if (!Array.isArray(names)) continue;
      merged[code] = names;
    }
  }

  const keyHold = /** @type {Record<string, number>} */ (Object.create(null));
  const keyActionMask = /** @type {Record<string, number>} */ (Object.create(null));
  const codes = Object.keys(merged);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const names = merged[code];
    let slot = -1;
    let mask = 0;
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      if (typeof name !== 'string') continue;
      const holdIdx = HOLD_BY_NAME[name];
      if (holdIdx !== undefined) {
        if (slot === -1) slot = holdIdx;
      } else {
        mask |= ACTION_BIT[name] | 0;
      }
    }
    if (slot !== -1) keyHold[code] = slot;
    if (mask !== 0) keyActionMask[code] = mask;
  }
  return { keyHold, keyActionMask };
}

/** The default tables, built once. `input.js` uses them until `setBindings` swaps in a remap. */
export const DEFAULT_BINDINGS = createBindings(null);
Object.freeze(DEFAULT_BINDINGS.keyHold);
Object.freeze(DEFAULT_BINDINGS.keyActionMask);
Object.freeze(DEFAULT_BINDINGS);

/**
 * `KeyboardEvent.code` → hold slot for the default layout. Absent codes are not movement keys.
 * @type {Record<string, number>}
 */
export const KEY_HOLD = DEFAULT_BINDINGS.keyHold;

/**
 * `KeyboardEvent.code` → action bitmask (edge-triggered on key *down*) for the default layout.
 *
 * Note the deliberate overlaps: `Escape` is both `back` and `pause` because the same key closes a
 * submenu and opens the pause menu depending on phase, and the movement keys double as menu
 * cursor keys so a player never has to move their hand to navigate.
 * @type {Record<string, number>}
 */
export const KEY_ACTION_MASK = DEFAULT_BINDINGS.keyActionMask;

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
 * `0` A/Cross = confirm, `1` B/Circle = back, `3` Y/Triangle = mute, `8` Select/Back/View = map,
 * `9` Start/Menu = pause,
 * `12…15` d-pad = menu navigation (also movement, see `GAMEPAD_BUTTON_HOLD`).
 * Sparse array: missing entries are `undefined` and treated as 0 by the caller.
 * @type {number[]}
 */
export const GAMEPAD_BUTTON_ACTION = [];
GAMEPAD_BUTTON_ACTION[0] = ACTION_BIT.confirm;
GAMEPAD_BUTTON_ACTION[1] = ACTION_BIT.back;
// Y rather than a shoulder or R3: LB already sprints, so a shoulder is where a thumb lands by
// accident, and R3 clicks by accident while turning hard. A face button is a deliberate press.
GAMEPAD_BUTTON_ACTION[3] = ACTION_BIT.mute;
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

/** Display names for codes whose `KeyboardEvent.code` is not already what a keycap says. */
const KEY_LABEL = /** @type {Record<string, string>} */ (Object.assign(Object.create(null), {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  Escape: 'Esc',
  NumpadEnter: 'Enter',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
}));

/**
 * What a keycap for `code` says: `KeyW` → `W`, `Digit1` → `1`, `Numpad8` → `Num8`, `ArrowUp` → `↑`.
 * @param {string} code
 * @returns {string}
 */
export function keyLabel(code) {
  const named = KEY_LABEL[code];
  if (named !== undefined) return named;
  if (code.length === 4 && code.startsWith('Key')) return code.slice(3);
  if (code.length === 6 && code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
  return code;
}

/**
 * @param {BindingTables} tables
 * @param {number} slot
 * @returns {string[]} distinct keycap labels, in table order
 */
function labelsForSlot(tables, slot) {
  /** @type {string[]} */
  const out = [];
  const codes = Object.keys(tables.keyHold);
  for (let i = 0; i < codes.length; i++) {
    if (tables.keyHold[codes[i]] !== slot) continue;
    const l = keyLabel(codes[i]);
    if (out.indexOf(l) === -1) out.push(l);
  }
  return out;
}

/**
 * @param {BindingTables} tables
 * @param {number} bit
 * @returns {string[]} distinct keycap labels, in table order
 */
function labelsForAction(tables, bit) {
  /** @type {string[]} */
  const out = [];
  const codes = Object.keys(tables.keyActionMask);
  for (let i = 0; i < codes.length; i++) {
    if ((tables.keyActionMask[codes[i]] & bit) === 0) continue;
    const l = keyLabel(codes[i]);
    if (out.indexOf(l) === -1) out.push(l);
  }
  return out;
}

/** Arrow keycaps, which pair with each other rather than with letters. */
const ARROWS = '↑↓←→';

/**
 * A two-slot row such as Move (forward/backward): keys pair up as `W S / ↑ ↓`. Arrows pair with
 * arrows and everything else pairs positionally, so a remap that moves forward from `W` to `I`
 * still reads `I S / ↑ ↓` rather than mixing an arrow with a letter. Leftovers follow on their own.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {string}
 */
function pairRow(a, b) {
  /** @type {string[]} */
  const parts = [];
  for (let pass = 0; pass < 2; pass++) {
    const wantArrow = pass === 1;
    const aa = a.filter((l) => (ARROWS.indexOf(l) !== -1) === wantArrow);
    const bb = b.filter((l) => (ARROWS.indexOf(l) !== -1) === wantArrow);
    const n = aa.length > bb.length ? aa.length : bb.length;
    for (let i = 0; i < n; i++) {
      if (i < aa.length && i < bb.length) parts.push(aa[i] + ' ' + bb[i]);
      else parts.push(i < aa.length ? aa[i] : bb[i]);
    }
  }
  return parts.length ? parts.join(' / ') : '—';
}

/**
 * @param {string[]} labels
 * @returns {string}
 */
function listRow(labels) {
  return labels.length ? labels.join(' / ') : '—';
}

/**
 * Player-facing description of a layout, in display order, generated from the tables themselves so
 * it can never drift from what the keys actually do — including after a remap.
 *
 * @param {BindingTables} [tables]  defaults to {@link DEFAULT_BINDINGS}
 * @returns {readonly {label:string, keys:string, pad:string}[]} frozen rows
 */
export function describeControls(tables) {
  const t = tables && tables.keyHold && tables.keyActionMask ? tables : DEFAULT_BINDINGS;
  return Object.freeze([
    Object.freeze({ label: 'Move', keys: pairRow(labelsForSlot(t, HOLD.FORWARD), labelsForSlot(t, HOLD.BACK)), pad: 'Left stick / D-pad' }),
    Object.freeze({ label: 'Strafe', keys: pairRow(labelsForSlot(t, HOLD.STRAFE_L), labelsForSlot(t, HOLD.STRAFE_R)), pad: 'Left stick' }),
    Object.freeze({ label: 'Turn', keys: pairRow(labelsForSlot(t, HOLD.TURN_L), labelsForSlot(t, HOLD.TURN_R)), pad: 'Right stick' }),
    Object.freeze({ label: 'Look', keys: 'Mouse', pad: 'Right stick' }),
    Object.freeze({ label: 'Sprint', keys: listRow(labelsForSlot(t, HOLD.SPRINT)), pad: 'Triggers / LB / L3' }),
    Object.freeze({ label: 'Map', keys: listRow(labelsForAction(t, ACTION_BIT.map)), pad: 'View' }),
    Object.freeze({ label: 'Pause', keys: listRow(labelsForAction(t, ACTION_BIT.pause)), pad: 'Menu' }),
    Object.freeze({ label: 'Mute', keys: listRow(labelsForAction(t, ACTION_BIT.mute)), pad: 'Y' }),
    Object.freeze({ label: 'Confirm', keys: listRow(labelsForAction(t, ACTION_BIT.confirm)), pad: 'A' }),
    Object.freeze({ label: 'Back', keys: listRow(labelsForAction(t, ACTION_BIT.back)), pad: 'B' }),
  ]);
}

/**
 * The default layout's hints. `src/ui` renders this verbatim on the Options screen's Controls panel
 * instead of duplicating the binding knowledge.
 *
 * **Wiring (the seam, because `src/ui` may not import `src/input` — §2):** the composition root
 * passes it across — `createMenus(overlay, { …, controls: CONTROL_HINTS })`. After a remap it passes
 * `describeControls(createBindings(overrides))` instead. `src/ui/menus.js` carries an ASCII
 * fallback for a preview/harness that passes nothing.
 * @type {readonly {label:string, keys:string, pad:string}[]}
 */
export const CONTROL_HINTS = describeControls(DEFAULT_BINDINGS);
