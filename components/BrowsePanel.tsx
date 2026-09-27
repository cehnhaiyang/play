import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    Code,
    Compass,
    Database,
    Globe,
    HardDrive,
    Home,
    KeyRound,
    Layers,
    Loader2,
    Maximize2,
    Minimize2,
    Music,
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
    X,
} from 'lucide-react';
import { useBrowse } from '../hooks';
import type {
    AgentState,
    BookmarksState,
    SearchEngine,
    Tab,
    TamperState,
    TabsState,
} from '../hooks';
import { SEARCH_ENGINE_OPTIONS, isAddressLike } from '../hooks';
import type {
    AgentMessage,
    AgentScript,
    Bookmark,
    CookieItem,
    HeaderRule,
    TamperRule,
    WebviewElement,
} from '../meta';
import {
    buildCookieData,
    collectDroppedRules,
    decodeJwt,
    findCookieByKey,
    generateId,
    pickJwtCandidates,
} from '../utils/utils';
import { loadJSON, saveJSON } from '../utils/persist';

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

const TabsBar: React.FC<{
    tabs: TabsState['tabs'];
    activeTabId: string;
    actions: TabsState['actions'];
}> = ({ tabs, activeTabId, actions }) => (
    <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-white/8 bg-white/[0.02] px-2">
        <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab: Tab) => {
                const isActive = tab.id === activeTabId;
                const host = safeHostname(tab.url);
                return (
                    <div
                        key={tab.id}
                        onClick={() => actions.switchTab(tab.id)}
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
                            <SiteTile host={host} className="h-4 w-4 text-[9px]" />
                        )}

                        <span className={`min-w-0 flex-1 truncate text-xs ${isActive ? 'font-semibold' : ''}`}>
                            {tab.title || '新标签页'}
                        </span>

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
            title="新建标签页"
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

        return (
            <div className="relative flex h-12 shrink-0 items-center gap-2 border-b border-white/8 bg-white/[0.03] px-2.5">
                {/* 导航控制 */}
                <div className="flex shrink-0 items-center gap-0.5">
                    <NavButton onClick={() => tabActions.goBack(activeTabId)} disabled={!canGoBack} title="后退">
                        <ArrowLeft className="h-4 w-4" />
                    </NavButton>
                    <NavButton onClick={() => tabActions.goForward(activeTabId)} disabled={!canGoForward} title="前进">
                        <ArrowRight className="h-4 w-4" />
                    </NavButton>
                    <NavButton onClick={() => tabActions.goHome(activeTabId)} title="主页">
                        <Home className="h-4 w-4" />
                    </NavButton>
                    <NavButton onClick={() => tabActions.reload(activeTabId)} title="刷新">
                        <RotateCw className={`h-4 w-4 ${activeTab.isLoading || isAnalyzing ? 'animate-spin text-indigo-400' : ''}`} />
                    </NavButton>
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

                        {activeTab.url && (
                            <button
                                onClick={() => toggleBookmark(activeTab.url, activeTab.title)}
                                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition ${isCurrentPageBookmarked ? 'text-amber-400' : 'text-slate-600 hover:text-amber-300'
                                    }`}
                                title={isCurrentPageBookmarked ? '取消收藏' : '收藏此页'}
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

                {/* 右侧功能入口：三个应用入口。地址栏不按域名长出额外按钮 ——
                    "在播放器里打开这个页面"在画廊与播放器里各有入口 */}
                <div className="flex shrink-0 items-center gap-1.5">
                    <div className="flex items-center gap-0.5 rounded-xl border border-white/8 bg-white/[0.03] p-0.5">
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
/*                                  首页                                       */
/* ========================================================================== */

const HomePage: React.FC<{
    bookmarks: Bookmark[];
    onNavigate: (url: string) => void;
    onRemoveBookmark: (id: string) => void;
}> = ({ bookmarks, onNavigate, onRemoveBookmark }) => (
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
                    自动分析并提取页面里的视频流媒体资源；右侧 Agent 可以直接在这页里动手。
                </p>
            </div>

            <div className="w-full rounded-2xl border border-white/8 bg-white/[0.03] p-5 backdrop-blur-sm">
                <div className="mb-3.5 flex items-center justify-between px-0.5">
                    <h3 className="flex items-center gap-2 text-xs font-bold text-slate-400">
                        <Compass className="h-3.5 w-3.5" />
                        快速访问
                    </h3>
                    <span className="font-mono text-[11px] text-slate-600">{bookmarks.length} 个书签</span>
                </div>

                {bookmarks.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-white/8 py-8 text-center text-xs text-slate-600">
                        还没有书签 —— 打开一个页面，点地址栏右边的星标即可收藏
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                        {bookmarks.map((bookmark) => {
                            const host = safeHostname(bookmark.url);
                            return (
                                <div
                                    key={bookmark.id}
                                    onClick={() => onNavigate(bookmark.url)}
                                    title={bookmark.url}
                                    className="group relative flex cursor-pointer items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] p-3 transition-all hover:-translate-y-0.5 hover:border-indigo-400/40 hover:bg-indigo-500/8 hover:shadow-[0_10px_28px_rgba(0,0,0,0.35)]"
                                >
                                    <SiteTile host={host} className="h-9 w-9 text-sm" />
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-xs font-semibold text-slate-200">{bookmark.title}</div>
                                        <div className="truncate font-mono text-[10px] text-slate-500">{host || bookmark.url}</div>
                                    </div>
                                    <button
                                        onClick={(event) => { event.stopPropagation(); onRemoveBookmark(bookmark.id); }}
                                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-600 opacity-0 transition group-hover:opacity-100 hover:bg-rose-500/15 hover:text-rose-300"
                                        title="移除书签"
                                    >
                                        <Trash2 className="h-3 w-3" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    </div>
);

/* ========================================================================== */
/*                                浏览视图                                      */
/* ========================================================================== */

const BrowserView: React.FC<{
    tabs: Tab[];
    activeTabId: string;
    isElectron: boolean;
    onLoadFinish: (id: string) => void;
    bookmarks: BookmarksState['bookmarks'];
    handleNavigate: (url: string) => void;
    removeBookmark: (id: string) => void;
    snifferError: string;
    /** 稳定身份的 webview ref 回调工厂，见 useBrowse 内注释 */
    getWebviewRef: (tabId: string) => (el: WebviewElement | null) => void;
    registerIframe: (id: string, el: HTMLIFrameElement | null) => void;
}> = ({
    tabs,
    activeTabId,
    isElectron,
    onLoadFinish,
    bookmarks,
    handleNavigate,
    removeBookmark,
    snifferError,
    getWebviewRef,
    registerIframe,
}) => {
        const activeTab = tabs.find((tab) => tab.id === activeTabId);

        return (
            <div className="relative flex-1 overflow-hidden bg-slate-950">
                {/* 所有标签页常驻：只切可见性，不卸载。webview 一卸载就丢页面状态，
          切回来是重新加载（登录态、滚动、播放进度全没） */}
                {tabs.map((tab) => (
                    <div key={tab.id} className={`absolute inset-0 ${tab.id === activeTabId ? 'z-10' : 'invisible z-0'}`}>
                        {tab.url ? (
                            isElectron ? (
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
                            ) : tab.initialUrl ? (
                                <iframe
                                    ref={(el) => registerIframe(tab.id, el)}
                                    src={tab.initialUrl}
                                    title={tab.title}
                                    className="h-full w-full border-none bg-white"
                                    sandbox="allow-same-origin allow-scripts allow-forms allow-downloads"
                                    onLoad={() => onLoadFinish(tab.id)}
                                />
                            ) : null
                        ) : (
                            <HomePage bookmarks={bookmarks} onNavigate={handleNavigate} onRemoveBookmark={removeBookmark} />
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
/*                            Agent：对话流                                     */
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

/* ========================================================================== */
/*                            Agent：侧边栏外壳                                 */
/* ========================================================================== */

type AgentTab = 'chat' | 'rules' | 'headers' | 'storage' | 'jwt' | 'scripts';

const AGENT_TABS: { id: AgentTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'chat', label: '对话', icon: Bot },
    { id: 'rules', label: '规则', icon: Database },
    { id: 'headers', label: '请求头', icon: ArrowRightLeft },
    { id: 'storage', label: '存储', icon: Globe },
    { id: 'jwt', label: 'JWT', icon: KeyRound },
    { id: 'scripts', label: '脚本', icon: Code },
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
}> = ({ agent, tamper, currentUrl }) => {
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

                    {/* 标签：图标 + 文字两行。侧边栏最窄 320px，六个标签横排仍放得下 */}
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
    isVisible: boolean;
    browse: ReturnType<typeof useBrowse>;
    agent: AgentState;
}

export const BrowsePanel: React.FC<BrowsePanelProps> = ({
    onNavigateToPlayer,
    onNavigateToAudio,
    onNavigateToGallery,
    isVisible,
    browse,
    agent,
}) => {
    const { tabs: tabsHook, bookmarks: bookmarksHook, search, sniffer, interactions, tamper } = browse;

    const {
        inputUrl,
        setInputUrl,
        setInputFocused,
        isElectron,
        isCurrentPageBookmarked,
        handleNavigate,
        onLoadFinish,
        getWebviewRef,
        registerIframe,
    } = interactions;

    const { tabs, activeTabId, activeTab, actions: tabActions } = tabsHook;
    const { isAnalyzing, error } = sniffer;
    const { bookmarks, removeBookmark, toggleBookmark } = bookmarksHook;

    return (
        <div className="flex h-full w-full bg-slate-950" aria-hidden={!isVisible}>
            {/* 左：浏览器本体。侧边栏是它的兄弟节点，所以开合只挤压这一栏的宽度，
          webview 的父链保持不变 —— 这是"收起侧边栏不重载页面"的前提 */}
            <div className="flex min-w-0 flex-1 flex-col">
                <TabsBar tabs={tabs} activeTabId={activeTabId} actions={tabActions} />

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
                />

                <BrowserView
                    tabs={tabs}
                    activeTabId={activeTabId}
                    isElectron={isElectron}
                    onLoadFinish={onLoadFinish}
                    bookmarks={bookmarks}
                    handleNavigate={handleNavigate}
                    removeBookmark={removeBookmark}
                    snifferError={error}
                    getWebviewRef={getWebviewRef}
                    registerIframe={registerIframe}
                />
            </div>

            {/* 右：Agent 工作区。非 Electron 下没有 webview，Agent 一步都做不了，
          所以直接不给入口，而不是给一个点了没反应的按钮 */}
            {isElectron && <AgentSidebar agent={agent} tamper={tamper} currentUrl={activeTab.url} />}
        </div>
    );
};
