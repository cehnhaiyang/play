import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Hls from 'hls.js';
import { PlayerState, PlaylistState, PlaybackMode, ObjectFitMode, VideoFile, MediaType } from '../../meta';
import { createVideoFile, createStreamFile, revokeVideoFile, STORAGE_KEYS, generateId, detectGalleryFolders, dirOfFile, galleryNameFromMarker } from '../../utils';

export interface UsePlayReturn {
  state: PlayerState;
  playlist: PlaylistState;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentFile: VideoFile | null;
  mediaError: string | null;
  methods: {
    play: () => Promise<void>;
    pause: () => void;
    togglePlay: () => void;
    seek: (time: number) => void;
    setVolume: (volume: number) => void;
    setPlaybackRate: (rate: number) => void;
    setPlaybackMode: (mode: PlaybackMode) => void;
    setObjectFit: (fit: ObjectFitMode) => void;
    toggleMute: () => void;
    toggleFullscreen: (element?: HTMLElement | null) => void;
    togglePip: () => Promise<void>;
    addFiles: (files: FileList | File[]) => void;
    addStream: (url: string, name?: string, autoPlay?: boolean, mediaType?: MediaType) => void;
    addMultipleStreams: (streams: (Partial<VideoFile> & { url: string; title?: string })[], autoPlayFirst?: boolean, clearPrevious?: boolean) => void;
    appendStreams: (streams: (Partial<VideoFile> & { url: string; title?: string })[]) => void;
    /** 有序合并：同 groupId 的图集页按 page 升序归位（迟到/重试的页插回正确位置），当前看到的那页锚定不动 */
    mergeOrderedStreams: (streams: (Partial<VideoFile> & { url: string; title?: string })[], groupId?: string) => void;
    selectTrack: (index: number) => void;
    nextTrack: (manual?: boolean) => void;
    prevTrack: () => void;
    /** 顺序翻页（图集/文档专用）：无视 Random/SingleLoop/StopAfter，永远按列表顺序走 */
    nextPage: () => void;
    prevPage: () => void;
    removeTrack: (index: number) => void;
    removeTracks: (indexes: number[]) => void;
    clearPlaylist: () => void;
    clearError: () => void;
  };
}

