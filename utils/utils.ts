import { VideoFile, MediaType, GalleryProbeResult, AiBookFile, AiBookPage } from '../meta';

/* -------------------------------------------------------------------------- */
/*                                常量定义                                     */
/* -------------------------------------------------------------------------- */

export const STORAGE_KEYS = {
    VOLUME: 'react-player-volume',
    MODE: 'react-player-mode',
    RATE: 'react-player-rate',
    FIT: 'react-player-fit'
};

/**
 * 后缀 → 媒体类型的**唯一真值**（按扩展名判定的路径都从这里派生）。
 *
 * 派生方：getMediaType 的查表、嗅探扫描清单（useBrowse 的 CATEGORIES）、
 * 画廊页码识别（本文件的 IMAGE_EXTENSIONS）。
 * 曾经这几处各写一份，结果 `.avif` 只进了主进程嗅探表 ——
 * 页内嗅探扫到它归为 other 后直接丢弃，同一个文件走两条路径结论不同。
 * 新增后缀只改这里（getMediaType 末尾那组关键字兜底是刻意更松的独立判据，不在此列）。
 */
export const MEDIA_EXTENSIONS: Record<string, MediaType> = {
    // Stream
    'm3u8': 'stream',
    'm3u': 'stream',
    'mpd': 'stream',
    'ts': 'stream',
    'flv': 'stream', // 注意：标准 H5 Video 不支持 FLV，通常需要 flv.js，这里先归类为流
    'f4v': 'stream',

    // Video
    'mp4': 'video',
    'mkv': 'video',
    'webm': 'video',
    'avi': 'video',
    'mov': 'video',
    'wmv': 'video',
    'ogv': 'video',
    '3gp': 'video',
    'mpg': 'video',
    'mpeg': 'video',
    'm4s': 'video',

    // Audio
    'mp3': 'audio',
    'wav': 'audio',
    'aac': 'audio',
    'm4a': 'audio',
    'ogg': 'audio',
    'flac': 'audio',
    'opus': 'audio',
    'wma': 'audio',

    // Image
    'jpg': 'image',
    'jpeg': 'image',
    'png': 'image',
    'gif': 'image',
    'webp': 'image',
    'svg': 'image',
    'bmp': 'image',
    'ico': 'image',
    'tiff': 'image',
    'heic': 'image',
    'avif': 'image',

    // Document / Markdown / Text
    'md': 'document',
    'markdown': 'document',
    'txt': 'document',
    'log': 'document',
    'pdf': 'document',
    'json': 'document',

    // Custom AI Book（AI 绘本归档：JSON，内含分页图片 + 文案）
    // 导入时由 PlayPanel 的 importFilesSmart 识别并解包成组；
    // 这里的 image 分类只用于「没被识别成绘本」时的兜底展示。
    'aibook': 'image',

    // Gallery（画廊徽标文件，代表一本多页图集的文件夹）
    'gallery': 'gallery',
};

/* -------------------------------------------------------------------------- */
/*                                工具函数定义                                 */
/* -------------------------------------------------------------------------- */

/**
 * 生成简短的随机 ID，用于列表项的唯一标识
 */
