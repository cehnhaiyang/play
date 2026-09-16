import React, { useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Film,
  Globe,
  Headphones,
  Image as ImageIcon,
  Layers,
  Play,
  Radio,
  RefreshCw,
  Search,
  Sparkles,
  Star,
} from 'lucide-react';
import { useAcgmhoGallery } from '../../engines';
import type { AcgmhoGalleryItem } from '../../meta';
import { isAcgUrl } from '../../utils';

interface GalleryBrowseProps {
  currentUrl?: string;
  onOpenItem: (url: string) => void;
}

const CHANNEL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  latest: Sparkles,
  hot: Star,
  manga: BookOpen,
  album: Layers,
  animation: Film,
  hanime: Play,
  asmr: Headphones,
  cosplay: ImageIcon,
  webtoon: Globe,
  western: Radio,
};

const KIND_META: Record<AcgmhoGalleryItem['kind'], { label: string; icon: React.ComponentType<{ className?: string }>; pill: string }> = {
  image: { label: '图文', icon: BookOpen, pill: 'border-emerald-400/30 bg-emerald-500/15 text-emerald-200' },
  video: { label: '视频', icon: Film, pill: 'border-indigo-400/30 bg-indigo-500/15 text-indigo-200' },
  audio: { label: '有声', icon: Headphones, pill: 'border-cyan-400/30 bg-cyan-500/15 text-cyan-200' },
};

const itemMetaLine = (item: AcgmhoGalleryItem): string => {
  const parts = [item.date, item.lang || item.tag, item.duration || item.pages, item.views ? `${item.views}👁` : ''].filter(Boolean);
  return parts.join(' · ');
};

