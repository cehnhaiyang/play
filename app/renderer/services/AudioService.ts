/**
 * 声音粒子（SPG）音频服务。
 *
 * 链路：SPG 源码 → SPGParser 解析 → EventScheduler 排期成"绝对秒数"的事件表
 * → AudioSynthesizer 把事件表铺成 Web Audio 节点图 → BrowserAudioEngine 负责
 * 实时试听与离线导出；末尾的工程持久化与 WAV/Zip 编码供 UI 直接调用。
 *
 * 之所以收在一个文件里：这四层共用同一套乐理与数值工具（音名、时值、确定性随机），
 * 拆成多个模块时工具层被迫对外暴露，反而让"哪些是内部实现"变得含糊。
 *
 * 本文件由 test/tsconfig.json 单独编译进 Node 测试环境（无 React 类型），
 * 因此不得引用 React，也不得有模块级副作用。
 */

import type {
  ArpCommand, ArpPattern, ChordCommand, ChordSymbol, DrumName, DrumSpec,
  EffectDef, EffectType, Envelope, EnvelopeCurve, ExpandedOscillatorType,
  FilterDef, FilterKind, InstrumentDef, LFODef, LFOTarget, MixTrack, NoiseColor,
  NoteExpression, ParseResult, ParserError, ProgressionCommand, Project,
  RunCommand, ScheduledEvent, SequenceCommand, SequenceDef, SPGWarning, VoicingStyle,
} from '../../../shared/meta';

/* ==================== 乐理与数值工具 ==================== */

