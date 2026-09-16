
import { Project } from '../../meta';

const STORAGE_KEYS = {
  PROJECTS: 'spg_projects_v1',
};

// Generate a random ID
const generateId = () => Math.random().toString(36).substr(2, 9);

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
    return JSON.parse(data);
  } catch (e) {
    console.warn("Failed to load projects from localStorage", e);
    return [];
  }
};

// Legacy support cleanup (optional)
export const clearLegacyData = () => {
    localStorage.removeItem('spg_workspace_code');
    localStorage.removeItem('spg_chat_messages');
};
