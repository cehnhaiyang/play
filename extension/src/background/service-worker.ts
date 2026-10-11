/**
 * MV3 service worker：嗅探、Cookie、下载、Agent 引擎。
 *
 * ## 三条必须守住的 MV3 约束
 *
 * 1. **监听器只能在顶层同步注册。**
 *    service worker 空闲约 30 秒就被终止，下次事件到来时重新求值本文件。
 *    如果注册写在 `async` 函数里或 `await` 之后，重启后事件就没人听了 ——
 *    表现为"用一会儿就不工作了"。所以下面所有 `addListener` 都在模块顶层，
 *    不包任何异步外壳。
 *
 * 2. **内存状态要有落盘副本，且落盘不能拖慢热路径。**
 *    开关与结果都落 `chrome.storage`，但**读一律走内存镜像**（见 `sniffItems`）。
 *    每次写入都去 `storage.get` 一次读回全量是错的：那是 O(n) 的，
 *    页面上几百个响应涌进来时会把主路径从毫秒级拖到秒级 ——
 *    表现为"嗅探结果出得极慢"，而单看任何一个函数都看不出问题。
 *
 * 3. **没有 DOM。**
 *    `document`、`window`、`localStorage` 都不存在。所以共享的 `const.ts`
 *    只能取它的纯函数与常量，不能碰它的存储工具函数。
 */
import {
    classifyByExt,
    classifyResponse,
    deriveTitle,
    pathExtOf,
    pathnameOf,
    AUDIO_EXTS,
    IMAGE_EXTS,
    STREAM_EXTS,
    VIDEO_EXTS,
} from '../shared/classify';
import { IN_PAGE_SCAN, type ScanCandidate, type ScanConfig } from '../shared/inpage';
import {
    MAX_SNIFFED_ITEMS,
    STORAGE_KEYS,
    type BallEvent,
    type BallRequest,
    type ExtensionResponse,
    type SniffedMedia,
} from '../shared/protocol';
import type { MediaType } from '../../../shared/meta';
import { agentBridge } from './agent-bridge';
import { emitBridgeEvent, ensureBridge, setDispatcher } from './bridge-port';
import { pageHost } from '../offscreen/page-host';
import { applyRules, loadRules, injectRules } from './tamper';
import type { AgentEngine } from '../agent/engine';
import { isGenericTitle, isLinkFromPage } from '../../../shared/core/sniff';
import type { CookieItem, HeaderRule, TamperRule } from '../../../shared/meta';

/* ========================================================================== */
/* 1. 状态：一律落 storage，内存只做缓存                                       */
/* ========================================================================== */

/**
 * 写盘去抖窗口。
 *
 * 取 200ms：一次页面加载的几十条结果通常落在同一个窗口里，合并成一次写；
 * 而用户手动点"清空"之后最多 200ms 盘上就同步了，不需要为它单独走一条同步路径。
 */
const FLUSH_DEBOUNCE_MS = 200;

/**
 * 嗅探结果的**内存镜像**，也是热路径上唯一被读的那一份。
 *
 * ## 为什么必须有它
 *
 * 原先是每次写入都 `storage.session.get` 读回全量数组、push、再整体写回。
 * 单条代价看着很小（读 500 条约 8ms、写 500 条约 58ms），但两个问题叠在一起
 * 就致命：
 *
 *   1. **写是 O(n)**。第 k 条要序列化 k 条记录，n 条下来总量是 O(n²)；
 *   2. **写是串行的**（原来的 `serialize` 闸门）。一页几百个响应几乎同时
 *      到达时，每个响应都要排在自己前面所有写操作之后，而每个写操作又越来越贵。
 *
 * 实测（`tools/_sniff-latency.js`，一张图都没有的干净页面 → 带 300 个响应的页面）：
 *
 *     页面上 0 个无关响应    → 媒体结果落库    34 ms
 *     页面上 300 个无关响应  → 媒体结果落库  2867 ms
 *
 * 而真实网页动辄几百个请求，于是用户看到的就是"嗅探结果出得极其缓慢"。
 * 更糟的是 `getEnabled()` 也走 `chrome.storage`，它排在同一个事件循环上，
 * 于是连"要不要嗅探"这个判断本身都被拖慢。
 *
 * 改成内存镜像之后：判断与追加都是 O(1)，只有写盘是 O(n) 且**不阻塞追加**。
 *
 * ## 为什么不是"干脆不落盘"
 *
 * 结果要活过 service worker 的回收（空闲约 30 秒）—— 球下次打开时
 * `sniffer-get-state` 得拿得到东西。所以盘上那份还是要写，只是不再由它当权威。
 */
let sniffItems: SniffedMedia[] = [];
let sniffLoaded = false;

/**
 * 去重表：URL → 上次记录时间。
 *
 * 两条采集路径（网络层、页内扫描）都会撞上同一个地址，而它们的代价完全不同：
 * 网络层每条都要解析分类，页内扫描一次能吐几百条。没有这张表的话，一个视频站
 * 开着一晚上会把同一批分片地址反复推进列表。
 *
 * **丢了无害**（最多多记一条重复），所以留在内存里，不落盘。
 */
const recentUrls = new Map<string, number>();

/**
 * 同一 URL 在这个窗口内不重复记录。
 *
 * 取 5 秒而不是更长：有些站点用同一个地址轮询（`/api/live` 每次都是新内容），
 * 窗口太长会让"重新嗅探一次"看不出任何变化。而 5 秒足够盖住
 * "网络层与页内扫描几乎同时发现同一个地址"这个主要场景。
 */
const SNIFF_DEDUP_MS = 5000;

/**
 * 记一次"这个地址刚刚被记录过"，顺便把过期的键清掉。
 *
 * 返回 true 表示这次该记（不在窗口内），false 表示刚记过、跳过。
 * 清理跟着写入走，不另起定时器 —— 表的上限由调用频率自然限制在
 * `1000 条` 这个量级，而一个空闲的 SW 不该留着定时器。
 *
 * ⚠️ **去重表与列表必须同生共死**：它记的是"这个地址已经在列表里了"，
 * 所以列表被清空时它必须跟着清（见 `clearItems` / `clearPage`）。
 * 只清列表不清它的话，"清空之后立刻再扫一次"会一条都扫不到 —— 而用户
 * 刚清完正是最想重新扫一遍的时候。
 */
const markRecent = (url: string, now: number): boolean => {
    const last = recentUrls.get(url);
    if (last && now - last < SNIFF_DEDUP_MS) return false;
    recentUrls.set(url, now);
    if (recentUrls.size > 1000) {
        for (const [key, at] of recentUrls) {
            if (now - at > SNIFF_DEDUP_MS) recentUrls.delete(key);
        }
    }
    return true;
};

