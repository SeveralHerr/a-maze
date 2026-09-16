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
  assert.equal(wasPrevented('KeyW'), false, 'letters never scroll');
  assert.equal(wasPrevented('F5'), false, 'unbound keys are untouched');

  // With a text field focused the game must keep its hands off the keyboard entirely.
  const field = t.env.document.createElement('input');
  t.env.document.activeElement = field;
  assert.equal(wasPrevented('Space'), false);
  t.env.document.activeElement = null;
  t.input.destroy();
});

test('Tab never traps keyboard focus: swallowed only during play, never with Shift', () => {
  const t = setup({ playing: false });
  /** @param {string} code @param {any} [extra] @returns {boolean} */
  const wasPrevented = (code, extra) => {
    /** @type {any} */
    const ev = Object.assign({ type: 'keydown', code, repeat: false, cancelable: true }, extra);
    t.env.window.dispatchEvent(ev);
    t.env.window.dispatchEvent({ type: 'keyup', code });
    return ev.defaultPrevented === true;
  };
  // On the title/options screens the map binding is worth nothing and the focus ring is worth
  // everything: a keyboard-only player must be able to tab out of the canvas (WCAG 2.1.2).
  assert.equal(wasPrevented('Tab'), false, 'menus must not eat Tab');
  t.setPlaying(true);
  assert.equal(wasPrevented('Tab'), true, 'during play Tab is the second map key');
  assert.equal(wasPrevented('Tab', { shiftKey: true }), false, 'Shift+Tab always walks focus back');
  assert.equal(wasPrevented('ArrowUp'), true, 'the other suppressed keys are unaffected');
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

test('lookDX accumulates while locked, and resets every poll', () => {
  const t = setup({ sensitivity: 1 });
  mouseMove(t, 100);
  mouseMove(t, 100);
  assert.equal(t.input.poll().lookDX, 0, 'not playing, not locked → no look');

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

test('mouse: a real high-DPI flick passes through intact; glitches are dropped, not clamped', () => {
  const t = setup();
  t.env.document.pointerLockElement = t.env.canvas;
  // One animation frame of a 3200 DPI flick: Chrome coalesces this into a single event.
  mouseMove(t, 600);
  let dx = t.input.poll().lookDX;
  assert.ok(Math.abs(dx - 600 * 0.0024) < 1e-12, `600 counts must not be clamped, got ${dx}`);
  mouseMove(t, -900);
  dx = t.input.poll().lookDX;
  assert.ok(Math.abs(dx + 900 * 0.0024) < 1e-12, `and not in the other direction either, got ${dx}`);

  // A driver/wake glitch is thrown away entirely rather than becoming a maximum-size turn.
  mouseMove(t, 100000);
  mouseMove(t, -50000);
  assert.equal(t.input.poll().lookDX, 0);

  mouseMove(t, NaN);
  mouseMove(t, Infinity);
  t.env.document.dispatchEvent({ type: 'mousemove' }); // no movementX at all
  assert.equal(t.input.poll().lookDX, 0);

  // Even a flood of plausible deltas is capped at half a turn per step.
  for (let i = 0; i < 5000; i++) mouseMove(t, 1500);
  assert.ok(Math.abs(t.input.poll().lookDX - Math.PI) < 1e-12);
  t.input.destroy();
});

test('mouse: the jumbo delta at pointer-lock engagement is dropped, then look resumes', () => {
  const t = setup();
  t.env.document.pointerLockElement = t.env.canvas;
  t.env.document.dispatchEvent({ type: 'pointerlockchange' });
  mouseMove(t, 1400); // Chrome's cursor-to-origin jump, delivered with the lock
  assert.equal(t.input.poll().lookDX, 0, 'first move after engagement is ignored');
  mouseMove(t, 40);
  assert.equal(t.input.poll().lookDX, 0, 'and anything inside the settle window');
  t.env.advance(60);
  mouseMove(t, 40);
  assert.ok(Math.abs(t.input.poll().lookDX - 40 * 0.0024) < 1e-12, 'normal look ~one frame later');

  // Moves arriving long after engagement: only the very first is sacrificed.
  const u = setup();
  u.env.document.pointerLockElement = u.env.canvas;
  u.env.document.dispatchEvent({ type: 'pointerlockchange' });
  u.env.advance(500);
  mouseMove(u, 30);
  mouseMove(u, 30);
  assert.ok(Math.abs(u.input.poll().lookDX - 30 * 0.0024) < 1e-12);
  u.input.destroy();
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
  t.env.advance(100);
  mouseMove(t, 90); // the engagement spike slot
  mouseMove(t, 90);
  assert.ok(t.input.poll().lookDX > 0, 'and normal look resumes right after');
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

test('mouse look works without pointer lock while playing, never in menus', () => {
  const t = setup({ playing: false });
  // Take the lock API away so nothing can capture the pointer out from under the test.
  delete t.env.canvas.requestPointerLock;
  mouseMove(t, 100);
  mouseMove(t, 100);
  assert.equal(t.input.poll().lookDX, 0, 'moving the cursor over a menu must not turn the camera');

  t.setPlaying(true);
  mouseMove(t, 1400); // the first free move is the cursor's jump since the menu: dropped
  assert.equal(t.input.poll().lookDX, 0);
  mouseMove(t, 100);
  mouseMove(t, 50);
  let dx = t.input.poll().lookDX;
  assert.ok(Math.abs(dx - 150 * 0.0024) < 1e-12, `expected 0.36 rad, got ${dx}`);

  // Sensitivity and invert apply to free look exactly as to locked look.
  t.input.setOptions({ sensitivity: 2, invertLook: true });
  mouseMove(t, 100);
  dx = t.input.poll().lookDX;
  assert.ok(Math.abs(dx + 100 * 0.0024 * 2) < 1e-12, `got ${dx}`);

  // A glitch is still dropped unlocked.
  mouseMove(t, 100000);
  assert.equal(t.input.poll().lookDX, 0);

  t.setPlaying(false);
  mouseMove(t, 100);
  assert.equal(t.input.poll().lookDX, 0, 'back in a menu');
  t.input.destroy();
});

test('free mouse look: the first move after a pause in motion is dropped (cursor re-entry)', () => {
  const t = setup({ playing: true });
  delete t.env.canvas.requestPointerLock;
  mouseMove(t, 10);
  mouseMove(t, 10);
  assert.ok(Math.abs(t.input.poll().lookDX - 10 * 0.0024) < 1e-12);

  // The cursor leaves the iframe and comes back in on the other side.
  t.env.advance(150);
  mouseMove(t, 1400);
  assert.equal(t.input.poll().lookDX, 0, 'the re-entry jump is not a turn');
  t.env.advance(16);
  mouseMove(t, 20);
  assert.ok(Math.abs(t.input.poll().lookDX - 20 * 0.0024) < 1e-12, 'continuous motion resumes');

  // Blur re-arms the guard too.
  t.env.window.dispatchEvent({ type: 'blur' });
  mouseMove(t, 500);
  assert.equal(t.input.poll().lookDX, 0);
  t.input.destroy();
});

test('arrow-key turning and free mouse look apply in the same frame', () => {
  const t = setup({ playing: true });
  delete t.env.canvas.requestPointerLock;
  t.keyDown('ArrowRight');
  mouseMove(t, 30);
  mouseMove(t, 30);
  const f = t.input.poll();
  assert.equal(f.turn, 1, 'the key still turns');
  assert.ok(f.lookDX > 0, 'and the mouse adds to it');
  t.input.destroy();
});

test('touch devices never take look from synthesised mouse moves', () => {
  const t = setup({ coarsePointer: true, playing: true });
  delete t.env.canvas.requestPointerLock;
  // The compatibility mouse events a browser emits right after a tap.
  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: 600, y: 300 }]));
  t.env.canvas.dispatchEvent(touchEvent('touchend', [{ id: 1, x: 600, y: 300 }]));
  mouseMove(t, 100);
  mouseMove(t, 100);
  t.env.canvas.dispatchEvent({ type: 'mousedown', button: 0 });
  t.env.canvas.dispatchEvent({ type: 'click' });
  assert.equal(t.input.poll().lookDX, 0, 'echoes inside the ghost window are ignored');

  // Engines with InputDeviceCapabilities say so outright, however late the echo arrives.
  t.env.advance(5000);
  const echo = { sourceCapabilities: { firesTouchEvents: true } };
  for (let i = 0; i < 3; i++) t.env.document.dispatchEvent({ type: 'mousemove', movementX: 50, ...echo });
  assert.equal(t.input.poll().lookDX, 0);
  assert.equal(t.input.wantsPointer, false, 'touch is still in control');
  t.input.destroy();
});

test('regression: a touchscreen laptop reporting (pointer: coarse) still gets mouse look and pointer lock', () => {
  // Windows Chrome on a touchscreen laptop: `(pointer: coarse)` true, `(any-pointer: fine)` false,
  // maxTouchPoints 10 — while the player uses a real mouse. The hint used to latch "touch device",
  // which disabled click-to-lock, the automatic lock and free mouse look: a visible cursor and a
  // dead camera.
  const t = setup({ coarsePointer: true, playing: true });
  assert.equal(t.input.isTouch, true, 'the on-screen controls may still show');
  mouseMove(t, 20);
  mouseMove(t, 40);
  assert.ok(Math.abs(t.input.poll().lookDX - 40 * 0.0024) < 1e-12, 'free mouse look turns the camera');
  assert.equal(t.input.wantsPointer, true, 'and the game wants the pointer');

  t.env.canvas.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0 });
  assert.equal(t.env.document.pointerLockElement, t.env.canvas, 'a click captures the mouse');
  t.input.destroy();

  // Keyboard resume on the same device, after the mouse has been used, re-locks automatically.
  const k = setup({ coarsePointer: true, playing: false });
  mouseMove(k, 5);
  k.keyDown('Enter');
  k.setPlaying(true);
  k.input.poll();
  assert.equal(k.env.document.pointerLockElement, k.env.canvas);
  k.input.destroy();
});

