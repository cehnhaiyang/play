
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
    // 监听来自主进程的导航请求（新标签页链接），返回取消订阅函数
    onNavigateToUrl: (callback) => subscribe('navigate-to-url', callback),
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
    // --- 浏览器外壳能力（快捷键 / 右键菜单 / 网页下载 / 发声状态） ---
    // 键盘与右键事件只有主进程收得到（webview 是跨进程 OOPIF，不冒泡到宿主
    // 页面的 window），所以方向是**主进程 → 渲染层**：主进程判出是哪个浏览器
    // 动作，发过来由渲染层执行。见 electron/browserService.js 顶部注释。
    browser: {
        /** 浏览器动作命令（新建标签、查找、缩放…）。返回取消订阅函数 */
        onCommand: (callback) => subscribe('browser-command', callback),
        /** 网页自身触发的下载：进度 / 完成 / 中断。返回取消订阅函数 */
        onDownload: (callback) => subscribe('browser-download', callback),
        /** 取当前全部下载记录（面板首次打开时补齐历史） */
        downloads: () => ipcRenderer.invoke('browser-downloads'),
        /** 暂停 / 继续 / 取消 / 在文件夹中显示 / 打开 / 从列表移除 */
        downloadAction: (id, action) => ipcRenderer.invoke('browser-download-action', { id, action }),
    },
    // --- 知识库（open-reverselab 的 Markdown 文章） ---
    // 主进程只负责把文件读出来；解析、检索、切片全在渲染层的 services/KbService，
    // 所以这里是纯粹的字节搬运，没有任何业务判断。
    kb: {
        /** 整库一次读完（约 3MB）。渲染层长期驻留，之后检索不再往返 IPC */
        load: () => ipcRenderer.invoke('kb-load'),
        /** 读单篇正文。路径是 kb 根下的相对路径，形如 ctf-website/techniques/xx/yy.md */
        read: (path) => ipcRenderer.invoke('kb-read', path),
        /** 轻量状态：根目录 / 篇数 / 是否就绪 */
        status: () => ipcRenderer.invoke('kb-status'),
        /** 保存 kb 根目录，返回里带新的 status，界面不用再问一次 */
        setRoot: (value) => ipcRenderer.invoke('kb-set-root', value),
    },
    // --- Edge 数据导入（收藏夹 / 历史 / 图标 / 自动填充 / Cookie） ---
    // 两步：detect 只读文件大小与条目数（快、不会被锁影响），import 才开 SQLite
    // 与解密。Cookie 走纯离线解密（APPB → SYSTEM DPAPI → 主密钥，不启动 Edge），
    // 详见 electron/edgeImportService.js 顶部注释。
    edge: {
        /** 探测本机 Edge 与各 profile 的数据量 */
        detect: () => ipcRenderer.invoke('edge-detect'),
        /** 执行导入。options.include 逐项开关；返回逐项结果与 warnings */
        run: (options) => ipcRenderer.invoke('edge-import', options),
        /** 导入过程中的阶段提示（"正在读取收藏夹…"）。返回取消订阅函数 */
        onProgress: (callback) => subscribe('edge-import-progress', callback),
    },
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