const A4 = 440;
/** 音名 → 八度内的半音数 */
const LETTER_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 解析音名 → MIDI 音高号（C4 = 60）。非法音名抛出可读错误而非静默返回 0。 */
export function getMidi(pitch: string): number {
  const raw = String(pitch ?? '').trim();
  if (!raw) throw new Error('音名为空');

  // 支持直接写频率：440hz
  const hz = raw.match(/^([\d.]+)\s*hz$/i);
  if (hz) {
    const f = parseFloat(hz[1]);
    if (!Number.isFinite(f) || f <= 0) throw new Error(`非法频率 "${raw}"`);
    return 69 + 12 * Math.log2(f / A4);
  }

  const m = raw.match(/^([A-Ga-g])([#♯b♭]{0,3})(-?\d+)$/);
  if (!m) {
    throw new Error(
      `无法识别的音名 "${raw}"（应形如 C4 / F#5 / Bb3 / C#4，或直接写频率如 440hz）`
    );
  }

  let semitone = LETTER_SEMITONES[m[1].toUpperCase()];
  for (const acc of m[2]) {
    semitone += (acc === '#' || acc === '♯') ? 1 : -1;
  }
  return (parseInt(m[3], 10) + 1) * 12 + semitone;
}

/** MIDI 音高号 → 频率 (Hz)，A4 = 440Hz */
export function midiToFreq(midi: number): number {
  return A4 * Math.pow(2, (midi - 69) / 12);
}

/**
 * 解析时值记号到秒。
 *
 * 支持：音符时值 `4n`/`8n`、附点 `4n.`(×1.5) `4n..`(×1.75)、三连音 `4nt`(×2/3)、
 * 小节 `1m`（按 4/4 拍）、绝对时间 `250ms`/`1.5s`、纯数字（按秒）。
 *
 * 非法输入一律抛错：`Infinity` / `NaN` 悄悄流进音频图会导致死循环或静音。
 */
export function parseDuration(dur: string | number, tempo: number): number {
  if (dur === undefined || dur === null || dur === '') {
    throw new Error('时值为空');
  }
  if (typeof dur === 'number') {
    if (!Number.isFinite(dur) || dur < 0) throw new Error(`非法时值 ${dur}`);
    return dur;
  }

  const str = String(dur).trim().toLowerCase();
  if (!str) throw new Error('时值为空');

  // 绝对时间
  if (str.endsWith('ms')) {
    const v = parseFloat(str);
    if (!Number.isFinite(v) || v < 0) throw new Error(`非法时值 "${dur}"`);
    return v / 1000;
  }
  if (str.endsWith('s') && !str.endsWith('ms')) {
    const v = parseFloat(str);
    if (!Number.isFinite(v) || v < 0) throw new Error(`非法时值 "${dur}"`);
    return v;
  }

  if (!Number.isFinite(tempo) || tempo <= 0) {
    throw new Error(`tempo 非法 (${tempo})，必须为正数`);
  }
  const beatTime = 60 / tempo;

  // 附点 / 三连音后缀。附点按"点的个数"累加：单附点 = 1+1/2，
  // 双附点 = 1+1/2+1/4 = 1.75 —— 把 1.5 连乘两次会得到 2.25，多出近 30% 的时值。
  let body = str;
  let dots = 0;
  let triplets = 0;
  let guard = 0;
  while (guard++ < 8) {
    if (body.endsWith('.')) { dots++; body = body.slice(0, -1); continue; }
    if (body.endsWith('t')) { triplets++; body = body.slice(0, -1); continue; }
    break;
  }
  const multiplier = (2 - Math.pow(2, -dots)) * Math.pow(2 / 3, triplets);

  // 小节
  const measure = body.match(/^([\d.]+)m$/);
  if (measure) {
    const n = parseFloat(measure[1]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`非法时值 "${dur}"`);
    return n * 4 * beatTime * multiplier;
  }

  // 音符时值：Nn 表示 1/N 全音符，全音符 = 4 拍
  const note = body.match(/^(\d+)n$/);
  if (note) {
    const denom = parseInt(note[1], 10);
    if (!Number.isFinite(denom) || denom <= 0) throw new Error(`非法时值 "${dur}"`);
    return (4 / denom) * beatTime * multiplier;
  }

  // 纯数字按秒。必须整串都是数字：用 parseFloat 会把 `4x` 这类拼写错误
  // 读成 4 秒，于是"时值写错了"变成"这个音特别长"，错误被静默吞掉。
  if (multiplier === 1 && /^\d+(\.\d+)?$/.test(body)) {
    return parseFloat(body);
  }

  throw new Error(
    `无法解析的时值 "${dur}"（可用 4n / 8n. / 16nt / 1m / 250ms / 1.5s）`
  );
}

/** 将数值钳制在 [min, max] 区间，非有限值回落到 fallback */
export function clamp(value: number, min: number, max: number, fallback = min): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * 确定性伪随机数发生器 (mulberry32)。
 * `humanize` 必须可复现：同一份 SPG 代码每次渲染出的音频应当一致，
 * 否则导出的 WAV 与试听结果会对不上，也无法做回归测试。
 */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成一段可复现的噪声样本数据 */
export function fillNoise(data: Float32Array, color: NoiseColor, rand: () => number): void {
  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = rand() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168981;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return;
  }
  if (color === 'brown') {
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = rand() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    return;
  }
  for (let i = 0; i < data.length; i++) {
    data[i] = rand() * 2 - 1;
  }
}

/* ==================== WAV 编码 ==================== */

/** 16 位 PCM 单声道/立体声 WAV。`len` 超过实际渲染长度时按实际长度截断，避免写出静音尾巴。 */
export function bufferToWave(abuffer: AudioBuffer, len: number): Blob {
  const numOfChan = abuffer.numberOfChannels;
  const frames = Math.max(0, Math.min(len, abuffer.length));
  const dataBytes = frames * numOfChan * 2;
  const length = dataBytes + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  let pos = 0;

  const setUint16 = (data: number) => { view.setUint16(pos, data, true); pos += 2; };
  const setUint32 = (data: number) => { view.setUint32(pos, data, true); pos += 4; };

  // WAVE 头
  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // 文件长度 - 8
  setUint32(0x45564157); // "WAVE"

  setUint32(0x20746d66); // "fmt "
  setUint32(16);         // PCM 头长度
  setUint16(1);          // PCM 未压缩
  setUint16(numOfChan);
  setUint32(abuffer.sampleRate);
  setUint32(abuffer.sampleRate * 2 * numOfChan); // 平均字节率
  setUint16(numOfChan * 2);                      // 块对齐
  setUint16(16);                                 // 位深

  setUint32(0x61746164); // "data"
  setUint32(dataBytes);

  const channels: Float32Array[] = [];
  for (let i = 0; i < numOfChan; i++) channels.push(abuffer.getChannelData(i));

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < numOfChan; ch++) {
      const raw = channels[ch][frame] || 0;
      const clamped = Math.max(-1, Math.min(1, raw));
      const int = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(offset, int, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/* ==================== 和弦符号 ==================== */

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER_ORDER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/**
 * 半音数 → 音级序号（1 = 根音、3 = 三音、5 = 五音、7 = 七音、9/11/13 = 延伸音）。
 *
 * 音名的拼写由**音级**决定，而不是由音高决定：`Cdim7` 的第三个音在钢琴上是 3 个半音，
 * 但它的音级是三音，因此必须写成 `Eb` 而不是 `D#`。只看半音数会得到一堆等音异名，
 * 频率相同但和弦符号变得无法辨认。
 */
const INTERVAL_DEGREE: Record<number, number> = {
  0: 1, 1: 2, 2: 2, 3: 3, 4: 3, 5: 4, 6: 5, 7: 5, 8: 5,
  9: 6, 10: 7, 11: 7, 12: 8, 13: 9, 14: 9, 15: 9,
  16: 11, 17: 11, 18: 11, 19: 12, 20: 13, 21: 13,
};

/** 把 MIDI 音高号拆成音级（0~11）与八度 */
function midiParts(midi: number): { pc: number; octave: number } {
  const rounded = Math.round(midi);
  return { pc: ((rounded % 12) + 12) % 12, octave: Math.floor(rounded / 12) - 1 };
}

/** 用升降号列表把 MIDI 音高号拼成简单音名（不做音级拼写） */
function simpleName(midi: number, preferFlats: boolean): string {
  const { pc, octave } = midiParts(midi);
  return `${(preferFlats ? FLAT_NAMES : SHARP_NAMES)[pc]}${octave}`;
}

/**
 * 按音级拼写和弦音：先由音级决定字母，再按实际音高算出所需的变音记号。
 * 需要双升/双降时（如减七和弦的 `Bbb`）退化为简单音名 —— 合成器并不区分等音，
 * 双降号只会让输出更难读。
 *
 * `semitones` 是实际音高用的音程，`degreeSemitones` 是查音级表用的音程，两者默认相同。
 * 声位变换（open / drop2 / spread）只搬八度、不改音级，所以那里必须把变换**前**的音程
 * 传进来：否则 C 和弦的三音 4 升高八度变成 16，查表命中十一度，拼出 `Fb5` 这种错音名。
 */
function spellChordTone(
  rootLetter: string,
  rootMidi: number,
  semitones: number,
  degreeSemitones: number = semitones
): string {
  const degree = INTERVAL_DEGREE[degreeSemitones];
  const targetMidi = rootMidi + semitones;
  const { pc: targetPc } = midiParts(targetMidi);

  if (degree === undefined) {
    // 未知音程（超出 13 和弦范围）：按"偏向降号"的保守策略拼写
    return simpleName(targetMidi, targetPc === 1 || targetPc === 3 || targetPc === 6 || targetPc === 8 || targetPc === 10);
  }

  const rootIdx = LETTER_ORDER.indexOf(rootLetter);
  const letter = LETTER_ORDER[(rootIdx + degree - 1) % 7];
  const naturalPc = LETTER_SEMITONES[letter];

  let diff = targetPc - naturalPc;
  while (diff > 6) diff -= 12;
  while (diff < -6) diff += 12;

  if (diff > 1 || diff < -1) {
    return simpleName(targetMidi, diff < 0);
  }

  // 八度按"字母 + 变音记号"反推，保证 Cb4 / B#3 这类写法落在正确八度
  let octave = Math.floor(targetMidi / 12) - 1;
  const naturalMidi = (octave + 1) * 12 + naturalPc;
  if (naturalMidi + diff > targetMidi + 0.5) octave -= 1;
  else if (naturalMidi + diff < targetMidi - 0.5) octave += 1;

  const accidental = diff === 1 ? '#' : diff === -1 ? 'b' : '';
  return `${letter}${accidental}${octave}`;
}

/**
 * 和弦性质 → 相对根音的半音音程表。
 *
 * 语法层直接接受和弦符号（`Am7` / `Fmaj9` / `G7/B`）而不是只收音高数组：
 * 要求模型自己展开七和弦/九和弦，既容易漏音写错音程，也只能写出密集排列，
 * 拿不到转位、开放排列、省略音这些真实编曲手法。展开交给引擎按确定规则做，
 * 模型只负责"和声进行"这一它真正擅长的高层决策。
 */
const CHORD_INTERVALS: Record<string, number[]> = {
  /* --- 三和弦 --- */
  '': [0, 4, 7],
  'maj': [0, 4, 7],
  'M': [0, 4, 7],
  'major': [0, 4, 7],
  'm': [0, 3, 7],
  'min': [0, 3, 7],
  'minor': [0, 3, 7],
  '-': [0, 3, 7],
  'dim': [0, 3, 6],
  'o': [0, 3, 6],
  'aug': [0, 4, 8],
  '+': [0, 4, 8],
  '5': [0, 7],

  /* --- 挂留 --- */
  'sus': [0, 5, 7],
  'sus4': [0, 5, 7],
  'sus2': [0, 2, 7],
  // 挂留七和弦必须进表：通用展开分支处理不了 sus 前缀与七度的组合，
  // 而 7sus4 是流行/爵士里最常见的挂留写法。
  '7sus4': [0, 5, 7, 10],
  '7sus2': [0, 2, 7, 10],
  '9sus4': [0, 5, 7, 10, 14],
  'maj7sus4': [0, 5, 7, 11],
  'm7sus4': [0, 5, 7, 10],
  '13sus4': [0, 5, 7, 10, 14, 21],

  /* --- 六和弦 --- */
  '6': [0, 4, 7, 9],
  'm6': [0, 3, 7, 9],
  'min6': [0, 3, 7, 9],

  /* --- 七和弦 --- */
  '7': [0, 4, 7, 10],
  'dom7': [0, 4, 7, 10],
  'maj7': [0, 4, 7, 11],
  'M7': [0, 4, 7, 11],
  'Δ7': [0, 4, 7, 11],
  'm7': [0, 3, 7, 10],
  'min7': [0, 3, 7, 10],
  '-7': [0, 3, 7, 10],
  'm7b5': [0, 3, 6, 10],
  'min7b5': [0, 3, 6, 10],
  'ø': [0, 3, 6, 10],
  'ø7': [0, 3, 6, 10],
  'dim7': [0, 3, 6, 9],
  'o7': [0, 3, 6, 9],
  'mM7': [0, 3, 7, 11],
  'mMaj7': [0, 3, 7, 11],
  'minMaj7': [0, 3, 7, 11],
  'mM9': [0, 3, 7, 11, 14],
  'aug7': [0, 4, 8, 10],
  '+7': [0, 4, 8, 10],
  'augM7': [0, 4, 8, 11],

  /* --- 加音 --- */
  'add9': [0, 4, 7, 14],
  'add2': [0, 4, 7, 14],
  'madd9': [0, 3, 7, 14],
  'add11': [0, 4, 7, 17],
  'add4': [0, 4, 7, 17],
  'add6': [0, 4, 7, 9],
  'madd6': [0, 3, 7, 9],

  /* --- 九和弦 --- */
  '9': [0, 4, 7, 10, 14],
  'dom9': [0, 4, 7, 10, 14],
  'maj9': [0, 4, 7, 11, 14],
  'M9': [0, 4, 7, 11, 14],
  'm9': [0, 3, 7, 10, 14],
  'min9': [0, 3, 7, 10, 14],
  '6/9': [0, 4, 7, 9, 14],
  '69': [0, 4, 7, 9, 14],
  'm6/9': [0, 3, 7, 9, 14],

  /* --- 十一 / 十三和弦 --- */
  '11': [0, 4, 7, 10, 14, 17],
  'maj11': [0, 4, 7, 11, 14, 17],
  'm11': [0, 3, 7, 10, 14, 17],
  '13': [0, 4, 7, 10, 14, 21],
  'maj13': [0, 4, 7, 11, 14, 21],
  'm13': [0, 3, 7, 10, 14, 21],
};

/**
 * 变化音的半音偏移（在基础音程上叠加）。
 *
 * `degree` 必须是该音级的**自然音程**：展开时先删掉自然音程、再插入 `degree + shift`。
 * 若写成 `#11` 的实际音高 18，`delete(18)` 删的是个不存在的音，`add(19)` 得到的 19
 * 正好等于五度音高八度（7+12）—— `C7#11` 里凭空多出一个重复的 G，真正的 F# 反而没有。
 */
const ALTERATIONS: Record<string, { degree: number; shift: number }> = {
  'b5': { degree: 7, shift: -1 },
  '#5': { degree: 7, shift: 1 },
  'b9': { degree: 14, shift: -1 },
  '#9': { degree: 14, shift: 1 },
  'b13': { degree: 21, shift: -1 },
  '#11': { degree: 17, shift: 1 },
  'b11': { degree: 17, shift: -1 },
};

/** 解析根音/低音音名（允许 #/b/♯/♭），返回 { name, pitchClass } */
function parseNoteName(text: string): { name: string; pitchClass: number } | null {
  const m = /^([A-Ga-g])([#b♯♭]*)$/.exec(text.trim());
  if (!m) return null;
  const letter = m[1].toUpperCase();
  let pc = LETTER_SEMITONES[letter];
  for (const acc of m[2]) pc += acc === '#' || acc === '♯' ? 1 : -1;
  return { name: letter + m[2], pitchClass: ((pc % 12) + 12) % 12 };
}

/**
 * 展开无法在表里直接命中的和弦性质，处理 `<基础三和弦><扩展音><变化音>` 的组合
 * （`m7#5`、`7b9`、`maj9#11`）。无法识别时返回 null，由调用方报错 ——
 * 宁可报错也不要静默给出错误和声。
 */
function expandQuality(quality: string): number[] | null {
  let rest = quality;
  let base: number[];
  /** `maj` 前缀决定七度是**大七度**(11) 而不是属七度(10) */
  let majorSeventh = false;
  /**
   * 减和弦基线（dim/o）的七度是**减七度**(9)：`Co9` = dim7 + 9 = [0,3,6,9,14]。
   * 不区分的话"隐含七度"规则会补一个属七度 10，减九和弦静默变成半减九和弦。
   * 半减（ø）仍用小七度 10，与普通分支一致。
   */
  let dimSeventh = false;

  if (/^(min|minor|-)/.test(rest)) { base = [0, 3, 7]; rest = rest.replace(/^(min|minor|-)/, ''); }
  else if (/^(maj|major|M|Δ)/.test(rest)) { base = [0, 4, 7]; majorSeventh = true; rest = rest.replace(/^(maj|major|M|Δ)/, ''); }
  // dim/o 基线不能加 (?![0-9]) 守卫：'o7' 这类有和弦表直接命中、根本到不了这里，
  // 加了守卫反而让 'o9'/'o11' 掉进大三和弦基线，减和弦静默变成属和弦。
  else if (/^(dim|o)/.test(rest)) { base = [0, 3, 6]; dimSeventh = true; rest = rest.replace(/^(dim|o)/, ''); }
  else if (/^ø/.test(rest)) { base = [0, 3, 6]; rest = rest.replace(/^ø/, ''); }
  else if (/^(aug|\+)/.test(rest)) { base = [0, 4, 8]; rest = rest.replace(/^(aug|\+)/, ''); }
  // sus2 必须在 sus4 之前：/^(sus4?)/ 会把 'sus2' 的 'sus' 吃掉，剩下 '2' 无法识别。
  else if (/^sus2/.test(rest)) { base = [0, 2, 7]; rest = rest.replace(/^sus2/, ''); }
  else if (/^(sus4?)/.test(rest)) { base = [0, 5, 7]; rest = rest.replace(/^sus4?/, ''); }
  else if (/^m/.test(rest)) { base = [0, 3, 7]; rest = rest.replace(/^m/, ''); }
  else { base = [0, 4, 7]; }

  const intervals = new Set<number>(base);
  let matched = false;

  // 变化音优先（`b5` 必须整体识别，不能被拆成 `b` + `5`）
  for (const key of Object.keys(ALTERATIONS)) {
    if (rest.includes(key)) {
      const { degree, shift } = ALTERATIONS[key];
      intervals.delete(degree);
      intervals.add(degree + shift);
      rest = rest.split(key).join('');
      matched = true;
    }
  }

  /**
   * 扩展音标志必须在变化音摘除**之后**取。
   *
   * 反过来的话，变化音里的数字会被当成自然扩展音：`#11` 含子串 `11`，
   * 于是 `C7#11` 在插入 F# 之后又被 has11 分支补回一个自然十一度 F，
   * 得到一个既有 F 又有 F# 的和弦。后取不会让 `C#9` 丢掉隐含七度 ——
   * `#` 已被根音正则吃进根音，rest 就是干净的 `9`。
   */
  const has7 = /7/.test(rest);
  const has9 = /9/.test(rest);
  const has11 = /11/.test(rest);
  const has13 = /13/.test(rest);
  const has6 = /6/.test(rest);
  // 单独的 2 = add9（如 C2）：流行写法，不认会报"无法识别的和弦符号"。
  // sus2 到这里 rest 已被基线分支吃干净，不会误伤。
  const has2 = /(^|[^0-9])2([^0-9]|$)/.test(rest);

  // 省略音
  if (/(no|omit)3/.test(rest)) { intervals.delete(3); intervals.delete(4); rest = rest.replace(/(no|omit)3/, ''); matched = true; }
  if (/(no|omit)5/.test(rest)) { intervals.delete(7); rest = rest.replace(/(no|omit)5/, ''); matched = true; }

  // `add` 系列只加音、不含七度，必须先摘掉再解析扩展音，否则会被当成普通 9/11 而补上七度
  const isAdd = /add/.test(rest);
  if (isAdd) rest = rest.replace(/add/g, '');

  if (has2) intervals.add(14);
  if (has9) intervals.add(14);
  if (has11) { intervals.add(14); intervals.add(17); }   // 11 隐含 9
  if (has13) { intervals.add(14); intervals.add(21); }   // 13 隐含 9
  if (has7 || has9 || has11 || has13) matched = true;

  /**
   * 七度：显式写 `7`，或由 9 / 11 / 13 **隐含**（与和弦表保持一致 ——
   * 表里 `C9`/`C11`/`C13` 都含属七度）。否则 `C9#11` 会得到没有七度的和弦，
   * 而 `C9` 有 —— 同一个 9 和弦加个变化音就成了完全不同的和声。
   */
  if (!isAdd && (has7 || has9 || has11 || has13)) {
    intervals.add(majorSeventh ? 11 : dimSeventh ? 9 : 10);
  }
  if (has6) { intervals.add(9); matched = true; }
  if (has2) matched = true;

  // 摘掉已识别的扩展音数字；剩下的才是真正无法识别的字符
  rest = rest.replace(/1[13]|[679]|2/g, '');

  if (rest.replace(/[()\s]/g, '').length > 0) return null;
  if (!matched) return null;

  return Array.from(intervals).sort((a, b) => a - b);
}

/** 解析和弦符号（`Am7` / `Fmaj9` / `G7/B`），失败返回 null */
export function parseChordSymbol(text: string): ChordSymbol | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  // 斜杠低音：`C/E`、`Am7/G`
  const slash = raw.lastIndexOf('/');
  let body = raw;
  let bass: string | null = null;
  if (slash > 0) {
    const bassParsed = parseNoteName(raw.slice(slash + 1));
    if (bassParsed) {
      bass = bassParsed.name;
      body = raw.slice(0, slash);
    }
  }

  const rootMatch = /^([A-Ga-g])([#b♯♭]*)(.*)$/.exec(body.trim());
  if (!rootMatch) return null;
  const rootParsed = parseNoteName(rootMatch[1] + rootMatch[2]);
  if (!rootParsed) return null;

  const qualityRaw = rootMatch[3].trim();
  /**
   * 多字母性质的大小写归一：'MAJ7'/'Maj7' 必须等于 'maj7'。
   * 不归一的后果是静默错和声 —— expandQuality 的基线分支全是小写，
   * 'MAJ7' 匹配不上 maj、也匹配不上大小写敏感的 /^m/，于是掉进大三和弦基线
   * 再补一个属七度：maj7 静默变成 dominant 7。
   * 单字母 'm'/'M' 不碰（大小写区分小七与大七，是刻意的设计）。
   */
  const qualityNorm = qualityRaw.replace(/^(maj|min|dim|aug|sus|add)/i,
    (m) => m.toLowerCase());
  const direct = CHORD_INTERVALS[qualityNorm] ?? CHORD_INTERVALS[qualityNorm.replace(/\s+/g, '')];
  const intervals = direct ?? expandQuality(qualityNorm);
  if (!intervals || intervals.length === 0) return null;

  return { root: rootParsed.name, quality: qualityRaw, bass, intervals: [...intervals] };
}

/**
 * 把和弦符号展开成带八度的音名数组。
 *
 * 声位规则：
 * - `close`  密集排列：全部音挤在一个八度内（键盘/铺底最常用）
 * - `open`   开放排列：三音升高一个八度，音域更宽
 * - `drop2`  从上往下数第二个音降低一个八度（爵士钢琴的标准左手声位）
 * - `spread` 相邻音交替向上八度，跨度最大的铺底声位
 *
 * 斜杠低音额外在根音下方补一个低音，而不是替换原有声部 ——
 * 这样 `C/E` 仍是完整的 C 和弦，只是转位，符合和声学直觉。
 */
export function voicingToPitches(
  chord: ChordSymbol,
  octave: number,
  voicing: VoicingStyle = 'close'
): string[] {
  const rootLetter = chord.root[0].toUpperCase();
  // 变音记号要数个数：'Bbb' 是降两次（-2），includes 只算一次会让整个和弦错位两个半音，
  // 而频率"听起来差不多"，极难排查。
  const rootSharps = (chord.root.match(/[#♯]/g) || []).length;
  const rootFlats = (chord.root.match(/[b♭]/g) || []).length;
  const rootMidi = (octave + 1) * 12 + (LETTER_SEMITONES[rootLetter] ?? 0)
    + rootSharps - rootFlats;

  const preferFlats = /[b♭]/.test(chord.root) || /[b♭]/.test(chord.quality);

  let intervals = [...chord.intervals];
  /** 每个音**变换前**的音程，用于查音级表（声位变换只搬八度、不改音级） */
  const degreeIntervals = [...chord.intervals];

  if (voicing === 'open') {
    if (intervals.length > 1) intervals[1] += 12;
  } else if (voicing === 'drop2') {
    if (intervals.length >= 3) intervals[intervals.length - 2] -= 12;
  } else if (voicing === 'spread') {
    intervals = intervals.map((iv, i) => (i % 2 === 1 ? iv + 12 : iv));
  }

  const pitches = intervals
    .map((iv, i) => spellChordTone(rootLetter, rootMidi, iv, degreeIntervals[i]))
    .sort((a, b) => getMidi(a) - getMidi(b));

  if (chord.bass) {
    const bassParsed = parseNoteName(chord.bass);
    if (bassParsed) {
      // 低音放在根音下方一个八度内的最近位置，形成转位而不是另加一个低八度声部
      const bassMidi = rootMidi + ((bassParsed.pitchClass - (((rootMidi % 12) + 12) % 12) + 12) % 12) - 12;
      pitches.unshift(simpleName(bassMidi, /[b♭]/.test(chord.bass) || preferFlats));
    }
  }

  // 去重（drop2 / spread 可能产生同音）
  return Array.from(new Set(pitches)).sort((a, b) => getMidi(a) - getMidi(b));
}

/** 全部内置和弦性质名，供提示词与报错信息自动列出 */
export const CHORD_QUALITY_NAMES = Object.keys(CHORD_INTERVALS);

/* ==================== 鼓组音色表 ==================== */

/**
 * 内置鼓组合成器。
 *
 * 让模型不必先定义乐器就能写节奏声部（直接 `hit("kick", "4n")`）。三种合成模型：
 * - `membrane` 带音高包络的正弦膜振动（底鼓 / 通鼓）
 * - `noise`    噪声为主、带通塑形（军鼓 / 拍手 / 沙锤）
 * - `metallic` 多个非谐方波分音叠加（镲片 / 踩镲 / 牛铃）
 */
export const DRUM_SPECS: Record<DrumName, DrumSpec> = {
  kick: {
    model: 'membrane', freq: 52, pitchAmount: 26, pitchDecay: 0.045, decay: 0.34,
    noise: 0.06, noiseFilter: 'lowpass', noiseFreq: 3000, noiseQ: 0.5,
    gain: 1.0, highpass: 28,
  },
  sub_kick: {
    model: 'membrane', freq: 38, pitchAmount: 14, pitchDecay: 0.08, decay: 0.62,
    noise: 0, noiseFilter: 'lowpass', noiseFreq: 800, noiseQ: 0.5,
    gain: 1.0, highpass: 24,
  },
  snare: {
    model: 'noise', freq: 190, pitchAmount: 10, pitchDecay: 0.03, decay: 0.19,
    noise: 0.85, noiseFilter: 'highpass', noiseFreq: 1400, noiseQ: 0.6,
    gain: 0.8, highpass: 160,
  },
  rim: {
    model: 'noise', freq: 420, pitchAmount: 6, pitchDecay: 0.01, decay: 0.05,
    noise: 0.7, noiseFilter: 'bandpass', noiseFreq: 2600, noiseQ: 3.0,
    gain: 0.6, highpass: 500,
  },
  clap: {
    model: 'noise', freq: 300, pitchAmount: 0, pitchDecay: 0.01, decay: 0.28,
    noise: 1.0, noiseFilter: 'bandpass', noiseFreq: 1300, noiseQ: 1.4,
    gain: 0.7, highpass: 400,
  },
  hat: {
    model: 'metallic', freq: 320, pitchAmount: 0, pitchDecay: 0.01, decay: 0.055,
    noise: 0.35, noiseFilter: 'highpass', noiseFreq: 8000, noiseQ: 0.7,
    ratios: [2.0, 3.0, 4.16, 5.43, 6.79, 8.21], gain: 0.45, highpass: 6000,
  },
  open_hat: {
    model: 'metallic', freq: 320, pitchAmount: 0, pitchDecay: 0.01, decay: 0.42,
    noise: 0.35, noiseFilter: 'highpass', noiseFreq: 7500, noiseQ: 0.7,
    ratios: [2.0, 3.0, 4.16, 5.43, 6.79, 8.21], gain: 0.42, highpass: 5500,
  },
  pedal_hat: {
    model: 'metallic', freq: 300, pitchAmount: 0, pitchDecay: 0.01, decay: 0.09,
    noise: 0.3, noiseFilter: 'highpass', noiseFreq: 6500, noiseQ: 0.8,
    ratios: [2.0, 3.0, 4.16, 5.43], gain: 0.38, highpass: 4000,
  },
  tom_low: {
    model: 'membrane', freq: 92, pitchAmount: 12, pitchDecay: 0.09, decay: 0.5,
    noise: 0.12, noiseFilter: 'lowpass', noiseFreq: 2500, noiseQ: 0.5,
    gain: 0.8, highpass: 50,
  },
  tom_mid: {
    model: 'membrane', freq: 132, pitchAmount: 12, pitchDecay: 0.08, decay: 0.42,
    noise: 0.12, noiseFilter: 'lowpass', noiseFreq: 2800, noiseQ: 0.5,
    gain: 0.8, highpass: 60,
  },
  tom_high: {
    model: 'membrane', freq: 186, pitchAmount: 12, pitchDecay: 0.07, decay: 0.36,
    noise: 0.12, noiseFilter: 'lowpass', noiseFreq: 3200, noiseQ: 0.5,
    gain: 0.78, highpass: 80,
  },
  crash: {
    model: 'metallic', freq: 280, pitchAmount: 0, pitchDecay: 0.01, decay: 1.9,
    noise: 0.5, noiseFilter: 'highpass', noiseFreq: 4500, noiseQ: 0.5,
    ratios: [2.0, 3.0, 4.16, 5.43, 6.79, 8.21, 9.87], gain: 0.4, highpass: 2500,
  },
  ride: {
    model: 'metallic', freq: 420, pitchAmount: 0, pitchDecay: 0.01, decay: 1.3,
    noise: 0.22, noiseFilter: 'highpass', noiseFreq: 6000, noiseQ: 0.6,
    ratios: [2.0, 3.0, 4.16, 5.43, 6.79], gain: 0.38, highpass: 3000,
  },
  cowbell: {
    model: 'metallic', freq: 540, pitchAmount: 0, pitchDecay: 0.01, decay: 0.32,
    noise: 0.05, noiseFilter: 'bandpass', noiseFreq: 2600, noiseQ: 2.0,
    ratios: [1.0, 1.48], gain: 0.45, highpass: 400,
  },
  shaker: {
    model: 'noise', freq: 200, pitchAmount: 0, pitchDecay: 0.01, decay: 0.11,
    noise: 1.0, noiseFilter: 'highpass', noiseFreq: 5200, noiseQ: 0.9,
    gain: 0.4, highpass: 2200,
  },
  tambourine: {
    model: 'noise', freq: 260, pitchAmount: 0, pitchDecay: 0.01, decay: 0.3,
    noise: 0.9, noiseFilter: 'bandpass', noiseFreq: 6800, noiseQ: 1.1,
    gain: 0.42, highpass: 3000,
  },
};

/**
 * 全部可用鼓组名，供 UI 与提示词自动列出。
 * 从 DRUM_SPECS 派生而非另抄一份：解析器认了某个名字、合成器却查不到音色时，
 * 只会静默不发声，两边必须同源。
 */
export const DRUM_NAMES = Object.keys(DRUM_SPECS) as DrumName[];

/* ==================== 音色预设库 ==================== */

/**
 * 内置音色预设库。
 *
 * 约定：`fm_wave` 必须是真正的振荡器波形（sine/square/sawtooth/triangle），
 * 不能写噪声 —— OscillatorNode.type 不接受噪声名，会在调度期抛异常。
 * 需要噪声质感请用 `attack_noise` 或直接使用 noise 波形作为主波形。
 */
export const PRESETS: Record<string, Partial<InstrumentDef>> = {
  /* ============================ 键盘 / 电子 ============================ */

  'piano': {
    wave: 'sine',
    envelope: { attack: 0.004, decay: 1.6, sustain: 0.08, release: 0.5, curve: 'exp' },
    // 真实钢琴的锤击感来自快速衰减的高次谐波
    fm_wave: 'triangle',
    fm_ratio: 3.0,
    fm_index: 180,
    pitchEnvAmount: 0,
    gain: 0.75,
    detune: 2,
    voices: 2,
    unisonSpread: 3,
    filter: { type: 'lowpass', frequency: 6000, Q: 0.4 },
    filterEnvelope: { attack: 0.002, decay: 1.2, sustain: 0.15, release: 0.4 },
    filterEnvAmount: 2500,
    velocitySensitivity: 0.85,
    velocityToFilter: 3000,
  },

  'electric_piano': {
    wave: 'sine',
    envelope: { attack: 0.005, decay: 1.4, sustain: 0.12, release: 0.6, curve: 'exp' },
    // DX7 电钢的经典 1:1 FM 钟声成分
    fm_wave: 'sine',
    fm_ratio: 1.0,
    fm_index: 320,
    gain: 0.7,
    detune: 3,
    voices: 2,
    unisonSpread: 4,
    filter: { type: 'lowpass', frequency: 4500, Q: 0.5 },
    velocitySensitivity: 0.9,
    velocityToFilter: 2000,
    effects: [{ type: 'chorus', rate: 0.8, depth: 3, mix: 0.35 }],
  },

  'organ': {
    wave: 'sine',
    envelope: { attack: 0.01, decay: 0.05, sustain: 1.0, release: 0.08 },
    // 用谐波叠加模拟音栓（drawbar）音色
    harmonics: [1, 0.5, 0.35, 0.2, 0.15, 0.1, 0.08, 0.05],
    gain: 0.6,
    filter: { type: 'lowpass', frequency: 5000, Q: 0.3 },
    effects: [{ type: 'tremolo', rate: 6.5, depth: 0.25 }],
  },

  'harpsichord': {
    wave: 'sawtooth',
    envelope: { attack: 0.002, decay: 0.9, sustain: 0.0, release: 0.3, curve: 'exp' },
    filter: { type: 'highpass', frequency: 300, Q: 0.5 },
    fm_wave: 'square',
    fm_ratio: 4.0,
    fm_index: 60,
    gain: 0.65,
    detune: 4,
    voices: 2,
    unisonSpread: 6,
  },

  'clavinet': {
    wave: 'square',
    envelope: { attack: 0.002, decay: 0.35, sustain: 0.05, release: 0.12, curve: 'exp' },
    filter: { type: 'bandpass', frequency: 1600, Q: 1.2 },
    filterEnvelope: { attack: 0.001, decay: 0.25, sustain: 0.0, release: 0.1 },
    filterEnvAmount: 1800,
    gain: 0.65,
    velocitySensitivity: 0.8,
    velocityToFilter: 2000,
  },

  /* ============================ 合成器 ============================ */

  'synth_pad': {
    wave: 'sawtooth',
    envelope: { attack: 1.5, decay: 2.0, sustain: 0.6, release: 2.5, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 400, Q: 0.5 },
    filterEnvelope: { attack: 2.0, decay: 1.0, sustain: 0.8, release: 2.0, curve: 'linear' },
    filterEnvAmount: 800,
    detune: 15,
    voices: 3,
    unisonSpread: 14,
    spread: 0.7,
    gain: 0.45,
    lfo: { type: 'sine', frequency: 0.3, amount: 6, target: 'filter', ramp: 1.0 },
  },

  'warm_pad': {
    wave: 'triangle',
    envelope: { attack: 2.2, decay: 2.0, sustain: 0.75, release: 3.0, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 900, Q: 0.4 },
    detune: 10,
    voices: 3,
    unisonSpread: 10,
    spread: 0.8,
    gain: 0.5,
    lfo: { type: 'sine', frequency: 0.15, amount: 400, target: 'filter', ramp: 2.0 },
  },

  'supersaw': {
    wave: 'sawtooth',
    envelope: { attack: 0.01, decay: 0.4, sustain: 0.85, release: 0.3 },
    filter: { type: 'lowpass', frequency: 4000, Q: 1.2 },
    filterEnvelope: { attack: 0.01, decay: 0.5, sustain: 0.5, release: 0.3 },
    filterEnvAmount: 4000,
    detune: 22,
    voices: 5,
    unisonSpread: 20,
    spread: 0.9,
    gain: 0.35,
  },

  'lead_square': {
    wave: 'square',
    envelope: { attack: 0.01, decay: 0.15, sustain: 0.7, release: 0.15 },
    filter: { type: 'lowpass', frequency: 3000, Q: 2 },
    filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.15 },
    filterEnvAmount: 2500,
    detune: 6,
    voices: 2,
    unisonSpread: 8,
    gain: 0.5,
    glide: 0.05,
    glideFrom: -12,
  },

  'chiptune': {
    wave: 'square',
    envelope: { attack: 0.001, decay: 0.08, sustain: 0.6, release: 0.05, curve: 'hold' },
    gain: 0.45,
    pitchEnvAmount: 0,
  },

  'bass': {
    wave: 'sawtooth',
    envelope: { attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.1 },
    filter: { type: 'lowpass', frequency: 100, Q: 2 },
    filterEnvelope: { attack: 0.02, decay: 0.3, sustain: 0.0, release: 0.1 },
    filterEnvAmount: 500,
    detune: 4,
    voices: 2,
    unisonSpread: 5,
    gain: 0.8,
    velocitySensitivity: 0.5,
  },

  'sub_bass': {
    wave: 'sine',
    envelope: { attack: 0.01, decay: 0.3, sustain: 0.9, release: 0.15 },
    gain: 0.9,
    filter: { type: 'lowpass', frequency: 180, Q: 0.7 },
    glide: 0.06,
    glideFrom: -12,
    velocitySensitivity: 0.3,
  },

  'reese_bass': {
    wave: 'sawtooth',
    envelope: { attack: 0.02, decay: 0.4, sustain: 0.85, release: 0.2 },
    filter: { type: 'lowpass', frequency: 350, Q: 3 },
    filterEnvelope: { attack: 0.05, decay: 0.6, sustain: 0.3, release: 0.2 },
    filterEnvAmount: 900,
    detune: 30,
    voices: 3,
    unisonSpread: 28,
    gain: 0.5,
    lfo: { type: 'sine', frequency: 0.4, amount: 300, target: 'filter', ramp: 0.5 },
  },

  'acid': {
    wave: 'sawtooth',
    envelope: { attack: 0.01, decay: 0.4, sustain: 0.0, release: 0.1, curve: 'exp' },
    filter: { type: 'lowpass', frequency: 200, Q: 8 },
    filterEnvelope: { attack: 0.05, decay: 0.3, sustain: 0.1, release: 0.1 },
    filterEnvAmount: 1500,
    gain: 0.6,
    glide: 0.06,
    glideFrom: -12,
    velocitySensitivity: 0.6,
    velocityToFilter: 1500,
  },

  'plucked_synth': {
    wave: 'square',
    envelope: { attack: 0.005, decay: 2.0, sustain: 0.0, release: 0.1, curve: 'exp' },
    filter: { type: 'lowpass', frequency: 300, Q: 1 },
    filterEnvelope: { attack: 0.005, decay: 0.5, sustain: 0.0, release: 0.1 },
    filterEnvAmount: 2000,
    gain: 0.6,
    detune: 6,
    voices: 2,
    unisonSpread: 8,
  },

  'bell': {
    wave: 'sine',
    envelope: { attack: 0.002, decay: 2.5, sustain: 0.0, release: 1.5, curve: 'exp' },
    // 非整数比率产生金属钟声的非谐分音
    fm_wave: 'sine',
    fm_ratio: 3.5,
    fm_index: 420,
    gain: 0.55,
    voices: 2,
    unisonSpread: 5,
  },

  'marimba': {
    wave: 'sine',
    envelope: { attack: 0.002, decay: 0.6, sustain: 0.0, release: 0.25, curve: 'exp' },
    fm_wave: 'sine',
    fm_ratio: 4.0,
    fm_index: 220,
    gain: 0.7,
    filter: { type: 'lowpass', frequency: 3500, Q: 0.5 },
    velocitySensitivity: 0.85,
  },

  'music_box': {
    wave: 'triangle',
    envelope: { attack: 0.001, decay: 1.2, sustain: 0.0, release: 0.6, curve: 'exp' },
    fm_wave: 'sine',
    fm_ratio: 7.0,
    fm_index: 150,
    gain: 0.5,
    filter: { type: 'highpass', frequency: 800, Q: 0.4 },
  },

  'glass': {
    wave: 'triangle',
    envelope: { attack: 0.4, decay: 1.5, sustain: 0.35, release: 1.8, curve: 'linear' },
    harmonics: [1, 0.2, 0.5, 0.1, 0.3, 0.05, 0.15],
    gain: 0.45,
    detune: 8,
    voices: 2,
    unisonSpread: 12,
    lfo: { type: 'sine', frequency: 4.5, amount: 4, target: 'frequency', ramp: 0.8 },
  },

  /* ============================ 拨弦 / 弹拨 ============================ */

  'guitar': {
    wave: 'triangle',
    envelope: { attack: 0.004, decay: 0.9, sustain: 0.06, release: 0.25, curve: 'exp' },
    filter: { type: 'lowpass', frequency: 2200, Q: 0.6 },
    filterEnvelope: { attack: 0.003, decay: 0.5, sustain: 0.1, release: 0.2 },
    filterEnvAmount: 1500,
    gain: 0.6,
    detune: 3,
    voices: 2,
    unisonSpread: 4,
    attackNoise: 0.25,
    velocitySensitivity: 0.8,
    velocityToFilter: 2500,
  },

  'nylon_guitar': {
    wave: 'triangle',
    envelope: { attack: 0.006, decay: 1.1, sustain: 0.04, release: 0.3, curve: 'exp' },
    filter: { type: 'lowpass', frequency: 1600, Q: 0.5 },
    gain: 0.6,
    detune: 2,
    voices: 2,
    unisonSpread: 3,
    attackNoise: 0.3,
    velocitySensitivity: 0.85,
  },

  'electric_guitar': {
    wave: 'sawtooth',
    envelope: { attack: 0.008, decay: 1.2, sustain: 0.2, release: 0.4, curve: 'exp' },
    filter: { type: 'lowpass', frequency: 2400, Q: 1.5 },
    filterEnvelope: { attack: 0.005, decay: 0.6, sustain: 0.3, release: 0.3 },
    filterEnvAmount: 2000,
    gain: 0.5,
    detune: 4,
    voices: 2,
    unisonSpread: 6,
    attackNoise: 0.15,
    velocitySensitivity: 0.7,
    effects: [
      { type: 'distortion', amount: 0.45, mix: 0.8 },
      { type: 'delay', time: 0.32, feedback: 0.28, mix: 0.22, damping: 2200 },
    ],
  },

  'harp': {
    wave: 'triangle',
    envelope: { attack: 0.004, decay: 2.2, sustain: 0.0, release: 1.2, curve: 'exp' },
    filter: { type: 'lowpass', frequency: 4000, Q: 0.3 },
    gain: 0.6,
    voices: 2,
    unisonSpread: 4,
    attackNoise: 0.12,
  },

  'pizzicato': {
    wave: 'sawtooth',
    envelope: { attack: 0.002, decay: 0.22, sustain: 0.0, release: 0.08, curve: 'exp' },
    filter: { type: 'lowpass', frequency: 1400, Q: 1.5 },
    filterEnvelope: { attack: 0.001, decay: 0.12, sustain: 0.0, release: 0.05 },
    filterEnvAmount: 1800,
    gain: 0.65,
    attackNoise: 0.2,
    velocitySensitivity: 0.8,
  },

  /* ============================ 管弦乐 ============================ */

  'violin': {
    wave: 'sawtooth',
    envelope: { attack: 0.35, decay: 0.4, sustain: 0.85, release: 0.45, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 2600, Q: 1.2 },
    filterEnvelope: { attack: 0.3, decay: 0.5, sustain: 0.8, release: 0.4 },
    filterEnvAmount: 900,
    // 颤音是弦乐的灵魂：带淡入，避免起音瞬间音高抖动
    lfo: { type: 'sine', frequency: 5.8, amount: 9, target: 'frequency', ramp: 0.5 },
    detune: 5,
    voices: 2,
    unisonSpread: 7,
    spread: 0.25,
    gain: 0.55,
    attackNoise: 0.1,
    velocitySensitivity: 0.75,
    velocityToFilter: 1800,
  },

  'viola': {
    wave: 'sawtooth',
    envelope: { attack: 0.4, decay: 0.45, sustain: 0.85, release: 0.5, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 1800, Q: 1.0 },
    lfo: { type: 'sine', frequency: 5.2, amount: 8, target: 'frequency', ramp: 0.6 },
    detune: 6,
    voices: 2,
    unisonSpread: 8,
    spread: 0.25,
    gain: 0.55,
    attackNoise: 0.12,
    velocitySensitivity: 0.75,
  },

  'cello': {
    wave: 'sawtooth',
    envelope: { attack: 0.45, decay: 0.5, sustain: 0.9, release: 0.6, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 1000, Q: 0.9 },
    lfo: { type: 'sine', frequency: 4.6, amount: 7, target: 'frequency', ramp: 0.7 },
    detune: 8,
    voices: 2,
    unisonSpread: 9,
    gain: 0.6,
    // 木质琴箱共鸣
    fm_wave: 'triangle',
    fm_ratio: 2.0,
    fm_index: 40,
    attackNoise: 0.14,
    velocitySensitivity: 0.75,
    velocityToFilter: 1200,
  },

  'contrabass': {
    wave: 'sawtooth',
    envelope: { attack: 0.5, decay: 0.6, sustain: 0.9, release: 0.7, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 600, Q: 0.8 },
    detune: 10,
    voices: 2,
    unisonSpread: 10,
    gain: 0.65,
    attackNoise: 0.16,
  },

  'strings_section': {
    wave: 'sawtooth',
    envelope: { attack: 0.8, decay: 1.0, sustain: 1.0, release: 1.2, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 1600, Q: 0.5 },
    filterEnvelope: { attack: 0.9, decay: 1.2, sustain: 0.85, release: 1.0, curve: 'linear' },
    filterEnvAmount: 700,
    detune: 22,
    voices: 3,
    unisonSpread: 20,
    spread: 0.85,
    gain: 0.4,
    attackNoise: 0.08,
    lfo: { type: 'sine', frequency: 5.0, amount: 5, target: 'frequency', ramp: 1.2 },
  },

  'solo_strings': {
    wave: 'sawtooth',
    envelope: { attack: 0.3, decay: 0.4, sustain: 0.9, release: 0.5, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 2200, Q: 1.0 },
    detune: 6,
    voices: 2,
    unisonSpread: 6,
    gain: 0.6,
    attackNoise: 0.12,
    lfo: { type: 'sine', frequency: 5.5, amount: 10, target: 'frequency', ramp: 0.4 },
  },

  'brass_ensemble': {
    wave: 'sawtooth',
    envelope: { attack: 0.1, decay: 0.3, sustain: 0.75, release: 0.4, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 400, Q: 1 },
    // 铜管标志性的 "Swell"：滤波器随音量打开
    filterEnvelope: { attack: 0.15, decay: 0.3, sustain: 0.5, release: 0.4 },
    filterEnvAmount: 2000,
    detune: 10,
    voices: 2,
    unisonSpread: 10,
    spread: 0.5,
    gain: 0.55,
    attackNoise: 0.1,
    velocitySensitivity: 0.8,
    velocityToFilter: 2500,
  },

  'trumpet': {
    wave: 'sawtooth',
    envelope: { attack: 0.06, decay: 0.25, sustain: 0.8, release: 0.25, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 900, Q: 1.4 },
    filterEnvelope: { attack: 0.08, decay: 0.3, sustain: 0.6, release: 0.25 },
    filterEnvAmount: 2600,
    gain: 0.6,
    lfo: { type: 'sine', frequency: 5.5, amount: 7, target: 'frequency', ramp: 0.5 },
    velocitySensitivity: 0.85,
    velocityToFilter: 3000,
  },

  'french_horn': {
    wave: 'triangle',
    envelope: { attack: 0.18, decay: 0.4, sustain: 0.8, release: 0.45, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 1100, Q: 0.8 },
    filterEnvelope: { attack: 0.25, decay: 0.4, sustain: 0.7, release: 0.4 },
    filterEnvAmount: 900,
    gain: 0.55,
    lfo: { type: 'sine', frequency: 4.8, amount: 5, target: 'frequency', ramp: 0.8 },
    velocitySensitivity: 0.7,
  },

  'trombone': {
    wave: 'sawtooth',
    envelope: { attack: 0.09, decay: 0.3, sustain: 0.8, release: 0.3, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 700, Q: 1.2 },
    filterEnvelope: { attack: 0.12, decay: 0.35, sustain: 0.55, release: 0.3 },
    filterEnvAmount: 2200,
    gain: 0.6,
    glide: 0.08,
    glideFrom: -5,
    velocitySensitivity: 0.8,
    velocityToFilter: 2400,
  },

  'tuba': {
    wave: 'sawtooth',
    envelope: { attack: 0.14, decay: 0.35, sustain: 0.85, release: 0.4, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 450, Q: 0.9 },
    filterEnvAmount: 800,
    gain: 0.65,
    velocitySensitivity: 0.7,
  },

  'flute': {
    wave: 'triangle',
    envelope: { attack: 0.16, decay: 0.12, sustain: 0.9, release: 0.25, curve: 'linear' },
    lfo: { type: 'sine', frequency: 5.2, amount: 8, target: 'frequency', ramp: 0.6 },
    filter: { type: 'lowpass', frequency: 2200, Q: 0.3 },
    // 气息噪声用 attack_noise 表现，而不是把噪声塞进 fm_wave（那是非法的振荡器类型）
    attackNoise: 0.35,
    gain: 0.6,
    velocitySensitivity: 0.6,
  },

  'piccolo': {
    wave: 'triangle',
    envelope: { attack: 0.08, decay: 0.1, sustain: 0.9, release: 0.18, curve: 'linear' },
    lfo: { type: 'sine', frequency: 6.0, amount: 7, target: 'frequency', ramp: 0.4 },
    filter: { type: 'highpass', frequency: 500, Q: 0.3 },
    attackNoise: 0.3,
    gain: 0.5,
  },

  'clarinet': {
    wave: 'square',
    envelope: { attack: 0.08, decay: 0.12, sustain: 0.85, release: 0.22, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 1500, Q: 0.6 },
    attackNoise: 0.22,
    gain: 0.6,
    lfo: { type: 'sine', frequency: 4.8, amount: 5, target: 'frequency', ramp: 0.5 },
    velocitySensitivity: 0.7,
    velocityToFilter: 1500,
  },

  'oboe': {
    wave: 'sawtooth',
    envelope: { attack: 0.07, decay: 0.12, sustain: 0.85, release: 0.22, curve: 'linear' },
    filter: { type: 'bandpass', frequency: 1400, Q: 1.6 },
    attackNoise: 0.28,
    gain: 0.55,
    lfo: { type: 'sine', frequency: 5.4, amount: 6, target: 'frequency', ramp: 0.5 },
    velocitySensitivity: 0.75,
  },

  'bassoon': {
    wave: 'sawtooth',
    envelope: { attack: 0.12, decay: 0.2, sustain: 0.85, release: 0.3, curve: 'linear' },
    filter: { type: 'lowpass', frequency: 900, Q: 1.0 },
    attackNoise: 0.3,
    gain: 0.6,
    velocitySensitivity: 0.7,
  },

  'choir': {
    wave: 'sawtooth',
    envelope: { attack: 0.6, decay: 0.8, sustain: 0.9, release: 1.0, curve: 'linear' },
    // 人声的共振峰靠带通堆叠近似
    filter: { type: 'bandpass', frequency: 700, Q: 1.1 },
    filterEnvelope: { attack: 0.8, decay: 1.0, sustain: 0.7, release: 0.8, curve: 'linear' },
    filterEnvAmount: 600,
    detune: 18,
    voices: 3,
    unisonSpread: 16,
    spread: 0.9,
    gain: 0.4,
    attackNoise: 0.1,
    lfo: { type: 'sine', frequency: 4.6, amount: 6, target: 'frequency', ramp: 1.0 },
  },

  /* ============================ 打击乐 ============================ */

  'timpani': {
    wave: 'sine',
    envelope: { attack: 0.002, decay: 1.0, sustain: 0.0, release: 0.7, curve: 'exp' },
    // 鼓皮张力导致的音高下坠
    pitchEnvAmount: 5,
    pitchDecay: 0.08,
    fm_wave: 'sine',
    fm_ratio: 1.5,
    fm_index: 90,
    gain: 0.9,
    filter: { type: 'lowpass', frequency: 1200, Q: 0.6 },
    velocitySensitivity: 0.8,
  },

  'kick': {
    wave: 'sine',
    envelope: { attack: 0.001, decay: 0.32, sustain: 0.0, release: 0.06, curve: 'exp' },
    // 快速音高下坠是底鼓"冲击感"的核心
    pitchEnvAmount: 24,
    pitchDecay: 0.045,
    fm_wave: 'triangle',
    fm_ratio: 0.5,
    fm_index: 60,
    gain: 1.0,
    filter: { type: 'lowpass', frequency: 3000, Q: 0.5 },
    velocitySensitivity: 0.4,
  },

  'snare': {
    wave: 'triangle',
    envelope: { attack: 0.001, decay: 0.18, sustain: 0.0, release: 0.1, curve: 'exp' },
    pitchEnvAmount: 8,
    pitchDecay: 0.04,
    filter: { type: 'highpass', frequency: 400, Q: 0.7 },
    attackNoise: 0.8,
    gain: 0.8,
    velocitySensitivity: 0.6,
  },

  'tom': {
    wave: 'sine',
    envelope: { attack: 0.001, decay: 0.42, sustain: 0.0, release: 0.2, curve: 'exp' },
    pitchEnvAmount: 12,
    pitchDecay: 0.1,
    gain: 0.8,
    velocitySensitivity: 0.7,
  },

  'hihat': {
    wave: 'square',
    envelope: { attack: 0.001, decay: 0.06, sustain: 0.0, release: 0.03, curve: 'exp' },
    filter: { type: 'highpass', frequency: 7000, Q: 0.8 },
    attackNoise: 0.9,
    gain: 0.5,
    velocitySensitivity: 0.5,
  },

  'crash': {
    wave: 'square',
    envelope: { attack: 0.001, decay: 1.8, sustain: 0.0, release: 0.9, curve: 'exp' },
    filter: { type: 'highpass', frequency: 3500, Q: 0.5 },
    attackNoise: 0.95,
    gain: 0.55,
  },

  'noise_sweep': {
    wave: 'white_noise',
    envelope: { attack: 0.5, decay: 1.0, sustain: 0.3, release: 1.5, curve: 'linear' },
    filter: { type: 'bandpass', frequency: 200, Q: 3, sweepTo: 6000 },
    gain: 0.4,
  },

  'wind': {
    wave: 'pink_noise',
    envelope: { attack: 2.0, decay: 2.0, sustain: 0.8, release: 3.0, curve: 'linear' },
    filter: { type: 'bandpass', frequency: 500, Q: 1.2 },
    lfo: { type: 'sine', frequency: 0.12, amount: 350, target: 'filter', ramp: 1.5 },
    gain: 0.35,
  },

  'rain': {
    wave: 'white_noise',
    envelope: { attack: 1.5, decay: 1.0, sustain: 0.85, release: 2.0, curve: 'linear' },
    filter: { type: 'highpass', frequency: 900, Q: 0.4 },
    lfo: { type: 'sine', frequency: 0.25, amount: 0.12, target: 'gain', ramp: 1.0 },
    gain: 0.3,
  },

  'thunder': {
    wave: 'brown_noise',
    envelope: { attack: 0.02, decay: 2.5, sustain: 0.1, release: 2.0, curve: 'exp' },
    filter: { type: 'lowpass', frequency: 220, Q: 0.8 },
    gain: 0.7,
  },
};

/**
 * 按名称取预设（大小写不敏感）。
 *
 * 入参做空值防御：签名是 `string`，但调用方可能从 Map/索引取到 undefined，
 * 那种写法 TS 不会报错却会在这里炸成 "Cannot read properties of undefined"。
 * 返回 null 与"未知预设"同义，调用方本来就要处理。
 */
export const getPreset = (name: string): Partial<InstrumentDef> | null => {
  if (typeof name !== 'string') return null;
  return PRESETS[name.toLowerCase()] || null;
};

/** 全部可用预设名，供 UI 与提示词自动列出 */
export const PRESET_NAMES = Object.keys(PRESETS);

/* ==================== SPG 解析器 ==================== */

/* ---- 常量白名单 ---- */

const OSC_WAVES: ExpandedOscillatorType[] = [
  'sine', 'square', 'sawtooth', 'triangle',
  'white_noise', 'pink_noise', 'brown_noise', 'custom',
];
/**
 * 真正的振荡器波形。FM 调制器、LFO 与主波形都只能取这几个值 ——
 * 噪声名赋给 OscillatorNode.type 会抛异常，custom 需要另外挂 PeriodicWave。
 */
const OSCILLATOR_WAVES: OscillatorType[] = ['sine', 'square', 'sawtooth', 'triangle'];
/** 判定波形名能否直接赋给 OscillatorNode.type（不能则退回 sine） */
const isOscillatorWave = (wave: string): wave is OscillatorType =>
  (OSCILLATOR_WAVES as readonly string[]).includes(wave);
/**
 * 噪声波形。合成器为它们走 BufferSource 分支，**没有振荡器**，
 * 因此既不能赋给 OscillatorNode.type，也挂不上 PeriodicWave（harmonics）。
 */
const NOISE_WAVES: ExpandedOscillatorType[] = ['white_noise', 'pink_noise', 'brown_noise'];
const isNoiseWave = (wave: string): boolean =>
  (NOISE_WAVES as readonly string[]).includes(wave);
const LFO_TARGETS: LFOTarget[] = ['frequency', 'filter', 'gain', 'pan', 'detune'];
const FILTER_KINDS: FilterKind[] = [
  'lowpass', 'highpass', 'bandpass', 'notch',
  'lowshelf', 'highshelf', 'peaking', 'allpass',
];
const ENVELOPE_CURVES: EnvelopeCurve[] = ['linear', 'exp', 'hold'];
const ARP_PATTERNS: ArpPattern[] = ['up', 'down', 'upDown', 'downUp', 'asPlayed', 'random'];
const EFFECT_NAMES: EffectType[] = [
  'delay', 'pingpong', 'reverb', 'distortion', 'bitcrush', 'overdrive',
  'filter', 'eq', 'chorus', 'flanger', 'phaser', 'tremolo', 'compressor',
];

/** 和弦声位风格 */
const VOICING_STYLES: VoicingStyle[] = ['close', 'open', 'drop2', 'spread'];
/** 调式音阶白名单 */
const SCALE_NAMES = [
  'major', 'minor', 'harmonic_minor', 'melodic_minor',
  'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian',
  'major_pentatonic', 'minor_pentatonic', 'blues', 'chromatic',
  'whole_tone',
];

const DEFAULT_ENVELOPE: Envelope = { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2 };

/**
 * 效果器的同义参数名纠错表。
 *
 * 模型很自然会写出 `delay(delay=0.25)`、`reverb(size=2)` 这类同义写法，
 * 未知参数若被静默忽略，"延迟 0.25 秒"就会变成默认的 0.3 秒 ——
 * 用户听到的结果与描述不符，却拿不到任何报错。这里纠正并给出提示。
 */
const EFFECT_PARAM_ALIASES: Record<string, Record<string, string>> = {
  delay: { delay: 'time', fb: 'feedback', tone: 'damping', ping_pong: 'pingpong' },
  pingpong: { delay: 'time', fb: 'feedback', tone: 'damping', ping_pong: 'pingpong' },
  // 只列真正会改名的同义写法：写成 `pre_delay: 'pre_delay'` 这类自映射会让
  // `reverb(pre_delay=0.02)` 弹出一句"参数 pre_delay 已按 pre_delay 处理"的空提示。
  reverb: { size: 'decay', tone: 'damping' },
  distortion: { drive: 'amount', gain: 'amount' },
  overdrive: { drive: 'amount', gain: 'amount' },
  bitcrush: { depth: 'bits' },
  chorus: { speed: 'rate' },
  flanger: { speed: 'rate', fb: 'feedback' },
  phaser: { speed: 'rate', from: 'min', to: 'max' },
  tremolo: { speed: 'rate' },
  /**
   * 这里**不能**写 `start: 'from'`。
   *
   * `start` 已经是 filter 的正式参数（扫频起始时刻，见 EFFECT_PARAMS.filter），
   * 再把它当"起始频率"的别名，同一个名字就背上了两种量纲：
   * `filter(start=1, to=4000, duration=2)` 会被改写成 `from=1`，
   * 用户本意是"第 1 秒开始扫"，得到的却是"从 1Hz 扫到 4000Hz"——
   * 听感完全不同且不报错。一个名字只能有一个含义：起始频率请写 `from`。
   */
  filter: { end: 'to', dur: 'duration', at: 'start' },
  eq: { bass: 'low', treble: 'high' },
};

/** 每个效果器的合法参数名（含别名），用于校验并给出可读报错 */
const EFFECT_PARAMS: Record<string, string[]> = {
  delay: ['time', 'feedback', 'mix', 'damping', 'pingpong'],
  pingpong: ['time', 'feedback', 'mix', 'damping', 'pingpong'],
  reverb: ['decay', 'mix', 'predelay', 'pre_delay', 'damping'],
  distortion: ['amount', 'mix'],
  overdrive: ['amount', 'mix'],
  bitcrush: ['bits', 'mix'],
  chorus: ['rate', 'depth', 'mix'],
  flanger: ['rate', 'feedback', 'mix'],
  phaser: ['rate', 'min', 'max', 'mix'],
  tremolo: ['rate', 'depth'],
  filter: ['kind', 'from', 'to', 'q', 'duration', 'start'],
  eq: ['low', 'mid', 'high'],
  compressor: ['threshold', 'ratio', 'attack', 'release'],
};

/** 带行号的解析错误。引擎读取 `line` 以在编辑器里定位。 */
export class SPGError extends Error {
  public line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = 'SPGError';
    this.line = line;
  }
}

/**
 * SPG 源码解析器。
 *
 * 语法：`config { }` / `define_instrument(name=...) { }` / `sequence(name=...) { }` /
 * 顶层 `effect_chain { }` / `mix { track(...) }`。
 *
 * 贯穿全篇的一条原则：**宁可报错，不要静默忽略**。拼错的参数名、拼错的时值、
 * 写了却不生效的字段，都会让用户听到与代码描述不符的结果而无从排查 ——
 * 这类问题在 LLM 生成的代码里出现频率极高，因此每个可疑输入都给出可操作的报错。
 */
export class SPGParser {
  /** 本次解析收集到的提示，`parse()` 开始时清空 */
  private warnings: SPGWarning[] = [];

  private warn(message: string, line: number): void {
    this.warnings.push({ message, line });
  }

  /* ---- 文本预处理 ---- */

  /**
   * 按行剥离注释（# 与 //），忽略单双引号内部的内容与 URL 协议分隔符。
   * 保留换行数量，使行号在剥离后依然准确。
   */
  private stripComments(code: string): string {
    return code.split('\n').map((line) => {
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const prev = i > 0 ? line[i - 1] : '';
        if (ch === "'" && !inDouble && prev !== '\\') { inSingle = !inSingle; continue; }
        if (ch === '"' && !inSingle && prev !== '\\') { inDouble = !inDouble; continue; }
        if (inSingle || inDouble) continue;
        if (ch === '#') return line.slice(0, i);
        if (ch === '/' && line[i + 1] === '/') {
          // `http://` 这类协议分隔符不是注释
          if (/:\s*$/.test(line.slice(0, i))) continue;
          return line.slice(0, i);
        }
      }
      return line;
    }).join('\n');
  }

  /** 绝对字符下标 → 行号（1 基） */
  private makeLineLookup(code: string): (index: number) => number {
    const starts: number[] = [0];
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '\n') starts.push(i + 1);
    }
    return (index: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= index) lo = mid; else hi = mid - 1;
      }
      return lo + 1;
    };
  }

  /* ---- 结构化扫描 ---- */

  /**
   * 找到所有 `keyword(...) { body }` 结构。
   * 用括号配对扫描而非正则 —— 正则的 `[^}]+` 会在块内出现嵌套花括号
   * （如乐器里内嵌 `effect_chain { ... }`）时提前截断。
   *
   * 关键字与 `{` 之间允许有一个冒号：`effect_chain: { ... }` 是模型很自然会写出的形式，
   * 而它此前会被静默丢掉 —— 乐器字段白名单里收了 `effect_chain` 所以不报"未知参数"，
   * 这里又因为紧跟的不是 `{` 而不当成块，于是整条乐器级效果链无声消失。
   */
  private findBlocks(
    code: string,
    keyword: string,
    lineOf: (i: number) => number
  ): { header: string; body: string; headerStart: number; bodyStart: number; line: number }[] {
    const out: { header: string; body: string; headerStart: number; bodyStart: number; line: number }[] = [];
    const kw = new RegExp(`\\b${keyword}\\b`, 'g');
    let m: RegExpExecArray | null;

    while ((m = kw.exec(code)) !== null) {
      let i = m.index + keyword.length;
      while (i < code.length && /\s/.test(code[i])) i++;

      // 可选参数列表
      let headerEnd = i;
      if (code[i] === '(') {
        const close = this.matchPair(code, i, '(', ')');
        if (close < 0) {
          throw new SPGError(`${keyword} 的参数括号未闭合`, lineOf(m.index));
        }
        headerEnd = close + 1;
        i = close + 1;
        while (i < code.length && /\s/.test(code[i])) i++;
      }

      // `keyword: { ... }` 与 `keyword { ... }` 等价
      if (code[i] === ':') {
        i++;
        while (i < code.length && /\s/.test(code[i])) i++;
      }

      if (code[i] !== '{') {
        // 不是块结构（可能是别处的同名标识符），继续扫描
        kw.lastIndex = m.index + keyword.length;
        continue;
      }

      const bodyStart = i + 1;
      const bodyEnd = this.matchPair(code, i, '{', '}');
      if (bodyEnd < 0) {
        throw new SPGError(`${keyword} 的花括号未闭合`, lineOf(m.index));
      }

      out.push({
        header: code.slice(m.index + keyword.length, headerEnd),
        body: code.slice(bodyStart, bodyEnd),
        headerStart: m.index,
        bodyStart,
        line: lineOf(m.index),
      });

      kw.lastIndex = bodyEnd + 1;
    }
    return out;
  }

  /** 从 open 位置出发做括号配对，返回配对字符下标；失败返回 -1 */
  private matchPair(code: string, open: number, openCh: string, closeCh: string): number {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    for (let i = open; i < code.length; i++) {
      const ch = code[i];
      const prev = i > 0 ? code[i - 1] : '';
      if (ch === "'" && !inDouble && prev !== '\\') { inSingle = !inSingle; continue; }
      if (ch === '"' && !inSingle && prev !== '\\') { inDouble = !inDouble; continue; }
      if (inSingle || inDouble) continue;
      if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** 按顶层分隔符切分（忽略括号/方括号/引号内部的分隔符） */
  private splitTopLevel(str: string, separator = ','): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let current = '';

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const prev = i > 0 ? str[i - 1] : '';
      if (ch === "'" && !inDouble && prev !== '\\') { inSingle = !inSingle; current += ch; continue; }
      if (ch === '"' && !inSingle && prev !== '\\') { inDouble = !inDouble; current += ch; continue; }
      if (!inSingle && !inDouble) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (ch === separator && depth === 0) {
          parts.push(current);
          current = '';
          continue;
        }
      }
      current += ch;
    }
    if (current.trim().length > 0) parts.push(current);
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
  }

  /**
   * 把块体切成一条条独立语句，返回每段文本及其在块体内的偏移（用于算行号）。
   *
   * 分隔依据有三类，缺一不可：
   * 1. 分号 `;`
   * 2. 换行
   * 3. **右括号后紧跟新的调用** —— `hit("kick","4n") hit("hat","4n")` 这种同行连写
   *    在模型输出里很常见，只按换行/分号切会把它当成一条畸形语句，
   *    报出"无法解析的时值"这类牛头不对马嘴的错误。
   *
   * 收尾时还必须剥掉尾部的 `;`：`note("C4","4n");` 是合法且最常见的写法，
   * 分号留在文本里会让调用正则匹配失败。
   */
  private splitStatements(body: string): { text: string; offset: number }[] {
    const out: { text: string; offset: number }[] = [];
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let start = 0;
    let current = '';

    const flush = (endExclusive: number) => {
      const trimmed = current.replace(/[;\s]+$/, '').trim();
      if (trimmed.length > 0) {
        out.push({ text: trimmed, offset: start });
      }
      current = '';
      start = endExclusive;
    };

    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      const prev = i > 0 ? body[i - 1] : '';
      if (ch === "'" && !inDouble && prev !== '\\') { inSingle = !inSingle; current += ch; continue; }
      if (ch === '"' && !inSingle && prev !== '\\') { inDouble = !inDouble; current += ch; continue; }
      if (inSingle || inDouble) { current += ch; continue; }

      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);

      current += ch;

      if (depth !== 0) continue;

      // 跳过空白，判断后面是否开始了一个新调用
      let j = i + 1;
      while (j < body.length && (body[j] === ' ' || body[j] === '\t')) j++;

      const isSeparator = ch === ';' || ch === '\n';
      const startsNewCall = ch === ')' && /^[A-Za-z_]\w*\s*\(/.test(body.slice(j));

      if (isSeparator || startsNewCall) {
        flush(j);
        i = j - 1;
      }
    }
    flush(body.length);
    return out;
  }

  /** 去掉一层包裹的引号 */
  private unquote(str: string): string {
    const t = str.trim();
    if (t.length >= 2) {
      const a = t[0];
      const b = t[t.length - 1];
      if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
        return t.slice(1, -1).replace(/\\(["'])/g, '$1');
      }
    }
    return t;
  }

  /**
   * 严格的数字解析。
   *
   * `parseFloat("0.5x")` 会静默读成 0.5 —— 拼写错误变成有效值，用户听到的不是自己写的。
   * 这里用 Number 做全字匹配：非法返回 NaN，由调用方报错。
   * 空串与十六进制同样拒绝（`Number('') === 0` 会吞掉 `gain=` 这类空值）。
   */
  private strictFloat(raw: string): number {
    const t = this.unquote(raw).trim();
    if (!t || /^0x/i.test(t)) return NaN;
    return Number(t);
  }

  /** 解析参数列表为「位置参数 + 具名参数」，支持 `name="x"` 与裸位置值 */
  private parseArgs(str: string): { positional: string[]; named: Record<string, string> } {
    const positional: string[] = [];
    const named: Record<string, string> = {};
    for (const part of this.splitTopLevel(str, ',')) {
      const eq = this.findTopLevelEquals(part);
      if (eq > 0) {
        const key = part.slice(0, eq).trim();
        if (/^[A-Za-z_]\w*$/.test(key)) {
          named[key.toLowerCase()] = part.slice(eq + 1).trim();
          continue;
        }
      }
      positional.push(part);
    }
    return { positional, named };
  }

  /** 找到顶层（不在括号/引号内）的赋值等号位置；没有返回 -1 */
  private findTopLevelEquals(str: string): number {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const prev = i > 0 ? str[i - 1] : '';
      if (ch === "'" && !inDouble && prev !== '\\') { inSingle = !inSingle; continue; }
      if (ch === '"' && !inSingle && prev !== '\\') { inDouble = !inDouble; continue; }
      if (inSingle || inDouble) continue;
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === '=' && depth === 0 && str[i + 1] !== '=' && prev !== '!' && prev !== '<' && prev !== '>') {
        return i;
      }
    }
    return -1;
  }

  /** 解析数组字面量 `["C4", "E4"]` 或 `[1, 2, 3]` */
  private parseArray(str: string): string[] {
    const t = str.trim();
    const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
    return this.splitTopLevel(inner, ',').map((v) => this.unquote(v));
  }

  /* ---- 参数取值助手 ---- */

  /**
   * 校验音名。底层的 getMidi 抛的是普通 Error，直接冒泡会让行号丢失（引擎只能报 line 0），
   * 编辑器就无法定位到出错的那一行。
   */
  private validatePitch(pitch: string, ctx: string, line: number): void {
    try {
      getMidi(pitch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SPGError(`${ctx}: ${msg}`, line);
    }
  }

  /** 校验时值，失败时抛出带行号的 SPGError */
  private validateDuration(dur: string | number, tempo: number, ctx: string, line: number): number {
    try {
      return parseDuration(dur, tempo);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SPGError(`${ctx}: ${msg}`, line);
    }
  }

  private num(named: Record<string, string>, keys: string[], fallback: number, ctx: string, line: number): number {
    for (const k of keys) {
      if (named[k] !== undefined) {
        const v = this.strictFloat(named[k]);
        if (!Number.isFinite(v)) {
          throw new SPGError(`${ctx}: 参数 ${k} 需要数字，收到 "${named[k]}"`, line);
        }
        return v;
      }
    }
    return fallback;
  }

  private str(named: Record<string, string>, keys: string[], fallback: string): string {
    for (const k of keys) {
      if (named[k] !== undefined) return this.unquote(named[k]);
    }
    return fallback;
  }

  /** 拼错的布尔值不能静默当 false：`accent=maybe` 本意是重音，安静地演奏成普通力度最难排查。 */
  private bool(named: Record<string, string>, keys: string[], fallback: boolean, ctx = '', line = 0): boolean {
    for (const k of keys) {
      if (named[k] !== undefined) {
        const v = this.unquote(named[k]).toLowerCase();
        if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
        if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
        throw new SPGError(
          `${ctx}: 参数 ${k} 需要布尔值（true / false），收到 "${named[k]}"`, line
        );
      }
    }
    return fallback;
  }

  /** 枚举取值（大小写不敏感），非法值把合法取值一并列出 */
  private enum_<T extends string>(
    value: string, allowed: readonly T[], ctx: string, line: number
  ): T {
    const v = value.trim();
    const found = allowed.find((a) => a.toLowerCase() === v.toLowerCase());
    if (!found) {
      throw new SPGError(
        `${ctx}: "${value}" 不是合法取值。可用：${allowed.join(' / ')}`, line
      );
    }
    return found;
  }

  /* ---- 块内字段扫描 ---- */

  /**
   * 把块体解析成「键 → 值文本 + 行号」。
   *
   * 行号必须跟着字段走：块内任一字段出错时，报的是块首那一行的话，
   * 编辑器会把光标停在 `define_instrument(...) {` 上 —— 而错误在十几行之下。
   *
   * 不能用 `new RegExp(key + '\\s*[:=]\\s*...')` 逐字段匹配，那有三个致命问题：
   *
   * 1. **键名边界泄漏**：匹配 `wave` 会命中 `fm_wave` 里的 `wave`，
   *    于是写了 `fm_wave: "triangle"` 的乐器主波形被悄悄改成 triangle；
   *    同理 `filter` 会命中 `filter_envelope`，滤波包络整体替换振幅包络。
   * 2. **只认引号值**：`envelope: adsr(0.1,0.2,0.6,0.4)` 这种不带引号的写法会被完全忽略。
   * 3. **无法处理跨行值**：`harmonics: [\n 1, 0.5\n]` 匹配不到。
   *
   * 改为一次带括号深度的线性扫描：只在深度 0 处识别 `键 : 值` / `键 = 值`，
   * 值延伸到同深度的换行/分号/下一个键。嵌套的 `effect_chain { ... }` 因此被整体跳过，
   * 不会把 `delay(time=..., feedback=...)` 里的具名参数误当成乐器字段。
   */
  private parseFields(
    body: string,
    lineOf: (index: number) => number,
    bodyStart: number
  ): Map<string, { value: string; line: number }> {
    const fields = new Map<string, { value: string; line: number }>();
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let i = 0;

    while (i < body.length) {
      const ch = body[i];
      const prev = i > 0 ? body[i - 1] : '';

      if (ch === "'" && !inDouble && prev !== '\\') { inSingle = !inSingle; i++; continue; }
      if (ch === '"' && !inSingle && prev !== '\\') { inDouble = !inDouble; i++; continue; }
      if (inSingle || inDouble) { i++; continue; }

      if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); i++; continue; }

      /**
       * 只在顶层识别键名，且键名必须从左边界开始（行首/空白/分隔符之后）。
       *
       * 逗号也算左边界：`{ wave:"sine",gain:0.5 }` 这种紧凑写法里，
       * 键名前面紧挨着的是逗号而不是空格。不认的话 `gain` 整个字段都不会被发现 ——
       * 它既不会生效、也不会进"未知参数"校验，就是静默消失。
       */
      const atBoundary = i === 0 || /[\s;,]/.test(prev);
      if (depth === 0 && atBoundary) {
        const m = /^([A-Za-z_]\w*)\s*([:=])\s*/.exec(body.slice(i));
        if (m) {
          const key = m[1].toLowerCase();
          // 行号直接由绝对下标查表，不用在扫描途中累加换行数
          const keyLine = lineOf(bodyStart + i);
          let j = i + m[0].length;
          let vDepth = 0;
          let vSingle = false;
          let vDouble = false;
          const valueStart = j;

          for (; j < body.length; j++) {
            const c = body[j];
            const p = j > 0 ? body[j - 1] : '';
            if (c === "'" && !vDouble && p !== '\\') { vSingle = !vSingle; continue; }
            if (c === '"' && !vSingle && p !== '\\') { vDouble = !vDouble; continue; }
            if (vSingle || vDouble) continue;
            if (c === '(' || c === '[' || c === '{') vDepth++;
            else if (c === ')' || c === ']' || c === '}') {
              if (vDepth === 0) break; // 收尾到块边界，交给外层处理
              vDepth--;
            } else if (vDepth === 0 && (c === '\n' || c === ';')) break;

            /**
             * 单行多字段：`{ wave: "sine" gain: 0.5 }` 的值必须以下一个键名为界，
             * 否则 wave 会把 `gain: 0.5` 一起吞掉。
             *
             * 检查必须在**每个字符**处做：若只在"当前是空白且前一个也是空白"时检查，
             * `"sawtooth" effect_chain { ... }` 里的空格前面是引号，边界永远不会被识别，
             * 值一路吞到行尾，wave 收到拼接串并抛出"不是合法取值"。
             */
            if (vDepth === 0 && j > valueStart) {
              const ahead = body.slice(j).replace(/^\s+/, '');
              /**
               * 值在顶层遇到下列三种情况即结束：
               * 1. 下一个 `键:` / `键=`
               * 2. 嵌套块 `关键字(...) {`
               * 3. 顶层逗号（`fm_wave:"sine", fm_ratio:3.5`）
               * 排除 `==` / `<=` 之类的比较写法，避免误判。
               */
              const isNextKey = (/^[A-Za-z_]\w*\s*[:=]/.test(ahead)
                && !/^[A-Za-z_]\w*\s*[=!<>]=/.test(ahead))
                || /^[A-Za-z_]\w*\s*(\([^()]*\))?\s*\{/.test(ahead)
                || ahead.startsWith(',');
              if (isNextKey) break;
            }
          }

          // 同名键后写覆盖先写，与"后写优先"的直觉一致
          fields.set(key, { value: body.slice(valueStart, j).trim(), line: keyLine });
          i = j;
          continue;
        }
      }

      i++;
    }

    return fields;
  }

  /**
   * 取字段值。表达式类字段（envelope/filter/lfo）允许带引号也允许裸写，
   * 两种写法都返回去掉引号后的表达式文本。
   *
   * 同时给出该字段**自己**的行号（缺省回落到块首）：报错落在块首那一行时，
   * 编辑器会把光标停在 `define_instrument(...) {` 上，而错误在十几行之下。
   */
  private field(
    fields: Map<string, { value: string; line: number }>,
    key: string
  ): { value: string; line: number } | null {
    const f = fields.get(key.toLowerCase());
    if (f === undefined) return null;
    const t = f.value.trim();
    return t.length > 0 ? { value: this.unquote(t), line: f.line } : null;
  }

  /** 取数值字段；缺失返回 null，非数字抛带行号的错误 */
  private fieldNumber(
    fields: Map<string, { value: string; line: number }>,
    key: string, ctx: string
  ): number | null {
    const f = this.field(fields, key);
    if (f === null) return null;
    const v = this.strictFloat(f.value);
    if (!Number.isFinite(v)) {
      throw new SPGError(`${ctx}: 参数 ${key} 需要数字（收到 "${f.value}"）`, f.line);
    }
    return v;
  }

  /** 字段自身的行号（用于报错定位），缺失时回落到块首 */
  private fieldLine(
    fields: Map<string, { value: string; line: number }>, key: string, fallbackLine: number
  ): number {
    return fields.get(key.toLowerCase())?.line ?? fallbackLine;
  }
  /**
   * 拒绝未知的具名参数。
   *
   * `note("C4","4n", velo=0.5)`（`velocity` 拼错）按旧逻辑会安静地按默认力度演奏，
   * `reverb(damp=3000)` 会安静地用默认阻尼 —— 用户听到的不是自己写的，却拿不到反馈。
   * 这类"看起来生效其实没生效"的写法是 LLM 生成代码里最难排查的错误，
   * 因此直接报错，并把合法参数名列出来供模型自我纠正。
   *
   * 收键名数组而不是对象：乐器/config 块手里拿的是「键 → 值 + 行号」的 Map，
   * 为了调用这里先 `Object.fromEntries` 再丢掉行号，等于把刚算出来的定位信息扔掉。
   */
  private rejectUnknownParams(
    keys: Iterable<string>, allowed: readonly string[], ctx: string, line: number
  ): void {
    for (const key of keys) {
      if (!allowed.includes(key)) {
        throw new SPGError(
          `${ctx}: 未知参数 "${key}"。可用参数：${allowed.join(' / ')}`, line
        );
      }
    }
  }

  /** 把效果器的同义参数名归一化，返回被纠正的键（用于提示） */
  private normalizeEffectParams(
    name: string, named: Record<string, string>
  ): { named: Record<string, string>; renamed: Array<[string, string]> } {
    const aliases = EFFECT_PARAM_ALIASES[name] ?? {};
    const out: Record<string, string> = {};
    const renamed: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(named)) {
      const canonical = aliases[key];
      if (canonical && !(canonical in named)) {
        out[canonical] = value;
        renamed.push([key, canonical]);
      } else {
        out[key] = value;
      }
    }
    return { named: out, renamed };
  }

  /* ---- 包络 / 滤波 / LFO ---- */

  /** 解析包络表达式，支持 adsr / ad / ar / perc 四种形态与命名参数 */
  private parseEnvelope(str: string | null, ctx: string, line: number): Envelope | undefined {
    if (!str) return undefined;
    const m = str.trim().match(/^(\w+)\s*\(([\s\S]*)\)$/);
    if (!m) {
      throw new SPGError(`${ctx}: 无法解析包络 "${str}"（应形如 adsr(0.01, 0.2, 0.6, 0.4)）`, line);
    }
    const kind = m[1].toLowerCase();
    const { positional, named } = this.parseArgs(m[2]);
    const p = positional.map((v) => this.strictFloat(v));
    for (const v of p) {
      if (!Number.isFinite(v)) {
        throw new SPGError(`${ctx}: 包络参数必须是数字（收到 "${str}"）`, line);
      }
    }

    const pick = (idx: number, keys: string[], fallback: number): number => {
      if (named && keys.some((k) => named[k] !== undefined)) return this.num(named, keys, fallback, ctx, line);
      return p[idx] !== undefined && Number.isFinite(p[idx]) ? p[idx] : fallback;
    };

    let env: Envelope;
    let allowed: string[];
    switch (kind) {
      case 'adsr':
        env = {
          attack: pick(0, ['a', 'attack'], 0.01),
          decay: pick(1, ['d', 'decay'], 0.1),
          sustain: pick(2, ['s', 'sustain'], 0.7),
          release: pick(3, ['r', 'release'], 0.2),
        };
        allowed = ['a', 'd', 's', 'r', 'attack', 'decay', 'sustain', 'release'];
        break;
      case 'ad':
        env = {
          attack: pick(0, ['a', 'attack'], 0.01),
          decay: pick(1, ['d', 'decay'], 0.3),
          sustain: 0, release: pick(1, ['d', 'decay'], 0.3) * 0.5,
        };
        allowed = ['a', 'd', 'attack', 'decay'];
        break;
      case 'ar':
        env = {
          attack: pick(0, ['a', 'attack'], 0.05),
          decay: 0.01, sustain: 1,
          release: pick(1, ['r', 'release'], 0.4),
        };
        allowed = ['a', 'r', 'attack', 'release'];
        break;
      case 'perc':
        env = {
          attack: pick(0, ['a', 'attack'], 0.001),
          decay: pick(1, ['d', 'decay'], 0.3),
          sustain: 0, release: pick(2, ['r', 'release'], 0.15),
        };
        allowed = ['a', 'd', 'r', 'attack', 'decay', 'release'];
        break;
      default:
        throw new SPGError(
          `${ctx}: 未知包络类型 "${kind}"。可用：adsr / ad / ar / perc`, line
        );
    }

    this.rejectUnknownParams(
      Object.keys(named), [...allowed, 'curve', 'delay'], `${ctx} 包络 ${kind}()`, line);

    env.curve = named.curve
      ? this.enum_(this.unquote(named.curve), ENVELOPE_CURVES, `${ctx} curve`, line)
      : 'exp';
    env.delay = named.delay !== undefined ? this.num(named, ['delay'], 0, ctx, line) : 0;

    // 负时间会让自动化时间点倒流
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) {
        throw new SPGError(`${ctx}: 包络参数 ${k} 不能为负数（${v}）`, line);
      }
    }
    if (env.sustain > 1) env.sustain = 1;
    return env;
  }

  /** 解析滤波器表达式，例如 lowpass(2000, 1) */
  private parseFilter(str: string | null, ctx: string, line: number): FilterDef | undefined {
    if (!str) return undefined;
    const m = str.trim().match(/^(\w+)\s*\(([\s\S]*)\)$/);
    if (!m) {
      throw new SPGError(`${ctx}: 无法解析滤波器 "${str}"（应形如 lowpass(2000, 1)）`, line);
    }
    const kind = this.enum_(m[1], FILTER_KINDS, `${ctx} 滤波器类型`, line);
    const { positional, named } = this.parseArgs(m[2]);
    const p = positional.map((v) => this.strictFloat(v));

    this.rejectUnknownParams(
      Object.keys(named),
      ['freq', 'frequency', 'q', 'gain', 'sweep', 'sweep_to'],
      `${ctx} 滤波器 ${kind}()`, line
    );

    const frequency = named.freq !== undefined || named.frequency !== undefined
      ? this.num(named, ['freq', 'frequency'], 1000, ctx, line)
      : (Number.isFinite(p[0]) ? p[0] : 1000);
    const Q = named.q !== undefined
      ? this.num(named, ['q'], 1, ctx, line)
      : (Number.isFinite(p[1]) ? p[1] : 1);
    const gain = named.gain !== undefined ? this.num(named, ['gain'], 0, ctx, line)
      : (Number.isFinite(p[2]) ? p[2] : undefined);
    const sweepTo = named.sweep !== undefined || named.sweep_to !== undefined
      ? this.num(named, ['sweep', 'sweep_to'], 0, ctx, line)
      : (Number.isFinite(p[3]) ? p[3] : undefined);

    if (!Number.isFinite(frequency) || frequency <= 0) {
      throw new SPGError(`${ctx}: 滤波器频率必须为正数（收到 ${frequency}）`, line);
    }
    if (Q < 0) throw new SPGError(`${ctx}: 滤波器 Q 不能为负数`, line);

    return { type: kind as BiquadFilterType, frequency, Q, gain, sweepTo };
  }

  /** 解析 LFO 表达式，例如 sine(freq=5, amount=12, target=frequency) */
  private parseLFO(str: string | null, ctx: string, line: number): LFODef | undefined {
    if (!str) return undefined;
    const m = str.trim().match(/^(\w+)\s*\(([\s\S]*)\)$/);
    if (!m) {
      throw new SPGError(`${ctx}: 无法解析 LFO "${str}"（应形如 sine(freq=5, amount=10, target=frequency)）`, line);
    }
    // 波形必须真实合法，否则调度期会在 OscillatorNode.type 上抛异常
    const type = this.enum_(m[1], OSCILLATOR_WAVES, `${ctx} LFO 波形`, line);
    const { positional, named } = this.parseArgs(m[2]);
    const p = positional.map((v) => this.strictFloat(v));

    this.rejectUnknownParams(
      Object.keys(named), ['freq', 'frequency', 'amount', 'target', 'ramp', 'swell'],
      `${ctx} LFO ${type}()`, line
    );

    const frequency = named.freq !== undefined || named.frequency !== undefined
      ? this.num(named, ['freq', 'frequency'], 5, ctx, line)
      : (Number.isFinite(p[0]) ? p[0] : 5);
    const amount = named.amount !== undefined
      ? this.num(named, ['amount'], 10, ctx, line)
      : (Number.isFinite(p[1]) ? p[1] : 10);
    // target 是枚举字符串，不能走数字解析；位置写法取原始第三个参数
    const target = named.target !== undefined
      ? this.enum_(this.unquote(named.target), LFO_TARGETS, `${ctx} LFO target`, line)
      : (positional[2] !== undefined
        ? this.enum_(this.unquote(positional[2]), LFO_TARGETS, `${ctx} LFO target`, line)
        : 'frequency');

    if (frequency <= 0) throw new SPGError(`${ctx}: LFO 速率必须为正数`, line);

    return {
      type,
      frequency,
      amount,
      target,
      ramp: named.ramp !== undefined ? this.num(named, ['ramp'], 0, ctx, line) : 0,
      swell: this.bool(named, ['swell'], false, `${ctx} LFO`, line),
    };
  }

  /* ---- 效果链 ---- */

  private parseEffects(
    body: string,
    tempo: number,
    lineOf: (index: number) => number,
    bodyStart: number,
    ctx: string
  ): EffectDef[] {
    const effects: EffectDef[] = [];
    // 效果器同样允许同行连写，复用统一的语句切分
    const statements = this.splitStatements(body);

    statements.forEach(({ text: line, offset }) => {
      const lineNo = lineOf(bodyStart + offset);

      const m = line.match(/^(\w+)\s*\(([\s\S]*)\)\s*$/);
      if (!m) {
        throw new SPGError(
          `${ctx}: 无法解析效果器 "${line}"（应形如 reverb(decay=2.5, mix=0.3)）`, lineNo
        );
      }
      const name = this.enum_(m[1], EFFECT_NAMES, `${ctx} 效果器`, lineNo);
      const parsedArgs = this.parseArgs(m[2]);
      const positional = parsedArgs.positional;
      const { named, renamed } = this.normalizeEffectParams(name, parsedArgs.named);
      renamed.forEach(([from, to]) =>
        this.warn(`${ctx} ${name}(): 参数 "${from}" 已按 "${to}" 处理`, lineNo)
      );
      this.rejectUnknownParams(
        Object.keys(named), EFFECT_PARAMS[name] ?? [], `${ctx} ${name}()`, lineNo);

      const p = positional.map((v) => this.strictFloat(v));
      const num = (keys: string[], fallback: number, idx2: number): number => {
        if (keys.some((k) => named[k] !== undefined)) {
          return this.num(named, keys, fallback, `${ctx} ${name}`, lineNo);
        }
        return Number.isFinite(p[idx2]) ? p[idx2] : fallback;
      };
      /** 时值参数既接受数字也接受 4n/250ms 这类记号 */
      const durArg = (keys: string[], idx2: number, fallback: string): number => {
        if (keys.some((k) => named[k] !== undefined)) {
          const raw = this.unquote(this.str(named, keys, fallback));
          try {
            return parseDuration(raw, tempo);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new SPGError(`${ctx} ${name}: ${msg}`, lineNo);
          }
        }
        if (Number.isFinite(p[idx2])) return p[idx2];
        return parseDuration(fallback, tempo);
      };

      switch (name) {
        case 'delay':
        case 'pingpong':
          effects.push({
            type: 'delay',
            time: durArg(['time'], 0, '0.3'),
            feedback: num(['feedback'], 0.3, 1),
            mix: num(['mix'], 0.4, 2),
            damping: num(['damping'], 2000, 3),
            pingPong: name === 'pingpong' || this.bool(named, ['pingpong'], false, `${ctx} ${name}`, lineNo),
          });
          break;

        case 'reverb':
          effects.push({
            type: 'reverb',
            decay: num(['decay'], 2.0, 0),
            mix: num(['mix'], 0.3, 1),
            preDelay: num(['predelay', 'pre_delay'], 0.01, 2),
            damping: num(['damping'], 5000, 3),
          });
          break;

        case 'distortion':
        case 'overdrive':
          effects.push({
            type: 'distortion',
            amount: name === 'overdrive'
              ? num(['amount'], 0.15, 0)
              : num(['amount'], 0.5, 0),
            mix: num(['mix'], 1, 1),
          });
          break;

        case 'bitcrush':
          effects.push({
            type: 'bitcrush',
            bits: Math.max(1, Math.min(16, num(['bits'], 8, 0))),
            mix: num(['mix'], 1, 1),
          });
          break;

        case 'chorus':
          effects.push({
            type: 'chorus',
            rate: num(['rate'], 1.5, 0),
            depth: num(['depth'], 3.5, 1),
            mix: num(['mix'], 0.5, 2),
          });
          break;

        case 'flanger':
          effects.push({
            type: 'flanger',
            rate: num(['rate'], 0.3, 0),
            feedback: num(['feedback'], 0.6, 1),
            mix: num(['mix'], 0.5, 2),
          });
          break;

        case 'phaser':
          effects.push({
            type: 'phaser',
            rate: num(['rate'], 0.5, 0),
            min: num(['min'], 300, 1),
            max: num(['max'], 2000, 2),
            mix: num(['mix'], 0.6, 3),
          });
          break;

        case 'tremolo':
          effects.push({
            type: 'tremolo',
            rate: num(['rate'], 5, 0),
            depth: num(['depth'], 0.6, 1),
          });
          break;

        case 'compressor':
          effects.push({
            type: 'compressor',
            threshold: num(['threshold'], -20, 0),
            ratio: num(['ratio'], 4, 1),
            attack: num(['attack'], 0.01, 2),
            release: num(['release'], 0.25, 3),
          });
          break;

        case 'filter':
          effects.push({
            type: 'filter',
            kind: named.kind !== undefined
              ? this.enum_(this.unquote(named.kind), FILTER_KINDS, `${ctx} filter kind`, lineNo)
              : 'lowpass',
            from: num(['from'], 200, 0),
            to: num(['to'], 4000, 1),
            Q: num(['q'], 1, 2),
            duration: durArg(['duration'], 3, '2'),
            start: num(['start'], 0, 4),
          });
          break;

        case 'eq':
          effects.push({
            type: 'eq',
            low: num(['low'], 0, 0),
            mid: num(['mid'], 0, 1),
            high: num(['high'], 0, 2),
          });
          break;

        default:
          throw new SPGError(`${ctx}: 未知效果器 "${name}"`, lineNo);
      }
    });

    return effects;
  }

  /* ---- 逐音符表现力 ---- */

  /**
   * 逐音符可用的具名参数白名单。
   * 与 `rejectUnknownParams` 配合，把"拼错参数名 → 静默按默认值演奏"变成明确报错。
   */
  private static readonly NOTE_EXPR_PARAMS = [
    'velocity', 'vel', 'pan', 'gain', 'gate', 'transpose', 'glide', 'detune',
    'humanize', 'human', 'octave', 'accent',
  ] as const;

  private parseExpression(
    named: Record<string, string>,
    line: number,
    ctx: string,
    extraParams: readonly string[] = [],
    reserved: readonly string[] = []
  ): NoteExpression {
    this.rejectUnknownParams(
      Object.keys(named),
      [...SPGParser.NOTE_EXPR_PARAMS, ...extraParams],
      ctx, line
    );

    /**
     * `reserved` 里的键由调用方自己消费，这里不再当作表现力参数解释。
     *
     * 典型冲突是 `octave`：在 `chord("Am7","1n", octave=3)` 里它是"和弦发在第几八度"
     * （声位寄存器），在 `note("C4","4n", octave=1)` 里它是"升高一个八度"。
     * 若两边都解释，chord 的 octave=3 会同时把整组音再升高 36 个半音，
     * 和弦直接飞到听不见的高频。
     */
    const isReserved = (k: string) => reserved.includes(k);
    const has = (k: string) => !isReserved(k) && named[k] !== undefined;

    const expr: NoteExpression = {};
    if (has('velocity') || has('vel')) {
      expr.velocity = Math.max(0, Math.min(1, this.num(named, ['velocity', 'vel'], 0.8, ctx, line)));
    }
    if (has('pan')) {
      expr.pan = Math.max(-1, Math.min(1, this.num(named, ['pan'], 0, ctx, line)));
    }
    if (has('gain')) {
      expr.gain = Math.max(0, this.num(named, ['gain'], 1, ctx, line));
    }
    if (has('gate')) {
      expr.gate = Math.max(0, this.num(named, ['gate'], 1, ctx, line));
    }
    if (has('transpose')) {
      expr.transpose = this.num(named, ['transpose'], 0, ctx, line);
    }
    if (has('octave')) {
      // 八度是"音乐单位"，与半音制的 transpose 分开，避免模型把 12 和 1 写混
      expr.transpose = (expr.transpose ?? 0) + this.num(named, ['octave'], 0, ctx, line) * 12;
    }
    if (has('glide')) {
      expr.glide = Math.max(0, this.num(named, ['glide'], 0, ctx, line));
    }
    if (has('detune')) {
      expr.detune = this.num(named, ['detune'], 0, ctx, line);
    }
    if (has('humanize') || has('human')) {
      expr.humanize = Math.max(0, Math.min(1, this.num(named, ['humanize', 'human'], 0, ctx, line)));
    }
    // accent 是重音的简写：直接顶到最强力度
    if (!isReserved('accent') && this.bool(named, ['accent'], false, ctx, line)) {
      expr.velocity = 1;
    }
    return expr;
  }

  /* ---- 和弦符号与音高展开 ---- */

  /**
   * 判断一个 token 是否"看起来像和弦符号"而不是音名，用于给出可操作的报错：
   * `note("Am7","2n")` 报"无法识别的音名 Am7"时模型很难判断该怎么改，
   * 识别出它是和弦符号后可以直接建议改用 `chord("Am7","2n")`。
   */
  private looksLikeChordSymbol(text: string): boolean {
    const t = text.trim();
    // 纯音名（含频率写法）不算和弦符号
    if (/^[A-Ga-g][#b♯♭]{0,3}-?\d+$/.test(t)) return false;
    if (/^[\d.]+\s*hz$/i.test(t)) return false;
    // `Am7` / `Cmaj9` / `G7/B` 这类：根音字母 + 性质后缀（可带斜杠低音）
    if (/^[A-Ga-g][#b♯♭]?(maj|min|m|M|dim|aug|sus|add|no|omit|[#b]?\d|Δ|ø|\+|-|\/|[()\s])/i.test(t)) return true;
    return false;
  }

  /** 解析和弦符号，失败时抛出带建议的 SPGError */
  private requireChordSymbol(text: string, ctx: string, line: number): ChordSymbol {
    const symbol = parseChordSymbol(text);
    if (!symbol) {
      throw new SPGError(
        `${ctx}: 无法识别的和弦符号 "${text}"。`
        + `可用写法如 C / Am / Fmaj7 / G7 / Dm7b5 / Bb / C/E / Am7/G；`
        + `也可直接给音高数组 ["C4","E4","G4"]`, line
      );
    }
    return symbol;
  }

  /**
   * 把单个 token 展开成音名数组：`[` 开头 → 音高数组；合法音名 → 原样返回；否则按和弦符号展开。
   *
   * 顺序很重要：必须先试音名。`"C4"` 既是合法音名、也满足和弦符号的根音语法，
   * 若先当和弦处理会把单音展开成三和弦。
   */
  private expandPitchOrChord(
    token: string,
    voicing: VoicingStyle,
    octave: number,
    line: number,
    ctx: string
  ): string[] {
    const t = String(token ?? '').trim();
    if (!t) return [];

    if (t.startsWith('[')) {
      const items = this.parseArray(t);
      items.forEach((p) => this.validatePitch(p, ctx, line));
      return items;
    }

    // 合法音名（含 440hz）优先
    try {
      getMidi(t);
      return [t];
    } catch {
      /* 不是音名，继续按和弦符号尝试 */
    }

    const symbol = this.requireChordSymbol(t, ctx, line);
    return voicingToPitches(symbol, octave, voicing);
  }

  /* ---- 主解析 ---- */

  public parse(code: string): ParseResult {
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new SPGError('代码为空', 1);
    }

    this.warnings = [];

    const instruments = new Map<string, InstrumentDef>();
    const sequences = new Map<string, SequenceDef>();
    let effects: EffectDef[] = [];
    let mix: MixTrack[] = [];
    let tempo = 120;
    let masterVolumeConfig = 0.6;
    let key = 'C';
    let scale = 'major';
    let swing = 0;

    const cleanCode = this.stripComments(code);
    const lineOf = this.makeLineLookup(cleanCode);

    /* ---- 1. config ---- */
    const configBlocks = this.findBlocks(cleanCode, 'config', lineOf);
    if (configBlocks.length > 1) {
      throw new SPGError('只允许一个 config 块', configBlocks[1].line);
    }
    if (configBlocks.length === 1) {
      const block = configBlocks[0];
      const body = block.body;
      const bodyLine = lineOf(block.bodyStart);
      const cfg = this.parseFields(body, lineOf, block.bodyStart);

      this.rejectUnknownParams(
        cfg.keys(), ['tempo', 'bpm', 'master_gain', 'gain', 'key', 'scale', 'swing'],
        'config', bodyLine
      );

      // bpm 是 tempo 最自然的同义写法，模型经常直接写 bpm
      const tempoField = this.field(cfg, 'tempo') ?? this.field(cfg, 'bpm');
      if (tempoField !== null) {
        tempo = this.strictFloat(tempoField.value);
        if (!Number.isFinite(tempo) || tempo <= 0 || tempo > 1000) {
          throw new SPGError(
            `tempo 必须大于 0 且不超过 1000（收到 ${tempoField.value}）`, tempoField.line
          );
        }
      }
      const volField = this.field(cfg, 'master_gain') ?? this.field(cfg, 'gain');
      if (volField !== null) {
        masterVolumeConfig = this.strictFloat(volField.value);
        if (!Number.isFinite(masterVolumeConfig) || masterVolumeConfig < 0) {
          throw new SPGError(`master_gain 不能为负数（收到 ${volField.value}）`, volField.line);
        }
        masterVolumeConfig = Math.min(2, masterVolumeConfig);
      }
      const keyField = this.field(cfg, 'key');
      if (keyField !== null) {
        if (!/^[A-Ga-g][#b♯♭]?m?$/.test(keyField.value.trim())) {
          throw new SPGError(
            `key 必须是调性记号，如 C / Am / F# / Bbm（收到 "${keyField.value}"）`, keyField.line
          );
        }
        key = keyField.value.trim();
      }
      const scaleField = this.field(cfg, 'scale');
      if (scaleField !== null) {
        scale = this.enum_(scaleField.value, SCALE_NAMES, 'config scale', scaleField.line);
      }
      const swingField = this.field(cfg, 'swing');
      if (swingField !== null) {
        swing = this.strictFloat(swingField.value);
        if (!Number.isFinite(swing) || swing < 0 || swing > 1) {
          throw new SPGError(`swing 必须在 0~1 之间（收到 ${swingField.value}）`, swingField.line);
        }
      }
    }

    /* ---- 2. 乐器定义 ---- */
    const instBlocks = this.findBlocks(cleanCode, 'define_instrument', lineOf);
    for (const block of instBlocks) {
      const { named: instHeader } = this.parseArgs(block.header.replace(/^\(|\)$/g, ''));
      const name = this.unquote(instHeader.name ?? instHeader.instrument ?? instHeader.id ?? '');
      if (!name) {
        throw new SPGError(
          'define_instrument 缺少 name 参数（写法：define_instrument(name="lead") { ... }）',
          block.line
        );
      }
      if (instruments.has(name)) {
        throw new SPGError(`乐器 "${name}" 重复定义`, block.line);
      }

      const ctx = `乐器 "${name}"`;
      const body = block.body;
      const bodyLine = lineOf(block.bodyStart);

      // 块内字段一次性扫描成「键 → 值 + 行号」，避免逐字段正则互相串味
      const fields = this.parseFields(body, lineOf, block.bodyStart);

      this.rejectUnknownParams(fields.keys(), [
        'preset', 'wave', 'envelope', 'env', 'amp_envelope', 'filter', 'filter_envelope',
        'filter_env_amount', 'lfo', 'pan', 'gain', 'fm_wave', 'fm_index', 'fm_ratio',
        'detune', 'glide', 'glide_from', 'pitch_env_amount', 'pitch_decay', 'spread',
        'velocity_sensitivity', 'velocity_to_filter', 'voices', 'unison_spread',
        'harmonics', 'attack_noise', 'loop_point',
        // `effect_chain { ... }` 是嵌套块，不是 `键: 值` 字段，
        // 但写成 `effect_chain: { ... }` 也应当被接受而不是报未知参数
        'effect_chain',
      ], ctx, bodyLine);

      // 预设作为基线
      const presetField = this.field(fields, 'preset');
      let base: Partial<InstrumentDef> = {};
      if (presetField) {
        const loaded = getPreset(presetField.value);
        if (!loaded) {
          throw new SPGError(
            `${ctx}: 未知预设 "${presetField.value}"。可用预设：${PRESET_NAMES.join(' / ')}`,
            presetField.line
          );
        }
        base = { ...loaded };
      }

      // 嵌套的乐器级效果链：先摘出去，避免干扰其它字段匹配
      const instEffectBlocks = this.findBlocks(body, 'effect_chain', (i) => lineOf(block.bodyStart + i));
      let instEffects: EffectDef[] | undefined;
      if (instEffectBlocks.length > 1) {
        throw new SPGError(`${ctx}: 只允许一个乐器级 effect_chain`, block.line);
      }
      if (instEffectBlocks.length === 1) {
        const eb = instEffectBlocks[0];
        instEffects = this.parseEffects(
          eb.body, tempo, lineOf, block.bodyStart + eb.bodyStart, ctx
        );
      }

      // 每个字段的报错都定位到**它自己**那一行，而不是块首
      const waveField = this.field(fields, 'wave');
      const wave = this.enum_(
        waveField?.value ?? base.wave ?? 'sine', OSC_WAVES, `${ctx} wave`,
        waveField?.line ?? bodyLine
      );

      const envField = this.field(fields, 'envelope')
        ?? this.field(fields, 'env')
        ?? this.field(fields, 'amp_envelope');
      const envelope = (envField ? this.parseEnvelope(envField.value, ctx, envField.line) : undefined)
        ?? base.envelope ?? DEFAULT_ENVELOPE;

      const filterField = this.field(fields, 'filter');
      const filter = (filterField ? this.parseFilter(filterField.value, ctx, filterField.line) : undefined)
        ?? base.filter;

      const filterEnvField = this.field(fields, 'filter_envelope');
      const filterEnvelope = (filterEnvField
        ? this.parseEnvelope(filterEnvField.value, ctx, filterEnvField.line)
        : undefined) ?? base.filterEnvelope;

      const lfoField = this.field(fields, 'lfo');
      const lfo = (lfoField ? this.parseLFO(lfoField.value, ctx, lfoField.line) : undefined) ?? base.lfo;

      // 自定义谐波
      let harmonics = base.harmonics;
      const harmField = this.field(fields, 'harmonics');
      if (harmField !== null) {
        harmonics = this.parseArray(harmField.value)
          .map((v) => this.strictFloat(v))
          .filter((v) => Number.isFinite(v));
        if (harmonics.length === 0) {
          throw new SPGError(`${ctx}: harmonics 数组不能为空`, harmField.line);
        }
      }

      // FM 调制器必须是真正的振荡器波形：写噪声名会在合成器被静默跳过
      // （听到的就是没 FM 的声音），写 custom 则退化成 sine —— 两种都是"写了白写"。
      // 预设里带的 fm_wave 同样过一遍校验：预设表由本文件维护，写错在这里就该拦住。
      const fmWaveField = this.field(fields, 'fm_wave');
      const fmWaveSource = fmWaveField?.value ?? base.fm_wave;
      const fmWave = fmWaveSource
        ? this.enum_(fmWaveSource, OSCILLATOR_WAVES,
          `${ctx} fm_wave（只能是 sine / square / sawtooth / triangle）`,
          fmWaveField?.line ?? bodyLine)
        : undefined;

      const pickNum = (key: string, baseVal: number | undefined, fallback?: number): number | undefined => {
        const v = this.fieldNumber(fields, key, ctx);
        if (v !== null) return v;
        if (baseVal !== undefined) return baseVal;
        return fallback;
      };

      // fm_ratio 是倍频比：0 会让 FM 静默关闭（合成器按 falsy 跳过），
      // 负数会被取绝对值 —— 两种都是"写了跟没写不一样，但又不报错"。
      const fmRatio = pickNum('fm_ratio', base.fm_ratio);
      if (fmRatio !== undefined && fmRatio <= 0) {
        throw new SPGError(
          `${ctx}: fm_ratio 是倍频比，必须为正数（收到 ${fmRatio}）`
          + `；不需要 FM 时直接删掉 fm_wave / fm_ratio / fm_index`,
          this.fieldLine(fields, 'fm_ratio', bodyLine)
        );
      }

      /**
       * wave: "custom" 必须配 harmonics，否则合成器找不到 PeriodicWave 会退回 sine。
       * 但 harmonics 可以来自预设基线，所以这里查的是最终值而不是本块的字段。
       */
      if (wave === 'custom' && harmonics === undefined) {
        throw new SPGError(
          `${ctx}: wave "custom" 需要配合 harmonics 使用`
          + `（如 harmonics: [1, 0.5, 0.25]），否则请写具体波形：`
          + `sine / square / sawtooth / triangle`,
          waveField?.line ?? bodyLine
        );
      }

      /**
       * 噪声波形走 BufferSource，**根本没有振荡器**，谐波无处可挂。
       * 不拦的话 `wave:"white_noise" + harmonics:[...]` 会安静地按纯噪声发声，
       * 用户以为自己叠加了谐波音色，实际什么都没发生。
       */
      if (harmonics !== undefined && isNoiseWave(wave)) {
        throw new SPGError(
          `${ctx}: wave "${wave}" 是噪声，不能配合 harmonics 使用`
          + `（噪声没有振荡器可挂谐波）。请改用 sine / square / sawtooth / triangle，`
          + `或直接写 wave: "custom"`,
          harmField?.line ?? waveField?.line ?? bodyLine
        );
      }

      // 时长类参数为负数没有任何物理意义，合成器会静默按 0 处理
      for (const k of ['glide', 'pitch_decay', 'loop_point']) {
        const v = this.fieldNumber(fields, k, ctx);
        if (v !== null && v < 0) {
          throw new SPGError(
            `${ctx}: 参数 ${k} 不能为负数（收到 ${v}）`, this.fieldLine(fields, k, bodyLine)
          );
        }
      }

      instruments.set(name, {
        name,
        wave,
        envelope,
        filter,
        filterEnvelope,
        filterEnvAmount: pickNum('filter_env_amount', base.filterEnvAmount, 0),
        lfo,
        pan: pickNum('pan', base.pan),
        gain: pickNum('gain', base.gain, 0.8)!,
        fm_wave: fmWave,
        fm_index: pickNum('fm_index', base.fm_index),
        fm_ratio: fmRatio,
        detune: pickNum('detune', base.detune),

        glide: pickNum('glide', base.glide, 0),
        glideFrom: pickNum('glide_from', base.glideFrom, -12),
        pitchEnvAmount: pickNum('pitch_env_amount', base.pitchEnvAmount, 0),
        pitchDecay: pickNum('pitch_decay', base.pitchDecay, 0.05),
        spread: pickNum('spread', base.spread, 0),
        velocitySensitivity: pickNum('velocity_sensitivity', base.velocitySensitivity, 0.7),
        velocityToFilter: pickNum('velocity_to_filter', base.velocityToFilter, 0),
        voices: Math.max(1, Math.min(7, Math.round(pickNum('voices', base.voices, 1) ?? 1))),
        unisonSpread: pickNum('unison_spread', base.unisonSpread, 12),
        harmonics,
        attackNoise: Math.max(0, Math.min(1, pickNum('attack_noise', base.attackNoise, 0) ?? 0)),
        effects: instEffects ?? base.effects,
        loopPoint: pickNum('loop_point', base.loopPoint, 0),
      });
    }

    /* ---- 3. 全局效果链（只取顶层的，乐器块内的已在上一步消费） ---- */
    const topLevelEffects: EffectDef[] = [];
    const allEffectBlocks = this.findBlocks(cleanCode, 'effect_chain', lineOf);
    for (const eb of allEffectBlocks) {
      const insideInstrument = instBlocks.some(
        (ib) => eb.headerStart > ib.bodyStart && eb.headerStart < ib.bodyStart + ib.body.length
      );
      if (insideInstrument) continue;
      topLevelEffects.push(
        ...this.parseEffects(eb.body, tempo, lineOf, eb.bodyStart, 'effect_chain')
      );
    }
    effects = topLevelEffects;

    /* ---- 4. 音序 ---- */
    const seqBlocks = this.findBlocks(cleanCode, 'sequence', lineOf);
    for (const block of seqBlocks) {
      const { named: seqHeader } = this.parseArgs(block.header.replace(/^\(|\)$/g, ''));
      const seqName = this.unquote(seqHeader.name ?? seqHeader.seq ?? seqHeader.id ?? '');
      if (!seqName) {
        throw new SPGError(
          'sequence 缺少 name 参数（写法：sequence(name="melody", instrument="lead") { ... }）',
          block.line
        );
      }
      if (sequences.has(seqName)) {
        throw new SPGError(`音序 "${seqName}" 重复定义`, block.line);
      }

      this.rejectUnknownParams(
        Object.keys(seqHeader),
        ['name', 'seq', 'id', 'instrument', 'inst', 'gain', 'transpose', 'humanize'],
        `sequence "${seqName}" 头部`, block.line
      );

      const instrumentName = this.unquote(seqHeader.instrument ?? seqHeader.inst ?? 'default');
      const ctx = `音序 "${seqName}"`;

      // 只有真正含音高类指令的音序才需要乐器；纯 hit 的鼓组音序不需要任何乐器定义。
      const bodyHasPitched = /\b(note|chord|arp|progression|run)\s*\(/.test(block.body);
      if (bodyHasPitched && !instruments.has(instrumentName) && instrumentName !== 'default') {
        throw new SPGError(
          `${ctx} 引用了未定义的乐器 "${instrumentName}"。`
          + `已定义的乐器：${instruments.size > 0 ? Array.from(instruments.keys()).join(' / ') : '（无）'}`,
          block.line
        );
      }

      const commands: SequenceCommand[] = [];
      const bodyAbsStart = block.bodyStart;
      const statements = this.splitStatements(block.body);

      /**
       * 把 chord/progression 的输入统一展开成音名数组，支持三种写法：
       * 音名数组 `["C4","E4","G4"]`、和弦符号 `"Am7"`（引擎按声位规则展开，
       * 避免模型自己算错音程）、和弦符号数组 `["Am7","Dm7"]`。
       */
      const resolvePitches = (
        raw: string | undefined,
        voicing: VoicingStyle,
        octave: number,
        lineNo: number,
        what: string
      ): string[] => {
        if (raw === undefined) return [];
        const trimmed = raw.trim();
        if (trimmed.startsWith('[')) {
          const items = this.parseArray(trimmed);
          const out: string[] = [];
          for (const item of items) {
            out.push(...this.expandPitchOrChord(item, voicing, octave, lineNo, ctx));
          }
          return out;
        }
        const single = this.unquote(trimmed);
        return this.expandPitchOrChord(single, voicing, octave, lineNo, `${ctx} ${what}`);
      };

      statements.forEach(({ text: line, offset }) => {
        const lineNo = lineOf(bodyAbsStart + offset);

        const call = line.match(/^(\w+)\s*\(([\s\S]*)\)\s*$/);
        if (!call) {
          throw new SPGError(
            `${ctx}: 无法解析的指令 "${line}"（应为 note / chord / arp / hit / rest / progression / run）`,
            lineNo
          );
        }
        const cmdName = call[1].toLowerCase();
        const { positional, named } = this.parseArgs(call[2]);

        /** 位置参数与具名参数统一取值：具名优先，其次按位置序号 */
        const arg = (keys: string[], idx: number): string | undefined => {
          for (const k of keys) {
            if (named[k] !== undefined) return this.unquote(named[k]);
          }
          const v = positional[idx];
          return v === undefined ? undefined : this.unquote(v);
        };

        switch (cmdName) {
          case 'note': {
            // 具名参数恰恰是 LLM 最偏爱的写法，不能只认位置参数
            const pitch = arg(['pitch', 'note', 'n'], 0) ?? '';
            const duration = arg(['duration', 'dur', 'len', 'd'], 1) ?? '';
            const expr = this.parseExpression(
              named, lineNo, ctx,
              ['pitch', 'note', 'n', 'duration', 'dur', 'len', 'd']
            );
            if (!pitch) {
              throw new SPGError(
                `${ctx}: note 缺少音高参数（写法：note("C4", "4n")）`, lineNo
              );
            }
            if (!duration) {
              throw new SPGError(`${ctx}: note("${pitch}") 缺少时值参数`, lineNo);
            }
            // 一个音符位置写了和弦符号（`note("Am7","2n")`）是模型常见笔误，
            // 静默当音名只会报"无法识别的音名"，这里给出可操作的提示。
            if (this.looksLikeChordSymbol(pitch)) {
              throw new SPGError(
                `${ctx}: note() 只能写单个音名，"${pitch}" 看起来是和弦符号。`
                + `请改用 chord("${pitch}", "${duration || '2n'}")`, lineNo
              );
            }
            this.validatePitch(pitch, ctx, lineNo);
            this.validateDuration(duration, tempo, ctx, lineNo);
            commands.push({ type: 'note', pitch, duration, ...expr });
            break;
          }

          case 'chord': {
            const arrRaw = positional.find((a) => a.trim().startsWith('['))
              ?? named.pitches ?? named.chord ?? named.notes
              ?? (positional[0] !== undefined ? positional[0] : undefined);
            if (arrRaw === undefined) {
              throw new SPGError(
                `${ctx}: chord 需要一个音高数组或和弦符号，`
                + `如 chord(["C4","E4","G4"], "2n") 或 chord("Am7", "2n")`, lineNo
              );
            }
            const expr = this.parseExpression(
              named, lineNo, ctx,
              ['strum', 'voicing', 'pitches', 'chord', 'notes', 'duration', 'dur'],
              // octave/voicing 属于"和弦声位"，不能同时被当成移调参数
              ['octave', 'voicing']
            );
            const voicing = named.voicing !== undefined
              ? this.enum_(this.unquote(named.voicing), VOICING_STYLES, `${ctx} voicing`, lineNo)
              : 'close';
            const octave = named.octave !== undefined
              ? this.num(named, ['octave'], 4, ctx, lineNo)
              : 4;

            const pitches = resolvePitches(arrRaw, voicing, octave, lineNo, 'chord');
            if (pitches.length === 0) {
              throw new SPGError(`${ctx}: chord 的音高数组为空`, lineNo);
            }
            pitches.forEach((p) => this.validatePitch(p, ctx, lineNo));

            // 时值：优先具名，否则取数组/和弦符号之后的位置参数
            const arrIdx = positional.findIndex((a) => a.trim().startsWith('['));
            const durFromPos = arrIdx >= 0 ? positional[arrIdx + 1] : positional[1];
            const duration = this.unquote(
              named.duration ?? named.dur ?? durFromPos ?? ''
            );
            if (!duration) throw new SPGError(`${ctx}: chord 缺少时值参数`, lineNo);
            this.validateDuration(duration, tempo, ctx, lineNo);

            const strum = named.strum !== undefined
              ? Math.max(0, Math.min(1, this.num(named, ['strum'], 0, ctx, lineNo)))
              : 0;
            commands.push({ type: 'chord', pitches, duration, strum, ...expr });
            break;
          }

          case 'arp': {
            let pitches: string[] = [];
            /**
             * 第一个位置参数既可以是音高数组，也可以是**和弦符号字符串**。
             * 和弦符号是模型最自然的写法，只认 `[...]` 会把它逼进反复试错。
             */
            const arrIdx = positional.findIndex((a) => a.trim().startsWith('['));
            const expr = this.parseExpression(named, lineNo, ctx, [
              'pattern', 'rate', 'octaves', 'chord', 'notes', 'pitches', 'voicing',
              'duration', 'dur',
            ], ['octave', 'voicing']);
            const voicing = named.voicing !== undefined
              ? this.enum_(this.unquote(named.voicing), VOICING_STYLES, `${ctx} voicing`, lineNo)
              : 'close';
            const baseOctave = named.octave !== undefined
              ? this.num(named, ['octave'], 4, ctx, lineNo)
              : 4;

            /**
             * 音高来源的优先级：具名参数 > 位置参数。具名参数一旦给出，位置参数就全部
             * 让位给 pattern/rate/duration —— 否则 `arp(chord=["C4"], "up", "16n", "1n")`
             * 会把 `"up"` 当成和弦符号去解析。
             */
            const namedPitchSource = named.chord ?? named.notes ?? named.pitches;
            const posPitchSource = arrIdx >= 0 ? positional[arrIdx] : positional[0];
            // pattern/rate/duration 的起始下标：跳过已被当作音高来源的参数
            const afterPitchIdx = namedPitchSource !== undefined
              ? 0
              : (arrIdx >= 0 ? arrIdx + 1 : 1);

            if (namedPitchSource !== undefined) {
              pitches = resolvePitches(namedPitchSource, voicing, baseOctave, lineNo, 'arp');
            } else if (posPitchSource !== undefined) {
              pitches = resolvePitches(posPitchSource, voicing, baseOctave, lineNo, 'arp');
            }
            if (pitches.length === 0) {
              throw new SPGError(
                `${ctx}: arp 需要音高数组或和弦符号，`
                + `如 arp("Am7", pattern="up", rate="16n", duration="1n")`, lineNo
              );
            }
            pitches.forEach((p) => this.validatePitch(p, ctx, lineNo));

            // 位置参数依次为 [音高来源, pattern, rate, duration]，从音高来源之后取
            const rest = positional.slice(afterPitchIdx);

            const pattern = named.pattern
              ? this.enum_(this.unquote(named.pattern), ARP_PATTERNS, `${ctx} arp pattern`, lineNo)
              : (rest[0] !== undefined
                ? this.enum_(this.unquote(rest[0]), ARP_PATTERNS, `${ctx} arp pattern`, lineNo)
                : 'up');

            const rate = this.unquote(this.str(
              named, ['rate'],
              rest[1] !== undefined ? this.unquote(rest[1]) : '16n'
            ));
            const duration = this.unquote(this.str(
              named, ['duration', 'dur'],
              rest[2] !== undefined ? this.unquote(rest[2]) : ''
            ));
            if (!duration) {
              throw new SPGError(`${ctx}: arp 缺少 duration 参数（琶音总时长）`, lineNo);
            }

            const stepDur = this.validateDuration(rate, tempo, ctx, lineNo);
            if (!Number.isFinite(stepDur) || stepDur <= 0) {
              throw new SPGError(`${ctx}: arp 的 rate="${rate}" 解析为 ${stepDur}，必须为正时值`, lineNo);
            }
            const totalDur = this.validateDuration(duration, tempo, ctx, lineNo);
            if (!Number.isFinite(totalDur) || totalDur <= 0) {
              throw new SPGError(`${ctx}: arp 的 duration="${duration}" 必须为正时值`, lineNo);
            }

            const octaves = named.octaves !== undefined
              ? Math.max(1, Math.min(4, Math.round(this.num(named, ['octaves'], 1, ctx, lineNo))))
              : 1;

            commands.push({
              type: 'arp', pitches, pattern, rate, duration, octaves,
              gate: named.gate !== undefined ? this.num(named, ['gate'], 0.9, ctx, lineNo) : 0.9,
              ...expr,
            });
            break;
          }

          case 'progression': {
            // duration/dur 不在白名单里：progression 的时值只认 beats/beat/位置参数，
            // 收进白名单会让 `duration="2n"` 静默失效。写了就报错并列出可用参数。
            const expr = this.parseExpression(named, lineNo, ctx, [
              'chords', 'beats', 'beat', 'voicing', 'octave', 'octaves', 'pattern',
              'strum',
            ], ['octave', 'voicing']);
            const chordsRaw = positional.find((a) => a.trim().startsWith('['))
              ?? named.chords ?? named.chord ?? positional[0];
            if (chordsRaw === undefined) {
              throw new SPGError(
                `${ctx}: progression 需要和弦数组，`
                + `如 progression(["Am7","Dm7","G7","Cmaj7"], "1n")`, lineNo
              );
            }
            const symbols = this.parseArray(chordsRaw);
            if (symbols.length === 0) {
              throw new SPGError(`${ctx}: progression 的和弦数组为空`, lineNo);
            }
            const voicing = named.voicing !== undefined
              ? this.enum_(this.unquote(named.voicing), VOICING_STYLES, `${ctx} voicing`, lineNo)
              : 'close';
            const octave = named.octave !== undefined
              ? this.num(named, ['octave'], 4, ctx, lineNo)
              : 4;
            const octaves = named.octaves !== undefined
              ? Math.max(1, Math.min(4, Math.round(this.num(named, ['octaves'], 1, ctx, lineNo))))
              : 1;
            const pattern = named.pattern !== undefined
              ? this.enum_(this.unquote(named.pattern), ARP_PATTERNS, `${ctx} progression pattern`, lineNo)
              : 'asPlayed';

            const arrIdx = positional.findIndex((a) => a.trim().startsWith('['));
            const beatFromPos = arrIdx >= 0 ? positional[arrIdx + 1] : positional[1];
            const beatsRaw = named.beats ?? named.beat ?? beatFromPos;
            if (beatsRaw === undefined) {
              throw new SPGError(
                `${ctx}: progression 缺少每和弦时值，如 progression([...], "1n")`, lineNo
              );
            }

            // 时值可以是单个记号（每个和弦等长），也可以是与和弦数等长的数组
            let beatList: string[];
            const beatsText = beatsRaw.trim();
            if (beatsText.startsWith('[')) {
              beatList = this.parseArray(beatsText);
              if (beatList.length !== symbols.length) {
                throw new SPGError(
                  `${ctx}: progression 的时值数组长度 (${beatList.length}) `
                  + `与和弦数 (${symbols.length}) 不一致`, lineNo
                );
              }
            } else {
              beatList = new Array(symbols.length).fill(this.unquote(beatsText));
            }
            beatList.forEach((b) => this.validateDuration(b, tempo, ctx, lineNo));

            // 和弦符号 → 音名数组；允许数组里混写具体音名数组
            const expandedChords: string[][] = symbols.map((sym) => {
              const pitches = sym.trim().startsWith('[')
                ? this.parseArray(sym)
                : voicingToPitches(
                  this.requireChordSymbol(sym, ctx, lineNo), octave, voicing
                );
              if (pitches.length === 0) {
                throw new SPGError(`${ctx}: progression 中的和弦 "${sym}" 展开为空`, lineNo);
              }
              pitches.forEach((p) => this.validatePitch(p, ctx, lineNo));
              return pitches;
            });

            const chordCommand: ProgressionCommand = {
              type: 'progression',
              chords: expandedChords,
              beats: beatList,
              octaves,
              pattern,
              gate: named.gate !== undefined
                ? Math.max(0, this.num(named, ['gate'], 1, ctx, lineNo))
                : 1,
              strum: named.strum !== undefined
                ? Math.max(0, Math.min(1, this.num(named, ['strum'], 0, ctx, lineNo)))
                : 0,
              ...expr,
            };
            commands.push(chordCommand);
            break;
          }

          case 'run': {
            // 白名单只收"真的会被消费"的键：from/to/octaves/scale/key 这类
            // "合法但无用"的写法，写了不报错也不生效，与未知参数静默忽略是同一类陷阱。
            const expr = this.parseExpression(named, lineNo, ctx, [
              'notes', 'pitches', 'pattern',
              'direction', 'repeat', 'times', 'rate', 'step',
            ]);
            const notesRaw = positional.find((a) => a.trim().startsWith('['))
              ?? named.notes ?? named.pitches;
            if (notesRaw === undefined) {
              throw new SPGError(
                `${ctx}: run 需要音高数组，如 run(["C4","D4","E4","G4"], "16n")`, lineNo
              );
            }
            const pitches = this.parseArray(notesRaw);
            if (pitches.length === 0) {
              throw new SPGError(`${ctx}: run 的音高数组为空`, lineNo);
            }
            pitches.forEach((p) => this.validatePitch(p, ctx, lineNo));

            const arrIdx = positional.findIndex((a) => a.trim().startsWith('['));
            const rateFromPos = arrIdx >= 0 ? positional[arrIdx + 1] : positional[1];
            const rateRaw = named.rate ?? named.step ?? rateFromPos;
            if (rateRaw === undefined) {
              throw new SPGError(`${ctx}: run 缺少速率参数，如 run([...], "16n")`, lineNo);
            }
            const rate = this.unquote(rateRaw);
            const stepDur = this.validateDuration(rate, tempo, ctx, lineNo);
            if (!(stepDur > 0)) {
              throw new SPGError(`${ctx}: run 的 rate="${rate}" 必须为正时值`, lineNo);
            }

            const repeat = named.repeat !== undefined || named.times !== undefined
              ? Math.max(1, Math.round(this.num(named, ['repeat', 'times'], 1, ctx, lineNo)))
              : 1;

            // direction 与 pattern 都接受，取交集后映射到 run 的三种走向
            const dirRaw = named.direction ?? named.pattern;
            let direction: 'up' | 'down' | 'updown' = 'up';
            if (dirRaw !== undefined) {
              const parsed = this.enum_(
                this.unquote(dirRaw), ARP_PATTERNS, `${ctx} run direction`, lineNo
              );
              if (parsed === 'down') direction = 'down';
              else if (parsed === 'upDown' || parsed === 'downUp') direction = 'updown';
              else direction = 'up';
            }

            const runCommand: RunCommand = {
              type: 'run', pitches, rate, repeat, direction,
              gate: named.gate !== undefined
                ? Math.max(0, this.num(named, ['gate'], 1, ctx, lineNo))
                : 1,
              ...expr,
            };
            commands.push(runCommand);
            break;
          }

          case 'hit': {
            /**
             * 鼓组名可以是位置参数，也可以用 `drum=` / `name=` 具名传入。
             *
             * 刻意不收 `kit=` 这个别名：`kit` 在鼓组语境里指"整套鼓"，
             * 而这里要的是**单件**鼓（kick/hat/…）。留着它会让
             * `hit(kit="kick")` 这种把集合当成员的写法通过，把错误的名字概念固化下来。
             */
            const drumRaw = arg(['drum', 'name'], 0) ?? '';
            if (!drumRaw) {
              throw new SPGError(
                `${ctx}: hit 缺少鼓组名，如 hit("kick", "4n")。`
                + `可用：${DRUM_NAMES.join(' / ')}`, lineNo
              );
            }
            const drum = this.enum_(drumRaw, DRUM_NAMES, `${ctx} 鼓组`, lineNo);
            const duration = arg(['duration', 'dur', 'len'], 1) ?? '8n';
            const expr = this.parseExpression(named, lineNo, ctx, [
              'drum', 'name', 'tune', 'decay', 'tone', 'snap',
              'duration', 'dur', 'len',
            ]);
            this.validateDuration(duration, tempo, ctx, lineNo);

            // 鼓组微调参数：写出来就必须生效，否则用户听到的不是自己写的
            const drumTune = named.tune !== undefined ? this.num(named, ['tune'], 0, ctx, lineNo) : undefined;
            const drumDecay = named.decay !== undefined ? this.num(named, ['decay'], 1, ctx, lineNo) : undefined;
            const drumTone = named.tone !== undefined ? this.num(named, ['tone'], 0, ctx, lineNo) : undefined;
            const drumSnap = named.snap !== undefined ? this.num(named, ['snap'], 0, ctx, lineNo) : undefined;
            if (drumDecay !== undefined && drumDecay <= 0) {
              throw new SPGError(`${ctx}: hit 的 decay 必须为正数（收到 ${drumDecay}）`, lineNo);
            }
            if (drumSnap !== undefined && (drumSnap < 0 || drumSnap > 1)) {
              throw new SPGError(`${ctx}: hit 的 snap 必须在 0~1 之间（收到 ${drumSnap}）`, lineNo);
            }

            commands.push({
              type: 'hit', drum, duration, ...expr,
              drumTune, drumDecay, drumTone, drumSnap,
            });
            break;
          }

          case 'rest': {
            const duration = arg(['duration', 'dur', 'len'], 0) ?? '';
            if (!duration) throw new SPGError(`${ctx}: rest 缺少时值参数，如 rest("4n")`, lineNo);
            this.rejectUnknownParams(
              Object.keys(named), ['duration', 'dur', 'len'], `${ctx} rest()`, lineNo);
            this.validateDuration(duration, tempo, ctx, lineNo);
            commands.push({ type: 'rest', duration });
            break;
          }

          default:
            throw new SPGError(
              `${ctx}: 未知指令 "${call[1]}"。`
              + `可用：note / chord / arp / hit / rest / progression / run`, lineNo
            );
        }
      });

      if (commands.length === 0) {
        throw new SPGError(`${ctx} 是空的，至少需要一条指令`, block.line);
      }

      sequences.set(seqName, {
        name: seqName,
        instrumentName,
        commands,
        gain: seqHeader.gain !== undefined ? this.num(seqHeader, ['gain'], 1, ctx, block.line) : 1,
        transpose: seqHeader.transpose !== undefined ? this.num(seqHeader, ['transpose'], 0, ctx, block.line) : 0,
        humanize: seqHeader.humanize !== undefined
          ? Math.max(0, Math.min(1, this.num(seqHeader, ['humanize'], 0, ctx, block.line)))
          : 0,
      });
    }

    /* ---- 5. mix ---- */
    const mixBlocks = this.findBlocks(cleanCode, 'mix', lineOf);
    if (mixBlocks.length > 1) {
      throw new SPGError('只允许一个 mix 块', mixBlocks[1].line);
    }
    if (mixBlocks.length === 1) {
      const mixAbsStart = mixBlocks[0].bodyStart;
      this.splitStatements(mixBlocks[0].body).forEach(({ text: line, offset }) => {
        const lineNo = lineOf(mixAbsStart + offset);
        const m = line.match(/^track\s*\(([\s\S]*)\)\s*$/);
        if (!m) {
          throw new SPGError(`mix: 无法解析的指令 "${line}"（应为 track(source="...", time=0, loop=1)）`, lineNo);
        }
        const { positional, named } = this.parseArgs(m[1]);
        this.rejectUnknownParams(
          Object.keys(named),
          ['source', 'seq', 'track', 'time', 'at', 'loop', 'repeat', 'times',
            'gain', 'pan', 'stagger'],
          'mix track()', lineNo
        );

        const source = this.unquote(named.source ?? named.seq ?? named.track ?? positional[0] ?? '');
        if (!source) {
          throw new SPGError(
            `mix: track 缺少 source 参数。已定义的音序：`
            + `${Array.from(sequences.keys()).join(' / ')}`, lineNo
          );
        }
        if (!sequences.has(source)) {
          throw new SPGError(
            `mix: 引用了未定义的音序 "${source}"。`
            + `已定义的音序：${Array.from(sequences.keys()).join(' / ')}`, lineNo
          );
        }

        const timeRaw = this.unquote(
          named.time ?? named.at ?? (positional[1] !== undefined ? positional[1] : '0')
        );
        const loop = named.loop !== undefined || named.repeat !== undefined || named.times !== undefined
          ? Math.max(0, Math.round(this.num(named, ['loop', 'repeat', 'times'], 1, 'mix track', lineNo)))
          : 1;

        /** 时值解析失败时补上 mix 上下文，而不是裸的"无法解析的时值" */
        const dur = (raw: string): number => {
          try {
            return parseDuration(raw, tempo);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new SPGError(`mix track: ${msg}`, lineNo);
          }
        };

        mix.push({
          source,
          time: dur(timeRaw),
          loop,
          gain: named.gain !== undefined ? this.num(named, ['gain'], 1, 'mix track', lineNo) : 1,
          pan: named.pan !== undefined
            ? Math.max(-1, Math.min(1, this.num(named, ['pan'], 0, 'mix track', lineNo)))
            : 0,
          stagger: named.stagger !== undefined ? dur(this.unquote(named.stagger)) : 0,
        });
      });
    }

    /* ---- 6. 兜底与校验 ---- */
    if (sequences.size === 0) {
      throw new SPGError('没有任何 sequence 块，无法生成音频', 1);
    }

    // 需要乐器但一个都没定义时，补一个默认正弦音色
    const needsInstrument = Array.from(sequences.values()).some((s) =>
      s.commands.some((c) => c.type !== 'hit')
    );
    if (instruments.size === 0 && needsInstrument) {
      instruments.set('default', {
        name: 'default',
        wave: 'sine',
        envelope: { ...DEFAULT_ENVELOPE },
        gain: 0.5,
      });
    }

    // 写了 mix 却漏掉某些音序，是"代码没错但没声音"最常见的原因，必须提示出来
    if (mix.length > 0) {
      const used = new Set(mix.map((t) => t.source));
      const orphans = Array.from(sequences.keys()).filter((n) => !used.has(n));
      if (orphans.length > 0) {
        this.warn(`以下音序没有被 mix 引用，不会发声：${orphans.join(' / ')}`, 1);
      }
    }

    return {
      instruments, sequences, effects, mix, tempo, masterVolumeConfig,
      key, scale, swing, warnings: this.warnings,
    };
  }
}

/* ==================== 事件调度器 ==================== */

/** 字符串 → 32 位种子，用于确定性 humanize */
function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 一个事件从起音到彻底静音所需的时长。
 *
 * 这是"尾音有多长"的**唯一定义**：调度器用它累加总时长（决定离线导出的长度），
 * 合成器用它决定效果链内 LFO 何时停止。两处各写一份的后果是它们会漂移 ——
 * 合成器的实际停止时刻是 `delay + duration + release + 0.1`，
 * 谁忘了 `delay` 这一项，谁的估算就偏短（包络 delay 可达数秒）。
 *
 * 鼓组以 `decay` 为准（可被 hit 的时值或 decay 参数截断），振荡器以包络为准。
 */
function eventTail(event: ScheduledEvent): number {
  if (event.drum) {
    const spec = DRUM_SPECS[event.drum];
    const natural = spec ? spec.decay : 0.3;
    const scaled = natural * (event.drumDecay ?? 1);
    const gated = event.duration > 0 ? Math.min(scaled, Math.max(event.duration, 0.01)) : scaled;
    return gated + 0.15;
  }
  return (event.envelope?.delay ?? 0) + event.duration + (event.envelope?.release ?? 0.2) + 0.1;
}

/**
 * 把音序里的乐理记法全部换算成绝对秒数，产出一张"合成器照着铺节点"的事件表。
 * 合成器因此不做任何乐理计算，只负责发声。
 */
export class EventScheduler {
  public schedule(
    sequences: Map<string, SequenceDef>,
    instruments: Map<string, InstrumentDef>,
    mixTracks: MixTrack[],
    tempo: number,
    swing = 0
  ): { events: ScheduledEvent[], totalDuration: number } {

    const scheduledEvents: ScheduledEvent[] = [];
    let maxTime = 0;
    const swingAmount = clamp(swing, 0, 1, 0);

    /**
     * 摇摆：把"后半拍"往后推到三连音该在的位置。
     *
     * 爵士/放克/Lo-fi 的律动感几乎全部来自这里 —— 用均匀的时值网格演奏切分节奏，
     * 听感必然是"机器在打拍子"。规则统一为「把后半拍挪到最近的八分三连音位置上」，
     * 分两层，**两层都必须处理**：
     *  - 十六分网格里落在奇数步的（第 2、4 个十六分）→ 推到 1/3 拍
     *  - 落在 `step % 4 === 2` 的（第 2 个八分，即"后半拍"）→ 推到 2/3 拍
     *
     * 只处理奇数步的话，`8n` 写法的音符落在 step 0/2/4/6 全是偶数，一个都不会被推动 ——
     * 而 `8n` 恰恰是爵士鼓组（ride 的 ding-ding-a-ding）和 Lo-fi 最常用的写法，
     * 结果是设了 swing 却完全听不出变化。偏移量 2/3 grid < grid，不会越过下一个音。
     */
    const swingOffset = (time: number): number => {
      if (swingAmount <= 0) return time;
      const grid = 60 / tempo / 4; // 十六分音符
      const step = Math.round(time / grid);
      let shift = 0;
      if (step % 2 === 1) shift = grid * (1 / 3);       // 后半拍十六分 → 1/3 拍
      if (step % 4 === 2) shift = grid * (2 / 3);       // 后半拍八分   → 2/3 拍
      if (shift === 0) return time;
      return time + shift * swingAmount;
    };

    /** 调度单个音序，返回其净时长 */
    const scheduleSequence = (
      seqName: string,
      startTime: number,
      trackGain: number,
      trackPan: number,
      /**
       * 随机流盐：种子若只含 (音序名, 起始时刻)，mix 里同一音序同一时刻出现两次
       * （如齐奏叠加）时两遍的 humanize 抖动逐采样相同 —— 双轨叠加等于单轨加 6dB。
       * 调用方传入 track/loop 下标即可错开随机流。
       */
      salt = ''
    ): number => {
      const seq = sequences.get(seqName);
      if (!seq) {
        throw new Error(`引用了未定义的音序 "${seqName}"`);
      }

      const inst = instruments.get(seq.instrumentName) ?? instruments.get('default');
      const rand = createRandom(hashSeed(`${seqName}:${startTime.toFixed(6)}:${salt}`));

      const seqGain = seq.gain ?? 1;
      const seqTranspose = seq.transpose ?? 0;
      const seqHumanize = seq.humanize ?? 0;

      let currentTime = startTime;

      /** 把音名解析为频率，叠加各级移调 */
      const freqOf = (pitch: string, expr: NoteExpression): number => {
        const midi = getMidi(pitch) + seqTranspose + (expr.transpose ?? 0);
        return midiToFreq(midi);
      };

      /** 把逐音符表达 + 轨道参数合并进一个事件 */
      const pushEvent = (
        time: number,
        freq: number,
        duration: number,
        expr: NoteExpression,
        overrides?: Partial<ScheduledEvent>
      ) => {
        const isDrum = !!overrides?.drum;
        // 鼓组事件没有音高（freq=0 是合法的），不能用音高条件把它滤掉
        if (!isDrum && (!Number.isFinite(freq) || freq <= 0)) return;
        if (!Number.isFinite(time) || !Number.isFinite(duration) || duration < 0) return;

        const human = clamp((expr.humanize ?? seqHumanize), 0, 1, 0);
        // 人性化抖动：音高 ±12 音分、力度 ±12%、时值 ±2%（可复现）
        const jitterPitch = human > 0 ? (rand() * 2 - 1) * 12 * human : 0;
        const jitterGain = human > 0 ? 1 + (rand() * 2 - 1) * 0.12 * human : 1;
        const jitterTime = human > 0 ? (rand() * 2 - 1) * 0.012 * human : 0;

        const velocity = clamp(expr.velocity ?? 0.8, 0, 1, 0.8);
        const sens = inst?.velocitySensitivity ?? 0.7;
        const velScale = clamp((1 - sens) + sens * (velocity / 0.8), 0, 1.6, 1);

        /**
         * 增益基线的选择。
         *
         * 鼓组事件绝不能沿用"当前乐器"的增益：鼓组音色自带 `DRUM_SPECS.gain` 标定
         * （kick 1.0、hat 0.45、shaker 0.4…），而 `instruments.get('default')` 的增益是 0.5。
         * 套用乐器增益会把**整条鼓组压掉一半**，且压缩程度取决于文件里恰好定义了哪些乐器 ——
         * 加一个 `gain: 0.2` 的铺底音色会让底鼓一起变轻，用户完全无从理解。
         */
        const baseGain = isDrum
          ? (expr.gain ?? 1)
          : (expr.gain ?? inst?.gain ?? 0.8);
        const gain = clamp(
          baseGain * velScale * seqGain * trackGain * jitterGain,
          0, 2, 0.8
        );

        // 力度影响音色亮度：强奏更亮，是管弦乐"强弱=音色"的关键
        let filter: FilterDef | undefined = inst?.filter;
        const vtF = inst?.velocityToFilter ?? 0;
        if (filter && vtF !== 0) {
          filter = {
            ...filter,
            frequency: clamp(
              filter.frequency + (velocity - 0.8) * vtF,
              20, 20000, filter.frequency
            ),
          };
        }

        const finalTime = Math.max(0, swingOffset(time) + jitterTime);
        const detune = (expr.detune ?? inst?.detune ?? 0) + jitterPitch;

        // 起音噪声不应在鼓组上叠加：鼓组本身已有独立的噪声层
        const attackNoise = isDrum ? 0 : (inst?.attackNoise ?? 0);

        /**
         * 声像基线与增益同源。
         *
         * 鼓组音色不属于任何乐器，套用"当前乐器"的 pan 会让整条鼓组跟着跑：
         * 定义一个 `pan=-0.5` 的弦乐铺底，底鼓就一起偏到左边 —— 用户完全无从理解。
         * 鼓组只认逐音符的 pan（以及 mix 轨道的 pan），与 gain 的处理保持一致。
         */
        const basePan = isDrum ? (expr.pan ?? 0) : (expr.pan ?? inst?.pan ?? 0);

        const event: ScheduledEvent = {
          time: finalTime,
          freq,
          duration,
          wave: inst?.wave ?? 'sine',
          envelope: inst?.envelope ?? { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2 },
          filter,
          filterEnvelope: inst?.filterEnvelope,
          filterEnvAmount: inst?.filterEnvAmount,
          lfo: inst?.lfo,
          pan: clamp(basePan + trackPan, -1, 1, 0),
          gain,
          fm_wave: inst?.fm_wave,
          fm_index: inst?.fm_index,
          fm_ratio: inst?.fm_ratio,
          detune,

          glide: expr.glide ?? inst?.glide ?? 0,
          glideFrom: inst?.glideFrom ?? -12,
          pitchEnvAmount: inst?.pitchEnvAmount ?? 0,
          pitchDecay: inst?.pitchDecay ?? 0.05,
          spread: inst?.spread ?? 0,
          velocity,
          velocityToFilter: vtF,
          voices: inst?.voices ?? 1,
          unisonSpread: inst?.unisonSpread ?? 12,
          harmonics: inst?.harmonics,
          attackNoise,
          effects: inst?.effects,
          loopPoint: inst?.loopPoint ?? 0,
          ...overrides,
        };
        scheduledEvents.push(event);

        // 尾音长度与合成器的实际发声长度同源（见 eventTail 说明）
        const end = finalTime + eventTail(event);
        if (end > maxTime) maxTime = end;
      };

      seq.commands.forEach((cmd) => {
        switch (cmd.type) {
          case 'note': {
            const gate = clamp(cmd.gate ?? 1, 0, 4, 1);
            const dur = parseDuration(cmd.duration, tempo);
            pushEvent(currentTime, freqOf(cmd.pitch, cmd), dur * gate, cmd);
            currentTime += dur;
            break;
          }

          case 'chord': {
            const c = cmd as ChordCommand;
            const gate = clamp(c.gate ?? 1, 0, 4, 1);
            const dur = parseDuration(c.duration, tempo);
            // strum>0 时各声部依次错开进入，模拟竖琴/吉他的滚奏
            const strum = clamp(c.strum ?? 0, 0, 1, 0);
            const perNote = strum * 0.055;
            c.pitches.forEach((pitch, i) => {
              pushEvent(currentTime + i * perNote, freqOf(pitch, c), dur * gate, c);
            });
            currentTime += dur;
            break;
          }

          case 'arp': {
            const a = cmd as ArpCommand;
            const totalDur = parseDuration(a.duration, tempo);
            const stepDur = parseDuration(a.rate, tempo);
            if (!(stepDur > 0) || !(totalDur > 0)) {
              throw new Error(`arp 的 rate/duration 必须为正时值`);
            }

            // 跨八度扩展音域
            const octaves = clamp(a.octaves ?? 1, 1, 4, 1);

            /**
             * `up` / `down` 是**音高**顺序，不是书写顺序。
             * 直接按下标升/降序会让 `["C3","G3","Eb3","Bb3"]` 的 up 出来是
             * 131 196 156 233 —— 听感上根本不是上行琶音，且与 `asPlayed` 完全等价，
             * 等于 pattern 参数失效。这里按实际音高排序，asPlayed 才保留书写顺序。
             */
            const pool = (a.pattern === 'asPlayed' || a.pattern === 'random')
              ? this.octaveSpread(a.pitches, octaves)
              : this.octaveSpread([...a.pitches].sort((x, y) => getMidi(x) - getMidi(y)), octaves);

            const order = this.arpOrder(pool.length, a.pattern);
            const steps = Math.max(1, Math.floor(totalDur / stepDur));
            const gate = clamp(a.gate ?? 0.9, 0, 4, 0.9);

            for (let i = 0; i < steps; i++) {
              const idx = a.pattern === 'random'
                ? Math.floor(rand() * pool.length)
                : order[i % order.length];
              const pitch = pool[idx % pool.length];
              if (!pitch) continue;
              pushEvent(currentTime + i * stepDur, freqOf(pitch, a), stepDur * gate, a);
            }
            currentTime += totalDur;
            break;
          }

          case 'hit': {
            const gate = clamp(cmd.gate ?? 1, 0, 4, 1);
            const dur = parseDuration(cmd.duration, tempo);
            pushEvent(
              currentTime,
              0,
              dur * gate,
              cmd,
              {
                drum: cmd.drum, wave: 'sine', effects: undefined,
                // 鼓组不走滤波/LFO 链路，这些参数会污染音色
                filter: undefined,
                filterEnvelope: undefined,
                filterEnvAmount: undefined,
                lfo: undefined,
                drumTune: cmd.drumTune,
                drumDecay: cmd.drumDecay,
                drumTone: cmd.drumTone,
                drumSnap: cmd.drumSnap,
              }
            );
            currentTime += dur;
            break;
          }

          case 'progression': {
            const p = cmd as ProgressionCommand;
            const octaves = clamp(p.octaves ?? 1, 1, 4, 1);
            const gate = clamp(p.gate ?? 1, 0, 4, 1);
            const strum = clamp(p.strum ?? 0, 0, 1, 0);
            const perNote = strum * 0.055;

            p.chords.forEach((chord, ci) => {
              const beat = p.beats[ci] ?? p.beats[p.beats.length - 1] ?? '1n';
              const dur = parseDuration(beat, tempo);

              // 跨八度复制，音域更宽
              const pool = this.octaveSpread(chord, octaves);

              /**
               * 和弦符号写出来的和弦默认是"齐奏"，`pattern` 一旦不是 asPlayed
               * 就按琶音方式把和弦音依次奏出 —— 这让
               * `progression(..., pattern="up")` 直接得到分解和弦伴奏，不必再手写一长串 note。
               */
              if (p.pattern === 'asPlayed') {
                pool.forEach((pitch, i) => {
                  pushEvent(currentTime + i * perNote, freqOf(pitch, p), dur * gate, p);
                });
              } else {
                const sorted = p.pattern === 'random'
                  ? pool
                  : [...pool].sort((x, y) => getMidi(x) - getMidi(y));
                const order = this.arpOrder(sorted.length, p.pattern);
                const stepDur = dur / Math.max(1, order.length);
                for (let i = 0; i < order.length; i++) {
                  const idx = p.pattern === 'random'
                    ? Math.floor(rand() * sorted.length)
                    : order[i];
                  const pitch = sorted[idx % sorted.length];
                  if (!pitch) continue;
                  pushEvent(currentTime + i * stepDur, freqOf(pitch, p), stepDur * gate, p);
                }
              }
              currentTime += dur;
            });
            break;
          }

          case 'run': {
            const r = cmd as RunCommand;
            const stepDur = parseDuration(r.rate, tempo);
            if (!(stepDur > 0)) throw new Error(`run 的 rate 必须为正时值`);
            const gate = clamp(r.gate ?? 1, 0, 4, 1);
            const repeat = Math.max(1, r.repeat ?? 1);

            let sequence = [...r.pitches];
            if (r.direction === 'down') sequence.reverse();
            else if (r.direction === 'updown' && sequence.length > 2) {
              sequence = sequence.concat(sequence.slice(1, -1).reverse());
            }

            for (let rep = 0; rep < repeat; rep++) {
              sequence.forEach((pitch, i) => {
                pushEvent(
                  currentTime + (rep * sequence.length + i) * stepDur,
                  freqOf(pitch, r),
                  stepDur * gate,
                  r
                );
              });
            }
            currentTime += sequence.length * stepDur * repeat;
            break;
          }

          case 'rest': {
            currentTime += parseDuration(cmd.duration, tempo);
            break;
          }

          default:
            break;
        }
      });

      return currentTime - startTime;
    };

    /* ---- 主循环 ---- */
    if (mixTracks.length > 0) {
      mixTracks.forEach((track, trackIndex) => {
        if (!sequences.has(track.source)) {
          throw new Error(`mix 引用了未定义的音序 "${track.source}"`);
        }
        const loopCount = Math.max(0, track.loop ?? 1);
        const stagger = track.stagger ?? 0;
        let currentStart = track.time ?? 0;
        for (let i = 0; i < loopCount; i++) {
          const duration = scheduleSequence(
            track.source,
            currentStart,
            track.gain ?? 1,
            track.pan ?? 0,
            `${trackIndex}:${i}`
          );
          // stagger 让每次循环错位叠加，可做卡农
          currentStart += duration + stagger;
        }
      });
    } else {
      // 未写 mix 时按定义顺序首尾相接，而不是全部从 0 叠加
      let cursor = 0;
      let seqIndex = 0;
      sequences.forEach((seq) => {
        cursor += scheduleSequence(seq.name, cursor, 1, 0, `solo:${seqIndex++}`);
      });
    }

    return { events: scheduledEvents, totalDuration: maxTime };
  }

  /** 生成琶音索引序列 */
  private arpOrder(len: number, pattern: ArpPattern): number[] {
    const idx = Array.from({ length: len }, (_, i) => i);
    switch (pattern) {
      case 'down':
        return idx.slice().reverse();
      case 'upDown': {
        // 首尾不重复，避免两音和弦退化成单音重复
        if (len <= 2) return idx;
        return idx.concat(idx.slice(1, -1).reverse());
      }
      case 'downUp': {
        const down = idx.slice().reverse();
        if (len <= 2) return down;
        return down.concat(down.slice(1, -1).reverse());
      }
      case 'asPlayed':
      case 'up':
      default:
        return idx;
    }
  }

  /** 音名移调（半音数），用于 arp / progression 跨八度 */
  private transposeName(pitch: string, semitones: number): string {
    const midi = getMidi(pitch) + semitones;
    const octave = Math.floor(midi / 12) - 1;
    return `${SHARP_NAMES[((midi % 12) + 12) % 12]}${octave}`;
  }

  /** 把一组音名按八度层叠展开：`octaves=2` 时额外复制一份高八度，音域更宽 */
  private octaveSpread(pitches: string[], octaves: number): string[] {
    const out: string[] = [];
    for (let o = 0; o < octaves; o++) {
      for (const p of pitches) {
        out.push(o === 0 ? p : this.transposeName(p, o * 12));
      }
    }
    return out;
  }
}

/* ==================== 音频合成器 ==================== */

/** 指数自动化不能到 0，用极小值代替 */
const ZERO = 0.0001;
/** 频率上限按奈奎斯特留出余量 */
const NYQUIST_MARGIN = 0.45;
/** 噪声颜色的固定种子：同一份代码每次渲染必须得到相同纹理，导出才能与试听一致 */
const NOISE_SEEDS: Record<string, number> = { white: 0x5eed, pink: 0x5eed + 977, brown: 0x5eed + 977 * 2 };

/**
 * 把调度好的事件表铺成 Web Audio 节点图。
 *
 * 每个音符的链路：声部振荡器 → 声部增益/声部声像 → 汇总 → 滤波 → 声像 → 振幅包络 → 总线。
 * 包络做在汇总之后，避免声部间的相位差被逐声部包络扭曲。
 */
export class AudioSynthesizer {
  private noiseBuffers = new Map<string, AudioBuffer>();

  /* ---- 噪声样本 ---- */

  /**
   * 按需生成噪声缓冲。
   * 缓存键必须带采样率：离线渲染（44100）与实时上下文（常为 48000）混用时，
   * 按颜色缓存会让同一次导出拿到另一种采样率的缓冲，噪声纹理与试听对不上。
   */
  private noiseBufferFor(ctx: BaseAudioContext, wave: string): AudioBuffer {
    const color = wave.startsWith('brown') ? 'brown' : wave.startsWith('pink') ? 'pink' : 'white';
    const key = `${color}@${ctx.sampleRate}`;
    const cached = this.noiseBuffers.get(key);
    if (cached) return cached;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    fillNoise(buffer.getChannelData(0), color, createRandom(NOISE_SEEDS[color]));
    this.noiseBuffers.set(key, buffer);
    return buffer;
  }

  /* ---- 包络自动化 ---- */

  /**
   * 在 AudioParam 上写入 ADSR 自动化，返回包络结束时刻。
   *
   * 音符时值短于 attack+decay 时按比例压缩 A/D，保证所有时间点严格单调递增 ——
   * 时间点倒流时浏览器对自动化事件的处理是未定义的，包络行为会变得不可预测。
   *
   * `loopPointOverride > 0` 时进入"重复起音"模式：每隔 loopPoint 秒重新起音一次，
   * 模拟弦乐的换弓、管乐的气息脉冲，让长音有呼吸而不是一条死平的直线。
   */
  private applyAdsr(
    param: AudioParam,
    startTime: number,
    duration: number,
    env: Envelope,
    peak: number,
    floor: number,
    loopPointOverride = 0
  ): number {
    const delay = Math.max(0, env.delay ?? 0);
    const t0 = startTime + delay;

    let a = Math.max(0, env.attack);
    let d = Math.max(0, env.decay);
    const noteDur = Math.max(0, duration);
    const loopPoint = Math.max(0, loopPointOverride);

    if (a + d > noteDur && a + d > 0) {
      const scale = noteDur / (a + d);
      a *= scale;
      d *= scale;
    }

    const sustainLevel = clamp(floor + (peak - floor) * clamp(env.sustain, 0, 1, 0), ZERO, 4, ZERO);
    const curve = env.curve ?? 'exp';
    const ramp = (target: number, at: number) => {
      const safeTarget = Math.max(ZERO, target);
      if (curve === 'linear') param.linearRampToValueAtTime(safeTarget, at);
      else if (curve === 'hold') param.setValueAtTime(safeTarget, at);
      else param.exponentialRampToValueAtTime(safeTarget, at);
    };

    param.setValueAtTime(Math.max(ZERO, floor), startTime);
    if (delay > 0) param.setValueAtTime(Math.max(ZERO, floor), t0);

    // 重复起音：把整段时值切成若干段，每段重新走一次 A→D→S
    if (loopPoint > 0 && noteDur > loopPoint * 1.5) {
      const segments = Math.floor(noteDur / loopPoint);
      const segDur = noteDur / segments;
      // 段内压缩 A/D，保证不越过段尾
      const sa = Math.min(a, segDur * 0.4);
      const sd = Math.min(d, segDur * 0.4);

      for (let s = 0; s < segments; s++) {
        const segStart = t0 + s * segDur;
        const segAttackEnd = segStart + sa;
        const segDecayEnd = segAttackEnd + sd;
        // 最后一段之后直接进 release，由下方统一处理
        if (segDecayEnd >= t0 + noteDur) break;

        if (sa <= 0.0005) {
          param.setValueAtTime(Math.max(ZERO, peak), segAttackEnd);
        } else {
          ramp(peak, segAttackEnd);
        }
        if (sd > 0.0005) ramp(sustainLevel, segDecayEnd);
        else param.setValueAtTime(sustainLevel, segDecayEnd);
      }

      const releaseStart = t0 + noteDur;
      const releaseEnd = releaseStart + Math.max(0, env.release);
      param.setValueAtTime(sustainLevel, releaseStart);
      if (env.release > 0.0005) param.exponentialRampToValueAtTime(ZERO, releaseEnd);
      param.setValueAtTime(0, releaseEnd + 0.005);
      return releaseEnd + 0.005;
    }

    const attackEnd = t0 + a;
    const decayEnd = attackEnd + d;
    const releaseStart = Math.max(decayEnd, t0 + noteDur);
    const releaseEnd = releaseStart + Math.max(0, env.release);

    if (a <= 0.0005) {
      param.setValueAtTime(Math.max(ZERO, peak), Math.max(attackEnd, startTime));
    } else {
      ramp(peak, attackEnd);
    }
    if (d > 0.0005) ramp(sustainLevel, decayEnd);
    else param.setValueAtTime(sustainLevel, decayEnd);

    param.setValueAtTime(sustainLevel, releaseStart);
    if (env.release > 0.0005) {
      param.exponentialRampToValueAtTime(ZERO, releaseEnd);
    }
    // 归零，避免释放后残留直流
    param.setValueAtTime(0, releaseEnd + 0.005);

    return releaseEnd + 0.005;
  }

  /** 生成自定义周期波（谐波叠加） */
  private makePeriodicWave(ctx: BaseAudioContext, harmonics: number[]): PeriodicWave | null {
    try {
      const real = new Float32Array(harmonics.length + 1);
      const imag = new Float32Array(harmonics.length + 1);
      harmonics.forEach((amp, i) => { imag[i + 1] = amp; });
      return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    } catch {
      return null;
    }
  }

  /* ---- 效果链 ---- */

  private makeDistortionCurve(amount: number, samples = 2048): Float32Array<ArrayBuffer> {
    const curve = new Float32Array(samples);
    const k = Math.max(0.001, amount);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((3 + k) * x * 20 * Math.PI / 180) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  /** 位深量化曲线 */
  private makeBitcrushCurve(bits: number, samples = 8192): Float32Array<ArrayBuffer> {
    const curve = new Float32Array(samples);
    const levels = Math.pow(2, Math.max(1, Math.min(16, bits))) / 2;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = Math.round(x * levels) / levels;
    }
    return curve;
  }

  /** 生成混响脉冲响应 */
  private makeImpulse(ctx: BaseAudioContext, decay: number, damping: number): AudioBuffer {
    const rate = ctx.sampleRate;
    // decay 直接决定这次分配的大小，必须先夹住：`reverb(decay=600)` 这类写法
    // 会申请 2 通道 × 44100×600 帧的缓冲（约 420MB）并在生成循环里跑上千万次，
    // 表现就是导出/试听彻底卡死且没有任何报错。上限与 compile() 计算尾音时
    // 用的是同一个常量，保证"留多长的尾"和"造多长的脉冲"不会各说各话。
    const seconds = clamp(decay, 0.05, MAX_REVERB_DECAY, 2.0);
    const length = Math.max(1, Math.floor(rate * seconds));
    const impulse = ctx.createBuffer(2, length, rate);
    const rand = createRandom(0x1e5 + Math.floor(seconds * 1000));
    // 阻尼越高，脉冲高频衰减越快
    const lpCoef = clamp(damping / (ctx.sampleRate / 2), 0.02, 1, 0.3);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.pow(1 - t, 2.2);
        const white = rand() * 2 - 1;
        last = last + lpCoef * (white - last);
        data[i] = last * env;
      }
    }
    return impulse;
  }

  /**
   * 把一串效果器串成链：inputNode -> ... -> outputNode。
   * 覆盖时间类、失真类、调制类与动态类效果。
   *
   * `registerSource` 与 `stopAt` 用于接管调制类效果内部的 LFO：
   * 它们必须被登记并在曲末停止，否则会永久占用振荡器。
   *
   * `timeOffset` 是实时播放时的调度偏移：playRealtime 把所有事件整体后移
   * （now + 缓冲），而 filter 效果的扫频自动化写的是"乐曲内时刻"。
   * 不加偏移，扫频会落在上下文时间 0~duration（即过去）而完全听不见 ——
   * 试听与导出的行为从此分叉。离线渲染传 0。
   */
  public buildEffectChain(
    ctx: BaseAudioContext,
    inputNode: AudioNode,
    outputNode: AudioNode,
    effects: EffectDef[],
    registerSource?: (node: AudioScheduledSourceNode) => void,
    stopAt?: number,
    timeOffset = 0
  ): void {
    let currentNode = inputNode;

    /** 启动效果器内部 LFO 并纳入生命周期管理 */
    const startChainLfo = (lfo: OscillatorNode) => {
      lfo.start(0);
      if (stopAt !== undefined && Number.isFinite(stopAt) && stopAt > 0) {
        lfo.stop(stopAt);
      }
      if (registerSource) registerSource(lfo);
    };

    const mergeWetDry = (dry: GainNode, wet: GainNode) => {
      const merge = ctx.createGain();
      dry.connect(merge);
      wet.connect(merge);
      return merge;
    };

    effects.forEach((effect) => {
      switch (effect.type) {
        case 'delay': {
          const time = clamp(effect.time, 0.001, 10, 0.3);
          const feedback = clamp(effect.feedback, 0, 0.95, 0.3);
          const mix = clamp(effect.mix, 0, 1, 0.4);

          const dryGain = ctx.createGain();
          dryGain.gain.value = 1 - mix;
          const wetGain = ctx.createGain();
          wetGain.gain.value = mix;

          const damping = ctx.createBiquadFilter();
          damping.type = 'lowpass';
          damping.frequency.value = clamp(effect.damping ?? 2000, 100, 20000, 2000);
          damping.Q.value = 0.5;

          const fb = ctx.createGain();
          fb.gain.value = feedback;

          currentNode.connect(dryGain);

          if (effect.pingPong) {
            // 乒乓：左右两路交替反馈，延迟时间略微错开形成交替弹跳
            const splitter = ctx.createChannelSplitter(2);
            const left = ctx.createDelay(10);
            const right = ctx.createDelay(10);
            const panL = ctx.createStereoPanner();
            const panR = ctx.createStereoPanner();
            panL.pan.value = -1;
            panR.pan.value = 1;
            left.delayTime.value = time;
            right.delayTime.value = time * 1.5;

            currentNode.connect(splitter);
            splitter.connect(left, 0);
            splitter.connect(right, 1);
            left.connect(panR);
            right.connect(panL);
            panR.connect(damping);
            panL.connect(damping);
            damping.connect(fb);
            fb.connect(left);
            fb.connect(right);
            damping.connect(wetGain);
          } else {
            const delayNode = ctx.createDelay(10);
            delayNode.delayTime.value = time;
            currentNode.connect(delayNode);
            delayNode.connect(damping);
            damping.connect(fb);
            fb.connect(delayNode);
            damping.connect(wetGain);
          }

          currentNode = mergeWetDry(dryGain, wetGain);
          break;
        }

        case 'reverb': {
          const mix = clamp(effect.mix, 0, 1, 0.3);
          const dry = ctx.createGain();
          dry.gain.value = 1 - mix;
          const wet = ctx.createGain();
          wet.gain.value = mix;

          const pre = ctx.createDelay(1);
          pre.delayTime.value = clamp(effect.preDelay ?? 0.01, 0, 0.5, 0.01);

          const damp = ctx.createBiquadFilter();
          damp.type = 'lowpass';
          damp.frequency.value = clamp(effect.damping ?? 5000, 200, 20000, 5000);

          const convolver = ctx.createConvolver();
          convolver.buffer = this.makeImpulse(ctx, effect.decay, effect.damping ?? 5000);

          currentNode.connect(dry);
          currentNode.connect(pre);
          pre.connect(damp);
          damp.connect(convolver);
          convolver.connect(wet);

          currentNode = mergeWetDry(dry, wet);
          break;
        }

        case 'distortion': {
          const mix = clamp(effect.mix ?? 1, 0, 1, 1);
          const amount = clamp(effect.amount, 0, 1, 0.5);
          const shaper = ctx.createWaveShaper();
          shaper.curve = this.makeDistortionCurve(amount * 100);
          shaper.oversample = '4x';

          if (mix >= 1) {
            // 全湿时补偿失真带来的电平抬升
            const comp = ctx.createGain();
            comp.gain.value = 1 / (1 + amount * 1.5);
            currentNode.connect(shaper);
            shaper.connect(comp);
            currentNode = comp;
          } else {
            const dry = ctx.createGain();
            dry.gain.value = 1 - mix;
            const wet = ctx.createGain();
            wet.gain.value = mix / (1 + amount);
            currentNode.connect(dry);
            currentNode.connect(shaper);
            shaper.connect(wet);
            currentNode = mergeWetDry(dry, wet);
          }
          break;
        }

        case 'bitcrush': {
          const mix = clamp(effect.mix, 0, 1, 1);
          const shaper = ctx.createWaveShaper();
          shaper.curve = this.makeBitcrushCurve(effect.bits);
          shaper.oversample = 'none';

          if (mix >= 1) {
            currentNode.connect(shaper);
            currentNode = shaper;
          } else {
            const dry = ctx.createGain();
            dry.gain.value = 1 - mix;
            const wet = ctx.createGain();
            wet.gain.value = mix;
            currentNode.connect(dry);
            currentNode.connect(shaper);
            shaper.connect(wet);
            currentNode = mergeWetDry(dry, wet);
          }
          break;
        }

        case 'chorus':
        case 'flanger': {
          const isFlanger = effect.type === 'flanger';
          const mix = clamp(effect.mix, 0, 1, 0.5);
          const rate = clamp(effect.rate, 0.01, 20, isFlanger ? 0.3 : 1.5);
          const depthMs = isFlanger ? 2.5 : clamp(effect.depth, 0.1, 20, 3.5);
          const feedback = isFlanger ? clamp(effect.feedback, 0, 0.9, 0.6) : 0;

          const dry = ctx.createGain();
          dry.gain.value = 1 - mix * 0.5; // 调制类保留较多干声
          const wet = ctx.createGain();
          wet.gain.value = mix;

          const delayNode = ctx.createDelay(0.1);
          delayNode.delayTime.value = (isFlanger ? 1 : 20) / 1000;

          const lfo = ctx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.value = rate;
          const lfoGain = ctx.createGain();
          lfoGain.gain.value = depthMs / 1000;
          lfo.connect(lfoGain);
          lfoGain.connect(delayNode.delayTime);

          currentNode.connect(dry);
          currentNode.connect(delayNode);
          delayNode.connect(wet);

          if (feedback > 0) {
            const fb = ctx.createGain();
            fb.gain.value = feedback;
            delayNode.connect(fb);
            fb.connect(delayNode);
          }

          startChainLfo(lfo);

          currentNode = mergeWetDry(dry, wet);
          break;
        }

        case 'phaser': {
          const mix = clamp(effect.mix, 0, 1, 0.6);
          const rate = clamp(effect.rate, 0.01, 20, 0.5);
          const minF = clamp(effect.min, 20, 20000, 300);
          const maxF = clamp(effect.max, minF + 10, 20000, 2000);

          const dry = ctx.createGain();
          dry.gain.value = 1 - mix * 0.5;
          const wet = ctx.createGain();
          wet.gain.value = mix;

          // 四级全通串联是相位器的经典结构
          const stages: BiquadFilterNode[] = [];
          for (let i = 0; i < 4; i++) {
            const ap = ctx.createBiquadFilter();
            ap.type = 'allpass';
            ap.Q.value = 0.7;
            stages.push(ap);
          }

          const lfo = ctx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.value = rate;
          const lfoGain = ctx.createGain();
          lfoGain.gain.value = (maxF - minF) / 2;
          lfo.connect(lfoGain);
          stages.forEach((s) => {
            s.frequency.value = (maxF + minF) / 2;
            lfoGain.connect(s.frequency);
          });
          startChainLfo(lfo);

          currentNode.connect(dry);
          currentNode.connect(stages[0]);
          for (let i = 0; i < stages.length - 1; i++) stages[i].connect(stages[i + 1]);
          stages[stages.length - 1].connect(wet);

          currentNode = mergeWetDry(dry, wet);
          break;
        }

        case 'tremolo': {
          const rate = clamp(effect.rate, 0.01, 40, 5);
          const depth = clamp(effect.depth, 0, 1, 0.6);
          const vca = ctx.createGain();
          vca.gain.value = 1 - depth / 2;

          const lfo = ctx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.value = rate;
          const lfoGain = ctx.createGain();
          lfoGain.gain.value = depth / 2;
          lfo.connect(lfoGain);
          lfoGain.connect(vca.gain);
          startChainLfo(lfo);

          currentNode.connect(vca);
          currentNode = vca;
          break;
        }

        case 'compressor': {
          const comp = ctx.createDynamicsCompressor();
          comp.threshold.value = clamp(effect.threshold, -100, 0, -20);
          comp.ratio.value = clamp(effect.ratio, 1, 20, 4);
          comp.attack.value = clamp(effect.attack, 0, 1, 0.01);
          comp.release.value = clamp(effect.release, 0, 1, 0.25);
          currentNode.connect(comp);
          currentNode = comp;
          break;
        }

        case 'filter': {
          const biquad = ctx.createBiquadFilter();
          biquad.type = effect.kind as BiquadFilterType;
          biquad.Q.value = clamp(effect.Q, 0, 30, 1);
          const from = clamp(effect.from, 20, 20000, 200);
          const to = clamp(effect.to, 20, 20000, 4000);
          // 自动化锚点必须跟事件走同样的偏移（见 timeOffset 说明）
          const start = Math.max(0, effect.start) + timeOffset;
          const end = start + Math.max(0.01, effect.duration);

          biquad.frequency.setValueAtTime(from, start);
          biquad.frequency.exponentialRampToValueAtTime(Math.max(ZERO, to), end);
          biquad.frequency.setValueAtTime(to, end);

          currentNode.connect(biquad);
          currentNode = biquad;
          break;
        }

        case 'eq': {
          const low = ctx.createBiquadFilter();
          low.type = 'lowshelf';
          low.frequency.value = 250;
          low.gain.value = clamp(effect.low, -24, 24, 0);

          const mid = ctx.createBiquadFilter();
          mid.type = 'peaking';
          mid.frequency.value = 1200;
          mid.Q.value = 0.9;
          mid.gain.value = clamp(effect.mid, -24, 24, 0);

          const high = ctx.createBiquadFilter();
          high.type = 'highshelf';
          high.frequency.value = 4000;
          high.gain.value = clamp(effect.high, -24, 24, 0);

          currentNode.connect(low);
          low.connect(mid);
          mid.connect(high);
          currentNode = high;
          break;
        }

        default:
          break;
      }
    });

    currentNode.connect(outputNode);
  }

  /* ---- 鼓组合成 ---- */

  private scheduleDrum(
    ctx: BaseAudioContext,
    destination: AudioNode,
    event: ScheduledEvent,
    registerSource: (node: AudioScheduledSourceNode) => void
  ): void {
    const baseSpec = DRUM_SPECS[event.drum as DrumName];
    if (!baseSpec) return;

    /**
     * 逐次击打微调：`tune` 改基频、`decay` 改衰减、`tone` 移滤波频率、`snap` 加瞬态。
     * 没有这些参数时整首歌里同一个 `hit("kick")` 每次听起来一模一样，
     * 而这正是"程序化鼓组"最容易被听出来的地方；有了它们，模型可以用
     * `tune=-2, decay=0.8` 把同一套鼓拆成"主歌的闷底鼓"与"副歌的亮底鼓"。
     */
    const tune = event.drumTune ?? 0;
    const decayScale = Math.max(0.05, event.drumDecay ?? 1);
    const toneShift = event.drumTone ?? 0;
    const snap = clamp(event.drumSnap ?? 0, 0, 1, 0);
    const tuneRatio = Math.pow(2, tune / 12);

    const spec: DrumSpec = {
      ...baseSpec,
      freq: clamp(baseSpec.freq * tuneRatio, 10, 20000, baseSpec.freq),
      noiseFreq: clamp(baseSpec.noiseFreq + toneShift, 20, 20000, baseSpec.noiseFreq),
      decay: baseSpec.decay * decayScale,
      pitchDecay: baseSpec.pitchDecay * decayScale,
    };

    const t = event.time;
    const velocity = clamp(event.velocity ?? 0.8, 0, 1, 0.8);
    const amp = clamp(spec.gain * (0.45 + velocity * 0.7), 0, 2, 0.8);
    // 时值短于音色自然衰减时按门限截断（例如闭镲掐断开镲）
    const decay = event.duration > 0
      ? Math.min(spec.decay, Math.max(event.duration, 0.01))
      : spec.decay;

    const out = ctx.createGain();
    out.gain.value = amp;

    /**
     * 鼓组不走逐音符链路（滤波器/包络/声像都在 scheduleEvents 里），
     * 所以 `pan` 必须在这里自己接——提示词明确建议"打击乐点缀 pan=±0.4"，
     * 不接的话这个参数被解析、被存进事件，然后无声无息地丢掉：
     * 用户按建议写了声像，听到的却永远在正中间。
     */
    const pan = clamp(event.pan ?? 0, -1, 1, 0);
    let tail: AudioNode = out;
    if (pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      out.connect(panner);
      tail = panner;
    }

    if (spec.highpass) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = clamp(spec.highpass + toneShift, 20, 20000, spec.highpass);
      hp.Q.value = 0.7;
      tail.connect(hp);
      hp.connect(destination);
    } else {
      tail.connect(destination);
    }

    const endTime = t + decay + 0.15;

    // 1. 音体（膜振动 / 金属分音）
    if (spec.model === 'membrane' || spec.model === 'metallic') {
      const ratios: number[] = spec.model === 'metallic' && spec.ratios ? spec.ratios : [1];
      ratios.forEach((ratio: number, i: number) => {
        const osc = ctx.createOscillator();
        osc.type = spec.model === 'metallic' ? 'square' : 'sine';
        const base = spec.freq * ratio;
        osc.frequency.setValueAtTime(
          Math.min(base * Math.pow(2, spec.pitchAmount / 12), 20000), t
        );
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(20, base), t + Math.max(0.005, spec.pitchDecay)
        );

        const g = ctx.createGain();
        const partialAmp = spec.model === 'metallic' ? 1 / (i + 2) : 1;
        // 金属分音衰减更快，模拟镲片能量耗散
        const partialDecay = spec.model === 'metallic' ? decay * (0.4 + 0.6 / (i + 1)) : decay;

        /**
         * 起音斜坡必须严格短于衰减终点。
         *
         * decay 会被 hit 的时值截断：`hit("kick","128n")` 这种极短时值下，
         * 写死 0.002 秒的起音会越过 `t + decay`，两个自动化事件时间倒流 ——
         * 浏览器在自动化乱序时的行为未定义，表现为音量忽大忽小甚至爆音。
         */
        const attackEnd = t + Math.min(0.002, Math.max(0.0002, decay * 0.1));
        g.gain.setValueAtTime(ZERO, t);
        g.gain.exponentialRampToValueAtTime(Math.max(ZERO, partialAmp), attackEnd);
        g.gain.exponentialRampToValueAtTime(ZERO, t + Math.max(0.02, partialDecay));
        g.gain.setValueAtTime(0, t + Math.max(0.02, partialDecay) + 0.005);

        osc.connect(g);
        g.connect(out);

        osc.start(t);
        osc.stop(endTime);
        registerSource(osc);
      });
    }

    // 2. 噪声层
    if (spec.noise > 0) {
      const buffer = this.noiseBufferFor(ctx, 'white');
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = spec.noiseFilter;
      filter.frequency.value = clamp(spec.noiseFreq, 20, 20000, 2000);
      filter.Q.value = spec.noiseQ;

      const g = ctx.createGain();
      const noiseAmp = spec.noise * (1 + snap * 0.8);
      const noiseAttack = Math.min(0.002, Math.max(0.0002, decay * 0.1));
      if (event.drum === 'clap') {
        /**
         * 拍手的多次爆发：用几个短促包络堆叠出"啪"的群感。
         *
         * 四次爆发的包络必须写成一条**严格递增**的时间线。先按固定毫秒排完爆发、
         * 再补一句收尾 `setValueAtTime` 会把时间点倒拨回爆发之前 ——
         * 浏览器对乱序自动化事件的行为未定义，实测表现为拍手音量忽大忽小；
         * 固定的毫秒间隔在极短时值（`hit("clap","128n")`）下还会整段越界。
         * 这里按可用衰减时长缩放爆发间隔，并在每次爆发后直接衔接下一次。
         */
        const burstSpan = Math.min(0.036, Math.max(0.008, decay * 0.6));
        const offsets = [0, 0.3, 0.62, 1].map((f) => f * burstSpan);
        const tailEnd = t + burstSpan + Math.max(0.01, decay);

        g.gain.setValueAtTime(ZERO, t);
        offsets.forEach((offset, i) => {
          const level = noiseAmp * (0.5 + i * 0.16);
          const isLast = i === offsets.length - 1;
          const nextAt = isLast ? tailEnd : t + offsets[i + 1] - 0.0005;
          g.gain.setValueAtTime(Math.max(ZERO, level * (isLast ? 1 : 0.4)), t + offset);
          g.gain.exponentialRampToValueAtTime(ZERO, nextAt);
        });
        g.gain.setValueAtTime(0, tailEnd + 0.005);
      } else {
        g.gain.setValueAtTime(ZERO, t);
        g.gain.exponentialRampToValueAtTime(Math.max(ZERO, noiseAmp), t + noiseAttack);
        g.gain.exponentialRampToValueAtTime(ZERO, t + Math.max(0.02, decay));
        g.gain.setValueAtTime(0, t + Math.max(0.02, decay) + 0.005);
      }

      src.connect(filter);
      filter.connect(g);
      g.connect(out);

      src.start(t);
      src.stop(endTime);
      registerSource(src);
    }

    // 3. 起音冲击层：极短的高频噪声，让瞬态"扎"出来
    if (snap > 0) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBufferFor(ctx, 'white');
      src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = clamp(spec.noiseFreq * 0.6 + toneShift, 200, 20000, 4000);
      const g = ctx.createGain();
      const burst = 0.012;
      g.gain.setValueAtTime(ZERO, t);
      g.gain.exponentialRampToValueAtTime(Math.max(ZERO, snap * 0.5), t + 0.0008);
      g.gain.exponentialRampToValueAtTime(ZERO, t + burst);
      g.gain.setValueAtTime(0, t + burst + 0.005);

      src.connect(hp);
      hp.connect(g);
      g.connect(out);
      src.start(t);
      src.stop(t + burst + 0.02);
      registerSource(src);
    }
  }

  /* ---- 主调度入口 ---- */

  public scheduleEvents(
    ctx: BaseAudioContext,
    destination: AudioNode,
    events: ScheduledEvent[],
    effects: EffectDef[],
    registerSource: (node: AudioScheduledSourceNode) => void,
    /** 实时播放时事件已被整体后移，效果器内的时间自动化要跟同样的偏移 */
    timeOffset = 0
  ): void {
    const masterBus = ctx.createGain();
    masterBus.gain.value = 1.0;

    // 效果链内部 LFO 的停止时刻：最后一个事件的尾音之后。
    // 用 eventTail 而不是 duration+release —— 鼓组按包络算是 0，LFO 会在镲片还响着时停摆。
    const chainStop = events.reduce((acc, e) => Math.max(acc, e.time + eventTail(e)), 1);

    if (effects.length > 0) {
      this.buildEffectChain(ctx, masterBus, destination, effects, registerSource, chainStop, timeOffset);
    } else {
      masterBus.connect(destination);
    }

    // 乐器级效果链按签名缓存总线，避免每个音符都重建卷积器。
    // 链内 LFO 的停止时刻取全局 chainStop，因此缓存必须限定在同一次调度内
    // （每次 scheduleEvents 都会新建 map，天然满足）。
    const busCache = new Map<string, AudioNode>();
    const busFor = (instEffects: EffectDef[]): AudioNode => {
      const key = JSON.stringify(instEffects);
      const cached = busCache.get(key);
      if (cached) return cached;
      const bus = ctx.createGain();
      this.buildEffectChain(ctx, bus, masterBus, instEffects, registerSource, chainStop, timeOffset);
      busCache.set(key, bus);
      return bus;
    };

    const periodicWaveCache = new Map<string, PeriodicWave | null>();

    events.forEach((event) => {
      if (event.drum) {
        // 鼓组走 masterBus，绕开逐音符的滤波器/声像/包络链路
        this.scheduleDrum(ctx, masterBus, event, registerSource);
        return;
      }

      const outBus = event.effects && event.effects.length > 0
        ? busFor(event.effects)
        : masterBus;

      const t = event.time;
      const env = event.envelope;
      const duration = Math.max(0, event.duration);
      const release = Math.max(0, env.release);
      const tailEnd = t + (env.delay ?? 0) + duration + release + 0.1;

      const isNoise = isNoiseWave(event.wave);
      const voiceCount = clamp(event.voices ?? 1, 1, 7, 1);

      /* 振幅总线：所有声部汇总后统一做包络，避免声部间相位差被包络扭曲 */
      const voiceMix = ctx.createGain();
      voiceMix.gain.value = 1;

      // 1. 滤波器（在声部汇总之后，整条音色共用一只滤波器）
      let filterNode: BiquadFilterNode | null = null;
      let postFilter: AudioNode = voiceMix;
      if (event.filter) {
        filterNode = ctx.createBiquadFilter();
        filterNode.type = event.filter.type;
        filterNode.Q.value = clamp(event.filter.Q, 0, 30, 1);
        filterNode.gain.value = clamp(event.filter.gain ?? 0, -40, 40, 0);

        const baseFreq = clamp(event.filter.frequency, 20, ctx.sampleRate * NYQUIST_MARGIN, 1000);
        filterNode.frequency.setValueAtTime(baseFreq, t);

        if (event.filter.sweepTo && event.filter.sweepTo > 0) {
          // 自动扫频
          const target = clamp(event.filter.sweepTo, 20, ctx.sampleRate * NYQUIST_MARGIN, 4000);
          filterNode.frequency.exponentialRampToValueAtTime(
            Math.max(ZERO, target), t + Math.max(0.01, duration)
          );
        } else if (event.filterEnvelope && event.filterEnvAmount) {
          const fe = event.filterEnvelope;
          const amt = event.filterEnvAmount;
          const nyq = ctx.sampleRate * NYQUIST_MARGIN;
          const peak = clamp(baseFreq + amt, 20, nyq, baseFreq);
          const sustainF = clamp(baseFreq + amt * clamp(fe.sustain, 0, 1, 0), 20, nyq, baseFreq);

          let a = Math.max(0, fe.attack);
          let d = Math.max(0, fe.decay);
          if (a + d > duration && a + d > 0) {
            const scale = duration / (a + d);
            a *= scale; d *= scale;
          }
          const aEnd = t + a;
          const dEnd = aEnd + d;
          const rStart = Math.max(dEnd, t + duration);
          const rEnd = rStart + Math.max(0, fe.release);

          // 零起音/零衰减时用跳变代替零时长 ramp：exponentialRamp 在起止同刻的
          // 行为各浏览器不一致，而 applyAdsr 对振幅包络就是这么处理的，两边保持一致。
          filterNode.frequency.setValueAtTime(baseFreq, t);
          if (a <= 0.0005) {
            filterNode.frequency.setValueAtTime(Math.max(ZERO, peak), aEnd);
          } else {
            filterNode.frequency.exponentialRampToValueAtTime(Math.max(ZERO, peak), aEnd);
          }
          if (d <= 0.0005) {
            filterNode.frequency.setValueAtTime(Math.max(ZERO, sustainF), dEnd);
          } else {
            filterNode.frequency.exponentialRampToValueAtTime(Math.max(ZERO, sustainF), dEnd);
          }
          filterNode.frequency.setValueAtTime(Math.max(ZERO, sustainF), rStart);
          filterNode.frequency.exponentialRampToValueAtTime(Math.max(ZERO, baseFreq), rEnd);
        }

        voiceMix.connect(filterNode);
        postFilter = filterNode;
      }

      // 2. 声像
      let pannerNode: StereoPannerNode | null = null;
      let postPan: AudioNode = postFilter;
      const basePan = clamp(event.pan ?? 0, -1, 1, 0);
      if (ctx.createStereoPanner) {
        pannerNode = ctx.createStereoPanner();
        pannerNode.pan.value = basePan;
        postFilter.connect(pannerNode);
        postPan = pannerNode;
      }

      // 3. 振幅包络
      const ampNode = ctx.createGain();
      const peakGain = clamp(event.gain, 0, 2, 0.8);
      this.applyAdsr(ampNode.gain, t, duration, env, peakGain, 0, event.loopPoint ?? 0);
      postPan.connect(ampNode);
      ampNode.connect(outBus);

      /* ---- 生成各声部 ---- */
      const spread = clamp(event.spread ?? 0, 0, 1, 0);
      const unison = clamp(event.unisonSpread ?? 12, 0, 100, 12);
      const detuneBase = event.detune ?? 0;
      // 声部数增加时按 1/sqrt(n) 补偿响度
      const voiceGain = voiceCount > 1 ? 1 / Math.sqrt(voiceCount) : 1;

      const startFreq = event.freq;
      const glide = Math.max(0, event.glide ?? 0);
      const glideFrom = event.glideFrom ?? -12;

      // 收集本事件的所有声部振荡器，供 LFO 统一调制
      const voiceOscillators: OscillatorNode[] = [];

      for (let v = 0; v < voiceCount; v++) {
        const pos = voiceCount === 1 ? 0 : (v / (voiceCount - 1)) * 2 - 1; // -1..1
        const detuneCents = detuneBase + pos * (unison / 2);

        const g = ctx.createGain();
        g.gain.value = voiceGain;

        // 每个声部独立声像，制造宽度
        if (pannerNode && spread > 0) {
          const vp = ctx.createStereoPanner();
          vp.pan.value = clamp(pos * spread, -1, 1, 0);
          g.connect(vp);
          vp.connect(voiceMix);
        } else {
          g.connect(voiceMix);
        }

        if (isNoise) {
          const src = ctx.createBufferSource();
          src.buffer = this.noiseBufferFor(ctx, event.wave);
          src.loop = true;
          // 噪声通过带通塑形才有音高感
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = clamp(startFreq, 20, ctx.sampleRate * NYQUIST_MARGIN, 1000);
          bp.Q.value = 1.2;
          src.connect(bp);
          bp.connect(g);
          src.start(t);
          src.stop(tailEnd);
          registerSource(src);
          continue;
        }

        const osc = ctx.createOscillator();

        // 自定义谐波优先于内置波形
        let usedCustom = false;
        if (event.harmonics && event.harmonics.length > 0) {
          const key = event.harmonics.join(',');
          let wave = periodicWaveCache.get(key);
          if (wave === undefined) {
            wave = this.makePeriodicWave(ctx, event.harmonics);
            periodicWaveCache.set(key, wave);
          }
          if (wave) {
            osc.setPeriodicWave(wave);
            usedCustom = true;
          }
        }
        if (!usedCustom) {
          osc.type = isOscillatorWave(event.wave) ? event.wave : 'sine';
        }

        // 音高：滑音 → 音高包络 → 失谐
        const freq = clamp(startFreq, 0.01, ctx.sampleRate * NYQUIST_MARGIN, 440);
        if (glide > 0) {
          const fromFreq = clamp(midiToFreq(
            Math.log2(freq / 440) * 12 + 69 + glideFrom
          ), 0.01, ctx.sampleRate * NYQUIST_MARGIN, freq * 0.5);
          osc.frequency.setValueAtTime(fromFreq, t);
          osc.frequency.exponentialRampToValueAtTime(freq, t + glide);
        } else {
          osc.frequency.setValueAtTime(freq, t);
        }

        if (event.pitchEnvAmount && event.pitchEnvAmount !== 0 && (event.pitchDecay ?? 0.05) >= 0) {
          const peakF = clamp(
            freq * Math.pow(2, event.pitchEnvAmount / 12),
            0.01, ctx.sampleRate * NYQUIST_MARGIN, freq
          );
          // 与滑音叠加时从滑音终点继续，避免时间点冲突
          const pStart = t + (glide > 0 ? glide : 0);
          osc.frequency.setValueAtTime(peakF, pStart);
          osc.frequency.exponentialRampToValueAtTime(
            freq, pStart + Math.max(0.005, event.pitchDecay ?? 0.05)
          );
        }

        osc.detune.value = clamp(detuneCents, -4800, 4800, 0);
        voiceOscillators.push(osc);

        /**
         * FM 调制。
         *
         * 判定条件是 **fm_wave 存在且 fm_index 非零**，不能写成 `event.fm_ratio &&` ——
         * fm_ratio 是个有默认值的数值，拿它当开关会让"只写了 fm_wave + fm_index"
         * 的乐器静默失去 FM（`0 &&` 与 `undefined &&` 都是 falsy），
         * 而解析器只在 fm_ratio<=0 时报错，恰好漏掉"根本没写"这一支。
         *
         * fm_index 为 0 或缺失时调制增益恒为 0，建出来的只是个不出声的振荡器，
         * 白白占一份调度与节点开销，直接跳过。
         */
        const fmIndex = event.fm_index ?? 0;
        let fmMod: OscillatorNode | null = null;
        if (event.fm_wave && fmIndex > 0 && !isNoiseWave(event.fm_wave)) {
          fmMod = ctx.createOscillator();
          fmMod.type = isOscillatorWave(event.fm_wave) ? event.fm_wave : 'sine';
          // 比率可小于 1（产生非谐低频调制），但不能为 0 或负；缺省 1 即同频调制
          const ratio = clamp(Math.abs(event.fm_ratio ?? 1), 0.01, 32, 1);
          fmMod.frequency.setValueAtTime(clamp(freq * ratio, 0.01, 20000, freq), t);
          fmMod.detune.value = clamp(detuneCents, -4800, 4800, 0);

          const fmGain = ctx.createGain();
          // fm_index 是"调制指数"，换算成 Hz 偏移量
          fmGain.gain.setValueAtTime(clamp(fmIndex, 0, 20000, 0), t);
          // 调制量随时值衰减，模拟真实 FM 音色的起音亮度
          fmGain.gain.exponentialRampToValueAtTime(
            Math.max(ZERO, fmIndex * 0.08),
            t + Math.max(0.05, duration * 0.6)
          );

          fmMod.connect(fmGain);
          fmGain.connect(osc.frequency);
        }

        osc.connect(g);
        osc.start(t);
        osc.stop(tailEnd);
        registerSource(osc);

        if (fmMod) {
          fmMod.start(t);
          fmMod.stop(tailEnd);
          registerSource(fmMod);
        }
      }

      // 4. 起音噪声：模拟弓弦摩擦 / 气息 / 拨片触弦
      const attackNoise = clamp(event.attackNoise ?? 0, 0, 1, 0);
      if (attackNoise > 0) {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBufferFor(ctx, 'white');
        src.loop = true;
        const nf = ctx.createBiquadFilter();
        nf.type = 'bandpass';
        nf.frequency.value = clamp(startFreq * 2.5, 200, ctx.sampleRate * NYQUIST_MARGIN, 2000);
        nf.Q.value = 0.8;
        const ng = ctx.createGain();
        const burst = clamp(0.03 + attackNoise * 0.05, 0.01, 0.2, 0.05);
        const level = attackNoise * peakGain * 0.5;
        ng.gain.setValueAtTime(ZERO, t);
        ng.gain.exponentialRampToValueAtTime(Math.max(ZERO, level), t + 0.003);
        ng.gain.exponentialRampToValueAtTime(ZERO, t + burst);
        ng.gain.setValueAtTime(0, t + burst + 0.005);

        src.connect(nf);
        nf.connect(ng);
        ng.connect(voiceMix);
        src.start(t);
        src.stop(t + burst + 0.02);
        registerSource(src);
      }

      // 5. LFO 调制
      if (event.lfo) {
        const lfo = ctx.createOscillator();
        lfo.type = isOscillatorWave(event.lfo.type) ? event.lfo.type : 'sine';
        lfo.frequency.value = clamp(event.lfo.frequency, 0.01, 100, 5);

        const lfoGain = ctx.createGain();
        const ramp = Math.max(0, event.lfo.ramp ?? 0);
        const target = event.lfo.target;
        const amount = event.lfo.amount;

        /**
         * 各调制目标的量纲不同，必须分别换算：
         * - frequency/detune 走 detune 参数（单位音分），amount 直接可用
         * - filter 走频率参数（单位 Hz），amount 直接可用
         * - gain 走增益参数，amount 必须当作 0~1 的深度比例，否则会严重削波
         * - pan 走声像参数，取值范围 -1~1
         */
        let peakAmount: number;
        switch (target) {
          case 'gain': peakAmount = clamp(amount, 0, 1, 0.3) * peakGain; break;
          case 'pan': peakAmount = clamp(amount, 0, 1, 0.3); break;
          case 'filter': peakAmount = clamp(amount, 0, 12000, 300); break;
          // 音高类：amount 视为音分，限制在 ±1200 音分（一个八度）内
          default: peakAmount = clamp(amount, -1200, 1200, 10); break;
        }

        if (ramp > 0) {
          // 淡入，避免起音瞬间参数跳变产生咔哒声
          lfoGain.gain.setValueAtTime(ZERO, t);
          lfoGain.gain.linearRampToValueAtTime(peakAmount, t + ramp);
        } else {
          lfoGain.gain.setValueAtTime(peakAmount, t);
        }
        /**
         * 渐进增强（riser 式颤音）。
         *
         * 终点必须**不早于**淡入终点：`ramp` 比音符时值长时（例如
         * `ramp=2` 配 `4n` 音符），淡入写在 `t+2`、增强写在 `t+0.5`，
         * 两个自动化事件时间倒流 —— 浏览器对乱序自动化事件的处理是未定义的。
         * 取两者较大值，保证时间线严格单调。
         */
        if (event.lfo.swell) {
          lfoGain.gain.linearRampToValueAtTime(
            peakAmount * 2.2, t + Math.max(0.05, duration, ramp)
          );
        }

        lfo.connect(lfoGain);

        if (target === 'frequency' || target === 'detune') {
          // 连到 detune（音分）而非 frequency（Hz），颤音深度才能在所有音高上听感一致
          voiceOscillators.forEach((osc) => lfoGain.connect(osc.detune));
        } else if (target === 'filter' && filterNode) {
          lfoGain.connect(filterNode.frequency);
        } else if (target === 'gain') {
          lfoGain.connect(ampNode.gain);
        } else if (target === 'pan' && pannerNode) {
          lfoGain.connect(pannerNode.pan);
        }

        lfo.start(t);
        lfo.stop(tailEnd);
        registerSource(lfo);
      }
    });
  }
}

