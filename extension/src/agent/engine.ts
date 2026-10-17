import type {
    AgentCompaction,
    AgentMessage,
    AgentRunStatus,
    AgentState,
    AgentToolName,
    AgentUsage,
    AiChatMessage,
    AiUsage,
    ReasoningEffort,
    SandboxRequest,
    SandboxResult,
} from '../../../shared/meta';
import { generateId } from '../../../shared/core';
import type { AgentHost } from './host';
import {
    COMPACT_PREFIX,
    COMPACT_RATIO_DEFAULT,
    COMPACT_RATIO_STORE_KEY,
    COMPACT_RATIOS,
    COMPACT_SYSTEM_PROMPT,
    CONTEXT_LIMIT_TOKENS,
    MAX_PROTOCOL_ERRORS,
    MESSAGES_STORE_KEY,
    MESSAGES_STORE_MAX,
    STORE_BUDGET_MESSAGES,
    SYSTEM_PROMPT,
    compactCoverCount,
    contextFullMessage,
    requestTokensOf,
} from './prompt';
import {
    PROTOCOL_ERROR_LABEL,
    batchObservation,
    buildTranscript,
    insertAfterId,
    protocolErrorObservation,
    protocolErrorSummary,
    splitByCompaction,
    sumUsage,
} from './transcript';
import { asString, errorText, keepReasoning, trimToBudget } from './text';
import {
    buildScriptSource,
    extractCalls,
    extractJsonObject,
    isErrorResult,
    isJsErrorResult,
    locateScriptError,
    MAX_CALLS_PER_REPLY,
} from './parse';
import { dispatchTool } from './tools';

/**
 * Agent 引擎。
 *
 * ## 为什么是一个普通类
 *
 * 两个理由都来自它自己会做的事：
 *
 * 1. **它的 navigate 工具会换页**。挂在页面里的话（内容脚本、注入的脚本），
 *    换页会重跑整个脚本，主循环当场死掉 —— 而"跨页继续"正是 Agent 存在的
 *    意义之一。
 * 2. **它必须在没有界面的情况下继续跑**。球收起、用户切到别的标签页，循环都该
 *    继续。挂在某个组件的生命周期上做不到这一点。
 *
 * 所以它是一个普通的状态机：构造时给宿主、存储、模型、沙箱四个端口，之后靠
 * `onSnapshot` 回调把快照推出去。测试里可以直接 new 出来跑，不需要 React、不需要 DOM。
 *
 * ## 与 `AgentState` 的关系
 *
 * 快照形状就是 `AgentState`（悬浮球按它渲染），只**多了一个 `revision`**：
 * 条数不变的改写（同一段历史被重算）在界面侧看不出变化，带一个单调递增的序号
 * 最省事。
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
 * 引擎跑在 service worker 里（它挂的宿主 `page-host` 要 `chrome.tabs` /
 * `chrome.cookies` / `chrome.debugger` 这一整套 API），而**模型调用不能在那里发**：
 * 一次流式补全可能持续几分钟，SW 空闲约 30 秒就被回收，它是否会被"在途 fetch"
 * 续命没有可实测的依据。
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
        reasoningEffort?: ReasoningEffort;
        signal: AbortSignal;
        onDelta: (delta: { content?: string; reasoning?: string }) => void;
        onUsage: (usage: AiUsage) => void;
    }) => Promise<string>;
}

interface EngineOptions {
    host: AgentHost;
    storage: EngineStorage;
    chat: ChatPort;
    /**
     * 本机沙箱端口（`sandbox` 工具的实现）。
     *
     * **不放 `AgentHost`**：那一层是"页面宿主"的抽象（见 host.ts 的文件头），
     * 而沙箱既不认识 tab，也不碰 chrome.* —— 它唯一的通路是过桥到桌面应用。
     * 混进去会让 pageHost 背上与页面无关的能力。
     */
    sandbox: (request: SandboxRequest) => Promise<SandboxResult>;
    /**
     * 增量回调。流式输出的每个分片都走它 ——
     * 整个快照太大，逐字重发不现实。
     */
    onDelta: (delta: { content?: string; reasoning?: string }) => void;
    /** 快照变更回调 */
    onSnapshot: (snapshot: EngineSnapshot) => void;
}

export class AgentEngine {
    private readonly options: EngineOptions;

    private messages: AgentMessage[] = [];

