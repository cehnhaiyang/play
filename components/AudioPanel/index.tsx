
/// <reference lib="dom" />
import React, { useState, useRef, useCallback } from 'react';
import ChatInterface, { ChatInterfaceRef } from './ChatInterface';
import CodeEditor from './CodeEditor';
import Visualizer from './Visualizer';
import AudioToolbox from './AudioToolbox';
import { AppState, Message, Project } from '../../meta';
import { useAudio } from '../../hooks'; 
import { 
  PlayIcon, StopIcon, ArrowUpTrayIcon, ArchiveBoxArrowDownIcon, 
  SparklesIcon, PlusIcon, TrashIcon, ArrowLeftIcon, 
  PencilSquareIcon, Bars3Icon, CubeIcon, BeakerIcon, MusicalNoteIcon,
  HomeIcon, ExclamationTriangleIcon
} from '@heroicons/react/24/solid';

type ViewState = 'dashboard' | 'workspace' | 'lab';

interface AudioPanelProps {
    onBack: () => void;
}

export const AudioPanel: React.FC<AudioPanelProps> = ({ onBack }) => {
  // Use the aggregated Audio Hook
  const audio = useAudio();
  const { state: audioState, actions: audioActions } = audio;
  
  const projectList = audioState.projects;
  const activeProjectId = audioState.activeProjectId;
  const activeProject = audioState.activeProject;
  
  const analyser = audioState.analyser;
  const appState = audioState.appState;
  const parserError = audioState.parserError;
  const autoFixCount = audioState.autoFixCount;
  const compileWarnings = audioState.compileWarnings;

  // UI Local State
  const [view, setView] = useState<ViewState>('dashboard');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  
  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatInterfaceRef = useRef<ChatInterfaceRef>(null);

  // --- Handlers ---

  const handleCreateProject = useCallback(() => {
    audioActions.stop();
    audioActions.createProject();
    setView('workspace');
    audioActions.reset();
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  }, [audioActions]);

  const handleOpenProject = useCallback((id: string) => {
    if (activeProjectId === id && view === 'workspace') return;
    
    audioActions.reset();
    audioActions.setActiveProjectId(id);
    setView('workspace');
    
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  }, [activeProjectId, audioActions, view]);

  const handleDeleteProject = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (window.confirm("确定要删除这个项目吗？此操作无法撤销。")) {
        audioActions.deleteProject(id);
        if (activeProjectId === id) {
            audioActions.stop();
            audioActions.reset();
            setView('dashboard'); 
        }
    }
  }, [activeProjectId, audioActions]);

  const handleSwitchToLab = useCallback(() => {
      audioActions.stop();
      audioActions.reset();
      setView('lab');
  }, [audioActions]);

  // --- Workspace Logic ---

  // 自动修复的最大尝试次数，防止模型反复给出同样错误的代码时无限循环
  const MAX_AUTO_FIX = 3;
  // 用 ref 记录尝试次数：state 在这里会被闭包捕获成旧值，导致计数错乱
  const fixAttemptRef = useRef(0);

  const handleCompileAndPlay = useCallback(async (
    sourceCode: string,
    options: { autoFix?: boolean } = {}
  ) => {
    const { autoFix = false } = options;
    const result = await audioActions.compileAndPlay(sourceCode);

    if (result.success) {
      fixAttemptRef.current = 0;
      return;
    }

    if (!autoFix || !result.error) return;

    if (fixAttemptRef.current >= MAX_AUTO_FIX) {
      audioActions.setParserError({
        message: `${result.error.message}（已自动修复 ${MAX_AUTO_FIX} 次仍未通过，请手动检查代码）`,
        line: result.error.line,
      });
      fixAttemptRef.current = 0;
      return;
    }

    fixAttemptRef.current += 1;
    audioActions.setAutoFixCount(fixAttemptRef.current);
    chatInterfaceRef.current?.triggerFix(sourceCode, result.error.message);
  }, [audioActions]);

  const handleCodeUpdate = useCallback((newCode: string, isAutoFix = false) => {
    audioActions.updateActiveProject({ code: newCode });
    // AI 产出的代码（含修复结果）自动试跑；修复结果若仍失败会继续触发下一轮修复
    handleCompileAndPlay(newCode, { autoFix: true });
  }, [audioActions, handleCompileAndPlay]);

  const handleMessagesUpdate = useCallback((newMessages: Message[]) => {
      audioActions.updateProjectMessages(newMessages);
  }, [audioActions]);

  const handleManualFix = useCallback(() => {
      if (parserError && chatInterfaceRef.current && activeProject) {
          fixAttemptRef.current = 0;
          audioActions.setAutoFixCount(1);
          chatInterfaceRef.current.triggerFix(activeProject.code, parserError.message);
      }
  }, [activeProject, audioActions, parserError]);

  const handleExportBundle = useCallback(() => {
      if (activeProject) {
          audioActions.exportBundle(activeProject.name, activeProject.code);
      }
  }, [activeProject, audioActions]);

  // Import logic
  const handleFileImport = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    audioActions.stop();
    audioActions.importProjectFromFile(file, (newId: string) => {
        setView('workspace');
        audioActions.reset();
    });
    event.target.value = '';
  }, [audioActions]);

  // --- Render Views ---

  const renderDashboard = () => (
    <div className="min-h-full bg-slate-950 animate-fade-in text-zinc-100 flex flex-col items-center p-8 relative overflow-y-auto">
      {/* Background Gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-slate-950 via-slate-900 to-black pointer-events-none z-[-1]" />
      
      {/* Back Button */}
      <div className="absolute top-6 left-6 z-20">
        <button 
            onClick={onBack}
            className="flex items-center gap-2 text-zinc-400 hover:text-white bg-slate-800/50 hover:bg-slate-800 px-4 py-2 rounded-xl transition border border-slate-700/50"
        >
            <ArrowLeftIcon className="w-5 h-5" />
            <span className="font-bold">返回浏览</span>
        </button>
      </div>

      <div className="w-full max-w-6xl z-10 mt-12">
        <div className="flex justify-between items-end mb-12 border-b border-zinc-800 pb-6">
            <div>
              <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-blue-500 mb-2">
                  Sound Particle Studio
              </h1>
              <p className="text-zinc-400 font-light">AI 驱动的参数化音频合成工作站</p>
            </div>
            
            <div className="flex gap-4">
                <button 
                    onClick={handleSwitchToLab}
                    className="flex items-center gap-2 bg-zinc-800/80 hover:bg-zinc-700 text-cyan-400 px-6 py-3 rounded-xl font-medium transition-all border border-zinc-700 hover:border-cyan-500/50 backdrop-blur-sm"
                >
                    <BeakerIcon className="w-5 h-5" /> 实验室
                </button>
                <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-2 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 px-6 py-3 rounded-xl font-medium transition-all border border-zinc-700 backdrop-blur-sm"
                >
                    <ArrowUpTrayIcon className="w-5 h-5" /> 导入
                </button>
                <button 
                    onClick={handleCreateProject}
                    className="flex items-center gap-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white px-6 py-3 rounded-xl font-medium shadow-lg shadow-cyan-900/40 transition-all hover:-translate-y-0.5"
                >
                    <PlusIcon className="w-5 h-5" /> 新建项目
                </button>
            </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {/* Create Card */}
            <div 
              onClick={handleCreateProject}
              className="group h-[240px] border-2 border-dashed border-zinc-800 hover:border-cyan-500/50 rounded-2xl flex flex-col items-center justify-center cursor-pointer transition-all bg-zinc-900/20 hover:bg-zinc-800/40"
            >
                <div className="w-16 h-16 rounded-full bg-zinc-800 group-hover:bg-cyan-900/30 flex items-center justify-center mb-4 transition-colors">
                    <PlusIcon className="w-8 h-8 text-zinc-500 group-hover:text-cyan-400" />
                </div>
                <span className="text-zinc-500 group-hover:text-cyan-300 font-medium">开始新创作</span>
            </div>

            {/* Project Cards */}
            {projectList.map((project: Project) => (
                <div 
                  key={project.id}
                  onClick={() => handleOpenProject(project.id)}
                  className="group relative h-[240px] bg-zinc-900/50 border border-zinc-800 hover:border-cyan-500/50 rounded-2xl p-6 transition-all cursor-pointer hover:shadow-2xl hover:shadow-black/50 overflow-hidden backdrop-blur-md flex flex-col"
                >
                    {/* Active Gradient Overlay */}
                    <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                    
                    <div className="flex justify-between items-start mb-4 relative z-10">
                        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-900 border border-zinc-700 flex items-center justify-center shadow-inner">
                            <MusicalNoteIcon className="w-6 h-6 text-cyan-500" />
                        </div>
                        <button 
                            onClick={(e) => handleDeleteProject(e, project.id)}
                            className="p-2 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                            title="删除项目"
                        >
                            <TrashIcon className="w-5 h-5" />
                        </button>
                    </div>
                    
                    <h3 className="text-xl font-bold text-zinc-100 mb-2 truncate group-hover:text-cyan-200 transition-colors relative z-10">{project.name}</h3>
                    <div className="flex-1 relative z-10">
                        <p className="text-xs text-zinc-500 font-mono bg-zinc-950/50 inline-block px-2 py-1 rounded">
                            ID: {project.id.slice(0, 8)}
                        </p>
                    </div>
                    
                    <div className="mt-auto flex justify-between items-center text-xs text-zinc-500 border-t border-zinc-800 pt-4 relative z-10">
                        <span>{new Date(project.lastModified).toLocaleDateString()}</span>
                        <div className="flex items-center gap-1 bg-zinc-800 px-2 py-1 rounded-full text-zinc-400">
                             <div className="w-2 h-2 rounded-full bg-cyan-500/50" />
                             {project.messages.length} 
                        </div>
                    </div>
                </div>
            ))}
        </div>
        
        {projectList.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-zinc-600">
                <CubeIcon className="w-16 h-16 mb-4 opacity-20" />
                <p>暂无项目。创建一个新项目开始您的音频之旅。</p>
            </div>
        )}
      </div>
    </div>
  );

  const renderSidebar = () => (
    <div className={`
        flex flex-col border-r border-zinc-800 bg-zinc-950 transition-all duration-300 ease-in-out relative z-20 shrink-0
        ${isSidebarOpen ? 'w-72 opacity-100 translate-x-0' : 'w-0 opacity-0 -translate-x-10 overflow-hidden'}
    `}>
        {/* Header */}
        <div className="h-14 flex items-center justify-between px-4 border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md">
            <span className="text-zinc-100 font-bold tracking-tight text-lg">SPG Studio</span>
            <button onClick={onBack} title="返回浏览" className="text-zinc-500 hover:text-white">
                <ArrowLeftIcon className="w-4 h-4" />
            </button>
        </div>

        {/* Navigation */}
        <div className="p-3 space-y-1">
             <button 
                onClick={() => setView('dashboard')}
                className={`flex items-center gap-3 w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200
                    ${view === 'dashboard' 
                        ? 'bg-gradient-to-r from-zinc-800 to-zinc-800/50 text-white shadow-lg shadow-black/20' 
                        : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900'}
                `}
             >
                <HomeIcon className="w-5 h-5" /> 概览
             </button>
             <button 
                onClick={() => setView('lab')}
                className={`flex items-center gap-3 w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200
                    ${view === 'lab' 
                        ? 'bg-gradient-to-r from-cyan-900/30 to-blue-900/30 text-cyan-300 border border-cyan-900/50' 
                        : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900'}
                `}
             >
                <BeakerIcon className="w-5 h-5" /> 音频实验室
             </button>
        </div>

        {/* Project List Header */}
        <div className="px-4 py-2 flex items-center justify-between mt-4">
            <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider">最近项目</h3>
            <button onClick={handleCreateProject} className="text-cyan-500 hover:text-cyan-300 p-1 rounded hover:bg-cyan-950 transition-colors">
                <PlusIcon className="w-4 h-4" />
            </button>
        </div>

        {/* Scrollable List */}
        <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-0.5 custom-scrollbar">
            {projectList.map((p: { id: string; name: string }) => (
                <div 
                    key={p.id}
                    className={`
                        group flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 relative
                        ${activeProjectId === p.id && view === 'workspace'
                            ? 'bg-zinc-800 text-cyan-400 font-medium' 
                            : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}
                    `}
                    onClick={() => handleOpenProject(p.id)}
                >
                    {activeProjectId === p.id && view === 'workspace' && (
                        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-cyan-500 rounded-r-full" />
                    )}
                    
                    <div className="flex items-center gap-3 truncate flex-1 pl-2">
                        <span className="truncate text-sm">{p.name}</span>
                    </div>

                    <button 
                        onClick={(e) => handleDeleteProject(e, p.id)}
                        className={`
                            p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-900/20 transition-all
                            ${activeProjectId === p.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
                        `}
                        title="删除"
                    >
                        <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                </div>
            ))}
        </div>
        
        {/* User / Footer */}
        <div className="p-4 border-t border-zinc-800 text-xs text-zinc-600 text-center">
             Sound Particle Gen v1.0
        </div>
    </div>
  );

  const renderWorkspace = () => {
    if (!activeProject) return null;

    return (
      <div className="flex-1 flex flex-col min-w-0 bg-slate-950 h-full">
             {/* Workspace Header */}
            <header className="h-14 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-xl flex items-center px-4 justify-between shrink-0 z-10">
                <div className="flex items-center gap-3">
                    <button 
                        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                        className={`text-zinc-400 hover:text-white p-2 rounded-lg hover:bg-zinc-800 transition-colors ${!isSidebarOpen ? 'bg-zinc-800' : ''}`}
                    >
                        <Bars3Icon className="w-5 h-5" />
                    </button>
                    <div className="h-6 w-px bg-zinc-800 mx-2"></div>
                    <div className="group relative flex items-center gap-2">
                        <input 
                            className="bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-cyan-500 focus:outline-none text-sm font-bold text-zinc-100 w-48 transition-all px-1"
                            value={activeProject.name}
                            onChange={(e) => audioActions.updateActiveProject({ name: e.target.value })}
                        />
                        <PencilSquareIcon className="w-3.5 h-3.5 text-zinc-600 group-hover:text-zinc-400" />
                    </div>
                </div>

                <div className="flex items-center gap-6">
                    {/* Status Indicators */}
                    {parserError ? (
                        <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-red-950/30 border border-red-900/50">
                            <span className="text-xs text-red-400 flex items-center gap-1.5 font-mono font-medium" title={parserError.message}>
                                <span className="relative flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                                </span>
                                Error at line {parserError.line}
                            </span>
                            {autoFixCount > 0 && (
                                <span className="text-[10px] text-amber-400 font-mono" title="自动修复尝试次数">
                                    修复 {autoFixCount}/{MAX_AUTO_FIX}
                                </span>
                            )}
                            <div className="h-4 w-px bg-red-900/50"></div>
                            <button 
                                onClick={handleManualFix}
                                className="text-xs text-red-300 hover:text-white flex items-center gap-1 transition-colors uppercase tracking-wide font-bold"
                            >
                                <SparklesIcon className="w-3 h-3" /> Auto Fix
                            </button>
                        </div>
                    ) : (
                        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all duration-300 ${
                            appState === AppState.PLAYING 
                            ? 'bg-green-950/30 border-green-900/50' 
                            : 'bg-zinc-900 border-zinc-800'
                        }`}>
                            <span className="relative flex h-2 w-2">
                              {appState === AppState.PLAYING && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>}
                              <span className={`relative inline-flex rounded-full h-2 w-2 ${appState === AppState.PLAYING ? 'bg-green-500' : 'bg-zinc-600'}`}></span>
                            </span>
                            <span className={`text-xs font-mono font-medium ${appState === AppState.PLAYING ? 'text-green-400' : 'text-zinc-500'}`}>
                                 {appState === AppState.PLAYING ? 'SYNTHESIZING' : 'READY'}
                            </span>
                        </div>
                    )}

                    {/* 编译提示：代码能跑，但有些东西大概率不是作者本意 */}
                    {compileWarnings.length > 0 && (
                        <div
                            className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-950/30 border border-amber-900/50 cursor-help"
                            title={compileWarnings.map((w) => `第 ${w.line} 行: ${w.message}`).join('\n')}
                        >
                            <ExclamationTriangleIcon className="w-3.5 h-3.5 text-amber-400" />
                            <span className="text-xs text-amber-300 font-medium">
                                {compileWarnings.length} 条提示
                            </span>
                        </div>
                    )}

                    {/* Toolbar Actions */}
                    <div className="flex items-center bg-zinc-900 p-1 rounded-xl border border-zinc-800 shadow-sm">
                        {appState === AppState.PLAYING ? (
                            <button 
                                onClick={audioActions.stop}
                                className="p-2 text-red-400 hover:text-red-300 hover:bg-zinc-800 rounded-lg transition-colors flex items-center gap-2 px-3"
                                title="停止"
                            >
                                <StopIcon className="w-4 h-4" /> <span className="text-xs font-bold">STOP</span>
                            </button>
                        ) : (
                            <button 
                                onClick={() => handleCompileAndPlay(activeProject.code)}
                                disabled={appState === AppState.EXPORTING_AUDIO}
                                className="p-2 text-green-400 hover:text-green-300 hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2 px-3"
                                title="运行"
                            >
                                <PlayIcon className="w-4 h-4" /> <span className="text-xs font-bold">RUN</span>
                            </button>
                        )}
                        <div className="w-px h-5 bg-zinc-700 mx-1"></div>
                        <button 
                            onClick={handleExportBundle}
                            disabled={appState === AppState.EXPORTING_AUDIO}
                            className="p-2 text-cyan-400 hover:text-cyan-300 hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-50"
                            title="导出"
                        >
                            {appState === AppState.EXPORTING_AUDIO ? (
                                <div className="w-4 h-4 border-2 border-white/30 border-t-cyan-400 rounded-full animate-spin" />
                            ) : (
                                <ArchiveBoxArrowDownIcon className="w-4 h-4" />
                            )}
                        </button>
                    </div>
                </div>
            </header>

            {/* Split View Content */}
            <div className="flex-1 flex overflow-hidden p-4 gap-4">
                {/* Left: Chat */}
                <div className="w-[380px] shrink-0 flex flex-col rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900/90 shadow-2xl backdrop-blur-sm">
                    <ChatInterface 
                        key={activeProject.id} 
                        ref={chatInterfaceRef}
                        chat={{
                            isProcessing: audioState.isChatProcessing,
                            sendMessage: audioActions.sendMessage,
                            triggerFix: audioActions.triggerFix,
                        }}
                        initialMessages={activeProject.messages}
                        onMessagesUpdate={handleMessagesUpdate}
                        onCodeGenerated={handleCodeUpdate} 
                    />
                </div>

                {/* Right: Visualizer & Code */}
                <div className="flex-1 flex flex-col gap-4 min-w-0">
                    {/* Visualizer (Fixed Height) */}
                    <div className="h-48 shrink-0 rounded-xl overflow-hidden border border-zinc-800 shadow-lg relative group">
                         <div className="absolute top-2 left-3 z-10 text-[10px] font-mono text-cyan-500 opacity-50 uppercase tracking-widest">Oscilloscope View</div>
                         <Visualizer analyser={analyser} isActive={appState === AppState.PLAYING} />
                    </div>
                    
                    {/* Editor (Flex fill) */}
                    <div className="flex-1 min-h-0 rounded-xl overflow-hidden border border-zinc-800 shadow-lg bg-zinc-950 flex flex-col">
                         <div className="h-8 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between px-3">
                             <span className="text-xs text-zinc-500 font-mono">script.spg</span>
                             <div className="flex gap-1.5">
                                 <div className="w-2.5 h-2.5 rounded-full bg-zinc-800 border border-zinc-700"></div>
                                 <div className="w-2.5 h-2.5 rounded-full bg-zinc-800 border border-zinc-700"></div>
                             </div>
                         </div>
                        <CodeEditor 
                            code={activeProject.code} 
                            onChange={(code) => audioActions.updateActiveProject({ code })} 
                            error={parserError} 
                        />
                    </div>
                </div>
            </div>
      </div>
    );
  };

  const renderLab = () => (
      <div className="flex-1 flex flex-col min-w-0 bg-slate-950 h-full">
           <header className="h-14 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md flex items-center px-4 gap-3 shrink-0">
                <button 
                    onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                    className="text-zinc-400 hover:text-white p-2 rounded-lg hover:bg-zinc-800 transition-colors"
                >
                    <Bars3Icon className="w-5 h-5" />
                </button>
                <div className="h-6 w-px bg-zinc-800"></div>
                <BeakerIcon className="w-5 h-5 text-cyan-500" />
                <span className="text-sm font-bold text-zinc-100 tracking-wide">Audio Laboratory</span>
           </header>
           <div className="flex-1 overflow-hidden">
                <AudioToolbox tools={{
                    converter: {
                        state: { isProcessing: audioState.converterProcessing, logs: audioState.converterLogs },
                        convert: audioActions.convert,
                    },
                    analyzer: {
                        result: audioState.analyzerResult,
                        analyze: audioActions.analyze,
                    },
                    fixer: {
                        state: { file: audioState.fixerFile, gain: audioState.fixerGain, isProcessing: audioState.fixerProcessing },
                        setFile: audioActions.setFixerFile,
                        setGain: audioActions.setFixerGain,
                        applyFix: audioActions.applyFix,
                    },
                }} />
           </div>
      </div>
  );

  return (
    <div className="h-full w-full bg-black text-zinc-100 flex flex-col font-sans selection:bg-cyan-500/30 overflow-hidden">
      {/* Hidden File Input */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileImport} 
        accept=".spg,.txt" 
        className="hidden" 
      />

      {/* Main Container */}
      {view === 'dashboard' ? renderDashboard() : (
          <div className="flex-1 flex overflow-hidden h-full">
               {renderSidebar()}
               {view === 'workspace' ? renderWorkspace() : renderLab()}
          </div>
      )}
      
    </div>
  );
};