/* ==================== 音频引擎门面 ==================== */

/** 效果尾音的额外预留时长 (秒) */
const EFFECT_TAIL = 3.0;

/** 混响脉冲长度上限（秒）。同时约束脉冲分配大小与尾音长度。 */
const MAX_REVERB_DECAY = 12;
/** 导出时的采样率 */
const RENDER_SAMPLE_RATE = 44100;

/**
 * 离线渲染的时长上限。
 *
 * 渲染长度直接决定内存：立体声 32 位浮点缓冲约 8 字节/帧，再加 16 位 PCM
 * 输出的 4 字节/帧，15 分钟就是 ~480MB。越过之后 Chromium 的分配会失败或
 * 长时间无响应，而调用方只会看到一个永不结束的 Promise —— 表现为导出按钮
 * 一直转圈且没有任何报错。这里提前拒绝，并说清是哪一步超了。
 */
const MAX_RENDER_SECONDS = 900;
const MAX_RENDER_FRAMES = MAX_RENDER_SECONDS * RENDER_SAMPLE_RATE;

/** 离线渲染的最长等待。超时说明渲染线程已卡死，不能让界面永远停在"导出中"。 */
const RENDER_TIMEOUT_MS = 120_000;

/**
 * 浏览器端音频引擎：编译 → 实时试听 / 离线导出。
 *
 * 编译成功后的事件表与解析结果留在实例上，播放与导出共用同一份数据，
 * 保证"听到的"与"导出的"是同一个东西。
 */
