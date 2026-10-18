'use strict';
/**
 * E-Hentai 站点适配：频道列表、搜索、作品探测、逐页大图解析。
 *
 * 与 acgmhoService 的关系：通用能力（出网、落盘、续传、徽标、页码范围）在
 * galleryCore.js 里，本文件只留**这个站点独有的东西** —— 地址形状、HTML 结构、
 * 字段口径。两个站点都往同一个画廊面板里填，所以条目结构必须同构
 * （见 shared/meta/interface.ts 的 AcgmhoGalleryItem）。
 *
 * 本站点只有图片：没有视频、没有音轨，探测结果恒为 mediaType:'image'。
 *
 * 实测（2026-10，经本机 HTTP 代理取真页面存成 test/fixtures/eh_*.html）：
 * - 列表页 <table class="itg"> 每行一本：gl1c 分类 / gl2c 封面 / gl3c glname 标题
 *   + div.gl 标签 / gl4c 上传者与页数；封面可能是 data: 占位 + data-src 真链。
 * - 翻页是**游标**不是页码：?page=N 实测三页返回同一批（首个 gid 完全相同），
 *   只有 ?next=<本页最后一个 gid> 才翻得动（实测零重叠）。所以页码只是计数器，
 *   真正传给下一次的是上一页给的规范地址。
 * - 详情页 /g/<gid>/<token>/：#gn 标题、#gdd 元信息表（Length: N pages 即总页数）、
 *   #gdt 里每 20 页一个 /s/<imgkey>/<gid>-<n> 缩略锚，?p=<0 起> 翻这批缩略图。
 * - 图片页 /s/<imgkey>/<gid>-<n>：<img id="img" src="..."> 是可直接下载的大图。
 * - 大图直链带 keystamp 签名，**到点即失效**（实测到期时刻落在整 10 分钟边界，
 *   距签发最多 10 分钟）。所以"先把全本直链解析出来再慢慢下"这种写法在长本子上
 *   必然有尾部整批 403 —— 直链只能现取现用，见 resolveImageUrl。
 * - 图床 hath.network 走代理与直连都能拿到全图（实测同样字节数），没有特殊性，
 *   照常吃全局代理即可。
 */
const fs = require('fs');
const path = require('path');
const galleryCore = require('./galleryCore');

const BASE = 'https://e-hentai.org';

const {
    httpGet,
    httpGetFinal,
    stripTags,
    unescapeHtml,
    sleep,
    mapWithConcurrency,
    downloadImageWithResume,
    defaultGalleryRoot,
    writeGalleryOutputs,
    pruneSiblingPageFiles,
    parsePageRange,
} = galleryCore;

/* -------------------------------------------------------------------------- */
/*                                  频道表                                     */
/* -------------------------------------------------------------------------- */
// 全部实测 200 且都能解析出 25 条（popular 是多段合并，实测 68 条）。
// kind 一律 image：本站点没有视频/音轨。
const CHANNELS = [
    { id: 'latest', label: '最新', base: '/', kind: 'image' },
    { id: 'popular', label: '热门', base: '/popular', kind: 'image' },
    { id: 'doujinshi', label: '同人志', base: '/doujinshi', kind: 'image' },
    { id: 'manga', label: '漫画', base: '/manga', kind: 'image' },
    { id: 'artistcg', label: '画师CG', base: '/artistcg', kind: 'image' },
    { id: 'gamecg', label: '游戏CG', base: '/gamecg', kind: 'image' },
    { id: 'imageset', label: '图集', base: '/imageset', kind: 'image' },
    { id: 'cosplay', label: '写真', base: '/cosplay', kind: 'image' },
    { id: 'western', label: '西漫', base: '/western', kind: 'image' },
    { id: 'nonh', label: '非H', base: '/non-h', kind: 'image' },
    { id: 'asianporn', label: '亚洲', base: '/asianporn', kind: 'image' },
    { id: 'misc', label: '其他', base: '/misc', kind: 'image' },
];

const getChannel = (id) => CHANNELS.find((c) => c.id === id) || null;

