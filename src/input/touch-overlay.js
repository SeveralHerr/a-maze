// @ts-check
/**
 * @file On-screen touch controls: the virtual stick's visuals plus the pause / map buttons.
 *
 * Styling is CSS-in-JS (inline `cssText`) on purpose. `styles.css` is integrator territory, and a
 * control layer that ships its own look cannot be broken by an unrelated stylesheet edit; it also
 * means the overlay leaves no trace in the document when `destroy()` runs. The look matches the
 * art direction (`docs/art-reference.png`): chunky 2 px gold `#d9a441` borders on translucent
 * near-black, hard square corners, no gradients on the buttons, monospaced all-caps lettering with
 * a 1-pixel black drop shadow — i.e. the same gold-on-stone palette as the in-game lettering.
 *
 * Responsibilities kept *out* of here: no touch tracking (that is `input.js`, which owns the
 * gesture state for all devices), no game state (the overlay only reads `state.phase`), no
 * per-frame work (`update()` early-returns unless the phase changed, and the stick is only
 * repainted when `input.js` reports a new thumb position).
 *
 * @see ARCHITECTURE.md §4.3
 */

/** @typedef {import('../core/types.js').InputAction} InputAction */

/**
 * The handle returned by {@link createTouchOverlay}.
 * @typedef {Object} TouchOverlay
 * @property {(state: {phase?: string, settings?: {mapMode?: string}}|null|undefined) => void} update
 *   Bind visibility to the game phase. Controls show only while `phase === 'playing'` (a pause or
 *   title menu draws its own buttons). The map mode only sets the bar's `data-map` styling hook;
 *   it never moves a button. Safe to call every frame: it costs two compares.
 * @property {(active: boolean, originX: number, originY: number, knobX: number, knobY: number, sprint?: boolean) => void} setStick
 *   Move/show/hide the virtual stick. Coordinates are **CSS pixels in viewport space** (i.e. raw
 *   `Touch.clientX/clientY`), matching what `input.js` already tracks. `sprint` lights the knob up
 *   while the flick-to-sprint latch is on, so a touch player can see they are burning fuel faster.
 * @property {() => void} destroy   Remove every node and listener this overlay created.
 * @property {HTMLElement|null} element  The overlay's root node (null if the DOM was unusable).
 */

/** Gold used for borders, lettering and the stick ring — the reference art's torch-lit gold. */
const GOLD = '#d9a441';
/** Dark ink behind the controls; translucent so the dungeon stays visible underneath. */
const INK = 'rgba(9,12,20,0.62)';
/** Radius of the stick ring in CSS px. Must match `STICK_RADIUS_PX` in `input.js`. */
const RING_RADIUS = 60;
/** Radius of the thumb knob in CSS px. */
const KNOB_RADIUS = 26;
/**
 * Window in ms after a touch during which a synthetic `click` is ignored. Mobile browsers emit a
 * compatibility `click` ~300 ms after `touchend`; without this guard every tap fires twice.
 */
const CLICK_SUPPRESS_MS = 700;

/**
 * Extra drop of the button bar below where the page stylesheet puts it, in CSS px — applied
 * **always**, never as a function of game state.
 *
 * `styles.css` pushes the bar clear of the HUD's top-right panel, but the full-screen map draws its
 * own header (`DEPTH n · 128×128` on the left, `MAPPED %` on the right) at that same vertical inset
 * on a phone, so PAUSE landed on top of the percentage. The previous fix slid the bar down only
 * while the full map was open — which moved MAP out from under the thumb that had just pressed it,
 * so tapping the same spot again to close the map missed. A control must never move because it
 * was used: the bar now sits at the lowered position in every mode, one button height plus the gap
 * below the header line, so MAP opens and closes the map from exactly the same spot.
 */
const BAR_DROP_PX = 64;

