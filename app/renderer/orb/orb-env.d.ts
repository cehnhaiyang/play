/// <reference types="vite/client" />

/**
 * 球窗口暴露的接口。定义在 `app/main/orb-preload.js`。
 *
 * 声明在渲染层而不是共享类型里：这是**窗口自己的**契约，
 * 主窗口的渲染层没有它（`electronAPI` 也没有球那几个方法），
 * 混进 shared/meta 会让"谁能调什么"变得看不出来。
 */

interface OrbApi {
    /** 是哪个球 */
    id: string;

    dragStart: (point: { x: number; y: number }) => void;
    dragMove: (point: { x: number; y: number }) => void;
    dragEnd: () => void;

    setOpen: (open: boolean) => void;
    onLayout: (callback: (payload: { open: boolean; ballSize: number }) => void) => () => void;

    /** 调一个桥端点，返回插件给的结果 */
    bridge: <T = unknown>(method: string, params?: unknown) => Promise<{ ok: boolean; result?: T; error?: string }>;
    bridgeStatus: () => Promise<{ connected: boolean }>;
    /** 桥的连接状态变化。返回取消订阅的函数 */
    onBridgeStatus: (callback: (payload: { connected: boolean }) => void) => () => void;
    onEvent: (callback: (payload: { event: string; payload: unknown }) => void) => () => void;
}

interface Window {
    orbApi?: OrbApi;
}
