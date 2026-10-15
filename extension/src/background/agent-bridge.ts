import { AgentEngine, memoryStorage } from '../agent/engine';
import type { ChatPort, EngineSnapshot, EngineStorage } from '../agent/engine';
import type { SandboxRequest, SandboxResult } from '../../../shared/meta';
import { pageHost } from '../offscreen/page-host';
import { createChatPort } from './chat-port';
import { emitBridgeEvent, requestApp } from './bridge-port';

/**
 * Agent 在 service worker 里的接线。
 *
 * ## 引擎放哪：SW 还是 offscreen
 *
 * 拆成两半：
 *
 * - **引擎（状态机 + 工具派发）放 SW**。它要 `chrome.tabs` / `chrome.cookies` /
 *   `chrome.debugger` 这一整套 API，而 offscreen 文档**没有** chrome.* 的大部分
 *   命名空间（它是个普通页面）。放过去的话每个动作都要再转发一次。
 * - **模型调用放 offscreen**。一次流式补全可能几分钟，而 SW 空闲约 30 秒被回收。
 *
 * 所以真正的风险是"SW 在 Agent 跑着的时候被回收"。对策是**只要引擎在跑就持续
 * 唤醒**：每一步工具调用、每一次流式增量都会碰 chrome API，而 Chrome 的规则是
 * "扩展 API 活动会重置空闲计时器"。轮内还有一道显式保活（见 keepAlive）。
 *
 * ## 消息必须按 requestId 分流
 *
 * 流式增量是**广播**的（响应通道只有一个终值，装不下持续增量），所以这个文件
 * 会收到属于**任何一个**球的事件。按 requestId 对回本地登记的那次调用，
 * 认不出的一律忽略 —— 否则 A 球的输出会出现在 B 球的对话里。
 */

/* ========================================================================== */
/* 1. 存储端口                                                                */
/* ========================================================================== */

/**
 * `chrome.storage.local` 上的引擎存储。
 *
 * 不用 `storage.session`：对话历史该活过浏览器重启 —— 用户关掉浏览器再打开，
 * 上一次的排查过程还在，这是这个功能可用性的前提。
 */
const chromeStorage: EngineStorage = {
    load: async <T,>(key: string, fallback: T): Promise<T> => {
        const got = await chrome.storage.local.get(key);
        return key in got ? (got[key] as T) : fallback;
    },
    save: async (key, value) => {
        await chrome.storage.local.set({ [key]: value });
    },
};

/* ========================================================================== */
/* 2. 引擎实例                                                                */
/* ========================================================================== */

/**
 * 本机沙箱端口。
 *
 * 单独一个函数而不是塞进 `pageHost`：那一层是"页面宿主"，而沙箱与页面无关，
 * 它的对端是桌面应用的 Node 能力（见 bridge.ts 的 `sandbox` 归属）。
 *
 * 不再放宽等待时长：exec 删掉之后，剩下的都是本机文件读写，毫秒级 ——
 * 默认 5 秒足够，给太长只会让"应用没在跑"表现为一直转圈。
 */
const sandboxPort = (request: SandboxRequest): Promise<SandboxResult> => requestApp<SandboxResult>(
    'sandbox',
    request,
);

/**
 * 全局单例。
 *
 * **只能有一个。** 引擎持有对话历史与执行队列；两个实例意味着两套
 * 真值，而"哪一套是对的"没有答案。SW 被回收后重新求值本文件，`hydrate()`
 * 从 storage 把历史读回来 —— 实例重建，但状态不丢。
 */
let engine: AgentEngine | null = null;

/** 最近一次快照。球随时可能问"现在什么状态"，而引擎的推送是增量的 */
let lastSnapshot: EngineSnapshot | null = null;

/** 引擎是否正在跑一轮。用来决定保活定时器开不开 */
let running = false;

/**
 * 保活。
 *
 * SW 的空闲回收按"最后一次扩展 API 活动"计时。Agent 的一步里可能有长时间
 * 没有 chrome API 调用（模型正在生成），那时计时器会走满。所以轮内每 20 秒
 * 主动碰一次 `chrome.storage` —— 它是最便宜的 API，不产生副作用。
 *
 * 轮结束就停：不跑的时候让它正常回收，常驻保活等于让扩展永远占着一个进程。
 */
let keepAliveTimer: number | null = null;

const startKeepAlive = (): void => {
    if (keepAliveTimer !== null) return;
    keepAliveTimer = self.setInterval(() => {
        void chrome.storage.local.get('agent-keepalive').catch(() => undefined);
    }, 20000);
};