/** Knob look while the flick-to-sprint latch is on: brighter rim and a hot glow (fuel burns 1.5×). */
const KNOB_SPRINT_BORDER = '#ffd37a';
const KNOB_SPRINT_BG = 'rgba(255,176,64,0.55)';
const KNOB_SPRINT_SHADOW = 'inset 0 0 0 2px rgba(0,0,0,0.5),0 0 18px 4px rgba(255,160,40,0.6)';
const KNOB_IDLE_BORDER = GOLD;
const KNOB_IDLE_BG = 'rgba(217,164,65,0.30)';
const KNOB_IDLE_SHADOW = 'inset 0 0 0 2px rgba(0,0,0,0.5),0 0 10px rgba(217,164,65,0.25)';

/**
 * Create the on-screen touch controls inside `root`.
 *
 * Fails soft: if `root` cannot host elements (no document, detached fake, exotic embedding) the
 * returned handle is inert rather than throwing — losing the touch buttons must never take the
 * game down, because keyboard and gamepad still work.
 *
 * @param {HTMLElement|null|undefined} root  container to append into; `#touch` in `index.html`
 * @param {Object} [opts]
 * @param {(action: InputAction) => void} [opts.onAction]  called on press with `'pause'`/`'map'`
 * @param {Document} [opts.document]  injectable document (Node tests pass a fake)
 * @returns {TouchOverlay}
 */
