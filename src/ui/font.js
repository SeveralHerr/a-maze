// @ts-check
/**
 * @file Built-in bitmap pixel fonts for the A-MAZE overlay (ARCHITECTURE.md §4.6).
 *
 * Two faces, both defined as glyph bitmaps in this file — no font files, no web fonts, nothing to
 * load or fail to load:
 *
 * - **`display`** — a gothic/blackletter-inspired titling face, 12 rows tall (10 above the
 *   baseline, 2 of descender), proportional widths. Modelled on the gold "Labyrinth" lettering in
 *   `docs/art-reference.png`: heavy 2-pixel stems, flared serifs, sharp apexes. Drawn with a warm
 *   gold fill, a dark burnt-umber outline and drop shadow, and a parchment highlight along the top
 *   edge of every stroke — the three-tone treatment is what makes 10-pixel letterforms read as
 *   carved metal rather than as a system font.
 * - **`hud`** — a crisp 5×7 monospace face for readouts, in an 8-row cell (seven above the
 *   baseline plus one descender row, so `g j p q y` hang properly instead of reading as digits).
 *   Monospace on purpose: a rolling score counter whose digits changed width would jitter sideways
 *   every frame.
 *
 * Both cover all 95 printable ASCII characters (0x20…0x7E), plus a handful of punctuation the UI
 * copy actually uses (`© × … ·`).
 *
 * ## How drawing works (and why it is fast)
 * Glyphs are compiled once at import into 1-bit masks. The first time a (face, style) pair is
 * drawn, every glyph is rasterised — shadow, outline, fill, highlight — into a single offscreen
 * **atlas canvas**; from then on a character costs one `drawImage` of an already-coloured cell.
 * Nothing is recoloured per frame and nothing allocates per glyph, so a 300-character frame of HUD
 * text costs 300 blits and zero garbage.
 *
 * Atlases are cached per face **and per style string**, so a caller that passes a raw CSS colour
 * ("#ff0000") gets a cache entry too; the cache is capped and evicts in insertion order.
 *
 * ## Crispness invariant
 * Every glyph is blitted at an **integer** scale to **integer** coordinates with image smoothing
 * disabled. The overlay surface (`hud.js`) additionally installs an integer-scaled transform, so a
 * font pixel is always an exact, axis-aligned block of device pixels — never a resampled smear.
 *
 * ## Node safety
 * Compilation, measurement and wrapping are pure and run in Node (that is what the unit tests
 * exercise). Only `drawText` touches a canvas, and it degrades to a no-op if no canvas
 * implementation exists rather than throwing.
 */

import { createLogger } from '../core/log.js';

const log = createLogger('ui/font');

// ─── UI palette ──────────────────────────────────────────────────────────────────────────────

/**
 * The overlay's colours as CSS hex strings.
 *
 * `src/ui` may not import `src/renderer` (ARCHITECTURE.md §2), so the few values the UI needs are
 * mirrored here. Names marked *(palette)* are byte-identical to the entry of the same name in
 * `src/renderer/palette.js`; if that file's ramps are re-sampled, these must be updated with it.
 * The three display-face tones are the art direction given for the title lettering and sit inside
 * the palette's gold ramp (between `goldMid` and `goldPale`).
 * @type {Readonly<Record<string, string>>}
 */
export const COLOR = Object.freeze({
  // Display lettering (art direction).
  gold: '#d9a441', //  warm gold fill
  goldDeep: '#7a4a1a', //  outline + drop shadow
  parchment: '#e8d3a0', //  top-edge highlight

  // Gold ramp (palette).
  goldDark: '#3a2a0d',
  goldMid: '#8a6520',
  goldBase: '#c9962f',
  goldLight: '#e8c24a',
  goldPale: '#f7e3a1',

  // Stone — panels and frames (palette).
  stoneShadow: '#11161f',
  stoneMortar: '#1d2433',
  stoneDeep: '#2b3446',
  stoneDark: '#3e4b5f',
  stoneMid: '#56657a',
  stoneBase: '#6d7d92',
  stoneLight: '#8a9bb0',
  stoneBright: '#a6b5c7',
  stoneHilite: '#c3ced9',

  // Timber — panel backs and the torch handle (palette).
  woodShadow: '#140c06',
  woodDark: '#22160c',
  woodMid: '#3a2618',
  woodBase: '#4a3020',
  woodLight: '#5a3a22',
  woodBright: '#7a5230',
  woodHilite: '#96683c',

  // Iron — sconce, compass ring (palette).
  ironShadow: '#0f1116',
  ironDark: '#1c1f26',
  ironBase: '#2f343d',
  ironLight: '#474d58',
  ironHilite: '#6b7280',

  // Fire — the fuel bar and the flame cursor (palette).
  fireDeep: '#7a2408',
  fireEmber: '#c2410c',
  fireMid: '#ff8a1e',
  fireHot: '#ffcf4a',
  fireCore: '#fff3c4',

  // Arcane — the exit portal on the minimap (palette).
  arcViolet: '#4c1d95',
  arcMid: '#7c3aed',
  arcLight: '#a78bfa',
  arcCyan: '#22d3ee',
  arcPale: '#a5f3fc',

  // Gem — the gem counter icon (palette).
  gemDeep: '#06323f',
  gemMid: '#0e7490',
  gemBright: '#22d3ee',
  gemPale: '#a5f3fc',

  // Oil flask — the pickup icon (palette).
  oilDeep: '#33190a',
  oilDark: '#7c3f0a',
  oilMid: '#c97a16',
  oilLight: '#f0b040',
  oilPale: '#ffe6a8',

  // Moss — minimap explored floor tint (palette).
  mossDeep: '#27491f',
  mossMid: '#3d672a',

  // Ambient (palette).
  fog: '#0a0e18',
  void: '#05070c',
  white: '#ffffff',

  /** Danger red for the low-fuel gauge. Sits between `fireDeep` and `fireEmber`. */
  alarm: '#e2431a',
});

// ─── Glyph data ──────────────────────────────────────────────────────────────────────────────

/** First character code the faces carry. */
const FIRST_CODE = 0x20;
/** Last character code the faces carry. */
const LAST_CODE = 0x7e;

/**
 * The 5×7 HUD face, one entry per printable ASCII code starting at space. Rows are top to bottom,
 * `#` = ink. Every glyph is exactly 5 columns wide: the face is monospace, so a rolling counter
 * cannot shift sideways as its digits change.
 *
 * The cell is 5×8, not 5×7: seven rows above the baseline plus **one descender row**, which the
 * handful of glyphs that need it (`g j p q y , ;`) declare as an eighth row. Everything else
 * stops at seven rows and is padded, which is why most entries below have exactly seven. Without
 * that extra row a lowercase `g` has to be squeezed into the x-height and reads as a `9`.
 * @type {ReadonlyArray<string>}
 */