test('hybrid device: a real touch hands look to touch, a later real mouse takes it back', () => {
  const t = setup({ playing: true });
  delete t.env.canvas.requestPointerLock;
  mouseMove(t, 10);
  mouseMove(t, 10);
  assert.ok(t.input.poll().lookDX > 0);

  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: 600, y: 300 }]));
  t.env.canvas.dispatchEvent(touchEvent('touchend', [{ id: 1, x: 600, y: 300 }]));
  t.input.poll();
  mouseMove(t, 10);
  mouseMove(t, 10);
  assert.equal(t.input.poll().lookDX, 0, 'the echo of the tap does not turn the camera');
  assert.equal(t.input.wantsPointer, false);

  t.env.advance(1500);
  mouseMove(t, 10); // real mouse, but the first free move after a gap is the re-entry guard
  mouseMove(t, 10);
  assert.ok(Math.abs(t.input.poll().lookDX - 10 * 0.0024) < 1e-12, 'the mouse is back in control');
  t.input.destroy();
});

test('pointer lock is requested on the mouse press, before a fullscreen request can consume the gesture', () => {
  const t = setup({ playing: true });
  let requests = 0;
  t.env.canvas.requestPointerLock = () => {
    requests++; // pending: a real browser answers a task later
  };
  // A second listener registered after input.js (main.js's fullscreen request) must see the lock
  // already asked for.
  let requestsSeenByLaterListener = -1;
  t.env.canvas.addEventListener('pointerdown', () => {
    requestsSeenByLaterListener = requests;
  });
  t.env.canvas.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0 });
  assert.equal(requestsSeenByLaterListener, 1);
  t.env.canvas.dispatchEvent({ type: 'mousedown', button: 0 });
  t.env.canvas.dispatchEvent({ type: 'click' });
  assert.equal(requests, 1, 'the compatibility mousedown and the click do not ask again');

  // A refusal is retried by the next press, even after the automatic path gave up.
  t.env.advance(600);
  t.env.canvas.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0 });
  assert.equal(requests, 2);

  // Right-clicks, touch and pen presses never ask.
  t.env.advance(600);
  t.env.canvas.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 2 });
  t.env.canvas.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', button: 0 });
  t.env.canvas.dispatchEvent({ type: 'pointerdown', pointerType: 'pen', button: 0 });
  assert.equal(requests, 2);

  // Menus never ask.
  t.setPlaying(false);
  t.env.advance(600);
  t.env.canvas.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0 });
  assert.equal(requests, 2);
  t.input.destroy();
});

