// @ts-check
/**
 * @file Unit tests for src/state/sim.js — collision, line of sight, fog of war, movement feel,
 * bump detection and the title attract camera.
 *
 * The collision suite is deliberately brute force: correctness here is a safety property ("the
 * body is never inside a wall"), and the cheapest honest way to test a safety property is to try
 * to violate it from every angle, speed and dt the game can produce.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE } from '../maze/constants.js';
import { TAU } from '../core/math.js';
import { createInitialState, reducer } from './game.js';
import { ATTRACT, PLAYER, WORLD } from './balance.js';
import {
  hasLineOfSight,
  moveCircle,
  revealAround,
  solidAt,
  stepAttract,
  stepPlaying,
  updateDerived,
} from './sim.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────

/**
 * Build a Maze from an ASCII picture: '#' = wall, anything else = floor, 'S' = start, 'E' = exit.
 * @param {string[]} rows
 * @returns {import('../core/types.js').Maze}
 */
function mazeFrom(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const tiles = new Uint8Array(width * height);
  let start = { x: 1, y: 1 };
  let exit = { x: 1, y: 1 };
  for (let y = 0; y < height; y++) {
    assert.equal(rows[y].length, width, `row ${y} has the wrong width`);
    for (let x = 0; x < width; x++) {
      const c = rows[y][x];
      tiles[y * width + x] = c === '#' ? TILE.WALL : TILE.FLOOR;
      if (c === 'S') start = { x, y };
      if (c === 'E') exit = { x, y };
    }
  }
  return {
    width,
    height,
    cols: (width - 1) >> 1,
    rows: (height - 1) >> 1,
    tiles,
    start,
    exit,
    seed: 1234,
  };
}

/** A twisty 9×9 test maze with corners of every orientation. */
const TWISTY = [
  '#########',
  '#S..#...#',
  '###.#.#.#',
  '#...#.#.#',
  '#.#####.#',
  '#.#...#.#',
  '#.#.#.#.#',
  '#...#..E#',
  '#########',
];

/**
 * An open arena: every tile floor except a sealed 1-tile border.
 * @param {number} n side length in tiles
 * @returns {import('../core/types.js').Maze}
 */
function openMaze(n) {
  const rows = [];
  for (let y = 0; y < n; y++) {
    let r = '';
    for (let x = 0; x < n; x++) r += x === 0 || y === 0 || x === n - 1 || y === n - 1 ? '#' : '.';
    rows.push(r);
  }
  const maze = mazeFrom(rows);
  maze.start = { x: 1, y: 1 };
  maze.exit = { x: n - 2, y: n - 2 };
  return maze;
}

/**
 * @param {import('../core/types.js').Maze} maze
 * @param {import('../core/types.js').Item[]} [items]
 * @param {number} [fuel]
 * @returns {import('../core/types.js').LevelData}
 */
function levelDataFor(maze, items = [], fuel = 100) {
  return {
    maze,
    validation: {
      solvable: true,
      fullyConnected: true,
      bordersSealed: true,
      pathLength: 10,
      floorCount: 10,
      deadEnds: 1,
      loops: 0,
      path: null,
      errors: [],
    },
    items,
    torches: [],
    fuel,
    par: 50,
  };
}

/**
 * A state sitting in `playing` on the given maze.
 * @param {import('../core/types.js').Maze} maze
 * @param {import('../core/types.js').Item[]} [items]
 * @param {number} [fuel]
 * @returns {import('../core/types.js').GameState}
 */
function playing(maze, items = [], fuel = 100) {
  const s = createInitialState();
  reducer(s, { type: 'newGame', seed: 7 });
  reducer(s, { type: 'levelReady', data: levelDataFor(maze, items, fuel) });
  assert.equal(s.phase, 'playing');
  return s;
}

/** Zero input frame. @type {import('./sim.js').SimInput} */
const NONE = { moveX: 0, moveY: 0, turn: 0, lookDX: 0 };

/**
 * @param {Partial<import('./sim.js').SimInput>} o
 * @returns {import('./sim.js').SimInput}
 */
function input(o) {
  return { ...NONE, ...o };
}

/**
 * One gameplay step with the event queue cleared first — the reducer does this for every action,
 * so a test calling `stepPlaying` directly must do it too or events pile up across steps.
 * @param {import('../core/types.js').GameState} s
 * @param {number} dt
 * @param {import('./sim.js').SimInput} inp
 * @returns {void}
 */
function step(s, dt, inp) {
  s.events.length = 0;
  stepPlaying(s, dt, inp);
}

/**
 * Ground truth overlap test, written independently of the solver: is a circle at (x,y) intersecting
 * any solid tile? Out-of-bounds counts as solid.
 * @param {import('../core/types.js').Maze} maze
 * @param {number} x
 * @param {number} y
 * @param {number} r
 * @returns {boolean}
 */
function overlapsWall(maze, x, y, r) {
  const { width: w, height: h, tiles } = maze;
  const x0 = Math.floor(x - r);
  const x1 = Math.floor(x + r);
  const y0 = Math.floor(y - r);
  const y1 = Math.floor(y + r);
  const eps = 1e-9;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (!solidAt(tiles, w, h, tx, ty)) continue;
      // Nearest point on the tile rect to the circle centre.
      const nx = x < tx ? tx : x > tx + 1 ? tx + 1 : x;
      const ny = y < ty ? ty : y > ty + 1 ? ty + 1 : y;
      const dx = x - nx;
      const dy = y - ny;
      if (dx * dx + dy * dy < r * r - eps) return true;
    }
  }
  return false;
}