export function createTouchOverlay(root, opts) {
  const options = opts || {};
  const onAction = typeof options.onAction === 'function' ? options.onAction : null;
  /** @type {any} */
  const doc =
    options.document ||
    (root && /** @type {any} */ (root).ownerDocument) ||
    (typeof document !== 'undefined' ? document : null);

  // ── Inert fallback ────────────────────────────────────────────────────────────────────────
  if (!doc || typeof doc.createElement !== 'function' || !root || typeof root.appendChild !== 'function') {
    return {
      update() {},
      setStick() {},
      destroy() {},
      element: null,
    };
  }

  /** Listener bookkeeping so `destroy()` is exact: every entry is removed, none is missed. */
  /** @type {{t:any, type:string, fn:Function, opt:any}[]} */
  const bound = [];
  /**
   * @param {any} target
   * @param {string} type
   * @param {Function} fn
   * @param {any} [opt]
   */
  function listen(target, type, fn, opt) {
    target.addEventListener(type, fn, opt);
    bound.push({ t: target, type, fn, opt });
  }

  /**
   * @param {string} tag
   * @param {string} css
   * @returns {any}
   */
  function el(tag, css) {
    const node = doc.createElement(tag);
    node.style.cssText = css;
    return node;
  }

  // ── Root ──────────────────────────────────────────────────────────────────────────────────
  // `position:absolute; inset:0` fills `#touch` (itself `position:absolute; inset:0`). The root is
  // `pointer-events:none` so drags fall straight through to the canvas that owns look/stick
  // gestures; only the buttons opt back in.
  const layer = el(
    'div',
    'position:absolute;inset:0;pointer-events:none;z-index:5;' +
      "font-family:ui-monospace,'Courier New',monospace;" +
      '-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;' +
      'touch-action:none;'
  );
  layer.setAttribute('aria-hidden', 'true');

  // ── Virtual stick ─────────────────────────────────────────────────────────────────────────
  // Both parts are positioned at the viewport origin and moved with `translate3d`, with their own
  // size negated by a margin so the transform addresses their centre. Transforms (not left/top)
  // keep the move on the compositor and off the layout path.
  const ring = el(
    'div',
    `position:absolute;left:0;top:0;width:${RING_RADIUS * 2}px;height:${RING_RADIUS * 2}px;` +
      `margin:${-RING_RADIUS}px 0 0 ${-RING_RADIUS}px;border:2px solid rgba(217,164,65,0.45);` +
      'border-radius:50%;background:radial-gradient(circle,rgba(217,164,65,0.10) 0%,rgba(9,12,20,0.42) 72%);' +
      'box-shadow:inset 0 0 0 2px rgba(0,0,0,0.45);opacity:0;transition:opacity 120ms linear;' +
      'will-change:transform;transform:translate3d(-999px,-999px,0);'
  );
  const knob = el(
    'div',
    `position:absolute;left:0;top:0;width:${KNOB_RADIUS * 2}px;height:${KNOB_RADIUS * 2}px;` +
      `margin:${-KNOB_RADIUS}px 0 0 ${-KNOB_RADIUS}px;border:2px solid ${KNOB_IDLE_BORDER};border-radius:50%;` +
      `background:${KNOB_IDLE_BG};box-shadow:${KNOB_IDLE_SHADOW};` +
      'opacity:0;transition:opacity 120ms linear;will-change:transform;transform:translate3d(-999px,-999px,0);'
  );

  // ── Buttons ───────────────────────────────────────────────────────────────────────────────
  // Top-right, stacked horizontally, inside the safe area (notch/rounded corners). Top-right keeps
  // them clear of the home indicator and of both thumbs' resting positions, so neither the stick
  // (bottom-left) nor a look-drag (right half) can graze them.
  const bar = el(
    'div',
    'position:absolute;top:0;right:0;display:flex;gap:10px;pointer-events:none;' +
      `padding:calc(env(safe-area-inset-top,0px) + ${10 + BAR_DROP_PX}px) calc(env(safe-area-inset-right,0px) + 10px) 0 0;`
  );
  // SEAM (integrator): the HUD's score/gem panel also lives in the top-right corner, so on a
  // portrait phone these buttons landed on top of the score. The class is the only hook the page
  // stylesheet has (everything else here is inline and would win the cascade); `styles.css` uses
  // it to push the bar below the HUD's top row. Nothing in this module depends on the class.
  bar.className = 'amaze-touch-bar';

  const BTN_IDLE =
    `min-width:64px;min-height:44px;padding:12px 12px 10px;box-sizing:border-box;` +
    `border:2px solid ${GOLD};background:${INK};color:${GOLD};` +
    'box-shadow:inset 0 0 0 2px rgba(0,0,0,0.55),0 2px 0 rgba(0,0,0,0.55);' +
    'font:700 12px/1 ui-monospace,"Courier New",monospace;letter-spacing:2px;text-align:center;' +
    'text-shadow:0 2px 0 rgba(0,0,0,0.85);pointer-events:auto;touch-action:none;' +
    '-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;';

  /**
   * Build one chunky pixel-art button that fires `action` the instant it is touched.
   * Firing on press (not release) is what makes a mobile button feel responsive; the matching
   * visual inversion gives the player the confirmation a real key's travel would.
   * @param {string} label
   * @param {InputAction} action
   * @returns {any}
   */
  function makeButton(label, action) {
    const btn = el('div', BTN_IDLE);
    btn.textContent = label;
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', label);

    let held = false;
    const press = () => {
      if (held) return;
      held = true;
      btn.style.background = GOLD;
      btn.style.color = '#10131c';
      btn.style.transform = 'translateY(2px)';
      btn.style.boxShadow = 'inset 0 0 0 2px rgba(0,0,0,0.55)';
      if (onAction) onAction(action);
    };
    const release = () => {
      if (!held) return;
      held = false;
      btn.style.background = INK;
      btn.style.color = GOLD;
      btn.style.transform = '';
      btn.style.boxShadow = 'inset 0 0 0 2px rgba(0,0,0,0.55),0 2px 0 rgba(0,0,0,0.55)';
    };

    listen(
      btn,
      'touchstart',
      (/** @type {any} */ ev) => {
        lastTouchMs = nowMs();
        // Stop the canvas from also reading this touch as a look-drag, and stop the browser from
        // treating it as a scroll/zoom gesture.
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        if (ev && ev.cancelable !== false && typeof ev.preventDefault === 'function') ev.preventDefault();
        press();
      },
      { passive: false }
    );
    const endTouch = (/** @type {any} */ ev) => {
      lastTouchMs = nowMs();
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      release();
    };
    listen(btn, 'touchend', endTouch, { passive: true });
    listen(btn, 'touchcancel', endTouch, { passive: true });
    // Mouse/stylus path (and hybrid laptops): a real click, only when no touch just happened.
    listen(btn, 'click', (/** @type {any} */ ev) => {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      if (nowMs() - lastTouchMs < CLICK_SUPPRESS_MS) return;
      press();
      release();
    });
    return btn;
  }

  /** Monotonic-ish clock used only for the synthetic-click guard. */
  const nowMs =
    typeof doc.defaultView === 'object' && doc.defaultView && doc.defaultView.performance
      ? () => doc.defaultView.performance.now()
      : typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? () => performance.now()
        : () => Date.now();
  let lastTouchMs = -1e9;

  const mapBtn = makeButton('MAP', 'map');
  const pauseBtn = makeButton('PAUSE', 'pause');
  bar.appendChild(mapBtn);
  bar.appendChild(pauseBtn);

  layer.appendChild(ring);
  layer.appendChild(knob);
  layer.appendChild(bar);
  root.appendChild(layer);

  // ── Mutable view state (cached so we only touch the DOM on a real change) ─────────────────
  let visible = true; // visible until the first update() binds us to a phase
  let mapAttr = ''; // last `data-map` written
  let knobSprint = false;
  let stickShown = false;
  let ringX = NaN;
  let ringY = NaN;
  let knobX = NaN;
  let knobY = NaN;
  let destroyed = false;

  /**
   * @param {boolean} on
   */
  function setStickShown(on) {
    if (stickShown === on) return;
    stickShown = on;
    const o = on ? '1' : '0';
    ring.style.opacity = o;
    knob.style.opacity = o;
  }

  return {
    update(state) {
      if (destroyed) return;

      // `data-map` is a styling hook only (`styles.css` may key off it). Position deliberately does
      // NOT depend on the map mode — see BAR_DROP_PX: a button that moves when pressed misses the
      // second tap.
      const settings = state ? /** @type {any} */ (state).settings : null;
      const attr = !!settings && settings.mapMode === 'full' ? 'full' : 'default';
      if (attr !== mapAttr) {
        mapAttr = attr;
        bar.setAttribute('data-map', attr);
      }

      // Anything that is not the playing phase is a menu, and menus own the screen: hiding the
      // buttons there prevents a stray tap from re-pausing an already paused game.
      const show = !state || typeof state.phase !== 'string' ? true : state.phase === 'playing';
      if (show === visible) return;
      visible = show;
      layer.style.display = show ? '' : 'none';
      if (!show) setStickShown(false);
    },

    setStick(active, originX, originY, kx, ky, sprint) {
      if (destroyed) return;
      const hot = active === true && sprint === true && visible;
      if (hot !== knobSprint) {
        // Written only on a change of the latch, so a touchmove adds no style writes.
        knobSprint = hot;
        knob.style.borderColor = hot ? KNOB_SPRINT_BORDER : KNOB_IDLE_BORDER;
        knob.style.background = hot ? KNOB_SPRINT_BG : KNOB_IDLE_BG;
        knob.style.boxShadow = hot ? KNOB_SPRINT_SHADOW : KNOB_IDLE_SHADOW;
      }
      if (!active || !visible) {
        setStickShown(false);
        return;
      }
      setStickShown(true);
      // `!==` on cached numbers: a touchmove that does not move the thumb writes nothing.
      if (originX !== ringX || originY !== ringY) {
        ringX = originX;
        ringY = originY;
        ring.style.transform = 'translate3d(' + originX + 'px,' + originY + 'px,0)';
      }
      if (kx !== knobX || ky !== knobY) {
        knobX = kx;
        knobY = ky;
        knob.style.transform = 'translate3d(' + kx + 'px,' + ky + 'px,0)';
      }
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (let i = 0; i < bound.length; i++) {
        const b = bound[i];
        try {
          b.t.removeEventListener(b.type, b.fn, b.opt);
        } catch {
          // A detached node can throw in exotic embeddings; the node is going away regardless.
        }
      }
      bound.length = 0;
      if (typeof layer.remove === 'function') layer.remove();
      else if (layer.parentNode) layer.parentNode.removeChild(layer);
    },

    element: layer,
  };
}