export const usePlay = (): UsePlayReturn => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [playlist, setPlaylist] = useState<PlaylistState>({
    files: [],
    currentIndex: -1
  });
  // ref 镜像：让切歌/删除索引计算保持纯函数，避免在 setState updater 内做副作用
  const playlistRef = useRef(playlist);
  useEffect(() => { playlistRef.current = playlist; }, [playlist]);

  const [mediaError, setMediaError] = useState<string | null>(null);

  const [state, setState] = useState<PlayerState>(() => {
    const savedVol = parseFloat(localStorage.getItem(STORAGE_KEYS.VOLUME) || '0.7');
    const savedRate = parseFloat(localStorage.getItem(STORAGE_KEYS.RATE) || '1');
    const savedMode = (localStorage.getItem(STORAGE_KEYS.MODE) as PlaybackMode) || PlaybackMode.ListLoop;
    const savedFit = (localStorage.getItem(STORAGE_KEYS.FIT) as ObjectFitMode) || 'contain';

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

  // 释放 Hls 实例
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, []);

  // 卸载时释放 HLS
  useEffect(() => () => destroyHls(), [destroyHls]);

  // 播放
  const play = useCallback(async () => {
    const file = currentFileRef.current;
    // 图集 / 文档走幻灯片模式：无 video 元素时直接翻转播放态
    if (!videoRef.current) {
      if (file && (file.mediaType === 'image' || file.mediaType === 'document')) {
        setMediaError(null);
        setState(prev => ({ ...prev, isPlaying: true }));
      }
      return;
    }
    try {
      setMediaError(null);
      await videoRef.current.play();
      setState(prev => ({ ...prev, isPlaying: true }));
    } catch {
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

  // 切换播放/暂停
  const togglePlay = useCallback(() => {
    if (!videoRef.current) {
      setMediaError(null);
      setState(prev => ({ ...prev, isPlaying: !prev.isPlaying }));
      return;
    }
    if (videoRef.current.paused) {
      play();
    } else {
      pause();
    }
  }, [play, pause]);

  // 跳转（直播 / 无限时长直接忽略，避免抛异常）
  const seek = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video) return;
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const target = Math.max(0, Math.min(time, dur));
    try {
      video.currentTime = target;
    } catch {
      return;
    }
    setState(prev => ({ ...prev, currentTime: target }));
  }, []);

  // 音量
  const setVolume = useCallback((volume: number) => {
    const val = Math.max(0, Math.min(1, volume));
    if (val > 0) prevVolumeRef.current = val;
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
    }
    localStorage.setItem(STORAGE_KEYS.VOLUME, String(val));
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
      localStorage.setItem(STORAGE_KEYS.VOLUME, String(restoreVol));
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
    localStorage.setItem(STORAGE_KEYS.RATE, String(rate));
    setState(prev => ({ ...prev, playbackRate: rate }));
  }, []);

  // 循环模式
  const setPlaybackMode = useCallback((mode: PlaybackMode) => {
    localStorage.setItem(STORAGE_KEYS.MODE, mode);
    setState(prev => ({ ...prev, playbackMode: mode }));
  }, []);

  // 画面适配模式
  const setObjectFit = useCallback((fit: ObjectFitMode) => {
    localStorage.setItem(STORAGE_KEYS.FIT, fit);
    setState(prev => ({ ...prev, objectFit: fit }));
  }, []);

  const clearError = useCallback(() => setMediaError(null), []);

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
      setPlaylist({ ...prev, currentIndex: nextIdx });
      return;
    }
    if (mode === PlaybackMode.SingleLoop && !manual) {
      const v = videoRef.current;
      if (v) {
        try {
          v.currentTime = 0;
          v.play().catch(() => { });
        } catch { /* ignore */ }
      } else {
        // 幻灯片单曲循环：原地重播即保持索引并确保播放态
        setState(s => (s.isPlaying ? s : { ...s, isPlaying: true }));
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
    setPlaylist({ ...prev, currentIndex: nextIdx });
  }, [pause]);

  // 上一首
  const prevTrack = useCallback(() => {
    const prev = playlistRef.current;
    const len = prev.files.length;
    if (len === 0) return;
    const prevIdx = prev.currentIndex <= 0 ? len - 1 : prev.currentIndex - 1;
    if (prevIdx === prev.currentIndex) return;
    setPlaylist({ ...prev, currentIndex: prevIdx });
  }, []);

  // 顺序翻页：图集/文档阅读专用，不受播放模式影响。
  // 背景：nextTrack 在 Random 模式下随机跳页、SingleLoop 下卡住，
  // 轮播和翻页走它会导致“剧情顺序混乱”，这里永远按列表顺序走（循环）。
  const stepPage = useCallback((delta: 1 | -1) => {
    const prev = playlistRef.current;
    const len = prev.files.length;
    if (len === 0) return;
    const base = prev.currentIndex < 0 ? (delta === 1 ? -1 : 0) : prev.currentIndex;
    const nextIdx = (base + delta + len) % len;
    if (nextIdx === prev.currentIndex) return;
    setMediaError(null);
    setPlaylist({ ...prev, currentIndex: nextIdx });
  }, []);
  const nextPage = useCallback(() => stepPage(1), [stepPage]);
  const prevPage = useCallback(() => stepPage(-1), [stepPage]);

  // 选择曲目
  const selectTrack = useCallback((index: number) => {
    const prev = playlistRef.current;
    if (index < 0 || index >= prev.files.length) return;
    if (index === prev.currentIndex) return;
    setMediaError(null);
    setPlaylist({ ...prev, currentIndex: index });
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
    setPlaylist({ files: newFiles, currentIndex: newIdx });
    if (newFiles.length === 0) {
      destroyHls();
      const v = videoRef.current;
      if (v) {
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
      }
      setState(s => ({ ...s, isPlaying: false, isBuffering: false, currentTime: 0, duration: 0 }));
    } else if (removingCurrent) {
      // 切走正在播的项时清掉旧错误，加载副作用由 currentFile effect 接管
      setMediaError(null);
    }
  }, [destroyHls]);

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
    setPlaylist({ files: newFiles, currentIndex: newIdx });
    if (newFiles.length === 0) {
      destroyHls();
      const v = videoRef.current;
      if (v) {
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
      }
      setState(s => ({ ...s, isPlaying: false, isBuffering: false, currentTime: 0, duration: 0 }));
    } else if (removedCurrent) {
      setMediaError(null);
    }
  }, [destroyHls]);

  // 清空列表
  const clearPlaylist = useCallback(() => {
    const prev = playlistRef.current;
    prev.files.forEach(revokeVideoFile);
    setPlaylist({ files: [], currentIndex: -1 });
    destroyHls();
    const v = videoRef.current;
    if (v) {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
    }
    setMediaError(null);
    setState(s => ({ ...s, isPlaying: false, isBuffering: false, currentTime: 0, duration: 0 }));
  }, [destroyHls]);

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
    setPlaylist({ files: updated, currentIndex: nextIdx });
  }, []);

  // 添加网络流
  const addStream = useCallback((url: string, name?: string, autoPlay = true, mediaType?: MediaType) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const streamFile = createStreamFile(trimmed, name, mediaType);
    setMediaError(null);
    const prev = playlistRef.current;
    const updated = [...prev.files, streamFile];
    setPlaylist({ files: updated, currentIndex: updated.length - 1 });
    void autoPlay;
    // 自动播放由下方 currentFile 加载 effect 统一触发，避免 setTimeout 竞态
  }, []);

  // 批量添加网络流/图集页面
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
      setPlaylist({ files: streamFiles, currentIndex: 0 });
    } else {
      const updated = [...prev.files, ...streamFiles];
      const nextIdx = prev.currentIndex === -1 ? 0 : prev.currentIndex;
      setPlaylist({ files: updated, currentIndex: nextIdx });
    }
    void autoPlayFirst;
  }, [destroyHls]);

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
    setPlaylist({
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

    const inGroup = (f: VideoFile) => (groupId ? f.groupId === groupId : f.page != null);
    const groupFiles = prev.files.filter(inGroup);
    const otherFiles = prev.files.filter(f => !inGroup(f));
    // 组内去重（按 url），页码缺失的沉底
    const byUrl = new Map<string, VideoFile>();
    for (const f of [...groupFiles, ...incoming]) {
      if (!byUrl.has(f.url)) byUrl.set(f.url, f);
    }
    const mergedGroup = [...byUrl.values()].sort((a, b) => {
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
    setPlaylist({ files, currentIndex });
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

  // 加载当前媒体源：仅随 currentFile 变化触发，音量/倍速由独立 effect 同步
  useEffect(() => {
    const video = videoRef.current;
    if (!currentFile) {
      destroyHls();
      if (video) {
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
      }
      setState(prev => ({ ...prev, isPlaying: false, isBuffering: false, currentTime: 0, duration: 0 }));
      return;
    }

    // 非音视频流走图集 / 文档 / 其他展示分支：停掉旧视频并把播放态交给幻灯片逻辑
    if (currentFile.mediaType !== 'video' && currentFile.mediaType !== 'stream' && currentFile.mediaType !== 'audio') {
      destroyHls();
      if (video) {
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
      }
      setMediaError(null);
      setState(prev => ({ ...prev, isPlaying: true, isBuffering: false, currentTime: 0, duration: 0 }));
      return;
    }

    if (!video) {
      // 音频分支的隐藏 video 尚未挂载时由幻灯片态兜底，挂载后 effect 会重跑
      setState(prev => ({ ...prev, isBuffering: true }));
      return;
    }

    destroyHls();
    setMediaError(null);
    setState(prev => ({ ...prev, isBuffering: true, currentTime: 0, duration: 0 }));

    const isM3U8 =
      currentFile.url.includes('.m3u8') ||
      currentFile.url.includes('.m3u') ||
      currentFile.name.endsWith('.m3u8') ||
      currentFile.name.endsWith('.m3u');

    if (isM3U8 && Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30,
        enableWorker: true
      });
      hls.loadSource(currentFile.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => { });
      });
      let recoverAttempts = 0;
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (recoverAttempts < 3) {
            recoverAttempts += 1;
            hls.startLoad();
          } else {
            setMediaError('网络错误：流媒体加载失败，已停止重试');
            setState(prev => ({ ...prev, isBuffering: false, isPlaying: false }));
            destroyHls();
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (recoverAttempts < 3) {
            recoverAttempts += 1;
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
      video.src = currentFile.url;
      video.load();
      video.play().catch(() => { });
    }

    video.volume = stateRef.current.isMuted ? 0 : stateRef.current.volume;
    video.muted = stateRef.current.isMuted;
    try { video.playbackRate = stateRef.current.playbackRate; } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFile, destroyHls]);

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
  }, [state.volume, state.isMuted, state.playbackRate, currentFile]);

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
  }), [play, pause, togglePlay, seek, setVolume, setPlaybackRate, setPlaybackMode, setObjectFit, toggleMute, toggleFullscreen, togglePip, addFiles, addStream, addMultipleStreams, appendStreams, mergeOrderedStreams, selectTrack, nextTrack, prevTrack, nextPage, prevPage, removeTrack, removeTracks, clearPlaylist, clearError]);

  return {
    state,
    playlist,
    videoRef,
    currentFile,
    mediaError,
    methods
  };
};
