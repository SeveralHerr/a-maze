// @ts-check
/**
 * @file Unit tests for src/state/game.js — the phase machine, level installation, scoring,
 * fuel economy and the reducer's total-function guarantee (no input can make it throw).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE } from '../maze/constants.js';
import { createInitialState, reducer } from './game.js';
import {
  CAP_LEVEL,
  FUEL,
  PLAYER,
  SCORE,
  SIM,
  drainRate,
  gemScore,
  levelBonus,
  levelParams,
  oilFuel,
  UNLOCKS,
  UNLOCK_FX,
  unlockCost,
} from './balance.js';

/** The lean first floor's tank: every level-1 fixture's offered fuel is clamped to it. */
const TANK1 = levelParams(1).fuelSeconds;

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {string[]} rows '#' = wall, 'S' = start, 'E' = exit
 * @returns {import('../core/types.js').Maze}
 */
function mazeFrom(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const tiles = new Uint8Array(width * height);
  let start = { x: 1, y: 1 };
  let exit = { x: 1, y: 1 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = rows[y][x];
      tiles[y * width + x] = c === '#' ? TILE.WALL : TILE.FLOOR;
      if (c === 'S') start = { x, y };
      if (c === 'E') exit = { x, y };
    }
  }
  return { width, height, cols: (width - 1) >> 1, rows: (height - 1) >> 1, tiles, start, exit, seed: 99 };
}

/** A 3-tile corridor: start west, exit east. */
const CORRIDOR = ['#####', '#S.E#', '#####'];

/**
 * @param {import('../core/types.js').Item[]} [items]
 * @param {number} [fuel]
 * @param {string[]} [rows]
 * @returns {import('../core/types.js').LevelData}
 */
function level(items = [], fuel = 100, rows = CORRIDOR) {
  return {
    maze: mazeFrom(rows),
    validation: {
      solvable: true,
      fullyConnected: true,
      bordersSealed: true,
      pathLength: 3,
      floorCount: 3,
      deadEnds: 0,
      loops: 0,
      path: null,
      errors: [],
    },
    items,
    torches: [],
    fuel,
    par: 40,
  };
}

/**
 * @param {number} id
 * @param {import('../core/types.js').ItemKind} kind
 * @param {number} x
 * @param {number} y
 * @returns {import('../core/types.js').Item}
 */
function item(id, kind, x, y) {
  return { id, kind, x, y, taken: false };
}

/** @returns {import('../core/types.js').InputFrame} */
function frame(o = {}) {
  return /** @type {any} */ ({
    moveX: 0,
    moveY: 0,
    turn: 0,
    lookDX: 0,
    pressed: new Set(),
    ...o,
  });
}

/**
 * Start a run and install a level, leaving the state in `playing`.
 * @param {import('../core/types.js').LevelData} [data]
 * @returns {import('../core/types.js').GameState}
 */
function started(data = level()) {
  const s = createInitialState();
  reducer(s, { type: 'newGame', seed: 12345 });
  reducer(s, { type: 'levelReady', data });
  return s;
}

/**
 * @param {import('../core/types.js').GameState} s
 * @param {number} n
 * @param {object} [inp]
 * @returns {void}
 */
function ticks(s, n, inp = {}) {
  for (let i = 0; i < n; i++) reducer(s, { type: 'tick', dt: 1 / 60, input: frame(inp) });
}

/**
 * @param {import('../core/types.js').GameState} s
 * @param {import('../core/types.js').GameEvent['type']} type
 * @returns {number}
 */
function countEvents(s, type) {
  let n = 0;
  for (const e of s.events) if (e.type === type) n++;
  return n;
}

/**
 * Tick up to `max` times, collecting every event emitted along the way. Events live only until the
 * next dispatch, so any test spanning more than one tick must accumulate them like this (exactly
 * as main.js does from its store subscriber).
 * @param {import('../core/types.js').GameState} s
 * @param {number} max
 * @param {object} [inp]
 * @param {(s: import('../core/types.js').GameState) => boolean} [until] stop when this returns true
 * @returns {import('../core/types.js').GameEvent[]}
 */
function collect(s, max, inp = {}, until) {
  /** @type {import('../core/types.js').GameEvent[]} */
  const out = [];
  for (let i = 0; i < max; i++) {
    reducer(s, { type: 'tick', dt: 1 / 60, input: frame(inp) });
    for (const e of s.events) out.push(e);
    if (until !== undefined && until(s)) break;
  }
  return out;
}

/**
 * @param {import('../core/types.js').GameEvent[]} events
 * @param {string} type
 * @returns {number}
 */
function count(events, type) {
  let n = 0;
  for (const e of events) if (e.type === type) n++;
  return n;
}

// ─── Initial state ───────────────────────────────────────────────────────────────────────────

test('createInitialState: a clean, valid, contract-shaped state', () => {
  const s = createInitialState();
  assert.equal(s.phase, 'title');
  assert.equal(s.time, 0);
  assert.equal(s.phaseTime, 0);
  assert.equal(s.level, 1);
  assert.equal(s.levelData, null);
  assert.equal(s.explored, null);
  assert.deepEqual(s.best, { score: 0, level: 0 });
  assert.deepEqual(s.run, {
    score: 0,
    gems: 0,
    gemsTotal: 0,
    fuel: 0,
    fuelMax: 0,
    levelTime: 0,
    totalTime: 0,
    levelScore: 0,
    bestCombo: 0,
    refuels: 0,
    distance: 0,
    mapFound: true,
    chalk: 0,
    reserve: 0,
    emberUsed: false,
    // New Descent (§4.11). `hpMax` 0 is what every consumer reads as "this mode has no health".
    hp: 0,
    hpMax: 0,
    kills: 0,
    iframes: 0,
    // How the run ended (§4.12). A run that has not ended still carries the field, and carries the
    // torch — which is what it is heading for.
    endCause: 'torch',
  });
  assert.equal(s.mode, 'classic', 'a fresh state is Classic Descent until a title row says otherwise');
  assert.deepEqual(s.enemies, []);
  // `buffer` remembers a press made while the sword was busy (§4.11).
  assert.deepEqual(s.attack, { st: 0, t: 0, hits: 0, buffer: 0 });
  // `best` and `progress` are live references into the mode's profile, not copies (§4.11).
  assert.equal(s.best, s.profiles.classic.best);
  assert.equal(s.progress, s.profiles.classic.progress);
  assert.deepEqual(s.offer, { open: false, level: 0, ids: [] });
  assert.deepEqual(s.marks, []);
  assert.equal(s.progress.purse, 0);
  assert.equal(s.perks.tankMult, 1, 'nothing unlocked on a clean profile');
  assert.equal(s.derived.exitDist, Infinity);
  assert.equal(s.derived.lowFuel, false);
  assert.deepEqual(s.events, []);
  assert.equal(s.settings.sensitivity, 1);
});