/** 写盘的去抖句柄。见 `flushItems` */
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 把内存镜像写回 `storage.session`。
 *
 * ## 为什么是"首次排程"而不是"每次重置"
 *
 * 原先每追加一条就 `clearTimeout` 再重排，那在持续有请求的页面上会**永远不写盘**：
 * 一个视频站的分片请求间隔小于 200ms，计时器每轮都被推后，SW 一旦被回收，
 * 攒下的几百条全部消失。所以只在**没有待写时**排一次，之后不再推后 ——
 * 上限是 200ms 一次写，而不是"最后一次请求之后 200ms"。
 *
 * ## 为什么值得去抖
 *
 * 一次页面加载能出几十条结果，逐条写就是几十次全量序列化，而中间那些状态
 * 没有任何人会看到 —— 球拿的是内存镜像推过去的事件，不是盘上那份。
 */
const flushItems = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void chrome.storage.session.set({ [STORAGE_KEYS.SNIFFED_ITEMS]: sniffItems });
    }, FLUSH_DEBOUNCE_MS);
};

/**
 * 首次读盘，把镜像填上。
 *
 * 只做一次：SW 被回收后重新求值本文件时镜像会重建，
 * 那时盘上那份就是上次去抖写下去的结果。
 *
 * ## 为什么是**合并**而不是覆盖
 *
 * 读盘是异步的，而追加是**同步**的（那是热路径，见 `pushItem`）。两者一交叠，
 * 覆盖就会丢数据：
 *
 *     ① 扫描到一个媒体地址 → pushItem 把它放进镜像（同步，立即生效）
 *     ② 球第一次问状态 → getItems → loadItems 开始读盘
 *     ③ 读回来的是**上一次写盘**的内容，里面没有 ① 那条
 *     ④ 直接赋值 → ① 那条没了
 *
 * 实测过：`sniffer-scan` 回 `{added: 2}`，紧接着 `sniffer-get-state` 返回空列表 ——
 * 扫描说成功了，列表里什么都没有。用户看到的就是"点了嗅探没反应"。
 *
 * 合并按 URL 去重，并按发现时间重排：两个来源各自的顺序都是对的，
 * 拼起来之后必须重新排一次，否则新条目会全部沉到旧条目后面。
 *
 * ## `clearedAt` 挡的是同一类竞态的另一半
 *
 * 合并的前提是"盘上那份是旧的、镜像是新的"。但用户在这段读盘期间点了"清空"
 * 时前提反过来了：盘上那份成了**用户已经删掉的东西**，合并会把它们复活。
 * 所以清空动作会盖一个时间戳，读盘回来发现它变了就不再合并。
 */
let clearedAt = 0;

const loadItems = async (): Promise<void> => {
    if (sniffLoaded) return;
    sniffLoaded = true;
    const startedAt = clearedAt;
    const got = await chrome.storage.session.get(STORAGE_KEYS.SNIFFED_ITEMS);
    if (clearedAt !== startedAt) return;

    const saved = got[STORAGE_KEYS.SNIFFED_ITEMS];
    if (!Array.isArray(saved) || saved.length === 0) return;

    // 镜像里已有的（读盘期间进来的）优先：它们比盘上那份新
    const known = new Set(sniffItems.map((item) => item.url));
    const restored = (saved as SniffedMedia[]).filter((item) => item && !known.has(item.url));
    if (restored.length === 0) return;

    sniffItems = [...sniffItems, ...restored]
        .sort((a, b) => b.foundAt - a.foundAt)
        .slice(0, MAX_SNIFFED_ITEMS);
};

/**
 * 收下一条嗅探结果。
 *
 * ## 按 URL 合并，不是无脑追加
 *
 * 同一个地址会被**多条路径**发现：网络层看到它被请求、页内扫描在 DOM 里读到它、
 * AI 又把它挑出来一次。而每一条路径拿到的标题质量不同 —— 网络层只有 URL 末段
 * （`index.m3u8`），页内扫描有页面标题。无脑追加的话列表里会出现三条一模一样的
 * 地址，其中两条标题是文件名，用户完全分不清该点哪一条。
 *
 * 所以这里以 URL 为键做 upsert，与旧实现（`useBrowse.ts` 的 `addLinks`）
 * 同一套语义：
 *   · 已存在且**旧标题没信息量、新标题有** → 用新的顶掉（升级）；
 *   · 已存在且旧标题更好 → 保持原样（后来的"文件名"不该把页面标题挤掉）；
 *   · 不存在 → 追加到最前。
 *
 * ## 为什么"没信息量"的判据要共用一份
 *
 * `isGenericTitle` 在 `shared/core/sniff.ts`，界面与插件读同一份。判据分叉过：
 * 新增那条用较全的、更新那条只看 `startsWith('Media_')`，于是标题是文件名
 * （`index.m3u8`，入库时页面标题还没拿到）的条目**永远升不了级**。
 */
const pushItem = (item: SniffedMedia): void => {
    const index = sniffItems.findIndex((existing) => existing.url === item.url);
    if (index < 0) {
        sniffItems = [item, ...sniffItems].slice(0, MAX_SNIFFED_ITEMS);
        flushItems();
        return;
    }

    const existing = sniffItems[index];
    // 只有"旧标题没用、新标题有用"才替换。两个都没用时保持原样 ——
    // 否则一次网络层推送就能把 `index.m3u8` 换成更差的 `Media_stream`
    if (!isGenericTitle(item.title) || isGenericTitle(existing.title)) {
        // 保留首次发现时间：列表按它排序，"这个地址是什么时候出现的"不该
        // 因为后来又被发现一次而跳到最前面
        const merged = { ...existing, ...item, foundAt: existing.foundAt };
        sniffItems = [...sniffItems];
        sniffItems[index] = merged;
        flushItems();
    }
};

const clearItems = (): void => {
    sniffItems = [];
    sniffLoaded = true;
    // 盖时间戳：读盘在途时它会让那次读盘放弃合并，见 loadItems
    clearedAt = Date.now();
    // 去重表记的是"这个地址已经在列表里了"，列表空了它就得跟着空
    recentUrls.clear();
    flushItems();
};

/**
 * 清掉某个页面来的结果。
 *
 * 判据与界面上的「仅当前页」筛选**必须是同一条**（`isLinkFromPage`）：
 * 列表里看得见的当前页条目，点「清空当前页」必须都能清掉。两处各写一份判据
 * 的后果实测过 —— 没有 pageUrl 的条目在筛选下可见却清不掉，看起来像按钮没生效。
 */
