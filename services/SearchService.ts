/**
 * ============================================================================
 * SearchService — 通用资源搜索引擎
 * ============================================================================
 *
 * 一次关键词 → 选定分区（表站 / 里站）→ 扇出查询该分区全部站点 → 归一化汇总。
 *
 * 整个服务在本文件内按小节排开：
 *
 *   一、插口契约    SiteProvider：引擎对站点的全部认知
 *   二、归一化      体积 / 时间 / 磁链编码 / HTML 实体，各站格式差异在此消化
 *   三、站点公共件  声明骨架、条目组装、正则游标
 *   四、站点实现    每站一节，只回答"怎么搜"与"怎么读"
 *   五、注册表      引擎与 UI 认识站点的唯一入口（分区也在这里判定）
 *   六、传输        唯一碰网络的地方，可替换
 *   七、引擎        扇出 / 并发 / 超时 / 去重 / 排序 / 容错
 *
 * 加一个站点 = 在第四节写一个 defineProvider(...)，再到第五节的 PROVIDERS 里加
 * 一项；`adult: true` 即自动进里站分区。引擎、UI、主进程都不用改。
 *
 * provider 的 buildSearchUrl 与 parse 必须是纯函数：不请求网络、不读全局状态。
 * 这样才能拿保存下来的真实响应快照离线跑测试（test/search.test.js）——站点改版
 * 时测试立刻失败，而不是等用户搜出空结果才发现。
 */

import type {
    SearchHit, SearchQuery, SearchResult, SearchSiteStatus, SearchSort, SiteDescriptor, SiteGroup,
} from '../meta';

/* ==========================================================================
 * 一、插口契约
 * ==========================================================================
 *
 * 引擎对任何具体站点一无所知，只认这一节里的接口。
 */

/** 引擎交给 provider 的解析上下文 */
export interface ParseContext {
    /** 本次实际请求的地址（部分站点需要从中回填信息） */
    url: string;
    /** 搜索关键词 */
    query: string;
}

/**
 * provider 产出的条目。
 * site / siteLabel 由引擎按注册信息统一盖章，provider 不必也不该自己填——
 * 否则同一个站点在两处各写一遍名字，迟早不一致。
 */
export type ProviderHit = Omit<SearchHit, 'site' | 'siteLabel'>;

/**
 * 站点插口：只需回答"这个站怎么搜、它返回的东西怎么读"。
 * 翻页、并发、限速、去重、排序、容错全部由引擎负责。
 */
export interface SiteProvider {
    /** 站点元信息（id / 显示名 / 主页 / 是否成人 / 内容类型） */
    descriptor: SiteDescriptor;
    /** 关键词 → 搜索地址。纯函数。 */
    buildSearchUrl(query: string): string;
    /**
     * 响应正文 → 归一化条目。纯函数。
     *
     * 必须容错：站点改版、返回错误页、返回空结果时应当返回空数组而不是抛错。
     * 单个站点解析失败不该让整个扇出搜索失败——引擎会把空结果记为「0 条」。
     */
    parse(body: string, ctx: ParseContext): ProviderHit[];
    /**
     * 站点要求的请求头（多为 Referer）。
     * 部分站点校验来源，缺失会返回 403 或空列表。
     */
    headers?: Record<string, string>;
}

/** 一次取字节请求 */
export interface TransportRequest {
    url: string;
    headers?: Record<string, string>;
    /** 单次请求超时（毫秒） */
    timeoutMs?: number;
}

/** 一次取字节结果 */
export interface TransportResponse {
    ok: boolean;
    /** HTTP 状态码；0 表示连接根本没建立（超时 / DNS / 网络错误） */
    status: number;
    body: string;
    /** 跟随重定向后的最终地址 */
    finalUrl: string;
    /** 失败原因（status 为 0 或非 2xx 时有值），引擎据此在站点状态里说明原因 */
    error?: string;
}

/**
 * 传输层：引擎唯一碰网络的地方。
 *
 * 抽成接口有两个实际好处：
 * 1. 测试时可以注入假实现，离线跑完整扇出流程；
 * 2. 将来若要改走主进程代取（例如需要过 Cloudflare 挑战），
 *    只需换一个实现，引擎与全部 provider 一行都不用动。
 */
export interface Transport {
    get(req: TransportRequest): Promise<TransportResponse>;
}

/* ==========================================================================
 * 二、归一化
 * ==========================================================================
 *
 * 各站字段格式互不相同，引擎与 UI 只认归一化后的数字：
 *
 *   体积   "6.6 GiB" / "48.5GB" / "183567938" / "33,343,733,854 bytes"
 *   时间   epoch 秒 / epoch 毫秒 / "2026-09-12 15:45" / "05/05/2026 20:50"
 *   磁链   btih 可能是 40 位 hex，也可能是 32 位 base32（dmhy / animetosho）
 *
 * 跨站排序只能用数字——按 "1.8 GB" 与 "709.4 MiB" 这类字符串排序毫无意义
 * （字典序里 "1.8 GB" > "709.4 MiB"，实际相反）。
 */

/** 站点未公布某个数字时的哨兵值。与 0 含义不同：0 是"确实是零" */
export const UNKNOWN = -1;

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    '#39': "'", '#x27': "'", '#x2F': '/', hellip: '…', mdash: '—', ndash: '–',
};

/** 解码 HTML 实体（含数字实体）。解析标题时必须先做，否则标题里留着 &#39; 这类噪音 */
export function decodeEntities(input: string): string {
    return String(input || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
        if (body.charAt(0) === '#') {
            const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
            const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
            if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
            try {
                return String.fromCodePoint(code);
            } catch (_e) {
                return whole;
            }
        }
        const named = NAMED_ENTITIES[body];
        return named === undefined ? whole : named;
    });
}

