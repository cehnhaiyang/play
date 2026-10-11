/// <reference types="vite/client" />

import type {
    DownloadCapabilities,
    DownloadMediaParams,
    DownloadMediaResult,
    ElectronAPI,
    MediaDownloadProgress,
    PlayMediaItem,
} from '../../../shared/meta';

/**
 * 球窗口暴露的接口。定义在 `app/main/orb-preload.js`。
 *
 * 声明在渲染层而不是共享类型里：这是**窗口自己的**契约，
 * 主窗口的渲染层没有它（`electronAPI` 也没有球那几个方法），
 * 混进 shared/meta 会让"谁能调什么"变得看不出来。
 *
 * 下面必须是 `declare global`：文件顶部的 import 让它变成一个**模块**，
 * 而模块里的 `interface Window` 只是本模块的局部类型 —— 加不上全局的
 * `window.orbApi`，于是每个调用点都报"属性不存在"。
 */
declare global {
    interface OrbApi {
        /** 是哪个球 */
        id: string;

        dragStart: (point: { x: number; y: number }) => void;
        dragMove: (point: { x: number; y: number }) => void;
        dragEnd: () => void;

        setOpen: (open: boolean) => void;
        onLayout: (callback: (payload: { open: boolean; ballSize: number }) => void) => () => void;

        /** 窗口的真实状态。自检用，界面上不用 */
        windowInfo: () => Promise<{
            id: string;
            bounds: { x: number; y: number; width: number; height: number };
            open: boolean;
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
         * 这个分岔在球里判（见 bridge-client.ts 的 downloadMedia）。
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

export {};
