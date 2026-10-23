import type { CookieItem, HeaderRule, TamperRule } from '../../../shared/meta';

/**
 * Agent 引擎的宿主接口。
 *
 * ## 为什么要有这一层
 *
 * 引擎要的每一项能力 —— 在页面里跑脚本、导航、读写存储与 Cookie、装篡改钩子 ——
 * 都需要 tabId 与 `chrome.*`，而"现在操作哪个页面"每秒都可能变。
 * **把这些调用直接写进主循环，等于让"Agent 跑在什么环境里"渗进业务逻辑**，
 * 而它本来只是一个接口问题。
 *
 * 所以差异收进这一个接口：引擎不认识 tabId、不认识 chrome.*，只认识"执行一段
 * 代码""导航到某个地址"。真实实现见 `offscreen/page-host.ts`（它由 service
 * worker import，不在 offscreen 文档里求值 —— 那个文档没有 chrome.tabs）；
 * 测试塞一个假宿主就能把整个主循环跑起来。
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

export interface AgentHost {
    /**
     * 当前要操作的页面 —— 由模型用 `focus` 指定。没 focus 过、或那个标签页
     * 已被关掉时返回 null。
     */
    target: () => Promise<AgentTab | null>;
    /**
     * 打开或刷新一个页面，把它交给模型当作后续所有页面工具的目标。
     *
     * **不激活标签页**（`active: false`）：用户往往正在别的网页里干活，把焦点抢过来
     * 等于让 Agent 一动手就把人赶出他正在看的东西。这也正是这一层存在的理由 ——
     * 以前"操作哪个页面"取自浏览器的活动标签页，于是 Agent 的目标跟着用户切标签页
     * 跑；现在它由模型自己指定，用户切到哪儿都不影响。
     *
     * 已存在同地址的标签页时**强制刷新**它而不是新开一个：模型要的是一份干净的
     * 页面（新的主世界、清掉的内存态），而不是又一张重复的标签页。
     *
     * 返回**最终**地址（重定向后会与请求的不同）：模型要靠它判断自己到底落在哪。
     */
    focus: (url: string) => Promise<{ id: number; url: string; loaded: boolean }>;
    /**
     * 在指定页面的主世界执行代码，返回**已序列化的观察值**。
     *
     * 失败也是一条观察值（`{"__agentError":"..."}`），不另开一个字段表示成败。
     * 曾经返回 `{value, failed}`：`failed` 由宿主在四条失败路径上各写一次，
     * 而读它的一处也没有 —— 引擎判成败走的是 isJsErrorResult（成败还要参与
     * 历史重建，只有它能对"页面数据里自带 error 字段"与"脚本抛错"分岔）。
     * 同一个事实存两处，迟早出现"宿主说失败、字符串说成功"。
     *
     * **不传超时**：`Runtime.evaluate` 没有 abort，页面死循环时那个 Promise 永远
     * 不 settle，所以超时必须由宿主自己 race 出来 —— 它是宿主能力的差异，
     * 不是调用方该关心的事。
     */
    evaluate: (tabId: number, code: string) => Promise<string>;

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
     * 持久化的那份在 `chrome.storage.local`，而读它是异步的。曾经把它做成
     * 同步 getter（直接读内存镜像）—— 于是**读到的可能是"还没加载完"的空数组**：
     * 用户明明存了规则，`tamper get` 回一个空列表，模型据此以为没有规则，
     * 转头又加了一遍。把它做成 `await` 之后，"读到未加载状态"在类型上就不存在了。
     *
     * 注意镜像会**领先**存储：`applyRules` 之后规则已经对页面生效，但还没落盘。
     * 所以 `tamper get` 读到的是"当前真正生效的"，不一定是"存下来的"。
     *
     * `applyRules` 是**改内存 + 注入当前页面、不落盘**的那个（工具层语义：模型改的
     * 规则立刻对页面生效，但用户点「应用更改」才持久化）。这里刻意**没有**落盘版：
     * 模型不该越过用户把浏览器行为永久改掉，而一个用不上的口只会让人以为有人在用。
     *
     * 返回**注入**结果，不是持久化结果：`false` 表示"规则已进内存，但这个页面
     * 没能装上钩子"（没有可用标签页、受限页面）。工具层必须把它说出来 ——
     * 导航会重建主世界，注入失败时页面还在跑旧规则，而"改了没反应"没有任何症状。
     */
    tamper: {
        rules: () => Promise<{
            interceptRules: TamperRule[];
            requestRules: TamperRule[];
            headerRules: HeaderRule[];
        }>;
        applyRules: (intercept: TamperRule[], request: TamperRule[], headers: HeaderRule[]) => Promise<boolean>;
    };
}
