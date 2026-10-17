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
    // 只报主框架：子 iframe 加载完成不代表页面可用，报上去会让 navigate 提前返回
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
 * 与旧实现的差别：这里**不需要**轮询停止标志，也不需要比对 webview 身份 ——
 * `webNavigation.onCompleted` 本身就带 tabId，比"全局广播 + 身份比对"准确。
 * 唯一保留的是超时：页面可能一直加载不完（挂在某个永不返回的资源上）。
 */
const waitForReady = (tabId: number, timeoutMs = 15000): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
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
        const timer = self.setTimeout(() => finish(false), timeoutMs);
    });

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
/* 导出                                                                       */
/* ========================================================================== */

const activeTab = async (): Promise<AgentTab | null> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== 'number') return null;
    return { id: tab.id, url: tab.url || '' };
};

export const pageHost: AgentHost = {
    activeTab,

    evaluate: evaluateInPage,

    navigate: async (tabId: number, url: string) => {
        /*
         * 先订阅后导航：`chrome.tabs.update` 在地址非法时直接 reject，
         * 那时等待必须能取消，否则监听器与定时器会泄漏到 15 秒超时。
         */
        const ready = waitForReady(tabId);
        try {
            await chrome.tabs.update(tabId, { url });
        } catch (e) {
            // 取消这次等待。没有 cancel 的话上面那个 Promise 会挂满 15 秒，
            // 期间 readyListeners 里一直留着这个回调。
            readyListeners.clear();
            throw e;
        }
        const loaded = await ready;
        return { url, loaded };
    },

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
            const tab = await activeTab();
            return applyRules(
                { interceptRules: intercept, requestRules: request, headerRules: headers },
                tab?.id ?? null,
            );
        },
    },
};
