import React from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  Play,
  RotateCw,
  StopCircle,
} from 'lucide-react';
import { useAcgmho } from '../../engines';
import { GalleryBrowse } from './GalleryBrowse';

interface GalleryFloatingProps {
  currentUrl?: string;
  onBrowseInPlayer?: (gallery: { title: string; gid?: string; pages: { url: string; title: string; page?: number }[] }) => void;
  onAppendToPlayer?: (pages: { url: string; title: string; page?: number }[], gid?: string) => void;
  onMergeToPlayer?: (pages: { url: string; title: string; page?: number }[], gid?: string) => void;
}

export const GalleryFloating: React.FC<GalleryFloatingProps> = ({
  currentUrl = '',
  onBrowseInPlayer,
  onAppendToPlayer,
  onMergeToPlayer,
}) => {
  const { state, actions } = useAcgmho();
  const {
    probeResult,
    pageRange,
    delayMs,
    isDownloading,
    progress,
    isFetchingPages,
    fetchProgress,
    failedPages,
    error,
    lastDownloadDir,
    isElectron,
  } = state;

  // 画廊点击封面 → 探测详情 → 进入详情视图；返回则 reset 回浏览
  const openDetail = (url: string) => {
    const t = (url || '').trim();
    if (!t) return;
    actions.setInputGid(t);
    void actions.probe(t);
  };

  const backToBrowse = () => {
    actions.reset();
  };

  const handleBrowseInPlayer = async () => {
    let current = probeResult;
    if (!current) return;

    const total = current.totalPages;
    const title = current.title;
    const targetRange = pageRange.trim() || `1-${total}`;
    const isFirstPageIncluded =
      targetRange.startsWith('1-') ||
      targetRange.startsWith('1,') ||
      targetRange === '1' ||
      !pageRange.trim();

    let hasLoadedFirst = false;

    // 1. 若为动画视频
    if (current.mediaType === 'video' || current.category === 'animation') {
      if (onBrowseInPlayer) {
        onBrowseInPlayer({
          title,
          pages: [
            {
              url: current.videoUrl || current.firstImgUrl,
              title: `${title} (动画视频)`,
            },
          ],
        });
      }
      return;
    }

    // 2. 若为 ASMR / 有声音声：无有效音轨时不再把页面地址硬塞成音频，
    // 否则会产生播不出的坏条目；直接提示并返回
    if (current.mediaType === 'audio' || current.category === 'asmr') {
      const audioTracks =
        current.audioList && current.audioList.length > 0
          ? current.audioList
              .filter((a: any) => a && a.url)
              .map((a: any, idx: number) => ({
                url: a.url,
                title: a.name || `${title} - 音轨 ${idx + 1}`,
              }))
          : [];
      if (audioTracks.length === 0) return;
      if (onBrowseInPlayer) {
        onBrowseInPlayer({
          title,
          pages: audioTracks,
        });
      }
      return;
    }

    // 3. 漫画或动图图集
    // 若范围包含第 1 页，立即将已知第 1 页直链推送并跳转，0等待秒开
    if (isFirstPageIncluded && current.firstImgUrl && onBrowseInPlayer) {
      onBrowseInPlayer({
        title,
        gid: current.gid,
        pages: [
          {
            url: current.firstImgUrl,
            title: `${title} - P01/${total}`,
            page: 1,
          },
        ],
      });
      hasLoadedFirst = true;
    }

    if (total <= 1 && hasLoadedFirst) return;

    // 2. 后台流式解析剩余页面并实时追加进播放列表（页码随包透传，供有序合并与断点续抓）
    await actions.fetchPages(current.gid, targetRange, (item) => {
      if (!hasLoadedFirst && onBrowseInPlayer) {
        onBrowseInPlayer({
          title,
          gid: current.gid,
          pages: [
            {
              url: item.url,
              title: item.title,
              page: item.page,
            },
          ],
        });
        hasLoadedFirst = true;
      } else if (onAppendToPlayer) {
        if (!isFirstPageIncluded || item.page > 1) {
          onAppendToPlayer([
            {
              url: item.url,
              title: item.title,
              page: item.page,
            },
          ], current.gid);
        }
      }
    });
  };

  // 失败页一键重试：只重抓失败页码，回来按页码归位（不断点、不重头）
  const handleRetryFailed = async () => {
    if (!probeResult || failedPages.length === 0 || !onMergeToPlayer) return;
    await actions.retryFailedPages((items) => {
      onMergeToPlayer(
        items.map((it) => ({ url: it.url, title: it.title, page: it.page })),
        probeResult.gid
      );
    });
  };

  // 无探测结果 → 浏览画廊（频道分类 + 封面流 + ID 直达）；有结果 → 详情
  if (!probeResult) {
    return (
      <div className="flex h-full min-h-0 flex-col text-slate-200">
        <div className="mb-3 flex shrink-0 items-center gap-2 text-xs font-semibold text-slate-400">
          <BookOpen className="h-4 w-4 text-rose-400" />
          <span>ACG 画廊 (acgmho.com) — 选分类、挑封面，一键推送到播放器</span>
        </div>

        {/* 探测错误（如 ID 不存在） */}
        {error && (
          <div className="mb-3 flex shrink-0 items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
            <div className="flex-1 leading-relaxed">{error}</div>
          </div>
        )}

        {/* 非 Electron 提示 */}
        {!isElectron && (
          <div className="mb-3 flex shrink-0 items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-2.5 text-xs text-amber-200">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />
            <span>当前非桌面端 Electron 环境，浏览画廊与下载功能受限。</span>
          </div>
        )}

        <div className="min-h-0 flex-1">
          <GalleryBrowse currentUrl={currentUrl} onOpenItem={openDetail} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1 text-slate-200">
      {/* 详情视图：返回画廊 */}
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={backToBrowse}
          className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          返回画廊
        </button>
        <span className="truncate text-xs text-zinc-500">正在查看作品详情，可推送到播放器或下载全本</span>
      </div>

      {/* 图集解析结果卡片 */}
        <div className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/5 p-4 shadow-xl backdrop-blur-md">
          <div className="flex gap-4">
            {/* 封面预览 */}
            <div className="relative h-32 w-24 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-md">
              {probeResult.firstImgUrl ? (
                <img
                  src={probeResult.firstImgUrl}
                  alt={probeResult.title}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-slate-600">
                  <BookOpen className="h-8 w-8" />
                </div>
              )}
              <div className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[9px] font-mono font-bold text-white">
                P1
              </div>
            </div>

            {/* 详情与元信息 */}
            <div className="flex flex-1 flex-col justify-between">
              <div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold text-rose-300">
                    ID: {probeResult.gid}
                  </span>
                  {probeResult.category === 'animation' ? (
                    <span className="rounded-md border border-indigo-400/30 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-bold text-indigo-300">
                      🎬 动画视频 (HLS)
                    </span>
                  ) : probeResult.category === 'asmr' ? (
                    <span className="rounded-md border border-cyan-400/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold text-cyan-300">
                      🎧 有声音声 / ASMR
                    </span>
                  ) : probeResult.isAnimated ? (
                    <span className="rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                      🔥 动图图集 (WebP/GIF)
                    </span>
                  ) : (
                    <span className="rounded-md border border-sky-400/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-sky-300">
                      📖 漫画共 {probeResult.totalPages} 页
                    </span>
                  )}
                  <span className="rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                    /{probeResult.prefix}/
                  </span>
                </div>

                <h3 className="mt-2 line-clamp-2 text-sm font-bold text-white leading-snug" title={probeResult.title}>
                  {probeResult.title}
                </h3>
              </div>

              <div className="flex items-center gap-2 pt-2 text-xs text-slate-400">
                <a
                  href={probeResult.firstPageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-white transition-colors"
                >
                  <ExternalLink className="h-3 w-3" />
                  <span>访问网页</span>
                </a>
              </div>
            </div>
          </div>

          {/* 下载配置与动作 */}
          <div className="flex flex-col gap-3 border-t border-white/10 pt-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-slate-400">
                  下载页码范围
                </label>
                <input
                  type="text"
                  value={pageRange}
                  onChange={(e) => actions.setPageRange(e.target.value)}
                  placeholder={`例如 1-${probeResult.totalPages} 或 1,3,5`}
                  disabled={isDownloading}
                  className="w-full rounded-lg border border-white/10 bg-slate-900/80 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-rose-400/50 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold text-slate-400">
                  请求间隔（秒）
                </label>
                <select
                  value={delayMs}
                  onChange={(e) => actions.setDelayMs(Number(e.target.value))}
                  disabled={isDownloading}
                  className="w-full rounded-lg border border-white/10 bg-slate-900/80 px-2.5 py-1.5 text-xs text-white focus:border-rose-400/50 focus:outline-none"
                >
                  <option value={500}>0.5s（极速）</option>
                  <option value={1000}>1.0s（标准推荐）</option>
                  <option value={2000}>2.0s（防风控）</option>
                </select>
              </div>
            </div>

            {/* 下载与浏览控制按钮 */}
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => actions.setPageRange(`1-${probeResult.totalPages}`)}
                  disabled={isDownloading || isFetchingPages}
                  className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold text-slate-300 hover:bg-white/10 transition-colors"
                >
                  全本 ({probeResult.totalPages}P)
                </button>
                {probeResult.totalPages > 10 && (
                  <button
                    type="button"
                    onClick={() => actions.setPageRange('1-5')}
                    disabled={isDownloading || isFetchingPages}
                    className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold text-slate-300 hover:bg-white/10 transition-colors"
                  >
                    前 5 页
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                {/* 抓取中禁用：防连点开出两轮并发，交错追加搅乱顺序 */}
                <button
                  type="button"
                  onClick={handleBrowseInPlayer}
                  disabled={isDownloading || isFetchingPages}
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 via-sky-500 to-cyan-400 px-4 py-2 text-xs font-bold text-white shadow-lg transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
                  title="无需下载，直接将漫画抓取到播放器顺序翻页浏览"
                >
                  <Play className="h-4 w-4 fill-current" />
                  <span>
                    {isFetchingPages
                      ? '载入中...'
                      : probeResult.category === 'animation'
                      ? '播放动画'
                      : probeResult.category === 'asmr'
                      ? '播放音声'
                      : probeResult.isAnimated
                      ? '开阅动图'
                      : '在播放器中浏览'}
                  </span>
                </button>

                {!isDownloading ? (
                  <button
                    onClick={() => actions.startDownload()}
                    disabled={isFetchingPages}
                    className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-rose-500 via-pink-500 to-amber-500 px-4 py-2 text-xs font-bold text-white shadow-lg transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
                  >
                    <Download className="h-4 w-4" />
                    <span>下载全本</span>
                  </button>
                ) : (
                  <button
                    onClick={() => actions.cancelDownload()}
                    className="flex items-center gap-2 rounded-xl bg-rose-600/80 hover:bg-rose-600 px-4 py-2 text-xs font-bold text-white shadow-lg transition-all active:scale-95"
                  >
                    <StopCircle className="h-4 w-4" />
                    <span>取消下载</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

      {/* 在线解析与载入进度条 */}
      {fetchProgress && (
        <div className="flex flex-col gap-2 rounded-2xl border border-sky-400/20 bg-sky-950/40 p-3.5 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-sky-200">
              <RotateCw className={`h-3.5 w-3.5 ${isFetchingPages ? 'animate-spin' : ''} text-sky-400`} />
              <span className="font-semibold">{fetchProgress.message}</span>
            </div>
            <span className="font-mono text-xs font-bold text-sky-300">
              {fetchProgress.current} / {fetchProgress.total}
            </span>
          </div>

          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 via-sky-400 to-cyan-300 transition-all duration-200"
              style={{
                width: `${fetchProgress.total > 0
                  ? Math.min(100, Math.round((fetchProgress.current / fetchProgress.total) * 100))
                  : 0
                  }%`,
              }}
            />
          </div>

          {isFetchingPages && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => actions.cancelFetchPages()}
                className="text-[10px] text-slate-400 hover:text-rose-300 transition"
              >
                停止后续载入
              </button>
            </div>
          )}
        </div>
      )}

      {/* 失败页横幅：长图集总有几页网络抖动挂掉，一键只重抓这些页，按页码归位 */}
      {!isFetchingPages && failedPages.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-400/25 bg-amber-500/10 px-3.5 py-2.5">
          <div className="flex items-center gap-2 text-xs text-amber-200">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />
            <span>
              {failedPages.length} 页解析失败（{failedPages.slice(0, 8).map((f) => `P${f.page}`).join('、')}
              {failedPages.length > 8 ? '…' : ''}），剧情在此断档
            </span>
          </div>
          <button
            type="button"
            onClick={handleRetryFailed}
            disabled={isDownloading}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-3.5 py-1.5 text-xs font-bold text-white shadow transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
          >
            <RotateCw className="h-3.5 w-3.5" />
            重试失败页
          </button>
        </div>
      )}

      {/* 实时进度条 */}
      {progress && (
        <div className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-slate-900/90 p-4 shadow-xl">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              {progress.status === 'downloading' && (
                <RotateCw className="h-3.5 w-3.5 animate-spin text-rose-400" />
              )}
              {progress.status === 'completed' && (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              )}
              {progress.status === 'cancelled' && (
                <AlertCircle className="h-3.5 w-3.5 text-amber-400" />
              )}
              <span className="font-semibold text-slate-200">
                {progress.message || (progress.status === 'completed' ? '下载完成' : '下载中...')}
              </span>
            </div>
            <span className="font-mono text-xs font-bold text-rose-300">
              {progress.currentPage} / {progress.totalPages}
            </span>
          </div>

          {/* 进度条轨道 */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full transition-all duration-300 ${progress.status === 'completed'
                ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                : 'bg-gradient-to-r from-rose-500 via-pink-500 to-amber-400'
                }`}
              style={{
                width: `${progress.totalPages > 0
                  ? Math.min(100, Math.round((progress.currentPage / progress.totalPages) * 100))
                  : 0
                  }%`,
              }}
            />
          </div>

          {/* 底部打开目录按钮 */}
          {(progress.status === 'completed' || lastDownloadDir) && (
            <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2 text-xs">
              <span className="text-[11px] text-slate-400">已保存至本地 Downloads/acgmho 目录</span>
              <button
                onClick={() => actions.openFolder()}
                className="flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-300 hover:bg-emerald-500/20 transition-all"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                <span>打开下载文件夹</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
