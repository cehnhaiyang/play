/// <reference lib="dom" />
import React, {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    ArchiveBoxArrowDownIcon,
    ArrowDownIcon,
    ArrowLeftIcon,
    ArrowUpTrayIcon,
    Bars3Icon,
    BeakerIcon,
    CheckIcon,
    ChevronRightIcon,
    ClipboardDocumentIcon,
    CpuChipIcon,
    CubeIcon,
    ExclamationTriangleIcon,
    HomeIcon,
    MusicalNoteIcon,
    PaperAirplaneIcon,
    PencilSquareIcon,
    PlayIcon,
    PlusIcon,
    SparklesIcon,
    StopIcon,
    TrashIcon,
    UserCircleIcon,
    XMarkIcon,
} from '@heroicons/react/24/solid';
import {
    ArrowDownTrayIcon,
    ArrowPathRoundedSquareIcon,
    ArrowUpTrayIcon as ArrowUpTrayOutlineIcon,
    ChartBarIcon,
    WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import { AppState, ChatInterfaceRef, Message, ParserError, Project } from '../meta';
import { useAudio } from '../hooks';

/**
 * 音频工坊（Sound Particle Studio）。
 *
 * 这个文件是**一个整体**：对话生成代码 → 编辑器改代码 → 编译报错 → 回灌对话
 * 自动修复，是一条闭环。闭环上的每一环都要读写同一份「当前工程」，
 * 而工程状态只属于 AudioPanel 里的 useAudio；拆成多个文件后，
 * 子组件只能靠一层层传参或各自再调一次 useAudio 来够到它，
 * 前者接口随需求反复变形，后者每个实例都会新建一个 AudioContext 且从不关闭。
 *
 * 原 AudioPanel/ 目录（index + ChatInterface + CodeEditor + Visualizer +
 * AudioToolbox）全部合并到这里，对话区所需的引擎能力由 AudioPanel 显式注入。
 *
 * 文件内分区：示波器 → 代码编辑器 → 对话区 → 音频实验室 → 面板外壳。
 */

type ViewState = 'dashboard' | 'workspace' | 'lab';

interface AudioPanelProps {
    onBack: () => void;
}

/** 分析器结果只在工具箱内部流转，直接从 hook 出参取形，避免再抄一份字段表 */
type AnalyzerResult = NonNullable<ReturnType<typeof useAudio>['state']['analyzerResult']>;

/* ========================================================================== */
/*                                 视觉令牌                                   */
/* ========================================================================== */

/* 面板此前每一处卡片都自己拼一遍 zinc 组合，结果同时存在 zinc-800/900/950
   三种描边与三种底色，彼此之间并不构成层级。这里收敛成一套：
   层级只靠描边亮度与内间距区分，底色一律是同一层半透明白。 */

/** 浮起的表面。整个面板只有这一种 */
const SURFACE = 'rounded-2xl border border-white/8 bg-white/[0.03] backdrop-blur-sm';
/** 可点击表面的悬停态 */
const SURFACE_HOVER = 'transition-colors hover:border-white/16 hover:bg-white/[0.06]';
/** 键盘焦点环：面板内所有可点元素共用，避免各处 focus 表现不一 */
const FOCUS_RING =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950';
const BTN_BASE =
    'inline-flex items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40';
/** 主操作：新建、运行、导出这类"推进流程"的动作 */
const BTN_PRIMARY = `${BTN_BASE} ${FOCUS_RING} bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-lg shadow-cyan-500/25 hover:from-cyan-400 hover:to-blue-400`;
/** 次要操作：与主操作同排但不抢注意力 */
const BTN_GHOST = `${BTN_BASE} ${FOCUS_RING} border border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/20 hover:bg-white/[0.08] hover:text-white`;
/** 小标签：字段名、单位、分区标题共用 */
const LABEL = 'text-[10px] font-bold uppercase tracking-wider text-zinc-500';

/**
 * 相对时间。项目卡片此前显示 `toLocaleDateString()`，只到"天"，
 * 同一天改过的几个项目看起来完全一样，而"哪个是刚才动过的"恰恰是列表里
 * 最需要一眼看出的信息。
 */
const relativeTime = (ts: number): string => {
    const diff = Date.now() - ts;
    const minute = 60_000;
    if (diff < minute) return '刚刚';
    if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
    const days = Math.floor(diff / (24 * 60 * minute));
    if (days < 30) return `${days} 天前`;
    return new Date(ts).toLocaleDateString();
};

interface CodeSummary {
    lines: number;
    tempo: number | null;
    key: string | null;
    parts: number;
}

/**
 * 从源码里取几个能代表这首曲子的数字，供项目卡片展示。
 * 用正则而不是走一遍解析器：卡片在列表里要渲染几十次，解析器成本高得多，
 * 而这里只做展示，读到什么算什么，读不到就不显示。
 */
const summarizeCode = (code: string): CodeSummary => {
    const tempoMatch = /^\s*(?:tempo|bpm)\s*:\s*(\d+)/m.exec(code);
    const keyMatch = /^\s*key\s*:\s*"([^"]+)"/m.exec(code);
    return {
        lines: code ? code.split('\n').length : 0,
        tempo: tempoMatch ? Number(tempoMatch[1]) : null,
        key: keyMatch ? keyMatch[1] : null,
        parts: (code.match(/^\s*sequence\s*\(/gm) || []).length,
    };
};

/**
 * 项目指纹：由项目 id 派生的一串竖条。
 *
 * 纯装饰 —— 它不读音频，只用 id 的哈希做种子，让每个项目在列表里有一个
 * 稳定且互不相同的图形标识。种子取自 id 而非随机数，所以同一项目每次
 * 渲染、每次重启都长得一样，不会闪。
 */
const ProjectGlyph: React.FC<{ seed: string; bars?: number; className?: string }> = ({
    seed,
    bars = 28,
    className = '',
}) => {
    const heights = useMemo(() => {
        let hash = 2166136261;
        for (let i = 0; i < seed.length; i++) {
            hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
        }
        const out: number[] = [];
        for (let i = 0; i < bars; i++) {
            // xorshift：够用且可复现，不需要真正的随机源
            hash ^= hash << 13;
            hash ^= hash >>> 17;
            hash ^= hash << 5;
            out.push(0.16 + ((hash >>> 0) % 1000) / 1000 * 0.84);
        }
        return out;
    }, [seed, bars]);

    return (
        <div className={`flex items-end gap-[2px] h-8 ${className}`} aria-hidden="true">
            {heights.map((h, i) => (
                <span
                    key={i}
                    className="flex-1 rounded-full bg-gradient-to-t from-cyan-500/25 to-cyan-300/70"
                    style={{ height: `${h * 100}%` }}
                />
            ))}
        </div>
    );
};

/* ========================================================================== */
/*                                 示波器                                     */
/* ========================================================================== */

interface VisualizerProps {
    analyser: AnalyserNode | null;
    isActive: boolean;
}

/** 空闲时画在示波器中央的那条平线，同时也是画布的底色 */
const SCOPE_BG = '#0b0f14';

