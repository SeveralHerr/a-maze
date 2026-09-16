// @ts-check
/**
 * Unit tests for src/maze/populate.js — run with `node src/maze/populate.test.mjs`.
 *
 * Three things matter here and all three are player-visible:
 *   1. items must never land somewhere impossible (inside a wall, on top of each other, under the
 *      player's feet at spawn);
 *   2. the **refuel chain** must hold — a competent player walking the route at the documented
 *      2.0× wander factor must never run dry, at any maze size (ARCHITECTURE.md §4.4);
 *   3. item counts must follow *area*, so a 128×128 maze is not a 16×16 maze with the same handful
 *      of pickups rattling around inside it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMaze } from './generator.js';
import { validateMaze } from './validator.js';
import { populateLevel, fuelBudget, walkRefuelChain } from './populate.js';
import { TILE } from './constants.js';

/**
 * Generate + validate + populate in one step.
 * @param {import('./populate.js').PopulateParams & {cols:number, rows:number, braid?:number}} p
 * @param {number} seed
 * @returns {{maze:import('../core/types.js').Maze, validation:import('../core/types.js').Validation,
 *   pop:import('./populate.js').Population}}
 */
function build(p, seed) {
  const maze = generateMaze({ cols: p.cols, rows: p.rows, seed, braid: p.braid });
  const validation = validateMaze(maze);
  return { maze, validation, pop: populateLevel(maze, validation, p, seed) };
}

/**
 * Count items of one kind.
 * @param {import('./populate.js').Population} pop
 * @param {'gem'|'oil'} kind
 * @returns {number}
 */
function countOf(pop, kind) {
  let n = 0;
  for (const it of pop.items) if (it.kind === kind) n++;
  return n;
}

test('items sit on the centre of a floor tile and never share a tile', () => {
  for (let seed = 0; seed < 25; seed++) {
    const { maze, pop } = build({ cols: 14, rows: 14, braid: 0.25, gems: 10, oil: 4 }, seed);
    const used = new Set();
    for (const it of pop.items) {
      const tx = it.x - 0.5;
      const ty = it.y - 0.5;
      assert.ok(Number.isInteger(tx) && Number.isInteger(ty), `item ${it.id} is not on a tile centre`);
      const idx = ty * maze.width + tx;
      assert.equal(maze.tiles[idx], TILE.FLOOR, `item ${it.id} is inside a wall`);
      assert.equal(used.has(idx), false, `two items share tile ${idx}`);
      used.add(idx);
      assert.equal(it.taken, false);
    }
    assert.deepEqual(
      pop.items.map((i) => i.id),
      pop.items.map((_, i) => i),
      'ids must be a dense 0..n-1 range',
    );
  }
});

test('counts come from density when it is given, in either unit', () => {
  // 0.05 items per cell and 20 cells per item are the same request; both must be honoured, because
  // src/state ships the field in whichever unit it settles on.
  const perCell = build({ cols: 20, rows: 20, gemDensity: 0.02, oilDensity: 0.05 }, 3);
  const cellsPer = build({ cols: 20, rows: 20, gemDensity: 50, oilDensity: 20 }, 3);
  assert.equal(countOf(perCell.pop, 'gem'), 8, '400 cells / 50 = 8 gems');
  assert.equal(countOf(cellsPer.pop, 'gem'), 8);
  assert.equal(countOf(perCell.pop, 'oil'), countOf(cellsPer.pop, 'oil'));
  assert.ok(countOf(perCell.pop, 'oil') >= 20, '400 cells / 20 = 20 flasks');
});

test('item counts scale with area, so density stays roughly constant', () => {
  const small = build({ cols: 16, rows: 16, braid: 0.05, gemDensity: 50, oilDensity: 20 }, 11);
  const huge = build({ cols: 128, rows: 128, braid: 0.25, gemDensity: 60, oilDensity: 30 }, 11);
  const smallCells = 16 * 16;
  const hugeCells = 128 * 128;

  assert.equal(countOf(small.pop, 'gem'), Math.round(smallCells / 50));
  assert.equal(countOf(huge.pop, 'gem'), Math.round(hugeCells / 60));
  assert.ok(countOf(huge.pop, 'oil') >= Math.round(hugeCells / 30), 'the chain may add, never remove');

  // Density, not count, is what is held roughly constant: within a factor of 2 across 64× the area.
  const dSmall = countOf(small.pop, 'oil') / smallCells;
  const dHuge = countOf(huge.pop, 'oil') / hugeCells;
  assert.ok(dHuge > dSmall / 2 && dHuge < dSmall * 2, `oil density drifted: ${dSmall} vs ${dHuge}`);
  assert.ok(huge.pop.items.length < 1000, `a level must stay under ~1000 items, got ${huge.pop.items.length}`);
});

