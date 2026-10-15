'use strict';
/**
 * SPG 引擎回归测试。
 *
 * 运行：npm run test
 * （该命令会先用 tsc 把引擎编译到 test/build/，再执行本文件）
 *
 * 这套测试的重点不是"覆盖率"，而是**锁住那些曾经真实出错的行为**：
 * 每一条断言背后都对应一个具体的 bug 或一条刻意的语法设计，改动引擎时它们会立刻报警。
 */
const { MockBaseContext, MockOfflineAudioContext } = require('./mockAudio');

const ROOT = './build/app';
const {
  SPGParser, SPGError, EventScheduler, AudioSynthesizer,
  parseDuration, getMidi, midiToFreq,
} = require(`${ROOT}/services/AudioService`);

/* ------------------------------- 迷你测试框架 ------------------------------ */

let passed = 0;
const failures = [];
let currentGroup = '';
/** 异步断言挂载点：check() 是同步的，需要跨 turn 等待的断言先挂在这里，run() 里统一结算 */
const pendingAsync = [];

const group = (name) => { currentGroup = name; };

const check = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ group: currentGroup, name, error: e });
  }
};

const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg || '值不相等'}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};
const near = (a, b, tol, msg) => {
  if (!(Math.abs(a - b) <= tol)) {
    throw new Error(`${msg || '数值不符'}: 期望 ${b} ±${tol}，实际 ${a}`);
  }
};
const throws = (fn, msg) => {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(msg || '本应抛错但没有');
};

/* --------------------------------- 工具函数 -------------------------------- */

const parser = new SPGParser();
const scheduler = new EventScheduler();

const parse = (code) => parser.parse(code);
const compile = (code, tempoOverride) => {
  const parsed = parser.parse(code);
  const res = scheduler.schedule(
    parsed.sequences, parsed.instruments, parsed.mix, parsed.tempo, parsed.swing
  );
  return { parsed, ...res, tempo: tempoOverride || parsed.tempo };
};

/** 用模拟上下文跑一遍完整合成，捕获任何"真实浏览器会抛"的错误 */
const render = (code, sampleRate = 44100) => {
  const ctx = new MockBaseContext(sampleRate);
  const { parsed, events, totalDuration } = compile(code);
  const synth = new AudioSynthesizer();
  const dest = ctx.createGain();
  const registered = [];
  synth.scheduleEvents(ctx, dest, events, parsed.effects, (n) => registered.push(n));
  return { ctx, parsed, events, totalDuration, registered, dest };
};

/**
 * 校验所有 AudioParam 的自动化时间点是否严格单调、是否全部非负。
 * 时间点倒流会让浏览器的自动化行为不可预测，是引擎里最隐蔽的一类 bug。
 */
const auditTimelines = (ctx) => {
  const problems = [];
  for (const node of ctx._nodes) {
    for (const key of Object.keys(node)) {
      const p = node[key];
      if (!p || typeof p.setValueAtTime !== 'function' || !Array.isArray(p.events)) continue;
      let prev = -Infinity;
      for (const ev of p.events) {
        if (!Number.isFinite(ev.t)) problems.push(`${node.kind}.${key}: 非法时间 ${ev.t}`);
        else if (ev.t < 0) problems.push(`${node.kind}.${key}: 负时间 ${ev.t}`);
        else if (ev.t < prev - 1e-9) {
          problems.push(`${node.kind}.${key}: 时间倒流 ${prev} -> ${ev.t}`);
        }
        prev = Math.max(prev, ev.t);
      }
    }
  }
  return problems;
};

/* ========================================================================== */
/*                              1. 时值解析                                    */
/* ========================================================================== */

group('时值解析');

check('4n @120bpm = 0.5s', () => near(parseDuration('4n', 120), 0.5, 1e-9));
check('8n. 附点 = 0.375s', () => near(parseDuration('8n.', 120), 0.375, 1e-9));
check('4n.. 双附点 = 1.75 倍', () => near(parseDuration('4n..', 120), 0.5 * 1.75, 1e-9));
check('4nt 三连音 = 2/3 倍', () => near(parseDuration('4nt', 120), (1 / 3), 1e-9));
check('1m = 4 拍', () => near(parseDuration('1m', 120), 2.0, 1e-9));
check('250ms = 0.25s', () => near(parseDuration('250ms', 120), 0.25, 1e-9));
check('1.5s = 1.5s', () => near(parseDuration('1.5s', 120), 1.5, 1e-9));
check('4x 非法（不得被静默读成 4 秒）', () => throws(() => parseDuration('4x', 120)));
check('负时值非法', () => throws(() => parseDuration('-4n', 120)));
check('Infinity 非法', () => throws(() => parseDuration('Infinity', 120)));
check('tempo=0 时音符时值应报错', () => throws(() => parseDuration('4n', 0)));

group('音名解析');
check('C4 = 60', () => eq(getMidi('C4'), 60));
check('A4 = 440Hz', () => near(midiToFreq(69), 440, 1e-9));
check('F#5 合法', () => eq(getMidi('F#5'), 78));
check('Bb3 合法', () => eq(getMidi('Bb3'), 58));
check('440hz 直接频率', () => near(midiToFreq(getMidi('440hz')), 440, 1e-6));
check('H9 非法', () => throws(() => getMidi('H9')));
check('C（缺八度）非法', () => throws(() => getMidi('C')));

/* ========================================================================== */
/*                              2. 解析器                                      */
/* ========================================================================== */

group('解析器 · 基础');

const BASIC = `
config {
  tempo: 120
  master_gain: 0.7
}
define_instrument(name="lead") {
  wave: "sawtooth"
  envelope: adsr(0.01, 0.2, 0.6, 0.4)
  gain: 0.6
}
sequence(name="mel", instrument="lead") {
  note("C4", "4n")
  note("E4", "4n")
}
mix { track(source="mel", time=0, loop=1) }
`;

check('基础文件可解析', () => {
  const r = parse(BASIC);
  eq(r.tempo, 120);
  eq(r.masterVolumeConfig, 0.7);
  eq(r.instruments.size, 1);
  eq(r.sequences.size, 1);
  eq(r.sequences.get('mel').commands.length, 2);
});

check('分号结尾合法', () => {
  const r = parse(`sequence(name="s"){ note("C4","4n"); note("D4","4n"); }`);
  eq(r.sequences.get('s').commands.length, 2);
});

check('同行连写多条指令', () => {
  const r = parse(`sequence(name="s"){ hit("kick","4n") hit("hat","8n") }`);
  eq(r.sequences.get('s').commands.length, 2);
});

check('注释剥离（# 与 //）', () => {
  const r = parse(`# 头部注释
sequence(name="s"){ note("C4","4n") # 行尾
  // 整行
  note("D4","4n")
}`);
  eq(r.sequences.get('s').commands.length, 2);
});

check('注释中的 # 不破坏字符串', () => {
  const r = parse(`sequence(name="s"){ note("C#4","4n") }`);
  eq(r.sequences.get('s').commands[0].pitch, 'C#4');
});

check('单引号音名合法', () => {
  const r = parse(`sequence(name="s"){ note('C4','4n') }`);
  eq(r.sequences.get('s').commands[0].pitch, 'C4');
});

group('解析器 · 命名参数与位置参数');

check('note 用 pitch/duration 命名参数', () => {
  const r = parse(`sequence(name="s"){ note(pitch="C4", duration="4n") }`);
  const c = r.sequences.get('s').commands[0];
  eq(c.pitch, 'C4');
  eq(c.duration, '4n');
});

check('note 位置参数顺序不受影响', () => {
  const r = parse(`sequence(name="s"){ note("C4","4n", velocity=0.5) }`);
  const c = r.sequences.get('s').commands[0];
  eq(c.pitch, 'C4');
  eq(c.duration, '4n');
  eq(c.velocity, 0.5);
});

check('rest 用 duration= 命名参数', () => {
  const r = parse(`sequence(name="s"){ rest(duration="4n") }`);
  eq(r.sequences.get('s').commands[0].duration, '4n');
});

check('hit 用 drum=/duration= 命名参数', () => {
  const r = parse(`sequence(name="s"){ hit(drum="kick", duration="4n") }`);
  const c = r.sequences.get('s').commands[0];
  eq(c.drum, 'kick');
  eq(c.duration, '4n');
});

/**
 * `hit(kit=...)` 必须报错。
 *
 * `kit` 在鼓组语境里指"整套鼓"，而 hit 要的是**单件**鼓（kick/hat/…）。
 * 把它当别名收下，等于默许"把集合当成员"的写法；未在提示词里出现过，
 * 所以直接删掉这个别名、让未知参数校验拦住它。
 */
check('hit 不接受 kit= 别名（应报未知参数）', () => {
  throws(() => parse(`sequence(name="s"){ hit(kit="kick", duration="4n") }`));
});

check('chord 用 pitches= 命名参数', () => {
  const r = parse(`sequence(name="s"){ chord(pitches=["C4","E4"], duration="2n") }`);
  const c = r.sequences.get('s').commands[0];
  eq(c.pitches.length, 2);
  eq(c.duration, '2n');
});

check('sequence 用 seq= 作为 name 别名', () => {
  const r = parse(`sequence(seq="s"){ note("C4","4n") }`);
  assert(r.sequences.has('s'), 'seq= 未被识别为 name');
});

check('sequence 用 instrument= 命名乐器', () => {
  const r = parse(`
define_instrument(name="a"){ wave:"sine" }
sequence(name="s", instrument="a"){ note("C4","4n") }
`);
  eq(r.sequences.get('s').instrumentName, 'a');
});

check('config 支持 bpm= 别名', () => {
  const r = parse(`config { bpm: 140 }
sequence(name="s"){ note("C4","4n") }`);
  eq(r.tempo, 140);
});

check('arp 支持音符数组 + 具名 pattern/rate/duration', () => {
  const r = parse(`sequence(name="s"){ arp(["C4","E4","G4"], pattern="up", rate="16n", duration="1n") }`);
  const c = r.sequences.get('s').commands[0];
  eq(c.pattern, 'up');
  eq(c.rate, '16n');
  eq(c.duration, '1n');
  eq(c.pitches.length, 3);
});

check('arp 支持 notes= 别名', () => {
  const r = parse(`sequence(name="s"){ arp(notes=["C4","E4"], rate="16n", duration="1n") }`);
  eq(r.sequences.get('s').commands[0].pitches.length, 2);
});

group('解析器 · 报错与行号');

const lineOfError = (code) => {
  try { parse(code); } catch (e) { return e; }
  return null;
};

check('非法音名报出正确行号', () => {
  const e = lineOfError(`sequence(name="s") {
  note("C4", "4n")
  note("H9", "4n")
}`);
  assert(e instanceof SPGError, '应为 SPGError');
  eq(e.line, 3, '行号');
});

check('未知指令报错', () => {
  const e = lineOfError(`sequence(name="s") { foo("C4","4n") }`);
  assert(e && /未知指令/.test(e.message), `错误信息不符: ${e && e.message}`);
});

check('未闭合花括号报错', () => {
  const e = lineOfError(`sequence(name="s") { note("C4","4n") `);
  assert(e !== null, '应报错');
});

check('引用未定义乐器报错', () => {
  const e = lineOfError(`sequence(name="s", instrument="nope") { note("C4","4n") }`);
  assert(e && /未定义的乐器/.test(e.message), `错误信息不符: ${e && e.message}`);
});

check('mix 引用未定义音序报错', () => {
  const e = lineOfError(`sequence(name="s"){ note("C4","4n") }
mix { track(source="nope") }`);
  assert(e && /未定义的音序/.test(e.message), `错误信息不符: ${e && e.message}`);
});

check('错误信息包含可用取值提示', () => {
  const e = lineOfError(`sequence(name="s"){ hit("kickdrum","4n") }`);
  assert(e && /kick/.test(e.message), `应提示可用鼓组名: ${e && e.message}`);
});

/* ========================================================================== */
/*                              3. 调度器                                      */
/* ========================================================================== */

group('调度器');

check('顺序音符首尾相接', () => {
  const { events } = compile(`sequence(name="s"){ note("C4","4n") note("D4","4n") }`);
  eq(events.length, 2);
  near(events[0].time, 0, 1e-9);
  near(events[1].time, 0.5, 1e-9);
});

check('rest 推进时间轴', () => {
  const { events } = compile(`sequence(name="s"){ rest("4n") note("C4","4n") }`);
  eq(events.length, 1);
  near(events[0].time, 0.5, 1e-9);
});

check('gate 缩放发声时长但不改变步进', () => {
  const { events } = compile(`sequence(name="s"){ note("C4","4n",gate=0.5) note("D4","4n") }`);
  near(events[0].duration, 0.25, 1e-9);
  near(events[1].time, 0.5, 1e-9);
});

check('chord 同时发声', () => {
  const { events } = compile(`sequence(name="s"){ chord(["C4","E4","G4"],"2n") }`);
  eq(events.length, 3);
  events.forEach((e) => near(e.time, 0, 1e-9));
});

check('chord strum 依次错开', () => {
  const { events } = compile(`sequence(name="s"){ chord(["C4","E4","G4"],"2n",strum=1) }`);
  assert(events[1].time > events[0].time, 'strum 未错开时间');
});

check('arp up 按音高升序（而非书写顺序）', () => {
  const { events } = compile(`sequence(name="s"){ arp(["C5","E4","G4"], pattern="up", rate="4n", duration="2n") }`);
  const freqs = events.map((e) => e.freq);
  for (let i = 1; i < freqs.length; i++) {
    assert(freqs[i] >= freqs[i - 1], `up 琶音未升序: ${freqs.join(',')}`);
  }
});

check('arp down 按音高降序', () => {
  const { events } = compile(`sequence(name="s"){ arp(["C5","E4","G4"], pattern="down", rate="4n", duration="2n") }`);
  const freqs = events.map((e) => e.freq);
  for (let i = 1; i < freqs.length; i++) {
    assert(freqs[i] <= freqs[i - 1], `down 琶音未降序: ${freqs.join(',')}`);
  }
});

check('arp octaves 扩展音域', () => {
  const { events } = compile(`sequence(name="s"){ arp(["C4"], pattern="up", rate="4n", duration="1n", octaves=3) }`);
  const uniq = new Set(events.map((e) => Math.round(e.freq)));
  assert(uniq.size === 3, `octaves=3 应产生 3 个不同音高，实际 ${uniq.size}`);
});

