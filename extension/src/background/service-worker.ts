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
 * 2. **内存状态不可依赖。**
 *    开关与结果都落 `chrome.storage`。内存里只留"重建成本高且丢了无害"的东西
 *    （比如去重用的时间戳表 —— 丢了最多多推一条）。
 *
 * 3. **没有 DOM。**
 *    `document`、`window`、`localStorage` 都不存在。所以共享的 `const.ts`
 *    只能取它的纯函数与常量，不能碰它的存储工具函数。
 */
import {
    classifyResponse,
    deriveTitle,
} from '../shared/classify';
import {
    MAX_SNIFFED_ITEMS,
    SNIFF_DEDUP_MS,
    STORAGE_KEYS,
    type BallEvent,
    type BallRequest,
    type ExtensionResponse,
    type SniffedMedia,
} from '../shared/protocol';
import { agentBridge } from './agent-bridge';
import { emitBridgeEvent, ensureBridge, isBridgeReady, setDispatcher } from './bridge-port';
import type { AgentEngine } from '../agent/engine';

/* ========================================================================== */
/* 1. 状态：一律落 storage，内存只做缓存                                       */
/* ========================================================================== */

/** 去重表：URL → 上次推送时间。丢了无害（最多多推一条），所以留在内存 */
const recentUrls = new Map<string, number>();

/**
 * 写操作的串行化闸门。
 *
 * `chrome.storage` 的读-改-写不是原子的：两个响应几乎同时到达时，
 * 两边都读到同一份旧数组、各自 push、后写的覆盖先写的 —— 结果是**丢条目**。
 * 嗅探恰恰是高频并发的（一个页面同时发几十个请求），所以必须串起来。
 */
let writeChain: Promise<unknown> = Promise.resolve();
const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(task, task);
    // 链上保留失败，避免一次拒绝卡死后续所有写操作
    writeChain = next.catch(() => undefined);
    return next;
};

const getEnabled = async (): Promise<boolean> => {
    const got = await chrome.storage.local.get(STORAGE_KEYS.SNIFFER_ENABLED);
    // 默认**关闭**：与应用侧"持续嗅探"开关同语义，不打开就不推任何结果。
    // 默认开启会让用户一装插件就被动收集浏览记录。
    return got[STORAGE_KEYS.SNIFFER_ENABLED] === true;
};

const setEnabled = async (enabled: boolean): Promise<void> => {
    await chrome.storage.local.set({ [STORAGE_KEYS.SNIFFER_ENABLED]: enabled });
};

const getItems = async (): Promise<SniffedMedia[]> => {
    const got = await chrome.storage.session.get(STORAGE_KEYS.SNIFFED_ITEMS);
    const items = got[STORAGE_KEYS.SNIFFED_ITEMS];
    return Array.isArray(items) ? (items as SniffedMedia[]) : [];
};

/**
 * 追加一条嗅探结果。
 *
 * 列表是**工作列表不是归档**：超过上限丢最旧的。不设上限的话，
 * 开着嗅探刷一晚上视频，storage.session 会顶到 10MB 配额然后**所有写操作
 * 一起失败**（包括开关），表现为"插件整个失灵"。
 */
const pushItem = (item: SniffedMedia): Promise<SniffedMedia[]> =>
    serialize(async () => {
        const items = await getItems();
        const next = [item, ...items].slice(0, MAX_SNIFFED_ITEMS);
        await chrome.storage.session.set({ [STORAGE_KEYS.SNIFFED_ITEMS]: next });
        return next;
    });

const clearItems = (): Promise<void> =>
    serialize(async () => {
        await chrome.storage.session.set({ [STORAGE_KEYS.SNIFFED_ITEMS]: [] });
    });

/**
 * 把一条事件推给悬浮球。
 *
 * ## `target: 'ball'` 不能省
 *
 * 球的监听器按 `target === 'ball'` 过滤（它必须过滤 —— 否则 offscreen 的
 * 流式增量也会被它当成嗅探结果）。漏掉这个字段时，事件发得出去、球收得到，
 * 但**被球自己丢掉**：表现为"打开嗅探开关后列表一直是空的，刷新页面才出现"。
 * 这类故障没有任何报错，只能靠盯住这里的字段。
 *
 * ## 球没开时 sendMessage 会抛
 *
 * "Could not establish connection" 是**正常情况**不是错误 —— 用户没在看那个
 * 标签页时球可能还没注入。必须吞掉，否则每次嗅探都在控制台刷一条红色报错，
 * 真正的故障反而被淹没。
 */
const notifyBall = (event: BallEvent): void => {
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
    const last = recentUrls.get(url);
    if (last && now - last < SNIFF_DEDUP_MS) return;
    recentUrls.set(url, now);
    if (recentUrls.size > 1000) {
        for (const [key, t] of recentUrls) {
            if (now - t > SNIFF_DEDUP_MS) recentUrls.delete(key);
        }
    }

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

    await pushItem(item);
    notifyBall({ target: 'ball', kind: 'sniffed-media', item });
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
 * 一个在扩展进程内，一个跨进程。**故意不合并成一个函数** ——
 * 合并就要把"调用方在哪"变成参数，而那个参数只影响怎么回包，
 * 不影响做什么；拆开之后每条路径都短，谁调谁一目了然。
 */
const dispatchBridge = async (method: string, params: unknown): Promise<unknown> => {
    const args = (params || {}) as Record<string, never>;

    switch (method) {
        case 'sniffer-get-state':
            return { enabled: await getEnabled(), items: await getItems() };

        case 'sniffer-set-enabled':
            await setEnabled(Boolean((args as { enabled?: boolean }).enabled));
            return { enabled: await getEnabled() };

        case 'sniffer-clear':
            await clearItems();
            return { cleared: true };

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
 * 与面板的 dispatch 分开：球能做的事**严格多于**面板（它能驱动 Agent、
 * 能附着调试器），而面板没有那个上下文。合成一个 switch 会让"面板能不能
 * 调 page-eval"这个问题永远没有答案。
 */
const dispatchBall = async (message: BallRequest): Promise<unknown> => {
    switch (message.kind) {
        case 'sniffer-set-enabled':
            await setEnabled(message.enabled);
            return { enabled: message.enabled };

        case 'sniffer-get-state':
            return { enabled: await getEnabled(), items: await getItems() };

        case 'sniffer-clear':
            await clearItems();
            return { cleared: true };

        case 'downloads-start':
            return { downloadId: await downloadsStart(message.url, message.filename) };

        case 'cookies-get':
            return cookiesGet(message.url);

        case 'cookies-set':
            return { saved: await cookieSet(message.url, message.name, message.value) };

        case 'cookies-remove':
            await cookieRemove(message.url, message.name);
            return { removed: true };

        /*
         * Agent 的三条：引擎挂在 agentBridge 上，球只负责转发。
         *
         * 这些消息**不带 tabId**：引擎每次都问宿主的 `activeTab()`，
         * 那是"当前操作哪个页面"的唯一权威。球传一个自己的 tabId 会让同一个
         * 事实有两个存放处 —— 用户切标签页后两边立刻不一致。
         */
        case 'host-ensure':
            await agentBridge.ensureOffscreen();
            return { ready: true };

        case 'agent-snapshot': {
            const engine = await agentBridge.getEngine();
            return { snapshot: engine.snapshot() };
        }

        case 'agent-action': {
            const engine = await agentBridge.getEngine();
            return { result: await runAgentAction(engine, message) };
        }

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

