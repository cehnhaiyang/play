
import {
    InstrumentDef, SequenceDef, EffectDef, Envelope, FilterDef, LFODef,
    ExpandedOscillatorType, SequenceCommand, MixTrack, FilterKind,
    EnvelopeCurve, ArpPattern, DrumName, NoteExpression, EffectType, LFOTarget,
    ProgressionCommand, RunCommand,
} from '../../../meta';
import { parseDuration, getMidi } from '../utils';
import { getPreset, PRESET_NAMES } from './presets';
import {
    parseChordSymbol, voicingToPitches, VoicingStyle, CHORD_QUALITY_NAMES,
} from './chords';

/** 非致命提示。代码能编译，但某些写法大概率不是作者本意 */
export interface SPGWarning {
    message: string;
    line: number;
}

export interface ParseResult {
    instruments: Map<string, InstrumentDef>;
    sequences: Map<string, SequenceDef>;
    effects: EffectDef[];
    mix: MixTrack[];
    tempo: number;
    masterVolumeConfig: number;
    /** 调性（如 C / Am / F#），供 LLM 自查与 UI 显示 */
    key: string;
    /** 音阶类型 */
    scale: string;
    /** 摇摆量 0~1 */
    swing: number;
    /** 编译过程中收集的非致命提示 */
    warnings: SPGWarning[];
}

/* -------------------------------------------------------------------------- */
/*                                  常量白名单                                  */
/* -------------------------------------------------------------------------- */

const OSC_WAVES: ExpandedOscillatorType[] = [
    'sine', 'square', 'sawtooth', 'triangle',
    'white_noise', 'pink_noise', 'brown_noise', 'custom',
];
/** FM 调制器与 LFO 只能是真正的振荡器波形（见 LFO_WAVES；噪声由合成器另行处理） */
const LFO_WAVES: OscillatorType[] = ['sine', 'square', 'sawtooth', 'triangle'];
const LFO_TARGETS: LFOTarget[] = ['frequency', 'filter', 'gain', 'pan', 'detune'];
const FILTER_KINDS: FilterKind[] = [
    'lowpass', 'highpass', 'bandpass', 'notch',
    'lowshelf', 'highshelf', 'peaking', 'allpass',
];
const ENVELOPE_CURVES: EnvelopeCurve[] = ['linear', 'exp', 'hold'];
const ARP_PATTERNS: ArpPattern[] = ['up', 'down', 'upDown', 'downUp', 'asPlayed', 'random'];
const DRUM_NAMES: DrumName[] = [
    'kick', 'sub_kick', 'snare', 'rim', 'clap',
    'hat', 'open_hat', 'pedal_hat',
    'tom_low', 'tom_mid', 'tom_high',
    'crash', 'ride', 'cowbell', 'shaker', 'tambourine',
];
const EFFECT_NAMES: EffectType[] = [
    'delay', 'pingpong', 'reverb', 'distortion', 'bitcrush', 'overdrive',
    'filter', 'eq', 'chorus', 'flanger', 'phaser', 'tremolo', 'compressor',
];

/** 和弦声位风格 */
const VOICING_STYLES: VoicingStyle[] = ['close', 'open', 'drop2', 'spread'];
/** 和弦符号可用的根音字母（用于把裸音名与和弦符号区分开） */
const CHORD_ROOT_LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
/** 调式音阶白名单 */
const SCALE_NAMES = [
    'major', 'minor', 'harmonic_minor', 'melodic_minor',
    'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian',
    'major_pentatonic', 'minor_pentatonic', 'blues', 'chromatic',
    'whole_tone',
];

const DEFAULT_ENVELOPE: Envelope = { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2 };

/**
 * 效果器的规范参数名。
 *
 * 用途是"参数名纠错"：模型很自然会写出 `delay(delay=0.25)`、`reverb(size=2)`
 * 这类同义写法，其中 `size` 本来就支持，但 `delay(...)` 里的 `delay`
 * 会被当成未知参数**静默忽略**，于是"延迟 0.25 秒"变成"默认 0.3 秒"，
 * 用户听到的结果与描述不符却没有任何报错。这里把它纠正并给出提示。
 */
