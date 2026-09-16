// @ts-check
/**
 * @file Cost and integrity of the simulation on **massive** levels (ARCHITECTURE.md §4.2).
 *
 * The size change turns three previously harmless things into hazards, and this file is the guard
 * on all three:
 *
 * 1. **Per-item work per step.** A level now carries up to ~820 items instead of six. The pickup
 *    test must not scan them, so it queries a bucket grid built once per level; the check here is
 *    empirical — a step on a 128×128 level with hundreds of items must cost no more than a step on
 *    the old 6×6 level — plus a white-box check of the grid's own invariants.
 * 2. **Per-level allocation.** `explored` is 66 kB on a 257×257 level and a deep run installs one
 *    per level, so it (and the grid buffers) come from grow-only pools.
 * 3. **Long runs.** A level is now a 4–14 minute maze, so a single run is measured in *hours* of
 *    wall-clock simulation. 108 000 ticks (30 minutes at 60 Hz) must leave every number finite,
 *    the clock exact, and the heap flat.
 *
 * Cross-module note: like `feasibility.test.mjs`, this file imports `src/maze` to build the real
 * levels it measures. That is a test-only dependency; the runtime rule in §2 is unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';

import { buildLevel } from '../maze/level.js';
import { TAU } from '../core/math.js';
import { createRng } from '../core/rng.js';
import { WORLD, levelParams } from './balance.js';
import { createInitialState, reducer } from './game.js';
import { allocExplored, buildItemGrid, stepPlaying } from './sim.js';

/** @typedef {import('./sim.js').SimState} SimState */

/** The level-1 parameters from *before* the massive-maze change — the baseline to beat. */
const OLD_LEVEL_1 = Object.freeze({ cols: 6, rows: 6, braid: 0, gems: 4, oil: 2 });

/**
 * A `gc()` handle without needing `--expose-gc` on the command line (the test runner spawns each
 * file as a plain `node file.mjs`). Returns null if the trick is ever disallowed, in which case the
 * heap assertions downgrade to "did not explode" rather than silently passing.
 * @returns {(() => void)|null}
 */
function getGc() {
  try {
    v8.setFlagsFromString('--expose-gc');
    const fn = vm.runInNewContext('gc');
    v8.setFlagsFromString('--no-expose-gc');
    return typeof fn === 'function' ? fn : null;
  } catch {
    return null;
  }
}

/**
 * Build a real level and install it, leaving the state in `playing`.
 *
 * The exit is moved onto the sealed corner tile (0,0) first: the benchmarks and the 30-minute soak
 * measure *gameplay* steps, and a level that completes half way through would measure the level
 * transition instead. The corner is a wall, and the collision radius keeps the body more than
 * `WORLD.EXIT_RADIUS` from its centre, so it is simply unreachable.
 *
 * @param {{cols:number, rows:number, braid?:number, gems?:number, oil?:number}} params
 * @param {number} seed
 * @param {number} [level=1] the level number the state should think it is on
 * @returns {{state: SimState, data: import('../core/types.js').LevelData, buildMs: number}}
 */
function installed(params, seed, level = 1) {
  const t0 = performance.now();
  const data = buildLevel(params, seed);
  const buildMs = performance.now() - t0;
  data.maze.exit = { x: 0, y: 0 };
  const state = createInitialState();
  reducer(state, { type: 'newGame', seed });
  state.level = level;
  reducer(state, { type: 'levelReady', data });
  assert.equal(state.phase, 'playing');
  return { state, data, buildMs };
}

/**
 * Run `steps` gameplay steps with a deterministic wandering input, keeping the torch topped up so
 * the run never ends.
 * @param {SimState} state
 * @param {number} steps
 * @param {number} [phase=0] offset into the wander pattern
 * @returns {void}
 */
function drive(state, steps, phase = 0) {
  const input = { moveX: 0, moveY: 1, turn: 0, lookDX: 0, sprint: false };
  for (let i = 0; i < steps; i++) {
    const t = i + phase;
    input.turn = Math.sin(t / 97) + Math.sin(t / 31) * 0.5;
    input.sprint = (t & 63) === 0;
    state.events.length = 0;
    state.run.fuel = state.run.fuelMax;
    stepPlaying(state, 1 / 60, input);
  }
}

