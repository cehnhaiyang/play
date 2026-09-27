
/// <reference lib="dom" />
import { ScheduledEvent, EffectDef, Envelope, DrumName } from '../../../meta';
import { fillNoise, createRandom, clamp, midiToFreq } from '../utils';
import { DRUM_SPECS, DrumSpec } from './drums';

/** 指数自动化不能到 0，用极小值代替 */
const ZERO = 0.0001;
const NYQUIST_MARGIN = 0.45;

export class AudioSynthesizer {
    private noiseBuffers = new Map<string, AudioBuffer>();

    constructor(ctx: BaseAudioContext) {
        this.initNoiseBuffers(ctx);
    }

    /* ---------------------------- 噪声样本预生成 ---------------------------- */

    private initNoiseBuffers(ctx: BaseAudioContext) {
        const duration = 2.0;
        const sampleRate = ctx.sampleRate;
        const bufferSize = Math.floor(sampleRate * duration);

        // 固定种子：同一份代码每次渲染得到相同的噪声纹理
        const colors: Array<'white' | 'pink' | 'brown'> = ['white', 'pink', 'brown'];
        colors.forEach((color, i) => {
            const buffer = ctx.createBuffer(1, bufferSize, sampleRate);
            fillNoise(buffer.getChannelData(0), color, createRandom(0x5eed + i * 977));
            this.noiseBuffers.set(color, buffer);
        });
    }

    private noiseBufferFor(ctx: BaseAudioContext, wave: string): AudioBuffer | null {
        const key = wave.startsWith('brown') ? 'brown' : wave.startsWith('pink') ? 'pink' : 'white';
        const existing = this.noiseBuffers.get(key);
        if (existing && existing.sampleRate === ctx.sampleRate) return existing;
        // 离线上下文采样率可能不同，按需重建
        const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
        fillNoise(buffer.getChannelData(0), key, createRandom(0x5eed));
        this.noiseBuffers.set(key, buffer);
        return buffer;
    }

    private static isNoise(wave: string): boolean {
        return wave === 'white_noise' || wave === 'pink_noise' || wave === 'brown_noise';
    }

    /* ------------------------------ 包络自动化 ------------------------------ */

