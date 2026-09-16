// @ts-check
/**
 * @file Unit tests for src/state/balance.js — the difficulty curve, the score formulas pinned by
 * ARCHITECTURE.md §1, and settings validation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTRACT,
  BUMP,
  CAP_LEVEL,
  FUEL,
  LEVEL,
  MAP_MODES,
  PLAYER,
  SCORE,
  SETTING_KEYS,
  WORLD,
  coerceSetting,
  defaultSettings,
  drainRate,
  estimatedPathTiles,
  gapSafety,
  gemScore,
  levelBonus,
  levelParams,
  oilFuel,
  resolveTank,
  sanitizeBest,
  sanitizeSettings,
  tankSeconds,
  travelTiles,
} from './balance.js';

// ─── Invariants the sim depends on ───────────────────────────────────────────────────────────

test('constants: the invariants the collision solver and feel depend on', () => {
  assert.ok(PLAYER.RADIUS < 0.5, 'the body must fit in a 1-tile corridor');
  assert.ok(PLAYER.MAX_SUBSTEP < PLAYER.RADIUS, 'a substep must not out-run the body radius');
  assert.ok(PLAYER.MAX_SUBSTEP < 1, 'a substep must not skip a wall tile');
  assert.ok(
    Math.abs(PLAYER.ACCEL * PLAYER.TIME_TO_TOP_SPEED - PLAYER.WALK_SPEED) < 1e-9,
    'ACCEL is derived from TIME_TO_TOP_SPEED',
  );
  assert.ok(PLAYER.FRICTION > PLAYER.ACCEL, 'stopping is at least as snappy as starting');
  assert.ok(WORLD.EXIT_RADIUS > WORLD.PICKUP_RADIUS, 'the portal is easier to hit than an item');
  assert.ok(FUEL.REARM_FRACTION > FUEL.LOW_FRACTION, 'the low-fuel cue needs hysteresis');
  assert.ok(BUMP.MIN_FRACTION > 0 && BUMP.MIN_FRACTION <= 1);
  assert.ok(ATTRACT.SPEED < PLAYER.WALK_SPEED, 'the title camera is calmer than the player');
  assert.ok(Object.isFrozen(PLAYER) && Object.isFrozen(FUEL) && Object.isFrozen(SCORE));
});

// ─── levelParams ─────────────────────────────────────────────────────────────────────────────

test('levelParams: level 1 is a 16×16 perfect maze with a small, fixed tank', () => {
  const p = levelParams(1);
  assert.equal(p.cols, 16, 'massive mazes: level 1 is 16×16 cells = 33×33 tiles');
  assert.equal(p.rows, 16);
  assert.equal(p.braid, 0, 'level 1 is a perfect maze');
  assert.equal(p.fuelSeconds, FUEL.TANK_START, 'the tank, not a size-based budget');
  assert.ok(p.fuelSeconds >= 100 && p.fuelSeconds <= 120, `a ~110 s tank (${p.fuelSeconds} s)`);
  assert.equal(p.drain, 1, 'no extra drain before the size cap');
  assert.ok(p.gems >= LEVEL.GEM_MIN);
  assert.ok(p.oil >= LEVEL.OIL_MIN);
});

test('levelParams: the tank is independent of the maze area', () => {
  // The whole point of the new economy: 64× the area, well under 1.4× the tank.
  const first = levelParams(1);
  const capped = levelParams(CAP_LEVEL);
  assert.equal(capped.cells / first.cells, 64, 'the cap level is 64× the area of level 1');
  assert.ok(capped.fuelSeconds / first.fuelSeconds < 1.4, 'the tank barely moves');
  assert.equal(capped.fuelSeconds, FUEL.TANK_END);
  // …and past the cap it stops moving entirely: difficulty comes from drain and density.
  assert.equal(levelParams(CAP_LEVEL + 10).fuelSeconds, FUEL.TANK_END);
  assert.ok(levelParams(CAP_LEVEL + 10).drain > capped.drain, 'the torch burns faster instead');
  assert.ok(levelParams(999).drain <= FUEL.DRAIN_MAX, 'drain is capped');
});

test('levelParams: the curve grows, braids and tightens monotonically, then caps', () => {
  let prev = levelParams(1);
  for (let lv = 2; lv <= 60; lv++) {
    const p = levelParams(lv);
    assert.ok(p.cols >= prev.cols, `size never shrinks (level ${lv})`);
    assert.ok(p.braid >= prev.braid - 1e-12, `braid never falls (level ${lv})`);
    assert.ok(p.fuelSeconds >= prev.fuelSeconds, `the tank never shrinks (level ${lv})`);
    assert.ok(p.drain >= prev.drain - 1e-12, `drain never falls (level ${lv})`);
    assert.ok(p.fuelPerCell <= prev.fuelPerCell + 1e-12, `per-cell fuel never rises (level ${lv})`);
    assert.ok(p.oil >= prev.oil * 0.999, `flask count never falls (level ${lv})`);
    assert.equal(p.cols, p.rows, 'mazes are square');
    assert.ok(p.cols <= LEVEL.MAX_CELLS, 'size is capped');
    assert.ok(p.braid <= LEVEL.BRAID_MAX + 1e-12, 'braid is capped');
    assert.ok(p.gems >= LEVEL.GEM_MIN && p.gems <= LEVEL.GEM_MAX);
    assert.ok(p.oil >= LEVEL.OIL_MIN && p.oil <= LEVEL.OIL_MAX);
    assert.ok(Number.isInteger(p.gems) && Number.isInteger(p.oil));
    assert.ok(Number.isInteger(p.fuelSeconds) && Number.isInteger(p.par));
    assert.ok(p.fuelSeconds > 0 && p.fuelPerPathTile > 0);
    prev = p;
  }
  assert.equal(CAP_LEVEL, 15, '128 cells per side at +8 per level from 16 lands on level 15');
  assert.equal(levelParams(CAP_LEVEL).cols, LEVEL.MAX_CELLS, 'the size cap is reached at CAP_LEVEL');
  assert.equal(levelParams(CAP_LEVEL - 1).cols, LEVEL.MAX_CELLS - LEVEL.GROWTH, 'and not before');
  assert.equal(levelParams(200).cols, LEVEL.MAX_CELLS);
  assert.ok(
    levelParams(1 + LEVEL.BRAID_RAMP_LEVELS).braid >= LEVEL.BRAID_MAX - 1e-12,
    'braid tops out at the end of its (post-cap) ramp',
  );
  assert.ok(levelParams(CAP_LEVEL).braid < LEVEL.BRAID_MAX, 'braid is still rising at the size cap');
});

test('levelParams: item counts are a density over the area, hundreds of them deep down', () => {
  const p1 = levelParams(1);
  assert.ok(Math.abs(p1.oil - p1.cells / LEVEL.OIL_CELLS_START) <= 1, 'one flask per ~20 cells');
  assert.ok(Math.abs(p1.gems - p1.cells / LEVEL.GEM_CELLS_START) <= 1, 'one gem per ~50 cells');
  const pc = levelParams(CAP_LEVEL);
  assert.ok(pc.oil > 430 && pc.oil < 530, `~482 flasks at the cap (${pc.oil})`);
  assert.ok(pc.gems > 250 && pc.gems < 300, `~273 gems at the cap (${pc.gems})`);
  assert.ok(pc.oil + pc.gems < 1000, 'the sim and renderer are sized for ≤ ~900 items');
  // Density thins with depth: the deep levels are emptier per cell than level 1.
  assert.ok(pc.oilDensity < p1.oilDensity, 'flasks thin out');
  assert.ok(pc.gemDensity < p1.gemDensity, 'gems thin out');
  assert.ok(1 / pc.oilDensity <= LEVEL.OIL_CELLS_END + 1e-9);
});

test('levelParams: oilTargetGap is a distance one flask can actually pay for', () => {
  for (let lv = 1; lv <= 30; lv++) {
    const p = levelParams(lv);
    const flask = oilFuel(p.fuelSeconds);
    // A flask must buy the wander-inflated walk across the gap, with the level's headroom to spare.
    const cost = (p.oilTargetGap * FUEL.WANDER * FUEL.TRAVEL_OVERHEAD * p.drain) / PLAYER.WALK_SPEED;
    assert.ok(cost <= flask * gapSafety(lv) + 1e-9, `level ${lv}: gap ${p.oilTargetGap} costs ${cost.toFixed(1)} s of a ${flask.toFixed(1)} s flask`);
    // …and a full tank must cover at least one gap, or the first leg is impossible.
    assert.ok(travelTiles(p.fuelSeconds, p.drain) / FUEL.WANDER > p.oilTargetGap, `level ${lv}: the first leg fits in a tank`);
    assert.ok(Number.isInteger(p.oilTargetGap) && p.oilTargetGap > 0);
  }
  // The gap widens with the tank, then narrows again as the drain rises past the cap.
  assert.ok(levelParams(CAP_LEVEL).oilTargetGap > levelParams(1).oilTargetGap);
  assert.ok(levelParams(30).oilTargetGap < levelParams(CAP_LEVEL).oilTargetGap);
});

test('tankSeconds / drainRate / travelTiles / estimatedPathTiles: the derived curve helpers', () => {
  assert.equal(tankSeconds(1), FUEL.TANK_START);
  assert.equal(tankSeconds(CAP_LEVEL), FUEL.TANK_END);
  assert.equal(tankSeconds(1e6), FUEL.TANK_END);
  assert.equal(tankSeconds(NaN), FUEL.TANK_START, 'garbage degrades to level 1');
  assert.equal(drainRate(1), 1, 'level 1 burns at exactly 1×');
  assert.equal(drainRate(LEVEL.DRAIN_RAMP_START), 1, 'the generous half of the curve is flat');
  assert.equal(
    drainRate(LEVEL.DRAIN_RAMP_START + 5),
    1 + 5 * FUEL.DRAIN_PER_LEVEL,
    'the ramp starts inside the playable curve, not at the size cap',
  );
  assert.ok(drainRate(CAP_LEVEL) > 1.1, `drain at the cap is ${drainRate(CAP_LEVEL)}, not flat`);
  assert.equal(drainRate(1e6), FUEL.DRAIN_MAX);
  // The whole point of the ramp: depth must actually cost more torch, not just more walking.
  for (let lv = 2; lv <= 40; lv++) {
    assert.ok(drainRate(lv) >= drainRate(lv - 1), `drain is non-decreasing at level ${lv}`);
  }
  assert.ok(drainRate(12) > drainRate(3), 'a level-12 route costs more torch than a level-3 one');
  // 110 s of fuel at 3.2 tiles/s with 18 % overhead ≈ 298 tiles of walking.
  assert.ok(Math.abs(travelTiles(110, 1) - 298) < 1, `${travelTiles(110, 1).toFixed(1)} tiles`);
  assert.equal(travelTiles(110, 2), travelTiles(110, 1) / 2, 'drain halves the reach');
  assert.equal(travelTiles(-5), 0);
  assert.equal(travelTiles(NaN), 0);
  assert.equal(estimatedPathTiles(1), 16 * LEVEL.PATH_TILES_PER_SIDE);
  assert.ok(estimatedPathTiles(1e6) === LEVEL.MAX_CELLS * LEVEL.PATH_TILES_PER_SIDE);
});

test('resolveTank: the state module owns the tank; level data may lower it, never raise it', () => {
  assert.equal(resolveTank(1, 999), levelParams(1).fuelSeconds, 'a path-derived budget is clamped');
  assert.equal(resolveTank(1, 40), 40, 'a smaller offer (a demo or a fixture) is honoured');
  assert.equal(resolveTank(1, 0), levelParams(1).fuelSeconds, 'nonsense falls back to the tank');
  assert.equal(resolveTank(1, NaN), levelParams(1).fuelSeconds);
  assert.equal(resolveTank(1, undefined), levelParams(1).fuelSeconds);
  assert.equal(resolveTank(CAP_LEVEL, 655), FUEL.TANK_END, 'a 128×128 path budget is ~4× the tank');
});

test('levelParams: garbage input degrades to level 1 instead of producing NaN', () => {
  for (const bad of [0, -5, NaN, Infinity, -Infinity, /** @type {any} */ ('7'), undefined, null]) {
    const p = levelParams(/** @type {any} */ (bad));
    assert.equal(p.cols, LEVEL.BASE_CELLS, `level ${String(bad)} → level 1`);
    assert.ok(Number.isFinite(p.fuelSeconds));
  }
  assert.equal(levelParams(3.9).cols, levelParams(3).cols, 'fractional levels floor');
});

