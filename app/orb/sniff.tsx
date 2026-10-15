import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { MediaSourceChannel, MediaType, PlayMediaItem } from '../../shared/meta';
import { isFromTab, isPlayableMedia, requiresFfmpeg, withoutTab } from '../../shared/core';
import {
    bridge,
    bridgeConnected,
    downloadMedia,
    onBridgeEvent,
    onBridgeStatus,
    OrbShell,
    pushToPlayer,
    RadarIcon,
} from './orb-kit';
import type { BrowserTab, SniffedMedia } from './orb-kit';

/**
 * 嗅探球窗口：入口 + 列表面板。
 *
 * ## 它不自己存一份数据
 *
 * 嗅探结果的唯一权威是插件的 service worker（落 `chrome.storage.session`）。
 * 这个球只做三件事：订阅推送、打开时取一次全量、把用户操作转成桥请求。
 *
 * 球是**全局唯一**的一个（Electron 窗口，不是每个标签页一份），所以"多份
 * 列表互相漂移"这个问题从根上没有了 —— 这是从 content script 改成
 * 独立窗口之后顺带拿到的最大好处。
 *
 * ## 作用域是"浏览器里打开的全部标签页"
 *
 * 嗅探不区分标签页：任何标签页里出现的媒体都会被收进来，包括后台那些。
 * 球这边的**筛选轴是标签页**（顶部标签栏），而不是"当前页"——
 * "当前"是浏览器里那个会随时变的状态，球拿到的永远是快照，
 * 用户切一下标签页界面就过期了。
 *
 * 所以判据用 `SniffedMedia.tabIds`（`isFromTab`）：标签页 id 是稳定的身份，
 * 导航之后不变。拿 pageUrl 当筛选键会在页面跳转的那一刻把选中的标签页弄丢。
 *
 * ## 关掉嗅探时列表仍显示
 *
 * 这是有意的：用户关掉总开关往往正是为了**停下来看已经抓到的那些**。
 * 清空是另一个显式动作。
 *
 * ## 列表内仍按页面分组
 *
 * 一个标签页可以导航（点进第二页），那时它名下的资源来自两个页面地址。
 * 平铺着画会看不出某条是导航前还是导航后来的，所以组内再按 pageUrl 分组。
 *
 * 共用件（外壳、桥、图标）在 `orb-kit.tsx`。
 */

/** 列表渲染上限。与插件的 SNIFF_RENDER_MAX 同一口径，超出的不画 */
const RENDER_MAX = 300;

/**
 * 类型筛选项。与旧实现（`useBrowse.ts` 的 `SNIFF_FILTER_OPTIONS`）同一份清单。
 *
 * `document` 不在里面：它不是"可播放的媒体"，混进来只会让筛选栏多一个
 * 几乎永远为空的档位。这是产品决定，不是遗漏。
 */
const FILTERS: { value: MediaType | 'all'; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'stream', label: '流媒体' },
    { value: 'video', label: '视频' },
    { value: 'audio', label: '音频' },
    { value: 'image', label: '图片' },
];

/**
 * 嗅探来源的角标文案。
 *
 * 三个来源对用户有实质区别：`network` 是页面真的请求过的（一定能下），
 * `local` 是页内扫描找到的地址，`ai` 是模型从源码里挑的（**可能是猜的**）。
 * 不标出来的话，用户分不清"这条下载失败"是站点的问题还是模型编的地址。
 */
const SOURCE_LABEL: Record<MediaSourceChannel, string> = {
    network: '网络',
    local: '页面',
    ai: 'AI',
};

/** 一组：同一个页面来的结果 */
interface PageGroup {
    pageUrl: string;
    items: SniffedMedia[];
}

/**
 * 把结果按 pageUrl 分组。
 *
 * 组内保持原顺序（已经按发现时间倒序），组之间按**组内最新一条**的时间倒序 ——
 * 刚打开的那个页面自然排到最上面，用户不必在十几个页面里找。
 */