export class BrowserAudioEngine {
  // 这些节点在 buildGraph() 里创建（构造函数委托给它），故用明确赋值断言
  private mainCtx!: AudioContext;
  private masterGain!: GainNode;
  private compressor!: DynamicsCompressorNode;
  private limiter!: WaveShaperNode;
  private analyser!: AnalyserNode;

  private parser: SPGParser;
  private scheduler: EventScheduler;
  private synthesizer!: AudioSynthesizer;

  private lastParseResult: ParseResult | null = null;
  private scheduledEvents: ScheduledEvent[] = [];
  private totalDuration = 0;
  private activeSources: Set<AudioScheduledSourceNode> = new Set();
  /**
   * 上一次 compile 是否成功。只有成功编译的数据才能播放/导出：
   * 失败后 lastParseResult 里还留着旧解析结果（警告需要它），
   * 但播放/导出必须拒绝，否则用户拿到的是与当前代码无关的旧音频。
   */
  private lastCompileOk = false;

  constructor() {
    this.parser = new SPGParser();
    this.scheduler = new EventScheduler();
    this.buildGraph();
  }

  /**
   * 建立（或重建）音频节点图。
   *
   * 独立成方法是为了支持 `dispose()` 之后复用：React StrictMode 在开发模式下会
   * 先挂载、卸载、再挂载，卸载时的 `dispose()` 会关闭 AudioContext；
   * 若引擎实例被复用而不重建，第二次挂载拿到的就是一个已关闭的死上下文，
   * 表现为"完全没有声音"。这里让引擎在被关闭后能自我修复。
   */
  private buildGraph(): void {
    const Win = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioContextClass = Win.AudioContext || Win.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error('当前环境不支持 Web Audio API');
    }
    this.mainCtx = new AudioContextClass();
    this.synthesizer = new AudioSynthesizer();

