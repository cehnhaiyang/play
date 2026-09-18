import { loadStr, saveStr } from '../utils/persist';

const API_KEY_STORAGE_KEY = 'play_gemini_api_key';

type RuntimeProcess = {
  env?: {
    API_KEY?: string;
  };
};

export const getStoredApiKey = (): string => {
  try {
    return loadStr(API_KEY_STORAGE_KEY, '', '').trim() || '';
  } catch (_error) {
    return '';
  }
};

export const getResolvedApiKey = (): string => {
  const storedApiKey = getStoredApiKey();
  if (storedApiKey) {
    return storedApiKey;
  }

  return window.process?.env?.API_KEY?.trim() || '';
};

export const syncRuntimeApiKey = () => {
  const runtimeProcess = window.process as RuntimeProcess | undefined;
  if (!runtimeProcess?.env) {
    return;
  }

  try {
    runtimeProcess.env.API_KEY = getResolvedApiKey();
  } catch (_error) {
    // Electron 通过 contextBridge 暴露的对象可能是只读的。
    // 这里保持静默回退，让调用方继续优先读取本地存储的 Key。
  }
};

export const saveApiKey = (apiKey: string) => {
  const normalizedKey = apiKey.trim();
  // 配额异常时只丢本次保存，不抛错中断调用方
  saveStr(API_KEY_STORAGE_KEY, normalizedKey, '');
  syncRuntimeApiKey();
};

export const clearApiKey = () => {
  saveStr(API_KEY_STORAGE_KEY, '', '');
  try {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  } catch (_error) {
    // ignore
  }
  syncRuntimeApiKey();
};
