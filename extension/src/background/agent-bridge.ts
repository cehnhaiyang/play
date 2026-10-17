import { AgentEngine } from '../agent/engine';
import type { EngineSnapshot, EngineStorage } from '../agent/engine';
import type { SandboxRequest, SandboxResult } from '../../../shared/meta';
import { SANDBOX_NODE_TIMEOUT_MAX_MS } from '../../../shared/meta';
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
 * "扩展 API 活动会重置空闲计时器"。轮内还有一道显式保活（见 startKeepAlive）。
 *
 * ## 推给球只有一条路
 *
 * 球跑在 Electron 窗口里，没有 `chrome.runtime`，所以快照与流式增量都只能经
 * native messaging 过桥。这个文件不碰 `chrome.runtime.sendMessage` —— 见 publish。
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
 * 等待时长必须放宽到 node 动作的最长超时（+10 秒余量）：文件读写是毫秒级，
 * 但一个脚本可以合法地跑到第 5 分钟，而默认 5 秒的等待会先报"应用没回应" ——
 * 脚本其实还在跑，模型却以为失败了，接着再写一遍同一个脚本。
 * 应用侧才是真正钳制执行时长的地方（见 app/main/sandbox.js），这里只负责
 * **等得比它久**，否则超时文案会由错的一方给出。
 */
const sandboxPort = (request: SandboxRequest): Promise<SandboxResult> => requestApp<SandboxResult>(
    'sandbox',
    request,
    SANDBOX_NODE_TIMEOUT_MAX_MS + 10000,
);

/**
 * 全局单例。
 *
 * **只能有一个。** 引擎持有对话历史与执行队列；两个实例意味着两套
 * 真值，而"哪一套是对的"没有答案。SW 被回收后重新求值本文件，`hydrate()`
 * 从 storage 把历史读回来 —— 实例重建，但状态不丢。
 */
let engine: AgentEngine | null = null;

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

/**
 * 把快照推给球，并顺手更新保活状态。
 *
 * **只走桥这一条路。** 球跑在 Electron 窗口里（见 app/main/orbs.js），它没有
 * `chrome.runtime`，收不到扩展内的广播 —— 这里曾经也发一条
 * `chrome.runtime.sendMessage`，理由是"页面里的 content script 球可能还在"，
 * 而 manifest 里早已没有 `content_scripts`：那条消息发给一个不存在的收件人，
 * 代价是每推一版快照就把 1MB 量级的 JSON 结构化克隆一遍。
 *
 * `snapshot` 里含 `actions`（一组函数），过桥时会被 JSON 丢掉 —— 那是**有意的**：
 * 球只能通过 `agent-action` 端点驱动引擎，不能拿到函数直接调。
 */
const publish = (snapshot: EngineSnapshot): void => {
    const nowRunning = snapshot.status !== 'idle' || snapshot.compacting;
    if (nowRunning && !running) startKeepAlive();
    if (!nowRunning && running) stopKeepAlive();
    running = nowRunning;

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
        onDelta: (delta) => emitBridgeEvent('agent-delta', delta),
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

interface AgentBridge {
    getEngine: () => Promise<AgentEngine>;
    ensureOffscreen: () => Promise<void>;
}

export const agentBridge: AgentBridge = {
    getEngine,
    ensureOffscreen,
};
