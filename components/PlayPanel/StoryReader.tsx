import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Volume2, Pause, Loader2, BookOpen, ChevronLeft, ChevronRight } from 'lucide-react';
import { generateSpeech } from '../../services/AiService';
import type { VideoFile } from '../../meta';

interface StoryReaderProps {
    /** 当前页 */
    file: VideoFile;
    /** 同组全部页（按列表顺序），用于显示页码 */
    pages: VideoFile[];
    /** 语音合成结果写回当前条目，避免重复请求 */
    onCacheAudio: (fileId: string, base64: string) => void;
    /** 翻页：图片区两侧的热区需要它，否则读绘本时手得在图片与底栏之间来回跑 */
    onPrevPage: () => void;
    onNextPage: () => void;
}

/** Gemini TTS 输出固定为 24kHz 单声道 16bit PCM */
const TTS_SAMPLE_RATE = 24000;

/**
 * Base64 PCM(16bit LE) → AudioBuffer。
 *
 * 浏览器没有直接播 PCM 的能力，必须自己填 AudioBuffer。
 * 字节数为奇数时丢弃末尾半个采样，避免 Int16Array 越界读到脏数据。
 */
const pcmToAudioBuffer = (base64: string, ctx: AudioContext): AudioBuffer => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const sampleCount = Math.floor(bytes.length / 2);
    const samples = new Int16Array(bytes.buffer, 0, sampleCount);
    const buffer = ctx.createBuffer(1, sampleCount, TTS_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) channel[i] = samples[i] / 32768;
    return buffer;
};

/**
 * 绘本阅读器 —— 左图右文，带朗读。
 *
 * 与普通图片浏览的区别：图片只是「插图」，文案才是主体，
 * 因此采用 3:2 分栏而不是让图片独占视口；页码徽标也换成故事语境。
 */
