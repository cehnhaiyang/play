const { app, BrowserWindow, ipcMain, shell, webContents } = require('electron');
const { probeGallery, downloadGallery, fetchGalleryPages, normalizeGid, GALLERY_CHANNELS, fetchChannelList } = require('./acgmhoService');
const { searchSukebei, downloadTorrentFile, extractId } = require('./sukebeiService');
const {
  startTorrent,
  cancelTorrent,
  pauseTorrent,
  resumeTorrent,
  getTorrentTasks,
  destroyTorrentClient,
} = require('./torrentService');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { createWriteStream } = require('fs');
const ffmpegStatic = require('ffmpeg-static');

if (!app.isPackaged) {
  // 开发阶段浏览器能力依赖 webview 与抓包能力，先关闭 Electron 控制台安全告警，
  // 避免无效噪音淹没真实运行时错误。
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

let mainWindow = null;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const STREAM_EXTENSIONS = new Set(['m3u8', 'm3u', 'mpd']);
const MEDIA_HTTP_HEADERS = {
  'User-Agent': USER_AGENT,
  Referer: '',
};

function resolveFfmpegPath() {
  if (!ffmpegStatic) {
    return null;
  }

  if (!app.isPackaged) {
    return ffmpegStatic;
  }

  const unpackedPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
  return fs.existsSync(unpackedPath) ? unpackedPath : ffmpegStatic;
}

function getDownloadCapabilities() {
  const ffmpegPath = resolveFfmpegPath();
  const ffmpegAvailable = Boolean(ffmpegPath && fs.existsSync(ffmpegPath));

  return {
    ffmpegAvailable,
    ffmpegMessage: ffmpegAvailable
      ? '项目内 ffmpeg 已就绪，可直接下载流媒体资源。'
      : '项目内 ffmpeg 不可用，当前无法下载流媒体资源。',
  };
}

function sanitizeFileName(name) {
  const fallbackName = 'media';
  const cleanName = String(name || fallbackName)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  return cleanName || fallbackName;
}

function inferExtension(url, ext) {
  if (ext) {
    return String(ext).toLowerCase().replace(/^\./, '');
  }

  try {
    const pathname = new URL(url).pathname;
    const matched = pathname.match(/\.([a-zA-Z0-9]+)$/);
    return matched ? matched[1].toLowerCase() : 'mp4';
  } catch (_error) {
    return 'mp4';
  }
}

function resolveDownloadTarget(title, ext) {
  const downloadsDir = app.getPath('downloads');
  const baseName = sanitizeFileName(title);
  const normalizedExt = inferExtension('', ext);
  let fileName = baseName;

  if (!fileName.toLowerCase().endsWith(`.${normalizedExt}`)) {
    fileName = `${fileName}.${normalizedExt}`;
  }

  let targetPath = path.join(downloadsDir, fileName);
  let counter = 1;

  while (fs.existsSync(targetPath)) {
    const parsed = path.parse(fileName);
    targetPath = path.join(downloadsDir, `${parsed.name}-${counter}${parsed.ext}`);
    counter += 1;
  }

  return targetPath;
}

function buildRequestHeaders(url, customReferer) {
  const headers = { ...MEDIA_HTTP_HEADERS };
  if (customReferer) {
    headers.Referer = customReferer;
  } else {
    try {
      headers.Referer = `${new URL(url).origin}/`;
    } catch (_error) {
      headers.Referer = '';
    }
  }
  return headers;
}

async function downloadDirectFile(url, filePath, customReferer, maxRedirects = 5) {
  if (maxRedirects <= 0) {
    throw new Error('下载失败：重定向次数过多。');
  }

  const transport = url.startsWith('https:') ? https : http;
  const headers = buildRequestHeaders(url, customReferer);

  return new Promise((resolve, reject) => {
    const request = transport.get(url, { headers }, async (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        try {
          const redirectUrl = new URL(res.headers.location, url).toString();
          await downloadDirectFile(redirectUrl, filePath, customReferer, maxRedirects - 1);
          resolve();
        } catch (redirectError) {
          reject(redirectError);
        }
        return;
      }

      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error(`下载失败，HTTP 状态码 ${res.statusCode || '未知'}`));
        return;
      }

      try {
        await pipeline(res, createWriteStream(filePath));
        resolve();
      } catch (pipeError) {
        reject(pipeError);
      }
    });

    request.on('error', reject);
    // 无超时保护时，僵尸连接会让下载永远挂起；30s 无响应直接失败
    request.setTimeout(30000, () => {
      request.destroy(new Error('下载超时：30s 内服务器无响应。'));
    });
  });
}