// ─── solidAt ─────────────────────────────────────────────────────────────────────────────────

test('solidAt: out of bounds is solid, FLOOR is not', () => {
  const m = mazeFrom(TWISTY);
  assert.equal(solidAt(m.tiles, m.width, m.height, 1, 1), false);
  assert.equal(solidAt(m.tiles, m.width, m.height, 0, 0), true);
  assert.equal(solidAt(m.tiles, m.width, m.height, -1, 4), true);
  assert.equal(solidAt(m.tiles, m.width, m.height, 4, -1), true);
  assert.equal(solidAt(m.tiles, m.width, m.height, 9, 4), true);
  assert.equal(solidAt(m.tiles, m.width, m.height, 4, 9), true);
  // Any non-FLOOR value is solid, not just WALL.
  const m2 = mazeFrom(TWISTY);
  m2.tiles[1 * m2.width + 1] = 7;
  assert.equal(solidAt(m2.tiles, m2.width, m2.height, 1, 1), true);
});

// ─── moveCircle: the anti-tunnelling guarantee ───────────────────────────────────────────────

test('moveCircle: the body can never enter a wall, from any tile/angle/speed/dt', () => {
  const maze = mazeFrom(TWISTY);
  const r = PLAYER.RADIUS;
  const out = new Float64Array(4);
  const speeds = [1, 3.2, 5.12, 20];
  const dts = [1 / 60, 0.1, 0.25];
  const starts = [];
  for (let ty = 0; ty < maze.height; ty++) {
    for (let tx = 0; tx < maze.width; tx++) {
      if (!solidAt(maze.tiles, maze.width, maze.height, tx, ty)) starts.push([tx + 0.5, ty + 0.5]);
    }
  }
  assert.ok(starts.length > 10, 'fixture should have plenty of floor tiles');

  let checks = 0;
  for (const [sx, sy] of starts) {
    for (let a = 0; a < 24; a++) {
      const angle = (a / 24) * TAU;
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      for (const speed of speeds) {
        for (const dt of dts) {
          let x = sx;
          let y = sy;
          for (let i = 0; i < 24; i++) {
            moveCircle(maze.tiles, maze.width, maze.height, x, y, ux * speed * dt, uy * speed * dt, r, out);
            x = out[0];
            y = out[1];
            assert.ok(Number.isFinite(x) && Number.isFinite(y), 'position stayed finite');
            assert.equal(
              overlapsWall(maze, x, y, r),
              false,
              `entered a wall at (${x.toFixed(4)}, ${y.toFixed(4)}) angle=${angle.toFixed(2)} speed=${speed} dt=${dt}`,
            );
            checks++;
          }
        }
      }
    }
  }
  assert.ok(checks > 50000, `ran ${checks} positional checks`);
});

test('moveCircle: diagonal corner approaches never clip the corner', () => {
  // A single wall block at (2,2) surrounded by floor: every diagonal approach hits a convex corner.
  const maze = mazeFrom([
    '#####',
    '#...#',
    '#.#.#',
    '#...#',
    '#####',
  ]);
  const r = PLAYER.RADIUS;
  const out = new Float64Array(4);
  const corners = [
    [1.5, 1.5, 1, 1],
    [3.5, 1.5, -1, 1],
    [1.5, 3.5, 1, -1],
    [3.5, 3.5, -1, -1],
  ];
  for (const [sx, sy, dx, dy] of corners) {
    let x = sx;
    let y = sy;
    for (let i = 0; i < 300; i++) {
      moveCircle(maze.tiles, maze.width, maze.height, x, y, dx * 0.05, dy * 0.05, r, out);
      x = out[0];
      y = out[1];
      assert.equal(overlapsWall(maze, x, y, r), false, `clipped the corner at (${x}, ${y})`);
    }
    // Pressing straight into a convex corner stops the body — it must not squeeze past.
    const cornerX = dx > 0 ? 2 : 3;
    const cornerY = dy > 0 ? 2 : 3;
    const d = Math.hypot(x - cornerX, y - cornerY);
    assert.ok(d >= r - 1e-9, `stopped at the corner (distance ${d})`);
  }
});

test('moveCircle: slides along a flat wall, keeping the tangential component', () => {
  const maze = openMaze(9);
  const r = PLAYER.RADIUS;
  const out = new Float64Array(4);
  // Start flush against the west wall, push north-west: the -x part is absorbed, +y survives.
  const blocked = moveCircle(maze.tiles, maze.width, maze.height, 1 + r, 4, -0.05, 0.05, r, out);
  assert.equal(blocked & 1, 1, 'x was blocked');
  assert.equal(blocked & 2, 0, 'y was not blocked');
  assert.ok(Math.abs(out[0] - (1 + r)) < 1e-9, 'x did not move into the wall');
  assert.ok(Math.abs(out[1] - 4.05) < 1e-12, 'y slid the full amount');
  assert.ok(Math.abs(out[2] - -0.05) < 1e-9, 'the lost displacement is the normal component');
  assert.equal(out[3], 0);
});

