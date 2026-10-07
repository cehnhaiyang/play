import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
    AlertCircle,
    BrainCircuit,
    Check,
    Copy,
    Cpu,
    Download,
    Eye,
    EyeOff,
    FileQuestion,
    FileText,
    Film,
    Globe,
    Image as ImageIcon,
    Info,
    KeyRound,
    Link2,
    ListFilter,
    Loader2,
    Music,
    Play,
    Plug,
    Radio,
    RefreshCw,
    Save,
    ScrollText,
    Search,
    Settings,
    Sparkles,
    ToggleLeft,
    ToggleRight,
    Trash2,
    Wifi,
    X,
    Zap,
} from 'lucide-react';
import type { SnifferState } from '../hooks';
import { SNIFF_FILTER_OPTIONS } from '../hooks';
import type {
    AiConfig,
    FoundLink,
    MediaDownloadProgress,
} from '../meta';
import { getElectronAPI } from '../meta';
import { isLinkFromPage, loadJSON, requiresFfmpeg, saveJSON } from '../const';
import { formatBytes } from '../services/SearchService';
import {
    AI_PROVIDERS,
    DEFAULT_AI_CONFIG,
    EFFORT_OPTIONS,
    findAiProvider,
    getModelPresets,
    resolveReasoningEffort,
    saveAiConfig,
    testAiConnection,
    type AiProviderPreset,
} from '../services/AiService';
import {
    LOG_BUFFER_CAP,
    LOG_PERSIST_CAP,
    clearLogs,
    getLogEntries,
    getLogVersion,
    subscribeLogs,
    type LogLevel,
} from '../services/LogService';

/**
 * 悬浮球与它的三个面板。
 *
 * 这个文件是**一个整体**：悬浮球 + 资源嗅探 + 设置 + 运行日志。
 * 四块内容由同一个 keep-alive 策略管着（打开过就常驻内存，切页/关球只用
 * `hidden` 藏，输入、滚动、已加载的列表原样保留）—— 拆成多个文件后，
 * 改一次这个策略要同时动好几处，漏一处就是"切个页搜索条件没了"。
 *
 * Agent 不在这里。它已迁到浏览器面板的右侧边栏（components/BrowsePanel.tsx）：
 * 它每一步都要落到 webview 上，而悬浮球在播放器/音频工坊里也常驻，
 * 那时没有可用页面，摆一个能打字却做不了事的对话框只会误导人。
 * 留在这里的三个面板都不依赖 webview。
 *
 * 磁力下载也不在这里。它已迁到浏览器全屏页（components/TorrentPanel）：
 * 搜索结果与任务表在小浮窗里翻得难受，与 ACG 画廊同概念走地址栏入口。
 *
 * 原 Floating/ 目录（index + SniffResults + 磁力面板 + SettingsFloating
 * + shared）全部合并到这里，唯独磁力面板搬去了 TorrentPanel。
 */

/* ========================================================================== */
/*                              常量与共享原子件                              */
/* ========================================================================== */

/** 悬浮球里剩下的面板。'agent' / 'tamper' / 'torrent' 是历史落盘值，见 readStoredPanel */
type FloatingPanelType = 'sniff' | 'settings' | 'logs';

interface FloatingProps {
    sniffer: SnifferState;
    currentUrl: string;
    onPlay: (link: FoundLink) => void;
    onAiAnalyze: () => void;
}

const PANEL_MARGIN = 12;
const BALL_SIZE = 60;
/** 拖动释放时距左右边缘多近就吸附过去 */
const SNAP_THRESHOLD = 72;

/**
 * 表面色阶：只保留三档。
 *
 * 此前这里是 bg-white/4、/5、/6、/8、/10、/12 再加三个 bg-white/[0.0x] ——
 * 九档混用，肉眼分不出相邻两档，却让"这块该用什么底色"每次都靠猜。
 * 现在只有三个语义：内嵌区块 / 可交互控件 / 悬停与选中。
 */
const SURFACE_SUNKEN = 'border border-white/[0.06] bg-white/[0.03]';
const SURFACE_RAISED = 'border border-white/10 bg-white/[0.06]';
const SURFACE_HOVER = 'hover:border-white/20 hover:bg-white/[0.12]';

/**
 * 焦点环。此前这些面板里没有一个 focus-visible 样式，
 * 纯键盘用户按 Tab 完全看不出焦点落在哪个按钮上。
 */
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60';

const BTN_GHOST = `inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-300 transition ${SURFACE_RAISED} ${SURFACE_HOVER} hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`;
const BTN_PRIMARY = `inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-indigo-500/20 transition hover:bg-indigo-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`;

/** 面板外壳与遮罩（原 shared.ts 的三个常量，这里只留真正在用的） */
const PANEL_SHELL =
    'rounded-3xl border border-white/12 bg-slate-950/85 backdrop-blur-2xl shadow-[0_24px_80px_rgba(0,0,0,0.65),0_0_1px_1px_rgba(255,255,255,0.08)]';

/**
 * 遮罩：只负责压暗与接住点击。
 *
 * 这里**不做 backdrop-blur** —— 面板只留 12px 边距，遮罩的模糊只有那一圈看得见，
 * 却要在整块视口上再跑一遍 backdrop-filter。面板自己已经有一层全屏模糊，
 * 两层叠着是纯浪费。
 */
const PANEL_OVERLAY = 'fixed inset-0 z-40 bg-black/45';

const PANEL_META: Record<
    FloatingPanelType,
    {
        label: string;
        icon: React.ComponentType<{ className?: string }>;
        accent: string;
        hint: string;
    }
> = {
    sniff: {
        label: '资源嗅探',
        icon: Sparkles,
        accent: 'from-indigo-500 via-violet-500 to-cyan-400',
        hint: '自动侦测音视频、流媒体及直链资源',
    },
    settings: {
        label: '设置',
        icon: Settings,
        accent: 'from-sky-500 via-blue-500 to-indigo-400',
        hint: '网络代理与 AI 服务配置',
    },
    logs: {
        label: '运行日志',
        icon: ScrollText,
        accent: 'from-slate-500 via-slate-400 to-slate-300',
        hint: '渲染进程的全部 console 输出，重启后保留最近一部分',
    },
};

const clampPosition = (nextX: number, nextY: number) => ({
    x: Math.max(12, Math.min(nextX, window.innerWidth - BALL_SIZE - 12)),
    y: Math.max(12, Math.min(nextY, window.innerHeight - BALL_SIZE - 12)),
});

/** 导航顺序。写死而不是 Object.keys(PANEL_META)：顺序是设计决定，不该随对象字面量改动而变 */
const PANEL_ORDER: FloatingPanelType[] = ['sniff', 'settings', 'logs'];

/**
 * 剪贴板写入。
 *
 * `navigator.clipboard.writeText()` 失败是走 **Promise reject**，不是同步 throw，
 * 所以 `try { writeText() } catch {}` 永远进不了 catch —— 剪贴板不可用时
 * 界面照样弹「已复制」，用户粘贴出来是空的。必须 await。
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

/* ========================================================================== */
/*                              资源嗅探                                       */
/* ========================================================================== */

interface SnifferResultsProps {
    sniffer: SnifferState;
    onPlay: (link: FoundLink) => void;
    onAiAnalyze: () => void;
    currentUrl: string;
}

/**
 * 筛选栏的可选项从 hooks 导入，不在这里另写一份。
 *
 * 界面这份原先写死一份字面量，而落盘校验读的是 CATEGORIES 的全部键 ——
 * 两份必然漂移：手改 localStorage 成 'gallery' 能通过校验，
 * 界面上却没有那个按钮，表现为"列表空了却看不出为什么"。
 */
const SNIFF_FILTERS = SNIFF_FILTER_OPTIONS;

const TYPE_ICONS: Record<string, React.ReactNode> = {
    stream: <Radio className="h-4 w-4" />,
    video: <Film className="h-4 w-4" />,
    audio: <Music className="h-4 w-4" />,
    image: <ImageIcon className="h-4 w-4" />,
    document: <FileText className="h-4 w-4" />,
};

const TYPE_TONES: Record<string, string> = {
    stream: 'border-orange-300/20 bg-orange-500/12 text-orange-200',
    video: 'border-sky-300/20 bg-sky-500/12 text-sky-200',
    audio: 'border-pink-300/20 bg-pink-500/12 text-pink-200',
    image: 'border-emerald-300/20 bg-emerald-500/12 text-emerald-200',
    document: 'border-cyan-300/20 bg-cyan-500/12 text-cyan-200',
};