/** 去标签 + 解码实体 + 压空白 */
export function stripTags(input: string): string {
    return decodeEntities(String(input || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

const SIZE_UNITS: Record<string, number> = {
    B: 1,
    // 带 i 的是二进制单位（1024），不带的按十进制（1000）。
    // 两者差约 7%，对"按体积排序"没有实质影响，但按字面正确解析更不容易出错。
    KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4, PIB: 1024 ** 5,
    KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4, PB: 1000 ** 5,
};

/**
 * 体积文本 → 字节数。无法解析返回 UNKNOWN。
 * 覆盖实测到的全部形态：
 *   "6.6 GiB"（nyaa） / "48.5GB"（dmhy） / "1.8 GB"（acg.rip）
 *   "183567938"（apibay，纯字节） / "33,343,733,854 bytes"（animetosho 的 title）
 *   "-" / "" / "N/A"（站点未公布）
 */
export function parseSizeBytes(input: string): number {
    const raw = String(input == null ? '' : input).trim();
    if (!raw || raw === '-' || /^(n\/?a|unknown|未知)$/i.test(raw)) return UNKNOWN;

    // 纯数字（可带千分位）：站点直接给了字节数
    const plain = raw.replace(/,/g, '');
    if (/^\d+$/.test(plain)) {
        const n = Number(plain);
        return Number.isFinite(n) && n >= 0 ? n : UNKNOWN;
    }

    // "33,343,733,854 bytes"
    const bytesOnly = raw.match(/^([\d.,]+)\s*bytes?$/i);
    if (bytesOnly) {
        const n = Number(bytesOnly[1].replace(/,/g, ''));
        return Number.isFinite(n) && n >= 0 ? n : UNKNOWN;
    }

    // "6.6 GiB" / "48.5GB" / "1.8 GB"
    const m = raw.match(/([\d.,]+)\s*([KMGTPE]?i?B)\b/i);
    if (!m) return UNKNOWN;
    const value = Number(m[1].replace(/,/g, ''));
    const unit = SIZE_UNITS[m[2].toUpperCase()];
    if (!Number.isFinite(value) || unit === undefined) return UNKNOWN;
    return Math.round(value * unit);
}

/** 字节数 → 人类可读（结果列表用；站点原始文本仍保留在 sizeText 里） */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let v = bytes;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
        v /= 1024;
        u += 1;
    }
    return `${v.toFixed(u === 0 ? 0 : v >= 100 ? 0 : 1)} ${units[u]}`;
}

/**
 * 时间 → epoch 毫秒。无法解析返回 UNKNOWN。
 *
 * epoch 秒与毫秒靠量级区分：秒级现在约 1.7e9，毫秒级约 1.7e12，
 * 阈值取 1e11 可稳定分开两者（1e11 秒是公元 5138 年，1e11 毫秒是 1973 年）。
 */
export function parseTimestamp(input: string | number): number {
    if (input == null || input === '') return UNKNOWN;
    const n = typeof input === 'number' ? input : Number(String(input).trim());
    if (!Number.isFinite(n) || n <= 0) return UNKNOWN;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

/**
 * 日期文本 → epoch 毫秒。无法解析返回 UNKNOWN。
 * 覆盖实测形态：
 *   "2026-09-12 15:45"（nyaa） / "2026/08/28 05:32"（dmhy）
 *   "05/05/2026 20:50"（animetosho，日/月/年）
 */
export function parseDateText(input: string): number {
    const raw = String(input || '').trim();
    if (!raw) return UNKNOWN;

    // 年在前：YYYY-MM-DD / YYYY/MM/DD [HH:mm[:ss]]
    const ymd = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (ymd) {
        const t = Date.UTC(
            Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]),
            Number(ymd[4] || 0), Number(ymd[5] || 0), Number(ymd[6] || 0)
        );
        return Number.isFinite(t) ? t : UNKNOWN;
    }

    // 日在先：DD/MM/YYYY [HH:mm]（animetosho）
    const dmy = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (dmy) {
        const t = Date.UTC(
            Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]),
            Number(dmy[4] || 0), Number(dmy[5] || 0)
        );
        return Number.isFinite(t) ? t : UNKNOWN;
    }

    const fallback = Date.parse(raw);
    return Number.isFinite(fallback) ? fallback : UNKNOWN;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * base32 → 小写 hex。
 *
 * 必需，不是锦上添花：dmhy 与 animetosho 的磁链用的是 32 位 base32 btih
 * （如 7BSRIRFCYCZ767R5UPF5OXNFR327BHQZ），nyaa 与 apibay 用 40 位 hex。
 * 不统一的话，同一资源在两站之间无法识别为同一条，跨站去重直接失效。
 */
export function base32ToHex(input: string): string {
    const s = String(input || '').toUpperCase().replace(/=+$/, '');
    if (!s) return '';
    let bits = 0;
    let value = 0;
    let out = '';
    for (let i = 0; i < s.length; i += 1) {
        const idx = BASE32_ALPHABET.indexOf(s.charAt(i));
        if (idx < 0) return ''; // 非 base32 字符：整体判为无效，不返回半截结果
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out += ((value >>> bits) & 0xff).toString(16).padStart(2, '0');
        }
    }
    return out;
}

/**
 * 从 magnet 链接提取 info hash（小写 hex）。提取不到返回空串。
 * 两种编码都要认，见 base32ToHex。
 */
export function magnetInfoHash(magnet: string): string {
    const m = String(magnet || '').match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
    if (!m) return '';
    const btih = m[1];
    if (/^[0-9a-fA-F]{40}$/.test(btih)) return btih.toLowerCase();
    if (/^[a-zA-Z2-7]{32}$/.test(btih)) return base32ToHex(btih);
    return '';
}

/** 已知 info hash 时补一条 magnet（apibay 只给 hash，不给磁链） */
export function buildMagnet(infoHash: string, name: string): string {
    if (!infoHash) return '';
    const dn = name ? `&dn=${encodeURIComponent(name)}` : '';
    return `magnet:?xt=urn:btih:${infoHash}${dn}`;
}

/**
 * 标题归一化，仅用于跨站去重的兜底比较（info hash 缺失时）。
 * 去掉大小写、标点、空白差异——同一资源在不同站的标题常有细微排版差别。
 */
