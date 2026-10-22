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
    isSniffExcluded,
    isSegmentCandidate,
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
    type BallRequest,
    type BrowserTab,
    type ExtensionResponse,
    type SniffedMedia,
} from '../shared/protocol';
import type { MediaType } from '../../../shared/meta';
import { agentBridge } from './agent-bridge';
import { emitBridgeEvent, ensureBridge, setDispatcher } from './bridge-port';
import { pageHost } from '../offscreen/page-host';
import { saveRules, loadRules, injectRules } from './tamper';
import type { AgentEngine } from '../agent/engine';
import { isGenericTitle, withoutTab } from '../../../shared/core/sniff';
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

/**
 * 首次读盘合并的进行状态。**全模块唯一一处表示"镜像是否已由盘上那份播种"。**
 *
 * 是 promise 而不是布尔标志：标志只答得上"这一次跑完了没有"，而两个使用方
 * 问的是不同的问题 —— "要不要等它"（并发的调用方）与"现在能不能写盘"
 * （`flushItems`）。原先这里是一个 `sniffLoaded`，它在读盘**开始**时就置 true，
 * 而写盘按"已经装载完"理解它 —— 于是 SW 被回收后重来的那一次生命周期里，
 * 第一条结果会在读盘回来之前就把盘上那份整份覆盖掉（见 `flushItems`）。
 *
 * `null` = 还没开始；失败时会重新置空，让下一次调用重试。
 */
let seeding: Promise<void> | null = null;

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
 * 所以列表被清空时它必须跟着清（见 `clearItems` / `clearTab`）。
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
 *
 * ## 为什么写之前必须等播种（`loadItems`）
 *
 * 镜像与盘上那份是两个东西：SW 被回收后重来时镜像是**空的**，而盘上那份是
 * 上一次生命周期攒下的全部结果，恢复它的唯一路径是 `loadItems` —— 而那条路
 * 只挂在"球问状态"（`sniffer-get-state`）上，球关着时永远轮不到它。
 * 所以写回不能无条件发生：它自己先等播种（`loadItems` 幂等，已播种时只是一次
 * 微任务），否则第一条结果就足以把整份历史抹成"这次才发现的那几条"。
 *
 * 播种失败就不写 —— 条目还在镜像里，下一次发现新结果时会再试一次；
 * 拿一个空镜像去写，比晚写一次坏得多。
 */
const flushItems = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void loadItems().then(
            () => {
                void chrome.storage.session.set({ [STORAGE_KEYS.SNIFFED_ITEMS]: sniffItems });
            },
            // 播种失败：这次不写，条目留在镜像里等下一次触发
            () => undefined,
        );
    }, FLUSH_DEBOUNCE_MS);
};

/**
 * 首次读盘，把镜像填上。
 *
 * 每个生命周期只做一次：重复调用共用同一个 promise（见 `loadItems`）。
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

const readPersisted = async (): Promise<void> => {
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
 * 保证镜像已由盘上那份播种，等它做完。
 *
 * **这是"镜像播种好了没有"的唯一入口**：写盘（`flushItems`）与改动镜像之前
 * 都要先经过它。失败时把 memo 置空并原样抛出 —— 置空是为了让下一次调用重试
 * 而不是记成"已经播种过"（那会让紧接着的写回拿空镜像覆盖盘上那份）；
 * 抛出则由调用方各自处置：`getItems` 让它冒到界面上，`flushItems` 跳过这次写。
 */
const loadItems = (): Promise<void> => {
    seeding ??= readPersisted().catch((error: unknown) => {
        seeding = null;
        throw error;
    });
    return seeding;
};

/**
 * 合并两条记录各自的标签页归属。
 *
 * 去重且保持首次出现的顺序：顺序本身没有语义，但每次合并都重排会让写盘
 * 内容无谓地变化，而那正是"这个地址到底变没变"的判据（见 pushItem 末尾）。
 *
 * 空值一律归一成空数组：`undefined` 与 `[]` 在"有没有标签页"这件事上等价，
 * 让两种形状同时存在只会让后面每个读取点都要写 `|| []`。
 */
