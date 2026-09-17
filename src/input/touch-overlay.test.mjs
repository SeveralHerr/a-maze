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

test('the MAP button never moves when the map mode changes (a second tap must land)', () => {
  const m = mount();
  const bar = m.layer.childNodes[2];
  const mapBtn = m.layer.findByText('MAP');
  const snapshot = () => [bar.style.cssText, bar.style.transform, bar.style.top, bar.style.marginTop, bar.style.padding, mapBtn.style.transform, mapBtn.style.margin].join('|');

  m.overlay.update({ phase: 'playing', settings: { mapMode: 'corner' } });
  const before = snapshot();
  // The player presses MAP; main.js opens the full map; the next frame's update() runs while the
  // thumb is still on the glass.
  mapBtn.dispatchEvent({ type: 'touchstart', cancelable: true });
  assert.deepEqual(m.fired, ['map']);
  const held = mapBtn.style.transform; // the press visual, not a layout move
  m.overlay.update({ phase: 'playing', settings: { mapMode: 'full' } });
  assert.equal(bar.style.transform, undefined, 'the bar is not shifted');
  assert.equal(mapBtn.style.transform, held);
  mapBtn.dispatchEvent({ type: 'touchend' });
  assert.equal(snapshot(), before, 'geometry identical with the full map open');
  assert.equal(bar.attributes['data-map'], 'full', 'the styling hook still reports the mode');

  // Tap the same spot again: it fires, and closing the map moves nothing either.
  mapBtn.dispatchEvent({ type: 'touchstart', cancelable: true });
  mapBtn.dispatchEvent({ type: 'touchend' });
  assert.deepEqual(m.fired, ['map', 'map']);
  for (const mapMode of ['off', 'corner', 'full', /** @type {any} */ (7)]) {
    m.overlay.update({ phase: 'playing', settings: { mapMode } });
    assert.equal(snapshot(), before, String(mapMode));
  }
  m.overlay.update({ phase: 'playing' });
  assert.equal(snapshot(), before);
  assert.equal(bar.attributes['data-map'], 'default');
  m.overlay.destroy();
});

test('a locked map dims the MAP button and flags the bar, without moving anything', () => {
  const m = mount();
  const bar = m.layer.childNodes[2];
  // The fake DOM has no removeAttribute; give the bar the real browser behaviour.
  bar.removeAttribute = (/** @type {string} */ k) => {
    delete bar.attributes[k];
  };
  const mapBtn = m.layer.findByText('MAP');
  const pauseBtn = m.layer.findByText('PAUSE');
  const geometry = () => [bar.style.cssText, bar.style.transform, mapBtn.style.cssText, mapBtn.style.transform, mapBtn.style.margin].join('|');

  m.overlay.update({ phase: 'playing', settings: { mapMode: 'corner' }, run: { mapFound: true } });
  const before = geometry();
  assert.equal(bar.attributes['data-map-locked'], undefined);
  assert.ok(!mapBtn.style.opacity, 'lit while the map is found');

  m.overlay.update({ phase: 'playing', settings: { mapMode: 'corner' }, run: { mapFound: false } });
  assert.equal(bar.attributes['data-map-locked'], '1');
  assert.ok(Number(mapBtn.style.opacity) > 0 && Number(mapBtn.style.opacity) < 1, 'dimmed, not hidden');
  assert.ok(!pauseBtn.style.opacity, 'PAUSE is untouched');
  assert.equal(geometry(), before, 'locking moves nothing');

  // The button still fires while locked: main.js answers it with a notice.
  mapBtn.dispatchEvent({ type: 'touchstart', cancelable: true });
  mapBtn.dispatchEvent({ type: 'touchend' });
  assert.deepEqual(m.fired, ['map']);

  // Writes only on a change.
  mapBtn.style.opacity = 'SENTINEL';
  m.overlay.update({ phase: 'playing', settings: { mapMode: 'corner' }, run: { mapFound: false } });
  assert.equal(mapBtn.style.opacity, 'SENTINEL');
  mapBtn.style.opacity = '0.4';

  m.overlay.update({ phase: 'playing', settings: { mapMode: 'corner' }, run: { mapFound: true } });
  assert.equal(bar.attributes['data-map-locked'], undefined, 'the flag is removed on unlock');
  assert.ok(!mapBtn.style.opacity);
  assert.equal(geometry(), before);

  // An older state without the field (or no run at all) is treated as found.
  m.overlay.update({ phase: 'playing', run: { mapFound: false } });
  m.overlay.update({ phase: 'playing', run: {} });
  assert.equal(bar.attributes['data-map-locked'], undefined);
  m.overlay.update({ phase: 'playing', run: { mapFound: false } });
  m.overlay.update({ phase: 'playing' });
  assert.equal(bar.attributes['data-map-locked'], undefined);
  m.overlay.destroy();
});

