// @ts-check
/**
 * @file Unit tests for `src/input/input.js`, driven entirely through the injectable environment
 * (`fake-dom.test-util.mjs`) so they run in plain Node with no DOM and no browser.
 * Run: `node src/input/input.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInput } from './input.js';
import { createFakeEnv, fakePad, touchEvent } from './fake-dom.test-util.mjs';

/**
 * Spin up an input bound to a fresh fake environment.
 * @param {Object} [opts]
 * @param {boolean} [opts.coarsePointer]
 * @param {number} [opts.sensitivity]
 * @param {boolean} [opts.invertLook]
 * @param {boolean} [opts.playing]      value returned by `shouldLockPointer`
 * @param {boolean} [opts.touchOverlay]
 */
function setup(opts) {
  const o = opts || {};
  const env = createFakeEnv({ coarsePointer: o.coarsePointer });
  let playing = o.playing === true;
  const input = createInput(env.canvas, {
    sensitivity: o.sensitivity,
    invertLook: o.invertLook,
    touchOverlay: o.touchOverlay,
    shouldLockPointer: () => playing,
    env: { window: env.window, document: env.document, navigator: env.navigator, performance: env.performance },
  });
  return {
    env,
    input,
    /** @param {boolean} v */
    setPlaying(v) {
      playing = v;
    },
    /** @param {string} code @param {any} [extra] */
    keyDown(code, extra) {
      env.window.dispatchEvent(Object.assign({ type: 'keydown', code, repeat: false, cancelable: true }, extra));
    },
    /** @param {string} code */
    keyUp(code) {
      env.window.dispatchEvent({ type: 'keyup', code });
    },
  };
}

// ─── Keyboard mapping ────────────────────────────────────────────────────────────────────────

test('keyboard: WASD moves and strafes, arrows move and turn, Q/E turn', () => {
  const t = setup();
  const p = t.input;

  t.keyDown('KeyW');
  assert.equal(p.poll().moveY, 1);
  t.keyUp('KeyW');
  t.keyDown('KeyS');
  assert.equal(p.poll().moveY, -1);
  t.keyUp('KeyS');

  t.keyDown('KeyD');
  assert.equal(p.poll().moveX, 1);
  t.keyDown('KeyA');
  assert.equal(p.poll().moveX, 0, 'opposing strafes cancel');
  t.keyUp('KeyD');
  assert.equal(p.poll().moveX, -1);
  t.keyUp('KeyA');

  t.keyDown('ArrowRight');
  assert.equal(p.poll().turn, 1);
  t.keyUp('ArrowRight');
  t.keyDown('KeyQ');
  assert.equal(p.poll().turn, -1, 'Q also turns left');
  t.keyUp('KeyQ');

  t.keyDown('ArrowUp');
  const f = p.poll();
  assert.equal(f.moveY, 1, 'ArrowUp moves forward');
  assert.equal(f.turn, 0, 'ArrowUp does not turn');
  t.keyUp('ArrowUp');
  assert.equal(p.poll().moveY, 0);

  p.destroy();
});

test('keyboard: two keys on one slot need both releases (no stuck-then-stop)', () => {
  const t = setup();
  t.keyDown('KeyW');
  t.keyDown('ArrowUp');
  assert.equal(t.input.poll().moveY, 1);
  t.keyUp('KeyW');
  assert.equal(t.input.poll().moveY, 1, 'still held by ArrowUp');
  t.keyUp('ArrowUp');
  assert.equal(t.input.poll().moveY, 0);
  t.input.destroy();
});

test('keyboard: shift sprints, and a duplicate keydown does not double-count', () => {
  const t = setup();
  t.keyDown('ShiftLeft');
  t.keyDown('ShiftLeft', { repeat: true });
  assert.equal(t.input.poll().sprint, true);
  t.keyUp('ShiftLeft');
  assert.equal(t.input.poll().sprint, false, 'one keyup clears a repeated keydown');
  t.input.destroy();
});

