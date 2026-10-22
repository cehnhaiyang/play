import type {
    AgentCompaction,
    AgentMessage,
    AgentRunStatus,
    AgentSessionMeta,
    AgentState,
    AgentToolName,
    AgentUsage,
    AiChatMessage,
    AiReply,
    AiToolSpec,
    AiUsage,
    ReasoningEffort,
    SandboxRequest,
    SandboxResult,
} from '../../../shared/meta';
import { AGENT_SESSION_TITLE_MAX, agentSessionTitle, generateId } from '../../../shared/core';
import type { AgentHost } from './host';
import {
    COMPACT_PREFIX,
    COMPACT_RATIO_DEFAULT,
    COMPACT_RATIO_STORE_KEY,
    COMPACT_RATIOS,
    COMPACT_SYSTEM_PROMPT,
    CONTEXT_LIMIT_TOKENS,
    LEGACY_MESSAGES_STORE_KEY,
    MAX_PROTOCOL_ERRORS,
    MAX_SESSIONS,
    MESSAGES_STORE_MAX,
    SESSIONS_STORE_KEY,
    STORE_BUDGET_MESSAGES,
    SYSTEM_PROMPT,
    compactCoverCount,
    contextFullMessage,
    requestTokensOf,
    sessionMessagesKey,
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
    toolObservation,
} from './transcript';
import { asString, errorText, keepReasoning, trimToBudget } from './text';
import {
    buildScriptSource,
    extractCalls,
    isErrorResult,
    isJsErrorResult,
    locateScriptError,
    parseArguments,
} from './parse';
import { AGENT_TOOLS } from './toolspec';
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
 *
 * ## 会话
 *
 * 对话历史是**多条**的：每条一个 id，`messages` 只是当前那条的本体。切会话不新建
 * 引擎、也不清空任何东西 —— 它换的是"`messages` 指向哪份历史"，以及把这一份从
 * 存储里读出来。运行中不许切（见 switchSession）：主循环正拿着这个数组追加。
 */

/** 引擎推给界面的快照 */
export interface EngineSnapshot extends AgentState {
    revision: number;
}

