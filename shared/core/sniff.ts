/**
 * 嗅探结果的归属与标题判定。
 *
 * 与宿主无关：Electron 的嗅探面板与插件的嗅探标签页读同一份判据 ——
 * 同一个地址在两边不该得出不同结论。
 */

/**
 * 这条嗅探结果是否属于某个页面。
 *
 * **三处共用的唯一判据**：「仅当前页」筛选、当前页计数、「清空当前」。
 * 三处曾经各写一份，其中「清空当前」那份少了 `!pageUrl` 这一支 ——
 * 于是没有 pageUrl 的条目（旧缓存、网络层未带上）在「仅当前页」下可见却清不掉，
 * 用户点「清空当前」后列表里还剩几条，看起来像按钮没生效。
 *
 * pageUrl 为空视为属于当前页：那种条目无法归到任何具体页面，
 * 若不算进来就会永远清不掉，只能点「清空全部」。
 */
export const isLinkFromPage = (
    link: { pageUrl?: string } | null | undefined,
    pageUrl: string,
): boolean => !!link && (!link.pageUrl || link.pageUrl === pageUrl);

/**
 * 标题是不是"没信息量"的那种。
 *
 * 命中即说明这个标题来自文件名或占位符，而不是页面标题 ——
 * 嗅探列表应当用宿主页面标题把它顶掉。
 *
 * 三类：
 *  - 占位与通用名（`Media_xxx` / `detected` / `hls` / `playlist` / `index` / `stream` / `chunk`）；
 *  - 纯哈希文件名（16 位以上十六进制，CDN 常见）；
 *  - 纯数字文件名（8 位以上，如时间戳命名）。
 * 判据前先剥掉扩展名，否则 `index.m3u8` 这类会被当成"有内容"。
 *
 * **新增与更新两条路径必须共用这一个判据**。
 * 原先它们各写一份：新增用这套较全的，更新只看 `startsWith('Media_')` ——
 * 于是标题为文件名（`index.m3u8`，入库时页面标题还没拿到）的条目
 * 永远升不了级，列表里一直挂着那个文件名。
 */
export const isGenericTitle = (title: string | undefined | null): boolean => {
    if (!title) return true;
    const stem = title.replace(/\.[a-zA-Z0-9]+$/, '');
    return /^(media_|detected|hls|playlist|index|stream|chunk)/i.test(title)
        || /^[0-9a-f]{16,}$/i.test(stem)
        || /^\d{8,}$/.test(stem);
};
