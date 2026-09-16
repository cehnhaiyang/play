import { useState, useCallback } from 'react';

type SearchEngine = 'google' | 'bing' | 'duckduckgo';

const ENGINE_URLS: Record<SearchEngine, string> = {
    google: 'https://www.google.com/search?q=',
    bing: 'https://www.bing.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q='
};

/**
 * 搜索与导航逻辑 Hook
 * 职责：解析用户输入，判断是 URL 还是搜索关键词，并返回最终跳转地址
 */
export const useSearch = (defaultEngine: SearchEngine = 'bing') => {
    const [engine, setEngine] = useState<SearchEngine>(defaultEngine);

    /**
     * 解析用户输入
     * 逻辑：
     * 1. 如果是空，返回空
     * 2. 如果符合 URL 格式（带协议、www开头、或域名格式），补全协议
     * 3. 否则视为搜索关键词，拼接搜索引擎 URL
     */
    const parseInputToUrl = useCallback((input: string): string => {
        const target = input.trim();
        if (!target) return '';

        // 简单的 URL 格式检测正则
        const isUrl = /^(http|https):\/\/[^ "]+$/.test(target) || 
                      /^www\.[^ "]+$/.test(target) || 
                      /^[a-z0-9]+([\-\.]{1}[a-z0-9]+)*\.[a-z]{2,5}(:[0-9]{1,5})?(\/.*)?$/i.test(target);

        if (!isUrl) {
            // 视为搜索
            return `${ENGINE_URLS[engine]}${encodeURIComponent(target)}`;
        }

        // 补全协议
        if (!target.startsWith('http://') && !target.startsWith('https://')) {
            return `https://${target}`;
        }

        return target;
    }, [engine]);

    return {
        engine,
        setEngine,
        parseInputToUrl
    };
};