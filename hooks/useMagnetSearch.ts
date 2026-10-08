import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
    SearchHit,
    SearchQuery,
    SearchSiteStatus,
    SearchSort,
    TorrentStartOptions,
    TorrentTaskSnapshot,
    SiteDescriptor,
    SiteGroup,
    getElectronAPI,
} from '../meta';
import { loadJSON, saveJSON } from '../const';
import { search as runSearch, sitesFor } from '../services/SearchService';

/**
 * ============================================================================
 * useMagnetSearch — 磁力搜索
 * ============================================================================
 *
 * 关键词 + 分区（表站 / 里站）→ 引擎扇出查询该分区全部站点 → 汇总结果。
 *
 * 与旧 useSukebei 的区别不只是改名：旧版把「站点」当成一个下拉选项，
 * 一次只能搜一个站。现在选的是**分区**而不是单个站点——分区内所有站点一起搜，
 * 子站点在 UI 里只能查看（名称/擅长内容/本次成败），不能逐个勾选。
 * 里站结果永远不会混进表站列表，这是分区语义的全部意义。
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
    /** 搜索分区：表站 or 里站。必选，UI 上是一组二选一分段控件 */
    group: SiteGroup;
    sort: SearchSort;
    minSeeders: number;
}

const DEFAULT_QUERY: MagnetSearchState = {
    q: '',
    group: 'sfw',
    sort: 'seeders',
    minSeeders: 0,
};

/**
 * 落盘条件里混着历史版本：早期存过 sites: string[]（站点多选）与 includeAdult
 * （成人站点开关），那两个字段的语义已经没了。这里按白名单取值，
 * 旧键不写进 state——否则 UI 拿到一个没人读的字段还以为它在生效。
 */
const sanitizeQuery = (saved: Partial<MagnetSearchState> | null): MagnetSearchState => ({
    q: typeof saved?.q === 'string' ? saved.q : DEFAULT_QUERY.q,
    group: saved?.group === 'nsfw' ? 'nsfw' : 'sfw',
    sort: saved?.sort || DEFAULT_QUERY.sort,
    minSeeders: Number(saved?.minSeeders) || DEFAULT_QUERY.minSeeders,
});

export const SORT_OPTIONS: { value: SearchSort; label: string }[] = [
    { value: 'seeders', label: '做种数' },
    { value: 'size', label: '体积' },
    { value: 'date', label: '发布时间' },
    { value: 'site', label: '来源站点' },
];

export const useMagnetSearch = () => {
    // 查询条件与结果落盘：重进回到上次搜的那页
    const [query, setQuery] = useState<MagnetSearchState>(() =>
        sanitizeQuery(loadJSON<Partial<MagnetSearchState>>('search-query', {}))
    );
    const [isSearching, setIsSearching] = useState(false);
    const [hits, setHits] = useState<SearchHit[]>(() => {
        const saved = loadJSON<SearchHit[]>('search-hits', []);
        if (!Array.isArray(saved)) return [];
        // 结果列表只能含本区站点：旧版本落盘过"表里混排"的结果，原样恢复会让里站
        // 条目出现在表站标题下，正是这次分区改造要消除的东西。
        const inGroup = new Set(sitesFor(query.group).map((s) => s.id));
        return saved.filter((h) => h && h.id && h.site && inGroup.has(h.site)).slice(0, 200);
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

    /** 当前分区内的站点（引擎注册表驱动，UI 只读展示） */
    const group = query.group;
    const sites: SiteDescriptor[] = useMemo(() => sitesFor(group), [group]);
    /** 两个分区各自的站点数：分段控件要显示"表站 5 / 里站 3" */
    const groupCounts = useMemo(
        () => ({ sfw: sitesFor('sfw').length, nsfw: sitesFor('nsfw').length }),
        []
    );

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
                group: next.group,
                sort: next.sort,
                minSeeders: next.minSeeders,
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

    /**
     * 切分区（表站 / 里站）。切换即清空结果与各站状态：
     * 列表里留着上一个分区的条目，等于把"里站结果混进表站列表"换了个方式发生。
     */
    const setGroup = useCallback((next: SiteGroup) => {
        if (queryRef.current.group === next) return;
        setQuery({ ...queryRef.current, group: next });
        setHits([]);
        setSiteStatus([]);
        setError(null);
        setNotice(null);
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
            groupCounts,
        },
        actions: {
            setQuery,
            setGroup,
            search,
            downloadHit,
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
