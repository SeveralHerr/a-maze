// @ts-check
/**
 * Unit tests for src/maze/client.js — run with `node src/maze/client.test.mjs`.
 *
 * The client's job is to make worker failure invisible, so every test here breaks the worker in a
 * different way and checks that a playable level still comes out. Real `Worker` instances do not
 * exist in Node, so the constructor is injected; the real browser path (module worker resolved via
 * `new URL('./worker.js', import.meta.url)`) is covered by `logs/maze-worker-check.mjs` and by
 * `tools/verify.mjs`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMazeClient } from './client.js';
import { buildLevel } from './level.js';
import { handleMazeRequest } from './worker.js';

const BIG = { cols: 30, rows: 30, braid: 0.2, gems: 6, oil: 2 };
const SMALL = { cols: 6, rows: 6, braid: 0, gems: 3, oil: 1 };

// client.js deliberately unrefs its worker-deadline timer, and the fakes below mirror that, so
// nothing in this file keeps the process alive on its own. That is fine in a browser and fine when
// node:test happens to keep the loop spinning between tests, but it is not guaranteed: on a slower
// or differently-scheduled runtime the event loop can decide it is done before an unref'd timer
// gets its turn, and every in-flight test is cancelled with "Promise resolution is still pending
// but the event loop has already resolved" (observed in CI on Node 22/Linux; not reproducible
// locally on Node 24/Windows). A single ref'd interval for the duration of this file removes the
// race without touching the production unref behaviour it is testing.
let keepalive;
before(() => {
  keepalive = setInterval(() => {}, 1 << 30);
});
after(() => {
  clearInterval(keepalive);
});

/**
 * A fake `Worker` that answers on a timer using the real worker-side handler.
 * @typedef {{delay?:number, silent?:boolean, crash?:boolean, garbage?:boolean, throwOnPost?:boolean,
 *   reportError?:{name:string, message:string}}} FakeBehaviour
 *
 * @param {FakeBehaviour} [behaviour]
 * @returns {{ctor:new (url:URL|string, o?:{type?:string}) => any,
 *   made:{count:number, terminated:number, url:string}, behaviour:FakeBehaviour}}
 */
function fakeWorker(behaviour) {
  const b = behaviour || {};
  const made = { count: 0, terminated: 0, url: '' };
  class FakeWorker {
    /**
     * @param {URL|string} url
     * @param {{type?:string}} [opts]
     */
    constructor(url, opts) {
      made.count++;
      made.url = String(url);
      assert.equal(opts?.type, 'module', 'the worker must be started as a module worker');
      /** @type {((ev:{data:unknown}) => void)|null} */
      this.onmessage = null;
      /** @type {((ev:unknown) => void)|null} */
      this.onerror = null;
      /** @type {((ev:unknown) => void)|null} */
      this.onmessageerror = null;
      this.alive = true;
    }
    /** @param {unknown} msg */
    postMessage(msg) {
      if (b.throwOnPost) throw new Error('not cloneable');
      if (b.silent) return;
      const t = setTimeout(() => {
        if (!this.alive) return;
        if (b.crash) {
          this.onerror?.({ message: 'worker blew up' });
          return;
        }
        if (b.reportError) {
          this.onmessage?.({ data: { id: /** @type {{id:number}} */ (msg).id, ...b.reportError, error: b.reportError.message } });
          return;
        }
        if (b.garbage) {
          this.onmessage?.({ data: { id: /** @type {{id:number}} */ (msg).id, data: { nope: true } } });
          return;
        }
        const res = handleMazeRequest(msg);
        if (res) this.onmessage?.({ data: res.message });
      }, b.delay ?? 0);
      const handle = /** @type {{unref?:() => void}} */ (/** @type {unknown} */ (t));
      if (typeof handle.unref === 'function') handle.unref();
    }
    terminate() {
      this.alive = false;
      made.terminated++;
    }
  }
  // `behaviour` is handed back so a test can change what the worker does mid-run (answer, then
  // go silent), which is how the "one hiccup is not a verdict" policy gets exercised.
  return { ctor: /** @type {never} */ (FakeWorker), made, behaviour: b };
}

test('small mazes are built synchronously, large ones go to the worker', async () => {
  const { ctor, made } = fakeWorker();
  const client = createMazeClient({ WorkerCtor: ctor });

  const small = await client.build(SMALL, 1);
  assert.equal(made.count, 0, 'a 36-cell maze must not pay for a worker round trip');
  assert.equal(small.maze.cols, 6);

  const big = await client.build(BIG, 1);
  assert.equal(made.count, 1);
  assert.match(made.url, /worker\.js$/, 'the worker URL must resolve next to client.js');
  assert.equal(big.maze.cols, 30);
  assert.equal(client.pending(), 0);
  client.dispose();
});

