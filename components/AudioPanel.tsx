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
    ArrowLeftIcon,
    ArrowUpTrayIcon,
    Bars3Icon,
    BeakerIcon,
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
/*                                 示波器                                     */
/* ========================================================================== */

interface VisualizerProps {
    analyser: AnalyserNode | null;
    isActive: boolean;
}

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
            ctx.fillStyle = isActive ? 'rgba(26, 32, 44, 0.3)' : 'rgb(26, 32, 44)';
            ctx.fillRect(0, 0, width, height);

            if (!isActive) {
                // Draw a flat line when idle
                ctx.beginPath();
                ctx.strokeStyle = '#2d3748';
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
        <div className="w-full h-full bg-gray-850 rounded-lg overflow-hidden border border-gray-750 shadow-inner relative">
            <canvas ref={canvasRef} className="w-full h-full block" />
            {/* Overlay Scanline Effect */}
            <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] z-10 bg-[length:100%_4px,6px_100%]" />
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
        <div className="flex flex-col h-full bg-[#0d1117] font-mono text-sm relative">
            {/* Scoped Styles for Editor Layout & Highlighting */}
            <style>{`
        .spg-editor-container {
            position: relative;
            font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
            font-size: 14px;
            line-height: 1.5;
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
            caret-color: #fff;
            z-index: 1;
            resize: none;
            outline: none;
        }
        .spg-editor-pre {
            z-index: 0;
            pointer-events: none;
            color: #abb2bf;
        }
        .line-numbers {
            position: absolute;
            top: 0;
            left: 0;
            width: 3rem;
            height: 100%;
            padding: 1rem 0;
            background: #0d1117;
            border-right: 1px solid #30363d;
            color: #495162;
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
                    className="absolute left-0 right-0 bg-zinc-800/30 pointer-events-none z-0 transition-top duration-75"
                    style={{
                        top: `${(currentLine - 1) * 21 + 16}px`, // 1.5rem line-height (~21px) + 1rem padding (~16px)
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
                    ${error?.line === i + 1 ? 'text-red-500 font-bold bg-red-900/20' : ''}
                    ${currentLine === i + 1 ? 'text-zinc-200' : ''}
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
            <div className="px-4 py-1.5 bg-[#0d1117] border-t border-zinc-800 flex justify-between items-center text-xs text-zinc-500 z-10 select-none">
                <span>Ln {currentLine}, Col {currentCol}</span>
                <span>SPG 1.0</span>
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

const ChatInterface = forwardRef<ChatInterfaceRef, ChatInterfaceProps>(
    ({ initialMessages, onCodeGenerated, onMessagesUpdate, chat }, ref) => {
        const { isProcessing, sendMessage, triggerFix: triggerFixAction } = chat;

        const [input, setInput] = useState('');
        const [messages, setMessages] = useState<Message[]>(initialMessages);
        const messagesEndRef = useRef<HTMLDivElement>(null);
        const isMounted = useRef(true);

        useEffect(() => {
            isMounted.current = true;
            return () => {
                isMounted.current = false;
            };
        }, []);

        const scrollToBottom = () => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        };

        useEffect(() => {
            setMessages(initialMessages);
        }, [initialMessages]);

        useEffect(scrollToBottom, [messages]);

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
                <div className="px-5 py-4 border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md flex items-center justify-between sticky top-0 z-10">
                    <div className="flex items-center gap-2">
                        <SparklesIcon className="w-4 h-4 text-cyan-400" />
                        <h2 className="text-sm font-bold text-zinc-200">AI Assistant</h2>
                    </div>
                    <span className="text-[10px] text-zinc-600 bg-zinc-900 px-2 py-1 rounded border border-zinc-800">AI COMPOSE</span>
                </div>

                {/* Message List */}
                <div className="flex-1 overflow-y-auto p-4 space-y-6">
                    {messages.map((msg, idx) => (
                        <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                            {/* Avatar */}
                            <div
                                className={`
                w-8 h-8 rounded-full flex items-center justify-center shrink-0 border
                ${msg.role === 'user'
                                        ? 'bg-zinc-800 border-zinc-700'
                                        : msg.role === 'system' ? 'bg-transparent border-transparent'
                                            : 'bg-gradient-to-br from-cyan-900 to-blue-900 border-cyan-800'
                                    }
            `}
                            >
                                {msg.role === 'user' && <UserCircleIcon className="w-5 h-5 text-zinc-400" />}
                                {msg.role === 'model' && <CpuChipIcon className="w-5 h-5 text-cyan-300" />}
                            </div>

                            {/* Bubble */}
                            <div
                                className={`
                max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm
                ${msg.role === 'user'
                                        ? 'bg-zinc-800 text-zinc-100 rounded-tr-none border border-zinc-700'
                                        : msg.role === 'system'
                                            ? 'bg-zinc-900/50 text-zinc-500 text-xs italic text-center w-full border border-dashed border-zinc-800'
                                            : 'bg-gradient-to-br from-zinc-800 to-zinc-900 text-zinc-300 rounded-tl-none border border-zinc-800 shadow-md'
                                    }
            `}
                            >
                                {msg.content}
                            </div>
                        </div>
                    ))}

                    {isProcessing && (
                        <div className="flex gap-3">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-900 to-blue-900 border border-cyan-800 flex items-center justify-center shrink-0">
                                <CpuChipIcon className="w-5 h-5 text-cyan-300" />
                            </div>
                            <div className="bg-zinc-900 rounded-2xl rounded-tl-none px-4 py-3 border border-zinc-800 flex items-center gap-2">
                                <span className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce"></span>
                                <span className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce delay-100"></span>
                                <span className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce delay-200"></span>
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* Input Area */}
                <div className="p-4 border-t border-zinc-800 bg-zinc-900/30 backdrop-blur-md">
                    <div className="relative group">
                        <input
                            type="text"
                            value={input}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="描述您想要的声音..."
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-4 pr-12 py-3 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all placeholder:text-zinc-600"
                            disabled={isProcessing}
                        />
                        <button
                            onClick={handleSend}
                            disabled={isProcessing}
                            className={`
                absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-all
                ${isProcessing || !input.trim()
                                    ? 'text-zinc-700'
                                    : 'text-cyan-400 hover:bg-cyan-900/30 hover:text-cyan-300'
                                }
            `}
                        >
                            <PaperAirplaneIcon className="w-5 h-5" />
                        </button>
                    </div>
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

    const tabs: { id: ToolMode; label: string; icon: React.ElementType }[] = [
        { id: 'analyzer', label: '音频透视', icon: ChartBarIcon },
        { id: 'converter', label: '格式转换', icon: ArrowPathRoundedSquareIcon },
        { id: 'fixer', label: '增益修复', icon: WrenchScrewdriverIcon },
    ];

    return (
        <div className="flex flex-col h-full bg-dots-pattern text-zinc-200">
            {/* Header / Tabs */}
            <div className="flex border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md px-6 pt-2 gap-2">
                {tabs.map((tab) => (
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
                    {mode === 'converter' && <ConverterView {...converter} />}
                    {mode === 'analyzer' && <AnalyzerView {...analyzer} />}
                    {mode === 'fixer' && <FixerView {...fixer} />}
                </div>
            </div>
        </div>
    );
};

const ConverterView: React.FC<ConverterProps> = ({ isProcessing, logs, convert }) => (
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
                    <ArrowUpTrayOutlineIcon className="w-5 h-5 text-cyan-500" />
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
            {logs.map((log, i) => (
                <div key={i} className="mb-1 border-l-2 border-zinc-800 pl-2 hover:bg-zinc-900/30">{log}</div>
            ))}
        </div>
    </div>
);

const AnalyzerView: React.FC<AnalyzerProps> = ({ result, analyze }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            analyze(e.target.files[0]);
        }
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
        ctx.fillStyle = '#18181b'; // zinc-900
        ctx.fillRect(0, 0, width, height);

        // Grid lines
        ctx.strokeStyle = '#27272a';
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
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
            ctx.moveTo(i, (1 - max) * amp);
            ctx.lineTo(i, (1 - min) * amp);
        }
        ctx.stroke();
    }, [result]);

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex items-center justify-between bg-zinc-950 p-6 rounded-xl border border-zinc-800">
                <div>
                    <h3 className="text-xl font-bold text-zinc-100">音频分析器</h3>
                    <p className="text-zinc-500 text-sm mt-1">深度解析音频文件的声学特征。</p>
                </div>
                <label className="bg-zinc-100 hover:bg-white text-zinc-900 px-5 py-2.5 rounded-xl cursor-pointer transition-all shadow-lg hover:shadow-xl text-sm font-bold flex items-center gap-2">
                    <ArrowUpTrayOutlineIcon className="w-4 h-4" /> 上传文件
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

const StatCard: React.FC<{ label: string; value: string | number; highlight?: boolean }> = ({ label, value, highlight }) => (
    <div className={`
        p-4 rounded-xl border transition-all hover:-translate-y-1
        ${highlight ? 'bg-zinc-800 border-zinc-700' : 'bg-zinc-950 border-zinc-800'}
    `}>
        <div className="text-[10px] text-zinc-500 mb-1 uppercase tracking-wider font-bold">{label}</div>
        <div className={`text-lg font-mono font-medium ${highlight ? 'text-cyan-400' : 'text-zinc-200'}`}>{value}</div>
    </div>
);

const FixerView: React.FC<FixerProps> = ({ file, gain, isProcessing, setFile, setGain, applyFix }) => (
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
                onClick={applyFix}
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
