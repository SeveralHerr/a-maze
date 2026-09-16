/**
 * Jamcraft studio logo intro — integrator territory, a web port of the Jamcraft Godot splash.
 *
 * The markup (`#splash` in index.html) is static, so the first paint is already the black splash
 * card rather than a flash of the title underneath. This module only animates it and gets it out of
 * the way. It is loaded as its own module script, independent of `main.js`: a boot failure must
 * never leave the player staring at a black card over the fatal panel.
 *
 * Timeline: black → logo pops in (scale + fade) with an additive flash → hold (slow push-in) →
 * logo fades to black → the black card fades away revealing the title → the node is removed.
 * Any key, click, touch or gamepad button skips straight to the fade-out.
 *
 * `#splash` itself is `pointer-events: none` like every layer above `#overlay`. Input meant to skip
 * the splash is swallowed by window capture listeners instead, so the press that skips it never
 * also reaches the title menu — and once the reveal starts they are gone.
 *
 * `?headless=1` and `?splash=0` remove it immediately (tools must not wait on a logo).
 */

const START_DELAY_MS = 100;
const INTRO_MS = 450;
const HOLD_MS = 700;
const FADE_OUT_MS = 300;
const REVEAL_MS = 350;
const FLASH_STRENGTH = 0.55;
const POP_SCALE = 1.12;
const HOLD_SCALE = 1.025;

const EASE_OUT_QUAD = 'cubic-bezier(0.5, 1, 0.89, 1)';
const EASE_IN_QUAD = 'cubic-bezier(0.11, 0, 0.5, 0)';
const EASE_OUT_BACK = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const EASE_OUT_EXPO = 'cubic-bezier(0.16, 1, 0.3, 1)';
const EASE_OUT_SINE = 'cubic-bezier(0.61, 1, 0.88, 1)';
const EASE_IN_OUT_SINE = 'cubic-bezier(0.37, 0, 0.63, 1)';

/** Events that skip the splash, and whose release/follow-up must be swallowed with them. */
const SKIP_EVENTS = ['keydown', 'pointerdown', 'mousedown', 'touchstart'];
const SWALLOW_EVENTS = [...SKIP_EVENTS, 'keyup', 'pointerup', 'mouseup', 'touchend', 'click', 'contextmenu'];