test('the worker result is identical to a synchronous build', async () => {
  const { ctor } = fakeWorker();
  const client = createMazeClient({ WorkerCtor: ctor });
  const viaWorker = await client.build(BIG, 555);
  const local = buildLevel(BIG, 555);
  assert.deepEqual(Array.from(viaWorker.maze.tiles), Array.from(local.maze.tiles));
  assert.deepEqual(viaWorker.items, local.items);
  assert.equal(viaWorker.fuel, local.fuel);
  client.dispose();
});

test('concurrent requests are matched to their own ids', async () => {
  const { ctor } = fakeWorker({ delay: 1 });
  const client = createMazeClient({ WorkerCtor: ctor });
  const pending = [10, 20, 30, 40].map((seed) => client.build(BIG, seed));
  assert.equal(client.pending(), 4);
  const results = await Promise.all(pending);
  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].maze.seed, [10, 20, 30, 40][i], 'answers were crossed');
  }
  assert.equal(client.pending(), 0);
  client.dispose();
});

test('a silent worker times out and the level is rebuilt synchronously', async () => {
  const { ctor, made } = fakeWorker({ silent: true });
  const client = createMazeClient({ WorkerCtor: ctor, timeoutMs: 30 });
  const t0 = Date.now();
  const data = await client.build(BIG, 3);
  assert.ok(Date.now() - t0 >= 25, 'the timeout must actually be waited out');
  assert.deepEqual(data.validation.errors, []);
  assert.equal(made.terminated, 1, 'a worker that went silent must be terminated');
  assert.equal(client.mode(), 'worker', 'one timeout is a hiccup, not a verdict');
  const next = await client.build(BIG, 4);
  assert.equal(made.count, 2, 'the next build gets a fresh worker');
  assert.deepEqual(next.validation.errors, []);
  assert.equal(client.mode(), 'sync', 'two failures in a row and the worker idea is dropped');
  const third = await client.build(BIG, 5);
  assert.equal(made.count, 2, 'no third worker after the client has given up');
  assert.deepEqual(third.validation.errors, []);
  client.dispose();
});

test('a worker that answers between two failures never gets written off', async () => {
  // A throttled background tab can blow one deadline and be fine on the next level; the client
  // must not spend the rest of the run on the main thread because of it.
  const { ctor, made, behaviour } = fakeWorker({ silent: true });
  const client = createMazeClient({ WorkerCtor: ctor, timeoutMs: 30 });
  await client.build(BIG, 21); // times out, worker #1 retired
  behaviour.silent = false;
  const good = await client.build(BIG, 22); // worker #2 answers
  assert.deepEqual(good.validation.errors, []);
  assert.equal(made.count, 2);
  behaviour.silent = true;
  await client.build(BIG, 23); // times out, worker #2 retired — but the streak was reset
  assert.equal(client.mode(), 'worker', 'a good answer clears the failure streak');
  assert.equal(made.terminated, 2);
  client.dispose();
});

test('maxFailures is configurable, and one is enough to latch when asked', async () => {
  const { ctor } = fakeWorker({ crash: true });
  const client = createMazeClient({ WorkerCtor: ctor, maxFailures: 1 });
  await client.build(BIG, 31);
  assert.equal(client.mode(), 'sync');
  client.dispose();
});

test('a crashing worker falls back without losing the in-flight request', async () => {
  const { ctor, made } = fakeWorker({ crash: true });
  const client = createMazeClient({ WorkerCtor: ctor });
  const data = await client.build(BIG, 6);
  assert.deepEqual(data.validation.errors, []);
  assert.equal(made.terminated, 1);
  assert.equal(client.mode(), 'worker');
  const again = await client.build(BIG, 7);
  assert.deepEqual(again.validation.errors, []);
  assert.equal(client.mode(), 'sync', 'two crashes in a row retire the worker for good');
  client.dispose();
});