/**
 * Microseconds per step, taking the best of `rounds` timed batches (the minimum is the least
 * noisy estimator on a machine that is also doing other things).
 * @param {SimState} state
 * @param {number} steps
 * @param {number} [rounds=5]
 * @returns {number} µs per step
 */
function usPerStep(state, steps, rounds = 5) {
  drive(state, 30_000); // warm-up: let the JIT settle on the real shapes
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t0 = process.hrtime.bigint();
    drive(state, steps, r * steps);
    const us = Number(process.hrtime.bigint() - t0) / 1000 / steps;
    if (us < best) best = us;
  }
  return best;
}

// ─── The item grid ───────────────────────────────────────────────────────────────────────────

test('item grid: every item is filed in exactly one bucket, and in the right one', () => {
  const { state, data } = installed(levelParams(8), 1234, 8);
  const sim = state.sim;
  const start = /** @type {Int32Array} */ (sim.gridStart);
  const order = /** @type {Int32Array} */ (sim.gridItems);
  const buckets = sim.gridW * sim.gridH;
  const n = data.items.length;
  assert.ok(n > 200, `a level-8 maze should be busy (${n} items)`);
  assert.equal(start[0], 0);
  assert.equal(start[buckets], n, 'the CSR offsets cover every item');

  const seen = new Uint8Array(n);
  for (let b = 0; b < buckets; b++) {
    assert.ok(start[b] <= start[b + 1], `bucket ${b} has a non-decreasing offset`);
    const bx = b % sim.gridW;
    const by = (b - bx) / sim.gridW;
    for (let k = start[b]; k < start[b + 1]; k++) {
      const i = order[k];
      assert.ok(i >= 0 && i < n, 'a real item index');
      assert.equal(seen[i], 0, `item ${i} is filed once`);
      seen[i] = 1;
      const it = data.items[i];
      assert.equal(Math.floor(it.x / WORLD.ITEM_GRID_TILES), bx, `item ${i} is in its own column`);
      assert.equal(Math.floor(it.y / WORLD.ITEM_GRID_TILES), by, `item ${i} is in its own row`);
    }
  }
  for (let i = 0; i < n; i++) assert.equal(seen[i], 1, `item ${i} was filed`);
});

test('item grid: rebuilt per level, and the buffers are reused rather than reallocated', () => {
  const { state } = installed(levelParams(3), 99, 3);
  const sim = state.sim;
  const bigStart = sim.gridStart;
  const bigItems = sim.gridItems;
  assert.notEqual(bigStart, null);

  // Descending to a *smaller* level must reuse the (larger) buffers, not allocate new ones.
  const small = buildLevel({ cols: 6, rows: 6, gems: 2, oil: 1 }, 7);
  state.level = 2;
  reducer(state, { type: 'debugWin' });
  reducer(state, { type: 'nextLevel' });
  reducer(state, { type: 'levelReady', data: small });
  assert.equal(sim.gridStart, bigStart, 'the offset buffer is pooled');
  assert.equal(sim.gridItems, bigItems, 'the item buffer is pooled');
  assert.equal(sim.gridFor, small, 'and the grid now describes the new level');
  assert.equal(
    /** @type {Int32Array} */ (sim.gridStart)[sim.gridW * sim.gridH],
    small.items.length,
    'stale counts from the bigger level are gone',
  );
});

test('item grid: only the items near the player are picked up, however many there are', () => {
  const { state, data } = installed(levelParams(6), 4242, 6);
  const p = state.player;
  // Drop one gem right under the player and rebuild: it must be collected on the first step while
  // the hundreds of others, far away, are not.
  data.items.push({ id: data.items.length, kind: 'gem', x: p.x, y: p.y, taken: false });
  buildItemGrid(state);
  const before = state.run.gems;
  state.events.length = 0;
  stepPlaying(state, 1 / 60, { moveX: 0, moveY: 0, turn: 0, lookDX: 0, sprint: false });
  assert.equal(state.run.gems, before + 1, 'the item under the player was collected');
  let taken = 0;
  for (const it of data.items) if (it.taken) taken++;
  assert.equal(taken, 1, 'and nothing else was');
});

