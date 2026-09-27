import type { ProviderHit, SiteProvider, ParseContext } from '../types';
import { UNKNOWN, stripTags, parseSizeBytes, parseDateText, magnetInfoHash } from '../util';

/**
 * ============================================================================
 * Anime Tosho 插件（英文动漫资源聚合）
 * ============================================================================
 *
 * 实测结构（https://animetosho.org/search?q=…）：
 *
 *   <div class="home_list_datesep">05/05/2026</div>
 *   <div class="home_list_entry home_list_entry_alt home_list_entry_compl_-1">
 *     <div class="date" title="Date/time submitted: 05/05/2026 20:50">20:50</div>
 *     <div class="size" title="Total file size: 33,343,733,854 bytes">31.05 GB</div>
 *     <div class="link"><a href="https://animetosho.org/view/…​.n2106580">标题</a></div>
 *     <div class="links">
 *       <a href="https://animetosho.org/storage/torrent/…​.torrent" class="dllink">Torrent</a>
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

/** 条目切分：按 class 里的 home_list_entry 切开 */
const ENTRY_SPLIT_RE = /<div class="home_list_entry[^"]*">/i;
/** 日期分组标记，出现在条目之前 */
const DATESEP_RE = /<div class="home_list_datesep">([^<]*)<\/div>/gi;

/** 条目内：标题与详情页 */
const LINK_RE = /<div class="link"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
/** 条目内：种子直链 */
const TORRENT_RE = /<a href="([^"]+\.torrent)"[^>]*class="dllink"/i;
/** 条目内：磁链 */
const MAGNET_RE = /<a href="(magnet:\?[^"]+)"/i;
/** 条目内：体积（正文 + title 里的精确字节数） */
const SIZE_RE = /<div class="size"[^>]*title="Total file size:\s*([\d,]+)\s*bytes"[^>]*>([^<]*)<\/div>/i;
/** 条目内：完整时间（date 的 title 属性）。注意 "Date/time" 里的斜杠必须转义，
 *  否则会提前结束正则字面量 */
const DATE_RE = /<div class="date"[^>]*title="Date\/time submitted:\s*([^"]+)"/i;
/** 条目内：做种/吸血 */
const PEERS_RE = /title="Seeders:\s*(\d+)\s*\/\s*Leechers:\s*(\d+)"/i;
/** 条目内：文件数 */
const FILES_RE = /<em>\((\d+)\s+files?\)<\/em>/i;

/** 详情页 URL 末尾的 .n<数字> 是站点内部 id */
function idFromUrl(url: string): string {
    const m = String(url || '').match(/\.n(\d+)$/) || String(url || '').match(/\/(\d+)$/);
    return m ? m[1] : '';
}

export const animetoshoProvider: SiteProvider = {
    descriptor: {
        id: 'animetosho',
        label: 'Anime Tosho',
        homepage: 'https://animetosho.org',
        adult: false,
        kinds: ['动画', '英文', '聚合'],
    },
    buildSearchUrl(query: string): string {
        return `https://animetosho.org/search?q=${encodeURIComponent(query)}`;
    },
    headers: { Referer: 'https://animetosho.org/' },

    parse(body: string, _ctx: ParseContext): ProviderHit[] {
        if (!body) return [];

        // 条目按出现顺序切开；第 0 段是首个条目之前的内容（含日期分组标记）
        const segments = body.split(ENTRY_SPLIT_RE);
        if (segments.length < 2) return [];

        const hits: ProviderHit[] = [];

        for (let i = 1; i < segments.length; i += 1) {
            const seg = segments[i];

            const linkMatch = seg.match(LINK_RE);
            if (!linkMatch) continue;
            const viewUrl = linkMatch[1];
            const title = stripTags(linkMatch[2]);
            const id = idFromUrl(viewUrl);
            if (!id) continue;

            const torrentMatch = seg.match(TORRENT_RE);
            const magnetMatch = seg.match(MAGNET_RE);
            const magnet = magnetMatch ? stripTags(magnetMatch[1]) : '';

            // 体积：title 里的精确字节数优先
            const sizeMatch = seg.match(SIZE_RE);
            let sizeBytes = UNKNOWN;
            let sizeText = '';
            if (sizeMatch) {
                sizeBytes = parseSizeBytes(sizeMatch[1]);
                sizeText = stripTags(sizeMatch[2]);
                // title 解析失败时回落到正文文本
                if (sizeBytes === UNKNOWN) sizeBytes = parseSizeBytes(sizeText);
            }

            // 时间：条目内 date 的 title 给完整时间；缺失时用前一段的日期分组
            const dateMatch = seg.match(DATE_RE);
            let publishedAt = dateMatch ? parseDateText(dateMatch[1]) : UNKNOWN;
            if (publishedAt === UNKNOWN) {
                // 回看本条目之前的内容，取最后一个日期分组
                const before = segments[i - 1] || '';
                DATESEP_RE.lastIndex = 0;
                let sep: RegExpExecArray | null;
                let last = '';
                while ((sep = DATESEP_RE.exec(before)) !== null) last = sep[1];
                if (last) publishedAt = parseDateText(last);
            }

            const peersMatch = seg.match(PEERS_RE);
            const filesMatch = seg.match(FILES_RE);

            hits.push({
                id,
                title: title || `torrent-${id}`,
                magnet,
                torrent: torrentMatch ? torrentMatch[1] : '',
                viewUrl,
                sizeBytes,
                sizeText,
                seeders: peersMatch ? Number(peersMatch[1]) : UNKNOWN,
                leechers: peersMatch ? Number(peersMatch[2]) : UNKNOWN,
                completed: UNKNOWN,
                publishedAt,
                category: filesMatch ? `${filesMatch[1]} 个文件` : '',
                infoHash: magnetInfoHash(magnet),
            });
        }
        return hits;
    },
};