test('keyboard: diagonal movement is not normalised away (sim owns speed)', () => {
  const t = setup();
  t.keyDown('KeyW');
  t.keyDown('KeyD');
  const f = t.input.poll();
  assert.equal(f.moveX, 1);
  assert.equal(f.moveY, 1);
  t.input.destroy();
});

// ─── Edge triggering ─────────────────────────────────────────────────────────────────────────

test('actions are edge-triggered: one press, one poll', () => {
  const t = setup();
  t.keyDown('Enter');
  const f1 = t.input.poll();
  assert.ok(f1.pressed.has('confirm'));
  assert.equal(f1.pressed.size, 1);
  assert.equal(t.input.poll().pressed.size, 0, 'the edge is consumed');
  t.input.destroy();
});

test('holding a key does not re-fire non-navigation actions, but nav repeats', () => {
  const t = setup();
  t.keyDown('Enter');
  assert.ok(t.input.poll().pressed.has('confirm'));
  t.keyDown('Enter', { repeat: true });
  t.keyDown('Enter', { repeat: true });
  assert.equal(t.input.poll().pressed.size, 0, 'OS auto-repeat must not spam confirm');

  t.keyDown('ArrowDown');
  assert.ok(t.input.poll().pressed.has('down'));
  t.keyDown('ArrowDown', { repeat: true });
  assert.ok(t.input.poll().pressed.has('down'), 'menus scroll on auto-repeat');
  t.input.destroy();
});

test('every action is reachable from the keyboard with the documented keys', () => {
  const t = setup();
  /** @param {string} code @returns {Set<string>} */
  const press = (code) => {
    t.keyDown(code);
    const set = new Set(t.input.poll().pressed);
    t.keyUp(code);
    return set;
  };
  assert.deepEqual([...press('Space')], ['confirm']);
  assert.deepEqual([...press('Backspace')], ['back']);
  assert.deepEqual([...press('KeyP')], ['pause']);
  assert.deepEqual([...press('Tab')], ['map']);
  assert.deepEqual([...press('KeyM')], ['map']);
  assert.deepEqual([...press('KeyN')], ['mute']);
  // Escape carries both meanings; the consumer disambiguates by phase.
  const esc = press('Escape');
  assert.ok(esc.has('back') && esc.has('pause'));
  assert.ok(press('ArrowUp').has('up'));
  assert.ok(press('ArrowDown').has('down'));
  assert.ok(press('ArrowLeft').has('left'));
  assert.ok(press('ArrowRight').has('right'));
  assert.ok(press('KeyW').has('up'), 'WASD navigates menus too');
  assert.ok(press('KeyD').has('right'));
  t.input.destroy();
});

test('modified keys are left entirely to the browser', () => {
  const t = setup();
  t.keyDown('KeyW', { ctrlKey: true });
  t.keyDown('KeyN', { metaKey: true });
  t.keyDown('Tab', { altKey: true });
  const f = t.input.poll();
  assert.equal(f.moveY, 0);
  assert.equal(f.pressed.size, 0);
  t.input.destroy();
});

test('a Cmd combo drops held keys (macOS swallows their keyup)', () => {
  const t = setup();
  t.keyDown('KeyW');
  assert.equal(t.input.poll().moveY, 1);
  t.keyDown('KeyC', { metaKey: true }); // Cmd+C: the OS takes over
  assert.equal(t.input.poll().moveY, 0, 'W cannot get stuck behind a missing keyup');
  t.input.destroy();
});

test('preventDefault is scoped: only bound scrolling keys, never while typing', () => {
  const t = setup();
  /** @param {string} code @returns {boolean} */
  const wasPrevented = (code) => {
    /** @type {any} */
    const ev = { type: 'keydown', code, repeat: false, cancelable: true };
    t.env.window.dispatchEvent(ev);
    t.env.window.dispatchEvent({ type: 'keyup', code });
    return ev.defaultPrevented === true;
  };
  assert.equal(wasPrevented('ArrowUp'), true, 'arrows would scroll the page');
  assert.equal(wasPrevented('Space'), true);
  assert.equal(wasPrevented('Tab'), true, 'Tab would move focus off the canvas');
  assert.equal(wasPrevented('KeyW'), false, 'letters never scroll');
  assert.equal(wasPrevented('F5'), false, 'unbound keys are untouched');

  // With a text field focused the game must keep its hands off the keyboard entirely.
  const field = t.env.document.createElement('input');
  t.env.document.activeElement = field;
  assert.equal(wasPrevented('Space'), false);
  t.env.document.activeElement = null;
  t.input.destroy();
});