// ─── Cost per step ───────────────────────────────────────────────────────────────────────────

test('a step on a 128×128 level with hundreds of items costs no more than the old 6×6 level', () => {
  const small = installed(OLD_LEVEL_1, 12345, 1);
  const capped = levelParams(15);
  const big = installed(capped, 777, 15);
  assert.ok(big.data.items.length > 700, `the cap level is busy (${big.data.items.length} items)`);
  assert.equal(big.data.maze.width, 257);

  const STEPS = 60_000;
  const smallUs = usPerStep(small.state, STEPS);
  const bigUs = usPerStep(big.state, STEPS);
  console.log(
    `step cost: old 6×6 (${small.data.items.length} items, 13×13 tiles) ${smallUs.toFixed(3)} µs  ·  ` +
      `new 128×128 (${big.data.items.length} items, 257×257 tiles) ${bigUs.toFixed(3)} µs  ·  ` +
      `ratio ${(bigUs / smallUs).toFixed(2)}×  ·  level build ${big.buildMs.toFixed(0)} ms`,
  );
  // The honest target is 1.0×; the gate is loose enough to survive a noisy machine but nowhere near
  // loose enough to hide a per-item scan, which would be ~5× at 774 items.
  assert.ok(
    bigUs < smallUs * 1.5,
    `a massive level must not cost more per step: ${bigUs.toFixed(3)} µs vs ${smallUs.toFixed(3)} µs`,
  );
  assert.ok(bigUs < 5, `a sim step must stay far inside the 16.6 ms frame (${bigUs.toFixed(3)} µs)`);
});

// ─── Allocation ──────────────────────────────────────────────────────────────────────────────

test('100 000 ticks on a max-size level allocate nothing that survives a GC', () => {
  const gc = getGc();
  const { state } = installed(levelParams(15), 20_240_607, 15);
  drive(state, 20_000); // settle: collect the reachable items, warm the JIT

  if (gc !== null) gc();
  const before = process.memoryUsage().heapUsed;
  drive(state, 100_000, 20_000);
  if (gc !== null) gc();
  const after = process.memoryUsage().heapUsed;
  const grown = after - before;
  console.log(
    `100 000 ticks: heap ${(before / 1048576).toFixed(2)} → ${(after / 1048576).toFixed(2)} MiB ` +
      `(${(grown / 1024).toFixed(1)} KiB, gc ${gc !== null ? 'forced' : 'unavailable'})`,
  );
  assert.ok(
    grown < 1_048_576,
    `the steady state must not allocate: heap grew ${(grown / 1024).toFixed(1)} KiB`,
  );
});

test('explored is allocated once per level, from a pool, and always correctly sized', () => {
  const state = createInitialState();
  const big = allocExplored(state, 257 * 257);
  assert.equal(big.length, 257 * 257);
  big.fill(1);
  const smaller = allocExplored(state, 33 * 33);
  assert.equal(smaller.length, 33 * 33, 'a smaller level gets an exactly-sized view');
  assert.equal(smaller.buffer, big.buffer, 'backed by the same pooled buffer');
  for (let i = 0; i < smaller.length; i++) assert.equal(smaller[i], 0, 'and it is zeroed');
  const again = allocExplored(state, 257 * 257);
  assert.equal(again.buffer, big.buffer, 'growing back up still reuses the pool');
  for (let i = 0; i < again.length; i++) assert.equal(again[i], 0);

  // And through the reducer: two real levels in a row, each with its own correctly-sized view.
  const a = installed(levelParams(1), 11, 1);
  assert.equal(
    /** @type {Uint8Array} */ (a.state.explored).length,
    a.data.maze.width * a.data.maze.height,
  );
  const b = buildLevel(levelParams(2), 12);
  reducer(a.state, { type: 'debugWin' });
  reducer(a.state, { type: 'nextLevel' });
  reducer(a.state, { type: 'levelReady', data: b });
  const explored = /** @type {Uint8Array} */ (a.state.explored);
  assert.equal(explored.length, b.maze.width * b.maze.height);
  let seen = 0;
  for (let i = 0; i < explored.length; i++) seen += explored[i];
  assert.ok(seen > 0 && seen < 200, `only the new start room is revealed (${seen} tiles)`);
});

