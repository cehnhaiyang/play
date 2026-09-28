import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle,
    ArrowLeft,
    BookOpen,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    ExternalLink,
    Film,
    Flame,
    FolderOpen,
    Globe,
    Headphones,
    Image as ImageIcon,
    Layers,
    Play,
    Radio,
    RefreshCw,
    RotateCw,
    Search,
    Sparkles,
    Star,
    X,
} from 'lucide-react';
import {
    useAcgmho,
    useAcgmhoGallery,
    useAcgDownloads,
    bindSaveFileSync,
    acgTaskKeyOf,
} from '../../hooks';
import type { AcgSaveTask } from '../../hooks';
import type { AcgmhoGalleryItem, GalleryPageItem, MediaType } from '../../meta';
import { isAcgUrl, resolveProbeMedia } from '../../utils/utils';

/* -------------------------------------------------------------------------- */
/*                                Types & Props                               */
/* -------------------------------------------------------------------------- */

export interface GalleryPanelProps {
    onBack: () => void;
    currentUrl?: string;
    onBrowseInPlayer?: (gallery: {
        title: string;
        gid?: string;
        pages: { url: string; title: string; page?: number }[];
    }) => void;
    // 纯媒体直推（视频 / 音频）：调用方把条目直接进播放列表，不建画廊分组。
    // mediaType 必须原样带过去：ACG 音声作品的「音轨」是 HLS（.m3u8）地址，
    // 下游若按 URL 重新推断只会看到 .m3u8，会把 mp3 音轨判成流媒体、
    // 进而被播放器的「视频」筛选吞掉。类型由探测结果决定，不由扩展名决定。
    onPlayMediaStreams?: (pages: { url: string; title: string; mediaType?: MediaType }[]) => void;
    onAppendToPlayer?: (
        pages: { url: string; title: string; page?: number }[],
        gid?: string
    ) => void;
    onMergeToPlayer?: (
        pages: { url: string; title: string; page?: number }[],
        gid?: string
    ) => void;
}

/* -------------------------------------------------------------------------- */
/*                              Constants & Meta                              */
/* -------------------------------------------------------------------------- */

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

const KIND_META: Record<
    AcgmhoGalleryItem['kind'],
    { label: string; icon: React.ComponentType<{ className?: string }>; pill: string }
> = {
    image: {
        label: '图文',
        icon: BookOpen,
        pill: 'border-emerald-400/30 bg-emerald-500/15 text-emerald-200',
    },
    video: {
        label: '视频',
        icon: Film,
        pill: 'border-indigo-400/30 bg-indigo-500/15 text-indigo-200',
    },
    audio: {
        label: '有声',
        icon: Headphones,
        pill: 'border-cyan-400/30 bg-cyan-500/15 text-cyan-200',
    },
};

const formatItemMeta = (item: AcgmhoGalleryItem): string => {
    const parts = [
        item.date,
        item.lang || item.tag,
        item.duration || item.pages,
        item.views ? `${item.views} 浏览` : '',
    ].filter(Boolean);
    return parts.join(' · ');
};

// 流式批量缓冲器：服务端 5 并发导致 item 乱序到达，攒批（20 页或 500ms）排序后一次性交付。
// 避免每页一次 setPlaylist（全量拷贝 + 全列表重渲染，200 页即 200 次重渲染直接卡死）。
// 泛型尾逗号：tsx 里 <T> 会被当成 JSX，必须写成 <T,>
const createBatchFlusher = <T,>(
    onFlush: (batch: T[]) => void,
    compare: (a: T, b: T) => number,
    maxBatch = 20,
    intervalMs = 500
): { push: (item: T) => void; flush: () => void } => {
    const pending: T[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (pending.length === 0) return;
        pending.sort(compare);
        onFlush(pending.splice(0, pending.length));
    };
    return {
        push: (item: T) => {
            pending.push(item);
            if (pending.length >= maxBatch) {
                flush();
                return;
            }
            if (!timer) timer = setTimeout(flush, intervalMs);
        },
        flush,
    };
};

// 页码范围是否包含指定页：与主进程 parsePageRange 同语义（all/空=全选，支持倒写与空格）
const rangeIncludesPage = (range: string, page: number): boolean => {
    const spec = (range || '').trim().toLowerCase();
    if (!spec || spec === 'all') return true;
    for (const chunk of spec.split(',')) {
        const t = chunk.trim();
        if (!t) continue;
        if (t.includes('-')) {
            const [a, b] = t.split('-').map((s) => parseInt(s.trim(), 10));
            if (Number.isFinite(a) && Number.isFinite(b)) {
                if (page >= Math.min(a, b) && page <= Math.max(a, b)) return true;
            }
        } else {
            if (parseInt(t, 10) === page) return true;
        }
    }
    return false;
};

/* -------------------------------------------------------------------------- */
/*                     Subcomponent: SaveTaskRow                              */
/* -------------------------------------------------------------------------- */

