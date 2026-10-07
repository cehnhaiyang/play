'use strict';
/**
 * 向后兼容冒烟测试。
 *
 * 这些片段是"旧版提示词"会产出的典型代码 —— 升级语法后它们必须仍然能编译，
 * 否则用户已经存下来的项目会在升级后突然跑不动。
 */
const { MockBaseContext } = require('./mockAudio');
const ROOT = './build';
const { SPGParser } = require(`${ROOT}/services/AudioService/audioEngine/parser`);
const { EventScheduler } = require(`${ROOT}/services/AudioService/audioEngine/scheduler`);
const { AudioSynthesizer } = require(`${ROOT}/services/AudioService/audioEngine/synthesizer`);

const parser = new SPGParser();
const scheduler = new EventScheduler();

/** 旧版提示词里的完整示例，一字不改 */
const LEGACY_EXAMPLE = `
config {
  tempo: 96
  master_gain: 0.7
}

define_instrument(name="pad") {
  preset: "strings_section"
  gain: 0.42
  pan: -0.35
  effect_chain { reverb(decay=3.5, mix=0.45, damping=4200) }
}

define_instrument(name="lead") {
  preset: "flute"
  gain: 0.62
  pan: 0.2
  effect_chain {
    delay(time="8n.", feedback=0.3, mix=0.22, damping=2400)
    reverb(decay=2.4, mix=0.3)
  }
}

define_instrument(name="low") {
  preset: "cello"
  gain: 0.68
  pan: 0.1
}

sequence(name="harmony", instrument="pad") {
  chord(["A3","C4","E4"], "1n")
  chord(["F3","A3","C4"], "1n")
  chord(["C4","E4","G4"], "1n")
  chord(["G3","B3","D4"], "1n")
}

sequence(name="melody", instrument="lead", humanize=0.25) {
  note("E5", "4n", velocity=0.85)
  note("A5", "8n.", velocity=1.0)
  note("G5", "8n", velocity=0.7)
  rest("8n")
  note("E5", "2n", velocity=0.9, gate=1.2)
}

sequence(name="bass", instrument="low") {
  note("A2", "2n")
  note("F2", "2n")
  note("C3", "2n")
  note("G2", "2n")
}

sequence(name="drums") {
  hit("kick", "2n")
  hit("hat", "4n", velocity=0.5)
  hit("snare", "2n", velocity=0.7)
  hit("hat", "4n", velocity=0.4)
}

effect_chain {
  eq(low=1.5, mid=0, high=1)
  compressor(threshold=-16, ratio=3, attack=0.02, release=0.3)
}

mix {
  track(source="drums",   time=0, loop=2)
  track(source="bass",    time=0, loop=2)
  track(source="harmony", time=0, loop=2)
  track(source="melody",  time=2, loop=1)
}
`;

