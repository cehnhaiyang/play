/**
 * 插件内部的消息协议。
 *
 * ## 三个执行环境，刻意分开
 *
 * 各有各的能力边界，消息**不能混着发**：
 *
 *   · **service worker**（`background/`）—— 有 `chrome.*` 全套，没有 DOM，
 *     空闲约 30 秒被回收。放短命、事件驱动的活：嗅探、cookie、下载、debugger。
 *   · **offscreen 文档**（`offscreen/`）—— 有 DOM、有 localStorage，生命周期
 *     跟扩展走（不受 30 秒回收影响）。放长命、要持续在途的活：Agent 的模型调用。
 *   · **content script**（`content/`）—— 在页面里，有 DOM 但**受页面 CSP 约束**。
 *     只做展示与输入，不发任何网络请求。
 *
 * 曾经还有第四个：side panel。它被删掉了 —— 悬浮球已经在页面上，侧边栏
 * 只是同一批数据的第二个视图，而那个视图只有几百像素宽、还得用户主动点开。
 * 留着它的代价是每个能力都要维护两条界面路径，收益是零。
 *
 * ## 为什么每条消息都带 `target`
 *
 * content script 的 `chrome.runtime.sendMessage` 会同时送到 SW 与 offscreen ——
 * 两边都挂 `onMessage` 时，"谁来回这一条"取决于谁先调 `sendResponse`，
 * 而那是竞态。所以每条消息显式声明目标，各环境只处理属于自己的那些。
 * 写错目标的表现是"消息发出去没人接"，而不是偶发的错答案。
 *
 * ## 与 `shared/meta/bridge.ts` 的 `BridgeRequest` 不是一回事
 *
 * 这里全在扩展进程内，消息不会被序列化截断，也没有 native messaging 的
 * 1MB 上限；`BridgeRequest` 是跨进程的，要分片、要版本握手。混用一套类型
 * 会让"这个字段能不能放"变成看运气 —— 在这里随手塞一张 base64 图片没问题，
 * 同样的代码走桥就会静默失败。
 */
import type { AiChatMessage, AiConfig, AiUsage, CookieItem, HeaderRule, MediaSourceChannel, MediaType, ReasoningEffort, TamperRule } from '../../../shared/meta';

/* ========================================================================== */
/* 0. 公共                                                                     */
/* ========================================================================== */

/** 统一回包。失败也要有回包 —— 否则调用方会一直等 */
export interface ExtensionResponse<T = unknown> {
    ok: boolean;
    result?: T;
    error?: string;
}

/**
 * 一条嗅探结果。
 *
 * 字段与球推给播放器的 `PlayMediaItem` 对应（`type` 到那边叫 `mediaType`），
 * 另外多两个嗅探自己用的：`tabIds`（归属哪个标签页）与 `foundAt`（排序）。
 */
export interface SniffedMedia {
    url: string;
    title: string;
    type: MediaType;
    ext: string;
    /**
     * 这条是怎么来的。
     *
     * 两个值对用户有实质区别，不是同义标签：
     *   · `network` —— webRequest 观察到的真实请求（最可信，一定能下）；
     *   · `local` —— 页内扫描（DOM / Performance / 源码正则）找到的地址，
     *     可能从没被请求过。
     */
    source: MediaSourceChannel;
    /** 防盗链 Referer。Chrome 的 webRequest **不提供** referrer，靠请求头捕获 */
    referer?: string;
    /** 发起该请求的页面地址 */
    pageUrl?: string;
    /**
     * 这条资源被**哪些标签页**请求过。
     *
     * 是数组而不是单个 id，因为列表按 URL 合并（见 `pushItem`）：同一个地址
     * 被两个标签页请求过时，只记第一个会让"切到另一个标签页就看不到它"——
     * 而那个标签页确实请求过它。一个数字装不下这个事实。
     *
     * 与 `pageUrl` 不是同一件事，两个都要留：标签页导航之后 pageUrl 会变，
     * 而标签页身份不变。界面上的标签栏筛选走 tabIds（"这个标签页下嗅到的
     * 全部资源"本来就跨它的多次导航），防盗链要的是 pageUrl。
     *
     * 非标签页发起的请求（Service Worker、预取）没有标签页，Chrome 给的是 -1，
     * 那种一律记空数组 —— 记成 -1 会让它冒充一个不存在的标签页。
     */
    tabIds?: number[];
    /** 发现时间（毫秒时间戳），列表按它倒序 */
    foundAt: number;
}

