import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertCircle,
    ArrowLeft,
    Check,
    CheckCircle2,
    Download,
    ExternalLink,
    FileDown,
    FolderOpen,
    Link2,
    Loader2,
    Magnet,
    Pause,
    Play,
    Search,
    SlidersHorizontal,
    X,
} from 'lucide-react';
import { SORT_OPTIONS, useMagnetSearch } from '../../hooks';
import type { SearchHit, SearchSiteStatus, TorrentTaskSnapshot } from '../../meta';
import { formatBytes } from '../../services/SearchService';

/**
 * ============================================================================
 * TorrentPanel — 磁力下载全屏页
 * ============================================================================
 *
 * 从悬浮球里搬出来的（原 components/Floating.tsx 的 TorrentFloating 一家）。
 * 搬家原因：悬浮球面板是小浮窗，搜出来 150 条结果、任务进度表挤在里面翻得难受；
 * 它与 ACG 画廊 / 音频工坊 / 播放器同概念——都是浏览器地址栏一键进入的全屏页，
 * 所以入口也在地址栏那组导航按钮里（BrowsePanel），由 App 的 ViewMode 统一调度。
 *
 * 状态不靠 keep-alive：useMagnetSearch 把查询条件与结果落盘（search-query /
 * search-hits），任务挂载即从主进程拉全量——卸载重进回到上次那页，数据不丢。
 * 面板内的 tab / 站点折叠等纯 UI 状态重进复位，这是全屏页的常规语义（音频工坊同）。
 */

const SURFACE_SUNKEN = 'border border-white/[0.06] bg-white/[0.03]';
const SURFACE_RAISED = 'border border-white/10 bg-white/[0.06]';
const SURFACE_HOVER = 'hover:border-white/20 hover:bg-white/[0.12]';
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60';
const BTN_GHOST = `inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-300 transition ${SURFACE_RAISED} ${SURFACE_HOVER} hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`;

/**
 * 剪贴板写入。navigator.clipboard.writeText() 失败走 Promise reject 不是同步 throw，
 * try/catch 不 await 会永远报"已复制"——必须 await（与 Floating 同一份语义）。
 */
const copyText = async (text: string): Promise<boolean> => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
};

/** 「已复制」这类一次性反馈：定时器随卸载一起清掉，避免卸载后仍写 state */
const useTransientFlag = (ms: number) => {
    const [on, setOn] = useState(false);
    const timer = useRef<number | null>(null);

    const flash = useCallback(() => {
        setOn(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setOn(false), ms);
    }, [ms]);

    useEffect(
        () => () => {
            if (timer.current !== null) window.clearTimeout(timer.current);
        },
        []
    );

    return [on, flash] as const;
};

