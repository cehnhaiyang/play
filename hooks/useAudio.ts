/// <reference lib="dom" />
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type React from 'react';
import { Project, Message, AppState, ParserError } from '../meta';
import { loadProjects, saveProjects, createNewProject } from '../services/AudioService/persistence';
import { BrowserAudioEngine } from '../services/AudioService/audioEngine';
import { exportProjectBundle, bufferToWave } from '../services/AudioService/utils';
import { generateSyntax, fixSyntax } from '../services/gemini';
import { loadJSON, saveJSON, removeStored } from '../utils/persist';

interface UseAudioParams {
    initialProjectId?: string | null;
}

interface UseAudioReturn {
    state: {
        // 工程管理
        projects: Project[];
        activeProjectId: string | null;
        activeProject: Project | null;
        // 声音引擎
        analyser: AnalyserNode | null;
        appState: AppState;
        parserError: ParserError | null;
        autoFixCount: number;
        // 工具箱
        converterProcessing: boolean;
        converterLogs: string[];
        analyzerResult: {
            duration: number;
            channels: number;
            sampleRate: number;
            maxDBFS: number;
            rms: number;
            peak: number;
            crestFactor: number;
            zeroCrossRate: number;
            buffer: AudioBuffer;
        } | null;
        fixerFile: File | null;
        fixerGain: number;
        fixerProcessing: boolean;
        // 对话辅助
        isChatProcessing: boolean;
    };
    actions: {
        // 工程操作
        createProject: () => string;
        deleteProject: (id: string) => void;
        updateActiveProject: (updates: Partial<Project>) => void;
        updateProjectMessages: (messages: Message[]) => void;
        importProjectFromFile: (file: File, callback: (newId: string) => void) => void;
        setActiveProjectId: React.Dispatch<React.SetStateAction<string | null>>;
        // 引擎操作
        compileAndPlay: (sourceCode: string, currentTryCount?: number) => Promise<{ success: boolean; error?: ParserError }>;
        stop: () => void;
        reset: () => void;
        exportBundle: (name: string, code: string) => Promise<void>;
        setAppState: React.Dispatch<React.SetStateAction<AppState>>;
        setParserError: React.Dispatch<React.SetStateAction<ParserError | null>>;
        setAutoFixCount: React.Dispatch<React.SetStateAction<number>>;
        // 工具操作
        convert: (files: FileList | null, target: 'wav2asf' | 'asf2wav') => Promise<void>;
        analyze: (file: File) => Promise<void>;
        setFixerFile: (file: File | null) => void;
        setFixerGain: (gain: number) => void;
        applyFix: () => Promise<void>;
        // 对话操作
        sendMessage: (content: string) => Promise<{ success: boolean; code?: string; replyMessage: Message }>;
        triggerFix: (brokenCode: string, error: string) => Promise<{ success: boolean; code?: string; replyMessage: Message }>;
    };
}

const AUDIO_DEFAULTS = {
    ACTIVE_PROJECT_KEY: 'audio-active-project',
};

