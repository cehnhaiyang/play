import { BRIDGE_PROTOCOL_VERSION, NATIVE_HOST_NAME } from '../../../shared/meta/bridge';
import type { BridgeResponse } from '../../../shared/meta/bridge';

/**
 * service worker ↔ 本机应用 的 native messaging 桥。
 *
 * ## 方向：由插件发起，之后双向
 *
 * 应用**无法主动连插件** —— `connectNative` 只有扩展能调。所以连接一律由这里
 * 发起：
 *
 *     SW ──connectNative──▶ Chrome 拉起 host.js ──TCP──▶ Electron 主进程
 *
 * 连上之后这条 Port 是双向的：应用发请求过来（球要嗅探结果、要驱动 Agent），
 * 插件发事件过去（嗅探到新媒体、Agent 推快照与流式增量）。
 *
 * ## 这条 Port 是悬浮球的唯一通路，也是它的生命线
 *
 * 球跑在 Electron 窗口里（见 app/main/orbs.js），拿不到 `chrome.*`。
 * 它要的一切都从这条 Port 走。于是有一个必须成立的推论：
 *
 *     **SW 被回收 = 球与插件失联 = 球变成一块死界面。**
 *
 * 而 MV3 的 SW 空闲约 30 秒就被终止。所以这里不能只是"懒连接"：
 * 连接断了之后应用**没有任何办法把 SW 叫醒**（host.js 会随 Port 关闭被
 * Chrome 杀掉，连 TCP 都断）。这正是本文件存在的理由 ——
 * 它要保证 Port 一直开着。
 *
 * 见 `keepAlive` 的注释：MV3 里"有打开的 Port"本身就会延长 SW 的生命。
 */

/* ========================================================================== */
/* 1. 连接                                                                    */
/* ========================================================================== */

/** 应用发来的一条请求 */
interface AppRequest {
    id: string;
    method: string;
    params?: unknown;
}

/** 处理应用请求的分派函数。由 service-worker 注入，避免这里认识所有端点 */
type Dispatcher = (method: string, params: unknown) => Promise<unknown>;

let dispatcher: Dispatcher | null = null;

let port: chrome.runtime.Port | null = null;

/** 连上之后要通知的订阅者（球要知道"插件已就绪"） */
const readyListeners = new Set<(connected: boolean) => void>();

const notifyReady = (connected: boolean): void => {
    for (const listener of readyListeners) {
        try {
            listener(connected);
        } catch {
            // 单个订阅者出错不影响其他
        }
    }
};

/** 往应用发一条消息。Port 不在就丢掉 —— 事件是"锦上添花"，不该抛 */
const post = (message: unknown): boolean => {
    if (!port) return false;
    try {
        port.postMessage(message);
        return true;
    } catch {
        return false;
    }
};

/**
 * 应用请求的分派。
 *
 * 每一条都要回包，包括失败的那些。不回的话应用侧会一直等 ——
 * 球上表现为"点了没反应"，而真正的原因可能只是一条消息格式不对。
 */
const handleAppRequest = (message: AppRequest): void => {
    void (async () => {
        const reply = (response: Omit<BridgeResponse, 'id'>): void => {
            post({ id: message.id, ...response });
        };
        try {
            if (!dispatcher) throw new Error('插件尚未就绪（分派器未注册）');
            reply({ ok: true, result: await dispatcher(message.method, message.params) });
        } catch (e) {
            reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    })();
};

const connect = (): chrome.runtime.Port => {
    const created = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    created.onMessage.addListener((raw: unknown) => {
        const message = raw as (AppRequest & { hello?: string; protocol?: number }) | null;
        if (!message) return;

        /*
         * 握手。host.js 连上应用之后会先报一次协议版本。
         *
         * 不一致要**明确报错**，不能降级尝试 —— 否则旧应用配新插件会表现为
         * "某些端点神秘失败"，而不是一句能看懂的"请更新"。
         */
        if (message.hello === 'theplay-host') {
            if (message.protocol !== BRIDGE_PROTOCOL_VERSION) {
                post({
                    hello: 'theplay-extension',
                    protocol: BRIDGE_PROTOCOL_VERSION,
                    error: `协议版本不一致：插件 ${BRIDGE_PROTOCOL_VERSION}，应用 ${message.protocol}`,
                });
                return;
            }
            post({ hello: 'theplay-extension', protocol: BRIDGE_PROTOCOL_VERSION });
            notifyReady(true);
            return;
        }

        if (message.id && message.method) handleAppRequest(message);
    });

    created.onDisconnect.addListener(() => {
        if (port === created) port = null;
        notifyReady(false);
        /*
         * 断开之后**不在这里自动重连**。
         *
         * `onDisconnect` 里立刻 connectNative 会在应用没运行时变成一个
         * 无限重连循环，每轮都在控制台留一条错误。重连交给 `ensureBridge`：
         * 它由真实需求（球打开、用户操作）触发，那时重试是有意义的。
         */
    });

    return created;
};

/**
 * 确保 Port 开着。
 *
 * 幂等：已经有 Port 就复用。并发的调用共用同一次连接 ——
 * 建两条 Port 会让"应用的回包走哪条"变成竞态。
 */
export const ensureBridge = (): boolean => {
    if (port) return true;
    try {
        port = connect();
        return true;
    } catch (e) {
        // connectNative 在 host 没注册时直接抛。这里不往上抛：
        // "应用没装/没运行"是正常状态，不是异常
        port = null;
        void e;
        return false;
    }
};

/** 注册分派器。service-worker 在顶层调用一次 */
export const setDispatcher = (fn: Dispatcher): void => {
    dispatcher = fn;
};

/** 连接状态变化。回调立刻用当前状态调一次 */
export const onBridgeReady = (listener: (connected: boolean) => void): (() => void) => {
    readyListeners.add(listener);
    listener(!!port);
    return () => readyListeners.delete(listener);
};

export const isBridgeReady = (): boolean => !!port;

/* ========================================================================== */
/* 2. 推送事件给应用                                                          */
/* ========================================================================== */

/**
 * 推一条事件给应用（转发给球）。
 *
 * 应用没连上时**静默丢弃**，不排队。理由：这些事件是高频的（嗅探一个页面
 * 能出几十条、流式增量逐字到达），排队会在应用启动的瞬间灌过去几百条，
 * 而它们全都已经过期了 —— 球打开时本来就会主动拉一次全量快照。
 */
export const emitBridgeEvent = (event: string, payload: unknown): void => {
    post({ event, payload });
};
