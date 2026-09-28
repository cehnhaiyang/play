import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    AlertCircle,
    AlertTriangle,
    ArrowLeft,
    ArrowRight,
    ArrowRightLeft,
    BookOpen,
    Bot,
    Braces,
    Check,
    ChevronDown,
    ChevronRight,
    ChevronsRight,
    Code,
    Compass,
    FolderPlus,
    GripVertical,
    Pencil,
    Database,
    Download,
    FolderOpen,
    Globe,
    HardDrive,
    Home,
    KeyRound,
    Layers,
    Loader2,
    Magnet,
    Maximize2,
    Minimize2,
    Music,
    Pause,
    Play,
    Plus,
    RefreshCw,
    RotateCw,
    Save,
    Search,
    Send,
    ShieldAlert,
    ShieldCheck,
    Square,
    Star,
    Terminal,
    Trash2,
    Undo2,
    User,
    Volume2,
    VolumeX,
    X,
} from 'lucide-react';
import { useBrowse } from '../hooks';
import type {
    AgentState,
    BookmarksState,
    DownloadsState,
    FindInfo,
    SearchEngine,
    Tab,
    TamperState,
    TabsState,
} from '../hooks';
import { SEARCH_ENGINE_OPTIONS, isAddressLike } from '../hooks';
import type {
    AgentMessage,
    AgentScript,
    BookmarkNode,
    BookmarkBarVisibility,
    CookieItem,
    EdgeDetectResult,
    EdgeImportResult,
    EdgeAccountEntry,
    HeaderRule,
    KbStatus,
    TamperRule,
    WebviewElement,
} from '../meta';
import { getAppWindow, getElectronAPI } from '../meta';
import {
    buildCookieData,
    collectDroppedRules,
    decodeJwt,
    findCookieByKey,
    generateId,
    pickJwtCandidates,
} from '../utils/utils';
import { loadJSON, saveJSON } from '../utils/persist';
import { formatBytes } from '../services/SearchService';
import { zoomLevelToPercent, type NavigationError } from '../services/BrowserService';
import {
    collectFolders,
    countNodes,
    findNode,
    findParent,
    flattenUrls,
    isDescendant,
    type MergeStats,
} from '../services/BookmarkService';
import {
    buildKbIndex,
    searchKb,
    type KbEntry,
    type KbSearchHit,
} from '../services/KbService';

/**
 * 浏览器面板。
 *
 * 这个文件是**一个整体**，不是"碰巧放在一起的几个组件"。浏览器面板与 Agent
 * 工作区是同一条生命周期的两端：Agent 只能通过 webview 干活（点击、改规则、
 * 读存储、注入脚本），没有 webview 它一步都走不了；而 webview 的 dom-ready
 * 广播、规则注入、脚本自动执行又都挂在同一个 useBrowse 上。拆成两个目录之后，
 * 一边改接口、另一边不知道，编译期毫无提示。
 *
 * 原 BrowsePanel/ 目录（index + TabsBar + AddressBar + BrowserView + HomePage）
 * 与原 Floating/AgentFloating.tsx、Floating/tamper/ 全部合并到这里。
 *
 * **webview 的父链不许动**：它是 Electron 的原生宿主标签，React 一旦在它上面
 * 卸载重挂，页面就重新加载一次（登录态、滚动位置、SPA 路由全丢）。所以侧边栏
 * 的展开/收起只改宽度，不改 DOM 结构 —— 见 AgentSidebar 的注释。
 */

/* ========================================================================== */
/*                              视觉：站点标识                                */
/* ========================================================================== */

/**
 * 站点取色：把 hostname 哈希到一个固定色相。
 *
 * 同一个站点永远同色，不同站点大概率不同色 —— 标签页一多，颜色比文字更快认出来。
 * 取色表是手挑的：都在中高饱和、亮度接近，避免某几个站点刺眼而另几个糊成一团。
 */
const SITE_HUES = [199, 217, 245, 268, 292, 322, 348, 22, 40, 158, 172];

const siteHue = (host: string): number => {
    let hash = 0;
    for (let i = 0; i < host.length; i += 1) {
        hash = (hash * 31 + host.charCodeAt(i)) % 100003;
    }
    return SITE_HUES[hash % SITE_HUES.length];
};

/**
 * 书签与标签页的标题都可能是历史脏数据（缺协议、缺 title），
 * 直接 new URL 会抛异常 —— 一条坏数据就能让整个面板白屏。
 */
const safeHostname = (url: string): string => {
    if (!url) return '';
    try {
        return new URL(url).hostname;
    } catch {
        try {
            return new URL(`https://${url}`).hostname;
        } catch {
            return url.slice(0, 30);
        }
    }
};

/** 去掉 www. 前缀，取首字符。中文域名取整个首字（不是半个代理对） */
const siteInitial = (host: string): string => {
    const bare = host.replace(/^www\./i, '');
    const first = Array.from(bare)[0];
    return first ? first.toUpperCase() : '?';
};

const SiteTile: React.FC<{ host: string; className?: string }> = ({ host, className = '' }) => {
    if (!host) {
        return (
            <span className={`flex shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/6 text-zinc-500 ${className}`}>
                <Compass className="h-3 w-3" />
            </span>
        );
    }

    const hue = siteHue(host);
    return (
        <span
            className={`flex shrink-0 items-center justify-center rounded-md font-bold text-white ${className}`}
            style={{
                background: `linear-gradient(140deg, hsl(${hue} 72% 54%), hsl(${(hue + 30) % 360} 74% 36%))`,
                boxShadow: `inset 0 0 0 1px hsl(${hue} 90% 72% / 0.3), 0 1px 4px hsl(${hue} 80% 12% / 0.55)`,
            }}
            title={host}
        >
            {siteInitial(host)}
        </span>
    );
};

/** 地址栏左侧的连接状态：图标 + 色调 + 一句话，三处必须同源 */
const addressSecurity = (url: string): { Icon: React.ComponentType<{ className?: string }>; tone: string; label: string } => {
    const target = url.trim().toLowerCase();
    if (target.startsWith('https://')) return { Icon: ShieldCheck, tone: 'text-emerald-400', label: 'HTTPS 加密连接' };
    if (target.startsWith('http://')) return { Icon: ShieldAlert, tone: 'text-amber-400', label: 'HTTP 明文连接，内容可被中途查看' };
    if (target.startsWith('file://')) return { Icon: HardDrive, tone: 'text-sky-400', label: '本地文件' };
    return { Icon: Globe, tone: 'text-zinc-500', label: '页面地址' };
};

/* ========================================================================== */
/*                                  标签栏                                      */
/* ========================================================================== */

/**
 * 站点图标。
 *
 * 有真实 favicon 就用它，没有才回落到 hostname 取色块。
 *
 * 回落不是失败态 —— 很多站点（尤其是纯 API 页、内网页）本来就没有 favicon。
 * 但**必须**区分这两种情况：取色块永远画得出来，所以"没有图标"这件事
 * 只能靠"画的是色块还是图片"本身来表达，不能靠空白。
 *
 * 加载失败要退回色块：favicon 是远端资源，403/404/跨域都会发生，
 * 而 broken image 在暗色主题下是一个刺眼的白框。
 */
