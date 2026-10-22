/// <reference types="vite/client" />

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
    AgentState,
    DownloadCapabilities,
    DownloadMediaParams,
    DownloadMediaResult,
    ElectronAPI,
    MediaDownloadProgress,
    MediaSourceChannel,
    MediaType,
    PlayMediaItem,
} from '../../shared/meta';
import { requiresFfmpeg } from '../../shared/core';
import './orb.css';

/**
 * 两个球共用的东西：窗口接口、桥客户端、图标、外壳。
 *
 * ## 为什么挤在一个文件里
 *
 * `app/orb` 只保留两个球各自的入口（`agent.html` / `agent.tsx` 与
 * `sniff.html` / `sniff.tsx`）加上这一个共用文件。下面四块**两个球都要用**，
 * 拆成四个文件等于把目录又摊回去，而复制进两个入口是两个球各存一份 ——
 * 桥的错误处理、外壳的拖动逻辑改一处漏一处，正是最不该有的重复。
 *
 * 四块的职责互不重叠，按出现顺序读即可：接口声明 → 桥 → 图标 → 外壳。
 *
 * ## 这里不放的东西
 *
 * 只有单个球用的东西不进这里：纯展示的格式化（`formatTokens`、来源角标文案）
 * 跟着各自的消费方留在入口里。判据是"是不是与插件/主进程的 IO"，
 * 是 IO 才留下 —— 那部分两个球的用法完全一样。
 */

/* ========================================================================== */
/* 窗口接口                                                                    */
/* ========================================================================== */

/**
 * 球窗口暴露的接口。定义在 `app/main/orb-preload.js`。
 *
 * 声明在渲染层而不是共享类型里：这是**窗口自己的**契约，
 * 主窗口的渲染层没有它（`electronAPI` 也没有球那几个方法），
 * 混进 shared/meta 会让"谁能调什么"变得看不出来。
 *
 * 必须是 `declare global`：模块里的 `interface Window` 只是本模块的局部类型 ——
 * 加不上全局的 `window.orbApi`，于是每个调用点都报"属性不存在"。
 */
declare global {
    interface OrbApi {
        /** 是哪个球 */
        id: string;

        dragStart: (point: { x: number; y: number }) => void;
        dragMove: (point: { x: number; y: number }) => void;
        dragEnd: () => void;

        /*
         * 面板缩放。与拖动同一套：渲染层只报**屏幕坐标**，窗口尺寸怎么算是
         * 主进程的事（最小尺寸、工作区上限都在那边，见 app/main/orbs.js）。
         * 渲染层自己算尺寸的话，那两条约束就得分叉成两份。
         */
        resizeStart: (point: { x: number; y: number }) => void;
        resizeMove: (point: { x: number; y: number }) => void;
        resizeEnd: () => void;

        setOpen: (open: boolean) => void;
        onLayout: (callback: (payload: { open: boolean; ballSize: number }) => void) => () => void;

        /** 窗口的真实状态。自检用，界面上不用 */
        windowInfo: () => Promise<{
            id: string;
            bounds: { x: number; y: number; width: number; height: number };
            open: boolean;
            /** 展开态的目标尺寸（用户拖出来的那个），与 bounds 不一定相等 */
            panel: { w: number; h: number };
            isAlwaysOnTop: boolean;
            isResizable: boolean;
            isMovable: boolean;
            isVisible: boolean;
            isDestroyed: boolean;
        } | null>;

        /** 调一个桥端点，返回插件给的结果 */
        bridge: <T = unknown>(method: string, params?: unknown) => Promise<{ ok: boolean; result?: T; error?: string }>;
        bridgeStatus: () => Promise<{ connected: boolean }>;
        /** 桥的连接状态变化。返回取消订阅的函数 */
        onBridgeStatus: (callback: (payload: { connected: boolean }) => void) => () => void;
        onEvent: (callback: (payload: { event: string; payload: unknown }) => void) => () => void;

        /*
         * 应用侧下载。**不过桥** —— ffmpeg 与文件系统在应用这一侧。
         * 球同时握着插件与主进程两条路，所以"直链走浏览器、流媒体走应用"
         * 这个分岔在球里判（见下面的 downloadMedia）。
         */
        downloadMedia: (payload: DownloadMediaParams) => Promise<DownloadMediaResult>;
        cancelMediaDownload: (url: string) => Promise<boolean>;
        getDownloadCapabilities: () => Promise<DownloadCapabilities>;
        /** 流媒体下载进度。返回取消订阅的函数 */
        onMediaDownloadProgress: (callback: (progress: MediaDownloadProgress) => void) => () => void;

        /*
         * 推给应用播放器。**单向** —— 球窗口里没有播放器，播放列表长在主窗口。
         * 返回实际送达的条数：主窗口没开时是 0，球据此提示用户而不是假装成功。
         */
        pushToPlayer: (items: PlayMediaItem[]) => Promise<{ sent: number; error?: string }>;
    }

    interface Window {
        orbApi?: OrbApi;
        /** preload 注入的 Electron 桥。球的下载与进度走它，见上面那段 */
        electronAPI?: ElectronAPI;
    }
}

