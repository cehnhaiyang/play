
import {
    InstrumentDef, SequenceDef, ScheduledEvent, ArpCommand, ChordCommand,
    NoteExpression, MixTrack, FilterDef, ProgressionCommand, RunCommand, DrumName, ArpPattern,
} from '../../../meta';
import { getMidi, midiToFreq, parseDuration, clamp, createRandom } from '../utils';
import { DRUM_SPECS } from './drums';

/** 每音符最大声部数，防止 `voices` 与 `arp` 组合时爆炸 */
const MAX_VOICES = 7;

/** 字符串 → 32 位种子，用于确定性 humanize */
function hashSeed(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

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
         * 摇摆：把"后半拍"往后推，推到三连音该在的位置。
         *
         * 爵士/放克/Lo-fi 的律动感几乎全部来自这里 —— 用均匀的时值网格
         * 演奏切分节奏，听感必然是"机器在打拍子"。
         *
         * 规则统一为「把后半拍挪到最近的八分三连音位置上」，分两层：
         *  - 十六分音符网格里落在**奇数步**的（第 2、4 个十六分）→ 推到 1/3 拍，偏移 1/3 grid
         *  - 落在 **step % 4 === 2** 的（第 2 个八分，即"后半拍"）→ 推到 2/3 拍，偏移 2/3 grid
         * `swing=1` 即完全三连音化（标准 shuffle），`swing=0` 为平均八分。
         *
         * **两层都必须处理**：此前只处理了奇数步，于是 `8n` 写法的音符落在
         * step 0/2/4/6 全是偶数，**一个都不会被推动** —— 而 `8n` 恰恰是
         * 爵士鼓组（ride 的 ding-ding-a-ding）和 Lo-fi 最常用的写法，
         * 提示词也正是让模型给这两类风格开 swing。结果是设了 swing 却完全听不出变化。
         * 偏移量 2/3 grid < grid，不会越过下一个音，单调性有测试保证。
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

        /**
         * 调度单个音序，返回其净时长。
         * 所有音高与时值在此处一次性算成绝对秒数，合成器不再做乐理换算。
         */
        const scheduleSequence = (
            seqName: string,
            startTime: number,
            trackGain: number,
            trackPan: number,
            trackTranspose: number,
            /**
             * 随机流盐：种子原来只含 (音序名, 起始时刻)，于是 mix 里
             * 同一音序同一时刻出现两次（如齐奏叠加），两遍的 humanize 抖动
             * 逐采样相同 —— 双轨叠加等于单轨加 6dB，还多了一倍节点。
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
            const seqTranspose = (seq.transpose ?? 0) + trackTranspose;
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
                 * 鼓组事件绝不能沿用"当前乐器"的增益：鼓组音色自带 `DRUM_SPECS.gain`
                 * 标定（kick 1.0、hat 0.45、shaker 0.4…），而 `instruments.get('default')`
                 * 的增益是 0.5。旧实现无条件套用乐器增益，于是**整条鼓组被压掉一半**，
                 * 且压缩程度取决于文件里恰好定义了哪些乐器 —— 加一个 `gain: 0.2`
                 * 的铺底音色会让底鼓一起变轻，用户完全无从理解。
                 * 这里让鼓组以 1.0 为基线（音色自身的标定即最终电平），
                 * 只受力度、轨道增益与人性化影响。
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

                scheduledEvents.push({
                    time: finalTime,
                    freq,
                    duration,
                    wave: inst?.wave ?? 'sine',
                    envelope: inst?.envelope ?? { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2 },
                    filter,
                    filterEnvelope: inst?.filterEnvelope,
                    filterEnvAmount: inst?.filterEnvAmount,
                    lfo: inst?.lfo,
                    pan: clamp(clamp(expr.pan ?? inst?.pan ?? 0, -1, 1, 0) + trackPan, -1, 1, 0),
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
                });

                /**
                 * 尾音长度必须与合成器的实际发声长度一致。
                 *
                 * 合成器把振荡器停在 `t + duration + release + 0.1`，鼓组则停在
                 * `t + decay + 0.15`（其中 decay 可被 hit 的时值或 decay 参数改变）。
                 * 旧实现只按 `duration + release` 累加，于是**所有鼓组尾音都被漏算**：
                 * 一段只有 `hit("crash","4n")` 的曲子总时长不到 1 秒，
                 * 而 crash 的音色衰减有 1.9 秒 —— 离线导出会把镲片硬生生切掉。
                 */
                let tail: number;
                if (isDrum) {
                    const spec = DRUM_SPECS[overrides?.drum as DrumName];
                    const natural = spec ? spec.decay : 0.3;
                    const scaled = natural * (overrides?.drumDecay ?? 1);
                    const gated = duration > 0 ? Math.min(scaled, Math.max(duration, 0.01)) : scaled;
                    tail = gated + 0.15;
                } else {
                    tail = (inst?.envelope?.delay ?? 0) + duration + (inst?.envelope?.release ?? 0.2) + 0.1;
                }
                const end = finalTime + tail;
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
                            pushEvent(
                                currentTime + i * perNote,
                                freqOf(pitch, c),
                                dur * gate,
                                c
                            );
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
                        let pool: string[] = [];
                        for (let o = 0; o < octaves; o++) {
                            for (const p of a.pitches) {
                                pool.push(o === 0 ? p : this.transposeName(p, o * 12));
                            }
                        }

                        /**
                         * `up` / `down` 是**音高**顺序，不是书写顺序。
                         * 旧实现直接按下标升/降序返回，于是 `["C3","G3","Eb3","Bb3"]`
                         * 的 up 出来是 131 196 156 233 —— 听感上根本不是上行琶音，
                         * 且与 `asPlayed` 完全等价，等于 pattern 参数失效。
                         * 这里按实际音高排序，asPlayed 才保留书写顺序。
                         */
                        if (a.pattern !== 'asPlayed' && a.pattern !== 'random') {
                            const base = [...a.pitches].sort((x, y) => getMidi(x) - getMidi(y));
                            const sorted: string[] = [];
                            for (let o = 0; o < octaves; o++) {
                                for (const p of base) {
                                    sorted.push(o === 0 ? p : this.transposeName(p, o * 12));
                                }
                            }
                            pool = sorted;
                        }

                        // 扫描序列（与书写顺序无关的显式索引表）
                        const order = this.arpOrder(pool.length, a.pattern);
                        const steps = Math.max(1, Math.floor(totalDur / stepDur));
                        const gate = clamp(a.gate ?? 0.9, 0, 4, 0.9);

                        for (let i = 0; i < steps; i++) {
                            const idx = a.pattern === 'random'
                                ? Math.floor(rand() * pool.length)
                                : order[i % order.length];
                            const pitch = pool[idx % pool.length];
                            if (!pitch) continue;
                            pushEvent(
                                currentTime + i * stepDur,
                                freqOf(pitch, a),
                                stepDur * gate,
                                a
                            );
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
                            let pool: string[] = [];
                            for (let o = 0; o < octaves; o++) {
                                for (const pitch of chord) {
                                    pool.push(o === 0 ? pitch : this.transposeName(pitch, o * 12));
                                }
                            }

                            /**
                             * 和弦符号写出来的和弦默认是"齐奏"，`pattern` 一旦不是
                             * asPlayed 就按琶音方式把和弦音依次奏出 ——
                             * 这让 `progression(..., pattern="up")` 直接得到分解和弦伴奏，
                             * 不必再手写一长串 note。
                             */
                            if (p.pattern === 'asPlayed') {
                                pool.forEach((pitch, i) => {
                                    pushEvent(
                                        currentTime + i * perNote,
                                        freqOf(pitch, p),
                                        dur * gate,
                                        p
                                    );
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
                                    pushEvent(
                                        currentTime + i * stepDur,
                                        freqOf(pitch, p),
                                        stepDur * gate,
                                        p
                                    );
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

        /* ------------------------------ 主循环 -------------------------------- */
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
                        0,
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
                cursor += scheduleSequence(seq.name, cursor, 1, 0, 0, `solo:${seqIndex++}`);
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
                return idx;
            case 'up':
            default:
                return idx;
        }
    }

    /** 音名移调（半音数），用于 arp 跨八度 */
    private transposeName(pitch: string, semitones: number): string {
        const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const midi = getMidi(pitch) + semitones;
        const octave = Math.floor(midi / 12) - 1;
        return `${names[((midi % 12) + 12) % 12]}${octave}`;
    }
}
