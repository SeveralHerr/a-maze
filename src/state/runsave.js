// @ts-check
/**
 * @file Saved runs (ARCHITECTURE.md §4.10) — a descent can be put down and picked up again instead
 * of being abandoned. Pure data in, pure data out: no storage here (`save.js` owns that) and no
 * phase changes (the `continueRun` reducer and `applyRunSave` in `game.js` own those).
 *
 * ## What a save is
 * A level is rebuilt from its seed rather than stored: `(params, seed)` → identical level (§4.4), so
 * a save names the run seed, the depth and the exact maze seed, and records only what play changed:
 * - **run totals** — score, time, distance, best combo — and the record the run started against;
 * - **mid-level** (a save made from pause): the player's pose, the per-level `run` fields, which
 *   items are taken (one bit each), the explored grid (one bit per tile) and the chalk marks.
 * A save made on a level clear is a **checkpoint** instead: `mid` is null and `level` is the next
 * depth, which is simply built fresh on continue.
 *
 * ## Size
 * Bits are packed and base64'd: the 257×257 cap level's explored grid is 8 257 bytes → 11 012
 * characters, its ~820 items 138. A whole save at the cap is ~11.5 kB of JSON.
 *
 * ## Trust
 * A save is untrusted input (it comes from `localStorage`). `sanitizeRunSave` rebuilds it field by
 * field and returns null for anything malformed; `applyMid` refuses a snapshot whose maze
 * fingerprint (width, height, item count, tile hash) does not match the level that was actually
 * built — a build of the generator from after the save was made — and the level then starts fresh
 * with the run's totals intact, rather than restoring bits onto the wrong maze.
 */

import { TILE } from '../maze/constants.js';
import { coerceMode } from './balance.js';
import { ENEMY_KINDS, ST_DEAD as FOE_DEAD } from './combat.js';

/** @typedef {import('../core/types.js').GameState} GameState */
/** @typedef {import('../core/types.js').LevelData} LevelData */
/** @typedef {import('../core/types.js').ChalkMark} ChalkMark */

/** Schema version inside a saved run. Bump when the shape changes incompatibly. */
export const RUN_SAVE_VERSION = 1;

/** Deepest level a save may name. Far past anything playable; bounds garbage. */
const MAX_LEVEL = 100000;

/** Most chalk marks a save may carry (a level's charges are single digits). */
const MAX_MARKS = 512;

/**
 * Most enemies a save may carry (New Descent, §4.11). Deliberately `COMBAT.MAX_ENEMIES` spelled out
 * rather than imported: this is a **storage** bound, and it must not move when the gameplay cap is
 * retuned — a save written at a higher cap has to stay readable by the build that lowered it.
 */
const MAX_FOES = 256;

/** Largest map a save may describe, in tiles (the cap is 257×257; 4096² is the generator's limit). */
const MAX_TILES = 4096 * 4096;

/**
 * The run totals a save carries, restored whatever kind of save it is.
 * @typedef {Object} RunTotals
 * @property {number} score
 * @property {number} totalTime
 * @property {number} distance
 * @property {number} bestCombo
 */

/**
 * The per-level state a mid-level save carries.
 * @typedef {Object} MidLevel
 * @property {number} w          maze width, tiles (fingerprint)
 * @property {number} h          maze height, tiles (fingerprint)
 * @property {number} items      item count (fingerprint)
 * @property {number} hash       FNV-1a of the tile map (fingerprint)
 * @property {number} x          player position, tiles
 * @property {number} y
 * @property {number} angle      radians
 * @property {number} fuel       seconds
 * @property {number} gems       gems collected this level
 * @property {number} levelTime  seconds
 * @property {number} refuels
 * @property {number} chalk      charges left
 * @property {number} reserve    siphon reserve, seconds
 * @property {boolean} emberUsed
 * @property {boolean} mapFound
 * @property {string} taken      items[i].taken, one bit each, base64
 * @property {string} explored   explored[i] !== 0, one bit each, base64
 * @property {Array<[number, number, number, number]>} marks  chalk marks as [x, y, face, seed]
 * @property {number} hp         player health (New Descent, §4.11; 0 in Classic Descent)
 * @property {number} kills      enemies felled this run
 * @property {number[]} foes     four numbers per live enemy - kind index, x*64, y*64, hp - so a
 *   40-enemy floor costs ~160 numbers. Empty in Classic Descent, and an absent or rejected list
 *   simply leaves the freshly spawned set alone rather than refusing the whole save
 */

