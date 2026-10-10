/**
 * 本地存储读写。
 *
 * ## 这一层为什么单独成文件
 *
 * 它**只在有 DOM 的宿主里能用** —— `localStorage` 在插件 service worker 里
 * 不存在。单独成文件之后，"谁不能 import 我"由文件名直接回答，
 * 而不是靠读一遍 1400 行的 const.ts 才知道。
 *
 * 插件侧要持久化的东西一律走 `chrome.storage`（见 extension/src/shared/storage.ts），
 * 不要试图把这里的东西搬过去 —— 表现是 service worker 启动即崩，
 * 而 TypeScript 拦不住（它只看类型，不看运行环境）。
 */

/** 播放器偏好的**裸键**（无前缀的历史键名，改动即等于丢掉用户已存的设置） */
export const STORAGE_KEYS = {
    VOLUME: 'react-player-volume',
    MODE: 'react-player-mode',
    RATE: 'react-player-rate',
    FIT: 'react-player-fit',
};

/** 悬浮球状态的默认命名空间，兼容历史键 */
const STORAGE_PREFIX = 'theplay.floating.';

/**
 * 拼出真正的存储键。
 *
 * ns 传空串表示读写裸键（播放器偏好等历史键没有前缀），
 * 不传（undefined / null）才落到默认命名空间。
 */
const storageKey = (key: string, ns?: string): string =>
    ns === undefined || ns === null ? STORAGE_PREFIX + key : `${ns}${key}`;

/** 读 JSON；键不存在、内容损坏、隐私模式一律回落 fallback */
export const loadJSON = <T>(key: string, fallback: T, ns?: string): T => {
    try {
        const raw = localStorage.getItem(storageKey(key, ns));
        if (raw == null) return fallback;
        const parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed as T;
    } catch {
        return fallback;
    }
};

/** 写 JSON；配额爆了只丢本次快照，返回是否写成功（调用方无需再 try/catch） */
export const saveJSON = (key: string, value: unknown, ns?: string): boolean => {
    try {
        localStorage.setItem(storageKey(key, ns), JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
};

/** 删键；删不掉（隐私模式）不影响功能 */
export const removeStored = (key: string, ns?: string): void => {
    try {
        localStorage.removeItem(storageKey(key, ns));
    } catch {
        /* 隐私模式下 removeItem 也会抛，忽略 */
    }
};

/** 安全读原始字符串（getItem 抛错会崩初始化，裸键直读的历史代码统一走这里） */
export const loadStr = (key: string, fallback = '', ns = ''): string => {
    try {
        const raw = localStorage.getItem(storageKey(key, ns));
        return raw == null ? fallback : raw;
    } catch {
        return fallback;
    }
};

/** 安全写原始字符串，返回是否成功（配额爆了也不抛错） */
export const saveStr = (key: string, value: string, ns = ''): boolean => {
    try {
        localStorage.setItem(storageKey(key, ns), value);
        return true;
    } catch {
        return false;
    }
};