// ─── Blur / visibility ───────────────────────────────────────────────────────────────────────

test('blur clears every held input but keeps already-queued actions', () => {
  const t = setup();
  t.keyDown('KeyW');
  t.keyDown('KeyD');
  t.keyDown('ShiftLeft');
  t.keyDown('KeyP'); // queued action, not yet polled
  t.env.window.dispatchEvent({ type: 'blur' });

  const f = t.input.poll();
  assert.equal(f.moveX, 0);
  assert.equal(f.moveY, 0);
  assert.equal(f.turn, 0);
  assert.equal(f.sprint, false);
  assert.equal(f.lookDX, 0);
  assert.ok(f.pressed.has('pause'), 'a real press is not swallowed by losing focus');

  // A keyup that arrives after the blur (or never arrives) must not underflow the counters.
  t.keyUp('KeyW');
  t.keyDown('KeyW');
  assert.equal(t.input.poll().moveY, 1, 'input recovers cleanly after refocus');
  t.input.destroy();
});

test('visibilitychange clears held state only while hidden', () => {
  const t = setup();
  t.keyDown('KeyW');
  t.env.document.hidden = false;
  t.env.document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(t.input.poll().moveY, 1, 'becoming visible again keeps the key');
  t.env.document.hidden = true;
  t.env.document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(t.input.poll().moveY, 0);
  t.input.destroy();
});

// ─── Mouse look ──────────────────────────────────────────────────────────────────────────────

/**
 * @param {any} t
 * @param {number} dx
 */
function mouseMove(t, dx) {
  t.env.document.dispatchEvent({ type: 'mousemove', movementX: dx, movementY: 0 });
}

test('lookDX accumulates only while locked, and resets every poll', () => {
  const t = setup({ sensitivity: 1 });
  mouseMove(t, 100);
  assert.equal(t.input.poll().lookDX, 0, 'no lock, no drag → no look');

  t.env.document.pointerLockElement = t.env.canvas;
  assert.equal(t.input.pointerLocked, true);
  mouseMove(t, 100);
  mouseMove(t, 50);
  const dx = t.input.poll().lookDX;
  assert.ok(Math.abs(dx - 150 * 0.0024) < 1e-12, `expected 0.36 rad, got ${dx}`);
  assert.equal(t.input.poll().lookDX, 0, 'accumulator is drained by the poll');

  mouseMove(t, -40);
  assert.ok(t.input.poll().lookDX < 0, 'sign follows the mouse');
  t.input.destroy();
});

test('sensitivity scales look, invertLook flips it, both live-updatable', () => {
  const t = setup({ sensitivity: 2 });
  t.env.document.pointerLockElement = t.env.canvas;
  mouseMove(t, 100);
  assert.ok(Math.abs(t.input.poll().lookDX - 100 * 0.0024 * 2) < 1e-12);

  t.input.setOptions({ invertLook: true });
  mouseMove(t, 100);
  assert.ok(t.input.poll().lookDX < 0);

  t.input.setOptions({ invertLook: false, sensitivity: 0.5 });
  mouseMove(t, 100);
  assert.ok(Math.abs(t.input.poll().lookDX - 100 * 0.0024 * 0.5) < 1e-12);

  // Out-of-range settings are clamped to the contract's 0.2…3 rather than trusted.
  t.input.setOptions({ sensitivity: 99 });
  mouseMove(t, 100);
  assert.ok(Math.abs(t.input.poll().lookDX - 100 * 0.0024 * 3) < 1e-12);
  t.input.setOptions({ sensitivity: -5 });
  mouseMove(t, 100);
  assert.ok(Math.abs(t.input.poll().lookDX - 100 * 0.0024 * 0.2) < 1e-12);
  t.input.destroy();
});

