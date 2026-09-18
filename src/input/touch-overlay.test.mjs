// @ts-check
/**
 * @file Unit tests for `src/input/touch-overlay.js` in isolation.
 * Run: `node src/input/touch-overlay.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTouchOverlay, DECK, SYS_ROW_MAX_W } from './touch-overlay.js';
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
  // Ring, knob, the stick's resting mark, then the thumb deck: a system row (CHALK / MAP / PAUSE)
  // above the mode's primary button (ATTACK or AUTO). Named here so a test reads the structure
  // rather than an index (§4.12).
  const home = layer.childNodes[2];
  const deck = layer.childNodes[3];
  const bar = deck.childNodes[0];
  const primary = deck.childNodes[1];
  return { env, overlay, fired, layer, home, deck, bar, primary };
}

test('mounts one layer with the stick and both buttons', () => {
  const m = mount();
  assert.equal(m.env.touchRoot.childNodes.length, 1);
  assert.ok(m.layer.findByText('PAUSE'));
  assert.ok(m.layer.findByText('MAP'));
  // Ring + knob + the stick's resting mark + the thumb deck.
  assert.equal(m.layer.childNodes.length, 4);
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
  assert.match(pause.style.cssText, new RegExp('min-width:' + DECK.SYS_MIN_W + 'px'));
  assert.match(pause.style.cssText, new RegExp('min-height:' + DECK.SYS_MIN_H + 'px'));
  assert.ok(DECK.SYS_MIN_W >= 44 && DECK.SYS_MIN_H >= 44, 'a system button is at least a 44px target');
  // The primary button is several times that, because it is the one pressed constantly (§4.12).
  const attack = m.layer.findByText('ATTACK');
  assert.match(attack.style.cssText, new RegExp('min-width:' + DECK.PRIMARY_W + 'px'));
  assert.ok(
    DECK.PRIMARY_W * DECK.PRIMARY_H >= 3 * DECK.SYS_MIN_W * DECK.SYS_MIN_H,
    'the primary button dwarfs a system button',
  );
  // Safe-area insets are respected on notched phones — the BOTTOM and right ones now, because the
  // deck is anchored to the bottom right and the home indicator is the hardware in its way.
  assert.match(m.deck.style.cssText, /env\(safe-area-inset-bottom,\s*0px\)/);
  assert.match(m.deck.style.cssText, /env\(safe-area-inset-right,\s*0px\)/);
  assert.doesNotMatch(m.deck.style.cssText, /safe-area-inset-top/, 'nothing in the deck is top-anchored');
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
  // Back to the system skin's stone body — near-opaque, so the button has an actual body over the
  // black control deck rather than reading as a wireframe outline (§4.12).
  assert.equal(pause.style.background, 'rgba(19,24,34,0.92)');
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

test('the ATTACK button is ringed while the swing runs, and a release cannot wipe it (§4.12)', () => {
  const m = mount();
  const attack = m.layer.findByText('ATTACK');
  const playing = (/** @type {number} */ st) => ({
    phase: 'playing',
    mode: 'combat',
    run: { mapFound: true },
    attack: { st, t: 0, hits: 0 },
  });

  m.overlay.update(playing(0));
  assert.ok(!attack.style.outline, 'idle: no ring');
  m.overlay.update(playing(2));
  assert.match(attack.style.outline, /solid #d9a441/, 'lit while the blade is moving');

  // The press inversion owns background/colour/box-shadow; the lit ring is an `outline` precisely
  // so a thumb lifting mid-swing does not black it out.
  attack.dispatchEvent({ type: 'touchstart', cancelable: true });
  attack.dispatchEvent({ type: 'touchend' });
  assert.match(attack.style.outline, /solid #d9a441/, 'still lit after the release repaint');

  m.overlay.update(playing(0));
  assert.equal(attack.style.outline, '');

  // Classic Descent has no sword, so nothing lights however the state is shaped.
  m.overlay.update({ phase: 'playing', mode: 'classic', run: { mapFound: true }, attack: { st: 2 } });
  assert.equal(attack.style.outline, '');
  m.overlay.destroy();
});

