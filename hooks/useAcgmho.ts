import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
    AcgmhoChannelDef,
    AcgmhoGalleryItem,
    GalleryDownloadProgress,
    GalleryProbeResult,
    GalleryPageItem,
    GalleryFetchProgress,
    GallerySaveOptions,
    GallerySaveProgress,
    GallerySavedFile,
    getElectronAPI,
} from '../meta';
import { loadJSON, saveJSON, removeStored } from '../utils/persist';

/* ========================================================================== */
/*                             1. 类型定义与公共配置                           */
/* ========================================================================== */

export type AcgSaveTaskStatus = 'saving' | 'completed' | 'cancelled' | 'error';

export interface AcgSaveTask {
    /** 作品数字 ID（任务键） */
    gid: string;
    title: string;
    totalFiles: number;
    doneFiles: number;
    percent: number;
    status: AcgSaveTaskStatus;
    message: string;
    outDir?: string;
    updatedAt: number;
}

interface ChannelCache {
    items: AcgmhoGalleryItem[];
    page: number;
    hasMore: boolean;
    /** 搜索流上一页规范地址（频道流为空）：翻页时回传主进程 */
    baseUrl?: string;
}

interface StoredCacheEntry extends ChannelCache {
    ts: number;
}

// 详情快照落盘类型（剔除 firstHtml 大文本，见 GalleryProbeResult 注释）
type StoredProbe = Omit<GalleryProbeResult, 'firstHtml'>;

/* ========================================================================== */
/*                     2. 全局后台保存任务模块 (Downloads Store)               */
/* ========================================================================== */

let tasks: Record<string, AcgSaveTask> = {};
let snapshot: AcgSaveTask[] = [];
const listeners = new Set<() => void>();

const TASKS_STORE_KEY = 'acg-save-tasks';
const TASKS_STORE_MAX = 20;
let lastPersistAt = 0;

const persistTasks = (immediate = false) => {
    const now = Date.now();
    if (!immediate && now - lastPersistAt < 2000) return;
    lastPersistAt = now;
    try {
        const records = Object.values(tasks).slice(0, TASKS_STORE_MAX);
        saveJSON(TASKS_STORE_KEY, records);
    } catch {
        /* ignore */
    }
};

const restoreTasks = (): void => {
    try {
        const saved = loadJSON<AcgSaveTask[]>(TASKS_STORE_KEY, []);
        if (!Array.isArray(saved)) return;
        const next: Record<string, AcgSaveTask> = {};
        for (const t of saved.slice(0, TASKS_STORE_MAX)) {
            if (!t || typeof t.gid !== 'string' || !t.gid) continue;
            next[t.gid] = {
                gid: t.gid,
                title: typeof t.title === 'string' ? t.title : `作品 ${t.gid}`,
                totalFiles: Number.isFinite(t.totalFiles) ? t.totalFiles : 0,
                doneFiles: Number.isFinite(t.doneFiles) ? t.doneFiles : 0,
                percent: Number.isFinite(t.percent) ? t.percent : 0,
                status: t.status === 'saving' ? 'cancelled' : t.status || 'cancelled',
                message:
                    t.status === 'saving'
                        ? '应用已重启，任务中断（可重新边下边播）'
                        : t.message || '',
                outDir: typeof t.outDir === 'string' ? t.outDir : undefined,
                updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : Date.now(),
            };
        }
        tasks = next;
        snapshot = Object.values(tasks).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
        /* ignore */
    }
};

const refreshSnapshot = () => {
    snapshot = Object.values(tasks).sort((a, b) => b.updatedAt - a.updatedAt);
};

const emit = () => {
    refreshSnapshot();
    listeners.forEach((l) => l());
    persistTasks();
};

const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
};

const getSnapshot = () => snapshot;

// 模块初始化时恢复上次落盘任务
restoreTasks();

/** gid -> 播放列表回写回调集：单页落盘完成即把本地 URL 替换进播放器 */
const fileSyncs = new Map<string, Set<(file: GallerySavedFile) => void>>();

export const bindSaveFileSync = (
    gid: string,
    cb: (file: GallerySavedFile) => void
): (() => void) => {
    const key = String(gid || '');
    if (!key) return () => { };
    let set = fileSyncs.get(key);
    if (!set) {
        set = new Set();
        fileSyncs.set(key, set);
    }
    set.add(cb);
    return () => {
        set!.delete(cb);
        if (set!.size === 0) fileSyncs.delete(key);
    };
};