const HUD_ROWS = [
  '...../...../...../...../...../...../.....', // (space)
  '..#../..#../..#../..#../..#../...../..#..', // !
  '.#.#./.#.#./...../...../...../...../.....', // "
  '.#.#./#####/.#.#./#####/.#.#./...../.....', // #
  '..#../.####/#.#../.###./..#.#/####./..#..', // $
  '##.../##..#/...#./..#../.#.../#..##/...##', // %
  '.##../#..#./.##../#.#.#/#..#./#..#./.##.#', // &
  '..#../..#../...../...../...../...../.....', // '
  '...#./..#../.#.../.#.../.#.../..#../...#.', // (
  '.#.../..#../...#./...#./...#./..#../.#...', // )
  '...../#.#.#/.###./#####/.###./#.#.#/.....', // *
  '...../..#../..#../#####/..#../..#../.....', // +
  '...../...../...../...../...../.##../.##../.#...', // ,
  '...../...../...../#####/...../...../.....', // -
  '...../...../...../...../...../.##../.##..', // .
  '....#/...#./..#../..#../.#.../#..../#....', // /
  '.###./#...#/#..##/#.#.#/##..#/#...#/.###.', // 0
  '..#../.##../..#../..#../..#../..#../.###.', // 1
  '.###./#...#/....#/...#./..#../.#.../#####', // 2
  '#####/...#./..##./....#/....#/#...#/.###.', // 3
  '...#./..##./.#.#./#..#./#####/...#./...#.', // 4
  '#####/#..../####./....#/....#/#...#/.###.', // 5
  '..##./.#.../#..../####./#...#/#...#/.###.', // 6
  '#####/#...#/....#/...#./..#../..#../..#..', // 7
  '.###./#...#/#...#/.###./#...#/#...#/.###.', // 8
  '.###./#...#/#...#/.####/....#/...#./.##..', // 9
  '...../.##../.##../...../.##../.##../.....', // :
  '...../.##../.##../...../.##../.##../..#../.#...', // ;
  '...#./..#../.#.../#..../.#.../..#../...#.', // <
  '...../...../#####/...../#####/...../.....', // =
  '.#.../..#../...#./....#/...#./..#../.#...', // >
  '.###./#...#/....#/...#./..#../...../..#..', // ?
  '.###./#...#/....#/.##.#/#.#.#/#.#.#/.####', // @
  '.###./#...#/#...#/#####/#...#/#...#/#...#', // A
  '####./#...#/#...#/####./#...#/#...#/####.', // B
  '.###./#...#/#..../#..../#..../#...#/.###.', // C
  '###../#..#./#...#/#...#/#...#/#..#./###..', // D
  '#####/#..../#..../####./#..../#..../#####', // E
  '#####/#..../#..../####./#..../#..../#....', // F
  '.###./#...#/#..../#.###/#...#/#...#/.####', // G
  '#...#/#...#/#...#/#####/#...#/#...#/#...#', // H
  '.###./..#../..#../..#../..#../..#../.###.', // I
  '..###/...#./...#./...#./...#./#..#./.##..', // J
  '#...#/#..#./#.#../##.../#.#../#..#./#...#', // K
  '#..../#..../#..../#..../#..../#..../#####', // L
  '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#', // M
  '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#', // N
  '.###./#...#/#...#/#...#/#...#/#...#/.###.', // O
  '####./#...#/#...#/####./#..../#..../#....', // P
  '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#', // Q
  '####./#...#/#...#/####./#.#../#..#./#...#', // R
  '.####/#..../#..../.###./....#/....#/####.', // S
  '#####/..#../..#../..#../..#../..#../..#..', // T
  '#...#/#...#/#...#/#...#/#...#/#...#/.###.', // U
  '#...#/#...#/#...#/#...#/#...#/.#.#./..#..', // V
  '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#', // W
  '#...#/#...#/.#.#./..#../.#.#./#...#/#...#', // X
  '#...#/#...#/.#.#./..#../..#../..#../..#..', // Y
  '#####/....#/...#./..#../.#.../#..../#####', // Z
  '.###./.#.../.#.../.#.../.#.../.#.../.###.', // [
  '#..../.#.../.#.../..#../...#./...#./....#', // \
  '.###./...#./...#./...#./...#./...#./.###.', // ]
  '..#../.#.#./#...#/...../...../...../.....', // ^
  '...../...../...../...../...../...../#####', // _
  '.#.../..#../...../...../...../...../.....', // `
  '...../...../.###./....#/.####/#...#/.####', // a
  '#..../#..../####./#...#/#...#/#...#/####.', // b
  '...../...../.####/#..../#..../#...#/.###.', // c
  '....#/....#/.####/#...#/#...#/#...#/.####', // d
  '...../...../.###./#...#/#####/#..../.###.', // e
  '..##./.#..#/.#.../###../.#.../.#.../.#...', // f
  '...../...../.####/#...#/#...#/.####/....#/.###.', // g
  '#..../#..../####./#...#/#...#/#...#/#...#', // h
  '..#../...../.##../..#../..#../..#../.###.', // i
  '...../..#../...../..#../..#../..#../#.#../.##..', // j
  '#..../#..../#..#./#.#../##.../#.#../#..#.', // k
  '.##../..#../..#../..#../..#../..#../.###.', // l
  '...../...../##.#./#.#.#/#.#.#/#.#.#/#.#.#', // m
  '...../...../####./#...#/#...#/#...#/#...#', // n
  '...../...../.###./#...#/#...#/#...#/.###.', // o
  '...../...../####./#...#/#...#/####./#..../#....', // p
  '...../...../.####/#...#/#...#/.####/....#/....#', // q
  '...../...../#.##./##..#/#..../#..../#....', // r
  '...../...../.####/#..../.###./....#/####.', // s
  '.#.../.#.../###../.#.../.#.../.#..#/..##.', // t
  '...../...../#...#/#...#/#...#/#..##/.##.#', // u
  '...../...../#...#/#...#/#...#/.#.#./..#..', // v
  '...../...../#...#/#.#.#/#.#.#/#.#.#/.#.#.', // w
  '...../...../#...#/.#.#./..#../.#.#./#...#', // x
  '...../...../#...#/#...#/#...#/.####/....#/.###.', // y
  '...../...../#####/...#./..#../.#.../#####', // z
  '...#./..#../..#../.#.../..#../..#../...#.', // {
  '..#../..#../..#../..#../..#../..#../..#..', // |
  '.#.../..#../..#../...#./..#../..#../.#...', // }
  '...../...../.#..#/#.#.#/#..#./...../.....', // ~
];

/**
 * The gothic display face. One entry per printable ASCII code from space. Each entry is 10 or 12
 * rows; 10-row entries have no descender and are padded. All rows of one glyph must be the same
 * length — that length **is** the glyph's width (the face is proportional).
 *
 * Row layout: rows 0…9 sit above the baseline (cap height 10, x-height 7 starting at row 3),
 * rows 10…11 are the descender zone.
 * @type {ReadonlyArray<string>}
 */
