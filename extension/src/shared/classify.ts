/**
 * 嗅探分类（纯函数，不碰任何 chrome.* API）。
 *
 * ## 为什么单独一层
 *
 * 分类逻辑如果和 webRequest 接线写在一起，就只能靠"打开浏览器点一下"来验证，
 * 而分类恰恰是最容易错、也最值得回归的部分（`.ts` 分片、query 里藏后缀、
 * content-type 与后缀互相矛盾）。拆出来之后它能在 Node 里直接跑断言。
 *
 * ## 后缀表是**派生**的，不是抄的
 *
 * 应用侧的 `electron/main.js` 里那张表是**手抄副本**（主进程不能 import TS），
 * 由 `test/sniffer.test.js` 盯着不漂移。插件没有这个限制 —— 它和应用共用
 * 同一个 `const.ts`，所以这里直接从 `MEDIA_EXTENSIONS` 派生。
 *
 * 这不只是省事：手抄副本的历史事故是 `.avif` 只进了其中一份，同一个文件
 * 走两条路径结论不同。派生之后"新增后缀要改几处"这个问题从根上消失了。
 */
import { HLS_SEGMENT_RE_SOURCE, MEDIA_EXTENSIONS, isAcgUrl } from '../../../const';
import type { MediaType } from '../../../meta';

/**
 * 表里有、但**不进嗅探列表**的后缀。
 *
 * `.aibook` 在 `MEDIA_EXTENSIONS` 里属 image（导入时没被识别成绘本的兜底展示），
 * 但它是本应用的归档格式，不是网页上的媒体资源。与 `hooks/useBrowse.ts` 的
 * `SNIFF_EXCLUDED_EXTS` 同口径。
 */
const SNIFF_EXCLUDED_EXTS = new Set(['aibook']);

/** 按类型取出后缀清单（顺序无关紧要，判据是"成词匹配"不是"谁先命中"） */
const extsOfType = (type: MediaType): string[] =>
    Object.entries(MEDIA_EXTENSIONS)
        .filter(([ext, t]) => t === type && !SNIFF_EXCLUDED_EXTS.has(ext))
        .map(([ext]) => ext);

export const STREAM_EXTS = extsOfType('stream');
export const VIDEO_EXTS = extsOfType('video');
export const AUDIO_EXTS = extsOfType('audio');
export const IMAGE_EXTS = extsOfType('image');

/**
 * MIME 子类型 → 规范后缀。
 *
 * 存在的理由是 content-type 里的子类型常常**不是**后缀：
 *   video/x-matroska  → mkv（子类型是 x-matroska）
 *   audio/x-mpeg      → mp3（子类型是 x-mpeg）
 *   audio/mp4         → m4a（子类型是 mp4）
 * 照搬子类型会让文件名变成 `片子.matroska`，而应用的类型判定按
 * `MEDIA_EXTENSIONS` 查表，全部落空。
 *
 * 两张表而不是一张：`ogg` 在主类型下含义不同 —— video/ogg 是 `.ogv`、
 * audio/ogg 是 `.ogg`。合成一张必然把其中一个映射错。
 *
 * ⚠️ 这是 `electron/main.js` 同名表的**第二份**。迁移期由
 * `test/extsniffer.test.js` 逐条比对两边，避免"插件判 mkv、应用判 matroska"。
 * 主进程那份随自建浏览器外壳一起删除后，这里就是唯一一份。
 */
export const VIDEO_MIME_EXTS: Record<string, string> = {
    'mp4': 'mp4', 'mpeg': 'mpg', 'mpg': 'mpg',
    'x-matroska': 'mkv', 'matroska': 'mkv',
    'quicktime': 'mov', 'x-msvideo': 'avi', 'avi': 'avi',
    'webm': 'webm', 'ogg': 'ogv', 'x-ms-wmv': 'wmv', '3gpp': '3gp',
};

export const AUDIO_MIME_EXTS: Record<string, string> = {
    'x-mpeg': 'mp3', 'mpeg': 'mp3', 'mp3': 'mp3', 'mpeg3': 'mp3',
    'wav': 'wav', 'x-wav': 'wav', 'wave': 'wav',
    'aac': 'aac', 'x-aac': 'aac', 'mp4': 'm4a', 'm4a': 'm4a',
    'flac': 'flac', 'x-flac': 'flac', 'opus': 'opus',
    'x-ms-wma': 'wma', 'x-ms-asf': 'wma', 'ogg': 'ogg',
};

/** content-type → 规范后缀；表里没有的（含 `video/mp4` 这种子类型恰好等于后缀的）回落 */
export const canonicalExtFromMime = (contentType: string, fallback: string): string => {
    const sub = String(contentType).split('/')[1]?.split(';')[0]?.trim() || '';
    const table = String(contentType).startsWith('audio/') ? AUDIO_MIME_EXTS : VIDEO_MIME_EXTS;
    return table[sub] || fallback;
};