    // 链路：masterGain -> compressor -> limiter -> analyser -> destination
    this.masterGain = this.mainCtx.createGain();
    this.compressor = this.mainCtx.createDynamicsCompressor();
    this.limiter = this.mainCtx.createWaveShaper();
    this.analyser = this.mainCtx.createAnalyser();

    // 1. 压缩器：降低压缩比、放慢启动，保留瞬态让声音有"呼吸感"
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.03;
    this.compressor.release.value = 0.25;

    // 2. 软削波限制器：tanh 饱和，防止数字削波
    this.limiter.curve = this.makeSoftClipCurve(1.0);
    this.limiter.oversample = '4x';

    // 3. 分析器
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.85;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;

    this.masterGain.connect(this.compressor);
    this.compressor.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.mainCtx.destination);

    this.masterGain.gain.value = this.masterVolume();
    this.activeSources.clear();
  }

  /** 上下文是否已被关闭（StrictMode 卸载后可能出现） */
  private get isDead(): boolean {
    return !this.mainCtx || this.mainCtx.state === 'closed';
  }

  /** 若上下文已失效则重建整张图 */
  private ensureAlive(): void {
    if (this.isDead) this.buildGraph();
  }

  /** 当前应使用的总线音量（无编译结果时用默认值） */
  private masterVolume(): number {
    return this.lastParseResult
      ? clamp(this.lastParseResult.masterVolumeConfig, 0, 2, 0.6)
      : 0.6;
  }

  /** 生成软削波曲线 */
  private makeSoftClipCurve(amount: number): Float32Array<ArrayBuffer> {
    const n = 4410;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; ++i) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.tanh(amount * x);
    }
    return curve;
  }

  /**
   * 取分析器节点。
   * 这里也要确保上下文存活：StrictMode 重挂载时组件会重新取一次分析器，
   * 若返回的是已关闭上下文里的旧节点，示波器就再也读不到数据了。
   */
  public getAnalyser(): AnalyserNode {
    this.ensureAlive();
    return this.analyser;
  }

  public getDuration(): number {
    return this.totalDuration;
  }

  /** 把解析异常转换为带行号的 ParserError */
  private toParserError(e: unknown): ParserError {
    if (e instanceof SPGError) {
      return { message: e.message, line: e.line };
    }
    const message = e instanceof Error ? e.message : '未知的编译错误';
    return { message, line: 0 };
  }

  public compile(code: string): ParserError | null {
    if (!code || code.trim().length === 0) {
      this.lastCompileOk = false;
      return { message: '代码为空', line: 1 };
    }
    try {
      const parsed = this.parser.parse(code);
      const { events, totalDuration } = this.scheduler.schedule(
        parsed.sequences,
        parsed.instruments,
        parsed.mix,
        parsed.tempo,
        parsed.swing
      );

      // 先落盘本次解析结果，警告才能在"没有事件"这条失败路径上也拿得到
      this.lastParseResult = parsed;

      if (events.length === 0) {
        // 没有事件就不能留着上一次的数据：否则用户点播放/导出，
        // 听到/拿到的是上一次编译的旧音频 —— 与当前代码完全无关。
        this.scheduledEvents = [];
        this.totalDuration = 0;
        this.lastCompileOk = false;
        return { message: '代码编译通过，但没有产生任何音符事件', line: 0 };
      }

      this.scheduledEvents = events;
      // 效果链会拖出尾音，导出时需要留出余量；混响 decay 可达十几秒，
      // 固定 3 秒会把长尾硬生生切掉，这里按实际 decay 动态留。
      // 上限与 makeImpulse 共用同一个常量：脉冲实际只有那么长，
      // 尾音留得比它更久只是在 WAV 末尾堆静音。
      const longestReverb = parsed.effects.reduce(
        (m, e) => (e.type === 'reverb' ? Math.max(m, e.decay) : m), 0
      );
      const tailRoom = parsed.effects.length > 0
        ? Math.min(Math.max(EFFECT_TAIL, longestReverb), MAX_REVERB_DECAY)
        : 0.5;
      this.totalDuration = totalDuration + tailRoom;

      this.masterGain.gain.value = this.masterVolume();
      this.lastCompileOk = true;
      return null;
    } catch (e: unknown) {
      this.lastCompileOk = false;
      return this.toParserError(e);
    }
  }

  /**
   * 最近一次成功编译产生的非致命提示。
   *
   * 典型场景是"某个 sequence 没被 mix 引用，因此不会发声"—— 代码语法完全正确、
   * 编译通过、界面显示 READY，但用户听不到那一轨，只能靠提示告诉他原因。
   */
  public getWarnings(): SPGWarning[] {
    return this.lastParseResult?.warnings ?? [];
  }

  public async playRealtime(): Promise<void> {
    if (!this.lastParseResult || !this.lastCompileOk) {
      throw new Error(
        this.lastParseResult
          ? '上次编译失败，请修复错误后重新编译再播放'
          : '没有可播放的已编译代码'
      );
    }
    // StrictMode 卸载会关闭上下文，这里按需重建后再播放
    this.ensureAlive();

    if (this.mainCtx.state === 'suspended') await this.mainCtx.resume();

    // 先停掉上一次的播放，避免声音叠加
    this.stop();

    const now = this.mainCtx.currentTime;
    // 留一点调度余量，避免首个音符因调度延迟被截断
    const startAt = now + 0.08;
    const playEvents = this.scheduledEvents.map((e) => ({ ...e, time: e.time + startAt }));

    this.synthesizer.scheduleEvents(
      this.mainCtx,
      this.masterGain,
      playEvents,
      this.lastParseResult.effects,
      this.registerSource.bind(this),
      // 效果器内的时间自动化（filter 扫频）必须跟事件走同样的偏移，
      // 否则扫频落在过去而完全听不见
      startAt
    );
  }

  private registerSource(node: AudioScheduledSourceNode): void {
    this.activeSources.add(node);
    node.onended = () => {
      this.activeSources.delete(node);
    };
  }

  public stop(): void {
    // 上下文已关闭时任何节点操作都会抛错，直接返回
    if (this.isDead) return;

    // 1. 停掉所有活动音源
    this.activeSources.forEach((source) => {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* 已停止的节点再 stop 会抛异常，忽略 */
      }
    });
    this.activeSources.clear();

    // 2. 重置 masterGain 以立刻掐断混响/延迟尾音。效果链挂在 masterGain 下游，
    //    断开它即可让整条链失去输入而静音，无需逐节点追踪（节点会随引用消失被回收）。
    try { this.masterGain.disconnect(); } catch { /* ignore */ }
    this.masterGain = this.mainCtx.createGain();
    // 音量必须与 buildGraph 一致：stop 后不重新 compile 直接播放时，
    // 否则音量会莫名其妙掉一档。
    this.masterGain.gain.value = this.masterVolume();
    this.masterGain.connect(this.compressor);
  }

  /** 释放音频上下文（组件卸载时调用）。之后再次播放会自动重建节点图。 */
  public async dispose(): Promise<void> {
    this.stop();
    try {
      if (this.mainCtx && this.mainCtx.state !== 'closed') await this.mainCtx.close();
    } catch {
      /* ignore */
    }
  }

  public async renderOffline(): Promise<Blob> {
    if (!this.lastParseResult || !this.lastCompileOk) {
      throw new Error(
        this.lastParseResult
          ? '上次编译失败，请修复错误后重新编译再导出'
          : '没有可导出的已编译代码'
      );
    }

    const sampleRate = RENDER_SAMPLE_RATE;
    const length = Math.max(1, Math.ceil((this.totalDuration || 1) * sampleRate));

    if (length > MAX_RENDER_FRAMES) {
      const minutes = (length / sampleRate / 60).toFixed(1);
      throw new Error(
        `工程时长 ${minutes} 分钟，超过离线导出上限 ${MAX_RENDER_SECONDS / 60} 分钟。请缩短序列或分段导出。`
      );
    }

    const Win = window as unknown as {
      OfflineAudioContext?: typeof OfflineAudioContext;
      webkitOfflineAudioContext?: typeof OfflineAudioContext;
    };
    const OfflineCtxClass = Win.OfflineAudioContext || Win.webkitOfflineAudioContext;
    if (!OfflineCtxClass) throw new Error('当前环境不支持离线音频渲染');

    // 立体声输出，与实时链路保持一致
    const offlineCtx = new OfflineCtxClass(2, length, sampleRate);

    const offMaster = offlineCtx.createGain();
    const offComp = offlineCtx.createDynamicsCompressor();
    const offLimiter = offlineCtx.createWaveShaper();

    // 复制实时链路的全部参数，保证导出与试听一致
    offComp.threshold.value = this.compressor.threshold.value;
    offComp.knee.value = this.compressor.knee.value;
    offComp.ratio.value = this.compressor.ratio.value;
    offComp.attack.value = this.compressor.attack.value;
    offComp.release.value = this.compressor.release.value;

    offLimiter.curve = this.limiter.curve;
    offLimiter.oversample = '4x';

    offMaster.gain.value = this.masterVolume();

    offMaster.connect(offComp);
    offComp.connect(offLimiter);
    offLimiter.connect(offlineCtx.destination);

    // 离线上下文采样率可能不同，需要独立合成器实例
    const offlineSynth = new AudioSynthesizer();
    offlineSynth.scheduleEvents(
      offlineCtx,
      offMaster,
      this.scheduledEvents,
      this.lastParseResult.effects,
      () => { /* 离线渲染无需跟踪音源 */ }
    );

    const renderedBuffer = await this.renderWithTimeout(offlineCtx);
    return bufferToWave(renderedBuffer, length);
  }

  /**
   * `startRendering()` 在渲染线程失败时可能既不 resolve 也不 reject。
   * 此时调用方的 await 永远挂着，界面停在"导出中"，而导出期间工具栏是禁用的 ——
   * 用户连重试都做不到。加一个有界等待，把"永不结束"变成一条能读的错误。
   *
   * 注意它管不到脉冲生成：那一步在 scheduleEvents 里同步跑完，
   * 主线程被它占住时这个定时器根本没机会注册。脉冲长度由 MAX_REVERB_DECAY 兜底。
   */
  private renderWithTimeout(ctx: OfflineAudioContext): Promise<AudioBuffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`离线渲染超时（${RENDER_TIMEOUT_MS / 1000} 秒未完成），已中止导出。请缩短工程后重试。`));
      }, RENDER_TIMEOUT_MS);

      ctx.startRendering().then(
        (buffer) => { clearTimeout(timer); resolve(buffer); },
        (err: unknown) => { clearTimeout(timer); reject(err); }
      );
    });
  }
}