const clearPage = (pageUrl: string): number => {
    const before = sniffItems.length;
    const removed = sniffItems.filter((item) => isLinkFromPage(item, pageUrl));
    sniffItems = sniffItems.filter((item) => !isLinkFromPage(item, pageUrl));
    // 同 clearItems：读盘在途时被清掉的条目不能从盘上复活
    clearedAt = Date.now();
    /*
     * 去重表里**只摘掉被清的那些**。
     *
     * 整个清空是不行的：清掉 A 页的条目之后，A 页的地址要能重新被发现，
     * 而 B 页那些还留在列表里的地址不该被重复记一遍 —— 那会让列表里
     * 出现同一个地址的第二条（`pushItem` 按 URL 合并，所以实际是多一次
     * 无谓的分类与写盘，且标题升级的判据会被绕过）。
     */
    for (const item of removed) recentUrls.delete(item.url);
    flushItems();
    return before - sniffItems.length;
};

/**
 * 「清空当前页」的目标地址。
 *
 * 球传了自己的 pageUrl 就用它；没传时问当前活动的标签页 —— 判据与
 * `sniffer-active-page` 同一个（`activePageInfo`），两处不能各问一次不同的问题。
 */
const resolveClearTarget = async (pageUrl?: string): Promise<string> => {
    if (pageUrl) return pageUrl;
    return (await activePageInfo()).pageUrl;
};

/**
 * 解析要操作哪个标签页。
 *
 * 球跑在 Electron 里，它**不知道** chrome 的 tabId（那是浏览器的概念）。
 * 所以它一律不传，由这里问"当前活动的那个" —— 这也正是用户操作时看着的那个。
 * 传了的话就用传的（自检脚本要指定标签页）。
 */
const resolveTabId = async (tabId?: number): Promise<number | null> => {
    if (typeof tabId === 'number' && tabId >= 0) return tabId;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return typeof tab?.id === 'number' ? tab.id : null;
};

/** 同上，但没有标签页时直接报错 —— 扫描类操作没有目标可做 */
const requireTabId = async (tabId?: number): Promise<number> => {
    const resolved = await resolveTabId(tabId);
    if (resolved === null) throw new Error('没有可扫描的标签页（当前窗口没有活动页面）');
    return resolved;
};

/**
 * 当前活动标签页的地址与标题。
 *
 * 球的「仅当前页」筛选与「清空当前页」都读它 —— 而"当前是哪个页面"是
 * **浏览器侧的事实**，球（Electron 窗口）无从得知。
 */
const activePageInfo = async (): Promise<{ pageUrl: string; title: string }> => {
    const tabId = await resolveTabId(undefined);
    if (tabId === null) return { pageUrl: '', title: '' };
    try {
        const tab = await chrome.tabs.get(tabId);
        return { pageUrl: tab.url || '', title: tab.title || '' };
    } catch {
        // 标签页刚好被关掉：返回空，让界面退回"全部"而不是拿着过期地址去清错页面
        return { pageUrl: '', title: '' };
    }
};

/**
 * 总开关的内存镜像。
 *
 * 与 `sniffItems` 同一个理由，但更严重：`getEnabled()` 在**每一个响应**上都要
 * 被问一次。走 `chrome.storage.local` 的话，一页几百个请求就是几百次跨进程读，
 * 全部串在 `handleResponse` 的最前面 —— 那正是"嗅探结果出得极慢"的另一半原因
 * （前一半是写盘 O(n²)，见 `sniffItems`）。
 *
 * 默认**关闭**：与应用侧"持续嗅探"开关同语义，不打开就不推任何结果。
 * 默认开启会让用户一装插件就被动收集浏览记录。
 */
let snifferEnabled = false;
let enabledLoaded = false;

const getEnabled = async (): Promise<boolean> => {
    if (!enabledLoaded) {
        enabledLoaded = true;
        const got = await chrome.storage.local.get(STORAGE_KEYS.SNIFFER_ENABLED);
        snifferEnabled = got[STORAGE_KEYS.SNIFFER_ENABLED] === true;
    }
    return snifferEnabled;
};

const setEnabled = async (enabled: boolean): Promise<void> => {
    snifferEnabled = enabled;
    enabledLoaded = true;
    await chrome.storage.local.set({ [STORAGE_KEYS.SNIFFER_ENABLED]: enabled });
};

/**
 * 读全部结果。
 *
 * 先等首次读盘完成（SW 刚被唤醒时镜像是空的，而盘上可能有上次的几十条），
 * 之后一律直接返回内存镜像。
 */
const getItems = async (): Promise<SniffedMedia[]> => {
    await loadItems();
    return sniffItems;
};

/**
 * 把一条事件广播出去。
 *
 * ## 为什么保留 `sendMessage` 这一条
 *
 * 球已经搬到 Electron 窗口里，不再需要它 —— 但 offscreen 宿主文档
 * （`offscreen/host.ts` 的 `ai-delta` / `ai-done`）仍然走同一条广播。
 * 这里只负责把事件交出去，**收件人是谁由各自的 `target` 过滤决定**。
 *
 * ## 没人听时 sendMessage 会抛
 *
 * "Could not establish connection" 是**正常情况**不是错误 ——
 * 没有任何监听者时它必然抛。必须吞掉，否则每次嗅探都在控制台刷一条红色报错，
 * 真正的故障反而被淹没。
 */
const broadcast = (event: BallEvent): void => {
    chrome.runtime.sendMessage(event).catch(() => undefined);
};

/* ========================================================================== */
/* 2. 嗅探                                                                    */
/* ========================================================================== */

/**
 * 请求 → 发起它的文档位置。
 *
 * ⚠️ **Chrome 的 webRequest 不提供 Electron 那样的 `details.referrer`，
 * 也不提供 `documentUrl`** —— 这是拆分中最容易踩空的一处。它只给
 * `initiator`（发起方的 **origin**，如 `https://site.com`），
 * 而防盗链校验的往往是**完整页面地址**。
 *
 * 所以这里记 `tabId` + `frameId`，再经 `chrome.webNavigation.getFrame`
 * 反查该 frame 的真实 URL（那才是 documentUrl）。
 *
 * 用 `requestId` 关联的原因：分类发生在 onResponseStarted，而文档位置
 * 只有请求阶段能拿到。
 */
const requestContext = new Map<string, { tabId: number; frameId: number; initiator: string }>();

/**
 * 记录每个请求的归属。
 *
 * ⚠️ 只读取不修改，所以**不需要 `extraHeaders`**，也不会拖慢请求。
 */
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        requestContext.set(details.requestId, {
            tabId: details.tabId,
            frameId: details.frameId,
            initiator: details.initiator || '',
        });
        // 表要有界：不清理的话一个长会话能攒到几十万条。
        if (requestContext.size > 2000) {
            for (const key of [...requestContext.keys()].slice(0, 1000)) {
                requestContext.delete(key);
            }
        }
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders'],
);

