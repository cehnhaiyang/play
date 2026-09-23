
import {
    InstrumentDef, SequenceDef, ScheduledEvent, ArpCommand, ChordCommand,
    NoteExpression, MixTrack, FilterDef,
} from '../../../meta';
import { getMidi, midiToFreq, parseDuration, clamp, createRandom } from '../utils';

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
        tempo: number
    ): { events: ScheduledEvent[], totalDuration: number } {

        const scheduledEvents: ScheduledEvent[] = [];
        let maxTime = 0;

        /**
         * 调度单个音序，返回其净时长。
         * 所有音高与时值在此处一次性算成绝对秒数，合成器不再做乐理换算。
         */
        const scheduleSequence = (
            seqName: string,
            startTime: number,
            trackGain: number,
            trackPan: number,
            trackTranspose: number
        ): number => {
            const seq = sequences.get(seqName);
            if (!seq) {
                throw new Error(`引用了未定义的音序 "${seqName}"`);
            }

            const inst = instruments.get(seq.instrumentName) ?? instruments.get('default');
            const rand = createRandom(hashSeed(`${seqName}:${startTime.toFixed(6)}`));

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

                const baseGain = expr.gain ?? inst?.gain ?? 0.8;
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

                const finalTime = Math.max(0, time + jitterTime);
                const detune = (expr.detune ?? inst?.detune ?? 0) + jitterPitch;

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
                    attackNoise: inst?.attackNoise ?? 0,
                    effects: inst?.effects,
                    loopPoint: inst?.loopPoint ?? 0,
                    ...overrides,
                });

                const end = finalTime + duration + (inst?.envelope?.release ?? 0.2);
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
                            { drum: cmd.drum, wave: 'sine', effects: undefined }
                        );
                        currentTime += dur;
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
            mixTracks.forEach((track) => {
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
                        0
                    );
                    // stagger 让每次循环错位叠加，可做卡农
                    currentStart += duration + stagger;
                }
            });
        } else {
            // 未写 mix 时按定义顺序首尾相接，而不是全部从 0 叠加
            let cursor = 0;
            sequences.forEach((seq) => {
                cursor += scheduleSequence(seq.name, cursor, 1, 0, 0);
            });
        }

        return { events: scheduledEvents, totalDuration: maxTime };
    }

    /** 生成琶音索引序列 */
    private arpOrder(len: number, pattern: ArpCommand['pattern']): number[] {
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