const upsertTask = (gid: string, patch: Partial<AcgSaveTask>) => {
    const key = String(gid || '');
    if (!key) return;
    const prev = tasks[key];
    tasks = {
        ...tasks,
        [key]: {
            gid: key,
            title: patch.title ?? prev?.title ?? `作品 ${key}`,
            totalFiles: patch.totalFiles ?? prev?.totalFiles ?? 0,
            doneFiles: patch.doneFiles ?? prev?.doneFiles ?? 0,
            percent: patch.percent ?? prev?.percent ?? 0,
            status: patch.status ?? prev?.status ?? 'saving',
            message: patch.message ?? prev?.message ?? '',
            outDir: patch.outDir ?? prev?.outDir,
            updatedAt: Date.now(),
        },
    };
    emit();
};

const applySaveProgress = (p: GallerySaveProgress) => {
    // 任务键优先：同数字 gid 不同前缀的两本书各走各的进度与 file-done 回写
    const key = String(p?.taskKey || '') || acgTaskKeyOf(String(p?.gid || ''));
    if (!key) return;
    if (p.status === 'file-done' && p.file) {
        const syncs = fileSyncs.get(key);
        if (syncs) {
            syncs.forEach((cb) => {
                try {
                    cb(p.file as GallerySavedFile);
                } catch {
                    /* ignore */
                }
            });
        }
        // file-done 同步回写任务进度（否则进度条卡在上一文件直到下一块到来）
        const total = Number(p.totalFiles) || 0;
        const done = Math.max(Number(p.doneFiles) || 0, (tasks[key]?.doneFiles ?? 0) + 1);
        upsertTask(key, {
            title: p.title,
            totalFiles: total,
            doneFiles: Math.min(done, total || done),
            percent: total > 0 ? Math.round((Math.min(done, total) / total) * 100) : 0,
            outDir: p.outDir,
            message: p.message ?? `第 ${p.file.page} 页已保存到本地`,
        });
        return;
    }
    const terminal: Record<string, AcgSaveTaskStatus> = {
        completed: 'completed',
        cancelled: 'cancelled',
        error: 'error',
    };
    upsertTask(key, {
        title: p.title,
        totalFiles: p.totalFiles,
        doneFiles: p.doneFiles,
        percent: p.percent,
        outDir: p.outDir,
        message: p.message,
        status: terminal[p.status] ?? 'saving',
    });
    if (terminal[p.status]) persistTasks(true);
};

let saveListenerArmed = false;
const ensureSaveListener = () => {
    if (saveListenerArmed) return;
    try {
        const api = getElectronAPI();
        if (!api?.acgmho?.onSaveProgress) return;
        saveListenerArmed = true;
        api.acgmho.onSaveProgress((p: GallerySaveProgress) => {
            applySaveProgress(p);
        });
    } catch {
        /* ignore */
    }
};

/**
 * useAcgDownloads — 管理全局多作品后台落盘进度
 */
