import { useCallback, useEffect, useState } from 'react';
import { OrbShell } from './OrbShell';
import { RadarIcon } from './icons';
import { bridge, bridgeConnected, onBridgeEvent, onBridgeStatus } from './bridge-client';
import type { SniffedMedia } from './bridge-client';

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
 */

/** 列表渲染上限。与插件的 SNIFF_RENDER_MAX 同一口径，超出的不画 */
const RENDER_MAX = 300;

export const SniffOrb = () => {
    const [enabled, setEnabled] = useState(false);
    const [items, setItems] = useState<SniffedMedia[]>([]);
    const [error, setError] = useState('');
    const [connected, setConnected] = useState(true);
    const [busy, setBusy] = useState(false);

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

    /* 实时接收新结果。组件卸载时监听器随之消失 */
    useEffect(() => onBridgeEvent((event, payload) => {
        if (event !== 'sniffed-media') return;
        setItems((prev) => [payload as SniffedMedia, ...prev].slice(0, RENDER_MAX));
    }), []);

    const toggle = useCallback(async () => {
        const next = !enabled;
        setError('');
        setBusy(true);
        try {
            await bridge('sniffer-set-enabled', { enabled: next });
            setEnabled(next);
            setConnected(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setConnected(await bridgeConnected());
        } finally {
            setBusy(false);
        }
    }, [enabled]);

    const clear = useCallback(async () => {
        setError('');
        try {
            await bridge('sniffer-clear');
            setItems([]);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    /**
     * 交给浏览器下载。
     *
     * 不走应用侧的原因：直链交给 `chrome.downloads` 之后，用户在 Ctrl+J 里
     * 能看到进度、能暂停、能断点续传，这些浏览器已经做好了。
     * 需要 ffmpeg 的流媒体才会走应用 —— 那部分还没接。
     */
    const download = useCallback(async (item: SniffedMedia) => {
        setError('');
        try {
            await bridge('downloads-start', { url: item.url, filename: item.title || undefined });
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
            label="资源嗅探"
            hint={
                !connected
                    ? '插件未连接'
                    : enabled
                        ? `正在记录 · ${items.length} 条`
                        : `已停止 · ${items.length} 条`
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

            {items.length === 0 ? (
                <p className="p-4 text-[11px] leading-relaxed text-slate-500">
                    {enabled
                        ? '正在记录浏览中出现的视频、音频与流媒体地址。'
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
