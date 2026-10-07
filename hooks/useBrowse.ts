import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    BookmarkNode,
    BookmarkTree,
    BookmarkBarVisibility,
    BrowserCommand,
    BrowserDownload,
    BrowserDownloadAction,
    CookieItem,
    DownloadCapabilities,
    DownloadMediaResult,
    FoundLink,
    HeaderRule,
    MediaDownloadProgress,
    MediaType,
    TamperRule,
    WebviewElement,
    getElectronAPI,
} from '../meta';
import { extractMediaLinks } from '../services/AiService';
import {
    classifyNavigationError,
    shouldShowNavigationError,
    nextZoomLevel,
    resolveInputUrl,
    zoomLevelToFactor,
    zoomFactorToLevel,
    ZOOM_MIN_LEVEL,
    ZOOM_MAX_LEVEL,
    type NavigationError,
} from '../services/BrowserService';
export type { MergeStats } from '../services/BookmarkService';
export type { BookmarkBarVisibility } from '../meta';
import {
    collectUrls,
    findNode,
    flattenUrls,
    insertNode,
    makeDefaultTree,
    makeFolder,
    makeUrlNode,
    mergeIntoFolder,
    migrateFlatBookmarks,
    moveNode,
    normalizeTree,
    removeNode,
    replaceNode,
    type MergeStats,
} from '../services/BookmarkService';
import { loadJSON, loadStr, saveJSON, saveStr } from '../utils/persist';
import { MEDIA_EXTENSIONS, generateId, isAcgUrl, isGenericTitle, isHlsSegmentPath, isLinkFromPage, isRealUrl, requiresFfmpeg, HLS_SEGMENT_RE_SOURCE } from '../utils/utils';

/**
 * webview 方法是否可用。
 *
 * vite 开发服（localhost:5173）里 `<webview>` 只是未知 HTML 标签，
 * Electron 才给它装上 stop/reload/findInPage 这些方法。直接调用会抛
 * `TypeError: webview.stop is not a function`，被各处的 try/catch 接住后
 * 以 console.error 刷进运行日志 —— 看起来像"报错 2 条"，实际只是环境差异。
 * 调用前先判 typeof：方法不存在时静默跳过（非 Electron 下本就做不了这件事），
 * 只有方法存在但执行抛错时才记日志。
 */
const hasWebviewFn = (webview: unknown, name: string): boolean => {
    try {
        const el = webview as Record<string, unknown>;
        return !!el && typeof el[name] === 'function';
    } catch {
        return false;
    }
};

/**
 * ============================================================================
 * useBrowse — 内置浏览器（标签页 / 书签 / 地址栏 / 资源嗅探）
 * ============================================================================
 *
 * 原先拆在 hooks/useBrowse/ 下的五个文件（useTabs、useBookmarks、useSearch、
 * useInteractions、useSniff）合并到这里。它们共享同一份会话状态，
 * 拆开只会让"谁持有真值"变得含糊：useInteractions 需要 tabs+search+bookmarks，
 * useSniff 又需要 interactions 的 webview 访问器，链式注入跨了三个文件。
 *
 * 现在子模块仍是独立的 hook（各自的 state 与 effect 边界不变），
 * 但降为模块私有：外部只能通过 useBrowse() 拿到聚合结果，
 * 无法绕过协调器单独实例化一份"影子标签页"。
 *
 * 对外只导出 useBrowse 与状态类型（Tab / TabsState / ...），
 * 组件按 `TabsState['actions']` 取自己需要的那部分。
 *
 * 例外：两个**纯判据**函数是导出的（pickStoredTabs、shouldAddressBarFollow）。
 * 它们原本内联在 hook 里、读 localStorage 或闭包状态，无法单测；
 * 抽成纯函数后由 test/ 直接求值断言。它们不持有任何状态，
 * 导出不会让外部绕过协调器拿到"影子标签页"。
 */

/* -------------------------------------------------------------------------- */
/*                                  常量                                      */
/* -------------------------------------------------------------------------- */

/**
 * 嗅探不认的后缀。
 * `aibook` 在 MEDIA_EXTENSIONS 里被归为 image（未被识别成绘本时的兜底展示），
 * 但它是本地归档文件而非可下载的图片资源，进嗅探列表纯属噪声。
 */
const SNIFF_EXCLUDED_EXTS = new Set(['aibook']);

/**
 * 按媒体类型归并的后缀表。
 * 唯一真值来自 utils.MEDIA_EXTENSIONS —— 播放器的类型判定与嗅探的扫描清单
 * 必须一致，各写一份必然会漂移（合并前此处、页内脚本、utils 共三份）。
 *
 * 页内脚本的 streamExts 也直接用这一份（含 `ts`），不再单独排除：
 * 排除是因为旧逻辑"先定类型再判分片"，`.ts` 会在分片判定前就被标成 stream；
 * 现在的顺序是「定类型 → 丢分片 → 按标签兜底」，分片照样被丢，
 * 整段 .ts 视频却能正确归为 stream，与 utils 完全同源。
 */
const CATEGORIES: Record<MediaType, string[]> = (() => {
    const map: Record<MediaType, string[]> = {
        stream: [], video: [], audio: [], image: [], document: [], gallery: [], other: [],
    };
    for (const [ext, type] of Object.entries(MEDIA_EXTENSIONS)) {
        if (!SNIFF_EXCLUDED_EXTS.has(ext)) map[type].push(ext);
    }
    return map;
})();

/**
 * 筛选栏的可选项，**唯一真值**。
 *
 * 筛选栏（Floating 的 SNIFF_FILTERS）与落盘校验（filterType 的初值）
 * 原先各写一份，两份必然漂移：落盘校验放行 CATEGORIES 的**全部键**，
 * 而界面只有下面这几项 —— 于是手改 localStorage 成 'gallery' 能通过校验，
 * 界面上却没有那个按钮，表现为"列表空了却看不出为什么"。
 * 现在两处都读这一份。
 *
 * 清单内容与原界面完全一致（5 项），**没有**擅自增减类型：
 * document 要不要进筛选栏是一个待定的产品决定，见下方注释，不在本次修复范围内。
 */
export const SNIFF_FILTER_OPTIONS: { value: MediaType | 'all'; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'stream', label: '流媒体 (HLS)' },
    { value: 'video', label: '视频 (MP4)' },
    { value: 'audio', label: '音频' },
    { value: 'image', label: '图片' },
];

const TABS_STORE_KEY = 'browse-tabs';
const TABS_STORE_MAX = 20;
/**
 * 「最近关闭」栈深度。取 10 与 Chrome 一致：
 * 再深用户也不会去数，而每一项都只是一个 { url, title } 小对象。
 */
const CLOSED_STACK_MAX = 10;
const BOOKMARKS_STORE_KEY = 'react-player-bookmarks';
/**
 * v2 起书签是**树**（带文件夹），与 v1 的扁平数组不兼容。
 * 换键而不是原地改结构：旧键留着，用户若回退版本还能读回自己的书签。
 */
const BOOKMARK_TREE_STORE_KEY = 'react-player-bookmark-tree';
const BOOKMARK_BAR_STORE_KEY = 'react-player-bookmark-bar';
const BOOKMARKS_MAX = 500;
const LINKS_STORE_KEY = 'sniff-links';
const LINKS_STORE_MAX = 300;

const DEFAULT_CAPABILITIES: DownloadCapabilities = {
    ffmpegAvailable: false,
    ffmpegMessage: '正在检测 ffmpeg 下载能力...',
};

/* -------------------------------------------------------------------------- */
/*                                地址栏解析                                    */
/* -------------------------------------------------------------------------- */

export type SearchEngine = 'google' | 'bing' | 'duckduckgo';

/**
 * 引擎清单是**唯一真值**：地址栏的选择器与落盘校验都读它。
 *
 * 选择器曾经不存在，于是 `setEngine` 没有任何调用方、`engine` 永远钉死在 bing，
 * `search-engine` 这个存储键也就永远读不出别的值。现在界面接上了，
 * 但 id 与显示名不能再各写一份 —— 加引擎时漏改一处，选择器就会少一项。
 */
export const SEARCH_ENGINE_OPTIONS: { id: SearchEngine; label: string }[] = [
    { id: 'google', label: 'Google' },
    { id: 'bing', label: 'Bing' },
    { id: 'duckduckgo', label: 'DuckDuckGo' },
];

const DEFAULT_ENGINE: SearchEngine = 'bing';
const SEARCH_ENGINES: SearchEngine[] = SEARCH_ENGINE_OPTIONS.map((option) => option.id);

const ENGINE_URLS: Record<SearchEngine, string> = {
    google: 'https://www.google.com/search?q=',
    bing: 'https://www.bing.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
};

const SEARCH_ENGINE_STORE_KEY = 'search-engine';

/**
 * 地址判据（isUrlLike / isAddressLike / resolveInputUrl）住在
 * services/BrowserService：纯函数放 hook 里进不了单测。
 * 这里只 re-export 给面板（它从 '../hooks' 拿 isAddressLike），
 * 实现只有服务层那一份。
 */
export { isAddressLike } from '../services/BrowserService';

/* -------------------------------------------------------------------------- */
/*                              页内嗅探脚本                                    */
/* -------------------------------------------------------------------------- */

const IN_PAGE_INSPECTOR_SCRIPT = `
(() => {
  const results = [];
  const seen = new Set();
  const pageTitle = (document.title || '').trim();
  const pageUrl = window.location.href;

  const streamExts = ${JSON.stringify(CATEGORIES.stream)};
  const videoExts = ${JSON.stringify(CATEGORIES.video)};
  const audioExts = ${JSON.stringify(CATEGORIES.audio)};
  const imageExts = ${JSON.stringify(CATEGORIES.image)};
  const hlsSegmentRe = new RegExp(${JSON.stringify(HLS_SEGMENT_RE_SOURCE)}, 'i');

  const getMediaInfo = (rawUrl, defaultType) => {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let url = rawUrl.trim();
    if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('javascript:')) return null;
    try {
      url = new URL(url, window.location.href).href;
    } catch (_e) {
      return null;
    }
    if (seen.has(url)) return null;

    let pathname = '';
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch (_e) {
      pathname = url.split('?')[0].toLowerCase();
    }

    const extMatch = pathname.match(/\\.([a-zA-Z0-9]+)$/);
    let ext = extMatch ? extMatch[1] : '';

    /**
     * 在整条 URL 上按后缀找类型（路径没有后缀时的兜底，如 ?file=movie.mp4）。
     *
     * 判据必须**成词**：末尾的负向前瞻保证后缀后面不再跟字母数字。
     * 早先用的是裸 includes —— component.tsx 里含 .ts、backup.mpd2 里含 .mpd，
     * 源码文件与备份文件都被当成流媒体收进列表，点下载才发现下回来一个文本。
     */
    const extInUrl = (list) => {
      const lower = url.toLowerCase();
      for (let i = 0; i < list.length; i++) {
        if (new RegExp('\\\\.' + list[i] + '(?![a-z0-9])').test(lower)) return list[i];
      }
      return '';
    };

    let type = 'other';
    if (streamExts.includes(ext)) type = 'stream';
    else if (videoExts.includes(ext)) type = 'video';
    else if (audioExts.includes(ext)) type = 'audio';
    else if (imageExts.includes(ext)) type = 'image';

    // 路径认不出时再看整条 URL。ext 与 type 必须一起定：
    // 只改 type 会让条目变成"type=audio 但 ext=jpg"这种自相矛盾的组合
    if (type === 'other') {
      const hitStream = extInUrl(streamExts);
      const hitVideo = hitStream ? '' : extInUrl(videoExts);
      const hitAudio = hitStream || hitVideo ? '' : extInUrl(audioExts);
      if (hitStream) { type = 'stream'; ext = hitStream; }
      else if (hitVideo) { type = 'video'; ext = hitVideo; }
      else if (hitAudio) { type = 'audio'; ext = hitAudio; }
    }

    // 元素自身的标签是最后一层依据：<video>/<audio> 认得出的东西，
    // 路径与 URL 都认不出时按标签归类（HLS 的 blob 型 src 常走到这里）
    if (type === 'other' && defaultType) type = defaultType;

    // 智能兜底扩展名
    if (!ext) {
      if (type === 'video') ext = 'mp4';
      else if (type === 'audio') ext = 'mp3';
      else if (type === 'stream') ext = 'm3u8';
      else if (type === 'image') ext = 'jpg';
    }

    // 过滤 TS 切片分段。
    // 判据源码来自 utils.HLS_SEGMENT_RE_SOURCE（与文本兜底、主进程同一份语义），
    // 这里 new RegExp 是因为脚本整体是模板字符串，没法 import 正则对象。
    if (ext === 'ts') {
      if (hlsSegmentRe.test(pathname) && !url.includes('playlist')) return null;
    }

    if (type === 'other') return null;

    seen.add(url);
    const filename = pathname.split('/').filter(Boolean).pop() || '';
    const title = pageTitle ? pageTitle : (filename || '媒体资源');

    return {
      url,
      title,
      type,
      ext: ext || 'unknown',
      source: 'local',
      pageUrl,
      referer: pageUrl,
    };
  };

  // 1. 扫描所有的 <video>, <audio> 及其 <source> 子元素
  document.querySelectorAll('video, audio').forEach((mediaEl) => {
    const isAudio = mediaEl.tagName.toLowerCase() === 'audio';
    const defaultType = isAudio ? 'audio' : 'video';

    if (mediaEl.currentSrc) {
      const item = getMediaInfo(mediaEl.currentSrc, defaultType);
      if (item) results.push(item);
    }
    if (mediaEl.src) {
      const item = getMediaInfo(mediaEl.src, defaultType);
      if (item) results.push(item);
    }

    mediaEl.querySelectorAll('source').forEach((sourceEl) => {
      if (sourceEl.src) {
        const item = getMediaInfo(sourceEl.src, defaultType);
        if (item) results.push(item);
      }
    });
  });

  // 2. 扫描 Performance API (包含页面所有流媒体网络请求)
  try {
    const perfEntries = window.performance?.getEntriesByType?.('resource') || [];
    for (let i = perfEntries.length - 1; i >= 0 && results.length < 80; i--) {
      const entry = perfEntries[i];
      let perfType = undefined;
      if (entry.initiatorType === 'video') perfType = 'video';
      else if (entry.initiatorType === 'audio') perfType = 'audio';
      const item = getMediaInfo(entry.name, perfType);
      if (item) results.push(item);
    }
  } catch (_e) {}

  // 3. 扫描常见的网页播放器全局对象 (如 Bilibili __playinfo__, DPlayer, HLS 等)
  try {
    if (window.__playinfo__ && window.__playinfo__.data) {
      const data = window.__playinfo__.data;
      if (data.dash) {
        if (Array.isArray(data.dash.video)) {
          data.dash.video.forEach((v, idx) => {
            const item = getMediaInfo(v.baseUrl || v.base_url, 'video');
            if (item) {
              item.title = (pageTitle || 'Bilibili 视频') + ' - 视频轨 ' + (idx + 1);
              results.push(item);
            }
          });
        }
        if (Array.isArray(data.dash.audio)) {
          data.dash.audio.forEach((a, idx) => {
            const item = getMediaInfo(a.baseUrl || a.base_url, 'audio');
            if (item) {
              item.title = (pageTitle || 'Bilibili 音频') + ' - 音频轨 ' + (idx + 1);
              results.push(item);
            }
          });
        }
      }
      if (Array.isArray(data.durl)) {
        data.durl.forEach(d => {
          const item = getMediaInfo(d.url, 'video');
          if (item) results.push(item);
        });
      }
    }
  } catch (_e) {}

  // 4. 扫描 iframe src (很多嵌入播放器位于 iframe)
  document.querySelectorAll('iframe').forEach(iframe => {
    if (iframe.src) {
      const item = getMediaInfo(iframe.src);
      if (item) results.push(item);
    }
  });

  return {
    pageTitle,
    pageUrl,
    links: results
  };
})()
`;

/* -------------------------------------------------------------------------- */
/*                              页内篡改脚本                                    */
/* -------------------------------------------------------------------------- */

/**
 * 注入到页面的核心 Hook 脚本 (Ultimate Edition v3.1)
 *
 * 包含：JSON.parse Hook、Response.json Hook、XHR Hook（含 responseType='json'）、
 *       Fetch Hook、LocalStorage / SessionStorage Hook
 *
 * 与 IN_PAGE_INSPECTOR_SCRIPT 的区别：那个是一次性的只读取数，这个装的是常驻钩子。
 *
 * 五条硬约束，改这个脚本时必须守住：
 *  1. 幂等。脚本会被反复注入（每次导航、每次改规则各一次）。
 *     window.__interceptorInstalled 只在**全部钩子装完之后**才置位 ——
 *     提前置位会让一次中途失败变成永久失效（再注入也走"已装"分支直接返回）。
 *  2. 不抛给页面。每一节各自 try/catch。localStorage 在第三方 iframe 里读取会抛
 *     SecurityError，让它冒出去的话后面所有钩子都装不上，页面自己的 JSON.parse 也会炸。
 *  3. 响应规则与请求规则不能混。两者曾经被合并成一份规则表，
 *     结果请求规则会改写接口响应（把真 token 改成假 token），响应规则会改写请求体。
 *  4. 不重复解析请求体。请求体必须用**原始** JSON.parse 解析，用被钩过的那个会把
 *     响应规则套上去，且"改动前"取到的已经是改动后的值，请求体篡改会整体静默失效。
 *  5. 两个存储区对称。规则里没有字段能区分 localStorage 与 sessionStorage，
 *     面板又把它们并列呈现，只钩一个会让另一半的规则静默不生效。
 *
 * 另有一条性能约束：JSON.parse 是全局钩子，页面上每次解析都会走一遍遍历。
 * 规则在 config 更新时**预编译**成查表结构，遍历里只做 O(1) 命中判断。
 *
 * 能力边界（架构限制，不是缺陷）——钩子装在**当前页面主世界**，
 * 下面这些路径的解析发生在别处，规则一律不生效，不要指望它们：
 *  - Web Worker / SharedWorker / Service Worker 里解析的响应（各有独立全局）
 *  - 跨域 iframe 内的请求（注入不到那个文档）
 *  - 页面在引擎装钩**之前**就把 JSON.parse 存了引用（const p = JSON.parse）
 *  - WASM 或原生层直接解析的 JSON（不经过 JS 的 JSON.parse）
 * 注意 Service Worker 本身**不**构成绕过：它只是拦截网络，
 * 响应仍由页面主世界解析，钩子照常命中。
 *
 * 存储规则另有一条边界：**只覆盖 `storage.getItem(k)`，不覆盖 `storage[k]`**。
 * 具名属性访问走的是接口的具名属性 getter（WebIDL legacy platform object 的
 * [[GetOwnProperty]]），不经过实例上的 getItem，所以 `localStorage.vip`
 * 仍返回真实值。要堵住它得把 window.localStorage 换成 Proxy ——
 * 那会改变对象身份（`localStorage === 别的引用`、`Storage.prototype.getItem.call`
 * 仍可绕过），风险大于收益，故不做。**面板与 Agent 工具里显示的永远是真实值**，
 * 不受这条影响（它们读的是原型上的原生方法）。
 */