export const generateId = (): string => {
    try {
        const uuid = (globalThis as any)?.crypto?.randomUUID?.();
        if (typeof uuid === 'string' && uuid.length > 0) return uuid.replace(/-/g, '').slice(0, 12);
    } catch { /* ignore, fallback below */ }
    return `${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
};

/**
 * 播放器可接受的 URL 白名单校验：仅 http(s) / blob，拒绝 javascript:/data:/file: 等
 */
export const isValidMediaUrl = (url: string): boolean => {
    const trimmed = (url || '').trim();
    if (!trimmed || trimmed.length > 8192) return false;
    if (/^(javascript|data|file|vbscript):/i.test(trimmed)) return false;
    return /^(https?:\/\/|blob:)/i.test(trimmed);
};

/**
 * ACG 专属资源判定（与主进程 setupSniffer 同口径）：
 * 站点 + 图床域名。命中者不进嗅探列表，一律走画廊流程。
 */
const ACG_HOST_SUFFIXES = ['acgmho.com', 'acgnngca.com', 'acgnfl.com', 'acg-hentai.com'];

export const isAcgUrl = (url: string | undefined | null): boolean => {
    if (!url || typeof url !== 'string') return false;
    try {
        const host = new URL(url.trim()).hostname.toLowerCase();
        return ACG_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
    } catch {
        return false;
    }
};

/**
 * ACG 站点 HLS 清单签名补全。
 * 站点下发的 master 形如 /ha/<id>/zh-chs_master.m3u8?m=<token>&t=<过期戳>，
 * 其中的变体是相对地址（zh-chs-sd/index.m3u8）。按 RFC 3986，非空相对路径解析时
 * 不继承 base 的 query，于是 hls.js 实际请求的变体地址不带签名，图床一律回 403
 * —— 播放器表现为各画质全部 403、重试耗尽后报网络错误。
 * 站点自身靠 xhrSetup 补 from=<master 路径> + m + t，这里做同一件事。
 * 只处理 .m3u8（分片实测无需签名，改写反而会打乱 CDN 缓存键），
 * 且只在「ACG 域 + master 带 m= 令牌」时生效——其它站点的签名 URL 可能是
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
    const params = master.searchParams;
    const token = params.get('m');
    if (!token) return requestUrl;

    const sep = requestUrl.includes('?') ? '&' : '?';
    const t = params.get('t');
    const tPart = t ? `&t=${encodeURIComponent(t)}` : '';
    return `${requestUrl}${sep}m=${encodeURIComponent(token)}${tPart}&from=${encodeURIComponent(master.pathname)}`;
};

export interface ResolvedProbeMedia {
    kind: 'video' | 'audio' | 'image' | 'none';
    streams: (Partial<VideoFile> & { url: string; title?: string })[];
    totalPages: number;
    status: string | null;
}

/** 探测音轨单项（与 GalleryProbeResult.audioList 同构，url 为空者视为无效） */
interface ProbeAudioTrack {
    name?: string;
    url?: string;
    artist?: string;
    cover?: string;
    type?: string;
}

/**
 * ACG probe 结果统一解析（App 与 PlayPanel 共用，消除三处重复分支）。
 * 防护：video/audio 分支缺有效 URL 时不再构造坏条目，而是回落并给出 status。
 */
export const resolveProbeMedia = (probe: GalleryProbeResult | null | undefined): ResolvedProbeMedia => {
    if (!probe) return { kind: 'none', streams: [], totalPages: 0, status: '未能探测到作品信息，请核对链接或作品 ID' };
    const title = probe.title || '未命名作品';
    const totalPages = Number(probe.totalPages) || 0;

    const rawList: ProbeAudioTrack[] = Array.isArray(probe.audioList) ? probe.audioList : [];
    const audioList = rawList.filter((a): a is ProbeAudioTrack & { url: string } => Boolean(a && a.url));
    if (probe.mediaType === 'video' || probe.category === 'animation' || probe.videoUrl) {
        // 无视频直链时不再拿封面图冒充视频（会产生播不出的坏条目），与音频分支同口径回落
        if (!probe.videoUrl) return { kind: 'none', streams: [], totalPages, status: '该动画作品未解析到可播放的视频资源' };
        // 显式标注 video：动画直链多为 .m3u8，靠扩展名推断会被判成 stream（并被「LIVE」逻辑误认）
        return { kind: 'video', streams: [{ url: probe.videoUrl, name: title, title, mediaType: 'video' as const }], totalPages, status: null };
    }
    if (probe.mediaType === 'audio' || probe.category === 'asmr' || audioList.length > 0) {
        if (audioList.length > 0) {
            return {
                kind: 'audio',
                streams: audioList.map((a, idx: number) => ({
                    url: a.url,
                    name: a.name || `${title} - 音轨 ${idx + 1}`,
                    title: a.name || `${title} - 音轨 ${idx + 1}`,
                    mediaType: 'audio' as const,
                    // 艺术家与封面一并透出：音频视图凭此展示署名与封面 discs，不再裸奔 URL
                    artist: a.artist,
                    poster: a.cover,
                })),
                totalPages,
                status: null,
            };
        }
        // 无音轨列表时不再把页面地址硬塞成音频，避免产生播不出的坏条目
        return { kind: 'none', streams: [], totalPages, status: '该音频作品未解析到可播放音轨' };
    }
    if (probe.firstImgUrl) {
        return {
            kind: 'image',
            streams: [{ url: probe.firstImgUrl, name: `${title} - P01/${totalPages || 1}`, title: `${title} - P01/${totalPages || 1}`, mediaType: 'image' as const }],
            totalPages,
            status: null,
        };
    }
    return { kind: 'none', streams: [], totalPages, status: '作品中未解析到可播放的媒体资源' };
};

/** 图集后续页回包（主进程原样带回 runId，调用方凭空 runId 丢弃旧轮） */
export interface AcgRemainingPages {
    runId: string;
    pages: { url: string; title: string; page: number }[];
    errors: unknown[];
}

/**
 * ACG 图集后续页抓取（App 与 PlayPanel 共用，消除两处重复的 fetchPages 样板）。
 * 只返回首屏之外的页；runId 为空串表示旧轮回包，调用方直接丢弃。
 * 首屏已展示：失败直接抛错，调用方记日志即可，不打断阅读。
 */
export const fetchAcgRemainingPages = async (
    fetchPages: (opts: { gidOrUrl: string; pages: string; delayMs: number; runId: string; probe: GalleryProbeResult }) => Promise<{ runId?: string; pages?: { url: string; title?: string; page?: number }[]; errors?: unknown[] } | null | undefined>,
    probe: GalleryProbeResult,
    tag: string,
): Promise<AcgRemainingPages> => {
    // runId 必须随请求下发：主进程原样回带，凭它比对才能认出本轮回包。
    // 漏传时主进程会自造 runId，下面的比对永远不相等，后续页会被整批当作旧轮丢弃。
    const runId = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetchPages({
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
        .map((p) => ({ url: p.url as string, title: p.title || `P${p.page}`, page: p.page as number }));
    return { runId, pages, errors: res.errors ?? [] };
};

/**
 * 清理 URL 中的查询参数和 hash，只保留路径
 * @param urlFull 完整 URL
 */
const cleanUrlPath = (urlFull: string): string => {
    try {
        // 处理 blob: 协议
        if (urlFull.startsWith('blob:')) return '';
        const url = new URL(urlFull);
        return url.pathname;
    } catch (e) {
        // 如果不是有效的 URL 对象，尝试简单的字符串分割
        return urlFull.split('?')[0].split('#')[0];
    }
};

/**
 * 强大的媒体类型推断函数
 * 优先级：MIME Type > 文件扩展名 > 默认值
 */
export const getMediaType = (name: string, mimeType?: string, url?: string): MediaType => {
    // 1. 优先根据 MIME 类型准确判断
    if (mimeType) {
        if (mimeType === 'application/x-mpegurl' ||
            mimeType === 'application/vnd.apple.mpegurl' ||
            mimeType === 'application/dash+xml') {
            return 'stream';
        }
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType.startsWith('audio/')) return 'audio';
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('text/') ||
            mimeType === 'text/markdown' ||
            mimeType === 'application/pdf' ||
            mimeType === 'application/json') {
            return 'document';
        }
    }

    const getExtFromStr = (str?: string): string => {
        if (!str) return '';
        const cleaned = cleanUrlPath(str).toLowerCase();
        const extMatch = cleaned.match(/\.([a-z0-9]+)$/);
        return extMatch ? extMatch[1] : '';
    };

    // 2. 先尝试从 name 中获取扩展名
    let ext = getExtFromStr(name);

    // 3. 如果 name 没有匹配的媒体扩展名，回退从 url 路径中获取
    if (!ext || !MEDIA_EXTENSIONS[ext]) {
        if (url) {
            const urlExt = getExtFromStr(url);
            if (urlExt && MEDIA_EXTENSIONS[urlExt]) {
                ext = urlExt;
            }
        }
    }

    // 4. 查表判断
    if (ext && MEDIA_EXTENSIONS[ext]) {
        return MEDIA_EXTENSIONS[ext];
    }

    // 5. 特殊关键字兜底检测
    const lowerBoth = `${name || ''} ${url || ''}`.toLowerCase();
    if (lowerBoth.includes('.m3u8') || lowerBoth.includes('.mpd')) return 'stream';
    if (['.webp', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.avif'].some(s => lowerBoth.includes(s))) return 'image';
    if (['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.opus'].some(s => lowerBoth.includes(s))) return 'audio';
    if (['.mp4', '.mkv', '.webm', '.avi', '.mov', '.wmv', '.flv'].some(s => lowerBoth.includes(s))) return 'video';
    if (['.md', '.markdown', '.txt', '.log', '.pdf', '.json'].some(s => lowerBoth.includes(s))) return 'document';

    // 6. 默认回退：未知文件严禁归为视频，安全回退为 'other'
    return 'other';
};

/**
 * 封装本地文件对象为播放器可用的数据结构
 */
export const createVideoFile = (file: File, folder?: string): VideoFile => {
    const item: VideoFile = {
        id: generateId(),
        file,
        url: URL.createObjectURL(file), // 创建 Blob URL
        name: file.name,
        type: 'file',
        mediaType: getMediaType(file.name, file.type)
    };
    if (folder) item.folder = folder;
    return item;
};

/**
 * 封装网络流媒体链接
 */
export const createStreamFile = (
    url: string,
    name?: string,
    mediaType?: MediaType,
    extra?: Partial<VideoFile>
): VideoFile => {
    const fileName = name || `Resource ${generateId()}`;
    return {
        id: generateId(),
        url,
        name: fileName,
        type: 'stream',
        mediaType: mediaType || getMediaType(fileName, undefined, url),
        ...extra,
    };
};

/**
 * 清理资源，防止内存泄漏
 * 主要是释放 URL.createObjectURL 创建的 Blob URL
 *
 * 判据是「URL 是不是 blob:」而不是「条目 type 是不是 file」：
 * .aibook 绘本页由 data URL 转成 blob: 后以 stream 条目入列（没有本地 File），
 * 旧判据会把这些 Blob 全部漏掉，反复导入导出绘本会持续吃内存。
 */
export const revokeVideoFile = (videoFile: VideoFile) => {
    if (videoFile.url && videoFile.url.startsWith('blob:')) {
        URL.revokeObjectURL(videoFile.url);
    }
};

/**
 * data URL 拆成 { mimeType, base64 }。
 * 非 data URL（http/blob）返回 null——调用方需自行先取回字节。
 */
export const splitDataUrl = (dataUrl: string): { mimeType: string; base64: string } | null => {
    const text = String(dataUrl || '');
    const match = text.match(/^data:([^;,]*);base64,(.*)$/s);
    if (!match) return null;
    return { mimeType: match[1] || 'image/png', base64: match[2] || '' };
};

/** File → data URL */
export const fileToDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`图片读取失败：${file.name}`));
    reader.readAsDataURL(file);
});

/**
 * 任意图片来源 → data URL。
 * 已经是 data URL 的原样返回；blob/http 取回字节再编码。
 */
export const toDataUrl = async (source: File | string): Promise<string> => {
    if (typeof source !== 'string') return fileToDataUrl(source);
    const text = source.trim();
    if (!text) throw new Error('图片地址为空');
    if (text.startsWith('data:')) return text;
    const response = await fetch(text);
    if (!response.ok) throw new Error(`图片获取失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    return fileToDataUrl(new File([blob], 'page.png', { type: blob.type || 'image/png' }));
};