const SiteIcon: React.FC<{ host: string; favicon: string; className?: string }> = ({
    host, favicon, className = '',
}) => {
    const [failed, setFailed] = useState(false);

    // 换了站点要重置失败标记：不重置的话，A 站的坏 favicon 会让 B 站的
    // 好 favicon 也画不出来（组件按 host 复用，failed 一直挂着）
    useEffect(() => { setFailed(false); }, [favicon]);

    if (!favicon || failed) return <SiteTile host={host} className={className} />;

    return (
        <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-white/6 ${className}`}>
            <img
                src={favicon}
                alt=""
                // 不挂 referrerPolicy：favicon 常被站点按 Referer 判防盗链，
                // 而这里的 Referer 是应用自身的地址，带上反而更容易被拒
                className="h-full w-full object-contain"
                onError={() => setFailed(true)}
            />
        </span>
    );
};

const TabsBar: React.FC<{
    tabs: TabsState['tabs'];
    activeTabId: string;
    actions: TabsState['actions'];
    onToggleMute: (tabId: string) => void;
}> = ({ tabs, activeTabId, actions, onToggleMute }) => (
    <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-white/8 bg-white/[0.02] px-2">
        <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab: Tab) => {
                const isActive = tab.id === activeTabId;
                const host = safeHostname(tab.url);
                return (
                    <div
                        key={tab.id}
                        onClick={() => actions.switchTab(tab.id)}
                        // 中键关闭标签页。Chrome 的行为，重度用户靠它一天少点几百次
                        onAuxClick={(event) => {
                            if (event.button === 1) {
                                event.preventDefault();
                                actions.closeTab(tab.id);
                            }
                        }}
                        title={tab.url || '新标签页'}
                        className={`group relative flex h-7 min-w-[124px] max-w-[200px] cursor-pointer items-center gap-2 rounded-lg px-2.5 transition-all select-none ${isActive
                            ? 'bg-white/8 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                            : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
                            }`}
                    >
                        {/* 激活指示：顶部一段渐变细线。比整块高亮克制，也不抢标题的对比度 */}
                        {isActive && (
                            <span className="pointer-events-none absolute inset-x-2.5 top-0 h-px bg-gradient-to-r from-transparent via-indigo-400/80 to-transparent" />
                        )}

                        {tab.isLoading ? (
                            <RotateCw className="h-3 w-3 shrink-0 animate-spin text-indigo-400" />
                        ) : (
                            <SiteIcon host={host} favicon={tab.favicon} className="h-4 w-4 text-[9px]" />
                        )}

                        <span className={`min-w-0 flex-1 truncate text-xs ${isActive ? 'font-semibold' : ''}`}>
                            {tab.title || '新标签页'}
                        </span>

                        {/* 发声 / 静音指示。**只有真在出声或已被静音时才出现** ——
                            常驻一个喇叭图标会让每个标签页都多一个无意义的符号 */}
                        {(tab.audible || tab.muted) && (
                            <button
                                onClick={(event) => { event.stopPropagation(); onToggleMute(tab.id); }}
                                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition ${tab.muted ? 'text-slate-500 hover:text-slate-300' : 'text-indigo-400 hover:text-indigo-200'
                                    }`}
                                title={tab.muted ? '取消静音' : '静音此标签页'}
                            >
                                {tab.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
                            </button>
                        )}

                        <button
                            onClick={(event) => { event.stopPropagation(); actions.closeTab(tab.id); }}
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition ${isActive ? 'text-slate-400 opacity-70 hover:bg-white/15 hover:text-white' : 'opacity-0 group-hover:opacity-70 hover:bg-white/15'
                                }`}
                            title="关闭标签页"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    </div>
                );
            })}
        </div>

        <button
            onClick={() => actions.createTab()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white/8 hover:text-white"
            title="新建标签页（Ctrl+T）"
        >
            <Plus className="h-4 w-4" />
        </button>
    </div>
);

/* ========================================================================== */
/*                                  地址栏                                      */
/* ========================================================================== */

const NavButton: React.FC<{
    onClick: () => void;
    disabled?: boolean;
    title: string;
    children: React.ReactNode;
}> = ({ onClick, disabled, title, children }) => (
    <button
        onClick={onClick}
        disabled={disabled}
        title={title}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/8 hover:text-white disabled:cursor-not-allowed disabled:text-slate-700 disabled:hover:bg-transparent"
    >
        {children}
    </button>
);

/**
 * 搜索引擎选择器。
 *
 * 只在"这一串会被当成搜索词"时才出现 —— 判据走 hooks 里的 isAddressLike，
 * 与回车时实际用的解析是**同一份实现**。各写一份的话，界面显示"用 Bing 搜索"、
 * 回车却当网址打开，这类不一致几乎没人能一眼看出来。
 */
const EnginePicker: React.FC<{
    engine: SearchEngine;
    onChange: (engine: SearchEngine) => void;
}> = ({ engine, onChange }) => {
    const [open, setOpen] = useState(false);
    const boxRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const close = (event: PointerEvent) => {
            if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', close);
        return () => document.removeEventListener('pointerdown', close);
    }, [open]);

    const current = SEARCH_ENGINE_OPTIONS.find((option) => option.id === engine) || SEARCH_ENGINE_OPTIONS[0];

    return (
        <div ref={boxRef} className="relative">
            <button
                // 阻止默认：点按钮时输入框不失焦，否则 setInputFocused(false) 会让
                // 地址栏重新跟随页面 URL，把用户正在敲的内容覆盖掉
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setOpen((prev) => !prev)}
                className="flex h-6 items-center gap-1 rounded-md border border-white/10 bg-white/6 px-1.5 text-[10px] font-bold text-slate-300 transition hover:border-white/20 hover:bg-white/12 hover:text-white"
                title={`搜索引擎：${current.label}（点击切换）`}
            >
                {siteInitial(current.label)}
                <ChevronDown className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>

            {open && (
                <div className="animate-in fade-in zoom-in-95 absolute left-0 top-8 z-50 w-36 overflow-hidden rounded-xl border border-white/12 bg-slate-950/95 p-1 shadow-[0_16px_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
                    {SEARCH_ENGINE_OPTIONS.map((option) => (
                        <button
                            key={option.id}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => { onChange(option.id); setOpen(false); }}
                            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${option.id === engine ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/6 hover:text-slate-200'
                                }`}
                        >
                            <SiteTile host={option.label} className="h-4 w-4 text-[9px]" />
                            <span className="flex-1">{option.label}</span>
                            {option.id === engine && <Check className="h-3 w-3 text-emerald-400" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

const AddressBar: React.FC<{
    activeTab: Tab;
    activeTabId: string;
    tabActions: TabsState['actions'];
    inputUrl: string;
    setInputUrl: (url: string) => void;
    /** 聚焦/失焦上报：地址栏聚焦时停止跟随页面 URL，否则用户输入会被 SPA 导航覆盖 */
    setInputFocused: (focused: boolean) => void;
    handleNavigate: (url: string) => void;
    isCurrentPageBookmarked: boolean;
    toggleBookmark: BookmarksState['toggleBookmark'];
    isAnalyzing: boolean;
    engine: SearchEngine;
    onEngineChange: (engine: SearchEngine) => void;
    onNavigateToPlayer: () => void;
    onNavigateToAudio: () => void;
    onNavigateToGallery: () => void;
    onNavigateToTorrent: () => void;
    /** 中止当前加载 */
    onStop: () => void;
    /** 缩放：+1 / -1 / 0（复位） */
    onZoom: (delta: number) => void;
    /** 正在进行的下载条数，用于徽标 */
    downloadCount: number;
    onToggleDownloads: () => void;
    /** 地址栏 input 的 ref，供 Ctrl+L 聚焦用 */
    inputRef: React.RefObject<HTMLInputElement | null>;
}> = ({
    activeTab,
    activeTabId,
    tabActions,
    inputUrl,
    setInputUrl,
    setInputFocused,
    handleNavigate,
    isCurrentPageBookmarked,
    toggleBookmark,
    isAnalyzing,
    engine,
    onEngineChange,
    onNavigateToPlayer,
    onNavigateToAudio,
    onNavigateToGallery,
    onNavigateToTorrent,
    onStop,
    onZoom,
    downloadCount,
    onToggleDownloads,
    inputRef,
}) => {
        /**
         * 后退/前进是否可用。
         *
         * 用 React 侧的历史记账（historyIndex / history.length）判断，而不是
         * webview.canGoBack()：后者要等 dom-ready 之后才可靠，且是同步取值，
         * 拿不到就无法触发重渲染 —— 按钮会一直停在初始态。
         * 记账与实际可能有一格偏差（页面内部 replaceState 之类），
         * 所以 goBack/goForward 自身还会再判一次，越界时是 no-op。
         */
        const canGoBack = activeTab.historyIndex > 0;
        const canGoForward = activeTab.historyIndex >= 0 && activeTab.historyIndex < activeTab.history.length - 1;

        const security = addressSecurity(activeTab.url);
        const query = inputUrl.trim();
        const asSearch = query.length > 0 && !isAddressLike(query);
        const zoomPercent = zoomLevelToPercent(activeTab.zoomLevel);

        return (
            <div className="relative flex h-12 shrink-0 items-center gap-2 border-b border-white/8 bg-white/[0.03] px-2.5">
                {/* 导航控制 */}
                <div className="flex shrink-0 items-center gap-0.5">
                    <NavButton onClick={() => tabActions.goBack(activeTabId)} disabled={!canGoBack} title="后退（Alt+←）">
                        <ArrowLeft className="h-4 w-4" />
                    </NavButton>
                    <NavButton onClick={() => tabActions.goForward(activeTabId)} disabled={!canGoForward} title="前进（Alt+→）">
                        <ArrowRight className="h-4 w-4" />
                    </NavButton>
                    <NavButton onClick={() => tabActions.goHome(activeTabId)} title="主页（Alt+Home）">
                        <Home className="h-4 w-4" />
                    </NavButton>
                    {/* 刷新与停止**共用一个位置**（Chrome 的行为）：加载中显示停止，
                        加载完显示刷新。两个按钮并排会让工具栏多一个永远灰着的格子，
                        而且用户想停止时反而要去分辨哪个是哪个 */}
                    {activeTab.isLoading || isAnalyzing ? (
                        <NavButton onClick={onStop} title="停止加载（Esc）">
                            <X className="h-4 w-4" />
                        </NavButton>
                    ) : (
                        <NavButton onClick={() => tabActions.reload(activeTabId)} title="刷新（F5 / Ctrl+R，Shift 强制刷新）">
                            <RotateCw className="h-4 w-4" />
                        </NavButton>
                    )}
                </div>

                <div className="h-5 w-px shrink-0 bg-white/8" />

                {/* 地址输入 */}
                <div className="relative min-w-0 flex-1">
                    <div className="group flex h-8 items-center gap-2 rounded-xl border border-white/10 bg-slate-950/70 px-2.5 transition-all focus-within:border-indigo-400/50 focus-within:bg-slate-950 focus-within:shadow-[0_0_0_3px_rgba(99,102,241,0.12)]">
                        {/* 左槽：这一串是地址还是搜索词，用不同的控件直接说出来 */}
                        {asSearch ? (
                            <EnginePicker engine={engine} onChange={onEngineChange} />
                        ) : (
                            <span title={security.label} className="flex h-4 w-4 shrink-0 items-center justify-center">
                                <security.Icon className={`h-4 w-4 ${security.tone}`} />
                            </span>
                        )}

                        <input
                            ref={inputRef}
                            type="text"
                            value={inputUrl}
                            onChange={(event) => setInputUrl(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') handleNavigate(inputUrl);
                                if (event.key === 'Escape') event.currentTarget.blur();
                            }}
                            // 聚焦时选中全部：方便直接覆盖输入
                            onFocus={(event) => { event.target.select(); setInputFocused(true); }}
                            onBlur={() => setInputFocused(false)}
                            placeholder="输入网址或搜索内容…"
                            spellCheck={false}
                            className="min-w-0 flex-1 bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-600"
                        />

                        {/* 缩放指示。**只在非 100% 时出现**：常驻一个"100%"是噪声，
                            而离开 100% 之后用户需要一个"怎么回到原样"的入口 */}
                        {activeTab.zoomLevel !== 0 && (
                            <button
                                onClick={() => onZoom(0)}
                                className="flex h-5 shrink-0 items-center rounded px-1 font-mono text-[10px] text-indigo-300 transition hover:bg-white/10"
                                title={`当前缩放 ${zoomPercent}%，点击复位到 100%`}
                            >
                                {zoomPercent}%
                            </button>
                        )}

                        {activeTab.url && (
                            <button
                                onClick={() => toggleBookmark(activeTab.url, activeTab.title)}
                                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition ${isCurrentPageBookmarked ? 'text-amber-400' : 'text-slate-600 hover:text-amber-300'
                                    }`}
                                title={isCurrentPageBookmarked ? '取消收藏' : '收藏此页（Ctrl+D）'}
                            >
                                <Star className={`h-3.5 w-3.5 ${isCurrentPageBookmarked ? 'fill-current' : ''}`} />
                            </button>
                        )}

                        <button
                            onClick={() => handleNavigate(inputUrl)}
                            className="flex h-6 shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-2.5 text-[11px] font-bold text-white transition hover:bg-indigo-500 active:scale-95"
                            title={asSearch ? `用 ${engine} 搜索` : '打开地址'}
                        >
                            {asSearch ? <Search className="h-3 w-3" /> : <ArrowRight className="h-3 w-3" />}
                            转到
                        </button>
                    </div>
                </div>

                {/* 右侧功能入口 */}
                <div className="flex shrink-0 items-center gap-1.5">
                    {/* 下载入口。有进行中的下载时显示数量徽标 —— 网页下载不像
                        嗅探下载那样有独立面板，不给入口用户根本不知道文件去哪了 */}
                    <button
                        onClick={onToggleDownloads}
                        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/8 hover:text-white"
                        title="下载内容"
                    >
                        <Download className="h-4 w-4" />
                        {downloadCount > 0 && (
                            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-indigo-500 px-0.5 text-[8px] font-bold text-white">
                                {downloadCount}
                            </span>
                        )}
                    </button>

                    <div className="flex items-center gap-0.5 rounded-xl border border-white/8 bg-white/[0.03] p-0.5">
                        <NavButton onClick={onNavigateToTorrent} title="磁力下载">
                            <Magnet className="h-4 w-4 text-cyan-400" />
                        </NavButton>
                        <NavButton onClick={onNavigateToGallery} title="ACG 画廊">
                            <BookOpen className="h-4 w-4 text-rose-400" />
                        </NavButton>
                        <NavButton onClick={onNavigateToAudio} title="音频工坊">
                            <Music className="h-4 w-4 text-cyan-400" />
                        </NavButton>
                        <NavButton onClick={onNavigateToPlayer} title="播放器">
                            <Play className="h-4 w-4 text-slate-300" />
                        </NavButton>
                    </div>
                </div>

                {/* 加载进度：绝对定位在底边，不占布局高度，出现/消失不会把内容顶一下 */}
                {activeTab.isLoading && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden">
                        <div className="bp-progress-bar bg-gradient-to-r from-indigo-500 via-violet-400 to-cyan-400" />
                    </div>
                )}
            </div>
        );
    };

/* ========================================================================== */
/*                                 书签栏                                       */
/* ========================================================================== */

/** 书签下拉菜单的宽度，w-72 = 18rem = 288px。定位计算要用，所以提出来 */
const BOOKMARK_MENU_WIDTH = 288;

/**
 * 把下拉菜单送到 document.body 上，用 fixed 定位贴住锚点。
 *
 * **为什么不能留在书签栏的 DOM 里**：书签栏的条目区是 `overflow-hidden` ——
 * 溢出项必须被裁掉，否则那一行会被撑破。而下拉菜单恰恰是**故意**要溢出到
 * 栏外的。两者直接冲突：留在原地时菜单的 top 落在条目区的盒子之外，
 * 会被裁成 0 高度。
 *
 * 表现就是「点文件夹、点 » 都毫无反应」—— 事件其实都触发了，state 也变了，
 * 菜单也渲染了，只是被裁得完全看不见。这类故障不报错、不抛异常，所以只能
 * 靠结构判断，不能靠日志。
 *
 * 走 portal 之后菜单不再受书签栏的裁剪约束；锚点坐标每次打开时用
 * getBoundingClientRect 现算，所以侧边栏开合、窗口缩放都不会让它错位。
 */
const BookmarkMenuPortal: React.FC<{
    /** 菜单要贴住的元素。为 null 时不渲染 —— 首帧 ref 还没挂上 */
    anchor: HTMLElement | null;
    /**
     * below：贴在锚点下方左对齐（书签栏上的文件夹、» 溢出菜单）。
     * right：贴在锚点右侧、顶对齐（菜单里再展开的嵌套文件夹）。
     */
    placement?: 'below' | 'right';
    children: React.ReactNode;
}> = ({ anchor, placement = 'below', children }) => {
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

    useLayoutEffect(() => {
        if (!anchor) { setPos(null); return; }
        const place = () => {
            const rect = anchor.getBoundingClientRect();
            const maxLeft = Math.max(8, window.innerWidth - BOOKMARK_MENU_WIDTH - 8);
            const clampLeft = (value: number) => Math.min(Math.max(8, value), maxLeft);

            if (placement === 'right') {
                // 右侧放不下就翻到左边。嵌套文件夹在窗口右半边时全靠这一条，
                // 否则子菜单会整个跑到窗口外，看起来同样是"点了没反应"。
                const right = rect.right + 2;
                const left = right + BOOKMARK_MENU_WIDTH > window.innerWidth - 8
                    ? rect.left - BOOKMARK_MENU_WIDTH - 2
                    : right;
                setPos({ left: clampLeft(left), top: Math.max(8, rect.top - 4) });
                return;
            }
            setPos({ left: clampLeft(rect.left), top: rect.bottom + 4 });
        };
        place();
        window.addEventListener('resize', place);
        // capture 阶段收滚动：菜单自己所在的滚动容器也要跟手
        window.addEventListener('scroll', place, true);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [anchor, placement]);

    if (!pos) return null;
    return createPortal(
        // z-40 与「右键书签栏」那个菜单同级：都要盖住浏览器面板（z-20），
        // 但都不该盖住悬浮球（z-50）
        <div data-bm-menu style={{ position: 'fixed', left: pos.left, top: pos.top }} className="z-40">
            {children}
        </div>,
        document.body,
    );
};

/**
 * 书签栏。
 *
 * **位置是硬约束**：它必须插在 AddressBar 与 BrowserView 的容器之间，也就是
 * 同一根 flex 列的兄弟节点。绝不能让书签栏成为 webview 的祖先或父链上的一环
 * —— webview 是 Electron 的原生宿主标签，父链一变 React 就会把它卸载重挂，
 * 页面重新加载（登录态、滚动位置、SPA 路由全丢）。
 * 这里只占一行高度，开合也只是这一个 div 的出现/消失，webview 的父链不动。
 *
 * 溢出用「»」收纳而不是横向滚动：书签栏是一行定高的条，横向滚动条会占掉
 * 本就不多的高度，而且滚动条本身在暗色主题下很显眼。
 *
 * 下拉菜单一律走 BookmarkMenuPortal —— 见该组件的注释。
 */
const BookmarkBar: React.FC<{
    tree: BookmarkNode;
    onNavigate: (url: string) => void;
    onOpenManager: () => void;
    onOpenImport: () => void;
    onVisibilityChange: (value: BookmarkBarVisibility) => void;
    visibility: BookmarkBarVisibility;
    onRemove: (id: string) => void;
    onOpenInNewTab: (url: string) => void;
}> = ({ tree, onNavigate, onOpenManager, onOpenImport, onVisibilityChange, visibility, onRemove, onOpenInNewTab }) => {
    const [openFolderId, setOpenFolderId] = useState<string | null>(null);
    const [overflowOpen, setOverflowOpen] = useState(false);
    const barRef = useRef<HTMLDivElement | null>(null);
    const overflowBtnRef = useRef<HTMLButtonElement | null>(null);
    const [visibleCount, setVisibleCount] = useState<number>(Number.MAX_SAFE_INTEGER);

    const items = tree.children || [];

    /**
     * 溢出计算：量每个子项的实际宽度，能塞下几个就显示几个。
     *
     * 用 ResizeObserver 而不是监听 window.resize —— 侧边栏开合改变的是**容器**
     * 宽度，window 尺寸根本没变，只听 resize 会在侧边栏展开后仍然溢出。
     */
    useEffect(() => {
        const host = barRef.current;
        if (!host) return;
        const measure = () => {
            const width = host.clientWidth;
            if (width <= 0) return;
            const children = Array.from(host.querySelectorAll<HTMLElement>('[data-bm-item]'));
            if (children.length === 0) { setVisibleCount(Number.MAX_SAFE_INTEGER); return; }
            // 给「»」按钮留 34px
            let used = 0;
            let count = 0;
            const limit = width - 34;
            for (const child of children) {
                const w = child.offsetWidth + 2;
                if (used + w > limit) break;
                used += w;
                count += 1;
            }
            setVisibleCount(count === 0 ? children.length : count);
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(host);
        return () => observer.disconnect();
    }, [items.length]);

    // 点空白处收起下拉
    useEffect(() => {
        if (!openFolderId && !overflowOpen) return;
        const close = (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            if (target.closest('[data-bm-menu]')) return;
            setOpenFolderId(null);
            setOverflowOpen(false);
        };
        window.addEventListener('mousedown', close);
        return () => window.removeEventListener('mousedown', close);
    }, [openFolderId, overflowOpen]);

    const shown = items.slice(0, visibleCount);
    const hidden = items.slice(visibleCount);

    return (
        <div
            className="relative flex h-8 shrink-0 items-center gap-0.5 border-b border-white/8 bg-slate-900/60 px-2"
            onContextMenu={(event) => {
                event.preventDefault();
                // 书签栏自身的右键菜单：显示策略 + 管理入口。
                // 不复用主进程的 Menu.popup —— 那是给 webview 页面内容用的，
                // 而这里是渲染层的 DOM，走原生菜单反而要绕一大圈 IPC。
                setOverflowOpen(false);
                setOpenFolderId('__bar__');
            }}
        >
            <div ref={barRef} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
                {shown.map((node) => (
                    <BookmarkBarItem
                        key={node.id}
                        node={node}
                        onNavigate={onNavigate}
                        onOpenInNewTab={onOpenInNewTab}
                        onRemove={onRemove}
                        open={openFolderId === node.id}
                        onToggle={() => setOpenFolderId((prev) => (prev === node.id ? null : node.id))}
                    />
                ))}

                {hidden.length > 0 && (
                    <div className="relative shrink-0" data-bm-menu>
                        <button
                            ref={overflowBtnRef}
                            onClick={() => setOverflowOpen((prev) => !prev)}
                            className="flex h-6 w-7 items-center justify-center rounded text-slate-400 transition hover:bg-white/8 hover:text-slate-200"
                            title={`还有 ${hidden.length} 项`}
                        >
                            <ChevronsRight className="h-3.5 w-3.5" />
                        </button>
                        {overflowOpen && (
                            <BookmarkMenuPortal anchor={overflowBtnRef.current}>
                                <BookmarkDropdown
                                    nodes={hidden}
                                    onNavigate={(url) => { onNavigate(url); setOverflowOpen(false); }}
                                    onOpenInNewTab={(url) => { onOpenInNewTab(url); setOverflowOpen(false); }}
                                    onRemove={onRemove}
                                />
                            </BookmarkMenuPortal>
                        )}
                    </div>
                )}
            </div>

            <button
                onClick={onOpenImport}
                className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 transition hover:bg-white/8 hover:text-indigo-300"
                title="从 Edge 导入"
            >
                <Download className="h-3.5 w-3.5" />
            </button>
            <button
                onClick={onOpenManager}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 transition hover:bg-white/8 hover:text-slate-200"
                title="书签管理器"
            >
                <Layers className="h-3.5 w-3.5" />
            </button>

            {openFolderId === '__bar__' && (
                <div className="absolute left-2 top-8 z-40" data-bm-menu>
                    <div className="w-52 overflow-hidden rounded-lg border border-white/10 bg-slate-900/98 py-1 shadow-2xl backdrop-blur">
                        <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">书签栏显示</div>
                        {([
                            ['always', '始终显示'],
                            ['newTab', '仅新标签页'],
                            ['never', '从不显示'],
                        ] as [BookmarkBarVisibility, string][]).map(([value, label]) => (
                            <button
                                key={value}
                                onClick={() => { onVisibilityChange(value); setOpenFolderId(null); }}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-slate-300 transition hover:bg-white/8"
                            >
                                <span className="flex h-3.5 w-3.5 items-center justify-center">
                                    {visibility === value && <Check className="h-3 w-3 text-indigo-400" />}
                                </span>
                                {label}
                            </button>
                        ))}
                        <div className="my-1 h-px bg-white/8" />
                        <button
                            onClick={() => { onOpenManager(); setOpenFolderId(null); }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-slate-300 transition hover:bg-white/8"
                        >
                            <Layers className="h-3 w-3" /> 书签管理器
                        </button>
                        <button
                            onClick={() => { onOpenImport(); setOpenFolderId(null); }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-slate-300 transition hover:bg-white/8"
                        >
                            <Download className="h-3 w-3" /> 从 Edge 导入
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

/** 书签栏上的一个条目：网址直接跳转，文件夹点开下拉 */
const BookmarkBarItem: React.FC<{
    node: BookmarkNode;
    onNavigate: (url: string) => void;
    onOpenInNewTab: (url: string) => void;
    onRemove: (id: string) => void;
    open: boolean;
    onToggle: () => void;
}> = ({ node, onNavigate, onOpenInNewTab, onRemove, open, onToggle }) => {
    const host = node.type === 'url' ? safeHostname(node.url || '') : '';
    // 下拉要贴在这个按钮下面，而它自己被 overflow-hidden 裁着 —— 见 BookmarkMenuPortal
    const btnRef = useRef<HTMLButtonElement | null>(null);

    return (
        <div className="relative shrink-0" data-bm-item data-bm-menu>
            <button
                ref={btnRef}
                onClick={() => (node.type === 'folder' ? onToggle() : onNavigate(node.url || ''))}
                onAuxClick={(event) => {
                    if (event.button !== 1 || node.type !== 'url') return;
                    event.preventDefault();
                    onOpenInNewTab(node.url || '');
                }}
                title={node.type === 'url' ? node.url : `${node.title}（${(node.children || []).length} 项）`}
                className={`flex h-6 max-w-[190px] items-center gap-1.5 rounded px-1.5 text-[11px] transition ${open ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/8 hover:text-white'
                    }`}
            >
                {node.type === 'folder' ? (
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                ) : (
                    <SiteIcon host={host} favicon={node.icon || ''} className="h-3.5 w-3.5 text-[8px]" />
                )}
                <span className="truncate">{node.title}</span>
            </button>

            {open && node.type === 'folder' && (
                <BookmarkMenuPortal anchor={btnRef.current}>
                    <BookmarkDropdown
                        nodes={node.children || []}
                        onNavigate={(url) => { onNavigate(url); onToggle(); }}
                        onOpenInNewTab={(url) => { onOpenInNewTab(url); onToggle(); }}
                        onRemove={onRemove}
                    />
                </BookmarkMenuPortal>
            )}
        </div>
    );
};

/**
 * 书签下拉菜单（文件夹内容 / 溢出内容共用）。
 *
 * 文件夹用**嵌套子菜单**而不是平铺：Edge 与 Chrome 都是这个行为，而且平铺
 * 会在深目录下变成一个几百项的长列表，反而找不到东西。
 *
 * **定位由 BookmarkMenuPortal 负责**，这里只画内容：调用方一律把它包在
 * portal 里。自己带 `absolute` 的话会被书签栏的 overflow-hidden 裁掉。
 */
const BookmarkDropdown: React.FC<{
    nodes: BookmarkNode[];
    onNavigate: (url: string) => void;
    onOpenInNewTab: (url: string) => void;
    onRemove: (id: string) => void;
}> = ({ nodes, onNavigate, onOpenInNewTab, onRemove }) => (
    <div
        className="custom-scrollbar max-h-[70vh] w-72 overflow-y-auto rounded-lg border border-white/10 bg-slate-900/98 py-1 shadow-2xl backdrop-blur"
        data-bm-menu
    >
        {nodes.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-slate-500">这个文件夹是空的</div>
        ) : nodes.map((node) => (
            <BookmarkDropdownRow
                key={node.id}
                node={node}
                onNavigate={onNavigate}
                onOpenInNewTab={onOpenInNewTab}
                onRemove={onRemove}
            />
        ))}
    </div>
);

const BookmarkDropdownRow: React.FC<{
    node: BookmarkNode;
    onNavigate: (url: string) => void;
    onOpenInNewTab: (url: string) => void;
    onRemove: (id: string) => void;
}> = ({ node, onNavigate, onOpenInNewTab, onRemove }) => {
    const [subOpen, setSubOpen] = useState(false);
    const host = node.type === 'url' ? safeHostname(node.url || '') : '';
    const rowRef = useRef<HTMLDivElement | null>(null);
    const closeTimer = useRef<number | null>(null);

    /**
     * 子菜单是 portal 到 body 的，鼠标从这一行移到子菜单上时会先离开这一行。
     * 直接 onMouseLeave 关掉的话，子菜单在鼠标抵达之前就没了 —— 表现为
     * 「嵌套文件夹永远展不开」。所以关要延迟，且进入子菜单时取消。
     */
    const cancelClose = useCallback(() => {
        if (closeTimer.current !== null) {
            window.clearTimeout(closeTimer.current);
            closeTimer.current = null;
        }
    }, []);
    const scheduleClose = useCallback(() => {
        cancelClose();
        closeTimer.current = window.setTimeout(() => setSubOpen(false), 160);
    }, [cancelClose]);
    useEffect(() => cancelClose, [cancelClose]);

    if (node.type === 'folder') {
        return (
            <div ref={rowRef} className="relative" onMouseEnter={() => { cancelClose(); setSubOpen(true); }} onMouseLeave={scheduleClose}>
                <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/8">
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate">{node.title}</span>
                    <ChevronRight className="h-3 w-3 shrink-0 text-slate-500" />
                </div>
                {subOpen && (
                    // 同样必须 portal：父级下拉是 overflow-y-auto，留在里面会被裁掉
                    <BookmarkMenuPortal anchor={rowRef.current} placement="right">
                        <div onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
                            <BookmarkDropdown
                                nodes={node.children || []}
                                onNavigate={onNavigate}
                                onOpenInNewTab={onOpenInNewTab}
                                onRemove={onRemove}
                            />
                        </div>
                    </BookmarkMenuPortal>
                )}
            </div>
        );
    }

    return (
        <div className="group/row flex items-center gap-2 px-3 py-1.5 hover:bg-white/8">
            <button
                onClick={() => onNavigate(node.url || '')}
                onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onOpenInNewTab(node.url || ''); } }}
                title={node.url}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
                <SiteIcon host={host} favicon={node.icon || ''} className="h-4 w-4 text-[9px]" />
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-slate-200">{node.title}</span>
                    <span className="block truncate font-mono text-[9px] text-slate-500">{host}</span>
                </span>
            </button>
            <button
                onClick={() => onRemove(node.id)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-600 opacity-0 transition group-hover/row:opacity-100 hover:bg-rose-500/15 hover:text-rose-300"
                title="移除"
            >
                <Trash2 className="h-3 w-3" />
            </button>
        </div>
    );
};

/* ========================================================================== */
/*                              书签管理器                                      */
/* ========================================================================== */

/**
 * 书签管理器：左侧文件夹树 + 右侧条目列表。
 *
 * 拖拽用的是 HTML5 draggable 而不是自己算坐标：这里的拖放目标是"另一个列表项"，
 * 而 dragover 事件天然带 preventDefault 语义（不 preventDefault 就不允许放置），
 * 自己实现反而要额外处理滚动与自动展开。
 *
 * **拒绝拖进自己的子树**：判据走 BookmarkService 的 isDescendant。这是本面板
 * 最需要防的事故 —— 朴素实现会把子树挂到自己里面，整块从书签里消失。
 */
const BookmarkManager: React.FC<{
    tree: BookmarkNode;
    onClose: () => void;
    onNavigate: (url: string) => void;
    onRemove: (id: string) => void;
    onRename: (id: string, title: string) => void;
    onUpdateUrl: (id: string, url: string) => void;
    onAddFolder: (parentId: string, title: string) => void;
    onMove: (id: string, targetFolderId: string, index?: number) => void;
    onOpenImport: () => void;
}> = ({ tree, onClose, onNavigate, onRemove, onRename, onUpdateUrl, onAddFolder, onMove, onOpenImport }) => {
    const [selectedId, setSelectedId] = useState(tree.id);
    const [query, setQuery] = useState('');
    const [dragId, setDragId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [newFolderMode, setNewFolderMode] = useState(false);

    const selected = findNode(tree, selectedId) || tree;
    const folders = useMemo(() => collectFolders(tree), [tree]);

    /**
     * 结构根的 id（"收藏夹栏 / 其他收藏夹" —— 虚拟根的直属孩子）。
     *
     * 它们删不得（removeBookmark 对根直接返回原树），所以之前挂在行上的删除键
     * 点了毫无反应。这里直接不渲染那个键，而不是留一个点不动的按钮。
     * 选中文件夹自身的删除走标题栏的「删除此文件夹」（见下面）。
     */
    const rootIds = useMemo(() => new Set((tree.children || []).map((c) => c.id)), [tree]);

    /** 当前选中的是不是一个可删除的文件夹（虚拟根与结构根除外） */
    const isSelectedDeletable = selected.type === 'folder' && selected.id !== tree.id && !rootIds.has(selected.id);

    /** 删除选中的文件夹本身，并把选中态退到父级（删完停在空处会让人以为没删掉） */
    const deleteSelectedFolder = () => {
        if (!isSelectedDeletable) return;
        const parent = findParent(tree, selected.id);
        onRemove(selected.id);
        setSelectedId(parent ? parent.id : tree.id);
    };

    /** 搜索结果：跨整个树，按标题与 url 匹配 */
    const searchResults = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        if (!keyword) return null;
        return flattenUrls(tree).filter((entry) => {
            const title = (entry.node.title || '').toLowerCase();
            const url = (entry.node.url || '').toLowerCase();
            return title.includes(keyword) || url.includes(keyword);
        }).slice(0, 300);
    }, [tree, query]);

    const list = searchResults
        ? searchResults.map((entry) => entry.node)
        : (selected.children || []);

    const commitEdit = () => {
        if (!editingId) return;
        if (editingId.startsWith('url:')) onUpdateUrl(editingId.slice(4), draft);
        else onRename(editingId, draft);
        setEditingId(null);
    };

    return (
        <div className="absolute inset-0 z-30 flex flex-col bg-slate-950/98 backdrop-blur">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/8 px-3">
                <Layers className="h-4 w-4 text-indigo-300" />
                <span className="text-xs font-bold text-slate-200">书签管理器</span>
                <span className="font-mono text-[10px] text-slate-500">
                    {countNodes(tree)} 项
                </span>
                <div className="relative ml-3 min-w-0 flex-1 max-w-xs">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-500" />
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="搜索书签…"
                        className="w-full rounded-md border border-white/10 bg-slate-900/70 py-1 pl-7 pr-2 text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-indigo-400/40"
                    />
                </div>
                <button
                    onClick={onOpenImport}
                    className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[10px] text-slate-300 transition hover:border-indigo-400/40 hover:text-indigo-200"
                >
                    <Download className="h-3 w-3" /> 从 Edge 导入
                </button>
                <button onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded text-slate-500 transition hover:bg-white/8 hover:text-slate-200">
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>

            <div className="flex min-h-0 flex-1">
                {/* 左：文件夹树 */}
                <div className="custom-scrollbar w-60 shrink-0 overflow-y-auto border-r border-white/8 py-2">
                    <FolderTreeRow
                        node={tree}
                        depth={0}
                        selectedId={selectedId}
                        onSelect={(id) => { setSelectedId(id); setQuery(''); }}
                        dragId={dragId}
                        onDragStart={setDragId}
                        onDropNode={(targetId) => {
                            if (dragId && dragId !== targetId) onMove(dragId, targetId);
                            setDragId(null);
                        }}
                    />
                    {folders.filter((f) => f.node.id !== tree.id).map((folder) => (
                        <FolderTreeRow
                            key={folder.node.id}
                            node={folder.node}
                            depth={folder.depth}
                            selectedId={selectedId}
                            onSelect={(id) => { setSelectedId(id); setQuery(''); }}
                            dragId={dragId}
                            onDragStart={setDragId}
                            onDropNode={(targetId) => {
                                if (dragId && dragId !== targetId) onMove(dragId, targetId);
                                setDragId(null);
                            }}
                        />
                    ))}
                </div>

                {/* 右：条目列表 */}
                <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/8 px-3">
                        <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-slate-300">
                            {searchResults ? `搜索「${query}」` : selected.title}
                        </span>
                        {!searchResults && (
                            <button
                                onClick={() => { setNewFolderMode(true); }}
                                className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-slate-400 transition hover:bg-white/8 hover:text-slate-200"
                            >
                                <FolderPlus className="h-3 w-3" /> 新建文件夹
                            </button>
                        )}
                        {!searchResults && isSelectedDeletable && (
                            <button
                                onClick={deleteSelectedFolder}
                                className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-slate-400 transition hover:bg-rose-500/15 hover:text-rose-300"
                                title="删除当前选中的文件夹（含其中全部书签）"
                            >
                                <Trash2 className="h-3 w-3" /> 删除此文件夹
                            </button>
                        )}
                    </div>

                    {newFolderMode && (
                        <div className="flex items-center gap-2 border-b border-white/8 px-3 py-1.5">
                            <input
                                autoFocus
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') { onAddFolder(selected.id, draft); setDraft(''); setNewFolderMode(false); }
                                    if (event.key === 'Escape') { setDraft(''); setNewFolderMode(false); }
                                }}
                                placeholder="文件夹名称，回车确认"
                                className="min-w-0 flex-1 rounded border border-white/10 bg-slate-900/70 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-indigo-400/40"
                            />
                            <button
                                onClick={() => { onAddFolder(selected.id, draft); setDraft(''); setNewFolderMode(false); }}
                                className="rounded px-2 py-1 text-[10px] text-indigo-300 hover:bg-white/8"
                            >
                                创建
                            </button>
                        </div>
                    )}

                    <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
                        {list.length === 0 ? (
                            <div className="flex h-full items-center justify-center text-[11px] text-slate-600">
                                {searchResults ? '没有匹配的书签' : '这个文件夹是空的 —— 把书签拖进来即可'}
                            </div>
                        ) : list.map((node, index) => (
                            <div
                                key={node.id}
                                draggable={!searchResults}
                                onDragStart={() => setDragId(node.id)}
                                onDragEnd={() => setDragId(null)}
                                onDragOver={(event) => {
                                    if (!dragId || dragId === node.id) return;
                                    // 拖到文件夹上 → 放进该文件夹；拖到网址上 → 插到它前面
                                    const source = findNode(tree, dragId);
                                    if (!source) return;
                                    if (node.type === 'folder' && isDescendant(source, node.id)) return;
                                    event.preventDefault();
                                }}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    if (!dragId || dragId === node.id) return;
                                    const source = findNode(tree, dragId);
                                    if (!source) return;
                                    if (node.type === 'folder') {
                                        if (isDescendant(source, node.id)) return;
                                        onMove(dragId, node.id);
                                    } else {
                                        onMove(dragId, selected.id, index);
                                    }
                                    setDragId(null);
                                }}
                                className={`group/bm flex items-center gap-2 px-3 py-1.5 transition ${dragId === node.id ? 'opacity-40' : 'hover:bg-white/5'
                                    }`}
                            >
                                {!searchResults && <GripVertical className="h-3 w-3 shrink-0 cursor-grab text-slate-700" />}
                                {node.type === 'folder' ? (
                                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                                ) : (
                                    <SiteIcon host={safeHostname(node.url || '')} favicon={node.icon || ''} className="h-4 w-4 text-[9px]" />
                                )}

                                {editingId === node.id || editingId === `url:${node.id}` ? (
                                    <input
                                        autoFocus
                                        value={draft}
                                        onChange={(event) => setDraft(event.target.value)}
                                        onBlur={commitEdit}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') commitEdit();
                                            if (event.key === 'Escape') setEditingId(null);
                                        }}
                                        className="min-w-0 flex-1 rounded border border-indigo-400/40 bg-slate-900/80 px-1.5 py-0.5 text-[11px] text-slate-100 outline-none"
                                    />
                                ) : (
                                    <button
                                        onClick={() => {
                                            if (node.type === 'folder') { setSelectedId(node.id); setQuery(''); }
                                            else onNavigate(node.url || '');
                                        }}
                                        className="min-w-0 flex-1 text-left"
                                    >
                                        <span className="block truncate text-[11px] text-slate-200">{node.title}</span>
                                        {node.type === 'url' && (
                                            <span className="block truncate font-mono text-[9px] text-slate-500">{node.url}</span>
                                        )}
                                        {node.type === 'folder' && (
                                            <span className="block text-[9px] text-slate-500">{(node.children || []).length} 项</span>
                                        )}
                                    </button>
                                )}

                                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover/bm:opacity-100">
                                    <button
                                        onClick={() => { setEditingId(node.id); setDraft(node.title); }}
                                        className="flex h-5 w-5 items-center justify-center rounded text-slate-500 hover:bg-white/10 hover:text-slate-200"
                                        title="重命名"
                                    >
                                        <Pencil className="h-3 w-3" />
                                    </button>
                                    {node.type === 'url' && (
                                        <button
                                            onClick={() => { setEditingId(`url:${node.id}`); setDraft(node.url || ''); }}
                                            className="flex h-5 w-5 items-center justify-center rounded text-slate-500 hover:bg-white/10 hover:text-slate-200"
                                            title="修改网址"
                                        >
                                            <Globe className="h-3 w-3" />
                                        </button>
                                    )}
                                    {/* 结构根（收藏夹栏 / 其他收藏夹）删不得，不渲染删除键 ——
                                        之前这里挂着点了没反应的按钮 */}
                                    {!rootIds.has(node.id) && (
                                        <button
                                            onClick={() => onRemove(node.id)}
                                            className="flex h-5 w-5 items-center justify-center rounded text-slate-500 hover:bg-rose-500/15 hover:text-rose-300"
                                            title="删除"
                                        >
                                            <Trash2 className="h-3 w-3" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

/** 管理器左侧的文件夹树一行 */
const FolderTreeRow: React.FC<{
    node: BookmarkNode;
    depth: number;
    selectedId: string;
    onSelect: (id: string) => void;
    dragId: string | null;
    onDragStart: (id: string) => void;
    onDropNode: (targetId: string) => void;
}> = ({ node, depth, selectedId, onSelect, dragId, onDragStart, onDropNode }) => {
    const [over, setOver] = useState(false);
    const isSelected = selectedId === node.id;

    return (
        <div
            draggable={depth > 0}
            onDragStart={() => onDragStart(node.id)}
            onDragOver={(event) => { if (dragId && dragId !== node.id) { event.preventDefault(); setOver(true); } }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => { event.preventDefault(); setOver(false); onDropNode(node.id); }}
            onClick={() => onSelect(node.id)}
            style={{ paddingLeft: 8 + depth * 12 }}
            className={`flex cursor-pointer items-center gap-1.5 py-1 pr-2 text-[11px] transition ${isSelected ? 'bg-indigo-500/15 text-indigo-200' : 'text-slate-300 hover:bg-white/6'
                } ${over ? 'ring-1 ring-inset ring-indigo-400/60' : ''}`}
        >
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="min-w-0 flex-1 truncate">{node.title}</span>
            <span className="shrink-0 font-mono text-[9px] text-slate-600">{countNodes(node)}</span>
        </div>
    );
};

/* ========================================================================== */
/*                              Edge 导入面板                                   */
/* ========================================================================== */

/** 导入项开关的清单。**唯一真值** —— 文案、默认值、请求参数都从这里生成 */
const EDGE_IMPORT_ITEMS: { key: string; label: string; hint: string; always?: boolean }[] = [
    { key: 'bookmarks', label: '收藏夹', hint: '含文件夹层级与网站图标', always: true },
    { key: 'favicons', label: '网站图标', hint: '从 Edge 的图标库取 16/32px 图' },
    { key: 'history', label: '浏览历史', hint: '最近 3000 条' },
    { key: 'autofill', label: '自动填充', hint: '表单里填过的名字与值' },
    { key: 'accounts', label: '账号', hint: '各站点保存的用户名（不含密码）' },
    { key: 'cookies', label: 'Cookie（含登录态）', hint: '需要完全退出 Edge' },
    { key: 'searchEngine', label: '默认搜索引擎', hint: '只读取，不自动切换' },
];

/** 导入来的账号落盘键。裸键，与书签那几个键同一命名空间 */
const EDGE_ACCOUNTS_STORE_KEY = 'react-player-edge-accounts';

/**
 * 导入来的账号存在 localStorage 里。
 *
 * 只显示在导入面板的结果里是不够的 —— 面板一关数字就没了，用户没法确认
 * 到底导进来了什么，也没法拿去用。而账号是明文（密码才是解不开的那个），
 * 存下来没有额外的安全损失：它们本来就在本机的 Edge 库里明文躺着。
 */
const loadStoredAccounts = (): EdgeAccountEntry[] => {
    const saved = loadJSON<EdgeAccountEntry[]>(EDGE_ACCOUNTS_STORE_KEY, [], '');
    return Array.isArray(saved) ? saved : [];
};

/**
 * Edge 导入面板。
 *
 * 三处刻意的设计：
 *
 *  1. **密码不可导入且写明原因**。不是漏做 —— Edge 的密码库是 v20
 *     （App-Bound Encryption），离线解密目前只做 Cookie（含登录态），
 *     密码的派生细节未验证。给一个点了没反应的开关比不做更糟。
 *  2. **逐项显示结果**。每个来源要么显示条数，要么显示失败原因。
 *     静默跳过会让用户以为"Edge 里就这些"。
 *  3. **Cookie 那条会明确提示先退出 Edge**。实测 Edge 关掉窗口后仍有后台进程
 *     持有 Cookies 库的独占锁（三种读法全 EBUSY），不提示的话用户只会看到
 *     一条莫名其妙的失败。
 */
const EdgeImportPanel: React.FC<{
    onClose: () => void;
    onImported: (result: EdgeImportResult) => MergeStats | null;
}> = ({ onClose, onImported }) => {
    const [detected, setDetected] = useState<EdgeDetectResult | null>(null);
    const [profileId, setProfileId] = useState('Default');
    const [enabled, setEnabled] = useState<Record<string, boolean>>({
        bookmarks: true, favicons: true, history: true, autofill: true, accounts: true, cookies: true, searchEngine: true,
    });
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState('');
    const [result, setResult] = useState<EdgeImportResult | null>(null);
    /** 本次实际合并进书签树的统计（与 Edge 侧条数是两回事：重复导入时 Edge 条数不变） */
    const [merge, setMerge] = useState<MergeStats | null>(null);
    const [error, setError] = useState('');
    const [accounts, setAccounts] = useState<EdgeAccountEntry[]>(loadStoredAccounts);
    const [showAccounts, setShowAccounts] = useState(false);

    useEffect(() => {
        const api = getElectronAPI();
        if (!api?.edge) { setError('读取不到 Edge 导入桥（preload 未加载），请重启应用。'); return; }
        api.edge.detect()
            .then((data) => {
                setDetected(data);
                if (data.profiles.length > 0) setProfileId(data.profiles[0].id);
            })
            .catch((e) => setError(e instanceof Error ? e.message : '探测 Edge 失败'));
    }, []);

    useEffect(() => {
        const api = getElectronAPI();
        if (!api?.edge) return;
        return api.edge.onProgress((message) => setProgress(message));
    }, []);

    const run = async () => {
        const api = getElectronAPI();
        if (!api?.edge) return;
        setRunning(true);
        setError('');
        setProgress('');
        try {
            const data = await api.edge.run({ profileId, include: enabled });
            setResult(data);
            // 账号要落盘才留得住 —— 面板一关数字就没了，用户无法确认导进来了什么
            if (data.ok && data.accounts.length > 0) {
                setAccounts(data.accounts);
                saveJSON(EDGE_ACCOUNTS_STORE_KEY, data.accounts, '');
            }
            if (data.ok) setMerge(onImported(data));
        } catch (e) {
            setError(e instanceof Error ? e.message : '导入失败');
        } finally {            setRunning(false);
            setProgress('');
        }
    };

    const profile = detected?.profiles.find((item) => item.id === profileId);

    return (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/80 p-6 backdrop-blur-sm">
            <div className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900/98 shadow-2xl">
                <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-4 py-3">
                    <Download className="h-4 w-4 text-indigo-300" />
                    <span className="text-xs font-bold text-slate-200">从 Edge 导入</span>
                    <div className="flex-1" />
                    <button onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded text-slate-500 transition hover:bg-white/8 hover:text-slate-200">
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>

                <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    {error && (
                        <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-500/25 bg-rose-500/8 px-3 py-2 text-[11px] text-rose-200">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}

                    {!detected && !error && (
                        <div className="flex items-center gap-2 py-6 text-[11px] text-slate-500">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在探测 Edge…
                        </div>
                    )}

                    {detected && !detected.available && (
                        <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-[11px] text-amber-200">
                            {detected.reason || '没有找到 Edge。'}
                        </div>
                    )}

                    {detected?.available && (
                        <>
                            <div className="mb-3 rounded-lg border border-white/8 bg-white/3 px-3 py-2">
                                <div className="text-[11px] font-bold text-slate-200">
                                    {detected.label} <span className="font-mono text-[10px] text-slate-500">{detected.version}</span>
                                </div>
                                <div className="mt-0.5 break-all font-mono text-[9px] text-slate-600">{detected.userDataDir}</div>
                            </div>

                            {detected.profiles.length > 1 && (
                                <div className="mb-3">
                                    <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">配置文件</div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {detected.profiles.map((item) => (
                                            <button
                                                key={item.id}
                                                onClick={() => setProfileId(item.id)}
                                                className={`rounded-md border px-2 py-1 text-[10px] transition ${profileId === item.id
                                                    ? 'border-indigo-400/50 bg-indigo-500/15 text-indigo-200'
                                                    : 'border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200'
                                                    }`}
                                            >
                                                {item.name} · {item.bookmarkCount} 书签
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {profile && (
                                <div className="mb-3 grid grid-cols-2 gap-1.5 text-[10px] text-slate-400">
                                    <div className="rounded border border-white/8 px-2 py-1">收藏夹 <span className="font-mono text-slate-200">{profile.bookmarkCount}</span> 条 / <span className="font-mono text-slate-200">{profile.folderCount}</span> 个文件夹</div>
                                    <div className="rounded border border-white/8 px-2 py-1">Cookie <span className={profile.hasCookies ? 'text-emerald-300' : 'text-slate-500'}>{profile.hasCookies ? '有' : '无'}</span></div>
                                </div>
                            )}

                            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">导入内容</div>
                            <div className="space-y-1">
                                {EDGE_IMPORT_ITEMS.map((item) => (
                                    <label
                                        key={item.key}
                                        className={`flex cursor-pointer items-start gap-2 rounded-lg border border-white/8 px-2.5 py-1.5 transition hover:bg-white/4 ${item.always ? 'opacity-70' : ''}`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={item.always ? true : Boolean(enabled[item.key])}
                                            disabled={Boolean(item.always)}
                                            onChange={(event) => setEnabled((prev) => ({ ...prev, [item.key]: event.target.checked }))}
                                            className="mt-0.5 h-3 w-3 shrink-0 accent-indigo-500"
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-[11px] text-slate-200">{item.label}</span>
                                            <span className="block text-[9px] text-slate-500">{item.hint}</span>
                                        </span>
                                    </label>
                                ))}
                            </div>

                            <div className="mt-2 flex items-start gap-2 rounded-lg border border-white/8 bg-white/3 px-2.5 py-2 text-[10px] text-slate-500">
                                <KeyRound className="mt-0.5 h-3 w-3 shrink-0 text-slate-600" />
                                <span>
                                    <span className="text-slate-400">密码无法导入（账号可以）。</span>
                                    Edge 里用户名是明文存储的，所以上面「账号」那一项能正常导入；
                                    但密码库用 App-Bound Encryption（v20）加密，密钥锁在系统级
                                    DPAPI 里，只有 Edge 进程本身能解，浏览器调试接口也不提供密码。
                                    这不是本应用的取舍，是 Windows 上的设计边界。
                                </span>
                            </div>

                            {result && (
                                <div className="mt-3 rounded-lg border border-white/8 bg-white/3 px-3 py-2">
                                    <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">导入结果</div>
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                                        <span className="text-slate-400">收藏夹</span>
                                        <span className="font-mono text-slate-200">{result.stats.bookmarks} 条 / {result.stats.folders} 文件夹</span>
                                        <span className="text-slate-400">网站图标</span>
                                        <span className="font-mono text-slate-200">{result.stats.favicons}</span>
                                        <span className="text-slate-400">浏览历史</span>
                                        <span className="font-mono text-slate-200">{result.stats.history}</span>
                                        <span className="text-slate-400">自动填充</span>
                                        <span className="font-mono text-slate-200">{result.stats.autofill}</span>
                                        <span className="text-slate-400">账号</span>
                                        <span className="font-mono text-slate-200">{result.stats.accounts}</span>
                                        <span className="text-slate-400">Cookie</span>
                                        <span className="font-mono text-slate-200">
                                            {result.stats.cookies}
                                            {typeof result.stats.cookiesApplied === 'number' && result.stats.cookiesApplied !== result.stats.cookies
                                                ? `（写入 ${result.stats.cookiesApplied}）`
                                                : ''}
                                        </span>
                                    </div>
                                    {merge && (
                                        <div className="mt-2 border-t border-white/8 pt-2 text-[10px] text-slate-400">
                                            本次合并：新增 <span className="font-mono text-emerald-300">{merge.added}</span> 条，
                                            跳过 <span className="font-mono text-slate-200">{merge.skipped}</span> 条（已存在）
                                        </div>
                                    )}
                                    {result.warnings.length > 0 && (
                                        <div className="mt-2 space-y-1 border-t border-white/8 pt-2">
                                            {result.warnings.map((warning, index) => (
                                                <div key={index} className="flex items-start gap-1.5 text-[10px] text-amber-300">
                                                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                                    <span>{warning.message}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {/* 账号列表可展开：只报一个数字，用户没法确认
                                        到底导进来了哪些站点、哪些用户名 */}
                                    {accounts.length > 0 && (
                                        <div className="mt-2 border-t border-white/8 pt-2">
                                            <button
                                                onClick={() => setShowAccounts((prev) => !prev)}
                                                className="flex w-full items-center gap-1 text-[10px] text-slate-400 transition hover:text-slate-200"
                                            >
                                                <ChevronDown className={`h-3 w-3 transition-transform ${showAccounts ? 'rotate-180' : ''}`} />
                                                {showAccounts ? '收起账号列表' : `查看导入的 ${accounts.length} 个账号`}
                                            </button>
                                            {showAccounts && (
                                                <div className="custom-scrollbar mt-1.5 max-h-52 space-y-0.5 overflow-y-auto">
                                                    {accounts.map((entry, index) => (
                                                        <div key={index} className="flex items-baseline gap-2 rounded px-1.5 py-1 hover:bg-white/5">
                                                            <span className="min-w-0 flex-1 truncate text-[10px] text-slate-200">{entry.username}</span>
                                                            <span className="min-w-0 flex-[1.2] truncate text-right font-mono text-[9px] text-slate-500">
                                                                {safeHostname(entry.origin)}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className="flex shrink-0 items-center gap-2 border-t border-white/8 px-4 py-3">
                    {progress && (
                        <span className="flex items-center gap-1.5 text-[10px] text-slate-400">
                            <Loader2 className="h-3 w-3 animate-spin" /> {progress}
                        </span>
                    )}
                    <div className="flex-1" />
                    <button onClick={onClose} className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-300 transition hover:bg-white/6">
                        关闭
                    </button>
                    <button
                        onClick={run}
                        disabled={running || !detected?.available}
                        className="flex items-center gap-1.5 rounded-lg bg-indigo-500/90 px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                        {running ? '导入中…' : result ? '再导入一次' : '开始导入'}
                    </button>
                </div>
            </div>
        </div>
    );
};

/* ========================================================================== */
/*                                  首页                                       */
/* ========================================================================== */

const HomePage: React.FC = () => (
    <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden px-8">
        {/* 氛围光：两团低透明度的径向渐变，撑出纵深，不做成会动的背景（会分心） */}
        <div className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 top-1/4 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600/10 blur-[120px]" />
            <div className="absolute bottom-0 right-1/4 h-[360px] w-[360px] rounded-full bg-cyan-500/6 blur-[110px]" />
        </div>

        <div className="relative z-10 flex w-full max-w-3xl flex-col items-center gap-9">
            <div className="flex flex-col items-center gap-4 text-center">
                <div className="relative">
                    <div className="absolute -inset-3 rounded-[28px] bg-gradient-to-br from-indigo-500/25 to-cyan-400/15 blur-xl" />
                    <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-white/12 bg-slate-900/80 shadow-[0_16px_40px_rgba(0,0,0,0.5)] backdrop-blur">
                        <Globe className="h-7 w-7 text-indigo-300" />
                    </div>
                </div>
                <h2 className="bg-gradient-to-b from-white to-slate-400 bg-clip-text text-2xl font-bold tracking-tight text-transparent">
                    探索未知的网络世界
                </h2>
                <p className="max-w-md text-xs leading-relaxed text-slate-500">
                    内置 <span className="font-semibold text-indigo-300">AI 嗅探引擎</span>，
                    点击嗅探即可提取页面里的视频流媒体资源；右侧 Agent 可以直接在这页里动手。
                </p>
            </div>
        </div>
    </div>
);

/* ========================================================================== */
/*                            错误页 / 崩溃页                                   */
/* ========================================================================== */

/**
 * 导航失败页。
 *
 * 与"白屏"的区别不只是好看：白屏让用户以为应用坏了，而错误页能说出
 * 是断网、DNS 错、证书过期还是站点下线 —— 这四种的处理方式完全不同。
 *
 * 证书类错误单独换一条建议（"重试"对证书问题没有意义），
 * 这是 classifyNavigationError 把 isCertificate 单独标出来的唯一原因。
 */
const ErrorPage: React.FC<{
    error: NavigationError;
    url: string;
    onRetry: () => void;
    onBack: () => void;
    canGoBack: boolean;
}> = ({ error, url, onRetry, onBack, canGoBack }) => (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-slate-950 px-8">
        <div className="relative">
            <div className="absolute -inset-3 rounded-[28px] bg-gradient-to-br from-rose-500/20 to-amber-400/10 blur-xl" />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-white/12 bg-slate-900/80 shadow-[0_16px_40px_rgba(0,0,0,0.5)]">
                {error.isCertificate ? (
                    <ShieldAlert className="h-6 w-6 text-amber-400" />
                ) : (
                    <AlertTriangle className="h-6 w-6 text-rose-400" />
                )}
            </div>
        </div>

        <div className="flex flex-col items-center gap-1.5 text-center">
            <h2 className="text-lg font-bold text-slate-200">{error.title}</h2>
            {error.host && (
                <div className="font-mono text-[11px] text-slate-500">{error.host}</div>
            )}
            {error.hint && (
                <p className="max-w-md text-xs leading-relaxed text-slate-500">{error.hint}</p>
            )}
            {error.isDns && (
                <p className="max-w-md text-[11px] leading-relaxed text-slate-600">
                    若本机用了代理，请确认设置里的代理端口正确 —— 代理不通时所有域名都会解析失败。
                </p>
            )}
        </div>

        {/* 原始错误码收在详情里：排查时有用，但不该是用户第一眼看到的东西 */}
        <details className="group max-w-md">
            <summary className="cursor-pointer list-none text-center text-[10px] text-slate-600 transition hover:text-slate-400">
                错误详情
            </summary>
            <div className="mt-2 space-y-1 rounded-lg border border-white/8 bg-white/[0.03] p-2.5 font-mono text-[10px] leading-relaxed text-slate-500">
                <div className="break-all">地址：{url || '（无）'}</div>
                <div>错误码：{error.errorCode}</div>
                {error.raw && <div className="break-all">描述：{error.raw}</div>}
            </div>
        </details>

        <div className="flex items-center gap-2">
            <button
                onClick={onRetry}
                className="flex h-8 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[11px] font-bold text-slate-900 transition hover:bg-slate-100"
            >
                <RotateCw className="h-3 w-3" />
                重试
            </button>
            {canGoBack && (
                <button
                    onClick={onBack}
                    className="flex h-8 items-center gap-1.5 rounded-lg border border-white/12 bg-white/5 px-3.5 text-[11px] font-bold text-slate-300 transition hover:bg-white/10"
                >
                    <ArrowLeft className="h-3 w-3" />
                    返回上一页
                </button>
            )}
        </div>
    </div>
);

/**
 * 渲染进程崩溃页。
 *
 * 与错误页分开的理由：那个是"页面没拿到"，可以重试；这个是"渲染进程没了"，
 * 重试没有意义 —— 必须重新加载。文案也不该说"重试"，那会让用户以为
 * 再点几次就能好。
 */
const CrashPage: React.FC<{ url: string; onReload: () => void }> = ({ url, onReload }) => (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-slate-950 px-8">
        <div className="relative">
            <div className="absolute -inset-3 rounded-[28px] bg-gradient-to-br from-amber-500/20 to-rose-400/10 blur-xl" />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-white/12 bg-slate-900/80 shadow-[0_16px_40px_rgba(0,0,0,0.5)]">
                <AlertTriangle className="h-6 w-6 text-amber-400" />
            </div>
        </div>

        <div className="flex flex-col items-center gap-1.5 text-center">
            <h2 className="text-lg font-bold text-slate-200">页面崩溃了</h2>
            {url && <div className="max-w-md truncate font-mono text-[11px] text-slate-500">{url}</div>}
            <p className="max-w-md text-xs leading-relaxed text-slate-500">
                这个页面的渲染进程已退出（通常是内存不足或页面自身的问题）。
                重新加载通常能恢复；反复崩溃的话，这个页面本身可能有问题。
            </p>
        </div>

        <button
            onClick={onReload}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[11px] font-bold text-slate-900 transition hover:bg-slate-100"
        >
            <RotateCw className="h-3 w-3" />
            重新加载
        </button>
    </div>
);

/* ========================================================================== */
/*                                 查找条                                       */
/* ========================================================================== */

/**
 * 页面内查找条。
 *
 * **必须定位在 webview 之上、且不能包住它**：webview 的父链一动就会重载
 * 页面（登录态、滚动位置、播放进度全丢）。所以它是一个绝对定位的兄弟层，
 * 和拖动遮罩是同一个道理。
 *
 * 匹配数的来源是 `found-in-page` 事件而不是 findInPage 的返回值 ——
 * webview 的 findInPage 只返回请求 id，**没有**匹配数。
 */
const FindBar: React.FC<{
    query: string;
    info: FindInfo;
    onChange: (text: string) => void;
    onNext: () => void;
    onPrev: () => void;
    onClose: () => void;
}> = ({ query, info, onChange, onNext, onPrev, onClose }) => {
    const inputRef = useRef<HTMLInputElement | null>(null);

    // 打开就聚焦并全选：查找条是"按 Ctrl+F 立刻打字"的交互，
    // 还要用户再点一下输入框是不能接受的
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    return (
        <div className="absolute right-4 top-3 z-30 flex items-center gap-1.5 rounded-xl border border-white/12 bg-slate-950/95 px-2 py-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <input
                ref={inputRef}
                value={query}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        if (event.shiftKey) onPrev(); else onNext();
                    }
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        onClose();
                    }
                }}
                placeholder="在此页面中查找"
                spellCheck={false}
                className="w-44 bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-600"
            />
            <span className={`shrink-0 font-mono text-[10px] ${info.matches === 0 && query ? 'text-rose-400' : 'text-slate-500'}`}>
                {query ? `${info.active}/${info.matches}` : ''}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
                <button
                    onClick={onPrev}
                    disabled={info.matches === 0}
                    className="flex h-5 w-5 items-center justify-center rounded text-slate-400 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                    title="上一个（Shift+Enter）"
                >
                    <ChevronDown className="h-3 w-3 rotate-180" />
                </button>
                <button
                    onClick={onNext}
                    disabled={info.matches === 0}
                    className="flex h-5 w-5 items-center justify-center rounded text-slate-400 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                    title="下一个（Enter）"
                >
                    <ChevronDown className="h-3 w-3" />
                </button>
                <button
                    onClick={onClose}
                    className="flex h-5 w-5 items-center justify-center rounded text-slate-500 transition hover:bg-white/10 hover:text-white"
                    title="关闭（Esc）"
                >
                    <X className="h-3 w-3" />
                </button>
            </div>
        </div>
    );
};

/* ========================================================================== */
/*                                下载面板                                      */
/* ========================================================================== */

/** 字节数 → 人类可读。与搜索结果列表共用一份实现（services/SearchService） */
const fmtBytes = (n: number): string => (n > 0 ? formatBytes(n) : '未知大小');

/**
 * 网页下载面板。
 *
 * 与嗅探下载的区别：那个是"我们发现了一个媒体地址，帮你下"，
 * 这个是"页面自己触发了下载"。前者走 ffmpeg/直链引擎，后者走 Chromium
 * 自带的下载栈 —— 所以进度、暂停、续传能力都不一样，界面也不该合并。
 *
 * 定位为覆盖层而不是常驻面板：下载是低频的，常驻会挤掉页面宽度。
 */
const DownloadsPanel: React.FC<{
    downloads: DownloadsState;
    onClose: () => void;
}> = ({ downloads, onClose }) => {
    const { items, actions } = downloads;

    return (
        <div className="absolute bottom-3 right-3 z-30 flex max-h-[70%] w-80 flex-col overflow-hidden rounded-xl border border-white/12 bg-slate-950/95 shadow-[0_16px_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
            <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-3 py-2">
                <Download className="h-3.5 w-3.5 text-slate-400" />
                <span className="flex-1 text-xs font-bold text-slate-200">下载内容</span>
                {items.some((d) => d.state !== 'progressing') && (
                    <button
                        onClick={actions.clearFinished}
                        className="rounded px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:bg-white/8 hover:text-slate-300"
                        title="清掉已结束的记录（不删文件）"
                    >
                        清空已结束
                    </button>
                )}
                <button
                    onClick={onClose}
                    className="flex h-5 w-5 items-center justify-center rounded text-slate-500 transition hover:bg-white/10 hover:text-white"
                    title="关闭"
                >
                    <X className="h-3 w-3" />
                </button>
            </div>

            <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
                {items.length === 0 ? (
                    <div className="px-3 py-8 text-center text-[11px] text-slate-600">
                        还没有下载过东西。<br />
                        页面里点「链接另存为」或直接点下载链接都会出现在这里。
                    </div>
                ) : (
                    items.map((item) => {
                        const done = item.state === 'completed';
                        const dead = item.state === 'cancelled' || item.state === 'interrupted';
                        return (
                            <div key={item.id} className="border-b border-white/6 px-3 py-2.5 last:border-b-0">
                                <div className="flex items-start gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-[11px] font-semibold text-slate-200" title={item.savePath || item.filename}>
                                            {item.filename}
                                        </div>
                                        <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                                            {dead ? (
                                                <span className="text-rose-400">
                                                    {item.state === 'cancelled' ? '已取消' : '已中断'}
                                                </span>
                                            ) : done ? (
                                                <span className="text-emerald-400">已完成 · {fmtBytes(item.receivedBytes)}</span>
                                            ) : item.paused ? (
                                                <span className="text-amber-400">已暂停 · {fmtBytes(item.receivedBytes)}</span>
                                            ) : (
                                                <>
                                                    {fmtBytes(item.receivedBytes)} / {fmtBytes(item.totalBytes)}
                                                    {item.speed > 0 && <span className="text-slate-600"> · {formatBytes(item.speed)}/s</span>}
                                                </>
                                            )}
                                        </div>
                                    </div>

                                    <div className="flex shrink-0 items-center gap-0.5">
                                        {item.state === 'progressing' && (
                                            <>
                                                <button
                                                    onClick={() => (item.paused ? actions.resume(item.id) : actions.pause(item.id))}
                                                    className="flex h-5 w-5 items-center justify-center rounded text-slate-400 transition hover:bg-white/10 hover:text-white"
                                                    title={item.paused ? '继续' : '暂停'}
                                                >
                                                    {item.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                                                </button>
                                                <button
                                                    onClick={() => actions.cancel(item.id)}
                                                    className="flex h-5 w-5 items-center justify-center rounded text-slate-400 transition hover:bg-rose-500/15 hover:text-rose-300"
                                                    title="取消下载"
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </>
                                        )}
                                        {done && (
                                            <>
                                                <button
                                                    onClick={() => actions.open(item.id)}
                                                    className="flex h-5 w-5 items-center justify-center rounded text-slate-400 transition hover:bg-white/10 hover:text-white"
                                                    title="打开文件"
                                                >
                                                    <Play className="h-3 w-3" />
                                                </button>
                                                <button
                                                    onClick={() => actions.reveal(item.id)}
                                                    className="flex h-5 w-5 items-center justify-center rounded text-slate-400 transition hover:bg-white/10 hover:text-white"
                                                    title="在文件夹中显示"
                                                >
                                                    <FolderOpen className="h-3 w-3" />
                                                </button>
                                            </>
                                        )}
                                        <button
                                            onClick={() => actions.remove(item.id)}
                                            className="flex h-5 w-5 items-center justify-center rounded text-slate-500 transition hover:bg-white/10 hover:text-white"
                                            title="从列表移除（不删文件）"
                                        >
                                            <Trash2 className="h-3 w-3" />
                                        </button>
                                    </div>
                                </div>

                                {/* 进度条。总长未知（服务器没给 Content-Length）时不画百分比 ——
                                    画一条编出来的进度比不画更糟 */}
                                {item.state === 'progressing' && (
                                    <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-white/8">
                                        {item.percent >= 0 ? (
                                            <div
                                                className="h-full rounded-full bg-indigo-400 transition-[width] duration-200"
                                                style={{ width: `${item.percent}%` }}
                                            />
                                        ) : (
                                            <div className="bp-indeterminate h-full w-1/3 rounded-full bg-indigo-400/70" />
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};

/* ========================================================================== */
/*                                浏览视图                                      */
/* ========================================================================== */

const BrowserView: React.FC<{
    tabs: Tab[];
    activeTabId: string;
    snifferError: string;
    /** 稳定身份的 webview ref 回调工厂，见 useBrowse 内注释 */
    getWebviewRef: (tabId: string) => (el: WebviewElement | null) => void;
    /** 重试加载（错误页的按钮） */
    onRetry: (tabId: string) => void;
    /** 重新加载崩溃的页面 */
    onRevive: (tabId: string) => void;
    onGoBack: (tabId: string) => void;
}> = ({
    tabs,
    activeTabId,
    snifferError,
    getWebviewRef,
    onRetry,
    onRevive,
    onGoBack,
}) => {
        const activeTab = tabs.find((tab) => tab.id === activeTabId);

        return (
            <div className="relative flex-1 overflow-hidden bg-slate-950">
                {/* 所有标签页常驻：只切可见性，不卸载。webview 一卸载就丢页面状态，
          切回来是重新加载（登录态、滚动、播放进度全没） */}
                {tabs.map((tab) => (
                    <div key={tab.id} className={`absolute inset-0 ${tab.id === activeTabId ? 'z-10' : 'invisible z-0'}`}>
                        {tab.url ? (
                            tab.initialUrl ? (
                                <webview
                                    // 必须用稳定身份的 ref：内联箭头每次渲染都是新函数，
                                    // React 会先以 null 调旧 ref 再以元素调新 ref，
                                    // 使 registerWebview 反复清空 ready 标记与刷新记账
                                    // （表现为每渲染重载一次、地址栏换地址无效）。
                                    ref={getWebviewRef(tab.id)}
                                    src={tab.initialUrl}
                                    className="h-full w-full border-none bg-white"
                                    // 必须与主进程 electron/main.js 的 USER_AGENT **逐字一致**：
                                    // 那里 onBeforeSendHeaders 会把这个 UA 写进真实请求头，
                                    // 而这里决定 JS 里 navigator.userAgent 报什么。两者不一致时，
                                    // "UA 头 / JS 里的 UA / 内核版本"三处互相矛盾，Cloudflare 的
                                    // managed 挑战必失败（点击了也过不去、反复弹回挑战页）。
                                    // 一致性由 scripts/test/mainstatic.test.js 静态校验。
                                    useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                                    // @ts-ignore: Electron 特有属性
                                    // Electron 的 BooleanAttribute 是 hasAttribute() 语义，
                                    // 属性存在即为真、与取值字符串无关。这里必须让属性存在，
                                    // 否则 window.open 被内核直接丢弃，主进程的
                                    // setWindowOpenHandler → navigate-to-url（新标签页）不会触发。
                                    allowpopups=""
                                    // @ts-ignore: Electron 特有属性
                                    webpreferences="contextIsolation=yes"
                                />
                            ) : null
                        ) : (
                            <HomePage />
                        )}

                        {/* 错误页与崩溃页盖在 webview **之上**，而不是替换它。
                            替换会让 webview 被卸载重挂 —— 那等于用户点一次重试
                            就重新加载一次页面，而且失败原因被丢掉。
                            盖着的话 webview 一直活着，重试只是让它再导航一次。 */}
                        {tab.error && (
                            <div className="absolute inset-0 z-20">
                                <ErrorPage
                                    error={tab.error}
                                    url={tab.url}
                                    onRetry={() => onRetry(tab.id)}
                                    onBack={() => onGoBack(tab.id)}
                                    canGoBack={tab.historyIndex > 0}
                                />
                            </div>
                        )}

                        {tab.crashed && !tab.error && (
                            <div className="absolute inset-0 z-20">
                                <CrashPage url={tab.url} onReload={() => onRevive(tab.id)} />
                            </div>
                        )}
                    </div>
                ))}

                {activeTab?.url && snifferError && (
                    <div className="animate-in fade-in absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-rose-500/25 bg-rose-950/85 px-4 py-2 text-xs text-rose-200 shadow-2xl backdrop-blur-md">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                        <span className="max-w-[60vw] truncate">{snifferError}</span>
                    </div>
                )}
            </div>
        );
    };

/* ========================================================================== */
/*                            Agent：规则草稿                                   */
/* ========================================================================== */

/**
 * 规则内容比较。
 *
 * 不能直接用 JSON.stringify：它对**键序敏感**，而规则对象是各处拼出来的 ——
 * 面板新建、引擎归一化、localStorage 反序列化各有一条路径。
 * 一旦某条路径的键序不同，这里就会把"内容完全一样"判成"用户有编辑"，
 * 于是草稿永远不跟随外部值，界面永远挂着"未应用"的提示。
 *
 * 实测目前三条路径的键序恰好一致（id, enabled, urlPattern, jsonPath, newValue），
 * 所以这是个**潜在**问题而非现症；但判错的代价（永久假提示）远大于排序开销，
 * 且它不依赖"以后不会有人改字段顺序"这个假设。
 */
const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        // 键名排序后再序列化；值递归处理，嵌套对象同样不受键序影响
        return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
};

const sameRules = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** 保存按钮的确认态：三种取值对应三种外观 */
type SaveStatus = 'idle' | 'saved' | 'failed';

/**
 * 「已应用」这个确认态此刻成不成立。
 *
 * 保存成功后 saveStatus 会保持 'saved' 两秒再收回。这两秒里用户若又改了规则，
 * dirty 已经变 true，但按钮还挂着绿勾「已应用」、横幅也不显示（它要求 idle）——
 * 用户此刻切走再回来，看到的就是"改动已保存"。
 * 所以渲染时再与 dirty 求与：一旦有未应用的改动，确认态立刻失效。
 *
 * failed 不这样处理：它说的是"没写进本地存储"，与之后改不改无关。
 */
const showsAsSaved = (status: SaveStatus, dirty: boolean): boolean =>
    status === 'saved' && !dirty;

/**
 * 外部规则变了，草稿该不该跟着换。
 *
 * 抽成纯函数是为了能直接测：这段判据有三个容易搞错的方向 ——
 * 判错会把用户正在敲的规则冲掉、让界面永远停在旧值，
 * 或者反过来报出一次并不存在的"被覆盖"。
 *
 * @param prev    上一版外部值（上次同步时记下的）
 * @param next    这一版外部值
 * @param current 用户此刻的草稿
 * @returns value 要采用的草稿；kept 表示"因用户有编辑而保留了他的草稿"
 */
const resolveDraftSync = <T,>(
    prev: T, next: T, current: T,
): { value: T; kept: boolean } => {
    // 草稿还等于上一版外部值 ⇒ 用户没在编辑，可以安全跟随
    if (sameRules(current, prev)) return { value: next, kept: false };
    // 草稿已经等于这一版外部值 ⇒ 外部变成的正是用户想要的那份。
    // 最典型的来源是**用户自己点了「应用更改」**：saveRules 把草稿数组原样
    // 交给 setState，于是 next 就是 current。此时没有"被覆盖"可言 ——
    // 不认这一条的话，用户每次保存完都会看到
    // 「Agent 在对话里改过规则，你手上有未应用的编辑」，而 Agent 根本没参与。
    if (sameRules(current, next)) return { value: next, kept: false };
    // 用户有未应用的编辑，且外部被改成了别的样子 ⇒ 保留他的草稿，由界面说明
    return { value: current, kept: true };
};

interface TamperDraft {
    intercept: TamperRule[];
    request: TamperRule[];
    headers: HeaderRule[];
    /** 启用中但会被引擎跳过的规则条数（目标键 / Header 名为空） */
    incompleteCount: number;
    /** 应用草稿；返回值是**持久化**结果（false = 已注入但没写进本地存储） */
    save: () => boolean;
    /** 丢弃草稿，改用引擎里当前生效的那一份 */
    reset: () => void;
    /** 草稿与引擎里已生效的规则是否一致 */
    dirty: boolean;
    /** 外部（通常是 Agent）改了规则，而用户手里有未应用的编辑 */
    overridden: boolean;
    setIntercept: (rules: TamperRule[]) => void;
    setRequest: (rules: TamperRule[]) => void;
    setHeaders: (rules: HeaderRule[]) => void;
}

/**
 * 规则草稿：面板上正在编辑、但还没点「应用更改」的那一份。
 *
 * 为什么要草稿而不是直接改引擎状态：编辑一条规则要敲十几个字符，
 * 每个字符都推给引擎的话，用户敲到一半的半成品规则（比如 jsonPath 只打了 `is_v`）
 * 会立刻生效并改写页面数据 —— 那不是"实时预览"，那是破坏。
 *
 * 草稿只在**外部规则本身变化**时跟随。不能顺带依赖别的（存储刷新、切标签页）：
 * 那些都会换新身份，从而把用户正在编辑的草稿冲掉。
 */
const useTamperDraft = (tamper: TamperState): TamperDraft => {
    const { interceptRules, requestRules, headerRules } = tamper.state;

    const [intercept, setIntercept] = useState<TamperRule[]>(interceptRules);
    const [request, setRequest] = useState<TamperRule[]>(requestRules);
    const [headers, setHeaders] = useState<HeaderRule[]>(headerRules);
    /** 外部改规则时用户手里有未应用的编辑 —— 用来提示"底下被改过" */
    const [overridden, setOverridden] = useState(false);

    // 上次同步时见到的外部值，用来判断"用户此刻是否干净"
    const seenRef = useRef({
        intercept: interceptRules, request: requestRules, headers: headerRules,
    });

    /**
     * 外部规则变化 → 决定草稿是否跟随。
     *
     * 不能无条件重置：**模型自己会改这三份规则**
     * （tamper_rules set → applyRules → setInterceptRules），每次都产生新数组身份；
     * 无条件重置就会把用户正在敲的那条规则冲掉 —— 用户敲到一半、模型在后台跑完
     * 一步，输入就没了。
     *
     * 这里直接读闭包里的三个草稿，而不是用函数式 updater：effect 在 commit 之后
     * 执行，闭包里的值就是当前已提交的值。用 updater 反而错 —— updater 要等到
     * 下一次渲染才跑，在它里面置标志位、外面立刻读，读到的永远是初始值。
     *
     * 依赖数组刻意不含草稿本身：含了就会每敲一个键都跑一遍，
     * 而那时 prev 已被更新，等于每次都判"没在编辑"。
     */
    useEffect(() => {
        const prev = seenRef.current;
        seenRef.current = { intercept: interceptRules, request: requestRules, headers: headerRules };

        const ri = resolveDraftSync(prev.intercept, interceptRules, intercept);
        const rr = resolveDraftSync(prev.request, requestRules, request);
        const rh = resolveDraftSync(prev.headers, headerRules, headers);

        if (!ri.kept) setIntercept(ri.value);
        if (!rr.kept) setRequest(rr.value);
        if (!rh.kept) setHeaders(rh.value);

        setOverridden(ri.kept || rr.kept || rh.kept);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [interceptRules, requestRules, headerRules]);

    /**
     * 启用中的规则里，有几条会被引擎跳过（目标键 / Header 名为空）。
     *
     * 判据走 utils 里的 collectDroppedRules —— 与 Agent 的 tamper_rules 工具
     * 共用同一份实现。各写一份的话，面板说"3 条被跳过"、工具说"2 条"，
     * 而用户和模型都没法判断该信哪个。
     *
     * 面板默认新建的就是半空规则，不点出来用户看到的是「启用中」而实际什么都没发生。
     */
    const incompleteCount = useMemo(
        () => collectDroppedRules({ intercept, request, headers }).length,
        [intercept, request, headers],
    );

    const dirty = useMemo(() => (
        !sameRules(intercept, interceptRules)
        || !sameRules(request, requestRules)
        || !sameRules(headers, headerRules)
    ), [intercept, request, headers, interceptRules, requestRules, headerRules]);

    /**
     * 应用草稿。
     *
     * 返回的是**持久化**结果，不是注入结果 —— 两者会分离（配额爆了规则仍对
     * 当前页面生效，但重启就没了）。调用方必须把这两种结果分开告诉用户。
     */
    const save = useCallback((): boolean => (
        tamper.actions.saveRules(intercept, request, headers)
    ), [tamper.actions, intercept, request, headers]);

    const reset = useCallback(() => {
        setIntercept(interceptRules);
        setRequest(requestRules);
        setHeaders(headerRules);
        setOverridden(false);
    }, [interceptRules, requestRules, headerRules]);

    return {
        intercept, request, headers, incompleteCount, save, reset, dirty, overridden,
        setIntercept, setRequest, setHeaders,
    };
};

/* ========================================================================== */
/*                            Agent：篡改共用件                                 */
/* ========================================================================== */

/**
 * 是否是严格的 JSON 数字字面量。与引擎里的 isStrictNumber 同构。
 *
 * 不用正则：引擎那段脚本嵌在模板字符串里，正则里的反斜杠会被模板吃掉
 * （实测源码写反斜杠 d 的转义、运行时变成裸 d）。这里保持一致，也便于对照。
 */
const isStrictNumber = (s: string): boolean => {
    if (s === '') return false;

    let i = 0;
    if (s.charAt(0) === '-') i++;
    if (i >= s.length) return false;

    // 整数部分：单个 0，或 1-9 开头的数字串（不许前导零）
    const intStart = i;
    if (s.charAt(i) === '0') {
        i++;
    } else if (s.charAt(i) >= '1' && s.charAt(i) <= '9') {
        i++;
        while (i < s.length && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
    } else {
        return false;
    }
    if (i - intStart > 1 && s.charAt(intStart) === '0' && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
        return false;
    }

    // 小数部分
    if (i < s.length && s.charAt(i) === '.') {
        i++;
        const fracStart = i;
        while (i < s.length && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
        if (i === fracStart) return false;
    }

    // 指数部分
    if (i < s.length && (s.charAt(i) === 'e' || s.charAt(i) === 'E')) {
        i++;
        if (i < s.length && (s.charAt(i) === '+' || s.charAt(i) === '-')) i++;
        const expStart = i;
        while (i < s.length && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
        if (i === expStart) return false;
    }

    return i === s.length;
};

/**
 * 「新值」这一栏实际会被写成什么。
 *
 * 判据必须与引擎的 parseValue / isStrictNumber **逐字一致**，
 * 否则这个预览本身就成了假信息。一致性由回归测试交叉验证。
 *
 * 面板只有一个文本框，靠写法猜类型；猜错的代价是静默的类型变化，
 * 所以把猜测结果实时显示出来，用户一眼就能发现"等号被吃了""前导零没了"。
 */
const describeNewValue = (raw: string): string => {
    // 与引擎一致：= 前缀取原文；想得到以 = 开头的字符串就双写
    if (raw.charAt(0) === '=') return `字符串 ${JSON.stringify(raw.slice(1))}`;
    if (raw === 'true' || raw === 'false') return `布尔 ${raw}`;
    if (raw === 'null') return 'null';

    // 引擎里 undefined 是显式支持的（parseValue 有单独一行）。
    // 赋成 undefined 后 JSON.stringify 会丢掉这个键 —— 效果是**删除字段**。
    // 不说清楚的话，用户以为在写字符串 "undefined"，实际把字段删了。
    if (raw === 'undefined') return 'undefined（该字段会从响应里消失）';

    if (isStrictNumber(raw)) return `数字 ${Number(raw)}`;
    return `字符串 ${JSON.stringify(raw)}`;
};

/**
 * 「目标键」这一栏实际会匹配什么。
 *
 * 引擎只取 `jsonPath.split('.').pop()` 作为键名，**不限层级**：
 * 规则 `id` 与 `user.id` 都会命中任意深度上名为 id 的字段。
 * 用户看到 `user.id` 很自然会以为限定了路径，实际会把列表里每条记录的 id 一起改掉。
 */
const describeJsonPath = (raw: string): string => {
    if (!raw) return '未填写，该规则会被跳过';

    const key = raw.split('.').pop() || '';
    if (!key) return '只有分隔符，该规则会被跳过';

    if (raw.includes('.')) {
        return `只按末段匹配：任意层级上名为 ${JSON.stringify(key)} 的字段都会被改，不只是这一层`;
    }
    return `匹配任意层级上名为 ${JSON.stringify(key)} 的字段`;
};

/** 写了点号但引擎并不按路径解释 —— 用来触发提醒色 */
const isDottedJsonPath = (raw: string): boolean =>
    raw.includes('.') && !!(raw.split('.').pop() || '');

const EmptyState: React.FC<{ text?: string }> = ({ text = '暂无规则配置' }) => (
    <div className="rounded-xl border border-dashed border-white/8 py-6 text-center text-[11px] text-slate-600">
        {text}
    </div>
);

const FieldInput: React.FC<{
    label: string;
    value: string;
    placeholder: string;
    onChange: (value: string) => void;
    className?: string;
    inputClassName?: string;
    /** 输入框下方的一行说明（如「将写入：数字 42」） */
    hint?: string;
    /** 说明的色调：warn 用于「你的写法与预期不符」这类提醒 */
    hintTone?: 'normal' | 'warn';
    /**
     * 说明的前缀。默认「将写入：」——但那只对**值**字段成立。
     * 「目标键」不是被写入的值（它说明的是这条规则会匹配什么），
     * 用同一个前缀会写出「将写入：未填写，该规则会被跳过」这种读不通的话。
     */
    hintPrefix?: string;
}> = ({ label, value, placeholder, onChange, className = '', inputClassName = '', hint, hintTone = 'normal', hintPrefix = '将写入：' }) => (
    <div className={className}>
        <div className="relative">
            <span className="absolute left-2.5 top-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-600">{label}</span>
            <input
                type="text"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                className={`w-full rounded-lg border border-white/10 bg-black/25 px-2.5 pb-1.5 pt-5 font-mono text-[11px] text-slate-200 outline-none transition focus:border-indigo-400/40 ${inputClassName}`}
            />
        </div>
        {hint && (
            <p className={`mt-1 px-1 text-[10px] leading-relaxed ${hintTone === 'warn' ? 'text-amber-300/90' : 'text-slate-600'}`}>
                {hintTone === 'warn' ? '⚠ ' : hintPrefix}{hint}
            </p>
        )}
    </div>
);

/* ========================================================================== */
/*                            Agent：拦截规则页                                 */
/* ========================================================================== */

const blankRule = (): TamperRule =>
    ({ id: generateId(), enabled: true, urlPattern: '', jsonPath: '', newValue: '' });

/** 对一份规则数组做「改一条 / 加一条 / 删一条」—— 响应与请求两栏共用 */
const useRuleOps = (rules: TamperRule[], onChange: (rules: TamperRule[]) => void) => ({
    update: (index: number, field: keyof TamperRule, value: unknown) => {
        const next = [...rules];
        next[index] = { ...next[index], [field]: value };
        onChange(next);
    },
    add: () => onChange([...rules, blankRule()]),
    remove: (index: number) => onChange(rules.filter((_, i) => i !== index)),
});

/**
 * 拦截规则页：响应篡改 + 请求体篡改。
 *
 * 纯展示组件 —— 草稿状态由 useTamperDraft 持有（见该处说明：为什么不能
 * 边敲边推给引擎）。这里只负责把草稿画出来并回调修改。
 */
const RulesTab: React.FC<{
    intercept: TamperRule[];
    request: TamperRule[];
    onInterceptChange: (rules: TamperRule[]) => void;
    onRequestChange: (rules: TamperRule[]) => void;
}> = ({ intercept, request, onInterceptChange, onRequestChange }) => (
    <div className="space-y-6">
        {/* 能力边界：规则只对当前页面主世界的 JS 生效。
        不写出来的话，用户遇到"改了没反应"会一直以为是规则写错了。 */}
        <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2 text-[10px] leading-relaxed text-slate-500">
            规则作用于<strong className="text-slate-400">当前页面的 JS</strong>（XHR / fetch / 存储）。
            以下情况不生效：Web Worker、Service Worker 内部解析、跨域 iframe 内的请求、
            页面在注入前就存下了 <code className="text-slate-400">JSON.parse</code> 引用、WASM 解析。
            <br />
            存储规则只覆盖 <code className="text-slate-400">storage.getItem(k)</code>，
            不覆盖 <code className="text-slate-400">storage[k]</code> 这种具名属性读法 ——
            页面若用后者，读到的仍是真实值。
        </div>

        <RuleSection
            title="响应篡改"
            desc="拦截 JSON 响应并替换目标字段。同名规则也会改写 localStorage / sessionStorage 的读取结果。想强制按字符串写入时在「新值」前加 =（想写以 = 开头的值就双写）。"
            tone="cyan"
            rules={intercept}
            ops={useRuleOps(intercept, onInterceptChange)}
            icon={Database}
        />

        <RuleSection
            title="请求体篡改"
            desc="在请求发出前修改 JSON Body 中的目标字段。"
            tone="violet"
            rules={request}
            ops={useRuleOps(request, onRequestChange)}
            icon={ArrowRightLeft}
        />
    </div>
);

const RuleSection: React.FC<{
    title: string;
    desc: string;
    tone: 'cyan' | 'violet';
    rules: TamperRule[];
    ops: { update: (index: number, field: keyof TamperRule, value: unknown) => void; add: () => void; remove: (index: number) => void };
    icon: React.ComponentType<{ className?: string }>;
}> = ({ title, desc, tone, rules, ops, icon: Icon }) => {
    const accent = tone === 'cyan' ? 'text-cyan-300' : 'text-violet-300';

    return (
        <div>
            <div className="mb-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h4 className={`flex items-center gap-1.5 text-xs font-bold ${accent}`}>
                        <Icon className="h-3.5 w-3.5" />
                        {title}
                    </h4>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{desc}</p>
                </div>
                <button
                    onClick={ops.add}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/6 px-2 py-1 text-[11px] text-slate-300 transition hover:bg-white/12 hover:text-white"
                >
                    <Plus className="h-3 w-3" />
                    新增
                </button>
            </div>

            <div className="space-y-2.5">
                {rules.length === 0 ? <EmptyState /> : rules.map((rule, index) => (
                    <div
                        key={rule.id || index}
                        className={`rounded-xl border p-2.5 transition-all ${rule.enabled ? 'border-white/10 bg-white/[0.04]' : 'border-white/6 bg-black/20 opacity-60 grayscale'}`}
                    >
                        <div className="mb-2.5 flex items-center gap-2">
                            <label className="flex cursor-pointer items-center gap-1.5 select-none">
                                <input
                                    type="checkbox"
                                    checked={rule.enabled}
                                    onChange={(event) => ops.update(index, 'enabled', event.target.checked)}
                                    className="h-3 w-3 accent-indigo-400"
                                />
                                <span className={`text-[10px] font-bold ${rule.enabled ? 'text-slate-300' : 'text-slate-600'}`}>
                                    {rule.enabled ? '启用中' : '已禁用'}
                                </span>
                            </label>
                            <div className="mx-1 h-px flex-1 bg-white/8" />
                            <button
                                onClick={() => ops.remove(index)}
                                className="flex h-5 w-5 items-center justify-center rounded text-slate-600 transition hover:bg-rose-500/15 hover:text-rose-300"
                                title="删除这条规则"
                            >
                                <Trash2 className="h-3 w-3" />
                            </button>
                        </div>

                        {/* 侧边栏窄，字段竖排；窗口拉宽后由容器查询切成两列（见 index.css） */}
                        <div className="bp-field-grid">
                            <FieldInput
                                label="URL 匹配"
                                value={rule.urlPattern}
                                placeholder="*（全部）"
                                onChange={(value) => ops.update(index, 'urlPattern', value)}
                                className="bp-field-wide"
                            />
                            <FieldInput
                                label="目标键"
                                value={rule.jsonPath}
                                placeholder="例如 is_vip"
                                onChange={(value) => ops.update(index, 'jsonPath', value)}
                                hint={describeJsonPath(rule.jsonPath)}
                                hintTone={isDottedJsonPath(rule.jsonPath) ? 'warn' : 'normal'}
                                hintPrefix="实际匹配："
                            />
                            <FieldInput
                                label="新值"
                                value={rule.newValue}
                                placeholder="例如 true（加 = 强制当字符串）"
                                onChange={(value) => ops.update(index, 'newValue', value)}
                                inputClassName={accent}
                                hint={describeNewValue(rule.newValue)}
                            />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

/* ========================================================================== */
/*                            Agent：请求头页                                   */
/* ========================================================================== */

/**
 * 请求头控制页。
 *
 * `headerValue` 留空 = **删除**该请求头（引擎里 `''` 有专门语义）。
 * 占位符必须写出来，否则用户以为留空是"不改"。
 */
const HeadersTab: React.FC<{
    headers: HeaderRule[];
    onChange: (rules: HeaderRule[]) => void;
}> = ({ headers, onChange }) => {
    const update = (index: number, field: keyof HeaderRule, value: unknown) => {
        const next = [...headers];
        next[index] = { ...next[index], [field]: value };
        onChange(next);
    };

    return (
        <div className="space-y-2.5">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h4 className="flex items-center gap-1.5 text-xs font-bold text-amber-300">
                        <ArrowRightLeft className="h-3.5 w-3.5" />
                        请求头注入
                    </h4>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                        修改或注入 HTTP Request Headers，例如 Authorization、User-Agent。
                        <strong className="text-amber-300/80">值留空表示删除该请求头。</strong>
                    </p>
                </div>
                <button
                    onClick={() => onChange([...headers, { id: generateId(), enabled: true, urlPattern: '', headerName: '', headerValue: '' }])}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/6 px-2 py-1 text-[11px] text-slate-300 transition hover:bg-white/12 hover:text-white"
                >
                    <Plus className="h-3 w-3" />
                    新增
                </button>
            </div>

            {headers.length === 0 ? <EmptyState /> : headers.map((rule, index) => (
                <HeaderRuleRow
                    key={rule.id || index}
                    rule={rule}
                    onChange={(field, value) => update(index, field, value)}
                    onRemove={() => onChange(headers.filter((_, i) => i !== index))}
                />
            ))}
        </div>
    );
};

const HeaderRuleRow: React.FC<{
    rule: HeaderRule;
    onChange: (field: keyof HeaderRule, value: unknown) => void;
    onRemove: () => void;
}> = ({ rule, onChange, onRemove }) => (
    <div className={`flex flex-col gap-2 rounded-xl border p-2.5 transition-all ${rule.enabled ? 'border-white/10 bg-white/[0.04]' : 'border-white/6 bg-black/20 opacity-60'}`}>
        <div className="flex items-center gap-1.5">
            <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(event) => onChange('enabled', event.target.checked)}
                className="h-3 w-3 shrink-0 accent-amber-400"
            />
            <input
                type="text"
                value={rule.headerName}
                onChange={(event) => onChange('headerName', event.target.value)}
                placeholder="Header-Name"
                spellCheck={false}
                className="min-w-0 flex-1 border-b border-transparent bg-transparent font-mono text-[11px] font-bold text-amber-300 outline-none transition placeholder:text-slate-700 hover:border-white/10 focus:border-amber-400/60"
            />
            <span className="shrink-0 text-slate-700">:</span>
            <input
                type="text"
                value={rule.headerValue}
                onChange={(event) => onChange('headerValue', event.target.value)}
                placeholder="值（留空 = 删除）"
                spellCheck={false}
                className="min-w-0 flex-[1.4] border-b border-transparent bg-transparent font-mono text-[11px] text-slate-300 outline-none transition placeholder:text-slate-700 hover:border-white/10 focus:border-amber-400/60"
            />
            <button
                onClick={onRemove}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-600 transition hover:bg-rose-500/15 hover:text-rose-300"
                title="删除这条规则"
            >
                <Trash2 className="h-3 w-3" />
            </button>
        </div>
        <input
            type="text"
            value={rule.urlPattern}
            onChange={(event) => onChange('urlPattern', event.target.value)}
            placeholder="URL 匹配模式（留空或 * 表示全部）"
            spellCheck={false}
            className="rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 font-mono text-[10px] text-slate-400 outline-none transition focus:border-indigo-400/40"
        />
    </div>
);

/* ========================================================================== */
/*                            Agent：存储页                                     */
/* ========================================================================== */

/**
 * 存储管理页：localStorage / sessionStorage / Cookie。
 *
 * 存储是**即改即存**的（不像规则需要草稿 + 应用），所以这里不接草稿，
 * 直接用引擎的 actions。读取一律走引擎（真值，绕过篡改规则）——
 * 面板是管理真实存储的地方，显示被规则改写后的值会让用户以为保存失败。
 */
const StorageTab: React.FC<{ tamper: TamperState; currentUrl: string }> = ({ tamper, currentUrl }) => {
    const { actions } = tamper;

    const [expanded, setExpanded] = useState<Record<string, boolean>>({ local: true, session: false, cookie: false });
    const [cookies, setCookies] = useState<CookieItem[]>([]);
    const [localData, setLocalData] = useState<Record<string, string>>({});
    const [sessionData, setSessionData] = useState<Record<string, string>>({});
    /** 上一次写入失败的原因（配额爆了 / 页面禁用了存储） */
    const [storageError, setStorageError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        // 单独 try/catch：cookie 走 IPC，通道异常时若让它冒出去，
        // 后面的 localStorage / sessionStorage 就一起读不到了。
        try { setCookies(await actions.getCookies()); } catch { setCookies([]); }
        try { setLocalData(JSON.parse(await actions.getLocalStorage())); } catch { setLocalData({}); }
        try { setSessionData(JSON.parse(await actions.getSessionStorage())); } catch { setSessionData({}); }
    }, [actions]);

    // 存储按当前页面取，切标签页或刷新时重新读
    useEffect(() => { void refresh(); }, [refresh, currentUrl]);

    const updateLS = async (key: string, value: string) => {
        const ok = await actions.setLocalStorage(key, value);
        setStorageError(ok ? null : '写入失败：页面可能已禁用存储或配额已满');
        await refresh();
    };

    const updateSS = async (key: string, value: string) => {
        const ok = await actions.setSessionStorage(key, value);
        setStorageError(ok ? null : '写入失败：页面可能已禁用存储或配额已满');
        await refresh();
    };

    /** 删掉一个存储键。删完立刻重读，否则界面还显示着已删的条目 */
    const removeEntry = async (area: 'local' | 'session', key: string) => {
        const ok = area === 'local'
            ? await actions.removeLocalStorage(key)
            : await actions.removeSessionStorage(key);
        setStorageError(ok ? null : '删除失败：页面可能已禁用存储');
        await refresh();
    };

    /**
     * 改一条 Cookie。
     *
     * 走引擎的 setCookie —— 它会把 httpOnly / sameSite / expirationDate 原样带上。
     * cookies.set 是整条覆盖：漏掉 httpOnly 会把 HttpOnly 会话 cookie 降级成
     * JS 可读的普通 cookie，漏掉 expirationDate 会把持久 cookie 变成会话 cookie
     * （关掉窗口就掉登录态）—— 改一个字符的代价不该是会话失效。
     */
    const updateCookie = async (cookie: CookieItem, value: string) => {
        const ok = await actions.setCookie({ ...cookie, value });
        setStorageError(ok ? null : '写入 Cookie 失败：当前没有可用的页面地址');
        await refresh();
    };

    /**
     * 删掉一条 cookie。
     *
     * cookies.remove(url, name) 按 name 删，同名不同 path 的 cookie 会被一起删掉。
     * 这是 Electron API 的限制（没有按 path 删的入口），删前在界面上已经过一次确认。
     */
    const removeCookieEntry = async (cookie: CookieItem) => {
        const ok = await actions.removeCookie(cookie.name);
        setStorageError(ok ? null : '删除 Cookie 失败：当前没有可用的页面地址');
        await refresh();
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] leading-relaxed text-slate-600">
                    改完即时生效。这里显示的是<strong className="text-slate-400">真实值</strong>，
                    页面 JS 读到的可能被拦截规则改写。
                </p>
                <button
                    onClick={() => void refresh()}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-400 transition hover:bg-white/12 hover:text-white"
                    title="刷新存储"
                >
                    <RefreshCw className="h-3.5 w-3.5" />
                </button>
            </div>

            {storageError && (
                <div className="flex items-start justify-between gap-3 rounded-xl border border-rose-400/20 bg-rose-500/8 px-3 py-2 text-[10px] text-rose-200">
                    <span className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        {storageError}
                    </span>
                    <button onClick={() => setStorageError(null)} className="shrink-0 text-rose-300/70 transition hover:text-rose-100">
                        关闭
                    </button>
                </div>
            )}

            <StorageGroup
                title="Local Storage"
                count={Object.keys(localData).length}
                expanded={expanded.local}
                onToggle={() => setExpanded((prev) => ({ ...prev, local: !prev.local }))}
                data={localData}
                onSave={updateLS}
                onDelete={(key) => void removeEntry('local', key)}
                icon={Layers}
            />
            <StorageGroup
                title="Session Storage"
                count={Object.keys(sessionData).length}
                expanded={expanded.session}
                onToggle={() => setExpanded((prev) => ({ ...prev, session: !prev.session }))}
                data={sessionData}
                onSave={updateSS}
                onDelete={(key) => void removeEntry('session', key)}
                icon={Layers}
            />
            <StorageGroup
                title="Cookies"
                count={cookies.length}
                expanded={expanded.cookie}
                onToggle={() => setExpanded((prev) => ({ ...prev, cookie: !prev.cookie }))}
                // 同名 cookie 在 Chrome 里按 name+domain+path 并存，访问子域时会同时
                // 返回 `sid@sub.example.com` 与 `sid@.example.com`。键必须能区分它们，
                // 否则面板少显示一条，且 find 回写只会命中先出现的那条。
                // buildCookieKeys 只在真会撞时才补 domain，避免刷出噪声。
                data={buildCookieData(cookies)}
                onSave={(key, value) => {
                    const cookie = findCookieByKey(cookies, key);
                    if (cookie) void updateCookie(cookie, value);
                }}
                onDelete={(key) => {
                    const cookie = findCookieByKey(cookies, key);
                    if (cookie) void removeCookieEntry(cookie);
                }}
                icon={Globe}
            />
        </div>
    );
};

const StorageGroup: React.FC<{
    title: string;
    count: number;
    expanded: boolean;
    onToggle: () => void;
    data: Record<string, string>;
    onSave: (key: string, value: string) => void | Promise<void>;
    onDelete: (key: string) => void;
    icon: React.ComponentType<{ className?: string }>;
}> = ({ title, count, expanded, onToggle, data, onSave, onDelete, icon: Icon }) => {
    const keys = Object.keys(data);

    return (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
            <button onClick={onToggle} className="flex w-full items-center justify-between px-3 py-2 transition hover:bg-white/6">
                <span className="flex items-center gap-2 text-[11px] font-bold text-slate-300">
                    <Icon className="h-3.5 w-3.5 text-slate-500" />
                    {title}
                </span>
                <span className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-slate-600">{count} 项</span>
                    {expanded ? <ChevronDown className="h-3.5 w-3.5 text-slate-600" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-600" />}
                </span>
            </button>

            {expanded && (
                <div className="border-t border-white/8">
                    {keys.length === 0 ? (
                        <div className="p-3 text-center text-[10px] text-slate-600">没有可显示的数据</div>
                    ) : (
                        keys.map((key) => (
                            <StorageRow
                                key={key}
                                label={key}
                                value={data[key]}
                                onSave={(value) => onSave(key, value)}
                                onDelete={() => onDelete(key)}
                            />
                        ))
                    )}
                </div>
            )}
        </div>
    );
};

const StorageRow: React.FC<{
    label: string;
    value: string;
    onSave: (value: string) => void | Promise<void>;
    onDelete: () => void;
}> = ({ label, value, onSave, onDelete }) => {
    const [draftValue, setDraftValue] = useState(value);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const hasChanged = draftValue !== value;

    useEffect(() => { setDraftValue(value); }, [value]);

    // 确认态会自动收回：误点一下不该让这一行永久停在"确认删除"
    useEffect(() => {
        if (!confirmDelete) return;
        const timer = window.setTimeout(() => setConfirmDelete(false), 3000);
        return () => window.clearTimeout(timer);
    }, [confirmDelete]);

    return (
        <div className="border-t border-white/6 p-2.5 first:border-t-0">
            <div className="mb-1.5 flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-bold text-slate-400" title={label}>
                    {label}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                    {hasChanged && (
                        <button
                            onClick={() => void onSave(draftValue)}
                            className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white transition hover:bg-emerald-500"
                        >
                            保存
                        </button>
                    )}
                    <button
                        onClick={() => {
                            if (confirmDelete) { setConfirmDelete(false); onDelete(); return; }
                            setConfirmDelete(true);
                        }}
                        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold transition ${confirmDelete ? 'bg-rose-600 text-white hover:bg-rose-500' : 'text-slate-600 hover:bg-rose-500/15 hover:text-rose-300'
                            }`}
                        title={confirmDelete ? '再点一次确认删除' : '删除这一项'}
                    >
                        <Trash2 className="h-3 w-3" />
                        {confirmDelete ? '确认删除' : ''}
                    </button>
                </span>
            </div>
            <textarea
                value={draftValue}
                onChange={(event) => setDraftValue(event.target.value)}
                className="custom-scrollbar h-14 w-full resize-none rounded-lg border border-white/10 bg-slate-950/70 p-2 font-mono text-[10px] leading-relaxed text-slate-300 outline-none transition focus:border-indigo-400/40"
                spellCheck={false}
            />
        </div>
    );
};

/* ========================================================================== */
/*                            Agent：JWT 页                                     */
/* ========================================================================== */

/** 存储快照解析；坏了返回空对象，不让一个坏键让整个查找失效 */
const parseSafe = (raw: string): Record<string, unknown> => {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
};

/**
 * JWT 调试页。
 *
 * 解码走 utils 里的 decodeJwt —— 与 Agent 的 tokens 工具是**同一份实现**。
 * 两边各写一份的话，面板能解的 token 模型解不开（或反之），
 * 而用户看到的只是"模型说这不是 JWT"。
 */
const JwtTab: React.FC<{ tamper: TamperState }> = ({ tamper }) => {
    const { actions } = tamper;
    const [input, setInput] = useState('');
    const [decoded, setDecoded] = useState<{ header: string; payload: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** 自动查找的结果为空时的提示（用 alert 会打断，这里就地显示） */
    const [searchHint, setSearchHint] = useState<string | null>(null);

    /**
     * 解 JWT。
     *
     * 面板与 Agent 的 tokens 工具共用 utils 里的 decodeJwt —— 它负责把
     * base64url 还原成 UTF-8 字节再解，否则中文 payload 会变成乱码
     * （实测 `{"name":"张三"}` 解成 `{"name":"å¼ ä¸"}`）。
     */
    useEffect(() => {
        if (!input) { setDecoded(null); setError(null); return; }
        try {
            const { header, payload } = decodeJwt(input);
            setDecoded({ header: JSON.stringify(header, null, 2), payload: JSON.stringify(payload, null, 2) });
            setError(null);
        } catch (e) {
            setDecoded(null);
            setError(e instanceof Error ? e.message : '解析失败');
        }
    }, [input]);

    /**
     * 从 Cookie / localStorage / sessionStorage 里找一个 JWT。
     *
     * 判据与 Agent 的 tokens find 共用 pickJwtCandidates（两段 base64url 即可，
     * 未签名的调试 token 只有两段，要求三段会把它们漏掉）。
     */
    const findJwt = useCallback(async () => {
        setSearchHint(null);
        const cookies = await actions.getCookies();
        const values: unknown[] = [
            ...cookies.map((cookie) => cookie.value),
            ...Object.values(parseSafe(await actions.getLocalStorage())),
            ...Object.values(parseSafe(await actions.getSessionStorage())),
        ];

        const [first] = pickJwtCandidates(values);
        if (first) { setInput(first); return; }
        setSearchHint('未在 Cookie 与本地存储里找到 JWT');
    }, [actions]);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Encoded Token</label>
                <button
                    onClick={() => void findJwt()}
                    className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/6 px-2 py-1 text-[10px] text-slate-400 transition hover:bg-white/12 hover:text-white"
                >
                    <Search className="h-3 w-3" />
                    自动查找
                </button>
            </div>

            <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="请粘贴 JWT，例如 eyJhbGciOi…"
                spellCheck={false}
                className="custom-scrollbar h-20 w-full resize-none rounded-xl border border-white/10 bg-slate-950/70 p-2.5 font-mono text-[10px] leading-relaxed text-slate-300 outline-none transition focus:border-rose-400/40"
            />

            {searchHint && (
                <div className="flex items-start gap-2 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2 text-[10px] text-slate-400">
                    <Search className="mt-0.5 h-3 w-3 shrink-0" />
                    {searchHint}
                </div>
            )}

            {error && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-500/8 px-3 py-2 text-[10px] text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    无法解析：{error}
                </div>
            )}

            {/* 上下叠放：侧边栏窄，Header 与 Payload 并排会把两边都挤成竖排单字 */}
            <JwtPanel title="Header" tone="text-rose-300" content={decoded?.header || '// Header info'} />
            <JwtPanel title="Payload" tone="text-violet-300" content={decoded?.payload || '// Payload data'} />

            <p className="text-[10px] leading-relaxed text-slate-600">
                只做解码。改 payload 会让签名失效（签名覆盖的正是 payload），
                这类改写请让 Agent 用 tokens 工具做 —— 它会一并告知这个后果。
            </p>
        </div>
    );
};

const JwtPanel: React.FC<{ title: string; tone: string; content: string }> = ({ title, tone, content }) => (
    <div className="flex flex-col gap-1.5">
        <label className={`text-[10px] font-bold uppercase tracking-wider ${tone}`}>{title}</label>
        <div className="custom-scrollbar max-h-56 overflow-auto rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
            <pre className={`whitespace-pre-wrap font-mono text-[10px] leading-relaxed ${tone}`}>{content}</pre>
        </div>
    </div>
);

/* ========================================================================== */
/*                            Agent：对话流                                   */
/* ========================================================================== */

/**
 * 一段推理过程。默认折叠。
 *
 * 自持开合状态（不走父级 Set）：流式气泡与历史消息共用这一个组件，
 * 若由父级管就得维护两套 key（一条消息可能在两个阶段各出现一次），
 * 而它的开合本来就只跟自己有关。组件按 message.id 做 key，
 * 列表重排不会丢状态。
 *
 * 默认折叠的理由：推理动辄几千字，展开会把正文与工具结果全顶出屏幕。
 * 但折叠不等于藏起来 —— 标题上写明字数，用户知道这里有多少东西可看。
 */
const ReasoningBlock: React.FC<{ text: string; defaultOpen?: boolean }> = ({ text, defaultOpen = false }) => {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div className="rounded-xl border border-white/8 bg-black/25 px-2.5 py-1.5">
            <button
                onClick={() => setOpen((prev) => !prev)}
                className="flex w-full items-center gap-1.5 text-left text-[10px] font-bold uppercase tracking-wider text-slate-600 transition hover:text-slate-300"
            >
                <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                推理过程
                <span className="font-normal normal-case tracking-normal text-slate-700">{text.length} 字</span>
            </button>
            {open && (
                <pre className="custom-scrollbar mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap font-sans text-[10px] italic leading-relaxed text-slate-500">
                    {text}
                </pre>
            )}
        </div>
    );
};

