
import { InstrumentDef } from '../../../meta';

// 定义预设类型，允许部分属性缺失，最终合并时补全
type PresetDef = Partial<InstrumentDef>;

export const PRESETS: Record<string, PresetDef> = {
  // === 基础/电子类 ===
  'piano': {
    wave: 'sine',
    envelope: { attack: 0.01, decay: 0.8, sustain: 0.0, release: 0.4 },
    fm_wave: 'sine',
    fm_ratio: 1.0,
    fm_index: 300,
    gain: 0.8,
    detune: 3,
    filter: { type: 'lowpass', frequency: 3000, Q: 0.5 }
  },
  'synth_pad': {
    wave: 'sawtooth',
    envelope: { attack: 1.5, decay: 2.0, sustain: 0.6, release: 2.5 },
    filter: { type: 'lowpass', frequency: 400, Q: 0.5 },
    // 缓慢打开的滤波器，增加动态感
    filterEnvelope: { attack: 2.0, decay: 1.0, sustain: 0.8, release: 2.0 },
    filterEnvAmount: 800, 
    detune: 15,
    gain: 0.6
  },
  'kick': {
    wave: 'sine',
    envelope: { attack: 0.001, decay: 0.3, sustain: 0.0, release: 0.05 },
    // 使用快速 FM 模拟瞬态冲击
    fm_wave: 'square',
    fm_ratio: 0.5,
    fm_index: 80,
    gain: 1.0
  },
  'bass': {
    wave: 'sawtooth', 
    envelope: { attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.1 },
    filter: { type: 'lowpass', frequency: 100, Q: 2 },
    filterEnvelope: { attack: 0.02, decay: 0.3, sustain: 0.0, release: 0.1 },
    filterEnvAmount: 500,
    detune: 4,
    gain: 0.8
  },
  'acid': {
    wave: 'sawtooth',
    envelope: { attack: 0.01, decay: 0.4, sustain: 0.0, release: 0.1 },
    filter: { type: 'lowpass', frequency: 200, Q: 8 }, 
    filterEnvelope: { attack: 0.05, decay: 0.3, sustain: 0.1, release: 0.1 },
    filterEnvAmount: 1500, 
    gain: 0.75
  },
  'plucked_synth': {
    wave: 'square',
    envelope: { attack: 0.01, decay: 2.0, sustain: 0.0, release: 0.1 },
    filter: { type: 'lowpass', frequency: 300, Q: 1 },
    filterEnvelope: { attack: 0.01, decay: 0.5, sustain: 0.0, release: 0.1 },
    filterEnvAmount: 2000,
    gain: 0.7,
    detune: 6
  },
  'guitar': {
    wave: 'triangle',
    envelope: { attack: 0.01, decay: 0.4, sustain: 0.1, release: 0.1 },
    filter: { type: 'lowpass', frequency: 1500, Q: 0.5 },
    gain: 0.7,
    detune: 2
  },

  // === 交响乐/管弦乐类 (Symphony) ===
  'violin': {
    wave: 'sawtooth',
    envelope: { attack: 0.4, decay: 0.5, sustain: 0.8, release: 0.4 },
    filter: { type: 'lowpass', frequency: 2000, Q: 1.5 }, // 较高的 Q 模拟琴箱共鸣
    lfo: { type: 'sine', frequency: 6, amount: 15, target: 'frequency' }, // 颤音
    detune: 5,
    gain: 0.7
  },
  'cello': {
    wave: 'sawtooth',
    envelope: { attack: 0.5, decay: 0.5, sustain: 0.9, release: 0.6 },
    filter: { type: 'lowpass', frequency: 800, Q: 0.8 },
    lfo: { type: 'sine', frequency: 4.5, amount: 8, target: 'frequency' },
    detune: 8,
    gain: 0.75,
    fm_wave: 'triangle', // 增加一点 FM 增加木质感
    fm_ratio: 2.0,
    fm_index: 50
  },
  'strings_section': {
    wave: 'sawtooth',
    envelope: { attack: 0.8, decay: 1.0, sustain: 1.0, release: 1.2 },
    filter: { type: 'lowpass', frequency: 1200, Q: 0.5 },
    detune: 25, // 大量 Detune 模拟齐奏
    gain: 0.6,
    pan: 0 // 默认居中，通常配合左右声像使用
  },
  'brass_ensemble': {
    wave: 'sawtooth',
    envelope: { attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.4 },
    filter: { type: 'lowpass', frequency: 400, Q: 1 },
    // 铜管标志性的 "Swell" 效果，滤波器随音量打开
    filterEnvelope: { attack: 0.15, decay: 0.3, sustain: 0.5, release: 0.4 },
    filterEnvAmount: 2000, 
    detune: 10,
    gain: 0.7
  },
  'flute': {
    wave: 'triangle',
    envelope: { attack: 0.15, decay: 0.1, sustain: 0.9, release: 0.2 },
    lfo: { type: 'sine', frequency: 5, amount: 10, target: 'frequency' },
    filter: { type: 'lowpass', frequency: 1500, Q: 0.3 },
    // 增加一点白噪音模拟气流声 (通过 FM 模拟不稳定性)
    fm_wave: 'white_noise',
    fm_ratio: 1.0,
    fm_index: 20,
    gain: 0.7
  },
  'clarinet': {
    wave: 'square', // 只有奇次谐波，类似方波
    envelope: { attack: 0.08, decay: 0.1, sustain: 0.8, release: 0.2 },
    filter: { type: 'lowpass', frequency: 1200, Q: 0.5 },
    gain: 0.65
  },
  'timpani': {
    wave: 'sine',
    envelope: { attack: 0.01, decay: 0.4, sustain: 0.0, release: 0.5 },
    // 音高下降模拟鼓皮松弛
    filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0, release: 0.1 }, 
    filterEnvAmount: -200, // 不用于 Filter，这里只是为了占位，实际上打击乐需要 Pitch Env，这里用 FM 模拟冲击
    fm_wave: 'sine',
    fm_ratio: 0.5,
    fm_index: 500, // 强烈的初始冲击
    gain: 0.9
  },
  'harp': {
    wave: 'triangle',
    envelope: { attack: 0.01, decay: 1.5, sustain: 0.0, release: 1.0 },
    filter: { type: 'lowpass', frequency: 3000, Q: 0.1 },
    gain: 0.7
  }
};

export const getPreset = (name: string): PresetDef | null => {
    return PRESETS[name.toLowerCase()] || null;
};