const GalleryCard: React.FC<{ item: AcgmhoGalleryItem; onOpen: (url: string) => void }> = ({ item, onOpen }) => {
  const [imgFailed, setImgFailed] = useState(false);
  const kind = KIND_META[item.kind] || KIND_META.image;
  const KindIcon = kind.icon;

  return (
    <button
      type="button"
      onClick={() => onOpen(item.url)}
      className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5 text-left transition-all duration-200 hover:border-rose-400/40 hover:shadow-[0_8px_30px_rgba(244,63,94,0.15)] hover:-translate-y-0.5"
      title={item.title}
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-slate-900">
        {!imgFailed && item.cover ? (
          <img
            src={item.cover}
            alt={item.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-800 to-slate-900 p-3 text-center">
            <BookOpen className="h-8 w-8 text-slate-600" />
            <span className="line-clamp-3 text-[11px] text-slate-400">{item.title}</span>
          </div>
        )}

        {/* 类型徽标 */}
        <span className={`absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold backdrop-blur-md ${kind.pill}`}>
          <KindIcon className="h-3 w-3" />
          {kind.label}
        </span>
        {item.duration && (
          <span className="absolute right-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white backdrop-blur-md">
            {item.duration}
          </span>
        )}

        {/* 悬停：查看详情 */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="rounded-full bg-white/15 px-4 py-1.5 text-xs font-bold text-white backdrop-blur-md border border-white/25">
            查看详情 →
          </span>
        </div>
      </div>

      <div className="p-2">
        <div className="line-clamp-2 min-h-[2.2em] text-xs font-medium leading-5 text-zinc-100">
          {item.title}
        </div>
        <div className="mt-1 truncate text-[10px] text-zinc-500">
          {itemMetaLine(item) || `#${item.gid}`}
        </div>
      </div>
    </button>
  );
};

const SkeletonGrid: React.FC = () => (
  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
    {Array.from({ length: 6 }).map((_, i) => (
      <div key={i} className="overflow-hidden rounded-xl border border-white/8 bg-white/4">
        <div className="aspect-[3/4] w-full animate-pulse bg-white/8" />
        <div className="space-y-1.5 p-2">
          <div className="h-3 animate-pulse rounded bg-white/10" />
          <div className="h-2 w-2/3 animate-pulse rounded bg-white/8" />
        </div>
      </div>
    ))}
  </div>
);

export const GalleryBrowse: React.FC<GalleryBrowseProps> = ({ currentUrl = '', onOpenItem }) => {
  const { state, actions } = useAcgmhoGallery();
  const { channels, channelId, items, hasMore, isLoading, isLoadingMore, error, isElectron } = state;
  const [query, setQuery] = useState('');

  const isAcgmhoPage = isAcgUrl(currentUrl);

  const submitQuery = () => {
    const t = query.trim();
    if (t) onOpenItem(t);
  };

  if (!isElectron) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-zinc-400">
        内置浏览画廊仅在 Electron 桌面端可用（浏览器直连会撞跨域），请用桌面版打开。
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 搜索直达 */}
      <div className="flex shrink-0 items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitQuery()}
            placeholder="作品 ID / 详情页链接直达，如 761277…"
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 pl-9 text-sm text-slate-100 placeholder-slate-500 transition-all focus:border-rose-400/50 focus:outline-none focus:ring-2 focus:ring-rose-500/20"
          />
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
        </div>
        <button
          onClick={submitQuery}
          disabled={!query.trim()}
          className="rounded-xl bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-2 text-xs font-bold text-white shadow-lg transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
        >
          直达
        </button>
        <button
          onClick={() => actions.refresh()}
          disabled={isLoading}
          className="rounded-xl border border-white/10 bg-white/5 p-2 text-zinc-400 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
          title="刷新当前频道"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {isAcgmhoPage && (
        <button
          onClick={() => onOpenItem(currentUrl)}
          className="flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-200 transition hover:bg-rose-500/20"
        >
          <Globe className="h-3.5 w-3.5" />
          检测到当前正是漫画详情页，点击直接打开
        </button>
      )}

      {/* 频道分类 */}
      <div className="flex shrink-0 gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
        {(channels.length > 0 ? channels : [{ id: 'latest', label: '最新', base: '/', kind: 'image' as const }]).map((ch) => {
          const Icon = CHANNEL_ICONS[ch.id] || Layers;
          const active = ch.id === channelId;
          return (
            <button
              key={ch.id}
              onClick={() => actions.selectChannel(ch.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all ${
                active
                  ? 'bg-gradient-to-r from-rose-500 to-amber-500 text-white shadow-lg'
                  : 'border border-white/10 bg-white/5 text-zinc-400 hover:border-white/20 hover:bg-white/10 hover:text-white'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {ch.label}
            </button>
          );
        })}
      </div>

      {/* 错误条 */}
      {error && !isLoading && (
        <div className="flex shrink-0 items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <div className="flex-1 leading-relaxed">{error}</div>
          <button onClick={() => actions.refresh()} className="shrink-0 font-bold text-rose-300 hover:text-white">
            重试
          </button>
        </div>
      )}

      {/* 封面流 */}
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
        {isLoading && items.length === 0 ? (
          <SkeletonGrid />
        ) : items.length === 0 ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-sm text-zinc-500">
            <BookOpen className="h-8 w-8 opacity-40" />
            该频道暂无内容，换个频道或点右上刷新试试
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {items.map((item) => (
              <GalleryCard key={`${item.channel}-${item.gid}`} item={item} onOpen={onOpenItem} />
            ))}
          </div>
        )}
      </div>

      {/* 翻页 */}
      <div className="flex shrink-0 items-center justify-center gap-2 text-xs text-zinc-500">
        {hasMore ? (
          <button
            onClick={() => actions.loadMore()}
            disabled={isLoadingMore}
            className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-5 py-2 font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            {isLoadingMore && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
            {isLoadingMore ? '加载中…' : `加载更多（第 ${items.length} 项）`}
          </button>
        ) : (
          items.length > 0 && <span>— 到底了，共 {items.length} 项 —</span>
        )}
      </div>
    </div>
  );
};