/**
 * 正在流式输出的这一轮。
 *
 * 正文与推理分开渲染：推理是模型的草稿，用暗色斜体并默认折叠；
 * 正文才是要看的，正常样式实时增长。
 * 流式在这里买到的是"它在干活"的可见性，不是更快的响应 ——
 * Agent 每一步都要等完整 JSON 才能解析，所以流式只影响观感，不影响速度。
 */
const StreamBubble: React.FC<{ content: string; reasoning: string }> = ({ content, reasoning }) => (
    <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500">
            <Bot className="h-3.5 w-3.5 text-white" />
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
            {/* 流式期间默认展开：此刻"它在想什么"正是用户要看的，
                而这一步定稿后同一个组件会以折叠态出现在历史里 */}
            {reasoning && <ReasoningBlock text={reasoning} defaultOpen />}

            <div className="whitespace-pre-wrap break-words rounded-xl rounded-tl-sm bg-white/6 px-2.5 py-2 text-[11px] leading-relaxed text-slate-200">
                {content || <span className="text-slate-600">…</span>}
                <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse rounded-sm bg-indigo-400 align-text-bottom" />
            </div>
        </div>
    </div>
);

const EmptyHint: React.FC = () => (
    <div className="rounded-xl border border-dashed border-white/8 bg-white/[0.02] px-4 py-5 text-center">
        <Bot className="mx-auto mb-2 h-5 w-5 text-slate-600" />
        <p className="text-[11px] font-bold text-slate-400">Agent 在已登录的页面里干活</p>
        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
            它既能写 JavaScript（点击、翻页、调页面自身的函数），
            也能直接改拦截规则、请求头、存储与 JWT —— 上面那几个标签页做的事，它都能做。
        </p>
    </div>
);

