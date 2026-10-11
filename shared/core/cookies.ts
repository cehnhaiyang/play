/**
 * Cookie 的界面键与取回。
 *
 * ## 为什么键的唯一性是个真问题
 *
 * Chrome 的 cookie 主键是 **name + domain + path**，三者任一不同即为两条独立 cookie。
 * 访问 `https://sub.example.com/` 时 `cookies.getAll` 会同时返回
 * `sid@sub.example.com/` 与 `sid@.example.com/` —— 只按 name 建索引会让它们
 * 在面板里互相覆盖：一条的值盖掉另一条，而按 key 回写时又只命中先出现的那条，
 * 于是**另一条永远看不到、也改不到**。
 *
 * 但不能无脑把 domain 全写上：绝大多数站点只有一条同名 cookie，
 * 那样会把界面刷成 `token (www.example.com)` 这种噪声。
 * 所以**先算最简键，只在真会撞的时候才补区分信息**。
 *
 * 与宿主无关：Electron 渲染层与插件侧（Agent 的 tokens 工具）共用这一份。
 */

/**
 * 是不是一个可用于 cookie 查询的真实地址。
 *
 * 空白标签页的 url 是空串；`about:blank` 之类的内部页也没有可查的 cookie。
 * 这两种都不能交给 `cookies.getAll` —— **空串在那里表示"全部 URL"**，
 * 会把所有站点的 cookie 一起列出来。
 */
export const isRealUrl = (url: string): boolean => {
    if (!url || url === 'about:blank') return false;
    try {
        const { protocol } = new URL(url);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
};

/** Cookie 列表在界面上的唯一键（与入参等长、同序） */
export const buildCookieKeys = (
    cookies: { name: string; path?: string; domain?: string }[],
): string[] => {
    const brief = cookies.map((c) =>
        !c.path || c.path === '/' ? c.name : `${c.name} (${c.path})`);

    // 统计每个最简键出现几次，只给重复的那些补 domain
    const counts = new Map<string, number>();
    for (const k of brief) counts.set(k, (counts.get(k) || 0) + 1);

    return brief.map((k, i) => {
        if ((counts.get(k) || 0) <= 1) return k;
        const domain = cookies[i].domain;
        return domain ? `${k} @${domain}` : k;
    });
};

/**
 * 面板要展示的 Cookie 键值表。
 *
 * 用 `buildCookieKeys` 保证键唯一 —— 直接用 reduce 累积的话，
 * 撞键的两条会静默合并成一条（后写的赢），面板少显示一行而没有任何提示。
 */
export const buildCookieData = (
    cookies: { name: string; value: string; path?: string; domain?: string }[],
): Record<string, string> => {
    const keys = buildCookieKeys(cookies);
    const out: Record<string, string> = {};
    cookies.forEach((c, i) => { out[keys[i]] = c.value; });
    return out;
};

/** 按 `buildCookieData` 的键取回原 cookie；找不到返回 null */
export const findCookieByKey = <T extends { name: string; path?: string; domain?: string }>(
    cookies: T[],
    key: string,
): T | null => {
    const i = buildCookieKeys(cookies).indexOf(key);
    return i >= 0 ? cookies[i] : null;
};