export function normalizeTitle(input: string): string {
    return String(input || '')
        .toLowerCase()
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // 去掉 [字幕组] (年份) 这类括号段
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

/** 把站点给的相对地址补成绝对地址（nyaa 用相对、sukebei 用绝对，两者都要能处理） */
export function absolutize(href: string, base: string): string {
    const s = String(href || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return `https:${s}`;
    const origin = String(base || '').replace(/\/+$/, '');
    if (s.startsWith('/')) return `${origin}${s}`;
    return `${origin}/${s}`;
}

/** 文本 → 整数；空、"-"、非数字都记 UNKNOWN（数字单元格与 JSON 字符串字段共用） */
function toInt(value: unknown): number {
    if (value == null || value === '') return UNKNOWN;
    const n = Number(String(value).replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : UNKNOWN;
}

/* ==========================================================================
 * 三、站点公共件
 * ==========================================================================
 */

/**
 * 全局正则游标：把 lastIndex 复位与 exec 循环收在一处。
 * 五个解析器都要"逐行/逐条扫"，原来各写一遍 while-exec，容易漏掉复位
 * （漏了就是第二次搜索只返回一半结果）。传入的正则必须带 g。
 */
function* iterMatches(re: RegExp, text: string): Generator<RegExpExecArray> {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) yield m;
}

/** 数据行里按顺序排列的 <td> 内容 */
function cellsOf(rowHtml: string): string[] {
    const out: string[] = [];
    for (const m of iterMatches(/<td[^>]*>([\s\S]*?)<\/td>/gi, rowHtml)) out.push(m[1]);
    return out;
}

/**
 * provider 声明：只给站点元信息、搜索地址与解析器。
 * descriptor 与 Referer 都由 homepage 推导——原来五个 provider 各写一遍
 * `headers: { Referer: homepage + '/' }`，漏写就莫名 403。
 */
interface ProviderSpec {
    id: string;
    label: string;
    homepage: string;
    adult?: boolean;
    kinds: string[];
    buildSearchUrl(query: string): string;
    parse(body: string, ctx: ParseContext): ProviderHit[];
}

function defineProvider(spec: ProviderSpec): SiteProvider {
    return {
        descriptor: {
            id: spec.id,
            label: spec.label,
            homepage: spec.homepage,
            adult: spec.adult === true,
            kinds: spec.kinds,
        },
        buildSearchUrl: spec.buildSearchUrl,
        parse: spec.parse,
        headers: { Referer: `${spec.homepage}/` },
    };
}

/** provider 交给组装器的字段：只填站点真给了的东西 */
type HitSeed = { id: string } & Partial<Omit<ProviderHit, 'id'>>;

/**
 * 条目组装：站点没给的字段一律记 UNKNOWN / 空串。
 * infoHash 一律从磁链推（没有磁链的站就是空串），标题缺失时给占位名。
 */
function makeHit(seed: HitSeed): ProviderHit {
    const magnet = seed.magnet || '';
    const number = (v: number | undefined) => (v === undefined ? UNKNOWN : v);
    return {
        id: seed.id,
        title: seed.title || `torrent-${seed.id}`,
        magnet,
        torrent: seed.torrent || '',
        viewUrl: seed.viewUrl || '',
        sizeBytes: number(seed.sizeBytes),
        sizeText: seed.sizeText || '',
        seeders: number(seed.seeders),
        leechers: number(seed.leechers),
        completed: number(seed.completed),
        publishedAt: number(seed.publishedAt),
        category: seed.category || '',
        infoHash: seed.infoHash === undefined ? magnetInfoHash(magnet) : seed.infoHash,
    };
}

/* ==========================================================================
 * 四、站点实现
 * ==========================================================================
 */

/* --------------------------------------------------------------------------
 * Nyaa 系：nyaa.si 表区 / sukebei.nyaa.si 里区
 * --------------------------------------------------------------------------
 *
 * 两个站跑同一套 Nyaa 程序，HTML 结构逐字段一致，实测确认：
 *
 *   <tr class="default">          ← 状态色，success/danger 同构，见 NYAA_ROW_RE
 *     <td><a href="/?c=1_2" title="Anime - English-translated"><img class="category-icon"></a></td>
 *     <td colspan="2"><a href="/view/2160092" title="标题">标题</a></td>
 *     <td class="text-center">
 *       <a href="/download/2160092.torrent">…</a>
 *       <a href="magnet:?xt=urn:btih:ef3e7ad1…">…</a>
 *     </td>
 *     <td class="text-center">6.6 GiB</td>
 *     <td class="text-center" data-timestamp="1789227900">2026-09-12 15:45</td>
 *     <td class="text-center">43</td>   ← seeders
 *     <td class="text-center">2</td>    ← leechers
 *     <td class="text-center">607</td>  ← completed
 *   </tr>
 *
 * 差异只有两处，全部收在配置里：
 *   1. 域名与分类默认值不同；
 *   2. sukebei 给绝对地址，nyaa 给相对地址（解析两者都接受）。
 *
 * 页面域名为什么是 .si 而不是 .site（2026-10-08 实测，同一解析器）：
 * `?q=nitroplus` 在 sukebei.nyaa.site 返回 "No results found"（0 行），
 * 在 sukebei.nyaa.si 返回 11 行；`?q=hentai` 是 50 行 vs 73 行。.site 是同步
 * 不完整的镜像，日文/社团名查询在它那儿静默返回空，所以弃用。早先下载链与页面
 * 域名分家（页面 .site、下载 .si）才需要 downloadBase 单列，现在两处同域，
 * 该字段已删——留着就是一行没人用的配置和一个会失真的注释。
 *
 * 一份解析器服务两个站点实例，正是"引擎不认识站点、站点只是插口"的体现。
 */

/**
 * 行定位：不吃 class。站点在数据行上放的是**状态色** class——实测 default=普通、
 * success=可信上传组、danger=另一种标记，比例随页面剧烈变化。曾经按
 * `class~="default"` 认行，等于把所有可信源整批丢掉：sukebei 同人志分类页
 * （?c=1_2）75 行全是 success，解析出 0 行；nyaa 浏览页 75 行只认 44 行。
 * 数据行的真判据是"这一行有没有 /view/<id> 详情链"（见 NYAA_VIEW_RE 的用法），
 * 表头行没有该链，自然被跳过。
 */
const NYAA_ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
/** 详情页链接：绝对或相对都接受，从中抠出数字 id，并捕获锚内文本作为标题兜底 */
const NYAA_VIEW_RE = /<a[^>]*href="((?:https?:\/\/[^"/]+)?\/view\/(\d+))"[^>]*>([\s\S]*?)<\/a>/i;
/** 同一个锚上的 title 属性（站点给的完整原文，优先于锚内文本） */
const NYAA_VIEW_TITLE_RE = /<a[^>]*href="(?:https?:\/\/[^"/]+)?\/view\/\d+"[^>]*\stitle="([^"]*)"/i;
const NYAA_MAGNET_RE = /href="(magnet:\?[^"]+)"/i;
/** 种子直链：绝对或相对都接受 */
const NYAA_TORRENT_RE = /href="((?:https?:\/\/[^"]+)?\/download\/\d+\.torrent)"/i;
/**
 * 分类：取分类图标的 alt 文本。属性顺序两种都要认——实测给的是
 * `alt="…" class="category-icon"`（alt 在前），但属性顺序不受规范约束，
 * 站点改版时可能调换。
 */
const NYAA_CATEGORY_ALT_RE = /<img[^>]*class="category-icon"[^>]*alt="([^"]*)"/i;
const NYAA_CATEGORY_ALT_RE2 = /<img[^>]*alt="([^"]*)"[^>]*class="category-icon"/i;
/** 日期单元格上的精确时间戳（epoch 秒），比显示的文本更准 */
const NYAA_TIMESTAMP_RE = /data-timestamp="(\d+)"/i;

interface NyaaSiteConfig {
    id: string;
    label: string;
    /** 页面所在域名，用于补全相对地址与拼搜索地址 */
    base: string;
    adult: boolean;
    kinds: string[];
}

function createNyaaProvider(cfg: NyaaSiteConfig): SiteProvider {
    return defineProvider({
        id: cfg.id,
        label: cfg.label,
        homepage: cfg.base,
        adult: cfg.adult,
        kinds: cfg.kinds,
        // 只带 q：跨站搜索不该替用户预设分类，各站分类编码互不通用
        buildSearchUrl: (query) => `${cfg.base}/?q=${encodeURIComponent(query)}`,
        parse: (body) => {
            if (!body) return [];
            const hits: ProviderHit[] = [];

            for (const row of iterMatches(NYAA_ROW_RE, body)) {
                const rowHtml = row[1];

                const view = rowHtml.match(NYAA_VIEW_RE);
                if (!view) continue; // 没有详情链的行不是数据行
                const viewHref = view[1];
                const id = view[2];

                // 标题优先取锚的 title 属性：锚内文本可能被站点截断或含高亮标签，
                // title 是站点给的完整原文。两者都拿不到才由组装器给占位名。
                const titleAttr = rowHtml.match(NYAA_VIEW_TITLE_RE);
                const title = stripTags(titleAttr ? titleAttr[1] : view[3]);

                const magnetMatch = rowHtml.match(NYAA_MAGNET_RE);
                const magnet = magnetMatch ? stripTags(magnetMatch[1]) : '';

                const torrentMatch = rowHtml.match(NYAA_TORRENT_RE);
                // 行内没有种子直链 = 站点自己就没有（死种只留 magnet），不再按 id 硬拼一个。
                // 实测 sukebei `?q=nitroplus` 页 14 行只有 3 行带真直链，硬拼出来的 11 个
                // 必然 404：每次下载先白打一发请求才回落到 magnet，还可能把失败报成下载错误。
                const torrent = torrentMatch ? absolutize(torrentMatch[1], cfg.base) : '';

                const categoryAlt = rowHtml.match(NYAA_CATEGORY_ALT_RE) || rowHtml.match(NYAA_CATEGORY_ALT_RE2);

                // 体积/日期/做种/吸血/完成是数据行末尾的连续单元格。
                // 从后往前取更稳：前面的分类与标题单元格数量可能变化。
                const tail = cellsOf(rowHtml).slice(-5);
                let sizeBytes = UNKNOWN;
                let sizeText = '';
                let publishedAt = UNKNOWN;

                for (const cell of tail) {
                    const text = stripTags(cell);
                    if (!sizeText && /[\d.]+\s*[KMGT]?i?B\b/i.test(text)) {
                        sizeText = text;
                        sizeBytes = parseSizeBytes(text);
                        continue;
                    }
                    const tsAttr = cell.match(NYAA_TIMESTAMP_RE);
                    if (tsAttr) {
                        publishedAt = parseTimestamp(Number(tsAttr[1]));
                        continue;
                    }
                    if (publishedAt === UNKNOWN && /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text)) {
                        publishedAt = parseDateText(text);
                    }
                }

                // 末尾三个纯数字单元格依次是 seeders / leechers / completed。
                // 少于三个说明站点没采集全，缺的一律 UNKNOWN。
                const nums = tail.map((c) => toInt(stripTags(c))).filter((n) => n !== UNKNOWN);
                let seeders = UNKNOWN;
                let leechers = UNKNOWN;
                let completed = UNKNOWN;
                if (nums.length >= 3) {
                    seeders = nums[nums.length - 3];
                    leechers = nums[nums.length - 2];
                    completed = nums[nums.length - 1];
                } else if (nums.length === 2) {
                    seeders = nums[0];
                    leechers = nums[1];
                } else if (nums.length === 1) {
                    seeders = nums[0];
                }

                hits.push(makeHit({
                    id,
                    title,
                    magnet,
                    torrent,
                    viewUrl: absolutize(viewHref, cfg.base),
                    sizeBytes,
                    sizeText,
                    seeders,
                    leechers,
                    completed,
                    publishedAt,
                    category: categoryAlt ? stripTags(categoryAlt[1]) : '',
                }));
            }

            return hits;
        },
    });
}