test('createInitialState: persisted settings and best are sanitised, never trusted', () => {
  const s = createInitialState(
    { volume: 99, sensitivity: -4, scanlines: 'yes', minimap: false, bogus: 1 },
    { score: '900', level: 4.9 },
  );
  assert.equal(s.settings.volume, 1, 'clamped into range');
  assert.equal(s.settings.sensitivity, 0.2, 'clamped into range');
  assert.equal(s.settings.scanlines, true, 'uncoercible value falls back to the default');
  assert.equal(s.settings.minimap, false, 'a legal value is kept');
  assert.equal(/** @type {any} */ (s.settings).bogus, undefined, 'unknown keys are dropped');
  assert.equal(s.best.score, 0, 'a non-number score is discarded');
  assert.equal(s.best.level, 4, 'a fractional level is floored');
});

// ─── Phase machine ───────────────────────────────────────────────────────────────────────────

test('phase machine: the full happy path, with a phase event on every transition', () => {
  const s = createInitialState();

  reducer(s, { type: 'newGame', seed: 42 });
  assert.equal(s.phase, 'loading');
  assert.deepEqual(s.events, [{ type: 'phase', from: 'title', to: 'loading' }]);
  assert.equal(s.seed, 42);

  reducer(s, { type: 'levelReady', data: level() });
  assert.equal(s.phase, 'playing');
  assert.equal(countEvents(s, 'phase'), 1);
  assert.equal(countEvents(s, 'levelStart'), 1);

  reducer(s, { type: 'pause' });
  assert.equal(s.phase, 'paused');
  reducer(s, { type: 'resume' });
  assert.equal(s.phase, 'playing');

  reducer(s, { type: 'debugWin' });
  assert.equal(s.phase, 'levelComplete');
  assert.equal(countEvents(s, 'levelComplete'), 1);

  reducer(s, { type: 'nextLevel' });
  assert.equal(s.phase, 'loading');
  assert.equal(s.level, 2);

  reducer(s, { type: 'levelReady', data: level() });
  assert.equal(s.phase, 'playing');
  assert.equal(s.run.levelTime, 0, 'the per-level timer restarted');

  reducer(s, { type: 'pause' });
  reducer(s, { type: 'toTitle' });
  assert.equal(s.phase, 'title');
});

test('phase machine: invalid actions are ignored in every phase', () => {
  /** @type {Array<{type:string}>} */
  const all = [
    { type: 'newGame', seed: 1 },
    { type: 'levelReady', data: level() },
    { type: 'pause' },
    { type: 'resume' },
    { type: 'nextLevel' },
    { type: 'toTitle' },
    { type: 'debugWin' },
  ];
  /** @type {Record<string, string[]>} */
  const legal = {
    title: ['newGame', 'levelReady'],
    loading: ['levelReady'],
    playing: ['pause', 'debugWin'],
    paused: ['newGame', 'resume', 'toTitle'],
    levelComplete: ['newGame', 'nextLevel', 'toTitle'],
    gameOver: ['newGame', 'toTitle'],
  };

  for (const phase of Object.keys(legal)) {
    for (const action of all) {
      const s = intoPhase(/** @type {any} */ (phase));
      const before = s.phase;
      reducer(s, action);
      const shouldChange = legal[phase].indexOf(action.type) >= 0;
      if (!shouldChange) {
        assert.equal(s.phase, before, `${action.type} must be ignored in ${phase}`);
        assert.equal(s.events.length, 0, `${action.type} in ${phase} must emit nothing`);
      }
    }
  }
});

/**
 * Drive a fresh state into the given phase.
 * @param {import('../core/types.js').Phase} phase
 * @returns {import('../core/types.js').GameState}
 */
function intoPhase(phase) {
  const s = createInitialState();
  if (phase === 'title') return s;
  reducer(s, { type: 'newGame', seed: 3 });
  if (phase === 'loading') return s;
  reducer(s, { type: 'levelReady', data: level() });
  if (phase === 'playing') return s;
  if (phase === 'paused') {
    reducer(s, { type: 'pause' });
    return s;
  }
  if (phase === 'levelComplete') {
    reducer(s, { type: 'debugWin' });
    return s;
  }
  // gameOver
  s.run.fuel = 0.001;
  ticks(s, 2);
  assert.equal(s.phase, 'gameOver');
  return s;
}

test('phase machine: levelReady in title installs the demo maze and keeps the phase', () => {
  const s = createInitialState();
  reducer(s, { type: 'levelReady', data: level() });
  assert.equal(s.phase, 'title');
  assert.notEqual(s.levelData, null);
  assert.equal(countEvents(s, 'phase'), 0);
  assert.equal(countEvents(s, 'levelStart'), 0);
  assert.equal(s.run.fuel, 0, 'the demo level does not start a run');
  // The attract camera now runs on ticks.
  const x0 = s.player.x;
  ticks(s, 60);
  assert.notEqual(s.player.x, x0, 'the attract camera moved');
  assert.ok(s.time > 0.9 && s.time < 1.1);
});

