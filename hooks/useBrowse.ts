import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Bookmark,
    CookieItem,
    DownloadCapabilities,
    DownloadMediaResult,
    FoundLink,
    HeaderRule,
    MediaDownloadProgress,
    MediaType,
    TamperRule,
    WebviewElement,
    getAppWindow,
    getElectronAPI,
} from '../meta';
import { extractMediaLinks } from '../services/AiService';
import { loadJSON, loadStr, saveJSON, saveStr } from '../utils/persist';
import { MEDIA_EXTENSIONS, generateId, isAcgUrl, isLinkFromPage, isRealUrl } from '../utils/utils';

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
 * 抽成纯函数后由 scripts/test 直接求值断言。它们不持有任何状态，
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
 * 页内脚本的流媒体后缀刻意不含 `ts`。
 * 原逻辑里 `.ts` 走单独分支：先判是不是 HLS 分片，是则丢弃，
 * 不是则保持 defaultType（'other' 时最终丢弃）。把它并进 streamExts
 * 会让所有分片先被标成 stream 再走后面的兜底，语义就变了。
 */
const INSPECTOR_STREAM_EXTS = CATEGORIES.stream.filter((ext) => ext !== 'ts');

const TABS_STORE_KEY = 'browse-tabs';
const TABS_STORE_MAX = 20;
const BOOKMARKS_STORE_KEY = 'react-player-bookmarks';
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

/** 只有这三种协议会被当作"用户就是要访问这个地址"，其余一律退回搜索 */
const SAFE_SCHEME_RE = /^(https?|file):\/\//i;
const LOCALHOST_RE = /^localhost(:\d{1,5})?(\/.*)?$/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?(\/.*)?$/;
/**
 * 裸域名。TLD 不限长度 —— 旧版写死 `[a-z]{2,5}`，`example.museum`、`a.technology`
 * 这类合法域名会被误判成搜索词。
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(:\d{1,5})?(\/.*)?$/i;

const isUrlLike = (target: string): boolean => {
    // 含空白的输入几乎不可能是 URL（`site.com/a b` 也按搜索处理）
    if (/\s/.test(target)) return false;
    if (SAFE_SCHEME_RE.test(target)) return true;
    if (LOCALHOST_RE.test(target)) return true;
    if (IPV4_RE.test(target)) return true;
    return HOSTNAME_RE.test(target);
};

/**
 * 地址栏要按同一判据决定"这是地址还是搜索词"：是地址就不该显示搜索引擎选择器，
 * 是搜索词才显示。导出的是**上面那一份实现**，不是抄一遍 ——
 * 抄一份的话，这里显示"搜索 Bing"、回车却当网址打开，是最难被发现的一类不一致。
 */
export const isAddressLike = (input: string): boolean => isUrlLike(input.trim());

/* -------------------------------------------------------------------------- */
/*                              页内嗅探脚本                                    */
/* -------------------------------------------------------------------------- */