const SaveTaskRow = memo<{
    task: AcgSaveTask;
    onCancel: (gid: string) => void;
    onOpen: (outDir?: string) => void;
    onDismiss: (gid: string) => void;
}>(({ task, onCancel, onOpen, onDismiss }) => {
    const saving = task.status === 'saving';

    return (
        <div className="flex flex-col gap-1.5 rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 transition-colors hover:border-white/20">
            <div className="flex items-center justify-between gap-2 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                    {saving ? (
                        <RotateCw className="h-3.5 w-3.5 shrink-0 animate-spin text-rose-400" />
                    ) : task.status === 'completed' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    ) : (
                        <AlertCircle
                            className={`h-3.5 w-3.5 shrink-0 ${task.status === 'error' ? 'text-rose-400' : 'text-amber-400'
                                }`}
                        />
                    )}
                    <span className="truncate font-semibold text-slate-200" title={task.title}>
                        {task.title}
                    </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <span className="font-mono text-[11px] font-bold text-rose-300">
                        {task.doneFiles}/{task.totalFiles}
                    </span>
                    {saving ? (
                        <button
                            type="button"
                            onClick={() => onCancel(task.gid)}
                            className="rounded-md px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-white/10 hover:text-rose-300 transition"
                            title="取消保存"
                        >
                            取消
                        </button>
                    ) : (
                        <>
                            {task.outDir && (
                                <button
                                    type="button"
                                    onClick={() => onOpen(task.outDir)}
                                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/10 transition"
                                    title="打开保存目录"
                                >
                                    <FolderOpen className="h-3 w-3" />
                                    打开
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => onDismiss(task.gid)}
                                className="rounded-md p-0.5 text-slate-500 hover:bg-white/10 hover:text-white transition"
                                title="从列表移除"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </>
                    )}
                </div>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                    className={`h-full transition-all duration-300 ${task.status === 'completed'
                            ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                            : task.status === 'error'
                                ? 'bg-rose-600'
                                : 'bg-gradient-to-r from-rose-500 via-pink-500 to-amber-400'
                        }`}
                    style={{ width: `${Math.min(100, Math.max(0, task.percent))}%` }}
                />
            </div>
            {task.message && (
                <div className="truncate text-[10px] text-slate-500" title={task.message}>
                    {task.message}
                </div>
            )}
        </div>
    );
});

SaveTaskRow.displayName = 'SaveTaskRow';

/* -------------------------------------------------------------------------- */
/*                  Subcomponent: SaveTasksSection (可折叠)                   */
/* -------------------------------------------------------------------------- */

const SaveTasksSection = memo<{
    tasks: AcgSaveTask[];
    onCancel: (gid: string) => void;
    onOpen: (outDir?: string) => void;
    onDismiss: (gid: string) => void;
}>(({ tasks, onCancel, onOpen, onDismiss }) => {
    const [isExpanded, setIsExpanded] = useState(false);

    const activeCount = tasks.filter((t) => t.status === 'saving').length;
    // 有进行中任务时自动展开（0→N 跃迁才触发）：默认收起会让后台进度完全不可见；
    // 只订阅布尔翻转，用户中途手动收起后不再打扰
    const hasActive = activeCount > 0;
    useEffect(() => {
        if (hasActive) setIsExpanded(true);
    }, [hasActive]);

    if (tasks.length === 0) return null;

    return (
        <div className="flex shrink-0 flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-2.5 backdrop-blur-md">
            <div className="flex items-center justify-between">
                <button
                    type="button"
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="flex items-center gap-2 text-xs font-semibold text-zinc-300 transition hover:text-white"
                >
                    <FolderOpen className="h-4 w-4 text-rose-400" />
                    <span>全本保存任务</span>
                    <span className="rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] font-bold text-rose-300 border border-rose-500/30">
                        {tasks.length}
                    </span>
                    {activeCount > 0 && (
                        <span className="flex items-center gap-1 text-[11px] text-amber-300">
                            <RotateCw className="h-3 w-3 animate-spin" />
                            {activeCount} 个进行中
                        </span>
                    )}
                    {isExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5 text-zinc-400" />
                    ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
                    )}
                </button>
            </div>

            {isExpanded && (
                <div className="mt-2.5 flex flex-col gap-2 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
                    {tasks.map((task) => (
                        <SaveTaskRow
                            key={task.gid}
                            task={task}
                            onCancel={onCancel}
                            onOpen={onOpen}
                            onDismiss={onDismiss}
                        />
                    ))}
                </div>
            )}
        </div>
    );
});

SaveTasksSection.displayName = 'SaveTasksSection';

/* -------------------------------------------------------------------------- */
/*                     Subcomponent: GalleryCard                              */
/* -------------------------------------------------------------------------- */