test('phase machine: malformed levelReady payloads are dropped, not installed', () => {
  const bad = [
    undefined,
    null,
    42,
    {},
    { maze: null },
    { maze: { width: 5, height: 3, tiles: new Uint8Array(4), start: {}, exit: {} }, items: [], torches: [] },
    { maze: { width: 0, height: 0, tiles: new Uint8Array(0), start: {}, exit: {} }, items: [], torches: [] },
    { maze: mazeFrom(CORRIDOR), items: 'nope', torches: [] },
    // start/exit must be in-bounds tiles: these would spawn the player at NaN or outside the map.
    { maze: { ...mazeFrom(CORRIDOR), start: {} }, items: [], torches: [] },
    { maze: { ...mazeFrom(CORRIDOR), start: { x: NaN, y: 1 } }, items: [], torches: [] },
    { maze: { ...mazeFrom(CORRIDOR), exit: { x: 99, y: 1 } }, items: [], torches: [] },
    { maze: { ...mazeFrom(CORRIDOR), exit: { x: '3', y: 1 } }, items: [], torches: [] },
    // An array of the wrong THINGS, not just the wrong type. `buildItemGrid` dereferences
    // `items[i].x` and the install loop writes `items[i].taken`, so each of these used to throw
    // out of the reducer *after* levelData/explored had already been swapped — leaving the state
    // half-installed with the malformed payload live as the loading-screen backdrop.
    { maze: mazeFrom(CORRIDOR), items: [null], torches: [] },
    { maze: mazeFrom(CORRIDOR), items: [5], torches: [] },
    { maze: mazeFrom(CORRIDOR), items: ['gem'], torches: [] },
    { maze: mazeFrom(CORRIDOR), items: [{ kind: 'oil', x: NaN, y: NaN }], torches: [] },
    { maze: mazeFrom(CORRIDOR), items: [{ kind: 'gem', x: 1.5, y: Infinity }], torches: [] },
    // No kind at all: `takeItem` used to treat anything that was not a gem as a flask.
    { maze: mazeFrom(CORRIDOR), items: [{ x: 1.5, y: 1.5 }], torches: [] },
    { maze: mazeFrom(CORRIDOR), items: [{ kind: 'bomb', x: 1.5, y: 1.5 }], torches: [] },
    { maze: mazeFrom(CORRIDOR), items: [], torches: [null] },
  ];
  for (const data of bad) {
    const s = createInitialState();
    reducer(s, { type: 'newGame', seed: 1 });
    // The contract is that the reducer is TOTAL: it must not throw, whatever it is handed.
    assert.doesNotThrow(() => reducer(s, { type: 'levelReady', data }));
    assert.equal(s.phase, 'loading', `payload ${JSON.stringify(data)} must be ignored`);
    assert.equal(s.levelData, null, 'and nothing may be half-installed');
    assert.equal(s.explored, null);
    assert.equal(s.run.fuelMax, 0);
  }
});

test('phase machine: a malformed levelReady never disturbs an installed level', () => {
  // The other half of totality: a bad payload arriving in `title` (the attract camera's demo maze)
  // must leave whatever is already installed exactly as it was.
  const s = createInitialState();
  reducer(s, { type: 'levelReady', data: level([item(1, 'gem', 2.5, 1.5)]) });
  const installed = s.levelData;
  const explored = s.explored;
  assert.notEqual(installed, null);
  assert.doesNotThrow(() =>
    reducer(s, { type: 'levelReady', data: { maze: mazeFrom(CORRIDOR), items: [null], torches: [] } }),
  );
  assert.equal(s.levelData, installed, 'the good level is still installed');
  assert.equal(s.explored, explored, 'and its explored buffer was not swapped');
});

test('phase machine: newGame resets the run and re-arms the record check', () => {
  const s = started();
  s.run.score = 4321;
  s.run.gems = 9;
  s.best.score = 1000;
  reducer(s, { type: 'pause' });
  reducer(s, { type: 'newGame', seed: 777 });
  assert.equal(s.phase, 'loading');
  assert.equal(s.level, 1);
  assert.equal(s.seed, 777);
  assert.equal(s.run.score, 0);
  assert.equal(s.run.gems, 0);
  assert.equal(s.run.totalTime, 0);
  assert.equal(s.best.score, 4321, 'the abandoned run was folded into the record before the reset');
  assert.equal(s.sim.runBestScore, 4321, 'and the new run measures newBest against that record');
});

test('best: quitting to the title from pause keeps the run\'s score in the record', () => {
  // Regression: toTitle used to leave `paused` without recordBest, so the points of a level the
  // player quit were never counted — and a run that had already beaten the record lost it.
  const s = createInitialState(undefined, { score: 150, level: 1 });
  reducer(s, { type: 'newGame', seed: 1 });
  reducer(s, { type: 'levelReady', data: level([item(1, 'gem', 1.5, 1.5), item(2, 'gem', 2.5, 1.5)], 100) });
  ticks(s, 1); // +100 on the start tile
  for (let i = 0; i < 40 && s.run.gems < 2; i++) ticks(s, 1, { moveY: 1 });
  assert.equal(s.run.gems, 2, 'both gems collected');
  assert.equal(s.run.score, 200);
  reducer(s, { type: 'pause' });
  reducer(s, { type: 'toTitle' });
  assert.equal(s.phase, 'title');
  assert.equal(s.best.score, s.run.score, 'best.score === run.score after the quit');
  assert.equal(s.best.level, 1);
});

test('best: quitting a worse run from pause leaves the record alone', () => {
  const s = createInitialState(undefined, { score: 99999, level: 7 });
  reducer(s, { type: 'newGame', seed: 1 });
  reducer(s, { type: 'levelReady', data: level([item(1, 'gem', 1.5, 1.5)], 100) });
  ticks(s, 1);
  reducer(s, { type: 'pause' });
  reducer(s, { type: 'toTitle' });
  assert.equal(s.best.score, 99999);
  assert.equal(s.best.level, 7);
});

test('best: best.level is the deepest level REACHED — dying on 2 after clearing 1 records 2', () => {
  // Pinned on purpose (sim.recordBest): a death folds in the level the run was on, the same number
  // a clear of that level records. The menus label it as depth reached.
  const s = createInitialState();
  reducer(s, { type: 'newGame', seed: 1 });
  reducer(s, { type: 'levelReady', data: level([], 100) });
  reducer(s, { type: 'debugWin' });
  assert.equal(s.best.level, 1, 'clearing level 1 records 1');
  reducer(s, { type: 'nextLevel' });
  reducer(s, { type: 'levelReady', data: level([], 100) });
  s.run.fuel = 1 / 120;
  collect(s, 5, {}, (st) => st.phase !== 'playing');
  assert.equal(s.phase, 'gameOver');
  assert.equal(s.best.level, 2, 'dying on level 2 records 2');
});

