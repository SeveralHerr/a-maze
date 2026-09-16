// @ts-check
/**
 * Unit tests for src/ui/audio.js.
 *
 * Everything runs against a **minimal fake AudioContext** that records node creation, connections
 * and every AudioParam operation, so the tests can assert routing, envelopes, voice limiting and
 * node lifetime without a browser (and without making a sound).
 *
 * Run: `node src/ui/audio.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudio, AUDIO } from './audio.js';

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Fake WebAudio
// ══════════════════════════════════════════════════════════════════════════════════════════════

class FakeParam {
  /** @param {FakeCtx} ctx @param {FakeNode} node @param {string} name @param {number} value */
  constructor(ctx, node, name, value) {
    this.ctx = ctx;
    this.node = node;
    this.name = name;
    this.value = value;
  }
  /** @param {string} method @param {number} v @param {number} t */
  _op(method, v, t) {
    this.value = v;
    this.ctx.ops.push({ node: this.node, param: this.name, method, value: v, time: t });
  }
  setValueAtTime(v, t) {
    this._op('set', v, t);
  }
  linearRampToValueAtTime(v, t) {
    this._op('lin', v, t);
  }
  exponentialRampToValueAtTime(v, t) {
    assert.ok(v > 0, 'exponential ramps must never target 0');
    this._op('exp', v, t);
  }
  setTargetAtTime(v, t, tc) {
    assert.ok(tc > 0, 'setTargetAtTime needs a positive time constant');
    this._op('target', v, t);
  }
  cancelScheduledValues(t) {
    this._op('cancel', this.value, t);
  }
}

let nodeSeq = 0;

class FakeNode {
  /** @param {FakeCtx} ctx @param {string} kind */
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.id = ++nodeSeq;
    this.type = '';
    this.buffer = null;
    this.loop = false;
    this.onended = null;
    this.started = -1;
    this.stopped = Infinity;
    this.disconnects = 0;
    this.endedFired = 0;
    ctx.nodes.push(this);
  }
  /** @param {string} name @param {number} value */
  _param(name, value) {
    const p = new FakeParam(this.ctx, this, name, value);
    this[name] = p;
    return p;
  }
  connect(dst) {
    assert.ok(dst, 'connect(undefined) is a routing bug');
    this.ctx.connections.push([this, dst]);
    return dst;
  }
  disconnect() {
    this.disconnects++;
  }
}

class FakeSource extends FakeNode {
  start(t, offset) {
    assert.equal(this.started, -1, 'a source may only be started once');
    this.started = t === undefined ? this.ctx.currentTime : t;
    this.offset = offset;
  }
  stop(t) {
    this.stopped = Math.min(this.stopped, t === undefined ? this.ctx.currentTime : t);
  }
}

class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._data = new Float32Array(length);
  }
  getChannelData() {
    return this._data;
  }
}

class FakeCtx {
  constructor(opts = {}) {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = opts.state || 'suspended';
    /** @type {FakeNode[]} */
    this.nodes = [];
    this.destination = new FakeNode(this, 'destination');
    /** @type {Array<[FakeNode, any]>} */
    this.connections = [];
    /** @type {Array<{node:FakeNode, param:string, method:string, value:number, time:number}>} */
    this.ops = [];
    this.buffers = 0;
    this.resumes = 0;
    this.suspends = 0;
    this.closes = 0;
  }
  createGain() {
    const n = new FakeNode(this, 'gain');
    n._param('gain', 1);
    return n;
  }
  createBiquadFilter() {
    const n = new FakeNode(this, 'filter');
    n._param('frequency', 350);
    n._param('Q', 1);
    n._param('detune', 0);
    return n;
  }
  createDelay() {
    const n = new FakeNode(this, 'delay');
    n._param('delayTime', 0);
    return n;
  }
  createDynamicsCompressor() {
    const n = new FakeNode(this, 'compressor');
    n._param('threshold', -24);
    n._param('knee', 30);
    n._param('ratio', 12);
    n._param('attack', 0.003);
    n._param('release', 0.25);
    return n;
  }
  createOscillator() {
    const n = new FakeSource(this, 'osc');
    n._param('frequency', 440);
    n._param('detune', 0);
    return n;
  }
  createBufferSource() {
    const n = new FakeSource(this, 'bufferSource');
    n._param('playbackRate', 1);
    return n;
  }
  createStereoPanner() {
    const n = new FakeNode(this, 'panner');
    n._param('pan', 0);
    return n;
  }
  createWaveShaper() {
    const n = new FakeNode(this, 'waveshaper');
    n.curve = null;
    n.oversample = 'none';
    return n;
  }
  createBuffer(channels, length, sampleRate) {
    this.buffers++;
    return new FakeBuffer(channels, length, sampleRate);
  }
  resume() {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.suspends++;
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.closes++;
    this.state = 'closed';
    return Promise.resolve();
  }