test('a menu click whose mousedown was suppressed (pointerdown preventDefault) still authorises the lock', () => {
  // main.js calls preventDefault on a pointerdown the menus consumed; browsers then never deliver
  // the compatibility mousedown. Only pointerdown and click arrive.
  const t = setup({ playing: false });
  t.env.canvas.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0 });
  t.env.canvas.dispatchEvent({ type: 'click' });
  assert.equal(t.env.document.pointerLockElement, null, 'menus keep the cursor');
  t.env.advance(900); // loading
  t.setPlaying(true);
  t.input.poll();
  assert.equal(t.env.document.pointerLockElement, t.env.canvas, 'captured once play begins');
  t.input.destroy();
});

test('a mouse click that starts a level authorises the pointer lock once play begins', () => {
  // Clicking "New Game" lands during `loading`: onClick cannot lock then.
  const t = setup({ playing: false });
  t.env.canvas.dispatchEvent({ type: 'mousedown', button: 0 });
  t.env.canvas.dispatchEvent({ type: 'click' });
  assert.equal(t.env.document.pointerLockElement, null, 'menus keep the cursor');
  t.env.advance(900); // the loading screen
  t.setPlaying(true);
  t.input.poll();
  assert.equal(t.env.document.pointerLockElement, t.env.canvas, 'captured without a second click');

  // A right-click is not treated as that authorisation.
  const u = setup({ playing: false });
  u.env.canvas.dispatchEvent({ type: 'mousedown', button: 2 });
  u.setPlaying(true);
  u.input.poll();
  assert.equal(u.env.document.pointerLockElement, null);
  u.input.destroy();
  t.input.destroy();
});

