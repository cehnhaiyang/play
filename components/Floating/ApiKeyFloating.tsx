import React, { useEffect, useMemo, useState } from 'react';
import { Check, Eye, EyeOff, KeyRound, Save, Trash2 } from 'lucide-react';
import { clearApiKey, getResolvedApiKey, getStoredApiKey, saveApiKey, syncRuntimeApiKey } from '../../services/apiKey';

export const ApiKeyFloating: React.FC = () => {
  const [draftKey, setDraftKey] = useState('');
  const [isVisible, setIsVisible] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'cleared'>('idle');

  useEffect(() => {
    syncRuntimeApiKey();
    setDraftKey(getStoredApiKey() || getResolvedApiKey());
  }, []);

  useEffect(() => {
    if (status === 'idle') {
      return;
    }

    const timer = window.setTimeout(() => setStatus('idle'), 2200);
    return () => window.clearTimeout(timer);
  }, [status]);

  const hasStoredKey = useMemo(() => Boolean(getStoredApiKey()), [status]);
  const resolvedKey = useMemo(() => getResolvedApiKey(), [status]);
  const maskedPreview = useMemo(() => {
    if (!resolvedKey) {
      return '未配置';
    }

    if (resolvedKey.length <= 8) {
      return resolvedKey;
    }

    return `${resolvedKey.slice(0, 4)}...${resolvedKey.slice(-4)}`;
  }, [resolvedKey]);

  const handleSave = () => {
    // 空输入视为清除，避免存下空字符串占位导致“已配置”误判
    if (!draftKey.trim()) {
      clearApiKey();
      setDraftKey('');
      setStatus('cleared');
      return;
    }
    saveApiKey(draftKey);
    setDraftKey(getStoredApiKey());
    setStatus('saved');
  };

  const handleClear = () => {
    clearApiKey();
    setDraftKey('');
    setStatus('cleared');
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10">
            <KeyRound className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-zinc-100">API Key 管理</h3>
            <p className="text-xs text-zinc-500">统一维护 AI 调用所使用的密钥。</p>
          </div>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-[11px] ${
            resolvedKey ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-white/10 bg-white/5 text-zinc-400'
          }`}
        >
          {resolvedKey ? '已配置' : '未配置'}
        </span>
      </div>

      <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">当前状态</span>
          <span className="text-xs text-zinc-400">{hasStoredKey ? '优先使用本地保存的 Key' : '当前回退到运行时环境'}</span>
        </div>
        <div className="mt-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono text-sm text-zinc-300">
          {maskedPreview}
        </div>
      </div>

      <div className="mt-5 space-y-2">
        <label className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Gemini API Key</label>
        <div className="relative">
          <input
            type={isVisible ? 'text' : 'password'}
            value={draftKey}
            onChange={(event) => setDraftKey(event.target.value)}
            placeholder="请输入或覆盖 API Key"
            className="w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 pr-12 text-sm text-zinc-200 outline-none transition focus:border-emerald-500/60"
          />
          <button
            onClick={() => setIsVisible((prev) => !prev)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
            title={isVisible ? '隐藏 API Key' : '显示 API Key'}
          >
            {isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <p className="text-xs text-zinc-500">保存后会立即同步到当前运行时，无需刷新页面。</p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <button
          onClick={handleSave}
          className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 py-3 font-bold text-black transition-colors hover:bg-emerald-400"
        >
          {status === 'saved' ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {status === 'saved' ? '已保存' : '保存 Key'}
        </button>
        <button
          onClick={handleClear}
          className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-zinc-900 px-4 py-3 font-bold text-zinc-300 transition-colors hover:bg-zinc-800"
        >
          <Trash2 className="h-4 w-4" />
          {status === 'cleared' ? '已清除' : '清除 Key'}
        </button>
      </div>

      <div className="mt-5 space-y-2 rounded-2xl border border-white/10 bg-gradient-to-br from-zinc-900 to-zinc-950 p-4 text-xs leading-6 text-zinc-400">
        <p>1. 本地保存的 Key 优先级高于运行时环境中的 Key。</p>
        <p>2. 资源嗅探里的 AI 深度分析与其他 AI 能力会共享这份 Key。</p>
        <p>3. 清除后会立即回退到运行时环境或未配置状态。</p>
      </div>
    </div>
  );
};