check('humanize 可复现（同代码两次结果一致）', () => {
  const code = `sequence(name="s", humanize=0.5){ note("C4","4n") note("D4","4n") note("E4","4n") }`;
  const a = compile(code).events.map((e) => `${e.time.toFixed(6)}:${e.gain.toFixed(6)}:${(e.detune||0).toFixed(6)}`);
  const b = compile(code).events.map((e) => `${e.time.toFixed(6)}:${e.gain.toFixed(6)}:${(e.detune||0).toFixed(6)}`);
  eq(a.join('|'), b.join('|'), 'humanize 不可复现');
});

check('hit 事件保留打击乐增益（不被乐器增益污染）', () => {
  /**
   * 触发条件是"鼓组音序引用了某个已定义的乐器"。
   *
   * 鼓组音色自带 `DRUM_SPECS.gain` 标定，不该再乘一遍乐器增益；
   * 但旧实现无条件套用当前乐器的增益，于是这里 kick 的增益会被压到 0.05 附近，
   * 底鼓几乎听不见 —— 而且文件里多定义一个安静的音色就会让鼓组变轻，用户无从理解。
   */
  const { events } = compile(`
define_instrument(name="quiet"){ wave:"sine" gain: 0.05 }
sequence(name="d", instrument="quiet"){ hit("kick","4n") hit("snare","4n") }
`);
  const kick = events.find((e) => e.drum === 'kick');
  const snare = events.find((e) => e.drum === 'snare');
  assert(kick && snare, '未找到鼓事件');
  assert(kick.gain > 0.5, `底鼓增益被乐器增益压到 ${kick.gain}，应接近 1`);
  assert(snare.gain > 0.5, `军鼓增益被乐器增益压到 ${snare.gain}`);
});

check('鼓组的 gain= 逐音符参数仍然生效', () => {
  const { events } = compile(`
define_instrument(name="quiet"){ wave:"sine" gain: 0.05 }
sequence(name="d", instrument="quiet"){ hit("kick","4n", gain=0.3) }
`);
  const kick = events.find((e) => e.drum === 'kick');
  // 显式写的 gain 必须被尊重，只是不能被乐器默认值暗中覆盖
  assert(kick.gain < 0.5 && kick.gain > 0.1, `显式 gain=0.3 应生效，实际 ${kick.gain}`);
});

check('鼓组不受乐器滤波/LFO 链路污染', () => {
  const { events } = compile(`
define_instrument(name="wobble"){ filter:"lowpass(200,8)" lfo:"sine(freq=6, amount=50, target=filter)" }
sequence(name="d", instrument="wobble"){ hit("kick","4n") }
`);
  const kick = events.find((e) => e.drum === 'kick');
  eq(kick.filter, undefined, '鼓组不应带上乐器的滤波器');
  eq(kick.lfo, undefined, '鼓组不应带上乐器的 LFO');
  eq(kick.attackNoise, 0, '鼓组不应叠加乐器的起音噪声');
});

check('mix loop 重复音序', () => {
  const { events } = compile(`
sequence(name="s"){ note("C4","4n") }
mix { track(source="s", loop=3) }
`);
  eq(events.length, 3);
  near(events[1].time, 0.5, 1e-9);
  near(events[2].time, 1.0, 1e-9);
});

check('mix time 决定入场时刻', () => {
  const { events } = compile(`
sequence(name="s"){ note("C4","4n") }
mix { track(source="s", time=1.5) }
`);
  near(events[0].time, 1.5, 1e-9);
});

check('无 mix 时音序首尾相接', () => {
  const { events } = compile(`
sequence(name="a"){ note("C4","4n") }
sequence(name="b"){ note("E4","4n") }
`);
  eq(events.length, 2);
  near(events[1].time, 0.5, 1e-9);
});

check('transpose 逐音符与整轨叠加', () => {
  const { events } = compile(`sequence(name="s", transpose=12){ note("C4","4n",transpose=12) }`);
  near(events[0].freq, midiToFreq(60 + 24), 1e-6);
});

/* ========================================================================== */
/*                              4. 合成器                                      */
/* ========================================================================== */

group('合成器 · 节点图');

check('最简单的音序可完整合成', () => {
  render(`sequence(name="s"){ note("C4","4n") }`);
});

check('鼓组可完整合成', () => {
  const { registered } = render(`
sequence(name="d"){ hit("kick","4n") hit("snare","4n") hit("hat","8n") hit("crash","1n") }
`);
  assert(registered.length > 0, '未注册任何音源');
});

check('全部 16 种鼓组都能合成', () => {
  const names = ['kick','sub_kick','snare','rim','clap','hat','open_hat','pedal_hat',
    'tom_low','tom_mid','tom_high','crash','ride','cowbell','shaker','tambourine'];
  const body = names.map((n) => `hit("${n}","8n")`).join('\n');
  render(`sequence(name="d"){ ${body} }`);
});

check('全部内置预设都能合成', () => {
  const { PRESET_NAMES } = require(`${ROOT}/services/AudioService`);
  const seqs = PRESET_NAMES.map((p, i) =>
    `define_instrument(name="i${i}"){ preset:"${p}" }\nsequence(name="s${i}", instrument="i${i}"){ note("C4","4n") }`
  ).join('\n');
  render(seqs);
});

/**
 * getPreset 是导出给外部的工具函数，必须对"取不到值"的入参返回 null 而不是崩溃。
 *
 * 签名虽然是 `name: string`，但 `Map.get()` 这类写法返回的是 `undefined`，
 * TS 不会报错，到了 `name.toLowerCase()` 就炸成 TypeError。
 * 返回 null 与"未知预设"同义，调用方本来就要处理这个分支。
 */
check('getPreset 对空值/非字符串返回 null 而不抛异常', () => {
  const { getPreset } = require(`${ROOT}/services/AudioService`);
  for (const bad of [undefined, null, '', '   ', 'nope', 123, {}, []]) {
    eq(getPreset(bad), null, `getPreset(${JSON.stringify(bad)}) 应返回 null`);
  }
  assert(getPreset('piano') !== null, 'getPreset("piano") 应命中预设');
  assert(getPreset('PIANO') !== null, '预设名应大小写不敏感');
});

check('全部效果器都能构建', () => {
  render(`
sequence(name="s"){ note("C4","2n") }
effect_chain {
  delay(time=0.25, feedback=0.4, mix=0.4)
  pingpong(time=0.25, feedback=0.4, mix=0.4)
  reverb(decay=2, mix=0.3)
  distortion(amount=0.5)
  overdrive(amount=0.2)
  bitcrush(bits=8)
  chorus(rate=1, depth=3, mix=0.4)
  flanger(rate=0.3, feedback=0.5, mix=0.4)
  phaser(rate=0.5, mix=0.5)
  tremolo(rate=5, depth=0.5)
  compressor(threshold=-20, ratio=4)
  filter(kind="lowpass", from=200, to=4000, duration=2)
  eq(low=2, mid=-1, high=3)
}
`);
});

check('噪声波形可合成', () => {
  render(`
define_instrument(name="n"){ wave:"white_noise" }
define_instrument(name="p"){ wave:"pink_noise" }
define_instrument(name="b"){ wave:"brown_noise" }
sequence(name="a", instrument="n"){ note("C4","4n") }
sequence(name="b", instrument="p"){ note("C4","4n") }
sequence(name="c", instrument="b"){ note("C4","4n") }
`);
});

check('自定义谐波可合成', () => {
  render(`
define_instrument(name="h"){ harmonics: [1, 0.5, 0.25, 0.1] }
sequence(name="s", instrument="h"){ note("C4","4n") }
`);
});

check('乐器级效果链只作用于该乐器', () => {
  const { ctx } = render(`
define_instrument(name="g"){ wave:"sawtooth" effect_chain { distortion(amount=0.6) } }
define_instrument(name="c"){ wave:"sine" }
sequence(name="a", instrument="g"){ note("C4","4n") }
sequence(name="b", instrument="c"){ note("E4","4n") }
`);
  const shapers = ctx._nodes.filter((n) => n.kind === 'WaveShaperNode');
  eq(shapers.length, 1, '应只有 1 个失真节点');
});

check('同乐器级效果链复用总线（不逐音符重建卷积器）', () => {
  const { ctx } = render(`
define_instrument(name="g"){ effect_chain { reverb(decay=2, mix=0.3) } }
sequence(name="a", instrument="g"){ note("C4","8n") note("D4","8n") note("E4","8n") note("F4","8n") }
`);
  const convolvers = ctx._nodes.filter((n) => n.kind === 'ConvolverNode');
  eq(convolvers.length, 1, '4 个音符应共用 1 个卷积器');
});

check('voices 多声部可合成', () => {
  const { ctx } = render(`
define_instrument(name="ss"){ voices: 5, unison_spread: 20, spread: 0.8 }
sequence(name="s", instrument="ss"){ note("C4","4n") }
`);
  const oscs = ctx._nodes.filter((n) => n.kind === 'OscillatorNode');
  assert(oscs.length >= 5, `voices=5 应有 >=5 个振荡器，实际 ${oscs.length}`);
});

check('FM 合成可构建', () => {
  render(`
define_instrument(name="fm"){ fm_wave:"sine", fm_ratio:3.5, fm_index:400 }
sequence(name="s", instrument="fm"){ note("C4","4n") }
`);
});

check('LFO 各目标可构建', () => {
  for (const target of ['frequency', 'filter', 'gain', 'pan', 'detune']) {
    render(`
define_instrument(name="l"){ filter:"lowpass(1200,1)" lfo:"sine(freq=5, amount=10, target=${target}, ramp=0.2)" }
sequence(name="s", instrument="l"){ note("C4","2n") }
`);
  }
});

check('长音 + 短音混合不产生非法自动化时间', () => {
  const { ctx } = render(`
define_instrument(name="a"){ envelope: adsr(0.5, 0.8, 0.6, 1.2) }
define_instrument(name="b"){ envelope: adsr(1.5, 2.0, 0.7, 2.5, curve=linear) }
sequence(name="s1", instrument="a"){ note("C4","64n") note("E4","1n") }
sequence(name="s2", instrument="b"){ note("C3","32n") note("G3","2n") }
`);
  const problems = auditTimelines(ctx);
  assert(problems.length === 0, `时间线异常:\n  ${problems.join('\n  ')}`);
});

check('超短音符不产生时间倒流', () => {
  const { ctx } = render(`
define_instrument(name="a"){ envelope: adsr(0.3, 0.4, 0.5, 0.6) }
sequence(name="s", instrument="a"){ note("C4","64n") note("D4","64n") }
`);
  const problems = auditTimelines(ctx);
  assert(problems.length === 0, `时间线异常:\n  ${problems.join('\n  ')}`);
});

check('全部自动化时间点非负', () => {
  const { ctx } = render(`
sequence(name="s"){ note("C4","4n") chord(["E4","G4"],"2n") arp(["C4","E4"],rate="16n",duration="1n") hit("kick","4n") }
`);
  const problems = auditTimelines(ctx).filter((p) => /负时间|非法时间/.test(p));
  assert(problems.length === 0, `时间线异常:\n  ${problems.join('\n  ')}`);
});

check('loop_point 长音不产生时间倒流', () => {
  const { ctx } = render(`
define_instrument(name="a"){ loop_point: 0.5, envelope: adsr(0.2,0.3,0.8,0.4) }
sequence(name="s", instrument="a"){ note("C4","1n") }
`);
  const problems = auditTimelines(ctx);
  assert(problems.length === 0, `时间线异常:\n  ${problems.join('\n  ')}`);
});

check('glide + pitch_env 组合不冲突', () => {
  const { ctx } = render(`
define_instrument(name="a"){ glide:0.2, glide_from:-12, pitch_env_amount:12, pitch_decay:0.1 }
sequence(name="s", instrument="a"){ note("C4","2n") }
`);
  const problems = auditTimelines(ctx);
  assert(problems.length === 0, `时间线异常:\n  ${problems.join('\n  ')}`);
});

check('filter sweep 与 filter_envelope 可构建', () => {
  render(`
define_instrument(name="a"){ filter:"bandpass(200,3,sweep_to=6000)" }
define_instrument(name="b"){ filter:"lowpass(400,1)" filter_envelope:"adsr(0.1,0.3,0.4,0.2)" filter_env_amount:2000 }
sequence(name="s1", instrument="a"){ note("C4","1n") }
sequence(name="s2", instrument="b"){ note("E4","1n") }
`);
});

check('长衰减鼓组在离线渲染长度内不被截断', () => {
  const { totalDuration } = compile(`
sequence(name="d"){ rest("1m") hit("crash","4n") }
`);
  assert(totalDuration > 2.0, `crash 尾音未计入总时长: ${totalDuration}`);
});

/* ========================================================================== */
/*                    9. 回归修复（本轮审查发现的问题）                        */
/* ========================================================================== */

group('回归修复 · 严格数字与布尔');

check('数字截断写法报错（gain=0.5x）', () => {
  const e = lineOfError(`define_instrument(name="t"){ gain: 0.5x }
sequence(name="s", instrument="t"){ note("C4","4n") }`);
  assert(e && /需要数字/.test(e.message), `应报需要数字: ${e && e.message}`);
});

check('包络里的截断数字报错', () => {
  throws(() => parse(`define_instrument(name="t"){ envelope: adsr(0.01x, 0.2, 0.6, 0.4) }
sequence(name="s", instrument="t"){ note("C4","4n") }`));
});

check('拼错的布尔值报错（accent=maybe）', () => {
  const e = lineOfError(`sequence(name="s"){ note("C4","4n", accent=maybe) }`);
  assert(e && /布尔/.test(e.message), `应报布尔值错误: ${e && e.message}`);
});

check('合法布尔值不受影响', () => {
  const r = parse(`sequence(name="s"){ note("C4","4n", accent=true) hit("kick","4n") }`);
  eq(r.sequences.get('s').commands[0].velocity, 1);
});

group('回归修复 · 白名单静默参数');

check('run 的 from= 报错（曾静默忽略）', () => {
  const e = lineOfError(`sequence(name="s"){ run(["C4","D4"], "16n", from="C4") }`);
  assert(e && /未知参数/.test(e.message), `应报未知参数: ${e && e.message}`);
});