const DISPLAY_ROWS = [
  '...../...../...../...../...../...../...../...../...../.....', // (space)
  '##/##/##/##/##/##/##/../##/##', // !
  '##.##/##.##/##.##/...../...../...../...../...../...../.....', // "
  '......./.##.##./.##.##./#######/.##.##./.##.##./#######/.##.##./.##.##./.......', // #
  '...#.../.#####./##.#.##/##.#.../.#####./...#.##/##.#.##/.#####./...#.../.......', // $
  '.##....##/#..#..##./#..#.##../.##.##.../...##..../..##.##../.##.#..#./##..#..#./.....##../.........', // %
  '..####.../.##..##../.##..##../..####.../.####..../##..##.##/##...####/##....###/.##..####/..#####.#', // &
  '##/##/##/../../../../../../..', // '
  '..##/.##./##../##../##../##../##../##../.##./..##', // (
  '##../.##./..##/..##/..##/..##/..##/..##/.##./##..', // )
  '...#.../##.#.##/.#####./..###../.#####./##.#.##/...#.../......./......./.......', // *
  '..##../..##../..##../######/######/..##../..##../....../....../......', // +
  '.../.../.../.../.../.../.../.../.##/.##/.##/##.', // ,
  '....../....../....../....../######/######/....../....../....../......', // -
  '../../../../../../../../##/##', // .
  '.....##/.....##/....##./....##./...##../..##.../..##.../.##..../##...../##.....', // /
  '.#####./##...##/##...##/##..###/##.####/####.##/###..##/##...##/##...##/.#####.', // 0
  '..##.../.###.../####.../..##.../..##.../..##.../..##.../..##.../..##.../#######', // 1
  '.#####./##...##/##...##/.....##/....##./...##../..##.../.##..../##...../#######', // 2
  '.#####./##...##/.....##/....##./..####./....###/.....##/##...##/##...##/.#####.', // 3
  '....##./...###./..####./.##.##./##..##./#######/....##./....##./....##./..#####', // 4
  '#######/##...../##...../######./....##./.....##/.....##/##...##/##...##/.#####.', // 5
  '..####./.##...#/##...../##...../######./##...##/##...##/##...##/##...##/.#####.', // 6
  '#######/##...##/....##./....##./...##../...##../..##.../..##.../..##.../..##...', // 7
  '.#####./##...##/##...##/##...##/.#####./##...##/##...##/##...##/##...##/.#####.', // 8
  '.#####./##...##/##...##/##...##/##...##/.######/.....##/.....##/#...##./.####..', // 9
  '../../../../##/##/../../##/##', // :
  '.../.../.../.../.##/.##/.../.../.##/.##/.##/##.', // ;
  '.....#/...###/.###../###.../##..../###.../.###../...###/.....#/......', // <
  '....../....../....../######/######/....../######/######/....../......', // =
  '#...../###.../..###./....##/.....#/....##/..###./###.../#...../......', // >
  '.#####./##...##/##...##/.....##/....##./...##../...##../......./...##../...##..', // ?
  '..#####../.##...##./##..#..##/##.###.##/##.##..##/##.##..##/##.#####./##......./.##....#./..######.', // @
  '...##.../..####../..####../.##..##./.##..##./.######./.##..##./##....##/##....##/###..###', // A
  '######../.##..##./.##..##./.##..##./.#####../.##..##./.##...##/.##...##/.##..##./#######.', // B
  '..#####./.##...##/##....##/##....../##....../##....../##....../##....##/.##...##/..#####.', // C
  '######../.##..##./.##...##/.##...##/.##...##/.##...##/.##...##/.##...##/.##..##./######..', // D
  '########/.##...##/.##...../.##...../.#####../.#####../.##...../.##...../.##...##/########', // E
  '########/.##...##/.##...../.##...../.#####../.#####../.##...../.##...../.##...../####....', // F
  '..#####./.##...##/##....##/##....../##..####/##..####/##....##/##....##/.##..##./..####..', // G
  '###..###/.##..##./.##..##./.##..##./.######./.##..##./.##..##./.##..##./.##..##./###..###', // H
  '######/..##../..##../..##../..##../..##../..##../..##../..##../######', // I
  '..#####/....##./....##./....##./....##./....##./....##./##..##./##..##./.####..', // J
  '###..###/.##..##./.##.##../.####.../.###..../.####.../.##.##../.##..##./.##...##/###..###', // K
  '###..../.##..../.##..../.##..../.##..../.##..../.##..../.##..../.##..##/#######', // L
  '##.....##/###...###/####.####/##.###.##/##..#..##/##.....##/##.....##/##.....##/##.....##/###...###', // M
  '##....##/###...##/####..##/##.##.##/##.##.##/##..####/##..####/##...###/##....##/##....##', // N
  '..####../.##..##./##....##/##....##/##....##/##....##/##....##/##....##/.##..##./..####..', // O
  '######../.##..##./.##...##/.##...##/.##..##./.#####../.##...../.##...../.##...../####....', // P
  '..####../.##..##./##....##/##....##/##....##/##....##/##....##/##....##/.##..##./..####../...####./....####', // Q
  '######../.##..##./.##...##/.##...##/.##..##./.#####../.##.##../.##..##./.##...##/###...##', // R
  '..#####./.##...##/##....../.###..../..####../....###./......##/##....##/.##..##./..#####.', // S
  '########/##.##.##/...##.../...##.../...##.../...##.../...##.../...##.../...##.../..####..', // T
  '###..###/.##..##./.##..##./.##..##./.##..##./.##..##./.##..##./##....##/.##..##./..####..', // U
  '##....##/##....##/##....##/##....##/.##..##./.##..##./..####../..####../...##.../...##...', // V
  '##......##/##......##/##......##/##..##..##/##.####.##/##.####.##/##.####.##/.########./..##..##../..##..##..', // W
  '###..###/.##..##./..####../..####../...##.../..####../..####../.##..##./.##..##./###..###', // X
  '###..###/.##..##./..####../...##.../...##.../...##.../...##.../...##.../...##.../..####..', // Y
  '########/.....##./....##../....##../...##.../..##..../..##..../.##...../.##...../########', // Z
  '####/.##./.##./.##./.##./.##./.##./.##./.##./####', // [
  '##...../##...../.##..../..##.../..##.../...##../...##../....##./.....##/.....##', // \
  '####/..##/..##/..##/..##/..##/..##/..##/..##/####', // ]
  '...#.../..###../.##.##./##...##/......./......./......./......./......./.......', // ^
  '......./......./......./......./......./......./......./......./......./......./#######/.......', // _
  '##../.##./..#./..../..../..../..../..../..../....', // `
  '......./......./......./.####../##..##./....##./.#####./##..##./##..##./.#####.', // a
  '##...../##...../##...../#####../##..##./##...##/##...##/##...##/##..##./#####..', // b
  '....../....../....../.####./##..##/##..../##..../##..../##..##/.####.', // c
  '.....##/.....##/.....##/..#####/.##..##/##...##/##...##/##...##/.##..##/..#####', // d
  '....../....../....../.####./##..##/##..##/######/##..../##..##/.####.', // e
  '..###./.##.../.##.../#####./.##.../.##.../.##.../.##.../.##.../.####.', // f
  '......./......./......./.#####./##...##/##...##/##...##/.#####./.....##/.....##/##...##/.#####.', // g
  '##...../##...../##...../#####../##..##./##...##/##...##/##...##/##...##/##...##', // h
  '..../.##./..../###./.##./.##./.##./.##./.##./####', // i
  '...../..##./...../.###./..##./..##./..##./..##./..##./..##./#.##./.###.', // j
  '##...../##...../##...../##..##./##.##../####.../####.../##.##../##..##./##...##', // k
  '###./.##./.##./.##./.##./.##./.##./.##./.##./####', // l
  '........../........../........../.########./##..##..##/##..##..##/##..##..##/##..##..##/##..##..##/##..##..##', // m
  '......./......./......./######./##..##./##...##/##...##/##...##/##...##/##...##', // n
  '......./......./......./.#####./##...##/##...##/##...##/##...##/##...##/.#####.', // o
  '......./......./......./#####../##..##./##...##/##...##/##..##./#####../##...../##...../####...', // p
  '......./......./......./..#####/.##..##/##...##/##...##/.##..##/..#####/.....##/.....##/...####', // q
  '....../....../....../##.###/###.../##..../##..../##..../##..../##....', // r
  '....../....../....../.####./##..##/##..../.####./....##/##..##/.####.', // s
  '...../.##../.##../#####/.##../.##../.##../.##../.##.#/..###', // t
  '......./......./......./##...##/##...##/##...##/##...##/##...##/##..###/.######', // u
  '......./......./......./##...##/##...##/##...##/.##.##./.##.##./..###../...#...', // v
  '........./........./........./##.....##/##.....##/##..#..##/##.###.##/##.###.##/.#######./..##.##..', // w
  '......./......./......./##...##/.##.##./..###../..###../..###../.##.##./##...##', // x
  '......./......./......./##...##/##...##/##...##/##...##/.##..##/..#####/.....##/##...##/.#####.', // y
  '....../....../....../######/....##/...##./..##../.##.../##..../######', // z
  '..###/.##../.##../.##../##.../##.../.##../.##../.##../..###', // {
  '##/##/##/##/##/##/##/##/##/##', // |
  '###../..##./..##./..##./...##/...##/..##./..##./..##./###..', // }
  '......../......../......../......../.####.##/##.####./......../......../......../........', // ~
];

