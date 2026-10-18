/**
 * ACG 站点：域名判定、HLS 签名补全、探测结果解析、后续页抓取。
 *
 * 与宿主无关：面板、Agent、画廊流程三处读同一份判据。
 */
import type {
    AcgRemainingPages,
    GalleryProbeResult,
    ResolvedProbeMedia,
} from '../meta';

/** ACG 专属资源判定：站点 + 图床域名。嗅探过滤（isSniffExcluded）与画廊流程读的是这一份 */
const ACG_HOST_SUFFIXES = ['acgmho.com', 'acgnngca.com', 'acgnfl.com', 'acg-hentai.com'];

/** e-hentai 站点域名（含图集页与图床） */
const EHENTAI_HOST_SUFFIXES = ['e-hentai.org', 'exhentai.org', 'ehgt.org', 'hath.network'];

const hostMatches = (url: string | undefined | null, suffixes: string[]): boolean => {
    if (!url || typeof url !== 'string') return false;
    try {
        const host = new URL(url.trim()).hostname.toLowerCase();
        return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
    } catch {
        return false;
    }
};

/** 命中者不进嗅探列表，一律走画廊流程 */
export const isAcgUrl = (url: string | undefined | null): boolean => hostMatches(url, ACG_HOST_SUFFIXES);

/** 是否为 e-hentai 地址（同样走画廊流程，不进嗅探列表） */
export const isEhentaiUrl = (url: string | undefined | null): boolean => hostMatches(url, EHENTAI_HOST_SUFFIXES);

/**
 * 从地址反推站点 id，用于"粘贴链接直接抓取"这类没有站点选择器的入口。
 *
 * 判据只能是主机名：gid 在两个站点都是数字，光看数字分不出是哪本书。
 * 认不出返回空串，由调用方按默认站点处理 —— 静默猜成某个站点会让
 * "贴了 e-hentai 链接却报 acgmho 解析失败"这种错误极难定位。
 */
export const siteIdOfUrl = (url: string | undefined | null): string => {
    if (isEhentaiUrl(url)) return 'ehentai';
    if (isAcgUrl(url)) return 'acgmho';
    return '';
};

/**
 * ACG 站点 HLS 清单签名补全。
 *
 * 站点下发的 master 形如 `/ha/<id>/zh-chs_master.m3u8?m=<token>&t=<过期戳>`，
 * 其中的变体是相对地址（`zh-chs-sd/index.m3u8`）。按 RFC 3986，非空相对路径
 * 解析时**不继承** base 的 query，于是 hls.js 实际请求的变体地址不带签名，
 * 图床一律回 403 —— 播放器表现为各画质全部 403、重试耗尽后报网络错误。
 *
 * 站点自身靠 xhrSetup 补 `from=<master 路径>` + m + t，这里做同一件事。
 * 只处理 .m3u8（分片实测无需签名，改写反而会打乱 CDN 缓存键），
 * 且只在「ACG 域 + master 带 m= 令牌」时生效 —— 其它站点的签名 URL 可能是
 * 对整个 query 做 HMAC，追加参数会让本来能播的流失效。
 */
