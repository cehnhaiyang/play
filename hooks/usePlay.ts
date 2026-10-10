import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Hls from 'hls.js';
import { PlayerState, PlaylistState, PlaybackMode, ObjectFitMode, VideoFile, MediaType, AiBookEntryPage, PagePosition, UsePlayReturn } from '../meta';
import {
    canPlayback,
    createStreamFile,
    createVideoFile,
    detectGalleryFolders,
    dirOfFile,
    galleryNameFromMarker,
    generateId,
    loadJSON,
    loadStr,
    revokeVideoFile,
    saveJSON,
    saveStr,
    signAcgHlsUrl,
    STORAGE_KEYS,
} from '../const';

/* -------------------------------------------------------------------------- */
/* 播放列表落盘：只存可重建的在线条目（type==='file' 的本地 File/Blob 重进    */
/* 即失效，不存）；上限 200 条防爆配额；读到坏缓存直接丢用空列表。             */
/* -------------------------------------------------------------------------- */

interface StoredPlaylistItem {
    url: string;
    name: string;
    mediaType?: MediaType;
    groupId?: string;
    groupName?: string;
    groupType?: VideoFile['groupType'];
    page?: number;
    poster?: string;
    artist?: string;
    description?: string;
}

interface StoredPlaylist {
    items: StoredPlaylistItem[];
    currentIndex: number;
}

/**
 * AI 绘本入列的一页。
 *
 * `file` 与 `url` 二选一：生成器直接产出 File；从 .aibook 导入时图片是
 * 内联 data URL，调用方先转成 Blob URL 再传 url。
 */
const PLAYLIST_STORE_KEY = 'theplay.playlist.v1';
const PLAYLIST_STORE_MAX = 200;

const isPersistableUrl = (url: string): boolean =>
    typeof url === 'string' && url.length > 0 && url.length <= 8192 &&
    /^(https?:\/\/|file:\/\/)/i.test(url.trim());

/**
 * 序列化播放列表快照，并把当前索引重映射到落盘后的下标。
 * 落盘同时做「过滤」与「截断」两件事，直接沿用原始下标会在列表超长时
 * 指向另一首曲目（重进后从错误的位置续播）。
 */
const serializePlaylist = (files: VideoFile[], currentIndex: number): StoredPlaylist => {
    const persistable = files
        .map((f, sourceIndex) => ({ f, sourceIndex }))
        .filter(({ f }) => f && f.type === 'stream' && isPersistableUrl(f.url));
    const retained = persistable.slice(-PLAYLIST_STORE_MAX);
    const dropped = persistable.length - retained.length;

    let index = -1;
    if (currentIndex >= 0) {
        const exact = retained.findIndex(({ sourceIndex }) => sourceIndex === currentIndex);
        if (exact >= 0) {
            index = exact;
        } else {
            // 当前项本身不可持久化（本地 File/Blob）：退化为「其前方仍保留的条数」，
            // 重进后至少停在邻近位置，而不是跳回列表开头
            const before = persistable.filter(({ sourceIndex }) => sourceIndex < currentIndex).length;
            index = Math.min(Math.max(before - dropped, 0), Math.max(retained.length - 1, 0));
        }
    }

    return {
        items: retained.map(({ f }) => ({
            url: f.url,
            name: f.name,
            mediaType: f.mediaType,
            groupId: f.groupId,
            groupName: f.groupName,
            groupType: f.groupType,
            page: f.page,
            poster: f.poster,
            artist: f.artist,
            description: f.description,
        })),
        currentIndex: index,
    };
};

const restorePlaylist = (): PlaylistState => {
    const fallback: PlaylistState = { files: [], currentIndex: -1 };
    try {
        const saved = loadJSON<StoredPlaylist | null>(PLAYLIST_STORE_KEY, null, '');
        if (!saved || !Array.isArray(saved.items) || saved.items.length === 0) return fallback;
        const files: VideoFile[] = [];
        for (const it of saved.items.slice(0, PLAYLIST_STORE_MAX)) {
            if (!it || !isPersistableUrl(it.url)) continue;
            files.push(
                createStreamFile(it.url, it.name || it.url, it.mediaType, {
                    groupId: it.groupId,
                    groupName: it.groupName,
                    groupType: it.groupType,
                    page: it.page,
                    poster: it.poster,
                    artist: it.artist,
                    description: it.description,
                })
            );
        }
        if (files.length === 0) return fallback;
        const idx = Number.isInteger(saved.currentIndex) ? saved.currentIndex as number : -1;
        return { files, currentIndex: idx >= 0 && idx < files.length ? idx : 0 };
    } catch {
        return fallback;
    }
};

