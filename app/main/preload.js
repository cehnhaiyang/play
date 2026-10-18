
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
    getDownloadCapabilities: () => ipcRenderer.invoke('get-download-capabilities'),
    downloadMedia: (payload) => ipcRenderer.invoke('download-media', payload),
    /** 取消正在进行的媒体下载（kill 子进程/请求，并删掉半成品文件） */
    cancelMediaDownload: (url) => ipcRenderer.invoke('cancel-media-download', url),
    /** 媒体下载实时进度（流媒体走 ffmpeg 的 Duration/out_time，直链走 Content-Length） */
    onMediaDownloadProgress: (callback) => subscribe('media-download-progress', callback),
    /**
     * 悬浮球推来的"加入播放列表"。
     *
     * 嗅探球是独立窗口，没有播放器 —— 它抓到的东西要入列只能经主进程转到这里。
     * 主窗口是唯一持有播放列表的地方，所以这条是单向的：球只发，这里只收。
     */
    onPlayMediaPush: (callback) => subscribe('play-media-push', callback),
    // --- 单文件 .gallery 打包保存（渲染层组包，主进程弹另存为对话框落盘） ---
    galleryPack: {
        savePack: (options) => ipcRenderer.invoke('gallery-save-pack', options),
    },
    /** SPG 源码留档与读取：落点固定在项目根的 .spg 目录 */
    spg: {
        save: (payload) => ipcRenderer.invoke('spg-save', payload),
        pick: () => ipcRenderer.invoke('spg-pick'),
    },
    // --- Tamper API ---
    getCookies: (url) => ipcRenderer.invoke('get-cookies', url),
    setCookie: (details) => ipcRenderer.invoke('set-cookie', details),
    removeCookie: (url, name) => ipcRenderer.invoke('remove-cookie', url, name),
    // --- 画廊（多站点：ACG 漫画 / E-Hentai 等）---
    //
    // 站点差异全在主进程的 galleryRegistry 里，渲染层只传 site 字段。
    // 旧的 acgmho 命名空间保留为"默认站点"的别名（同一次 invoke，不复制逻辑），
    // 老调用方不必跟着改；新代码一律走 gallery。
    gallery: {
        sites: () => ipcRenderer.invoke('gallery-sites'),
        /** all=true 返回"站点 → 频道"两层结构 */
        channels: (options) => ipcRenderer.invoke('gallery-channels', options),
        channelList: (options) => ipcRenderer.invoke('gallery-channel-list', options),
        probe: (options) => ipcRenderer.invoke('gallery-probe', options),
        startDownload: (options) => ipcRenderer.invoke('gallery-start-download', options),
        cancelDownload: (options) => ipcRenderer.invoke('gallery-cancel-download', options),
        openFolder: (folderPath) => ipcRenderer.invoke('gallery-open-folder', folderPath),
        onProgress: (callback) => subscribe('gallery-progress', callback),
        fetchPages: (options) => ipcRenderer.invoke('gallery-fetch-pages', options),
        cancelFetchPages: (options) => ipcRenderer.invoke('gallery-cancel-fetch-pages', options),
        onFetchProgress: (callback) => subscribe('gallery-fetch-progress', callback),
        saveImages: (options) => ipcRenderer.invoke('gallery-save-images', options),
        cancelSaveImages: (options) => ipcRenderer.invoke('gallery-cancel-save-images', options),
        onSaveProgress: (callback) => subscribe('gallery-save-progress', callback),
    },
    // --- 兼容别名：默认站点（acgmho）---
    acgmho: {
        probe: (gidOrUrl) => ipcRenderer.invoke('gallery-probe', { target: gidOrUrl }),
        channels: () => ipcRenderer.invoke('gallery-channels', {}),
        channelList: (options) => ipcRenderer.invoke('gallery-channel-list', options),
        startDownload: (options) => ipcRenderer.invoke('gallery-start-download', options),
        cancelDownload: (gid) => ipcRenderer.invoke('gallery-cancel-download', { gidOrUrl: gid }),
        openFolder: (folderPath) => ipcRenderer.invoke('gallery-open-folder', folderPath),
        onProgress: (callback) => subscribe('gallery-progress', callback),
        fetchPages: (options) => ipcRenderer.invoke('gallery-fetch-pages', options),
        cancelFetchPages: (gid, runId) => ipcRenderer.invoke('gallery-cancel-fetch-pages', { gidOrUrl: gid, runId }),
        onFetchProgress: (callback) => subscribe('gallery-fetch-progress', callback),
        saveImages: (options) => ipcRenderer.invoke('gallery-save-images', options),
        cancelSaveImages: (gid) => ipcRenderer.invoke('gallery-cancel-save-images', { taskKey: gid }),
        onSaveProgress: (callback) => subscribe('gallery-save-progress', callback),
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
    // 都由浏览器插件直接处理，不再经过应用。相关通道见 shared/meta/bridge.ts 的 RETIRED_CHANNELS。
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
