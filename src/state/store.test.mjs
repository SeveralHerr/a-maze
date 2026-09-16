// @ts-check
/**
 * @file Unit tests for src/state/store.js — dispatch ordering, re-entrancy, subscriber semantics
 * and the "a thrown error never takes the game down" guarantee.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from './store.js';
import { createInitialState, reducer } from './game.js';

test('createStore: rejects a missing state or reducer up front', () => {
  assert.throws(() => createStore(/** @type {any} */ (null), () => {}), TypeError);
  assert.throws(() => createStore(/** @type {any} */ (7), () => {}), TypeError);
  assert.throws(() => createStore({}, /** @type {any} */ (undefined)), TypeError);
  assert.throws(() => createStore({}, /** @type {any} */ ('reduce')), TypeError);
});

test('getState: returns the same live object the reducer mutates', () => {
  const state = { n: 0 };
  const store = createStore(state, (s, a) => {
    if (a.type === 'inc') s.n++;
  });
  assert.equal(store.getState(), state);
  store.dispatch({ type: 'inc' });
  assert.equal(store.getState().n, 1);
  assert.equal(store.getState(), state, 'the identity never changes');
});

test('dispatch: ignores anything that is not an action object', () => {
  let calls = 0;
  const store = createStore({}, () => {
    calls++;
  });
  for (const bad of [null, undefined, 0, '', 'tick', [], {}, { type: 1 }, { type: null }]) {
    store.dispatch(/** @type {any} */ (bad));
  }
  assert.equal(calls, 0, 'the reducer was never invoked');
});

test('subscribe: called after the reducer, with the state and the action', () => {
  const store = createStore({ n: 0 }, (s, a) => {
    if (a.type === 'inc') s.n++;
  });
  /** @type {Array<[number, string]>} */
  const seen = [];
  store.subscribe((s, a) => seen.push([/** @type {any} */ (s).n, a.type]));
  store.dispatch({ type: 'inc' });
  store.dispatch({ type: 'noop' });
  assert.deepEqual(seen, [
    [1, 'inc'],
    [1, 'noop'],
  ]);
});

test('subscribe: unsubscribe is idempotent and stops delivery', () => {
  const store = createStore({}, () => {});
  let n = 0;
  const off = store.subscribe(() => n++);
  store.dispatch({ type: 'a' });
  off();
  off();
  off();
  store.dispatch({ type: 'b' });
  assert.equal(n, 1);
  assert.throws(() => store.subscribe(/** @type {any} */ (null)), TypeError);
});

test('subscribe: a listener added during a dispatch runs from the next one', () => {
  const store = createStore({}, () => {});
  /** @type {string[]} */
  const log = [];
  store.subscribe(() => {
    log.push('first');
    store.subscribe(() => log.push('late'));
  });
  store.dispatch({ type: 'a' });
  assert.deepEqual(log, ['first']);
  log.length = 0;
  store.dispatch({ type: 'b' });
  assert.equal(log.indexOf('late') >= 0, true);
});

test('subscribe: a listener removed during a dispatch is not called in that dispatch', () => {
  const store = createStore({}, () => {});
  /** @type {string[]} */
  const log = [];
  /** @type {(() => void)|null} */
  let offB = null;
  store.subscribe(() => {
    log.push('a');
    if (offB) offB();
  });
  offB = store.subscribe(() => log.push('b'));
  store.subscribe(() => log.push('c'));
  store.dispatch({ type: 'x' });
  assert.deepEqual(log, ['a', 'c']);
  log.length = 0;
  store.dispatch({ type: 'y' });
  assert.deepEqual(log, ['a', 'c']);
});