const groupByPage = (items: SniffedMedia[]): PageGroup[] => {
    const groups = new Map<string, SniffedMedia[]>();
    for (const item of items) {
        // 没有 pageUrl 的归到一个空串组里，标题显示"未知来源"。
        // 不丢：那种条目仍然可下载，丢掉等于用户看不见自己抓到的资源
        const key = item.pageUrl || '';
        const list = groups.get(key);
        if (list) list.push(item);
        else groups.set(key, [item]);
    }

    return [...groups.entries()]
        .map(([pageUrl, group]) => ({ pageUrl, items: group }))
        .sort((a, b) => (b.items[0]?.foundAt ?? 0) - (a.items[0]?.foundAt ?? 0));
};

/** 页面地址压成一行可读的标题：只留 host + 最后一段路径 */
const shortenPage = (pageUrl: string): string => {
    if (!pageUrl) return '未知来源';
    try {
        const u = new URL(pageUrl);
        const tail = u.pathname.split('/').filter(Boolean).pop() || '';
        return tail ? `${u.host}/${tail}` : u.host;
    } catch {
        return pageUrl;
    }
};

/** 标签栏上那一条的文案。标题常常为空（页面还在加载），那就退回域名 */
const tabLabel = (tab: BrowserTab): string => {
    if (tab.title) return tab.title;
    try {
        return new URL(tab.url).host;
    } catch {
        return tab.url || `标签页 ${tab.id}`;
    }
};

