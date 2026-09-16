// @ts-check
/**
 * @file Unit tests for the binding tables and the deadzone math (`src/input/bindings.js`).
 * Run: `node src/input/bindings.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIONS,
  ACTION_BIT,
  ACTION_COUNT,
  NAV_MASK,
  HOLD,
  HOLD_COUNT,
  KEY_HOLD,
  KEY_ACTION_MASK,
  PREVENT_DEFAULT_CODES,
  GAMEPAD_BUTTON_ACTION,
  GAMEPAD_BUTTON_HOLD,
  DEADZONE,
  radialDeadzone,
  axisDeadzone,
  codeFromKey,
  CONTROL_HINTS,
} from './bindings.js';

test('ACTIONS covers the contract vocabulary exactly once', () => {
  const expected = ['confirm', 'back', 'pause', 'map', 'up', 'down', 'left', 'right', 'mute'];
  assert.deepEqual([...ACTIONS], expected);
  assert.equal(ACTION_COUNT, 9);
  assert.equal(new Set(ACTIONS).size, ACTIONS.length);
});

test('ACTION_BIT assigns one distinct bit per action, in ACTIONS order', () => {
  let seen = 0;
  for (let i = 0; i < ACTIONS.length; i++) {
    const bit = ACTION_BIT[ACTIONS[i]];
    assert.equal(bit, 1 << i, `${ACTIONS[i]} bit`);
    assert.equal(seen & bit, 0, 'bits are distinct');
    seen |= bit;
  }
  assert.equal(seen, (1 << ACTION_COUNT) - 1);
});

test('ACTION_BIT has a null prototype (no inherited keys leak through)', () => {
  assert.equal(Object.getPrototypeOf(ACTION_BIT), null);
  assert.equal(ACTION_BIT['constructor'], undefined);
  assert.equal(KEY_HOLD['toString'], undefined);
  assert.equal(KEY_ACTION_MASK['hasOwnProperty'], undefined);
});

test('NAV_MASK is exactly the four directions', () => {
  assert.equal(NAV_MASK, ACTION_BIT.up | ACTION_BIT.down | ACTION_BIT.left | ACTION_BIT.right);
  assert.equal(NAV_MASK & ACTION_BIT.confirm, 0);
});

test('keyboard layout matches the design: arrows turn, WASD moves, A/D strafe, Q/E turn', () => {
  assert.equal(KEY_HOLD.KeyW, HOLD.FORWARD);
  assert.equal(KEY_HOLD.ArrowUp, HOLD.FORWARD);
  assert.equal(KEY_HOLD.KeyS, HOLD.BACK);
  assert.equal(KEY_HOLD.ArrowDown, HOLD.BACK);
  assert.equal(KEY_HOLD.KeyA, HOLD.STRAFE_L);
  assert.equal(KEY_HOLD.KeyD, HOLD.STRAFE_R);
  assert.equal(KEY_HOLD.KeyQ, HOLD.TURN_L);
  assert.equal(KEY_HOLD.KeyE, HOLD.TURN_R);
  assert.equal(KEY_HOLD.ArrowLeft, HOLD.TURN_L);
  assert.equal(KEY_HOLD.ArrowRight, HOLD.TURN_R);
  assert.equal(KEY_HOLD.ShiftLeft, HOLD.SPRINT);
  assert.equal(KEY_HOLD.ShiftRight, HOLD.SPRINT);
  // Every hold slot is reachable from the keyboard, and none points outside the array.
  const used = new Set(Object.values(KEY_HOLD));
  for (let i = 0; i < HOLD_COUNT; i++) assert.ok(used.has(i), `slot ${i} is bound`);
});

test('action keys match the contract (confirm/back/pause/map/mute/nav)', () => {
  assert.equal(KEY_ACTION_MASK.Enter, ACTION_BIT.confirm);
  assert.equal(KEY_ACTION_MASK.Space, ACTION_BIT.confirm);
  assert.equal(KEY_ACTION_MASK.Backspace, ACTION_BIT.back);
  assert.equal(KEY_ACTION_MASK.KeyP, ACTION_BIT.pause);
  assert.equal(KEY_ACTION_MASK.KeyM, ACTION_BIT.map);
  assert.equal(KEY_ACTION_MASK.Tab, ACTION_BIT.map);
  assert.equal(KEY_ACTION_MASK.KeyN, ACTION_BIT.mute);
  // Escape is deliberately both: menus read `back`, gameplay reads `pause`.
  assert.equal(KEY_ACTION_MASK.Escape, ACTION_BIT.back | ACTION_BIT.pause);
  // Arrows and WASD both drive menu navigation.
  assert.equal(KEY_ACTION_MASK.ArrowUp, ACTION_BIT.up);
  assert.equal(KEY_ACTION_MASK.KeyW, ACTION_BIT.up);
  assert.equal(KEY_ACTION_MASK.KeyA, ACTION_BIT.left);
  assert.equal(KEY_ACTION_MASK.ArrowRight, ACTION_BIT.right);
  // No mask may carry a bit outside the 9 defined actions.
  for (const [code, mask] of Object.entries(KEY_ACTION_MASK)) {
    assert.equal(mask & ~((1 << ACTION_COUNT) - 1), 0, `${code} stays inside the action mask`);
    assert.ok(mask > 0, `${code} binds something`);
  }
});

test('only bound, non-typing keys have their browser default suppressed', () => {
  for (const code of PREVENT_DEFAULT_CODES) {
    assert.ok(KEY_HOLD[code] !== undefined || KEY_ACTION_MASK[code] !== undefined, `${code} is bound`);
  }
  // Letters never scroll the page, so we must not swallow them.
  assert.equal(PREVENT_DEFAULT_CODES.has('KeyW'), false);
  assert.equal(PREVENT_DEFAULT_CODES.has('KeyM'), false);
  assert.ok(PREVENT_DEFAULT_CODES.has('Space'));
  assert.ok(PREVENT_DEFAULT_CODES.has('Tab'));
  assert.ok(PREVENT_DEFAULT_CODES.has('ArrowUp'));
});

test('gamepad standard mapping: A/B/Start/Back and the d-pad', () => {
  assert.equal(GAMEPAD_BUTTON_ACTION[0], ACTION_BIT.confirm);
  assert.equal(GAMEPAD_BUTTON_ACTION[1], ACTION_BIT.back);
  assert.equal(GAMEPAD_BUTTON_ACTION[8], ACTION_BIT.map);
  assert.equal(GAMEPAD_BUTTON_ACTION[9], ACTION_BIT.pause);
  assert.equal(GAMEPAD_BUTTON_ACTION[12], ACTION_BIT.up);
  assert.equal(GAMEPAD_BUTTON_ACTION[15], ACTION_BIT.right);
  assert.equal(GAMEPAD_BUTTON_HOLD[12], HOLD.FORWARD);
  assert.equal(GAMEPAD_BUTTON_HOLD[14], HOLD.TURN_L);
  assert.equal(GAMEPAD_BUTTON_HOLD[10], HOLD.SPRINT);
  // Unbound buttons must read as undefined, never as 0 (= slot FORWARD).
  assert.equal(GAMEPAD_BUTTON_HOLD[3], undefined);
  assert.equal(GAMEPAD_BUTTON_ACTION[5], undefined);
});

test('radialDeadzone: inside the zone is exactly zero', () => {
  const out = [0, 0];
  for (const [x, y] of [
    [0, 0],
    [0.1, 0],
    [0, -0.17],
    [0.12, 0.12], // magnitude 0.1697 < 0.18 — a per-axis deadzone would let this through
  ]) {
    const m = radialDeadzone(x, y, DEADZONE, out);
    assert.equal(m, 0, `(${x},${y}) magnitude`);
    assert.equal(out[0], 0);
    assert.equal(out[1], 0);
  }
});

test('radialDeadzone: rescales (dz,1] onto (0,1] and keeps direction', () => {
  const out = [0, 0];

  // Full deflection stays full.
  assert.equal(radialDeadzone(1, 0, 0.18, out), 1);
  assert.equal(out[0], 1);
  assert.equal(out[1], 0);

  // Just past the edge is near zero, not a jump to 0.18.
  const m = radialDeadzone(0.19, 0, 0.18, out);
  assert.ok(Math.abs(m - 0.01 / 0.82) < 1e-12, `expected tiny magnitude, got ${m}`);
  assert.ok(out[0] > 0 && out[0] < 0.02);

  // Halfway: magnitude 0.59 → (0.59-0.18)/0.82 = 0.5.
  const mid = radialDeadzone(0.59, 0, 0.18, out);
  assert.ok(Math.abs(mid - 0.5) < 1e-12);

  // Direction is preserved for a diagonal, and the magnitude never exceeds 1.
  const diag = radialDeadzone(0.7071067811865476, 0.7071067811865476, 0.18, out);
  assert.ok(Math.abs(out[0] - out[1]) < 1e-12, 'diagonal stays diagonal');
  assert.ok(diag <= 1);
  // An over-range pad report (both axes at 1) is clamped to unit length, so diagonals are not
  // faster than cardinals.
  const over = radialDeadzone(1, 1, 0.18, out);
  assert.equal(over, 1);
  assert.ok(Math.abs(Math.hypot(out[0], out[1]) - 1) < 1e-12);
});

test('radialDeadzone: degenerate inputs are total', () => {
  const out = [9, 9];
  assert.equal(radialDeadzone(NaN, NaN, 0.18, out), 0);
  assert.equal(out[0], 0);
  // Non-finite axes are treated as 0 rather than as "full deflection": a broken driver must not
  // be able to pin the player at full speed.
  assert.equal(radialDeadzone(Infinity, 0, 0.18, out), 0);
  assert.equal(out[0], 0);
  assert.equal(radialDeadzone(0.5, 0, -1, out), 0.5, 'negative deadzone behaves as zero');
  assert.equal(radialDeadzone(0.5, 0, 5, out), 0, 'over-large deadzone swallows everything');
});

test('axisDeadzone: sign preserved, rescaled, total', () => {
  assert.equal(axisDeadzone(0.1, 0.18), 0);
  assert.equal(axisDeadzone(-0.1, 0.18), 0);
  assert.equal(axisDeadzone(1, 0.18), 1);
  assert.equal(axisDeadzone(-1, 0.18), -1);
  assert.ok(Math.abs(axisDeadzone(0.59, 0.18) - 0.5) < 1e-12);
  assert.ok(Math.abs(axisDeadzone(-0.59, 0.18) + 0.5) < 1e-12);
  assert.equal(axisDeadzone(NaN, 0.18), 0);
  assert.equal(axisDeadzone(-2, 0.18), -1, 'over-range clamps');
});

test('codeFromKey covers the bound keys and refuses to guess otherwise', () => {
  assert.equal(codeFromKey('ArrowLeft'), 'ArrowLeft');
  assert.equal(codeFromKey('Escape'), 'Escape');
  assert.equal(codeFromKey(' '), 'Space');
  assert.equal(codeFromKey('Shift'), 'ShiftLeft');
  assert.equal(codeFromKey('w'), 'KeyW');
  assert.equal(codeFromKey('M'), 'KeyM');
  assert.equal(codeFromKey('7'), 'Digit7');
  assert.equal(codeFromKey('F5'), '');
  assert.equal(codeFromKey(''), '');
  assert.equal(codeFromKey(undefined), '');
  assert.equal(codeFromKey(null), '');
  // Every fallback result that claims to be a binding must actually resolve to one.
  for (const key of ['w', 'a', 's', 'd', 'q', 'e', 'ArrowUp', ' ', 'Enter', 'm', 'n', 'p']) {
    const code = codeFromKey(key);
    assert.ok(KEY_HOLD[code] !== undefined || KEY_ACTION_MASK[code] !== undefined, `${key} → ${code}`);
  }
});

test('CONTROL_HINTS is frozen, non-empty and complete enough to render', () => {
  assert.ok(Object.isFrozen(CONTROL_HINTS));
  assert.ok(CONTROL_HINTS.length >= 8);
  for (const h of CONTROL_HINTS) {
    assert.equal(typeof h.label, 'string');
    assert.ok(h.label.length > 0);
    assert.equal(typeof h.keys, 'string');
    assert.equal(typeof h.pad, 'string');
  }
});
