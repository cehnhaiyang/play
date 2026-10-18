'use strict';
/**
 * 画廊站点注册表：把"哪个站点"这件事收敛到一处。
 *
 * 存在的理由：面板、主进程 IPC、任务键、落盘目录原先全都硬绑在 acgmho 上
 * （模块名、频道表、`${prefix}:${gid}` 键、`Downloads/acgmho/` 目录）。
 * 接第二个站点时如果照抄一遍，就会有第二份翻页/限速/去重/落盘逻辑，
 * 然后两边各自漂移。这里只做三件事：
 *
 * 1. 列出站点（UI 的站点选择按这张表渲染，加站点不需要改 UI）；
 * 2. 按 id 取站点，取不到就明确报错（不要静默回落到第一个站点——
 *    那会让"站点名打错"表现为"打开的是另一个站点"，极难发现）；
 * 3. 任务键 / 目录根 / 站点归属判定，三处口径唯一。
 *
 * 站点的接口约定（每个 provider 都必须提供，缺了启动即抛）：
 *   id, label, rootName, channels(), probeGallery(), fetchGalleryPages(),
 *   saveImages()（acgmho 叫 saveGalleryImages）, downloadGallery(),
 *   fetchChannelList(), taskKeyOf() 或 { galleryTaskKey, normalizeGid }
 *
 * 注意：**不要**在这里塞任何站点专有的解析逻辑。谁家的 HTML 谁自己懂。
 */
const acgmho = require('./acgmhoService');
const ehentai = require('./ehentaiService');

/**
 * 把各 provider 的差异收敛成一份统一形状。
 *
 * 差异只有两处，都只是命名不同，不值得为此改 provider：
 * - acgmho 的落盘入口叫 saveGalleryImages，ehentai 叫 saveImages；
 * - acgmho 的任务键与 gid 归一拆成 galleryTaskKey/normalizeGid 两个函数。
 * 这里补齐，调用方只认统一名。
 */
const normalizeProvider = (p) => {
    const saveImages = p.saveImages || p.saveGalleryImages;
    if (typeof saveImages !== 'function') {
        throw new Error(`站点 ${p.id} 缺少落盘入口（saveImages / saveGalleryImages）`);
    }
    if (typeof p.probeGallery !== 'function') throw new Error(`站点 ${p.id} 缺少 probeGallery`);
    if (typeof p.fetchGalleryPages !== 'function') throw new Error(`站点 ${p.id} 缺少 fetchGalleryPages`);
    if (typeof p.fetchChannelList !== 'function') throw new Error(`站点 ${p.id} 缺少 fetchChannelList`);
    if (typeof p.channels !== 'function') throw new Error(`站点 ${p.id} 缺少 channels()`);
    // 纯数字 gid 归一必须由 provider 提供：registry 无法凭 URL 形状反推"这个站点
    // 接受哪些写法"（ehentai 认 /g/<gid>/<token>/，acgmho 认 /h/<gid>.html 与裸数字）。
    // 缺了它，取消判定与落盘目录都会拿到空 gid，退化成把任务键当 gid 用。
    if (typeof p.normalizeGid !== 'function') throw new Error(`站点 ${p.id} 缺少 normalizeGid`);

    const rawTaskKeyOf = p.taskKeyOf || ((gidOrUrl, probe) => p.galleryTaskKey(gidOrUrl, probe));
    const rawKeyMatches = p.keyMatches || p.galleryKeyMatches;
    const gidOf = (input) => String((p.normalizeGid(input) || {}).gid || '').trim();

    /**
     * 任务键统一带站点前缀：`<site>:<站点内键>`。
     *
     * 站点内键由 provider 决定（acgmho 是 `prefix:gid`，ehentai 是纯 gid），
     * 但**站点维度由这里加**，不让每个 provider 各记一遍 —— 否则接第三个站点时
     * 又会出现一个忘了加前缀的键，表现为"两个站点同号作品互相顶掉"。
     */
    const taskKeyOf = (gidOrUrl, probe) => {
        const raw = String(rawTaskKeyOf(gidOrUrl, probe) || '').trim();
        if (!raw) return '';
        return raw.startsWith(`${p.id}:`) ? raw : `${p.id}:${raw}`;
    };

    /**
     * 取消/归属判定：先剥掉站点前缀再交给 provider。
     * 这样 provider 只关心"站点内这个键是不是这本书"，不用知道多站点存在。
     */
    const keyMatches = (storedKey, gidOrUrl) => {
        const raw = String(storedKey || '');
        if (!raw) return false;
        if (!raw.startsWith(`${p.id}:`)) return false;
        return !!rawKeyMatches(raw.slice(p.id.length + 1), gidOrUrl);
    };

    return {
        id: p.id,
        label: p.label,
        rootName: p.rootName || p.id,
        adult: !!p.adult,
        kinds: p.kinds || ['image'],
        /**
         * 搜索凭证的取用域：主进程据此从 Electron 会话里捞 cf_clearance 之类的
         * cookie。**必须按站点给**，不能让主进程拿一个站点的 cookie 去打另一个站点 ——
         * 那既是凭证跨站泄漏，也必然无效（cookie 按域签发）。
         */
        searchCookieOrigins: p.searchCookieOrigins || [],
        channels: p.channels,
        fetchChannelList: p.fetchChannelList,
        probeGallery: p.probeGallery,
        fetchGalleryPages: p.fetchGalleryPages,
        saveImages,
        downloadGallery: p.downloadGallery,
        taskKeyOf,
        gidOf,
        keyMatches,
    };
};