/**
 * 一条消息右上角的行内操作（回退 / 删除）。
 *
 * 平时 opacity-0，悬停或键盘聚焦时才显形：对话流里每条都挂两个按钮会把
 * 正文淹掉，而这些操作本身是低频的。
 *
 * `focus-within` 与 `focus-visible` 都写上，是因为两者管的不是一回事：
 * 前者让**容器**在子按钮获得焦点时显形（Tab 进来时按钮才可见，否则焦点
 * 落在一个看不见的按钮上），后者管按钮自己的焦点环。
 */
const MessageActions: React.FC<{
    disabled: boolean;
    onRewind: () => void;
    onRemove: () => void;
}> = ({ disabled, onRewind, onRemove }) => (
    <span className={`flex shrink-0 items-center gap-0.5 transition-opacity ${disabled ? 'opacity-0' : 'opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100'}`}>
        <button
            onClick={onRewind}
            disabled={disabled}
            className="flex h-5 w-5 items-center justify-center rounded text-slate-500 transition hover:bg-indigo-500/15 hover:text-indigo-300 disabled:cursor-not-allowed"
            title="回到这里：这一轮及其之后的对话都会被移除，提问会填回输入框"
        >
            <Undo2 className="h-3 w-3" />
        </button>
        <button
            onClick={onRemove}
            disabled={disabled}
            className="flex h-5 w-5 items-center justify-center rounded text-slate-500 transition hover:bg-rose-500/15 hover:text-rose-300 disabled:cursor-not-allowed"
            title="删除这一条"
        >
            <Trash2 className="h-3 w-3" />
        </button>
    </span>
);

