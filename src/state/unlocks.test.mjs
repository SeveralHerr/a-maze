// @ts-check
/**
 * @file The unlocks wave (ARCHITECTURE.md §4.9): the catalogue, perks, the Shrine and Boon actions,
 * and every perk's effect in the sim — including the ones that must NOT happen (a magnet through a
 * wall, a boon twice for one depth, a purchase mid-level).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE } from '../maze/constants.js';
import { createInitialState, reducer } from './game.js';
import { RETIRED_UNLOCK_COSTS,
  BOON_CHOICES,
  SIPHON,
  UNLOCKS,
  UNLOCK_FX,
  UNLOCK_IDS,
  WORLD,
  computePerks,
  defaultProgress,
  drainRate,
  levelParams,
  oilFuel,
  sanitizeProgress,
  unlockCost,
} from './balance.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {string[]} rows '#' wall, 'S' start, 'E' exit
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
  return { width, height, cols: (width - 1) >> 1, rows: (height - 1) >> 1, tiles, start, exit, seed: 7 };
}

const LONG = ['###########', '#S.......E#', '###########'];

/**
 * @param {any[]} items
 * @param {string[]} [rows]
 * @returns {import('../core/types.js').LevelData}
 */
function level(items, rows = LONG) {
  return /** @type {any} */ ({
    maze: mazeFrom(rows),
    validation: { solvable: true, fullyConnected: true, bordersSealed: true, pathLength: 3, floorCount: 3, deadEnds: 0, loops: 0, path: null, errors: [] },
    items,
    torches: [],
    fuel: 999,
    par: 40,
  });
}

/** @param {number} id @param {string} kind @param {number} x @param {number} y */
function item(id, kind, x, y) {
  return { id, kind, x, y, taken: false };
}

/** @param {object} [o] */
function frame(o = {}) {
  return /** @type {any} */ ({ moveX: 0, moveY: 0, turn: 0, lookDX: 0, pressed: new Set(), ...o });
}

/**
 * A run on `data` with the given ranks owned.
 * @param {any} data
 * @param {Record<string, number>} [ranks]
 * @param {number} [purse]
 */
function started(data, ranks = {}, purse = 0) {
  const s = createInitialState(undefined, undefined, { purse, ranks, boonLevel: 0 });
  reducer(s, { type: 'newGame', seed: 4242 });
  reducer(s, { type: 'levelReady', data });
  return s;
}

/**
 * Start a level with perk values set directly — for the retired map unlocks, whose effects stay
 * wired but which no rank can reach any more (RETIRED_UNLOCK_COSTS).
 * @param {any} data @param {Record<string, number>} perks @returns {any}
 */
function startedWithPerks(data, perks) {
  const s = started(data);
  Object.assign(s.perks, perks);
  // `levelReady` already swept the reveal window at the base radius; forget it so the next step
  // sweeps again with the perk in force.
  s.sim.revealCursor = 0;
  s.sim.revealSeen = 0;
  s.sim.revealX = -1e9;
  s.sim.revealY = -1e9;
  return s;
}

/** @param {any} s @param {number} n @param {object} [inp] @returns {any[]} */
function run(s, n, inp = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    reducer(s, { type: 'tick', dt: 1 / 60, input: frame(inp) });
    out.push(...s.events);
  }
  return out;
}

// ─── Catalogue ───────────────────────────────────────────────────────────────────────────────

test('catalogue: every unlock has a price and a description per rank, and an effect table to match', () => {
  assert.equal(UNLOCKS.length, 11);
  for (const id of Object.keys(RETIRED_UNLOCK_COSTS)) assert.equal(UNLOCK_IDS.includes(id), false, `${id} is retired`);
  const ids = new Set();
  for (const u of UNLOCKS) {
    assert.ok(!ids.has(u.id), `unique id ${u.id}`);
    ids.add(u.id);
    assert.equal(u.costs.length, u.max);
    assert.equal(u.ranks.length, u.max);
    for (let r = 1; r < u.costs.length; r++) assert.ok(u.costs[r] > u.costs[r - 1], `${u.id} prices climb`);
    const fx = /** @type {any} */ (UNLOCK_FX)[u.id];
    assert.ok(Array.isArray(fx), `${u.id} has an effect table`);
    assert.equal(fx.length, u.max + 1, `${u.id}: one effect per rank plus the unowned value`);
    assert.ok(['torch', 'sight', 'fortune'].includes(u.group));
  }
  assert.deepEqual([...UNLOCK_IDS], UNLOCKS.map((u) => u.id));
  assert.ok(UNLOCK_FX.magnet[UNLOCK_FX.magnet.length - 1] <= 2, 'the magnet stays inside the 3×3 bucket bound');
  assert.equal(unlockCost('reservoir', 0), 15);
  assert.equal(unlockCost('wideFlame', 3), Infinity, 'a maxed unlock has no next price');
  assert.equal(unlockCost('lodestone', 0), Infinity, 'a retired unlock cannot be bought');
  assert.equal(unlockCost('nope', 0), Infinity);
});

