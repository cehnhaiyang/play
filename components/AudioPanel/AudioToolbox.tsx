
import React, { useState, useRef, useEffect } from 'react';
import { 
    ArrowPathRoundedSquareIcon, 
    ChartBarIcon, 
    WrenchScrewdriverIcon, 
    ArrowUpTrayIcon, 
    ArrowDownTrayIcon 
} from '@heroicons/react/24/outline';
import { useAudio } from '../../hooks';

type ToolMode = 'converter' | 'analyzer' | 'fixer';

interface AudioToolboxProps {
    tools: {
        converter: {
            state: { isProcessing: boolean; logs: string[] };
            convert: (files: FileList | null, target: 'wav2asf' | 'asf2wav') => Promise<void>;
        };
        analyzer: {
            result: ReturnType<typeof useAudio>['state']['analyzerResult'];
            analyze: (file: File) => Promise<void>;
        };
        fixer: {
            state: { file: File | null; gain: number; isProcessing: boolean };
            setFile: (file: File | null) => void;
            setGain: (gain: number) => void;
            applyFix: () => Promise<void>;
        };
    };
}

const AudioToolbox: React.FC<AudioToolboxProps> = ({ tools }) => {
    const [mode, setMode] = useState<ToolMode>('analyzer');

    const tabs: {id: ToolMode, label: string, icon: React.ElementType}[] = [
        { id: 'analyzer', label: '音频透视', icon: ChartBarIcon },
        { id: 'converter', label: '格式转换', icon: ArrowPathRoundedSquareIcon },
        { id: 'fixer', label: '增益修复', icon: WrenchScrewdriverIcon },
    ];

    return (
        <div className="flex flex-col h-full bg-dots-pattern text-zinc-200">
            {/* Header / Tabs */}
            <div className="flex border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md px-6 pt-2 gap-2">
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setMode(tab.id)}
                        className={`
                            flex items-center gap-2 py-3 px-4 text-sm font-medium border-b-2 transition-all duration-200 rounded-t-lg
                            ${mode === tab.id 
                                ? 'border-cyan-500 text-cyan-400 bg-zinc-800/50' 
                                : 'border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/30'}
                        `}
                    >
                        <tab.icon className="w-4 h-4" />
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-8 max-w-6xl mx-auto w-full">
                <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
                    {mode === 'converter' && <ConverterView converter={tools.converter} />}
                    {mode === 'analyzer' && <AnalyzerView analyzer={tools.analyzer} />}
                    {mode === 'fixer' && <FixerView fixer={tools.fixer} />}
                </div>
            </div>
        </div>
    );
};

// --- Sub Components ---

const ConverterView: React.FC<{ converter: any }> = ({ converter }) => {
    const { state, convert } = converter;
    const { isProcessing, logs } = state;

    return (
        <div className="space-y-8 animate-fade-in">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* WAV to ASF */}
                <div className="bg-zinc-950 p-6 rounded-xl border border-zinc-800 hover:border-cyan-700/50 transition-colors group">
                    <h3 className="text-lg font-semibold text-zinc-100 mb-2 flex items-center gap-2">
                         <span className="bg-cyan-900/30 text-cyan-400 px-2 py-0.5 rounded text-xs">WAV</span>
                         <span>→</span>
                         <span className="bg-purple-900/30 text-purple-400 px-2 py-0.5 rounded text-xs">ASF</span>
                    </h3>
                    <p className="text-sm text-zinc-500 mb-6">将标准 WAV 音频转换为自定义 ASF 文本格式。</p>
                    <label className={`
                        flex items-center justify-center gap-2 w-full py-4 rounded-xl border border-dashed border-zinc-700 
                        cursor-pointer hover:bg-zinc-900 hover:border-cyan-500/50 transition-all group-hover:shadow-lg
                        ${isProcessing ? 'opacity-50 pointer-events-none' : ''}
                    `}>
                        <ArrowUpTrayIcon className="w-5 h-5 text-cyan-500" />
                        <span className="text-sm font-medium text-zinc-300">选择 WAV 文件 (支持批量)</span>
                        <input 
                            type="file" 
                            multiple 
                            accept=".wav" 
                            className="hidden" 
                            onChange={(e) => convert(e.target.files, 'wav2asf')}
                        />
                    </label>
                </div>

                {/* ASF to WAV */}
                <div className="bg-zinc-950 p-6 rounded-xl border border-zinc-800 hover:border-purple-700/50 transition-colors group">
                     <h3 className="text-lg font-semibold text-zinc-100 mb-2 flex items-center gap-2">
                         <span className="bg-purple-900/30 text-purple-400 px-2 py-0.5 rounded text-xs">ASF</span>
                         <span>→</span>
                         <span className="bg-cyan-900/30 text-cyan-400 px-2 py-0.5 rounded text-xs">WAV</span>
                    </h3>
                    <p className="text-sm text-zinc-500 mb-6">将自定义 ASF 文本格式还原为 WAV 音频。</p>
                    <label className={`
                        flex items-center justify-center gap-2 w-full py-4 rounded-xl border border-dashed border-zinc-700 
                        cursor-pointer hover:bg-zinc-900 hover:border-purple-500/50 transition-all group-hover:shadow-lg
                        ${isProcessing ? 'opacity-50 pointer-events-none' : ''}
                    `}>
                        <ArrowDownTrayIcon className="w-5 h-5 text-purple-500" />
                        <span className="text-sm font-medium text-zinc-300">选择 ASF 文件 (支持批量)</span>
                        <input 
                            type="file" 
                            multiple 
                            accept=".asf,.txt" 
                            className="hidden" 
                            onChange={(e) => convert(e.target.files, 'asf2wav')}
                        />
                    </label>
                </div>
            </div>

            {/* Console Output */}
            <div className="bg-black rounded-xl p-4 font-mono text-xs text-zinc-400 min-h-[150px] max-h-[300px] overflow-y-auto border border-zinc-800 shadow-inner">
                <div className="text-zinc-600 mb-2 border-b border-zinc-900 pb-2 uppercase tracking-wider font-bold">Process Log</div>
                {logs.length === 0 && <div className="italic opacity-30 text-center py-8">等待任务开始...</div>}
                {logs.map((log: string, i: number) => (
                    <div key={i} className="mb-1 border-l-2 border-zinc-800 pl-2 hover:bg-zinc-900/30">{log}</div>
                ))}
            </div>
        </div>
    );
};