  // ── test helpers ────────────────────────────────────────────────────────────────────────────

  /** Advance the clock and fire `onended` for every source whose stop time has passed. */
  advance(dt) {
    this.currentTime += dt;
    for (const n of this.nodes) {
      if (n instanceof FakeSource && n.started >= 0 && n.stopped <= this.currentTime) {
        if (n.onended && n.endedFired === 0) {
          n.endedFired++;
          const cb = n.onended;
          cb.call(n);
        }
      }
    }
  }

  /** @param {string} kind @returns {FakeNode[]} */
  of(kind) {
    return this.nodes.filter((n) => n.kind === kind);
  }

  /** True when `node` reaches `this.destination` through the connection graph. */
  reaches(node, target = this.destination) {
    const seen = new Set();
    const stack = [node];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const [a, b] of this.connections) {
        if (a === cur && b instanceof FakeNode) stack.push(b);
      }
    }
    return false;
  }

  /** True when `node` eventually modulates an AudioParam (an LFO rather than an audible voice). */
  modulates(node) {
    const seen = new Set();
    const stack = [node];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const [a, b] of this.connections) {
        if (a !== cur) continue;
        if (b instanceof FakeParam) return true;
        stack.push(b);
      }
    }
    return false;
  }

  /** Every op recorded after index `from`. */
  opsSince(from) {
    return this.ops.slice(from);
  }
}

/**
 * Pick the fixed mixer nodes out of the recorded graph.
 * The two buses are told apart by creation order — audio.js builds sfx before music.
 */
function graphOf(ctx) {
  const comp = ctx.of('compressor')[0];
  const master = ctx.connections.find(([, b]) => b === comp)[0];
  const buses = ctx.connections
    .filter(([, b]) => b === master)
    .map(([a]) => a)
    .sort((x, y) => x.id - y.id);
  // The portal hum reaches the sfx bus through its stereo panner; the torch bed is then the only
  // remaining gain feeding that bus (the reverb return arrives from a filter, not a gain).
  const panner = ctx.of('panner')[0];
  const portalGain = ctx.connections.find(([, b]) => b === panner)[0];
  const torchGain = ctx.connections.filter(([a, b]) => b === buses[0] && a.kind === 'gain')[0][0];
  const droneGain = ctx.connections.filter(([a, b]) => b === buses[1] && a.kind === 'gain')[0][0];
  return {
    comp,
    master,
    sfxBus: buses[0],
    musicBus: buses[1],
    panner,
    portalGain,
    torchGain,
    droneGain,
  };
}

/** Build an audio engine on a fresh fake context. */
function makeAudio(overrides = {}) {
  const ctx = new FakeCtx();
  const audio = createAudio({
    contextFactory: () => ctx,
    doc: null,
    seed: 1234,
    volume: 1,
    music: 0.6,
    ...overrides,
  });
  return { ctx, audio };
}

