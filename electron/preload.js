
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload Script
 * 运行在渲染进程加载之前，拥有 Node.js 权限。
 * 用于将主进程的数据安全地桥接到渲染进程的 window 对象上。
 */

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
  onNavigateToUrl: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on('navigate-to-url', handler);
    // 返回清理函数
    return () => ipcRenderer.removeListener('navigate-to-url', handler);
  },
  // 移除监听器
  removeNavigateListener: () => {
    ipcRenderer.removeAllListeners('navigate-to-url');
  },
  // 监听网络嗅探结果
  onSniffedMedia: (callback) => {
    const handler = (_event, mediaInfo) => callback(mediaInfo);
    ipcRenderer.on('sniffed-media', handler);
    return () => ipcRenderer.removeListener('sniffed-media', handler);
  },
  getDownloadCapabilities: () => ipcRenderer.invoke('get-download-capabilities'),
  downloadMedia: (payload) => ipcRenderer.invoke('download-media', payload),
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
    onProgress: (callback) => {
      const handler = (_event, progress) => callback(progress);
      ipcRenderer.on('acgmho-progress', handler);
      return () => ipcRenderer.removeListener('acgmho-progress', handler);
    },
    fetchPages: (options) => ipcRenderer.invoke('acgmho-fetch-pages', options),
    cancelFetchPages: (gid, runId) => ipcRenderer.invoke('acgmho-cancel-fetch-pages', gid, runId),
    onFetchProgress: (callback) => {
      const handler = (_event, progress) => callback(progress);
      ipcRenderer.on('acgmho-fetch-progress', handler);
      return () => ipcRenderer.removeListener('acgmho-fetch-progress', handler);
    },
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
    onProgress: (callback) => {
      const handler = (_event, progress) => callback(progress);
      ipcRenderer.on('torrent-progress', handler);
      return () => ipcRenderer.removeListener('torrent-progress', handler);
    },
  },
});

console.log('Electron preload script loaded.');
