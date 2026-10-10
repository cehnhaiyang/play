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
 * ## 两个成员是**可选**的，且这是刻意的
 *
 * `tamper` 依赖规则引擎，而规则引擎还没接进来。给它一个空实现（存下规则
 * 但没人执行）比没有更糟：模型会收到 `applied: true`，然后在页面上什么都
 * 看不到，还查不出为什么。所以缺宿主时工具如实报"未接入"。
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
     * 篡改规则引擎。**未接入时不存在**。
     *
     * 不提供它时 `tamper` 工具会如实报错，而不是假装成功 ——
     * 规则存下来却没人执行，是本项目里最难查的一类故障。
     *
     * `rules` 是**摊平**的规则集合。应用侧那份 `TamperState` 把它裹在
     * `state.rules` 里，而引擎只需要这三张表 —— 照搬那层嵌套会让引擎多认识
     * 一个它不关心的结构，也更容易在迁移时把 `state.state` 写错。
     */
    tamper?: {
        rules: {
            interceptRules: TamperRule[];
            requestRules: TamperRule[];
            headerRules: HeaderRule[];
        };
        applyRules: (intercept: TamperRule[], request: TamperRule[], headers: HeaderRule[]) => void;
    };
}