const EmptyHint: React.FC<{ icon: React.ReactNode; title: string; children?: React.ReactNode }> = ({
    icon,
    title,
    children,
}) => (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl text-slate-500 ${SURFACE_SUNKEN}`}>
            {icon}
        </div>
        <p className="text-sm text-slate-400">{title}</p>
        {children}
    </div>
);

const fmtSpeed = (n: number) => `${formatBytes(n)}/s`;

const statusText = (s: TorrentTaskSnapshot['status']): string => {
    switch (s) {
        case 'metadata':
            return '找资源中';
        case 'downloading':
            return '下载中';
        case 'seeding':
            return '做种中';
        case 'paused':
            return '已暂停';
        case 'error':
            return '出错';
        default:
            return s;
    }
};

/** 未知值统一显示为「?」而不是 0——两者含义不同（站点没公布 ≠ 数量为零） */
const fmtNum = (n: number) => (n < 0 ? '?' : String(n));

const fmtDate = (ms: number): string => {
    if (!ms || ms < 0) return '';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (v: number) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const STATUS_TONES: Record<string, string> = {
    downloading: 'bg-cyan-500/15 text-cyan-300',
    seeding: 'bg-emerald-500/15 text-emerald-300',
    error: 'bg-rose-500/15 text-rose-300',
};

const SEARCH_INPUT = `min-w-[200px] flex-1 rounded-lg border border-white/10 bg-white/[0.06] px-2.5 py-1.5 text-xs text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-cyan-400/50 ${FOCUS_RING}`;
const SEARCH_SELECT = `rounded-lg border border-white/10 bg-white/[0.06] px-2.5 py-1.5 text-xs text-slate-200 outline-none transition focus:border-cyan-400/50 ${FOCUS_RING}`;
const SEARCH_PRIMARY = `inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-indigo-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-110 active:scale-95 disabled:opacity-50 ${FOCUS_RING}`;

/**
 * 结果行。一次搜索可能回来 150 条，行内不持有任何会变的状态之外的东西，
 * 所以 memo 之后翻页/滚动只重绘真正变化的那几行。
 */
const SearchHitRow = React.memo(function SearchHitRow({
    hit,
    onDownload,
    onSaveTorrent,
    onCopyResult,
    onOpenDetail,
}: {
    hit: SearchHit;
    onDownload: (hit: SearchHit) => void;
    onSaveTorrent: (hit: SearchHit) => void;
    onCopyResult: (ok: boolean) => void;
    onOpenDetail: (url: string) => void;
}) {
    const [copied, flashCopied] = useTransientFlag(1500);

    const handleCopyMagnet = useCallback(async () => {
        const ok = await copyText(hit.magnet || '');
        if (ok) flashCopied();
        onCopyResult(ok);
    }, [hit.magnet, flashCopied, onCopyResult]);

    const seeders = hit.seeders;
    // 做种数为 0 是死种，任何加速手段都救不了 —— 列表里先标出来，别让人下完才发现
    const isDead = seeders === 0;
    const detailUrl = hit.viewUrl;

    return (
        <div className={`rounded-xl p-2.5 transition-colors ${SURFACE_SUNKEN} hover:border-white/20`}>
            <div className="line-clamp-2 text-xs font-medium leading-5 text-slate-100" title={hit.title}>
                {hit.title}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                <span className="rounded border border-cyan-400/25 bg-cyan-400/10 px-1.5 py-px text-[10px] font-medium text-cyan-300">
                    {hit.siteLabel}
                </span>
                {hit.category && <span className="text-cyan-400/80">{hit.category}</span>}
                {hit.sizeText && <span>{hit.sizeText}</span>}
                <span className={isDead ? 'text-rose-400' : seeders > 0 ? 'text-emerald-400' : 'text-slate-500'}>
                    做种 {fmtNum(seeders)}
                    {isDead && '（死种）'}
                </span>
                <span>吸血 {fmtNum(hit.leechers)}</span>
                {hit.publishedAt > 0 && <span>{fmtDate(hit.publishedAt)}</span>}
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button onClick={() => onDownload(hit)} className={SEARCH_PRIMARY}>
                    <Download className="h-3 w-3" /> 下载
                </button>
                {hit.torrent && (
                    <button onClick={() => onSaveTorrent(hit)} className={BTN_GHOST} title="只保存 .torrent 种子文件">
                        <FileDown className="h-3 w-3" /> 种子
                    </button>
                )}
                {hit.magnet && (
                    <button onClick={() => void handleCopyMagnet()} className={BTN_GHOST} title="复制 magnet">
                        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Link2 className="h-3 w-3" />}
                        {copied ? '已复制' : '磁链'}
                    </button>
                )}
                {detailUrl && (
                    <button onClick={() => onOpenDetail(detailUrl)} className={BTN_GHOST} title="站点详情页">
                        <ExternalLink className="h-3 w-3" /> 详情
                    </button>
                )}
            </div>
        </div>
    );
});

const TaskRow = React.memo(function TaskRow({
    task,
    onPause,
    onResume,
    onDelete,
    onOpenFolder,
}: {
    task: TorrentTaskSnapshot;
    onPause: (id: string) => void;
    onResume: (id: string) => void;
    onDelete: (task: TorrentTaskSnapshot) => void;
    onOpenFolder: (target: string) => void;
}) {
    const percent = Math.round(task.progress * 100);
    const isActive = task.status === 'downloading' || task.status === 'metadata';

    return (
        <div className={`rounded-xl p-2.5 ${SURFACE_SUNKEN}`}>
            <div className="flex items-center justify-between gap-2">
                <div className="line-clamp-1 flex-1 text-xs font-medium text-slate-100" title={task.name}>
                    {task.name}
                </div>
                <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_TONES[task.status] || 'bg-white/10 text-slate-300'
                        }`}
                >
                    {statusText(task.status)}
                </span>
            </div>

            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-indigo-400 transition-[width] duration-300"
                    style={{ width: `${percent}%` }}
                />
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-slate-500">
                <span>{percent}%</span>
                <span>
                    {formatBytes(task.downloaded)} / {formatBytes(task.total)}
                </span>
                <span>↓ {fmtSpeed(task.downloadSpeed)}</span>
                <span>↑ {fmtSpeed(task.uploadSpeed)}</span>
                <span>{task.numPeers} peers</span>
                {task.files.length > 1 && <span>{task.files.length} 个文件</span>}
            </div>

            {task.status === 'error' && task.error && <div className="mt-1 text-[11px] text-rose-400">{task.error}</div>}

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {isActive ? (
                    <button onClick={() => onPause(task.id)} className={BTN_GHOST}>
                        <Pause className="h-3 w-3" /> 暂停
                    </button>
                ) : (
                    <button onClick={() => onResume(task.id)} className={BTN_GHOST}>
                        <Play className="h-3 w-3" /> 继续
                    </button>
                )}
                <button onClick={() => onDelete(task)} className={BTN_GHOST}>
                    <X className="h-3 w-3" /> 删除
                </button>
                <button onClick={() => onOpenFolder(task.outDir || task.id)} className={BTN_GHOST}>
                    <FolderOpen className="h-3 w-3" /> 目录
                </button>
            </div>
        </div>
    );
});