/** A GameState-shaped object good enough for audio. */
function makeState(over = {}) {
  return {
    phase: 'playing',
    time: 0,
    phaseTime: 0,
    level: 1,
    seed: 1,
    levelData: null,
    player: { x: 1.5, y: 1.5, angle: 0, px: 0, py: 0, pangle: 0, vx: 0, vy: 0, bob: 0, bobAmp: 0, shake: 0 },
    explored: null,
    run: {
      score: 0,
      gems: 0,
      gemsTotal: 5,
      fuel: 60,
      fuelMax: 100,
      levelTime: 0,
      totalTime: 0,
      levelScore: 0,
      bestCombo: 0,
    },
    best: { score: 0, level: 0 },
    settings: {
      volume: 1,
      music: 0.6,
      sensitivity: 1,
      scanlines: true,
      minimap: true,
      reducedMotion: false,
      invertLook: false,
    },
    derived: { exitDist: 20, nearExit: 0, lowFuel: false },
    events: [],
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Graceful degradation
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('no WebAudio at all: every method is a silent no-op and nothing throws', () => {
  const audio = createAudio({ contextFactory: () => null, doc: null });
  assert.equal(audio.unlock(), false);
  assert.equal(audio.unlocked, false);
  assert.equal(audio.available, false);
  audio.handle([{ type: 'footstep', foot: 0 }], makeState());
  audio.update(makeState());
  audio.setVolume(0.5, 0.5);
  audio.playUi('confirm');
  audio.suspend();
  audio.resume();
  audio.dispose();
  audio.dispose();
  assert.equal(audio.stats().voices, 0);
  assert.equal(audio.stats().state, 'failed');
});

test('createAudio with no options at all is safe in Node (no AudioContext global)', () => {
  const audio = createAudio();
  assert.doesNotThrow(() => {
    audio.unlock();
    audio.update(makeState());
    audio.handle([{ type: 'levelStart', level: 1 }], makeState());
    audio.dispose();
  });
});

test('a throwing context factory is swallowed', () => {
  const audio = createAudio({
    contextFactory: () => {
      throw new Error('blocked by policy');
    },
    doc: null,
  });
  assert.equal(audio.unlock(), false);
  assert.doesNotThrow(() => audio.handle([{ type: 'bump', strength: 1 }], makeState()));
  assert.equal(audio.available, false);
});

test('a factory returning a garbage object degrades instead of throwing', () => {
  const audio = createAudio({ contextFactory: () => /** @type {any} */ ({}), doc: null });
  assert.equal(audio.unlock(), false);
  assert.equal(audio.available, false);
});

test('a context that throws while building the graph degrades to silence', () => {
  const ctx = new FakeCtx();
  ctx.createDynamicsCompressor = () => {
    throw new Error('nope');
  };
  const audio = createAudio({ contextFactory: () => ctx, doc: null });
  assert.equal(audio.unlock(), false);
  assert.equal(audio.available, false);
  assert.doesNotThrow(() => audio.update(makeState()));
});

test('garbage arguments never throw', () => {
  const { audio } = makeAudio();
  audio.unlock();
  assert.doesNotThrow(() => {
    audio.handle(null, null);
    audio.handle(undefined, undefined);
    audio.handle(/** @type {any} */ ('nope'), makeState());
    audio.handle([null, undefined, {}, { type: 'unknownEvent' }], null);
    audio.update(null);
    audio.update(/** @type {any} */ (42));
    audio.setVolume(NaN, NaN);
    audio.setVolume(/** @type {any} */ ('loud'));
    audio.playUi(/** @type {any} */ ('weird'));
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Routing
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('unlock builds master -> compressor -> destination with sfx and music buses', () => {
  const { ctx, audio } = makeAudio();
  assert.equal(audio.unlock(), true);
  assert.equal(audio.unlocked, true);
  assert.equal(ctx.resumes, 1);

  const comp = ctx.of('compressor');
  assert.equal(comp.length, 1, 'exactly one master compressor');
  assert.ok(ctx.reaches(comp[0]), 'the compressor reaches the destination');

  // …through the soft-clip limiter, whose curve must be monotonic, odd and inside [-1, 1].
  const ws = ctx.of('waveshaper');
  assert.equal(ws.length, 1, 'exactly one limiter');
  assert.ok(
    ctx.connections.some(([a, b]) => a === comp[0] && b === ws[0]),
    'compressor -> limiter',
  );
  assert.ok(
    ctx.connections.some(([a, b]) => a === ws[0] && b === ctx.destination),
    'limiter -> destination',
  );
  const curve = ws[0].curve;
  assert.ok(curve instanceof Float32Array && curve.length > 64);
  assert.ok(Math.abs(curve[(curve.length - 1) / 2]) < 1e-9, 'the curve passes through the origin');
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i] >= curve[i - 1], 'the transfer curve must be monotonic');
    assert.ok(Math.abs(curve[i]) < 1, 'the transfer curve can never output a clipped sample');
  }
  // The only thing allowed into the compressor is the master gain.
  const intoComp = ctx.connections.filter(([, b]) => b === comp[0]).map(([a]) => a);
  assert.equal(intoComp.length, 1);
  const master = intoComp[0];
  assert.equal(master.kind, 'gain');

  // Two independent buses land on the master.
  const intoMaster = ctx.connections.filter(([, b]) => b === master).map(([a]) => a);
  assert.ok(intoMaster.length >= 2, 'sfx and music buses both reach the master');
  for (const bus of intoMaster) assert.equal(bus.kind, 'gain');
});

test('unlock is idempotent: one context, one graph, one noise buffer', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const nodesAfterFirst = ctx.nodes.length;
  audio.unlock();
  audio.unlock();
  assert.equal(ctx.nodes.length, nodesAfterFirst, 'no second graph');
  assert.equal(ctx.buffers, 1, 'the noise buffer is created exactly once');
});

test('the noise buffer is shared by every noise voice', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();
  for (let i = 0; i < 6; i++) {
    audio.handle([{ type: 'bump', strength: 1 }], state);
    ctx.advance(0.5);
    audio.update(state);
  }
  assert.equal(ctx.buffers, 1, 'noise buffers are created once, never per voice');
  const sources = ctx.of('bufferSource');
  assert.ok(sources.length >= 6);
  const first = sources[0].buffer;
  for (const s of sources) assert.equal(s.buffer, first, 'all sources share one buffer');
});

test('every cue voice reaches the destination', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();
  audio.handle(
    [
      { type: 'footstep', foot: 0 },
      { type: 'pickup', kind: 'gem', x: 1, y: 1, value: 100 },
      { type: 'pickup', kind: 'oil', x: 1, y: 1, value: 12 },
      { type: 'levelStart', level: 1 },
    ],
    state,
  );
  const sources = ctx.nodes.filter((n) => n instanceof FakeSource && n.started >= 0);
  assert.ok(sources.length > 6);
  for (const s of sources) {
    // Every started source is either audible (reaches the destination) or an LFO (modulates a param).
    assert.ok(
      ctx.reaches(s) || ctx.modulates(s),
      `source ${s.kind}#${s.id} is connected to nothing`,
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Voice limiting & lifetime
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('voice count never exceeds the cap under an event flood', () => {
  const { ctx, audio } = makeAudio({ maxVoices: 8 });
  audio.unlock();
  const state = makeState();
  const flood = [];
  for (let i = 0; i < 40; i++) flood.push({ type: 'bump', strength: 1 });
  audio.handle(flood, state);
  const s = audio.stats();
  assert.ok(s.voices <= 8, `voices ${s.voices} exceeded the cap`);
  assert.ok(s.stolen + s.dropped > 0, 'the limiter actually engaged');
});

test('stolen voices are disconnected, so nodes never leak', () => {
  const { ctx, audio } = makeAudio({ maxVoices: 6 });
  audio.unlock();
  const state = makeState();
  for (let i = 0; i < 60; i++) audio.handle([{ type: 'bump', strength: 1 }], state);
  // Every node created for a voice that is no longer live must have been disconnected.
  const live = audio.stats().voices;
  const voiceNodes = ctx.nodes.filter((n) => n.kind === 'osc' || n.kind === 'bufferSource');
  const disconnected = voiceNodes.filter((n) => n.disconnects > 0).length;
  assert.ok(
    disconnected >= voiceNodes.length - live * 4,
    `only ${disconnected}/${voiceNodes.length} voice nodes were disconnected`,
  );
});

test('voices release on ended and the pool returns to empty', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();
  audio.handle([{ type: 'pickup', kind: 'gem', x: 1, y: 1, value: 100 }], state);
  assert.ok(audio.stats().voices > 0);
  ctx.advance(3); // fires onended for every finished source
  assert.equal(audio.stats().voices, 0, 'onended released every voice');
  for (const n of ctx.nodes) {
    if (n instanceof FakeSource && n.started >= 0 && n.stopped < Infinity) {
      assert.ok(n.disconnects > 0, `node ${n.kind}#${n.id} stayed connected`);
    }
  }
});

test('the per-frame reap releases voices even when onended never fires', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  // A title-screen state so update() itself schedules no torch crackle while we count.
  const state = makeState({ phase: 'title' });
  // Strip onended after scheduling: this is what a suspended context looks like.
  audio.handle([{ type: 'bump', strength: 1 }], state);
  for (const n of ctx.nodes) n.onended = null;
  assert.ok(audio.stats().voices > 0);
  ctx.currentTime += 5;
  audio.update(state);
  assert.equal(audio.stats().voices, 0, 'reap() cleaned up the orphaned voices');
});

test('dispose stops and disconnects everything and is idempotent', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  audio.handle([{ type: 'levelStart', level: 3 }], makeState());
  audio.dispose();
  audio.dispose();
  assert.equal(audio.stats().voices, 0);
  assert.equal(audio.available, false);
  assert.equal(ctx.closes, 1);
  assert.doesNotThrow(() => audio.update(makeState()));
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Cue behaviour
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** Peak amplitude ramped onto any gain node in the given op slice. */
function peakGain(ops) {
  let peak = 0;
  for (const op of ops) {
    if (op.param === 'gain' && (op.method === 'lin' || op.method === 'set')) {
      if (op.value > peak) peak = op.value;
    }
  }
  return peak;
}

/** All filter cutoffs scheduled in the given op slice. */
function filterFreqs(ops) {
  return ops.filter((o) => o.param === 'frequency' && o.node.kind === 'filter').map((o) => o.value);
}

test('footsteps alternate pitch per foot and are louder when sprinting', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const walking = makeState({ player: { ...makeState().player, vx: 2.4, vy: 0 } });
  const sprinting = makeState({ player: { ...makeState().player, vx: 5.1, vy: 0 } });

  const m0 = ctx.ops.length;
  audio.handle([{ type: 'footstep', foot: 0 }], walking);
  const left = ctx.opsSince(m0);
  ctx.advance(0.5);

  const m1 = ctx.ops.length;
  audio.handle([{ type: 'footstep', foot: 1 }], walking);
  const right = ctx.opsSince(m1);
  ctx.advance(0.5);

  const m2 = ctx.ops.length;
  audio.handle([{ type: 'footstep', foot: 0 }], sprinting);
  const sprint = ctx.opsSince(m2);

  const leftF = filterFreqs(left)[0];
  const rightF = filterFreqs(right)[0];
  assert.ok(leftF > 0 && rightF > 0, 'both feet filter the noise burst');
  assert.ok(leftF > rightF, 'the two feet have distinct centre frequencies');

  assert.ok(
    peakGain(sprint) > peakGain(left) * 1.2,
    `sprint step (${peakGain(sprint)}) should be clearly louder than a walk step (${peakGain(left)})`,
  );
  assert.ok(peakGain(left) <= AUDIO.STEP_GAIN.max + 1e-6);
});

test('rapid gem pickups raise the arpeggio pitch (combo), a slow one resets it', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();

  /** @returns {number} the fundamental of the first note of the arpeggio */
  function pickup() {
    const mark = ctx.ops.length;
    audio.handle([{ type: 'pickup', kind: 'gem', x: 1, y: 1, value: 100 }], state);
    const freqs = ctx
      .opsSince(mark)
      .filter((o) => o.param === 'frequency' && o.node.kind === 'osc')
      .map((o) => o.value);
    return freqs[0];
  }

  const f0 = pickup();
  ctx.advance(0.2);
  const f1 = pickup();
  ctx.advance(0.2);
  const f2 = pickup();
  assert.ok(f1 > f0 * 1.05, 'second quick gem is higher');
  assert.ok(f2 > f1 * 1.05, 'third quick gem is higher again');

  ctx.advance(AUDIO.COMBO_WINDOW + 0.5);
  const f3 = pickup();
  assert.ok(Math.abs(f3 - f0) < 1e-6, 'the combo lapses back to the base pitch');
});

test('bump strength scales the thud', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();
  const m0 = ctx.ops.length;
  audio.handle([{ type: 'bump', strength: 0.05 }], state);
  const soft = peakGain(ctx.opsSince(m0));
  ctx.advance(1);
  const m1 = ctx.ops.length;
  audio.handle([{ type: 'bump', strength: 1 }], state);
  const hard = peakGain(ctx.opsSince(m1));
  assert.ok(hard > soft * 2, `hard bump ${hard} should dwarf a graze ${soft}`);
});