    /**
     * 上一轮的上下文重建。键是数组身份，理由见 contextOf
     */
    private contextCache: { messages: AgentMessage[]; transcript: AiChatMessage[]; tokens: number } | null = null;

    /**
     * 主循环在途时，**真正要发出去的那一份**的 token 数；空闲时是 null。
     *
     * 与 `contextCache.tokens` 不是一回事，两者在轮内会差出一大截：轮内的
     * transcript 每步都追加模型那条完整 JSON 回复（含整份 args.code），而重建
     * messages 时工具消息只回放 label + result，脚本源码一个字都不进。
     *
     * 写入只有两处：循环顶部（每次请求前重算）与 finally 里的复位。读者是轮内
     * 闸门与快照 —— 门槛与界面上显示的那个数必须是同一个，否则用户会看到
     * "上下文 1.7k"然后突然被告知已满。
     *
     * 复位放在 finally 里，而不是每个 break 之前：循环有八处出口（三处"已停止"、
     * 上下文越线、调用中断、收尾、协议错误超限、空回复），漏一处就会让下一轮
     * 一开始就拿着上一轮的旧数，判"已满"而拒绝一切提问。
     */
    private liveTokens: number | null = null;

    private status: AgentRunStatus = 'idle';
    private error = '';
    private compacting = false;
    private compactRatio = COMPACT_RATIO_DEFAULT;
    private revision = 0;

    private busy = false;
    private stopped = false;
    private abort: AbortController | null = null;
    /**
     * 在途的压缩调用。
     *
     * 与 `abort` 分开：压缩不是"一轮"，它可以在空闲时发起，也不该被 send() 开头
     * 的重置碰掉。但**停止必须够得着它** —— 原先这里传的是 `new AbortController().signal`，
     * 一个没有人持有的控制器，于是 stop() 永远碰不到它。
     */
    private compactAbort: AbortController | null = null;

    /**
     * 脚本执行的串行队列。
     *
     * `Runtime.evaluate` 的并发语义不可靠：两段脚本交错读页面时，双方看到的都是
     * 对方改了一半的状态。串行后"谁先谁后"有明确顺序，排查时能复现。
     * 队列自身吞掉异常 —— 某一次失败不能把排在后面的全部卡死。
     */
    private execChain: Promise<unknown> = Promise.resolve();

    /**
     * 动作表。**只建一次**，快照原样带上它。
     *
     * 它只是一组指向本实例方法的闭包，内容不随状态变 —— 以前在 `snapshot()` 里
     * 现建：每推一版快照就扔掉 7 个函数对象，而调用方拿它只是为了**调一个动作**
     * （service worker 的 `agent-action` 转发端点），根本不需要先算一版快照。
     *
     * 界面拿不到它（过桥时 JSON 会丢掉函数，见 agent-bridge），这是有意的：
     * 球驱动引擎的唯一通路是 `agent-action` 端点，而不是拿到函数直接调。
     */
    readonly actions: AgentState['actions'] = {
        send: (prompt) => this.send(prompt),
        stop: () => this.stop(),
        clear: () => this.clear(),
        removeMessage: (id) => this.removeMessage(id),
        rewindTo: (id) => this.rewindTo(id),
        compact: () => this.compact(),
        setCompactRatio: (ratio) => this.setCompactRatio(ratio),
    };

    constructor(options: EngineOptions) {
        this.options = options;
    }

    /* ---------------------------------------------------------------------- */
    /* 生命周期                                                                */
    /* ---------------------------------------------------------------------- */

    /**
     * 从存储恢复。构造之后必须先 await 它，否则第一次快照是空的。
     *
     * 读进来的每条都要过 isStoredMessage：存储是外部输入，一条坏记录足以让
     * buildTranscript 抛错，而那时界面连「清空」都点不了（见 isStoredMessage）。
     */
    async hydrate(): Promise<void> {
        const [messages, ratio] = await Promise.all([
            this.options.storage.load<AgentMessage[]>(MESSAGES_STORE_KEY, []),
            this.options.storage.load<number>(COMPACT_RATIO_STORE_KEY, COMPACT_RATIO_DEFAULT),
        ]);

        this.messages = Array.isArray(messages) ? messages.filter(isStoredMessage) : [];
        this.compactRatio = (COMPACT_RATIOS as readonly number[]).includes(ratio)
            ? ratio
            : COMPACT_RATIO_DEFAULT;

        this.emit();
    }