/**
 * A saved run.
 * @typedef {Object} RunSave
 * @property {number} v           RUN_SAVE_VERSION
 * @property {import('../core/types.js').Mode} mode  which mode this run is (§4.11). A save written
 *   before the modes wave has no `mode` and loads as `'classic'`, which is what it was.
 * @property {number} seed        run seed (uint32)
 * @property {number} level       the depth continue loads
 * @property {number|null} mazeSeed  the exact maze seed of a mid-level save; null for a checkpoint
 * @property {number} runBest     the best score the run started against (for "NEW BEST")
 * @property {RunTotals} totals
 * @property {MidLevel|null} mid
 */

// ─── Bits and base64 ─────────────────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup for {@link B64}; −1 for characters that are not in it. */
const B64_INDEX = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/**
 * Pack `count` truthiness bits (LSB first) and base64 them. Built as an array of chunks joined once,
 * so a 66 kB grid costs a handful of string allocations, not one per character.
 * @param {(i:number) => boolean} bit
 * @param {number} count
 * @returns {string}
 */
export function encodeBits(bit, count) {
  const bytes = new Uint8Array((count + 7) >> 3);
  for (let i = 0; i < count; i++) if (bit(i)) bytes[i >> 3] |= 1 << (i & 7);
  /** @type {string[]} */
  const parts = [];
  const CHUNK = 3 * 4096;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    let out = '';
    const end = Math.min(bytes.length, start + CHUNK);
    for (let i = start; i < end; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < end ? bytes[i + 1] : 0;
      const b2 = i + 2 < end ? bytes[i + 2] : 0;
      out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)];
      out += i + 1 < end ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
      out += i + 2 < end ? B64[b2 & 63] : '=';
    }
    parts.push(out);
  }
  return parts.join('');
}

/**
 * Decode {@link encodeBits} into `count` bytes of 0/1. Returns null for a string that is not exactly
 * the base64 of `ceil(count / 8)` bytes, so a truncated or edited save cannot half-apply.
 * @param {unknown} text
 * @param {number} count
 * @returns {Uint8Array|null}
 */
export function decodeBits(text, count) {
  if (typeof text !== 'string') return null;
  const nBytes = (count + 7) >> 3;
  if (text.length !== Math.ceil(nBytes / 3) * 4) return null;
  const bytes = new Uint8Array(nBytes);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const c0 = text.charCodeAt(i);
    const c1 = text.charCodeAt(i + 1);
    const c2 = text.charCodeAt(i + 2);
    const c3 = text.charCodeAt(i + 3);
    const v0 = c0 < 128 ? B64_INDEX[c0] : -1;
    const v1 = c1 < 128 ? B64_INDEX[c1] : -1;
    const v2 = c2 === 61 ? 0 : c2 < 128 ? B64_INDEX[c2] : -1;
    const v3 = c3 === 61 ? 0 : c3 < 128 ? B64_INDEX[c3] : -1;
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return null;
    if (o < nBytes) bytes[o++] = (v0 << 2) | (v1 >> 4);
    if (o < nBytes) bytes[o++] = ((v1 & 15) << 4) | (v2 >> 2);
    if (o < nBytes) bytes[o++] = ((v2 & 3) << 6) | v3;
  }
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return out;
}

/**
 * FNV-1a over a tile map — the fingerprint that ties a mid-level save to the maze it was made on.
 * @param {Uint8Array} tiles
 * @returns {number} uint32
 */
