'use strict';
/**
 * 最小可用的 Web Audio API 模拟层，用于在 Node 里跑 SPG 引擎。
 *
 * 重点不是"能跑"，而是**像浏览器一样报错**：
 * 真实 Web Audio 会在下列情况抛异常，而引擎里一旦抛异常整条渲染链就断掉，
 * 所以这些检查必须复现出来，否则测试是假绿的。
 */

class MockAudioParam {
  constructor(name, value = 0) {
    this.name = name;
    this.value = value;
    this.events = [];
  }
  _checkTime(t, method) {
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      throw new TypeError(`${this.name}.${method}: time 不是有限数字 (${t})`);
    }
    if (t < 0) {
      throw new RangeError(`${this.name}.${method}: time 不能为负 (${t})`);
    }
  }
  _checkValue(v, method) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError(`${this.name}.${method}: value 不是有限数字 (${v})`);
    }
  }
  setValueAtTime(v, t) {
    this._checkValue(v, 'setValueAtTime');
    this._checkTime(t, 'setValueAtTime');
    this.events.push({ kind: 'set', v, t });
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this._checkValue(v, 'linearRampToValueAtTime');
    this._checkTime(t, 'linearRampToValueAtTime');
    this.events.push({ kind: 'linear', v, t });
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    this._checkValue(v, 'exponentialRampToValueAtTime');
    this._checkTime(t, 'exponentialRampToValueAtTime');
    // 浏览器规范：指数斜坡的目标值必须非零且与当前值同号
    if (v === 0) {
      throw new RangeError(`${this.name}.exponentialRampToValueAtTime: 目标值不能为 0`);
    }
    this.events.push({ kind: 'exp', v, t });
    return this;
  }
  setTargetAtTime(v, t) {
    this._checkValue(v, 'setTargetAtTime');
    this._checkTime(t, 'setTargetAtTime');
    this.events.push({ kind: 'target', v, t });
    return this;
  }
  cancelScheduledValues(t) {
    this.events.push({ kind: 'cancel', t });
    return this;
  }
  /** 最后一个自动化事件的时间；用于断言时间点单调 */
  get lastTime() {
    let m = -Infinity;
    for (const e of this.events) if (e.t > m) m = e.t;
    return m;
  }
}

let NODE_ID = 0;

class MockAudioNode {
  constructor(ctx, kind) {
    this.context = ctx;
    this.kind = kind;
    this.id = ++NODE_ID;
    this.outputs = [];
    this.inputs = [];
    this._disconnected = false;
  }
  connect(dest, out, inp) {
    if (!dest) throw new TypeError(`${this.kind}.connect: 目标为空`);
    this.outputs.push(dest);
    if (dest instanceof MockAudioNode) dest.inputs.push(this);
    return dest;
  }
  disconnect() {
    this.outputs.length = 0;
    this._disconnected = true;
  }
}

class MockScheduledSource extends MockAudioNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.started = false;
    this.stopped = false;
    this.startTime = null;
    this.stopTime = null;
    this.onended = null;
  }
  start(t = 0) {
    if (this.started) throw new Error(`${this.kind}.start: 已启动的节点不能重复 start`);
    if (!Number.isFinite(t) || t < 0) throw new RangeError(`${this.kind}.start: 非法时间 ${t}`);
    this.started = true;
    this.startTime = t;
    this.context._sources.push(this);
  }
  stop(t = 0) {
    if (!this.started) throw new Error(`${this.kind}.stop: 未启动就 stop`);
    if (!Number.isFinite(t) || t < 0) throw new RangeError(`${this.kind}.stop: 非法时间 ${t}`);
    this.stopped = true;
    this.stopTime = t;
  }
}

class MockOscillator extends MockScheduledSource {
  constructor(ctx) {
    super(ctx, 'OscillatorNode');
    this._type = 'sine';
    this.frequency = new MockAudioParam('frequency', 440);
    this.detune = new MockAudioParam('detune', 0);
    this._periodicWave = null;
  }
  get type() { return this._type; }
  set type(v) {
    const ok = ['sine', 'square', 'sawtooth', 'triangle', 'custom'];
    if (!ok.includes(v)) throw new TypeError(`OscillatorNode.type: 非法波形 "${v}"`);
    this._type = v;
  }
  setPeriodicWave(w) {
    if (!w) throw new TypeError('setPeriodicWave: 波形为空');
    this._periodicWave = w;
    this._type = 'custom';
  }
}