/** 资源来源徽章：AI 分析 / 网络捕获 / 页面抓取，文案与配色一一对应 */
const SOURCE_BADGES: Record<string, { label: string; className: string; icon?: React.ReactNode }> = {
    ai: {
        label: 'AI 深度分析',
        className: 'border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200',
        icon: <Sparkles className="h-2.5 w-2.5" />,
    },
    network: { label: '网络捕获', className: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200' },
    local: { label: '页面抓取', className: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200' },
};

/** 秒 → mm:ss / h:mm:ss */
const fmtClock = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (v: number) => String(v).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

/**
 * 进度摘要：优先给百分比，拿不到总长时退化成已下载字节数。
 *
 * 不编造百分比 —— 直链文件没有 Content-Length、或 ffmpeg 还没打印出
 * Duration 时，percent 就是 null，这里如实显示"已下载 X MB"。
 */
const describeProgress = (p: MediaDownloadProgress): string => {
    const parts: string[] = [];
    if (p.percent !== null) {
        parts.push(`${p.percent}%`);
        if (p.totalSeconds > 0) {
            parts.push(`${fmtClock(p.processedSeconds)} / ${fmtClock(p.totalSeconds)}`);
        }
    } else if (p.receivedBytes > 0) {
        parts.push(`已下载 ${formatBytes(p.receivedBytes)}`);
    } else {
        parts.push('正在连接…');
    }
    if (p.receivedBytes > 0 && p.totalBytes > 0) {
        parts.push(`${formatBytes(p.receivedBytes)} / ${formatBytes(p.totalBytes)}`);
    }
    if (p.speed > 0) parts.push(`${p.speed.toFixed(1)}x`);
    if (p.skippedSegments > 0) parts.push(`已跳过 ${p.skippedSegments} 段`);
    return parts.join(' · ');
};

const SniffCard = React.memo(function SniffCard({
    index,
    link,
    isDownloading,
    progress,
    canDownload,
    downloadHint,
    onDownload,
    onPlay,
    onCancel,
}: {
    index: number;
    link: FoundLink;
    isDownloading: boolean;
    /** 仅当这条正在下载时非 null */
    progress: MediaDownloadProgress | null;
    canDownload: boolean;
    downloadHint: string;
    onDownload: (link: FoundLink) => void;
    onPlay: (link: FoundLink) => void;
    onCancel: () => void;
}) {
    const [copied, flashCopied] = useTransientFlag(1500);

    const handleCopy = useCallback(async () => {
        if (await copyText(link.url)) flashCopied();
    }, [link.url, flashCopied]);

    const source = SOURCE_BADGES[link.source] || null;

    return (
        <div
            className={`group relative rounded-2xl p-3.5 transition-colors ${SURFACE_SUNKEN} hover:border-indigo-400/40 hover:bg-white/[0.06]`}
        >
            <div className="flex items-start gap-3">
                <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${TYPE_TONES[link.type] || 'border-white/10 bg-white/[0.06] text-slate-300'
                        }`}
                >
                    {TYPE_ICONS[link.type] || <FileQuestion className="h-4 w-4" />}
                </div>

                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-sm font-semibold text-slate-100" title={link.title}>
                            {link.title || '未命名资源'}
                        </div>
                        <button
                            onClick={() => void handleCopy()}
                            className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[10px] text-slate-400 transition ${SURFACE_RAISED} ${SURFACE_HOVER} hover:text-white ${FOCUS_RING}`}
                            title="复制资源链接"
                            aria-label="复制资源链接"
                        >
                            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                            <span>{copied ? '已复制' : '复制'}</span>
                        </button>
                    </div>

                    <div className="mt-1 flex items-center gap-1 truncate font-mono text-[10px] text-slate-400">
                        <span className="rounded border border-white/10 bg-white/[0.08] px-1 font-bold uppercase text-slate-300">
                            {link.ext || 'UNK'}
                        </span>
                        <span className="flex-1 truncate" title={link.url}>
                            {link.url}
                        </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {source && (
                            <span
                                className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold ${source.className}`}
                            >
                                {source.icon}
                                {source.label}
                            </span>
                        )}
                        {/* 徽章同样按 requiresFfmpeg 判：只看 type 会让
                            "ext=flv 但 type=video"的条目既没有徽章、又被主进程走 ffmpeg */}
                        {requiresFfmpeg(link.type, link.ext) && (
                            <span
                                className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${canDownload
                                    ? 'border-indigo-400/30 bg-indigo-500/10 text-indigo-200'
                                    : 'border-white/10 bg-white/[0.06] text-slate-400'
                                    }`}
                            >
                                {canDownload ? 'ffmpeg 下载' : 'ffmpeg 不可用'}
                            </span>
                        )}
                        {link.referer && (
                            <span
                                className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[9px] text-slate-400"
                                title={link.referer}
                            >
                                <Globe className="h-2.5 w-2.5" />
                                防盗链参数已捕获
                            </span>
                        )}
                    </div>
                </div>
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2">
                <span className="pl-1 font-mono text-[10px] text-slate-500">#{index + 1}</span>
                <div className="flex gap-2">
                    {isDownloading ? (
                        /* 下载中：按钮位置换成进度 + 取消。
                           进度条宽度用 percent，拿不到百分比时走不定态条纹 —— 不假装有进度 */
                        <div className="flex items-center gap-2">
                            <div className="flex w-32 flex-col gap-1">
                                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                                    {progress?.percent !== null && progress?.percent !== undefined ? (
                                        <div
                                            className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400 transition-[width] duration-300"
                                            style={{ width: `${progress.percent}%` }}
                                        />
                                    ) : (
                                        <div className="bp-indeterminate h-full w-1/3 rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400" />
                                    )}
                                </div>
                                <span className="truncate text-[10px] text-slate-400" title={progress ? describeProgress(progress) : ''}>
                                    {progress ? describeProgress(progress) : '正在启动…'}
                                </span>
                            </div>
                            <button
                                onClick={onCancel}
                                className={`${BTN_GHOST} hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-300`}
                                title="取消下载并删除未完成的文件"
                            >
                                <X className="h-3.5 w-3.5" />
                                <span>取消</span>
                            </button>
                        </div>
                    ) : (
                        <button onClick={() => onDownload(link)} disabled={!canDownload} className={BTN_GHOST} title={downloadHint}>
                            <Download className="h-3.5 w-3.5" />
                            <span>下载</span>
                        </button>
                    )}
                    <button onClick={() => onPlay(link)} className={BTN_PRIMARY}>
                        <Play className="h-3 w-3 fill-current" />
                        {link.type === 'image' ? '查看' : '播放'}
                    </button>
                </div>
            </div>
        </div>
    );
});

