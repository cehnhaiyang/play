import type { ProviderHit, SiteProvider, ParseContext } from '../types';
import {
    UNKNOWN, stripTags, parseSizeBytes, parseTimestamp, parseDateText,
    magnetInfoHash, buildMagnet, absolutize,
} from '../util';

/**
 * ============================================================================
 * Nyaa 系站点插件（nyaa.si 表区 / sukebei.nyaa.site 里区）
 * ============================================================================
 *
 * 这两个站跑的是同一套 Nyaa 程序，HTML 结构逐字段一致，实测确认：
 *
 *   <tr class="default">
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
 * 差异只有三处，都收在下面的配置里：
 *   1. 域名不同；
 *   2. sukebei 用绝对地址（https://sukebei.nyaa.site/view/…），nyaa 用相对地址（/view/…）；
 *   3. **种子直链的域名不同**——sukebei 页面挂在 .site，下载链却指向 sukebei.nyaa.si；
 *      nyaa.si 页面则是相对地址。所以下载链不能按页面域名硬拼。
 *
 * 因为结构一致，这里一个解析器服务两个站点实例——这本身就是"引擎不认识站点、
 * 站点只是插口"的直接体现：同一份特化代码可以被多个站点复用。
 */

/** 行定位：Nyaa 给数据行固定加 class="default"（表头行没有） */
const ROW_RE = /<tr[^>]*class="[^"]*\bdefault\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;

/** 详情页链接：绝对或相对都接受，从中抠出数字 id，并捕获锚内文本作为标题兜底 */
const VIEW_RE = /<a[^>]*href="((?:https?:\/\/[^"/]+)?\/view\/(\d+))"[^>]*>([\s\S]*?)<\/a>/i;
/** 同一个锚上的 title 属性（站点给的完整原文，优先于锚内文本） */
const VIEW_TITLE_ATTR_RE = /<a[^>]*href="(?:https?:\/\/[^"/]+)?\/view\/\d+"[^>]*\stitle="([^"]*)"/i;
/** 磁链 */
const MAGNET_RE = /href="(magnet:\?[^"]+)"/i;
/** 种子直链：绝对或相对都接受 */
const TORRENT_RE = /href="((?:https?:\/\/[^"]+)?\/download\/\d+\.torrent)"/i;
/**
 * 分类：取分类图标的 alt 文本。
 * 属性顺序两种都要认——实测 nyaa/sukebei 给的是 `alt="…" class="category-icon"`
 * （alt 在前），但属性顺序不受规范约束，站点改版时可能调换。
 */
const CATEGORY_ALT_RE = /<img[^>]*class="category-icon"[^>]*alt="([^"]*)"/i;
const CATEGORY_ALT_RE_ALT = /<img[^>]*alt="([^"]*)"[^>]*class="category-icon"/i;

/** 数据行里按顺序排列的 <td> */
function cellsOf(rowHtml: string): string[] {
    const out: string[] = [];
    const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rowHtml)) !== null) out.push(m[1]);
    return out;
}

