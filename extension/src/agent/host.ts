import type { CookieItem, HeaderRule, TamperRule } from '../../../shared/meta';

/**
 * Agent 引擎的宿主接口。
 *
 * ## 为什么要有这一层
 *
 * 应用里那份 Agent 通过 `AgentDeps` 拿到三个东西：`getActiveWebview()`、
 * `onPageReady()`、`tamper`。它假定宿主是一个 Electron `<webview>` 元素 ——
 * 那个前提随自建浏览器外壳一起消失了。
 *
 * 直接改调用点是不行的：`useAgent.ts` 里有 11 处 `deps.`，散在工具派发、
 * 导航等待、自动执行三条路径上。**把它们逐个换成 chrome.* 调用，等于让
 * "Agent 跑在什么环境里"这件事渗进业务逻辑**，而它本来只该是一个接口问题。
 *
 * 所以把差异收进这一个接口：引擎不认识 webview、不认识 tabId、不认识
 * chrome.*，只认识"执行一段代码""导航到某个地址""页面就绪了"。
 *
 * ## 与 AgentDeps 的对应关系
 *
 * | AgentDeps | 这里 | 为什么变了 |
 * |---|---|---|
 * | `getActiveWebview()` | `activeTab()` | 浏览器里没有"当前 webview"，只有 tabId + URL |
 * | `webview.executeJavaScript()` | `evaluate()` | 宿主是 chrome.debugger，见 page-host |
 * | `webview.loadURL()` | `navigate()` | 同上 |
 * | `onPageReady()` | `onPageReady()` | 语义相同，事件源从 webview 换成 webNavigation |
 * | `tamper` | `tamper` | 语义相同，实现换到插件侧 |
 *
 * ## 所有成员都是必填的
 *
 * 曾经把 `tamper` 标成可选、并在缺失时让工具如实报"未接入"。那个设计是错的：
 * 它把一个**未完成的功能**伪装成一种合法状态，模型收到"未接入"只会换个方式
 * 再试，而用户看到的是"Agent 说它改不了"。现在插件侧有完整的规则引擎
 * （`background/tamper.ts`），接口就该是必填的 —— 缺了是类型错误，不是运行时分支。
 */

/** 一个页面目标的标识。tabId 是唯一键，URL 是给模型看的 */
export interface AgentTab {
    id: number;
    url: string;
}

/** 在页面里执行一段代码的结果。失败也返回字符串，由引擎决定怎么回灌 */
export interface EvaluateResult {
    /** 页面返回的值（已序列化成字符串）。出错时是错误文案 */
    value: string;
    /** 这次执行是不是失败（页面抛错、宿主不可用、超时） */
    failed: boolean;
}

export interface AgentHost {
    /** 当前要操作的页面。没有可用页面时返回 null */
    activeTab: () => Promise<AgentTab | null>;
    /**
     * 在指定页面的主世界执行代码。
     *
     * **不传超时**：`Runtime.evaluate` 没有 abort，页面死循环时那个 Promise 永远
     * 不 settle，所以超时必须由宿主自己 race 出来 —— 它是宿主能力的差异，
     * 不是调用方该关心的事。
     */
    evaluate: (tabId: number, code: string) => Promise<EvaluateResult>;
    /** 导航并等页面就绪。返回最终地址 */
    navigate: (tabId: number, url: string) => Promise<{ url: string; loaded: boolean }>;
    /** 页面就绪广播。返回退订函数 */
    onPageReady: (cb: (tabId: number, url: string) => void) => () => void;

    /** 读页面的 localStorage / sessionStorage 原文 */
    readWebStorage: (tabId: number, area: 'local' | 'session') => Promise<string>;
    writeWebStorage: (tabId: number, area: 'local' | 'session', key: string, value: string) => Promise<boolean>;
    removeWebStorage: (tabId: number, area: 'local' | 'session', key: string) => Promise<boolean>;

    /** 读当前页面的 Cookie（含 HttpOnly —— 页面 JS 读不到的那些） */
    getCookies: (tabId: number) => Promise<CookieItem[]>;
    setCookie: (tabId: number, cookie: CookieItem) => Promise<boolean>;
    removeCookie: (tabId: number, name: string) => Promise<boolean>;

    /**
     * 篡改规则引擎。
     *
     * ## 为什么 `rules` 是异步的
     *
     * 规则的唯一权威是 `chrome.storage.local`，而读它是异步的。曾经把它做成
     * 同步 getter（读内存镜像）—— 于是**读到的可能是"还没加载完"的空数组**：
     * 用户明明存了规则，`tamper get` 回一个空列表，模型据此以为没有规则，
     * 转头又加了一遍。把它做成 `await` 之后，"读到未加载状态"在类型上就不存在了。
     *
     * `applyRules` 是**只改内存不落盘**的那个（工具层语义：模型改的规则立刻
     * 生效，但用户点「应用更改」才持久化）。落盘版是 `saveRules`。
     */
    tamper: {
        rules: () => Promise<{
            interceptRules: TamperRule[];
            requestRules: TamperRule[];
            headerRules: HeaderRule[];
        }>;
        applyRules: (intercept: TamperRule[], request: TamperRule[], headers: HeaderRule[]) => void;
        /** 改规则并落盘，同时立刻对指定标签页注入一次 */
        saveRules: (intercept: TamperRule[], request: TamperRule[], headers: HeaderRule[], tabId?: number) => Promise<boolean>;
    };
}