test('level start, fanfare and game over each schedule several voices', () => {
  for (const ev of [
    { type: 'levelStart', level: 2 },
    { type: 'levelComplete', level: 2, bonus: 1200 },
    { type: 'gameOver', score: 999, newBest: true },
  ]) {
    const { ctx, audio } = makeAudio();
    audio.unlock();
    const before = ctx.nodes.length;
    audio.handle([ev], makeState());
    assert.ok(ctx.nodes.length - before >= 6, `${ev.type} produced too little sound`);
    assert.ok(audio.stats().voices >= 3, `${ev.type} should use several voices`);
  }
});

test('UI blips play through handle() and through playUi()', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const a = ctx.nodes.length;
  audio.handle([{ type: 'uiMove' }, { type: 'uiConfirm' }], makeState({ phase: 'title' }));
  assert.ok(ctx.nodes.length > a);
  const b = ctx.nodes.length;
  audio.playUi('back');
  assert.ok(ctx.nodes.length > b);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Continuous cues
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('portal hum opens with derived.nearExit and closes again', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();

  const { portalGain } = graphOf(ctx);
  const hum = (from) =>
    ctx.opsSince(from).filter((o) => o.node === portalGain && o.method === 'target');

  const far = ctx.ops.length;
  audio.update(state);
  assert.ok(
    hum(far).every((o) => o.value < 0.02),
    'the hum is silent far from the exit',
  );

  state.derived.nearExit = 1;
  ctx.advance(0.016);
  const mark = ctx.ops.length;
  audio.update(state);
  const gains = hum(mark).map((o) => o.value);
  const cutoffs = ctx
    .opsSince(mark)
    .filter((o) => o.method === 'target' && o.param === 'frequency')
    .map((o) => o.value);
  assert.ok(Math.max(...gains) > 0.05, 'the hum gets loud on the portal');
  assert.ok(Math.max(...cutoffs) > AUDIO.PORTAL.cutMax * 0.9, 'the filter opens up');

  state.derived.nearExit = 0;
  ctx.advance(0.016);
  const closing = ctx.ops.length;
  audio.update(state);
  assert.ok(
    hum(closing).some((o) => o.value === 0),
    'walking away closes the hum',
  );
});