test('pointer lock is re-acquired on the next poll after a keyboard resume', () => {
  const t = setup({ playing: false });

  // Paused, with the pointer released exactly as main.js does on leaving `playing`.
  t.env.canvas.dispatchEvent({ type: 'click' });
  assert.equal(t.env.document.pointerLockElement, null, 'menus keep the cursor');

  // The player presses Enter on the pause menu; main.js flips the phase for the next step.
  t.keyDown('Enter');
  t.setPlaying(true);
  t.input.poll();
  assert.equal(t.env.document.pointerLockElement, t.env.canvas, 'the mouse is live without a click');

  // And mouse look actually works now, which is the point of the whole exercise.
  mouseMove(t, 100);
  assert.ok(Math.abs(t.input.poll().lookDX - 100 * 0.0024) < 1e-12);
  t.input.destroy();
});

test('automatic pointer lock is gated by gesture, phase, cooldown and refusals', () => {
  const t = setup({ playing: true });
  let requests = 0;
  t.env.canvas.requestPointerLock = () => {
    requests++;
    // A browser that refuses: the lock never lands and `pointerlockerror` is delivered.
    t.env.document.dispatchEvent({ type: 'pointerlockerror' });
  };

  // No gesture yet in this session → nothing is asked for.
  t.env.advance(9000);
  t.input.poll();
  assert.equal(requests, 0, 'a request without a user gesture would only be refused');

  t.keyDown('KeyW');
  t.input.poll();
  assert.equal(requests, 1, 'a keypress authorises the request');
  t.input.poll();
  t.input.poll();
  assert.equal(requests, 1, 'and the cooldown stops a request storm');

  // After a refusal the retry comes soon (Chrome refuses for ~1 s after an Escape release) ...
  t.env.advance(100);
  t.input.poll();
  assert.equal(requests, 1, 'but not every poll');
  t.env.advance(160);
  t.input.poll();
  assert.equal(requests, 2, 'a refused request is retried after ~250 ms, not 1.2 s');
  // ... and stops after a bounded number of refusals (~2 s of trying).
  for (let i = 0; i < 20; i++) {
    t.env.advance(260);
    t.input.poll();
  }
  assert.equal(requests, 8, 'eight refusals and the module stops asking');
  t.env.advance(1300);
  t.input.poll();
  assert.equal(requests, 8);

  // A deliberate click is the player saying "try again".
  t.env.canvas.dispatchEvent({ type: 'click' });
  assert.equal(requests, 9);

  // Touch devices never want the pointer at all.
  const m = setup({ coarsePointer: true, playing: true });
  let touchRequests = 0;
  m.env.canvas.requestPointerLock = () => {
    touchRequests++;
  };
  m.keyDown('KeyW');
  m.env.advance(10);
  m.input.poll();
  assert.equal(touchRequests, 0);
  m.input.destroy();
  t.input.destroy();
});