const MessageRow: React.FC<{
    message: AgentMessage;
    expanded: boolean;
    onToggle: () => void;
    canEdit: boolean;
    onRewind: () => void;
    onRemove: () => void;
}> = ({ message, expanded, onToggle, canEdit, onRewind, onRemove }) => {
    const row = 'group/msg';

    if (message.role === 'user') {
        return (
            <div className={`${row} flex items-start justify-end gap-2`}>
                <MessageActions disabled={!canEdit} onRewind={onRewind} onRemove={onRemove} />
                <div className="max-w-[85%] rounded-xl rounded-tr-sm bg-indigo-500/15 px-2.5 py-2 text-[11px] leading-relaxed text-indigo-100">
                    {message.content}
                </div>
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-white/8">
                    <User className="h-3.5 w-3.5 text-slate-400" />
                </div>
            </div>
        );
    }

    if (message.role === 'assistant') {
        return (
            <div className={`${row} flex items-start gap-2`}>
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500">
                    <Bot className="h-3.5 w-3.5 text-white" />
                </div>
                <div className="min-w-0 max-w-[85%] flex-1 space-y-1.5">
                    {message.reasoning && <ReasoningBlock text={message.reasoning} />}
                    <div className="whitespace-pre-wrap rounded-xl rounded-tl-sm bg-white/6 px-2.5 py-2 text-[11px] leading-relaxed text-slate-200">
                        {message.content}
                    </div>
                </div>
                <MessageActions disabled={!canEdit} onRewind={onRewind} onRemove={onRemove} />
            </div>
        );
    }

    // 工具调用
    return (
        <div className={`${row} flex items-start gap-2`}>
            <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${message.ok ? 'bg-emerald-500/15' : 'bg-rose-500/15'}`}>
                {message.ok ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <AlertCircle className="h-3.5 w-3.5 text-rose-400" />}
            </div>

            <div className="min-w-0 flex-1 rounded-xl border border-white/8 bg-black/20 px-2.5 py-1.5">
                <button onClick={onToggle} className="flex w-full items-center gap-1.5 text-left">
                    <Terminal className="h-3 w-3 shrink-0 text-slate-500" />
                    <span className="min-w-0 flex-1 truncate text-[10px] font-bold text-slate-300">{message.content}</span>
                    <span className="shrink-0 rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-slate-400">{message.tool}</span>
                    <ChevronRight className={`h-3 w-3 shrink-0 text-slate-600 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                </button>

                {expanded && (
                    <div className="mt-2 space-y-2">
                        {/* 这一步的思考。放在展开区而不是卡片外：工具调用动辄几十条，
                            每条都挂一段推理会把日志淹掉；而它恰恰解释了"为什么改这个字段" */}
                        {message.reasoning && <ReasoningBlock text={message.reasoning} />}
                        {message.script && (
                            <div>
                                <div className="mb-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-slate-600">
                                    <Code className="h-2.5 w-2.5" />
                                    脚本
                                </div>
                                <pre className="custom-scrollbar max-h-40 overflow-auto rounded-lg border border-white/8 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-cyan-200">
                                    {message.script}
                                </pre>
                            </div>
                        )}
                        <div>
                            <div className="mb-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-slate-600">
                                <Braces className="h-2.5 w-2.5" />
                                返回值
                            </div>
                            <pre className="custom-scrollbar max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-white/8 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-400">
                                {message.result || '(空)'}
                            </pre>
                        </div>
                    </div>
                )}
            </div>

            <MessageActions disabled={!canEdit} onRewind={onRewind} onRemove={onRemove} />
        </div>
    );
};