test('with no density and no counts at all, a level is still populated from its area', () => {
  const { pop } = build({ cols: 32, rows: 32 }, 9);
  assert.ok(countOf(pop, 'oil') >= 30, `32×32 = 1024 cells should carry ~45 flasks, got ${countOf(pop, 'oil')}`);
  assert.ok(countOf(pop, 'gem') >= 15, `…and ~20 gems, got ${countOf(pop, 'gem')}`);
});

test('nothing is placed on the start tile, the exit tile, or the first three path tiles', () => {
  for (let seed = 0; seed < 20; seed++) {
    const { maze, validation, pop } = build({ cols: 10, rows: 10, braid: 0.2, gems: 8, oil: 3 }, seed);
    const path = /** @type {Uint32Array} */ (validation.path);
    const forbidden = new Set([maze.start.y * maze.width + maze.start.x, maze.exit.y * maze.width + maze.exit.x]);
    for (let i = 0; i < 3 && i < path.length; i++) forbidden.add(path[i]);
    for (const it of pop.items) {
      const idx = (it.y - 0.5) * maze.width + (it.x - 0.5);
      assert.equal(forbidden.has(idx), false, `item on a reserved tile (seed ${seed})`);
    }
  }
});

// ─── The refuel chain ────────────────────────────────────────────────────────────────────────

test('THE GUARANTEE: the refuel chain is walkable at every size, on every seed', () => {
  const sizes = [
    { cols: 16, rows: 16, braid: 0, fuelSeconds: 110 },
    { cols: 24, rows: 24, braid: 0.05, fuelSeconds: 113 },
    { cols: 48, rows: 48, braid: 0.15, fuelSeconds: 121 },
    { cols: 96, rows: 96, braid: 0.25, fuelSeconds: 143 },
    { cols: 128, rows: 128, braid: 0.35, fuelSeconds: 150 },
  ];
  let worst = 1;
  for (const size of sizes) {
    const params = { ...size, oilDensity: 25, gemDensity: 55 };
    const seeds = size.cols > 64 ? 4 : 12;
    for (let seed = 0; seed < seeds; seed++) {
      const { maze, validation, pop } = build(params, seed * 7919 + size.cols);
      const walk = walkRefuelChain(maze, validation, pop.items, params);
      assert.ok(walk.flasks > 0, `${size.cols}² seed ${seed}: no flask is reachable from the route`);
      assert.ok(
        walk.maxGap <= walk.gap,
        `${size.cols}² seed ${seed}: ${walk.maxGap} tiles between refuels, limit ${walk.gap}`,
      );
      assert.ok(
        walk.minFuel > 0,
        `${size.cols}² seed ${seed}: the torch died with ${walk.minFuel}s to spare`,
      );
      assert.equal(walk.ok, true);
      worst = Math.min(worst, walk.minFuelFraction);
    }
  }
  // A chain that only just holds is a chain that breaks for a real player; the margin is the point.
  assert.ok(worst > 0.25, `worst torch reserve across the sweep was ${(worst * 100).toFixed(1)} %`);
});

test('the chain survives a level whose params ask for far too little oil', () => {
  // A stale or hand-written `oil: 1` must not be able to strand the player: the chain is a floor.
  const params = { cols: 64, rows: 64, braid: 0.2, oil: 1, gems: 4, fuelSeconds: 130 };
  for (let seed = 0; seed < 6; seed++) {
    const { maze, validation, pop } = build(params, seed);
    assert.ok(countOf(pop, 'oil') > 1, 'the chain must override a too-small oil count');
    assert.equal(walkRefuelChain(maze, validation, pop.items, params).ok, true);
  }
});

