import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
    Maximize2,
    Minimize2,
    Repeat,
    Shuffle,
    Folder,
    FolderOpen,
    ChevronRight,
    ChevronDown,
    Library,
    Plus,
    Trash2,
    ArrowLeft,
    Link,
    Music,
    Image as ImageIcon,
    Sparkles,
    HelpCircle,
    Film,
    Tv,
    FileText,
    FileQuestion,
    X,
    PanelLeftClose,
    PanelLeftOpen,
    FastForward,
    Rewind,
    Radio,
    Archive,
    Repeat1,
    CircleStop,
} from 'lucide-react';
import { UsePlayReturn } from '../../hooks/usePlay';
import { PlaybackMode, ObjectFitMode, VideoFile, MediaType, getElectronAPI } from '../../meta';
import { isValidMediaUrl, resolveProbeMedia, fetchAcgRemainingPages } from '../../utils';
import {
    collectPackSources,
    packToGalleryBlob,
    sanitizePackName,
    unpackGalleryPack,
    isGalleryPackFile,
} from '../../utils/galleryPack';
import { ShortcutsModal } from './ShortcutsModal';

interface PlayPanelProps {
    player: UsePlayReturn;
    onBackToBrowse: () => void;
}

// 播放模式 / 画面比例中文标签：枚举值是英文（'List Loop'），直接展示会裸奔英文
const PLAYBACK_MODE_LABEL: Record<PlaybackMode, string> = {
    [PlaybackMode.ListLoop]: '列表循环',
    [PlaybackMode.SingleLoop]: '单曲循环',
    [PlaybackMode.Random]: '随机播放',
    [PlaybackMode.StopAfter]: '播完即停',
};
const OBJECT_FIT_LABEL: Record<ObjectFitMode, string> = {
    contain: '适应',
    cover: '填充',
    fill: '拉伸',
};
// 媒体类型中文标签：此前直接把 mediaType 小写拼进 UI（VIDEO/AUDIO/GALLERY），
// 中文界面里裸奔英文；这里统一口径，列表与顶部标题共用。
const MEDIA_TYPE_LABEL: Record<MediaType, string> = {
    video: '视频',
    stream: '流媒体',
    audio: '音频',
    image: '图片',
    document: '文档',
    gallery: '画廊',
    other: '其它',
};
const MEDIA_TYPE_ICON: Record<MediaType, React.ComponentType<{ className?: string }>> = {
    video: Film,
    stream: Radio,
    audio: Music,
    image: ImageIcon,
    document: FileText,
    gallery: Library,
    other: FileQuestion,
};
// 列表行图标配色：与顶部类型徽章、底部控制条保持同一套语义色
const MEDIA_TYPE_ACCENT: Record<MediaType, string> = {
    video: 'text-indigo-400',
    stream: 'text-sky-400',
    audio: 'text-pink-400',
    image: 'text-emerald-400',
    document: 'text-cyan-400',
    gallery: 'text-amber-400',
    other: 'text-slate-400',
};
// 格式化时间为 mm:ss 或 hh:mm:ss
const formatTime = (seconds: number) => {
    if (isNaN(seconds) || seconds < 0 || !Number.isFinite(seconds)) return '00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

/**
 * 现代专业视频播放器进度条组件
 * 支持：
 * 1. 拖拽快进时内部锁定状态，避免与播放器 timeupdate 产生回弹冲突（彻底解决无法快进）
 * 2. 真实已播放高亮槽、已缓冲进度槽、背景底槽三层视觉
 * 3. 鼠标悬停实时 Tooltip 预览时间气泡与刻度指示
 * 4. 移动端与桌面端点击、滑动平滑快进
 */
interface ProgressBarProps {
    currentTime: number;
    duration: number;
    bufferedEnd?: number;
    onSeek: (time: number) => void;
    disabled?: boolean;
    isLive?: boolean;
}

const ProgressBar: React.FC<ProgressBarProps> = ({
    currentTime,
    duration,
    bufferedEnd = 0,
    onSeek,
    disabled = false,
    isLive = false,
}) => {
    const barRef = useRef<HTMLDivElement>(null);
    const [isHovered, setIsHovered] = useState(false);
    const [hoverPosition, setHoverPosition] = useState<number | null>(null);
    const [isSeeking, setIsSeeking] = useState(false);
    const [seekPreviewTime, setSeekPreviewTime] = useState<number>(0);

    // 拖拽期间挂在 window 上的监听器回收句柄。
    // 只在 mouseup/touchend 里摘除是不够的：拖到一半切媒体会让进度条卸载，
    // 监听器会永久驻留并持有过期闭包，下一次松开鼠标就对已经切走的媒体 seek。
    const dragCleanupRef = useRef<(() => void) | null>(null);
    const endDrag = useCallback(() => {
        dragCleanupRef.current?.();
        dragCleanupRef.current = null;
    }, []);
    useEffect(() => () => dragCleanupRef.current?.(), []);

    // 确保 duration 是有效数值
    const validDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

    // 当前有效显示时间（拖拽快进中优先显示预览时间）
    const activeTime = isSeeking ? seekPreviewTime : currentTime;
    const progressPercent = validDuration > 0 ? Math.min(100, Math.max(0, (activeTime / validDuration) * 100)) : 0;
    const bufferedPercent = validDuration > 0 ? Math.min(100, Math.max(0, (bufferedEnd / validDuration) * 100)) : 0;

    const calculateTimeFromEvent = useCallback((clientX: number): number => {
        if (!barRef.current || validDuration <= 0) return 0;
        const rect = barRef.current.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return ratio * validDuration;
    }, [validDuration]);

    // 鼠标悬停位置计算
    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (disabled || isLive || validDuration <= 0) return;
        const time = calculateTimeFromEvent(e.clientX);
        setHoverPosition(time);
    }, [calculateTimeFromEvent, disabled, isLive, validDuration]);

    // 鼠标点击或拖拽开始
    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (disabled || isLive || validDuration <= 0) return;
        e.preventDefault();
        endDrag();
        const startTime = calculateTimeFromEvent(e.clientX);
        setIsSeeking(true);
        setSeekPreviewTime(startTime);

        const onGlobalMouseMove = (moveEvent: MouseEvent) => {
            const movedTime = calculateTimeFromEvent(moveEvent.clientX);
            setSeekPreviewTime(movedTime);
        };

        const onGlobalMouseUp = (upEvent: MouseEvent) => {
            const finalTime = calculateTimeFromEvent(upEvent.clientX);
            setIsSeeking(false);
            endDrag();
            onSeek(finalTime);
        };

        dragCleanupRef.current = () => {
            window.removeEventListener('mousemove', onGlobalMouseMove);
            window.removeEventListener('mouseup', onGlobalMouseUp);
        };
        window.addEventListener('mousemove', onGlobalMouseMove);
        window.addEventListener('mouseup', onGlobalMouseUp);
    }, [calculateTimeFromEvent, disabled, endDrag, isLive, onSeek, validDuration]);

    // 触控拖拽支持（以 touchend 落点为准，避免闭包旧值导致永远回到起点）
    const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
        if (disabled || isLive || validDuration <= 0 || !e.touches[0]) return;
        endDrag();
        const startTime = calculateTimeFromEvent(e.touches[0].clientX);
        setIsSeeking(true);
        setSeekPreviewTime(startTime);

        const onGlobalTouchMove = (moveEvent: TouchEvent) => {
            if (!moveEvent.touches[0]) return;
            const movedTime = calculateTimeFromEvent(moveEvent.touches[0].clientX);
            setSeekPreviewTime(movedTime);
        };

        const onGlobalTouchEnd = (endEvent: TouchEvent) => {
            const endTouch = endEvent.changedTouches[0];
            const finalTime = endTouch ? calculateTimeFromEvent(endTouch.clientX) : startTime;
            setSeekPreviewTime(finalTime);
            setIsSeeking(false);
            endDrag();
            onSeek(finalTime);
        };

        dragCleanupRef.current = () => {
            window.removeEventListener('touchmove', onGlobalTouchMove);
            window.removeEventListener('touchend', onGlobalTouchEnd);
        };
        window.addEventListener('touchmove', onGlobalTouchMove, { passive: true });
        window.addEventListener('touchend', onGlobalTouchEnd);
    }, [calculateTimeFromEvent, disabled, endDrag, isLive, onSeek, validDuration]);

    if (isLive) {
        return (
            <div className="flex items-center gap-2 py-1.5 select-none">
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[11px] font-bold">
                    <Radio className="w-3 h-3 text-rose-400 animate-pulse" />
                    <span>LIVE 实时流媒体</span>
                </span>
                <span className="text-xs font-mono text-slate-400">已播放 {formatTime(currentTime)}</span>
            </div>
        );
    }

    return (
        <div
            role="slider"
            aria-label="播放进度"
            aria-valuemin={0}
            aria-valuemax={Math.round(validDuration)}
            aria-valuenow={Math.round(activeTime)}
            aria-disabled={disabled || isLive || validDuration <= 0}
            tabIndex={disabled || isLive || validDuration <= 0 ? -1 : 0}
            onKeyDown={(e) => {
                if (disabled || isLive || validDuration <= 0) return;
                if (e.key === 'ArrowLeft') { e.preventDefault(); onSeek(Math.max(0, activeTime - 5)); }
                else if (e.key === 'ArrowRight') { e.preventDefault(); onSeek(Math.min(validDuration, activeTime + 5)); }
                else if (e.key === 'Home') { e.preventDefault(); onSeek(0); }
                else if (e.key === 'End') { e.preventDefault(); onSeek(validDuration); }
            }}
            className="relative flex items-center w-full py-2.5 cursor-pointer group select-none touch-none outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 rounded-full"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => {
                setIsHovered(false);
                setHoverPosition(null);
            }}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
        >
            {/* 悬停时间预览 Tooltip 气泡 */}
            {(isHovered || isSeeking) && hoverPosition !== null && validDuration > 0 && (
                <div
                    className="absolute -top-7 -translate-x-1/2 px-2 py-0.5 rounded bg-slate-900/95 border border-white/20 text-[11px] font-mono text-white pointer-events-none shadow-xl backdrop-blur transition-all duration-75 z-30"
                    style={{
                        left: `${Math.min(96, Math.max(4, (hoverPosition / validDuration) * 100))}%`,
                    }}
                >
                    {formatTime(hoverPosition)}
                </div>
            )}

            {/* 进度条轨道容器 */}
            <div
                ref={barRef}
                className="relative w-full h-1.5 group-hover:h-2.5 rounded-full bg-white/20 overflow-visible transition-all duration-200"
            >
                {/* 缓冲进度槽 */}
                <div
                    className="absolute top-0 left-0 h-full rounded-full bg-white/30 transition-all duration-300 pointer-events-none"
                    style={{ width: `${bufferedPercent}%` }}
                />

                {/* 悬浮指示槽 */}
                {isHovered && hoverPosition !== null && (
                    <div
                        className="absolute top-0 left-0 h-full rounded-full bg-white/10 pointer-events-none"
                        style={{ width: `${(hoverPosition / validDuration) * 100}%` }}
                    />
                )}

                {/* 已播放进度槽 (高亮渐变) */}
                <div
                    className="absolute top-0 left-0 h-full rounded-full bg-gradient-to-r from-indigo-500 via-indigo-400 to-cyan-400 shadow-[0_0_8px_rgba(99,102,241,0.5)] pointer-events-none"
                    style={{ width: `${progressPercent}%` }}
                />

            {/* 进度滑动手柄 (Thumb)。底色不能再用 border-indigo-600：它在深色渐变槽上
                偏暗，缩到 scale-0 时看不到；改为高亮描边并补一层外发光，拖拽目标更明确。 */}
                <div
                    className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.6)] ring-2 ring-indigo-400 transition-[transform,opacity] duration-150 pointer-events-none ${isHovered || isSeeking ? 'scale-110 opacity-100' : 'scale-0 opacity-0 group-hover:scale-100 group-hover:opacity-100'
                        }`}
                    style={{ left: `${progressPercent}%` }}
                />
            </div>
        </div>
    );
};

// 文档/文本内容展示组件（大文件截断 + PDF 不做文本转储）
const MAX_DOC_CHARS = 200_000;
const DocumentDisplay: React.FC<{ file: VideoFile }> = ({ file }) => {
    const [content, setContent] = useState<string>('');
    const [loading, setLoading] = useState<boolean>(true);
    const [truncated, setTruncated] = useState<boolean>(false);
    const isPdf = /\.pdf($|\?|#)/i.test(file.name) || /\.pdf($|\?|#)/i.test(file.url);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setTruncated(false);

        const loadContent = async () => {
            try {
                let text = '';
                if (file.file) {
                    if (file.file.size > 2 * 1024 * 1024) {
                        // 大文件只读前 MAX_DOC_CHARS 字节：整文件 text() 会把几百 MB 日志
                        // 一次性读进内存再截断，直接卡死渲染进程
                        text = await file.file.slice(0, MAX_DOC_CHARS).text();
                        if (!cancelled) {
                            setContent(text);
                            setTruncated(true);
                            setLoading(false);
                        }
                        return;
                    }
                    text = await file.file.text();
                } else if (file.url) {
                    const res = await fetch(file.url);
                    const reader = res.body?.getReader();
                    // 流式读取并上限截断，避免超大日志卡死渲染
                    if (reader) {
                        const decoder = new TextDecoder();
                        let acc = '';
                        for (; ;) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            acc += decoder.decode(value, { stream: true });
                            if (acc.length >= MAX_DOC_CHARS) {
                                acc = acc.slice(0, MAX_DOC_CHARS);
                                try { await reader.cancel(); } catch { /* ignore */ }
                                if (!cancelled) {
                                    setContent(acc);
                                    setTruncated(true);
                                    setLoading(false);
                                }
                                return;
                            }
                        }
                        text = acc;
                    } else {
                        text = (await res.text()).slice(0, MAX_DOC_CHARS + 1);
                    }
                }
                if (!cancelled) {
                    if (text.length > MAX_DOC_CHARS) {
                        setContent(text.slice(0, MAX_DOC_CHARS));
                        setTruncated(true);
                    } else {
                        setContent(text);
                    }
                    setLoading(false);
                }
            } catch (_err) {
                if (!cancelled) {
                    setContent('无法读取文档内容或网络请求受限');
                    setLoading(false);
                }
            }
        };

        loadContent();
        return () => {
            cancelled = true;
        };
    }, [file]);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full text-slate-400 gap-2">
                <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm">读取文档中...</span>
            </div>
        );
    }

    if (isPdf) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3 p-8 text-center">
                <FileText className="w-10 h-10 text-cyan-400" />
                <p className="text-sm font-semibold text-white">{file.name}</p>
                <p className="text-xs text-slate-500">PDF 不在播放器内预览，请下载后查看</p>
                {file.url && (
                    <a href={file.url} download={file.name} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition">
                        下载 PDF
                    </a>
                )}
            </div>
        );
    }

    return (
        <div className="w-full h-full overflow-y-auto p-6 max-w-4xl mx-auto text-slate-200">
            <div className="mb-4 pb-3 border-b border-white/10 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm font-semibold text-white">{file.name}</span>
                </div>
                <span className="text-xs text-slate-500 font-mono">{content.length} 字符{truncated ? '（已截断前 20 万字）' : ''}</span>
            </div>
            <pre className="font-mono text-sm leading-relaxed whitespace-pre-wrap break-words bg-slate-900/60 p-4 rounded-xl border border-white/5 select-text">
                {content}
            </pre>
        </div>
    );
};

export const PlayPanel: React.FC<PlayPanelProps> = ({ player, onBackToBrowse }) => {
    const { state, playlist, videoRef, currentFile, mediaError, pageInfo, methods } = player;

    // 播放器容器引用（用于真正的纯视频全屏，隔离左侧播放列表）
    const playerContainerRef = useRef<HTMLDivElement>(null);

    // 界面状态
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isControlsVisible, setIsControlsVisible] = useState(true);
    const controlsTimerRef = useRef<number | null>(null);

    // 画面操作提示反馈徽章 (如 +5s, -5s, 音量调节等)
    const [badgeText, setBadgeText] = useState<{ id: number; text: string; icon?: string } | null>(null);
    const badgeTimerRef = useRef<number | null>(null);

    const showFeedback = useCallback((text: string, icon?: string) => {
        if (badgeTimerRef.current !== null) {
            window.clearTimeout(badgeTimerRef.current);
        }
        setBadgeText({ id: Date.now(), text, icon });
        badgeTimerRef.current = window.setTimeout(() => {
            setBadgeText(null);
        }, 1000);
    }, []);

    // 模态框状态
    const [showUrlModal, setShowUrlModal] = useState(false);
    const [inputUrl, setInputUrl] = useState('');
    const [inputTitle, setInputTitle] = useState('');
    const [showRateMenu, setShowRateMenu] = useState(false);
    const [showShortcuts, setShowShortcuts] = useState(false);

    // ACG 直推抓取模态框
    const [showAcgModal, setShowAcgModal] = useState(false);
    const [acgInput, setAcgInput] = useState('');
    const [isAcgLoading, setIsAcgLoading] = useState(false);
    const [acgStatus, setAcgStatus] = useState<string | null>(null);

    // 播放列表分类过滤
    const [playlistFilter, setPlaylistFilter] = useState<'all' | 'video' | 'stream' | 'audio' | 'image' | 'document' | 'gallery'>('all');
    // 树节点展开状态（缺省全展开，只记手动收起的）
    const [collapsedNodes, setCollapsedNodes] = useState<Record<string, boolean>>({});
    const toggleNode = useCallback((id: string) => {
        setCollapsedNodes((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const packFolderInputRef = useRef<HTMLInputElement>(null);

    // 单文件 .gallery 打包/导入状态行（6 秒自动消失）
    const [packStatus, setPackStatus] = useState<string | null>(null);
    useEffect(() => {
        if (!packStatus) return;
        const t = window.setTimeout(() => setPackStatus(null), 6000);
        return () => window.clearTimeout(t);
    }, [packStatus]);

    // 智能导入：先按魔数挑出单文件 .gallery 包（ZIP），解包成组；
    // 其它文件（含旧式 JSON 徽标画廊文件夹）原样走 addFiles，不破坏原有成组逻辑
    const importFilesSmart = useCallback(async (files: FileList | File[]) => {
        const list = Array.from(files || []);
        if (list.length === 0) return;
        const galleryFiles = list.filter((f) => f && /\.gallery$/i.test(f.name || ''));
        if (galleryFiles.length === 0) {
            methods.addFiles(list);
            return;
        }
        const checks = await Promise.all(
            galleryFiles.map(async (f) => ({ file: f, isPack: await isGalleryPackFile(f) }))
        );
        const packSet = new Set(checks.filter((c) => c.isPack).map((c) => c.file));
        const rest = list.filter((f) => !packSet.has(f));
        if (rest.length > 0) methods.addFiles(rest);
        for (const f of packSet) {
            try {
                const unpacked = await unpackGalleryPack(f);
                if (unpacked) {
                    methods.addUnpackedGallery(unpacked.name, unpacked.pages);
                    setPackStatus(`✅ 已导入画廊「${unpacked.name}」（${unpacked.pages.length} 页）`);
                    continue;
                }
            } catch {
                // 坏包回落散文件逻辑
            }
            methods.addFiles([f]);
        }
    }, [methods]);

    // 打包为单文件 .gallery：选目录 → 按 .name + 数字图片规则收集 → ZIP →
    // Electron 弹另存为（位置自选），纯浏览器回退走下载
    const handlePackFolder = useCallback(async (files: FileList | File[]) => {
        const list = Array.from(files || []);
        if (list.length === 0) return;
        setPackStatus('正在按规则收集画廊文件…');
        try {
            const collected = await collectPackSources(list);
            setPackStatus(`正在打包「${collected.name}」（${collected.images.length} 页）…`);
            const blob = await packToGalleryBlob(collected.name, collected.images);
            const fileName = `${sanitizePackName(collected.name)}.gallery`;
            const api = getElectronAPI();
            if (api?.galleryPack?.savePack) {
                const data = await blob.arrayBuffer();
                const res = await api.galleryPack.savePack({ fileName, data });
                setPackStatus(res.success ? `✅ ${res.message}` : `ℹ️ ${res.message || '未保存'}`);
            } else {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 5000);
                setPackStatus(`✅ 已导出 ${fileName}（浏览器下载）`);
            }
        } catch (e) {
            setPackStatus(`❌ ${e instanceof Error ? e.message : '打包失败'}`);
        }
    }, []);

    // 全屏下鼠标静止自动隐藏控制条
    const resetControlsTimer = useCallback(() => {
        setIsControlsVisible(true);
        if (controlsTimerRef.current !== null) {
            window.clearTimeout(controlsTimerRef.current);
        }
        if (state.isPlaying) {
            controlsTimerRef.current = window.setTimeout(() => {
                setIsControlsVisible(false);
            }, 3000);
        }
    }, [state.isPlaying]);

    useEffect(() => {
        if (!state.isPlaying) {
            setIsControlsVisible(true);
            if (controlsTimerRef.current !== null) {
                window.clearTimeout(controlsTimerRef.current);
            }
        } else {
            resetControlsTimer();
        }
    }, [state.isPlaying, resetControlsTimer]);

    // 处理全屏切换：使用 playerContainerRef 实现独立真全屏
    const handleToggleFullscreen = useCallback(() => {
        methods.toggleFullscreen(playerContainerRef.current);
    }, [methods]);

    // 快进 / 快退逻辑封装 (带视觉提示)
    const handleSeekDelta = useCallback((delta: number) => {
        if (!videoRef.current) return;
        const target = Math.max(0, Math.min(state.duration || 0, state.currentTime + delta));
        methods.seek(target);
        showFeedback(delta > 0 ? `+${delta}s` : `${delta}s`, delta > 0 ? 'forward' : 'rewind');
    }, [methods, showFeedback, state.currentTime, state.duration, videoRef]);

    // 单击/双击消歧：单击延迟 260ms 生效，双击直接取消单击，避免双击快进时连带暂停两次
    const clickTimerRef = useRef<number | null>(null);

    // 单击/双击画面响应。两条护栏：文档分支直接放行（选词/滚动不许误触播放态），
    // 按钮/链接/输入/代码块冒泡一律忽略（下载、导入按钮点下去不再连带暂停）。
    // 图集/文档双击按区域翻页（左上页、右下页、中暂停/继续）；视频保持左退10s、右进10s、中全屏。
    const pagedKind = currentFile?.mediaType === 'image' || currentFile?.mediaType === 'document';
    // 有真实播放态的媒体：音视频/流，以及走幻灯片轮播的图集与文档
    const isPlayableMedia = !!currentFile
        && (currentFile.mediaType === 'video'
            || currentFile.mediaType === 'stream'
            || currentFile.mediaType === 'audio'
            || pagedKind);
    const handleVideoAreaClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        if (target.closest?.('button, a, input, textarea, select, pre')) return;
        if (currentFile?.mediaType === 'document') return;
        const rect = e.currentTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const width = rect.width;

        if (e.detail === 2) {
            if (clickTimerRef.current !== null) {
                window.clearTimeout(clickTimerRef.current);
                clickTimerRef.current = null;
            }
            // 双击事件
            if (pagedKind) {
                if (clickX < width * 0.35) {
                    methods.prevPage();
                } else if (clickX > width * 0.65) {
                    methods.nextPage();
                } else {
                    methods.togglePlay();
                }
                return;
            }
            if (clickX < width * 0.35) {
                handleSeekDelta(-10);
            } else if (clickX > width * 0.65) {
                handleSeekDelta(10);
            } else {
                handleToggleFullscreen();
            }
        } else if (e.detail === 1) {
            if (clickTimerRef.current !== null) {
                window.clearTimeout(clickTimerRef.current);
            }
            const wasPlaying = state.isPlaying;
            clickTimerRef.current = window.setTimeout(() => {
                clickTimerRef.current = null;
                // 纯静态占位页（画廊徽标/other）没有播放态，togglePlay 是空操作，
                // 这里同步不弹提示，避免"提示播放中但画面毫无变化"的误导
                if (!pagedKind && !isPlayableMedia) return;
                methods.togglePlay();
                showFeedback(wasPlaying ? '已暂停' : '播放中', wasPlaying ? 'pause' : 'play');
            }, 260);
        }
    }, [currentFile?.mediaType, handleSeekDelta, handleToggleFullscreen, isPlayableMedia, methods, pagedKind, showFeedback, state.isPlaying]);

    useEffect(() => () => {
        if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    }, []);

    // 免下载直接抓取网络作品推送到播放器（与 App 共用 resolveProbeMedia）
    const handleFetchAcg = async () => {
        const target = acgInput.trim();
        if (!target) return;
        const electronAPI = getElectronAPI();
        if (!electronAPI?.acgmho?.probe) {
            setAcgStatus('当前环境不支持直连抓取，请在桌面端应用中运行');
            return;
        }
        setIsAcgLoading(true);
        setAcgStatus('正在解析作品媒体资源...');
        try {
            const probe = await electronAPI.acgmho.probe(target);
            const resolved = resolveProbeMedia(probe);
            if (resolved.kind === 'none' || resolved.streams.length === 0) {
                setAcgStatus(resolved.status || '作品中未解析到可播放的媒体资源');
                setIsAcgLoading(false);
                return;
            }

            methods.addMultipleStreams(
                resolved.kind === 'image'
                    // 多图集才建画廊分组（带标题 + 页码）；音视频走上面的纯直推，不进分组
                    ? resolved.streams.map((s, i) => ({ ...s, groupId: `acg:${probe.gid}`, groupName: probe.title, groupType: 'gallery' as const, page: i + 1 }))
                    : resolved.streams,
                true,
                false
            );
            setShowAcgModal(false);
            setIsAcgLoading(false);
            setAcgInput('');
            setAcgStatus(null);

            // 图集后续页面异步流式抓取并追加到列表（带页码+分组，供有序合并）
            if (resolved.kind === 'image' && resolved.totalPages > 1 && electronAPI.acgmho.fetchPages) {
                fetchAcgRemainingPages(electronAPI.acgmho.fetchPages, probe, 'playpanel').then(({ runId, pages }) => {
                    // 空 runId 即旧轮回包（用户又开了一本新的），直接丢弃不灌进新分组
                    if (!runId || pages.length === 0) return;
                    methods.appendStreams(pages.map((p) => ({
                        url: p.url,
                        name: p.title,
                        title: p.title,
                        mediaType: 'image' as const,
                        groupId: `acg:${probe.gid}`,
                        groupName: probe.title,
                        groupType: 'gallery' as const,
                        page: p.page,
                    })));
                }).catch((e: any) => {
                    // 后台续页失败不打断已展示的首屏，只记日志
                    console.warn(`ACG ${probe.gid} 后续页抓取失败:`, e?.message || e);
                });
            }
        } catch (err: any) {
            setAcgStatus(err?.message || '抓取解析发生异常');
            setIsAcgLoading(false);
        }
    };

    // 图片自动轮播 (顺序翻页，走 nextPage；间隔受倍速控制：2x 则 2 秒一页)
    useEffect(() => {
        if (currentFile?.mediaType !== 'image' || !state.isPlaying) return;
        const rate = Number.isFinite(state.playbackRate) && state.playbackRate > 0 ? state.playbackRate : 1;
        const timer = setInterval(() => {
            methods.nextPage();
        }, Math.max(500, Math.round(4000 / rate)));
        return () => clearInterval(timer);
    }, [currentFile?.mediaType, currentFile?.id, state.isPlaying, state.playbackRate, methods]);

    // 一键关闭所有浮层（URL/ACG/快捷键/倍速菜单）：Esc 分支凭此执行，handler 只绑一次
    const closeOverlaysRef = useRef(() => { });
    closeOverlaysRef.current = () => {
        setShowUrlModal(false);
        setShowAcgModal(false);
        setAcgStatus(null);
        setShowShortcuts(false);
        setShowRateMenu(false);
    };

    // 全局快捷键处理：用 ref 承接高频 state，避免 timeupdate 每次重绑监听
    const shortcutsRef = useRef({ methods, handleSeekDelta, handleToggleFullscreen, showFeedback });
    shortcutsRef.current = { methods, handleSeekDelta, handleToggleFullscreen, showFeedback };
    const mediaKindRef = useRef(currentFile?.mediaType);
    mediaKindRef.current = currentFile?.mediaType;
    const playStateRef = useRef({ isPlaying: state.isPlaying, isMuted: state.isMuted, volume: state.volume });
    playStateRef.current = { isPlaying: state.isPlaying, isMuted: state.isMuted, volume: state.volume };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Esc 优先关闭一切浮层（含弹窗输入框内）：放 INPUT 守卫之前，
            // 否则框内聚焦时按 Esc 永远关不掉弹窗
            if (e.code === 'Escape') {
                closeOverlaysRef.current();
                return;
            }
            const target = e.target as HTMLElement;
            const tag = target.tagName;
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || target.isContentEditable) {
                return;
            }
            // 焦点在进度条滑杆上时方向键交给滑杆自身（自带 ±5s 步进），
            // 全局不再重复 seek 一次，否则每次跳 10s
            if (target.closest?.('[role="slider"]')) return;
            // 聚焦在按钮上时空格交给按钮默认行为，避免一次空格触发两次 toggle
            if (e.code === 'Space' && (tag === 'BUTTON' || target.closest?.('button'))) {
                return;
            }
            const { methods: m, handleSeekDelta: seekDelta, handleToggleFullscreen: toggleFs, showFeedback: feedback } = shortcutsRef.current;
            const { isPlaying, isMuted, volume } = playStateRef.current;
            const mediaKind = mediaKindRef.current;
            const isPaged = mediaKind === 'image' || mediaKind === 'document';

            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    m.togglePlay();
                    feedback(isPlaying ? '已暂停' : '播放中');
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    if (isPaged) {
                        m.prevPage();
                    } else {
                        seekDelta(-5);
                    }
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    if (isPaged) {
                        m.nextPage();
                    } else {
                        seekDelta(5);
                    }
                    break;
                case 'KeyJ':
                    e.preventDefault();
                    if (isPaged) m.prevPage();
                    else seekDelta(-10);
                    break;
                case 'KeyL':
                    e.preventDefault();
                    if (isPaged) m.nextPage();
                    else seekDelta(10);
                    break;
                case 'KeyK':
                    e.preventDefault();
                    m.togglePlay();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    {
                        const nextVolUp = Math.min(1, Math.round((volume + 0.05) * 100) / 100);
                        m.setVolume(nextVolUp);
                        feedback(`音量 ${Math.round(nextVolUp * 100)}%`);
                    }
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    {
                        const nextVolDown = Math.max(0, Math.round((volume - 0.05) * 100) / 100);
                        m.setVolume(nextVolDown);
                        feedback(`音量 ${Math.round(nextVolDown * 100)}%`);
                    }
                    break;
                case 'KeyM':
                    e.preventDefault();
                    m.toggleMute();
                    feedback(isMuted ? '取消静音' : '已静音');
                    break;
                case 'KeyF':
                    e.preventDefault();
                    toggleFs();
                    break;
                case 'BracketLeft':
                    e.preventDefault();
                    setIsSidebarOpen((prev) => !prev);
                    break;
                case 'KeyP':
                    e.preventDefault();
                    if (isPaged) m.prevPage();
                    else m.prevTrack();
                    break;
                case 'KeyN':
                    e.preventDefault();
                    if (isPaged) m.nextPage();
                    else m.nextTrack(true);
                    break;
                case 'Slash':
                    if (e.shiftKey) {
                        e.preventDefault();
                        setShowShortcuts((prev) => !prev);
                    }
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // 工作区文件树：画廊成组（头=画廊名，底下按页码排）、文件夹按层级嵌套、散文件平铺。
    // 过滤对叶子生效，空组/空目录自动隐藏；顺序按首次出现位置，不打乱原列表。
    interface TreeFileLeaf { kind: 'file'; file: VideoFile; originalIndex: number }
    interface TreeGroupNode {
        kind: 'group';
        id: string;
        name: string;
        gallery: boolean;
        children: TreeFileLeaf[];
    }
    interface TreeFolderNode {
        kind: 'folder';
        id: string;
        name: string;
        children: TreeNode[];
    }
    type TreeNode = TreeFileLeaf | TreeGroupNode | TreeFolderNode;

    const leafVisible = useCallback((file: VideoFile): boolean => {
        if (playlistFilter === 'all') return true;
        // 视频与流媒体分开：此前 video 把 stream 一并吞掉，纯 HLS 直播/音轨会被算进「视频」，
        // 用户按「视频」筛却看到音频，按「音频」筛又找不到它。
        if (playlistFilter === 'video') return file.mediaType === 'video';
        if (playlistFilter === 'stream') return file.mediaType === 'stream';
        if (playlistFilter === 'audio') return file.mediaType === 'audio';
        if (playlistFilter === 'image') return file.mediaType === 'image';
        if (playlistFilter === 'document') return file.mediaType === 'document';
        if (playlistFilter === 'gallery') return file.mediaType === 'gallery' || file.groupType === 'gallery';
        return true;
    }, [playlistFilter]);

    const isGalleryFile = useCallback((file: VideoFile): boolean => {
        if (!file.groupId) return false;
        return file.groupType === 'gallery'
            || file.groupId.startsWith('acg:')
            || file.groupId.startsWith('gallery:');
    }, []);

    const playlistTree = useMemo((): TreeNode[] => {
        const roots: TreeNode[] = [];
        const groupMap = new Map<string, TreeGroupNode>();
        // 文件夹节点按完整路径复用，保证嵌套层级正确
        const folderMap = new Map<string, TreeFolderNode>();

        const ensureFolder = (segments: string[]): TreeFolderNode[] => {
            const chain: TreeFolderNode[] = [];
            let acc = '';
            let parentChildren: TreeNode[] | null = null;
            for (const seg of segments) {
                acc = acc ? `${acc}/${seg}` : seg;
                let node = folderMap.get(acc);
                if (!node) {
                    node = { kind: 'folder', id: `folder:${acc}`, name: seg, children: [] };
                    folderMap.set(acc, node);
                    if (parentChildren) parentChildren.push(node);
                    else roots.push(node);
                }
                chain.push(node);
                parentChildren = node.children;
            }
            return chain;
        };

        playlist.files.forEach((file: VideoFile, originalIndex: number) => {
            if (!leafVisible(file)) return;
            if (isGalleryFile(file)) {
                const gid = file.groupId!;
                let node = groupMap.get(gid);
                if (!node) {
                    node = { kind: 'group', id: `gallery:${gid}`, name: file.groupName || '未命名画廊', gallery: true, children: [] };
                    groupMap.set(gid, node);
                    roots.push(node);
                } else if (node.name === '未命名画廊' && file.groupName) {
                    node.name = file.groupName;
                }
                node.children.push({ kind: 'file', file, originalIndex });
                return;
            }
            if (file.folder) {
                const segments = file.folder.split('/').filter(Boolean);
                if (segments.length > 0) {
                    const chain = ensureFolder(segments);
                    chain[chain.length - 1].children.push({ kind: 'file', file, originalIndex });
                    return;
                }
            }
            roots.push({ kind: 'file', file, originalIndex });
        });

        // 画廊子页按页码升序（迟到/重试页归位后这里自然有序）；无页码保持原顺序
        for (const node of groupMap.values()) {
            node.children.sort((a, b) => (a.file.page ?? Number.MAX_SAFE_INTEGER) - (b.file.page ?? Number.MAX_SAFE_INTEGER));
        }
        return roots;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playlist.files, playlistFilter]);

    // —— 工作区文件树渲染 ——
    const renderFileRow = (file: VideoFile, originalIndex: number, depth: number) => {
        const isActive = playlist.currentIndex === originalIndex;
        const TypeIcon = MEDIA_TYPE_ICON[file.mediaType] || FileQuestion;
        return (
            <div
                key={file.id || originalIndex}
                onClick={() => methods.selectTrack(originalIndex)}
                style={{ paddingLeft: 16 + depth * 14 }}
                className={`flex items-center gap-3 pr-4 py-3 cursor-pointer group transition duration-150 ${isActive
                    ? 'bg-indigo-600/20 border-l-4 border-indigo-500 text-white font-medium'
                    : 'hover:bg-white/5 text-slate-400 hover:text-slate-200'
                    }`}
            >
                <div className={`shrink-0 transition-colors ${isActive ? MEDIA_TYPE_ACCENT[file.mediaType] : 'text-slate-500 group-hover:text-slate-300'}`}>
                    <TypeIcon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                    <p
                        className={`text-xs truncate ${isActive ? 'text-white font-bold' : ''}`}
                        title={file.description && file.description !== file.name ? `${file.name}（${file.description}）` : file.name}
                    >
                        {file.name}
                    </p>
                    <p className="text-[10px] text-slate-500 font-mono mt-0.5 flex items-center gap-1.5">
                        <span>{file.page != null ? `P${file.page}` : `#${originalIndex + 1}`}</span>
                        <span>·</span>
                        <span>{MEDIA_TYPE_LABEL[file.mediaType]}</span>
                    </p>
                </div>
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        methods.removeTrack(originalIndex);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-rose-400 transition"
                    title="移除"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
        );
    };

    const collectLeafIndexes = (nodes: TreeNode[]): number[] => {
        const out: number[] = [];
        for (const n of nodes) {
            if (n.kind === 'file') out.push(n.originalIndex);
            else if (n.kind === 'group') out.push(...n.children.map((c) => c.originalIndex));
            else out.push(...collectLeafIndexes(n.children));
        }
        return out;
    };

    const renderTreeNode = (node: TreeNode, depth: number): React.ReactNode => {
        if (node.kind === 'file') return renderFileRow(node.file, node.originalIndex, depth);

        const collapsed = !!collapsedNodes[node.id];
        const leafIndexes = node.kind === 'group'
            ? node.children.map((c) => c.originalIndex)
            : collectLeafIndexes(node.children);
        const hasActive = leafIndexes.includes(playlist.currentIndex);
        const isGallery = node.kind === 'group';

        return (
            <div key={node.id}>
                <div
                    className={`flex items-center gap-2 pr-3 py-2.5 cursor-pointer group transition duration-150 border-l-4 ${hasActive
                        ? 'bg-indigo-600/10 border-indigo-500/70 text-white'
                        : 'border-transparent hover:bg-white/5 text-slate-300 hover:text-white'
                        }`}
                    style={{ paddingLeft: 12 + depth * 14 }}
                >
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleNode(node.id);
                        }}
                        className="p-0.5 text-slate-500 hover:text-white transition shrink-0"
                        title={collapsed ? '展开' : '收起'}
                    >
                        {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    {isGallery ? (
                        <Library className={`w-4 h-4 shrink-0 ${hasActive ? 'text-amber-400' : 'text-amber-500/80'}`} />
                    ) : collapsed ? (
                        <Folder className="w-4 h-4 shrink-0 text-slate-500" />
                    ) : (
                        <FolderOpen className="w-4 h-4 shrink-0 text-indigo-400/80" />
                    )}
                    <div
                        className="flex-1 min-w-0"
                        onClick={() => {
                            if (leafIndexes.length > 0) methods.selectTrack(leafIndexes[0]);
                        }}
                        title={node.name}
                    >
                        <p className="text-xs font-semibold truncate">{node.name}</p>
                        <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                            {isGallery ? `${leafIndexes.length}P` : `${leafIndexes.length} 项`}
                        </p>
                    </div>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            methods.removeTracks(leafIndexes);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:text-rose-400 transition shrink-0"
                        title={isGallery ? '移除整本画廊' : '移除整个文件夹'}
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
                {!collapsed && (
                    <div>
                        {node.kind === 'group'
                            ? node.children.map((c) => renderFileRow(c.file, c.originalIndex, depth + 1))
                            : node.children.map((c) => renderTreeNode(c, depth + 1))}
                    </div>
                )}
            </div>
        );
    };

    // 切换播放循环模式（四种全覆盖，之前 StopAfter 在 UI 上不可达）
    const cycleMode = () => {
        const modes: PlaybackMode[] = [
            PlaybackMode.ListLoop,
            PlaybackMode.SingleLoop,
            PlaybackMode.Random,
            PlaybackMode.StopAfter,
        ];
        const currentIndex = modes.indexOf(state.playbackMode);
        const nextMode = modes[(currentIndex + 1) % modes.length];
        methods.setPlaybackMode(nextMode);
        showFeedback(`模式: ${PLAYBACK_MODE_LABEL[nextMode]}`);
    };

    // 切换画面填充模式
    const cycleFit = () => {
        const fits: ObjectFitMode[] = ['contain', 'cover', 'fill'];
        const currentIndex = fits.indexOf(state.objectFit);
        const nextFit = fits[(currentIndex + 1) % fits.length];
        methods.setObjectFit(nextFit);
        showFeedback(`画面: ${OBJECT_FIT_LABEL[nextFit]}`);
    };

    // 判断是否为流媒体直播：duration 保留 Infinity 语义，未加载完成前不误判 VOD 为 LIVE
    const isLiveStream = currentFile?.mediaType === 'stream' && !Number.isFinite(state.duration);

    // 获取视频缓冲进度：除 timeupdate 外还监听 progress 事件，
    // 否则暂停状态下边下边播时缓冲条长期不刷新
    const [bufferedVersion, setBufferedVersion] = useState(0);
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        const bump = () => setBufferedVersion((v) => v + 1);
        video.addEventListener('progress', bump);
        video.addEventListener('loadedmetadata', bump);
        video.addEventListener('canplay', bump);
        return () => {
            video.removeEventListener('progress', bump);
            video.removeEventListener('loadedmetadata', bump);
            video.removeEventListener('canplay', bump);
        };
    }, [currentFile?.id, videoRef]);
    const bufferedEnd = useMemo(() => {
        if (!videoRef.current || videoRef.current.buffered.length === 0) return 0;
        try {
            return videoRef.current.buffered.end(videoRef.current.buffered.length - 1);
        } catch (_e) {
            return 0;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.currentTime, bufferedVersion, currentFile?.id]);

    return (
        <div className="relative flex h-full w-full bg-slate-950 text-slate-200 overflow-hidden font-sans select-none">
            {/* ========================================================================= */}
            {/* 左侧：可折叠播放列表侧边栏                                                 */}
            {/* ========================================================================= */}
            <div
                className={`bg-slate-900/95 backdrop-blur-xl border-r border-white/8 flex flex-col shrink-0 z-30 transition-all duration-300 ease-in-out ${isSidebarOpen ? 'w-80 translate-x-0' : 'w-0 -translate-x-full overflow-hidden border-r-0 invisible'
                    }`}
                aria-hidden={!isSidebarOpen}
            >
                {/* 顶部标题与收起/清空操作 */}
                <div className="p-4 border-b border-white/8 flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <button
                                onClick={onBackToBrowse}
                                className="p-1.5 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition"
                                title="返回嗅探浏览"
                            >
                                <ArrowLeft className="w-4 h-4" />
                            </button>
                            <h2 className="text-sm font-bold text-white flex items-center gap-2">
                                <span>播放列表</span>
                                <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-indigo-300 font-mono font-semibold">
                                    {playlist.files.length}
                                </span>
                            </h2>
                        </div>

                        <div className="flex items-center gap-1">
                            <button
                                onClick={methods.clearPlaylist}
                                className="p-1.5 hover:bg-rose-500/15 hover:text-rose-400 rounded-xl text-slate-400 transition"
                                title="清空列表"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => setIsSidebarOpen(false)}
                                className="p-1.5 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition"
                                title="收起播放列表 ([)"
                            >
                                <PanelLeftClose className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    {/* 分类过滤标签：7 个分类塞进 320px 侧栏，保持 flex-1 单行会把
                        每格压到 ~40px 且中文挤成两行；改为两行网格（3 + 4），
                        每格宽度仍在 70px 以上，标签可读。 */}
                    <div className="grid grid-cols-4 gap-1 bg-black/40 p-1 rounded-xl border border-white/5 text-xs">
                        {(
                            [
                                { key: 'all', label: '全部' },
                                { key: 'video', label: '视频' },
                                { key: 'stream', label: '流媒体' },
                                { key: 'audio', label: '音频' },
                                { key: 'image', label: '图片' },
                                { key: 'gallery', label: '画廊' },
                                { key: 'document', label: '文档' },
                            ] as const
                        ).map((tab) => (
                            <button
                                key={tab.key}
                                onClick={() => setPlaylistFilter(tab.key)}
                                className={`py-1 text-center font-medium rounded-lg transition ${playlistFilter === tab.key
                                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30 font-bold'
                                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                                    }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    {/* 添加按钮组 */}
                    <div className="flex gap-2">
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-indigo-600/20 active:scale-95"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            <span>添加媒体</span>
                        </button>
                        <button
                            onClick={() => folderInputRef.current?.click()}
                            className="p-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl transition border border-white/5"
                            title="添加目录（含 .gallery 画廊文件夹自动成组；单文件 .gallery 包自动解包）"
                        >
                            <FolderOpen className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => packFolderInputRef.current?.click()}
                            className="p-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 rounded-xl transition"
                            title="打包目录为.gallery单文件"
                        >
                            <Archive className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setShowUrlModal(true)}
                            className="p-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl transition border border-white/5"
                            title="添加网络流"
                        >
                            <Link className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setShowAcgModal(true)}
                            className="p-2 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 rounded-xl transition"
                            title="抓取网络作品 / ACG (免下载直推到播放器)"
                        >
                            <Sparkles className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* 隐藏的本地文件/目录输入 */}
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="video/*,audio/*,image/*,.gallery,.md,.markdown,.txt,.log,.json,.pdf,.m4s,.ts"
                    onChange={(e) => {
                        if (e.target.files) void importFilesSmart(e.target.files);
                        e.target.value = '';
                    }}
                    className="hidden"
                />
                <input
                    ref={folderInputRef}
                    type="file"
                    // @ts-ignore
                    webkitdirectory=""
                    directory=""
                    multiple
                    onChange={(e) => {
                        if (e.target.files) void importFilesSmart(e.target.files);
                        e.target.value = '';
                    }}
                    className="hidden"
                />
                <input
                    ref={packFolderInputRef}
                    type="file"
                    // @ts-ignore
                    webkitdirectory=""
                    directory=""
                    multiple
                    onChange={(e) => {
                        if (e.target.files) void handlePackFolder(e.target.files);
                        e.target.value = '';
                    }}
                    className="hidden"
                />
                {packStatus && (
                    <div className="px-1 py-1 text-[11px] leading-4 text-amber-200/90 break-all">
                        {packStatus}
                    </div>
                )}

                {/* 工作区文件树：画廊成组、文件夹嵌套、散文件平铺 */}
                <div className="flex-1 overflow-y-auto divide-y divide-white/5 custom-scrollbar">
                    {playlistTree.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-48 text-slate-500 text-xs gap-2">
                            <Sparkles className="w-6 h-6 opacity-30" />
                            <span>列表中暂无此类媒体</span>
                        </div>
                    ) : (
                        playlistTree.map((node) => renderTreeNode(node, 0))
                    )}
                </div>
            </div>

            {/* ========================================================================= */}
            {/* 右侧：纯视频/媒体主容器 (独立绑定制胜真全屏与沉浸式体验)                 */}
            {/* ========================================================================= */}
            <div
                ref={playerContainerRef}
                onMouseMove={resetControlsTimer}
                onTouchStart={resetControlsTimer}
                className={`flex-1 flex flex-col relative overflow-hidden bg-black select-none ${state.isFullscreen && !isControlsVisible ? 'cursor-none' : ''
                    }`}
            >
                {/* 顶部浮层：侧边栏唤起按钮、标题与小窗/全屏快捷按钮 */}
                <div
                    className={`absolute top-0 left-0 right-0 z-30 flex items-center justify-between p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-300 pointer-events-auto ${isControlsVisible || !state.isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
                        }`}
                >
                    <div className="flex items-center gap-2">
                        {!isSidebarOpen && (
                            <button
                                onClick={() => setIsSidebarOpen(true)}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900/80 hover:bg-slate-800 text-slate-200 hover:text-white rounded-xl backdrop-blur border border-white/10 text-xs font-semibold shadow-xl transition"
                                title="展开播放列表 ([)"
                            >
                                <PanelLeftOpen className="w-4 h-4 text-indigo-400" />
                                <span>列表</span>
                            </button>
                        )}

                        {currentFile && (
                            <div className="flex items-center gap-2 max-w-lg truncate pl-1">
                                <span className="text-xs font-bold text-slate-100 truncate">{currentFile.name}</span>
                                {currentFile.mediaType && (
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded bg-white/10 uppercase tracking-wide ${MEDIA_TYPE_ACCENT[currentFile.mediaType]}`}>
                                        {MEDIA_TYPE_LABEL[currentFile.mediaType]}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        {(currentFile?.mediaType === 'video' || currentFile?.mediaType === 'stream') && document.pictureInPictureEnabled && (
                            <button
                                onClick={() => methods.togglePip()}
                                className="px-3 py-1.5 bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white rounded-xl backdrop-blur border border-white/10 text-xs font-semibold flex items-center gap-1.5 transition shadow-lg"
                                title="画中画模式 (PiP)"
                            >
                                <Tv className="w-3.5 h-3.5" />
                                <span>画中画</span>
                            </button>
                        )}

                        <button
                            onClick={handleToggleFullscreen}
                            className="p-2 bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white rounded-xl backdrop-blur border border-white/10 transition shadow-lg"
                            title={state.isFullscreen ? '退出全屏 (F / Esc)' : '真正视频全屏 (F)'}
                        >
                            {state.isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                        </button>
                    </div>
                </div>

                {/* 画面正中央反馈浮标 (提示 +5s, -5s, 音量变化等) */}
                {badgeText && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-40 animate-in fade-in zoom-in-75 duration-100">
                        <div className="flex items-center gap-2.5 px-5 py-3 rounded-2xl bg-black/80 backdrop-blur-xl border border-white/15 text-white shadow-2xl">
                            {badgeText.icon === 'forward' && <FastForward className="w-6 h-6 text-indigo-400 animate-pulse" />}
                            {badgeText.icon === 'rewind' && <Rewind className="w-6 h-6 text-indigo-400 animate-pulse" />}
                            {badgeText.icon === 'play' && <Play className="w-6 h-6 text-emerald-400 fill-current" />}
                            {badgeText.icon === 'pause' && <Pause className="w-6 h-6 text-amber-400 fill-current" />}
                            <span className="text-base font-bold font-mono tracking-wide">{badgeText.text}</span>
                        </div>
                    </div>
                )}

                {/* 媒体展示与播放主视口。
                    底栏是覆盖式渐变浮层，高度实测约 109px：视频有黑边挡着无所谓，
                    但图片/文档是「内容本身」，底边会被实打实盖住（实测遮挡 100px，
                    长图最后一行看不全）。因此这两类在控制条可见时预留出底栏高度，
                    控制条自动隐藏（幻灯片播放中）时再让出空间，长图不被永久压小。 */}
                <div
                    className={`flex-1 relative flex items-center justify-center overflow-hidden transition-[padding] duration-300 ${
                        pagedKind && (isControlsVisible || !state.isPlaying) ? 'pb-28' : 'pb-0'
                    }`}
                    onClick={handleVideoAreaClick}
                >
                    {currentFile ? (
                        currentFile.mediaType === 'image' ? (
                            <div className="relative w-full h-full flex items-center justify-center p-2 select-none">
                                <img
                                    src={currentFile.url}
                                    alt={currentFile.name}
                                    referrerPolicy="no-referrer"
                                    className="max-w-full max-h-full object-contain pointer-events-auto shadow-2xl"
                                />
                                <div className="absolute top-16 right-4 z-10 flex items-center gap-2">
                                    <span className="px-2.5 py-1 bg-slate-900/80 rounded-xl backdrop-blur border border-white/10 text-[11px] font-mono text-emerald-300 shadow-lg flex items-center gap-1.5">
                                        <ImageIcon className="w-3 h-3 text-emerald-400" />
                                        {pageInfo.index} / {pageInfo.total}
                                    </span>
                                    {state.isPlaying && state.playbackRate !== 1 && (
                                        <span
                                            className="px-2 py-1 bg-slate-900/80 rounded-xl backdrop-blur border border-white/10 text-[11px] font-mono text-indigo-300 shadow-lg"
                                            title="轮播间隔跟随倍速"
                                        >
                                            {state.playbackRate}x轮播
                                        </span>
                                    )}
                                </div>
                            </div>
                        ) : currentFile.mediaType === 'audio' ? (
                            // 音频没有画面，但空占满屏黑底会让整个视口显得「坏了」。
                            // 用同心唱片替代单圈圆环（原来只有一圈 + 中心小方块，中间大面积空），
                            // 并按播放态切换旋转与光环，静止时也有可看的层级。
                            <div className="flex flex-col items-center justify-center gap-7 p-8 text-center select-none">
                                <video ref={videoRef} className="hidden" />
                                <div className="relative flex items-center justify-center">
                                    {state.isPlaying && (
                                        <>
                                            <span className="absolute w-52 h-52 rounded-full border border-indigo-500/30 animate-orb-sonar" />
                                            <span className="absolute w-52 h-52 rounded-full border border-cyan-400/25 animate-orb-sonar-delayed" />
                                        </>
                                    )}
                                    <div
                                        className={`w-48 h-48 rounded-full border border-indigo-400/30 flex items-center justify-center shadow-2xl relative ${state.isPlaying ? 'animate-spin' : ''}`}
                                        style={{
                                            animationDuration: '12s',
                                            background:
                                                'repeating-radial-gradient(circle at 50% 50%, rgba(99,102,241,0.16) 0 2px, rgba(2,6,23,0) 2px 9px), radial-gradient(circle at 50% 50%, #1e1b4b 0%, #020617 72%)',
                                        }}
                                    >
                                        {/* 唱片高光，避免纯平圆盘显得呆板 */}
                                        <span className="absolute inset-0 rounded-full bg-gradient-to-tr from-white/10 via-transparent to-transparent" />
                                        <div className="w-16 h-16 rounded-full bg-slate-950 border border-white/10 flex items-center justify-center shadow-inner z-10">
                                            <Music className="w-8 h-8 text-indigo-400" />
                                        </div>
                                    </div>
                                </div>
                                <div className="max-w-md">
                                    <h2 className="text-lg font-bold text-white truncate">{currentFile.name}</h2>
                                    <p className="text-xs text-slate-500 mt-1 font-mono truncate" title={currentFile.url}>{currentFile.url}</p>
                                    <p className="text-[11px] text-slate-600 mt-2">
                                        {state.isPlaying ? '正在播放' : '已暂停'} · 点击画面或按空格切换
                                    </p>
                                </div>
                            </div>
                        ) : currentFile.mediaType === 'document' ? (
                            <DocumentDisplay file={currentFile} />
                        ) : currentFile.mediaType === 'gallery' ? (
                            <div className="flex flex-col items-center justify-center p-8 text-center text-slate-400 gap-4">
                                <Library className="w-12 h-12 text-amber-500/70" />
                                <div>
                                    <h3 className="text-base font-semibold text-white">{currentFile.name}</h3>
                                    <p className="text-xs text-slate-500 mt-1 max-w-sm">
                                        {currentFile.description || '画廊徽标文件：请选择包含“画廊名.gallery + 数字图片”的文件夹导入'}
                                    </p>
                                </div>
                                <button
                                    onClick={() => folderInputRef.current?.click()}
                                    className="px-4 py-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 rounded-xl text-xs font-semibold transition"
                                >
                                    选择画廊文件夹导入
                                </button>
                            </div>
                        ) : currentFile.mediaType === 'other' ? (
                            <div className="flex flex-col items-center justify-center p-8 text-center text-slate-400 gap-4">
                                <FileQuestion className="w-12 h-12 text-slate-500" />
                                <div>
                                    <h3 className="text-base font-semibold text-white">{currentFile.name}</h3>
                                    <p className="text-xs text-slate-500 mt-1">其他格式文件</p>
                                </div>
                                {currentFile.url && (
                                    <a
                                        href={currentFile.url}
                                        download={currentFile.name}
                                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition"
                                    >
                                        下载文件
                                    </a>
                                )}
                            </div>
                        ) : (
                            // 视频或流媒体 (播放区域)
                            <div className="relative w-full h-full flex items-center justify-center">
                                <video
                                    ref={videoRef}
                                    className="w-full h-full"
                                    style={{ objectFit: state.objectFit }}
                                    playsInline
                                />
                            </div>
                        )
                    ) : (
                        <div className="flex flex-col items-center justify-center text-slate-600 gap-3">
                            <Sparkles className="w-12 h-12 opacity-30 stroke-1 text-indigo-400" />
                            <div className="text-center">
                                <p className="text-sm font-medium text-slate-400">未选择任何媒体</p>
                                <p className="text-xs text-slate-600 mt-1">从左侧播放列表选择，或添加媒体开始播放</p>
                            </div>
                            <div className="flex gap-2 mt-2">
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-indigo-600/30"
                                >
                                    添加本地媒体
                                </button>
                                <button
                                    onClick={() => setShowUrlModal(true)}
                                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition"
                                >
                                    输入网络流
                                </button>
                                <button
                                    onClick={() => setShowAcgModal(true)}
                                    className="px-3 py-1.5 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 rounded-xl text-xs font-semibold transition flex items-center gap-1.5"
                                >
                                    <Sparkles className="w-3.5 h-3.5" />
                                    <span>抓取网络作品 (免下载)</span>
                                </button>
                            </div>
                        </div>
                    )}

                    {/* 缓冲加载中指示器 */}
                    {state.isBuffering && !mediaError && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-none z-20">
                            <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin shadow-2xl" />
                        </div>
                    )}

                    {/* 媒体错误横幅（替代此前的静默失败） */}
                    {mediaError && (
                        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-rose-950/90 border border-rose-500/40 text-rose-200 text-xs shadow-2xl backdrop-blur max-w-[90%]">
                            <span className="shrink-0 w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
                            <span className="truncate">{mediaError}</span>
                            <button onClick={() => methods.clearError()} className="shrink-0 p-1 hover:bg-white/10 rounded-lg text-rose-300 hover:text-white transition" title="关闭">
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    )}
                </div>

                {/* ========================================================================= */}
                {/* 底部悬浮控制底栏 (带渐变遮罩与沉浸式自动隐藏)                            */}
                {/* ========================================================================= */}
                {/* 未选择媒体时整条底栏都是死的：进度条 00:00/00:00、播放键点了没反应、
                    倍速/画幅/CONTAIN 全无对象。空态隐藏，让画面中央的引导按钮成为唯一焦点。 */}
                <div
                    className={`absolute bottom-0 left-0 right-0 z-30 p-4 bg-gradient-to-t from-black/95 via-black/75 to-transparent backdrop-blur-md flex-col gap-2 transition-all duration-300 ${currentFile ? 'flex pointer-events-auto' : 'hidden pointer-events-none'} ${isControlsVisible || !state.isPlaying ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0 pointer-events-none'
                        }`}
                >
                    {/* 核心专业进度条 */}
                    {currentFile?.mediaType === 'image' || currentFile?.mediaType === 'document' ? (
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => methods.selectTrack(pageInfo.firstIndex)}
                                className="text-[11px] font-mono text-slate-400 hover:text-white px-2 py-0.5 rounded bg-white/10 transition shrink-0"
                                title={pageInfo.grouped ? '本画廊首页' : '首项'}
                            >
                                1
                            </button>
                            <span className="text-xs font-mono text-indigo-300 w-16 text-right font-bold">
                                {pageInfo.index}
                            </span>
                            <input
                                type="range"
                                min={pageInfo.firstIndex}
                                max={pageInfo.lastIndex}
                                step={1}
                                value={playlist.currentIndex >= 0 ? playlist.currentIndex : pageInfo.firstIndex}
                                onChange={(e) => methods.selectTrack(parseInt(e.target.value, 10))}
                                className="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500 hover:h-2 transition-all"
                            />
                            <span className="text-xs font-mono text-slate-400 w-16">共 {pageInfo.total}</span>
                            <button
                                onClick={() => methods.selectTrack(pageInfo.lastIndex)}
                                className="text-[11px] font-mono text-slate-400 hover:text-white px-2 py-0.5 rounded bg-white/10 transition shrink-0"
                                title={pageInfo.grouped ? '本画廊末页' : '末项'}
                            >
                                {pageInfo.total}
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-3">
                            <span className="text-xs font-mono text-slate-300 w-14 text-right font-medium">
                                {formatTime(state.currentTime)}
                            </span>

                            <div className="flex-1">
                                <ProgressBar
                                    currentTime={state.currentTime}
                                    duration={state.duration}
                                    bufferedEnd={bufferedEnd}
                                    onSeek={methods.seek}
                                    isLive={isLiveStream}
                                />
                            </div>

                            <span className="text-xs font-mono text-slate-400 w-14 font-medium">
                                {isLiveStream ? 'LIVE' : formatTime(state.duration)}
                            </span>
                        </div>
                    )}

                    {/* 控制按钮组 */}
                    <div className="flex items-center justify-between pt-1">
                        {/* 左侧：播放模式、音量调节 */}
                        <div className="flex items-center gap-3">
                            <button
                                onClick={cycleMode}
                                className="p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition"
                                title={`播放模式: ${PLAYBACK_MODE_LABEL[state.playbackMode]}（点击切换）`}
                            >
                                {state.playbackMode === PlaybackMode.Random ? (
                                    <Shuffle className="w-4 h-4 text-indigo-400" />
                                ) : state.playbackMode === PlaybackMode.StopAfter ? (
                                    <CircleStop className="w-4 h-4 text-amber-400" />
                                ) : state.playbackMode === PlaybackMode.SingleLoop ? (
                                    <Repeat1 className="w-4 h-4 text-cyan-400" />
                                ) : (
                                    <Repeat className="w-4 h-4" />
                                )}
                            </button>

                            <div className="flex items-center gap-2 group/vol">
                                <button
                                    onClick={methods.toggleMute}
                                    className="p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition"
                                    title={state.isMuted ? '取消静音 (M)' : '静音 (M)'}
                                >
                                    {state.isMuted || state.volume === 0 ? (
                                        <VolumeX className="w-4 h-4 text-rose-400" />
                                    ) : (
                                        <Volume2 className="w-4 h-4" />
                                    )}
                                </button>
                                <div className="w-20 flex items-center">
                                    <input
                                        type="range"
                                        min={0}
                                        max={1}
                                        step={0.01}
                                        value={state.isMuted ? 0 : state.volume}
                                        onChange={(e) => methods.setVolume(parseFloat(e.target.value))}
                                        className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500 hover:h-2 transition-all"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* 中间：上一个 / 快退10s / 播放 / 快进10s / 下一个
              （图集/文档走顺序翻页，不受 Random 影响；时间轴跳转对分页媒体无意义，故隐藏） */}
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => (pagedKind ? methods.prevPage() : methods.prevTrack())}
                                className="p-2 hover:bg-white/10 rounded-xl text-slate-300 hover:text-white transition"
                                title={pagedKind ? '上一页 (P / ←)' : '上一个 (P)'}
                            >
                                <SkipBack className="w-5 h-5" />
                            </button>

                            {!pagedKind && (
                                <button
                                    onClick={() => handleSeekDelta(-10)}
                                    className="p-2 hover:bg-white/10 rounded-xl text-slate-300 hover:text-white transition"
                                    title="快退 10 秒 (J / ←)"
                                >
                                    <Rewind className="w-4 h-4" />
                                </button>
                            )}

                            <button
                                onClick={methods.togglePlay}
                                className="p-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl shadow-lg shadow-indigo-600/40 transition hover:scale-105 active:scale-95"
                                title={state.isPlaying ? '暂停 (Space)' : '播放 (Space)'}
                            >
                                {state.isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 fill-current" />}
                            </button>

                            {!pagedKind && (
                                <button
                                    onClick={() => handleSeekDelta(10)}
                                    className="p-2 hover:bg-white/10 rounded-xl text-slate-300 hover:text-white transition"
                                    title="快进 10 秒 (L / →)"
                                >
                                    <FastForward className="w-4 h-4" />
                                </button>
                            )}

                            <button
                                onClick={() => (pagedKind ? methods.nextPage() : methods.nextTrack(true))}
                                className="p-2 hover:bg-white/10 rounded-xl text-slate-300 hover:text-white transition"
                                title={pagedKind ? '下一页 (N / →)' : '下一个 (N)'}
                            >
                                <SkipForward className="w-5 h-5" />
                            </button>
                        </div>

                        {/* 右侧：倍速、画幅、全屏与帮助 */}
                        <div className="flex items-center gap-2">
                            {/* 倍速切换 */}
                            <div className="relative">
                                <button
                                    onClick={() => setShowRateMenu(!showRateMenu)}
                                    className="px-2.5 py-1 text-xs font-semibold rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/5 transition"
                                    title="播放倍速"
                                >
                                    {state.playbackRate}x
                                </button>
                                {showRateMenu && (
                                    <div className="absolute bottom-full right-0 mb-2 bg-slate-900 border border-white/10 rounded-xl shadow-2xl p-1 flex flex-col gap-0.5 z-50 backdrop-blur-xl">
                                        {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0].map((rate) => (
                                            <button
                                                key={rate}
                                                onClick={() => {
                                                    methods.setPlaybackRate(rate);
                                                    setShowRateMenu(false);
                                                    showFeedback(`倍速 ${rate}x`);
                                                }}
                                                className={`px-3 py-1 text-xs rounded-lg text-left transition ${state.playbackRate === rate
                                                    ? 'bg-indigo-600 text-white font-bold'
                                                    : 'text-slate-300 hover:bg-white/10'
                                                    }`}
                                            >
                                                {rate}x
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* 画面比例：显示中文标签，英文枚举继续留在 title 里备查 */}
                            <button
                                onClick={cycleFit}
                                className="px-2.5 py-1 bg-white/5 hover:bg-white/10 rounded-xl text-slate-300 hover:text-white border border-white/5 transition text-xs font-semibold whitespace-nowrap"
                                title={`画面适配: ${OBJECT_FIT_LABEL[state.objectFit]}（${state.objectFit}，点击切换）`}
                            >
                                {OBJECT_FIT_LABEL[state.objectFit]}
                            </button>

                            {/* 真正视频全屏按钮 */}
                            <button
                                onClick={handleToggleFullscreen}
                                className="p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition"
                                title={state.isFullscreen ? '退出全屏 (F / Esc)' : '纯净视频全屏 (F)'}
                            >
                                {state.isFullscreen ? <Minimize2 className="w-4 h-4 text-indigo-400" /> : <Maximize2 className="w-4 h-4" />}
                            </button>

                            {/* 快捷键指南 */}
                            <button
                                onClick={() => setShowShortcuts(true)}
                                className="p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition"
                                title="快捷键说明 (?)"
                            >
                                <HelpCircle className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* ========================================================================= */}
            {/* 模态框组                                                                 */}
            {/* ========================================================================= */}

            {/* 网络流添加模态框 */}
            {showUrlModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                    <div className="bg-slate-900 border border-white/10 rounded-2xl w-full max-w-md p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-4">
                            <h3 className="text-base font-bold text-white flex items-center gap-2">
                                <Link className="w-4 h-4 text-indigo-400" />
                                <span>输入网络媒体链接</span>
                            </h3>
                            <button
                                onClick={() => setShowUrlModal(false)}
                                className="p-1 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">资源 URL (视频 / 音频 / 图片 / 流)</label>
                                <input
                                    type="text"
                                    placeholder="https://example.com/live.m3u8 或 .mp4 / .mp3 / .jpg"
                                    value={inputUrl}
                                    onChange={(e) => setInputUrl(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && inputUrl.trim() && isValidMediaUrl(inputUrl.trim())) {
                                            methods.addStream(inputUrl.trim(), inputTitle.trim() || undefined);
                                            setInputUrl('');
                                            setInputTitle('');
                                            setShowUrlModal(false);
                                        }
                                    }}
                                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                                />
                                {inputUrl.trim() && !isValidMediaUrl(inputUrl.trim()) && (
                                    <p className="text-[11px] text-rose-400 mt-1">仅支持 http(s) / blob 链接，已拦截可疑协议</p>
                                )}
                            </div>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">显示名称 (可选)</label>
                                <input
                                    type="text"
                                    placeholder="自定义媒体标题"
                                    value={inputTitle}
                                    onChange={(e) => setInputTitle(e.target.value)}
                                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                                />
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 mt-6">
                            <button
                                onClick={() => setShowUrlModal(false)}
                                className="px-4 py-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl text-xs font-semibold transition"
                            >
                                取消
                            </button>
                            <button
                                onClick={() => {
                                    if (inputUrl.trim() && isValidMediaUrl(inputUrl.trim())) {
                                        methods.addStream(inputUrl.trim(), inputTitle.trim() || undefined);
                                        setInputUrl('');
                                        setInputTitle('');
                                        setShowUrlModal(false);
                                    }
                                }}
                                disabled={!inputUrl.trim() || !isValidMediaUrl(inputUrl.trim())}
                                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition shadow-lg shadow-indigo-600/30"
                            >
                                添加并播放
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 抓取网络作品 / ACG 直推模态框 */}
            {showAcgModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                    <div className="bg-slate-900 border border-white/10 rounded-2xl w-full max-w-md p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-4">
                            <h3 className="text-base font-bold text-white flex items-center gap-2">
                                <Sparkles className="w-4 h-4 text-rose-400" />
                                <span>抓取网络作品到播放器 (免下载)</span>
                            </h3>
                            <button
                                onClick={() => {
                                    setShowAcgModal(false);
                                    setAcgStatus(null);
                                }}
                                className="p-1 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">
                                    作品链接或 GID (支持漫画、动图、动画视频、有声音频)
                                </label>
                                <input
                                    type="text"
                                    placeholder="https://www.acgmho.com/h/12345 或作品 ID"
                                    value={acgInput}
                                    onChange={(e) => setAcgInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleFetchAcg();
                                    }}
                                    disabled={isAcgLoading}
                                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-rose-500 font-mono"
                                />
                            </div>

                            {acgStatus && (
                                <div className="flex items-center gap-2 p-3 bg-slate-950/80 rounded-xl border border-white/5 text-xs text-slate-300">
                                    {isAcgLoading && (
                                        <div className="w-3.5 h-3.5 border-2 border-rose-500 border-t-transparent rounded-full animate-spin shrink-0" />
                                    )}
                                    <span>{acgStatus}</span>
                                </div>
                            )}
                        </div>
                        <div className="flex justify-end gap-2 mt-6">
                            <button
                                onClick={() => {
                                    setShowAcgModal(false);
                                    setAcgStatus(null);
                                }}
                                className="px-4 py-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl text-xs font-semibold transition"
                            >
                                取消
                            </button>
                            <button
                                onClick={handleFetchAcg}
                                disabled={!acgInput.trim() || isAcgLoading}
                                className="px-4 py-2 bg-gradient-to-r from-rose-600 to-pink-600 hover:brightness-110 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition shadow-lg shadow-rose-600/30 flex items-center gap-1.5"
                            >
                                {isAcgLoading ? (
                                    <>
                                        <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        <span>解析中...</span>
                                    </>
                                ) : (
                                    <>
                                        <Play className="w-3.5 h-3.5 fill-current" />
                                        <span>抓取并播放</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 快捷键指南模态框 */}
            <ShortcutsModal isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
        </div>
    );
};

export default PlayPanel;