test('phase machine: a non-finite seed keeps the previous one rather than poisoning the run', () => {
  const a = createInitialState();
  reducer(a, { type: 'newGame', seed: 5 });
  assert.equal(a.seed, 5);

  const b = createInitialState();
  reducer(b, { type: 'newGame', seed: NaN });
  assert.equal(b.seed, 0, 'a NaN seed falls back to the current one (0 on a fresh state)');

  const c = createInitialState();
  reducer(c, { type: 'newGame', seed: 2 ** 33 + 9 });
  assert.equal(c.seed, 9, 'the seed is coerced to uint32');

  const d = createInitialState();
  reducer(d, /** @type {any} */ ({ type: 'newGame', seed: 'abc' }));
  assert.equal(d.seed, 0);
  assert.equal(d.phase, 'loading', 'a bad seed still starts the run');
});

// ─── tick ────────────────────────────────────────────────────────────────────────────────────

test('tick: dt is clamped, and a non-positive or garbage dt advances nothing', () => {
  const s = started();
  const t0 = s.time;
  reducer(s, { type: 'tick', dt: 5, input: frame() });
  assert.ok(Math.abs(s.time - (t0 + SIM.MAX_DT)) < 1e-12, 'a huge dt is clamped');
  const t1 = s.time;
  for (const dt of [0, -1, NaN, Infinity, '1/60', null, undefined]) {
    reducer(s, /** @type {any} */ ({ type: 'tick', dt, input: frame() }));
    assert.equal(s.time, t1, `dt=${String(dt)} must not advance time`);
  }
});

test('tick: a missing or garbage input frame is treated as no input', () => {
  const s = started();
  const x = s.player.x;
  for (const input of [undefined, null, 7, 'go', { moveY: 'fast', turn: NaN, lookDX: Infinity }]) {
    reducer(s, /** @type {any} */ ({ type: 'tick', dt: 1 / 60, input }));
  }
  assert.equal(s.player.x, x, 'nothing moved');
  assert.ok(Number.isFinite(s.player.angle));
});

test('tick: mouse yaw is clamped so a pointer-lock glitch cannot teleport the view', () => {
  const s = started();
  const a0 = s.player.angle;
  reducer(s, { type: 'tick', dt: 1 / 60, input: frame({ lookDX: 40 }) });
  const d = Math.abs(s.player.angle - a0);
  assert.ok(d <= SIM.MAX_LOOK_DX + 1e-9, `yaw delta ${d} was clamped`);
});

test('tick: frozen phases keep the interpolation snapshot in sync', () => {
  const s = started();
  ticks(s, 20, { moveY: 1 });
  reducer(s, { type: 'pause' });
  ticks(s, 10);
  assert.equal(s.player.px, s.player.x);
  assert.equal(s.player.py, s.player.y);
  assert.equal(s.player.pangle, s.player.angle);
  assert.ok(s.phaseTime > 0.15, 'phaseTime still advances while paused');
});

// ─── Scoring & pickups ───────────────────────────────────────────────────────────────────────

test('pickups: a gem scores 100 × level and counts toward the level total', () => {
  const s = started(level([item(1, 'gem', 1.5, 1.5), item(2, 'gem', 2.5, 1.5)]));
  assert.equal(s.run.gemsTotal, 2);
  ticks(s, 1);
  assert.equal(s.run.gems, 1, 'the gem under the player is collected');
  assert.equal(s.run.score, gemScore(1));
  assert.equal(countEvents(s, 'pickup'), 1);
  const e = /** @type {any} */ (s.events.find((x) => x.type === 'pickup'));
  assert.equal(e.kind, 'gem');
  assert.equal(e.value, 100);
  ticks(s, 1);
  assert.equal(countEvents(s, 'pickup'), 0, 'a collected gem is not collected twice');
});

test('pickups: score scales with level', () => {
  const s = started(level([item(1, 'gem', 1.5, 1.5)]));
  reducer(s, { type: 'debugWin' });
  reducer(s, { type: 'nextLevel' });
  reducer(s, { type: 'levelReady', data: level([item(1, 'gem', 1.5, 1.5)]) });
  assert.equal(s.level, 2);
  const before = s.run.score;
  ticks(s, 1);
  assert.equal(s.run.score - before, 200, 'a level-2 gem is worth 200');
});

test('pickups: oil refills fuel, capped at the tank, and re-arms the low-fuel cue', () => {
  const s = started(level([item(1, 'oil', 2.5, 1.5)], TANK1));
  s.run.fuel = 10; // below the 20 % warning line
  ticks(s, 1);
  assert.equal(s.derived.lowFuel, true);
  assert.equal(countEvents(s, 'lowFuel'), 1, 'the warning fires once on the way down');
  // Walk east onto the flask.
  ticks(s, 40, { moveY: 1 });
  assert.ok(s.run.fuel > 10, 'the flask refilled the torch');
  assert.ok(s.run.fuel <= s.run.fuelMax, 'never over-fills');
  assert.equal(s.derived.lowFuel, false);
  const expected = Math.min(TANK1, 10 + oilFuel(TANK1));
  assert.ok(Math.abs(s.run.fuel - (expected - s.run.levelTime)) < 1.5, 'restored the documented amount');
});

test('run stats: refuels count flasks per level, distance is the run odometer', () => {
  const s = started(level([item(1, 'oil', 2.5, 1.5)], 100));
  assert.equal(s.run.refuels, 0);
  assert.equal(s.run.distance, 0);
  s.run.fuel = 10; // so the flask is actually worth taking
  ticks(s, 40, { moveY: 1 });
  assert.equal(s.run.refuels, 1, 'one flask burned');
  assert.ok(s.run.distance > 0.5, `walked ${s.run.distance.toFixed(2)} tiles`);
  // The odometer measures distance *covered*, so it can never outrun the top speed × time.
  const ceiling = PLAYER.WALK_SPEED * s.run.levelTime;
  assert.ok(s.run.distance <= ceiling, 'the odometer cannot exceed top speed × time');

  // A new level resets the per-level tally but keeps the run odometer.
  const walked = s.run.distance;
  reducer(s, { type: 'debugWin' });
  reducer(s, { type: 'nextLevel' });
  reducer(s, { type: 'levelReady', data: level([item(1, 'oil', 2.5, 1.5)], 100) });
  assert.equal(s.run.refuels, 0, 'refuels are per level');
  assert.equal(s.run.distance, walked, 'distance is per run');

  // A new run resets both.
  reducer(s, { type: 'pause' });
  reducer(s, { type: 'newGame', seed: 7 });
  assert.equal(s.run.refuels, 0);
  assert.equal(s.run.distance, 0);
});

