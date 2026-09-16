// @ts-check
/**
 * @file Unit tests for `src/input/fullscreen.js`, driven through the fake DOM
 * (`fake-dom.test-util.mjs`) so they run in plain Node.
 * Run: `node src/input/fullscreen.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFullscreen, shouldAutoFullscreen } from './fullscreen.js';
import { createFakeEnv } from './fake-dom.test-util.mjs';

/** Let queued promise reactions (the swallowed rejections) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** @returns {{env: any, doc: any, html: any, fs: ReturnType<typeof createFullscreen>}} */
function setup() {
  const env = createFakeEnv();
  const doc = env.document;
  const fs = createFullscreen({ env: { document: doc } });
  return { env, doc, html: doc.documentElement, fs };
}

test('shouldAutoFullscreen: the param overrides, otherwise embedded && setting && !headless', () => {
  for (const headless of [false, true]) {
    for (const embedded of [false, true]) {
      for (const setting of [false, true]) {
        const o = { headless, embedded, setting };
        assert.equal(shouldAutoFullscreen({ ...o, param: '1' }), true, `param 1 ${JSON.stringify(o)}`);
        assert.equal(shouldAutoFullscreen({ ...o, param: '0' }), false, `param 0 ${JSON.stringify(o)}`);
        const expected = !headless && embedded && setting;
        for (const param of [null, undefined, '', 'yes']) {
          assert.equal(shouldAutoFullscreen({ ...o, param }), expected, `param ${param} ${JSON.stringify(o)}`);
        }
      }
    }
  }
  assert.equal(shouldAutoFullscreen(/** @type {any} */ (undefined)), false, 'garbage is a no');
});

test('request enters fullscreen once, then no-ops while active; exit leaves', () => {
  const { doc, html, fs } = setup();
  assert.equal(fs.supported, true);
  assert.equal(fs.active, false);
  assert.equal(fs.request(), true);
  assert.equal(html.requestFullscreenCalls, 1);
  assert.equal(fs.active, true);
  assert.equal(fs.request(), false, 'already active');
  assert.equal(html.requestFullscreenCalls, 1);
  fs.exit();
  assert.equal(doc.exitFullscreenCalls, 1);
  assert.equal(fs.active, false);
  fs.exit();
  assert.equal(doc.exitFullscreenCalls, 1, 'exit is a no-op when not fullscreen');
});

test('request is a no-op when unsupported or disallowed by the embed', () => {
  const a = setup();
  delete a.html.requestFullscreen;
  assert.equal(a.fs.supported, false);
  assert.equal(a.fs.request(), false);
  assert.equal(a.fs.active, false);

  const b = setup();
  b.doc.fullscreenEnabled = false; // an iframe without `allowfullscreen`
  assert.equal(b.fs.supported, false);
  assert.equal(b.fs.request(), false);
  assert.equal(b.html.requestFullscreenCalls, 0);

  // No document at all (Node without an env) must not throw either.
  const c = createFullscreen({ env: {}, root: null });
  assert.equal(c.supported, typeof document !== 'undefined');
  assert.doesNotThrow(() => c.request());
  assert.doesNotThrow(() => c.exit());
  c.destroy();
});

test('webkit-prefixed API is used when the standard one is missing', () => {
  const env = createFakeEnv();
  /** @type {any} */
  const doc = env.document;
  const html = doc.documentElement;
  delete html.requestFullscreen;
  // Model Safari: no unprefixed members on the document either.
  doc.fullscreenElement = undefined;
  doc.exitFullscreen = undefined;
  doc.webkitFullscreenElement = null;
  let webkitCalls = 0;
  html.webkitRequestFullscreen = () => {
    webkitCalls++;
    doc.webkitFullscreenElement = html;
    doc.dispatchEvent({ type: 'webkitfullscreenchange' });
  };
  let webkitExits = 0;
  doc.webkitExitFullscreen = () => {
    webkitExits++;
    doc.webkitFullscreenElement = null;
    doc.dispatchEvent({ type: 'webkitfullscreenchange' });
  };
  const fs = createFullscreen({ env: { document: doc } });
  /** @type {boolean[]} */
  const seen = [];
  fs.onChange((a) => seen.push(a));
  assert.equal(fs.supported, true);
  assert.equal(fs.request(), true);
  assert.equal(webkitCalls, 1);
  assert.equal(fs.active, true);
  fs.exit();
  assert.equal(webkitExits, 1);
  assert.equal(fs.active, false);
  assert.deepEqual(seen, [true, false]);
});

test('a rejected promise and a synchronous throw are both swallowed', async () => {
  const { html, fs } = setup();
  let rejections = 0;
  html.requestFullscreen = () => {
    rejections++;
    return Promise.reject(new TypeError('Permissions check failed'));
  };
  /** @type {unknown[]} */
  const unhandled = [];
  const onUnhandled = (/** @type {unknown} */ r) => unhandled.push(r);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.doesNotThrow(() => fs.request());
    await flush();
    assert.equal(rejections, 1);
    assert.deepEqual(unhandled, [], 'the refusal never surfaces as an unhandled rejection');

    html.requestFullscreen = () => {
      throw new Error('not allowed');
    };
    assert.doesNotThrow(() => assert.equal(fs.request(), false));
    assert.equal(fs.active, false);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('onChange fires once per transition (both events de-duplicated), unsubscribe and destroy detach', () => {
  const { env, doc, fs } = setup();
  /** @type {boolean[]} */
  const seen = [];
  const off = fs.onChange((a) => seen.push(a));
  fs.request();
  // Chrome also sends the prefixed event for the same transition.
  doc.dispatchEvent({ type: 'webkitfullscreenchange' });
  assert.deepEqual(seen, [true]);

  /** @type {boolean[]} */
  const other = [];
  fs.onChange((a) => other.push(a));
  off();
  fs.exit();
  assert.deepEqual(seen, [true], 'unsubscribed');
  assert.deepEqual(other, [false]);

  assert.equal(doc.listenerCount(), 2, 'standard + webkit change listeners');
  fs.destroy();
  assert.equal(env.totalListeners(), 0, 'destroy leaves no listener anywhere');
  fs.destroy(); // idempotent
  doc.fullscreenElement = doc.documentElement;
  doc.dispatchEvent({ type: 'fullscreenchange' });
  assert.deepEqual(other, [false], 'nothing fires after destroy');
  doc.fullscreenElement = null;
  assert.equal(fs.request(), false, 'request after destroy is a no-op');
});

test('a throwing subscriber does not stop the others', () => {
  const { fs } = setup();
  let reached = false;
  fs.onChange(() => {
    throw new Error('boom');
  });
  fs.onChange(() => {
    reached = true;
  });
  assert.doesNotThrow(() => fs.request());
  assert.equal(reached, true);
});
