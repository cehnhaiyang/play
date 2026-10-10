import type {
    AgentCompaction,
    AgentMessage,
    AgentMessageOrigin,
    AgentRunStatus,
    AgentScript,
    AgentState,
    AgentToolName,
    AgentUsage,
    AiChatMessage,
    AiUsage,
} from '../../../shared/meta';
import { generateId } from '../../../shared/core';
import type { AgentHost } from './host';
import {
    COMPACT_INPUT_BUDGET_BYTES,
    COMPACT_MAX_TOKENS,
    COMPACT_PREFIX,
    COMPACT_RATIO_DEFAULT,
    COMPACT_RATIO_STORE_KEY,
    COMPACT_RATIOS,
    COMPACT_SYSTEM_PROMPT,
    CONTEXT_LIMIT_TOKENS,
    MAX_PROTOCOL_ERRORS,
    MESSAGES_STORE_KEY,
    MESSAGES_STORE_MAX,
    SCRIPTS_STORE_KEY,
    SCRIPTS_STORE_MAX,
    STORE_BUDGET_MESSAGES,
    STORE_BUDGET_SCRIPTS,
    SYSTEM_PROMPT,
    compactCoverCount,
    contextFullMessage,
    contextTokensOf,
} from './prompt';
import {
    AUTO_RUN_PREFIX,
    MANUAL_RUN_PREFIX,
    PROTOCOL_ERROR_LABEL,
    buildTranscript,
    insertAfterId,
    protocolErrorObservation,
    splitByCompaction,
    sumUsage,
    toolObservation,
} from './transcript';
import { asString, errorText, keepReasoning, trimToBudget } from './text';
import { buildScriptSource, extractJsonObject, isJsErrorResult } from './parse';
import { dispatchTool } from './tools';
import type { ScriptStore } from './tools';

/**
 * Agent 引擎。
 *
 * ## 为什么不是 React hook
 *
 * 应用里那份是 `useAgent`，挂在渲染层。搬到这里之后有两个理由必须改掉这个形态：
 *
 * 1. **它自己的 navigate 工具会换页**。挂在 content script 里的话，换页会重跑
 *    整个脚本，主循环当场死掉 —— 而"跨页继续"正是 Agent 存在的意义之一。
 * 2. **它必须在没有界面的情况下继续跑**。球收起、用户切到别的标签页，循环都该
 *    继续。挂在某个组件的生命周期上做不到这一点。
 *
 * 所以它是一个普通的状态机：构造时给宿主与持久化端口，之后靠 `subscribe` 把
 * 快照推给界面。测试里可以直接 new 出来跑，不需要 React、不需要 DOM。
 *
 * ## 与界面那份 `AgentState` 的关系
 *
 * 快照形状保持不变（界面代码不用重学），但**多了一个 `revision`**：消息数组是
 * 每次变更新建的，跨进程消息只传增量会让界面难以判断"这次推的是新的还是重复的"，
 * 带一个单调递增的序号最省事。
 */

/** 引擎推给界面的快照 */
export interface EngineSnapshot extends AgentState {
    revision: number;
}

/** 持久化端口。抽出来是为了测试里能换成内存实现 */
export interface EngineStorage {
    load: <T>(key: string, fallback: T) => Promise<T>;
    save: (key: string, value: unknown) => Promise<void>;
}

/**
 * 模型调用端口。
 *
 * ## 为什么引擎不直接调 `chat()`
 *
 * 引擎跑在 service worker 里（它要 `chrome.tabs` / `chrome.cookies` /
 * `chrome.debugger` 这一整套 API），而**模型调用不能在那里发**：一次流式补全
 * 可能持续几分钟，SW 空闲约 30 秒就被回收，它是否会被"在途 fetch"续命没有
 * 可实测的依据。
 *
 * 所以调用被推到 offscreen 文档，中间隔这一个端口。副作用是引擎**完全不知道
 * 网络的存在** —— 测试里塞一个假实现就能把整个主循环跑起来，不碰网络。
 */
export interface ChatPort {
    chat: (options: {
        system?: string;
        messages: AiChatMessage[];
        temperature?: number;
        maxTokens?: number;
        reasoningEffort?: 'low' | 'high' | 'max';
        signal: AbortSignal;
        onDelta: (delta: { content?: string; reasoning?: string }) => void;
        onUsage: (usage: AiUsage) => void;
    }) => Promise<string>;
}

