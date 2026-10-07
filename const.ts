/**
 * const.ts — 全局常量、类型与纯工具函数的唯一入口。
 *
 * 由原 utils/ 目录的四个文件合并而来（utils / persist / galleryPack / agentExport）：
 * 它们之间本就有依赖（galleryPack 用 galleryPageNumber、agentExport 用 downloadBlob），
 * 拆成四个文件只产生跨文件 import，没有真实的边界。合并后按用途分节，
 * 节内一律「常量 → 类型 → 函数」。
 *
 * 两条约定：
 *  - 只放**无副作用、不依赖 React** 的东西，因此能被 Node 回归测试直接 require
 *    （test/tsconfig.json 把本文件编译到 test/build/const.js）；
 *  - 主进程（electron/*.js）是独立进程、不能 import TS，凡有跨进程同源要求的判据
 *    （MEDIA_EXTENSIONS / HLS_SEGMENT_RE_SOURCE / requiresFfmpeg）都在注释里点名，
 *    由 test/sniffer.test.js 与 test/mainstatic.test.js 盯着两边不漂移。
 */
import JSZip from 'jszip';
import type {
    AgentCompaction,
    AgentMessage,
    AiBookFile,
    AiBookPage,
    AiUsage,
    GalleryProbeResult,
    MediaType,
    VideoFile,
} from './meta';

/* ==========================================================================
 * 1. 本地存储（localStorage）
 * ========================================================================== */

/** 播放器偏好的**裸键**（无前缀的历史键名，改动即等于丢掉用户已存的设置） */
export const STORAGE_KEYS = {
    VOLUME: 'react-player-volume',
    MODE: 'react-player-mode',
    RATE: 'react-player-rate',
    FIT: 'react-player-fit',
};

/** 悬浮球状态的默认命名空间，兼容历史键 */
const STORAGE_PREFIX = 'theplay.floating.';

/**
 * 拼出真正的存储键。
 *
 * ns 传空串表示读写裸键（播放器偏好、书签等历史键没有前缀），
 * 不传（undefined / null）才落到默认命名空间。
 */
const storageKey = (key: string, ns?: string): string =>
    ns === undefined || ns === null ? STORAGE_PREFIX + key : `${ns}${key}`;