test('pickups: a flask is left on the floor when the tank is already full', () => {
  const s = started(level([item(1, 'oil', 1.5, 1.5)], 100));
  assert.equal(s.run.fuel, TANK1, 'level 1 is the lean first floor: its tank clamps the offer');
  ticks(s, 1);
  assert.equal(countEvents(s, 'pickup'), 0, 'not consumed for nothing');
  assert.equal(/** @type {any} */ (s.levelData).items[0].taken, false, 'still there to come back for');
  // Burn some fuel, walk back over it, and now it is worth taking.
  s.run.fuel = 40;
  const events = collect(s, 2);
  assert.equal(count(events, 'pickup'), 1);
  assert.ok(s.run.fuel > 40);
});

test('pickups: a near-full tank tops off from a flask, clamped to the tank', () => {
  // Playtest: "I cannot pick up oil and top off." Any room takes the flask (`FUEL.OIL_MIN_ROOM`); the
  // over-fill is lost, never stored past the tank.
  const flask = oilFuel(100);
  const s = started(level([item(1, 'oil', 1.5, 1.5)], 100));
  s.run.fuel = s.run.fuelMax * 0.9; // 10 s of headroom against a ~35 s flask
  const events = collect(s, 2);
  assert.equal(count(events, 'pickup'), 1, 'a 90 % tank still takes the flask');
  assert.equal(/** @type {any} */ (s.levelData).items[0].taken, true);
  assert.equal(s.run.refuels, 1);
  assert.ok(s.run.fuel <= s.run.fuelMax && s.run.fuel > s.run.fuelMax - 1, 'topped off to the brim, not past it');
  assert.ok(flask > 10, 'the flask was bigger than the room, so this really is a top-off');
});

test('pickups: an item with non-finite coordinates is never collected', () => {
  // `bucketOf` files a NaN-positioned item into bucket 0 — tiles 0…3 × 0…3, which is exactly where
  // the player spawns — and `NaN > pickupRadius²` is false, so the old "skip if outside" test
  // handed out a free refuel on the first frame of the level. Regression for sim.js collectAround.
  const s = started(level([item(1, 'gem', 2.5, 1.5)], 100));
  const items = /** @type {any[]} */ (/** @type {any} */ (s.levelData).items);
  items.push({ id: 2, kind: 'oil', x: NaN, y: NaN, taken: false });
  items.push({ id: 3, kind: 'gem', x: Infinity, y: 1.5, taken: false });
  // The reducer would now reject this payload outright (isLevelData validates elements), so the
  // grid is invalidated directly to reproduce the *sim-side* failure the guard comment claims is
  // impossible: a malformed item must cost one wasted comparison per step, nothing more.
  /** @type {any} */ (s).sim.gridFor = null;
  s.run.fuel = 10;
  const score = s.run.score;
  ticks(s, 60);
  assert.ok(s.run.fuel < 10, 'the torch burned down; nothing refilled it');
  assert.equal(s.run.refuels, 0, 'the NaN flask was not consumed');
  assert.equal(s.run.score, score, 'the Infinity gem scored nothing');
  assert.equal(items[1].taken, false);
  assert.equal(items[2].taken, false);
});

// ─── Map scroll (ARCHITECTURE.md §4.8) ───────────────────────────────────────────────────────

test('map scroll: levelReady locks the map only when the level has a scroll', () => {
  const withMap = started(level([item(1, 'gem', 2.5, 1.5), item(2, 'map', 3.5, 1.5)]));
  assert.equal(withMap.phase, 'playing', 'a map item is valid level data');
  assert.equal(withMap.run.mapFound, false, 'a level with a scroll starts locked');
  assert.equal(withMap.run.gemsTotal, 1, 'the scroll never counts toward gemsTotal');

  const without = started(level([item(1, 'gem', 2.5, 1.5)]));
  assert.equal(without.run.mapFound, true, 'no scroll → the map is never locked');

  // A new level re-decides from its own items, and newGame re-locks until that decision.
  without.run.mapFound = true;
  reducer(without, { type: 'debugWin' });
  reducer(without, { type: 'nextLevel' });
  reducer(without, { type: 'levelReady', data: level([item(1, 'map', 2.5, 1.5)]) });
  assert.equal(without.run.mapFound, false, 'the next level with a scroll locks it again');
  reducer(without, { type: 'pause' });
  reducer(without, { type: 'newGame', seed: 3 });
  assert.equal(without.run.mapFound, false, 'newGame resets it (false: no spurious MAP FOUND delta)');
  reducer(without, { type: 'levelReady', data: level([]) });
  assert.equal(without.run.mapFound, true);
});

test('map scroll: picking it up unlocks the map, emits a pickup, and scores nothing', () => {
  const s = started(level([item(1, 'map', 1.5, 1.5)]));
  assert.equal(s.run.mapFound, false);
  const score = s.run.score;
  ticks(s, 1);
  assert.equal(s.run.mapFound, true, 'the scroll under the player is taken');
  assert.equal(/** @type {any} */ (s.levelData).items[0].taken, true);
  const e = /** @type {any} */ (s.events.find((x) => x.type === 'pickup'));
  assert.deepEqual(e, { type: 'pickup', kind: 'map', x: 1.5, y: 1.5, value: 0 });
  assert.equal(s.run.score, score, 'no score');
  assert.equal(s.run.gems, 0, 'not a gem');
  assert.equal(s.run.bestCombo, 0, 'no combo');
  ticks(s, 1);
  assert.equal(countEvents(s, 'pickup'), 0, 'taken once');
});

