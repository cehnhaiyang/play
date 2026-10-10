/**
 * MV3 service worker：嗅探、Cookie、下载。
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
    type PanelRequest,
    type PanelResponse,
    type SniffedMedia,
} from '../shared/protocol';

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
 * 通知侧边栏。
 *
 * 面板没开时 `sendMessage` 会抛 "Could not establish connection"，
 * 这是**正常情况**不是错误 —— 必须吞掉，否则每次嗅探都会在控制台刷一条
 * 红色报错，真正的故障反而被淹没。
 */
const notifyPanel = (event: unknown): void => {
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
    notifyPanel({ kind: 'sniffed-media', item });
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

/* ========================================================================== */
/* 4. 下载                                                                    */
/* ========================================================================== */

/**
 * 浏览器的下载列表。
 *
 * 与应用侧的 `browser-downloads` 不同：那是自建外壳自己记的账，
 * 这里是浏览器原生下载管理器，用户按 Ctrl+J 看到的就是同一份。
 */
const downloadsList = async () => {
    const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 200 });
    return items.map((d) => ({
        id: d.id,
        filename: d.filename,
        url: d.url,
        state: d.state,
        paused: d.paused,
        totalBytes: d.totalBytes,
        // 字段名是 bytesReceived 不是 receivedBytes —— 后者是 Electron 的
        // DownloadItem 用的名字，两边的 API 只是像，不通用。
        receivedBytes: d.bytesReceived,
        error: d.error,
        startTime: d.startTime,
    }));
};

const downloadAction = async (
    id: number,
    action: 'pause' | 'resume' | 'cancel' | 'erase' | 'show',
) => {
    switch (action) {
        case 'pause': await chrome.downloads.pause(id); break;
        case 'resume': await chrome.downloads.resume(id); break;
        case 'cancel': await chrome.downloads.cancel(id); break;
        case 'erase': await chrome.downloads.erase({ id }); break;
        case 'show': chrome.downloads.show(id); break;
    }
};

/**
 * 起一个下载。
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
/* 5. 消息路由                                                                */
/* ========================================================================== */

chrome.runtime.onMessage.addListener((message: PanelRequest, _sender, sendResponse) => {
    // 返回 true 才能异步回复。忘了它，面板收到的永远是 undefined，
    // 表现为"界面一直转圈"。
    void (async (): Promise<void> => {
        try {
            const result = await dispatch(message);
            sendResponse({ ok: true, result } satisfies PanelResponse);
        } catch (e) {
            sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies PanelResponse);
        }
    })();
    return true;
});

const dispatch = async (message: PanelRequest): Promise<unknown> => {
    switch (message.kind) {
        case 'sniffer-set-enabled':
            await setEnabled(message.enabled);
            return { enabled: message.enabled };

        case 'sniffer-get-state':
            return { enabled: await getEnabled(), items: await getItems() };

        case 'sniffer-clear':
            await clearItems();
            return { cleared: true };

        case 'cookies-get':
            return cookiesGet(message.url);

        case 'cookies-remove':
            await cookieRemove(message.url, message.name);
            return { removed: true };

        case 'downloads-list':
            return downloadsList();

        case 'downloads-action':
            await downloadAction(message.id, message.action);
            return { done: true };

        case 'downloads-start':
            return { downloadId: await downloadsStart(message.url, message.filename) };

        default: {
            // 穷尽检查：新增 PanelRequest 分支却忘了在这里处理时，
            // 这一行会变成类型错误，而不是运行时的静默 undefined。
            const never: never = message;
            throw new Error(`未知消息：${JSON.stringify(never)}`);
        }
    }
};

/* ========================================================================== */
/* 6. 顶层注册：点图标开侧边栏                                                 */
/* ========================================================================== */

chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => {
        console.error('设置侧边栏行为失败：', error);
    });