    /**
     * 上下文重建与它的 token 数 —— **按 messages 的数组身份缓存**。
     *
     * 这两样每次推快照都要用（快照里带着上下文占用，`send()` 还要拿重建结果当
     * 历史），而重建一次要把全部历史重新拼装一遍再逐字符估一遍 token：一份
     * 1.5MB 的历史上是 7ms（实测），与一版快照同价。emit 在一步里要被叫好几遍
     * —— 状态变化、追加消息、落盘 —— 其中只有历史**真的变了**的那一次需要重算。
     *
     * 缓存键取数组身份而不是内容：`messages` 每次变更都是整体替换（追加、删除、
     * 回退、清空、压缩、hydrate），身份变了就等于内容变了，逐字段比对纯属浪费。
     * 失效条件也只有这一个 —— 这个函数的输入就只有 messages。
     */
    private contextOf(messages: AgentMessage[]): { transcript: AiChatMessage[]; tokens: number } {
        if (this.contextCache?.messages === messages) return this.contextCache;
        const transcript = buildTranscript(messages);
        this.contextCache = { messages, transcript, tokens: requestTokensOf(transcript) };
        return this.contextCache;
    }

    /**
     * 下一次请求会带上多少 token —— **门槛与界面共用这一个数**。
     *
     * 主循环在跑时是 `liveTokens`（本轮真正要发出去的那一份），空闲时退回按
     * messages 重建的结果（下一轮要发的就是它）。两者在轮内会差一大截，理由见
     * liveTokens 的注释。
     */
    private contextTokens(): number {
        return this.liveTokens ?? this.contextOf(this.messages).tokens;
    }

    snapshot(): EngineSnapshot {
        const contextTokens = this.contextTokens();
        const usage: AgentUsage = sumUsage(this.messages, contextTokens);
        return {
            messages: this.messages,
            status: this.status,
            error: this.error,
            /*
             * 判据是 busy 与 compacting，**不是 status**。
             *
             * send() 一开始就把 busy 置真，而 status 要等第一次请求发出才变
             * thinking：按 status 判的话，"提问刚进对话"那一刻推出去的快照会说
             * 可以编辑，可主循环已经拿着 messages 在跑了 —— 按钮显示为可用，
             * 点下去却什么也不会发生（改写历史的闸门是 busy）。
             *
             * compacting 同样必须在里面：三个改历史的动作都拦它（见 locked），
             * 这里少写一项，快照就会说"能改"而动作拒绝。
             */
            canEdit: !this.locked(),
            usage,
            contextFull: contextTokens >= CONTEXT_LIMIT_TOKENS,
            canCompact: compactCoverCount(splitByCompaction(this.messages).messages.length, this.compactRatio) >= 1,
            compacting: this.compacting,
            compactRatio: this.compactRatio,
            actions: this.actions,
            revision: this.revision,
        };
    }

    private emit(): void {
        this.revision += 1;
        this.options.onSnapshot(this.snapshot());
    }

    /**
     * 现在能不能改历史。**快照与三个动作共用这一个判据。**
     *
     * 曾经写成两处：快照判 `!busy && !compacting`，动作只判 `busy`。于是压缩
     * 在途时界面把按钮禁掉，而程序化路径（`agent-action` 桥端点）照样能删能清 ——
     * 用户看到的是"灰着却能生效"，比两种行为都糟。
     *
     * 压缩为什么必须锁：摘要调用的 digest 与 upTo 是开始那一刻算的，这期间
     * 历史一变，这次调用就白跑（锚点没了会自愈成丢弃，但白花一次调用）。
     * 而压缩是用户自己点的、明知要等几十秒，锁住比"让他改完再重压"更省事。
     */
    private locked(): boolean {
        return this.busy || this.compacting;
    }

    /* ---------------------------------------------------------------------- */
    /* 持久化                                                                  */
    /* ---------------------------------------------------------------------- */

