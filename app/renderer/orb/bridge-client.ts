import type { AgentMessage, AgentState, AgentUsage, MediaSourceChannel, MediaType, PlayMediaItem } from '../../../shared/meta';
import { requiresFfmpeg } from '../../../shared/core';

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
    source: MediaSourceChannel;
    referer?: string;
    pageUrl?: string;
    /**
     * 这条资源被哪些浏览器标签页请求过。
     *
     * 是数组而不是单个 id：同一个地址可能被两个标签页请求（同一个视频站开
     * 两个页、或共用的 CDN 资源），只记第一个会让"切到另一个标签页就看不到它"。
     *
     * 空数组表示"不属于任何标签页"（Service Worker 发起的请求、或旧版本
     * 落盘的条目）—— 那种只在「全部」下出现，不冒充某一个标签页。
     */
    tabIds?: number[];
    foundAt: number;
}

/** 浏览器里的一个标签页。与插件的 BrowserTab 同形 */
export interface BrowserTab {
    id: number;
    url: string;
    title: string;
    active: boolean;
    windowId: number;
}

/** 插件推来的事件名。与 extension/src/background 里 emitBridgeEvent 的取值一一对应 */
export type BridgeEventName = 'sniffed-media' | 'tabs-changed' | 'agent-snapshot' | 'agent-delta';

/** 引擎快照过桥后的形状。`actions` 是函数，JSON 序列化时被丢掉 —— 见下 */
export type EngineSnapshot = Omit<AgentState, 'actions'> & { revision: number };

/**
 * 球对引擎发起的一次动作。形状与插件的 `AgentAction` 逐条对齐。
 *
 * 这里**再声明一份**而不是从插件 import：球与插件是两个独立的构建产物
 * （插件由 `extension/vite.config.mts` 构建，球由根 `vite.config` 构建），
 * 一个 import 另一个会把对方的整个依赖图拖进来。而 `test/manifest.test.js`
 * 会比对两边的事件名，`agent-action` 的分支由插件的穷尽检查兜住 ——
 * 漏一条在那里是类型错误，不是运行时的静默 undefined。
 */
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
/* Agent 的动作                                                                */
/* ========================================================================== */

export const agentAction = (action: AgentAction): Promise<unknown> =>
    bridge<{ result: unknown }>('agent-action', { action }).then((r) => r.result);

/**
 * 回退到某条消息之前，返回该条的提问原文。
 *
 * 单独一个函数而不是让调用方 `agentAction({type:'rewind'})` 再拆结果：
 * 返回值形状是这条动作独有的（其它动作回 `{done:true}`），而"回退之后要把
 * 提问填回输入框"是它唯一的用途 —— 让每个调用点自己拆一层 `result.prompt`
 * 等于把同一个形状写两遍。
 */
export const rewindTo = async (id: string): Promise<string> => {
    const result = await agentAction({ type: 'rewind', id }) as { prompt?: string } | null;
    return result?.prompt || '';
};

/* ========================================================================== */
/* 下载路由                                                                    */
/* ========================================================================== */

/**
 * 下载一条嗅探结果。
 *
 * ## 为什么分岔判据放在球里
 *
 * 直链交给插件的 `chrome.downloads`，流媒体交给应用侧的 ffmpeg —— 这是
 * `shared/meta/bridge.ts` 里 `download-media` 那条 `split` 路由的说明。
 * 判据是 `requiresFfmpeg`（`shared/core/media.ts`，唯一真值）。
 *
 * 球**同时**能调这两边（它经桥调插件、经 preload 调主进程），所以分岔放在
 * 这里最省：插件不需要知道应用有没有 ffmpeg，应用也不需要知道浏览器下到哪了。
 *
 * ## 直链为什么不能也走应用
 *
 * `chrome.downloads` 交给浏览器之后，用户在 Ctrl+J 里能看到进度、能暂停、
 * 能断点续传、能重命名 —— 那些浏览器已经做好了。应用侧再实现一遍只会和
 * Ctrl+J 显示得不一样，然后用户不知道该信哪个。
 */
export const downloadMedia = async (item: SniffedMedia): Promise<void> => {
    if (requiresFfmpeg(item.type, item.ext)) {
        const api = window.electronAPI;
        if (!api?.downloadMedia) throw new Error('应用侧下载接口不可用（preload 未加载）。');
        const result = await api.downloadMedia({
            url: item.url,
            title: item.title,
            type: item.type as MediaType,
            ext: item.ext,
            // 防盗链：多数站点校验的是"从哪个页面来的"，所以取 pageUrl 而不是媒体自身地址
            referer: item.referer || item.pageUrl,
        });
        if (!result.success && !result.cancelled) throw new Error(result.message || '下载失败');
        return;
    }

    await bridge('downloads-start', { url: item.url, filename: item.title || undefined });
};

/* ========================================================================== */
/* 推送到应用播放器                                                            */
/* ========================================================================== */

/**
 * 把嗅探结果推进应用播放器。
 *
 * ## 为什么这条不过桥
 *
 * 播放器在**应用**里，插件的 `chrome.downloads` 与它无关；而播放列表的唯一权威
 * 是主窗口的渲染层。球与主窗口同属一个 Electron 进程，走 preload 直达即可 ——
 * 绕插件一圈再回来只会多两跳，且插件根本没有"播放列表"这个概念。
 *
 * ## 为什么不在这里过滤不可播的
 *
 * 判据（`isPlayableMedia`）在 `shared/core` 里，主窗口入列时还会再判一次。
 * 在这里先筛一道等于同一个事实存两处，而两边一旦漂移，症状是"球上点了推送、
 * 播放列表里没有" —— 比让主窗口自己筛更难查。
 */
export const pushToPlayer = async (items: PlayMediaItem[]): Promise<number> => {
    const api = window.orbApi;
    if (!api?.pushToPlayer) throw new Error('推送接口不可用（preload 未加载）。');
    const result = await api.pushToPlayer(items);
    if (result?.error) throw new Error(result.error);
    return result?.sent ?? 0;
};

/* ========================================================================== */
/* 展示辅助                                                                    */
/* ========================================================================== */

/**
 * 嗅探来源的角标文案。
 *
 * 三个来源对用户有实质区别：`network` 是页面真的请求过的（一定能下），
 * `local` 是页内扫描找到的地址，`ai` 是模型从源码里挑的（**可能是猜的**）。
 * 不标出来的话，用户分不清"这条下载失败"是站点的问题还是模型编的地址。
 */
export const SOURCE_LABEL: Record<MediaSourceChannel, string> = {
    network: '网络',
    local: '页面',
    ai: 'AI',
};

/** 上下文占用。只给量级 —— 精确到个位的数字每秒都在变，读它没有意义 */
export const formatTokens = (usage?: AgentUsage): string => {
    const n = usage?.contextTokens ?? 0;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}k tok`;
    return `${n} tok`;
};

export type { AgentMessage, AgentState, AgentUsage };
