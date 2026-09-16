import { useState, useEffect, useCallback } from 'react';
import { Bookmark } from '../../meta';

// 本地存储键名常量
const STORAGE_KEYS = {
    BOOKMARKS: 'react-player-bookmarks',
};

/**
 * 书签管理 Hook
 * 职责：处理书签数据的加载、保存、添加、移除
 * 
 * @returns 书签状态及操作方法
 */
export const useBookmarks = () => {
    const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

    // 初始化：从 LocalStorage 加载书签
    useEffect(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.BOOKMARKS);
            if (saved) {
                setBookmarks(JSON.parse(saved));
            } else {
                // 默认预置书签
                const defaults: Bookmark[] = [
                    { id: '1', title: 'Google', url: 'https://www.google.com', createdAt: Date.now() },
                    { id: '2', title: 'Bing', url: 'https://www.bing.com', createdAt: Date.now() },
                    { id: '3', title: 'YouTube', url: 'https://www.youtube.com', createdAt: Date.now() },
                    { id: '4', title: 'Bilibili', url: 'https://www.bilibili.com', createdAt: Date.now() },
                ];
                setBookmarks(defaults);
                localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(defaults));
            }
        } catch (e) {
            console.error("加载书签失败:", e);
        }
    }, []);

    /**
     * 持久化保存
     */
    const saveBookmarks = (newBookmarks: Bookmark[]) => {
        setBookmarks(newBookmarks);
        localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(newBookmarks));
    };

    /**
     * 检查 URL 是否已收藏
     */
    const isBookmarked = useCallback((url: string) => {
        return bookmarks.some(b => b.url === url);
    }, [bookmarks]);

    /**
     * 切换收藏状态（存在则删除，不存在则添加）
     */
    const toggleBookmark = useCallback((url: string, title: string = '新书签') => {
        if (!url) return;
        
        const existing = bookmarks.find(b => b.url === url);
        
        if (existing) {
            // 移除
            const next = bookmarks.filter(b => b.url !== url);
            saveBookmarks(next);
        } else {
            // 添加
            // 尝试从 URL 提取 hostname 作为备用标题
            let finalTitle = title;
            try {
                if (title === '新书签' || !title) {
                    finalTitle = new URL(url).hostname; 
                }
            } catch {}

            const newBookmark: Bookmark = {
                id: Date.now().toString(),
                url,
                title: finalTitle,
                createdAt: Date.now()
            };
            saveBookmarks([...bookmarks, newBookmark]);
        }
    }, [bookmarks]);

    /**
     * 根据 ID 移除书签
     */
    const removeBookmark = useCallback((id: string) => {
        const next = bookmarks.filter(b => b.id !== id);
        saveBookmarks(next);
    }, [bookmarks]);

    return {
        bookmarks,
        isBookmarked,
        toggleBookmark,
        removeBookmark
    };
};