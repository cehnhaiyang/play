
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { WebviewElement, getElectronAPI, getAppWindow } from '../../meta';

// 定义所需的接口形状，解耦具体实现
interface TabsDependency {
    activeTab: { url: string; id: string; initialUrl: string; historyIndex: number };
    activeTabId: string;
    tabs: Array<{ id: string; url: string; initialUrl: string; reloadKey: number; historyIndex: number; history: string[]; pendingNavigation?: 'back' | 'forward' }>;
    actions: {
        navigateTab: (id: string, url: string, isLoading?: boolean) => void;
        syncTabUrl: (id: string, url: string, historyIndex?: number) => void;
        openInNewTab: (url: string) => void;
        setTabLoading: (id: string, isLoading: boolean) => void;
        clearPendingNavigation: (id: string) => void;
    };
}

interface SearchDependency {
    parseInputToUrl: (input: string) => string;
}

interface BookmarksDependency {
    isBookmarked: (url: string) => boolean;
}

interface InteractionDependencies {
    tabs: TabsDependency;
    search: SearchDependency;
    bookmarks: BookmarksDependency;
}

/**
 * 浏览面板交互逻辑 Hook
 * 职责：
 * 1. 管理地址栏输入状态
 * 2. 处理导航跳转和新标签页打开逻辑
 * 3. 监听 Electron IPC 消息和 Webview DOM 事件
 * 4. 管理 Webview/Iframe 引用
 */