const IN_PAGE_INSPECTOR_SCRIPT = `
(() => {
  const results = [];
  const seen = new Set();
  const pageTitle = (document.title || '').trim();
  const pageUrl = window.location.href;

  const streamExts = ${JSON.stringify(INSPECTOR_STREAM_EXTS)};
  const videoExts = ${JSON.stringify(CATEGORIES.video)};
  const audioExts = ${JSON.stringify(CATEGORIES.audio)};
  const imageExts = ${JSON.stringify(CATEGORIES.image)};

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
    let type = defaultType || 'other';

    if (streamExts.includes(ext) || url.includes('.m3u8') || url.includes('.mpd')) {
      type = 'stream';
      ext = ext || (url.includes('.mpd') ? 'mpd' : 'm3u8');
    } else if (videoExts.includes(ext) || url.includes('.mp4') || url.includes('.webm') || url.includes('.m4s')) {
      type = 'video';
      ext = ext || 'mp4';
    } else if (audioExts.includes(ext) || url.includes('.mp3') || url.includes('.m4a')) {
      type = 'audio';
      ext = ext || 'mp3';
    } else if (imageExts.includes(ext)) {
      type = 'image';
      ext = ext || 'jpg';
    }

    // 智能兜底扩展名
    if (!ext) {
      if (type === 'video') ext = 'mp4';
      else if (type === 'audio') ext = 'mp3';
      else if (type === 'stream') ext = 'm3u8';
      else if (type === 'image') ext = 'jpg';
    }

    // 过滤 TS 切片分段
    if (ext === 'ts') {
      const isSegment = /\\b(seg|chunk|slice|frag|part|track|\\d{2,})\\b/i.test(pathname) || /[-_]\\d+\\.ts/i.test(pathname);
      if (isSegment && !url.includes('playlist')) return null;
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
    /** 待处理的导航动作（由 interactions 落到 webview API） */
    pendingNavigation?: 'back' | 'forward';
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
        openInNewTab: (url: string) => void;
        syncTabUrl: (tabId: string, url: string, historyIndex?: number) => void;
        clearPendingNavigation: (tabId: string) => void;
    };
}

export interface BookmarksState {
    bookmarks: Bookmark[];
    isBookmarked: (url: string) => boolean;
    toggleBookmark: (url: string, title?: string) => void;
    removeBookmark: (id: string) => void;
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
    error: string;
    downloadingUrl: string;
    /** 当前下载的实时进度；没有下载在进行时为 null */
    downloadProgress: MediaDownloadProgress | null;
    downloadCapabilities: DownloadCapabilities;
    actions: {
        /** runId：同一轮多次扫描共用一个序号，过期轮次的结果与状态更新会被丢弃 */
        scan: (targetUrl?: string, runId?: number) => Promise<void>;
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

export interface InteractionsState {
    inputUrl: string;
    setInputUrl: (url: string) => void;
    /**
     * 地址栏聚焦状态。地址栏必须在聚焦时**停止跟随** activeTab.url，
     * 否则 SPA 的 in-page 导航会把用户正在敲的地址覆盖掉（见 useInteractions 内注释）。
     */
    setInputFocused: (focused: boolean) => void;
    isElectron: boolean;
    isCurrentPageBookmarked: boolean;
    handleNavigate: (urlOrQuery: string) => void;
    handleOpenInNewTab: (url: string) => void;
    onLoadFinish: (tabId: string) => void;
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
    registerIframe: (id: string, el: HTMLIFrameElement | null) => void;
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
            if (history[history.length - 1] === url) {
                // 已停在同一地址：只更新加载态与标题，不新增历史项
                return { ...tab, url, title, isLoading };
            }
            history.push(url);
            return {
                ...tab,
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
            const next = title.trim() || getTitleFromUrl(tab.url);
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
        })));
    }, []);

    const reload = useCallback((tabId: string) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            tab.url ? { ...tab, isLoading: true, reloadKey: (tab.reloadKey || 0) + 1 } : tab
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
        setState((prev) => mapTab(prev, tabId, (tab) => ({
            ...tab,
            url,
            historyIndex: historyIndex !== undefined ? historyIndex : tab.historyIndex,
        })));
    }, []);

    const clearPendingNavigation = useCallback((tabId: string) => {
        setState((prev) => mapTab(prev, tabId, (tab) => (
            tab.pendingNavigation ? { ...tab, pendingNavigation: undefined } : tab
        )));
    }, []);

    const actions = useMemo(() => ({
        createTab, closeTab, switchTab, navigateTab, updateTabTitle, setTabLoading,
        goBack, goForward, goHome, reload, openInNewTab, syncTabUrl, clearPendingNavigation,
    }), [
        createTab, closeTab, switchTab, navigateTab, updateTabTitle, setTabLoading,
        goBack, goForward, goHome, reload, openInNewTab, syncTabUrl, clearPendingNavigation,
    ]);

    return useMemo(() => ({ tabs, activeTabId, activeTab, actions }), [tabs, activeTabId, activeTab, actions]);
};

/* -------------------------------------------------------------------------- */
/*                               内部：书签                                     */
/* -------------------------------------------------------------------------- */

/**
 * 书签条目校验 + 归一化。
 *
 * title 是**必填展示字段**（HomePage 直接 bm.title.substring(0, 2) 取首字做图标），
 * 只校验 id/url 会让缺 title 的历史脏数据一路走到渲染层崩掉整个快速访问页。
 * 这里把缺失/非字符串的 title 补成 hostname，坏数据在入口就被修好。
 */
const normalizeBookmark = (b: unknown): Bookmark | null => {
    if (!b || typeof b !== 'object') return null;
    const raw = b as Partial<Bookmark>;
    if (typeof raw.id !== 'string' || typeof raw.url !== 'string' || raw.url.length === 0) return null;
    const title = typeof raw.title === 'string' && raw.title.trim()
        ? raw.title
        : getTitleFromUrl(raw.url);
    return {
        id: raw.id,
        url: raw.url,
        title,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    };
};

const DEFAULT_BOOKMARKS: Bookmark[] = [
    { id: '1', title: 'Google', url: 'https://www.google.com', createdAt: 0 },
    { id: '2', title: 'Bing', url: 'https://www.bing.com', createdAt: 0 },
    { id: '3', title: 'YouTube', url: 'https://www.youtube.com', createdAt: 0 },
    { id: '4', title: 'Bilibili', url: 'https://www.bilibili.com', createdAt: 0 },
];

/**
 * 初始化：从 LocalStorage 读取书签。
 * 放在 lazy initializer 而不是 effect 里 —— 用 effect 会先渲染一帧空列表再填上，
 * 且"初始化"与"写盘"两个 effect 的先后顺序决定了会不会把默认书签覆盖掉用户数据。
 */
const loadStoredBookmarks = (): Bookmark[] => {
    try {
        const saved = loadStr(BOOKMARKS_STORE_KEY, '', '');
        if (saved) {
            const parsed: unknown = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                // 坏条目只丢弃，不崩；空数组视为"用户清空过"，同样尊重。
                // 取最新的若干条（slice(-MAX)）：条目按收藏顺序追加，末尾最新，
                // slice(0, MAX) 会在攒够上限后把磁盘副本冻结在最早那批 ——
                // 之后无论再收藏什么，重启后都看不到。
                return parsed
                    .map(normalizeBookmark)
                    .filter((b): b is Bookmark => b !== null)
                    .slice(-BOOKMARKS_MAX);
            }
        }
    } catch (e) {
        console.error('加载书签失败:', e);
    }
    const defaults = DEFAULT_BOOKMARKS.map((b) => ({ ...b, createdAt: Date.now() }));
    saveStr(BOOKMARKS_STORE_KEY, JSON.stringify(defaults), '');
    return defaults;
};

const useBookmarks = (): BookmarksState => {
    const [bookmarks, setBookmarks] = useState<Bookmark[]>(loadStoredBookmarks);

    /**
     * 写盘只做追加式快照，不读回。
     * 所有变更走函数式更新：旧实现基于闭包里的 bookmarks 快照计算新数组，
     * 连点两次"收藏"会两次都读到旧列表，第二次把第一次的结果覆盖掉。
     *
     * 落盘时收敛到上限（取最新）：上限原本只在读回侧生效，内存态与磁盘态
     * 可以无限增长，配额爆掉后 saveStr 静默返回 false —— 表现为"收藏了但没存住"。
     */
    useEffect(() => {
        saveStr(BOOKMARKS_STORE_KEY, JSON.stringify(bookmarks.slice(-BOOKMARKS_MAX)), '');
    }, [bookmarks]);

    const isBookmarked = useCallback((url: string) => {
        return bookmarks.some((b) => b.url === url);
    }, [bookmarks]);

    /** 切换收藏状态（存在则删除，不存在则添加） */
    const toggleBookmark = useCallback((url: string, title: string = '新书签') => {
        if (!url) return;
        let finalTitle = title;
        try {
            if (!title || title === '新书签') finalTitle = new URL(url).hostname;
        } catch { /* 非法 URL 保留传入标题 */ }

        setBookmarks((prev) => {
            if (prev.some((b) => b.url === url)) {
                return prev.filter((b) => b.url !== url);
            }
            return [...prev, { id: generateId(), url, title: finalTitle, createdAt: Date.now() }];
        });
    }, []);

    const removeBookmark = useCallback((id: string) => {
        setBookmarks((prev) => prev.filter((b) => b.id !== id));
    }, []);

    return useMemo(
        () => ({ bookmarks, isBookmarked, toggleBookmark, removeBookmark }),
        [bookmarks, isBookmarked, toggleBookmark, removeBookmark]
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
    const parseInputToUrl = useCallback((input: string): string => {
        const target = input.trim();
        if (!target) return '';
        if (!isUrlLike(target)) {
            return `${ENGINE_URLS[engine]}${encodeURIComponent(target)}`;
        }
        if (SAFE_SCHEME_RE.test(target)) return target;
        return `https://${target}`;
    }, [engine]);

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

    // DOM 引用（不要用 state 存 webview，会触发 React DevTools 跨域错误）
    const webviewRefs = useRef<Map<string, WebviewElement>>(new Map());
    const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
    // webview 是否已 ready（dom-ready 之后才能安全调用 API）
    const webviewReadyRefs = useRef<Set<string>>(new Set());
    // 刷新请求的上一轮 reloadKey
    const prevReloadKeys = useRef<Record<string, number>>({});
    // 正在进行的前进后退（did-navigate 时据此判断要不要新增历史）
    const pendingHistoryNav = useRef<Map<string, 'back' | 'forward'>>(new Map());
    // webview 尚未 ready 时暂存的待导航地址
    const pendingNavigations = useRef<Map<string, string>>(new Map());
    // 「页面就绪」订阅者（篡改引擎的注入挂在这里）
    const pageReadyListeners = useRef<Set<(tabId: string, webview: WebviewElement) => void>>(new Set());
    // 每个标签页上一次广播时的 URL：SPA 的 in-page 导航据此去重，
    // 否则脚本自己点击链接 → 导航 → 再触发脚本，会形成回环
    const lastPageReadyUrl = useRef<Map<string, string>>(new Map());

    // 最新值镜像：事件回调里必须读到当前 tabs/activeTabId，而不是绑定时的快照。
    // 走 effect 而非渲染期赋值：并发渲染下被丢弃的那次渲染不应污染 ref。
    const tabsRef = useRef(tabsState.tabs);
    useEffect(() => { tabsRef.current = tabsState.tabs; }, [tabsState.tabs]);
    const activeTabIdRef = useRef(activeTabId);
    useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

    const isElectron = useMemo(
        () => !!(getElectronAPI() || getAppWindow().process?.isElectron),
        []
    );

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
            } else {
                // iframe 的 history API 受同源策略限制，只能重设 src
                const iframe = iframeRefs.current.get(tab.id);
                if (iframe && iframe.src !== tab.url) {
                    iframe.src = tab.url;
                }
            }
        });
    }, [tabsState.tabs]);

    // 3. 核心导航：空白页就地跳转，已有内容则开新标签页
    const handleNavigate = useCallback((urlOrQuery: string) => {
        const finalUrl = parseInputToUrl(urlOrQuery);
        if (!finalUrl) return;

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

    // 4. 页面加载结束
    const onLoadFinish = useCallback((tabId: string) => {
        tabActions.setTabLoading(tabId, false);
    }, [tabActions]);

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

            broadcastPageReady(tabId, webview);

            const pendingUrl = pendingNavigations.current.get(tabId);
            if (pendingUrl) {
                try {
                    if (webview.getURL?.() !== pendingUrl) void webview.loadURL(pendingUrl);
                    pendingNavigations.current.delete(tabId);
                } catch (e) {
                    console.error('Failed to navigate pending URL:', e);
                }
            }
        };

        const handleFinish = () => tabActions.setTabLoading(tabId, false);
        const handleFail = () => tabActions.setTabLoading(tabId, false);

        // 真实标题（旧实现从未监听，标签页因此永远显示域名）
        const handleTitle = (e: Event) => {
            const title = (e as Event & { title?: string }).title;
            if (title) tabActions.updateTabTitle(tabId, title);
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
        webview.addEventListener('did-navigate', handleNavigateInternal);
        webview.addEventListener('did-navigate-in-page', handleInPageNavigate);
        // 注意：不再监听 'new-window'。Electron 44 的 <webview> 已移除该事件，
        // 新窗口统一由主进程 setWindowOpenHandler → navigate-to-url IPC 处理。

        (webview as any).__listenersAttached = true;
    }, [tabActions]);

    // 6. 注册 / 注销 webview 引用
    const registerWebview = useCallback((id: string, el: WebviewElement | null) => {
        if (el) {
            webviewRefs.current.set(id, el);
            if (isElectron) {
                attachWebviewListeners(id, el);
                // 挂载时可能已经 ready（事件早于监听绑定），补一次探测
                window.setTimeout(() => {
                    try {
                        if (el.getURL?.()) webviewReadyRefs.current.add(id);
                    } catch { /* webview 已卸载 */ }
                }, 100);
            }
            return;
        }
        webviewRefs.current.delete(id);
        webviewReadyRefs.current.delete(id);
        // 关闭标签页后清理该页暂存状态，避免残留导致误导航
        pendingNavigations.current.delete(id);
        pendingHistoryNav.current.delete(id);
        lastPageReadyUrl.current.delete(id);
        delete prevReloadKeys.current[id];
    }, [isElectron, attachWebviewListeners]);

    const registerIframe = useCallback((id: string, el: HTMLIFrameElement | null) => {
        if (el) iframeRefs.current.set(id, el);
        else iframeRefs.current.delete(id);
    }, []);

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

    // 8. 刷新请求
    useEffect(() => {
        tabsState.tabs.forEach((tab) => {
            const prev = prevReloadKeys.current[tab.id] || 0;
            if (tab.reloadKey <= prev) return;
            prevReloadKeys.current[tab.id] = tab.reloadKey;

            const webview = webviewRefs.current.get(tab.id);
            if (webview) {
                try { webview.reload(); } catch (e) { console.error(e); }
                return;
            }
            const iframe = iframeRefs.current.get(tab.id);
            if (iframe?.contentWindow) {
                try { iframe.contentWindow.location.reload(); } catch (e) { console.error(e); }
            }
        });
    }, [tabsState.tabs]);

    // 9. 前进 / 后退请求
    useEffect(() => {
        tabsState.tabs.forEach((tab) => {
            if (!tab.pendingNavigation) return;
            const webview = webviewRefs.current.get(tab.id);

            if (webview && webviewReadyRefs.current.has(tab.id)) {
                try {
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

    // 供 Tamper 等外部调用
    const getActiveWebview = useCallback(
        () => webviewRefs.current.get(activeTabIdRef.current) || null,
        []
    );

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

    return useMemo(() => ({
        inputUrl,
        setInputUrl,
        setInputFocused,
        isElectron,
        isCurrentPageBookmarked,
        handleNavigate,
        handleOpenInNewTab,
        onLoadFinish,
        getWebviewRef,
        registerIframe,
        getActiveWebview,
        onPageReady,
        forEachWebview,
    }), [
        inputUrl, isElectron, isCurrentPageBookmarked, handleNavigate, handleOpenInNewTab,
        onLoadFinish, getWebviewRef, registerIframe, getActiveWebview,
        onPageReady, forEachWebview, setInputFocused,
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

/** 读 webview 当前 URL。webview 卸载后调用会抛，统一吞掉返回空串 */
const readWebviewUrlSafe = (webview: WebviewElement): string => {
    try { return webview.getURL?.() || ''; } catch { return ''; }
};
/** ACG 专属资源与本地文件一律不进嗅探列表（所有入库通道统一在此拦截） */
const isSniffable = (item: FoundLink | null | undefined): boolean =>
    !!item && typeof item.url === 'string' &&
    !isFileUrl(item.url) && !isFileUrl(item.pageUrl) && !isFileUrl(item.referer) &&
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
     * （App 的 effect 连扫三轮）→ scan(B) 很快结束、置 false →
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
        const all = ['all', ...Object.keys(CATEGORIES)] as (MediaType | 'all')[];
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

    const addLinks = useCallback((newLinks: FoundLink[]) => {
        const usable = (newLinks || []).filter(isSniffable);
        if (usable.length === 0) return;

        setFoundLinks((prev) => {
            const map = new Map<string, FoundLink>();
            prev.forEach((item) => map.set(item.url, item));

            usable.forEach((item) => {
                const existing = map.get(item.url);
                if (existing) {
                    // 现有标题普通而新标题更好时更新
                    if (item.title && item.title !== existing.title && existing.title.startsWith('Media_')) {
                        map.set(item.url, { ...existing, ...item });
                    }
                    return;
                }

                let enhancedTitle = item.title;
                const cleanTitle = (enhancedTitle || '').replace(/\.[a-zA-Z0-9]+$/, '');
                const isGeneric =
                    !enhancedTitle ||
                    /^(media_|detected|hls|playlist|index|stream|chunk)/i.test(enhancedTitle) ||
                    /^[0-9a-f]{16,}$/i.test(cleanTitle) ||
                    /^\d{8,}$/.test(cleanTitle);
                if (isGeneric && activeTabRef.current?.title) {
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

    // 主进程网络层推送
    useEffect(() => {
        const electronAPI = getElectronAPI();
        if (!electronAPI?.onSniffedMedia) return;
        return electronAPI.onSniffedMedia((media) => {
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
                ffmpegMessage: '当前为浏览器环境，仅支持普通文件下载。',
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
     * App 在 URL 变化时会连扫三次（立即 + 1.5s + 3.5s，等 SPA 把资源渲染出来），
     * 三次共用同一个 runId。用户快速切页时旧页面的迟到轮次必须作废，
     * 否则会把上一页的资源写进当前列表、并抢走新轮次的加载态。
     * 不传 runId（如悬浮球的"重新扫描"）视为始终有效。
     */
    const latestRunRef = useRef<number | null>(null);
    const isCurrentRun = useCallback(
        (runId?: number) => runId === undefined || latestRunRef.current === runId,
        []
    );

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
                    setStatusMessage('嗅探扫描完成，网络监听持续捕捉中。');
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
                        try {
                            const response = await fetch(targetUrl);
                            const contentType = response.headers.get('content-type') || '';
                            if (response.ok && (/text|html|json|xml|javascript/i.test(contentType) || !contentType)) {
                                content = await response.text();
                            }
                        } catch { /* 无内容可分析 */ }
                    }
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

        if (link.type === 'stream' && !downloadCapabilities.ffmpegAvailable) {
            const message = downloadCapabilities.ffmpegMessage || '当前无法下载流媒体资源。';
            setError(message);
            setStatusMessage(message);
            return { success: false, message };
        }

        setDownloadingUrl(link.url);
        setDownloadProgress(null);
        setError('');
        setStatusMessage(link.type === 'stream' ? '正在使用 ffmpeg 下载流媒体...' : '正在下载资源...');

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
        scan, analyzeWithAi, setFilterType, setScopeFilter, clear, clearCurrentPage, download, cancelDownload,
    }), [scan, analyzeWithAi, clear, clearCurrentPage, download, cancelDownload]);

    return useMemo(() => ({
        foundLinks,
        filteredLinks,
        isAnalyzing,
        statusMessage,
        filterType,
        scopeFilter,
        error,
        downloadingUrl,
        downloadProgress,
        downloadCapabilities,
        actions,
    }), [
        foundLinks, filteredLinks, isAnalyzing, statusMessage, filterType,
        scopeFilter, error, downloadingUrl, downloadProgress, downloadCapabilities, actions,
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

    return useMemo(
        () => ({ tabs, bookmarks, search, sniffer, interactions, tamper }),
        [tabs, bookmarks, search, sniffer, interactions, tamper]
    );
};
