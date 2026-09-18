import { VideoFile, MediaType, GalleryProbeResult } from './meta';

/* -------------------------------------------------------------------------- */
/*                                常量定义                                     */
/* -------------------------------------------------------------------------- */

export const STORAGE_KEYS = {
    VOLUME: 'react-player-volume',
    MODE: 'react-player-mode',
    RATE: 'react-player-rate',
    FIT: 'react-player-fit'
};

// 恢复播放进度的阈值（百分比），太开头或太结尾通常不需要恢复
export const RESUME_THRESHOLD = { MIN: 0.05, MAX: 0.95 };

// 统一的后缀定义，与 useSniff 保持一致，但这里作为播放器的核心判断逻辑
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

    // Document / Markdown / Text
    'md': 'document',
    'markdown': 'document',
    'txt': 'document',
    'log': 'document',
    'pdf': 'document',
    'json': 'document',

    // Custom AI Book
    'aibook': 'image', // 实际上是一个集合，但作为文件导入时，它的内容主要是图片

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
        return { kind: 'video', streams: [{ url: probe.videoUrl, name: title, title }], totalPages, status: null };
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
 */
export const revokeVideoFile = (videoFile: VideoFile) => {
    if (videoFile.type === 'file' && videoFile.url) {
        URL.revokeObjectURL(videoFile.url);
    }
};

/**
 * 将 Blob URL 转换为 Base64 字符串
 */
export const blobUrlToBase64 = async (blobUrl: string): Promise<string> => {
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            resolve(reader.result as string);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

/**
 * 将 Base64 转换为 Blob URL
 * 非法输入直接抛错，避免 atob 崩溃产生难以定位的异常
 */
export const base64ToBlobUrl = (base64: string): string => {
    if (typeof base64 !== 'string' || !base64.includes(',')) {
        throw new Error('非法的 Base64 数据：缺少 data:...;base64, 前缀');
    }
    const arr = base64.split(',');
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const b64body = arr[1];
    if (!/^[A-Za-z0-9+/=]*$/.test(b64body.replace(/\s/g, ''))) {
        throw new Error('非法的 Base64 数据：正文含非法字符');
    }
    const bstr = atob(b64body);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    const blob = new Blob([u8arr], { type: mime });
    return URL.createObjectURL(blob);
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

/** 画廊清单文件内容（写入 *.gallery 徽标的数据结构） */
export interface GalleryManifest {
    format: 'the-play-gallery/1';
    title: string;
    gid?: string;
    artist?: string;
    sourceUrl?: string;
    totalPages: number;
    createdAt: string;
}

/** 生成 *.gallery 徽标文件正文 */
export const buildGalleryManifest = (init: Omit<GalleryManifest, 'format' | 'createdAt'>): string =>
    JSON.stringify(
        {
            format: 'the-play-gallery/1',
            createdAt: new Date().toISOString(),
            ...init,
        } as GalleryManifest,
        null,
        2
    );

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