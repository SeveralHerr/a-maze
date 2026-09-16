// @ts-check
/**
 * @file Fullscreen for the itch.io embed.
 *
 * Contract (ARCHITECTURE.md §4.3): `createFullscreen({root?, env?}) → { request(), exit(), active,
 * supported, onChange(fn), destroy() }` plus the pure `shouldAutoFullscreen(...)`.
 *
 * Why this is its own module rather than three lines in main.js:
 *
 * - **Browsers refuse `requestFullscreen` outside a user gesture**, and refuse it *by rejecting a
 *   promise* — an unhandled rejection that `installGlobalErrorCapture` would record as a game error
 *   on every keyboard-started run that lands a frame too late. `request()` swallows it.
 * - **Safari still ships only the prefixed API** on some versions (`webkitRequestFullscreen`,
 *   `webkitFullscreenElement`, `webkitfullscreenchange`), so every read goes through one fallback.
 * - **Chrome fires both `fullscreenchange` and `webkitfullscreenchange`** for one transition, so
 *   `onChange` is de-duplicated on the `active` value; main.js pauses on "left fullscreen", and a
 *   double notification would be a double pause dispatch.
 * - The decision of *whether* to ask is a pure function, so its truth table is tested without a DOM.
 */

import { createLogger } from '../core/log.js';

/**
 * Should the game ask for fullscreen on the gesture that starts or resumes a run?
 *
 * `?fullscreen=1` / `?fullscreen=0` override everything (a tool or a player who wants the other
 * answer). Otherwise only inside an embed: a top-level tab already owns the whole window, while the
 * itch.io iframe is a small letterbox. Headless tool runs never get it by default — `verify.mjs`
 * screenshots a fixed viewport and a fullscreen transition would resize it mid-run.
 *
 * @param {{param?: string|null, headless?: boolean, embedded?: boolean, setting?: boolean}} o
 * @returns {boolean}
 */
export function shouldAutoFullscreen(o) {
  const param = o ? o.param : null;
  if (param === '1') return true;
  if (param === '0') return false;
  return !!o && o.headless !== true && o.embedded === true && o.setting === true;
}

/**
 * @typedef {Object} Fullscreen
 * @property {() => boolean} request  ask for fullscreen; returns whether a request was actually
 *   issued (false when unsupported, already active or destroyed). Never throws.
 * @property {() => void} exit        leave fullscreen if this document is in it. Never throws.
 * @property {boolean} active         a fullscreen element is currently shown (read live)
 * @property {boolean} supported      the API exists and the document allows it (an iframe without
 *   `allowfullscreen` reports false) — read live
 * @property {(fn: (active: boolean) => void) => () => void} onChange  subscribe to transitions
 *   (de-duplicated on `active`); returns an unsubscribe function
 * @property {() => void} destroy     remove the document listeners and drop every subscriber
 */

/**
 * @param {{root?: any, env?: {document?: any}}} [opts]
 *   `root` is the element made fullscreen (default `document.documentElement`, so the whole page —
 *   every layer and the touch overlay — goes with it). `env.document` injects a fake for Node tests.
 * @returns {Fullscreen}
 */
export function createFullscreen(opts) {
  const o = opts || {};
  const env = o.env || {};
  const log = createLogger('fullscreen');
  /** @type {any} */
  const doc = env.document || (typeof document !== 'undefined' ? document : null);
  /** @type {any} */
  const root = o.root || (doc ? doc.documentElement : null) || null;

  /** @type {Array<(active: boolean) => void>} */
  const subscribers = [];
  let destroyed = false;

  /** @returns {boolean} */
  function isActive() {
    if (!doc) return false;
    const el = doc.fullscreenElement !== undefined ? doc.fullscreenElement : doc.webkitFullscreenElement;
    return el !== null && el !== undefined;
  }

  /** @returns {boolean} */
  function isSupported() {
    if (!doc || !root) return false;
    if (typeof root.requestFullscreen !== 'function' && typeof root.webkitRequestFullscreen !== 'function') {
      return false;
    }
    // `fullscreenEnabled` is false inside an iframe that was not given `allowfullscreen`; asking
    // there only produces a rejection. Undefined (older engines) means "unknown", so try anyway.
    const enabled = doc.fullscreenEnabled !== undefined ? doc.fullscreenEnabled : doc.webkitFullscreenEnabled;
    return enabled !== false;
  }

  let lastActive = isActive();
  const onDocChange = () => {
    const now = isActive();
    if (now === lastActive) return; // Chrome sends the prefixed and unprefixed event for one change
    lastActive = now;
    for (const fn of subscribers.slice()) {
      try {
        fn(now);
      } catch (err) {
        log.error('fullscreen subscriber threw', err);
      }
    }
  };
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('fullscreenchange', onDocChange);
    doc.addEventListener('webkitfullscreenchange', onDocChange);
  }

  /**
   * Swallow a returned promise's rejection (a refusal is an expected outcome, not an error).
   * @param {any} p
   * @param {string} what
   */
  function quiet(p, what) {
    if (p && typeof p.then === 'function') {
      p.then(undefined, (/** @type {unknown} */ err) => log.debug(`${what} refused`, err));
    }
  }

  function request() {
    if (destroyed || isActive() || !isSupported()) return false;
    try {
      if (typeof root.requestFullscreen === 'function') {
        // `navigationUI: 'hide'` keeps mobile Chrome's toolbar from covering the HUD's top row.
        quiet(root.requestFullscreen({ navigationUI: 'hide' }), 'requestFullscreen');
      } else {
        quiet(root.webkitRequestFullscreen(), 'webkitRequestFullscreen');
      }
      return true;
    } catch (err) {
      // Older engines throw synchronously instead of rejecting.
      log.debug('requestFullscreen threw', err);
      return false;
    }
  }

  function exit() {
    if (!doc || !isActive()) return;
    try {
      if (typeof doc.exitFullscreen === 'function') quiet(doc.exitFullscreen(), 'exitFullscreen');
      else if (typeof doc.webkitExitFullscreen === 'function') quiet(doc.webkitExitFullscreen(), 'webkitExitFullscreen');
    } catch (err) {
      log.debug('exitFullscreen threw', err);
    }
  }

  return {
    request,
    exit,
    get active() {
      return isActive();
    },
    get supported() {
      return isSupported();
    },
    onChange(fn) {
      if (destroyed || typeof fn !== 'function') return () => {};
      subscribers.push(fn);
      return () => {
        const i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      subscribers.length = 0;
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('fullscreenchange', onDocChange);
        doc.removeEventListener('webkitfullscreenchange', onDocChange);
      }
    },
  };
}
