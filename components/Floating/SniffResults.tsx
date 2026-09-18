import React, { useCallback, useState } from 'react';
import {
  Download,
  FileQuestion,
  Film,
  Image as ImageIcon,
  ListFilter,
  Music,
  Play,
  Radio,
  RefreshCw,
  Sparkles,
  BookOpen,
  FileText,
  Copy,
  Check,
  Trash2,
  Globe,
} from 'lucide-react';
import { useSniff } from '../../hooks';
import { FoundLink, MediaType } from '../../meta';
import { isAcgUrl } from '../../utils';

interface SnifferResultsProps {
  sniffer: ReturnType<typeof useSniff>;
  onPlay: (link: FoundLink) => void;
  onAiAnalyze: () => void;
  onOpenGallery?: (url: string) => void;
  currentUrl: string;
}

const getTypeIcon = (type: MediaType) => {
  switch (type) {
    case 'stream':
      return <Radio className="h-4 w-4" />;
    case 'video':
      return <Film className="h-4 w-4" />;
    case 'audio':
      return <Music className="h-4 w-4" />;
    case 'image':
      return <ImageIcon className="h-4 w-4" />;
    case 'document':
      return <FileText className="h-4 w-4" />;
    default:
      return <FileQuestion className="h-4 w-4" />;
  }
};

const getTypeColor = (type: MediaType) => {
  switch (type) {
    case 'stream':
      return 'border-orange-300/20 bg-orange-500/12 text-orange-200';
    case 'video':
      return 'border-sky-300/20 bg-sky-500/12 text-sky-200';
    case 'audio':
      return 'border-pink-300/20 bg-pink-500/12 text-pink-200';
    case 'image':
      return 'border-emerald-300/20 bg-emerald-500/12 text-emerald-200';
    case 'document':
      return 'border-cyan-300/20 bg-cyan-500/12 text-cyan-200';
    default:
      return 'border-white/10 bg-white/6 text-slate-300';
  }
};

const SniffCard = React.memo(function SniffCard({
  index,
  link,
  isDownloading,
  canDownload,
  downloadHint,
  onDownload,
  onPlay,
}: {
  index: number;
  link: FoundLink;
  isDownloading: boolean;
  canDownload: boolean;
  downloadHint: string;
  onDownload: (link: FoundLink) => void;
  onPlay: (link: FoundLink) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_e) { }
  };

  return (
    <div className="group relative rounded-2xl border border-white/10 bg-white/5 p-3.5 shadow-[0_10px_30px_rgba(15,23,42,0.18)] transition-all duration-200 hover:border-indigo-400/40 hover:bg-white/10">
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${getTypeColor(link.type)}`}>
          {getTypeIcon(link.type)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-semibold text-slate-100" title={link.title}>
              {link.title || '未命名资源'}
            </div>
            <button
              onClick={handleCopy}
              className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-zinc-400 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
              title="复制资源链接"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          </div>

          <div className="mt-1 flex items-center gap-1 truncate font-mono text-[10px] text-slate-400 opacity-90">
            <span className="rounded border border-white/10 bg-white/8 px-1 font-bold uppercase text-slate-300">
              {link.ext || 'UNK'}
            </span>
            <span className="flex-1 truncate" title={link.url}>{link.url}</span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {link.source === 'ai' && (
              <span className="flex items-center gap-1 rounded border border-fuchsia-400/30 bg-fuchsia-500/10 px-1.5 py-0.5 text-[9px] font-bold text-fuchsia-200">
                <Sparkles className="h-2.5 w-2.5" />
                AI 深度分析
              </span>
            )}
            {link.source === 'network' && (
              <span className="rounded border border-cyan-400/30 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-bold text-cyan-200">
                网络捕获
              </span>
            )}
            {link.source === 'local' && (
              <span className="rounded border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-200">
                页面抓取
              </span>
            )}
            {link.type === 'stream' && (
              <span
                className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${canDownload
                  ? 'border-indigo-400/30 bg-indigo-500/10 text-indigo-200'
                  : 'border-white/10 bg-white/5 text-slate-400'
                  }`}
              >
                {canDownload ? 'ffmpeg 下载' : 'ffmpeg 不可用'}
              </span>
            )}
            {link.referer && (
              <span className="flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] text-zinc-400" title={link.referer}>
                <Globe className="h-2.5 w-2.5" />
                防盗链参数已捕获
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-white/8 pt-2">
        <span className="pl-1 font-mono text-[10px] text-slate-500">#{index + 1}</span>
        <div className="flex gap-2">
          <button
            onClick={() => onDownload(link)}
            disabled={isDownloading || !canDownload}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/6 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-white/12 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            title={downloadHint}
          >
            {isDownloading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            <span>下载</span>
          </button>
          <button
            onClick={() => onPlay(link)}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-1 text-xs font-medium text-white transition hover:bg-indigo-400 active:scale-95 shadow-md shadow-indigo-500/20"
          >
            <Play className="h-3 w-3 fill-current" />
            {link.type === 'image' ? '查看' : '播放'}
          </button>
        </div>
      </div>
    </div>
  );
});

