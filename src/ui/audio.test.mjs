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
    this._data = [];
    for (let c = 0; c < channels; c++) this._data.push(new Float32Array(length));
  }
  getChannelData(c = 0) {
    return this._data[c];
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
  createConvolver() {
    const n = new FakeNode(this, 'convolver');
    n.normalize = true;
    n.buffer = null;
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
  // One shared noise buffer plus one impulse response per reverb bus, all built once.
  assert.equal(ctx.buffers, 3, 'the noise buffer and the two IRs are created exactly once');
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
  assert.equal(ctx.buffers, 3, 'buffers are created once at unlock, never per voice');
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
  // Every source created for a voice that is no longer live must have been disconnected, except
  // the ones still sounding: the live voices and the stolen tails still fading in the retire ring
  // (at most one pool's worth). No shipped cue voice owns more than two sources. The always-on
  // generators never get a stop time, which is how they are told apart here.
  const live = audio.stats().voices;
  const voiceNodes = ctx.nodes.filter(
    (n) => (n.kind === 'osc' || n.kind === 'bufferSource') && n.stopped < Infinity,
  );
  const connected = voiceNodes.filter((n) => n.disconnects === 0).length;
  assert.ok(voiceNodes.length > 60, 'the storm actually created voices');
  assert.ok(
    connected <= (live + 6) * 2,
    `${connected}/${voiceNodes.length} voice sources are still connected`,
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

/**
 * Peak envelope amplitude in the given op slice: the attack ramps (`lin`) every voice's head gain
 * climbs to. Static `set`s are deliberately ignored — those are send levels and relative partial
 * gains, not loudness.
 */
function peakGain(ops) {
  let peak = 0;
  for (const op of ops) {
    if (op.param === 'gain' && op.method === 'lin') {
      if (op.value > peak) peak = op.value;
    }
  }
  return peak;
}

/** All filter cutoffs scheduled in the given op slice. */
function filterFreqs(ops) {
  return ops.filter((o) => o.param === 'frequency' && o.node.kind === 'filter').map((o) => o.value);
}

test('footsteps alternate pitch per foot and are louder at a full stride', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const walking = makeState({ player: { ...makeState().player, vx: 2.4, vy: 0 } });
  const striding = makeState({ player: { ...makeState().player, vx: 3.2, vy: 0 } });

  const m0 = ctx.ops.length;
  audio.handle([{ type: 'footstep', foot: 0 }], walking);
  const left = ctx.opsSince(m0);
  ctx.advance(0.5);

  const m1 = ctx.ops.length;
  audio.handle([{ type: 'footstep', foot: 1 }], walking);
  const right = ctx.opsSince(m1);
  ctx.advance(0.5);

  const m2 = ctx.ops.length;
  audio.handle([{ type: 'footstep', foot: 0 }], striding);
  const stride = ctx.opsSince(m2);

  const leftF = filterFreqs(left)[0];
  const rightF = filterFreqs(right)[0];
  assert.ok(leftF > 0 && rightF > 0, 'both feet filter the noise burst');
  assert.ok(leftF > rightF, 'the two feet have distinct centre frequencies');

  assert.ok(
    peakGain(stride) > peakGain(left) * 1.2,
    `full stride (${peakGain(stride)}) should be clearly louder than a walk step (${peakGain(left)})`,
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

test('the map scroll has its own cue: not the gem chime, not the oil whoosh, no combo step', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();

  /**
   * What one pickup of `kind` builds: its oscillator fundamentals and its noise filter types.
   * @param {string} kind
   */
  function cue(kind) {
    const mark = ctx.ops.length;
    const nodes = ctx.nodes.length;
    audio.handle([{ type: 'pickup', kind, x: 1, y: 1, value: 0 }], state);
    const added = ctx.nodes.slice(nodes);
    const freqs = ctx
      .opsSince(mark)
      .filter((o) => o.param === 'frequency' && o.node.kind === 'osc' && o.method === 'set')
      .map((o) => Math.round(o.value));
    return {
      freqs,
      oscTypes: added.filter((n) => n.kind === 'osc').map((n) => n.type),
      noise: added.filter((n) => n.kind === 'bufferSource').length,
      filters: added.filter((n) => n.kind === 'filter').map((n) => n.type),
    };
  }

  const gem = cue('gem');
  ctx.advance(AUDIO.COMBO_WINDOW + 0.5);
  const oil = cue('oil');
  ctx.advance(2);
  const map = cue('map');
  assert.ok(map.freqs.length >= 3, `the map cue has a chime (${map.freqs})`);
  assert.ok(map.noise >= 3, 'and a parchment rustle made of several crackles');
  assert.notDeepEqual(map.freqs, gem.freqs, 'not the gem arpeggio');
  assert.notDeepEqual(map.freqs, oil.freqs, 'not the oil refill');
  assert.ok(!map.oscTypes.includes('triangle'), 'no gem/oil triangle voice in the map cue');
  assert.ok(map.filters.includes('bandpass') && map.filters.includes('lowpass'));
  // Fundamentals only (each note also carries a quiet 2.76× bell partial): three notes, rising.
  const notes = map.freqs.filter((f) => f < 1000);
  assert.equal(notes.length, 3, `three chime notes (${map.freqs})`);
  assert.ok(notes[0] < notes[1] && notes[1] < notes[2], `the chime rises (${notes})`);

  // A replayed event inside the throttle window builds nothing.
  const again = cue('map');
  assert.equal(again.freqs.length + again.noise, 0, 'the map cue is rate-limited');

  // The map cue does not touch the gem combo ladder: gem, map, gem climbs exactly one rung — the
  // same as gem, gem — and a map on its own never starts a combo.
  ctx.advance(AUDIO.COMBO_WINDOW + 0.5);
  const base = cue('gem').freqs[0];
  ctx.advance(0.1);
  const rung1 = cue('gem').freqs[0];
  assert.ok(rung1 > base, 'sanity: two quick gems climb');
  ctx.advance(AUDIO.COMBO_WINDOW + 0.5);
  assert.equal(cue('gem').freqs[0], base);
  ctx.advance(0.1);
  assert.ok(cue('map').freqs.length > 0);
  ctx.advance(0.1);
  assert.equal(cue('gem').freqs[0], rung1, 'a map between two gems is not a combo step');
  ctx.advance(AUDIO.COMBO_WINDOW + 0.5);
  assert.ok(cue('map').freqs.length > 0);
  ctx.advance(0.1);
  assert.equal(cue('gem').freqs[0], base, 'a map alone never starts a combo');

  // An unknown kind is silent rather than a gem.
  ctx.advance(3);
  const unknown = cue('relic');
  assert.equal(unknown.freqs.length + unknown.noise, 0);
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

// ══════════════════════════════════════════════════════════════════════════════════════════════
// One sound per action (the unpause flam)
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** Square oscillators started in the given op slice — one confirm figure is exactly two. */
function squareBlips(ctx, from) {
  const ids = new Set(
    ctx
      .opsSince(from)
      .filter((o) => o.node.kind === 'osc')
      .map((o) => o.node.id),
  );
  return ctx.nodes.filter((n) => ids.has(n.id) && n.type === 'square').length;
}

test('unpausing from the menu plays the confirm blip exactly once', () => {
  // The real path: menus.js -> main.js -> playUi('confirm'), and the same key press dispatches
  // `resume`, whose phase event arrives here a moment later.
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();
  const mark = ctx.ops.length;
  audio.playUi('confirm');
  audio.handle([{ type: 'phase', from: 'paused', to: 'playing' }], state);
  assert.equal(squareBlips(ctx, mark), 2, 'one confirm figure is two square oscillators, not four');
});

test('a uiConfirm event in the same batch as the phase change also blips once', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();

  const mark = ctx.ops.length;
  audio.handle([{ type: 'uiConfirm' }, { type: 'phase', from: 'paused', to: 'playing' }], state);
  assert.equal(squareBlips(ctx, mark), 2, 'uiConfirm before the phase event');

  // …and in the other order, because nothing guarantees the reducer's emission order.
  ctx.advance(AUDIO.UI_ECHO + 0.1);
  const mark2 = ctx.ops.length;
  audio.handle([{ type: 'phase', from: 'paused', to: 'playing' }, { type: 'uiConfirm' }], state);
  assert.equal(squareBlips(ctx, mark2), 2, 'phase event before uiConfirm');
});

test('a programmatic resume with no menu blip still gets its confirm', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const mark = ctx.ops.length;
  audio.handle([{ type: 'phase', from: 'paused', to: 'playing' }], makeState());
  assert.equal(squareBlips(ctx, mark), 2, 'a bare resume is still audible');
});

test('pausing from a menu does not double the back blip either', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();
  const mark = ctx.ops.length;
  audio.playUi('back');
  audio.handle([{ type: 'phase', from: 'playing', to: 'paused' }], state);
  assert.equal(squareBlips(ctx, mark), 1, 'the back blip is one square oscillator');

  // A pause the player did not press a menu key for (pointer-lock loss, lost focus) still speaks.
  ctx.advance(AUDIO.UI_ECHO + 0.1);
  const mark2 = ctx.ops.length;
  audio.handle([{ type: 'phase', from: 'playing', to: 'paused' }], state);
  assert.equal(squareBlips(ctx, mark2), 1);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Event coverage
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('every GameEvent type in the contract is audible', () => {
  // The ten shapes of ARCHITECTURE.md §3's GameEvent union. A new type added to core/types.js
  // without a case here would otherwise go silently inaudible.
  const union = [
    { type: 'footstep', foot: 0 },
    { type: 'bump', strength: 0.7 },
    { type: 'pickup', kind: 'gem', x: 1, y: 1, value: 100 },
    { type: 'levelStart', level: 3 },
    { type: 'levelComplete', level: 3, bonus: 900 },
    { type: 'lowFuel' },
    { type: 'gameOver', score: 1200, newBest: false },
    { type: 'phase', from: 'playing', to: 'paused' },
    { type: 'uiMove' },
    { type: 'uiConfirm' },
  ];
  assert.equal(union.length, 10, 'the union has ten members');
  for (const ev of union) {
    const { ctx, audio } = makeAudio();
    audio.unlock();
    const before = ctx.nodes.length;
    audio.handle([ev], makeState());
    assert.ok(
      ctx.nodes.length > before,
      `'${ev.type}' scheduled nothing at all — it is inaudible in the shipped game`,
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Voice stealing policy
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('a short sound never evicts a longer one at the same priority', () => {
  const { audio } = makeAudio({ maxVoices: 4 });
  audio.unlock();
  const state = makeState();
  // Three long CUE voices (the oil whoosh) plus the bump's own first voice fill the pool.
  audio.handle([{ type: 'pickup', kind: 'oil', x: 1, y: 1, value: 12 }], state);
  const before = { stolen: audio.stats().stolen, dropped: audio.stats().dropped };
  // A bump is the same priority but much shorter: its second voice must be dropped, not granted
  // by chopping half a second off something still ringing.
  audio.handle([{ type: 'bump', strength: 1 }], state);
  const after = audio.stats();
  assert.equal(after.stolen, before.stolen, 'nothing was stolen for a shorter sound');
  assert.ok(after.dropped > before.dropped, 'the shorter sound was dropped instead');
});

test('torch crackles never steal a voice, they are dropped', () => {
  const { ctx, audio } = makeAudio({ maxVoices: 4 });
  audio.unlock();
  // Four bell voices (PRI.STING, 1.5 s+) fill the pool.
  audio.handle([{ type: 'levelStart', level: 1 }], makeState());
  assert.equal(audio.stats().voices, 4, 'the pool is full of stings');
  const state = makeState({ run: { ...makeState().run, fuel: 100 } });
  const before = audio.stats().dropped;
  for (let i = 0; i < 10; i++) {
    audio.update(state); // asks for crackles (PRI.AMBIENT) and plucks (PRI.MUSIC)
    ctx.advance(0.05);
  }
  const s = audio.stats();
  assert.equal(s.stolen, 0, 'ambience must never truncate a sting');
  assert.ok(s.dropped > before, 'the ambient requests were dropped instead');
});

test('a stolen voice is faded out over a few milliseconds, not cut dead', () => {
  const { ctx, audio } = makeAudio({ maxVoices: 4 });
  audio.unlock();
  const state = makeState();
  // Fill the pool with CUE voices, then let a STING (higher priority) take one.
  audio.handle([{ type: 'pickup', kind: 'oil', x: 1, y: 1, value: 12 }], state);
  audio.handle([{ type: 'bump', strength: 1 }], state);
  const mark = ctx.ops.length;
  const t0 = ctx.currentTime;
  audio.handle([{ type: 'levelStart', level: 1 }], state);
  assert.ok(audio.stats().stolen > 0, 'the sting actually stole');

  const fades = ctx.opsSince(mark).filter((o) => o.method === 'exp' && o.value === 1e-4);
  assert.ok(fades.length > 0, 'the stolen voice was ramped to silence');
  assert.ok(fades[0].time > t0 && fades[0].time <= t0 + 0.05, 'and the ramp is short');

  // Nothing was stopped at the current instant, which is what the hard cut used to do.
  const cut = ctx.nodes.filter((n) => n.stopped === t0 && n.started >= 0);
  assert.equal(cut.length, 0, 'no source was stopped with no fade at all');
});

test('the tails of stolen voices are disconnected by the reap, never left connected', () => {
  const { ctx, audio } = makeAudio({ maxVoices: 4 });
  audio.unlock();
  const state = makeState({ phase: 'title' });
  for (let i = 0; i < 12; i++) {
    audio.handle([{ type: 'bump', strength: 1 }], state);
  }
  assert.ok(audio.stats().stolen > 0);
  ctx.currentTime += 5;
  for (const n of ctx.nodes) n.onended = null; // the suspended-context case: no ended callbacks
  audio.update(state);
  assert.equal(audio.stats().voices, 0);
  // Every source that was given a stop time belonged to a voice (the always-on portal/torch/drone
  // generators never get one) and must have been disconnected with it.
  const live = ctx.nodes.filter(
    (n) => n instanceof FakeSource && n.started >= 0 && n.stopped < Infinity && n.disconnects === 0,
  );
  assert.equal(live.length, 0, `${live.length} stolen sources stayed connected`);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Tuning: the sustained lows, and depth
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('the portal fundamental is locked to the drone and the drone fifth is exactly 3:2', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const freqs = ctx.ops
    .filter((o) => o.param === 'frequency' && o.node.kind === 'osc')
    .map((o) => o.value);
  const root = AUDIO.MUSIC.droneHz;
  const has = (hz) => freqs.some((f) => Math.abs(f - hz) < 1e-6);
  assert.ok(has(root), 'the drone root');
  assert.ok(has(root * 1.5), 'a pure 3:2 fifth, not the equal-tempered 1.498307');
  assert.ok(!has(root * 1.4983), 'the equal-tempered fifth is gone');
  assert.ok(has(root * 2), 'the portal fundamental is an octave above the drone');
  // Nothing sustained sits a few Hz from the drone, which is what produced the low-end mud. The
  // one exception is the drone's own 0.4 % detuned twin, which is the slow shimmer it is made of.
  for (const f of freqs) {
    const gap = Math.abs(f - root);
    assert.ok(
      gap < root * 0.01 || gap > 12,
      `a sustained ${f} Hz throbs against the ${root} Hz drone`,
    );
  }
});

test('the ambience is keyed to the depth: different levels, different notes', () => {
  /** @returns {number[]} pluck fundamentals over `seconds` on the title screen */
  function plucks(level, seconds) {
    const { ctx, audio } = makeAudio({ seed: 99 });
    audio.unlock();
    const state = makeState({ phase: 'title', level });
    const mark = ctx.ops.length;
    const frames = Math.round(seconds / 0.05);
    for (let i = 0; i < frames; i++) {
      audio.update(state);
      ctx.advance(0.05);
    }
    return ctx
      .opsSince(mark)
      .filter((o) => o.param === 'frequency' && o.node.kind === 'osc' && o.method === 'set')
      .map((o) => o.value);
  }

  const l1 = plucks(1, 120);
  const l2 = plucks(2, 120);
  assert.ok(l1.length > 4 && l2.length > 4, 'both levels made music');
  assert.notDeepEqual(l1, l2, 'level 2 must not replay level 1 note for note');
  const ratio = Math.pow(2, -2 / 12); // MUSIC_KEYS[1]
  for (let i = 0; i < Math.min(l1.length, l2.length); i++) {
    assert.ok(
      Math.abs(l2[i] / l1[i] - ratio) < 1e-6,
      `pluck ${i} is not transposed by the level key (${l1[i]} -> ${l2[i]})`,
    );
  }

  // …and the deepest levels are denser, because they take three times as long to walk.
  const deep = plucks(AUDIO.MUSIC.depthSpan, 300);
  const shallow = plucks(1, 300);
  assert.ok(
    deep.length > shallow.length,
    `depth should thicken the line (${shallow.length} -> ${deep.length} notes in 300 s)`,
  );
});

test('the descent bell states the level key, so level 1 and level 15 differ', () => {
  /** @returns {number[]} bell fundamentals for one levelStart */
  function bell(level) {
    const { ctx, audio } = makeAudio();
    audio.unlock();
    const mark = ctx.ops.length;
    audio.handle([{ type: 'levelStart', level }], makeState({ level }));
    return ctx
      .opsSince(mark)
      .filter((o) => o.param === 'frequency' && o.node.kind === 'osc' && o.method === 'set')
      .map((o) => o.value);
  }
  const first = bell(1);
  const deep = bell(15);
  assert.ok(first.length >= 4 && deep.length >= 4);
  assert.notDeepEqual(first, deep, 'the same bell on the first and the deepest level');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Positional pickups and the record run
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('a pickup is panned toward where the item actually was', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();
  state.player.x = 5;
  state.player.y = 5;
  state.player.angle = 0; // facing +x (east)

  /** @returns {number} the pan written for a gem at (x, y) */
  function panFor(x, y) {
    const mark = ctx.ops.length;
    audio.handle([{ type: 'pickup', kind: 'gem', x, y, value: 100 }], state);
    ctx.advance(AUDIO.COMBO_WINDOW + 0.5); // let the combo lapse between measurements
    const ops = ctx.opsSince(mark).filter((o) => o.param === 'pan');
    assert.ok(ops.length > 0, 'a panner was inserted for an off-centre pickup');
    return ops[0].value;
  }

  assert.ok(panFor(5, 4) < -0.4, 'a gem to the north is on your left when facing east');
  assert.ok(panFor(5, 6) > 0.4, 'a gem to the south is on your right');

  // Dead ahead needs no panner at all — the cheap path stays cheap.
  const mark = ctx.ops.length;
  audio.handle([{ type: 'pickup', kind: 'gem', x: 9, y: 5, value: 100 }], state);
  assert.equal(
    ctx.opsSince(mark).filter((o) => o.param === 'pan').length,
    0,
    'a centred pickup allocates no panner',
  );
});

test('beating your own record sounds different from a bad run', () => {
  function gameOver(newBest) {
    const { ctx, audio } = makeAudio();
    audio.unlock();
    const mark = ctx.ops.length;
    audio.handle([{ type: 'gameOver', score: 5000, newBest }], makeState());
    return ctx
      .opsSince(mark)
      .filter((o) => o.param === 'frequency' && o.node.kind === 'osc' && o.method === 'set')
      .map((o) => o.value);
  }
  const plain = gameOver(false);
  const record = gameOver(true);
  assert.ok(record.length > plain.length, 'a record run adds the payoff chord');
  assert.ok(
    record.some((f) => Math.abs(f - 523.25) < 1e-6),
    'the rising triad is there',
  );
  assert.ok(
    !plain.some((f) => Math.abs(f - 523.25) < 1e-6),
    'a losing run must not get it',
  );
});

test('the heartbeat urgency curve is measured against the mirrored low-fuel fraction', () => {
  // AUDIO.HEART.lowFraction mirrors balance.js FUEL.LOW_FRACTION; if it is ever edited on its own
  // the beat reaches maximum urgency at the wrong tank level.
  assert.equal(AUDIO.HEART.lowFraction, 0.25);
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState();
  state.derived.lowFuel = true;
  // Exactly at the threshold the beat must be at its slowest; half the threshold is measurably
  // faster, which is the escalation the cue exists for.
  state.run.fuel = state.run.fuelMax * AUDIO.HEART.lowFraction;
  const atThreshold = countBeats(ctx, audio, state, 8);
  state.run.fuel = state.run.fuelMax * AUDIO.HEART.lowFraction * 0.5;
  const halfway = countBeats(ctx, audio, state, 8);
  assert.ok(atThreshold > 0, 'the beat starts at the threshold');
  assert.ok(halfway > atThreshold, `the curve escalates (${atThreshold} -> ${halfway})`);
});

test('the widest cues fit a voice: no node is ever dropped past MAX_NODES', async () => {
  // `own()` logs instead of silently leaking when a cue needs more nodes than a voice can hold.
  // Drive every cue with every optional node switched on (pan + send + partial) and assert the
  // guard never fired, so adding a node to a cue fails here rather than leaking in the browser.
  const { errors, clearErrors } = await import('../core/log.js');
  clearErrors();
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState({ derived: { exitDist: 2, nearExit: 1, lowFuel: true } });
  state.run.fuel = 5;
  const all = [
    { type: 'footstep', foot: 1 },
    { type: 'bump', strength: 1 },
    { type: 'pickup', kind: 'gem', x: 1.5, y: 0.5, value: 100 },
    { type: 'pickup', kind: 'oil', x: 1.5, y: 2.5, value: 12 },
    { type: 'lowFuel' },
    { type: 'levelStart', level: 7 },
    { type: 'levelComplete', level: 7, bonus: 900 },
    { type: 'gameOver', score: 9000, newBest: true },
    { type: 'phase', from: 'playing', to: 'paused' },
    { type: 'uiMove' },
    { type: 'uiConfirm' },
  ];
  for (let i = 0; i < 20; i++) {
    audio.handle(all, state);
    audio.update(state);
    ctx.advance(0.1);
  }
  const overflow = errors.filter((e) => JSON.stringify(e).includes('overflow'));
  assert.equal(overflow.length, 0, 'a cue asked for more nodes than MAX_NODES');
  assert.equal(audio.stats().failures, 0);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Round 3: key discipline, small speakers, the room, the phrase engine, lifecycle hardening
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** Level key offsets in semitones, mirrored from audio.js MUSIC_KEYS (A, G, C, E). */
const KEY_SEMIS = [0, -2, 3, -5];
/** Minor pentatonic pitch classes over the tonic. */
const SCALE_PCS = new Set([0, 3, 5, 7, 10]);

/**
 * Pitch class of `f` relative to the level's tonic, or NaN when `f` is not on an equal-tempered
 * semitone of that key at all.
 * @param {number} f Hz
 * @param {number} level 1-based
 * @returns {number}
 */
function pitchClass(f, level) {
  const tonic = AUDIO.MUSIC.root * Math.pow(2, KEY_SEMIS[(level - 1) % 4] / 12);
  const semis = 12 * Math.log2(f / tonic);
  const r = Math.round(semis);
  if (Math.abs(semis - r) > 0.02) return NaN;
  return ((r % 12) + 12) % 12;
}

/** Oscillator frequencies set in an op slice. */
function oscFreqs(ctx, from) {
  return ctx
    .opsSince(from)
    .filter((o) => o.param === 'frequency' && o.node.kind === 'osc' && o.method === 'set')
    .map((o) => o.value);
}

test('the gem chime and its whole combo ladder stay inside the level key', () => {
  for (const level of [1, 2, 3, 4]) {
    const { ctx, audio } = makeAudio();
    audio.unlock();
    const state = makeState({ level, phase: 'title' });
    audio.update(state); // keys the engine to the level
    const mark = ctx.ops.length;
    // A nine-gem sweep: climbs the ladder to COMBO_MAX and holds there. Handled back to back (no
    // update() in between) so no music pluck lands in the measured slice.
    for (let i = 0; i < 9; i++) {
      audio.handle([{ type: 'pickup', kind: 'gem', x: 2.5, y: 1.5, value: 100 }], state);
      ctx.advance(0.15);
    }
    const freqs = oscFreqs(ctx, mark);
    assert.ok(freqs.length >= 27, `level ${level}: the sweep produced ${freqs.length} tones`);
    for (const f of freqs) {
      const pc = pitchClass(f, level);
      assert.ok(
        SCALE_PCS.has(pc),
        `level ${level}: gem tone ${f.toFixed(2)} Hz (pc ${pc}) is out of key`,
      );
    }
  }
});

test('the gem ladder climbs one scale step per combo, never a whole-tone ladder', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState({ level: 2, phase: 'title' });
  audio.update(state);
  const roots = [];
  for (let i = 0; i <= AUDIO.COMBO_MAX; i++) {
    const mark = ctx.ops.length;
    audio.handle([{ type: 'pickup', kind: 'gem', x: 2.5, y: 1.5, value: 100 }], state);
    roots.push(oscFreqs(ctx, mark)[0]);
    ctx.advance(0.2);
  }
  for (let i = 1; i < roots.length; i++) {
    const step = 12 * Math.log2(roots[i] / roots[i - 1]);
    assert.ok(step > 1.9 && step < 3.1, `rung ${i} moved ${step.toFixed(2)} semitones`);
  }
});

test('the record chord is transposed into the key the run ended in', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const state = makeState({ level: 4, phase: 'gameOver' });
  audio.update(state);
  const mark = ctx.ops.length;
  audio.handle([{ type: 'gameOver', score: 5000, newBest: true }], state);
  const key = Math.pow(2, KEY_SEMIS[3] / 12);
  const freqs = oscFreqs(ctx, mark);
  for (const hz of [523.25, 659.25, 783.99]) {
    assert.ok(
      freqs.some((f) => Math.abs(f - hz * key) < 1e-6),
      `record triad note ${hz} is not transposed to the level-4 key`,
    );
  }
  assert.ok(!freqs.some((f) => Math.abs(f - 523.25) < 1e-6), 'the untransposed C major is gone');
});

/**
 * What a small speaker can reproduce: tones at or above `floorHz`, and band/high-passed noise
 * centred at or above it.
 * @returns {{tones:number[], bands:number[]}}
 */
function audibleOnSmallSpeakers(ctx, from, floorHz) {
  const ops = ctx.opsSince(from);
  const tones = ops
    .filter(
      (o) =>
        o.param === 'frequency' && o.node.kind === 'osc' && o.method === 'set' && o.value >= floorHz,
    )
    .map((o) => o.value);
  const bands = ops
    .filter(
      (o) =>
        o.param === 'frequency' &&
        o.node.kind === 'filter' &&
        o.method === 'set' &&
        o.value >= floorHz &&
        (o.node.type === 'bandpass' || o.node.type === 'highpass'),
    )
    .map((o) => o.value);
  return { tones, bands };
}

test('the heartbeat, bump and footstep all carry content a phone speaker can play', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();

  // Heartbeat, measured on the first update that arms it (no music/crackle in the way: we only
  // look at filters and tones the beat itself creates, but keep the phase honest).
  const state = makeState();
  state.derived.lowFuel = true;
  state.run.fuel = 20;
  audio.update(makeState({ phase: 'title', level: 1 }));
  ctx.advance(0.05);
  let mark = ctx.ops.length;
  audio.update(state);
  const beat = audibleOnSmallSpeakers(ctx, mark, 150);
  assert.ok(
    beat.tones.filter((f) => f >= 180 && f <= 210).length >= 2,
    `the lub and the dub each need a harmonic above 150 Hz (${beat.tones})`,
  );
  assert.ok(
    beat.bands.some((f) => f >= 600 && f <= 1300),
    'the lub needs a band-passed transient in the 0.6–1.3 kHz range',
  );

  ctx.advance(2);
  mark = ctx.ops.length;
  audio.handle([{ type: 'bump', strength: 0.6 }], makeState());
  const bump = audibleOnSmallSpeakers(ctx, mark, 150);
  assert.ok(bump.tones.length >= 1, 'the bump thud has an upper partial');
  assert.ok(bump.bands.some((f) => f >= 500), 'the bump has a stone slap above 500 Hz');

  ctx.advance(2);
  mark = ctx.ops.length;
  audio.handle([{ type: 'footstep', foot: 0 }], makeState());
  const step = audibleOnSmallSpeakers(ctx, mark, 150);
  assert.ok(step.tones.length >= 1 && step.bands.length >= 1, 'the step keeps grit and a harmonic');
});

test('each bus reverb is a convolver on a synthetic, decaying, decorrelated stereo IR', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const convs = ctx.of('convolver');
  assert.equal(convs.length, 2, 'one room per bus');
  assert.equal(ctx.of('delay').length, 0, 'the single-echo delay line is gone');
  const { sfxBus, musicBus } = graphOf(ctx);
  assert.ok(
    ctx.connections.some(([a, b]) => a === convs[0] && b === sfxBus),
    'the sfx room returns into the sfx bus',
  );
  assert.ok(
    ctx.connections.some(([a, b]) => a === convs[1] && b === musicBus),
    'the music room returns into the music bus',
  );

  for (const [i, conv] of convs.entries()) {
    const spec = i === 0 ? AUDIO.REVERB.sfx : AUDIO.REVERB.music;
    assert.equal(conv.normalize, false, 'the IR carries its own calibrated level');
    const buf = conv.buffer;
    assert.ok(buf && buf.numberOfChannels === 2, 'stereo IR');
    assert.ok(Math.abs(buf.duration - spec.seconds) < 0.01, 'a real tail, not a single echo');
    assert.ok(buf.duration >= 1);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const q = Math.floor(L.length / 4);
    let head = 0;
    let tail = 0;
    let energy = 0;
    let cross = 0;
    let nonFinite = 0;
    for (let n = 0; n < L.length; n++) {
      if (!Number.isFinite(L[n]) || !Number.isFinite(R[n])) nonFinite++;
      if (n < q) head += L[n] * L[n];
      if (n >= 3 * q) tail += L[n] * L[n];
      energy += L[n] * L[n];
      cross += L[n] * R[n];
    }
    assert.equal(nonFinite, 0);
    assert.ok(tail < head * 0.01, `the tail decays (${tail} vs ${head})`);
    assert.ok(
      Math.abs(energy - spec.energy) < 1e-3,
      `IR energy is calibrated to ${spec.energy} (${energy})`,
    );
    assert.ok(Math.abs(cross) < energy * 0.3, 'left and right are decorrelated, so the room is wide');
    const preSamples = Math.floor(buf.sampleRate * spec.pre);
    for (let n = 0; n < preSamples; n++) assert.equal(L[n], 0, 'silence before the pre-delay');
  }
});

test('the reverb IR is deterministic per seed', () => {
  const irOf = (seed) => {
    const { ctx, audio } = makeAudio({ seed });
    audio.unlock();
    return Array.from(ctx.of('convolver')[0].buffer.getChannelData(0).slice(0, 4000));
  };
  assert.deepEqual(irOf(42), irOf(42));
  assert.notDeepEqual(irOf(42), irOf(43));
});

test('a context without createConvolver still gets a (delay) tail and makes sound', () => {
  const ctx = new FakeCtx();
  // @ts-ignore — deliberately removing an optional factory method
  ctx.createConvolver = undefined;
  const audio = createAudio({ contextFactory: () => ctx, doc: null, seed: 5 });
  assert.equal(audio.unlock(), true);
  assert.equal(ctx.of('delay').length, 2, 'a fallback tail per bus');
  audio.handle([{ type: 'levelStart', level: 1 }], makeState());
  assert.ok(audio.stats().voices > 0);
});

/**
 * Play the title-screen ambience for `seconds` and return the *melody* in order: triangle plucks,
 * skipping cadence dyads (which start 90 ms after their note).
 * @returns {{t:number, f:number}[]}
 */
function melody(seconds, level = 1, seed = 1234) {
  const { ctx, audio } = makeAudio({ seed });
  audio.unlock();
  const state = makeState({ phase: 'title', level });
  const mark = ctx.nodes.length;
  const frames = Math.round(seconds / 0.05);
  for (let i = 0; i < frames; i++) {
    audio.update(state);
    ctx.advance(0.05);
  }
  const notes = ctx.nodes
    .slice(mark)
    .filter((n) => n.kind === 'osc' && n.type === 'triangle' && n.started >= 0)
    .map((n) => ({ t: n.started, f: n.frequency.value }))
    .sort((a, b) => a.t - b.t);
  /** @type {{t:number, f:number}[]} */
  const out = [];
  for (const n of notes) {
    if (out.length && n.t - out[out.length - 1].t < 0.3) continue; // the dyad under a cadence
    out.push(n);
  }
  return out;
}

/** Split a melody into phrases at the long rests. @returns {{t:number, f:number}[][]} */
function phrasesOf(notes) {
  const restGap = AUDIO.PHRASE.pulse * AUDIO.PHRASE.restMin;
  const out = [];
  let cur = [];
  for (let i = 0; i < notes.length; i++) {
    cur.push(notes[i]);
    if (i + 1 === notes.length || notes[i + 1].t - notes[i].t >= restGap - 1e-6) {
      out.push(cur);
      cur = [];
    }
  }
  return out;
}

test('the generative line moves mostly by step, on a pulse grid, in key', () => {
  const notes = melody(600);
  assert.ok(notes.length > 80, `ten minutes should hold plenty of notes (${notes.length})`);
  let steps = 0;
  for (let i = 1; i < notes.length; i++) {
    const semis = Math.abs(12 * Math.log2(notes[i].f / notes[i - 1].f));
    if (semis <= 5.01) steps++;
  }
  const moves = notes.length - 1;
  // A uniform draw from the old two-octave bag landed within a fourth well under half the time.
  assert.ok(steps / moves >= 0.7, `only ${steps}/${moves} intervals are steps`);
  for (const n of notes) assert.ok(SCALE_PCS.has(pitchClass(n.f, 1)), `${n.f} Hz is out of key`);
  const t0 = notes[0].t;
  for (const n of notes) {
    const beats = (n.t - t0) / AUDIO.PHRASE.pulse;
    assert.ok(Math.abs(beats - Math.round(beats)) < 1e-6, `onset ${n.t} is off the pulse grid`);
  }
});

test('phrases breathe and resolve: every phrase ends on the root or the fifth', () => {
  const phrases = phrasesOf(melody(600));
  assert.ok(phrases.length >= 10, `ten minutes should contain many phrases (${phrases.length})`);
  // The last phrase may be cut off by the end of the window.
  for (const p of phrases.slice(0, -1)) {
    const pc = pitchClass(p[p.length - 1].f, 1);
    assert.ok(pc === 0 || pc === 7, `a phrase ended on pitch class ${pc}, not the root or fifth`);
    assert.ok(p.length >= 2, 'a phrase is a motif, not a lone pluck');
  }
});

test('the motif recurs, varied, rather than every phrase being new or identical', () => {
  const phrases = phrasesOf(melody(600)).slice(0, -1);
  const keys = phrases.map((p) => p.map((n) => Math.round(12 * Math.log2(n.f / 110))).join(','));
  const distinct = new Set(keys).size;
  assert.ok(distinct < keys.length, `no phrase ever came back (${distinct}/${keys.length})`);
  assert.ok(distinct > 2, 'but the line is not one loop either');
});

test('an OS interruption re-arms the gesture listeners and a tap brings sound back', () => {
  const doc = fakeDoc();
  const ctx = new FakeCtx();
  const audio = createAudio({ contextFactory: () => ctx, doc, seed: 7 });
  doc.fire('pointerdown');
  assert.equal(audio.unlocked, true);
  assert.equal(doc.count('pointerdown'), 0);

  // iOS Safari after a phone call: 'interrupted', page still visible, and resume() refused.
  ctx.resume = () => {
    ctx.resumes++;
    return Promise.reject(new Error('not allowed without a gesture'));
  };
  const before = ctx.resumes;
  ctx.state = 'interrupted';
  assert.equal(typeof ctx.onstatechange, 'function', 'the engine listens for state changes');
  ctx.onstatechange();
  assert.equal(audio.unlocked, false);
  assert.ok(ctx.resumes > before, 'a resume was attempted straight away');
  assert.ok(doc.count('pointerdown') > 0, 'the next tap is listened for again');

  // The tap: now the platform allows it.
  ctx.resume = FakeCtx.prototype.resume;
  doc.fire('touchend');
  assert.equal(ctx.state, 'running');
  assert.equal(audio.unlocked, true);
  assert.equal(doc.count('touchend'), 0, 'and the listeners detach again once running');

  audio.dispose();
  assert.equal(ctx.onstatechange, null, 'teardown clears the state hook');
});

test('an explicit suspend() is not undone by the interruption recovery', () => {
  const doc = fakeDoc();
  const ctx = new FakeCtx();
  const audio = createAudio({ contextFactory: () => ctx, doc, seed: 7 });
  doc.fire('pointerdown');
  audio.suspend();
  ctx.onstatechange();
  assert.equal(ctx.state, 'suspended');
  assert.equal(doc.count('pointerdown'), 0, 'no listener re-armed for a deliberate suspend');
  audio.resume();
  assert.equal(ctx.state, 'running');
  audio.dispose();
});

test('isolated failures decay; only a burst switches audio off', () => {
  const { ctx, audio } = makeAudio();
  audio.unlock();
  const realGain = ctx.createGain;
  const state = makeState({ phase: 'title' });
  const failOnce = () => {
    ctx.createGain = () => {
      throw new Error('transient');
    };
    audio.handle([{ type: 'bump', strength: 1 }], state);
    ctx.createGain = realGain;
  };
  // Forty rare failures, one every three seconds: a long run with a flaky edge case.
  for (let i = 0; i < 40; i++) {
    failOnce();
    ctx.advance(3);
    audio.update(state);
  }
  assert.equal(audio.available, true, 'sporadic failures must not add up to silence');
  assert.equal(audio.stats().failures, 40, 'but every one is still counted');

  // A genuine burst still trips the breaker.
  for (let i = 0; i < AUDIO.FAIL.burst; i++) failOnce();
  assert.equal(audio.available, false, 'a failure storm switches audio off');
  assert.equal(audio.stats().state, 'failed');
});

test('rejected suspend/resume/close promises are always handled', async () => {
  const rejections = [];
  const onRejection = (r) => rejections.push(r);
  process.on('unhandledRejection', onRejection);
  try {
    const doc = fakeDoc();
    const ctx = new FakeCtx();
    const audio = createAudio({ contextFactory: () => ctx, doc, seed: 3 });
    doc.fire('pointerdown');
    ctx.suspend = () => Promise.reject(new Error('closed'));
    ctx.close = () => Promise.reject(new Error('closed'));
    ctx.resume = () => Promise.reject(new Error('no gesture'));
    audio.suspend();
    doc.hidden = true;
    doc.fire('visibilitychange');
    doc.hidden = false;
    ctx.state = 'suspended';
    doc.fire('visibilitychange');
    audio.resume();
    audio.dispose();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.equal(rejections.length, 0, `unhandled rejections: ${rejections.join('; ')}`);
});

test('a steal storm keeps the retire ring bounded and reaps it completely', () => {
  const { ctx, audio } = makeAudio({ maxVoices: 4 });
  audio.unlock();
  const state = makeState({ phase: 'title', settings: { ...makeState().settings, music: 0 } });
  const stillConnected = () =>
    ctx.nodes.filter(
      (n) =>
        n instanceof FakeSource && n.started >= 0 && n.stopped < Infinity && n.disconnects === 0,
    ).length;
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 50; i++) audio.handle([{ type: 'levelStart', level: 1 }], state);
    // Live voices plus one pool's worth of fading tails, two sources each at most.
    const connected = stillConnected();
    assert.ok(connected <= (4 + 4) * 2, `round ${round}: ${connected} sources still connected`);
    ctx.currentTime += 5;
    for (const n of ctx.nodes) n.onended = null;
    audio.update(state);
  }
  assert.equal(stillConnected(), 0);
  assert.ok(audio.stats().stolen > 100, 'the storm really did steal');
});