test('the bar rests below the full map header line in every mode', () => {
  const m = mount();
  const bar = m.layer.childNodes[2];
  const pad = /padding:calc\(env\(safe-area-inset-top,0px\) \+ (\d+)px\)/.exec(bar.style.cssText);
  assert.ok(pad, bar.style.cssText);
  assert.ok(Number(pad[1]) >= 64, `drop is built into the resting position, got ${pad && pad[1]}`);
  m.overlay.destroy();
});

test('the CHALK button appears only with the unlock, dims at zero charges, and never moves MAP', () => {
  const m = mount();
  const bar = m.layer.childNodes[2];
  const chalk = bar.childNodes[1];
  assert.equal(chalk.textContent, 'CHALK');
  m.overlay.update({ phase: 'playing', run: { mapFound: true, chalk: 0 }, perks: { chalk: 0 } });
  assert.equal(chalk.style.display, 'none', 'hidden without the unlock');
  m.overlay.update({ phase: 'playing', run: { mapFound: true, chalk: 4 }, perks: { chalk: 4 } });
  assert.equal(chalk.style.display, '');
  assert.ok(!chalk.style.opacity, 'lit while there are charges');
  m.overlay.update({ phase: 'playing', run: { mapFound: true, chalk: 0 }, perks: { chalk: 4 } });
  assert.equal(chalk.style.opacity, '0.4', 'dimmed once the charges are spent');
  chalk.style.opacity = 'SENTINEL';
  m.overlay.update({ phase: 'playing', run: { mapFound: true, chalk: 0 }, perks: { chalk: 4 } });
  assert.equal(chalk.style.opacity, 'SENTINEL', 'written only on a change');
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

test('the AUTO button fires the auto action, is lit while Auto Explore is on, and never moves MAP (§4.10)', () => {
  const m = mount();
  const bar = m.layer.childNodes[2];
  const auto = bar.childNodes[0];
  assert.equal(auto.textContent, 'AUTO', 'leftmost, so it never shifts MAP or PAUSE');
  const mapBtn = m.layer.findByText('MAP');
  const mapCss = mapBtn.style.cssText;

  auto.dispatchEvent({ type: 'touchstart', cancelable: true });
  auto.dispatchEvent({ type: 'touchend' });
  assert.deepEqual(m.fired, ['auto']);

  m.overlay.update({ phase: 'playing', settings: { autoExplore: false } });
  assert.equal(auto.style.opacity, '0.7', 'dim while off');
  assert.ok(!auto.style.outline);
  m.overlay.update({ phase: 'playing', settings: { autoExplore: true } });
  assert.equal(auto.style.opacity, '', 'full while on');
  assert.match(auto.style.outline, /2px solid/);
  assert.equal(auto.attributes['aria-pressed'], 'true');
  // A press while lit inverts and restores the button without wiping the lit outline.
  auto.dispatchEvent({ type: 'touchstart', cancelable: true });
  auto.dispatchEvent({ type: 'touchend' });
  assert.match(auto.style.outline, /2px solid/);
  m.overlay.update({ phase: 'playing', settings: { autoExplore: false } });
  assert.ok(!auto.style.outline, 'unlit again when switched off');
  assert.equal(mapBtn.style.cssText, mapCss, 'MAP untouched throughout');
  m.overlay.destroy();
});
