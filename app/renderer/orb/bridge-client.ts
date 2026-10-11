import type { AgentMessage, AgentState, AgentUsage } from '../../../shared/meta';

/**
 * 球的桥客户端。
 *
 * ## 球与插件之间隔着三层
 *
 *     球（渲染层） → preload → 主进程 → host.js → 插件 SW
 *
 * 这个文件只关心最上面那一跳：把 `window.orbApi.bridge()` 包成一个会抛错的
 * async 调用，并处理"插件没连上"这个必须显示给用户的失败。
 *
 * ## 为什么失败要抛而不是返回 null
 *
 * 球上每一处失败都得让用户看见 —— "插件未连接"与"这条请求失败了"是两件事，
 * 而返回 null 会把两者都变成"界面上什么都没有"，用户无从判断该去开浏览器
 * 还是该重试。抛出去，由界面决定怎么显示。
 */

/** 一条嗅探结果。与插件的 SniffedMedia 同形 */
export interface SniffedMedia {
    url: string;
    title: string;
    type: string;
    ext: string;
    source: 'network';
    referer?: string;
    pageUrl?: string;
    foundAt: number;
}

/** 插件推来的事件名。与 extension/src/background 里 emitBridgeEvent 的取值一一对应 */
export type BridgeEventName = 'sniffed-media' | 'agent-snapshot' | 'agent-delta';

/** 引擎快照过桥后的形状。`actions` 是函数，JSON 序列化时被丢掉 —— 见下 */
export type EngineSnapshot = Omit<AgentState, 'actions'> & { revision: number };

const api = () => {
    const orb = window.orbApi;
    if (!orb) {
        // preload 没加载。这不是"用户没开插件"，是打包/路径出了问题，
        // 所以错误信息要指出来，而不是笼统说一句失败
        throw new Error('orbApi 不存在：preload 没有加载，球无法与主进程通信。');
    }
    return orb;
};

/**
 * 调一个桥端点。
 *
 * `method` 是 `BridgeEndpointName`。**不做方法名白名单** ——
 * 那份表在 shared/meta/bridge.ts，插件收到不认识的方法会明确报错，
 * 在这里再维护一份就是同一个事实存两处。
 */
export const bridge = async <T,>(method: string, params?: unknown): Promise<T> => {
    const res = await api().bridge<T>(method, params);
    if (!res) throw new Error('主进程没有回应（应用可能正在退出）');
    if (!res.ok) throw new Error(res.error || '请求失败');
    return res.result as T;
};

/** 桥连上没有。球用它区分"插件未连接"与"请求失败" */
export const bridgeConnected = async (): Promise<boolean> => {
    try {
        const res = await api().bridgeStatus();
        return !!res?.connected;
    } catch {
        return false;
    }
};

/**
 * 订阅桥的连接状态变化。
 *
 * **不能只查一次。** 应用通常比浏览器先启动，所以球打开那一刻桥几乎总是
 * 未连接的。只在挂载时查一次的话，那句"插件未连接"会永久留在界面上 ——
 * 而它下面的列表其实已经在实时更新，界面自相矛盾。
 */
export const onBridgeStatus = (listener: (connected: boolean) => void): (() => void) => {
    try {
        return api().onBridgeStatus(({ connected }) => listener(connected));
    } catch {
        return () => undefined;
    }
};

/** 订阅插件推来的事件。返回取消订阅的函数 */
export const onBridgeEvent = (
    listener: (event: BridgeEventName, payload: unknown) => void,
): (() => void) => {
    try {
        return api().onEvent(({ event, payload }) => {
            listener(event as BridgeEventName, payload);
        });
    } catch {
        // preload 缺失时界面已经在 bridge() 里报过错，这里不再重复
        return () => undefined;
    }
};

/* ========================================================================== */
/* Agent 的两个动作                                                            */
/* ========================================================================== */

/** 球对引擎发起的一次动作。形状与插件的 AgentAction 逐条对齐 */
export type AgentAction =
    | { type: 'send'; prompt: string }
    | { type: 'stop' }
    | { type: 'clear' }
    | { type: 'compact' }
    | { type: 'set-compact-ratio'; ratio: number }
    | { type: 'remove-message'; id: string }
    | { type: 'rewind'; id: string }
    | { type: 'run-script'; id: string }
    | { type: 'remove-script'; id: string }
    | { type: 'toggle-script'; id: string };

export const agentAction = (action: AgentAction): Promise<unknown> =>
    bridge<{ result: unknown }>('agent-action', { action }).then((r) => r.result);

/* ========================================================================== */
/* 展示辅助                                                                    */
/* ========================================================================== */

/** 上下文占用。只给量级 —— 精确到个位的数字每秒都在变，读它没有意义 */
export const formatTokens = (usage?: AgentUsage): string => {
    const n = usage?.contextTokens ?? 0;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}k tok`;
    return `${n} tok`;
};

export type { AgentMessage, AgentState, AgentUsage };