/** 持久化端口。抽出来是为了测试里能换成内存实现 */
export interface EngineStorage {
    load: <T>(key: string, fallback: T) => Promise<T>;
    save: (key: string, value: unknown) => Promise<void>;
    /**
     * 删掉一个键。
     *
     * 只有两处用它：删掉一条会话时连它的历史一起删、以及迁移上一版单会话的键。
     * 少了这一口，那两处都只能改写成一个空数组 —— 而配额照样被那份没人读的数据
     * 占着，配额正是会话数上限的出处（见 prompt.ts 的 MAX_SESSIONS）。
     */
    remove: (key: string) => Promise<void>;
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
        /** 可调用的工具。传了它，服务商用自己的结构化通道产出调用 */
        tools?: AiToolSpec[];
        toolChoice?: 'auto' | 'none' | 'required';
        signal: AbortSignal;
        onDelta: (delta: { content?: string; reasoning?: string }) => void;
        onUsage: (usage: AiUsage) => void;
    }) => Promise<AiReply>;
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

    /**
     * 当前会话的消息。
     *
     * 只有这一份在内存里 —— 别的会话的本体留在存储里，切过去时才读（见
     * switchSession）。全部装进内存的话，6 条会话就是十几 MB 常驻。
     */
    private messages: AgentMessage[] = [];

    /**
     * 全部会话的元信息，以及当前是哪一条。**两者缺一不可**：会话列表要画出来，
     * 而"当前这条"决定了 `messages` 是哪个数组的家。
     *
     * 至少一条（不变式，见 deleteSession 的拒绝条件）：没有会话时，用户按下发送
     * 就没有地方可落 —— 那是一个连"清空"都救不回来的状态。
     */
    private sessions: AgentSessionMeta[] = [];
    private activeId = '';

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
        newSession: () => this.newSession(),
        switchSession: (id) => this.switchSession(id),
        renameSession: (id, title) => this.renameSession(id, title),
        deleteSession: (id) => this.deleteSession(id),
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
     *
     * 三条来源按优先级：会话索引 → 上一版的单会话键（迁移）→ 全新的一条空会话。
     * 三条路径走完，`sessions` 与 `activeId` 一定有值 —— 这是不变式，
     * 后面的每个动作都建立在它上面。
     */
    async hydrate(): Promise<void> {
        const [index, legacy, ratio] = await Promise.all([
            this.options.storage.load<unknown>(SESSIONS_STORE_KEY, null),
            this.options.storage.load<AgentMessage[]>(LEGACY_MESSAGES_STORE_KEY, []),
            this.options.storage.load<number>(COMPACT_RATIO_STORE_KEY, COMPACT_RATIO_DEFAULT),
        ]);

        this.compactRatio = (COMPACT_RATIOS as readonly number[]).includes(ratio)
            ? ratio
            : COMPACT_RATIO_DEFAULT;

        const restored = readSessionIndex(index);
        // 索引是否**确定**在存储里。下面删老键只认这一个事实
        let committed = restored !== null;
        if (restored) {
            this.sessions = restored.sessions;
            this.activeId = restored.activeId;
            this.messages = await this.readMessages(restored.activeId);
        } else {
            committed = await this.adoptLegacyMessages(legacy);
        }

        /*
         * 上一版的单会话键，只在"索引确定落盘"之后才删。
         *
         * 判据是提交点，不是"迁移跑过了"：写索引是异步的，而失败会被静默吞掉
         * （配额满是最常见的原因）。把"写过了"当成"写成了"，一旦它没落盘，
         * 那份历史就两处都没了 —— 新键的 id 只有索引知道，而老键已经删掉。
         *
         * 放在两条分支之外，是为了同时收掉另一种断点：迁移写完索引之后 SW 被回收，
         * 老键当时没来得及删。下一次 hydrate 走的是恢复这条路，删除只写在迁移分支里
         * 的话，那份最多 1.5MB、再也无人读的数据就永远留着 —— 而配额正是会话数
         * 上限的出处（见 prompt.ts 的 MAX_SESSIONS）。
         */
        if (committed) await this.options.storage.remove(LEGACY_MESSAGES_STORE_KEY);

        this.emit();
    }

    /**
     * 读一条会话的消息本体。
     *
     * 缺键就是空数组（新建的会话不写空历史）：判断"这条会话有没有消息"的地方
     * 因此只有一处 —— 这里。
     */
    private async readMessages(id: string): Promise<AgentMessage[]> {
        const stored = await this.options.storage.load<AgentMessage[]>(sessionMessagesKey(id), []);
        return Array.isArray(stored) ? stored.filter(isStoredMessage) : [];
    }

    /**
     * 把上一版（单会话）的历史收成第一条会话。
     *
     * 这是**数据迁移**，不是兼容分支：老键读一次、历史写进新键、索引作为提交点落盘，
     * 老键由 hydrate 在确认提交之后删掉（判据与理由都在那边）。不迁的话，
     * 用户升级一次插件就丢掉了全部历史，而那是他自己写下的、没有任何副本的东西。
     *
     * @returns 索引是否真的落盘 —— 删老键拿它当判据
     */
    private async adoptLegacyMessages(legacy: AgentMessage[]): Promise<boolean> {
        const messages = Array.isArray(legacy) ? legacy.filter(isStoredMessage) : [];
        const created = createSessionMeta(Date.now());
        this.sessions = [created];
        this.activeId = created.id;
        this.messages = messages;
        // 条数与自动名字必须在落盘之前推出来：索引里存的就是它们
        this.touchActiveMeta();

        await this.writeMessages();
        return this.writeIndex();
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
            sessions: this.sessions,
            activeSessionId: this.activeId,
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
             * compacting 同样必须在里面：改历史的动作与换会话都拦它（见 locked），
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
     * 现在能不能改历史、能不能换会话。**快照与每一个这样的动作共用这一个判据。**
     *
     * 曾经写成两处：快照判 `!busy && !compacting`，动作只判 `busy`。于是压缩
     * 在途时界面把按钮禁掉，而程序化路径（`agent-action` 桥端点）照样能删能清 ——
     * 用户看到的是"灰着却能生效"，比两种行为都糟。
     *
     * 压缩为什么必须锁：摘要调用的 digest 与 upTo 是开始那一刻算的，这期间
     * 历史一变，这次调用就白跑（锚点没了会自愈成丢弃，但白花一次调用）。
     * 而压缩是用户自己点的、明知要等几十秒，锁住比"让他改完再重压"更省事。
     *
     * 换会话为什么必须在里面：`messages` 是主循环追加的那一份，换掉它，这一轮的
     * 结果就会落进**另一条会话**，而"哪条会话得到了这些消息"没有答案。
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
     *
     * 写**两份**：这条会话的历史（大）+ 会话索引（几百字节）。索引必须跟着每次
     * 写入一起更新，否则列表上的条数与自动名字会停在会话创建那一刻 ——
     * 而"这条会话里写了什么"正是用户在列表上找它的依据。
     */
    private persist(): void {
        this.touchActiveMeta();
        void this.writeMessages();
        void this.writeIndex();
    }

    /** 当前会话的历史落盘。裁剪在这里发生，迁移那条路径用的是同一份逻辑 */
    private writeMessages(): Promise<void> {
        const messages = trimToBudget(this.messages, STORE_BUDGET_MESSAGES).slice(-MESSAGES_STORE_MAX);
        return this.options.storage.save(sessionMessagesKey(this.activeId), messages).catch(() => undefined);
    }

    /**
     * 会话索引落盘。返回**是否真的写成了**。
     *
     * 返回值只有一处用：hydrate 据此决定能不能删上一版的老键（理由见那里的注释）。
     * persist 那条路径忽略它 —— 那条路上失败是静默的，与别处一致。
     *
     * 索引是**提交点**：删会话要等它写完才敢删历史（索引里没有的会话等于不存在）。
     */
    private async writeIndex(): Promise<boolean> {
        try {
            await this.options.storage.save(SESSIONS_STORE_KEY, {
                activeId: this.activeId,
                sessions: this.sessions,
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 把"消息变了"这件事同步到当前会话的元信息上：条数 + 自动名字。
     *
     * **推导只有这一处。** 这两个值都是从 `messages` 算出来的，所以三处调用它而不是
     * 各算一遍，共同点是"`messages` 刚换过，而快照或落盘马上就要用到它们"：
     *
     *   · `persist` —— 每次改写历史之后，这是常态路径；
     *   · `newSession` —— 换成了一条空历史，第一版快照上就得有个名字可画；
     *   · `adoptLegacyMessages` —— 接过上一版那份历史，索引里存的就是推导结果。
     *
     * 用户起的名字（`title`）不在这里动：自动名字回答的是"它开头问的是什么"，
     * 与用户管它叫什么无关（见 AgentSessionMeta）。
     */
    private touchActiveMeta(): void {
        const meta = this.sessions.find((session) => session.id === this.activeId);
        if (!meta) return;
        meta.messageCount = this.messages.length;
        meta.autoTitle = agentSessionTitle(this.messages);
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
    /* 会话                                                                    */
    /* ---------------------------------------------------------------------- */

    /**
     * 新建一条会话并切过去。
     *
     * 到上限时是**拒绝**，不是"删掉最旧的那条腾地方"：历史是用户的东西，
     * 程序替他扔掉一条会话不可接受 —— 而写不进去只是写不进去，已经写下的还在。
     */
    private async newSession(): Promise<boolean> {
        if (this.locked()) return false;
        if (this.sessions.length >= MAX_SESSIONS) {
            this.error = `最多 ${MAX_SESSIONS} 条会话。要新建请先删掉一条（可以先把它导出成 Markdown）。`;
            this.emit();
            return false;
        }

        const created = createSessionMeta(Date.now());
        /*
         * 前插而不是追加：数组顺序就是列表顺序（新的在最前），而它是 createdAt 倒序
         * —— 新会话的 createdAt 一定最大，所以前插就等于排好序。
         */
        this.sessions = [created, ...this.sessions];
        this.activeId = created.id;
        // 新会话是空的，历史一份都不用写（缺键即空，见 readMessages）；索引要写
        this.messages = [];
        // 名字与条数推在 emit 之前：第一版快照上就得有一个能画的名字
        this.touchActiveMeta();
        this.error = '';
        this.emit();
        await this.writeIndex();
        return true;
    }

    /**
     * 切换会话。
     *
     * 当前这份历史**不需要在这里回写一次**：它每次追加都已经落盘（persist 挂在
     * appendMessages 上，其余改写历史的动作也各自走过）。多写一次等于凭空多一处
     * "什么时候该写"的判断，而那种判断正是会漏的那一种。
     */
    private async switchSession(id: string): Promise<boolean> {
        if (this.locked()) return false;
        if (id === this.activeId) return true;
        if (!this.sessions.some((session) => session.id === id)) return false;

        this.activeId = id;
        this.messages = await this.readMessages(id);
        // 上一条会话留下的报错属于那一段历史，留着会指向用户已经看不见的东西
        this.error = '';
        // 换了一份历史，上下文占用、canCompact、contextFull 全都要跟着变
        this.emit();
        await this.writeIndex();
        return true;
    }

    /**
     * 给会话改名。空串 = 清掉用户起的名字，界面回落到自动名字。
     *
     * **不拦 locked**（与其它改历史的动作不同）：它一个字都不碰消息。模型正跑着的
     * 时候给这条会话起个名字是完全合理的动作，而拦住它只会让用户以为改名坏了。
     */
    private renameSession(id: string, title: string): void {
        const meta = this.sessions.find((session) => session.id === id);
        if (!meta) return;
        meta.title = title.trim().slice(0, AGENT_SESSION_TITLE_MAX);
        this.emit();
        void this.writeIndex();
    }

    /**
     * 删掉一条会话，连同它的历史。
     *
     * 只剩一条时**拒绝**：会话数"至少一条"是不变式（见 sessions 的注释），删空了
     * 用户按下发送就没有地方可落。要清掉内容有 clear —— 两者的意图不同：
     * 清空是"这条不要了，从头开始"，删除是"这条连同名字一起消失"。
     */
    private async deleteSession(id: string): Promise<boolean> {
        if (this.locked()) return false;
        if (this.sessions.length <= 1) {
            this.error = '只剩一条会话，不能删除。要清掉里面的内容请用「清空」。';
            this.emit();
            return false;
        }
        const at = this.sessions.findIndex((session) => session.id === id);
        if (at < 0) return false;

        this.sessions = this.sessions.filter((session) => session.id !== id);
        if (id === this.activeId) {
            /*
             * 删的是当前这条：落到剩下的同一条位置上（下标越界时取最后一条），
             * 并把那份历史读出来。不换的话界面上留着的是**一条已经被删掉的会话**
             * 的消息，而那一刻它属于哪条会话没有答案。
             */
            const next = this.sessions[Math.min(at, this.sessions.length - 1)];
            this.activeId = next.id;
            this.messages = await this.readMessages(next.id);
        }

        this.error = '';
        this.emit();
        /*
         * 删历史的**条件是索引确实落盘了**（提交点，与 hydrate 删老键同一条规矩）。
         *
         * 两种顺序都试过，取这一种的理由是两种断点里选坏处小的：索引没写成时不删，
         * 最坏留下一份"不在列表里、也没人读"的历史（占着配额，界面看不出异常），
         * 而且重启之后那条会话还在索引里 —— 删除没生效，但什么都没丢。反过来先删
         * 历史，索引一失败就留下一条点开即空白的会话：用户看得见的坏状态，
         * 而且内容真的没了。
         */
        if (await this.writeIndex()) await this.options.storage.remove(sessionMessagesKey(id));
        return true;
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

        // 模型侧记录。工具结果以原生 tool 消息回灌（形状与 roundToMessages 逐字对齐）
        const transcript = [...history, { role: 'user' as const, content: text }];

        try {
            // 连续协议错误计数。只统计**连续**的：中途成功执行过一次工具就归零，
            // 否则一个偶发故障会跟着整个会话不放，几次之后把还正常的模型判死。
            let protocolErrors = 0;

            // 不设步数上限：什么时候停由模型自己决定（不再要工具就收尾）。
            for (;;) {
                if (this.stopped) break;

                /*
                 * 轮内门槛量的必须是**真正要发出去的那一份**，也就是 transcript，
                 * 不是 `contextOf(messages)`。
                 *
                 * 两者不等价，而且差的正是最容易撑爆的那一块：transcript 里每步
                 * 都追加模型那条 assistant 消息（含整份 arguments.code），而重建
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
                let reply: AiReply;

                try {
                    reply = await this.options.chat.chat({
                        system: SYSTEM_PROMPT,
                        messages: transcript,
                        /*
                         * 工具表随请求下发。**这是本设计的核心**：调用由服务商的
                         * 结构化通道产出，模型不写任何 JSON 外壳 —— 那类"漏引号 /
                         * 漏括号 / 被截断"的失败因此不是变少了，而是不存在。
                         */
                        tools: AGENT_TOOLS,
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
                const { calls } = extractCalls(reply.toolCalls);
                const intent = reply.content.trim();
                const truncated = reply.finishReason === 'length';

                /*
                 * 截断发生在参数里时，只有**参数完整**的那些调用能执行。
                 *
                 * 理由与服务商配对规则直接相关：`assistant.tool_calls` 里出现的
                 * 每一个 id，后面都必须跟一条对应的 tool 消息。把坏掉的那个也
                 * 写进去，就得为它编一条结果；而它根本没被执行，编出来的结果
                 * 会污染历史。截断这件事由下面那条 notice + TRUNCATED_OBSERVATION
                 * 说清，不靠"一条假结果"表达。
                 */
                const runnable = truncated
                    ? calls.filter((one) => parseArguments(one.raw).ok)
                    : calls;

                /**
                 * **截断优先于一切。**
                 *
                 * `finishReason === 'length'` 意味着这一条回复是被输出上限砍断的，
                 * 于是它里面的一切都是残片：正文是半句话，`tool_calls` 的参数
                 * 是半个 JSON。两者必须按**同一个原因**处置 —— 而那个原因是
                 * "内容太长"，不是"模型写错了协议"。
                 *
                 * 判据必须在这里、在派发之前：放到 `calls.length === 0` 分支里
                 * 就只覆盖了"截断发生在正文"这一种，而实测中截断几乎总是发生在
                 * **参数**里（模型正在写一份长文件），那时 calls 非空，会一路
                 * 走到"参数不是合法 JSON"被误判成协议错误 —— 回灌一句"重发同一个
                 * 调用"，模型照做还是被砍，于是连撞三次把整轮撞停。
                 */
                if (truncated) {
                    this.appendMessage({
                        id: generateId(),
                        role: 'assistant',
                        content: runnable.length > 0
                            ? '（本轮回复撞上输出长度上限被截断；已完整写出的调用照常执行）'
                            : '（本轮回复撞上输出长度上限被截断，已要求模型拆小重做）',
                        reasoning: keepReasoning(liveReasoning),
                        notice: true,
                        ...(stepUsage ? { usage: stepUsage } : {}),
                        at: Date.now(),
                    });
                    transcript.push({ role: 'assistant', content: intent });
                    transcript.push({ role: 'user', content: TRUNCATED_OBSERVATION });
                    // 一条能执行的调用都没有：没有 tool 消息要回，直接进下一轮
                    if (runnable.length === 0) continue;
                }

                /**
                 * 没有工具调用 —— 两种情况：
                 *
                 * 1. **模型明确收尾**（有正文）：落一条回答。
                 * 2. **空回复**：推理模型偶发，回灌也无从改起，如实提示后停止。
                 */
                if (runnable.length === 0) {
                    if (intent) {
                        this.appendMessage({
                            id: generateId(),
                            role: 'assistant',
                            content: intent,
                            reasoning: keepReasoning(liveReasoning),
                            ...(stepUsage ? { usage: stepUsage } : {}),
                            at: Date.now(),
                        });
                        break;
                    }

                    /*
                     * 走到这里：既没有工具调用也没有正文。
                     * 空回复回灌一句"你没输出"它也变不出内容来，那是浪费一次调用。
                     */
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
                 * 把这一步的调用原样回放进 transcript —— **在派发之前**。
                 *
                 * 服务商要求每条 tool 消息都由一个带同 id 的 assistant.tool_calls
                 * 指回，所以那条 assistant 消息必须先在序列里。它同时是下一轮
                 * 重建历史时 `roundToMessages` 产出的同一条形状。
                 */
                transcript.push({
                    role: 'assistant',
                    content: intent,
                    tool_calls: runnable.map((one) => ({
                        id: one.id,
                        name: one.tool,
                        arguments: one.raw,
                    })),
                });

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
                const batch = await Promise.all(runnable.map(async (one) => {
                    /*
                     * 参数解析失败**不是**"丢掉这个调用"：那会让模型看到的结果
                     * 比它写的少，从而以为工具坏了再发一遍，而真实原因（参数
                     * JSON 坏了）它一次都读不到。这里把它变成一条明确的失败观察。
                     *
                     * 它在结构化通道下只可能来自"服务商没有真正约束解码"，
                     * 所以计一次协议错误 —— 与"给了一个不存在的工具名"同类。
                     */
                    const parsed = parseArguments(one.raw);
                    if (parsed.ok === false) {
                        return {
                            callId: one.id,
                            tool: one.tool,
                            label: one.tool,
                            result: JSON.stringify({ __agentError: parsed.error }),
                            ok: false,
                            bad: true,
                            args: {} as Record<string, unknown>,
                        };
                    }

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
                        result = await dispatchTool(tool, parsed.args, {
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
                    const rawAction = asString(parsed.args.action);
                    const label = tool === 'sandbox' && rawAction ? `${tool}·${rawAction}` : tool;

                    /**
                     * 失败判据按工具分岔，因为"什么算失败"对两者本就不同：
                     * js 的返回值是**页面数据**，`{error:"..."}` 是探测到的业务字段，
                     * 只有 `__agentError` 算失败；其余工具的错误对象只可能由我们自己
                     * 构造，`{error}` 就是失败。
                     */
                    const failed = tool === 'js' ? isJsErrorResult(result) : isErrorResult(result);
                    return { callId: one.id, tool, label, result, ok: !failed, bad: false, args: parsed.args };
                }));

                // 用户在一批跑到一半时点停止：后面的调用已经发出去了，收不回来，
                // 但结果不必再落进对话流 —— 他刚说了不要。
                if (this.stopped) break;

                /*
                 * 协议错误计数：只有**参数坏掉**的那些才算（见上面的 bad）。
                 * 一个工具执行失败（文件不存在、脚本抛错）是模型的正常反馈循环，
                 * 不是协议问题 —— 把它算进去，连续三次失败就会把还正常的模型判死。
                 */
                const badCalls = batch.filter((item) => item.bad).length;
                if (badCalls === 0) {
                    protocolErrors = 0;
                } else {
                    protocolErrors += 1;
                }

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
                        content: item.bad
                            ? protocolErrorSummary(item.result)
                            : (intent
                                ? (batch.length > 1 ? `${intent}（${index + 1}/${batch.length}）` : intent)
                                : `调用 ${item.label}`),
                        reasoning: keepReasoning(liveReasoning),
                        tool: item.tool as AgentToolName,
                        /*
                         * 参数坏掉的调用记成**协议错误**而不是工具失败。
                         *
                         * 两者的成因完全不同：工具失败是"这一步没做成，改参数再来"，
                         * 协议错误是"服务商给的参数不是合法 JSON" —— 后者在结构化
                         * 通道下本不该发生。混记成工具失败，用户与模型都会以为
                         * 是自己参数写错了，而真正该换的是模型服务。
                         */
                        label: item.bad ? PROTOCOL_ERROR_LABEL : item.label,
                        // 协议身份：下一轮重建历史时要靠它拼回 assistant.tool_calls
                        callId: item.callId,
                        callArgs: calls[index].raw,
                        // js 跑的源码存下来供界面展开查看；其它工具没有源码。
                        script: item.tool === 'js' ? asString(item.args.code) : undefined,
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

                /*
                 * 回灌观察。**每条调用一条 tool 消息**（不是把一批塞进一条 user
                 * 消息）：服务商按 tool_call_id 逐条配对，塞成一条会让后面几条
                 * 调用找不到结果。批次语义因此改由 tool 消息的内容表达 ——
                 * 见 batchObservation 的 head。
                 *
                 * 参数坏掉的那些也**必须**回一条 tool 消息：它们的 id 已经在
                 * assistant.tool_calls 里发出去了，少一条配对，整条请求会被服务商
                 * 拒掉（"tool 消息与调用对不上"）。
                 */
                const batchHead = batchObservation(batch);
                const perCall = batch.length > 1;
                for (const item of batch) {
                    transcript.push({
                        role: 'tool',
                        tool_call_id: item.callId,
                        /*
                         * 单条调用时用 toolObservation 的原话；一批时每条都带上
                         * 批次头 —— 模型需要知道"这些结果来自同一步"，那正是它
                         * 规划下一步并行的依据。只有第一条带完整的 head 会更省
                         * token，但模型按 tool_call_id 逐条读，后几条就没有上下文了。
                         */
                        content: item.bad
                            ? protocolErrorObservation(item.result)
                            : (perCall
                                ? `${batchHead}\n\n${toolObservation(item.label, item.result, item.ok)}`
                                : batchHead),
                    });
                }

                if (protocolErrors >= MAX_PROTOCOL_ERRORS) {
                    this.appendMessage({
                        id: generateId(),
                        role: 'assistant',
                        content: `连续 ${MAX_PROTOCOL_ERRORS} 次收到无法执行的调用，已停止。`
                            + '工具调用由协议层生成，正常不会坏 —— 这说明当前模型服务没有真正约束解码。'
                            + '可以换一个模型，或再说一次。',
                        notice: true,
                        at: Date.now(),
                    });
                    break;
                }
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
            const reply = await this.options.chat.chat({
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

            const summary = reply.content.trim();
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
 * 回复撞上输出长度上限时回灌的那句话。
 *
 * 只由这一个函数产出（当场与重建共用）：模型自己不知道被砍断了 —— 它收到的
 * 正文就是它写下的那半句，看起来完全正常。不说清这件事，它下一步只会照着
 * 半句话继续往下想，而真正该做的是把这一步拆小。
 */
const TRUNCATED_OBSERVATION = '[系统提示] 你上一条回复撞上了输出长度上限，被截断在半路。'
    + '这不是你的表达问题，是这一步的内容太长。把这一步拆小：'
    + 'args 里只放必需的那部分，能分两次做的就分两次，尤其不要把整份脚本或整篇文档塞进一次调用。';

/**
 * 一条新会话的元信息。
 *
 * 只给身份与创建时刻：条数与自动名字由 `touchActiveMeta` 从历史推导出来。
 * 那份推导**只有一处** —— 在这里再算一遍，等于同一件事有两个实现，而其中一个
 * （新建时是空历史，推导结果是"未命名会话"）改了另一个不会跟着改。
 */
const createSessionMeta = (now: number): AgentSessionMeta => ({
    id: generateId(),
    title: '',
    autoTitle: '',
    createdAt: now,
    messageCount: 0,
});

/**
 * 存储里的会话索引是不是能用的。
 *
 * 与 isStoredMessage 同一个立场：存储是外部输入（上一版插件写的、用户手改的、
 * 同 origin 的别的代码写的），而这份索引决定"有哪些会话、当前是哪条"。一条坏
 * 记录足以把 `activeId` 指到一个不存在的会话上 —— 那时消息列表是空的，而且用户
 * 按下发送会把新消息写进一个列表里不存在的 id。
 *
 * 返回 null 表示"没有可用的索引"：调用方去走迁移或新建（见 hydrate）。**不在这里
 * 兜底造一条会话**：那会把"没有索引"和"索引坏了"合并成同一条路径，而前者要走的是
 * 迁移（把老键那份历史接过来），后者只能新建。
 */
const readSessionIndex = (value: unknown): { activeId: string; sessions: AgentSessionMeta[] } | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = (value as { sessions?: unknown }).sessions;
    if (!Array.isArray(raw)) return null;

    const sessions = raw.filter(isStoredSession);
    if (sessions.length === 0) return null;

    // 数组顺序就是列表顺序（新会话前插，见 newSession），这里原样保留
    const wanted = (value as { activeId?: unknown }).activeId;
    const activeId = typeof wanted === 'string' && sessions.some((session) => session.id === wanted)
        ? wanted
        : sessions[0].id;
    return { activeId, sessions };
};

/** 索引里的一条会话记录是不是能用的。只查会被读到的那几个字段，同 isStoredMessage */
const isStoredSession = (value: unknown): value is AgentSessionMeta => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const session = value as Record<string, unknown>;
    if (typeof session.id !== 'string' || !session.id) return false;
    if (typeof session.title !== 'string' || typeof session.autoTitle !== 'string') return false;
    if (typeof session.createdAt !== 'number') return false;
    // 界面直接渲染它，非数字会渲染成 NaN
    if (typeof session.messageCount !== 'number') return false;
    return true;
};

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