const EFFECT_PARAM_ALIASES: Record<string, Record<string, string>> = {
    delay: { delay: 'time', fb: 'feedback', tone: 'damping', ping_pong: 'pingpong' },
    pingpong: { delay: 'time', fb: 'feedback', tone: 'damping', ping_pong: 'pingpong' },
    reverb: { size: 'decay', pre_delay: 'pre_delay', tone: 'damping' },
    distortion: { drive: 'amount', gain: 'amount' },
    overdrive: { drive: 'amount', gain: 'amount' },
    bitcrush: { depth: 'bits' },
    chorus: { speed: 'rate' },
    flanger: { speed: 'rate', fb: 'feedback' },
    phaser: { speed: 'rate', from: 'min', to: 'max' },
    tremolo: { speed: 'rate' },
    filter: { start: 'from', end: 'to', dur: 'duration', at: 'start' },
    eq: { bass: 'low', treble: 'high' },
    compressor: {},
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

/* -------------------------------------------------------------------------- */
/*                                  错误类型                                    */
/* -------------------------------------------------------------------------- */

/** 带行号的解析错误。引擎读取 `line` 以在编辑器里定位。 */
export class SPGError extends Error {
    public line: number;
    constructor(message: string, line: number) {
        super(message);
        this.name = 'SPGError';
        this.line = line;
    }
}

/* -------------------------------------------------------------------------- */
/*                                   解析器                                     */
/* -------------------------------------------------------------------------- */

export class SPGParser {
    /** 本次解析收集到的提示，`parse()` 开始时清空 */
    private warnings: SPGWarning[] = [];

    private warn(message: string, line: number): void {
        this.warnings.push({ message, line });
    }

    /* ------------------------------ 文本预处理 ------------------------------ */

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

    /* ------------------------------ 结构化扫描 ------------------------------ */

    /**
     * 找到所有 `keyword(...) { body }` 结构。
     * 使用括号配对扫描而非正则 —— 正则的 `[^}]+` 会在块内出现嵌套花括号
     * （例如乐器里内嵌 `effect_chain { ... }`）时提前截断。
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
            // 跳过空白
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
     * 把块体切成一条条独立语句。
     *
     * 分隔依据有三类，缺一不可：
     * 1. 分号 `;`
     * 2. 换行
     * 3. **右括号后紧跟新的调用** —— 形如 `hit("kick","4n") hit("hat","4n")`
     *    这种同行连写很常见（尤其是模型输出），只按换行/分号切会把它当成一条
     *    畸形语句，报出"无法解析的时值"这类牛头不对马嘴的错误。
     *
     * 返回每段语句及其在块体内的偏移，用于计算准确行号。
     */
    private splitStatements(body: string): { text: string; offset: number }[] {
        const out: { text: string; offset: number }[] = [];
        let depth = 0;
        let inSingle = false;
        let inDouble = false;
        let start = 0;
        let current = '';

        /**
         * 收尾一段语句。
         * 必须剥掉尾部的语句分隔符（`;`）—— 旧实现把 `;` 一起留在文本里，
         * 于是 `note("C4","4n");` 送进 `^(\w+)\s*\(...\)\s*$` 匹配失败，
         * 报出"无法解析的指令"。分号是最常见的合法写法，却 100% 编译失败。
         */
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

            if (isSeparator) {
                flush(j);
                i = j - 1;
            } else if (startsNewCall) {
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
     * `parseFloat("0.5x")` 会静默读成 0.5 —— 拼写错误变成有效值，
     * 用户听到的不是自己写的，却拿不到任何反馈（与未知参数静默忽略同类）。
     * 这里用 Number 做全字匹配：非法返回 NaN，调用方按原有逻辑报错。
     * 空串与十六进制同样拒绝（Number('') === 0 会吞掉 `gain=` 这类空值）。
     */
    private strictFloat(raw: string): number {
        const t = this.unquote(raw).trim();
        if (!t || /^0x/i.test(t)) return NaN;
        return Number(t);
    }

    /**
     * 解析参数列表为「位置参数 + 具名参数」。
     * 支持 `name="x"`、`freq=200`、`chord=["C4","E4"]` 与裸位置值。
     */
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

    /** 统计字符串中的换行数，用于把块内偏移换算成行号 */
    private countNewlines(str: string): number {
        let n = 0;
        for (let i = 0; i < str.length; i++) if (str[i] === '\n') n++;
        return n;
    }

    /** 解析数组字面量 `["C4", "E4"]` 或 `[1, 2, 3]` */
    private parseArray(str: string): string[] {
        const t = str.trim();
        const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
        return this.splitTopLevel(inner, ',').map((v) => this.unquote(v));
    }

    /* ------------------------------ 参数取值助手 ---------------------------- */

    /**
     * 校验音名，失败时抛出带行号的 SPGError。
     * 底层的 getMidi 抛的是普通 Error，直接冒泡会让行号丢失（引擎只能报 line 0），
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

    private bool(named: Record<string, string>, keys: string[], fallback: boolean, ctx = '', line = 0): boolean {
        for (const k of keys) {
            if (named[k] !== undefined) {
                const v = this.unquote(named[k]).toLowerCase();
                if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
                if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
                // 拼错的布尔值不能静默当 false：`accent=maybe` 本意是重音，
                // 按旧逻辑会安静地演奏成普通力度。
                throw new SPGError(
                    `${ctx}: 参数 ${k} 需要布尔值（true / false），收到 "${named[k]}"`, line
                );
            }
        }
        return fallback;
    }

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

    /* ---------------------------- 块内字段扫描 ------------------------------ */

    /**
     * 把 `define_instrument` 的块体解析成「键 → 原始值文本」。
     *
     * 旧实现用 `new RegExp(key + '\\s*[:=]\\s*...')` 逐个字段去匹配，有三个致命问题：
     *
     * 1. **键名边界泄漏**：`body.match(/wave\s*[:=]\s*"([^"]*)"/)` 会命中 `fm_wave` 里的
     *    `wave`，于是写了 `fm_wave: "triangle"` 的乐器主波形被悄悄改成 triangle。
     *    同理 `filter` 会命中 `filter_envelope`，导致振幅包络被滤波包络整体替换。
     * 2. **只认引号值**：旧 `grabStr` 只匹配 `"..."`，而 `envelope: adsr(0.1,0.2,0.6,0.4)`
     *    这种不带引号的写法（文档与示例都在用）会被完全忽略，参数静默失效。
     * 3. **无法处理跨行值**：`harmonics: [\n 1, 0.5\n]` 这类写法匹配不到。
     *
     * 这里改成一次带括号深度的线性扫描：只在深度 0 处识别 `键 : 值` 或 `键 = 值`，
     * 值延伸到同深度的换行/分号/块尾。嵌套的 `effect_chain { ... }` 内部因此被整体跳过，
     * 不会把 `delay(time=..., feedback=...)` 里的具名参数误当成乐器字段。
     */
    private parseFields(body: string): Map<string, string> {
        const fields = new Map<string, string>();
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

            // 只在顶层识别键名，且键名必须从左边界开始（行首/空白/分隔符之后）
            const atBoundary = i === 0 || /[\s;]/.test(prev);
            if (depth === 0 && atBoundary) {
                const m = /^([A-Za-z_]\w*)\s*([:=])\s*/.exec(body.slice(i));
                if (m) {
                    const key = m[1].toLowerCase();
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
                         * 单行多字段：`{ wave: "sine" gain: 0.5 }` 的值必须以
                         * 下一个键名为界，否则 wave 会把 `gain: 0.5` 一起吞掉。
                         *
                         * 旧实现只在「当前字符是空白、且前一个字符也是空白」时才检查，
                         * 而 `"sawtooth" effect_chain { ... }` 里的空格前面是引号，
                         * 于是这个边界永远不会被识别 —— 值一路吞到行尾，
                         * 最终 wave 收到 `"sawtooth" effect_chain { distortion(...) }`
                         * 这种拼接串并抛出"不是合法取值"。
                         * 单行写 `wave: "..." effect_chain { ... }` 的乐器因此完全无法定义。
                         *
                         * 改为在每个字符处都检查是否已走到下一个 `键:` / `键=`，
                         * 这样无论值是什么形态（引号、数字、函数调用）都能正确断开。
                         */
                        if (vDepth === 0 && j > valueStart) {
                            // 允许键名之前有空白：`wave: "sawtooth" effect_chain { ... }`
                            // 里下一个键名前面就是一个空格
                            const ahead = body.slice(j).replace(/^\s+/, '');
                            /**
                             * 值在顶层遇到下列三种情况即结束：
                             * 1. 下一个 `键:` / `键=`
                             * 2. 嵌套块 `关键字(...) {`（如单行写 `wave: "x" effect_chain { ... }`）
                             * 3. 顶层逗号（`fm_wave:"sine", fm_ratio:3.5` 这类写法）
                             * 排除 `==` / `<=` 之类的比较写法，避免误判。
                             */
                            const isNextKey = (/^[A-Za-z_]\w*\s*[:=]/.test(ahead)
                                && !/^[A-Za-z_]\w*\s*[=!<>]=/.test(ahead))
                                || /^[A-Za-z_]\w*\s*(\([^()]*\))?\s*\{/.test(ahead)
                                || ahead.startsWith(',');
                            if (isNextKey) break;
                        }
                    }

                    const raw = body.slice(valueStart, j).trim();
                    // 同名键后写覆盖先写，与"后写优先"的直觉一致
                    fields.set(key, raw);
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
     */
    private fieldValue(fields: Map<string, string>, key: string): string | null {
        const v = fields.get(key.toLowerCase());
        if (v === undefined) return null;
        const t = v.trim();
        return t.length > 0 ? this.unquote(t) : null;
    }

    /** 取数值字段；缺失返回 null，非数字抛带行号的错误 */
    private fieldNumber(
        fields: Map<string, string>, key: string, ctx: string, line: number
    ): number | null {
        const raw = this.fieldValue(fields, key);
        if (raw === null) return null;
        const v = this.strictFloat(raw);
        if (!Number.isFinite(v)) {
            throw new SPGError(`${ctx}: 参数 ${key} 需要数字（收到 "${raw}"）`, line);
        }
        return v;
    }

    /**
     * 拒绝未知的具名参数。
     *
     * 旧实现对所有未知参数一律静默忽略，于是 `note("C4","4n", velo=0.5)`
     * （`velocity` 拼错）会安静地按默认力度演奏，`reverb(damp=3000)`
     * 会安静地用默认阻尼 —— 用户听到的不是自己写的，却拿不到任何反馈。
     * 这类"看起来生效其实没生效"的写法是 LLM 生成代码里最难排查的错误，
     * 因此这里直接报错，并把合法参数名列出来供模型自我纠正。
     */
    private rejectUnknownParams(
        named: Record<string, string>, allowed: readonly string[], ctx: string, line: number
    ): void {
        for (const key of Object.keys(named)) {
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

    /* ------------------------------ 包络 / 滤波 / LFO ----------------------- */

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

        this.rejectUnknownParams(named, [...allowed, 'curve', 'delay'], `${ctx} 包络 ${kind}()`, line);

        env.curve = named.curve
            ? this.enum_(this.unquote(named.curve), ENVELOPE_CURVES, `${ctx} curve`, line)
            : 'exp';
        env.delay = named.delay !== undefined ? this.num(named, ['delay'], 0, ctx, line) : 0;

        // 合法性校验：负时间会让自动化时间点倒流
        for (const [k, v] of Object.entries(env)) {
            if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) {
                throw new SPGError(`${ctx}: 包络参数 ${k} 不能为负数（${v}）`, line);
            }
        }
        if (env.sustain > 1) env.sustain = 1;
        return env;
    }

    /** 解析滤波器表达式 */
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
            named,
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
        const type = this.enum_(m[1], LFO_WAVES, `${ctx} LFO 波形`, line);
        const { positional, named } = this.parseArgs(m[2]);
        const p = positional.map((v) => this.strictFloat(v));

        this.rejectUnknownParams(
            named, ['freq', 'frequency', 'amount', 'target', 'ramp', 'swell'],
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

    /* -------------------------------- 效果链 -------------------------------- */

    private parseEffects(body: string, tempo: number, baseLine: number, ctx: string): EffectDef[] {
        const effects: EffectDef[] = [];
        // 效果器同样允许同行连写，复用统一的语句切分
        const statements = this.splitStatements(body);

        statements.forEach(({ text: line, offset }) => {
            const lineNo = baseLine + this.countNewlines(body.slice(0, offset));

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
            this.rejectUnknownParams(named, EFFECT_PARAMS[name] ?? [], `${ctx} ${name}()`, lineNo);

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

    /* ------------------------------ 逐音符表现力 ---------------------------- */

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
            named,
            [...SPGParser.NOTE_EXPR_PARAMS, ...extraParams],
            ctx, line
        );

        /**
         * `reserved` 里的键由调用方自己消费，这里不再当作表现力参数解释。
         *
         * 典型冲突是 `octave`：在 `chord("Am7","1n", octave=3)` 里它是
         * "和弦发在第几八度"（声位寄存器），在 `note("C4","4n", octave=1)` 里
         * 它是"升高一个八度"。若两边都解释，chord 的 octave=3 会同时把整组音
         * 再升高 36 个半音，和弦直接飞到听不见的高频。
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

    /* --------------------------- 和弦符号与音高展开 -------------------------- */

    /**
     * 判断一个 token 是否"看起来像和弦符号"而不是音名。
     *
     * 目的是给出可操作的报错。`note("Am7","2n")` 在旧实现里会报
     * "无法识别的音名 Am7"，模型据此很难判断该怎么改；
     * 识别出它是和弦符号后可以直接建议 `chord("Am7","2n")`。
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
    private requireChordSymbol(text: string, ctx: string, line: number) {
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
     * 把单个 token 展开成音名数组。
     *
     * - 以 `[` 开头 → 音高数组，逐项校验
     * - 是合法音名 → 原样返回（保持向后兼容）
     * - 否则按和弦符号展开
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

    /* -------------------------------- 主解析 -------------------------------- */

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

        /* ------------------------------ 1. config ------------------------------ */
        const configBlocks = this.findBlocks(cleanCode, 'config', lineOf);
        if (configBlocks.length > 1) {
            throw new SPGError('只允许一个 config 块', configBlocks[1].line);
        }
        if (configBlocks.length === 1) {
            const body = configBlocks[0].body;
            const bodyLine = lineOf(configBlocks[0].bodyStart);
            const cfg = this.parseFields(body);

            this.rejectUnknownParams(
                Object.fromEntries(cfg), ['tempo', 'bpm', 'master_gain', 'gain', 'key', 'scale', 'swing'],
                'config', bodyLine
            );

            // bpm 是 tempo 最自然的同义写法，模型经常直接写 bpm
            const tempoRaw = this.fieldValue(cfg, 'tempo') ?? this.fieldValue(cfg, 'bpm');
            if (tempoRaw !== null) {
                tempo = this.strictFloat(tempoRaw);
                if (!Number.isFinite(tempo) || tempo <= 0 || tempo > 1000) {
                    throw new SPGError(`tempo 必须大于 0 且不超过 1000（收到 ${tempoRaw}）`, bodyLine);
                }
            }
            const volRaw = this.fieldValue(cfg, 'master_gain') ?? this.fieldValue(cfg, 'gain');
            if (volRaw !== null) {
                masterVolumeConfig = this.strictFloat(volRaw);
                if (!Number.isFinite(masterVolumeConfig) || masterVolumeConfig < 0) {
                    throw new SPGError(`master_gain 不能为负数（收到 ${volRaw}）`, bodyLine);
                }
                masterVolumeConfig = Math.min(2, masterVolumeConfig);
            }
            const keyRaw = this.fieldValue(cfg, 'key');
            if (keyRaw !== null) {
                if (!/^[A-Ga-g][#b♯♭]?m?$/.test(keyRaw.trim())) {
                    throw new SPGError(
                        `key 必须是调性记号，如 C / Am / F# / Bbm（收到 "${keyRaw}"）`, bodyLine
                    );
                }
                key = keyRaw.trim();
            }
            const scaleRaw = this.fieldValue(cfg, 'scale');
            if (scaleRaw !== null) {
                scale = this.enum_(scaleRaw, SCALE_NAMES, 'config scale', bodyLine);
            }
            const swingRaw = this.fieldValue(cfg, 'swing');
            if (swingRaw !== null) {
                swing = this.strictFloat(swingRaw);
                if (!Number.isFinite(swing) || swing < 0 || swing > 1) {
                    throw new SPGError(`swing 必须在 0~1 之间（收到 ${swingRaw}）`, bodyLine);
                }
            }
        }

        /* --------------------------- 2. 乐器定义 ------------------------------- */
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

            // 块内字段一次性扫描成「键 → 值」，避免逐字段正则互相串味
            const fields = this.parseFields(body);

            this.rejectUnknownParams(Object.fromEntries(fields), [
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
            const presetName = this.fieldValue(fields, 'preset');
            let base: Partial<InstrumentDef> = {};
            if (presetName) {
                const loaded = getPreset(presetName);
                if (!loaded) {
                    throw new SPGError(
                        `${ctx}: 未知预设 "${presetName}"。可用预设：${PRESET_NAMES.join(' / ')}`, bodyLine
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
                    eb.body, tempo, lineOf(block.bodyStart + eb.bodyStart), ctx
                );
            }

            const waveRaw = this.fieldValue(fields, 'wave') ?? base.wave ?? 'sine';
            const wave = this.enum_(waveRaw, OSC_WAVES, `${ctx} wave`, bodyLine);

            const envStr = this.fieldValue(fields, 'envelope')
                ?? this.fieldValue(fields, 'env')
                ?? this.fieldValue(fields, 'amp_envelope');
            const envelope = (envStr ? this.parseEnvelope(envStr, ctx, bodyLine) : undefined)
                ?? base.envelope ?? DEFAULT_ENVELOPE;

            const filterStr = this.fieldValue(fields, 'filter');
            const filter = (filterStr ? this.parseFilter(filterStr, ctx, bodyLine) : undefined) ?? base.filter;

            const filterEnvStr = this.fieldValue(fields, 'filter_envelope');
            const filterEnvelope = (filterEnvStr ? this.parseEnvelope(filterEnvStr, ctx, bodyLine) : undefined)
                ?? base.filterEnvelope;

            const lfoStr = this.fieldValue(fields, 'lfo');
            const lfo = (lfoStr ? this.parseLFO(lfoStr, ctx, bodyLine) : undefined) ?? base.lfo;

            // 自定义谐波
            let harmonics = base.harmonics;
            const harmRaw = this.fieldValue(fields, 'harmonics');
            if (harmRaw !== null) {
                harmonics = this.parseArray(harmRaw)
                    .map((v) => this.strictFloat(v))
                    .filter((v) => Number.isFinite(v));
                if (harmonics.length === 0) {
                    throw new SPGError(`${ctx}: harmonics 数组不能为空`, bodyLine);
                }
            }

            const fmWaveRaw = this.fieldValue(fields, 'fm_wave') ?? base.fm_wave;
            // FM 调制器必须是真正的振荡器波形：写噪声名会在合成器被静默跳过
            // （听到的就是没 FM 的声音），写 custom 则退化成 sine —— 两种都是"写了白写"。
            const fmWave = fmWaveRaw
                ? this.enum_(fmWaveRaw, LFO_WAVES, `${ctx} fm_wave（只能是 sine / square / sawtooth / triangle）`, bodyLine)
                : undefined;

            const pickNum = (key: string, baseVal: number | undefined, fallback?: number): number | undefined => {
                const v = this.fieldNumber(fields, key, ctx, bodyLine);
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
                    + `；不需要 FM 时直接删掉 fm_wave / fm_ratio / fm_index`, bodyLine
                );
            }

            // wave: "custom" 没有内置定义：不配 harmonics 会静默退化成 sine。
            if (wave === 'custom' && harmonics === undefined) {
                throw new SPGError(
                    `${ctx}: wave "custom" 需要配合 harmonics 使用`
                    + `（如 harmonics: [1, 0.5, 0.25]），否则请写具体波形：`
                    + `sine / square / sawtooth / triangle`, bodyLine
                );
            }

            // 时长类参数为负数没有任何物理意义，合成器会静默按 0 处理 ——
            // 在这里报错，模型才能知道自己写错了。
            for (const k of ['glide', 'pitch_decay', 'loop_point']) {
                const v = this.fieldNumber(fields, k, ctx, bodyLine);
                if (v !== null && v < 0) {
                    throw new SPGError(`${ctx}: 参数 ${k} 不能为负数（收到 ${v}）`, bodyLine);
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

        /* --------------------------- 3. 全局效果链 ----------------------------- */
        // 只取顶层的 effect_chain（乐器块内的已在上一步消费）
        const topLevelEffects: EffectDef[] = [];
        const allEffectBlocks = this.findBlocks(cleanCode, 'effect_chain', lineOf);
        for (const eb of allEffectBlocks) {
            const insideInstrument = instBlocks.some(
                (ib) => eb.headerStart > ib.bodyStart && eb.headerStart < ib.bodyStart + ib.body.length
            );
            if (insideInstrument) continue;
            topLevelEffects.push(
                ...this.parseEffects(eb.body, tempo, lineOf(eb.bodyStart), 'effect_chain')
            );
        }
        effects = topLevelEffects;

        /* ----------------------------- 4. 音序 -------------------------------- */
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
                seqHeader, ['name', 'seq', 'id', 'instrument', 'inst', 'gain', 'transpose', 'humanize'],
                `sequence "${seqName}" 头部`, block.line
            );

            const instrumentName = this.unquote(seqHeader.instrument ?? seqHeader.inst ?? 'default');
            const ctx = `音序 "${seqName}"`;

            // 只有真正含音高类指令的音序才需要乐器；
            // 纯 hit 的鼓组音序不需要任何乐器定义。
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
             * 把 chord/progression 的输入统一展开成音名数组。
             *
             * 支持三种写法，覆盖模型可能产出的一切合理形式：
             * - 音名数组：`["C4","E4","G4"]`
             * - 和弦符号：`"Am7"`（引擎按声位规则展开，避免模型自己算错音程）
             * - 和弦符号数组：`["Am7","Dm7"]`
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
                        const expanded = this.expandPitchOrChord(item, voicing, octave, lineNo, ctx);
                        out.push(...expanded);
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
                        // 旧实现只认位置参数，`note(pitch="C4", duration="4n")` 直接报
                        // "缺少音高参数" —— 而具名参数恰恰是 LLM 最偏爱的写法。
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
                        // 静默当音名会报"无法识别的音名"，这里给出可操作的提示。
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
                         *
                         * 旧实现只找以 `[` 开头的参数，于是 `arp("Am7", ...)` 找不到音高来源，
                         * 直接报"arp 需要 chord=[...] 音高数组"。和弦符号是模型最自然的写法，
                         * 而错误信息又指向一种它没用过的写法，只能反复试错。
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
                         * 音高来源的优先级：具名参数 > 位置参数。
                         *
                         * 具名参数一旦给出，位置参数就全部让位给 pattern/rate/duration，
                         * 否则 `arp(chord=["C4"], "up", "16n", "1n")` 会把 `"up"`
                         * 当成和弦符号去解析并报出莫名其妙的错误。
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

                        // 位置参数依次为 [音高来源, pattern, rate, duration]，
                        // 从音高来源之后取，避免把 pattern 误当成时值
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
                        // duration/dur 曾经在白名单里但从未被消费：
                        // progression 的时值只认 beats/beat/位置参数，
                        // `duration="2n"` 会静默失效。这里删掉，写了就报错并列出可用参数。
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
                        // extraParams 白名单只收"真的会被消费"的键：
                        // from/to/octaves/scale/key 曾经在这里"合法但无用" ——
                        // 写了不报错也不生效，与未知参数静默忽略是同一类陷阱。
                        // run 的音高只来自音高数组，方向只认 direction/pattern。
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
                        // 鼓组名可以是位置参数，也可以用 drum= / name= 具名传入
                        const drumRaw = arg(['drum', 'name', 'kit'], 0) ?? '';
                        if (!drumRaw) {
                            throw new SPGError(
                                `${ctx}: hit 缺少鼓组名，如 hit("kick", "4n")。`
                                + `可用：${DRUM_NAMES.join(' / ')}`, lineNo
                            );
                        }
                        const drum = this.enum_(drumRaw, DRUM_NAMES, `${ctx} 鼓组`, lineNo);
                        const duration = arg(['duration', 'dur', 'len'], 1) ?? '8n';
                        const expr = this.parseExpression(named, lineNo, ctx, [
                            'drum', 'name', 'kit', 'tune', 'decay', 'tone', 'snap',
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
                        this.rejectUnknownParams(named, ['duration', 'dur', 'len'], `${ctx} rest()`, lineNo);
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

        /* ------------------------------ 5. mix -------------------------------- */
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
                    named, ['source', 'seq', 'track', 'time', 'at', 'loop', 'repeat', 'times',
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
                const dur = (raw: string, fallback: number): number => {
                    try {
                        return parseDuration(raw, tempo);
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        throw new SPGError(`mix track: ${msg}`, lineNo);
                    }
                };

                mix.push({
                    source,
                    time: dur(timeRaw, 0),
                    loop,
                    gain: named.gain !== undefined ? this.num(named, ['gain'], 1, 'mix track', lineNo) : 1,
                    pan: named.pan !== undefined
                        ? Math.max(-1, Math.min(1, this.num(named, ['pan'], 0, 'mix track', lineNo)))
                        : 0,
                    stagger: named.stagger !== undefined
                        ? dur(this.unquote(named.stagger), 0)
                        : 0,
                });
            });
        }

        /* --------------------------- 6. 兜底与校验 ----------------------------- */
        // 没有任何音序时给出明确的空结果而不是静默无声
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

        // 写了 mix 却漏掉某些音序，是"代码没错但没声音"最常见的原因，
        // 编译能过但用户听不到，必须提示出来
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
