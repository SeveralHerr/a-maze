// @ts-check
/**
 * @file Number, time and label formatting for the overlay, plus the rolling-counter model
 * (ARCHITECTURE.md §4.6).
 *
 * WHY this is its own module: everything here is pure arithmetic on numbers and strings, so it
 * imports nothing, runs in Node and is exhaustively unit-testable. The HUD and the menus then
 * contain only drawing code. Nothing in here throws — every function takes untrusted numbers
 * (a NaN score, a negative timer, an Infinity distance) and returns a sane string, because a
 * formatting exception during `render` would take the whole frame loop down.
 *
 * ## Units & conventions (invariants)
 * - Times are **seconds** (the unit the whole sim uses); output is `mm:ss`.
 * - Scores are integers; fractional input is floored, never rounded, so a counter rolling up to
 *   a target can never briefly display a value the player has not earned yet.
 * - Digit grouping uses `,` because the display font's comma is a full glyph; a thin space would
 *   need a font feature the bitmap faces do not have.
 */

// ─── Constants ───────────────────────────────────────────────────────────────────────────────

/**
 * Largest score the formatter will print in full. Beyond this it clamps rather than switching to
 * exponent notation, which no bitmap font can render legibly.
 */
const MAX_SCORE = 999999999;

/** `mm:ss` saturates here: 99:59. A single level can never approach it, but a soak test can. */
const MAX_CLOCK_SECONDS = 99 * 60 + 59;

/**
 * Rolling-counter tuning. A counter closes the gap in `DURATION` seconds, but never slower than
 * `MIN_RATE` units/second — otherwise a `+10` pop would crawl — and never slower than 1 unit per
 * frame at 60 Hz, so it always terminates.
 * @type {Readonly<Record<string, number>>}
 */
export const ROLL = Object.freeze({
  /** Seconds to close the whole remaining gap at the current rate. */
  DURATION: 0.42,
  /** Floor on the roll rate, in units/second. */
  MIN_RATE: 60,
  /** Gap below which the counter simply snaps (stops the last few units dribbling). */
  SNAP_EPSILON: 0.5,
});

// ─── Integers ────────────────────────────────────────────────────────────────────────────────

/**
 * Coerce anything to a safe integer for display: non-finite → 0, fractional → floored toward
 * −∞, magnitude clamped to `MAX_SCORE`.
 * @param {unknown} n
 * @returns {number} a finite integer in [-MAX_SCORE, MAX_SCORE]
 */
export function safeInt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  const v = Math.floor(n);
  if (v > MAX_SCORE) return MAX_SCORE;
  if (v < -MAX_SCORE) return -MAX_SCORE;
  return v;
}

/**
 * Group an integer with thousands separators: `1234567` → `"1,234,567"`.
 * @param {number} n any number (floored; non-finite → 0)
 * @returns {string}
 */
export function formatInt(n) {
  const v = safeInt(n);
  const neg = v < 0;
  let s = String(neg ? -v : v);
  // Walk from the right in groups of three. A manual loop beats a regex here: it allocates one
  // string per group instead of compiling and running a global pattern every frame.
  if (s.length > 3) {
    let out = '';
    let i = s.length;
    while (i > 3) {
      out = ',' + s.slice(i - 3, i) + out;
      i -= 3;
    }
    s = s.slice(0, i) + out;
  }
  return neg ? '-' + s : s;
}

/**
 * The score as the HUD prints it. Alias of {@link formatInt}, named for the call site so the
 * grouping rule can change for scores alone later without touching every caller.
 * @param {number} n
 * @returns {string}
 */
export function formatScore(n) {
  return formatInt(n);
}

/**
 * A signed delta for the floating pickup pops: `+100`, `-25`, `+0`.
 * @param {number} n
 * @returns {string}
 */
export function formatSigned(n) {
  const v = safeInt(n);
  return v < 0 ? formatInt(v) : '+' + formatInt(v);
}

/**
 * Left-pad to a fixed width. Used for digit columns in the tally, where a proportional face would
 * otherwise make the numbers dance as they roll.
 * @param {string} s
 * @param {number} len target length (values ≤ the string's length return it unchanged)
 * @param {string} [pad] single padding character, default `'0'`
 * @returns {string}
 */
