
import React from 'react';
import { Globe, LayoutGrid, Trash2 } from 'lucide-react';
import { Bookmark } from '../../meta';

interface HomePageProps {
    bookmarks: Bookmark[];
    onNavigate: (url: string) => void;
    onRemoveBookmark: (id: string) => void;
}

// 书签可能是历史脏数据（如缺协议的裸域名），直接 new URL 会抛异常导致整个浏览面板白屏
const safeHostname = (url: string): string => {
    try {
        return new URL(url).hostname;
    } catch {
        try {
            return new URL(`https://${url}`).hostname;
        } catch {
            return url.slice(0, 30) || '未知站点';
        }
    }
};

export const HomePage: React.FC<HomePageProps> = ({ bookmarks, onNavigate, onRemoveBookmark }) => (
    <div className="w-full h-full flex flex-col items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-[600px] h-[600px] bg-indigo-600/5 rounded-full blur-[100px] opacity-50 animate-pulse" />
        </div>
        <div className="z-10 w-full max-w-4xl px-8 flex flex-col gap-10">
            <div className="flex flex-col items-center text-center gap-4">
                <div className="w-20 h-20 bg-slate-900 rounded-2xl flex items-center justify-center border border-slate-800 shadow-2xl shadow-indigo-500/10 mb-2">
                    <Globe className="w-10 h-10 text-indigo-400" />
                </div>
                <h3 className="text-3xl font-bold text-slate-200 tracking-tight">探索未知的网络世界</h3>
                <p className="text-slate-500 max-w-md">
                    内置 <span className="text-indigo-400">AI 嗅探引擎</span>，自动分析并提取视频流媒体资源。
                </p>
            </div>
            <div className="bg-slate-900/40 backdrop-blur-sm border border-slate-800 rounded-2xl p-6 shadow-xl">
                <div className="flex items-center justify-between mb-4 px-1">
                    <h4 className="text-sm font-bold text-slate-400 flex items-center gap-2">
                        <LayoutGrid className="w-4 h-4"/> 快速访问
                    </h4>
                    <span className="text-xs text-slate-600">{bookmarks.length} 个书签</span>
                </div>
                {bookmarks.length === 0 ? (
                    <div className="text-center py-8 text-slate-600 text-sm border-2 border-dashed border-slate-800 rounded-xl">
                        暂无书签
                    </div>
                ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                        {bookmarks.map((bm) => (
                            <div 
                                key={bm.id} 
                                className="group relative flex flex-col gap-2 p-3 bg-slate-800/50 hover:bg-indigo-600/10 border border-slate-700/50 hover:border-indigo-500/50 rounded-xl transition-all cursor-pointer hover:-translate-y-0.5"
                                onClick={() => onNavigate(bm.url)}
                            >
                                <div className="flex items-start justify-between">
                                    <div className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center text-slate-300 font-bold text-xs uppercase">
                                        {bm.title.substring(0, 2)}
                                    </div>
                                    <button 
                                        onClick={(e) => { e.stopPropagation(); onRemoveBookmark(bm.id); }}
                                        className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-red-400 transition"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                                <div className="min-w-0">
                                    <div className="text-sm font-medium text-slate-200 truncate">{bm.title}</div>
                                    <div className="text-[10px] text-slate-500 truncate">{safeHostname(bm.url)}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    </div>
);
