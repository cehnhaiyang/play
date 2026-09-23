import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { DownloadCapabilities, DownloadMediaResult, FoundLink, MediaType, WebviewElement, getElectronAPI } from '../../meta';
import { extractMediaLinks } from '../../services/AiService';
import { loadJSON, saveJSON } from '../../utils/persist';
import { isAcgUrl } from '../../utils';

/**
 * 本地文件不进嗅探：已在本地的东西无需"发现下载"，属纯噪声；
 * 且 ACG 落盘页正是 file://（无 hostname，isAcgUrl 认不出），不拦会污染列表。
 */
const isFileUrl = (url: unknown): boolean =>
    typeof url === 'string' && url.trim().toLowerCase().startsWith('file:');

export const CATEGORIES: Record<MediaType, string[]> = {
  stream: ['m3u8', 'm3u', 'mpd', 'ts', 'flv', 'f4v'],
  video: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'ogv', '3gp', 'mpg', 'mpeg', 'm4s'],
  audio: ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'opus', 'wma'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'avif'],
  document: ['md', 'markdown', 'txt', 'log', 'pdf', 'json'],
  gallery: ['gallery'],
  other: [],
};

const DEFAULT_CAPABILITIES: DownloadCapabilities = {
  ffmpegAvailable: false,
  ffmpegMessage: '正在检测 ffmpeg 下载能力...',
};

const IN_PAGE_INSPECTOR_SCRIPT = `
(() => {
  const results = [];
  const seen = new Set();
  const pageTitle = (document.title || '').trim();
  const pageUrl = window.location.href;

  const streamExts = ['m3u8', 'm3u', 'mpd', 'flv', 'f4v'];
  const videoExts = ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'ogv', '3gp', 'mpg', 'mpeg', 'm4s'];
  const audioExts = ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'opus', 'wma'];
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'avif'];

  const getMediaInfo = (rawUrl, defaultType) => {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let url = rawUrl.trim();
    if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('javascript:')) return null;
    try {
      url = new URL(url, window.location.href).href;
    } catch (_e) {
      return null;
    }
    if (seen.has(url)) return null;

    let pathname = '';
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch (_e) {
      pathname = url.split('?')[0].toLowerCase();
    }

    const extMatch = pathname.match(/\\.([a-zA-Z0-9]+)$/);
    let ext = extMatch ? extMatch[1] : '';
    let type = defaultType || 'other';

    if (streamExts.includes(ext) || url.includes('.m3u8') || url.includes('.mpd')) {
      type = 'stream';
      ext = ext || (url.includes('.mpd') ? 'mpd' : 'm3u8');
    } else if (videoExts.includes(ext) || url.includes('.mp4') || url.includes('.webm') || url.includes('.m4s')) {
      type = 'video';
      ext = ext || 'mp4';
    } else if (audioExts.includes(ext) || url.includes('.mp3') || url.includes('.m4a')) {
      type = 'audio';
      ext = ext || 'mp3';
    } else if (imageExts.includes(ext)) {
      type = 'image';
      ext = ext || 'jpg';
    }

    // 智能兜底扩展名
    if (!ext) {
      if (type === 'video') ext = 'mp4';
      else if (type === 'audio') ext = 'mp3';
      else if (type === 'stream') ext = 'm3u8';
      else if (type === 'image') ext = 'jpg';
    }

    // 过滤 TS 切片分段
    if (ext === 'ts') {
      const isSegment = /\\b(seg|chunk|slice|frag|part|track|\\d{2,})\\b/i.test(pathname) || /[-_]\\d+\\.ts/i.test(pathname);
      if (isSegment && !url.includes('playlist')) return null;
    }

    if (type === 'other') return null;

    seen.add(url);
    const filename = pathname.split('/').filter(Boolean).pop() || '';
    const title = pageTitle ? pageTitle : (filename || '媒体资源');

    return {
      url,
      title,
      type,
      ext: ext || 'unknown',
      source: 'local',
      pageUrl,
      referer: pageUrl,
    };
  };

  // 1. 扫描所有的 <video>, <audio> 及其 <source> 子元素
  document.querySelectorAll('video, audio').forEach((mediaEl) => {
    const isAudio = mediaEl.tagName.toLowerCase() === 'audio';
    const defaultType = isAudio ? 'audio' : 'video';
    
    if (mediaEl.currentSrc) {
      const item = getMediaInfo(mediaEl.currentSrc, defaultType);
      if (item) results.push(item);
    }
    if (mediaEl.src) {
      const item = getMediaInfo(mediaEl.src, defaultType);
      if (item) results.push(item);
    }

    mediaEl.querySelectorAll('source').forEach((sourceEl) => {
      if (sourceEl.src) {
        const item = getMediaInfo(sourceEl.src, defaultType);
        if (item) results.push(item);
      }
    });
  });

  // 2. 扫描 Performance API (包含页面所有流媒体网络请求)
  try {
    const perfEntries = window.performance?.getEntriesByType?.('resource') || [];
    for (let i = perfEntries.length - 1; i >= 0 && results.length < 80; i--) {
      const entry = perfEntries[i];
      let perfType = undefined;
      if (entry.initiatorType === 'video') perfType = 'video';
      else if (entry.initiatorType === 'audio') perfType = 'audio';
      const item = getMediaInfo(entry.name, perfType);
      if (item) results.push(item);
    }
  } catch (_e) {}

  // 3. 扫描常见的网页播放器全局对象 (如 Bilibili __playinfo__, DPlayer, HLS 等)
  try {
    if (window.__playinfo__ && window.__playinfo__.data) {
      const data = window.__playinfo__.data;
      if (data.dash) {
        if (Array.isArray(data.dash.video)) {
          data.dash.video.forEach((v, idx) => {
            const item = getMediaInfo(v.baseUrl || v.base_url, 'video');
            if (item) {
              item.title = (pageTitle || 'Bilibili 视频') + ' - 视频轨 ' + (idx + 1);
              results.push(item);
            }
          });
        }
        if (Array.isArray(data.dash.audio)) {
          data.dash.audio.forEach((a, idx) => {
            const item = getMediaInfo(a.baseUrl || a.base_url, 'audio');
            if (item) {
              item.title = (pageTitle || 'Bilibili 音频') + ' - 音频轨 ' + (idx + 1);
              results.push(item);
            }
          });
        }
      }
      if (Array.isArray(data.durl)) {
        data.durl.forEach(d => {
          const item = getMediaInfo(d.url, 'video');
          if (item) results.push(item);
        });
      }
    }
  } catch (_e) {}

  // 4. 扫描 iframe src (很多嵌入播放器位于 iframe)
  document.querySelectorAll('iframe').forEach(iframe => {
    if (iframe.src) {
      const item = getMediaInfo(iframe.src);
      if (item) results.push(item);
    }
  });

  return {
    pageTitle,
    pageUrl,
    links: results
  };
})()
`;