export const usePlay = (): UsePlayReturn => {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const hlsRef = useRef<Hls | null>(null);

    const [playlist, setPlaylist] = useState<PlaylistState>(restorePlaylist);

    /**
     * 播放列表的**唯一写入点**：ref 与 state 同一次写入。
     *
     * 此前只用 setPlaylist 写 state，另挂一个 effect 把 state 回填进 ref —— 同一个
     * 事实存了两处，而 ref 恒定落后 state 一个提交。所有增删又都是「读 ref → 算
     * 新表 → 覆盖写」，于是同一轮里连着改两次时，第二次读到的是旧表、把第一次的
     * 结果整个盖掉（导入时「散文件 + 解包画廊 + 多本绘本」都是连着调好几次）。
     * 目前那几处调用之间恰好都有 await、React 来得及冲刷，才没暴露出来 ——
     * 这正是「靠时序侥幸才对」：少一个 await 就丢数据，且不报任何错。
     *
     * 让 ref 成为写穿缓存后，它永远等于最后一次提交值，谁先跑完都不影响结果。
     * 仍然不用 setState 的函数式 updater：索引计算夹着 revokeVideoFile 这类副作用，
     * 塞进 updater 会在 StrictMode 下重放。
     *
     * 本函数依赖为空、引用恒定（与 setState 同性质），所以各调用处不把它列进依赖
     * 数组 —— 若将来要给它加依赖，必须同时给所有调用处补上，否则闭包会静默过期。
     */
    const playlistRef = useRef(playlist);
    const commitPlaylist = useCallback((next: PlaylistState) => {
        playlistRef.current = next;
        setPlaylist(next);
    }, []);

    // 播放列表快照落盘（只写可重建项，本地 File/Blob 条目天然跳过）。
    // 防抖 1.5s：边下边播每页 append 都会改 playlist，同步写 localStorage 会把阅读滚动卡成幻灯片。
    useEffect(() => {
        const timer = setTimeout(() => {
            const { files, currentIndex } = playlistRef.current;
            saveJSON(PLAYLIST_STORE_KEY, serializePlaylist(files, currentIndex), '');
        }, 1500);
        return () => clearTimeout(timer);
    }, [playlist]);

    const [mediaError, setMediaError] = useState<string | null>(null);
    const [mediaWarning, setMediaWarning] = useState<string | null>(null);

    const [state, setState] = useState<PlayerState>(() => {
        // 初始化读盘全程防爆：隐私模式/坏值都回落默认值，不崩首屏
        const savedVol = parseFloat(loadStr(STORAGE_KEYS.VOLUME, '0.7', ''));
        const savedRate = parseFloat(loadStr(STORAGE_KEYS.RATE, '1', ''));
        const savedMode = (loadStr(STORAGE_KEYS.MODE, '', '') as PlaybackMode) || PlaybackMode.ListLoop;
        const savedFit = (loadStr(STORAGE_KEYS.FIT, '', '') as ObjectFitMode) || 'contain';

        return {
            isPlaying: false,
            isBuffering: false,
            volume: isNaN(savedVol) ? 0.7 : savedVol,
            currentTime: 0,
            duration: 0,
            isMuted: false,
            playbackMode: Object.values(PlaybackMode).includes(savedMode) ? savedMode : PlaybackMode.ListLoop,
            playbackRate: isNaN(savedRate) ? 1 : savedRate,
            objectFit: ['contain', 'cover', 'fill'].includes(savedFit) ? savedFit : 'contain',
            isFullscreen: false,
            isPip: false
        };
    });

    // ref 镜像：事件回调读取最新播放模式/静音恢复音量，避免过期闭包与反复重绑
    const playbackModeRef = useRef(state.playbackMode);
    useEffect(() => { playbackModeRef.current = state.playbackMode; }, [state.playbackMode]);
    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; }, [state]);
    const prevVolumeRef = useRef(state.volume > 0 ? state.volume : 0.7);

    const currentFile = playlist.currentIndex >= 0 && playlist.currentIndex < playlist.files.length
        ? playlist.files[playlist.currentIndex]
        : null;
    const currentFileRef = useRef(currentFile);
    useEffect(() => { currentFileRef.current = currentFile; }, [currentFile]);

    /**
     * 当前项的组内页码位置。
     *
     * 画廊成组时必须按组内口径计算：直接拿 playlist 全局下标展示，看第 3 页会显示成
     * “第 137 项”，首项/末项跳转还会跳到别的作品去。
     *
     * 取「包含当前项的连续同组块」而非全列表同组项：进度滑杆的 min/max 直接吃
     * firstIndex/lastIndex，若按全列表口径，同组项被其它媒体隔开时滑杆会横跨
     * 无关条目，一拖就跳进别的视频。散文件/单曲无 groupId，退化为整列表口径。
     */
    const pageInfo = useMemo((): PagePosition => {
        const { files, currentIndex } = playlist;
        const wholeList: PagePosition = {
            index: currentIndex >= 0 ? currentIndex + 1 : 0,
            total: files.length,
            firstIndex: 0,
            lastIndex: Math.max(files.length - 1, 0),
            grouped: false,
        };
        if (!currentFile || currentIndex < 0) return wholeList;
        const gid = currentFile.groupId;
        if (!gid) return wholeList;

        let firstIndex = currentIndex;
        while (firstIndex > 0 && files[firstIndex - 1].groupId === gid) firstIndex -= 1;
        let lastIndex = currentIndex;
        while (lastIndex < files.length - 1 && files[lastIndex + 1].groupId === gid) lastIndex += 1;

        return {
            index: currentIndex - firstIndex + 1,
            total: lastIndex - firstIndex + 1,
            firstIndex,
            lastIndex,
            grouped: true,
        };
    }, [playlist, currentFile]);

    // 释放 Hls 实例
    const destroyHls = useCallback(() => {
        if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
        }
    }, []);

    /**
     * 把给定的 video 元素与旧源解绑。
     *
     * 只清 src 不调 load() 不会真正断开：解码器与网络连接会挂到下一次赋值，
     * 表现为「切走了还在后台下」。
     *
     * 参数是**元素本身**而不是去读 videoRef：React 在提交阶段就把 ref 摘掉了，
     * 而 effect 的清理函数要等到提交之后才跑，那时 `videoRef.current` 早已指向
     * 新元素或 null。凡是「释放我刚才配置的那个元素」都必须把元素握在手里，
     * 回头去 ref 里取只会拿到别人。
     */
    const detachElement = useCallback((video: HTMLVideoElement | null) => {
        if (!video) return;
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
    }, []);

    /**
     * 统一发起播放并识别「自动播放被拦截」。
     * 浏览器/Electron 无用户手势时 play() 会被拒绝，此前一律静默 catch，
     * 表现为点开媒体后画面静止却无任何提示；这里把拦截单独暴露成可读错误，
     * 让用户知道点一下播放键即可（而不是误以为媒体坏了）。
     */
    const attemptAutoplay = useCallback((video: HTMLVideoElement) => {
        video.play().catch((err: unknown) => {
            const name = (err as { name?: string } | null)?.name;
            if (name === 'NotAllowedError') {
                setMediaError('浏览器已拦截自动播放：点击播放按钮即可开始');
                setState(prev => ({ ...prev, isPlaying: false, isBuffering: false }));
                return;
            }
            // AbortError 是切换源时打断上一次 play() 的正常现象，不当作错误上报
            if (name !== 'AbortError') {
                setState(prev => ({ ...prev, isPlaying: false }));
            }
        });
    }, []);

    /**
     * 列表清空后把播放器放干净：释放 HLS、解绑 video、复位播放态。
     * 删除末项有三条路径（单删/批删/清空），这里是它们共同的所有者。
     *
     * 这里必须**同步**做，不能只交给加载 effect：清空列表会同时 revoke 掉条目的
     * Blob URL，而元素上还挂着那个地址，晚一步解绑就可能先收到一次媒体错误。
     */
    const releasePlayback = useCallback(() => {
        destroyHls();
        detachElement(videoRef.current);
        setState(prev => ({ ...prev, isPlaying: false, isBuffering: false, currentTime: 0, duration: 0 }));
    }, [destroyHls, detachElement]);


    useEffect(() => () => destroyHls(), [destroyHls]);

    // 播放
    const play = useCallback(async () => {
        const file = currentFileRef.current;
        // 图集走幻灯片模式：无 video 元素时直接翻转播放态（文档是静态页，不算幻灯片）
        if (!videoRef.current) {
            const list = playlistRef.current;
            if (file && canPlayback(file.mediaType, list.currentIndex, list.files.length)) {
                setMediaError(null);
                setState(prev => ({ ...prev, isPlaying: true }));
            }
            return;
        }
        try {
            setMediaError(null);
            await videoRef.current.play();
            setState(prev => ({ ...prev, isPlaying: true }));
        } catch (err: unknown) {
            const name = (err as { name?: string } | null)?.name;
            setMediaError(name === 'NotAllowedError' ? '浏览器已拦截自动播放：点击播放按钮即可开始' : '播放失败：媒体源不可用或已被移除');
            setState(prev => ({ ...prev, isPlaying: false }));
        }
    }, []);

    // 暂停
    const pause = useCallback(() => {
        if (!videoRef.current) {
            // 幻灯片模式暂停
            setState(prev => (prev.isPlaying ? { ...prev, isPlaying: false } : prev));
            return;
        }
        videoRef.current.pause();
        setState(prev => ({ ...prev, isPlaying: false }));
    }, []);

    /**
     * 切换播放/暂停。
     *
     * 返回「本次是否真的改变了播放态」：静态页（画廊占位/other）与文档没有播放态，
     * 已经在末项的幻灯片也无从推进（轮播 effect 会在同一帧把它按回暂停），
     * 这些情况都不响应。调用方据此决定要不要弹「播放中」提示 —— 让它按媒体类型
     * 自行判断等于把同一个事实存两份，两边迟早对不上（文档可翻页，却没有播放态）。
     */
    const togglePlay = useCallback((): boolean => {
        if (!videoRef.current) {
            const file = currentFileRef.current;
            const list = playlistRef.current;
            if (!file || !canPlayback(file.mediaType, list.currentIndex, list.files.length)) return false;
            setMediaError(null);
            setState(prev => ({ ...prev, isPlaying: !prev.isPlaying }));
            return true;
        }
        if (videoRef.current.paused) {
            play();
        } else {
            pause();
        }
        return true;
    }, [play, pause]);

    /**
     * 跳转（直播 / 无限时长直接忽略，避免抛异常）。
     *
     * 返回「本次是否真的跳了」：直播与未加载出时长的源上跳转无效，
     * 调用方据此决定要不要弹「+10s」提示 —— 弹了却没动等于骗人。
     *
     * 暂停下快进/快退必须保持暂停：某些 Chromium 在 seek 后会恢复播放，
     * 这里显式按住暂停态（先记 paused，设完 currentTime 后若被唤醒则按回去）。
     */
    const seek = useCallback((time: number): boolean => {
        const video = videoRef.current;
        if (!video) return false;
        const dur = video.duration;
        if (!Number.isFinite(dur) || dur <= 0) return false;
        const target = Math.max(0, Math.min(time, dur));
        const wasPaused = video.paused;
        try {
            video.currentTime = target;
        } catch {
            return false;
        }
        if (wasPaused && !video.paused) {
            try { video.pause(); } catch { /* ignore */ }
        }
        setState(prev => (wasPaused && prev.isPlaying ? { ...prev, currentTime: target, isPlaying: false } : { ...prev, currentTime: target }));
        return true;
    }, []);

    // 音量
    const setVolume = useCallback((volume: number) => {
        const val = Math.max(0, Math.min(1, volume));
        if (val > 0) prevVolumeRef.current = val;
        if (videoRef.current) {
            videoRef.current.volume = val;
            videoRef.current.muted = val === 0;
        }
        saveStr(STORAGE_KEYS.VOLUME, String(val), '');
        setState(prev => ({ ...prev, volume: val, isMuted: val === 0 }));
    }, []);

    // 静音切换（恢复静音前音量，而非固定 0.7）
    const toggleMute = useCallback(() => {
        const s = stateRef.current;
        if (s.isMuted || s.volume === 0) {
            const restoreVol = prevVolumeRef.current > 0 ? prevVolumeRef.current : 0.7;
            if (videoRef.current) {
                videoRef.current.volume = restoreVol;
                videoRef.current.muted = false;
            }
            setState(prev => ({ ...prev, volume: restoreVol, isMuted: false }));
            saveStr(STORAGE_KEYS.VOLUME, String(restoreVol), '');
        } else {
            if (s.volume > 0) prevVolumeRef.current = s.volume;
            if (videoRef.current) videoRef.current.muted = true;
            setState(prev => ({ ...prev, isMuted: true }));
        }
    }, []);

    // 倍速
    const setPlaybackRate = useCallback((rate: number) => {
        if (!Number.isFinite(rate) || rate <= 0 || rate > 8) return;
        if (videoRef.current) {
            try { videoRef.current.playbackRate = rate; } catch { /* ignore */ }
        }
        saveStr(STORAGE_KEYS.RATE, String(rate), '');
        setState(prev => ({ ...prev, playbackRate: rate }));
    }, []);

    // 循环模式
    const setPlaybackMode = useCallback((mode: PlaybackMode) => {
        saveStr(STORAGE_KEYS.MODE, mode, '');
        setState(prev => ({ ...prev, playbackMode: mode }));
    }, []);

    // 画面适配模式
    const setObjectFit = useCallback((fit: ObjectFitMode) => {
        saveStr(STORAGE_KEYS.FIT, fit, '');
        setState(prev => ({ ...prev, objectFit: fit }));
    }, []);

    const clearError = useCallback(() => setMediaError(null), []);
    const clearWarning = useCallback(() => setMediaWarning(null), []);

    /**
     * 幻灯片「原地重播」：索引不变时只把播放态按回 true。
     *
     * 末项无从推进，这里交给 canPlayback 统一否决 —— 否则按 N 会把播放态点亮，
     * 紧接着轮播 effect 发现已在末项又按回暂停，用户看到播放键闪一下。
     */
    const resumeSlideshow = useCallback(() => {
        const list = playlistRef.current;
        const file = list.currentIndex >= 0 ? list.files[list.currentIndex] : null;
        if (!file || !canPlayback(file.mediaType, list.currentIndex, list.files.length)) return;
        setState(s => (s.isPlaying ? s : { ...s, isPlaying: true }));
    }, []);

    // 下一首/曲目切换（纯计算 + 副作用外置，避免 updater 内副作用与 StrictMode 双调用）
    const nextTrack = useCallback((manual = false) => {
        const prev = playlistRef.current;
        const len = prev.files.length;
        if (len === 0) return;
        const mode = playbackModeRef.current;
        let nextIdx = prev.currentIndex;

        if (mode === PlaybackMode.Random && len > 1) {
            do {
                nextIdx = Math.floor(Math.random() * len);
            } while (nextIdx === prev.currentIndex);
            commitPlaylist({ ...prev, currentIndex: nextIdx });
            return;
        }
        if (mode === PlaybackMode.SingleLoop && !manual) {
            const v = videoRef.current;
            if (v) {
                try {
                    v.currentTime = 0;
                    attemptAutoplay(v);
                } catch { /* ignore */ }
            } else {
                // 幻灯片单曲循环：原地重播即保持索引并确保播放态
                resumeSlideshow();
            }
            return;
        }
        if (mode === PlaybackMode.StopAfter && !manual) {
            if (nextIdx + 1 >= len) {
                pause();
                return;
            }
            nextIdx += 1;
        } else {
            nextIdx = (nextIdx + 1) % len;
        }
        // 单条列表（或随机模式只有一个候选）算出原地不动：索引没变，
        // 依赖 currentFile 的加载 effect 不会重跑，播完就永远停在末帧。
        // 这里显式回到开头重播，让“列表循环”对单条媒体同样成立。
        if (nextIdx === prev.currentIndex) {
            const v = videoRef.current;
            if (v) {
                try {
                    v.currentTime = 0;
                    attemptAutoplay(v);
                } catch { /* ignore */ }
            } else {
                resumeSlideshow();
            }
            return;
        }
        commitPlaylist({ ...prev, currentIndex: nextIdx });
    }, [pause, attemptAutoplay, resumeSlideshow]);

    // 上一首
    const prevTrack = useCallback(() => {
        const prev = playlistRef.current;
        const len = prev.files.length;
        if (len === 0) return;
        const prevIdx = prev.currentIndex <= 0 ? len - 1 : prev.currentIndex - 1;
        if (prevIdx === prev.currentIndex) return;
        commitPlaylist({ ...prev, currentIndex: prevIdx });
    }, []);

    // 顺序翻页：图集/文档阅读专用，不受播放模式影响。
    // 背景：nextTrack 在 Random 模式下随机跳页、SingleLoop 下卡住，
    // 轮播和翻页走它会导致“剧情顺序混乱”，这里永远按列表顺序走。
    // 到头即停不回绕：看完末页突然跳回 P1 是迷惑行为，轮播到末页自然停住即是"读完"
    const stepPage = useCallback((delta: 1 | -1) => {
        const prev = playlistRef.current;
        const len = prev.files.length;
        if (len === 0) return;
        const base = prev.currentIndex < 0 ? (delta === 1 ? -1 : 0) : prev.currentIndex;
        const nextIdx = delta === 1 ? Math.min(base + 1, len - 1) : Math.max(base - 1, 0);
        if (nextIdx === prev.currentIndex) return;
        setMediaError(null);
        commitPlaylist({ ...prev, currentIndex: nextIdx });
    }, []);
    const nextPage = useCallback(() => stepPage(1), [stepPage]);
    const prevPage = useCallback(() => stepPage(-1), [stepPage]);

    // 选择曲目
    const selectTrack = useCallback((index: number) => {
        const prev = playlistRef.current;
        if (index < 0 || index >= prev.files.length) return;
        if (index === prev.currentIndex) return;
        setMediaError(null);
        commitPlaylist({ ...prev, currentIndex: index });
    }, []);

    // 移除曲目（修正：删除当前索引之前的项时 currentIndex 需同步前移）
    const removeTrack = useCallback((index: number) => {
        const prev = playlistRef.current;
        const target = prev.files[index];
        if (!target) return;
        const removingCurrent = index === prev.currentIndex;
        const newFiles = prev.files.filter((_, i) => i !== index);
        revokeVideoFile(target);
        let newIdx = prev.currentIndex;
        if (newFiles.length === 0) {
            newIdx = -1;
        } else if (index < prev.currentIndex) {
            newIdx = prev.currentIndex - 1;
        } else if (removingCurrent) {
            newIdx = Math.min(prev.currentIndex, newFiles.length - 1);
        } else if (newIdx >= newFiles.length) {
            newIdx = newFiles.length - 1;
        }
        commitPlaylist({ files: newFiles, currentIndex: newIdx });
        if (newFiles.length === 0) {
            releasePlayback();
        } else if (removingCurrent) {
            // 切走正在播的项时清掉旧错误，加载副作用由 currentFile effect 接管
            setMediaError(null);
        }
    }, [releasePlayback]);

    // 批量移除（供画廊/分组整组删除）：单次 setState，避免逐个 removeTrack 读到过期 ref
    const removeTracks = useCallback((indexes: number[]) => {
        const prev = playlistRef.current;
        const drop = new Set(indexes.filter((i) => i >= 0 && i < prev.files.length));
        if (drop.size === 0) return;
        const removedCurrent = drop.has(prev.currentIndex);
        const removedBefore = [...drop].filter((i) => i < prev.currentIndex).length;
        const newFiles = prev.files.filter((f, i) => {
            if (drop.has(i)) {
                revokeVideoFile(f);
                return false;
            }
            return true;
        });
        let newIdx = prev.currentIndex - removedBefore;
        if (newFiles.length === 0) {
            newIdx = -1;
        } else if (removedCurrent) {
            newIdx = Math.min(newIdx, newFiles.length - 1);
        } else if (newIdx >= newFiles.length) {
            newIdx = newFiles.length - 1;
        }
        commitPlaylist({ files: newFiles, currentIndex: newIdx });
        if (newFiles.length === 0) {
            releasePlayback();
        } else if (removedCurrent) {
            setMediaError(null);
        }
    }, [releasePlayback]);

    // 清空列表
    const clearPlaylist = useCallback(() => {
        const prev = playlistRef.current;
        prev.files.forEach(revokeVideoFile);
        commitPlaylist({ files: [], currentIndex: -1 });
        setMediaError(null);
        releasePlayback();
    }, [releasePlayback]);

    // 添加文件：先识别 .gallery 画廊文件夹（徽标 + 数字图片成组进组，
    // 头显示画廊名、底下 1/2/3…；徽标本身不进列表），其余散文件照常平铺
    const addFiles = useCallback((files: FileList | File[]) => {
        const list = Array.from(files);
        if (!list.length) return;
        const { galleries, loose, orphanMarkers } = detectGalleryFolders(list);
        const newVideoFiles: VideoFile[] = [];
        for (const g of galleries) {
            for (const p of g.pages) {
                const vf = createVideoFile(p.file, g.dir || undefined);
                vf.name = `${p.page}`;
                vf.description = p.file.name;
                vf.groupId = g.groupId;
                vf.groupName = g.name;
                vf.groupType = 'gallery';
                vf.page = p.page;
                newVideoFiles.push(vf);
            }
        }
        for (const f of loose) {
            newVideoFiles.push(createVideoFile(f, dirOfFile(f) || undefined));
        }
        // 孤立徽标：无相对路径（单文件点选）才给占位提示条目，告诉用户选文件夹；
        // 文件夹内的孤立徽标按格式约定忽略
        for (const m of orphanMarkers) {
            if (!dirOfFile(m)) {
                const stem = galleryNameFromMarker(m.name);
                newVideoFiles.push({
                    id: generateId(),
                    file: m,
                    url: URL.createObjectURL(m),
                    name: stem,
                    type: 'file',
                    mediaType: 'gallery',
                    description: '画廊徽标文件：请选择包含“画廊名.gallery + 数字图片”的文件夹导入',
                });
            }
        }
        if (!newVideoFiles.length) return;
        setMediaError(null);
        const prev = playlistRef.current;
        const updated = [...prev.files, ...newVideoFiles];
        const nextIdx = prev.currentIndex === -1 ? 0 : prev.currentIndex;
        commitPlaylist({ files: updated, currentIndex: nextIdx });
    }, []);

    // 单文件 .gallery 解包入列（与 addFiles 的文件夹画廊分支同构，徽标不进列表）
    const addUnpackedGallery = useCallback((name: string, pages: { file: File; page: number }[]) => {
        const ordered = [...pages]
            .filter((p) => p && p.file && Number.isFinite(p.page))
            .sort((a, b) => a.page - b.page);
        if (ordered.length === 0) return;
        const galleryName = (name || '').trim() || '未命名画廊';
        const groupId = `gallery:pack/${galleryName}`;
        const newVideoFiles: VideoFile[] = ordered.map((p) => {
            const vf = createVideoFile(p.file);
            vf.name = `${p.page}`;
            vf.description = p.file.name;
            vf.groupId = groupId;
            vf.groupName = galleryName;
            vf.groupType = 'gallery';
            vf.page = p.page;
            return vf;
        });
        setMediaError(null);
        const prev = playlistRef.current;
        const updated = [...prev.files, ...newVideoFiles];
        commitPlaylist({ files: updated, currentIndex: prev.files.length });
    }, []);

    // AI 绘本成组入列：与画廊同构（成组 + 页码），差别在每页带 description 文案
    // 且 groupType='ai-book'——播放器据此切到左图右文的阅读器版式。
    const addAiBook = useCallback((name: string, pages: AiBookEntryPage[]) => {
        const list = (pages || []).filter((p) => p && (p.file || p.url));
        if (list.length === 0) return;
        const bookName = (name || '').trim() || '未命名故事';
        // 用 generateId 而非书名做 key：同名绘本可以同时存在两本，书名做 key 会串台
        const groupId = `aibook:${generateId()}`;
        const newVideoFiles: VideoFile[] = list.map((p, i) => {
            // 调用方已建好 blob:（生成器网格里显示用的那个）时必须复用：
            // 走 createVideoFile 会再造一个，前一个就成了没人回收的孤儿。
            // 条目仍保留 file 引用，导出 .aibook 时可直读字节、省一次解码。
            const url = p.url || (p.file ? URL.createObjectURL(p.file) : '');
            const vf: VideoFile = p.file
                ? { id: generateId(), file: p.file, url, name: `${i + 1}`, type: 'file', mediaType: 'image' }
                : createStreamFile(url, `${i + 1}`, 'image');
            vf.name = `${i + 1}`;
            vf.mediaType = 'image';
            vf.description = p.text || '';
            vf.audioData = p.audio;
            vf.groupId = groupId;
            vf.groupName = bookName;
            vf.groupType = 'ai-book';
            vf.page = i + 1;
            return vf;
        });
        setMediaError(null);
        const prev = playlistRef.current;
        const updated = [...prev.files, ...newVideoFiles];
        commitPlaylist({ files: updated, currentIndex: prev.files.length });
    }, []);

    // 添加网络流。跳转到新条目后由加载 effect 统一发起播放，此处不自己调 play()
    const addStream = useCallback((url: string, name?: string, mediaType?: MediaType) => {
        const trimmed = url.trim();
        if (!trimmed) return;
        const streamFile = createStreamFile(trimmed, name, mediaType);
        setMediaError(null);
        const prev = playlistRef.current;
        const updated = [...prev.files, streamFile];
        commitPlaylist({ files: updated, currentIndex: updated.length - 1 });
    }, []);

    // 批量添加网络流/图集页面
    // autoPlayFirst=true 时跳到本批第一项（不清旧列表也会跳，推送新画廊不再靠清空实现“自动播新”）
    const addMultipleStreams = useCallback((streams: (Partial<VideoFile> & { url: string; title?: string })[], autoPlayFirst = true, clearPrevious = false) => {
        if (!streams.length) return;
        const streamFiles = streams.map(s => {
            const displayName = s.name || s.title || `Resource ${generateId()}`;
            return createStreamFile(s.url, displayName, s.mediaType, {
                poster: s.poster,
                artist: s.artist,
                isAnimated: s.isAnimated,
                acgCategory: s.acgCategory,
                groupId: s.groupId,
                groupName: s.groupName,
                groupType: s.groupType,
                page: s.page,
            });
        });
        setMediaError(null);
        const prev = playlistRef.current;
        if (clearPrevious) {
            prev.files.forEach(revokeVideoFile);
            destroyHls();
            commitPlaylist({ files: streamFiles, currentIndex: 0 });
        } else {
            const updated = [...prev.files, ...streamFiles];
            const nextIdx = autoPlayFirst ? prev.files.length : (prev.currentIndex === -1 ? 0 : prev.currentIndex);
            commitPlaylist({ files: updated, currentIndex: nextIdx });
        }
    }, [destroyHls]);

    // 绘本朗读的语音缓存写回：同一页重复点「朗读」不再重新合成
    const cacheAudioData = useCallback((fileId: string, base64: string) => {
        if (!fileId || !base64) return;
        const prev = playlistRef.current;
        let changed = false;
        const files = prev.files.map((f) => {
            if (f.id !== fileId || f.audioData === base64) return f;
            changed = true;
            return { ...f, audioData: base64 };
        });
        // 无变化就不 setState：朗读缓存命中时会走到这里，白白触发一次全列表重渲染
        if (!changed) return;
        commitPlaylist({ files, currentIndex: prev.currentIndex });
    }, []);

    // 追加更多流/图集后续页（不打扰当前播放/阅读索引）
    const appendStreams = useCallback((streams: (Partial<VideoFile> & { url: string; title?: string })[]) => {
        if (!streams.length) return;
        const prev = playlistRef.current;
        const existingUrls = new Set(prev.files.map(f => f.url));
        const toAdd = streams
            .filter(s => s.url && !existingUrls.has(s.url))
            .map(s => {
                const displayName = s.name || s.title || `Resource ${generateId()}`;
                return createStreamFile(s.url, displayName, s.mediaType, {
                    poster: s.poster,
                    artist: s.artist,
                    isAnimated: s.isAnimated,
                    acgCategory: s.acgCategory,
                    groupId: s.groupId,
                    groupName: s.groupName,
                    groupType: s.groupType,
                    page: s.page,
                });
            });
        if (!toAdd.length) return;
        commitPlaylist({
            files: [...prev.files, ...toAdd],
            currentIndex: prev.currentIndex === -1 ? 0 : prev.currentIndex
        });
    }, []);

    // 有序合并：把迟到/重试补回的图集页按 page 插回正确位置。
    // 只动同 groupId 的块，其他来源的文件原位不动；当前正在看的那条按 id 锚定。
    const mergeOrderedStreams = useCallback((streams: (Partial<VideoFile> & { url: string; title?: string })[], groupId?: string) => {
        if (!streams.length) return;
        const prev = playlistRef.current;
        const currentId = prev.currentIndex >= 0 && prev.currentIndex < prev.files.length
            ? prev.files[prev.currentIndex].id
            : null;
        const incoming = streams
            .filter(s => s.url)
            .map(s => {
                const displayName = s.name || s.title || `Resource ${generateId()}`;
                return createStreamFile(s.url, displayName, s.mediaType, {
                    poster: s.poster,
                    artist: s.artist,
                    isAnimated: s.isAnimated,
                    acgCategory: s.acgCategory,
                    groupId: s.groupId ?? groupId,
                    groupName: s.groupName,
                    groupType: s.groupType ?? 'gallery',
                    page: s.page,
                });
            });
        if (!incoming.length) return;

        // groupId 缺失时从首个入项推导；仍无则退化为去重追加——禁止回退到
        // “所有带 page 项”口径，否则两本无组画廊的页会混排进同一序列
        const gid = groupId ?? incoming[0].groupId;
        if (!gid) {
            const existingUrls = new Set(prev.files.map(f => f.url));
            const toAdd = incoming.filter(f => f.url && !existingUrls.has(f.url));
            if (!toAdd.length) return;
            commitPlaylist({
                files: [...prev.files, ...toAdd],
                currentIndex: prev.currentIndex === -1 ? 0 : prev.currentIndex,
            });
            return;
        }
        const inGroup = (f: VideoFile) => f.groupId === gid;
        const groupFiles = prev.files.filter(inGroup);
        const otherFiles = prev.files.filter(f => !inGroup(f));
        // 组内按“页码优先、URL 兜底”归位：同页新条目（如下落盘的本地 file://）
        // 原位替换旧条目（远程直链），id 沿用旧值保证当前阅读位置锚定不动
        const groupKey = (f: { page?: number; url: string }) =>
            f.page != null ? `page:${f.page}` : `url:${f.url}`;
        const byKey = new Map<string, VideoFile>();
        for (const f of groupFiles) {
            byKey.set(groupKey(f), f);
        }
        for (const f of incoming) {
            const k = groupKey(f);
            const old = byKey.get(k);
            if (old) {
                // 同页新条目顶掉旧条目时释放旧 Blob（file:// 回写/远端替换后旧 URL 再无人引用）
                if (old.url !== f.url) revokeVideoFile(old);
                byKey.set(k, { ...f, id: old.id, groupName: f.groupName ?? old.groupName });
            } else {
                byKey.set(k, f);
            }
        }
        const mergedGroup = [...byKey.values()].sort((a, b) => {
            const pa = a.page ?? Number.MAX_SAFE_INTEGER;
            const pb = b.page ?? Number.MAX_SAFE_INTEGER;
            return pa - pb;
        });

        // 组块放回原组起始位置（换算到剔除组后的数组下标）；原来没有组则拼在末尾
        let insertAt = otherFiles.length;
        const firstGroupIdx = prev.files.findIndex(inGroup);
        if (firstGroupIdx >= 0) {
            insertAt = prev.files.slice(0, firstGroupIdx).filter(f => !inGroup(f)).length;
        }
        const files = [...otherFiles.slice(0, insertAt), ...mergedGroup, ...otherFiles.slice(insertAt)];
        let currentIndex = prev.currentIndex;
        if (currentId) {
            const anchored = files.findIndex(f => f.id === currentId);
            currentIndex = anchored >= 0 ? anchored : Math.min(prev.currentIndex, files.length - 1);
        } else if (prev.currentIndex === -1 && files.length > 0) {
            currentIndex = 0;
        } else if (currentIndex >= files.length) {
            currentIndex = files.length - 1;
        }
        setMediaError(null);
        commitPlaylist({ files, currentIndex });
    }, []);

    // 全屏 (支持传入指定播放器主容器元素实现真正的纯视频全屏)
    const toggleFullscreen = useCallback((element?: HTMLElement | null) => {
        if (!document.fullscreenElement) {
            const target = element || document.documentElement;
            target.requestFullscreen?.().catch(() => { });
        } else {
            document.exitFullscreen?.().catch(() => { });
        }
    }, []);

    // 监听原生全屏状态变化，精准同步 isFullscreen 状态（支持 Esc 退出）
    useEffect(() => {
        const handleFullscreenChange = () => {
            setState(prev => ({ ...prev, isFullscreen: Boolean(document.fullscreenElement) }));
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    // 画中画
    const togglePip = useCallback(async () => {
        if (!videoRef.current) return;
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
                setState(prev => ({ ...prev, isPip: false }));
            } else {
                await videoRef.current.requestPictureInPicture();
                setState(prev => ({ ...prev, isPip: true }));
            }
        } catch {
            // ignore
        }
    }, []);

    // 同步 PiP 状态（顶栏按钮走直调 API 时也能回写 state）
    useEffect(() => {
        const onEnter = () => setState(prev => ({ ...prev, isPip: true }));
        const onLeave = () => setState(prev => ({ ...prev, isPip: false }));
        document.addEventListener('enterpictureinpicture', onEnter);
        document.addEventListener('leavepictureinpicture', onLeave);
        return () => {
            document.removeEventListener('enterpictureinpicture', onEnter);
            document.removeEventListener('leavepictureinpicture', onLeave);
        };
    }, []);

    /**
     * 媒体加载的触发键：只认「源身份」= id + url。
     *
     * 不能拿 currentFile 对象本身当依赖：playlist 每次变化都会重建当前项对象，
     * 于是纯元数据改动（朗读语音写回 audioData、合并时补 groupName）也会走一遍
     * 换源流程 —— 图片分支会把 isPlaying 强制置回 true，正在读的绘本页当场被
     * 轮播翻走。id 由 mergeOrderedStreams 刻意沿用、url 变了才是真的换了源。
     */
    const mediaSourceKey = currentFile ? `${currentFile.id}:${currentFile.url}` : 'none';

    // 加载当前媒体源：仅随媒体源变化触发，音量/倍速由独立 effect 同步
    useEffect(() => {
        const video = videoRef.current;
        // 走 ref 取最新条目：effect 只按 mediaSourceKey 重跑，闭包里的 currentFile 可能已过期
        const file = currentFileRef.current;

        // 无论走哪个分支，旧的 Hls 实例都不能继续下载 —— 它挂在 hlsRef 上，
        // 只有这里能释放；放在分支之前可保证没有哪条 return 绕过它。
        destroyHls();

        if (!file) {
            // 列表被清空/删到空时横幅必须一起走：留着「已跳过 N 段」而播放器是空的，
            // 用户既看不懂也关不掉（此后没有任何媒体切换来触发清理）
            setMediaError(null);
            setMediaWarning(null);
            setState(prev => ({ ...prev, isPlaying: false, isBuffering: false, currentTime: 0, duration: 0 }));
            return;
        }

        // 非音视频流走图集 / 文档 / 其他展示分支：播放态由 canPlayback 统一裁定。
        // 文档/画廊占位/other 是静态页保持暂停（否则暂停键误导 + 控制条自动隐藏，
        // 用户连点哪里播都找不到），已在末项的图集同样不进入 —— 轮播无从继续，
        // 点亮后下一帧就被按回去。
        if (file.mediaType !== 'video' && file.mediaType !== 'stream' && file.mediaType !== 'audio') {
            const list = playlistRef.current;
            const playable = canPlayback(file.mediaType, list.currentIndex, list.files.length);
            setMediaError(null);
            // 警告同样要清：图集页上残留上一部视频的「已跳过 N 段」是无意义的噪音
            setMediaWarning(null);
            setState(prev => ({ ...prev, isPlaying: playable, isBuffering: false, currentTime: 0, duration: 0 }));
            return;
        }

        if (!video) {
            // 防御性分支：音视频分支在**同一次提交**里就渲染了 video 元素，
            // 而 effect 在提交之后才跑，所以正常路径下 videoRef 一定有值。
            // 真走到这里说明渲染分支与 mediaType 判定脱节了（那是个 bug），
            // 这里只保证不崩：标成缓冲而不是拿 null 去赋 src。
            setState(prev => ({ ...prev, isBuffering: true }));
            return;
        }

        setMediaError(null);
        // 警告跟着媒体走：换源后上一部的"已跳过 N 段"不该留在新片上
        setMediaWarning(null);
        setState(prev => ({ ...prev, isBuffering: true, currentTime: 0, duration: 0 }));

        const isM3U8 =
            file.url.includes('.m3u8') ||
            file.url.includes('.m3u') ||
            file.name.endsWith('.m3u8') ||
            file.name.endsWith('.m3u');

        if (isM3U8 && Hls.isSupported()) {
            const hls = new Hls({
                maxBufferLength: 30,
                enableWorker: true,
                // ACG 图床对 m3u8 变体做签名校验：master 的 m/t 令牌不会随相对地址
                // 继承到变体请求上（RFC 3986 非空相对路径丢弃 base 的 query），
                // 缺签名的变体一律 403，表现为各画质全部 403。
                // 这里按站点同款口径补齐 m/t/from；仅对 ACG 域 + 带 m= 令牌的
                // master 生效，其它站点的流原样放行（见 const.ts 的 signAcgHlsUrl）。
                xhrSetup: (xhr, url) => {
                    const signed = signAcgHlsUrl(url, file.url);
                    if (signed !== url) xhr.open('GET', signed, true);
                }
            });
            hls.loadSource(file.url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                attemptAutoplay(video);
            });
            // 重试预算按错误类型分开。网络错误与解码错误是两件独立的事，
            // 共用一个计数器时解码错误会吃掉网络重试的额度：长片里偶发两次解码
            // 抖动之后，网络稍有波动就直接放弃，用户看到「已停止重试」。
            let networkRetries = 0;
            let mediaRetries = 0;
            // 已跳过的失效分片数：只用于汇总提示，不设上限——
            // 用户明确要求"确定坏掉的就跳过"，哪怕整片都缺也照跳，
            // 由播放器自然播到末尾结束，而不是替用户判定"这资源没救了"。
            let skippedFrags = 0;
            hls.on(Hls.Events.ERROR, (_, data) => {
                // 分片 4xx：源站已经确认这个文件不存在，重试永远不会成功。
                // 必须**在致命判断之前**拦下——hls.js 对 4xx 一次都不重试
                // （error-helper 的 retryForHttpStatus 对 400~499 返回 false），
                // 于是直接转 penalty box 并置 fatal，整个视频就崩了。
                // 而它自带的"当作空洞跳过"路径（treatAsGap）只在直播流上生效，
                // VOD 的 #EXT-X-ENDLIST 清单走不到那里，所以这里自己跳。
                const httpCode = data.response?.code;
                const frag = data.frag;
                if (
                    frag &&
                    typeof httpCode === 'number' &&
                    httpCode >= 400 &&
                    httpCode < 500
                ) {
                    skippedFrags += 1;
                    // 从这一段的**结束时刻**继续。startLoad 无参数等于从当前位置重来，
                    // 会再次撞上同一个坏分片，那正是原来三次重试后放弃的原因。
                    const resumeAt = frag.start + frag.duration;
                    // 缓冲区会因此留下一个空洞。VOD 下 gap-controller 只自动跳
                    // ≤2 秒的起始空洞（MAX_START_GAP_JUMP），更长的洞需要把播放头
                    // 主动挪过去，否则画面会卡在洞口一直转圈。
                    try {
                        if (Number.isFinite(resumeAt)) {
                            video.currentTime = resumeAt;
                            hls.startLoad(resumeAt, true);
                        } else {
                            hls.startLoad();
                        }
                    } catch {
                        hls.startLoad();
                    }
                    setMediaWarning(
                        skippedFrags === 1
                            ? `第 ${frag.sn} 段在源站已失效（HTTP ${httpCode}），已跳过该段继续播放。`
                            : `源站有 ${skippedFrags} 段已失效（最新一段 HTTP ${httpCode}），已逐段跳过继续播放。`
                    );
                    return;
                }

                if (!data.fatal) return;
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    if (networkRetries < 3) {
                        networkRetries += 1;
                        hls.startLoad();
                    } else {
                        setMediaError('网络错误：流媒体加载失败，已停止重试');
                        setState(prev => ({ ...prev, isBuffering: false, isPlaying: false }));
                        destroyHls();
                    }
                } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    if (mediaRetries < 3) {
                        mediaRetries += 1;
                        hls.recoverMediaError();
                    } else {
                        setMediaError('媒体错误：该流无法解码');
                        setState(prev => ({ ...prev, isBuffering: false, isPlaying: false }));
                        destroyHls();
                    }
                } else {
                    setMediaError('流媒体加载失败：不支持的格式或致命错误');
                    setState(prev => ({ ...prev, isBuffering: false, isPlaying: false }));
                    destroyHls();
                }
            });
            hlsRef.current = hls;
        } else {
            video.src = file.url;
            video.load();
            attemptAutoplay(video);
        }

        video.volume = stateRef.current.isMuted ? 0 : stateRef.current.volume;
        video.muted = stateRef.current.isMuted;
        try { video.playbackRate = stateRef.current.playbackRate; } catch { /* ignore */ }

        /**
         * 元素离场时解绑。
         *
         * 音视频分支与图集/文档分支互斥，切到后者时 React 会把 <video> 整个卸载。
         * 摘除的媒体元素**不会自己断开**：规范只要求它暂停，src 与资源加载都还在，
         * 于是后台继续拉流、继续占解码器，直到被回收。而真正能中止它的是
         * `removeAttribute('src') + load()` —— 偏偏这时 videoRef.current 已被 React
         * 在提交阶段置空，回头去 ref 里取只会拿到 null：原先各分支里的解绑在
         * 「视频切图片」这条路径上一直是空转的。只有把元素握在闭包里才够得着它。
         *
         * 按「元素是否还是当前元素」筛一道：video→video 换源时 React 复用同一个
         * 元素，此时若也解绑，清空 src 触发的 error 会落到紧随其后的新源上，
         * 给每次换片都弹一条假的「媒体加载失败」。
         */
        return () => {
            if (videoRef.current !== video) detachElement(video);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaSourceKey, destroyHls]);

    // 音量 / 倍速独立同步：不再触发媒体重载
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        if (Math.abs(video.volume - state.volume) > 0.001) {
            try { video.volume = state.volume; } catch { /* ignore */ }
        }
        if (video.muted !== state.isMuted && state.volume > 0) {
            try { video.muted = state.isMuted; } catch { /* ignore */ }
        }
        if (Math.abs(video.playbackRate - state.playbackRate) > 0.001) {
            try { video.playbackRate = state.playbackRate; } catch { /* ignore */ }
        }
    }, [state.volume, state.isMuted, state.playbackRate, mediaSourceKey]);

    // 绑定原生音视频事件：随挂载的 video 元素（分支切换会重挂载）重绑
    // 媒体切换 key 保证 image<->video 分支重挂载后监听不丢失
    const mediaBindKey = currentFile ? `${currentFile.id}:${currentFile.mediaType}` : 'none';
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const onTimeUpdate = () => {
            setState(prev => ({ ...prev, currentTime: video.currentTime }));
        };
        const onDurationChange = () => {
            const d = video.duration;
            // 保留 Infinity 供直播判断；仅 NaN 回落为 0
            const validDuration = Number.isNaN(d) ? 0 : Math.max(0, d);
            setState(prev => ({ ...prev, duration: validDuration }));
        };
        const onLoadedMetadata = () => {
            const d = video.duration;
            const validDuration = Number.isNaN(d) ? 0 : Math.max(0, d);
            setState(prev => ({ ...prev, duration: validDuration, isBuffering: false }));
        };
        const onPlay = () => { setMediaError(null); setState(prev => ({ ...prev, isPlaying: true })); };
        const onPause = () => setState(prev => ({ ...prev, isPlaying: false }));
        const onWaiting = () => setState(prev => ({ ...prev, isBuffering: true }));
        const onPlaying = () => setState(prev => ({ ...prev, isBuffering: false }));
        const onEnded = () => nextTrack(false);
        const onError = () => {
            const code = video.error?.code;
            setMediaError(code === 4 ? '无法播放：浏览器不支持该格式' : '媒体加载失败：网络或源不可用');
            setState(prev => ({ ...prev, isBuffering: false, isPlaying: false }));
        };
        const onVolumeChange = () => {
            // 原生控件（PiP/系统）改动时回写，避免 state 脱节
            setState(prev => {
                if (prev.volume === video.volume && prev.isMuted === video.muted) return prev;
                return { ...prev, volume: video.volume, isMuted: video.muted };
            });
        };
        const onRateChange = () => {
            setState(prev => (prev.playbackRate === video.playbackRate ? prev : { ...prev, playbackRate: video.playbackRate }));
        };

        video.addEventListener('timeupdate', onTimeUpdate);
        video.addEventListener('durationchange', onDurationChange);
        video.addEventListener('loadedmetadata', onLoadedMetadata);
        video.addEventListener('play', onPlay);
        video.addEventListener('pause', onPause);
        video.addEventListener('waiting', onWaiting);
        video.addEventListener('playing', onPlaying);
        video.addEventListener('ended', onEnded);
        video.addEventListener('error', onError);
        video.addEventListener('volumechange', onVolumeChange);
        video.addEventListener('ratechange', onRateChange);

        return () => {
            video.removeEventListener('timeupdate', onTimeUpdate);
            video.removeEventListener('durationchange', onDurationChange);
            video.removeEventListener('loadedmetadata', onLoadedMetadata);
            video.removeEventListener('play', onPlay);
            video.removeEventListener('pause', onPause);
            video.removeEventListener('waiting', onWaiting);
            video.removeEventListener('playing', onPlaying);
            video.removeEventListener('ended', onEnded);
            video.removeEventListener('error', onError);
            video.removeEventListener('volumechange', onVolumeChange);
            video.removeEventListener('ratechange', onRateChange);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaBindKey, nextTrack]);

    const methods = useMemo(() => ({
        play,
        pause,
        togglePlay,
        seek,
        setVolume,
        setPlaybackRate,
        setPlaybackMode,
        setObjectFit,
        toggleMute,
        toggleFullscreen,
        togglePip,
        addFiles,
        addUnpackedGallery,
        addAiBook,
        cacheAudioData,
        addStream,
        addMultipleStreams,
        appendStreams,
        mergeOrderedStreams,
        selectTrack,
        nextTrack,
        prevTrack,
        nextPage,
        prevPage,
        removeTrack,
        removeTracks,
        clearPlaylist,
        clearError,
        clearWarning,
    }), [play, pause, togglePlay, seek, setVolume, setPlaybackRate, setPlaybackMode, setObjectFit, toggleMute, toggleFullscreen, togglePip, addFiles, addUnpackedGallery, addAiBook, cacheAudioData, addStream, addMultipleStreams, appendStreams, mergeOrderedStreams, selectTrack, nextTrack, prevTrack, nextPage, prevPage, removeTrack, removeTracks, clearPlaylist, clearError, clearWarning]);

    return {
        state,
        playlist,
        videoRef,
        currentFile,
        mediaError,
        mediaWarning,
        pageInfo,
        methods
    };
};
