import type { CookieItem } from '../../../shared/meta';
import type { AgentHost, AgentTab } from '../agent/host';
import { applyRules, loadRules } from '../background/tamper';

/**
 * 页面宿主：用 `chrome.debugger` 在页面**主世界**执行代码。
 *
 * ## 为什么是 debugger 而不是 chrome.userScripts
 *
 * 两条路的差别不在 API 好不好用，而在**能不能调到页面自己的函数**：
 *
 * - `chrome.userScripts.execute({ world: 'MAIN' })` 能进主世界，但需要用户在
 *   扩展详情页手动打开「允许用户脚本」开关（默认关闭）。不开则整个 js 工具
 *   不可用，且失败信息是"没有权限"，与"这段代码写错了"难以区分。
 * - `chrome.debugger` + `Runtime.evaluate` 不需要任何用户开关，拿到的是真正的
 *   主世界执行上下文 —— 页面自己定义的函数、闭包里的变量都能直接调。
 *
 * 代价是页面顶部会出现一条「正在调试此浏览器」提示条，且与用户自己打开的
 * DevTools 互斥（两者不能同时附着同一个标签页）。这是明确接受的取舍：
 * Agent 的用途就是逆向与调试，用户不会同时开着 DevTools 看同一个页面。
 *
 * ## 附着必须按标签页复用
 *
 * 每次 `evaluate` 都 attach/detach 会让提示条反复闪烁，而且 attach 本身有
 * 往返开销 —— 一轮几十步就是几十次。所以按 tabId 记住已附着的状态，
 * 标签页关闭时清掉（`chrome.tabs.onRemoved`）。
 *
 * ## `Runtime.evaluate` 没有 abort
 *
 * 页面死循环时那个 Promise 永远不 settle。所以超时只能靠 `Promise.race`
 * 自己造：超时后返回一个失败结果，让主循环能继续 —— 那个真正卡住的
 * Promise 会被丢弃（它的结果没人再读），页面本身仍然卡着，这是
 * `Runtime.evaluate` 的固有限制，不是这里能修的。
 */

/** 附着时声明的协议版本。Chrome 要求主版本匹配，这里是 DevTools Protocol 的版本 */
const PROTOCOL_VERSION = '1.3';

/**
 * 页面脚本单次执行超时。
 *
 * **真值在这里**，因为 race 由宿主自己做（见文件头：`Runtime.evaluate` 没有
 * abort，页面死循环时那个 Promise 永远不 settle）。曾经在 agent/prompt.ts 里
 * 另有一份同值的 EXEC_TIMEOUT_MS，谁也没读 —— 找超时的人改错那一份不会有
 * 任何报错，只有这一份生效。
 */
const EVAL_TIMEOUT_MS = 60000;

/**
 * 等一个页面加载完成的超时。
 *
 * 必须有上限：页面可能一直加载不完（挂在某个永不返回的资源上）。超时不是失败，
 * 返回 `loaded: false` 让模型自己决定要不要等 —— 半加载的页面里它照样能跑脚本，
 * 而"报错退出"会让它重开一遍。
 */
const READY_TIMEOUT_MS = 15000;

/** 已附着的标签页。值是附着 Promise，用来把并发的 attach 合并成一次 */
const attached = new Map<number, Promise<void>>();

/**
 * 页面导航监听者。
 *
 * `chrome.webNavigation.onCompleted` 是 SW 侧的事件，而这里要把它转成
 * "某个 tabId 就绪了"的回调，供 `waitForReady` 结束导航等待。
 */
const readyListeners = new Set<(tabId: number, url: string) => void>();

/**
 * 顶层注册：**必须在模块顶层同步调用**。
 *
 * service worker 空闲约 30 秒就被终止，下次事件到来时重新求值本文件。
 * 注册写在 async 函数里或 await 之后，重启后事件就没人听了 ——
 * 表现为"用一会儿就不响应导航了"。
 */