test('mouse spikes and garbage deltas cannot teleport the aim', () => {
  const t = setup();
  t.env.document.pointerLockElement = t.env.canvas;
  mouseMove(t, 100000); // the classic pointer-lock acquisition spike
  const dx = t.input.poll().lookDX;
  assert.ok(Math.abs(dx - 180 * 0.0024) < 1e-12, `clamped to 180px, got ${dx}`);

  mouseMove(t, NaN);
  mouseMove(t, Infinity);
  t.env.document.dispatchEvent({ type: 'mousemove' }); // no movementX at all
  assert.equal(t.input.poll().lookDX, 0);

  // Even a flood of legitimate max-size deltas is capped at half a turn per step.
  for (let i = 0; i < 5000; i++) mouseMove(t, 180);
  assert.ok(Math.abs(t.input.poll().lookDX - Math.PI) < 1e-12);
  t.input.destroy();
});

test('any pointer-lock transition drops the partial gesture and the drag', () => {
  const t = setup();
  t.env.document.pointerLockElement = t.env.canvas;
  mouseMove(t, 90);
  t.env.document.pointerLockElement = null;
  t.env.document.dispatchEvent({ type: 'pointerlockchange' });
  assert.equal(t.input.poll().lookDX, 0);

  // Acquiring the lock is the other discontinuity (browsers spike on the first delta).
  t.env.document.pointerLockElement = t.env.canvas;
  mouseMove(t, 90);
  t.env.document.dispatchEvent({ type: 'pointerlockchange' });
  assert.equal(t.input.poll().lookDX, 0);
  mouseMove(t, 90);
  assert.ok(t.input.poll().lookDX > 0, 'and normal look resumes immediately after');
  t.input.destroy();
});

test('pointer lock is requested on click only while playing', () => {
  const t = setup({ playing: false });
  t.env.canvas.dispatchEvent({ type: 'click' });
  assert.equal(t.env.document.pointerLockElement, null, 'menus keep the cursor');

  t.setPlaying(true);
  t.env.canvas.dispatchEvent({ type: 'click' });
  assert.equal(t.env.document.pointerLockElement, t.env.canvas);

  // Already locked: no second request (and no error).
  t.env.canvas.dispatchEvent({ type: 'click' });
  assert.equal(t.env.document.pointerLockElement, t.env.canvas);
  t.input.destroy();
  assert.equal(t.env.document.exitPointerLockCalls, 1, 'destroy releases the pointer');
});

test('requestPointerLock is safe when unsupported or rejected', () => {
  const t = setup({ playing: true });
  delete t.env.canvas.requestPointerLock;
  t.input.requestPointerLock(); // must not throw
  assert.equal(t.env.document.pointerLockElement, null);

  // A promise-returning implementation that rejects `unadjustedMovement` must fall back.
  let calls = 0;
  t.env.canvas.requestPointerLock = (/** @type {any} */ arg) => {
    calls++;
    if (arg && arg.unadjustedMovement) return Promise.reject(new Error('unsupported'));
    t.env.document.pointerLockElement = t.env.canvas;
    return Promise.resolve();
  };
  t.input.requestPointerLock();
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    assert.equal(calls, 2, 'retried without the option');
    assert.equal(t.env.document.pointerLockElement, t.env.canvas);
    t.input.destroy();
  });
});

test('drag-look works as a pointer-lock fallback, but only while playing', () => {
  const t = setup({ playing: false });
  t.env.canvas.dispatchEvent({ type: 'mousedown', button: 0 });
  mouseMove(t, 100);
  assert.equal(t.input.poll().lookDX, 0, 'dragging in a menu must not turn the camera');

  t.setPlaying(true);
  mouseMove(t, 100);
  assert.ok(t.input.poll().lookDX > 0);

  t.env.document.dispatchEvent({ type: 'mouseup' });
  mouseMove(t, 100);
  assert.equal(t.input.poll().lookDX, 0, 'drag ended');
  t.input.destroy();
});

