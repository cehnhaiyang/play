
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

contextBridge.exposeInMainWorld('process', {
  env: {
    // 暴露 API Key，优先使用系统环境变量
    API_KEY: process.env.API_KEY || ''
  },
  // 标识当前运行在 Electron 环境
  isElectron: true
});

// 暴露 IPC 通信接口
contextBridge.exposeInMainWorld('electronAPI', {
  // 监听来自主进程的导航请求（新标签页链接）
  onNavigateToUrl: (callback) => subscribe('navigate-to-url', callback),
  // 移除监听器
  removeNavigateListener: () => {
    ipcRenderer.removeAllListeners('navigate-to-url');
  },
  // 监听网络嗅探结果
  onSniffedMedia: (callback) => subscribe('sniffed-media', callback),
  getDownloadCapabilities: () => ipcRenderer.invoke('get-download-capabilities'),
  downloadMedia: (payload) => ipcRenderer.invoke('download-media', payload),
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
  // --- Sukebei / Nyaa 资源搜索与种子 API ---
  sukebei: {
    search: (options) => ipcRenderer.invoke('sukebei-search', options),
    getTorrent: (options) => ipcRenderer.invoke('sukebei-get-torrent', options),
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