/**
 * Extra glyphs the UI copy needs beyond ASCII, keyed by code point. Kept out of the ASCII arrays so
 * their indexing stays a simple `code - 0x20`.
 * @type {ReadonlyArray<readonly [number, string, string]>} `[codePoint, hudRows, displayRows]`
 */
const EXTRA_GLYPHS = /** @type {const} */ ([
  // © — the footer copyright mark.
  [
    0xa9,
    '.###./#...#/#.##./#.#../#.##./#...#/.###.',
    '..#####../.##...##./##.....##/##.###.##/##.##..##/##.##..##/##.###.##/##.....##/.##...##./..#####..',
  ],
  // × — "gems × 8" in the tally.
  [
    0xd7,
    '...../#...#/.#.#./..#../.#.#./#...#/.....',
    '....../....../....../##..##/.####./..##../.####./##..##/....../......',
  ],
  // … — "Carving the labyrinth…".
  [
    0x2026,
    '...../...../...../...../...../#.#.#/#.#.#',
    '........./........./........./........./........./........./........./........./##.##.##./##.##.##.',
  ],
  // · — separator between footer fields.
  [
    0xb7,
    '...../...../...../.###./.###./...../.....',
    '..../..../..../..../.##./.##./..../..../..../....',
  ],
]);

// ─── Face compilation ────────────────────────────────────────────────────────────────────────

/**
 * One compiled glyph: a 1-bit mask plus the pen advance it costs.
 * @typedef {Object} Glyph
 * @property {number} code  code point
 * @property {number} w     mask columns
 * @property {number} h     mask rows (always the face height)
 * @property {number} adv   pen advance in font pixels (width + inter-letter spacing)
 * @property {Uint8Array} mask  `w*h`, row-major, 1 = ink
 */

/**
 * A compiled face.
 * @typedef {Object} Face
 * @property {string} name          `'hud'` or `'display'`
 * @property {number} height        rows per glyph, including the descender zone
 * @property {number} ascent        rows above the baseline
 * @property {number} descent       rows below the baseline
 * @property {number} lineGap       extra rows between wrapped lines
 * @property {number} spacing       columns inserted between adjacent glyphs
 * @property {number} spaceAdv      advance of the space character
 * @property {number} maxWidth      widest glyph, for atlas layout
 * @property {boolean} monospace    true when every glyph has the same advance
 * @property {Array<Glyph|null>} ascii  indexed by `code - 0x20`
 * @property {Map<number, Glyph>} extra  glyphs outside the ASCII block
 */

/**
 * Compile one face's row data into glyph masks.
 *
 * Malformed data (a row of the wrong length) is a programming error in *this file*. Rather than
 * throwing at import — which would take down the whole page for one bad character — the offending
 * glyph is dropped and the problem is recorded in the core error ring buffer, where `?debug=1`
 * surfaces it. The face still works; one character renders blank.
 *
 * @param {string} name face name
 * @param {number} height rows per glyph
 * @param {number} ascent rows above the baseline
 * @param {number} lineGap extra rows between lines
 * @param {number} spacing columns between adjacent glyphs
 * @param {ReadonlyArray<string>} rows one `'/'`-joined entry per ASCII code from 0x20
 * @param {boolean} monospace whether every advance is forced to the same width
 * @returns {Face}
 */
function compileFace(name, height, ascent, lineGap, spacing, rows, monospace) {
  /** @type {Face} */
  const face = {
    name,
    height,
    ascent,
    descent: height - ascent,
    lineGap,
    spacing,
    spaceAdv: 0,
    maxWidth: 0,
    monospace,
    ascii: new Array(LAST_CODE - FIRST_CODE + 1).fill(null),
    extra: new Map(),
  };

  const expected = LAST_CODE - FIRST_CODE + 1;
  if (rows.length !== expected) {
    log.error(`${name}: expected ${expected} glyph entries, found ${rows.length}`);
  }

  for (let i = 0; i < rows.length && i < expected; i++) {
    const glyph = compileGlyph(name, FIRST_CODE + i, height, rows[i]);
    if (glyph === null) continue;
    face.ascii[i] = glyph;
    if (glyph.w > face.maxWidth) face.maxWidth = glyph.w;
  }

  for (let i = 0; i < EXTRA_GLYPHS.length; i++) {
    const [code, hudRows, displayRows] = EXTRA_GLYPHS[i];
    const glyph = compileGlyph(name, code, height, name === 'hud' ? hudRows : displayRows);
    if (glyph === null) continue;
    face.extra.set(code, glyph);
    if (glyph.w > face.maxWidth) face.maxWidth = glyph.w;
  }

  if (monospace) {
    // Monospace: every advance is the widest glyph plus the spacing column, so digits line up and
    // a rolling counter never shifts sideways.
    const adv = face.maxWidth + spacing;
    for (let i = 0; i < face.ascii.length; i++) {
      const g = face.ascii[i];
      if (g !== null) g.adv = adv;
    }
    face.extra.forEach((g) => {
      g.adv = adv;
    });
  }

  const space = face.ascii[0];
  face.spaceAdv = space !== null ? space.adv : Math.max(2, (face.maxWidth >> 1) + spacing);
  return face;
}

/**
 * Compile a single glyph from its `'/'`-joined row string.
 * @param {string} faceName for diagnostics
 * @param {number} code code point
 * @param {number} height the face height; shorter data is padded with blank rows at the bottom
 * @param {string} data rows of `.` and `#`
 * @returns {Glyph|null} null when the data is malformed
 */
function compileGlyph(faceName, code, height, data) {
  const parts = data.split('/');
  if (parts.length === 0 || parts.length > height) {
    log.error(`${faceName}: glyph U+${code.toString(16)} has ${parts.length} rows (max ${height})`);
    return null;
  }
  const w = parts[0].length;
  if (w === 0) {
    log.error(`${faceName}: glyph U+${code.toString(16)} has zero width`);
    return null;
  }
  for (let r = 1; r < parts.length; r++) {
    if (parts[r].length !== w) {
      log.error(
        `${faceName}: glyph U+${code.toString(16)} row ${r} is ${parts[r].length} wide, expected ${w}`,
      );
      return null;
    }
  }
  const mask = new Uint8Array(w * height);
  for (let r = 0; r < parts.length; r++) {
    const row = parts[r];
    for (let c = 0; c < w; c++) {
      if (row.charCodeAt(c) === 35 /* '#' */) mask[r * w + c] = 1;
    }
  }
  return { code, w, h: height, adv: w, mask };
}

/**
 * The HUD face: 8 rows (7 above the baseline + 1 descender), 1 column of letter spacing,
 * monospace. The line pitch is 9 rows, which is the tightest setting at which a descender and the
 * next line's cap height still keep a clear pixel between them.
 * @type {Face}
 */
const HUD_FACE = compileFace('hud', 8, 7, 1, 1, HUD_ROWS, true);

/**
 * The gothic display face: 12 rows with a 2-row descender zone, proportional, 1 column of spacing.
 * @type {Face}
 */
const DISPLAY_FACE = compileFace('display', 12, 10, 3, 1, DISPLAY_ROWS, false);

