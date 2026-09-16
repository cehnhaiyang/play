/**
 * 悬浮球持久化小工具：localStorage JSON 存取，全部 try/catch 包裹。
 * 配额爆了/隐私模式都只影响“记住”，不影响功能。
 */
const PREFIX = 'theplay.floating.';

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // 配额不足等：只丢本次快照，不抛错
  }
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}