test('the portal hum pans toward the exit so it can be navigated by ear', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const { panner } = graphOf(ctx);
  // A 3x3 stub level: the exit sits east of the player at (5.5, 1.5).
  const level = {
    maze: { width: 3, height: 3, cols: 1, rows: 1, tiles: new Uint8Array(9), start: { x: 1, y: 1 }, exit: { x: 5, y: 1 }, seed: 1 },
    validation: null,
    items: [],
    torches: [],
    fuel: 60,
    par: 30,
  };
  const state = makeState({ levelData: level, derived: { exitDist: 4, nearExit: 0.9, lowFuel: false } });
  state.player.x = 1.5;
  state.player.y = 1.5;

  /** @returns {number} the pan value written this frame */
  function panFor(angle) {
    state.player.angle = angle;
    const mark = ctx.ops.length;
    audio.update(state);
    ctx.advance(0.05);
    const ops = ctx.opsSince(mark).filter((o) => o.node === panner);
    return ops.length ? ops[ops.length - 1].value : 0;
  }

  // Facing north (-π/2): the exit is due east, i.e. hard right.
  assert.ok(panFor(-Math.PI / 2) > 0.5, 'exit on the right pans right');
  // Facing south (+π/2): the same exit is now to the left.
  assert.ok(panFor(Math.PI / 2) < -0.5, 'exit on the left pans left');
  // Facing it head on: centred.
  assert.ok(Math.abs(panFor(0)) < 0.2, 'exit dead ahead stays centred');
});