// ─── Score (ARCHITECTURE.md §1) ──────────────────────────────────────────────────────────────

test('score: the formulas match the design document exactly', () => {
  for (let lv = 1; lv <= 12; lv++) {
    assert.equal(gemScore(lv), 100 * lv);
    for (const fuel of [0, 1, 12.9, 240]) {
      assert.equal(levelBonus(lv, fuel), 500 * lv + Math.floor(fuel) * 10 * lv);
    }
  }
  assert.equal(SCORE.GEM_BASE, 100);
  assert.equal(SCORE.CLEAR_BASE, 500);
  assert.equal(SCORE.FUEL_UNIT, 10);
});

test('score: degenerate arguments never produce NaN or negative points', () => {
  assert.equal(gemScore(NaN), 100);
  assert.equal(gemScore(0), 100);
  assert.equal(levelBonus(NaN, NaN), 500);
  assert.equal(levelBonus(1, -50), 500, 'negative fuel counts as none');
  assert.equal(levelBonus(2, Infinity), 1000, 'infinite fuel is ignored, not multiplied');
});

test('oilFuel: scales with the tank and stays inside its clamps', () => {
  assert.equal(oilFuel(0), FUEL.OIL_MIN);
  assert.equal(oilFuel(NaN), FUEL.OIL_MIN);
  assert.equal(oilFuel(1e9), FUEL.OIL_MAX);
  const mid = oilFuel(110);
  assert.ok(mid > FUEL.OIL_MIN && mid < FUEL.OIL_MAX, `a mid-size tank scales (${mid})`);
  for (let tank = 0; tank <= 400; tank += 0.5) {
    assert.ok(oilFuel(tank + 0.5) >= oilFuel(tank), `monotonic in the tank size at ${tank}`);
  }
  assert.ok(Math.abs(oilFuel(FUEL.TANK_START) / FUEL.TANK_START - FUEL.OIL_FRACTION) < 1e-12);
  assert.ok(Math.abs(oilFuel(FUEL.TANK_END) / FUEL.TANK_END - FUEL.OIL_FRACTION_END) < 1e-12);
  assert.ok(FUEL.OIL_FRACTION_END >= FUEL.OIL_FRACTION, 'flasks grow (never shrink) with depth');
  // Every tank the level curve can produce must land strictly inside the clamps, or the flask
  // stops tracking the tank and the per-flask economy quietly stops holding.
  for (let lv = 1; lv <= 40; lv++) {
    const tank = levelParams(lv).fuelSeconds;
    const v = oilFuel(tank);
    assert.ok(v > FUEL.OIL_MIN && v < FUEL.OIL_MAX, `level ${lv}: flask ${v} s of a ${tank} s tank`);
    const frac = v / tank;
    assert.ok(
      frac >= FUEL.OIL_FRACTION - 1e-9 && frac <= FUEL.OIL_FRACTION_END + 1e-9,
      `level ${lv}: the clamps never bind on the curve (${frac})`,
    );
    assert.ok(v < tank, `level ${lv}: a flask is never a whole tank`);
  }
});