// ─── Gamepad ─────────────────────────────────────────────────────────────────────────────────

test('gamepad: radial deadzone swallows drift and rescales real deflection', () => {
  const t = setup();
  t.env.setGamepads([fakePad({ axes: [0.12, 0.12, 0, 0] })]);
  let f = t.input.poll();
  assert.equal(f.moveX, 0, 'resting drift inside the radial deadzone');
  assert.equal(f.moveY, 0);

  t.env.setGamepads([fakePad({ axes: [0.59, 0, 0, 0] })]);
  f = t.input.poll();
  assert.ok(Math.abs(f.moveX - 0.5) < 1e-9, `rescaled, got ${f.moveX}`);
  assert.equal(f.moveY, 0);

  // Pads report "up" as -1 on the Y axis; forward must come out positive.
  t.env.setGamepads([fakePad({ axes: [0, -1, 0, 0] })]);
  f = t.input.poll();
  assert.equal(f.moveY, 1);
  t.input.destroy();
});

test('gamepad: right stick drives turn through the deadzone and the response curve', () => {
  const t = setup();
  t.env.setGamepads([fakePad({ axes: [0, 0, 0.1, 0] })]);
  assert.equal(t.input.poll().turn, 0, 'right stick deadzone');

  t.env.setGamepads([fakePad({ axes: [0, 0, 1, 0] })]);
  assert.equal(t.input.poll().turn, 1, 'full deflection is full turn rate');

  t.env.setGamepads([fakePad({ axes: [0, 0, -1, 0] })]);
  assert.equal(t.input.poll().turn, -1);

  // Half deflection gives noticeably less than half rate (fine aim near centre).
  t.env.setGamepads([fakePad({ axes: [0, 0, 0.59, 0] })]);
  const half = t.input.poll().turn;
  assert.ok(half > 0 && half < 0.3, `expected a soft centre, got ${half}`);
  t.input.destroy();
});

test('gamepad: buttons are edge-triggered and d-pad moves', () => {
  const t = setup();
  // First poll after a pad appears re-baselines without firing (a button held at connect time).
  t.env.setGamepads([fakePad({ pressed: [0] })]);
  assert.equal(t.input.poll().pressed.size, 0, 'no phantom press on connect');
  assert.equal(t.input.poll().pressed.size, 0, 'still held → still silent');

  t.env.setGamepads([fakePad({ pressed: [] })]);
  t.input.poll();
  t.env.setGamepads([fakePad({ pressed: [0] })]);
  assert.ok(t.input.poll().pressed.has('confirm'), 'A confirms');
  t.env.setGamepads([fakePad({ pressed: [] })]);
  t.input.poll();

  /** @param {number[]} pressed @returns {Set<string>} */
  const tap = (pressed) => {
    t.env.setGamepads([fakePad({ pressed })]);
    const set = new Set(t.input.poll().pressed);
    t.env.setGamepads([fakePad({ pressed: [] })]);
    t.input.poll();
    return set;
  };
  assert.ok(tap([1]).has('back'), 'B goes back');
  assert.ok(tap([9]).has('pause'), 'Start pauses');
  assert.ok(tap([8]).has('map'), 'Back/View toggles the map');

  // D-pad: up/down move, left/right turn, and they also navigate menus.
  t.env.setGamepads([fakePad({ pressed: [12] })]);
  let f = t.input.poll();
  assert.equal(f.moveY, 1);
  assert.ok(f.pressed.has('up'));
  t.env.setGamepads([fakePad({ pressed: [14] })]);
  f = t.input.poll();
  assert.equal(f.turn, -1);
  assert.ok(f.pressed.has('left'));
  t.input.destroy();
});

test('gamepad: triggers sprint, and a disconnected pad is ignored', () => {
  const t = setup();
  t.env.setGamepads([fakePad({ pressed: [7] })]);
  assert.equal(t.input.poll().sprint, true);
  t.env.setGamepads([null, undefined]);
  assert.equal(t.input.poll().sprint, false);
  t.env.setGamepads([{ connected: false, axes: [1, 1], buttons: [] }]);
  const f = t.input.poll();
  assert.equal(f.moveX, 0, 'a disconnected pad contributes nothing');
  t.input.destroy();
});

