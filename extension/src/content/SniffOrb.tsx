import { useCallback, useEffect, useState } from 'react';
import type { BallRequest, ExtensionResponse, SniffedMedia } from '../shared/protocol';
import { SNIFF_RENDER_MAX } from '../shared/protocol';
import { OrbShell } from './OrbShell';
import { RadarIcon } from './icons';

/**
 * 嗅探球。
 *
 * ## 它不自己存一份数据
 *
 * 嗅探结果的唯一权威是 service worker（落 `chrome.storage.session`）。这个球
 * 只做三件事：订阅推送、按当前状态取一次全量、把用户的操作转成消息。
 *
 * 之所以强调这一点：球是**每个标签页各有一份**的，而嗅探结果是全局的。
 * 球自己存一份的话，用户在同一站点开三个标签页就有三份会各自漂移的列表 ——
 * 而"哪个是真的"没有答案。统一从 SW 取，三份显示必然一致。
 *
 * ## 关掉嗅探时列表仍显示
 *
 * 这是有意的：用户关掉总开关往往正是为了**停下来看已经抓到的那些**。
 * 清空是另一个显式动作。
 */

/** 发一条消息给 service worker 并等回包。失败一律抛，由调用方决定怎么显示 */
export const askServiceWorker = async <T,>(message: BallRequest): Promise<T> => {
    const res = (await chrome.runtime.sendMessage(message)) as ExtensionResponse<T> | undefined;
    if (!res) throw new Error('后台无响应（service worker 可能刚被回收，重试一次）');
    if (!res.ok) throw new Error(res.error || '未知错误');
    return res.result as T;
};

export const SniffOrb = () => {
    const [enabled, setEnabled] = useState(false);
    const [items, setItems] = useState<SniffedMedia[]>([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    /* 初始状态：从 SW 取（它才是权威，球可能刚随页面注入） */
    useEffect(() => {
        void (async () => {
            try {
                const state = await askServiceWorker<{ enabled: boolean; items: SniffedMedia[] }>({
                    target: 'sw',
                    kind: 'sniffer-get-state',
                });
                setEnabled(state.enabled);
                setItems(state.items.slice(0, SNIFF_RENDER_MAX));
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        })();
    }, []);

    /* 实时接收新结果。球被销毁时监听器随之消失，不需要清理 storage */
    useEffect(() => {
        const onMessage = (message: { target?: string; kind?: string; item?: SniffedMedia }) => {
            if (message?.target === 'ball' && message.kind === 'sniffed-media' && message.item) {
                setItems((prev) => [message.item as SniffedMedia, ...prev].slice(0, SNIFF_RENDER_MAX));
            }
        };
        chrome.runtime.onMessage.addListener(onMessage);
        return () => chrome.runtime.onMessage.removeListener(onMessage);
    }, []);

    const toggle = useCallback(async () => {
        const next = !enabled;
        setError('');
        setBusy(true);
        try {
            await askServiceWorker({ target: 'sw', kind: 'sniffer-set-enabled', enabled: next });
            setEnabled(next);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [enabled]);

    const clear = useCallback(async () => {
        setError('');
        try {
            await askServiceWorker({ target: 'sw', kind: 'sniffer-clear' });
            setItems([]);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    /**
     * 交给浏览器下载。
     *
     * 不走应用侧的原因：直链交给 `chrome.downloads` 之后，用户在 Ctrl+J 里
     * 能看到进度、能暂停、能断点续传，这些浏览器已经做好了。需要 ffmpeg 的
     * 流媒体才会走应用 —— 那部分还没接桥。
     */
    const download = useCallback(async (item: SniffedMedia) => {
        setError('');
        try {
            await askServiceWorker({
                target: 'sw',
                kind: 'downloads-start',
                url: item.url,
                filename: item.title || undefined,
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    const toolbar = (
        <>
            <button
                type="button"
                onClick={() => void toggle()}
                disabled={busy}
                className={`shrink-0 rounded-lg px-2 py-1 text-[10px] font-bold transition ${
                    enabled
                        ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
                        : 'bg-white/[0.06] text-slate-400 hover:bg-white/[0.12] hover:text-slate-200'
                } disabled:opacity-40`}
            >
                {enabled ? '● 嗅探中' : '○ 已停止'}
            </button>
            <button
                type="button"
                onClick={() => void clear()}
                disabled={items.length === 0}
                className="shrink-0 rounded-lg px-2 py-1 text-[10px] text-slate-500 transition hover:text-slate-300 disabled:opacity-30"
            >
                清空
            </button>
        </>
    );

    return (
        <OrbShell
            storageKey="orbPos.sniff"
            ballSize={56}
            panelSize={{ w: 380, h: 520 }}
            label="资源嗅探"
            hint={enabled ? `正在记录 · ${items.length} 条` : `已停止 · ${items.length} 条`}
            accent="from-sky-500 via-blue-500 to-indigo-400"
            icon={<RadarIcon className="h-6 w-6" />}
            toolbar={toolbar}
        >
            {error && (
                <div className="shrink-0 border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[10px] leading-relaxed text-rose-300">
                    {error}
                </div>
            )}

            {items.length === 0 ? (
                <p className="p-4 text-[11px] leading-relaxed text-slate-500">
                    {enabled
                        ? '正在记录当前浏览中出现的视频、音频与流媒体地址。'
                        : '嗅探默认关闭。打开后，这里会列出页面加载过的媒体地址。'}
                </p>
            ) : (
                <ul className="min-h-0 flex-1 divide-y divide-white/5 overflow-y-auto">
                    {items.map((item) => (
                        <li key={item.url} className="group px-3 py-2 hover:bg-white/[0.04]">
                            <div className="flex items-center gap-2">
                                <span className="shrink-0 rounded bg-indigo-500/20 px-1 py-0.5 font-mono text-[9px] text-indigo-300">
                                    {item.ext}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[11px] text-slate-200" title={item.title}>
                                    {item.title}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => void download(item)}
                                    title="交给浏览器下载"
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
            )}
        </OrbShell>
    );
};