export interface EngineOptions {
    host: AgentHost;
    storage: EngineStorage;
    chat: ChatPort;
    /**
     * 增量回调。流式输出的每个分片都走它 ——
     * 整个快照太大，逐字重发不现实。
     */
    onDelta: (delta: { content?: string; reasoning?: string }) => void;
    /** 快照变更回调 */
    onSnapshot: (snapshot: EngineSnapshot) => void;
}

/** 默认的内存实现，给测试与"存储不可用"的降级路径用 */
export const memoryStorage = (): EngineStorage => {
    const map = new Map<string, unknown>();
    return {
        load: async <T,>(key: string, fallback: T): Promise<T> =>
            (map.has(key) ? (map.get(key) as T) : fallback),
        save: async (key, value) => {
            map.set(key, value);
        },
    };
};

export class AgentEngine {
    private readonly options: EngineOptions;

    private messages: AgentMessage[] = [];
    private scripts: AgentScript[] = [];
    private status: AgentRunStatus = 'idle';
    private error = '';
    private streaming: { content: string; reasoning: string } | null = null;
    private compacting = false;
    private compactRatio = COMPACT_RATIO_DEFAULT;
    private revision = 0;

    private busy = false;
    private stopped = false;
    private abort: AbortController | null = null;

    /**
     * 脚本执行的串行队列。
     *
     * 模型步骤与自动脚本都会进这里，而 `Runtime.evaluate` 的并发语义不可靠：
     * 两段脚本交错读页面时，双方看到的都是对方改了一半的状态。串行后"谁先谁后"
     * 有明确顺序，排查时能复现。队列自身吞掉异常 —— 某一次失败不能把排在后面的
     * 全部卡死。
     */
    private execChain: Promise<unknown> = Promise.resolve();

    constructor(options: EngineOptions) {
        this.options = options;
    }

    /* ---------------------------------------------------------------------- */
    /* 生命周期                                                                */
    /* ---------------------------------------------------------------------- */

    /** 从存储恢复。构造之后必须先 await 它，否则第一次快照是空的 */
    async hydrate(): Promise<void> {
        const [messages, scripts, ratio] = await Promise.all([
            this.options.storage.load<AgentMessage[]>(MESSAGES_STORE_KEY, []),
            this.options.storage.load<unknown[]>(SCRIPTS_STORE_KEY, []),
            this.options.storage.load<number>(COMPACT_RATIO_STORE_KEY, COMPACT_RATIO_DEFAULT),
        ]);

        this.messages = Array.isArray(messages) ? messages : [];
        this.scripts = (Array.isArray(scripts) ? scripts : [])
            .map(normalizeScript)
            .filter((s): s is AgentScript => !!s)
            .slice(-SCRIPTS_STORE_MAX);
        this.compactRatio = (COMPACT_RATIOS as readonly number[]).includes(ratio)
            ? ratio
            : COMPACT_RATIO_DEFAULT;

        this.emit();
    }

    snapshot(): EngineSnapshot {
        const contextTokens = contextTokensOf(this.messages);
        const usage: AgentUsage = sumUsage(this.messages, contextTokens);
        return {
            messages: this.messages,
            scripts: this.scripts,
            status: this.status,
            error: this.error,
            streaming: this.streaming,
            canEdit: this.status === 'idle' && !this.compacting,
            usage,
            contextFull: contextTokens >= CONTEXT_LIMIT_TOKENS,
            canCompact: compactCoverCount(splitByCompaction(this.messages).messages.length, this.compactRatio) >= 1,
            compacting: this.compacting,
            compactRatio: this.compactRatio,
            actions: {
                send: (prompt) => this.send(prompt),
                stop: () => this.stop(),
                clear: () => this.clear(),
                removeMessage: (id) => this.removeMessage(id),
                rewindTo: (id) => this.rewindTo(id),
                compact: () => this.compact(),
                setCompactRatio: (ratio) => this.setCompactRatio(ratio),
                runScriptNow: (id) => this.runScriptNow(id),
                removeScript: (id) => this.removeScript(id),
                toggleScript: (id) => this.toggleScript(id),
            },
            revision: this.revision,
        };
    }

    private emit(): void {
        this.revision += 1;
        this.options.onSnapshot(this.snapshot());
    }

    /* ---------------------------------------------------------------------- */
    /* 持久化                                                                  */
    /* ---------------------------------------------------------------------- */

