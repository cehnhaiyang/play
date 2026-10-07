import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
    SearchHit,
    SearchQuery,
    SearchSiteStatus,
    SearchSort,
    TorrentStartOptions,
    TorrentTaskSnapshot,
    SiteDescriptor,
    getElectronAPI,
} from '../meta';
import { loadJSON, saveJSON } from '../const';
import { search as runSearch, listSites } from '../services/SearchService';

/**
 * ============================================================================
 * useMagnetSearch — 磁力搜索
 * ============================================================================
 *
 * 一次关键词 → 引擎扇出查询所有已注册站点 → 汇总结果。
 *
 * 与旧 useSukebei 的区别不只是改名：旧版把「站点」当成一个下拉选项，
 * 一次只能搜一个站，且站点名写死在 hook 里。这里站点是引擎注册表里的插口，
 * 用户可以多选或全选，结果统一汇总并标注来源。
 *
 * 搜索走 services/SearchService，用渲染层 fetch 直接请求各站点——
 * 代理配在 Chromium 会话上，因此自动生效，不需要 IPC 中转。
 * 只有「把 .torrent 落到磁盘」需要主进程（文件系统权限）。
 *
 * 命名说明：不叫 useSearch，因为 useBrowse 里的地址栏搜索引擎选择器
 * （google/bing/duckduckgo）已经占用了那个名字，与此处无关。
 */

export interface MagnetSearchState {
    q: string;
    /** 勾选的站点 id；空数组 = 全部站点 */
    sites: string[];
    sort: SearchSort;
    minSeeders: number;
    /** 是否包含成人站点 */
    includeAdult: boolean;
}

const DEFAULT_QUERY: MagnetSearchState = {
    q: '',
    sites: [],           // 空 = 全部
    sort: 'seeders',
    minSeeders: 0,
    includeAdult: true,
};

export const SORT_OPTIONS: { value: SearchSort; label: string }[] = [
    { value: 'seeders', label: '做种数' },
    { value: 'size', label: '体积' },
    { value: 'date', label: '发布时间' },
    { value: 'site', label: '来源站点' },
];

