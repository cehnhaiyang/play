import type { ProviderHit, SiteProvider, ParseContext } from '../types';
import { UNKNOWN, stripTags, parseSizeBytes, parseDateText, magnetInfoHash, absolutize } from '../util';

/**
 * ============================================================================
 * 动漫花园（share.dmhy.org）插件
 * ============================================================================
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
 *         <td nowrap align="center"><span class="btl_1">-</span></td>  ← 种子(seeders)
 *         <td nowrap align="center"><span class="bts_1">-</span></td>  ← 下载(leechers)
 *         <td nowrap align="center">-</td>                             ← 完成
 *         <td align="center"><a href="/topics/list/user_id/759200">c8l</a></td>
 *       </tr>
 *
 * 四个要点：
 * 1. **磁链是 base32 btih**（32 位字母数字），与 nyaa/apibay 的 40 位 hex 不同。
 *    统一成 hex 由 util.magnetInfoHash 负责，否则跨站去重认不出同一资源。
 * 2. 行内有**多个磁链来源**：`arrow-magnet` 的 href，以及 `download-xl` 的
 *    data-magnet。href 优先，缺失时回退 data-magnet。
 * 3. 做种/吸血列常显示 `-`（站点未采集），此时记 UNKNOWN 而非 0。
 * 4. 分类是 `<font color=red>季度全集</font>` 这类带样式的中文文本，去标签即可。
 */

/** 主结果表：id="topic_list" */
const TABLE_RE = /<table[^>]*id="topic_list"[^>]*>([\s\S]*?)<\/table>/i;
/** 数据行：<tbody> 内的 tr（表头在 thead 里，不在 tbody） */
const TBODY_RE = /<tbody>([\s\S]*?)<\/tbody>/i;
const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

/** 标题锚：/topics/view/<id>_<slug>.html */
const TITLE_RE = /<td[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="(\/topics\/view\/(\d+)_[^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
/** 磁链：href 形式优先 */
const MAGNET_HREF_RE = /href="(magnet:\?[^"]+)"/i;
/** 磁链：data-magnet 形式兜底 */
const MAGNET_DATA_RE = /data-magnet="(magnet:\?[^"]*)"/i;
/** 发布日期：行首单元格的 YYYY/MM/DD HH:mm */
const DATE_RE = /(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})/;
/** 体积：形如 48.5GB / 1.2 GiB 的独立单元格 */
const SIZE_RE = /<td[^>]*>\s*([\d.]+\s*[KMGTP]?i?B)\s*<\/td>/i;
/** 分类：分类单元格内的文本（通常是 <font> 或 <a> 里的中文） */
const CATEGORY_RE = /<td[^>]*width="6%"[^>]*>([\s\S]*?)<\/td>/i;

export const dmhyProvider: SiteProvider = {
    descriptor: {
        id: 'dmhy',
        label: '动漫花园',
        homepage: 'https://share.dmhy.org',
        adult: false,
        kinds: ['动画', '字幕组', '合集'],
    },
    buildSearchUrl(query: string): string {
        // 该站接受 UTF-8 关键词的百分号编码
        return `https://share.dmhy.org/topics/list?keyword=${encodeURIComponent(query)}`;
    },
    headers: { Referer: 'https://share.dmhy.org/' },

    parse(body: string, _ctx: ParseContext): ProviderHit[] {
        if (!body) return [];
        const table = body.match(TABLE_RE);
        if (!table) return [];
        const tbody = table[1].match(TBODY_RE);
        if (!tbody) return [];

        const hits: ProviderHit[] = [];
        ROW_RE.lastIndex = 0;
        let row: RegExpExecArray | null;

        while ((row = ROW_RE.exec(tbody[1])) !== null) {
            const rowHtml = row[1];
            const titleMatch = rowHtml.match(TITLE_RE);
            if (!titleMatch) continue;

            const viewPath = titleMatch[1];
            const id = titleMatch[2];
            const title = stripTags(titleMatch[3]);

            // 磁链：href 优先，data-magnet 兜底
            const magnetHref = rowHtml.match(MAGNET_HREF_RE);
            const magnetData = rowHtml.match(MAGNET_DATA_RE);
            const magnetRaw = (magnetHref && magnetHref[1]) || (magnetData && magnetData[1]) || '';
            const magnet = magnetRaw ? stripTags(magnetRaw) : '';

            const dateMatch = rowHtml.match(DATE_RE);
            const publishedAt = dateMatch ? parseDateText(dateMatch[1]) : UNKNOWN;

            const sizeMatch = rowHtml.match(SIZE_RE);
            const sizeText = sizeMatch ? stripTags(sizeMatch[1]) : '';
            const sizeBytes = sizeText ? parseSizeBytes(sizeText) : UNKNOWN;

            const catMatch = rowHtml.match(CATEGORY_RE);
            const category = catMatch ? stripTags(catMatch[1]) : '';

            hits.push({
                id,
                title: title || `torrent-${id}`,
                magnet,
                // 该站不直接给 .torrent 直链（详情页里才有），留空由引擎/UI 处理
                torrent: '',
                viewUrl: absolutize(viewPath, 'https://share.dmhy.org'),
                sizeBytes,
                sizeText,
                seeders: UNKNOWN,   // 该站列表页通常显示 "-"
                leechers: UNKNOWN,
                completed: UNKNOWN,
                publishedAt,
                category,
                infoHash: magnetInfoHash(magnet),
            });
        }
        return hits;
    },
};
