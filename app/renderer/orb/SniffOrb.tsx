import { useCallback, useEffect, useMemo, useState } from 'react';
import { OrbShell } from './OrbShell';
import { RadarIcon } from './icons';
import {
    bridge,
    bridgeConnected,
    downloadMedia,
    onBridgeEvent,
    onBridgeStatus,
    pushToPlayer,
    SOURCE_LABEL,
} from './bridge-client';
import type { SniffedMedia } from './bridge-client';
import { isLinkFromPage, isPlayableMedia, requiresFfmpeg } from '../../../shared/core';
import type { MediaType, PlayMediaItem } from '../../../shared/meta';

/**
 * 嗅探球。
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
 * ## 关掉嗅探时列表仍显示
 *
 * 这是有意的：用户关掉总开关往往正是为了**停下来看已经抓到的那些**。
 * 清空是另一个显式动作。
 *
 * ## 按页面分组
 *
 * 插件的列表是**所有标签页混在一起**的一份（`pageUrl` 是唯一能把它们分开的
 * 字段）。平铺着画会有两个后果：看不出某条是哪个页面来的，以及一旦换个页面
 * 就以为"只嗅探了第一个页面" —— 实际上每条都带着自己的 pageUrl。
 * 所以这里按 pageUrl 分组，最近的页面排在最前。
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

export const SniffOrb = () => {
    const [enabled, setEnabled] = useState(false);
    const [items, setItems] = useState<SniffedMedia[]>([]);
    const [error, setError] = useState('');
    const [connected, setConnected] = useState(true);
    const [busy, setBusy] = useState(false);
    /** 页内扫描或 AI 分析在途。与 busy 分开：那两个可能几秒到几十秒，要给得出反馈 */
    const [scanning, setScanning] = useState('');
    const [filter, setFilter] = useState<MediaType | 'all'>('all');
    /** 「仅当前页」：勾上之后只画活动标签页来的条目 */
    const [currentOnly, setCurrentOnly] = useState(false);
    /** 当前活动标签页地址。它是「仅当前页」与「清空当前页」的判据 */
    const [activePage, setActivePage] = useState('');

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

    /*
     * 当前活动标签页。
     *
     * 「仅当前页」筛选与「清空当前页」都要它，而它是**浏览器侧的事实**，
     * 只能问插件。没有这一条的话，那两个功能就只能退化成"用户自己看地址"。
     *
     * 桥连上、开关变化时各问一次：用户切标签页时不会通知球（球不在页面里），
     * 所以只能在这些时刻刷新 —— 刷新频率够用，而轮询一个窗口状态是纯浪费。
     */
    useEffect(() => {
        if (!connected) return;
        void (async () => {
            try {
                const info = await bridge<{ pageUrl: string }>('sniffer-active-page');
                setActivePage(info.pageUrl || '');
            } catch {
                // 问不到就当作"没有当前页"：筛选与清空都会退回"全部"，
                // 而不是拿着一个过期的地址去清错页面
                setActivePage('');
            }
        })();
    }, [connected, enabled]);

    /* 实时接收新结果。组件卸载时监听器随之消失 */
    useEffect(() => onBridgeEvent((event, payload) => {
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
    }), []);

    const toggle = useCallback(async () => {
        const next = !enabled;
        setError('');
        setBusy(true);
        try {
            await bridge('sniffer-set-enabled', { enabled: next });
            setEnabled(next);
            setConnected(true);
            // 打开开关时插件会顺手扫一次当前页，那批结果走事件推过来，
            // 所以这里不必再拉一次全量
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setConnected(await bridgeConnected());
        } finally {
            setBusy(false);
        }
    }, [enabled]);

    /**
     * 手动嗅探一次。
     *
     * 与"持续嗅探"开关无关：开关关着时点它也只扫这一次，网络层不会因此
     * 开始推送。扫的是页内那几条路（DOM / Performance / `__playinfo__` / 源码正则），
     * 结果由插件推事件回来 —— 所以这里只负责等，不负责取。
     */
    const scan = useCallback(async (kind: 'sniffer-scan' | 'sniffer-ai-scan') => {
        setError('');
        setScanning(kind === 'sniffer-scan' ? '正在扫描页面…' : 'AI 正在分析页面…');
        try {
            const result = await bridge<{ added: number }>(kind);
            setConnected(true);
            if (result.added === 0) {
                setError(kind === 'sniffer-scan'
                    ? '这次扫描没有发现新的媒体地址（页面可能没有可嗅探的内容，或该页面不允许注入）。'
                    : 'AI 没有从页面里找出新的媒体地址。');
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setConnected(await bridgeConnected());
        } finally {
            setScanning('');
        }
    }, []);

    const clear = useCallback(async () => {
        setError('');
        try {
            await bridge('sniffer-clear');
            setItems([]);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    /** 清掉当前页面来的条目。判据在插件侧与「仅当前页」共用一份（isLinkFromPage） */
    const clearCurrentPage = useCallback(async () => {
        setError('');
        try {
            const result = await bridge<{ removed: number }>('sniffer-clear-page', {
                pageUrl: activePage || undefined,
            });
            /*
             * 本地同步删掉同一批。
             *
             * 插件不会为"被清掉的条目"推事件（推送只表示"发现了新的"），
             * 所以不在这里删的话，界面上会一直显示已经不在列表里的东西 ——
             * 用户再点一次"清空当前页"会得到"没有可清的了"，而列表还在。
             */
            setItems((prev) => prev.filter((item) => !isLinkFromPage(item, activePage)));
            if (result.removed === 0) setError('当前页面没有可清空的条目。');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [activePage]);

    /**
     * 下载。
     *
     * 分岔在 `bridge-client.ts` 的 `downloadMedia` 里：直链交给浏览器
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

    /* 筛选。两个条件是"与"关系：类型筛 + 范围筛 */
    const filtered = useMemo(() => {
        let list = items;
        if (currentOnly && activePage) list = list.filter((item) => isLinkFromPage(item, activePage));
        if (filter !== 'all') list = list.filter((item) => item.type === filter);
        return list;
    }, [items, filter, currentOnly, activePage]);

    const groups = useMemo(() => groupByPage(filtered), [filtered]);
    const pageCount = useMemo(() => new Set(items.map((item) => item.pageUrl || '')).size, [items]);

    const toolbar = (
        <>
            <button
                type="button"
                onClick={() => void scan('sniffer-scan')}
                disabled={!!scanning || busy}
                className="shrink-0 rounded-lg bg-white/[0.06] px-2 py-1 text-[10px] font-medium text-slate-300 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-40"
            >
                嗅探
            </button>
            <button
                type="button"
                onClick={() => void scan('sniffer-ai-scan')}
                disabled={!!scanning || busy}
                title="把页面源码交给模型，让它挑出结构化资源（比扫描慢，但能找出页面里没写的直链）"
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
                        : `${items.length} 条 / ${pageCount} 个页面`
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
                    <span className="mx-1 h-3 w-px bg-white/10" />
                    <button
                        type="button"
                        onClick={() => setCurrentOnly((v) => !v)}
                        title={activePage || '当前没有可识别的页面'}
                        className={`rounded px-1.5 py-0.5 text-[10px] transition ${
                            currentOnly
                                ? 'bg-sky-500/25 text-sky-200'
                                : 'text-slate-500 hover:bg-white/[0.06] hover:text-slate-300'
                        }`}
                    >
                        仅当前页
                    </button>
                    <button
                        type="button"
                        onClick={() => void clearCurrentPage()}
                        disabled={!activePage}
                        className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:text-rose-300 disabled:opacity-30"
                    >
                        清空当前页
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
                            ? '正在记录浏览中出现的视频、音频与流媒体地址。点「嗅探」可以立刻扫一遍当前页面。'
                            : '嗅探默认关闭。点「嗅探」扫一次当前页面，或打开「持续」让它自动记录。')
                        : '当前筛选条件下没有条目。'}
                </p>
            ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                    {groups.map((group) => (
                        <section key={group.pageUrl || '(unknown)'}>
                            {/*
                              页面标题条。吸附在顶部：列表长了之后滚动时
                              始终知道下面这些条目属于哪个页面。
                            */}
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