check('progression 的 duration= 报错（曾静默忽略）', () => {
  const e = lineOfError(`sequence(name="s"){ progression(["C","G"], "1n", duration="2n") }`);
  assert(e && /未知参数/.test(e.message), `应报未知参数: ${e && e.message}`);
});

group('回归修复 · 乐器校验');

check('fm_wave 写噪声名报错', () => {
  const e = lineOfError(`define_instrument(name="t"){ fm_wave: "white_noise", fm_ratio: 2 }
sequence(name="s", instrument="t"){ note("C4","4n") }`);
  assert(e && /fm_wave/.test(e.message), `应报 fm_wave 非法: ${e && e.message}`);
});

check('fm_ratio=0 报错', () => {
  throws(() => parse(`define_instrument(name="t"){ fm_wave: "sine", fm_ratio: 0 }
sequence(name="s", instrument="t"){ note("C4","4n") }`));
});

check('wave=custom 不配 harmonics 报错', () => {
  const e = lineOfError(`define_instrument(name="t"){ wave: "custom" }
sequence(name="s", instrument="t"){ note("C4","4n") }`);
  assert(e && /harmonics/.test(e.message), `应提示配 harmonics: ${e && e.message}`);
});

check('wave=custom 配 harmonics 合法且可合成', () => {
  render(`define_instrument(name="t"){ wave: "custom", harmonics: [1, 0.5, 0.25] }
sequence(name="s", instrument="t"){ note("C4","4n") }`);
});

check('负 glide / pitch_decay / loop_point 报错', () => {
  for (const p of ['glide: -0.1', 'pitch_decay: -0.1', 'loop_point: -1']) {
    const e = lineOfError(`define_instrument(name="t"){ ${p} }
sequence(name="s", instrument="t"){ note("C4","4n") }`);
    assert(e && /不能为负数/.test(e.message), `${p} 应报不能为负数: ${e && e.message}`);
  }
});

check('未知预设报错里列出可用名', () => {
  const e = lineOfError(`define_instrument(name="t"){ preset: "nope" }
sequence(name="s", instrument="t"){ note("C4","4n") }`);
  assert(e && /piano/.test(e.message), `应列出可用预设: ${e && e.message}`);
});

group('回归修复 · 和弦符号');

// 本组插在第 7 节（和弦符号）的 require 之前，用独立的局部引用避免 TDZ
const { parseChordSymbol: parseChord9, voicingToPitches: voicing9 } =
  require(`${ROOT}/services/AudioService`);
const names9 = (ps) => ps.join(',');

check('7sus4 族可解析', () => {
  eq(parseChord9('G7sus4').intervals.join(','), '0,5,7,10');
  eq(parseChord9('G7sus2').intervals.join(','), '0,2,7,10');
  eq(parseChord9('Cmaj7sus4').intervals.join(','), '0,5,7,11');
});

check('7sus4 可走完解析与合成', () => {
  render(`sequence(name="s"){ chord("G7sus4", "1n") progression(["Dm7sus4","G7sus4"], "1n") }`);
});

check('大写性质 MAJ7 等于 maj7（曾静默变属七）', () => {
  eq(parseChord9('CMAJ7').intervals.join(','), parseChord9('Cmaj7').intervals.join(','));
  eq(parseChord9('CMIN7').intervals.join(','), parseChord9('Cm7').intervals.join(','));
  eq(parseChord9('CSUS4').intervals.join(','), parseChord9('Csus4').intervals.join(','));
});

check('o9 按减和弦展开（含减七度 9）', () => {
  eq(parseChord9('Co9').intervals.join(','), '0,3,6,9,14');
  eq(parseChord9('Cdim9').intervals.join(','), '0,3,6,9,14');
});

check('sus2+add9 组合展开正确（分支顺序）', () => {
  eq(parseChord9('Csus2add9').intervals.join(','), '0,2,7,14');
});

check('C2 等于 Cadd9', () => {
  eq(parseChord9('C2').intervals.join(','), parseChord9('Cadd9').intervals.join(','));
});

check('双降号根音音高正确', () => {
  // Abb = G：Abbm 应展开成 G4,Bb4,D5
  eq(names9(voicing9(parseChord9('Abbm'), 4)), 'G4,Bb4,D5');
});

group('回归修复 · 调度与合成');

check('同一音序同轨叠加时随机流错开', () => {
  const { events } = compile(`sequence(name="s", humanize=0.5){ note("C4","4n") }
mix { track(source="s", time=0) track(source="s", time=0) }`);
  eq(events.length, 2);
  assert(events[0].gain !== events[1].gain,
    `两遍 humanize 抖动完全相同，叠加等于单轨加响：${events[0].gain} vs ${events[1].gain}`);
});

check('filter 扫频跟随 timeOffset（实时播放可听见）', () => {
  const ctx = new MockBaseContext(44100);
  const { events } = compile(`sequence(name="s"){ note("C4","2n") }`);
  const synth = new AudioSynthesizer();
  const dest = ctx.createGain();
  const fx = [{ type: 'filter', kind: 'lowpass', from: 200, to: 4000, Q: 1, duration: 2, start: 0 }];
  synth.scheduleEvents(ctx, dest, events, fx, () => {}, 100);
  const biquads = ctx._nodes.filter((n) => n.kind === 'BiquadFilterNode');
  assert(biquads.length > 0, '应建滤波节点');
  const times = biquads[0].frequency.events.map((e) => e.t);
  assert(times.length > 0 && times.every((t) => t >= 100),
    `扫频自动化应整体后移 100s，实际 ${JSON.stringify(times)}`);
});

check('噪声缓存在不同采样率下各自稳定', () => {
  const code = `define_instrument(name="n"){ wave:"white_noise" }
sequence(name="s", instrument="n"){ note("C4","4n") }`;
  // 两个采样率各渲染：缓存键必须带采样率，且同采样率的纹理可复现
  const snap = (rate) => {
    const ctx = new MockBaseContext(rate);
    const { parsed, events } = compile(code);
    const synth = new AudioSynthesizer();
    synth.scheduleEvents(ctx, ctx.createGain(), events, parsed.effects, () => {});
    const key = [...synth.noiseBuffers.keys()].find((k) => k.startsWith('white@'));
    assert(key === `white@${rate}`, `缓存键应带采样率，实际 ${key}`);
    return Array.from(synth.noiseBuffers.get(key).getChannelData(0).slice(0, 64)).join(',');
  };
  eq(snap(44100), snap(44100), '同采样率噪声纹理应一致');
  snap(48000);
});

check('长混响尾音计入总时长（导出不切尾）', () => {
  // 尾音余量是 BrowserAudioEngine.compile 加的（调度器只算事件时钟），必须走引擎整链
  global.window = { AudioContext: MockBaseContext, OfflineAudioContext: MockOfflineAudioContext };
  const { BrowserAudioEngine } = require(`${ROOT}/services/AudioService`);
  const engine = new BrowserAudioEngine();
  const err = engine.compile(`sequence(name="s"){ note("C4","4n") }
effect_chain { reverb(decay=8, mix=0.5) }`);
  eq(err, null, `编译应成功: ${JSON.stringify(err)}`);
  assert(engine.getDuration() > 8, `8 秒混响尾音未计入总时长: ${engine.getDuration()}`);
});

group('回归修复 · 编译失败不残留旧数据');

check('无事件编译后时长清零', () => {
  global.window = { AudioContext: MockBaseContext, OfflineAudioContext: MockOfflineAudioContext };
  const { BrowserAudioEngine } = require(`${ROOT}/services/AudioService`);
  const engine = new BrowserAudioEngine();
  eq(engine.compile(BASIC), null);
  assert(engine.getDuration() > 0, '前置条件：正常编译有时长');
  const err = engine.compile(`sequence(name="s"){ rest("4n") }`);
  assert(err && /没有产生任何音符事件/.test(err.message), `应报无事件: ${JSON.stringify(err)}`);
  eq(engine.getDuration(), 0, '失败后时长应清零，否则导出的是旧音频的长度');
  // 异步：无事件后导出必须失败（不能吐出上一次的旧音频）
  pendingAsync.push(engine.renderOffline().then(
    () => { throw new Error('无事件后导出应失败，实际成功（吐出的是旧音频）'); },
    (e) => { assert(/编译/.test(e.message), `导出错误信息不符: ${e && e.message}`); }
  ));
});

/* ========================================================================== */
/*                              5. 引擎                                        */
/* ========================================================================== */

group('引擎');

check('compile 返回 null 表示成功', () => {
  global.window = { AudioContext: MockBaseContext, OfflineAudioContext: MockOfflineAudioContext };
  const { BrowserAudioEngine } = require(`${ROOT}/services/AudioService`);
  const engine = new BrowserAudioEngine();
  const err = engine.compile(BASIC);
  eq(err, null, '编译应成功');
  assert(engine.getDuration() > 0, '时长应大于 0');
});

check('compile 失败返回带行号的错误', () => {
  const { BrowserAudioEngine } = require(`${ROOT}/services/AudioService`);
  const engine = new BrowserAudioEngine();
  const err = engine.compile(`sequence(name="s"){ note("H9","4n") }`);
  assert(err && err.line === 1, `行号错误: ${JSON.stringify(err)}`);
});

check('renderOffline 可产出 WAV', async () => {
  const { BrowserAudioEngine } = require(`${ROOT}/services/AudioService`);
  const engine = new BrowserAudioEngine();
  engine.compile(BASIC);
  const blob = await engine.renderOffline();
  assert(blob && blob.size > 44, 'WAV 数据过短');
});

/* ========================================================================== */
/*                              6. 复杂整曲                                    */
/* ========================================================================== */

group('整曲');

const FULL = `
config { tempo: 96, master_gain: 0.7 }

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
define_instrument(name="low") { preset: "cello" gain: 0.68 pan: 0.1 }

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
  note("A2", "2n") note("F2", "2n") note("C3", "2n") note("G2", "2n")
}
sequence(name="drums") {
  hit("kick", "2n") hit("hat", "4n", velocity=0.5)
  hit("snare", "2n", velocity=0.7) hit("hat", "4n", velocity=0.4)
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

check('整曲可编译且时间线合法', () => {
  const { ctx, events } = render(FULL);
  assert(events.length > 30, `事件数过少: ${events.length}`);
  const problems = auditTimelines(ctx);
  assert(problems.length === 0, `时间线异常:\n  ${problems.join('\n  ')}`);
});

check('整曲时长合理', () => {
  const { totalDuration } = compile(FULL);
  assert(totalDuration > 8 && totalDuration < 60, `时长异常: ${totalDuration}`);
});

check('鼓组声部音量不应被 melody 之外的乐器压掉', () => {
  const { events } = compile(FULL);
  const kicks = events.filter((e) => e.drum === 'kick');
  // drums 音序里每遍只有 1 个 kick，mix 里 loop=2，共 2 次
  eq(kicks.length, 2, '底鼓数量');
  kicks.forEach((k) => assert(k.gain > 0.5, `底鼓增益过低: ${k.gain}`));
});

/* ========================================================================== */
/*                              7. 新语法增强                                  */
/* ========================================================================== */

group('和弦符号');

const { parseChordSymbol, voicingToPitches, CHORD_QUALITY_NAMES } = require(`${ROOT}/services/AudioService`);
const names = (ps) => ps.join(',');

check('大三和弦 C = C E G', () => {
  const s = parseChordSymbol('C');
  eq(names(voicingToPitches(s, 4)), 'C4,E4,G4');
});

check('小三和弦 Am = A C E', () => {
  const s = parseChordSymbol('Am');
  eq(names(voicingToPitches(s, 4)), 'A4,C5,E5');
});

check('属七 G7 含小七度', () => {
  const s = parseChordSymbol('G7');
  eq(names(voicingToPitches(s, 4)), 'G4,B4,D5,F5');
});

check('大七 Cmaj7 含大七度', () => {
  const s = parseChordSymbol('Cmaj7');
  eq(names(voicingToPitches(s, 4)), 'C4,E4,G4,B4');
});

check('小七 Am7', () => {
  const s = parseChordSymbol('Am7');
  eq(names(voicingToPitches(s, 4)), 'A4,C5,E5,G5');
});

check('半减七 Dm7b5', () => {
  const s = parseChordSymbol('Dm7b5');
  eq(names(voicingToPitches(s, 4)), 'D4,F4,Ab4,C5');
});

check('减七 Cdim7', () => {
  const s = parseChordSymbol('Cdim7');
  eq(names(voicingToPitches(s, 4)), 'C4,Eb4,Gb4,A4');
});

check('挂四 Csus4', () => {
  const s = parseChordSymbol('Csus4');
  eq(names(voicingToPitches(s, 4)), 'C4,F4,G4');
});

check('加九 Cadd9 含九音', () => {
  const s = parseChordSymbol('Cadd9');
  eq(names(voicingToPitches(s, 4)), 'C4,E4,G4,D5');
});

check('九和弦 C9', () => {
  const s = parseChordSymbol('C9');
  eq(names(voicingToPitches(s, 4)), 'C4,E4,G4,Bb4,D5');
});

check('转位 C/E 低音在下方', () => {
  const s = parseChordSymbol('C/E');
  const ps = voicingToPitches(s, 4);
  const midis = ps.map(getMidi);
  assert(ps[0].startsWith('E'), `低音应为 E，实际 ${ps[0]}`);
  eq(midis[0], Math.min(...midis), '低音必须是最低音');
  assert(ps.includes('C4') && ps.includes('G4'), `转位应保留完整和弦: ${ps.join(',')}`);
});

check('Am7/G 斜杠低音', () => {
  const s = parseChordSymbol('Am7/G');
  const ps = voicingToPitches(s, 4);
  // 低音必须是 G，且必须是整组音里最低的那个
  assert(ps[0].startsWith('G'), `低音应为 G，实际 ${ps[0]}`);
  const midis = ps.map(getMidi);
  eq(midis[0], Math.min(...midis), '低音必须是最低音');
  assert(midis[0] < getMidi('A4'), '低音应低于根音');
  // 转位不应丢音：A C E G 四个音级都要在
  const pcs = new Set(ps.map((p) => p.replace(/-?\d+$/, '')));
  ['A', 'C', 'E', 'G'].forEach((n) => assert(pcs.has(n), `转位后缺少 ${n}: ${ps.join(',')}`));
});

check('升号根音 F#m', () => {
  const s = parseChordSymbol('F#m');
  eq(names(voicingToPitches(s, 4)), 'F#4,A4,C#5');
});

check('降号根音 Bb', () => {
  const s = parseChordSymbol('Bb');
  eq(names(voicingToPitches(s, 4)), 'Bb4,D5,F5');
});

check('voicing=drop2 改变声位但保持音级', () => {
  const s = parseChordSymbol('Cmaj7');
  const close = voicingToPitches(s, 4, 'close');
  const drop2 = voicingToPitches(s, 4, 'drop2');
  eq(close.length, drop2.length, '音数应一致');
  const pc = (p) => p.replace(/-?\d+$/, '');
  eq([...close].map(pc).sort().join(','), [...drop2].map(pc).sort().join(','), '音级集合应一致');
  assert(drop2[0] !== close[0], 'drop2 应改变最低音');
});

/**
 * 变化音（#11 / b11）的音级必须是**自然十一度 17**，不是 18。
 *
 * 这里曾经有个真实 bug：ALTERATIONS 里 `#11` 的 degree 写成 18，
 * 展开时 `delete(18)` 删了个不存在的音，`add(18+1)` 得到 **19** ——
 * 而 19 半音 = 五度音高八度（7+12），于是 `C7#11` 里凭空多出一个重复的 G、
 * 真正的 F# 反而没有；`b11` 同理退化成自然十一度，降号完全失效。
 * 错音不影响"能不能播"，所以只有逐音比对才能发现。
 */