const SniffOrb = () => {
    const [enabled, setEnabled] = useState(false);
    const [items, setItems] = useState<SniffedMedia[]>([]);
    const [tabs, setTabs] = useState<BrowserTab[]>([]);
    /** 标签栏拉取失败的原因。空串表示没失败 */
    const [tabsError, setTabsError] = useState('');
    const [error, setError] = useState('');
    const [connected, setConnected] = useState(true);
    const [busy, setBusy] = useState(false);
    /** 页内扫描或 AI 分析在途。与 busy 分开：那两个可能几秒到几十秒，要给得出反馈 */
    const [scanning, setScanning] = useState('');
    const [filter, setFilter] = useState<MediaType | 'all'>('all');
    /**
     * 选中的标签页。
     *
     * `null` = 全部标签页。存 **id** 而不是 url：标签页导航之后 url 会变，
     * 而用户选的是"那个标签页"，不是"那个地址"。
     */
    const [activeTabId, setActiveTabId] = useState<number | null>(null);

    /*
     * 桥的连接状态：查一次，之后跟着推送走。
     *
     * 只查一次是不够的 —— 应用通常比浏览器先起来，所以这里第一次问到的
     * 几乎总是"未连接"，而插件连上之后如果不更新，界面会永久挂着红字。
     */
    useEffect(() => {
        void (async () => setConnected(await bridgeConnected()))();
        return onBridgeStatus(setConnected);
    }, []);

    /*
     * 初始状态：从插件取。球可能刚开，而嗅探早就跑过了。
     *
     * **连上桥之后再取，且取成功时清掉上一次的错误。** 应用通常比浏览器先起，
     * 所以挂载那一刻这次请求多半会失败并留下一条"插件未连接"。桥随后连上时
     * 若不把它清掉，界面上会同时出现"已停止 · 2 条"和一句红色的
     * "插件未连接" —— 用户看到的是自相矛盾的两句话。
     */
    useEffect(() => {
        if (!connected) return;
        void (async () => {
            try {
                const state = await bridge<{ enabled: boolean; items: SniffedMedia[] }>('sniffer-get-state');
                setEnabled(state.enabled);
                setItems(state.items.slice(0, RENDER_MAX));
                setError('');
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        })();
    }, [connected]);

    /**
     * 标签栏的数据源。
     *
     * ## 为什么每次都重拉，而不是在本地维护一份
     *
     * "浏览器里开着哪些标签页"是**浏览器侧的事实**，球（Electron 窗口）
     * 无从得知。本地维护一份就意味着要自己处理新建、关闭、导航、窗口切换
     * 四种变化，而插件那边一条 `chrome.tabs.query` 就是准确答案。
     *
     * 触发点有两个：连上桥时拉一次，以及插件推 `tabs-changed` 时重拉
     * （见下面那个 effect）。
     *
     * ## 失败必须说出来，不能只是"标签栏没了"
     *
     * 这里原先把异常吞掉、`setTabs([])` 了事。后果实测过：**标签栏整条不画**
     * （渲染条件是 `tabs.length > 0`），而"浏览器里一个标签页都没有"和
     * "这个端点根本没通"在界面上长得一模一样 —— 都是什么都没有。
     * 用户看到的是"标签页没法切换"，且没有任何线索。
     *
     * 最常见的失败原因是插件没重载（`sniffer-tabs` 是新增端点，
     * 旧插件回"不认识的桥端点"），所以错误文案要把这条说出来。
     */
    const refreshTabs = useCallback(async () => {
        try {
            const result = await bridge<{ tabs: BrowserTab[] }>('sniffer-tabs');
            setTabs(result.tabs || []);
            setTabsError('');
        } catch (e) {
            setTabs([]);
            setTabsError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    useEffect(() => {
        if (!connected) return;
        void refreshTabs();
    }, [connected, refreshTabs]);

    /*
     * 实时接收新结果，以及"标签页集合变了"。
     *
     * 组件卸载时监听器随之消失。
     */
    useEffect(() => onBridgeEvent((event, payload) => {
        if (event === 'tabs-changed') {
            void refreshTabs();
            return;
        }
        if (event !== 'sniffed-media') return;
        const item = payload as SniffedMedia;
        /*
         * 按 URL 去重后再插入。
         *
         * 插件的去重窗口只有 5 秒，而同一个地址可能被三条路径先后发现
         * （网络层、页内扫描、AI）—— 间隔超过 5 秒就会各推一条。球这一层
         * 按 URL 合并，与插件侧的 `pushItem` 同一语义：列表里一个地址只出现一次。
         */
        setItems((prev) => {
            const index = prev.findIndex((existing) => existing.url === item.url);
            if (index < 0) return [item, ...prev].slice(0, RENDER_MAX);
            const next = [...prev];
            next[index] = { ...prev[index], ...item, foundAt: prev[index].foundAt };
            return next;
        });
    }), [refreshTabs]);

    /*
     * 选中的标签页被关掉之后，选中项必须回到「全部」。
     *
     * 不清的话筛选条件会指向一个不存在的 id：列表永远是空的，而标签栏上
     * 也看不出哪个是选中的（那一项已经没了）—— 用户看到的是"嗅探坏了"。
     */
    useEffect(() => {
        if (activeTabId === null) return;
        if (!tabs.some((tab) => tab.id === activeTabId)) setActiveTabId(null);
    }, [tabs, activeTabId]);

    const toggle = useCallback(async () => {
        const next = !enabled;
        setError('');
        setBusy(true);
        setScanning(next ? '正在扫描全部标签页…' : '');
        try {
            await bridge('sniffer-set-enabled', { enabled: next });
            setEnabled(next);
            setConnected(true);
            // 打开开关时插件会扫一遍全部标签页，那批结果走事件推过来，
            // 所以这里不必再拉一次全量
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setConnected(await bridgeConnected());
        } finally {
            setBusy(false);
            setScanning('');
        }
    }, [enabled]);

    /**
     * 手动嗅探一次。
     *
     * 与"持续嗅探"开关无关：开关关着时点它也只扫这一次，网络层不会因此
     * 开始推送。扫的是页内那几条路（DOM / Performance / `__playinfo__` / 源码正则），
     * 结果由插件推事件回来 —— 所以这里只负责等，不负责取。
     *
     * 扫的是**全部标签页**，与嗅探本身的作用域一致。
     */
    const scan = useCallback(async (kind: 'sniffer-scan' | 'sniffer-ai-scan') => {
        setError('');
        const isAi = kind === 'sniffer-ai-scan';
        setScanning(isAi ? 'AI 正在分析页面…' : '正在扫描全部标签页…');
        try {
            /*
             * AI 那条**只扫选中的那一个**（没选就是当前活动的）。
             *
             * 一次 AI 分析是一整份页面源码加一次模型往返；把几十个标签页
             * 一起发出去不是点一下按钮该有的后果，用户也没法知道钱花在哪。
             * 页内扫描是纯本地的，扫全部才符合"嗅探浏览器里的一切"。
             */
            const result = await bridge<{ added: number; scanned?: number }>(
                kind,
                isAi ? { tabId: activeTabId ?? undefined } : undefined,
            );
            setConnected(true);
            if (result.added === 0) {
                setError(isAi
                    ? 'AI 没有从页面里找出新的媒体地址。'
                    : '这次扫描没有发现新的媒体地址（页面可能没有可嗅探的内容，或该页面不允许注入）。');
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setConnected(await bridgeConnected());
        } finally {
            setScanning('');
        }
    }, [activeTabId]);

    const clear = useCallback(async () => {
        setError('');
        try {
            await bridge('sniffer-clear');
            setItems([]);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    /** 清掉选中标签页来的条目 */
    const clearActiveTab = useCallback(async () => {
        if (activeTabId === null) return;
        setError('');
        try {
            const result = await bridge<{ removed: number }>('sniffer-clear-tab', { tabId: activeTabId });
            /*
             * 本地同步删掉同一批。
             *
             * 插件不会为"被清掉的条目"推事件（推送只表示"发现了新的"），
             * 所以不在这里删的话，界面上会一直显示已经不在列表里的东西 ——
             * 用户再点一次会得到"没有可清的了"，而列表还在。
             *
             * 用 `withoutTab` 而不是整条过滤：别的标签页也请求过的地址只摘掉
             * 这个标签页的归属，条目本身留着 —— 整条删掉的话它在另一个标签页
             * 下也消失了，而那个标签页并没有被清。
             */
            setItems((prev) => prev.flatMap((item) => {
                const kept = withoutTab(item, activeTabId);
                return kept ? [kept] : [];
            }));
            if (result.removed === 0) setError('这个标签页没有可清空的条目。');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [activeTabId]);

    /**
     * 关闭一个浏览器标签页。
     *
     * 球上点 × 就该等于在浏览器里关掉它 —— 只从球上藏起来会让用户以为
     * 关掉了，而浏览器里那个标签页还在跑（还在嗅探、还在播视频）。
     *
     * 关掉之后**立刻重拉标签栏**，不等插件的 `tabs-changed` 事件：
     * 那条事件走 native messaging 回来要一个来回，而用户点完 × 就在等界面反应。
     */
    const closeTab = useCallback(async (tabId: number) => {
        setError('');
        try {
            await bridge('sniffer-close-tab', { tabId });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            await refreshTabs();
        }
    }, [refreshTabs]);

    /**
     * 下载。
     *
     * 分岔在 `orb-kit.tsx` 的 `downloadMedia` 里：直链交给浏览器
     * （Ctrl+J 能看到进度、能暂停续传），流媒体交给应用侧 ffmpeg。
     */
    const download = useCallback(async (item: SniffedMedia) => {
        setError('');
        setScanning(requiresFfmpeg(item.type, item.ext) ? '正在用 ffmpeg 下载…' : '');
        try {
            await downloadMedia(item);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setScanning('');
        }
    }, []);

    /**
     * 推进应用播放器。
     *
     * ## 与「下载」的区别
     *
     * 下载是**存下来**（浏览器 Ctrl+J 或应用 ffmpeg），推送是**现在就看** ——
     * 播放器直接播这个地址，不落盘。两条路都要有：想收藏的走下载，
     * 想立刻看/听的走推送。旧实现（`useBrowse.ts` 的 sniffer 面板）两样都有。
     *
     * ## 判据
     *
     * `isPlayableMedia` 挡掉文档、画廊占位、other —— 它们进播放列表只会是
     * 一条点了没反应的条目。判据与主窗口入列时用的是同一份（`shared/core`），
     * 这里先挡一道只是为了让提示说得出原因，不是第二套真值。
     */
    const push = useCallback(async (items: SniffedMedia[]) => {
        setError('');
        const playable = items.filter((item) => isPlayableMedia(item.type as MediaType));
        if (playable.length === 0) {
            setError('这些条目不是可播放的媒体（文档或未知类型），无法推送到播放器。');
            return;
        }
        const payload: PlayMediaItem[] = playable.map((item) => ({
            url: item.url,
            title: item.title,
            mediaType: item.type as MediaType,
            pageUrl: item.pageUrl,
        }));
        try {
            const sent = await pushToPlayer(payload);
            if (sent === 0) {
                setError('主窗口没有接收（应用主窗口可能还没打开）。');
                return;
            }
            if (sent < playable.length) {
                setError(`已推送 ${sent} 条，其余 ${playable.length - sent} 条已在播放列表里。`);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    /*
     * 筛选。两个条件是"与"关系：标签页筛 + 类型筛。
     *
     * 判据 `isFromTab` 与插件侧的「清空此标签页」是同一份 —— 界面上看得见的
     * 条目必须都能清掉，两处各写一份的后果实测过（那时判据是 pageUrl）。
     *
     * 不属于任何标签页的条目（SW 发起的请求、旧缓存）只在「全部」下出现。
     */
    const filtered = useMemo(() => {
        let list = items;
        if (activeTabId !== null) list = list.filter((item) => isFromTab(item, activeTabId));
        if (filter !== 'all') list = list.filter((item) => item.type === filter);
        return list;
    }, [items, filter, activeTabId]);

    const groups = useMemo(() => groupByPage(filtered), [filtered]);

    /**
     * 每个标签页名下有多少条。
     *
     * 一次算完（而不是每画一个标签页就 filter 一遍）：标签栏有几十项时，
     * 逐项过滤整个列表是 O(标签页数 × 条目数)。
     */
    const countByTab = useMemo(() => {
        const counts = new Map<number, number>();
        for (const item of items) {
            for (const id of item.tabIds || []) counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        return counts;
    }, [items]);

    const activeTab = activeTabId === null ? null : tabs.find((tab) => tab.id === activeTabId) || null;

    const toolbar = (
        <>
            <button
                type="button"
                onClick={() => void scan('sniffer-scan')}
                disabled={!!scanning || busy}
                title="扫描全部标签页的 DOM / Performance / 播放器全局对象与源码"
                className="shrink-0 rounded-lg bg-white/[0.06] px-2 py-1 text-[10px] font-medium text-slate-300 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-40"
            >
                嗅探
            </button>
            <button
                type="button"
                onClick={() => void scan('sniffer-ai-scan')}
                disabled={!!scanning || busy}
                title={activeTab
                    ? `把「${tabLabel(activeTab)}」的源码交给模型挑结构化资源`
                    : '把当前活动标签页的源码交给模型挑结构化资源（比扫描慢，但能找出页面里没写的直链）'}
                className="shrink-0 rounded-lg bg-white/[0.06] px-2 py-1 text-[10px] font-medium text-fuchsia-300 transition hover:bg-white/[0.12] disabled:opacity-40"
            >
                AI
            </button>
            <button
                type="button"
                onClick={() => void toggle()}
                disabled={busy || !!scanning}
                className={`shrink-0 rounded-lg px-2 py-1 text-[10px] font-bold transition ${
                    enabled
                        ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
                        : 'bg-white/[0.06] text-slate-400 hover:bg-white/[0.12] hover:text-slate-200'
                } disabled:opacity-40`}
            >
                {enabled ? '● 持续' : '○ 已停止'}
            </button>
        </>
    );

    return (
        <OrbShell
            label="资源嗅探"
            hint={
                !connected
                    ? '插件未连接'
                    : scanning
                        ? scanning
                        : `${items.length} 条 / ${tabs.length} 个标签页`
            }
            accent="from-sky-500 via-blue-500 to-indigo-400"
            icon={<RadarIcon className="h-6 w-6" />}
            toolbar={toolbar}
        >
            {!connected && (
                <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[10px] leading-relaxed text-amber-300">
                    没有连上浏览器插件。请确认：① 浏览器已打开；② 扩展已加载；
                    ③ 已跑过 <code className="font-mono">npm run host:install</code> 并重启过浏览器。
                </div>
            )}

            {/*
              两条横幅说的是同一件事，只留一条。
              `!connected` 那条已经写清了怎么办，此时再把请求失败的原文
              （"插件未连接。请确认浏览器已打开…"）也画出来，用户会看到
              上下两行几乎一样的话 —— 那会让人以为出了两个问题。
            */}
            {error && connected && (
                <div className="shrink-0 border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[10px] leading-relaxed text-rose-300">
                    {error}
                </div>
            )}

            {/*
              标签栏。**这是筛选轴**：点一项就只看那个标签页的资源，
              点 × 就在浏览器里关掉它。

              横向滚动而不是换行：几十个标签页换行会占掉面板一大半高度，
              而列表才是主角。滚动条隐藏（`scrollbar-hide` 见 orb.css），
              靠滚轮与拖拽浏览。

              「全部」那一项**始终画**，哪怕一个标签页都没有：它是"筛选轴存在"
              的可见标志。整条不画的话，用户分不清"这个功能没有"和"暂时没有
              标签页" —— 实测过一次，用户的原话是"我根本没看到怎么切换"。
            */}
            {connected && (
                <div className="scrollbar-hide flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.07] px-2 py-1.5">
                    <button
                        type="button"
                        onClick={() => setActiveTabId(null)}
                        title="显示全部标签页嗅到的资源"
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] transition ${
                            activeTabId === null
                                ? 'bg-sky-500/25 text-sky-200'
                                : 'text-slate-500 hover:bg-white/[0.06] hover:text-slate-300'
                        }`}
                    >
                        全部 {items.length}
                    </button>
                    {tabs.length === 0 && (
                        /*
                         * 拉不到标签页时**必须写出原因**。
                         *
                         * 最常见的失败是插件没重载（`sniffer-tabs` 是新增端点，
                         * 旧插件回"不认识的桥端点"）—— 那和"浏览器里真没标签页"
                         * 在界面上完全一样，都是空的一条。不说出来的话，用户只能
                         * 得出"标签页切换坏了"这一个（错的）结论。
                         */
                        <span
                            className="shrink-0 truncate px-1 text-[10px] text-amber-400/90"
                            title={tabsError || '浏览器里没有可嗅探的标签页（只列 http/https 页面）'}
                        >
                            {tabsError ? `标签栏不可用：${tabsError}` : '没有可嗅探的标签页'}
                        </span>
                    )}
                    {tabs.map((tab) => {
                        const selected = tab.id === activeTabId;
                        const count = countByTab.get(tab.id) ?? 0;
                        return (
                            /*
                             * 一项 = 选中按钮 + 关闭按钮，包在一个容器里。
                             *
                             * 不用一个按钮内嵌一个按钮：HTML 不允许按钮嵌套，
                             * React 会渲染出来但点击行为取决于浏览器，实测是
                             * 点 × 时两个 onClick 都触发（既切换又关闭）。
                             */
                            <span
                                key={tab.id}
                                className={`group/tab flex shrink-0 items-center rounded ${
                                    selected ? 'bg-sky-500/25' : 'hover:bg-white/[0.06]'
                                }`}
                            >
                                <button
                                    type="button"
                                    onClick={() => setActiveTabId(tab.id)}
                                    title={`${tab.url}\n${count} 条资源`}
                                    className={`max-w-[140px] truncate py-0.5 pl-1.5 text-[10px] transition ${
                                        selected ? 'text-sky-200' : 'text-slate-500 hover:text-slate-300'
                                    }`}
                                >
                                    {/* 活动标签页点一个圆点标出来：标题可能一样，位置不会 */}
                                    {tab.active && <span className="mr-1 text-emerald-400">•</span>}
                                    {tabLabel(tab)}
                                    {count > 0 && <span className="ml-1 font-mono text-[9px] text-slate-600">{count}</span>}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void closeTab(tab.id)}
                                    title="关闭这个浏览器标签页"
                                    aria-label={`关闭 ${tabLabel(tab)}`}
                                    className="shrink-0 py-0.5 pr-1.5 pl-0.5 text-[10px] text-slate-600 transition hover:text-rose-300"
                                >
                                    ×
                                </button>
                            </span>
                        );
                    })}
                </div>
            )}

            {/* 筛选栏。没有条目时不画：一排点了没反应的按钮比没有更让人困惑 */}
            {items.length > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-white/[0.07] px-2 py-1.5">
                    {FILTERS.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => setFilter(option.value)}
                            className={`rounded px-1.5 py-0.5 text-[10px] transition ${
                                filter === option.value
                                    ? 'bg-sky-500/25 text-sky-200'
                                    : 'text-slate-500 hover:bg-white/[0.06] hover:text-slate-300'
                            }`}
                        >
                            {option.label}
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={() => void clearActiveTab()}
                        disabled={activeTabId === null}
                        title={activeTabId === null
                            ? '先在标签栏里选中一个标签页'
                            : '清掉这个标签页嗅到的全部条目（不影响其它标签页）'}
                        className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:text-rose-300 disabled:opacity-30"
                    >
                        清空此标签页
                    </button>
                    <button
                        type="button"
                        onClick={() => void clear()}
                        className="rounded px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:text-rose-300"
                    >
                        清空全部
                    </button>
                </div>
            )}

            {/*
              批量推送。放在筛选栏下方而不是标题栏：标题栏只有 380px，
              已经塞了「嗅探 / AI / 持续 / 收起」四个按钮。
              推的是**当前筛选出来的**那批 —— 用户先筛出想要的范围再推，
              比"推全部"更接近实际用法，且不必先清空列表。
            */}
            {filtered.some((item) => isPlayableMedia(item.type as MediaType)) && (
                <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-2 py-1.5">
                    <span className="text-[10px] text-slate-500">
                        当前 {filtered.length} 条
                    </span>
                    <button
                        type="button"
                        onClick={() => void push(filtered)}
                        title="把当前筛选出的可播放条目全部送进应用播放器"
                        className="ml-auto rounded-lg bg-emerald-500/15 px-2 py-1 text-[10px] font-medium text-emerald-300 transition hover:bg-emerald-500/25"
                    >
                        全部推送到播放器
                    </button>
                </div>
            )}

            {filtered.length === 0 ? (
                <p className="p-4 text-[11px] leading-relaxed text-slate-500">
                    {items.length === 0
                        ? (enabled
                            ? '正在记录所有标签页里出现的视频、音频与流媒体地址。点「嗅探」可以立刻把每个标签页都扫一遍。'
                            : '嗅探默认关闭。点「嗅探」扫一遍全部标签页，或打开「持续」让它自动记录。')
                        : activeTabId !== null
                            ? '这个标签页还没有嗅到资源。'
                            : '当前筛选条件下没有条目。'}
                </p>
            ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                    {groups.map((group) => (
                        <section key={group.pageUrl || '(unknown)'}>
                            {/*
                              页面标题条。吸附在顶部：列表长了之后滚动时
                              始终知道下面这些条目属于哪个页面。

                              选中单个标签页时**不画它**：那个标签页的资源全在
                              同一个组里，一条和标签栏重复的标题条只是白占一行。
                            */}
                            {activeTabId === null && (
                                <h3
                                    className="sticky top-0 z-10 flex items-center gap-1.5 border-y border-white/[0.07] bg-slate-900/95 px-3 py-1 backdrop-blur-sm"
                                    title={group.pageUrl || '这条结果没有记录来源页面'}
                                >
                                    <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-slate-400">
                                        {shortenPage(group.pageUrl)}
                                    </span>
                                    <span className="shrink-0 font-mono text-[9px] text-slate-600">
                                        {group.items.length}
                                    </span>
                                </h3>
                            )}
                            <ul className="divide-y divide-white/5">
                                {group.items.map((item) => (
                                    <li key={item.url} className="group px-3 py-2 hover:bg-white/[0.04]">
                                        <div className="flex items-center gap-2">
                                            <span className="shrink-0 rounded bg-indigo-500/20 px-1 py-0.5 font-mono text-[9px] text-indigo-300">
                                                {item.ext}
                                            </span>
                                            {/*
                                              来源角标。三条采集路径的可信度不同：
                                              AI 挑出来的地址可能是编的，用户据此决定要不要点下载。
                                            */}
                                            <span
                                                className={`shrink-0 rounded px-1 py-0.5 text-[9px] ${
                                                    item.source === 'network'
                                                        ? 'bg-emerald-500/15 text-emerald-300/80'
                                                        : item.source === 'ai'
                                                            ? 'bg-fuchsia-500/15 text-fuchsia-300/80'
                                                            : 'bg-white/[0.06] text-slate-500'
                                                }`}
                                            >
                                                {SOURCE_LABEL[item.source] || item.source}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate text-[11px] text-slate-200" title={item.title}>
                                                {item.title}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => void push([item])}
                                                disabled={!isPlayableMedia(item.type as MediaType)}
                                                title={isPlayableMedia(item.type as MediaType)
                                                    ? '直接送进应用播放器播放（不落盘）'
                                                    : '不是可播放的媒体，无法推送'}
                                                className="shrink-0 rounded px-1.5 py-0.5 text-[9px] text-slate-500 opacity-0 transition group-hover:opacity-100 hover:text-emerald-300 disabled:opacity-0"
                                            >
                                                播放
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void download(item)}
                                                title={requiresFfmpeg(item.type, item.ext)
                                                    ? '用应用内的 ffmpeg 下载（流媒体）'
                                                    : '交给浏览器下载（Ctrl+J 可看进度）'}
                                                className="shrink-0 rounded px-1.5 py-0.5 text-[9px] text-slate-500 opacity-0 transition group-hover:opacity-100 hover:text-indigo-300"
                                            >
                                                下载
                                            </button>
                                        </div>
                                        <div className="mt-0.5 truncate font-mono text-[9px] text-slate-600" title={item.url}>
                                            {item.url}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            )}
        </OrbShell>
    );
};

/* ========================================================================== */
/* 入口                                                                        */
/* ========================================================================== */

/**
 * 不用 `StrictMode`：它会在开发模式下**故意双调用** effect，而球的每个 effect
 * 都在跟主进程/插件通信 —— 双调用意味着开两次面板、订阅两次事件、
 * 发两遍请求。生产构建里 StrictMode 不做这件事，所以这个代价只在开发时出现，
 * 而"开发时行为与生产不一致"本身就是最该避免的。
 *
 * 必须在组件定义之后：模块顶层立即执行，而 `SniffOrb` 是 `const`，
 * 提到前面会撞上暂时性死区。
 */
const container = document.getElementById('root');
if (container) createRoot(container).render(<SniffOrb />);
