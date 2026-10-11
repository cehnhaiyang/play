import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentMessage, AgentUsage } from '../../../shared/meta';
import { OrbShell } from './OrbShell';
import { TerminalIcon } from './icons';
import { agentAction, bridge, bridgeConnected, formatTokens, onBridgeEvent, onBridgeStatus } from './bridge-client';
import type { AgentAction, EngineSnapshot } from './bridge-client';

/**
 * Agent 球。
 *
 * ## 它只是一个视图
 *
 * 引擎（对话历史、主循环、工具派发）在插件的 service worker 里，模型调用在
 * offscreen 文档里，页面执行在 chrome.debugger 上。这个窗口做三件事：
 *
 *   1. 把用户输入转成 `agent-action` 桥请求；
 *   2. 订阅 `agent-snapshot` 与 `agent-delta`，把引擎状态画出来；
 *   3. 显示插件连没连上。
 *
 * ## 为什么不做乐观更新
 *
 * 用户点了"发送"，本地**不**先把这条消息插进列表，而是等引擎推回快照。
 * 乐观更新在这里会撒谎：引擎可能因为 `contextFull` 或 `busy` 直接拒绝，
 * 那条消息就永远停在界面上，而引擎根本没收到。
 *
 * 流式增量是唯一的例外（它逐字到达，等快照太慢），但那也是引擎推来的。
 *
 * ## 快照是权威，增量只是加速
 *
 * `agent-delta` 用来让文字实时滚起来，`agent-snapshot` 才是真值。所以每收到
 * 一次快照就丢掉本地累积的增量 —— 两者叠加会让文字重复一遍。
 */

export const AgentOrb = () => {
    const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
    const [streaming, setStreaming] = useState<{ content: string; reasoning: string } | null>(null);
    const [input, setInput] = useState('');
    const [error, setError] = useState('');
    const [connected, setConnected] = useState(true);

    /* 桥的连接状态：查一次，之后跟着推送走。理由见 SniffOrb 同名那段 */
    useEffect(() => {
        void (async () => setConnected(await bridgeConnected()))();
        return onBridgeStatus(setConnected);
    }, []);

    /*
     * 拿一次当前快照：球可能刚开，而引擎早就跑过好几轮了。
     *
     * 连上桥之后再取，理由见 SniffOrb 同名那段 —— 应用先起时挂载那一刻
     * 必然失败，那条错误要能被后续成功清掉。
     */
    useEffect(() => {
        if (!connected) return;
        void (async () => {
            try {
                const res = await bridge<{ snapshot: EngineSnapshot }>('agent-snapshot');
                setSnapshot(res.snapshot);
                setError('');
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        })();
    }, [connected]);

    useEffect(() => onBridgeEvent((event, payload) => {
        if (event === 'agent-snapshot') {
            setSnapshot(payload as EngineSnapshot);
            // 快照是权威：它已经含了定稿内容，本地累积的增量必须丢掉
            setStreaming(null);
            return;
        }
        if (event === 'agent-delta') {
            const delta = payload as { content?: string; reasoning?: string };
            setStreaming((prev) => ({
                content: (prev?.content || '') + (delta.content || ''),
                reasoning: (prev?.reasoning || '') + (delta.reasoning || ''),
            }));
        }
    }), []);

    /** 发一个动作给引擎 */
    const act = useCallback(async (action: AgentAction): Promise<unknown> => {
        setError('');
        try {
            const result = await agentAction(action);
            setConnected(true);
            return result;
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setConnected(await bridgeConnected());
            return null;
        }
    }, []);

    const send = useCallback(() => {
        const text = input.trim();
        if (!text) return;
        // 立刻清空输入框：引擎会推回快照，那条消息随后出现在列表里。
        // 不清空的话用户会以为没发出去而再点一次。
        setInput('');
        void act({ type: 'send', prompt: text });
    }, [act, input]);

    const state = snapshot;
    const busy = state?.status !== 'idle';
    const messages = state?.messages || [];

    const toolbar = (
        <>
            {busy && (
                <button
                    type="button"
                    onClick={() => void act({ type: 'stop' })}
                    className="shrink-0 rounded-lg bg-rose-500/20 px-2 py-1 text-[10px] font-bold text-rose-300 transition hover:bg-rose-500/30"
                >
                    停止
                </button>
            )}
            <button
                type="button"
                onClick={() => void act({ type: 'clear' })}
                disabled={busy || messages.length === 0}
                className="shrink-0 rounded-lg px-2 py-1 text-[10px] text-slate-500 transition hover:text-slate-300 disabled:opacity-30"
            >
                清空
            </button>
        </>
    );

    return (
        <OrbShell
            label="Agent"
            hint={
                !connected
                    ? '插件未连接'
                    : busy
                        ? '正在执行…'
                        : `上下文 ${formatTokens(state?.usage)}`
            }
            accent="from-fuchsia-500 via-purple-500 to-indigo-500"
            icon={<TerminalIcon className="h-6 w-6" />}
            toolbar={toolbar}
        >
            {!connected && (
                <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[10px] leading-relaxed text-amber-300">
                    没有连上浏览器插件。请确认：① 浏览器已打开；② 扩展已加载；
                    ③ 已跑过 <code className="font-mono">npm run host:install</code> 并重启过浏览器。
                </div>
            )}

            {/* 两条横幅说同一件事，只留一条。理由见 SniffOrb 同名那段 */}
            {error && connected && (
                <div className="shrink-0 border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[10px] leading-relaxed text-rose-300">
                    {error}
                </div>
            )}

            {state?.error && !error && (
                <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[10px] leading-relaxed text-amber-300">
                    {state.error}
                </div>
            )}

            {state?.contextFull && (
                <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[10px] leading-relaxed text-amber-300">
                    上下文已满，必须先压缩或清空才能继续。
                </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
                {messages.length === 0 && !streaming ? (
                    <p className="p-4 text-[11px] leading-relaxed text-slate-500">
                        在已登录的页面里执行脚本。模型可以直接调用页面自己的函数、读带凭证的
                        fetch 结果，并在跨页面导航后继续同一轮任务。
                    </p>
                ) : (
                    <ul className="divide-y divide-white/5">
                        {messages.map((message) => (
                            <MessageRow key={message.id} message={message} />
                        ))}
                    </ul>
                )}

                {streaming && (streaming.content || streaming.reasoning) && (
                    <div className="border-t border-white/5 px-3 py-2">
                        {streaming.reasoning && (
                            <pre className="mb-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[9px] leading-relaxed text-slate-500">
                                {streaming.reasoning}
                            </pre>
                        )}
                        {streaming.content && (
                            <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-slate-300">
                                {streaming.content}
                            </pre>
                        )}
                    </div>
                )}
            </div>

            <div className="shrink-0 border-t border-white/10 p-2">
                <div className="flex items-end gap-1.5">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            // Enter 发送，Shift+Enter 换行。与聊天界面一致；
                            // 不拦 IME 组合中的 Enter，否则中文输入法选词会误发。
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                send();
                            }
                        }}
                        rows={2}
                        placeholder="Enter 发送，Shift+Enter 换行"
                        disabled={busy || state?.contextFull}
                        className="min-h-0 flex-1 resize-none rounded-xl border border-white/10 bg-slate-950/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-white/25 disabled:opacity-50"
                    />
                    <button
                        type="button"
                        onClick={send}
                        disabled={busy || !input.trim() || state?.contextFull}
                        className="shrink-0 rounded-xl bg-indigo-500 px-3 py-2 text-[11px] font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        发送
                    </button>
                </div>
            </div>
        </OrbShell>
    );
};

