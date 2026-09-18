
import { useMemo } from 'react';
import { useTabs } from './useTabs';
import { useBookmarks } from './useBookmarks';
import { useSearch } from './useSearch';
import { useSniff } from './useSniff';
import { useBrowserInteractions } from './useInteractions';

export { useTabs, useBookmarks, useSearch, useSniff };

/**
 * 浏览引擎核心 Hook (Coordinator)
 * 职责：
 * 1. 聚合所有浏览相关的子 Hook (Tabs, Bookmarks, Search, Sniffer)。
 * 2. 编排交互逻辑 (Interactions)，注入所需依赖。
 * 3. 提供统一的接口供 UI 层调用。
 */
export const useBrowse = () => {
    // 1. 初始化各基础子模块
    const tabs = useTabs();
    const bookmarks = useBookmarks();
    const search = useSearch();

    // 2. 初始化交互逻辑 (注入依赖)
    const interactions = useBrowserInteractions({
        tabs,
        bookmarks,
        search
    });

    // 3. 初始化资源嗅探引擎 (注入 Webview 访问器与当前标签页信息)
    const sniffer = useSniff({
        getActiveWebview: interactions.getActiveWebview,
        activeTab: tabs.activeTab
    });

    // 3. 返回聚合对象 (Memoized)
    return useMemo(() => ({
        tabs,       // 标签页管理
        bookmarks,  // 书签管理
        search,     // 搜索与 URL 解析
        sniffer,    // 资源嗅探
        interactions // 交互逻辑与状态
    }), [tabs, bookmarks, search, sniffer, interactions]);
};
