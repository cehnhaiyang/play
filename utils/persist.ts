/**
 * 悬浮球持久化小工具：localStorage JSON 存取，全部 try/catch 包裹。
 * 配额爆了/隐私模式都只影响“记住”，不影响功能。
 *
 * 约定：
 * - 默认命名空间 PREFIX（theplay.floating.）兼容历史键；
 * - 传 ns='' 可读写裸键（如 react-player-*、书签等历史裸键）；
 * - 所有写操作吞异常并返回 boolean，调用方无需再 try/catch。
 */
const PREFIX = 'theplay.floating.';

const storageKey = (key: string, ns?: string): string =>
    ns === undefined || ns === null ? PREFIX + key : `${ns}${key}`;

export function loadJSON<T>(key: string, fallback: T, ns?: string): T {
    try {
        const raw = localStorage.getItem(storageKey(key, ns));
        if (!raw) return fallback;
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export function saveJSON(key: string, value: unknown, ns?: string): boolean {
    try {
        localStorage.setItem(storageKey(key, ns), JSON.stringify(value));
        return true;
    } catch {
        // 配额不足等：只丢本次快照，不抛错
        return false;
    }
}

export function removeStored(key: string, ns?: string): void {
    try {
        localStorage.removeItem(storageKey(key, ns));
    } catch {
        // ignore
    }
}

/** 安全读原始字符串（裸键直读的历史代码统一走这里，避免 getItem 抛错崩初始化） */
export function loadStr(key: string, fallback = '', ns = ''): string {
    try {
        const raw = localStorage.getItem(storageKey(key, ns));
        return raw == null ? fallback : raw;
    } catch {
        return fallback;
    }
}

/** 安全写原始字符串，返回是否成功（配额爆了也不抛错） */
export function saveStr(key: string, value: string, ns = ''): boolean {
    try {
        localStorage.setItem(storageKey(key, ns), value);
        return true;
    } catch {
        return false;
    }
}