/** 旧语法里各种等价写法，都应继续可用 */
const LEGACY_SNIPPETS = {
  '位置参数 note': `sequence(name="s"){ note("C4","4n") }`,
  'arp 用 chord= 数组': `sequence(name="s"){ arp(chord=["C4","E4","G4"], pattern="up", rate="16n", duration="1n") }`,
  'arp 具名和弦 + 位置 pattern/rate/duration': `sequence(name="s"){ arp(chord=["C4","E4"], "up", "16n", "1n") }`,
  'arp 位置参数': `sequence(name="s"){ arp(["C4","E4"], "up", "16n", "1n") }`,
  'chord 数组 + strum': `sequence(name="s"){ chord(["C4","E4"], "2n", strum=0.5) }`,
  'envelope 裸写': `define_instrument(name="a"){ envelope: adsr(0.01, 0.2, 0.6, 0.4) }\nsequence(name="s", instrument="a"){ note("C4","4n") }`,
  'envelope 带引号': `define_instrument(name="a"){ envelope: "adsr(0.01, 0.2, 0.6, 0.4)" }\nsequence(name="s", instrument="a"){ note("C4","4n") }`,
  'filter 带 sweep_to': `define_instrument(name="a"){ filter: "bandpass(1200, 1.5, sweep_to=6000)" }\nsequence(name="s", instrument="a"){ note("C4","4n") }`,
  'lfo 位置参数': `define_instrument(name="a"){ lfo: "sine(5, 10, frequency)" }\nsequence(name="s", instrument="a"){ note("C4","4n") }`,
  'config tempo': `config { tempo: 140 }\nsequence(name="s"){ note("C4","4n") }`,
  'config master_gain': `config { master_gain: 0.5 }\nsequence(name="s"){ note("C4","4n") }`,
  'mix stagger 卡农': `sequence(name="s"){ note("C4","4n") }\nmix { track(source="s", time=0, loop=3, stagger=0.25) }`,
  'mix pan/gain': `sequence(name="s"){ note("C4","4n") }\nmix { track(source="s", gain=0.8, pan=-0.4) }`,
  '无 mix 顺序播放': `sequence(name="a"){ note("C4","4n") }\nsequence(name="b"){ note("E4","4n") }`,
  '无乐器默认正弦': `sequence(name="s"){ note("C4","4n") }`,
  '噪声波形': `define_instrument(name="n"){ wave:"pink_noise" }\nsequence(name="s", instrument="n"){ note("C4","2n") }`,
  '自定义谐波': `define_instrument(name="h"){ harmonics: [1, 0.5, 0.33] }\nsequence(name="s", instrument="h"){ note("C4","4n") }`,
  '同名乐器 effect_chain 嵌套': `define_instrument(name="g"){ wave:"sawtooth"\n  effect_chain {\n    distortion(amount=0.5)\n  }\n}\nsequence(name="s", instrument="g"){ note("C4","4n") }`,
  '全效果器链': `sequence(name="s"){ note("C4","2n") }\neffect_chain {\n  delay(time=0.3, feedback=0.3, mix=0.3)\n  pingpong(time=0.3)\n  reverb(decay=2, mix=0.3)\n  distortion(amount=0.4)\n  overdrive(amount=0.2)\n  bitcrush(bits=8)\n  chorus(rate=1, depth=3, mix=0.4)\n  flanger(rate=0.3, feedback=0.5, mix=0.4)\n  phaser(rate=0.5, min=300, max=2000, mix=0.5)\n  tremolo(rate=5, depth=0.5)\n  compressor(threshold=-20, ratio=4)\n  filter(kind="lowpass", from=200, to=4000, duration=2, start=0)\n  eq(low=2, mid=-1, high=3)\n}`,
  '全部鼓组': `sequence(name="d"){ ${['kick','sub_kick','snare','rim','clap','hat','open_hat','pedal_hat','tom_low','tom_mid','tom_high','crash','ride','cowbell','shaker','tambourine'].map((n) => `hit("${n}","8n")`).join(' ')} }`,
  '中文注释': `# 中文注释\nsequence(name="s"){ note("C4","4n") # 行尾注释\n}`,
  '分号结尾': `sequence(name="s"){ note("C4","4n"); note("D4","4n"); }`,
  '同行连写': `sequence(name="s"){ hit("kick","4n") hit("hat","8n") hit("kick","4n") }`,
};

const render = (code) => {
  const parsed = parser.parse(code);
  const { events } = scheduler.schedule(
    parsed.sequences, parsed.instruments, parsed.mix, parsed.tempo, parsed.swing
  );
  const ctx = new MockBaseContext(44100);
  const synth = new AudioSynthesizer(ctx);
  synth.scheduleEvents(ctx, ctx.createGain(), events, parsed.effects, () => {});
  return { parsed, events, ctx };
};

let pass = 0;
const fails = [];

const tryOne = (name, code) => {
  try {
    const { events } = render(code);
    if (events.length === 0) throw new Error('没有产生任何事件');
    pass++;
  } catch (e) {
    fails.push({ name, message: e.message });
  }
};

const run = () => {
  tryOne('旧版完整示例', LEGACY_EXAMPLE);
  Object.entries(LEGACY_SNIPPETS).forEach(([name, code]) => tryOne(name, code));

  console.log(`向后兼容：通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) {
    for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
    return false;
  }
  return true;
};

module.exports = { run };
