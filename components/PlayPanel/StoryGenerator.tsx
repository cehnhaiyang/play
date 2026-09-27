import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
    Sparkles,
    Upload,
    X,
    ArrowLeft,
    Loader2,
    AlertTriangle,
    Wand2,
    Images,
    ChevronDown,
    ChevronRight,
} from 'lucide-react';
import { generateStoryFromImages, toImageInput, AIBOOK_MAX_SOURCE_IMAGES } from '../../services/AiService';
import { generateId } from '../../utils/utils';
import type { AiStory } from '../../meta';

/**
 * 生成器里的一张待用图片。
 *
 * 这个结构只服务于生成器的增删与回收，所以就近定义在本文件：
 * 它是组件内部状态，不是跨模块契约。
 */
export interface StoryPageSource {
    /** 页面唯一 id（生成器里用于增删排序） */
    id: string;
    /** 原始文件；从 .aibook 导入时为 null */
    file: File | null;
    /** 显示用 URL（blob:） */
    url: string;
}

/** 用 File 造一个生成器页面源 */
export const createStoryPageSource = (file: File): StoryPageSource => ({
    id: generateId(),
    file,
    url: URL.createObjectURL(file),
});

/** 释放生成器页面源占用的 Blob URL */
export const revokeStoryPageSource = (source: StoryPageSource): void => {
    try {
        if (source.url && source.url.startsWith('blob:')) URL.revokeObjectURL(source.url);
    } catch {
        // 已释放或非法 URL：忽略
    }
};

interface StoryGeneratorProps {
    /** 生成完成：把故事与图片交给播放器成组入列 */
    onComplete: (story: AiStory, sources: StoryPageSource[]) => void;
    /** 返回媒体浏览 */
    onClose: () => void;
}

/**
 * AI 绘本故事家 —— 上传一组图片，让模型串成一个故事。
 *
 * 顺序即叙事顺序，因此网格支持删除但**不支持拖拽重排**：
 * 用户按故事顺序命名/挑选图片是更自然的做法，而重排在触屏上实现成本高、
 * 收益低（真要改顺序，删掉再加一次即可）。
 */