const ScriptList: React.FC<{
    scripts: AgentScript[];
    onRemove: (id: string) => void;
    onToggle: (id: string) => void;
}> = ({ scripts, onRemove, onToggle }) => {
    if (scripts.length === 0) {
        return (
            <div className="rounded-xl border border-dashed border-white/8 bg-white/[0.02] px-4 py-6 text-center">
                <Play className="mx-auto mb-2 h-4 w-4 text-slate-600" />
                <p className="text-[11px] font-bold text-slate-400">还没有保存的脚本</p>
                <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
                    在对话里让模型保存，它就会出现在这里。
                    <br />
                    填了 URL 匹配的脚本会在打开对应页面时自动执行。
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-2">
            {scripts.map((script) => (
                <div key={script.id} className="rounded-xl border border-white/10 bg-white/[0.04] p-2.5">
                    <div className="flex items-center gap-2">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 select-none">
                            <input
                                type="checkbox"
                                checked={script.enabled}
                                onChange={() => onToggle(script.id)}
                                className="h-3 w-3 shrink-0 accent-indigo-400"
                            />
                            <span className={`truncate text-[11px] font-bold ${script.enabled ? 'text-slate-200' : 'text-slate-600'}`}>
                                {script.name}
                            </span>
                        </label>
                        <button
                            onClick={() => onRemove(script.id)}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-600 transition hover:bg-rose-500/15 hover:text-rose-300"
                            title="删除脚本"
                        >
                            <Trash2 className="h-3 w-3" />
                        </button>
                    </div>

                    {script.description && (
                        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">{script.description}</p>
                    )}

                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[9px]">
                        <span className={`rounded px-1.5 py-0.5 font-mono ${script.urlPattern ? 'bg-emerald-500/12 text-emerald-300' : 'bg-white/6 text-slate-500'}`}>
                            {script.urlPattern ? `自动 · ${script.urlPattern}` : '仅手动'}
                        </span>
                        {script.lastRunAt && (
                            <span className="text-slate-600">最近执行 {new Date(script.lastRunAt).toLocaleTimeString()}</span>
                        )}
                    </div>

                    {script.lastResult && (
                        <pre className="custom-scrollbar mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded-lg border border-white/8 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-500">
                            {script.lastResult}
                        </pre>
                    )}
                </div>
            ))}
        </div>
    );
};

/**
 * 知识库面板。
 *
 * 这是给**人**看的浏览入口 —— Agent 走的是 kb 工具，不经过这里。
 * 存在的理由是排查："模型说查不到"到底是没有这篇文章、还是路径配错了、
 * 还是检索词没命中。这三件事在这一个页面上就能分辨。
 *
 * 状态与取数全在主进程（kbService），这里只展示 + 提交路径。
 */
const KbTab: React.FC = () => {
    const [status, setStatus] = useState<KbStatus | null>(null);
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState<KbSearchHit[] | null>(null);
    const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
    const [draftRoot, setDraftRoot] = useState('');
    const [saveMsg, setSaveMsg] = useState('');
    const [busy, setBusy] = useState(false);

    // 索引缓存与 Agent 那份相互独立：面板按需重建，不跟 Agent 的缓存共享，
    // 否则"面板改了路径"与"Agent 还在用旧索引"会打架
    const indexRef = useRef<KbEntry[] | null>(null);

    const refresh = useCallback(async () => {
        const api = getAppWindow().electronAPI?.kb;
        if (!api) return;
        const next = await api.status();
        setStatus(next);
        setDraftRoot(next.root || '');
        // 路径变了就必须丢掉索引：否则搜索还在用旧库
        indexRef.current = null;
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    const ensureIndex = useCallback(async (): Promise<KbEntry[]> => {
        if (indexRef.current) return indexRef.current;
        const api = getAppWindow().electronAPI?.kb;
        if (!api) return [];
        const payload = await api.load();
        const built = buildKbIndex(payload?.files || [], payload?.boardIndexes || {});
        indexRef.current = built;
        return built;
    }, []);

    const runSearch = useCallback(async () => {
        if (!query.trim()) return;
        setBusy(true);
        try {
            const entries = await ensureIndex();
            setHits(searchKb(entries, query, 20));
            setPreview(null);
        } finally {
            setBusy(false);
        }
    }, [query, ensureIndex]);

    const openArticle = useCallback(async (path: string) => {
        const api = getAppWindow().electronAPI?.kb;
        if (!api) return;
        const payload = await api.read(path);
        setPreview({ path, text: payload?.content || payload?.error || '(空)' });
    }, []);

    const applyRoot = useCallback(async () => {
        const api = getAppWindow().electronAPI?.kb;
        if (!api) return;
        const res = await api.setRoot(draftRoot);
        setSaveMsg(res.message || '');
        setStatus(res.status);
        indexRef.current = null;
        setHits(null);
        setPreview(null);
    }, [draftRoot]);

    return (
        <div className="space-y-2.5">
            {/* 状态条：篇数与根目录。未就绪时明说原因，不显示"0 篇" —— 那会被读成库是空的 */}
            <div className={`rounded-xl border px-2.5 py-2 ${status?.ready ? 'border-emerald-500/25 bg-emerald-950/25' : 'border-amber-500/25 bg-amber-950/25'}`}>
                <div className="flex items-center gap-1.5">
                    <BookOpen className={`h-3 w-3 shrink-0 ${status?.ready ? 'text-emerald-400' : 'text-amber-400'}`} />
                    <span className={`text-[11px] font-bold ${status?.ready ? 'text-emerald-200' : 'text-amber-200'}`}>
                        {status?.ready ? `已接入 · ${status.articles} 篇` : '未接入'}
                    </span>
                </div>
                {status?.ready ? (
                    <p className="mt-1 break-all font-mono text-[9px] leading-relaxed text-slate-500">{status.root}</p>
                ) : (
                    <p className="mt-1 text-[10px] leading-relaxed text-amber-200/80">
                        {status?.error || '正在检查…'}
                    </p>
                )}
            </div>

            {/* 检索 */}
            <div className="flex items-center gap-1.5">
                <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }}
                    placeholder="例如：付费墙 内容提取 / jwt 签名"
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1.5 text-[11px] text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-indigo-400/40"
                />
                <button
                    onClick={() => void runSearch()}
                    disabled={busy || !query.trim()}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/10 text-slate-300 transition hover:bg-white/15 disabled:opacity-40"
                    title="检索"
                >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                </button>
            </div>

            {/* 结果 */}
            {hits && (
                hits.length === 0 ? (
                    <p className="px-1 text-[10px] leading-relaxed text-slate-500">
                        没有匹配。换个更完整的说法试试 —— 单个字符查不出东西。
                    </p>
                ) : (
                    <div className="space-y-1.5">
                        {hits.map((hit) => (
                            <button
                                key={hit.path}
                                onClick={() => void openArticle(hit.path)}
                                className={`w-full rounded-lg border px-2 py-1.5 text-left transition ${preview?.path === hit.path
                                    ? 'border-indigo-400/40 bg-indigo-500/10'
                                    : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.06]'
                                    }`}
                            >
                                <div className="flex items-start gap-1.5">
                                    <span className="mt-0.5 shrink-0 rounded bg-white/8 px-1 font-mono text-[9px] text-slate-400">{hit.score}</span>
                                    <span className="min-w-0 flex-1 text-[11px] font-bold leading-snug text-slate-200">{hit.title}</span>
                                </div>
                                <p className="mt-0.5 break-all font-mono text-[9px] text-slate-600">{hit.path}</p>
                                {hit.summary && (
                                    <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-slate-500">{hit.summary}</p>
                                )}
                            </button>
                        ))}
                    </div>
                )
            )}

            {/* 预览 */}
            {preview && (
                <div className="rounded-lg border border-white/10 bg-slate-950">
                    <div className="flex items-center gap-1.5 border-b border-white/8 px-2 py-1.5">
                        <span className="min-w-0 flex-1 break-all font-mono text-[9px] text-slate-500">{preview.path}</span>
                        <button
                            onClick={() => setPreview(null)}
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-600 transition hover:text-slate-300"
                            title="关闭"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    </div>
                    <pre className="custom-scrollbar max-h-64 overflow-auto whitespace-pre-wrap p-2 font-mono text-[10px] leading-relaxed text-slate-400">
                        {preview.text}
                    </pre>
                </div>
            )}

            {/* 路径配置 */}
            <div className="rounded-xl border border-white/8 bg-white/[0.02] p-2.5">
                <p className="text-[10px] font-bold text-slate-400">知识库路径</p>
                <p className="mt-1 text-[9px] leading-relaxed text-slate-600">
                    留空则自动查找项目下以 open-reverselab 开头的目录。打包版需要手填绝对路径。
                </p>
                <input
                    value={draftRoot}
                    onChange={(event) => setDraftRoot(event.target.value)}
                    placeholder="D:\\path\\to\\open-reverselab\\kb"
                    className="mt-1.5 w-full rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1.5 font-mono text-[10px] text-slate-300 outline-none transition placeholder:text-slate-700 focus:border-indigo-400/40"
                />
                <div className="mt-1.5 flex items-center gap-1.5">
                    <button
                        onClick={() => void applyRoot()}
                        className="rounded-lg bg-white/10 px-2.5 py-1 text-[10px] font-bold text-slate-200 transition hover:bg-white/15"
                    >
                        保存并重新检查
                    </button>
                    {saveMsg && <span className="min-w-0 flex-1 break-all text-[9px] text-slate-500">{saveMsg}</span>}
                </div>
            </div>
        </div>
    );
};

/* ========================================================================== */
/*                            Agent：侧边栏外壳                                 */
/* ========================================================================== */
type AgentTab = 'chat' | 'rules' | 'headers' | 'storage' | 'jwt' | 'scripts' | 'kb';

const AGENT_TABS: { id: AgentTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'chat', label: '对话', icon: Bot },
    { id: 'rules', label: '规则', icon: Database },
    { id: 'headers', label: '请求头', icon: ArrowRightLeft },
    { id: 'storage', label: '存储', icon: Globe },
    { id: 'jwt', label: 'JWT', icon: KeyRound },
    { id: 'scripts', label: '脚本', icon: Code },
    { id: 'kb', label: '知识库', icon: BookOpen },
];

