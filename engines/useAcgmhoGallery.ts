import { useState, useCallback, useEffect, useRef } from 'react';
import {
  AcgmhoChannelDef,
  AcgmhoGalleryItem,
  getElectronAPI,
} from '../meta';
import { loadJSON, saveJSON } from '../utils/persist';

interface ChannelCache {
  items: AcgmhoGalleryItem[];
  page: number;
  hasMore: boolean;
}

interface StoredCacheEntry extends ChannelCache {
  ts: number;
}

// 画廊缓存落盘：重进 App 直接显示上次刷好的封面，后台静默刷新第一页补新
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
      map.set(id, { items: entry.items.slice(0, GALLERY_CACHE_ITEMS), page: entry.page || 1, hasMore: entry.hasMore !== false });
    }
  } catch {
    // 坏缓存直接丢，用 fresh
  }
  return map;
}

function storeCache(map: Map<string, ChannelCache>): void {
  const raw: Record<string, StoredCacheEntry> = {};
  for (const [id, entry] of map) {
    raw[id] = { items: entry.items.slice(0, GALLERY_CACHE_ITEMS), page: entry.page, hasMore: entry.hasMore, ts: Date.now() };
  }
  saveJSON('gallery-cache', raw);
}

/**
 * useAcgmhoGallery — 内置浏览画廊的数据层。
 * 频道秒切：每个频道首屏缓存在 ref 里，切回去不重新请求；
 * 翻页追加按 gid 去重；isElectron 为 false（纯浏览器）时直接报环境错，
 * 不发请求（渲染层 fetch 会撞 CORS）。
 */
export const useAcgmhoGallery = () => {
  const [channels, setChannels] = useState<AcgmhoChannelDef[]>([]);
  const [channelId, setChannelId] = useState<string>('latest');
  const [items, setItems] = useState<AcgmhoGalleryItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cacheRef = useRef<Map<string, ChannelCache>>(loadStoredCache());
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  const loadingRef = useRef(false);
  // 落盘写全部频道快照（读 ref + 写盘，不碰 state，不会循环）
  const persistCache = useCallback(() => {
    storeCache(cacheRef.current);
  }, []);

  const isElectron = Boolean(getElectronAPI()?.acgmho?.channelList);

  // 频道表：主进程唯一源，失败时用内置兜底保证画廊骨架永远能渲染
  useEffect(() => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.acgmho?.channels) return;
    let cancelled = false;
    electronAPI.acgmho.channels()
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length > 0) setChannels(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const loadPage = useCallback(async (targetChannel: string, targetPage: number, append: boolean, silent = false) => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.acgmho?.channelList) {
      setError('当前环境不支持浏览画廊，请在 Electron 桌面端中运行');
      return;
    }
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (append) setIsLoadingMore(true);
    else if (!silent) {
      setIsLoading(true);
      setError(null);
      setItems([]);
    }
    try {
      const res = await electronAPI.acgmho.channelList({ channelId: targetChannel, page: targetPage });
      if (channelIdRef.current !== targetChannel) return;
      if (!res.success) {
        setError(res.message || '列表加载失败');
        return;
      }
      const incoming = res.items || [];
      setItems((prev) => {
        // 静默补新：不清旧列表，新货置顶、旧页保留，做并集
        if (silent && prev.length > 0 && !append) {
          const seen = new Set(incoming.map((i) => i.gid));
          const merged = [...incoming];
          for (const it of prev) {
            if (!seen.has(it.gid)) {
              seen.add(it.gid);
              merged.push(it);
            }
          }
          const cachedPrev = cacheRef.current.get(targetChannel);
          cacheRef.current.set(targetChannel, { items: merged, page: Math.max(targetPage, cachedPrev?.page ?? 1), hasMore: res.hasMore });
          return merged;
        }
        const base = append ? prev : [];
        const seen = new Set(base.map((i) => i.gid));
        const merged = [...base];
        for (const it of incoming) {
          if (!seen.has(it.gid)) {
            seen.add(it.gid);
            merged.push(it);
          }
        }
        cacheRef.current.set(targetChannel, { items: merged, page: targetPage, hasMore: res.hasMore });
        return merged;
      });
      setPage(targetPage);
      setHasMore(res.hasMore);
      persistCache();
    } catch (err: any) {
      if (channelIdRef.current === targetChannel) {
        setError(err?.message || '列表加载失败，请检查网络');
      }
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [persistCache]);

  const selectChannel = useCallback((id: string) => {
    setChannelId(id);
    setError(null);
    const cached = cacheRef.current.get(id);
    if (cached) {
      setItems(cached.items);
      setPage(cached.page);
      setHasMore(cached.hasMore);
      return;
    }
    void loadPage(id, 1, false);
  }, [loadPage]);

  const loadMore = useCallback(() => {
    const cached = cacheRef.current.get(channelIdRef.current);
    const nextPage = (cached?.page ?? page) + 1;
    void loadPage(channelIdRef.current, nextPage, true);
  }, [loadPage, page]);

  const refresh = useCallback(() => {
    cacheRef.current.delete(channelIdRef.current);
    persistCache();
    void loadPage(channelIdRef.current, 1, false);
  }, [loadPage, persistCache]);

  // 首屏：落盘有 latest 就秒显旧封面，后台静默刷第一页补新；没有才转圈等
  useEffect(() => {
    if (!isElectron) return;
    const cached = cacheRef.current.get('latest');
    if (cached && cached.items.length > 0) {
      setItems(cached.items);
      setPage(cached.page);
      setHasMore(cached.hasMore);
      // 静默补新：不清列表、不转圈，到了自动合并
      void loadPage('latest', 1, false, true);
      return;
    }
    void loadPage('latest', 1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isElectron]);

  return {
    state: {
      channels,
      channelId,
      items,
      page,
      hasMore,
      isLoading,
      isLoadingMore,
      error,
      isElectron,
    },
    actions: {
      selectChannel,
      loadMore,
      refresh,
    },
  };
};