test('the torch crackles only while playing, and thins out as the fuel runs down', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const { torchGain } = graphOf(ctx);

  const count = (state, seconds) => {
    const mark = ctx.nodes.length;
    const frames = Math.round(seconds / 0.05);
    for (let i = 0; i < frames; i++) {
      audio.update(state);
      ctx.advance(0.05);
    }
    return ctx.nodes.slice(mark).filter((n) => n.kind === 'bufferSource').length;
  };

  const title = makeState({ phase: 'title' });
  assert.equal(count(title, 5), 0, 'no torch in the title screen');

  const full = makeState({ run: { ...makeState().run, fuel: 100 } });
  const hot = count(full, 10);
  assert.ok(hot > 8, `a burning torch should crackle (${hot} pops in 10 s)`);

  const dying = makeState({ run: { ...makeState().run, fuel: 2 } });
  const cold = count(dying, 10);
  assert.ok(cold < hot, `a dying torch crackles less (${hot} -> ${cold})`);

  // …and the flame bed follows the fuel too.
  const beds = ctx.ops.filter((o) => o.node === torchGain && o.method === 'target');
  assert.ok(beds.length >= 2);
  assert.ok(beds[beds.length - 1].value < beds[0].value || beds[0].value === 0);
});

test('an unchanged frame schedules no redundant parameter writes', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();
  audio.update(state);
  ctx.advance(0.016);
  audio.update(state); // settle
  ctx.advance(0.016);
  const mark = ctx.ops.length;
  for (let i = 0; i < 30; i++) {
    audio.update(state);
    ctx.advance(0.016);
  }
  const writes = ctx.opsSince(mark).filter((o) => o.method === 'target');
  // Nothing moved, so nothing may be rescheduled: mixer, portal, torch bed and drone all hold.
  assert.equal(writes.length, 0, `redundant continuous writes: ${writes.length}`);
});