function runSplash() {
  const doc = globalThis.document;
  const root = doc && doc.getElementById('splash');
  if (!root) return;

  const params = new URLSearchParams(globalThis.location ? globalThis.location.search : '');
  const flag = (name) => params.get(name) !== null && params.get(name) !== '0';
  const logo = /** @type {HTMLElement|null} */ (root.querySelector('.splash-logo'));
  const flash = /** @type {HTMLElement|null} */ (root.querySelector('.splash-flash'));
  if (flag('headless') || params.get('splash') === '0' || !logo || !flash || typeof root.animate !== 'function') {
    root.remove();
    return;
  }

  const reduced = !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
  /** @type {Animation[]} */
  let running = [];
  let leaving = false;
  let done = false;
  let padRaf = 0;

  const track = (/** @type {Animation} */ a) => (running.push(a), a);
  const cancelRunning = () => {
    for (const a of running) {
      try {
        a.commitStyles(); // freeze the current frame so the outro starts from where the intro was
      } catch {
        // commitStyles throws on a detached/hidden element; the outro still runs from its keyframes
      }
      a.cancel();
    }
    running = [];
  };

  const swallow = (/** @type {Event} */ ev) => {
    if (done) return;
    ev.stopImmediatePropagation();
    if (ev.cancelable && ev.type !== 'keyup') ev.preventDefault();
    if (SKIP_EVENTS.includes(ev.type) && !(/** @type {KeyboardEvent} */ (ev).repeat)) outro();
  };
  const unlisten = () => {
    for (const type of SWALLOW_EVENTS) globalThis.removeEventListener(type, swallow, true);
    if (padRaf) globalThis.cancelAnimationFrame(padRaf);
    padRaf = 0;
  };
  for (const type of SWALLOW_EVENTS) globalThis.addEventListener(type, swallow, { capture: true, passive: false });

  // Gamepads fire no events for buttons; poll them only while the splash is up.
  const nav = /** @type {any} */ (globalThis.navigator);
  if (nav && typeof nav.getGamepads === 'function') {
    const poll = () => {
      padRaf = 0;
      if (done) return;
      for (const pad of nav.getGamepads() || []) {
        if (pad && pad.buttons.some((b) => b.pressed)) outro();
      }
      if (!done) padRaf = globalThis.requestAnimationFrame(poll);
    };
    padRaf = globalThis.requestAnimationFrame(poll);
  }

  function intro() {
    const d = START_DELAY_MS;
    if (reduced) {
      track(logo.animate([{ opacity: 0 }, { opacity: 1 }], { duration: INTRO_MS, delay: d, fill: 'forwards' }));
    } else {
      const fadeIn = INTRO_MS * 0.4;
      const flashRise = fadeIn * 0.35;
      track(logo.animate([{ opacity: 0 }, { opacity: 1 }],
        { duration: fadeIn, delay: d, easing: EASE_OUT_QUAD, fill: 'forwards' }));
      // Pop, then a slow push-in across the hold so the frame never feels frozen.
      track(logo.animate([{ transform: `scale(${POP_SCALE})` }, { transform: 'scale(1)' }],
        { duration: INTRO_MS, delay: d, easing: EASE_OUT_BACK, fill: 'backwards' }));
      track(logo.animate([{ transform: 'scale(1)' }, { transform: `scale(${HOLD_SCALE})` }],
        { duration: HOLD_MS + FADE_OUT_MS, delay: d + INTRO_MS, easing: EASE_OUT_SINE, fill: 'forwards' }));
      // The flash peaks the moment the logo is fully opaque, then decays fast.
      track(flash.animate([{ opacity: 0 }, { opacity: FLASH_STRENGTH }],
        { duration: flashRise, delay: d + fadeIn - flashRise, easing: EASE_IN_QUAD, fill: 'forwards' }));
      track(flash.animate([{ opacity: FLASH_STRENGTH }, { opacity: 0 }],
        { duration: Math.max(INTRO_MS * 0.7, 100), delay: d + fadeIn, easing: EASE_OUT_EXPO, fill: 'forwards' }));
    }
    setTimeout(outro, d + INTRO_MS + HOLD_MS);
  }

  function outro() {
    if (leaving) return;
    leaving = true;
    cancelRunning();
    const opacity = getComputedStyle(logo).opacity;
    const transform = getComputedStyle(logo).transform;
    const base = transform && transform !== 'none' ? transform : 'scale(1)';
    track(logo.animate([{ opacity }, { opacity: 0 }], { duration: FADE_OUT_MS, easing: EASE_IN_QUAD, fill: 'forwards' }));
    if (!reduced) {
      track(logo.animate([{ transform: base }, { transform: `${base} scale(1.04)` }],
        { duration: FADE_OUT_MS, easing: EASE_IN_QUAD, fill: 'forwards' }));
    }
    track(flash.animate([{ opacity: getComputedStyle(flash).opacity }, { opacity: 0 }],
      { duration: FADE_OUT_MS * 0.5, fill: 'forwards' }));
    setTimeout(finish, FADE_OUT_MS);
  }

  function finish() {
    if (done) return;
    done = true;
    unlisten();
    const reveal = root.animate([{ opacity: 1 }, { opacity: 0 }],
      { duration: REVEAL_MS, easing: EASE_IN_OUT_SINE, fill: 'forwards' });
    reveal.finished.then(() => root.remove(), () => root.remove());
  }

  intro();
}

try {
  runSplash();
} catch {
  // A broken logo intro must never cost the game: drop it and let the title show.
  const el = globalThis.document && globalThis.document.getElementById('splash');
  if (el) el.remove();
}
