
import React from 'react';
import { AlertCircle } from 'lucide-react';
import { WebviewElement } from '../../meta';
import { Tab } from '../../hooks/useBrowse/useTabs';
import { HomePage } from './HomePage';
import { useBookmarks } from '../../hooks/useBrowse/useBookmarks';

interface BrowserViewProps {
    tabs: Tab[];
    activeTabId: string;
    isElectron: boolean;
    onLoadFinish: (id: string) => void;
    
    // Register callbacks from interactions
    registerWebview: (id: string, el: WebviewElement | null) => void;
    registerIframe: (id: string, el: HTMLIFrameElement | null) => void;

    // HomePage Props
    bookmarks: ReturnType<typeof useBookmarks>['bookmarks'];
    handleNavigate: (url: string) => void;
    removeBookmark: (id: string) => void;
    
    // Error state
    snifferError: string;
}

export const BrowserView: React.FC<BrowserViewProps> = ({
    tabs,
    activeTabId,
    isElectron,
    onLoadFinish,
    bookmarks,
    handleNavigate,
    removeBookmark,
    snifferError,
    registerWebview,
    registerIframe
}) => {
    const activeTab = tabs.find(t => t.id === activeTabId);

    return (
        <div className="flex-1 relative bg-slate-950 overflow-hidden">
            {tabs.map(tab => (
                <div 
                    key={tab.id} 
                    className={`absolute inset-0 ${tab.id === activeTabId ? 'z-10' : 'z-0 invisible'}`}
                >
                    {tab.url ? (
                        isElectron ? (
                            tab.initialUrl ? (
                                <webview
                                    ref={(el) => registerWebview(tab.id, el as unknown as WebviewElement)}
                                    src={tab.initialUrl}
                                    className="w-full h-full border-none bg-white"
                                    useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                                    // @ts-ignore: Electron 特有属性
                                    allowpopups="false"
                                    // @ts-ignore: Electron 特有属性
                                    webpreferences="contextIsolation=yes"
                                />
                            ) : null
                        ) : (
                            tab.initialUrl ? (
                                <iframe 
                                    ref={(el) => registerIframe(tab.id, el)}
                                    src={tab.initialUrl}
                                    title={tab.title}
                                    className="w-full h-full border-none bg-white"
                                    sandbox="allow-same-origin allow-scripts allow-forms allow-downloads"
                                    onLoad={() => onLoadFinish(tab.id)}
                                />
                            ) : null
                        )
                    ) : (
                        /* 空白页 / 快速访问页 */
                        <HomePage 
                            bookmarks={bookmarks} 
                            onNavigate={handleNavigate} 
                            onRemoveBookmark={removeBookmark} 
                        />
                    )}
                </div>
            ))}
            
            {/* 错误提示浮层 */}
            {activeTab?.url && snifferError && (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-red-950/90 backdrop-blur-md text-red-200 text-xs px-4 py-2.5 rounded-full shadow-2xl border border-red-500/30 flex items-center gap-2 z-30">
                    <AlertCircle className="w-4 h-4 text-red-400" />
                    <span className="truncate">{snifferError}</span>
                </div>
            )}
        </div>
    );
};