    /**
     * 落盘。**不 await**：它挂在每个 appendMessage 后面，而写 storage 是异步的，
     * await 会让主循环每追加一条消息就多等一个来回。
     *
     * 失败只记日志不抛：配额满了的时候，用户最不该看到的是"对话进行到一半
     * 整个卡住"。历史丢失是可惜，但比中断当前这轮轻。
     */
    private persist(): void {
        const messages = trimToBudget(this.messages, STORE_BUDGET_MESSAGES).slice(-MESSAGES_STORE_MAX);
        const scripts = trimToBudget(this.scripts, STORE_BUDGET_SCRIPTS);
        void this.options.storage.save(MESSAGES_STORE_KEY, messages).catch(() => undefined);
        void this.options.storage.save(SCRIPTS_STORE_KEY, scripts).catch(() => undefined);
    }

    private appendMessage(message: AgentMessage): void {
        this.messages = [...this.messages, message];
        this.persist();
        this.emit();
    }

    /* ---------------------------------------------------------------------- */
    /* 脚本清单（工具层的读写口）                                               */
    /* ---------------------------------------------------------------------- */

    private scriptStore(): ScriptStore {
        return {
            list: () => this.scripts,
            add: (script) => {
                this.scripts = [...this.scripts, script].slice(-SCRIPTS_STORE_MAX);
                this.persist();
                this.emit();
            },
            update: (id, patch) => {
                this.scripts = this.scripts.map((s) => (s.id === id ? { ...s, ...patch } : s));
                this.persist();
                this.emit();
            },
            remove: (id) => {
                this.scripts = this.scripts.filter((s) => s.id !== id);
                this.persist();
                this.emit();
            },
        };
    }

    /* ---------------------------------------------------------------------- */
    /* 页面执行                                                                */
    /* ---------------------------------------------------------------------- */

    /**
     * 在页面里执行一段代码，走串行队列。
     *
     * 超时只是"不等了"，不是"掐断了"：后返回的结果会被丢弃，队列按 race 的
     * settle 推进，不会因此卡住。
     */
    private execOnPage(tabId: number, code: string): Promise<string> {
        const task = async (): Promise<string> => {
            /*
             * 超时由宿主负责 race：`Runtime.evaluate` 没有 abort，页面死循环时
             * 那个 Promise 永远不 settle。宿主返回失败结果，这里只负责把队列
             * 推进下去 —— 后返回的结果会被丢弃，队列不会因此卡住。
             */
            const result = await this.options.host.evaluate(tabId, buildScriptSource(code));
            return result.value;
        };

        const queued: Promise<string> = this.execChain.then(task, task);
        this.execChain = queued.then(() => undefined, () => undefined);
        return queued;
    }

    private async execActive(code: string): Promise<string> {
        /*
         * 每次都问宿主"现在操作哪个页面"，**不缓存 tabId**。
         *
         * 缓存会让同一个事实有两个存放处：引擎一份、宿主的 activeTab() 一份。
         * 用户切标签页后两边立刻不一致，而"哪个是对的"没有答案 ——
         * 表现为"脚本跑到上一个标签页去了"。宿主才是这件事的权威。
         */
        const tab = await this.options.host.activeTab();
        if (!tab) {
            return JSON.stringify({ error: '当前没有可用的页面（标签页是空白页或未就绪）' });
        }
        return this.execOnPage(tab.id, code);
    }

    /* ---------------------------------------------------------------------- */
    /* 主循环                                                                  */
    /* ---------------------------------------------------------------------- */

