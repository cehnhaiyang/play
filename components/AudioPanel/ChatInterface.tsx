
/// <reference lib="dom" />
import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { Message } from '../../meta';
import { PaperAirplaneIcon, SparklesIcon, UserCircleIcon, CpuChipIcon } from '@heroicons/react/24/solid';

export interface ChatInterfaceRef {
    triggerFix: (code: string, error: string) => Promise<void>;
}

interface ChatInterfaceProps {
  initialMessages: Message[];
  onCodeGenerated: (code: string, isAutoFix?: boolean) => void;
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

const ChatInterface = forwardRef<ChatInterfaceRef, ChatInterfaceProps>(({ initialMessages, onCodeGenerated, onMessagesUpdate, chat }, ref) => {
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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
            timestamp: Date.now() 
        };
        setMessages(prev => [...prev, systemMsg]);

        const result = await triggerFixAction(brokenCode, error);

        if (!isMounted.current) return;

        setMessages(prev => [...prev, result.replyMessage]);
        
        if (result.success && result.code) {
             onCodeGenerated(result.code, true);
        }
    }
  }));

  const handleSend = async () => {
    if (!input.trim() || isProcessing) return;

    const userMsg: Message = { role: 'user', content: input, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');

    const result = await sendMessage(userMsg.content);
    
    if (!isMounted.current) return;

    setMessages(prev => [...prev, result.replyMessage]);
    
    if (result.success && result.code) {
        onCodeGenerated(result.code, false);
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
            <div className={`
                w-8 h-8 rounded-full flex items-center justify-center shrink-0 border
                ${msg.role === 'user' 
                    ? 'bg-zinc-800 border-zinc-700' 
                    : msg.role === 'system' ? 'bg-transparent border-transparent'
                    : 'bg-gradient-to-br from-cyan-900 to-blue-900 border-cyan-800'
                }
            `}>
                {msg.role === 'user' && <UserCircleIcon className="w-5 h-5 text-zinc-400" />}
                {msg.role === 'model' && <CpuChipIcon className="w-5 h-5 text-cyan-300" />}
            </div>

            {/* Bubble */}
            <div className={`
                max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm
                ${msg.role === 'user' 
                  ? 'bg-zinc-800 text-zinc-100 rounded-tr-none border border-zinc-700' 
                  : msg.role === 'system'
                    ? 'bg-zinc-900/50 text-zinc-500 text-xs italic text-center w-full border border-dashed border-zinc-800'
                    : 'bg-gradient-to-br from-zinc-800 to-zinc-900 text-zinc-300 rounded-tl-none border border-zinc-800 shadow-md'
                }
            `}>
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
});

export default ChatInterface;