/**
 * 浏览器里的一个标签页。
 *
 * 只有 `id` 是稳定的身份；`url` / `title` 随时会变（导航、SPA 改标题）。
 * 所以界面按 id 记住"选中了哪个"，显示用 url/title —— 拿 url 当键会在
 * 页面跳转的那一刻把选中项弄丢。
 */
export interface BrowserTab {
    id: number;
    url: string;
    title: string;
    /** 是不是用户当前正在看的那个 */
    active: boolean;
    windowId: number;
}

/** 嗅探列表上限。超过后丢最旧的：这是工作列表不是归档 */
export const MAX_SNIFFED_ITEMS = 500;

/** chrome.storage 键名 */
export const STORAGE_KEYS = {
    /** 嗅探总开关。放 local：用户希望它跨浏览器重启保持 */
    SNIFFER_ENABLED: 'snifferEnabled',
    /** 嗅探结果。放 session：SW 会被回收，但结果不该活过浏览器重启 */
    SNIFFED_ITEMS: 'sniffedItems',
    /** 悬浮球位置。放 local：用户摆好的位置是长期偏好 */
    ORB_POS: 'orbPos',
} as const;

/* ========================================================================== */
/* 1. 悬浮球 ↔ service worker                                                  */
/* ========================================================================== */

/**
 * 悬浮球发给 SW 的请求。
 *
 * `target` 固定为 `'sw'` —— offscreen 文档看到这个字段就不处理。
 * 存在的理由见文件头"为什么每条消息都带 target"。
 */
/** 球对引擎发起的一次动作。形状对齐 `AgentState['actions']`，逐条映射 */
export type AgentAction =
    | { type: 'send'; prompt: string }
    | { type: 'stop' }
    | { type: 'clear' }
    | { type: 'compact' }
    | { type: 'set-compact-ratio'; ratio: number }
    | { type: 'remove-message'; id: string }
    | { type: 'rewind'; id: string }
    | { type: 'new-session' }
    | { type: 'switch-session'; id: string }
    | { type: 'rename-session'; id: string; title: string }
    | { type: 'delete-session'; id: string };

export type BallRequest =
    | { target: 'sw'; kind: 'sniffer-get-state' }
    | { target: 'sw'; kind: 'sniffer-set-enabled'; enabled: boolean }
    | { target: 'sw'; kind: 'sniffer-clear' }
    /** 清掉某个标签页来的全部结果（「清空此标签页」） */
    | { target: 'sw'; kind: 'sniffer-clear-tab'; tabId: number }
    /**
     * 浏览器当前打开的全部标签页。
     *
     * 球要把它们画成一条标签栏（切换即筛选、点 × 即关闭），而"打开了哪些
     * 标签页"是**浏览器侧的事实**，球（Electron 窗口）无从得知。
     */
    | { target: 'sw'; kind: 'sniffer-tabs' }
    /**
     * 关闭一个浏览器标签页。
     *
     * 球上点标签栏的 × 走这条 —— 用户要的是"在这里关掉就等于在浏览器里关掉"，
     * 而不是只把这一条从球上藏起来。
     */
    | { target: 'sw'; kind: 'sniffer-close-tab'; tabId: number }
    /**
     * 手动嗅探一次：页内扫描（DOM / Performance / __playinfo__ / 源码正则）。
     *
     * 与"持续嗅探"开关无关 —— 开关关着时点它也只扫这一次，
     * 网络层不会因此开始推送。旧实现（useBrowse 的 `scan`）就是这个语义。
     *
     * **不传 tabId 表示扫全部标签页**：嗅探的作用域是"浏览器里打开的一切"，
     * 而不是"用户此刻正在看的那个"。
     */
    | { target: 'sw'; kind: 'sniffer-scan'; tabId?: number }
    /**
     * 当前活动标签页。
     *
     * **嗅探不再用它** —— 嗅探的作用域已经是"浏览器里打开的全部标签页"，
     * 球按 `SniffedMedia.tabId` 筛选，不再需要问"当前是哪个页面"。
     * 留着是给 Agent 球的「规则 / 请求头 / 存储 / JWT」四个页签显示作用对象：
     * 那几条端点不带 tabId 时由插件作用于活动标签页，界面必须显示同一个答案。
     */
    | { target: 'sw'; kind: 'sniffer-active-page' }
    | { target: 'sw'; kind: 'downloads-start'; url: string; filename?: string }
    /** 读引擎当前快照。球每次打开面板都要一次 —— 它可能刚随页面注入 */
    | { target: 'sw'; kind: 'agent-snapshot' }
    /** 对引擎发起一次动作 */
    | { target: 'sw'; kind: 'agent-action'; action: AgentAction }
    /**
     * 确保 offscreen 宿主文档已存在。
     *
     * 必须经 SW 中转：`chrome.offscreen` 不在 content script 可见的 API 集合里。
     */
    | { target: 'sw'; kind: 'host-ensure' }
    | { target: 'sw'; kind: 'cookies-get'; url: string }
    | { target: 'sw'; kind: 'cookies-set'; url: string; name: string; value: string }
    | { target: 'sw'; kind: 'cookies-remove'; url: string; name: string }
    /** 读篡改规则（面板的「规则」「请求头」两个页签） */
    | { target: 'sw'; kind: 'tamper-get' }
    /** 写篡改规则。只传要改的类别，其余原样保留 */
    | {
        target: 'sw';
        kind: 'tamper-set';
        tabId?: number;
        interceptRules?: TamperRule[];
        requestRules?: TamperRule[];
        headerRules?: HeaderRule[];
    }
    /** 只注入、不改规则：把当前页补齐（切标签页之后那个页面还没装钩子） */
    | { target: 'sw'; kind: 'tamper-inject'; tabId?: number }
    /** 读页面存储（local / session / cookie）——「存储」与「JWT」页签的数据源 */
    | { target: 'sw'; kind: 'page-storage-read'; tabId?: number }
    /** 写一条存储。`value === null` 表示删除；`area === 'cookie'` 时另收完整 cookie 对象 */
    | {
        target: 'sw';
        kind: 'page-storage-write';
        tabId?: number;
        area: 'local' | 'session' | 'cookie';
        key: string;
        value: string | null;
        cookie?: CookieItem;
    };