export const StoryGenerator: React.FC<StoryGeneratorProps> = ({ onComplete, onClose }) => {
    const [sources, setSources] = useState<StoryPageSource[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showStyle, setShowStyle] = useState(false);
    const [styleInstruction, setStyleInstruction] = useState('');
    // 空态那块投放区写着「或直接拖入」，但此前没有任何拖拽处理：
    // 拖进来的图片会被 Electron 当成导航目标直接打开。这里把承诺兑现。
    const [isDragging, setIsDragging] = useState(false);
    const dragDepthRef = useRef(0);

    const fileInputRef = useRef<HTMLInputElement>(null);

    // 卸载时统一回收 Blob URL：组件在生成成功后会立刻被卸载，
    // 此时 URL 已被播放列表接管（同一批 blob: 仍在使用），
    // 所以只在「还没交出去」的情况下释放。
    // sourcesRef 与 sources 同步维护，且**同步**写入（不靠 effect）：
    // 连续两次 addFiles 之间不会重渲染，靠 effect 回填的 ref 会读到旧值，
    // 导致第二次添加覆盖掉第一次的结果。
    const handedOffRef = useRef(false);
    const sourcesRef = useRef<StoryPageSource[]>([]);
    const commitSources = useCallback((next: StoryPageSource[]) => {
        sourcesRef.current = next;
        setSources(next);
    }, []);
    useEffect(() => () => {
        if (handedOffRef.current) return;
        sourcesRef.current.forEach(revokeStoryPageSource);
    }, []);

    const addFiles = useCallback((files: FileList | File[] | null) => {
        const list = Array.from(files || []).filter((f) => f && f.type.startsWith('image/'));
        if (list.length === 0) return;

        // 在 updater 之外算好再 setState：updater 必须是纯函数，
        // 在里面再调 setError 属于「渲染期改状态」，StrictMode 下会被重放
        const current = sourcesRef.current;
        const room = AIBOOK_MAX_SOURCE_IMAGES - current.length;
        if (room <= 0) {
            setError(`最多支持 ${AIBOOK_MAX_SOURCE_IMAGES} 张图片`);
            return;
        }
        const accepted = list.slice(0, room);
        setError(accepted.length < list.length
            ? `最多支持 ${AIBOOK_MAX_SOURCE_IMAGES} 张图片，已忽略多余的 ${list.length - accepted.length} 张`
            : null);
        commitSources([...current, ...accepted.map(createStoryPageSource)]);
    }, [commitSources]);

    const removeAt = useCallback((id: string) => {
        const target = sourcesRef.current.find((s) => s.id === id);
        if (target) revokeStoryPageSource(target);
        commitSources(sourcesRef.current.filter((s) => s.id !== id));
        setError(null);
    }, [commitSources]);

    const clearAll = useCallback(() => {
        sourcesRef.current.forEach(revokeStoryPageSource);
        commitSources([]);
        setError(null);
    }, [commitSources]);

    /* ---------------------------------------------------------------------- */
    /* 拖拽投放                                                                */
    /* ---------------------------------------------------------------------- */
    const hasFiles = (e: React.DragEvent) =>
        Array.from(e.dataTransfer?.types || []).includes('Files');

    const handleDragEnter = useCallback((e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        if (dragDepthRef.current === 1) setIsDragging(true);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        // 不阻止默认行为就不会触发 drop，浏览器会直接打开被拖入的文件
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        // 同 PlayPanel：dragleave 的 types 可能为空，不能拿 hasFiles 当守卫，
        // 否则计数器减不回去，提示层会一直挂着
        e.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDragging(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        setIsDragging(false);
        if (busy) return;
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) addFiles(files);
    }, [addFiles, busy]);

    // 拖出窗口 / 取消拖拽时 drop 不触发，靠窗口级兜底收尾
    useEffect(() => {
        const reset = () => {
            dragDepthRef.current = 0;
            setIsDragging(false);
        };
        const onWindowDragLeave = (e: DragEvent) => {
            if (e.relatedTarget === null) reset();
        };
        window.addEventListener('drop', reset);
        window.addEventListener('dragend', reset);
        window.addEventListener('dragleave', onWindowDragLeave);
        return () => {
            window.removeEventListener('drop', reset);
            window.removeEventListener('dragend', reset);
            window.removeEventListener('dragleave', onWindowDragLeave);
        };
    }, []);

    const handleGenerate = useCallback(async () => {
        if (sources.length === 0 || busy) return;
        setBusy(true);
        setError(null);
        try {
            // 只送有原始 File 的页：没有字节就无从编码成模型入参
            const usable = sources.filter((s): s is StoryPageSource & { file: File } => !!s.file);
            if (usable.length === 0) throw new Error('没有可用的图片');
            const images = await Promise.all(usable.map((s) => toImageInput(s.file)));
            const story = await generateStoryFromImages(images, styleInstruction.trim());
            // 交给播放列表接管：置位后再卸载就不会误回收这批 Blob URL
            handedOffRef.current = true;
            onComplete(story, usable);
        } catch (err) {
            setError(err instanceof Error ? err.message : '生成失败');
        } finally {
            setBusy(false);
        }
    }, [sources, busy, styleInstruction, onComplete]);

    return (
        <div
            className="absolute inset-0 z-40 bg-slate-950 overflow-y-auto custom-scrollbar"
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* 拖拽提示层：整屏响应，覆盖在内容之上，pointer-events-none 以免自己吃掉 drop */}
            {isDragging && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-teal-950/70 backdrop-blur-sm pointer-events-none">
                    <div className="flex flex-col items-center gap-3 px-10 py-8 rounded-2xl border-2 border-dashed border-teal-400/60 bg-slate-950/70">
                        <Images className="w-8 h-8 text-teal-300" />
                        <span className="text-sm font-bold text-white">松开即可加入故事</span>
                        <span className="text-[11px] text-slate-400">
                            按拖入顺序排列 · 最多 {AIBOOK_MAX_SOURCE_IMAGES} 张
                        </span>
                    </div>
                </div>
            )}

            <div className="max-w-4xl mx-auto px-6 py-8 pb-20">
                <button
                    onClick={onClose}
                    disabled={busy}
                    className="mb-6 flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-slate-300 rounded-xl text-xs font-semibold transition border border-white/5"
                >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>返回媒体</span>
                </button>

                <div className="text-center mb-8">
                    <h2 className="text-2xl font-bold text-white flex items-center justify-center gap-2">
                        <Sparkles className="w-6 h-6 text-teal-400" />
                        <span>AI 绘本故事家</span>
                    </h2>
                    <p className="text-xs text-slate-400 mt-2">
                        上传一组照片，AI 会为您编织一个图文并茂的故事，并加入播放列表
                    </p>
                </div>

                <div className="bg-slate-900/60 border border-white/8 rounded-2xl p-5 flex flex-col gap-4">
                    {/* 图片网格 / 空态投放区 */}
                    {sources.length === 0 ? (
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={busy}
                            className={`w-full py-14 rounded-xl border-2 border-dashed transition flex flex-col items-center justify-center gap-2 ${isDragging
                                ? 'border-teal-400/70 bg-teal-500/10 text-teal-200'
                                : 'border-white/12 hover:border-teal-500/50 hover:bg-teal-500/5 text-slate-400 disabled:opacity-40'
                                }`}
                        >
                            <Upload className="w-7 h-7 opacity-60" />
                            <span className="text-sm font-semibold text-slate-200">点击上传图片序列，或直接拖入</span>
                            <span className="text-[11px]">支持多选 · 顺序即叙事顺序 · 最多 {AIBOOK_MAX_SOURCE_IMAGES} 张</span>
                        </button>
                    ) : (
                        <>
                            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2.5">
                                {sources.map((s, i) => (
                                    <div key={s.id} className="relative aspect-square rounded-xl overflow-hidden border border-white/10 bg-black group">
                                        <img src={s.url} alt={`第 ${i + 1} 页`} className="w-full h-full object-cover" />
                                        {/* 序号用不透明底：压在浅色图片上时半透明底会糊掉看不清 */}
                                        <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded-md bg-black/80 backdrop-blur text-[10px] font-mono font-bold text-teal-300 border border-white/10">
                                            #{i + 1}
                                        </span>
                                        <button
                                            onClick={() => removeAt(s.id)}
                                            disabled={busy}
                                            className="absolute top-1 right-1 p-1 rounded-md bg-black/80 hover:bg-rose-600/90 disabled:opacity-40 text-white/80 hover:text-white transition sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                                            title={`移除第 ${i + 1} 张`}
                                            aria-label={`移除第 ${i + 1} 张`}
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={busy}
                                    className={`aspect-square rounded-xl border-2 border-dashed transition flex flex-col items-center justify-center gap-1 disabled:opacity-40 ${isDragging
                                        ? 'border-teal-400/70 bg-teal-500/10 text-teal-200'
                                        : 'border-white/12 hover:border-teal-500/50 hover:bg-teal-500/5 text-slate-500 hover:text-teal-300'
                                        }`}
                                    title="添加更多图片"
                                >
                                    <Upload className="w-5 h-5" />
                                    <span className="text-[10px]">添加更多</span>
                                </button>
                            </div>

                            {/* 统计与清空 */}
                            <div className="flex items-center justify-between text-[11px] text-slate-500">
                                <span className="flex items-center gap-1.5">
                                    <Images className="w-3.5 h-3.5" />
                                    共 {sources.length} 张 · 将生成 {sources.length} 页故事
                                </span>
                                <button
                                    onClick={clearAll}
                                    disabled={busy}
                                    className="hover:text-rose-400 disabled:opacity-40 transition"
                                >
                                    清空
                                </button>
                            </div>
                        </>
                    )}

                    {/* 自定义故事风格（默认收起，避免干扰主流程） */}
                    <div className="border-t border-white/8 pt-3">
                        <button
                            onClick={() => setShowStyle((v) => !v)}
                            aria-expanded={showStyle}
                            className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200 transition"
                        >
                            {showStyle ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            <span>自定义故事风格（可选）</span>
                        </button>
                        {showStyle && (
                            <>
                                <textarea
                                    value={styleInstruction}
                                    onChange={(e) => setStyleInstruction(e.target.value)}
                                    disabled={busy}
                                    rows={3}
                                    aria-label="自定义故事风格"
                                    placeholder="例如：用冷峻的硬汉侦探口吻叙述，短句为主，带黑色幽默……（留空则用默认风格）"
                                    className="mt-2 w-full px-3 py-2 bg-black/40 border border-white/10 rounded-xl text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-teal-500/50 resize-y disabled:opacity-50 transition"
                                />
                                {/* 说清楚它替换的是什么：这段文字会顶掉默认人设，
                                    而不是叠加上去，否则用户会以为风格是「附加」的 */}
                                <p className="mt-1.5 text-[10.5px] text-slate-500 leading-4">
                                    这段描述会作为系统人设发送，替代默认的故事风格；画面忠实度与不回避的要求始终生效。
                                </p>
                            </>
                        )}
                    </div>

                    {/* 生成按钮 */}
                    <button
                        onClick={handleGenerate}
                        disabled={sources.length === 0 || busy}
                        className="w-full py-3 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:bg-white/5 disabled:text-slate-500 disabled:cursor-not-allowed text-white text-sm font-bold transition shadow-lg shadow-teal-600/20 flex items-center justify-center gap-2"
                    >
                        {busy ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span>AI 正在构思剧情…</span>
                            </>
                        ) : (
                            <>
                                <Wand2 className="w-4 h-4" />
                                <span>开始创作故事</span>
                            </>
                        )}
                    </button>

                    {error && (
                        <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-[11px] leading-relaxed">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span className="break-all">{error}</span>
                        </div>
                    )}
                </div>

                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    onChange={(e) => {
                        addFiles(e.target.files);
                        e.target.value = '';
                    }}
                    className="hidden"
                />
            </div>
        </div>
    );
};

export default StoryGenerator;