const stopKeepAlive = (): void => {
    if (keepAliveTimer === null) return;
    self.clearInterval(keepAliveTimer);
    keepAliveTimer = null;
};

/** 把快照广播给球，并顺手更新保活状态 */
const publish = (snapshot: EngineSnapshot): void => {
    lastSnapshot = snapshot;
    const nowRunning = snapshot.status !== 'idle' || snapshot.compacting;
    if (nowRunning && !running) startKeepAlive();
    if (!nowRunning && running) stopKeepAlive();
    running = nowRunning;

    void chrome.runtime.sendMessage({ target: 'ball', kind: 'agent-snapshot', snapshot })
        .catch(() => undefined);
    /*
     * 同时推给应用。
     *
     * 球现在跑在 Electron 窗口里（见 app/main/orbs.js），它收不到
     * `chrome.runtime` 的广播，只能经 native messaging 拿。两条都发是因为
     * 页面里的 content script 球还没删干净之前可能两种形态并存。
     *
     * `snapshot` 里含 `actions`（一组函数），过桥时会被 JSON 丢掉 ——
     * 那是**有意的**：球只能通过 `agent-action` 端点驱动引擎，
     * 不能拿到函数直接调。这也正是桥该有的边界。
     */
    emitBridgeEvent('agent-snapshot', snapshot);
};

/** 取引擎，第一次调用时构造并恢复历史 */
const getEngine = async (): Promise<AgentEngine> => {
    if (engine) return engine;
    const created = new AgentEngine({
        host: pageHost,
        storage: chromeStorage,
        chat: createChatPort(ensureOffscreen),
        sandbox: sandboxPort,
        onDelta: (delta) => {
            void chrome.runtime.sendMessage({ target: 'ball', kind: 'agent-delta', delta })
                .catch(() => undefined);
            emitBridgeEvent('agent-delta', delta);
        },
        onSnapshot: publish,
    });
    engine = created;
    await created.hydrate();
    return created;
};

/* ========================================================================== */
/* 3. offscreen 宿主文档                                                      */
/* ========================================================================== */

const OFFSCREEN_PATH = 'offscreen.html';

/**
 * 确保 offscreen 文档存在。
 *
 * 三种状态要分清，混在一起会让"创建"被反复调用：
 *   · 不存在 → 创建；
 *   · 存在且正常 → 直接返回；
 *   · **正在创建中** → 等同一个 Promise。`createDocument` 是异步的，两次
 *     并发调用都会看到"不存在"，然后第二次抛 "Only a single offscreen
 *     document may be created"。
 */
let offscreenCreating: Promise<void> | null = null;

export const ensureOffscreen = async (): Promise<void> => {
    if (await chrome.offscreen.hasDocument()) return;
    if (offscreenCreating) return offscreenCreating;

    offscreenCreating = chrome.offscreen
        .createDocument({
            url: OFFSCREEN_PATH,
            /*
             * reasons 是必填且**必须是枚举里的值**。选 WORKERS 是因为它最贴近
             * 实际用途：这个文档承载一个长跑的异步任务。
             *
             * ⚠️ 这个枚举值与真实用途不完全吻合（Chrome 没有"跑网络请求"这一项）。
             * 它只是给用户看的说明，不影响权限 —— 但要知道这一处是迁就 API 形状。
             */
            reasons: ['WORKERS' as chrome.offscreen.Reason],
            justification: '在扩展页面里执行长时间的模型调用，避免 service worker 空闲回收中断对话。',
        })
        .finally(() => {
            offscreenCreating = null;
        });

    return offscreenCreating;
};

/* ========================================================================== */
/* 4. 导出给消息路由用                                                         */
/* ========================================================================== */

export interface AgentBridge {
    getEngine: () => Promise<AgentEngine>;
    ensureOffscreen: () => Promise<void>;
    snapshot: () => EngineSnapshot | null;
}

export const agentBridge: AgentBridge = {
    getEngine,
    ensureOffscreen,
    snapshot: () => lastSnapshot,
};

/** 测试与降级路径用：不落盘、不发网络的引擎 */
export const createMemoryEngine = (chat: ChatPort): AgentEngine => new AgentEngine({
    host: pageHost,
    storage: memoryStorage(),
    chat,
    /**
     * 内存引擎不接本机沙箱，如实报"未接通"。
     *
     * 不能回 `{bytes:0}` 之类的成功值 —— 那会把一个没接的功能伪装成合法状态，
     * 模型收到成功就照着往下走（`host.ts` 里 `tamper` 可选化踩过同一坑）。
     */
    sandbox: async () => ({ error: '这个引擎实例没有接通本机沙箱。' }),
    onDelta: () => undefined,
    onSnapshot: () => undefined,
});
