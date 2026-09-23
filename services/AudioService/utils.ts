
import JSZip from 'jszip';
import type { NoiseColor } from '../../meta';

/* -------------------------------------------------------------------------- */
/*                                基础频率计算                                 */
/* -------------------------------------------------------------------------- */

const noteFreqCache: Record<string, number> = {};
const A4 = 440;
const SEMITONES: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

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

  const letter = m[1].toUpperCase();
  let semitone = SEMITONES[letter];
  for (const acc of m[2]) {
    semitone += (acc === '#' || acc === '♯') ? 1 : -1;
  }
  const octave = parseInt(m[3], 10);
  return (octave + 1) * 12 + semitone;
}

/** MIDI 音高号 → 频率 (Hz)，A4 = 440Hz */
export function midiToFreq(midi: number): number {
  return A4 * Math.pow(2, (midi - 69) / 12);
}

export function getFreq(note: string): number {
  const key = String(note ?? '').trim();
  if (noteFreqCache[key]) return noteFreqCache[key];
  const freq = midiToFreq(getMidi(key));
  if (!Number.isFinite(freq) || freq <= 0) {
    throw new Error(`音名 "${note}" 计算出的频率非法 (${freq}Hz)`);
  }
  noteFreqCache[key] = freq;
  return freq;
}

/* -------------------------------------------------------------------------- */
/*                                  时值解析                                   */
/* -------------------------------------------------------------------------- */

/**
 * 解析时值记号到秒。
 *
 * 支持写法：
 * - 音符时值：`1n` `2n` `4n` `8n` `16n` `32n` `64n` `128n`
 * - 附点：`4n.` (×1.5)、`4n..` (×1.75)
 * - 三连音：`4nt` (×2/3)、`8nt`
 * - 小节：`1m` `2m` (按 4/4 拍，1 小节 = 4 拍)
 * - 绝对时间：`250ms` `1.5s`
 * - 纯数字：按秒处理
 *
 * 非法输入抛出错误，避免 `Infinity` / `NaN` 悄悄流入音频图导致死循环或静音。
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

  // 附点 / 三连音后缀
  //
  // 附点必须按"点的个数"算，不能简单地连乘 1.5：
  // 单附点 = 1 + 1/2 = 1.5，双附点 = 1 + 1/2 + 1/4 = 1.75（而不是 2.25）。
  // 旧实现把 1.5 连乘两次得到 2.25，与函数文档里写的 ×1.75 自相矛盾，
  // 且 `4n..` 会被解析成一个不存在的时值（比双附点长了近 30%）。
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

  // 纯数字按秒。
  // 必须校验整个字符串都是数字 —— 用 parseFloat 会把 `4x` 这类拼写错误
  // 悄悄读成 4 秒，于是"写错了时值"变成"这个音特别长"，错误被静默吞掉。
  if (multiplier === 1 && /^\d+(\.\d+)?$/.test(body)) {
    return parseFloat(body);
  }

  throw new Error(
    `无法解析的时值 "${dur}"（可用 4n / 8n. / 16nt / 1m / 250ms / 1.5s）`
  );
}

/* -------------------------------------------------------------------------- */
/*                                音频数值工具                                 */
/* -------------------------------------------------------------------------- */

/** 将数值钳制在 [min, max] 区间，非有限值回落到 fallback */
export function clamp(value: number, min: number, max: number, fallback = min): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** MIDI 音高号 → 音名，用于调试输出 */
export function midiToName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const rounded = Math.round(midi);
  const octave = Math.floor(rounded / 12) - 1;
  return `${names[((rounded % 12) + 12) % 12]}${octave}`;
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

/* -------------------------------------------------------------------------- */
/*                                Wave 编码器                                  */
/* -------------------------------------------------------------------------- */

export function bufferToWave(abuffer: AudioBuffer, len: number): Blob {
  const numOfChan = abuffer.numberOfChannels;
  // 不能超过实际渲染长度，否则会写出一段静音尾巴
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

/* -------------------------------------------------------------------------- */
/*                                Zip 导出服务                                 */
/* -------------------------------------------------------------------------- */

export const exportProjectBundle = async (sourceCode: string, audioBlob: Blob): Promise<Blob> => {
  const zip = new JSZip();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  zip.file(`project_${timestamp}.spg`, sourceCode);
  zip.file(`audio_${timestamp}.wav`, audioBlob);

  const readme = `Sound Particle Project
Created at: ${new Date().toLocaleString()}

How to use:
1. Open https://sound-particle.app (or your hosted URL)
2. Click "Import Project"
3. Select the .spg file from this archive
`;
  zip.file('README.txt', readme);

  return await zip.generateAsync({ type: 'blob' });
};