test('perks: nothing owned is the base game; every rank only ever adds slack', () => {
  const base = computePerks(null);
  assert.deepEqual(base, computePerks({}));
  assert.equal(base.tankMult, 1);
  assert.equal(base.oilMult, 1);
  assert.equal(base.drainMult, 1);
  assert.equal(base.reveal, WORLD.REVEAL_RADIUS);
  assert.equal(base.gemPurse, 1);
  const maxed = computePerks(Object.fromEntries(UNLOCKS.map((u) => [u.id, u.max])));
  assert.ok(maxed.tankMult >= base.tankMult && maxed.oilMult >= base.oilMult && maxed.drainMult <= base.drainMult);
  assert.ok(maxed.emberSeconds > 0 && maxed.siphonCap > 0 && maxed.chalk > 0 && maxed.magnet > 0);
  const clamped = computePerks({ reservoir: 99, slowWick: -3, chalk: NaN });
  assert.equal(clamped.tankMult, UNLOCK_FX.reservoir[5], 'an out-of-range rank clamps to the table');
  assert.equal(clamped.drainMult, 1);
  assert.equal(clamped.chalk, 0);
});

test('progress: ranks of a retired map unlock are refunded once and dropped', () => {
  const p = sanitizeProgress({ purse: 7, ranks: { cartographer: 2, scrollSense: 1, lodestone: 5, chalk: 1 }, boonLevel: 0 });
  assert.equal(p.purse, 7 + 30 + 80 + 15 + 150, 'every paid rank comes back, clamped to what existed');
  assert.equal(/** @type {any} */ (p.ranks).cartographer, undefined);
  assert.equal(/** @type {any} */ (p.ranks).lodestone, undefined);
  assert.equal(p.ranks.chalk, 1);
  assert.equal(sanitizeProgress(p).purse, p.purse, 'sanitising the result again refunds nothing');
});

test('progress: persisted progress is sanitised, never trusted', () => {
  const p = sanitizeProgress({ purse: -5, ranks: { reservoir: 3.7, wideFlame: 9, bogus: 4, chalk: 'x' }, boonLevel: 2.5 });
  assert.equal(p.purse, 0);
  assert.equal(p.ranks.reservoir, 3);
  assert.equal(p.ranks.wideFlame, 3, 'clamped to the unlock max');
  assert.equal(/** @type {any} */ (p.ranks).bogus, undefined);
  assert.equal(p.ranks.chalk, 0);
  assert.equal(p.boonLevel, 2);
  assert.deepEqual(sanitizeProgress('garbage'), defaultProgress());
});

// ─── Shrine ──────────────────────────────────────────────────────────────────────────────────

test('shrine: buying spends the purse, raises the rank and the perks, and emits unlock', () => {
  const s = createInitialState(undefined, undefined, { purse: 50, ranks: {}, boonLevel: 0 });
  // The Shrine is no longer open from the title (§4.11): it lives inside a mode now, so a purchase
  // made before a mode was chosen would spend whichever purse happened to be live. Game over is one
  // of the two screens it IS open from.
  s.phase = 'gameOver';
  reducer(s, { type: 'buyUnlock', id: 'reservoir' });
  assert.equal(s.progress.purse, 35);
  assert.equal(s.progress.ranks.reservoir, 1);
  assert.equal(s.perks.tankMult, UNLOCK_FX.reservoir[1]);
  assert.deepEqual(s.events, [{ type: 'unlock', id: 'reservoir', rank: 1, boon: false }]);
  reducer(s, { type: 'buyUnlock', id: 'reservoir' });
  assert.equal(s.progress.purse, 5);
  reducer(s, { type: 'buyUnlock', id: 'reservoir' });
  assert.equal(s.progress.ranks.reservoir, 2, 'a purse that cannot pay buys nothing');
  assert.equal(s.events.length, 0);
  reducer(s, { type: 'buyUnlock', id: 'constructor' });
  reducer(s, { type: 'buyUnlock', id: 42 });
  assert.equal(s.progress.purse, 5, 'garbage ids are ignored');
});