    /**
     * 落盘。**不 await**：它挂在每个 appendMessage 后面，而写 storage 是异步的，
     * await 会让主循环每追加一条消息就多等一个来回。
     *
     * 失败静默吞掉（`catch` 里连日志都没有）：配额满了的时候，用户最不该看到的是
     * "对话进行到一半整个卡住"。代价是写入失败时界面只表现为"历史不再保存" ——
     * 这条取舍是有意的，不是遗漏；要让它可查得先有一个界面上的落盘失败提示。
     */
    private persist(): void {
        const messages = trimToBudget(this.messages, STORE_BUDGET_MESSAGES).slice(-MESSAGES_STORE_MAX);
        void this.options.storage.save(MESSAGES_STORE_KEY, messages).catch(() => undefined);
    }

    /**
     * 追加消息。**追加的写入口只有这一个**，`messages` 变了就要落盘、就要推快照
     * 这条不变式在这里维护一次（其余五处是整体替换：清空 / 删除 / 回退 / 压缩 /
     * hydrate，各自也都走 persist + emit）。
     *
     * 收数组而不是单条，是因为一批工具调用是**一步**：逐条追加会让界面按条数
     * 连跳几下（而它们本就是同一步发生的事），落盘那头也变成 N 次写、每次都要
     * 把整份历史重算一遍体积预算。
     */
    private appendMessages(messages: AgentMessage[]): void {
        if (messages.length === 0) return;
        this.messages = [...this.messages, ...messages];
        this.persist();
        this.emit();
    }

    /** 单条追加，就是上面那个的退化情形 */
    private appendMessage(message: AgentMessage): void {
        this.appendMessages([message]);
    }

    /* ---------------------------------------------------------------------- */
    /* 页面执行                                                                */
    /* ---------------------------------------------------------------------- */