const SniffResults: React.FC<SnifferResultsProps> = ({ sniffer, onPlay, onAiAnalyze, currentUrl }) => {
    const {
        filteredLinks,
        foundLinks,
        filterType,
        scopeFilter,
        sniffEnabled,
        isAnalyzing,
        statusMessage,
        downloadingUrl,
        downloadProgress,
        downloadCapabilities,
        actions,
    } = sniffer;

    // 只依赖 actions.download 本身（useBrowse 里是 memo 过的稳定引用），
    // 依赖整个 actions 会让 SniffCard 的 memo 每轮都失效
    const download = actions.download;
    const cancelDownload = actions.cancelDownload;
    const handleDownload = useCallback((link: FoundLink) => void download(link), [download]);
    const handleCancel = useCallback(() => void cancelDownload(), [cancelDownload]);

    const currentPageLinksCount = useMemo(
        () => foundLinks.filter((link) => isLinkFromPage(link, currentUrl)).length,
        [foundLinks, currentUrl]
    );

    const canClear = filteredLinks.length > 0;
    const ffmpegAvailable = downloadCapabilities.ffmpegAvailable;

    // 状态栏要显示"正在下载哪一个"。下载中那条可能已被筛掉/清空，
    // 所以从全量列表里找，找不到就退回显示主机名。
    const currentDownloadTitle = useMemo(() => {
        if (!downloadingUrl) return '';
        const hit = foundLinks.find((l) => l.url === downloadingUrl);
        if (hit?.title) return hit.title;
        try {
            return new URL(downloadingUrl).pathname.split('/').pop() || downloadingUrl;
        } catch {
            return downloadingUrl;
        }
    }, [downloadingUrl, foundLinks]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* 工具条。标题与副标题由外壳统一给出，这里只说本页独有的动态信息 */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                <p className="text-xs text-slate-400">
                    {isAnalyzing
                        ? '正在全面扫描页面与网络请求…'
                        : `已捕获 ${foundLinks.length} 项资源 · 当前页 ${currentPageLinksCount} 项`}
                </p>

                <div className="flex items-center gap-2">
                    {/* 持续嗅探总开关：打开 = 切页自动三轮扫描 + 主进程网络层持续推送；
                        关闭 = 两者全停。手动"重新扫描"是一次性的，不受开关影响 */}
                    <button
                        onClick={() => actions.setSniffEnabled(!sniffEnabled)}
                        className={`${BTN_GHOST} ${sniffEnabled ? 'border-emerald-400/40 text-emerald-300' : ''}`}
                        title={sniffEnabled ? '关闭持续嗅探：切页不再自动扫描，主进程也不再推送' : '打开持续嗅探：切页自动扫描，主进程持续推送新资源'}
                        aria-pressed={sniffEnabled}
                    >
                        {sniffEnabled ? <ToggleRight className="h-3.5 w-3.5 text-emerald-400" /> : <ToggleLeft className="h-3.5 w-3.5" />}
                        <span>持续嗅探</span>
                    </button>
                    <button
                        onClick={() => actions.scan(currentUrl)}
                        disabled={isAnalyzing}
                        className={BTN_GHOST}
                        title="刷新当前页面嗅探扫描"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${isAnalyzing ? 'animate-spin text-indigo-400' : ''}`} />
                        <span>重新扫描</span>
                    </button>
                    <button
                        onClick={() => (scopeFilter === 'current' ? actions.clearCurrentPage(currentUrl) : actions.clear())}
                        disabled={!canClear}
                        className={`${BTN_GHOST} hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-300`}
                        title={scopeFilter === 'current' ? '清空当前页面嗅探列表' : '清空所有嗅探列表'}
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>{scopeFilter === 'current' ? '清空当前' : '清空全部'}</span>
                    </button>
                </div>
            </div>

            {/* AI 深度嗅探引导 */}
            {currentUrl && (
                <div className="mt-3 flex shrink-0 items-center justify-between gap-3 rounded-2xl border border-indigo-400/15 bg-gradient-to-r from-indigo-500/10 via-fuchsia-500/5 to-transparent px-3.5 py-2.5">
                    <div className="text-xs text-indigo-200">
                        加密媒体或复杂 SPA？可调取 AI 进行 DOM 与深层网络结构挖掘。
                    </div>
                    <button
                        onClick={onAiAnalyze}
                        disabled={isAnalyzing}
                        className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-indigo-300/30 bg-indigo-500/20 px-3 py-1.5 text-xs font-bold text-indigo-100 transition hover:border-indigo-300/50 hover:bg-indigo-500/30 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
                    >
                        <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
                        AI 深度嗅探
                    </button>
                </div>
            )}

            {/* 筛选条：分类 + 页面范围 */}
            <div className="mt-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
                <div className={`flex items-center gap-1 overflow-x-auto rounded-2xl p-1 scrollbar-thin ${SURFACE_SUNKEN}`}>
                    <span className="pl-1.5 pr-1 text-slate-500">
                        <ListFilter className="h-3.5 w-3.5" />
                    </span>
                    {SNIFF_FILTERS.map((item) => (
                        <button
                            key={item.value}
                            onClick={() => actions.setFilterType(item.value)}
                            className={`whitespace-nowrap rounded-xl px-2.5 py-1 text-xs font-medium transition ${FOCUS_RING} ${filterType === item.value
                                ? 'bg-indigo-500 text-white shadow-sm'
                                : 'text-slate-300 hover:bg-white/[0.12] hover:text-white'
                                }`}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>

                <div className="flex shrink-0 items-center rounded-xl border border-white/10 bg-black/20 p-0.5">
                    {(
                        [
                            { value: 'all', label: '全部历史' },
                            { value: 'current', label: '仅当前页' },
                        ] as const
                    ).map((option) => (
                        <button
                            key={option.value}
                            onClick={() => actions.setScopeFilter(option.value)}
                            className={`rounded-lg px-2 py-0.5 text-[11px] font-medium transition ${FOCUS_RING} ${scopeFilter === option.value ? 'bg-white/[0.12] text-white' : 'text-slate-400 hover:text-slate-200'
                                }`}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            {filterType === 'stream' && (
                <div
                    className={`mt-2.5 shrink-0 rounded-xl border px-3.5 py-1.5 text-[11px] ${ffmpegAvailable
                        ? 'border-emerald-400/15 bg-emerald-500/10 text-emerald-200'
                        : 'border-amber-400/15 bg-amber-500/10 text-amber-200'
                        }`}
                >
                    {downloadCapabilities.ffmpegMessage}
                </div>
            )}

            <div className="custom-scrollbar mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
                {filteredLinks.length === 0 ? (
                    <EmptyHint icon={<FileQuestion className="h-6 w-6" />} title="暂未嗅探到符合条件的媒体资源">
                        <div className="flex items-center gap-2 text-xs">
                            <button onClick={() => actions.scan(currentUrl)} className={`text-indigo-400 hover:underline ${FOCUS_RING}`}>
                                重新扫描当前页
                            </button>
                            {filterType !== 'all' && (
                                <>
                                    <span className="text-slate-600">·</span>
                                    <button
                                        onClick={() => actions.setFilterType('all')}
                                        className={`text-indigo-400 hover:underline ${FOCUS_RING}`}
                                    >
                                        查看全部资源
                                    </button>
                                </>
                            )}
                        </div>
                    </EmptyHint>
                ) : (
                    filteredLinks.map((link, index) => {
                        // 判据与主进程、与 useBrowse 的 download 同源（const.ts 的 requiresFfmpeg）：
                        // 只看 type 会漏掉"ext=flv 但 type=video"这类 AI 提取产物，
                        // 界面按钮照常可点、主进程却会走 ffmpeg，点下去才报错。
                        const needsFfmpeg = requiresFfmpeg(link.type, link.ext);
                        const canDownload = !needsFfmpeg || ffmpegAvailable;
                        const downloadHint =
                            needsFfmpeg
                                ? ffmpegAvailable
                                    ? '使用 ffmpeg 下载流媒体资源'
                                    : downloadCapabilities.ffmpegMessage
                                : '下载资源';

                        return (
                            <SniffCard
                                // 不用 index：addLinks 已按 url 去重，url 天然唯一；
                                // 带上 index 后每次筛选/排序都会让所有卡片重挂载，copied 状态和滚动位置一起丢
                                key={link.url}
                                index={index}
                                link={link}
                                isDownloading={downloadingUrl === link.url}
                                // 只把属于这条的进度传下去：否则同时下载多条时每条都会画同一条进度
                                progress={downloadingUrl === link.url ? downloadProgress : null}
                                canDownload={canDownload}
                                downloadHint={downloadHint}
                                onDownload={handleDownload}
                                onPlay={onPlay}
                                onCancel={handleCancel}
                            />
                        );
                    })
                )}
            </div>

            {/*
        状态栏。下载进行中时它升级成**进度条 + 明细**，这是用户唯一能确认
        "到底下到哪了、是死是活"的地方：此前它只显示一句一次性设置的静态文案
        （"正在使用 ffmpeg 下载流媒体..."），从开始到结束都不变，
        既看不出进度，也分不清"还在下"和"已经卡死"。

        进度条与卡片上的那条同源（downloadProgress），但这里额外给出
        文件名、百分比、已下字节、速度、跳过段数 —— 卡片放不下这些。
      */}
            {downloadingUrl ? (
                <div className={`mt-3 shrink-0 rounded-2xl px-3.5 py-2.5 ${SURFACE_SUNKEN}`}>
                    <div className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2 text-[11px] text-slate-300">
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-400" />
                            <span className="truncate" title={downloadingUrl}>
                                正在下载 {currentDownloadTitle}
                            </span>
                        </span>
                        <button
                            onClick={handleCancel}
                            className={`shrink-0 rounded-lg px-2 py-0.5 text-[11px] text-slate-400 transition hover:bg-rose-500/10 hover:text-rose-300 ${FOCUS_RING}`}
                        >
                            取消
                        </button>
                    </div>

                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                        {downloadProgress?.percent !== null && downloadProgress?.percent !== undefined ? (
                            <div
                                className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400 transition-[width] duration-300"
                                style={{ width: `${downloadProgress.percent}%` }}
                            />
                        ) : (
                            <div className="bp-indeterminate h-full w-1/3 rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400" />
                        )}
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[11px] text-slate-400">
                        {downloadProgress ? (
                            <>
                                {downloadProgress.percent !== null && (
                                    <span className="font-semibold text-slate-200">{downloadProgress.percent}%</span>
                                )}
                                {downloadProgress.totalSeconds > 0 && (
                                    <span>
                                        {fmtClock(downloadProgress.processedSeconds)} / {fmtClock(downloadProgress.totalSeconds)}
                                    </span>
                                )}
                                {downloadProgress.receivedBytes > 0 && <span>{formatBytes(downloadProgress.receivedBytes)}</span>}
                                {downloadProgress.speed > 0 && <span>{downloadProgress.speed.toFixed(1)}x</span>}
                                {downloadProgress.skippedSegments > 0 && (
                                    <span className="text-amber-400">已跳过 {downloadProgress.skippedSegments} 段</span>
                                )}
                            </>
                        ) : (
                            <span>正在建立连接…</span>
                        )}
                    </div>
                </div>
            ) : (
                statusMessage && (
                    <div
                        className={`mt-3 shrink-0 rounded-2xl px-4 py-2 text-center text-[11px] ${/失败|错误|无法|取消/.test(statusMessage)
                            ? 'border border-rose-500/25 bg-rose-500/10 text-rose-300'
                            : /跳过|缺失/.test(statusMessage)
                                ? 'border border-amber-500/25 bg-amber-500/10 text-amber-300'
                                : `text-slate-400 ${SURFACE_SUNKEN}`
                            }`}
                    >
                        <p className="break-words">{statusMessage}</p>
                    </div>
                )
            )}
        </div>
    );
};

/* ========================================================================== */
/*                              设置                                           */
/* ========================================================================== */

const FIELD_CLS = `w-full rounded-2xl border border-white/10 bg-slate-950 py-3 pl-11 pr-4 font-mono text-sm text-slate-200 outline-none transition placeholder:text-slate-600 ${FOCUS_RING}`;

const SETTINGS_BTN = `flex items-center justify-center gap-2 rounded-2xl px-4 py-3 font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`;

/** 预设地址去掉协议头，用作服务商按钮的副标题 */
const providerHost = (baseUrl: string): string => baseUrl.replace(/^https?:\/\//i, '');

/** 档位展示：不下发写成「不思考」，映射后取值不同才写出箭头 */
const formatEffort = (config: AiConfig): string => {
    const wire = resolveReasoningEffort(config);
    if (!wire) return '不思考';
    return wire === config.reasoningEffort ? wire : `${config.reasoningEffort} → ${wire}`;
};

/**
 * 设置面板：网络代理 + AI 服务，两处配置合并在一页。
 *
 * 代理语义（与主进程 electron/settings.js 一致）：
 * - 留空 = 一律直连，不读系统代理、不做探测。Proton VPN 这类 TUN 模式 VPN
 *   在网卡层接管流量，直连本身就是被代理着的；
 * - 有值 = 用该端口走隧道。只填数字默认 127.0.0.1，协议（HTTP / SOCKS5）自动识别；
 *   也可以显式写 socks5:// 或 http:// 前缀跳过识别。
 *
 * AI 语义：
 * - 走 OpenAI 兼容协议（POST {baseUrl}/chat/completions）；
 * - 服务商是填表模板（AiService 的 AI_PROVIDERS）：点一下填好地址、密钥与模型；
 * - 思考强度可选：不思考 / 低 / 高 / 最大，各家取值可能不同，
 *   下发前由 AiService.resolveReasoningEffort 映射，实际下发的取值显示在按钮下方；
 *   「不思考」与不需要思考的服务商（gcli2api）都不下发 reasoning_effort；
 * - 配置落在主进程 settings.json（浏览器调试时回落 localStorage，见 AiService）。
 *
 * 保存值落在主进程 userData/settings.json：主进程启动时（渲染层还没起来）
 * 就要知道走不走代理，localStorage 那时读不到。
 */
const SettingsFloating: React.FC = () => {
    const settingsApi = getElectronAPI()?.settings;

    /* ------------------------------ 代理端口 ------------------------------ */
    const [draft, setDraft] = useState('');
    const [savedValue, setSavedValue] = useState('');
    // 主进程当前真正生效的端点（配了端口但连不上时会是空 → 界面区分"已配置"与"已生效"）
    const [applied, setApplied] = useState('');
    // 主进程探测/识别出的隧道协议：裸端口时用户没写协议，靠它显示实际走的是哪种
    const [proxyProtocol, setProxyProtocol] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState<'idle' | 'saved' | 'cleared'>('idle');

    /* ------------------------------ AI 服务 ------------------------------ */
    const [aiDraft, setAiDraft] = useState<AiConfig>(DEFAULT_AI_CONFIG);
    const [aiSaved, setAiSaved] = useState<AiConfig>(DEFAULT_AI_CONFIG);
    const [aiError, setAiError] = useState('');
    const [aiStatus, setAiStatus] = useState<'idle' | 'saved'>('idle');
    const [isAiSaving, setIsAiSaving] = useState(false);
    const [isKeyVisible, setIsKeyVisible] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

    // 初次进入读一次主进程配置，避免界面显示与服务端实际不一致
    useEffect(() => {
        let cancelled = false;
        if (!settingsApi) {
            setIsLoading(false);
            return;
        }
        settingsApi
            .get()
            .then((res) => {
                if (cancelled) return;
                setSavedValue(res.proxyPort || '');
                setDraft(res.proxyPort || '');
                setApplied(res.applied || '');
                setProxyProtocol(res.proxyProtocol || '');
                if (res.ai) {
                    setAiSaved(res.ai);
                    setAiDraft(res.ai);
                }
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : '读取设置失败');
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [settingsApi]);

    useEffect(() => {
        if (status === 'idle') return;
        const timer = window.setTimeout(() => setStatus('idle'), 2200);
        return () => window.clearTimeout(timer);
    }, [status]);

    useEffect(() => {
        if (aiStatus === 'idle') return;
        const timer = window.setTimeout(() => setAiStatus('idle'), 2200);
        return () => window.clearTimeout(timer);
    }, [aiStatus]);

    const handleSave = useCallback(async () => {
        if (!settingsApi) return;
        setIsSaving(true);
        setError('');
        try {
            const res = await settingsApi.setProxyPort(draft);
            if (!res.success) {
                setError(res.message || '保存失败');
                return;
            }
            setSavedValue(res.proxyPort || '');
            setDraft(res.proxyPort || '');
            setApplied(res.applied || '');
            setProxyProtocol(res.proxyProtocol || '');
            setStatus(res.proxyPort ? 'saved' : 'cleared');
        } catch (err) {
            setError(err instanceof Error ? err.message : '保存失败');
        } finally {
            setIsSaving(false);
        }
    }, [draft, settingsApi]);

    const handleClear = useCallback(() => {
        setDraft('');
        setError('');
    }, []);

    /* ------------------------------ AI 操作 ------------------------------ */

    // 改任意字段都清掉上一次的测试结论：它对应的是旧配置，留着会误导
    const patchAiDraft = useCallback((patch: Partial<AiConfig>) => {
        setAiDraft((prev) => ({ ...prev, ...patch }));
        setAiError('');
        setTestResult(null);
    }, []);

    // 草稿地址对应的服务商：档位映射与模型候选都看它
    const activeProvider = useMemo(() => findAiProvider(aiDraft.baseUrl), [aiDraft.baseUrl]);
    const modelPresets = useMemo(() => getModelPresets(aiDraft.baseUrl), [aiDraft.baseUrl]);
    /** 自定义地址（不在预设表里）按需要思考处理，与 AiService 的判定一致 */
    const supportsReasoning = activeProvider?.reasoning !== false;

    /** 各档位 + 实际下发的取值（显示用）；wire 为空即「不下发」 */
    const effortRows = useMemo(
        () => EFFORT_OPTIONS.map((option) => ({ ...option, wire: resolveReasoningEffort(aiDraft, option.value) })),
        [aiDraft]
    );

    /** 套用预设：地址、密钥、模型整份换，档位取中间一档 */
    const applyAiProvider = useCallback((preset: AiProviderPreset) => {
        setAiDraft((prev) => ({
            baseUrl: preset.baseUrl,
            apiKey: preset.apiKey,
            model: preset.models[0] || prev.model,
            // 不需要思考的服务商留空（= 不思考），否则会显示一个永远不会下发的档位
            reasoningEffort: preset.reasoning === false ? undefined : 'high',
        }));
        setAiError('');
        setTestResult(null);
    }, []);

    const handleSaveAi = useCallback(async () => {
        setIsAiSaving(true);
        setAiError('');
        try {
            const res = await saveAiConfig(aiDraft);
            if (!res.success) {
                setAiError(res.message || '保存失败');
                return;
            }
            const next = res.ai || aiDraft;
            setAiSaved(next);
            setAiDraft(next);
            setAiStatus('saved');
        } catch (err) {
            setAiError(err instanceof Error ? err.message : '保存失败');
        } finally {
            setIsAiSaving(false);
        }
    }, [aiDraft]);

    const handleTestAi = useCallback(async () => {
        setIsTesting(true);
        setTestResult(null);
        setAiError('');
        try {
            const res = await testAiConnection(aiDraft);
            setTestResult({
                ok: res.success,
                text: res.success
                    ? `${res.message}${res.model ? ` · 模型 ${res.model}` : ''}${res.reply ? ` · 回复「${res.reply.trim()}」` : ''}`
                    : res.message,
            });
        } catch (err) {
            setTestResult({ ok: false, text: err instanceof Error ? err.message : '测试失败' });
        } finally {
            setIsTesting(false);
        }
    }, [aiDraft]);

    const isAiDirty = useMemo(
        () =>
            aiDraft.baseUrl !== aiSaved.baseUrl ||
            aiDraft.apiKey !== aiSaved.apiKey ||
            aiDraft.model !== aiSaved.model ||
            aiDraft.reasoningEffort !== aiSaved.reasoningEffort,
        [aiDraft, aiSaved]
    );

    const isDirty = draft.trim() !== savedValue;
    // 配了端口但 applied 为空 → 端口连不上，服务层已回落直连
    const isConfiguredButDead = Boolean(savedValue) && !applied;
    const isDirect = !savedValue;
    // 协议标签：只在真正生效时显示，避免"直连模式（SOCKS5）"这种自相矛盾的组合
    const protocolLabel = proxyProtocol === 'socks5' ? 'SOCKS5' : proxyProtocol === 'http' ? 'HTTP' : '';

    return (
        <div className="custom-scrollbar flex h-full flex-col gap-5 overflow-y-auto pb-1 pr-1">
            {/* ======================= 分区一：网络与代理 ======================= */}
            <section>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <Wifi className="h-4 w-4 text-sky-400" />
                        <h4 className="text-sm font-bold text-slate-200">网络与代理</h4>
                    </div>
                    <span
                        className={`rounded-full border px-3 py-1 text-[11px] ${isDirect
                            ? 'border-white/10 bg-white/[0.06] text-slate-400'
                            : isConfiguredButDead
                                ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            }`}
                    >
                        {isDirect ? '直连模式' : isConfiguredButDead ? '端口不可用' : '代理已生效'}
                    </span>
                </div>

                <div className={`mt-3 rounded-2xl p-4 ${SURFACE_SUNKEN}`}>
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">当前状态</span>
                        {isLoading ? (
                            <span className="flex items-center gap-1.5 text-xs text-slate-400">
                                <Loader2 className="h-3 w-3 animate-spin" /> 读取中
                            </span>
                        ) : (
                            <span className="text-xs text-slate-400">
                                {isDirect
                                    ? '所有请求直连'
                                    : `经 ${applied || savedValue} 建立隧道${protocolLabel ? `（${protocolLabel}）` : ''}`}
                            </span>
                        )}
                    </div>
                    <div className="mt-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono text-sm text-slate-300">
                        {isDirect ? '未使用代理（直连）' : applied || savedValue}
                    </div>
                    {isConfiguredButDead && (
                        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300/90">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>
                                已保存 {savedValue}，但该端口当前连不上，本轮已自动回落直连。请确认代理软件已启动、端口填写正确。
                            </span>
                        </p>
                    )}
                    {!isDirect && !isConfiguredButDead && protocolLabel && (
                        <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
                            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>
                                已自动识别为 {protocolLabel} 代理。抓取与内置浏览器均走此隧道；本地服务（AI 网关、开发服务器）始终直连，不受影响。
                            </span>
                        </p>
                    )}
                </div>

                <div className="mt-4 space-y-2">
                    <label htmlFor="fp-proxy-port" className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
                        代理端口
                    </label>
                    <div className="relative">
                        <Plug className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                        <input
                            id="fp-proxy-port"
                            type="text"
                            value={draft}
                            onChange={(event) => {
                                setDraft(event.target.value);
                                setError('');
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') void handleSave();
                            }}
                            placeholder="留空 = 直连，例如 10808 或 socks5://127.0.0.1:10808"
                            spellCheck={false}
                            className={`${FIELD_CLS} focus:border-sky-500/60`}
                        />
                    </div>
                    {error && (
                        <p className="flex items-start gap-1.5 text-xs text-rose-400">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>{error}</span>
                        </p>
                    )}
                    <p className="text-xs text-slate-500">
                        只填端口号默认走 127.0.0.1，并自动识别该端口是 HTTP 还是 SOCKS5 代理。保存后立即生效，无需重启。
                    </p>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                    <button
                        onClick={() => void handleSave()}
                        disabled={isSaving || isLoading || (!isDirty && !error)}
                        className={`${SETTINGS_BTN} bg-sky-500 text-black hover:bg-sky-400`}
                    >
                        {status === 'saved' ? (
                            <Check className="h-4 w-4" />
                        ) : isSaving ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Save className="h-4 w-4" />
                        )}
                        {status === 'saved' ? '已保存' : '保存'}
                    </button>
                    <button
                        onClick={handleClear}
                        disabled={isLoading}
                        className={`${SETTINGS_BTN} border border-white/10 bg-zinc-900 text-slate-300 hover:bg-zinc-800`}
                    >
                        <Globe className="h-4 w-4" />
                        {status === 'cleared' ? '已切直连' : '清空（直连）'}
                    </button>
                </div>

                <div className={`mt-4 space-y-2 rounded-2xl p-4 text-xs leading-6 text-slate-400 ${SURFACE_SUNKEN}`}>
                    <p>
                        1. <strong className="text-slate-300">留空即直连</strong>：应用不会读取系统代理，也不做端口探测。使用
                        Proton VPN 等 TUN 模式 VPN 时选这项——流量在网卡层已被接管，无需本地代理端口。
                    </p>
                    <p>
                        2. <strong className="text-slate-300">填入端口</strong>
                        ：抓取站点的请求与内置浏览器都走该端口的隧道。HTTP 与 SOCKS5 都支持，只填裸端口会自动识别——v2rayN 的
                        10808 是 SOCKS5、10809 是 HTTP，Clash 的 7890 是 HTTP、7891 是 SOCKS5，填错端口会连不上。
                    </p>
                    <p>
                        3. <strong className="text-slate-300">想指定协议</strong>：写{' '}
                        <code className="rounded bg-black/40 px-1 font-mono text-slate-300">socks5://127.0.0.1:10808</code>{' '}
                        即可跳过自动识别。端口必须写对——SOCKS5 与 HTTP 的端口通常只差一位数字。
                    </p>
                    <p>4. 填写后若端口连不上，本轮会自动回落直连，并在上方提示，不会让请求全部失败。</p>
                </div>
            </section>

            {/* ======================= 分区二：AI 服务 ======================= */}
            <section className="border-t border-white/10 pt-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <BrainCircuit className="h-4 w-4 text-violet-400" />
                        <h4 className="text-sm font-bold text-slate-200">AI 服务</h4>
                    </div>
                    <span className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-0.5 text-[11px] text-slate-400">
                        OpenAI 兼容协议
                    </span>
                </div>

                <div className="mt-3 space-y-2">
                    <span className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">服务商</span>
                    <div className="grid grid-cols-2 gap-2" role="group" aria-label="服务商">
                        {AI_PROVIDERS.map((preset) => {
                            const isActive = activeProvider?.id === preset.id;
                            return (
                                <button
                                    key={preset.id}
                                    type="button"
                                    onClick={() => applyAiProvider(preset)}
                                    title={preset.note}
                                    aria-pressed={isActive}
                                    className={`flex flex-col items-center gap-0.5 rounded-2xl border px-3 py-2.5 transition ${FOCUS_RING} ${isActive
                                        ? 'border-violet-500/50 bg-violet-500/15 text-violet-200'
                                        : 'border-white/10 bg-slate-950 text-slate-400 hover:border-white/20 hover:text-slate-200'
                                        }`}
                                >
                                    <span className="text-sm font-bold">{preset.label}</span>
                                    <span className="w-full truncate text-center text-[10px] text-slate-500">
                                        {providerHost(preset.baseUrl)}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className={`mt-4 rounded-2xl p-4 ${SURFACE_SUNKEN}`}>
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">当前生效</span>
                        <span className="truncate text-xs text-slate-400">{aiSaved.model}</span>
                    </div>
                    <div className="mt-3 space-y-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-slate-300">
                        <div className="truncate">{aiSaved.baseUrl}</div>
                        <div className="text-slate-500">
                            密钥 {aiSaved.apiKey ? `${aiSaved.apiKey.slice(0, 3)}***` : '（空）'} · 思考强度{' '}
                            {formatEffort(aiSaved)}
                        </div>
                    </div>
                </div>

                <div className="mt-4 space-y-2">
                    <label htmlFor="fp-ai-base" className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
                        接口地址 (Base URL)
                    </label>
                    <div className="relative">
                        <Link2 className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                        <input
                            id="fp-ai-base"
                            type="text"
                            value={aiDraft.baseUrl}
                            onChange={(event) => patchAiDraft({ baseUrl: event.target.value })}
                            placeholder="http://127.0.0.1:7863/v1"
                            spellCheck={false}
                            className={`${FIELD_CLS} focus:border-violet-500/60`}
                        />
                    </div>
                    <p className="text-xs text-slate-500">需包含版本段（/v1），末尾斜杠会自动去掉。</p>
                </div>

                <div className="mt-4 space-y-2">
                    <label htmlFor="fp-ai-key" className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
                        密钥 (API Key)
                    </label>
                    <div className="relative">
                        <KeyRound className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                        <input
                            id="fp-ai-key"
                            type={isKeyVisible ? 'text' : 'password'}
                            value={aiDraft.apiKey}
                            onChange={(event) => patchAiDraft({ apiKey: event.target.value })}
                            placeholder="本地服务可留空"
                            spellCheck={false}
                            className={`${FIELD_CLS} pr-12 focus:border-violet-500/60`}
                        />
                        <button
                            onClick={() => setIsKeyVisible((prev) => !prev)}
                            className={`absolute right-3 top-1/2 -translate-y-1/2 rounded text-slate-500 transition-colors hover:text-slate-200 ${FOCUS_RING}`}
                            title={isKeyVisible ? '隐藏密钥' : '显示密钥'}
                            aria-label={isKeyVisible ? '隐藏密钥' : '显示密钥'}
                            type="button"
                        >
                            {isKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                    </div>
                </div>

                <div className="mt-4 space-y-2">
                    <label htmlFor="fp-ai-model" className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
                        模型
                    </label>
                    <div className="relative">
                        <Cpu className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                        <input
                            id="fp-ai-model"
                            type="text"
                            value={aiDraft.model}
                            onChange={(event) => patchAiDraft({ model: event.target.value })}
                            placeholder={modelPresets[0] || 'global:deepseek-v4.1-flash'}
                            spellCheck={false}
                            className={`${FIELD_CLS} focus:border-violet-500/60`}
                        />
                    </div>
                    {/* 候选常驻显示：datalist 按下拉里的当前值过滤，只看得到已选的那个 */}
                    {modelPresets.length > 0 && (
                        <div className="flex flex-wrap gap-2" role="group" aria-label="模型候选">
                            {modelPresets.map((name) => {
                                const isActive = aiDraft.model === name;
                                return (
                                    <button
                                        key={name}
                                        type="button"
                                        onClick={() => patchAiDraft({ model: name })}
                                        title={name}
                                        aria-pressed={isActive}
                                        className={`max-w-full truncate rounded-full border px-3 py-1 font-mono text-[11px] transition ${FOCUS_RING} ${isActive
                                            ? 'border-violet-500/50 bg-violet-500/15 text-violet-200'
                                            : 'border-white/10 bg-slate-950 text-slate-400 hover:border-white/20 hover:text-slate-200'
                                            }`}
                                    >
                                        {name}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="mt-4 space-y-2">
                    <span className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">思考强度</span>
                    <div className="grid grid-cols-3 gap-2" role="group" aria-label="思考强度">
                        {effortRows.map((option) => {
                            const isActive = aiDraft.reasoningEffort === option.value;
                            // 不需要思考的服务商：三档按钮点了也不会被下发，标灰避免误解
                            const isMuted = !supportsReasoning && option.value !== undefined;
                            return (
                                <button
                                    key={option.value ?? 'none'}
                                    type="button"
                                    onClick={() => patchAiDraft({ reasoningEffort: option.value })}
                                    title={option.hint}
                                    aria-pressed={isActive}
                                    disabled={isMuted}
                                    className={`flex flex-col items-center gap-0.5 rounded-2xl border px-3 py-2.5 transition disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING} ${isActive
                                        ? 'border-violet-500/50 bg-violet-500/15 text-violet-200'
                                        : 'border-white/10 bg-slate-950 text-slate-400 hover:border-white/20 hover:text-slate-200'
                                        }`}
                                >
                                    <span className="flex items-center gap-1.5 text-sm font-bold">
                                        {isActive && <Zap className="h-3.5 w-3.5" />}
                                        {option.label}
                                    </span>
                                    <span className="max-w-full truncate font-mono text-[10px] text-slate-500">
                                        {option.wire ?? '不下发'}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    {!supportsReasoning && (
                        <p className="text-xs text-slate-500">
                            该服务商不需要思考档位（档位在模型名里），请求不会下发 reasoning_effort。
                        </p>
                    )}
                </div>

                {aiError && (
                    <p className="mt-3 flex items-start gap-1.5 text-xs text-rose-400">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{aiError}</span>
                    </p>
                )}

                {testResult && (
                    <p
                        className={`mt-3 flex items-start gap-1.5 text-xs ${testResult.ok ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                    >
                        {testResult.ok ? (
                            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        ) : (
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="break-all">{testResult.text}</span>
                    </p>
                )}

                <div className="mt-4 grid grid-cols-2 gap-3">
                    <button
                        onClick={() => void handleSaveAi()}
                        disabled={isAiSaving || (!isAiDirty && !aiError)}
                        className={`${SETTINGS_BTN} bg-violet-500 text-black hover:bg-violet-400`}
                    >
                        {aiStatus === 'saved' ? (
                            <Check className="h-4 w-4" />
                        ) : isAiSaving ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Save className="h-4 w-4" />
                        )}
                        {aiStatus === 'saved' ? '已保存' : '保存配置'}
                    </button>
                    <button
                        onClick={() => void handleTestAi()}
                        disabled={isTesting}
                        className={`${SETTINGS_BTN} border border-white/10 bg-zinc-900 text-slate-300 hover:bg-zinc-800`}
                    >
                        {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                        {isTesting ? '测试中' : '测试连接'}
                    </button>
                </div>

                <div className={`mt-4 space-y-2 rounded-2xl p-4 text-xs leading-6 text-slate-400 ${SURFACE_SUNKEN}`}>
                    <p>
                        1. <strong className="text-slate-300">测试连接用草稿配置</strong>
                        ：不会写盘，可以先验证地址、密钥、模型三者是否可用再决定保存。
                    </p>
                    <p>
                        2. <strong className="text-slate-300">密钥存在主进程</strong>
                        ：落盘在 userData/settings.json，不写入浏览器 localStorage。
                    </p>
                    <p>3. 资源嗅探的 AI 深度分析与音频工作台的代码生成共用这份配置。</p>
                </div>
            </section>
        </div>
    );
};