test('the heartbeat only beats while playing on low fuel, and speeds up as fuel drops', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();

  // Not low on fuel: nothing.
  assert.equal(countBeats(ctx, audio, state, 3), 0, 'a full torch has no heartbeat');

  // Low fuel but paused: still nothing.
  state.derived.lowFuel = true;
  state.phase = 'paused';
  assert.equal(countBeats(ctx, audio, state, 3), 0, 'a paused game has no heartbeat');

  // Playing at 15% fuel: beats appear.
  state.phase = 'playing';
  state.run.fuel = 15;
  const slowBeats = countBeats(ctx, audio, state, 6);
  assert.ok(slowBeats > 0, 'low fuel starts the heartbeat');

  // Nearly empty: measurably faster.
  state.run.fuel = 0.5;
  const fastBeats = countBeats(ctx, audio, state, 6);
  assert.ok(
    fastBeats > slowBeats,
    `heartbeat should accelerate (${slowBeats} -> ${fastBeats} beats / 6 s)`,
  );

  // Refuelled: it stops.
  state.derived.lowFuel = false;
  state.run.fuel = 90;
  const after = countBeats(ctx, audio, state, 4);
  assert.equal(after, 0, 'the heartbeat stops once the torch is refilled');
});

/** Run `seconds` of frames and count scheduled heartbeat thumps (sine oscillators under 100 Hz). */
function countBeats(ctx, audio, state, seconds) {
  const mark = ctx.ops.length;
  const frames = Math.round(seconds / 0.05);
  for (let i = 0; i < frames; i++) {
    audio.update(state);
    ctx.advance(0.05);
  }
  return ctx
    .opsSince(mark)
    .filter((o) => o.param === 'frequency' && o.method === 'set' && o.value > 60 && o.value < 75)
    .length;
}

test('generative music schedules plucks over time and stops when music is muted', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState({ phase: 'title' });

  const mark = ctx.ops.length;
  for (let i = 0; i < 600; i++) {
    audio.update(state);
    ctx.advance(0.05); // 30 s
  }
  const notes = ctx.opsSince(mark).filter((o) => o.param === 'gain' && o.method === 'exp').length;
  assert.ok(notes > 4, `expected a handful of plucks in 30 s, saw ${notes}`);

  state.settings.music = 0;
  const mark2 = ctx.ops.length;
  for (let i = 0; i < 600; i++) {
    audio.update(state);
    ctx.advance(0.05);
  }
  const silentNotes = ctx
    .opsSince(mark2)
    .filter((o) => o.param === 'gain' && o.method === 'exp').length;
  assert.equal(silentNotes, 0, 'music 0 must schedule no plucks at all');
});

test('a long stall does not dump a burst of backlogged sounds', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState({ phase: 'title' });
  audio.update(state);
  ctx.currentTime += 600; // ten minutes with a hidden tab
  const mark = ctx.nodes.length;
  audio.update(state);
  assert.ok(ctx.nodes.length - mark < 8, 'the scheduler rebased instead of catching up');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Mixing
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('setVolume moves the master and music buses and mute skips voices entirely', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();

  const mark = ctx.ops.length;
  audio.setVolume(0.5, 0.25);
  const moved = ctx.opsSince(mark).filter((o) => o.method === 'target' && o.param === 'gain');
  assert.ok(moved.length >= 2, 'both buses were retargeted');

  audio.setVolume(0);
  const nodesBefore = ctx.nodes.length;
  audio.handle(
    [
      { type: 'footstep', foot: 0 },
      { type: 'bump', strength: 1 },
      { type: 'pickup', kind: 'gem', x: 1, y: 1, value: 100 },
      { type: 'levelComplete', level: 1, bonus: 10 },
    ],
    state,
  );
  assert.equal(ctx.nodes.length, nodesBefore, 'a muted engine allocates no voices');
  assert.equal(audio.stats().voices, 0);
});

test('update() adopts the volume settings from the state', () => {
  const { ctx, audio } = makeAudio({ volume: 1, music: 1 });
  audio.unlock();
  const state = makeState();
  audio.update(state);
  ctx.advance(0.016);

  state.settings.volume = 0;
  const mark = ctx.ops.length;
  audio.update(state);
  const targets = ctx.opsSince(mark).filter((o) => o.method === 'target' && o.param === 'gain');
  assert.ok(
    targets.some((o) => o.value === 0),
    'the master follows Settings.volume without an explicit setVolume call',
  );
});

test('a direct setVolume survives frames where the settings did not change', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();
  audio.update(state); // adopt the settings once
  audio.setVolume(0); // e.g. a mute hotkey that has not reached the store yet
  for (let i = 0; i < 10; i++) {
    ctx.advance(0.016);
    audio.update(state);
  }
  const before = ctx.nodes.length;
  audio.handle([{ type: 'bump', strength: 1 }], state);
  assert.equal(ctx.nodes.length, before, 'still muted after ten frames of unchanged settings');

  state.settings.volume = 0.9; // the player moves the slider: settings win again
  audio.update(state);
  audio.handle([{ type: 'bump', strength: 1 }], state);
  assert.ok(ctx.nodes.length > before, 'a settings change takes over');
});