export interface UseSniffOptions {
  getActiveWebview?: () => WebviewElement | null;
  activeTab?: { url: string; title?: string };
}

export const useSniff = (options?: UseSniffOptions) => {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // 嗅探结果落盘：退出重进不清零（纯 URL 文本，上限 300 条防爆配额）
  const [foundLinks, setFoundLinks] = useState<FoundLink[]>(() => {
    const saved = loadJSON<FoundLink[]>('sniff-links', []);
    if (!Array.isArray(saved)) return [];
    // 旧缓存顺带清洗：以前混进来的 ACG / 本地文件条目在此版不再保留
    return saved
      .filter((l) => l && typeof l.url === 'string' && !isFileUrl(l.url) && !isFileUrl(l.pageUrl) && !isFileUrl((l as FoundLink).referer) && !isAcgUrl(l.url) && !isAcgUrl(l.pageUrl) && !isAcgUrl((l as FoundLink).referer))
      .slice(0, 300);
  });
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [filterType, setFilterType] = useState<MediaType | 'all'>(() => {
    const saved = loadJSON<string>('sniff-filter', 'all');
    return (['all', 'stream', 'video', 'audio', 'image', 'document', 'gallery', 'other'] as const).includes(saved as MediaType | 'all')
      ? (saved as MediaType | 'all')
      : 'all';
  });
  const [scopeFilter, setScopeFilter] = useState<'all' | 'current'>(() =>
    loadJSON<'all' | 'current'>('sniff-scope', 'all') === 'current' ? 'current' : 'all'
  );
  const [downloadingUrl, setDownloadingUrl] = useState('');
  const [downloadCapabilities, setDownloadCapabilities] = useState<DownloadCapabilities>(DEFAULT_CAPABILITIES);

  // 写盘只做追加式快照，不读回，不会循环
  useEffect(() => {
    saveJSON('sniff-links', foundLinks.slice(0, 300));
  }, [foundLinks]);
  useEffect(() => {
    saveJSON('sniff-filter', filterType);
  }, [filterType]);
  useEffect(() => {
    saveJSON('sniff-scope', scopeFilter);
  }, [scopeFilter]);

  const getActiveWebviewRef = useRef(options?.getActiveWebview);
  useEffect(() => {
    getActiveWebviewRef.current = options?.getActiveWebview;
  }, [options?.getActiveWebview]);

  const activeTabRef = useRef(options?.activeTab);
  useEffect(() => {
    activeTabRef.current = options?.activeTab;
  }, [options?.activeTab]);

  const addLinks = useCallback((newLinks: FoundLink[]) => {
    // ACG 专属资源一律不进嗅探列表（走画廊流程）：资源直链在 ACG 域名，
    // 或挂在 ACG 页面下（pageUrl/referer）。本地 file:// 同样排除（无需发现下载，
    // 且 ACG 落盘页就是 file://）。所有入库通道（页内扫描/文本兜底/AI/主进程推送）统一在此拦截
    const usable = (newLinks || []).filter(
      (item) => item && typeof item.url === 'string' && !isFileUrl(item.url) && !isFileUrl(item.pageUrl) && !isFileUrl(item.referer) && !isAcgUrl(item.url) && !isAcgUrl(item.pageUrl) && !isAcgUrl(item.referer)
    );
    if (usable.length === 0) return;
    setFoundLinks((prev) => {
      const map = new Map<string, FoundLink>();
      prev.forEach((item) => map.set(item.url, item));

      usable.forEach((item) => {
        const existing = map.get(item.url);
        if (!existing) {
          let enhancedTitle = item.title;
          const cleanTitle = (enhancedTitle || '').replace(/\.[a-zA-Z0-9]+$/, '');
          const isGeneric =
            !enhancedTitle ||
            /^(media_|detected|hls|playlist|index|stream|chunk)/i.test(enhancedTitle) ||
            /^[0-9a-f]{16,}$/i.test(cleanTitle) ||
            /^\d{8,}$/.test(cleanTitle);
          if (isGeneric && activeTabRef.current?.title) {
            enhancedTitle = `${activeTabRef.current.title} (${item.ext || item.type})`;
          }
          map.set(item.url, {
            ...item,
            title: enhancedTitle,
            pageUrl: item.pageUrl || activeTabRef.current?.url,
            referer: item.referer || activeTabRef.current?.url,
          });
        } else {
          // 如果现有标题普通而新标题更好，则更新
          if (item.title && item.title !== existing.title && existing.title.startsWith('Media_')) {
            map.set(item.url, { ...existing, ...item });
          }
        }
      });
      return Array.from(map.values());
    });
  }, []);

  useEffect(() => {
    const electronAPI = getElectronAPI();
    if (!electronAPI) {
      return;
    }

    const unsubscribe = electronAPI.onSniffedMedia((media) => {
      const linkWithMeta: FoundLink = {
        ...media,
        pageUrl: media.pageUrl || activeTabRef.current?.url,
        referer: media.referer || activeTabRef.current?.url,
      };
      addLinks([linkWithMeta]);
    });

    return unsubscribe;
  }, [addLinks]);

  useEffect(() => {
    const electronAPI = getElectronAPI();
    if (!electronAPI) {
      setDownloadCapabilities({
        ffmpegAvailable: false,
        ffmpegMessage: '当前为浏览器环境，仅支持普通文件下载。',
      });
      return;
    }

    let mounted = true;
    void electronAPI.getDownloadCapabilities().then((capabilities) => {
      if (mounted) {
        setDownloadCapabilities(capabilities);
      }
    }).catch(() => {
      if (mounted) {
        setDownloadCapabilities({
          ffmpegAvailable: false,
          ffmpegMessage: 'ffmpeg 能力检测失败。',
        });
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  const extractLinksLocally = useCallback((content: string, baseUrl = ''): FoundLink[] => {
    const links: FoundLink[] = [];
    const seen = new Set<string>();

    const normalizeUrl = (rawUrl: string) => {
      if (!rawUrl) return null;

      let normalized = rawUrl.replace(/\\\//g, '/');
      if (normalized.startsWith('blob:') || normalized.startsWith('data:') || normalized.startsWith('javascript:')) {
        return null;
      }

      if (!normalized.startsWith('http')) {
        if (!baseUrl) return null;
        try {
          normalized = new URL(normalized, baseUrl).href;
        } catch (_error) {
          return null;
        }
      }

      return normalized;
    };

    const getPatterns = (exts: string[]) => {
      if (exts.length === 0) return [];
      const extGroup = exts.join('|');
      return [
        new RegExp(`(https?:\\/\\/[^\\s"',]+\\.(?:${extGroup})(?:\\?[^\\s"']*)?)`, 'gi'),
        new RegExp(`(https?:\\\\/\\\\/[^\\s"',]+\\.(?:${extGroup})(?:\\?[^\\s"']*)?)`, 'gi'),
        new RegExp(`["']((?:\\/|http)[^"']+\\.(?:${extGroup})(?:\\?[^"']*)?)["']`, 'gi'),
      ];
    };

    const scanCategory = (type: MediaType, exts: string[]) => {
      for (const regex of getPatterns(exts)) {
        let match: RegExpExecArray | null = null;
        let loopCount = 0;

        while ((match = regex.exec(content)) !== null && loopCount < 1000) {
          loopCount += 1;
          const rawUrl = match[1] || match[0];
          const cleanUrl = normalizeUrl(rawUrl.replace(/['"]/g, ''));
          if (!cleanUrl || seen.has(cleanUrl)) {
            continue;
          }

          try {
            const urlObj = new URL(cleanUrl);
            const filename = urlObj.pathname.split('/').pop() || 'Resource';
            const extMatch = urlObj.pathname.match(/\.([a-zA-Z0-9]+)$/);
            const ext = extMatch ? extMatch[1].toLowerCase() : '';
            if (!exts.includes(ext)) {
              continue;
            }

            seen.add(cleanUrl);
            let title = decodeURIComponent(filename);
            if (activeTabRef.current?.title) {
              title = `${activeTabRef.current.title} (${ext || type})`;
            }

            links.push({
              url: cleanUrl,
              title,
              type,
              ext,
              source: 'local',
              pageUrl: baseUrl,
              referer: baseUrl,
            });
          } catch (_error) { }
        }
      }
    };

    (Object.keys(CATEGORIES) as MediaType[]).forEach((type) => {
      if (type !== 'other') {
        scanCategory(type, CATEGORIES[type]);
      }
    });

    return links;
  }, []);

  const scan = useCallback(async (targetUrl?: string) => {
    const url = targetUrl || activeTabRef.current?.url;
    if (!url) return;

    setIsAnalyzing(true);
    setError('');
    setStatusMessage('正在全面嗅探页面与网络资源...');

    try {
      // 1. 如果存在活跃的 Webview，优先执行深度 DOM 嗅探与性能列表提取
      const webview = getActiveWebviewRef.current?.();
      if (webview && (webview as any).executeJavaScript) {
        try {
          const scanResult = await (webview as any).executeJavaScript(IN_PAGE_INSPECTOR_SCRIPT);
          if (scanResult?.links && Array.isArray(scanResult.links) && scanResult.links.length > 0) {
            addLinks(scanResult.links);
          }
        } catch (_e) {
          // Webview 未就绪或拒绝执行时安全回退
        }
      }

      // 2. 文本兜底嗅探：二进制媒体直链不做 fetch（跨域 CORS 必失败，
      // 且会把几百 MB 的音视频当文本读进内存）；只嗅探页面文档
      const BINARY_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.m3u8', '.mpd', '.m4s', '.ts', '.flv', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.pdf', '.zip', '.rar', '.7z'];
      const lowerUrl = url.toLowerCase().split('?')[0].split('#')[0];
      const isBinaryUrl = BINARY_EXTS.some((ext) => lowerUrl.endsWith(ext));
      let contentToAnalyze = '';
      if (!isBinaryUrl) {
        try {
          const controller = new AbortController();
          const timer = window.setTimeout(() => controller.abort(), 8000);
          try {
            const response = await fetch(url, { signal: controller.signal });
            const contentType = response.headers.get('content-type') || '';
            // 只解析文本型文档，二进制/流响应直接跳过
            const isTextLike = /text|html|json|xml|javascript|m3u|mpegurl|dash/i.test(contentType);
            if (response.ok && (isTextLike || !contentType)) {
              contentToAnalyze = await response.text();
              // 上限截断，避免超大页面卡死正则扫描
              if (contentToAnalyze.length > 500_000) {
                contentToAnalyze = contentToAnalyze.slice(0, 500_000);
              }
            }
          } finally {
            window.clearTimeout(timer);
          }
        } catch (_error) {
          // 跨域 CORS / 超时 / 离线：静默回退，仅依赖 webview 与网络层嗅探
          contentToAnalyze = '';
        }
      }

      if (contentToAnalyze) {
        const localLinks = extractLinksLocally(contentToAnalyze, url);
        if (localLinks.length > 0) {
          addLinks(localLinks);
        }
      }

      setStatusMessage('嗅探扫描完成，网络监听持续捕捉中。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '扫描失败');
    } finally {
      setIsAnalyzing(false);
    }
  }, [addLinks, extractLinksLocally]);

  const analyzeWithAi = useCallback(async (targetUrl: string) => {
    setIsAnalyzing(true);
    setError('');
    setStatusMessage('正在提取页面上下文供 AI 分析...');

    try {
      let content = '';
      const webview = getActiveWebviewRef.current?.();
      if (webview && (webview as any).executeJavaScript) {
        try {
          content = await (webview as any).executeJavaScript('document.documentElement.outerHTML');
        } catch (_e) { }
      }

      if (!content) {
        try {
          // 二进制直链不做 fetch（同 scan：CORS 必失败且占内存）
          if (!/\.(mp4|mkv|webm|mp3|wav|flac|m3u8|mpd|m4s|ts|jpg|jpeg|png|gif|webp|avif|pdf|zip)(\?|#|$)/i.test(targetUrl)) {
            const response = await fetch(targetUrl);
            const contentType = response.headers.get('content-type') || '';
            if (response.ok && (/text|html|json|xml|javascript/i.test(contentType) || !contentType)) {
              content = await response.text();
            }
          }
        } catch (_e) {
          content = '';
        }
      }

      setStatusMessage('AI 正在深度解析页面流媒体与直链...');
      const extracted = await extractMediaLinks(content, activeTabRef.current?.title || '');

      if (extracted.length === 0) {
        setStatusMessage('AI 分析完成，未发现额外结构化资源。');
        return;
      }

      const formattedLinks: FoundLink[] = extracted.map((item) => ({
        ...item,
        source: 'ai',
        pageUrl: targetUrl,
        referer: targetUrl,
      }));

      addLinks(formattedLinks);
      setStatusMessage(`AI 深度分析完成，收录 ${formattedLinks.length} 个候选资源。`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI 分析失败';
      setError(`AI 分析失败：${message}`);
    } finally {
      setIsAnalyzing(false);
    }
  }, [addLinks]);

  const clear = useCallback(() => {
    setFoundLinks([]);
    setStatusMessage('已清空嗅探列表。');
  }, []);

  const clearCurrentPage = useCallback((pageUrl?: string) => {
    const targetUrl = pageUrl || activeTabRef.current?.url;
    if (!targetUrl) {
      setFoundLinks([]);
      return;
    }
    setFoundLinks((prev) => prev.filter((item) => item.pageUrl !== targetUrl));
    setStatusMessage('已清空当前页面嗅探资源。');
  }, []);

  const download = useCallback(async (link: FoundLink): Promise<DownloadMediaResult> => {
    const electronAPI = getElectronAPI();
    if (!electronAPI) {
      const fallbackLink = document.createElement('a');
      fallbackLink.href = link.url;
      fallbackLink.download = link.title || 'media';
      fallbackLink.target = '_blank';
      fallbackLink.rel = 'noreferrer';
      fallbackLink.click();
      return { success: true, message: '已触发浏览器下载。' };
    }

    if (link.type === 'stream' && !downloadCapabilities.ffmpegAvailable) {
      const message = downloadCapabilities.ffmpegMessage || '当前无法下载流媒体资源。';
      setError(message);
      setStatusMessage(message);
      return { success: false, message };
    }

    setDownloadingUrl(link.url);
    setError('');
    setStatusMessage(link.type === 'stream' ? '正在使用 ffmpeg 下载流媒体...' : '正在下载资源...');

    try {
      const result = await electronAPI.downloadMedia({
        url: link.url,
        title: link.title,
        type: link.type,
        ext: link.ext,
        referer: link.referer || activeTabRef.current?.url,
      });

      setStatusMessage(result.message);
      if (!result.success) {
        setError(result.message);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : '下载失败';
      setError(message);
      setStatusMessage(message);
      return { success: false, message };
    } finally {
      setDownloadingUrl('');
    }
  }, [downloadCapabilities]);

  const activeTabUrl = options?.activeTab?.url;
  const filteredLinks = useMemo(() => {
    let list = foundLinks;
    if (scopeFilter === 'current' && activeTabUrl) {
      list = list.filter((item) => !item.pageUrl || item.pageUrl === activeTabUrl);
    }
    if (filterType !== 'all') {
      list = list.filter((link) => link.type === filterType);
    }
    return list;
  }, [filterType, foundLinks, scopeFilter, activeTabUrl]);

  const actions = useMemo(() => ({
    scan,
    analyzeWithAi,
    setFilterType,
    setScopeFilter,
    clear,
    clearCurrentPage,
    download,
  }), [analyzeWithAi, clear, clearCurrentPage, download, scan]);

  return {
    foundLinks,
    filteredLinks,
    isAnalyzing,
    statusMessage,
    filterType,
    scopeFilter,
    error,
    downloadingUrl,
    downloadCapabilities,
    actions,
  };
};
