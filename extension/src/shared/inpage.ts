/**
 * 页内扫描：把"页面自己知道、网络层看不到"的媒体地址捞出来。
 *
 * ## 为什么必须有这一层
 *
 * `webRequest` 只能看见**开关打开之后**发生的请求。用户打开嗅探开关再刷新，
 * 或者切到一个早就加载完的标签页时，网络层一条都不会有 —— 而页面上明明在播。
 * 实测过：一个视频站的页面里 `video.src` 已经加载完、`__playinfo__` 里躺着
 * dash 轨、页面源码里还有一堆没被请求的直链，网络层全是空的。
 *
 * 旧实现（`新建文件夹/useBrowse.ts` 的 `IN_PAGE_INSPECTOR_SCRIPT`）有四条路：
 * 媒体元素、Performance API、播放器全局对象、页面源码正则。这四条在这里
 * 一一对应，一条都不少。
 *
 * ## 这个函数会被 `toString()` 之后送进页面
 *
 * `chrome.scripting.executeScript({ func })` 是把函数**序列化**再在目标页面里
 * 重新求值的。所以：
 *
 *   · **不能引用任何外层作用域的东西** —— 包括 import 进来的常量。哪怕
 *     TypeScript 编译通过，运行时那个标识符在页面里根本不存在，表现为
 *     "扫描静默返回空"。需要的表一律经 `args` 传进来（见 `ScanConfig`）。
 *   · **返回值必须可结构化克隆**（只放字符串、数字、数组、普通对象）。
 *
 * ## 分类不在这里做
 *
 * 这里只**枚举**候选地址，判定"是不是媒体、是哪种媒体"一律交给
 * `shared/classify.ts` 的 `classifyResponse` —— 那是唯一一份判据。在页面里
 * 再写一份的话，同一个地址走网络层与走页内扫描会得出两个结论。
 *
 * `hint` 只用于分类器**认不出**的那些地址：`<video src="/play?id=1">` 这种
 * 没有后缀、也没有 content-type 的，只能靠元素标签兜底。
 */

/** 扫描配置。全部经 `args` 传入，见文件头"会被 toString()" */
export interface ScanConfig {
    /**
     * 全部媒体后缀，用来构造页面源码正则。
     *
     * 它只是一张**采集用**的表（正则要拿它圈出候选），不是判据 ——
     * 判据仍在 `classifyResponse`。表由 service worker 从 `classify.ts`
     * 现取现传，所以两边不可能漂移。
     */
    allExts: string[];
    /** 候选地址总数上限。页面源码里几千个地址全送回 SW 是纯浪费 */
    limit: number;
    /** 页面源码只扫前这么多字符 */
    htmlLimit: number;
    /** 每条正则最多命中多少次 */
    matchLimit: number;
}

/**
 * 候选地址的来源。只有前四个会被当作"类型兜底"用。
 *
 * `perf` / `frame` / `source` 不带类型信息：Performance 里混着 JS 与 CSS，
 * iframe 多数是别的页面，源码正则更是捞到什么算什么。它们只负责"这个地址
 * 值得让分类器看一眼"，分类器认不出就丢掉。
 */
export type ScanHint =
    | 'video'
    | 'audio'
    | 'playinfo-video'
    | 'playinfo-audio'
    | 'perf'
    | 'frame'
    | 'source';

export interface ScanCandidate {
    url: string;
    hint: ScanHint;
    /** playinfo 轨道的序号标签（如「视频轨 1」）。其它来源为空 */
    label?: string;
}

export interface ScanResult {
    /** 扫描时的页面地址。由页面自己报，比 SW 那边再查一次更准 */
    pageUrl: string;
    pageTitle: string;
    items: ScanCandidate[];
}

/**
 * 在页面主世界里跑一次全面扫描。
 *
 * ⚠️ 改这个函数时守住文件头那两条：不引用外层、返回值可克隆。
 */
