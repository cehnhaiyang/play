import React, { useEffect } from 'react';
import { X, Keyboard } from 'lucide-react';
import { IconButton } from './ui';

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** 分组后的快捷键定义：原来 9 条平铺两列，语义相近的（翻页 / 跳转 / 音量）混在一起，
 *  读起来要靠猜。按「播放控制 / 画面与窗口」两组归拢，并补上此前漏记的 K、Esc。
 *  分页媒体专属的按键单独成组：图集与文档下方向键是翻页而不是快退快进，
 *  混在「播放控制」里会让人以为视频也能按 ← → 翻页。 */
const SHORTCUT_GROUPS: { title: string; items: { label: string; keys: string[] }[] }[] = [
  {
    title: '播放控制',
    items: [
      { label: '播放 / 暂停', keys: ['Space', 'K'] },
      { label: '上一个 / 下一个', keys: ['P', 'N'] },
      { label: '快退 / 快进 10 秒', keys: ['J', 'L'] },
      { label: '快退 / 快进 5 秒', keys: ['←', '→'] },
      { label: '增加 / 减小音量', keys: ['↑', '↓'] },
      { label: '静音切换', keys: ['M'] },
    ],
  },
  {
    title: '画面与窗口',
    items: [
      { label: '全屏模式', keys: ['F'] },
      { label: '退出全屏 / 关闭浮层', keys: ['Esc'] },
      { label: '收起 / 展开播放列表', keys: ['['] },
      { label: '本快捷键说明', keys: ['?'] },
    ],
  },
];

/** 图集 / 文档 / 绘本下，方向键与 J L P N 全部改为翻页 */
const PAGED_SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: '上一页', keys: ['P', '←'] },
  { label: '下一页', keys: ['N', '→'] },
  { label: '播放 / 暂停轮播', keys: ['Space', 'K'] },
];

const KeyCap: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="min-w-[26px] text-center px-2 py-1 bg-slate-800/90 border border-slate-600/70 border-b-2 rounded-md text-[11px] font-mono font-bold text-slate-100 shadow-sm">
    {children}
  </kbd>
);

const ShortcutRow: React.FC<{ label: string; keys: string[] }> = ({ label, keys }) => (
  <div className="flex items-center justify-between gap-3">
    <span className="text-xs text-slate-300">{label}</span>
    <div className="flex gap-1 shrink-0">
      {keys.map((k) => <KeyCap key={k}>{k}</KeyCap>)}
    </div>
  </div>
);

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="快捷键指南"
        className="bg-slate-900 border border-white/10 rounded-2xl w-full max-w-xl shadow-2xl animate-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto custom-scrollbar"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4 sticky top-0 bg-slate-900/95 backdrop-blur z-10">
          <div className="flex items-center gap-2.5">
            <span className="p-1.5 rounded-lg bg-indigo-500/15 border border-indigo-500/25">
              <Keyboard className="w-4 h-4 text-indigo-400" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-white">快捷键指南</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">输入框聚焦时，除 Esc 外均不生效</p>
            </div>
          </div>
          <IconButton label="关闭 (Esc)" onClick={onClose}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="px-6 py-4 grid gap-4 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h4 className="text-[11px] font-bold text-indigo-300/90 tracking-wide mb-2">{group.title}</h4>
              <div className="space-y-1.5 bg-slate-950/50 p-3 rounded-xl border border-white/5">
                {group.items.map((item) => (
                  <ShortcutRow key={item.label} label={item.label} keys={item.keys} />
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* 分页媒体（图集 / 文档 / 绘本）的按键映射与视频不同，单独说明 */}
        <div className="px-6 pb-2">
          <h4 className="text-[11px] font-bold text-emerald-300/90 tracking-wide mb-2">
            图集 / 文档 / 绘本模式
          </h4>
          <div className="space-y-1.5 bg-slate-950/50 p-3 rounded-xl border border-white/5">
            {PAGED_SHORTCUTS.map((item) => (
              <ShortcutRow key={item.label} label={item.label} keys={item.keys} />
            ))}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-white/10 flex items-center justify-between gap-4">
          <p className="text-[11px] text-slate-500">
            翻页媒体下 <span className="font-mono text-slate-400">← →</span> 用于翻页，不触发快退快进
          </p>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-indigo-600/25 shrink-0"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShortcutsModal;