test('shrine: closed mid-level, and a maxed unlock cannot be bought again', () => {
  const s = started(level([]), {}, 1000);
  reducer(s, { type: 'buyUnlock', id: 'chalk' });
  assert.equal(s.progress.ranks.chalk, 0, 'no purchases while playing');
  reducer(s, { type: 'pause' });
  reducer(s, { type: 'buyUnlock', id: 'chalk' });
  assert.equal(s.progress.ranks.chalk, 0, 'nor while paused');
  const t = createInitialState(undefined, undefined, { purse: 1000, ranks: { wideFlame: 3 }, boonLevel: 0 });
  reducer(t, { type: 'buyUnlock', id: 'wideFlame' });
  assert.equal(t.progress.purse, 1000);
});

// ─── Boons ───────────────────────────────────────────────────────────────────────────────────

test('boon: a new record depth offers three distinct unlocks; claiming one is free and closes it', () => {
  const s = started(level([]));
  reducer(s, { type: 'debugWin' });
  assert.equal(s.phase, 'levelComplete');
  assert.equal(s.offer.open, true);
  assert.equal(s.offer.level, 1);
  assert.equal(s.offer.ids.length, BOON_CHOICES);
  assert.equal(new Set(s.offer.ids).size, BOON_CHOICES, 'distinct');
  reducer(s, { type: 'claimBoon', id: 'not-offered' });
  assert.equal(s.offer.open, true, 'only an offered id can be claimed');
  const pick = s.offer.ids[1];
  reducer(s, { type: 'claimBoon', id: pick });
  assert.equal(s.progress.ranks[pick], 1);
  assert.equal(s.progress.purse, 0, 'a boon costs nothing');
  assert.equal(s.progress.boonLevel, 1);
  assert.equal(s.offer.open, false);
  assert.deepEqual(s.events, [{ type: 'unlock', id: pick, rank: 1, boon: true }]);
  reducer(s, { type: 'claimBoon', id: s.offer.ids[0] });
  assert.equal(s.progress.ranks[s.offer.ids[0]], 0, 'one claim per offer');
});

test('boon: a depth already boon-ed offers nothing; a forfeited boon is offered again later', () => {
  const s = started(level([]));
  reducer(s, { type: 'debugWin' });
  reducer(s, { type: 'nextLevel' });
  assert.equal(s.offer.open, false, 'descending closes the offer');
  assert.equal(s.progress.boonLevel, 0, 'forfeited, not banked');
  reducer(s, { type: 'levelReady', data: level([]) });
  reducer(s, { type: 'debugWin' });
  assert.equal(s.offer.open, true, 'level 2 is also a new record depth');
  reducer(s, { type: 'claimBoon', id: s.offer.ids[0] });
  assert.equal(s.progress.boonLevel, 2);

  // A new run: clearing levels 1 and 2 again offers nothing, the boon record carries.
  reducer(s, { type: 'newGame', seed: 1 });
  reducer(s, { type: 'levelReady', data: level([]) });
  reducer(s, { type: 'debugWin' });
  assert.equal(s.offer.open, false);
});

test('boon: the same run seed is offered the same unlocks; nothing to offer when everything is maxed', () => {
  const a = started(level([]));
  const b = started(level([]));
  reducer(a, { type: 'debugWin' });
  reducer(b, { type: 'debugWin' });
  assert.deepEqual(a.offer.ids, b.offer.ids);
  const maxed = Object.fromEntries(UNLOCKS.map((u) => [u.id, u.max]));
  const c = started(level([]), maxed);
  reducer(c, { type: 'debugWin' });
  assert.equal(c.offer.open, false);
});

// ─── Perks in the sim ────────────────────────────────────────────────────────────────────────