    private async send(prompt: string): Promise<void> {
        const text = prompt.trim();
        if (!text || this.busy) return;

        /*
         * 压缩在途时拒绝新提问。
         *
         * compact 手上的 digest 与 upTo 是开始那一刻算的，中途进来一轮，
         * 分界线就会按过期位置落下：本该保留的工作集被划进覆盖区，
         * 既没进摘要器又不再进上下文。
         */
        if (this.compacting) {
            this.error = '正在压缩上下文，请稍候再试。';
            this.emit();
            return;
        }

        /*
         * 硬门槛的第二道闸门。
         *
         * 界面已禁用输入框，但不能只靠界面：快捷键、以及任何直接调 actions.send
         * 的路径都会绕过 disabled。在唯一的入口处拦一次才是真正的保证。
         */
        if (contextTokensOf(this.messages) >= CONTEXT_LIMIT_TOKENS) {
            this.error = contextFullMessage();
            this.emit();
            return;
        }

        this.busy = true;
        this.stopped = false;
        this.error = '';

        /*
         * 历史必须在 appendMessage **之前**读。那行之后 this.messages 已经变了，
         * 读在它前面就不必关心时序，也不会把本轮提问重复算进历史。
         * 不接历史的话模型每轮都从零开始，追问「它 / 刚才那个」全部落空。
         */
        const history = buildTranscript(this.messages);
        this.appendMessage({ id: generateId(), role: 'user', content: text, at: Date.now() });

        // 模型侧记录。JSON 协议没有 tool role，观察结果以 user 消息回灌（ReAct 形态）
        const transcript = [...history, { role: 'user' as const, content: text }];

        try {
            // 连续协议错误计数。只统计**连续**的：中途成功执行过一次工具就归零，
            // 否则一个偶发笔误会跟着整个会话不放，几次之后把还正常的模型判死。
            let protocolErrors = 0;

            // 不设步数上限：什么时候停由模型自己决定（不再要工具就收尾）。
            for (;;) {
                if (this.stopped) break;

                // 轮内门槛：transcript 在本轮内单调增长，入口处那道闸门管不住它。
                if (contextTokensOf(this.messages) >= CONTEXT_LIMIT_TOKENS) {
                    this.appendMessage({
                        id: generateId(),
                        role: 'assistant',
                        content: `本轮${contextFullMessage()}`,
                        notice: true,
                        at: Date.now(),
                    });
                    this.error = contextFullMessage();
                    break;
                }

                this.status = 'thinking';
                this.streaming = { content: '', reasoning: '' };
                this.emit();

                // 增量累积在局部变量里，再整块 setState：
                // 每个 token 都推一次快照会让长回复卡住渲染。
                let liveContent = '';
                let liveReasoning = '';
                const controller = new AbortController();
                this.abort = controller;

                let stepUsage: AiUsage | undefined;
                let reply: string;

                try {
                    reply = await this.options.chat.chat({
                        system: SYSTEM_PROMPT,
                        messages: transcript,
                        // 不指定 reasoningEffort：由配置里的档位决定。
                        // 硬编码会无视用户在设置里选的档位，而推理强度是按调用计费的。
                        signal: controller.signal,
                        onUsage: (u) => {
                            stepUsage = u;
                        },
                        onDelta: (delta) => {
                            if (delta.content) liveContent += delta.content;
                            if (delta.reasoning) liveReasoning += delta.reasoning;
                            this.options.onDelta({ content: delta.content, reasoning: delta.reasoning });
                        },
                    });
                } catch (e) {
                    // 用户点停止导致的中断：不算错误，把已流出的部分定稿即可
                    const aborted = e instanceof Error && e.name === 'AbortError';
                    if (!aborted) this.error = errorText(e);

                    /*
                     * 中断的这两条消息**不带 usage**，这不是遗漏。
                     * chat 只在成功拿到完整回复后才回调 onUsage，中止时它直接抛
                     * AbortError —— 客户端根本没收到 usage 块。服务端那边这次调用
                     * 确实可能已经计了费，但那个数字本地无从得知；编一个估算值挂上去，
                     * 只会让"累计"这个本该能核对账单的数变得不可信。
                     */
                    if (liveContent.trim()) {
                        this.appendMessage({
                            id: generateId(),
                            role: 'assistant',
                            content: liveContent.trim(),
                            reasoning: keepReasoning(liveReasoning),
                            at: Date.now(),
                        });
                    } else if (liveReasoning.trim()) {
                        // 只有推理、没有正文（用户中途停止时很常见）：也要落一条，
                        // 否则这一轮的思考同样会随气泡消失。
                        this.appendMessage({
                            id: generateId(),
                            role: 'assistant',
                            content: '（本轮已中断，模型只输出了推理）',
                            reasoning: keepReasoning(liveReasoning),
                            notice: true,
                            at: Date.now(),
                        });
                    }
                    break;
                } finally {
                    this.abort = null;
                    this.streaming = null;
                    this.emit();
                }

                if (this.stopped) break;
                transcript.push({ role: 'assistant', content: reply });

                const call = extractJsonObject(reply);
                /*
                 * 工具名全小写严格匹配，写错会落到"未知工具"。
                 * 不归一：归一等于把"拼写检查"这道关口拆掉，写错名字是最便宜的笔误，
                 * 就该在第一步暴露，而不是猜着执行。
                 */
                const tool = call?.tool as AgentToolName | undefined;

                /**
                 * 没有可执行的工具调用 —— 三种情况必须分开处置，混为一谈会让 Agent
                 * 在最需要自救的时候停下来：
                 *
                 * 1. **模型明确收尾**（给了 final）：正常结束，落一条回答。
                 * 2. **协议错误**（没给 final，也没给 tool）：这不是"它说完了"，
                 *    而是**这一步没做成**。直接当成普通文本收尾，等于把一次失败的
                 *    调用当成结论交给用户。必须把错误回灌让它改。
                 * 3. **空回复**：推理模型偶发，回灌也无从改起，如实提示后停止。
                 */
                if (!call || !tool) {
                    const finalText = asString(call?.final);

                    if (finalText) {
                        this.appendMessage({
                            id: generateId(),
                            role: 'assistant',
                            content: finalText,
                            reasoning: keepReasoning(liveReasoning),
                            ...(stepUsage ? { usage: stepUsage } : {}),
                            at: Date.now(),
                        });
                        break;
                    }

                    // 走到这里：既没有 final 也没有 tool。有正文内容才算协议错误 ——
                    // 空回复回灌一句"你没输出"它也变不出内容来，那是浪费一次调用。
                    if (reply.trim()) {
                        protocolErrors += 1;

                        this.appendMessage({
                            id: generateId(),
                            role: 'tool',
                            content: '协议错误：回复里没有工具调用也没有 final',
                            reasoning: keepReasoning(liveReasoning),
                            label: PROTOCOL_ERROR_LABEL,
                            ok: false,
                            result: reply.trim(),
                            ...(stepUsage ? { usage: stepUsage } : {}),
                            at: Date.now(),
                        });

                        transcript.push({ role: 'user', content: protocolErrorObservation(reply.trim()) });

                        if (protocolErrors >= MAX_PROTOCOL_ERRORS) {
                            this.appendMessage({
                                id: generateId(),
                                role: 'assistant',
                                content: `连续 ${MAX_PROTOCOL_ERRORS} 次没有按输出协议回复，已停止。`
                                    + '可以再说一次，或换个更明确的说法。',
                                notice: true,
                                at: Date.now(),
                            });
                            break;
                        }
                        continue;
                    }

                    // 空回复：不能静默 break —— 那样用户看到对话停在半路，
                    // 分不清是结束还是卡住。
                    this.appendMessage({
                        id: generateId(),
                        role: 'assistant',
                        content: '（模型本轮没有返回内容，已停止。可以再说一次或换个说法。）',
                        notice: true,
                        at: Date.now(),
                    });
                    break;
                }

                const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;
                const thought = asString(call.thought);

                this.status = 'acting';
                this.emit();

                /**
                 * 工具派发**不能让异常穿出去**。
                 *
                 * dispatchTool 内部对预期内的失败（缺参数、找不到 id、脚本抛错）
                 * 都返回 `{error}`，但意外异常仍然存在：宿主断连、标签页被关。
                 * 原先这些异常会一路冒到 finally，循环直接终止 —— 用户看到的是
                 * 对话停在半路，而模型连"这一步失败了"都不知道。
                 */
                let result: string;
                try {
                    result = await dispatchTool(tool, args, {
                        host: this.options.host,
                        scripts: this.scriptStore(),
                        exec: (code) => this.execActive(code),
                    });
                } catch (e) {
                    result = JSON.stringify({ error: `工具 ${tool} 执行时抛出异常：${errorText(e)}` });
                }
                if (this.stopped) break;

                // 这一步真的执行了（无论成败），协议错误计数归零 ——
                // 判据是"模型能不能正确表达调用意图"，它已经表达对了。
                protocolErrors = 0;

                // 日志只写工具名会分不清模型做的是哪件事
                // （列清单 / 存脚本 / 改脚本 / 删脚本都是 "script_store"）。
                const rawAction = asString(args.action);
                const label = tool === 'script_store' && rawAction ? `${tool}·${rawAction}` : tool;

                /**
                 * 失败判据按工具分岔，因为"什么算失败"对两者本就不同：
                 * js 的页面数据里 `{error:"..."}` 是**探测到的业务字段**，
                 * 只有 `__agentError` 与 dispatchTool 自己的参数错误才算失败。
                 */
                const failed = tool === 'js' ? isJsErrorResult(result) : isErrorResultLocal(result);

                this.appendMessage({
                    id: generateId(),
                    role: 'tool',
                    content: thought || `调用 ${label}`,
                    reasoning: keepReasoning(liveReasoning),
                    tool,
                    // 显示文案会被 thought 顶掉，而 label 是**稳定**的那一份：重建上下文时
                    // 若只按 tool 写回，模型在历史里看不出这一步做的是列清单还是存脚本。
                    label,
                    // js 跑的源码存下来供界面展开查看；其它工具没有源码。
                    script: tool === 'js' ? asString(args.code) : undefined,
                    ok: !failed,
                    result,
                    // 用量挂在这条工具消息上而不是上一条 assistant：assistant 那条在这一步里
                    // 只是"决定要调用工具"的中间产物，用户真正会展开看的是这一步干了什么。
                    ...(stepUsage ? { usage: stepUsage } : {}),
                    at: Date.now(),
                });

                transcript.push({ role: 'user', content: toolObservation(label, result, !failed) });
            }
        } finally {
            this.busy = false;
            this.status = 'idle';
            this.streaming = null;
            this.emit();
        }
    }