export const signAcgHlsUrl = (requestUrl: string, masterUrl: string): string => {
    if (!/\.m3u8(\?|#|$)/i.test(requestUrl)) return requestUrl;
    // master 自身、以及上层已补过签名的地址不重复追加
    if (/[?&]m=/.test(requestUrl)) return requestUrl;
    if (!isAcgUrl(masterUrl)) return requestUrl;

    let master: URL;
    try {
        master = new URL(masterUrl);
    } catch {
        return requestUrl;
    }
    const token = master.searchParams.get('m');
    if (!token) return requestUrl;

    const sep = requestUrl.includes('?') ? '&' : '?';
    const t = master.searchParams.get('t');
    const tPart = t ? `&t=${encodeURIComponent(t)}` : '';
    return `${requestUrl}${sep}m=${encodeURIComponent(token)}${tPart}&from=${encodeURIComponent(master.pathname)}`;
};

/** 探测音轨单项：与 GalleryProbeResult.audioList 同构，但字段放宽为可选以容忍脏数据 */
interface ProbeAudioTrack {
    name?: string;
    url?: string;
    artist?: string;
    cover?: string;
}

/**
 * ACG probe 结果统一解析（消除多处重复分支）。
 *
 * 两条分支都不允许"拿别的资源冒充"：video 缺直链时不再拿封面图顶替、
 * audio 缺音轨时不再把页面地址当音频 —— 那会产生播不出的坏条目，
 * 表现为列表里点一下就报错。缺资源时回落成 `kind:'none'` 并给出 status 文案。
 */
export const resolveProbeMedia = (probe: GalleryProbeResult | null | undefined): ResolvedProbeMedia => {
    if (!probe) return { kind: 'none', streams: [], totalPages: 0, status: '未能探测到作品信息，请核对链接或作品 ID' };
    const title = probe.title || '未命名作品';
    const totalPages = Number(probe.totalPages) || 0;

    const rawList: ProbeAudioTrack[] = Array.isArray(probe.audioList) ? probe.audioList : [];
    const audioList = rawList.filter((a): a is ProbeAudioTrack & { url: string } => Boolean(a && a.url));

    if (probe.mediaType === 'video' || probe.category === 'animation' || probe.videoUrl) {
        if (!probe.videoUrl) return { kind: 'none', streams: [], totalPages, status: '该动画作品未解析到可播放的视频资源' };
        // 显式标注 video：动画直链多为 .m3u8，靠扩展名推断会被判成 stream（并被「LIVE」逻辑误认）
        return { kind: 'video', streams: [{ url: probe.videoUrl, name: title, title, mediaType: 'video' }], totalPages, status: null };
    }

    if (probe.mediaType === 'audio' || probe.category === 'asmr' || audioList.length > 0) {
        if (audioList.length > 0) {
            return {
                kind: 'audio',
                streams: audioList.map((a, idx) => ({
                    url: a.url,
                    name: a.name || `${title} - 音轨 ${idx + 1}`,
                    title: a.name || `${title} - 音轨 ${idx + 1}`,
                    mediaType: 'audio',
                    // 艺术家随条目透出，播放器的音频视图靠它显示署名。
                    // poster 只是透传到条目上，播放器尚未渲染封面（封面目前只在画廊详情页用）
                    artist: a.artist,
                    poster: a.cover,
                })),
                totalPages,
                status: null,
            };
        }
        return { kind: 'none', streams: [], totalPages, status: '该音频作品未解析到可播放音轨' };
    }

    if (probe.firstImgUrl) {
        const name = `${title} - P01/${totalPages || 1}`;
        return { kind: 'image', streams: [{ url: probe.firstImgUrl, name, title: name, mediaType: 'image' }], totalPages, status: null };
    }
    return { kind: 'none', streams: [], totalPages, status: '作品中未解析到可播放的媒体资源' };
};

/**
 * ACG 图集后续页抓取（消除重复的 fetchPages 样板）。
 *
 * 只返回首屏之外的页；runId 为空串表示旧轮回包，调用方直接丢弃。
 * 首屏已展示：失败直接抛错，调用方记日志即可，不打断阅读。
 */
export const fetchAcgRemainingPages = async (
    fetchPages: (opts: { gidOrUrl: string; pages: string; delayMs: number; runId: string; probe: GalleryProbeResult; site?: string }) => Promise<{ runId?: string; pages?: { url: string; title?: string; page?: number }[]; errors?: unknown[] } | null | undefined>,
    probe: GalleryProbeResult,
    tag: string,
): Promise<AcgRemainingPages> => {
    // runId 必须随请求下发：主进程原样回带，凭它比对才能认出本轮回包。
    // 漏传时主进程会自造 runId，下面的比对永远不相等，后续页会被整批当作旧轮丢弃。
    const runId = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetchPages({
        // site 必须来自探测结果：主进程按它选 provider，缺了就回落到默认站点，
        // 表现为"e-hentai 的书抓回来的是 acgmho 的页"（或直接解析失败）。
        site: probe.site,
        gidOrUrl: probe.firstPageUrl || probe.gid,
        pages: `1-${probe.totalPages}`,
        delayMs: 100,
        runId,
        // 复用详情探测结果，防 /h/ 与 /hentai/ 同数字作品串台
        probe,
    });
    if (!res || res.runId !== runId) return { runId: '', pages: [], errors: [] };
    // 按页码过滤而非 slice(1)：第 1 页抓取失败时 slice 会误丢第 2 页
    const pages = (res.pages ?? [])
        .filter((p) => p && p.url && p.page !== 1 && Number.isFinite(p.page))
        .map((p) => ({ url: p.url, title: p.title || `P${p.page}`, page: p.page as number }));
    return { runId, pages, errors: res.errors ?? [] };
};
