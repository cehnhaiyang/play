
import React from 'react';
import { useBrowse } from '../../engines';
import { TabsBar } from './TabsBar';
import { AddressBar } from './AddressBar';
import { BrowserView } from './BrowserView';

interface BrowsePanelProps {
    onNavigateToPlayer: () => void;
    onNavigateToAudio: () => void;
    onOpenGalleryInPlayer?: (url: string) => void;
    isVisible: boolean;
    browse: ReturnType<typeof useBrowse>;
}

export const BrowsePanel: React.FC<BrowsePanelProps> = ({
    onNavigateToPlayer,
    onNavigateToAudio,
    onOpenGalleryInPlayer,
    isVisible,
    browse
}) => {
    const {
        tabs: tabsHook,
        bookmarks: bookmarksHook,
        sniffer,
        interactions
    } = browse;

    const {
        inputUrl,
        setInputUrl,
        isElectron,
        isCurrentPageBookmarked,
        handleNavigate,
        onLoadFinish,
        registerWebview,
        registerIframe
    } = interactions;

    const { tabs, activeTabId, activeTab, actions: tabActions } = tabsHook;
    const { isAnalyzing, error } = sniffer;
    const { bookmarks, removeBookmark, toggleBookmark } = bookmarksHook;

    return (
        <div className="h-full w-full bg-slate-950 flex flex-col" aria-hidden={!isVisible}>
            <TabsBar
                tabs={tabs}
                activeTabId={activeTabId}
                actions={tabActions}
            />

            <AddressBar
                activeTab={activeTab}
                activeTabId={activeTabId}
                tabActions={tabActions}
                inputUrl={inputUrl}
                setInputUrl={setInputUrl}
                handleNavigate={handleNavigate}
                isCurrentPageBookmarked={isCurrentPageBookmarked}
                toggleBookmark={toggleBookmark}
                isAnalyzing={isAnalyzing}
                onNavigateToPlayer={onNavigateToPlayer}
                onNavigateToAudio={onNavigateToAudio}
                onOpenGalleryInPlayer={onOpenGalleryInPlayer}
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
                registerWebview={registerWebview}
                registerIframe={registerIframe}
            />

            <style>{`
                @keyframes loading {
                    0% { transform: translateX(-100%); }
                    50% { transform: translateX(100%); }
                    100% { transform: translateX(-100%); }
                }
                .scrollbar-hide::-webkit-scrollbar { display: none; }
                .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
            `}</style>
        </div>
    );
};