test("the stick's resting mark shows the empty half of the deck is walkable (§4.12)", () => {
  // Once the buttons moved to the bottom right, the bottom left became a few hundred pixels of
  // black with nothing saying a drag there walks. The mark is that hint — and it is the stick's
  // *absence*, so exactly one ring is ever on screen.
  const m = mount();
  assert.match(m.home.style.cssText, /left:/, 'parked on the left, where the stick zone is');
  assert.match(m.home.style.cssText, /bottom:/);
  assert.match(m.home.style.cssText, /pointer-events:none/, 'a hint, not a target');
  // The fake DOM does not parse `cssText` into properties, so the birth state is read off the
  // declaration and the toggles off the properties the module writes.
  assert.match(m.home.style.cssText, /opacity:1/, 'visible before anything is touched');

  m.overlay.setStick(true, 60, 700, 60, 700);
  assert.equal(m.home.style.opacity, '0', 'the live stick replaces it');
  m.overlay.setStick(false, 0, 0, 0, 0);
  assert.equal(m.home.style.opacity, '1');
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
  const bar = m.bar;
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
  const bar = m.bar;
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

test('the deck is anchored to the bottom right, never the top (§4.12)', () => {
  const m = mount();
  // The whole point of the rewrite: the top of the screen is instruments — the fuel gauge, the
  // health bar, the score plaque, and in New Descent the corner map — and the bottom is controls.
  // A button anchored to the top is both on top of a panel and out of a thumb's reach.
  assert.match(m.deck.style.cssText, /bottom:0/);
  assert.match(m.deck.style.cssText, /right:0/);
  assert.doesNotMatch(m.deck.style.cssText, /top:0/);
  // Rows stack upward and are right-aligned, which is what makes CHALK appear on the LEFT and
  // leave MAP and PAUSE exactly where a thumb already found them.
  assert.match(m.deck.style.cssText, /flex-direction:column/);
  assert.match(m.deck.style.cssText, /align-items:flex-end/);
  assert.equal(m.deck.childNodes.length, 2, 'the system row, then the primary button');
  assert.equal(m.bar.childNodes[m.bar.childNodes.length - 1].textContent, 'PAUSE', 'PAUSE is rightmost');
  m.overlay.destroy();
});

test('the system row clears the virtual stick zone on a phone, both orientations (§4.12)', () => {
  // `input.js` gives the left STICK_ZONE_FRACTION of the viewport to the virtual stick at ANY
  // height, so a bottom row reaching into it is a row a walking thumb can press by accident.
  // Right-aligned, the row's left edge is `width - inset - rowWidth`. This is asserted rather than
  // eyeballed because the failure is a player pausing the game when they meant to walk — which
  // happens on a real phone, to a real thumb, and never once in a screenshot.
  const STICK_ZONE_FRACTION = 0.4; // mirrors src/input/input.js
  for (const [label, width] of /** @type {[string, number][]} */ ([
    ['the narrowest promised width', DECK.MIN_SAFE_WIDTH],
    ['portrait 375px (iPhone SE)', 375],
    ['portrait 390px (iPhone 14)', 390],
    ['portrait 412px (Pixel)', 412],
    ['landscape 844px', 844],
  ])) {
    const rowLeft = width - DECK.INSET - SYS_ROW_MAX_W;
    assert.ok(
      rowLeft >= width * STICK_ZONE_FRACTION,
      `${label}: row starts at ${rowLeft}px, stick zone ends at ${width * STICK_ZONE_FRACTION}px`,
    );
  }
  // The floor is a promise about real devices, not an arbitrary number: assert it covers the
  // narrowest phones anyone still plays on, so shrinking it later trips this rather than a player.
  assert.ok(DECK.MIN_SAFE_WIDTH <= 360, 'the promise must cover a 360px Android');
});

test('the CHALK button appears only with the unlock, dims at zero charges, and never moves MAP', () => {
  const m = mount();
  const bar = m.bar;
  // Leftmost in the right-aligned system row, so appearing mid-run grows the row leftwards and
  // leaves MAP and PAUSE exactly where they were (§4.12).
  const chalk = bar.childNodes[0];
  assert.equal(chalk.textContent, 'CHALK');
  m.overlay.update({ phase: 'playing', run: { mapFound: true, chalk: 0 }, perks: { chalk: 0 } });
  assert.equal(chalk.style.display, 'none', 'hidden without the unlock');
  m.overlay.update({ phase: 'playing', run: { mapFound: true, chalk: 4 }, perks: { chalk: 4 } });
  assert.equal(chalk.style.display, 'flex', 'shown, and still centring its label');
  assert.ok(!chalk.style.opacity, 'lit while there are charges');
  m.overlay.update({ phase: 'playing', run: { mapFound: true, chalk: 0 }, perks: { chalk: 4 } });
  assert.equal(chalk.style.opacity, '0.4', 'dimmed once the charges are spent');
  chalk.style.opacity = 'SENTINEL';
  m.overlay.update({ phase: 'playing', run: { mapFound: true, chalk: 0 }, perks: { chalk: 4 } });
  assert.equal(chalk.style.opacity, 'SENTINEL', 'written only on a change');
  m.overlay.destroy();
});

test('showing a button restores its flex centring, not a bare display (§4.12)', () => {
  // Every button centres its label with `display:flex`. Showing one by clearing the inline
  // property falls back to a div's `block`, which drops the label to the top of the box — which is
  // exactly what shipped: CHALK, ATTACK and AUTO all had their labels riding the top border while
  // MAP and PAUSE, which are never toggled, looked correct.
  const m = mount();
  const chalk = m.bar.childNodes[0];
  const attack = m.layer.findByText('ATTACK');
  const auto = m.layer.findByText('AUTO');
  assert.match(chalk.style.cssText, /display:flex/, 'centred at birth');

  m.overlay.update({ phase: 'playing', run: { mapFound: true, chalk: 2 }, perks: { chalk: 2 }, mode: 'combat' });
  assert.equal(chalk.style.display, 'flex');
  assert.equal(attack.style.display, 'flex');
  assert.equal(auto.style.display, 'none');

  m.overlay.update({ phase: 'playing', run: { mapFound: true, chalk: 2 }, perks: { chalk: 2 }, mode: 'classic' });
  assert.equal(auto.style.display, 'flex');
  assert.equal(attack.style.display, 'none');
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
  // AUTO is Classic Descent's primary button and lives in the big bottom-right slot, not in the
  // system row: it and ATTACK are never both on screen, so they share the one target a thumb rests
  // on (§4.12). Either way it cannot shift MAP or PAUSE — it is not in their row at all.
  const auto = m.primary.childNodes[0];
  assert.equal(auto.textContent, 'AUTO');
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