test('moveCircle: a zero or non-finite move is a no-op', () => {
  const maze = openMaze(9);
  const out = new Float64Array(4);
  assert.equal(moveCircle(maze.tiles, maze.width, maze.height, 4.5, 4.5, 0, 0, PLAYER.RADIUS, out), 0);
  assert.deepEqual([...out], [4.5, 4.5, 0, 0]);
  moveCircle(maze.tiles, maze.width, maze.height, 4.5, 4.5, NaN, 0, PLAYER.RADIUS, out);
  assert.equal(out[0], 4.5);
  assert.equal(out[1], 4.5);
});

test('moveCircle: an absurd displacement is capped, never tunnelled', () => {
  const maze = mazeFrom(TWISTY);
  const out = new Float64Array(4);
  // 10 000 tiles of displacement in one call: bounded work, and still inside the maze.
  moveCircle(maze.tiles, maze.width, maze.height, 1.5, 1.5, 10000, 10000, PLAYER.RADIUS, out);
  assert.equal(overlapsWall(maze, out[0], out[1], PLAYER.RADIUS), false);
  assert.ok(out[0] > 0 && out[0] < maze.width && out[1] > 0 && out[1] < maze.height);
});

test('moveCircle: a body that starts inside a wall can escape', () => {
  const maze = mazeFrom(TWISTY);
  const out = new Float64Array(4);
  // (0.5, 0.5) is the solid corner tile — the body must be allowed to walk out.
  moveCircle(maze.tiles, maze.width, maze.height, 0.5, 0.5, 1, 1, PLAYER.RADIUS, out);
  assert.ok(out[0] > 0.5 && out[1] > 0.5, 'moved out of the wall rather than locking up');
});

// ─── Line of sight ───────────────────────────────────────────────────────────────────────────

test('hasLineOfSight: blocked by walls, clear along a corridor', () => {
  const maze = mazeFrom([
    '#####',
    '#...#',
    '#.#.#',
    '#...#',
    '#####',
  ]);
  const { tiles, width: w, height: h } = maze;
  assert.equal(hasLineOfSight(tiles, w, h, 1.5, 1.5, 1.5, 1.5), true, 'same tile');
  assert.equal(hasLineOfSight(tiles, w, h, 1.5, 1.5, 3.5, 1.5), true, 'straight corridor');
  assert.equal(hasLineOfSight(tiles, w, h, 1.5, 2.5, 3.5, 2.5), false, 'blocked by the pillar');
  assert.equal(hasLineOfSight(tiles, w, h, 1.5, 1.5, 2.5, 2.5), true, 'the wall tile sees itself');
  assert.equal(hasLineOfSight(tiles, w, h, 1.5, 1.5, NaN, 2), false, 'non-finite target is not visible');
});

// ─── Fog of war ──────────────────────────────────────────────────────────────────────────────

test('revealAround: reveals what is visible, never what is behind a wall, within budget', () => {
  const maze = mazeFrom(TWISTY);
  const s = playing(maze);
  const w = maze.width;
  // levelReady already ran one reveal pass; run a few more so the budget cursor completes a sweep.
  for (let i = 0; i < 6; i++) revealAround(s);
  const explored = /** @type {Uint8Array} */ (s.explored);
  assert.equal(explored[1 * w + 1], 1, 'the tile under the player is explored');
  assert.equal(explored[1 * w + 2], 1, 'the corridor ahead is explored');
  // (7,1) is more than REVEAL_RADIUS away from the start and behind walls.
  assert.equal(explored[1 * w + 7], 0, 'a distant tile stays hidden');
  let seen = 0;
  for (let i = 0; i < explored.length; i++) seen += explored[i];
  assert.ok(seen > 4 && seen < explored.length, `revealed a plausible number of tiles (${seen})`);
});

test('revealAround: budget bounds the probes per step and the cursor resumes', () => {
  const maze = openMaze(21);
  const s = playing(maze);
  s.player.x = 10.5;
  s.player.y = 10.5;
  const explored = /** @type {Uint8Array} */ (s.explored);
  explored.fill(0);
  revealAround(s);
  let after1 = 0;
  for (let i = 0; i < explored.length; i++) after1 += explored[i];
  // One own-tile write plus at most the probe budget.
  assert.ok(after1 <= WORLD.REVEAL_BUDGET + 1, `first pass revealed ${after1} tiles`);
  for (let i = 0; i < 20; i++) revealAround(s);
  let after2 = 0;
  for (let i = 0; i < explored.length; i++) after2 += explored[i];
  assert.ok(after2 > after1, 'the sweep resumes and keeps revealing');
});

// ─── Movement feel ───────────────────────────────────────────────────────────────────────────

test('movement: full input reaches walk speed in TIME_TO_TOP_SPEED seconds', () => {
  const s = playing(openMaze(41));
  s.player.x = 20.5;
  s.player.y = 20.5;
  s.player.angle = 0;
  const dt = 1 / 60;
  const steps = Math.round(PLAYER.TIME_TO_TOP_SPEED / dt); // 9
  for (let i = 0; i < steps - 1; i++) stepPlaying(s, dt, input({ moveY: 1 }));
  const nearly = Math.hypot(s.player.vx, s.player.vy);
  assert.ok(nearly < PLAYER.WALK_SPEED, 'not at top speed one step early');
  stepPlaying(s, dt, input({ moveY: 1 }));
  assert.ok(
    Math.abs(Math.hypot(s.player.vx, s.player.vy) - PLAYER.WALK_SPEED) < 1e-9,
    'exactly at walk speed after TIME_TO_TOP_SPEED',
  );
});

