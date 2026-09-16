
import React from 'react';
import { Home, RotateCw, Globe, Search, Star, Sparkles, Play, Music, BookOpen, Headphones, Film } from 'lucide-react';
import { Tab, useTabs } from '../../engines/useBrowse/useTabs';
import { useBookmarks } from '../../engines/useBrowse/useBookmarks';
import { isAcgUrl } from '../../utils';

interface AddressBarProps {
    activeTab: Tab;
    activeTabId: string;
    tabActions: Pick<ReturnType<typeof useTabs>['actions'], 'goHome' | 'reload'>;
    inputUrl: string;
    setInputUrl: (url: string) => void;
    handleNavigate: (url: string) => void;

    isCurrentPageBookmarked: boolean;
    toggleBookmark: ReturnType<typeof useBookmarks>['toggleBookmark'];

    isAnalyzing: boolean;
    onNavigateToPlayer: () => void;
    onNavigateToAudio: () => void;
    onOpenGalleryInPlayer?: (url: string) => void;
}

export const AddressBar: React.FC<AddressBarProps> = ({
    activeTab,
    activeTabId,
    tabActions,
    inputUrl,
    setInputUrl,
    handleNavigate,
    isCurrentPageBookmarked,
    toggleBookmark,
    isAnalyzing,
    onNavigateToPlayer,
    onNavigateToAudio,
    onOpenGalleryInPlayer,
}) => {
    return (
        <div className="h-14 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 flex items-center px-4 gap-3 shrink-0 shadow-lg z-20 relative">
            {/* 导航控制 */}
            <div className="flex items-center gap-1">
                <button
                    onClick={() => tabActions.goHome(activeTabId)}
                    className={`p-2 rounded-lg transition ${!activeTab.url ? 'text-indigo-400 bg-indigo-500/10' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                    title="主页"
                >
                    <Home className="w-4 h-4" />
                </button>
                <div className="w-px h-4 bg-slate-700 mx-1" />
                <button
                    onClick={() => tabActions.reload(activeTabId)}
                    className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition"
                    title="刷新"
                >
                    <RotateCw className={`w-4 h-4 ${activeTab.isLoading || isAnalyzing ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* 地址输入框 */}
            <div className="flex-1 max-w-3xl relative">
                <div className="relative flex items-center w-full">
                    <div className="absolute left-3 text-slate-500">
                        {activeTab.url.startsWith('https') ? <Globe className="w-4 h-4 text-green-500/70" /> : <Search className="w-4 h-4" />}
                    </div>
                    <input
                        type="text"
                        value={inputUrl}
                        onChange={(e) => setInputUrl(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleNavigate(inputUrl)}
                        onFocus={(e) => e.target.select()}
                        placeholder="输入网址或搜索内容..."
                        className="w-full bg-slate-950/80 border border-slate-700 rounded-xl pl-10 pr-24 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500/50 focus:bg-slate-900 focus:ring-2 focus:ring-indigo-500/20 transition-all font-mono shadow-inner"
                    />
                    <div className="absolute right-1.5 flex items-center gap-1">
                        {activeTab.url && (
                            <button
                                onClick={() => toggleBookmark(activeTab.url, activeTab.title)}
                                className={`p-1.5 rounded-lg transition hover:bg-slate-800 ${isCurrentPageBookmarked ? 'text-yellow-400' : 'text-slate-500 hover:text-yellow-200'}`}
                                title={isCurrentPageBookmarked ? "取消收藏" : "收藏"}
                            >
                                <Star className={`w-4 h-4 ${isCurrentPageBookmarked ? 'fill-current' : ''}`} />
                            </button>
                        )}
                        <button
                            onClick={() => handleNavigate(inputUrl)}
                            className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition shadow-md"
                        >
                            Go
                        </button>
                    </div>
                </div>
            </div>

            {/* 右侧功能入口 */}
            <div className="flex items-center gap-2 ml-auto">
                {activeTab.url && isAcgUrl(activeTab.url) && onOpenGalleryInPlayer && (() => {
                    const url = activeTab.url.toLowerCase();
                    const isVideo = url.includes('/animation/') || url.includes('/gif/');
                    const isAudio = url.includes('/asmr/');
                    const isAnimated = url.includes('/hentai/');

                    const btnClass = isVideo
                        ? 'bg-gradient-to-r from-indigo-500 via-blue-500 to-cyan-400'
                        : isAudio
                        ? 'bg-gradient-to-r from-violet-500 via-purple-500 to-pink-500'
                        : isAnimated
                        ? 'bg-gradient-to-r from-amber-500 via-rose-500 to-pink-500'
                        : 'bg-gradient-to-r from-rose-500 via-pink-500 to-amber-500';

                    const label = isVideo ? '播放动画' : isAudio ? '播放音声' : isAnimated ? '开阅动图' : '开阅漫画';

                    return (
                        <button
                            onClick={() => onOpenGalleryInPlayer(activeTab.url)}
                            className={`px-3 py-1.5 ${btnClass} hover:brightness-110 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-md shadow-rose-500/20 group`}
                            title={`在播放器中直接${label}`}
                        >
                            {isVideo ? (
                                <Film className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
                            ) : isAudio ? (
                                <Headphones className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
                            ) : isAnimated ? (
                                <Sparkles className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
                            ) : (
                                <BookOpen className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
                            )}
                            <span className="hidden sm:inline">{label}</span>
                        </button>
                    );
                })()}

                <button
                    onClick={onNavigateToAudio}
                    className="p-2 bg-slate-800 hover:bg-slate-700 text-cyan-400 hover:text-cyan-300 rounded-xl transition border border-white/5 flex items-center gap-2 group"
                    title="音频工坊"
                >
                    <Music className="w-4 h-4 group-hover:scale-110 transition-transform" />
                    <span className="hidden lg:inline text-xs font-bold">AudioLab</span>
                </button>

                <button
                    onClick={onNavigateToPlayer}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition text-sm font-bold border border-white/5 flex items-center gap-2"
                >
                    <span className="hidden sm:inline">播放器</span>
                    <Play className="w-4 h-4 fill-current" />
                </button>
            </div>

            {/* 加载进度条 */}
            {activeTab.isLoading && (
                <div className="absolute bottom-0 left-0 w-full h-[2px] bg-slate-800 overflow-hidden">
                    <div className="h-full bg-indigo-500 animate-[loading_2s_ease-in-out_infinite] w-1/3" />
                </div>
            )}
        </div>
    );
};