test('sprint: a sprinted tile always costs more torch than a walked one', () => {
  // Regression: FUEL.SPRINT_MULT 1.5 against PLAYER.SPRINT_MULT 1.6 made sprinting 37 % faster AND
  // 6 % cheaper per tile, so the only trade-off in the controls ran backwards.
  const premium = FUEL.SPRINT_MULT / PLAYER.SPRINT_MULT;
  assert.ok(premium >= FUEL.SPRINT_TILE_PREMIUM_MIN, `fuel per sprinted tile is ${premium.toFixed(3)}× a walked one`);
  assert.ok(FUEL.SPRINT_TILE_PREMIUM_MIN >= 1.15);
  assert.ok(PLAYER.SPRINT_MULT > 1, 'sprint is still faster');
});

test('gapSafety: headroom ramps over the size curve and never reaches 1', () => {
  assert.equal(gapSafety(1), FUEL.GAP_SAFETY);
  assert.equal(gapSafety(CAP_LEVEL), FUEL.GAP_SAFETY_END);
  assert.equal(gapSafety(1e6), FUEL.GAP_SAFETY_END);
  assert.equal(gapSafety(NaN), FUEL.GAP_SAFETY);
  for (let lv = 1; lv <= 40; lv++) {
    const g = gapSafety(lv);
    assert.ok(g > 0 && g < 1, `level ${lv}: ${g} keeps the chain provably closed`);
    if (lv > 1) assert.ok(g >= gapSafety(lv - 1), `non-decreasing at level ${lv}`);
  }
});

