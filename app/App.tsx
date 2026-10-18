import React, { useState, useCallback, useEffect, useRef } from 'react';
import { usePlay } from './hooks';
import { PlayPanel, Floating, AudioPanel, GalleryPanel, TorrentPanel } from './components';
import { MediaType } from '../shared/meta';
import { getMediaType, isPlayableMedia } from '../shared/core';

/**
 * 应用主视图。
 *
 * **浏览器视图已移除**：标签页、地址栏、书签、嗅探这些随自建外壳一起拆掉，
 * 由浏览器插件接管（extension/）。这里只剩"本机工具"那一半 ——
 * 播放器、音频工坊、画廊、磁力下载。
 *
 * 视图切换仍用 fixed + transform 的叠加层而不是路由：切换要保持各组件的
 * 挂载状态（播放进度、已加载的列表、输入内容），路由会卸载重建。
 */
type ViewMode = 'player' | 'audio' | 'gallery' | 'torrent';

const PlayerLayout: React.FC = () => {
  const player = usePlay();

  const [view, setView] = useState<ViewMode>('player');

  /* 推送监听器只订阅一次，所以要能读到"此刻的 player"，见下面那个 effect */
  const playerRef = useRef(player);
  playerRef.current = player;

  // 画廊懒挂载：GalleryPanel 首屏 effect 会预拉 latest 频道，常驻挂载等于每次启动都偷跑流量；
  // 且百张封面图常驻后台会持续占用解码与内存。首次进入时挂载，之后 keep-alive 保状态。
  const [galleryVisited, setGalleryVisited] = useState(false);
  const openGalleryView = useCallback(() => {
    setGalleryVisited(true);
    setView('gallery');
  }, []);

  // 磁力下载同画廊：首次进入挂载、之后 keep-alive 保状态。
  const [torrentVisited, setTorrentVisited] = useState(false);
  const openTorrentView = useCallback(() => {
    setTorrentVisited(true);
    setView('torrent');
  }, []);

  const openAudioView = useCallback(() => setView('audio'), []);

  const handleBrowseGallery = useCallback(
    (gallery: { title: string; gid?: string; pages: { url: string; title: string; page?: number }[] }) => {
      const groupId = gallery.gid ? `acg:${gallery.gid}` : undefined;
      const streamItems = gallery.pages.map((p) => ({
        url: p.url,
        name: p.title,
        title: p.title,
        mediaType: getMediaType(p.title, undefined, p.url),
        groupId,
        groupName: gallery.title,
        groupType: 'gallery' as const,
        page: p.page,
      }));
      // 追加成新分组并跳到本批第一页，不清空旧列表
      player.methods.addMultipleStreams(streamItems, true);
      setView('player');
    },
    [player.methods]
  );

  // 纯媒体直推（视频 / 音频）：不建画廊分组，不带 groupId/groupType/page。
  // 只有多图集才有"标题 + 子内容"结构，单个视频/音轨直接进播放列表。
  // artist 必须原样带过去：它只存在于探测结果里，在这个边界丢掉之后，
  // 音频视图就只能显示一条裸地址（同一条音轨从播放器入口进来是带署名的）。
  const handlePlayMediaStreams = useCallback((pages: { url: string; title: string; mediaType?: MediaType; artist?: string }[]) => {
    if (pages.length === 0) return;
    const streamItems = pages.map((p) => ({
      url: p.url,
      name: p.title,
      title: p.title,
      mediaType: p.mediaType || getMediaType(p.title, undefined, p.url),
      artist: p.artist,
    }));
    player.methods.addMultipleStreams(streamItems, true);
    setView('player');
  }, [player.methods]);

  const handleAppendGalleryPages = useCallback((pages: { url: string; title: string; page?: number }[], gid?: string) => {
    const groupId = gid ? `acg:${gid}` : undefined;
    const streamItems = pages.map((p) => ({
      url: p.url,
      name: p.title,
      title: p.title,
      mediaType: getMediaType(p.title, undefined, p.url),
      groupId,
      groupType: 'gallery' as const,
      page: p.page,
    }));
    player.methods.appendStreams(streamItems);
  }, [player.methods]);

  // 有序合并：失败页重试补回来的迟到页按页码归位，而不是堆在末尾
  const handleMergeGalleryPages = useCallback((pages: { url: string; title: string; page?: number }[], gid?: string) => {
    const groupId = gid ? `acg:${gid}` : undefined;
    const streamItems = pages.map((p) => ({
      url: p.url,
      name: p.title,
      title: p.title,
      mediaType: getMediaType(p.title, undefined, p.url),
      groupId,
      groupType: 'gallery' as const,
      page: p.page,
    }));
    player.methods.mergeOrderedStreams(streamItems, groupId);
  }, [player.methods]);

  /**
   * 嗅探球推来的资源入列。
   *
   * 球是**独立窗口**（app/main/orbs.js），它自己没有播放器 —— 抓到的东西只能
   * 经主进程转到这里。这就是"嗅探结果进播放器"的唯一入口。
   *
   * ## 为什么经 ref 读 player
   *
   * 这个监听器必须只订阅一次。把 `player.methods` / `player.playlist` 放进依赖
   * 数组的话，列表每加一条就退订重订一次 —— 批量导入几百张图时就是几百次
   * IPC 监听器增删。而监听器真正需要的只有"此刻的列表"和"入列函数"，
   * 两者都能从 ref 上现读。
   *
   * ## 两道过滤都在这里，不在球里
   *
   *  · `isPlayableMedia` 挡掉文档、画廊占位、other —— 它们进播放列表只会是
   *    一条点了没反应的条目（`canPlayback` 对这些一律返回 false）；
   *  · 已在列表里的 URL 不再重复入列（同一条可能被推两次）。
   *
   * 判据取自 `shared/core`，与播放器自己的可用性判断同一份，不另写一套。
   */
  useEffect(() => {
    const off = window.electronAPI?.onPlayMediaPush?.((items) => {
      const current = playerRef.current;
      const existing = new Set(current.playlist.files.map((f) => f.url));
      const accepted = items
        .filter((item) => item?.url && !existing.has(item.url))
        .map((item) => ({
          url: item.url,
          name: item.title,
          title: item.title,
          mediaType: item.mediaType || getMediaType(item.title, undefined, item.url),
        }))
        .filter((item) => isPlayableMedia(item.mediaType));
      if (accepted.length === 0) return;
      current.methods.addMultipleStreams(accepted, true);
      // 切到播放器：推送的意义就是"现在就看"，留在别的视图里等于没反应
      setView('player');
    });
    return off;
  }, []);

  return (
    <div className="h-full w-full bg-slate-950 text-slate-200 font-sans overflow-hidden">
      {/* 音频工坊仍是条件挂载（切走即卸载），与画廊/磁力不同：
        它的窗口级快捷键没有 isVisible 闸（见 AudioPanel 的 keydown effect），
        常驻挂载会让空格/回车在播放器里继续触发工坊的编译与试听。 */}
      <div
        className={`fixed inset-0 z-50 transition-transform duration-300 ease-out will-change-transform bg-slate-950 ${view === 'audio' ? 'translate-y-0 pointer-events-auto' : 'translate-y-full pointer-events-none'
          }`}
      >
        {view === 'audio' && <AudioPanel onBack={() => setView('player')} />}
      </div>

      <div
        className={`fixed inset-0 z-50 transition-transform duration-300 ease-out will-change-transform bg-slate-950 ${view === 'gallery' ? 'translate-y-0 pointer-events-auto' : 'translate-y-full pointer-events-none'
          }`}
      >
        {galleryVisited && (
          <GalleryPanel
            onBack={() => setView('player')}
            onBrowseInPlayer={handleBrowseGallery}
            onPlayMediaStreams={handlePlayMediaStreams}
            onAppendToPlayer={handleAppendGalleryPages}
            onMergeToPlayer={handleMergeGalleryPages}
          />
        )}
      </div>

      <div
        className={`fixed inset-0 z-50 transition-transform duration-300 ease-out will-change-transform bg-slate-950 ${view === 'torrent' ? 'translate-y-0 pointer-events-auto' : 'translate-y-full pointer-events-none'
          }`}
      >
        {torrentVisited && (
          <TorrentPanel onBack={() => setView('player')} />
        )}
      </div>

      <div
        className={`fixed inset-0 z-30 flex flex-col transition-transform duration-300 ease-out will-change-transform bg-slate-950 ${view === 'player' ? 'translate-x-0' : 'translate-x-full'
          }`}
      >
        <PlayPanel
          player={player}
          isVisible={view === 'player'}
          onOpenGallery={openGalleryView}
          onOpenTorrent={openTorrentView}
          onOpenAudio={openAudioView}
        />
      </div>

      {/* 悬浮球常驻挂载：切到音频工坊/画廊时只 display:none 藏起来，不卸载。
        之前这里 view !== 'player' 直接不渲染，切一次视图球内全部状态清零。
        Agent 不在这里 —— 它随浏览器外壳迁到插件的悬浮球 */}
      <div className={view === 'player' ? 'fixed inset-0 z-50 pointer-events-none block' : 'hidden'}>
        <Floating />
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return <PlayerLayout />;
};

export default App;
