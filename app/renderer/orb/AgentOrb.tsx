import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMessage, AgentScript, AgentUsage, HeaderRule, TamperRule } from '../../../shared/meta';
import { exportAgentSession } from '../../../shared/core';
import { OrbShell } from './OrbShell';
import { TerminalIcon } from './icons';
import { droppedHint, HeadersTab, JwtTab, RulesTab, StorageTab } from './AgentTabs';
import {
    agentAction,
    bridge,
    bridgeConnected,
    formatTokens,
    onBridgeEvent,
    onBridgeStatus,
    rewindTo,
} from './bridge-client';
import type { AgentAction, EngineSnapshot } from './bridge-client';

/**
 * 压缩档位候选。
 *
 * 与插件的 `COMPACT_RATIOS`（`agent/prompt.ts`）逐字一致。这里再写一份而不是
 * import：球与插件是两个独立的构建产物，互相 import 会把对方的整个依赖图拖
 * 进来（见 bridge-client.ts 里 AgentAction 那段）。而档位是**用户界面**的事实
 * —— 传一个插件不认的值时引擎直接忽略（`setCompactRatio` 自己校验取值），
 * 不会静默改成别的档位。
 */
const COMPACT_RATIOS = [0.4, 0.6, 0.8, 1] as const;

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
 *
 * ## 六个页签
 *
 * 「对话」「规则」「请求头」「存储」「JWT」「脚本」。后五个不是装饰：
 *
 *  · **脚本**：`script_store` 工具能让模型存下脚本并按 URL 自动执行，而
 *    **只有这个界面能让人看见存了什么、改掉它、或者停掉它**。没有它的话，
 *    模型偷偷装上一个每次打开某站点就自动跑的脚本，用户无从知晓 ——
 *    那既是能力缺失也是安全问题。
 *  · **规则 / 请求头**：模型改的规则立刻生效但不落盘，用户必须能看见它改了什么，
 *    并且能自己写规则（不是所有篡改都值得让模型代劳）。
 *  · **存储 / JWT**：Agent 改页面时最常问的两个问题 —— "这个值到底存在哪"、
 *    "这个 token 里有什么"。不能查就只能反复让模型去读，慢且费上下文。
 *
 * 页签清单与 `新建文件夹/BrowsePanel.tsx` 的 `AGENT_TABS` 一致。
 */

/** 页签清单。顺序即显示顺序：对话在最前，脚本在最后（它是低频的审阅页） */
type AgentTab = 'chat' | 'rules' | 'headers' | 'storage' | 'jwt' | 'scripts';

const AGENT_TABS: { id: AgentTab; label: string }[] = [
    { id: 'chat', label: '对话' },
    { id: 'rules', label: '规则' },
    { id: 'headers', label: '请求头' },
    { id: 'storage', label: '存储' },
    { id: 'jwt', label: 'JWT' },
    { id: 'scripts', label: '脚本' },
];