/* -------------------------------------------------------------------------- */
/*                              地址与目标归一                                  */
/* -------------------------------------------------------------------------- */
/** /g/<gid>/<token>/ 是唯一能定位一本图集的地址；纯数字缺 token，取不到详情 */
function parseGalleryUrl(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    // 允许只贴 "4262064/ecdb568beb" 或 "g/4262064/ecdb568beb"；
    // 也允许尾巴上带 query/hash —— 浏览器里复制出来的地址常带 ?nw=session、
    // #comments，旧写法要求以 "/" 收尾，于是这类**完全有效**的作品地址被判成
    // "请填写作品页地址"，用户只能自己去删尾巴。
    const m = s.match(/(?:^|\/)(?:g\/)?(\d{3,})\/([0-9a-f]{6,20})\/?(?:[?#][^\s]*)?$/i);
    if (!m) return null;
    return { gid: m[1], token: m[2].toLowerCase(), url: `${BASE}/g/${m[1]}/${m[2].toLowerCase()}/` };
}

/**
 * gid 归一：给 galleryRegistry.gidOf 用（取消/落盘目录都靠它拿到纯数字）。
 *
 * 没有它时 registry 只能退到 parseGalleryUrl，而纯数字 gid 解析不出东西，
 * 于是 handleSaveImages 拿任务键 "ehentai:4262064" 当 gid 传给落盘，
 * 目录被拼成 `g-ehentai4262064`、徽标里的 gid 也是脏的。
 *
 * 图片页 /s/<imgkey>/<gid>-<n> 也认：播放列表与失败页重试传下来的可能是它。
 */
function normalizeGid(input) {
    const s = String(input || '').trim();
    const byUrl = parseGalleryUrl(s);
    if (byUrl) return { gid: byUrl.gid };
    const byImagePage = s.match(/\/s\/[0-9a-f]+\/(\d+)-\d+/i);
    if (byImagePage) return { gid: byImagePage[1] };
    const byId = s.match(/^(\d{3,})$/);
    return { gid: byId ? byId[1] : '' };
}

/** 作品页地址（列表条目 url 已经是完整地址，这里只给拼装用） */
const galleryUrlOf = (gid, token) => `${BASE}/g/${gid}/${token}/`;

/**
 * 任务键：站点维度由 galleryRegistry 统一加前缀，这里只给站点内键。
 * 本站点 gid 全局唯一（不像 acgmho 的 /h/ 与 /hentai/ 是两套地址空间）。
 *
 * 归一必须认纯数字与 /s/ 图片页：渲染层回传的是 probe.firstPageUrl（本站点恒为
 * 作品页），但落盘入口可能只拿到裸数字 gid（firstPageUrl 缺失时的回落），抓页阶段
 * 往外传的又是 /s/ 图片页地址。只认作品页地址会让这两类输入归一出空 gid，
 * 表现为任务取消判不掉、落盘目录带上任务键。
 */
const taskKeyOf = (gidOrUrl, probe) => {
    const gid = String((probe && probe.gid) || normalizeGid(gidOrUrl).gid || '').trim();
    return gid || '';
};

/** 取消时判定：站点内键（可能带 #runToken）是否属于这个 gidOrUrl */
const keyMatches = (storedKey, gidOrUrl) => {
    const key = String(storedKey || '');
    if (!key) return false;
    const base = key.split('#')[0];
    const want = normalizeGid(gidOrUrl).gid;
    if (!want) return false;
    return base === want;
};

/* -------------------------------------------------------------------------- */
/*                                列表页解析                                    */
/* -------------------------------------------------------------------------- */
// 列表主表：<table class="itg gltc">。popular 页有多段表，全部收下再按 gid 去重。
const ITG_TABLE_RE = /<table[^>]*class=["'][^"']*\bitg\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi;
// 只问"页面上有没有这张表"：不能用带 /g 的 ITG_TABLE_RE 去 test —— 它的 lastIndex
// 有状态，同一个正则既遍历又判断会让结果随调用次数变化。pattern 仍只有一份。
const HAS_LISTING_TABLE_RE = new RegExp(ITG_TABLE_RE.source, 'i');
const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const GALLERY_LINK_RE = /<a[^>]*href="(?:https?:\/\/[^"']*?)?\/g\/(\d+)\/([0-9a-f]+)\/?"[^>]*>([\s\S]*?)<\/a>/i;
const GLINK_TITLE_RE = /<div[^>]*class=["']glink["'][^>]*>([\s\S]*?)<\/div>/i;
const CATEGORY_RE = /<div[^>]*class=["']cn\s+(ct\d+)["'][^>]*>([\s\S]*?)<\/div>/i;
// 站点会往属性值里插换行与随机串来打断爬虫：实测 id 变成
// `id="posted_4262\nc091\n064"`。写死 `posted_\d+` 会整条失配（日期全空），
// 所以这里只锚 `posted_` 前缀，允许中间夹最多 40 字符任意内容。
const POSTED_RE = /id=["']posted_[\s\S]{0,40}?["'][^>]*>([\s\S]*?)<\/div>/i;
const PAGES_RE = />\s*(\d+)\s*pages?\s*</i;
const UPLOADER_RE = /\/uploader\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i;
const TAG_TITLE_RE = /<div[^>]*class=["']gt["'][^>]*title=["']([^"']*)["']/gi;
const IMG_RE = /<img[^>]*>/i;

/**
 * 封面：src 可能是 data: 占位（懒加载），真链在 data-src。
 * 站点实测两种写法都存在（同一页里混排），只读 src 会把一半条目画成空白。
 */
function pickCover(rowHtml) {
    const tag = rowHtml.match(IMG_RE);
    if (!tag) return '';
    const attr = (name) => {
        const m = tag[0].match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
        return m ? unescapeHtml(m[1]) : '';
    };
    const lazy = attr('data-src') || attr('data-original');
    const src = attr('src');
    if (!src || src.startsWith('data:')) return lazy;
    // 站点还有 1px 占位图与"请换浏览器"占位图，命中时同样回退懒加载源
    if (/1x1|placeholder|loading|blank|up_browser/i.test(src) && lazy) return lazy;
    return src;
}

/** 从标签串里挑语言：e-hentai 用 language:chinese 这类命名空间标签 */
function langFromTags(tags) {
    const lang = tags.find((t) => /^language:/i.test(t));
    if (!lang) return '';
    return lang.slice(lang.indexOf(':') + 1);
}

/** 标签展示：去掉 language:/other: 这类噪声，留 parody/character/artist/female 等 */
function displayTags(tags) {
    const useful = tags.filter((t) => !/^(language|other|temp|reclass):/i.test(t));
    return useful.slice(0, 4).map((t) => t.slice(t.indexOf(':') + 1)).join(', ');
}

/** 单行解析：认不出画廊锚（表头、广告行）返回 null */
function parseRow(rowHtml, channelId) {
    const link = rowHtml.match(GALLERY_LINK_RE);
    if (!link) return null;
    const gid = link[1];
    const token = link[2].toLowerCase();

    const tags = [...rowHtml.matchAll(TAG_TITLE_RE)].map((m) => unescapeHtml(m[1]));
    const titleM = rowHtml.match(GLINK_TITLE_RE);
    const catM = rowHtml.match(CATEGORY_RE);
    const postedM = rowHtml.match(POSTED_RE);
    const pagesM = rowHtml.match(PAGES_RE);
    const uploaderM = rowHtml.match(UPLOADER_RE);

    const title = stripTags((titleM && titleM[1]) || link[3] || '') || `作品 ${gid}`;
    return {
        gid,
        url: galleryUrlOf(gid, token),
        title,
        cover: pickCover(rowHtml),
        date: stripTags((postedM && postedM[1]) || ''),
        lang: langFromTags(tags),
        tag: displayTags(tags),
        pages: (pagesM && pagesM[1]) || '',
        views: '',
        duration: '',
        artist: stripTags((uploaderM && uploaderM[1]) || ''),
        // prefix 用 'g'：与站点 /g/ 地址同形，任务键与落盘目录都靠它区分站点内空间
        prefix: 'g',
        kind: 'image',
        channel: channelId,
        // 详情地址需要 token，条目里必须原样带出去，否则点开卡片只能拿数字重探
        token,
        category: stripTags((catM && catM[2]) || ''),
    };
}

function parseList(html, channelId) {
    if (!html) return [];
    const items = [];
    const seen = new Set();
    for (const table of html.matchAll(ITG_TABLE_RE)) {
        for (const row of table[1].matchAll(ROW_RE)) {
            const item = parseRow(row[1], channelId);
            if (!item) continue;
            // 去重键带 token：popular 页同一本可能在多段里出现
            const key = `${item.gid}:${item.token}`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push(item);
        }
    }
    return items;
}

/**
 * 下一页游标：站点把规范地址放在 #unext 的 href 里。
 * popular 页的 #unext 是 <span>（没有下一页），此时必须返回空 —— 否则 UI 会
 * 一直"加载更多"打同一页，越界页又因零增长收敛，用户看到的是按钮闪一下没反应。
 */
function nextCursor(html) {
    if (!html) return '';
    const m = html.match(/<a[^>]*id=["']unext["'][^>]*href=["']([^"']+)["']/i);
    return m ? unescapeHtml(m[1]) : '';
}

/* -------------------------------------------------------------------------- */
/*                                列表抓取                                      */
/* -------------------------------------------------------------------------- */
function channelListUrl(channelId, page = 1, query = '') {
    const q = String(query || '').trim();
    if (channelId === 'search' || q) {
        if (!q) throw new Error('请输入搜索关键词');
        return `${BASE}/?f_search=${encodeURIComponent(q)}`;
    }
    const ch = getChannel(channelId);
    if (!ch) throw new Error(`未知频道: ${channelId}`);
    // 页码只是计数器：站点翻页靠 ?next= 游标，第 2 页起必须用上一页给的规范地址
    // （deriveListPageUrl）。这里只在没有规范地址时给个起点。
    void page;
    return `${BASE}${ch.base === '/' ? '/' : ch.base}`;
}

/**
 * HTTP 错误 → 用户能据以行动的说明。
 *
 * 站点对列表、详情、图片页都有频控：429 直接回 "Too Many Requests"，
 * 裸报 HTTP 429 用户只会反复重试，把限流窗口一直顶住。三处调用点共用这一份，
 * 各写一遍必然有一处漏掉，表现为"搜索会提示限流、点进作品却只看到 429"。
 */
function mapHttpError(error) {
    const message = String((error && error.message) || '');
    if (/HTTP 429/.test(message)) {
        return new Error('站点提示：请求过于频繁，请等待约 30 秒后重试');
    }
    if (/HTTP 403/.test(message)) {
        return new Error('站点拒绝了请求（可能需要登录或触发了风控），请在设置里配置代理后重试');
    }
    return error;
}

/**
 * 抓取一页列表。
 *
 * baseUrl 是上一页回带的规范地址（含 ?next=<游标> 或 ?f_search=…&next=…）：
 * 传了就原样用，没传才按频道规则拼。这是本站点翻页的唯一正确姿势 ——
 * 实测 ?page=N 三页返回同一批，用页码翻页会永远停在第 1 页。
 */
async function fetchChannelList({ channelId = 'latest', page = 1, query = '', baseUrl = '', cookieHeader = '' } = {}) {
    const q = String(query || '').trim();
    const isSearch = channelId === 'search' || !!q;
    if (isSearch && !q) throw new Error('请输入搜索关键词');
    if (!isSearch && !getChannel(channelId)) throw new Error(`未知频道: ${channelId}`);
    const p = Math.max(1, Number(page) || 1);

    let url = '';
    if (p > 1 && baseUrl) url = baseUrl;
    else url = channelListUrl(channelId, p, q);

    let fetched;
    try {
        fetched = await httpGetFinal(
            url,
            `${BASE}/`,
            isSearch ? 15000 : 30000,
            isSearch ? 1 : 3,
            5,
            cookieHeader ? { Cookie: cookieHeader } : null
        );
    } catch (error) {
        throw mapHttpError(error);
    }
    return buildChannelListResult({ channelId, page: p, query: q, html: fetched.html, finalUrl: fetched.url });
}

function buildChannelListResult({ channelId = 'latest', page = 1, query = '', html = '', finalUrl = '' }) {
    const q = String(query || '').trim();
    const p = Math.max(1, Number(page) || 1);
    const isSearch = channelId === 'search' || !!q;
    // 挑战页不是结果页：解析成 0 条会让 UI 报"未找到"，把"需要过验证"伪装成"没有结果"
    if (galleryCore.isCloudflareChallengePage(html)) {
        throw new Error('站点被人机验证拦截（Cloudflare 挑战未完成），请检查代理后重试');
    }
    if (galleryCore.isCloudflareErrorPage(html)) {
        throw new Error('站点暂时不可用（Cloudflare 错误页），请稍后重试');
    }
    const items = parseList(html, channelId);
    const cursor = nextCursor(html);
    // 解析不出条目分两种情况，判据是**页面内容**而不是这次请求算不算搜索：
    // - 页面上连列表主表都没有：这不是"这个频道/关键词没有内容"，而是模板变了或被
    //   换成了别的页（登录页、错误页）。搜索与频道都要报 —— 只对搜索报时，频道页会
    //   静默变成空列表、"加载更多"一起消失，用户以为站点没内容，维护者看不到信号。
    // - 站点明确写了 No hits found：那才是真的没搜到，换关键词才有意义。
    const noListingTable = !HAS_LISTING_TABLE_RE.test(html);
    const noHitsText = /No hits found|No results/i.test(html);
    if (items.length === 0 && !noHitsText && (noListingTable || isSearch)) {
        throw new Error('列表解析失败（站点结构可能已变更），请反馈');
    }
    if (items.length === 0 && isSearch) {
        throw new Error(`未找到与「${q}」相关的内容，换个关键词试试`);
    }
    return {
        channelId,
        page: p,
        // 只有拿到游标才谈得上"还有更多"：末页的 #unext 是 <span>，没有 href
        hasMore: !!cursor,
        items,
        query: q,
        // 规范地址原样回带：下一页必须用它（页码翻不动本站点）
        baseUrl: cursor || finalUrl,
    };
}

/* -------------------------------------------------------------------------- */
/*                                详情页解析                                    */
/* -------------------------------------------------------------------------- */
const GN_RE = /<h1[^>]*id=["']gn["'][^>]*>([\s\S]*?)<\/h1>/i;
const GJ_RE = /<h1[^>]*id=["']gj["'][^>]*>([\s\S]*?)<\/h1>/i;
const GD1_COVER_RE = /<div[^>]*id=["']gd1["'][^>]*>[\s\S]*?url\(([^)]+)\)/i;
const GDT_ROW_RE = /<td[^>]*class=["']gdt1["'][^>]*>([\s\S]*?)<\/td>\s*<td[^>]*class=["']gdt2["'][^>]*>([\s\S]*?)<\/td>/gi;
const GDT_THUMB_RE = /<a[^>]*href=["'](?:https?:\/\/[^"']*?)?(\/s\/[0-9a-f]+\/\d+-\d+)["'][^>]*>[\s\S]*?<div[^>]*title=["']Page\s+(\d+):\s*([^"']*)["']/gi;

/** 详情页元信息表 → 键值对象（键是站点英文标签，值已去标签） */
function readMetaTable(html) {
    const meta = {};
    for (const row of html.matchAll(GDT_ROW_RE)) {
        const key = stripTags(row[1]).replace(/:\s*$/, '').trim();
        if (key) meta[key] = stripTags(row[2]);
    }
    return meta;
}

/** 总页数：Length: "685 pages" 是唯一可靠来源（缩略图只给了当前 20 页） */
function totalPagesOf(meta) {
    const raw = meta.Length || '';
    const m = raw.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
}

/** 缩略锚 → { n: { url, name } }：每 20 页一批，?p=<0 起> 翻批 */
function readThumbs(html) {
    const map = new Map();
    for (const m of html.matchAll(GDT_THUMB_RE)) {
        const page = parseInt(m[2], 10);
        if (!Number.isFinite(page)) continue;
        if (!map.has(page)) map.set(page, { url: `${BASE}${m[1]}`, name: unescapeHtml(m[3]) });
    }
    return map;
}

/* -------------------------------------------------------------------------- */
/*                                图片页解析                                    */
/* -------------------------------------------------------------------------- */
const IMG_MAIN_RE = /<img[^>]*id=["']img["'][^>]*src=["']([^"']+)["']/i;
const IMG_INFO_RE = /<div>([^<]*?\.[a-z0-9]{2,5})\s*::\s*(\d+)\s*x\s*(\d+)\s*::\s*([\d.]+\s*[KMG]?i?B)<\/div>/i;

/**
 * 解析图片页的大图直链。
 *
 * 直链带 keystamp（实测 `?keystamp=<过期戳>-<签名>;fileindex=…;xres=…`），
 * 是**有时效**的：拿到就要下，不能缓存起来下一轮再用。所以这里不落任何缓存。
 */
function parseImagePage(html) {
    const m = html.match(IMG_MAIN_RE);
    if (!m) return null;
    const url = unescapeHtml(m[1]);
    if (!/^https?:\/\//i.test(url)) return null;
    const info = html.match(IMG_INFO_RE);
    return {
        url,
        name: info ? info[1] : '',
        width: info ? parseInt(info[2], 10) : 0,
        height: info ? parseInt(info[3], 10) : 0,
        sizeText: info ? info[4] : '',
    };
}

/* -------------------------------------------------------------------------- */
/*                              图片页 → 直链                                   */
/* -------------------------------------------------------------------------- */
/**
 * 图片页地址 → 可下载的大图直链。
 *
 * 直链带 keystamp 签名，**到点即失效**（实测到期落在整 10 分钟边界）。
 * 因此这个函数的返回值有一条硬约束：**拿到就立刻消费，不得缓存、不得攒批**。
 * 曾经 downloadGallery 先把全本直链解析完再统一下载，长本子下到后段时前段
 * 的签名早已过期，整批 403；而失败被记进 records，用户看到的是"下载完成 600/685"
 * 却不知道另外 85 页全因过期而废。
 */
async function resolveImageUrl(pageUrl, referer) {
    let html;
    try {
        html = await httpGet(pageUrl, referer);
    } catch (error) {
        // 图片页同样受限流：裸报 HTTP 429/403 用户只会反复重试，把限流窗口一直顶住。
        // 站点请求的几个入口共用 mapHttpError 一份口径，各写一遍必有一处漏掉。
        throw mapHttpError(error);
    }
    if (galleryCore.isCloudflareChallengePage(html)) {
        throw new Error('站点触发了人机验证，请检查代理后重试');
    }
    if (galleryCore.isCloudflareErrorPage(html)) {
        throw new Error('站点暂时不可用（Cloudflare 错误页），请稍后重试');
    }
    const parsed = parseImagePage(html);
    if (parsed) return parsed;
    // 站点对未登录用户有看图配额：超限时图片页存在但没有大图
    if (/image limit|You are opening pages too fast|exceeded/i.test(html)) {
        throw new Error('站点提示：看图过于频繁（触发配额限制），请等几分钟后重试');
    }
    throw new Error('未在该页找到大图');
}

/**
 * 缩略图批次加载器：一批 20 页，同批的页共享一次请求。
 * 抓页与下载共用它 —— 两处各写一份就会有一处忘了 `?p=` 的 0 基偏移。
 *
 * probe.firstHtml 就是第 0 批的详情页原文，直接拿来当缓存初值，
 * 省掉"探测完再抓一次同一页"。快照恢复时没有 firstHtml，自然退回真请求。
 */
function createListingLoader(probe) {
    const cache = new Map();
    if (probe && probe.firstHtml) {
        const seeded = readThumbs(probe.firstHtml);
        if (seeded.size > 0) cache.set(0, seeded);
    }
    return async (listingIndex) => {
        if (cache.has(listingIndex)) return cache.get(listingIndex);
        const url = listingIndex <= 0 ? probe.galleryUrl : `${probe.galleryUrl}?p=${listingIndex}`;
        const html = await httpGet(url, probe.galleryUrl);
        const map = readThumbs(html);
        cache.set(listingIndex, map);
        return map;
    };
}

/** 第 n 页的图片页地址；缩略图里没有就明确报错（页数变了/批次抓失败） */
async function pageUrlOf(loadListing, n) {
    const listing = await loadListing(Math.floor((n - 1) / THUMBS_PER_LISTING));
    const thumb = listing.get(n);
    if (!thumb) throw new Error(`缩略图里没有第 ${n} 页（作品页数可能已变化）`);
    return thumb.url;
}

/* -------------------------------------------------------------------------- */
/*                                  探测                                        */
/* -------------------------------------------------------------------------- */
/**
 * 探测一本图集。
 *
 * 纯数字 gid 不接受：本站点详情页地址必须带 token（/g/<gid>/<token>/），
 * 没有 token 取不到任何东西。直接报清楚，比"探测失败"让用户去猜要好。
 *
 * 这里多花一次请求去解析第 1 页的**大图直链**，而不是把缩略锚直接当图片地址
 * 交出去：缩略锚是 `/s/<imgkey>/<gid>-1` 这种**页面**地址，塞进 <img>/播放器
 * 只会渲染成一张坏图。同一份契约里 firstPageUrl 必须是作品页（后续抓页、取消、
 * 任务键都拿它回指这本书），两者不能是同一个值。
 */
async function probeGallery(target) {
    const parsed = parseGalleryUrl(target);
    if (!parsed) {
        throw new Error('请填写 e-hentai 作品页地址（形如 https://e-hentai.org/g/4262064/ecdb568beb/），纯数字 ID 缺 token 无法定位');
    }
    const { gid, token } = parsed;
    const galleryUrl = parsed.url;

    let html;
    try {
        html = await httpGet(galleryUrl, `${BASE}/`);
    } catch (error) {
        throw mapHttpError(error);
    }
    if (galleryCore.isCloudflareChallengePage(html)) {
        throw new Error('站点被人机验证拦截（Cloudflare 挑战未完成），请检查代理后重试');
    }
    if (galleryCore.isCloudflareErrorPage(html)) {
        throw new Error('站点暂时不可用（Cloudflare 错误页），请稍后重试');
    }

    const meta = readMetaTable(html);
    const totalPages = totalPagesOf(meta);
    const title = stripTags((html.match(GN_RE) || [])[1] || '') ||
        stripTags((html.match(GJ_RE) || [])[1] || '') ||
        `作品 ${gid}`;
    if (totalPages === 0) {
        // 0 页不是"空作品"，是页面结构变了或被删：两者都不该伪装成一本 0 页画廊
        const gone = /This gallery is unavailable|pining for the fjords|has been removed/i.test(html);
        throw new Error(gone
            ? '该作品已被删除或不可见'
            : '未能从作品页解析出页数（站点结构可能已变更），请反馈');
    }

    // 封面取 #gd1 的背景图（ehgt.org 缩略图，无签名不会过期），用于详情页展示
    const coverM = html.match(GD1_COVER_RE);
    const poster = coverM ? unescapeHtml(coverM[1]).trim() : '';
    const thumbs = readThumbs(html);
    const firstThumb = thumbs.get(1);

    let firstImgUrl = '';
    let firstPageUrl = '';
    if (firstThumb) {
        firstPageUrl = firstThumb.url;
        try {
            firstImgUrl = (await resolveImageUrl(firstThumb.url, galleryUrl)).url;
        } catch (_firstErr) {
            // 第 1 页取不到不该让整次探测失败：作品信息（页数/标题/封面）都已在手，
            // 封面还能顶上做展示，后续抓页会再试一次并如实报错。
        }
    }

    return {
        gid,
        site: 'ehentai',
        title,
        totalPages,
        // 第 1 页大图直链（有时效）；取不到时退回封面，至少能展示
        firstImgUrl: firstImgUrl || poster,
        // 稳定封面：详情页优先用它，避免 10 分钟后签名过期变成坏图
        poster,
        prefix: 'g',
        // 必须是作品页：渲染层把 firstPageUrl 当 gidOrUrl 回传，抓页/取消/任务键全靠它
        firstPageUrl: galleryUrl,
        // 复用详情页 HTML：首屏解析不必再请求一次
        firstHtml: html,
        mediaType: 'image',
        category: 'manga',
        // 站点专有：翻缩略图批次与逐页取图都要 token / 规范地址
        token,
        galleryUrl,
    };
}

/* -------------------------------------------------------------------------- */
/*                              逐页大图抓取                                    */
/* -------------------------------------------------------------------------- */
const THUMBS_PER_LISTING = 20;

/**
 * 逐页抓取大图直链。
 *
 * 两段式，因为站点把"页 → 图片页地址"藏在缩略图里：
 * 1. 按批抓缩略图页（?p=<0 起>，每批 20 页），得到 n → /s/<imgkey>/<gid>-<n>；
 * 2. 逐页抓 /s/ 页，解析 <img id="img">。
 *
 * 只抓目标页所在的批次：全本 685 页 = 35 个批次 + 685 个图片页，
 * 比"逐页去猜 /s/ 地址"省掉几百个必然 404 的请求。
 */
async function fetchGalleryPages(options, onProgress, isCancelled) {
    const { gidOrUrl, pages: pageSpec, delayMs = 1000, skipPages = [], probe: preProbe = null } = options || {};
    // 复用调用方已探测的结果：gid 对得上就直接用（避免详情页重复请求）
    let probe = preProbe;
    const want = normalizeGid(gidOrUrl);
    if (!probe || !want.gid || String(probe.gid) !== String(want.gid)) {
        probe = await probeGallery(gidOrUrl);
    }
    const { gid, totalPages, title } = probe;
    const skipSet = new Set((Array.isArray(skipPages) ? skipPages : []).map((n) => Number(n)).filter((n) => Number.isFinite(n)));
    const targetPages = parsePageRange(pageSpec, totalPages);
    const pendingPages = targetPages.filter((n) => !skipSet.has(n));
    const skippedCount = targetPages.length - pendingPages.length;

    const pages = [];
    const errors = [];
    let doneCount = 0;

    const emitState = (item, status) => {
        if (onProgress) {
            onProgress({
                gid,
                current: skippedCount + doneCount,
                total: targetPages.length,
                item,
                status,
            });
        }
    };

    const loadListing = createListingLoader(probe);

    // 预取所需批次（去重后按批号升序，串行 + 间隔，避免一次打出一串请求）
    const neededListings = [...new Set(pendingPages.map((n) => Math.floor((n - 1) / THUMBS_PER_LISTING)))].sort((a, b) => a - b);
    for (const idx of neededListings) {
        if (isCancelled && isCancelled(gid)) break;
        try {
            await loadListing(idx);
        } catch (err) {
            // 单批失败不致命：用到它的页会在下面逐页记失败，其余页照常抓
            console.error(`[ehentai] 缩略图批次 ${idx} 抓取失败:`, (err && err.message) || err);
        }
        if (delayMs > 0) await sleep(delayMs);
    }

    let cancelledSeen = false;
    await mapWithConcurrency(pendingPages, 3, async (n) => {
        if (cancelledSeen || (isCancelled && isCancelled(gid))) {
            cancelledSeen = true;
            return;
        }
        let img = null;
        try {
            const pageUrl = await pageUrlOf(loadListing, n);
            img = await resolveImageUrl(pageUrl, probe.galleryUrl);
        } catch (err) {
            errors.push({ page: n, error: String((err && err.message) || err) });
            doneCount += 1;
            emitState(null, 'fetching');
            return;
        }

        const item = {
            page: n,
            url: img.url,
            title: `${title || `图集 ${gid}`} - P${String(n).padStart(2, '0')}/${totalPages}`,
            alt: img.name || null,
        };
        pages.push(item);
        doneCount += 1;
        emitState(item, 'fetching');

        if (delayMs > 0 && doneCount < pendingPages.length && !(isCancelled && isCancelled(gid))) {
            await sleep(delayMs);
        }
    });

    if (cancelledSeen || (isCancelled && isCancelled(gid))) {
        emitState(null, 'cancelled');
    } else {
        emitState(null, 'completed');
    }
    pages.sort((a, b) => (a.page || 0) - (b.page || 0));
    errors.sort((a, b) => (a.page || 0) - (b.page || 0));

    return {
        gid,
        title: probe.title,
        totalPages: probe.totalPages,
        pages,
        errors,
    };
}

/* -------------------------------------------------------------------------- */
/*                                落盘                                          */
/* -------------------------------------------------------------------------- */
/** 图片落盘的扩展名：直链里带 /xxx.webp，取不到时按 jpg */
function extOf(url) {
    const m = String(url || '').match(/\.([a-z0-9]{2,5})(?:[?;]|$)/i);
    return m ? `.${m[1].toLowerCase()}` : '.jpg';
}

/**
 * 边下边播落盘（图片）。
 *
 * 与 acgmho 的同名流程共用 galleryCore 的下载器（续传、双看门狗、软 404 校验），
 * 差别只有 Referer 的来源。
 *
 * 这里的直链是抓取阶段刚解析出来的，**必须在签名有效期内用完**。因此本函数不做
 * 任何排队/延迟，也不复用上次的 items：签名过期后同一个 URL 只会 403。
 */
async function saveImages(options, onProgress, isCancelled) {
    const {
        gid,
        title: rawTitle,
        prefix = 'g',
        sourceUrl = '',
        totalPages: totalHint,
        items = [],
        outDir,
        taskKey = '',
    } = options || {};
    // 调用方可能把任务键（ehentai:4262064）当 gid 传进来：落盘目录与徽标都要纯数字。
    // 归一失败就明确报错，不要回落到原字符串 —— 那会拼出 `g-ehentai4262064` 这种目录，
    // 且取消判定（主进程按纯数字比）永远为假，任务停不下来。
    const gidStr = normalizeGid(gid).gid;
    if (!gidStr) throw new Error(`缺少可用的作品 gid（收到「${String(gid || '')}」），无法落盘`);
    const emitTaskKey = String(taskKey || '').trim();
    const list = (Array.isArray(items) ? items : [])
        .filter((it) => it && it.url)
        .map((it) => ({ page: Number(it.page) || 0, url: String(it.url), title: it.title || '' }))
        .sort((a, b) => a.page - b.page);
    if (list.length === 0) throw new Error('没有可保存的图片直链');

    const title = String(rawTitle || `作品 ${gidStr}`);
    const galleryDir = outDir || defaultGalleryRoot('ehentai', gidStr, prefix);
    fs.mkdirSync(galleryDir, { recursive: true });

    const totalFiles = list.length;
    let doneFiles = 0;
    const savedFiles = [];
    const records = [];

    const emit = (extra) => {
        if (!onProgress) return;
        onProgress({
            gid: gidStr,
            taskKey: emitTaskKey || undefined,
            title,
            doneFiles,
            totalFiles,
            percent: totalFiles > 0 ? Math.round((doneFiles / totalFiles) * 100) : 0,
            outDir: galleryDir,
            ...extra,
        });
    };

    // 页码编号：显式页码优先占位，无页码项从未占用序号补（与 acgmho 同口径）
    const usedPages = new Set(list.filter((it) => it.page > 0).map((it) => it.page));
    let fallbackCursor = 1;
    const numbered = list.map((item) => {
        if (item.page > 0) return { item, n: item.page };
        while (usedPages.has(fallbackCursor)) fallbackCursor += 1;
        usedPages.add(fallbackCursor);
        return { item, n: fallbackCursor };
    });

    let cancelledEarly = false;
    // 直链签名最多 10 分钟失效：抓取阶段解析出来的链接，等到落盘时可能已过期。
    // 有作品页地址就按页码重新取一次（重新解析图片页），没有就只能如实报 403。
    const parsedSource = parseGalleryUrl(sourceUrl);
    const loadListing = parsedSource ? createListingLoader({ galleryUrl: parsedSource.url }) : null;
    await mapWithConcurrency(numbered, 4, async ({ item, n }) => {
        if (cancelledEarly || (isCancelled && isCancelled(gidStr))) {
            cancelledEarly = true;
            return;
        }
        const fileName = `${n}${extOf(item.url)}`;
        const dest = path.join(galleryDir, fileName);
        pruneSiblingPageFiles(galleryDir, n, fileName);
        const referer = sourceUrl || `${BASE}/`;
        try {
            const bytes = await downloadPageImage({
                url: item.url,
                loadPageUrl: loadListing ? () => pageUrlOf(loadListing, n) : null,
                dest,
                referer,
                onChunk: (done, total) => {
                    emit({
                        status: 'downloading',
                        message: `正在保存第 ${n} 页 (${(done / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB)`,
                    });
                },
            });
            const { pathToFileURL } = require('url');
            const localUrl = pathToFileURL(dest).href;
            doneFiles += 1;
            savedFiles.push(dest);
            records.push({ page: n, page_url: referer, img_url: item.url, saved_as: dest.replace(/\\/g, '/'), bytes });
            emit({
                status: 'file-done',
                message: `第 ${n} 页已保存到本地`,
                file: { page: n, url: item.url, title: item.title, localUrl, savedPath: dest, bytes },
            });
        } catch (err) {
            records.push({ page: n, page_url: referer, img_url: item.url, error: String((err && err.message) || err) });
        }
    });

    const cancelled = cancelledEarly || !!(isCancelled && isCancelled(gidStr));
    records.sort((a, b) => (a.page || 0) - (b.page || 0));
    savedFiles.sort();

    const { manifestPath, galleryMarkerPath } = writeGalleryOutputs(galleryDir, {
        site: 'ehentai',
        base: BASE,
        gid: gidStr,
        title,
        prefix,
        sourceUrl: sourceUrl || '',
        totalPages: Number(totalHint) || totalFiles,
        records,
        logTag: 'ehentaiSave',
    });

    emit({
        status: cancelled ? 'cancelled' : 'completed',
        message: cancelled ? '保存已取消' : `保存完成：成功 ${savedFiles.length}/${totalFiles} 页`,
    });

    return { success: savedFiles.length > 0 && !cancelled, outDir: galleryDir, manifestPath, galleryMarkerPath, savedFiles, records };
}

/**
 * 下载一页大图；直链过期（403）时按图片页重新解析一次再下。
 *
 * e-hentai 的直链签名最多 10 分钟失效（实测到期落在整 10 分钟边界），而抓页与落盘
 * 是分批进行的：685 页的书在 1s 间隔下抓完要 11 分钟以上，尾部页的链接早过期了。
 * 没有这一步，长本子的落盘以"成功 600/685"收场，剩下 85 页是坏图，且失败原因
 * 只有一句 HTTP 403 —— 用户与维护者都看不出这是签名过期。
 *
 * @param {object} args
 * @param {string} args.url 已解析的大图直链（可能已过期）
 * @param {() => Promise<string>} [args.loadPageUrl] 重新取该页图片页地址；缺省则不做刷新
 */
async function downloadPageImage({ url, loadPageUrl, dest, referer, onChunk }) {
    try {
        return await downloadImageWithResume(url, dest, referer, onChunk);
    } catch (err) {
        if (!loadPageUrl || !/HTTP 403/.test(String((err && err.message) || ''))) throw err;
        const fresh = await resolveImageUrl(await loadPageUrl(), referer);
        return downloadImageWithResume(fresh.url, dest, referer, onChunk);
    }
}

/**
 * 全本下载：逐页「解析直链 → 立刻下载」。
 *
 * 刻意**不**复用 fetchGalleryPages 的批量结果：那会先把全本直链解析完再统一下载，
 * 而直链 10 分钟就过期，长本子必然尾部整批 403（实测复现）。
 * 一页一页地"现取现用"才是这个站点的正确姿势。
 */
async function downloadGallery(options, onProgress, isCancelled) {
    const { gidOrUrl, pages: pageSpec, outDir, delayMs = 1000, probe: preProbe = null } = options || {};
    const probe = preProbe || await probeGallery(gidOrUrl);
    const { gid, totalPages } = probe;
    const targetPages = parsePageRange(pageSpec, totalPages);
    const galleryDir = outDir || defaultGalleryRoot('ehentai', String(gid), probe.prefix);
    if (targetPages.length === 0) {
        return {
            success: false,
            totalDownloaded: 0,
            outDir: galleryDir,
            manifestPath: '',
            galleryMarkerPath: '',
            records: [],
            message: `页码范围「${pageSpec}」无有效页（总 ${totalPages} 页）`,
        };
    }
    fs.mkdirSync(galleryDir, { recursive: true });

    const loadListing = createListingLoader(probe);
    const records = [];
    const savedFiles = [];
    let cancelled = false;
    let doneCount = 0;

    await mapWithConcurrency(targetPages, 3, async (n) => {
        if (cancelled || (isCancelled && isCancelled(gid))) {
            cancelled = true;
            return;
        }
        let imgUrl = '';
        let pageUrl = '';
        try {
            pageUrl = await pageUrlOf(loadListing, n);
            const img = await resolveImageUrl(pageUrl, probe.galleryUrl);
            imgUrl = img.url;
            const fileName = `${n}${extOf(imgUrl)}`;
            const dest = path.join(galleryDir, fileName);
            pruneSiblingPageFiles(galleryDir, n, fileName);
            const bytes = await downloadImageWithResume(imgUrl, dest, probe.galleryUrl, (done, total) => {
                if (onProgress) {
                    onProgress({
                        gid,
                        currentPage: n,
                        totalPages: targetPages.length,
                        currentBytes: done,
                        totalBytes: total,
                        percent: total > 0 ? Math.round((done / total) * 100) : 0,
                        currentUrl: imgUrl,
                        status: 'downloading',
                        message: `正在下载第 ${n} 页 (${(done / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB)`,
                        savedFiles,
                    });
                }
            });
            records.push({ page: n, page_url: pageUrl, img_url: imgUrl, saved_as: dest.replace(/\\/g, '/'), bytes });
            savedFiles.push(dest);
        } catch (err) {
            records.push({ page: n, page_url: pageUrl, img_url: imgUrl, error: `下载失败: ${(err && err.message) || err}` });
        }
        doneCount += 1;
        if (delayMs > 0 && doneCount < targetPages.length && !(isCancelled && isCancelled(gid))) {
            await sleep(delayMs);
        }
    });

    cancelled = cancelled || !!(isCancelled && isCancelled(gid));
    records.sort((a, b) => (a.page || 0) - (b.page || 0));
    savedFiles.sort();

    const { manifestPath, galleryMarkerPath } = writeGalleryOutputs(galleryDir, {
        site: 'ehentai',
        base: BASE,
        gid,
        title: probe.title,
        prefix: probe.prefix,
        sourceUrl: probe.galleryUrl,
        totalPages: probe.totalPages,
        records,
        logTag: 'ehentaiDownload',
    });

    const successfulCount = records.filter((r) => r.bytes && r.bytes > 0).length;
    if (onProgress) {
        onProgress(cancelled
            ? {
                gid,
                currentPage: targetPages.length,
                totalPages: targetPages.length,
                currentBytes: 0,
                totalBytes: 0,
                percent: Math.round((successfulCount / targetPages.length) * 100),
                currentUrl: '',
                status: 'cancelled',
                message: `下载已取消：已保存 ${successfulCount}/${targetPages.length} 页`,
                savedFiles,
            }
            : {
                gid,
                currentPage: targetPages.length,
                totalPages: targetPages.length,
                currentBytes: 0,
                totalBytes: 0,
                percent: 100,
                currentUrl: '',
                status: 'completed',
                message: `下载完成：成功 ${successfulCount}/${targetPages.length} 页`,
                savedFiles,
            });
    }

    return {
        success: successfulCount > 0 && !cancelled,
        totalDownloaded: successfulCount,
        outDir: galleryDir,
        manifestPath,
        galleryMarkerPath,
        records,
        // 失败页不再另开一个字段：records 里带 error 的条目就是全部失败面，
        // 两个字段并存只会让调用方以为存在"下载失败但记录成功"的页。
    };
}

module.exports = {
    id: 'ehentai',
    label: 'E-Hentai',
    rootName: 'ehentai',
    adult: true,
    kinds: ['image'],
    // 会话 cookie 只跟着**列表/搜索请求**走（handleChannelList），用于少撞列表限流；
    // 图片页与图床 hath.network 属于别的域，不带任何 cookie，那里也不认它。
    // 与 acgmho 的域无关，按站点给才不会被主进程拿错凭证。
    searchCookieOrigins: [`${BASE}/`, 'https://forums.e-hentai.org/'],
    CHANNELS,
    channels: () => CHANNELS,
    channelListUrl,
    fetchChannelList,
    buildChannelListResult,
    parseList,
    nextCursor,
    parseGalleryUrl,
    normalizeGid,
    parseImagePage,
    probeGallery,
    fetchGalleryPages,
    downloadGallery,
    saveImages,
    taskKeyOf,
    keyMatches,
    parsePageRange,
    // 供测试直接验证的纯函数
    _internals: { parseRow, readMetaTable, readThumbs, totalPagesOf, langFromTags, displayTags, pickCover, extOf, mapHttpError },
};