/** nyaa.si：表区（全年龄） */
export const nyaaProvider = createNyaaProvider({
    id: 'nyaa',
    label: 'Nyaa 表区',
    base: 'https://nyaa.si',
    adult: false,
    kinds: ['动画', '漫画', '音乐', '软件'],
});

/** sukebei.nyaa.si：里区（成人）。页面域名用 .si，理由见本节开头 */
export const sukebeiProvider = createNyaaProvider({
    id: 'sukebei',
    label: 'Sukebei 里区',
    base: 'https://sukebei.nyaa.si',
    adult: true,
    kinds: ['成人', '同人志', '图包'],
});

/* --------------------------------------------------------------------------
 * apibay：The Pirate Bay 的公开 JSON 接口
 * --------------------------------------------------------------------------
 *
 * 最省事的一类数据源：纯 JSON，字段规整，不需要解析 HTML。它同时验证了引擎的
 * 数据源无关性——同一个引擎既吃 HTML 也吃 JSON。
 *
 * 实测响应（https://apibay.org/q.php?q=…）：
 * [
 *   {
 *     "id": "5316077",
 *     "name": "Big.Buck.Bunny.BDRip.XviD-MEDiC",
 *     "info_hash": "C39FE3EEFBDB62DA9C27EB6398FF4A7D2E26E7AB",
 *     "leechers": "1", "seeders": "0",
 *     "size": "183567938",          ← 纯字节数字符串
 *     "added": "1264712003",        ← epoch 秒
 *     "category": "204"
 *   }, …
 * ]
 *
 * 三个要点：
 * 1. **没有 magnet**，只给 info_hash —— 磁链由本地拼出（见 buildMagnet）。
 * 2. 接口不提供完成数，记 UNKNOWN。
 * 3. 无结果时返回 `[{"id":"0","name":"No results returned",…}]` 这种占位行，
 *    必须识别并丢弃，否则列表里会出现一条假结果。
 */

/** 注意：页面挂在 thepiratebay.org，接口在 apibay.org，两者不能混用一个域名。 */
const APIBAY_BASE = 'https://apibay.org';
const APIBAY_HOME = 'https://thepiratebay.org';

/** TPB 的分类 id → 可读文本。只列常用的，未知 id 原样显示。 */
const APIBAY_CATEGORY_NAMES: Record<string, string> = {
    '101': '音频', '102': '音频 - 无损', '103': '音频 - 有损', '104': '音频 - 其他',
    '201': '视频', '202': '视频 - 电影', '203': '视频 - 音乐视频', '204': '视频 - 影视片段',
    '205': '视频 - 电视剧', '206': '视频 - 手持', '207': '视频 - 高清电影', '208': '视频 - 高清剧集',
    '209': '视频 - 3D',
    '301': '应用', '302': '应用 - Windows', '303': '应用 - Mac', '304': '应用 - UNIX',
    '305': '应用 - 手持', '306': '应用 - iOS', '307': '应用 - 安卓',
    '401': '游戏', '402': '游戏 - PC', '403': '游戏 - Mac', '404': '游戏 - PS', '405': '游戏 - Xbox',
    '406': '游戏 - Wii', '407': '游戏 - 手持', '408': '游戏 - iOS', '409': '游戏 - 安卓',
    '501': '成人', '502': '成人 - 影视', '503': '成人 - 图片', '504': '成人 - 文本',
    '505': '成人 - 其他', '506': '成人 - 视频', '507': '成人 - 高清',
    '601': '其他', '602': '其他 - 电子书', '603': '其他 - 漫画', '604': '其他 - 图片',
    '605': '其他 - 素材', '606': '其他 - 字幕',
};

interface ApibayRow {
    id?: string;
    name?: string;
    info_hash?: string;
    seeders?: string | number;
    leechers?: string | number;
    size?: string | number;
    added?: string | number;
    category?: string;
}

export const apibayProvider: SiteProvider = defineProvider({
    id: 'apibay',
    label: 'The Pirate Bay',
    homepage: APIBAY_HOME,
    kinds: ['影视', '音乐', '软件', '游戏'],
    buildSearchUrl: (query) => `${APIBAY_BASE}/q.php?q=${encodeURIComponent(query)}`,
    parse: (body) => {
        if (!body) return [];
        let rows: unknown;
        try {
            rows = JSON.parse(body);
        } catch (_e) {
            // 非 JSON：接口被拦截或返回了错误页。返回空数组，由引擎记为该站 0 条。
            return [];
        }
        if (!Array.isArray(rows)) return [];

        const hits: ProviderHit[] = [];
        for (const raw of rows as ApibayRow[]) {
            const id = String(raw?.id ?? '').trim();
            const name = String(raw?.name ?? '').trim();
            // 无结果占位行：id 为 "0" 且 name 形如 "No results returned"
            if (!id || id === '0') continue;
            if (/^no results? returned$/i.test(name)) continue;
            // 有 name 但无 info_hash 的行无法下载，丢弃
            const infoHash = String(raw?.info_hash ?? '').trim().toLowerCase();
            if (!infoHash) continue;

            const sizeBytes = toInt(raw.size);
            hits.push(makeHit({
                id,
                title: name,
                magnet: buildMagnet(infoHash, name),
                // apibay 不提供种子文件直链；有 info_hash 就能起任务，torrent 留空
                viewUrl: `${APIBAY_HOME}/description.php?id=${id}`,
                sizeBytes,
                sizeText: sizeBytes === UNKNOWN ? '' : formatBytes(sizeBytes),
                seeders: toInt(raw.seeders),
                leechers: toInt(raw.leechers),
                publishedAt: parseTimestamp(raw.added as string | number),
                category: APIBAY_CATEGORY_NAMES[String(raw.category ?? '')]
                    || (raw.category ? `分类 ${raw.category}` : ''),
                infoHash,
            }));
        }
        return hits;
    },
});