test('map scroll: a full tank does not leave the scroll on the floor', () => {
  const s = started(level([item(1, 'map', 1.5, 1.5)], 100));
  assert.equal(s.run.fuel, s.run.fuelMax);
  ticks(s, 1);
  assert.equal(s.run.mapFound, true);
});

test('map scroll: the title demo maze accepts a scroll and the attract camera never takes it', () => {
  const s = createInitialState();
  reducer(s, { type: 'levelReady', data: level([item(1, 'map', 2.5, 1.5)]) });
  assert.equal(s.phase, 'title');
  assert.notEqual(s.levelData, null);
  for (let i = 0; i < 600; i++) reducer(s, { type: 'tick', dt: 1 / 60, input: frame() });
  assert.equal(/** @type {any} */ (s.levelData).items[0].taken, false, 'attract mode does not collect');
  assert.ok(Number.isFinite(s.player.x) && Number.isFinite(s.player.y));
});

test('map scroll: a misspelt kind is still rejected', () => {
  for (const kind of ['Map', 'scroll', 'maps', '']) {
    const s = createInitialState();
    reducer(s, { type: 'newGame', seed: 1 });
    reducer(s, { type: 'levelReady', data: { ...level(), items: [{ id: 1, kind, x: 1.5, y: 1.5 }] } });
    assert.equal(s.phase, 'loading', `kind ${JSON.stringify(kind)} must be rejected`);
    assert.equal(s.levelData, null);
  }
});

test('levelReady: the tank is the state module’s number, never the maze’s', () => {
  // `src/maze/populate.js` still derives a *path-sized* budget, which on a 128×128 maze is several
  // times the tank. A tank that scaled with the maze would undo the whole torch economy, so
  // `resolveTank` clamps it (ARCHITECTURE.md §4.4 fuel seam).
  const big = started(level([], 9999));
  assert.equal(big.run.fuelMax, levelParams(1).fuelSeconds, 'an oversized offer is clamped');
  assert.equal(big.run.fuel, big.run.fuelMax, 'and the torch starts full');
  const small = started(level([], 40));
  assert.equal(small.run.fuelMax, 40, 'a smaller offer (demo, tutorial, fixture) is honoured');
  const junk = started(level([], /** @type {any} */ ('lots')));
  assert.equal(junk.run.fuelMax, levelParams(1).fuelSeconds, 'garbage falls back to the tank');
});

test('fuel: past the size cap the torch burns faster instead of the maze growing', () => {
  const shallow = started(level([], 200));
  const deep = createInitialState();
  reducer(deep, { type: 'newGame', seed: 3 });
  deep.level = CAP_LEVEL + 10;
  reducer(deep, { type: 'levelReady', data: level([], 200) });
  assert.equal(deep.run.fuelMax, FUEL.TANK_END, 'the tank stopped growing at the cap');

  ticks(shallow, 60);
  ticks(deep, 60);
  const usedShallow = shallow.run.fuelMax - shallow.run.fuel;
  const usedDeep = deep.run.fuelMax - deep.run.fuel;
  const expected = drainRate(CAP_LEVEL + 10);
  assert.ok(Math.abs(usedShallow - 1) < 0.02, `level 1 burns 1 s/s (${usedShallow})`);
  assert.ok(
    Math.abs(usedDeep - expected) < 0.02,
    `level ${CAP_LEVEL + 10} burns ${expected} s/s (${usedDeep})`,
  );
});

test('pickups: hundreds of items along one corridor are every one collected', () => {
  // The pickup test is a bucket-grid query now (4-tile buckets), so the case that matters is an
  // item sitting right on a bucket seam. A 57-tile corridor crosses fourteen of them.
  const wide = 60;
  const row = `#S${'.'.repeat(wide - 4)}E#`;
  const items = [];
  for (let x = 2; x < wide - 2; x++) items.push(item(x, x % 2 === 0 ? 'gem' : 'oil', x + 0.5, 1.5));
  const s = started(level(items, 100, ['#'.repeat(wide), row, '#'.repeat(wide)]));
  s.run.fuel = 1; // keep the tank empty so every flask is worth taking
  assert.equal(s.run.gemsTotal, items.filter((i) => i.kind === 'gem').length);
  for (let i = 0; i < 2000 && s.phase === 'playing'; i++) {
    s.run.fuel = Math.min(s.run.fuelMax * 0.3, s.run.fuel);
    ticks(s, 1, { moveY: 1 });
  }
  assert.equal(s.phase, 'levelComplete', 'the player walked the whole corridor');
  const missed = /** @type {any} */ (s.levelData).items.filter((/** @type {any} */ it) => !it.taken);
  assert.deepEqual(
    missed.map((/** @type {any} */ it) => it.x),
    [],
    'every item on the route was picked up',
  );
  assert.equal(s.run.gems, s.run.gemsTotal);
});

test('lowFuel: fires exactly once per crossing, with hysteresis on the way back up', () => {
  const s = started(level([], 100));
  s.run.fuel = 21;
  const first = collect(s, 300, {}, (st) => st.phase !== 'playing');
  assert.equal(count(first, 'lowFuel'), 1, 'one warning, not one per frame');

  // Refill above the re-arm line and drain again: it must fire a second time.
  // (The first drain ran the tank dry, so the run is revived by hand here.)
  s.run.fuel = s.run.fuelMax * (FUEL.REARM_FRACTION + 0.05);
  s.phase = 'playing';
  const second = collect(s, 1200, {}, (st) => st.phase !== 'playing');
  assert.equal(count(second, 'lowFuel'), 1, 're-armed after a refill');

  // And it stays quiet while hovering just above the line.
  s.run.fuel = s.run.fuelMax * FUEL.LOW_FRACTION + 0.01;
  s.derived.lowFuel = false;
  const third = collect(s, 3, {});
  assert.ok(count(third, 'lowFuel') <= 1);
});

