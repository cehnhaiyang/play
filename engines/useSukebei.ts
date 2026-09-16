import { useState, useCallback, useEffect, useRef } from 'react';
import {
  SukebeiItem,
  SukebeiSearchOptions,
  TorrentStartOptions,
  TorrentTaskSnapshot,
  getElectronAPI,
} from '../meta';
import { loadJSON, saveJSON } from '../utils/persist';

export interface SukebeiQuery extends SukebeiSearchOptions {
  q: string;
}

const DEFAULT_QUERY: SukebeiQuery = {
  q: '',
  site: 'sukebei',
  category: '0_0',
  filter: '0',
  sort: 'id',
  pages: 1,
  minSeeders: 0,
};

export const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: '0_0', label: '全部分类' },
  { value: '1_0', label: 'Art - 全部' },
  { value: '1_1', label: 'Art - Anime' },
  { value: '1_2', label: 'Art - 同人志' },
  { value: '1_3', label: 'Art - 游戏' },
  { value: '1_4', label: 'Art - 漫画' },
  { value: '1_5', label: 'Art - 图包' },
  { value: '2_0', label: 'Real Life - 全部' },
  { value: '2_1', label: 'Real Life - 写真' },
  { value: '2_2', label: 'Real Life - 视频' },
];

/**
 * useSukebei — Sukebei/Nyaa 搜索 + 内置 BT 下载。
 * 搜索走主进程 sukebeiService，正片下载走主进程 torrentService（WebTorrent），
 * 进度通过 torrent-progress 事件回推，全程不需要迅雷/qBittorrent 等外部工具。
 */