const Visualizer: React.FC<VisualizerProps> = ({ analyser, isActive }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animationRef = useRef<number>(0);

    useEffect(() => {
        if (!analyser || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // High DPI scaling（窗口/容器尺寸变化时重算，否则拉伸模糊）
        const dpr = window.devicePixelRatio || 1;
        const resizeCanvas = () => {
            const r = canvas.getBoundingClientRect();
            canvas.width = Math.max(1, Math.round(r.width * dpr));
            canvas.height = Math.max(1, Math.round(r.height * dpr));
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        resizeCanvas();
        const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resizeCanvas) : null;
        resizeObserver?.observe(canvas);

        const bufferLength = analyser.frequencyBinCount;
        const dataArrayTime = new Uint8Array(bufferLength);
        const dataArrayFreq = new Uint8Array(bufferLength);

        const draw = () => {
            animationRef.current = requestAnimationFrame(draw);
            const width = canvas.clientWidth || 1;
            const height = canvas.clientHeight || 1;

            // 1. Fade out background (creating trails)
            ctx.fillStyle = isActive ? 'rgba(11, 15, 20, 0.3)' : SCOPE_BG;
            ctx.fillRect(0, 0, width, height);

            if (!isActive) {
                // Draw a flat line when idle
                ctx.beginPath();
                ctx.strokeStyle = '#1e293b';
                ctx.moveTo(0, height / 2);
                ctx.lineTo(width, height / 2);
                ctx.stroke();
                return;
            }

            // Get Data
            analyser.getByteTimeDomainData(dataArrayTime);
            analyser.getByteFrequencyData(dataArrayFreq);

            const centerX = width / 2;
            const centerY = height / 2;

            // 2. Draw Frequency Spectrum (Mirrored Bars from Center)
            const bars = 64;
            const barWidth = (width / bars) / 2;
            const step = Math.floor(bufferLength / bars / 2); // Sampling step

            for (let i = 0; i < bars; i++) {
                const value = dataArrayFreq[i * step];
                const percent = value / 256;
                const barHeight = (height * 0.6) * percent;

                // Color gradient based on height
                const hue = 180 + (percent * 60); // Cyan to Blue/Purple
                ctx.fillStyle = `hsla(${hue}, 100%, 60%, 0.4)`;

                // Right side
                ctx.fillRect(centerX + (i * barWidth), centerY - barHeight / 2, barWidth - 1, barHeight);
                // Left side
                ctx.fillRect(centerX - ((i + 1) * barWidth), centerY - barHeight / 2, barWidth - 1, barHeight);
            }

            // 3. Draw Waveform (Oscilloscope) with Glow
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#00e5ff'; // Cyan
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#00e5ff';

            ctx.beginPath();
            const sliceWidth = width * 1.0 / bufferLength;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const v = dataArrayTime[i] / 128.0;
                const y = v * height / 2;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    // Smooth curve
                    const prevX = x - sliceWidth;
                    const prevY = (dataArrayTime[i - 1] / 128.0) * height / 2;
                    const xc = (prevX + x) / 2;
                    const yc = (prevY + y) / 2;
                    ctx.quadraticCurveTo(prevX, prevY, xc, yc);
                }

                x += sliceWidth;
            }

            ctx.lineTo(width, height / 2);
            ctx.stroke();

            // Reset Shadow for next frame
            ctx.shadowBlur = 0;
        };

        draw();

        return () => {
            resizeObserver?.disconnect();
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        };
    }, [analyser, isActive]);

    return (
        <div className="w-full h-full rounded-xl overflow-hidden relative" style={{ background: SCOPE_BG }}>
            <canvas ref={canvasRef} className="w-full h-full block" />

            {/* 网格：给波形一个可读的纵向参照，纯静态，不参与绘制循环 */}
            <div className="absolute inset-0 pointer-events-none opacity-[0.14] bg-[linear-gradient(rgba(148,163,184,0.6)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.6)_1px,transparent_1px)] bg-[length:100%_25%,8.333%_100%]" />

            {/* Overlay Scanline Effect */}
            <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] z-10 bg-[length:100%_4px,6px_100%]" />

            {/* 播放时沿顶边扫过的一道流光，静止状态下不存在 */}
            {isActive && (
                <div className="absolute inset-x-0 top-0 h-px overflow-hidden pointer-events-none z-20">
                    <div className="spg-sheen h-px w-1/3 bg-gradient-to-r from-transparent via-cyan-300 to-transparent" />
                </div>
            )}
        </div>
    );
};

/* ========================================================================== */
/*                               代码编辑器                                   */
/* ========================================================================== */

interface CodeEditorProps {
    code: string;
    onChange: (val: string) => void;
    error?: ParserError | null;
}

