import React, { useState } from 'react';
import { Download, FolderOpen, Pause, Play, Search, X, FileDown, Link2, ExternalLink } from 'lucide-react';
import { useSukebei, CATEGORY_OPTIONS as SUKEBEI_CATEGORIES } from '../../engines';
import type { TorrentTaskSnapshot } from '../../meta';

// nyaa 表区与 sukebei 里区的分类编码完全不同：旧代码切到 nyaa 还带着里区编码，
// 搜出来全是错类/空结果。按站点切换选项，切站时分类重置为全部。
const NYAA_CATEGORIES: { value: string; label: string }[] = [
  { value: '0_0', label: '全部分类' },
  { value: '1_0', label: 'Anime - 全部' },
  { value: '1_2', label: 'Anime - English' },
  { value: '1_3', label: 'Anime - Non-English' },
  { value: '1_4', label: 'Anime - Raw' },
  { value: '2_0', label: 'Audio - 全部' },
  { value: '3_0', label: 'Literature - 全部' },
  { value: '4_0', label: 'Live Action - 全部' },
  { value: '5_0', label: 'Pictures - 全部' },
  { value: '6_0', label: 'Software - 全部' },
  { value: '6_2', label: 'Software - Games' },
];

function fmtBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

function fmtSpeed(n: number): string {
  return `${fmtBytes(n)}/s`;
}

function statusText(s: TorrentTaskSnapshot['status']): string {
  switch (s) {
    case 'metadata': return '找资源中';
    case 'downloading': return '下载中';
    case 'seeding': return '做种中';
    case 'paused': return '已暂停';
    case 'error': return '出错';
    default: return s;
  }
}

const inputCls =
  'rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-cyan-400/50 placeholder:text-zinc-600';
const btnPrimary =
  'flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-indigo-500 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:brightness-110 active:scale-95 disabled:opacity-50';
const btnGhost =
  'flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300 transition-all hover:border-white/25 hover:bg-white/10 hover:text-white active:scale-95';