test('movement: one top speed (no sprint, whatever a stale frame says), friction brings it to a full stop', () => {
  const s = playing(openMaze(41));
  s.player.x = 20.5;
  s.player.y = 20.5;
  s.player.angle = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 40; i++) stepPlaying(s, dt, /** @type {any} */ ({ ...input({ moveY: 1 }), sprint: true }));
  const top = Math.hypot(s.player.vx, s.player.vy);
  assert.ok(Math.abs(top - PLAYER.WALK_SPEED) < 1e-9, `top speed ${top}`);
  // Friction: WALK / FRICTION ≈ 0.11 s ≈ 7 steps.
  for (let i = 0; i < 12; i++) stepPlaying(s, dt, input({}));
  assert.equal(s.player.vx, 0);
  assert.equal(s.player.vy, 0);
});

test('movement: diagonal input is not faster than cardinal input', () => {
  const s = playing(openMaze(41));
  s.player.x = 20.5;
  s.player.y = 20.5;
  s.player.angle = 0;
  for (let i = 0; i < 40; i++) stepPlaying(s, 1 / 60, input({ moveX: 1, moveY: 1 }));
  assert.ok(Math.abs(Math.hypot(s.player.vx, s.player.vy) - PLAYER.WALK_SPEED) < 1e-9);
});

test('movement: keyboard turn eases in and approaches TURN_SPEED', () => {
  const s = playing(openMaze(41));
  s.player.x = 20.5;
  s.player.y = 20.5;
  s.player.angle = 0;
  const dt = 1 / 60;
  stepPlaying(s, dt, input({ turn: 1 }));
  const firstStep = s.player.angle;
  assert.ok(firstStep > 0 && firstStep < PLAYER.TURN_SPEED * dt, 'the first frame is eased, not instant');
  let total = firstStep;
  let prev = s.player.angle;
  for (let i = 1; i < 60; i++) {
    stepPlaying(s, dt, input({ turn: 1 }));
    total += s.player.angle - prev >= 0 ? s.player.angle - prev : s.player.angle - prev + TAU;
    prev = s.player.angle;
  }
  // One second of held turn ≈ TURN_SPEED radians, minus the ease-in lag (~1/TURN_EASE_RATE s).
  assert.ok(total > PLAYER.TURN_SPEED * 0.9 && total <= PLAYER.TURN_SPEED, `turned ${total} rad in 1 s`);
});

test('movement: mouse yaw is applied directly and clamped by the reducer, not here', () => {
  const s = playing(openMaze(9));
  const before = s.player.angle;
  stepPlaying(s, 1 / 60, input({ lookDX: 0.4 }));
  assert.ok(Math.abs(s.player.angle - (before + 0.4)) < 1e-12, 'no smoothing on mouse look');
});

test('movement: the interpolation snapshot trails exactly one step', () => {
  const s = playing(openMaze(41));
  s.player.x = 20.5;
  s.player.y = 20.5;
  for (let i = 0; i < 10; i++) {
    const bx = s.player.x;
    stepPlaying(s, 1 / 60, input({ moveY: 1 }));
    assert.equal(s.player.px, bx);
  }
});

// ─── Head bob & footsteps ────────────────────────────────────────────────────────────────────

test('bob: phase follows distance travelled and footsteps alternate feet', () => {
  const s = playing(openMaze(61));
  s.player.x = 30.5;
  s.player.y = 30.5;
  s.player.angle = 0;
  /** @type {number[]} */
  const feet = [];
  let distance = 0;
  for (let i = 0; i < 240; i++) {
    const bx = s.player.x;
    const by = s.player.y;
    step(s, 1 / 60, input({ moveY: 1 }));
    distance += Math.hypot(s.player.x - bx, s.player.y - by);
    for (const e of s.events) if (e.type === 'footstep') feet.push(e.foot);
  }
  assert.ok(feet.length >= 6, `heard ${feet.length} footsteps over ${distance.toFixed(2)} tiles`);
  for (let i = 1; i < feet.length; i++) assert.notEqual(feet[i], feet[i - 1], 'feet alternate');
  // Two footsteps per stride, so steps ≈ distance / (STRIDE/2) within one step of rounding.
  const expected = Math.floor(distance / (1.9 / 2));
  assert.ok(Math.abs(feet.length - expected) <= 1, `${feet.length} steps vs ${expected} expected`);
  assert.ok(s.player.bobAmp > 0.9, 'bob amplitude ramped up at full speed');
  assert.ok(s.player.bob >= 0 && s.player.bob < TAU, 'bob phase stays wrapped');
});

test('bob: standing still emits no footsteps and the amplitude decays', () => {
  const s = playing(openMaze(41));
  s.player.x = 20.5;
  s.player.y = 20.5;
  for (let i = 0; i < 60; i++) step(s, 1 / 60, input({ moveY: 1 }));
  for (let i = 0; i < 90; i++) {
    step(s, 1 / 60, input({}));
    for (const e of s.events) assert.notEqual(e.type, 'footstep');
  }
  assert.ok(s.player.bobAmp < 0.01, 'bob amplitude decayed to nothing');
});

// ─── Bump ────────────────────────────────────────────────────────────────────────────────────

test('bump: a head-on impact fires once, then respects the cooldown', () => {
  const s = playing(openMaze(9));
  s.player.x = 4.5;
  s.player.y = 4.5;
  s.player.angle = 0; // east, into the wall at tile column 7... run until contact
  let bumps = 0;
  for (let i = 0; i < 120; i++) {
    step(s, 1 / 60, input({ moveY: 1 }));
    for (const e of s.events) if (e.type === 'bump') bumps++;
  }
  assert.equal(bumps, 1, 'one thud per impact, not one per frame');
  assert.ok(s.player.shake > 0, 'the impact shook the camera');
});

