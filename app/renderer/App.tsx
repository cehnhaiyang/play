import React, { useState, useCallback } from 'react';
import { usePlay } from './hooks';
import { PlayPanel, Floating, AudioPanel, GalleryPanel, TorrentPanel } from './components';
import { MediaType } from '../../shared/meta';
import { getMediaType } from '../../shared/core';

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
  const handlePlayMediaStreams = useCallback((pages: { url: string; title: string; mediaType?: MediaType }[]) => {
    if (pages.length === 0) return;
    const streamItems = pages.map((p) => ({
      url: p.url,
      name: p.title,
      title: p.title,
      mediaType: p.mediaType || getMediaType(p.title, undefined, p.url),
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

  return (
    <div className="h-full w-full bg-slate-950 text-slate-200 font-sans overflow-hidden">
      <div
        className={`fixed inset-0 z-50 transition-transform duration-300 ease-out will-change-transform bg-slate-950 ${view === 'audio' ? 'translate-y-0' : 'translate-y-full'
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
        <PlayPanel player={player} isVisible={view === 'player'} />
      </div>

      {/* 悬浮球常驻挂载：切到音频工坊/画廊时只 display:none 藏起来，不卸载。
        之前这里 view !== 'player' 直接不渲染，切一次视图球内全部状态清零。
        Agent 不在这里 —— 它随浏览器外壳迁到插件侧边栏 */}
      <div className={view === 'player' ? 'fixed inset-0 z-50 pointer-events-none block' : 'hidden'}>
        <Floating
          onOpenGallery={openGalleryView}
          onOpenTorrent={openTorrentView}
        />
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return <PlayerLayout />;
};

export default App;