const INJECT_SCRIPT = `
(function(config) {
    // --- 0. 基础工具 ---

    // 伪装钩子（基础反-反篡改）
    var maskFn = function(fn, original) {
        try {
            Object.defineProperty(fn, 'name', { value: original.name });
            Object.defineProperty(fn, 'length', { value: original.length });
            Object.defineProperty(fn, 'toString', { value: function() { return original.toString(); }, writable: true });
        } catch (e) {}
        return fn;
    };

    // 原始 JSON.parse。请求体必须用它解析。
    var parseOriginal = JSON.parse;

    /**
     * 去重日志。
     *
     * 轮询型页面每秒发一次请求，列表页一次解析 500 条记录 —— 逐次打印的话
     * 控制台会被同一个规则刷满（实测：60 次轮询 = 60 行，一次列表解析 = 500 行），
     * 用户自己的日志被冲掉，且 DevTools 会一直持有这些字符串。
     *
     * 同一条消息只打前 3 次，第 4 次起折叠计数，每 100 次补一条汇总。
     * 表用 Object.create(null)：普通 {} 会让 "toString" / "constructor" 这类消息
     * 命中 Object.prototype 上的函数，当成已计数的次数用，消息被静默吞掉。
     * 当前 8 处调用都带字面量前缀所以碰不到，但下一个人加消息时就会踩。
     */
    var logSeen = Object.create(null);
    var tamperLog = function(msg, style) {
        var n = logSeen[msg] || 0;
        logSeen[msg] = n + 1;
        if (n < 3) {
            console.log('%c[Tamper] ' + msg, style);
        } else if ((n + 1) % 100 === 0) {
            console.log('%c[Tamper] ' + msg + '（已重复 ' + (n + 1) + ' 次，后续不再逐条打印）', style);
        }
    };

    var pageUrl = function() {
        try { return String(window.location.href); } catch (e) { return ''; }
    };

    /**
     * 值类型还原。
     *
     * 面板只有一个文本框，没有类型选择器，所以只能靠写法猜类型。猜的规则要**窄**：
     * 只认严格的 JSON 标量字面量，别的一律当字符串。
     *
     * 曾经用 !isNaN(Number(t)) 判断，等于把「任何能被 Number() 吃掉的东西」都变数字：
     *   "007"      -> 7        （前导零丢失，订单号/手机号被毁）
     *   "1.10"     -> 1.1      （版本号语义丢失）
     *   "0x10"     -> 16       （十六进制写法被当十进制解释）
     *   " 42"      -> 42       （带空格也被吞）
     *   "Infinity" -> Infinity （JSON.stringify 变成 null）
     * 这些写法明显是想表达**字符串**，静默改类型会让页面里的 === "007" 比较失败，
     * 且用户完全看不出为什么。
     *
     * 现在只有两种写法能得到非字符串：
     *   1. 严格的 JSON 标量：true / false / null / 无前导零无空格的数字
     *   2. 显式前缀 = ，如 ="007" 取等号后面的原文（想强制字符串又怕被猜成数字时用）
     */
    var parseValue = function(val) {
        if (typeof val !== 'string') return val;

        // 显式转义：= 后面原样当字符串
        if (val.charAt(0) === '=') return val.slice(1);

        if (val === 'true') return true;
        if (val === 'false') return false;
        if (val === 'null') return null;
        if (val === 'undefined') return undefined;

        // 严格数字：可选负号 + 整数（不许前导零）或小数，或科学计数法。
        // 不用正则字面量 —— 这段脚本整体嵌在模板字符串里，正则里的反斜杠会被模板吃掉
        // （实测：源码写反斜杠 d 的转义，运行时变成裸 d，正则静默失效且不报错）。
        // 手写字符判断，既避开这个坑，也比正则快。
        if (isStrictNumber(val)) return Number(val);
        return val;
    };

    var isStrictNumber = function(s) {
        if (s === '') return false;
        var i = 0;
        if (s.charAt(0) === '-') i++;
        if (i >= s.length) return false;

        // 整数部分：单个 0，或 1-9 开头的数字串（不许前导零）
        var intStart = i;
        if (s.charAt(i) === '0') {
            i++;
        } else if (s.charAt(i) >= '1' && s.charAt(i) <= '9') {
            i++;
            while (i < s.length && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
        } else {
            return false;
        }
        // 前导零后面还有数字 => "007" 这类，判为字符串
        if (i - intStart > 1 && s.charAt(intStart) === '0' && s.charAt(i) >= '0' && s.charAt(i) <= '9') return false;

        // 小数部分
        if (i < s.length && s.charAt(i) === '.') {
            i++;
            var fracStart = i;
            while (i < s.length && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
            if (i === fracStart) return false;   // "1." 不算数字
        }

        // 指数部分
        if (i < s.length && (s.charAt(i) === 'e' || s.charAt(i) === 'E')) {
            i++;
            if (i < s.length && (s.charAt(i) === '+' || s.charAt(i) === '-')) i++;
            var expStart = i;
            while (i < s.length && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
            if (i === expStart) return false;    // "1e" 不算数字
        }

        return i === s.length;
    };

    // glob 匹配：'*' 任意串、'?' 任意单字符。
    // 手写而不用正则：注入脚本嵌在模板字符串里，正则转义的反斜杠会被模板吃掉。
    var globMatch = function(glob, text) {
        var g = 0, t = 0, star = -1, mark = 0;
        while (t < text.length) {
            if (g < glob.length && (glob.charAt(g) === '?' || glob.charAt(g) === text.charAt(t))) { g++; t++; }
            else if (g < glob.length && glob.charAt(g) === '*') { star = g++; mark = t; }
            else if (star >= 0) { g = star + 1; t = ++mark; }
            else return false;
        }
        while (g < glob.length && glob.charAt(g) === '*') g++;
        return g === glob.length;
    };

    /**
     * 编译 URL 匹配器。
     * null 表示「全部匹配」—— 空串、'*'、'.*' 都算：
     * UI 里 URL 匹配的占位符写的就是 '*'，不认它等于所有规则默认失效。
     */
    var compileMatcher = function(pattern) {
        var p = pattern == null ? '' : String(pattern);
        if (p === '' || p === '*' || p === '.*') return null;
        if (p.indexOf('*') !== -1 || p.indexOf('?') !== -1) {
            return function(urls) {
                for (var i = 0; i < urls.length; i++) { if (urls[i] && globMatch(p, urls[i])) return true; }
                return false;
            };
        }
        return function(urls) {
            for (var i = 0; i < urls.length; i++) { if (urls[i] && urls[i].indexOf(p) !== -1) return true; }
            return false;
        };
    };

    // 规则预编译：过滤 enabled、拆好目标键、编好 URL 匹配器
    var compile = function(cfg) {
        // 被丢弃的规则数量，回传给面板提示。
        // 丢弃本身是对的（没有目标键的规则永远匹配不上），但不能是**静默**的：
        // 面板「新增规则」默认就是空 jsonPath / 空 headerName，
        // 用户只填一半就点「应用更改」时，界面上显示「启用中」而引擎里根本不存在。
        var dropped = { rules: 0, requestRules: 0, headerRules: 0 };

        var buildFields = function(list, dropKey) {
            var out = [];
            if (!list || !list.length) return out;
            for (var i = 0; i < list.length; i++) {
                var r = list[i];
                if (!r || !r.enabled) continue;
                var path = r.jsonPath == null ? '' : String(r.jsonPath);
                var key = path.split('.').pop();
                if (!key) { dropped[dropKey]++; continue; }   // 没有目标键的规则永远匹配不上，丢弃
                out.push({
                    key: key,
                    rawPath: path,
                    rawValue: r.newValue == null ? '' : String(r.newValue),
                    value: parseValue(r.newValue),
                    match: compileMatcher(r.urlPattern)
                });
            }
            return out;
        };
        var buildHeaders = function(list) {
            var out = [];
            if (!list || !list.length) return out;
            for (var i = 0; i < list.length; i++) {
                var r = list[i];
                if (!r || !r.enabled) continue;
                if (!r.headerName) { dropped.headerRules++; continue; }
                out.push({
                    name: String(r.headerName),
                    lower: String(r.headerName).toLowerCase(),
                    value: r.headerValue == null ? '' : String(r.headerValue),
                    match: compileMatcher(r.urlPattern)
                });
            }
            return out;
        };
        var compiled = {
            rules: buildFields(cfg && cfg.rules, 'rules'),
            requestRules: buildFields(cfg && cfg.requestRules, 'requestRules'),
            headerRules: buildHeaders(cfg && cfg.headerRules)
        };
        compiled.dropped = dropped;
        return compiled;
    };

    /**
     * 深度遍历并改写。
     *
     * rules 必须由调用方明确传入：响应路径传 rules，请求路径传 requestRules。
     * urls 是该数据可能的来源地址（接口地址 + 页面地址）—— 规则既能按页面地址匹配，
     * 也能按接口地址匹配，两者取或。只按页面地址匹配时，针对具体接口写的规则永远不生效。
     *
     * seen 集合是**载荷性**的，不能删：JSON.parse 的 reviver 可以造出循环引用
     * （在 reviver 里写 v.self = v），实测去掉这两行后 walk 无限递归抛 RangeError。
     * 而在生产路径上，这个异常会被 JSON.parse 钩子里的 try/catch **吞掉** ——
     * 症状不是页面崩溃，而是"篡改对这份数据静默失效"，极难排查。
     * 所以这里宁可多一次 Set 查询。
     */
    var traverseAndModify = function(obj, rules, urls) {
        if (!obj || typeof obj !== 'object' || !rules || !rules.length) return obj;

        var seen = new Set();
        var walk = function(target) {
            if (!target || typeof target !== 'object') return;
            if (seen.has(target)) return;
            seen.add(target);

            for (var key in target) {
                if (!Object.prototype.hasOwnProperty.call(target, key)) continue;

                for (var i = 0; i < rules.length; i++) {
                    var rule = rules[i];
                    if (rule.key !== key) continue;
                    if (rule.match && !rule.match(urls)) continue;

                    var cur = target[key];
                    if (cur === rule.value) continue;
                    // 只在标量之间打日志：对象比较没有意义，也刷屏
                    if (cur === null || typeof cur !== 'object') {
                        tamperLog(' ✏️ ' + key + ' -> ' + rule.value, 'color: cyan; background: #000;');
                    }
                    target[key] = rule.value;
                }

                var next = target[key];
                if (next && typeof next === 'object') walk(next);
            }
        };

        walk(obj);
        return obj;
    };

    /**
     * 报告被丢弃的规则。
     *
     * 丢弃是正确行为（没有目标键的规则永远匹配不上），但必须说出来：
     * 面板「新增规则」默认就是空 jsonPath / 空 headerName，
     * 用户填一半就点「应用更改」时，界面显示「启用中」而引擎里根本没有这条规则。
     * 不提示的话，用户会一直以为是自己 URL 写错了。
     */
    var reportDropped = function(compiled) {
        var d = compiled && compiled.dropped;
        if (!d) return;
        var parts = [];
        if (d.rules) parts.push('响应 ' + d.rules + ' 条');
        if (d.requestRules) parts.push('请求体 ' + d.requestRules + ' 条');
        if (d.headerRules) parts.push('请求头 ' + d.headerRules + ' 条');
        if (!parts.length) return;
        console.warn('%c[Tamper] ⚠️ 有规则因「目标键 / Header 名为空」被跳过，未生效：' + parts.join('、')
            + '。请在面板里补全后重新应用。', 'color: #f66; font-weight: bold');
    };

    // --- 1. 配置更新 ---
    // 已装过就只换配置：重复打补丁会让钩子链越套越深，同一个响应被篡改 N 次。
    // 只存预编译结果：原始 config 没有任何读取方，留着是死状态
    // （改规则时它会被旧 config 覆盖，看的人会以为规则没更新）。
    if (window.__interceptorInstalled) {
        window.__interceptorCompiled = compile(config);
        reportDropped(window.__interceptorCompiled);
        console.log('%c[Tamper] 🔄 Rules Updated', 'color: #0f0; background: #333; padding: 2px 4px; border-radius: 2px;');
        return;
    }

    window.__interceptorCompiled = compile(config);
    reportDropped(window.__interceptorCompiled);

    console.log('%c[Tamper] 🛡️ Interceptor v3.1 Activated', 'color: #fff; background: #e00; font-weight: bold; padding: 4px; border-radius: 4px;');

    // --- 2. JSON.parse（响应文本解析路径）---
    try {
        var originalParse = JSON.parse;
        JSON.parse = maskFn(function(text, reviver) {
            var data = originalParse.apply(this, arguments);
            try {
                var c = window.__interceptorCompiled;
                if (data && typeof data === 'object' && c && c.rules.length) {
                    traverseAndModify(data, c.rules, [pageUrl()]);
                }
            } catch (e) {}
            return data;
        }, originalParse);
    } catch (e) {}

    // --- 3. Response.prototype.json（fetch 响应路径）---
    try {
        if (window.Response && Response.prototype.json) {
            var originalResponseJson = Response.prototype.json;
            Response.prototype.json = maskFn(function() {
                var self = this;
                var args = arguments;
                return Promise.resolve(originalResponseJson.apply(self, args)).then(function(data) {
                    try {
                        var c = window.__interceptorCompiled;
                        var u = '';
                        try { u = String(self.url || ''); } catch (e) {}
                        if (data && typeof data === 'object' && c && c.rules.length) {
                            traverseAndModify(data, c.rules, [u, pageUrl()]);
                        }
                    } catch (e) {}
                    return data;
                });
            }, originalResponseJson);
        }
    } catch (e) {}

    // --- 4. XMLHttpRequest（请求体 / 请求头 / 响应）---
    try {
        var originalXHR = window.XMLHttpRequest;
        if (typeof originalXHR === 'function') {

            var WrappedXHR = maskFn(function() {
                var xhr = new originalXHR();
                var originalOpen = xhr.open;
                var originalSetRequestHeader = xhr.setRequestHeader;
                var originalSend = xhr.send;

                xhr.open = maskFn(function(method, url) {
                    try { this.__tamperUrl = String(url); } catch (e) {}
                    return originalOpen.apply(this, arguments);
                }, originalOpen);

                xhr.setRequestHeader = maskFn(function(header, value) {
                    var finalValue = value;
                    var blocked = false;
                    try {
                        var c = window.__interceptorCompiled;
                        var rules = (c && c.headerRules) || [];
                        var name = String(header).toLowerCase();
                        var urls = [this.__tamperUrl || '', pageUrl()];
                        for (var i = 0; i < rules.length; i++) {
                            var rule = rules[i];
                            if (rule.lower !== name) continue;
                            if (rule.match && !rule.match(urls)) continue;
                            if (rule.value === '') {
                                blocked = true;
                                tamperLog(' 🚫 Header 已删除: ' + header, 'color: #f66');
                            } else {
                                finalValue = rule.value;
                                tamperLog(' ✏️ Header 已改写: ' + header, 'color: #ff0');
                            }
                        }
                    } catch (e) {}
                    if (blocked) return undefined;
                    return originalSetRequestHeader.apply(this, [header, finalValue]);
                }, originalSetRequestHeader);

                xhr.send = maskFn(function(body) {
                    try {
                        var c = window.__interceptorCompiled;
                        if (c && c.requestRules.length && typeof body === 'string' && (body.charAt(0) === '{' || body.charAt(0) === '[')) {
                            var data = parseOriginal(body);
                            var before = JSON.stringify(data);
                            traverseAndModify(data, c.requestRules, [this.__tamperUrl || '', pageUrl()]);
                            var after = JSON.stringify(data);
                            if (after !== before) {
                                tamperLog(' 💉 请求体已注入 (XHR)', 'color: #f0f');
                                body = after;
                            }
                        }
                    } catch (e) {}
                    return originalSend.apply(this, [body]);
                }, originalSend);

                return xhr;
            }, originalXHR);

            // instanceof 必须仍然成立：包装函数返回的是真正的 XHR 实例，
            // 把原型指回去即可（构造函数返回对象时，new 拿到的就是那个对象）。
            try { WrappedXHR.prototype = originalXHR.prototype; } catch (e) {}
            try { Object.setPrototypeOf(WrappedXHR, originalXHR); }
            catch (e) { try { Object.assign(WrappedXHR, originalXHR); } catch (e2) {} }

            window.XMLHttpRequest = WrappedXHR;

            // responseType = 'json' 时浏览器自己解析响应，绕过 JSON.parse 与 Response.json。
            // 这是现代前端最常见的取数方式，不在这里补一刀则响应篡改对它完全无效。
            try {
                var respDesc = Object.getOwnPropertyDescriptor(originalXHR.prototype, 'response');
                if (respDesc && typeof respDesc.get === 'function') {
                    Object.defineProperty(originalXHR.prototype, 'response', {
                        configurable: true,
                        enumerable: respDesc.enumerable,
                        get: function() {
                            var v = respDesc.get.call(this);
                            try {
                                var c = window.__interceptorCompiled;
                                if (v && typeof v === 'object' && c && c.rules.length) {
                                    var u = '';
                                    try { u = String(this.responseURL || ''); } catch (e) {}
                                    traverseAndModify(v, c.rules, [u, pageUrl()]);
                                }
                            } catch (e) {}
                            return v;
                        }
                    });
                }
            } catch (e) {}
        }
    } catch (e) {}

    // --- 5. fetch（请求体 / 请求头）---
    try {
        var originalFetch = window.fetch;
        if (typeof originalFetch === 'function') {
            window.fetch = maskFn(function(input, init) {
                var url = '';
                var isRequest = false;
                try {
                    isRequest = typeof Request === 'function' && input instanceof Request;
                    url = isRequest ? String(input.url) : String(input);
                } catch (e) { url = ''; }

                var c = window.__interceptorCompiled;

                // 请求头：init.headers 优先，其次 Request 实例自带的头；
                // 两者都没有时也要能注入 —— 只在 init.headers 存在时才处理的话，
                // fetch(url) / fetch(Request) 这两种最常见写法下头规则形同虚设。
                try {
                    var hRules = (c && c.headerRules) || [];
                    if (hRules.length) {
                        var headers = null;
                        try {
                            if (init && init.headers) headers = new Headers(init.headers);
                            else if (isRequest) headers = new Headers(input.headers);
                            else headers = new Headers();
                        } catch (e) {
                            try { headers = new Headers(); } catch (e2) { headers = null; }
                        }

                        if (headers) {
                            var changed = false;
                            // 日志延后到改动真正生效再打：Request 重建可能失败
                            // （body 已被消费等），那时先打日志就成了假证据。
                            var pendingLogs = [];
                            var urls = [url, pageUrl()];
                            for (var i = 0; i < hRules.length; i++) {
                                var rule = hRules[i];
                                if (rule.match && !rule.match(urls)) continue;
                                if (rule.value === '') {
                                    if (headers.has(rule.name)) {
                                        headers.delete(rule.name);
                                        changed = true;
                                        pendingLogs.push('🚫 Header 已删除: ' + rule.name);
                                    }
                                } else {
                                    headers.set(rule.name, rule.value);
                                    changed = true;
                                    pendingLogs.push('✏️ Header 已改写: ' + rule.name);
                                }
                            }
                            if (changed) {
                                var applied = true;
                                if (!init && isRequest) {
                                    // Request.headers 不可变，只能重建
                                    try { input = new Request(input, { headers: headers }); }
                                    catch (e) { applied = false; }
                                } else {
                                    init = Object.assign({}, init, { headers: headers });
                                }

                                // 失败时**不能**再打"已改写"——只靠颜色区分不够，
                                // 控制台里复制出来就是一串成功记录。
                                if (applied) {
                                    for (var j = 0; j < pendingLogs.length; j++) {
                                        tamperLog(' ' + pendingLogs[j], 'color: #ff0');
                                    }
                                } else {
                                    tamperLog(' ⚠️ 请求头未能改写（Request 无法重建，body 可能已被消费）: ' + pendingLogs.length + ' 条规则未生效', 'color: #f66');
                                }
                            }
                        }
                    }
                } catch (e) {}

                // 请求体
                try {
                    var rRules = (c && c.requestRules) || [];
                    if (rRules.length && init && typeof init.body === 'string' && (init.body.charAt(0) === '{' || init.body.charAt(0) === '[')) {
                        var data = parseOriginal(init.body);
                        var before = JSON.stringify(data);
                        traverseAndModify(data, rRules, [url, pageUrl()]);
                        var after = JSON.stringify(data);
                        if (after !== before) {
                            tamperLog(' 💉 请求体已注入 (fetch)', 'color: #f0f');
                            init = Object.assign({}, init, { body: after });
                        }
                    }
                } catch (e) {}

                return originalFetch.call(this, input, init);
            }, originalFetch);
        }
    } catch (e) {}

    // --- 6. 存储读取篡改 ---
    // 两个存储区都要装：面板把它们并列呈现，规则又没有字段能区分是哪一个，
    // 只钩 localStorage 会让"给 sessionStorage 里的键写的规则"静默不生效。
    // 每个区各自 try/catch —— 沙箱 iframe 里读其中一个就抛 SecurityError，
    // 合并成一个 try 会让另一个区一起装不上。
    var hookStorage = function(areaName) {
        try {
            var storage = window[areaName];
            if (!storage || typeof storage.getItem !== 'function') return;
            var originalGetItem = storage.getItem;
            storage.getItem = maskFn(function(key) {
                try {
                    var c = window.__interceptorCompiled;
                    var rules = (c && c.rules) || [];
                    var k = String(key);
                    var urls = [pageUrl()];
                    for (var i = 0; i < rules.length; i++) {
                        // 存储按「键」精确匹配：整条 jsonPath 或它的末段都算
                        if (rules[i].key !== k && rules[i].rawPath !== k) continue;
                        if (rules[i].match && !rules[i].match(urls)) continue;
                        tamperLog(' 📖 存储读取已改写: ' + areaName + '.' + k, 'color: #f80');
                        return rules[i].rawValue;
                    }
                } catch (e) {}
                return originalGetItem.apply(this, arguments);
            }, originalGetItem);
        } catch (e) { /* 该存储区不可访问 */ }
    };
    hookStorage('localStorage');
    hookStorage('sessionStorage');

    // 全部装完才置位：中途失败时保持未装状态，下次注入可以补齐
    window.__interceptorInstalled = true;

})(%CONFIG%);
`;

/** 注入脚本的 config 载荷，与 useTamper 持有的三份规则一一对应 */
interface TamperConfig {
    rules: TamperRule[];
    requestRules: TamperRule[];
    headerRules: HeaderRule[];
}

/**
 * 把 config 填进注入脚本。
 *
 * 替换必须用**函数式**形式：字符串替换会把 config 里的 `$&` / `` $` `` / `$'` / `$1`
 * 当成反向引用解释，一条 newValue 为 "$&" 的规则足以让整段脚本被替换成 config 文本本身
 * —— 页面里什么都没装上，且不报任何错。
 */
const buildTamperScript = (config: TamperConfig): string =>
    INJECT_SCRIPT.replace('%CONFIG%', () => JSON.stringify(config));

/* -------------------------------------------------------------------------- */
/*                                  类型                                       */
/* -------------------------------------------------------------------------- */

/**
 * 一次导航失败。
 *
 * 类型与判据都来自 services/BrowserService —— **这里只是再导出**，
 * 让 hooks 的使用方不必知道它住在哪一层。判据绝不能在本文件里再写一份：
 * 主进程与渲染层各维护一张错误码表，漂移的症状是"同一个错误在日志里和
 * 界面上叫两个名字"，不报错、不崩溃，只是让人对不上号。
 */
export type { NavigationError };

