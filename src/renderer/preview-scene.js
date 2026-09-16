// @ts-check
/**
 * @file The renderer's fixed test scene: a hand-built 15×15 maze with torches, items and six
 * camera poses.
 *
 * WHY it is its own module: `preview.js` touches `document` and `location` at import time, so the
 * scene it shows could not be loaded in Node, and the colour tests had to guess at poses instead
 * of measuring the exact frames a person sees in `preview.html?pose=N`. Keeping the scene here —
 * pure data, no DOM — lets `preview.js` and `raycaster.test.mjs` render the same pixels.
 *
 * Not shipped: nothing in `src/main.js` imports this.
 */

import { DIR_DX, DIR_DY } from '../maze/constants.js';

/**
 * Three concentric corridors joined by three doorways, with the exit portal in the middle. Chosen
 * over a generated maze because every feature the renderer has to get right is visible from a
 * short walk: long straight runs (texture perspective), inside and outside corners (wall shading),
 * doorways (sprite occlusion), and a dead centre to look back out of.
 * Legend: `#` wall, `.` floor. 15×15 tiles, sealed border, 7×7 logical cells.
 */
export const MAP = Object.freeze([
  '###############',
  '#.............#',
  '#.#####.#####.#',
  '#.#.........#.#',
  '#.#.#######.#.#',
  '#.#.#.....#.#.#',
  '#.#.#.###.#.#.#',
  '#.#.#.#.#...#.#',
  '#.#.#.#.#.#.#.#',
  '#.#.#.....#.#.#',
  '#.#.#######.#.#',
  '#.#.........#.#',
  '#.###########.#',
  '#.............#',
  '###############',
]);

/**
 * Build a fresh `Maze` from {@link MAP}. A new object each call, so a test can mutate its tiles
 * without touching another test's scene.
 * @returns {import('../core/types.js').Maze}
 */
export function buildPreviewMaze() {
  const height = MAP.length;
  const width = MAP[0].length;
  const tiles = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = MAP[y];
    if (row.length !== width) throw new Error(`preview: map row ${y} is ${row.length} wide`);
    for (let x = 0; x < width; x++) tiles[y * width + x] = row.charCodeAt(x) === 35 ? 1 : 0;
  }
  return {
    width,
    height,
    cols: (width - 1) / 2,
    rows: (height - 1) / 2,
    tiles,
    start: { x: 1, y: 1 },
    exit: { x: 7, y: 7 },
    seed: 1,
  };
}

/**
 * True when tile `(x, y)` of {@link MAP} is walkable.
 * @param {number} x tile x
 * @param {number} y tile y
 * @returns {boolean}
 */
function isFloor(x, y) {
  return y >= 0 && y < MAP.length && x >= 0 && x < MAP[0].length && MAP[y].charCodeAt(x) !== 35;
}

/**
 * Wall-mounted torches. Each entry is validated: the tile must be a wall and the tile it faces must
 * be floor, or the sconce would be buried inside the masonry. `Torch.face` uses the maze module's
 * direction numbering (0=E 1=S 2=W 3=N), so its tables apply directly.
 * @type {ReadonlyArray<import('../core/types.js').Torch>}
 */
export const PREVIEW_TORCHES = Object.freeze(
  /** @type {import('../core/types.js').Torch[]} */ ([
    { x: 4, y: 0, face: 1 },
    { x: 10, y: 0, face: 1 },
    { x: 0, y: 7, face: 0 },
    { x: 14, y: 7, face: 2 },
    { x: 7, y: 14, face: 3 },
    { x: 4, y: 4, face: 3 },
    { x: 8, y: 4, face: 3 },
    { x: 2, y: 5, face: 0 },
    { x: 12, y: 5, face: 2 },
    { x: 6, y: 6, face: 3 },
    { x: 8, y: 6, face: 3 },
    { x: 6, y: 8, face: 1 },
    { x: 8, y: 8, face: 1 },
    { x: 2, y: 9, face: 0 },
    { x: 12, y: 11, face: 2 },
    { x: 4, y: 12, face: 1 },
    { x: 10, y: 12, face: 1 },
  ]).filter((t) => !isFloor(t.x, t.y) && isFloor(t.x + DIR_DX[t.face], t.y + DIR_DY[t.face])),
);

/**
 * Collectibles at tile centres. Returned fresh because the preview flips `taken` on nothing today,
 * but a test that does must not leak the change into the next one.
 * @returns {import('../core/types.js').Item[]}
 */
export function previewItems() {
  return [
    { id: 1, kind: 'gem', x: 5.5, y: 1.5, taken: false },
    { id: 2, kind: 'gem', x: 13.5, y: 5.5, taken: false },
    { id: 3, kind: 'gem', x: 5.5, y: 13.5, taken: false },
    { id: 4, kind: 'gem', x: 9.5, y: 3.5, taken: false },
    { id: 5, kind: 'gem', x: 5.5, y: 9.5, taken: false },
    { id: 6, kind: 'gem', x: 11.5, y: 9.5, taken: false },
    { id: 7, kind: 'oil', x: 1.5, y: 5.5, taken: false },
    { id: 8, kind: 'oil', x: 13.5, y: 11.5, taken: false },
    { id: 9, kind: 'oil', x: 7.5, y: 11.5, taken: false },
    // The hidden map scroll (§4.8), down the west inner corridor. No existing pose can see this
    // tile, so adding it left every measured preview frame byte-identical; pose 6 looks at it.
    { id: 10, kind: 'map', x: 3.5, y: 7.5, taken: false },
  ];
}

/**
 * Fixed camera poses for deterministic screenshots (`preview.html?pose=N`): `[x, y, angleRadians]`.
 * Chosen so that between them they show every feature the renderer has: long-run perspective, wall
 * torches and their light pools, both item types, the portal, and an inside corner.
 * 0 long corridor · 1 lit hall · 2 portal chamber · 3 torch close-up · 4 oil flask · 5 corner turn ·
 * 6 map scroll (two tiles ahead, under the sconce on the west wall).
 * @type {ReadonlyArray<readonly [number, number, number]>}
 */
export const POSES = Object.freeze([
  /** @type {const} */ ([1.5, 6.5, -Math.PI / 2]),
  /** @type {const} */ ([1.7, 1.5, 0]),
  /** @type {const} */ ([7.5, 10.2, -Math.PI / 2]),
  /** @type {const} */ ([3.4, 1.5, 0]),
  /** @type {const} */ ([13.5, 13.0, -Math.PI / 2]),
  /** @type {const} */ ([3.5, 13.5, Math.PI]),
  /** @type {const} */ ([3.5, 9.7, -Math.PI / 2]),
]);
