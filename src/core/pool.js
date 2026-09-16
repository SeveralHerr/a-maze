// @ts-check
/**
 * @file Fixed-capacity object pool for particles, sparks and other short-lived per-frame objects.
 *
 * The renderer must not allocate while a frame is in flight — a GC pause of even 4 ms shows up as
 * a visible hitch at 60 fps. A pool preallocates every object at construction and hands out the
 * same instances forever, so the steady-state allocation rate of the particle system is zero.
 *
 * Layout: one dense array where the first `count` entries are live and the rest are free. Both
 * `acquire` and `release` are O(1) — release swaps the released object with the last live one
 * (the "swap-remove" idiom), which is why **live order is not stable**; particles do not care.
 *
 * Typical per-frame use (note the reverse iteration, so a swap-remove cannot skip an entry):
 * ```js
 * for (let i = pool.count - 1; i >= 0; i--) {
 *   const p = pool.items[i];
 *   p.life -= dt;
 *   if (p.life <= 0) pool.releaseAt(i);
 * }
 * ```
 */

/**
 * @template T
 * @typedef {Object} Pool
 * @property {T[]} items            backing store; entries [0, count) are live. Do not resize it.
 * @property {number} count         live objects (getter)
 * @property {number} capacity      total objects ever allocated (getter)
 * @property {number} free          capacity - count (getter)
 * @property {() => (T|null)} acquire       take a free object, or null when exhausted
 * @property {(obj:T) => boolean} release   return an object; false if it was not live
 * @property {(index:number) => boolean} releaseAt  return the live object at `index`
 * @property {(fn:(obj:T, index:number) => boolean) => void} retain
 *   visit every live object; releasing the ones for which `fn` returns false
 * @property {() => void} clear     release everything
 */

/**
 * Create a pool of `size` objects.
 *
 * `factory` is called exactly `size` times, up front. `reset` is called whenever an object is
 * returned to the pool (and by `clear`), which is the right moment to drop references the object
 * holds so they can be collected, and leaves every acquired object in a known-clean state.
 * @template T
 * @param {() => T} factory create one object
 * @param {(obj:T) => void} reset return one object to its neutral state
 * @param {number} size capacity, ≥ 0 (non-integer values are floored)
 * @returns {Pool<T>}
 */
export function createPool(factory, reset, size) {
  if (typeof factory !== 'function') throw new TypeError('createPool: factory must be a function');
  if (typeof reset !== 'function') throw new TypeError('createPool: reset must be a function');
  const capacity = Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0;

  /** @type {T[]} */
  const items = new Array(capacity);
  /** Index of each object inside `items`, kept in sync by the swap-remove in `releaseAt`. */
  const index = new Map();
  let count = 0;

  for (let i = 0; i < capacity; i++) {
    const obj = factory();
    items[i] = obj;
    reset(obj);
    index.set(obj, i);
  }

  /**
   * @returns {T|null} a clean object, or null when the pool is exhausted (the caller should skip
   *   spawning rather than grow: a fixed budget is what keeps frame time bounded)
   */
  function acquire() {
    if (count >= capacity) return null;
    return items[count++];
  }

  /**
   * @param {number} i index of a live object
   * @returns {boolean} true if something was released
   */
  function releaseAt(i) {
    if (!(i >= 0 && i < count)) return false;
    const obj = items[i];
    const last = count - 1;
    if (i !== last) {
      const swapped = items[last];
      items[i] = swapped;
      items[last] = obj;
      index.set(swapped, i);
      index.set(obj, last);
    }
    count = last;
    reset(obj);
    return true;
  }

  /**
   * @param {T} obj an object previously returned by `acquire`
   * @returns {boolean} false if the object is not from this pool or is already free
   */
  function release(obj) {
    const i = index.get(obj);
    return i === undefined ? false : releaseAt(i);
  }

  /**
   * Visit every live object exactly once, releasing those for which `fn` returns false. Handles
   * the swap-remove correctly (the swapped-in object is visited in the same pass), so callers do
   * not have to think about iteration order.
   * @param {(obj:T, index:number) => boolean} fn return true to keep the object alive
   * @returns {void}
   */
  function retain(fn) {
    let i = 0;
    while (i < count) {
      if (fn(items[i], i)) i++;
      else releaseAt(i); // a different object now occupies slot i — revisit it
    }
  }

  /** @returns {void} */
  function clear() {
    while (count > 0) releaseAt(count - 1);
  }

  return {
    items,
    get count() {
      return count;
    },
    get capacity() {
      return capacity;
    },
    get free() {
      return capacity - count;
    },
    acquire,
    release,
    releaseAt,
    retain,
    clear,
  };
}