// Proportional faces must not let a glyph sit flush against its neighbour.
for (let i = 0; i < DISPLAY_FACE.ascii.length; i++) {
  const g = DISPLAY_FACE.ascii[i];
  if (g !== null) g.adv = g.w + DISPLAY_FACE.spacing;
}
DISPLAY_FACE.extra.forEach((g) => {
  g.adv = g.w + DISPLAY_FACE.spacing;
});
// The space glyph's own bitmap is blank; give it a width that reads as a word gap at title size.
{
  const space = DISPLAY_FACE.ascii[0];
  if (space !== null) space.adv = 5;
  DISPLAY_FACE.spaceAdv = space !== null ? space.adv : 5;
}

/**
 * The two faces by name.
 * @type {Readonly<Record<string, Face>>}
 */
const FACES = Object.freeze({ hud: HUD_FACE, display: DISPLAY_FACE });

/** Face names accepted by every function here. @typedef {'hud'|'display'} FontName */

/**
 * Resolve a face name, defaulting to the HUD face for anything unknown so a typo degrades to
 * readable text instead of an exception.
 * @param {string|undefined} name
 * @returns {Face}
 */
function faceOf(name) {
  return name === 'display' ? DISPLAY_FACE : HUD_FACE;
}

/**
 * Look up one glyph.
 * @param {Face} face
 * @param {number} code code point
 * @returns {Glyph|null} null when the face has no such glyph
 */
function glyphOf(face, code) {
  if (code >= FIRST_CODE && code <= LAST_CODE) return face.ascii[code - FIRST_CODE];
  const extra = face.extra.get(code);
  return extra !== undefined ? extra : null;
}

// ─── Text styles ─────────────────────────────────────────────────────────────────────────────

/**
 * How a face is painted: up to four tones per glyph.
 * @typedef {Object} TextStyle
 * @property {string} fill              body colour (CSS)
 * @property {string|null} outline      1-pixel surround, or null
 * @property {string|null} highlight    top-edge tone inside the fill, or null
 * @property {string|null} shadow       drop-shadow colour, or null
 * @property {number} shadowX           shadow offset in font pixels
 * @property {number} shadowY           shadow offset in font pixels
 */

/**
 * Named styles. Callers pass one of these names as `color`; anything else is treated as a raw CSS
 * colour and gets a plain fill (with a 1-pixel shadow when `shadow: true`).
 *
 * `gothic` is the art-directed title treatment from §4.6: gold fill, burnt-umber outline and drop
 * shadow, parchment highlight along the top of each stroke.
 * @type {Readonly<Record<string, TextStyle>>}
 */
export const FONT_STYLES = Object.freeze({
  /** Title lettering. */
  gothic: Object.freeze({
    fill: COLOR.gold,
    outline: COLOR.goldDeep,
    highlight: COLOR.parchment,
    shadow: COLOR.void,
    shadowX: 1,
    shadowY: 2,
  }),
  /** Title lettering, unselected/quiet: same shape, less light. */
  gothicDim: Object.freeze({
    fill: COLOR.goldMid,
    outline: COLOR.goldDark,
    highlight: COLOR.goldBase,
    shadow: COLOR.void,
    shadowX: 1,
    shadowY: 1,
  }),
  /** Title lettering, selected: lit by the cursor flame. */
  gothicHot: Object.freeze({
    fill: COLOR.fireHot,
    outline: COLOR.fireDeep,
    highlight: COLOR.fireCore,
    shadow: COLOR.void,
    shadowX: 1,
    shadowY: 2,
  }),
  /** Disabled menu entry. */
  gothicOff: Object.freeze({
    fill: COLOR.stoneDark,
    outline: COLOR.void,
    highlight: COLOR.stoneMid,
    shadow: null,
    shadowX: 0,
    shadowY: 0,
  }),
  /** Default HUD text: parchment on a hard shadow so it survives any background. */
  hud: Object.freeze({
    fill: COLOR.parchment,
    outline: null,
    highlight: null,
    shadow: COLOR.void,
    shadowX: 1,
    shadowY: 1,
  }),
  /** HUD text, gold — labels and headings. */
  hudGold: Object.freeze({
    fill: COLOR.goldLight,
    outline: null,
    highlight: null,
    shadow: COLOR.void,
    shadowX: 1,
    shadowY: 1,
  }),
  /** HUD text, dimmed — units and secondary readouts. */
  hudDim: Object.freeze({
    fill: COLOR.stoneLight,
    outline: null,
    highlight: null,
    shadow: COLOR.void,
    shadowX: 1,
    shadowY: 1,
  }),
  /** HUD text, alarm — low fuel. */
  hudAlarm: Object.freeze({
    fill: COLOR.alarm,
    outline: null,
    highlight: null,
    shadow: COLOR.void,
    shadowX: 1,
    shadowY: 1,
  }),
  /** HUD text, gem cyan. */
  hudGem: Object.freeze({
    fill: COLOR.gemBright,
    outline: null,
    highlight: null,
    shadow: COLOR.void,
    shadowX: 1,
    shadowY: 1,
  }),
  /**
   * HUD text, bright — score pops, totals, NEW BEST. The dark outline (rather than a shadow alone)
   * is what keeps a "+100" legible while it floats over a lit wall.
   */
  hudBright: Object.freeze({
    fill: COLOR.fireCore,
    outline: COLOR.void,
    highlight: null,
    shadow: COLOR.void,
    shadowX: 1,
    shadowY: 1,
  }),
});

/**
 * Styles built on demand for raw CSS colours, keyed by `color + '|' + shadow`.
 * @type {Map<string, TextStyle>}
 */
const adHocStyles = new Map();

/**
 * Resolve the `color`/`shadow` options to a style.
 * @param {string|undefined} color a `FONT_STYLES` name, or any CSS colour
 * @param {boolean} shadow whether an unnamed colour gets a drop shadow
 * @returns {TextStyle}
 */
function styleOf(color, shadow) {
  if (color === undefined) return FONT_STYLES.hud;
  const named = FONT_STYLES[color];
  if (named !== undefined) return named;
  const key = shadow ? color + '|1' : color + '|0';
  let style = adHocStyles.get(key);
  if (style === undefined) {
    style = Object.freeze({
      fill: color,
      outline: null,
      highlight: null,
      shadow: shadow ? COLOR.void : null,
      shadowX: 1,
      shadowY: 1,
    });
    // Unbounded growth would be a leak if a caller generated colours per frame; 64 distinct
    // ad-hoc colours is far more than the UI uses, and the oldest is dropped past that.
    if (adHocStyles.size >= 64) {
      const oldest = adHocStyles.keys().next();
      if (!oldest.done) adHocStyles.delete(oldest.value);
    }
    adHocStyles.set(key, style);
  }
  return style;
}

// ─── Glyph atlases ───────────────────────────────────────────────────────────────────────────

/**
 * A pre-rendered, pre-coloured sheet of every glyph in one face.
 * @typedef {Object} Atlas
 * @property {CanvasImageSource} image  the sheet
 * @property {number} cellH             cell height including padding
 * @property {number} padX              ink-to-cell-left padding, in font pixels
 * @property {number} padY              ink-to-cell-top padding, in font pixels
 * @property {Map<number, number>} at   code point → x offset of its cell
 * @property {Map<number, number>} cw   code point → cell width
 */

/**
 * Atlas cache: `face name → (style key → Atlas)`. Capped; see `MAX_ATLASES`.
 * @type {Map<string, Map<string, Atlas>>}
 */
const atlasCache = new Map();

/** Upper bound on cached atlases across all faces (each is ≈ 60 KB of pixels). */
const MAX_ATLASES = 16;

/** Number of cached atlases, tracked so eviction does not have to walk the map. */
let atlasCount = 0;

/**
 * Set to true once a canvas could not be created, so the failure is reported once rather than on
 * every frame.
 */
let canvasFailed = false;