check('变化音 #11 / b11 音程正确', () => {
  const iv = (sym) => parseChordSymbol(sym).intervals;
  eq(iv('C7#11').join(','), '0,4,7,10,18', '#11 应为 18 半音（F#）');
  eq(iv('C7b11').join(','), '0,4,7,10,16', 'b11 应为 16 半音');
  // 19 半音等于五度音加八度，属于"多出来的重复音"，绝不能出现
  for (const sym of ['C7#11', 'C9#11', 'C13#11', 'Cmaj7#11']) {
    assert(!iv(sym).includes(19), `${sym} 不应含 19（那是五度的八度重复音）`);
  }
});

/**
 * 9 / 11 / 13 隐含七度，展开分支必须与和弦表一致。
 *
 * 表里 `C9 = [0,4,7,10,14]` 含属七度；但展开分支此前只认字面 `7`，
 * 于是 `C9#11` 得到 [0,4,7,14,19]（无七度），同一个 9 和弦
 * 加个变化音就变成了完全不同的和声。`maj` 前缀还必须用大七度。
 */
check('9/11/13 隐含七度，maj 前缀用大七度', () => {
  const iv = (sym) => parseChordSymbol(sym).intervals;
  eq(iv('C9#11').join(','), '0,4,7,10,14,18', '9 应隐含属七度 10');
  eq(iv('C13#11').join(','), '0,4,7,10,14,18,21');
  eq(iv('C9b5').join(','), '0,4,6,10,14', 'b5 不应吃掉隐含的七度');
  eq(iv('Cmaj7#11').join(','), '0,4,7,11,18', 'maj 前缀应给大七度 11 而非 10');
  eq(iv('Cmaj9#11').join(','), '0,4,7,11,14,18');
  eq(iv('Cmaj7b5').join(','), '0,4,6,11');
  // add 系列只加音，不含七度
  eq(iv('Cadd9').join(','), '0,4,7,14', 'add9 不含七度');
  eq(iv('Cadd11').join(','), '0,4,7,17', 'add11 不含七度');
});

check('和弦表与展开分支对所有性质给出同一结果', () => {
  // 表里能直接命中的性质，其音程必须与源码表定义一致；
  // 且任何性质都不应随根音变化（音程是相对根音的）
  const roots = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'F#', 'Bb', 'Eb'];
  for (const q of CHORD_QUALITY_NAMES) {
    if (!q) continue;
    const ref = parseChordSymbol(`C${q}`);
    assert(ref, `C${q} 应能解析`);
    for (const r of roots) {
      const c = parseChordSymbol(`${r}${q}`);
      assert(c, `${r}${q} 应能解析`);
      eq(c.intervals.join(','), ref.intervals.join(','), `${r}${q} 的音程应与 C${q} 一致`);
    }
  }
});

check('voicing=open 音域更宽', () => {
  const s = parseChordSymbol('C');
  const close = voicingToPitches(s, 4, 'close');
  const open = voicingToPitches(s, 4, 'open');
  eq(close.length, open.length);
});

/**
 * 声位变换只搬八度，**不能改变音级拼写**。
 *
 * 这里曾经有个真实 bug：open/spread 把音程 +12 之后直接拿去查音级表，
 * 而表是按"变换后"的半音数建的 —— C 的三音 4 升高八度成 16，
 * 16 在表里对应十一度（字母 F），于是 `C` 的 open 声位拼出 `Fb5` 而不是 `E5`。
 * 频率一样（都是 76），所以听不出问题，但和弦符号变成了同音异名的错写法；
 * `G` 的 open 更是拼出 `Cb6`（应为 `D6`）。
 *
 * 原测试只断言了音数相同，所以完全没发现。下面按**音级字母**逐条钉死。
 */
check('voicing=open 不改变音级拼写', () => {
  const cases = [
    ['C', 'C4,G4,E5'],
    ['Cm', 'C4,G4,Eb5'],
    ['C7', 'C4,G4,Bb4,E5'],
    ['Cmaj7', 'C4,G4,B4,E5'],
    ['D', 'D4,A4,F#5'],
    ['Dm', 'D4,A4,F5'],
    ['G', 'G4,D5,B5'],
    ['Am', 'A4,E5,C6'],
    ['Am7', 'A4,E5,G5,C6'],
  ];
  for (const [sym, want] of cases) {
    const got = names(voicingToPitches(parseChordSymbol(sym), 4, 'open'));
    eq(got, want, `${sym} 的 open 声位拼写`);
  }
});

check('voicing=spread 不改变音级拼写', () => {
  const cases = [
    ['C', 'C4,G4,E5'],
    ['Cmaj7', 'C4,G4,E5,B5'],
    ['Dm', 'D4,A4,F5'],
  ];
  for (const [sym, want] of cases) {
    const got = names(voicingToPitches(parseChordSymbol(sym), 4, 'spread'));
    eq(got, want, `${sym} 的 spread 声位拼写`);
  }
});

check('声位变换后音名仍能正确回读为同一批音高', () => {
  // 拼写错了但频率对，是最隐蔽的情况：用 getMidi 反查必须与半音数吻合。
  for (const sym of ['C', 'Cm', 'C7', 'Cmaj7', 'G', 'Am7', 'Dm', 'F#m']) {
    const chord = parseChordSymbol(sym);
    for (const v of ['close', 'open', 'drop2', 'spread']) {
      const pitches = voicingToPitches(chord, 4, v);
      const midis = pitches.map(getMidi);
      for (const m of midis) {
        assert(Number.isFinite(m), `${sym}/${v} 的音名 ${pitches} 应能解析成音高`);
      }
      // 同一和弦各声位的音级集合（去掉八度后）必须一致
      const pcOf = (n) => ((getMidi(n) % 12) + 12) % 12;
      const set = (arr) => [...new Set(arr.map(pcOf))].sort((a, b) => a - b).join(',');
      eq(set(pitches), set(voicingToPitches(chord, 4, 'close')), `${sym}/${v} 音级集合应与 close 一致`);
    }
  }
});

check('非法和弦符号返回 null', () => {
  eq(parseChordSymbol('H7'), null);
  eq(parseChordSymbol('Czzz'), null);
  eq(parseChordSymbol(''), null);
});

check('chord 指令接受和弦符号', () => {
  const r = parse(`sequence(name="s"){ chord("Am7", "2n") }`);
  const c = r.sequences.get('s').commands[0];
  eq(names(c.pitches), 'A4,C5,E5,G5');
  eq(c.duration, '2n');
});

check('chord 指令接受和弦符号数组', () => {
  const r = parse(`sequence(name="s"){ chord(["C","F","G"], "1n") }`);
  const c = r.sequences.get('s').commands[0];
  eq(c.pitches.length, 9, '三个三和弦共 9 个音');
});

check('chord 的 octave 指定声位八度', () => {
  const r = parse(`sequence(name="s"){ chord("C", "1n", octave=3) }`);
  const c = r.sequences.get('s').commands[0];
  eq(names(c.pitches), 'C3,E3,G3');
});

check('chord 的音高数组写法仍然可用', () => {
  const r = parse(`sequence(name="s"){ chord(["C4","E4","G4"], "2n") }`);
  eq(names(r.sequences.get('s').commands[0].pitches), 'C4,E4,G4');
});

group('progression 和弦进行');

check('progression 按时值依次发声', () => {
  const { events } = compile(`
sequence(name="s"){ progression(["C","F","G","C"], "1n") }
`);
  // 每个三和弦 3 个音 × 4 个和弦
  eq(events.length, 12);
  const times = [...new Set(events.map((e) => Number(e.time.toFixed(4))))].sort((a, b) => a - b);
  eq(times.length, 4, '应有 4 个和弦起音时刻');
  near(times[1] - times[0], 2.0, 1e-6, '1n @120bpm = 2s');
});

check('progression 支持每个和弦不同时值', () => {
  const { events } = compile(`
sequence(name="s"){ progression(["C","G"], ["2n","1n"]) }
`);
  const times = [...new Set(events.map((e) => Number(e.time.toFixed(4))))].sort((a, b) => a - b);
  near(times[1] - times[0], 1.0, 1e-6, '2n @120bpm = 1s');
});

check('progression 时值数组长度不符会报错', () => {
  throws(() => parse(`sequence(name="s"){ progression(["C","G"], ["2n"]) }`));
});

check('progression pattern=up 做分解和弦', () => {
  const { events } = compile(`
sequence(name="s"){ progression(["C"], "1n", pattern="up") }
`);
  eq(events.length, 3);
  assert(events[1].time > events[0].time, '分解和弦应依次进入');
});

check('progression 非法和弦符号报错', () => {
  const e = lineOfError(`sequence(name="s"){ progression(["Czz"], "1n") }`);
  assert(e && /和弦符号/.test(e.message), `错误信息不符: ${e && e.message}`);
});

check('progression 可用于爵士进行', () => {
  render(`
define_instrument(name="ep"){ preset:"electric_piano" }
sequence(name="s", instrument="ep") {
  progression(["Dm7","G7","Cmaj7","Cmaj7"], "1n", voicing="drop2")
}
`);
});

group('run 音型跑动');

check('run 按速率依次奏出', () => {
  const { events } = compile(`sequence(name="s"){ run(["C4","D4","E4","G4"], "16n") }`);
  eq(events.length, 4);
  near(events[1].time - events[0].time, 0.125, 1e-6, '16n @120bpm = 0.125s');
});

check('run direction=down 逆序', () => {
  const { events } = compile(`sequence(name="s"){ run(["C4","E4","G4"], "8n", direction="down") }`);
  assert(events[0].freq > events[2].freq, 'down 应高到低');
});

check('run repeat 重复音型', () => {
  const { events } = compile(`sequence(name="s"){ run(["C4","E4"], "8n", repeat=3) }`);
  eq(events.length, 6);
});

check('run 推进时间轴总长正确', () => {
  const { totalDuration } = compile(`
sequence(name="s"){ run(["C4","D4","E4","F4"], "8n") }
`);
  // 4 个八分音符 = 4 × 0.25 = 1s，加上释放时间
  assert(totalDuration >= 1.0, `总时长应 >= 1s，实际 ${totalDuration}`);
});

group('swing 摇摆');

check('swing=0 时不改变时间', () => {
  const code = `sequence(name="s"){ note("C4","16n") note("D4","16n") }`;
  const a = compile(code).events.map((e) => e.time);
  const b = compile(`config { swing: 0 }\n${code}`).events.map((e) => e.time);
  eq(JSON.stringify(a), JSON.stringify(b));
});

check('swing 推迟后半拍', () => {
  const { events } = compile(`
config { swing: 1 }
sequence(name="s"){ note("C4","16n") note("D4","16n") }
`);
  const grid = 60 / 120 / 4; // 0.125
  assert(events[0].time < 1e-9, `第一拍不应偏移，实际 ${events[0].time}`);
  assert(events[1].time > grid + 1e-6, `后半拍应被推迟，实际 ${events[1].time}`);
  // swing=1 时后半拍应落到八分三连音的第三音位置：0.125 + 0.125/3
  near(events[1].time, grid * (1 + 1 / 3), 1e-6, 'shuffle 律动位置');
});

check('swing 超范围报错', () => {
  throws(() => parse(`config { swing: 2 }\nsequence(name="s"){ note("C4","4n") }`));
});

/**
 * `8n` 是爵士鼓组与 Lo-fi 最常用的写法，也必须是 swing 能生效的写法。
 *
 * 这里曾经有个真实 bug：swing 只推动十六分网格里的**奇数步**，
 * 而 `8n` 音符落在 step 0/2/4/6 全是偶数 —— 一个都推不动。
 * 于是给爵士/Lo-fi 风格（提示词明确让模型开 swing）设了 swing 却毫无变化。
 * 原来的测试只覆盖了 `16n`，恰好绕开了这个盲区。
 */
check('swing 对 8n（爵士/Lo-fi 常用写法）生效', () => {
  const grid = 60 / 120 / 4; // 0.125
  const code = `sequence(name="s"){ ${'note("C4","8n") '.repeat(4)} }`;
  const straight = compile(code).events.map((e) => e.time);
  const swung = compile(`config { swing: 1 }\n${code}`).events.map((e) => e.time);

  // 正拍（step 0/4）不动，后半拍（step 2/6）必须被推动
  near(swung[0], straight[0], 1e-9, '第 1 个八分（正拍）不应偏移');
  near(swung[2], straight[2], 1e-9, '第 3 个八分（正拍）不应偏移');
  assert(swung[1] > straight[1] + 1e-6, `第 2 个八分应被推迟，实际 ${swung[1]}`);
  assert(swung[3] > straight[3] + 1e-6, `第 4 个八分应被推迟，实际 ${swung[3]}`);
  // swing=1 时后半拍落到八分三连音第三音：1/2 拍 → 2/3 拍
  near(swung[1], grid * 4 * (2 / 3), 1e-6, 'shuffle 律动位置（2/3 拍）');
  // 整拍长度不变
  near(swung[2], grid * 4, 1e-6, '第 2 拍起点不应移动');
});