/* ========================================================================== */
/* 消息行                                                                      */
/* ========================================================================== */

const MessageRow = ({ message }: { message: AgentMessage }) => {
    const [expanded, setExpanded] = useState(false);

    const tone = useMemo(() => {
        if (message.role === 'user') return 'text-slate-200';
        if (message.role === 'assistant') return 'text-slate-300';
        return message.ok === false ? 'text-rose-300' : 'text-emerald-300';
    }, [message]);

    const badge = message.origin
        ? message.origin === 'manual' ? '手动' : '自动'
        : message.label || message.tool || message.role;

    /*
     * 折叠长结果。
     *
     * 工具返回值动辄几 KB，全展开会把对话冲得没法看。但**不能截断** ——
     * 用户排查时正要看那段原文，所以给一个展开开关而不是切片。
     */
    const body = message.result || message.content;
    const long = body.length > 400;
    const shown = expanded || !long ? body : `${body.slice(0, 400)}…`;

    return (
        <li className="px-3 py-2">
            <div className="mb-0.5 flex items-center gap-1.5">
                <span className="rounded bg-white/10 px-1 py-0.5 font-mono text-[9px] text-slate-400">
                    {badge}
                </span>
                {message.usage && (
                    <span className="font-mono text-[9px] text-slate-600">
                        {message.usage.totalTokens} tok
                    </span>
                )}
                {long && (
                    <button
                        type="button"
                        onClick={() => setExpanded((v) => !v)}
                        className="ml-auto text-[9px] text-slate-500 hover:text-slate-300"
                    >
                        {expanded ? '收起' : '展开'}
                    </button>
                )}
            </div>

            {message.reasoning && expanded && (
                <pre className="mb-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white/[0.03] p-1.5 font-mono text-[9px] leading-relaxed text-slate-500">
                    {message.reasoning}
                </pre>
            )}

            <pre className={`whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed ${tone}`}>
                {shown}
            </pre>

            {message.script && expanded && (
                <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white/[0.03] p-1.5 font-mono text-[9px] leading-relaxed text-slate-500">
                    {message.script}
                </pre>
            )}
        </li>
    );
};

export type { AgentUsage };