const AnalyzerView: React.FC<{ analyzer: any }> = ({ analyzer }) => {
    const { result, analyze } = analyzer;
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            analyze(e.target.files[0]);
        }
    };

    // Draw static waveform
    useEffect(() => {
        if (result && canvasRef.current) {
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            
            const dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            ctx.scale(dpr, dpr);
            
            const width = rect.width;
            const height = rect.height;
            const data = result.buffer.getChannelData(0);
            const step = Math.ceil(data.length / width);
            const amp = height / 2;
            
            ctx.clearRect(0, 0, width, height);
            ctx.fillStyle = '#18181b'; // zinc-900
            ctx.fillRect(0, 0, width, height);
            
            // Grid lines
            ctx.strokeStyle = '#27272a';
            ctx.beginPath();
            ctx.moveTo(0, height/2);
            ctx.lineTo(width, height/2);
            ctx.stroke();

            // Waveform
            ctx.beginPath();
            ctx.strokeStyle = '#22d3ee'; // cyan-400
            ctx.lineWidth = 1;

            for (let i = 0; i < width; i++) {
                let min = 1.0;
                let max = -1.0;
                for (let j = 0; j < step; j++) {
                    const idx = (i * step) + j;
                    if (idx < data.length) {
                        const datum = data[idx];
                        if (datum < min) min = datum;
                        if (datum > max) max = datum;
                    }
                }
                const yMin = (1 - max) * amp;
                const yMax = (1 - min) * amp;
                ctx.moveTo(i, yMin);
                ctx.lineTo(i, yMax);
            }
            ctx.stroke();
        }
    }, [result]);

    return (
        <div className="space-y-6 animate-fade-in">
             <div className="flex items-center justify-between bg-zinc-950 p-6 rounded-xl border border-zinc-800">
                <div>
                    <h3 className="text-xl font-bold text-zinc-100">音频分析器</h3>
                    <p className="text-zinc-500 text-sm mt-1">深度解析音频文件的声学特征。</p>
                </div>
                <label className="bg-zinc-100 hover:bg-white text-zinc-900 px-5 py-2.5 rounded-xl cursor-pointer transition-all shadow-lg hover:shadow-xl text-sm font-bold flex items-center gap-2">
                    <ArrowUpTrayIcon className="w-4 h-4" /> 上传文件
                    <input type="file" onChange={handleFile} accept="audio/*" className="hidden" />
                </label>
             </div>

             {result ? (
                 <div className="space-y-6">
                    {/* Stats Grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <StatCard label="时长 (Duration)" value={`${result.duration.toFixed(2)}s`} highlight />
                        <StatCard label="峰值 (Peak)" value={result.peak.toFixed(4)} />
                        <StatCard label="最大响度 (Max dBFS)" value={`${result.maxDBFS.toFixed(2)} dB`} />
                        <StatCard label="RMS Power" value={result.rms.toFixed(4)} />
                        <StatCard label="采样率 (Sample Rate)" value={`${result.sampleRate} Hz`} />
                        <StatCard label="通道数 (Channels)" value={result.channels} />
                        <StatCard label="波峰因数 (Crest)" value={result.crestFactor.toFixed(2)} />
                        <StatCard label="过零率 (Zero Cross)" value={`${(result.zeroCrossRate * 100).toFixed(2)}%`} />
                    </div>

                    {/* Waveform */}
                    <div className="bg-zinc-950 rounded-xl border border-zinc-800 p-2 overflow-hidden h-64 relative shadow-inner group">
                        <canvas ref={canvasRef} className="w-full h-full rounded-lg" />
                        <div className="absolute top-4 left-4 text-[10px] bg-zinc-900/90 px-2 py-1 rounded text-cyan-400 font-mono border border-zinc-800 uppercase tracking-widest">
                            Waveform Visualizer
                        </div>
                    </div>
                 </div>
             ) : (
                 <div className="h-64 border-2 border-dashed border-zinc-800 bg-zinc-900/30 rounded-xl flex flex-col items-center justify-center text-zinc-600 gap-4">
                     <ChartBarIcon className="w-12 h-12 opacity-20" />
                     <span>暂无数据，请上传音频文件</span>
                 </div>
             )}
        </div>
    );
};