export const useMagnetSearch = () => {
    // 查询条件与结果落盘：重进回到上次搜的那页
    const [query, setQuery] = useState<MagnetSearchState>(() => {
        const saved = loadJSON<Partial<MagnetSearchState>>('search-query', {});
        return { ...DEFAULT_QUERY, ...(saved || {}) };
    });
    const [isSearching, setIsSearching] = useState(false);
    const [hits, setHits] = useState<SearchHit[]>(() => {
        const saved = loadJSON<SearchHit[]>('search-hits', []);
        return Array.isArray(saved) ? saved.filter((h) => h && h.id && h.site).slice(0, 200) : [];
    });
    /** 每站状态：哪几站成功、哪几站失败及原因 */
    const [siteStatus, setSiteStatus] = useState<SearchSiteStatus[]>([]);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [tasks, setTasks] = useState<TorrentTaskSnapshot[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    useEffect(() => { saveJSON('search-query', query); }, [query]);
    useEffect(() => { saveJSON('search-hits', hits.slice(0, 200)); }, [hits]);

    // 搜索回调用 ref 读最新条件，避免把 query 放进 deps 导致每敲一字就重建回调
    const queryRef = useRef(query);
    queryRef.current = query;

    /** 已注册站点（来自引擎注册表，UI 据此渲染站点选择） */
    const sites: SiteDescriptor[] = useMemo(() => listSites(), []);

    /* ---------------------------- BT 任务进度 ---------------------------- */

    useEffect(() => {
        const api = getElectronAPI();
        if (!api?.torrent?.onProgress) return;
        const unsubscribe = api.torrent.onProgress((snap) => {
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

    // 面板打开即拉一次全量任务
    useEffect(() => {
        const api = getElectronAPI();
        if (!api?.torrent?.tasks) return;
        let cancelled = false;
        api.torrent.tasks()
            .then((all) => { if (!cancelled && Array.isArray(all)) setTasks(all); })
            .catch(() => { });
        return () => { cancelled = true; };
    }, []);

    /* ------------------------------ 搜索 ------------------------------ */

    const search = useCallback(async (custom?: Partial<MagnetSearchState>) => {
        const next = { ...queryRef.current, ...custom };
        setQuery(next);
        const keyword = next.q.trim();
        if (!keyword) {
            setError('请输入搜索关键词');
            return [];
        }

        setIsSearching(true);
        setError(null);
        setNotice(null);

        try {
            const payload: SearchQuery = {
                q: keyword,
                sites: next.sites.length ? next.sites : undefined,
                sort: next.sort,
                minSeeders: next.minSeeders,
                includeAdult: next.includeAdult,
            };
            const res = await runSearch(payload);
            setSiteStatus(res.sites || []);
            setElapsedMs(res.elapsedMs || 0);

            if (!res.success) {
                setError(res.message || '搜索失败');
                return [];
            }
            setHits(res.hits || []);
            // 这里**不设** notice。引擎返回的 message 是"几站返回结果、几站失败"，
            // 而面板已经用 siteStatus 画了一条更细的状态行（逐站耗时/失败原因）。
            // 两边都写就是同一句话在界面上说两遍。
            // notice 只留给下载/保存/复制这类一次性动作反馈。
            return res.hits || [];
        } catch (err: any) {
            // 引擎已把单站错误转成状态，走到这里说明是引擎自身的意外错误
            setError(err?.message || '搜索失败，请检查网络');
            return [];
        } finally {
            setIsSearching(false);
        }
    }, []);

    /* ------------------------------ 下载 ------------------------------ */

    /** 一键用内置引擎下载正片（.torrent 与 magnet 双源都传，主进程优先种子文件秒得元数据，失败回退 magnet）。 */
    const downloadHit = useCallback(async (hit: SearchHit, fileIndexes?: number[]) => {
        const api = getElectronAPI();
        if (!api?.torrent?.start) {
            setError('读取不到下载桥（preload 未加载），请重启应用。');
            return null;
        }
        setError(null);
        const opts: TorrentStartOptions = {
            magnet: hit.magnet || undefined,
            torrentUrl: hit.torrent || undefined,
            site: hit.site,
            name: hit.title,
            fileIndexes,
        };
        if (!opts.magnet && !opts.torrentUrl) {
            setError('该条目既无 magnet 也无种子直链，无法下载');
            return null;
        }
        try {
            const res = await api.torrent.start(opts);
            if (!res.success) {
                setError(res.message || '任务启动失败');
                return null;
            }
            setNotice(res.duplicate ? `已在下载中：${hit.title.slice(0, 40)}` : `已开始下载：${hit.title.slice(0, 40)}`);
            try {
                const all = await api.torrent.tasks();
                if (Array.isArray(all)) setTasks(all);
            } catch (_e) { /* 任务表刷新失败不影响下载本身 */ }
            return res.taskId || null;
        } catch (err: any) {
            setError(err?.message || '任务启动失败');
            return null;
        }
    }, []);

    /** 只保存 .torrent 种子文件（不下正片）。落盘需要文件系统权限，因此走主进程。 */
    const saveTorrentFile = useCallback(async (hit: SearchHit) => {
        const api = getElectronAPI();
        if (!api?.torrentFile?.fetchFile) {
            setError('读取不到种子保存桥（preload 未加载），请重启应用。');
            return null;
        }
        if (!hit.torrent) {
            setError('该条目没有种子文件直链');
            return null;
        }
        try {
            const res = await api.torrentFile.fetchFile({ url: hit.torrent, title: hit.title });
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

    /* ------------------------------ 任务 ------------------------------ */

    const cancelTask = useCallback(async (taskId: string) => {
        const api = getElectronAPI();
        if (!api?.torrent) return;
        await api.torrent.cancel(taskId, true);
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
    }, []);

    const refreshTasks = useCallback(async () => {
        const api = getElectronAPI();
        if (!api?.torrent?.tasks) return;
        try {
            const all = await api.torrent.tasks();
            if (Array.isArray(all)) setTasks(all);
        } catch (_e) { /* 忽略：刷新失败保留旧表 */ }
    }, []);

    const pauseTask = useCallback(async (taskId: string) => {
        const api = getElectronAPI();
        if (!api?.torrent) return;
        await api.torrent.pause(taskId);
        // 进度事件有节流，暂停后立刻本地置灰 + 拉全量，避免按钮长时间没反应
        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: 'paused' as const } : t)));
        await refreshTasks();
    }, [refreshTasks]);

    const resumeTask = useCallback(async (taskId: string) => {
        const api = getElectronAPI();
        if (!api?.torrent) return;
        await api.torrent.resume(taskId);
        await refreshTasks();
    }, [refreshTasks]);

    const openFolder = useCallback(async (target: string) => {
        const api = getElectronAPI();
        if (!api?.torrent) return;
        await api.torrent.openFolder(target);
    }, []);

    /** 切换单个站点的勾选状态 */
    const toggleSite = useCallback((siteId: string) => {
        setQuery((prev) => {
            const selected = prev.sites.length ? prev.sites : listSites().map((s) => s.id);
            const next = selected.includes(siteId)
                ? selected.filter((id) => id !== siteId)
                : [...selected, siteId];
            // 全选等价于"不限定"，回到空数组以保持语义简单
            const all = listSites().map((s) => s.id);
            const normalized = next.length === all.length ? [] : next;
            return { ...prev, sites: normalized };
        });
    }, []);

    const clearResults = useCallback(() => {
        setHits([]);
        setSiteStatus([]);
        setError(null);
        setNotice(null);
    }, []);

    return {
        state: {
            query,
            isSearching,
            hits,
            siteStatus,
            elapsedMs,
            tasks,
            error,
            notice,
            sites,
        },
        actions: {
            setQuery,
            search,
            downloadHit,
            saveTorrentFile,
            cancelTask,
            pauseTask,
            resumeTask,
            openFolder,
            refreshTasks,
            toggleSite,
            clearResults,
            setError,
            setNotice,
        },
    };
};
