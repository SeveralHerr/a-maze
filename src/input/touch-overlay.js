// @ts-check
/**
 * @file On-screen touch controls: the virtual stick's visuals plus the bottom-right thumb deck —
 * the mode's primary button (ATTACK or AUTO) with a system row of CHALK / MAP / PAUSE above it.
 *
 * Styling is CSS-in-JS (inline `cssText`) on purpose. `styles.css` is integrator territory, and a
 * control layer that ships its own look cannot be broken by an unrelated stylesheet edit; it also
 * means the overlay leaves no trace in the document when `destroy()` runs. The look matches the
 * art direction (`docs/art-reference.png`): chunky 2 px gold `#d9a441` borders on translucent
 * near-black, hard square corners, no gradients on the buttons, monospaced all-caps lettering with
 * a 1-pixel black drop shadow — i.e. the same gold-on-stone palette as the in-game lettering.
 *
 * Responsibilities kept *out* of here: no touch tracking (that is `input.js`, which owns the
 * gesture state for all devices), no game state (the overlay only reads `state.phase`, `settings.mapMode`,
 * `run.mapFound`, `run.chalk` and `perks.chalk`), no
 * per-frame work (`update()` early-returns unless the phase changed, and the stick is only
 * repainted when `input.js` reports a new thumb position).
 *
 * @see ARCHITECTURE.md §4.3
 */

/** @typedef {import('../core/types.js').InputAction} InputAction */

/**
 * The handle returned by {@link createTouchOverlay}.
 * @typedef {Object} TouchOverlay
 * @property {(state: {phase?: string, settings?: {mapMode?: string}, run?: {mapFound?: boolean, chalk?: number}, perks?: {chalk?: number}}|null|undefined) => void} update
 *   Bind visibility to the game phase. Controls show only while `phase === 'playing'` (a pause or
 *   title menu draws its own buttons). The map mode only sets the bar's `data-map` styling hook;
 *   it never moves a button. While `run.mapFound === false` the bar carries `data-map-locked="1"`
 *   and the MAP button is dimmed (opacity only). The CHALK button exists only once the Chalk unlock
 *   is owned (`perks.chalk > 0`, ARCHITECTURE.md §4.9) and dims at zero charges. The ATTACK button
 *   is ringed while `state.attack.st !== 0`, so it doubles as the sword's cooldown readout exactly
 *   as the HUD's desktop plaque does (§4.12). Safe to call every frame: a few compares.
 * @property {(active: boolean, originX: number, originY: number, knobX: number, knobY: number) => void} setStick
 *   Move/show/hide the virtual stick. Coordinates are **CSS pixels in viewport space** (i.e. raw
 *   `Touch.clientX/clientY`), matching what `input.js` already tracks.
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
 * The thumb deck's geometry, in CSS pixels (ARCHITECTURE.md §4.12). Exported because
 * `touch-overlay.test.mjs` asserts the system row clears the virtual stick's zone at a given
 * viewport width, and a test that re-types the numbers is asserting against itself.
 *
 * Why the bottom right at all: every button used to live in a bar pinned to the TOP right, pushed
 * down by a `15vh` stylesheet margin and a 64 px inline drop tuned against a HUD that has since
 * grown a health bar, a depth plaque and — in New Descent — a corner map that moved into exactly
 * that corner. On a 390×844 phone the bar sat on top of the corner map the moment the map scroll
 * was found, and ATTACK, the button pressed more than every other control combined, was at the far
 * top right: the one place on a phone a thumb cannot reach without regripping.
 *
 * So: **the top is instruments, the bottom is controls.** Nothing here is anchored to the top, and
 * nothing here moves because of game state.
 */
export const DECK = Object.freeze({
  /** Inset from the safe-area edges. */
  INSET: 12,
  /** The mode's one constantly-pressed button: ATTACK in combat, AUTO in classic. */
  PRIMARY_W: 112,
  PRIMARY_H: 92,
  /**
   * A system button (CHALK / MAP / PAUSE). A **fixed** width, not a minimum: the row's left edge has
   * to clear the virtual stick's zone (see `SYS_ROW_MAX_W`), and a `min-width` lets the widest label
   * decide how far left the row actually reaches — which makes the clearance a property of the word
   * "CHALK" in whatever font the device substituted. 58×44 clears every platform's 44 px floor and
   * holds a five-character label at `SYS_FONT_PX` with room to spare.
   */
  SYS_MIN_W: 58,
  SYS_MIN_H: 44,
  /**
   * Between the system row and the primary button. Wide on purpose: PAUSE sits directly above
   * ATTACK, and a thumb sliding up off the attack button mid-fight must not land on pause. This is
   * the gap that keeps the two rows separate targets rather than one cluster.
   */
  ROW_GAP: 18,
  /** Between system buttons. */
  BTN_GAP: 6,
  /**
   * Narrowest viewport the stick-zone clearance is promised at, in CSS px. 360 is the smallest
   * Android still in meaningful use and comfortably under the iPhone SE's 375; below it the row
   * grazes the zone, which is a bottom-right button near a bottom-left thumb — worth knowing, not
   * worth shrinking the labels for.
   */
  MIN_SAFE_WIDTH: 360,
});