/* ========================================================================== */
/* 桥客户端                                                                    */
/* ========================================================================== */

/**
 * ## 球与插件之间隔着三层
 *
 *     球（渲染层） → preload → 主进程 → host.js → 插件 SW
 *
 * 这一段只关心最上面那一跳：把 `window.orbApi.bridge()` 包成一个会抛错的
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
    | { type: 'new-session' }
    | { type: 'switch-session'; id: string }
    | { type: 'rename-session'; id: string; title: string }
    | { type: 'delete-session'; id: string };

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

/* -------------------------------------------------------------------------- */
/* Agent 的动作                                                                */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* 下载路由                                                                    */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* 推送到应用播放器                                                            */
/* -------------------------------------------------------------------------- */

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
/* 图标                                                                        */
/* ========================================================================== */

/**
 * 内联 path 而不用 `lucide-react`：球窗口是一个常驻的小窗口，图标库会把
 * 它那几百 KB 的模块全带进来，而这里只用得到两个。
 */

interface IconProps {
    className?: string;
}

/** 嗅探：同心弧，与"正在接收信号"同义 */
export const RadarIcon = ({ className }: IconProps) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4.9 19.1a10 10 0 0 1 0-14.2" />
        <path d="M7.8 16.2a6 6 0 0 1 0-8.4" />
        <path d="M10.6 13.4a2 2 0 0 1 0-2.8" />
        <path d="M16.2 7.8a6 6 0 0 1 0 8.4" />
        <path d="M19.1 4.9a10 10 0 0 1 0 14.2" />
    </svg>
);

/** Agent：终端提示符，与"在这里执行代码"同义 */
export const TerminalIcon = ({ className }: IconProps) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 17l6-5-6-5" />
        <path d="M12 19h8" />
    </svg>
);

/* ========================================================================== */
/* 外壳                                                                        */
/* ========================================================================== */

/**
 * 悬浮球的外壳：收起是一颗球，展开是一个面板。
 *
 * ## 尺寸由主进程决定，这里只负责画
 *
 * 窗口的 width/height 是主进程 `setBounds` 改的，渲染层改不了也**不该改** ——
 * 渲染层算出的尺寸和窗口实际尺寸一旦不一致，就会在球形态下露出面板的一角，
 * 或者面板被裁掉一截。所以这里只切"画成球"还是"画成面板"，
 * 尺寸一律 `w-full h-full` 跟着窗口走。
 *
 * 拖动与缩放同理：这里只报**屏幕坐标**，窗口怎么挪、能缩到多小都在主进程里
 * （见 app/main/orbs.js 的第 6、7 节）。
 *
 * ## 拖动与点击必须分开
 *
 * 球的交互有三个：拖、点开、以及拖完松手的那一次 click。第三个别处理的话，
 * 每次拖完都会把面板弹开。所以位移超过阈值就标记为拖动，松手后 50ms 内
 * 忽略 click —— 那个 click 是浏览器补发的，不是用户想展开。
 */