/**
 * Create an offscreen canvas, preferring `OffscreenCanvas` (no DOM node, no layout) and falling
 * back to a detached `<canvas>`.
 * @param {number} w
 * @param {number} h
 * @returns {{canvas:CanvasImageSource, ctx:CanvasRenderingContext2D}|null} null when neither exists
 */
function createOffscreen(w, h) {
  try {
    if (typeof OffscreenCanvas === 'function') {
      const c = new OffscreenCanvas(w, h);
      const ctx = /** @type {CanvasRenderingContext2D|null} */ (
        /** @type {unknown} */ (c.getContext('2d'))
      );
      if (ctx !== null) return { canvas: /** @type {CanvasImageSource} */ (c), ctx };
    }
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (ctx !== null) return { canvas: c, ctx };
    }
  } catch (err) {
    if (!canvasFailed) log.error('offscreen canvas unavailable', err);
    canvasFailed = true;
  }
  return null;
}

/**
 * Parse `#rgb`/`#rrggbb`/`rgb(...)`/`rgba(...)` into RGBA bytes.
 *
 * A tiny hand parser rather than a canvas round-trip: it runs at atlas-build time only, but it
 * also lets the atlas be built from an `OffscreenCanvas` without ever touching `fillStyle`.
 * Unparseable input returns opaque magenta, which is unmistakable in a screenshot.
 * @param {string} css
 * @param {Uint8Array} out length ≥ 4; receives r,g,b,a
 * @returns {void}
 */
function parseColor(css, out) {
  out[0] = 255;
  out[1] = 0;
  out[2] = 255;
  out[3] = 255;
  if (typeof css !== 'string') return;
  const s = css.trim();
  if (s.charCodeAt(0) === 35 /* # */) {
    if (s.length === 4 || s.length === 5) {
      const r = parseInt(s[1] + s[1], 16);
      const g = parseInt(s[2] + s[2], 16);
      const b = parseInt(s[3] + s[3], 16);
      const a = s.length === 5 ? parseInt(s[4] + s[4], 16) : 255;
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b) && !Number.isNaN(a)) {
        out[0] = r;
        out[1] = g;
        out[2] = b;
        out[3] = a;
      }
      return;
    }
    if (s.length === 7 || s.length === 9) {
      const r = parseInt(s.slice(1, 3), 16);
      const g = parseInt(s.slice(3, 5), 16);
      const b = parseInt(s.slice(5, 7), 16);
      const a = s.length === 9 ? parseInt(s.slice(7, 9), 16) : 255;
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b) && !Number.isNaN(a)) {
        out[0] = r;
        out[1] = g;
        out[2] = b;
        out[3] = a;
      }
      return;
    }
    return;
  }
  const open = s.indexOf('(');
  if (open > 0 && s.endsWith(')')) {
    const parts = s.slice(open + 1, -1).split(',');
    if (parts.length >= 3) {
      out[0] = clampByte(parseFloat(parts[0]));
      out[1] = clampByte(parseFloat(parts[1]));
      out[2] = clampByte(parseFloat(parts[2]));
      out[3] = parts.length >= 4 ? clampByte(parseFloat(parts[3]) * 255) : 255;
    }
  }
}

/**
 * Clamp to a 0..255 integer; NaN reads as 0.
 * @param {number} v
 * @returns {number}
 */
function clampByte(v) {
  if (!Number.isFinite(v)) return 0;
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

/**
 * Scratch colour buffers used while painting an atlas (build time only, never per frame).
 */
const _rgbaFill = new Uint8Array(4);
const _rgbaOutline = new Uint8Array(4);
const _rgbaHighlight = new Uint8Array(4);
const _rgbaShadow = new Uint8Array(4);

/**
 * Build the atlas for one (face, style) pair: every glyph, painted once, laid out in a row.
 *
 * Painting order is bottom-up — shadow, outline, fill, highlight — so later tones overwrite
 * earlier ones exactly the way a painter would layer them.
 * @param {Face} face
 * @param {TextStyle} style
 * @returns {Atlas|null} null when no canvas implementation is available
 */
function buildAtlas(face, style) {
  const padX = style.outline !== null ? 1 : 0;
  const padY = padX;
  const shX = style.shadow !== null ? Math.max(0, style.shadowX) : 0;
  const shY = style.shadow !== null ? Math.max(0, style.shadowY) : 0;
  const cellH = face.height + padY * 2 + shY;

  /** @type {number[]} */
  const codes = [];
  for (let i = 0; i < face.ascii.length; i++) {
    if (face.ascii[i] !== null) codes.push(FIRST_CODE + i);
  }
  face.extra.forEach((_g, code) => codes.push(code));

  let total = 0;
  for (let i = 0; i < codes.length; i++) {
    const g = /** @type {Glyph} */ (glyphOf(face, codes[i]));
    total += g.w + padX * 2 + shX;
  }
  if (total === 0) return null;

  const surface = createOffscreen(total, cellH);
  if (surface === null) return null;

  const img = surface.ctx.createImageData(total, cellH);
  const px = img.data;
  parseColor(style.fill, _rgbaFill);
  if (style.outline !== null) parseColor(style.outline, _rgbaOutline);
  if (style.highlight !== null) parseColor(style.highlight, _rgbaHighlight);
  if (style.shadow !== null) parseColor(style.shadow, _rgbaShadow);

  /** @type {Map<number, number>} */
  const at = new Map();
  /** @type {Map<number, number>} */
  const cw = new Map();

  let penX = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const g = /** @type {Glyph} */ (glyphOf(face, code));
    const cellW = g.w + padX * 2 + shX;
    at.set(code, penX);
    cw.set(code, cellW);

    // Shadow: the whole mask, offset. Drawn first so everything else covers it.
    if (style.shadow !== null && (shX !== 0 || shY !== 0)) {
      for (let y = 0; y < g.h; y++) {
        for (let x = 0; x < g.w; x++) {
          if (g.mask[y * g.w + x] === 0) continue;
          putPixel(px, total, penX + padX + x + shX, padY + y + shY, _rgbaShadow);
        }
      }
    }

    // Outline: every empty cell orthogonally or diagonally adjacent to ink.
    if (style.outline !== null) {
      for (let y = -1; y <= g.h; y++) {
        for (let x = -1; x <= g.w; x++) {
          if (inkAt(g, x, y)) continue;
          if (!touchesInk(g, x, y)) continue;
          putPixel(px, total, penX + padX + x, padY + y, _rgbaOutline);
        }
      }
    }

    // Fill, then the highlight along the top edge of each stroke (the light is overhead).
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        if (g.mask[y * g.w + x] === 0) continue;
        const top = style.highlight !== null && !inkAt(g, x, y - 1);
        putPixel(px, total, penX + padX + x, padY + y, top ? _rgbaHighlight : _rgbaFill);
      }
    }

    penX += cellW;
  }

  surface.ctx.putImageData(img, 0, 0);
  return { image: surface.canvas, cellH, padX, padY, at, cw };
}

/**
 * Is (x,y) inside the glyph and inked?
 * @param {Glyph} g
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function inkAt(g, x, y) {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return false;
  return g.mask[y * g.w + x] !== 0;
}

/**
 * Does (x,y) touch ink in any of the 8 surrounding cells?
 * @param {Glyph} g
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function touchesInk(g, x, y) {
  return (
    inkAt(g, x - 1, y) ||
    inkAt(g, x + 1, y) ||
    inkAt(g, x, y - 1) ||
    inkAt(g, x, y + 1) ||
    inkAt(g, x - 1, y - 1) ||
    inkAt(g, x + 1, y - 1) ||
    inkAt(g, x - 1, y + 1) ||
    inkAt(g, x + 1, y + 1)
  );
}

/**
 * Write one opaque pixel into an `ImageData` byte array.
 * @param {Uint8ClampedArray} px
 * @param {number} stride image width in pixels
 * @param {number} x
 * @param {number} y
 * @param {Uint8Array} rgba length ≥ 4
 * @returns {void}
 */