chrome.webRequest.onResponseStarted.addListener(
    (details) => {
        // 监听器必须同步返回，所以异步逻辑整体丢进一个 void 分支。
        void handleResponse(details);
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
);

/**
 * 反查发起请求的那个文档的地址（= Referer 的来源）。
 *
 * 三级回落，每一级都有存在理由：
 *   1. `webNavigation.getFrame` —— 唯一能拿到**完整 URL** 的途径；
 *   2. `initiator` —— 只有 origin，比没有强（多数站点的防盗链只校验 origin）；
 *   3. 空串 —— 顶层导航、非标签页请求（tabId 为 -1）时确实没有来源。
 */
const resolvePageUrl = async (ctx?: { tabId: number; frameId: number; initiator: string }): Promise<string> => {
    if (!ctx) return '';
    if (ctx.tabId >= 0) {
        try {
            const frame = await chrome.webNavigation.getFrame({ tabId: ctx.tabId, frameId: ctx.frameId });
            if (frame?.url) return frame.url;
        } catch {
            // frame 可能已经销毁（页面刚跳走），继续回落
        }
        try {
            const tab = await chrome.tabs.get(ctx.tabId);
            if (tab.url) return tab.url;
        } catch {
            // 标签页已关闭
        }
    }
    return ctx.initiator;
};

const handleResponse = async (details: chrome.webRequest.OnResponseStartedDetails): Promise<void> => {
    // 总开关放最前：关着的时候后面的分类、查表、写盘全部省掉。
    if (!(await getEnabled())) return;

    const { url, method, statusCode } = details;
    if (!url) return;
    // 只认成功响应；OPTIONS/HEAD 是预检与探测，不是资源本身。
    if (statusCode !== 200 && statusCode !== 206) return;
    if (method === 'OPTIONS' || method === 'HEAD') return;

    const ctx = requestContext.get(details.requestId);
    const header = (name: string): string => {
        const list = details.responseHeaders || [];
        const hit = list.find((h) => h.name.toLowerCase() === name);
        return hit?.value || '';
    };

    const pageUrl = await resolvePageUrl(ctx);

    const classified = classifyResponse({
        url,
        contentType: header('content-type'),
        documentUrl: pageUrl,
    });
    if (!classified) return;

    const now = Date.now();
    if (!markRecent(url, now)) return;

    /*
     * 页面地址已在上面的 resolvePageUrl 里查过，这里直接用。
     * 不再回落到 chrome.tabs.get —— 那是同一个查询的第二次，
     * 且 getFrame 已经覆盖了它的全部结果。
     */
    const item: SniffedMedia = {
        url,
        title: deriveTitle(url, header('content-disposition'), classified.ext),
        type: classified.type,
        ext: classified.ext,
        source: 'network',
        // Referer 取发起请求的文档地址：防盗链站点校验的是"从哪个页面来的"
        referer: pageUrl,
        pageUrl,
        foundAt: now,
    };

    pushItem(item);
    broadcast({ target: 'ball', kind: 'sniffed-media', item });
    /*
     * 同一条结果也要推给应用里的悬浮球。
     *
     * 直接调 `emitBridgeEvent` 而不是包一层 `notifyApp` —— 那层包装只是多一个
     * 转发，却让 manifest 自检扫不到这个调用点（它按 `emitBridgeEvent('kind'`
     * 的字面形态匹配），于是"忘了过桥"这个最该被挡住的错误反而查不出来。
     * 应用没连上时 `emitBridgeEvent` 自己会丢弃，不需要在外面判断。
     */
    emitBridgeEvent('sniffed-media', item);
};

/* ========================================================================== */
/* 2.1 页内扫描                                                               */
/* ========================================================================== */

/**
 * 一次页内扫描的采集配置。
 *
 * 后缀表**在这里现取**，不写死在 `inpage.ts` 里：那张表只有一份权威
 * （`classify.ts` 从 `shared/core/media.ts` 派生），页面里的正则要拿它圈候选。
 * 表变了而这里没跟着变，表现是"新后缀的网络层能嗅到、页内扫描永远嗅不到"。
 */
const scanConfig = (): ScanConfig => ({
    allExts: [...STREAM_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS],
    limit: 400,
    htmlLimit: 500_000,
    matchLimit: 300,
});

/**
 * 页内候选 → 一条嗅探结果。
 *
 * ## 分类一律走共享判据
 *
 * 候选里带 `hint`（元素标签、轨道类型），但它**只在分类器认不出时**兜底：
 * `<video src="/play?id=1">` 既没有后缀也没有 content-type，只有标签能说明
 * 它是什么。反过来，`hint='perf'` 的候选（Performance 里混着 JS 与 CSS）
 * 没有任何类型信息，分类器认不出就必须丢掉 —— 按 hint 硬套一个类型会往
 * 列表里灌一堆非媒体。
 */
const itemFromCandidate = (
    candidate: ScanCandidate,
    pageUrl: string,
    pageTitle: string,
): SniffedMedia | null => {
    const { url, hint } = candidate;
    if (!url) return null;

    const classified = classifyByExt(url, pathExtOf(pathnameOf(url)));
    const fallbackType: MediaType | null = hint === 'video' || hint === 'playinfo-video'
        ? 'video'
        : hint === 'audio' || hint === 'playinfo-audio'
            ? 'audio'
            : null;

    const type = classified?.type ?? fallbackType;
    if (!type) return null;

    const ext = classified?.ext || DEFAULT_EXT_OF[type];
    /*
     * 标题优先用页面标题 + 轨道标签：`<video>` 的地址常常是 `/play?id=1`
     * 这种没有文件名的形式，取 URL 末段只会得到 "id=1"。
     */
    const base = pageTitle || deriveTitle(url, '', ext);
    const title = candidate.label ? `${base} - ${candidate.label}` : base;

    return {
        url,
        title: title.slice(0, 120),
        type,
        ext,
        source: 'local',
        referer: pageUrl,
        pageUrl,
        foundAt: Date.now(),
    };
};

/**
 * 分类器认不出、又靠元素标签兜底时的后缀。
 *
 * 与旧实现（`useBrowse.ts` 的 `getMediaInfo`）同一取舍：条目没有后缀时
 * 界面上的类型徽章会空着，而下载侧按 ext 决定文件名与方式。
 */
const DEFAULT_EXT_OF: Record<MediaType, string> = {
    stream: 'm3u8',
    video: 'mp4',
    audio: 'mp3',
    image: 'jpg',
    document: 'txt',
    gallery: 'gallery',
    other: 'unknown',
};

/**
 * 在指定标签页里跑一次全面扫描，把结果并进列表。
 *
 * ## 为什么只在开关打开或用户手动点时才跑
 *
 * 页内扫描要把代码送进页面执行（`chrome.scripting`），代价是页面上下文里
 * 多跑一段脚本。默认关闭 = 用户不打开嗅探就一个字节都不进页面，
 * 与"默认关闭"这个产品决定保持一致。
 *
 * ## 必须读 `frameId` 过滤
 *
 * 广告 iframe 里也有 video。不过滤的话一次扫描会把几十个广告素材收进来，
 * 而它们全都归到主页面名下 —— 用户看到的是"这个页面怎么这么多东西"。
 * 只扫主框架：子框架的资源在网络层那条路里仍然会以它自己的 URL 被嗅到。
 */
const scanTab = async (tabId: number): Promise<{ added: number }> => {
    let results: chrome.scripting.InjectionResult<ReturnType<typeof IN_PAGE_SCAN>>[];
    try {
        results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            /*
             * **必须进主世界。**
             *
             * `executeScript` 默认落在**隔离世界**（ISOLATED），那里有自己的一份
             * `window` —— 页面的全局对象在那里根本不存在。而 `__playinfo__`、
             * `dplayer` 这类播放器状态正是这一层要读的东西：少了这个参数，
             * 整条"播放器全局对象"的采集路径永远返回空，且**不报任何错**。
             *
             * 实测过：一个只把地址写在 `__playinfo__` 里的页面，隔离世界下扫不到，
             * 主世界下能扫到（test/e2e/verify-sniff-coverage.js）。
             *
             * 主世界注入不受页面 CSP 约束 —— 它不是 <script> 标签，是调试协议
             * 直接求值，所以 `connect-src` 之类的白名单管不到它。
             */
            world: 'MAIN',
            func: IN_PAGE_SCAN,
            args: [scanConfig()],
        });
    } catch (e) {
        /*
         * 扫描失败不是错误：`chrome://` 页面、扩展商店、PDF 阅读器都不允许注入，
         * 而用户完全可能正在看那些页面。报一条红字只会让人以为功能坏了。
         */
        void e;
        return { added: 0 };
    }

    const result = results?.[0]?.result;
    if (!result) return { added: 0 };

    const pageUrl = result.pageUrl || '';
    const pageTitle = result.pageTitle || '';
    let added = 0;

    for (const candidate of result.items) {
        const item = itemFromCandidate(candidate, pageUrl, pageTitle);
        if (!item) continue;
        // 页内扫描与网络层共用同一张去重表：同一个地址两条路径都发现时只留一条
        if (!markRecent(item.url, Date.now())) continue;

        pushItem(item);
        emitBridgeEvent('sniffed-media', item);
        added += 1;
    }

    return { added };
};