export interface OrbShellProps {
    /** 球心的图标 */
    icon: ReactNode;
    /** 球的渐变（Tailwind 的 from/via/to 组合） */
    accent: string;
    label: string;
    hint: string;
    /** 标题栏右侧的额外控件 */
    toolbar?: ReactNode;
    children: ReactNode;
}

/** 位移小于这个值算点击，不算拖动 */
const DRAG_THRESHOLD_PX = 4;

export const OrbShell = ({ icon, accent, label, hint, toolbar, children }: OrbShellProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const hasMoved = useRef(false);
    const raf = useRef<number | null>(null);
    /* 缩放与拖动各自一套状态，理由见下面 onResizeDown 那段 */
    const [isResizing, setIsResizing] = useState(false);
    const resizeRaf = useRef<number | null>(null);

    /*
     * 主进程改了窗口尺寸 → 切换形态。尺寸本身不在这里设，见文件头。
     *
     * 顺手把两条手势状态清掉：拖到一半按 Esc（收起）时，指针捕获还挂在
     * 那个 header 上，而 header 随形态切换被卸载了 —— pointerup 落到球身上，
     * 而球身上那次 `isDragging` 已经是 false，于是提前 return。
     * 结果是两个标记都留着：
     *   · `isDragging` / `isResizing` 留着 → 下一次 pointermove 被当成"还在拖"；
     *   · `hasMoved` 留着 → 球的 onClick 永远认为"刚拖过"，**点不开了**。
     * 主进程那边也在 setOpen 里清基准，同一个理由。
     */
    useEffect(() => {
        const off = window.orbApi?.onLayout(({ open }) => {
            setIsOpen(open);
            setIsDragging(false);
            setIsResizing(false);
            hasMoved.current = false;
        });
        return off;
    }, []);

    /* ESC 收起。主进程据此把窗口缩回球 */
    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') window.orbApi?.setOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isOpen]);

    const onPointerDown = useCallback((event: React.PointerEvent) => {
        /*
         * 展开态的 header 里有按钮（工具条、收起）。在这些控件上按下是要点击，
         * 不是要拖窗口 —— 一旦 preventDefault + 抓指针，按钮就点不动了。
         */
        if ((event.target as HTMLElement).closest('button, input, textarea, select, a')) return;
        event.preventDefault();
        setIsDragging(true);
        hasMoved.current = false;
        /*
         * 抓在 handler 挂着的那个元素上，不是 `event.target`。
         *
         * header 里的图标、标题都是子元素，抓到子元素上时指针事件只在
         * 那个子元素范围内重定向；虽然能冒泡上来，但只要那个子元素在拖动
         * 过程中被重渲染换掉，捕获就一起没了。
         */
        event.currentTarget.setPointerCapture(event.pointerId);
    }, []);

    const onPointerMove = useCallback((event: React.PointerEvent) => {
        if (!isDragging) return;
        /*
         * 用 screenX/screenY 而不是 clientX/clientY。
         *
         * clientX 是**相对窗口**的，而窗口正在跟着鼠标移动 —— 用它算位移会
         * 形成反馈：窗口挪一点，鼠标相对窗口的位置就变回去，表现为球跟不上手
         * 或者疯狂抖动。screen 坐标是绝对屏幕坐标，不受窗口移动影响。
         */
        const point = { x: event.screenX, y: event.screenY };
        if (!hasMoved.current) {
            hasMoved.current = true;
            window.orbApi?.dragStart(point);
            return;
        }
        /* rAF 合并：pointermove 一帧能来好几次，每次都发 IPC 是纯浪费 */
        if (raf.current !== null) return;
        raf.current = window.requestAnimationFrame(() => {
            raf.current = null;
            window.orbApi?.dragMove(point);
        });
    }, [isDragging]);

    const onPointerUp = useCallback((event: React.PointerEvent) => {
        if (!isDragging) return;
        setIsDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (hasMoved.current) {
            window.orbApi?.dragEnd();
            /*
             * 拖完松手浏览器会补一个 click。不把标记多留一会儿，那次 click
             * 会被当成"点击展开" —— 表现为"一拖就开"。
             */
            window.setTimeout(() => {
                hasMoved.current = false;
            }, 50);
        }
    }, [isDragging]);

    const onClick = useCallback(() => {
        if (isOpen || hasMoved.current) return;
        window.orbApi?.setOpen(true);
    }, [isOpen]);

    /*
     * 缩放把手。
     *
     * 与拖动是**两套独立状态**：拖到一半又去抓把手时，共用一套标记会让两条
     * 路径互相改写对方的基准点，窗口会跳。主进程那边同理（resizeAnchors）。
     *
     * 用 `screenX/screenY` 的理由与拖动相同 —— 窗口正在跟着手改尺寸，
     * clientX 是相对窗口的，会形成反馈。
     *
     * 这里**只报指针位置**，尺寸怎么算全在主进程（增量、下限、贴边平移）。
     * 渲染层自己算的话，那几条约束就得分叉成两份。
     */
    const onResizeDown = useCallback((event: React.PointerEvent) => {
        // 防的是浏览器把这次按下当成选择/原生拖拽的起点（面板本身已 select-none）
        event.preventDefault();
        setIsResizing(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        window.orbApi?.resizeStart({ x: event.screenX, y: event.screenY });
    }, []);

    const onResizeMove = useCallback((event: React.PointerEvent) => {
        if (!isResizing) return;
        const point = { x: event.screenX, y: event.screenY };
        /* rAF 合并：pointermove 一帧能来好几次，每次都发 IPC 是纯浪费 */
        if (resizeRaf.current !== null) return;
        resizeRaf.current = window.requestAnimationFrame(() => {
            resizeRaf.current = null;
            window.orbApi?.resizeMove(point);
        });
    }, [isResizing]);

    const onResizeUp = useCallback((event: React.PointerEvent) => {
        if (!isResizing) return;
        setIsResizing(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        window.orbApi?.resizeEnd();
    }, [isResizing]);

    /*
     * 球的容器是**正方形**，且必须与窗口等大。
     *
     * 窗口本身是透明的，所以"球"其实是这个容器里的一个圆。容器用
     * `rounded-full` + `overflow-hidden`，圆角外的部分才不会画出来。
     */
    if (!isOpen) {
        return (
            <div
                className="animate-orb-unfold h-full w-full cursor-grab select-none active:cursor-grabbing"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onClick={onClick}
                title={`${label} · ${hint}`}
            >
                <div className="relative h-full w-full rounded-full">
                    {/*
                     * 呼吸光晕。
                     *
                     * 用 `.orb-halo`（mask 径向淡出）而不是 `blur-*`：
                     * blur 会向外扩散到窗口之外并被裁成直角，球外面就会
                     * 出现一个方块。见 orb.css 里那段说明。
                     *
                     * 它铺满整个窗口而不是 `inset-*` —— 淡出位置由 mask 控制，
                     * 不需要靠 inset 躲开边界。
                     */}
                    <span
                        className={`orb-halo animate-orb-breath pointer-events-none absolute inset-0 rounded-full bg-gradient-to-br ${accent} opacity-70`}
                    />
                    <span className={`absolute inset-2 rounded-full bg-gradient-to-br ${accent} opacity-95`} />
                    <span className="orb-specular pointer-events-none absolute inset-2 rounded-full" />
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.65)]">
                        {icon}
                    </span>
                </div>
            </div>
        );
    }

    return (
        /*
         * 两层：外层只做定位，内层是面板本体。
         *
         * 必须分开，因为内层带 `rounded-2xl` + `overflow-hidden` —— 那是给
         * 内容用的圆角。缩放把手正好落在右下角那个 16px 圆角上，被它一裁就
         * 只剩一半命中区（圆角切掉的是弓形，占三角形面积的 57%）。
         * 把手是**边框级**的东西，不该被表面裁。
         */
        <div className="animate-orb-unfold relative h-full w-full font-sans text-slate-200 select-none">
            {/*
              面板底色：**不用 `backdrop-blur`**。

              底色本来就写到了 95% 不透明，模糊层剩给用户看的只有那 5% ——
              视觉上几乎为零，代价却是真的：透明窗口的 backdrop-filter 要求
              合成器每帧重新抓取并模糊窗口**背后的桌面内容**，而面板展开时
              一直在动（流式输出、滚动、拖拽）。换成实色之后画面几乎一样，
              每帧省下一次全窗模糊。

              不透明度从 95% 提到 97%：文字压在深底上更实，读数更清楚。
            */}
            <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/12 bg-slate-950/[0.97] shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
                {/*
                 * 只有 header 是拖动区。面板本体挂着滚动列表和输入框，
                 * 整块都可拖的话选不中文字、点不到按钮。
                 */}
                <header
                    className="flex shrink-0 cursor-grab items-center gap-2.5 border-b border-white/10 px-3 py-2.5 active:cursor-grabbing"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                >
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${accent} text-white`}>
                        {icon}
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-white">{label}</span>
                        <span className="block truncate text-[10px] text-slate-400">{hint}</span>
                    </span>
                    {toolbar}
                    <button
                        type="button"
                        onClick={() => window.orbApi?.setOpen(false)}
                        title="收起（Esc）"
                        aria-label="收起"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-slate-400 transition hover:border-white/20 hover:bg-white/[0.12] hover:text-white"
                    >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
                            <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                    </button>
                </header>
                {/*
                 * `select-text` 是**必要的覆盖**，不是冗余。
                 *
                 * 面板根节点带 `select-none`（拖动与点按钮时不该选中文字），
                 * 而那个属性会被子元素继承 —— 于是内容区里的工具返回值、
                 * 脚本、对话正文全都选不中，用户想复制一段报错去查都做不到。
                 * 内容区自己声明可选，选择范围不会越出这里。
                 */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden select-text">{children}</div>
            </div>
            {/*
              右下角的缩放把手。

              形状是**角上的三角形**而不是一个方块：方块会压住面板右下角的内容
              （Agent 的「发送」按钮离右下角只有 8px，方块热区正好盖住它的一角，
              点在那里会变成缩放而不是发送）。三角形只覆盖
              `离右边距离 + 离下边距离 ≤ 16` 的区域，与那个 8×8 的角只有一个点相切。

              `clip-path` 同时裁掉命中区（不只是绘制），所以三角形既是外观也是热区，
              不需要额外写一层判据。

              只画右下角、不画整条边：透明窗口没有窗口边框，整条边的热区会盖住
              列表行尾的按钮（"播放"/"下载"就在那一列）。
            */}
            <div
                onPointerDown={onResizeDown}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeUp}
                onPointerCancel={onResizeUp}
                title="拖动调整面板大小"
                aria-label="调整面板大小"
                className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize text-slate-600 transition hover:text-slate-300 [clip-path:polygon(100%_0,100%_100%,0_100%)]"
            >
                {/* 两条斜线离角 5px 与 10px，都落在三角形内，不会被裁掉半截 */}
                <svg
                    className="pointer-events-none absolute right-0 bottom-0 h-4 w-4"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.4}
                    strokeLinecap="round"
                    aria-hidden="true"
                >
                    <path d="M15 6L6 15M15 11L11 15" />
                </svg>
            </div>
        </div>
    );
};