export const TorrentFloating: React.FC = () => {
  const { state, actions } = useSukebei();
  const { query, isSearching, results, tasks, error, notice, isElectron } = state;
  const [tab, setTab] = useState<'search' | 'tasks'>('search');

  const set = (patch: Partial<typeof query>) => actions.setQuery({ ...query, ...patch });

  const onSearch = () => {
    actions.search();
    setTab('search');
  };

  const categoryOptions = query.site === 'nyaa' ? NYAA_CATEGORIES : SUKEBEI_CATEGORIES;

  const onSiteChange = (site: string) => {
    // 切站后旧分类编码在新站无意义，重置为全部分类后按新条件搜
    const next = { ...query, site };
    if (site === 'nyaa' && !NYAA_CATEGORIES.some((c) => c.value === query.category)) {
      next.category = '0_0';
    }
    if (site !== 'nyaa' && !SUKEBEI_CATEGORIES.some((c) => c.value === query.category)) {
      next.category = '0_0';
    }
    actions.setQuery(next);
  };

  // 点下载后跳到任务页看进度；重复添加则只提示不跳转打断浏览
  const onDownloadItem = async (item: Parameters<typeof actions.downloadItem>[0]) => {
    // 做种数为 0 的是死种：任何加速手段都救不了，先预警，免得用户干等报“慢”
    // seeders 为 -1 表示站点没公布做种数（未知），不拦
    if (item.seeders === 0) {
      const go = window.confirm(
        `「${item.title.slice(0, 40)}」当前做种数为 0，可能极慢或根本无法完成。\n\n仍要尝试下载吗？`
      );
      if (!go) return;
    }
    const taskId = await actions.downloadItem(item);
    if (taskId) setTab('tasks');
  };

  const onDeleteTask = (t: TorrentTaskSnapshot) => {
    const done = t.status === 'seeding' || (t.progress >= 1 && t.total > 0);
    const msg = done
      ? `删除任务「${t.name.slice(0, 30)}」？\n\n已完成文件保留在下载目录，仅移除任务记录。`
      : `删除任务「${t.name.slice(0, 30)}」？\n\n未完成分片将被一起删除，该操作不可撤销。`;
    if (window.confirm(msg)) {
      void actions.cancelTask(t.id);
    }
  };

  if (!isElectron) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-zinc-400">
        磁力搜索与内置下载仅在 Electron 桌面端可用，请用桌面版打开。
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 搜索栏 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <input
          value={query.q}
          onChange={(e) => set({ q: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') onSearch(); }}
          placeholder="搜 sukebei / nyaa，如 blue archive、MIDA-787"
          className={`${inputCls} min-w-[180px] flex-1`}
        />
        <select value={query.site} onChange={(e) => onSiteChange(e.target.value)} className={inputCls}>
          <option value="sukebei">sukebei 里区</option>
          <option value="nyaa">nyaa 表区</option>
        </select>
        <select value={query.category} onChange={(e) => set({ category: e.target.value })} className={inputCls}>
          {categoryOptions.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <select
          value={query.sort}
          onChange={(e) => set({ sort: e.target.value })}
          className={inputCls}
          title="排序"
        >
          <option value="id">最新</option>
          <option value="seeders">做种</option>
          <option value="leechers">吸血</option>
          <option value="downloads">完成</option>
          <option value="size">大小</option>
        </select>
        <select
          value={String(query.pages)}
          onChange={(e) => set({ pages: Number(e.target.value) })}
          className={inputCls}
          title="页数"
        >
          {[1, 2, 3, 5].map((p) => (
            <option key={p} value={p}>{p} 页</option>
          ))}
        </select>
        <button onClick={onSearch} disabled={isSearching} className={btnPrimary}>
          <Search className="h-3.5 w-3.5" />
          {isSearching ? '搜索中…' : '搜索'}
        </button>
      </div>

      {/* 状态行 */}
      {(error || notice) && (
        <div className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs ${error ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'}`}>
          {error || notice}
        </div>
      )}

      {/* 子标签 */}
      <div className="flex shrink-0 items-center gap-1.5">
        {(['search', 'tasks'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1 text-xs font-semibold transition-all ${tab === t ? 'bg-white/15 text-white' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
          >
            {t === 'search' ? `结果 (${results.length})` : `下载任务 (${tasks.length})`}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={() => actions.refreshTasks()} className={btnGhost}>刷新任务</button>
      </div>

      {/* 结果列表 */}
      {tab === 'search' && (
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          {results.length === 0 && !isSearching && (
            <div className="py-10 text-center text-xs text-zinc-500">
              在上方输入关键词搜索。点「下载」直接用内置引擎下正片，无需迅雷 / qBittorrent。
            </div>
          )}
          <div className="flex flex-col gap-2">
            {results.map((it) => (
              <div key={`${it.site}-${it.id}`} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 transition-colors hover:border-white/20">
                <div className="line-clamp-2 text-xs font-medium leading-5 text-zinc-100" title={it.title}>
                  {it.title}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                  <span className="text-cyan-400/80">{it.category}</span>
                  <span>{it.size}</span>
                  <span className="text-emerald-400">做种 {it.seeders < 0 ? '?' : it.seeders}</span>
                  <span>吸血 {it.leechers < 0 ? '?' : it.leechers}</span>
                  <span>{it.date}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <button onClick={() => void onDownloadItem(it)} className={btnPrimary}>
                    <Download className="h-3 w-3" /> 下载
                  </button>
                  <button onClick={() => actions.saveTorrentFile(it)} className={btnGhost} title="只保存 .torrent 种子文件">
                    <FileDown className="h-3 w-3" /> 种子
                  </button>
                  {it.magnet && (
                    <button
                      onClick={() => {
                        try {
                          navigator.clipboard.writeText(it.magnet);
                          actions.setNotice('magnet 已复制');
                        } catch (_e) {
                          actions.setError('复制失败：浏览器剪贴板不可用');
                        }
                      }}
                      className={btnGhost}
                      title="复制 magnet"
                    >
                      <Link2 className="h-3 w-3" /> 磁链
                    </button>
                  )}
                  <button onClick={() => window.open(it.viewUrl, '_blank')} className={btnGhost} title="官网详情页">
                    <ExternalLink className="h-3 w-3" /> 详情
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 任务列表 */}
      {tab === 'tasks' && (
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          {tasks.length === 0 && (
            <div className="py-10 text-center text-xs leading-5 text-zinc-500">
              暂无下载任务，去「结果」里点「下载」开始。
              <br />
              若任务长期 0 速度：先看 peers 是否为 0——
              为 0 多半是资源已死（做种 0）或当前网络禁 P2P（换支持 P2P 的节点/直连）；
              引擎已自动挂载 17 个公共 Tracker + 6 个 DHT 入口 + 200 并行连接，
              新任务一般 1 分钟内能找到 peer。
            </div>
          )}
          <div className="flex flex-col gap-2">
            {tasks.map((t) => (
              <div key={t.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="line-clamp-1 flex-1 text-xs font-medium text-zinc-100" title={t.name}>
                    {t.name}
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${t.status === 'downloading' ? 'bg-cyan-500/15 text-cyan-300' : t.status === 'seeding' ? 'bg-emerald-500/15 text-emerald-300' : t.status === 'error' ? 'bg-rose-500/15 text-rose-300' : 'bg-white/10 text-zinc-300'}`}>
                    {statusText(t.status)}
                  </span>
                </div>
                {/* 进度条 */}
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-indigo-400 transition-all"
                    style={{ width: `${Math.round(t.progress * 100)}%` }}
                  />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-zinc-500">
                  <span>{Math.round(t.progress * 100)}%</span>
                  <span>{fmtBytes(t.downloaded)} / {fmtBytes(t.total)}</span>
                  <span>↓ {fmtSpeed(t.downloadSpeed)}</span>
                  <span>↑ {fmtSpeed(t.uploadSpeed)}</span>
                  <span>{t.numPeers} peers</span>
                  {t.files.length > 1 && <span>{t.files.length} 个文件</span>}
                </div>
                {t.status === 'error' && t.error && (
                  <div className="mt-1 text-[11px] text-rose-400">{t.error}</div>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {t.status === 'downloading' || t.status === 'metadata' ? (
                    <button onClick={() => actions.pauseTask(t.id)} className={btnGhost}>
                      <Pause className="h-3 w-3" /> 暂停
                    </button>
                  ) : (
                    <button onClick={() => actions.resumeTask(t.id)} className={btnGhost}>
                      <Play className="h-3 w-3" /> 继续
                    </button>
                  )}
                  <button onClick={() => onDeleteTask(t)} className={btnGhost}>
                    <X className="h-3 w-3" /> 删除
                  </button>
                  <button onClick={() => actions.openFolder(t.outDir || t.id)} className={btnGhost}>
                    <FolderOpen className="h-3 w-3" /> 目录
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