export function tileHash(tiles) {
  let h = 0x811c9dc5;
  for (let i = 0; i < tiles.length; i++) {
    h ^= tiles[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ─── Snapshot ────────────────────────────────────────────────────────────────────────────────

/**
 * The run totals of `state`.
 * @param {Readonly<GameState>} state
 * @returns {RunTotals}
 */
function totalsOf(state) {
  const run = state.run;
  return { score: run.score, totalTime: run.totalTime, distance: run.distance, bestCombo: run.bestCombo };
}

/**
 * The best score the run started against (`sim.runBestScore`), read defensively: a hand-built state
 * without the sim scratch falls back to the live record.
 * @param {Readonly<GameState>} state
 * @returns {number}
 */
function runBestOf(state) {
  const sim = /** @type {any} */ (state).sim;
  return sim && typeof sim.runBestScore === 'number' ? sim.runBestScore : state.best.score;
}

/**
 * Snapshot a run that is in the middle of a level (`playing` or `paused`). O(tiles) — call it on a
 * pause or when the page goes away, never per step.
 * @param {Readonly<GameState>} state
 * @returns {RunSave|null} null when no level is loaded
 */
export function snapshotMidLevel(state) {
  const level = state.levelData;
  const explored = state.explored;
  if (level === null || explored === null) return null;
  const maze = level.maze;
  const run = state.run;
  const p = state.player;
  const items = level.items;
  const marks = Array.isArray(state.marks) ? state.marks : [];
  return {
    v: RUN_SAVE_VERSION,
    mode: coerceMode(state.mode),
    seed: state.seed >>> 0,
    level: state.level,
    mazeSeed: maze.seed >>> 0,
    runBest: runBestOf(state),
    totals: totalsOf(state),
    mid: {
      w: maze.width,
      h: maze.height,
      items: items.length,
      hash: tileHash(maze.tiles),
      x: p.x,
      y: p.y,
      angle: p.angle,
      fuel: run.fuel,
      gems: run.gems,
      levelTime: run.levelTime,
      refuels: run.refuels,
      chalk: run.chalk,
      reserve: run.reserve,
      emberUsed: run.emberUsed === true,
      mapFound: run.mapFound === true,
      taken: encodeBits((i) => items[i].taken === true, items.length),
      explored: encodeBits((i) => explored[i] !== 0, explored.length),
      marks: marks.slice(0, MAX_MARKS).map((m) => /** @type {[number, number, number, number]} */ ([m.x, m.y, m.face, m.seed])),
      hp: run.hp > 0 ? run.hp : 0,
      kills: run.kills > 0 ? run.kills : 0,
      foes: encodeFoes(state),
    },
  };
}

/**
 * Pack the live enemies into a flat number list: kind index, x and y in 64ths of a tile, and hit
 * points - four numbers each (ARCHITECTURE.md §4.11). Positions are quantised because a sixty-fourth
 * of a tile is finer than a monster's silhouette, and a full double per coordinate would triple the
 * list for nothing. Dead slots are skipped, so a cleared floor saves an empty list.
 * @param {Readonly<GameState>} state
 * @returns {number[]}
 */
function encodeFoes(state) {
  /** @type {number[]} */
  const out = [];
  const list = /** @type {any[]} */ (/** @type {any} */ (state).enemies);
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < list.length && out.length < MAX_FOES * 4; i++) {
    const e = list[i];
    if (!e || e.st === FOE_DEAD || !(e.hp > 0)) continue;
    const kind = ENEMY_KINDS.indexOf(e.kind);
    out.push(kind < 0 ? 0 : kind, Math.round(e.x * 64), Math.round(e.y * 64), Math.round(e.hp));
  }
  return out;
}

/**
 * Snapshot a run that has just cleared a level (`levelComplete`): a checkpoint at the next depth.
 * @param {Readonly<GameState>} state
 * @returns {RunSave}
 */
export function snapshotCheckpoint(state) {
  return {
    v: RUN_SAVE_VERSION,
    mode: coerceMode(state.mode),
    seed: state.seed >>> 0,
    level: state.level + 1,
    mazeSeed: null,
    runBest: runBestOf(state),
    totals: totalsOf(state),
    mid: null,
  };
}

// ─── Sanitising ──────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} v
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function num(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/**
 * @param {unknown} v
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function int(v, min, max) {
  const n = num(v, min, max);
  return n !== null && Number.isInteger(n) ? n : null;
}

/**
 * Rebuild a `RunSave` from anything at all, or null when it is not one. Every field is checked;
 * nothing from the input object is kept by reference.
 * @param {unknown} raw
 * @returns {RunSave|null}
 */
export function sanitizeRunSave(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (r.v !== RUN_SAVE_VERSION) return null;
  const seed = int(r.seed, 0, 0xffffffff);
  const level = int(r.level, 1, MAX_LEVEL);
  const runBest = num(r.runBest, 0, Number.MAX_SAFE_INTEGER);
  if (seed === null || level === null || runBest === null) return null;
  const t = r.totals;
  if (t === null || typeof t !== 'object') return null;
  const tt = /** @type {Record<string, unknown>} */ (t);
  const score = num(tt.score, 0, Number.MAX_SAFE_INTEGER);
  const totalTime = num(tt.totalTime, 0, 1e9);
  const distance = num(tt.distance, 0, 1e12);
  const bestCombo = int(tt.bestCombo, 0, 1e9);
  if (score === null || totalTime === null || distance === null || bestCombo === null) return null;
  /** @type {RunSave} */
  const out = {
    v: RUN_SAVE_VERSION,
    // Absent means classic: every save written before the modes wave describes a classic run (§4.11).
    mode: coerceMode(r.mode),
    seed,
    level,
    mazeSeed: null,
    runBest,
    totals: { score, totalTime, distance, bestCombo },
    mid: null,
  };
  if (r.mid === null || r.mid === undefined) return out;
  const mazeSeed = int(r.mazeSeed, 0, 0xffffffff);
  const mid = sanitizeMid(r.mid);
  if (mazeSeed === null || mid === null) return null;
  out.mazeSeed = mazeSeed;
  out.mid = mid;
  return out;
}

/**
 * @param {unknown} raw
 * @returns {MidLevel|null}
 */
function sanitizeMid(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = /** @type {Record<string, unknown>} */ (raw);
  const w = int(m.w, 1, 4096);
  const h = int(m.h, 1, 4096);
  const items = int(m.items, 0, 1 << 20);
  const hash = int(m.hash, 0, 0xffffffff);
  if (w === null || h === null || items === null || hash === null || w * h > MAX_TILES) return null;
  const x = num(m.x, 0, w);
  const y = num(m.y, 0, h);
  const angle = num(m.angle, -1e3, 1e3);
  const fuel = num(m.fuel, 0, 1e6);
  const gems = int(m.gems, 0, items);
  const levelTime = num(m.levelTime, 0, 1e9);
  const refuels = int(m.refuels, 0, 1e9);
  const chalk = int(m.chalk, 0, 1e6);
  const reserve = num(m.reserve, 0, 1e6);
  // New Descent (§4.11). Absent in a classic save and in every save written before the modes wave,
  // so these degrade to zero rather than rejecting the record.
  const hp = m.hp === undefined ? 0 : num(m.hp, 0, 1e6);
  const kills = m.kills === undefined ? 0 : int(m.kills, 0, 1e9);
  if (
    x === null || y === null || angle === null || fuel === null || gems === null || levelTime === null ||
    refuels === null || chalk === null || reserve === null || hp === null || kills === null
  ) {
    return null;
  }
  if (typeof m.taken !== 'string' || typeof m.explored !== 'string') return null;
  // Lengths are checked here; the bits themselves are decoded only when applied.
  if (m.taken.length !== Math.ceil(((items + 7) >> 3) / 3) * 4) return null;
  if (m.explored.length !== Math.ceil(((w * h + 7) >> 3) / 3) * 4) return null;
  if (!Array.isArray(m.marks) || m.marks.length > MAX_MARKS) return null;
  /** @type {Array<[number, number, number, number]>} */
  const marks = [];
  for (const mk of m.marks) {
    if (!Array.isArray(mk) || mk.length !== 4) return null;
    const mx = int(mk[0], 0, w - 1);
    const my = int(mk[1], 0, h - 1);
    const face = int(mk[2], 0, 3);
    const mseed = int(mk[3], 0, 0xffffffff);
    if (mx === null || my === null || face === null || mseed === null) return null;
    marks.push([mx, my, face, mseed]);
  }
  /** @type {number[]} */
  const foes = [];
  if (Array.isArray(m.foes) && m.foes.length <= MAX_FOES * 4 && m.foes.length % 4 === 0) {
    for (let i = 0; i < m.foes.length; i += 4) {
      const kind = int(m.foes[i], 0, ENEMY_KINDS.length - 1);
      const fx = int(m.foes[i + 1], 0, w * 64);
      const fy = int(m.foes[i + 2], 0, h * 64);
      const fhp = int(m.foes[i + 3], 1, 1e6);
      // One malformed entry drops the enemy list, not the save: the floor then starts with the
      // monsters it would have had anyway, which is a fair fallback and never a broken one.
      if (kind === null || fx === null || fy === null || fhp === null) {
        foes.length = 0;
        break;
      }
      foes.push(kind, fx, fy, fhp);
    }
  }
  return {
    w, h, items, hash, x, y, angle, fuel, gems, levelTime, refuels, chalk, reserve,
    emberUsed: m.emberUsed === true,
    mapFound: m.mapFound === true,
    taken: m.taken,
    explored: m.explored,
    marks,
    hp,
    kills,
    foes,
  };
}

/**
 * What the title shows for a saved run.
 * @typedef {{level:number, score:number, mid:boolean}} RunSummary
 */

/**
 * @param {RunSave|null} save
 * @returns {RunSummary|null}
 */
export function summarizeRunSave(save) {
  return save === null ? null : { level: save.level, score: save.totals.score, mid: save.mid !== null };
}

// ─── Restore ─────────────────────────────────────────────────────────────────────────────────

/**
 * Put a mid-level snapshot back onto a freshly installed level. The caller (the `levelReady`
 * reducer) has already installed the level, placed the player at the start and set the per-level
 * fields from the current perks; this overwrites them with what the save recorded.
 *
 * @param {GameState} state a state in which `levelReady` has just installed `level`
 * @param {MidLevel} mid
 * @returns {boolean} false — and nothing touched — when the fingerprint or the bits do not match
 */
export function applyMid(state, mid) {
  const level = state.levelData;
  const explored = state.explored;
  if (level === null || explored === null) return false;
  const maze = level.maze;
  const items = level.items;
  if (maze.width !== mid.w || maze.height !== mid.h || items.length !== mid.items) return false;
  if (explored.length !== mid.w * mid.h || tileHash(maze.tiles) !== mid.hash) return false;
  const taken = decodeBits(mid.taken, items.length);
  const seen = decodeBits(mid.explored, explored.length);
  if (taken === null || seen === null) return false;
  // The pose must be standing on floor, or the body would start inside a wall.
  const tx = Math.floor(mid.x);
  const ty = Math.floor(mid.y);
  if (tx < 0 || ty < 0 || tx >= maze.width || ty >= maze.height || maze.tiles[ty * maze.width + tx] !== TILE.FLOOR) {
    return false;
  }

  for (let i = 0; i < items.length; i++) items[i].taken = taken[i] === 1;
  explored.set(seen);

  const p = state.player;
  p.x = mid.x;
  p.y = mid.y;
  p.angle = mid.angle;
  p.px = p.x;
  p.py = p.y;
  p.pangle = p.angle;
  p.vx = 0;
  p.vy = 0;

  const run = state.run;
  // A rank bought at the Shrine since the save may have grown the tank; never beyond it.
  run.fuel = Math.min(mid.fuel, run.fuelMax);
  run.gems = Math.min(mid.gems, run.gemsTotal);
  run.levelTime = mid.levelTime;
  run.refuels = mid.refuels;
  // Clamped to what this run can actually hold, not merely to a sane-looking range: a save is a
  // string in the player's own browser, so `chalk: 999999` must not restore as unlimited chalk, and
  // a reserve past the Siphon's capacity must not restore as a second tank. `sanitizeMid` only
  // rejects nonsense; the perks are what say how much is legitimate.
  const perks = state.perks;
  run.chalk = perks ? Math.min(mid.chalk, perks.chalk) : mid.chalk;
  run.reserve = perks ? Math.min(mid.reserve, perks.siphonCap) : mid.reserve;
  run.emberUsed = mid.emberUsed;
  run.mapFound = mid.mapFound;
  // New Descent (§4.11): health is a run resource, so it comes back with the run. A classic save,
  // or one that predates the mode, leaves the freshly reset values alone.
  if (run.hpMax > 0 && mid.hp > 0) run.hp = Math.min(mid.hp, run.hpMax);
  if (mid.kills > 0) run.kills = mid.kills;
  applyFoes(state, mid);

  /** @type {ChalkMark[]} */
  const marks = [];
  for (const [x, y, face, seed] of mid.marks) marks.push({ x, y, face: /** @type {0|1|2|3} */ (face), seed });
  state.marks = marks;
  return true;
}

/**
 * Put the saved enemies back onto the level `levelReady` has just spawned (§4.11).
 *
 * The pool is already the right size for this depth, so this rewrites the leading `foes.length / 4`
 * slots and kills the rest: a floor saved half-cleared comes back half-cleared. An empty or absent
 * list leaves the fresh spawn alone, which is the documented fallback for a classic save or one
 * written before the modes wave.
 * @param {GameState} state
 * @param {MidLevel} mid
 * @returns {void}
 */
function applyFoes(state, mid) {
  const list = /** @type {any[]} */ (/** @type {any} */ (state).enemies);
  if (!Array.isArray(list) || list.length === 0) return;
  const foes = mid.foes;
  if (!Array.isArray(foes) || foes.length === 0) return;
  const n = Math.min(list.length, foes.length >> 2);
  for (let i = 0; i < n; i++) {
    const e = list[i];
    e.kind = ENEMY_KINDS[foes[i * 4]] || 'crawler';
    e.x = foes[i * 4 + 1] / 64;
    e.y = foes[i * 4 + 2] / 64;
    e.px = e.x;
    e.py = e.y;
    e.hpMax = Math.max(e.hpMax, foes[i * 4 + 3]);
    e.hp = Math.min(e.hpMax, foes[i * 4 + 3]);
    e.st = 0;
    e.t = 0;
    e.cool = 0;
    e.hunt = 0;
    e.hurt = 0;
    e.awake = false;
  }
  // Everything past what the save recorded had already been killed.
  for (let i = n; i < list.length; i++) {
    const e = list[i];
    e.st = FOE_DEAD;
    e.hp = 0;
    e.t = 1e3;
    e.awake = false;
  }
}