test('gamepad: menu navigation repeats on a held direction, with a delay first', () => {
  const t = setup();
  t.env.setGamepads([fakePad({ axes: [0, -1, 0, 0] })]); // stick held forward = menu "up"
  assert.ok(t.input.poll().pressed.has('up'), 'immediate first move');
  t.env.advance(100);
  assert.equal(t.input.poll().pressed.size, 0, 'no machine-gunning before the delay');
  t.env.advance(200);
  t.input.poll();
  t.env.advance(200);
  assert.ok(t.input.poll().pressed.has('up'), 'repeats after ~0.42 s');
  t.env.advance(120);
  assert.ok(t.input.poll().pressed.has('up'), 'then at the faster interval');
  t.input.destroy();
});

test('gamepad: a hostile getGamepads implementation cannot break the poll', () => {
  const t = setup();
  t.env.navigator.getGamepads = () => {
    throw new Error('permission denied');
  };
  assert.equal(t.input.poll().moveX, 0);
  t.env.navigator.getGamepads = () => null;
  assert.equal(t.input.poll().moveX, 0);
  t.env.navigator.getGamepads = () => [{ axes: [NaN, NaN, NaN], buttons: [null, 1, {}] }];
  const f = t.input.poll();
  assert.equal(f.moveX, 0);
  assert.equal(Number.isFinite(f.turn), true);
  t.input.destroy();
});

// ─── Touch ───────────────────────────────────────────────────────────────────────────────────

test('touch: the left 40% is a dynamic-origin virtual stick', () => {
  const t = setup();
  assert.equal(t.input.isTouch, false);

  // Thumb lands at (100,500): inside the left 40% of an 800px-wide canvas.
  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: 100, y: 500 }]));
  assert.equal(t.input.isTouch, true, 'the first real touch proves the device');
  let f = t.input.poll();
  assert.equal(f.moveX, 0, 'the origin is where the thumb landed, so it starts centred');
  assert.equal(f.moveY, 0);

  // Push right by a third of the ring radius: past the deadzone, well short of full.
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 1, x: 130, y: 500 }]));
  f = t.input.poll();
  assert.ok(f.moveX > 0.2 && f.moveX < 0.6, `partial deflection, got ${f.moveX}`);
  assert.equal(f.moveY, 0);

  // Up the screen is forward.
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 1, x: 100, y: 440 }]));
  f = t.input.poll();
  assert.equal(f.moveY, 1, 'a full-radius push forward is full speed');
  assert.equal(f.sprint, true, 'pinning the stick sprints');

  // Beyond the ring the origin follows, so the thumb can always come back.
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 1, x: 100, y: 200 }]));
  t.input.poll();
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 1, x: 100, y: 230 }]));
  f = t.input.poll();
  assert.ok(f.moveY < 1 && f.moveY > 0, `origin followed the thumb, got ${f.moveY}`);

  t.env.canvas.dispatchEvent(touchEvent('touchend', [{ id: 1, x: 100, y: 230 }]));
  f = t.input.poll();
  assert.equal(f.moveY, 0);
  assert.equal(f.sprint, false);
  t.input.destroy();
});

test('touch: the right side drags to look, independently of the stick', () => {
  const t = setup();
  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 2, x: 600, y: 300 }]));
  assert.equal(t.input.poll().lookDX, 0, 'no movement yet');

  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 2, x: 700, y: 300 }]));
  const dx = t.input.poll().lookDX;
  assert.ok(Math.abs(dx - 100 * 0.0038) < 1e-12, `100px drag, got ${dx}`);
  assert.equal(t.input.poll().lookDX, 0, 'drained');

  // Both thumbs at once: stick and look do not interfere.
  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 3, x: 80, y: 500 }]));
  t.env.canvas.dispatchEvent(
    touchEvent('touchmove', [
      { id: 3, x: 80, y: 440 },
      { id: 2, x: 640, y: 300 },
    ])
  );
  const f = t.input.poll();
  assert.equal(f.moveY, 1);
  assert.ok(f.lookDX < 0, 'dragging left looks left');

  t.env.canvas.dispatchEvent(touchEvent('touchcancel', [{ id: 2, x: 640, y: 300 }]));
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 2, x: 700, y: 300 }]));
  assert.equal(t.input.poll().lookDX, 0, 'a cancelled touch stops steering');
  t.input.destroy();
});