const StatCard: React.FC<{label: string, value: string | number, highlight?: boolean}> = ({ label, value, highlight }) => (
    <div className={`
        p-4 rounded-xl border transition-all hover:-translate-y-1
        ${highlight ? 'bg-zinc-800 border-zinc-700' : 'bg-zinc-950 border-zinc-800'}
    `}>
        <div className="text-[10px] text-zinc-500 mb-1 uppercase tracking-wider font-bold">{label}</div>
        <div className={`text-lg font-mono font-medium ${highlight ? 'text-cyan-400' : 'text-zinc-200'}`}>{value}</div>
    </div>
);

const FixerView: React.FC<{ fixer: any }> = ({ fixer }) => {
    const { state, setFile, setGain, apply } = fixer;
    const { file, gain, isProcessing } = state;

    return (
        <div className="max-w-2xl mx-auto space-y-8 animate-fade-in py-8">
             <div className="text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-cyan-900/20 mb-4">
                    <WrenchScrewdriverIcon className="w-6 h-6 text-cyan-500" />
                </div>
                <h3 className="text-xl font-bold text-zinc-100">音频增益修复</h3>
                <p className="text-zinc-500 text-sm mt-2 max-w-md mx-auto">
                    当音频文件音量过低或过高时，使用此工具进行无损数字增益补偿。
                </p>
             </div>

             <div className="bg-zinc-950 p-8 rounded-2xl border border-zinc-800 space-y-8 shadow-xl">
                {/* File Input */}
                <div>
                    <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3">输入文件</label>
                    <input 
                        type="file" 
                        accept="audio/*"
                        onChange={(e) => setFile(e.target.files?.[0] || null)}
                        className="block w-full text-sm text-zinc-400
                            file:mr-4 file:py-2.5 file:px-6
                            file:rounded-xl file:border-0
                            file:text-sm file:font-bold
                            file:bg-zinc-800 file:text-cyan-400
                            hover:file:bg-zinc-700
                            cursor-pointer border border-zinc-800 rounded-xl p-1"
                    />
                </div>

                {/* Gain Slider */}
                <div>
                    <div className="flex justify-between text-sm mb-4 items-center">
                         <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">增益量 (dB)</span>
                         <span className="bg-zinc-900 text-cyan-400 font-mono px-3 py-1 rounded border border-zinc-800 text-xs">
                             {gain > 0 ? '+' : ''}{gain} dB
                         </span>
                    </div>
                    <input 
                        type="range" 
                        min="-60" 
                        max="60" 
                        step="1"
                        value={gain} 
                        onChange={(e) => setGain(parseInt(e.target.value))}
                        className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-cyan-500 hover:accent-cyan-400"
                    />
                    <div className="flex justify-between text-[10px] text-zinc-600 mt-2 font-mono">
                        <span>-60dB</span>
                        <span>0dB</span>
                        <span>+60dB</span>
                    </div>
                </div>

                {/* Action */}
                <button
                    onClick={apply}
                    disabled={!file || isProcessing}
                    className={`
                        w-full py-4 rounded-xl font-bold transition-all shadow-lg transform active:scale-95
                        ${!file || isProcessing 
                            ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed' 
                            : 'bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white shadow-cyan-900/40'}
                    `}
                >
                    {isProcessing ? '正在处理...' : '应用增益并导出'}
                </button>
             </div>
        </div>
    );
};

export default AudioToolbox;
