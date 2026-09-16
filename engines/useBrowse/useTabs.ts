
import { useState, useCallback, useEffect, useRef } from 'react';

export interface Tab {
    id: string;
    url: string;           // 当前 URL (React 状态同步用)
    initialUrl: string;    // 首次加载的 URL (webview src 属性用，避免重复加载)
    title: string;
    isLoading: boolean;
    // 每个标签页独立的历史记录
    history: string[];
    historyIndex: number;
    // 用于触发刷新的 Key
    reloadKey: number;
    // 待处理的导航动作 (webview API)
    pendingNavigation?: 'back' | 'forward';
}

const generateTabId = () => `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

// 从 URL 提取标题
const getTitleFromUrl = (url: string): string => {
    if (!url) return '新标签页';
    try {
        const urlObj = new URL(url);
        return urlObj.hostname || '新标签页';
    } catch {
        return url.slice(0, 30) || '新标签页';
    }
};

/**
 * 标签页管理 Hook
 * 职责：管理多标签页状态、历史记录、导航、加载状态
 */
export const useTabs = () => {
    // 标签页列表
    const [tabs, setTabs] = useState<Tab[]>([
        { id: generateTabId(), url: '', initialUrl: '', title: '新标签页', isLoading: false, history: [], historyIndex: -1, reloadKey: 0 }
    ]);
    // 当前激活的标签页 ID
    const [activeTabId, setActiveTabId] = useState<string>(tabs[0].id);
    // ref 镜像供 closeTab 等回调读取，避免 updater 内副作用与过期闭包
    const activeTabIdRef = useRef(activeTabId);
    useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

    // 获取当前标签页
    const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

    // 创建新标签页
    const createTab = useCallback((url: string = '') => {
        const newTab: Tab = {
            id: generateTabId(),
            url,
            initialUrl: url,  // 首次创建时 initialUrl 与 url 相同
            title: getTitleFromUrl(url),
            isLoading: !!url,
            history: url ? [url] : [],
            historyIndex: url ? 0 : -1,
            reloadKey: 0
        };
        setTabs(prev => [...prev, newTab]);
        setActiveTabId(newTab.id);
        return newTab.id;
    }, []);

    // 关闭标签页（禁止在 setTabs updater 内调用 setActiveTabId：
    // updater 在 StrictMode 下可能双跑，副作用会执行两次导致活动页错乱）
    const closeTab = useCallback((tabId: string) => {
        let nextActiveId: string | null = null;
        setTabs(prev => {
            if (prev.length <= 1) {
                // 至少保留一个标签页，重置为空白页
                return [{ id: prev[0].id, url: '', initialUrl: '', title: '新标签页', isLoading: false, history: [], historyIndex: -1, reloadKey: 0 }];
            }
            const newTabs = prev.filter(t => t.id !== tabId);
            // 如果关闭的是当前标签页，切换到相邻标签（只计算，不在此处 setState）
            if (tabId === activeTabIdRef.current) {
                const closedIndex = prev.findIndex(t => t.id === tabId);
                const newActiveIndex = Math.min(closedIndex, newTabs.length - 1);
                nextActiveId = newTabs[newActiveIndex].id;
            }
            return newTabs;
        });
        if (nextActiveId) {
            setActiveTabId(nextActiveId);
        }
    }, []);

    // 切换标签页
    const switchTab = useCallback((tabId: string) => {
        setActiveTabId(tabId);
    }, []);

    // 更新标签页 URL（导航）
    const navigateTab = useCallback((tabId: string, url: string, isLoading: boolean = true) => {
        setTabs(prev => prev.map(tab => {
            if (tab.id !== tabId) return tab;
            
            // 更新历史记录
            const newHistory = tab.history.slice(0, tab.historyIndex + 1);
            newHistory.push(url);
            
            // 如果 initialUrl 为空（首次导航），同时设置 initialUrl
            const newInitialUrl = tab.initialUrl || url;
            
            return {
                ...tab,
                url,
                initialUrl: newInitialUrl,
                title: getTitleFromUrl(url),
                isLoading: isLoading,
                history: newHistory,
                historyIndex: newHistory.length - 1
            };
        }));
    }, []);

    // 更新标签页标题
    const updateTabTitle = useCallback((tabId: string, title: string) => {
        setTabs(prev => prev.map(tab => 
            tab.id === tabId ? { ...tab, title: title || getTitleFromUrl(tab.url) } : tab
        ));
    }, []);

    // 设置加载状态
    const setTabLoading = useCallback((tabId: string, isLoading: boolean) => {
        setTabs(prev => prev.map(tab => 
            tab.id === tabId ? { ...tab, isLoading } : tab
        ));
    }, []);

    // 后退 (设置标志位，由 Interactions 处理实际 Webview 导航)
    const goBack = useCallback((tabId: string) => {
        setTabs(prev => prev.map(tab => {
            if (tab.id !== tabId || tab.historyIndex <= 0) return tab;
            return {
                ...tab,
                pendingNavigation: 'back',
                isLoading: true
            };
        }));
    }, []);

    // 前进 (设置标志位，由 Interactions 处理实际 Webview 导航)
    const goForward = useCallback((tabId: string) => {
        setTabs(prev => prev.map(tab => {
            if (tab.id !== tabId || tab.historyIndex >= tab.history.length - 1) return tab;
            return {
                ...tab,
                pendingNavigation: 'forward',
                isLoading: true
            };
        }));
    }, []);

    // 返回主页
    const goHome = useCallback((tabId: string) => {
        setTabs(prev => prev.map(tab => 
            tab.id === tabId ? { ...tab, url: '', initialUrl: '', title: '新标签页', isLoading: false, historyIndex: -1, history: [] } : tab
        ));
    }, []);

    // 刷新
    const reload = useCallback((tabId: string) => {
        setTabs(prev => prev.map(tab => {
            if (tab.id !== tabId || !tab.url) return tab;
            // 通过增加 reloadKey 来触发 UI 层的刷新逻辑，而不是hack URL
            return { ...tab, isLoading: true, reloadKey: (tab.reloadKey || 0) + 1 };
        }));
    }, []);

    // 在新标签页中打开 URL
    const openInNewTab = useCallback((url: string) => {
        createTab(url);
    }, [createTab]);

    // 同步 URL (来自 Webview 事件，不增加历史记录)
    const syncTabUrl = useCallback((tabId: string, url: string, historyIndex?: number) => {
        setTabs(prev => prev.map(tab => {
            if (tab.id !== tabId) return tab;
            return {
                ...tab,
                url,
                title: getTitleFromUrl(url),
                historyIndex: historyIndex !== undefined ? historyIndex : tab.historyIndex
            };
        }));
    }, []);

    // 清除待处理导航标记
    const clearPendingNavigation = useCallback((tabId: string) => {
        setTabs(prev => prev.map(tab => 
            tab.id === tabId ? { ...tab, pendingNavigation: undefined } : tab
        ));
    }, []);

    return {
        tabs,
        activeTabId,
        activeTab,
        actions: {
            createTab,
            closeTab,
            switchTab,
            navigateTab,
            updateTabTitle,
            setTabLoading,
            goBack,
            goForward,
            goHome,
            reload,
            openInNewTab,
            syncTabUrl,
            clearPendingNavigation
        }
    };
};