class MockGainNode extends MockAudioNode {
  constructor(ctx) { super(ctx, 'GainNode'); this.gain = new MockAudioParam('gain', 1); }
}
class MockBiquadFilter extends MockAudioNode {
  constructor(ctx) {
    super(ctx, 'BiquadFilterNode');
    this._type = 'lowpass';
    this.frequency = new MockAudioParam('frequency', 350);
    this.Q = new MockAudioParam('Q', 1);
    this.gain = new MockAudioParam('gain', 0);
    this.detune = new MockAudioParam('detune', 0);
  }
  get type() { return this._type; }
  set type(v) {
    const ok = ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'];
    if (!ok.includes(v)) throw new TypeError(`BiquadFilterNode.type: 非法类型 "${v}"`);
    this._type = v;
  }
}
class MockStereoPanner extends MockAudioNode {
  constructor(ctx) { super(ctx, 'StereoPannerNode'); this.pan = new MockAudioParam('pan', 0); }
}
class MockDelay extends MockAudioNode {
  constructor(ctx, max) { super(ctx, 'DelayNode'); this.maxDelayTime = max; this.delayTime = new MockAudioParam('delayTime', 0); }
}
class MockConvolver extends MockAudioNode {
  constructor(ctx) { super(ctx, 'ConvolverNode'); this.buffer = null; this.normalize = true; }
}
class MockWaveShaper extends MockAudioNode {
  constructor(ctx) { super(ctx, 'WaveShaperNode'); this._curve = null; this.oversample = 'none'; }
  get curve() { return this._curve; }
  set curve(v) {
    if (v !== null) {
      if (!(v instanceof Float32Array)) throw new TypeError('WaveShaperNode.curve: 必须是 Float32Array');
      if (v.length < 2) throw new TypeError('WaveShaperNode.curve: 长度必须 >= 2');
      for (let i = 0; i < v.length; i++) {
        if (!Number.isFinite(v[i])) throw new TypeError(`WaveShaperNode.curve[${i}] 非有限值`);
      }
    }
    this._curve = v;
  }
}
class MockCompressor extends MockAudioNode {
  constructor(ctx) {
    super(ctx, 'DynamicsCompressorNode');
    this.threshold = new MockAudioParam('threshold', -24);
    this.knee = new MockAudioParam('knee', 30);
    this.ratio = new MockAudioParam('ratio', 12);
    this.attack = new MockAudioParam('attack', 0.003);
    this.release = new MockAudioParam('release', 0.25);
    this.reduction = 0;
  }
}
class MockAnalyser extends MockAudioNode {
  constructor(ctx) { super(ctx, 'AnalyserNode'); this.fftSize = 2048; this.smoothingTimeConstant = 0.8; this.minDecibels = -100; this.maxDecibels = -30; }
}
class MockChannelSplitter extends MockAudioNode {
  constructor(ctx, n) { super(ctx, 'ChannelSplitterNode'); this.numberOfOutputs = n; }
}
class MockChannelMerger extends MockAudioNode {
  constructor(ctx, n) { super(ctx, 'ChannelMergerNode'); this.numberOfInputs = n; }
}
class MockBufferSource extends MockScheduledSource {
  constructor(ctx) {
    super(ctx, 'AudioBufferSourceNode');
    this.buffer = null;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.playbackRate = new MockAudioParam('playbackRate', 1);
    this.detune = new MockAudioParam('detune', 0);
  }
}

class MockAudioBuffer {
  constructor(channels, length, sampleRate) {
    if (!Number.isFinite(length) || length <= 0) throw new RangeError(`createBuffer: 非法长度 ${length}`);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError(`createBuffer: 非法采样率 ${sampleRate}`);
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._data = [];
    for (let i = 0; i < channels; i++) this._data.push(new Float32Array(length));
  }
  getChannelData(i) {
    if (i < 0 || i >= this.numberOfChannels) throw new RangeError(`getChannelData: 非法声道 ${i}`);
    return this._data[i];
  }
}

class MockBaseContext {
  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.destination = new MockAudioNode(this, 'AudioDestinationNode');
    this._sources = [];
    this._nodes = [];
  }
  _mk(node) { this._nodes.push(node); return node; }
  createGain() { return this._mk(new MockGainNode(this)); }
  createOscillator() { return this._mk(new MockOscillator(this)); }
  createBiquadFilter() { return this._mk(new MockBiquadFilter(this)); }
  createStereoPanner() { return this._mk(new MockStereoPanner(this)); }
  createDelay(max = 1) { return this._mk(new MockDelay(this, max)); }
  createConvolver() { return this._mk(new MockConvolver(this)); }
  createWaveShaper() { return this._mk(new MockWaveShaper(this)); }
  createDynamicsCompressor() { return this._mk(new MockCompressor(this)); }
  createAnalyser() { return this._mk(new MockAnalyser(this)); }
  createChannelSplitter(n = 6) { return this._mk(new MockChannelSplitter(this, n)); }
  createChannelMerger(n = 6) { return this._mk(new MockChannelMerger(this, n)); }
  createBufferSource() { return this._mk(new MockBufferSource(this)); }
  createBuffer(ch, len, sr) { return new MockAudioBuffer(ch, len, sr); }
  createPeriodicWave(real, imag) {
    if (!(real instanceof Float32Array) || !(imag instanceof Float32Array)) {
      throw new TypeError('createPeriodicWave: 必须是 Float32Array');
    }
    if (real.length !== imag.length) throw new TypeError('createPeriodicWave: 实虚部长度不一致');
    return { real, imag, __periodic: true };
  }
}

class MockOfflineAudioContext extends MockBaseContext {
  constructor(channels, length, sampleRate) {
    super(sampleRate);
    this.numberOfChannels = channels;
    this.length = length;
  }
  async startRendering() {
    return new MockAudioBuffer(this.numberOfChannels, this.length, this.sampleRate);
  }
}

module.exports = {
  MockAudioParam,
  MockAudioNode,
  MockScheduledSource,
  MockBaseContext,
  MockOfflineAudioContext,
  MockAudioBuffer,
};