export const AgentOrb = () => {
    const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
    const [streaming, setStreaming] = useState<{ content: string; reasoning: string } | null>(null);
    const [input, setInput] = useState('');
    const [error, setError] = useState('');
    const [connected, setConnected] = useState(true);
    const [tab, setTab] = useState<AgentTab>('chat');

    /* 篡改规则。**唯一权威在插件**（tamper-get / tamper-set），这里只是它的一个视图 */
    const [rules, setRules] = useState<{ interceptRules: TamperRule[]; requestRules: TamperRule[]; headerRules: HeaderRule[] }>({
        interceptRules: [],
        requestRules: [],
        headerRules: [],
    });
    /** 规则的保存状态。`null` = 还没改过，不显示任何提示 */
    const [rulesSaved, setRulesSaved] = useState<boolean | null>(null);
    /** 当前活动标签页地址。存储页与 JWT 页按它取数据 */
    const [activePage, setActivePage] = useState('');

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

    /**
     * 拉一次篡改规则与当前页面。
     *
     * 只在连上桥之后拉，理由同上面那个快照 effect。**每次切到规则/请求头/
     * 存储/JWT 页时也拉一次** —— 模型可能刚用 `tamper` 工具改过规则，
     * 而那条改动不经桥推事件（它改的是引擎内存，不是 UI 状态）。
     */
    const isDataTab = tab === 'rules' || tab === 'headers' || tab === 'storage' || tab === 'jwt';

    useEffect(() => {
        if (!connected || !isDataTab) return;
        void (async () => {
            try {
                const [res, page] = await Promise.all([
                    bridge<{ rules: { interceptRules: TamperRule[]; requestRules: TamperRule[]; headerRules: HeaderRule[] } }>('tamper-get'),
                    bridge<{ pageUrl: string }>('sniffer-active-page'),
                ]);
                setRules(res.rules);
                setActivePage(page.pageUrl || '');
                setError('');
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        })();
    }, [connected, isDataTab]);

    /**
     * 保存规则（去抖）。
     *
     * ## 为什么必须去抖
     *
     * 输入框是受控的，每敲一个字符就会调到这里。而 `tamper-set` 不只是写一次
     * 存储 —— 它还会 `chrome.scripting.executeScript` 把整个钩子**重新注入页面**。
     * 不去抖的话，打一个 "is_vip" 就是 6 次脚本注入，每敲一下卡一下。
     *
     * 400ms：够短到用户松手就生效，够长到一次连续输入只落一次。
     * 界面**立刻**更新（下面那行 setRules），所以去抖不影响手感。
     */
    const saveTimer = useRef<number | null>(null);

    const saveRules = useCallback((next: typeof rules) => {
        setRules(next);
        setError('');
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
            saveTimer.current = null;
            void (async () => {
                try {
                    const result = await bridge<{ saved: boolean }>('tamper-set', next);
                    setRulesSaved(result.saved);
                    setConnected(true);
                } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                    setRulesSaved(false);
                    setConnected(await bridgeConnected());
                }
            })();
        }, 400);
    }, []);

    /* 卸载时取消在途的保存：球窗口关掉之后那个定时器还会跑一次，而它没有意义 */
    useEffect(() => () => {
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    }, []);

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

    /**
     * 回退到某条消息之前。
     *
     * 把该条的提问填回输入框 —— 用户的意图几乎总是"改一下再问一遍"，
     * 而回退已经把那条连同之后的全部删了。不填回去等于让他凭记忆重打。
     */
    const rewind = useCallback(async (id: string) => {
        setError('');
        try {
            const prompt = await rewindTo(id);
            if (prompt) setInput(prompt);
            setConnected(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setConnected(await bridgeConnected());
        }
    }, []);

    const state = snapshot;
    const busy = state?.status !== 'idle';
    const messages = state?.messages || [];
    const scripts = state?.scripts || [];
    const canEdit = state?.canEdit !== false && !busy;

    /*
     * 页签条。
     *
     * 放在**标题栏下面**而不是塞进标题栏：标题栏只有 440px 宽，六个页签加上
     * 停止/清空/收起会全部挤成单字。独立一行还能给每个页签足够的点击面积。
     */
    const tabBar = (
        <nav className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-white/[0.07] px-1.5 py-1">
            {AGENT_TABS.map((entry) => (
                <button
                    key={entry.id}
                    type="button"
                    onClick={() => setTab(entry.id)}
                    className={`shrink-0 rounded-lg px-2 py-1 text-[10px] font-medium transition ${
                        tab === entry.id
                            ? 'bg-fuchsia-500/20 text-fuchsia-200'
                            : 'text-slate-500 hover:bg-white/[0.06] hover:text-slate-300'
                    }`}
                >
                    {entry.label}
                    {entry.id === 'scripts' && scripts.length > 0 ? ` ${scripts.length}` : ''}
                </button>
            ))}
        </nav>
    );

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
                    : state?.compacting
                        ? '正在压缩上下文…'
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

            {tabBar}

            {tab === 'scripts' && (
                <ScriptList
                    scripts={scripts}
                    busy={busy}
                    onToggle={(id) => void act({ type: 'toggle-script', id })}
                    onRun={(id) => void act({ type: 'run-script', id })}
                    onRemove={(id) => void act({ type: 'remove-script', id })}
                />
            )}

            {tab === 'rules' && (
                <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                    {/*
                      规则不落盘就等于没配 —— 而"引擎会跳过这条"是最容易让人
                      白费功夫的一处：面板显示启用中，页面里什么都没发生。
                      提示条与引擎的丢弃判据共用一份（collectDroppedRules）。
                    */}
                    {droppedHint(rules) && (
                        <div className="mb-2 rounded-lg border border-amber-400/20 bg-amber-500/[0.08] px-2 py-1.5 text-[9px] leading-relaxed text-amber-200">
                            {droppedHint(rules)}
                        </div>
                    )}
                    <RulesTab rules={rules} onChange={saveRules} />
                    <SaveHint saved={rulesSaved} />
                </div>
            )}

            {tab === 'headers' && (
                <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                    {droppedHint(rules) && (
                        <div className="mb-2 rounded-lg border border-amber-400/20 bg-amber-500/[0.08] px-2 py-1.5 text-[9px] leading-relaxed text-amber-200">
                            {droppedHint(rules)}
                        </div>
                    )}
                    <HeadersTab headers={rules.headerRules} onChange={(headerRules) => saveRules({ ...rules, headerRules })} />
                    <SaveHint saved={rulesSaved} />
                </div>
            )}

            {tab === 'storage' && (
                <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                    <StorageTab pageUrl={activePage} />
                </div>
            )}

            {tab === 'jwt' && (
                <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                    <JwtTab pageUrl={activePage} />
                </div>
            )}

            {tab === 'chat' && (
                <>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {messages.length === 0 && !streaming ? (
                            <p className="p-4 text-[11px] leading-relaxed text-slate-500">
                                在已登录的页面里执行脚本。模型可以直接调用页面自己的函数、读带凭证的
                                fetch 结果，并在跨页面导航后继续同一轮任务。
                            </p>
                        ) : (
                            <ul className="divide-y divide-white/5">
                                {messages.map((message) => (
                                    <MessageRow
                                        key={message.id}
                                        message={message}
                                        canEdit={canEdit}
                                        onRemove={() => void act({ type: 'remove-message', id: message.id })}
                                        onRewind={() => void rewind(message.id)}
                                    />
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
                        {/*
                          次要动作放在输入框上方，不占标题栏。
                          标题栏只有 440px 宽，塞进「脚本 / 停止 / 压缩 / 导出 /
                          简洁 / 清空 / 收起」七个按钮会把标签挤到看不见。
                        */}
                        <div className="mb-1.5 flex items-center gap-2 px-0.5">
                            <button
                                type="button"
                                onClick={() => void act({ type: 'compact' })}
                                disabled={busy || state?.compacting || !state?.canCompact}
                                title="把分界线之后的旧消息压成摘要（不可逆，但比清空保留更多）"
                                className="text-[10px] text-slate-500 transition hover:text-slate-300 disabled:opacity-30"
                            >
                                {state?.compacting ? '压缩中…' : '压缩上下文'}
                            </button>
                            <span className="h-3 w-px bg-white/10" />
                            <button
                                type="button"
                                onClick={() => exportAgentSession(messages)}
                                disabled={messages.length === 0}
                                title="导出完整会话（含推理过程）"
                                className="text-[10px] text-slate-500 transition hover:text-slate-300 disabled:opacity-30"
                            >
                                导出
                            </button>
                            <button
                                type="button"
                                onClick={() => exportAgentSession(messages, { includeReasoning: false })}
                                disabled={messages.length === 0}
                                title="导出不含推理过程的版本（适合分享）"
                                className="text-[10px] text-slate-500 transition hover:text-slate-300 disabled:opacity-30"
                            >
                                简洁版
                            </button>
                            <span className="ml-auto shrink-0 font-mono text-[9px] text-slate-600">
                                档位
                            </span>
                            {/*
                              压缩档位：决定"保留最近多少"（0.4 只留四成，1 全留）。
                              它是**用户的选择**而不是模型能改的东西 —— 压缩不可逆，
                              留多少该由人定。所以按钮放在这里而不是让模型调。
                            */}
                            {COMPACT_RATIOS.map((ratio) => (
                                <button
                                    key={ratio}
                                    type="button"
                                    onClick={() => void act({ type: 'set-compact-ratio', ratio })}
                                    disabled={busy || state?.compacting}
                                    className={`shrink-0 rounded px-1 text-[9px] transition disabled:opacity-30 ${
                                        state?.compactRatio === ratio
                                            ? 'bg-fuchsia-500/20 text-fuchsia-200'
                                            : 'text-slate-600 hover:text-slate-300'
                                    }`}
                                >
                                    {ratio}
                                </button>
                            ))}
                        </div>
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
                </>
            )}
        </OrbShell>
    );
};

/* ========================================================================== */
/* 保存提示                                                                    */
/* ========================================================================== */

/**
 * 规则的保存结果。
 *
 * 只有**失败**才值得一直显示。成功那条 2 秒后自己消失 —— 常驻的"已保存"
 * 会让人以为它说的是"当前草稿已保存"，而实际上它说的是"上一次保存成功了"。
 * `saved === null`（还没改过）时什么都不画。
 */
const SaveHint = ({ saved }: { saved: boolean | null }) => {
    const [visible, setVisible] = useState(saved !== null);

    useEffect(() => {
        if (saved === null) return;
        setVisible(true);
        // 失败不自动消失：用户必须看到它，否则会以为规则已经存住了
        if (!saved) return;
        const timer = window.setTimeout(() => setVisible(false), 2000);
        return () => window.clearTimeout(timer);
    }, [saved]);

    if (saved === null || !visible) return null;

    return (
        <p className={`mt-2 text-[9px] ${saved ? 'text-emerald-400/70' : 'text-rose-300'}`}>
            {saved
                ? '已保存并对当前页面生效。'
                : '规则已对当前页面生效，但写入本地存储失败（配额可能已满）—— 重启浏览器后会丢失。'}
        </p>
    );
};

/* ========================================================================== */
/* 消息行                                                                      */
/* ========================================================================== */

const MessageRow = ({
    message,
    canEdit,
    onRemove,
    onRewind,
}: {
    message: AgentMessage;
    canEdit: boolean;
    onRemove: () => void;
    onRewind: () => void;
}) => {
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

    /* 压缩分界线单独画：它既不是模型说的话也不是用户的提问 */
    if (message.compaction) {
        return (
            <li className="bg-white/[0.03] px-3 py-2">
                <div className="mb-1 flex items-center gap-2">
                    <span className="h-px flex-1 bg-white/10" />
                    <span className="text-[9px] text-slate-500">上下文已压缩</span>
                    <span className="h-px flex-1 bg-white/10" />
                </div>
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="text-[9px] text-slate-500 hover:text-slate-300"
                >
                    {expanded ? '收起摘要' : '查看摘要'}
                </button>
                {expanded && (
                    <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[9px] leading-relaxed text-slate-500">
                        {message.compaction.summary}
                    </pre>
                )}
            </li>
        );
    }

    return (
        <li className="group px-3 py-2">
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
                {/*
                  两条历史编辑操作。只在引擎允许时出现（canEdit）：运行中或
                  压缩中改动 messages 会和主循环抢同一个数组，而那个抢法没有
                  正确答案 —— 界面禁用比让用户点了没反应好。
                */}
                {canEdit && (
                    <span className={`${long ? '' : 'ml-auto'} flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100`}>
                        <button
                            type="button"
                            onClick={onRewind}
                            title="回退到这条之前（这条及之后的全部移除），提问会填回输入框"
                            className="text-[9px] text-slate-500 hover:text-amber-300"
                        >
                            回退
                        </button>
                        <button
                            type="button"
                            onClick={onRemove}
                            title="只删这一条"
                            className="text-[9px] text-slate-500 hover:text-rose-300"
                        >
                            删除
                        </button>
                    </span>
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

/* ========================================================================== */
/* 脚本页                                                                      */
/* ========================================================================== */

/**
 * 脚本清单。
 *
 * ## 为什么这个页面必须存在
 *
 * `script_store` 工具让**模型自己**存脚本，而 `urlPattern` 非空的脚本会在
 * 页面就绪时自动执行 —— 也就是说模型可以装上一个"每次打开某站点就自动跑"
 * 的东西。用户必须能看见它、停掉它、删掉它。没有这个页面，那件事就是
 * 完全隐形的，而这既是能力缺失也是安全问题。
 *
 * ## 为什么没有"新建"按钮
 *
 * 脚本由模型写（它才有页面上下文去验证选择器）。手工从零写一段要在页面里跑的
 * 代码，在球这个 440×640 的窗口里做不了，做了也是个更差的编辑器。
 * 用户能做的是**审阅、启停、立刻跑一次、删掉** —— 那正是这里提供的四件事。
 */
const ScriptList = ({
    scripts,
    busy,
    onToggle,
    onRun,
    onRemove,
}: {
    scripts: AgentScript[];
    busy: boolean;
    onToggle: (id: string) => void;
    onRun: (id: string) => void;
    onRemove: (id: string) => void;
}) => {
    const [expanded, setExpanded] = useState('');

    if (scripts.length === 0) {
        return (
            <p className="p-4 text-[11px] leading-relaxed text-slate-500">
                还没有保存的脚本。模型可以用 <code className="font-mono">script_store</code> 把
                验证过的代码存下来，填了 URL 匹配的脚本会在页面打开时自动执行 ——
                存下来的东西都会出现在这里。
            </p>
        );
    }

    return (
        <div className="min-h-0 flex-1 overflow-y-auto">
            <ul className="divide-y divide-white/5">
                {scripts.map((script) => (
                    <li key={script.id} className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                            {/*
                              启停开关。自动执行的脚本靠它停 —— 删掉是另一个决定
                              （下次还想跑就得让模型重写一遍），所以两者分开。
                            */}
                            <button
                                type="button"
                                onClick={() => onToggle(script.id)}
                                disabled={busy}
                                title={script.enabled ? '已启用：URL 命中时自动执行' : '已停用'}
                                className={`h-3.5 w-6 shrink-0 rounded-full transition disabled:opacity-40 ${
                                    script.enabled ? 'bg-emerald-500/70' : 'bg-white/15'
                                }`}
                            >
                                <span
                                    className={`block h-2.5 w-2.5 rounded-full bg-white transition ${
                                        script.enabled ? 'translate-x-3' : 'translate-x-0.5'
                                    }`}
                                />
                            </button>
                            <span className="min-w-0 flex-1 truncate text-[11px] text-slate-200" title={script.description}>
                                {script.name}
                            </span>
                            <button
                                type="button"
                                onClick={() => onRun(script.id)}
                                disabled={busy}
                                title="立刻在当前页面跑一次，结果会进对话"
                                className="shrink-0 text-[9px] text-slate-500 transition hover:text-emerald-300 disabled:opacity-30"
                            >
                                运行
                            </button>
                            <button
                                type="button"
                                onClick={() => onRemove(script.id)}
                                disabled={busy}
                                className="shrink-0 text-[9px] text-slate-500 transition hover:text-rose-300 disabled:opacity-30"
                            >
                                删除
                            </button>
                        </div>

                        {script.urlPattern && (
                            <div className="mt-0.5 truncate font-mono text-[9px] text-slate-600" title={script.urlPattern}>
                                匹配 {script.urlPattern}
                            </div>
                        )}
                        {script.description && (
                            <div className="mt-0.5 text-[9px] leading-relaxed text-slate-500">
                                {script.description}
                            </div>
                        )}

                        <button
                            type="button"
                            onClick={() => setExpanded((v) => (v === script.id ? '' : script.id))}
                            className="mt-0.5 text-[9px] text-slate-500 hover:text-slate-300"
                        >
                            {expanded === script.id ? '收起代码' : '查看代码'}
                        </button>
                        {expanded === script.id && (
                            <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white/[0.03] p-1.5 font-mono text-[9px] leading-relaxed text-slate-400">
                                {script.code}
                            </pre>
                        )}

                        {script.lastResult && (
                            <div className="mt-1 truncate font-mono text-[9px] text-slate-600" title={script.lastResult}>
                                上次：{script.lastResult.slice(0, 120)}
                            </div>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
};

export type { AgentUsage };