/**
 * Widest the system row ever gets: CHALK + MAP + PAUSE. Right-aligned, so this is also exactly how
 * far left it reaches — the number the stick-zone check in the tests is about.
 */
export const SYS_ROW_MAX_W = DECK.SYS_MIN_W * 3 + DECK.BTN_GAP * 2;

/** MAP button opacity while the level's map scroll has not been found (§4.8). Dim, not gone. */
const MAP_LOCKED_OPACITY = '0.4';

/** The thumb knob's look. */
const KNOB_IDLE_BORDER = GOLD;
const KNOB_IDLE_BG = 'rgba(217,164,65,0.30)';
const KNOB_IDLE_SHADOW = 'inset 0 0 0 2px rgba(0,0,0,0.5),0 0 10px rgba(217,164,65,0.25)';

/** CHALK button opacity while this level's chalk charges are spent. */
const CHALK_EMPTY_OPACITY = '0.4';

/**
 * AUTO button opacity while Auto Explore is off. On, it is fully opaque and ringed with a gold
 * outline — written as `outline`, which the press/release styling never touches, so a tap's
 * visual inversion cannot wipe the lit state.
 */
const AUTO_OFF_OPACITY = '0.7';

/**
 * Create the on-screen touch controls inside `root`.
 *
 * Fails soft: if `root` cannot host elements (no document, detached fake, exotic embedding) the
 * returned handle is inert rather than throwing — losing the touch buttons must never take the
 * game down, because keyboard and gamepad still work.
 *
 * @param {HTMLElement|null|undefined} root  container to append into; `#touch` in `index.html`
 * @param {Object} [opts]
 * @param {(action: InputAction) => void} [opts.onAction]  called on press with `'pause'`/`'map'`/`'chalk'`
 * @param {(action: InputAction, held: boolean) => void} [opts.onHold]  called on press AND release,
 *   so a consumer can treat a button as held rather than tapped (the sword, §4.11)
 * @param {Document} [opts.document]  injectable document (Node tests pass a fake)
 * @returns {TouchOverlay}
 */
