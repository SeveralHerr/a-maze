// @ts-check
/**
 * @file How the preview harness reaches each `?screen=` value — extracted from `preview.js` so it
 * can be proven in Node.
 *
 * The sub-screens are internal to `menus.js` (there is no `openScreen(id)` in the contract, §4.6),
 * so a harness has to reach them the way a player does: move the selection and confirm. That walk
 * is fragile by nature — it depends on the row order, on which rows the state makes visible, and on
 * the menus' own memory of where the cursor was — and when it broke, `?screen=options` and
 * `?screen=credits` quietly showed a different screen (they landed on the loading screen, because
 * row 0 is *Descend*). Nothing failed; the screenshots were simply of the wrong thing.
 *
 * Keeping it here means `preview-nav.test.mjs` can assert, in Node and with the real menus, that
 * every documented value lands on the screen it names.
 *
 * This file is **not shipped**: `index.html` loads `src/main.js`, which never imports it.
 */

/** @typedef {import('../core/types.js').InputAction} InputAction */

/**
 * The menus surface this walk needs — the shipped one, narrowed to what it uses.
 * @typedef {{render:(state:any) => void, handleInput:(frame:any, state:any) => boolean, screen:() => string}} WalkMenus
 */

/**
 * Every `?screen=` value the harness documents, and the screen id `menus.screen()` reports there.
 * `'hud'` and `'font'` are not menus at all, so the menus report `'none'`.
 * @type {Readonly<Record<string, string>>}
 */
export const PREVIEW_SCREENS = Object.freeze({
  hud: 'none',
  title: 'title',
  pause: 'pause',
  options: 'options',
  controls: 'controls',
  credits: 'credits',
  shrine: 'shrine',
  boon: 'boon',
  confirm: 'confirm',
  complete: 'complete',
  gameover: 'gameover',
  loading: 'loading',
  font: 'none',
});

/** The phase each screen lives in. */
const PHASE_FOR = Object.freeze({
  hud: 'playing',
  font: 'playing',
  title: 'title',
  options: 'title',
  controls: 'title',
  credits: 'title',
  shrine: 'title',
  pause: 'paused',
  confirm: 'paused',
  loading: 'loading',
  complete: 'levelComplete',
  boon: 'levelComplete',
  gameover: 'gameOver',
});

/** Rows a walk will try before giving up (the title's longest list is six). */
const MAX_WALK_ROWS = 8;

/**
 * Put the menus on a screen, the way a player would reach it.
 *
 * The caller owns the state's *contents* (scores, a waiting boon); this sets the phase and drives
 * the navigation only.
 *
 * @param {WalkMenus} menus
 * @param {any} state mutated: `phase` is set to the one that screen lives in
 * @param {string} name a key of {@link PREVIEW_SCREENS}
 * @param {(action:InputAction) => any} frameWith one reusable input frame with that action pressed
 * @returns {string} the screen actually reached (`menus.screen()`), for a harness to check
 */
export function reachScreen(menus, state, name, frameWith) {
  const phase = /** @type {any} */ (PHASE_FOR)[name];
  state.phase = phase === undefined ? 'playing' : phase;
  state.phaseTime = 0;
  menus.render(state);
  const want = /** @type {any} */ (PREVIEW_SCREENS)[name];
  if (want === undefined || menus.screen() === want) return menus.screen();

  if (name === 'confirm') {
    // Pause → Abandon Run (the last row) → "Abandon the descent?".
    menus.handleInput(frameWith('up'), state);
    menus.handleInput(frameWith('confirm'), state);
    menus.render(state);
    return menus.screen();
  }
  if (name === 'boon') {
    // The tally first (a confirm skips it), then the "Choose a Boon" row — which is row 0 while an
    // offer is open, so the walk below finds it without stepping onto Descend.
    menus.handleInput(frameWith('confirm'), state);
    menus.render(state);
  }
  return walkTo(menus, state, want, frameWith, name === 'boon' ? 0 : 1);
}

/**
 * Walk a list from `first`, confirming each row in turn until one opens `want`.
 *
 * Rows are found by **what they open**, never by a remembered position: the step counts a harness
 * hard-codes go stale the moment a row is added (the Shrine joining the title list is what broke the
 * last set). A row that opens the wrong screen is backed out of and the cursor walked home.
 *
 * @param {WalkMenus} menus
 * @param {any} state
 * @param {string} want the screen id to reach
 * @param {(action:InputAction) => any} frameWith
 * @param {number} first first row to try (1 on the title: row 0 starts a run)
 * @returns {string} the screen reached
 */
function walkTo(menus, state, want, frameWith, first) {
  const home = menus.screen();
  for (let row = first; row < MAX_WALK_ROWS; row++) {
    for (let i = 0; i < row; i++) menus.handleInput(frameWith('down'), state);
    menus.handleInput(frameWith('confirm'), state);
    menus.render(state);
    if (menus.screen() === want) return menus.screen();
    // Wrong row: back out and walk the cursor home again.
    if (menus.screen() !== home) {
      menus.handleInput(frameWith('back'), state);
      menus.render(state);
    }
    for (let i = 0; i < row; i++) menus.handleInput(frameWith('up'), state);
    menus.render(state);
  }
  return menus.screen();
}