const SIDEBAR_MIN = 320;
const SIDEBAR_MAX = 720;
const SIDEBAR_DEFAULT = 400;
const SIDEBAR_RAIL = 48;
const SIDEBAR_STORE_KEY = 'theplay.browse.agent';

interface SidebarPrefs { open: boolean; width: number; fullscreen: boolean }

/**
 * Agent 工作区：浏览器面板右侧的**常驻边栏**。
 *
 * 为什么不挂在悬浮球里：Agent 的每一步都要落到 webview 上（执行脚本、读页面
 * URL、注入规则）。悬浮球是全局浮层，切到播放器/音频工坊时它还在，但那时
 * webview 已经不可见、甚至没有活动页面 —— 用户会看到一个能打字、却什么也做不了的
 * 对话框。钉在浏览器面板里，"Agent 只能在有页面的地方用"这件事就由布局本身说明。
 *
 * 收起时留一条 48px 竖轨而不是彻底消失：竖轨上带着状态点与脚本数，
 * 是"它还在、现在什么状态"的唯一入口。
 *
 * **内容始终挂载**（收起只是 display:none）：对话记录、输入框草稿、滚动位置、
 * 当前标签页全都不能因为收起而清零。这与悬浮球"关球不卸载"是同一个理由。
 */
const AgentSidebar: React.FC<{
    agent: AgentState;
    tamper: TamperState;
    currentUrl: string;
    /**
     * 待填入输入框的文本（右键「让 Agent 分析这个元素」产生）。
     *
     * 带 seq 是因为同一个元素可能被连点两次右键：纯文本的第二次 setState
     * 值相同，React 会跳过更新，effect 不跑 —— 用户已经删掉的输入框内容
     * 不会被重新填上，看起来像"右键没反应"。
     */
    prefill?: { seq: number; text: string } | null;
}> = ({ agent, tamper, currentUrl, prefill }) => {
    const { messages, scripts, status, error, streaming, actions, canEdit } = agent;

    const [prefs, setPrefs] = useState<SidebarPrefs>(() => {
        const saved = loadJSON<Partial<SidebarPrefs> | null>(SIDEBAR_STORE_KEY, null, '');
        const width = Number(saved?.width);
        return {
            open: saved?.open !== false,
            // 越界值夹回范围：上次在超宽屏拖到 720 之后换到小窗口，边栏不该吃掉整个视口
            width: Number.isFinite(width) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)) : SIDEBAR_DEFAULT,
            fullscreen: saved?.fullscreen === true,
        };
    });

    const [activeTab, setActiveTab] = useState<AgentTab>('chat');
    const [input, setInput] = useState('');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
    const [resizing, setResizing] = useState(false);

    const draft = useTamperDraft(tamper);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const asideRef = useRef<HTMLElement | null>(null);
    const resizeCleanupRef = useRef<(() => void) | null>(null);
    const busy = status !== 'idle';

    const persist = useCallback((next: SidebarPrefs) => {
        setPrefs(next);
        saveJSON(SIDEBAR_STORE_KEY, next, '');
    }, []);

    /**
     * 右键「让 Agent 分析这个元素」填进输入框。
     *
     * 只在输入框空着时才覆盖 —— 与回退（handleRewind）同一判据：
     * 用户可能已经写好半句话，右键只是想再补一个元素的信息，
     * 直接覆盖等于替他扔掉正在写的内容。
     *
     * 顺带把标签切到对话页并展开边栏：填进一个用户看不见的输入框
     * 等于什么都没做。
     */
    useEffect(() => {
        if (!prefill || !prefill.text) return;
        setInput((prev) => (prev.trim() ? prev : prefill.text));
        setActiveTab('chat');
        setPrefs((prev) => {
            if (prev.open) return prev;
            const next = { ...prev, open: true };
            saveJSON(SIDEBAR_STORE_KEY, next, '');
            return next;
        });
    }, [prefill]);

    /**
     * Esc 退出全屏。
     *
     * 只在全屏时挂监听，且不 preventDefault / stopPropagation —— 面板里别处
     * （如地址栏的 Esc 失焦）仍要用这个键。全屏下用户按 Esc 的意图是明确的：
     * 先把全屏收掉，这是最常见的"我按 Esc 想退出当前模式"预期。
     */
    useEffect(() => {
        if (!prefs.fullscreen || !prefs.open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setPrefs((prev) => { const next = { ...prev, fullscreen: false }; saveJSON(SIDEBAR_STORE_KEY, next, ''); return next; });
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [prefs.fullscreen, prefs.open]);

    // 新消息进来滚到底：对话流不自动跟随的话，模型跑到第十步用户还在看第一步
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages.length, status, streaming?.content, streaming?.reasoning, activeTab]);

    // 成功提示是"一次性确认"，2 秒后收回；
    // **失败提示不能自动消失** —— 它的后果是持久的（规则没写进本地存储，
    // 重启就全丢），2 秒后收回等于用户再也没机会看到。由用户手动关闭，
    // 或下次保存成功时自动清掉。
    useEffect(() => {
        if (saveStatus !== 'saved') return;
        const timer = window.setTimeout(() => setSaveStatus('idle'), 2000);
        return () => window.clearTimeout(timer);
    }, [saveStatus]);

    /**
     * 拖拽调宽。
     *
     * 从右边缘往左拖 = 变宽，所以算的是 `容器右边 − clientX`。
     * 松手时才落盘：拖动过程中每帧写一次 localStorage 是没必要的同步 I/O。
     * 卸载时必须回收挂在 window 上的监听器，否则它持有过期闭包，
     * 之后每次移动鼠标都在改一个不存在的宽度。
     *
     * **拖动期间必须给 webview 盖一层透明遮罩**（见下面的 resizeShield）。
     * 实测事故：鼠标从手柄往左偏一点点就压到 <webview> 上，拖动当场失效；
     * 挪回来又能接着拖，表现为"幅度稍大就失焦"。原因是 <webview> 是
     * Chromium 的跨进程 OOPIF，指针进入它之后 mousemove 不再冒泡到宿主页面的
     * window —— 监听器本身没坏，是事件根本送不到。遮罩盖住它，
     * 指针就始终落在宿主页面里，拖动全程连续。
     */
    const endResize = useCallback(() => {
        resizeCleanupRef.current?.();
        resizeCleanupRef.current = null;
        setResizing(false);
        document.body.classList.remove('tp-resizing');
    }, []);

    useEffect(() => () => endResize(), [endResize]);

    const startResize = useCallback((event: React.MouseEvent) => {
        if (!prefs.open) return;
        event.preventDefault();
        endResize();
        setResizing(true);
        document.body.classList.add('tp-resizing');

        // 右边缘在拖动过程中是固定的（贴着窗口右侧），左边缘才随宽度移动，
        // 所以这里取一次即可 —— 每帧重取反而会因为宽度已变而算出自激的偏移
        const right = asideRef.current?.getBoundingClientRect().right ?? window.innerWidth;
        const apply = (clientX: number) => {
            const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, right - clientX));
            setPrefs((prev) => (prev.width === next ? prev : { ...prev, width: next }));
        };

        const onMove = (ev: MouseEvent) => apply(ev.clientX);
        const onUp = () => {
            endResize();
            setPrefs((prev) => { saveJSON(SIDEBAR_STORE_KEY, prev, ''); return prev; });
        };

        // 指针移出窗口（拖到屏幕外）也要收尾，否则 resizing 会一直挂着、
        // 遮罩不撤，整个页面再也点不动
        const onCancel = () => onUp();

        resizeCleanupRef.current = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('blur', onCancel);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('blur', onCancel);
    }, [endResize, prefs.open]);

    const submit = useCallback(() => {
        const text = input.trim();
        if (!text || busy) return;
        setInput('');
        void actions.send(text);
    }, [actions, busy, input]);

    const toggleExpand = useCallback((id: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const hostName = useMemo(() => {
        try { return new URL(currentUrl).hostname; } catch { return ''; }
    }, [currentUrl]);

    const isRuleTab = activeTab === 'rules' || activeTab === 'headers';

    /**
     * 回退到某条消息之前。
     *
     * 提问原文填回输入框 —— 回退的主要用途就是"改一改重发"，
     * 让用户重新手打一遍自己刚写的话是没道理的。
     *
     * 只在输入框空着时才填：用户可能已经写好了下一句，回退只是想把历史清干净。
     * 直接覆盖等于替他扔掉正在写的内容。
     */
    const handleRewind = useCallback((id: string) => {
        const prompt = actions.rewindTo(id);
        if (prompt) setInput((prev) => (prev.trim() ? prev : prompt));
    }, [actions]);

    const applyChanges = useCallback(() => {
        // draft.save() 返回的是**持久化**结果。配额爆了规则仍对当前页面生效，
        // 但重启就没了 —— 这两种结果必须分开告诉用户，否则他以为存住了。
        setSaveStatus(draft.save() ? 'saved' : 'failed');
    }, [draft]);

    /**
     * 「已应用」只在**没有新改动**时才成立（判据是 showsAsSaved，可单测）。
     *
     * 保存成功后 saveStatus 会保持 'saved' 两秒再收回。这两秒里用户若又改了规则，
     * dirty 已经变 true，但按钮还挂着绿勾「已应用」、横幅也不显示 ——
     * 用户此刻切走再回来，看到的就是"改动已保存"。
     */
    const showSaved = showsAsSaved(saveStatus, draft.dirty);

    const statusTone = busy ? 'bg-amber-400' : error ? 'bg-rose-400' : 'bg-emerald-400';
    const statusText = status === 'thinking' ? '思考中' : status === 'acting' ? '执行中' : '就绪';

    /** 这几条提示只在规则页出现，且互斥关系由各自条件决定（见下方注释） */
    const banners = isRuleTab
        ? {
            incomplete: draft.incompleteCount > 0,
            overridden: draft.overridden,
            dirty: draft.dirty && !draft.overridden && !showSaved && saveStatus !== 'failed',
            failed: saveStatus === 'failed',
        }
        : { incomplete: false, overridden: false, dirty: false, failed: false };
    const hasBanner = banners.incomplete || banners.overridden || banners.dirty || banners.failed;

    /* ------------------------------ 收起：竖轨 ------------------------------ */

    const rail = (
        // flex-1：竖轨要撑满高度，底部的 AGENT 字样才能被 mt-auto 推到最下
        <div className="flex w-full flex-1 flex-col items-center gap-2 py-3">
            <button
                onClick={() => persist({ ...prefs, open: true })}
                className="group relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-[0_6px_18px_rgba(79,70,229,0.35)] transition hover:scale-105 active:scale-95"
                title="展开 Agent 工作区"
            >
                <Bot className="h-4 w-4" />
                <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-950 ${statusTone} ${busy ? 'animate-pulse' : ''}`} />
            </button>

            {scripts.length > 0 && (
                <span
                    className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-white/8 px-1 font-mono text-[9px] font-bold text-slate-400"
                    title={`${scripts.length} 个已保存脚本`}
                >
                    {scripts.length}
                </span>
            )}

            <span className="mt-auto select-none font-mono text-[9px] tracking-widest text-slate-700 [writing-mode:vertical-rl]">
                AGENT
            </span>
        </div>
    );

    /* ------------------------------ 展开：边栏 ------------------------------ */

    /**
     * 全屏时的版面。
     *
     * 半透明而不是实心：全屏是为了"看大图、读长文"，用户仍需要看到底下的页面
     * 来判断 Agent 改的东西对不对。实心背景会把 Agent 变成一个隔绝的黑箱，
     * 那正是把它从悬浮球搬进浏览器面板时要避免的。
     *
     * 定位用 fixed 而不是撑满父容器：父容器只有浏览器面板那一条（右侧还有标签栏
     * 与地址栏的高度），fixed 才能盖住整个视口 —— 那才是"全屏"。
     * z-40 在悬浮球（z-[70]）之下：悬浮球是全局最高层，不该被 Agent 盖住。
     */
    const isFullscreen = prefs.open && prefs.fullscreen;

    return (
        <>
            {/* 拖动遮罩。必须在 <webview> 之上、且覆盖整个视口：
          指针一旦落进 webview，mousemove 就不再冒泡到宿主页面，
          拖动会当场断掉（见 startResize 的注释）。
          只在拖动期间存在，平时不挡任何点击。 */}
            {resizing && <div className="fixed inset-0 z-[60] cursor-col-resize" />}

            <aside
                ref={asideRef}
                style={{ width: prefs.open ? (isFullscreen ? undefined : prefs.width) : SIDEBAR_RAIL }}
                className={
                    isFullscreen
                        ? 'bp-agent-aside fixed inset-0 z-40 flex flex-col border-l border-white/12 bg-slate-950/78 backdrop-blur-2xl'
                        : `bp-agent-aside relative flex shrink-0 flex-col border-l border-white/8 bg-white/[0.02] ${prefs.open ? '' : 'items-center'}`
                }
            >
                {/* 收起态：只画竖轨，但**下面那整块内容不卸载**，只 hidden。
          卸载会丢掉对话滚动位置与所有未提交的输入；而收起边栏是个高频动作
          （腾地方看页面），每次都要重新滚到最新一条是不能接受的。 */}
                {!prefs.open && rail}

                <div className={prefs.open ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
                    {/* 拖拽手柄：视觉上 1px，命中区左右各外扩，避免要精确到像素才能拖到。
            全屏时宽度由视口决定，拖它没有意义，直接不给手柄。 */}
                    {!isFullscreen && (
                        <div
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="拖拽调整 Agent 边栏宽度（双击复位）"
                            onMouseDown={startResize}
                            onDoubleClick={() => persist({ ...prefs, width: SIDEBAR_DEFAULT })}
                            title="拖拽调整宽度 · 双击复位"
                            className="group/resize absolute top-0 -left-1 bottom-0 z-40 flex w-2 cursor-col-resize justify-center"
                        >
                            <span className={`h-full w-px transition-all group-hover/resize:w-0.5 group-hover/resize:bg-indigo-400/60 ${resizing ? 'w-0.5 bg-indigo-400/60' : 'bg-white/8'}`} />
                        </div>
                    )}

                    {/* 头部 */}
                    <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-3 py-2.5">
                        <div className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-white">
                            <Bot className="h-3.5 w-3.5" />
                            <span className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-slate-950 ${statusTone} ${busy ? 'animate-pulse' : ''}`} />
                        </div>

                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                                <span className="text-xs font-bold text-white">Agent</span>
                                <span className="text-[10px] text-slate-500">{statusText}</span>
                            </div>
                            <div className="truncate font-mono text-[9px] text-slate-600" title={currentUrl || undefined}>
                                {hostName || '没有打开的页面'}
                            </div>
                        </div>

                        <button
                            onClick={() => persist({ ...prefs, fullscreen: !prefs.fullscreen })}
                            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition ${isFullscreen ? 'bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30' : 'text-slate-500 hover:bg-white/8 hover:text-white'
                                }`}
                            title={isFullscreen ? '退出全屏（Esc）' : '全屏显示 Agent'}
                        >
                            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                        </button>

                        <button
                            // 收起时一并退出全屏：收起是比退出全屏更强的动作，
                            // 留着 fullscreen 标记的话，下次展开会突然铺满整屏 —— 那不是用户要的
                            onClick={() => persist({ ...prefs, open: false, fullscreen: false })}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white/8 hover:text-white"
                            title="收起 Agent 工作区"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>

                    {/* 标签：图标 + 文字两行。侧边栏最窄 320px，七个标签横排仍放得下 */}
                    <div className="flex shrink-0 gap-0.5 border-b border-white/8 px-1.5 py-1.5">
                        {AGENT_TABS.map((tab) => {
                            const Icon = tab.icon;
                            const isActive = activeTab === tab.id;
                            const count = tab.id === 'scripts' ? scripts.length : 0;
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={`relative flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 transition-all ${isActive ? 'bg-white/10 text-white' : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
                                        }`}
                                    title={tab.label}
                                >
                                    <Icon className="h-3.5 w-3.5" />
                                    <span className="text-[9px] font-semibold leading-none">{tab.label}</span>
                                    {count > 0 && (
                                        <span className="absolute right-1 top-0.5 flex h-3 min-w-[12px] items-center justify-center rounded-full bg-indigo-500 px-0.5 text-[8px] font-bold text-white">
                                            {count}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    {/* 规则页的上下文操作条：应用 / 清空对话 */}
                    {(isRuleTab || (activeTab === 'chat' && messages.length > 0)) && (
                        <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-3 py-2">
                            {isRuleTab ? (
                                <>
                                    <button
                                        onClick={applyChanges}
                                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold transition-all ${showSaved
                                            ? 'bg-emerald-600 text-white shadow-[0_0_15px_rgba(22,163,74,0.35)]'
                                            : saveStatus === 'failed'
                                                ? 'bg-rose-600 text-white shadow-[0_0_15px_rgba(225,29,72,0.35)]'
                                                : 'bg-white text-slate-900 hover:bg-slate-100'
                                            }`}
                                    >
                                        {showSaved ? <Check className="h-3 w-3" /> : saveStatus === 'failed' ? <AlertTriangle className="h-3 w-3" /> : <Save className="h-3 w-3" />}
                                        {showSaved ? '已应用' : saveStatus === 'failed' ? '未持久化' : '应用更改'}
                                    </button>
                                    <span className="shrink-0 text-[10px] text-slate-600">
                                        改完不点这里，只对当前页面生效
                                    </span>
                                </>
                            ) : (
                                <>
                                    <span className="flex-1 text-[10px] text-slate-600">
                                        {messages.length} 条记录
                                        {!canEdit && ' · 运行中不可编辑'}
                                    </span>
                                    <button
                                        onClick={actions.clear}
                                        disabled={!canEdit}
                                        className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-slate-400 transition hover:bg-rose-500/12 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/5 disabled:hover:text-slate-400"
                                        title={canEdit ? '清空对话记录' : '运行中不能清空，先停止'}
                                    >
                                        <Trash2 className="h-3 w-3" />
                                        清空对话
                                    </button>
                                </>
                            )}
                        </div>
                    )}

                    {/* 提示横幅。半空规则会被引擎跳过，但面板上显示「启用中」——
            不点出来用户会以为规则生效了 */}
                    <div className={`flex shrink-0 flex-col gap-1.5 px-3 ${hasBanner ? 'pt-2.5' : ''}`}>
                        {banners.incomplete && (
                            <div className="flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-500/8 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-200">
                                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                有 {draft.incompleteCount} 条启用中的规则没填「目标键 / Header 名」，引擎会跳过它们。
                            </div>
                        )}

                        {/* 模型改了规则，而用户手里有没应用的编辑。草稿没被覆盖，
              但底下那份已经变了 —— 不说清楚的话，用户点「应用更改」会用旧草稿把模型的改动顶掉。 */}
                        {banners.overridden && (
                            <div className="flex items-start justify-between gap-2 rounded-lg border border-indigo-400/20 bg-indigo-500/8 px-2.5 py-1.5 text-[10px] leading-relaxed text-indigo-200">
                                <span className="flex items-start gap-2">
                                    <Bot className="mt-0.5 h-3 w-3 shrink-0" />
                                    Agent 在对话里改过规则，你手上有未应用的编辑，所以这里仍显示你的草稿。
                                    点「应用更改」会用你的版本覆盖 Agent 的改动。
                                </span>
                                <button onClick={draft.reset} className="shrink-0 text-indigo-300/70 transition hover:text-indigo-100">
                                    改用 Agent 的
                                </button>
                            </div>
                        )}

                        {/* overridden 时不再重复显示「未应用」：那时 dirty 必然为真，
              两条一起挂等于同一件事说两遍，反而盖住更具体的那条。
              条件用 !showSaved 而不是 saveStatus==='idle'：后者要等两秒才成立，
              而这两秒里用户已经改了规则（dirty=true），界面却还宣称"已应用"。 */}
                        {banners.dirty && (
                            <div className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] leading-relaxed text-slate-400">
                                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                规则已改但<strong className="text-slate-300">未应用</strong> —— 点上方「应用更改」才会生效并写入本地存储。
                            </div>
                        )}

                        {banners.failed && (
                            <div className="flex items-start justify-between gap-2 rounded-lg border border-amber-400/20 bg-amber-500/8 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-200">
                                <span className="flex items-start gap-2">
                                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                    规则已注入当前页面，但未能写入本地存储 —— 重启后会丢失。请腾出空间后重新点「应用更改」。
                                </span>
                                <button onClick={() => setSaveStatus('idle')} className="shrink-0 text-amber-300/70 transition hover:text-amber-100">
                                    知道了
                                </button>
                            </div>
                        )}
                    </div>

                    {/* 内容区 */}
                    {activeTab === 'chat' ? (
                        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
                            <div ref={scrollRef} className="custom-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto py-2.5 pr-1">
                                {messages.length === 0 ? (
                                    <EmptyHint />
                                ) : (
                                    messages.map((message) => (
                                        <MessageRow
                                            key={message.id}
                                            message={message}
                                            expanded={expanded.has(message.id)}
                                            onToggle={() => toggleExpand(message.id)}
                                            canEdit={canEdit}
                                            onRewind={() => handleRewind(message.id)}
                                            onRemove={() => actions.removeMessage(message.id)}
                                        />
                                    ))
                                )}

                                {busy && (
                                    <div className="flex items-center gap-2 px-1 text-[10px] text-slate-500">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        {status === 'thinking' ? '模型思考中…' : '正在页面里执行…'}
                                    </div>
                                )}
                            </div>

                            {/* 流式气泡：正在写但还没定稿的这一轮。
                它不进 messages，定稿时（或中断时）才转成正式消息，避免列表里出现两份 */}
                            {streaming && (
                                <div className="shrink-0 pb-2">
                                    <StreamBubble
                                        content={streaming.content}
                                        reasoning={streaming.reasoning}
                                    />
                                </div>
                            )}

                            {error && (
                                <div className="mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-950/40 px-2.5 py-1.5 text-[10px] text-rose-300">
                                    <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                                    <span className="break-all">{error}</span>
                                </div>
                            )}

                            {/* 输入区 */}
                            <div className="flex shrink-0 items-end gap-1.5 border-t border-white/8 pt-2.5">
                                <textarea
                                    value={input}
                                    onChange={(event) => setInput(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' && !event.shiftKey) {
                                            event.preventDefault();
                                            submit();
                                        }
                                    }}
                                    rows={2}
                                    placeholder="描述你要做的事，例如：把接口返回的 is_vip 改成 true，并让页面相信"
                                    className="custom-scrollbar min-h-0 flex-1 resize-none rounded-xl border border-white/10 bg-slate-950/70 p-2.5 text-[11px] leading-relaxed text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-indigo-400/40"
                                />
                                {busy ? (
                                    <button
                                        onClick={actions.stop}
                                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-600 text-white transition hover:bg-rose-500"
                                        title="停止"
                                    >
                                        <Square className="h-3.5 w-3.5" />
                                    </button>
                                ) : (
                                    <button
                                        onClick={submit}
                                        disabled={!input.trim()}
                                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
                                        title="发送（Enter）"
                                    >
                                        <Send className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
                            {activeTab === 'rules' && (
                                <RulesTab
                                    intercept={draft.intercept}
                                    request={draft.request}
                                    onInterceptChange={draft.setIntercept}
                                    onRequestChange={draft.setRequest}
                                />
                            )}
                            {activeTab === 'headers' && <HeadersTab headers={draft.headers} onChange={draft.setHeaders} />}
                            {activeTab === 'storage' && <StorageTab tamper={tamper} currentUrl={currentUrl} />}
                            {activeTab === 'jwt' && <JwtTab tamper={tamper} />}
                            {activeTab === 'scripts' && (
                                <ScriptList scripts={scripts} onRemove={actions.removeScript} onToggle={actions.toggleScript} />
                            )}
                            {activeTab === 'kb' && <KbTab />}
                        </div>
                    )}
                </div>
            </aside>
        </>
    );
};