export const useAcgDownloads = () => {
    const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    useEffect(() => {
        ensureSaveListener();
    }, []);

    const startSave = useCallback((options: GallerySaveOptions) => {
        const api = getElectronAPI();
        if (!api?.acgmho?.saveImages) return Promise.resolve(null);
        ensureSaveListener();
        const gid = String(options.gid || '');
        // 空 gid/空直链直接拒掉（先建空任务再报错会留下无处回写的错误态）
        if (!gid || !Array.isArray(options.items) || options.items.length === 0) {
            return Promise.resolve(null);
        }
        // 任务键带前缀：/h/123 与 /hentai/123 各自独立，主进程原样带回进度
        const key = acgTaskKeyOf(gid, options.prefix) || gid;
        upsertTask(key, {
            title: options.title || `作品 ${gid}`,
            totalFiles: options.items.length,
            doneFiles: 0,
            percent: 0,
            status: 'saving',
            message: '正在准备保存…',
        });
        return api.acgmho.saveImages({ ...options, taskKey: key }).then(
            (res) => res,
            (err: unknown) => {
                upsertTask(key, {
                    status: 'error',
                    message: err instanceof Error ? err.message : '保存任务启动失败',
                });
                return null;
            }
        );
    }, []);

    const cancelSave = useCallback((gid: string) => {
        const api = getElectronAPI();
        const key = String(gid || '');
        if (!key) return;
        try {
            void api?.acgmho?.cancelSaveImages?.(key);
        } catch {
            /* ignore */
        }
        const prev = tasks[key];
        if (prev && prev.status === 'saving') {
            upsertTask(key, { status: 'cancelled', message: '已取消保存' });
        }
    }, []);

    const dismissTask = useCallback((gid: string) => {
        const key = String(gid || '');
        if (!key || !tasks[key]) return;
        const next = { ...tasks };
        delete next[key];
        tasks = next;
        emit();
        persistTasks(true);
    }, []);

    const openFolder = useCallback((outDir?: string) => {
        const api = getElectronAPI();
        if (outDir && api?.acgmho?.openFolder) {
            void api.acgmho.openFolder(outDir);
        }
    }, []);

    const actions = useMemo(
        () => ({ startSave, cancelSave, dismissTask, openFolder }),
        [startSave, cancelSave, dismissTask, openFolder]
    );

    return {
        tasks: list,
        actions,
    };
};

/* ========================================================================== */
/*                     3. 画廊频道与列表缓存模块 (Gallery Store)               */
/* ========================================================================== */

const GALLERY_CACHE_TTL = 30 * 60 * 1000;
const GALLERY_CACHE_ITEMS = 60;

function loadStoredCache(): Map<string, ChannelCache> {
    const map = new Map<string, ChannelCache>();
    try {
        const raw = loadJSON<Record<string, StoredCacheEntry>>('gallery-cache', {});
        const now = Date.now();
        for (const [id, entry] of Object.entries(raw || {})) {
            if (!entry || !Array.isArray(entry.items) || typeof entry.ts !== 'number') continue;
            if (now - entry.ts > GALLERY_CACHE_TTL) continue;
            map.set(id, {
                items: entry.items.slice(0, GALLERY_CACHE_ITEMS),
                page: entry.page || 1,
                hasMore: entry.hasMore !== false,
            });
        }
    } catch {
        /* ignore */
    }
    return map;
}

function storeCache(map: Map<string, ChannelCache>): void {
    const raw: Record<string, StoredCacheEntry> = {};
    for (const [id, entry] of map) {
        // 搜索结果只留内存：关键词无上限，落盘会撑爆 localStorage
        if (id.startsWith('search:')) continue;
        raw[id] = {
            items: entry.items.slice(0, GALLERY_CACHE_ITEMS),
            page: entry.page,
            hasMore: entry.hasMore,
            ts: Date.now(),
        };
    }
    saveJSON('gallery-cache', raw);
}

// 落盘防抖（1s 尾随）：loadMore 每页都调 persistCache，直写会阻塞主线程造成滚动卡顿。
let galleryCacheTimer: ReturnType<typeof setTimeout> | null = null;
function storeCacheDebounced(map: Map<string, ChannelCache>): void {
    if (galleryCacheTimer) clearTimeout(galleryCacheTimer);
    galleryCacheTimer = setTimeout(() => {
        galleryCacheTimer = null;
        storeCache(map);
    }, 1000);
}

// 任务键：/h/123 与 /hentai/123 是两本不同的作品，纯数字 gid 会互顶。
// 与主进程 galleryTaskKey 同口径：有前缀用 prefix:gid，无则回退纯 gid（兼容旧任务）。
export const acgTaskKeyOf = (gid: string, prefix?: string): string => {
    const g = String(gid || '').trim();
    const p = String(prefix || '').trim().toLowerCase();
    if (!g) return '';
    if (!p || p === 'auto') return g;
    return `${p}:${g}`;
};

// 条目去重键：/h/123 与 /hentai/123 是两本不同的作品，不能只按 gid 去重
const itemKey = (i: AcgmhoGalleryItem): string => `${i.prefix || ''}:${i.gid}`;