const mergeTabIds = (a?: number[], b?: number[]): number[] => {
    const out = [...(a || [])];
    for (const id of b || []) {
        if (!out.includes(id)) out.push(id);
    }
    return out;
};

/**
 * 收下一条嗅探结果。
 *
 * ## 按 URL 合并，不是无脑追加
 *
 * 同一个地址会被**两条路径**发现：网络层看到它被请求、页内扫描在 DOM 里读到它。
 * 而每一条路径拿到的标题质量不同 —— 网络层只有 URL 末段
 * （`index.m3u8`），页内扫描有页面标题。无脑追加的话列表里会出现两条一模一样的
 * 地址，其中一条标题是文件名，用户完全分不清该点哪一条。
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
 *
 * ## 返回**入库后的那一份**，事件里必须发它
 *
 * 传进来的只是"这次发现"，而合并（标签页归属取并集、标题只升不降）发生在
 * 下面。发原始的那份，球上的副本就与这里分叉 —— 而且是两边都"成功"的那种
 * 分叉：条目从另一个标签页的筛选里消失、好标题被文件名顶掉、计数对不上。
 */
const pushItem = (item: SniffedMedia): SniffedMedia => {
    const index = sniffItems.findIndex((existing) => existing.url === item.url);
    if (index < 0) {
        sniffItems = [item, ...sniffItems].slice(0, MAX_SNIFFED_ITEMS);
        flushItems();
        return item;
    }

    const existing = sniffItems[index];
    /*
     * 标签页归属是**并集**，不是覆盖。
     *
     * 同一个地址会被两个标签页请求（同一个视频站开两个页、或共用的 CDN 资源），
     * 也会被两条采集路径先后发现。直接 `{...existing, ...item}` 会让归属变成
     * "最后一个发现它的那个标签页"，于是切到另一个标签页就看不到它 ——
     * 而那个标签页确实请求过它。用户看到的是"这个页面的资源怎么少了一条"。
     */
    const tabIds = mergeTabIds(existing.tabIds, item.tabIds);
    // 只有"旧标题没用、新标题有用"才替换。两个都没用时保持原样 ——
    // 否则一次网络层推送就能把 `index.m3u8` 换成更差的 `Media_stream`
    if (!isGenericTitle(item.title) || isGenericTitle(existing.title)) {
        // 保留首次发现时间：列表按它排序，"这个地址是什么时候出现的"不该
        // 因为后来又被发现一次而跳到最前面
        const merged = { ...existing, ...item, tabIds, foundAt: existing.foundAt };
        sniffItems = [...sniffItems];
        sniffItems[index] = merged;
        flushItems();
        return merged;
    }

    /*
     * 标题不升级时也要把归属并进去。
     *
     * 这段原先直接 return —— 那时没有归属可并。现在不并的话，"第二个标签页
     * 也请求了这个地址"这条信息会**丢掉**：标题没升级（本来就是好的），
     * 归属却停在第一个标签页上。
     */
    if (tabIds.length !== (existing.tabIds || []).length) {
        const merged = { ...existing, tabIds };
        sniffItems = [...sniffItems];
        sniffItems[index] = merged;
        flushItems();
        return merged;
    }

    return existing;
};

const clearItems = (): void => {
    sniffItems = [];
    /*
     * 清空 = "镜像即权威"：盘上那份不必再读 —— 读回来也只会被合并掉，
     * 而用户要的正是它消失。在途的那次读盘由下面的时间戳挡下。
     */
    seeding = Promise.resolve();
    // 盖时间戳：读盘在途时它会让那次读盘放弃合并，见 readPersisted
    clearedAt = Date.now();
    // 去重表记的是"这个地址已经在列表里了"，列表空了它就得跟着空
    recentUrls.clear();
    flushItems();
};

