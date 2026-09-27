
import { getMidi } from '../utils';

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER_ORDER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NOTE_LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * 半音数 → 音级序号（1 = 根音、3 = 三音、5 = 五音、7 = 七音、9/11/13 = 延伸音）。
 *
 * 音名的拼写由**音级**决定，而不是由音高决定：
 * `Cdim7` 的第三个音在钢琴上是 3 个半音，但它的音级是三音，
 * 因此必须写成 `Eb` 而不是 `D#`；第七音的音级是七音，所以是 `Bb` 而不是 `A#`。
 * 只看半音数会得到一堆等音异名，虽然频率相同，但和弦符号会变得无法辨认。
 */
const INTERVAL_DEGREE: Record<number, number> = {
  0: 1, 1: 2, 2: 2, 3: 3, 4: 3, 5: 4, 6: 5, 7: 5, 8: 5,
  9: 6, 10: 7, 11: 7, 12: 8, 13: 9, 14: 9, 15: 9,
  16: 11, 17: 11, 18: 11, 19: 12, 20: 13, 21: 13,
};

/** 把 MIDI 音高号拆成音名（不含八度）与八度 */
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
 * 变音记号超过一个（如减七和弦的 `Bbb`）时退化为简单音名 ——
 * 合成器并不区分等音，双降号只会让输出更难读。
 *
 * `semitones` 是**实际音高**用的音程，`degreeSemitones` 是查音级表用的音程，
 * 两者默认相同。声位变换（open / drop2 / spread）只搬动八度，不改音级，
 * 所以那里必须把变换**前**的音程传进来：否则 C 和弦的三音 4 升高八度变成 16，
 * 查表命中十一度，会拼出 `Fb5` 这种同音异名的错音名（频率对、写法错）。
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
  const naturalPc = NOTE_LETTERS[letter];

  let diff = targetPc - naturalPc;
  while (diff > 6) diff -= 12;
  while (diff < -6) diff += 12;

  if (diff > 1 || diff < -1) {
    // 需要双升/双降：用等音简化，避免输出 Bbb 这类难读的音名
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
 * 和弦符号解析器。
 *
 * 为什么要做这件事：LLM 的"母语"是和弦符号（`Am7`、`Fmaj9`、`G7/B`），
 * 而不是音高数组。要求模型自己把 `Am7` 展开成 `["A3","C4","E4","G4"]` 会带来两类损失：
 *
 * 1. **正确性**：模型展开七和弦/九和弦时经常漏音或写错音程，直接把和弦写错；
 * 2. **音乐性**：模型展开时倾向于写密集排列（close voicing），
 *    而真实编曲需要转位、开放排列、省略五音等手法，模型很难每次都算对。
 *
 * 因此语法层直接接受和弦符号，由引擎按确定的声位规则展开，
 * 模型只需负责"和声进行"这一它真正擅长的高层决策。
 */

/** 和弦性质 → 相对根音的半音音程表 */
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
 * `degree` 必须是该音级的**自然音程**：展开时先删掉自然音程、再插入
 * `degree + shift`。这里曾经把 `#11`/`b11` 的 degree 写成 18（而不是自然十一度的 17），
 * 于是 `delete(18)` 删了个不存在的音，`add(18+1)` 得到 **19** ——
 * 而 19 半音正好等于五度音高八度（7+12），`C7#11` 里凭空多出一个重复的 G，
 * 真正的 F# 反而没有。`b11` 同理得到 17（自然十一度），降号完全失效。
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

export type VoicingStyle = 'close' | 'open' | 'drop2' | 'spread';

export interface ChordSymbol {
  /** 根音音名（不带八度） */
  root: string;
  /** 原始性质文本（规范化前） */
  quality: string;
  /** 转位低音音名；无则为 null */
  bass: string | null;
  /** 相对根音的半音音程 */
  intervals: number[];
}

/** 解析根音/低音音名（允许 #/b/♯/♭），返回 { name, pitchClass } */
function parseNoteName(text: string): { name: string; pitchClass: number } | null {
  const m = /^([A-Ga-g])([#b♯♭]*)$/.exec(text.trim());
  if (!m) return null;
  const letter = m[1].toUpperCase();
  let pc = NOTE_LETTERS[letter];
  for (const acc of m[2]) pc += acc === '#' || acc === '♯' ? 1 : -1;
  return { name: letter + m[2], pitchClass: ((pc % 12) + 12) % 12 };
}

/**
 * 展开无法在表里直接命中的和弦性质。
 * 处理 `<基础三和弦><扩展音><变化音>` 这类组合，例如 `m7#5`、`7b9`、`maj9#11`。
 */
function expandQuality(quality: string): number[] | null {
  let rest = quality;
  let base: number[];
  /** `maj` 前缀决定七度是**大七度**(11) 而不是属七度(10) */
  let majorSeventh = false;

  if (/^(min|minor|-)/.test(rest)) { base = [0, 3, 7]; rest = rest.replace(/^(min|minor|-)/, ''); }
  else if (/^(maj|major|M|Δ)/.test(rest)) { base = [0, 4, 7]; majorSeventh = true; rest = rest.replace(/^(maj|major|M|Δ)/, ''); }
  else if (/^(dim|o)(?![0-9])/.test(rest)) { base = [0, 3, 6]; rest = rest.replace(/^(dim|o)/, ''); }
  else if (/^(aug|\+)/.test(rest)) { base = [0, 4, 8]; rest = rest.replace(/^(aug|\+)/, ''); }
  else if (/^(sus4?)/.test(rest)) { base = [0, 5, 7]; rest = rest.replace(/^sus4?/, ''); }
  else if (/^sus2/.test(rest)) { base = [0, 2, 7]; rest = rest.replace(/^sus2/, ''); }
  else if (/^m/.test(rest)) { base = [0, 3, 7]; rest = rest.replace(/^m/, ''); }
  else { base = [0, 4, 7]; }

  // 单独一个 `m` / `M` 已在上面的基础分支消化掉，这里 rest 只应剩扩展音与变化音
  const intervals = new Set<number>(base);
  let matched = false;

  // 变化音优先（`b5` 必须整体识别，不能被拆成 `b` + `5`）
  for (const key of Object.keys(ALTERATIONS)) {
    if (rest.includes(key)) {
      const { degree, shift } = ALTERATIONS[key];
      // 去掉原本的同名自然音程，再插入变化后的音程
      intervals.delete(degree);
      intervals.add(degree + shift);
      rest = rest.split(key).join('');
      matched = true;
    }
  }

  // 省略音
  if (/(no|omit)3/.test(rest)) { intervals.delete(3); intervals.delete(4); rest = rest.replace(/(no|omit)3/, ''); matched = true; }
  if (/(no|omit)5/.test(rest)) { intervals.delete(7); rest = rest.replace(/(no|omit)5/, ''); matched = true; }

  /**
   * `add` 系列（add9 / add11 / add6）**只加音、不含七度**，
   * 必须先摘掉再解析扩展音，否则会被当成普通 9/11 而补上七度。
   */
  const isAdd = /add/.test(rest);
  if (isAdd) rest = rest.replace(/add/g, '');

  // 先取标志位，再把数字从 rest 里摘干净（残余检查依赖 rest 已被清空）
  const has7 = /7/.test(rest);
  const has9 = /9/.test(rest);
  const has11 = /11/.test(rest);
  const has13 = /13/.test(rest);
  const has6 = /6/.test(rest);

  if (has9) intervals.add(14);
  if (has11) { intervals.add(14); intervals.add(17); }   // 11 隐含 9
  if (has13) { intervals.add(14); intervals.add(21); }   // 13 隐含 9
  if (has7 || has9 || has11 || has13) matched = true;

  /**
   * 七度：显式写 `7`，或由 9 / 11 / 13 **隐含**。
   *
   * 这里必须与和弦表保持一致 —— 表里 `C9 = [0,4,7,10,14]`、`C11 = [0,4,7,10,14,17]`、
   * `C13 = [0,4,7,10,14,21]` 都含属七度。此前展开分支只认字面 `7`，
   * 于是 `C9#11` 得到 [0,4,7,14,19]（没有七度）、而 `C9` 得到 [0,4,7,10,14]（有七度），
   * 同一个 9 和弦加个变化音就变成了完全不同的和声。
   * `maj` 前缀则用大七度：`Cmaj7#11` 必须是 C E G B F#，而不是 C E G Bb。
   */
  if (!isAdd && (has7 || has9 || has11 || has13)) {
    intervals.add(majorSeventh ? 11 : 10);
  }
  if (has6) { intervals.add(9); matched = true; }

  // 摘掉已识别的扩展音数字；剩下的才是真正无法识别的字符
  rest = rest.replace(/1[13]|[679]/g, '');

  // 仍有残余字符说明是拼错的和弦名，宁可报错也不要静默给出错误和声
  if (rest.replace(/[()\s]/g, '').length > 0) return null;
  if (!matched) return null;

  return Array.from(intervals).sort((a, b) => a - b);
}

/** 解析和弦符号，失败返回 null */
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

  const rootMatch = /^([A-Ga-g])([#b♯♭]?)(.*)$/.exec(body.trim());
  if (!rootMatch) return null;
  const rootParsed = parseNoteName(rootMatch[1] + rootMatch[2]);
  if (!rootParsed) return null;

  const qualityRaw = rootMatch[3].trim();
  // 精确命中优先；`m`/`M` 这类单字母性质必须走表，否则会被通用展开误判
  const direct = CHORD_INTERVALS[qualityRaw] ?? CHORD_INTERVALS[qualityRaw.replace(/\s+/g, '')];
  const intervals = direct ?? expandQuality(qualityRaw);
  if (!intervals || intervals.length === 0) return null;

  return { root: rootParsed.name, quality: qualityRaw, bass, intervals: [...intervals] };
}

/**
 * 把和弦符号展开成带八度的音名数组。
 *
 * 声位规则（`voicing`）：
 * - `close`  密集排列：全部音挤在一个八度内（键盘/铺底最常用）
 * - `open`   开放排列：把三音升高一个八度，音域更宽、更"打开"
 * - `drop2`  把从上往下数第二个音降低一个八度（爵士钢琴的标准左手声位）
 * - `spread` 相邻音交替向上八度，得到跨度最大的铺底声位
 *
 * 斜杠低音会额外在根音下方一个八度补上低音，而不是替换原有声部 ——
 * 这样 `C/E` 仍然是完整的 C 和弦，只是转位，符合和声学直觉。
 */
export function voicingToPitches(
  chord: ChordSymbol,
  octave: number,
  voicing: VoicingStyle = 'close'
): string[] {
  const rootLetter = chord.root[0].toUpperCase();
  const rootMidi = (octave + 1) * 12 + (NOTE_LETTERS[rootLetter] ?? 0)
    + (chord.root.includes('#') || chord.root.includes('♯') ? 1 : 0)
    + (chord.root.includes('b') || chord.root.includes('♭') ? -1 : 0);

  const preferFlats = /[b♭]/.test(chord.root) || /[b♭]/.test(chord.quality);

  let intervals = [...chord.intervals];
  /**
   * 每个音**变换前**的音程，用于查音级表。
   *
   * 声位变换只搬八度、不改音级，所以拼写时必须按原始音程查表。
   * 直接拿变换后的音程查会把三音(4)→十一度(16)、五音(7)→十二度(19)，
   * 于是 C 的 open 声位拼出 `Fb5`（本该是 `E5`）、G 的 open 拼出 `Cb6`（本该是 `D6`）。
   */
  const degreeIntervals = [...chord.intervals];

  if (voicing === 'open') {
    // 三音（第一个非根音）升高八度
    if (intervals.length > 1) intervals[1] += 12;
  } else if (voicing === 'drop2') {
    if (intervals.length >= 3) {
      const idx = intervals.length - 2;
      intervals[idx] -= 12;
    }
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