// ─── Long-run integrity ──────────────────────────────────────────────────────────────────────

test('108 000 ticks (30 minutes) on a max-size level: no drift, no leak, no NaN', () => {
  const gc = getGc();
  const { state, data } = installed(levelParams(15), 8_675_309, 15);
  const maze = data.maze;
  const rng = createRng(4242);
  const input = { moveX: 0, moveY: 1, turn: 0, lookDX: 0, sprint: false };
  const TICKS = 108_000;
  const DT = 1 / 60;

  drive(state, 5000); // warm-up outside the measured window
  state.time = 0;
  state.run.levelTime = 0;
  state.run.totalTime = 0;
  state.run.score = 0;
  if (gc !== null) gc();
  const heapBefore = process.memoryUsage().heapUsed;

  let refills = 0;
  let minFuel = state.run.fuelMax;
  for (let i = 0; i < TICKS; i++) {
    // A drunkard's walk that still makes progress: re-aim every ~2 s, sprint in bursts.
    if (i % 120 === 0) input.turn = rng.range(-1, 1);
    input.moveX = (i % 600) < 60 ? rng.range(-1, 1) : 0;
    input.sprint = (i & 511) < 90;
    state.events.length = 0;
    stepPlaying(state, DT, input);
    state.time += DT;

    const run = state.run;
    if (run.fuel < minFuel) minFuel = run.fuel;
    // The point of this test is arithmetic and allocation over half an hour, not winning: top the
    // torch up when it runs dry so the level lasts the full 30 minutes. The low-fuel arm/re-arm
    // path is exercised on every one of these cycles.
    if (run.fuel <= 0.5) {
      run.fuel = run.fuelMax;
      refills++;
    }

    if ((i & 1023) === 0) {
      assert.ok(Number.isFinite(state.player.x) && Number.isFinite(state.player.y), `tick ${i}: position`);
      assert.ok(Number.isFinite(state.player.angle), `tick ${i}: angle`);
      assert.ok(Number.isFinite(run.fuel) && run.fuel >= 0, `tick ${i}: fuel ${run.fuel}`);
      assert.ok(Number.isFinite(run.score) && run.score >= 0, `tick ${i}: score ${run.score}`);
      assert.ok(Number.isFinite(state.derived.exitDist), `tick ${i}: exitDist`);
      assert.ok(state.player.bob >= 0 && state.player.bob < TAU, `tick ${i}: bob wrapped`);
      assert.ok(state.player.shake >= 0 && state.player.shake <= 1, `tick ${i}: shake clamped`);
      assert.ok(
        state.player.x > 0 && state.player.x < maze.width && state.player.y > 0 && state.player.y < maze.height,
        `tick ${i}: still inside the maze`,
      );
    }
  }

  if (gc !== null) gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const grown = heapAfter - heapBefore;
  const run = state.run;
  console.log(
    `30-minute level: ${TICKS} ticks, ${refills} torch refills, lowest fuel ${minFuel.toFixed(2)} s, ` +
      `clock ${state.run.levelTime.toFixed(6)} s, heap ${(grown / 1024).toFixed(1)} KiB`,
  );

  assert.equal(state.phase, 'playing', 'the level never ended');
  // 108 000 additions of 1/60 must still be 1800 s: the sim clock is the fuel clock and the score
  // clock, so a drift here is a drift in everything the player sees.
  assert.ok(Math.abs(run.levelTime - 1800) < 1e-6, `levelTime drifted: ${run.levelTime}`);
  assert.ok(Math.abs(run.totalTime - run.levelTime) < 1e-9, 'the two clocks stayed in step');
  assert.ok(Number.isFinite(run.fuel) && run.fuel > 0 && run.fuel <= run.fuelMax);
  assert.ok(Number.isInteger(run.score) && run.score >= 0, `score stayed an integer (${run.score})`);
  assert.ok(Number.isInteger(run.gems) && run.gems <= run.gemsTotal);
  assert.ok(refills > 5, `the torch really did run down repeatedly (${refills} refills)`);
  assert.ok(
    grown < 1_048_576,
    `half an hour of play must not grow the heap: ${(grown / 1024).toFixed(1)} KiB`,
  );
});