/**
 * 这些 content-type 直接丢弃。
 *
 * 网页自身的 HTML/CSS/JS/JSON 会命中"后缀或 MIME 像媒体"的边角判据，
 * 不在这里拦掉就会往列表里灌一堆页面资源。
 */
export const isIgnorableContentType = (contentType: string): boolean => {
    const ct = contentType.toLowerCase();
    return ct.includes('text/html')
        || ct.includes('text/css')
        || ct.includes('javascript')
        || ct.includes('application/json');
};

/**
 * 这些协议不嗅探。
 *
 * `file:` 必须排除：嗅探的目的是发现**远端**媒体以下载，本地文件进列表零作用；
 * 且 ACG 落盘页正是 `file://`（hostname 为空，走不进域名排除），
 * 否则保存完成后轮播每翻一页就往列表里推一条。
 */
export const isSniffableProtocol = (url: string): boolean => {
    if (!url) return false;
    return !(
        url.startsWith('chrome-extension:')
        || url.startsWith('devtools:')
        || url.startsWith('blob:')
        || url.startsWith('data:')
        || url.startsWith('file:')
    );
};

/**
 * 从查询参数值里认出媒体后缀（`?file=movie.mp4`、`?url=a%2Fb.m3u8`）。
 *
 * 后缀必须**成词**，不能用裸 includes：`component.tsx` 里含 `.ts`、
 * `backup.mpd2` 里含 `.mpd` —— 那是源码与备份文件，不是流媒体。
 * 裸 includes 会把它们推成 stream，界面据此打上「ffmpeg 下载」徽章，
 * 用户点了才发现下回来一个文本文件。
 * 成词判据是"后缀后面不能再跟字母数字"（`?`、`&`、`#`、`/` 都算边界）。
 *
 * 返回命中的**真实后缀**而不是写死的 m3u8/mp4：`?file=movie.mpd` 的后缀
 * 是 mpd，写死 m3u8 会让徽章、下载命名与 ffmpeg 判定三处都用错后缀。
 */
export const matchExtInValue = (value: string, exts: string[]): string => {
    const lower = String(value).toLowerCase();
    for (const e of exts) {
        if (new RegExp(`\\.${e}(?![a-z0-9])`).test(lower)) return e;
    }
    return '';
};

/** 取 URL 的 pathname（小写）；解析失败时退化成字符串切分 */
export const pathnameOf = (url: string): string => {
    try {
        return new URL(url).pathname.toLowerCase();
    } catch {
        return url.split('?')[0].split('#')[0].toLowerCase();
    }
};

/** 路径末尾的后缀（无则空串） */
export const pathExtOf = (pathname: string): string => {
    const m = pathname.match(/\.([a-zA-Z0-9]+)$/);
    return m ? m[1] : '';
};

/**
 * 是不是 HLS 分片。
 *
 * 判据只对 `.ts` 有意义（见 `const.ts` 的 `HLS_SEGMENT_RE_SOURCE` 注释），
 * 所以调用方必须先确认后缀/类型是 ts 一类，不能拿它当通用"像不像分片"用。
 *
 * 播放列表本身要留下（它是"可下载的流"的入口），只丢分片。
 */
export const isHlsSegment = (url: string, pathname: string): boolean => {
    if (url.includes('playlist')) return false;
    return new RegExp(HLS_SEGMENT_RE_SOURCE, 'i').test(pathname);
};

/** 分类结果 */
export interface ClassifiedMedia {
    type: MediaType;
    ext: string;
}

export interface ClassifyInput {
    url: string;
    /** 响应头里的 content-type（大小写不敏感，可带参数） */
    contentType: string;
    /** 页面上发起该请求的文档地址，用于 ACG 排除 */
    documentUrl?: string;
}

/**
 * 判定一条响应是不是可下载的媒体。不是则返回 null。
 *
 * 三级判据，与 `electron/main.js` 的嗅探回调同序：
 *   1. content-type（最可信，服务器直接说了是什么）
 *   2. URL 路径后缀
 *   3. 查询参数里藏着的后缀
 *
 * 顺序不能颠倒：`/video?id=1` 这类地址没有后缀，但 content-type 是 video/mp4；
 * 反过来 `x.mp4` 被标成 `application/octet-stream` 时又要靠后缀救回来。
 */