/* ========================================================================== */
/*                                面板外壳                                      */
/* ========================================================================== */

interface BrowsePanelProps {
    onNavigateToPlayer: () => void;
    onNavigateToAudio: () => void;
    onNavigateToGallery: () => void;
    onNavigateToTorrent: () => void;
    isVisible: boolean;
    browse: ReturnType<typeof useBrowse>;
    agent: AgentState;
}

export const BrowsePanel: React.FC<BrowsePanelProps> = ({
    onNavigateToPlayer,
    onNavigateToAudio,
    onNavigateToGallery,
    onNavigateToTorrent,
    isVisible,
    browse,
    agent,
}) => {
    const { tabs: tabsHook, bookmarks: bookmarksHook, search, sniffer, interactions, tamper, downloads } = browse;

    const {
        inputUrl,
        setInputUrl,
        setInputFocused,
        isCurrentPageBookmarked,
        handleNavigate,
        getWebviewRef,
        stopLoading,
        findInPage,
        setFindQuery,
        findQuery,
        findInfo,
        zoomBy,
        toggleMute,
        reviveTab,
        onUiAction,
    } = interactions;

    const { tabs, activeTabId, activeTab, actions: tabActions } = tabsHook;
    const { isAnalyzing, error } = sniffer;
    const {
        tree: bookmarkTree,
        barVisibility,
        setBarVisibility,
        removeBookmark,
        toggleBookmark,
        addFolder,
        renameNode,
        updateNodeUrl,
        moveBookmark,
        mergeImported,
    } = bookmarksHook;

    const [showDownloads, setShowDownloads] = useState(false);
    /** 书签管理器（全屏覆盖层） */
    const [showBookmarkManager, setShowBookmarkManager] = useState(false);
    /** Edge 导入面板（居中弹窗） */
    const [showEdgeImport, setShowEdgeImport] = useState(false);
    const addressInputRef = useRef<HTMLInputElement | null>(null);
    /**
     * 待填入 Agent 输入框的文本（右键「让 Agent 分析这个元素」产生）。
     *
     * 用**递增序号 + 文本**而不是纯文本：用户可能对同一个元素连点两次右键，
     * 而纯文本的第二次 setState 与第一次值相同，React 会跳过更新 ——
     * effect 不跑，输入框里已经删掉的内容不会被重新填上。
     */
    const [agentPrefill, setAgentPrefill] = useState<{ seq: number; text: string } | null>(null);

    /**
     * 界面层的浏览器动作（Ctrl+L 聚焦地址栏 / 右键"让 Agent 分析这个元素"）。
     *
     * 这两件事的真值在这里 —— useBrowse 没有地址栏 input 的 ref，
     * 也不该知道 Agent 输入框长什么样。所以那边原样转发，这边落地。
     */
    useEffect(() => onUiAction((command) => {
        if (command.action === 'focusAddressBar') {
            addressInputRef.current?.focus();
            addressInputRef.current?.select();
            return;
        }
        if (command.action === 'analyzeElement') {
            // 右键命中的坐标 → 一段提示 → 填进 Agent 输入框。
            //
            // **只填不发**：分析一个元素通常还要补一句"它的数据从哪来"，
            // 直接发出去等于替用户决定了问题。填进输入框他还能改。
            const x = Number(command.arg?.x) || 0;
            const y = Number(command.arg?.y) || 0;
            setAgentPrefill((prev) => ({
                seq: (prev?.seq || 0) + 1,
                text: `分析页面上坐标 (${x}, ${y}) 处的这个元素：它是什么、数据从哪来、能不能改。`,
            }));
            return;
        }
        if (command.action === 'searchSelection') {
            handleNavigate(String(command.arg?.text || ''));
        }
    }), [onUiAction, handleNavigate]);

    /**
     * Esc 关闭查找条。
     *
     * 挂在宿主页面而不是 webview 上，是因为主进程对 Esc 是**只通知不拦截**
     * （页面自己也要用 Esc）—— 所以页面里的 Esc 不会到这里，只有焦点在
     * 宿主界面（查找条自己的输入框）时才由这里处理。查找条自己的 onKeyDown
     * 也处理了一次，两处都需要：一处管焦点在条上，一处管焦点被用户点走之后。
     */
    useEffect(() => {
        if (!findQuery) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setFindQuery('');
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [findQuery, setFindQuery]);

    /** 错误页的「重试」：清掉错误态再重新加载，否则错误页会一直盖着 */
    const retryTab = useCallback((tabId: string) => {
        tabActions.setTabError(tabId, null);
        tabActions.setTabCrashed(tabId, false);
        tabActions.reload(tabId);
    }, [tabActions]);

    /**
     * 书签管理器的虚拟根。
     *
     * 管理器要能同时看到「收藏夹栏」与「其他收藏夹」两个根，但服务层的
     * findNode / collectFolders / countNodes 都只认单一根。用一个虚拟根
     * 把它们包起来，既复用了全部纯函数，又让管理器天然呈现出 Edge/Chrome
     * 那样的两级结构 —— 而不是给服务层再加一套「多根」重载。
     *
     * 这个节点**只存在于界面上**，不落盘、不参与任何写操作（见下面的
     * onAddFolder 重定向）。
     */
    const bookmarkRoot = useMemo<BookmarkNode>(() => ({
        id: '__bookmark_root__',
        type: 'folder',
        title: '全部书签',
        children: [bookmarkTree.bar, bookmarkTree.other],
        createdAt: 0,
    }), [bookmarkTree]);

    /**
     * Edge 导入结果落地。
     *
     * 这里只并**收藏夹**进树 —— 历史、自动填充、Cookie 各有各的去处
     * （Cookie 由主进程直接写进会话，账号由导入面板自己落盘并列出），
     * 书签树里没有它们的位置。
     *
     * `extras`（Edge 里非空的其它根，例如「移动收藏夹」）挂到「其他收藏夹」
     * 下面而不是丢掉：那些是用户的真实数据，只是不在主栏上。
     *
     * 返回实际合并的统计（新增 / 因已存在跳过），调用方拿去展示 —— 重复导入时
     * Edge 侧条数不变（"收藏夹 1336 条"），没有这行用户会以为"导了个寂寞"。
     */
    const applyEdgeImport = useCallback((result: EdgeImportResult): MergeStats | null => {
        if (!result.bookmarks) return null;

        // 分流而不是合并：Edge 的「收藏夹栏」进本应用的收藏夹栏，
        // 「其他收藏夹」与其余非空根进「其他收藏夹」。全部倒进栏上会让
        // 横栏瞬间塞满用户本来就没打算放出来的东西。
        const toBar = result.bookmarks.bar.children || [];
        const toOther = [
            ...(result.bookmarks.other.children || []),
            ...result.bookmarks.extras,
        ];

        const total: MergeStats = { added: 0, skipped: 0 };
        if (toBar.length > 0) {
            const s = mergeImported('bar', toBar);
            total.added += s.added;
            total.skipped += s.skipped;
        }
        if (toOther.length > 0) {
            const s = mergeImported('other', toOther);
            total.added += s.added;
            total.skipped += s.skipped;
        }
        return total;
    }, [mergeImported]);

    return (
        <div className="flex h-full w-full bg-slate-950" aria-hidden={!isVisible}>
            {/* 左：浏览器本体。侧边栏是它的兄弟节点，所以开合只挤压这一栏的宽度，
          webview 的父链保持不变 —— 这是"收起侧边栏不重载页面"的前提 */}
            <div className="flex min-w-0 flex-1 flex-col">
                <TabsBar
                    tabs={tabs}
                    activeTabId={activeTabId}
                    actions={tabActions}
                    onToggleMute={toggleMute}
                />

                <AddressBar
                    activeTab={activeTab}
                    activeTabId={activeTabId}
                    tabActions={tabActions}
                    inputUrl={inputUrl}
                    setInputUrl={setInputUrl}
                    setInputFocused={setInputFocused}
                    handleNavigate={handleNavigate}
                    isCurrentPageBookmarked={isCurrentPageBookmarked}
                    toggleBookmark={toggleBookmark}
                    isAnalyzing={isAnalyzing}
                    engine={search.engine}
                    onEngineChange={search.setEngine}
                    onNavigateToPlayer={onNavigateToPlayer}
                    onNavigateToAudio={onNavigateToAudio}
                    onNavigateToGallery={onNavigateToGallery}
                    onNavigateToTorrent={onNavigateToTorrent}
                    onStop={() => stopLoading(activeTabId)}
                    onZoom={(delta) => zoomBy(activeTabId, delta)}
                    downloadCount={downloads.activeCount}
                    onToggleDownloads={() => setShowDownloads((prev) => !prev)}
                    inputRef={addressInputRef}
                />

                {/* 书签栏。位置是硬约束：必须在 AddressBar 与 webview 容器之间，
                    作为同一根 flex 列的兄弟节点 —— 它绝不能成为 webview 的祖先，
                    父链一变 React 就会把 webview 卸载重挂，页面重新加载。
                    显示策略与 Edge/Chrome 一致，默认「仅新标签页」。 */}
                {(barVisibility === 'always' || (barVisibility === 'newTab' && !activeTab.url)) && (
                    <BookmarkBar
                        tree={bookmarkTree.bar}
                        visibility={barVisibility}
                        onVisibilityChange={setBarVisibility}
                        onNavigate={handleNavigate}
                        onOpenInNewTab={(url) => tabActions.openInNewTab(url)}
                        onRemove={removeBookmark}
                        onOpenManager={() => setShowBookmarkManager(true)}
                        onOpenImport={() => setShowEdgeImport(true)}
                    />
                )}

                {/* 相对定位容器：查找条与下载面板都是它的绝对定位子层。
                    它们**不能**包住 webview —— 父链一动就重载页面 */}
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <BrowserView
                        tabs={tabs}
                        activeTabId={activeTabId}
                        snifferError={error}
                        getWebviewRef={getWebviewRef}
                        onRetry={retryTab}
                        onRevive={reviveTab}
                        onGoBack={tabActions.goBack}
                    />

                    {findQuery !== '' && (
                        <FindBar
                            query={findQuery}
                            info={findInfo}
                            onChange={setFindQuery}
                            onNext={() => findInPage(activeTabId, findQuery, { findNext: true, forward: true })}
                            onPrev={() => findInPage(activeTabId, findQuery, { findNext: true, forward: false })}
                            onClose={() => setFindQuery('')}
                        />
                    )}

                    {showDownloads && (
                        <DownloadsPanel
                            downloads={downloads}
                            onClose={() => setShowDownloads(false)}
                        />
                    )}

                    {showBookmarkManager && (
                        <BookmarkManager
                            tree={bookmarkRoot}
                            onClose={() => setShowBookmarkManager(false)}
                            onNavigate={(url) => { handleNavigate(url); setShowBookmarkManager(false); }}
                            onRemove={removeBookmark}
                            onRename={renameNode}
                            onUpdateUrl={updateNodeUrl}
                            // 选中虚拟根时把新文件夹放进收藏夹栏 —— 虚拟根不落盘，
                            // 直接传下去会找不到父节点，表现为「点了创建但什么都没发生」
                            onAddFolder={(parentId, title) => addFolder(
                                parentId === bookmarkRoot.id ? bookmarkTree.bar.id : parentId,
                                title,
                            )}
                            // 同理：虚拟根不是真实节点，落点要改指收藏夹栏
                            onMove={(id, targetId, index) => moveBookmark(
                                id,
                                targetId === bookmarkRoot.id ? bookmarkTree.bar.id : targetId,
                                index,
                            )}
                            onOpenImport={() => { setShowBookmarkManager(false); setShowEdgeImport(true); }}
                        />
                    )}

                    {showEdgeImport && (
                        <EdgeImportPanel
                            onClose={() => setShowEdgeImport(false)}
                            onImported={applyEdgeImport}
                        />
                    )}
                </div>
            </div>

            {/* 右：Agent 工作区 */}
            <AgentSidebar
                agent={agent}
                tamper={tamper}
                currentUrl={activeTab.url}
                prefill={agentPrefill}
            />
        </div>
    );
};