test('bump: sliding along a wall is silent', () => {
  const s = playing(openMaze(21));
  // Flush against the west wall, running north with a slight push into it.
  s.player.x = 1 + PLAYER.RADIUS;
  s.player.y = 10.5;
  s.player.angle = -Math.PI / 2; // north
  let bumps = 0;
  for (let i = 0; i < 120; i++) {
    step(s, 1 / 60, input({ moveY: 1, moveX: -0.15 }));
    for (const e of s.events) if (e.type === 'bump') bumps++;
  }
  assert.equal(bumps, 0, 'grazing a wall must not thud');
  assert.ok(s.player.y < 10.5 - 2, 'and the player still made progress along it');
});

// ─── Pickup reach (ARCHITECTURE.md §4.8) ─────────────────────────────────────────────────────

/**
 * @param {number} id
 * @param {import('../core/types.js').ItemKind} kind
 * @param {number} x
 * @param {number} y
 * @returns {import('../core/types.js').Item}
 */
function itemAt(id, kind, x, y) {
  return { id, kind, x, y, taken: false };
}

test('pickups: cutting an L-corner collects the item on the corner tile', () => {
  // Regression for "you can walk right by items". The corridor turns from east to south at tile
  // (3,1); the gem sits on that tile's centre. The player cuts the corner on a diagonal that passes
  // 0.25 from the inner wall vertex (3,2) — just clear of the 0.22 body — so its closest approach to
  // the gem is √0.5 − 0.25 ≈ 0.457: outside the old 0.45 radius, inside the new one.
  const maze = mazeFrom([
    '######',
    '#S..##',
    '###.##',
    '###.##',
    '###E##',
    '######',
  ]);
  const gem = itemAt(1, 'gem', 3.5, 1.5);
  const s = playing(maze, [gem], 100);
  const off = 0.25 / Math.SQRT2;
  const p = s.player;
  p.x = 3 + off - 0.6;
  p.y = 2 - off - 0.6;
  p.px = p.x;
  p.py = p.y;
  p.angle = Math.PI / 4;
  p.vx = PLAYER.WALK_SPEED * Math.SQRT1_2;
  p.vy = PLAYER.WALK_SPEED * Math.SQRT1_2;
  let closest = Infinity;
  let collectedAt = -1;
  for (let i = 0; i < 60 && p.x < 3 + off + 0.6; i++) {
    step(s, 1 / 60, input({ moveY: 1 }));
    closest = Math.min(closest, Math.hypot(p.x - gem.x, p.y - gem.y));
    if (gem.taken && collectedAt < 0) collectedAt = i;
  }
  assert.ok(closest > 0.45, `the route is the regression case (closest approach ${closest.toFixed(3)})`);
  assert.ok(closest <= WORLD.PICKUP_RADIUS, 'and within the new reach');
  assert.equal(gem.taken, true, 'the corner gem was collected');
  assert.equal(s.run.gems, 1);
});

test('pickups: an item on the far side of a one-tile wall is never collected', () => {
  const maze = mazeFrom([
    '#######',
    '#S.#.E#',
    '#######',
  ]);
  const gem = itemAt(1, 'gem', 4.5, 1.5);
  const s = playing(maze, [gem], 100);
  // Press into the wall from the adjacent tile at full speed, at normal and clamped dt.
  for (const dt of [1 / 60, 0.25]) {
    for (let i = 0; i < 120; i++) step(s, dt, input({ moveY: 1 }));
    assert.ok(s.player.x <= 3 - PLAYER.RADIUS + 1e-9, 'pressed flat against the wall');
    assert.equal(gem.taken, false, `nothing grabbed through the wall at dt=${dt}`);
    s.run.fuel = 100;
  }
  assert.equal(s.run.gems, 0);
  assert.equal(s.phase, 'playing');
});

test('pickups: a long step at the dt clamp sweeps its whole path, not just its end point', () => {
  // Open room, player walking east at full speed with dt = SIM.MAX_DT (0.8 tiles per step). The
  // gem sits 0.7 off the line of travel, half way along the step: both end points are
  // √(0.4² + 0.7²) ≈ 0.81 away, so only the swept test can see it.
  const maze = openMaze(12);
  const gem = itemAt(1, 'gem', 5.5, 5.5);
  const s = playing(maze, [gem], 100);
  const speed = PLAYER.WALK_SPEED;
  const dt = 0.25;
  const p = s.player;
  p.x = gem.x - (speed * dt) / 2;
  p.y = gem.y + 0.7;
  p.angle = 0;
  p.vx = speed;
  p.vy = 0;
  const x0 = p.x;
  step(s, dt, input({ moveY: 1 }));
  assert.ok(Math.abs(p.x - x0 - speed * dt) < 1e-9, 'the step covered the full 0.8 tiles');
  assert.ok(Math.hypot(x0 - gem.x, 0.7) > WORLD.PICKUP_RADIUS, 'the start is out of reach');
  assert.ok(Math.hypot(p.x - gem.x, p.y - gem.y) > WORLD.PICKUP_RADIUS, 'so is the end');
  assert.equal(gem.taken, true, 'the gem passed under the swept path was collected');
  assert.ok(s.events.some((e) => e.type === 'pickup'));
});