/**
 * data URL → Blob URL。
 *
 * 播放列表里的条目一律用 Blob URL（CSP 与 <img> 都友好，且能被
 * revokeVideoFile 统一回收）；data URL 直接塞进 <img> 在长图下会撑爆内存。
 */
export const dataUrlToBlobUrl = (dataUrl: string): string => {
    const split = splitDataUrl(dataUrl);
    if (!split) return '';
    try {
        const binary = atob(split.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return URL.createObjectURL(new Blob([bytes], { type: split.mimeType }));
    } catch {
        return '';
    }
};

/* -------------------------------------------------------------------------- */
/*                              篡改规则的可用性                                */
/*                                                                            */
/*  引擎（注入脚本）、面板、Agent 工具三处都要判断"这条规则引擎会不会用"。      */
/*  引擎那份在模板字符串里、无法 import，所以这里是**面板与工具**的单一实现，   */
/*  与引擎的一致性由回归测试交叉验证（见 scripts/test/tamper.test.js）。        */
/* -------------------------------------------------------------------------- */

/**
 * 规则的目标键名 —— 引擎取的是 `jsonPath.split('.').pop()`。
 *
 * 注意 `"."` 这种只有分隔符的写法取到空串，与空 jsonPath 同样不可用。
 */
export const ruleTargetKey = (jsonPath: string | undefined | null): string =>
    String(jsonPath == null ? '' : jsonPath).split('.').pop() || '';

/** 这条字段规则是否会被引擎丢弃（未启用不算丢弃 —— 那是用户主动关的） */
export const isFieldRuleDropped = (rule: { enabled?: boolean; jsonPath?: string } | null | undefined): boolean =>
    !!rule && rule.enabled !== false && !ruleTargetKey(rule.jsonPath);

/** 这条请求头规则是否会被引擎丢弃 */
export const isHeaderRuleDropped = (rule: { enabled?: boolean; headerName?: string } | null | undefined): boolean =>
    !!rule && rule.enabled !== false && !rule.headerName;

/**
 * 收集被引擎跳过的规则，附带它在原数组里的下标与原因。
 *
 * 下标是给模型/用户**定位**用的：只说"有 2 条被跳过"没用，
 * 得说清是第几条、缺哪个字段，才能一步改对。
 */
export interface DroppedRule {
    /** 在哪一类规则里：intercept / request / headers */
    group: 'intercept' | 'request' | 'headers';
    /** 在该数组里的下标（0 起） */
    index: number;
    /** 缺什么 */
    reason: string;
}

export const collectDroppedRules = (rules: {
    intercept?: { enabled?: boolean; jsonPath?: string }[];
    request?: { enabled?: boolean; jsonPath?: string }[];
    headers?: { enabled?: boolean; headerName?: string }[];
}): DroppedRule[] => {
    const out: DroppedRule[] = [];

    const fields = (list: { enabled?: boolean; jsonPath?: string }[] | undefined, group: 'intercept' | 'request') => {
        (list || []).forEach((rule, index) => {
            if (isFieldRuleDropped(rule)) {
                out.push({ group, index, reason: 'jsonPath 为空（或只有 "."），没有目标键的规则永远匹配不上' });
            }
        });
    };

    fields(rules.intercept, 'intercept');
    fields(rules.request, 'request');

    (rules.headers || []).forEach((rule, index) => {
        if (isHeaderRuleDropped(rule)) {
            out.push({ group: 'headers', index, reason: 'headerName 为空' });
        }
    });

    return out;
};

/* -------------------------------------------------------------------------- */
/*                              嗅探结果的归属                                  */
/* -------------------------------------------------------------------------- */

/**
 * 这条嗅探结果是否属于某个页面。
 *
 * **三处共用的唯一判据**：「仅当前页」筛选、当前页计数、「清空当前」。
 * 三处曾经各写一份，其中「清空当前」那份少了 `!pageUrl` 这一支 ——
 * 于是没有 pageUrl 的条目（旧缓存、网络层未带上）在「仅当前页」下可见却清不掉，
 * 用户点「清空当前」后列表里还剩几条，看起来像按钮没生效。
 *
 * pageUrl 为空视为属于当前页：那种条目无法归到任何具体页面，
 * 若不算进来就会永远清不掉，只能点「清空全部」。
 */
export const isLinkFromPage = (
    link: { pageUrl?: string } | null | undefined,
    pageUrl: string,
): boolean => !!link && (!link.pageUrl || link.pageUrl === pageUrl);

/* -------------------------------------------------------------------------- */
/*                              Cookie 工具                                     */
/* -------------------------------------------------------------------------- */

/**
 * 是不是一个可用于 cookie 查询的真实地址。
 *
 * 空白标签页的 url 是空串；`about:blank` 之类的内部页也没有可查的 cookie。
 * 这两种都不能交给 cookies.get —— **空串在那里表示"全部 URL"**，
 * 会把所有站点的 cookie 一起列出来。
 */
export const isRealUrl = (url: string): boolean => {
    if (!url || url === 'about:blank') {
        return false;
    }

    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
};

/**
 * Cookie 列表在界面上的唯一键（与入参等长、同序）。
 *
 * Chrome 的 cookie 主键是 **name + domain + path**，三者任一不同即为两条独立 cookie。
 * 访问 `https://sub.example.com/` 时 cookies.get 会同时返回
 * `sid@sub.example.com/` 与 `sid@.example.com/` —— 只按 name 建索引会让它们
 * 在面板里互相覆盖：一条的值盖掉另一条，而按 key 回写时又只命中先出现的那条，
 * 于是**另一条永远看不到、也改不到**。
 *
 * 但不能无脑把 domain 全写上：绝大多数站点只有一条同名 cookie，
 * 那样会把界面刷成 `token (www.example.com)` 这种噪声。
 * 所以**先算最简键，只在真会撞的时候才补区分信息**。
 */
export const buildCookieKeys = (
    cookies: { name: string; path?: string; domain?: string }[],
): string[] => {
    const brief = cookies.map((c) =>
        !c.path || c.path === '/' ? c.name : `${c.name} (${c.path})`);

    // 统计每个最简键出现几次，只给重复的那些补 domain
    const counts = new Map<string, number>();
    for (const k of brief) counts.set(k, (counts.get(k) || 0) + 1);

    return brief.map((k, i) => {
        if ((counts.get(k) || 0) <= 1) return k;
        const domain = cookies[i].domain;
        return domain ? `${k} @${domain}` : k;
    });
};

/**
 * 面板要展示的 Cookie 键值表。
 *
 * 用 `buildCookieKeys` 保证键唯一 —— 直接用 reduce 累积的话，
 * 撞键的两条会静默合并成一条（后写的赢），面板少显示一行而没有任何提示。
 */
export const buildCookieData = (
    cookies: { name: string; value: string; path?: string; domain?: string }[],
): Record<string, string> => {
    const keys = buildCookieKeys(cookies);
    const out: Record<string, string> = {};
    cookies.forEach((c, i) => { out[keys[i]] = c.value; });
    return out;
};

/** 按 `buildCookieData` 的键取回原 cookie；找不到返回 null */
export const findCookieByKey = <T extends { name: string; path?: string; domain?: string }>(
    cookies: T[],
    key: string,
): T | null => {
    const keys = buildCookieKeys(cookies);
    const i = keys.indexOf(key);
    return i >= 0 ? cookies[i] : null;
};

/* -------------------------------------------------------------------------- */
/*                              JWT 令牌工具                                    */
/*                                                                            */
/*  面板与 Agent 工具共用同一份实现。放在这里而不是某个组件里，是因为两边都要   */
/*  用它，且它是纯函数 —— 能直接进 Node 回归测试，不必起浏览器。              */
/* -------------------------------------------------------------------------- */

/**
 * 候选 token 的形状：两段或三段 base64url。
 *
 * 两段也接受：未签名的调试 token 只有 `header.payload`，要求三段会把它们全漏掉。
 * 签名段可以为空串（`a.b.` 合法），所以第三段用 `*` 而不是 `+`。
 */
const JWT_SHAPE = /^[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}(\.[A-Za-z0-9_-]*)?$/;

/** 这个值是否长得像 JWT */
export const looksLikeJwt = (value: string): boolean => JWT_SHAPE.test(value);

/**
 * 从一堆字符串里挑出所有像 JWT 的值，去重且保持出现顺序。
 *
 * Cookie 值常见 `Bearer xxx` 前缀，所以取最后一段再判；非字符串一律跳过。
 */
export const pickJwtCandidates = (values: unknown[]): string[] => {
    const out: string[] = [];
    for (const raw of values) {
        if (typeof raw !== 'string') continue;
        const token = raw.trim().split(/\s+/).pop() || '';
        if (looksLikeJwt(token) && !out.includes(token)) out.push(token);
    }
    return out;
};

export interface DecodedJwt {
    header: unknown;
    payload: unknown;
}

/**
 * base64url 段 → 字节。
 *
 * 必须补回 `=` 填充：atob 对长度不是 4 的倍数的输入直接抛
 * InvalidCharacterError，而 JWT 规范要求**去掉**填充 ——
 * 不补的话绝大多数真实 token 都解不开。
 */
const base64UrlToBytes = (segment: string): Uint8Array => {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
};

/** 字节 → base64url（无填充），逐字节拼接而非展开成参数，避免长 payload 爆栈 */
const bytesToBase64Url = (bytes: Uint8Array): string => {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** 拆出 JWT 的三段（签名段可能不存在，返回空串） */
const splitJwt = (token: string): string[] => {
    const parts = String(token || '').trim().split('.');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
        throw new Error('不是有效的 JWT：至少要有 header.payload 两段');
    }
    return parts;
};

/**
 * 解 JWT 的 header / payload。
 *
 * base64url 不能直接 atob 后 JSON.parse：atob 返回的是 Latin-1 字节串，
 * payload 里只要有中文/日文就会变成乱码（实测 `{"name":"张三"}` 解成
 * `{"name":"å¼ ä¸"}`）。必须先还原成 UTF-8 字节再用 TextDecoder 解。
 * 带 emoji 的 payload 在部分实现下还会直接抛 InvalidCharacterError。
 */
export const decodeJwt = (token: string): DecodedJwt => {
    const parts = splitJwt(token);
    const read = (segment: string): unknown =>
        JSON.parse(new TextDecoder('utf-8').decode(base64UrlToBytes(segment)));
    return { header: read(parts[0]), payload: read(parts[1]) };
};

/**
 * 改写 payload 字段并重组 token。
 *
 * **只替换 payload 段**，header 与签名段逐字符原样搬运 —— 重新编码 header
 * 可能改变它的字节形态（键序、空白），而签名是对 `header.payload` 的原始
 * 字节串算的，动 header 会让本来能用的 token 变成另一种坏法。
 *
 * 改完**签名必然失效**：签名覆盖的正是 payload。服务端若验签就会拒绝。
 * 这不是缺陷，是这类调试的固有前提 —— 调用方必须把这句话一并交代给用户。
 */
export const rewriteJwtPayload = (token: string, changes: Record<string, unknown>): string => {
    const parts = splitJwt(token);
    const { payload } = decodeJwt(token);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('payload 不是 JSON 对象，无法按字段改写');
    }

    const merged = { ...(payload as Record<string, unknown>), ...changes };
    const segment = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(merged)));
    return [parts[0], segment, ...parts.slice(2)].join('.');
};