    /**
     * 在页面里执行一段代码，走串行队列。
     *
     * **返回值原样回传，不设字节上限。** 页面返回可能上兆，而模型窗口能装多少
     * 是用户配置里的事实 —— 在这儿定一个数等于替他假设，代价是把一条观察静默
     * 换掉一半（模型拿到半截 JSON 还得重跑一次）。提示词里改为如实说明代价：
     * 返回什么就会随后续每一步重发，所以该只要需要的字段。
     */
    private execOnPage(tabId: number, code: string): Promise<string> {
        const task = async (): Promise<string> => {
            /*
             * 超时由宿主负责 race：`Runtime.evaluate` 没有 abort，页面死循环时
             * 那个 Promise 永远不 settle。宿主返回失败结果，这里只负责把队列
             * 推进下去 —— 后返回的结果会被丢弃，队列不会因此卡住。
             */
            const result = await this.options.host.evaluate(tabId, buildScriptSource(code));
            // 宿主拿到的是**包装后**源码的行号，这里换算回模型自己写的行
            return locateScriptError(result, code);
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
            // 走 `__agentError`：这是**我们**的失败，与页面返回的 `{error:"..."}`
            // 业务字段必须分开（判据见 isJsErrorResult）。
            return JSON.stringify({ __agentError: '当前没有可用的页面（标签页是空白页或未就绪）' });
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
         * 界面已禁用输入框，但不能只靠界面：任何直接调 `actions.send` 的路径
         * （`agent-action` 桥端点、测试）都会绕过 disabled。在唯一的入口处
         * 拦一次才是真正的保证。
         */
        if (this.contextTokens() >= CONTEXT_LIMIT_TOKENS) {
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
        const history = this.contextOf(this.messages).transcript;
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

                /*
                 * 轮内门槛量的必须是**真正要发出去的那一份**，也就是 transcript，
                 * 不是 `contextOf(messages)`。
                 *
                 * 两者不等价，而且差的正是最容易撑爆的那一块：transcript 里每步
                 * 都追加模型那条**完整 JSON 回复**（含整份 args.code），而重建
                 * messages 时工具消息只回放 label + result，脚本源码一个字都不进
                 * （见 roundToMessages）。按重建量的话，"模型每步写一个大脚本"
                 * 这条路永远量不到 —— 实测连发 3 步 90 万字符的脚本，实际发出
                 * 180 万 token，引擎自报仍是 1707，error 为空。超限最后由服务商
                 * 报，而那时三条 90 万字符的 script 已经落盘了。
                 */
                this.liveTokens = requestTokensOf(transcript);
                if (this.liveTokens >= CONTEXT_LIMIT_TOKENS) {
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
                this.emit();

                // 增量累积在局部变量里，等这一步结束再整块落进消息列表：
                // 每个分片都推一次快照会让长回复卡住渲染。实时滚字由 onDelta 负责。
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
                    this.emit();
                }

                if (this.stopped) break;
                transcript.push({ role: 'assistant', content: reply });

                const call = extractJsonObject(reply);
                const { calls, written } = extractCalls(call);
                /** 这一步的意图，只用于界面显示（不参与任何判据） */
                const intent = asString(call?.intent);

                /**
                 * 没有可执行的调用 —— 三种情况必须分开处置，混为一谈会让 Agent
                 * 在最需要自救的时候停下来：
                 *
                 * 1. **模型明确收尾**（给了 final）：正常结束，落一条回答。
                 * 2. **协议错误**（没给 final，也没给出可执行的 calls）：这不是"它说完了"，
                 *    而是**这一步没做成**。直接当成普通文本收尾，等于把一次失败的
                 *    调用当成结论交给用户。必须把错误回灌让它改。
                 * 3. **空回复**：推理模型偶发，回灌也无从改起，如实提示后停止。
                 */
                if (calls.length === 0) {
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

                    /*
                     * 走到这里：既没有 final 也没有可执行的调用。有正文内容才算协议错误 ——
                     * 空回复回灌一句"你没输出"它也变不出内容来，那是浪费一次调用。
                     *
                     * 两条文案喂**同一段** trim 过的正文：它们各自调 diagnoseReply，
                     * 而诊断里的字符偏移是相对传进去的那段文本算的 —— 一处给原文、
                     * 一处给 trim 过的，同一次错误就会对用户说"第 120 个字符"、
                     * 对模型说"第 118 个"。
                     */
                    const badReply = reply.trim();
                    if (badReply) {
                        protocolErrors += 1;

                        /*
                         * 界面上那条记录只说"哪儿错了"，不贴整条原文。
                         *
                         * 回灌给模型的观察里带全文（protocolErrorObservation），
                         * 那是它自查的依据；而这条记录是给**人**看的，原文动辄
                         * 几千字，贴上去会把对话流冲得没法读。两处用途不同，
                         * 所以取的内容也不同 —— 但都出自同一个诊断函数。
                         */
                        this.appendMessage({
                            id: generateId(),
                            role: 'tool',
                            content: protocolErrorSummary(badReply),
                            reasoning: keepReasoning(liveReasoning),
                            label: PROTOCOL_ERROR_LABEL,
                            ok: false,
                            result: badReply,
                            ...(stepUsage ? { usage: stepUsage } : {}),
                            at: Date.now(),
                        });

                        transcript.push({ role: 'user', content: protocolErrorObservation(badReply) });

                        if (protocolErrors >= MAX_PROTOCOL_ERRORS) {
                            this.appendMessage({
                                id: generateId(),
                                role: 'assistant',
                                /*
                                 * 收尾必须**同时**说清"发生了什么事"与"你可以怎么办"。
                                 * 原话只有"换个更明确的说法"，而这里的成因几乎总是
                                 * 回复超长被截断 —— 那不是用户措辞的问题，
                                 * 让他去改措辞等于把人支到错的方向上。
                                 */
                                content: `连续 ${MAX_PROTOCOL_ERRORS} 次没有按输出协议回复，已停止。`
                                    + '常见原因是单步内容太长（一次塞了整份脚本或整篇文档）'
                                    + '撞上输出长度上限，回复被截断成半个 JSON。'
                                    + '可以再说一次，或把任务拆成几步让它一次只做一件。',
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

                this.status = 'acting';
                this.emit();

                /*
                 * 一批调用是**一步**：先把它们全部发出去，再按声明顺序收结果。
                 *
                 * 不给每条观察各发一次 emit —— 一批里改三次界面，用户看到的是
                 * 列表连跳三下，而它们本就是同一步发生的事。
                 *
                 * 并发只对非 js 工具成立：js 必须走 execActive 的串行队列
                 * （`Runtime.evaluate` 并发语义不可靠，两段脚本交错会互相看到
                 * 对方改了一半的页面）。这不是遗憾而是取舍 —— 模型要的是
                 * "一次回复里能派几件事"，不是"几段脚本同时跑"。
                 */
                const batch = await Promise.all(calls.map(async (one) => {
                    const tool = one.tool as AgentToolName;

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
                        result = await dispatchTool(tool, one.args, {
                            host: this.options.host,
                            exec: (code) => this.execActive(code),
                            sandbox: this.options.sandbox,
                        });
                    } catch (e) {
                        // 异常也走 `__agentError`：js 这条路径上它是唯一被认作失败的
                        // 通道（页面返回的 {error} 是业务数据，见 isJsErrorResult）
                        const text = `工具 ${tool} 执行时抛出异常：${errorText(e)}`;
                        result = tool === 'js'
                            ? JSON.stringify({ __agentError: text })
                            : JSON.stringify({ error: text });
                    }

                    // 日志只写工具名会分不清模型做的是哪件事
                    // （读写删改查语法都是 "sandbox"）。
                    const rawAction = asString(one.args.action);
                    const label = tool === 'sandbox' && rawAction ? `${tool}·${rawAction}` : tool;

                    /**
                     * 失败判据按工具分岔，因为"什么算失败"对两者本就不同：
                     * js 的返回值是**页面数据**，`{error:"..."}` 是探测到的业务字段，
                     * 只有 `__agentError` 算失败；其余工具的错误对象只可能由我们自己
                     * 构造，`{error}` 就是失败。
                     */
                    const failed = tool === 'js' ? isJsErrorResult(result) : isErrorResult(result);
                    return { tool, label, result, ok: !failed };
                }));

                // 用户在一批跑到一半时点停止：后面的调用已经发出去了，收不回来，
                // 但结果不必再落进对话流 —— 他刚说了不要。
                if (this.stopped) break;

                // 这一步真的执行了（无论成败），协议错误计数归零 ——
                // 判据是"模型能不能正确表达调用意图"，它已经表达对了。
                protocolErrors = 0;

                /*
                 * 一批的展示记录**一次性**写进列表（见 appendMessages）：
                 * 这一步是一次请求换回来的一批结果，界面该看到的是列表一次到位，
                 * 而不是按条数闪几下。
                 *
                 * `at` 也只取一个时刻：同一步的几条记录带上毫秒级的先后差，
                 * 读历史的人会以为它们是两件事。
                 */
                const at = Date.now();
                const created: AgentMessage[] = [];
                for (const [index, item] of batch.entries()) {
                    created.push({
                        id: generateId(),
                        role: 'tool',
                        /*
                         * 显示文案用 intent，逐条带上序号。
                         *
                         * 一批里的每一条都出自**同一个** intent（一次回复只有一个），
                         * 不编号的话列表上会出现几条一模一样的记录，用户分不清
                         * 哪条对应哪次调用。而 label 是**稳定**的那一份：重建上下文时
                         * 若只按 tool 写回，模型在历史里看不出这一步做的是读文件还是改文件。
                         */
                        content: intent
                            ? (batch.length > 1 ? `${intent}（${index + 1}/${batch.length}）` : intent)
                            : `调用 ${item.label}`,
                        reasoning: keepReasoning(liveReasoning),
                        tool: item.tool,
                        label: item.label,
                        // js 跑的源码存下来供界面展开查看；其它工具没有源码。
                        script: item.tool === 'js' ? asString(calls[index].args.code) : undefined,
                        ok: item.ok,
                        result: item.result,
                        // 用量挂在这条工具消息上而不是上一条 assistant：assistant 那条在这一步里
                        // 只是"决定要调用工具"的中间产物，用户真正会展开看的是这一步干了什么。
                        // 一批里的几条共用同一次调用的用量，只记在**第一条**上 —— 每条都挂一份，
                        // 累计用量（sumUsage）会把一次调用算成 N 次，而那个数用户是拿来核账单的。
                        ...(stepUsage && index === 0 ? { usage: stepUsage } : {}),
                        at,
                    });
                }
                this.appendMessages(created);

                transcript.push({
                    role: 'user',
                    content: batchObservation(
                        batch,
                        // 写多了几个、有几个没写工具名：两种"你写的比跑的多"都要说，
                        // 否则模型只会看到结果比它写的少，以为工具坏了再发一遍。
                        written > batch.length
                            ? `你这一步写了 ${written} 个调用，其中 ${batch.length} 个被执行`
                                + `（一批最多 ${MAX_CALLS_PER_REPLY} 个，且每一项都必须带 tool 名）。`
                            : '',
                    ),
                });
            }
        } finally {
            this.busy = false;
            this.status = 'idle';
            // 本轮结束了，下一次请求要发的是重建出来的历史 —— 交还给 contextTokens
            this.liveTokens = null;
            this.emit();
        }
    }

    private stop(): void {
        this.stopped = true;
        // 真掐断在途请求。只置标志位的话，得等整包回来循环才会发现已停止 ——
        // 流式下这一点尤其明显：界面还在滚字，用户以为停止没生效。
        this.abort?.abort();
        // 压缩是独立于主循环的一次调用（空闲时也能发起），同一个按钮也该能掐断它。
        // 不掐的话用户点了停止只能干等 —— 摘要调用可能跑几十秒。
        this.compactAbort?.abort();
    }

    private clear(): void {
        // 运行中禁止清空：主循环正拿着 messages 追加，此刻清空后它的下一次
        // appendMessage 会把旧轮次"接"回来，界面表现为"清了但历史又冒出来"。
        // 压缩中同理（见 locked）：那次摘要调用的锚点会指向已经不存在的历史。
        if (this.locked()) return;
        this.messages = [];
        this.error = '';
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
        if (this.locked()) return;
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
        if (this.locked()) return '';
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
     * 把现存消息（分界线之后的那一段）按当前档位压成结构化摘要。
     *
     * **只由用户手动触发，没有自动压缩。** 压缩是不可逆的历史改写加上一次模型
     * 调用，这两样代价都不该由程序替他决定。
     *
     * 已有摘要时它作为前缀一起进摘要器：这次覆盖的是"上一次摘要 + 新的一段"，
     * 所以压第二次不会把第一次的结论丢掉。
     */
    private async compact(): Promise<AgentCompaction | null> {
        if (this.busy || this.compacting) return null;

        const list = this.messages;
        const { messages: live, summary: priorSummary } = splitByCompaction(list);
        const coverCount = compactCoverCount(live.length, this.compactRatio);
        if (coverCount < 1) return null;

        const covered = live.slice(0, coverCount);
        /*
         * 空消息不进摘要器，也不计入给用户看的条数。
         *
         * 覆盖区**整段**进摘要器，不按体积裁剪：裁掉的那部分既没进摘要、又落在
         * 分界线之前 —— 等于压缩时静默丢掉一段历史。摘要器装不下就让它失败：
         * catch 里如实报出，历史一个字不动。
         */
        const summarizable = covered.filter((m) => m.role !== 'tool' || m.result || m.content);

        /*
         * 刻意不叫 transcript：那是 send() 里"发给模型的本轮上下文"的名字，
         * 而这份是**送进摘要器的历史原文**，两者的生命周期与用途都不同。
         */
        const digest = priorSummary
            ? [{ role: 'user' as const, content: `${COMPACT_PREFIX}\n${priorSummary}` }, ...summarizable.map(toChatMessage)]
            : summarizable.map(toChatMessage);

        this.compacting = true;
        this.error = '';
        this.emit();
        const controller = new AbortController();
        this.compactAbort = controller;
        try {
            let usage: AiUsage | undefined;
            const body = await this.options.chat.chat({
                system: COMPACT_SYSTEM_PROMPT,
                messages: digest,
                /*
                 * **不指定输出上限**。摘要不会比它的输入更长，而输入能不能装下
                 * 由模型窗口决定；在这里定一个数只会在摘要写长时把它从中间切断，
                 * 而切断后的摘要是要**替换掉那段历史**的 —— 又是静默丢内容。
                 * 与主循环那条路径一样，输出上限交给服务商/模型的默认值。
                 */
                // 摘要要的是忠实，不是创意：温度压到最低能显著减少"顺手补全"的编造
                temperature: 0,
                /*
                 * **不指定档位**：与主循环那条路径一致，档位由配置决定
                 * （AiService.resolveReasoningEffort 的 `requested || config.reasoningEffort`）。
                 * 在这里写死一个档位，等于让插件维护第三份模型配置，
                 * 用户在设置里选了什么都盖不过它。
                 */
                signal: controller.signal,
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

            const beforeTokens = this.contextOf(list).tokens;
            const upTo = covered[covered.length - 1].id;
            const next: AgentCompaction = {
                summary,
                upTo,
                at: Date.now(),
                coveredMessages: summarizable.length,
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

            /*
             * 锚点必然还在 —— 这是**不变式检查**，不是绕开某条路径的兜底。
             *
             * 压缩期间 `locked()` 挡住了 send / clear / removeMessage / rewindTo，
             * appendMessages 只被 send 调用，hydrate 只在构造后跑一次 —— 所以从
             * upTo 算出来到这里，那条消息一定还在。真丢了只可能是锁被绕过。
             *
             * 那时必须丢弃摘要：insertAfterId 找不到锚点会兜底追加到末尾，摘要
             * 就名义上覆盖**全部**历史 —— 保留区被静默吞掉，比白花一次调用严重
             * 得多。
             */
            if (!this.messages.some((m) => m.id === upTo)) {
                this.error = '压缩期间对话发生了变化，本次摘要已丢弃，历史未改动。';
                this.emit();
                return null;
            }

            /*
             * 拼接用**现在**的 messages，不用开始那一刻拍的 list。
             *
             * 这一条同样是给"锁被绕过"留的：list 里那条若已被删掉，拿它拼出来的
             * after 赋值回去等于把用户刚删的东西静默复活。用当前列表拼接，最少
             * 保住"已经删掉的不会回来"这个性质。
             */
            const after = insertAfterId(this.messages, upTo, marker);
            next.afterTokens = this.contextOf(after).tokens;
            next.overBudget = next.afterTokens >= CONTEXT_LIMIT_TOKENS;

            this.messages = after;
            this.persist();
            // 成功后清掉报错：压缩在途时 send() 的拒绝会写一条"请稍候"，
            // 压缩完了它就过期了，指向一个已经不存在的状态。
            this.error = '';
            this.emit();

            return next;
        } catch (e) {
            /*
             * 用户点了停止掐断的这次压缩**不报错**：与主循环那条路径同一个判据
             * （见 send 里 `aborted` 那段）—— 中止是用户的动作，不是失败，
             * 而历史一个字没动。报一条"压缩失败：已停止"只会让人以为出了事。
             *
             * 失败必须说清"历史未改动"。最可能的失败原因是这次输入超过了所配
             * 模型的窗口 —— 那正是用户要自己判断的事（换档位 / 分几次压 /
             * 清空），而报错原文里带着服务端给出的实测数字。这里**不替他做
             * 任何裁剪**：少喂一点换"这次成功"，代价是静默丢掉一段历史。
             */
            const aborted = e instanceof Error && e.name === 'AbortError';
            if (!aborted) this.error = `压缩失败：${errorText(e)}（历史未改动）`;
            this.emit();
            return null;
        } finally {
            this.compactAbort = null;
            this.compacting = false;
            this.emit();
        }
    }
}

/**
 * 存储里的一条记录是不是能用的 `AgentMessage`。
 *
 * 存储是**外部输入**（上一版插件写的、用户手改的、同 origin 的别的代码写的），
 * 而 `hydrate` 曾经只做 `Array.isArray` 就整份收下。一条 `null` 的代价实测过：
 * `buildTranscript` 抛 "Cannot read properties of null"，于是 `hydrate` 抛、
 * `snapshot()` 也抛 —— 界面拿不到快照，消息列表为空，「清空」按钮恒为 disabled，
 * 用户连自救的入口都没有，只能手动清 `chrome.storage.local`。
 *
 * 判据只查**重建上下文真正会碰到的字段**，不追求完整校验：
 * 少一个可选字段（reasoning / script / usage）不影响任何读法，多校验一遍只是
 * 给未来的字段加一道忘改就失效的门。
 *
 * 代价是**静默**：被滤掉的记录不会告诉用户，历史看起来就像少了几条。要让它
 * 可见得先在界面上有一个"有 N 条记录读不出来"的位置，而不是在这里改成抛错
 * （那会让整份历史都打不开）。
 */
const isStoredMessage = (value: unknown): value is AgentMessage => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const m = value as Record<string, unknown>;
    if (typeof m.id !== 'string' || !m.id) return false;
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') return false;
    // content 会被 estimateTokens 逐字符遍历，不是字符串就当场炸
    if (typeof m.content !== 'string') return false;
    if (typeof m.at !== 'number') return false;
    // 压缩记录的形状由 splitByCompaction 直接读 summary
    if (m.compaction !== undefined) {
        const c = m.compaction as Record<string, unknown> | null;
        if (!c || typeof c !== 'object' || typeof c.summary !== 'string') return false;
    }
    return true;
};

/* -------------------------------------------------------------------------- */
/* 局部工具                                                                    */
/* -------------------------------------------------------------------------- */

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