/**
 * 页面加载完成 → 开关打开时自动扫一次。
 *
 * 这一条补的是网络层的**盲区**：开关是用户手动打开的，而页面早就加载完了，
 * 那时网络层一条都看不到。用户打开开关的意图就是"把当前这页的东西列出来"，
 * 只等新请求等于什么都没做。
 */
chrome.webNavigation.onCompleted.addListener((details) => {
    // 只扫主框架，理由见 scanTab
    if (details.frameId !== 0 || details.tabId < 0) return;
    void (async () => {
        /*
         * 篡改钩子的重装。**与嗅探开关无关** —— 规则是用户显式配置的，
         * 不该因为"没开嗅探"就不生效。
         *
         * 必须挂在导航完成上而不是只在改规则时注入：每次导航都会换掉页面的
         * 主世界，上一次注入的钩子随之消失。不重装的话，用户会看到
         * "第一页生效、点进第二页就失效"。
         *
         * 规则为空时跳过注入：给每个页面白装一遍钩子是纯浪费，且会在页面上
         * 留下一串控制台日志。
         */
        const rules = await loadRules();
        if (rules.interceptRules.length || rules.requestRules.length || rules.headerRules.length) {
            await injectRules(details.tabId);
        }

        if (!(await getEnabled())) return;
        await scanTab(details.tabId);
    })();
});

/**
 * AI 深度嗅探：把页面源码交给模型，让它挑出结构化资源。
 *
 * ## 与页内扫描的分工
 *
 * 页内扫描是**确定性**的（正则 + API），它捞的是"页面上已经存在的地址"。
 * 有些站点的直链不在页面里，而在接口返回的 JSON 里、或者被拼装出来 ——
 * 那种只能靠模型读源码猜。所以这两条是互补的，不是替代关系。
 *
 * ## 走 offscreen 而不是在 SW 里 fetch
 *
 * 与 Agent 的模型调用同一条约束：一次补全可能十几秒到几分钟，而 SW 空闲
 * 约 30 秒被回收。所以这里复用 Agent 那条 `ChatPort`，让 offscreen 文档
 * 去发请求 —— 不另开一条通道，否则"模型调用在哪发"这件事会有两个答案。
 *
 * ## 页面源码从哪来
 *
 * 用页内扫描的同一个注入通道取 `documentElement.outerHTML`，不在 SW 里
 * `fetch` 页面地址：那会丢掉登录态渲染出来的内容（SPA 尤其明显），
 * 而"已登录页面上有什么"正是这个功能的用途。
 */
const AI_SNIFF_HTML_LIMIT = 80_000;

const aiSniffTab = async (tabId: number): Promise<{ added: number }> => {
    let html = '';
    let pageUrl = '';
    let pageTitle = '';
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            // 同 scanTab：页面自己的全局（`__playinfo__` 一类）只在主世界可见
            world: 'MAIN',
            func: (limit: number) => ({
                html: document.documentElement.outerHTML.slice(0, limit),
                pageUrl: location.href,
                pageTitle: (document.title || '').trim(),
            }),
            args: [AI_SNIFF_HTML_LIMIT],
        });
        const result = results?.[0]?.result;
        if (!result) return { added: 0 };
        html = result.html;
        pageUrl = result.pageUrl;
        pageTitle = result.pageTitle;
    } catch (e) {
        void e;
        return { added: 0 };
    }

    if (!html.trim()) return { added: 0 };

    /*
     * 模型调用交给 offscreen 文档。
     *
     * SW 里**不能** import `shared/ai/AiService.ts`：它顶层 import 了
     * `shared/core/storage.ts`，那个模块碰 `localStorage` —— 而 SW 里没有。
     * 表现是"插件装上就崩"，且崩在模块顶层、没有任何指向性错误信息。
     * `test/extsniffer.test.js` 有一条沙箱断言正是盯着这类问题。
     */
    await agentBridge.ensureOffscreen();
    const response = (await chrome.runtime.sendMessage({
        target: 'host',
        kind: 'ai-extract-links',
        html,
        title: pageTitle,
    })) as ExtensionResponse<{ links: Array<Pick<SniffedMedia, 'url' | 'title' | 'type' | 'ext'>> }> | undefined;

    if (!response) throw new Error('offscreen 宿主无响应（可能创建失败）');
    if (!response.ok) throw new Error(response.error || 'AI 提取失败');
    const extracted = response.result?.links || [];

    let added = 0;
    for (const link of extracted) {
        const now = Date.now();
        if (!markRecent(link.url, now)) continue;

        const item: SniffedMedia = {
            url: link.url,
            title: link.title,
            type: link.type,
            ext: link.ext,
            // 来源标 'ai'：与页内扫描（'local'）、网络层（'network'）分开，
            // 用户能看出这条是模型猜的还是页面里确实有的
            source: 'ai',
            referer: pageUrl,
            pageUrl,
            foundAt: now,
        };
        pushItem(item);
        emitBridgeEvent('sniffed-media', item);
        added += 1;
    }
    return { added };
};