test('touch: browser scroll/zoom gestures are suppressed on the game element only', () => {
  const t = setup();
  /** @type {any} */
  const start = touchEvent('touchstart', [{ id: 1, x: 600, y: 300 }]);
  t.env.canvas.dispatchEvent(start);
  assert.equal(start.defaultPrevented, true);
  /** @type {any} */
  const move = touchEvent('touchmove', [{ id: 1, x: 620, y: 300 }]);
  t.env.canvas.dispatchEvent(move);
  assert.equal(move.defaultPrevented, true);
  for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'contextmenu', 'dblclick']) {
    /** @type {any} */
    const ev = { type, cancelable: true };
    t.env.canvas.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, type);
  }
  // The canvas itself opts out of native gesture handling, and puts the value back on destroy.
  assert.equal(t.env.canvas.style.touchAction, 'none');
  t.input.destroy();
  assert.equal(t.env.canvas.style.touchAction, '');
});

test('touch: blur releases both thumbs', () => {
  const t = setup();
  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: 100, y: 500 }]));
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 1, x: 100, y: 440 }]));
  assert.equal(t.input.poll().moveY, 1);
  t.env.window.dispatchEvent({ type: 'blur' });
  assert.equal(t.input.poll().moveY, 0);
  t.input.destroy();
});

test('touch overlay: created on first touch, emits pause/map, removed on destroy', () => {
  const t = setup();
  assert.equal(t.env.touchRoot.childNodes.length, 0, 'nothing drawn until a finger arrives');

  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: 600, y: 300 }]));
  assert.equal(t.env.touchRoot.childNodes.length, 1, 'overlay mounted into #touch');

  const layer = t.env.touchRoot.childNodes[0];
  const pauseBtn = layer.findByText('PAUSE');
  const mapBtn = layer.findByText('MAP');
  assert.ok(pauseBtn && mapBtn);
  pauseBtn.dispatchEvent({ type: 'touchstart', cancelable: true });
  mapBtn.dispatchEvent({ type: 'touchstart', cancelable: true });
  const pressed = t.input.poll().pressed;
  assert.ok(pressed.has('pause'));
  assert.ok(pressed.has('map'));

  t.input.destroy();
  assert.equal(t.env.touchRoot.childNodes.length, 0, 'overlay removed with the input');
});

test('touch overlay is created up front on a touch-primary device', () => {
  const t = setup({ coarsePointer: true });
  assert.equal(t.input.isTouch, true);
  assert.equal(t.env.touchRoot.childNodes.length, 1);
  t.input.destroy();
});

test('touchOverlay:false suppresses the on-screen controls but keeps the gestures', () => {
  const t = setup({ touchOverlay: false });
  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: 100, y: 500 }]));
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 1, x: 100, y: 440 }]));
  assert.equal(t.env.touchRoot.childNodes.length, 0);
  assert.equal(t.input.poll().moveY, 1);
  t.input.destroy();
});

// ─── Frame identity, lifecycle and leaks ─────────────────────────────────────────────────────

test('poll() reuses one frame object and one Set (no per-step allocation)', () => {
  const t = setup();
  const a = t.input.poll();
  t.keyDown('Enter');
  const b = t.input.poll();
  assert.equal(a, b, 'same frame instance');
  assert.equal(a.pressed, b.pressed, 'same Set instance');
  assert.ok(b.pressed.has('confirm'));
  const c = t.input.poll();
  assert.equal(c.pressed.size, 0, 'the Set is cleared, not replaced');
  t.input.destroy();
});

