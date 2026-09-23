
/// <reference lib="dom" />
import type { DrumName } from '../../../meta';

/**
 * 内置鼓组合成器。
 *
 * 设计意图：让 LLM 不必先定义一个合成器乐器就能写出节奏声部 ——
 * 直接 `hit("kick", "4n")` 即可。三种合成模型覆盖绝大多数打击乐：
 * - `membrane` 带音高包络的正弦膜振动（底鼓 / 通鼓）
 * - `noise`    噪声为主、带通塑形（军鼓 / 拍手 / 沙锤）
 * - `metallic` 多个非谐方波分音叠加（镲片 / 踩镲 / 牛铃）
 */

export interface DrumSpec {
    model: 'membrane' | 'noise' | 'metallic';
    /** 基频 (Hz) */
    freq: number;
    /** 音高包络深度（半音） */
    pitchAmount: number;
    /** 音高包络衰减 (秒) */
    pitchDecay: number;
    /** 振幅衰减 (秒) */
    decay: number;
    /** 噪声层混合比 (0~1) */
    noise: number;
    /** 噪声层滤波器类型 */
    noiseFilter: BiquadFilterType;
    /** 噪声层滤波频率 (Hz) */
    noiseFreq: number;
    /** 噪声层 Q */
    noiseQ: number;
    /** 金属层的非谐比率 */
    ratios?: number[];
    /** 基础增益 */
    gain: number;
    /** 高通清理低频泥浆 (Hz) */
    highpass?: number;
}

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

/** 全部可用鼓组名，供 UI 与提示词自动列出 */
export const DRUM_NAMES = Object.keys(DRUM_SPECS) as DrumName[];