test('a reported build failure rejects with the same error class, without rebuilding it here', async () => {
  // Rebuilding a deterministic failure costs up to ~230 ms at the cap purely to throw the same
  // error again, so the client rebuilds the *error*, not the level. The proof: the worker reports
  // a failure for parameters that build perfectly well — if the client rebuilt, this would resolve.
  const reportError = { name: 'RangeError', message: 'generateMaze: cols must be 1..4096, got -1' };
  const deterministic = fakeWorker({ reportError });
  const client = createMazeClient({ WorkerCtor: deterministic.ctor, mode: 'always' });
  await assert.rejects(() => client.build(BIG, 41), (err) => {
    assert.ok(err instanceof RangeError, `expected a RangeError, got ${String(err)}`);
    assert.match(err.message, /cols must be 1\.\.4096/);
    return true;
  });
  assert.equal(client.mode(), 'worker', 'a reported bad level is not a broken worker');
  client.dispose();

  // An error that might have been the worker's own fault is still rebuilt here, and succeeds.
  const flaky = fakeWorker({ reportError: { name: 'Error', message: 'out of memory' } });
  const second = createMazeClient({ WorkerCtor: flaky.ctor, mode: 'always' });
  const data = await second.build(BIG, 42);
  assert.deepEqual(data.validation.errors, []);
  second.dispose();
});

test('a malformed worker answer is treated as a failure, not as a level', async () => {
  const { ctor } = fakeWorker({ garbage: true });
  const client = createMazeClient({ WorkerCtor: ctor });
  const data = await client.build(BIG, 8);
  assert.ok(data.maze.tiles.length > 0, 'a real level came back instead of the garbage');
  assert.deepEqual(data.validation.errors, []);
  client.dispose();
});

test('a worker that cannot be constructed degrades to synchronous generation', async () => {
  class Broken {
    constructor() {
      throw new Error('SecurityError: worker blocked');
    }
  }
  const client = createMazeClient({ WorkerCtor: /** @type {never} */ (Broken) });
  const data = await client.build(BIG, 9);
  assert.deepEqual(data.validation.errors, []);
  assert.equal(client.mode(), 'sync');
  client.dispose();
});

test('an uncloneable request falls back instead of throwing out of postMessage', async () => {
  const { ctor } = fakeWorker({ throwOnPost: true });
  const client = createMazeClient({ WorkerCtor: ctor });
  const data = await client.build(BIG, 11);
  assert.deepEqual(data.validation.errors, []);
  assert.equal(client.pending(), 0);
  client.dispose();
});

test('with no Worker in the environment everything is built synchronously', async () => {
  const client = createMazeClient({ WorkerCtor: undefined });
  assert.equal(client.mode(), 'sync');
  const data = await client.build(BIG, 12);
  assert.equal(data.maze.cols, 30);
  client.dispose();
});

test('mode:"always" and mode:"never" override the size threshold', async () => {
  const forced = fakeWorker();
  const always = createMazeClient({ WorkerCtor: forced.ctor, mode: 'always' });
  await always.build(SMALL, 1);
  assert.equal(forced.made.count, 1, 'mode:"always" must use the worker even for a tiny maze');
  always.dispose();

  const off = fakeWorker();
  const never = createMazeClient({ WorkerCtor: off.ctor, mode: 'never' });
  await never.build(BIG, 1);
  assert.equal(off.made.count, 0, 'mode:"never" must not spawn a worker');
  assert.equal(never.mode(), 'sync');
  never.dispose();
});

test('a genuine build failure rejects with a real Error rather than hanging', async () => {
  const { ctor } = fakeWorker();
  const client = createMazeClient({ WorkerCtor: ctor, mode: 'always' });
  await assert.rejects(() => client.build({ cols: -1, rows: 5 }, 1), RangeError);
  assert.equal(client.pending(), 0);
  client.dispose();
});

test('dispose terminates the worker, settles everything in flight, and stays idempotent', async () => {
  const { ctor, made } = fakeWorker({ silent: true });
  const client = createMazeClient({ WorkerCtor: ctor, timeoutMs: 5000 });
  const inflight = client.build(BIG, 13);
  assert.equal(client.pending(), 1);
  client.dispose();
  await assert.rejects(() => inflight, /disposed/);
  assert.equal(made.terminated, 1);
  assert.equal(client.pending(), 0);
  assert.equal(client.mode(), 'disposed');
  client.dispose(); // idempotent
  assert.equal(made.terminated, 1);
  await assert.rejects(() => client.build(SMALL, 1), /after dispose/);
});

test('build never throws synchronously, whatever it is handed', () => {
  const client = createMazeClient();
  for (const bad of [null, undefined, {}, { cols: 'x', rows: 'y' }, 7]) {
    const p = client.build(/** @type {never} */ (bad), 1);
    assert.ok(p instanceof Promise);
    p.catch(() => {}); // the rejection is the point; swallow it here
  }
  client.dispose();
});