export interface Tab {
    id: string;
    /** 当前 URL（React 状态同步用） */
    url: string;
    /** 首次加载的 URL（webview src 属性用，避免重复加载） */
    initialUrl: string;
    title: string;
    isLoading: boolean;
    /** 每个标签页独立的历史记录 */
    history: string[];
    historyIndex: number;
    /** 用于触发刷新的 Key */
    reloadKey: number;
    /** 强制刷新（忽略缓存）的 Key。与 reloadKey 分开：两者走不同的 webview API */
    hardReloadKey: number;
    /** 待处理的导航动作（由 interactions 落到 webview API） */
    pendingNavigation?: 'back' | 'forward';
    /** 真实 favicon 地址（page-favicon-updated 事件）。空则回落到 hostname 取色块 */
    favicon: string;
    /** 导航失败详情。非空时页面区显示错误页而不是空白 */
    error: NavigationError | null;
    /** 渲染进程崩溃（render-process-gone）。与 error 分开：它需要的是"重新加载"而不是"重试" */
    crashed: boolean;
    /** 此刻是否正在出声（静音的视频不算） */
    audible: boolean;
    /** 是否被静音 */
    muted: boolean;
    /** 缩放级别（Electron 的 zoomLevel，每级 1.2 倍）。0 为 100% */
    zoomLevel: number;
}

export interface TabsState {
    tabs: Tab[];
    activeTabId: string;
    activeTab: Tab;
    actions: {
        createTab: (url?: string) => string;
        closeTab: (tabId: string) => void;
        switchTab: (tabId: string) => void;
        navigateTab: (tabId: string, url: string, isLoading?: boolean, keepTitle?: boolean) => void;
        updateTabTitle: (tabId: string, title: string) => void;
        setTabLoading: (tabId: string, isLoading: boolean) => void;
        goBack: (tabId: string) => void;
        goForward: (tabId: string) => void;
        goHome: (tabId: string) => void;
        reload: (tabId: string) => void;
        /** 强制刷新：忽略缓存重新拉取。普通刷新改不掉的旧资源靠它 */
        hardReload: (tabId: string) => void;
        openInNewTab: (url: string) => void;
        syncTabUrl: (tabId: string, url: string, historyIndex?: number) => void;
        clearPendingNavigation: (tabId: string) => void;
        setTabFavicon: (tabId: string, favicon: string) => void;
        setTabError: (tabId: string, error: NavigationError | null) => void;
        setTabCrashed: (tabId: string, crashed: boolean) => void;
        setTabAudible: (tabId: string, audible: boolean) => void;
        setTabMuted: (tabId: string, muted: boolean) => void;
        setTabZoom: (tabId: string, zoomLevel: number) => void;
        /** 恢复最近关闭的标签页（Ctrl+Shift+T）。没有可恢复的返回 false */
        reopenClosedTab: () => boolean;
    };
}

/**
 * 书签状态。
 *
 * 真值是 `tree`（树）。不再另外派生一份平铺列表：唯一需要平铺的消费者是
 * 首页的快速访问网格，它已删除；剩下的消费点（书签栏、下拉、管理器）都
 * 直接遍历树，多一份派生副本只会多一处会漂移的判据。
 */
export interface BookmarksState {
    /** 书签树（真值） */
    tree: BookmarkTree;
    /** 收藏夹栏显示策略 */
    barVisibility: BookmarkBarVisibility;
    setBarVisibility: (value: BookmarkBarVisibility) => void;
    isBookmarked: (url: string) => boolean;
    toggleBookmark: (url: string, title?: string) => void;
    removeBookmark: (id: string) => void;
    /** 在指定文件夹下新建文件夹，返回新文件夹 id（失败返回空串） */
    addFolder: (parentId: string, title: string) => string;
    /** 重命名节点 */
    renameNode: (id: string, title: string) => void;
    /** 改网址节点的 url */
    updateNodeUrl: (id: string, url: string) => void;
    /** 移动节点到另一个文件夹 */
    moveBookmark: (id: string, targetFolderId: string, index?: number) => void;
    /** 把导入的节点合并进某个根，返回统计 */
    mergeImported: (target: 'bar' | 'other', nodes: BookmarkNode[]) => MergeStats;
    /** 清空某个根下的全部内容 */
    clearRoot: (target: 'bar' | 'other') => void;
}

export interface SearchState {
    engine: SearchEngine;
    setEngine: (engine: SearchEngine) => void;
    parseInputToUrl: (input: string) => string;
}

export interface SnifferState {
    foundLinks: FoundLink[];
    filteredLinks: FoundLink[];
    isAnalyzing: boolean;
    statusMessage: string;
    filterType: MediaType | 'all';
    scopeFilter: 'all' | 'current';
    /**
     * "持续嗅探"总开关。打开时切页自动扫描 + 网络层持续推送；
     * 关闭时两者全停（手动点"嗅探"按钮做的一次性扫描不受影响）。
     * 默认关闭，状态落盘持久化。
     */
    sniffEnabled: boolean;
    error: string;
    downloadingUrl: string;
    /** 当前下载的实时进度；没有下载在进行时为 null */
    downloadProgress: MediaDownloadProgress | null;
    downloadCapabilities: DownloadCapabilities;
    actions: {
        /** runId：同一轮多次扫描共用一个序号，过期轮次的结果与状态更新会被丢弃 */
        scan: (targetUrl?: string, runId?: number) => Promise<void>;
        /** 打开/关闭持续嗅探（同步写盘 + 通知主进程开关网络推送） */
        setSniffEnabled: (enabled: boolean) => void;
        analyzeWithAi: (targetUrl: string) => Promise<void>;
        setFilterType: (type: MediaType | 'all') => void;
        setScopeFilter: (scope: 'all' | 'current') => void;
        clear: () => void;
        clearCurrentPage: (pageUrl?: string) => void;
        download: (link: FoundLink) => Promise<DownloadMediaResult>;
        /** 取消正在进行的下载（半成品文件由主进程删除） */
        cancelDownload: () => Promise<void>;
    };
}

/**
 * 地址栏此刻该不该跟随页面 URL。
 *
 * 用户在编辑时**不能**跟随：SPA 每次 pushState / hash 变化都会更新 activeTab.url，
 * 跟随会把用户正在敲的地址覆盖掉。失焦后恢复跟随，于是切页/跳转仍会正常刷新地址栏。
 * 这也是 Chrome 地址栏的行为 —— 正在输入时它不会被页面导航改写。
 *
 * 抽成纯函数是为了能直接测：这个判据只有一个方向容易搞错（少一个取反），
 * 而错了的表现是"用户输入被吞"或"地址栏永远停在旧地址"，都不容易一眼看出来。
 */
export const shouldAddressBarFollow = (inputFocused: boolean): boolean => !inputFocused;

/** 页面内查找的当前结果 */
export interface FindInfo {
    /** 命中总数 */
    matches: number;
    /** 当前是第几个（1 起）；无命中时为 0 */
    active: number;
}

export interface InteractionsState {
    inputUrl: string;
    setInputUrl: (url: string) => void;
    /**
     * 地址栏聚焦状态。地址栏必须在聚焦时**停止跟随** activeTab.url，
     * 否则 SPA 的 in-page 导航会把用户正在敲的地址覆盖掉（见 useInteractions 内注释）。
     */
    setInputFocused: (focused: boolean) => void;
    isCurrentPageBookmarked: boolean;
    handleNavigate: (urlOrQuery: string) => void;
    handleOpenInNewTab: (url: string) => void;
    /**
     * 取该标签页**稳定身份**的 ref 回调。JSX 里必须写 `ref={getWebviewRef(tab.id)}`，
     * 不能写内联箭头 —— 原因见 useInteractions 内的注释。
     *
     * 这是注册 webview 的**唯一入口**。内部的 registerWebview 刻意不对外暴露：
     * 内联 ref 箭头会让它每渲染收到一次 null，把 ready 标记与刷新记账清空
     * （表现为每渲染重载一次、地址栏换地址无效）。只留这个缓存版回调，
     * 就没有"正确写法 / 错误写法"两条路可选。
     */
    getWebviewRef: (tabId: string) => (el: WebviewElement | null) => void;
    getActiveWebview: () => WebviewElement | null;
    /**
     * 订阅「页面就绪」广播：每个标签页每次 dom-ready 各触发一次，回调收到该页 webview。
     * 返回退订函数。
     *
     * 需要长期活在页面里的注入（篡改引擎）挂这里，而不是自己往 webview 上
     * addEventListener('dom-ready') —— 那样在 webview 尚未挂载时监听会丢失，
     * 且换标签页后仍绑在旧页上。
     */
    onPageReady: (cb: (tabId: string, webview: WebviewElement) => void) => () => void;
    /** 遍历当前存活的全部 webview（规则变更时向所有页面推送用） */
    forEachWebview: (cb: (webview: WebviewElement, tabId: string) => void) => void;
    /** 取某个标签页的 webview（可能未挂载，返回 null） */
    getWebview: (tabId: string) => WebviewElement | null;

    /* ------------------------------ 页面能力 ------------------------------ */

    /** 中止当前导航。加载卡住时唯一的出路 —— 不调它只能等超时 */
    stopLoading: (tabId: string) => void;
    /** 页面内查找。空串 = 结束查找并清掉高亮 */
    findInPage: (tabId: string, text: string, options?: { forward?: boolean; findNext?: boolean }) => void;
    /** 结束查找 */
    stopFindInPage: (tabId: string, keepSelection?: boolean) => void;
    /** 调整缩放。delta: +1 放大 / -1 缩小 / 0 复位到 100% */
    zoomBy: (tabId: string, delta: number) => void;
    /** 静音 / 取消静音 */
    toggleMute: (tabId: string) => void;
    /** 重新加载崩溃的页面 */
    reviveTab: (tabId: string) => void;

    /** 当前查找状态（按标签页）。查找条据此显示 "3/17" */
    findInfo: FindInfo;
    /** 当前正在查找的词（空串表示还没打词，条可能开着等输入） */
    findQuery: string;
    /** 查找条是否开着（与词分离：刚按 Ctrl+F 时开着但词为空） */
    findOpen: boolean;
    /** 打开/关闭查找条。传空串等于关闭 */
    setFindQuery: (text: string) => void;
    /** 只打开查找条不等输入（Ctrl+F）；已开着时保持不动 */
    openFind: () => void;
    /** 关闭查找条并清掉高亮 */
    closeFind: () => void;
    /**
     * 订阅**只属于界面层**的浏览器动作（聚焦地址栏 / 让 Agent 分析元素 /
     * 用选中文字搜索）。真值在 BrowsePanel（它持有地址栏 input 的 ref 与
     * Agent 输入框），useBrowse 无从下手，所以原样转发。返回退订函数。
     */
    onUiAction: (cb: (command: BrowserCommand) => void) => () => void;
}

export interface TamperState {
    state: {
        interceptRules: TamperRule[];
        requestRules: TamperRule[];
        headerRules: HeaderRule[];
    };
    actions: {
        /**
         * 应用规则：注入全部存活页面，并尝试持久化。
         *
         * 返回值是**持久化**结果，不是注入结果 —— 两者会分离（配额爆了规则
         * 仍对当前页面生效，但重启就没了），调用方必须能说出这个区别。
         */
        saveRules: (intercept: TamperRule[], request: TamperRule[], headers: HeaderRule[]) => boolean;
        /**
         * 只注入不落盘。
         *
         * 给 Agent 工具用：模型改规则可以立刻生效，但不该越过用户把浏览器行为
         * 永久改掉。面板会显示「未应用」，由用户点「应用更改」才写进本地存储。
         */
        applyRules: (intercept: TamperRule[], request: TamperRule[], headers: HeaderRule[]) => void;
        getLocalStorage: () => Promise<string>;
        getSessionStorage: () => Promise<string>;
        setLocalStorage: (key: string, val: string) => Promise<boolean>;
        removeLocalStorage: (key: string) => Promise<boolean>;
        setSessionStorage: (key: string, val: string) => Promise<boolean>;
        removeSessionStorage: (key: string) => Promise<boolean>;
        /** 读当前页面的 Cookie。地址不可查询时返回空数组 */
        getCookies: () => Promise<CookieItem[]>;
        /** 覆盖一条 Cookie（整条覆盖，必须带上原字段） */
        setCookie: (cookie: CookieItem) => Promise<boolean>;
        /** 按 name 删除 Cookie；同名不同 path 会被一起删掉（Electron 无按 path 删的入口） */
        removeCookie: (name: string) => Promise<boolean>;
    };
}

export interface BrowseState {
    tabs: TabsState;
    bookmarks: BookmarksState;
    search: SearchState;
    sniffer: SnifferState;
    interactions: InteractionsState;
    tamper: TamperState;
    downloads: DownloadsState;
}

/**
 * 网页自身触发的下载（区别于嗅探下载 / 画廊下载 / BT）。
 *
 * 状态由**主进程**持有（DownloadItem 只在那里），渲染层只是镜像 ——
 * 所以这里的 actions 全是"发一条 IPC 然后等主进程推新快照回来"，
 * 不做乐观更新。乐观更新在这里是错的：暂停能不能成功取决于服务器
 * 是否支持 Range 请求，本地先改状态会让界面显示"已暂停"而实际还在下。
 */
export interface DownloadsState {
    items: BrowserDownload[];
    /** 正在进行的条数（进度条徽标用） */
    activeCount: number;
    actions: {
        pause: (id: string) => Promise<void>;
        resume: (id: string) => Promise<void>;
        cancel: (id: string) => Promise<void>;
        /** 在系统文件管理器里定位到文件 */
        reveal: (id: string) => Promise<void>;
        open: (id: string) => Promise<void>;
        /** 只从列表移除记录，不删文件 */
        remove: (id: string) => Promise<void>;
        /** 清掉所有已结束的记录 */
        clearFinished: () => void;
    };
}

/* -------------------------------------------------------------------------- */
/*                              内部：标签页                                    */
/* -------------------------------------------------------------------------- */

interface StoredTab {
    url: string;
    title: string;
}

interface StoredTabs {
    tabs: StoredTab[];
    activeIndex: number;
}

/**
 * 读回上次的标签页 —— 纯函数部分（可测）。
 *
 * activeIndex 是**落盘时那份数组**的下标，而这里会把空白页（url 为空）过滤掉 ——
 * 两者错位就会恢复到错误的标签页。实测：`[空白, A, B]` 且正在看 A（index 1），
 * 过滤后数组变成 `[A, B]`，再用 1 去索引就落到了 B。
 * 所以下标必须**在过滤的同时**跟着映射，而不是过滤完再套用旧下标。
 */
export const pickStoredTabs = (saved: unknown): StoredTabs | null => {
    const raw = saved as StoredTabs | null;
    if (!raw || !Array.isArray(raw.tabs) || raw.tabs.length === 0) return null;

    const savedActiveIndex = Number.isInteger(raw.activeIndex) ? raw.activeIndex : 0;
    const tabs: StoredTab[] = [];
    // 落盘时的活动页被过滤掉（它本身是空白页）或超出上限时，退回第一个
    let activeIndex = 0;

    const limit = Math.min(raw.tabs.length, TABS_STORE_MAX);
    for (let i = 0; i < limit; i += 1) {
        const t = raw.tabs[i];
        if (!t || typeof t.url !== 'string' || t.url.length === 0 || t.url.length > 4096) continue;
        // 落盘时的第 i 条，在新数组里的位置就是当前长度 —— 一边过滤一边映射下标
        if (i === savedActiveIndex) activeIndex = tabs.length;
        tabs.push({ url: t.url, title: typeof t.title === 'string' ? t.title.slice(0, 120) : '' });
    }

    if (tabs.length === 0) return null;
    return { tabs, activeIndex };
};

const loadStoredTabs = (): StoredTabs | null =>
    pickStoredTabs(loadJSON<StoredTabs | null>(TABS_STORE_KEY, null));

/** 从 URL 提取标题（真实标题由 page-title-updated 事件补上） */
const getTitleFromUrl = (url: string): string => {
    if (!url) return '新标签页';
    try {
        return new URL(url).hostname || '新标签页';
    } catch {
        return url.slice(0, 30) || '新标签页';
    }
};

const makeBlankTab = (id = generateId()): Tab => ({
    id,
    url: '',
    initialUrl: '',
    title: '新标签页',
    isLoading: false,
    history: [],
    historyIndex: -1,
    reloadKey: 0,
    hardReloadKey: 0,
    favicon: '',
    error: null,
    crashed: false,
    audible: false,
    muted: false,
    zoomLevel: 0,
});

const makeTab = (url = '', title = ''): Tab => ({
    id: generateId(),
    url,
    initialUrl: url,
    title: title || getTitleFromUrl(url),
    isLoading: !!url,
    history: url ? [url] : [],
    historyIndex: url ? 0 : -1,
    reloadKey: 0,
    hardReloadKey: 0,
    favicon: '',
    error: null,
    crashed: false,
    audible: false,
    muted: false,
    zoomLevel: 0,
});

/**
 * 标签页状态是**一个** atom（tabs 与 activeTabId 同生共死）。
 *
 * 旧实现拆成两个 useState，于是 closeTab 必须"先 setTabs 再 setActiveTabId"，
 * 而下一个活动页只能在 setTabs 的 updater 里算出来 —— updater 在 StrictMode 下
 * 会双跑，在里面写外部变量就会执行两次。原作者已经踩到，用注释记了下来。
 * 合并成一个 atom 后，整个转移是 updater 内的纯计算，双跑无害。
 */
interface TabsAtom {
    tabs: Tab[];
    activeTabId: string;
}

/** 每个 action 都是 (atom, args) => atom 的纯函数，StrictMode 重放下结果一致 */
const mapTab = (state: TabsAtom, tabId: string, fn: (tab: Tab) => Tab): TabsAtom => {
    let changed = false;
    const tabs = state.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const next = fn(tab);
        if (next !== tab) changed = true;
        return next;
    });
    return changed ? { ...state, tabs } : state;
};

