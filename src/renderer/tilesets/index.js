// @ts-check
/**
 * @file Tileset registry — which walls, floors and ceilings each floor of the dungeon wears.
 *
 * Floor 1 is the Old Keep painted by `../textures.js`. Every deeper floor steps to the next tileset
 * in {@link TILESETS} (see {@link tilesetIndexForLevel}), and past the last one the sequence repeats.
 * A tileset only repaints the world surfaces; sprites (sconce, portal, gem, flask, scroll, chalk)
 * are shared by every floor so a pickup reads the same at any depth.
 *
 * A tileset module (`./<id>.js`) exports `TILESET: TilesetDef`, and its colours live in
 * `./<id>.palette.js`, which `../palette.js` appends to the master palette. `paint` returns raw
 * palette-index buffers in the exact shape of the Old Keep's (see `TilesetSurfaces`), and must obey
 * the `textures.js` invariants: row-major 64×64, no index 0, floors and ceilings seamless on both
 * axes, walls seamless horizontally, deterministic for a seed — and **seamless across variants**:
 * the raycaster ties texels to world position (no per-tile offset, mirror or flip), so every wall
 * variant must meet every other at a tile seam, and floor[0]/floor[1] and ceiling[0]/ceiling[1]
 * likewise on both axes. Variants share their structure (joints, courses, bedding) along the tile
 * edges and differ in the interior and the surface detail. `tilesets.test.mjs` measures it.
 *
 * Node-safe: no DOM access.
 */

import { createRng } from '../../core/rng.js';
import { C } from '../palette.js';
import { createTextures, finish } from '../textures.js';
import { TILESET as CISTERN } from './cistern.js';
import { TILESET as OSSUARY } from './ossuary.js';
import { TILESET as GROTTO } from './grotto.js';
import { TILESET as TEMPLE } from './temple.js';
import { TILESET as GLACIER } from './glacier.js';
import { TILESET as FORGE } from './forge.js';

/** @typedef {import('../textures.js').TextureSet} TextureSet */

/**
 * Raw surfaces a tileset paints: palette-index buffers, `SIZE × SIZE`, row-major.
 * @typedef {Object} TilesetSurfaces
 * @property {Uint8Array[]} wall     exactly 4 variants, by frequency: [0] plain (8/16 of tiles),
 *   [1] common variant (5/16), [2] accent (2/16), [3] rare showpiece (1/16)
 * @property {Uint8Array[]} floor    exactly 3: [0] and [1] the two common floors (≈15/32 each),
 *   [2] a rare special tile (1/16) — a grate, drain, mosaic, rune
 * @property {Uint8Array[]} ceiling  exactly 2: [0] plain, [1] with a structural band (beam, rib,
 *   arch) running across the tile; the raycaster transposes both for east-west corridors
 */

/**
 * @typedef {Object} TilesetDef
 * @property {string} id      stable id, also the file name
 * @property {string} name    display name
 * @property {string} fog     palette name of the colour distance fades into on this floor
 * @property {number} [warmth] 0..1 how strongly torchlight tints the floor amber (1 = the Keep). A
 *   cold palette turns it down, or the torch paints ice and fungus the same tan as the Keep's stone
 * @property {((seedOf:(name:string) => number) => TilesetSurfaces)|null} paint  null = reuse the
 *   Old Keep surfaces (only the Keep itself and unfinished stubs)
 */

/** The Old Keep: the surfaces `createTextures` already paints. @type {TilesetDef} */
const KEEP = Object.freeze({ id: 'keep', name: 'The Old Keep', fog: 'fog', warmth: 1, paint: null });

/**
 * Torch warmth per tileset id. Kept here (not in the painters' modules) because it is a lighting
 * decision tuned against the rendered floors, not part of the painting.
 * @type {Readonly<Record<string, number>>}
 */
const WARMTH = Object.freeze({ keep: 1, cistern: 0.6, ossuary: 1, grotto: 0.5, temple: 0.9, glacier: 0.35, forge: 1 });

/** Every tileset, in floor order. @type {ReadonlyArray<TilesetDef>} */
export const TILESETS = Object.freeze([KEEP, CISTERN, OSSUARY, GROTTO, TEMPLE, GLACIER, FORGE]);

/**
 * Which tileset a floor wears: floors run through the list in order and wrap past its end.
 * @param {number} level 1-based floor number
 * @param {number} [floorsPer] floors each tileset lasts (`WORLD.FLOORS_PER_TILESET`)
 * @returns {number} index into {@link TILESETS}
 */
export function tilesetIndexForLevel(level, floorsPer = 1) {
  const per = Number.isFinite(floorsPer) && floorsPer >= 1 ? Math.floor(floorsPer) : 1;
  const l = Number.isFinite(level) && level >= 1 ? Math.floor(level) : 1;
  return Math.floor((l - 1) / per) % TILESETS.length;
}

/**
 * Index of a tileset by id, or -1.
 * @param {string|null|undefined} id
 * @returns {number}
 */
export function tilesetIndexById(id) {
  for (let i = 0; i < TILESETS.length; i++) if (TILESETS[i].id === id) return i;
  return -1;
}

/**
 * Build the texture set for one tileset. Pass `base` (the Old Keep set for the same seed) to share
 * its sprites instead of repainting them.
 * @param {number} index into {@link TILESETS} (clamped)
 * @param {number} [seed]
 * @param {TextureSet} [base]
 * @returns {TextureSet}
 */
export function createTilesetTextures(index, seed, base) {
  const keep = base || createTextures(seed);
  const i = Number.isFinite(index) ? Math.max(0, Math.min(TILESETS.length - 1, Math.floor(index))) : 0;
  const def = TILESETS[i];
  const fog = C[def.fog] !== undefined ? C[def.fog] : C.fog;
  const warmth = WARMTH[def.id] !== undefined ? WARMTH[def.id] : 1;
  if (def.paint === null) return { ...keep, tileset: def.id, fog, warmth };
  const root = createRng((keep.seed >>> 0) ^ 0x7115e7);
  const surfaces = def.paint((name) => root.fork(def.id + ':' + name).u32());
  const wrap = (/** @type {Uint8Array[]} */ list) => list.map((ix) => finish(ix, null, false));
  return {
    ...keep,
    tileset: def.id,
    fog,
    warmth,
    wall: wrap(surfaces.wall),
    floor: wrap(surfaces.floor),
    ceiling: wrap(surfaces.ceiling),
  };
}