export const StoryReader: React.FC<StoryReaderProps> = ({ file, pages, onCacheAudio, onPrevPage, onNextPage }) => {
    const [ttsBusy, setTtsBusy] = useState(false);
    const [ttsPlaying, setTtsPlaying] = useState(false);
    const [ttsError, setTtsError] = useState<string | null>(null);

    const ctxRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);

    const pageIndex = Math.max(0, pages.findIndex((p) => p.id === file.id));
    const text = file.description || '';

    // 停止当前朗读。组件卸载或翻页时必须调用，否则上一页的声音会继续念下去。
    const stop = useCallback(() => {
        if (sourceRef.current) {
            try { sourceRef.current.stop(); } catch { /* 已停止 */ }
            sourceRef.current = null;
        }
        setTtsPlaying(false);
    }, []);

    // 图片区两侧的翻页热区：翻页前先掐掉朗读，否则上一页的声音会跟着翻过去
    const prevPage = useCallback(() => {
        stop();
        onPrevPage();
    }, [stop, onPrevPage]);
    const nextPage = useCallback(() => {
        stop();
        onNextPage();
    }, [stop, onNextPage]);

    // 翻页/换书时中断朗读并清掉错误：新一页的报错不该继承上一页的
    useEffect(() => {
        stop();
        setTtsError(null);
    }, [file.id, stop]);

    // 卸载时释放 AudioContext（浏览器并发 AudioContext 数量有限，泄漏会拖垮后续朗读）
    useEffect(() => () => {
        if (sourceRef.current) {
            try { sourceRef.current.stop(); } catch { /* 已停止 */ }
            sourceRef.current = null;
        }
        const ctx = ctxRef.current;
        ctxRef.current = null;
        if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => { /* 忽略关闭失败 */ });
    }, []);

    const handleRead = useCallback(async () => {
        if (ttsPlaying) {
            stop();
            return;
        }
        if (!text.trim()) return;

        setTtsBusy(true);
        setTtsError(null);
        try {
            const ctx = ctxRef.current ?? new AudioContext();
            ctxRef.current = ctx;
            if (ctx.state === 'suspended') await ctx.resume();

            // 已缓存过的页直接播，不再打一次网络请求
            let base64 = file.audioData || '';
            if (!base64) {
                const generated = await generateSpeech(text);
                if (!generated) throw new Error('语音合成没有返回音频');
                base64 = generated;
                onCacheAudio(file.id, base64);
            }

            const buffer = pcmToAudioBuffer(base64, ctx);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.onended = () => {
                // 只有仍是当前 source 时才清状态：快速连点会先停旧的再起新的，
                // 旧 source 的 onended 迟到触发会把新播放的状态误清成「已停止」
                if (sourceRef.current === source) {
                    sourceRef.current = null;
                    setTtsPlaying(false);
                }
            };
            source.start();
            sourceRef.current = source;
            setTtsPlaying(true);
        } catch (err) {
            setTtsError(err instanceof Error ? err.message : '朗读失败');
            setTtsPlaying(false);
        } finally {
            setTtsBusy(false);
        }
    }, [ttsPlaying, stop, text, file.audioData, file.id, onCacheAudio]);

    return (
        <div className="w-full h-full flex min-h-0">
            {/* 左：插图。模糊底衬取自同一张图，避免大面积纯黑显得空洞 */}
            <div className="flex-[3] relative bg-black flex items-center justify-center min-w-0">
                <div
                    className="absolute inset-0 bg-cover bg-center opacity-20 blur-3xl"
                    style={{ backgroundImage: `url(${file.url})` }}
                    aria-hidden="true"
                />
                <img
                    src={file.url}
                    alt={file.groupName ? `${file.groupName} 第 ${pageIndex + 1} 页插图` : file.name}
                    referrerPolicy="no-referrer"
                    className="relative z-10 max-w-full max-h-full object-contain p-4 drop-shadow-2xl"
                />

                {/* 图片区的翻页热区：读绘本时手一直在图这边，不该为了翻页
                    每次把鼠标挪到底栏。左右各 18% 宽，中间留空避免误触。 */}
                {pageIndex > 0 && (
                    <button
                        onClick={prevPage}
                        aria-label="上一页"
                        title="上一页 (P / ←)"
                        className="absolute left-0 top-0 bottom-0 w-[18%] z-20 flex items-center justify-start pl-3 group/nav focus:outline-none focus-visible:bg-white/5"
                    >
                        <span className="p-2 rounded-full bg-black/50 backdrop-blur border border-white/10 text-white/70 group-hover/nav:text-white group-hover/nav:bg-black/70 opacity-0 group-hover/nav:opacity-100 focus-visible:opacity-100 transition">
                            <ChevronLeft className="w-5 h-5" />
                        </span>
                    </button>
                )}
                {pageIndex >= 0 && pageIndex < pages.length - 1 && (
                    <button
                        onClick={nextPage}
                        aria-label="下一页"
                        title="下一页 (N / →)"
                        className="absolute right-0 top-0 bottom-0 w-[18%] z-20 flex items-center justify-end pr-3 group/nav focus:outline-none focus-visible:bg-white/5"
                    >
                        <span className="p-2 rounded-full bg-black/50 backdrop-blur border border-white/10 text-white/70 group-hover/nav:text-white group-hover/nav:bg-black/70 opacity-0 group-hover/nav:opacity-100 focus-visible:opacity-100 transition">
                            <ChevronRight className="w-5 h-5" />
                        </span>
                    </button>
                )}
            </div>

            {/* 右：文案 */}
            <div className="flex-[2] min-w-[260px] bg-gradient-to-b from-slate-900 to-slate-950 border-l border-white/8 flex flex-col">
                <div className="px-6 py-4 border-b border-white/8 shrink-0">
                    <h2 className="text-base font-bold text-white mb-2 truncate" title={file.groupName}>
                        {file.groupName || '未命名故事'}
                    </h2>
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono tracking-widest text-teal-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
                            AI STORY
                        </span>
                        <span className="text-[10px] font-mono text-slate-400 tabular-nums">
                            第 {pageIndex + 1} / {pages.length} 页
                        </span>
                        {/* 朗读状态提到页眉：底部的按钮会随滚动内容变化，
                            而「这一页有没有语音」是阅读时的持续信息 */}
                        {file.audioData && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-mono text-indigo-300">
                                <Volume2 className="w-3 h-3" />
                                已缓存语音
                            </span>
                        )}
                    </div>
                </div>

                {/* data-text-select：外层点击处理器据此放行，划词不被当成「暂停」 */}
                <div className="flex-1 overflow-y-auto custom-scrollbar px-7 py-6 select-text" data-text-select>
                    <p className="text-[15px] leading-loose text-slate-300 whitespace-pre-wrap">
                        {text || '（本页暂无文案）'}
                    </p>
                </div>

                {/* 进度条：读完一页后不用回底栏也知道到哪了 */}
                <div className="px-6 pt-3 shrink-0">
                    <div className="h-1 rounded-full bg-white/8 overflow-hidden">
                        <div
                            className="h-full rounded-full bg-gradient-to-r from-teal-500 to-cyan-400 transition-[width] duration-300"
                            style={{ width: `${pages.length > 1 ? ((pageIndex + 1) / pages.length) * 100 : 100}%` }}
                        />
                    </div>
                </div>

                <div className="px-6 py-4 shrink-0">
                    <button
                        onClick={handleRead}
                        disabled={ttsBusy || !text.trim()}
                        className={`w-full py-3 rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 border disabled:opacity-40 disabled:cursor-not-allowed ${ttsPlaying
                            ? 'bg-rose-500/10 border-rose-500/40 text-rose-300 hover:bg-rose-500/20'
                            : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10'
                            }`}
                    >
                        {ttsBusy ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span>正在合成语音…</span>
                            </>
                        ) : ttsPlaying ? (
                            <>
                                <Pause className="w-4 h-4" />
                                <span>停止朗读</span>
                            </>
                        ) : (
                            <>
                                <Volume2 className="w-4 h-4" />
                                <span>{file.audioData ? '朗读本页（已缓存）' : '朗读故事'}</span>
                            </>
                        )}
                    </button>
                    {ttsError && (
                        <p role="alert" className="mt-2 text-[10.5px] leading-relaxed text-rose-300/90 break-all">{ttsError}</p>
                    )}
                    {!ttsError && !text.trim() && (
                        <p className="mt-2 text-[10.5px] text-slate-500 flex items-center gap-1">
                            <BookOpen className="w-3 h-3" />
                            本页没有文案，无法朗读
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default StoryReader;
