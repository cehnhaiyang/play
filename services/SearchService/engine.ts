import type { SearchHit, SearchQuery, SearchResult, SearchSiteStatus, SearchSort } from '../../meta';
import type { SiteProvider, Transport, ProviderHit } from './types';
import { resolveProviders } from './registry';
import { fetchTransport } from './transport';
import { UNKNOWN, normalizeTitle } from './util';

/**
 * ============================================================================
 * 通用搜索引擎
 * ============================================================================
 *
 * 职责（全部与具体站点无关）：
 *   扇出 → 并发 → 单站超时 → 解析 → 归一化 → 跨站去重 → 排序 → 汇总状态
 *
 * 引擎对任何站点一无所知，只认 SiteProvider 接口。加站点不改这个文件。
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

/**
 * 跨站去重。
 *
 * 同一条资源常同时出现在多个站（实测 nyaa 与 animetosho 索引大量重叠）。
 * 保留"信息更全"的那条：有做种数的优先，其次体积已知的优先。
 * 这样用户看到的是去重后的列表，而不是同一资源刷屏。
 */
function dedupe(hits: SearchHit[]): SearchHit[] {
    const best = new Map<string, SearchHit>();
    for (const hit of hits) {
        const key = dedupeKey(hit);
        const prev = best.get(key);
        if (!prev) {
            best.set(key, hit);
            continue;
        }
        // 打分：做种数已知 +2，体积已知 +1，有磁链 +1
        const score = (h: SearchHit) =>
            (h.seeders !== UNKNOWN ? 2 : 0) +
            (h.sizeBytes !== UNKNOWN ? 1 : 0) +
            (h.magnet ? 1 : 0);
        if (score(hit) > score(prev)) best.set(key, hit);
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
 * 但这是**实现细节，不是契约**——排序算法一换（或数组规模跨过
 * TimSort 的 run 阈值）就可能变。取一个比任何真实值都小、相减又不会
 * 溢出的有限哨兵，成本为零且把这条不确定性彻底消掉；未知项之间差为 0，
 * 天然满足"相等即返回 0"，排序因此是确定的。
 */
const UNKNOWN_RANK = -Number.MAX_SAFE_INTEGER;

function rank(value: number): number {
    return value === UNKNOWN ? UNKNOWN_RANK : value;
}

/**
 * 导出排序比较器供测试直接断言其契约（见 scripts/test/search.test.js）。
 * 只测"最终顺序"抓不到 NaN：V8 会把 NaN 当成"不大于"，结果碰巧仍是对的。
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

/** 排序。未知值一律排到末尾，见 rank。比较器与导出的 compareBy 共用同一份实现。 */
function sortHits(hits: SearchHit[], sort: SearchSort): SearchHit[] {
    return hits.slice().sort(compareBy(sort));
}

/** 单站搜索：取字节 → 解析 → 盖站点章 → 归一化。任何失败都转成状态上报，不抛。 */
async function searchOneSite(
    provider: SiteProvider,
    query: string,
    transport: Transport,
    timeoutMs: number
): Promise<{ hits: SearchHit[]; status: SearchSiteStatus }> {
    const startedAt = Date.now();
    const { descriptor } = provider;
    const base: SearchSiteStatus = {
        site: descriptor.id,
        label: descriptor.label,
        ok: false,
        count: 0,
        elapsedMs: 0,
    };

    let url = '';
    try {
        url = provider.buildSearchUrl(query);
    } catch (err: any) {
        return {
            hits: [],
            status: { ...base, elapsedMs: Date.now() - startedAt, error: `构造搜索地址失败：${err?.message || err}` },
        };
    }

    let res;
    try {
        res = await transport.get({ url, headers: provider.headers, timeoutMs });
    } catch (err: any) {
        // transport 约定不抛，但自定义实现可能抛；这里兜住，保证扇出不被单站带崩
        return {
            hits: [],
            status: { ...base, elapsedMs: Date.now() - startedAt, error: err?.message || '请求失败' },
        };
    }

    const elapsedMs = Date.now() - startedAt;

    if (!res.ok) {
        const reason = res.error || (res.status ? `HTTP ${res.status}` : '请求失败');
        return { hits: [], status: { ...base, elapsedMs, error: reason } };
    }

    let parsed: ProviderHit[] = [];
    try {
        parsed = provider.parse(res.body, { url: res.finalUrl || url, query });
    } catch (err: any) {
        // 解析器抛错说明站点结构变了（或返回了意料之外的内容）。
        // 报出来比静默返回空结果好——空结果会被误读成"这个站没有该资源"。
        return {
            hits: [],
            status: { ...base, elapsedMs, error: `解析失败（站点结构可能已变）：${err?.message || err}` },
        };
    }

    // 盖站点章：provider 不自己填 site/siteLabel，避免同一站点名在两处各写一遍
    const hits: SearchHit[] = parsed.map((h) => ({
        ...h,
        site: descriptor.id,
        siteLabel: descriptor.label,
    }));

    return {
        hits,
        status: { ...base, ok: true, count: hits.length, elapsedMs },
    };
}

/**
 * 扇出搜索：并发查询全部（或指定的）站点，汇总归一化结果。
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

    const providers = resolveProviders(query.sites, query.includeAdult !== false);
    if (providers.length === 0) {
        return { success: false, message: '没有可用的搜索站点', hits: [], sites: [], elapsedMs: 0 };
    }

    const limitPerSite = Number(query.limitPerSite) > 0 ? Number(query.limitPerSite) : 0;
    const timeoutMs = 12000;

    // 并发扇出。用 allSettled 而非 all：单站异常不该让整体 reject，
    // 而 searchOneSite 已把错误转成状态，这里再兜一层。
    const settled = await Promise.allSettled(
        providers.map((p) => searchOneSite(p, q, transport, timeoutMs))
    );

    const allHits: SearchHit[] = [];
    const sites: SearchSiteStatus[] = [];

    settled.forEach((result, idx) => {
        const provider = providers[idx];
        if (result.status === 'fulfilled') {
            const { hits, status } = result.value;
            allHits.push(...(limitPerSite > 0 ? hits.slice(0, limitPerSite) : hits));
            sites.push(status);
        } else {
            sites.push({
                site: provider.descriptor.id,
                label: provider.descriptor.label,
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

    hits = sortHits(hits, query.sort || 'seeders');

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