    private stop(): void {
        this.stopped = true;
        // 真掐断在途请求。只置标志位的话，得等整包回来循环才会发现已停止 ——
        // 流式下这一点尤其明显：界面还在滚字，用户以为停止没生效。
        this.abort?.abort();
    }

    private clear(): void {
        // 运行中禁止清空：主循环正拿着 messages 追加，此刻清空后它的下一次
        // appendMessage 会把旧轮次"接"回来，界面表现为"清了但历史又冒出来"。
        if (this.busy) return;
        this.messages = [];
        this.error = '';
        this.streaming = null;
        this.persist();
        this.emit();
    }

    /**
     * 删除单条消息体。
     *
     * 与「回退」分开是有意的：删一条只动一条，用于清掉某次失败的探测、一条泄露了
     * 密钥的工具返回值；回退是从这条起往后全砍掉。
     */
    private removeMessage(id: string): void {
        if (this.busy) return;
        this.messages = this.messages.filter((m) => m.id !== id);
        this.persist();
        this.emit();
    }

    /**
     * 回退到某条消息**之前**：这条连同它之后的全部删掉，返回该条的提问原文。
     *
     * 切点就是用户点中的**那一条**，不按轮次往前扩 —— 一轮里的消息本就该能单独
     * 作废后半段：某轮模型连发了十来步工具，用户只想扔掉后面几步、留住前面那些
     * 还有用的探测结果，按整轮切会把有用的部分一起扔掉。
     */
    private rewindTo(id: string): string {
        if (this.busy) return '';
        const at = this.messages.findIndex((m) => m.id === id);
        if (at < 0) return '';

        const prompt = this.messages[at].role === 'user' ? this.messages[at].content : '';
        this.messages = this.messages.slice(0, at);
        // 上一轮留下的报错横幅属于被删掉的那一段，留着会指向不存在的东西
        this.error = '';
        this.persist();
        this.emit();
        return prompt;
    }

