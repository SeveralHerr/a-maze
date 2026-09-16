// @ts-check
/**
 * Unit tests for src/maze/populate.js — run with `node src/maze/populate.test.mjs`.
 *
 * Two things matter here and both are player-visible: items must never land somewhere impossible
 * (inside a wall, on top of each other, under the player's feet at spawn), and the fuel budget
 * must keep the difficulty promise from ARCHITECTURE.md §1 — level 1 forgiving, level 10 tight,
 * every level winnable without pickups.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMaze } from './generator.js';
import { validateMaze } from './validator.js';
import { populateLevel, fuelBudget } from './populate.js';
import { TILE } from './constants.js';

/**
 * Generate + validate + populate in one step.
 * @param {{cols:number, rows:number, braid?:number, gems?:number, oil?:number, fuelSeconds?:number, par?:number}} p
 * @param {number} seed
 * @returns {{maze:import('../core/types.js').Maze, validation:import('../core/types.js').Validation,
 *   pop:import('./populate.js').Population}}
 */
function build(p, seed) {
  const maze = generateMaze({ cols: p.cols, rows: p.rows, seed, braid: p.braid });
  const validation = validateMaze(maze);
  return { maze, validation, pop: populateLevel(maze, validation, p, seed) };
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

test('the requested number of items is placed when the maze has room', () => {
  const { pop } = build({ cols: 12, rows: 12, gems: 9, oil: 3 }, 42);
  assert.equal(pop.items.filter((i) => i.kind === 'gem').length, 9);
  assert.equal(pop.items.filter((i) => i.kind === 'oil').length, 3);
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

test('gems prefer dead ends far from the start', () => {
  const { maze, pop } = build({ cols: 16, rows: 16, gems: 8, oil: 0 }, 5);
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

test('oil flasks sit just off the solution path, spread along it', () => {
  let offPath = 0;
  let totalFlasks = 0;
  for (let seed = 0; seed < 20; seed++) {
    const { maze, validation, pop } = build({ cols: 18, rows: 18, braid: 0.15, gems: 0, oil: 4 }, seed);
    const path = /** @type {Uint32Array} */ (validation.path);
    const onPath = new Set(path);
    assert.equal(pop.items.length, 4);

    /** Manhattan distance to the closest path tile, and the path index it hangs off. */
    const anchors = [];
    for (const it of pop.items) {
      assert.equal(it.kind, 'oil');
      const x = it.x - 0.5;
      const y = it.y - 0.5;
      totalFlasks++;
      if (!onPath.has(y * maze.width + x)) offPath++;
      let best = Infinity;
      let bestAt = -1;
      for (let i = 0; i < path.length; i++) {
        const px = path[i] % maze.width;
        const py = (path[i] - px) / maze.width;
        const d = Math.abs(px - x) + Math.abs(py - y);
        if (d < best) {
          best = d;
          bestAt = i;
        }
      }
      assert.ok(best <= 3, `oil is ${best} tiles from the path (seed ${seed})`);
      anchors.push(bestAt);
    }
    // Spread: the flasks hang off distinct, ordered stretches of the route.
    anchors.sort((a, b) => a - b);
    for (let i = 1; i < anchors.length; i++) {
      assert.ok(anchors[i] > anchors[i - 1], `two flasks share a stretch of the path (seed ${seed})`);
    }
  }
  // A stretch of route with no side passage at all falls back to the corridor itself; that is the
  // documented behaviour, but it must stay the exception.
  assert.ok(offPath / totalFlasks >= 0.85, `only ${offPath}/${totalFlasks} flasks hang off the path`);
});

test('degenerate mazes place as many items as physically fit and never more', () => {
  for (const [cols, rows] of [[1, 1], [1, 2], [2, 1], [2, 2]]) {
    const { maze, pop } = build({ cols, rows, gems: 6, oil: 3 }, 7);
    const floors = Array.from(maze.tiles).filter((t) => t === TILE.FLOOR).length;
    assert.ok(pop.items.length <= floors, 'more items than floor tiles');
    assert.ok(pop.items.length <= 9);
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
    // The face points at the corridor the flame lights.
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
  const a = build({ cols: 15, rows: 15, braid: 0.3, gems: 7, oil: 3 }, 1234);
  const b = build({ cols: 15, rows: 15, braid: 0.3, gems: 7, oil: 3 }, 1234);
  assert.deepEqual(a.pop.items, b.pop.items);
  assert.deepEqual(a.pop.torches, b.pop.torches);
  assert.equal(a.pop.fuel, b.pop.fuel);
  const c = build({ cols: 15, rows: 15, braid: 0.3, gems: 7, oil: 3 }, 1235);
  assert.notDeepEqual(a.pop.items, c.pop.items);
});

test('the fuel budget keeps level 1 at or under 55 % for EVERY possible 6×6 maze', () => {
  // A shortest path is simple, so it visits each of the 36 cells at most once: pathLength ≤ 71.
  // Checking the whole range proves the bound instead of sampling it.
  for (let len = 1; len <= 71; len++) {
    const b = fuelBudget(len, { gems: 0, oil: 0 });
    assert.ok(b.usage <= 0.55, `path ${len} tiles burns ${(b.usage * 100).toFixed(1)} % of the fuel`);
  }
  let worst = 0;
  for (let seed = 0; seed < 400; seed++) {
    const { validation, pop } = build({ cols: 6, rows: 6, gems: 4, oil: 1 }, seed);
    const direct = (validation.pathLength * 1.18) / 3.2;
    worst = Math.max(worst, direct / pop.fuel);
  }
  assert.ok(worst <= 0.55, `worst level-1 usage was ${(worst * 100).toFixed(1)} %`);
  assert.ok(worst > 0.35, 'level 1 should not be a walkover either');
});

test('difficulty ramps: level 10 lands near 85 % and nothing ever exceeds the 88 % ceiling', () => {
  let sum = 0;
  let n = 0;
  let worst = 0;
  for (let seed = 0; seed < 120; seed++) {
    const { validation, pop } = build({ cols: 24, rows: 24, braid: 0.4, gems: 13, oil: 4 }, seed);
    const usage = ((validation.pathLength * 1.18) / 3.2) / pop.fuel;
    sum += usage;
    n++;
    worst = Math.max(worst, usage);
  }
  const avg = sum / n;
  assert.ok(avg > 0.78 && avg < 0.9, `level 10 average usage was ${(avg * 100).toFixed(1)} %`);
  assert.ok(worst <= 0.881, `usage ceiling breached: ${(worst * 100).toFixed(1)} %`);

  // Deep levels stay winnable without a single pickup.
  for (let seed = 0; seed < 40; seed++) {
    const { validation, pop } = build({ cols: 40, rows: 40, braid: 0.4, gems: 20, oil: 8 }, seed);
    const usage = ((validation.pathLength * 1.18) / 3.2) / pop.fuel;
    assert.ok(usage <= 0.881, `level 30 usage ${(usage * 100).toFixed(1)} %`);
  }
});

test('fuel rises with path length, and par always fits inside the fuel', () => {
  let prev = 0;
  for (const len of [1, 10, 50, 100, 250, 500, 1000, 5000]) {
    const b = fuelBudget(len, {});
    assert.ok(b.fuel >= prev, 'fuel must be monotonic in path length');
    assert.ok(b.par <= b.fuel, 'par must be reachable');
    assert.ok(b.par > 0 && Number.isFinite(b.fuel));
    prev = b.fuel;
  }
  assert.equal(fuelBudget(0, {}).fuel, fuelBudget(1, {}).fuel, 'a degenerate path is treated as one tile');
  assert.equal(fuelBudget(NaN, {}).fuel, fuelBudget(1, {}).fuel);
});

test('params.fuelSeconds / params.par act as floors, never as ceilings', () => {
  const derived = fuelBudget(200, {});
  assert.equal(fuelBudget(200, { fuelSeconds: 1 }).fuel, derived.fuel, 'a low floor changes nothing');
  const raised = fuelBudget(200, { fuelSeconds: derived.fuel + 60 });
  assert.equal(raised.fuel, derived.fuel + 60);
  assert.ok(raised.usage < derived.usage, 'more fuel must mean a lower burn fraction');
  assert.ok(fuelBudget(200, { par: 9999 }).par <= raised.fuel + 60);
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
  assert.equal(pop.items.length, 6, 'items fall back to any free floor tile');
  assert.ok(pop.fuel >= 20, 'a floor budget is still produced');
  const used = new Set(pop.items.map((i) => (i.y - 0.5) * maze.width + (i.x - 0.5)));
  assert.equal(used.size, pop.items.length);
});