/**
 * Walk the player east along row y = 1.5 from x0 to x1 at walking speed, 60 Hz.
 * @param {import('../core/types.js').GameState} s
 * @param {number} x1
 * @returns {void}
 */
function walkEastTo(s, x1) {
  const p = s.player;
  p.angle = 0;
  for (let i = 0; i < 600 && p.x < x1; i++) step(s, 1 / 60, input({ moveY: 1 }));
}

test('pickups: two flasks on adjacent tiles are both collected when the tank has room for both', () => {
  // Bug report: "two oils were right next to each other and the other was unable to be picked up".
  const maze = mazeFrom(['############', '#S........E#', '############']);
  const a = itemAt(1, 'oil', 3.5, 1.5);
  const b = itemAt(2, 'oil', 4.5, 1.5);
  const s = playing(maze, [a, b], 100);
  s.run.fuel = 5;
  walkEastTo(s, 6.5);
  assert.equal(a.taken, true, 'first flask');
  assert.equal(b.taken, true, 'second flask');
  assert.equal(s.run.refuels, 2);
});

test('pickups: every pair of item kinds on adjacent tiles is collected, across bucket seams too', () => {
  const kinds = /** @type {const} */ (['gem', 'oil', 'map']);
  // x = 3.5 | 4.5 straddles the ITEM_GRID_TILES = 4 bucket seam; 1.5 | 2.5 does not.
  for (const [ax, bx] of [[1.5, 2.5], [3.5, 4.5], [7.5, 8.5]]) {
    for (const ka of kinds) {
      for (const kb of kinds) {
        const maze = mazeFrom(['##############', '#S..........E#', '##############']);
        const a = itemAt(1, ka, ax, 1.5);
        const b = itemAt(2, kb, bx, 1.5);
        const s = playing(maze, [a, b], 100);
        s.run.fuel = s.run.fuelMax * 0.1;
        s.player.x = 1.5;
        s.player.y = 1.5;
        walkEastTo(s, 10.2);
        assert.equal(a.taken, true, `${ka}@${ax} then ${kb}@${bx}: first`);
        assert.equal(b.taken, true, `${ka}@${ax} then ${kb}@${bx}: second`);
      }
    }
  }
});

test('pickups: a second adjacent flask on a brim-full tank is taken after a moment of burn', () => {
  // Topping off (sim.js takeItem): only a brim-full tank leaves a flask on the floor. The first flask
  // fills the tank, so the second waits — but only for `FUEL.OIL_MIN_ROOM` of burn, standing on it.
  const maze = mazeFrom(['############', '#S........E#', '############']);
  const a = itemAt(1, 'oil', 3.5, 1.5);
  const b = itemAt(2, 'oil', 4.5, 1.5);
  const s = playing(maze, [a, b], 100);
  s.run.fuel = s.run.fuelMax * 0.9;
  walkEastTo(s, 4.5);
  assert.equal(a.taken, true, 'first flask');
  let t = 0;
  while (!b.taken && t < 120 && s.phase === 'playing') {
    step(s, 1 / 60, NONE);
    t += 1 / 60;
  }
  assert.equal(b.taken, true, `second flask taken after ${t.toFixed(1)} s standing on it`);
  assert.ok(t < 3, `a top-off needs only a moment of burn (${t.toFixed(1)} s)`);
});

// ─── Derived ─────────────────────────────────────────────────────────────────────────────────

test('updateDerived: exitDist, nearExit ramp and lowFuel', () => {
  const maze = openMaze(21);
  const s = playing(maze, [], 100);
  s.player.x = maze.exit.x + 0.5;
  s.player.y = maze.exit.y + 0.5;
  updateDerived(s);
  assert.ok(s.derived.exitDist < 1e-9);
  assert.equal(s.derived.nearExit, 1);
  s.player.x = 1.5;
  s.player.y = 1.5;
  updateDerived(s);
  assert.ok(s.derived.exitDist > WORLD.NEAR_EXIT_RANGE);
  assert.equal(s.derived.nearExit, 0);
  assert.equal(s.derived.lowFuel, false);
  s.run.fuel = 19;
  updateDerived(s);
  assert.equal(s.derived.lowFuel, true);
  s.levelData = null;
  updateDerived(s);
  assert.equal(s.derived.exitDist, Infinity);
  assert.equal(s.derived.nearExit, 0);
});

// ─── Attract mode ────────────────────────────────────────────────────────────────────────────

test('attract: the title camera wanders the maze without ever touching a wall', () => {
  const maze = mazeFrom(TWISTY);
  const s = createInitialState();
  reducer(s, { type: 'levelReady', data: levelDataFor(maze) });
  assert.equal(s.phase, 'title', 'levelReady in title keeps the phase');

  let travelled = 0;
  /** @type {Set<string>} */
  const visited = new Set();
  for (let i = 0; i < 3600; i++) {
    const bx = s.player.x;
    const by = s.player.y;
    stepAttract(s, 1 / 60);
    travelled += Math.hypot(s.player.x - bx, s.player.y - by);
    assert.equal(
      overlapsWall(maze, s.player.x, s.player.y, PLAYER.RADIUS),
      false,
      `attract camera walked into a wall at (${s.player.x}, ${s.player.y})`,
    );
    visited.add(`${Math.floor(s.player.x)},${Math.floor(s.player.y)}`);
  }
  assert.ok(travelled > 30, `camera covered ${travelled.toFixed(1)} tiles in 60 s`);
  assert.ok(visited.size >= 8, `camera visited ${visited.size} distinct tiles`);
  assert.ok(Number.isFinite(s.player.angle), 'angle stayed finite');
});