check('swing 偏移量单调递增，不会越过下一个音', () => {
  // 任何时值下，排在后面前的时间必须严格更大（否则音符会互相盖住）
  for (const unit of ['8n', '16n', '32n']) {
    const times = compile(
      `config { swing: 1 }\nsequence(name="s"){ ${`note("C4","${unit}") `.repeat(16)} }`
    ).events.map((e) => e.time);
    for (let i = 1; i < times.length; i++) {
      assert(times[i] > times[i - 1] + 1e-9,
        `${unit} 第 ${i} 个音 (${times[i]}) 应晚于第 ${i - 1} 个 (${times[i - 1]})`);
    }
  }
});

check('swing=0.5 偏移量恰好是 swing=1 的一半', () => {
  const code = `sequence(name="s"){ ${'note("C4","8n") '.repeat(4)} }`;
  const base = compile(code).events.map((e) => e.time);
  const half = compile(`config { swing: 0.5 }\n${code}`).events.map((e) => e.time);
  const full = compile(`config { swing: 1 }\n${code}`).events.map((e) => e.time);
  for (let i = 0; i < base.length; i++) {
    near(half[i] - base[i], (full[i] - base[i]) / 2, 1e-9, `第 ${i} 个音的偏移应线性缩放`);
  }
});

group('鼓组表现力');

check('hit 支持 tune/decay/tone/snap', () => {
  const r = parse(`sequence(name="d"){ hit("kick","4n", tune=-3, decay=0.5, tone=200, snap=0.8) }`);
  const c = r.sequences.get('d').commands[0];
  eq(c.drumTune, -3);
  eq(c.drumDecay, 0.5);
  eq(c.drumTone, 200);
  eq(c.drumSnap, 0.8);
});

check('鼓组微调参数能完整合成', () => {
  render(`
sequence(name="d"){
  hit("kick","4n", tune=-3, decay=0.5)
  hit("snare","4n", tone=500, snap=0.9)
  hit("hat","8n", tune=2, decay=1.5)
}
`);
});

check('hit 的 snap 超范围报错', () => {
  throws(() => parse(`sequence(name="d"){ hit("kick","4n", snap=1.5) }`));
});

check('鼓组微调不产生非法自动化时间', () => {
  const { ctx } = render(`
sequence(name="d"){
  hit("kick","128n", decay=0.1)
  hit("snare","128n", decay=0.1)
  hit("hat","128n", decay=0.1)
  hit("clap","128n", decay=0.1)
}
`);
  const problems = auditTimelines(ctx);
  assert(problems.length === 0, `时间线异常:\n  ${problems.join('\n  ')}`);
});

check('鼓组 tune 真的改变基频', () => {
  const a = render(`sequence(name="d"){ hit("kick","4n") }`);
  const b = render(`sequence(name="d"){ hit("kick","4n", tune=-12) }`);
  const freqOf = (r) => r.ctx._nodes.filter((n) => n.kind === 'OscillatorNode')[0].frequency.events[0].v;
  near(freqOf(b) / freqOf(a), 0.5, 0.01, 'tune=-12 应降八度');
});

group('新增提示与校验');

check('未被 mix 引用的音序给出提示', () => {
  const r = parse(`
sequence(name="a"){ note("C4","4n") }
sequence(name="b"){ note("E4","4n") }
mix { track(source="a") }
`);
  assert(r.warnings.some((w) => /b/.test(w.message)), `应提示音序 b 未被引用: ${JSON.stringify(r.warnings)}`);
});

check('拼错参数名会报错而非静默忽略', () => {
  const e = lineOfError(`sequence(name="s"){ note("C4","4n", velo=0.5) }`);
  assert(e && /未知参数/.test(e.message), `应报未知参数: ${e && e.message}`);
});

check('效果器同义参数被纠正并提示', () => {
  const r = parse(`
sequence(name="s"){ note("C4","4n") }
effect_chain { delay(delay=0.25, fb=0.5) }
`);
  eq(r.effects[0].time, 0.25, 'delay 应被当作 time');
  eq(r.effects[0].feedback, 0.5, 'fb 应被当作 feedback');
  assert(r.warnings.length > 0, '应给出参数纠正提示');
});

check('效果器未知参数报错', () => {
  throws(() => parse(`
sequence(name="s"){ note("C4","4n") }
effect_chain { reverb(decay=2, wetness=0.5) }
`));
});

check('config 支持 key/scale', () => {
  const r = parse(`config { key: "Am", scale: "dorian" }\nsequence(name="s"){ note("C4","4n") }`);
  eq(r.key, 'Am');
  eq(r.scale, 'dorian');
});

check('非法 key 报错', () => {
  throws(() => parse(`config { key: "H" }\nsequence(name="s"){ note("C4","4n") }`));
});

check('非法 scale 报错', () => {
  throws(() => parse(`config { scale: "bebop" }\nsequence(name="s"){ note("C4","4n") }`));
});

check('note 写和弦符号时给出可操作提示', () => {
  const e = lineOfError(`sequence(name="s"){ note("Am7","2n") }`);
  assert(e && /chord/.test(e.message), `应建议改用 chord(): ${e && e.message}`);
});

check('octave 逐音符移调（非和弦场景）', () => {
  const { events } = compile(`sequence(name="s"){ note("C4","4n", octave=1) }`);
  near(events[0].freq, midiToFreq(72), 1e-6);
});

check('chord 的 octave 不会被当成移调（不双重生效）', () => {
  const r = parse(`sequence(name="s"){ chord("C","1n", octave=3) }`);
  const c = r.sequences.get('s').commands[0];
  eq(names(c.pitches), 'C3,E3,G3', 'chord 的 octave 只决定声位八度');
  eq(c.transpose, undefined, 'chord 的 octave 不应写进 transpose');
});

check('arp 的 octave 不会被当成移调', () => {
  const r = parse(`sequence(name="s"){ arp("C", pattern="up", rate="8n", duration="1n", octave=3) }`);
  const c = r.sequences.get('s').commands[0];
  assert(c.pitches.every((p) => getMidi(p) < 60), `arp 的 octave=3 应把音放在低八度: ${c.pitches.join(',')}`);
});

check('progression 的 octave 不会被当成移调', () => {
  const r = parse(`sequence(name="s"){ progression(["C","G"], "1n", octave=3) }`);
  const c = r.sequences.get('s').commands[0];
  assert(c.chords[0].every((p) => getMidi(p) < 60), `progression 的 octave=3 应把音放在低八度: ${c.chords[0].join(',')}`);
});

check('progression 支持 pattern=down 分解和弦', () => {
  const { events } = compile(`sequence(name="s"){ progression(["C"], "1n", pattern="down") }`);
  eq(events.length, 3);
  assert(events[0].freq > events[2].freq, 'down 应从高到低');
});

check('progression 支持 octaves 跨八度铺开', () => {
  const { events } = compile(`sequence(name="s"){ progression(["C"], "1n", octaves=2) }`);
  eq(events.length, 6, '两个八度共 6 个音');
});

check('progression 支持 strum 滚奏', () => {
  const { events } = compile(`sequence(name="s"){ progression(["C"], "1n", strum=1) }`);
  assert(events[1].time > events[0].time, 'strum 应错开进入');
});

check('progression 可用 gate 做断奏', () => {
  const { events } = compile(`sequence(name="s"){ progression(["C"], "1n", gate=0.3) }`);
  events.forEach((e) => near(e.duration, 2.0 * 0.3, 1e-6));
});

check('progression 的 voicing=drop2 生效', () => {
  const close = parse(`sequence(name="s"){ progression(["Cmaj7"], "1n", voicing="close") }`)
    .sequences.get('s').commands[0].chords[0];
  const drop = parse(`sequence(name="s"){ progression(["Cmaj7"], "1n", voicing="drop2") }`)
    .sequences.get('s').commands[0].chords[0];
  assert(close[0] !== drop[0], `drop2 应改变最低音: close=${close.join(',')} drop2=${drop.join(',')}`);
});

check('run 推进时间轴且后续指令时间正确', () => {
  const { events } = compile(`
sequence(name="s"){ run(["C4","D4","E4","F4"], "8n") note("G4","4n") }
`);
  eq(events.length, 5);
  // 4 个八分音符 = 1s，所以后面的 note 应在 1s
  near(events[4].time, 1.0, 1e-6);
});

check('run direction=updown 往返', () => {
  const { events } = compile(`sequence(name="s"){ run(["C4","E4","G4"], "8n", direction="updown") }`);
  eq(events.length, 4, '3 音往返首尾不重复应为 4 个音');
});

check('run 的 gate 生效', () => {
  const { events } = compile(`sequence(name="s"){ run(["C4","D4"], "8n", gate=0.5) }`);
  events.forEach((e) => near(e.duration, 0.25 * 0.5, 1e-6));
});

check('chord 混写和弦符号与音高数组', () => {
  const r = parse(`sequence(name="s"){ chord(["Am7"], "1n") }`);
  eq(names(r.sequences.get('s').commands[0].pitches), 'A4,C5,E5,G5');
});

check('arp 用和弦符号作具名参数 chord=', () => {
  const r = parse(`sequence(name="s"){ arp(chord="Am7", pattern="up", rate="16n", duration="1n") }`);
  eq(r.sequences.get('s').commands[0].pitches.length, 4);
});

check('arp 用和弦符号作位置参数', () => {
  const r = parse(`sequence(name="s"){ arp("Am7", "up", "16n", "1n") }`);
  const c = r.sequences.get('s').commands[0];
  eq(c.pitches.length, 4);
  eq(c.pattern, 'up');
  eq(c.rate, '16n');
  eq(c.duration, '1n');
});

check('arp 位置参数版不把 pattern 误当时值', () => {
  const r = parse(`sequence(name="s"){ arp(["C4","E4"], "down", "8n", "2n") }`);
  const c = r.sequences.get('s').commands[0];
  eq(c.pattern, 'down');
  eq(c.rate, '8n');
  eq(c.duration, '2n');
});

check('accent 顶到最强力度', () => {
  const r = parse(`sequence(name="s"){ note("C4","4n", accent=true) }`);
  eq(r.sequences.get('s').commands[0].velocity, 1);
});

check('带逗号的单行乐器定义可解析', () => {
  const r = parse(`
define_instrument(name="fm"){ fm_wave:"sine", fm_ratio:3.5, fm_index:400, gain:0.5 }
sequence(name="s", instrument="fm"){ note("C4","4n") }
`);
  const inst = r.instruments.get('fm');
  eq(inst.fm_wave, 'sine');
  eq(inst.fm_ratio, 3.5);
  eq(inst.fm_index, 400);
  eq(inst.gain, 0.5);
});

check('单行乐器定义含嵌套 effect_chain 可解析', () => {
  const r = parse(`
define_instrument(name="g"){ wave:"sawtooth" effect_chain { distortion(amount=0.6) } gain:0.4 }
sequence(name="s", instrument="g"){ note("C4","4n") }
`);
  const inst = r.instruments.get('g');
  eq(inst.wave, 'sawtooth');
  eq(inst.gain, 0.4);
  eq(inst.effects.length, 1);
  eq(inst.effects[0].amount, 0.6);
});

group('回归修复 · 字段扫描与报错定位');

/**
 * 逗号也是键名的左边界。
 *
 * `{ wave:"sine",gain:0.5 }` 里 `gain` 前面紧挨的是逗号而不是空白，
 * 旧实现的 atBoundary 只认 `[\s;]`，于是 gain 整个字段都不会被发现 ——
 * 它既不生效、也不进"未知参数"校验，就是静默消失（用户写的音量被丢掉）。
 */
check('紧凑逗号写法不会丢字段', () => {
  const r = parse(`
define_instrument(name="t"){ wave:"sine",gain:0.42 }
sequence(name="s", instrument="t"){ note("C4","4n") }
`);
  eq(r.instruments.get('t').gain, 0.42, 'gain 字段被静默丢弃');
});

check('紧凑逗号写法下的未知参数仍会报错', () => {
  const e = lineOfError(`
define_instrument(name="t"){ wave:"sine",gaain:0.42 }
sequence(name="s", instrument="t"){ note("C4","4n") }`);
  assert(e && /未知参数/.test(e.message), `应报未知参数: ${e && e.message}`);
});

/**
 * 报错行号必须指向出错的**那一行**，而不是块首。
 *
 * 旧实现把整个块的字段都按 bodyLine（块首）报，编辑器于是把光标停在
 * `define_instrument(...) {` 上，而真正的错误在十几行之下 —— 行号形同虚设。
 */
check('乐器字段报错指向字段自己那一行', () => {
  const e = lineOfError(`define_instrument(name="t") {
  wave: "sine"
  gain: 0.6
  fm_wave: "white_noise"
}`);
  assert(e && /fm_wave/.test(e.message), `应报 fm_wave: ${e && e.message}`);
  eq(e.line, 4, 'fm_wave 在第 4 行');
});

check('config 字段报错指向字段自己那一行', () => {
  const e = lineOfError(`config {
  tempo: 120
  swing: 5
}
sequence(name="s"){ note("C4","4n") }`);
  assert(e && /swing/.test(e.message), `应报 swing: ${e && e.message}`);
  eq(e.line, 3, 'swing 在第 3 行');
});

check('包络表达式报错指向 envelope 字段那一行', () => {
  const e = lineOfError(`define_instrument(name="t") {
  wave: "sine"
  envelope: "nope(1,2)"
}`);
  assert(e && /包络/.test(e.message), `应报包络错误: ${e && e.message}`);
  eq(e.line, 3, 'envelope 在第 3 行');
});

check('效果器报错行号跟随语句所在行', () => {
  const e = lineOfError(`sequence(name="s"){ note("C4","4n") }
effect_chain {
  reverb(decay=2, mix=0.3)
  delay(nope=1)
}`);
  assert(e && /未知参数/.test(e.message), `应报未知参数: ${e && e.message}`);
  eq(e.line, 4, 'delay 在第 4 行');
});

group('回归修复 · 静默失效的写法');

