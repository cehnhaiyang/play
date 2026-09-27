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
    Search,
    GripVertical,
    ListMusic,
    Inbox,
    Volume1,
    AlertTriangle,
} from 'lucide-react';
import { UsePlayReturn } from '../../hooks/usePlay';
import { PlaybackMode, ObjectFitMode, VideoFile, MediaType, getElectronAPI, type AiStory } from '../../meta';
import {
    isValidMediaUrl,
    resolveProbeMedia,
    fetchAcgRemainingPages,
    readAiBookFile,
    isAiBookFileName,
    dataUrlToBlobUrl,
    buildAiBookBlob,
    toDataUrl,
    sanitizeBookName,
} from '../../utils/utils';
import { loadStr, saveStr } from '../../utils/persist';
import {
    collectPackSources,
    packToGalleryBlob,
    sanitizePackName,
    unpackGalleryPack,
    isGalleryPackFile,
} from '../../utils/galleryPack';
import { ShortcutsModal } from './ShortcutsModal';
import { StoryGenerator, type StoryPageSource } from './StoryGenerator';
import { StoryReader } from './StoryReader';
import { IconButton, Pill, Modal, RangeSlider, EqualizerBars, useClickOutside, type PillTone } from './ui';

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
// 同一套语义色的十六进制形态：原生 range 的填充与滑块描边只能吃 CSS 颜色值，
// 用 Tailwind 类名表达不了，而这里又必须与上面那张表保持一致，故并列维护。
const MEDIA_TYPE_HEX: Record<MediaType, string> = {
    video: '#818cf8',
    stream: '#38bdf8',
    audio: '#f472b6',
    image: '#34d399',
    document: '#22d3ee',
    gallery: '#fbbf24',
    other: '#94a3b8',
};
// 徽章底色：顶部标题旁的类型标签用柔和色块，避免十来个灰底徽章糊成一片
const MEDIA_TYPE_TONE: Record<MediaType, PillTone> = {
    video: 'indigo',
    stream: 'sky',
    audio: 'rose',
    image: 'emerald',
    document: 'cyan',
    gallery: 'amber',
    other: 'slate',
};
// 侧栏宽度可拖拽，这两组是夹取范围与「双击复位」的目标值
const SIDEBAR_MIN = 248;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 320;
// 侧栏宽度落盘：用户调过一次之后，下次进播放器不该又弹回默认
const SIDEBAR_STORE_KEY = 'theplay.player.sidebarWidth';
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
    const { state, playlist, videoRef, currentFile, mediaError, mediaWarning, pageInfo, methods } = player;

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
    const [playlistFilter, setPlaylistFilter] = useState<'all' | 'video' | 'stream' | 'audio' | 'image' | 'gallery' | 'book' | 'document'>('all');
    // 侧栏搜索词：列表长到几十项后，靠肉眼在折叠树里找一条比重建列表还慢
    const [listQuery, setListQuery] = useState('');
    // 树节点展开状态（缺省全展开，只记手动收起的）
    const [collapsedNodes, setCollapsedNodes] = useState<Record<string, boolean>>({});
    const toggleNode = useCallback((id: string) => {
        setCollapsedNodes((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []);

    // 侧栏宽度：可拖拽 + 落盘。初值从 localStorage 读，越界值夹回范围内，
    // 避免上次在超宽屏拖到 560 之后换到小屏时侧栏吃掉整个视口。
    const [sidebarWidth, setSidebarWidth] = useState(() => {
        const saved = parseInt(loadStr(SIDEBAR_STORE_KEY, '', ''), 10);
        if (!Number.isFinite(saved)) return SIDEBAR_DEFAULT;
        return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, saved));
    });
    const sidebarRef = useRef<HTMLDivElement>(null);
    const resizeCleanupRef = useRef<(() => void) | null>(null);
    const endSidebarResize = useCallback(() => {
        resizeCleanupRef.current?.();
        resizeCleanupRef.current = null;
        document.body.classList.remove('tp-resizing');
    }, []);
    // 拖到一半切走视图/卸载时，挂在 window 上的监听器必须回收，
    // 否则它持有过期闭包，之后每次移动鼠标都在改一个不存在的侧栏宽度
    useEffect(() => () => endSidebarResize(), [endSidebarResize]);

    const startSidebarResize = useCallback((e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        endSidebarResize();
        document.body.classList.add('tp-resizing');

        const apply = (clientX: number) => {
            const left = sidebarRef.current?.getBoundingClientRect().left ?? 0;
            const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, clientX - left));
            setSidebarWidth(next);
        };

        const onMove = (ev: MouseEvent) => apply(ev.clientX);
        const onTouchMove = (ev: TouchEvent) => { if (ev.touches[0]) apply(ev.touches[0].clientX); };
        const onUp = () => {
            endSidebarResize();
            // 松手时才落盘：拖动过程中每帧写一次 localStorage 是没必要的同步 I/O
            setSidebarWidth((w) => { saveStr(SIDEBAR_STORE_KEY, String(w), ''); return w; });
        };

        resizeCleanupRef.current = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchmove', onTouchMove, { passive: true });
        window.addEventListener('touchend', onUp);
    }, [endSidebarResize]);

    const resetSidebarWidth = useCallback(() => {
        setSidebarWidth(SIDEBAR_DEFAULT);
        saveStr(SIDEBAR_STORE_KEY, String(SIDEBAR_DEFAULT), '');
    }, []);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const packFolderInputRef = useRef<HTMLInputElement>(null);

    // 单文件 .gallery 打包/导入状态行（6 秒自动消失）
    const [packStatus, setPackStatus] = useState<string | null>(null);

    // AI 绘本生成器开关（覆盖在主视口上的整屏面板）
    const [showGenerator, setShowGenerator] = useState(false);
    useEffect(() => {
        if (!packStatus) return;
        const t = window.setTimeout(() => setPackStatus(null), 6000);
        return () => window.clearTimeout(t);
    }, [packStatus]);

    // 倍速菜单此前只有「选中某一项」会关，点别处一律不关：浮层会一直挂在
    // 控制条上方，直到用户再点一次倍速按钮。补上点击外部关闭。
    const rateMenuRef = useRef<HTMLDivElement>(null);
    useClickOutside(rateMenuRef, () => setShowRateMenu(false), showRateMenu);

    /* ---------------------------------------------------------------------- */
    /* 模态框提交 / 关闭                                                       */
    /* ---------------------------------------------------------------------- */

    // 地址合法性算一次给三处用（边框变色、禁用按钮、提交守卫），
    // 此前在 JSX 里重复调了三遍 isValidMediaUrl
    const urlIsValid = !!inputUrl.trim() && isValidMediaUrl(inputUrl.trim());

    const submitUrl = useCallback(() => {
        const url = inputUrl.trim();
        if (!url || !isValidMediaUrl(url)) return;
        methods.addStream(url, inputTitle.trim() || undefined);
        setInputUrl('');
        setInputTitle('');
        setShowUrlModal(false);
    }, [inputUrl, inputTitle, methods]);

    // ACG 状态文案里带「失败 / 异常 / 不支持」时按错误着色，成功路径保持中性
    const acgStatusIsError = !!acgStatus && /失败|异常|不支持|未解析|错误/.test(acgStatus);

    const closeAcgModal = useCallback(() => {
        setShowAcgModal(false);
        setAcgStatus(null);
    }, []);

    // 智能导入：先按后缀挑出 .aibook（AI 绘本 JSON），再按魔数挑出单文件
    // .gallery 包（ZIP），各自解包成组；其它文件（含旧式 JSON 徽标画廊文件夹）
    // 原样走 addFiles，不破坏原有成组逻辑
    const importFilesSmart = useCallback(async (files: FileList | File[]) => {
        const list = Array.from(files || []);
        if (list.length === 0) return;

        // AI 绘本：JSON 解析失败（后缀对但内容坏）时回落成普通文件，
        // 用户至少能在播放器里看到这个文件，而不是「点了导入什么都没发生」
        const bookFiles = list.filter((f) => f && isAiBookFileName(f.name || ''));
        const afterBooks: File[] = [];
        for (const f of bookFiles) {
            try {
                const book = await readAiBookFile(f);
                const pages = book.pages
                    .map((p) => {
                        const image = p.image.trim();
                        // 常规形态是内联 data URL，转成 blob: 后入列（见 utils 的 .aibook 段）；
                        // 手写的 .aibook 也可能直接引用网络图片，这类原样透传。
                        const url = /^data:/i.test(image)
                            ? dataUrlToBlobUrl(image)
                            : (/^(https?|blob):/i.test(image) ? image : '');
                        return { url, text: p.text, audio: p.audio };
                    })
                    .filter((p) => p.url);
                if (pages.length === 0) throw new Error('绘本内没有可用图片');
                methods.addAiBook(book.title, pages);
                setPackStatus(`✅ 已导入绘本《${book.title}》（${pages.length} 页）`);
            } catch (err) {
                setPackStatus(`⚠️ ${f.name} 不是有效的 .aibook：${err instanceof Error ? err.message : '解析失败'}`);
                afterBooks.push(f);
            }
        }

        const rest = list.filter((f) => !bookFiles.includes(f));
        const pending = [...afterBooks, ...rest];
        if (pending.length === 0) return;

        const galleryFiles = pending.filter((f) => f && /\.gallery$/i.test(f.name || ''));
        if (galleryFiles.length === 0) {
            methods.addFiles(pending);
            return;
        }
        const checks = await Promise.all(
            galleryFiles.map(async (f) => ({ file: f, isPack: await isGalleryPackFile(f) }))
        );
        const packSet = new Set(checks.filter((c) => c.isPack).map((c) => c.file));
        const loose = pending.filter((f) => !packSet.has(f));
        if (loose.length > 0) methods.addFiles(loose);
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

    // 绘本生成完成：把故事分页与图片一起入列，并关掉生成器。
    // 连同生成器已建好的 blob: 一起交出（所有权转移），避免同一张图存在两个
    // Blob URL 而其中一个永远没人回收。
    const handleStoryComplete = useCallback((story: AiStory, sources: StoryPageSource[]) => {
        const pages = sources.map((s, i) => ({
            file: s.file,
            url: s.url,
            text: story.pages[i] || '',
        }));
        methods.addAiBook(story.title, pages);
        setShowGenerator(false);
        setPackStatus(`✅ 故事《${story.title}》已加入播放列表（${pages.length} 页）`);
    }, [methods]);

    // 导出当前绘本为单文件 .aibook（图片内联 data URL，文案与语音一并带走）
    const handleExportBook = useCallback(async (file: VideoFile) => {
        const groupId = file.groupId;
        if (!groupId) return;
        const pages = playlist.files.filter((f) => f.groupId === groupId);
        if (pages.length === 0) return;
        setPackStatus('正在打包绘本…');
        try {
            const payload = [];
            for (const p of pages) {
                // 本地 File 直接读；导入的绘本只有 blob: URL，取回字节再编码
                const image = p.file ? await toDataUrl(p.file) : await toDataUrl(p.url);
                payload.push({ image, text: p.description || '', audio: p.audioData || undefined });
            }
            const title = file.groupName || 'My AI Story';
            const blob = buildAiBookBlob(title, payload);
            const fileName = `${sanitizeBookName(title)}.aibook`;
            const api = getElectronAPI();
            if (api?.galleryPack?.savePack) {
                const res = await api.galleryPack.savePack({ fileName, data: await blob.arrayBuffer() });
                setPackStatus(res.success ? `✅ ${res.message}` : `ℹ️ ${res.message || '未保存'}`);
            } else {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.append(a);
                a.click();
                a.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                setPackStatus(`✅ 已导出《${title}》`);
            }
        } catch (err) {
            setPackStatus(`❌ 导出失败：${err instanceof Error ? err.message : '未知错误'}`);
        }
    }, [playlist.files]);

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

    /* ---------------------------------------------------------------------- */
    /* 拖拽导入                                                                */
    /* ---------------------------------------------------------------------- */
    // 空态文案一直写着「拖拽文件到播放器」，但整条链路从未实现过拖拽处理：
    // 拖进来的文件会被 Electron 直接导航打开。这里补上。
    // dragenter/dragleave 会在子元素间反复冒泡，用计数器判断是否真的离开了窗口，
    // 否则鼠标一划过子元素提示层就闪一下。
    const [isDragging, setIsDragging] = useState(false);
    const dragDepthRef = useRef(0);

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
        // 必须阻止默认行为，否则浏览器不会触发 drop，而是直接打开文件
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        // 这里**不能**用 hasFiles 守卫：dragleave 的 dataTransfer.types 在部分场景
        // （拖出窗口、拖拽被取消）是空的，一旦提前 return，计数器就永远减不回去，
        // 提示层会一直糊在画面上。递减用 Math.max 夹底，多余的 dragleave 无害。
        e.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDragging(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        setIsDragging(false);
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) void importFilesSmart(files);
    }, [importFilesSmart]);

    // 兜底收尾：拖到窗口外松手、或拖拽被取消时，drop 不会触发。
    // dragend 只在拖拽源上触发（跨窗口拖入时根本不发），所以还要认「真正离开窗口」
    // 的 dragleave —— relatedTarget 为 null 即指针离开了文档。
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
    // AI 绘本页：走「左图右文」阅读器版式而不是普通图片浏览。
    // 只按分组判定，不要求本页有文案——同一本书里各页版式必须一致，
    // 否则某页文案缺失就会突然退回普通图片视图，翻页时版式来回跳。
    const storyPages = useMemo(
        () => (currentFile?.groupType === 'ai-book' && currentFile.groupId
            ? playlist.files.filter((f) => f.groupId === currentFile.groupId)
            : []),
        [playlist.files, currentFile?.groupType, currentFile?.groupId]
    );
    const isStoryPage = !!currentFile && storyPages.length > 0;
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
        // 绘本正文区是可选中的阅读内容：单击不该被当成「暂停」，
        // 否则用户想划词复制一段文案，画面先停了
        if (target.closest?.('[data-text-select]')) return;
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
    // 绘本页要读文案，4 秒根本读不完，按阅读节奏给 12 秒；普通图片维持 4 秒。
    useEffect(() => {
        if (currentFile?.mediaType !== 'image' || !state.isPlaying) return;
        const rate = Number.isFinite(state.playbackRate) && state.playbackRate > 0 ? state.playbackRate : 1;
        const baseMs = isStoryPage ? 12000 : 4000;
        const timer = setInterval(() => {
            methods.nextPage();
        }, Math.max(500, Math.round(baseMs / rate)));
        return () => clearInterval(timer);
    }, [currentFile?.mediaType, currentFile?.id, state.isPlaying, state.playbackRate, methods, isStoryPage]);

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
        /** AI 绘本组：图标与副标题文案与画廊区分 */
        book?: boolean;
        children: TreeFileLeaf[];
    }
    interface TreeFolderNode {
        kind: 'folder';
        id: string;
        name: string;
        children: TreeNode[];
    }
    type TreeNode = TreeFileLeaf | TreeGroupNode | TreeFolderNode;

    // 成组条目：画廊（.gallery/ACG 图集）与 AI 绘本都按「组」折叠展示，
    // 差别只在图标与副标题文案。散文件不满足任何一条，正常平铺。
    const isGroupedFile = useCallback((file: VideoFile): boolean => {
        if (!file.groupId) return false;
        return file.groupType === 'gallery'
            || file.groupType === 'ai-book'
            || file.groupId.startsWith('acg:')
            || file.groupId.startsWith('gallery:')
            || file.groupId.startsWith('aibook:');
    }, []);

    /** 该组是否为 AI 绘本（决定图标与「N 页」文案） */
    const isBookFile = useCallback((file: VideoFile): boolean =>
        file.groupType === 'ai-book' || !!file.groupId?.startsWith('aibook:'), []);

    const leafVisible = useCallback((file: VideoFile): boolean => {
        // 类型筛选：视频与流媒体分开——此前 video 把 stream 一并吞掉，纯 HLS 直播/音轨
        // 会被算进「视频」，用户按「视频」筛却看到音频，按「音频」筛又找不到它。
        let typeOk = true;
        if (playlistFilter === 'video') typeOk = file.mediaType === 'video';
        else if (playlistFilter === 'stream') typeOk = file.mediaType === 'stream';
        else if (playlistFilter === 'audio') typeOk = file.mediaType === 'audio';
        else if (playlistFilter === 'image') typeOk = file.mediaType === 'image';
        else if (playlistFilter === 'document') typeOk = file.mediaType === 'document';
        else if (playlistFilter === 'gallery') typeOk = file.mediaType === 'gallery' || file.groupType === 'gallery';
        else if (playlistFilter === 'book') typeOk = isBookFile(file);
        if (!typeOk) return false;

        // 关键词：名称或所属分组名命中即保留。带上分组名是必要的——
        // 搜「某本画册」时用户期望看到它下面的每一页，而不是因为子页标题里
        // 没有这几个字就整组消失。
        if (!listQuery) return true;
        const q = listQuery;
        return file.name.toLowerCase().includes(q) || (file.groupName || '').toLowerCase().includes(q);
    }, [playlistFilter, isBookFile, listQuery]);

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
            if (isGroupedFile(file)) {
                const gid = file.groupId!;
                const book = isBookFile(file);
                let node = groupMap.get(gid);
                if (!node) {
                    node = {
                        kind: 'group',
                        id: `group:${gid}`,
                        name: file.groupName || (book ? '未命名绘本' : '未命名画廊'),
                        gallery: !book,
                        book,
                        children: [],
                    };
                    groupMap.set(gid, node);
                    roots.push(node);
                } else if (file.groupName && (node.name === '未命名画廊' || node.name === '未命名绘本')) {
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
    }, [playlist.files, playlistFilter, listQuery]);

    /**
     * 各分类的条目数，给过滤标签做角标。
     * 用同一套 leafVisible 判定，但把搜索词排除在外——角标要回答的是
     * 「这个分类里一共有多少」，而不是「当前搜索命中了多少」，
     * 否则一搜索所有角标一起归零，看着像列表被清空了。
     */
    const filterCounts = useMemo(() => {
        const counts = {
            all: 0, video: 0, stream: 0, audio: 0,
            image: 0, gallery: 0, book: 0, document: 0,
        };
        for (const f of playlist.files) {
            counts.all += 1;
            if (f.mediaType === 'video') counts.video += 1;
            else if (f.mediaType === 'stream') counts.stream += 1;
            else if (f.mediaType === 'audio') counts.audio += 1;
            else if (f.mediaType === 'image') counts.image += 1;
            else if (f.mediaType === 'document') counts.document += 1;
            if (f.mediaType === 'gallery' || f.groupType === 'gallery') counts.gallery += 1;
            if (isBookFile(f)) counts.book += 1;
        }
        return counts;
    }, [playlist.files, isBookFile]);

    // —— 工作区文件树渲染 ——
    const renderFileRow = (file: VideoFile, originalIndex: number, depth: number) => {
        const isActive = playlist.currentIndex === originalIndex;
        const TypeIcon = MEDIA_TYPE_ICON[file.mediaType] || FileQuestion;
        // 正在出声的那一条：只有它显示跳动指示条，而不是所有行都点一个静止圆点
        const isSounding = isActive && state.isPlaying;
        return (
            <div
                key={file.id || originalIndex}
                onClick={() => methods.selectTrack(originalIndex)}
                style={{ paddingLeft: 14 + depth * 14 }}
                className={`relative flex items-center gap-2.5 pr-3 py-2 cursor-pointer group transition-colors duration-150 ${isActive
                    ? 'bg-indigo-500/15 text-white'
                    : 'hover:bg-white/5 text-slate-400 hover:text-slate-200'
                    }`}
            >
                {/* 选中指示条：比整行左侧 4px 边框更克制，不会让列表看起来歪掉 */}
                {isActive && <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-indigo-400" />}

                <div className={`shrink-0 transition-colors ${isActive ? MEDIA_TYPE_ACCENT[file.mediaType] : 'text-slate-500 group-hover:text-slate-300'}`}>
                    <TypeIcon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                    <p
                        className={`text-xs truncate leading-5 ${isActive ? 'text-white font-bold' : ''}`}
                        title={file.description && file.description !== file.name ? `${file.name}（${file.description}）` : file.name}
                    >
                        {file.name}
                    </p>
                    <p className="text-[10px] text-slate-500 font-mono mt-0.5 flex items-center gap-1.5">
                        <span className="shrink-0">{file.page != null ? `P${file.page}` : `#${originalIndex + 1}`}</span>
                        <span className="opacity-50">·</span>
                        <span className="truncate">{MEDIA_TYPE_LABEL[file.mediaType]}</span>
                        {file.artist && (
                            <>
                                <span className="opacity-50">·</span>
                                <span className="truncate">{file.artist}</span>
                            </>
                        )}
                    </p>
                </div>

                {isSounding && <EqualizerBars active className="text-indigo-400 shrink-0" />}

                <IconButton
                    label="移除"
                    size="sm"
                    tone="danger"
                    className="tp-row-action !p-1"
                    onClick={(e) => {
                        e.stopPropagation();
                        methods.removeTrack(originalIndex);
                    }}
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </IconButton>
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
        const isBook = node.kind === 'group' && !!node.book;

        return (
            <div key={node.id}>
                <div
                    className={`relative flex items-center gap-1.5 pr-3 py-2 cursor-pointer group transition-colors duration-150 ${hasActive
                        ? 'bg-indigo-500/10 text-white'
                        : 'hover:bg-white/5 text-slate-300 hover:text-white'
                        }`}
                    style={{ paddingLeft: 10 + depth * 14 }}
                >
                    {hasActive && <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-indigo-400/70" />}

                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleNode(node.id);
                        }}
                        className="p-0.5 text-slate-500 hover:text-white transition shrink-0"
                        title={collapsed ? '展开' : '收起'}
                        aria-label={collapsed ? '展开分组' : '收起分组'}
                        aria-expanded={!collapsed}
                    >
                        {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    {isBook ? (
                        <Sparkles className={`w-4 h-4 shrink-0 ${hasActive ? 'text-teal-300' : 'text-teal-500/80'}`} />
                    ) : isGallery ? (
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
                        <p className="text-xs font-semibold truncate leading-5">{node.name}</p>
                        <p className="text-[10px] text-slate-500 font-mono mt-0.5 flex items-center gap-1.5">
                            <span className={`px-1 rounded ${isBook ? 'bg-teal-500/15 text-teal-300' : isGallery ? 'bg-amber-500/15 text-amber-300' : 'bg-white/5 text-slate-400'}`}>
                                {isBook ? 'AI 绘本' : isGallery ? '画廊' : '文件夹'}
                            </span>
                            <span>{isBook || isGallery ? `${leafIndexes.length} 页` : `${leafIndexes.length} 项`}</span>
                        </p>
                    </div>
                    <IconButton
                        label={isBook ? '移除整本绘本' : isGallery ? '移除整本画廊' : '移除整个文件夹'}
                        size="sm"
                        tone="danger"
                        className="tp-row-action !p-1"
                        onClick={(e) => {
                            e.stopPropagation();
                            methods.removeTracks(leafIndexes);
                        }}
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </IconButton>
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

    // 音频视图外圈进度环的填充比例（0~1）。duration 为 Infinity/NaN 时按 0 处理，
    // 否则 strokeDashoffset 会算成 NaN，整圈环直接消失。
    const audioProgress = useMemo(() => {
        if (!Number.isFinite(state.duration) || state.duration <= 0) return 0;
        return Math.min(1, Math.max(0, state.currentTime / state.duration));
    }, [state.currentTime, state.duration]);

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
                ref={sidebarRef}
                style={{ width: isSidebarOpen ? sidebarWidth : 0 }}
                className={`relative bg-slate-900/95 backdrop-blur-xl border-r border-white/8 flex flex-col shrink-0 z-30 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full overflow-hidden border-r-0 invisible'
                    } ${resizeCleanupRef.current ? '' : 'transition-[width,transform] duration-300 ease-in-out'}`}
                aria-hidden={!isSidebarOpen}
            >
                {/* 顶部标题与收起/清空操作 */}
                <div className="p-3.5 border-b border-white/8 flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <IconButton label="返回嗅探浏览" size="sm" onClick={onBackToBrowse}>
                                <ArrowLeft className="w-4 h-4" />
                            </IconButton>
                            <h2 className="text-sm font-bold text-white flex items-center gap-1.5 min-w-0">
                                <ListMusic className="w-4 h-4 text-indigo-400 shrink-0" />
                                <span className="truncate">播放列表</span>
                            </h2>
                        </div>

                        <div className="flex items-center gap-0.5 shrink-0">
                            <IconButton
                                label="清空列表"
                                size="sm"
                                tone="danger"
                                onClick={methods.clearPlaylist}
                                disabled={playlist.files.length === 0}
                            >
                                <Trash2 className="w-4 h-4" />
                            </IconButton>
                            <IconButton label="收起播放列表 ([)" size="sm" onClick={() => setIsSidebarOpen(false)}>
                                <PanelLeftClose className="w-4 h-4" />
                            </IconButton>
                        </div>
                    </div>

                    {/* 搜索：列表长起来之后，在折叠树里翻找一条比重新导入还慢 */}
                    <div className="relative flex items-center">
                        <Search className="absolute left-2.5 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
                        <input
                            type="text"
                            value={listQuery}
                            onChange={(e) => setListQuery(e.target.value)}
                            placeholder="搜索名称或分组…"
                            aria-label="搜索播放列表"
                            className="w-full bg-black/40 border border-white/5 rounded-lg pl-8 pr-7 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/50 focus:bg-black/60 transition"
                        />
                        {listQuery && (
                            <IconButton
                                label="清除搜索"
                                size="sm"
                                className="absolute right-0.5 !p-1"
                                onClick={() => setListQuery('')}
                            >
                                <X className="w-3 h-3" />
                            </IconButton>
                        )}
                    </div>

                    {/* 分类过滤：8 个标签固定 4 列两行。角标显示各分类条目数，
                        没有内容的分类直接置灰，省得点进去看空列表。 */}
                    <div className="grid grid-cols-4 gap-1 bg-black/40 p-1 rounded-xl border border-white/5">
                        {(
                            [
                                { key: 'all', label: '全部' },
                                { key: 'video', label: '视频' },
                                { key: 'stream', label: '流媒体' },
                                { key: 'audio', label: '音频' },
                                { key: 'image', label: '图片' },
                                { key: 'gallery', label: '画廊' },
                                { key: 'book', label: '绘本' },
                                { key: 'document', label: '文档' },
                            ] as const
                        ).map((tab) => {
                            const count = filterCounts[tab.key];
                            const active = playlistFilter === tab.key;
                            const empty = count === 0 && tab.key !== 'all';
                            return (
                                <button
                                    key={tab.key}
                                    onClick={() => setPlaylistFilter(tab.key)}
                                    disabled={empty}
                                    title={empty ? `${tab.label}：暂无内容` : `${tab.label}（${count}）`}
                                    className={`relative py-1 px-0.5 text-center text-[11px] rounded-lg transition leading-4 ${active
                                        ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30 font-bold'
                                        : empty
                                            ? 'text-slate-600 cursor-not-allowed'
                                            : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 font-medium'
                                        }`}
                                >
                                    <span>{tab.label}</span>
                                    {/* 角标只在有内容时出现：一排「0」比不显示更吵 */}
                                    {!empty && (
                                        <span className={`ml-0.5 font-mono text-[9px] ${active ? 'text-indigo-100/80' : 'text-slate-500'}`}>
                                            {count > 999 ? '999+' : count}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    {/* 添加按钮组：主操作（添加媒体）独占一行，四个次要入口排成一行。
                        此前五个按钮挤在同一行，主按钮被压到只剩图标宽度。 */}
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full flex items-center justify-center gap-1.5 py-2 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition shadow-md shadow-indigo-600/20 active:scale-[0.98]"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        <span>添加媒体</span>
                    </button>
                    <div className="flex gap-1.5">
                        <button
                            onClick={() => folderInputRef.current?.click()}
                            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-white/5 hover:bg-white/10 text-slate-300 rounded-lg transition border border-white/5 text-[11px] font-medium"
                            title="添加目录（含 .gallery 画廊文件夹自动成组；单文件 .gallery 包自动解包）"
                        >
                            <FolderOpen className="w-3.5 h-3.5" />
                            <span>目录</span>
                        </button>
                        <button
                            onClick={() => setShowUrlModal(true)}
                            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-white/5 hover:bg-white/10 text-slate-300 rounded-lg transition border border-white/5 text-[11px] font-medium"
                            title="添加网络流"
                        >
                            <Link className="w-3.5 h-3.5" />
                            <span>链接</span>
                        </button>
                        <button
                            onClick={() => packFolderInputRef.current?.click()}
                            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-amber-600/15 hover:bg-amber-600/25 text-amber-300 border border-amber-500/25 rounded-lg transition text-[11px] font-medium"
                            title="打包目录为 .gallery 单文件"
                        >
                            <Archive className="w-3.5 h-3.5" />
                            <span>打包</span>
                        </button>
                        <button
                            onClick={() => setShowAcgModal(true)}
                            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-rose-600/15 hover:bg-rose-600/25 text-rose-300 border border-rose-500/25 rounded-lg transition text-[11px] font-medium"
                            title="抓取网络作品 / ACG（免下载直推到播放器）"
                        >
                            <Sparkles className="w-3.5 h-3.5" />
                            <span>抓取</span>
                        </button>
                    </div>
                </div>

                {/* 隐藏的本地文件/目录输入 */}
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="video/*,audio/*,image/*,.gallery,.aibook,.md,.markdown,.txt,.log,.json,.pdf,.m4s,.ts"
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
                    <div className="mx-3.5 mt-2.5 px-2.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] leading-4 text-amber-200/90 break-all">
                        {packStatus}
                    </div>
                )}

                {/* 工作区文件树：画廊成组、文件夹嵌套、散文件平铺 */}
                <div className="flex-1 overflow-y-auto custom-scrollbar py-1">
                    {playlistTree.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-48 text-slate-500 text-xs gap-2.5 px-4 text-center">
                            {playlist.files.length === 0 ? (
                                <>
                                    <Inbox className="w-7 h-7 opacity-30" />
                                    <span>播放列表是空的</span>
                                    <span className="text-[11px] text-slate-600 leading-4">
                                        点击上方「添加媒体」导入本地文件，或拖拽文件到播放器
                                    </span>
                                </>
                            ) : (
                                <>
                                    <Search className="w-6 h-6 opacity-30" />
                                    <span>没有匹配的媒体</span>
                                    {(listQuery || playlistFilter !== 'all') && (
                                        <button
                                            onClick={() => { setListQuery(''); setPlaylistFilter('all'); }}
                                            className="mt-0.5 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 text-[11px] transition border border-white/5"
                                        >
                                            清除筛选条件
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    ) : (
                        playlistTree.map((node) => renderTreeNode(node, 0))
                    )}
                </div>

                {/* 宽度拖拽手柄：绝对定位在右边缘，视觉上只有 1px 竖线，
                    但命中区左右各外扩 3px，避免要精确到像素才能拖到 */}
                {isSidebarOpen && (
                    <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="拖拽调整播放列表宽度（双击复位）"
                        onMouseDown={startSidebarResize}
                        onTouchStart={startSidebarResize}
                        onDoubleClick={resetSidebarWidth}
                        title="拖拽调整宽度 · 双击复位"
                        className="absolute top-0 -right-1 bottom-0 w-2 cursor-col-resize group/resize z-40 flex justify-center"
                    >
                        <span className="w-px h-full bg-white/8 group-hover/resize:bg-indigo-500/60 group-hover/resize:w-0.5 transition-all" />
                    </div>
                )}
            </div>

            {/* ========================================================================= */}
            {/* 右侧：纯视频/媒体主容器 (独立绑定制胜真全屏与沉浸式体验)                 */}
            {/* ========================================================================= */}
            <div
                ref={playerContainerRef}
                onMouseMove={resetControlsTimer}
                onTouchStart={resetControlsTimer}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`flex-1 flex flex-col relative overflow-hidden bg-black select-none tp-player-main ${state.isFullscreen && !isControlsVisible ? 'cursor-none' : ''
                    }`}
            >
                {/* 顶部浮层：侧边栏唤起按钮、标题与小窗/全屏快捷按钮。
                    左侧放「你在看什么」（名称 + 所属分组 + 类型），右侧放操作。 */}
                <div
                    className={`absolute top-0 left-0 right-0 z-30 flex items-center justify-between gap-3 px-4 py-3 bg-gradient-to-b from-black/90 via-black/50 to-transparent transition-opacity duration-300 pointer-events-auto ${isControlsVisible || !state.isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
                        }`}
                >
                    <div className="flex items-center gap-2 min-w-0">
                        {!isSidebarOpen && (
                            <button
                                onClick={() => setIsSidebarOpen(true)}
                                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900/80 hover:bg-slate-800 text-slate-200 hover:text-white rounded-xl backdrop-blur border border-white/10 text-xs font-semibold shadow-xl transition shrink-0"
                                title="展开播放列表 ([)"
                            >
                                <PanelLeftOpen className="w-4 h-4 text-indigo-400" />
                                <span>列表</span>
                            </button>
                        )}

                        {currentFile && (
                            <div className="flex items-center gap-2 min-w-0">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-xs font-bold text-slate-100 truncate" title={currentFile.name}>
                                            {currentFile.name}
                                        </span>
                                        {currentFile.mediaType && (
                                            <Pill tone={MEDIA_TYPE_TONE[currentFile.mediaType]}>
                                                {MEDIA_TYPE_LABEL[currentFile.mediaType]}
                                            </Pill>
                                        )}
                                    </div>
                                    {/* 第二行只在有信息可给时出现：分组名 / 页码 / 画师。
                                        画集与绘本动辄上百页，不显示「第几页」就只能靠数。 */}
                                    {(currentFile.groupName || pageInfo.grouped || currentFile.artist) && (
                                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-400 font-mono truncate">
                                            {currentFile.groupName && (
                                                <span className="truncate max-w-[280px]" title={currentFile.groupName}>
                                                    {currentFile.groupName}
                                                </span>
                                            )}
                                            {pageInfo.grouped && pageInfo.total > 1 && (
                                                <span className="shrink-0 text-indigo-300">
                                                    {pageInfo.index} / {pageInfo.total}
                                                </span>
                                            )}
                                            {currentFile.artist && (
                                                <span className="truncate max-w-[160px]" title={currentFile.artist}>
                                                    {currentFile.artist}
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                        {/* AI 绘本入口：与其他控制项同处顶部浮层，随控制条一起淡出 */}
                        <button
                            onClick={() => setShowGenerator(true)}
                            className="px-2.5 py-1.5 bg-teal-600/20 hover:bg-teal-600/30 text-teal-300 border border-teal-500/30 rounded-xl backdrop-blur text-xs font-semibold flex items-center gap-1.5 transition shadow-lg"
                            title="上传一组图片，让 AI 编成一个故事"
                        >
                            <Sparkles className="w-3.5 h-3.5" />
                            <span className="tp-book-label">AI 绘本</span>
                        </button>

                        {/* 绘本导出：只在读绘本时出现，把整组打包成单文件 .aibook */}
                        {isStoryPage && (
                            <button
                                onClick={() => void handleExportBook(currentFile as VideoFile)}
                                className="px-2.5 py-1.5 bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white rounded-xl backdrop-blur border border-white/10 text-xs font-semibold flex items-center gap-1.5 transition shadow-lg"
                                title="导出为单文件 .aibook（含文案与语音）"
                            >
                                <Archive className="w-3.5 h-3.5" />
                                <span className="tp-book-label">导出绘本</span>
                            </button>
                        )}

                        {(currentFile?.mediaType === 'video' || currentFile?.mediaType === 'stream') && document.pictureInPictureEnabled && (
                            <button
                                onClick={() => methods.togglePip()}
                                className="px-2.5 py-1.5 bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white rounded-xl backdrop-blur border border-white/10 text-xs font-semibold flex items-center gap-1.5 transition shadow-lg"
                                title="画中画模式 (PiP)"
                            >
                                <Tv className="w-3.5 h-3.5" />
                                <span className="tp-pip-label">画中画</span>
                            </button>
                        )}

                        <button
                            onClick={handleToggleFullscreen}
                            className="p-2 bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white rounded-xl backdrop-blur border border-white/10 transition shadow-lg"
                            title={state.isFullscreen ? '退出全屏 (F / Esc)' : '真正视频全屏 (F)'}
                            aria-label={state.isFullscreen ? '退出全屏' : '全屏'}
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
                    控制条自动隐藏（幻灯片播放中）时再让出空间，长图不被永久压小。
                    绘本阅读器同理：右栏底部的「朗读故事」按钮被盖住就点不到了。 */}
                <div
                    className={`flex-1 relative flex items-center justify-center overflow-hidden transition-[padding] duration-300 ${pagedKind && (isControlsVisible || !state.isPlaying) ? 'pb-28' : 'pb-0'
                        }`}
                    onClick={handleVideoAreaClick}
                >
                    {currentFile ? (
                        isStoryPage ? (
                            <StoryReader
                                file={currentFile}
                                pages={storyPages}
                                onCacheAudio={methods.cacheAudioData}
                                onPrevPage={methods.prevPage}
                                onNextPage={methods.nextPage}
                            />
                        ) : currentFile.mediaType === 'image' ? (
                            <div className="relative w-full h-full flex items-center justify-center p-2 select-none">
                                <img
                                    src={currentFile.url}
                                    alt={currentFile.name}
                                    referrerPolicy="no-referrer"
                                    className="max-w-full max-h-full object-contain pointer-events-auto shadow-2xl"
                                />
                                <div className="absolute top-16 right-4 z-10 flex items-center gap-2">
                                    <Pill tone="emerald" className="!px-2.5 !py-1 !text-[11px] !font-mono backdrop-blur bg-slate-900/80">
                                        <ImageIcon className="w-3 h-3" />
                                        {pageInfo.index} / {pageInfo.total}
                                    </Pill>
                                    {state.isPlaying && state.playbackRate !== 1 && (
                                        <Pill
                                            tone="indigo"
                                            className="!px-2 !py-1 !text-[11px] !font-mono backdrop-blur bg-slate-900/80"
                                            title="轮播间隔跟随倍速"
                                        >
                                            {state.playbackRate}x 轮播
                                        </Pill>
                                    )}
                                </div>
                            </div>
                        ) : currentFile.mediaType === 'audio' ? (
                            // 音频没有画面，空占满屏黑底会让整个视口显得「坏了」。
                            // 用同心唱片 + 外圈进度环填满：底栏进度条离视线中心很远，
                            // 这里再给一圈实时进度，暂停/播放一眼可辨。
                            <div className="flex flex-col items-center justify-center gap-6 p-8 text-center select-none">
                                <video ref={videoRef} className="hidden" />
                                <div className="relative flex items-center justify-center">
                                    {state.isPlaying && (
                                        <>
                                            <span className="absolute w-56 h-56 rounded-full border border-indigo-500/30 animate-orb-sonar" />
                                            <span className="absolute w-56 h-56 rounded-full border border-cyan-400/25 animate-orb-sonar-delayed" />
                                        </>
                                    )}

                                    <svg className="absolute w-56 h-56 -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
                                        <circle cx="50" cy="50" r="47" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1.5" />
                                        <circle
                                            cx="50" cy="50" r="47" fill="none" strokeWidth="1.5" strokeLinecap="round"
                                            stroke="url(#tp-audio-ring)"
                                            strokeDasharray={2 * Math.PI * 47}
                                            strokeDashoffset={2 * Math.PI * 47 * (1 - audioProgress)}
                                            style={{ transition: 'stroke-dashoffset 300ms linear' }}
                                        />
                                        <defs>
                                            <linearGradient id="tp-audio-ring" x1="0" y1="0" x2="1" y2="1">
                                                <stop offset="0%" stopColor="#818cf8" />
                                                <stop offset="100%" stopColor="#22d3ee" />
                                            </linearGradient>
                                        </defs>
                                    </svg>

                                    <div
                                        className={`w-44 h-44 rounded-full border border-indigo-400/30 flex items-center justify-center shadow-2xl relative ${state.isPlaying ? 'animate-spin' : ''}`}
                                        style={{
                                            animationDuration: '12s',
                                            background:
                                                'repeating-radial-gradient(circle at 50% 50%, rgba(99,102,241,0.16) 0 2px, rgba(2,6,23,0) 2px 9px), radial-gradient(circle at 50% 50%, #1e1b4b 0%, #020617 72%)',
                                        }}
                                    >
                                        {/* 唱片高光，避免纯平圆盘显得呆板 */}
                                        <span className="absolute inset-0 rounded-full bg-gradient-to-tr from-white/10 via-transparent to-transparent" />
                                        <div className="w-16 h-16 rounded-full bg-slate-950 border border-white/10 flex items-center justify-center shadow-inner z-10">
                                            <Music className="w-7 h-7 text-indigo-400" />
                                        </div>
                                    </div>
                                </div>

                                <div className="max-w-lg min-w-0">
                                    <h2 className="text-lg font-bold text-white truncate" title={currentFile.name}>
                                        {currentFile.name}
                                    </h2>
                                    {currentFile.artist && (
                                        <p className="text-xs text-slate-400 mt-1 truncate">{currentFile.artist}</p>
                                    )}
                                    {/* 地址通常很长且无意义，收成一行小字；悬停给全量 */}
                                    <p className="text-[10px] text-slate-600 mt-1 font-mono truncate" title={currentFile.url}>
                                        {currentFile.url}
                                    </p>
                                    <div className="flex items-center justify-center gap-2 mt-3">
                                        <Pill tone={state.isPlaying ? 'emerald' : 'slate'}>
                                            <EqualizerBars active={state.isPlaying} />
                                            {state.isPlaying ? '正在播放' : '已暂停'}
                                        </Pill>
                                        {Number.isFinite(state.duration) && state.duration > 0 && (
                                            <Pill tone="slate" className="!font-mono">
                                                {formatTime(state.currentTime)} / {formatTime(state.duration)}
                                            </Pill>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-slate-600 mt-2">点击画面或按空格切换播放</p>
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
                        // 空态：这是用户进播放器看到的第一屏，此前只有一行灰字 + 四个挤在
                        // 一起的按钮。改成「主操作卡 + 次要入口」两级，并把拖拽这条路径写出来
                        // （拖拽确实可用，但界面上从未提过）。
                        <div className="flex flex-col items-center justify-center px-6 py-10 text-center max-w-2xl">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-cyan-500/10 border border-white/10 flex items-center justify-center mb-5 shadow-2xl">
                                <Play className="w-7 h-7 text-indigo-400 fill-current ml-0.5" />
                            </div>
                            <h2 className="text-lg font-bold text-white">播放列表是空的</h2>
                            <p className="text-xs text-slate-500 mt-2 leading-5 max-w-sm">
                                导入本地视频、音频、图片或文档开始播放，也可以直接抓取网络作品或让 AI 把一组图片编成绘本。
                            </p>

                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-7 w-full">
                                {(
                                    [
                                        { key: 'file', icon: Plus, label: '本地媒体', hint: '视频 / 音频 / 图片', tone: 'indigo', onClick: () => fileInputRef.current?.click() },
                                        { key: 'url', icon: Link, label: '网络流', hint: 'HTTP / HLS 直链', tone: 'slate', onClick: () => setShowUrlModal(true) },
                                        { key: 'acg', icon: Sparkles, label: '抓取作品', hint: '免下载直推', tone: 'rose', onClick: () => setShowAcgModal(true) },
                                        { key: 'book', icon: Archive, label: 'AI 绘本', hint: '读图成书', tone: 'teal', onClick: () => setShowGenerator(true) },
                                    ] as const
                                ).map(({ key, icon: Icon, label, hint, tone, onClick }) => {
                                    const tones: Record<string, string> = {
                                        indigo: 'hover:border-indigo-500/50 hover:bg-indigo-500/10 text-indigo-300',
                                        slate: 'hover:border-white/20 hover:bg-white/5 text-slate-300',
                                        rose: 'hover:border-rose-500/50 hover:bg-rose-500/10 text-rose-300',
                                        teal: 'hover:border-teal-500/50 hover:bg-teal-500/10 text-teal-300',
                                    };
                                    return (
                                        <button
                                            key={key}
                                            onClick={onClick}
                                            className={`flex flex-col items-center gap-1.5 py-4 px-2 rounded-xl border border-white/8 bg-white/[0.02] transition active:scale-[0.98] ${tones[tone]}`}
                                        >
                                            <Icon className="w-5 h-5" />
                                            <span className="text-xs font-bold text-slate-200">{label}</span>
                                            <span className="text-[10px] text-slate-500">{hint}</span>
                                        </button>
                                    );
                                })}
                            </div>

                            <p className="text-[11px] text-slate-600 mt-6 flex items-center gap-1.5">
                                <GripVertical className="w-3.5 h-3.5" />
                                也可以把文件或文件夹直接拖进播放器
                            </p>
                        </div>
                    )}

                    {/* 缓冲加载中指示器：环形 + 文案，比一个孤零零的转圈更能说明在等什么 */}
                    {state.isBuffering && !mediaError && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40 backdrop-blur-sm pointer-events-none z-20">
                            <div className="w-11 h-11 border-[3px] border-indigo-500 border-t-transparent rounded-full animate-spin shadow-2xl" />
                            <span className="text-[11px] text-slate-300 font-medium">正在缓冲…</span>
                        </div>
                    )}

                    {/* 非致命警告横幅：能播，但内容有缺失（如源站丢了分片已跳过）。
                        刻意用琥珀色且放在错误横幅**上方**、更靠下（top-16 与错误重叠位置错开）——
                        它和错误是两件事：错误要用户手动关掉，警告只是告知，不打断观看。
                        用 min-w-0 + break-words 而不是 line-clamp：警告文案会随跳过段数
                        累积变长，截断后就说不清到底跳了多少。 */}
                    {mediaWarning && !mediaError && (
                        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-950/90 border border-amber-500/40 text-amber-200 text-xs shadow-2xl backdrop-blur max-w-[90%]">
                            <AlertTriangle className="shrink-0 mt-0.5 w-3.5 h-3.5" />
                            <span className="leading-5 break-words">{mediaWarning}</span>
                            <IconButton label="关闭" size="sm" className="!p-1 shrink-0" onClick={() => methods.clearWarning()}>
                                <X className="w-3.5 h-3.5" />
                            </IconButton>
                        </div>
                    )}

                    {/* 媒体错误横幅（替代此前的静默失败） */}
                    {mediaError && (
                        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 flex items-start gap-3 px-4 py-3 rounded-xl bg-rose-950/90 border border-rose-500/40 text-rose-200 text-xs shadow-2xl backdrop-blur max-w-[90%]">
                            <span className="shrink-0 mt-0.5 w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
                            {/* 用 line-clamp 而不是 truncate：错误信息（含 URL 与原因）
                                单行截断后往往只剩开头几个字，等于没提示 */}
                            <span className="leading-5 line-clamp-3 break-all">{mediaError}</span>
                            <IconButton label="关闭" size="sm" className="!p-1 shrink-0" onClick={() => methods.clearError()}>
                                <X className="w-3.5 h-3.5" />
                            </IconButton>
                        </div>
                    )}

                    {/* 拖拽导入提示层：拖拽在窗口任意位置都生效，提示层只是把它可视化 */}
                    {isDragging && (
                        <div className="absolute inset-0 z-40 flex items-center justify-center bg-indigo-950/70 backdrop-blur-sm pointer-events-none">
                            <div className="flex flex-col items-center gap-3 px-10 py-8 rounded-2xl border-2 border-dashed border-indigo-400/60 bg-slate-950/60">
                                <Plus className="w-8 h-8 text-indigo-300" />
                                <span className="text-sm font-bold text-white">松开即可导入</span>
                                <span className="text-[11px] text-slate-400">支持视频 / 音频 / 图片 / 文档，以及 .gallery、.aibook</span>
                            </div>
                        </div>
                    )}
                </div>

                {/* ========================================================================= */}
                {/* 底部悬浮控制底栏 (带渐变遮罩与沉浸式自动隐藏)                            */}
                {/* ========================================================================= */}
                {/* 未选择媒体时整条底栏都是死的：进度条 00:00/00:00、播放键点了没反应、
                    倍速/画幅/CONTAIN 全无对象。空态隐藏，让画面中央的引导按钮成为唯一焦点。 */}
                <div
                    className={`absolute bottom-0 left-0 right-0 z-30 px-3 sm:px-4 pt-4 pb-3 bg-gradient-to-t from-black/95 via-black/80 to-transparent backdrop-blur-md flex-col gap-1.5 transition-all duration-300 ${currentFile ? 'flex pointer-events-auto' : 'hidden pointer-events-none'} ${isControlsVisible || !state.isPlaying ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0 pointer-events-none'
                        }`}
                >
                    {/* 进度区：分页媒体给「第几页」滑杆，时间型媒体给时间轴 */}
                    {pagedKind ? (
                        <div className="flex items-center gap-2 sm:gap-3">
                            <button
                                onClick={() => methods.selectTrack(pageInfo.firstIndex)}
                                className="text-[11px] font-mono text-slate-400 hover:text-white px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 transition shrink-0"
                                title={pageInfo.grouped ? '本画廊首页' : '首项'}
                            >
                                1
                            </button>
                            <div className="flex-1 min-w-0 flex items-center">
                                <RangeSlider
                                    label="翻页进度"
                                    min={pageInfo.firstIndex}
                                    max={Math.max(pageInfo.lastIndex, pageInfo.firstIndex)}
                                    step={1}
                                    color={MEDIA_TYPE_HEX[currentFile?.mediaType || 'image']}
                                    value={playlist.currentIndex >= 0 ? playlist.currentIndex : pageInfo.firstIndex}
                                    onChange={(v) => methods.selectTrack(Math.round(v))}
                                />
                            </div>
                            <span className="text-xs font-mono text-slate-200 font-bold shrink-0 tabular-nums">
                                {pageInfo.index}
                                <span className="text-slate-500 font-normal"> / {pageInfo.total}</span>
                            </span>
                            <button
                                onClick={() => methods.selectTrack(pageInfo.lastIndex)}
                                className="text-[11px] font-mono text-slate-400 hover:text-white px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 transition shrink-0"
                                title={pageInfo.grouped ? '本画廊末页' : '末项'}
                            >
                                {pageInfo.total}
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2 sm:gap-3">
                            <span className="text-xs font-mono text-slate-300 shrink-0 tabular-nums">
                                {formatTime(state.currentTime)}
                            </span>

                            <div className="flex-1 min-w-0">
                                <ProgressBar
                                    currentTime={state.currentTime}
                                    duration={state.duration}
                                    bufferedEnd={bufferedEnd}
                                    onSeek={methods.seek}
                                    isLive={isLiveStream}
                                />
                            </div>

                            <span className="text-xs font-mono text-slate-500 shrink-0 tabular-nums">
                                {isLiveStream ? 'LIVE' : formatTime(state.duration)}
                            </span>
                        </div>
                    )}

                    {/* 控制按钮组。
                        此前用 justify-between 均分三组：中间那组（真正的播放控制）因为
                        两侧宽度不等而被挤得偏离画面中心，窄窗口下还会和右侧倍速/画幅重叠。
                        改成 1fr / auto / 1fr 三栏，中间恒定居中；窄屏隐藏左右两栏的次要控件。 */}
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 pt-0.5">
                        {/* 左栏：播放模式 + 音量 */}
                        <div className="flex items-center gap-1 sm:gap-2 justify-self-start min-w-0">
                            <IconButton
                                label={`播放模式：${PLAYBACK_MODE_LABEL[state.playbackMode]}（点击切换）`}
                                onClick={cycleMode}
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
                            </IconButton>

                            {/* 音量：静音键常驻，滑杆在窄容器收起（见 index.css 的容器查询；
                                键盘 ↑↓ 与静音键 M 仍可用） */}
                            <div className="tp-vol-slider flex items-center gap-1.5">
                                <IconButton
                                    label={state.isMuted ? '取消静音 (M)' : '静音 (M)'}
                                    onClick={methods.toggleMute}
                                >
                                    {state.isMuted || state.volume === 0 ? (
                                        <VolumeX className="w-4 h-4 text-rose-400" />
                                    ) : state.volume < 0.5 ? (
                                        <Volume1 className="w-4 h-4" />
                                    ) : (
                                        <Volume2 className="w-4 h-4" />
                                    )}
                                </IconButton>
                                <div className="w-16 lg:w-20 flex items-center">
                                    <RangeSlider
                                        label="音量"
                                        min={0}
                                        max={1}
                                        step={0.01}
                                        value={state.isMuted ? 0 : state.volume}
                                        onChange={methods.setVolume}
                                    />
                                </div>
                            </div>
                            {/* 窄容器下音量滑杆整组收起，但静音键不能一起消失：
                                它没有快捷键以外的等价入口，单独补一颗 */}
                            <IconButton
                                label={state.isMuted ? '取消静音 (M)' : '静音 (M)'}
                                onClick={methods.toggleMute}
                                className="tp-mute-compact"
                            >
                                {state.isMuted || state.volume === 0
                                    ? <VolumeX className="w-4 h-4 text-rose-400" />
                                    : <Volume2 className="w-4 h-4" />}
                            </IconButton>
                        </div>

                        {/* 中栏：上一个 / 快退10s / 播放 / 快进10s / 下一个
                            （图集/文档走顺序翻页，不受 Random 影响；时间轴跳转对分页媒体无意义，故隐藏） */}
                        <div className="flex items-center gap-1 sm:gap-2 justify-self-center">
                            <IconButton
                                label={pagedKind ? '上一页 (P / ←)' : '上一个 (P)'}
                                size="lg"
                                tone="ghost"
                                onClick={() => (pagedKind ? methods.prevPage() : methods.prevTrack())}
                            >
                                <SkipBack className="w-[18px] h-[18px]" />
                            </IconButton>

                            {!pagedKind && (
                                <IconButton label="快退 10 秒 (J / ←)" size="lg" tone="ghost" className="tp-seek-btn" onClick={() => handleSeekDelta(-10)}>
                                    <Rewind className="w-4 h-4" />
                                </IconButton>
                            )}

                            {/* 主播放键：尺寸最大、实心强调色，是全条唯一的「重点」 */}
                            <button
                                onClick={methods.togglePlay}
                                className="mx-0.5 p-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl shadow-lg shadow-indigo-600/40 transition hover:scale-105 active:scale-95"
                                title={state.isPlaying ? '暂停 (Space)' : '播放 (Space)'}
                                aria-label={state.isPlaying ? '暂停' : '播放'}
                            >
                                {state.isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 fill-current" />}
                            </button>

                            {!pagedKind && (
                                <IconButton label="快进 10 秒 (L / →)" size="lg" tone="ghost" className="tp-seek-btn" onClick={() => handleSeekDelta(10)}>
                                    <FastForward className="w-4 h-4" />
                                </IconButton>
                            )}

                            <IconButton
                                label={pagedKind ? '下一页 (N / →)' : '下一个 (N)'}
                                size="lg"
                                tone="ghost"
                                onClick={() => (pagedKind ? methods.nextPage() : methods.nextTrack(true))}
                            >
                                <SkipForward className="w-[18px] h-[18px]" />
                            </IconButton>
                        </div>

                        {/* 右栏：倍速、画幅、全屏与帮助 */}
                        <div className="flex items-center gap-0.5 sm:gap-1.5 justify-self-end min-w-0">
                            {/* 倍速切换 */}
                            <div className="relative" ref={rateMenuRef}>
                                <button
                                    onClick={() => setShowRateMenu(!showRateMenu)}
                                    className={`px-2 py-1 text-xs font-semibold rounded-lg border transition tabular-nums ${state.playbackRate !== 1
                                        ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-200'
                                        : 'bg-white/5 border-white/5 text-slate-300 hover:bg-white/10 hover:text-white'
                                        }`}
                                    title={`播放倍速：${state.playbackRate}x`}
                                    aria-haspopup="menu"
                                    aria-expanded={showRateMenu}
                                >
                                    {state.playbackRate}x
                                </button>
                                {showRateMenu && (
                                    <div
                                        role="menu"
                                        className="absolute bottom-full right-0 mb-2 bg-slate-900/95 border border-white/10 rounded-xl shadow-2xl p-1 flex flex-col gap-0.5 z-50 backdrop-blur-xl tp-rise min-w-[76px]"
                                    >
                                        {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0].map((rate) => (
                                            <button
                                                key={rate}
                                                role="menuitemradio"
                                                aria-checked={state.playbackRate === rate}
                                                onClick={() => {
                                                    methods.setPlaybackRate(rate);
                                                    setShowRateMenu(false);
                                                    showFeedback(`倍速 ${rate}x`);
                                                }}
                                                className={`px-3 py-1.5 text-xs rounded-lg text-left transition tabular-nums ${state.playbackRate === rate
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

                            {/* 画面比例：显示中文标签，英文枚举继续留在 title 里备查。
                                只对真正有画面的视频/流媒体有意义——图片与文档恒为
                                contain，音频连 video 元素都是隐藏的，改了看不出任何变化。 */}
                            {(currentFile?.mediaType === 'video' || currentFile?.mediaType === 'stream') && (
                                <button
                                    onClick={cycleFit}
                                    className="tp-fit-btn px-2.5 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-slate-300 hover:text-white border border-white/5 transition text-xs font-semibold whitespace-nowrap"
                                    title={`画面适配：${OBJECT_FIT_LABEL[state.objectFit]}（${state.objectFit}，点击切换）`}
                                >
                                    {OBJECT_FIT_LABEL[state.objectFit]}
                                </button>
                            )}

                            {/* 全屏与帮助在窄容器收起：两者都有快捷键（F / ?），
                                而顶部浮层里还有一颗全屏按钮，不会丢失入口 */}
                            <IconButton
                                label={state.isFullscreen ? '退出全屏 (F / Esc)' : '全屏 (F)'}
                                onClick={handleToggleFullscreen}
                                className="tp-fs-btn"
                            >
                                {state.isFullscreen ? <Minimize2 className="w-4 h-4 text-indigo-400" /> : <Maximize2 className="w-4 h-4" />}
                            </IconButton>

                            <IconButton
                                label="快捷键说明 (?)"
                                onClick={() => setShowShortcuts(true)}
                                className="tp-help-btn"
                            >
                                <HelpCircle className="w-4 h-4" />
                            </IconButton>
                        </div>
                    </div>
                </div>
            </div>

            {/* ========================================================================= */}
            {/* AI 绘本生成器（覆盖主视口的整屏面板）                                     */}
            {/* ========================================================================= */}
            {showGenerator && (
                <StoryGenerator
                    onComplete={handleStoryComplete}
                    onClose={() => setShowGenerator(false)}
                />
            )}

            {/* ========================================================================= */}
            {/* 模态框组                                                                 */}
            {/* ========================================================================= */}

            {/* 网络流添加模态框 */}
            <Modal
                open={showUrlModal}
                onClose={() => setShowUrlModal(false)}
                title="输入网络媒体链接"
                icon={<Link className="w-4 h-4 text-indigo-400" />}
                footer={
                    <>
                        <button
                            onClick={() => setShowUrlModal(false)}
                            className="px-4 py-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl text-xs font-semibold transition"
                        >
                            取消
                        </button>
                        <button
                            onClick={submitUrl}
                            disabled={!urlIsValid}
                            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-xs font-semibold transition shadow-lg shadow-indigo-600/30"
                        >
                            添加并播放
                        </button>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label htmlFor="tp-url-input" className="text-xs text-slate-400 mb-1 block">
                            资源 URL（视频 / 音频 / 图片 / 流）
                        </label>
                        <input
                            id="tp-url-input"
                            type="text"
                            placeholder="https://example.com/live.m3u8 或 .mp4 / .mp3 / .jpg"
                            value={inputUrl}
                            onChange={(e) => setInputUrl(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') submitUrl(); }}
                            className={`w-full bg-slate-950 border rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none font-mono transition ${inputUrl.trim() && !urlIsValid
                                ? 'border-rose-500/60 focus:border-rose-500'
                                : 'border-white/10 focus:border-indigo-500'
                                }`}
                        />
                        {/* 只在用户真的输了东西之后才报错：一打开就红着一条提示很吵 */}
                        {inputUrl.trim() && !urlIsValid && (
                            <p className="text-[11px] text-rose-400 mt-1.5">仅支持 http(s) / blob 链接，已拦截可疑协议</p>
                        )}
                    </div>
                    <div>
                        <label htmlFor="tp-url-title" className="text-xs text-slate-400 mb-1 block">
                            显示名称（可选）
                        </label>
                        <input
                            id="tp-url-title"
                            type="text"
                            placeholder="留空则用链接中的文件名"
                            value={inputTitle}
                            onChange={(e) => setInputTitle(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') submitUrl(); }}
                            className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition"
                        />
                    </div>
                </div>
            </Modal>

            {/* 抓取网络作品 / ACG 直推模态框 */}
            <Modal
                open={showAcgModal}
                onClose={closeAcgModal}
                title="抓取网络作品到播放器"
                icon={<Sparkles className="w-4 h-4 text-rose-400" />}
                footer={
                    <>
                        <button
                            onClick={closeAcgModal}
                            className="px-4 py-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl text-xs font-semibold transition"
                        >
                            取消
                        </button>
                        <button
                            onClick={handleFetchAcg}
                            disabled={!acgInput.trim() || isAcgLoading}
                            className="px-4 py-2 bg-gradient-to-r from-rose-600 to-pink-600 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-xs font-semibold transition shadow-lg shadow-rose-600/30 flex items-center gap-1.5"
                        >
                            {isAcgLoading ? (
                                <>
                                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                    <span>解析中…</span>
                                </>
                            ) : (
                                <>
                                    <Play className="w-3.5 h-3.5 fill-current" />
                                    <span>抓取并播放</span>
                                </>
                            )}
                        </button>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label htmlFor="tp-acg-input" className="text-xs text-slate-400 mb-1 block">
                            作品链接或 GID
                        </label>
                        <input
                            id="tp-acg-input"
                            type="text"
                            placeholder="https://www.acgmho.com/h/12345 或作品 ID"
                            value={acgInput}
                            onChange={(e) => setAcgInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleFetchAcg(); }}
                            disabled={isAcgLoading}
                            className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-rose-500 font-mono disabled:opacity-60 transition"
                        />
                        <p className="text-[11px] text-slate-500 mt-1.5">支持漫画、动图、动画视频与有声音频，免下载直接推送到播放器</p>
                    </div>

                    {acgStatus && (
                        <div
                            role="status"
                            aria-live="polite"
                            className={`flex items-start gap-2 p-3 rounded-xl border text-xs ${acgStatusIsError
                                ? 'bg-rose-500/10 border-rose-500/30 text-rose-200'
                                : 'bg-slate-950/80 border-white/5 text-slate-300'
                                }`}
                        >
                            {isAcgLoading && (
                                <div className="w-3.5 h-3.5 mt-0.5 border-2 border-rose-500 border-t-transparent rounded-full animate-spin shrink-0" />
                            )}
                            <span className="leading-5 break-all">{acgStatus}</span>
                        </div>
                    )}
                </div>
            </Modal>

            {/* 快捷键指南模态框 */}
            <ShortcutsModal isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
        </div>
    );
};

export default PlayPanel;