// 列表合并（去重保首见顺序）：静默补新时新条目置顶，追加/换频道时旧在前新在后
const mergeChannelItems = (
    base: AcgmhoGalleryItem[],
    incoming: AcgmhoGalleryItem[],
    prepend: boolean
): AcgmhoGalleryItem[] => {
    const seen = new Set<string>();
    const merged: AcgmhoGalleryItem[] = [];
    const ordered = prepend ? [...incoming, ...base] : [...base, ...incoming];
    for (const it of ordered) {
        const k = itemKey(it);
        if (!seen.has(k)) {
            seen.add(k);
            merged.push(it);
        }
    }
    return merged;
};

// 从 URL 或纯 ID 中提取数字 gid，用于"是否同一本"的比较（主进程 normalizeGid 的轻量版）
const extractGid = (target: string): string => {
    const m = String(target || '').match(/(\d+)/);
    return m ? m[1] : String(target || '').trim();
};

// 提取 URL 中的站点前缀（无则为 auto）：只比 gid 会把 /h/123 与 /hentai/123 认成同一本
const extractPrefix = (target: string): string => {
    const m = String(target || '').match(
        /\/(hentai|h|hanime|asmr|gif|animation|cos|webtoon|western|g)\/(\d+)/i
    );
    if (!m) return 'auto';
    const p = m[1].toLowerCase();
    if (p === 'animation') return 'gif';
    if (p === 'g') return 'auto';
    return p;
};

// 目标地址与现存探测是否为同一本：gid 相同且前缀不冲突（auto 视为通配）
const isSameProbeTarget = (target: string, probe: { gid: string; prefix?: string } | null): boolean => {
    if (!probe) return false;
    if (!target) return true;
    if (extractGid(target) !== String(probe.gid)) return false;
    const wantPrefix = extractPrefix(target);
    if (wantPrefix === 'auto') return true;
    return (probe.prefix || '') === wantPrefix;
};

/**
 * useAcgmhoGallery — 画廊浏览流与频道秒切数据层
 */