/**
 * 清掉某个标签页来的结果。
 *
 * ## 判据是 `tabIds`，不是 `pageUrl`
 *
 * 原先按 pageUrl 清，因为那时嗅探只覆盖当前标签页，一个页面就是一个标签页。
 * 现在嗅探覆盖全部标签页，而**同一个标签页会换地址**（导航、SPA 改路由）——
 * 按 pageUrl 清就只能清掉它当前那一次导航的结果，用户看到的仍然是"点了 ×
 * 这个标签页的资源还在列表里"。标签页 id 是稳定的身份，pageUrl 不是。
 *
 * ## 别的标签页也有的条目只摘归属，不整条删
 *
 * 摘归属用 `withoutTab`：它不拥有这条记录时返回原对象、拥有时返回摘掉归属的
 * 副本，两种情况天然分开，不需要另判一次。
 * 换成 `filter` 会把"两个标签页都请求过的地址"整条删掉 —— 另一个标签页下
 * 它就凭空消失了，而那个标签页并没有被清。
 */
const clearTab = async (tabId: number): Promise<number> => {
    /*
     * 先播种再动手。它清的是"一个标签页"，不能拿一个空镜像去比对：SW 刚被回收
     * 时镜像里一条都没有，那样 removed 会是 0（球却已经把那些行从界面上删了），
     * 而紧接着的写回会把**别的标签页**那些条目一起写成这份空列表。
     */
    await loadItems();

    let removed = 0;
    /** 整条被删掉的地址。只有它们要从去重表里摘 */
    const dropped: string[] = [];
    const next: SniffedMedia[] = [];

    for (const item of sniffItems) {
        const kept = withoutTab(item, tabId);
        if (kept === item) {
            // 这个标签页本来就不拥有它：原样留着，且**不动去重表** ——
            // 摘掉的话它下次被发现时会作为新条目重复入库
            next.push(item);
            continue;
        }
        removed += 1;
        if (kept) next.push(kept);
        else dropped.push(item.url);
    }

    sniffItems = next;
    // 同 clearItems：读盘在途时被清掉的条目不能从盘上复活
    clearedAt = Date.now();
    /*
     * 去重表记的是"这个地址已经在列表里了"。所以只摘**整条被删**的那些：
     * 摘掉之后 A 标签页的资源能重新被发现；而还留在列表里的地址（别的标签页
     * 也有它）继续占着去重表，否则它会被重复记一遍，多一次无谓的分类与写盘。
     */
    for (const url of dropped) recentUrls.delete(url);
    flushItems();
    return removed;
};

/**
 * 浏览器里当前打开的全部标签页。
 *
 * 只列 http/https：`chrome://`、扩展页、`about:blank` 这些既扫不了也不该
 * 出现在嗅探器的标签栏里（用户不会想在那上面嗅探）。
 *
 * 按 windowId 再按 index 排：多窗口时同一窗口的标签页要挨在一起，
 * 否则标签栏的顺序每次刷新都在跳。
 */
const listTabs = async (): Promise<BrowserTab[]> => {
    const tabs = await chrome.tabs.query({});
    return tabs
        .filter((tab) => typeof tab.id === 'number' && /^https?:/.test(tab.url || ''))
        .sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index))
        .map((tab) => ({
            id: tab.id as number,
            url: tab.url || '',
            title: tab.title || '',
            active: tab.active === true,
            windowId: tab.windowId,
        }));
};

/**
 * 关掉一个浏览器标签页。
 *
 * 球上的 × 走这条：用户在那个小标签栏上点关闭，期望的就是浏览器里那个标签页
 * 也没了。返回 `closed: false` 表示标签页已经不在（重复点、或浏览器刚关掉它）——
 * 那不是错误，界面据此刷新一次标签栏即可。
 */
const closeTab = async (tabId: number): Promise<{ closed: boolean }> => {
    try {
        await chrome.tabs.remove(tabId);
        return { closed: true };
    } catch {
        return { closed: false };
    }
};

