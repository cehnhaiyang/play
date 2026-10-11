/**
 * 唯一标识生成。
 *
 * 与宿主无关：`crypto.randomUUID` 在 Electron 渲染层、
 * 插件 service worker 里都存在，缺了也有时间戳兜底。
 */

/** 生成简短的随机 ID，用于列表项的唯一标识 */
export const generateId = (): string => {
    try {
        const uuid = (globalThis as { crypto?: { randomUUID?: () => string } })?.crypto?.randomUUID?.();
        if (typeof uuid === 'string' && uuid.length > 0) return uuid.replace(/-/g, '').slice(0, 12);
    } catch {
        /* 无 crypto 的宿主回落到下面的时间戳方案 */
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
};