function putPixel(px, stride, x, y, rgba) {
  const i = (y * stride + x) * 4;
  px[i] = rgba[0];
  px[i + 1] = rgba[1];
  px[i + 2] = rgba[2];
  px[i + 3] = rgba[3];
}

/**
 * Fetch (building on first use) the atlas for a face and style.
 * @param {Face} face
 * @param {string} styleKey cache key — the caller's `color` string
 * @param {TextStyle} style
 * @returns {Atlas|null}
 */
function atlasFor(face, styleKey, style) {
  let byStyle = atlasCache.get(face.name);
  if (byStyle === undefined) {
    byStyle = new Map();
    atlasCache.set(face.name, byStyle);
  }
  const hit = byStyle.get(styleKey);
  if (hit !== undefined) return hit;

  const atlas = buildAtlas(face, style);
  if (atlas === null) return null;

  if (atlasCount >= MAX_ATLASES) {
    // Evict the oldest entry of the largest bucket; atlases are interchangeable, so any eviction
    // policy is correct — this one is O(1) and keeps the cache from growing without bound.
    const firstFace = atlasCache.keys().next();
    if (!firstFace.done) {
      const bucket = /** @type {Map<string, Atlas>} */ (atlasCache.get(firstFace.value));
      const firstKey = bucket.keys().next();
      if (!firstKey.done) {
        bucket.delete(firstKey.value);
        atlasCount--;
      }
    }
  }
  byStyle.set(styleKey, atlas);
  atlasCount++;
  return atlas;
}

/**
 * Drop every cached atlas. Call after changing a style table; the next draw rebuilds lazily.
 * @returns {void}
 */
export function clearFontCache() {
  atlasCache.clear();
  adHocStyles.clear();
  atlasCount = 0;
}

// ─── Measuring ───────────────────────────────────────────────────────────────────────────────

/**
 * Text drawing options. Every field is optional.
 * @typedef {Object} TextOptions
 * @property {FontName} [font]   `'hud'` (default) or `'display'`
 * @property {number} [size]     integer pixel scale, 1 = one font pixel per surface pixel (default 1)
 * @property {number} [scale]    alias of `size`, for callers that prefer the name
 * @property {string} [color]    a `FONT_STYLES` name (default `'hud'`) or any CSS colour
 * @property {boolean} [shadow]  give a raw CSS colour a 1-pixel drop shadow (named styles decide for themselves)
 * @property {'left'|'center'|'right'} [align]     horizontal anchor for `x` (default `'left'`)
 * @property {'top'|'middle'|'baseline'|'bottom'} [baseline]  vertical anchor for `y` (default `'top'`)
 * @property {number} [tracking] extra pixels between glyphs, before scaling (default 0)
 * @property {number} [lineHeight] line pitch in font pixels (default face height + lineGap)
 * @property {number} [alpha]    0..1 opacity (default 1)
 */

/**
 * Integer pixel scale from the options (always ≥ 1: a sub-pixel bitmap font is a blur).
 * @param {TextOptions|undefined} opts
 * @returns {number}
 */
function scaleOf(opts) {
  const raw = opts === undefined ? 1 : opts.size !== undefined ? opts.size : opts.scale;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1;
  const s = Math.round(raw);
  return s < 1 ? 1 : s;
}

/**
 * Width of a single line in surface pixels. Newlines are not interpreted — use
 * {@link measureText} for multi-line strings.
 *
 * The trailing letter-spacing column of the last glyph is removed, so a centred string is centred
 * on its ink rather than half a pixel to the left.
 * @param {string} text
 * @param {TextOptions} [opts]
 * @returns {number} width in surface pixels (0 for an empty string)
 */
export function measureLine(text, opts) {
  const face = faceOf(opts === undefined ? undefined : opts.font);
  const scale = scaleOf(opts);
  const tracking = opts !== undefined && typeof opts.tracking === 'number' ? opts.tracking : 0;
  return measureLineRaw(face, String(text), tracking) * scale;
}

/**
 * Width of one line in **font** pixels (before scaling).
 * @param {Face} face
 * @param {string} text
 * @param {number} tracking
 * @returns {number}
 */
function measureLineRaw(face, text, tracking) {
  const n = text.length;
  if (n === 0) return 0;
  let w = 0;
  let last = 0;
  for (let i = 0; i < n; i++) {
    const g = glyphOf(face, text.charCodeAt(i));
    if (g === null) {
      w += face.spaceAdv + tracking;
      last = tracking;
      continue;
    }
    w += g.adv + tracking;
    // The advance's trailing spacing column is not ink; drop it from the reported width.
    last = g.adv - g.w + tracking;
  }
  const width = w - last;
  return width > 0 ? width : 0;
}

/**
 * Measure a string, honouring `\n`.
 * @param {string} text
 * @param {TextOptions} [opts]
 * @returns {{width:number, height:number, lines:number}} surface pixels, and the line count
 */
export function measureText(text, opts) {
  const face = faceOf(opts === undefined ? undefined : opts.font);
  const scale = scaleOf(opts);
  const tracking = opts !== undefined && typeof opts.tracking === 'number' ? opts.tracking : 0;
  const pitch = lineHeightOf(face, opts);
  const str = String(text);

  let width = 0;
  let lines = 1;
  let start = 0;
  for (;;) {
    const nl = str.indexOf('\n', start);
    const line = nl < 0 ? str.slice(start) : str.slice(start, nl);
    const w = measureLineRaw(face, line, tracking);
    if (w > width) width = w;
    if (nl < 0) break;
    lines++;
    start = nl + 1;
  }
  return {
    width: width * scale,
    height: (face.height + (lines - 1) * pitch) * scale,
    lines,
  };
}

/**
 * Line pitch in font pixels.
 * @param {Face} face
 * @param {TextOptions|undefined} opts
 * @returns {number}
 */
function lineHeightOf(face, opts) {
  if (opts !== undefined && typeof opts.lineHeight === 'number' && opts.lineHeight > 0) {
    return Math.round(opts.lineHeight);
  }
  return face.height + face.lineGap;
}

/**
 * Face metrics in surface pixels, for laying out around text.
 * @param {TextOptions} [opts]
 * @returns {{height:number, ascent:number, descent:number, lineHeight:number, scale:number}}
 */
export function fontMetrics(opts) {
  const face = faceOf(opts === undefined ? undefined : opts.font);
  const scale = scaleOf(opts);
  return {
    height: face.height * scale,
    ascent: face.ascent * scale,
    descent: face.descent * scale,
    lineHeight: lineHeightOf(face, opts) * scale,
    scale,
  };
}

/**
 * Height of one line of this face, in surface pixels.
 *
 * The scalar twin of {@link fontMetrics} — layout code calls it several times a frame, and
 * returning a number rather than a fresh object keeps the per-frame allocation count at zero.
 * @param {TextOptions} [opts]
 * @returns {number}
 */
export function textHeight(opts) {
  return faceOf(opts === undefined ? undefined : opts.font).height * scaleOf(opts);
}

/**
 * Distance from one baseline to the next, in surface pixels (the scalar twin of
 * `fontMetrics().lineHeight`).
 * @param {TextOptions} [opts]
 * @returns {number}
 */
export function lineHeight(opts) {
  const face = faceOf(opts === undefined ? undefined : opts.font);
  return lineHeightOf(face, opts) * scaleOf(opts);
}