export const IN_PAGE_SCAN = (config: ScanConfig): ScanResult => {
    const items: ScanCandidate[] = [];
    const seen = new Set<string>();
    const pageUrl = location.href;
    const pageTitle = (document.title || '').trim();

    /**
     * 收一个候选地址。
     *
     * 相对地址在这里就解析成绝对地址：页面里的 `src="/a/b.mp4"` 送回去之后
     * SW 已经不知道它是相对谁的了，而在 SW 里补解析要再查一次页面地址 ——
     * 那个值还可能已经变了（用户切页）。
     */
    const push = (raw: unknown, hint: ScanHint, label?: string): void => {
        if (typeof raw !== 'string') return;
        const text = raw.trim();
        if (!text) return;
        /*
         * `blob:` 是页面自己那块内存的句柄，不是可下载的远端资源 ——
         * MSE 播放的站点上 `<video src>` 几乎总是它，收进来只会得到一条
         * 点下载必然失败的记录。
         */
        if (/^(blob|data|javascript|about|chrome|chrome-extension|file|devtools):/i.test(text)) return;

        let url = '';
        try {
            url = new URL(text, pageUrl).href;
        } catch {
            return;
        }
        if (url === pageUrl || seen.has(url)) return;
        seen.add(url);
        if (items.length >= config.limit) return;
        items.push(label ? { url, hint, label } : { url, hint });
    };

    /* ---------------------------------------------------------------- */
    /* 1. 媒体元素：<video> / <audio> 自身与它们的 <source>               */
    /* ---------------------------------------------------------------- */

    document.querySelectorAll('video, audio').forEach((element) => {
        const hint: ScanHint = element.tagName.toLowerCase() === 'audio' ? 'audio' : 'video';
        const media = element as HTMLMediaElement;
        // currentSrc 是**实际在播**的那个（MSE 站点上常是 blob:，上面已拦掉），
        // src 是标签上写的那个 —— 两个都收，它们可能不同
        push(media.currentSrc, hint);
        push(media.getAttribute('src'), hint);
        element.querySelectorAll('source').forEach((source) => {
            push(source.getAttribute('src'), hint);
        });
    });

    /* ---------------------------------------------------------------- */
    /* 2. Performance API：页面已经发生过的全部资源请求                    */
    /* ---------------------------------------------------------------- */

    try {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        // 从新往旧：候选上限是按"先到先得"截断的，倒序遍历才能保住最新的那些
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const initiator = entries[i].initiatorType;
            const hint: ScanHint = initiator === 'video' ? 'video' : initiator === 'audio' ? 'audio' : 'perf';
            push(entries[i].name, hint);
        }
    } catch {
        // 隐私模式或极老的引擎上 performance 可能不可用。少一条路不影响其它四条
    }

    /* ---------------------------------------------------------------- */
    /* 3. 播放器全局对象：B 站的 __playinfo__ 等                          */
    /* ---------------------------------------------------------------- */

    try {
        const info = (window as unknown as {
            __playinfo__?: {
                data?: {
                    dash?: { video?: unknown[]; audio?: unknown[] };
                    durl?: unknown[];
                };
            };
        }).__playinfo__;

        const data = info?.data;
        const takeTracks = (list: unknown[] | undefined, hint: ScanHint, name: string): void => {
            if (!Array.isArray(list)) return;
            list.forEach((raw, index) => {
                const track = (raw || {}) as { baseUrl?: string; base_url?: string; url?: string };
                push(track.baseUrl || track.base_url || track.url, hint, `${name} ${index + 1}`);
            });
        };

        takeTracks(data?.dash?.video, 'playinfo-video', '视频轨');
        takeTracks(data?.dash?.audio, 'playinfo-audio', '音频轨');
        takeTracks(data?.durl, 'playinfo-video', '视频');
    } catch {
        // 站点可能用 getter 抛错（反调试）
    }

    /* ---------------------------------------------------------------- */
    /* 4. iframe：很多嵌入播放器在子框架里                                */
    /* ---------------------------------------------------------------- */

    document.querySelectorAll('iframe').forEach((frame) => {
        push(frame.getAttribute('src'), 'frame');
    });

    /* ---------------------------------------------------------------- */
    /* 5. 页面源码正则：捞那些从没被请求过的直链                          */
    /* ---------------------------------------------------------------- */

    try {
        const html = document.documentElement.outerHTML.slice(0, config.htmlLimit);
        const group = config.allExts.join('|');
        /*
         * 两条模式，与旧实现的 `extractLinksLocally` 同覆盖：
         *   1. 绝对地址，含 JSON 里转义过的 `https:\/\/` 形态；
         *   2. 引号包起来的相对地址。
         *
         * 正则里的 `\\` 是**正则源码**里的转义（匹配一个反斜杠），写成字符串时
         * 要再翻一倍 —— 这里用的是单引号字符串，不是正则字面量。
         */
        const patterns = [
            new RegExp('https?:\\\\?/\\\\?/[^\\s"\'<>]+\\.(?:' + group + ')(?:\\?[^\\s"\'<>]*)?', 'gi'),
            new RegExp('["\']((?:/|\\./|\\.\\./)[^"\']*\\.(?:' + group + ')(?:\\?[^"\']*)?)["\']', 'gi'),
        ];

        for (const pattern of patterns) {
            let match: RegExpExecArray | null = null;
            let guard = 0;
            while ((match = pattern.exec(html)) !== null && guard < config.matchLimit) {
                guard += 1;
                push(match[1] || match[0], 'source');
            }
        }
    } catch {
        // outerHTML 在少数文档上会抛（XML 文档、已卸载的框架）
    }

    return { pageUrl, pageTitle, items };
};