/* ========================================================================== */
/*                              运行日志                                       */
/* ========================================================================== */

/** 列表最多渲染条数：console 输出可能刷屏，渲染层只看最近的 */
const LOG_RENDER_CAP = 300;
/** 距底部多少像素内算"贴底"：贴底时新日志自动跟随，上翻看历史就暂停跟随 */
const LOG_STICK_PX = 24;

const LOG_LEVEL_TONES: Record<LogLevel, string> = {
    error: 'bg-rose-500/15 text-rose-300',
    warn: 'bg-amber-500/15 text-amber-300',
    info: 'bg-cyan-500/15 text-cyan-300',
    debug: 'bg-violet-500/15 text-violet-300',
    log: 'bg-white/10 text-slate-300',
};

const LOG_FILTERS: { value: 'all' | LogLevel; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'error', label: '错误' },
    { value: 'warn', label: '警告' },
    { value: 'info', label: '信息' },
    { value: 'debug', label: '调试' },
    { value: 'log', label: '普通' },
];

const fmtLogTime = (ms: number): string => {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (v: number, w = 2) => String(v).padStart(w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

/**
 * 运行日志面板：渲染进程的全部 console 输出。
 *
 * 隐藏时不订阅：面板是 keep-alive 常驻的，若始终订阅，每条 console 输出
 * 都会把隐藏的面板重渲染一遍。用 activeRef 门控，tab 切走即断开订阅，
 * 版本号冻结在离开时的值，重进才继续跟。
 */
const LogsFloating: React.FC<{ active: boolean }> = ({ active }) => {
    const [levelFilter, setLevelFilter] = useState<'all' | LogLevel>(() => {
        const saved = loadJSON<'all' | LogLevel>('log-level-filter', 'all');
        return saved === 'all' || (LOG_LEVEL_TONES as Record<string, string>)[saved] ? saved : 'all';
    });
    const [query, setQuery] = useState('');
    const activeRef = useRef(active);
    activeRef.current = active;
    const listRef = useRef<HTMLDivElement | null>(null);
    const stickRef = useRef(true);

    useEffect(() => {
        saveJSON('log-level-filter', levelFilter);
    }, [levelFilter]);

    // 订阅包装一层门控：面板 keep-alive 常驻，tab 切走即断开订阅，
    // 版本号冻结在离开时的值，重进才继续跟 —— 否则每条 console 都重渲染隐藏面板
    const subscribe = useCallback((listener: () => void) => {
        if (!activeRef.current) return () => {};
        return subscribeLogs(listener);
    }, []);

    const version = useSyncExternalStore(subscribe, getLogVersion);

    const { visible, total, counts } = useMemo(() => {
        const all = getLogEntries();
        const counts: Record<'all' | LogLevel, number> = {
            all: all.length,
            error: 0,
            warn: 0,
            info: 0,
            debug: 0,
            log: 0,
        };
        for (const e of all) counts[e.level] += 1;
        const q = query.trim().toLowerCase();
        const filtered = all.filter(
            (e) =>
                (levelFilter === 'all' || e.level === levelFilter) &&
                (q === '' || e.message.toLowerCase().includes(q))
        );
        const visible = filtered.length > LOG_RENDER_CAP ? filtered.slice(-LOG_RENDER_CAP) : filtered;
        return { visible, total: all.length, counts };
        // version 只做重渲染触发器：读它让 useSyncExternalStore 的每次广播都重算
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [version, levelFilter, query]);

    // 新日志进来且贴底时跟随到底；用户上翻看历史时不动滚动条
    useEffect(() => {
        const el = listRef.current;
        if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    }, [version]);

    const handleScroll = useCallback(() => {
        const el = listRef.current;
        if (!el) return;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= LOG_STICK_PX;
    }, []);

    return (
        <div className="flex h-full min-h-0 flex-col gap-3">
            {/* 工具条：级别过滤 + 搜索 + 清空 */}
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {LOG_FILTERS.map(({ value: f, label }) => (
                    <button
                        key={f}
                        onClick={() => setLevelFilter(f)}
                        className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${FOCUS_RING} ${levelFilter === f
                            ? 'bg-white/[0.12] text-white'
                            : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-200'
                            }`}
                        title={`只看${label}（${counts[f]} 条）`}
                    >
                        {label}
                        <span className="ml-1 text-[10px] opacity-70">{counts[f]}</span>
                    </button>
                ))}
                <div className="flex-1" />
                <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="搜索日志内容"
                        aria-label="搜索日志内容"
                        className={`w-40 rounded-lg border border-white/10 bg-white/[0.06] py-1.5 pl-7 pr-2 text-xs text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-indigo-400/50 ${FOCUS_RING}`}
                    />
                </div>
                <button onClick={() => clearLogs()} className={BTN_GHOST} title="清空内存与落盘的全部日志">
                    <Trash2 className="h-3 w-3" /> 清空
                </button>
            </div>

            {/* 日志列表：role="log" 让读屏软件知道这是实时追加区 */}
            <div
                ref={listRef}
                onScroll={handleScroll}
                role="log"
                aria-label="运行日志"
                className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1"
            >
                {visible.length === 0 && (
                    <EmptyHint icon={<ScrollText className="h-6 w-6" />} title="暂无日志">
                        <p className="max-w-md text-xs leading-5 text-slate-500">
                            渲染进程的 console 输出会实时出现在这里。
                            <br />
                            主进程（终端里）的日志不在此列。
                        </p>
                    </EmptyHint>
                )}
                {visible.map((e) => (
                    <div key={e.seq} className={`rounded-lg px-2.5 py-1.5 ${SURFACE_SUNKEN}`}>
                        <div className="flex items-center gap-2">
                            <span className="shrink-0 font-mono text-[10px] text-slate-500">{fmtLogTime(e.ts)}</span>
                            <span
                                className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${LOG_LEVEL_TONES[e.level]}`}
                            >
                                {e.level}
                            </span>
                        </div>
                        <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-slate-300">
                            {e.message}
                        </div>
                    </div>
                ))}
            </div>

            <p className="shrink-0 text-[11px] text-slate-500">
                共 {total} 条（内存上限 {LOG_BUFFER_CAP}，落盘保留最近 {LOG_PERSIST_CAP} 条）
                {total > LOG_RENDER_CAP && levelFilter === 'all' && query.trim() === ''
                    ? `，列表仅显示最近 ${LOG_RENDER_CAP} 条`
                    : ''}
            </p>
        </div>
    );
};

/* ========================================================================== */
/*                              悬浮球外壳                                     */
/* ========================================================================== */

export const Floating: React.FC<FloatingProps> = ({ sniffer, currentUrl, onPlay, onAiAnalyze }) => {
    const [isOpen, setIsOpen] = useState(false);
    // 悬浮球位置落盘：退出 App 重进也在上次的位置
    const [position, setPosition] = useState(() => {
        const saved = loadJSON<{ x: number; y: number } | null>('ball-pos', null);
        const fallback = {
            x: typeof window !== 'undefined' ? window.innerWidth - 88 : 1000,
            y: typeof window !== 'undefined' ? window.innerHeight - 180 : 600,
        };
        if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return fallback;
        return clampPosition(saved.x, saved.y);
    });
    const [isDragging, setIsDragging] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [isIdle, setIsIdle] = useState(false);

    /**
     * 读回上次停留的面板。
     *
     * 存量用户落盘的可能是 'agent' / 'tamper'（那时它们还在悬浮球里），
     * 或 'torrent'（磁力下载已迁到浏览器全屏页 TorrentPanel）。
     * 这三个键已不在 PANEL_META 里，不映射的话打开就是空白页 —— 回落成 'sniff'。
     */
    const readStoredPanel = useCallback((): FloatingPanelType => {
        const saved = loadJSON<string>('panel', 'sniff');
        if (saved === 'agent' || saved === 'tamper' || saved === 'torrent') return 'sniff';
        const all = Object.keys(PANEL_META) as FloatingPanelType[];
        return all.includes(saved as FloatingPanelType) ? (saved as FloatingPanelType) : 'sniff';
    }, []);

    const [activePanel, setActivePanel] = useState<FloatingPanelType>(readStoredPanel);
    const [contentVisible, setContentVisible] = useState(false);
    // 访问过的面板常驻内存：打开过一次就不再卸载，切页/关闭重开不丢输入、滚动与已加载数据
    const [visited, setVisited] = useState<Set<FloatingPanelType>>(() => {
        const initial = readStoredPanel();
        return new Set<FloatingPanelType>(['sniff', initial]);
    });

    // 拖拽结束（非拖拽态的位置变更）即落盘，拖动过程中不写，避免每帧刷 localStorage
    useEffect(() => {
        if (!isDragging) saveJSON('ball-pos', position);
    }, [position, isDragging]);
    useEffect(() => {
        saveJSON('panel', activePanel);
    }, [activePanel]);

    const dragOffset = useRef({ x: 0, y: 0 });
    const pointerStartPos = useRef({ x: 0, y: 0 });
    const hasMoved = useRef(false);
    const pendingPosition = useRef(position);
    const rafRef = useRef<number | null>(null);
    const idleTimer = useRef<number | null>(null);

    const activeMeta = PANEL_META[activePanel];
    const ActiveIcon = activeMeta.icon;
    const linkCount = sniffer.foundLinks.length;

    // 动画控制：展开时微延时淡入内容，收起时先快速淡出内容；
    // 同时把当前页记入常驻集合（内容已挂载时重开就是单纯显示，打开不再卡顿）
    useEffect(() => {
        let timer: number;
        if (isOpen) {
            setVisited((prev) => {
                if (prev.has(activePanel)) return prev;
                const next = new Set(prev);
                next.add(activePanel);
                return next;
            });
            timer = window.setTimeout(() => setContentVisible(true), 70);
        } else {
            setContentVisible(false);
        }
        return () => window.clearTimeout(timer);
    }, [isOpen, activePanel]);

    // 闲置状态计时器：未交互数秒后进入微缩呼吸态，鼠标靠近即唤醒
    const resetIdleTimer = useCallback(() => {
        setIsIdle(false);
        if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
        if (!isOpen) {
            idleTimer.current = window.setTimeout(() => setIsIdle(true), 4000);
        }
    }, [isOpen]);

    useEffect(() => {
        resetIdleTimer();
        return () => {
            if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
        };
    }, [isOpen, resetIdleTimer]);

    // ESC 关闭展开面板
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setIsOpen(false);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen]);

    // 窗口尺寸自适应约束
    useEffect(() => {
        const handleResize = () => setPosition((prev) => clampPosition(prev.x, prev.y));
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const updatePosition = useCallback((nextX: number, nextY: number) => {
        pendingPosition.current = clampPosition(nextX, nextY);
        if (rafRef.current !== null) return;
        rafRef.current = window.requestAnimationFrame(() => {
            rafRef.current = null;
            setPosition(pendingPosition.current);
        });
    }, []);

    useEffect(
        () => () => {
            if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
        },
        []
    );

    /**
     * 面板尺寸。
     *
     * 展开态占满视口只留一圈边距，不再按悬浮球位置推算 —— 小屏不会溢出，
     * 也就没有"打开状态下挪不动"的问题。
     *
     * `transition: all` 改成显式属性：`all` 会连 background / border-color / box-shadow
     * 一起补间，拖动时每帧都要重算这些与位置无关的属性。
     *
     * transform 必须留在列表里：内联 transition 会盖掉类上的 `transition-transform`，
     * 漏掉它 `hover:scale-105` 就成了瞬变。
     */
    const panelStyle = useMemo(() => {
        const ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
        const transition = isDragging
            ? 'none'
            : `left 320ms ${ease}, top 320ms ${ease}, width 320ms ${ease}, height 320ms ${ease}, border-radius 320ms ${ease}, transform 320ms ${ease}`;

        if (!isOpen) {
            return {
                left: `${position.x}px`,
                top: `${position.y}px`,
                width: `${BALL_SIZE}px`,
                height: `${BALL_SIZE}px`,
                borderRadius: '9999px',
                transition,
            };
        }

        return {
            left: `${PANEL_MARGIN}px`,
            top: `${PANEL_MARGIN}px`,
            width: `calc(100vw - ${PANEL_MARGIN * 2}px)`,
            height: `calc(100vh - ${PANEL_MARGIN * 2}px)`,
            borderRadius: '24px',
            transition,
        };
    }, [isDragging, isOpen, position]);

    // 拖拽与点击防误触
    const handlePointerDown = useCallback(
        (event: React.PointerEvent) => {
            if (isOpen) return;
            event.preventDefault();
            event.stopPropagation();
            setIsDragging(true);
            hasMoved.current = false;
            pointerStartPos.current = { x: event.clientX, y: event.clientY };
            const rect = event.currentTarget.getBoundingClientRect();
            dragOffset.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            event.currentTarget.setPointerCapture(event.pointerId);
            resetIdleTimer();
        },
        [isOpen, resetIdleTimer]
    );

    const handlePointerMove = useCallback(
        (event: React.PointerEvent) => {
            if (!isDragging) return;
            const dist = Math.hypot(
                event.clientX - pointerStartPos.current.x,
                event.clientY - pointerStartPos.current.y
            );
            if (dist > 4) {
                hasMoved.current = true;
                updatePosition(event.clientX - dragOffset.current.x, event.clientY - dragOffset.current.y);
            }
        },
        [isDragging, updatePosition]
    );

    const handlePointerUp = useCallback(
        (event: React.PointerEvent) => {
            if (!isDragging) return;
            setIsDragging(false);
            event.currentTarget.releasePointerCapture(event.pointerId);

            // 智能磁吸边缘吸附（释放位置距左右侧边较近时平滑吸附）
            if (hasMoved.current) {
                const currentX = pendingPosition.current.x;
                const screenW = window.innerWidth;
                if (currentX < SNAP_THRESHOLD) {
                    updatePosition(16, pendingPosition.current.y);
                } else if (screenW - currentX - BALL_SIZE < SNAP_THRESHOLD) {
                    updatePosition(screenW - BALL_SIZE - 16, pendingPosition.current.y);
                }
                // 避免拖拽释放瞬间被判定为点击
                window.setTimeout(() => {
                    hasMoved.current = false;
                }, 50);
            }
            resetIdleTimer();
        },
        [isDragging, resetIdleTimer, updatePosition]
    );

    const toggleOpen = useCallback(() => {
        if (!hasMoved.current) setIsOpen((prev) => !prev);
    }, []);

    const openPanel = useCallback((panel: FloatingPanelType) => {
        setActivePanel(panel);
        setIsOpen(true);
    }, []);

    const hudOnRight = typeof window !== 'undefined' && position.x > window.innerWidth / 2;

    /**
     * 常驻渲染：访问过的面板用 hidden 藏而不是卸载，内部输入/滚动/已加载数据全部保留；
     * 未访问过的面板不挂载，首屏不为此买单。
     *
     * 元素本身要 memo 住。拖动悬浮球时 position 每帧都在变，整个组件跟着重渲染 ——
     * 若不 memo，嗅探列表（上限 300 条）会在拖动的每一帧重建一遍。
     * 元素引用不变时 React 会跳过整棵子树，与它是不是 hidden 无关。
     * settings 不吃 props，所以它的元素是真正一次性的。
     */
    const sniffNode = useMemo(
        () => <SniffResults sniffer={sniffer} onPlay={onPlay} onAiAnalyze={onAiAnalyze} currentUrl={currentUrl} />,
        [sniffer, onPlay, onAiAnalyze, currentUrl]
    );
    const settingsNode = useMemo(() => <SettingsFloating />, []);
    // logs 只吃 active：tab 切换时才变，拖球时引用稳定；同一类型同一位置，
    // 换引用只重渲染不重挂载，过滤条件/滚动位置照旧保留。
    const logsActive = activePanel === 'logs';
    const logsNode = useMemo(() => <LogsFloating active={logsActive} />, [logsActive]);

    const panels = useMemo(
        () =>
            ({
                sniff: sniffNode,
                settings: settingsNode,
                logs: logsNode,
            }) as Record<FloatingPanelType, React.ReactNode>,
        [sniffNode, settingsNode, logsNode]
    );

    return (
        <>
            <div
                className={`group pointer-events-auto fixed z-[70] flex select-none flex-col ${isOpen ? PANEL_SHELL : 'cursor-grab transition-transform hover:scale-105 active:scale-95 active:cursor-grabbing'
                    }`}
                style={panelStyle}
                onPointerDown={!isOpen ? handlePointerDown : undefined}
                onPointerMove={!isOpen ? handlePointerMove : undefined}
                onPointerUp={!isOpen ? handlePointerUp : undefined}
                onClick={!isOpen ? toggleOpen : undefined}
                onPointerEnter={() => {
                    setIsHovered(true);
                    resetIdleTimer();
                }}
                onPointerLeave={() => {
                    setIsHovered(false);
                    resetIdleTimer();
                }}
            >
                {/* ======================= 折叠状态：微晶悬浮球 ======================= */}
                {!isOpen && (
                    <div
                        className={`relative flex h-full w-full items-center justify-center transition-all duration-300 ${isIdle ? 'scale-95 opacity-80' : 'scale-100 opacity-100'
                            }`}
                    >
                        {/* 1. 声纳扩散波纹（嗅探到资源时向外扩散动态光波） */}
                        {linkCount > 0 && (
                            <>
                                <div className="animate-orb-sonar pointer-events-none absolute inset-0 rounded-full border border-cyan-400/50" />
                                <div className="animate-orb-sonar-delayed pointer-events-none absolute inset-0 rounded-full border border-indigo-400/40" />
                            </>
                        )}

                        {/* 2. 外部流动呼吸光晕。
                只让 scale 参与动画、opacity 留给 hover —— 此前关键帧同时补间 opacity，
                而 CSS 动画的优先级高于普通声明，`group-hover:opacity-85` 从来没有生效过。
                will-change-transform 让这层模糊结果被缓存成合成层，缩放不再逐帧重新模糊 */}
                        <div
                            className={`animate-orb-breath pointer-events-none absolute -inset-2.5 rounded-full bg-gradient-to-r ${activeMeta.accent} opacity-45 blur-lg transition-opacity duration-500 will-change-transform group-hover:opacity-85`}
                        />

                        {/* 3. 多层晶透外壳。
                不加 backdrop-blur：底色已是 80% 不透明的 slate-950，20% 的透光量看不出模糊，
                却要为这个常驻元素每帧付一次 backdrop-filter */}
                        <div className="orb-specular relative flex h-full w-full items-center justify-center rounded-full border border-white/25 bg-slate-950/80 shadow-[0_12px_36px_rgba(0,0,0,0.6),0_0_1px_1px_rgba(255,255,255,0.12)]">
                            {/* 液态渐变能量核心 */}
                            <div className={`absolute inset-[5px] rounded-full bg-gradient-to-br ${activeMeta.accent} opacity-90`} />

                            {/* 表面晶格光泽反光弧 */}
                            <div className="pointer-events-none absolute inset-[5px] rounded-full bg-gradient-to-b from-white/35 via-transparent to-black/30" />
                            <div className="pointer-events-none absolute inset-[6px] rounded-full bg-[radial-gradient(circle_at_32%_25%,rgba(255,255,255,0.7),transparent_55%)]" />

                            {/* 动态模式核心图标 */}
                            <div className="relative z-10 text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)] transition-transform duration-300 group-hover:scale-110">
                                <ActiveIcon className="h-6 w-6 stroke-[2.2]" />
                            </div>

                            {/* 霓虹角标。key 用数量：每多嗅到一项就重挂一次，
                  让弹跳动画重放一遍（动画本身是有限次的，不做永久运动） */}
                            {linkCount > 0 && (
                                <div
                                    key={linkCount}
                                    className="animate-orb-badge absolute -right-1 -top-1 z-20 flex h-5 min-w-[20px] items-center justify-center rounded-full border border-rose-300/50 bg-gradient-to-r from-rose-500 to-pink-500 px-1 text-[10px] font-black text-white shadow-[0_0_12px_rgba(244,63,94,0.7)]"
                                >
                                    {linkCount > 99 ? '99+' : linkCount}
                                </div>
                            )}
                        </div>

                        {/* 4. 悬停微型快捷 HUD */}
                        {isHovered && !isDragging && (
                            <div
                                className={`animate-in fade-in zoom-in-95 pointer-events-auto absolute top-1/2 z-50 flex -translate-y-1/2 items-center gap-1.5 rounded-2xl border border-white/15 bg-slate-950/90 p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.65)] backdrop-blur-2xl duration-150 ${hudOnRight ? 'right-full mr-3.5' : 'left-full ml-3.5'
                                    }`}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                            >
                                <div className="flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs text-slate-300">
                                    {linkCount > 0 ? (
                                        <>
                                            <Sparkles className="h-3.5 w-3.5 animate-pulse text-cyan-400" />
                                            <span>
                                                已嗅探 <strong className="font-bold text-white">{linkCount}</strong> 项
                                            </span>
                                        </>
                                    ) : (
                                        <>
                                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                                            <span>{activeMeta.label}</span>
                                        </>
                                    )}
                                </div>

                                <div className="flex items-center gap-1 border-l border-white/10 pl-1.5">
                                    {PANEL_ORDER.map((key) => {
                                        const meta = PANEL_META[key];
                                        const Icon = meta.icon;
                                        const isCurrent = key === activePanel;
                                        const count = key === 'sniff' ? linkCount : 0;

                                        return (
                                            <button
                                                key={key}
                                                onClick={() => openPanel(key)}
                                                className={`relative flex h-8 w-8 items-center justify-center rounded-xl border transition ${FOCUS_RING} ${isCurrent
                                                    ? `border-white/25 bg-gradient-to-br ${meta.accent} text-white shadow-md`
                                                    : 'border-white/10 bg-white/[0.06] text-slate-400 hover:border-white/20 hover:bg-white/[0.12] hover:text-white'
                                                    }`}
                                                title={`一键切换到 ${meta.label}`}
                                                aria-label={`打开 ${meta.label}`}
                                            >
                                                <Icon className="h-4 w-4" />
                                                {count > 0 && (
                                                    <span className="absolute -right-1 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-rose-500 px-0.5 text-[8px] font-bold text-white">
                                                        {count > 99 ? '99+' : count}
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* ======================= 展开状态：流光毛玻璃 HUD 面板 ======================= */}
                {/* 常驻挂载、关闭只隐藏：关球不再卸载任何面板，抓取进度/输入/滚动原样保留，
            重开就是单纯显示。如改回条件渲染，关球会停掉抓取并清空所有状态 */}
                <div
                    className={`relative h-full flex-col p-5 transition-opacity duration-200 ${isOpen ? 'flex' : 'hidden'
                        } ${contentVisible ? 'opacity-100' : 'opacity-0'}`}
                >
                    {/* 弥散柔光氛围底光 */}
                    <div
                        className={`pointer-events-none absolute -inset-10 rounded-[48px] bg-gradient-to-br ${activeMeta.accent} opacity-15 blur-3xl transition-colors duration-700`}
                    />

                    {/* 面板头部。标题与说明只在这里出现一次，各面板不再重复画一遍标题 */}
                    <div className="relative z-10 flex shrink-0 items-center justify-between gap-4 border-b border-white/10 pb-4">
                        <div className="flex items-center gap-3">
                            <div
                                className={`flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br ${activeMeta.accent} text-white shadow-[0_8px_20px_rgba(0,0,0,0.3)]`}
                            >
                                <ActiveIcon className="h-5 w-5" />
                            </div>
                            <div>
                                <span className="text-xl font-bold tracking-tight text-white">{activeMeta.label}</span>
                                <div className="mt-0.5 text-xs text-slate-400">{activeMeta.hint}</div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            <span className="hidden items-center gap-1 rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1 text-[11px] text-slate-400 sm:inline-flex">
                                <kbd className="font-mono text-[10px] text-slate-300">ESC</kbd> 关闭
                            </span>
                            <button
                                onClick={() => setIsOpen(false)}
                                className={`flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.06] text-slate-400 transition hover:rotate-90 hover:border-white/20 hover:bg-white/[0.12] hover:text-white active:scale-95 ${FOCUS_RING}`}
                                title="关闭面板 (Esc)"
                                aria-label="关闭面板"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    </div>

                    {/* 胶囊分段导航 */}
                    <div
                        className={`relative z-10 mt-3.5 flex shrink-0 items-center gap-1.5 rounded-2xl p-1.5 ${SURFACE_SUNKEN}`}
                        role="tablist"
                        aria-label="悬浮球面板"
                    >
                        {PANEL_ORDER.map((key) => {
                            const meta = PANEL_META[key];
                            const Icon = meta.icon;
                            const isActive = key === activePanel;
                            const count = key === 'sniff' ? linkCount : 0;

                            return (
                                <button
                                    key={key}
                                    onClick={() => setActivePanel(key)}
                                    role="tab"
                                    aria-selected={isActive}
                                    className={`relative flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition ${FOCUS_RING} ${isActive
                                        ? 'border border-white/20 bg-white/[0.12] text-white shadow-[0_4px_16px_rgba(0,0,0,0.3)]'
                                        : 'border border-transparent text-slate-400 hover:bg-white/[0.06] hover:text-slate-200'
                                        }`}
                                    title={meta.hint}
                                >
                                    <span
                                        className={`flex h-6 w-6 items-center justify-center rounded-lg transition ${isActive ? `bg-gradient-to-br ${meta.accent} text-white shadow-sm` : 'text-slate-400'
                                            }`}
                                    >
                                        <Icon className="h-3.5 w-3.5" />
                                    </span>
                                    <span className="tracking-wide">{meta.label}</span>
                                    {count > 0 && (
                                        <span className="flex h-4 min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                                            {count > 99 ? '99+' : count}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    {/* 主内容区 */}
                    <div className="relative z-10 mt-3.5 min-h-0 flex-1 overflow-hidden rounded-[20px] border border-white/10 bg-slate-950/40 p-4">
                        {PANEL_ORDER.map((key) => {
                            if (!visited.has(key)) return null;
                            return (
                                <div key={key} className={activePanel === key ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
                                    {panels[key]}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* 遮罩背景 */}
            {isOpen && <div className={PANEL_OVERLAY} onClick={() => setIsOpen(false)} />}
        </>
    );
};
