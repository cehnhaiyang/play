
import { InstrumentDef } from '../../../meta';

// 定义预设类型，允许部分属性缺失，最终合并时补全
type PresetDef = Partial<InstrumentDef>;

/**
 * 内置音色预设库。
 *
 * 约定：`fm_wave` 必须是真正的振荡器波形（sine/square/sawtooth/triangle），
 * 不能写噪声 —— OscillatorNode.type 不接受噪声名，会在调度期抛异常。
 * 需要噪声质感请用 `attack_noise` 或直接使用 noise 波形作为主波形。
 */
export const PRESETS: Record<string, PresetDef> = {
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

/** 按名称取预设（大小写不敏感） */
export const getPreset = (name: string): PresetDef | null => {
    return PRESETS[name.toLowerCase()] || null;
};

/** 全部可用预设名，供 UI 与提示词自动列出 */
export const PRESET_NAMES = Object.keys(PRESETS);
