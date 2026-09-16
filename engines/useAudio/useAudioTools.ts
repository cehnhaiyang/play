
import { useState, useCallback } from 'react';
import { bufferToWave } from '../../services/AudioService/utils';

/**
 * Convert AudioFile (WAV) to ASF text format Blob
 * Simulated as 16-bit depth for compatibility
 */
export const convertWavToAsf = async (file: File): Promise<Blob> => {
    const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new AudioContext();
    try {
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        
        // Header Info
        const sampleRate = audioBuffer.sampleRate;
        const channels = audioBuffer.numberOfChannels;
        const bitDepth = 2; // 16-bit (2 bytes)
        
        // Use an array to collect lines to avoid O(N^2) string concatenation issues
        const lines: string[] = [`${sampleRate} ${bitDepth} ${channels}`];
        
        const len = audioBuffer.length;
        const channelData: Float32Array[] = [];
        for(let i = 0; i < channels; i++) {
            channelData.push(audioBuffer.getChannelData(i));
        }
        
        // Interleave and quantize
        for (let i = 0; i < len; i++) {
            for (let ch = 0; ch < channels; ch++) {
                let sample = channelData[ch][i];
                // Clamp
                sample = Math.max(-1, Math.min(1, sample));
                // Float to Int16
                const intVal = sample < 0 ? sample * 32768 : sample * 32767;
                lines.push(Math.round(intVal).toString());
            }
        }
        
        return new Blob([lines.join('\n')], { type: 'text/plain' });
    } finally {
        audioCtx.close();
    }
};

/**
 * Convert ASF text file to WAV Blob
 */
export const convertAsfToWav = async (file: File): Promise<Blob> => {
    const text = await file.text();
    const lines = text.trim().split('\n');
    
    if (lines.length < 2) throw new Error("Invalid ASF file structure");
    
    // Parse Header
    const header = lines[0].trim().split(/\s+/);
    if (header.length < 3) throw new Error("Invalid ASF Header");

    const sampleRate = parseInt(header[0]);
    // const sampWidth = parseInt(header[1]); // Ignored, we output standard WAV
    const channels = parseInt(header[2]);
    
    // Parse Samples (skip header)
    const samples: number[] = [];
    for(let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line) {
            const val = parseInt(line);
            if (!isNaN(val)) samples.push(val);
        }
    }
    
    const frameCount = Math.floor(samples.length / channels);
    
    // Create AudioBuffer using OfflineContext
    const offlineCtx = new OfflineAudioContext(channels, frameCount, sampleRate);
    const audioBuffer = offlineCtx.createBuffer(channels, frameCount, sampleRate);
    
    // De-interleave
    for (let ch = 0; ch < channels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < frameCount; i++) {
            const sampleVal = samples[i * channels + ch];
            // Normalize Int16 to Float32
            channelData[i] = sampleVal / 32768.0; 
        }
    }
    
    return bufferToWave(audioBuffer, frameCount);
};

// ==============================
// Audio Analysis
// ==============================

export interface AudioAnalysisResult {
    duration: number;
    channels: number;
    sampleRate: number;
    maxDBFS: number;
    rms: number;
    peak: number;
    crestFactor: number;
    zeroCrossRate: number;
    buffer: AudioBuffer;
}

export const analyzeAudioFile = async (file: File): Promise<AudioAnalysisResult> => {
    const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new AudioContext();
    try {
        const buffer = await audioCtx.decodeAudioData(arrayBuffer);
        
        const channels = buffer.numberOfChannels;
        const len = buffer.length;
        
        // Calculate mixed mono signal for statistical analysis to match simplified Python logic
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
        let nonZeroCount = 0;
        let zeroCrossings = 0;
        
        for (let i = 0; i < len; i++) {
            const val = monoData[i];
            const abs = Math.abs(val);
            
            if (abs > peak) peak = abs;
            sumSquare += val * val;
            if (abs > 0) nonZeroCount++;
            
            // Zero Crossing
            if (i > 0 && ((monoData[i-1] > 0 && val <= 0) || (monoData[i-1] < 0 && val >= 0))) {
                zeroCrossings++;
            }
        }
        
        const rms = Math.sqrt(sumSquare / len);
        const maxDBFS = 20 * Math.log10(peak || 1e-10); 
        const crestFactor = rms > 0 ? peak / rms : 0;
        
        return {
            duration: buffer.duration,
            channels: buffer.numberOfChannels,
            sampleRate: buffer.sampleRate,
            maxDBFS,
            rms,
            peak,
            crestFactor,
            zeroCrossRate: zeroCrossings / len,
            buffer
        };
    } finally {
        audioCtx.close();
    }
};

// ==============================
// Audio Repair (Gain)
// ==============================

export const fixAudioGain = async (file: File, targetGainDb: number): Promise<Blob> => {
    const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new AudioContext();
    try {
        const buffer = await audioCtx.decodeAudioData(arrayBuffer);
        
        const gainFactor = Math.pow(10, targetGainDb / 20);
        
        // Apply gain directly to buffer data
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
                data[i] *= gainFactor;
            }
        }
        
        return bufferToWave(buffer, buffer.length);
    } finally {
        audioCtx.close();
    }
};

// ==============================
// Hook
// ==============================

export const useAudioTools = () => {
    // --- Converter State ---
    const [converterState, setConverterState] = useState({
        isProcessing: false,
        logs: [] as string[]
    });

    const addLog = useCallback((msg: string) => {
        setConverterState(prev => ({ ...prev, logs: [...prev.logs, msg] }));
    }, []);

    const handleBatchConvert = useCallback(async (files: FileList | null, target: 'wav2asf' | 'asf2wav') => {
        if (!files || files.length === 0) return;
        
        setConverterState({ isProcessing: true, logs: [] });

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

                // Trigger Download
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = newName;
                a.click();
                URL.revokeObjectURL(url);
                
                addLog(`${logPrefix}: 成功 -> ${newName}`);
            } catch (e: any) {
                addLog(`${logPrefix}: 失败 - ${e.message}`);
            }
        }
        setConverterState(prev => ({ ...prev, isProcessing: false }));
    }, [addLog]);

    // --- Analyzer State ---
    const [analyzerResult, setAnalyzerResult] = useState<AudioAnalysisResult | null>(null);

    const handleAnalyze = useCallback(async (file: File) => {
        if (file) {
            const res = await analyzeAudioFile(file);
            setAnalyzerResult(res);
        }
    }, []);

    // --- Fixer State ---
    const [fixerState, setFixerState] = useState({
        file: null as File | null,
        gain: 0,
        isProcessing: false
    });

    const setFixerFile = useCallback((file: File | null) => {
        setFixerState(prev => ({ ...prev, file }));
    }, []);

    const setFixerGain = useCallback((gain: number) => {
        setFixerState(prev => ({ ...prev, gain }));
    }, []);

    const handleFix = useCallback(async () => {
        const { file, gain } = fixerState;
        if (!file) return;
        
        setFixerState(prev => ({ ...prev, isProcessing: true }));
        try {
            const blob = await fixAudioGain(file, gain);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `fixed_${file.name.replace(/\.[^/.]+$/, "")}.wav`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            alert("处理失败: " + e);
        } finally {
            setFixerState(prev => ({ ...prev, isProcessing: false }));
        }
    }, [fixerState]);

    return {
        converter: {
            state: converterState,
            convert: handleBatchConvert
        },
        analyzer: {
            result: analyzerResult,
            analyze: handleAnalyze
        },
        fixer: {
            state: fixerState,
            setFile: setFixerFile,
            setGain: setFixerGain,
            apply: handleFix
        }
    };
};