test('the frame always carries the exact contract shape', () => {
  const t = setup();
  const f = t.input.poll();
  assert.deepEqual(Object.keys(f).sort(), ['lookDX', 'moveX', 'moveY', 'pressed', 'sprint', 'turn']);
  assert.equal(typeof f.moveX, 'number');
  assert.equal(typeof f.moveY, 'number');
  assert.equal(typeof f.turn, 'number');
  assert.equal(typeof f.lookDX, 'number');
  assert.equal(typeof f.sprint, 'boolean');
  assert.ok(f.pressed instanceof Set);
  t.input.destroy();
});

test('axes stay inside -1..1 no matter how many sources push at once', () => {
  const t = setup();
  t.keyDown('KeyW');
  t.keyDown('KeyD');
  t.keyDown('ArrowRight');
  t.env.setGamepads([fakePad({ axes: [1, -1, 1, 0], pressed: [12, 15] })]);
  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: 100, y: 500 }]));
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 1, x: 300, y: 300 }]));
  const f = t.input.poll();
  assert.equal(f.moveX, 1);
  assert.equal(f.moveY, 1);
  assert.equal(f.turn, 1);
  t.input.destroy();
});

test('destroy() removes every listener it added, and is idempotent', () => {
  const env = createFakeEnv();
  const before = env.totalListeners();
  assert.equal(before, 0);

  const input = createInput(env.canvas, {
    env: { window: env.window, document: env.document, navigator: env.navigator, performance: env.performance },
  });
  // Force the overlay to exist so its listeners are part of the count too.
  env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: 600, y: 300 }]));
  assert.ok(env.totalListeners() > 10, 'listeners were actually installed');

  input.destroy();
  assert.equal(env.totalListeners(), 0, 'not one listener left behind');
  input.destroy(); // idempotent
  assert.equal(env.totalListeners(), 0);
});

test('a destroyed input is inert but still safe to call', () => {
  const t = setup({ playing: true });
  t.keyDown('KeyW');
  t.input.destroy();
  t.keyDown('KeyD'); // listener is gone; nothing should change
  t.input.requestPointerLock();
  t.input.updateOverlay({ phase: 'playing' });
  t.input.setOptions({ sensitivity: 2 });
  const f = t.input.poll();
  assert.equal(f.moveX, 0);
  assert.equal(f.moveY, 0);
  assert.equal(f.pressed.size, 0);
  assert.equal(t.env.document.pointerLockElement, null);
});

test('createInput survives a hostile or absent environment', () => {
  // No DOM at all: the frame is neutral and nothing throws.
  const input = createInput(null, { env: { window: null, document: null, navigator: null, performance: null } });
  const f = input.poll();
  assert.equal(f.moveX, 0);
  assert.equal(f.lookDX, 0);
  assert.equal(f.pressed.size, 0);
  assert.equal(input.isTouch, false);
  assert.equal(input.pointerLocked, false);
  input.requestPointerLock();
  input.updateOverlay(null);
  input.setOptions({});
  input.destroy();

  // A canvas that reports a zero-size rect must not divide by zero when splitting the screen.
  const env = createFakeEnv();
  env.canvas.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
  const b = createInput(env.canvas, {
    env: { window: env.window, document: env.document, navigator: env.navigator, performance: env.performance },
  });
  env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: 10, y: 10 }]));
  assert.ok(Number.isFinite(b.poll().moveX));
  b.destroy();
});

test('updateOverlay forwards the phase to the on-screen controls', () => {
  const t = setup({ coarsePointer: true });
  const layer = t.env.touchRoot.childNodes[0];
  t.input.updateOverlay({ phase: 'playing' });
  assert.notEqual(layer.style.display, 'none');
  t.input.updateOverlay({ phase: 'paused' });
  assert.equal(layer.style.display, 'none', 'menus own the screen while paused');
  t.input.updateOverlay({ phase: 'playing' });
  assert.equal(layer.style.display, '');
  t.input.destroy();
});