export const classifyResponse = (input: ClassifyInput): ClassifiedMedia | null => {
    const { url, contentType, documentUrl } = input;
    if (!url || !isSniffableProtocol(url)) return null;
    if (isIgnorableContentType(contentType)) return null;

    // ACG 资源不进嗅探：图集封面/动画/有声走画廊流程，
    // 否则翻一本漫画就刷几十条封面进嗅探列表。
    if (isAcgUrl(url) || isAcgUrl(documentUrl)) return null;

    const ct = contentType.toLowerCase();
    let type: MediaType | null = null;
    let ext = '';

    /* 1. content-type */
    if (ct.includes('mpegurl') || ct.includes('dash+xml') || ct.includes('vnd.ms-sstr')) {
        type = 'stream';
        ext = ct.includes('dash') ? 'mpd' : 'm3u8';
    } else if (ct.startsWith('video/')) {
        if (ct.includes('x-flv')) {
            type = 'stream';
            ext = 'flv';
        } else if (ct.includes('mp2t')) {
            // MPEG-TS 必须与 const.ts 同口径判成 stream、后缀归一为 'ts'：
            // 表里 'ts' 属 stream，照搬 content-type 的字面量 'mp2t' 判成 video
            // 会让同一个地址两条路径两个结论 —— 筛选栏归错类，
            // 界面按 type 判 ffmpeg 徽章而下载侧按 ext 判方式。
            type = 'stream';
            ext = 'ts';
        } else {
            type = 'video';
            ext = canonicalExtFromMime(ct, 'mp4');
        }
    } else if (ct.startsWith('audio/')) {
        type = 'audio';
        ext = canonicalExtFromMime(ct, 'mp3');
    } else if (ct.startsWith('image/')) {
        let imgExt = ct.split('/')[1]?.split(';')[0] || '';
        if (imgExt === 'svg+xml') imgExt = 'svg';
        if (IMAGE_EXTS.includes(imgExt)) {
            type = 'image';
            ext = imgExt;
        }
    }

    /* 2. 路径后缀 */
    const pathname = pathnameOf(url);
    const pathExt = pathExtOf(pathname);

    if (!type) {
        if (STREAM_EXTS.includes(pathExt)) { type = 'stream'; ext = pathExt; }
        else if (VIDEO_EXTS.includes(pathExt)) { type = 'video'; ext = pathExt; }
        else if (AUDIO_EXTS.includes(pathExt)) { type = 'audio'; ext = pathExt; }
        else if (IMAGE_EXTS.includes(pathExt)) { type = 'image'; ext = pathExt; }
    }

    /* 3. 查询参数里藏的后缀 */
    if (!type) {
        let searchParams: URLSearchParams | null = null;
        try {
            searchParams = new URL(url).searchParams;
        } catch {
            searchParams = null;
        }
        if (searchParams) {
            for (const [, val] of searchParams.entries()) {
                const hitStream = matchExtInValue(val, STREAM_EXTS);
                if (hitStream) { type = 'stream'; ext = hitStream; break; }
                const hitVideo = matchExtInValue(val, VIDEO_EXTS);
                if (hitVideo) { type = 'video'; ext = hitVideo; break; }
                const hitAudio = matchExtInValue(val, AUDIO_EXTS);
                if (hitAudio) { type = 'audio'; ext = hitAudio; break; }
            }
        }
    }

    if (!type) return null;

    /*
     * TS 分片过滤。
     *
     * 三条门都要开，缺一条就会漏：
     *   · ext === 'ts'：content-type 是 video/mp2t，步骤 1 归一成 ts；
     *   · pathExt === 'ts'：部分 CDN 把分片标成 application/octet-stream，
     *     既不进 mpegurl 分支也不进 video/ 分支，只靠前两条会让整页
     *     segNNN.ts 全被推上来；
     *   · ct 含 mp2t：兜住上面两种都没覆盖的。
     *
     * 但最终判据仍然交给路径正则（它只认分片命名）—— 不写成"任何 .ts 都算
     * 分片"，整段的 .ts 视频同样可下载，不该被丢。
     */
    if (ext === 'ts' || pathExt === 'ts' || ct.includes('mp2t')) {
        if (isHlsSegment(url, pathname)) return null;
    }

    return { type, ext: ext || 'unknown' };
};

/**
 * 从 URL 与 content-disposition 推一个显示标题。
 *
 * 长度上限 80 与主进程一致：超长文件名在列表里会把类型徽章挤掉。
 */
export const deriveTitle = (url: string, contentDisposition: string, ext: string): string => {
    let filename = '';

    const m = contentDisposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (m && m[1]) filename = m[1];

    if (!filename) {
        try {
            const parts = new URL(url).pathname.split('/').filter(Boolean);
            filename = parts.pop() || '';
        } catch {
            filename = '';
        }
    }

    if (!filename || filename.length > 80) return `Media_${ext || 'stream'}`;

    try {
        return decodeURIComponent(filename);
    } catch {
        return filename;
    }
};