test('perks: Reservoir raises the tank, Slow Wick lowers the drain, Rich Oil prices off the base tank', () => {
  const base = started(level([]));
  const buffed = started(level([]), { reservoir: 5, slowWick: 4, richOil: 4 });
  const tank = levelParams(1).fuelSeconds;
  assert.equal(base.run.fuelMax, tank);
  assert.equal(buffed.run.fuelMax, Math.round(tank * UNLOCK_FX.reservoir[5]));
  run(base, 60);
  run(buffed, 60);
  const burnBase = base.run.fuelMax - base.run.fuel;
  const burnBuffed = buffed.run.fuelMax - buffed.run.fuel;
  assert.ok(Math.abs(burnBuffed - burnBase * UNLOCK_FX.slowWick[4]) < 1e-6, `burn ${burnBuffed} vs ${burnBase}`);
  assert.equal(buffed.sim.drain, drainRate(1) * UNLOCK_FX.slowWick[4]);

  const oil = started(level([item(1, 'oil', 2.5, 1.5)]), { reservoir: 5, richOil: 4 });
  oil.run.fuel = 10;
  run(oil, 30, { moveY: 1 });
  const gained = oil.run.fuel - 10 + oil.run.levelTime;
  assert.ok(Math.abs(gained - oilFuel(tank) * UNLOCK_FX.richOil[4]) < 0.2, `flask gave ${gained}`);
});

test('perks: gems fill the purse, Appraiser multiplies it', () => {
  const s = started(level([item(1, 'gem', 1.5, 1.5)]), { appraiser: 2 }, 3);
  run(s, 1);
  assert.equal(s.run.gems, 1);
  assert.equal(s.progress.purse, 3 + UNLOCK_FX.appraiser[2]);
});

test('perks: Ember Reserve rekindles a dead torch once per level', () => {
  const s = started(level([]), { ember: 1 });
  s.run.fuel = 0.01;
  const ev = run(s, 2);
  assert.equal(s.phase, 'playing', 'the run survives');
  assert.equal(ev.filter((e) => e.type === 'ember').length, 1);
  assert.ok(s.run.fuel > UNLOCK_FX.ember[1] - 0.1);
  assert.equal(s.run.emberUsed, true);
  s.run.fuel = 0.01;
  run(s, 2);
  assert.equal(s.phase, 'gameOver', 'the second death on the same level is final');
  const plain = started(level([]));
  plain.run.fuel = 0.01;
  run(plain, 2);
  assert.equal(plain.phase, 'gameOver', 'without the unlock nothing changes');
});

test('perks: Siphon stores a flask overflow and pours it back below half a tank', () => {
  const s = started(level([item(1, 'oil', 1.5, 1.5)]), { siphon: 3 });
  assert.equal(s.run.fuel, s.run.fuelMax);
  run(s, 1);
  assert.equal(/** @type {any} */ (s.levelData).items[0].taken, true, 'a brim-full tank takes the flask into the reserve');
  assert.ok(s.run.reserve > 20, `reserve ${s.run.reserve}`);
  const stored = s.run.reserve;
  s.run.fuel = s.run.fuelMax * SIPHON.POUR_BELOW - 5;
  const before = s.run.fuel;
  run(s, 60);
  assert.ok(s.run.fuel > before, 'poured back in');
  assert.ok(Math.abs(stored - s.run.reserve - SIPHON.POUR_RATE) < 0.05, 'at POUR_RATE per second');
  const plain = started(level([item(1, 'oil', 1.5, 1.5)]));
  run(plain, 1);
  assert.equal(/** @type {any} */ (plain.levelData).items[0].taken, false, 'without it a full tank leaves the flask');
});

test('perks: the Gem Magnet pulls a gem it can see, never one through a wall', () => {
  const ROOM = ['#######', '#S....#', '###.###', '#.....#', '#######'];
  const gems = [item(1, 'gem', 4.5, 1.5), item(2, 'gem', 1.5, 3.5)];
  const s = started(level(gems, ROOM), { magnet: 3 });
  run(s, 1);
  assert.equal(gems[0].taken, false, '3 tiles away is beyond the rank-3 pull');
  const t = started(level([item(1, 'gem', 2.5, 1.5), item(2, 'gem', 1.5, 3.5)], ROOM), { magnet: 3 });
  run(t, 1);
  const items = /** @type {any} */ (t.levelData).items;
  assert.equal(items[0].taken, true, '1 tile away in plain sight is pulled in');
  assert.equal(items[1].taken, false, '2 tiles away behind a wall is not');
  const plain = started(level([item(1, 'gem', 2.5, 1.5)], ROOM));
  run(plain, 1);
  assert.equal(/** @type {any} */ (plain.levelData).items[0].taken, false, 'no magnet, no pull');
});