/* ========================================================================== */
/* 2. service worker ↔ offscreen 宿主文档                                      */
/* ========================================================================== */

/**
 * 模型调用的一次请求。
 *
 * 走 offscreen 而不是 SW 或球自己的原因，两条都是硬约束：
 *
 *  1. **球里不能发**。MV3 起 content script 的 fetch 不再豁免页面 CSP，
 *     落在 `connect-src` 白名单外的站点上会直接失败 —— 且失败与否取决于
 *     用户打开的是哪个网站，表现为"Agent 时好时坏"。
 *  2. **SW 里不稳**。一次流式补全可能持续几分钟，而 SW 空闲约 30 秒就被回收。
 *     它是否会被"在途 fetch"续命，我没有可实测的依据，不能拿它当设计前提。
 *
 * offscreen 文档没有这两个问题：它是扩展自己的页面，CSP 是自己的那份，
 * 生命周期也不随空闲回收。
 */
export interface HostChatRequest {
    target: 'host';
    kind: 'ai-chat';
    /** 用于把流式增量与最终结果对回这一次请求 */
    requestId: string;
    /**
     * 本次调用使用的模型配置。
     *
     * **必须随请求带进来，不能由 offscreen 自己读。** 配置的所有者是应用主进程
     * （settings.json），offscreen 文档既没有 electronAPI，扩展的 localStorage
     * 也不是它存放的地方 —— 让它自己读的结果是每一级回落依次命中、最终拿着
     * 内置默认值去调模型，且全程不报错。SW 能过桥拿到真值，所以由 SW 填。
     */
    aiConfig: AiConfig;
    system?: string;
    messages: AiChatMessage[];
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: ReasoningEffort;
}

export type HostRequest =
    | HostChatRequest
    | { target: 'host'; kind: 'ai-ready' }
    /** 用户点了停止：中止在途的那次补全 */
    | { target: 'host'; kind: 'ai-cancel'; requestId: string };

/**
 * 宿主文档推给 SW 里 chat-port 的流式增量与终局。
 *
 * `target` 是 `'chat'` 而不是 `'ball'`：收件人从来不是悬浮球，而是
 * `background/chat-port.ts` 里的登记表（它按 requestId 认领属于自己的那些）。
 * 球跑在 Electron 窗口里，根本收不到 `chrome.runtime` 广播 —— 曾经写 `'ball'`
 * 只会让下一个人以为球在监听这条通道。
 *
 * 也不能复用 `'sw'`：那是 `BallRequest` 的收件人，SW 会把这条当成未知端点
 * 回一句 `{ok:false}`，与 chat-port 抢同一个响应通道。
 */
export type HostEvent =
    | { target: 'chat'; kind: 'ai-delta'; requestId: string; content?: string; reasoning?: string }
    | { target: 'chat'; kind: 'ai-done'; requestId: string; reply?: string; usage?: AiUsage; error?: string };
