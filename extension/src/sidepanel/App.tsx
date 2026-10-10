import { useCallback, useEffect, useState } from 'react';
import type { PanelRequest, PanelResponse, SniffedMedia } from '../shared/protocol';

/**
 * 侧边栏面板：嗅探 / Cookie / 下载。
 *
 * 三块都是**浏览器原生能力**（阶段 2 的 A 类），不需要本机应用参与 ——
 * 所以这个面板在没有安装 The Play 应用时也能独立工作。
 *
 * 应用桥（native messaging）接上来之后，这里会多出"用本机播放器打开"
 * 与"交给 ffmpeg 下载"两个动作；现在不预埋按钮，避免点了没反应。
 */

/** 统一发消息。失败一律抛出，由调用方决定怎么显示 */
const send = async <T,>(message: PanelRequest): Promise<T> => {
    const res = (await chrome.runtime.sendMessage(message)) as PanelResponse<T> | undefined;
    if (!res) throw new Error('service worker 无响应（可能已被回收，重试一次）');
    if (!res.ok) throw new Error(res.error || '未知错误');
    return res.result as T;
};

type Tab = 'sniff' | 'cookies' | 'downloads';

export const App = () => {
    const [tab, setTab] = useState<Tab>('sniff');
    const [enabled, setEnabled] = useState(false);
    const [items, setItems] = useState<SniffedMedia[]>([]);
    const [error, setError] = useState('');

    /* 初始状态：从 service worker 取（它才是权威，面板可能刚被打开） */
    useEffect(() => {
        void (async () => {
            try {
                const state = await send<{ enabled: boolean; items: SniffedMedia[] }>({
                    kind: 'sniffer-get-state',
                });
                setEnabled(state.enabled);
                setItems(state.items);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        })();
    }, []);

    /* 实时接收新结果。面板关闭时监听器随之销毁，不需要清理 storage */
    useEffect(() => {
        const onMessage = (message: { kind?: string; item?: SniffedMedia }) => {
            if (message?.kind === 'sniffed-media' && message.item) {
                setItems((prev) => [message.item as SniffedMedia, ...prev].slice(0, 500));
            }
        };
        chrome.runtime.onMessage.addListener(onMessage);
        return () => chrome.runtime.onMessage.removeListener(onMessage);
    }, []);

    const toggleSniffer = useCallback(async () => {
        const next = !enabled;
        setError('');
        try {
            await send({ kind: 'sniffer-set-enabled', enabled: next });
            setEnabled(next);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [enabled]);

    const clear = useCallback(async () => {
        setError('');
        try {
            await send({ kind: 'sniffer-clear' });
            setItems([]);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    return (
        <div className="flex h-full w-full flex-col">
            <nav className="flex shrink-0 border-b border-white/10">
                {([['sniff', '嗅探'], ['cookies', 'Cookie'], ['downloads', '下载']] as const).map(
                    ([key, label]) => (
                        <button
                            key={key}
                            onClick={() => setTab(key)}
                            className={`flex-1 py-2 text-[11px] transition-colors ${
                                tab === key
                                    ? 'border-b-2 border-indigo-400 text-slate-100'
                                    : 'text-slate-500 hover:text-slate-300'
                            }`}
                        >
                            {label}
                        </button>
                    ),
                )}
            </nav>

            {error && (
                <div className="shrink-0 border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[10px] text-rose-300">
                    {error}
                </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
                {tab === 'sniff' && (
                    <SniffTab
                        enabled={enabled}
                        items={items}
                        onToggle={toggleSniffer}
                        onClear={clear}
                    />
                )}
                {tab === 'cookies' && <CookieTab />}
                {tab === 'downloads' && <DownloadTab />}
            </div>
        </div>
    );
};

/* ========================================================================== */
/* 嗅探                                                                       */
/* ========================================================================== */

const SniffTab = ({
    enabled,
    items,
    onToggle,
    onClear,
}: {
    enabled: boolean;
    items: SniffedMedia[];
    onToggle: () => void;
    onClear: () => void;
}) => (
    <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
            <button
                onClick={onToggle}
                className={`rounded px-2 py-1 text-[10px] font-bold transition-colors ${
                    enabled
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'bg-white/5 text-slate-400 hover:bg-white/10'
                }`}
            >
                {enabled ? '● 持续嗅探中' : '○ 已停止'}
            </button>
            <span className="text-[10px] text-slate-500">{items.length} 条</span>
            <button
                onClick={onClear}
                disabled={items.length === 0}
                className="ml-auto rounded px-2 py-1 text-[10px] text-slate-500 hover:text-slate-300 disabled:opacity-30"
            >
                清空
            </button>
        </div>

        {!enabled && items.length === 0 && (
            <p className="p-3 text-[10px] leading-relaxed text-slate-500">
                嗅探默认关闭。打开后，插件会记录当前浏览中出现的视频、音频与流媒体地址。
            </p>
        )}

        <ul className="divide-y divide-white/5">
            {items.map((item) => (
                <li key={item.url} className="px-3 py-2 hover:bg-white/3">
                    <div className="flex items-center gap-2">
                        <span className="rounded bg-indigo-500/20 px-1 py-0.5 font-mono text-[9px] text-indigo-300">
                            {item.ext}
                        </span>
                        <span className="truncate text-[11px] text-slate-200" title={item.title}>
                            {item.title}
                        </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[9px] text-slate-600" title={item.url}>
                        {item.url}
                    </div>
                </li>
            ))}
        </ul>
    </div>
);

/* ========================================================================== */
/* Cookie                                                                     */
/* ========================================================================== */

interface CookieRow {
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    session: boolean;
}

const CookieTab = () => {
    const [url, setUrl] = useState('');
    const [rows, setRows] = useState<CookieRow[]>([]);
    const [error, setError] = useState('');

    /** 默认填当前标签页地址：Tamper 的用法几乎总是"看我现在这个站" */
    useEffect(() => {
        void (async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.url) setUrl(tab.url);
        })();
    }, []);

    const load = useCallback(async () => {
        setError('');
        try {
            setRows(await send<CookieRow[]>({ kind: 'cookies-get', url }));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setRows([]);
        }
    }, [url]);

    const remove = useCallback(
        async (name: string) => {
            try {
                await send({ kind: 'cookies-remove', url, name });
                setRows((prev) => prev.filter((r) => r.name !== name));
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        },
        [url],
    );

    return (
        <div className="flex h-full flex-col">
            <div className="flex shrink-0 gap-1 border-b border-white/10 p-2">
                <input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com"
                    className="min-w-0 flex-1 rounded bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-200 outline-none placeholder:text-slate-600 focus:bg-white/10"
                />
                <button
                    onClick={load}
                    disabled={!url}
                    className="rounded bg-indigo-500/20 px-2 py-1 text-[10px] text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-30"
                >
                    读取
                </button>
            </div>

            {error && <p className="px-3 py-2 text-[10px] text-rose-300">{error}</p>}

            <ul className="divide-y divide-white/5">
                {rows.map((row) => (
                    <li key={`${row.domain}${row.path}${row.name}`} className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                            <span className="truncate font-mono text-[10px] text-amber-300">{row.name}</span>
                            {row.httpOnly && (
                                <span className="rounded bg-white/10 px-1 text-[8px] text-slate-400">HttpOnly</span>
                            )}
                            {row.secure && (
                                <span className="rounded bg-white/10 px-1 text-[8px] text-slate-400">Secure</span>
                            )}
                            <button
                                onClick={() => remove(row.name)}
                                className="ml-auto shrink-0 text-[9px] text-slate-600 hover:text-rose-400"
                            >
                                删除
                            </button>
                        </div>
                        <div className="truncate font-mono text-[9px] text-slate-500" title={row.value}>
                            {row.value}
                        </div>
                        <div className="truncate text-[9px] text-slate-600">
                            {row.domain}
                            {row.path}
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
};

/* ========================================================================== */
/* 下载                                                                       */
/* ========================================================================== */

interface DownloadRow {
    id: number;
    filename: string;
    url: string;
    state: string;
    paused: boolean;
    totalBytes: number;
    receivedBytes: number;
    error: string;
}

const formatBytes = (n: number): string => {
    if (!n) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const DownloadTab = () => {
    const [rows, setRows] = useState<DownloadRow[]>([]);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setError('');
        try {
            setRows(await send<DownloadRow[]>({ kind: 'downloads-list' }));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    useEffect(() => {
        void load();
        /*
         * 下载进度靠轮询而不是 chrome.downloads.onChanged：
         * 那个事件在 service worker 里要顶层注册（本面板不是 SW），
         * 且面板只在自己可见时才有意义 —— 轮询 1.5 秒足够，
         * 面板一关就停，不做无谓唤醒。
         */
        const timer = window.setInterval(() => void load(), 1500);
        return () => window.clearInterval(timer);
    }, [load]);

    const act = useCallback(
        async (id: number, action: 'pause' | 'resume' | 'cancel' | 'erase' | 'show') => {
            try {
                await send({ kind: 'downloads-action', id, action });
                await load();
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        },
        [load],
    );

    return (
        <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
                <span className="text-[10px] text-slate-500">{rows.length} 个任务</span>
                <button
                    onClick={load}
                    className="ml-auto rounded px-2 py-1 text-[10px] text-slate-500 hover:text-slate-300"
                >
                    刷新
                </button>
            </div>

            {error && <p className="px-3 py-2 text-[10px] text-rose-300">{error}</p>}

            <ul className="divide-y divide-white/5">
                {rows.map((row) => {
                    const percent = row.totalBytes > 0
                        ? Math.round((row.receivedBytes / row.totalBytes) * 100)
                        : null;
                    const name = row.filename.split(/[\\/]/).pop() || row.filename;
                    return (
                        <li key={row.id} className="px-3 py-2">
                            <div className="flex items-center gap-2">
                                <span className="truncate text-[11px] text-slate-200" title={row.filename}>
                                    {name}
                                </span>
                                <span className="ml-auto shrink-0 font-mono text-[9px] text-slate-500">
                                    {row.state === 'in_progress'
                                        ? `${percent === null ? '…' : `${percent}%`}`
                                        : row.state}
                                </span>
                            </div>

                            <div className="mt-1 flex items-center gap-2 text-[9px] text-slate-600">
                                <span>
                                    {formatBytes(row.receivedBytes)}
                                    {row.totalBytes > 0 ? ` / ${formatBytes(row.totalBytes)}` : ''}
                                </span>
                                <div className="ml-auto flex shrink-0 gap-2">
                                    {row.state === 'in_progress' && (
                                        <button
                                            onClick={() => act(row.id, row.paused ? 'resume' : 'pause')}
                                            className="hover:text-slate-300"
                                        >
                                            {row.paused ? '继续' : '暂停'}
                                        </button>
                                    )}
                                    {row.state === 'in_progress' && (
                                        <button
                                            onClick={() => act(row.id, 'cancel')}
                                            className="hover:text-rose-400"
                                        >
                                            取消
                                        </button>
                                    )}
                                    <button
                                        onClick={() => act(row.id, 'show')}
                                        className="hover:text-slate-300"
                                    >
                                        定位
                                    </button>
                                    {row.state !== 'in_progress' && (
                                        <button
                                            onClick={() => act(row.id, 'erase')}
                                            className="hover:text-rose-400"
                                        >
                                            移除
                                        </button>
                                    )}
                                </div>
                            </div>

                            {row.error && (
                                <div className="mt-0.5 text-[9px] text-rose-400">{row.error}</div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
};