export const useBrowserInteractions = (deps: InteractionDependencies) => {
    const { tabs: tabsState, search, bookmarks } = deps;
    const { activeTab, activeTabId, actions: tabActions } = tabsState;
    const { parseInputToUrl } = search;
    const { isBookmarked } = bookmarks;

    // UI 状态
    const [inputUrl, setInputUrl] = useState('');
    
    // DOM 引用 (不要用 state 存储 webview，会导致 React DevTools 跨域错误)
    const webviewRefs = useRef<Map<string, WebviewElement>>(new Map());
    const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
    
    // 追踪 webview 是否已 ready (dom-ready 事件触发后)
    const webviewReadyRefs = useRef<Set<string>>(new Set());
    
    // 追踪之前的 Reload Key 以检测刷新请求
    const prevReloadKeys = useRef<Record<string, number>>({});
    
    // 追踪正在进行的前进后退操作 (用于 did-navigate 时判断是否需要更新历史记录)
    const pendingHistoryNav = useRef<Map<string, 'back' | 'forward'>>(new Map());
    
    // 待导航的 URL (当 webview 还没 ready 时暂存)
    const pendingNavigations = useRef<Map<string, string>>(new Map());
    
    // 保持 tabs 的最新引用，以便在事件回调中访问最新状态
    const tabsRef = useRef(tabsState.tabs);
    useEffect(() => { tabsRef.current = tabsState.tabs; }, [tabsState.tabs]);

    // 保持 activeTabId 的最新引用
    const activeTabIdRef = useRef(activeTabId);
    useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

    // 环境检测
    const isElectron = useMemo(() => !!(getElectronAPI() || getAppWindow().process?.isElectron), []);

    // 1. 同步地址栏内容
    useEffect(() => {
        setInputUrl(activeTab.url);
    }, [activeTab.url, activeTabId]);

    // 2. 监听 URL 变化，通过 webview API 导航 (避免 React 重渲染触发 src 属性变化)
    useEffect(() => {
        tabsState.tabs.forEach(tab => {
            const webview = webviewRefs.current.get(tab.id);
            const isReady = webviewReadyRefs.current.has(tab.id);
            
            if (!tab.url) return;

            if (webview && isReady) {
                try {
                    const currentSrc = (webview as any).getURL?.() || '';
                    
                    // 修复逻辑：移除基于索引的 goBack/goForward 优化。
                    // 这种优化在 React 状态与 Webview 内部历史栈不一致时会导致“地址变了但页面没变”的 Bug。
                    // 改为强制同步：只要 Webview 当前 URL 与 Tab 状态 URL 不一致，就强制加载目标 URL。
                    // 这确保了视图（Webview）永远与数据（Tab State）保持一致。
                    
                    // 简单的 URL 比较，忽略末尾斜杠差异以避免无限循环
                    const normalize = (u: string) => u.replace(/\/$/, '');
                    
                    if (normalize(currentSrc) !== normalize(tab.url)) {
                        // 只有当确实不一致时才导航
                        console.log('[Nav] Syncing Webview to:', tab.url);
                        (webview as any).loadURL(tab.url);
                    }
                    
                    // 清除待导航
                    pendingNavigations.current.delete(tab.id);
                } catch (e) {
                    console.error('Failed to navigate webview:', e);
                }
            } else if (webview && !isReady) {
                // webview 存在但还没 ready，记录待导航 URL
                pendingNavigations.current.set(tab.id, tab.url);
            } else if (!webview) {
                // iframe 处理 (Iframe 的 history API 受同源策略限制，通常只能重新设置 src)
                const iframe = iframeRefs.current.get(tab.id);
                if (iframe && iframe.src !== tab.url) {
                    iframe.src = tab.url;
                }
            }
        });
    }, [tabsState.tabs]);

    // 3. 核心导航方法
    const handleNavigate = useCallback((urlOrQuery: string) => {
        const finalUrl = parseInputToUrl(urlOrQuery);
        if (!finalUrl) return;

        // 修改为：每进入一个新界面就打开一个新标签页
        const currentActiveId = activeTabIdRef.current;
        const currentTabs = tabsRef.current;
        const currentTab = currentTabs.find(t => t.id === currentActiveId);

        // 如果当前是空白页（新标签页），则在当前页导航
        // 否则（即已有内容），则新建标签页打开
        if (currentTab && !currentTab.url) {
            tabActions.navigateTab(currentActiveId, finalUrl);
            setInputUrl(finalUrl);
        } else {
            tabActions.openInNewTab(finalUrl);
            // 新标签页激活后，上方的 useEffect 会自动更新 inputUrl
        }
    }, [parseInputToUrl, tabActions]);

    // 3. 在新标签页打开
    const handleOpenInNewTab = useCallback((url: string) => {
        const finalUrl = parseInputToUrl(url);
        if (finalUrl) {
            tabActions.openInNewTab(finalUrl);
        }
    }, [parseInputToUrl, tabActions]);

    // 4. 处理 Webview 内部的 window.open 或 target="_blank"
    const onWebviewNewWindow = useCallback((e: Event) => {
        e.preventDefault();
        const url = (e as any).url || (e as CustomEvent<{ url: string }>).detail?.url;
        if (url) {
            handleOpenInNewTab(url);
        }
    }, [handleOpenInNewTab]);

    // 5. 处理页面加载完成
    const onLoadFinish = useCallback((tabId: string) => {
        tabActions.setTabLoading(tabId, false);
    }, [tabActions]);

    // 6. 绑定 Webview 事件 (Stable Callback)
    const attachWebviewListeners = useCallback((tabId: string, webview: WebviewElement) => {
        // 避免重复绑定
        if ((webview as any).__listenersAttached) return;

        const handleNewWindow = (e: Event) => onWebviewNewWindow(e);
        
        // dom-ready 事件：标记 webview 已准备好接受 API 调用，同时结束加载状态
        const handleDomReady = () => {
            webviewReadyRefs.current.add(tabId);
            tabActions.setTabLoading(tabId, false);
            
            // 检查是否有待导航的 URL
            const pendingUrl = pendingNavigations.current.get(tabId);
            if (pendingUrl) {
                try {
                    const currentSrc = (webview as any).getURL?.() || '';
                    if (currentSrc !== pendingUrl) {
                        console.log('[Nav] Pending loadURL:', pendingUrl);
                        (webview as any).loadURL(pendingUrl);
                    }
                    pendingNavigations.current.delete(tabId);
                } catch (e) {
                    console.error('Failed to navigate pending URL:', e);
                }
            }
        };
        
        // did-finish-load 也结束加载状态（某些页面可能不触发 dom-ready）
        const handleFinish = () => {
            tabActions.setTabLoading(tabId, false);
        };
        const handleFail = () => {
            tabActions.setTabLoading(tabId, false);
        };

        // 处理 Webview 内部导航（同步 React 状态）
        const handleNavigateInternal = (e: any) => {
             const url = e.url;
             const currentTab = tabsRef.current.find(t => t.id === tabId);
             
             if (!url || !currentTab || url === currentTab.url) return;
             
             // 检查是否是前进后退导航
             const historyNavType = pendingHistoryNav.current.get(tabId);
             if (historyNavType) {
                 // 前进后退导航：计算新的 historyIndex，仅同步 URL 不修改历史记录
                 const newIndex = historyNavType === 'back' 
                     ? Math.max(0, currentTab.historyIndex - 1)
                     : Math.min(currentTab.history.length - 1, currentTab.historyIndex + 1);
                 
                 console.log('[Nav] History nav complete:', historyNavType, 'newIndex:', newIndex);
                 tabActions.syncTabUrl(tabId, url, newIndex);
                 pendingHistoryNav.current.delete(tabId);
             } else {
                 // 普通导航（用户点击链接）：添加到历史记录
                 tabActions.navigateTab(tabId, url, false);
             }
        };
        const handleInPageNavigate = (e: any) => {
             const url = e.url;
             const currentTab = tabsRef.current.find(t => t.id === tabId);
             if (url && currentTab && url !== currentTab.url) {
                  tabActions.navigateTab(tabId, url, false);
             }
        };

        webview.addEventListener('dom-ready', handleDomReady);
        webview.addEventListener('new-window', handleNewWindow);
        webview.addEventListener('did-finish-load', handleFinish);
        webview.addEventListener('did-fail-load', handleFail);
        webview.addEventListener('did-navigate', handleNavigateInternal);
        webview.addEventListener('did-navigate-in-page', handleInPageNavigate);
        
        (webview as any).__listenersAttached = true;
    }, [onWebviewNewWindow, tabActions]);

    // 注册 Webview 引用 (传递给 BrowserView)
    const registerWebview = useCallback((id: string, el: WebviewElement | null) => {
        if (el) {
            webviewRefs.current.set(id, el);
            if (isElectron) {
                attachWebviewListeners(id, el);
                // 如果 webview 已经有 URL，说明可能已经 ready 了
                setTimeout(() => {
                    try {
                        const url = (el as any).getURL?.();
                        if (url) {
                            webviewReadyRefs.current.add(id);
                        }
                    } catch (e) {
                        // 忽略错误
                    }
                }, 100);
            }
        } else {
            webviewRefs.current.delete(id);
            webviewReadyRefs.current.delete(id);
            // 关闭标签页后清理该页的暂存状态，避免已关闭 tab 的 URL 残留导致误导航或内存泄漏
            pendingNavigations.current.delete(id);
            pendingHistoryNav.current.delete(id);
            delete prevReloadKeys.current[id];
        }
    }, [isElectron, attachWebviewListeners]);

    // 注册 Iframe 引用 (传递给 BrowserView)
    const registerIframe = useCallback((id: string, el: HTMLIFrameElement | null) => {
        if (el) {
            iframeRefs.current.set(id, el);
        } else {
            iframeRefs.current.delete(id);
        }
    }, []);

    // Effect: 监听 Electron 主进程发来的"新窗口打开"请求
    useEffect(() => {
        const electronAPI = getElectronAPI();
        if (electronAPI) {
            electronAPI.onNavigateToUrl((url: string) => {
                handleOpenInNewTab(url);
            });
            return () => {
                electronAPI.removeNavigateListener();
            };
        }
    }, [handleOpenInNewTab]);

    // Effect: 监听 Reload Trigger 变化
    useEffect(() => {
        tabsState.tabs.forEach(tab => {
            const prev = prevReloadKeys.current[tab.id] || 0;
            if (tab.reloadKey > prev) {
                // 触发刷新
                const webview = webviewRefs.current.get(tab.id);
                if (webview) {
                    try { webview.reload(); } catch(e) { console.error(e); }
                } else {
                    const iframe = iframeRefs.current.get(tab.id);
                    if (iframe && iframe.contentWindow) {
                        try { iframe.contentWindow.location.reload(); } catch(e) { console.error(e); }
                    }
                }
                prevReloadKeys.current[tab.id] = tab.reloadKey;
            }
        });
    }, [tabsState.tabs]);

    // Effect: 处理前进/后退导航请求 (直接调用 webview API)
    useEffect(() => {
        tabsState.tabs.forEach(tab => {
            if (!tab.pendingNavigation) return;
            
            const webview = webviewRefs.current.get(tab.id);
            if (webview && webviewReadyRefs.current.has(tab.id)) {
                try {
                    // 记录导航类型，供 did-navigate 事件处理器使用
                    pendingHistoryNav.current.set(tab.id, tab.pendingNavigation);
                    
                    if (tab.pendingNavigation === 'back') {
                        console.log('[Nav] Webview goBack');
                        webview.goBack();
                    } else if (tab.pendingNavigation === 'forward') {
                        console.log('[Nav] Webview goForward');
                        webview.goForward();
                    }
                } catch (e) {
                    console.error('Failed to navigate webview:', e);
                    pendingHistoryNav.current.delete(tab.id);
                }
                // 清除标记
                tabActions.clearPendingNavigation(tab.id);
            } else {
                // 非 Electron 环境或 webview 未就绪，清除标记并结束加载
                tabActions.clearPendingNavigation(tab.id);
                tabActions.setTabLoading(tab.id, false);
            }
        });
    }, [tabsState.tabs, tabActions]);

    const isCurrentPageBookmarked = isBookmarked(activeTab.url);

    // 获取当前激活的 Webview 实例 (用于 Tamper 等外部调用)
    const getActiveWebview = useCallback(() => {
        return webviewRefs.current.get(activeTabId) || null;
    }, [activeTabId]);

    return {
        inputUrl,
        setInputUrl,
        isElectron,
        isCurrentPageBookmarked,
        handleNavigate,
        handleOpenInNewTab,
        onLoadFinish,
        registerWebview,
        registerIframe,
        getActiveWebview
    };
};