export interface TorrentPanelProps {
    onBack: () => void;
}

export const TorrentPanel: React.FC<TorrentPanelProps> = ({ onBack }) => {
    const { state, actions } = useMagnetSearch();
    const { query, isSearching, hits, siteStatus, elapsedMs, tasks, error, notice, sites } = state;

    const [tab, setTab] = useState<'search' | 'tasks'>('search');
    const [showSites, setShowSites] = useState(false);
    const [showStatus, setShowStatus] = useState(false);

    // 逐个取出：actions 对象每轮都是新引用，直接依赖它会让下面所有 memo 失效
    const { setQuery, search, downloadHit, saveTorrentFile, setNotice, setError, cancelTask } = actions;

    const set = useCallback(
        (patch: Partial<typeof query>) => setQuery({ ...query, ...patch }),
        [setQuery, query]
    );

    const onSearch = useCallback(() => {
        search();
        setTab('search');
    }, [search]);

    const onDownloadHit = useCallback(
        async (hit: SearchHit) => {
            // 做种数为 0 的是死种：任何加速手段都救不了，先预警免得用户干等报「慢」。
            // seeders 为 -1 表示站点没公布做种数（未知），不拦。
            if (hit.seeders === 0) {
                const go = window.confirm(
                    `「${hit.title.slice(0, 40)}」当前做种数为 0，可能极慢或根本无法完成。\n\n仍要尝试下载吗？`
                );
                if (!go) return;
            }
            const taskId = await downloadHit(hit);
            if (taskId) setTab('tasks');
        },
        [downloadHit]
    );

    const onSaveTorrent = useCallback((hit: SearchHit) => void saveTorrentFile(hit), [saveTorrentFile]);

    const onCopyResult = useCallback(
        (ok: boolean) => {
            if (ok) setNotice('magnet 已复制');
            else setError('复制失败：剪贴板不可用');
        },
        [setNotice, setError]
    );

    const onOpenDetail = useCallback((url: string) => window.open(url, '_blank'), []);

    const onDeleteTask = useCallback(
        (task: TorrentTaskSnapshot) => {
            const done = task.status === 'seeding' || (task.progress >= 1 && task.total > 0);
            const msg = done
                ? `删除任务「${task.name.slice(0, 30)}」？\n\n已完成文件保留在下载目录，仅移除任务记录。`
                : `删除任务「${task.name.slice(0, 30)}」？\n\n未完成分片将被一起删除，该操作不可撤销。`;
            if (window.confirm(msg)) void cancelTask(task.id);
        },
        [cancelTask]
    );

    const selectedSites = query.sites.length ? query.sites : sites.map((s) => s.id);
    const okSites = siteStatus.filter((s) => s.ok).length;
    const failedSites = siteStatus.filter((s) => !s.ok);

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-slate-950 text-slate-200">
            {/* 顶栏：与 ACG 画廊 / 音频工坊同一形制，返回浏览 */}
            <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/8 bg-white/[0.03] px-4">
                <button
                    onClick={onBack}
                    className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-slate-400 transition hover:bg-white/8 hover:text-white ${FOCUS_RING}`}
                    title="返回浏览"
                >
                    <ArrowLeft className="h-4 w-4" />
                    返回浏览
                </button>
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 via-sky-500 to-indigo-500 text-white">
                    <Magnet className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                    <div className="text-sm font-bold text-white">磁力下载</div>
                    <div className="truncate text-[11px] text-slate-500">扇出搜索全部已注册站点，内置引擎直下正片</div>
                </div>
                <div className="flex-1" />
                {tasks.length > 0 && (
                    <span className="rounded-full bg-cyan-500/15 px-2.5 py-1 text-[11px] font-semibold text-cyan-300">
                        {tasks.length} 个任务
                    </span>
                )}
            </div>

            {/* 内容：悬浮球里那套原样搬过来，全屏只加了居中限宽 */}
            <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-3 overflow-hidden p-4">
                {/* ============ 搜索栏 ============ */}
                <div className="flex shrink-0 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            value={query.q}
                            onChange={(e) => set({ q: e.target.value })}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') onSearch();
                            }}
                            placeholder="输入关键词，一次搜索全部站点"
                            aria-label="搜索关键词"
                            className={SEARCH_INPUT}
                        />
                        <select
                            value={query.sort}
                            onChange={(e) => set({ sort: e.target.value as typeof query.sort })}
                            className={SEARCH_SELECT}
                            title="排序方式"
                            aria-label="排序方式"
                        >
                            {SORT_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                        <button
                            onClick={() => setShowSites((v) => !v)}
                            className={`${BTN_GHOST} ${showSites ? 'border-cyan-400/40 text-cyan-300' : ''}`}
                            title="选择要搜索的站点"
                            aria-expanded={showSites}
                        >
                            <SlidersHorizontal className="h-3 w-3" />
                            {query.sites.length ? `${query.sites.length}/${sites.length} 站` : `全部 ${sites.length} 站`}
                        </button>
                        <button onClick={onSearch} disabled={isSearching} className={SEARCH_PRIMARY}>
                            {isSearching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                            {isSearching ? '搜索中…' : '搜索'}
                        </button>
                    </div>

                    {/* 站点多选：由引擎注册表驱动，注册表里加站点后这里自动出现，无需改 UI */}
                    {showSites && (
                        <div className={`flex flex-wrap items-center gap-1.5 rounded-xl p-2 ${SURFACE_SUNKEN}`}>
                            <span className="px-1 text-[11px] text-slate-500">搜索范围</span>
                            <button
                                onClick={() => set({ sites: [] })}
                                className={`${BTN_GHOST} ${query.sites.length === 0 ? 'border-cyan-400/40 text-cyan-300' : ''}`}
                            >
                                全部
                            </button>
                            {sites.map((s) => {
                                const on = selectedSites.includes(s.id);
                                return (
                                    <button
                                        key={s.id}
                                        onClick={() => actions.toggleSite(s.id)}
                                        className={`${BTN_GHOST} ${on ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200' : 'opacity-60'}`}
                                        title={`${s.homepage}${s.kinds.length ? ` · ${s.kinds.join(' / ')}` : ''}`}
                                    >
                                        {s.label}
                                        {s.adult && <span className="text-rose-400/80">18+</span>}
                                    </button>
                                );
                            })}
                            <div className="flex-1" />
                            <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                                <input
                                    type="checkbox"
                                    checked={query.includeAdult}
                                    onChange={(e) => set({ includeAdult: e.target.checked })}
                                    className="accent-cyan-500"
                                />
                                包含成人站点
                            </label>
                            <select
                                value={String(query.minSeeders)}
                                onChange={(e) => set({ minSeeders: Number(e.target.value) })}
                                className={SEARCH_SELECT}
                                title="过滤做种数过低的条目（做种数未知的站点不受影响）"
                                aria-label="做种数过滤"
                            >
                                <option value="0">不限做种</option>
                                <option value="1">≥ 1</option>
                                <option value="5">≥ 5</option>
                                <option value="20">≥ 20</option>
                            </select>
                        </div>
                    )}
                </div>

                {/* 动作反馈（下载已开始 / 种子已保存 / magnet 已复制）。
              各站统计不在这里 —— 它由下面的状态行独占，两边都写就是同一句话说两遍 */}
                {error && (
                    <div className="flex shrink-0 items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}
                {!error && notice && (
                    <div className="shrink-0 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300">
                        {notice}
                    </div>
                )}

                {/* 各站明细：扇出搜索必须让用户看到「哪几站没搜到、为什么」，
              否则无法区分「没有这个资源」与「有个站挂了」 */}
                {siteStatus.length > 0 && (
                    <div className="shrink-0">
                        <button
                            onClick={() => setShowStatus((v) => !v)}
                            className={`flex items-center gap-2 rounded text-[11px] text-slate-400 transition-colors hover:text-slate-200 ${FOCUS_RING}`}
                            aria-expanded={showStatus}
                        >
                            <CheckCircle2 className={`h-3.5 w-3.5 ${failedSites.length ? 'text-amber-400' : 'text-emerald-400'}`} />
                            <span>
                                {okSites}/{siteStatus.length} 站返回结果
                                {failedSites.length > 0 && <span className="text-rose-400"> · {failedSites.length} 站失败</span>}
                                {elapsedMs > 0 && <span className="text-slate-500"> · {elapsedMs}ms</span>}
                            </span>
                            <span className="text-slate-600">{showStatus ? '收起' : '明细'}</span>
                        </button>
                        {showStatus && (
                            <div className={`mt-1.5 flex flex-col gap-1 rounded-lg p-2 ${SURFACE_SUNKEN}`}>
                                {siteStatus.map((s: SearchSiteStatus) => (
                                    <div key={s.site} className="flex items-center gap-2 text-[11px]">
                                        <span className={s.ok ? 'text-emerald-400' : 'text-rose-400'}>{s.ok ? '●' : '×'}</span>
                                        <span className="w-28 shrink-0 truncate text-slate-300" title={s.label}>
                                            {s.label}
                                        </span>
                                        <span className="text-slate-500">{s.ok ? `${s.count} 条 · ${s.elapsedMs}ms` : s.error || '失败'}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* ============ 子标签 ============ */}
                <div className="flex shrink-0 items-center gap-1.5">
                    {(
                        [
                            { value: 'search', label: `结果 (${hits.length})` },
                            { value: 'tasks', label: `下载任务 (${tasks.length})` },
                        ] as const
                    ).map((t) => (
                        <button
                            key={t.value}
                            onClick={() => setTab(t.value)}
                            className={`rounded-lg px-3 py-1 text-xs font-semibold transition ${FOCUS_RING} ${tab === t.value ? 'bg-white/[0.12] text-white' : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-200'
                                }`}
                        >
                            {t.label}
                        </button>
                    ))}
                    <div className="flex-1" />
                    {tab === 'search' && hits.length > 0 && (
                        <button onClick={actions.clearResults} className={BTN_GHOST}>
                            清空结果
                        </button>
                    )}
                    {tab === 'tasks' && (
                        <button onClick={() => void actions.refreshTasks()} className={BTN_GHOST}>
                            刷新任务
                        </button>
                    )}
                </div>

                {/* ============ 结果列表 ============ */}
                {tab === 'search' && (
                    <div className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
                        {hits.length === 0 && !isSearching && (
                            <EmptyHint icon={<Search className="h-6 w-6" />} title="还没有结果">
                                <p className="max-w-md text-xs leading-5 text-slate-500">
                                    在上方输入关键词，引擎会同时搜索全部 {sites.length} 个站点并汇总结果。
                                    <br />
                                    点「下载」直接用内置引擎下正片，无需迅雷 / qBittorrent。
                                </p>
                            </EmptyHint>
                        )}
                        {hits.map((hit) => (
                            <SearchHitRow
                                key={`${hit.site}-${hit.id}`}
                                hit={hit}
                                onDownload={onDownloadHit}
                                onSaveTorrent={onSaveTorrent}
                                onCopyResult={onCopyResult}
                                onOpenDetail={onOpenDetail}
                            />
                        ))}
                    </div>
                )}

                {/* ============ 任务列表 ============ */}
                {tab === 'tasks' && (
                    <div className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
                        {tasks.length === 0 && (
                            <EmptyHint icon={<Download className="h-6 w-6" />} title="暂无下载任务">
                                <p className="max-w-md text-xs leading-5 text-slate-500">
                                    去「结果」里点「下载」开始。
                                    <br />
                                    若任务长期 0 速度：先看 peers 是否为 0——为 0 多半是资源已死（做种 0）或当前网络禁 P2P；
                                    引擎已自动挂载 17 个公共 Tracker + 6 个 DHT 入口 + 200 并行连接，新任务一般 1 分钟内能找到 peer。
                                </p>
                            </EmptyHint>
                        )}
                        {tasks.map((t) => (
                            <TaskRow
                                key={t.id}
                                task={t}
                                onPause={actions.pauseTask}
                                onResume={actions.resumeTask}
                                onDelete={onDeleteTask}
                                onOpenFolder={actions.openFolder}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
