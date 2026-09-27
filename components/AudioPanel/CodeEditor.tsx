
/// <reference lib="dom" />
import React, { useRef, useState, useEffect, useMemo } from 'react';
import { ParserError } from '../../meta';

interface CodeEditorProps {
  code: string;
  onChange: (val: string) => void;
  error?: ParserError | null;
}

const CodeEditor: React.FC<CodeEditorProps> = ({ code, onChange, error }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
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
      if (textareaRef.current) {
          const cursorPos = textareaRef.current.selectionStart;
          const textBeforeCursor = textareaRef.current.value.substring(0, cursorPos);
          const line = textBeforeCursor.split('\n').length;
          setCurrentLine(line);
          // 列 = 光标距本行行首的字符数 + 1（1 起）
          const lastNewline = textBeforeCursor.lastIndexOf('\n');
          setCurrentCol(cursorPos - lastNewline);
      }
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
          const newValue = code.substring(0, start) + "  " + code.substring(end);
          onChange(newValue);

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
        { type: 'property', regex: /\b(?:name|tempo|bpm|master_gain|key|scale|swing|instrument|wave|envelope|env|filter|filter_envelope|filter_env_amount|lfo|pan|gain|source|time|at|loop|repeat|stagger|feedback|mix|attack|decay|sustain|release|frequency|freq|Q|amount|target|pattern|rate|duration|dur|strum|voicing|octaves|octave|gate|velocity|vel|accent|transpose|glide|glide_from|detune|humanize|harmonics|voices|unison_spread|spread|pitch_env_amount|pitch_decay|attack_noise|velocity_sensitivity|velocity_to_filter|fm_wave|fm_index|fm_ratio|preset|curve|delay|ramp|swell|sweep|sweep_to|damping|pre_delay|pingpong|bits|depth|threshold|ratio|kind|from|to|low|mid|high|min|max|tune|tone|snap|direction|pitches|chords|notes|beats|beat|times|step|len)\b/ }
    ];

    // 2. 组合正则
    const combinedSource = tokens.map(t => `(${t.regex.source})`).join('|');
    const combinedRegex = new RegExp(combinedSource, 'g');

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
    html += escape(input.slice(lastIndex));
    return html;
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
      <div 
        ref={containerRef}
        className="relative flex-1 overflow-hidden spg-editor-container"
      >
        {/* Active Line Highlight (Background) */}
        <div 
            className="absolute left-0 right-0 bg-zinc-800/30 pointer-events-none z-0 transition-top duration-75"
            style={{ 
                top: `${(currentLine - 1) * 21 + 16}px`, // 1.5rem line-height (~21px) + 1rem padding (~16px)
                height: '21px',
                width: '100%'
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
        <pre 
          ref={preRef}
          className="spg-editor-pre"
          aria-hidden="true"
        >
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

export default CodeEditor;