test('fuel: running out ends the run and records the best score once', () => {
  const s = started(level([item(1, 'gem', 1.5, 1.5)], 100));
  ticks(s, 1); // collect the gem: 100 points
  s.run.fuel = 1 / 30;
  const events = collect(s, 5, {}, (st) => st.phase !== 'playing');
  assert.equal(s.phase, 'gameOver');
  const over = /** @type {any} */ (events.find((e) => e.type === 'gameOver'));
  assert.ok(over, 'a gameOver event was emitted');
  assert.equal(over.score, s.run.score);
  assert.equal(over.newBest, true);
  assert.equal(s.best.score, 100);
  assert.equal(s.best.level, 1);
  assert.equal(count(events, 'gameOver'), 1, 'exactly one gameOver');
  // Nothing more happens once the run is over.
  const after = collect(s, 30);
  assert.equal(count(after, 'gameOver'), 0);
  assert.equal(s.phase, 'gameOver');
});

test('fuel: there is no sprint — walking and standing burn the same torch, and a stale flag is ignored', () => {
  const LONG = ['#########', '#S.....E#', '#########'];
  const walk = started(level([], 100, LONG));
  const legacy = started(level([], 100, LONG));
  const still = started(level([], 100, LONG));
  ticks(walk, 60, { moveY: 1 });
  ticks(legacy, 60, { moveY: 1, sprint: true });
  ticks(still, 60, {});
  const usedWalk = walk.run.fuelMax - walk.run.fuel;
  const usedLegacy = legacy.run.fuelMax - legacy.run.fuel;
  const usedStill = still.run.fuelMax - still.run.fuel;
  assert.ok(Math.abs(usedWalk - 1) < 0.02, `walking burned ${usedWalk} s`);
  assert.ok(Math.abs(usedStill - 1) < 0.02, `standing burned ${usedStill} s`);
  assert.ok(Math.abs(usedLegacy - usedWalk) < 1e-9, 'an old frame carrying sprint:true changes nothing');
  assert.ok(Math.abs(legacy.player.x - walk.player.x) < 1e-9, 'nor the speed');
});

test('exit: reaching the portal completes the level with the contract bonus', () => {
  const s = started(level([], 100));
  // Walk east down the corridor to the exit at tile (3,1).
  for (let i = 0; i < 200 && s.phase === 'playing'; i++) ticks(s, 1, { moveY: 1 });
  assert.equal(s.phase, 'levelComplete');
  const done = /** @type {any} */ (s.events.find((e) => e.type === 'levelComplete'));
  assert.equal(done.level, 1);
  assert.equal(done.bonus, levelBonus(1, s.run.fuel));
  assert.equal(s.run.levelScore, done.bonus);
  assert.equal(s.run.score, done.bonus);
  assert.ok(done.bonus >= SCORE.CLEAR_BASE, 'at least the flat clear bonus');
});

test('exit: arriving on the frame the torch dies is a win, not a loss', () => {
  const s = started(level([], 100));
  s.player.x = 3.5 - 0.1;
  s.player.y = 1.5;
  s.run.fuel = 1 / 120;
  ticks(s, 1, { moveY: 1 });
  assert.equal(s.phase, 'levelComplete');
});

test('best: newBest is measured against the record the run started with', () => {
  const s = createInitialState(undefined, { score: 50, level: 1 });
  reducer(s, { type: 'newGame', seed: 1 });
  reducer(s, { type: 'levelReady', data: level([item(1, 'gem', 1.5, 1.5)], 100) });
  ticks(s, 1); // +100 → 100 > 50
  reducer(s, { type: 'debugWin' }); // records the best mid-run
  assert.ok(s.best.score > 50);
  reducer(s, { type: 'nextLevel' });
  reducer(s, { type: 'levelReady', data: level([], 100) });
  s.run.fuel = 1 / 120;
  const events = collect(s, 5, {}, (st) => st.phase !== 'playing');
  assert.equal(s.phase, 'gameOver');
  const over = /** @type {any} */ (events.find((e) => e.type === 'gameOver'));
  assert.equal(over.newBest, true, 'the run beat the record it started with');
  assert.equal(s.best.level, 2);
});

test('best: a worse run does not claim a new record', () => {
  const s = createInitialState(undefined, { score: 100000, level: 9 });
  reducer(s, { type: 'newGame', seed: 1 });
  reducer(s, { type: 'levelReady', data: level([], 100) });
  s.run.fuel = 1 / 120;
  const events = collect(s, 5, {}, (st) => st.phase !== 'playing');
  const over = /** @type {any} */ (events.find((e) => e.type === 'gameOver'));
  assert.equal(over.newBest, false);
  assert.equal(s.best.score, 100000);
  assert.equal(s.best.level, 9);
});

test('combo: consecutive gems raise bestCombo but never the score', () => {
  const s = started(
    level([item(1, 'gem', 1.5, 1.5), item(2, 'gem', 2.5, 1.5), item(3, 'gem', 3.5, 1.5)], 100, [
      '#########',
      '#S.....E#',
      '#########',
    ]),
  );
  for (let i = 0; i < 200 && s.phase === 'playing'; i++) ticks(s, 1, { moveY: 1 });
  assert.equal(s.run.gems, 3);
  assert.ok(s.run.bestCombo >= 2, `combo reached ${s.run.bestCombo}`);
  // Score is exactly 3 gems + the clear bonus — the combo must not multiply anything.
  assert.equal(s.run.score, 3 * gemScore(1) + s.run.levelScore);
});

// ─── Settings ────────────────────────────────────────────────────────────────────────────────

