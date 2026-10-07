import { loadJSON, saveJSON } from '../const';

/**
 * ============================================================================
 * 运行日志服务（只收渲染层）
 * ============================================================================
 *
 * 拦截渲染进程的 console.*（log/info/warn/error/debug），格式化后推进内存
 * 环形缓冲，并把最近一部分落盘，悬浮球的"运行日志"面板订阅展示。
 *
 * 主进程（torrent 引擎、下载、Edge 导入、嗅探网络层）的 console 打到终端，
 * 渲染层够不着 —— 要收必须加 IPC 转发。现在不做，LogEntry 特意留了
 * source 字段，将来合并主进程日志时直接填来源，不用改面板。
 *
 * 安装时机：index.tsx 的第一个 import，保证吃到最早的日志。
 * 模块在浏览器里 import 即自动安装（import 顺序先于任何模块顶层代码执行，
 * 只靠 index.tsx 里显式调用会漏掉各模块 import 阶段的顶层日志）。
 * Node 里（回归测试 require 编译产物）不自动安装，避免污染测试输出。
 */

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
    seq: number;
    /** Date.now() */
    ts: number;
    level: LogLevel;
    /** 格式化后的纯文本，不存原始对象（省内存、落盘小、无循环引用） */
    message: string;
    /** 日志来源：现在只有渲染层，主进程合并进来时填 'main' */
    source: 'renderer';
}

/** 内存环形缓冲上限：再多就是刷屏型 bug，面板渲染也扛不住 */
export const LOG_BUFFER_CAP = 1000;
/** 落盘只留最近这么多条：localStorage 5MB 配额下只有几十 KB */
export const LOG_PERSIST_CAP = 200;
/** 单条消息截断长度：Error 的 stack 很长，不截断一条就能撑爆落盘 */
const LOG_MESSAGE_MAX = 4000;
/** 落盘防抖：高频日志 burst 时不至于每条都写一次 localStorage */
const LOG_PERSIST_DEBOUNCE_MS = 1000;
/** 落盘键（默认命名空间 theplay.floating.，与其他悬浮球状态放一起） */
export const LOG_STORE_KEY = 'app-logs';

const LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

let installed = false;
let seq = 0;
let version = 0;
const buffer: LogEntry[] = [];
const listeners = new Set<() => void>();
let persistTimer: number | null = null;
/**
 * 重入保护：格式化/入缓冲/落盘过程中若再触发 console（比如 JSON.stringify
 * 撞上 getter 里打日志的怪对象），直接走原始方法，不再进缓冲。
 * 没有这面旗，一次怪异对象就能把调用栈撑爆。
 */
let writing = false;

const isValidEntry = (v: unknown): v is LogEntry =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as LogEntry).seq === 'number' &&
    typeof (v as LogEntry).ts === 'number' &&
    typeof (v as LogEntry).level === 'string' &&
    typeof (v as LogEntry).message === 'string';

/** 恢复上次落盘：坏数据（手改 localStorage）整批丢弃，不逐条抢救 */
const restorePersisted = (): void => {
    const saved = loadJSON<unknown>(LOG_STORE_KEY, []);
    if (!Array.isArray(saved)) return;
    const valid = saved.filter(isValidEntry).slice(-LOG_PERSIST_CAP);
    buffer.push(...valid);
    for (const e of valid) seq = Math.max(seq, e.seq);
};

const schedulePersist = (): void => {
    if (typeof window === 'undefined') return;
    if (persistTimer !== null) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
        persistTimer = null;
        saveJSON(LOG_STORE_KEY, buffer.slice(-LOG_PERSIST_CAP));
    }, LOG_PERSIST_DEBOUNCE_MS);
};

const notify = (): void => {
    version += 1;
    for (const cb of listeners) {
        try {
            cb();
        } catch {
            // 订阅回调炸了不能影响打日志本身
        }
    }
};

/** 读属性：getter 可能抛错，不能把序列化带崩 */
const readProp = (o: object, k: string): unknown => {
    try {
        return (o as Record<string, unknown>)[k];
    } catch {
        return '[Throwing getter]';
    }
};

/**
 * 循环安全的 JSON 式序列化。JSON.stringify 撞上循环引用是整串抛错，
 * 只能fallback成 [object Object]；这里逐层写，循环处记 "[Circular]"。
 * seen 用完即删（只记祖先链）：兄弟节点引用同一对象不算循环。
 */
const safeStringify = (v: unknown): string => {
    const seen = new Set<object>();
    const write = (x: unknown, depth: number): string => {
        if (x === null) return 'null';
        switch (typeof x) {
            case 'string':
                return JSON.stringify(x);
            case 'number':
                return Number.isFinite(x) ? String(x) : 'null';
            case 'bigint':
            case 'boolean':
                return String(x);
            case 'undefined':
                return 'undefined';
            case 'function':
                return `"[function ${(x as { name?: string }).name || 'anonymous'}]"`;
            case 'object': {
                if (seen.has(x)) return '"[Circular]"';
                if (depth > 8) return '"[Deep]"';
                if (x instanceof Date) return JSON.stringify(x);
                seen.add(x);
                try {
                    if (Array.isArray(x)) {
                        return `[${x.map((item) => write(item, depth + 1)).join(',')}]`;
                    }
                    const body = Object.keys(x)
                        .map((k) => `${JSON.stringify(k)}:${write(readProp(x, k), depth + 1)}`)
                        .join(',');
                    return `{${body}}`;
                } finally {
                    seen.delete(x);
                }
            }
            default:
                return '"[Unformattable]"';
        }
    };
    return write(v, 0);
};