const useTabs = (): TabsState => {
    const [state, setState] = useState<TabsAtom>(() => {
        const stored = loadStoredTabs();
        if (stored) {
            const tabs = stored.tabs.map((t) => makeTab(t.url, t.title));
            return { tabs, activeTabId: tabs[stored.activeIndex]?.id ?? tabs[0].id };
        }
        const tabs = [makeBlankTab()];
        return { tabs, activeTabId: tabs[0].id };
    });

    /**
     * 「最近关闭」栈（Ctrl+Shift+T）。
     *
     * 用 ref 而不是 state：它只被 reopenClosedTab 读一次，且**改动它不需要
     * 触发重渲染** —— 放进 state 会让每次关标签都多一轮渲染，而界面上
     * 没有任何东西依赖它。这也意味着它不跨重启（本来也不该跨）。
     */
    const closedStackRef = useRef<{ url: string; title: string }[]>([]);

    const { tabs, activeTabId } = state;

    /**
     * 标签页快照落盘：只存可重建的 url/title（webview 内部历史/滚动不跨重启）。
     *
     * 两个下标必须一起算，不能各自独立：
     *  - 只存前 TABS_STORE_MAX 条（slice(0, MAX)）时，超出上限的那批会被丢掉。
     *    此刻若活动页正在被丢掉的那批里，findIndex 得到的下标就**指向保存范围之外**，
     *    读回时 pickStoredTabs 找不到匹配项、退回第一个 —— 用户重启后回到第一个标签页。
     *  - 所以先确定"保存哪一批"，再在这批里找活动页；找不到就退到 0。
     */
    useEffect(() => {
        const kept = tabs.slice(0, TABS_STORE_MAX);
        const found = kept.findIndex((t) => t.id === activeTabId);
        saveJSON(TABS_STORE_KEY, {
            tabs: kept.map((t) => ({ url: t.url, title: t.title })),
            activeIndex: found >= 0 ? found : 0,
        });
    }, [tabs, activeTabId]);

    const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

    const createTab = useCallback((url: string = '') => {
        const newTab = makeTab(url);
        setState((prev) => ({ tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
        return newTab.id;
    }, []);

    const closeTab = useCallback((tabId: string) => {
        setState((prev) => {
            const closing = prev.tabs.find((t) => t.id === tabId);
            // 只记非空白页，理由见 reopenClosedTab
            if (closing && closing.url) {
                closedStackRef.current.push({ url: closing.url, title: closing.title });
                if (closedStackRef.current.length > CLOSED_STACK_MAX) closedStackRef.current.shift();
            }

            if (prev.tabs.length <= 1) {
                // 至少保留一个标签页，重置为空白页（沿用原 id，webview 引用不必换绑）
                return { tabs: [makeBlankTab(prev.tabs[0].id)], activeTabId: prev.tabs[0].id };
            }
            const closingIndex = prev.tabs.findIndex((t) => t.id === tabId);
            if (closingIndex < 0) return prev;

            const tabs = prev.tabs.filter((t) => t.id !== tabId);
            // 关闭的是当前页时切到相邻标签（优先右侧，越界则取最后一个）
            const activeTabId = tabId === prev.activeTabId
                ? tabs[Math.min(closingIndex, tabs.length - 1)].id
                : prev.activeTabId;
            return { tabs, activeTabId };
        });
    }, []);

    const switchTab = useCallback((tabId: string) => {
        setState((prev) => (prev.activeTabId === tabId ? prev : { ...prev, activeTabId: tabId }));
    }, []);

    /**
     * 更新标签页 URL（导航）。同一地址连续出现只记一条历史（重定向/重复事件去重）。
     *
     * keepTitle：页面内部导航（点击链接）时置真 —— 真实标题随后由
     * page-title-updated 事件补上，此刻先写 hostname 会让标题闪一下域名。
     * 地址栏主动导航不传，保持"立刻给出一个可读标题"的行为。
     */
    const navigateTab = useCallback((tabId: string, url: string, isLoading: boolean = true, keepTitle: boolean = false) => {
        setState((prev) => mapTab(prev, tabId, (tab) => {
            const history = tab.history.slice(0, tab.historyIndex + 1);
            const title = keepTitle ? tab.title : getTitleFromUrl(url);
            // 一旦开始新导航，上一页的错误/崩溃态必须清掉。
            // 不清的话：错误页盖着，而页面其实已经在加载了 —— 用户点重试
            // 之后仍然看到错误页，只能再点一次刷新。
            const cleared = { error: null, crashed: false };
            if (history[history.length - 1] === url) {
                // 已停在同一地址：只更新加载态与标题，不新增历史项
                return { ...tab, ...cleared, url, title, isLoading };
            }
            history.push(url);
            return {
                ...tab,
                ...cleared,
                url,
                initialUrl: tab.initialUrl || url,
                title,
                isLoading,
                history,
                historyIndex: history.length - 1,
            };
        }));
    }, []);

    const updateTabTitle = useCallback((tabId: string, title: string) => {
        setState((prev) => mapTab(prev, tabId, (tab) => {
            // 标题截 200 存：恶意页可下发任意长标题，全量进内存状态
            // （还会被 20 条快照写进 localStorage），先在这里收敛
            const next = title.trim().slice(0, 200) || getTitleFromUrl(tab.url);
            return next === tab.title ? tab : { ...tab, title: next };
        }));
    }, []);

    const setTabLoading = useCallback((tabId: string, isLoading: boolean) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            tab.isLoading === isLoading ? tab : { ...tab, isLoading }
        )));
    }, []);

    // 后退 / 前进：只置标志位，实际导航由 interactions 落到 webview API
    const goBack = useCallback((tabId: string) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            tab.historyIndex > 0 ? { ...tab, pendingNavigation: 'back', isLoading: true } : tab
        )));
    }, []);

    const goForward = useCallback((tabId: string) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            tab.historyIndex < tab.history.length - 1
                ? { ...tab, pendingNavigation: 'forward', isLoading: true }
                : tab
        )));
    }, []);

    const goHome = useCallback((tabId: string) => {
        setState((prev) => mapTab(prev, tabId, (tab) => ({
            ...tab, url: '', initialUrl: '', title: '新标签页',
            isLoading: false, history: [], historyIndex: -1,
            // 错误页与 favicon 必须一起清掉：不清的话回到首页后错误页还盖着，
            // 而 favicon 会留着上一个站点的图标
            error: null, crashed: false, favicon: '', audible: false,
        })));
    }, []);

    const reload = useCallback((tabId: string) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            // 同 URL 重载不会走 syncTabUrl 的"变地址清层"分支，错误/崩溃盖层
            // 必须在这里清，否则 F5 后新页面在盖层底下加载、用户以为刷新无效。
            // 重载再失败时 handleFail 会重新写回错误，不会丢信息。
            tab.url ? { ...tab, isLoading: true, error: null, crashed: false, reloadKey: (tab.reloadKey || 0) + 1 } : tab
        )));
    }, []);

    /**
     * 强制刷新（Ctrl+Shift+R）。
     *
     * 与 reload 分开记一个 key，而不是共用一个加标志位：两者落到 webview 上
     * 是**两个不同的 API**（reload / reloadIgnoringCache），用一个 effect
     * 分发时若标志位与 key 的更新顺序有偏差，就会偶发地走错那一个 ——
     * 表现为"强刷有时有效有时没有"。两个 key 各自独立递增，不会串。
     */
    const hardReload = useCallback((tabId: string) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            // 清层理由同 reload（两者走不同的 webview API，但盖层是同一套）
            tab.url
                ? { ...tab, isLoading: true, error: null, crashed: false, hardReloadKey: (tab.hardReloadKey || 0) + 1 }
                : tab
        )));
    }, []);

    const openInNewTab = useCallback((url: string) => {
        createTab(url);
    }, [createTab]);

    /**
     * 同步 URL（来自 webview 事件，不增加历史记录）。
     * 刻意不动 title：真实标题由 page-title-updated 事件负责，
     * 旧实现在这里把标题覆写成 hostname，导致标签页永远显示域名。
     */
    const syncTabUrl = useCallback((tabId: string, url: string, historyIndex?: number) => {
        setState((prev) => mapTab(prev, tabId, (tab) => {
            // 成功导航（did-navigate）必须清掉上一页的错误/崩溃态：
            // 后退/前进走的正是这条路，不清的话错误页会一直盖在新页面上。
            const cleared = url !== tab.url ? { error: null, crashed: false } : {};
            return {
                ...tab,
                ...cleared,
                url,
                historyIndex: historyIndex !== undefined ? historyIndex : tab.historyIndex,
            };
        }));
    }, []);

    const clearPendingNavigation = useCallback((tabId: string) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            tab.pendingNavigation ? { ...tab, pendingNavigation: undefined } : tab
        )));
    }, []);

    /* ------------------------- 浏览器外壳能力的状态 ------------------------- */

    /**
     * 下面这组 setter 都是**幂等 + 同值不换引用**的写法。
     *
     * 它们由 webview 事件驱动，而其中几个（favicon、audible、zoom）会在一次
     * 导航里被反复触发。每次都返回新对象的话，tabs 数组每帧都是新身份，
     * 下游所有依赖 tabs 的 useMemo/effect 全部重算 —— 页面一多就是持续掉帧，
     * 而且看不出是谁在改。
     */
    const setTabFavicon = useCallback((tabId: string, favicon: string) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            tab.favicon === favicon ? tab : { ...tab, favicon }
        )));
    }, []);

    const setTabError = useCallback((tabId: string, error: NavigationError | null) => {
        setState((prev) => mapTab(prev, tabId, (tab) => {
            // 同码同地址的错误不重复写入：did-fail-load 在重试时会连发多次，
            // 每次都换新对象会让下游所有依赖 tabs 的 memo/effect 每帧重算。
            if (tab.error === null && error === null) return tab;
            if (tab.error && error
                && tab.error.errorCode === error.errorCode
                && tab.error.raw === error.raw
                && tab.error.host === error.host) return tab;
            return { ...tab, error };
        }));
    }, []);

    const setTabCrashed = useCallback((tabId: string, crashed: boolean) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            tab.crashed === crashed ? tab : { ...tab, crashed }
        )));
    }, []);

    const setTabAudible = useCallback((tabId: string, audible: boolean) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            tab.audible === audible ? tab : { ...tab, audible }
        )));
    }, []);

    const setTabMuted = useCallback((tabId: string, muted: boolean) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            tab.muted === muted ? tab : { ...tab, muted }
        )));
    }, []);

    const setTabZoom = useCallback((tabId: string, zoomLevel: number) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            tab.zoomLevel === zoomLevel ? tab : { ...tab, zoomLevel }
        )));
    }, []);

    /**
     * 恢复最近关闭的标签页（Ctrl+Shift+T）。
     *
     * 只记**最近若干条**，且只记可重建的 url/title —— webview 里的滚动位置、
     * 表单内容、SPA 内部状态都不在恢复范围内。这是"重开那个页面"，
     * 不是"回到那个页面当时的样子"，界面上也不该暗示后者。
     *
     * 空白页不进栈：用户关掉一个刚开的空白页，再按 Ctrl+Shift+T 期待的是
     * 上一个**真实页面**，而不是又把空白页开回来。
     */
    const reopenClosedTab = useCallback((): boolean => {
        const entry = closedStackRef.current.pop();
        if (!entry) return false;
        const newTab = makeTab(entry.url, entry.title);
        setState((prev) => ({ tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
        return true;
    }, []);

    const actions = useMemo(() => ({
        createTab, closeTab, switchTab, navigateTab, updateTabTitle, setTabLoading,
        goBack, goForward, goHome, reload, hardReload, openInNewTab, syncTabUrl, clearPendingNavigation,
        setTabFavicon, setTabError, setTabCrashed, setTabAudible, setTabMuted, setTabZoom,
        reopenClosedTab,
    }), [
        createTab, closeTab, switchTab, navigateTab, updateTabTitle, setTabLoading,
        goBack, goForward, goHome, reload, hardReload, openInNewTab, syncTabUrl, clearPendingNavigation,
        setTabFavicon, setTabError, setTabCrashed, setTabAudible, setTabMuted, setTabZoom,
        reopenClosedTab,
    ]);

    return useMemo(() => ({ tabs, activeTabId, activeTab, actions }), [tabs, activeTabId, activeTab, actions]);
};

/* -------------------------------------------------------------------------- */
/*                               内部：书签                                     */
/* -------------------------------------------------------------------------- */

/**
 * 初始化：读取书签树。
 *
 * 三级回退，顺序不能换：
 *   1. v2 的树 —— 正常路径；
 *   2. v1 的扁平数组 —— **迁移**进「收藏夹栏」而不是丢弃。老用户升级后
 *      看到的是"书签都还在"，而不是"升级完书签没了"；
 *   3. 空的默认树 —— 只在两者都没有时（首次启动）。
 *
 * 第 3 档给的是**空**树而不是几个预置网址：预置等于替用户决定他该收藏什么。
 * 首次启动的书签栏本就是空的，用户要的是「从 Edge 导入」。
 *
 * 放在 lazy initializer 而不是 effect 里：用 effect 会先渲染一帧空列表再填上。
 */
const loadStoredBookmarks = (): BookmarkTree => {
    try {
        const savedTree = loadStr(BOOKMARK_TREE_STORE_KEY, '', '');
        if (savedTree) {
            const parsed: unknown = JSON.parse(savedTree);
            if (parsed && typeof parsed === 'object') {
                return normalizeTree(parsed, generateId);
            }
        }

        const savedFlat = loadStr(BOOKMARKS_STORE_KEY, '', '');
        if (savedFlat) {
            const parsedFlat: unknown = JSON.parse(savedFlat);
            if (Array.isArray(parsedFlat)) {
                const migrated = migrateFlatBookmarks(parsedFlat, generateId);
                // 立刻落盘成 v2，避免每次启动都重跑迁移（迁移会给节点换新 id）
                saveStr(BOOKMARK_TREE_STORE_KEY, JSON.stringify(migrated), '');
                return migrated;
            }
        }
    } catch (e) {
        console.error('加载书签失败:', e);
    }
    const defaults = makeDefaultTree();
    saveStr(BOOKMARK_TREE_STORE_KEY, JSON.stringify(defaults), '');
    return defaults;
};

/** 读收藏夹栏显示策略（默认与 Edge/Chrome 出厂一致：仅新标签页） */
const loadBarVisibility = (): BookmarkBarVisibility => {
    const saved = loadStr(BOOKMARK_BAR_STORE_KEY, '', '');
    return saved === 'always' || saved === 'never' ? saved : 'newTab';
};

/**
 * 把树按节点数收敛到上限。
 *
 * 超限时**从收藏夹栏的末尾往前删**（保留最新的），并且先把「其他收藏夹」
 * 整块保留 —— 那是用户明确归类过的内容，比栏上的随手收藏更该留下。
 * 上限原本只在读回侧生效，内存态与磁盘态可以无限增长，配额爆掉后 saveStr
 * 静默返回 false —— 表现为"收藏了但没存住"。
 */
const trimTree = (tree: BookmarkTree): BookmarkTree => {
    let total = flattenUrls(tree.bar).length + flattenUrls(tree.other).length;
    if (total <= BOOKMARKS_MAX) return tree;

    const bar = tree.bar;
    const children = [...(bar.children || [])];
    const otherCount = flattenUrls(tree.other).length;
    let budget = Math.max(0, BOOKMARKS_MAX - otherCount);

    // 从后往前删 url 节点，文件夹整块保留（删半个文件夹比删几条更糟）
    for (let i = children.length - 1; i >= 0 && budget >= 0; i -= 1) {
        const child = children[i];
        if (child.type !== 'url') continue;
        if (budget > 0) { budget -= 1; continue; }
        children.splice(i, 1);
    }
    return { bar: { ...bar, children }, other: tree.other };
};

const useBookmarks = (): BookmarksState => {
    const [tree, setTree] = useState<BookmarkTree>(loadStoredBookmarks);
    const [barVisibility, setBarVisibilityState] = useState<BookmarkBarVisibility>(loadBarVisibility);

    /**
     * 落盘：写收敛后的树，不读回。
     * 所有变更走函数式更新 —— 基于闭包快照计算会在连点两次时把前一次覆盖掉。
     */
    useEffect(() => {
        saveStr(BOOKMARK_TREE_STORE_KEY, JSON.stringify(trimTree(tree)), '');
    }, [tree]);

    useEffect(() => {
        saveStr(BOOKMARK_BAR_STORE_KEY, barVisibility, '');
    }, [barVisibility]);

    const setBarVisibility = useCallback((value: BookmarkBarVisibility) => {
        setBarVisibilityState(value);
    }, []);

    /**
     * 「是否已收藏」的判据源。
     *
     * 用 collectUrls 建集合，而不是遍历上面那份平铺数组 —— 判据只此一处，
     * 星标亮不亮与收藏夹里有没有它必然一致。
     */
    const urlSet = useMemo(() => collectUrls(tree), [tree]);

    const isBookmarked = useCallback((url: string) => urlSet.has(url), [urlSet]);

    /** 切换收藏状态：已存在则从树上摘掉，不存在则追加到收藏夹栏末尾 */
    const toggleBookmark = useCallback((url: string, title: string = '新书签') => {
        if (!url) return;
        let finalTitle = title;
        try {
            if (!title || title === '新书签') finalTitle = new URL(url).hostname;
        } catch { /* 非法 URL 保留传入标题 */ }

        setTree((prev) => {
            const existing = flattenUrls(prev.bar).find((e) => e.node.url === url)
                || flattenUrls(prev.other).find((e) => e.node.url === url);
            if (existing) {
                const inBar = findNode(prev.bar, existing.node.id);
                return inBar
                    ? { bar: removeNode(prev.bar, existing.node.id), other: prev.other }
                    : { bar: prev.bar, other: removeNode(prev.other, existing.node.id) };
            }
            const node = makeUrlNode(generateId(), url, finalTitle);
            return { bar: insertNode(prev.bar, prev.bar.id, node), other: prev.other };
        });
    }, []);

    /** 删除节点。根节点不允许删（界面上也不会给出入口） */
    const removeBookmark = useCallback((id: string) => {
        setTree((prev) => {
            if (id === prev.bar.id || id === prev.other.id) return prev;
            const inBar = findNode(prev.bar, id);
            return inBar
                ? { bar: removeNode(prev.bar, id), other: prev.other }
                : { bar: prev.bar, other: removeNode(prev.other, id) };
        });
    }, []);

    /** 新建文件夹，返回新 id（找不到父节点时返回空串） */
    const addFolder = useCallback((parentId: string, title: string): string => {
        const id = generateId();
        setTree((prev) => {
            const node = makeFolder(id, title.trim() || '新建文件夹');
            const inBar = findNode(prev.bar, parentId);
            return inBar
                ? { bar: insertNode(prev.bar, parentId, node), other: prev.other }
                : { bar: prev.bar, other: insertNode(prev.other, parentId, node) };
        });
        return id;
    }, []);

    const renameNode = useCallback((id: string, title: string) => {
        const clean = title.trim();
        if (!clean) return;
        setTree((prev) => ({
            bar: replaceNode(prev.bar, id, (node) => ({ ...node, title: clean })),
            other: replaceNode(prev.other, id, (node) => ({ ...node, title: clean })),
        }));
    }, []);

    const updateNodeUrl = useCallback((id: string, url: string) => {
        const clean = url.trim();
        if (!clean) return;
        setTree((prev) => ({
            bar: replaceNode(prev.bar, id, (node) => (node.type === 'url' ? { ...node, url: clean } : node)),
            other: replaceNode(prev.other, id, (node) => (node.type === 'url' ? { ...node, url: clean } : node)),
        }));
    }, []);

    const moveBookmark = useCallback((id: string, targetFolderId: string, index?: number) => {
        setTree((prev) => moveNode(prev, id, targetFolderId, index));
    }, []);

    /**
     * 合并导入的书签。
     *
     * 去重集合从**当前树**现算，而不是闭包里的旧值 —— 连续导入两次时，
     * 第二次必须看得见第一次插进去的 url，否则会重复一份。
     */
    const mergeImported = useCallback((target: 'bar' | 'other', nodes: BookmarkNode[]): MergeStats => {
        const stats: MergeStats = { added: 0, skipped: 0 };
        setTree((prev) => {
            const seen = collectUrls(prev);
            const folder = target === 'bar' ? prev.bar : prev.other;
            const merged = mergeIntoFolder(folder, nodes, seen, generateId);
            stats.added = merged.stats.added;
            stats.skipped = merged.stats.skipped;
            return target === 'bar'
                ? { bar: merged.folder, other: prev.other }
                : { bar: prev.bar, other: merged.folder };
        });
        return stats;
    }, []);

    const clearRoot = useCallback((target: 'bar' | 'other') => {
        setTree((prev) => target === 'bar'
            ? { bar: { ...prev.bar, children: [] }, other: prev.other }
            : { bar: prev.bar, other: { ...prev.other, children: [] } });
    }, []);

    return useMemo(
        () => ({
            tree, barVisibility, setBarVisibility,
            isBookmarked, toggleBookmark, removeBookmark,
            addFolder, renameNode, updateNodeUrl, moveBookmark, mergeImported, clearRoot,
        }),
        [
            tree, barVisibility, setBarVisibility,
            isBookmarked, toggleBookmark, removeBookmark,
            addFolder, renameNode, updateNodeUrl, moveBookmark, mergeImported, clearRoot,
        ]
    );
};

/* -------------------------------------------------------------------------- */
/*                             内部：搜索引擎                                   */
/* -------------------------------------------------------------------------- */

const useSearch = (): SearchState => {
    // 落盘：旧实现只存在 state 里，重启即回默认，选择器等于摆设
    const [engine, setEngineState] = useState<SearchEngine>(() => {
        const saved = loadJSON<string>(SEARCH_ENGINE_STORE_KEY, DEFAULT_ENGINE);
        return SEARCH_ENGINES.includes(saved as SearchEngine) ? (saved as SearchEngine) : DEFAULT_ENGINE;
    });

    const setEngine = useCallback((next: SearchEngine) => {
        if (!SEARCH_ENGINES.includes(next)) return;
        setEngineState(next);
        saveJSON(SEARCH_ENGINE_STORE_KEY, next);
    }, []);

    /**
     * 解析用户输入：
     * 1. 空 → 空串
     * 2. 像 URL（带安全协议 / localhost / IPv4 / 裸域名）→ 补全协议后返回
     * 3. 否则视为搜索关键词，拼搜索引擎地址
     */
    const parseInputToUrl = useCallback((input: string): string => (
        // 判据实现在 services/BrowserService（可单测），这里只喂当前引擎前缀
        resolveInputUrl(input, ENGINE_URLS[engine])
    ), [engine]);

    return useMemo(() => ({ engine, setEngine, parseInputToUrl }), [engine, setEngine, parseInputToUrl]);
};

/* -------------------------------------------------------------------------- */
/*                             内部：交互与导航                                 */
/* -------------------------------------------------------------------------- */

interface InteractionDeps {
    tabs: TabsState;
    search: SearchState;
    bookmarks: BookmarksState;
}

const useInteractions = (deps: InteractionDeps): InteractionsState => {
    const { tabs: tabsState, search, bookmarks } = deps;
    const { activeTab, activeTabId, actions: tabActions } = tabsState;
    const { parseInputToUrl } = search;
    const { isBookmarked } = bookmarks;

    const [inputUrl, setInputUrl] = useState('');
    /**
     * 地址栏是否正在被编辑。
     * 用 ref 而非 state：只给"要不要跟随"这一个判断读，不必触发重渲染。
     */
    const inputFocusedRef = useRef(false);
    const setInputFocused = useCallback((focused: boolean) => {
        inputFocusedRef.current = focused;
    }, []);
    /**
     * 地址栏连击去重：非空白页每次提交都开新标签，连按两次回车
     * （或回车+鼠标连点"转到"）会开出两个同 URL 标签。1 秒内同地址
     * 只认第一次 —— 正常人不会在 1 秒内故意开两个相同页。
     */
    const lastSubmitRef = useRef<{ url: string; time: number }>({ url: '', time: 0 });

    // DOM 引用（不要用 state 存 webview，会触发 React DevTools 跨域错误）
    const webviewRefs = useRef<Map<string, WebviewElement>>(new Map());
    // webview 是否已 ready（dom-ready 之后才能安全调用 API）
    const webviewReadyRefs = useRef<Set<string>>(new Set());
    // 刷新请求的上一轮 reloadKey
    const prevReloadKeys = useRef<Record<string, number>>({});
    // 强制刷新的上一轮 hardReloadKey。与 reloadKey 分开记账，理由见 8b 的 effect
    const prevHardReloadKeys = useRef<Record<string, number>>({});
    // 正在进行的前进后退（did-navigate 时据此判断要不要新增历史）
    const pendingHistoryNav = useRef<Map<string, 'back' | 'forward'>>(new Map());
    // webview 尚未 ready 时暂存的待导航地址
    const pendingNavigations = useRef<Map<string, string>>(new Map());
    // 「页面就绪」订阅者（篡改引擎的注入挂在这里）
    const pageReadyListeners = useRef<Set<(tabId: string, webview: WebviewElement) => void>>(new Set());
    // 每个标签页上一次广播时的 URL：SPA 的 in-page 导航据此去重，
    // 否则脚本自己点击链接 → 导航 → 再触发脚本，会形成回环
    const lastPageReadyUrl = useRef<Map<string, string>>(new Map());
    /**
     * 查找结果的接收器。
     *
     * 走 ref 而不是把 setState 直接塞进 attachWebviewListeners：那个回调
     * 只在 webview 挂载时执行一次并缓存在闭包上，一旦把 state setter 编进
     * 依赖，`__listenersAttached` 标记会让新的 setter **永远不生效** ——
     * 症状是查找匹配数一直不更新，而查找条本身看起来完全正常。
     * ref 转发让闭包永远指向最新实现，且不必重挂监听。
     */
    const findReporterRef = useRef<((tabId: string, info: FindInfo) => void) | null>(null);
    /**
     * 浏览器动作分发器。
     *
     * 订阅只建立一次（见下方 7b），而实现每次渲染刷新一次 —— 因为分发的每个
     * 分支都要读**最新**的 tabs / activeTabId / 各个回调。用 ref 转发而不是
     * 把一堆依赖塞进订阅：那样每切一次标签就重订阅一次，两次订阅之间的
     * 窗口期里按下的键会被丢掉，表现为"偶尔按了没反应"。
     *
     * 赋值放在文件后段（所有回调定义完之后）、无依赖的 effect 里。
     */
    const browserActionRef = useRef<(command: BrowserCommand) => void>(() => { });
    /**
     * 只属于界面层的浏览器动作（聚焦地址栏、让 Agent 分析元素）。
     *
     * 这两件事的真值在 BrowsePanel（它持有地址栏 input 的 ref 与 Agent 输入框），
     * useBrowse 无从下手，所以原样转发出去由面板订阅。
     */
    const uiActionListeners = useRef<Set<(command: BrowserCommand) => void>>(new Set());

    // 最新值镜像：事件回调里必须读到当前 tabs/activeTabId，而不是绑定时的快照。
    // 走 effect 而非渲染期赋值：并发渲染下被丢弃的那次渲染不应污染 ref。
    const tabsRef = useRef(tabsState.tabs);
    useEffect(() => { tabsRef.current = tabsState.tabs; }, [tabsState.tabs]);
    const activeTabIdRef = useRef(activeTabId);
    useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

    /**
     * 1. 地址栏跟随当前标签页 —— 但**不能**在用户正编辑时跟随。
     *
     * 原实现无条件 `setInputUrl(activeTab.url)`，而 activeTab.url 在 SPA 站点上
     * 每次 pushState / hash 变化都会变（did-navigate-in-page → syncFromWebview）。
     * 于是：用户点进地址栏开始敲新地址 → 页面自己路由跳了一下 → 输入被覆盖成
     * 当前页地址。用户看到的是一串自己没打过的字符，回车就跳错地方。
     *
     * 判据抽成纯函数（可单测），状态用 ref 而非 state：
     * 这里只需要"此刻是否聚焦"这一个事实，用 state 会让每次聚焦/失焦都重渲染整个面板。
     */
    useEffect(() => {
        if (!shouldAddressBarFollow(inputFocusedRef.current)) return;
        setInputUrl(activeTab.url);
    }, [activeTab.url, activeTabId]);

    // 2. 标签页 URL 变化 → 同步到 webview（避免靠 src 属性重渲染导致整页重载）
    useEffect(() => {
        tabsState.tabs.forEach((tab) => {
            const webview = webviewRefs.current.get(tab.id);
            const isReady = webviewReadyRefs.current.has(tab.id);

            if (!tab.url) return;

            if (webview && isReady) {
                if (!hasWebviewFn(webview, 'loadURL')) {
                    pendingNavigations.current.delete(tab.id);
                    return;
                }
                try {
                    // 不做基于索引的 goBack/goForward 优化：React 状态与 webview 内部
                    // 历史栈不一致时会出现"地址变了但页面没变"，强制对齐两者。
                    const currentSrc = webview.getURL?.() || '';
                    const normalize = (u: string) => u.replace(/\/$/, '');
                    if (normalize(currentSrc) !== normalize(tab.url)) {
                        void webview.loadURL(tab.url);
                    }
                    pendingNavigations.current.delete(tab.id);
                } catch (e) {
                    console.error('Failed to navigate webview:', e);
                }
            } else if (webview) {
                pendingNavigations.current.set(tab.id, tab.url);
            }
        });
    }, [tabsState.tabs]);

    // 3. 核心导航：空白页就地跳转，已有内容则开新标签页
    const handleNavigate = useCallback((urlOrQuery: string) => {
        const finalUrl = parseInputToUrl(urlOrQuery);
        if (!finalUrl) return;

        const now = Date.now();
        if (finalUrl === lastSubmitRef.current.url && now - lastSubmitRef.current.time < 1000) return;
        lastSubmitRef.current = { url: finalUrl, time: now };

        const currentActiveId = activeTabIdRef.current;
        const currentTab = tabsRef.current.find((t) => t.id === currentActiveId);

        if (currentTab && !currentTab.url) {
            tabActions.navigateTab(currentActiveId, finalUrl);
            setInputUrl(finalUrl);
        } else {
            tabActions.openInNewTab(finalUrl);
        }
    }, [parseInputToUrl, tabActions]);

    const handleOpenInNewTab = useCallback((url: string) => {
        const finalUrl = parseInputToUrl(url);
        if (finalUrl) tabActions.openInNewTab(finalUrl);
    }, [parseInputToUrl, tabActions]);

    // 5. 绑定 webview 事件
    const attachWebviewListeners = useCallback((tabId: string, webview: WebviewElement) => {
        if ((webview as any).__listenersAttached) return;

        /**
         * 页面就绪广播。
         *
         * 放在 dom-ready 而不是 registerWebview：
         *  - registerWebview 是 ref 回调，触发时 webview 尚未附加，executeJavaScript 必抛；
         *  - dom-ready 每次导航都会重来一次，换页后的重新注入天然被覆盖，
         *    不需要调用方自己再挂一套监听（那样在 webview 未挂载时会丢，且切标签页后仍绑旧页）。
         * 订阅者出错不能拖垮导航本身，因此逐个隔离。
         *
         * url 传入时记入去重表，供 SPA 的 in-page 导航判断是否需要补发。
         */
        const broadcastPageReady = (id: string, target: WebviewElement, url?: string) => {
            const current = url || readWebviewUrlSafe(target);
            if (current) lastPageReadyUrl.current.set(id, current);

            pageReadyListeners.current.forEach((cb) => {
                try { cb(id, target); } catch (e) { console.error('pageReady listener failed:', e); }
            });
        };

        const handleDomReady = () => {
            webviewReadyRefs.current.add(tabId);
            tabActions.setTabLoading(tabId, false);

            // webview 是原生标签：挂载前经 zoomBy/toggleMute 改的只是 React 状态，
            // 此刻把它们补到真实页面上，否则"没加载完就按 Ctrl+±/点静音"会静默丢失。
            try {
                const current = tabsRef.current.find((t) => t.id === tabId);
                if (current) {
                    // 持久化快照可能带非法有限值（如旧版本写入的 100）：zoomBy 路径
                    // 有 nextZoomLevel 夹取，这里直接应用会算出天文数字 factor。
                    // NaN/Infinity 由 zoomLevelToFactor 兜底为 0。
                    if (current.zoomLevel) {
                        const clamped = Math.min(ZOOM_MAX_LEVEL, Math.max(ZOOM_MIN_LEVEL, current.zoomLevel));
                        webview.setZoomFactor?.(zoomLevelToFactor(clamped));
                    }
                    if (current.muted) webview.setAudioMuted?.(true);
                }
            } catch { /* webview 已卸载 */ }

            broadcastPageReady(tabId, webview);

            const pendingUrl = pendingNavigations.current.get(tabId);
            if (pendingUrl) {
                if (!hasWebviewFn(webview, 'loadURL')) {
                    pendingNavigations.current.delete(tabId);
                } else try {
                    if (webview.getURL?.() !== pendingUrl) void webview.loadURL(pendingUrl);
                    pendingNavigations.current.delete(tabId);
                } catch (e) {
                    console.error('Failed to navigate pending URL:', e);
                }
            }
        };

        const handleFinish = () => tabActions.setTabLoading(tabId, false);

        /**
         * 导航失败。
         *
         * 旧实现是 `() => setTabLoading(tabId, false)` —— 把 errorCode、
         * errorDescription、validatedURL **全部丢掉**。用户看到的是白屏，
         * 不知道是断网、DNS 错、证书过期还是站点下线，也无从下手。
         *
         * 归类判据在 services/BrowserService（纯 TS，可单测），这里只负责
         * 把事件字段喂进去 —— 不重复实现一份错误码表，两份必然漂移。
         */
        const handleFail = (e: Event) => {
            tabActions.setTabLoading(tabId, false);
            // 回退/前进失败（或压根没走成）时历史标记必须清掉：
            // 它只在 did-navigate 成功路径被消费，留着的话下一次普通导航
            // 会被误记成"后退/前进"，historyIndex 从此错乱。
            pendingHistoryNav.current.delete(tabId);

            const detail = e as Event & {
                errorCode?: number;
                errorDescription?: string;
                validatedURL?: string;
                isMainFrame?: boolean;
            };
            // 只对**主框架**的、非 ERR_ABORTED 的失败显示错误页。
            // 子框架（广告 iframe）挂了不该让整页变错误页；而 -3（ERR_ABORTED）
            // 是正常导航（重定向、点下载、SPA 换页）都会抛的，不过滤的话
            // 每次点下载链接都会闪一下错误页。
            if (!shouldShowNavigationError(detail.errorCode ?? 0, detail.isMainFrame !== false)) return;

            tabActions.setTabError(tabId, classifyNavigationError(
                detail.errorCode ?? 0,
                detail.errorDescription || '',
                detail.validatedURL || '',
            ));
        };

        // 渲染进程崩溃（OOM、内核 bug）。与加载失败分开：那个能重试，这个只能重载
        const handleGone = () => {
            tabActions.setTabLoading(tabId, false);
            tabActions.setTabCrashed(tabId, true);
        };

        // 真实标题（旧实现从未监听，标签页因此永远显示域名）
        const handleTitle = (e: Event) => {
            const title = (e as Event & { title?: string }).title;
            if (title) tabActions.updateTabTitle(tabId, title);
        };

        /**
         * 真实 favicon。
         *
         * 取**最后一个**候选而不是第一个：站点的 favicons 数组常常是
         * [高清 png, svg, ico] 或反过来，而 Chromium 把"最终选中的那个"
         * 放在末尾。取第一个实测会拿到 404 的旧路径。
         *
         * 拿不到就留空 —— 界面回落到 hostname 取色块（SiteTile），
         * 那是"没有图标时的占位"，不是失败。
         */
        const handleFavicon = (e: Event) => {
            const list = (e as Event & { favicons?: string[] }).favicons;
            if (!Array.isArray(list) || list.length === 0) return;
            tabActions.setTabFavicon(tabId, String(list[list.length - 1] || ''));
        };

        // 页面内查找结果。webview 的 findInPage **没有同步返回值**，
        // 只能靠这个事件拿匹配数 —— 漏了它，查找条永远显示"0/0"
        const handleFoundInPage = (e: Event) => {
            const result = (e as Event & {
                result?: { matches?: number; activeMatchOrdinal?: number; finalUpdate?: boolean };
            }).result;
            if (!result) return;
            findReporterRef.current?.(tabId, {
                matches: Number(result.matches) || 0,
                active: Number(result.activeMatchOrdinal) || 0,
            });
        };

        // 页内原生缩放回写：用户在页面里 Ctrl+滚轮走的是 Chromium 原生缩放，
        // 不经过命令通道（zoomBy）。不同步的话地址栏百分比指示过期，
        // 且下一次 Ctrl+加号会按过期基准直接跳变。
        // 读 guest 当前 factor 而不是事件载荷：载荷形状各版本不一致，
        // factor 才是两个方向换算的同一底数。
        const handleZoomChanged = () => {
            try {
                const factor = webview.getZoomFactor();
                if (Number.isFinite(factor)) tabActions.setTabZoom(tabId, zoomFactorToLevel(factor));
            } catch { /* guest 已卸载 */ }
        };

        const syncFromWebview = (url: string) => {
            const currentTab = tabsRef.current.find((t) => t.id === tabId);
            if (!url || !currentTab || url === currentTab.url) return;

            const historyNavType = pendingHistoryNav.current.get(tabId);
            if (historyNavType) {
                const newIndex = historyNavType === 'back'
                    ? Math.max(0, currentTab.historyIndex - 1)
                    : Math.min(currentTab.history.length - 1, currentTab.historyIndex + 1);
                tabActions.syncTabUrl(tabId, url, newIndex);
                pendingHistoryNav.current.delete(tabId);
                return;
            }
            // 普通导航（用户点击链接）：记入历史。
            // did-navigate 在一次提交后只触发一次（302 链不单独提交），
            // 因此这里不需要为重定向去重 —— 多加一层标记反而会让重定向后的
            // 页面不进历史，后退键直接失效。
            //
            // keepTitle：真实标题由 page-title-updated 事件负责，这里不能先写成
            // hostname，否则每次点链接标题都会闪一下域名再被纠正回来。
            tabActions.navigateTab(tabId, url, false, true);
        };

        const handleNavigateInternal = (e: Event) => {
            syncFromWebview((e as Event & { url?: string }).url || '');
        };
        const handleInPageNavigate = (e: Event) => {
            const url = (e as Event & { url?: string }).url || '';
            syncFromWebview(url);
            // SPA 内部路由切换（history.pushState / hash 变化）不触发 dom-ready，
            // 只走 did-navigate-in-page。依赖"页面就绪"的下游（篡改引擎、Agent 的
            // urlPattern 脚本）如果不在这里补一次广播，对 SPA 站点就永远不生效。
            //
            // 按 URL 去重：脚本自身点击链接会引发新的 in-page 导航，
            // 不去重会形成"脚本→导航→脚本"的回环。
            if (url && lastPageReadyUrl.current.get(tabId) !== url) {
                broadcastPageReady(tabId, webview, url);
            }
        };

        webview.addEventListener('dom-ready', handleDomReady);
        webview.addEventListener('did-finish-load', handleFinish);
        webview.addEventListener('did-fail-load', handleFail);
        webview.addEventListener('page-title-updated', handleTitle);
        webview.addEventListener('page-favicon-updated', handleFavicon);
        webview.addEventListener('found-in-page', handleFoundInPage);
        webview.addEventListener('zoom-changed', handleZoomChanged);
        webview.addEventListener('render-process-gone', handleGone);
        webview.addEventListener('did-navigate', handleNavigateInternal);
        webview.addEventListener('did-navigate-in-page', handleInPageNavigate);
        // 注意：不再监听 'new-window'。Electron 44 的 <webview> 已移除该事件，
        // 新窗口统一由主进程 setWindowOpenHandler → navigate-to-url IPC 处理。
        //
        // 也不监听 'audio-state-changed'：<webview> **元素上没有这个事件**
        // （元素只有 media-started-playing / media-paused，而那两个判不出
        // "静音的视频"与"有声的视频"）。发声状态由主进程经 browser-command 推。

        (webview as any).__listenersAttached = true;
    }, [tabActions]);

    // 6. 注册 / 注销 webview 引用
    const registerWebview = useCallback((id: string, el: WebviewElement | null) => {
        if (el) {
            webviewRefs.current.set(id, el);
            attachWebviewListeners(id, el);
            // 挂载时可能已经 ready（事件早于监听绑定），补一次探测
            window.setTimeout(() => {
                try {
                    // 100ms 内标签已关闭会走 null 分支清掉 ready；这里再按身份
                    // 确认一次，否则超时回调会给已删的 id 写回一条 stale 标记
                    if (webviewRefs.current.get(id) === el && el.getURL?.()) {
                        webviewReadyRefs.current.add(id);
                    }
                } catch { /* webview 已卸载 */ }
            }, 100);
            return;
        }
        webviewRefs.current.delete(id);
        webviewReadyRefs.current.delete(id);
        // 关闭标签页后清理该页暂存状态，避免残留导致误导航
        pendingNavigations.current.delete(id);
        pendingHistoryNav.current.delete(id);
        lastPageReadyUrl.current.delete(id);
        delete prevReloadKeys.current[id];
        delete prevHardReloadKeys.current[id];
    }, [attachWebviewListeners]);

    /**
     * webview 的 ref 回调必须按 tab 缓存成**稳定身份**。
     *
     * React 在 `current.ref !== ref` 时会在每次提交先以 null 调旧 ref、再以元素调新 ref
     * （react-dom 的 markRef：`null === current || current.ref !== ref` 即打 Ref flag）。
     * 内联箭头函数每次渲染都是新身份，于是每渲染都走一遍 registerWebview(id, null)，
     * 而它负责清理 ready 标记 / 刷新记账 / 待导航：
     *   - prevReloadKeys 被抹 → 刷新 effect 把同一个 reloadKey 当成新请求，每次渲染重载一次页面；
     *   - webviewReadyRefs 被抹 → 导航被塞进 pendingNavigations，但 dom-ready 早已触发过
     *     不会再来，地址栏换地址因此静默失效。
     * 回调经 ref 转发，所以 registerWebview 重建也不会让缓存失效。
     */
    const registerWebviewRef = useRef(registerWebview);
    useEffect(() => { registerWebviewRef.current = registerWebview; }, [registerWebview]);

    const webviewRefCallbacks = useRef<Map<string, (el: WebviewElement | null) => void>>(new Map());

    const getWebviewRef = useCallback((tabId: string) => {
        let callback = webviewRefCallbacks.current.get(tabId);
        if (!callback) {
            callback = (el) => registerWebviewRef.current(tabId, el);
            webviewRefCallbacks.current.set(tabId, callback);
        }
        return callback;
    }, []);

    // 标签页关掉后回收其回调，避免 Map 随会话无限增长
    useEffect(() => {
        const live = new Set(tabsState.tabs.map((t) => t.id));
        for (const id of webviewRefCallbacks.current.keys()) {
            if (!live.has(id)) webviewRefCallbacks.current.delete(id);
        }
    }, [tabsState.tabs]);

    // 7. 主进程发来的"新窗口打开"请求。
    // 经 ref 转发：handleOpenInNewTab 依赖 tabActions，若直接进 deps 会每次渲染都重订阅；
    // 且卸载时用 subscribe 返回的退订函数，不再 removeAllListeners（会误杀他人监听）。
    const openInNewTabRef = useRef(handleOpenInNewTab);
    useEffect(() => { openInNewTabRef.current = handleOpenInNewTab; }, [handleOpenInNewTab]);

    useEffect(() => {
        const electronAPI = getElectronAPI();
        if (!electronAPI?.onNavigateToUrl) return;
        const unsubscribe = electronAPI.onNavigateToUrl((url: string) => {
            if (url) openInNewTabRef.current(url);
        });
        return typeof unsubscribe === 'function' ? unsubscribe : undefined;
    }, []);

    /**
     * 7b. 主进程下发的浏览器动作（快捷键、右键菜单、发声状态）。
     *
     * **方向是反的**：键盘事件只有主进程收得到（webview 是跨进程 OOPIF，
     * 键盘/滚轮不冒泡到宿主页面的 window），所以由主进程判出"这是哪个浏览器
     * 动作"再发过来；渲染层在这里执行 —— 因为标签页状态与 webview 引用
     * 都只在这里。
     *
     * 订阅**只建立一次**（依赖为空），而分发实现每渲染刷新一次
     * （browserActionRef 在文件下方无依赖的 effect 里重新赋值）。
     * 若把 tabs 放进订阅依赖，每切一次标签就重订阅一次，两次订阅之间的
     * 窗口期里按下的键会被丢掉 —— 表现为"偶尔按了没反应"。
     */
    useEffect(() => {
        const electronAPI = getElectronAPI();
        if (!electronAPI?.browser?.onCommand) return;
        const unsubscribe = electronAPI.browser.onCommand((command: BrowserCommand) => {
            if (command && command.action) browserActionRef.current(command);
        });
        return typeof unsubscribe === 'function' ? unsubscribe : undefined;
    }, []);

    // 8. 刷新请求
    useEffect(() => {
        tabsState.tabs.forEach((tab) => {
            const prev = prevReloadKeys.current[tab.id] || 0;
            if (tab.reloadKey <= prev) return;
            prevReloadKeys.current[tab.id] = tab.reloadKey;

            const webview = webviewRefs.current.get(tab.id);
            if (webview) {
                if (!hasWebviewFn(webview, 'reload')) return;
                try { webview.reload(); } catch (e) { console.error(e); }
            }
        });
    }, [tabsState.tabs]);

    /**
     * 8b. 强制刷新（Ctrl+Shift+R / Ctrl+F5）。
     *
     * 单独一个 effect + 单独的 key，而不是在 8 里读一个布尔标志：
     * 标志与 key 在同一次 setState 里更新时，"先看标志再看 key"这个顺序
     * 依赖 React 的批处理细节，而**两个 key 各自独立递增不依赖任何顺序**。
     * 走错那一个的症状是"强刷有时有效有时没有"，很难复现。
     */
    useEffect(() => {
        tabsState.tabs.forEach((tab) => {
            const prev = prevHardReloadKeys.current[tab.id] || 0;
            if (tab.hardReloadKey <= prev) return;
            prevHardReloadKeys.current[tab.id] = tab.hardReloadKey;

            const webview = webviewRefs.current.get(tab.id);
            if (webview) {
                if (!hasWebviewFn(webview, 'reloadIgnoringCache')) return;
                try { webview.reloadIgnoringCache(); } catch (e) { console.error(e); }
            }
        });
    }, [tabsState.tabs]);

    // 9. 前进 / 后退请求
    useEffect(() => {
        tabsState.tabs.forEach((tab) => {
            if (!tab.pendingNavigation) return;
            const webview = webviewRefs.current.get(tab.id);

            if (webview && webviewReadyRefs.current.has(tab.id)) {
                // 非 Electron 下这些方法不存在：静默收尾而不是抛 TypeError 刷日志。
                // canGoBack/canGoForward 缺失时按"不能走"处理，与"走不动"同一分支。
                if (!hasWebviewFn(webview, 'canGoBack') || !hasWebviewFn(webview, 'canGoForward')
                    || !hasWebviewFn(webview, 'goBack') || !hasWebviewFn(webview, 'goForward')) {
                    pendingHistoryNav.current.delete(tab.id);
                    tabActions.clearPendingNavigation(tab.id);
                    tabActions.setTabLoading(tab.id, false);
                    return;
                }
                try {
                    // webview 实际走不动时 goBack/goForward 是静默空操作
                    // （无任何事件），pendingHistoryNav 会残留并污染下一次
                    // 普通导航。先问能不能走，不能走就地清掉。
                    const canGo = tab.pendingNavigation === 'back'
                        ? webview.canGoBack()
                        : webview.canGoForward();
                    if (!canGo) {
                        pendingHistoryNav.current.delete(tab.id);
                        tabActions.clearPendingNavigation(tab.id);
                        tabActions.setTabLoading(tab.id, false);
                        return;
                    }
                    pendingHistoryNav.current.set(tab.id, tab.pendingNavigation);
                    if (tab.pendingNavigation === 'back') webview.goBack();
                    else webview.goForward();
                } catch (e) {
                    console.error('Failed to navigate webview:', e);
                    pendingHistoryNav.current.delete(tab.id);
                }
                tabActions.clearPendingNavigation(tab.id);
                return;
            }
            // 非 Electron 环境或 webview 未就绪：清标记并结束加载
            tabActions.clearPendingNavigation(tab.id);
            tabActions.setTabLoading(tab.id, false);
        });
    }, [tabsState.tabs, tabActions]);

    const isCurrentPageBookmarked = isBookmarked(activeTab.url);

    /* ------------------------------ 页面能力 ------------------------------ */

    /**
     * 页面内查找。
     *
     * 查找词与结果都只跟**当前标签页**有关，但状态放在 interactions 而不是
     * 每个 Tab 上：Tab 是要落盘重建的（tabs 快照只存 url/title），把查找词
     * 放进去等于把一次性的界面状态写进持久化结构。
     *
     * 关闭时**必须**调 stopFindInPage('clearSelection')：不调的话页面上会
     * 一直留着上一次的高亮，用户以为还在查找中。
     */
    const [findQuery, setFindQueryState] = useState('');
    const [findInfo, setFindInfo] = useState<FindInfo>({ matches: 0, active: 0 });
    const findQueryRef = useRef('');
    /**
     * 查找条开合（与查找词分离）。
     *
     * 原先以 `findQuery !== ''` 兼任"开着"：Ctrl+F 下发 `find` 时只能
     * setFindQuery('')，结果是"按 Ctrl+F 反而把查找条关掉"，从没打开过。
     * 开合单独记一笔：有词必开着，无词时可能是"开着等输入"（刚按 Ctrl+F）。
     */
    const [findOpen, setFindOpenState] = useState(false);
    const findOpenRef = useRef(false);

    useEffect(() => {
        findReporterRef.current = (tabId, info) => {
            // 只接收**当前标签页**的结果：后台标签页的查找事件也会推过来，
            // 不筛的话切页后查找条显示的是另一个页面的匹配数
            if (tabId !== activeTabIdRef.current) return;
            setFindInfo(info);
        };
        return () => { findReporterRef.current = null; };
    }, []);

    const findInPage = useCallback((tabId: string, text: string, options?: { forward?: boolean; findNext?: boolean }) => {
        // 空串/空白串不进 webview：查找条 Enter 不受按钮 disabled 约束，
        // 空条按 Enter 会直达这里（Chromium 空串查找语义是全位置匹配刷屏）。
        if (!text || !String(text).trim()) return;
        const webview = webviewRefs.current.get(tabId);
        if (!webview || !webviewReadyRefs.current.has(tabId)) return;
        if (!hasWebviewFn(webview, 'findInPage')) return;
        try {
            webview.findInPage(text, {
                forward: options?.forward !== false,
                // findNext=false 表示"开一次新的查找会话"（重置当前命中位置）。
                // 改词时必须为 false，否则会在旧会话里找新词 —— 命中数正确但
                // "第几个"会从上次的位置继续，表现为高亮停在半中间。
                findNext: options?.findNext !== false,
                matchCase: false,
            });
        } catch (e) {
            console.error('findInPage 失败:', e);
        }
    }, []);

    const stopFindInPage = useCallback((tabId: string, keepSelection: boolean = false) => {
        const webview = webviewRefs.current.get(tabId);
        if (!webview) return;
        if (!hasWebviewFn(webview, 'stopFindInPage')) return;
        try {
            webview.stopFindInPage(keepSelection ? 'keepSelection' : 'clearSelection');
        } catch (e) {
            console.error('stopFindInPage 失败:', e);
        }
    }, []);

    const setFindQuery = useCallback((text: string) => {
        const tabId = activeTabIdRef.current;
        const next = String(text || '');
        const prev = findQueryRef.current;
        findQueryRef.current = next;
        setFindQueryState(next);
        // 有词必开着；清空=关闭（输入框删空与 Esc/右上角 X 同义）
        findOpenRef.current = next !== '';
        setFindOpenState(next !== '');

        if (!next) {
            setFindInfo({ matches: 0, active: 0 });
            if (prev) stopFindInPage(tabId);
            return;
        }
        // 词变了就是新会话（findNext:false），否则是同一会话里跳下一个
        findInPage(tabId, next, { findNext: prev === next });
    }, [findInPage, stopFindInPage]);

    /** 打开查找条（Ctrl+F）：只开不搜，等用户打字；已开着时保持不动 */
    const openFind = useCallback(() => {
        findOpenRef.current = true;
        setFindOpenState(true);
    }, []);

    /** 关闭查找条：清词、清高亮、收条三件套 */
    const closeFind = useCallback(() => {
        const tabId = activeTabIdRef.current;
        const prev = findQueryRef.current;
        findQueryRef.current = '';
        setFindQueryState('');
        findOpenRef.current = false;
        setFindOpenState(false);
        setFindInfo({ matches: 0, active: 0 });
        if (prev) stopFindInPage(tabId);
    }, [stopFindInPage]);

    /** 上一个活动页：切页时停掉旧页的查找高亮（只清 state 的话旧页黄色高亮残留） */
    const prevActiveTabIdRef = useRef(activeTabId);

    /** 切标签页时把查找条收掉：查找是针对具体页面的，跟着切会找错页 */
    useEffect(() => {
        const prev = prevActiveTabIdRef.current;
        prevActiveTabIdRef.current = activeTabId;
        // 先停旧页的高亮再清 state：closeFind 停的是"当前页"（已是新页），
        // 旧页 webview 还挂着（多标签常驻挂载），会话不清高亮一直在。
        if (prev !== activeTabId && (findQueryRef.current || findOpenRef.current)) {
            stopFindInPage(prev);
        }
        if (!findQueryRef.current) return;
        findQueryRef.current = '';
        setFindQueryState('');
        setFindInfo({ matches: 0, active: 0 });
    }, [activeTabId, stopFindInPage]);

    /** 切标签页时同样收掉"开着但还没打词"的空查找条（与上面有词的分支互补） */
    useEffect(() => {
        if (!findOpenRef.current) return;
        if (findQueryRef.current) return;
        findOpenRef.current = false;
        setFindOpenState(false);
        setFindInfo({ matches: 0, active: 0 });
    }, [activeTabId]);

    const stopLoading = useCallback((tabId: string) => {
        const webview = webviewRefs.current.get(tabId);
        if (webview && hasWebviewFn(webview, 'stop')) {
            try { webview.stop(); } catch (e) { console.error(e); }
        }
        // 中止的导航不会再有 did-navigate，历史标记留着会污染下一次导航
        pendingHistoryNav.current.delete(tabId);
        // 无论 webview 在不在，都要把加载态落下来 —— 否则按钮会永远转下去
        tabActions.setTabLoading(tabId, false);
    }, [tabActions]);

    /**
     * 缩放。
     *
     * 必须**同时**改 webview 与 Tab 状态：只改 webview 的话地址栏右侧的
     * 百分比不会变（用户以为没生效，连按好几次直接顶到上限）。
     *
     * 用 setZoomFactor 而不是 setZoomLevel：level 是 Chromium 的整数档，
     * 而这里已经把 level 换算成了百分比展示，用 factor 能保证"显示的百分比"
     * 与实际缩放**逐位一致**，不会出现界面说 120% 而实际是 1.2^1=1.2 之外的值。
     */
    const zoomBy = useCallback((tabId: string, delta: number) => {
        const tab = tabsRef.current.find((t) => t.id === tabId);
        const next = nextZoomLevel(tab ? tab.zoomLevel : 0, delta);
        const webview = webviewRefs.current.get(tabId);
        if (webview && hasWebviewFn(webview, 'setZoomFactor')) {
            try { webview.setZoomFactor(zoomLevelToFactor(next)); } catch (e) { console.error(e); }
        }
        tabActions.setTabZoom(tabId, next);
    }, [tabActions]);

    const toggleMute = useCallback((tabId: string) => {
        const tab = tabsRef.current.find((t) => t.id === tabId);
        const next = !(tab ? tab.muted : false);
        const webview = webviewRefs.current.get(tabId);
        if (webview && hasWebviewFn(webview, 'setAudioMuted')) {
            try { webview.setAudioMuted(next); } catch (e) { console.error(e); }
        }
        tabActions.setTabMuted(tabId, next);
    }, [tabActions]);

    /**
     * 复活崩溃的页面。
     *
     * 走 reload 而不是 loadURL(tab.url)：崩溃后 webContents 还活着，
     * reload 会原地重来；loadURL 会**新增一条历史**，用户按后退会回到
     * 崩溃前那个页面再崩一次。
     */
    const reviveTab = useCallback((tabId: string) => {
        tabActions.setTabCrashed(tabId, false);
        tabActions.setTabError(tabId, null);
        const webview = webviewRefs.current.get(tabId);
        if (!webview) {
            // webview 不在（已关闭/尚未挂载）：没有任何事件能把 loading 落下来，
            // 置 true 等于转圈卡死。直接落下来。
            tabActions.setTabLoading(tabId, false);
            return;
        }
        if (!hasWebviewFn(webview, 'reload')) {
            // 非 Electron 下没有 reload：同"不在"处理，直接落 loading。
            tabActions.setTabLoading(tabId, false);
            return;
        }
        try {
            webview.reload();
        } catch (e) {
            console.error(e);
            tabActions.setTabLoading(tabId, false);
            return;
        }
        tabActions.setTabLoading(tabId, true);
        // 兜底：reload() 成功调用、但后续无任何事件时 loading 会永久卡死
        // （crashed/error 已清，用户连恢复入口都看不到）。12 秒后若 guest
        // 自己都不在加载中，说明事件丢了，直接落下来；慢页面 guest 仍在
        // 加载（isLoading 为 true），不会误伤。
        window.setTimeout(() => {
            try {
                const current = webviewRefs.current.get(tabId);
                if (!current) return;
                if (!hasWebviewFn(current, 'isLoading')) {
                    tabActions.setTabLoading(tabId, false);
                    return;
                }
                if (!current.isLoading()) tabActions.setTabLoading(tabId, false);
            } catch {
                tabActions.setTabLoading(tabId, false);
            }
        }, 12000);
    }, [tabActions]);

    // 供 Tamper 等外部调用
    const getActiveWebview = useCallback(
        () => webviewRefs.current.get(activeTabIdRef.current) || null,
        []
    );

    const getWebview = useCallback((tabId: string) => webviewRefs.current.get(tabId) || null, []);

    /** 订阅页面就绪；退订函数由调用方在 effect 清理里调用 */
    const onPageReady = useCallback((cb: (tabId: string, webview: WebviewElement) => void) => {
        pageReadyListeners.current.add(cb);
        return () => { pageReadyListeners.current.delete(cb); };
    }, []);

    /** 遍历存活 webview。webview 可能已被卸载，故逐个 try 隔离 */
    const forEachWebview = useCallback((cb: (webview: WebviewElement, tabId: string) => void) => {
        webviewRefs.current.forEach((webview, tabId) => {
            try { cb(webview, tabId); } catch (e) { console.error('forEachWebview callback failed:', e); }
        });
    }, []);

    /**
     * 11. 浏览器动作分发。
     *
     * 放在所有回调定义**之后**：它要引用 stopLoading / zoomBy / findInPage 等，
     * 而这些是 const 声明（有 TDZ），写在前面会在首次渲染时抛
     * "Cannot access before initialization"。
     *
     * 依赖为空 + 每次渲染重新赋值：见 browserActionRef 的注释。
     */
    useEffect(() => {
        browserActionRef.current = (command: BrowserCommand) => {
            const activeId = activeTabIdRef.current;
            const tabs = tabsRef.current;
            const arg = command.arg;

            // 只属于界面层的动作直接转发给面板（它持有地址栏 input 与 Agent 输入框）
            if (command.action === 'focusAddressBar' || command.action === 'analyzeElement'
                || command.action === 'searchSelection' || command.action === 'focusAgentInput') {
                uiActionListeners.current.forEach((cb) => {
                    try { cb(command); } catch (e) { console.error('ui action listener failed:', e); }
                });
                return;
            }

            switch (command.action) {
                case 'newTab':
                    tabActions.createTab();
                    break;
                case 'closeTab':
                    tabActions.closeTab(activeId);
                    break;
                case 'reopenTab': {
                    // 没东西可恢复时**什么都不做**，不新建空白页 ——
                    // 用户按 Ctrl+Shift+T 是想找回刚关掉的页面，
                    // 给他一个空白页等于把"恢复"这个动作的意义抹掉。
                    // 栈空是正常的（刚启动、或关的都是空白页），不报错。
                    tabActions.reopenClosedTab();
                    break;
                }
                case 'nextTab': case 'prevTab': {
                    if (tabs.length < 2) break;
                    const idx = tabs.findIndex((t) => t.id === activeId);
                    const step = command.action === 'nextTab' ? 1 : -1;
                    // 环绕：在最后一个上按 Ctrl+Tab 回到第一个（Chrome 的行为）
                    const next = (idx + step + tabs.length) % tabs.length;
                    tabActions.switchTab(tabs[next].id);
                    break;
                }
                case 'selectTabIndex': {
                    const index = Number(arg);
                    if (Number.isInteger(index) && index >= 0 && index < tabs.length) {
                        tabActions.switchTab(tabs[index].id);
                    }
                    break;
                }
                case 'lastTab':
                    if (tabs.length > 0) tabActions.switchTab(tabs[tabs.length - 1].id);
                    break;
                case 'reload':
                    tabActions.reload(activeId);
                    break;
                case 'hardReload':
                    tabActions.hardReload(activeId);
                    break;
                case 'stop':
                    stopLoading(activeId);
                    break;
                case 'back':
                    tabActions.goBack(activeId);
                    break;
                case 'forward':
                    tabActions.goForward(activeId);
                    break;
                case 'home':
                    tabActions.goHome(activeId);
                    break;
                case 'toggleBookmark': {
                    const tab = tabs.find((t) => t.id === activeId);
                    if (tab && tab.url) bookmarks.toggleBookmark(tab.url, tab.title);
                    break;
                }
                case 'zoomIn':
                    zoomBy(activeId, 1);
                    break;
                case 'zoomOut':
                    zoomBy(activeId, -1);
                    break;
                case 'zoomReset':
                    zoomBy(activeId, 0);
                    break;
                case 'find':
                    // Ctrl+F 是"打开查找条等输入"，不是"清空并关闭"。
                    // 原先调 setFindQuery('') 语义恰好反了：条关着时按了仍关着。
                    openFind();
                    break;
                case 'findNext':
                    if (findQueryRef.current) {
                        findInPage(activeId, findQueryRef.current, { findNext: true, forward: true });
                    }
                    break;
                case 'findPrev':
                    if (findQueryRef.current) {
                        findInPage(activeId, findQueryRef.current, { findNext: true, forward: false });
                    }
                    break;
                case 'escape':
                    // Esc 只通知不拦截（页面自己也要用），所以这里必须判"我现在
                    // 有没有东西可以关" —— 没有就什么都不做，把按键让给页面。
                    // 优先级：查找条开着先关条；否则正在加载则停掉（Chrome 行为），
                    // 否则放行给页面（关弹窗/退出全屏）。
                    if (findOpenRef.current || findQueryRef.current) {
                        closeFind();
                        break;
                    }
                    {
                        const current = tabs.find((t) => t.id === activeId);
                        if (current && current.isLoading) {
                            stopLoading(activeId);
                        }
                    }
                    break;
                case 'toggleDevTools':
                    // F12 / Ctrl+Shift+I 已由主进程直接 toggleDevTools，不会到这里。
                    // 保留分支是为了让这张表与主进程的 BROWSER_ACTIONS 逐字一致 ——
                    // 少一个分支，静态断言就会报"渲染层不认这个动作"。
                    break;
                case 'openInBackgroundTab':
                    // 后台打开：建标签但不切过去。createTab 会把新页设为活动页，
                    // 所以建完再把活动页切回来
                    if (arg?.url) {
                        tabActions.createTab(String(arg.url));
                        tabActions.switchTab(activeId);
                    }
                    break;
                case 'audibleChanged': {
                    // 按 webContentsId 找标签页：发声的是**那个页面**，
                    // 不一定是当前页（后台标签页开始放音频时当前页根本没变）
                    const target = findTabByWebContentsId(command.webContentsId);
                    if (target) tabActions.setTabAudible(target, Boolean(arg?.audible));
                    break;
                }
                default:
                    break;
            }
        };
    });

    /** 按 webContentsId 反查标签页 id。找不到返回空串（webview 可能已经关掉） */
    const findTabByWebContentsId = useCallback((webContentsId?: number): string => {
        if (!webContentsId) return '';
        let found = '';
        webviewRefs.current.forEach((webview, tabId) => {
            if (found) return;
            try {
                if (webview.getWebContentsId?.() === webContentsId) found = tabId;
            } catch { /* webview 已卸载 */ }
        });
        return found;
    }, []);

    /** 订阅界面层动作（聚焦地址栏 / 让 Agent 分析元素）。返回退订函数 */
    const onUiAction = useCallback((cb: (command: BrowserCommand) => void) => {
        uiActionListeners.current.add(cb);
        return () => { uiActionListeners.current.delete(cb); };
    }, []);

    return useMemo(() => ({
        inputUrl,
        setInputUrl,
        setInputFocused,
        isCurrentPageBookmarked,
        handleNavigate,
        handleOpenInNewTab,
        getWebviewRef,
        getActiveWebview,
        getWebview,
        onPageReady,
        forEachWebview,
        stopLoading,
        findInPage,
        stopFindInPage,
        zoomBy,
        toggleMute,
        reviveTab,
        findInfo,
        findQuery,
        findOpen,
        setFindQuery,
        openFind,
        closeFind,
        onUiAction,
    }), [
        inputUrl, isCurrentPageBookmarked, handleNavigate, handleOpenInNewTab,
        getWebviewRef, getActiveWebview, getWebview,
        onPageReady, forEachWebview, setInputFocused,
        stopLoading, findInPage, stopFindInPage, zoomBy, toggleMute, reviveTab,
        findInfo, findQuery, findOpen, setFindQuery, openFind, closeFind, onUiAction,
    ]);
};

/* -------------------------------------------------------------------------- */
/*                             内部：资源嗅探                                   */
/* -------------------------------------------------------------------------- */

/**
 * 本地文件不进嗅探：已在本地的东西无需"发现下载"，属纯噪声；
 * 且 ACG 落盘页正是 file://（无 hostname，isAcgUrl 认不出），不拦会污染列表。
 */
const isFileUrl = (url: unknown): boolean =>
    typeof url === 'string' && url.trim().toLowerCase().startsWith('file:');

/**
 * blob: 是**页面自己那块内存**的句柄，不是可下载的远端资源。
 *
 * 它跨不过进程边界：主进程下载器按这个地址去请求只会 404/协议不支持，
 * 播放器（file:// 或 localhost:5173 源）也不在页面那个源上，同样读不到。
 * 也就是说这条目进了列表之后，两个按钮点下去都不会成功。
 *
 * 页内脚本与网络层都已各自拦掉 blob:，唯独 AI 提取那条路径允许它
 * —— 所以真正的闸口放在这里（所有入库通道共用），不再指望每个来源自觉。
 */
const isBlobUrl = (url: unknown): boolean =>
    typeof url === 'string' && url.trim().toLowerCase().startsWith('blob:');

/** 读 webview 当前 URL。webview 卸载后调用会抛，统一吞掉返回空串 */
const readWebviewUrlSafe = (webview: WebviewElement): string => {
    try { return webview.getURL?.() || ''; } catch { return ''; }
};
/** ACG 专属资源、本地文件与 blob 一律不进嗅探列表（所有入库通道统一在此拦截） */
const isSniffable = (item: FoundLink | null | undefined): boolean =>
    !!item && typeof item.url === 'string' &&
    !isFileUrl(item.url) && !isFileUrl(item.pageUrl) && !isFileUrl(item.referer) &&
    !isBlobUrl(item.url) &&
    !isAcgUrl(item.url) && !isAcgUrl(item.pageUrl) && !isAcgUrl(item.referer);

interface SniffDeps {
    getActiveWebview: () => WebviewElement | null;
    activeTab: { url: string; title?: string };
}

const useSniffer = (deps: SniffDeps): SnifferState => {
    /**
     * 加载态用**计数**而不是布尔量。
     *
     * scan 与 analyzeWithAi 是两个独立操作、共用一个 isAnalyzing：
     * 布尔量下先结束的那个会把还在跑的那个的加载态一起关掉。
     * 实测路径：在 A 页点「AI 深度嗅探」（要等 AI 接口，很慢）→ 随即导航到 B 页
     * （此时若用户在 B 页又点了"嗅探"）→ scan(B) 很快结束、置 false →
     * 此刻界面显示"未在分析"、AI 按钮重新可点，而 AI 请求还在飞。
     * 用户以为没反应，再点一次，于是并发两轮。
     */
    const [pendingOps, setPendingOps] = useState(0);
    const isAnalyzing = pendingOps > 0;
    /** 包一层：无论成功、失败还是提前 return，都要把计数还回去 */
    const trackOp = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
        setPendingOps((n) => n + 1);
        try {
            return await fn();
        } finally {
            setPendingOps((n) => Math.max(0, n - 1));
        }
    }, []);
    /**
     * 嗅探结果落盘：退出重进不清零（纯 URL 文本，上限防爆配额）。
     *
     * 上限取**最新**的若干条（slice(-MAX)），不是最旧的：条目按发现顺序追加，
     * slice(0, MAX) 会在攒够 300 条后把磁盘副本永久冻结在最早那批 ——
     * 之后无论再嗅到多少，落盘的都是同一份旧数据，重启后最近的资源全部丢失。
     * useAgent 的脚本清单此前踩过同一个坑，那里也是 slice(-MAX)。
     */
    const [foundLinks, setFoundLinks] = useState<FoundLink[]>(() => {
        const saved = loadJSON<FoundLink[]>(LINKS_STORE_KEY, []);
        if (!Array.isArray(saved)) return [];
        // 旧缓存顺带清洗：以前混进来的 ACG / 本地文件条目在此版不再保留
        return saved.filter(isSniffable).slice(-LINKS_STORE_MAX);
    });
    const [error, setError] = useState('');
    const [statusMessage, setStatusMessage] = useState('');
    const [filterType, setFilterType] = useState<MediaType | 'all'>(() => {
        const saved = loadJSON<string>('sniff-filter', 'all');
        // 校验走筛选栏那一份清单，而不是 CATEGORIES 的全部键：
        // 后者含 gallery/other，它们从不产出条目，放行等于允许一个"永远空列表"的筛选态
        const all = SNIFF_FILTER_OPTIONS.map((option) => option.value);
        return all.includes(saved as MediaType | 'all') ? (saved as MediaType | 'all') : 'all';
    });
    const [scopeFilter, setScopeFilter] = useState<'all' | 'current'>(() =>
        loadJSON<'all' | 'current'>('sniff-scope', 'all') === 'current' ? 'current' : 'all'
    );
    const [downloadingUrl, setDownloadingUrl] = useState('');
    const [downloadProgress, setDownloadProgress] = useState<MediaDownloadProgress | null>(null);
    const [downloadCapabilities, setDownloadCapabilities] = useState<DownloadCapabilities>(DEFAULT_CAPABILITIES);

    // 写盘只做追加式快照，不读回，不会循环。
    // 同样取最新的若干条（与读回侧一致），否则磁盘上永远是启动时那批旧数据。
    useEffect(() => { saveJSON(LINKS_STORE_KEY, foundLinks.slice(-LINKS_STORE_MAX)); }, [foundLinks]);
    useEffect(() => { saveJSON('sniff-filter', filterType); }, [filterType]);
    useEffect(() => { saveJSON('sniff-scope', scopeFilter); }, [scopeFilter]);

    // 最新值镜像：回调（含 IPC 推送）里要读当前页，而不是绑定时的快照
    const getActiveWebviewRef = useRef(deps.getActiveWebview);
    useEffect(() => { getActiveWebviewRef.current = deps.getActiveWebview; }, [deps.getActiveWebview]);
    const activeTabRef = useRef(deps.activeTab);
    useEffect(() => { activeTabRef.current = deps.activeTab; }, [deps.activeTab]);
    // 进度订阅是常驻的（只挂一次），必须靠 ref 读"当前在下哪条"，不能闭包捕获
    const downloadingUrlRef = useRef('');
    useEffect(() => { downloadingUrlRef.current = downloadingUrl; }, [downloadingUrl]);

    /**
     * "持续嗅探"总开关，默认关闭。打开 = 切页自动扫描 + 网络层持续推送，
     * 关闭 = 两者全停（手动"嗅探"按钮的一次性扫描不受影响）。
     * 落盘持久化，重启后保持用户上次的选择。
     */
    const [sniffEnabled, setSniffEnabledState] = useState<boolean>(() =>
        loadJSON<boolean>('sniff-enabled', false) === true);
    useEffect(() => { saveJSON('sniff-enabled', sniffEnabled); }, [sniffEnabled]);
    /** 常驻订阅的回调闭包的是挂载时的快照，开关状态必须靠 ref 读最新值 */
    const sniffEnabledRef = useRef(sniffEnabled);
    useEffect(() => { sniffEnabledRef.current = sniffEnabled; }, [sniffEnabled]);
    /** 把开关同步给主进程。桥缺失（preload 未加载）时静默跳过：页内扫描照常工作，只是没有网络层增量 */
    const pushSnifferEnabled = useCallback((enabled: boolean) => {
        try {
            void getElectronAPI()?.setSnifferEnabled?.(enabled)?.catch(() => { /* 开关同步失败不影响界面状态 */ });
        } catch { /* 防御性兜底 */ }
    }, []);
    const setSniffEnabled = useCallback((enabled: boolean) => {
        setSniffEnabledState(enabled);
        pushSnifferEnabled(enabled);
    }, [pushSnifferEnabled]);
    // 启动时把开关状态同步给主进程（主进程侧默认关闭，不同步会两边不一致）。
    // 推当前值即可，幂等；只在挂载时做一次，之后的变化走 setSniffEnabled。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { pushSnifferEnabled(sniffEnabledRef.current); }, []);

    const addLinks = useCallback((newLinks: FoundLink[]) => {
        const usable = (newLinks || []).filter(isSniffable);
        if (usable.length === 0) return;

        setFoundLinks((prev) => {
            const map = new Map<string, FoundLink>();
            prev.forEach((item) => map.set(item.url, item));

            usable.forEach((item) => {
                const existing = map.get(item.url);
                if (existing) {
                    // 升级条件：**现有标题没信息量、而新标题有**。
                    // 判据与新增分支共用 isGenericTitle —— 原先这里只看
                    // startsWith('Media_')，于是标题为文件名（index.m3u8）的旧条目
                    // 永远升不了级：入库时页面标题还没拿到，之后再也没机会补。
                    //
                    // 要求新标题**非**通用：两个都通用时保持原样，
                    // 否则一次网络层推送就能把 "index.m3u8" 换成更差的 "Media_stream"。
                    // 已有好标题时同样不覆盖 —— 后来的"页面标题+后缀"不该把它顶掉。
                    if (item.title && item.title !== existing.title
                        && isGenericTitle(existing.title) && !isGenericTitle(item.title)) {
                        map.set(item.url, { ...existing, ...item });
                    }
                    return;
                }

                let enhancedTitle = item.title;
                if (isGenericTitle(enhancedTitle) && activeTabRef.current?.title) {
                    enhancedTitle = `${activeTabRef.current.title} (${item.ext || item.type})`;
                }
                map.set(item.url, {
                    ...item,
                    title: enhancedTitle,
                    pageUrl: item.pageUrl || activeTabRef.current?.url,
                    referer: item.referer || activeTabRef.current?.url,
                });
            });
            // 内存态同样收敛到上限：主进程推送的去重窗口只有 5 秒，
            // 长时间挂着一个视频站会持续发现新分片 URL，不封顶就一路涨。
            // 取最新的（与落盘一致），超出时丢最早的。
            const merged = Array.from(map.values());
            return merged.length > LINKS_STORE_MAX ? merged.slice(-LINKS_STORE_MAX) : merged;
        });
    }, []);

    // 主进程网络层推送（常驻订阅，只挂一次）
    useEffect(() => {
        const electronAPI = getElectronAPI();
        if (!electronAPI?.onSniffedMedia) return;
        return electronAPI.onSniffedMedia((media) => {
            // "持续嗅探"关闭时直接丢弃：网络层的推送不进列表
            if (!sniffEnabledRef.current) return;
            addLinks([{
                ...media,
                pageUrl: media.pageUrl || activeTabRef.current?.url,
                referer: media.referer || activeTabRef.current?.url,
            }]);
        });
    }, [addLinks]);

    /**
     * 下载进度订阅。
     *
     * 常驻订阅而不是在 download() 里临时订阅：主进程的进度推送可能在
     * invoke 的 Promise 结算之前就到了，临时订阅会漏掉开头几帧
     * （界面表现为"点了没反应，过一会儿突然跳到 30%"）。
     * 只认当前这条 URL 的进度，避免同时下载多条时互相串台。
     */
    useEffect(() => {
        const electronAPI = getElectronAPI();
        if (!electronAPI?.onMediaDownloadProgress) return;
        return electronAPI.onMediaDownloadProgress((progress) => {
            if (progress.url !== downloadingUrlRef.current) return;
            setDownloadProgress(progress);
        });
    }, []);

    // ffmpeg 能力探测
    useEffect(() => {
        const electronAPI = getElectronAPI();
        if (!electronAPI?.getDownloadCapabilities) {
            setDownloadCapabilities({
                ffmpegAvailable: false,
                ffmpegMessage: '读取不到下载能力桥（preload 未加载），请重启应用。',
            });
            return;
        }
        let mounted = true;
        void electronAPI.getDownloadCapabilities()
            .then((capabilities) => { if (mounted) setDownloadCapabilities(capabilities); })
            .catch(() => {
                if (mounted) {
                    setDownloadCapabilities({ ffmpegAvailable: false, ffmpegMessage: 'ffmpeg 能力检测失败。' });
                }
            });
        return () => { mounted = false; };
    }, []);

    /** 文本兜底嗅探：从页面源码里正则捞直链 */
    const extractLinksLocally = useCallback((content: string, baseUrl = ''): FoundLink[] => {
        const links: FoundLink[] = [];
        const seen = new Set<string>();

        const normalizeUrl = (rawUrl: string): string | null => {
            if (!rawUrl) return null;
            let normalized = rawUrl.replace(/\\\//g, '/');
            if (/^(blob|data|javascript):/i.test(normalized)) return null;
            if (!normalized.startsWith('http')) {
                if (!baseUrl) return null;
                try {
                    normalized = new URL(normalized, baseUrl).href;
                } catch {
                    return null;
                }
            }
            return normalized;
        };

        const getPatterns = (exts: string[]) => {
            if (exts.length === 0) return [];
            const extGroup = exts.join('|');
            return [
                new RegExp(`(https?:\\/\\/[^\\s"',]+\\.(?:${extGroup})(?:\\?[^\\s"']*)?)`, 'gi'),
                new RegExp(`(https?:\\\\/\\\\/[^\\s"',]+\\.(?:${extGroup})(?:\\?[^\\s"']*)?)`, 'gi'),
                new RegExp(`["']((?:\\/|http)[^"']+\\.(?:${extGroup})(?:\\?[^"']*)?)["']`, 'gi'),
            ];
        };

        (Object.keys(CATEGORIES) as MediaType[]).forEach((type) => {
            const exts = CATEGORIES[type];
            if (type === 'other' || exts.length === 0) return;

            for (const regex of getPatterns(exts)) {
                let match: RegExpExecArray | null = null;
                let loopCount = 0;

                while ((match = regex.exec(content)) !== null && loopCount < 1000) {
                    loopCount += 1;
                    const cleanUrl = normalizeUrl((match[1] || match[0]).replace(/['"]/g, ''));
                    if (!cleanUrl || seen.has(cleanUrl)) continue;

                    try {
                        const urlObj = new URL(cleanUrl);
                        const extMatch = urlObj.pathname.match(/\.([a-zA-Z0-9]+)$/);
                        const ext = extMatch ? extMatch[1].toLowerCase() : '';
                        if (!exts.includes(ext)) continue;

                        // HLS 分片同样要丢：主进程网络层与页内脚本都有这道闸，
                        // 少了它，页面源码里那几十上百个 segNNN.ts 会被这里单独收进列表
                        // —— 同一个页面走两条路径，结论不同。
                        if (ext === 'ts' && isHlsSegmentPath(urlObj.pathname) && !cleanUrl.includes('playlist')) continue;

                        seen.add(cleanUrl);
                        const filename = urlObj.pathname.split('/').pop() || 'Resource';
                        // decodeURIComponent 对含孤立 '%' 的文件名会抛 URIError
                        // （如 /100%.png、/x%zz.png —— 站点漏转义时很常见）。
                        // 它处在下面那个大 try 里，一旦抛出，整个候选会被当作
                        // "无法解析" 静默丢弃 —— 一个完全可下载的媒体链接就此消失。
                        // 解码只是为了让标题好看，失败就退回原始文件名即可。
                        let decodedName = filename;
                        try { decodedName = decodeURIComponent(filename); } catch { /* 保留原名 */ }
                        const title = activeTabRef.current?.title
                            ? `${activeTabRef.current.title} (${ext || type})`
                            : decodedName;

                        links.push({
                            url: cleanUrl, title, type, ext,
                            source: 'local',
                            pageUrl: baseUrl,
                            referer: baseUrl,
                        });
                    } catch { /* 跳过无法解析的候选 */ }
                }
            }
        });

        return links;
    }, []);

    /**
     * 扫描轮次序号。
     *
     * 用户连点"嗅探"时多轮 scan 会并发：后一轮必须作废前一轮的迟到结果，
     * 否则旧轮次把东西写进列表、并抢走新轮次的加载态。
     * 不传 runId（如悬浮球的"嗅探"按钮）视为始终有效。
     */
    const latestRunRef = useRef<number | null>(null);
    const isCurrentRun = useCallback(
        (runId?: number) => runId === undefined || latestRunRef.current === runId,
        []
    );

    /**
     * 手动嗅探的入口（悬浮球"嗅探"按钮 / 空态"嗅探当前页"）。
     * 纯一次性扫描，不碰"持续嗅探"开关：开关关闭时点了也只扫这一次，
     * 网络层不会因此开始推送 —— 要持续捕获请打开开关。
     */
    const scan = useCallback(async (targetUrl?: string, runId?: number) => {
        const url = targetUrl || activeTabRef.current?.url;
        if (!url) return;

        if (runId !== undefined) latestRunRef.current = runId;

        setError('');
        setStatusMessage('正在全面嗅探页面与网络资源...');

        await trackOp(async () => {
            try {
                // 1. 活跃 webview：深度 DOM 嗅探 + 性能列表提取
                const webview = getActiveWebviewRef.current?.();
                if (webview?.executeJavaScript) {
                    try {
                        const scanResult = await webview.executeJavaScript(IN_PAGE_INSPECTOR_SCRIPT);
                        if (isCurrentRun(runId) && Array.isArray(scanResult?.links) && scanResult.links.length > 0) {
                            addLinks(scanResult.links);
                        }
                    } catch { /* webview 未就绪或拒绝执行时安全回退 */ }
                }

                // 2. 文本兜底：二进制媒体直链不做 fetch（跨域 CORS 必失败，
                // 且会把几百 MB 的音视频当文本读进内存）
                const lowerUrl = url.toLowerCase().split('?')[0].split('#')[0];
                const isBinaryUrl = Object.values(CATEGORIES).some(
                    (exts) => exts.some((ext) => lowerUrl.endsWith(`.${ext}`))
                );
                let contentToAnalyze = '';
                if (!isBinaryUrl) {
                    const controller = new AbortController();
                    const timer = window.setTimeout(() => controller.abort(), 8000);
                    try {
                        const response = await fetch(url, { signal: controller.signal });
                        const contentType = response.headers.get('content-type') || '';
                        // 只解析文本型文档，二进制/流响应直接跳过
                        const isTextLike = /text|html|json|xml|javascript|m3u|mpegurl|dash/i.test(contentType);
                        if (response.ok && (isTextLike || !contentType)) {
                            // 上限截断，避免超大页面卡死正则扫描
                            contentToAnalyze = (await response.text()).slice(0, 500_000);
                        }
                    } catch {
                        // 跨域 CORS / 超时 / 离线：静默回退，仅依赖 webview 与网络层嗅探
                    } finally {
                        window.clearTimeout(timer);
                    }
                }

                if (contentToAnalyze && isCurrentRun(runId)) {
                    const localLinks = extractLinksLocally(contentToAnalyze, url);
                    if (localLinks.length > 0) addLinks(localLinks);
                }

                if (isCurrentRun(runId)) {
                    setStatusMessage(sniffEnabledRef.current
                        ? '嗅探扫描完成，网络监听持续捕捉中。'
                        : '嗅探扫描完成（持续嗅探已关闭，之后的新请求不再自动捕获）。');
                }
            } catch (err) {
                if (isCurrentRun(runId)) {
                    setError(err instanceof Error ? err.message : '扫描失败');
                }
            }
        });
        // 加载态由 trackOp 统一归还，这里不再按轮次判断 ——
        // 过期轮次也持有自己那一份计数，提前 return 会把它漏掉、永久转圈
    }, [addLinks, extractLinksLocally, isCurrentRun, trackOp]);

    /**
     * AI 深度分析。
     *
     * 与 scan 一样要防"过期结果写进当前列表"：AI 接口很慢（可能十几秒），
     * 用户完全可能在中途切页。原实现没有任何保护 —— 迟到的结果会以
     * **旧页面的 URL** 作为 pageUrl 入列，于是在 B 页看到 A 页的资源。
     *
     * 判据用页面 URL 而不是 scan 的 runId：这个操作不由 URL 变化驱动，
     * 没有轮次可言，它只关心"我出发时那个页面还是当前页吗"。
     */
    const analyzeWithAi = useCallback(async (targetUrl: string) => {
        const stillOnPage = () => (activeTabRef.current?.url || '') === targetUrl;

        setError('');
        setStatusMessage('正在提取页面上下文供 AI 分析...');

        await trackOp(async () => {
            try {
                let content = '';
                const webview = getActiveWebviewRef.current?.();
                if (webview?.executeJavaScript) {
                    try {
                        content = await webview.executeJavaScript('document.documentElement.outerHTML');
                    } catch { /* 回退到 fetch */ }
                }

                if (!content) {
                    // 二进制直链不做 fetch（同 scan：CORS 必失败且占内存）
                    const isBinary = Object.values(CATEGORIES).some(
                        (exts) => exts.some((ext) => new RegExp(`\\.${ext}(\\?|#|$)`, 'i').test(targetUrl))
                    );
                    if (!isBinary) {
                        // 超时与 scan 用同一个值：这个 fetch 只是"拿不到 webview 源码时"的
                        // 兜底，站点挂着不回时它会把 isAnalyzing 一直占着 ——
                        // 界面表现为 AI 按钮永久变灰、两个操作都点不动。
                        const controller = new AbortController();
                        const timer = window.setTimeout(() => controller.abort(), 8000);
                        try {
                            const response = await fetch(targetUrl, { signal: controller.signal });
                            const contentType = response.headers.get('content-type') || '';
                            if (response.ok && (/text|html|json|xml|javascript/i.test(contentType) || !contentType)) {
                                content = await response.text();
                            }
                        } catch { /* 无内容可分析 */ } finally {
                            window.clearTimeout(timer);
                        }
                    }
                }

                // 一个字都没拿到就别调 AI：空内容进去必然是空结果，
                // 白花一次接口调用与十几秒等待，最后还报"未发现额外结构化资源"
                // —— 那句话会把"页面根本没读到"说成"页面里确实没有"。
                if (!content.trim()) {
                    if (stillOnPage()) setStatusMessage('未能读取页面内容（页面未就绪或不可跨域读取），AI 分析已跳过。');
                    return;
                }

                setStatusMessage('AI 正在深度解析页面流媒体与直链...');
                const extracted = await extractMediaLinks(content, activeTabRef.current?.title || '');

                // 用户已经切走了：结果属于上一个页面，丢弃（连同状态文案）
                if (!stillOnPage()) return;

                if (extracted.length === 0) {
                    setStatusMessage('AI 分析完成，未发现额外结构化资源。');
                    return;
                }

                addLinks(extracted.map((item) => ({
                    ...item,
                    source: 'ai' as const,
                    pageUrl: targetUrl,
                    referer: targetUrl,
                })));
                setStatusMessage(`AI 深度分析完成，收录 ${extracted.length} 个候选资源。`);
            } catch (err) {
                if (!stillOnPage()) return;
                const message = err instanceof Error ? err.message : 'AI 分析失败';
                setError(`AI 分析失败：${message}`);
            }
        });
    }, [addLinks, trackOp]);

    const clear = useCallback(() => {
        setFoundLinks([]);
        setStatusMessage('已清空嗅探列表。');
    }, []);

    const clearCurrentPage = useCallback((pageUrl?: string) => {
        const targetUrl = pageUrl || activeTabRef.current?.url;
        if (!targetUrl) {
            setFoundLinks([]);
            return;
        }
        // 与「仅当前页」筛选同判据（isLinkFromPage）：列表里看得见的当前页条目，
        // 点这里必须都能清掉，否则按钮看起来没生效
        setFoundLinks((prev) => prev.filter((item) => !isLinkFromPage(item, targetUrl)));
        setStatusMessage('已清空当前页面嗅探资源。');
    }, []);

    const download = useCallback(async (link: FoundLink): Promise<DownloadMediaResult> => {
        const electronAPI = getElectronAPI();
        if (!electronAPI?.downloadMedia) {
            const fallbackLink = document.createElement('a');
            fallbackLink.href = link.url;
            fallbackLink.download = link.title || 'media';
            fallbackLink.target = '_blank';
            fallbackLink.rel = 'noreferrer';
            // 必须入文档再点：游离节点在部分浏览器上不触发下载；
            // 用完摘掉，否则每下载一次就往 body 里堆一个节点
            document.body.appendChild(fallbackLink);
            fallbackLink.click();
            fallbackLink.remove();
            return { success: true, message: '已触发浏览器下载。' };
        }

        if (requiresFfmpeg(link.type, link.ext) && !downloadCapabilities.ffmpegAvailable) {
            const message = downloadCapabilities.ffmpegMessage || '当前无法下载流媒体资源。';
            setError(message);
            setStatusMessage(message);
            return { success: false, message };
        }

        setDownloadingUrl(link.url);
        setDownloadProgress(null);
        setError('');
        setStatusMessage(requiresFfmpeg(link.type, link.ext) ? '正在使用 ffmpeg 下载流媒体...' : '正在下载资源...');

        try {
            const result = await electronAPI.downloadMedia({
                url: link.url,
                title: link.title,
                type: link.type,
                ext: link.ext,
                referer: link.referer || activeTabRef.current?.url,
            });
            // 下载成功但有缺失（如 HLS 源站丢了分片）时，状态栏要同时说清
            // "下好了" 与 "少了东西"——只报成功会让人以为拿到的是完整文件
            setStatusMessage(result.warning ? `${result.message}｜${result.warning}` : result.message);
            // 取消不是错误：用户自己点的，不该再弹一条红色报错
            if (!result.success && !result.cancelled) setError(result.message);
            return result;
        } catch (err) {
            const message = err instanceof Error ? err.message : '下载失败';
            setError(message);
            setStatusMessage(message);
            return { success: false, message };
        } finally {
            setDownloadingUrl('');
            setDownloadProgress(null);
        }
    }, [downloadCapabilities]);

    /**
     * 取消当前下载。
     *
     * 主进程会 kill 掉 ffmpeg 子进程/中断 HTTP 请求，并删除半成品文件；
     * 这里只负责把界面切回可再点状态 —— invoke 的 Promise 会在主进程
     * 收尾后自行结算，download() 的 finally 随即清掉进度。
     */
    const cancelDownload = useCallback(async () => {
        const target = downloadingUrlRef.current;
        if (!target) return;
        const electronAPI = getElectronAPI();
        setStatusMessage('正在取消下载…');
        try {
            await electronAPI?.cancelMediaDownload?.(target);
        } catch (err) {
            setStatusMessage(err instanceof Error ? err.message : '取消失败');
        }
    }, []);

    const activeTabUrl = deps.activeTab?.url;
    const filteredLinks = useMemo(() => {
        let list = foundLinks;
        if (scopeFilter === 'current' && activeTabUrl) {
            list = list.filter((item) => isLinkFromPage(item, activeTabUrl));
        }
        if (filterType !== 'all') {
            list = list.filter((link) => link.type === filterType);
        }
        return list;
    }, [filterType, foundLinks, scopeFilter, activeTabUrl]);

    const actions = useMemo(() => ({
        scan, setSniffEnabled, analyzeWithAi, setFilterType, setScopeFilter, clear, clearCurrentPage, download, cancelDownload,
    }), [scan, setSniffEnabled, analyzeWithAi, clear, clearCurrentPage, download, cancelDownload]);

    return useMemo(() => ({
        foundLinks,
        filteredLinks,
        isAnalyzing,
        statusMessage,
        filterType,
        scopeFilter,
        sniffEnabled,
        error,
        downloadingUrl,
        downloadProgress,
        downloadCapabilities,
        actions,
    }), [
        foundLinks, filteredLinks, isAnalyzing, statusMessage, filterType,
        scopeFilter, sniffEnabled, error, downloadingUrl, downloadProgress, downloadCapabilities, actions,
    ]);
};

/* -------------------------------------------------------------------------- */
/*                             内部：篡改引擎                                   */
/* -------------------------------------------------------------------------- */

interface TamperDeps {
    onPageReady: InteractionsState['onPageReady'];
    forEachWebview: InteractionsState['forEachWebview'];
    getActiveWebview: () => WebviewElement | null;
}

/**
 * 篡改引擎：规则持久化 + 注入编排 + 存储读写。
 *
 * 注入生命周期完全交给 interactions：页面每次 dom-ready 广播一次，
 * 这里被动接收并注入。引擎自己不认识「当前标签页」——
 * 哪个 webview 就绪就往哪个里面装，后台标签页同样装上，
 * 因此切换标签页不会让篡改失效。
 *
 * 脚本内部幂等（window.__interceptorInstalled），重复注入只换 config。
 */
const useTamper = (deps: TamperDeps): TamperState => {
    const [interceptRules, setInterceptRules] = useState<TamperRule[]>([]);
    const [requestRules, setRequestRules] = useState<TamperRule[]>([]);
    const [headerRules, setHeaderRules] = useState<HeaderRule[]>([]);

    const injectWith = useCallback((webview: WebviewElement, config: TamperConfig) => {
        try {
            // executeJavaScript 在 webview 未附加/未就绪时同步抛错，返回的 Promise 也可能 reject，
            // 两种都要吞掉：注入失败只意味着这一页没装上，不该影响导航。
            const promise = webview.executeJavaScript(buildTamperScript(config));
            if (promise && typeof promise.catch === 'function') promise.catch(() => { });
        } catch { /* webview 已卸载 */ }
    }, []);

    // 最新规则镜像：dom-ready 回调里要读当前值，不能绑 effect 建立时的快照
    const configRef = useRef<TamperConfig>({ rules: [], requestRules: [], headerRules: [] });

    /**
     * 加载已存规则（坏缓存不崩），并**立刻**推给已存在的 webview。
     *
     * 不能只 setState 等下面那个镜像 effect：那个要等重渲染，
     * 而这一瞬间若有页面就绪（HMR 重挂载、恢复会话时页面已加载完），
     * onPageReady 会读到还空着的 configRef，把空规则装进页面并一直留着 ——
     * 之后没有任何事件会再推一次，只能靠用户手动点「应用更改」。
     */
    useEffect(() => {
        const saved = loadStr('tamper_rules', '', '');
        if (!saved) return;

        let parsed: { intercept?: unknown; request?: unknown; headers?: unknown };
        try {
            parsed = JSON.parse(saved);
        } catch {
            return;   // 缓存损坏时保持空规则
        }

        const intercept = Array.isArray(parsed.intercept) ? parsed.intercept as TamperRule[] : [];
        const request = Array.isArray(parsed.request) ? parsed.request as TamperRule[] : [];
        const headers = Array.isArray(parsed.headers) ? parsed.headers as HeaderRule[] : [];

        setInterceptRules(intercept);
        setRequestRules(request);
        setHeaderRules(headers);

        const config: TamperConfig = { rules: intercept, requestRules: request, headerRules: headers };
        configRef.current = config;
        deps.forEachWebview((webview) => injectWith(webview, config));
    }, [deps.forEachWebview, injectWith]);

    // 规则变化 → 更新镜像（saveRules 自己会用参数直接推，这里只负责后续就绪的页面）
    useEffect(() => {
        configRef.current = { rules: interceptRules, requestRules, headerRules };
    }, [interceptRules, requestRules, headerRules]);

    // 页面就绪 → 注入当前规则
    useEffect(
        () => deps.onPageReady((_tabId, webview) => injectWith(webview, configRef.current)),
        [deps.onPageReady, injectWith]
    );

    /**
     * 把一份规则同时写进 React 状态与全部存活页面。
     *
     * 用**参数**而不是 configRef 构造脚本：configRef 要等这次 setState 渲染完的
     * effect 才更新，读它会把上一版规则推下去。
     */
    const applyRules = useCallback((intercept: TamperRule[], request: TamperRule[], headers: HeaderRule[]) => {
        setInterceptRules(intercept);
        setRequestRules(request);
        setHeaderRules(headers);

        const config: TamperConfig = { rules: intercept, requestRules: request, headerRules: headers };
        deps.forEachWebview((webview) => injectWith(webview, config));
    }, [deps.forEachWebview, injectWith]);

    const saveRules = useCallback((intercept: TamperRule[], request: TamperRule[], headers: HeaderRule[]): boolean => {
        applyRules(intercept, request, headers);

        // 返回值区分"已注入"与"已持久化"：配额爆了规则仍对当前页面生效，
        // 但重启就没了 —— 面板必须能说出这个区别，否则用户以为存住了。
        return saveStr('tamper_rules', JSON.stringify({ intercept, request, headers }), '');
    }, [applyRules]);

    // --- 存储管理 API ---
    // 每次都向 interactions 取当前活动 webview，不缓存引用：
    // 缓存的那份在切换标签页后仍指向旧页。

    /**
     * 读一个 Storage 区的全部键值。
     *
     * 两处都不能想当然：
     *
     * 1. 必须走 length/key() 逐条枚举，不能 `JSON.stringify(storage)`：
     *    Storage 的具名属性来自 WebIDL 的具名属性表，`JSON.stringify` 只序列化
     *    自有可枚举属性，拿到的是 `{}` —— 面板会永远显示"没有可显示的数据"。
     *
     * 2. 必须走**原型上的原生方法**，不能用 `s.getItem(k)`：
     *    篡改引擎钩的正是实例上的 getItem，规则会改写读取结果。
     *    结果是面板显示"被篡改后的值"而不是真实值 —— 用户改了键、点保存，
     *    面板刷新后仍显示旧值（规则又盖回去了），会以为保存失败而反复保存。
     *    面板是**管理真实存储**的地方，必须看到真值。
     */
    const readStorageArea = useCallback(async (area: 'localStorage' | 'sessionStorage') => {
        const webview = deps.getActiveWebview();
        if (!webview) return '{}';
        try {
            return await webview.executeJavaScript(`(function () {
                var out = {};
                try {
                    var s = window[${JSON.stringify(area)}];
                    // 引擎钩的是实例方法，原型上仍是原生实现
                    var proto = Object.getPrototypeOf(s);
                    var rawGet = (typeof Storage !== 'undefined' && Storage.prototype.getItem) || proto.getItem;
                    var rawKey = (typeof Storage !== 'undefined' && Storage.prototype.key) || proto.key;
                    var len = s.length;
                    for (var i = 0; i < len; i++) {
                        var k = rawKey.call(s, i);
                        if (k !== null) out[k] = rawGet.call(s, k);
                    }
                } catch (e) { /* 第三方 iframe / 禁用存储：读本身就是 SecurityError */ }
                return JSON.stringify(out);
            })()`);
        } catch {
            console.warn(`Unable to access ${area} (WebView might be loading or restricted)`);
            return '{}';
        }
    }, [deps.getActiveWebview]);

    const getLocalStorage = useCallback(
        () => readStorageArea('localStorage'),
        [readStorageArea]
    );

    const getSessionStorage = useCallback(
        () => readStorageArea('sessionStorage'),
        [readStorageArea]
    );

    /**
     * 往页面里写一个键。
     *
     * 键和值都用 JSON.stringify 嵌入，而不是手工转义：
     * 手工那版只处理了反斜杠、单引号、\n，漏掉 \r、U+2028/U+2029，
     * 而且**键名根本没转义** —— 键里带一个单引号就能把整段脚本拼断。
     *
     * 读路径走原型绕过引擎（见 readStorageArea）；写路径目前不需要 ——
     * 引擎只钩了 getItem，setItem / removeItem 仍是原生的。
     * 如果以后给引擎加了「写入篡改」，这里必须一并改成走原型，
     * 否则用户在面板里保存的值会被规则改写掉。
     */
    const writeStorageArea = useCallback(async (
        area: 'localStorage' | 'sessionStorage',
        op: 'set' | 'remove',
        key: string,
        val: string
    ): Promise<boolean> => {
        const webview = deps.getActiveWebview();
        if (!webview) return false;
        const call = op === 'set'
            ? `${area}.setItem(${JSON.stringify(key)}, ${JSON.stringify(val)})`
            : `${area}.removeItem(${JSON.stringify(key)})`;
        // 页面里的失败（配额爆了、存储被禁）必须传回来：
        // 吞掉的话面板会照着乐观更新的草稿显示"已保存"，而页面里什么都没发生。
        try {
            return await webview.executeJavaScript(`(function () { try { ${call}; return true; } catch (e) { return false; } })()`) === true;
        } catch {
            return false;   // webview 未就绪
        }
    }, [deps.getActiveWebview]);

    const setLocalStorage = useCallback(
        (key: string, val: string) => writeStorageArea('localStorage', 'set', key, val),
        [writeStorageArea]
    );

    const removeLocalStorage = useCallback(
        (key: string) => writeStorageArea('localStorage', 'remove', key, ''),
        [writeStorageArea]
    );

    const setSessionStorage = useCallback(
        (key: string, val: string) => writeStorageArea('sessionStorage', 'set', key, val),
        [writeStorageArea]
    );

    const removeSessionStorage = useCallback(
        (key: string) => writeStorageArea('sessionStorage', 'remove', key, ''),
        [writeStorageArea]
    );

    // --- Cookie ---
    // 与存储同一口径：每次现取活动 webview，不缓存引用。
    // 地址取 webview 自身的 URL 而不是标签页状态里的那份 —— 后者可能落后一帧，
    // 而 cookies.get 拿到过期地址会查到错误的域的 cookie。

    const getCookies = useCallback(async (): Promise<CookieItem[]> => {
        const electronAPI = getElectronAPI();
        const webview = deps.getActiveWebview();
        const url = webview ? readWebviewUrlSafe(webview) : '';
        // 空白页 / about:blank 没有可查的 cookie。不能传空串：
        // cookies.get({ url: '' }) 的含义是**该 session 的全部 cookie**。
        if (!electronAPI || !isRealUrl(url)) return [];
        try {
            return await electronAPI.getCookies(url);
        } catch {
            return [];
        }
    }, [deps.getActiveWebview]);

    /**
     * 覆盖一条 Cookie。
     *
     * httpOnly / sameSite / expirationDate 必须原样带上 —— cookies.set 是整条覆盖：
     * 漏掉 httpOnly 会把 HttpOnly 会话 cookie 降级成 JS 可读的普通 cookie，
     * 漏掉 expirationDate 会把持久 cookie 变成会话 cookie（关掉窗口就掉登录态）。
     * 改一个字符的代价不该是会话失效。
     */
    const setCookie = useCallback(async (cookie: CookieItem): Promise<boolean> => {
        const electronAPI = getElectronAPI();
        const webview = deps.getActiveWebview();
        const url = webview ? readWebviewUrlSafe(webview) : '';
        if (!electronAPI || !isRealUrl(url)) return false;

        // 逐字段判 undefined 而不是整包透传：显式 undefined 经 IPC 传过去
        // 与"不传"在 Electron 侧未必等价，而这些字段缺失会被当成"用默认值"，
        // 默认值恰恰是降级后的形态。
        const details: Record<string, unknown> = { url, name: cookie.name, value: cookie.value };
        if (cookie.domain !== undefined) details.domain = cookie.domain;
        if (cookie.path !== undefined) details.path = cookie.path;
        if (cookie.secure !== undefined) details.secure = cookie.secure;
        if (cookie.httpOnly !== undefined) details.httpOnly = cookie.httpOnly;
        if (cookie.sameSite !== undefined) details.sameSite = cookie.sameSite;
        if (cookie.expirationDate !== undefined) details.expirationDate = cookie.expirationDate;

        try {
            await electronAPI.setCookie(details);
            return true;
        } catch {
            return false;
        }
    }, [deps.getActiveWebview]);

    const removeCookie = useCallback(async (name: string): Promise<boolean> => {
        const electronAPI = getElectronAPI();
        const webview = deps.getActiveWebview();
        const url = webview ? readWebviewUrlSafe(webview) : '';
        if (!electronAPI || !isRealUrl(url)) return false;
        try {
            await electronAPI.removeCookie(url, name);
            return true;
        } catch {
            return false;
        }
    }, [deps.getActiveWebview]);

    const actions = useMemo(() => ({
        saveRules,
        applyRules,
        getLocalStorage,
        getSessionStorage,
        setLocalStorage,
        removeLocalStorage,
        setSessionStorage,
        removeSessionStorage,
        getCookies,
        setCookie,
        removeCookie
    }), [
        saveRules, applyRules, getLocalStorage, getSessionStorage, setLocalStorage,
        removeLocalStorage, setSessionStorage, removeSessionStorage,
        getCookies, setCookie, removeCookie
    ]);

    return useMemo(() => ({
        state: { interceptRules, requestRules, headerRules },
        actions
    }), [interceptRules, requestRules, headerRules, actions]);
};

/* -------------------------------------------------------------------------- */
/*                             内部：网页下载                                   */
/* -------------------------------------------------------------------------- */

/**
 * 网页自身触发的下载。
 *
 * **状态的真值在主进程**：DownloadItem 只在那边存在，暂停/继续能不能成功
 * 还取决于服务器是否支持 Range 请求。所以这里只做两件事：
 *
 *   1. 订阅主进程推来的快照，按 id 合并进列表；
 *   2. 把用户操作转成 IPC 发回去，**不做乐观更新** —— 本地先改成"已暂停"
 *      而实际还在下，是比不响应更糟的界面。
 *
 * 合并按 id 而不是整体替换：主进程那边有记录上限（会淘汰旧条目），
 * 整体替换会让被淘汰的记录在界面上凭空消失，而用户可能正在看它。
 */
const useDownloads = (): DownloadsState => {
    const [items, setItems] = useState<BrowserDownload[]>([]);

    const upsert = useCallback((incoming: BrowserDownload) => {
        if (!incoming || !incoming.id) return;
        setItems((prev) => {
            const idx = prev.findIndex((d) => d.id === incoming.id);
            if (idx < 0) return [incoming, ...prev];
            const next = prev.slice();
            next[idx] = incoming;
            return next;
        });
    }, []);

    useEffect(() => {
        const electronAPI = getElectronAPI();
        const bridge = electronAPI?.browser;
        if (!bridge) return;

        const unsubscribe = bridge.onDownload(upsert);
        // 首次拉一次历史：订阅只覆盖"订阅之后"的事件，面板打开时
        // 之前已经下完的东西不补一次就永远看不到
        void bridge.downloads().then((list) => {
            if (Array.isArray(list)) setItems(list);
        }).catch(() => { /* 主进程还没就绪，忽略 */ });

        return typeof unsubscribe === 'function' ? unsubscribe : undefined;
    }, [upsert]);

    const run = useCallback(async (id: string, action: BrowserDownloadAction) => {
        const bridge = getElectronAPI()?.browser;
        if (!bridge) return;
        try {
            const result = await bridge.downloadAction(id, action);
            // remove 是唯一由渲染层自己收敛的操作：主进程删完不会再推快照
            if (action === 'remove' && result?.success) {
                setItems((prev) => prev.filter((d) => d.id !== id));
            }
        } catch (e) {
            console.error('下载操作失败:', action, e);
        }
    }, []);

    const actions = useMemo(() => ({
        pause: (id: string) => run(id, 'pause'),
        resume: (id: string) => run(id, 'resume'),
        cancel: (id: string) => run(id, 'cancel'),
        reveal: (id: string) => run(id, 'reveal'),
        open: (id: string) => run(id, 'open'),
        remove: (id: string) => run(id, 'remove'),
        clearFinished: () => {
            setItems((prev) => prev.filter((d) => d.state === 'progressing'));
        },
    }), [run]);

    const activeCount = useMemo(
        () => items.filter((d) => d.state === 'progressing').length,
        [items]
    );

    return useMemo(() => ({ items, activeCount, actions }), [items, activeCount, actions]);
};

/* -------------------------------------------------------------------------- */
/*                                  协调器                                      */
/* -------------------------------------------------------------------------- */

/**
 * 浏览引擎核心 Hook。
 *
 * 子模块顺序即依赖顺序：tabs / bookmarks / search 是基础状态，
 * interactions 在其上编排导航并持有 webview，sniffer 与 tamper 最后接入
 * （都需要 interactions 的 webview 访问器）。
 * 每个子 hook 的返回值都已 memo，因此这里的聚合 memo 才真正稳定。
 */
export const useBrowse = (): BrowseState => {
    const tabs = useTabs();
    const bookmarks = useBookmarks();
    const search = useSearch();

    const interactions = useInteractions({ tabs, search, bookmarks });

    const sniffer = useSniffer({
        getActiveWebview: interactions.getActiveWebview,
        activeTab: tabs.activeTab,
    });

    const tamper = useTamper({
        onPageReady: interactions.onPageReady,
        forEachWebview: interactions.forEachWebview,
        getActiveWebview: interactions.getActiveWebview,
    });

    const downloads = useDownloads();

    return useMemo(
        () => ({ tabs, bookmarks, search, sniffer, interactions, tamper, downloads }),
        [tabs, bookmarks, search, sniffer, interactions, tamper, downloads]
    );
};