test('attract: turning is rate-limited, so the shot never snaps', () => {
  const maze = mazeFrom(TWISTY);
  const s = createInitialState();
  reducer(s, { type: 'levelReady', data: levelDataFor(maze) });
  const dt = 1 / 60;
  const maxTurn = ATTRACT.TURN_RATE * dt + 1e-9;
  for (let i = 0; i < 3600; i++) {
    const before = s.player.angle;
    stepAttract(s, dt);
    let d = s.player.angle - before;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    assert.ok(Math.abs(d) <= maxTurn, `turned ${d} rad in one step (cap ${maxTurn})`);
  }
});

test('attract: the steering is an easing controller, not a bang-bang one', () => {
  // Regression. The proportional term used to be compared against a PER-FRAME cap without being
  // multiplied by dt, which made the saturation band 60× too narrow: the camera sat pinned at
  // ±TURN_RATE and reversed sign almost every frame — a permanent ~±2°/frame buzz on the first
  // screen the player ever sees — and the band moved with the framerate on top of that.
  //
  // The property under test is the documented one (balance.js ATTRACT.TURN_GAIN): below
  // `TURN_RATE / TURN_GAIN` radians of heading error the turn eases off instead of saturating.
  /**
   * @param {number} dt
   * @returns {{pinned:number, flipsPerSecond:number, meanRate:number}}
   */
  function measure(dt) {
    const s = createInitialState();
    reducer(s, { type: 'levelReady', data: levelDataFor(mazeFrom(TWISTY)) });
    const steps = Math.round(60 / dt); // 60 seconds of attract, whatever the step size
    let pinned = 0;
    let flips = 0;
    let prev = 0;
    let sum = 0;
    for (let i = 0; i < steps; i++) {
      const before = s.player.angle;
      stepAttract(s, dt);
      let d = s.player.angle - before;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      const rate = d / dt;
      sum += Math.abs(rate);
      if (Math.abs(rate) >= ATTRACT.TURN_RATE * 0.95) pinned++;
      if (rate !== 0) {
        if (prev !== 0 && Math.sign(rate) !== Math.sign(prev)) flips++;
        prev = rate;
      }
    }
    return { pinned: pinned / steps, flipsPerSecond: flips / 60, meanRate: sum / steps };
  }

  const a = measure(1 / 60);
  // TWISTY turns a corner every few tiles, so honest corner-turning pins the cap ~25 % of the time;
  // the bang-bang bug measured 88 %. (A real 16×16 demo maze measures ~19 % at 60 and 30 Hz, 1.2 flips/s.)
  assert.ok(a.pinned < 0.3, `${(a.pinned * 100).toFixed(1)}% of frames pinned at the rate cap`);
  assert.ok(a.flipsPerSecond < 5, `yaw reversed ${a.flipsPerSecond.toFixed(1)} times per second`);
  assert.ok(a.meanRate < ATTRACT.TURN_RATE * 0.75, `mean |yaw| ${a.meanRate.toFixed(2)} rad/s`);

  // Framerate independence: the turn is a rate, so halving the step rate must not widen the band.
  const b = measure(1 / 30);
  assert.ok(
    Math.abs(a.pinned - b.pinned) < 0.1,
    `saturation is dt-dependent: ${a.pinned.toFixed(3)} at 60 Hz vs ${b.pinned.toFixed(3)} at 30 Hz`,
  );
  assert.ok(
    Math.abs(a.meanRate - b.meanRate) < ATTRACT.TURN_RATE * 0.1,
    `mean yaw rate is dt-dependent: ${a.meanRate.toFixed(3)} vs ${b.meanRate.toFixed(3)}`,
  );
});

test('attract: a small heading error eases, it does not saturate', () => {
  // The direct form of the same property: point the camera almost at its target and check that the
  // commanded step is the proportional one (err × GAIN × dt) rather than the rate cap.
  const maze = mazeFrom(['#####', '#S..#', '#####']);
  maze.exit = { x: 3, y: 1 };
  const s = createInitialState();
  reducer(s, { type: 'levelReady', data: levelDataFor(maze) });
  const dt = 1 / 60;
  // The attract target is east of the start, so a near-zero angle is a near-zero heading error.
  s.player.angle = 0.02;
  const before = s.player.angle;
  stepAttract(s, dt);
  let d = s.player.angle - before;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  // The sway makes the exact error unpredictable, but it is bounded by SWAY_AMP + 0.02, so the
  // step must stay far below the cap — an order of magnitude below, not a hair under it.
  assert.ok(
    Math.abs(d) < ATTRACT.TURN_RATE * dt * 0.5,
    `a ${(ATTRACT.SWAY_AMP + 0.02).toFixed(3)} rad error produced ${Math.abs(d).toFixed(5)} rad of turn, cap ${(ATTRACT.TURN_RATE * dt).toFixed(5)}`,
  );
});

test('attract: deterministic for a given maze seed', () => {
  const a = createInitialState();
  const b = createInitialState();
  reducer(a, { type: 'levelReady', data: levelDataFor(mazeFrom(TWISTY)) });
  reducer(b, { type: 'levelReady', data: levelDataFor(mazeFrom(TWISTY)) });
  for (let i = 0; i < 1200; i++) {
    stepAttract(a, 1 / 60);
    stepAttract(b, 1 / 60);
  }
  assert.equal(a.player.x, b.player.x);
  assert.equal(a.player.y, b.player.y);
  assert.equal(a.player.angle, b.player.angle);
});