const CodeEditor: React.FC<CodeEditorProps> = ({ code, onChange, error }) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const preRef = useRef<HTMLPreElement>(null);
    const lineNumbersRef = useRef<HTMLDivElement>(null);

    const [lineCount, setLineCount] = useState(1);
    const [currentLine, setCurrentLine] = useState(1);
    // 列号此前是写死的 `Col 0`：光标位置只算了行、没算列，状态栏却在宣称列号，
    // 于是无论把光标移到哪里都显示 0。这里把列一并算出来（1 起，与编辑器惯例一致）。
    const [currentCol, setCurrentCol] = useState(1);

    // 同步滚动
    const handleScroll = () => {
        if (textareaRef.current && preRef.current && lineNumbersRef.current) {
            const scrollTop = textareaRef.current.scrollTop;
            preRef.current.scrollTop = scrollTop;
            lineNumbersRef.current.scrollTop = scrollTop;
        }
    };

    // 跟踪光标位置来高亮当前行
    const handleSelectionChange = () => {
        if (!textareaRef.current) return;
        const cursorPos = textareaRef.current.selectionStart;
        const textBeforeCursor = textareaRef.current.value.substring(0, cursorPos);
        setCurrentLine(textBeforeCursor.split('\n').length);
        // 列 = 光标距本行行首的字符数 + 1（1 起）
        setCurrentCol(cursorPos - textBeforeCursor.lastIndexOf('\n'));
    };

    useEffect(() => {
        setLineCount(code.split('\n').length);
    }, [code]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Tab Support
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = e.currentTarget.selectionStart;
            const end = e.currentTarget.selectionEnd;

            // Insert 2 spaces
            onChange(code.substring(0, start) + '  ' + code.substring(end));

            // Restore cursor position (needs timeout because React render is async)
            setTimeout(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 2;
                }
            }, 0);
        }
    };

    // SPG 语法高亮器 (Tokenizer 模式)
    // 解决正则冲突问题：一次性匹配所有 Token，避免重复替换破坏 HTML 结构
    const highlightCode = (input: string) => {
        // 1. 定义 Token 正则
        // 注意顺序：注释和字符串优先，避免关键字匹配到字符串内部
        const tokens = [
            { type: 'comment', regex: /(?:#|\/\/).*/ },
            { type: 'string', regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/ }, // 支持转义引号
            { type: 'number', regex: /-?\d+(?:\.\d+)?(?:ms|s|n)?\b/ },
            { type: 'keyword', regex: /\b(?:config|define_instrument|sequence|mix|effect_chain|track)\b/ },
            // 指令与效果器
            { type: 'function', regex: /\b(?:note|chord|arp|hit|rest|progression|run|delay|pingpong|reverb|distortion|overdrive|bitcrush|chorus|flanger|phaser|tremolo|compressor|filter|eq|lowpass|highpass|bandpass|notch|lowshelf|highshelf|peaking|allpass|adsr|ad|ar|perc|sine|square|sawtooth|triangle)\b/ },
            // 乐器 / 音序 / 效果器的参数名
            { type: 'property', regex: /\b(?:name|tempo|bpm|master_gain|key|scale|swing|instrument|wave|envelope|env|filter|filter_envelope|filter_env_amount|lfo|pan|gain|source|time|at|loop|repeat|stagger|feedback|mix|attack|decay|sustain|release|frequency|freq|Q|amount|target|pattern|rate|duration|dur|strum|voicing|octaves|octave|gate|velocity|vel|accent|transpose|glide|glide_from|detune|humanize|harmonics|voices|unison_spread|spread|pitch_env_amount|pitch_decay|attack_noise|velocity_sensitivity|velocity_to_filter|fm_wave|fm_index|fm_ratio|preset|curve|delay|ramp|swell|sweep|sweep_to|damping|pre_delay|pingpong|bits|depth|threshold|ratio|kind|from|to|low|mid|high|min|max|tune|tone|snap|direction|pitches|chords|notes|beats|beat|times|step|len)\b/ },
        ];

        // 2. 组合正则
        const combinedRegex = new RegExp(tokens.map((t) => `(${t.regex.source})`).join('|'), 'g');

        // 3. HTML 转义辅助
        const escape = (str: string) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        let lastIndex = 0;
        let html = '';
        let match;

        while ((match = combinedRegex.exec(input)) !== null) {
            // 添加匹配前的普通文本 (需转义)
            html += escape(input.slice(lastIndex, match.index));

            const fullMatch = match[0];

            // 根据捕获组判断类型。
            // 每个分支都对 fullMatch 走 escape()：目前 3~6 组（数字/关键字/函数/属性）
            // 的正则都是固定字面量或纯数字，匹配不到 < > &，所以"不转义"当下不会出事。
            // 但这段 HTML 最终走 dangerouslySetInnerHTML，一旦以后有人往 tokens 里加了
            // 能匹配 '<' 的规则（比如标签高亮、泛型符号），未转义的分支立刻变成注入点，
            // 而且不会有任何测试报警。统一转义把这个隐患消掉，代价为零。
            if (match[1]) html += `<span class="token-comment">${escape(fullMatch)}</span>`;
            else if (match[2]) html += `<span class="token-string">${escape(fullMatch)}</span>`;
            else if (match[3]) html += `<span class="token-number">${escape(fullMatch)}</span>`;
            else if (match[4]) html += `<span class="token-keyword">${escape(fullMatch)}</span>`;
            else if (match[5]) html += `<span class="token-function">${escape(fullMatch)}</span>`;
            else if (match[6]) html += `<span class="token-property">${escape(fullMatch)}</span>`;
            else html += escape(fullMatch); // 兜底

            lastIndex = combinedRegex.lastIndex;
        }

        // 添加剩余文本
        return html + escape(input.slice(lastIndex));
    };

    // Tokenizer 正则组合每键都重建，大粘贴会逐键全量重跑；按 code 缓存高亮结果
    const highlightedHtml = useMemo(() => highlightCode(code), [code]);

    return (
        <div className="flex flex-col h-full bg-[#0b0f14] font-mono text-sm relative">
            {/* Scoped Styles for Editor Layout & Highlighting */}
            <style>{`
        .spg-editor-container {
            position: relative;
            font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            line-height: 21px;
        }
        .spg-editor-textarea, .spg-editor-pre {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            margin: 0;
            padding: 1rem;
            padding-left: 3.5rem; /* Space for line numbers */
            border: none;
            overflow: auto;
            white-space: pre;
            background: transparent;
            box-sizing: border-box;
            tab-size: 2;
        }
        .spg-editor-textarea {
            color: transparent;
            caret-color: #67e8f9;
            z-index: 1;
            resize: none;
            outline: none;
        }
        .spg-editor-pre {
            z-index: 0;
            pointer-events: none;
            color: #cbd5e1;
        }
        /* 行号槽与代码区共享同一套行高（21px）与顶部内边距（1rem），
           两者任一改动都会让行号与代码错位。 */
        .line-numbers {
            position: absolute;
            top: 0;
            left: 0;
            width: 3rem;
            height: 100%;
            padding: 1rem 0;
            background: #0b0f14;
            border-right: 1px solid rgba(255, 255, 255, 0.07);
            color: #3f4a5c;
            text-align: right;
            overflow: hidden;
            z-index: 2;
            user-select: none;
        }
        /* Token Colors (One Dark inspired) */
        .token-comment { color: #6a9955; font-style: italic; }
        .token-keyword { color: #c678dd; font-weight: bold; }
        .token-function { color: #61afef; }
        .token-property { color: #e06c75; }
        .token-string { color: #98c379; }
        .token-number { color: #d19a66; }
      `}</style>

            {/* Editor Area */}
            <div className="relative flex-1 overflow-hidden spg-editor-container">
                {/* Active Line Highlight (Background) */}
                <div
                    className="spg-active-line absolute left-0 right-0 bg-white/[0.045] pointer-events-none z-0"
                    style={{
                        top: `${(currentLine - 1) * 21 + 16}px`, // 21px 行高 + 1rem 内边距
                        height: '21px',
                        width: '100%',
                    }}
                />

                {/* Line Numbers */}
                <div ref={lineNumbersRef} className="line-numbers">
                    {Array.from({ length: lineCount }, (_, i) => (
                        <div
                            key={i}
                            className={`
                    px-2 
                    ${error?.line === i + 1 ? 'text-rose-400 font-bold bg-rose-500/15' : ''}
                    ${currentLine === i + 1 && error?.line !== i + 1 ? 'text-cyan-300' : ''}
                `}
                        >
                            {i + 1}
                        </div>
                    ))}
                </div>

                {/* Highlighting Layer (Pre/Code) */}
                <pre ref={preRef} className="spg-editor-pre" aria-hidden="true">
                    <code dangerouslySetInnerHTML={{ __html: highlightedHtml + '<br>' }} />
                </pre>

                {/* Editing Layer (Textarea) */}
                <textarea
                    ref={textareaRef}
                    className="spg-editor-textarea"
                    value={code}
                    onChange={(e) => onChange(e.target.value)}
                    onScroll={handleScroll}
                    onKeyDown={handleKeyDown}
                    onSelect={handleSelectionChange}
                    onClick={handleSelectionChange}
                    onKeyUp={handleSelectionChange}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                />
            </div>

            {/* Footer Info */}
            <div className="px-4 py-1.5 bg-[#0b0f14] border-t border-white/7 flex justify-between items-center text-[11px] text-zinc-500 z-10 select-none">
                <span className="font-mono">
                    Ln {currentLine}, Col {currentCol}
                    <span className="text-zinc-700"> · </span>
                    {lineCount} 行
                </span>
                <span className="flex items-center gap-2">
                    {error && <span className="text-rose-400/90">第 {error.line} 行有错</span>}
                    <span className="text-zinc-600">SPG 1.0</span>
                </span>
            </div>
        </div>
    );
};

/* ========================================================================== */
/*                                  对话区                                    */
/* ========================================================================== */

interface ChatInterfaceProps {
    initialMessages: Message[];
    onCodeGenerated: (code: string) => void;
    onMessagesUpdate: (messages: Message[]) => void;
    /**
     * 对话能力由父级 AudioPanel 注入。
     * 这里刻意不调用 useAudio()：那会为每个 ChatInterface 实例
     * 额外创建一个 AudioContext 且从不关闭，造成音频上下文泄漏。
     */
    chat: {
        isProcessing: boolean;
        sendMessage: (content: string) => Promise<{ success: boolean; code?: string; replyMessage: Message }>;
        triggerFix: (brokenCode: string, error: string) => Promise<{ success: boolean; code?: string; replyMessage: Message }>;
    };
}

/**
 * 消息正文渲染。
 *
 * 模型回复里最常出现的两种结构是**行内代码**（`note("C4","4n")` 这类写法）
 * 和段落换行。此前整段当纯文本塞进一个 div，反引号和换行原样显示，
 * 一条讲语法的回复读起来是一坨。
 *
 * 这里只处理这两种，不引入 Markdown 解析器：对话内容是模型生成的，
 * 走 HTML 渲染等于把注入面交给模型；下面全程是 React 元素，没有 innerHTML。
 */
const MessageBody: React.FC<{ content: string }> = ({ content }) => (
    <>
        {content.split('\n').map((line, lineIdx) => (
            <React.Fragment key={lineIdx}>
                {lineIdx > 0 && <br />}
                {line.split(/(`[^`]+`)/g).map((part, partIdx) =>
                    part.length > 1 && part.startsWith('`') && part.endsWith('`') ? (
                        <code
                            key={partIdx}
                            className="rounded bg-black/40 px-1 py-0.5 font-mono text-[0.85em] text-cyan-300"
                        >
                            {part.slice(1, -1)}
                        </code>
                    ) : (
                        <React.Fragment key={partIdx}>{part}</React.Fragment>
                    )
                )}
            </React.Fragment>
        ))}
    </>
);

/** 一条可复制的代码片段（模型回复里带 ``` 围栏的块） */
const CodeSnippet: React.FC<{ code: string }> = ({ code }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
        } catch {
            // 剪贴板权限被拒时保持原状：没有反馈好过谎报"已复制"
        }
    };

    return (
        <div className="mt-2 rounded-lg border border-white/8 bg-black/50 overflow-hidden">
            <div className="flex items-center justify-between px-2.5 py-1 border-b border-white/8 bg-white/[0.03]">
                <span className={`${LABEL} text-zinc-600`}>SPG</span>
                <button
                    onClick={handleCopy}
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-white/10 hover:text-white ${FOCUS_RING}`}
                    title="复制代码"
                >
                    {copied ? <CheckIcon className="w-3 h-3 text-emerald-400" /> : <ClipboardDocumentIcon className="w-3 h-3" />}
                    {copied ? '已复制' : '复制'}
                </button>
            </div>
            <pre className="px-2.5 py-2 overflow-x-auto text-[11px] leading-4 text-zinc-300 font-mono">{code}</pre>
        </div>
    );
};

/**
 * 把消息正文切成"文本段 + 代码块"。
 * 代码块用 ``` 围栏界定，与提示词要求模型输出的格式一致。
 */
const splitMessage = (content: string): { text: string; code?: string }[] => {
    const parts: { text: string; code?: string }[] = [];
    const fence = /```[^\n]*\n?([\s\S]*?)```/g;
    let last = 0;
    let match: RegExpExecArray | null;

    while ((match = fence.exec(content)) !== null) {
        if (match.index > last) parts.push({ text: content.slice(last, match.index) });
        parts.push({ text: '', code: match[1].replace(/\n$/, '') });
        last = fence.lastIndex;
    }
    if (last < content.length) parts.push({ text: content.slice(last) });
    return parts.length ? parts : [{ text: content }];
};

/** 一条消息的气泡内容：代码块单独成块，其余走 MessageBody */
const MessageContent: React.FC<{ content: string }> = ({ content }) => (
    <>
        {splitMessage(content).map((part, idx) =>
            part.code !== undefined ? (
                <CodeSnippet key={idx} code={part.code} />
            ) : part.text.trim() ? (
                <MessageBody key={idx} content={part.text.trim()} />
            ) : null
        )}
    </>
);

const ChatInterface = forwardRef<ChatInterfaceRef, ChatInterfaceProps>(
    ({ initialMessages, onCodeGenerated, onMessagesUpdate, chat }, ref) => {
        const { isProcessing, sendMessage, triggerFix: triggerFixAction } = chat;

        const [input, setInput] = useState('');
        const [messages, setMessages] = useState<Message[]>(initialMessages);
        const messagesEndRef = useRef<HTMLDivElement>(null);
        const scrollRef = useRef<HTMLDivElement>(null);
        const isMounted = useRef(true);
        /**
         * 用户是否还停在底部。
         *
         * 原来是无条件 `scrollIntoView({ behavior: 'smooth' })`：只要消息一变就滚到底。
         * 自动修复一轮会连续追加多条消息，用户想往上翻看前一条报错时会被反复拽回底部，
         * 根本读不了。改成只在"本来就在底部"时跟随。
         */
        const pinnedToBottom = useRef(true);

        useEffect(() => {
            isMounted.current = true;
            return () => {
                isMounted.current = false;
            };
        }, []);

        const handleScroll = () => {
            const el = scrollRef.current;
            if (!el) return;
            // 24px 容差：滚动到底时浏览器给的 scrollTop 常差几个小数
            pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        };

        useEffect(() => {
            setMessages(initialMessages);
        }, [initialMessages]);

        useEffect(() => {
            if (pinnedToBottom.current) {
                messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }
        }, [messages, isProcessing]);

        useEffect(() => {
            if (isMounted.current) {
                onMessagesUpdate(messages);
            }
        }, [messages, onMessagesUpdate]);

        // 暴露给父组件的 AutoFix 触发器
        useImperativeHandle(ref, () => ({
            triggerFix: async (brokenCode: string, error: string) => {
                const systemMsg: Message = {
                    role: 'model',
                    content: `检测到编译错误：${error}。正在尝试自动修复...`,
                    timestamp: Date.now(),
                };
                setMessages((prev) => [...prev, systemMsg]);

                const result = await triggerFixAction(brokenCode, error);

                if (!isMounted.current) return;

                setMessages((prev) => [...prev, result.replyMessage]);

                if (result.success && result.code) {
                    onCodeGenerated(result.code);
                }
            },
        }));

        const handleSend = async () => {
            if (!input.trim() || isProcessing) return;

            const userMsg: Message = { role: 'user', content: input, timestamp: Date.now() };
            setMessages((prev) => [...prev, userMsg]);
            setInput('');
            // 自己发的消息一定要看到，强制回到跟随状态
            pinnedToBottom.current = true;

            const result = await sendMessage(userMsg.content);

            if (!isMounted.current) return;

            setMessages((prev) => [...prev, result.replyMessage]);

            if (result.success && result.code) {
                onCodeGenerated(result.code);
            }
        };

        const handleKeyDown = (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        };

        return (
            <div className="flex flex-col h-full bg-transparent">
                {/* Header */}
                <div className="px-4 py-3 border-b border-white/8 bg-white/[0.02] flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600">
                            <SparklesIcon className="w-3.5 h-3.5 text-white" />
                        </span>
                        <h2 className="text-sm font-bold text-zinc-100">作曲助手</h2>
                    </div>
                    <span className={`${LABEL} rounded border border-white/8 bg-white/[0.03] px-2 py-1 text-zinc-500`}>
                        描述 → 代码
                    </span>
                </div>

                {/* Message List */}
                <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-5 custom-scrollbar">
                    {messages.map((msg, idx) => (
                        <div key={idx} className={`flex gap-2.5 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                            {/* Avatar */}
                            <div
                                className={`
                w-7 h-7 rounded-full flex items-center justify-center shrink-0 border
                ${msg.role === 'user'
                                        ? 'bg-white/[0.06] border-white/10'
                                        : msg.role === 'system' ? 'bg-transparent border-transparent'
                                            : 'bg-gradient-to-br from-cyan-600 to-blue-700 border-cyan-400/30'
                                    }
            `}
                            >
                                {msg.role === 'user' && <UserCircleIcon className="w-4 h-4 text-zinc-400" />}
                                {msg.role === 'model' && <CpuChipIcon className="w-4 h-4 text-white" />}
                            </div>

                            {/* Bubble */}
                            <div
                                className={`
                max-w-[85%] min-w-0 rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed
                ${msg.role === 'user'
                                        ? 'bg-cyan-500/12 text-cyan-50 rounded-tr-sm border border-cyan-400/20'
                                        : msg.role === 'system'
                                            ? 'bg-white/[0.02] text-zinc-500 text-[11px] italic text-center w-full border border-dashed border-white/10'
                                            : 'bg-white/[0.045] text-zinc-300 rounded-tl-sm border border-white/8'
                                    }
            `}
                            >
                                <MessageContent content={msg.content} />
                            </div>
                        </div>
                    ))}

                    {isProcessing && (
                        <div className="flex gap-2.5">
                            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-cyan-600 to-blue-700 border border-cyan-400/30 flex items-center justify-center shrink-0">
                                <CpuChipIcon className="w-4 h-4 text-white" />
                            </div>
                            <div className="bg-white/[0.045] rounded-2xl rounded-tl-sm px-3.5 py-3 border border-white/8 flex items-center gap-1">
                                {[0, 0.15, 0.3].map((delay) => (
                                    <span
                                        key={delay}
                                        className="spg-dot w-1.5 h-1.5 bg-cyan-400 rounded-full"
                                        style={{ '--spg-delay': `${delay}s` } as React.CSSProperties}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* Input Area */}
                <div className="p-3 border-t border-white/8 bg-white/[0.02] shrink-0">
                    <div className="relative">
                        <input
                            type="text"
                            value={input}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="描述你想要的音乐，例如：一段 90BPM 的 Lo-fi 钢琴…"
                            className={`w-full bg-black/40 border border-white/10 rounded-xl pl-3.5 pr-11 py-2.5 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/25 transition ${FOCUS_RING}`}
                            disabled={isProcessing}
                        />
                        <button
                            onClick={handleSend}
                            disabled={isProcessing || !input.trim()}
                            title="发送（Enter）"
                            className={`
                absolute right-1.5 top-1/2 -translate-y-1/2 p-2 rounded-lg transition
                ${isProcessing || !input.trim()
                                    ? 'text-zinc-700'
                                    : 'text-cyan-400 hover:bg-cyan-500/15 hover:text-cyan-300'
                                }
            `}
                        >
                            <PaperAirplaneIcon className="w-4 h-4" />
                        </button>
                    </div>
                    <p className="mt-2 text-[10px] text-zinc-600 leading-relaxed">
                        生成后会自动试跑；编译失败会连续自动修复最多 3 次。
                    </p>
                </div>
            </div>
        );
    }
);

/* ========================================================================== */
/*                                音频实验室                                  */
/* ========================================================================== */

type ToolMode = 'converter' | 'analyzer' | 'fixer';

interface ConverterProps {
    isProcessing: boolean;
    logs: string[];
    convert: (files: FileList | null, target: 'wav2asf' | 'asf2wav') => Promise<void>;
}

interface AnalyzerProps {
    result: AnalyzerResult | null;
    analyze: (file: File) => Promise<void>;
}

interface FixerProps {
    file: File | null;
    gain: number;
    isProcessing: boolean;
    setFile: (file: File | null) => void;
    setGain: (gain: number) => void;
    applyFix: () => Promise<void>;
}

interface AudioToolboxProps {
    converter: ConverterProps;
    analyzer: AnalyzerProps;
    fixer: FixerProps;
}

const AudioToolbox: React.FC<AudioToolboxProps> = ({ converter, analyzer, fixer }) => {
    const [mode, setMode] = useState<ToolMode>('analyzer');

    const tabs: { id: ToolMode; label: string; hint: string; icon: React.ElementType }[] = [
        { id: 'analyzer', label: '音频透视', hint: '波形与响度指标', icon: ChartBarIcon },
        { id: 'converter', label: '格式转换', hint: 'WAV ⇄ ASF', icon: ArrowPathRoundedSquareIcon },
        { id: 'fixer', label: '增益修复', hint: '无损数字增益', icon: WrenchScrewdriverIcon },
    ];

    return (
        <div className="flex flex-col h-full spg-noise text-zinc-200">
            {/* Header / Tabs */}
            <div className="flex border-b border-white/8 bg-zinc-950/70 backdrop-blur-md px-6 pt-3 gap-1.5 shrink-0">
                {tabs.map((tab) => {
                    const active = mode === tab.id;
                    return (
                        <button
                            key={tab.id}
                            onClick={() => setMode(tab.id)}
                            aria-current={active ? 'page' : undefined}
                            className={`
                            group relative flex items-center gap-2.5 rounded-t-xl px-4 py-2.5 text-sm font-medium transition-colors ${FOCUS_RING}
                            ${active ? 'text-cyan-300 bg-white/[0.05]' : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.03]'}
                        `}
                        >
                            <tab.icon className="w-4 h-4 shrink-0" />
                            <span className="flex flex-col items-start leading-tight">
                                <span>{tab.label}</span>
                                <span className="text-[10px] font-normal text-zinc-600 group-hover:text-zinc-500">
                                    {tab.hint}
                                </span>
                            </span>
                            {/* 选中态指示条压在底边上，与下方内容区连成一体 */}
                            {active && (
                                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-gradient-to-r from-cyan-400 to-blue-500" />
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
                <div className={`${SURFACE} mx-auto w-full max-w-6xl p-6 shadow-2xl shadow-black/40`}>
                    {mode === 'converter' && <ConverterView {...converter} />}
                    {mode === 'analyzer' && <AnalyzerView {...analyzer} />}
                    {mode === 'fixer' && <FixerView {...fixer} />}
                </div>
            </div>
        </div>
    );
};

/** 转换面板里的一个方向：源格式 → 目标格式 */
interface ConvertCardProps {
    from: string;
    to: string;
    title: string;
    description: string;
    accept: string;
    disabled: boolean;
    onPick: (files: FileList | null) => void;
}

const ConvertCard: React.FC<ConvertCardProps> = ({ from, to, title, description, accept, disabled, onPick }) => (
    <div className={`${SURFACE} ${SURFACE_HOVER} flex flex-col p-6`}>
        <div className="mb-3 flex items-center gap-2">
            <span className="rounded-md border border-cyan-400/25 bg-cyan-500/12 px-2 py-0.5 font-mono text-[11px] font-bold text-cyan-300">
                {from}
            </span>
            <ChevronRightIcon className="w-3.5 h-3.5 text-zinc-600" />
            <span className="rounded-md border border-violet-400/25 bg-violet-500/12 px-2 py-0.5 font-mono text-[11px] font-bold text-violet-300">
                {to}
            </span>
        </div>

        <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
        <p className="mt-1 mb-5 text-xs leading-relaxed text-zinc-500">{description}</p>

        <label
            className={`
                mt-auto flex items-center justify-center gap-2 w-full py-3.5 rounded-xl
                border border-dashed border-white/12 cursor-pointer
                hover:border-cyan-400/50 hover:bg-cyan-500/[0.06] transition-colors
                ${FOCUS_RING} ${disabled ? 'pointer-events-none opacity-40' : ''}
            `}
        >
            <ArrowUpTrayOutlineIcon className="w-4 h-4 text-cyan-400" />
            <span className="text-sm font-medium text-zinc-300">选择文件（支持批量）</span>
            <input type="file" multiple accept={accept} className="hidden" onChange={(e) => onPick(e.target.files)} />
        </label>
    </div>
);

const ConverterView: React.FC<ConverterProps> = ({ isProcessing, logs, convert }) => (
    <div className="space-y-6 spg-rise">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <ConvertCard
                from="WAV"
                to="ASF"
                title="封装为 ASF"
                description="把标准 WAV 音频转成自定义 ASF 文本格式，体积更小、便于版本管理。"
                accept=".wav"
                disabled={isProcessing}
                onPick={(files) => convert(files, 'wav2asf')}
            />
            <ConvertCard
                from="ASF"
                to="WAV"
                title="还原为 WAV"
                description="把 ASF 文本格式还原成可直接播放的 WAV 音频。"
                accept=".asf,.txt"
                disabled={isProcessing}
                onPick={(files) => convert(files, 'asf2wav')}
            />
        </div>

        {/* Console Output */}
        <div className="overflow-hidden rounded-xl border border-white/8 bg-black/60">
            <div className="flex items-center justify-between border-b border-white/8 bg-white/[0.03] px-3 py-2">
                <span className={LABEL}>处理日志</span>
                {isProcessing && (
                    <span className="flex items-center gap-1.5 text-[10px] text-cyan-400">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
                        处理中
                    </span>
                )}
            </div>
            <div className="max-h-[280px] min-h-[150px] overflow-y-auto p-3 font-mono text-xs custom-scrollbar">
                {logs.length === 0 && (
                    <div className="py-10 text-center italic text-zinc-700">等待任务开始…</div>
                )}
                {logs.map((log, i) => (
                    // 日志里"成功 / 失败 / 跳过"是三种需要一眼分开的结果，
                    // 用左侧色条区分，比让用户逐行读中文快得多
                    <div
                        key={i}
                        className={`
                            mb-1 border-l-2 py-1 pl-2.5
                            ${log.includes('失败') ? 'border-rose-500/60 text-rose-300'
                                : log.includes('成功') ? 'border-emerald-500/60 text-emerald-300'
                                    : 'border-white/10 text-zinc-500'}
                        `}
                    >
                        {log}
                    </div>
                ))}
            </div>
        </div>
    </div>
);

const AnalyzerView: React.FC<AnalyzerProps> = ({ result, analyze }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isDragging, setIsDragging] = useState(false);

    const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            analyze(e.target.files[0]);
        }
        // 清空，否则连续选同一个文件不会再触发 change
        e.target.value = '';
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) analyze(file);
    };

    // Draw static waveform
    useEffect(() => {
        if (!result || !canvasRef.current) return;

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
        ctx.fillStyle = '#0b0f14';
        ctx.fillRect(0, 0, width, height);

        // 中线
        ctx.strokeStyle = 'rgba(148,163,184,0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();

        /**
         * 波形主体。
         *
         * 原来逐像素 `moveTo/lineTo` 画满整个宽度：一个 3 分钟的文件在 1000px
         * 宽的画布上要画 1000 条竖线，且每条都要扫过 step 个采样点 ——
         * 每次分析完都卡一下。这里先按"每个像素列的 min/max"聚合（这步省不掉，
         * 它才是波形本身），但用单条 path + 一次 stroke 提交，并把列数限制在
         * 画布宽度内，避免在超宽屏上白画。
         */
        ctx.beginPath();
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 1;

        const columns = Math.min(Math.floor(width), 2000);
        for (let i = 0; i < columns; i++) {
            // 列数可能小于画布宽度，按比例映射回像素坐标
            const x = (i / columns) * width;
            let min = 1.0;
            let max = -1.0;
            const start = Math.floor((i / columns) * data.length);
            const end = Math.min(data.length, Math.floor(((i + 1) / columns) * data.length));
            for (let j = start; j < end; j++) {
                const datum = data[j];
                if (datum < min) min = datum;
                if (datum > max) max = datum;
            }
            if (min > max) continue;
            ctx.moveTo(x, (1 - max) * amp);
            ctx.lineTo(x, (1 - min) * amp);
        }
        ctx.stroke();
    }, [result]);

    return (
        <div className="space-y-6 spg-rise">
            <div className={`${SURFACE} flex flex-wrap items-center justify-between gap-4 p-5`}>
                <div>
                    <h3 className="text-lg font-bold text-zinc-100">音频透视</h3>
                    <p className="mt-1 text-xs text-zinc-500">
                        读出声学指标与波形，用于判断响度是否合格、有没有削顶。
                    </p>
                </div>
                <label className={`${BTN_PRIMARY} cursor-pointer px-4 py-2.5 text-[13px]`}>
                    <ArrowUpTrayOutlineIcon className="w-4 h-4" /> 上传音频
                    <input type="file" onChange={handleFile} accept="audio/*" className="hidden" />
                </label>
            </div>

            {result ? (
                <div className="space-y-5">
                    {/* Stats Grid */}
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                        <StatCard label="时长" value={`${result.duration.toFixed(2)}s`} hint="Duration" highlight />
                        <StatCard label="峰值" value={result.peak.toFixed(4)} hint="Peak" />
                        <StatCard label="最大响度" value={`${result.maxDBFS.toFixed(2)} dB`} hint="Max dBFS" />
                        <StatCard label="有效值" value={result.rms.toFixed(4)} hint="RMS" />
                        <StatCard label="采样率" value={`${result.sampleRate} Hz`} hint="Sample Rate" />
                        <StatCard label="通道" value={result.channels} hint="Channels" />
                        <StatCard label="波峰因数" value={result.crestFactor.toFixed(2)} hint="Crest Factor" />
                        <StatCard
                            label="过零率"
                            value={`${(result.zeroCrossRate * 100).toFixed(2)}%`}
                            hint="Zero Cross"
                        />
                    </div>

                    {/* Waveform */}
                    <div
                        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                        onDragLeave={() => setIsDragging(false)}
                        onDrop={handleDrop}
                        className={`relative h-64 overflow-hidden rounded-xl border bg-[#0b0f14] transition-colors ${isDragging ? 'border-cyan-400/70 bg-cyan-500/5' : 'border-white/8'
                            }`}
                    >
                        <canvas ref={canvasRef} className="h-full w-full" />
                        <div className="pointer-events-none absolute left-3 top-3 rounded border border-white/8 bg-black/70 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-cyan-400">
                            波形
                        </div>
                        {isDragging && (
                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 text-sm font-bold text-cyan-300">
                                松开以分析这个文件
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <label
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                    className={`flex h-64 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed transition-colors ${isDragging
                        ? 'border-cyan-400/70 bg-cyan-500/[0.07] text-cyan-300'
                        : 'border-white/10 bg-white/[0.02] text-zinc-600 hover:border-white/20 hover:text-zinc-400'
                        }`}
                >
                    <ChartBarIcon className="w-10 h-10 opacity-30" />
                    <span className="text-sm">{isDragging ? '松开以分析这个文件' : '拖入音频文件，或点击选择'}</span>
                    <input type="file" onChange={handleFile} accept="audio/*" className="hidden" />
                </label>
            )}
        </div>
    );
};

const StatCard: React.FC<{ label: string; value: string | number; hint: string; highlight?: boolean }> = ({
    label,
    value,
    hint,
    highlight,
}) => (
    <div className={`${SURFACE} ${SURFACE_HOVER} p-4`}>
        <div className="flex items-baseline justify-between gap-2">
            <span className={LABEL}>{label}</span>
            <span className="font-mono text-[9px] text-zinc-700">{hint}</span>
        </div>
        <div className={`mt-1.5 font-mono text-lg font-medium ${highlight ? 'text-cyan-300' : 'text-zinc-100'}`}>
            {value}
        </div>
    </div>
);

const FixerView: React.FC<FixerProps> = ({ file, gain, isProcessing, setFile, setGain, applyFix }) => {
    const [isDragging, setIsDragging] = useState(false);

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const dropped = e.dataTransfer.files?.[0];
        if (dropped) setFile(dropped);
    };

    return (
        <div className="mx-auto max-w-2xl space-y-6 py-4 spg-rise">
            <div className="text-center">
                <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500/25 to-blue-600/25 ring-1 ring-inset ring-cyan-400/20">
                    <WrenchScrewdriverIcon className="h-6 w-6 text-cyan-300" />
                </div>
                <h3 className="text-lg font-bold text-zinc-100">增益修复</h3>
                <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-zinc-500">
                    音量过低或过高时，用无损数字增益补偿。导出为新的 WAV，原文件不动。
                </p>
            </div>

            <div className={`${SURFACE} space-y-7 p-6 shadow-2xl shadow-black/40`}>
                {/* File Input */}
                <div>
                    <label className={`${LABEL} mb-2.5 block`}>输入文件</label>
                    <label
                        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                        onDragLeave={() => setIsDragging(false)}
                        onDrop={handleDrop}
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 py-3.5 transition-colors ${isDragging
                            ? 'border-cyan-400/70 bg-cyan-500/[0.07]'
                            : 'border-white/12 hover:border-cyan-400/40 hover:bg-white/[0.03]'
                            }`}
                    >
                        <ArrowUpTrayOutlineIcon className="h-4 w-4 shrink-0 text-cyan-400" />
                        <span className={`min-w-0 flex-1 truncate text-sm ${file ? 'text-zinc-100' : 'text-zinc-500'}`}>
                            {file ? file.name : '拖入音频文件，或点击选择'}
                        </span>
                        {file && (
                            <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                                {(file.size / 1024 / 1024).toFixed(2)} MB
                            </span>
                        )}
                        <input
                            type="file"
                            accept="audio/*"
                            onChange={(e) => setFile(e.target.files?.[0] || null)}
                            className="hidden"
                        />
                    </label>
                </div>

                {/* Gain Slider */}
                <div>
                    <div className="mb-3 flex items-center justify-between">
                        <span className={LABEL}>增益量</span>
                        <span
                            className={`rounded-md border px-2.5 py-0.5 font-mono text-xs ${gain === 0
                                ? 'border-white/10 bg-white/[0.04] text-zinc-400'
                                : 'border-cyan-400/30 bg-cyan-500/12 text-cyan-300'
                                }`}
                        >
                            {gain > 0 ? '+' : ''}{gain} dB
                        </span>
                    </div>
                    <input
                        type="range"
                        min="-60"
                        max="60"
                        step="1"
                        value={gain}
                        aria-label="增益量（分贝）"
                        onChange={(e) => setGain(parseInt(e.target.value))}
                        // index.css 里那套 range 样式用 --tp-fill 伪造"已填充轨道"，
                        // 不写这个变量的话轨道永远显示为空（PlayPanel 的滑杆同款约定）
                        style={{ '--tp-fill': `${((gain + 60) / 120) * 100}%` } as React.CSSProperties}
                        className="w-full"
                    />
                    <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-600">
                        <span>-60</span>
                        <button
                            onClick={() => setGain(0)}
                            className="rounded px-1.5 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
                            title="归零"
                        >
                            0
                        </button>
                        <span>+60</span>
                    </div>
                </div>

                {/* Action */}
                <button
                    onClick={applyFix}
                    disabled={!file || isProcessing}
                    className={`${BTN_PRIMARY} w-full py-3.5 text-sm`}
                >
                    {isProcessing ? (
                        <>
                            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                            正在处理…
                        </>
                    ) : (
                        '应用增益并导出'
                    )}
                </button>
            </div>
        </div>
    );
};

/* ========================================================================== */
/*                                 面板外壳                                   */
/* ========================================================================== */

export const AudioPanel: React.FC<AudioPanelProps> = ({ onBack }) => {
    // Use the aggregated Audio Hook
    const { state: audioState, actions: audioActions } = useAudio();
    const { projects: projectList, activeProjectId, activeProject, analyser, appState, parserError } = audioState;
    const { autoFixCount, compileWarnings } = audioState;

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
        if (window.confirm('确定要删除这个项目吗？此操作无法撤销。')) {
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

    const handleCodeUpdate = useCallback((newCode: string) => {
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
        audioActions.importProjectFromFile(file, () => {
            setView('workspace');
            audioActions.reset();
        });
        event.target.value = '';
    }, [audioActions]);

    // --- Render Views ---

    const renderDashboard = () => (
        <div className="relative flex-1 overflow-y-auto bg-slate-950 text-zinc-100 custom-scrollbar">
            {/* 背景光斑：给大面积的纯黑一个空间纵深，纯装饰、不拦事件 */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
                <div className="absolute -top-40 left-1/4 h-[520px] w-[520px] rounded-full bg-cyan-500/10 blur-[130px]" />
                <div className="absolute -bottom-32 right-1/4 h-[420px] w-[420px] rounded-full bg-blue-600/10 blur-[120px]" />
            </div>

            <div className="relative z-10 mx-auto w-full max-w-6xl px-8 py-8">
                {/* Back Button */}
                <button onClick={onBack} className={`${BTN_GHOST} mb-8 px-3.5 py-2`}>
                    <ArrowLeftIcon className="w-4 h-4" />
                    返回浏览
                </button>

                {/* Hero */}
                <div className="mb-10 flex flex-wrap items-end justify-between gap-6 border-b border-white/8 pb-7">
                    <div className="min-w-0">
                        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/25 bg-cyan-500/10 px-3 py-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                            <span className="text-[10px] font-bold uppercase tracking-widest text-cyan-300">
                                Sound Particle Generator
                            </span>
                        </div>
                        <h1 className="bg-gradient-to-r from-cyan-300 via-sky-300 to-blue-400 bg-clip-text text-4xl font-bold tracking-tight text-transparent">
                            SPG Studio
                        </h1>
                        <p className="mt-2 text-sm text-zinc-400">
                            用一句话描述你想要的音乐，AI 写出可编译的合成代码，直接试听。
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-3">
                        <button onClick={handleSwitchToLab} className={`${BTN_GHOST} px-4 py-2.5 text-[13px]`}>
                            <BeakerIcon className="w-4 h-4" /> 实验室
                        </button>
                        <button onClick={() => fileInputRef.current?.click()} className={`${BTN_GHOST} px-4 py-2.5 text-[13px]`}>
                            <ArrowUpTrayIcon className="w-4 h-4" /> 导入 .spg
                        </button>
                        <button onClick={handleCreateProject} className={`${BTN_PRIMARY} px-4 py-2.5 text-[13px]`}>
                            <PlusIcon className="w-4 h-4" /> 新建项目
                        </button>
                    </div>
                </div>

                {/* 概览：项目数与最近一次改动时间 */}
                {projectList.length > 0 && (
                    <div className="mb-6 flex items-center gap-4 text-xs text-zinc-500">
                        <span>
                            <span className="font-mono text-zinc-300">{projectList.length}</span> 个项目
                        </span>
                        <span className="h-3 w-px bg-white/10" />
                        <span>
                            最近改动{' '}
                            <span className="text-zinc-300">
                                {relativeTime(Math.max(...projectList.map((p) => p.lastModified)))}
                            </span>
                        </span>
                    </div>
                )}

                <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {/* Create Card */}
                    <button
                        onClick={handleCreateProject}
                        className={`group flex h-[248px] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-white/10 bg-white/[0.015] transition-colors hover:border-cyan-400/50 hover:bg-cyan-500/[0.04] ${FOCUS_RING}`}
                    >
                        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.04] transition-colors group-hover:bg-cyan-500/15">
                            <PlusIcon className="h-7 w-7 text-zinc-500 transition-colors group-hover:text-cyan-300" />
                        </span>
                        <span className="text-sm font-medium text-zinc-500 transition-colors group-hover:text-cyan-200">
                            开始新创作
                        </span>
                    </button>

                    {/* Project Cards */}
                    {projectList.map((project: Project, index) => {
                        const summary = summarizeCode(project.code);
                        const isActive = project.id === activeProjectId;
                        return (
                            <div
                                key={project.id}
                                onClick={() => handleOpenProject(project.id)}
                                // 入场按索引错开，列表越长越像"依次落位"而不是整块闪出
                                style={{ '--spg-delay': `${Math.min(index, 8) * 45}ms` } as React.CSSProperties}
                                className={`spg-rise group relative flex h-[248px] cursor-pointer flex-col overflow-hidden rounded-2xl border bg-white/[0.03] p-5 transition-all hover:-translate-y-1 hover:border-cyan-400/40 hover:shadow-2xl hover:shadow-cyan-950/40 ${isActive ? 'border-cyan-400/40' : 'border-white/8'
                                    }`}
                            >
                                <div className="mb-3 flex items-start justify-between gap-2">
                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/20 ring-1 ring-inset ring-white/10">
                                        <MusicalNoteIcon className="h-4 w-4 text-cyan-300" />
                                    </span>

                                    <div className="flex items-center gap-1">
                                        {isActive && (
                                            <span className="rounded-full border border-cyan-400/25 bg-cyan-500/12 px-2 py-0.5 text-[10px] font-bold text-cyan-300">
                                                进行中
                                            </span>
                                        )}
                                        <button
                                            onClick={(e) => handleDeleteProject(e, project.id)}
                                            // 触屏没有 hover，删除键不能只在 hover 时出现（同 .tp-row-action 的教训）
                                            className="rounded-lg p-1.5 text-zinc-600 opacity-100 transition hover:bg-rose-500/15 hover:text-rose-300 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                                            title="删除项目"
                                        >
                                            <TrashIcon className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>

                                <h3 className="truncate text-base font-bold text-zinc-100 transition-colors group-hover:text-cyan-200">
                                    {project.name}
                                </h3>

                                <div className="mt-3 flex-1">
                                    <ProjectGlyph seed={project.id} />
                                </div>

                                {/* 源码摘要：让卡片自己说明"这是个什么曲子" */}
                                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                                    {summary.tempo !== null && (
                                        <span className="rounded border border-white/8 bg-white/[0.04] px-1.5 py-0.5 font-mono">
                                            {summary.tempo} BPM
                                        </span>
                                    )}
                                    {summary.key && (
                                        <span className="rounded border border-white/8 bg-white/[0.04] px-1.5 py-0.5 font-mono">
                                            {summary.key}
                                        </span>
                                    )}
                                    {summary.parts > 0 && (
                                        <span className="rounded border border-white/8 bg-white/[0.04] px-1.5 py-0.5 font-mono">
                                            {summary.parts} 声部
                                        </span>
                                    )}
                                    {summary.lines > 0 && (
                                        <span className="rounded border border-white/8 bg-white/[0.04] px-1.5 py-0.5 font-mono">
                                            {summary.lines} 行
                                        </span>
                                    )}
                                </div>

                                <div className="mt-3 flex items-center justify-between border-t border-white/8 pt-3 text-[11px] text-zinc-500">
                                    <span>{relativeTime(project.lastModified)}</span>
                                    <span className="flex items-center gap-1.5">
                                        <SparklesIcon className="w-3 h-3 text-zinc-600" />
                                        {project.messages.length} 条对话
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>

                {projectList.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-3 py-16 text-zinc-600">
                        <CubeIcon className="h-14 w-14 opacity-20" />
                        <p className="text-sm">还没有项目。新建一个，或导入已有的 .spg 文件。</p>
                    </div>
                )}
            </div>
        </div>
    );

    const renderSidebar = () => (
        <div className={`
        flex flex-col border-r border-white/8 bg-zinc-950 transition-all duration-300 ease-in-out relative z-20 shrink-0
        ${isSidebarOpen ? 'w-72 opacity-100 translate-x-0' : 'w-0 opacity-0 -translate-x-10 overflow-hidden'}
    `}>
            {/* Header */}
            <div className="h-14 flex items-center justify-between px-4 border-b border-white/8 bg-white/[0.02] shrink-0">
                <span className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600">
                        <MusicalNoteIcon className="w-3.5 h-3.5 text-white" />
                    </span>
                    <span className="text-sm font-bold tracking-tight text-zinc-100">SPG Studio</span>
                </span>
                <button
                    onClick={onBack}
                    title="返回浏览"
                    className={`rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/8 hover:text-white ${FOCUS_RING}`}
                >
                    <ArrowLeftIcon className="w-4 h-4" />
                </button>
            </div>

            {/* Navigation */}
            <div className="p-3 space-y-1 shrink-0">
                {([
                    { id: 'dashboard' as ViewState, label: '概览', icon: HomeIcon },
                    { id: 'lab' as ViewState, label: '音频实验室', icon: BeakerIcon },
                ]).map((item) => (
                    <button
                        key={item.id}
                        onClick={() => setView(item.id)}
                        aria-current={view === item.id ? 'page' : undefined}
                        className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors ${FOCUS_RING} ${view === item.id
                            ? 'bg-white/[0.07] text-white'
                            : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
                            }`}
                    >
                        <item.icon className="w-4 h-4" /> {item.label}
                    </button>
                ))}
            </div>

            {/* Project List Header */}
            <div className="mt-2 flex items-center justify-between px-4 py-2 shrink-0">
                <h3 className={LABEL}>最近项目</h3>
                <button
                    onClick={handleCreateProject}
                    title="新建项目"
                    className={`rounded-md p-1 text-cyan-400 transition hover:bg-cyan-500/15 hover:text-cyan-300 ${FOCUS_RING}`}
                >
                    <PlusIcon className="w-4 h-4" />
                </button>
            </div>

            {/* Scrollable List */}
            <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-0.5 custom-scrollbar">
                {projectList.map((p: { id: string; name: string }) => {
                    const selected = activeProjectId === p.id && view === 'workspace';
                    return (
                        <div
                            key={p.id}
                            className={`
                        group relative flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-colors
                        ${selected
                                    ? 'bg-white/[0.07] text-cyan-300 font-medium'
                                    : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'}
                    `}
                            onClick={() => handleOpenProject(p.id)}
                        >
                            {selected && (
                                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-cyan-400 rounded-r-full" />
                            )}

                            <div className="flex items-center gap-3 truncate flex-1 pl-2">
                                <span className="truncate text-sm">{p.name}</span>
                            </div>

                            <button
                                onClick={(e) => handleDeleteProject(e, p.id)}
                                // 选中项常显删除键；其余项在触屏上也常显（无 hover 可用）
                                className={`
                            p-1.5 rounded-md text-zinc-500 transition-colors hover:bg-rose-500/15 hover:text-rose-300
                            ${selected ? 'opacity-100' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100'}
                        `}
                                title="删除"
                            >
                                <TrashIcon className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    );
                })}
                {projectList.length === 0 && (
                    <p className="px-3 py-6 text-center text-xs text-zinc-600">还没有项目</p>
                )}
            </div>

            {/* User / Footer */}
            <div className="p-3 border-t border-white/8 text-[10px] text-zinc-600 text-center shrink-0">
                Sound Particle Generator v1.0
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
                            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all duration-300 ${appState === AppState.PLAYING
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
                <AudioToolbox
                    converter={{
                        isProcessing: audioState.converterProcessing,
                        logs: audioState.converterLogs,
                        convert: audioActions.convert,
                    }}
                    analyzer={{
                        result: audioState.analyzerResult,
                        analyze: audioActions.analyze,
                    }}
                    fixer={{
                        file: audioState.fixerFile,
                        gain: audioState.fixerGain,
                        isProcessing: audioState.fixerProcessing,
                        setFile: audioActions.setFixerFile,
                        setGain: audioActions.setFixerGain,
                        applyFix: audioActions.applyFix,
                    }}
                />
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
