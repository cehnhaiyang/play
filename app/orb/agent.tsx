import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentMessage, AgentUsage, CookieItem, HeaderRule, TamperRule } from '../../shared/meta';
import {
    buildCookieData,
    collectDroppedRules,
    decodeJwt,
    exportAgentSession,
    findCookieByKey,
    isFieldRuleDropped,
    isHeaderRuleDropped,
    pickJwtCandidates,
    ruleTargetKey,
} from '../../shared/core';
import {
    agentAction,
    bridge,
    bridgeConnected,
    onBridgeEvent,
    onBridgeStatus,
    OrbShell,
    rewindTo,
    TerminalIcon,
} from './orb-kit';
import type { AgentAction, EngineSnapshot } from './orb-kit';

/**
 * Agent 球窗口：入口 + 对话面板 + 四个数据页签。
 *
 * ## 为什么是一个文件
 *
 * 这三块只有这一个窗口用。判据是**生命周期是否耦合**，不是行数：面板与页签
 * 共用同一份 `rules` 状态、同一个保存去抖、同一份 `error`，拆成两个文件之后
 * 改一边的接口另一边编译期毫无提示。入口本来就只有七行，单独留着也没有信息量。
 *
 * ## 阅读顺序
 *
 * 对话面板 → 消息行 → 四个页签 → 入口（文件末尾）。
 *
 * 共用件（外壳、桥、图标）在 `orb-kit.tsx`。
 */

/**
 * 上下文占用。只给量级 —— 精确到个位的数字每秒都在变，读它没有意义
 */
