// @ts-check
/**
 * @file Unit tests for the CSS post-effect stack (run: `node src/renderer/post.test.mjs`).
 *
 * `post.js` is DOM code, so these tests drive it through a fake document small enough to read in
 * one screen. That is worth doing because the module's whole value is a promise about *when* it
 * touches the DOM: `set()` is called every frame from the render loop, and it must write a style
 * only when a value actually changed. A regression there would not break anything visually — it
 * would just quietly cost a style recalculation sixty times a second.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPost } from './post.js';

/**
 * A fake element whose `style` counts writes.
 * @param {string} tag
 * @param {{writes:number}} meter
 * @returns {any}
 */
function makeElement(tag, meter) {
  /** @type {any} */
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    children: /** @type {any[]} */ ([]),
    parentNode: /** @type {any} */ (null),
    ownerDocument: /** @type {any} */ (null),
    /**
     * @param {any} child
     * @returns {any}
     */
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    /**
     * @param {any} child
     * @returns {any}
     */
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
  };
  /** @type {Record<string, string>} */
  const raw = {};
  el.style = new Proxy(raw, {
    set(target, key, value) {
      // Only count a write that actually changes the computed value — that is what the browser
      // would treat as a style invalidation.
      if (target[/** @type {string} */ (key)] !== value) meter.writes++;
      target[/** @type {string} */ (key)] = String(value);
      return true;
    },
  });
  return el;
}

/**
 * A fake document with just enough surface for `createPost`.
 * @returns {{doc:any, root:any, meter:{writes:number}}}
 */
function makeDom() {
  const meter = { writes: 0 };
  /** @type {any[]} */
  const all = [];
  /** @type {any} */
  const doc = {
    /**
     * @param {string} tag
     * @returns {any}
     */
    createElement(tag) {
      const el = makeElement(tag, meter);
      el.ownerDocument = doc;
      all.push(el);
      return el;
    },
    /**
     * @param {string} id
     * @returns {any}
     */
    getElementById(id) {
      return all.find((e) => e.id === id) || null;
    },
  };
  doc.head = makeElement('head', meter);
  doc.head.ownerDocument = doc;
  const root = makeElement('div', meter);
  root.ownerDocument = doc;
  return { doc, root, meter };
}

test('a missing or DOM-less root yields an inert stub instead of throwing', () => {
  for (const bad of [null, undefined, {}, { ownerDocument: null }]) {
    const post = createPost(/** @type {any} */ (bad));
    assert.doesNotThrow(() => post.set({ scanlines: true, vignette: 1, iris: 0.5 }));
    assert.doesNotThrow(() => post.resize(800, 600, 240));
    assert.doesNotThrow(() => post.destroy());
  }
});

test('the stack builds five layers and injects its stylesheet exactly once', () => {
  const { doc, root } = makeDom();
  createPost(root);
  assert.equal(root.children.length, 5, 'scanlines, vignette, low-fuel, flash, iris');
  for (const el of root.children) {
    assert.match(el.className, /^amaze-post-layer amaze-post-/);
  }
  assert.equal(doc.head.children.length, 1, 'one <style>');
  assert.ok(doc.head.children[0].textContent.includes('.amaze-post-layer'));

  // A second instance on the same document reuses the sheet.
  const second = root.ownerDocument.createElement('div');
  createPost(second);
  assert.equal(doc.head.children.length, 1, 'the stylesheet must not be injected twice');
});

test('set() writes a style only when a value changes', () => {
  const { root, meter } = makeDom();
  const post = createPost(root);
  post.resize(720, 720, 240); // pitch 3
  meter.writes = 0;

  post.set({ scanlines: true, vignette: 0.7, lowFuelPulse: 0, flash: { r: 0, g: 0, b: 0, a: 0 }, iris: 1 });
  const first = meter.writes;
  assert.ok(first > 0, 'the first call has to apply the values');

  // Re-applying identical values must be free.
  for (let i = 0; i < 10; i++) {
    post.set({ scanlines: true, vignette: 0.7, lowFuelPulse: 0, flash: { r: 0, g: 0, b: 0, a: 0 }, iris: 1 });
  }
  assert.equal(meter.writes, first, 'repeated identical set() calls must not touch the DOM');

  // Sub-quantum changes are also free (alpha is quantised to 1/128).
  post.set({ vignette: 0.7 + 1 / 400 });
  assert.equal(meter.writes, first, 'a change below the quantisation step must not write');

  // A real change does write.
  post.set({ vignette: 0.2 });
  assert.ok(meter.writes > first);
});

test('the scanline pitch is an integer number of CSS pixels and switches off when too fine', () => {
  const { root } = makeDom();
  const post = createPost(root);
  const scan = root.children[0];
  post.set({ scanlines: true });

  post.resize(1280, 720, 240); // 3 CSS px per internal row
  assert.match(scan.style.backgroundImage, /repeating-linear-gradient/);
  assert.match(scan.style.backgroundImage, /\b3px\)/, 'pitch should be exactly 3px');
  assert.doesNotMatch(scan.style.backgroundImage, /\d\.\d+px/, 'no fractional stops (they moiré)');

  post.resize(1920, 1440, 240); // 6 CSS px per row → a thicker line
  assert.match(scan.style.backgroundImage, /\b6px\)/);

  post.resize(400, 240, 240); // 1:1 — no room for a line
  assert.equal(scan.style.backgroundImage, 'none');

  post.set({ scanlines: false });
  assert.equal(scan.style.opacity, '0');
});

test('the iris closes to a hole and hides itself when fully open', () => {
  const { root } = makeDom();
  const post = createPost(root);
  const iris = root.children[4];

  post.set({ iris: 1 });
  assert.equal(iris.style.opacity, '0', 'a fully open iris must not cost a composited layer');

  post.set({ iris: 0.5 });
  assert.equal(iris.style.opacity, '1');
  // A radial gradient with a transparent centre is the only way to cut a hole in an overlay.
  assert.match(iris.style.background, /radial-gradient\(circle at 50% 50%,rgba\(0,0,0,0\) 0 /);

  post.set({ iris: 0 });
  assert.match(iris.style.background, /0 0\.0%/, 'a closed iris has no transparent radius');
});

test('flash colour is only written while the flash is visible', () => {
  const { root, meter } = makeDom();
  const post = createPost(root);
  const flash = root.children[3];

  post.set({ flash: { r: 255, g: 240, b: 200, a: 0 } });
  assert.equal(flash.style.opacity, '0');
  meter.writes = 0;
  // Colour changes while invisible cost nothing.
  post.set({ flash: { r: 10, g: 20, b: 30, a: 0 } });
  assert.equal(meter.writes, 0);

  post.set({ flash: { r: 10, g: 20, b: 30, a: 0.5 } });
  assert.equal(flash.style.backgroundColor, 'rgb(10,20,30)');
  assert.ok(Number(flash.style.opacity) > 0.49 && Number(flash.style.opacity) < 0.51);
});

test('destroy removes the layers it added', () => {
  const { root } = makeDom();
  const post = createPost(root);
  assert.equal(root.children.length, 5);
  post.destroy();
  assert.equal(root.children.length, 0);
  assert.doesNotThrow(() => post.destroy(), 'destroy must be idempotent');
});