async function downloadWithFfmpeg(url, filePath, customReferer) {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error('未找到项目内 ffmpeg，请重新安装依赖后再试。');
  }

  return new Promise((resolve, reject) => {
    const headers = buildRequestHeaders(url, customReferer);
    const headerArgs = [];

    if (headers['User-Agent']) {
      headerArgs.push('-user_agent', headers['User-Agent']);
    }

    if (headers.Referer) {
      headerArgs.push('-headers', `Referer: ${headers.Referer}\r\n`);
    }

    const ffmpegArgs = [
      '-y',
      ...headerArgs,
      '-i',
      url,
      '-c',
      'copy',
      filePath,
    ];

    const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', (error) => {
      if (error && error.code === 'ENOENT') {
        reject(new Error('项目内 ffmpeg 不存在或不可执行，请重新安装依赖。'));
        return;
      }

      reject(new Error(`无法启动 ffmpeg：${error.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const reason = stderr.trim().split('\n').slice(-3).join(' ');
      reject(new Error(reason || `ffmpeg 执行失败，退出码 ${code}`));
    });
  });
}

async function handleMediaDownload(_event, payload) {
  const url = payload?.url;
  const ext = inferExtension(url, payload?.ext);
  const title = payload?.title || 'media';
  const referer = payload?.referer || '';

  if (!url) {
    return { success: false, message: '下载失败：缺少资源地址。' };
  }

  const targetPath = resolveDownloadTarget(title, STREAM_EXTENSIONS.has(ext) ? 'mp4' : ext);

  try {
    if (STREAM_EXTENSIONS.has(ext)) {
      await downloadWithFfmpeg(url, targetPath, referer);
      return {
        success: true,
        message: `已通过 ffmpeg 下载到 ${targetPath}`,
        filePath: targetPath,
      };
    }

    await downloadDirectFile(url, targetPath, referer);
    return {
      success: true,
      message: `下载完成：${targetPath}`,
      filePath: targetPath,
    };
  } catch (error) {
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }

    return {
      success: false,
      message: error instanceof Error ? error.message : '下载失败',
    };
  }
}


const activeGalleryTasks = new Set();
// gid -> runId：同画廊同时只跑一轮解析，新 run 顶掉旧 run，保证推送顺序不交错
const activeFetchRuns = new Map();

function setupGalleryHandlers() {
  ipcMain.handle('acgmho-probe', async (_event, gidOrUrl) => {
    try {
      return await probeGallery(gidOrUrl);
    } catch (error) {
      console.error('acgmho-probe failed:', error);
      throw new Error(error.message || '探测失败');
    }
  });

  // 内置浏览画廊：频道表（静态）与频道列表（分页抓取）
  ipcMain.handle('acgmho-channels', async () => GALLERY_CHANNELS);

  ipcMain.handle('acgmho-channel-list', async (_event, options) => {
    try {
      return { success: true, ...(await fetchChannelList(options || {})) };
    } catch (error) {
      console.error('acgmho-channel-list failed:', error);
      return { success: false, message: error.message || '列表加载失败', items: [], hasMore: false };
    }
  });

  ipcMain.handle('acgmho-start-download', async (_event, options) => {
    const gid = options.gidOrUrl;
    activeGalleryTasks.add(String(gid));
    try {
      const downloadOptions = {
        ...options,
        outDir: options.outDir || path.join(app.getPath('downloads'), 'acgmho', String(gid)),
      };
      const result = await downloadGallery(
        downloadOptions,
        (progress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('acgmho-progress', progress);
          }
        },
        (id) => !activeGalleryTasks.has(String(id))
      );
      activeGalleryTasks.delete(String(gid));
      return result;
    } catch (error) {
      activeGalleryTasks.delete(String(gid));
      console.error('acgmho-start-download failed:', error);
      throw error;
    }
  });

  ipcMain.handle('acgmho-cancel-download', async (_event, gid) => {
    activeGalleryTasks.delete(String(gid));
    return { success: true };
  });

  ipcMain.handle('acgmho-open-folder', async (_event, folderPath) => {
    if (folderPath && fs.existsSync(folderPath)) {
      await shell.openPath(folderPath);
      return { success: true };
    }
    return { success: false, message: '目录不存在' };
  });

  ipcMain.handle('acgmho-fetch-pages', async (_event, options) => {
    const opts = options || {};
    // 键必须归一化为数字 gid：调用方传 URL 或纯 ID 两种形态，
    // 旧实现拿原文当键，传 URL 开跑的任务用 gid 永远取消不掉
    const key = normalizeGid(opts.gidOrUrl).gid || String(opts.gidOrUrl);
    // 单飞：同 gid 开新 run 直接顶掉旧 run（旧循环在下一页边界停，
    // 且它的进度带旧 runId，渲染层会丢弃，不会再污染播放列表顺序）
    const runId = opts.runId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeFetchRuns.set(key, runId);
    try {
      const result = await fetchGalleryPages(
        opts,
        (progress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('acgmho-fetch-progress', { ...progress, runId });
          }
        },
        (id) => activeFetchRuns.get(String(id)) !== runId
      );
      return { ...result, runId };
    } catch (error) {
      console.error('acgmho-fetch-pages failed:', error);
      throw error;
    } finally {
      // 只清自己的 key：别把后启动的新 run 误删了
      if (activeFetchRuns.get(key) === runId) activeFetchRuns.delete(key);
    }
  });

  ipcMain.handle('acgmho-cancel-fetch-pages', async (_event, gid, runId) => {
    const opts = typeof gid === 'object' && gid ? gid : { gidOrUrl: gid, runId };
    const key = normalizeGid(opts.gidOrUrl).gid || String(opts.gidOrUrl);
    // 带 runId 只杀匹配的 run，不带则全杀（兼容旧调用）
    if (!opts.runId || activeFetchRuns.get(key) === opts.runId) {
      activeFetchRuns.delete(key);
    }
    return { success: true };
  });
}

function setupDownloadHandlers() {
  ipcMain.handle('get-download-capabilities', async () => getDownloadCapabilities());
  ipcMain.handle('download-media', handleMediaDownload);
}

function setupSukebeiHandlers() {
  ipcMain.handle('sukebei-search', async (_event, options) => {
    try {
      return { success: true, items: await searchSukebei(options || {}) };
    } catch (error) {
      console.error('sukebei-search failed:', error);
      return { success: false, message: error.message || '搜索失败', items: [] };
    }
  });

  // 只拿 .torrent 种子文件（不下正片），存到下载目录
  ipcMain.handle('sukebei-get-torrent', async (_event, options) => {
    try {
      const opts = options || {};
      const outDir = opts.outDir || path.join(app.getPath('downloads'), 'the-play', 'torrents');
      const result = await downloadTorrentFile({ ...opts, outDir });
      return { success: true, ...result };
    } catch (error) {
      console.error('sukebei-get-torrent failed:', error);
      return { success: false, message: error.message || '种子下载失败' };
    }
  });

  // 内置引擎直接下正片：magnet / torrentPath / torrentUrl 均可。
  // 有 .torrent 直链时优先预取种子文件（KB 级，一次 HTTP 即得元数据，
  // 比纯 magnet 走 DHT 找元数据快一个数量级）；预取失败再回退 magnet。
  ipcMain.handle('torrent-start', async (_event, options) => {
    try {
      const opts = options || {};
      if (opts.torrentUrl && !opts.torrentPath) {
        try {
          const saved = await downloadTorrentFile({
            site: opts.site || 'sukebei',
            id: extractId(opts.torrentUrl),
            torrentUrl: opts.torrentUrl,
            title: opts.name || '',
            outDir: path.join(app.getPath('downloads'), 'the-play', 'torrents'),
          });
          opts.torrentPath = saved.path;
        } catch (prefetchError) {
          if (!opts.magnet) throw prefetchError;
          console.warn('torrent .torrent prefetch failed, fallback to magnet:', prefetchError.message);
        }
      }
      const outDir = opts.outDir || path.join(app.getPath('downloads'), 'the-play', 'bt');
      const result = await startTorrent(
        { ...opts, outDir },
        (progress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('torrent-progress', progress);
          }
        }
      );
      return { success: true, ...result };
    } catch (error) {
      console.error('torrent-start failed:', error);
      return { success: false, message: error.message || '任务启动失败' };
    }
  });

  ipcMain.handle('torrent-cancel', async (_event, taskId, deleteFiles) => {
    return cancelTorrent(taskId, deleteFiles !== false);
  });

  ipcMain.handle('torrent-pause', async (_event, taskId) => pauseTorrent(taskId));
  ipcMain.handle('torrent-resume', async (_event, taskId) => resumeTorrent(taskId));
  ipcMain.handle('torrent-tasks', async () => getTorrentTasks());

  ipcMain.handle('torrent-open-folder', async (_event, target) => {
    let dir = target || '';
    if (!dir || !fs.existsSync(dir)) {
      // 可能是 taskId，尝试从任务列表解析
      const found = getTorrentTasks().find((t) => t.id === target);
      dir = found ? found.outDir : dir;
    }
    if (dir && fs.existsSync(dir)) {
      await shell.openPath(dir);
      return { success: true };
    }
    return { success: false, message: '目录不存在' };
  });
}

function setupTamperHandlers(sess) {
  ipcMain.handle('get-cookies', async (_event, url) => {
    try {
      return await sess.cookies.get({ url });
    } catch (error) {
      console.error('Failed to get cookies', error);
      return [];
    }
  });

  ipcMain.handle('set-cookie', async (_event, details) => {
    try {
      await sess.cookies.set(details);
      return { success: true };
    } catch (error) {
      console.error('Failed to set cookie', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('remove-cookie', async (_event, url, name) => {
    try {
      await sess.cookies.remove(url, name);
      return { success: true };
    } catch (error) {
      console.error('Failed to remove cookie', error);
      return { success: false, error: error.message };
    }
  });
}

const sniffedSessions = new WeakSet();
const recentSniffedUrls = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [url, time] of recentSniffedUrls.entries()) {
    if (now - time > 15000) {
      recentSniffedUrls.delete(url);
    }
  }
}, 30000);

function setupSniffer(sess) {
  if (!sess || sniffedSessions.has(sess)) {
    return;
  }
  sniffedSessions.add(sess);

  const filter = { urls: ['<all_urls>'] };

  // ACG 专属资源不进嗅探：图集封面/动画/有声走画廊流程，
  // 否则翻一本漫画就刷几十条封面进嗅探列表。与渲染层 utils.isAcgUrl 保持同口径
  const ACG_SNIFF_EXCLUDE_SUFFIXES = ['acgmho.com', 'acgnngca.com', 'acgnfl.com', 'acg-hentai.com'];
  const isAcgExcluded = (u) => {
    if (!u || typeof u !== 'string') return false;
    try {
      const host = new URL(u).hostname.toLowerCase();
      return ACG_SNIFF_EXCLUDE_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
    } catch (_e) {
      return false;
    }
  };

  const streamExts = ['m3u8', 'm3u', 'mpd', 'flv', 'f4v'];
  const videoExts = ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'ogv', '3gp', 'mpg', 'mpeg', 'm4s', 'ts'];
  const audioExts = ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'opus', 'wma'];
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'avif'];

  sess.webRequest.onResponseStarted(filter, (details) => {
    const { url, responseHeaders, method, statusCode } = details;
    if (!url || (statusCode !== 200 && statusCode !== 206) || method === 'OPTIONS' || method === 'HEAD') {
      return;
    }

    // ACG 资源直接丢弃：资源直链在 ACG 域名，或请求挂在 ACG 页面下（referrer）
    if (isAcgExcluded(url) || isAcgExcluded(details.referrer)) {
      return;
    }

    if (
      url.startsWith('chrome-extension:') ||
      url.startsWith('devtools:') ||
      url.startsWith('blob:') ||
      url.startsWith('data:')
    ) {
      return;
    }

    const getHeader = (headers, name) => {
      if (!headers) return '';
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
      if (!key) return '';
      const val = headers[key];
      return Array.isArray(val) ? val[0] : String(val);
    };

    const contentType = getHeader(responseHeaders, 'content-type').toLowerCase();

    // 快速过滤不需要的普通网页文本文件
    if (
      contentType.includes('text/html') ||
      contentType.includes('text/css') ||
      contentType.includes('javascript') ||
      contentType.includes('application/json')
    ) {
      return;
    }

    let detectedType = null;
    let ext = '';

    // 1. 基于 Content-Type 判定
    if (
      contentType.includes('mpegurl') ||
      contentType.includes('dash+xml') ||
      contentType.includes('vnd.ms-sstr') ||
      contentType.includes('application/x-mpegurl')
    ) {
      detectedType = 'stream';
      ext = contentType.includes('dash') ? 'mpd' : 'm3u8';
    } else if (contentType.startsWith('video/')) {
      if (contentType.includes('x-flv')) {
        detectedType = 'stream';
        ext = 'flv';
      } else {
        detectedType = 'video';
        ext = contentType.split('/')[1]?.split(';')[0]?.replace('x-', '') || 'mp4';
      }
    } else if (contentType.startsWith('audio/')) {
      detectedType = 'audio';
      ext = contentType.split('/')[1]?.split(';')[0]?.replace('x-', '') || 'mp3';
    } else if (contentType.startsWith('image/')) {
      let imgExt = contentType.split('/')[1]?.split(';')[0];
      if (imgExt === 'svg+xml') {
        imgExt = 'svg';
      }
      if (imageExts.includes(imgExt)) {
        detectedType = 'image';
        ext = imgExt;
      }
    }

    // 2. 基于 URL 路径拓展名判定
    let urlObj = null;
    let pathname = '';
    try {
      urlObj = new URL(url);
      pathname = urlObj.pathname.toLowerCase();
    } catch (_e) {
      pathname = url.split('?')[0].split('#')[0].toLowerCase();
    }

    const pathMatch = pathname.match(/\.([a-zA-Z0-9]+)$/);
    const pathExt = pathMatch ? pathMatch[1] : '';

    if (!detectedType) {
      if (streamExts.includes(pathExt)) {
        detectedType = 'stream';
        ext = pathExt;
      } else if (videoExts.includes(pathExt)) {
        detectedType = 'video';
        ext = pathExt;
      } else if (audioExts.includes(pathExt)) {
        detectedType = 'audio';
        ext = pathExt;
      } else if (imageExts.includes(pathExt)) {
        detectedType = 'image';
        ext = pathExt;
      }
    }

    // 3. 基于 Query 参数中嵌套媒体拓展名探测
    if (!detectedType && urlObj) {
      for (const [, val] of urlObj.searchParams.entries()) {
        const lowerVal = val.toLowerCase();
        if (streamExts.some((s) => lowerVal.includes(`.${s}`))) {
          detectedType = 'stream';
          ext = 'm3u8';
          break;
        } else if (videoExts.some((v) => lowerVal.includes(`.${v}`))) {
          detectedType = 'video';
          ext = 'mp4';
          break;
        } else if (audioExts.some((a) => lowerVal.includes(`.${a}`))) {
          detectedType = 'audio';
          ext = 'mp3';
          break;
        }
      }
    }

    // 过滤 TS 切片分段
    if (ext === 'ts') {
      const isSegment =
        /\b(seg|chunk|slice|frag|part|track|\d{2,})\b/i.test(pathname) ||
        /[-_]\d+\.ts/i.test(pathname) ||
        pathname.includes('/ts/') ||
        contentType.includes('mp2t');
      if (isSegment && !url.includes('playlist')) {
        return;
      }
    }

    if (!detectedType || !mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    // 去重检查 (5 秒内相同 URL 不重复推送)
    const now = Date.now();
    const lastSeen = recentSniffedUrls.get(url);
    if (lastSeen && now - lastSeen < 5000) {
      return;
    }
    recentSniffedUrls.set(url, now);

    // 提取文件名与安全标题
    let filename = '';
    const dispositionHeader = getHeader(responseHeaders, 'content-disposition');
    if (dispositionHeader) {
      const match = dispositionHeader.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      if (match && match[1]) {
        filename = match[1];
      }
    }

    if (!filename && urlObj) {
      const parts = urlObj.pathname.split('/').filter(Boolean);
      filename = parts.pop() || '';
    }

    if (!filename || filename.length > 80) {
      filename = `Media_${ext || 'stream'}`;
    }

    let safeTitle = filename;
    try {
      safeTitle = decodeURIComponent(filename);
    } catch (_err) {
      safeTitle = filename;
    }

    let senderUrl = '';
    if (details.webContentsId) {
      try {
        const sender = webContents.fromId(details.webContentsId);
        if (sender && !sender.isDestroyed()) {
          senderUrl = sender.getURL() || '';
        }
      } catch (_e) { }
    }

    const referer = details.referrer || senderUrl || '';
    const pageUrl = senderUrl || details.referrer || '';

    // 二次兜底：宿主页面在 ACG 站（senderUrl）但 referrer 为空时，早期拦截拦不住，
    // 这里按最终 pageUrl/referer 再拦一次，与渲染层 addLinks 同口径
    if (isAcgExcluded(referer) || isAcgExcluded(pageUrl)) {
      return;
    }

    try {
      mainWindow.webContents.send('sniffed-media', {
        url,
        title: safeTitle,
        type: detectedType,
        ext: ext || 'unknown',
        source: 'network',
        referer,
        pageUrl,
      });
    } catch (_e) { }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'React Advanced Player',
    backgroundColor: '#020617',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      allowRunningInsecureContent: false,
      webSecurity: false,
      webviewTag: true,
    },
  });

  const isDev = !app.isPackaged;
  const devUrl = 'http://localhost:5173';
  const prodPath = path.join(__dirname, '../dist/index.html');

  if (isDev) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(prodPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    mainWindow.webContents.send('navigate-to-url', url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
    if (webContents.session) {
      setupSniffer(webContents.session);
    }
    webContents.setWindowOpenHandler(({ url }) => {
      mainWindow.webContents.send('navigate-to-url', url);
      return { action: 'deny' };
    });
  });

  const filter = { urls: ['*://*/*'] };
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    requestHeaders['User-Agent'] = USER_AGENT;
    delete requestHeaders['sec-ch-ua'];
    delete requestHeaders['sec-ch-ua-mobile'];
    delete requestHeaders['sec-ch-ua-platform'];

    try {
      const urlObj = new URL(details.url);
      if (urlObj.hostname.includes('bilivideo.com') || urlObj.hostname.includes('hdslb.com')) {
        requestHeaders.Referer = 'https://www.bilibili.com/';
      } else if (urlObj.hostname.includes('acgmho.com') || urlObj.hostname.includes('acgnngca.com')) {
        requestHeaders.Referer = 'https://www.acgmho.com/';
      }
    } catch (_error) { }

    callback({ requestHeaders });
  });

  const { session } = require('electron');
  setupSniffer(session.defaultSession);
  if (mainWindow.webContents.session !== session.defaultSession) {
    setupSniffer(mainWindow.webContents.session);
  }

  setupTamperHandlers(mainWindow.webContents.session);
  setupDownloadHandlers();
  setupGalleryHandlers();
  setupSukebeiHandlers();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  try {
    // 同步销毁 BT 引擎，避免退出时 DHT/Peer 句柄挂起
    destroyTorrentClient();
  } catch (_e) {}
});