chrome.webNavigation.onCompleted.addListener((details) => {
    // 只报主框架：子 iframe 加载完成不代表页面可用，报上去会让 focus 提前返回
    if (details.frameId !== 0) return;
    for (const listener of readyListeners) listener(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
});

/** 附着调试器。同一个标签页并发调用只会真正 attach 一次 */
const ensureAttached = (tabId: number): Promise<void> => {
    const existing = attached.get(tabId);
    if (existing) return existing;

    const task = chrome.debugger
        .attach({ tabId }, PROTOCOL_VERSION)
        .catch((e: unknown) => {
            // 附着失败要把它从表里摘掉，否则后续每一次调用都会拿到同一个失败
            // Promise，而"重试一次"这个动作永远做不到。
            attached.delete(tabId);
            throw e;
        });
    attached.set(tabId, task);
    return task;
};

/**
 * 执行一段代码，返回序列化后的结果。
 *
 * `awaitPromise: true` 不能省：`buildScriptSource` 包出来的是一个 async IIFE，
 * 不 await 的话拿到的结果是那个 Promise 对象本身（序列化成 `{}`），
 * 模型会以为脚本什么都没返回。
 *
 * `returnByValue: true` 同理：不开的话结果是 RemoteObject 描述符，
 * 形如 `{type:'object', objectId:'...'}`，同样不是模型要的东西。
 */
const evaluateInPage = async (tabId: number, code: string): Promise<string> => {
    try {
        await ensureAttached(tabId);
    } catch (e) {
        return JSON.stringify({ __agentError: `无法附着到页面：${errorText(e)}` });
    }

    let timer = 0;
    const timeout = new Promise<string>((resolve) => {
        timer = self.setTimeout(() => {
            resolve(JSON.stringify({
                __agentError: `脚本执行超过 ${EVAL_TIMEOUT_MS / 1000} 秒未返回（页面可能在死循环或弹窗阻塞）。请把任务拆小：先取少量字段确认选择器，再分步推进，不要一次 return 整个页面。`,
            }));
        }, EVAL_TIMEOUT_MS);
    });

    const run = (async (): Promise<string> => {
        const raw = await chrome.debugger.sendCommand(
            { tabId },
            'Runtime.evaluate',
            {
                expression: code,
                awaitPromise: true,
                returnByValue: true,
                // 关掉 DevTools 的"用户手势"要求：否则在需要手势的接口上
                // （如 fullscreen、clipboard）会直接抛错，而那是页面逻辑的问题，
                // 不是我们该替他判断的
                userGesture: true,
            },
        );

        const result = raw as {
            result?: { value?: unknown };
            exceptionDetails?: {
                exception?: { description?: string };
                text?: string;
                /** 出错位置。CDP 用的是**包装后**源码的行号，消费方负责换算 */
                lineNumber?: number;
                columnNumber?: number;
            };
        };

        /*
         * 页面抛错时协议**不 reject**，而是在 exceptionDetails 里报 ——
         * 不显式读它的话，脚本抛错会被当成"返回了 undefined"，
         * 模型看到 null 会以为页面真的没数据。
         *
         * 行列号一并带上：语法错误只报一句 `Unexpected token ')'` 时模型无从下手，
         * 而它自己重读整段代码往往读不出漏掉的那个括号（实测连撞多次）。
         * 换算与抄行由 `locateScriptError` 做 —— 那是纯函数，位置信息必须原样
         * 传上去，不能在这里就丢掉。
         */
        if (result.exceptionDetails) {
            const detail = result.exceptionDetails.exception?.description
                || result.exceptionDetails.text
                || '页面脚本抛出异常';
            const { lineNumber, columnNumber } = result.exceptionDetails;
            return JSON.stringify({
                __agentError: detail,
                ...(typeof lineNumber === 'number'
                    ? { __agentAt: { line: lineNumber + 1, column: columnNumber ?? 0 } }
                    : {}),
            });
        }

        const value = result.result?.value;
        // buildScriptSource 保证返回值已经是字符串；这里兜一层防它被改动
        return typeof value === 'string' ? value : JSON.stringify(value ?? null);
    })();

    try {
        return await Promise.race([run, timeout]);
    } catch (e) {
        return JSON.stringify({ __agentError: `执行失败：${errorText(e)}` });
    } finally {
        self.clearTimeout(timer);
    }
};

/**
 * 等某个标签页导航完成。
 *
 * 返回句柄而不是裸 Promise：调用方在 `tabs.reload` 失败时要能取消这次等待，
 * 否则监听器与定时器会挂满一整个超时。曾经用 `readyListeners.clear()` 取消 ——
 * 那是**全局**清理，一批里同时 focus 两个页面时会把另一个的等待一起杀掉。
 *
 * `probeLoaded` 是"订阅晚了一步"的补偿，只给建新标签页那条路用：那里 tabId 只有
 * `tabs.create` 返回后才知道，而 `onCompleted` 可能已经错过。刷新那条路**不能**探测
 * —— 那一刻页面还是 `complete` 的（新导航尚未开始），探测会把"还没刷新"当成"刷完了"。
 */
const waitForReady = (
    tabId: number,
    probeLoaded = false,
): { ready: Promise<boolean>; cancel: () => void } => {
    let cancel: () => void = () => undefined;
    const ready = new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            readyListeners.delete(listener);
            self.clearTimeout(timer);
            resolve(ok);
        };
        const listener = (readyTabId: number) => {
            if (readyTabId === tabId) finish(true);
        };
        readyListeners.add(listener);
        const timer = self.setTimeout(() => finish(false), READY_TIMEOUT_MS);
        cancel = () => finish(false);

        if (probeLoaded) {
            void chrome.tabs.get(tabId)
                .then((tab) => { if (tab.status === 'complete') finish(true); })
                .catch(() => undefined);
        }
    });
    return { ready, cancel };
};