export const SniffResults: React.FC<SnifferResultsProps> = ({
  sniffer,
  onPlay,
  onAiAnalyze,
  onOpenGallery,
  currentUrl,
}) => {
  const {
    filteredLinks,
    foundLinks,
    filterType,
    scopeFilter,
    isAnalyzing,
    statusMessage,
    downloadingUrl,
    downloadCapabilities,
    actions,
  } = sniffer;

  const handleDownload = useCallback(
    (link: FoundLink) => {
      void actions.download(link);
    },
    [actions]
  );

  const currentPageLinksCount = foundLinks.filter(
    (l: FoundLink) => !l.pageUrl || l.pageUrl === currentUrl
  ).length;

  return (
    <div className="flex h-full flex-col">
      {/* 顶部操作与状态栏 */}
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 pb-3.5">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold text-slate-50">
            <Sparkles className="h-4 w-4 text-indigo-300" />
            资源嗅探
          </h3>
          <p className="mt-0.5 text-xs text-slate-400">
            {isAnalyzing
              ? '正在全面扫描页面与网络请求...'
              : `已捕获 ${foundLinks.length} 项资源（当前页 ${currentPageLinksCount} 项）`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => actions.scan(currentUrl)}
            disabled={isAnalyzing}
            className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/10 hover:text-white disabled:opacity-50"
            title="刷新当前页面嗅探扫描"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isAnalyzing ? 'animate-spin text-indigo-400' : ''}`} />
            <span>重新扫描</span>
          </button>
          <button
            onClick={() => {
              if (scopeFilter === 'current') {
                actions.clearCurrentPage(currentUrl);
              } else {
                actions.clear();
              }
            }}
            disabled={filteredLinks.length === 0}
            className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-400 transition hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-40"
            title={scopeFilter === 'current' ? '清空当前页面嗅探列表' : '清空所有嗅探列表'}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{scopeFilter === 'current' ? '清空当前' : '清空全部'}</span>
          </button>
        </div>
      </div>

      {/* ACG 站点说明：图集/动画/有声不再进嗅探列表，一律走图集画廊 */}
      {currentUrl && isAcgUrl(currentUrl) && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-xs text-zinc-400">
          <BookOpen className="h-4 w-4 shrink-0 text-rose-400" />
          <span>当前为 ACG 站点页面，图集 / 动画 / 有声资源请走「图集下载」面板，不进入嗅探列表</span>
        </div>
      )}

      {/* ACG 漫画图集专属引导 */}
      {currentUrl && isAcgUrl(currentUrl) && (
        <div className="mt-3 flex items-center justify-between rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-rose-400" />
            <span className="font-bold">检测到 ACG 漫画图集页面</span>
          </div>
          {onOpenGallery && (
            <button
              onClick={() => onOpenGallery(currentUrl)}
              className="flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1 text-xs font-semibold text-white shadow transition hover:bg-rose-500"
            >
              <span>在播放器中开阅</span>
            </button>
          )}
        </div>
      )}

      {/* AI 深度嗅探引导 */}
      {currentUrl && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-indigo-400/15 bg-gradient-to-r from-indigo-500/10 via-fuchsia-500/5 to-transparent px-3.5 py-2.5">
          <div className="text-xs text-indigo-200">
            加密媒体或复杂 SPA？可调取 AI 进行 DOM 与深层网络结构挖掘。
          </div>
          <button
            onClick={onAiAnalyze}
            disabled={isAnalyzing}
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-indigo-300/30 bg-indigo-500/20 px-3 py-1.5 text-xs font-bold text-indigo-100 transition hover:border-indigo-300/50 hover:bg-indigo-500/30 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
            AI 深度嗅探
          </button>
        </div>
      )}

      {/* 筛选过滤条 (分类 + 页面范围) */}
      <div className="mt-3 flex shrink-0 items-center justify-between gap-2 overflow-x-auto rounded-2xl border border-white/8 bg-white/4 p-1.5 scrollbar-thin">
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1 pl-1 pr-2 text-slate-500">
            <ListFilter className="h-3.5 w-3.5" />
          </div>
          {(['all', 'stream', 'video', 'audio', 'image'] as const).map((item) => (
            <button
              key={item}
              onClick={() => actions.setFilterType(item)}
              className={`whitespace-nowrap rounded-xl px-2.5 py-1 text-xs font-medium transition-all duration-150 ${filterType === item
                ? 'bg-indigo-500 text-white shadow-sm'
                : 'text-slate-300 hover:bg-white/10 hover:text-white'
                }`}
            >
              {item === 'all'
                ? '全部'
                : item === 'stream'
                  ? '流媒体 (HLS)'
                  : item === 'video'
                    ? '视频 (MP4)'
                    : item === 'audio'
                      ? '音频'
                      : '图片'}
            </button>
          ))}
        </div>

        {/* 范围过滤：全部 vs 仅当前页 */}
        <div className="flex shrink-0 items-center rounded-xl border border-white/10 bg-black/20 p-0.5">
          <button
            onClick={() => actions.setScopeFilter('all')}
            className={`rounded-lg px-2 py-0.5 text-[11px] font-medium transition ${scopeFilter === 'all'
              ? 'bg-white/15 text-white'
              : 'text-zinc-400 hover:text-zinc-200'
              }`}
          >
            全部历史
          </button>
          <button
            onClick={() => actions.setScopeFilter('current')}
            className={`rounded-lg px-2 py-0.5 text-[11px] font-medium transition ${scopeFilter === 'current'
              ? 'bg-white/15 text-white'
              : 'text-zinc-400 hover:text-zinc-200'
              }`}
          >
            仅当前页
          </button>
        </div>
      </div>

      {filterType === 'stream' && (
        <div
          className={`mt-2.5 rounded-xl border px-3.5 py-1.5 text-[11px] ${downloadCapabilities.ffmpegAvailable
            ? 'border-emerald-400/15 bg-emerald-500/10 text-emerald-200'
            : 'border-amber-400/15 bg-amber-500/10 text-amber-200'
            }`}
        >
          {downloadCapabilities.ffmpegMessage}
        </div>
      )}

      {/* 资源列表区 */}
      <div className="custom-scrollbar mt-3 flex-1 space-y-2 overflow-y-auto pr-1">
        {filteredLinks.length === 0 ? (
          <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-3 text-slate-500">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
              <FileQuestion className="h-7 w-7 text-slate-500 opacity-60" />
            </div>
            <p className="text-sm">暂未嗅探到符合条件的媒体资源</p>
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={() => actions.scan(currentUrl)}
                className="text-indigo-400 hover:underline"
              >
                重新扫描当前页
              </button>
              {filterType !== 'all' && (
                <>
                  <span>·</span>
                  <button
                    onClick={() => actions.setFilterType('all')}
                    className="text-indigo-400 hover:underline"
                  >
                    查看全部资源
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          filteredLinks.map((link: FoundLink, index: number) => {
            const canDownload = link.type !== 'stream' || downloadCapabilities.ffmpegAvailable;
            const downloadHint =
              link.type === 'stream'
                ? downloadCapabilities.ffmpegAvailable
                  ? '使用 ffmpeg 下载流媒体资源'
                  : downloadCapabilities.ffmpegMessage
                : '下载资源';

            return (
              <SniffCard
                key={`${link.url}-${index}`}
                index={index}
                link={link}
                isDownloading={downloadingUrl === link.url}
                canDownload={canDownload}
                downloadHint={downloadHint}
                onDownload={handleDownload}
                onPlay={onPlay}
              />
            );
          })
        )}
      </div>

      {/* 底部状态通知栏 */}
      <div className="mt-3 rounded-2xl border border-white/8 bg-white/5 px-4 py-2 text-center text-[11px] text-slate-400">
        <p className="truncate">{statusMessage || '等待操作...'}</p>
      </div>
    </div>
  );
};