/**
 * 标签页集合变了就通知球。
 *
 * 球是个独立窗口，它不会自动知道浏览器里开了什么 —— 标签栏停在打开那一刻的
 * 快照上，用户新开一个页面后球上看不见。这四条事件覆盖了集合的全部变化来源。
 *
 * 导航（`onUpdated` 的 url 变化）也要推：标签页身份没变但标题变了，
 * 而球画的是标题。
 */
const notifyTabsChanged = (): void => {
    emitBridgeEvent('tabs-changed', {});
};

chrome.tabs.onCreated.addListener(() => notifyTabsChanged());
chrome.tabs.onRemoved.addListener(() => notifyTabsChanged());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    // 只认标题与地址的变化。onUpdated 在加载状态、favicon 变化时也会触发，
    // 那些每次都推一遍等于让球不停重拉标签列表
    if (changeInfo.title !== undefined || changeInfo.url !== undefined) notifyTabsChanged();
});

/**
 * 解析要操作哪个标签页。
 *
 * 球跑在 Electron 里，它**不知道** chrome 的 tabId（那是浏览器的概念），
 * 除非用户明确选了某一个标签页。传了就用传的（自检脚本要指定）。
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
 * **嗅探已经不用它了**（嗅探的作用域是全部标签页，见 scanTargets）。留着是因为
 * Agent 球的「规则 / 请求头 / 存储 / JWT」四个页签要显示"这些操作作用于哪个页面"
 * —— 那几条不带 tabId，插件按活动标签页执行，界面就必须显示同一个答案。
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
 * 全部可扫描的标签页 id。
 *
 * 嗅探的作用域是"浏览器里打开的一切"，不是"用户此刻正在看的那个" —— 用户
 * 在别的标签页里刷出来的资源，切回来时就该已经在列表里。
 *
 * 过滤掉不允许注入的页面（`chrome://`、扩展商店、PDF 阅读器）：对它们
 * `executeScript` 必然失败，逐个 try 只是把同一个必然结果试几十遍。
 * 判定交给 URL 前缀，与 listTabs 同一口径。
 */