test('a context without createWaveShaper still builds a working graph', () => {
  const ctx = new FakeCtx();
  // @ts-ignore — deliberately removing an optional factory method
  ctx.createWaveShaper = undefined;
  const audio = createAudio({ contextFactory: () => ctx, doc: null, seed: 5 });
  assert.equal(audio.unlock(), true);
  const comp = ctx.of('compressor')[0];
  assert.ok(
    ctx.connections.some(([a, b]) => a === comp && b === ctx.destination),
    'the compressor falls back to feeding the destination directly',
  );
  audio.handle([{ type: 'pickup', kind: 'gem', x: 1, y: 1, value: 1 }], makeState());
  assert.ok(audio.stats().voices > 0);
});

test('music is ducked by the phase (paused is quieter than the title screen)', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();

  const { musicBus } = graphOf(ctx);
  // The bus is only rewritten when the level actually moves, so track the last written value.
  let last = null;

  function busTarget(phase) {
    const state = makeState({ phase });
    const mark = ctx.ops.length;
    audio.update(state);
    ctx.advance(0.05);
    audio.update(state);
    const targets = ctx.opsSince(mark).filter((o) => o.node === musicBus && o.method === 'target');
    if (targets.length) last = targets[targets.length - 1].value;
    return last;
  }

  const paused = busTarget('paused');
  const title = busTarget('title');
  const playing = busTarget('playing');
  assert.ok(typeof paused === 'number' && typeof title === 'number');
  assert.ok(paused < title, `paused (${paused}) must duck under title (${title})`);
  assert.ok(playing < title, `playing (${playing}) sits back under title (${title})`);
  assert.ok(paused < playing, `paused (${paused}) is quieter than playing (${playing})`);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Document integration
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** A tiny document stub that can dispatch to registered listeners. */
function fakeDoc() {
  const listeners = new Map();
  return {
    hidden: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
    },
    fire(type) {
      const set = listeners.get(type);
      if (set) for (const fn of [...set]) fn({ type });
    },
    count(type) {
      const set = listeners.get(type);
      return set ? set.size : 0;
    },
  };
}

test('the first gesture unlocks automatically and the listeners are then removed', () => {
  const doc = fakeDoc();
  const ctx = new FakeCtx();
  const audio = createAudio({ contextFactory: () => ctx, doc, seed: 7 });
  assert.ok(doc.count('pointerdown') > 0, 'auto-unlock listener attached');
  assert.equal(audio.unlocked, false);
  doc.fire('pointerdown');
  assert.equal(audio.unlocked, true);
  assert.equal(doc.count('pointerdown'), 0, 'gesture listeners detach once running');
  assert.equal(doc.count('keydown'), 0);
  audio.dispose();
});

test('hiding the document suspends the context and returning resumes it', () => {
  const doc = fakeDoc();
  const ctx = new FakeCtx();
  const audio = createAudio({ contextFactory: () => ctx, doc, seed: 7 });
  audio.unlock();
  assert.equal(ctx.state, 'running');

  doc.hidden = true;
  doc.fire('visibilitychange');
  assert.equal(ctx.suspends, 1);
  assert.equal(ctx.state, 'suspended');
  assert.equal(audio.unlocked, false);

  doc.hidden = false;
  doc.fire('visibilitychange');
  assert.equal(ctx.state, 'running');
  assert.equal(audio.unlocked, true);
  audio.dispose();
  assert.equal(doc.count('visibilitychange'), 0, 'dispose detaches the visibility listener');
});

test('explicit suspend/resume work without a document', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  audio.suspend();
  assert.equal(ctx.state, 'suspended');
  audio.resume();
  assert.equal(ctx.state, 'running');
});

test('handle() before unlock is inert, and works right after', () => {
  const { ctx, audio } = makeAudio();
  audio.handle([{ type: 'bump', strength: 1 }], makeState());
  assert.equal(ctx.nodes.length, 1, 'only the destination exists before unlock');
  audio.unlock();
  audio.handle([{ type: 'bump', strength: 1 }], makeState());
  assert.ok(ctx.nodes.length > 5);
});

test('stats() returns a reused object with live counters', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const a = audio.stats();
  audio.handle([{ type: 'levelStart', level: 1 }], makeState());
  const b = audio.stats();
  assert.equal(a, b, 'stats() must not allocate');
  assert.ok(b.voices > 0);
  assert.equal(b.maxVoices, 24);
  assert.equal(b.state, 'running');
  assert.equal(typeof b.time, 'number');
});