/**
 * Break text into lines that each fit `maxWidth` surface pixels.
 *
 * Words are split on spaces; existing `\n` are honoured as hard breaks. A single word longer than
 * the limit is broken mid-word rather than overflowing, because the overlay has no scrollback and
 * an overflowing line would simply disappear off the panel.
 *
 * @param {string} text
 * @param {number} maxWidth surface pixels; values ≤ 0 return the input split on newlines only
 * @param {TextOptions} [opts]
 * @returns {string[]} one entry per line (never empty; a blank input yields `['']`)
 */
export function wrapText(text, maxWidth, opts) {
  const face = faceOf(opts === undefined ? undefined : opts.font);
  const scale = scaleOf(opts);
  const tracking = opts !== undefined && typeof opts.tracking === 'number' ? opts.tracking : 0;
  const limit =
    typeof maxWidth === 'number' && Number.isFinite(maxWidth) && maxWidth > 0
      ? maxWidth / scale
      : Infinity;
  const str = String(text);

  /** @type {string[]} */
  const out = [];
  const hardLines = str.split('\n');
  for (let h = 0; h < hardLines.length; h++) {
    const words = hardLines[h].split(' ');
    let line = '';
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const candidate = line.length === 0 ? word : line + ' ' + word;
      if (measureLineRaw(face, candidate, tracking) <= limit) {
        line = candidate;
        continue;
      }
      // The word does not fit after what is already on the line: break the line first.
      if (line.length > 0) {
        out.push(line);
        line = '';
      }
      if (measureLineRaw(face, word, tracking) <= limit) {
        line = word;
        continue;
      }
      // Still too long on a line of its own — break it mid-word. A single character wider than
      // the limit is emitted anyway; there is nothing else to do with it.
      let chunk = '';
      for (let c = 0; c < word.length; c++) {
        const next = chunk + word[c];
        if (chunk.length > 0 && measureLineRaw(face, next, tracking) > limit) {
          out.push(chunk);
          chunk = word[c];
        } else {
          chunk = next;
        }
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

// ─── Drawing ─────────────────────────────────────────────────────────────────────────────────

/**
 * Draw one line of text.
 *
 * Coordinates are in **surface pixels** and are rounded to integers before drawing: a bitmap glyph
 * landing on a half pixel is the one thing that would break the crispness invariant. `\n` is not
 * interpreted here (one line per call keeps the hot path branch-free); see {@link drawTextBlock}.
 *
 * Never throws: a missing canvas implementation, an unknown face or an unsupported character all
 * degrade to "draw less", because this runs inside `render`.
 *
 * @param {CanvasRenderingContext2D} ctx destination context (image smoothing should be off)
 * @param {string} text
 * @param {number} x anchor x in surface pixels (see `align`)
 * @param {number} y anchor y in surface pixels (see `baseline`)
 * @param {TextOptions} [opts]
 * @returns {number} the advance width actually drawn, in surface pixels
 */
export function drawText(ctx, text, x, y, opts) {
  const str = String(text);
  if (ctx === null || ctx === undefined || str.length === 0) return 0;

  const face = faceOf(opts === undefined ? undefined : opts.font);
  const scale = scaleOf(opts);
  const tracking = opts !== undefined && typeof opts.tracking === 'number' ? opts.tracking : 0;
  const color = opts === undefined ? undefined : opts.color;
  const style = styleOf(color, opts !== undefined && opts.shadow === true);
  const styleKey = color === undefined ? 'hud' : opts !== undefined && opts.shadow === true ? color + '|1' : color;
  const atlas = atlasFor(face, styleKey, style);
  if (atlas === null) return 0;

  const widthRaw = measureLineRaw(face, str, tracking);
  const width = widthRaw * scale;

  const align = opts === undefined ? undefined : opts.align;
  let penX = align === 'center' ? x - Math.round(width / 2) : align === 'right' ? x - width : x;
  const baseline = opts === undefined ? undefined : opts.baseline;
  let top = y;
  if (baseline === 'middle') top = y - Math.round((face.height * scale) / 2);
  else if (baseline === 'baseline') top = y - face.ascent * scale;
  else if (baseline === 'bottom') top = y - face.height * scale;
  penX = Math.round(penX);
  top = Math.round(top);

  const alpha = opts !== undefined && typeof opts.alpha === 'number' ? opts.alpha : 1;
  const prevAlpha = ctx.globalAlpha;
  if (alpha < 1) {
    if (alpha <= 0) return width;
    ctx.globalAlpha = prevAlpha * alpha;
  }

  const offX = atlas.padX * scale;
  const offY = atlas.padY * scale;
  const cellH = atlas.cellH * scale;

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const g = glyphOf(face, code);
    if (g === null) {
      penX += (face.spaceAdv + tracking) * scale;
      continue;
    }
    // Space and other blank glyphs: skip the blit, keep the advance.
    if (code !== 0x20) {
      const sx = atlas.at.get(code);
      const cw = atlas.cw.get(code);
      if (sx !== undefined && cw !== undefined) {
        ctx.drawImage(
          atlas.image,
          sx,
          0,
          cw,
          atlas.cellH,
          penX - offX,
          top - offY,
          cw * scale,
          cellH,
        );
      }
    }
    penX += (g.adv + tracking) * scale;
  }

  if (alpha < 1) ctx.globalAlpha = prevAlpha;
  return width;
}

/**
 * Draw a multi-line string, honouring `\n` and a per-block alignment.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x anchor x
 * @param {number} y anchor y of the **first** line's top edge
 * @param {TextOptions} [opts]
 * @returns {number} total height drawn, in surface pixels
 */
export function drawTextBlock(ctx, text, x, y, opts) {
  const face = faceOf(opts === undefined ? undefined : opts.font);
  const scale = scaleOf(opts);
  const pitch = lineHeightOf(face, opts) * scale;
  const str = String(text);
  let top = y;
  let start = 0;
  for (;;) {
    const nl = str.indexOf('\n', start);
    drawText(ctx, nl < 0 ? str.slice(start) : str.slice(start, nl), x, top, opts);
    top += pitch;
    if (nl < 0) break;
    start = nl + 1;
  }
  return top - y - pitch + face.height * scale;
}

/**
 * Does the face have a glyph for this character? (Diagnostics and tests; the draw path falls back
 * to a space.)
 * @param {FontName} font
 * @param {string} ch a single character
 * @returns {boolean}
 */
export function hasGlyph(font, ch) {
  if (typeof ch !== 'string' || ch.length === 0) return false;
  return glyphOf(faceOf(font), ch.charCodeAt(0)) !== null;
}

/**
 * Immutable description of a face, for tools and tests.
 * @param {FontName} font
 * @returns {{name:string, height:number, ascent:number, descent:number, lineGap:number,
 *   spacing:number, maxWidth:number, monospace:boolean, glyphCount:number}}
 */
export function faceInfo(font) {
  const face = faceOf(font);
  let count = 0;
  for (let i = 0; i < face.ascii.length; i++) if (face.ascii[i] !== null) count++;
  return {
    name: face.name,
    height: face.height,
    ascent: face.ascent,
    descent: face.descent,
    lineGap: face.lineGap,
    spacing: face.spacing,
    maxWidth: face.maxWidth,
    monospace: face.monospace,
    glyphCount: count + face.extra.size,
  };
}

/**
 * The raw 1-bit mask of one glyph — used by the proof sheet in the preview harness and by tests.
 * The returned array is the face's own buffer: **do not modify it**.
 * @param {FontName} font
 * @param {string} ch a single character
 * @returns {{w:number, h:number, mask:Uint8Array}|null} null when the face has no such glyph
 */
export function glyphMask(font, ch) {
  if (typeof ch !== 'string' || ch.length === 0) return null;
  const g = glyphOf(faceOf(font), ch.charCodeAt(0));
  return g === null ? null : { w: g.w, h: g.h, mask: g.mask };
}