test('a tighter oilTargetGap is honoured; a looser one cannot break the guarantee', () => {
  const base = { cols: 40, rows: 40, braid: 0.1, oilDensity: 25, fuelSeconds: 120 };
  const tight = build({ ...base, oilTargetGap: 20 }, 4);
  const loose = build({ ...base, oilTargetGap: 10000 }, 4);
  const natural = build(base, 4);

  const tightWalk = walkRefuelChain(tight.maze, tight.validation, tight.pop.items, { ...base, oilTargetGap: 20 });
  assert.equal(tightWalk.gap, 20, 'a tighter target must be adopted');
  assert.ok(tightWalk.maxGap <= 20);
  assert.equal(
    walkRefuelChain(loose.maze, loose.validation, loose.pop.items, base).gap,
    walkRefuelChain(natural.maze, natural.validation, natural.pop.items, base).gap,
    'a looser target must be ignored — the sustainable bound wins',
  );
  assert.equal(walkRefuelChain(loose.maze, loose.validation, loose.pop.items, base).ok, true);
});

test('oil flasks stay on the route the player is actually walking', () => {
  let offPath = 0;
  let reachable = 0;
  let total = 0;
  for (let seed = 0; seed < 12; seed++) {
    const params = { cols: 18, rows: 18, braid: 0.15, oilDensity: 25, gems: 0 };
    const { maze, validation, pop } = build(params, seed);
    const onPath = new Set(validation.path);
    for (const it of pop.items) {
      assert.equal(it.kind, 'oil');
      total++;
      if (!onPath.has((it.y - 0.5) * maze.width + (it.x - 0.5))) offPath++;
    }
    reachable += walkRefuelChain(maze, validation, pop.items, params).flasks;
  }
  // The economy only works if the flasks are *on the way*: nearly all of them must be pickable
  // from the solution path (within OIL_BRANCH_RADIUS), not buried in a far pocket.
  assert.ok(reachable / total >= 0.9, `only ${reachable}/${total} flasks are reachable from the route`);
  // …and a good half should sit in a side pocket rather than in the corridor itself, so taking one
  // is still a small decision. (A stretch of route with no side passage falls back to the corridor;
  // in a thick-wall maze that is common, which is why this is a majority and not a rule.)
  assert.ok(offPath / total >= 0.5, `only ${offPath}/${total} flasks hang off the path`);
});

test('gems favour dead ends off the beaten track', () => {
  const { maze, pop } = build({ cols: 16, rows: 16, gems: 8, oil: 0, oilTargetGap: 1e9 }, 5);
  let atDeadEnd = 0;
  for (const it of pop.items) {
    if (it.kind !== 'gem') continue;
    const x = it.x - 0.5;
    const y = it.y - 0.5;
    const idx = y * maze.width + x;
    let n = 0;
    if (maze.tiles[idx + 1] === TILE.FLOOR) n++;
    if (maze.tiles[idx - 1] === TILE.FLOOR) n++;
    if (maze.tiles[idx + maze.width] === TILE.FLOOR) n++;
    if (maze.tiles[idx - maze.width] === TILE.FLOOR) n++;
    if (n === 1) atDeadEnd++;
  }
  assert.equal(atDeadEnd, 8, 'a perfect 16×16 maze has plenty of dead ends; all gems should use them');
});

test('gems spread over the whole maze instead of clustering in one corner', () => {
  const { maze, pop } = build({ cols: 64, rows: 64, braid: 0.2, gemDensity: 55, oilDensity: 25 }, 17);
  const half = maze.width / 2;
  const quadrants = [0, 0, 0, 0];
  for (const it of pop.items) {
    if (it.kind !== 'gem') continue;
    quadrants[(it.x > half ? 1 : 0) + (it.y > half ? 2 : 0)]++;
  }
  const gems = quadrants.reduce((a, b) => a + b, 0);
  for (const q of quadrants) {
    assert.ok(q > gems / 8, `a quadrant holds only ${q} of ${gems} gems — the scatter is lopsided`);
  }
});

