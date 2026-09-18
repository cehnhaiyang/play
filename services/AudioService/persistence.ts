
import { Project } from '../../meta';

const STORAGE_KEYS = {
  PROJECTS: 'spg_projects_v1',
};

// Generate a random ID（优先 crypto，不可用时回退 Math.random）
const generateId = () => {
  try {
    const uuid = (globalThis as any)?.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid.length > 0) return uuid.replace(/-/g, '').slice(0, 12);
  } catch { /* ignore, fallback below */ }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 11)}`;
};

export const createNewProject = (): Project => {
  return {
    id: generateId(),
    name: '未命名项目',
    code: '# 等待 AI 生成或手动输入代码...',
    messages: [
      { role: 'system', content: '欢迎使用声音粒子Web Studio。请描述您想要生成的音频（例如："生成一段120BPM的C大调上行音阶"）。', timestamp: Date.now() }
    ],
    createdAt: Date.now(),
    lastModified: Date.now()
  };
};

export const saveProjects = (projects: Project[]) => {
  try {
    // Save minimal data to avoid quota limits, limit chat history per project
    const projectsToSave = projects.map(p => ({
      ...p,
      messages: p.messages.slice(-50) // Keep last 50 messages
    }));
    localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(projectsToSave));
  } catch (e) {
    console.warn("Failed to save projects to localStorage", e);
  }
};

export const loadProjects = (): Project[] => {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.PROJECTS);
    if (!data) return [];
    const parsed: unknown = JSON.parse(data);
    // 坏缓存自愈：非数组直接丢；条目缺 id/code 的也丢，不让脏数据进状态
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is Project =>
        !!p && typeof p === 'object' &&
        typeof (p as Project).id === 'string' &&
        typeof (p as Project).code === 'string' &&
        Array.isArray((p as Project).messages)
    );
  } catch (e) {
    console.warn("Failed to load projects from localStorage", e);
    return [];
  }
};

// Legacy support cleanup (optional)
export const clearLegacyData = () => {
  try {
    localStorage.removeItem('spg_workspace_code');
    localStorage.removeItem('spg_chat_messages');
  } catch {
    // ignore
  }
};