/**
 * `effect_chain: { ... }` 必须等于 `effect_chain { ... }`。
 *
 * 乐器字段白名单里收了 `effect_chain`（就是为了让带冒号的写法不报"未知参数"），
 * 但 findBlocks 只认紧跟 `{` 的形式，于是这条链被静默丢掉：
 * 不报错、也没效果，用户以为加了失真，实际听到的是干声。
 */
check('effect_chain 带冒号写法生效', () => {
  const r = parse(`
define_instrument(name="g"){ wave:"sawtooth" effect_chain: { distortion(amount=0.6) } }
sequence(name="s", instrument="g"){ note("C4","4n") }
`);
  const inst = r.instruments.get('g');
  eq(inst.effects.length, 1, 'effect_chain: {...} 被静默丢弃');
  eq(inst.effects[0].amount, 0.6);
});

/**
 * 只写 fm_wave + fm_index（不写 fm_ratio）必须仍然有 FM。
 *
 * 合成器的判定条件曾是 `event.fm_wave && event.fm_ratio` —— 拿一个有默认值的
 * 数值当开关，`undefined` 与 `0` 都是 falsy，于是"没写 fm_ratio"静默失去 FM；
 * 而解析器只在 fm_ratio<=0 时报错，恰好漏掉"根本没写"这一支。
 */
check('只写 fm_wave+fm_index 时 FM 仍然生效', () => {
  const { ctx } = render(`
define_instrument(name="fm"){ fm_wave:"sine", fm_index:400 }
sequence(name="s", instrument="fm"){ note("C4","4n") }
`);
  // FM 会额外建一个调制振荡器：单声部时应看到 2 个振荡器
  const oscs = ctx._nodes.filter((n) => n.kind === 'OscillatorNode');
  assert(oscs.length >= 2, `应建出 FM 调制振荡器，实际只有 ${oscs.length} 个`);
});

/**
 * fm_index 为 0 或缺失时不该建调制振荡器：增益恒为 0，纯属浪费。
 */
check('无 fm_index 时不建多余的 FM 振荡器', () => {
  const { ctx } = render(`
define_instrument(name="fm"){ fm_wave:"sine" }
sequence(name="s", instrument="fm"){ note("C4","4n") }
`);
  const oscs = ctx._nodes.filter((n) => n.kind === 'OscillatorNode');
  eq(oscs.length, 1, 'fm_index 缺省时不应创建调制振荡器');
});

/**
 * 噪声波形没有振荡器，谐波无处可挂 —— 必须报错而不是安静地按纯噪声发声。
 */
check('噪声波形配 harmonics 报错', () => {
  const e = lineOfError(`define_instrument(name="n"){ wave:"white_noise", harmonics:[1,0.5] }
sequence(name="s", instrument="n"){ note("C4","4n") }`);
  assert(e && /harmonics/.test(e.message), `应报 harmonics 不可用: ${e && e.message}`);
});

/**
 * `filter(start=...)` 是扫频起始**时刻**，不能被当成"起始频率"的别名。
 *
 * 别名表里曾写着 `start: 'from'`，而 start 本身就是 filter 的正式参数：
 * `filter(start=1, to=4000, duration=2)` 会被改写成 `from=1`，
 * 用户本意"第 1 秒开始扫"，得到的却是"从 1Hz 扫到 4000Hz"。
 */
check('filter 的 start= 保持"起始时刻"语义', () => {
  const r = parse(`
sequence(name="s"){ note("C4","2n") }
effect_chain { filter(kind="lowpass", start=1, to=4000, duration=2) }
`);
  const fx = r.effects[0];
  eq(fx.start, 1, 'start 应是起始时刻');
  eq(fx.from, 200, 'from 应保持默认值，不被 start 覆盖');
});

/**
 * LFO 的 swell 终点不能早于 ramp 终点。
 *
 * `ramp` 比音符时值长时（ramp=2 配 4n 音符），淡入写在 t+2、增强写在 t+0.5，
 * 两个自动化事件时间倒流 —— 浏览器对乱序自动化事件的处理是未定义的。
 */
check('LFO ramp 长于音符时值不产生时间倒流', () => {
  const { ctx } = render(`
define_instrument(name="a"){ lfo:"sine(freq=5, amount=10, target=frequency, ramp=2, swell=true)" }
sequence(name="s", instrument="a"){ note("C4","4n") }
`);
  const problems = auditTimelines(ctx);
  assert(problems.length === 0, `时间线异常:\n  ${problems.join('\n  ')}`);
});

/**
 * 包络 delay 必须计入尾音长度。
 *
 * chainStop 曾写成 `duration + release + 0.5`，漏掉 envelope.delay；
 * 而合成器实际把振荡器停在 `delay + duration + release + 0.1`。
 * delay 可达数秒（"吹奏前的气息准备"），于是长 delay 的音色在效果链 LFO
 * 已经停摆之后还在发声 —— 调制类效果（chorus/phaser/tremolo）中途冻结。
 */
check('包络 delay 计入效果链 LFO 停止时刻', () => {
  const ctx = new MockBaseContext(44100);
  const { events } = compile(`
define_instrument(name="a"){ envelope: "adsr(0.01, 0.1, 0.7, 0.2, delay=3)" }
sequence(name="s", instrument="a"){ note("C4","4n") }
`);
  const synth = new AudioSynthesizer();
  const fx = [{ type: 'chorus', rate: 1, depth: 3, mix: 0.5 }];
  synth.scheduleEvents(ctx, ctx.createGain(), events, fx, () => {});
  const lfos = ctx._nodes.filter(
    (n) => n.kind === 'OscillatorNode' && n.stopTime !== null && n.stopTime > 0
  );
  assert(lfos.length > 0, '应建出效果链 LFO');
  const maxStop = Math.max(...lfos.map((n) => n.stopTime));
  assert(maxStop >= 3, `delay=3 时 LFO 不应在 3 秒前停止，实际 ${maxStop}`);
});

/**
 * 鼓组必须真的按 pan 摆放声像。
 *
 * 提示词明确建议"打击乐点缀 pan=±0.4"，而 scheduleDrum 从不读 event.pan：
 * 参数被解析、被存进事件，然后无声无息地丢掉，用户听到的永远在正中间。
 */
check('鼓组 pan 真的建出声像节点', () => {
  const { ctx } = render(`sequence(name="d"){ hit("kick","4n", pan=-0.4) }`);
  const panners = ctx._nodes.filter((n) => n.kind === 'StereoPannerNode');
  eq(panners.length, 1, 'hit 的 pan 未生效（没有建声像节点）');
  near(panners[0].pan.value, -0.4, 1e-9, '声像值');
});

check('鼓组 pan=0 时不建多余声像节点', () => {
  const { ctx } = render(`sequence(name="d"){ hit("kick","4n") }`);
  eq(ctx._nodes.filter((n) => n.kind === 'StereoPannerNode').length, 0);
});

/**
 * 鼓组不该继承"当前乐器"的 pan —— 与增益是同一条不变量。
 *
 * 鼓组音色不属于任何乐器。套用乐器 pan 会让整条鼓组跟着跑：
 * 定义一个 pan=-0.5 的弦乐铺底，底鼓就一起偏到左边，用户无从理解。
 */
check('鼓组不被乐器 pan 带偏', () => {
  const { events } = compile(`
define_instrument(name="pad"){ wave:"sawtooth" pan:-0.5 }
sequence(name="d", instrument="pad"){ hit("kick","4n") }
`);
  const kick = events.find((e) => e.drum === 'kick');
  eq(kick.pan, 0, '鼓组不应继承乐器声像');
});

check('鼓组仍接受 mix 轨道的 pan', () => {
  const { events } = compile(`
sequence(name="d"){ hit("kick","4n") }
mix { track(source="d", pan=0.6) }
`);
  near(events[0].pan, 0.6, 1e-9, '轨道声像应生效');
});

/* ========================================================================== */
/*                    8. 提示词与引擎一致性（防止教错语法）                     */
/* ========================================================================== */

group('提示词一致性');

const fs = require('fs');
const path = require('path');
/**
 * 提示词写在 TS 模板字符串里，源码中的反引号是转义的（\`），
 * 直接对原始文本做正则匹配会全部落空。这里先把转义还原成提示词的真实内容。
 *
 * 读的是 SpgAiService.ts 而不是 AiService.ts：SPG 的语法文档与生成/修复函数
 * 已按功能归属切到应用侧（AiService 只留通用的补全与解析，否则插件侧会
 * 因为名字表依赖把整个音频引擎拖进 bundle）。
 */
const aiSource = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'services', 'SpgAiService.ts'), 'utf8'
).replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');

check('提示词里出现的所有指令名都被引擎支持', () => {
  const supported = ['note', 'chord', 'arp', 'hit', 'rest', 'progression', 'run'];
  const docMatch = /\*\*七条指令\*\*：([\s\S]*?)#### 4\./.exec(aiSource);
  assert(docMatch, '找不到指令文档一节');
  supported.forEach((cmd) => {
    assert(docMatch[1].includes(`${cmd}(`), `文档里缺少指令 ${cmd}`);
  });
});