/* ========================================================================== */
/* 3. Cookie（Tamper 工具用）                                                 */
/* ========================================================================== */

/**
 * 读一个地址的全部 cookie。
 *
 * 比应用侧的实现**更正确**：`chrome.cookies` 拿到的是浏览器当前真实会话值，
 * 而应用只能读启动时那份快照，Edge 导入那条链更是要求用户先完全退出浏览器。
 */
const cookiesGet = async (url: string) => {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate,
        session: c.session,
    }));
};

const cookieRemove = async (url: string, name: string) => {
    await chrome.cookies.remove({ url, name });
};

/**
 * 覆盖一条 cookie 的值。
 *
 * 与页面宿主的 `setCookie` 不同：那条要收完整对象（保留 httpOnly / 过期时间），
 * 这条只给面板用 —— 面板的输入框只能改值。**先读回原条目再改值**，不这么做
 * 就是整条覆盖，会把 httpOnly 与过期时间一起抹掉，会话 cookie 当场降级。
 */
const cookieSet = async (url: string, name: string, value: string): Promise<boolean> => {
    const list = await chrome.cookies.getAll({ url });
    const existing = list.find((c) => c.name === name);
    if (!existing) return false;

    const domain = existing.domain.startsWith('.') ? existing.domain.slice(1) : existing.domain;
    const result = await chrome.cookies.set({
        url,
        name,
        value,
        domain,
        path: existing.path,
        secure: existing.secure,
        httpOnly: existing.httpOnly,
        ...(existing.expirationDate ? { expirationDate: existing.expirationDate } : {}),
        ...(existing.sameSite ? { sameSite: existing.sameSite } : {}),
    });
    return !!result;
};

/* ========================================================================== */
/* 4. 下载                                                                    */
/* ========================================================================== */

/**
 * 起一个下载。
 *
 * 只有这一个下载动作：球把嗅探到的地址交给浏览器，之后**进度与暂停归
 * 浏览器自己的下载管理器管**（Ctrl+J）。原先还有一套"列出下载 / 暂停 / 取消"
 * 的接口，那是侧边栏用来做一份浏览器已有界面的镜像 —— 侧边栏删掉后它们
 * 一并消失：多一层重复的列表只会和 Ctrl+J 显示得不一样，然后用户不知道该信哪个。
 *
 * `conflictAction: 'uniquify'` 不能省：同名文件直接覆盖会让用户
 * 第二次下同一个片子时**悄悄丢掉第一次的结果**。
 */
const downloadsStart = async (url: string, filename?: string) => {
    return chrome.downloads.download({
        url,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
    });
};

/* ========================================================================== */
/* 6. 桥：本机应用（悬浮球的宿主）                                             */
/* ========================================================================== */

/**
 * 应用发来的请求。
 *
 * ## 为什么这一层必须存在
 *
 * 悬浮球跑在 Electron 窗口里，没有 `chrome.*`。它要的一切 —— 嗅探结果、
 * Agent 快照、下载动作 —— 都只能经 native messaging 问到这里。
 * 所以这个 switch 就是**球能看到的能力全集**：不在表里的方法，
 * 球就是做不到。
 *
 * ## 与 `dispatchBall` 的关系
 *
 * `dispatchBall` 是**页面里那个球**（content script）走的路径，它自带
 * `chrome.runtime`，直接发消息即可。两者做的是同一批事，但入口不同：
 * 一个在扩展进程内，一个跨进程。
 *
 * **重叠的部分只有这一份实现** —— `dispatchBall` 把嗅探、下载、Agent 那几条
 * 原样转发到这里，只有球独有、面板没有上下文的（`cookies-*`、`host-ensure`、
 * `page-eval`）留在那边。两份实现必然漂移，实测过一次：给
 * `sniffer-set-enabled` 加了"打开时自动扫一次"，只加在这里，而球走的是
 * `dispatchBall` 那一份 —— 用户点开开关看到的仍是空列表，插件自检却全绿。
 *
 * 所以：**新增端点一律加在这里**，`dispatchBall` 只需要多一条转发。
 */