/** 安全展开单个值：循环引用/ getter 抛错/DOM 对象都不许把格式化带崩 */
const formatValue = (v: unknown, seen: Set<object>): string => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'function') return `[function ${(v as { name?: string }).name || 'anonymous'}]`;
    if (v instanceof Error) {
        const stack = typeof v.stack === 'string' ? `\n${v.stack}` : '';
        return `${v.name}: ${v.message}${stack}`;
    }
    if (typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
        try {
            return safeStringify(v);
        } catch {
            try {
                return String(v);
            } catch {
                return '[Unformattable]';
            }
        }
    }
    try {
        return String(v);
    } catch {
        return '[Unformattable]';
    }
};

/**
 * 浏览器风格占位符的最小实现：%s %d %i %f %o %O 按位消费参数，
 * %c 只吞掉样式参数（Tamper 的 console.log('%c[Tamper] …', style) 全是这种）。
 * 浏览器原生还支持 %c 之后的多段样式，日志页不做富文本，直接扁平化。
 */
export const formatLogArgs = (args: unknown[]): string => {
    if (args.length === 0) return '';
    const seen = new Set<object>();
    const [first, ...rest] = args;
    const queue = [...rest];
    let out: string;
    if (typeof first === 'string' && first.includes('%')) {
        out = first.replace(/%[sdifoOc%]/g, (m) => {
            if (m === '%%') return '%';
            const v = queue.shift();
            if (m === '%c') return '';
            if (v === undefined) return m;
            return formatValue(v, seen);
        });
    } else {
        queue.unshift(first);
        out = '';
    }
    const tail = queue.map((v) => formatValue(v, seen)).join(' ');
    out = tail ? (out ? `${out} ${tail}` : tail) : out;
    return out.length > LOG_MESSAGE_MAX ? `${out.slice(0, LOG_MESSAGE_MAX)}…` : out;
};

const pushEntry = (level: LogLevel, message: string): void => {
    seq += 1;
    buffer.push({ seq, ts: Date.now(), level, message, source: 'renderer' });
    if (buffer.length > LOG_BUFFER_CAP) buffer.splice(0, buffer.length - LOG_BUFFER_CAP);
    schedulePersist();
    notify();
};

/**
 * 安装拦截。幂等：StrictMode 双重挂载、HMR 重跑都不会叠第二层
 *（叠了的话一条日志进两份，seq 还对不上）。
 */
export const installLogCapture = (): void => {
    if (installed) return;
    installed = true;

    restorePersisted();

    if (typeof window === 'undefined') return;
    const c = window.console;
    if (!c) return;

    for (const level of LEVELS) {
        const orig = c[level].bind(c) as (...args: unknown[]) => void;
        c[level] = (...args: unknown[]) => {
            if (writing) {
                orig(...args);
                return;
            }
            writing = true;
            try {
                pushEntry(level, formatLogArgs(args));
            } catch {
                // 格式化本身不许抛错：最坏情况丢这一条
            } finally {
                writing = false;
            }
            orig(...args);
        };
    }

    // 未捕获异常也记一笔：这类问题平时只躺在 devtools 里，用户反馈"我点了没反应"时只能靠它
    window.addEventListener('error', (e) => {
        if (writing) return;
        writing = true;
        try {
            pushEntry('error', `Uncaught: ${(e as ErrorEvent).message || 'unknown error'}`);
        } catch {
            // ignore
        } finally {
            writing = false;
        }
    });
    window.addEventListener('unhandledrejection', (e) => {
        if (writing) return;
        writing = true;
        try {
            pushEntry('error', `Unhandled rejection: ${formatLogArgs([(e as PromiseRejectionEvent).reason])}`);
        } catch {
            // ignore
        } finally {
            writing = false;
        }
    });
};

/** 面板读全量（调用方自己按级别/关键字过滤，保证只有一处"真相"） */
export const getLogEntries = (): readonly LogEntry[] => buffer;

/** useSyncExternalStore 快照：单调递增，面板只在有新日志时重渲染 */
export const getLogVersion = (): number => version;

export const subscribeLogs = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** 清空：内存与落盘一起清，已发出去的 seq 不回退（回退会让"新日志"判断错乱） */
export const clearLogs = (): void => {
    buffer.length = 0;
    if (persistTimer !== null && typeof window !== 'undefined') {
        window.clearTimeout(persistTimer);
        persistTimer = null;
    }
    saveJSON(LOG_STORE_KEY, []);
    notify();
};

// import 即安装（仅浏览器）：见文件头注释。显式调用 installLogCapture() 同样有效（幂等）。
if (typeof window !== 'undefined') installLogCapture();