test('perks (retired, still wired): a wider reveal radius maps further, scroll sense tracks the unfound scroll', () => {
  const OPEN = ['###########', '#S........#', '#.........#', '#.........#', '#........E#', '###########'];
  const narrow = started(level([], OPEN));
  const wide = startedWithPerks(level([], OPEN), { reveal: UNLOCK_FX.cartographer[2] });
  run(narrow, 20);
  run(wide, 20);
  const seen = (/** @type {any} */ st) => st.explored.reduce((a, b) => a + b, 0);
  assert.ok(seen(wide) > seen(narrow), `${seen(wide)} tiles vs ${seen(narrow)}`);

  const scroll = item(9, 'map', 6.5, 1.5);
  const s = startedWithPerks(level([scroll], OPEN), { scrollSense: UNLOCK_FX.scrollSense[1] });
  run(s, 1);
  assert.ok(s.derived.scrollSense > 0.5 && s.derived.scrollSense < 1, `sense ${s.derived.scrollSense}`);
  const blind = started(level([item(9, 'map', 6.5, 1.5)], OPEN));
  run(blind, 1);
  assert.equal(blind.derived.scrollSense, 0);
});

test('chalk: marks the wall ahead once per face, spends charges, and the level resets them', () => {
  const s = started(level([]), { chalk: 1 });
  assert.equal(s.run.chalk, UNLOCK_FX.chalk[1]);
  // Face west, one tile from the start's west wall.
  s.player.angle = Math.PI;
  const ev = run(s, 1, { pressed: new Set(['chalk']) });
  const hit = ev.find((e) => e.type === 'chalk');
  assert.equal(hit.ok, true);
  assert.equal(s.marks.length, 1);
  assert.deepEqual({ x: s.marks[0].x, y: s.marks[0].y, face: s.marks[0].face }, { x: 0, y: 1, face: 0 }, 'the east face of the wall west of the start');
  assert.equal(s.run.chalk, UNLOCK_FX.chalk[1] - 1);
  const again = run(s, 1, { pressed: new Set(['chalk']) }).find((e) => e.type === 'chalk');
  assert.equal(again.ok, false, 'a face takes one mark');
  assert.equal(s.run.chalk, UNLOCK_FX.chalk[1] - 1, 'and a refused mark costs nothing');

  // Facing down the long corridor nothing is in reach.
  s.player.angle = 0;
  const far = run(s, 1, { pressed: new Set(['chalk']) }).find((e) => e.type === 'chalk');
  assert.equal(far.ok, false);

  const marks = s.marks;
  reducer(s, { type: 'debugWin' });
  reducer(s, { type: 'nextLevel' });
  reducer(s, { type: 'levelReady', data: level([]) });
  assert.equal(s.marks.length, 0);
  assert.notEqual(s.marks, marks, 'a fresh array, so the renderer sees a new level');
  assert.equal(s.run.chalk, UNLOCK_FX.chalk[1]);

  const none = started(level([]));
  none.player.angle = Math.PI;
  const refused = run(none, 1, { pressed: new Set(['chalk']) }).find((e) => e.type === 'chalk');
  assert.equal(refused.ok, false, 'no unlock, no chalk');
  assert.equal(none.marks.length, 0);
});

test('reveal: a wide Cartographer window completes its sweep across steps, then rests until the player moves', () => {
  // Regression: a sweep only counted as complete when every hidden tile fit one step's probe budget,
  // so an 11×11 window with more hidden tiles than that was re-probed on every step for ever (2× step
  // cost). A pillared hall hides plenty of tiles from the middle.
  const rows = [];
  for (let y = 0; y < 15; y++) {
    let row = '';
    for (let x = 0; x < 15; x++) {
      const border = x === 0 || y === 0 || x === 14 || y === 14;
      const pillar = x % 2 === 0 && y % 2 === 0;
      row += border || pillar ? '#' : '.';
    }
    rows.push(row);
  }
  rows[7] = rows[7].slice(0, 7) + 'S' + rows[7].slice(8);
  rows[13] = rows[13].slice(0, 13) + 'E' + rows[13].slice(14);
  const s = startedWithPerks(level([], rows), { reveal: UNLOCK_FX.cartographer[2] });
  run(s, 60);
  assert.equal(s.sim.revealCursor, 0, 'the sweep finished');
  assert.equal(s.sim.revealSeen, 0);
  const seen = s.explored.reduce((a, b) => a + b, 0);
  run(s, 60);
  assert.equal(s.explored.reduce((a, b) => a + b, 0), seen, 'standing still reveals nothing new');
  assert.ok(Number.isFinite(s.sim.revealX), 'the completed sweep is remembered');
});