const dispatchBridge = async (method: string, params: unknown): Promise<unknown> => {
    const args = (params || {}) as Record<string, never>;

    switch (method) {
        case 'sniffer-get-state':
            return { enabled: await getEnabled(), items: await getItems() };

        case 'sniffer-set-enabled': {
            const enabled = Boolean((args as { enabled?: boolean }).enabled);
            await setEnabled(enabled);
            /*
             * 打开开关时立刻扫一次当前标签页。
             *
             * 不这么做的话，用户点开开关看到的是一个空列表 —— 网络层只能看到
             * **之后**发生的请求，而页面早就加载完了。旧实现（useBrowse 的
             * `setSniffEnabled`）就是"打开 = 切页自动扫描 + 网络层持续推送"，
             * 这里保持一致。
             */
            if (enabled) await scanTab(await requireTabId());
            return { enabled: await getEnabled() };
        }

        case 'sniffer-clear':
            clearItems();
            return { cleared: true };

        case 'sniffer-clear-page': {
            const pageUrl = await resolveClearTarget((args as { pageUrl?: string }).pageUrl);
            return { removed: clearPage(pageUrl) };
        }

        case 'sniffer-scan':
            return scanTab(await requireTabId((args as { tabId?: number }).tabId));

        case 'sniffer-active-page':
            return activePageInfo();

        case 'sniffer-ai-scan':
            return aiSniffTab(await requireTabId((args as { tabId?: number }).tabId));

        case 'downloads-start': {
            const p = args as unknown as { url: string; filename?: string };
            return { downloadId: await downloadsStart(p.url, p.filename) };
        }

        case 'agent-snapshot': {
            const engine = await agentBridge.getEngine();
            return { snapshot: engine.snapshot() };
        }

        case 'agent-action': {
            const engine = await agentBridge.getEngine();
            return { result: await runAgentAction(engine, { action: (args as unknown as { action: never }).action } as never) };
        }

        /*
         * 篡改规则。三条端点分别对应面板上的「规则」「请求头」两个页签：
         * 读一次、写一次、以及"改完立刻对当前页面生效一次"。
         *
         * 注入的**唯一入口**是 tamper.ts 的 `injectRules`，这里只负责转参数 ——
         * 面板与 Agent 工具各写一份注入代码，必然漂移成"面板里生效、模型改的不生效"。
         */
        case 'tamper-get':
            return { rules: await loadRules() };

        case 'tamper-set': {
            const p = args as unknown as Partial<{
                interceptRules: TamperRule[];
                requestRules: TamperRule[];
                headerRules: HeaderRule[];
            }>;
            const current = await loadRules();
            // 部分更新：只合并传了的类别。全量覆盖会让"只想改一条请求头"变成
            // "把用户的拦截规则全清空"。
            const next = {
                interceptRules: Array.isArray(p.interceptRules) ? p.interceptRules : current.interceptRules,
                requestRules: Array.isArray(p.requestRules) ? p.requestRules : current.requestRules,
                headerRules: Array.isArray(p.headerRules) ? p.headerRules : current.headerRules,
            };
            const tabId = (args as { tabId?: number }).tabId;
            const { saved } = await applyRules(next, await requireTabId(tabId));
            // 回读落盘后的镜像：面板据此更新，而不是拿它自己刚发出去的那份
            return { rules: await loadRules(), saved };
        }

        /*
         * 只注入、不改规则。
         *
         * 存在的理由：注入是**按页面**发生的，而规则是全局的。用户切到一个新标签页
         * 时那个页面还没装钩子（装钩子挂在 webNavigation.onCompleted 上，而那个
         * 页面可能在我们改规则之前就加载完了）。面板打开时调一次这条，把当前页补齐。
         */
        case 'tamper-inject':
            return { injected: await injectRules(await requireTabId((args as { tabId?: number }).tabId)) };

        /*
         * 页面存储。面板的「存储」与「JWT」两个页签都读它。
         *
         * 一次把三样都取回来（local / session / cookie）而不是分三条端点：
         * 面板打开时要同时显示它们，分三次就是三次跨进程往返 + 三个各自可能
         * 失败的点，而"读到一半"的界面比"读慢一点"更难解释。
         *
         * 走 pageHost 而不是自己拼 debugger 调用：那里已经有附着复用与超时，
         * 再写一份必然在"超时该多久""附着失败怎么办"上漂移。
         */
        case 'page-storage-read': {
            const tabId = await requireTabId((args as { tabId?: number }).tabId);
            // 三样各自 try：cookie 那条走 chrome.cookies，与 debugger 无关，
            // 让 debugger 的失败把它一起带走就等于"页面不可调试时看不到 cookie"。
            const [local, session, cookies] = await Promise.all([
                pageHost.readWebStorage(tabId, 'local').catch(() => '{}'),
                pageHost.readWebStorage(tabId, 'session').catch(() => '{}'),
                pageHost.getCookies(tabId).catch(() => []),
            ]);
            return { local, session, cookies, pageUrl: (await activePageInfo()).pageUrl };
        }

        /*
         * 写一条存储。`value === null` 表示删除 —— 用一个端点而不是两个，
         * 是因为 `Storage` 本来就只有 setItem / removeItem 两种写，而它们
         * 共用"哪个区、哪个键"这一半参数。
         *
         * `area === 'cookie'` 走另一条实现：cookie 的写入是**整条覆盖**
         * （见 pageHost.setCookie），必须收完整对象而不是一个字符串值。
         * 混进同一条分支里会让调用方以为"cookie 也是一个键值对"。
         */
        case 'page-storage-write': {
            const p = args as unknown as {
                area: 'local' | 'session' | 'cookie';
                key: string;
                value: string | null;
                cookie?: CookieItem;
            };
            const tabId = await requireTabId((args as { tabId?: number }).tabId);

            if (p.area === 'cookie') {
                if (!p.cookie) return { ok: false };
                // 删除：Chrome 没有"按 path 删"的入口，同名不同 path 会被一起删掉
                if (p.value === null || p.value === '') {
                    return { ok: await pageHost.removeCookie(tabId, p.cookie.name) };
                }
                return { ok: await pageHost.setCookie(tabId, { ...p.cookie, value: p.value }) };
            }

            const ok = p.value === null
                ? await pageHost.removeWebStorage(tabId, p.area, p.key)
                : await pageHost.writeWebStorage(tabId, p.area, p.key, p.value);
            return { ok };
        }

        default:
            /*
             * 不认识的端点**必须报错**，不能静默返回 undefined。
             *
             * 静默返回会让应用侧拿到一个 `ok: true` 加一个 undefined 结果，
             * 界面上表现为"点了没反应" —— 而真正的原因只是一个拼错的方法名。
             */
            throw new Error(`插件不认识的桥端点：${method}`);
    }
};

setDispatcher(dispatchBridge);

/**
 * 顶层尝试连一次桥。
 *
 * 放在顶层（而不是等第一次请求）的理由：SW 每次被唤醒都会重新求值本文件，
 * 而"应用在不在"是球一打开就要显示的状态。主动连一次能让球立刻拿到
 * 准确答案，而不是先显示"未连接"再跳回来。
 *
 * **失败是正常情况**：用户没开应用时 connectNative 直接抛，这里吞掉。
 */
ensureBridge();

/* ========================================================================== */
/* 7. 消息路由                                                                */
/* ========================================================================== */