const PROVIDERS = [acgmho, ehentai].map(normalizeProvider);

const DEFAULT_SITE_ID = 'acgmho';

/** 站点列表（UI 的站点切换按它渲染；不含任何解析细节） */
const listSites = () => PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    adult: p.adult,
    kinds: p.kinds,
}));

/**
 * 按 id 取站点。
 *
 * 不传 id 时回落到默认站点（老调用方没带 site 字段，行为保持不变）；
 * 传了但认不出就抛错 —— 静默回落会让"站点名打错"变成"打开了另一个站点"。
 */
const getSite = (id) => {
    const want = String(id || '').trim();
    if (!want) return PROVIDERS.find((p) => p.id === DEFAULT_SITE_ID) || PROVIDERS[0];
    const found = PROVIDERS.find((p) => p.id === want);
    if (!found) throw new Error(`未知站点: ${want}（可选：${PROVIDERS.map((p) => p.id).join(' / ')}）`);
    return found;
};

/**
 * 任务键 → 站点。
 *
 * 键的形态是 `<site>:<...>`。旧任务键没有站点前缀（如 `h:123`、`123`），
 * 一律归 acgmho —— 那时只有它一个站点，这样历史任务与取消路径都还能用。
 */
const siteOfTaskKey = (key) => {
    const raw = String(key || '');
    const head = raw.split('#')[0].split(':')[0];
    const found = PROVIDERS.find((p) => p.id === head);
    return found || PROVIDERS.find((p) => p.id === DEFAULT_SITE_ID) || PROVIDERS[0];
};

/**
 * 站点内全部频道的扁平表，供 UI 一次性拿到"站点 → 频道"两层结构。
 * 频道 id 只在站点内唯一（latest/popular 这类名字两个站点都会用），
 * 所以对外的复合键必须是 `site:channelId`。
 */
const listChannels = () => PROVIDERS.map((p) => ({
    site: p.id,
    label: p.label,
    adult: p.adult,
    channels: p.channels().map((c) => ({ ...c })),
}));

module.exports = {
    PROVIDERS,
    DEFAULT_SITE_ID,
    listSites,
    listChannels,
    getSite,
    siteOfTaskKey,
};