test('degenerate mazes place as many items as physically fit and never more', () => {
  for (const [cols, rows] of [[1, 1], [1, 2], [2, 1], [2, 2]]) {
    const { maze, pop } = build({ cols, rows, gems: 6, oil: 3 }, 7);
    const floors = Array.from(maze.tiles).filter((t) => t === TILE.FLOOR).length;
    assert.ok(pop.items.length <= floors, 'more items than floor tiles');
    const used = new Set(pop.items.map((i) => (i.y - 0.5) * maze.width + (i.x - 0.5)));
    assert.equal(used.size, pop.items.length, 'duplicate tile in a degenerate maze');
  }
});

test('torches are mounted on wall tiles, face the corridor, and stay 6 tiles apart', () => {
  const { maze, pop } = build({ cols: 24, rows: 24, braid: 0.2, gems: 0, oil: 0 }, 21);
  assert.ok(pop.torches.length > 10, 'a 24×24 maze should be lit by more than a handful of torches');
  const dirDx = [1, 0, -1, 0];
  const dirDy = [0, 1, 0, -1];
  for (const t of pop.torches) {
    assert.equal(maze.tiles[t.y * maze.width + t.x], TILE.WALL, 'torch is not on a wall tile');
    const fx = t.x + dirDx[t.face];
    const fy = t.y + dirDy[t.face];
    assert.equal(maze.tiles[fy * maze.width + fx], TILE.FLOOR, 'torch faces solid rock');
  }
  for (let i = 0; i < pop.torches.length; i++) {
    for (let j = i + 1; j < pop.torches.length; j++) {
      const a = pop.torches[i];
      const b = pop.torches[j];
      assert.ok(
        Math.abs(a.x - b.x) >= 6 || Math.abs(a.y - b.y) >= 6 || (a.x === b.x && a.y === b.y && a.face !== b.face),
        `torches ${i} and ${j} are too close`,
      );
      assert.ok(!(a.x === b.x && a.y === b.y && a.face === b.face), 'duplicate torch');
    }
  }
});

test('population is deterministic for a seed and varies between seeds', () => {
  const p = { cols: 15, rows: 15, braid: 0.3, gems: 7, oilDensity: 25 };
  const a = build(p, 1234);
  const b = build(p, 1234);
  assert.deepEqual(a.pop.items, b.pop.items);
  assert.deepEqual(a.pop.torches, b.pop.torches);
  assert.equal(a.pop.fuel, b.pop.fuel);
  const c = build(p, 1235);
  assert.notDeepEqual(a.pop.items, c.pop.items);
});

test('a 128×128 level is deterministic and stays inside the item budget', () => {
  const p = { cols: 128, rows: 128, braid: 0.3, gemDensity: 60, oilDensity: 30, fuelSeconds: 150 };
  const a = build(p, 4242);
  const b = build(p, 4242);
  assert.deepEqual(a.pop.items, b.pop.items, '16 384 cells must still replay exactly');
  assert.ok(a.pop.items.length > 400 && a.pop.items.length < 1000, `items: ${a.pop.items.length}`);
  assert.ok(a.pop.torches.length < 4096, `torches: ${a.pop.torches.length}`);
  const used = new Set(a.pop.items.map((i) => (i.y - 0.5) * a.maze.width + (i.x - 0.5)));
  assert.equal(used.size, a.pop.items.length, 'duplicate tile at scale');
});

// ─── The tank ────────────────────────────────────────────────────────────────────────────────

test('fuel is a TANK: params.fuelSeconds is the tank, not a floor under a path-derived budget', () => {
  const small = fuelBudget(200, { fuelSeconds: 110 });
  const huge = fuelBudget(1563, { fuelSeconds: 110 });
  assert.equal(small.fuel, 110);
  assert.equal(huge.fuel, 110, 'a 12× longer route must NOT buy a bigger tank');
  assert.ok(huge.usage > 1, 'a perfect run down a massive maze costs more than one tank — by design');
  assert.ok(small.usage < 1);
});

