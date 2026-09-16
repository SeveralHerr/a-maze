// @ts-check
/**
 * @file Unit tests for `src/input/touch-overlay.js` in isolation.
 * Run: `node src/input/touch-overlay.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTouchOverlay } from './touch-overlay.js';
import { createFakeEnv } from './fake-dom.test-util.mjs';

/** @param {{onAction?: (a:any) => void}} [opts] */
function mount(opts) {
  const env = createFakeEnv();
  /** @type {string[]} */
  const fired = [];
  const overlay = createTouchOverlay(env.touchRoot, {
    document: env.document,
    onAction: (a) => {
      fired.push(a);
      if (opts && opts.onAction) opts.onAction(a);
    },
  });
  const layer = /** @type {any} */ (overlay.element);
  return { env, overlay, fired, layer };
}

test('mounts one layer with the stick and both buttons', () => {
  const m = mount();
  assert.equal(m.env.touchRoot.childNodes.length, 1);
  assert.ok(m.layer.findByText('PAUSE'));
  assert.ok(m.layer.findByText('MAP'));
  // Ring + knob + button bar.
  assert.equal(m.layer.childNodes.length, 3);
  assert.equal(m.layer.attributes['aria-hidden'], 'true');
  m.overlay.destroy();
});

test('style follows the art direction and stays out of the gesture path', () => {
  const m = mount();
  // The layer never eats touches — only the buttons opt back in.
  assert.match(m.layer.style.cssText, /pointer-events:none/);
  const pause = m.layer.findByText('PAUSE');
  assert.match(pause.style.cssText, /pointer-events:auto/);
  // Chunky 2px gold border on translucent dark, square corners (no border-radius).
  assert.match(pause.style.cssText, /border:2px solid #d9a441/);
  assert.match(pause.style.cssText, /color:#d9a441/);
  assert.doesNotMatch(pause.style.cssText, /border-radius/);
  // Comfortable hit target (Apple/Google both say 44px minimum).
  assert.match(pause.style.cssText, /min-width:64px/);
  assert.match(pause.style.cssText, /min-height:44px/);
  // Safe-area insets are respected on notched phones.
  const bar = m.layer.childNodes[2];
  assert.match(bar.style.cssText, /env\(safe-area-inset-top,\s*0px\)/);
  assert.match(bar.style.cssText, /env\(safe-area-inset-right,\s*0px\)/);
  m.overlay.destroy();
});

test('buttons fire on press, invert while held and restore on release', () => {
  const m = mount();
  const pause = m.layer.findByText('PAUSE');
  const idle = pause.style.cssText;

  pause.dispatchEvent({ type: 'touchstart', cancelable: true });
  assert.deepEqual(m.fired, ['pause']);
  assert.equal(pause.style.background, '#d9a441', 'inverted while held');
  assert.equal(pause.style.color, '#10131c');

  // Re-entrant touchstart (multi-finger) must not double-fire.
  pause.dispatchEvent({ type: 'touchstart', cancelable: true });
  assert.deepEqual(m.fired, ['pause']);

  pause.dispatchEvent({ type: 'touchend' });
  assert.equal(pause.style.background, 'rgba(9,12,20,0.62)');
  assert.equal(pause.style.transform, '');
  assert.ok(idle.length > 0);

  m.layer.findByText('MAP').dispatchEvent({ type: 'touchstart', cancelable: true });
  assert.deepEqual(m.fired, ['pause', 'map']);
  m.overlay.destroy();
});

test('a button press never reaches the canvas underneath', () => {
  const m = mount();
  /** @type {any} */
  const ev = { type: 'touchstart', cancelable: true, bubbles: true };
  m.layer.findByText('MAP').dispatchEvent(ev);
  assert.equal(ev.propagationStopped, true, 'the look-drag handler must not see this touch');
  assert.equal(ev.defaultPrevented, true, 'and the browser must not zoom on it');
  m.overlay.destroy();
});

test('the synthetic click that follows a tap is ignored', () => {
  const m = mount();
  const pause = m.layer.findByText('PAUSE');
  pause.dispatchEvent({ type: 'touchstart', cancelable: true });
  pause.dispatchEvent({ type: 'touchend' });
  pause.dispatchEvent({ type: 'click' }); // mobile browsers emit this ~300ms later
  assert.deepEqual(m.fired, ['pause'], 'one tap, one action');
  m.overlay.destroy();
});

test('a genuine mouse click still works (hybrid laptops)', () => {
  const m = mount();
  m.layer.findByText('MAP').dispatchEvent({ type: 'click' });
  assert.deepEqual(m.fired, ['map']);
  m.overlay.destroy();
});

test('setStick shows, moves and hides the virtual stick', () => {
  const m = mount();
  const ring = m.layer.childNodes[0];
  const knob = m.layer.childNodes[1];
  assert.match(ring.style.cssText, /opacity:0/);

  m.overlay.setStick(true, 100, 500, 130, 470);
  assert.equal(ring.style.opacity, '1');
  assert.equal(knob.style.opacity, '1');
  assert.equal(ring.style.transform, 'translate3d(100px,500px,0)');
  assert.equal(knob.style.transform, 'translate3d(130px,470px,0)');

  // Repeating the same position writes nothing new (cheap enough to call per touchmove).
  knob.style.transform = 'SENTINEL';
  m.overlay.setStick(true, 100, 500, 130, 470);
  assert.equal(knob.style.transform, 'SENTINEL');

  m.overlay.setStick(false, 0, 0, 0, 0);
  assert.equal(ring.style.opacity, '0');
  assert.equal(knob.style.opacity, '0');
  m.overlay.destroy();
});

test('update() binds visibility to the phase and hides the stick with it', () => {
  const m = mount();
  const ring = m.layer.childNodes[0];
  m.overlay.setStick(true, 10, 10, 10, 10);
  assert.equal(ring.style.opacity, '1');

  m.overlay.update({ phase: 'paused' });
  assert.equal(m.layer.style.display, 'none');
  assert.equal(ring.style.opacity, '0', 'a menu takes over: drop the stick');
  // While hidden, the stick cannot be shown by a stray touch.
  m.overlay.setStick(true, 10, 10, 10, 10);
  assert.equal(ring.style.opacity, '0');

  m.overlay.update({ phase: 'playing' });
  assert.equal(m.layer.style.display, '');
  for (const phase of ['title', 'loading', 'levelComplete', 'gameOver']) {
    m.overlay.update({ phase });
    assert.equal(m.layer.style.display, 'none', phase);
  }
  // Missing/garbage state keeps the controls visible rather than stranding a touch player.
  m.overlay.update(null);
  assert.equal(m.layer.style.display, '');
  m.overlay.update(undefined);
  assert.equal(m.layer.style.display, '');
  m.overlay.destroy();
});

test('the button bar steps out of the full map’s header', () => {
  const m = mount();
  const bar = m.layer.childNodes[2];
  assert.equal(bar.style.transform, undefined, 'nothing is written before the first update');

  m.overlay.update({ phase: 'playing', settings: { mapMode: 'corner' } });
  assert.equal(bar.style.transform, undefined, 'the common case writes nothing at all');

  m.overlay.update({ phase: 'playing', settings: { mapMode: 'full' } });
  assert.equal(bar.attributes['data-map'], 'full', 'the hook styles.css can key off');
  assert.match(bar.style.transform, /translateY\(\d+px\)/, 'and a shift that works without it');

  m.overlay.update({ phase: 'playing', settings: { mapMode: 'off' } });
  assert.equal(bar.attributes['data-map'], 'default');
  assert.equal(bar.style.transform, '', 'the page stylesheet keeps its say in every other mode');

  // A state without settings (or without a map mode at all) must not move anything.
  m.overlay.update({ phase: 'playing' });
  assert.equal(bar.style.transform, '');
  m.overlay.update({ phase: 'playing', settings: { mapMode: /** @type {any} */ (7) } });
  assert.equal(bar.style.transform, '');
  m.overlay.destroy();
});

test('destroy() unmounts the layer, removes every listener and is idempotent', () => {
  const m = mount();
  assert.ok(m.env.totalListeners() > 0);
  m.overlay.destroy();
  assert.equal(m.env.touchRoot.childNodes.length, 0);
  assert.equal(m.env.totalListeners(), 0);
  m.overlay.destroy();

  // Every method stays callable (and silent) after teardown.
  m.overlay.update({ phase: 'playing' });
  m.overlay.setStick(true, 1, 2, 3, 4);
  assert.deepEqual(m.fired, []);
});

test('an unusable root yields an inert overlay instead of throwing', () => {
  for (const root of [null, undefined, /** @type {any} */ ({})]) {
    const overlay = createTouchOverlay(/** @type {any} */ (root), { document: /** @type {any} */ (null) });
    assert.equal(overlay.element, null);
    overlay.update({ phase: 'playing' });
    overlay.setStick(true, 1, 1, 1, 1);
    overlay.destroy();
  }
});

test('works without an onAction callback', () => {
  const env = createFakeEnv();
  const overlay = createTouchOverlay(env.touchRoot, { document: env.document });
  const layer = /** @type {any} */ (overlay.element);
  layer.findByText('PAUSE').dispatchEvent({ type: 'touchstart', cancelable: true });
  overlay.destroy();
  assert.equal(env.totalListeners(), 0);
});