export function createTouchOverlay(root, opts) {
  const options = opts || {};
  const onAction = typeof options.onAction === 'function' ? options.onAction : null;
  // New Descent's ATTACK button is a HOLD, not a tap (§4.11): `onHold(action, down)` reports the
  // press and the release, so a thumb kept on it keeps swinging.
  const onHold = typeof options.onHold === 'function' ? options.onHold : null;
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

  // ── The stick's resting mark ──────────────────────────────────────────────────────────────
  // A dim ring parked in the bottom left, shown only while the live stick is NOT up.
  //
  // It exists because of what the deck looks like to someone who has never played: on a portrait
  // phone the world is a 4:3 band with a black control deck under it, and once the buttons moved to
  // the bottom RIGHT (§4.12) the bottom left became several hundred pixels of pure black with no
  // indication that dragging anywhere in it walks. The game never says "drag to move" — it does not
  // need to, as long as the place to drag looks like a place to drag.
  //
  // Not interactive, and deliberately not a control: `input.js` takes a stick touch anywhere in the
  // left `STICK_ZONE_FRACTION` of the screen, at any height, and that stays true. This is a hint at
  // where a thumb is comfortable, not a target it has to hit.
  // Sized to the live stick it stands in for, and parked level with the primary button so the two
  // thumb anchors sit on one line — a hint that is smaller or lower than the thing it promises
  // reads as decoration.
  const HOME_RADIUS = Math.round(RING_RADIUS * 0.82);
  const homeBottom = DECK.INSET + Math.round(DECK.PRIMARY_H / 2) - HOME_RADIUS;
  const home = el(
    'div',
    `position:absolute;left:${DECK.INSET + 14}px;` +
      `bottom:calc(env(safe-area-inset-bottom,0px) + ${homeBottom}px);` +
      `width:${HOME_RADIUS * 2}px;height:${HOME_RADIUS * 2}px;border:2px dashed rgba(217,164,65,0.30);` +
      'border-radius:50%;background:radial-gradient(circle,rgba(217,164,65,0.09) 0%,rgba(9,12,20,0) 72%);' +
      'pointer-events:none;opacity:1;transition:opacity 140ms linear;' +
      'display:flex;align-items:center;justify-content:center;' +
      'font:700 10px/1 ui-monospace,"Courier New",monospace;letter-spacing:2px;' +
      'color:rgba(217,164,65,0.45);text-shadow:0 1px 0 rgba(0,0,0,0.8);'
  );
  // One word, once: the deck is black and silent, and "MOVE" is the difference between a dashed
  // circle that means something and one that looks like a rendering artefact. It fades with the
  // ring the instant a thumb lands, so it is never in the way of the thing it is explaining.
  home.textContent = 'MOVE';

  // ── The thumb deck ────────────────────────────────────────────────────────────────────────
  // Bottom right, inside the safe area, as a column of two right-aligned rows: the system row
  // (CHALK · MAP · PAUSE) above the mode's primary button (ATTACK or AUTO). See DECK for why the
  // bottom right and not the top right.
  //
  // `align-items:flex-end` is what makes the rows right-aligned, and that is a behaviour, not a
  // look: CHALK appears mid-run when the unlock is owned, and appearing on the LEFT of the row
  // means MAP and PAUSE do not shift out from under a thumb that already knows where they are.
  const deck = el(
    'div',
    'position:absolute;right:0;bottom:0;display:flex;flex-direction:column;align-items:flex-end;' +
      `gap:${DECK.ROW_GAP}px;pointer-events:none;` +
      `padding:0 calc(env(safe-area-inset-right,0px) + ${DECK.INSET}px) ` +
      `calc(env(safe-area-inset-bottom,0px) + ${DECK.INSET}px) 0;`
  );
  // SEAM (integrator): the only hook `styles.css` has on this module (everything else here is
  // inline and would win the cascade). Nothing in this module depends on the class.
  deck.className = 'amaze-touch-deck';

  const bar = el('div', `display:flex;gap:${DECK.BTN_GAP}px;pointer-events:none;`);
  const primaryRow = el('div', 'display:flex;pointer-events:none;');

  /**
   * A shown button's `display`. **Not** the empty string: every button centres its label with
   * `display:flex`, and clearing the inline property falls back to a `div`'s `block`, which drops
   * the label to the top of the box. Hiding and re-showing CHALK used to silently un-centre it.
   */
  const SHOWN = 'flex';

  /**
   * One button's look, as the two colours `press`/`release` have to restore. A press inverts to
   * gold and back, so the idle pair cannot be a module constant once the primary button has its own.
   * @param {string} bg @param {string} fg @param {string} border
   */
  const skin = (bg, fg, border) => ({ bg, fg, border });
  // Near-opaque, not `INK`: over the black control deck a 62 %-alpha fill left the system buttons
  // reading as empty wireframe outlines next to a primary button with an actual body. Every other
  // panel in the game is stone you cannot see through; these are too.
  const SYS_SKIN = skin('rgba(19,24,34,0.92)', GOLD, GOLD);
  /**
   * The primary button is not just bigger, it is *hotter*: ember-dark stone under a brighter gold
   * edge. Size alone did not read as primary — against a black deck a gold outline at 112×92 and
   * one at 58×44 are the same button seen from two distances, and the one the thumb lives on
   * should look like the one the thumb lives on.
   */
  const PRIMARY_SKIN = skin('rgba(52,25,13,0.88)', '#f3c76e', '#e8b45a');

  const BTN_BASE =
    'box-sizing:border-box;text-align:center;display:flex;align-items:center;justify-content:center;' +
    'text-shadow:0 2px 0 rgba(0,0,0,0.85);pointer-events:auto;touch-action:none;' +
    '-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;';
  // `width`/`height`, not `min-*`: the row's width has to be arithmetic, not typography (see DECK).
  const BTN_IDLE =
    `width:${DECK.SYS_MIN_W}px;height:${DECK.SYS_MIN_H}px;min-width:${DECK.SYS_MIN_W}px;` +
    `min-height:${DECK.SYS_MIN_H}px;padding:0 6px;flex:0 0 auto;` +
    `border:2px solid ${SYS_SKIN.border};background:${SYS_SKIN.bg};color:${SYS_SKIN.fg};` +
    'box-shadow:inset 0 0 0 2px rgba(0,0,0,0.55),0 2px 0 rgba(0,0,0,0.55);' +
    'font:700 12px/1 ui-monospace,"Courier New",monospace;letter-spacing:0.5px;' +
    BTN_BASE;
  // Roughly four times the area of a system button, because it is pressed four hundred times as
  // often — and because a missed swing in New Descent costs health, where a missed PAUSE costs a
  // second. The 3 px edge and the inner gold hairline are what make it read as the primary action
  // rather than as a large PAUSE.
  const PRIMARY_IDLE =
    `width:${DECK.PRIMARY_W}px;height:${DECK.PRIMARY_H}px;min-width:${DECK.PRIMARY_W}px;` +
    `min-height:${DECK.PRIMARY_H}px;padding:0 8px;flex:0 0 auto;` +
    `border:3px solid ${PRIMARY_SKIN.border};background:${PRIMARY_SKIN.bg};color:${PRIMARY_SKIN.fg};` +
    'box-shadow:inset 0 0 0 2px rgba(0,0,0,0.5),inset 0 0 0 3px rgba(217,164,65,0.22),' +
    '0 3px 0 rgba(0,0,0,0.6);' +
    'font:700 16px/1 ui-monospace,"Courier New",monospace;letter-spacing:2px;' +
    BTN_BASE;

  /**
   * Build one chunky pixel-art button that fires `action` the instant it is touched.
   * Firing on press (not release) is what makes a mobile button feel responsive; the matching
   * visual inversion gives the player the confirmation a real key's travel would.
   * @param {string} label
   * @param {InputAction} action
   * @param {boolean} [primary] use the big bottom-right slot's metrics
   * @returns {any}
   */
  function makeButton(label, action, primary) {
    const big = primary === true;
    const skinOf = big ? PRIMARY_SKIN : SYS_SKIN;
    const btn = el('div', big ? PRIMARY_IDLE : BTN_IDLE);
    btn.textContent = label;
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', label);
    // The idle shadow each button goes back to. Kept beside its skin rather than as a shared
    // literal: the primary button's is deeper, and a release that restored the system one flattened
    // the biggest button on screen the first time it was tapped.
    const idleShadow = big
      ? 'inset 0 0 0 2px rgba(0,0,0,0.5),inset 0 0 0 3px rgba(217,164,65,0.22),0 3px 0 rgba(0,0,0,0.6)'
      : 'inset 0 0 0 2px rgba(0,0,0,0.55),0 2px 0 rgba(0,0,0,0.55)';

    let held = false;
    const press = () => {
      if (held) return;
      held = true;
      btn.style.background = GOLD;
      btn.style.color = '#10131c';
      btn.style.transform = big ? 'translateY(3px)' : 'translateY(2px)';
      btn.style.boxShadow = 'inset 0 0 0 2px rgba(0,0,0,0.55)';
      if (onAction) onAction(action);
      if (onHold) onHold(action, true);
    };
    const release = () => {
      if (!held) return;
      held = false;
      if (onHold) onHold(action, false);
      btn.style.background = skinOf.bg;
      btn.style.color = skinOf.fg;
      btn.style.transform = '';
      btn.style.boxShadow = idleShadow;
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
  // Appended BEFORE MAP so it grows the row leftwards: adding it never moves a button a thumb has
  // already learned. Same rule as the old bar, kept deliberately.
  const chalkBtn = makeButton('CHALK', 'chalk');
  chalkBtn.style.display = 'none';
  bar.appendChild(chalkBtn);
  bar.appendChild(mapBtn);
  bar.appendChild(pauseBtn);

  // ── The primary slot: whichever button this mode presses constantly ────────────────────────
  // Auto Explore (§4.10) in Classic Descent, the sword (§4.11) in New Descent. They are never both
  // on screen, so they share the one big bottom-right target rather than competing for the row.
  const autoBtn = makeButton('AUTO', 'auto', true);
  autoBtn.style.opacity = AUTO_OFF_OPACITY;
  const attackBtn = makeButton('ATTACK', 'attack', true);
  attackBtn.style.display = 'none';
  primaryRow.appendChild(autoBtn);
  primaryRow.appendChild(attackBtn);

  deck.appendChild(bar);
  deck.appendChild(primaryRow);

  layer.appendChild(ring);
  layer.appendChild(knob);
  layer.appendChild(home);
  layer.appendChild(deck);
  root.appendChild(layer);

  // ── Mutable view state (cached so we only touch the DOM on a real change) ─────────────────
  let visible = true; // visible until the first update() binds us to a phase
  let mapAttr = ''; // last `data-map` written
  let mapLocked = false; // last `data-map-locked` state written
  let chalkShown = false; // last CHALK visibility written
  let chalkEmpty = false; // last CHALK dimming written
  let autoLit = false; // last AUTO lit state written
  let combatShown = false; // last ATTACK visibility (and AUTO hiding) written
  let attackLit = false; // last ATTACK swing-lit state written
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
    // The resting mark is the stick's absence, so it fades out exactly as the live stick fades in.
    // Two rings on screen at once would read as two sticks.
    home.style.opacity = on ? '0' : '1';
  }

  return {
    update(state) {
      if (destroyed) return;

      // `data-map` is a styling hook only (`styles.css` may key off it). Position deliberately does
      // NOT depend on the map mode — see DECK: a button that moves when pressed misses the
      // second tap.
      const settings = state ? /** @type {any} */ (state).settings : null;
      const attr = !!settings && settings.mapMode === 'full' ? 'full' : 'default';
      if (attr !== mapAttr) {
        mapAttr = attr;
        bar.setAttribute('data-map', attr);
      }

      // The map is locked until the level's scroll is found (ARCHITECTURE.md §4.8). The button
      // stays exactly where it is and still fires — main.js answers a locked press with a notice —
      // it only dims, so the player can see the instrument exists but is not earned yet. Opacity
      // only: never a position change (see DECK). Only an explicit `false` locks, so an
      // older state without the field keeps the button lit.
      const run = state ? /** @type {any} */ (state).run : null;
      const locked = !!run && run.mapFound === false;
      if (locked !== mapLocked) {
        mapLocked = locked;
        if (locked) bar.setAttribute('data-map-locked', '1');
        else if (typeof bar.removeAttribute === 'function') bar.removeAttribute('data-map-locked');
        mapBtn.style.opacity = locked ? MAP_LOCKED_OPACITY : '';
      }

      // Chalk (§4.9): the button appears once the unlock is owned and dims when the level's
      // charges are spent — it still fires, so main.js can say why nothing was drawn.
      const perks = state ? /** @type {any} */ (state).perks : null;
      const hasChalk = !!perks && perks.chalk > 0;
      if (hasChalk !== chalkShown) {
        chalkShown = hasChalk;
        chalkBtn.style.display = hasChalk ? SHOWN : 'none';
      }
      const empty = hasChalk && !!run && run.chalk === 0;
      if (empty !== chalkEmpty) {
        chalkEmpty = empty;
        chalkBtn.style.opacity = empty ? CHALK_EMPTY_OPACITY : '';
      }

      // New Descent (§4.11): the sword appears and Auto Explore goes away entirely, because the
      // mode has no autopilot. One DOM write on the mode change, never per frame.
      const combat = !!state && /** @type {any} */ (state).mode === 'combat';
      if (combat !== combatShown) {
        combatShown = combat;
        attackBtn.style.display = combat ? SHOWN : 'none';
        autoBtn.style.display = combat ? 'none' : SHOWN;
      }

      // The swing's own readout. The HUD's desktop plaque already lights while the blade is
      // actually moving, which is how a player learns the weapon's rhythm off the button as much as
      // off the sword — and the touch button, the one nearly every player of this mode will
      // actually use, had no such thing. A thumb held on a dead button and a thumb held on a
      // swinging one looked identical.
      //
      // `outline`, not the border or the background: the press inversion owns those, and a swing
      // still running when the thumb lifts must not have its lit state wiped by the release. Same
      // trick, and the same reason, as the AUTO button's lit ring. One write per change.
      const atk = state ? /** @type {any} */ (state).attack : null;
      const swinging = combat && !!atk && atk.st !== 0;
      if (swinging !== attackLit) {
        attackLit = swinging;
        attackBtn.style.outline = swinging ? `2px solid ${GOLD}` : '';
        attackBtn.style.outlineOffset = swinging ? '2px' : '';
      }

      // Auto Explore (§4.10): lit while it drives. Opacity and outline only — never a position change.
      const lit = !!settings && settings.autoExplore === true;
      if (lit !== autoLit) {
        autoLit = lit;
        autoBtn.style.opacity = lit ? '' : AUTO_OFF_OPACITY;
        autoBtn.style.outline = lit ? `2px solid ${GOLD}` : '';
        autoBtn.style.outlineOffset = lit ? '2px' : '';
        autoBtn.setAttribute('aria-pressed', lit ? 'true' : 'false');
      }

      // Anything that is not the playing phase is a menu, and menus own the screen: hiding the
      // buttons there prevents a stray tap from re-pausing an already paused game.
      const show = !state || typeof state.phase !== 'string' ? true : state.phase === 'playing';
      if (show === visible) return;
      visible = show;
      layer.style.display = show ? '' : 'none';
      if (!show) setStickShown(false);
    },

    setStick(active, originX, originY, kx, ky) {
      if (destroyed) return;
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
