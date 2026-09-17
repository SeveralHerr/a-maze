// @ts-check
/**
 * @file Composition root (ARCHITECTURE.md §4.7) — the only file that knows every subsystem.
 *
 * Nothing here implements gameplay. It creates the store, the input funnel, the raycaster, the
 * overlay (HUD + menus), the post-effect stack, the audio engine and the maze client, wires them
 * together in the one direction the contract allows, and drives them from a fixed-timestep loop:
 *
 * ```
 *   input.poll() ──► store.dispatch({type:'tick'}) ──► reducer mutates GameState
 *                                                      └─ emits GameEvent[]
 *   store.subscribe ──► routeEvents ──► audio / particles / flashes / level requests / persistence
 *   render(alpha)  ──► RenderView ──► raycaster ──► hud ──► menus ──► post
 *   menu callbacks ──► store.dispatch(...)          (never a direct state write)
 * ```
 *
 * ## Rules this file obeys
 * - **One reusable `RenderView`.** Allocating one per frame is exactly what §4.5 forbids.
 * - **Events are routed from the store subscriber**, not after the tick dispatch: `state.events` is
 *   cleared at the top of *every* dispatch, so a `phase` event from a UI-driven pause would be
 *   clobbered by the next tick if it were read anywhere else.
 * - **Boot is guarded.** Any throw during construction paints a styled fatal panel instead of
 *   leaving a black page with a message only devtools can see.
 * - **The loading phase always terminates.** Every level request carries a token (a stale worker
 *   answer is dropped), a failure retries once with a fresh seed, and a watchdog rebuilds a level
 *   that has not arrived in `LOAD_TIMEOUT_S`.
 */

import { createLoop } from './core/loop.js';
import { createLogger, errors, installGlobalErrorCapture, isDebug } from './core/log.js';
import { clamp, clamp01, lerp, lerpAngle } from './core/math.js';
import { createRng, randomSeed } from './core/rng.js';

import { createStore } from './state/store.js';
import { createInitialState, reducer } from './state/game.js';
import { AUTO, COMBAT, UNLOCKS, WORLD, levelParams } from './state/balance.js';
import { clearRun, loadPersist, loadRun, savePersist, saveRun } from './state/save.js';
import { snapshotCheckpoint, snapshotMidLevel, summarizeRunSave } from './state/runsave.js';
import { createAutopilot } from './state/autopilot.js';

import { createInput } from './input/input.js';
import { CONTROL_HINTS } from './input/bindings.js';
import { createFullscreen, shouldAutoFullscreen } from './input/fullscreen.js';
import { createMazeClient } from './maze/client.js';

import { createRaycaster } from './renderer/raycaster.js';
import { createTextures } from './renderer/textures.js';
import { createTilesetTextures, tilesetIndexById, tilesetIndexForLevel } from './renderer/tilesets/index.js';
import { SWORD_FRAMES, createCombatTextures } from './renderer/enemies.js';
import { createPost } from './renderer/post.js';
import { PARTICLE, PARTICLE_COLORS } from './renderer/particles.js';

import { createHud } from './ui/hud.js';
import { createMenus } from './ui/menus.js';
import { createAudio } from './ui/audio.js';

/** @typedef {import('./core/types.js').GameState} GameState */
/** @typedef {import('./core/types.js').GameEvent} GameEvent */
/** @typedef {import('./core/types.js').InputFrame} InputFrame */
/** @typedef {import('./core/types.js').InputAction} InputAction */
/** @typedef {import('./core/types.js').LevelData} LevelData */
/** @typedef {import('./core/types.js').RenderView} RenderView */
/** @typedef {import('./core/types.js').Settings} Settings */

const log = createLogger('main');

// ─── Tuning (composition-root feel; gameplay numbers live in state/balance.js) ────────────────

/**
 * Level whose parameters build the maze the attract camera wanders on the title screen.
 *
 * 1, deliberately: the lean 10×10-cell first floor is a labyrinth the attract camera turns corners
 * in constantly, it stays under the maze client's 400-cell worker threshold so the title costs no
 * worker spin-up at boot, and it keeps the title's item/torch load — the things the renderer sorts
 * every frame — at its smallest.
 */
const DEMO_LEVEL = 1;

/** Fixed seed for the title maze, so the title screen is identical every load (and screenshotable). */
const DEMO_SEED = 0xa11a2e;

/** Seconds before a level that has not arrived is requested again. */
const LOAD_TIMEOUT_S = 12;

/**
 * Minimum time the loading screen stays up, in seconds.
 *
 * A 128×128-cell level is built in a worker and comes back in ~25–60 ms, so without this the
 * loading screen would exist for three frames: the iris would start closing, snap back open, and
 * the banner naming the depth and the size of the labyrinth you are about to enter would never be
 * readable. Holding the answer for {@link MIN_LOAD_S} lets the iris complete its wipe and gives the
 * player the one moment in the loop where the game tells them how big this one is. It is a *floor*
 * on the loading phase, never a delay added to a slow build.
 */
const MIN_LOAD_S = 0.8;

/**
 * Milliseconds after a fullscreen request during which losing pointer lock does not pause. Chrome
 * drops the lock 8–25 ms into the transition; a second covers a slow frame without masking a real
 * Esc, which leaves fullscreen and pauses through that change instead.
 */
const FULLSCREEN_LOCK_GRACE_MS = 1000;

/** Iris open/close rates, 1/s (the level-transition wipe of §1). */
const IRIS_OPEN_RATE = 2.4;
const IRIS_CLOSE_RATE = 2.8;

/** World-flash decay rate, 1/s (the in-world pickup pop). */
const FLASH_DECAY = 3.6;

/** Page-flash decay rate, 1/s (the level-complete pop over the whole page). */
const POST_FLASH_DECAY = 1.8;

/**
 * Display-fitting: snap to a whole pixel multiple only when it costs less than this fraction of
 * the available size. 3× on a 720p display is exact and free; 4× on 1080p (or 3× on a landscape
 * phone) would leave a visible black frame for a pixel grid nobody can see at that scale, so those
 * take the fractional fit and fill the screen instead.
 */
const INTEGER_FIT_TOLERANCE = 0.97;

/** Empty collections handed to the renderer while no level is loaded (never reallocated). */
const NO_ITEMS = /** @type {import('./core/types.js').Item[]} */ ([]);
const NO_TORCHES = /** @type {import('./core/types.js').Torch[]} */ ([]);
const NO_MARKS = /** @type {import('./core/types.js').ChalkMark[]} */ ([]);
const NO_ENEMIES = /** @type {any[]} */ ([]);

/** Notices for the unlocks wave (§4.9). Title case, like every other HUD notice. */
const NOTICE_EMBER = 'The Ember Rekindles';
const NOTICE_NO_CHALK = 'Out of Chalk';
const NOTICE_CHALK_REACH = 'No Wall Within Reach';
const NOTICE_CHALK_LOCKED = 'Chalk - Unlock It at the Shrine';
/** Notices for Auto Explore (§4.10). */
const NOTICE_AUTO_ON = 'Auto Explore On';
const NOTICE_AUTO_OFF = 'Auto Explore Off';
/** Shown when Save & Quit cannot reach storage, so the run stays open instead of being lost. */
const NOTICE_SAVE_FAILED = 'Could Not Save - Storage Blocked';

// ─── Query flags ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the page's query string defensively (a sandboxed iframe can make `location` unreadable).
 * @returns {URLSearchParams}
 */
function readParams() {
  try {
    return new URLSearchParams(globalThis.location ? globalThis.location.search : '');
  } catch {
    return new URLSearchParams('');
  }
}

const params = readParams();
/** `?headless=1` exposes `window.__game` for `tools/verify.mjs` (ARCHITECTURE.md §4.7). */
const HEADLESS = params.get('headless') !== null && params.get('headless') !== '0';
/**
 * Whether the tool surface is live at all. §4.7 says `?headless=1` **or** `?debug=1` exposes
 * `window.__game`, so both flags must also arm everything behind it — most importantly the input
 * injection merge in {@link pollFrame}. Gating the surface on one condition and the merge on
 * another is how `inject()` becomes a function that exists, returns no error and does nothing.
 */
const EXPOSE = HEADLESS || isDebug();
/**
 * Running inside an iframe (the itch.io embed). Reading `top` across origins can throw in older
 * engines; a page that cannot even look at its parent is certainly framed.
 */