test('a refused lock right after Escape lands within ~a second of a keyboard resume', () => {
  const t = setup({ playing: true });
  const refuseUntil = t.env.performance.now() + 1000; // Chrome's post-Escape window
  t.env.canvas.requestPointerLock = () => {
    if (t.env.performance.now() < refuseUntil) {
      t.env.document.dispatchEvent({ type: 'pointerlockerror' });
      return;
    }
    t.env.document.pointerLockElement = t.env.canvas;
    t.env.document.dispatchEvent({ type: 'pointerlockchange' });
  };
  assert.equal(t.input.wantsPointer, true, 'playing without the pointer: the HUD may prompt');
  t.keyDown('Enter');
  let lockedAt = -1;
  for (let ms = 0; ms <= 3000; ms += 16) {
    t.input.poll();
    if (t.input.pointerLocked) {
      lockedAt = ms;
      break;
    }
    t.env.advance(16);
  }
  assert.ok(lockedAt >= 1000 && lockedAt <= 1300, `locked at ${lockedAt} ms`);
  assert.equal(t.input.wantsPointer, false, 'prompt clears once the pointer is ours');
  t.setPlaying(false);
  t.env.document.pointerLockElement = null;
  assert.equal(t.input.wantsPointer, false, 'menus never want the pointer');
  t.input.destroy();

  const m = setup({ coarsePointer: true, playing: true });
  assert.equal(m.input.wantsPointer, false, 'touch devices never prompt for a mouse');
  m.input.destroy();
});