test('setSetting: validates, clamps and ignores nonsense in every phase', () => {
  const s = createInitialState();
  reducer(s, { type: 'setSetting', key: 'volume', value: 0.3 });
  assert.equal(s.settings.volume, 0.3);
  reducer(s, { type: 'setSetting', key: 'volume', value: 12 });
  assert.equal(s.settings.volume, 1, 'clamped up');
  reducer(s, { type: 'setSetting', key: 'sensitivity', value: -5 });
  assert.equal(s.settings.sensitivity, 0.2, 'clamped down');
  reducer(s, { type: 'setSetting', key: 'sensitivity', value: NaN });
  assert.equal(s.settings.sensitivity, 0.2, 'NaN is ignored');
  reducer(s, { type: 'setSetting', key: 'scanlines', value: 0 });
  assert.equal(s.settings.scanlines, false, 'numeric booleans are accepted');
  reducer(s, { type: 'setSetting', key: 'scanlines', value: 'off' });
  assert.equal(s.settings.scanlines, false, 'a string is ignored, not coerced');
  // The three-state map is an enum: only a listed value is taken, and anything else leaves the
  // setting exactly where it was rather than snapping it back to the default.
  assert.equal(s.settings.mapMode, 'corner', 'factory default');
  reducer(s, { type: 'setSetting', key: 'mapMode', value: 'full' });
  assert.equal(s.settings.mapMode, 'full');
  reducer(s, { type: 'setSetting', key: 'mapMode', value: 'sideways' });
  assert.equal(s.settings.mapMode, 'full', 'an unlisted enum value is ignored');
  reducer(s, /** @type {any} */ ({ type: 'setSetting', key: 'mapMode', value: 1 }));
  assert.equal(s.settings.mapMode, 'full', 'a non-string enum value is ignored');
  reducer(s, { type: 'setSetting', key: 'mapMode', value: 'off' });
  assert.equal(s.settings.mapMode, 'off');
  reducer(s, /** @type {any} */ ({ type: 'setSetting', key: 'hack', value: 1 }));
  assert.equal(/** @type {any} */ (s.settings).hack, undefined);
  reducer(s, /** @type {any} */ ({ type: 'setSetting', key: 42, value: 1 }));
  reducer(s, /** @type {any} */ ({ type: 'setSetting' }));
  assert.equal(Object.keys(s.settings).length, 10);
});

test('setSetting: fullscreen defaults on and takes only boolean-shaped values', () => {
  const s = createInitialState();
  assert.equal(s.settings.fullscreen, true, 'factory default: an embed goes fullscreen');
  reducer(s, { type: 'setSetting', key: 'fullscreen', value: false });
  assert.equal(s.settings.fullscreen, false);
  for (const junk of ['on', 'true', null, undefined, 2, {}]) {
    reducer(s, /** @type {any} */ ({ type: 'setSetting', key: 'fullscreen', value: junk }));
    assert.equal(s.settings.fullscreen, false, `${String(junk)} is ignored, not coerced`);
  }
  reducer(s, { type: 'setSetting', key: 'fullscreen', value: true });
  assert.equal(s.settings.fullscreen, true);
  // A persisted blob from before the setting existed restores the default rather than `undefined`.
  const old = createInitialState(/** @type {any} */ ({ volume: 0.5 }));
  assert.equal(old.settings.fullscreen, true);
});

// ─── Events ──────────────────────────────────────────────────────────────────────────────────

test('events: cleared at the start of every dispatch, array identity preserved', () => {
  const s = started();
  const ref = s.events;
  reducer(s, { type: 'pause' });
  assert.equal(s.events.length, 1);
  assert.equal(s.events, ref, 'the array identity never changes');
  reducer(s, { type: 'setSetting', key: 'minimap', value: false });
  assert.equal(s.events.length, 0, 'a new action clears the previous events');
  assert.equal(s.events, ref);
});

// ─── Determinism & robustness ────────────────────────────────────────────────────────────────

test('determinism: the same seed and inputs produce a bit-identical state', () => {
  /** @returns {import('../core/types.js').GameState} */
  const run = () => {
    const s = createInitialState();
    reducer(s, { type: 'newGame', seed: 20240607 });
    reducer(s, {
      type: 'levelReady',
      data: level([item(1, 'gem', 4.5, 1.5), item(2, 'oil', 6.5, 1.5)], 80, [
        '#########',
        '#S.....E#',
        '#########',
      ]),
    });
    for (let i = 0; i < 600; i++) {
      const phase = i / 37;
      reducer(s, {
        type: 'tick',
        dt: 1 / 60,
        input: frame({
          moveY: Math.sin(phase) > 0 ? 1 : -1,
          moveX: Math.cos(phase * 0.7),
          turn: Math.sin(phase * 1.3),
          lookDX: Math.sin(phase * 2.1) * 0.02,
          chalk: i % 11 === 0,
        }),
      });
    }
    return s;
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.player, b.player);
  assert.deepEqual(a.run, b.run);
  assert.deepEqual(a.derived, b.derived);
  assert.equal(a.phase, b.phase);
  assert.deepEqual([...(/** @type {Uint8Array} */ (a.explored))], [...(/** @type {Uint8Array} */ (b.explored))]);
});

test('reducer: never throws, whatever it is handed', () => {
  const s = started();
  /** @type {unknown[]} */
  const garbage = [
    undefined,
    null,
    0,
    '',
    'tick',
    [],
    {},
    { type: 1 },
    { type: null },
    { type: 'tick' },
    { type: 'tick', dt: {}, input: [] },
    { type: 'newGame', seed: {} },
    { type: 'levelReady' },
    { type: 'levelReady', data: { maze: { width: 'a' } } },
    { type: 'setSetting', key: Symbol.iterator },
    { type: '__proto__' },
    { type: 'constructor' },
    Object.create(null),
    new Date(),
  ];
  for (let i = 0; i < garbage.length; i++) {
    const g = garbage[i];
    assert.doesNotThrow(() => reducer(s, /** @type {any} */ (g)), `threw for garbage[${i}]`);
  }
  assert.equal(s.phase, 'playing');
  assert.ok(Number.isFinite(s.player.x));
  // A prototype-polluting action type must not have created anything.
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
});

test('reducer: a whole simulated run stays finite and in bounds', () => {
  const s = createInitialState();
  reducer(s, { type: 'newGame', seed: 5 });
  reducer(s, {
    type: 'levelReady',
    data: level([], 20, ['#########', '#S.#...##', '#.##.#..#', '#....#.E#', '#########']),
  });
  for (let i = 0; i < 3000; i++) {
    reducer(s, {
      type: 'tick',
      dt: 1 / 60,
      input: frame({ moveY: 1, turn: Math.sin(i / 23) }),
    });
    assert.ok(Number.isFinite(s.player.x) && Number.isFinite(s.player.y));
    assert.ok(s.player.x > 0 && s.player.x < 9 && s.player.y > 0 && s.player.y < 5);
    assert.ok(s.run.fuel >= 0);
    assert.ok(s.player.bob >= 0 && s.player.bob < Math.PI * 2);
    assert.ok(s.player.shake >= 0 && s.player.shake <= 1);
  }
  assert.ok(['playing', 'levelComplete', 'gameOver'].indexOf(s.phase) >= 0);
});
