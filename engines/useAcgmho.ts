import { useState, useCallback, useEffect, useRef } from 'react';
import {
  GalleryDownloadProgress,
  GalleryProbeResult,
  GalleryPageItem,
  GalleryFetchProgress,
  getElectronAPI,
} from '../meta';
import { loadJSON, saveJSON, removeStored } from '../utils/persist';

// 详情快照落盘（去掉 firstHtml 大文本，重进直接回到详情视图，可继续推送/重试）
type StoredProbe = Omit<GalleryProbeResult, 'firstHtml'> & { firstHtml?: string };
const loadStoredProbe = (): GalleryProbeResult | null => {
  const saved = loadJSON<StoredProbe | null>('gallery-detail', null);
  if (!saved || typeof saved.gid !== 'string' || !saved.gid) return null;
  const { firstHtml: _drop, ...rest } = saved;
  void _drop;
  return rest as GalleryProbeResult;
};

export const useAcgmho = () => {
  const [inputGid, setInputGid] = useState('');
  const [isProbing, setIsProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<GalleryProbeResult | null>(loadStoredProbe);
  const [pageRange, setPageRange] = useState(() => loadJSON<string>('gallery-range', ''));
  const [delayMs, setDelayMs] = useState(() => {
    const saved = loadJSON<number>('gallery-delay', 1000);
    return Number.isFinite(saved) && saved >= 0 ? saved : 1000;
  });
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<GalleryDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastDownloadDir, setLastDownloadDir] = useState<string | null>(null);

  // 写盘只做快照不读回，不会循环；firstHtml 体积大，存时剥掉
  useEffect(() => {
    if (!probeResult) return;
    const { firstHtml: _drop, ...rest } = probeResult as GalleryProbeResult & { firstHtml?: string };
    void _drop;
    saveJSON('gallery-detail', rest);
  }, [probeResult]);
  useEffect(() => {
    saveJSON('gallery-range', pageRange);
  }, [pageRange]);
  useEffect(() => {
    saveJSON('gallery-delay', delayMs);
  }, [delayMs]);

  // 在线抓取到播放器状态
  const [isFetchingPages, setIsFetchingPages] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  // 本轮失败页（主进程已重试 3 次仍失败）：可一键只重抓这些页，有序并回播放列表
  const [failedPages, setFailedPages] = useState<{ page: number; error: string }[]>(() => {
    const saved = loadJSON<{ page: number; error: string }[]>('gallery-failed', []);
    return Array.isArray(saved)
      ? saved.filter((f) => f && Number.isFinite(f.page)).slice(0, 200)
      : [];
  });

  // run 标识：同 gid 开新轮直接顶掉旧轮；流回调与进度监听都凭 runId 认领，
  // 过期 run 的回包一律丢弃，否则两轮交错追加会把剧情顺序搅乱
  const fetchRunRef = useRef<string | null>(null);
  const fetchSeqRef = useRef(0);
  // failedPages 的 ref 镜像：retry 回调读最新值，不进 deps
  const failedPagesRef = useRef<{ page: number; error: string }[]>([]);
  useEffect(() => {
    failedPagesRef.current = failedPages;
    saveJSON('gallery-failed', failedPages.slice(0, 200));
  }, [failedPages]);
  const onPageStreamRef = useRef<{ runId: string; cb: (item: GalleryPageItem) => void } | null>(null);

  // 监听下载进度
  useEffect(() => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.acgmho?.onProgress) {
      return;
    }

    const unsubscribe = electronAPI.acgmho.onProgress((data) => {
      setProgress(data);
      if (data.status === 'completed') {
        setIsDownloading(false);
      } else if (data.status === 'error' || data.status === 'cancelled') {
        setIsDownloading(false);
      }
    });

    return unsubscribe;
  }, []);

  // 监听在线解析页码进度
  useEffect(() => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.acgmho?.onFetchProgress) {
      return;
    }

    const unsubscribe = electronAPI.acgmho.onFetchProgress((data: GalleryFetchProgress) => {
      // 非本轮进度直接丢弃（上一轮被顶掉后，主进程残留回包还会飞一会儿）
      if (!data.runId || data.runId !== fetchRunRef.current) return;
      setFetchProgress({
        current: data.current,
        total: data.total,
        message:
          data.status === 'completed'
            ? '已完成全部页面解析'
            : `正在解析第 ${data.current}/${data.total} 页...`,
      });

      if (data.item && onPageStreamRef.current && onPageStreamRef.current.runId === data.runId) {
        onPageStreamRef.current.cb(data.item);
      }

      if (data.status === 'completed' || data.status === 'error' || data.status === 'cancelled') {
        setIsFetchingPages(false);
      }
    });

    return unsubscribe;
  }, []);

  const probe = useCallback(async (customTarget?: string) => {
    const target = (customTarget !== undefined ? customTarget : inputGid).trim();
    if (!target) {
      setError('请输入图集 ID 或网页链接');
      return null;
    }

    const electronAPI = getElectronAPI();
    if (!electronAPI?.acgmho?.probe) {
      setError('当前环境不支持图集探测，请在 Electron 桌面端中运行');
      return null;
    }

    setIsProbing(true);
    setError(null);
    try {
      const result = await electronAPI.acgmho.probe(target);
      setProbeResult(result);
      setPageRange(`1-${result.totalPages}`);
      if (!inputGid) {
        setInputGid(result.gid);
      }
      return result;
    } catch (err: any) {
      const msg = err?.message || '探测图集失败，请检查网络或确认作品是否存在';
      setError(msg);
      return null;
    } finally {
      setIsProbing(false);
    }
  }, [inputGid]);

  const startDownload = useCallback(async (customRange?: string) => {
    if (!probeResult) {
      setError('请先完成图集探测');
      return;
    }

    const electronAPI = getElectronAPI();
    if (!electronAPI?.acgmho?.startDownload) {
      setError('当前环境不支持下载，请在 Electron 桌面端中运行');
      return;
    }

    const pages = (customRange !== undefined ? customRange : pageRange).trim();

    setIsDownloading(true);
    setError(null);
    setProgress({
      gid: probeResult.gid,
      currentPage: 0,
      totalPages: probeResult.totalPages,
      currentBytes: 0,
      totalBytes: 0,
      percent: 0,
      currentUrl: '',
      status: 'downloading',
      message: '正在准备下载...',
      savedFiles: [],
    });

    try {
      const res = await electronAPI.acgmho.startDownload({
        gidOrUrl: probeResult.gid,
        pages: pages || `1-${probeResult.totalPages}`,
        delayMs,
      });

      if (res.outDir) {
        setLastDownloadDir(res.outDir);
      }
    } catch (err: any) {
      setError(err?.message || '下载过程中出错');
    } finally {
      setIsDownloading(false);
    }
  }, [probeResult, pageRange, delayMs]);

  const cancelDownload = useCallback(async () => {
    const electronAPI = getElectronAPI();
    if (probeResult && electronAPI?.acgmho?.cancelDownload) {
      try {
        await electronAPI.acgmho.cancelDownload(probeResult.gid);
      } catch (_err) {}
    }
    setIsDownloading(false);
  }, [probeResult]);

  const fetchPages = useCallback(
    async (
      customTarget?: string,
      customRange?: string,
      onStream?: (item: GalleryPageItem) => void
    ) => {
      const target = (customTarget !== undefined ? customTarget : inputGid).trim();
      if (!target && !probeResult) {
        setError('请输入图集 ID 或网页链接');
        return null;
      }

      const electronAPI = getElectronAPI();
      if (!electronAPI?.acgmho?.fetchPages) {
        setError('当前环境不支持在线解析图集，请在 Electron 桌面端中运行');
        return null;
      }

      // 开新 run：主进程侧同 gid 旧 run 自动作废，本轮凭 runId 认领回包
      fetchSeqRef.current += 1;
      const runId = `${Date.now()}-${fetchSeqRef.current}`;
      fetchRunRef.current = runId;
      setIsFetchingPages(true);
      setError(null);
      setFailedPages([]);
      onPageStreamRef.current = onStream ? { runId, cb: onStream } : null;

      let currentProbe = probeResult;
      try {
        if (!currentProbe || (target && target !== currentProbe.gid)) {
          currentProbe = await electronAPI.acgmho.probe(target || currentProbe?.gid || '');
          setProbeResult(currentProbe);
          if (!inputGid) {
            setInputGid(currentProbe.gid);
          }
        }

        const pages =
          (customRange !== undefined ? customRange : pageRange).trim() ||
          `1-${currentProbe.totalPages}`;

        setFetchProgress({
          current: 1,
          total: currentProbe.totalPages,
          message: `开始解析图集: ${currentProbe.title}...`,
        });

        const res = await electronAPI.acgmho.fetchPages({
          gidOrUrl: currentProbe.gid,
          pages,
          delayMs,
          runId,
          // 把详情探测结果带过去：主进程不再按纯数字重探，
          // 否则 /h/ 与 /hentai/ 同名异帖会串台（看到的和抓到的不是同一本）
          probe: currentProbe,
        });

        // 被更新的 run 顶掉后，本轮回包作废（调用方拿到 null 即停手）
        if (fetchRunRef.current !== runId) return null;
        setFailedPages(res?.errors ?? []);
        return res;
      } catch (err: any) {
        if (fetchRunRef.current !== runId) return null;
        const msg = err?.message || '在线解析图集失败';
        setError(msg);
        return null;
      } finally {
        if (fetchRunRef.current === runId) {
          setIsFetchingPages(false);
          onPageStreamRef.current = null;
        }
      }
    },
    [inputGid, probeResult, pageRange, delayMs]
  );

  // 一键重试失败页：只抓上轮失败的页码，调用方用 mergeOrderedStreams 按页码归位。
  // 不经过 onStream 流式回调（页数少，直接等整批回包，避免乱序追加）。
  const retryFailedPages = useCallback(
    async (onMerged?: (items: GalleryPageItem[]) => void) => {
      const electronAPI = getElectronAPI();
      const lastFailed = failedPagesRef.current;
      const target = probeResult;
      if (!electronAPI?.acgmho?.fetchPages || !target || lastFailed.length === 0) return null;
      fetchSeqRef.current += 1;
      const runId = `${Date.now()}-${fetchSeqRef.current}`;
      fetchRunRef.current = runId;
      setIsFetchingPages(true);
      setError(null);
      try {
        const res = await electronAPI.acgmho.fetchPages({
          gidOrUrl: target.gid,
          pages: lastFailed.map((f) => f.page).join(','),
          delayMs,
          runId,
          probe: target,
        });
        if (fetchRunRef.current !== runId) return null;
        setFailedPages(res?.errors ?? []);
        if (res?.pages?.length && onMerged) onMerged(res.pages);
        return res;
      } catch (err: any) {
        if (fetchRunRef.current !== runId) return null;
        setError(err?.message || '重试失败页时出错');
        return null;
      } finally {
        if (fetchRunRef.current === runId) setIsFetchingPages(false);
      }
    },
    [probeResult, delayMs]
  );

  const cancelFetchPages = useCallback(async () => {
    const electronAPI = getElectronAPI();
    // 本地先作废本轮：残留回包会被 runId 过滤；再通知主进程（带 runId 防误杀新 run）
    const runId = fetchRunRef.current;
    fetchRunRef.current = null;
    onPageStreamRef.current = null;
    if (probeResult && electronAPI?.acgmho?.cancelFetchPages) {
      try {
        await electronAPI.acgmho.cancelFetchPages(probeResult.gid, runId ?? undefined);
      } catch (_err) {}
    }
    setIsFetchingPages(false);
  }, [probeResult]);

  const openFolder = useCallback(async (customPath?: string) => {
    const electronAPI = getElectronAPI();
    const targetPath = customPath || lastDownloadDir;
    if (targetPath && electronAPI?.acgmho?.openFolder) {
      await electronAPI.acgmho.openFolder(targetPath);
    }
  }, [lastDownloadDir]);

  const reset = useCallback(() => {
    fetchRunRef.current = null;
    onPageStreamRef.current = null;
    setProbeResult(null);
    setProgress(null);
    setFetchProgress(null);
    setFailedPages([]);
    setError(null);
    setPageRange('');
    // 返回画廊=主动丢弃详情，还原落盘，避免下次重进又跳回旧详情
    removeStored('gallery-detail');
    removeStored('gallery-failed');
  }, []);

  return {
    state: {
      inputGid,
      isProbing,
      probeResult,
      pageRange,
      delayMs,
      isDownloading,
      progress,
      isFetchingPages,
      fetchProgress,
      failedPages,
      error,
      lastDownloadDir,
      isElectron: Boolean(getElectronAPI()?.acgmho),
    },
    actions: {
      setInputGid,
      setPageRange,
      setDelayMs,
      probe,
      startDownload,
      cancelDownload,
      fetchPages,
      retryFailedPages,
      cancelFetchPages,
      openFolder,
      reset,
    },
  };
};