/* ==================== 工程持久化 ==================== */

const PROJECTS_STORAGE_KEY = 'spg_projects_v1';
/** 聊天记录只留最近这些条，避免撑爆 localStorage 配额 */
const MAX_STORED_MESSAGES = 50;

/** 优先用 crypto.randomUUID，不可用时回退 Math.random */
const generateId = (): string => {
  try {
    const uuid = (globalThis as any)?.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid.length > 0) return uuid.replace(/-/g, '').slice(0, 12);
  } catch { /* 回退到下方实现 */ }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 11)}`;
};

export const createNewProject = (): Project => {
  return {
    id: generateId(),
    name: '未命名项目',
    code: '# 等待 AI 生成或手动输入代码...',
    messages: [
      { role: 'system', content: '欢迎使用声音粒子Web Studio。请描述您想要生成的音频（例如："生成一段120BPM的C大调上行音阶"）。', timestamp: Date.now() }
    ],
    createdAt: Date.now(),
    lastModified: Date.now()
  };
};

export const saveProjects = (projects: Project[]): void => {
  try {
    const projectsToSave = projects.map(p => ({
      ...p,
      messages: p.messages.slice(-MAX_STORED_MESSAGES)
    }));
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projectsToSave));
  } catch (e) {
    console.warn('Failed to save projects to localStorage', e);
  }
};

export const loadProjects = (): Project[] => {
  try {
    const data = localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!data) return [];
    const parsed: unknown = JSON.parse(data);
    // 坏缓存自愈：非数组直接丢；条目缺 id/code 的也丢，不让脏数据进状态
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is Project =>
        !!p && typeof p === 'object' &&
        typeof (p as Project).id === 'string' &&
        typeof (p as Project).code === 'string' &&
        Array.isArray((p as Project).messages)
    );
  } catch (e) {
    console.warn('Failed to load projects from localStorage', e);
    return [];
  }
};