const GalleryCard = memo<{
    item: AcgmhoGalleryItem;
    onOpen: (url: string) => void;
}>(({ item, onOpen }) => {
    const [imgFailed, setImgFailed] = useState(false);
    const kind = KIND_META[item.kind] || KIND_META.image;
    const KindIcon = kind.icon;
    // 封面变更时重置失败态：复用卡片（key 碰撞/缓存更新）时旧的失败占位会一直盖住新图
    useEffect(() => {
        setImgFailed(false);
    }, [item.cover]);

    const handleClick = useCallback(() => {
        onOpen(item.url);
    }, [item.url, onOpen]);

    return (
        <button
            type="button"
            onClick={handleClick}
            // content-visibility：屏外卡片跳过布局与绘制，600 项长列表滚动不再掉帧
            style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 320px' }}
            className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5 text-left transition-all duration-200 hover:border-rose-400/40 hover:shadow-[0_8px_30px_rgba(244,63,94,0.15)] hover:-translate-y-0.5 contain-content"
            title={item.title}
        >
            <div className="relative aspect-[3/4] w-full overflow-hidden bg-slate-900">
                {!imgFailed && item.cover ? (
                    <img
                        src={item.cover}
                        alt={item.title}
                        loading="lazy"
                        decoding="async"
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
                <span
                    className={`absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold backdrop-blur-md ${kind.pill}`}
                >
                    <KindIcon className="h-3 w-3" />
                    {kind.label}
                </span>
                {item.duration && (
                    <span className="absolute right-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white backdrop-blur-md">
                        {item.duration}
                    </span>
                )}

                {/* 悬停动作 */}
                <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                    <span className="rounded-full border border-white/25 bg-white/15 px-4 py-1.5 text-xs font-bold text-white backdrop-blur-md">
                        查看详情 →
                    </span>
                </div>
            </div>

            <div className="p-2.5">
                <div className="line-clamp-2 min-h-[2.2em] text-xs font-medium leading-5 text-zinc-100 group-hover:text-rose-200 transition-colors">
                    {item.title}
                </div>
                <div className="mt-1 truncate text-[10px] text-zinc-500">
                    {formatItemMeta(item) || `#${item.gid}`}
                </div>
            </div>
        </button>
    );
});

GalleryCard.displayName = 'GalleryCard';

/* -------------------------------------------------------------------------- */
/*                     Subcomponent: GalleryGrid（memo 隔离）                  */
/* -------------------------------------------------------------------------- */

// 网格独立 memo：搜索输入时 BrowseSection 重渲染，网格凭 items 引用 + onOpen 身份跳过 diff
const GalleryGrid = memo<{
    items: AcgmhoGalleryItem[];
    onOpen: (url: string) => void;
}>(({ items, onOpen }) => (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {items.map((item) => (
            <GalleryCard
                key={`${item.channel}-${item.prefix}-${item.gid}`}
                item={item}
                onOpen={onOpen}
            />
        ))}
    </div>
));

GalleryGrid.displayName = 'GalleryGrid';

/* -------------------------------------------------------------------------- */
/*                   Subcomponent: GallerySkeletonGrid                        */
/* -------------------------------------------------------------------------- */

const SkeletonGrid = memo(() => (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-white/8 bg-white/4">
                <div className="aspect-[3/4] w-full animate-pulse bg-white/8" />
                <div className="space-y-1.5 p-2.5">
                    <div className="h-3 animate-pulse rounded bg-white/10" />
                    <div className="h-2 w-2/3 animate-pulse rounded bg-white/8" />
                </div>
            </div>
        ))}
    </div>
));

SkeletonGrid.displayName = 'SkeletonGrid';

/* -------------------------------------------------------------------------- */
/*                     Subcomponent: BrowseSection                            */
/* -------------------------------------------------------------------------- */

interface BrowseSectionProps {
    currentUrl: string;
    onOpenItem: (url: string) => void;
    galleryState: ReturnType<typeof useAcgmhoGallery>['state'];
    galleryActions: ReturnType<typeof useAcgmhoGallery>['actions'];
    tasks: AcgSaveTask[];
    downloadActions: ReturnType<typeof useAcgDownloads>['actions'];
}