test('the fallback tank curve runs 110 s → 150 s with maze side, and nothing else', () => {
  assert.equal(fuelBudget(279, {}, 16 * 16).fuel, 110, 'level-1 sized maze');
  assert.equal(fuelBudget(1563, {}, 128 * 128).fuel, 150, 'the size cap');
  assert.equal(fuelBudget(4000, {}, 2000 * 2000).fuel, 150, 'past the cap the tank stops growing');
  assert.ok(fuelBudget(600, {}, 48 * 48).fuel > 110 && fuelBudget(600, {}, 48 * 48).fuel < 150);
  assert.equal(fuelBudget(1, {}, 1).fuel, 110, 'a 1×1 test maze still gets a usable tank');
  // `cells` may arrive on params instead of as an argument, and may be missing entirely.
  assert.equal(fuelBudget(1563, { cells: 128 * 128 }).fuel, 150);
  assert.ok(fuelBudget(1563, {}).fuel > 140, 'with no cells at all, the path length implies the size');
});

test('a flask restores ~35 % of the tank, and the gap is what that buys', () => {
  const b = fuelBudget(500, { fuelSeconds: 110 });
  assert.ok(Math.abs(b.refuel - 38.5) < 0.1, `refuel ${b.refuel}`);
  // (R·S/spt − 2·3)/w with R=38.5, S=0.9, spt=1.18/3.2, w=2 ⇒ 43 tiles.
  assert.equal(b.gap, 43);
  assert.ok(b.reach > b.gap, 'a full tank must reach well past one chain hop');

  const explicit = fuelBudget(500, { fuelSeconds: 110, oilRefuelSeconds: 60 });
  assert.equal(explicit.refuel, 60, 'the state module may set the flask value directly');
  assert.ok(explicit.gap > b.gap, 'richer flasks buy a longer leash');

  // Past the size cap the torch burns faster, so every distance shortens with it.
  const drained = fuelBudget(500, { fuelSeconds: 110, drain: 1.35 });
  assert.ok(drained.gap < b.gap, `drain must tighten the chain: ${drained.gap} vs ${b.gap}`);
  assert.ok(drained.reach < b.reach);
  assert.ok(fuelBudget(500, { fuelSeconds: 1e9 }).fuel <= 3600, 'the tank is clamped');
  assert.ok(fuelBudget(500, { fuelSeconds: -5 }).fuel >= 20, 'a nonsense tank falls back, never goes negative');
});

test('par is a target time, not a fuel budget, and rises with the route', () => {
  let prev = 0;
  for (const len of [1, 10, 50, 100, 250, 500, 1000, 5000]) {
    const b = fuelBudget(len, {});
    assert.ok(b.par >= prev, 'par must be monotonic in path length');
    assert.ok(b.par > 0 && Number.isFinite(b.par));
    prev = b.par;
  }
  // 1563 tiles at 2× wander ≈ 19 minutes: the deep-level target the design asks for.
  const deep = fuelBudget(1563, { fuelSeconds: 150 });
  assert.ok(deep.par > 1000 && deep.par < 1300, `par ${deep.par}`);
  assert.equal(fuelBudget(200, { par: 9999 }).par, 9999, 'params.par is still a floor');
  assert.equal(fuelBudget(0, {}).fuel, fuelBudget(1, {}).fuel, 'a degenerate path is treated as one tile');
  assert.equal(fuelBudget(NaN, {}).fuel, fuelBudget(1, {}).fuel);
});

test('populateLevel rejects a maze it cannot read instead of producing nonsense', () => {
  assert.throws(() => populateLevel(/** @type {never} */ (null), /** @type {never} */ ({}), {}, 1), TypeError);
  assert.throws(
    () => populateLevel(/** @type {never} */ ({ width: 5, height: 5, tiles: new Uint8Array(9) }), /** @type {never} */ ({}), {}, 1),
    TypeError,
  );
});

test('a missing or unsolvable validation still yields a usable, safe level', () => {
  const maze = generateMaze({ cols: 8, rows: 8, seed: 3 });
  const pop = populateLevel(maze, /** @type {never} */ ({ path: null, pathLength: -1 }), { gems: 4, oil: 2 }, 3);
  assert.equal(pop.items.length, 6, 'items fall back to a plain scatter');
  assert.ok(pop.fuel >= 20, 'a tank is still produced');
  const used = new Set(pop.items.map((i) => (i.y - 0.5) * maze.width + (i.x - 0.5)));
  assert.equal(used.size, pop.items.length);
  const walk = walkRefuelChain(maze, /** @type {never} */ ({ path: null, pathLength: -1 }), pop.items, {});
  assert.equal(walk.ok, false, 'an unwalkable level cannot make the promise, and says so');
});