    private setCompactRatio(ratio: number): void {
        if (!(COMPACT_RATIOS as readonly number[]).includes(ratio)) return;
        this.compactRatio = ratio;
        void this.options.storage.save(COMPACT_RATIO_STORE_KEY, ratio).catch(() => undefined);
        this.emit();
    }

    /* ---------------------------------------------------------------------- */
    /* 压缩                                                                    */
    /* ---------------------------------------------------------------------- */

    /**
     * 把分界线之后的旧消息按当前档位压成结构化摘要。
     *
     * **只由用户手动触发，没有自动压缩。** 压缩是不可逆的历史改写加上一次模型
     * 调用，这两样代价都不该由程序替他决定。
     */
    private async compact(): Promise<AgentCompaction | null> {
        if (this.busy || this.compacting) return null;

        const list = this.messages;
        const { messages: live, summary: priorSummary } = splitByCompaction(list);
        const coverCount = compactCoverCount(live.length, this.compactRatio);
        if (coverCount < 1) return null;

        const covered = live.slice(0, coverCount);
        // 空消息不该出现在给用户看的消息数里，所以先滤掉再算条数
        const summarizable = covered
            .filter((m) => m.role !== 'tool' || m.result || m.content)
            .map((m) => [m]);
        const budgeted = trimToBudget(summarizable, COMPACT_INPUT_BUDGET_BYTES);
        const summarizedMessages = budgeted.length;

        /*
         * 刻意不叫 transcript：那是 send() 里"发给模型的本轮上下文"的名字，
         * 而这份是**送进摘要器的历史原文**，两者的生命周期与用途都不同。
         */
        const digest = priorSummary
            ? [{ role: 'user' as const, content: `${COMPACT_PREFIX}\n${priorSummary}` }, ...budgeted.flat().map(toChatMessage)]
            : budgeted.flat().map(toChatMessage);

        this.compacting = true;
        this.error = '';
        this.emit();
        try {
            let usage: AiUsage | undefined;
            const body = await this.options.chat.chat({
                system: COMPACT_SYSTEM_PROMPT,
                messages: digest,
                maxTokens: COMPACT_MAX_TOKENS,
                // 摘要要的是忠实，不是创意：温度压到最低能显著减少"顺手补全"的编造
                temperature: 0,
                reasoningEffort: 'low',
                signal: new AbortController().signal,
                onDelta: () => undefined,
                onUsage: (u) => {
                    usage = u;
                },
            });

            const summary = body.trim();
            // 空摘要不能落盘：那等于把一段历史换成了空白，而且没有任何提示
            if (!summary) {
                this.error = '压缩失败：模型没有返回摘要内容，历史未改动。';
                this.emit();
                return null;
            }

            const beforeTokens = contextTokensOf(list);
            const upTo = covered[covered.length - 1].id;
            const next: AgentCompaction = {
                summary,
                upTo,
                at: Date.now(),
                // 用 summarizable 而不是 covered：空消息不该出现在给用户看的消息数里
                coveredMessages: summarizable.length,
                summarizedMessages,
                beforeTokens,
                afterTokens: 0,
                overBudget: false,
            };

            /*
             * afterTokens 要按**压缩真正生效后**的消息序列算：那一刻新消息还没进
             * this.messages，只能先用同一个 insertAfterId 拼出来。不能只拿摘要的
             * token 数自己估 —— 保留的那些也占地方，漏掉它们会低估一大截，
             * 而 overBudget 的判据正是建立在这个数上。
             */
            const marker: AgentMessage = {
                id: generateId(),
                role: 'assistant',
                content: summary,
                compaction: next,
                // 摘要调用自身的用量挂在**这条消息**上，与其它每一步同一个位置。
                ...(usage ? { usage } : {}),
                at: next.at,
            };
            const after = insertAfterId(list, upTo, marker);
            next.afterTokens = contextTokensOf(after);
            next.overBudget = next.afterTokens >= CONTEXT_LIMIT_TOKENS;

            /*
             * 落盘前再确认一次锚点还在：压缩是异步的，这期间历史可能被改过。
             * 锚点没了还硬插，insertAfterId 会兜底追加到末尾，摘要就会名义上覆盖
             * **全部**历史 —— 保留的那些会被静默吞掉。丢弃这次摘要是安全方向。
             */
            if (!this.messages.some((m) => m.id === upTo)) {
                this.error = '压缩期间对话发生了变化，本次摘要已丢弃，历史未改动。';
                this.emit();
                return null;
            }
            this.messages = after;
            this.persist();
            // 成功后清掉报错：压缩在途时 send() 的拒绝会写一条"请稍候"，
            // 压缩完了它就过期了，指向一个已经不存在的状态。
            this.error = '';
            this.emit();

            return next;
        } catch (e) {
            this.error = `压缩失败：${errorText(e)}`;
            this.emit();
            return null;
        } finally {
            this.compacting = false;
            this.emit();
        }
    }