/** 读页面的 localStorage / sessionStorage 原文。返回 JSON 字符串 */
const readWebStorage = async (tabId: number, area: 'local' | 'session'): Promise<string> => {
    /*
     * 读的是**页面自己那份** storage。
     *
     * 内容脚本的 localStorage 属于页面 origin，所以从内容脚本读也行 —— 但那要求
     * 内容脚本恰好注入在目标标签页上，而 Agent 可能正操作另一个标签页。
     * 走 debugger 则天然针对指定 tabId。
     */
    const result = await evaluateInPage(tabId, `(() => {
      try {
        const s = ${area === 'local' ? 'localStorage' : 'sessionStorage'};
        const out = {};
        for (let i = 0; i < s.length; i += 1) {
          const k = s.key(i);
          if (k !== null) out[k] = s.getItem(k);
        }
        return JSON.stringify(out);
      } catch (e) {
        return JSON.stringify({ __agentError: String(e && e.message || e) });
      }
    })()`);

    const parsed = safeJson(result);
    if (parsed && typeof parsed.__agentError === 'string') return '{}';
    return result;
};

/** 写页面的 localStorage / sessionStorage */
const writeWebStorage = async (
    tabId: number,
    area: 'local' | 'session',
    key: string,
    value: string,
): Promise<boolean> => {
    const result = await evaluateInPage(tabId, `(() => {
      try {
        ${area === 'local' ? 'localStorage' : 'sessionStorage'}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});
        return 'ok';
      } catch (e) {
        return JSON.stringify({ __agentError: String(e && e.message || e) });
      }
    })()`);
    return result === '"ok"' || result === 'ok';
};

const removeWebStorage = async (
    tabId: number,
    area: 'local' | 'session',
    key: string,
): Promise<boolean> => {
    const result = await evaluateInPage(tabId, `(() => {
      try {
        ${area === 'local' ? 'localStorage' : 'sessionStorage'}.removeItem(${JSON.stringify(key)});
        return 'ok';
      } catch (e) {
        return JSON.stringify({ __agentError: String(e && e.message || e) });
      }
    })()`);
    return result === '"ok"' || result === 'ok';
};

/* ========================================================================== */
/* Cookie：走 chrome.cookies，不走页面                                        */
/* ========================================================================== */

/**
 * 读一个标签页地址下的全部 cookie。
 *
 * **必须走 `chrome.cookies` 而不是页面的 `document.cookie`**：后者读不到
 * HttpOnly 的那些，而会话凭证恰恰几乎总是 HttpOnly。用页面读等于把最关键的
 * 那一半藏起来，模型还会以为"这个站没有登录态"。
 */