/** 数字单元格 → 整数；"-" 或非数字返回 UNKNOWN（站点未公布） */
function numberCell(html: string): number {
    const text = stripTags(html);
    if (!text || text === '-') return UNKNOWN;
    const n = Number(text.replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : UNKNOWN;
}

export interface NyaaSiteConfig {
    id: string;
    label: string;
    /** 页面所在域名，用于补全相对地址与拼搜索地址 */
    base: string;
    /** 种子直链域名（sukebei 页面在 .site、下载链在 .si，必须分开配） */
    downloadBase: string;
    adult: boolean;
    kinds: string[];
}

export function createNyaaProvider(cfg: NyaaSiteConfig): SiteProvider {
    return {
        descriptor: {
            id: cfg.id,
            label: cfg.label,
            homepage: cfg.base,
            adult: cfg.adult,
            kinds: cfg.kinds,
        },
        // Nyaa 的搜索参数：q=关键词。不带分类与排序时站点按默认（最新）返回，
        // 跨站搜索不该替用户预设分类——各站分类编码互不通用。
        buildSearchUrl(query: string): string {
            return `${cfg.base}/?q=${encodeURIComponent(query)}`;
        },
        headers: { Referer: `${cfg.base}/` },

        parse(body: string, _ctx: ParseContext): ProviderHit[] {
            if (!body) return [];
            const hits: ProviderHit[] = [];
            ROW_RE.lastIndex = 0;
            let row: RegExpExecArray | null;

            while ((row = ROW_RE.exec(body)) !== null) {
                const rowHtml = row[1];

                const view = rowHtml.match(VIEW_RE);
                if (!view) continue; // 没有详情链的行不是数据行
                const viewHref = view[1];
                const id = view[2];

                // 标题优先取锚的 title 属性：锚内文本可能被站点截断或含高亮标签，
                // title 属性是站点给的完整原文。两者都拿不到才回落到占位名。
                const titleAttr = rowHtml.match(VIEW_TITLE_ATTR_RE);
                const title = stripTags(titleAttr ? titleAttr[1] : view[3]) || `torrent-${id}`;

                const magnetMatch = rowHtml.match(MAGNET_RE);
                const magnet = magnetMatch ? stripTags(magnetMatch[1]) : '';

                const torrentMatch = rowHtml.match(TORRENT_RE);
                let torrent = '';
                if (torrentMatch) {
                    // 相对地址用 downloadBase 补全（不是页面域名：sukebei 的下载链在 .si）
                    torrent = absolutize(torrentMatch[1], cfg.downloadBase);
                } else {
                    torrent = `${cfg.downloadBase}/download/${id}.torrent`;
                }

                const categoryAlt = rowHtml.match(CATEGORY_ALT_RE) || rowHtml.match(CATEGORY_ALT_RE_ALT);
                const category = categoryAlt ? stripTags(categoryAlt[1]) : '';

                // 体积/日期/做种/吸血/完成是数据行末尾的连续单元格。
                // 从后往前取更稳：前面的分类与标题单元格数量可能变化。
                const cells = cellsOf(rowHtml);
                const tail = cells.slice(-5);
                let sizeBytes = UNKNOWN;
                let sizeText = '';
                let publishedAt = UNKNOWN;
                let seeders = UNKNOWN;
                let leechers = UNKNOWN;
                let completed = UNKNOWN;

                for (const cell of tail) {
                    const text = stripTags(cell);
                    if (!sizeText && /[\d.]+\s*[KMGT]?i?B\b/i.test(text)) {
                        sizeText = text;
                        sizeBytes = parseSizeBytes(text);
                        continue;
                    }
                    // 日期单元格：nyaa 带 data-timestamp（epoch 秒），比文本更精确
                    const tsAttr = cell.match(/data-timestamp="(\d+)"/i);
                    if (tsAttr) {
                        publishedAt = parseTimestamp(Number(tsAttr[1]));
                        continue;
                    }
                    if (publishedAt === UNKNOWN && /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text)) {
                        publishedAt = parseDateText(text);
                    }
                }

                // 末尾三个纯数字单元格依次是 seeders / leechers / completed
                const nums = tail.map(numberCell).filter((n) => n !== UNKNOWN);
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

                hits.push({
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
                    category,
                    infoHash: magnetInfoHash(magnet),
                });
            }

            return hits;
        },
    };
}

/** nyaa.si：表区（全年龄） */
export const nyaaProvider = createNyaaProvider({
    id: 'nyaa',
    label: 'Nyaa 表区',
    base: 'https://nyaa.si',
    downloadBase: 'https://nyaa.si',
    adult: false,
    kinds: ['动画', '漫画', '音乐', '软件'],
});

/** sukebei：里区（成人） */
export const sukebeiProvider = createNyaaProvider({
    id: 'sukebei',
    label: 'Sukebei 里区',
    base: 'https://sukebei.nyaa.site',
    downloadBase: 'https://sukebei.nyaa.si',
    adult: true,
    kinds: ['成人', '同人志', '图包'],
});
