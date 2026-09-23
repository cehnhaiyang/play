
import {
    InstrumentDef, SequenceDef, EffectDef, Envelope, FilterDef, LFODef,
    ExpandedOscillatorType, SequenceCommand, MixTrack, FilterKind,
    EnvelopeCurve, ArpPattern, DrumName, NoteExpression, EffectType, LFOTarget,
} from '../../../meta';
import { parseDuration, getMidi } from '../utils';
import { getPreset } from './presets';

export interface ParseResult {
    instruments: Map<string, InstrumentDef>;
    sequences: Map<string, SequenceDef>;
    effects: EffectDef[];
    mix: MixTrack[];
    tempo: number;
    masterVolumeConfig: number;
}

/* -------------------------------------------------------------------------- */
/*                                  常量白名单                                  */
/* -------------------------------------------------------------------------- */

const OSC_WAVES: ExpandedOscillatorType[] = [
    'sine', 'square', 'sawtooth', 'triangle',
    'white_noise', 'pink_noise', 'brown_noise', 'custom',
];
/** FM 调制器与 LFO 只能是真正的振荡器波形（噪声由合成器另行处理） */
const NOISE_WAVES = ['white_noise', 'pink_noise', 'brown_noise'];
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

const DEFAULT_ENVELOPE: Envelope = { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2 };

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
                const v = parseFloat(this.unquote(named[k]));
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

    private bool(named: Record<string, string>, keys: string[], fallback: boolean): boolean {
        for (const k of keys) {
            if (named[k] !== undefined) {
                const v = this.unquote(named[k]).toLowerCase();
                return v === 'true' || v === '1' || v === 'yes' || v === 'on';
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

                        // 单行多字段：`{ wave: "sine" gain: 0.5 }` 的值必须以
                        // 下一个键名为界，否则 wave 会把 `gain: 0.5` 一起吞掉。
                        // 只在空白之后、且确实构成 `标识符[:=]` 时才断开，
                        // 这样 `envelope: adsr(...)` 里的内容（深度>0）不受影响。
                        if (vDepth === 0 && j > valueStart && /\s/.test(p)) {
                            const ahead = body.slice(j);
                            const isNextKey = /^[A-Za-z_]\w*\s*[:=]/.test(ahead)
                                // 排除 `==` / `<=` 之类的比较写法
                                && !/^[A-Za-z_]\w*\s*[=!<>]=/.test(ahead);
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
        const v = parseFloat(raw);
        if (!Number.isFinite(v)) {
            throw new SPGError(`${ctx}: 参数 ${key} 需要数字（收到 "${raw}"）`, line);
        }
        return v;
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
        const p = positional.map((v) => parseFloat(this.unquote(v)));
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
        switch (kind) {
            case 'adsr':
                env = {
                    attack: pick(0, ['a', 'attack'], 0.01),
                    decay: pick(1, ['d', 'decay'], 0.1),
                    sustain: pick(2, ['s', 'sustain'], 0.7),
                    release: pick(3, ['r', 'release'], 0.2),
                };
                break;
            case 'ad':
                env = {
                    attack: pick(0, ['a', 'attack'], 0.01),
                    decay: pick(1, ['d', 'decay'], 0.3),
                    sustain: 0, release: pick(1, ['d', 'decay'], 0.3) * 0.5,
                };
                break;
            case 'ar':
                env = {
                    attack: pick(0, ['a', 'attack'], 0.05),
                    decay: 0.01, sustain: 1,
                    release: pick(1, ['r', 'release'], 0.4),
                };
                break;
            case 'perc':
                env = {
                    attack: pick(0, ['a', 'attack'], 0.001),
                    decay: pick(1, ['d', 'decay'], 0.3),
                    sustain: 0, release: pick(2, ['r', 'release'], 0.15),
                };
                break;
            default:
                throw new SPGError(
                    `${ctx}: 未知包络类型 "${kind}"。可用：adsr / ad / ar / perc`, line
                );
        }

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
        const p = positional.map((v) => parseFloat(this.unquote(v)));

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
        const p = positional.map((v) => parseFloat(this.unquote(v)));

        const frequency = named.freq !== undefined || named.frequency !== undefined
            ? this.num(named, ['freq', 'frequency'], 5, ctx, line)
            : (Number.isFinite(p[0]) ? p[0] : 5);
        const amount = named.amount !== undefined
            ? this.num(named, ['amount'], 10, ctx, line)
            : (Number.isFinite(p[1]) ? p[1] : 10);
        // target 是枚举字符串，不能走 parseFloat；位置写法取原始第三个参数
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
            swell: this.bool(named, ['swell'], false),
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
            const { positional, named } = this.parseArgs(m[2]);
            const p = positional.map((v) => parseFloat(this.unquote(v)));
            const num = (keys: string[], fallback: number, idx2: number): number => {
                if (keys.some((k) => named[k] !== undefined)) {
                    return this.num(named, keys, fallback, `${ctx} ${name}`, lineNo);
                }
                return Number.isFinite(p[idx2]) ? p[idx2] : fallback;
            };
            /** 时值参数既接受数字也接受 4n/250ms 这类记号 */
            const durArg = (keys: string[], idx2: number, fallback: string): number => {
                if (keys.some((k) => named[k] !== undefined)) {
                    return parseDuration(this.unquote(this.str(named, keys, fallback)), tempo);
                }
                if (Number.isFinite(p[idx2])) return p[idx2];
                return parseDuration(fallback, tempo);
            };

            switch (name) {
                case 'delay':
                case 'pingpong':
                    effects.push({
                        type: 'delay',
                        time: durArg(['time', 'delay'], 0, '0.3'),
                        feedback: num(['feedback', 'fb'], 0.3, 1),
                        mix: num(['mix'], 0.4, 2),
                        damping: num(['damping', 'tone'], 2000, 3),
                        pingPong: name === 'pingpong' || this.bool(named, ['pingpong', 'ping_pong'], false),
                    });
                    break;

                case 'reverb':
                    effects.push({
                        type: 'reverb',
                        decay: num(['decay', 'size'], 2.0, 0),
                        mix: num(['mix'], 0.3, 1),
                        preDelay: num(['predelay', 'pre_delay'], 0.01, 2),
                        damping: num(['damping', 'tone'], 5000, 3),
                    });
                    break;

                case 'distortion':
                case 'overdrive':
                    effects.push({
                        type: 'distortion',
                        amount: name === 'overdrive'
                            ? num(['amount', 'drive'], 0.15, 0)
                            : num(['amount', 'drive'], 0.5, 0),
                        mix: num(['mix'], 1, 1),
                    });
                    break;

                case 'bitcrush':
                    effects.push({
                        type: 'bitcrush',
                        bits: Math.max(1, Math.min(16, num(['bits', 'depth'], 8, 0))),
                        mix: num(['mix'], 1, 1),
                    });
                    break;

                case 'chorus':
                    effects.push({
                        type: 'chorus',
                        rate: num(['rate', 'speed'], 1.5, 0),
                        depth: num(['depth'], 3.5, 1),
                        mix: num(['mix'], 0.5, 2),
                    });
                    break;

                case 'flanger':
                    effects.push({
                        type: 'flanger',
                        rate: num(['rate', 'speed'], 0.3, 0),
                        feedback: num(['feedback', 'fb'], 0.6, 1),
                        mix: num(['mix'], 0.5, 2),
                    });
                    break;

                case 'phaser':
                    effects.push({
                        type: 'phaser',
                        rate: num(['rate', 'speed'], 0.5, 0),
                        min: num(['min', 'from'], 300, 1),
                        max: num(['max', 'to'], 2000, 2),
                        mix: num(['mix'], 0.6, 3),
                    });
                    break;

                case 'tremolo':
                    effects.push({
                        type: 'tremolo',
                        rate: num(['rate', 'speed'], 5, 0),
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
                        from: num(['from', 'start'], 200, 0),
                        to: num(['to', 'end'], 4000, 1),
                        Q: num(['q'], 1, 2),
                        duration: durArg(['duration', 'dur'], 3, '2'),
                        start: num(['at'], 0, 4),
                    });
                    break;

                case 'eq':
                    effects.push({
                        type: 'eq',
                        low: num(['low', 'bass'], 0, 0),
                        mid: num(['mid'], 0, 1),
                        high: num(['high', 'treble'], 0, 2),
                    });
                    break;

                default:
                    throw new SPGError(`${ctx}: 未知效果器 "${name}"`, lineNo);
            }
        });

        return effects;
    }

    /* ------------------------------ 逐音符表现力 ---------------------------- */

    private parseExpression(named: Record<string, string>, line: number, ctx: string): NoteExpression {
        const expr: NoteExpression = {};
        if (named.velocity !== undefined || named.vel !== undefined) {
            expr.velocity = Math.max(0, Math.min(1, this.num(named, ['velocity', 'vel'], 0.8, ctx, line)));
        }
        if (named.pan !== undefined) {
            expr.pan = Math.max(-1, Math.min(1, this.num(named, ['pan'], 0, ctx, line)));
        }
        if (named.gain !== undefined) {
            expr.gain = Math.max(0, this.num(named, ['gain'], 1, ctx, line));
        }
        if (named.gate !== undefined) {
            expr.gate = Math.max(0, this.num(named, ['gate'], 1, ctx, line));
        }
        if (named.transpose !== undefined) {
            expr.transpose = this.num(named, ['transpose'], 0, ctx, line);
        }
        if (named.glide !== undefined) {
            expr.glide = Math.max(0, this.num(named, ['glide'], 0, ctx, line));
        }
        if (named.detune !== undefined) {
            expr.detune = this.num(named, ['detune'], 0, ctx, line);
        }
        if (named.humanize !== undefined || named.human !== undefined) {
            expr.humanize = Math.max(0, Math.min(1, this.num(named, ['humanize', 'human'], 0, ctx, line)));
        }
        return expr;
    }

    /* -------------------------------- 主解析 -------------------------------- */

    public parse(code: string): ParseResult {
        if (typeof code !== 'string' || code.trim().length === 0) {
            throw new SPGError('代码为空', 1);
        }

        const instruments = new Map<string, InstrumentDef>();
        const sequences = new Map<string, SequenceDef>();
        let effects: EffectDef[] = [];
        let mix: MixTrack[] = [];
        let tempo = 120;
        let masterVolumeConfig = 0.6;

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

            const tempoRaw = this.fieldValue(cfg, 'tempo');
            if (tempoRaw !== null) {
                tempo = parseFloat(tempoRaw);
                if (!Number.isFinite(tempo) || tempo <= 0 || tempo > 1000) {
                    throw new SPGError(`tempo 必须在 0~1000 之间（收到 ${tempoRaw}）`, bodyLine);
                }
            }
            const volRaw = this.fieldValue(cfg, 'master_gain');
            if (volRaw !== null) {
                masterVolumeConfig = parseFloat(volRaw);
                if (!Number.isFinite(masterVolumeConfig) || masterVolumeConfig < 0) {
                    throw new SPGError(`master_gain 不能为负数（收到 ${volRaw}）`, bodyLine);
                }
                masterVolumeConfig = Math.min(2, masterVolumeConfig);
            }
        }

        /* --------------------------- 2. 乐器定义 ------------------------------- */
        const instBlocks = this.findBlocks(cleanCode, 'define_instrument', lineOf);
        for (const block of instBlocks) {
            const { named } = this.parseArgs(block.header.replace(/^\(|\)$/g, ''));
            const name = this.unquote(named.name ?? '');
            if (!name) {
                throw new SPGError('define_instrument 缺少 name 参数', block.line);
            }
            if (instruments.has(name)) {
                throw new SPGError(`乐器 "${name}" 重复定义`, block.line);
            }

            const ctx = `乐器 "${name}"`;
            const body = block.body;
            const bodyLine = lineOf(block.bodyStart);

            // 块内字段一次性扫描成「键 → 值」，避免逐字段正则互相串味
            const fields = this.parseFields(body);

            // 预设作为基线
            const presetName = this.fieldValue(fields, 'preset');
            let base: Partial<InstrumentDef> = {};
            if (presetName) {
                const loaded = getPreset(presetName);
                if (!loaded) {
                    throw new SPGError(
                        `${ctx}: 未知预设 "${presetName}"。可用预设见文档。`, bodyLine
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

            const envStr = this.fieldValue(fields, 'envelope');
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
                    .map((v) => parseFloat(v))
                    .filter((v) => Number.isFinite(v));
                if (harmonics.length === 0) {
                    throw new SPGError(`${ctx}: harmonics 数组不能为空`, bodyLine);
                }
            }

            const fmWaveRaw = this.fieldValue(fields, 'fm_wave') ?? base.fm_wave;
            const fmWave = fmWaveRaw
                ? this.enum_(fmWaveRaw, OSC_WAVES, `${ctx} fm_wave`, bodyLine)
                : undefined;

            const pickNum = (key: string, baseVal: number | undefined, fallback?: number): number | undefined => {
                const v = this.fieldNumber(fields, key, ctx, bodyLine);
                if (v !== null) return v;
                if (baseVal !== undefined) return baseVal;
                return fallback;
            };

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
                fm_ratio: pickNum('fm_ratio', base.fm_ratio),
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
            const { named } = this.parseArgs(block.header.replace(/^\(|\)$/g, ''));
            const seqName = this.unquote(named.name ?? '');
            if (!seqName) throw new SPGError('sequence 缺少 name 参数', block.line);
            if (sequences.has(seqName)) {
                throw new SPGError(`音序 "${seqName}" 重复定义`, block.line);
            }

            const instrumentName = named.instrument ? this.unquote(named.instrument) : 'default';
            const ctx = `音序 "${seqName}"`;

            // 只有真正含 note/chord/arp 的音序才需要乐器；
            // 纯 hit 的鼓组音序不需要任何乐器定义。
            const bodyHasPitched = /\b(note|chord|arp)\s*\(/.test(block.body);
            if (bodyHasPitched && !instruments.has(instrumentName) && instrumentName !== 'default') {
                throw new SPGError(
                    `${ctx} 引用了未定义的乐器 "${instrumentName}"`, block.line
                );
            }

            const commands: SequenceCommand[] = [];
            const bodyAbsStart = block.bodyStart;
            const statements = this.splitStatements(block.body);

            statements.forEach(({ text: line, offset }) => {
                const lineNo = lineOf(bodyAbsStart + offset);

                const call = line.match(/^(\w+)\s*\(([\s\S]*)\)\s*$/);
                if (!call) {
                    throw new SPGError(
                        `${ctx}: 无法解析的指令 "${line}"（应为 note(...) / chord(...) / arp(...) / hit(...) / rest(...)）`,
                        lineNo
                    );
                }
                const cmdName = call[1].toLowerCase();
                const { positional, named } = this.parseArgs(call[2]);
                const expr = this.parseExpression(named, lineNo, ctx);

                switch (cmdName) {
                    case 'note': {
                        const pitch = this.unquote(positional[0] ?? '');
                        const duration = this.unquote(positional[1] ?? '');
                        if (!pitch) throw new SPGError(`${ctx}: note 缺少音高参数`, lineNo);
                        if (!duration) throw new SPGError(`${ctx}: note("${pitch}") 缺少时值参数`, lineNo);
                        this.validatePitch(pitch, ctx, lineNo);
                        this.validateDuration(duration, tempo, ctx, lineNo);
                        commands.push({ type: 'note', pitch, duration, ...expr });
                        break;
                    }

                    case 'chord': {
                        const arrRaw = positional.find((a) => a.trim().startsWith('['));
                        if (!arrRaw) throw new SPGError(`${ctx}: chord 需要一个音高数组，如 chord(["C4","E4","G4"], "2n")`, lineNo);
                        const pitches = this.parseArray(arrRaw);
                        if (pitches.length === 0) throw new SPGError(`${ctx}: chord 的音高数组为空`, lineNo);
                        pitches.forEach((p) => this.validatePitch(p, ctx, lineNo));
                        const durIdx = positional.indexOf(arrRaw) + 1;
                        const duration = this.unquote(positional[durIdx] ?? '');
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
                        // 音高数组可作第一个位置参数，也可用 chord= / notes= 具名传入
                        const arrIdx = positional.findIndex((a) => a.trim().startsWith('['));
                        const arrRaw = arrIdx >= 0 ? positional[arrIdx] : null;
                        if (arrRaw) pitches = this.parseArray(arrRaw);
                        else if (named.chord) pitches = this.parseArray(named.chord);
                        else if (named.notes) pitches = this.parseArray(named.notes);
                        if (pitches.length === 0) {
                            throw new SPGError(`${ctx}: arp 需要 chord=[...] 音高数组`, lineNo);
                        }
                        pitches.forEach((p) => this.validatePitch(p, ctx, lineNo));

                        // 位置参数依次为 [数组, pattern, rate, duration]，
                        // 从数组所在位置往后取，避免把 pattern 误当成时值
                        const rest = arrIdx >= 0 ? positional.slice(arrIdx + 1) : positional;

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

                    case 'hit': {
                        const drumRaw = this.unquote(positional[0] ?? '');
                        if (!drumRaw) throw new SPGError(`${ctx}: hit 缺少鼓组名，如 hit("kick", "4n")`, lineNo);
                        const drum = this.enum_(drumRaw, DRUM_NAMES, `${ctx} 鼓组`, lineNo);
                        const duration = this.unquote(positional[1] ?? '8n');
                        this.validateDuration(duration, tempo, ctx, lineNo);
                        commands.push({ type: 'hit', drum, duration, ...expr });
                        break;
                    }

                    case 'rest': {
                        const duration = this.unquote(positional[0] ?? named.duration ?? '');
                        if (!duration) throw new SPGError(`${ctx}: rest 缺少时值参数`, lineNo);
                        this.validateDuration(duration, tempo, ctx, lineNo);
                        commands.push({ type: 'rest', duration });
                        break;
                    }

                    default:
                        throw new SPGError(
                            `${ctx}: 未知指令 "${call[1]}"。可用：note / chord / arp / hit / rest`, lineNo
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
                gain: named.gain !== undefined ? this.num(named, ['gain'], 1, ctx, block.line) : 1,
                transpose: named.transpose !== undefined ? this.num(named, ['transpose'], 0, ctx, block.line) : 0,
                humanize: named.humanize !== undefined
                    ? Math.max(0, Math.min(1, this.num(named, ['humanize'], 0, ctx, block.line)))
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
                const source = this.unquote(named.source ?? named.seq ?? positional[0] ?? '');
                if (!source) throw new SPGError('mix: track 缺少 source 参数', lineNo);
                if (!sequences.has(source)) {
                    throw new SPGError(`mix: 引用了未定义的音序 "${source}"`, lineNo);
                }
                const timeRaw = named.time !== undefined ? this.unquote(named.time) : (positional[1] ? this.unquote(positional[1]) : '0');
                const loop = named.loop !== undefined
                    ? Math.max(0, Math.round(this.num(named, ['loop', 'repeat'], 1, 'mix track', lineNo)))
                    : 1;
                mix.push({
                    source,
                    time: parseDuration(timeRaw, tempo),
                    loop,
                    gain: named.gain !== undefined ? this.num(named, ['gain'], 1, 'mix track', lineNo) : 1,
                    pan: named.pan !== undefined
                        ? Math.max(-1, Math.min(1, this.num(named, ['pan'], 0, 'mix track', lineNo)))
                        : 0,
                    stagger: named.stagger !== undefined
                        ? parseDuration(this.unquote(named.stagger), tempo)
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

        return { instruments, sequences, effects, mix, tempo, masterVolumeConfig };
    }
}