const BrowseSection: React.FC<BrowseSectionProps> = ({
    currentUrl,
    onOpenItem,
    galleryState,
    galleryActions,
    tasks,
    downloadActions,
}) => {
    const { channels, channelId, searchKeyword, items, hasMore, isLoading, isLoadingMore, error } =
        galleryState;
    const [query, setQuery] = useState(searchKeyword || '');

    // 外部切换频道/清空搜索时，输入框跟随归位（输入过程不触发 searchKeyword 变化，不会打断打字）
    useEffect(() => {
        setQuery(searchKeyword || '');
    }, [searchKeyword]);

    // 无限滚动哨兵：触底前 600px 自动追加，底部按钮保留作手动兜底。
    // 回调闭包带 hasMore/isLoading* 快照，状态翻转即重绑，保证判断永远新鲜；
    // 并发与触底短路由 hook 内 loadingMoreRef 与 hasMore 守卫承担
    const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = loadMoreSentinelRef.current;
        if (!el || !hasMore || isLoading || isLoadingMore) return;
        const io = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting) galleryActions.loadMore();
            },
            { rootMargin: '600px' }
        );
        io.observe(el);
        return () => io.disconnect();
    }, [galleryActions, hasMore, isLoading, isLoadingMore]);

    const isAcgmhoPage = useMemo(() => isAcgUrl(currentUrl), [currentUrl]);

    const handleSearch = useCallback(() => {
        const t = query.trim();
        // 如果输入的是具体的直达 URL，直接进入详情
        if (/^https?:\/\//i.test(t)) {
            onOpenItem(t);
            return;
        }
        galleryActions.search(t);
    }, [query, onOpenItem, galleryActions]);

    const handleClearSearch = useCallback(() => {
        setQuery('');
        galleryActions.selectChannel('latest');
    }, [galleryActions]);

    return (
        <div className="flex h-full min-h-0 flex-col gap-4">
            {/* 顶层功能条：搜索与刷新 */}
            <div className="flex shrink-0 items-center gap-3">
                <div className="relative flex-1 max-w-xl">
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                        placeholder="搜索漫画、图集、作者或关键词（如：老师、学生、中文、纯爱）…"
                        className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 pl-9 pr-8 text-sm text-slate-100 placeholder-slate-500 transition-all focus:border-rose-400/50 focus:outline-none focus:ring-2 focus:ring-rose-500/20"
                    />
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
                    {query && (
                        <button
                            type="button"
                            onClick={handleClearSearch}
                            className="absolute right-2.5 top-2.5 p-0.5 text-slate-500 hover:text-white transition"
                            title="清空搜索"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
                <button
                    type="button"
                    onClick={handleSearch}
                    disabled={!query.trim()}
                    className="rounded-xl bg-gradient-to-r from-rose-500 to-amber-500 px-5 py-2 text-xs font-bold text-white shadow-lg shadow-rose-500/20 transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
                >
                    搜索
                </button>
                <button
                    type="button"
                    onClick={() => galleryActions.refresh()}
                    disabled={isLoading}
                    className="rounded-xl border border-white/10 bg-white/5 p-2 text-zinc-400 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
                    title="刷新当前内容"
                >
                    <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* 当前页面快捷检测 */}
            {isAcgmhoPage && (
                <button
                    type="button"
                    onClick={() => onOpenItem(currentUrl)}
                    className="flex shrink-0 items-center justify-between rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-200 transition hover:bg-rose-500/20"
                >
                    <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-rose-400" />
                        <span>检测到当前嗅探标签页为漫画详情页，点击立即载入</span>
                    </div>
                    <span className="font-semibold text-rose-300">立即解析 →</span>
                </button>
            )}

            {/* 全局保存任务栏（可折叠） */}
            <SaveTasksSection
                tasks={tasks}
                onCancel={downloadActions.cancelSave}
                onOpen={downloadActions.openFolder}
                onDismiss={downloadActions.dismissTask}
            />

            {/* 频道分类横向导航 */}
            <div className="flex shrink-0 gap-2 overflow-x-auto pb-1 scrollbar-thin items-center">
                {channelId === 'search' && searchKeyword && (
                    <div className="flex shrink-0 items-center gap-1.5 rounded-xl bg-rose-500/20 border border-rose-500/40 px-3 py-1.5 text-xs text-rose-300 font-semibold">
                        <Search className="h-3.5 w-3.5" />
                        <span>搜索: 「{searchKeyword}」</span>
                        <button
                            type="button"
                            onClick={handleClearSearch}
                            className="ml-1 rounded p-0.5 hover:bg-rose-500/30 text-rose-200 hover:text-white"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    </div>
                )}
                {(channels.length > 0
                    ? channels
                    : [{ id: 'latest', label: '最新', base: '/', kind: 'image' as const }]
                ).map((ch) => {
                    const Icon = CHANNEL_ICONS[ch.id] || Layers;
                    const active = ch.id === channelId;
                    return (
                        <button
                            key={ch.id}
                            type="button"
                            onClick={() => galleryActions.selectChannel(ch.id)}
                            className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-all ${active
                                    ? 'bg-gradient-to-r from-rose-500 to-amber-500 text-white shadow-lg shadow-rose-500/25'
                                    : 'border border-white/10 bg-white/5 text-zinc-400 hover:border-white/20 hover:bg-white/10 hover:text-white'
                                }`}
                        >
                            <Icon className="h-4 w-4" />
                            {ch.label}
                        </button>
                    );
                })}
            </div>

            {/* 错误提示栏 */}
            {error && !isLoading && (
                <div className="flex shrink-0 items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                    <div className="flex-1 leading-relaxed">{error}</div>
                    <button
                        type="button"
                        onClick={() => galleryActions.refresh()}
                        className="shrink-0 font-bold text-rose-300 hover:text-white"
                    >
                        重试
                    </button>
                </div>
            )}

            {/* 封面瀑布流 / 虚拟网格区 */}
            <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
                {isLoading && items.length === 0 ? (
                    <SkeletonGrid />
                ) : items.length === 0 ? (
                    <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 text-sm text-zinc-500">
                        <BookOpen className="h-10 w-10 opacity-30" />
                        <span>{channelId === 'search' ? `未找到与「${searchKeyword}」相关的作品` : '该频道暂无内容，请切换频道或点击刷新'}</span>
                    </div>
                ) : (
                    <GalleryGrid items={items} onOpen={onOpenItem} />
                )}
                {/* 无限滚动哨兵：滚到此处前 600px 自动加载更多 */}
                <div ref={loadMoreSentinelRef} className="h-1 w-full shrink-0" aria-hidden="true" />
            </div>

            {/* 分页加载更多 */}
            <div className="flex shrink-0 items-center justify-center py-2 text-xs text-zinc-500">
                {hasMore ? (
                    <button
                        type="button"
                        onClick={() => galleryActions.loadMore()}
                        disabled={isLoadingMore}
                        className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-6 py-2.5 font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
                    >
                        {isLoadingMore && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                        {isLoadingMore ? '正在加载更多…' : `加载更多（已载入 ${items.length} 项）`}
                    </button>
                ) : (
                    items.length > 0 && <span>— 已加载全部作品，共 {items.length} 项 —</span>
                )}
            </div>
        </div>
    );
};

/* -------------------------------------------------------------------------- */
/*                     Subcomponent: DetailSection                            */
/* -------------------------------------------------------------------------- */

interface DetailSectionProps {
    probeResult: NonNullable<ReturnType<typeof useAcgmho>['state']['probeResult']>;
    pageRange: string;
    delayMs: number;
    isFetchingPages: boolean;
    fetchProgress: ReturnType<typeof useAcgmho>['state']['fetchProgress'];
    failedPages: ReturnType<typeof useAcgmho>['state']['failedPages'];
    currentTask?: AcgSaveTask;
    onBack: () => void;
    onSetPageRange: (range: string) => void;
    onSetDelayMs: (delay: number) => void;
    onWatchAndSave: () => void;
    onCancelFetch: () => void;
    onRetryFailed: () => void;
    downloadActions: ReturnType<typeof useAcgDownloads>['actions'];
}

const DetailSection: React.FC<DetailSectionProps> = ({
    probeResult,
    pageRange,
    delayMs,
    isFetchingPages,
    fetchProgress,
    failedPages,
    currentTask,
    onBack,
    onSetPageRange,
    onSetDelayMs,
    onWatchAndSave,
    onCancelFetch,
    onRetryFailed,
    downloadActions,
}) => {
    const watchButtonText = useMemo(() => {
        if (isFetchingPages) return '载入中...';
        if (probeResult.category === 'animation') return '播放动画';
        if (probeResult.category === 'asmr') return '播放音声';
        if (probeResult.isAnimated) return '边下边播动图';
        return '边下边播';
    }, [isFetchingPages, probeResult.category, probeResult.isAnimated]);

    return (
        <div className="flex h-full flex-col gap-5 overflow-y-auto pr-1 text-slate-200 custom-scrollbar max-w-5xl mx-auto w-full">
            {/* 详情头部导航 */}
            <div className="flex shrink-0 items-center justify-between border-b border-white/10 pb-3">
                <button
                    type="button"
                    onClick={onBack}
                    className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/10 hover:text-white"
                >
                    <ArrowLeft className="h-4 w-4" />
                    返回画廊列表
                </button>
                <span className="text-xs text-zinc-400">
                    全本抓取并自动归档至本地，支持同步推送至播放器
                </span>
            </div>

            {/* 作品详情与解析卡片 */}
            <div className="flex flex-col gap-5 rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur-md">
                <div className="flex gap-6">
                    {/* 封面预览 */}
                    <div className="relative h-44 w-32 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-md">
                        {probeResult.firstImgUrl ? (
                            <img
                                src={probeResult.firstImgUrl}
                                alt={probeResult.title}
                                className="h-full w-full object-cover"
                                loading="lazy"
                                decoding="async"
                                referrerPolicy="no-referrer"
                            />
                        ) : (
                            <div className="flex h-full w-full items-center justify-center text-slate-600">
                                <BookOpen className="h-10 w-10" />
                            </div>
                        )}
                        <div className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white">
                            P1
                        </div>
                    </div>

                    {/* 详情与元信息 */}
                    <div className="flex flex-1 flex-col justify-between">
                        <div>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded-md border border-rose-400/30 bg-rose-500/10 px-2.5 py-0.5 text-xs font-bold text-rose-300">
                                    ID: {probeResult.gid}
                                </span>
                                {probeResult.category === 'animation' ? (
                                    <span className="inline-flex items-center gap-1 rounded-md border border-indigo-400/30 bg-indigo-500/10 px-2.5 py-0.5 text-xs font-bold text-indigo-300">
                                        <Film className="h-3.5 w-3.5" />
                                        动画视频 (HLS)
                                    </span>
                                ) : probeResult.category === 'asmr' ? (
                                    <span className="inline-flex items-center gap-1 rounded-md border border-cyan-400/30 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-bold text-cyan-300">
                                        <Headphones className="h-3.5 w-3.5" />
                                        有声音声 / ASMR
                                    </span>
                                ) : probeResult.isAnimated ? (
                                    <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-bold text-amber-300">
                                        <Flame className="h-3.5 w-3.5" />
                                        动图图集 (WebP/GIF)
                                    </span>
                                ) : (
                                    <span className="inline-flex items-center gap-1 rounded-md border border-sky-400/30 bg-sky-500/10 px-2.5 py-0.5 text-xs font-bold text-sky-300">
                                        <BookOpen className="h-3.5 w-3.5" />
                                        漫画共 {probeResult.totalPages} 页
                                    </span>
                                )}
                                <span className="rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-bold text-emerald-300">
                                    /{probeResult.prefix}/
                                </span>
                            </div>

                            <h2
                                className="mt-3 text-base font-bold leading-relaxed text-white"
                                title={probeResult.title}
                            >
                                {probeResult.title}
                            </h2>
                        </div>

                        <div className="flex items-center gap-3 pt-3 text-xs text-slate-400">
                            <a
                                href={probeResult.firstPageUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="flex items-center gap-1.5 text-xs text-slate-400 transition-colors hover:text-white"
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                <span>在浏览器中访问原网页</span>
                            </a>
                        </div>
                    </div>
                </div>

                {/* 抓取配置与控制 */}
                <div className="flex flex-col gap-4 border-t border-white/10 pt-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="mb-1.5 block text-xs font-semibold text-slate-300">
                                抓取页码范围
                            </label>
                            <input
                                type="text"
                                value={pageRange}
                                onChange={(e) => onSetPageRange(e.target.value)}
                                placeholder={`例如 1-${probeResult.totalPages} 或 1,3,5`}
                                disabled={isFetchingPages}
                                className="w-full rounded-xl border border-white/10 bg-slate-900/80 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-rose-400/50 focus:outline-none"
                            />
                        </div>

                        <div>
                            <label className="mb-1.5 block text-xs font-semibold text-slate-300">
                                请求间隔
                            </label>
                            <select
                                value={delayMs}
                                onChange={(e) => onSetDelayMs(Number(e.target.value))}
                                disabled={isFetchingPages}
                                className="w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-xs text-white focus:border-rose-400/50 focus:outline-none"
                            >
                                <option value={500}>0.5s（极速）</option>
                                <option value={1000}>1.0s（标准推荐）</option>
                                <option value={2000}>2.0s（防风控）</option>
                            </select>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => onSetPageRange(`1-${probeResult.totalPages}`)}
                                disabled={isFetchingPages}
                                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/10"
                            >
                                全本 ({probeResult.totalPages}P)
                            </button>
                            {probeResult.totalPages > 10 && (
                                <button
                                    type="button"
                                    onClick={() => onSetPageRange('1-5')}
                                    disabled={isFetchingPages}
                                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/10"
                                >
                                    前 5 页
                                </button>
                            )}
                        </div>

                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={onWatchAndSave}
                                disabled={isFetchingPages}
                                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 via-sky-500 to-cyan-400 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-cyan-500/20 transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
                                title="推送到播放器即时浏览，同时自动保存全本到本地"
                            >
                                <Play className="h-4 w-4 fill-current" />
                                <span>{watchButtonText}</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* 在线解析与载入进度条 */}
            {fetchProgress && (
                <div className="flex flex-col gap-2.5 rounded-2xl border border-sky-400/20 bg-sky-950/40 p-4 shadow-xl backdrop-blur-md">
                    <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2 text-sky-200">
                            <RotateCw
                                className={`h-4 w-4 ${isFetchingPages ? 'animate-spin' : ''} text-sky-400`}
                            />
                            <span className="font-semibold">{fetchProgress.message}</span>
                        </div>
                        <span className="font-mono text-xs font-bold text-sky-300">
                            {fetchProgress.current} / {fetchProgress.total}
                        </span>
                    </div>

                    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                            className="h-full bg-gradient-to-r from-indigo-500 via-sky-400 to-cyan-300 transition-all duration-200"
                            style={{
                                width: `${fetchProgress.total > 0
                                        ? Math.min(
                                            100,
                                            Math.round((fetchProgress.current / fetchProgress.total) * 100)
                                        )
                                        : 0
                                    }%`,
                            }}
                        />
                    </div>

                    {isFetchingPages && (
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={onCancelFetch}
                                className="text-xs text-slate-400 hover:text-rose-300 transition"
                            >
                                停止后续载入
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* 当前作品后台保存任务进度 */}
            {currentTask && (
                <SaveTaskRow
                    task={currentTask}
                    onCancel={downloadActions.cancelSave}
                    onOpen={downloadActions.openFolder}
                    onDismiss={downloadActions.dismissTask}
                />
            )}

            {/* 失败页重试栏 */}
            {!isFetchingPages && failedPages.length > 0 && (
                <div className="flex items-center justify-between gap-4 rounded-2xl border border-amber-400/25 bg-amber-500/10 p-4">
                    <div className="flex items-center gap-3 text-xs text-amber-200">
                        <AlertCircle className="h-5 w-5 shrink-0 text-amber-400" />
                        <span>
                            {failedPages.length} 页解析失败（
                            {failedPages
                                .slice(0, 8)
                                .map((f) => `P${f.page}`)
                                .join('、')}
                            {failedPages.length > 8 ? '…' : ''}），剧情在此断档
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={onRetryFailed}
                        className="flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-bold text-white shadow transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
                    >
                        <RotateCw className="h-4 w-4" />
                        重试失败页
                    </button>
                </div>
            )}
        </div>
    );
};

/* -------------------------------------------------------------------------- */
/*                     Primary Export Component: GalleryPanel                 */
/* -------------------------------------------------------------------------- */

export const GalleryPanel: React.FC<GalleryPanelProps> = ({
    onBack,
    currentUrl = '',
    onBrowseInPlayer,
    onPlayMediaStreams,
    onAppendToPlayer,
    onMergeToPlayer,
}) => {
    const acgmho = useAcgmho();
    const gallery = useAcgmhoGallery();
    const downloads = useAcgDownloads();

    const {
        probeResult,
        pageRange,
        delayMs,
        isFetchingPages,
        fetchProgress,
        failedPages,
        error: probeError,
    } = acgmho.state;

    // 按单个函数解构订阅：actions 容器在 probe 变化时会换身份，整包依赖会连带卡片回调失效
    const { setInputGid, probe: probeDetail, reset: resetDetail, fetchPages, retryFailedPages } =
        acgmho.actions;
    // 画廊封面点击 → 探测详情 → 切换详情视图
    const handleOpenDetail = useCallback(
        (url: string) => {
            const t = (url || '').trim();
            if (!t) return;
            setInputGid(t);
            void probeDetail(t);
        },
        [setInputGid, probeDetail]
    );

    const handleBackToBrowse = useCallback(() => {
        resetDetail();
    }, [resetDetail]);

    // 当前作品任务键：/h/123 与 /hentai/123 各自独立，保存进度与 file-done 回写凭此隔离
    const probeTaskKey = probeResult ? acgTaskKeyOf(probeResult.gid, probeResult.prefix) : '';
    // 单页保存完成时原位回写播放列表，将远端 URL 无缝替换为本地 file://
    const probeGid = probeResult?.gid;
    useEffect(() => {
        if (!probeTaskKey || !probeGid || !onMergeToPlayer) return;
        return bindSaveFileSync(probeTaskKey, (file) => {
            onMergeToPlayer(
                [
                    {
                        url: file.localUrl,
                        title: file.title || `P${file.page}`,
                        page: file.page,
                    },
                ],
                probeGid
            );
        });
    }, [probeTaskKey, probeGid, onMergeToPlayer]);

    // 边下边播核心处理函数
    const handleWatchAndSave = useCallback(async () => {
        const current = probeResult;
        if (!current) return;

        // 音声 / 动画不走图片抓取流：直接推送音轨或视频地址（与 App/PlayPanel 同一 resolve 口径）。
        // 注意：这里必须走纯媒体直推，不能进 onBrowseInPlayer——后者会包上画廊分组，
        // 单个视频也会被搞成"标题 + 子内容"结构
        const resolved = resolveProbeMedia(current);
        // 空探测（如无音轨的 asmr、无视频直链的动画）：不进图片流，否则会建空分组/静默无事发生
        if (resolved.kind === 'none' || resolved.streams.length === 0) return;
        if (resolved.kind === 'audio' || resolved.kind === 'video') {
            if (resolved.streams.length === 0) return;
            const plain = resolved.streams.map((s, i) => ({
                url: s.url,
                title: s.title || `${current.title} - ${i + 1}`,
                // 带上探测已确定的类型（音轨 = audio），别让下游靠 .m3u8 猜成 stream
                mediaType: s.mediaType || (resolved.kind === 'audio' ? 'audio' : 'video'),
                artist: s.artist,
                poster: s.poster,
            }));
            if (onPlayMediaStreams) {
                onPlayMediaStreams(plain);
                return;
            }
            if (!onBrowseInPlayer) return;
            onBrowseInPlayer({
                title: current.title,
                gid: current.gid,
                pages: plain.map((p, i) => ({ ...p, page: i + 1 })),
            });
            return;
        }

        const total = current.totalPages;
        const title = current.title;
        const targetRange = pageRange.trim() || `1-${total}`;
        // 范围是否含 P1：只认 "1-"/"1," 前缀会误判 "5-1"/"2,1"/"1 - 5"，首屏不建分组视图切不过去
        const isFirstPageIncluded = rangeIncludesPage(targetRange, 1);

        if (isFirstPageIncluded && current.firstImgUrl && onBrowseInPlayer) {
            onBrowseInPlayer({
                title,
                gid: current.gid,
                pages: [
                    {
                        url: current.firstImgUrl,
                        title: `${title} - P01/${total}`,
                        page: 1,
                    },
                ],
            });
        }

        const gid = current.gid;
        const prefix = current.prefix;
        const sourceUrl = current.firstPageUrl;

        // 首个流式页走 onBrowseInPlayer 建组并切视图：范围不含 P1（如 5-10）时，
        // 全走 append 会导致播放器视图切不过去，用户以为点击无反应
        let groupOpened = isFirstPageIncluded;
        const flusher = createBatchFlusher<GalleryPageItem>(
            (batch) => {
                if (onAppendToPlayer) {
                    onAppendToPlayer(
                        batch.map((it) => ({ url: it.url, title: it.title, page: it.page })),
                        current.gid
                    );
                }
            },
            (a, b) => a.page - b.page
        );
        const res = await fetchPages(undefined, targetRange, (item) => {
            if (item.page === 1 && isFirstPageIncluded) return;
            if (!groupOpened && onBrowseInPlayer) {
                groupOpened = true;
                onBrowseInPlayer({
                    title,
                    gid: current.gid,
                    pages: [{ url: item.url, title: item.title, page: item.page }],
                });
                return;
            }
            flusher.push(item);
        });
        flusher.flush();

        // 抓取完成后自动启动后台落盘任务
        if (res?.pages?.length) {
            void downloads.actions.startSave({
                gid,
                title,
                prefix,
                sourceUrl,
                totalPages: total,
                items: res.pages.map((p) => ({ page: p.page, url: p.url, title: p.title })),
            });
        }
    }, [
        probeResult,
        pageRange,
        onBrowseInPlayer,
        onPlayMediaStreams,
        onAppendToPlayer,
        fetchPages,
        downloads.actions,
    ]);

    // 失败页一键重抓（已是单批合并，无需再缓冲）
    const handleRetryFailed = useCallback(async () => {
        if (!probeResult || failedPages.length === 0 || !onMergeToPlayer) return;
        const gid = probeResult.gid;
        const title = probeResult.title;
        await retryFailedPages((items) => {
            onMergeToPlayer(
                items.map((it) => ({ url: it.url, title: it.title, page: it.page })),
                gid
            );
            if (items.length > 0) {
                void downloads.actions.startSave({
                    gid,
                    title,
                    prefix: probeResult.prefix,
                    sourceUrl: probeResult.firstPageUrl,
                    totalPages: probeResult.totalPages,
                    items: items.map((it) => ({ page: it.page, url: it.url, title: it.title })),
                });
            }
        });
    }, [probeResult, failedPages, onMergeToPlayer, retryFailedPages, downloads.actions]);

    return (
        <div className="flex h-full w-full flex-col bg-slate-950 text-slate-200">
            {/* 顶栏 Header */}
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-slate-950/80 px-6 backdrop-blur-xl z-10">
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={onBack}
                        className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white active:scale-95"
                    >
                        <ArrowLeft className="h-4 w-4" />
                        <span>返回</span>
                    </button>
                    <div className="h-4 w-[1px] bg-white/10" />
                    <div className="flex items-center gap-2 font-bold text-sm text-white">
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-amber-500 text-white shadow-sm">
                            <BookOpen className="h-4 w-4" />
                        </div>
                        <span>ACG 画廊工坊</span>
                        <span className="hidden sm:inline text-xs font-normal text-zinc-500">
                            acgmho.com 漫画、动图与媒体归档
                        </span>
                    </div>
                </div>
            </header>

            {/* 内容主工作区 */}
            <main className="min-h-0 flex-1 p-6 overflow-hidden flex flex-col">
                {/* 详情视图 */}
                {probeResult ? (
                    <DetailSection
                        probeResult={probeResult}
                        pageRange={pageRange}
                        delayMs={delayMs}
                        isFetchingPages={isFetchingPages}
                        fetchProgress={fetchProgress}
                        failedPages={failedPages}
                        currentTask={downloads.tasks.find((t) => t.gid === probeTaskKey)}
                        onBack={handleBackToBrowse}
                        onSetPageRange={acgmho.actions.setPageRange}
                        onSetDelayMs={acgmho.actions.setDelayMs}
                        onWatchAndSave={handleWatchAndSave}
                        onCancelFetch={acgmho.actions.cancelFetchPages}
                        onRetryFailed={handleRetryFailed}
                        downloadActions={downloads.actions}
                    />
                ) : (
                    /* 浏览视图 */
                    <div className="flex h-full min-h-0 flex-col">
                        {probeError && (
                            <div className="mb-4 flex shrink-0 items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                                <div className="flex-1 leading-relaxed">{probeError}</div>
                            </div>
                        )}

                        <div className="min-h-0 flex-1">
                            <BrowseSection
                                currentUrl={currentUrl}
                                onOpenItem={handleOpenDetail}
                                galleryState={gallery.state}
                                galleryActions={gallery.actions}
                                tasks={downloads.tasks}
                                downloadActions={downloads.actions}
                            />
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
};