const scanTargets = async (): Promise<number[]> => {
    const tabs = await chrome.tabs.query({});
    return tabs
        .filter((tab) => typeof tab.id === 'number' && /^https?:/.test(tab.url || ''))
        .map((tab) => tab.id as number);
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
 * 两级回落，每一级都有存在理由：
 *   1. `webNavigation.getFrame` —— 唯一能拿到**完整 URL** 的途径；
 *   2. `initiator` —— 只有 origin，比没有强（多数站点的防盗链只校验 origin）。
 *
 * ## 为什么不再回落到 `chrome.tabs.get`
 *
 * 原先是三级，第三级是 `chrome.tabs.get(tabId).url`。那条在"只嗅探当前标签页"
 * 的旧语义下看不出问题，但现在嗅探**覆盖全部标签页**，它就成了一条会把归属
 * 写错的路径：后台标签页里发起的请求，`getFrame` 查不到（frame 已销毁或
 * 在子框架里）时，回落拿到的是那个标签页**此刻**的地址，而不是发起这次请求
 * 的文档地址 —— 于是这条资源会被记到它根本不属于的页面名下。
 *
 * 拿不准归属时宁可留空：空 pageUrl 在界面上显示为"未知来源"，而一个错的
 * pageUrl 会让用户以为资源来自另一个页面，且按标签页筛选时出现在错误的组里。
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
        // Chrome 对非标签页发起的请求（SW、预取）给的是 -1，那种不冒充标签页
        tabIds: ctx && ctx.tabId >= 0 ? [ctx.tabId] : [],
        foundAt: now,
    };

    emitBridgeEvent('sniffed-media', pushItem(item));
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
    tabId: number,
): SniffedMedia | null => {
    const { url, hint } = candidate;
    if (!url) return null;
    // 与网络层共用 isSniffExcluded 这一个判据：只拦网络层的话，在 ACG 站上
    // 开着嗅探逛一圈，列表就被封面刷满
    if (isSniffExcluded(url, pageUrl)) return null;

    const pathExt = pathExtOf(pathnameOf(url));
    /*
     * 分片先挡掉，**在下面那段兜底之前**。
     *
     * `classifyByExt` 对分片返回 null，而 null 同时表示"认不出" —— 兜底正是为
     * "认不出"准备的（`<video src="/play?id=1">` 只能靠标签说明类型）。
     * 不问这一句的话，`<video src=".../seg001.ts">` 这类候选会被兜底捞回来，
     * 一次扫描又是几百条分片，而闸门看起来还在（见 isSegmentCandidate）。
     */
    if (isSegmentCandidate(url, pathExt)) return null;

    const classified = classifyByExt(url, pathExt);
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
        tabIds: [tabId],
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
        const item = itemFromCandidate(candidate, pageUrl, pageTitle, tabId);
        if (!item) continue;
        // 页内扫描与网络层共用同一张去重表：同一个地址两条路径都发现时只留一条
        if (!markRecent(item.url, Date.now())) continue;

        emitBridgeEvent('sniffed-media', pushItem(item));
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
 *
 * 扫的是**这个标签页**（不是全部）：导航事件天然带 tabId，而"刚加载完的那一页"
 * 正是用户此刻在看的。全部标签页的补齐由打开开关时那一次全量扫描负责。
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
 * 扫一遍给定的全部标签页，把新增条数加起来。
 *
 * 串行而不是 `Promise.all`：每个标签页的扫描都要把脚本注入页面并在主世界里
 * 求值，几十个并发注入会让浏览器卡住，而结果是同一份列表里的追加 ——
 * 顺序无所谓，代价却有所谓。
 */
const scanTabs = async (tabIds: number[]): Promise<{ added: number; scanned: number }> => {
    let added = 0;
    let scanned = 0;
    for (const tabId of tabIds) {
        const result = await scanTab(tabId);
        added += result.added;
        scanned += 1;
    }
    return { added, scanned };
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
 * 原样转发到这里，只有球独有、面板没有上下文的（`cookies-*`、`host-ensure`）
 * 留在那边。两份实现必然漂移，实测过一次：给
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
             * 打开开关时立刻扫一遍**全部标签页**。
             *
             * 不这么做的话，用户点开开关看到的是一个空列表 —— 网络层只能看到
             * **之后**发生的请求，而页面早就加载完了。旧实现（useBrowse 的
             * `setSniffEnabled`）就是"打开 = 切页自动扫描 + 网络层持续推送"，
             * 这里保持一致；只是作用域从"当前页"扩到"全部标签页"，与嗅探
             * 本身的作用域对齐。
             */
            if (enabled) await scanTabs(await scanTargets());
            return { enabled: await getEnabled() };
        }

        case 'sniffer-clear':
            clearItems();
            return { cleared: true };

        case 'sniffer-clear-tab':
            return { removed: await clearTab((args as unknown as { tabId: number }).tabId) };

        case 'sniffer-tabs':
            return { tabs: await listTabs() };

        case 'sniffer-close-tab':
            return closeTab((args as unknown as { tabId: number }).tabId);

        /*
         * 当前活动标签页。
         *
         * **嗅探不用它**（作用域已是全部标签页），Agent 球那四个数据页签用：
         * `tamper-*` 与 `page-storage-*` 不带 tabId 时作用于活动标签页，
         * 界面必须显示同一个答案，否则"改了规则但页面没生效"无从解释。
         */
        case 'sniffer-active-page':
            return activePageInfo();

        case 'sniffer-scan': {
            const only = (args as { tabId?: number }).tabId;
            // 指定了标签页就只扫它（自检脚本要可控）；否则扫全部
            if (typeof only === 'number' && only >= 0) return scanTab(only);
            return scanTabs(await scanTargets());
        }

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
            const { saved } = await saveRules(next, await requireTabId(tabId));
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
            /*
             * pageUrl 取自**刚解析出的那个 tabId**，而不是另问一次"当前活动标签页"。
             *
             * 面板要拿它显示"这些存储属于哪个页面"。调用方指定了 tabId 时
             * （Agent 工具、自检脚本）另问一次活动标签页会答成另一个页面 ——
             * 显示的地址与实际读到的存储对不上，而两处都"成功"。
             */
            let pageUrl = '';
            try {
                pageUrl = (await chrome.tabs.get(tabId)).url || '';
            } catch {
                // 标签页刚被关掉：存储已经读到了，地址留空比报错有用
            }
            return { local, session, cookies, pageUrl };
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
 * 三条通道的消息都会到这里：球（经桥）、offscreen 宿主、chat-port。
 * **必须按 `target` 分流**。
 *
 * 不分流会怎样：宿主推的 `ai-delta`（`target: 'chat'`）被当成未知消息，
 * SW 回一条 `{ok:false}`，而 chat-port 同时在等自己的回包 —— 于是"谁来回这一条"
 * 变成了竞态。协议里带 `target` 就是为了让这件事是确定的。
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
     * 发给别的文档（offscreen 宿主、chat-port）的消息不是给 SW 的，直接放行。
     *
     * 不 return true 就不会占用响应通道，消息继续由真正的接收方处理。
     */
    if (envelope?.target === 'host' || envelope?.target === 'chat') return false;

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
 * 合并会让'面板能不能调 cookies-get'没有答案"。那个理由对 `cookies-*` /
 * `host-ensure` 成立，但**对嗅探那一批不成立** —— 它们两边
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

        case 'sniffer-clear-tab':
            return dispatchBridge('sniffer-clear-tab', { tabId: message.tabId });

        case 'sniffer-tabs':
            return dispatchBridge('sniffer-tabs', {});

        case 'sniffer-close-tab':
            return dispatchBridge('sniffer-close-tab', { tabId: message.tabId });

        case 'sniffer-scan':
            return dispatchBridge('sniffer-scan', { tabId: message.tabId });

        /*
         * 嗅探已经不用它了，但 **Agent 球还在用**：规则 / 请求头 / 存储 / JWT
         * 四个页签要显示"这些操作作用于哪个页面"。删掉这条分支会让那四个页签
         * 报"未知消息"—— 而嗅探自己一切正常，看起来像 Agent 坏了。
         */
        case 'sniffer-active-page':
            return dispatchBridge('sniffer-active-page', {});

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
            await engine.actions.send(action.prompt);
            return { done: true };
        case 'stop':
            engine.actions.stop();
            return { done: true };
        case 'clear':
            engine.actions.clear();
            return { done: true };
        case 'compact':
            return { compaction: await engine.actions.compact() };
        case 'set-compact-ratio':
            engine.actions.setCompactRatio(action.ratio);
            return { done: true };
        case 'remove-message':
            engine.actions.removeMessage(action.id);
            return { done: true };
        case 'rewind':
            return { prompt: engine.actions.rewindTo(action.id) };
        /*
         * 会话四条。返回值都是**布尔**而不是 `{done:true}`：这四条都可能被合法地
         * 拒绝（到上限 / 运行中 / 只剩一条），而"点下去什么也没发生"必须能被球看见
         * —— 原因由引擎写进 `error`，随后那份快照会把它画出来。
         */
        case 'new-session':
            return { done: await engine.actions.newSession() };
        case 'switch-session':
            return { done: await engine.actions.switchSession(action.id) };
        case 'rename-session':
            engine.actions.renameSession(action.id, action.title);
            return { done: true };
        case 'delete-session':
            return { done: await engine.actions.deleteSession(action.id) };
        default: {
            const never: never = action;
            throw new Error(`未知 Agent 动作：${JSON.stringify(never)}`);
        }
    }
};
