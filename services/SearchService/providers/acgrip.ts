import type { ProviderHit, SiteProvider, ParseContext } from '../types';
import { UNKNOWN, stripTags, parseSizeBytes, parseTimestamp, magnetInfoHash, absolutize } from '../util';

/**
 * ============================================================================
 * acg.rip 插件（中文 ACG 资源站）
 * ============================================================================
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
 *       <td class="title">
 *         <span class="title"><a href="/t/85085">标题</a></span>
 *       </td>
 *       <td class="action"><a href="/t/85085.torrent">…</a></td>
 *       <td class="size">1.8 GB</td>
 *     </tr>
 *   </table>
 *
 * 三个要点：
 * 1. **只有 .torrent 直链，没有 magnet** —— torrent 字段有值、magnet 为空，
 *    引擎与 UI 必须能接受这种组合（下载走种子文件，不依赖磁链）。
 * 2. **不公布做种/吸血数**，全部记 UNKNOWN（不是 0）。
 * 3. 时间是 <time datetime="epoch秒">，比显示的"接近 11 年"这种相对文本可靠得多。
 *
 * 另外该站返回的搜索页带 UTF-8 中文标题，直接按 UTF-8 解码即可。
 */

/** 只扫主结果表，避免把页面别处的链接误当条目 */
const TABLE_RE = /<table[^>]*class="[^"]*post-index[^"]*"[^>]*>([\s\S]*?)<\/table>/i;
const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

/** 标题锚：/t/<id> 形式 */
const TITLE_RE = /<span[^>]*class="[^"]*title[^"]*"[^>]*>\s*<a[^>]*href="(\/t\/\d+)"[^>]*>([\s\S]*?)<\/a>/i;
/** 种子直链：/t/<id>.torrent */
const TORRENT_RE = /href="(\/t\/\d+\.torrent)"/i;
/** 发布时间 */
const TIME_RE = /<time[^>]*datetime="(\d+)"[^>]*>/i;
/** 体积单元格 */
const SIZE_RE = /<td[^>]*class="[^"]*size[^"]*"[^>]*>([\s\S]*?)<\/td>/i;

export const acgripProvider: SiteProvider = {
    descriptor: {
        id: 'acgrip',
        label: 'ACG.RIP',
        homepage: 'https://acg.rip',
        adult: false,
        kinds: ['动画', '漫画', '音乐', '游戏'],
    },
    buildSearchUrl(query: string): string {
        return `https://acg.rip/?term=${encodeURIComponent(query)}`;
    },
    headers: { Referer: 'https://acg.rip/' },

    parse(body: string, _ctx: ParseContext): ProviderHit[] {
        if (!body) return [];
        const table = body.match(TABLE_RE);
        if (!table) return []; // 无结果或页面结构变了：交给引擎记为 0 条

        const hits: ProviderHit[] = [];
        ROW_RE.lastIndex = 0;
        let row: RegExpExecArray | null;

        while ((row = ROW_RE.exec(table[1])) !== null) {
            const rowHtml = row[1];
            const titleMatch = rowHtml.match(TITLE_RE);
            if (!titleMatch) continue; // 表头行与空行没有标题锚

            const viewPath = titleMatch[1];
            const title = stripTags(titleMatch[2]);
            const idMatch = viewPath.match(/(\d+)/);
            const id = idMatch ? idMatch[1] : '';
            if (!id) continue;

            const torrentMatch = rowHtml.match(TORRENT_RE);
            const torrent = torrentMatch ? absolutize(torrentMatch[1], 'https://acg.rip') : '';

            const timeMatch = rowHtml.match(TIME_RE);
            const publishedAt = timeMatch ? parseTimestamp(Number(timeMatch[1])) : UNKNOWN;

            const sizeMatch = rowHtml.match(SIZE_RE);
            const sizeText = sizeMatch ? stripTags(sizeMatch[1]) : '';
            const sizeBytes = sizeText ? parseSizeBytes(sizeText) : UNKNOWN;

            hits.push({
                id,
                title: title || `torrent-${id}`,
                magnet: '', // 该站不提供磁链，只有种子文件
                torrent,
                viewUrl: absolutize(viewPath, 'https://acg.rip'),
                sizeBytes,
                sizeText,
                seeders: UNKNOWN,   // 站点不公布
                leechers: UNKNOWN,
                completed: UNKNOWN,
                publishedAt,
                category: '',       // 该站结果行不含分类
                infoHash: magnetInfoHash(''),
            });
        }
        return hits;
    },
};