    /* ---------------------------------------------------------------------- */
    /* 脚本执行                                                                */
    /* ---------------------------------------------------------------------- */

    /**
     * 记一次脚本执行：更新卡片上的"最近执行"，并往对话流里落一条环境事件消息。
     *
     * **两个触发入口共用这一个记账点**（手动点运行 / urlPattern 自动执行）。
     * 分开写两份的后果不是"重复代码"那么轻：两份里任何一份漏掉 lastResult，
     * 用户就会看到"点了运行但卡片上没痕迹"，而另一份是好的。
     */
    private recordScriptRun(script: AgentScript, result: string, origin: AgentMessageOrigin): void {
        this.scripts = this.scripts.map((s) => (
            s.id === script.id ? { ...s, lastRunAt: Date.now(), lastResult: result } : s
        ));
        this.appendMessage({
            id: generateId(),
            role: 'tool',
            content: `${origin === 'manual' ? MANUAL_RUN_PREFIX : AUTO_RUN_PREFIX}${script.name}`,
            tool: 'js',
            // label 只说"做了什么"，来源由 origin 表达：两处都写来源时，
            // 界面的「自动」角标会和 label 里的「自动」叠成"自动·js·自动·x"
            label: `js·${script.name}`,
            // 环境事件：不属于任何一次模型调用，重建上下文时不能伪造成工具调用
            origin,
            script: script.code,
            ok: !isJsErrorResult(result),
            result,
            at: Date.now(),
        });
    }

