/// <reference lib="dom" />
import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    ArchiveBoxArrowDownIcon,
    ArrowLeftIcon,
    ArrowTrendingUpIcon,
    ArrowUpTrayIcon,
    Bars3Icon,
    BeakerIcon,
    ChevronRightIcon,
    CubeIcon,
    ExclamationTriangleIcon,
    HomeIcon,
    MusicalNoteIcon,
    PencilSquareIcon,
    PlayIcon,
    PlusIcon,
    SparklesIcon,
    StopIcon,
    TrashIcon,
} from '@heroicons/react/24/solid';
import {
    ArrowPathRoundedSquareIcon,
    ArrowUpTrayIcon as ArrowUpTrayOutlineIcon,
    ChartBarIcon,
    WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import { AppState, ParserError, Project } from '../../shared/meta';
import { useAudio } from '../hooks';

/**
 * 音频工坊（Sound Particle Studio）。
 *
 * 这个文件是**一个整体**：新建工程时描述 → 生成代码 → 编辑器改代码 →
 * 编译报错 → 自动修复，是一条闭环。闭环上的每一环都要读写同一份「当前工程」，
 * 而工程状态只属于 AudioPanel 里的 useAudio；拆成多个文件后，
 * 子组件只能靠一层层传参或各自再调一次 useAudio 来够到它，
 * 前者接口随需求反复变形，后者每个实例都会新建一个 AudioContext 且从不关闭。
 *
 * 三件事各有独立入口，互不共用容器：
 *   创作 —— 新建工程对话框里写一句描述
 *   迭代 —— 选一份已有的 .spg，在保住原曲的前提下优化，落进新工程
 *   修复 —— 编译失败时自动触发（最多 3 轮），或由状态条上的「立即修复」手动触发
 *
 * 原 AudioPanel/ 目录（index + ChatInterface + CodeEditor + Visualizer +
 * AudioToolbox）全部合并到这里。对话区已随会话容器一起删除。
 *
 * 文件内分区：视觉令牌 → 示波器 → 代码编辑器 → 音频实验室 →
 * 新建工程对话框 → 面板外壳。
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
/** 键盘焦点环：面板内所有可点元素共用，避免各处 focus 表现不一。
    不用 ring-offset —— 面板底色在 slate-950 / zinc-950 之间切换，
    固定的 offset 颜色总会在其中一边露出色差。 */
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70';
const BTN_BASE =
    'inline-flex items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40';
/** 主操作：新建、运行、导出这类"推进流程"的动作 */
const BTN_PRIMARY = `${BTN_BASE} ${FOCUS_RING} bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-lg shadow-cyan-500/25 hover:from-cyan-400 hover:to-blue-400`;
/** 次要操作：与主操作同排但不抢注意力 */
const BTN_GHOST = `${BTN_BASE} ${FOCUS_RING} border border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/20 hover:bg-white/[0.08] hover:text-white`;
/** 小标签：字段名、单位、分区标题共用 */
const LABEL = 'text-[10px] font-bold uppercase tracking-wider text-zinc-500';

/**
 * 拖拽离开时判断"是不是真的离开了这个区域"。
 *
 * 裸写 onDragLeave={() => setDragging(false)} 会在指针移到区域内任意子元素上时
 * 也触发（dragleave 按元素边界派发，进入子元素同样算离开父元素），
 * 表现是高亮边框疯狂闪烁。relatedTarget 仍在本区域内就不算离开。
 */
const handleDragExit = (e: React.DragEvent, onLeave: () => void) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave();
};

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
        <div className={`flex items-end gap-[2px] ${className}`} aria-hidden="true">
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

    /**
     * 同步滚动。
     *
     * 可见的代码是 `pre` 那层，textarea 的字体色是 transparent（只留光标）。
     * 因此两个轴都必须跟着 textarea 走：此前只同步 scrollTop，
     * 拖横向滚动条时 textarea 确实在滚，但滚的是那层看不见的文字，
     * 可见的 pre 纹丝不动 —— 表现为"横向滚动条完全没反应"。
     * 行号槽只吃纵向滚动，横向不参与。
     */
    const handleScroll = () => {
        if (!textareaRef.current) return;
        const { scrollTop, scrollLeft } = textareaRef.current;
        if (preRef.current) {
            preRef.current.scrollTop = scrollTop;
            preRef.current.scrollLeft = scrollLeft;
        }
        if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = scrollTop;
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
                    {error && error.line > 0 && <span className="text-rose-400/90">第 {error.line} 行有错</span>}
                    {error && error.line <= 0 && <span className="text-rose-400/90">运行错误</span>}
                    <span className="text-zinc-600">SPG 1.0</span>
                </span>
            </div>
        </div>
    );
};

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
                        onDragLeave={(e) => handleDragExit(e, () => setIsDragging(false))}
                        onDrop={handleDrop}
                        className={`relative h-64 overflow-hidden rounded-xl border bg-[#0b0f14] transition-colors ${isDragging ? 'border-cyan-400/70' : 'border-white/8'
                            }`}
                    >
                        <canvas ref={canvasRef} className="h-full w-full" />
                        <div className="pointer-events-none absolute left-3 top-3 rounded border border-white/8 bg-black/70 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-cyan-400">
                            波形
                        </div>
                        {isDragging && (
                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 text-sm font-bold text-cyan-300">
                                松开以分析这个文件
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <label
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={(e) => handleDragExit(e, () => setIsDragging(false))}
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
                        onDragLeave={(e) => handleDragExit(e, () => setIsDragging(false))}
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
/*                              新建工程对话框                                */
/* ========================================================================== */

interface CreateProjectDialogProps {
    open: boolean;
    isGenerating: boolean;
    error: string | null;
    onCancel: () => void;
    onSubmit: (description: string) => void;
}

/**
 * 新建工程 = 描述一句话 → 生成 → 进工作台。
 *
 * 生成从对话区挪到了这一步，所以这个框是**唯一**的创作入口：
 * 用户不必先学会"该在哪个框里说什么话"，也不需要为了生成先建一个空工程。
 */
const CreateProjectDialog: React.FC<CreateProjectDialogProps> = ({
    open, isGenerating, error, onCancel, onSubmit,
}) => {
    const [description, setDescription] = useState('');
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // 每次打开都从空白开始：留着上一次的描述会让"再建一个"变成"再生成同一首"
    useEffect(() => {
        if (!open) return;
        setDescription('');
        inputRef.current?.focus();
    }, [open]);

    // Esc 关闭。生成中不关 —— 请求已经发出去了，关掉只会让用户以为取消了
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !isGenerating) onCancel();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [open, isGenerating, onCancel]);

    if (!open) return null;

    const submit = () => {
        if (isGenerating || !description.trim()) return;
        onSubmit(description);
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
            onMouseDown={(e) => { if (e.target === e.currentTarget && !isGenerating) onCancel(); }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label="新建工程"
                className="w-full max-w-lg rounded-2xl border border-white/10 bg-zinc-900 p-6 shadow-2xl shadow-black/60"
            >
                <div className="mb-1 flex items-center gap-2">
                    <SparklesIcon className="w-4 h-4 text-cyan-300" />
                    <h2 className="text-base font-bold text-zinc-100">想做什么曲子？</h2>
                </div>
                <p className="mb-4 text-xs text-zinc-500">
                    描述越具体越好：乐器、速度、调性、情绪、段落。AI 会写出可编译的 SPG 代码并直接试听。
                </p>

                <textarea
                    ref={inputRef}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    onKeyDown={(e) => {
                        // Ctrl/Cmd+Enter 提交（与工作区的运行快捷键一致），
                        // 裸 Enter 留给换行 —— 描述常常要写好几行
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                            e.preventDefault();
                            submit();
                        }
                    }}
                    rows={4}
                    disabled={isGenerating}
                    placeholder={'例如：一段 62BPM 的 C 小调钢琴独奏，左手琶音铺底，\n右手旋律克制，末段留白，加一点混响。'}
                    className={`w-full resize-none rounded-xl border border-white/10 bg-black/40 px-3.5 py-3 text-[13px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 transition focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/25 disabled:opacity-60 ${FOCUS_RING}`}
                />

                {error && (
                    <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
                        {error}
                    </p>
                )}

                <div className="mt-5 flex items-center justify-end gap-3">
                    <button
                        onClick={onCancel}
                        disabled={isGenerating}
                        className={`${BTN_GHOST} px-4 py-2.5 text-[13px] disabled:opacity-50`}
                    >
                        取消
                    </button>
                    <button
                        onClick={submit}
                        disabled={isGenerating || !description.trim()}
                        className={`${BTN_PRIMARY} px-4 py-2.5 text-[13px]`}
                    >
                        {isGenerating ? (
                            <>
                                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                                正在作曲…
                            </>
                        ) : (
                            <>
                                <SparklesIcon className="w-4 h-4" /> 开始创作
                            </>
                        )}
                    </button>
                </div>
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
    const [createOpen, setCreateOpen] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    // --- Workspace Logic ---

    // 自动修复的最大尝试次数，防止模型反复给出同样错误的代码时无限循环
    const MAX_AUTO_FIX = 3;
    /**
     * 自动修复尝试次数。
     *
     * 这个数此前存在两处：这里的 `fixAttemptRef`（异步逻辑读它）与 useAudio 的
     * `autoFixCount`（界面读它），而只有后者会被 `audioActions.reset()` 清掉。
     * 于是"A 项目卡在 3 次"之后切到 B 项目，界面显示"修复 0/3"、
     * 内部却仍是 3 —— 下一次自动修复直接判定超限放弃，一次都不试。
     *
     * 现在两者只由 setFixAttempts 写入，工作区重置时一并归零。
     * ref 仍是逻辑上的权威（异步回调里读 state 会拿到闭包旧值），
     * state 仅用于触发重渲染。
     */
    const fixAttemptRef = useRef(0);

    const setFixAttempts = useCallback((attempts: number) => {
        fixAttemptRef.current = attempts;
        audioActions.setAutoFixCount(attempts);
    }, [audioActions]);

    /** 工作区重置：引擎、报错、提示与修复计数必须一起归零，否则会互相矛盾 */
    const resetWorkspace = useCallback(() => {
        setFixAttempts(0);
        audioActions.reset();
    }, [audioActions, setFixAttempts]);

    // --- Handlers ---

    /**
     * 用一句话建工程：生成、命名、落盘全在 createProject 里，
     * 这里只管界面状态（进工作区、收起侧栏、就地显示失败原因）。
     */
    const handleCreateProject = useCallback(async (description: string) => {
        audioActions.stop();
        resetWorkspace();
        setCreateError(null);

        const result = await audioActions.createProject(description);
        if (!result.success) {
            setCreateError(result.message || '生成失败，请重试。');
            return;
        }

        setCreateOpen(false);
        setView('workspace');
        if (window.innerWidth < 768) setIsSidebarOpen(false);
    }, [audioActions, resetWorkspace]);

    const handleOpenProject = useCallback((id: string) => {
        if (activeProjectId === id && view === 'workspace') return;

        resetWorkspace();
        audioActions.setActiveProjectId(id);
        setView('workspace');

        if (window.innerWidth < 768) setIsSidebarOpen(false);
    }, [activeProjectId, audioActions, resetWorkspace, view]);

    const handleDeleteProject = useCallback((e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        if (window.confirm('确定要删除这个项目吗？此操作无法撤销。')) {
            audioActions.deleteProject(id);
            if (activeProjectId === id) {
                audioActions.stop();
                resetWorkspace();
                setView('dashboard');
            }
        }
    }, [activeProjectId, audioActions, resetWorkspace]);

    const handleSwitchToLab = useCallback(() => {
        audioActions.stop();
        resetWorkspace();
        setView('lab');
    }, [audioActions, resetWorkspace]);

    /**
     * 编译并试听；autoFix 时失败就自动修复，修好再试，最多 MAX_AUTO_FIX 轮。
     *
     * 写成**一个循环**而不是互相递归（原来是 compile → 对话区 ref → 回调 → compile）：
     * 中间那层 ref 是对话区才需要的转发，会话容器删掉后它没有存在理由，
     * 而递归版本的终止条件散在两个函数里，改一处就会漏。
     *
     * 尝试次数只由 fixAttemptRef 记账（见上），循环里每轮读它决定是否放弃。
     */
    const handleCompileAndPlay = useCallback(async (
        sourceCode: string,
        options: { autoFix?: boolean } = {}
    ) => {
        const { autoFix = false } = options;
        let code = sourceCode;

        for (; ;) {
            const result = await audioActions.compileAndPlay(code);

            if (result.success) {
                setFixAttempts(0);
                return;
            }

            if (!autoFix || !result.error) return;

            if (fixAttemptRef.current >= MAX_AUTO_FIX) {
                audioActions.setParserError({
                    message: `${result.error.message}（已自动修复 ${MAX_AUTO_FIX} 次仍未通过，请手动检查代码）`,
                    line: result.error.line,
                });
                setFixAttempts(0);
                return;
            }

            setFixAttempts(fixAttemptRef.current + 1);
            const fixed = await audioActions.triggerFix(code, result.error.message);

            if (!fixed.success || !fixed.code) {
                // 修复通道自己失败了（网络/服务不可用）：把原因报出来并停下，
                // 继续循环只会拿同一份代码反复撞同一个错
                audioActions.setParserError({
                    message: fixed.message || '自动修复失败，请手动检查代码。',
                    line: result.error.line,
                });
                setFixAttempts(0);
                return;
            }

            code = fixed.code;
            audioActions.updateActiveProject({ code });
        }
    }, [audioActions, setFixAttempts]);

    const handleManualFix = useCallback(async () => {
        if (!parserError || !activeProject) return;

        setFixAttempts(1);
        const fixed = await audioActions.triggerFix(activeProject.code, parserError.message);

        if (!fixed.success || !fixed.code) {
            audioActions.setParserError({
                message: fixed.message || '自动修复失败，请手动检查代码。',
                line: parserError.line,
            });
            return;
        }

        audioActions.updateActiveProject({ code: fixed.code });
        handleCompileAndPlay(fixed.code, { autoFix: true });
    }, [activeProject, audioActions, handleCompileAndPlay, parserError, setFixAttempts]);

    const handleExportBundle = useCallback(() => {
        if (activeProject) {
            audioActions.exportBundle(activeProject.name, activeProject.code);
        }
    }, [activeProject, audioActions]);

    /**
     * 导入与迭代共用的取件步骤：弹系统文件框，初始目录固定为项目根的 .spg。
     *
     * 两条路径的取件方式完全一样（同一目录、同一后缀过滤、同一读文件逻辑），
     * 差别只在拿到源码之后干什么 —— 所以取件抽在这里，落点各自保留。
     * 取件失败要说出来：用户点的是按钮，静默返回就是"点了没反应"。
     */
    const pickSpgSource = useCallback(async () => {
        audioActions.stop();
        const { source, message } = await audioActions.pickSpgSource();
        if (message) {
            audioActions.setParserError({ message, line: 0 });
            return null;
        }
        return source ?? null;
    }, [audioActions]);

    const handleFileImport = useCallback(async () => {
        const source = await pickSpgSource();
        if (!source) return;

        audioActions.importProjectFromFile(source, () => {
            setView('workspace');
            resetWorkspace();
        });
    }, [audioActions, pickSpgSource, resetWorkspace]);

    /**
     * 迭代优化一份 .spg 目录里的源码。
     *
     * 与"导入 .spg"是两个入口，不合并：导入是"把这份代码放进工作台"，
     * 迭代是"让 AI 在它基础上改一版"。合并的话，用户想迭代一份还没进工程的
     * 文件就得先导入、再找按钮，中间还多出一个他自己不会去用的工程。
     *
     * 优化结果进新工程（原稿不受影响），所以这里也直接切到工作区。
     */
    const handleRefineImport = useCallback(async () => {
        const source = await pickSpgSource();
        if (!source) return;

        resetWorkspace();
        const result = await audioActions.refineSpg(source);

        if (result.success && result.code) {
            setView('workspace');
            handleCompileAndPlay(result.code, { autoFix: true });
            return;
        }

        // 失败必须说出来：迭代要等模型跑完，界面只是按钮转圈，
        // 不报错的话用户看到的就是"点了一下，什么都没发生"
        audioActions.setParserError({ message: result.message || '迭代优化失败', line: 0 });
    }, [audioActions, handleCompileAndPlay, pickSpgSource, resetWorkspace]);

    /**
     * 工作区快捷键。
     *
     * Ctrl/Cmd+Enter 运行是这类工具最通用的约定（VS Code、Jupyter 同款），
     * 而此前运行只能靠鼠标点工具栏。Esc 退出当前工程回到概览，
     * 与"返回浏览"按钮同义。
     *
     * 输入框 / 编辑器里不拦：Ctrl+Enter 在 textarea 中同样应该触发运行，
     * 所以只对 Esc 做焦点判断 —— 在输入框按 Esc 的意图是"取消输入"，
     * 不该把整个工程关掉。
     */
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (view !== 'workspace' || !activeProject) return;

            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                handleCompileAndPlay(activeProject.code);
                return;
            }

            if (e.key === 'Escape') {
                const el = document.activeElement;
                const typing =
                    el instanceof HTMLInputElement ||
                    el instanceof HTMLTextAreaElement ||
                    (el instanceof HTMLElement && el.isContentEditable);
                if (typing) return;
                setView('dashboard');
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [view, activeProject, handleCompileAndPlay]);

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
                        <button
                            onClick={handleRefineImport}
                            disabled={audioState.isRefining}
                            title="选一份 .spg 目录里的作品，让 AI 在保住原曲风格的前提下优化一版"
                            className={`${BTN_GHOST} px-4 py-2.5 text-[13px] disabled:opacity-50`}
                        >
                            {audioState.isRefining ? (
                                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/25 border-t-cyan-300" />
                            ) : (
                                <ArrowTrendingUpIcon className="w-4 h-4" />
                            )}
                            {audioState.isRefining ? '优化中…' : '迭代优化'}
                        </button>
                        <button onClick={handleFileImport} className={`${BTN_GHOST} px-4 py-2.5 text-[13px]`}>
                            <ArrowUpTrayIcon className="w-4 h-4" /> 导入 .spg
                        </button>
                        <button onClick={() => setCreateOpen(true)} className={`${BTN_PRIMARY} px-4 py-2.5 text-[13px]`}>
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
                        onClick={() => setCreateOpen(true)}
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
                                // 入场按索引错开，列表越长越像"依次落位"而不是整块闪出
                                style={{ '--spg-delay': `${Math.min(index, 8) * 45}ms` } as React.CSSProperties}
                                className={`spg-rise group relative flex h-[248px] flex-col overflow-hidden rounded-2xl border bg-white/[0.03] p-5 transition-all hover:-translate-y-1 hover:border-cyan-400/40 hover:shadow-2xl hover:shadow-cyan-950/40 focus-within:border-cyan-400/40 ${isActive ? 'border-cyan-400/40' : 'border-white/8'
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
                                        {/* z-20：压在下面那张铺满卡片的"打开"按钮之上，否则点不到 */}
                                        <button
                                            onClick={(e) => handleDeleteProject(e, project.id)}
                                            // 触屏没有 hover，删除键不能只在 hover 时出现（同 .tp-row-action 的教训）
                                            className="relative z-20 rounded-lg p-1.5 text-zinc-600 opacity-100 transition hover:bg-rose-500/15 hover:text-rose-300 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                                            title="删除项目"
                                        >
                                            <TrashIcon className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>

                                {/* 铺满整张卡片的按钮：让卡片本身可以 Tab 到、回车打开。
                                    用 after:absolute after:inset-0 而不是把整个卡片做成 button ——
                                    卡片里还有删除按钮，button 嵌套 button 是非法 HTML。
                                    指针光标由根节点的 .spg-root 统一补（见 index.css）。 */}
                                <button
                                    onClick={() => handleOpenProject(project.id)}
                                    className={`${FOCUS_RING} truncate text-left text-base font-bold text-zinc-100 transition-colors after:absolute after:inset-0 after:content-[''] group-hover:text-cyan-200`}
                                >
                                    {project.name}
                                </button>

                                <div className="mt-3 flex-1 min-h-0">
                                    <ProjectGlyph seed={project.id} className="h-full max-h-16" />
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

                                {/* 右半边原来显示"N 条对话"，会话容器删掉后没有对应物了。
                                    卡片上方那排标签已经说明"这是个什么曲子"，不再补位占满 */}
                                <div className="mt-3 border-t border-white/8 pt-3 text-[11px] text-zinc-500">
                                    {relativeTime(project.lastModified)}
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
                    onClick={() => setCreateOpen(true)}
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

        const isPlaying = appState === AppState.PLAYING;
        const isExporting = appState === AppState.EXPORTING_AUDIO;
        const summary = summarizeCode(activeProject.code);

        return (
            <div className="flex-1 flex flex-col min-w-0 bg-slate-950 h-full">
                {/* Workspace Header */}
                <header className="h-14 border-b border-white/8 bg-zinc-950/80 backdrop-blur-xl flex items-center px-4 justify-between gap-4 shrink-0 z-10">
                    <div className="flex items-center gap-3 min-w-0">
                        <button
                            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                            title={isSidebarOpen ? '收起侧栏' : '展开侧栏'}
                            className={`rounded-lg p-2 transition-colors ${FOCUS_RING} ${!isSidebarOpen ? 'bg-white/8 text-white' : 'text-zinc-400 hover:bg-white/8 hover:text-white'
                                }`}
                        >
                            <Bars3Icon className="w-5 h-5" />
                        </button>
                        <div className="h-6 w-px bg-white/10" />
                        <div className="group relative flex items-center gap-2 min-w-0">
                            <input
                                aria-label="项目名称"
                                className="bg-transparent border-b border-transparent hover:border-white/15 focus:border-cyan-400 focus:outline-none text-sm font-bold text-zinc-100 w-48 transition-colors px-1"
                                value={activeProject.name}
                                onChange={(e) => audioActions.updateActiveProject({ name: e.target.value })}
                            />
                            <PencilSquareIcon className="w-3.5 h-3.5 shrink-0 text-zinc-600 group-hover:text-zinc-400" />
                        </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                        {/* 源码摘要：回答"这个工程现在是什么状态"，比只看运行状态更有信息量 */}
                        <div className="hidden items-center gap-2 lg:flex">
                            {summary.tempo !== null && (
                                <span className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 font-mono text-[10px] text-zinc-400">
                                    {summary.tempo} BPM
                                </span>
                            )}
                            <span className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 font-mono text-[10px] text-zinc-400">
                                {summary.lines} 行
                            </span>
                        </div>

                        {/* Status Indicators */}
                        {parserError ? (
                            <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-rose-950/40 border border-rose-500/30">
                                <span className="flex items-center gap-1.5 font-mono text-xs font-medium text-rose-300" title={parserError.message}>
                                    <span className="relative flex h-2 w-2">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500" />
                                    </span>
                                    {/* line 0 表示错误与具体某行无关（如导出超时），
                                        此时报"第 0 行出错"会把用户引到一行不存在的代码上 */}
                                    {parserError.line > 0 ? `第 ${parserError.line} 行出错` : '导出失败'}
                                </span>
                                {autoFixCount > 0 && parserError.line > 0 && (
                                    <span className="font-mono text-[10px] text-amber-400" title="自动修复尝试次数">
                                        修复 {autoFixCount}/{MAX_AUTO_FIX}
                                    </span>
                                )}
                                {/* 只有语法错误才谈得上"修复"：导出超时、环境不支持这类
                                    错误交给模型，只会让它去改一段本身没问题的代码 */}
                                {parserError.line > 0 && (
                                    <>
                                        <div className="h-4 w-px bg-rose-500/30" />
                                        <button
                                            onClick={handleManualFix}
                                            className="flex items-center gap-1 text-xs font-bold text-rose-200 transition-colors hover:text-white"
                                        >
                                            <SparklesIcon className="w-3 h-3" /> 立即修复
                                        </button>
                                    </>
                                )}
                            </div>
                        ) : (
                            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors ${isPlaying ? 'bg-emerald-950/40 border-emerald-500/30' : 'bg-white/[0.03] border-white/8'
                                }`}>
                                <span className="relative flex h-2 w-2">
                                    {isPlaying && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
                                    <span className={`relative inline-flex rounded-full h-2 w-2 ${isPlaying ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                                </span>
                                <span className={`font-mono text-xs font-medium ${isPlaying ? 'text-emerald-300' : 'text-zinc-500'}`}>
                                    {isPlaying ? '播放中' : '就绪'}
                                </span>
                            </div>
                        )}

                        {/* 编译提示：代码能跑，但有些东西大概率不是作者本意 */}
                        {compileWarnings.length > 0 && (
                            <div
                                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-950/40 border border-amber-500/30 cursor-help"
                                title={compileWarnings.map((w) => `第 ${w.line} 行: ${w.message}`).join('\n')}
                            >
                                <ExclamationTriangleIcon className="w-3.5 h-3.5 text-amber-400" />
                                <span className="text-xs font-medium text-amber-300">
                                    {compileWarnings.length} 条提示
                                </span>
                            </div>
                        )}

                        {/* Toolbar Actions */}
                        <div className="flex items-center gap-1 rounded-xl border border-white/8 bg-white/[0.03] p-1">
                            {isPlaying ? (
                                <button
                                    onClick={audioActions.stop}
                                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-rose-300 transition-colors hover:bg-rose-500/15 hover:text-rose-200"
                                    title="停止"
                                >
                                    <StopIcon className="w-4 h-4" /> 停止
                                </button>
                            ) : (
                                <button
                                    onClick={() => handleCompileAndPlay(activeProject.code)}
                                    disabled={isExporting}
                                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-emerald-300 transition-colors hover:bg-emerald-500/15 hover:text-emerald-200 disabled:opacity-50"
                                    title="编译并试听（Ctrl+Enter）"
                                >
                                    <PlayIcon className="w-4 h-4" /> 运行
                                </button>
                            )}
                            <div className="w-px h-5 bg-white/10" />
                            <button
                                onClick={handleExportBundle}
                                disabled={isExporting}
                                title="导出为 WAV 音频"
                                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-cyan-300 transition-colors hover:bg-cyan-500/15 hover:text-cyan-200 disabled:opacity-50"
                            >
                                {isExporting ? (
                                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-cyan-300" />
                                ) : (
                                    <ArchiveBoxArrowDownIcon className="w-4 h-4" />
                                )}
                                导出
                            </button>
                        </div>
                    </div>
                </header>

                {/* 工作区：示波器 + 编辑器。原来左边那栏是对话区，
                    现在创作、迭代、修复各自有独立入口，会话容器不再承担任何职责 */}
                <div className="flex-1 flex overflow-hidden p-4">
                    <div className="flex-1 flex flex-col gap-4 min-w-0">
                        {/* Visualizer (Fixed Height) */}
                        <div className="h-44 shrink-0 rounded-2xl overflow-hidden border border-white/8 shadow-2xl shadow-black/40 relative group">
                            <div className="absolute top-2.5 left-3 z-20 flex items-center gap-2 pointer-events-none">
                                <span className={`${LABEL} font-mono text-cyan-400/80`}>示波器</span>
                                {isPlaying && (
                                    <span className="flex items-center gap-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">
                                        <span className="h-1 w-1 rounded-full bg-emerald-400" />
                                        实时
                                    </span>
                                )}
                            </div>
                            <Visualizer analyser={analyser} isActive={isPlaying} />
                        </div>

                        {/* Editor (Flex fill) */}
                        <div className="flex-1 min-h-0 rounded-2xl overflow-hidden border border-white/8 shadow-2xl shadow-black/40 bg-[#0b0f14] flex flex-col">
                            <div className="h-9 bg-white/[0.03] border-b border-white/8 flex items-center justify-between px-3 shrink-0">
                                <span className="flex items-center gap-2 font-mono text-xs text-zinc-400">
                                    <span className="h-2 w-2 rounded-full bg-cyan-400/60" />
                                    script.spg
                                </span>
                                {parserError && parserError.line > 0 && (
                                    <span className="font-mono text-[10px] text-rose-400/90">
                                        编译失败
                                    </span>
                                )}
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
            <header className="h-14 border-b border-white/8 bg-zinc-950/80 backdrop-blur-md flex items-center px-4 gap-3 shrink-0">
                <button
                    onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                    title={isSidebarOpen ? '收起侧栏' : '展开侧栏'}
                    className={`rounded-lg p-2 text-zinc-400 transition-colors hover:bg-white/8 hover:text-white ${FOCUS_RING}`}
                >
                    <Bars3Icon className="w-5 h-5" />
                </button>
                <div className="h-6 w-px bg-white/10" />
                <BeakerIcon className="w-4 h-4 text-cyan-400" />
                <span className="text-sm font-bold tracking-wide text-zinc-100">音频实验室</span>
                <span className="text-[11px] text-zinc-500">格式转换 · 波形分析 · 增益修复</span>
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
        <div className="spg-root h-full w-full bg-black text-zinc-100 flex flex-col font-sans selection:bg-cyan-500/30 overflow-hidden">
            {/* Main Container */}
            {view === 'dashboard' ? renderDashboard() : (
                <div className="flex-1 flex overflow-hidden h-full">
                    {renderSidebar()}
                    {view === 'workspace' ? renderWorkspace() : renderLab()}
                </div>
            )}

            <CreateProjectDialog
                open={createOpen}
                isGenerating={audioState.isGenerating}
                error={createError}
                onCancel={() => setCreateOpen(false)}
                onSubmit={handleCreateProject}
            />
        </div>
    );
};
