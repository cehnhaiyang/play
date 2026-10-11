'use strict';

/**
 * 悬浮球窗口的 preload。
 *
 * 只做三件事：把拖动与展开的 IPC 通道包成函数、报告指针位置、转发主进程的
 * 布局通知。**没有任何业务逻辑** —— 嗅探与 Agent 的请求全部由球自己的渲染层
 * 直接发给扩展的 service worker（球是普通网页，有 `chrome.runtime` 吗？没有 ——
 * 见下）。
 *
 * ## 球怎么跟插件说话
 *
 * 这是个必须讲清楚的点：球是 Electron 的窗口，它**不是** content script，
 * 拿不到 `chrome.runtime`。所以球与插件之间的通道只能是 native messaging，
 * 而 native messaging 的 host 是主进程 —— 于是链路是：
 *
 *     球（渲染层） → preload → 主进程 → native messaging → 插件 SW
 *
 * 也就是说球**必须**经主进程中转。这不是绕远，是唯一可行的路径：
 * 扩展的 `connectNative` 只能从扩展自己的进程发起。
 *
 * 所以 preload 暴露的是 `orb.bridge(method, params)` 这种通用转发口，
 * 而不是逐个端点写一个函数 —— 端点表在 `shared/meta/bridge.ts`，
 * 加端点不该动这个文件。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbApi', {
    /** 是哪个球。主进程按 webContents 反查，这里只是给界面显示用 */
    id: process.argv.find((a) => a.startsWith('--orb-id='))?.slice('--orb-id='.length) || '',

    /* ---- 拖动 ---- */
    dragStart: (point) => ipcRenderer.send('orb:drag-start', point),
    dragMove: (point) => ipcRenderer.send('orb:drag-move', point),
    dragEnd: () => ipcRenderer.send('orb:drag-end'),

    /* ---- 展开 / 收起 ---- */
    setOpen: (open) => ipcRenderer.send('orb:set-open', open),
    /** 主进程改了窗口尺寸后通知渲染层切换形态 */
    onLayout: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('orb:layout', handler);
        return () => ipcRenderer.removeListener('orb:layout', handler);
    },

    /**
     * 窗口的真实状态（置顶、可缩放、位置）。
     *
     * 给自检用：这些是窗口管理器的事实，DOM 与渲染层都看不到。
     */
    windowInfo: () => ipcRenderer.invoke('orb:window-info'),

    /* ---- 过桥 ---- */
    /**
     * 调一个桥端点。
     *
     * `method` 用 `BridgeEndpointName`。主进程转发给插件的 native messaging host，
     * 由插件执行后回结果 —— 对渲染层来说就是一个普通的 async 调用。
     */
    bridge: (method, params) => ipcRenderer.invoke('orb:bridge', method, params),

    /** 桥连上没有。球用它显示"插件未连接"，而不是一直转圈 */
    bridgeStatus: () => ipcRenderer.invoke('orb:bridge-status'),

    /**
     * 桥的连接状态**变化**。
     *
     * 必须订阅而不是只查一次：应用通常比浏览器先起来，所以球打开那一刻
     * 桥多半还没连上。只查一次的话，那个"未连接"会一直挂在界面上 ——
     * 而它下面的列表其实已经在实时更新了，界面自相矛盾。
     */
    onBridgeStatus: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('orb:bridge-status', handler);
        return () => ipcRenderer.removeListener('orb:bridge-status', handler);
    },

    /** 插件推来的事件（嗅探结果、Agent 快照与流式增量） */
    onEvent: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('orb:event', handler);
        return () => ipcRenderer.removeListener('orb:event', handler);
    },

    /* ---- 应用侧下载 ---- */
    /*
     * 这三条**不过桥**：ffmpeg、文件系统、子进程都在应用这一侧，插件做不到
     * （见 shared/meta/bridge.ts 里 `download-media` 那条 split 路由）。
     * 球同时握着两条路，所以"直链走浏览器、流媒体走应用"这个分岔在球里判
     * （见 bridge-client.ts 的 downloadMedia）—— 插件与应用都不需要知道对方。
     */
    downloadMedia: (payload) => ipcRenderer.invoke('download-media', payload),
    cancelMediaDownload: (url) => ipcRenderer.invoke('cancel-media-download', url),
    getDownloadCapabilities: () => ipcRenderer.invoke('get-download-capabilities'),

    /** 流媒体下载进度。ffmpeg 一次可能跑几分钟，没有进度就是一块死界面 */
    onMediaDownloadProgress: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('orb:media-download-progress', handler);
        return () => ipcRenderer.removeListener('orb:media-download-progress', handler);
    },
});
