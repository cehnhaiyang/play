import React, { useState, useEffect, useCallback, useRef } from 'react';
import { usePlay, useBrowse, useAgent } from './hooks';
import { BrowsePanel, PlayPanel, Floating, AudioPanel, GalleryPanel, TorrentPanel } from './components';
import { FoundLink, MediaType, getAppWindow } from './meta';
import { getMediaType } from './const';

type ViewMode = 'sniffer' | 'player' | 'audio' | 'gallery' | 'torrent';

const PlayerLayout: React.FC = () => {
  const player = usePlay();
  const browse = useBrowse();

  const { tabs, sniffer, interactions, tamper } = browse;
  const currentUrl = tabs.activeTab.url;

  // Agent 与篡改引擎共用同一条 webview 生命周期：
  // 都靠 interactions 的 dom-ready 广播拿到页面，不各自持有 webview 引用。
  // 同时把 tamper 整个传进去 —— Agent 的三组新工具（tamper / storage /
  // tokens）做的正是篡改面板里那些事，规则真值由 useTamper 持有，这里不复制。
  //
  // kb 同理：preload 暴露的取数桥原样注入，Agent 不自己碰 window。
  // 桥缺失时 kb 工具回结构化错误而不是崩 —— 那是加载故障，不是"另一种运行环境"。
  const agent = useAgent({
    getActiveWebview: interactions.getActiveWebview,
    onPageReady: interactions.onPageReady,
    tamper,
    kb: getAppWindow().electronAPI?.kb,
  });

  // "持续嗅探"开关打开时，一次 URL 变化扫三轮（立即 + 1.5s + 3.5s），
  // 等 SPA 把资源渲染出来。开关关闭时直接返回，切页什么都不做。
  // 三轮共用一个 runId：用户快速切页时，上一页的迟到轮次会被丢弃，
  // 不会把旧页资源写进当前列表、也不会抢走新轮次的加载态。
  // 开关本身变化也会触发这里：打开开关 = 立刻给当前页来三轮。
  const scanRunRef = useRef(0);
  useEffect(() => {
    if (!sniffer.sniffEnabled || !currentUrl) return;
    scanRunRef.current += 1;
    const runId = scanRunRef.current;
    sniffer.actions.scan(currentUrl, runId);
    const t1 = window.setTimeout(() => sniffer.actions.scan(currentUrl, runId), 1500);
    const t2 = window.setTimeout(() => sniffer.actions.scan(currentUrl, runId), 3500);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [currentUrl, sniffer.sniffEnabled, sniffer.actions.scan]);

  const [view, setView] = useState<ViewMode>('sniffer');
  // 画廊懒挂载：GalleryPanel 首屏 effect 会预拉 latest 频道，常驻挂载等于每次启动都偷跑流量；
  // 且百张封面图常驻后台会持续占用解码与内存。首次进入时挂载，之后 keep-alive 保状态。
  const [galleryVisited, setGalleryVisited] = useState(false);
  const openGalleryView = useCallback(() => {
    setGalleryVisited(true);
    setView('gallery');
  }, []);
  // 磁力下载同画廊：首次进入挂载、之后 keep-alive 保状态。
  // useMagnetSearch 的查询与结果自带落盘、任务挂载即从主进程拉全量，
  // 但面板内的 tab / 站点折叠等纯 UI 状态靠常驻保留，切出去回来看下载进度不重置。
  const [torrentVisited, setTorrentVisited] = useState(false);
  const openTorrentView = useCallback(() => {
    setTorrentVisited(true);
    setView('torrent');
  }, []);

  const handleSnifferPlay = useCallback((link: FoundLink) => {
    player.methods.addStream(link.url, link.title, true, link.type);
    setView('player');
  }, [player.methods]);

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
      // 追加成新分组并跳到本批第一页，不再清空旧列表（旧行为每次推送都清空）
      player.methods.addMultipleStreams(streamItems, true, false);
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
    player.methods.addMultipleStreams(streamItems, true, false);
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
        className={`fixed inset-0 z-20 transition-all duration-300 ease-out ${view === 'sniffer' ? 'translate-x-0 opacity-100' : '-translate-x-[30%] opacity-0 pointer-events-none'
          }`}
      >
        <BrowsePanel
          isVisible={view === 'sniffer'}
          onNavigateToPlayer={() => setView('player')}
          onNavigateToAudio={() => setView('audio')}
          onNavigateToGallery={openGalleryView}
          onNavigateToTorrent={openTorrentView}
          browse={browse}
          agent={agent}
        />
      </div>

      <div
        className={`fixed inset-0 z-50 transition-transform duration-300 ease-out will-change-transform bg-slate-950 ${view === 'audio' ? 'translate-y-0' : 'translate-y-full'
          }`}
      >
        {view === 'audio' && <AudioPanel onBack={() => setView('sniffer')} />}
      </div>

      <div
        className={`fixed inset-0 z-50 transition-transform duration-300 ease-out will-change-transform bg-slate-950 ${view === 'gallery' ? 'translate-y-0 pointer-events-auto' : 'translate-y-full pointer-events-none'
          }`}
      >
        {galleryVisited && (
          <GalleryPanel
            onBack={() => setView('sniffer')}
            currentUrl={currentUrl}
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
          <TorrentPanel onBack={() => setView('sniffer')} />
        )}
      </div>

      <div
        className={`fixed inset-0 z-30 flex flex-col transition-transform duration-300 ease-out will-change-transform bg-slate-950 ${view === 'player' ? 'translate-x-0' : 'translate-x-full'
          }`}
      >
        <PlayPanel player={player} onBackToBrowse={() => setView('sniffer')} />
      </div>

      {/* 悬浮球常驻挂载：切到播放器/音频工坊时只 display:none 藏起来，不卸载。
        之前这里 view !== 'sniffer' 直接不渲染，切一次视图球内全部状态清零。
        Agent 不在这里 —— 它是浏览器面板的右侧边栏，与 webview 同生共死 */}
      <div className={view === 'sniffer' ? 'fixed inset-0 z-50 pointer-events-none block' : 'hidden'}>
        <Floating
          sniffer={sniffer}
          currentUrl={currentUrl}
          onPlay={handleSnifferPlay}
          onAiAnalyze={() => sniffer.actions.analyzeWithAi(currentUrl)}
        />
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return <PlayerLayout />;
};

export default App;