/* --------------------------------------------------------------------------
 * animetosho：英文动漫资源聚合
 * --------------------------------------------------------------------------
 *
 * 实测结构（https://animetosho.org/search?q=…）：
 *
 *   <div class="home_list_datesep">05/05/2026</div>
 *   <div class="home_list_entry home_list_entry_alt home_list_entry_compl_-1">
 *     <div class="date" title="Date/time submitted: 05/05/2026 20:50">20:50</div>
 *     <div class="size" title="Total file size: 33,343,733,854 bytes">31.05 GB</div>
 *     <div class="link"><a href="https://animetosho.org/view/….n2106580">标题</a></div>
 *     <div class="links">
 *       <a href="https://animetosho.org/storage/torrent/….torrent" class="dllink">Torrent</a>
 *       <a href="magnet:?xt=urn:btih:F7JBGPZI7PJJAINXOXAXZDQ46WWOXGQV&amp;tr=…">Magnet</a>
 *       <span title="Seeders: 1 / Leechers: 242">[1↑/242↓]</span>
 *       <em>(10 files)</em>
 *     </div>
 *   </div>
 *
 * 四个要点：
 * 1. **精确字节数在 size 的 title 属性里**（"33,343,733,854 bytes"），
 *    正文的 "31.05 GB" 是四舍五入后的。取 title 更准。
 * 2. **日期分成两处**：列表按天分组（home_list_datesep 给 "DD/MM/YYYY"），
 *    条目内只有时刻 "20:50"。完整时间在 date 的 title 里，取它。
 * 3. **做种/吸血在 title 属性里**（"Seeders: 1 / Leechers: 242"），正文是图标形式。
 * 4. 磁链同样是 **base32** btih，统一成 hex 后才能与 nyaa 结果去重。
 *
 * 条目边界：每个 home_list_entry 是一个条目，用 split 切比正则回溯更稳
 * （条目内部嵌套多层 div，非贪婪匹配容易在中间截断）。
 */

/** 条目切分：按 class 里的 home_list_entry 切开（split 用，不带 g） */
const ANIMETOSHO_ENTRY_RE = /<div class="home_list_entry[^"]*">/i;
/** 日期分组标记，出现在条目之前 */
const ANIMETOSHO_DATESEP_RE = /<div class="home_list_datesep">([^<]*)<\/div>/gi;
const ANIMETOSHO_LINK_RE = /<div class="link"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
const ANIMETOSHO_TORRENT_RE = /<a href="([^"]+\.torrent)"[^>]*class="dllink"/i;
const ANIMETOSHO_MAGNET_RE = /<a href="(magnet:\?[^"]+)"/i;
const ANIMETOSHO_SIZE_RE = /<div class="size"[^>]*title="Total file size:\s*([\d,]+)\s*bytes"[^>]*>([^<]*)<\/div>/i;
/** 完整时间（date 的 title 属性）。"Date/time" 里的斜杠必须转义，否则会提前结束正则字面量 */
const ANIMETOSHO_DATE_RE = /<div class="date"[^>]*title="Date\/time submitted:\s*([^"]+)"/i;
const ANIMETOSHO_PEERS_RE = /title="Seeders:\s*(\d+)\s*\/\s*Leechers:\s*(\d+)"/i;
const ANIMETOSHO_FILES_RE = /<em>\((\d+)\s+files?\)<\/em>/i;

/**
 * 详情页地址末尾的 id。实测同一页搜索结果里就混着三种形态
 * （frieren 快照 75 条：`.n<数字>` 60 条、`.k<数字>` 14 条、`.<数字>` 1 条）——
 * n=动画条目，k=其它发布，纯数字是更早的编号。
 * 以前只认 `.n`，另外 15 条整条静默消失（页面 20% 的行）。
 * id 保留类型字母：各张表的编号彼此独立，只留数字理论上会撞。
 */
function animetoshoIdFromUrl(url: string): string {
    const dotted = String(url || '').match(/\.([nk]?)(\d+)$/);
    if (dotted) return `${dotted[1] || ''}${dotted[2]}`;
    const bare = String(url || '').match(/\/(\d+)$/);
    return bare ? bare[1] : '';
}

export const animetoshoProvider: SiteProvider = defineProvider({
    id: 'animetosho',
    label: 'Anime Tosho',
    homepage: 'https://animetosho.org',
    kinds: ['动画', '英文', '聚合'],
    buildSearchUrl: (query) => `https://animetosho.org/search?q=${encodeURIComponent(query)}`,
    parse: (body) => {
        if (!body) return [];

        // 条目按出现顺序切开；第 0 段是首个条目之前的内容（含日期分组标记）
        const segments = body.split(ANIMETOSHO_ENTRY_RE);
        if (segments.length < 2) return [];

        const hits: ProviderHit[] = [];

        for (let i = 1; i < segments.length; i += 1) {
            const seg = segments[i];

            const linkMatch = seg.match(ANIMETOSHO_LINK_RE);
            if (!linkMatch) continue;
            const viewUrl = linkMatch[1];
            const id = animetoshoIdFromUrl(viewUrl);
            if (!id) continue;

            const magnetMatch = seg.match(ANIMETOSHO_MAGNET_RE);
            const magnet = magnetMatch ? stripTags(magnetMatch[1]) : '';
            const torrentMatch = seg.match(ANIMETOSHO_TORRENT_RE);

            // 体积：title 里的精确字节数优先
            const sizeMatch = seg.match(ANIMETOSHO_SIZE_RE);
            let sizeBytes = UNKNOWN;
            let sizeText = '';
            if (sizeMatch) {
                sizeBytes = parseSizeBytes(sizeMatch[1]);
                sizeText = stripTags(sizeMatch[2]);
                // title 解析失败时回落到正文文本
                if (sizeBytes === UNKNOWN) sizeBytes = parseSizeBytes(sizeText);
            }

            // 时间：条目内 date 的 title 给完整时间；缺失时回看之前的日期分组
            const dateMatch = seg.match(ANIMETOSHO_DATE_RE);
            let publishedAt = dateMatch ? parseDateText(dateMatch[1]) : UNKNOWN;
            if (publishedAt === UNKNOWN) {
                let last = '';
                for (const sep of iterMatches(ANIMETOSHO_DATESEP_RE, segments[i - 1] || '')) last = sep[1];
                if (last) publishedAt = parseDateText(last);
            }

            const peersMatch = seg.match(ANIMETOSHO_PEERS_RE);
            const filesMatch = seg.match(ANIMETOSHO_FILES_RE);

            hits.push(makeHit({
                id,
                title: stripTags(linkMatch[2]),
                magnet,
                torrent: torrentMatch ? torrentMatch[1] : '',
                viewUrl,
                sizeBytes,
                sizeText,
                seeders: peersMatch ? Number(peersMatch[1]) : UNKNOWN,
                leechers: peersMatch ? Number(peersMatch[2]) : UNKNOWN,
                publishedAt,
                category: filesMatch ? `${filesMatch[1]} 个文件` : '',
            }));
        }
        return hits;
    },
});

/* --------------------------------------------------------------------------
 * acg.rip：中文 ACG 资源站
 * --------------------------------------------------------------------------
 *
 * 实测结构（https://acg.rip/?term=…）：
 *
 *   <table class="table table-hover table-condensed post-index">
 *     <thead>…</thead>
 *     <tr>
 *       <td class="date hidden-xs hidden-sm">
 *         <div><a href="/user/2">发布者</a></div>
 *         <div><time datetime="1443503793">接近 11 年</time></div>
 *       </td>
 *       <td class="title"><span class="title"><a href="/t/85085">标题</a></span></td>
 *       <td class="action"><a href="/t/85085.torrent">…</a></td>
 *       <td class="size">1.8 GB</td>
 *     </tr>
 *   </table>
 *
 * 三个要点：
 * 1. **只有 .torrent 直链，没有 magnet** —— torrent 有值、magnet 为空，
 *    引擎与 UI 必须接受这种组合（下载走种子文件，不依赖磁链）。
 * 2. **不公布做种/吸血/完成数**，全部记 UNKNOWN（不是 0）。
 * 3. 时间是 <time datetime="epoch秒">，比显示的"接近 11 年"这种相对文本可靠得多。
 */