// ─── Settings ────────────────────────────────────────────────────────────────────────────────

test('defaultSettings: a complete, fresh, in-range object every call', () => {
  const a = defaultSettings();
  const b = defaultSettings();
  assert.notEqual(a, b, 'callers own the object');
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a).sort(), [...SETTING_KEYS].sort());
  assert.ok(a.volume >= 0 && a.volume <= 1);
  assert.ok(a.sensitivity >= 0.2 && a.sensitivity <= 3);
});

test('coerceSetting: clamps numbers, is strict about booleans, rejects unknown keys', () => {
  assert.equal(coerceSetting('volume', 0.5), 0.5);
  assert.equal(coerceSetting('volume', 4), 1);
  assert.equal(coerceSetting('volume', -4), 0);
  assert.equal(coerceSetting('volume', NaN), undefined);
  assert.equal(coerceSetting('volume', '0.5'), undefined, 'strings are not coerced');
  assert.equal(coerceSetting('sensitivity', 0.01), 0.2);
  assert.equal(coerceSetting('sensitivity', 99), 3);
  assert.equal(coerceSetting('scanlines', true), true);
  assert.equal(coerceSetting('scanlines', 1), true);
  assert.equal(coerceSetting('scanlines', 0), false);
  assert.equal(coerceSetting('scanlines', 'true'), undefined);
  assert.equal(coerceSetting('scanlines', 2), undefined);
  assert.equal(coerceSetting('nope', 1), undefined);
  assert.equal(coerceSetting('toString', 1), undefined, 'inherited properties are not settings');
  assert.equal(coerceSetting('volume', Infinity), undefined);
});