    /**
     * 在 AudioParam 上写入 ADSR 自动化。
     *
     * 关键点：当音符时值短于 attack+decay 时按比例压缩 A/D，
     * 保证所有时间点严格单调递增 —— 旧实现会让 release 落在 decay 之前，
     * 浏览器会以"自动化事件乱序"处理，导致包络行为不可预测。
     *
     * `loopPoint > 0` 时进入"重复起音"模式：每隔 loopPoint 秒重新起音一次，
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

        // 短音符压缩 A/D，避免时间点倒流
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
            let sa = Math.min(a, segDur * 0.4);
            let sd = Math.min(d, segDur * 0.4);

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

    /* ------------------------------ 效果链构建 ------------------------------ */

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
        const length = Math.max(1, Math.floor(rate * Math.max(0.05, decay)));
        const impulse = ctx.createBuffer(2, length, rate);
        const rand = createRandom(0x1e5 + Math.floor(decay * 1000));
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
     * 同时支持时间类、失真类、调制类与动态类效果。
     *
     * `registerSource` 与 `stopAt` 用于接管调制类效果内部的 LFO：
     * 它们必须被登记并在曲末停止，否则会永久占用振荡器。
     */
    public buildEffectChain(
        ctx: BaseAudioContext,
        inputNode: AudioNode,
        outputNode: AudioNode,
        effects: EffectDef[],
        registerSource?: (node: AudioScheduledSourceNode) => void,
        stopAt?: number
    ) {
        let currentNode = inputNode;

        /** 启动效果器内部 LFO 并纳入生命周期管理 */
        const startChainLfo = (lfo: OscillatorNode) => {
            const start = 0;
            lfo.start(start);
            if (stopAt !== undefined && Number.isFinite(stopAt) && stopAt > start) {
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
                        // 乒乓：左右两路交替反馈
                        const splitter = ctx.createChannelSplitter(2);
                        const left = ctx.createDelay(10);
                        const right = ctx.createDelay(10);
                        const panL = ctx.createStereoPanner();
                        const panR = ctx.createStereoPanner();
                        panL.pan.value = -1;
                        panR.pan.value = 1;
                        // 左右延迟时间略微错开，形成交替弹跳
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

                    const preDelay = clamp(effect.preDelay ?? 0.01, 0, 0.5, 0.01);
                    const pre = ctx.createDelay(1);
                    pre.delayTime.value = preDelay;

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
                        ap.frequency.value = minF;
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
                    const start = Math.max(0, effect.start);
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

    /* -------------------------------- 鼓组合成 ------------------------------ */

    private scheduleDrum(
        ctx: BaseAudioContext,
        destination: AudioNode,
        event: ScheduledEvent,
        registerSource: (node: AudioScheduledSourceNode) => void
    ) {
        const baseSpec = DRUM_SPECS[event.drum as DrumName];
        if (!baseSpec) return;

        /**
         * 逐次击打微调。
         *
         * `tune` 改基频、`decay` 改衰减、`tone` 移滤波频率、`snap` 加瞬态。
         * 没有这些参数时，整首歌里同一个 `hit("kick")` 每次听起来一模一样，
         * 而这正是"程序化鼓组"最容易被听出来的地方；有了它们，
         * 模型可以用 `tune=-2, decay=0.8` 把同一套鼓拆成"主歌的闷底鼓"
         * 与"副歌的亮底鼓"，而不必依赖并不存在的额外鼓组音色。
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

        if (spec.highpass) {
            const hp = ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = clamp(spec.highpass + toneShift, 20, 20000, spec.highpass);
            hp.Q.value = 0.7;
            out.connect(hp);
            hp.connect(destination);
        } else {
            out.connect(destination);
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
                 * 旧实现写死 0.002 秒的起音，而 `decay` 会被 hit 的时值截断：
                 * `hit("kick","64n")` 的 decay 只有 0.031 秒，起音还来得及，
                 * 但 `hit("kick","128n")` 这种极短时值会让 `t + 0.002` 越过
                 * `t + decay`，两个自动化事件时间倒流 —— 浏览器的自动化行为
                 * 在乱序时是未定义的，表现为音量忽大忽小甚至爆音。
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
            if (buffer) {
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
                // 拍手的多次爆发：用几个短促包络堆叠出"啪"的群感
                if (event.drum === 'clap') {
                    /**
                     * 四次爆发的包络必须写成一条**严格递增**的时间线。
                     *
                     * 旧实现先把四次爆发（固定 0/11/23/36 毫秒）排完，再补一句
                     * `setValueAtTime(noiseAmp, t + 0.036)` —— 而最后一次爆发已经把
                     * 自动化推到了 `t + 0.045`，这一句把时间点**倒拨**回 0.036。
                     * 浏览器对乱序的自动化事件行为未定义，实测表现为拍手音量忽大忽小；
                     * 而且固定的毫秒间隔在极短时值（如 `hit("clap","128n")`）下会整段越界。
                     * 这里改为按可用衰减时长缩放爆发间隔，并在每次爆发后直接衔接下一次。
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
        }

        // 3. 起音冲击层：极短的高频噪声，让瞬态"扎"出来
        if (snap > 0) {
            const buffer = this.noiseBufferFor(ctx, 'white');
            if (buffer) {
                const src = ctx.createBufferSource();
                src.buffer = buffer;
                src.loop = true;
                const hp = ctx.createBiquadFilter();
                hp.type = 'highpass';
                hp.frequency.value = clamp(spec.noiseFreq * 0.6 + toneShift, 200, 20000, 4000);
                const g = ctx.createGain();
                const burst = 0.012;
                const level = snap * 0.5;
                g.gain.setValueAtTime(ZERO, t);
                g.gain.exponentialRampToValueAtTime(Math.max(ZERO, level), t + 0.0008);
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
    }

    /* ------------------------------- 主调度入口 ----------------------------- */

    public scheduleEvents(
        ctx: BaseAudioContext,
        destination: AudioNode,
        events: ScheduledEvent[],
        effects: EffectDef[],
        registerSource: (node: AudioScheduledSourceNode) => void
    ) {
        const masterBus = ctx.createGain();
        masterBus.gain.value = 1.0;

        // 效果链内部 LFO 的停止时刻：最后一个事件的尾音之后
        const chainStop = events.reduce(
            (acc, e) => Math.max(acc, e.time + e.duration + (e.envelope?.release ?? 0) + 0.5),
            1
        );

        if (effects.length > 0) {
            this.buildEffectChain(ctx, masterBus, destination, effects, registerSource, chainStop);
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
            this.buildEffectChain(ctx, bus, masterBus, instEffects, registerSource, chainStop);
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

            const isNoise = AudioSynthesizer.isNoise(event.wave);
            const voiceCount = clamp(event.voices ?? 1, 1, 7, 1);

            /* --- 振幅总线：所有声部汇总后统一做包络，避免声部间相位差被包络扭曲 --- */
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

                    filterNode.frequency.setValueAtTime(baseFreq, t);
                    filterNode.frequency.exponentialRampToValueAtTime(Math.max(ZERO, peak), aEnd);
                    filterNode.frequency.exponentialRampToValueAtTime(Math.max(ZERO, sustainF), dEnd);
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

            /* ---------------------------- 生成各声部 ---------------------------- */
            const spread = clamp(event.spread ?? 0, 0, 1, 0);
            const unison = clamp(event.unisonSpread ?? 12, 0, 100, 12);
            const detuneBase = event.detune ?? 0;
            // 声部数增加时按 1/sqrt(n) 补偿响度
            const voiceGain = voiceCount > 1 ? 1 / Math.sqrt(voiceCount) : 1;

            const startFreq = event.freq;
            // 滑音：从偏移半音处滑向目标音
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
                    const buffer = this.noiseBufferFor(ctx, event.wave);
                    if (!buffer) continue;
                    const src = ctx.createBufferSource();
                    src.buffer = buffer;
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
                    osc.type = (['sine', 'square', 'sawtooth', 'triangle'] as OscillatorType[])
                        .includes(event.wave as OscillatorType)
                        ? (event.wave as OscillatorType)
                        : 'sine';
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

                if (event.pitchEnvAmount && event.pitchEnvAmount !== 0 && event.pitchDecay) {
                    const peakF = clamp(
                        freq * Math.pow(2, event.pitchEnvAmount / 12),
                        0.01, ctx.sampleRate * NYQUIST_MARGIN, freq
                    );
                    // 与滑音叠加时从滑音终点继续，避免时间点冲突
                    const pStart = t + (glide > 0 ? glide : 0);
                    osc.frequency.setValueAtTime(peakF, pStart);
                    osc.frequency.exponentialRampToValueAtTime(
                        freq, pStart + Math.max(0.005, event.pitchDecay)
                    );
                }

                osc.detune.value = clamp(detuneCents, -4800, 4800, 0);
                voiceOscillators.push(osc);

                // FM 调制
                let fmMod: OscillatorNode | null = null;
                if (event.fm_wave && event.fm_ratio && !AudioSynthesizer.isNoise(event.fm_wave)) {
                    fmMod = ctx.createOscillator();
                    fmMod.type = (['sine', 'square', 'sawtooth', 'triangle'] as OscillatorType[])
                        .includes(event.fm_wave as OscillatorType)
                        ? (event.fm_wave as OscillatorType)
                        : 'sine';
                    // 比率可小于 1（产生非谐低频调制），但不能为 0 或负
                    const ratio = clamp(Math.abs(event.fm_ratio), 0.01, 32, 1);
                    fmMod.frequency.setValueAtTime(clamp(freq * ratio, 0.01, 20000, freq), t);
                    fmMod.detune.value = clamp(detuneCents, -4800, 4800, 0);

                    const fmGain = ctx.createGain();
                    // fm_index 是"调制指数"，换算成 Hz 偏移量
                    fmGain.gain.setValueAtTime(clamp(event.fm_index ?? 0, 0, 20000, 0), t);
                    // 调制量随时值衰减，模拟真实 FM 音色的起音亮度
                    if (event.fm_index && event.fm_index > 0) {
                        fmGain.gain.exponentialRampToValueAtTime(
                            Math.max(ZERO, event.fm_index * 0.08),
                            t + Math.max(0.05, duration * 0.6)
                        );
                    }

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
                const buffer = this.noiseBufferFor(ctx, 'white');
                if (buffer) {
                    const src = ctx.createBufferSource();
                    src.buffer = buffer;
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
            }

            // 5. LFO 调制
            if (event.lfo) {
                const lfo = ctx.createOscillator();
                lfo.type = (['sine', 'square', 'sawtooth', 'triangle'] as OscillatorType[])
                    .includes(event.lfo.type) ? event.lfo.type : 'sine';
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
                // 渐进增强（riser 式颤音）
                if (event.lfo.swell) {
                    lfoGain.gain.linearRampToValueAtTime(
                        peakAmount * 2.2, t + Math.max(0.05, duration)
                    );
                }

                lfo.connect(lfoGain);

                if (target === 'frequency' || target === 'detune') {
                    // 连到 detune（音分）而非 frequency（Hz），
                    // 这样颤音深度在所有音高上听感一致
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