test('attract: a dead end is handled by turning around, not by getting stuck', () => {
  // A single 3-tile stub corridor: the camera must reverse at both ends.
  const maze = mazeFrom(['#####', '#S..#', '#####']);
  maze.exit = { x: 3, y: 1 };
  const s = createInitialState();
  reducer(s, { type: 'levelReady', data: levelDataFor(maze) });
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < 2400; i++) {
    stepAttract(s, 1 / 60);
    assert.equal(overlapsWall(maze, s.player.x, s.player.y, PLAYER.RADIUS), false);
    minX = Math.min(minX, s.player.x);
    maxX = Math.max(maxX, s.player.x);
  }
  assert.ok(maxX - minX > 1.2, `camera patrolled the stub (${minX.toFixed(2)}..${maxX.toFixed(2)})`);
});

/**
 * Drive the attract camera and measure how smooth the shot is.
 * @param {import('../core/types.js').Maze} maze
 * @param {number} hz step rate
 * @param {number} seconds
 * @param {(s: import('../core/types.js').GameState) => boolean} [counts] which steps to include in
 *   the yaw-rate statistics (all by default)
 * @returns {{maxAngAccel:number, maxLinAccel:number, maxAbsRate:number, travelled:number, counted:number}}
 */
function attractSmoothness(maze, hz, seconds, counts) {
  const s = createInitialState();
  reducer(s, { type: 'levelReady', data: levelDataFor(maze) });
  const dt = 1 / hz;
  let prevRate = 0;
  let prevSpeed = 0;
  let maxAngAccel = 0;
  let maxLinAccel = 0;
  let maxAbsRate = 0;
  let travelled = 0;
  let counted = 0;
  const steps = Math.round(seconds * hz);
  for (let i = 0; i < steps; i++) {
    const a0 = s.player.angle;
    const x0 = s.player.x;
    const y0 = s.player.y;
    stepAttract(s, dt);
    let d = s.player.angle - a0;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    const rate = d / dt;
    const speed = Math.hypot(s.player.x - x0, s.player.y - y0) / dt;
    travelled += speed * dt;
    if (i > 0) {
      maxAngAccel = Math.max(maxAngAccel, Math.abs(rate - prevRate) / dt);
      maxLinAccel = Math.max(maxLinAccel, Math.abs(speed - prevSpeed) / dt);
    }
    if (counts === undefined || counts(s)) {
      counted++;
      maxAbsRate = Math.max(maxAbsRate, Math.abs(rate));
    }
    prevRate = rate;
    prevSpeed = speed;
  }
  return { maxAngAccel, maxLinAccel, maxAbsRate, travelled, counted };
}

test('attract: turn rate and speed ease — no single-frame snap at corners or tiles', () => {
  // Regression: the steering assigned the proportional command straight to the turn rate and the
  // cos-falloff straight to the speed, so both stepped at every corner and every tile — measured
  // 152 rad/s² and 102 tiles/s² peaks over a 3-minute walk. Three minutes of TWISTY is ~70 corners.
  for (const hz of [30, 60, 144]) {
    const r = attractSmoothness(mazeFrom(TWISTY), hz, 180);
    assert.ok(r.maxAngAccel < 20, `${hz} Hz: peak angular acceleration ${r.maxAngAccel.toFixed(1)} rad/s²`);
    assert.ok(r.maxLinAccel < 12, `${hz} Hz: peak forward acceleration ${r.maxLinAccel.toFixed(1)} tiles/s²`);
    assert.ok(r.travelled > 100, `${hz} Hz: the camera still explores (${r.travelled.toFixed(0)} tiles in 3 min)`);
  }
});

test('attract: walking a straight corridor does not re-aim at every tile', () => {
  // Regression: aiming at the bare centre of the next tile moved the target on each arrival, so the
  // yaw rate flipped −0.14 → +0.09 rad/s every tile down a straight corridor. With the look-ahead aim
  // point on the centre line, a settled straight walk only carries the idle sway (≈ 0.04 rad/s).
  const row = '#S' + '.'.repeat(36) + '#';
  const maze = mazeFrom(['#'.repeat(row.length), row, '#'.repeat(row.length)]);
  maze.exit = { x: row.length - 2, y: 1 };
  const swayRate = ATTRACT.SWAY_AMP * TAU * ATTRACT.SWAY_HZ;
  // Only the eastbound leg well clear of both dead ends, after the start-up turn has settled.
  const r = attractSmoothness(
    maze,
    60,
    12,
    (s) => s.player.x > 6 && s.player.x < row.length - 6 && Math.cos(s.player.angle) > 0.99,
  );
  assert.ok(r.counted > 300, `the eastbound straight was measured (${r.counted} steps)`);
  assert.ok(r.maxAbsRate < swayRate * 1.5 + 0.02, `yaw rate on the straight reached ${r.maxAbsRate.toFixed(3)} rad/s`);
  assert.ok(r.travelled > 15, 'and it did walk the corridor');
});

test('attract: a state with no level data is a no-op, not a crash', () => {
  const s = createInitialState();
  stepAttract(s, 1 / 60);
  assert.equal(s.player.x, 1.5);
});
