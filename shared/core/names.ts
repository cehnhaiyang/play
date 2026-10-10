/**
 * 输出文件名的清洗。
 *
 * ## 为什么两套导出共用同一口径
 *
 * 绘本（.aibook）与画廊包（.gallery）是两个独立功能，但**落盘名走同一个函数**：
 * 两套各写一份清洗规则时，必然出现"一个能落盘、另一个报错"的情况 ——
 * 而用户看到的是两个看起来一模一样的"导出"按钮。
 *
 * 判据按 **Windows 最严格**的一套列全（`<>:"/\|?*` 与控制字符）：
 * 平台间取交集，比"在各平台分别合法"更省事，也不会出现同一本书在两个
 * 系统上落成不同文件名。
 *
 * 与宿主无关。
 */

/**
 * 文件名做输出名：去非法字符、压空白、限长。
 *
 * 限长 80：主流文件系统的单段上限是 255 字节，而中文按 UTF-8 是 3 字节/字 ——
 * 80 字约 240 字节，留出了后缀与去重编号（` (1)`）的余量。
 */
export const sanitizeFileName = (name: string, fallback: string): string => {
    const clean = String(name || '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return clean || fallback;
};

/** .aibook 输出名 */
export const sanitizeBookName = (name: string): string => sanitizeFileName(name, '未命名故事');

/** .gallery 输出名 */
export const sanitizePackName = (name: string): string => sanitizeFileName(name, '未命名画廊');