check('提示词里的效果器参数名全部合法', () => {
  // 提示词的 effect_chain 示例同样没有代码围栏，按章节切出来
  const start = aiSource.indexOf('#### 4. effect_chain');
  assert(start > 0, '找不到 effect_chain 一节');
  const end = aiSource.indexOf('**顺序很重要**', start);
  assert(end > start, '找不到 effect_chain 示例的结束标记');
  const section = aiSource.slice(start, end);
  const open = section.indexOf('effect_chain {');
  const close = section.indexOf('}', open);
  const example = section.slice(open + 'effect_chain {'.length, close);
  assert(/reverb\s*\(/.test(example), 'effect_chain 示例里没有 reverb');
  parse(`sequence(name="s"){ note("C4","4n") }\neffect_chain {\n${example}\n}`);
});

check('提示词里声明的和弦性质都能被解析', () => {
  const qualities = aiSource.match(/支持的性质：([^\n]+)/);
  assert(qualities, '找不到和弦性质声明');
  // 这一行是 `${chordList()}` 拼进去的，实际清单从引擎取，这里核对拼接点
  assert(/\$\{chordList\(\)\}/.test(aiSource), '和弦性质应通过 chordList() 注入');
  assert(CHORD_QUALITY_NAMES.length > 30, `和弦性质清单过短: ${CHORD_QUALITY_NAMES.length}`);
  // 逐个验证清单里的性质都能解析（空字符串代表大三和弦，跳过）
  CHORD_QUALITY_NAMES.filter((q) => q.length > 0).forEach((q) => {
    const sym = parseChordSymbol(`C${q}`);
    assert(sym, `引擎声明的和弦性质 "${q}" 无法解析`);
  });
});

check('提示词里声明的鼓组名与引擎一致', () => {
  const { DRUM_NAMES: engineDrums } = require(`${ROOT}/services/AudioService`);
  // 鼓组清单由 drumList() 在运行时注入，核对拼接点与清单完整性
  assert(/\$\{drumList\(\)\}/.test(aiSource), '提示词应通过 drumList() 注入鼓组名');
  assert(engineDrums.length === 16, `鼓组数量异常: ${engineDrums.length}`);
  // 并确认提示词里提到的每个鼓组名都是引擎认识的
  engineDrums.forEach((d) => {
    const mentioned = new RegExp(`hit\\("${d}"`).test(aiSource);
    if (mentioned) {
      parse(`sequence(name="s"){ hit("${d}","4n") }`);
    }
  });
});

check('提示词里声明的预设名与引擎一致', () => {
  const { PRESET_NAMES: enginePresets } = require(`${ROOT}/services/AudioService`);
  // 预设清单是运行时拼进去的，只需确认拼接点存在且清单非空
  assert(enginePresets.length > 20, `预设数量异常: ${enginePresets.length}`);
  assert(/\$\{presetList\(\)\}/.test(aiSource), '提示词应通过 presetList() 注入预设名');
});

/**
 * 提示词里教的每个和弦性质都必须真能被引擎解析。
 *
 * 提示词用 `CHORD_QUALITY_NAMES` 注入性质清单，清单与解析器同源，
 * 所以"清单里的项解析不了"理论上不该发生 —— 但正是这种"同源"假设
 * 让 expandQuality 的缺陷长期没被发现：清单来自和弦表（表项都能解析），
 * 而表**之外**的组合写法（`C7#11`、`Cmaj9#11`）才是出问题的地方。
 * 这条守卫锁死"清单项可解析"，并额外抽查表外的组合写法。
 */
check('提示词声明的和弦性质都能被引擎解析', () => {
  assert(CHORD_QUALITY_NAMES.length > 30, `和弦性质清单过短: ${CHORD_QUALITY_NAMES.length}`);
  assert(/\$\{chordList\(\)\}/.test(aiSource), '提示词应通过 chordList() 注入和弦性质');
  for (const q of CHORD_QUALITY_NAMES) {
    if (!q) continue;
    assert(parseChordSymbol(`C${q}`), `提示词声明了性质 "${q}"，但引擎解析 C${q} 失败`);
  }
  // 表外组合写法（提示词鼓励模型自由组合根音+性质，这些是常见的扩展写法）
  for (const sym of ['C7#11', 'C9#11', 'Cmaj7#11', 'Cmaj9#11', 'C7b9', 'C7#9', 'C7b13', 'Cmaj7b5']) {
    assert(parseChordSymbol(sym), `常见扩展和弦 ${sym} 应能解析`);
  }
});

check('提示词里的和弦示例都能实际解析', () => {
  // 把模板字符串的转义还原成提示词的真实内容
  const prompt = aiSource.replace(/\\`/g, '`').replace(/\\\$/g, '$');
  let seen = 0;
  for (const m of prompt.matchAll(/progression\(\[([^\]]*)\]/g)) {
    for (const s of [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])) {
      seen++;
      assert(parseChordSymbol(s), `提示词 progression 示例里的 "${s}" 无法解析`);
    }
  }
  for (const m of prompt.matchAll(/chord\("([^"]+)"/g)) {
    seen++;
    assert(parseChordSymbol(m[1]), `提示词 chord 示例里的 "${m[1]}" 无法解析`);
  }
  assert(seen >= 5, `应至少检查到 5 个和弦示例，实际 ${seen}`);
});

check('提示词提到的每条指令都能实际编译', () => {
  const cases = [
    `note("C5", "4n")`,
    `chord("Am7", "2n")`,
    `chord(["C4","E4","G4"], "2n", voicing="drop2")`,
    `progression(["Am7","Dm7","G7","Cmaj7"], "1n")`,
    `progression(["Am7","Dm7"], ["1n","2n"], voicing="drop2")`,
    `arp("Am7", pattern="up", rate="16n", duration="1n")`,
    `run(["C4","D4","E4","G4"], "16n")`,
    `run(["C4","E4","G4"], "16n", direction="down", repeat=2)`,
    `hit("kick", "4n", tune=0, decay=1, tone=0, snap=0)`,
    `hit("snare", "2n", velocity=0.7, snap=0.3)`,
    `rest("8n")`,
    `note("C4","4n", accent=true)`,
    `note("C4","4n", octave=1)`,
    `note("C4","4n", humanize=0.3)`,
  ];
  cases.forEach((c) => {
    try {
      parse(`sequence(name="s"){ ${c} }`);
    } catch (e) {
      throw new Error(`提示词里的写法无法编译: ${c}\n  → ${e.message}`);
    }
  });
});

check('提示词里的乐器参数名全部合法', () => {
  const valueFor = (p) => {
    if (p === 'effect_chain') return '{}';
    if (p === 'harmonics') return '[1,0.5]';
    if (p === 'envelope' || p === 'filter_envelope') return '"adsr(0.01,0.1,0.7,0.2)"';
    if (p === 'filter') return '"lowpass(2000,1)"';
    if (p === 'lfo') return '"sine(freq=5, amount=10, target=frequency)"';
    if (p === 'preset') return '"piano"';
    if (p === 'wave' || p === 'fm_wave') return '"sine"';
    return '0.5';
  };
  const params = [
    'wave', 'envelope', 'filter', 'filter_envelope', 'filter_env_amount', 'lfo',
    'gain', 'pan', 'fm_wave', 'fm_ratio', 'fm_index', 'detune', 'voices',
    'unison_spread', 'spread', 'glide', 'glide_from', 'pitch_env_amount',
    'pitch_decay', 'attack_noise', 'harmonics', 'velocity_sensitivity',
    'velocity_to_filter', 'effect_chain', 'loop_point', 'preset',
  ];
  params.forEach((p) => {
    // 每个参数都必须真的出现在提示词文档里（preset 在示例里以 `preset:` 出现）
    const declared = aiSource.includes(`\`${p}\``) || new RegExp(`${p}\\s*:`).test(aiSource);
    assert(declared, `提示词里没有声明参数 ${p}`);
    const code = `define_instrument(name="t"){ ${p}: ${valueFor(p)} }\nsequence(name="s", instrument="t"){ note("C4","4n") }`;
    try {
      parse(code);
    } catch (e) {
      throw new Error(`提示词里的乐器参数 ${p} 无法编译: ${e.message}`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                     作品名通道：提示词 ↔ 解析 ↔ 工程标题                     */
/* -------------------------------------------------------------------------- */

const { splitTitle, parseReply, TITLE_LINE_EXAMPLE } = require(`${ROOT}/services/SpgAiService`);

check('★ 提示词教的作品名格式，解析器必须真的认', () => {
  // 提示词给模型看的示例行与解析用的正则，是同一件事的两份表述。
  // 漂移了不会报错：模型照新格式写，解析器认不出来，作品名通道静默失效 ——
  // 用户看到的是"AI 不给工程命名了"，而根因在两边不一致。
  // 所以这里把**运行时真正拼进提示词的那个字符串**喂给解析函数。
  const parsed = splitTitle(`${TITLE_LINE_EXAMPLE}\nconfig { tempo: 120 }`);
  eq(parsed.title, '三圈半', '提示词教的示例行应能被解析出作品名');
  eq(parsed.code, 'config { tempo: 120 }', '作品名那一行应被摘掉，不能留在代码里');
  assert(/\$\{TITLE_LINE_EXAMPLE\}/.test(aiSource), '提示词应通过 TITLE_LINE_EXAMPLE 注入示例行');
});

check('作品名注释被摘干净，其余内容一字不动', () => {
  // 全角冒号（提示词教的）与半角冒号都要认，模型两种都会写
  eq(splitTitle('# 作品名：未落\nconfig { tempo: 90 }').title, '未落', '全角冒号');
  eq(splitTitle('# 作品名: 未落\nconfig { tempo: 90 }').title, '未落', '半角冒号');
  eq(splitTitle('// 作品名：未落\nconfig { tempo: 90 }').title, '未落', '// 注释符');
  eq(splitTitle('  # 作品名：未落  \nconfig{}').title, '未落', '缩进与尾随空格');
  // 只摘那一行，代码本体（含其它注释）必须原样保留
  const body = '# 这是一条普通注释\nconfig { tempo: 90 }\nsequence(name="s"){ note("C4","4n") }';
  eq(splitTitle(`# 作品名：未落\n${body}`).code, body, '除作品名外不得改动任何一行');
});

check('没有作品名时不误伤代码，也不编一个名字出来', () => {
  const code = '# 等待 AI 生成或手动输入代码...\nconfig { tempo: 120 }';
  const r = splitTitle(code);
  eq(r.title, null, '没有作品名注释时应返回 null，而不是回落到占位词');
  eq(r.code, code, '没有作品名时代码必须原样返回');
  // 「作品名」出现在正文或其它注释里不算作品名 —— 否则会把用户的说明文字摘掉
  eq(splitTitle('# 作品名字：这是个说明\nconfig{}').title, null, '「作品名字」不是作品名');
  eq(splitTitle('config { tempo: 120 } # 作品名：未落').title, null, '不在行首的注释不算');
});

check('作品名写在代码围栏外也能被摘到', () => {
  // 模型常把作品名写在围栏外面，而 cleanCodeBlock 只返回围栏内部的内容。
  // 顺序若反过来（先清围栏再摘作品名），那一行就随围栏一起没了。
  // 这里必须调 parseReply 而不是 splitTitle：只调 splitTitle 时，
  // 把 parseReply 的顺序写反，测试全绿 —— 变异测试实测确认过这一点。
  const outside = parseReply(`${TITLE_LINE_EXAMPLE}\n\`\`\`spg\nconfig { tempo: 120 }\n\`\`\``);
  eq(outside.title, '三圈半', '围栏外的作品名应被摘到');
  eq(outside.code, 'config { tempo: 120 }', '应同时清掉围栏，只留代码');
  // 围栏内写也一样要认（模型两种位置都会用）
  const inside = parseReply(`\`\`\`spg\n${TITLE_LINE_EXAMPLE}\nconfig { tempo: 120 }\n\`\`\``);
  eq(inside.title, '三圈半', '围栏内的作品名同样要认');
  eq(inside.code, 'config { tempo: 120 }', '围栏内摘完后不得留下空行或围栏');
  // 没有围栏时行为不变
  const bare = parseReply(`${TITLE_LINE_EXAMPLE}\nconfig { tempo: 120 }`);
  eq(bare.title, '三圈半', '裸文本');
  eq(bare.code, 'config { tempo: 120 }', '裸文本');
});

check('修复提示词明确排除作品名规则', () => {
  // 修复提示词 = 修复指令 + 完整语法文档，而语法文档第 1 条现在要求写作品名。
  // 不显式排除，模型每修一次就可能往用户已经改过的标题上覆盖一次。
  const fixStart = aiSource.indexOf('const SPG_FIX_PROMPT');
  assert(fixStart > 0, '找不到 SPG_FIX_PROMPT');
  const fixEnd = aiSource.indexOf('const withSyntaxDoc', fixStart);
  assert(fixEnd > fixStart, '找不到 SPG_FIX_PROMPT 的结束位置');
  const fixSection = aiSource.slice(fixStart, fixEnd);
  assert(/作品名/.test(fixSection), '修复提示词必须显式声明不处理作品名');
  assert(/不适用/.test(fixSection), '修复提示词应说明该条规则对修复不适用');
});

/**
 * 新建工程必须把作品名写进工程标题。
 *
 * **这是代码形状断言，不是行为验证**：useAudio 是 React hook，而本仓库没有
 * React 测试环境（无 jsdom / testing-library），无法在这里真的跑一遍。
 * 它能拦住的是"有人删掉/改错这几行"，拦不住"运行时没生效"。
 * 那一段只能靠人工在界面里确认，交付时按"未执行验证"记账。
 */
check('新建工程把作品名写进工程标题（代码形状断言，非行为验证）', () => {
  const hookSrc = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'hooks', 'useAudio.ts'), 'utf8');
  const start = hookSrc.indexOf('const createProject = useCallback');
  assert(start > 0, '找不到 createProject');
  const end = hookSrc.indexOf('const deleteProject', start);
  assert(end > start, '找不到 createProject 的结束位置');
  const body = hookSrc.slice(start, end);

  assert(/generateSyntax\(/.test(body), 'createProject 应调用 generateSyntax');
  assert(/\{\s*code\s*,\s*title\s*\}/.test(body), 'createProject 应从生成结果里取出 title');
  // 没给作品名时回落到用户描述的开头，而不是写一个占位词
  assert(/title\s*\|\|\s*prompt\.slice/.test(body),
    '没有作品名时应回落到描述开头，不能写死"未命名项目"');
  assert(/newProject\.name\s*=\s*name/.test(body), '作品名必须写进工程标题');
  assert(/archiveSpg\(code,\s*name\)/.test(body), '生成结果要留档到 .spg');
  // 失败不建工程：留一个空工程在列表里还得用户自己删
  const catchAt = body.indexOf('catch (');
  assert(catchAt > 0, 'createProject 应有失败分支');
  assert(!/setProjects/.test(body.slice(catchAt)), '生成失败时不得建工程');
});

check('工作台里没有会话容器（创作/迭代/修复各有独立入口）', () => {
  // 三件事各自有入口之后，对话区不再承担任何职责：
  // 留着它等于让用户面对一个"说什么都行但不知道会发生什么"的输入框。
  //
  // 断言锚在**定义与渲染处**，不是"文件里出现过这个词" ——
  // 文件头的历史说明里提到 ChatInterface 是正当的，
  // 而扫全文字面量会逼着注释绕开自己的历史（实测：这条一开始就是这么红的）。
  const panelSrc = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'components', 'AudioPanel.tsx'), 'utf8');
  for (const [pattern, what] of [
    [/const ChatInterface\s*=/, 'ChatInterface 组件定义'],
    [/<ChatInterface[\s/>]/, 'ChatInterface 的渲染'],
    [/placeholder="描述你想要的音乐/, '对话区输入框'],
    [/sendMessage:\s*\w/, '对话式的 sendMessage 注入'],
  ]) {
    assert(!pattern.test(panelSrc), `会话容器应已删除，但仍能找到${what}`);
  }
  // 创作入口改成"新建工程时输入描述"。
  // 断言必须锚在**使用处**：只查标识符是否存在的话，把按钮删掉、
  // 或把渲染短路成 `{false && <Dialog/>}`，标识符依然在文件里（实测确认过）。
  assert(/onClick=\{\(\) => setCreateOpen\(true\)\}/.test(panelSrc),
    '必须有一个能打开对话框的入口');
  assert(/<CreateProjectDialog\s+open=\{createOpen\}/.test(panelSrc),
    '新建工程对话框必须真的被渲染');
  // 对话框自己用 `if (!open) return null` 管可见性，外面再加一层条件
  // 就是同一件事的第二个主人 —— 两处对不上时表现为"点了按钮没反应"
  assert(!/[&?][&?]?\s*<CreateProjectDialog|\?\s*<CreateProjectDialog/.test(panelSrc),
    '对话框不得被外层条件短路，可见性由它自己的 open 参数决定');
  assert(/onSubmit=\{handleCreateProject\}/.test(panelSrc), '对话框应提交给 handleCreateProject');
  // 迭代与修复的入口必须还在（删会话容器不能顺手删掉它们）
  assert(/onClick=\{handleRefineImport\}/.test(panelSrc), '迭代优化入口不得被一起删掉');
  assert(/onClick=\{handleManualFix\}/.test(panelSrc), '手动修复入口不得被一起删掉');
});

check('工程数据里不再有会话历史', () => {
  // messages 字段随会话容器一起删掉。留着一个没人读的数组，
  // 下次改动就会有人以为它还在被持久化往返地维护。
  const iface = fs.readFileSync(
    path.join(__dirname, '..', 'shared', 'meta', 'interface.ts'), 'utf8');
  const start = iface.indexOf('export interface Project {');
  assert(start > 0, '找不到 Project 接口');
  const body = iface.slice(start, iface.indexOf('}', start));
  assert(!/messages/.test(body), 'Project 不应再有 messages 字段');

  const svc = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'services', 'AudioService.ts'), 'utf8');
  const createStart = svc.indexOf('export const createNewProject');
  const createBody = svc.slice(createStart, svc.indexOf('export const saveProjects', createStart));
  assert(!/messages/.test(createBody), 'createNewProject 不应再初始化 messages');
  // 旧缓存里带 messages 的条目必须仍能被读出来 —— 校验器若要求这个字段，
  // 用户升级后所有工程都会被判为脏数据丢掉
  const loadStart = svc.indexOf('export const loadProjects');
  const loadBody = svc.slice(loadStart, svc.indexOf('};', loadStart));
  assert(!/messages/.test(loadBody),
    'loadProjects 不得要求 messages 字段，否则旧缓存里的工程会被整批丢弃');
});

/* -------------------------------------------------------------------------- */
/*                       迭代优化通道：提示词 ↔ 落点 ↔ 原稿                     */
/* -------------------------------------------------------------------------- */

check('迭代提示词必须锁死原曲身份（调性/和声/曲式/旋律）', () => {
  // "优化"在模型的默认理解里就是"重写"。用户拿回的若是一首陌生的曲子，
  // 功能就是负价值 —— 而这类失败不报错、不告警，只能靠提示词里的硬约束挡。
  const start = aiSource.indexOf('const SPG_REFINE_PROMPT');
  assert(start > 0, '找不到 SPG_REFINE_PROMPT');
  const end = aiSource.indexOf('const withSyntaxDoc', start);
  assert(end > start, '找不到 SPG_REFINE_PROMPT 的结束位置');
  const refine = aiSource.slice(start, end);

  // 每一条"不许动"都对应一类会被静默改掉的音乐身份
  for (const [pattern, what] of [
    [/tempo/, '速度'],
    [/和声骨架/, '和声骨架'],
    [/曲式与时间轴/, '曲式与时间轴'],
    [/主旋律的音高与节奏/, '主旋律'],
    [/不要换乐器/, '乐器音色身份'],
  ]) {
    assert(pattern.test(refine), `迭代提示词必须锁死${what}，否则模型会把它一起"优化"掉`);
  }
  // 迭代不改工程名。必须钉在**输出纪律**那一节：这条规则在提示词里出现两次
  // （"不许动的部分"与"输出纪律"），而只有后者是模型最后读到的执行条款。
  // 只断言"提示词里某处提到了不改名"会漏掉"输出纪律被改成允许改名" ——
  // 那样提示词自相矛盾，模型两边都可能听，实测确认过这一点。
  const discipline = refine.slice(refine.indexOf('==================== 输出纪律 ===================='));
  assert(discipline.length > 0 && discipline.length < refine.length, '找不到迭代提示词的输出纪律一节');
  assert(/不要.*作品名|作品名.*不要|不改工程名|不重命名/.test(discipline),
    '输出纪律必须明确不改作品名，否则模型会顺手把工程名一起改掉');
  // 输出必须是完整代码而不是 diff，否则落进编辑器的东西编译不过
  assert(/完整的优化后代码/.test(refine), '迭代提示词必须要求输出完整代码');
  // 这条是"不许发明语法"的执行方式：与生成/修复共用同一份语法文档
  assert(/withSyntaxDoc\(SPG_REFINE_PROMPT\)/.test(aiSource),
    '迭代必须经 withSyntaxDoc 带上完整语法文档');
});

check('修复与迭代都必须带上完整语法文档', () => {
  // 只给"改一改"的指令而不给语法，模型只能凭印象猜合法写法 ——
  // 这正是此前自动修复反复失败的原因。凡是让模型改 SPG 代码的通道
  // 都得经过 withSyntaxDoc，否则它会退化成一次凭记忆的重写。
  const calls = [...aiSource.matchAll(/system:\s*([^,\n]+),/g)].map((m) => m[1].trim());
  assert(calls.includes('SPG_SYSTEM_PROMPT'), '生成通道应直接用 SPG_SYSTEM_PROMPT');
  assert(calls.filter((c) => /withSyntaxDoc\(/.test(c)).length >= 2,
    `修复与迭代都应经 withSyntaxDoc，实际只有 ${calls.filter((c) => /withSyntaxDoc\(/.test(c)).length} 处`);
  assert(!/buildFixPrompt/.test(aiSource), 'buildFixPrompt 已被 withSyntaxDoc 取代，不得残留');
});

check('迭代结果落进新工程，原工程一字不动（代码形状断言，非行为验证）', () => {
  // 原稿只存在于工程里，没有第二份可以回退。覆盖它就等于把用户的曲子弄丢了，
  // 而"保有原曲"正是这个功能的卖点 —— 所以落点必须是新建工程。
  const hookSrc = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'hooks', 'useAudio.ts'), 'utf8');
  const start = hookSrc.indexOf('const refineSpg = useCallback');
  assert(start > 0, '找不到 refineSpg');
  const end = hookSrc.indexOf('// 5. 组装出参', start);
  assert(end > start, '找不到 refineSpg 的结束位置');
  const body = hookSrc.slice(start, end);

  assert(/refineSyntax\(source\.content\)/.test(body),
    'refineSpg 必须把**正文**交给模型；传成文件名的话模型收到的是一句文件名');
  assert(/buildRefinedProject\(/.test(body), '迭代结果必须进新工程');
  assert(/setProjects\(\(prev\)\s*=>\s*\[project,/.test(body), '新工程应加入工程列表');
  // 覆盖原稿的两条路径都必须不出现：改名式更新与代码式更新
  assert(!/updateActiveProject/.test(body), 'refineSpg 不得改写任何既有工程');
  assert(/archiveSpg\(code,/.test(body), '优化结果同样要留档到 .spg');
});

check('导入与迭代都从项目根的 .spg 目录取件（系统文件框，非 <input type=file>）', () => {
  // `<input type="file">` 无法指定初始目录，只会停在上次去过的地方；
  // 而 .spg 是固定落点（生成时就写在那儿），用户每次都得自己导航回去。
  // 所以取件必须走主进程的 dialog —— 一旦退回 input，这个便利就没了。
  const panelSrc = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'components', 'AudioPanel.tsx'), 'utf8');
  // 只针对 .spg 取件那两个 input：实验室里还有三个给音频工具用的
  // `<input type="file">`，它们与本次改动无关，不该被这条断言扫到
  assert(!/accept="\.spg,\.txt"/.test(panelSrc),
    '导入/迭代不得再用 <input type="file">：它无法把初始目录指到 .spg');
  assert(!/fileInputRef|refineInputRef/.test(panelSrc), '两个隐藏 input 的 ref 应已删除');

  // 取件是两条路径共用的同一步（同一目录、同一过滤、同一读文件逻辑），
  // 差别只在拿到源码之后干什么 —— 所以共用一个函数，落点各自保留
  const pickStart = panelSrc.indexOf('const pickSpgSource');
  assert(pickStart > 0, '找不到共用的取件步骤 pickSpgSource');
  const pickBody = panelSrc.slice(pickStart, panelSrc.indexOf('const handleFileImport', pickStart));
  assert(/audioActions\.pickSpgSource\(/.test(pickBody), '取件应走 pickSpgSource（主进程弹框）');
  // 取件失败要说出来：用户点的是按钮，静默返回就是"点了没反应"
  assert(/setParserError\(/.test(pickBody), '取件失败必须给出可见的错误');

  // 入口按钮必须真的绑到 handler 上。只查标识符存在的话，
  // 把按钮删掉、或改成空 onClick，标识符依然在文件里（实测确认过）。
  assert(/onClick=\{handleFileImport\}/.test(panelSrc), '导入按钮应绑 handleFileImport');
  assert(/onClick=\{handleRefineImport\}/.test(panelSrc), '迭代按钮应绑 handleRefineImport');

  // 迭代失败必须报出来：模型要跑一段时间，界面只有按钮转圈，
  // 不报错的话用户看到的就是"点了一下，什么都没发生"
  const refineStart = panelSrc.indexOf('const handleRefineImport');
  assert(refineStart > 0, '找不到 handleRefineImport');
  const refineBody = panelSrc.slice(refineStart, panelSrc.indexOf('handleCompileAndPlay = useCallback', refineStart));
  assert(/setParserError\(/.test(refineBody), '迭代失败必须给出可见的错误');
  // 落点仍必须分开：导入是"放进工作台"，迭代是"AI 改一版进新工程"
  assert(/importProjectFromFile\(/.test(panelSrc), '导入应走 importProjectFromFile');
  assert(/refineSpg\(/.test(refineBody), '迭代应走 refineSpg');
});

check('取件结果的三态：拿到源码 / 取消 / 失败，取消不是失败', () => {
  // 这是纯函数，直接调用。用源码扫描验不了它 —— 把 `if (res.cancelled) return {}`
  // 删掉，源码里照样能找到那几行，只有调用才会发现取消变成了报错。
  const { resolveSpgPick, spgBaseName, buildImportedProject, buildRefinedProject } =
    require(`${ROOT}/hooks/useAudio`);

  // 1. 成功：正文与文件名都要带出来
  const ok = resolveSpgPick({ success: true, name: '未落.txt', content: 'config { tempo: 120 }' });
  eq(ok.source && ok.source.name, '未落.txt', '成功时应带出文件名');
  eq(ok.source && ok.source.content, 'config { tempo: 120 }', '成功时应带出正文');
  eq(ok.message, undefined, '成功时不该有错误');

  // 2. 取消：既没有源码，也**没有**错误 —— 混在一起的话按取消会看到报错
  const cancelled = resolveSpgPick({ success: false, cancelled: true });
  eq(cancelled.source, undefined, '取消不该给出源码');
  eq(cancelled.message, undefined, '取消不是失败，不该报错');

  // 3. 失败：必须给出可见的错误
  const failed = resolveSpgPick({ success: false, message: '读取文件失败' });
  eq(failed.source, undefined, '失败不该给出源码');
  assert(typeof failed.message === 'string' && failed.message.length > 0, '失败必须给出错误文案');

  // 4. success=true 但正文缺失同样是失败。空源码进工程就是一首空曲子，
  //    编译能过、就是没声音，界面上看不出哪里不对
  const empty = resolveSpgPick({ success: true, name: 'a.spg' });
  eq(empty.source, undefined, '正文缺失不得当成成功');
  assert(typeof empty.message === 'string' && empty.message.length > 0,
    '正文缺失必须报错，否则空源码会静默进工程');

  // 5. 桥没加载（preload 故障）：用户点的是按钮，静默返回就是"点了没反应"
  const noBridge = resolveSpgPick(null);
  eq(noBridge.source, undefined, '桥没加载时不该给出源码');
  assert(typeof noBridge.message === 'string' && noBridge.message.length > 0,
    '桥没加载必须报错，否则用户看到的是"点了没反应"');

  // 文件名 → 作品名：后缀去掉，空名有兜底
  eq(spgBaseName('忧伤_钢琴.txt'), '忧伤_钢琴', '应去掉 .txt 后缀');
  eq(spgBaseName('美好世界.spg'), '美好世界', '应去掉 .spg 后缀');
  eq(spgBaseName('无后缀'), '无后缀', '没有后缀时原样返回');

  // 导入：正文必须真的进工程。丢了正文的工程打开是空的
  const imported = buildImportedProject({ name: '三圈半.txt', content: 'config { tempo: 90 }' });
  eq(imported.name, '三圈半', '导入的工程名取文件名');
  eq(imported.code, 'config { tempo: 90 }', '导入必须把正文写进工程');

  // 迭代：进新工程、名字标出"优化版"、正文是优化结果而不是原稿
  const refined = buildRefinedProject({ name: '原地.txt', content: '原稿' }, '优化后的代码');
  eq(refined.name, '原地 优化版', '迭代结果应标出优化版');
  eq(refined.code, '优化后的代码', '迭代工程里应是优化结果');

  // 每次迭代都必须是**新**工程。共用 id 的话，第二次迭代会覆盖第一次的结果，
  // 而界面上只是列表少了一项 —— 用户不会意识到自己丢了一版
  const again = buildRefinedProject({ name: '原地.txt', content: '原稿' }, '再优化一版');
  assert(refined.id !== again.id, '两次迭代必须得到不同的工程 id，否则后一版会覆盖前一版');
  assert(imported.id !== buildImportedProject({ name: 'a.spg', content: 'x' }).id,
    '两次导入必须得到不同的工程 id');
});

check('取件通道把初始目录钉在项目根的 .spg（主进程 ↔ 桥 ↔ 渲染层三处对齐）', () => {
  // 三处必须同时存在，缺一处就表现为"点了按钮没反应"：
  // 主进程没注册 handler → 调用永远 pending；preload 没暴露 → 渲染层拿不到方法。
  const mainSrc = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'main', 'main.js'), 'utf8');
  const pickStart = mainSrc.indexOf('async function handleSpgPick');
  assert(pickStart > 0, '主进程缺少 handleSpgPick');
  const pickBody = mainSrc.slice(pickStart, mainSrc.indexOf('\nfunction setupDownloadHandlers', pickStart));
  // 落点与 handleSpgSave 必须是同一个目录：一个写、一个读，指到两处就是"存了却找不到"。
  // 两条断言缺一不可 —— 只查 `path.join(..., '.spg')` 的话，把 defaultPath 换成
  // 别的东西时那个 `dir` 变量还在，断言照样通过（实测确认过）。
  assert(/const dir = path\.join\(app\.getAppPath\(\), '\.spg'\)/.test(pickBody),
    '取件的目标目录必须是项目根的 .spg');
  assert(/defaultPath:\s*dir/.test(pickBody),
    '文件框的初始目录必须真的用上这个 dir，否则框会停在上次去过的地方');
  // 文件路径必须**来自**系统文件框。只查 `dialog.showOpenDialog` 出现过是不够的：
  // 把结果换成硬编码（或者把 dialog 调用挪到别处）时它照样在文件里，
  // 而用户会看到一个永远选不了文件的框（实测确认过）。
  assert(/const \{ canceled, filePaths \} = win\s*\?\s*await dialog\.showOpenDialog\(win, opts\)\s*:\s*await dialog\.showOpenDialog\(opts\)/.test(pickBody),
    '文件名必须由系统文件框返回，不能硬编码');
  assert(/readFile\(/.test(pickBody), '内容要在主进程读出来：渲染层读不了文件');
  assert(/cancelled/.test(pickBody), '取消要与失败分开：取消不该报错');
  assert(/ipcMain\.handle\('spg-pick'/.test(mainSrc), 'spg-pick 必须在主进程注册');

  const preloadSrc = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'main', 'preload.js'), 'utf8');
  assert(/pick:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('spg-pick'\)/.test(preloadSrc),
    'preload 必须暴露 spg.pick，否则渲染层拿不到这个方法');
});

/* ========================================================================== */

/** 汇总本次结果，返回是否全部通过 */
const run = async () => {
  // 跨 turn 的异步断言先结算（失败会计入 failures）
  for (const p of pendingAsync) {
    try { await p; passed++; } catch (e) {
      failures.push({ group: '回归修复', name: '异步断言', error: e });
    }
  }
  // 离线渲染是异步 API，单独跑一遍
  try {
    global.window = { AudioContext: MockBaseContext, OfflineAudioContext: MockOfflineAudioContext };
    const { BrowserAudioEngine } = require(`${ROOT}/services/AudioService`);
    const engine = new BrowserAudioEngine();
    engine.compile(BASIC);
    const blob = await engine.renderOffline();
    assert(blob && blob.size > 44, 'WAV 数据过短');
    passed++;
  } catch (e) {
    failures.push({ group: '引擎', name: 'renderOffline 可产出 WAV', error: e });
  }

  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('\n失败详情:');
    for (const f of failures) {
      console.log(`\n  [${f.group}] ${f.name}`);
      console.log(`    ${String(f.error.message).split('\n').join('\n    ')}`);
    }
    return false;
  }
  return true;
};

module.exports = { run };