/**
 * 两条通道的消息都会到这里：球（content script）与 offscreen 宿主。
 * **必须按 `target` 分流**。
 *
 * 不分流会怎样：宿主推的 `ai-delta` 被当成未知消息，SW 回一条 `{ok:false}`，
 * 而球同时在等自己的回包 —— 于是"谁来回这一条"变成了竞态。
 * 协议里带 `target` 就是为了让这件事是确定的。
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const envelope = message as { target?: string; kind?: string } | null;

    if (envelope?.target === 'sw') {
        void (async (): Promise<void> => {
            try {
                sendResponse({ ok: true, result: await dispatchBall(message as BallRequest) } satisfies ExtensionResponse);
            } catch (e) {
                sendResponse({ ok: false, error: errorText(e) } satisfies ExtensionResponse);
            }
        })();
        // 返回 true 才能异步回复。忘了它，球收到的永远是 undefined。
        return true;
    }

    /*
     * offscreen 与球之间的广播不是发给 SW 的，直接放行。
     *
     * 不 return true 就不会占用响应通道，消息继续由真正的接收方处理。
     */
    if (envelope?.target === 'host' || envelope?.target === 'ball') return false;

    /*
     * 到这里说明消息既没有 target，也不属于已知广播。
     *
     * **必须回一条**：不回的话调用方会一直等（响应通道开着但没人写），
     * 表现为"界面卡在转圈"。而真正的原因往往只是一个拼错的 target。
     * 之前这里把无 target 的消息当成侧边栏请求处理 —— 侧边栏删掉之后，
     * 那条路径会把任何漏写 target 的消息静默吞掉。
     */
    sendResponse({
        ok: false,
        error: `未知消息（缺少 target）：${String(envelope?.kind ?? message)}`,
    } satisfies ExtensionResponse);
    return false;
});

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 悬浮球发来的请求。
 *
 * ## 与 `dispatchBridge` 的关系：**共用同一份实现**
 *
 * 两条路径做的是同一批事，只是入口不同 —— 一个在扩展进程内（球经 native
 * messaging 转发过来），一个跨进程（页面里那个球走 `chrome.runtime`）。
 *
 * 原先这里是一份**独立的 switch**，理由写的是"球能做的事严格多于面板，
 * 合并会让'面板能不能调 page-eval'没有答案"。那个理由对 `cookies-*` /
 * `host-ensure` / `page-eval` 成立，但**对嗅探那一批不成立** —— 它们两边
 * 一模一样，而两份实现必然漂移。
 *
 * 漂移实测过：给 `sniffer-set-enabled` 加了"打开时自动扫一次当前页"，
 * 只加在 `dispatchBridge` 那一份上。球走的是**这一份**，于是用户点开开关
 * 看到的仍然是空列表 —— 而插件那边的自检（走桥）全绿。
 *
 * 所以现在：**重叠的部分一律转发给 `dispatchBridge`**，只有球独有、面板
 * 没有上下文的那些留在这里。新增嗅探类操作时只要往那边加一处，两条路径
 * 一起生效；漏加在这里是一个类型错误（下面按 method 逐个列出）。
 */
const dispatchBall = async (message: BallRequest): Promise<unknown> => {
    switch (message.kind) {
        /* ---- 与桥共用：转发，不重写 ---- */
        case 'sniffer-set-enabled':
            return dispatchBridge('sniffer-set-enabled', { enabled: message.enabled });

        case 'sniffer-get-state':
            return dispatchBridge('sniffer-get-state', {});

        case 'sniffer-clear':
            return dispatchBridge('sniffer-clear', {});

        case 'sniffer-clear-page':
            return dispatchBridge('sniffer-clear-page', { pageUrl: message.pageUrl });

        case 'sniffer-scan':
            return dispatchBridge('sniffer-scan', { tabId: message.tabId });

        case 'sniffer-active-page':
            return dispatchBridge('sniffer-active-page', {});

        case 'sniffer-ai-scan':
            return dispatchBridge('sniffer-ai-scan', { tabId: message.tabId });

        case 'downloads-start':
            return dispatchBridge('downloads-start', { url: message.url, filename: message.filename });

        case 'agent-snapshot':
            return dispatchBridge('agent-snapshot', {});

        case 'agent-action':
            return dispatchBridge('agent-action', { action: message.action });

        case 'tamper-get':
            return dispatchBridge('tamper-get', {});

        case 'tamper-set':
            return dispatchBridge('tamper-set', {
                tabId: message.tabId,
                interceptRules: message.interceptRules,
                requestRules: message.requestRules,
                headerRules: message.headerRules,
            });

        case 'tamper-inject':
            return dispatchBridge('tamper-inject', { tabId: message.tabId });

        case 'page-storage-read':
            return dispatchBridge('page-storage-read', { tabId: message.tabId });

        case 'page-storage-write':
            return dispatchBridge('page-storage-write', {
                tabId: message.tabId,
                area: message.area,
                key: message.key,
                value: message.value,
                cookie: message.cookie,
            });
        /* ---- 球独有：面板没有那个上下文 ---- */
        case 'cookies-get':
            return cookiesGet(message.url);

        case 'cookies-set':
            return { saved: await cookieSet(message.url, message.name, message.value) };

        case 'cookies-remove':
            await cookieRemove(message.url, message.name);
            return { removed: true };

        /*
         * Agent 的两条：引擎挂在 agentBridge 上，球只负责转发。
         *
         * 这些消息**不带 tabId**：引擎每次都问宿主的 `activeTab()`，
         * 那是"当前操作哪个页面"的唯一权威。球传一个自己的 tabId 会让同一个
         * 事实有两个存放处 —— 用户切标签页后两边立刻不一致。
         */
        case 'host-ensure':
            await agentBridge.ensureOffscreen();
            return { ready: true };

        case 'page-eval': {
            /*
             * 直接执行，不走引擎的主循环。
             *
             * 这条给"脚本页的手动运行"用：它不属于任何一次模型调用，
             * 走 dispatchTool 反而会被 busy 闸门挡住。串行化仍由引擎的队列
             * 保证 —— 换一条路径执行就等于绕开了"模型步骤与手动执行不交错"。
             */
            const engine = await agentBridge.getEngine();
            return { result: await engine.execForScript(message.tabId, message.code) };
        }

        case 'page-navigate': {
            const engine = await agentBridge.getEngine();
            return { result: await engine.navigateForScript(message.tabId, message.url) };
        }

        default: {
            // 穷尽检查：新增 BallRequest 分支却忘了在这里处理时，
            // 这一行会变成类型错误，而不是运行时的静默 undefined。
            const never: never = message;
            throw new Error(`未知消息：${JSON.stringify(never)}`);
        }
    }
};

/** 引擎上的动作。形状与 AgentState['actions'] 一致，球原样转发 */
const runAgentAction = async (
    engine: AgentEngine,
    message: Extract<BallRequest, { kind: 'agent-action' }>,
): Promise<unknown> => {
    const { action } = message;
    switch (action.type) {
        case 'send':
            await engine.snapshot().actions.send(action.prompt);
            return { done: true };
        case 'stop':
            engine.snapshot().actions.stop();
            return { done: true };
        case 'clear':
            engine.snapshot().actions.clear();
            return { done: true };
        case 'compact':
            return { compaction: await engine.snapshot().actions.compact() };
        case 'set-compact-ratio':
            engine.snapshot().actions.setCompactRatio(action.ratio);
            return { done: true };
        case 'remove-message':
            engine.snapshot().actions.removeMessage(action.id);
            return { done: true };
        case 'rewind':
            return { prompt: engine.snapshot().actions.rewindTo(action.id) };
        case 'run-script':
            return { result: await engine.snapshot().actions.runScriptNow(action.id) };
        case 'remove-script':
            engine.snapshot().actions.removeScript(action.id);
            return { done: true };
        case 'toggle-script':
            engine.snapshot().actions.toggleScript(action.id);
            return { done: true };
        default: {
            const never: never = action;
            throw new Error(`未知 Agent 动作：${JSON.stringify(never)}`);
        }
    }
};
