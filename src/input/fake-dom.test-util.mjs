// @ts-check
/**
 * @file A minimal, dependency-free DOM double for the input tests.
 *
 * Test-only (the `.test-util.mjs` suffix keeps it out of both the `*.test.mjs` runner and the
 * production import graph). It implements exactly the surface `src/input` touches — listener
 * registration with *observable bookkeeping*, element creation, styles, bounding rects, pointer
 * lock and `navigator.getGamepads` — so the tests can assert things a real browser hides, above
 * all "after `destroy()` not one listener is left anywhere".
 *
 * Events are plain objects: `{type, ...}`. Nothing here simulates the real event model beyond
 * single-target dispatch plus one level of manual bubbling, which is all the module needs.
 */

/** Simple style bag: any property can be written, `cssText` is stored verbatim. */
class FakeStyle {
  constructor() {
    this.cssText = '';
    this.touchAction = '';
  }
  /**
   * @param {string} k
   * @param {string} v
   */
  setProperty(k, v) {
    /** @type {any} */ (this)[k] = v;
  }
}

export class FakeNode {
  /**
   * @param {FakeDocument|null} ownerDocument
   * @param {string} tag
   */
  constructor(ownerDocument, tag) {
    this.ownerDocument = ownerDocument;
    this.tagName = String(tag).toUpperCase();
    this.style = new FakeStyle();
    /** @type {FakeNode[]} */
    this.childNodes = [];
    /** @type {FakeNode|null} */
    this.parentNode = null;
    this.textContent = '';
    /** @type {Record<string,string>} */
    this.attributes = {};
    /** @type {Map<string, {fn:Function, opt:any}[]>} */
    this.listeners = new Map();
    this.rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 };
    if (ownerDocument) ownerDocument.allNodes.push(this);
  }

  /**
   * @param {string} type
   * @param {Function} fn
   * @param {any} [opt]
   */
  addEventListener(type, fn, opt) {
    let arr = this.listeners.get(type);
    if (!arr) {
      arr = [];
      this.listeners.set(type, arr);
    }
    arr.push({ fn, opt });
  }

  /**
   * @param {string} type
   * @param {Function} fn
   */
  removeEventListener(type, fn) {
    const arr = this.listeners.get(type);
    if (!arr) return;
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].fn === fn) arr.splice(i, 1);
    if (arr.length === 0) this.listeners.delete(type);
  }

  /** @param {any} ev */
  dispatchEvent(ev) {
    if (typeof ev.preventDefault !== 'function') {
      ev.defaultPrevented = false;
      ev.preventDefault = function () {
        this.defaultPrevented = true;
      };
    }
    if (typeof ev.stopPropagation !== 'function') {
      ev.propagationStopped = false;
      ev.stopPropagation = function () {
        this.propagationStopped = true;
      };
    }
    if (ev.target === undefined) ev.target = this;
    /** @type {FakeNode|null} */
    let node = this;
    while (node) {
      const arr = node.listeners.get(ev.type);
      if (arr) for (const { fn } of arr.slice()) fn.call(node, ev);
      if (ev.propagationStopped || ev.bubbles !== true) break;
      node = node.parentNode;
    }
    return !ev.defaultPrevented;
  }

  /** @param {FakeNode} child */
  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  /** @param {FakeNode} child */
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  /**
   * @param {string} k
   * @param {string} v
   */
  setAttribute(k, v) {
    this.attributes[k] = v;
  }

  /** Total listeners registered on this node, across all event types. */
  listenerCount() {
    let n = 0;
    for (const arr of this.listeners.values()) n += arr.length;
    return n;
  }

  /** Depth-first search for the first descendant whose textContent matches. */
  /** @param {string} text */
  findByText(text) {
    if (this.textContent === text) return this;
    for (const c of this.childNodes) {
      const hit = c.findByText(text);
      if (hit) return hit;
    }
    return null;
  }
}

export class FakeDocument extends FakeNode {
  constructor() {
    super(null, 'document');
    /** @type {FakeNode[]} every node this document ever created, for leak assertions */
    this.allNodes = [this];
    this.body = new FakeNode(this, 'body');
    this.body.parentNode = this;
    this.childNodes.push(this.body);
    /** @type {FakeNode|null} */
    this.activeElement = null;
    /** @type {FakeNode|null} */
    this.pointerLockElement = null;
    this.hidden = false;
    /** @type {Record<string, FakeNode>} */
    this.ids = {};
    /** @type {any} */
    this.defaultView = null;
    this.exitPointerLockCalls = 0;
    // Fullscreen API (for `fullscreen.test.mjs`). `documentElement.requestFullscreen` behaves like a
    // browser that grants the request; a test deletes or replaces it to model refusal, the webkit
    // prefix, or no support at all. `fullscreenchange` is dispatched synchronously (a real browser
    // does it a task later), which is all the module's bookkeeping needs.
    this.documentElement = new FakeNode(this, 'html');
    this.documentElement.parentNode = this;
    /** @type {FakeNode|null} */
    this.fullscreenElement = null;
    this.exitFullscreenCalls = 0;
    const doc = this;
    const html = /** @type {any} */ (this.documentElement);
    html.requestFullscreenCalls = 0;
    html.requestFullscreen = function () {
      html.requestFullscreenCalls++;
      doc.fullscreenElement = html;
      doc.dispatchEvent({ type: 'fullscreenchange' });
      return Promise.resolve();
    };
  }