test('setBindings: a remap drives the game, releases held keys, and null restores defaults', async () => {
  const { createBindings } = await import('./bindings.js');
  const t = setup();
  t.keyDown('KeyW');
  assert.equal(t.input.poll().moveY, 1);

  // ESDF layout; W unbound.
  t.input.setBindings(
    createBindings({
      KeyE: ['forward', 'up'],
      KeyD: ['backward', 'down'],
      KeyS: ['strafeLeft', 'left'],
      KeyF: ['strafeRight', 'right'],
      KeyW: [],
      KeyA: [],
      KeyQ: [],
    }),
  );
  assert.equal(t.input.poll().moveY, 0, 'the key held across the swap is released');
  t.keyUp('KeyW');
  t.keyDown('KeyW');
  assert.equal(t.input.poll().moveY, 0, 'W is unbound now');
  t.keyUp('KeyW');
  t.keyDown('KeyE');
  let f = t.input.poll();
  assert.equal(f.moveY, 1);
  assert.ok(f.pressed.has('up'), 'menu nav follows the remap');
  t.keyUp('KeyE');
  t.keyDown('KeyS');
  assert.equal(t.input.poll().moveX, -1);
  t.keyUp('KeyS');
  // Escape can never be remapped away.
  t.keyDown('Escape');
  f = t.input.poll();
  assert.ok(f.pressed.has('pause') && f.pressed.has('back'));
  t.keyUp('Escape');

  t.input.setBindings(null);
  t.keyDown('KeyW');
  assert.equal(t.input.poll().moveY, 1, 'defaults are back');
  t.input.setBindings(/** @type {any} */ ({ keyHold: 3 }));
  t.keyDown('KeyA');
  assert.equal(t.input.poll().moveX, -1, 'garbage tables fall back to the defaults');
  t.input.destroy();

  // Also accepted at construction.
  const env = createFakeEnv();
  const input = createInput(env.canvas, {
    bindings: createBindings({ KeyI: ['forward'] }),
    env: { window: env.window, document: env.document, navigator: env.navigator, performance: env.performance },
  });
  env.window.dispatchEvent({ type: 'keydown', code: 'KeyI', cancelable: true });
  assert.equal(input.poll().moveY, 1);
  input.destroy();
});

