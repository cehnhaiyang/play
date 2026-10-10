
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload Script
 * 运行在渲染进程加载之前，拥有 Node.js 权限。
 * 用于将主进程的数据安全地桥接到渲染进程的 window 对象上。
 */

/**
 * 事件订阅构造器：ipcRenderer.on + 返回清理函数，六处 onX 共用一套写法。
 * @param {string} channel 监听的 IPC 通道名
 * @param {(payload: any) => void} callback 渲染层回调（只收 payload，不暴露 event）
 */
const subscribe = (channel, callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
};

// 暴露 IPC 通信接口
contextBridge.exposeInMainWorld('electronAPI', {
    // 监听网络嗅探结果
    onSniffedMedia: (callback) => subscribe('sniffed-media', callback),
    /** 打开/关闭主进程网络层嗅探推送（默认关闭，由"持续嗅探"开关控制） */
    setSnifferEnabled: (enabled) => ipcRenderer.invoke('sniffer-set-enabled', enabled),
    getDownloadCapabilities: () => ipcRenderer.invoke('get-download-capabilities'),
    downloadMedia: (payload) => ipcRenderer.invoke('download-media', payload),
    /** 取消正在进行的媒体下载（kill 子进程/请求，并删掉半成品文件） */
    cancelMediaDownload: (url) => ipcRenderer.invoke('cancel-media-download', url),
    /** 媒体下载实时进度（流媒体走 ffmpeg 的 Duration/out_time，直链走 Content-Length） */
    onMediaDownloadProgress: (callback) => subscribe('media-download-progress', callback),
    // --- 单文件 .gallery 打包保存（渲染层组包，主进程弹另存为对话框落盘） ---
    galleryPack: {
        savePack: (options) => ipcRenderer.invoke('gallery-save-pack', options),
    },
    /** 把 LLM 生成的 SPG 源码直接留档到项目根的 .spg 目录（无对话框、无确认） */
    spg: {
        save: (payload) => ipcRenderer.invoke('spg-save', payload),
    },
    // --- Tamper API ---
    getCookies: (url) => ipcRenderer.invoke('get-cookies', url),
    setCookie: (details) => ipcRenderer.invoke('set-cookie', details),
    removeCookie: (url, name) => ipcRenderer.invoke('remove-cookie', url, name),
    // --- ACGMHO 图集下载与在线浏览 API ---
    acgmho: {
        probe: (gidOrUrl) => ipcRenderer.invoke('acgmho-probe', gidOrUrl),
        channels: () => ipcRenderer.invoke('acgmho-channels'),
        channelList: (options) => ipcRenderer.invoke('acgmho-channel-list', options),
        startDownload: (options) => ipcRenderer.invoke('acgmho-start-download', options),
        cancelDownload: (gid) => ipcRenderer.invoke('acgmho-cancel-download', gid),
        openFolder: (folderPath) => ipcRenderer.invoke('acgmho-open-folder', folderPath),
        onProgress: (callback) => subscribe('acgmho-progress', callback),
        fetchPages: (options) => ipcRenderer.invoke('acgmho-fetch-pages', options),
        cancelFetchPages: (gid, runId) => ipcRenderer.invoke('acgmho-cancel-fetch-pages', gid, runId),
        onFetchProgress: (callback) => subscribe('acgmho-fetch-progress', callback),
        // 边下边播落盘：按直链保存，单页落盘即推 file-done 事件
        saveImages: (options) => ipcRenderer.invoke('acgmho-save-images', options),
        cancelSaveImages: (gid) => ipcRenderer.invoke('acgmho-cancel-save-images', gid),
        onSaveProgress: (callback) => subscribe('acgmho-save-progress', callback),
    },
    // --- 应用设置（代理端口、AI 服务配置等，主进程持久化） ---
    settings: {
        get: () => ipcRenderer.invoke('settings-get'),
        setProxyPort: (value) => ipcRenderer.invoke('settings-set-proxy-port', value),
        setAiConfig: (value) => ipcRenderer.invoke('settings-set-ai-config', value),
        testAiConfig: (value, reasoningEffort) => ipcRenderer.invoke('settings-test-ai-config', value, reasoningEffort),
    },
    // --- 浏览器外壳能力已整体移除 ---
    // 快捷键 / 右键菜单 / 网页下载 / 发声状态原先由主进程判出动作再发给渲染层执行
    // （webview 是跨进程 OOPIF，键盘与右键不冒泡到宿主页面）。
    // 自建外壳拆除后这些没有宿主了：浏览器里的下载、快捷键、右键菜单
    // 都由浏览器插件直接处理，不再经过应用。相关通道见 meta/bridge.ts 的 RETIRED_CHANNELS。
    // --- 种子文件获取（只有落盘需要主进程：文件系统权限） ---
    // 搜索不经过这里：搜索引擎完整地待在 services/SearchService，
    // 用渲染层 fetch 直接请求各站点，代理配在 Chromium 会话上、自动生效。
    torrentFile: {
        fetchFile: (options) => ipcRenderer.invoke('torrent-fetch-file', options),
    },
    // --- 内置 BT 下载引擎 API（磁力直下，无需外部工具） ---
    torrent: {
        start: (options) => ipcRenderer.invoke('torrent-start', options),
        cancel: (taskId, deleteFiles) => ipcRenderer.invoke('torrent-cancel', taskId, deleteFiles),
        pause: (taskId) => ipcRenderer.invoke('torrent-pause', taskId),
        resume: (taskId) => ipcRenderer.invoke('torrent-resume', taskId),
        tasks: () => ipcRenderer.invoke('torrent-tasks'),
        openFolder: (target) => ipcRenderer.invoke('torrent-open-folder', target),
        onProgress: (callback) => subscribe('torrent-progress', callback),
    },
});

console.log('Electron preload script loaded.');