test('coerceSetting: mapMode is an enum — only a listed value is taken', () => {
  for (const mode of MAP_MODES) assert.equal(coerceSetting('mapMode', mode), mode);
  assert.equal(coerceSetting('mapMode', 'sideways'), undefined, 'an unlisted value is rejected');
  assert.equal(coerceSetting('mapMode', 1), undefined, 'a number is not a mode');
  assert.equal(coerceSetting('mapMode', true), undefined);
  assert.equal(coerceSetting('mapMode', null), undefined);
  assert.equal(defaultSettings().mapMode, 'corner', 'the corner window is the default');
  // The legacy boolean survives alongside it: other consumers (audio, touch, older call sites)
  // still read `minimap`, and main.js writes both on every cycle.
  assert.equal(typeof defaultSettings().minimap, 'boolean');
  // A persisted record from before this wave has no mapMode and must still load.
  const legacy = sanitizeSettings({ volume: 0.3, minimap: false });
  assert.equal(legacy.mapMode, 'corner', 'missing enum falls back to the default');
  assert.equal(legacy.minimap, false, 'the legacy boolean is still honoured');
});

test('sanitizeSettings: fills gaps, drops junk, survives any input', () => {
  assert.deepEqual(sanitizeSettings(undefined), defaultSettings());
  assert.deepEqual(sanitizeSettings(null), defaultSettings());
  assert.deepEqual(sanitizeSettings(42), defaultSettings());
  assert.deepEqual(sanitizeSettings('{}'), defaultSettings());
  const s = sanitizeSettings({ volume: 0.25, minimap: false, sensitivity: 100, junk: 'x' });
  assert.equal(s.volume, 0.25);
  assert.equal(s.minimap, false);
  assert.equal(s.sensitivity, 3);
  assert.equal(s.music, defaultSettings().music, 'untouched keys keep their default');
  assert.equal(/** @type {any} */ (s).junk, undefined);
  assert.deepEqual(Object.keys(s).sort(), [...SETTING_KEYS].sort());
});

test('sanitizeBest: only non-negative integers survive', () => {
  assert.deepEqual(sanitizeBest(undefined), { score: 0, level: 0 });
  assert.deepEqual(sanitizeBest({ score: 1200.7, level: 3.9 }), { score: 1200, level: 3 });
  assert.deepEqual(sanitizeBest({ score: -5, level: -1 }), { score: 0, level: 0 });
  assert.deepEqual(sanitizeBest({ score: '900', level: null }), { score: 0, level: 0 });
  assert.deepEqual(sanitizeBest({ score: NaN, level: Infinity }), { score: 0, level: 0 });
  assert.deepEqual(sanitizeBest([1, 2]), { score: 0, level: 0 });
});