export const useAcgmhoGallery = () => {
    const [channels, setChannels] = useState<AcgmhoChannelDef[]>([]);
    const [channelId, setChannelId] = useState<string>('latest');
    const [searchKeyword, setSearchKeyword] = useState<string>('');
    const [items, setItems] = useState<AcgmhoGalleryItem[]>([]);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 缓存 Map 用 useState 懒初始化（写 useRef 实参里会每次渲染都解析一次 localStorage）
    const [cacheMap] = useState<Map<string, ChannelCache>>(loadStoredCache);
    const cacheRef = useRef<Map<string, ChannelCache>>(cacheMap);
    const channelIdRef = useRef(channelId);
    const searchKeywordRef = useRef(searchKeyword);
    const pageRef = useRef(page);
    // render 期不写 ref（并发模式不安全），统一走 effect 同步；回调内需即时值处手动同步
    useEffect(() => {
        channelIdRef.current = channelId;
    }, [channelId]);
    useEffect(() => {
        searchKeywordRef.current = searchKeyword;
    }, [searchKeyword]);
    useEffect(() => {
        pageRef.current = page;
    }, [page]);
    // 在途请求键（channel|keyword|page）：发起时占位，回包比对丢弃过期者
    const requestKeyRef = useRef<string | null>(null);
    // 追加在途锁：无限滚动 observer 在预取区内反复触发，无锁会并发抓同一页
    const loadingMoreRef = useRef(false);

    // 落盘防抖（同步写 localStorage 阻塞主线程，连续翻页只落最后一次）
    const persistCache = useCallback(() => {
        storeCacheDebounced(cacheRef.current);
    }, []);

    // 加载频道列表（主进程唯一源，有兜底保证）
    useEffect(() => {
        const electronAPI = getElectronAPI();
        if (!electronAPI?.acgmho?.channels) return;
        let cancelled = false;
        electronAPI.acgmho
            .channels()
            .then((list) => {
                if (!cancelled && Array.isArray(list) && list.length > 0) setChannels(list);
            })
            .catch(() => { });
        return () => {
            cancelled = true;
        };
    }, []);

    const loadPage = useCallback(
        async (
            targetChannel: string,
            targetPage: number,
            append: boolean,
            silent = false,
            keyword = '',
            baseUrl = ''
        ) => {
            const electronAPI = getElectronAPI();
            if (!electronAPI?.acgmho?.channelList) {
                setError('读取不到画廊桥（preload 未加载），请重启应用。');
                return;
            }
            if (append) {
                if (loadingMoreRef.current) return;
                loadingMoreRef.current = true;
            }
            // 请求键精确到页：慢回包凭它辨别过期（并发不拦截，过期回包一律丢弃）
            const requestKey = `${targetChannel}|${keyword}|${targetPage}|${append ? 'more' : 'first'}`;
            requestKeyRef.current = requestKey;
            if (append) setIsLoadingMore(true);
            else if (!silent) {
                setIsLoading(true);
                setError(null);
                setItems([]);
            }
            try {
                const res = await electronAPI.acgmho.channelList({
                    channelId: targetChannel,
                    page: targetPage,
                    query: keyword,
                    baseUrl: baseUrl || undefined,
                });
                // 过期回包直接丢弃（用户已切频道、换了关键词或翻了更新的页）
                if (requestKeyRef.current !== requestKey) return;
                if (!res.success) {
                    setError(res.message || '列表加载失败');
                    return;
                }
                const incoming = res.items || [];
                const cacheKey = keyword ? `search:${keyword}` : targetChannel;
                // 以缓存（非 setItems updater）为合并数据源：updater 在并发模式下可能延迟/重复执行
                const base = append || silent ? cacheRef.current.get(cacheKey)?.items ?? [] : [];
                // 静默补新（第 1 页重拉）新条目置顶；追加/换频道保持"旧在前、新在后"的页序
                const merged = mergeChannelItems(base, incoming, silent && !append);
                // 追加零增长说明服务端已无新内容（如翻页回绕）：直接收敛 hasMore
                const grew = merged.length > base.length;
                const cachedPrev = cacheRef.current.get(cacheKey);
                // 静默补新只补第 1 页：已载页码不能回退到 1，否则"加载更多"会重复拉取
                const nextPage = silent && !append ? Math.max(targetPage, cachedPrev?.page ?? 1) : targetPage;
                // 追加无增长则没有更多了，避免"加载更多"死循环打转
                const nextHasMore = append && !grew ? false : res.hasMore;
                cacheRef.current.set(cacheKey, {
                    items: merged,
                    page: nextPage,
                    hasMore: nextHasMore,
                    baseUrl: res.baseUrl || cachedPrev?.baseUrl,
                });
                setItems(merged);
                setPage(nextPage);
                setHasMore(nextHasMore);
                persistCache();
            } catch (err: any) {
                if (requestKeyRef.current === requestKey) {
                    setError(err?.message || '列表加载失败，请检查网络');
                }
            } finally {
                // 只清自己的占位与转圈：后发起的请求不受影响（旧回包先落袋时不许掐新请求的 spinner）
                if (requestKeyRef.current === requestKey) {
                    requestKeyRef.current = null;
                    setIsLoading(false);
                    setIsLoadingMore(false);
                }
                if (append) loadingMoreRef.current = false;
            }
        },
        [persistCache]
    );

    const selectChannel = useCallback(
        (id: string) => {
            setChannelId(id);
            channelIdRef.current = id;
            setSearchKeyword('');
            searchKeywordRef.current = '';
            setError(null);
            const cached = cacheRef.current.get(id);
            if (cached) {
                setItems(cached.items);
                setPage(cached.page);
                setHasMore(cached.hasMore);
                return;
            }
            void loadPage(id, 1, false, false, '');
        },
        [loadPage]
    );

    const search = useCallback(
        (keyword: string) => {
            const trimmed = (keyword || '').trim();
            if (!trimmed) {
                selectChannel('latest');
                return;
            }
            setChannelId('search');
            channelIdRef.current = 'search';
            setSearchKeyword(trimmed);
            searchKeywordRef.current = trimmed;
            setError(null);
            const cacheKey = `search:${trimmed}`;
            const cached = cacheRef.current.get(cacheKey);
            if (cached) {
                setItems(cached.items);
                setPage(cached.page);
                setHasMore(cached.hasMore);
                return;
            }
            void loadPage('search', 1, false, false, trimmed);
        },
        [loadPage, selectChannel]
    );

    const loadMore = useCallback(() => {
        const currentChannel = channelIdRef.current;
        const currentKeyword = searchKeywordRef.current;
        const cacheKey = currentKeyword ? `search:${currentKeyword}` : currentChannel;
        const cached = cacheRef.current.get(cacheKey);
        // 已触底直接返回：无限滚动触底后 observer 仍会触发，无此短路会空转请求
        if (cached && cached.hasMore === false) return;
        // 读 ref 而非 state：actions 容器可稳定 memo，翻页按钮不再每次 page 变化都换身份
        const nextPage = (cached?.page ?? pageRef.current) + 1;
        void loadPage(currentChannel, nextPage, true, false, currentKeyword, cached?.baseUrl);
    }, [loadPage]);

    const refresh = useCallback(() => {
        const currentChannel = channelIdRef.current;
        const currentKeyword = searchKeywordRef.current;
        const cacheKey = currentKeyword ? `search:${currentKeyword}` : currentChannel;
        const cached = cacheRef.current.get(cacheKey);
        // 刷新保留规范翻页基址（搜索第 1 页可不用，但保留无害）；内容缓存清掉重拉
        const baseUrl = cached?.baseUrl;
        cacheRef.current.delete(cacheKey);
        persistCache();
        void loadPage(currentChannel, 1, false, false, currentKeyword, baseUrl);
    }, [loadPage, persistCache]);

    // 首屏恢复 latest 缓存并静默补新
    useEffect(() => {
        const cached = cacheRef.current.get('latest');
        if (cached && cached.items.length > 0) {
            setItems(cached.items);
            setPage(cached.page);
            setHasMore(cached.hasMore);
            void loadPage('latest', 1, false, true);
            return;
        }
        void loadPage('latest', 1, false);
    }, [loadPage]);

    // actions 容器 memo：GalleryCard memo 依赖 onOpen 身份，容器每 render 重建会连带整网重渲染
    const galleryActions = useMemo(
        () => ({ selectChannel, search, loadMore, refresh }),
        [selectChannel, search, loadMore, refresh]
    );

    return {
        state: {
            channels,
            channelId,
            searchKeyword,
            items,
            page,
            hasMore,
            isLoading,
            isLoadingMore,
            error,
        },
        actions: galleryActions,
    };
};