test('setBindings keeps poll() allocation-free (tables are swapped, not copied)', async () => {
  const { createBindings } = await import('./bindings.js');
  const t = setup();
  t.input.setBindings(createBindings({ KeyI: ['forward'] }));
  const a = t.input.poll();
  t.keyDown('KeyI');
  const b = t.input.poll();
  assert.equal(a, b);
  assert.equal(a.pressed, b.pressed);
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

  // Radial like the left stick: a small vertical wobble does not re-open the X deadzone, and a
  // thumb resting diagonally inside the radial zone does not turn at all.
  t.env.setGamepads([fakePad({ axes: [0, 0, 0.12, 0.1] })]);
  assert.equal(t.input.poll().turn, 0, 'inside the radial deadzone');
  t.env.setGamepads([fakePad({ axes: [0, 0, 0.7071, 0.7071] })]);
  const diag = t.input.poll().turn;
  t.env.setGamepads([fakePad({ axes: [0, 0, 0.7071, 0] })]);
  const flat = t.input.poll().turn;
  assert.ok(diag > flat, `same X, more total deflection → past the deadzone sooner (${diag} vs ${flat})`);
  // A 3-axis pad still turns.
  t.env.setGamepads([fakePad({ axes: [0, 0, 1] })]);
  assert.equal(t.input.poll().turn, 1);
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
  assert.ok(tap([3]).has('mute'), 'Y mutes');
  assert.equal(tap([5]).size, 0, 'RB is not a mute a sprinting thumb can graze');

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

/**
 * Poll often enough that the "no pad has ever been seen" probe throttle cannot hide the pad under
 * test. While nothing is connected the module samples `getGamepads()` twice a second, not 60 times.
 * @param {any} t
 * @returns {any} the last frame
 */
function pollPastProbe(t) {
  let f = t.input.poll();
  for (let i = 0; i < 40; i++) f = t.input.poll();
  return f;
}

test('gamepad: triggers sprint, and a disconnected pad is ignored', () => {
  const t = setup();
  t.env.setGamepads([fakePad({ pressed: [7] })]);
  assert.equal(t.input.poll().sprint, true);
  t.env.setGamepads([null, undefined]);
  assert.equal(t.input.poll().sprint, false);
  t.env.setGamepads([{ connected: false, mapping: 'standard', axes: [1, 1], buttons: [] }]);
  const f = pollPastProbe(t);
  assert.equal(f.moveX, 0, 'a disconnected pad contributes nothing');
  t.input.destroy();
});

test('gamepad: a non-standard pad cannot spin the camera (its axis 2 often rests at -1)', () => {
  const t = setup();
  // Chrome reports mapping:'' for any HID pad it does not recognise. On a great many of those,
  // axis 2 is a trigger sitting at -1 — under the standard-mapping assumption that is a right
  // stick held hard over, and the player spins at full rate without touching anything.
  t.env.setGamepads([fakePad({ mapping: '', axes: [0, 0, -1, 0] })]);
  for (let i = 0; i < 60; i++) {
    const f = t.input.poll();
    assert.equal(f.turn, 0, 'an unmapped axis 2 is never read as yaw');
    assert.equal(f.moveX, 0);
    assert.equal(f.moveY, 0);
  }

  t.input.destroy();

  // The left stick still works on such a pad, but only once an axis has proven it is a control by
  // moving away from the value it was resting at when the pad was adopted.
  const u = setup();
  u.env.setGamepads([fakePad({ mapping: '', axes: [-1, 0, -1, 0] })]);
  for (let i = 0; i < 10; i++) {
    assert.equal(u.input.poll().moveX, 0, 'an axis resting at -1 is not a stick held left');
  }
  u.env.setGamepads([fakePad({ mapping: '', axes: [0.59, 0, -1, 0] })]);
  const f = u.input.poll();
  assert.ok(Math.abs(f.moveX - 0.5) < 1e-9, `a deliberate deflection is honoured, got ${f.moveX}`);
  assert.equal(f.turn, 0, 'and axis 2 stays ignored');
  u.input.destroy();
});

test('gamepad: a non-standard pad holding a button at rest cannot sprint or act forever', () => {
  const t = setup();
  t.env.setGamepads([fakePad({ mapping: '', pressed: [7, 9] })]);
  for (let i = 0; i < 30; i++) {
    const f = t.input.poll();
    assert.equal(f.sprint, false, 'a resting trigger reported as a pressed button is not sprint');
    assert.equal(f.pressed.size, 0);
  }
  // Once the same control has been seen released it is a real button and behaves normally.
  t.env.setGamepads([fakePad({ mapping: '', pressed: [] })]);
  t.input.poll();
  t.env.setGamepads([fakePad({ mapping: '', pressed: [7] })]);
  assert.equal(t.input.poll().sprint, true);
  t.input.destroy();
});

test('gamepad: a standard pad wins over a non-standard one at a lower index', () => {
  const t = setup();
  t.env.setGamepads([
    fakePad({ mapping: '', index: 0, axes: [0, 0, -1, 0] }),
    fakePad({ mapping: 'standard', index: 1, axes: [0, 0, 1, 0] }),
  ]);
  assert.equal(t.input.poll().turn, 1, 'the real controller is the one that drives');
  // And the buttons of the adopted pad are the ones that count.
  t.env.setGamepads([
    fakePad({ mapping: '', index: 0, axes: [0, 0, -1, 0] }),
    fakePad({ mapping: 'standard', index: 1, axes: [0, 0, 1, 0], pressed: [9] }),
  ]);
  assert.ok(t.input.poll().pressed.has('pause'));
  t.input.destroy();
});

test('gamepad: look sensitivity bends the stick curve without moving the rate ceiling', () => {
  for (const s of [0.2, 1, 3]) {
    const t = setup({ sensitivity: s });
    t.env.setGamepads([fakePad({ axes: [0, 0, 1, 0] })]);
    assert.equal(t.input.poll().turn, 1, `full deflection is full rate at sensitivity ${s}`);
    t.env.setGamepads([fakePad({ axes: [0, 0, -1, 0] })]);
    assert.equal(t.input.poll().turn, -1, `and symmetric at sensitivity ${s}`);
    t.input.destroy();
  }

  // The slider still does something: the middle of the travel is quicker at 3 than at 0.2.
  /** @param {number} s @returns {number} */
  const midRate = (s) => {
    const t = setup({ sensitivity: s });
    t.env.setGamepads([fakePad({ axes: [0, 0, 0.7, 0] })]);
    const turn = t.input.poll().turn;
    t.input.destroy();
    return turn;
  };
  const slow = midRate(0.2);
  const mid = midRate(1);
  const fast = midRate(3);
  assert.ok(slow < mid && mid < fast, `expected a monotone slider, got ${slow} < ${mid} < ${fast}`);
  assert.ok(fast < 1, 'and no part of the travel saturates early');
});

test('gamepad: getGamepads is not called every frame while nothing is plugged in', () => {
  const t = setup();
  let calls = 0;
  t.env.navigator.getGamepads = () => {
    calls++;
    return [];
  };
  for (let i = 0; i < 120; i++) t.input.poll();
  assert.ok(calls <= 8, `expected a throttled probe, got ${calls} calls in 120 polls`);
  assert.ok(calls >= 1, 'but it must still find a pad that appears without an event');

  // A connect event promotes the poll to sampling every frame immediately.
  t.env.navigator.getGamepads = () => {
    calls++;
    return [fakePad({ axes: [0, -1, 0, 0] })];
  };
  const before = calls;
  t.env.window.dispatchEvent({ type: 'gamepadconnected' });
  for (let i = 0; i < 10; i++) t.input.poll();
  assert.equal(calls - before, 10, 'a connected pad is sampled on every poll');
  assert.equal(t.input.poll().moveY, 1);
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
  assert.equal(pollPastProbe(t).moveX, 0);
  t.env.navigator.getGamepads = () => null;
  assert.equal(pollPastProbe(t).moveX, 0);
  t.env.navigator.getGamepads = () => [
    { connected: true, mapping: 'standard', axes: [NaN, NaN, NaN], buttons: [null, 1, {}] },
  ];
  const f = pollPastProbe(t);
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
  assert.equal(f.sprint, false, 'full speed is not sprinting');

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

test('touch: sprint is an outward flick, not "the thumb left the ring"', () => {
  const t = setup();

  // A slow, ordinary drag across the glass — the stick's origin slides with it and the magnitude
  // pins to 1, but the player did not ask to sprint and must not burn fuel 1.5x for walking.
  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: 100, y: 500 }]));
  for (let y = 480; y >= 260; y -= 20) {
    t.env.advance(120); // 20 px per 120 ms: nothing like a shove
    t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 1, x: 100, y }]));
    const f = t.input.poll();
    assert.equal(f.sprint, false, `dragging must not sprint (y=${y})`);
  }
  assert.equal(t.input.poll().moveY, 1, 'but it is still full-speed walking');
  t.env.canvas.dispatchEvent(touchEvent('touchend', [{ id: 1, x: 100, y: 260 }]));
  t.input.poll();

  // A deliberate flick: past 1.4 ring radii from where the thumb landed, inside the window.
  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 2, x: 100, y: 500 }]));
  t.env.advance(80);
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 2, x: 100, y: 400 }]));
  let f = t.input.poll();
  assert.equal(f.sprint, true, '100 px in 80 ms is a shove');
  assert.equal(f.moveY, 1);

  // It stays latched while the thumb stays out there…
  t.env.advance(400);
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 2, x: 100, y: 380 }]));
  assert.equal(t.input.poll().sprint, true);

  // …and drops the moment the thumb eases back off the rim.
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 2, x: 100, y: 450 }]));
  f = t.input.poll();
  assert.equal(f.sprint, false, 'easing back off the rim is how you stop sprinting');
  assert.ok(Math.abs(f.moveY) < 1, 'and the stick is no longer pinned');

  // The same travel taken slowly never latches.
  t.env.canvas.dispatchEvent(touchEvent('touchend', [{ id: 2, x: 100, y: 470 }]));
  t.env.canvas.dispatchEvent(touchEvent('touchstart', [{ id: 3, x: 100, y: 500 }]));
  t.env.advance(900);
  t.env.canvas.dispatchEvent(touchEvent('touchmove', [{ id: 3, x: 100, y: 380 }]));
  assert.equal(t.input.poll().sprint, false, 'slow travel is walking, however far it goes');
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