const EMBEDDED = (() => {
  try {
    return globalThis.self !== globalThis.top;
  } catch {
    return true;
  }
})();
/** `?fullscreen=1` / `?fullscreen=0` force auto-fullscreen on or off (§4.7 Fullscreen). */
const FULLSCREEN_PARAM = params.get('fullscreen');
/** `?seed=N` pins the run seed so a headless run replays exactly. */
const SEED_PARAM = Number(params.get('seed'));
const FORCED_SEED = Number.isFinite(SEED_PARAM) && params.get('seed') !== null ? SEED_PARAM >>> 0 : null;
/** `?tileset=<id>` pins every floor to one tileset (screenshots, art review); -1 = by depth. */
const FORCED_TILESET = tilesetIndexById(params.get('tileset'));

// ─── Fatal error panel ───────────────────────────────────────────────────────────────────────

/**
 * Replace the page with a legible, styled failure report.
 *
 * Styles are inline: this has to render even if `styles.css` is the thing that failed to load, and
 * a blank black page with the real reason hidden in devtools is the single worst way for a game to
 * break in front of a player.
 * @param {unknown} err
 * @returns {void}
 */
function showFatal(err) {
  try {
    log.error('fatal boot error', err);
    const e = /** @type {Error} */ (err);
    const message = e && e.message ? e.message : String(err);
    const stack = e && typeof e.stack === 'string' ? e.stack : '';
    const doc = globalThis.document;
    if (!doc || !doc.body) return;

    const panel = doc.createElement('div');
    panel.setAttribute('role', 'alert');
    panel.style.cssText =
      'position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;' +
      'padding:24px;background:radial-gradient(ellipse at 50% 40%,#151a26 0%,#07090f 70%);' +
      'color:#e8d3a0;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
      'overflow:auto;text-align:left;';

    const card = doc.createElement('div');
    card.style.cssText =
      'max-width:720px;width:100%;border:2px solid #7a4a1a;border-radius:2px;padding:20px 22px;' +
      'background:rgba(9,12,20,0.92);box-shadow:0 0 0 1px #2b3446 inset,0 12px 40px rgba(0,0,0,0.6);';

    const h = doc.createElement('div');
    h.textContent = '☠ THE TORCH WENT OUT';
    h.style.cssText =
      'color:#d9a441;font-size:20px;letter-spacing:2px;margin-bottom:10px;font-weight:700;';

    const p = doc.createElement('div');
    p.textContent = 'A-MAZE could not start. This is a bug, not something you did.';
    p.style.cssText = 'color:#8a9bb0;margin-bottom:14px;';

    const pre = doc.createElement('pre');
    pre.textContent = stack ? `${message}\n\n${stack}` : message;
    pre.style.cssText =
      'margin:0;white-space:pre-wrap;word-break:break-word;color:#c9d4e2;background:#05070c;' +
      'border:1px solid #2b3446;padding:12px;max-height:46vh;overflow:auto;font-size:12px;';

    const hint = doc.createElement('div');
    hint.textContent = 'Reload the page to try again.';
    hint.style.cssText = 'color:#8a9bb0;margin-top:14px;font-size:12px;';

    card.append(h, p, pre, hint);
    panel.appendChild(card);
    doc.body.appendChild(panel);
  } catch {
    // Reporting the failure must never itself throw — there is nothing left to report it with.
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the whole game and start the loop.
 * @returns {void}
 */
function boot() {
  installGlobalErrorCapture();

  // `?fatal=1` throws here on purpose. The failure path is the one path that cannot be exercised by
  // playing the game, and an untested error screen is how a bug becomes a black page.
  if (params.get('fatal') !== null) {
    throw new Error('?fatal=1 — simulated boot failure, used to verify this error screen renders.');
  }

  const doc = document;
  const view = /** @type {HTMLCanvasElement} */ (doc.getElementById('view'));
  const overlay = /** @type {HTMLCanvasElement} */ (doc.getElementById('overlay'));
  const postRoot = doc.getElementById('post');
  const touchRoot = doc.getElementById('touch');
  if (!view || !overlay) throw new Error('index.html is missing #view or #overlay');

  // ── Listener bookkeeping ────────────────────────────────────────────────────────────────────

  /**
   * Every listener this file registers, so {@link shutdown} can take them all off again. The page
   * normally lives until the tab closes, but a module that can be torn down is also a module that
   * can be re-created (bfcache eviction, a future embed that restarts the game in place), and the
   * subsystems all publish `dispose`/`destroy` in their §4 contracts.
   * @type {Array<{target:any, type:string, fn:any, opts:any}>}
   */
  const listeners = [];

  /**
   * `addEventListener` that remembers what it added.
   * @param {any} target
   * @param {string} type
   * @param {any} fn
   * @param {any} [opts]
   * @returns {void}
   */
  function listen(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    listeners.push({ target, type, fn, opts });
  }

  // ── State ───────────────────────────────────────────────────────────────────────────────────
  const persisted = loadPersist();
  const store = createStore(
    // `profiles` is the per-mode block (§4.11); `best`/`progress` are still handed over so a record
    // written before the modes wave migrates into the classic profile.
    createInitialState(persisted.settings, persisted.best, persisted.progress, persisted.profiles),
    reducer,
  );

  // ── Saved run (§4.10) ─────────────────────────────────────────────────────────────────────
  /**
   * What the title's Continue row offers, cached so the menus can ask every frame for free. Kept in
   * step with storage by {@link writeRun} and {@link dropRun}, the only two writers.
   * @type {{level:number, score:number, mid:boolean}|null}
   */
  let savedSummary = summarizeRunSave(loadRun());
  /**
   * The exact maze seed of a continued mid-level save, used by the first build of that level only. A
   * retry (salted) builds a different maze, whose fingerprint then refuses the snapshot, and the
   * level starts fresh with the run's totals — the documented fallback.
   * @type {number|null}
   */
  let resumeMazeSeed = null;

  /**
   * Store a snapshot as the saved run. O(tiles) at the size cap: only on a pause, a level clear or
   * the page going away, never per step.
   * @param {import('./state/runsave.js').RunSave|null} save
   * @returns {boolean} true when it reached storage
   */
  function writeRun(save) {
    if (save === null || !saveRun(save)) return false;
    savedSummary = summarizeRunSave(save);
    return true;
  }

  /** Forget the saved run (the run ended, was abandoned, or a new one replaced it). @returns {void} */
  function dropRun() {
    clearRun();
    savedSummary = null;
  }

  /** Settings snapshot used to detect what actually changed after a `setSetting`. */
  const appliedSettings = { ...store.getState().settings };
  /** Volume restored by the mute toggle. */
  let mutedVolume = appliedSettings.volume > 0 ? appliedSettings.volume : 0.8;

  // ── Renderer, overlay, effects ──────────────────────────────────────────────────────────────
  const keepTextures = createTextures();
  const raycaster = createRaycaster(view, { textures: keepTextures });
  /** Texture sets by tileset index, painted the first time a floor needs one (on the loading screen). */
  /** @type {Array<import('./renderer/textures.js').TextureSet|undefined>} */
  const tilesetCache = [keepTextures];
  let tilesetShown = 0;
  /**
   * Put the floor's tileset on the raycaster when it changes. Called per frame but is one integer
   * compare unless the floor changed; the title's attract camera wears the tileset of floor 1.
   * @param {number} level
   * @returns {void}
   */
  function syncTileset(level) {
    const idx = FORCED_TILESET >= 0 ? FORCED_TILESET : tilesetIndexForLevel(level, WORLD.FLOORS_PER_TILESET);
    if (idx === tilesetShown) return;
    tilesetShown = idx;
    let set = tilesetCache[idx];
    if (set === undefined) {
      set = createTilesetTextures(idx, keepTextures.seed, keepTextures);
      tilesetCache[idx] = set;
    }
    raycaster.setTextures(set);
  }
  if (FORCED_TILESET >= 0) {
    tilesetShown = -1;
    syncTileset(1);
  }
  /**
   * New Descent's creature and sword art (§4.11), painted **lazily** — the first time a combat run
   * needs it, on the loading screen where a ~100 ms paint is invisible — and then kept for the
   * session. A Classic Descent session never calls this at all, which is the whole reason the art
   * is not part of `createTextures`.
   * @type {import('./renderer/enemies.js').CombatTextures|null}
   */
  let combatTextures = null;

  /**
   * Make sure the renderer has the combat art if this run needs it, and does not if it does not.
   * One identity compare per level install, never per frame.
   * @param {string} mode
   * @returns {void}
   */
  function syncCombatArt(mode) {
    if (mode !== 'combat') return;
    if (combatTextures === null) combatTextures = createCombatTextures(keepTextures.seed);
    raycaster.setCombatTextures(combatTextures);
  }

  const post = createPost(postRoot);
  const hud = createHud(overlay);
  const audio = createAudio({ volume: appliedSettings.volume, music: appliedSettings.music });

  const menus = createMenus(overlay, {
    // Menus never invent a seed and never touch state: every row becomes one dispatch.
    // Fullscreen is asked for FIRST in the three rows that put the player back in the maze: the
    // request must land while the gesture's transient activation is still fresh, before a dispatch
    // whose subscribers (level build, pointer-lock release) could take long enough to matter.
    // The title's two rows hand over which mode they start (§4.11); anything else (Try Again)
    // repeats the mode the run that just ended was in.
    onNewGame: (mode) => {
      autoFullscreen();
      audio.unlock(); // we are inside a real user gesture here, which is the only place this works
      hud.reset();
      // A new run replaces the saved one; the menus asked first when there was one to lose (§4.10).
      if (savedSummary !== null && store.getState().phase === 'title') dropRun();
      store.dispatch({
        type: 'newGame',
        seed: FORCED_SEED === null ? randomSeed() : FORCED_SEED,
        mode: mode === 'combat' ? 'combat' : 'classic',
      });
    },
    onContinue: () => {
      autoFullscreen();
      audio.unlock();
      const save = loadRun();
      if (save === null) {
        // Storage lost it since boot (cleared in another tab, quota eviction): the row goes away.
        savedSummary = null;
        return;
      }
      hud.reset();
      resumeMazeSeed = save.mazeSeed;
      store.dispatch({ type: 'continueRun', save });
      if (store.getState().phase !== 'loading') resumeMazeSeed = null;
    },
    savedRun: () => savedSummary,
    onResume: () => {
      autoFullscreen();
      store.dispatch({ type: 'resume' });
    },
    // Abandon (and a game-over's Title): the run is gone, so is its save.
    onQuit: () => {
      if (store.getState().phase !== 'title') dropRun();
      store.dispatch({ type: 'toTitle' });
    },
    // Pause's Auto Explore row (the menus resume right after): the way in for a captured mouse.
    onToggleAuto: () => toggleAuto(),
    onSaveQuit: () => {
      const st = store.getState();
      const saved =
        st.phase === 'paused'
          ? writeRun(snapshotMidLevel(st))
          : st.phase === 'levelComplete'
            ? writeRun(snapshotCheckpoint(st))
            : false;
      // Storage refused (blocked in an embed, quota, private mode): leaving now would silently throw
      // the run away — or leave an older save behind to be continued by mistake. Stay, and say why.
      if (!saved) {
        hud.notice(NOTICE_SAVE_FAILED);
        return;
      }
      store.dispatch({ type: 'toTitle' });
    },
    onNextLevel: () => {
      autoFullscreen();
      store.dispatch({ type: 'nextLevel' });
    },
    onSetting: (key, value) => store.dispatch({ type: 'setSetting', key, value }),
    // The Shrine and the Boon (§4.9). The reducer validates both; the store subscriber persists the
    // result from the `unlock` event, so a purchase survives a closed tab.
    onBuy: (id) => store.dispatch({ type: 'buyUnlock', id }),
    onClaimBoon: (id) => store.dispatch({ type: 'claimBoon', id }),
    unlocks: UNLOCKS,
    onUiSound: (type) => {
      if (type === 'uiMove') audio.playUi('move');
      else if (type === 'uiConfirm') audio.playUi('confirm');
      else audio.playUi('back');
    },
    // The Controls panel lists the real bindings table (§4.3); menus.js only keeps a fallback copy
    // for harnesses that pass nothing.
    controls: CONTROL_HINTS,
  });

  // ── Input ───────────────────────────────────────────────────────────────────────────────────
  const input = createInput(overlay, {
    sensitivity: appliedSettings.sensitivity,
    invertLook: appliedSettings.invertLook,
    // Pointer lock is only ever taken while the player is actually playing, so clicking a menu
    // never swallows the cursor.
    // Nor while Auto Explore drives (§4.10): the cursor stays free for the AUTO button, and a mouse
    // drifting across the page is someone watching, not steering.
    shouldLockPointer: () => {
      const st = store.getState();
      if (st.phase !== 'playing') return false;
      // New Descent always wants the pointer: a locked click is the swing (§4.3, §4.11), and the
      // Auto Explore release below does not apply to a mode that has no autopilot.
      if (/** @type {any} */ (st).mode === 'combat') return true;
      return st.settings.autoExplore !== true;
    },
    touchRoot: /** @type {HTMLElement|null} */ (touchRoot),
  });

  // ── Fullscreen (itch.io embed, §4.7) ────────────────────────────────────────────────────────
  // The whole document goes fullscreen, not `#view`: every layer (HUD, menus, touch stick) has to
  // come with it, and `layout()` already fits the world band to whatever the window becomes.
  const fullscreen = createFullscreen();

  /**
   * Ask for fullscreen if this page should have it. Only ever called from inside a user gesture —
   * browsers refuse the request anywhere else, and `request()` swallows that refusal.
   * @returns {void}
   */
  function autoFullscreen() {
    if (fullscreen.active) return;
    const wanted = shouldAutoFullscreen({
      param: FULLSCREEN_PARAM,
      headless: HEADLESS,
      embedded: EMBEDDED,
      setting: store.getState().settings.fullscreen,
    });
    if (wanted && fullscreen.request()) fullscreenRequestMs = performance.now();
  }

  /**
   * When the last fullscreen request went out. Entering fullscreen drops a pointer lock taken by the
   * same gesture (measured in Chrome inside an iframe: the lock lands, then is lost 8–25 ms later as
   * the transition completes), and treating that loss as "the player pressed Esc" bounced every
   * resume straight back into the pause menu. See {@link FULLSCREEN_LOCK_GRACE_MS}.
   */
  let fullscreenRequestMs = -1e9;

  /**
   * Go fullscreen on the player's FIRST gesture of any kind — a key or click on the splash or the
   * title — rather than waiting for Descend. It cannot happen earlier: without a gesture the browser
   * refuses. Once fullscreen has been entered this stops; after an Esc the player stays windowed
   * until they start, resume or click back into play (the gestures below and in the menus).
   * The splash swallows its input in window capture listeners, so it forwards it as `splash:gesture`.
   * @param {Event} ev
   * @returns {void}
   */
  const onFirstGesture = (ev) => {
    const e = /** @type {any} */ (ev.type === 'splash:gesture' ? /** @type {CustomEvent} */ (ev).detail : ev);
    if (!e) return;
    // Activation lands on keydown (never Esc), on pointerdown for a mouse, on pointerup for touch/pen.
    const mouse = e.pointerType === 'mouse' || !e.pointerType;
    const grants =
      (e.type === 'keydown' && e.key !== 'Escape') ||
      (e.type === 'pointerdown' && mouse) ||
      (e.type === 'pointerup' && !mouse) ||
      e.type === 'touchend';
    if (grants) autoFullscreen();
  };
  const firstGestureTypes = ['splash:gesture', 'keydown', 'pointerdown', 'pointerup'];
  for (const type of firstGestureTypes) listen(globalThis, type, onFirstGesture, true);
  const stopFirstGesture = fullscreen.onChange((active) => {
    if (!active) return;
    for (const type of firstGestureTypes) globalThis.removeEventListener(type, onFirstGesture, true);
    stopFirstGesture();
  });

  // ── Maze generation ─────────────────────────────────────────────────────────────────────────
  const mazeClient = createMazeClient();

  // ─── Level requests ───────────────────────────────────────────────────────────────────────

  /** Incremented per request; an answer whose token is stale is dropped (§4.7). */
  let buildToken = 0;
  /** Seconds the current `loading` phase has been waiting. */
  let loadWait = 0;
  /** Retries used for the level currently loading. */
  let loadRetries = 0;
  /**
   * A built level waiting for {@link MIN_LOAD_S} to elapse before it is installed.
   * Holding the *data* rather than delaying the *request* means the build still starts immediately
   * and a slow build is never made slower.
   * @type {LevelData|null}
   */
  let pendingLevel = null;
  /** The build token `pendingLevel` belongs to, so a superseded answer is still dropped. */
  let pendingToken = -1;

  /**
   * Per-level seed. Derived from the run seed through a named fork so levels differ within a run
   * and a replayed run seed reproduces every level exactly.
   * @param {number} runSeed
   * @param {number} level
   * @returns {number}
   */
  function seedForLevel(runSeed, level) {
    return createRng(runSeed).fork(`level${level}`).u32();
  }

  /**
   * Ask the maze client for the level the state is waiting on.
   * @param {number} [salt] added to the seed by a retry, so a second attempt is a different maze
   * @returns {void}
   */
  function requestLevel(salt) {
    const st = store.getState();
    const level = st.level;
    const token = ++buildToken;
    loadWait = 0;
    pendingLevel = null;
    pendingToken = -1;
    const seed =
      salt === undefined && resumeMazeSeed !== null ? resumeMazeSeed : (seedForLevel(st.seed, level) + (salt || 0)) >>> 0;
    resumeMazeSeed = null;
    mazeClient.build(levelParams(level), seed).then(
      (data) => {
        if (token !== buildToken) return; // a newer request superseded this one
        if (store.getState().phase !== 'loading') return; // the player left the loading screen
        // Queue it for `step()` rather than installing it here. Two reasons: the loading screen
        // gets its MIN_LOAD_S, and `levelReady` is O(items) + a 66 kB allocation at the size cap,
        // which belongs on a sim step rather than in a promise callback landing mid-render.
        pendingLevel = data;
        pendingToken = token;
      },
      (err) => {
        if (token !== buildToken) return;
        log.error('level build failed', err);
        // `client.build` never rejects for infrastructure reasons, so this is a genuine failure.
        // Two retries with a different maze cost a few milliseconds and rescue the run (§4.7 —
        // the count below, the contract and this sentence must keep saying the same number).
        if (loadRetries < 2) {
          loadRetries++;
          requestLevel(0x9e3779b9 * loadRetries);
        } else {
          showFatal(err);
        }
      },
    );
  }

  /**
   * Build the maze the title-screen attract camera wanders. Dispatched while the phase is still
   * `title`, which installs it as the demo level without starting a run (§4.2).
   * @returns {void}
   */
  function requestDemoLevel() {
    mazeClient.build(levelParams(DEMO_LEVEL), DEMO_SEED).then(
      (data) => {
        if (store.getState().phase !== 'title') return;
        store.dispatch({ type: 'levelReady', data });
      },
      (err) => log.error('demo level build failed', err),
    );
  }

  // ─── Effect state driven by events ────────────────────────────────────────────────────────

  /** Additive tint applied inside the 3-D framebuffer (pickups). */
  const worldFlash = { r: 255, g: 236, b: 190, a: 0 };
  /** Tint applied over the whole page including the overlay (level complete / game over). */
  const postFlash = { r: 255, g: 246, b: 224, a: 0 };
  /** 1 = fully open. Starts closed so the first level irises in. */
  let iris = 0;
  /** RNG for particle bursts; seeded so a replayed run produces the same sparkles. */
  const fxRng = createRng(0x5a4c17);

  /**
   * Route one dispatch's events to everything that reacts to them.
   *
   * Called from the store subscriber (see the file header): `state.events` always holds exactly the
   * events of the action just dispatched, so every event is delivered exactly once.
   *
   * The HUD is deliberately *not* driven from here: it derives its score/fuel pops from
   * `GameState` deltas, because it renders per frame while events are per dispatch. Popping here
   * as well would show every pickup twice.
   *
   * @param {GameState} state
   * @param {{type:string}} action
   * @returns {void}
   */
  function routeEvents(state, action) {
    const events = state.events;
    if (events.length > 0) audio.handle(events, state);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      switch (ev.type) {
        case 'pickup': {
          if (ev.kind === 'map') {
            // The map scroll (§4.8): a pale parchment puff and a soft warm-white flash. The HUD
            // shows its own "MAP FOUND" banner from the `run.mapFound` delta, not from here.
            raycaster.particles.burst(
              PARTICLE.SPARK,
              ev.x,
              ev.y,
              0.36,
              22,
              1.6,
              0.8,
              PARTICLE_COLORS.dust,
              fxRng.next,
            );
            worldFlash.r = 255;
            worldFlash.g = 240;
            worldFlash.b = 200;
            worldFlash.a = Math.min(0.5, worldFlash.a + 0.34);
            break;
          }
          const gem = ev.kind === 'gem';
          // Sparkle burst at the item, and a short warm tint inside the world (not over the HUD —
          // the two flash paths must not be used for the same event, or the pop doubles).
          raycaster.particles.burst(
            PARTICLE.SPARK,
            ev.x,
            ev.y,
            0.42,
            gem ? 26 : 18,
            gem ? 2.4 : 1.8,
            0.7,
            gem ? PARTICLE_COLORS.spark : PARTICLE_COLORS.ember,
            fxRng.next,
          );
          worldFlash.r = gem ? 190 : 255;
          worldFlash.g = gem ? 236 : 214;
          worldFlash.b = gem ? 255 : 150;
          worldFlash.a = Math.min(0.5, worldFlash.a + (gem ? 0.3 : 0.38));
          break;
        }
        case 'chalk':
          if (ev.ok) {
            // A puff of chalk dust off the wall where the mark went.
            raycaster.particles.burst(
              PARTICLE.SPARK,
              ev.x,
              ev.y,
              0.5,
              14,
              0.9,
              0.5,
              PARTICLE_COLORS.dust,
              fxRng.next,
            );
          } else {
            const perks = /** @type {any} */ (state).perks;
            hud.notice(
              !perks || !(perks.chalk > 0)
                ? NOTICE_CHALK_LOCKED
                : state.run.chalk > 0
                  ? NOTICE_CHALK_REACH
                  : NOTICE_NO_CHALK,
            );
          }
          break;
        case 'enemyHit': {
          // A puff at the wound, brighter and longer when it was the killing blow. No world flash:
          // the flash path belongs to pickups, and using both for one event doubles the brightness
          // (§4.5 "two flash paths").
          raycaster.particles.burst(
            PARTICLE.SPARK,
            ev.x,
            ev.y,
            0.5,
            ev.killed ? 26 : 12,
            ev.killed ? 2.2 : 1.4,
            0.6,
            ev.kind === 'wraith' ? PARTICLE_COLORS.spark : PARTICLE_COLORS.ember,
            fxRng.next,
          );
          break;
        }
        case 'playerHit':
          // The page flash, not the world one: this happened TO the player, so it belongs over
          // everything the way a game over does, and the HUD's health panel flashes with it.
          postFlash.r = 150;
          postFlash.g = 26;
          postFlash.b = 20;
          postFlash.a = Math.min(0.5, postFlash.a + 0.34);
          break;
        case 'ember':
          hud.notice(NOTICE_EMBER);
          worldFlash.r = 255;
          worldFlash.g = 170;
          worldFlash.b = 90;
          worldFlash.a = Math.min(0.55, worldFlash.a + 0.45);
          break;
        case 'unlock':
          // Progress is the one thing a player would be furious to lose: write it now.
          persistNow(state);
          break;
        case 'levelComplete':
          postFlash.r = 255;
          postFlash.g = 246;
          postFlash.b = 224;
          postFlash.a = 0.55;
          break;
        case 'gameOver':
          postFlash.r = 90;
          postFlash.g = 20;
          postFlash.b = 16;
          postFlash.a = 0.42;
          // No persist here: the same dispatch also emits a `phase` event, and `onPhaseChange`
          // owns the write for both `gameOver` and `levelComplete`. Doing it in both places cost
          // two identical synchronous localStorage writes for one death.
          break;
        case 'phase':
          onPhaseChange(ev.from, ev.to, state);
          break;
        default:
          break;
      }
    }

    if (action && action.type === 'setSetting') applySettings(state.settings);
  }

  /**
   * React to a phase transition (the only place level requests and pointer-lock releases start).
   * @param {string} from
   * @param {string} to
   * @param {GameState} state
   * @returns {void}
   */
  function onPhaseChange(from, to, state) {
    if (to === 'loading') {
      loadRetries = 0;
      // Before the build, so the ~100 ms paint lands inside `MIN_LOAD_S` rather than on the first
      // frame of play (§4.11). A no-op in Classic Descent, and after the first combat floor.
      syncCombatArt(/** @type {any} */ (state).mode);
      requestLevel();
    }
    if (to !== 'playing') {
      // Give the cursor back the moment the player is not driving: pause, death, level complete.
      exitPointerLock();
    }
    // Gems go into the purse as they are picked up (§4.9), so a run abandoned to the title is
    // written too, not only one that ended.
    // Pausing writes too: a phone that kills a backgrounded tab may never deliver `pagehide`.
    if (to === 'levelComplete' || to === 'gameOver' || to === 'title' || to === 'paused') persistNow(state);
    // The saved run (§4.10) follows the run: every pause is a save point (blur and a hidden tab both
    // pause, so a closed tab keeps its descent), a clear checkpoints the next depth, a death ends it.
    if (from === 'playing' && to === 'paused') writeRun(snapshotMidLevel(state));
    else if (to === 'levelComplete') writeRun(snapshotCheckpoint(state));
    else if (to === 'gameOver') dropRun();
    if (from === 'loading' && to === 'playing') hud.reset();
  }

  /** @returns {void} */
  function exitPointerLock() {
    try {
      if (doc.pointerLockElement && typeof doc.exitPointerLock === 'function') doc.exitPointerLock();
    } catch {
      // Already released, or the browser refuses outside a gesture: nothing to do.
    }
  }

  /**
   * A settings change is waiting to be written to `localStorage`.
   *
   * `savePersist` is a synchronous `JSON.stringify` + storage write, and the options screen's
   * volume / music / sensitivity sliders dispatch `setSetting` on **every pointermove** — so
   * writing per dispatch means a storage write per pointer sample, inside the frame, on a phone or
   * a quota-pressured profile. The value is in the store either way; only the durable copy waits.
   */
  let persistDue = false;
  /** `state.time` of the last write, so the flush is rate-limited against the sim clock. */
  let lastPersistAt = -Infinity;

  /** How long a pending settings write may wait, in sim seconds. */
  const PERSIST_INTERVAL_S = 0.5;

  /**
   * Write the best score and settings to `localStorage` now, cancelling any pending write.
   * Used where the moment matters: a run ended, or the page is going away.
   * @param {GameState} state
   * @returns {void}
   */
  function persistNow(state) {
    persistDue = false;
    lastPersistAt = state.time;
    savePersist({
      best: state.best,
      settings: state.settings,
      progress: /** @type {any} */ (state).progress,
      // Both purses, not just the live one: a Shrine purchase in New Descent has to survive a
      // session that ends in Classic Descent (§4.11).
      profiles: /** @type {any} */ (state).profiles,
    });
  }

  /**
   * Write a pending settings change if one has been waiting long enough. Called once per step.
   * @param {GameState} state
   * @returns {void}
   */
  function flushPersist(state) {
    if (!persistDue) return;
    if (state.time - lastPersistAt < PERSIST_INTERVAL_S) return;
    persistNow(state);
  }

  /**
   * Push changed settings into the subsystems that cache them. Audio adopts `volume`/`music` from
   * the state by itself; the post stack reads `scanlines` every frame; only input needs telling.
   * @param {Settings} settings
   * @returns {void}
   */
  function applySettings(settings) {
    // Switching the option off is also the player asking to leave fullscreen now, not next run.
    if (settings.fullscreen !== appliedSettings.fullscreen && !settings.fullscreen && fullscreen.active) {
      fullscreen.exit();
    }
    appliedSettings.fullscreen = settings.fullscreen;
    if (
      settings.sensitivity !== appliedSettings.sensitivity ||
      settings.invertLook !== appliedSettings.invertLook
    ) {
      input.setOptions({ sensitivity: settings.sensitivity, invertLook: settings.invertLook });
    }
    if (settings.volume !== appliedSettings.volume || settings.music !== appliedSettings.music) {
      audio.setVolume(settings.volume, settings.music);
      if (settings.volume > 0) mutedVolume = settings.volume;
    }
    appliedSettings.volume = settings.volume;
    appliedSettings.music = settings.music;
    appliedSettings.sensitivity = settings.sensitivity;
    appliedSettings.invertLook = settings.invertLook;
    appliedSettings.scanlines = settings.scanlines;
    appliedSettings.minimap = settings.minimap;
    appliedSettings.mapMode = settings.mapMode;
    appliedSettings.reducedMotion = settings.reducedMotion;
    // However Auto Explore was switched (the O key or the Options row), a route planned before the
    // switch describes where the player *was*: drop it, so the pilot plans from where they are now.
    if (settings.autoExplore !== appliedSettings.autoExplore) {
      autopilot.interrupt();
      // Switching it on hands the cursor back so the AUTO button can be clicked to switch it off.
      if (settings.autoExplore) exitPointerLock();
    }
    appliedSettings.autoExplore = settings.autoExplore;
    // Mark rather than write: `step()` flushes at most twice a second, which collapses a whole
    // slider drag — and the map hotkey's two dispatches (`mapMode` + the legacy `minimap` mirror)
    // — into one storage write.
    persistDue = true;
  }

  store.subscribe(routeEvents);

  // ─── Input plumbing ───────────────────────────────────────────────────────────────────────

  /**
   * Injected input for headless tools (`window.__game.input.inject`). Merged with the real device
   * frame so a human can still drive the page while a tool is steering it.
   * @type {InputFrame}
   */
  const injected = { moveX: 0, moveY: 0, turn: 0, lookDX: 0, pressed: new Set() };
  /** The merged frame handed to the reducer in headless mode (reused, never reallocated). */
  const mergedFrame = /** @type {InputFrame} */ ({
    moveX: 0,
    moveY: 0,
    turn: 0,
    lookDX: 0,
    pressed: new Set(),
  });

  /**
   * Poll the devices for this step, folding in anything a headless tool injected.
   * @returns {InputFrame} a reused frame — never retain it
   */
  function pollFrame() {
    const real = input.poll();
    if (!EXPOSE) return real;
    mergedFrame.moveX = clamp(real.moveX + injected.moveX, -1, 1);
    mergedFrame.moveY = clamp(real.moveY + injected.moveY, -1, 1);
    mergedFrame.turn = clamp(real.turn + injected.turn, -1, 1);
    mergedFrame.lookDX = real.lookDX + injected.lookDX;
    const set = mergedFrame.pressed;
    set.clear();
    for (const a of real.pressed) set.add(a);
    for (const a of injected.pressed) set.add(a);
    // A look delta and an action press are one-shot events; axes persist until changed, so an
    // autopilot can set a heading once and keep walking.
    injected.lookDX = 0;
    injected.pressed.clear();
    return mergedFrame;
  }

  // ─── Auto Explore (§4.10) ─────────────────────────────────────────────────────────────────

  const autopilot = createAutopilot();
  /** The frame handed to the reducer while the autopilot drives (reused, never reallocated). */
  const autoFrame = /** @type {InputFrame} */ ({ moveX: 0, moveY: 0, turn: 0, lookDX: 0, pressed: new Set() });

  /**
   * Let the autopilot drive this step when Auto Explore is on. The player can always take over: any
   * movement, turn or look input this step is used as-is and the pilot drops its route, planning
   * afresh once the controls are let go. Action presses (pause, map, chalk…) always pass through.
   * @param {InputFrame} real the polled frame
   * @param {GameState} state
   * @param {number} dt the step, seconds
   * @returns {InputFrame}
   */
  function driveAuto(real, state, dt) {
    // New Descent has no Auto Explore (§4.11): the setting is ignored rather than cleared, so a
    // player who turned it on in Classic Descent still has it on in Classic Descent.
    if (/** @type {any} */ (state).mode === 'combat') return real;
    if (state.settings.autoExplore !== true || state.phase !== 'playing') return real;
    if (real.moveX !== 0 || real.moveY !== 0 || real.turn !== 0 || real.lookDX !== 0) {
      autopilot.interrupt();
      return real;
    }
    autopilot.step(state, autoFrame, dt);
    autoFrame.lookDX = 0;
    autoFrame.pressed = real.pressed;
    return autoFrame;
  }

  /**
   * Hotkeys that belong to the composition root rather than to a menu: pause, minimap and mute.
   * Only consulted when `menus.handleInput` did not consume the frame (i.e. during play).
   * @param {InputFrame} frame
   * @param {GameState} state
   * @returns {void}
   */
  function handleHotkeys(frame, state) {
    const pressed = frame.pressed;
    if (pressed.size === 0) return;
    if (state.phase === 'playing' && (pressed.has('pause') || pressed.has('back'))) {
      store.dispatch({ type: 'pause' });
    }
    if (pressed.has('map') && hud.mapLocked(state)) {
      // Locked until this level's scroll is found (§4.8). The persisted preference is left alone
      // so the map returns in the player's chosen mode the moment it unlocks.
      hud.notice('No Map - Find the Scroll');
    } else if (pressed.has('map')) {
      // Three states now (§4.6): OFF → CORNER → FULL. The HUD owns the cycle because it owns the
      // overlay that draws it; main.js only persists the result. Both keys are written: `mapMode`
      // is what the map restores from, `minimap` is the legacy mirror other consumers still read.
      const mode = hud.cycleMap(state.settings);
      store.dispatch({ type: 'setSetting', key: 'mapMode', value: mode });
      store.dispatch({ type: 'setSetting', key: 'minimap', value: mode !== 'off' });
    }
    if (pressed.has('mute')) {
      const on = state.settings.volume > 0;
      if (on) mutedVolume = state.settings.volume;
      store.dispatch({ type: 'setSetting', key: 'volume', value: on ? 0 : mutedVolume });
    }
    // The O key, and the touch bar's AUTO button (which emits the same action). Not in New Descent,
    // which has no autopilot — the key does nothing rather than toggling an invisible setting.
    if (pressed.has('auto') && /** @type {any} */ (state).mode !== 'combat') toggleAuto();
  }

  /**
   * Switch Auto Explore over and say so. Shared by the O key, the touch bar and the HUD button.
   * @returns {void}
   */
  function toggleAuto() {
    const next = store.getState().settings.autoExplore !== true;
    store.dispatch({ type: 'setSetting', key: 'autoExplore', value: next });
    hud.notice(next ? NOTICE_AUTO_ON : NOTICE_AUTO_OFF);
  }

  /** `performance.now()` until which the rest of a press that hit the HUD's AUTO button is swallowed. */
  let autoPressUntil = -1;

  /**
   * The HUD's AUTO button (§4.10). Window capture listeners, so the press is taken before
   * `input.js`'s canvas listeners can turn it into pointer lock or a look-drag, and before the
   * menus see it. A press toggles on `pointerdown`; the `mousedown`/`pointerup`/`mouseup`/`click`
   * (and touch events) belonging to the same press are swallowed for a short window.
   * @param {any} ev
   * @returns {void}
   */
  const onAutoButton = (ev) => {
    if (!ev || store.getState().phase !== 'playing') return;
    const t = performance.now();
    if (ev.type === 'pointerdown') {
      // The ATTACK plaque (§4.11) is taken here too, and first: it is the button a New Descent
      // player presses constantly, and it must not reach `input.js` as a look-drag or a lock request.
      if (ev.button === 0 && hud.hitAttack(ev.clientX, ev.clientY)) {
        autoPressUntil = t + 600;
        attackPressed = true;
      } else if (ev.button !== 0 || !hud.hitAuto(ev.clientX, ev.clientY)) {
        return;
      } else {
        autoPressUntil = t + 600;
        toggleAuto();
      }
    } else if (t > autoPressUntil) {
      return;
    }
    ev.stopPropagation();
    if (ev.cancelable) ev.preventDefault();
  };

  /**
   * Set by a press on the HUD's ATTACK plaque, consumed by the next `step` as an ordinary `attack`
   * edge — so a tap on the plaque, the F key and a locked mouse click are indistinguishable to the
   * simulation, which is the only way the three can stay in step.
   */
  let attackPressed = false;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'touchstart', 'touchend']) {
    listen(globalThis, type, onAutoButton, { capture: true, passive: false });
  }

  // Pointer events reach the menus directly: they hit-test the layout recorded by the last render.
  const onPointer = (/** @type {PointerEvent} */ ev) => {
    // A press on the world while playing is the gesture that re-enters fullscreen after the player
    // left it (Esc). It runs on the pointer event, which precedes the `click` input.js turns into
    // pointer lock. Browsers grant activation on `pointerdown` for a mouse but only on `pointerup`
    // for touch and pen, so each kind asks on the event that actually carries the gesture.
    if (store.getState().phase === 'playing') {
      const mouse = ev.pointerType === 'mouse' || !ev.pointerType;
      if (ev.type === (mouse ? 'pointerdown' : 'pointerup')) autoFullscreen();
    }
    const handled = menus.handlePointer(ev);
    if (handled && ev.cancelable) ev.preventDefault();
  };
  for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerleave', 'pointercancel']) {
    listen(overlay, type, onPointer);
  }

  // ─── Layout ───────────────────────────────────────────────────────────────────────────────

  /** Coalesces a burst of resize events into one relayout per frame. */
  let resizePending = false;

  /**
   * Size every surface to the viewport.
   *
   * The 3-D buffer is a fixed 240 rows (§4.5), so the canvas *element* is the thing that has to be
   * fitted: it is scaled to the largest box that preserves the buffer's aspect, snapped to a whole
   * pixel multiple whenever that costs less than {@link INTEGER_FIT_TOLERANCE} of the area. Integer
   * scaling is what makes `image-rendering: pixelated` produce square, evenly-sized pixels instead
   * of a mix of 4- and 5-device-pixel columns.
   *
   * The post-effect stack is sized to the same box so the vignette and iris frame the world rather
   * than the letterbox; the overlay stays full-bleed so menus can use the whole screen.
   * @returns {void}
   */
  function layout() {
    resizePending = false;
    const cssW = Math.max(1, globalThis.innerWidth || doc.documentElement.clientWidth || 960);
    const cssH = Math.max(1, globalThis.innerHeight || doc.documentElement.clientHeight || 540);
    const dpr = clamp(globalThis.devicePixelRatio || 1, 0.5, 4);

    // The framebuffer can grow taller than 4:3 (§4.5: 320 columns, up to 400 rows), which fills a
    // foldable's near-square inner screen. A phone in portrait is far past that, so it keeps the 4:3
    // band on purpose: the strip above it takes the HUD's top row, and the deeper deck below takes
    // the minimap and the thumb that drives the virtual stick — a handheld cabinet, not a broken video.
    const portrait = cssH > cssW * 1.25;
    raycaster.resize(cssW, portrait ? cssW * 0.75 : cssH, dpr);
    const iw = raycaster.internalSize.w || 426;
    const ih = raycaster.internalSize.h || 240;

    let scale = Math.min((cssW * dpr) / iw, (cssH * dpr) / ih);
    const whole = Math.floor(scale);
    if (whole >= 1 && whole / scale >= INTEGER_FIT_TOLERANCE) scale = whole;
    const boxW = Math.round((iw * scale) / dpr);
    const boxH = Math.round((ih * scale) / dpr);

    // Rather than centring the portrait band and leaving two dead bars, it is pushed up to 42 %.
    for (const el of /** @type {HTMLElement[]} */ ([view, postRoot])) {
      if (!el) continue;
      el.style.width = `${boxW}px`;
      el.style.height = `${boxH}px`;
      el.style.top = portrait ? '42%' : '50%';
      el.style.transform = 'translate(-50%, -50%)';
    }
    doc.body.classList.toggle('portrait', portrait);
    post.resize(boxW, boxH, ih);

    // The overlay is inset by the device's safe areas (styles.css), so it is measured rather than
    // assumed: `hud.resize` sizes the backing store, and the same numbers drive pointer mapping.
    const rect = overlay.getBoundingClientRect();
    const overlayW = Math.max(1, Math.round(rect.width) || cssW);
    const overlayH = Math.max(1, Math.round(rect.height) || cssH);
    // Tell the shared surface where the world band sits (§4.6 `Surface.setViewRect`) rather than
    // leaving it to re-measure `#view` itself: this function is the one that decided the band, and
    // on a portrait phone the menus lay rows out around it. Relative to the overlay, in CSS px.
    if (view && typeof hud.surface?.setViewRect === 'function') {
      const vr = view.getBoundingClientRect();
      hud.surface.setViewRect(vr.left - rect.left, vr.top - rect.top, vr.width, vr.height);
    }
    hud.resize(overlayW, overlayH, dpr);
    menus.resize(overlayW, overlayH, dpr);
  }

  /** @returns {void} */
  function scheduleLayout() {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(layout);
  }

  listen(globalThis, 'resize', scheduleLayout, { passive: true });
  listen(globalThis, 'orientationchange', scheduleLayout, { passive: true });
  listen(globalThis.visualViewport, 'resize', scheduleLayout, { passive: true });
  layout();

  // ─── Focus / visibility ───────────────────────────────────────────────────────────────────

  // Losing focus mid-corridor and coming back to a drained torch is the cheapest unfair death in
  // the genre. The loop already stops ticking on `document.hidden`; this also opens the pause menu
  // so the player sees *why* the world stopped, and so the torch is safe when focus is merely lost.
  const autoPause = () => {
    if (store.getState().phase === 'playing') store.dispatch({ type: 'pause' });
  };
  /**
   * Losing focus or the pointer while Auto Explore drives is a player stepping back to watch, not
   * one who stopped driving: keep going. A hidden tab still pauses (the loop stops anyway, and the
   * pause is the save point that keeps the run if the tab is then closed).
   */
  const focusPause = () => {
    const st = store.getState();
    // Only a watching player (Auto Explore driving) keeps going through a blur. New Descent has no
    // autopilot, so losing focus there is always someone who stopped playing — and being chewed on
    // while the window is behind another one is the unfairest death the mode could offer.
    if (/** @type {any} */ (st).mode === 'combat' || st.settings.autoExplore !== true) autoPause();
  };
  listen(globalThis, 'blur', focusPause);
  listen(doc, 'visibilitychange', () => {
    if (doc.hidden) autoPause();
  });
  listen(doc, 'pointerlockchange', () => {
    const locked = doc.pointerLockElement === overlay;
    // A hidden cursor is only right while the pointer is captured.
    doc.body.classList.toggle('locked', locked);
    // Escape is how a browser gives the pointer back, and it does NOT deliver that keypress to the
    // page — so without this, the first Esc frees the cursor and the game keeps running behind it.
    // Losing the pointer while playing means the player stopped driving: pause — unless our own
    // fullscreen transition took it. A real Esc during that window also leaves fullscreen, and that
    // change pauses on its own below; input.js re-acquires the lock, and free mouse look covers the gap.
    if (!locked && performance.now() - fullscreenRequestMs > FULLSCREEN_LOCK_GRACE_MS) focusPause();
  });
  // Fullscreen changes the window size (relayout), and Esc leaves it without delivering the key to
  // the page — the same trap as pointer lock above, so leaving it while playing pauses too.
  fullscreen.onChange((active) => {
    scheduleLayout();
    if (!active) autoPause();
  });

  // ─── Frame ────────────────────────────────────────────────────────────────────────────────

  /**
   * The single options object handed to `post.set` every frame. Reused for the same reason the
   * render view is: this runs 60 times a second forever.
   * @type {{scanlines:boolean, vignette:number, lowFuelPulse:number, flash:typeof postFlash, iris:number}}
   */
  const postOpts = {
    scanlines: true,
    vignette: 0.6,
    lowFuelPulse: 0,
    flash: postFlash,
    iris: 0,
  };

  /** The single `RenderView`, mutated in place every frame (§4.5). @type {RenderView} */
  const renderView = {
    player: { x: 1.5, y: 1.5, angle: 0, bob: 0, bobAmp: 0, shake: 0 },
    maze: /** @type {any} */ (null),
    items: NO_ITEMS,
    torches: NO_TORCHES,
    exit: { x: 0, y: 0 },
    time: 0,
    light: 0.85,
    flash: worldFlash,
    portalOpen: true,
    reducedMotion: false,
    marks: NO_MARKS,
    flame: 1,
    oilSense: 0,
    whisper: 0,
    enemies: NO_ENEMIES,
    weapon: null,
  };

  /**
   * The single weapon view block (New Descent, §4.11), mutated in place like the render view itself.
   * @type {{st:number, frame:number, phase:number, kick:number}}
   */
  const weaponState = { st: 0, frame: 0, phase: 0, kick: 0, sweep: 0 };

  /**
   * Which sword frame this moment of the swing shows, and how much recoil goes with it.
   *
   * The eight painted poses are laid over the attack state machine rather than run on their own
   * clock, so the frame on screen is always the frame the simulation is actually in — a wind-up the
   * player can read is only a fair telegraph if it lasts exactly as long as the wind-up does.
   * @param {GameState} state
   * @returns {{st:number, frame:number, phase:number, kick:number}}
   */
  function weaponView(state) {
    const atk = /** @type {any} */ (state).attack;
    const st = atk ? atk.st | 0 : 0;
    const t = atk ? atk.t : 0;
    const S = COMBAT.SWING;
    let phase = 0;
    let frame = 0;
    let kick = 0;
    // How far across the screen the cut travels, 0..1. The painted poses cannot carry this on their
    // own: the blade is already at the edge of its 64-texel card at full roll, so sweeping it
    // further inside the card clips the point off. Sliding the whole card left is what turns a
    // raised blade into a cut that crosses the view.
    let sweep = 0;
    // `kick` is SIGNED: negative drops the weapon back out of the way, positive drives it up into
    // the view. The first pass made it 0..1 and the renderer always pushed DOWN, so the strike —
    // the one frame the player is looking at — shoved the blade off the bottom of the screen.
    if (st === 1) {
      // Wind-up: poses 1→2, the blade drawn back and down. This is the telegraph, and it earns the
      // strike that follows by getting out of the way first.
      phase = S.WIND_UP > 0 ? clamp01(t / S.WIND_UP) : 1;
      frame = phase < 0.5 ? 1 : 2;
      kick = -0.45 * phase;
    } else if (st === 2) {
      // Strike: poses 3→4, the two fast frames with the motion smear on them, driven up and across.
      phase = S.STRIKE > 0 ? clamp01(t / S.STRIKE) : 1;
      frame = phase < 0.5 ? 3 : 4;
      kick = 1;
      sweep = 0.35 + 0.65 * phase;
    } else if (st === 3) {
      // Recover: poses 5→7 settling back to rest, and the lift decays with them.
      phase = S.RECOVER > 0 ? clamp01(t / S.RECOVER) : 1;
      frame = phase < 0.34 ? 5 : phase < 0.7 ? 6 : 7;
      kick = 1 - phase;
      sweep = (1 - phase) * 0.8;
    }
    weaponState.st = st;
    weaponState.frame = frame < SWORD_FRAMES ? frame : SWORD_FRAMES - 1;
    weaponState.phase = phase;
    weaponState.kick = kick;
    weaponState.sweep = sweep;
    return weaponState;
  }

  /** The tick action, reused: the reducer allocates nothing per step and neither should we. */
  const tickAction = { type: 'tick', dt: 0, input: /** @type {InputFrame|null} */ (null), auto: false };

  /**
   * One simulation step. Input is polled exactly once per step, so no press can be seen twice.
   * @param {number} dt seconds — always exactly 1/60 (§4.1)
   * @returns {void}
   */
  function step(dt) {
    const polled = pollFrame();
    // A press on the HUD's ATTACK plaque this frame (§4.11), merged in as a real edge.
    if (attackPressed) {
      attackPressed = false;
      polled.pressed.add('attack');
    }
    const state = store.getState();
    // Menus consume navigation on every menu screen and return false during play and loading.
    if (!menus.handleInput(polled, state)) handleHotkeys(polled, state);

    tickAction.dt = dt;
    tickAction.input = driveAuto(polled, store.getState(), dt);
    // The torch burns at the pilot's calm pace only on steps the pilot actually drove (§4.10).
    tickAction.auto = tickAction.input === autoFrame;
    store.dispatch(tickAction);

    // Auto Explore carries on down: once the cleared depth's tally has had its moment, descend. From
    // the tally, or from the boon cards — which open themselves `BOON_HOLD_S` after the tally, and with
    // Reduced Motion that is before NEXT_LEVEL_DELAY — after a longer grace so a player who is
    // watching can still pick one. Never out from under the Shrine or a dialog. An unclaimed boon is
    // forfeited for this run only; the depth offers one again later (§4.9).
    const after = store.getState();
    if (after.settings.autoExplore === true && after.phase === 'levelComplete') {
      const screen = menus.screen();
      if (
        (screen === 'complete' && after.phaseTime >= AUTO.NEXT_LEVEL_DELAY) ||
        (screen === 'boon' && after.phaseTime >= AUTO.BOON_DELAY)
      ) {
        store.dispatch({ type: 'nextLevel' });
      }
    }

    // Settings written during this step (or the last few) go to storage here, off the pointer
    // event that produced them.
    flushPersist(store.getState());

    // Watchdog: a level that never arrives would strand the player on the loading screen, and the
    // phase machine has no exit from `loading` (documented in ARCHITECTURE.md §4.2).
    if (store.getState().phase === 'loading') {
      loadWait += dt;
      if (pendingLevel !== null) {
        // A built level is in hand — install it once the loading screen has had its moment. The
        // token is re-checked here because a retry may have superseded this answer while it waited.
        if (loadWait >= MIN_LOAD_S) {
          const data = pendingLevel;
          const token = pendingToken;
          pendingLevel = null;
          pendingToken = -1;
          if (token === buildToken) store.dispatch({ type: 'levelReady', data });
        }
      } else if (loadWait > LOAD_TIMEOUT_S) {
        log.error('level build timed out; retrying');
        loadRetries = 0;
        requestLevel(loadWait | 0);
      }
    } else {
      loadWait = 0;
      // Leaving `loading` any other way (a retry, quitting to the title) abandons the answer, so a
      // level built for a run the player already left can never be installed later.
      pendingLevel = null;
      pendingToken = -1;
    }
  }

  /**
   * Draw one frame: world, overlay, effects.
   * @param {number} alpha interpolation factor in [0,1) between the previous and current sim step
   * @param {number} frameDt real seconds since the previous frame
   * @returns {void}
   */
  function render(alpha, frameDt) {
    const state = /** @type {GameState} */ (store.getState());
    const p = state.player;
    const level = state.levelData;
    const rv = renderView.player;

    rv.x = lerp(p.px, p.x, alpha);
    rv.y = lerp(p.py, p.y, alpha);
    rv.angle = lerpAngle(p.pangle, p.angle, alpha);
    rv.bob = p.bob;
    rv.bobAmp = p.bobAmp;
    rv.shake = p.shake;

    renderView.maze = level === null ? /** @type {any} */ (null) : level.maze;
    renderView.items = level === null ? NO_ITEMS : level.items;
    renderView.torches = level === null ? NO_TORCHES : level.torches;
    renderView.exit = level === null ? renderView.exit : level.maze.exit;
    renderView.time = state.time + alpha / 60;
    renderView.reducedMotion = state.settings.reducedMotion;
    // Unlocks the world itself shows (§4.9). The attract camera on the title wanders the plain game.
    const inRun = state.phase !== 'title' && level !== null;
    const perks = /** @type {any} */ (state).perks;
    const marks = /** @type {any} */ (state).marks;
    renderView.marks = inRun && Array.isArray(marks) ? marks : NO_MARKS;
    renderView.flame = inRun && perks ? perks.flame : 1;
    renderView.oilSense = inRun && perks ? perks.oilSense : 0;
    renderView.whisper = inRun && perks ? perks.whisper : 0;
    // New Descent (§4.11). The title's attract camera wanders the plain game, so both are empty
    // there and the enemy pass and the weapon pass return on their first line.
    const foes = /** @type {any} */ (state).enemies;
    renderView.enemies = inRun && Array.isArray(foes) ? foes : NO_ENEMIES;
    renderView.weapon = inRun && /** @type {any} */ (state).mode === 'combat' ? weaponView(state) : null;

    // Torch strength drives the light radius (§4.5). The exponent keeps the dungeon readable for
    // most of the level and then closes in hard over the last fifth, which is where the tension is.
    const run = state.run;
    const fuelFrac = run.fuelMax > 0 ? clamp01(run.fuel / run.fuelMax) : 1;
    renderView.light = state.phase === 'title' ? 0.85 : Math.pow(fuelFrac, 0.65);

    syncTileset(state.phase === 'title' ? 1 : state.level);
    raycaster.render(renderView);

    // Touch devices get these in the touch bar; the HUD's plaques are for a mouse (§4.10, §4.11).
    hud.setAutoButton(!input.isTouch);
    hud.setAttackButton(!input.isTouch);
    hud.render(state, loop.stats(), alpha);
    menus.render(state);

    // ── Post stack ──
    const lowFuel = state.derived.lowFuel && (state.phase === 'playing' || state.phase === 'paused');
    const reduced = state.settings.reducedMotion;
    const pulse = lowFuel
      ? reduced
        ? 0.18
        : 0.2 + 0.18 * Math.sin(state.time * 6.5) * Math.sin(state.time * 2.1)
      : 0;

    // The iris is the level-transition wipe: closed while a level is being carved and after the
    // run ends, open while there is a world worth looking at.
    const irisTarget =
      state.phase === 'playing' || state.phase === 'paused' || state.phase === 'title' ? 1 : 0;
    const irisRate = irisTarget > iris ? IRIS_OPEN_RATE : IRIS_CLOSE_RATE;
    if (level === null && state.phase === 'title') {
      iris = 0; // nothing to reveal yet; hold the shutter until the demo maze lands
    } else {
      iris = clamp01(iris + Math.sign(irisTarget - iris) * irisRate * frameDt);
      if (Math.abs(irisTarget - iris) < 0.01) iris = irisTarget;
    }

    postOpts.scanlines = state.settings.scanlines;
    postOpts.vignette = 0.52 + 0.34 * (1 - renderView.light);
    postOpts.lowFuelPulse = pulse;
    postOpts.iris = iris;
    post.set(postOpts);

    worldFlash.a = worldFlash.a > 0 ? Math.max(0, worldFlash.a - frameDt * FLASH_DECAY) : 0;
    postFlash.a = postFlash.a > 0 ? Math.max(0, postFlash.a - frameDt * POST_FLASH_DECAY) : 0;

    audio.update(state);
    input.updateOverlay(state);
  }

  const loop = createLoop({ step, render });

  // ─── Headless surface (ARCHITECTURE.md §4.7) ──────────────────────────────────────────────

  if (EXPOSE) {
    // Exactly the keys §4.7 enumerates, and nothing else: an extra handle here (the raw `loop`,
    // with start/stop on it, used to be one) is something a tool comes to depend on and the
    // contract never promised.
    /** @type {any} */ (globalThis).__game = {
      ready: false,
      state: () => store.getState(),
      dispatch: (/** @type {any} */ action) => store.dispatch(action),
      // Tools observe transitions through the same seam the game does, so a phase that lasts less
      // than one frame (a small level builds synchronously) is still seen exactly once.
      subscribe: (/** @type {any} */ fn) => store.subscribe(fn),
      stepOnce: (/** @type {number} */ n) => loop.stepOnce(n),
      stats: () => loop.stats(),
      renderStats: () => raycaster.stats(),
      audioStats: () => audio.stats(),
      // Which menu screen is up. A tool driving the menus through the real input path has no other
      // way to know whether a keypress landed, and "the options screen opened" is exactly the kind
      // of thing a gate should assert rather than assume.
      screen: () => menus.screen(),
      mapMode: () => hud.mapMode(store.getState().settings),
      // Auto Explore's current goal and plan count, and the saved run the title offers (§4.10).
      autopilot: () => autopilot.info(),
      savedRun: () => savedSummary,
      errors,
      input: {
        /**
         * Merge a partial frame into the injected input. Axes persist until changed; `lookDX` and
         * `pressed` are consumed by the next step, exactly like a real device's edges.
         * @param {Partial<InputFrame>|null} partial
         */
        inject(partial) {
          if (!partial || typeof partial !== 'object') return;
          if (typeof partial.moveX === 'number') injected.moveX = clamp(partial.moveX, -1, 1);
          if (typeof partial.moveY === 'number') injected.moveY = clamp(partial.moveY, -1, 1);
          if (typeof partial.turn === 'number') injected.turn = clamp(partial.turn, -1, 1);
          if (typeof partial.lookDX === 'number' && Number.isFinite(partial.lookDX)) {
            injected.lookDX += partial.lookDX;
          }

          const pressed = /** @type {any} */ (partial).pressed;
          if (pressed) {
            const list = Array.isArray(pressed) ? pressed : Array.from(pressed);
            for (const a of list) injected.pressed.add(/** @type {InputAction} */ (a));
          }
        },
        /** Drop every injected value (stop walking). */
        clear() {
          injected.moveX = 0;
          injected.moveY = 0;
          injected.turn = 0;
          injected.lookDX = 0;
          injected.pressed.clear();
        },
      },
    };
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────────────────────

  /** Guards {@link shutdown} against a second `pagehide` (or a manual call). */
  let shutDown = false;

  /**
   * Give everything back: stop the loop, dispose every subsystem that publishes a teardown in its
   * §4 contract, and remove every listener this file registered.
   *
   * Only for a page that is genuinely going away. A `pagehide` with `persisted === true` means the
   * page went into the back/forward cache and may be restored, so that path only writes a pending
   * setting: the loop suspends itself on `document.hidden` and comes back on `pageshow` (§4.1).
   * @returns {void}
   */
  function shutdown() {
    if (shutDown) return;
    shutDown = true;
    try {
      persistNow(store.getState());
      saveLiveRun();
    } catch {
      // Storage may be gone already; a lost preference must not take the teardown with it.
    }
    loop.stop();
    for (const l of listeners) {
      try {
        l.target.removeEventListener(l.type, l.fn, l.opts);
      } catch {
        // A detached target is already as removed as it can be.
      }
    }
    listeners.length = 0;
    // Each of these is documented as idempotent and safe to call, but one throwing must not stop
    // the rest from running — a half-disposed page is worse than an undisposed one.
    for (const close of [
      () => mazeClient.dispose(),
      () => input.destroy(),
      () => fullscreen.destroy(),
      () => audio.dispose(),
      () => raycaster.dispose(),
      () => post.destroy(),
      () => hud.dispose(),
      () => menus.dispose(),
    ]) {
      try {
        close();
      } catch (err) {
        log.error('shutdown step failed', err);
      }
    }
  }

  /**
   * Save a run that is mid-level as the page goes away (§4.10). A page closed without a blur (a
   * scripted close, a crash-free kill with focus) would otherwise resume from the last pause.
   * @returns {void}
   */
  function saveLiveRun() {
    const st = store.getState();
    if (st.phase === 'playing' || st.phase === 'paused') writeRun(snapshotMidLevel(st));
  }

  listen(globalThis, 'pagehide', (/** @type {PageTransitionEvent} */ ev) => {
    if (ev && ev.persisted) {
      // Bound for the bfcache: keep the machine intact, just make the durable copy current.
      if (persistDue) persistNow(store.getState());
      saveLiveRun();
      return;
    }
    shutdown();
  });

  // ─── Go ───────────────────────────────────────────────────────────────────────────────────

  requestDemoLevel();
  loop.start();
  if (/** @type {any} */ (globalThis).__game) /** @type {any} */ (globalThis).__game.ready = true;
  log.info('A-MAZE booted');
}

try {
  boot();
} catch (err) {
  showFatal(err);
}