    /**
     * 手动执行一条已保存脚本。
     *
     * 运行中拒绝：主循环正拿着页面跑模型的步骤，此刻手动执行会与它的下一步交错
     * 读页面，两边看到的状态互相污染。规则与改历史一致。
     */
    private async runScriptNow(id: string): Promise<string> {
        if (this.busy) return JSON.stringify({ error: 'Agent 正在运行，先停止再手动执行' });
        const script = this.scripts.find((s) => s.id === id);
        if (!script) return JSON.stringify({ error: '脚本不存在（可能已被删除）' });
        const result = await this.execActive(script.code);
        this.recordScriptRun(script, result, 'manual');
        return result;
    }

    private removeScript(id: string): void {
        this.scripts = this.scripts.filter((s) => s.id !== id);
        this.persist();
        this.emit();
    }

    private toggleScript(id: string): void {
        this.scripts = this.scripts.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
        this.persist();
        this.emit();
    }

    /**
     * 直接执行一段脚本，不走主循环。
     *
     * 给"手动运行一条已保存脚本"用：它不属于任何一次模型调用，走 dispatchTool
     * 反而会被 busy 闸门挡住。串行化仍由同一个队列保证 —— 这正是它必须留在
     * 引擎上的原因：换一条路径执行就等于绕开了"模型步骤与手动执行不交错"。
     */
    execForScript(tabId: number, code: string): Promise<string> {
        return this.execOnPage(tabId, code);
    }

    /** 直接导航。理由同上：脚本页的跳转也要走引擎的页面宿主 */
    async navigateForScript(tabId: number, url: string): Promise<{ url: string; loaded: boolean }> {
        return this.options.host.navigate(tabId, url);
    }

    /**
     * 页面就绪时跑一遍命中的脚本。
     *
     * 并发由 execOnPage 内的串行队列消化：模型步骤与自动脚本不会交错读页面，
     * 这里不需要再判 busy 而跳过 —— 跳过会漏掉命中的自动化，而排队只是晚一点跑。
     */
    async onPageReady(tabId: number, url: string): Promise<void> {
        if (!url) return;
        const hits = this.scripts.filter((s) => s.enabled && s.urlPattern && url.includes(s.urlPattern));
        if (hits.length === 0) return;
        for (const script of hits) {
            const result = await this.execOnPage(tabId, script.code);
            this.recordScriptRun(script, result, 'auto');
        }
    }
}

/* -------------------------------------------------------------------------- */
/* 局部工具                                                                    */
/* -------------------------------------------------------------------------- */

/** 非 js 工具的成败判据：错误只能由我们构造，任何非空 error 都是失败 */
const isErrorResultLocal = (result: string): boolean => {
    if (!result.startsWith('{')) return false;
    try {
        const parsed = JSON.parse(result) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        if (typeof parsed.__agentError === 'string' && parsed.__agentError.length > 0) return true;
        return typeof parsed.error === 'string' && parsed.error.length > 0;
    } catch {
        return false;
    }
};

/**
 * 一条展示记录 → 发给摘要器的消息。
 *
 * 摘要器要的是**历史原文**，所以这里比 buildTranscript 宽松：工具消息带上它的
 * 结果（那正是最该被概括的部分），而 assistant 的正文原样进。
 */
const toChatMessage = (message: AgentMessage): { role: 'user' | 'assistant'; content: string } => {
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'assistant') return { role: 'assistant', content: message.content };
    const label = message.label || message.tool || '工具';
    return { role: 'user', content: `[工具 ${label}]\n${message.result || message.content}` };
};

/** 把落盘数据收敛成合法脚本。坏数据丢掉而不是猜 */
const normalizeScript = (raw: unknown): AgentScript | null => {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Partial<AgentScript>;
    if (typeof item.code !== 'string' || !item.code.trim()) return null;
    return {
        id: typeof item.id === 'string' && item.id ? item.id : generateId(),
        name: (typeof item.name === 'string' && item.name.trim()) || '未命名脚本',
        description: asString(item.description),
        code: item.code,
        urlPattern: asString(item.urlPattern),
        enabled: item.enabled !== false,
        lastRunAt: typeof item.lastRunAt === 'number' ? item.lastRunAt : undefined,
        lastResult: typeof item.lastResult === 'string' ? item.lastResult : undefined,
    };
};