export const useAudio = ({
    initialProjectId = null,
}: UseAudioParams = {}): UseAudioReturn => {
    // 1. 工程管理状态
    const [projects, setProjects] = useState<Project[]>([]);
    const [activeProjectId, setActiveProjectId] = useState<string | null>(initialProjectId);
    const hasLoadedRef = useRef(false);

    useEffect(() => {
        const savedProjects = loadProjects();
        if (savedProjects.length > 0) {
            setProjects(savedProjects);
            const lastActive = loadJSON<string | null>(AUDIO_DEFAULTS.ACTIVE_PROJECT_KEY, null);
            if (lastActive && savedProjects.some((p) => p.id === lastActive)) {
                setActiveProjectId(lastActive);
            } else if (initialProjectId && savedProjects.some((p) => p.id === initialProjectId)) {
                setActiveProjectId(initialProjectId);
            }
        }
        hasLoadedRef.current = true;
    }, [initialProjectId]);

    useEffect(() => {
        if (!hasLoadedRef.current) return;
        saveProjects(projects);
    }, [projects]);

    useEffect(() => {
        if (!hasLoadedRef.current) return;
        if (activeProjectId) {
            saveJSON(AUDIO_DEFAULTS.ACTIVE_PROJECT_KEY, activeProjectId);
        } else {
            removeStored(AUDIO_DEFAULTS.ACTIVE_PROJECT_KEY);
        }
    }, [activeProjectId]);

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

        setProjects((prev) =>
            prev.map((project) => {
                if (project.id !== activeProjectId) {
                    return project;
                }

                return {
                    ...project,
                    ...updates,
                    lastModified: Date.now(),
                };
            })
        );
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
            const content = (event.target?.result as string) || '';

            const newProject = createNewProject();
            newProject.name = file.name.replace(/\.(spg|txt)$/i, '') || 'Imported Project';
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

    // 2. 声音引擎状态
    const [audioEngine] = useState(() => new BrowserAudioEngine());
    const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
    const [appState, setAppState] = useState<AppState>(AppState.IDLE);
    const [parserError, setParserError] = useState<ParserError | null>(null);
    const [autoFixCount, setAutoFixCount] = useState(0);

    useEffect(() => {
        setAnalyser(audioEngine.getAnalyser());
        return () => audioEngine.stop();
    }, [audioEngine]);

    const stop = useCallback(() => {
        audioEngine.stop();
        setAppState(AppState.READY);
    }, [audioEngine]);

    const reset = useCallback(() => {
        audioEngine.stop();
        setAppState(AppState.IDLE);
        setParserError(null);
        setAutoFixCount(0);
    }, [audioEngine]);

    const compileAndPlay = useCallback(
        async (sourceCode: string, currentTryCount = 0) => {
            setAppState(AppState.SYNTHESIZING_AUDIO);
            setParserError(null);

            if (currentTryCount === 0) setAutoFixCount(0);
            else setAutoFixCount(currentTryCount);

            try {
                const error = audioEngine.compile(sourceCode);
                if (error) {
                    setParserError(error);
                    setAppState(AppState.ERROR);
                    return { success: false, error };
                }
                setAutoFixCount(0);
                await audioEngine.playRealtime();
                setAppState(AppState.PLAYING);
                return { success: true };
            } catch (error: unknown) {
                console.error('音频引擎运行异常:', error);
                setAppState(AppState.ERROR);
                const message = error instanceof Error ? error.message : '未知运行时错误';
                return { success: false, error: { message, line: 0 } };
            }
        },
        [audioEngine]
    );

    const exportBundle = useCallback(
        async (name: string, code: string) => {
            setAppState(AppState.EXPORTING_AUDIO);
            setParserError(null);

            try {
                const error = audioEngine.compile(code);
                if (error) {
                    setParserError(error);
                    setAppState(AppState.ERROR);
                    return;
                }

                const wavBlob = await audioEngine.renderOffline();
                const zipBlob = await exportProjectBundle(code, wavBlob);

                const url = URL.createObjectURL(zipBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${name.replace(/\s+/g, '_')}_${Date.now()}.zip`;
                a.click();
                URL.revokeObjectURL(url);

                setAppState(AppState.READY);
            } catch (error: unknown) {
                console.error('导出音频工程包失败:', error);
                setAppState(AppState.ERROR);
            }
        },
        [audioEngine]
    );

    // 3. 工具箱处理逻辑与状态
    const [converterProcessing, setConverterProcessing] = useState(false);
    const [converterLogs, setConverterLogs] = useState<string[]>([]);

    const addLog = useCallback((msg: string) => {
        setConverterLogs((prev) => [...prev, msg]);
    }, []);

    const convertWavToAsf = useCallback(async (file: File): Promise<Blob> => {
        const arrayBuffer = await file.arrayBuffer();
        const audioCtx = new AudioContext();
        try {
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            const sampleRate = audioBuffer.sampleRate;
            const channels = audioBuffer.numberOfChannels;
            const bitDepth = 2;

            const lines: string[] = [`${sampleRate} ${bitDepth} ${channels}`];
            const len = audioBuffer.length;
            const channelData: Float32Array[] = [];
            for (let i = 0; i < channels; i++) {
                channelData.push(audioBuffer.getChannelData(i));
            }

            for (let i = 0; i < len; i++) {
                for (let ch = 0; ch < channels; ch++) {
                    let sample = channelData[ch][i];
                    sample = Math.max(-1, Math.min(1, sample));
                    const intVal = sample < 0 ? sample * 32768 : sample * 32767;
                    lines.push(Math.round(intVal).toString());
                }
            }

            return new Blob([lines.join('\n')], { type: 'text/plain' });
        } finally {
            audioCtx.close();
        }
    }, []);

    const convertAsfToWav = useCallback(async (file: File): Promise<Blob> => {
        const text = await file.text();
        const lines = text.trim().split('\n');

        if (lines.length < 2) throw new Error('无效的 ASF 文件结构');

        const header = lines[0].trim().split(/\s+/);
        if (header.length < 3) throw new Error('无效的 ASF 头部信息');

        const sampleRate = parseInt(header[0], 10);
        const channels = parseInt(header[2], 10);

        const samples: number[] = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line) {
                const val = parseInt(line, 10);
                if (!Number.isNaN(val)) samples.push(val);
            }
        }

        const frameCount = Math.floor(samples.length / channels);
        const offlineCtx = new OfflineAudioContext(channels, frameCount, sampleRate);
        const audioBuffer = offlineCtx.createBuffer(channels, frameCount, sampleRate);

        for (let ch = 0; ch < channels; ch++) {
            const channelData = audioBuffer.getChannelData(ch);
            for (let i = 0; i < frameCount; i++) {
                const sampleVal = samples[i * channels + ch];
                channelData[i] = sampleVal / 32768.0;
            }
        }

        return bufferToWave(audioBuffer, frameCount);
    }, []);

    const convert = useCallback(
        async (files: FileList | null, target: 'wav2asf' | 'asf2wav') => {
            if (!files || files.length === 0) return;

            setConverterProcessing(true);
            setConverterLogs([]);

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const logPrefix = `[${i + 1}/${files.length}] ${file.name}`;
                try {
                    let blob: Blob;
                    let newName: string;

                    if (target === 'wav2asf') {
                        if (!file.name.toLowerCase().endsWith('.wav')) {
                            addLog(`${logPrefix}: 跳过 (非 .wav)`);
                            continue;
                        }
                        blob = await convertWavToAsf(file);
                        newName = file.name.replace(/\.wav$/i, '.asf');
                    } else {
                        if (!file.name.toLowerCase().endsWith('.asf')) {
                            addLog(`${logPrefix}: 跳过 (非 .asf)`);
                            continue;
                        }
                        blob = await convertAsfToWav(file);
                        newName = file.name.replace(/\.asf$/i, '.wav');
                    }

                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = newName;
                    a.click();
                    URL.revokeObjectURL(url);

                    addLog(`${logPrefix}: 成功 -> ${newName}`);
                } catch (error: unknown) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    addLog(`${logPrefix}: 失败 - ${errMsg}`);
                }
            }
            setConverterProcessing(false);
        },
        [addLog, convertAsfToWav, convertWavToAsf]
    );

    const [analyzerResult, setAnalyzerResult] = useState<UseAudioReturn['state']['analyzerResult']>(null);

    const analyze = useCallback(async (file: File) => {
        if (!file) return;

        const arrayBuffer = await file.arrayBuffer();
        const audioCtx = new AudioContext();
        try {
            const buffer = await audioCtx.decodeAudioData(arrayBuffer);
            const channels = buffer.numberOfChannels;
            const len = buffer.length;

            const monoData = new Float32Array(len);
            for (let i = 0; i < len; i++) {
                let sum = 0;
                for (let c = 0; c < channels; c++) {
                    sum += buffer.getChannelData(c)[i];
                }
                monoData[i] = sum / channels;
            }

            let sumSquare = 0;
            let peak = 0;
            let zeroCrossings = 0;

            for (let i = 0; i < len; i++) {
                const val = monoData[i];
                const abs = Math.abs(val);

                if (abs > peak) peak = abs;
                sumSquare += val * val;

                if (i > 0 && ((monoData[i - 1] > 0 && val <= 0) || (monoData[i - 1] < 0 && val >= 0))) {
                    zeroCrossings++;
                }
            }

            const rms = Math.sqrt(sumSquare / len);
            const maxDBFS = 20 * Math.log10(peak || 1e-10);
            const crestFactor = rms > 0 ? peak / rms : 0;

            setAnalyzerResult({
                duration: buffer.duration,
                channels: buffer.numberOfChannels,
                sampleRate: buffer.sampleRate,
                maxDBFS,
                rms,
                peak,
                crestFactor,
                zeroCrossRate: zeroCrossings / len,
                buffer,
            });
        } finally {
            audioCtx.close();
        }
    }, []);

    const [fixerFile, setFixerFile] = useState<File | null>(null);
    const [fixerGain, setFixerGain] = useState(0);
    const [fixerProcessing, setFixerProcessing] = useState(false);

    const applyFix = useCallback(async () => {
        if (!fixerFile) return;

        setFixerProcessing(true);
        const audioCtx = new AudioContext();
        try {
            const arrayBuffer = await fixerFile.arrayBuffer();
            const buffer = await audioCtx.decodeAudioData(arrayBuffer);
            const gainFactor = Math.pow(10, fixerGain / 20);

            for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
                const data = buffer.getChannelData(ch);
                for (let i = 0; i < data.length; i++) {
                    data[i] *= gainFactor;
                }
            }

            const blob = bufferToWave(buffer, buffer.length);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `fixed_${fixerFile.name.replace(/\.[^/.]+$/, '')}.wav`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (error: unknown) {
            console.error('音频修复处理失败:', error);
        } finally {
            audioCtx.close();
            setFixerProcessing(false);
        }
    }, [fixerFile, fixerGain]);

    // 4. 对话与代码修复状态
    const [isChatProcessing, setIsChatProcessing] = useState(false);

    const sendMessage = useCallback(async (content: string) => {
        setIsChatProcessing(true);
        try {
            const code = await generateSyntax(content);
            const replyMessage: Message = {
                role: 'model',
                content: '已为您生成音频配置代码。正在自动加载到编辑器...',
                timestamp: Date.now(),
            };
            return { success: true, code, replyMessage };
        } catch (error: unknown) {
            let errorMsg = '生成失败，请重试。';
            if (error instanceof Error && error.message.includes('API Key')) {
                errorMsg = '错误：未检测到 API Key。请检查环境变量。';
            }
            const replyMessage: Message = {
                role: 'model',
                content: errorMsg,
                timestamp: Date.now(),
            };
            return { success: false, replyMessage };
        } finally {
            setIsChatProcessing(false);
        }
    }, []);

    const triggerFix = useCallback(async (brokenCode: string, error: string) => {
        setIsChatProcessing(true);
        try {
            const fixedCode = await fixSyntax(brokenCode, error);
            const replyMessage: Message = {
                role: 'model',
                content: '修复完成！正在应用新代码。',
                timestamp: Date.now(),
            };
            return { success: true, code: fixedCode, replyMessage };
        } catch (error: unknown) {
            console.error('语法自动修复失败:', error);
            const replyMessage: Message = {
                role: 'model',
                content: '自动修复失败。请手动检查代码。',
                timestamp: Date.now(),
            };
            return { success: false, replyMessage };
        } finally {
            setIsChatProcessing(false);
        }
    }, []);

    // 5. 组装出参
    const state = useMemo(
        () => ({
            projects,
            activeProjectId,
            activeProject,
            analyser,
            appState,
            parserError,
            autoFixCount,
            converterProcessing,
            converterLogs,
            analyzerResult,
            fixerFile,
            fixerGain,
            fixerProcessing,
            isChatProcessing,
        }),
        [
            projects,
            activeProjectId,
            activeProject,
            analyser,
            appState,
            parserError,
            autoFixCount,
            converterProcessing,
            converterLogs,
            analyzerResult,
            fixerFile,
            fixerGain,
            fixerProcessing,
            isChatProcessing,
        ]
    );

    const actions = useMemo(
        () => ({
            createProject,
            deleteProject,
            updateActiveProject,
            updateProjectMessages,
            importProjectFromFile,
            setActiveProjectId,
            compileAndPlay,
            stop,
            reset,
            exportBundle,
            setAppState,
            setParserError,
            setAutoFixCount,
            convert,
            analyze,
            setFixerFile,
            setFixerGain,
            applyFix,
            sendMessage,
            triggerFix,
        }),
        [
            createProject,
            deleteProject,
            updateActiveProject,
            updateProjectMessages,
            importProjectFromFile,
            setActiveProjectId,
            compileAndPlay,
            stop,
            reset,
            exportBundle,
            convert,
            analyze,
            applyFix,
            sendMessage,
            triggerFix,
        ]
    );

    return {
        state,
        actions,
    };
};
