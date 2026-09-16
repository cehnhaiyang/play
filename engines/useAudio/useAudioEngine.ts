
import { useState, useRef, useEffect, useCallback } from 'react';
import { BrowserAudioEngine } from '../../services/AudioService/audioEngine';
import { AppState, ParserError } from '../../meta';
import { exportProjectBundle } from '../../services/AudioService/utils';

export const useAudioEngine = () => {
    // 引擎实例
    const [audioEngine] = useState(() => new BrowserAudioEngine());
    const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

    // 运行状态
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

    const compileAndPlay = useCallback(async (sourceCode: string, currentTryCount: number = 0) => {
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
            } else {
                setAutoFixCount(0);
                await audioEngine.playRealtime();
                setAppState(AppState.PLAYING);
                return { success: true };
            }
        } catch (e) {
            console.error(e);
            setAppState(AppState.ERROR);
            return { success: false, error: { message: "Unknown runtime error", line: 0 } };
        }
    }, [audioEngine]);

    const exportBundle = useCallback(async (name: string, code: string) => {
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

            // compile 会停掉实时引擎，导出后统一回到 READY；
            // 旧逻辑按导出前状态恢复 PLAYING 会造成“显示播放中但实际无声”的脱节
            setAppState(AppState.READY);
        } catch (e) {
            console.error("Export bundle failed", e);
            setAppState(AppState.ERROR);
        }
    }, [audioEngine]);

    return {
        analyser,
        state: {
            appState,
            parserError,
            autoFixCount
        },
        actions: {
            setAppState,
            setParserError,
            setAutoFixCount,
            compileAndPlay,
            stop,
            reset,
            exportBundle
        }
    };
};