test('dispatch: re-entrant dispatches are queued, never nested', () => {
  /** @type {string[]} */
  const order = [];
  const store = createStore({ depth: 0 }, (s, a) => {
    order.push(`reduce:${a.type}`);
    assert.equal(/** @type {any} */ (s).depth, 0, 'the reducer is never re-entered');
    if (a.type === 'outer') {
      /** @type {any} */ (s).depth = 1;
      store.dispatch({ type: 'inner1' });
      store.dispatch({ type: 'inner2' });
      /** @type {any} */ (s).depth = 0;
    }
  });
  store.subscribe((_s, a) => order.push(`notify:${a.type}`));
  store.dispatch({ type: 'outer' });
  assert.deepEqual(order, [
    'reduce:outer',
    'notify:outer',
    'reduce:inner1',
    'notify:inner1',
    'reduce:inner2',
    'notify:inner2',
  ]);
});

test('dispatch: a subscriber may dispatch, and it runs after the current action completes', () => {
  /** @type {string[]} */
  const order = [];
  const store = createStore({}, (_s, a) => order.push(`r:${a.type}`));
  let once = true;
  store.subscribe((_s, a) => {
    order.push(`n:${a.type}`);
    if (once) {
      once = false;
      store.dispatch({ type: 'echo' });
    }
  });
  store.dispatch({ type: 'go' });
  assert.deepEqual(order, ['r:go', 'n:go', 'r:echo', 'n:echo']);
});

test('dispatch: a runaway dispatch loop is cut off instead of hanging the frame', () => {
  const store = createStore({ n: 0 }, (s) => {
    /** @type {any} */ (s).n++;
    store.dispatch({ type: 'again' });
  });
  store.dispatch({ type: 'start' });
  const n = store.getState().n;
  assert.ok(n > 1 && n < 10000, `the loop was bounded (${n} actions)`);
  // The store is still usable afterwards.
  store.dispatch({ type: 'x' });
  assert.ok(store.getState().n > n);
});

test('dispatch: a throwing reducer does not break the store or the subscribers', () => {
  let notified = 0;
  const store = createStore({ n: 0 }, (s, a) => {
    /** @type {any} */ (s).n++;
    if (a.type === 'boom') throw new Error('reducer exploded');
  });
  store.subscribe(() => notified++);
  assert.doesNotThrow(() => store.dispatch({ type: 'boom' }));
  assert.equal(notified, 1, 'subscribers still ran');
  store.dispatch({ type: 'ok' });
  assert.equal(store.getState().n, 2);
  assert.equal(notified, 2);
});

test('dispatch: one throwing subscriber does not stop the others', () => {
  const store = createStore({}, () => {});
  /** @type {string[]} */
  const log = [];
  store.subscribe(() => {
    log.push('a');
    throw new Error('listener exploded');
  });
  store.subscribe(() => log.push('b'));
  assert.doesNotThrow(() => store.dispatch({ type: 'x' }));
  assert.deepEqual(log, ['a', 'b']);
});

test('store + game reducer: the real wiring survives a scripted session', () => {
  const store = createStore(createInitialState(), reducer);
  /** @type {string[]} */
  const phases = [];
  store.subscribe((s) => {
    const st = /** @type {import('../core/types.js').GameState} */ (s);
    for (const e of st.events) if (e.type === 'phase') phases.push(e.to);
  });

  store.dispatch({ type: 'newGame', seed: 11 });
  store.dispatch({
    type: 'levelReady',
    data: {
      maze: {
        width: 5,
        height: 3,
        cols: 2,
        rows: 1,
        tiles: Uint8Array.from([1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1]),
        start: { x: 1, y: 1 },
        exit: { x: 3, y: 1 },
        seed: 11,
      },
      validation: /** @type {any} */ ({ errors: [] }),
      items: [],
      torches: [],
      fuel: 30,
      par: 15,
    },
  });
  for (let i = 0; i < 300; i++) {
    store.dispatch({
      type: 'tick',
      dt: 1 / 60,
      input: /** @type {any} */ ({ moveX: 0, moveY: 1, turn: 0, lookDX: 0, sprint: false, pressed: new Set() }),
    });
  }
  assert.deepEqual(phases, ['loading', 'playing', 'levelComplete']);
  assert.equal(store.getState().phase, 'levelComplete');
});
