import type { ProviderHit, SiteProvider, ParseContext } from '../types';
import { UNKNOWN, parseTimestamp, buildMagnet, formatBytes } from '../util';

/**
 * ============================================================================
 * apibay 插件（The Pirate Bay 的公开 JSON 接口）
 * ============================================================================
 *
 * 这是最省事的一类数据源：纯 JSON，字段规整，不需要解析 HTML。
 * 它同时验证了引擎的数据源无关性——同一个引擎既吃 HTML 也吃 JSON。
 *
 * 实测响应（https://apibay.org/q.php?q=…）：
 * [
 *   {
 *     "id": "5316077",
 *     "name": "Big.Buck.Bunny.BDRip.XviD-MEDiC",
 *     "info_hash": "C39FE3EEFBDB62DA9C27EB6398FF4A7D2E26E7AB",
 *     "leechers": "1", "seeders": "0",
 *     "size": "183567938",          ← 纯字节数字符串
 *     "num_files": "1", "username": ".BONE.",
 *     "added": "1264712003",        ← epoch 秒
 *     "status": "vip", "category": "204", "imdb": ""
 *   }, …
 * ]
 *
 * 两个要点：
 * 1. **没有 magnet**，只给 info_hash —— 磁链由本地拼出（见 util.buildMagnet）。
 * 2. **没有做种数之外的元信息**，且分类是数字 id。
 * 3. 无结果时返回 `[{"id":"0","name":"No results returned",…}]` 这种占位行，
 *    必须识别并丢弃，否则列表里会出现一条假结果。
 */

/** TPB 的分类 id → 可读文本。只列常用的，未知 id 原样显示。 */
const CATEGORY_NAMES: Record<string, string> = {
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
    num_files?: string | number;
}

/** 数字字段容错：可能是字符串、可能是空 */
function toInt(value: unknown): number {
    if (value == null || value === '') return UNKNOWN;
    const n = Number(value);
    return Number.isFinite(n) ? n : UNKNOWN;
}

export const apibayProvider: SiteProvider = {
    descriptor: {
        id: 'apibay',
        label: 'The Pirate Bay',
        homepage: 'https://thepiratebay.org',
        adult: false,
        kinds: ['影视', '音乐', '软件', '游戏'],
    },
    buildSearchUrl(query: string): string {
        return `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
    },
    headers: { Referer: 'https://thepiratebay.org/' },

    parse(body: string, _ctx: ParseContext): ProviderHit[] {
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
            hits.push({
                id,
                title: name || `torrent-${id}`,
                magnet: buildMagnet(infoHash, name),
                // apibay 不提供种子文件直链；有 info_hash 就能起任务，torrent 留空
                torrent: '',
                viewUrl: `https://thepiratebay.org/description.php?id=${id}`,
                sizeBytes,
                sizeText: sizeBytes === UNKNOWN ? '' : formatBytes(sizeBytes),
                seeders: toInt(raw.seeders),
                leechers: toInt(raw.leechers),
                completed: UNKNOWN, // 接口不提供
                publishedAt: parseTimestamp(raw.added as string | number),
                category: CATEGORY_NAMES[String(raw.category ?? '')] || (raw.category ? `分类 ${raw.category}` : ''),
                infoHash,
            });
        }
        return hits;
    },
};
