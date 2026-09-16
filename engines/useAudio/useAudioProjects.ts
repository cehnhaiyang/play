import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Project, Message } from '../../meta';
import { loadProjects, saveProjects, createNewProject } from '../../services/AudioService/persistence';

export const useAudioProjects = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  // 首轮 save 必须等 load 落盘读取完成后才允许，否则挂载瞬间会用初始 [] 覆盖用户存量工程
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    const savedProjects = loadProjects();
    if (savedProjects.length > 0) {
      setProjects(savedProjects);
    }
    hasLoadedRef.current = true;
  }, []);

  useEffect(() => {
    if (!hasLoadedRef.current) return;
    saveProjects(projects);
  }, [projects]);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) || null,
    [activeProjectId, projects]
  );

  const createProject = useCallback(() => {
    const newProject = createNewProject();
    newProject.name = `未命名项目 ${projects.length + 1}`;
    setProjects((prev) => [newProject, ...prev]);
    setActiveProjectId(newProject.id);
    return newProject.id;
  }, [projects.length]);

  const deleteProject = useCallback((id: string) => {
    setProjects((prev) => prev.filter((project) => project.id !== id));
    setActiveProjectId((prev) => (prev === id ? null : prev));
  }, []);

  const updateActiveProject = useCallback((updates: Partial<Project>) => {
    if (!activeProjectId) return;

    setProjects((prev) => prev.map((project) => {
      if (project.id !== activeProjectId) {
        return project;
      }

      return {
        ...project,
        ...updates,
        lastModified: Date.now(),
      };
    }));
  }, [activeProjectId]);

  const updateProjectMessages = useCallback((messages: Message[]) => {
    if (!activeProjectId) return;

    setProjects((prev) => {
      let changed = false;

      const nextProjects = prev.map((project) => {
        if (project.id !== activeProjectId) {
          return project;
        }

        if (project.messages === messages) {
          return project;
        }

        changed = true;
        return {
          ...project,
          messages,
          lastModified: Date.now(),
        };
      });

      return changed ? nextProjects : prev;
    });
  }, [activeProjectId]);

  const importProjectFromFile = useCallback((file: File, callback: (newId: string) => void) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;

      const newProject = createNewProject();
      newProject.name = file.name.replace('.spg', '').replace('.txt', '') || 'Imported Project';
      newProject.code = content;
      newProject.messages.push({
        role: 'system',
        content: '已导入外部代码文件。您可以继续在此基础上进行修改。',
        timestamp: Date.now(),
      });

      setProjects((prev) => [newProject, ...prev]);
      setActiveProjectId(newProject.id);
      callback(newProject.id);
    };
    reader.readAsText(file);
  }, []);

  const actions = useMemo(() => ({
    createProject,
    deleteProject,
    updateActiveProject,
    updateProjectMessages,
    importProjectFromFile,
    setActiveProjectId,
  }), [createProject, deleteProject, importProjectFromFile, updateActiveProject, updateProjectMessages]);

  return useMemo(() => ({
    projects,
    activeProjectId,
    activeProject,
    actions,
  }), [actions, activeProject, activeProjectId, projects]);
};