export function padLeft(s, len, pad = '0') {
  const str = String(s);
  const n = Number.isFinite(len) ? Math.floor(len) : 0;
  if (str.length >= n || pad.length === 0) return str;
  let out = str;
  while (out.length < n) out = pad.charAt(0) + out;
  return out;
}

// ─── Time ────────────────────────────────────────────────────────────────────────────────────

/**
 * Seconds → `mm:ss`, zero-padded to two digits each and saturating at `99:59`.
 *
 * Seconds are **floored**, so a timer counting up shows `0:00` for the whole first second, the way
 * a stopwatch does; a fuel gauge counting down therefore never shows `0:00` while fuel remains.
 * @param {number} seconds negative or non-finite input reads as 0
 * @returns {string} e.g. `"03:07"`
 */
export function formatClock(seconds) {
  const s = clampSeconds(seconds);
  const m = (s / 60) | 0;
  const r = s - m * 60;
  return padLeft(String(m), 2) + ':' + padLeft(String(r), 2);
}

/**
 * Seconds → `m:ss` with no leading zero on the minutes — the compact form for the fuel readout,
 * where the leading `0` is noise.
 * @param {number} seconds
 * @returns {string} e.g. `"3:07"`
 */
export function formatTime(seconds) {
  const s = clampSeconds(seconds);
  const m = (s / 60) | 0;
  const r = s - m * 60;
  return m + ':' + padLeft(String(r), 2);
}

/**
 * Clamp and floor a seconds value into the range `mm:ss` can represent.
 * @param {number} seconds
 * @returns {number} integer seconds in [0, MAX_CLOCK_SECONDS]
 */
function clampSeconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 0;
  const s = Math.floor(seconds);
  return s > MAX_CLOCK_SECONDS ? MAX_CLOCK_SECONDS : s;
}

// ─── Labels ──────────────────────────────────────────────────────────────────────────────────

/**
 * `"3 / 12"` — collected out of total. The spaces are deliberate: at HUD size the slash sits
 * tight against the digits without them.
 * @param {number} n
 * @param {number} total
 * @returns {string}
 */
export function formatCount(n, total) {
  return safeInt(n) + '/' + safeInt(total);
}

/**
 * `"DEPTH 3"` — the level indicator. The game calls levels *depths* because you descend.
 * @param {number} level 1-based
 * @returns {string}
 */
export function formatDepth(level) {
  const v = safeInt(level);
  return 'DEPTH ' + (v < 1 ? 1 : v);
}

/**
 * A 0..1 fraction as a whole-percent string, clamped: `0.834` → `"83%"`.
 * @param {number} f
 * @returns {string}
 */
export function formatPercent(f) {
  if (typeof f !== 'number' || !Number.isFinite(f)) return '0%';
  const v = f <= 0 ? 0 : f >= 1 ? 1 : f;
  return Math.round(v * 100) + '%';
}

/**
 * A distance in tiles for the compass readout: `"12m"`. Tiles are read as metres because a
 * corridor is roughly a metre wide — a unit the player already understands.
 *
 * Distances are grouped past a thousand (`"1,240m"`), because a walk across a 128-cell labyrinth
 * really does run into four figures and `1240m` is a wall of digits at HUD size.
 * @param {number} tiles non-finite (no level loaded) reads as `"--"`
 * @returns {string}
 */
export function formatDistance(tiles) {
  if (typeof tiles !== 'number' || !Number.isFinite(tiles)) return '--';
  const v = tiles < 0 ? 0 : tiles;
  return formatInt(Math.round(v)) + 'm';
}

/**
 * A maze's size as the player reads it: `"80×80"` — **cells**, not tiles, because cells are the
 * unit the difficulty curve is expressed in and the number a player can compare between depths.
 *
 * The `×` is a real glyph in both bitmap faces (`font.js` covers `© × … ·`), so this never falls
 * back to an `x`.
 * @param {number} cols cell columns
 * @param {number} rows cell rows
 * @returns {string}
 */