/** 只扫主结果表，避免把页面别处的链接误当条目 */
const ACGRIP_TABLE_RE = /<table[^>]*class="[^"]*post-index[^"]*"[^>]*>([\s\S]*?)<\/table>/i;
const ACGRIP_ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
/** 标题锚：/t/<id> 形式 */
const ACGRIP_TITLE_RE = /<span[^>]*class="[^"]*title[^"]*"[^>]*>\s*<a[^>]*href="(\/t\/\d+)"[^>]*>([\s\S]*?)<\/a>/i;
const ACGRIP_TORRENT_RE = /href="(\/t\/\d+\.torrent)"/i;
const ACGRIP_TIME_RE = /<time[^>]*datetime="(\d+)"[^>]*>/i;
const ACGRIP_SIZE_RE = /<td[^>]*class="[^"]*size[^"]*"[^>]*>([\s\S]*?)<\/td>/i;

export const acgripProvider: SiteProvider = defineProvider({
    id: 'acgrip',
    label: 'ACG.RIP',
    homepage: 'https://acg.rip',
    kinds: ['动画', '漫画', '音乐', '游戏'],
    buildSearchUrl: (query) => `https://acg.rip/?term=${encodeURIComponent(query)}`,
    parse: (body) => {
        if (!body) return [];
        const table = body.match(ACGRIP_TABLE_RE);
        if (!table) return []; // 无结果或页面结构变了：交给引擎记为 0 条

        const hits: ProviderHit[] = [];
        for (const row of iterMatches(ACGRIP_ROW_RE, table[1])) {
            const rowHtml = row[1];
            const titleMatch = rowHtml.match(ACGRIP_TITLE_RE);
            if (!titleMatch) continue; // 表头行与空行没有标题锚

            const viewPath = titleMatch[1];
            const idMatch = viewPath.match(/(\d+)/);
            const id = idMatch ? idMatch[1] : '';
            if (!id) continue;

            const torrentMatch = rowHtml.match(ACGRIP_TORRENT_RE);
            const timeMatch = rowHtml.match(ACGRIP_TIME_RE);
            const sizeMatch = rowHtml.match(ACGRIP_SIZE_RE);
            const sizeText = sizeMatch ? stripTags(sizeMatch[1]) : '';

            hits.push(makeHit({
                id,
                title: stripTags(titleMatch[2]),
                // 该站不提供磁链，只有种子文件；infoHash 因此也是空串
                torrent: torrentMatch ? absolutize(torrentMatch[1], 'https://acg.rip') : '',
                viewUrl: absolutize(viewPath, 'https://acg.rip'),
                sizeBytes: sizeText ? parseSizeBytes(sizeText) : UNKNOWN,
                sizeText,
                publishedAt: timeMatch ? parseTimestamp(Number(timeMatch[1])) : UNKNOWN,
            }));
        }
        return hits;
    },
});

/* --------------------------------------------------------------------------
 * 动漫花园 share.dmhy.org
 * --------------------------------------------------------------------------
 *
 * 实测结构（https://share.dmhy.org/topics/list?keyword=…）：
 *
 *   <table id="topic_list">
 *     <thead>…</thead>
 *     <tbody>
 *       <tr class="">
 *         <td width="98">2026/08/28 05:32 <span style="display:none">…</span></td>
 *         <td width="6%" align="center"><a class="sort-31" href="/topics/list/sort_id/31">
 *             <b><font color=red>季度全集</font></b></a></td>
 *         <td class="title"><a href="/topics/view/725809_….html">[7³ACG] 葬送的芙莉莲/…</a></td>
 *         <td nowrap align="center">
 *           <a class="download-arrow arrow-magnet" href="magnet:?xt=urn:btih:7BSRIRF…">
 *           <a class="download-xl" data-magnet="magnet:?xt=urn:btih:f8651444…">
 *         </td>
 *         <td nowrap align="center">48.5GB</td>
 *         <td nowrap align="center"><span class="btl_1">-</span></td>  ← 种子
 *         <td nowrap align="center"><span class="bts_1">-</span></td>  ← 下载
 *       </tr>
 *     </tbody>
 *   </table>
 *
 * 四个要点：
 * 1. **磁链是 base32 btih**（32 位字母数字），与 nyaa/apibay 的 40 位 hex 不同。
 *    统一成 hex 由 magnetInfoHash 负责，否则跨站去重认不出同一资源。
 * 2. 行内有**多个磁链来源**：`arrow-magnet` 的 href，以及 `download-xl` 的
 *    data-magnet。href 优先，缺失时回退 data-magnet。
 * 3. 做种/吸血列常显示 `-`（站点未采集），此时记 UNKNOWN 而非 0。
 * 4. 分类是 `<font color=red>季度全集</font>` 这类带样式的中文文本，去标签即可。
 */

const DMHY_TABLE_RE = /<table[^>]*id="topic_list"[^>]*>([\s\S]*?)<\/table>/i;
/** 数据行只取 tbody（表头在 thead 里） */
const DMHY_TBODY_RE = /<tbody>([\s\S]*?)<\/tbody>/i;
const DMHY_ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
/** 标题锚：/topics/view/<id>_<slug>.html */
const DMHY_TITLE_RE = /<td[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="(\/topics\/view\/(\d+)_[^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
const DMHY_MAGNET_HREF_RE = /href="(magnet:\?[^"]+)"/i;
const DMHY_MAGNET_DATA_RE = /data-magnet="(magnet:\?[^"]*)"/i;
/** 发布日期：行首单元格的 YYYY/MM/DD HH:mm */
const DMHY_DATE_RE = /(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})/;
/** 体积：形如 48.5GB / 1.2 GiB 的独立单元格 */
const DMHY_SIZE_RE = /<td[^>]*>\s*([\d.]+\s*[KMGTP]?i?B)\s*<\/td>/i;
/** 分类：分类单元格内的文本（通常是 <font> 或 <a> 里的中文） */
const DMHY_CATEGORY_RE = /<td[^>]*width="6%"[^>]*>([\s\S]*?)<\/td>/i;

export const dmhyProvider: SiteProvider = defineProvider({
    id: 'dmhy',
    label: '动漫花园',
    homepage: 'https://share.dmhy.org',
    kinds: ['动画', '字幕组', '合集'],
    // 该站接受 UTF-8 关键词的百分号编码
    buildSearchUrl: (query) => `https://share.dmhy.org/topics/list?keyword=${encodeURIComponent(query)}`,
    parse: (body) => {
        if (!body) return [];
        const table = body.match(DMHY_TABLE_RE);
        if (!table) return [];
        const tbody = table[1].match(DMHY_TBODY_RE);
        if (!tbody) return [];

        const hits: ProviderHit[] = [];
        for (const row of iterMatches(DMHY_ROW_RE, tbody[1])) {
            const rowHtml = row[1];
            const titleMatch = rowHtml.match(DMHY_TITLE_RE);
            if (!titleMatch) continue;

            // 磁链：href 优先，data-magnet 兜底
            const magnetHref = rowHtml.match(DMHY_MAGNET_HREF_RE);
            const magnetData = rowHtml.match(DMHY_MAGNET_DATA_RE);
            const magnet = stripTags((magnetHref && magnetHref[1]) || (magnetData && magnetData[1]) || '');

            const dateMatch = rowHtml.match(DMHY_DATE_RE);
            const sizeMatch = rowHtml.match(DMHY_SIZE_RE);
            const sizeText = sizeMatch ? stripTags(sizeMatch[1]) : '';
            const catMatch = rowHtml.match(DMHY_CATEGORY_RE);

            hits.push(makeHit({
                id: titleMatch[2],
                title: stripTags(titleMatch[3]),
                magnet,
                // 该站不直接给 .torrent 直链（详情页里才有），留空
                viewUrl: absolutize(titleMatch[1], 'https://share.dmhy.org'),
                sizeBytes: sizeText ? parseSizeBytes(sizeText) : UNKNOWN,
                sizeText,
                // 做种/吸血/完成：列表页通常显示 "-"，组装器记 UNKNOWN
                publishedAt: dateMatch ? parseDateText(dateMatch[1]) : UNKNOWN,
                category: catMatch ? stripTags(catMatch[1]) : '',
            }));
        }
        return hits;
    },
});

