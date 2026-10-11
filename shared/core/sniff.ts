/**
 * 嗅探结果的归属与标题判定。
 *
 * 与宿主无关：Electron 的嗅探球与插件的嗅探逻辑读同一份判据 ——
 * 同一个地址在两边不该得出不同结论。所以这个模块只放**纯函数**：
 * 它会被 service worker import，那里没有 DOM（见 test/extsniffer.test.js
 * 最后那组断言）。
 */

/**
 * 这条资源是否属于某个标签页。
 *
 * **两端共用的唯一判据**：插件的「清空此标签页」与球上的标签栏筛选。
 * 两处各写一份的后果实测过（那时判据是 pageUrl）：界面上看得见的条目清不掉，
 * 用户点完发现列表里还剩几条，看起来像按钮没生效。
 *
 * 判据是**数组包含**而不是相等：同一个地址可能被两个标签页请求过
 * （同一个视频站开两个标签页、或共用的 CDN 资源），那两个标签页下都该看到它。
 */
export const isFromTab = (
    item: { tabIds?: number[] } | null | undefined,
    tabId: number,
): boolean => !!item && (item.tabIds || []).includes(tabId);

/**
 * 从一条结果的标签页归属里摘掉一个标签页。
 *
 * 返回 `null` 表示这条该**整条丢掉** —— 没有别的标签页还拥有它。
 * 返回原对象（同一个引用）表示这个标签页本来就不拥有它，调用方据此跳过写盘。
 *
 * 单独一个函数而不是在两处各写一遍 `filter`：判据一旦分叉，"清掉 A 标签页
 * 却把 B 标签页也有的条目一起删了"这种错在两端表现还不一样（一端多删、
 * 一端少删），而两边都"成功"。
 */
export const withoutTab = <T extends { tabIds?: number[] }>(item: T, tabId: number): T | null => {
    const tabIds = item.tabIds || [];
    if (!tabIds.includes(tabId)) return item;
    const rest = tabIds.filter((id) => id !== tabId);
    return rest.length === 0 ? null : { ...item, tabIds: rest };
};

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