/** 读 JSON；键不存在、内容损坏、隐私模式一律回落 fallback */
export const loadJSON = <T>(key: string, fallback: T, ns?: string): T => {
    try {
        const raw = localStorage.getItem(storageKey(key, ns));
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
};

/** 写 JSON；配额爆了只丢本次快照，返回是否写成功（调用方无需再 try/catch） */
export const saveJSON = (key: string, value: unknown, ns?: string): boolean => {
    try {
        localStorage.setItem(storageKey(key, ns), JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
};

/** 删键；删不掉（隐私模式）不影响功能 */
export const removeStored = (key: string, ns?: string): void => {
    try {
        localStorage.removeItem(storageKey(key, ns));
    } catch {
        /* 忽略 */
    }
};

/** 安全读原始字符串（getItem 抛错会崩初始化，裸键直读的历史代码统一走这里） */
export const loadStr = (key: string, fallback = '', ns = ''): string => {
    try {
        const raw = localStorage.getItem(storageKey(key, ns));
        return raw == null ? fallback : raw;
    } catch {
        return fallback;
    }
};

/** 安全写原始字符串，返回是否成功（配额爆了也不抛错） */
export const saveStr = (key: string, value: string, ns = ''): boolean => {
    try {
        localStorage.setItem(storageKey(key, ns), value);
        return true;
    } catch {
        return false;
    }
};

/* ==========================================================================
 * 2. 媒体类型判定
 * ========================================================================== */

/**
 * 后缀 → 媒体类型的**唯一真值**（按扩展名判定的路径都从这里派生）。
 *
 * 派生方：getMediaType 的查表、嗅探扫描清单（useBrowse 的 CATEGORIES）、
 * 画廊页码识别（本文件的 IMAGE_EXTENSIONS）、主进程的嗅探后缀表（派生副本）。
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

/**
 * HLS 分片路径判据的**正则源码**（不是正则对象）。
 *
 * 导出字符串而不是正则对象：页内嗅探脚本整体是一个模板字符串、注入浏览器执行，
 * 它没法 import 一个正则对象，只能把源码插值进去自己 new RegExp。
 * 三处共用这一份语义：页内脚本（插值源码）、文本兜底提取（isHlsSegmentPath）、
 * 主进程网络层（electron/main.js 逐字复制，独立进程不能 import TS，
 * 由 test/sniffer.test.js 盯着两边不漂移）。
 *
 * 用途：判断一个 **.ts** 地址是 HLS 分片（丢弃）还是整段视频（保留）。
 * 判据只在 ext === 'ts' 时被调用，所以每条分支都锚在 .ts 上 ——
 * 不写成通用"像不像分片"，那样会把 `seg.mp4` 这种正常文件也判进来。
 *
 * 四条判据，都是实测见过的分片命名：
 *  1. 目录段是分片词（`/ts/000.ts`、`/seg/1.ts`、`/seg-1/x.ts`）——
 *     分片常被集中放在固定目录下；
 *  2. 文件名以分片词开头（`seg1.ts`、`chunk_00001.ts`、`part.ts`）——
 *     `\d*` 不能省：`seg1.ts` 里 `g` 与 `1` 都是词字符，`\bseg\b` 整条漏掉；
 *  3. 文件名整个是数字（`000.ts`、`1.ts`）；
 *  4. `[-_]\d+.ts`，兜住 `xxx-1.ts`。
 *
 * 数字判据**锚在文件名上**，不是"路径里出现两位数字"：
 * 后者会把 `/video/2024/lecture.ts` 这种带年份目录的整段视频当成分片丢掉
 * —— 而整段 .ts 同样可下载，正是这份判据要保护的东西。
 */
export const HLS_SEGMENT_RE_SOURCE =
    '(?:^|/)(?:segment|seg|chunk|slice|frag|part|track|ts)[-_]?\\d*/'
    + '|(?:^|/)(?:segment|seg|chunk|slice|frag|part|track)[-_]?\\d*\\.ts$'
    + '|(?:^|/)\\d+\\.ts$'
    + '|[-_]\\d+\\.ts$';

/** 判断一个 URL 的路径是不是 HLS 分片（只对 .ts 有意义，大小写不敏感） */
export const isHlsSegmentPath = (pathname: string): boolean =>
    !!pathname && new RegExp(HLS_SEGMENT_RE_SOURCE, 'i').test(pathname);

/**
 * 这条资源是否**必须交给 ffmpeg** 才能得到可用文件。
 *
 * 判据取或，两个都要看：
 *  - `type === 'stream'`：渲染层已经把它归类为流（页内脚本按后缀判、AI 提取按模型给的类型判）；
 *  - 后缀属 stream 类：`ext='flv'` 但 `type='video'` 是真实存在的组合 ——
 *    AI 提取时模型给的 type 与 URL 后缀不必自洽（`{"url":"...x.flv","type":"video"}`）。
 *
 * **三处必须同源**，否则界面与实际行为对不上：
 *  - 主进程 handleMediaDownload 的 isStream（决定走 ffmpeg 还是裸 HTTP）；
 *  - 嗅探面板的「下载」按钮禁用条件（ffmpeg 缺失时该不该拦）；
 *  - 下载提示文案。
 * 判据不一致的后果实测过：界面按 type 判、主进程按 ext 判，
 * 于是一个 .flv 条目在 ffmpeg 缺失时按钮照常可点，点下去才报"未找到 ffmpeg"。
 *
 * 主进程是独立进程不能 import 本文件，那边是逐字复制的副本，
 * 由 test/sniffer.test.js 盯着两边不漂移。
 */
export const requiresFfmpeg = (type: string | undefined, ext: string | undefined): boolean =>
    type === 'stream' || MEDIA_EXTENSIONS[(ext || '').toLowerCase()] === 'stream';

/** 剥掉 query 与 hash 只留路径；非 URL（含 blob:）回落成字符串切分 */
const cleanUrlPath = (urlFull: string): string => {
    if (urlFull.startsWith('blob:')) return '';
    try {
        return new URL(urlFull).pathname;
    } catch {
        return urlFull.split('?')[0].split('#')[0];
    }
};

/** 从名字或地址里取小写后缀（无后缀返回 ''） */
const extFromStr = (str?: string): string => {
    if (!str) return '';
    const match = cleanUrlPath(str).toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
};

/**
 * 媒体类型推断。优先级：MIME > 后缀查表 > 关键字兜底 > other。
 *
 * 兜底那组关键字刻意比查表更松（子串匹配），用来接住"后缀被 query 藏起来"
 * 的地址；未知文件**严禁**归为视频，一律落 other。
 */
export const getMediaType = (name: string, mimeType?: string, url?: string): MediaType => {
    if (mimeType) {
        if (mimeType === 'application/x-mpegurl'
            || mimeType === 'application/vnd.apple.mpegurl'
            || mimeType === 'application/dash+xml') {
            return 'stream';
        }
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType.startsWith('audio/')) return 'audio';
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('text/')
            || mimeType === 'text/markdown'
            || mimeType === 'application/pdf'
            || mimeType === 'application/json') {
            return 'document';
        }
    }

    // 名字里的后缀优先；它不认识时（或压根没有）才回落到地址
    let ext = extFromStr(name);
    if (!MEDIA_EXTENSIONS[ext]) {
        const urlExt = extFromStr(url);
        if (MEDIA_EXTENSIONS[urlExt]) ext = urlExt;
    }
    if (MEDIA_EXTENSIONS[ext]) return MEDIA_EXTENSIONS[ext];

    const lowerBoth = `${name || ''} ${url || ''}`.toLowerCase();
    if (lowerBoth.includes('.m3u8') || lowerBoth.includes('.mpd')) return 'stream';
    if (['.webp', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.avif'].some((s) => lowerBoth.includes(s))) return 'image';
    if (['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.opus'].some((s) => lowerBoth.includes(s))) return 'audio';
    if (['.mp4', '.mkv', '.webm', '.avi', '.mov', '.wmv', '.flv'].some((s) => lowerBoth.includes(s))) return 'video';
    if (['.md', '.markdown', '.txt', '.log', '.pdf', '.json'].some((s) => lowerBoth.includes(s))) return 'document';

    return 'other';
};

/* ==========================================================================
 * 3. 播放条目的构造与资源释放
 * ========================================================================== */

/** 生成简短的随机 ID，用于列表项的唯一标识 */
export const generateId = (): string => {
    try {
        const uuid = (globalThis as { crypto?: { randomUUID?: () => string } })?.crypto?.randomUUID?.();
        if (typeof uuid === 'string' && uuid.length > 0) return uuid.replace(/-/g, '').slice(0, 12);
    } catch {
        /* 无 crypto 的宿主回落到下面的时间戳方案 */
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
};

/** 播放器可接受的 URL 白名单校验：仅 http(s) / blob，拒绝 javascript:/data:/file: 等 */
export const isValidMediaUrl = (url: string): boolean => {
    const trimmed = (url || '').trim();
    if (!trimmed || trimmed.length > 8192) return false;
    if (/^(javascript|data|file|vbscript):/i.test(trimmed)) return false;
    return /^(https?:\/\/|blob:)/i.test(trimmed);
};

/** 封装本地文件对象为播放器可用的数据结构 */
export const createVideoFile = (file: File, folder?: string): VideoFile => {
    const item: VideoFile = {
        id: generateId(),
        file,
        url: URL.createObjectURL(file),
        name: file.name,
        type: 'file',
        mediaType: getMediaType(file.name, file.type),
    };
    if (folder) item.folder = folder;
    return item;
};

/** 封装网络流媒体链接（extra 用于透出封面、艺术家等附加字段） */
export const createStreamFile = (
    url: string,
    name?: string,
    mediaType?: MediaType,
    extra?: Partial<VideoFile>,
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
 * 清理资源，防止内存泄漏：释放 URL.createObjectURL 创建的 Blob URL。
 *
 * 判据是「URL 是不是 blob:」而不是「条目 type 是不是 file」：
 * .aibook 绘本页由 data URL 转成 blob: 后以 stream 条目入列（没有本地 File），
 * 旧判据会把这些 Blob 全部漏掉，反复导入导出绘本会持续吃内存。
 */
export const revokeVideoFile = (videoFile: VideoFile): void => {
    if (videoFile.url && videoFile.url.startsWith('blob:')) {
        URL.revokeObjectURL(videoFile.url);
    }
};

/**
 * 触发一次"下载文件"（音频工程包导出 / 画廊与绘本另存回退 / Agent 会话导出共用）。
 *
 * 原先三处各写一份，差异只在 revoke 时机与是否入文档 —— 而这两点写错都不报错：
 * 前者表现为"下载到一半失败"，后者表现为"点了没反应"。统一成一份之后，
 * 只剩这一个地方需要被盯住。两个细节都是有意的：
 *
 * - **入文档再点**：游离节点在部分内核上不触发下载；
 * - **延迟 revoke**：`click()` 只是发起导航，Chromium 是异步读 Blob 的，
 *   紧接着 revoke 有概率拿到已回收的 URL。留一拍再释放更稳，
 *   5 秒对用户无感（文件此时早已落盘）。
 *
 * Electron 下这次下载会被 session 的 will-download 接管，落进下载目录并
 * 出现在下载列表里（见 electron/browserService.js 的 beginDownload）。
 */
export const downloadBlob = (blob: Blob, fileName: string): void => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
};

/* ==========================================================================
 * 4. 图片编解码（data URL ⇄ File / Blob URL）
 * ========================================================================== */

/**
 * data URL 拆成 { mimeType, base64 }。
 * 非 data URL（http/blob）返回 null —— 调用方需自行先取回字节。
 */
export const splitDataUrl = (dataUrl: string): { mimeType: string; base64: string } | null => {
    const match = String(dataUrl || '').match(/^data:([^;,]*);base64,(.*)$/s);
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
 * 内容不是合法 data URL 时返回空串，调用方按"没有图"处理。
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

/* ==========================================================================
 * 5. ACG 站点：域名判定、HLS 签名补全、探测结果解析
 * ========================================================================== */

/** ACG 专属资源判定（与主进程 setupSniffer 同口径）：站点 + 图床域名 */
const ACG_HOST_SUFFIXES = ['acgmho.com', 'acgnngca.com', 'acgnfl.com', 'acg-hentai.com'];

/** 命中者不进嗅探列表，一律走画廊流程 */
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

export interface ResolvedProbeMedia {
    kind: 'video' | 'audio' | 'image' | 'none';
    streams: (Partial<VideoFile> & { url: string; title?: string })[];
    totalPages: number;
    status: string | null;
}

/** 探测音轨单项：与 GalleryProbeResult.audioList 同构，但字段放宽为可选以容忍脏数据 */
interface ProbeAudioTrack {
    name?: string;
    url?: string;
    artist?: string;
    cover?: string;
}

/**
 * ACG probe 结果统一解析（App 与 PlayPanel 共用，消除三处重复分支）。
 *
 * 两条分支都不允许"拿别的资源冒充"：video 缺直链时不再拿封面图顶替、
 * audio 缺音轨时不再把页面地址当音频 —— 那会产生播不出的坏条目，
 * 表现为列表里点一下就报错。缺资源时回落成 kind:'none' 并给出 status 文案。
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
                    // 艺术家与封面一并透出：音频视图凭此展示署名与封面 discs，不再裸奔 URL
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
        .map((p) => ({ url: p.url, title: p.title || `P${p.page}`, page: p.page as number }));
    return { runId, pages, errors: res.errors ?? [] };
};

/* ==========================================================================
 * 6. 篡改规则的可用性
 *
 * 引擎（注入脚本）、面板、Agent 工具三处都要判断"这条规则引擎会不会用"。
 * 引擎那份在模板字符串里、无法 import，所以这里是**面板与工具**的单一实现，
 * 与引擎的一致性由回归测试交叉验证（见 test/tamper.test.js）。
 * ========================================================================== */

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
 * 被引擎跳过的规则，附带它在原数组里的下标与原因。
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

    const collectFields = (list: { enabled?: boolean; jsonPath?: string }[] | undefined, group: 'intercept' | 'request') => {
        (list || []).forEach((rule, index) => {
            if (isFieldRuleDropped(rule)) {
                out.push({ group, index, reason: 'jsonPath 为空（或只有 "."），没有目标键的规则永远匹配不上' });
            }
        });
    };

    collectFields(rules.intercept, 'intercept');
    collectFields(rules.request, 'request');

    (rules.headers || []).forEach((rule, index) => {
        if (isHeaderRuleDropped(rule)) out.push({ group: 'headers', index, reason: 'headerName 为空' });
    });

    return out;
};

/* ==========================================================================
 * 7. 嗅探结果的归属与标题
 * ========================================================================== */

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

/**
 * 标题是不是"没信息量"的那种。
 *
 * 命中即说明这个标题来自文件名或占位符，而不是页面标题 ——
 * 嗅探列表应当用宿主页面标题把它顶掉。
 *
 * 三类：
 *  - 占位与通用名（`Media_xxx` / `detected` / `hls` / `playlist` / `index` / `stream` / `chunk`）；
 *  - 纯哈希文件名（16 位以上十六进制，CDN 常见）；
 *  - 纯数字文件名（8 位以上，如时间戳命名）。
 * 判据前先剥掉扩展名，否则 `index.m3u8` 这类会被当成"有内容"。
 *
 * **新增与更新两条路径必须共用这一个判据**（useBrowse 的 addLinks）。
 * 原先它们各写一份：新增用这套较全的，更新只看 `startsWith('Media_')` ——
 * 于是标题为文件名（`index.m3u8`，入库时页面标题还没拿到）的条目
 * 永远升不了级，列表里一直挂着那个文件名。
 */
export const isGenericTitle = (title: string | undefined | null): boolean => {
    if (!title) return true;
    const stem = title.replace(/\.[a-zA-Z0-9]+$/, '');
    return /^(media_|detected|hls|playlist|index|stream|chunk)/i.test(title)
        || /^[0-9a-f]{16,}$/i.test(stem)
        || /^\d{8,}$/.test(stem);
};

/* ==========================================================================
 * 8. Cookie 工具
 * ========================================================================== */

/**
 * 是不是一个可用于 cookie 查询的真实地址。
 *
 * 空白标签页的 url 是空串；`about:blank` 之类的内部页也没有可查的 cookie。
 * 这两种都不能交给 cookies.get —— **空串在那里表示"全部 URL"**，
 * 会把所有站点的 cookie 一起列出来。
 */
export const isRealUrl = (url: string): boolean => {
    if (!url || url === 'about:blank') return false;
    try {
        const { protocol } = new URL(url);
        return protocol === 'http:' || protocol === 'https:';
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
    const i = buildCookieKeys(cookies).indexOf(key);
    return i >= 0 ? cookies[i] : null;
};

/* ==========================================================================
 * 9. JWT 工具
 *
 * 面板与 Agent 工具共用同一份实现。放在这里而不是某个组件里，是因为两边都要
 * 用它，且它是纯函数 —— 能直接进 Node 回归测试，不必起浏览器。
 * ========================================================================== */

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

/* ==========================================================================
 * 10. .aibook —— AI 绘本单文件格式
 *
 * 与 .gallery 的取舍不同：绘本正文是文字、图片数量少（通常 3～20 页）且需要
 * 连文案、语音一起整体分享，所以用 JSON 单文件而非 ZIP —— 自描述、可读、可手改，
 * 也省掉解压依赖。代价是图片以 data URL 内联，体积比 ZIP 大约 33%。
 *
 * 磁盘形态：
 *     { "version": "1.0", "title": "小狐狸的月亮",
 *       "pages": [ { "image": "data:image/png;base64,...", "text": "…",
 *                    "audio": "…" }, … ] }
 * ========================================================================== */

/** 当前写出的格式版本 */
export const AIBOOK_VERSION = '1.0';

/** 单本绘本的页数上限（与画廊包同量级，防呆而非业务限制） */
export const AIBOOK_MAX_PAGES = 2000;

/**
 * 文件名做输出名：去非法字符、压空白、限长。
 * 绘本与画廊包共用同一口径，两套导出行为才不会一个能落盘一个报错。
 */
const sanitizeFileName = (name: string, fallback: string): string => {
    const clean = String(name || '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return clean || fallback;
};

/** .aibook 输出名 */
export const sanitizeBookName = (name: string): string => sanitizeFileName(name, '未命名故事');

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

/** 读取并解析 .aibook 文件（书名缺省取文件名） */
export const readAiBookFile = async (file: File): Promise<ParsedAiBook> => {
    const text = await file.text();
    const fallback = file.name.replace(/\.aibook$/i, '').trim() || '未命名故事';
    return parseAiBookText(text, fallback);
};

/* ==========================================================================
 * 11. 画廊：文件夹形态
 *
 * 磁盘布局（一个文件夹即一本画廊）：
 *     我的画廊/
 *         我的画廊.gallery   ← 徽标/清单文件（JSON，可含标题/作者/来源）
 *         1.png
 *         2.jpg
 * 规则：只有“徽标存在 + 至少一张数字命名图片”才认作画廊；
 * 非数字文件名、非图片后缀一律忽略。
 * ========================================================================== */

/** 取路径最后一段（webkitRelativePath 或裸文件名都适用） */
const baseNameOf = (path: string): string => (path || '').split('/').pop() || '';

/** 文件在所选目录里的相对路径（普通选择退化成文件名） */
const relPathOf = (file: File): string =>
    (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

/** 文件夹相对目录（webkitRelativePath 的目录部分；无则返回 ''） */
export const dirOfFile = (file: File): string => {
    const rel = relPathOf(file);
    const idx = rel.lastIndexOf('/');
    return idx > 0 ? rel.slice(0, idx) : '';
};

/** 图片后缀集合（由 MEDIA_EXTENSIONS 反查，保证与播放器判断一致） */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(
    Object.entries(MEDIA_EXTENSIONS).filter(([, v]) => v === 'image').map(([k]) => k),
);

/** 是否为画廊徽标文件（*.gallery） */
export const isGalleryMarker = (fileName: string): boolean =>
    /\.gallery$/i.test((fileName || '').trim());

/** 画廊徽标文件名取画廊名（去掉 .gallery 后缀） */
export const galleryNameFromMarker = (fileName: string): string =>
    baseNameOf(fileName).replace(/\.gallery$/i, '').trim() || '未命名画廊';

/**
 * 若是“数字命名 + 图片后缀”返回页码（1-based 整数），否则返回 null。
 * 前导零、空格都接受（"001.png"→1）；小数/负数/非数字一律忽略。
 */
export const galleryPageNumber = (fileName: string): number | null => {
    const base = baseNameOf(fileName);
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return null;
    const stem = base.slice(0, dot).trim();
    if (!IMAGE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())) return null;
    if (!/^\d+$/.test(stem)) return null;
    const n = parseInt(stem, 10);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
};

/**
 * 画廊徽标（*.gallery）的**文件夹形态**清单结构。
 *
 * 只声明形状，不在这里生成：徽标正文由主进程 electron/acgmhoService.js 的
 * writeGalleryOutputs 落盘（它才是写文件的那一侧）。这里曾有一个
 * buildGalleryManifest() 生成器，但从未被任何调用方使用、字段集也已与
 * 实际写出的内容漂移，故只保留类型。
 *
 * 注意与 meta/interface.ts 的同名接口不是一回事：那个是**下载归档**的清单
 * （含 records 列表），这个是**单文件夹画廊**的徽标。
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
    for (const file of files) {
        const dir = dirOfFile(file);
        const group = byDir.get(dir);
        if (group) group.push(file);
        else byDir.set(dir, [file]);
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
        const name = galleryNameFromMarker(markers[0].name);
        galleries.push({ groupId: `gallery:${dir}/${name}`, name, dir, pages, marker: markers[0] });
        // 已认定的画廊目录：徽标本身不进播放列表，其余不合规文件（非数字命名/非图片）
        // 按格式约定直接忽略，不散装进 loose
    }

    return { galleries, loose, orphanMarkers };
};

/* ==========================================================================
 * 12. 画廊：单文件 .gallery（ZIP 改后缀）的打包 / 解包
 *
 * 输入目录约定（选择文件夹后）：
 *   <root>/.name   ← 画廊名文件：文件名即 `.name`，内容有且仅有一行字符串 = 画廊名
 *   <root>/1.png   ← 数字命名 + 图片后缀即可（不一定是 png）
 *   <root>/2.jpg   ← 同上，页码 = 数字部分
 * 其它一切文件（子目录、非数字命名、非图片后缀、坏掉的 .name）直接无视。
 *
 * 输出单文件：
 *   <画廊名>.gallery ← ZIP（STORE 不重压图片），包内：`.name` + 原名图片
 * 导入时按魔数 `PK` 识别单文件包；旧式 JSON 徽标（`{"format":...}`）走原逻辑。
 * ========================================================================== */

export const GALLERY_PACK_NAME_FILE = '.name';
export const GALLERY_PACK_MAX_PAGES = 2000;

/** .gallery 输出名（与 sanitizeBookName 同口径） */
export const sanitizePackName = (name: string): string => sanitizeFileName(name, '未命名画廊');

/**
 * .name 内容校验：有且仅有一行非空字符串。
 * 首尾空白/末尾换行容忍（trim 后内部不许再含换行），否则返回 null。
 */
export const parseNameFileContent = (text: string): string | null => {
    const line = String(text ?? '').trim();
    if (!line || /[\r\n]/.test(line)) return null;
    return line;
};

export interface PackImage {
    file: File;
    page: number;
}

export interface CollectedPack {
    /** 所选根目录名（webkitdirectory 第一级；单文件/扁平选择为空） */
    root: string;
    /** 画廊名（.name 内容） */
    name: string;
    /** 按（页码，文件名）排好的图片 */
    images: PackImage[];
    /** 被无视的文件数（统计用，不报错） */
    ignoredFiles: number;
}

/** 按页码升序、同页按文件名排（中文序，与资源管理器所见一致） */
const byPageThenName = (a: PackImage, b: PackImage): number =>
    a.page - b.page || a.file.name.localeCompare(b.file.name, 'zh');

/**
 * 从一批文件（通常是 webkitdirectory 整目录）中按规则收集打包源。
 * 多根目录时取**第一个「.name 合法 + 有数字命名图片」的根**（按根名中文序），
 * 全都不合格则抛错，错误里带上前三个根各自缺什么（调用方转成用户提示）。
 */
export const collectPackSources = async (files: File[]): Promise<CollectedPack> => {
    const list = Array.from(files || []).filter((f) => f && typeof f.name === 'string');
    if (list.length === 0) throw new Error('所选目录为空');

    // 根目录分组：只有“根下直接子文件”（depth<=1）参与规则判定
    const byRoot = new Map<string, { rel: string; file: File }[]>();
    for (const file of list) {
        const rel = relPathOf(file);
        const segs = rel.split('/');
        const depth = segs.length - 1;
        if (depth > 1) continue;
        const root = depth === 1 ? segs[0] : '';
        const group = byRoot.get(root);
        if (group) group.push({ rel, file });
        else byRoot.set(root, [{ rel, file }]);
    }

    const roots = [...byRoot.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
    // 被无视的文件 = 总入选 - 根下直接子文件（子目录深层文件按规则直接无视）
    const inScope = roots.reduce((n, r) => n + (byRoot.get(r)?.length || 0), 0);
    const ignoredFiles = list.length - inScope;

    // 逐根尝试：先找合法 .name，再找图片。
    // 每个根只报**第一条**不满足的规则，顺序即用户看到的提示优先级，不能调换。
    const attempts: string[] = [];
    for (const root of roots) {
        const group = byRoot.get(root)!;
        const label = `「${root || '所选文件'}」`;
        const nameCandidates = group
            .filter((g) => baseNameOf(g.rel) === GALLERY_PACK_NAME_FILE)
            .sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
        if (nameCandidates.length === 0) {
            attempts.push(`${label}：缺少 ${GALLERY_PACK_NAME_FILE} 文件`);
            continue;
        }

        // 同一根下可能有多个 .name（历史残留），取第一个内容合法的
        let name: string | null = null;
        for (const c of nameCandidates) {
            try {
                name = parseNameFileContent(await c.file.text());
            } catch {
                name = null;
            }
            if (name) break;
        }
        if (!name) {
            attempts.push(`${label}：${GALLERY_PACK_NAME_FILE} 内容不合要求（必须有且仅有一行画廊名）`);
            continue;
        }

        const images: PackImage[] = [];
        for (const g of group) {
            const page = galleryPageNumber(baseNameOf(g.rel));
            if (page != null) images.push({ file: g.file, page });
        }
        images.sort(byPageThenName);
        if (images.length === 0) {
            attempts.push(`${label}：没有数字命名的图片（如 1.png、2.jpg）`);
            continue;
        }

        return { root, name, images, ignoredFiles };
    }

    throw new Error(
        attempts.length > 0
            ? `没有符合规则的画廊：${attempts.slice(0, 3).join('；')}`
            : '没有符合规则的文件（需要 .name + 数字命名图片）',
    );
};

/** 打包为单文件 .gallery（ZIP Blob，后缀由调用方定为 .gallery） */
export const packToGalleryBlob = async (name: string, images: PackImage[]): Promise<Blob> => {
    const zip = new JSZip();
    zip.file(GALLERY_PACK_NAME_FILE, name);
    for (const img of images) zip.file(img.file.name, img.file);
    // 图片本身已压缩，STORE 只组包不重压，又快又不掉画质
    return zip.generateAsync({ type: 'blob', compression: 'STORE' });
};

export interface UnpackedGallery {
    name: string;
    pages: PackImage[];
}

/** 前 2 字节是否为 ZIP 魔数 `PK`（含空包/分卷头都放行，后续由 JSZip 校验） */
export const isGalleryPackFile = async (file: File): Promise<boolean> => {
    try {
        const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
        return head.length === 2 && head[0] === 0x50 && head[1] === 0x4b;
    } catch {
        return false;
    }
};

/**
 * 解包单文件 .gallery：包内找 `.name`（画廊名）+ 数字命名图片。
 * 结构不符（旧 JSON 徽标 / 损坏）返回 null，调用方回落原逻辑。
 */
export const unpackGalleryPack = async (file: File): Promise<UnpackedGallery | null> => {
    try {
        if (!(await isGalleryPackFile(file))) return null;
        const zip = await JSZip.loadAsync(file);
        const entries = Object.values(zip.files).filter((e) => !e.dir);
        if (entries.length === 0 || entries.length > GALLERY_PACK_MAX_PAGES + 8) return null;

        let name: string | null = null;
        for (const e of entries) {
            if (baseNameOf(e.name) !== GALLERY_PACK_NAME_FILE) continue;
            try {
                name = parseNameFileContent(await e.async('text'));
            } catch {
                name = null;
            }
            if (name) break;
        }
        if (!name) return null;

        const pages: PackImage[] = [];
        for (const e of entries) {
            if (pages.length >= GALLERY_PACK_MAX_PAGES) break;
            const base = baseNameOf(e.name);
            const page = galleryPageNumber(base);
            if (page == null) continue;
            try {
                const blob = await e.async('blob');
                pages.push({ page, file: new File([blob], base, { type: blob.type || 'application/octet-stream' }) });
            } catch {
                // 单页读坏跳过该页
            }
        }
        if (pages.length === 0) return null;
        pages.sort(byPageThenName);
        return { name, pages };
    } catch {
        return null;
    }
};

/* ==========================================================================
 * 13. Agent 会话导出（Markdown 单文件）
 *
 * 导出的是**完整会话**：助手的推理、工具调用的脚本与返回值都在；
 * 推理可以按需去掉（见 AgentExportOptions.includeReasoning）。
 *
 * 段落顺序刻意与界面逐条对齐（助手气泡是「推理 → 正文」，工具卡片是
 * 「摘要 → 推理 → 脚本 → 返回值」）：两边各写一套顺序时，用户复盘
 * 「它当时为什么这么改」会看到两份不一样的记录，而无从判断该信哪个。
 * ========================================================================== */

/** 补零到两位 */
const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 本地时区时间戳：yyyy-MM-dd HH:mm:ss */
const formatDateTime = (at: number): string => {
    const d = new Date(at);
    const date = [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())].join('-');
    const time = [pad2(d.getHours()), pad2(d.getMinutes()), pad2(d.getSeconds())].join(':');
    return `${date} ${time}`;
};

/** 只有时刻。段落标题用 —— 日期在文件头已经写过一遍了 */
const formatClock = (at: number): string => formatDateTime(at).slice('yyyy-MM-dd '.length);

/** 文件名里不能出现的字符（Windows 最严格，一次列全）；控制字符一并换掉 */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 代码围栏：比正文里最长的一串反引号更长。
 *
 * 固定写 ``` 会在两种情况下把导出件写坏 —— Agent 常写生成 Markdown 的脚本，
 * 脚本本身就含 ```；返回值里带代码片段同理。围栏被提前闭合后，
 * 后面的内容会被整段当成代码或正文错位，而导出件看起来"没报错"。
 */
const fenceFor = (text: string): string => {
    const runs: string[] = text.match(/`+/g) || [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return '`'.repeat(Math.max(3, longest + 1));
};

/** 代码块；lang 传空串即不带语法标记 */
const codeBlock = (text: string, lang: string): string => {
    const fence = fenceFor(text);
    return `${fence}${lang}\n${text.replace(/\s+$/, '')}\n${fence}`;
};

/** 引用块：逐行加 ">"，空行写成 ">"，否则引用会在空行处断成两段 */
const blockquote = (text: string): string =>
    text.replace(/\s+$/, '').split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');

/** 推理：折叠起来。一段推理动辄上万字，平铺会把正文彻底淹没 */
const reasoningBlock = (reasoning: string): string =>
    `<details>\n<summary>推理过程</summary>\n\n${blockquote(reasoning)}\n\n</details>`;

/** 段落标题：角色 + 关键标记 + 时刻 */
const sectionHeading = (message: AgentMessage, index: number): string => {
    const clock = formatClock(message.at);
    if (message.role === 'user') return `${index}. 用户 · ${clock}`;
    // 压缩分界线既不是模型的发言也不是用户的提问。写成「助手」会让读到这份
    // 导出件的人（以及把它喂给别的模型的用户）以为那是模型说过的话
    if (message.compaction) return `${index}. 上下文压缩 · ${clock}`;
    // 界面自己补的提示不是模型说的话，标题里就得区分开
    if (message.role === 'assistant') return `${index}. 助手${message.notice ? '（界面提示）' : ''} · ${clock}`;
    const label = message.label || message.tool || '未知工具';
    return `${index}. 工具 ${label}${message.ok === false ? '（失败）' : ''} · ${clock}`;
};

/** token 数：只在有实测或估算值时写出来，没有就不占位置 */
const usageLine = (usage: AiUsage | undefined): string | null => {
    if (!usage) return null;
    const approx = usage.estimated ? '~' : '';
    return `token：${approx}${usage.promptTokens} 输入 + ${approx}${usage.completionTokens} 输出 = ${approx}${usage.totalTokens}`
        + `${usage.estimated ? '（本地估算）' : '（服务端实测）'}`;
};

/** 压缩记录的一行摘要说明 */
const compactionLine = (compaction: AgentCompaction): string => {
    const dropped = compaction.coveredMessages - compaction.summarizedMessages;
    return `已压缩 ${compaction.coveredMessages} 条（${compaction.beforeTokens} → ${compaction.afterTokens} token）`
        + `${dropped > 0 ? `，其中 ${dropped} 条超出摘要输入上限被直接丢弃` : ''}`
        + `${compaction.overBudget ? '，**压缩后仍超预算**' : ''}`;
};

/** 一条消息的正文块，顺序与界面一致 */
const sectionBody = (message: AgentMessage, includeReasoning: boolean): string[] => {
    const text = message.content.trim();

    // 压缩消息：正文就是摘要本身，另加一行说明它覆盖了什么
    if (message.compaction) return [`> ${compactionLine(message.compaction)}`, text];

    // 不带思考的导出只掐推理这一块：脚本与返回值是「发生了什么」，
    // 推理是「它当时怎么想的」，后者才是分享时要去掉的那部分
    const reasoning = includeReasoning && message.reasoning ? [reasoningBlock(message.reasoning)] : [];

    if (message.role === 'tool') {
        const body: string[] = [];
        if (text) body.push(text);
        body.push(...reasoning);
        if (message.script) body.push(`**脚本**\n\n${codeBlock(message.script, 'js')}`);
        // 返回值即使为空也写出来：界面上这张卡片永远有这一栏，
        // 省略会让「没有返回」和「没有这一步」在导出件里长得一样
        body.push(`**返回值**\n\n${codeBlock(message.result || '(空)', 'text')}`);
        const cost = usageLine(message.usage);
        if (cost) body.push(`> ${cost}`);
        return body;
    }

    const body: string[] = [...reasoning];
    if (text) body.push(message.notice ? blockquote(text) : text);
    const cost = usageLine(message.usage);
    if (cost) body.push(`> ${cost}`);
    return body;
};

/** 一条消息 → 一个 Markdown 段落；块之间留空行 */
const messageSection = (message: AgentMessage, index: number, includeReasoning: boolean): string =>
    [`## ${sectionHeading(message, index)}`, ...sectionBody(message, includeReasoning)].join('\n\n');

/** 会话标题：第一条用户提问压成一行，用作文件名（标题里换行会让文件名带上控制字符） */
const sessionTitle = (messages: AgentMessage[]): string => {
    const first = messages.find((message) => message.role === 'user' && message.content.trim());
    return first ? first.content.replace(/\s+/g, ' ').trim().slice(0, 24) : '未命名会话';
};

/** 导出选项。默认导出完整会话（含推理），关掉推理是为了直接分享 */
export interface AgentExportOptions {
    /**
     * 是否写入推理过程，默认 true。
     *
     * 关掉后文件里连 `<details>` 都不出现，但**文件头会注明"不含推理"** ——
     * 否则读到一份没有推理的记录，人只会以为模型当时没思考。
     */
    includeReasoning?: boolean;
    /**
     * 文件名与文件头共用的时间戳，默认取当前时刻。
     *
     * 必须是同一个时刻：分两次取的话，文件名的时间与文件头写的对不上，
     * 导两份还会出现同名覆盖。
     */
    at?: number;
}

/** 取一次选项，把缺省值补齐（两个 builder 与导出动作对缺省的理解必须一致） */
const resolveExportOptions = (options: AgentExportOptions): Required<AgentExportOptions> => ({
    includeReasoning: options.includeReasoning !== false,
    at: options.at ?? Date.now(),
});

/**
 * 导出文件名：Agent对话_<标题>_<带思考|不带思考>_<yyyyMMddHHmmss>.md
 *
 * 标记带不带思考是刻意的：两种导出常会被连着一起来一遍，
 * 只靠文件名分不出哪份含推理，事后只能逐个打开翻。
 *
 * 带时间戳同理：落盘路径由下载目录决定、同名自动编号，
 * 不留时间的话一串「Agent对话_xxx (1).md」谁也认不出哪份是新的。
 */
export const buildAgentSessionFileName = (messages: AgentMessage[], options: AgentExportOptions = {}): string => {
    const { includeReasoning, at } = resolveExportOptions(options);
    const stamp = formatDateTime(at).replace(/[-: ]/g, '');
    const title = sessionTitle(messages).replace(UNSAFE_FILENAME_CHARS, '_');
    return `Agent对话_${title}_${includeReasoning ? '带思考' : '不带思考'}_${stamp}.md`;
};

/** 会话 → Markdown 单文件（推理、脚本、返回值按选项收录） */
export const buildAgentSessionMarkdown = (messages: AgentMessage[], options: AgentExportOptions = {}): string => {
    const { includeReasoning, at } = resolveExportOptions(options);
    const header = [
        `导出时间：${formatDateTime(at)}`,
        `共 ${messages.length} 条记录`,
        includeReasoning ? '含推理过程' : '不含推理过程',
    ].join(' · ');
    const sections = messages.map((message, index) => messageSection(message, index + 1, includeReasoning));
    return `${['# Agent 会话导出', `> ${header}`, ...sections].join('\n\n')}\n`;
};

/**
 * 导出会话：组内容 + 触发下载。
 *
 * Blob 的 type 带上 charset：Electron 落盘后系统据此选默认打开方式与编码。
 */
export const exportAgentSession = (messages: AgentMessage[], options: AgentExportOptions = {}): void => {
    // 时间戳只在这里取一次：文件名与文件头必须是同一个时刻
    const resolved = resolveExportOptions(options);
    const blob = new Blob([buildAgentSessionMarkdown(messages, resolved)], {
        type: 'text/markdown;charset=utf-8',
    });
    downloadBlob(blob, buildAgentSessionFileName(messages, resolved));
};