/* ==========================================================================
 * 五、注册表
 * ==========================================================================
 *
 * 引擎通过这里认识站点，UI 通过这里列出分区内的站点。
 *
 * 分区判据只有一个：descriptor.adult。false = 表站，true = 里站。
 * 一次搜索只打一个分区，所以这里不再接受"勾选了哪几个站"——子站点在 UI 里
 * 只能查看，不能挑。加站点时写对 adult 就自动进对的分区。
 *
 * 数组顺序即分区内的展示顺序。
 */
const PROVIDERS: SiteProvider[] = [
    nyaaProvider,
    apibayProvider,
    animetoshoProvider,
    acgripProvider,
    dmhyProvider,
    sukebeiProvider,
];

/** id → provider */
const registry = new Map<string, SiteProvider>(PROVIDERS.map((p) => [p.descriptor.id, p]));

/** 站点属于哪个分区。adult 是唯一判据，不再多一个可能与之矛盾的字段 */
export function groupOf(descriptor: SiteDescriptor): SiteGroup {
    return descriptor.adult ? 'nsfw' : 'sfw';
}

/** 某个分区的 provider（引擎扇出用） */
export function providersFor(group: SiteGroup): SiteProvider[] {
    return PROVIDERS.filter((p) => groupOf(p.descriptor) === group);
}

/** 某个分区的站点描述（UI 只读列出用） */
export function sitesFor(group: SiteGroup): SiteDescriptor[] {
    return providersFor(group).map((p) => p.descriptor);
}

/** 全部已注册站点（跨分区，仅用于展示与遍历） */
export function listSites(): SiteDescriptor[] {
    return PROVIDERS.map((p) => p.descriptor);
}

/** 按 id 取 provider；未知 id 返回 null（调用方决定是忽略还是报错） */
export function getProvider(id: string): SiteProvider | null {
    return registry.get(id) || null;
}

/** 全部 provider（跨分区，遍历/测试用；搜索请用 providersFor） */
export function allProviders(): SiteProvider[] {
    return PROVIDERS;
}

/* ==========================================================================
 * 六、传输：默认实现走渲染层 fetch
 * ==========================================================================
 *
 * 为什么用渲染层 fetch 而不是走主进程 IPC：
 *
 * 1. **代理自动生效**。代理是配在 Chromium 会话上的（主进程
 *    session.defaultSession.setProxy），渲染层 fetch 走的就是 Chromium 网络栈，
 *    因此自动吃到代理，无需任何额外接线。
 *    对比：主进程用 Node 的 https.get 裸请求不传 agent，代理对它完全无效——
 *    配好 SOCKS5 后照样 ECONNRESET，而同一时刻同一地址走 Chromium 栈就正常。
 *
 * 2. **跨域不受限**。主窗口 webSecurity 为 false，跨站请求不会被同源策略拦下，
 *    所以搜索服务可以完整地待在渲染层，不必为了发一个请求而绕道 IPC。
 *
 * 3. **可替换**。Transport 是接口，测试注入假实现即可离线跑完整流程；
 *    将来若某个站需要过 Cloudflare 挑战（要开 BrowserWindow + CDP），
 *    只需另写一个实现，引擎与全部 provider 一行都不用改。
 */

/** 单站请求超时：扇出搜索里一个站卡住不该拖住整体 */
const REQUEST_TIMEOUT_MS = 12000;

const DEFAULT_HEADERS: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

export class FetchTransport implements Transport {
    async get(req: TransportRequest): Promise<TransportResponse> {
        const timeoutMs = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : REQUEST_TIMEOUT_MS;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(req.url, {
                method: 'GET',
                headers: { ...DEFAULT_HEADERS, ...(req.headers || {}) },
                signal: controller.signal,
                credentials: 'omit',
                redirect: 'follow',
                // 这里刻意不传 referrer 选项：按 fetch 规范它只接受同源地址或 about:client，
                // 传跨域地址会直接抛 TypeError。而各 provider 的 Referer 是站点自身域名，
                // 从应用页发起必然跨域——一传就所有站点全挂。
                //
                // Referer 也不能放进 headers：它是 fetch 的禁止头，会被静默丢弃。
                // 所以 provider.headers 里的 Referer 实际不生效；实测这些站点不校验来源，
                // 去掉无影响。若将来某个站确实要求 Referer，那条请求必须改走主进程
                // （Electron 的 net.fetch 允许设置该头），届时只需换一个 Transport 实现。
            });
            const body = await res.text();
            return {
                ok: res.ok,
                status: res.status,
                body,
                finalUrl: res.url || req.url,
            };
        } catch (err: any) {
            // 超时与网络错误都归一成"这次请求失败"，由引擎记进站点状态里。
            // 不往上抛：一个站失败不该让整次扇出搜索失败。
            const aborted = err?.name === 'AbortError';
            return {
                ok: false,
                status: 0,
                body: '',
                finalUrl: req.url,
                ...(aborted ? { error: `请求超时（${timeoutMs}ms）` } : { error: err?.message || '网络错误' }),
            } as TransportResponse;
        } finally {
            clearTimeout(timer);
        }
    }
}

/** 共享实例：transport 无状态，无需每次新建 */
export const fetchTransport = new FetchTransport();

/* ==========================================================================
 * 七、引擎
 * ==========================================================================
 *
 * 职责（全部与具体站点无关）：
 *   扇出 → 并发 → 单站超时 → 解析 → 归一化 → 跨站去重 → 排序 → 汇总状态
 *
 * 三条设计原则：
 *
 * 1. **单站失败不拖垮整体**。用户搜一次要的是"能搜到的都搜到"，
 *    而不是"有一个站挂了就什么都没有"。失败的站在 sites 里带原因上报，
 *    成功的站结果照常返回。这跟单站时代"一次请求失败就整个失败"是本质区别。
 *
 * 2. **不重试**。扇出场景下重试的代价是成倍放大（N 个站 × M 次重试 × 退避），
 *    而用户随时可以再点一次搜索。单站超时设短（12s），快速给出部分结果
 *    比让用户等一个慢站更符合搜索的交互预期。
 *
 * 3. **归一化在 provider 里完成**，引擎只做跨站的事（去重、排序、盖章）。
 *    引擎不解析任何站点格式，因此站点改版不会波及引擎。
 */

/** 跨站去重键：优先 info hash，缺失时回落到归一化标题 */
function dedupeKey(hit: SearchHit): string {
    if (hit.infoHash) return `h:${hit.infoHash}`;
    const norm = normalizeTitle(hit.title);
    return norm ? `t:${norm}` : `s:${hit.site}:${hit.id}`;
}

/** 重复条目里保留"信息更全"的那条：做种数已知 +2，体积已知 +1，有磁链 +1 */
function completeness(hit: SearchHit): number {
    return (hit.seeders !== UNKNOWN ? 2 : 0)
        + (hit.sizeBytes !== UNKNOWN ? 1 : 0)
        + (hit.magnet ? 1 : 0);
}

