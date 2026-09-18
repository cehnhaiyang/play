import React, { useState, useEffect, useCallback, useRef } from 'react';
import { usePlay, useBrowse, useTamper } from './hooks';
import { BrowsePanel, PlayPanel, Floating, AudioPanel, GalleryPanel } from './components';
import { FoundLink, getElectronAPI, MediaType } from './meta';
import { getMediaType, resolveProbeMedia } from './utils';

type ViewMode = 'sniffer' | 'player' | 'audio' | 'gallery';

const PlayerLayout: React.FC = () => {
  const player = usePlay();
  const browse = useBrowse();
  const tamper = useTamper();

  const { tabs, sniffer, interactions } = browse;
  const { getActiveWebview, isElectron } = interactions;
  const currentUrl = tabs.activeTab.url;

  useEffect(() => {
    if (currentUrl) {
      sniffer.actions.scan(currentUrl);
      const t1 = window.setTimeout(() => sniffer.actions.scan(currentUrl), 1500);
      const t2 = window.setTimeout(() => sniffer.actions.scan(currentUrl), 3500);
      return () => {
        window.clearTimeout(t1);
        window.clearTimeout(t2);
      };
    }
  }, [currentUrl, sniffer.actions.scan]);

  useEffect(() => {
    const webview = getActiveWebview();
    tamper.actions.registerWebview(webview);
  }, [getActiveWebview, tamper.actions]);

  const [view, setView] = useState<ViewMode>('sniffer');
  // 画廊懒挂载：GalleryPanel 首屏 effect 会预拉 latest 频道，常驻挂载等于每次启动都偷跑流量；
  // 且百张封面图常驻后台会持续占用解码与内存。首次进入时挂载，之后 keep-alive 保状态。
  const [galleryVisited, setGalleryVisited] = useState(false);
  const openGalleryView = useCallback(() => {
    setGalleryVisited(true);
    setView('gallery');
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

  // 直连抓取的 run 标识：用户连点两次时，旧轮回包直接丢弃
  const galleryRunRef = useRef(0);

  const handleOpenGalleryFromUrl = useCallback(async (url: string) => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.acgmho?.probe) return;
    try {
      const probe = await electronAPI.acgmho.probe(url);
      // 与 PlayPanel 共用 resolveProbeMedia：video/audio 缺有效 URL 时回落并提示，
      // 不再把页面地址硬塞成音视频条目（旧分支会产生播不出的坏条目）
      const resolved = resolveProbeMedia(probe);
      if (resolved.kind === 'none' || resolved.streams.length === 0) {
        console.warn('Gallery probe produced no playable media:', resolved.status);
        return;
      }

      // 1. 动画 / 视频
      if (resolved.kind === 'video') {
        const vUrl = resolved.streams[0].url;
        player.methods.addStream(vUrl, probe.title, true);
        setView('player');
        return;
      }

      // 2. 音声 / ASMR / 音频（追加新分组，不清空旧列表）
      if (resolved.kind === 'audio') {
        player.methods.addMultipleStreams(resolved.streams, true, false);
        setView('player');
        return;
      }

      // 3. 图集 / 漫画 / 动图
      if (resolved.kind === 'image') {
        handleBrowseGallery({
          title: probe.title,
          gid: probe.gid,
          pages: [
            {
              url: resolved.streams[0].url,
              title: `${probe.title} - P01/${probe.totalPages}`,
              page: 1,
            },
          ],
        });

        if (probe.totalPages > 1) {
          galleryRunRef.current += 1;
          const runId = `app-${Date.now()}-${galleryRunRef.current}`;
          electronAPI.acgmho.fetchPages({
            gidOrUrl: probe.firstPageUrl || probe.gid,
            pages: `1-${probe.totalPages}`,
            delayMs: 100,
            runId,
            // 复用详情探测结果，防 /h/ 与 /hentai/ 同名异帖串台
            probe,
          }).then((res) => {
            // 旧轮回包作废（用户又开了一本新的）
            if (!res || res.runId !== runId) return;
            if (res?.pages) {
              // 按页码过滤而非 slice(1)：第 1 页抓取失败时 slice 会误丢第 2 页
              handleAppendGalleryPages(res.pages.filter((p) => p.page !== 1), probe.gid);
            }
            if (res?.errors?.length) {
              console.warn(`Gallery ${probe.gid}: ${res.errors.length} 页解析失败`, res.errors);
            }
          }).catch((e) => {
            // 直推抓取是无界面的后台续页，失败只记日志（首屏已展示，不打断阅读）
            console.warn(`Gallery ${probe.gid} 后续页抓取失败:`, e?.message || e);
          });
        }
      }
    } catch (e) {
      console.error('Failed to open gallery from URL:', e);
    }
  }, [handleBrowseGallery, handleAppendGalleryPages, player.methods]);

  return (
    <div className="h-full w-full bg-slate-950 text-slate-200 font-sans overflow-hidden">
      <div
        className={`fixed inset-0 z-20 transition-all duration-300 ease-out ${
          view === 'sniffer' ? 'translate-x-0 opacity-100' : '-translate-x-[30%] opacity-0 pointer-events-none'
        }`}
      >
        <BrowsePanel
          isVisible={view === 'sniffer'}
          onNavigateToPlayer={() => setView('player')}
          onNavigateToAudio={() => setView('audio')}
          onNavigateToGallery={openGalleryView}
          onOpenGalleryInPlayer={handleOpenGalleryFromUrl}
          browse={browse}
        />
      </div>

      <div
        className={`fixed inset-0 z-50 transition-transform duration-300 ease-out will-change-transform bg-slate-950 ${
          view === 'audio' ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        {view === 'audio' && <AudioPanel onBack={() => setView('sniffer')} />}
      </div>

      <div
        className={`fixed inset-0 z-50 transition-transform duration-300 ease-out will-change-transform bg-slate-950 ${
          view === 'gallery' ? 'translate-y-0 pointer-events-auto' : 'translate-y-full pointer-events-none'
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
        className={`fixed inset-0 z-30 flex flex-col transition-transform duration-300 ease-out will-change-transform bg-slate-950 ${
          view === 'player' ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <PlayPanel player={player} onBackToBrowse={() => setView('sniffer')} />
      </div>

      {/* 悬浮球常驻挂载：切到播放器/音频工坊时只 display:none 藏起来，不卸载。
        之前这里 view !== 'sniffer' 直接不渲染，切一次视图球内全部状态清零 */}
      {isElectron && (
        <div className={view === 'sniffer' ? 'fixed inset-0 z-50 pointer-events-none block' : 'hidden'}>
          <Floating
            sniffer={sniffer}
            tamper={tamper}
            currentUrl={currentUrl}
            onPlay={handleSnifferPlay}
            onAiAnalyze={() => sniffer.actions.analyzeWithAi(currentUrl)}
            onOpenGallery={handleOpenGalleryFromUrl}
          />
        </div>
      )}
    </div>
  );
};

const App: React.FC = () => {
  return <PlayerLayout />;
};

export default App;