export const useSukebei = () => {
  // 搜索条件与结果落盘：重进直接回到上次搜的那页（结果上限 100 条）
  const [query, setQuery] = useState<SukebeiQuery>(() => {
    const saved = loadJSON<Partial<SukebeiQuery>>('sukebei-query', {});
    return { ...DEFAULT_QUERY, ...(saved || {}) };
  });
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SukebeiItem[]>(() => {
    const saved = loadJSON<SukebeiItem[]>('sukebei-results', []);
    return Array.isArray(saved) ? saved.filter((r) => r && r.id).slice(0, 100) : [];
  });
  const [tasks, setTasks] = useState<TorrentTaskSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    saveJSON('sukebei-query', query);
  }, [query]);
  useEffect(() => {
    saveJSON('sukebei-results', results.slice(0, 100));
  }, [results]);
  // search 回调用 ref 读最新 query，避免把 query 放进 deps 导致每敲一字就重建回调
  const queryRef = useRef(query);
  queryRef.current = query;

  const isElectron = Boolean(getElectronAPI()?.sukebei);

  // 监听 BT 任务进度：按 id 合并进任务表
  useEffect(() => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.torrent?.onProgress) return;
    const unsubscribe = electronAPI.torrent.onProgress((snap) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === snap.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = snap;
          return next;
        }
        return [...prev, snap];
      });
    });
    return unsubscribe;
  }, []);

  // 面板打开即拉一次全量任务：此前只有点下载后才拉，切到任务页时经常是空表
  useEffect(() => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.torrent?.tasks) return;
    let cancelled = false;
    electronAPI.torrent.tasks()
      .then((all) => { if (!cancelled && Array.isArray(all)) setTasks(all); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const search = useCallback(async (custom?: Partial<SukebeiQuery>) => {
    const q = { ...queryRef.current, ...custom };
    setQuery(q);
    if (!q.q.trim()) {
      setError('请输入搜索关键词');
      return [];
    }
    const electronAPI = getElectronAPI();
    if (!electronAPI?.sukebei?.search) {
      setError('当前环境不支持搜索，请在 Electron 桌面端中运行');
      return [];
    }
    setIsSearching(true);
    setError(null);
    setNotice(null);
    try {
      const res = await electronAPI.sukebei.search(q);
      if (!res.success) {
        setError(res.message || '搜索失败');
        return [];
      }
      setResults(res.items || []);
      setNotice(`共找到 ${(res.items || []).length} 条结果`);
      return res.items || [];
    } catch (err: any) {
      setError(err?.message || '搜索失败，请检查网络');
      return [];
    } finally {
      setIsSearching(false);
    }
  }, []);

  /** 一键用内置引擎下载正片（.torrent 与 magnet 双源都传，主进程优先用种子文件秒得元数据，失败回退 magnet，无需外部工具）。 */
  const downloadItem = useCallback(async (item: SukebeiItem, fileIndexes?: number[]) => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.torrent?.start) {
      setError('当前环境不支持下载，请在 Electron 桌面端中运行');
      return null;
    }
    setError(null);
    const opts: TorrentStartOptions = {
      magnet: item.magnet || undefined,
      torrentUrl: item.torrent || undefined,
      site: item.site,
      name: item.title,
      fileIndexes,
    };
    if (!opts.magnet && !opts.torrentUrl) {
      setError('该条目既无 magnet 也无种子直链，无法下载');
      return null;
    }
    try {
      const res = await electronAPI.torrent.start(opts);
      if (!res.success) {
        setError(res.message || '任务启动失败');
        return null;
      }
      if (res.duplicate) {
        setNotice(`已在下载中：${item.title.slice(0, 40)}`);
      } else {
        setNotice(`已开始下载：${item.title.slice(0, 40)}`);
      }
      // 拉一次全量任务表，保证任务行立刻出现
      try {
        const all = await electronAPI.torrent.tasks();
        if (Array.isArray(all)) setTasks(all);
      } catch (_e) {}
      return res.taskId || null;
    } catch (err: any) {
      setError(err?.message || '任务启动失败');
      return null;
    }
  }, []);

  /** 只保存 .torrent 种子文件（不下正片）。 */
  const saveTorrentFile = useCallback(async (item: SukebeiItem) => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.sukebei?.getTorrent) {
      setError('当前环境不支持，请在 Electron 桌面端中运行');
      return null;
    }
    try {
      const res = await electronAPI.sukebei.getTorrent({
        site: item.site,
        id: item.id,
        torrentUrl: item.torrent,
        title: item.title,
      });
      if (!res.success) {
        setError(res.message || '种子保存失败');
        return null;
      }
      setNotice(`种子已保存：${res.path}`);
      return res.path || null;
    } catch (err: any) {
      setError(err?.message || '种子保存失败');
      return null;
    }
  }, []);

  const cancelTask = useCallback(async (taskId: string) => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.torrent) return;
    await electronAPI.torrent.cancel(taskId, true);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  }, []);

  const refreshTasks = useCallback(async () => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.torrent?.tasks) return;
    try {
      const all = await electronAPI.torrent.tasks();
      if (Array.isArray(all)) setTasks(all);
    } catch (_e) {}
  }, []);

  const pauseTask = useCallback(async (taskId: string) => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.torrent) return;
    await electronAPI.torrent.pause(taskId);
    // 进度事件节流 900ms，暂停后立刻本地置灰 + 拉全量，避免按钮长时间没反应
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: 'paused' as const } : t)));
    await refreshTasks();
  }, [refreshTasks]);

  const resumeTask = useCallback(async (taskId: string) => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.torrent) return;
    await electronAPI.torrent.resume(taskId);
    await refreshTasks();
  }, [refreshTasks]);

  const openFolder = useCallback(async (target: string) => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.torrent) return;
    await electronAPI.torrent.openFolder(target);
  }, []);

  const clearResults = useCallback(() => {
    setResults([]);
    setError(null);
    setNotice(null);
  }, []);

  return {
    state: {
      query,
      isSearching,
      results,
      tasks,
      error,
      notice,
      isElectron,
    },
    actions: {
      setQuery,
      search,
      downloadItem,
      saveTorrentFile,
      cancelTask,
      pauseTask,
      resumeTask,
      openFolder,
      refreshTasks,
      clearResults,
      setError,
      setNotice,
    },
  };
};