  exitFullscreen() {
    this.exitFullscreenCalls++;
    this.fullscreenElement = null;
    this.dispatchEvent({ type: 'fullscreenchange' });
    return Promise.resolve();
  }

  /** @param {string} tag */
  createElement(tag) {
    return new FakeNode(this, tag);
  }

  /** @param {string} id */
  getElementById(id) {
    return this.ids[id] || null;
  }

  exitPointerLock() {
    this.exitPointerLockCalls++;
    this.pointerLockElement = null;
  }
}

export class FakeWindow extends FakeNode {
  /** @param {FakeDocument} doc */
  constructor(doc) {
    super(doc, 'window');
    this.document = doc;
    this.innerWidth = 800;
    this.innerHeight = 600;
    /** @type {Record<string, boolean>} media query string → matches */
    this.media = {};
    this.performance = { now: () => this.clock };
    this.clock = 0;
  }

  /** @param {string} q */
  matchMedia(q) {
    return { matches: this.media[q] === true, media: q, addEventListener() {}, removeEventListener() {} };
  }
}

/**
 * Build a complete fake environment plus the canvas element the input module binds to.
 * @param {Object} [opts]
 * @param {boolean} [opts.coarsePointer]  report a touch-primary device to `matchMedia`
 * @returns {{window: any, document: any, navigator: any, performance: any, canvas: any,
 *   touchRoot: any, setGamepads: (pads:any[]) => void, advance: (ms:number) => void,
 *   totalListeners: () => number}}
 */
export function createFakeEnv(opts) {
  const options = opts || {};
  const doc = new FakeDocument();
  const win = new FakeWindow(doc);
  doc.defaultView = win;
  if (options.coarsePointer) {
    win.media['(pointer: coarse)'] = true;
    win.media['(any-pointer: fine)'] = false;
  }

  const canvas = doc.createElement('canvas');
  doc.body.appendChild(canvas);
  /** @type {any} */ (canvas).requestPointerLock = function () {
    doc.pointerLockElement = canvas;
    return undefined;
  };

  const touchRoot = doc.createElement('div');
  doc.body.appendChild(touchRoot);
  doc.ids.touch = touchRoot;

  /** @type {any[]} */
  let gamepads = [];
  const nav = {
    maxTouchPoints: options.coarsePointer ? 5 : 0,
    getGamepads: () => gamepads,
  };

  return {
    window: win,
    document: doc,
    navigator: nav,
    performance: win.performance,
    canvas,
    touchRoot,
    setGamepads(pads) {
      gamepads = pads;
    },
    advance(ms) {
      win.clock += ms;
    },
    // `win` is itself registered in `doc.allNodes` (it is constructed with the document as its
    // owner), so summing that list alone covers window, document and every element.
    totalListeners() {
      let n = 0;
      for (const node of doc.allNodes) n += node.listenerCount();
      return n;
    },
  };
}

/**
 * Build a gamepad object in the shape `navigator.getGamepads()` returns.
 * @param {Object} [spec]
 * @param {number[]} [spec.axes]
 * @param {number[]} [spec.pressed]  indices of pressed buttons
 * @param {number} [spec.buttonCount]
 * @param {string} [spec.mapping]  W3C mapping; `''` is what Chrome reports for any HID pad it
 *   does not recognise (generic USB pads, arcade sticks, wheels), where no index means anything
 * @param {number} [spec.index]
 * @returns {any}
 */
export function fakePad(spec) {
  const s = spec || {};
  const count = s.buttonCount === undefined ? 17 : s.buttonCount;
  const pressed = new Set(s.pressed || []);
  const buttons = [];
  for (let i = 0; i < count; i++) buttons.push({ pressed: pressed.has(i), value: pressed.has(i) ? 1 : 0 });
  return {
    connected: true,
    index: s.index === undefined ? 0 : s.index,
    mapping: s.mapping === undefined ? 'standard' : s.mapping,
    axes: s.axes || [0, 0, 0, 0],
    buttons,
  };
}

/**
 * Build a touch-event-shaped object.
 * @param {string} type
 * @param {{id:number, x:number, y:number}[]} touches
 * @returns {any}
 */
export function touchEvent(type, touches) {
  const list = touches.map((t) => ({ identifier: t.id, clientX: t.x, clientY: t.y }));
  return { type, changedTouches: list, touches: list, cancelable: true };
}
