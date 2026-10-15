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

/** 应用对插件请求的应答 */
interface AppResponse {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
}

/** 处理应用请求的分派函数。由 service-worker 注入，避免这里认识所有端点 */
type Dispatcher = (method: string, params: unknown) => Promise<unknown>;

let dispatcher: Dispatcher | null = null;

let port: chrome.runtime.Port | null = null;

/**
 * 在途的插件→应用请求：id → 等待者。
 *
 * 与 `dispatcher` 是**两个方向**，不要混：那个是应用问插件，这个是插件问应用。
 * 插件要读应用的设置（模型配置的所有者是应用）就得有这条路。
 */
const outgoing = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}>();

let nextRequestId = 1;

/**
 * 一条请求等多久算超时。
 *
 * 默认值只管"读一份配置"这一类：本来就是本机来回，给太长会让"应用没在跑"
 * 表现为模型调用一直转圈。
 *
 * **但它管不了沙箱的 exec**：那一条允许跑到十分钟（见
 * `shared/meta/type.ts` 的 `SANDBOX_EXEC_TIMEOUT_MAX_MS`），用默认值的话
 * 表现是"命令明明还在执行，插件却报了应用没回应"。所以超时改成逐条传入，
 * 默认值只兜住没有传的那些。
 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * 向应用发一条请求。
 *
 * 连接不在时**立刻失败**，不排队。理由同应用侧那句：配置是所有后续动作的前提，
 * 排队只会把"应用没开"延迟成一次莫名其妙的模型调用失败。
 *
 * `timeoutMs` 只放宽**等待**，不改变"应用必须自己收摊"这件事 —— 应用侧该有它
 * 自己的执行超时（沙箱的 exec 就有），不能靠调用方等多久它就跑多久。
 */
export const requestApp = <T,>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
    if (!port) return Promise.reject(new Error('本机应用未连接，读不到设置。'));

    const wait = timeoutMs ?? REQUEST_TIMEOUT_MS;
    const id = `ext-${Date.now().toString(36)}-${(nextRequestId += 1).toString(36)}`;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            outgoing.delete(id);
            reject(new Error(`应用在 ${Math.round(wait / 1000)} 秒内没有回应：${method}`));
        }, wait);

        outgoing.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        if (!post({ id, method, params })) {
            outgoing.delete(id);
            clearTimeout(timer);
            reject(new Error('写入应用失败（连接已断开）'));
        }
    });
};

/** 把一条应答交回等待者 */
const settleOutgoing = (message: AppResponse): boolean => {
    const entry = outgoing.get(message.id);
    if (!entry) return false;
    outgoing.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || '应用返回了失败'));
    return true;
};

/** 连接断开时让在途请求当场失败，否则每一条都要等满超时 */
const failOutgoing = (reason: string): void => {
    for (const [, entry] of outgoing) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
    }
    outgoing.clear();
};

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
            // 握手成功才把退避重置：connectNative 不抛只说明 host 进程起来了，
            // 而"起来了但应用没在跑"同样要退避，不能当成功
            reconnectDelay = RECONNECT_MIN_MS;
            notifyReady(true);
            return;
        }

        /*
         * 三个方向在这一条 Port 上，按形状分辨，顺序不能换：
         *   · 握手行（hello）
         *   · 应用发来的请求（id + method）→ 我们回包
         *   · 应用对**我们**请求的应答（id，没有 method）→ 交给等待者
         *
         * 应答要放在请求之前判：应答没有 method，所以两者本不会撞；
         * 但若先用 `message.id && message.method` 兜底，一旦将来给应答也带上了
         * 形状相近的字段，它就会被当成请求再回一次包，等待者却永远等不到。
         */
        if (message.id && settleOutgoing(message as unknown as AppResponse)) return;
        if (message.id && message.method) handleAppRequest(message);
    });

    created.onDisconnect.addListener(() => {
        if (port === created) port = null;
        notifyReady(false);
        // 在途请求跟着这条连接一起作废：不回包的话每一条都要等满自己的超时
        failOutgoing('与应用连接已断开');
        /*
         * 断开就重连，**但带退避**。
         *
         * 断开有四种原因，只有一种该放弃：
         *   · 应用重启（端口与 token 都换了）→ 必须重连，这是主要场景；
         *   · host 进程被杀 → 必须重连；
         *   · SW 即将被回收 → 重连一次把它留住；
         *   · host 没注册（没跑过 host:install）→ 重连必然再失败。
         *
         * 最后一种靠退避兜住：失败间隔一路涨到上限，不会变成刷屏的忙循环。
         * 而没有重连的话，用户唯一的出路是重启浏览器 —— 那正是要消掉的事。
         */
        scheduleReconnect();
    });

    return created;
};

/**
 * 重连退避。
 *
 * 从 1 秒翻倍到 30 秒封顶。前几轮快是为了让"应用重启"这种最常见的场景
 * 在一两秒内恢复；封顶是为了让"host 没装"这种必然失败的场景安静下来。
 */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const scheduleReconnect = (): void => {
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (port) return;
        const ok = ensureBridge();
        reconnectDelay = ok ? RECONNECT_MIN_MS : Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
        // 连上了不代表握手成功，下一轮失败时还要退避，所以这里不重置
        if (!ok) scheduleReconnect();
    }, reconnectDelay);
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