export function formatLabyrinth(cols, rows) {
  const c = Math.max(1, safeInt(cols));
  const r = Math.max(1, safeInt(rows));
  return c + '×' + r;
}

/**
 * The level-start banner: `"DEPTH 7 · 80×80 LABYRINTH"`.
 *
 * The separator is a middle dot, not an em dash: the bitmap faces cover 0x20…0x7E plus `© × … ·`
 * only (`font.js`), and an em dash would silently render as a hole in the line.
 * @param {number} level 1-based
 * @param {number} cols
 * @param {number} rows
 * @returns {string}
 */
export function formatLevelBanner(level, cols, rows) {
  return formatDepth(level) + ' · ' + formatLabyrinth(cols, rows) + ' LABYRINTH';
}

/**
 * A count of things with a unit that has to pluralise: `"3 REFUELS"`, `"1 REFUEL"`.
 * @param {number} n
 * @param {string} unit singular, upper case
 * @returns {string}
 */
export function formatUnits(n, unit) {
  const v = safeInt(n);
  return formatInt(v) + ' ' + unit + (v === 1 ? '' : 'S');
}

// ─── Rolling counter ─────────────────────────────────────────────────────────────────────────

/**
 * An animated integer readout: the score that rolls up to its new value instead of snapping, and
 * every line of the level-complete tally.
 * @typedef {Object} Counter
 * @property {number} value    the integer to display right now (read-only for consumers)
 * @property {number} target   the value it is rolling toward
 * @property {boolean} done    true when `value === target`
 * @property {(v:number) => void} set   roll toward `v` from wherever the counter is
 * @property {(v:number) => void} snap  jump straight to `v` (level change, screen entry, skip)
 * @property {(dt:number) => boolean} update  advance by `dt` seconds; returns true if it moved
 */

/**
 * Create a rolling counter.
 *
 * The roll rate is proportional to the remaining gap (`gap / ROLL.DURATION`) with a floor, so a
 * `+100` gem pop and a `+12,000` level bonus both finish in about the same time while a small
 * change still moves fast enough to read as an increment rather than a fade.
 *
 * It keeps a float accumulator internally and exposes only the rounded integer, so the value
 * never flickers between two neighbouring numbers on slow frames.
 *
 * @param {number} [initial] starting value (default 0)
 * @returns {Counter}
 */
export function createCounter(initial = 0) {
  let current = safeInt(initial);
  let target = current;
  /** Float position; `value` is this rounded toward the target. */
  let pos = current;

  const counter = {
    get value() {
      return current;
    },
    get target() {
      return target;
    },
    get done() {
      return current === target;
    },
    /**
     * @param {number} v
     * @returns {void}
     */
    set(v) {
      target = safeInt(v);
    },
    /**
     * @param {number} v
     * @returns {void}
     */
    snap(v) {
      target = safeInt(v);
      pos = target;
      current = target;
    },
    /**
     * @param {number} dt seconds
     * @returns {boolean} true when the displayed value changed
     */
    update(dt) {
      if (current === target) return false;
      const step = typeof dt === 'number' && Number.isFinite(dt) && dt > 0 ? dt : 0;
      const gap = target - pos;
      const dist = gap < 0 ? -gap : gap;
      if (dist <= ROLL.SNAP_EPSILON || step === 0) {
        // A zero dt still resolves a sub-unit gap: `update(0)` must never leave the counter
        // permanently one unit short of its target.
        if (dist <= ROLL.SNAP_EPSILON) {
          pos = target;
          current = target;
          return true;
        }
        return false;
      }
      const rate = Math.max(ROLL.MIN_RATE, dist / ROLL.DURATION);
      const move = rate * step;
      if (move >= dist) {
        pos = target;
      } else {
        pos += gap < 0 ? -move : move;
      }
      // Truncate toward the start of the roll so the readout never overshoots its target.
      const shown = gap > 0 ? Math.floor(pos) : Math.ceil(pos);
      if (shown === current) return false;
      current = shown;
      return true;
    },
  };
  return counter;
}
