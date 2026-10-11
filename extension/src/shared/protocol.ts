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
import type { AiChatMessage, AiUsage, MediaType } from '../../../shared/meta';

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
 * 形状与 `shared/meta/interface.ts` 的 `FoundLink` 对齐（`source` 固定 'network'），
 * 这样将来交给播放器时不需要再转一次。
 */
export interface SniffedMedia {
    url: string;
    title: string;
    type: MediaType;
    ext: string;
    source: 'network';
    /** 防盗链 Referer。Chrome 的 webRequest **不提供** referrer，靠请求头捕获 */
    referer?: string;
    /** 发起该请求的页面地址 */
    pageUrl?: string;
    /** 发现时间（毫秒时间戳），列表按它倒序 */
    foundAt: number;
}

/** 嗅探列表上限。超过后丢最旧的：这是工作列表不是归档 */
export const MAX_SNIFFED_ITEMS = 500;

/** 同一 URL 在这个窗口内不重复推送（毫秒） */
export const SNIFF_DEDUP_MS = 5000;

/** 嗅探列表上限在界面上也要用（面板与悬浮球各自裁剪本地副本） */
export const SNIFF_RENDER_MAX = 300;

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
    | { type: 'run-script'; id: string }
    | { type: 'remove-script'; id: string }
    | { type: 'toggle-script'; id: string };

export type BallRequest =
    | { target: 'sw'; kind: 'sniffer-get-state' }
    | { target: 'sw'; kind: 'sniffer-set-enabled'; enabled: boolean }
    | { target: 'sw'; kind: 'sniffer-clear' }
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
    /**
     * 直接执行一段脚本，不走引擎的主循环。
     *
     * 给"手动运行一条已保存脚本"用：它不属于任何一次模型调用，走 dispatchTool
     * 反而会被 busy 闸门挡住。串行化仍由引擎的队列保证。
     */
    | { target: 'sw'; kind: 'page-eval'; tabId: number; code: string }
    | { target: 'sw'; kind: 'page-navigate'; tabId: number; url: string }
    | { target: 'sw'; kind: 'cookies-get'; url: string }
    | { target: 'sw'; kind: 'cookies-set'; url: string; name: string; value: string }
    | { target: 'sw'; kind: 'cookies-remove'; url: string; name: string };

/** SW 推给悬浮球的事件（广播，不针对某一条请求） */
export type BallEvent =
    | { target: 'ball'; kind: 'sniffed-media'; item: SniffedMedia }
    /** 引擎快照（消息、脚本、状态） */
    | { target: 'ball'; kind: 'agent-snapshot'; snapshot: unknown }
    /** 流式增量。整个快照太大，逐字重发不现实 */
    | { target: 'ball'; kind: 'agent-delta'; delta: { content?: string; reasoning?: string } };

/* ========================================================================== */
/* 2. 悬浮球 ↔ offscreen 宿主文档                                              */
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
    system?: string;
    messages: AiChatMessage[];
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: 'low' | 'high' | 'max';
}

export type HostRequest =
    | HostChatRequest
    | { target: 'host'; kind: 'ai-ready' }
    /** 用户点了停止：中止在途的那次补全 */
    | { target: 'host'; kind: 'ai-cancel'; requestId: string };

/** 宿主文档推给悬浮球的流式增量与终局 */
export type HostEvent =
    | { target: 'ball'; kind: 'ai-delta'; requestId: string; content?: string; reasoning?: string }
    | { target: 'ball'; kind: 'ai-done'; requestId: string; reply?: string; usage?: AiUsage; error?: string };