const getCookies = async (tabId: number): Promise<CookieItem[]> => {
    const url = await tabUrl(tabId);
    if (!url) return [];
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

/**
 * 覆盖一条 cookie。
 *
 * `chrome.cookies.set` 是**整条覆盖**：漏掉 httpOnly / expirationDate 会让会话
 * cookie 降级甚至掉登录态。所以调用方必须传回从 `getCookies` 拿到的完整对象，
 * 这里不提供"只改值"的便利接口 —— 那正是降级的来源。
 *
 * `domain` 缺失时**不传这个字段**（而不是补一个空串）：空串会让
 * `chrome.cookies.set` 直接报错，而不传则由 Chrome 按 url 的 host 处理。
 * 要注意这两者不等价 —— 域 cookie（`.example.com`）会因此变成 host-only，
 * 这是降级。`getCookies` 永远带 domain，所以只有手工构造的条目会走到这里。
 */
const setCookie = async (tabId: number, cookie: CookieItem): Promise<boolean> => {
    const url = await tabUrl(tabId);
    if (!url) return false;
    const domain = cookie.domain
        ? (cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain)
        : '';
    const result = await chrome.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        ...(domain ? { domain } : {}),
        ...(cookie.path ? { path: cookie.path } : {}),
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
        ...(cookie.sameSite === 'no_restriction' || cookie.sameSite === 'lax'
            || cookie.sameSite === 'strict' || cookie.sameSite === 'unspecified'
            ? { sameSite: cookie.sameSite }
            : {}),
    });
    return !!result;
};

/**
 * 按 name 删 cookie。
 *
 * 与旧实现同一取舍：Chrome 没有"按 path 删"的入口，同名不同 path 会被一起删掉。
 * 这一点在工具返回里如实说明了，不假装精确。
 */
const removeCookie = async (tabId: number, name: string): Promise<boolean> => {
    const url = await tabUrl(tabId);
    if (!url) return false;
    await chrome.cookies.remove({ url, name });
    return true;
};

const tabUrl = async (tabId: number): Promise<string> => {
    try {
        const tab = await chrome.tabs.get(tabId);
        return tab.url || '';
    } catch {
        return '';
    }
};

const safeJson = (text: string): Record<string, unknown> | null => {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/* ========================================================================== */
/* 执行目标                                                                    */
/* ========================================================================== */

/**
 * 模型指定的执行目标。
 *
 * ## 唯一权威
 *
 * `focus` 是**唯一写点**，其余每一个依赖页面的工具都读它。曾经取的是
 * `chrome.tabs.query({active:true})` —— 于是"Agent 在哪个页面干活"这件事
 * 跟着用户切标签页跑：用户切到别的网页工作，Agent 下一步就落到那个页面上，
 * 而"Agent 跑着的时候用户在别处干活"是最常见不过的状态。
 *
 * ## 为什么存在 storage.session 而不是模块变量
 *
 * service worker 空闲约 30 秒就被回收，模块变量随之清零。存成变量的话，
 * 用户隔一分钟再提问，模型看到历史里自己 focus 过，而宿主说"没 focus"——
 * 它会以为工具坏了，转头再 focus 一遍，用户看到的是标签页被莫名刷新。
 *
 * 用 `storage.session` 而不是 `storage.local`：tabId 只在本次浏览器会话内有意义，
 * 重启后编号会从头分配，存过期的 id 会让工具指向一个**陌生页面**。
 */
const FOCUS_STORE_KEY = 'agent-focus-tab';

/**
 * 当前目标页面。没有 focus 过、或那个标签页已被关掉时返回 null。
 *
 * 返回 null 是**正常状态**而不是故障：模型必须自己先 focus，这是本设计的
 * 前提（见 tools.ts 的 NO_PAGE）。所以这里不做任何"回落到活动标签页"的兜底 ——
 * 那会把这个前提悄悄取消掉，而模型永远不会知道自己没 focus 过。
 *
 * 标签页是否还活着由 `tabs.get` 现问，不在别处维护一个"还开着吗"的副本：
 * 用户随时可能关掉它，而那个副本没有任何办法保持同步。
 */
const target = async (): Promise<AgentTab | null> => {
    const got = await chrome.storage.session.get(FOCUS_STORE_KEY);
    const tabId = got[FOCUS_STORE_KEY];
    if (typeof tabId !== 'number') return null;
    try {
        const tab = await chrome.tabs.get(tabId);
        return { id: tabId, url: tab.url || '' };
    } catch {
        return null;
    }
};

/** 找已打开的、地址完全一致的那个标签页。用于"存在就刷新，不存在才新开" */
const findTabByUrl = async (url: string): Promise<number | null> => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((tab) => tab.url === url && typeof tab.id === 'number');
    return typeof hit?.id === 'number' ? hit.id : null;
};