/**
 * 跨站去重。
 *
 * 同一条资源常同时出现在多个站（实测 nyaa 与 animetosho 索引大量重叠）。
 * 这样用户看到的是去重后的列表，而不是同一资源刷屏。
 */
function dedupe(hits: SearchHit[]): SearchHit[] {
    const best = new Map<string, SearchHit>();
    for (const hit of hits) {
        const key = dedupeKey(hit);
        const prev = best.get(key);
        if (!prev || completeness(hit) > completeness(prev)) best.set(key, hit);
    }
    return Array.from(best.values());
}

/**
 * 把未知值（-1）映射到排序键，使其在降序排序中落到末尾。
 * 直接参与比较的话 -1 会被当成"最小"，但它的语义是"站点没公布"，
 * 不该因此排在已知为 0 做种的条目之后——那是两种不同的信息。
 *
 * 必须用**有限**数而不是 -Infinity。比较式统一写成 `rank(b) - rank(a)`，
 * 两条都未知时就是 `-Infinity - (-Infinity)` = **NaN**，直接违反
 * Array.prototype.sort 的比较器契约（必须返回负数/0/正数）。
 *
 * 实测说明（不要夸大也不要忽视）：当前 V8 的 TimSort 对 NaN 相当宽容，
 * 用 3000 组随机数据跑"已知在前、未知在后"的断言并未复现出乱序。
 * 但这是**实现细节，不是契约**——排序算法一换（或数组规模跨过 TimSort 的
 * run 阈值）就可能变。取一个比任何真实值都小、相减又不会溢出的有限哨兵，
 * 成本为零且把这条不确定性彻底消掉；未知项之间差为 0，天然满足"相等即返回
 * 0"，排序因此是确定的。
 */
const UNKNOWN_RANK = -Number.MAX_SAFE_INTEGER;

function rank(value: number): number {
    return value === UNKNOWN ? UNKNOWN_RANK : value;
}

/**
 * 排序比较器。导出供测试直接断言其契约（见 test/search.test.js）：
 * 只测"最终顺序"抓不到 NaN——V8 会把 NaN 当成"不大于"，结果碰巧仍是对的。
 */
export function compareBy(sort: SearchSort): (a: SearchHit, b: SearchHit) => number {
    switch (sort) {
        case 'size':
            return (a, b) => rank(b.sizeBytes) - rank(a.sizeBytes);
        case 'date':
            return (a, b) => rank(b.publishedAt) - rank(a.publishedAt);
        case 'site':
            return (a, b) => a.siteLabel.localeCompare(b.siteLabel) || rank(b.seeders) - rank(a.seeders);
        case 'seeders':
        default:
            return (a, b) => rank(b.seeders) - rank(a.seeders);
    }
}

/** 单站搜索：取字节 → 解析 → 盖站点章。任何失败都转成状态上报，不抛。 */
async function searchOneSite(
    provider: SiteProvider,
    query: string,
    transport: Transport,
    timeoutMs: number
): Promise<{ hits: SearchHit[]; status: SearchSiteStatus }> {
    const { id, label } = provider.descriptor;
    const startedAt = Date.now();
    const failed = (error: string): { hits: SearchHit[]; status: SearchSiteStatus } => ({
        hits: [],
        status: { site: id, label, ok: false, count: 0, elapsedMs: Date.now() - startedAt, error },
    });

    let url = '';
    try {
        url = provider.buildSearchUrl(query);
    } catch (err: any) {
        return failed(`构造搜索地址失败：${err?.message || err}`);
    }

    let res;
    try {
        res = await transport.get({ url, headers: provider.headers, timeoutMs });
    } catch (err: any) {
        // transport 约定不抛，但自定义实现可能抛；这里兜住，保证扇出不被单站带崩
        return failed(err?.message || '请求失败');
    }

    if (!res.ok) return failed(res.error || (res.status ? `HTTP ${res.status}` : '请求失败'));

    let parsed: ProviderHit[];
    try {
        parsed = provider.parse(res.body, { url: res.finalUrl || url, query });
    } catch (err: any) {
        // 解析器抛错说明站点结构变了（或返回了意料之外的内容）。
        // 报出来比静默返回空结果好——空结果会被误读成"这个站没有该资源"。
        return failed(`解析失败（站点结构可能已变）：${err?.message || err}`);
    }

    // 盖站点章：provider 不自己填 site/siteLabel，避免同一站点名在两处各写一遍
    const hits: SearchHit[] = parsed.map((h) => ({ ...h, site: id, siteLabel: label }));
    return {
        hits,
        status: { site: id, label, ok: true, count: hits.length, elapsedMs: Date.now() - startedAt },
    };
}

/**
 * 扇出搜索：并发查询选定分区内的全部站点，汇总归一化结果。
 *
 * group 必选：表站 or 里站。缺失或非法值直接失败并说清原因，不静默按某个分区搜
 * ——用户以为搜的是里站、实际搜了表站，比报错更难排查。
 *
 * 返回的 SearchResult 里 sites 数组带每站的成功/失败与耗时，
 * UI 据此告诉用户"哪几站搜到了、哪几站没搜到、为什么"——
 * 这是扇出搜索的必要信息：只给一个合并列表，用户无法判断
 * "没有我要的资源"和"有个站挂了"的区别。
 */
export async function search(
    query: SearchQuery,
    transport: Transport = fetchTransport
): Promise<SearchResult> {
    const startedAt = Date.now();
    const q = String(query?.q || '').trim();

    if (!q) {
        return { success: false, message: '请输入搜索关键词', hits: [], sites: [], elapsedMs: 0 };
    }

    if (query.group !== 'sfw' && query.group !== 'nsfw') {
        return { success: false, message: '请先选择表站或里站', hits: [], sites: [], elapsedMs: 0 };
    }

    const providers = providersFor(query.group);
    if (providers.length === 0) {
        return { success: false, message: '没有可用的搜索站点', hits: [], sites: [], elapsedMs: 0 };
    }

    const limitPerSite = Number(query.limitPerSite) > 0 ? Number(query.limitPerSite) : 0;

    // 并发扇出。用 allSettled 而非 all：单站异常不该让整体 reject，
    // 而 searchOneSite 已把错误转成状态，这里再兜一层。
    const settled = await Promise.allSettled(
        providers.map((p) => searchOneSite(p, q, transport, REQUEST_TIMEOUT_MS))
    );

    const allHits: SearchHit[] = [];
    const sites: SearchSiteStatus[] = [];

    settled.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
            const { hits, status } = result.value;
            allHits.push(...(limitPerSite > 0 ? hits.slice(0, limitPerSite) : hits));
            sites.push(status);
        } else {
            const { id, label } = providers[idx].descriptor;
            sites.push({
                site: id,
                label,
                ok: false,
                count: 0,
                elapsedMs: 0,
                error: result.reason?.message || '未知错误',
            });
        }
    });

    let hits = dedupe(allHits);

    // 做种数过滤：只过滤"明确低于阈值"的，未知（-1）保留——
    // 把未知当 0 会把 acg.rip / dmhy 这类不公布做种数的站整个滤掉。
    const minSeeders = Number(query.minSeeders) || 0;
    if (minSeeders > 0) {
        hits = hits.filter((h) => h.seeders === UNKNOWN || h.seeders >= minSeeders);
    }

    hits = hits.slice().sort(compareBy(query.sort || 'seeders'));

    const okCount = sites.filter((s) => s.ok).length;
    const failed = sites.filter((s) => !s.ok);

    return {
        success: true,
        hits,
        sites,
        elapsedMs: Date.now() - startedAt,
        message: failed.length
            ? `${okCount}/${sites.length} 个站点返回结果，${failed.length} 个失败`
            : `${okCount} 个站点全部返回结果`,
    };
}
