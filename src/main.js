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
import { levelParams } from './state/balance.js';
import { loadPersist, savePersist } from './state/save.js';

import { createInput } from './input/input.js';
import { CONTROL_HINTS } from './input/bindings.js';
import { createMazeClient } from './maze/client.js';

import { createRaycaster } from './renderer/raycaster.js';
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
 * 1, deliberately, now that level 1 is 16×16 cells (33×33 tiles): that is already a substantial
 * labyrinth for a camera that walks one corridor at a time, it stays under the maze client's
 * 400-cell worker threshold so the title costs no worker spin-up at boot, and it keeps the title's
 * item/torch load — the things the renderer sorts every frame — at its smallest.
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
/** `?seed=N` pins the run seed so a headless run replays exactly. */
const SEED_PARAM = Number(params.get('seed'));
const FORCED_SEED = Number.isFinite(SEED_PARAM) && params.get('seed') !== null ? SEED_PARAM >>> 0 : null;

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
  const store = createStore(createInitialState(persisted.settings, persisted.best), reducer);

  /** Settings snapshot used to detect what actually changed after a `setSetting`. */
  const appliedSettings = { ...store.getState().settings };
  /** Volume restored by the mute toggle. */
  let mutedVolume = appliedSettings.volume > 0 ? appliedSettings.volume : 0.8;

  // ── Renderer, overlay, effects ──────────────────────────────────────────────────────────────
  const raycaster = createRaycaster(view);
  const post = createPost(postRoot);
  const hud = createHud(overlay);
  const audio = createAudio({ volume: appliedSettings.volume, music: appliedSettings.music });

  const menus = createMenus(overlay, {
    // Menus never invent a seed and never touch state: every row becomes one dispatch.
    onNewGame: () => {
      audio.unlock(); // we are inside a real user gesture here, which is the only place this works
      hud.reset();
      store.dispatch({ type: 'newGame', seed: FORCED_SEED === null ? randomSeed() : FORCED_SEED });
    },
    onResume: () => store.dispatch({ type: 'resume' }),
    onQuit: () => store.dispatch({ type: 'toTitle' }),
    onNextLevel: () => store.dispatch({ type: 'nextLevel' }),
    onSetting: (key, value) => store.dispatch({ type: 'setSetting', key, value }),
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
    shouldLockPointer: () => store.getState().phase === 'playing',
    touchRoot: /** @type {HTMLElement|null} */ (touchRoot),
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
    const seed = (seedForLevel(st.seed, level) + (salt || 0)) >>> 0;
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
      requestLevel();
    }
    if (to !== 'playing') {
      // Give the cursor back the moment the player is not driving: pause, death, level complete.
      exitPointerLock();
    }
    if (to === 'levelComplete' || to === 'gameOver') persistNow(state);
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
    savePersist({ best: state.best, settings: state.settings });
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
  const injected = { moveX: 0, moveY: 0, turn: 0, lookDX: 0, sprint: false, pressed: new Set() };
  /** The merged frame handed to the reducer in headless mode (reused, never reallocated). */
  const mergedFrame = /** @type {InputFrame} */ ({
    moveX: 0,
    moveY: 0,
    turn: 0,
    lookDX: 0,
    sprint: false,
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
    mergedFrame.sprint = real.sprint || injected.sprint;
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
  }

  // Pointer events reach the menus directly: they hit-test the layout recorded by the last render.
  const onPointer = (/** @type {PointerEvent} */ ev) => {
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

    raycaster.resize(cssW, cssH, dpr);
    const iw = raycaster.internalSize.w || 426;
    const ih = raycaster.internalSize.h || 240;

    let scale = Math.min((cssW * dpr) / iw, (cssH * dpr) / ih);
    const whole = Math.floor(scale);
    if (whole >= 1 && whole / scale >= INTEGER_FIT_TOLERANCE) scale = whole;
    const boxW = Math.round((iw * scale) / dpr);
    const boxH = Math.round((ih * scale) / dpr);

    // The framebuffer can never be taller than 4:3 (§4.5 pins 240 rows and clamps the width to
    // 320…560), so a phone in portrait always letterboxes. Rather than centring the band and
    // leaving two dead bars, it is pushed up to 42 % of the height: the strip above it takes the
    // HUD's top row, and the deeper deck below takes the compass, the minimap and the thumb that
    // drives the virtual stick. The result reads as a handheld cabinet instead of a broken video.
    const portrait = cssH > cssW * 1.15;
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
  listen(globalThis, 'blur', autoPause);
  listen(doc, 'visibilitychange', () => {
    if (doc.hidden) autoPause();
  });
  listen(doc, 'pointerlockchange', () => {
    const locked = doc.pointerLockElement === overlay;
    // A hidden cursor is only right while the pointer is captured.
    doc.body.classList.toggle('locked', locked);
    // Escape is how a browser gives the pointer back, and it does NOT deliver that keypress to the
    // page — so without this, the first Esc frees the cursor and the game keeps running behind it.
    // Losing the pointer while playing means the player stopped driving: pause.
    if (!locked) autoPause();
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
  };

  /** The tick action, reused: the reducer allocates nothing per step and neither should we. */
  const tickAction = { type: 'tick', dt: 0, input: /** @type {InputFrame|null} */ (null) };

  /**
   * One simulation step. Input is polled exactly once per step, so no press can be seen twice.
   * @param {number} dt seconds — always exactly 1/60 (§4.1)
   * @returns {void}
   */
  function step(dt) {
    const frame = pollFrame();
    const state = store.getState();
    // Menus consume navigation on every menu screen and return false during play and loading.
    if (!menus.handleInput(frame, state)) handleHotkeys(frame, state);

    tickAction.dt = dt;
    tickAction.input = frame;
    store.dispatch(tickAction);

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

    // Torch strength drives the light radius (§4.5). The exponent keeps the dungeon readable for
    // most of the level and then closes in hard over the last fifth, which is where the tension is.
    const run = state.run;
    const fuelFrac = run.fuelMax > 0 ? clamp01(run.fuel / run.fuelMax) : 1;
    renderView.light = state.phase === 'title' ? 0.85 : Math.pow(fuelFrac, 0.65);

    raycaster.render(renderView);

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
          if (typeof partial.sprint === 'boolean') injected.sprint = partial.sprint;
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
          injected.sprint = false;
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

  listen(globalThis, 'pagehide', (/** @type {PageTransitionEvent} */ ev) => {
    if (ev && ev.persisted) {
      // Bound for the bfcache: keep the machine intact, just make the durable copy current.
      if (persistDue) persistNow(store.getState());
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