const formatTokens = (usage?: AgentUsage): string => {
    const n = usage?.contextTokens ?? 0;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}k tok`;
    return `${n} tok`;
};

/**
 * 压缩档位候选。
 *
 * 与插件的 `COMPACT_RATIOS`（`agent/prompt.ts`）逐字一致。这里再写一份而不是
 * import：球与插件是两个独立的构建产物，互相 import 会把对方的整个依赖图拖
 * 进来（见 orb-kit.tsx 里 AgentAction 那段）。而档位是**用户界面**的事实
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
 * ## 五个页签
 *
 * 「对话」「规则」「请求头」「存储」「JWT」。后四个不是装饰：
 *
 *  · **规则 / 请求头**：模型改的规则立刻生效但不落盘，用户必须能看见它改了什么，
 *    并且能自己写规则（不是所有篡改都值得让模型代劳）。
 *  · **存储 / JWT**：Agent 改页面时最常问的两个问题 —— "这个值到底存在哪"、
 *    "这个 token 里有什么"。不能查就只能反复让模型去读，慢且费上下文。
 */

/** 页签清单。顺序即显示顺序：对话在最前，JWT 在最后 */
type AgentTab = 'chat' | 'rules' | 'headers' | 'storage' | 'jwt';

const AGENT_TABS: { id: AgentTab; label: string }[] = [
    { id: 'chat', label: '对话' },
    { id: 'rules', label: '规则' },
    { id: 'headers', label: '请求头' },
    { id: 'storage', label: '存储' },
    { id: 'jwt', label: 'JWT' },
];

const AgentOrb = () => {
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

    /*
     * 流式增量的按帧合并缓冲。
     *
     * 放 ref 而不是 state：它只是"还没提交到画面的那一小段"，读它的人只有
     * 那个 rAF 回调，进 state 等于每次追加都多一次渲染 —— 正是要避免的事。
     */
    const pendingDelta = useRef({ content: '', reasoning: '' });
    const deltaRaf = useRef<number | null>(null);

    /*
     * 自动滚到底。
     *
     * 必须**先看用户在哪**再决定滚不滚：他一直往上翻着看历史时，新内容一来就
     * 把他拽回底部，等于在读的过程中被抢走滚动条。判据是"离底 40px 以内"，
     * 留一点余量给"刚好贴着底但差几像素"的情况。
     */
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const stickToBottom = useRef(true);

    const onScroll = useCallback(() => {
        const box = scrollRef.current;
        if (!box) return;
        stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    }, []);

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
            /*
             * 用 ref 累积、按帧提交，不直接在回调里 setState。
             *
             * 增量是按 token 到达的，一次回答能来几百上千条。每条都 setState
             * 就是每次一个 React 渲染 —— 而渲染的是整块面板。合并到动画帧之后，
             * 上限变成"每帧一次"，观感完全一样（人眼分辨不出帧内的中间态），
             * 开销按帧数收敛。
             */
            pendingDelta.current.content += delta.content || '';
            pendingDelta.current.reasoning += delta.reasoning || '';
            if (deltaRaf.current !== null) return;
            deltaRaf.current = window.requestAnimationFrame(() => {
                deltaRaf.current = null;
                const { content, reasoning } = pendingDelta.current;
                pendingDelta.current = { content: '', reasoning: '' };
                setStreaming((prev) => ({
                    content: (prev?.content || '') + content,
                    reasoning: (prev?.reasoning || '') + reasoning,
                }));
            });
        }
    }), []);

    /* 卸载时把在途的那一帧取消，否则窗口关掉之后还会 setState 一次 */
    useEffect(() => () => {
        if (deltaRaf.current !== null) window.cancelAnimationFrame(deltaRaf.current);
    }, []);

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
    const canEdit = state?.canEdit !== false && !busy;

    /*
     * 贴底滚动。
     *
     * 用 useLayoutEffect 而不是 useEffect：要在**浏览器绘制之前**把位置定好，
     * 否则会看到内容先出现在下面、再跳一下。
     *
     * 依赖是消息条数与流式文本长度 —— 这两样是"内容变高了"的全部来源。
     */
    useLayoutEffect(() => {
        const box = scrollRef.current;
        if (!box || !stickToBottom.current) return;
        box.scrollTop = box.scrollHeight;
    }, [messages.length, streaming?.content, streaming?.reasoning]);

    /*
     * 页签条。
     *
     * 放在**标题栏下面**而不是塞进标题栏：标题栏只有 440px 宽，五个页签加上
     * 停止/清空/收起会全部挤成单字。独立一行还能给每个页签足够的点击面积。
     */
    const tabBar = (
        <nav className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-white/[0.07] px-1.5 py-1 scrollbar-hide">
            {AGENT_TABS.map((entry) => (
                <button
                    key={entry.id}
                    type="button"
                    onClick={() => setTab(entry.id)}
                    className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${tab === entry.id
                        ? 'bg-fuchsia-500/20 text-fuchsia-200'
                        : 'text-slate-500 hover:bg-white/[0.06] hover:text-slate-300'
                        }`}
                >
                    {entry.label}
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
                    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                        {messages.length === 0 && !streaming ? (
                            <p className="p-4 text-[11px] leading-relaxed text-slate-500">
                                在已登录的页面里执行脚本。模型可以直接调用页面自己的函数、读带凭证的
                                fetch 结果，并在跨页面导航后继续同一轮任务。
                            </p>
                        ) : (
                            <ul className="divide-y divide-white/5">
                                {messages.map((message) => (
                                    <MessageRowMemo
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
                            <StreamingBubble content={streaming.content} reasoning={streaming.reasoning} />
                        )}
                    </div>

                    <div className="shrink-0 border-t border-white/10 p-2">
                        {/*
                          次要动作放在输入框上方，不占标题栏。
                          标题栏只有 440px 宽，塞进「停止 / 压缩 / 导出 /
                          简洁 / 清空 / 收起」六个按钮会把标签挤到看不见。
                        */}
                        <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
                            <button
                                type="button"
                                onClick={() => void act({ type: 'compact' })}
                                disabled={busy || state?.compacting || !state?.canCompact}
                                title="把分界线之后的旧消息压成摘要（不可逆，但比清空保留更多）"
                                className="shrink-0 rounded-lg bg-white/[0.06] px-2 py-1 text-[10px] font-medium text-slate-400 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-30"
                            >
                                {state?.compacting ? '压缩中…' : '压缩上下文'}
                            </button>
                            <span className="h-3 w-px bg-white/10" />
                            <button
                                type="button"
                                onClick={() => exportAgentSession(messages)}
                                disabled={messages.length === 0}
                                title="导出完整会话（含推理过程）"
                                className="shrink-0 rounded-lg bg-white/[0.06] px-2 py-1 text-[10px] font-medium text-slate-400 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-30"
                            >
                                导出
                            </button>
                            <button
                                type="button"
                                onClick={() => exportAgentSession(messages, { includeReasoning: false })}
                                disabled={messages.length === 0}
                                title="导出不含推理过程的版本（适合分享）"
                                className="shrink-0 rounded-lg bg-white/[0.06] px-2 py-1 text-[10px] font-medium text-slate-400 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-30"
                            >
                                简洁版
                            </button>
                            <span
                                className="ml-auto shrink-0 text-[9px] font-semibold text-slate-500"
                                title="压缩档位：决定压缩时保留最近多少（1 为全留）"
                            >
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
                                    className={`shrink-0 rounded-lg px-1.5 py-0.5 text-[9px] font-medium transition disabled:opacity-30 ${state?.compactRatio === ratio
                                        ? 'bg-fuchsia-500/20 text-fuchsia-200'
                                        : 'text-slate-600 hover:bg-white/[0.06] hover:text-slate-300'
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
                                className="min-h-0 flex-1 resize-none rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-white/25 focus:bg-slate-950/80 disabled:opacity-50"
                            />
                            <button
                                type="button"
                                onClick={send}
                                disabled={busy || !input.trim() || state?.contextFull}
                                className="shrink-0 rounded-xl bg-indigo-500 px-3.5 py-2.5 text-[12px] font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
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

    const badge = message.label || message.tool || message.role;

    /*
     * 折叠长结果。
     *
     * 工具返回值动辄几 KB，全展开会把对话冲得没法看。但**不能截断** ——
     * 用户排查时正要看那段原文，所以给一个展开开关而不是切片。
     */
    const body = message.result || message.content;
    const long = body.length > 400;
    const shown = expanded || !long ? body : `${body.slice(0, 400)}…`;

    /*
     * 复制整条。
     *
     * 工具返回值动辄几 KB，用鼠标在里面选中再拖过面板边界很容易失手，而
     * "把这段报错/数据发给别人"恰恰是它最常见的用途。`navigator.clipboard`
     * 在 file:// 下需要安全上下文，拿不到时静默失败即可 —— 文字本身还能手动选。
     */
    const [copied, setCopied] = useState(false);
    const onCopy = useCallback(() => {
        void navigator.clipboard?.writeText(body).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        }).catch(() => undefined);
    }, [body]);

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
                  复制与两条历史编辑操作，都在悬停时出现。

                  复制**不受 canEdit 限制** —— 它只读，运行中照样该能复制。
                  所以它单独一块，与下面那块（引擎不允许改动时整体消失）分开。
                */}
                <span className={`${long ? '' : 'ml-auto'} flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100`}>
                    <button
                        type="button"
                        onClick={onCopy}
                        title="复制这条的完整内容"
                        className="text-[9px] text-slate-500 hover:text-sky-300"
                    >
                        {copied ? '已复制' : '复制'}
                    </button>
                </span>
                {/*
                  两条历史编辑操作。只在引擎允许时出现（canEdit）：运行中或
                  压缩中改动 messages 会和主循环抢同一个数组，而那个抢法没有
                  正确答案 —— 界面禁用比让用户点了没反应好。
                */}
                {canEdit && (
                    <span className="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100">
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
                <pre className="mb-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white/[0.03] p-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
                    {message.reasoning}
                </pre>
            )}

            <pre className={`whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed ${tone}`}>
                {shown}
            </pre>

            {message.script && expanded && (
                <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white/[0.03] p-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
                    {message.script}
                </pre>
            )}
        </li>
    );
};

/*
 * memo 的比较函数不能省。
 *
 * 父组件每次渲染都会新建 onRemove / onRewind 两个箭头函数，默认的浅比较
 * 因此永远判"变了"，memo 形同虚设 —— 而消息列表是长列表，每步都要整体重渲。
 * 两个回调的**语义**完全由 message.id 决定，所以比 message 本身与 canEdit
 * 就够了：这两个没变，回调做的事就没变。
 */
const MessageRowMemo = memo(MessageRow, (prev, next) => (
    prev.message === next.message && prev.canEdit === next.canEdit
));

/**
 * 流式气泡。
 *
 * 单独成一个 memo 组件，理由是**它是唯一每来一个 token 就变的东西**。
 * 增量直接挂在 AgentOrb 的 state 上时，每来一个字整棵消息列表（可能上百行、
 * 每行几 KB 的 pre）都要重新 reconcile 一遍，而画面其实只有这一小块在动。
 * 隔出来之后，增量只重渲这一个节点。
 */
const StreamingBubble = memo(({ content, reasoning }: { content: string; reasoning: string }) => (
    <div className="border-t border-white/5 px-3 py-2">
        {reasoning && (
            <pre className="mb-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-slate-500">
                {reasoning}
            </pre>
        )}
        {content && (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-300">
                {content}
            </pre>
        )}
    </div>
));

/* ========================================================================== */
/* 规则页                                                                      */
/* ========================================================================== */

/**
 * 「规则 / 请求头 / 存储 / JWT」四个页签。
 *
 * ## 为什么这四个必须存在
 *
 * 对话页只是**入口**。真正让 Agent 有用的是它能改页面运行时：拦响应、改请求头、
 * 翻存储、解 token。而这四件事全都是"改了之后看不见"的 —— 规则存下来了、
 * 页面里到底生不生效、当前存储里到底有什么，只有把真实值摊开给用户看才说得清。
 *
 * ## 判据一律取自 `shared/core`
 *
 * `isFieldRuleDropped`、`collectDroppedRules`、`buildCookieData`、`decodeJwt`、
 * `pickJwtCandidates` 那几个函数是应用侧与插件侧共用的同一份实现，
 * 各写一套必然漂移。
 *
 * ## 规则的唯一权威在插件
 *
 * 这里**不存规则**。读走 `tamper-get`、写走 `tamper-set`，中间不落地 ——
 * 面板自己存一份就会与插件那份漂移，症状是"面板显示启用中、页面里没生效"。
 * 本地只留"正在编辑的草稿"，且草稿在保存成功后立即丢弃。
 */

/**
 * 一条规则的编辑动作。
 *
 * 新增规则的默认值刻意是**空目标键**：它会被引擎丢弃，而 `collectDroppedRules`
 * 会把这件事报出来（见下面的提示条）。给一个能猜的默认值（比如 `is_vip`）更糟 ——
 * 用户不填就得到一个"看起来在生效"的规则。
 */
const emptyFieldRule = (): TamperRule => ({ id: `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`, enabled: true, urlPattern: '', jsonPath: '', newValue: '' });
const emptyHeaderRule = (): HeaderRule => ({ id: `h${Date.now()}${Math.random().toString(36).slice(2, 6)}`, enabled: true, urlPattern: '', headerName: '', headerValue: '' });

const FieldInput = ({
    label,
    value,
    placeholder,
    onChange,
    hint,
    tone,
}: {
    label: string;
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
    hint?: string;
    tone?: string;
}) => (
    <label className="block min-w-0">
        <span className="mb-0.5 block text-[9px] font-bold uppercase tracking-wider text-slate-600">{label}</span>
        <input
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
            className={`w-full rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1 font-mono text-[10px] outline-none transition focus:border-white/25 ${tone || 'text-slate-200'}`}
        />
        {hint && <span className="mt-0.5 block truncate text-[9px] text-slate-600">{hint}</span>}
    </label>
);

/** 一组字段规则（响应篡改 / 请求体篡改共用同一个编辑器） */
const RuleSection = ({
    title,
    desc,
    rules,
    onChange,
    tone,
}: {
    title: string;
    desc: string;
    rules: TamperRule[];
    onChange: (rules: TamperRule[]) => void;
    tone: string;
}) => {
    const update = (index: number, field: keyof TamperRule, value: unknown) => {
        const next = [...rules];
        next[index] = { ...next[index], [field]: value };
        onChange(next);
    };

    return (
        <section>
            <div className="mb-1.5 flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <h4 className={`text-[11px] font-bold ${tone}`}>{title}</h4>
                    <p className="mt-0.5 text-[9px] leading-relaxed text-slate-600">{desc}</p>
                </div>
                <button
                    type="button"
                    onClick={() => onChange([...rules, emptyFieldRule()])}
                    className="shrink-0 rounded-lg border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-300 transition hover:bg-white/[0.12] hover:text-white"
                >
                    新增
                </button>
            </div>

            {rules.length === 0 ? (
                <p className="rounded-lg border border-dashed border-white/10 px-2 py-2 text-[10px] text-slate-600">还没有规则。</p>
            ) : (
                <div className="space-y-1.5">
                    {rules.map((rule, index) => (
                        <div
                            key={rule.id || index}
                            className={`rounded-lg border p-1.5 ${rule.enabled ? 'border-white/10 bg-white/[0.04]' : 'border-white/5 bg-black/20 opacity-60'}`}
                        >
                            <div className="mb-1 flex items-center gap-1.5">
                                <input
                                    type="checkbox"
                                    checked={rule.enabled}
                                    onChange={(event) => update(index, 'enabled', event.target.checked)}
                                    className="h-3 w-3 accent-fuchsia-400"
                                />
                                <span className="text-[9px] text-slate-500">{rule.enabled ? '启用中' : '已禁用'}</span>
                                {isFieldRuleDropped(rule) && (
                                    <span className="rounded bg-amber-500/20 px-1 text-[9px] text-amber-300" title="目标键为空，引擎会跳过这条规则">
                                        会被跳过
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => onChange(rules.filter((_, i) => i !== index))}
                                    className="ml-auto shrink-0 text-[9px] text-slate-600 transition hover:text-rose-300"
                                >
                                    删除
                                </button>
                            </div>
                            {/* 面板窄，字段竖排；不并排是为了让输入框有足够宽度写字 */}
                            <div className="space-y-1">
                                <FieldInput label="URL 匹配" value={rule.urlPattern} placeholder="*（全部）" onChange={(v) => update(index, 'urlPattern', v)} />
                                <FieldInput
                                    label="目标键"
                                    value={rule.jsonPath}
                                    placeholder="例如 is_vip"
                                    onChange={(v) => update(index, 'jsonPath', v)}
                                    hint={ruleTargetKey(rule.jsonPath) ? `实际匹配字段：${ruleTargetKey(rule.jsonPath)}` : undefined}
                                />
                                <FieldInput
                                    label="新值"
                                    value={rule.newValue}
                                    placeholder="true（加 = 强制当字符串）"
                                    onChange={(v) => update(index, 'newValue', v)}
                                    tone={tone}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
};

const RulesTab = ({
    rules,
    onChange,
}: {
    rules: { interceptRules: TamperRule[]; requestRules: TamperRule[]; headerRules: HeaderRule[] };
    onChange: (next: { interceptRules: TamperRule[]; requestRules: TamperRule[]; headerRules: HeaderRule[] }) => void;
}) => (
    <div className="space-y-4">
        {/*
          能力边界必须写出来。不写的话，用户遇到"改了没反应"会一直以为
          是自己规则写错了，而真正的原因在架构上（钩子只装在页面主世界）。
        */}
        <div className="rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1.5 text-[9px] leading-relaxed text-slate-500">
            规则作用于<strong className="text-slate-400">当前页面的 JS</strong>（XHR / fetch / 存储）。
            以下不生效：Web Worker / Service Worker 内部解析、跨域 iframe 内的请求、
            页面在注入前就存下了 <code className="text-slate-400">JSON.parse</code> 引用、WASM 解析。
            <br />
            存储规则只覆盖 <code className="text-slate-400">storage.getItem(k)</code>，
            不覆盖 <code className="text-slate-400">storage[k]</code> 这种具名属性读法。
        </div>

        <RuleSection
            title="响应篡改"
            desc="拦截 JSON 响应并替换目标字段。同名规则也会改写 localStorage / sessionStorage 的读取结果。"
            tone="text-cyan-300"
            rules={rules.interceptRules}
            onChange={(interceptRules) => onChange({ ...rules, interceptRules })}
        />
        <RuleSection
            title="请求体篡改"
            desc="在请求发出前修改 JSON Body 中的目标字段。"
            tone="text-violet-300"
            rules={rules.requestRules}
            onChange={(requestRules) => onChange({ ...rules, requestRules })}
        />
    </div>
);

/* ========================================================================== */
/* 请求头页                                                                    */
/* ========================================================================== */

/**
 * 请求头控制页。
 *
 * `headerValue` 留空 = **删除**该请求头（引擎里 `''` 有专门语义）。
 * 占位符必须写出来，否则用户以为留空是"不改"。
 */
const HeadersTab = ({
    headers,
    onChange,
}: {
    headers: HeaderRule[];
    onChange: (rules: HeaderRule[]) => void;
}) => {
    const update = (index: number, field: keyof HeaderRule, value: unknown) => {
        const next = [...headers];
        next[index] = { ...next[index], [field]: value };
        onChange(next);
    };

    return (
        <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <h4 className="text-[11px] font-bold text-amber-300">请求头注入</h4>
                    <p className="mt-0.5 text-[9px] leading-relaxed text-slate-600">
                        修改或注入 HTTP Request Headers，例如 Authorization、User-Agent。
                        <strong className="text-slate-400"> 值留空表示删除该请求头。</strong>
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => onChange([...headers, emptyHeaderRule()])}
                    className="shrink-0 rounded-lg border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-300 transition hover:bg-white/[0.12] hover:text-white"
                >
                    新增
                </button>
            </div>

            {headers.length === 0 ? (
                <p className="rounded-lg border border-dashed border-white/10 px-2 py-2 text-[10px] text-slate-600">还没有请求头规则。</p>
            ) : (
                <div className="space-y-1.5">
                    {headers.map((rule, index) => (
                        <div
                            key={rule.id || index}
                            className={`rounded-lg border p-1.5 ${rule.enabled ? 'border-white/10 bg-white/[0.04]' : 'border-white/5 bg-black/20 opacity-60'}`}
                        >
                            <div className="mb-1 flex items-center gap-1.5">
                                <input
                                    type="checkbox"
                                    checked={rule.enabled}
                                    onChange={(event) => update(index, 'enabled', event.target.checked)}
                                    className="h-3 w-3 accent-amber-400"
                                />
                                <span className="text-[9px] text-slate-500">{rule.enabled ? '启用中' : '已禁用'}</span>
                                {isHeaderRuleDropped(rule) && (
                                    <span className="rounded bg-amber-500/20 px-1 text-[9px] text-amber-300" title="Header 名为空，引擎会跳过这条规则">
                                        会被跳过
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => onChange(headers.filter((_, i) => i !== index))}
                                    className="ml-auto shrink-0 text-[9px] text-slate-600 transition hover:text-rose-300"
                                >
                                    删除
                                </button>
                            </div>
                            <div className="space-y-1">
                                <FieldInput label="URL 匹配" value={rule.urlPattern} placeholder="*（全部）" onChange={(v) => update(index, 'urlPattern', v)} />
                                <FieldInput label="Header 名" value={rule.headerName} placeholder="例如 Authorization" onChange={(v) => update(index, 'headerName', v)} />
                                <FieldInput
                                    label="值"
                                    value={rule.headerValue}
                                    placeholder="留空 = 删除该请求头"
                                    onChange={(v) => update(index, 'headerValue', v)}
                                    tone="text-amber-300"
                                />
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

/* ========================================================================== */
/* 存储页                                                                      */
/* ========================================================================== */

/** 三块存储的展开态。默认只展开 localStorage —— 三块全开时列表太长 */
interface StorageData {
    local: Record<string, string>;
    session: Record<string, string>;
    cookies: CookieItem[];
}

const parseObject = (text: string): Record<string, string> => {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        // 页面禁用了存储或读回的不是 JSON：当作空，而不是让整个页签崩掉
        return {};
    }
};

/**
 * 存储页。
 *
 * ## 为什么 Cookie 也在这里
 *
 * 三者是同一件事的三个面："页面能读到什么"。分开成两个页签会让用户为了
 * 改一个 token 先想清楚"它到底在 cookie 里还是 localStorage 里" ——
 * 而那正是他要来这里查的问题。
 *
 * ## 改 Cookie 必须带完整对象
 *
 * `chrome.cookies.set` 是**整条覆盖**：漏掉 httpOnly 会把 HttpOnly 会话 cookie
 * 降级成 JS 可读的普通 cookie，漏掉 expirationDate 会把持久 cookie 变成会话
 * cookie（关掉窗口就掉登录态）。所以这里把原条目整个传回去，只换 value。
 * 这条路径由插件的 `page-storage-write` 走 `pageHost.setCookie` 保证 ——
 * 面板不自己拼 cookie 对象。
 */
const StorageTab = ({ pageUrl }: { pageUrl: string }) => {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({ local: true, session: false, cookie: false });
    const [data, setData] = useState<StorageData>({ local: {}, session: {}, cookies: [] });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const result = await bridge<{ local: string; session: string; cookies: CookieItem[] }>('page-storage-read');
            setData({
                local: parseObject(result.local),
                session: parseObject(result.session),
                cookies: Array.isArray(result.cookies) ? result.cookies : [],
            });
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    // 存储按当前页面取，切标签页时重新读
    useEffect(() => { void refresh(); }, [refresh, pageUrl]);

    const write = useCallback(async (area: 'local' | 'session', key: string, value: string | null) => {
        try {
            const result = await bridge<{ ok: boolean }>('page-storage-write', { area, key, value });
            setError(result.ok ? '' : '写入失败：页面可能已禁用存储或配额已满。');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        await refresh();
    }, [refresh]);

    /** 改一条 cookie。走插件侧整条覆盖语义，只换 value，见上面那段 */
    const writeCookie = useCallback(async (cookie: CookieItem, value: string) => {
        try {
            const result = await bridge<{ ok: boolean }>('page-storage-write', {
                area: 'cookie',
                // cookie 的写入是整条覆盖，必须把原条目整个传回去（保留 httpOnly /
                // 过期时间），只换 value。插件侧按这个对象调 pageHost.setCookie。
                key: cookie.name,
                cookie,
                value,
            });
            setError(result.ok ? '' : '写入 Cookie 失败：当前没有可用的页面地址。');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        await refresh();
    }, [refresh]);

    const cookieData = useMemo(() => buildCookieData(data.cookies), [data.cookies]);

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <p className="text-[9px] leading-relaxed text-slate-600">
                    改完即时生效。这里显示的是<strong className="text-slate-400">真实值</strong>，
                    页面 JS 读到的可能被规则改写。
                </p>
                <button
                    type="button"
                    onClick={() => void refresh()}
                    disabled={loading}
                    className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-40"
                >
                    {loading ? '读取中…' : '刷新'}
                </button>
            </div>

            {error && (
                <div className="flex items-start justify-between gap-2 rounded-lg border border-rose-400/20 bg-rose-500/[0.08] px-2 py-1.5 text-[9px] text-rose-200">
                    <span className="min-w-0">{error}</span>
                    <button type="button" onClick={() => setError('')} className="shrink-0 text-rose-300/70 hover:text-rose-100">关闭</button>
                </div>
            )}

            <StorageGroup
                title="Local Storage"
                expanded={!!expanded.local}
                onToggle={() => setExpanded((prev) => ({ ...prev, local: !prev.local }))}
                data={data.local}
                onSave={(key, value) => void write('local', key, value)}
                onDelete={(key) => void write('local', key, null)}
            />
            <StorageGroup
                title="Session Storage"
                expanded={!!expanded.session}
                onToggle={() => setExpanded((prev) => ({ ...prev, session: !prev.session }))}
                data={data.session}
                onSave={(key, value) => void write('session', key, value)}
                onDelete={(key) => void write('session', key, null)}
            />
            <StorageGroup
                title="Cookies"
                expanded={!!expanded.cookie}
                onToggle={() => setExpanded((prev) => ({ ...prev, cookie: !prev.cookie }))}
                /*
                 * 同名 cookie 在 Chrome 里按 name+domain+path 并存，访问子域时会
                 * 同时返回 `sid@sub.example.com` 与 `sid@.example.com`。键必须能
                 * 区分它们，否则面板少显示一条、且回写只会命中先出现的那条。
                 */
                data={cookieData}
                onSave={(key, value) => {
                    const cookie = findCookieByKey(data.cookies, key);
                    if (cookie) void writeCookie(cookie, value);
                }}
                onDelete={(key) => {
                    const cookie = findCookieByKey(data.cookies, key);
                    if (cookie) void writeCookie(cookie, '');
                }}
            />
        </div>
    );
};

/** 一块存储：折叠头 + 键值列表。每行的编辑是就地输入，改完失焦即保存 */
const StorageGroup = ({
    title,
    expanded,
    onToggle,
    data,
    onSave,
    onDelete,
}: {
    title: string;
    expanded: boolean;
    onToggle: () => void;
    data: Record<string, string>;
    onSave: (key: string, value: string) => void;
    onDelete: (key: string) => void;
}) => {
    const keys = Object.keys(data);

    return (
        <div className="rounded-lg border border-white/10 bg-white/[0.02]">
            <button
                type="button"
                onClick={onToggle}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition hover:bg-white/[0.04]"
            >
                <span className="text-[10px] text-slate-400">{expanded ? '▾' : '▸'}</span>
                <span className="text-[11px] text-slate-300">{title}</span>
                <span className="ml-auto font-mono text-[9px] text-slate-600">{keys.length}</span>
            </button>

            {expanded && (
                keys.length === 0 ? (
                    <p className="border-t border-white/5 px-2 py-1.5 text-[9px] text-slate-600">没有数据。</p>
                ) : (
                    <ul className="divide-y divide-white/5 border-t border-white/5">
                        {keys.map((key) => (
                            <StorageRow key={key} name={key} value={data[key]} onSave={onSave} onDelete={onDelete} />
                        ))}
                    </ul>
                )
            )}
        </div>
    );
};

/**
 * 一行存储。
 *
 * ## 为什么用受控草稿而不是直接改
 *
 * 每敲一个字符就写回页面等于每敲一个字符改一次页面状态，而页面可能正读着它 ——
 * 且写盘是跨进程往返，打字会卡。所以本地留草稿，失焦或回车才提交。
 *
 * ## 为什么长值要折叠
 *
 * token 动辄几百字符，全展开会把列表冲得没法看。但**不能截断显示** ——
 * 用户来这里正是要抄那个值。给一个展开开关而不是切片。
 */
const StorageRow = ({
    name,
    value,
    onSave,
    onDelete,
}: {
    name: string;
    value: string;
    onSave: (key: string, value: string) => void;
    onDelete: (key: string) => void;
}) => {
    const [draft, setDraft] = useState(value);
    const [expanded, setExpanded] = useState(false);

    /* 外部刷新（切页面、重读）之后草稿要跟着走，否则界面显示的是过期值 */
    useEffect(() => setDraft(value), [value]);

    const commit = () => {
        if (draft !== value) onSave(name, draft);
    };

    const long = value.length > 80;

    return (
        <li className="px-2 py-1.5">
            <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-400" title={name}>{name}</span>
                {long && (
                    <button
                        type="button"
                        onClick={() => setExpanded((v) => !v)}
                        className="shrink-0 text-[9px] text-slate-600 transition hover:text-slate-300"
                    >
                        {expanded ? '收起' : '展开'}
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => onDelete(name)}
                    className="shrink-0 text-[9px] text-slate-600 transition hover:text-rose-300"
                >
                    删除
                </button>
            </div>
            {expanded ? (
                <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commit}
                    spellCheck={false}
                    rows={3}
                    className="mt-0.5 w-full resize-y rounded border border-white/10 bg-slate-950/70 px-1.5 py-1 font-mono text-[10px] text-slate-300 outline-none focus:border-white/25"
                />
            ) : (
                <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commit}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); commit(); }
                    }}
                    spellCheck={false}
                    className="mt-0.5 w-full rounded border border-white/10 bg-slate-950/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 outline-none focus:border-white/25"
                />
            )}
        </li>
    );
};

/* ========================================================================== */
/* JWT 页                                                                      */
/* ========================================================================== */

/**
 * JWT 解码页。
 *
 * ## 只做解码，不做改写
 *
 * 改 payload 会让签名失效（签名覆盖的正是 payload），而"改完还能用"这件事
 * 在客户端做不到。这类改写要交给 Agent 的 `tokens` 工具 —— 它会一并说明后果。
 * 给一个点了之后页面直接掉登录态的按钮，比没有这个功能更糟。
 *
 * ## 「自动查找」的判据与应用侧共用
 *
 * `pickJwtCandidates` 只要求**两段** base64url 即可：未签名的调试 token 只有
 * 两段，要求三段会把它们全漏掉。这个判据写在 `shared/core/jwt.ts` 里，
 * 面板与 Agent 工具读的是同一份。
 */
const JwtTab = ({ pageUrl }: { pageUrl: string }) => {
    const [input, setInput] = useState('');
    const [searchHint, setSearchHint] = useState('');

    /*
     * 解码结果由输入派生，不存 state。
     *
     * 存 state 就要在 input 变化时同步一次 —— 那是一个可以忘、忘了之后界面
     * 显示上一次结果的状态。`useMemo` 让它结构上不可能不同步。
     */
    const decoded = useMemo(() => {
        if (!input.trim()) return null;
        try {
            const { header, payload } = decodeJwt(input.trim());
            return { header: JSON.stringify(header, null, 2), payload: JSON.stringify(payload, null, 2), error: '' };
        } catch (e) {
            return { header: '', payload: '', error: e instanceof Error ? e.message : '解析失败' };
        }
    }, [input]);

    /**
     * 从 Cookie / localStorage / sessionStorage 里找一个 JWT。
     *
     * 走 `page-storage-read` 一次取回三样 —— 与应用侧的 `findJwt` 同一判据，
     * 但不用三次跨进程调用。
     */
    const findJwt = useCallback(async () => {
        setSearchHint('');
        try {
            const result = await bridge<{ local: string; session: string; cookies: CookieItem[] }>('page-storage-read');
            const values: unknown[] = [
                ...(result.cookies || []).map((cookie) => cookie.value),
                ...Object.values(parseObject(result.local)),
                ...Object.values(parseObject(result.session)),
            ];
            const [first] = pickJwtCandidates(values);
            if (first) { setInput(first); return; }
            setSearchHint('未在 Cookie 与本地存储里找到 JWT。');
        } catch (e) {
            setSearchHint(e instanceof Error ? e.message : String(e));
        }
    }, []);

    // 换页面时清空：上一个站点的 token 留在这里只会让人误以为它是当前页的
    useEffect(() => { setInput(''); setSearchHint(''); }, [pageUrl]);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
                <label className="text-[9px] font-bold uppercase tracking-wider text-slate-600">Encoded Token</label>
                <button
                    type="button"
                    onClick={() => void findJwt()}
                    className="rounded-lg border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/[0.12] hover:text-white"
                >
                    自动查找
                </button>
            </div>

            <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="请粘贴 JWT，例如 eyJhbGciOi…"
                spellCheck={false}
                rows={3}
                className="w-full resize-y rounded-lg border border-white/10 bg-slate-950/70 p-2 font-mono text-[10px] leading-relaxed text-slate-300 outline-none transition focus:border-rose-400/40"
            />

            {searchHint && (
                <div className="rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1.5 text-[9px] text-slate-400">{searchHint}</div>
            )}

            {decoded?.error && (
                <div className="rounded-lg border border-amber-400/20 bg-amber-500/[0.08] px-2 py-1.5 text-[9px] text-amber-200">
                    无法解析：{decoded.error}
                </div>
            )}

            {/* 上下叠放：面板窄，Header 与 Payload 并排会把两边都挤成竖排单字 */}
            <JwtPanel title="Header" tone="text-rose-300" content={decoded?.header || '// Header info'} />
            <JwtPanel title="Payload" tone="text-violet-300" content={decoded?.payload || '// Payload data'} />

            <p className="text-[9px] leading-relaxed text-slate-600">
                只做解码。改 payload 会让签名失效（签名覆盖的正是 payload），
                这类改写请让 Agent 用 <code className="font-mono">tokens</code> 工具做。
            </p>
        </div>
    );
};

const JwtPanel = ({ title, tone, content }: { title: string; tone: string; content: string }) => (
    <div className="flex flex-col gap-1">
        <label className={`text-[9px] font-bold uppercase tracking-wider ${tone}`}>{title}</label>
        <div className="max-h-40 overflow-auto rounded-lg border border-white/10 bg-white/[0.03] p-2">
            <pre className={`whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed ${tone}`}>{content}</pre>
        </div>
    </div>
);

/** 规则的"会被跳过"提示条。与引擎的丢弃判据同一份（collectDroppedRules） */
const droppedHint = (rules: { interceptRules: TamperRule[]; requestRules: TamperRule[]; headerRules: HeaderRule[] }): string => {
    const dropped = collectDroppedRules({
        intercept: rules.interceptRules,
        request: rules.requestRules,
        headers: rules.headerRules,
    });
    if (dropped.length === 0) return '';
    return `有 ${dropped.length} 条启用中的规则没填「目标键 / Header 名」，引擎会跳过它们。`;
};

/* ========================================================================== */
/* 入口                                                                        */
/* ========================================================================== */

/**
 * 不用 `StrictMode`：它会在开发模式下**故意双调用** effect，而球的每个 effect
 * 都在跟主进程/插件通信 —— 双调用意味着开两次面板、订阅两次事件、
 * 发两遍请求。生产构建里 StrictMode 不做这件事，所以这个代价只在开发时出现，
 * 而"开发时行为与生产不一致"本身就是最该避免的。
 *
 * 必须在所有组件定义之后：这里是模块顶层立即执行的一行，而组件是 `const`，
 * 提到前面会撞上暂时性死区。
 */
const container = document.getElementById('root');
if (container) createRoot(container).render(<AgentOrb />);
