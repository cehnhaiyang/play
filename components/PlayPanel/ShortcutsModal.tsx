import React, { useEffect } from 'react';
import { X, Keyboard } from 'lucide-react';

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

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

  const KeyCap: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <kbd className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-md text-xs font-mono font-bold text-slate-200 shadow-inner">
      {children}
    </kbd>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
          <div className="flex items-center gap-2">
            <Keyboard className="w-5 h-5 text-indigo-400" />
            <h3 className="text-base font-bold text-white">快捷键指南</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4 text-xs text-slate-300">
          <div className="grid grid-cols-2 gap-2.5 bg-slate-950/60 p-3.5 rounded-xl border border-slate-800/80">
            <div className="flex items-center justify-between">
              <span>播放 / 暂停（K 通用）</span>
              <div className="flex gap-1">
                <KeyCap>Space</KeyCap>
                <KeyCap>K</KeyCap>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span>上一项 / 下一项</span>
              <div className="flex gap-1">
                <KeyCap>P</KeyCap>
                <KeyCap>N</KeyCap>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span>快退 / 快进 (或翻页)</span>
              <div className="flex gap-1">
                <KeyCap>←</KeyCap>
                <KeyCap>→</KeyCap>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span>快退 / 快进 10 秒</span>
              <div className="flex gap-1">
                <KeyCap>J</KeyCap>
                <KeyCap>L</KeyCap>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span>收起 / 展开播放列表</span>
              <KeyCap>[</KeyCap>
            </div>
            <div className="flex items-center justify-between">
              <span>增加 / 减小音量</span>
              <div className="flex gap-1">
                <KeyCap>↑</KeyCap>
                <KeyCap>↓</KeyCap>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span>静音切换</span>
              <KeyCap>M</KeyCap>
            </div>
            <div className="flex items-center justify-between">
              <span>全屏模式</span>
              <KeyCap>F</KeyCap>
            </div>
            <div className="flex items-center justify-between">
              <span>快捷键说明</span>
              <KeyCap>?</KeyCap>
            </div>
          </div>
        </div>

        <div className="mt-5 pt-3 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold transition"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
};