/* ========================================================================== */
/*                     4. 详情探测与边下边播核心 (Detail Engine)               */
/* ========================================================================== */

const loadStoredProbe = (): GalleryProbeResult | null => {
    const saved = loadJSON<StoredProbe | null>('gallery-detail', null);
    if (!saved || typeof saved.gid !== 'string' || !saved.gid) return null;
    // 落盘时已剔除 firstHtml，此处无大文本可剥，直接可用
    return saved;
};

/**
 * useAcgmho — 作品详情探测、全本抓取与边下边播核心 Hook
 */
export const useAcgmho = () => {
    const [inputGid, setInputGid] = useState('');
    const [isProbing, setIsProbing] = useState(false);
    const [probeResult, setProbeResult] = useState<GalleryProbeResult | null>(
        loadStoredProbe
    );
    const [pageRange, setPageRange] = useState(() =>
        loadJSON<string>('gallery-range', '')
    );
    const [delayMs, setDelayMs] = useState(() => {
        const saved = loadJSON<number>('gallery-delay', 1000);
        return Number.isFinite(saved) && saved >= 0 ? saved : 1000;
    });
    const [isDownloading, setIsDownloading] = useState(false);
    const [progress, setProgress] = useState<GalleryDownloadProgress | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [lastDownloadDir, setLastDownloadDir] = useState<string | null>(null);

    // 快照持久化（firstHtml 大文本不落盘，类型上已可选，此处解构剔除）
    useEffect(() => {
        if (!probeResult) return;
        const { firstHtml: _drop, ...rest } = probeResult;
        void _drop;
        saveJSON('gallery-detail', rest);
    }, [probeResult]);

    useEffect(() => {
        saveJSON('gallery-range', pageRange);
    }, [pageRange]);

    useEffect(() => {
        saveJSON('gallery-delay', delayMs);
    }, [delayMs]);

    // 在线抓取与多 runId 防乱序状态
    const [isFetchingPages, setIsFetchingPages] = useState(false);
    const [fetchProgress, setFetchProgress] = useState<{
        current: number;
        total: number;
        message: string;
    } | null>(null);

    const [failedPages, setFailedPages] = useState<
        { page: number; error: string }[]
    >(() => {
        const saved = loadJSON<{ page: number; error: string }[]>('gallery-failed', []);
        return Array.isArray(saved)
            ? saved.filter((f) => f && Number.isFinite(f.page)).slice(0, 200)
            : [];
    });

    const fetchRunRef = useRef<string | null>(null);
    const fetchSeqRef = useRef(0);
    const failedPagesRef = useRef<{ page: number; error: string }[]>([]);

    useEffect(() => {
        failedPagesRef.current = failedPages;
        saveJSON('gallery-failed', failedPages.slice(0, 200));
    }, [failedPages]);

    const onPageStreamRef = useRef<{
        runId: string;
        cb: (item: GalleryPageItem) => void;
    } | null>(null);

    // 监听全量下载进度（旧版兼容）
    useEffect(() => {
        const electronAPI = getElectronAPI();
        if (!electronAPI?.acgmho?.onProgress) return;

        const unsubscribe = electronAPI.acgmho.onProgress((data) => {
            setProgress(data);
            if (
                data.status === 'completed' ||
                data.status === 'error' ||
                data.status === 'cancelled'
            ) {
                setIsDownloading(false);
            }
        });

        return unsubscribe;
    }, []);

    // 监听在线解析页码进度
    useEffect(() => {
        const electronAPI = getElectronAPI();
        if (!electronAPI?.acgmho?.onFetchProgress) return;

        const unsubscribe = electronAPI.acgmho.onFetchProgress(
            (data: GalleryFetchProgress) => {
                if (!data.runId || data.runId !== fetchRunRef.current) return;
                setFetchProgress({
                    current: data.current,
                    total: data.total,
                    message:
                        data.status === 'completed'
                            ? '已完成全部页面解析'
                            : `正在解析第 ${data.current}/${data.total} 页...`,
                });

                if (
                    data.item &&
                    onPageStreamRef.current &&
                    onPageStreamRef.current.runId === data.runId
                ) {
                    onPageStreamRef.current.cb(data.item);
                }

                if (
                    data.status === 'completed' ||
                    data.status === 'error' ||
                    data.status === 'cancelled'
                ) {
                    setIsFetchingPages(false);
                }
            }
        );

        return unsubscribe;
    }, []);

    const probe = useCallback(
        async (customTarget?: string) => {
            const target = (customTarget !== undefined ? customTarget : inputGid).trim();
            if (!target) {
                setError('请输入图集 ID 或网页链接');
                return null;
            }

            const electronAPI = getElectronAPI();
            if (!electronAPI?.acgmho?.probe) {
                setError('读取不到图集探测桥（preload 未加载），请重启应用。');
                return null;
            }

            setIsProbing(true);
            setError(null);
            try {
                const result = await electronAPI.acgmho.probe(target);
                setProbeResult(result);
                setPageRange(`1-${result.totalPages}`);
                // 回写探测时的原文（URL 含前缀）：只存数字 gid 会丢前缀，
                // 后续 fetchPages 拿纯数字重探可能命中同名异站帖子
                setInputGid(target);
                return result;
            } catch (err: any) {
                const msg = err?.message || '探测图集失败，请检查网络或确认作品是否存在';
                setError(msg);
                return null;
            } finally {
                setIsProbing(false);
            }
        },
        [inputGid]
    );

    const startDownload = useCallback(
        async (customRange?: string) => {
            if (!probeResult) {
                setError('请先完成图集探测');
                return;
            }

            const electronAPI = getElectronAPI();
            if (!electronAPI?.acgmho?.startDownload) {
                setError('读取不到下载桥（preload 未加载），请重启应用。');
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
                    // 传详情页原文（带前缀）+ 配套 probe：纯数字 gid 重探可能串到同名异帖
                    gidOrUrl: probeResult.firstPageUrl || probeResult.gid,
                    pages: pages || `1-${probeResult.totalPages}`,
                    delayMs,
                    probe: probeResult,
                });

                if (res.outDir && res.success !== false) {
                    setLastDownloadDir(res.outDir);
                }
            } catch (err: any) {
                setError(err?.message || '下载过程中出错');
            } finally {
                setIsDownloading(false);
            }
        },
        [probeResult, pageRange, delayMs]
    );

    const cancelDownload = useCallback(async () => {
        const electronAPI = getElectronAPI();
        if (probeResult && electronAPI?.acgmho?.cancelDownload) {
            try {
                await electronAPI.acgmho.cancelDownload(probeResult.gid);
            } catch (_err) { }
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
                setError('读取不到在线解析桥（preload 未加载），请重启应用。');
                return null;
            }

            fetchSeqRef.current += 1;
            const runId = `${Date.now()}-${fetchSeqRef.current}`;
            fetchRunRef.current = runId;
            setIsFetchingPages(true);
            setError(null);
            setFailedPages([]);
            onPageStreamRef.current = onStream ? { runId, cb: onStream } : null;

            let currentProbe = probeResult;
            try {
                // 同一本必须 gid+前缀双比（/h/869222 与 /hentai/869222 是两本不同的作品）
                if (!currentProbe || (target && !isSameProbeTarget(target, currentProbe))) {
                    currentProbe = await electronAPI.acgmho.probe(
                        target || currentProbe?.gid || ''
                    );
                    setProbeResult(currentProbe);
                    setInputGid(target || currentProbe.gid);
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
                    // 传详情页原文（带前缀）+ 配套 probe：纯数字 gid 重探可能串到同名异帖
                    gidOrUrl: currentProbe.firstPageUrl || currentProbe.gid,
                    pages,
                    delayMs,
                    runId,
                    probe: currentProbe,
                });

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

    const retryFailedPages = useCallback(
        async (onMerged?: (items: GalleryPageItem[]) => void) => {
            const electronAPI = getElectronAPI();
            const lastFailed = failedPagesRef.current;
            const target = probeResult;
            if (!electronAPI?.acgmho?.fetchPages || !target || lastFailed.length === 0)
                return null;
            fetchSeqRef.current += 1;
            const runId = `${Date.now()}-${fetchSeqRef.current}`;
            fetchRunRef.current = runId;
            setIsFetchingPages(true);
            setError(null);
            try {
                const res = await electronAPI.acgmho.fetchPages({
                    gidOrUrl: target.firstPageUrl || target.gid,
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
        const runId = fetchRunRef.current;
        fetchRunRef.current = null;
        onPageStreamRef.current = null;
        if (probeResult && electronAPI?.acgmho?.cancelFetchPages) {
            try {
                await electronAPI.acgmho.cancelFetchPages(
                    probeResult.firstPageUrl || probeResult.gid,
                    runId ?? undefined
                );
            } catch (_err) { }
        }
        setIsFetchingPages(false);
    }, [probeResult]);

    const openFolder = useCallback(
        async (customPath?: string) => {
            const electronAPI = getElectronAPI();
            const targetPath = customPath || lastDownloadDir;
            if (targetPath && electronAPI?.acgmho?.openFolder) {
                await electronAPI.acgmho.openFolder(targetPath);
            }
        },
        [lastDownloadDir]
    );

    const reset = useCallback(() => {
        // 返回列表即视为放弃本作：先停掉主进程在途的抓取/下载，否则后台继续跑、浪费带宽
        const electronAPI = getElectronAPI();
        const runId = fetchRunRef.current;
        fetchRunRef.current = null;
        onPageStreamRef.current = null;
        if (probeResult) {
            try {
                void electronAPI?.acgmho?.cancelFetchPages?.(
                    probeResult.firstPageUrl || probeResult.gid,
                    runId ?? undefined
                );
            } catch { /* ignore */ }
            try {
                void electronAPI?.acgmho?.cancelDownload?.(probeResult.gid);
            } catch { /* ignore */ }
        }
        setProbeResult(null);
        setProgress(null);
        setFetchProgress(null);
        setFailedPages([]);
        setError(null);
        setIsFetchingPages(false);
        setIsDownloading(false);
        setPageRange('');
        removeStored('gallery-detail');
        removeStored('gallery-failed');
    }, [probeResult]);

    // actions 容器 memo：调用方按单个函数解构订阅，避免整包依赖导致回调连锁失效
    const detailActions = useMemo(
        () => ({
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
        }),
        [
            probe,
            startDownload,
            cancelDownload,
            fetchPages,
            retryFailedPages,
            cancelFetchPages,
            openFolder,
            reset,
        ]
    );

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
        },
        actions: detailActions,
    };
};