/**
 * 打开或刷新一个页面，并把它设为执行目标。
 *
 * 两条路都**不激活标签页**（`active: false` / 刷新本就不改激活状态）：抢焦点会把
 * 用户从他正在看的页面赶走，而 Agent 的整个意义就是能在后台干活。
 *
 * 刷新是**强制的**，即使页面看起来已经加载完：模型要的是一份干净的页面
 * （新的主世界、清掉的内存态、重新发的请求），而"已经打开了"不等于"已经就绪"。
 */
const focus = async (url: string): Promise<{ id: number; url: string; loaded: boolean }> => {
    const existing = await findTabByUrl(url);
    const tabId = existing ?? await createTab(url);

    const { ready, cancel } = waitForReady(tabId, existing === null);
    if (existing !== null) {
        try {
            await chrome.tabs.reload(existing);
        } catch (e) {
            // 取消这次等待：reload 在标签页刚被关掉时会 reject，不取消的话
            // 监听器与定时器要挂满一整个超时。
            cancel();
            throw e;
        }
    }
    const loaded = await ready;

    await chrome.storage.session.set({ [FOCUS_STORE_KEY]: tabId });
    const tab = await chrome.tabs.get(tabId);
    return { id: tabId, url: tab.url || url, loaded };
};

/**
 * 新建一个后台标签页，返回它的 id。
 *
 * tabId 要等 `create` 返回才知道，而那时导航可能已经跑完了 —— 所以新开这条路
 * 要探测一次当前状态（见 waitForReady 的 probeLoaded）。刷新那条路**不能**探测：
 * 那一刻页面还是加载完成的，会把"还没开始刷新"当成"刷完了"。
 */
const createTab = async (url: string): Promise<number> => {
    const created = await chrome.tabs.create({ url, active: false });
    if (typeof created.id !== 'number') throw new Error('新标签页没有返回 id');
    return created.id;
};

/* ========================================================================== */
/* 导出                                                                       */
/* ========================================================================== */

export const pageHost: AgentHost = {
    focus,
    target,

    evaluate: evaluateInPage,


    readWebStorage,
    writeWebStorage,
    removeWebStorage,
    getCookies,
    setCookie,
    removeCookie,

    /*
     * 篡改规则引擎。
     *
     * 直接转发给 `background/tamper.ts` —— 它才是规则与注入的唯一所有者。
     * 这里**不缓存**规则：每次现读，否则引擎拿到的是 SW 唤醒那一刻的快照，
     * 而用户可能在面板里刚改过。
     *
     * offscreen 文档与 SW 同属一个扩展，import 是免费的（同一个 bundle 图）。
     */
    tamper: {
        rules: () => loadRules(),
        /*
         * 工具层语义：改内存 + 立刻注入当前页面，**不落盘**（落盘要用户在面板里
         * 显式点「应用更改」，见 service-worker 的 tamper-set）。
         *
         * `tabId` 必须传：导航会重建主世界、把钩子冲掉。只改内存镜像的话，
         * 工具回一句"已对当前页面生效"，而页面还在跑旧规则 —— 用户看到的是
         * "改了没反应"，且没有任何报错。没有可用标签页时如实回 false。
         */
        applyRules: async (intercept, request, headers) => {
            const tab = await target();
            return applyRules(
                { interceptRules: intercept, requestRules: request, headerRules: headers },
                tab?.id ?? null,
            );
        },
    },
};