/* -------------------------------------------------------------------------- */
/*                          .aibook AI 绘本单文件格式                          */
/*                                                                            */
/*  与 .gallery 的取舍不同：绘本正文是文字、图片数量少（通常 3～20 页）且需要    */
/*  连文案、语音一起整体分享，所以用 JSON 单文件而非 ZIP——自描述、可读、可手改， */
/*  也省掉解压依赖。代价是图片以 data URL 内联，体积比 ZIP 大约 33%。            */
/*                                                                            */
/*  磁盘形态：                                                                 */
/*      { "version": "1.0", "title": "小狐狸的月亮",                            */
/*        "pages": [ { "image": "data:image/png;base64,...", "text": "…",      */
/*                     "audio": "…" }, … ] }                                   */
/* -------------------------------------------------------------------------- */

/** 当前写出的格式版本 */
export const AIBOOK_VERSION = '1.0';

/** 单本绘本的页数上限（与画廊包同量级，防呆而非业务限制） */
export const AIBOOK_MAX_PAGES = 2000;

/**
 * 文件名做 .aibook 输出名：去非法字符、压空白、限长。
 * 与 galleryPack 的 sanitizePackName 同口径，保持两套导出行为一致。
 */
export const sanitizeBookName = (name: string): string => {
    const clean = String(name || '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return clean || '未命名故事';
};

/** 是否为 .aibook 文件（按后缀判定，导入入口用） */
export const isAiBookFileName = (fileName: string): boolean =>
    /\.aibook$/i.test((fileName || '').trim());

/** 组装一本 .aibook 的 JSON 文本 */
export const buildAiBookJson = (title: string, pages: AiBookPage[]): string => {
    const payload: AiBookFile = {
        version: AIBOOK_VERSION,
        title: (title || '').trim() || '未命名故事',
        pages,
    };
    return JSON.stringify(payload, null, 2);
};

/** 组装一本 .aibook 的 Blob（供下载 / Electron 另存为） */
export const buildAiBookBlob = (title: string, pages: AiBookPage[]): Blob =>
    new Blob([buildAiBookJson(title, pages)], { type: 'application/json' });

export interface ParsedAiBook {
    title: string;
    pages: AiBookPage[];
}

/**
 * 解析 .aibook 文本。
 *
 * 容错策略：字段缺失/类型不对的页直接跳过；一页不剩才抛错。
 * 这样用户手改坏一页仍能打开整本书。
 */
export const parseAiBookText = (text: string, fallbackTitle = '未命名故事'): ParsedAiBook => {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (error) {
        throw new Error(`不是合法的 .aibook 文件（JSON 解析失败）：${error instanceof Error ? error.message : '未知错误'}`);
    }

    const file = data as Partial<AiBookFile>;
    if (!file || typeof file !== 'object') throw new Error('不是合法的 .aibook 文件（内容为空）');
    if (!Array.isArray(file.pages)) throw new Error('不是合法的 .aibook 文件（缺少 pages 数组）');

    const pages: AiBookPage[] = [];
    for (const raw of file.pages.slice(0, AIBOOK_MAX_PAGES)) {
        const page = raw as Partial<AiBookPage>;
        if (!page || typeof page !== 'object') continue;
        const image = typeof page.image === 'string' ? page.image.trim() : '';
        if (!image) continue;
        pages.push({
            image,
            text: typeof page.text === 'string' ? page.text : '',
            audio: typeof page.audio === 'string' && page.audio ? page.audio : undefined,
        });
    }

    if (pages.length === 0) throw new Error('这本 .aibook 里没有任何有效页面');

    const title = typeof file.title === 'string' && file.title.trim() ? file.title.trim() : fallbackTitle;
    return { title, pages };
};

/** 读取并解析 .aibook 文件 */
export const readAiBookFile = async (file: File): Promise<ParsedAiBook> => {
    const text = await file.text();
    const fallback = file.name.replace(/\.aibook$/i, '').trim() || '未命名故事';
    return parseAiBookText(text, fallback);
};

/* -------------------------------------------------------------------------- */
/*                          .gallery 画廊文件夹格式                             */
/*                                                                            */
/*  磁盘布局（一个文件夹即一本画廊）：                                          */
/*      我的画廊/                                                              */
/*          我的画廊.gallery   ← 徽标/清单文件（JSON，可含标题/作者/来源）        */
/*          1.png                                                              */
/*          2.jpg                                                              */
/*  规则：只有“徽标存在 + 至少一张数字命名图片”才认作画廊；                       */
/*  非数字文件名、非图片后缀一律忽略。                                          */
/* -------------------------------------------------------------------------- */

/** 图片后缀集合（由 MEDIA_EXTENSIONS 反查，保证与播放器判断一致） */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(
    Object.entries(MEDIA_EXTENSIONS)
        .filter(([, v]) => v === 'image')
        .map(([k]) => k)
);

/** 是否为画廊徽标文件（*.gallery） */
export const isGalleryMarker = (fileName: string): boolean =>
    /\.gallery$/i.test((fileName || '').trim());

/** 画廊徽标文件名取画廊名（去掉 .gallery 后缀） */
export const galleryNameFromMarker = (fileName: string): string => {
    const base = (fileName || '').split('/').pop() || '';
    return base.replace(/\.gallery$/i, '').trim() || '未命名画廊';
};

/** 取文件名（不含后缀） */
const stemOf = (fileName: string): string => {
    const base = (fileName || '').split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    return (dot > 0 ? base.slice(0, dot) : base).trim();
};

/** 取小写后缀（无后缀返回 ''） */
const extOf = (fileName: string): string => {
    const base = (fileName || '').split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/**
 * 若是“数字命名 + 图片后缀”返回页码（1-based 整数），否则返回 null。
 * 前导零、空格都接受（"001.png"→1）；小数/负数/非数字一律忽略。
 */
export const galleryPageNumber = (fileName: string): number | null => {
    const stem = stemOf(fileName);
    const ext = extOf(fileName);
    if (!stem || !IMAGE_EXTENSIONS.has(ext)) return null;
    if (!/^\d+$/.test(stem)) return null;
    const n = parseInt(stem, 10);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
};

/**
 * 画廊徽标（*.gallery）的数据结构。
 *
 * 注意：**只声明形状，不在这里生成**。徽标正文由主进程
 * electron/acgmhoService.js 的 writeGalleryOutputs 落盘（它才是写文件的那一侧）。
 * 这里曾有一个 buildGalleryManifest() 生成器，但从未被任何调用方使用，
 * 且它的字段集与 acgmhoService 实际写出的内容已经漂移 —— 两份"真值"迟早对不上，
 * 故删除，只保留类型供读取侧（galleryPack / PlayPanel）引用。
 */
export interface GalleryManifest {
    format: 'the-play-gallery/1';
    title: string;
    gid?: string;
    artist?: string;
    sourceUrl?: string;
    totalPages: number;
    createdAt: string;
}

/** 文件夹相对目录（webkitRelativePath 的目录部分；无则返回 ''） */
export const dirOfFile = (file: File): string => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const idx = rel.lastIndexOf('/');
    return idx > 0 ? rel.slice(0, idx) : '';
};

export interface DetectedGallery {
    /** 分组唯一键 */
    groupId: string;
    /** 画廊名（徽标文件名） */
    name: string;
    /** 所在相对目录 */
    dir: string;
    /** 按页码升序排好的图片文件 */
    pages: { file: File; page: number }[];
    /** 徽标文件本身（不进播放列表，仅作凭证） */
    marker: File;
}

export interface SplitImportFiles {
    galleries: DetectedGallery[];
    /** 未被画廊收编的文件（含孤立徽标） */
    loose: File[];
    /** 孤立徽标（有 .gallery 但同目录无有效图片）：调用方可转为占位提示条目 */
    orphanMarkers: File[];
}

/**
 * 从一批文件（文件/文件夹混合选择）中识别画廊文件夹。
 * 同目录下：徽标存在 + ≥1 张有效图片 ⇒ 成组；其余文件原样归入 loose。
 */
export const detectGalleryFolders = (files: File[]): SplitImportFiles => {
    const galleries: DetectedGallery[] = [];
    const loose: File[] = [];
    const orphanMarkers: File[] = [];

    const byDir = new Map<string, File[]>();
    for (const f of files) {
        const dir = dirOfFile(f);
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir)!.push(f);
    }

    for (const [dir, group] of byDir) {
        const markers = group
            .filter((f) => isGalleryMarker(f.name))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        if (markers.length === 0) {
            loose.push(...group);
            continue;
        }
        const pages = group
            .map((f) => ({ file: f, page: galleryPageNumber(f.name) }))
            .filter((p): p is { file: File; page: number } => p.page != null)
            .sort((a, b) => a.page - b.page);
        if (pages.length === 0) {
            // 有徽标无有效图片：整组不认，徽标记为孤立（提示用），其余进 loose
            orphanMarkers.push(...markers);
            loose.push(...group.filter((f) => !isGalleryMarker(f.name)));
            continue;
        }
        const marker = markers[0];
        const name = galleryNameFromMarker(marker.name);
        galleries.push({
            groupId: `gallery:${dir}/${name}`,
            name,
            dir,
            pages,
            marker,
        });
        // 已认定的画廊目录：徽标本身不进播放列表，其余不合规文件（非数字命名/非图片）
        // 按格式约定直接忽略，不散装进 loose
        continue;
    }

    return { galleries, loose, orphanMarkers };
};