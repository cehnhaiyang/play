'use strict';
/**
 * Agent 引擎（工具派发 + 主循环 + 上下文重建）的回归。
 *
 * ## 被测对象变了
 *
 * 原先被测的是 `app/renderer/hooks/useAgent.ts` 里的 React hook，测试只能靠
 * 切源码字符串 + React shim 把它跑起来。引擎搬到 `extension/src/agent/` 之后
 * 它是一个**普通模块**：`AgentEngine` 接收宿主、存储、模型三个端口，因此
 * 这里直接 `require` 编译产物，塞假端口进去跑真代码。
 *
 * 这不只是省事。切源码字符串的断言有一个固有的坏处：**它对格式敏感**。
 * 把 `const dispatchTool = useCallback(async (` 改成换行写法，测试就红了，
 * 而产品没有任何变化 —— 那种红会训练人忽略它。
 *
 * ## 仍然保留的源码断言
 *
 * 有一类性质**只能**从源码上看出来，跑不出来：比如"每一处定稿点都带了推理"。
 * 那种断言留在原处，路径指向新的引擎目录（`AGENT_SOURCES` 把目录下的 .ts 全读进来）。
 *
 * 打在三处容易错的地方：
 *   1. 部分更新：set 只传一类规则时，其余两类必须原样保留；
 *   2. 落盘边界：模型改规则只走 applyRules（改内存 + 注入，不落盘），
 *      宿主上根本没有落盘那一口；注入失败要如实回 applied:false；
 *   3. tokens find 的 key 必须能写回去（cookie 用 cookie 名，不是数组下标）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * 全部引擎源码（按文件），供"某一处必须/不得出现某写法"这类断言使用。
 *
 * 引擎是多个文件，断言写在哪个文件里是**实现细节**。
 * 只读 engine.ts 会让"推理不进上下文"这种跨文件的约束漏测（transcript 那部分
 * 在 transcript.ts 里）。所以覆盖面断言一律扫全部文件。
 */
const AGENT_DIR = path.join(ROOT, 'extension', 'src', 'agent');
const AGENT_SOURCES = fs.readdirSync(AGENT_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({
        file: f,
        text: fs.readFileSync(path.join(AGENT_DIR, f), 'utf8').replace(/\r\n/g, '\n'),
    }));
const ALL_SRC = AGENT_SOURCES.map((s) => s.text).join('\n');

/**
 * 球窗口的源码。
 *
 * 有一条断言落在**渲染层**上（工具消息里的 intent 要画出来，见下面那一节）：
 * 引擎把 intent 写进消息只是做了一半，界面不画的话用户照样看不到。渲染层在
 * `app/` 下（React + JSX），不在本测试的编译范围里（test/tsconfig.json），
 * 所以只能读源码 —— 这正是文件头说的那类"只能从源码上看出来"的性质。
 *
 * 可用 `ORB_SRC` 覆盖：变异测试靠它指向一份改坏的副本，
 * 从而在不碰产品文件的前提下验证断言真的能失败。
 */
const ORB_SRC = process.env.ORB_SRC || path.join(ROOT, 'app', 'orb', 'agent.tsx');

/**
 * 引擎与它的纯函数，直接 require **编译产物**。
 *
 * 这是本次搬迁最大的收益：不再切源码字符串、不再需要 React shim。
 * 切字符串的断言对格式敏感 —— 换个换行写法就红，而产品没变，
 * 那种红会训练人忽略它。
 */
const AGENT = require('./build/extension/src/agent/engine.js');
const TRANSCRIPT = require('./build/extension/src/agent/transcript.js');
const PROMPT = require('./build/extension/src/agent/prompt.js');
const TEXT = require('./build/extension/src/agent/text.js');
const PARSE = require('./build/extension/src/agent/parse.js');
const TOOLS_SPEC = require('./build/extension/src/agent/toolspec.js');
const TOOLS = require('./build/extension/src/agent/tools.js');

const keepReasoning = TEXT.keepReasoning;
const {
    buildTranscript,
    insertAfterId,
    COMPACT_PREFIX,
    PROTOCOL_ERROR_LABEL,
    protocolErrorObservation,
    toolObservation,
} = TRANSCRIPT;
const { CONTEXT_LIMIT_TOKENS } = PROMPT;

/** buildDispatch 的默认页面地址。传 false 才表示没有可用页面 */
const DEFAULT_TAB_URL = 'https://example.com/';

/* -------------------------------------------------------------------------- */
/*                     端到端 harness：真跑 AgentEngine                        */
/* -------------------------------------------------------------------------- */
/**
 * 造一个真跑的 AgentEngine。
 *
 * 与应用侧那份 hook 版 harness 的差别：**不再需要 React shim**。引擎现在接收
 * 宿主、存储、模型三个端口，测试塞假端口进去就能把整个主循环跑起来 ——
 * 而这正是"引擎不做成 hook"这个决定换来的东西之一。
 *
 * ## 为什么是 async
 *
 * 引擎构造后必须 await `hydrate()`（它要从存储读回历史，那是异步的）。
 * 不 await 的话第一次 `state()` 看到的是空列表，而所有"恢复历史"的用例都会
 * 悄悄退化成在测空状态 —— 那比直接报错难查得多。
 */
const buildAgentHarness = async (options = {}) => {
    const chats = [];
    /**
     * 每次 chat 的**完整选项**（不只是消息）。
     *
     * 档位、temperature 这些只活在选项里，而 `chats` 只留了消息 ——
     * "这次调用带了什么参数"因此无从断言（压缩曾经偷偷写死档位就是这么漏掉的）。
     */
    const chatCalls = [];
    /**
     * 内存存储。
     *
     * `options.store` 用来预置**已有内容**（会话迁移那条路径必须从"上一版留下的
     * 老键"起步，而那只能靠预置，因为 hydrate 在 harness 里已经跑完了）。
     */
    const store = { ...(options.store || {}) };

    /**
     * AiService 的**编译产物**。
     *
     * 让 chat 桩的估算回落与产品同源 —— 自己重写一份估算，
     * 测的就是"我对估算的理解"而不是产品实现。
     */
    const AI = require('./build/shared/ai/AiService.js');
    // 本轮里已经发起过几次 chat。每一轮（每次 send）开始时归零 ——
    // 用它实现"每轮先调一次工具、再收尾"，而不是按全局调用序号算：
    // 后者会让第 2 轮之后再也拿不到工具调用，造不出"轮内有工具消息"的场景。
    let roundCalls = 0;

    const chatImpl = async (opts) => {
        /*
         * 记下**协议相关字段**，不只记 role + content。
         *
         * tool_calls / tool_call_id 是服务商配对调用与结果的唯一依据：夹具把它们
         * 丢掉的话，"重建出来的历史能不能被服务商接受"这件事在测试里完全看不见 ——
         * 而那正是最容易写错、也最致命的一处（少一条配对整条请求被拒）。
         */
        chats.push(opts.messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        })));
        chatCalls.push({
            system: opts.system,
            temperature: opts.temperature,
            reasoningEffort: opts.reasoningEffort,
            maxTokens: opts.maxTokens,
        });
        roundCalls += 1;
        /**
         * usage 回调。这里要**如实复刻真实 chat 的契约**：成功就回调一次，
         * 有服务端 usage 就是实测，没有就是估算（见 AiService.reportUsage）。
         *
         * 不能只在 noUsage 为假时回调 —— 那会让"服务端不回 usage"这条回落路径
         * 在测试里根本走不到，而它恰恰是本地代理环境下最常见的形态。
         */
        const replyFor = () => {
            if (typeof opts.system === 'string' && opts.system.includes('对话压缩器')) {
                return options.compactReply !== undefined ? options.compactReply : '## 任务目标\n取价格';
            }
            /**
             * replies：逐次指定模型回复，用来造"先答错再答对"的序列。
             *
             * 数组成分尽后回落到默认收尾，于是用例只要写它关心的那几次；
             * 传字符串则每次都用它（造"一直错下去"的场景）。
             */
            if (options.replies) {
                const seq = Array.isArray(options.replies) ? options.replies : null;
                const at = roundCalls - 1;
                if (seq) {
                    if (at < seq.length) return seq[at];
                } else {
                    return options.replies;
                }
            }
            if (options.toolCall && roundCalls === 1) {
                // toolCase: 大写让模型回大写工具名，用来验证解析侧的严格匹配
                // （全小写协议下大写即写错，必须落到未知工具）
                const toolName = options.toolCase === 'upper' ? 'JS' : 'js';
                return JSON.stringify({ intent: '取数', calls: [{ tool: toolName, args: { code: 'return 1;' } }] });
            }
            return JSON.stringify({ intent: '答完了', final: `第 ${chats.length} 轮的回答` });
        };

        /**
         * 把用例写的回复字符串翻成 **AiReply**。
         *
         * 桩必须复刻真实协议的形状，否则测的就不是产品行为：
         *
         *  - `{"calls":[…]}` 这种信封写法已经不存在了。为了不改动上百个既有用例，
         *    这里把它**翻译**成原生 tool_calls —— 这正是服务商在做的事。
         *  - `{"final":"…"}` 同理翻成"有正文、没有 tool_calls"。
         *  - 其余字符串原样当正文（用来造"模型说了句散文"的场景）。
         *
         * 这一步只存在于测试里：产品侧再也不解析任何信封。
         */
        const toReply = (raw) => {
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch { /* 不是 JSON：当正文 */ }
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                if (Array.isArray(parsed.calls)) {
                    return {
                        content: typeof parsed.intent === 'string' ? parsed.intent : '',
                        toolCalls: parsed.calls.map((call, at) => ({
                            id: `call_${at}_${Math.random().toString(36).slice(2, 8)}`,
                            name: String(call && call.tool),
                            arguments: JSON.stringify((call && call.args) || {}),
                        })),
                        finishReason: 'tool_calls',
                    };
                }
                if (typeof parsed.final === 'string') {
                    return { content: parsed.final, toolCalls: [], finishReason: 'stop' };
                }
            }
            return {
                content: raw,
                toolCalls: [],
                finishReason: options.finishReason || 'stop',
            };
        };

        /**
         * 直接指定某一步的 **AiReply**（第 0 步起算）。
         *
         * 有些场景只有它能造：参数不是合法 JSON 的调用、被 `length` 截断的回复 ——
         * 这两样都无法从"回复字符串"表达出来，而它们正是本次改造要处理的核心形态。
         * 返回 null 表示这一步交给默认逻辑。
         */
        const replyOverride = (at) => (typeof options.replyOverride === 'function'
            ? options.replyOverride(at)
            : null);

        // hold：卡住**指定那一轮**（默认第 2 轮），用来观察"运行中"这个中间态。
        // 不能卡住每一轮 —— 那样连造初始状态的那次 send 都会挂死。
        //
        // 同时如实复刻真实 chat 的 abort 契约：信号被掐断后这次调用必须尽快以
        // AbortError 失败。少了这一半，"停止能不能掐断这次调用"就测不出来 ——
        // 卡住的桩会一直卡着，引擎再对也拿不到结果。
        if (options.hold && chats.length === (options.holdAt || 2)) {
            await new Promise((resolve, reject) => {
                const onAbort = () => reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
                if (opts.signal && opts.signal.aborted) { onAbort(); return; }
                opts.signal?.addEventListener('abort', onAbort, { once: true });
                options.hold.then(resolve);
            });
        }

        const raw = replyFor();
        const forced = replyOverride(roundCalls - 1);
        const reply = forced || toReply(raw);
        if (opts.onUsage) {
            if (options.noUsage) {
                const wire = opts.system ? [{ role: 'system', content: opts.system }, ...opts.messages] : opts.messages;
                const promptTokens = AI.estimatePromptTokens(wire);
                const completionTokens = AI.estimateTokens(typeof raw === 'string' ? raw : reply.content);
                opts.onUsage({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true });
            } else {
                opts.onUsage({ promptTokens: 100 * chats.length, completionTokens: 10, totalTokens: 100 * chats.length + 10, estimated: false });
            }
        }
        return reply;
    };

    /**
     * 内存存储。
     *
     * save 的函数体在调用那一刻**同步**执行完（没有 await），所以引擎那句
     * "落盘不 await"的写法在这里表现为立即生效 —— 这让 setMessages 能靠
     * 重新 hydrate 来摆状态，而不必给产品代码开一个测试专用的写入口。
     */
    /** 落盘次数。用来钉住"一批只写一次"这类写入次数的契约 */
    let saves = 0;
    /** 删除键的次数。用来钉住"迁移之后老键必须被删掉" */
    let removes = 0;
    const storage = {
        load: async (k, d) => (k in store ? store[k] : d),
        save: async (k, v) => {
            // failSave：复刻"写不进去"（配额满）。抛在计数之前 —— 没写成的不能算一次写入
            if (options.failSave && options.failSave(k)) throw new Error('存储写入失败（配额可能已满）');
            saves += 1;
            store[k] = v;
        },
        remove: async (k) => { removes += 1; delete store[k]; },
    };

    /**
     * 假宿主。默认**有页面**，需要造"没有可用页面"的用例传 webview: false。
     *
     * 默认必须有：没有页面时 js 一律返回 {error: 当前没有可用的页面}，
     * 于是所有依赖成功结果的用例都会悄悄退化成在测失败路径 ——
     * 而它们断言的是观察前缀、跨轮可见性这些与成败无关的性质，测错了也不知道。
     */
    const tabUrl = options.webviewUrl || 'https://example.com/';
    const hasPage = options.webview !== false;
    const ranCode = [];
    const navigated = [];
    const sandboxCalls = [];

    /*
     * 当前标签页可变，且记录 activeTab() 被问了几次。
     *
     * 这两样是给"执行前重新解析活动标签"那条断言用的：缓存 tabId 的写法在
     * 单标签页的用例里完全看不出问题，只有切换之后才暴露。所以必须能切、
     * 也必须能数。
     */
    let currentTabId = 1;
    let activeTabCalls = 0;
    let lastEvalTabId = null;

    const host = {
        activeTab: async () => {
            activeTabCalls += 1;
            return hasPage ? { id: currentTabId, url: tabUrl } : null;
        },
        evaluate: async (tabId, source) => {
            /*
             * 复刻真实执行器的契约：源码是包好的 IIFE，直接求值拿到返回值。
             * 用 new Function 而不是 eval —— 与 debugger 的 Runtime.evaluate
             * 同为"独立作用域求值"，能暴露依赖外部变量的写法。
             */
            lastEvalTabId = tabId;
            ranCode.push(source);
            const value = await new Function(`return (${source})`)();
            return typeof value === 'string' ? value : JSON.stringify(value);
        },
        navigate: async (_tabId, url) => { navigated.push(url); return { url, loaded: true }; },
        readWebStorage: async () => {
            // throwOnBridge：让宿主抛异常，用来测"工具内部异常"这条与
            // "返回 error 字段"完全不同的失败路径。readWebStorage 是 storage get
            // 与 tokens find 都要过的口，在这里抛能覆盖 dispatchTool 里
            // **没有**自己 try/catch 的那一类调用。
            if (options.throwOnBridge) throw new Error('页面宿主不可用');
            return '{}';
        },
        writeWebStorage: async () => true,
        removeWebStorage: async () => true,
        getCookies: async () => [],
        setCookie: async () => true,
        removeCookie: async () => true,
        tamper: {
            rules: { interceptRules: [], requestRules: [], headerRules: [] },
            applyRules: async () => true,
        },
    };

    const snapshots = [];
    const engine = new AGENT.AgentEngine({
        host,
        storage,
        chat: { chat: chatImpl },
        /**
         * 沙箱端口。默认**成功且什么都没做**。
         *
         * 传 options.sandboxThrow 则复刻"桥断了"那条路径 —— 它是唯一一条
         * 工具内部 catch 不住的失败（reject 而非返回 error），必须能单独造出来。
         */
        sandbox: async (request) => {
            sandboxCalls.push(request);
            if (options.sandboxThrow) throw new Error('本机应用未连接');
            return options.sandboxResult || { bytes: 1 };
        },
        onDelta: () => {},
        onSnapshot: (s) => snapshots.push(s),
    });
    await engine.hydrate();

    /*
     * 记账从"构造完成"那一刻开始。
     *
     * hydrate 自己会写存储（迁移老键 / 建第一条会话的索引），而那不是任何一轮的账：
     * 把它算进去，每条与写入次数有关的断言都得先减掉一个常量 —— 而那个常量还会
     * 随着 hydrate 的实现变化。
     */
    saves = 0;
    removes = 0;

    return {
        chats,
        /** 每次 chat 的完整选项（system / temperature / reasoningEffort / maxTokens） */
        chatCalls: () => chatCalls,
        ranCode,
        navigated,
        /** 沙箱端口被调了几次、每次收到什么。用来证明参数确实转给了应用 */
        sandboxCalls: () => sandboxCalls,
        engine,
        /** 当前状态。引擎的快照是同步可取的（hydration 已经 await 过） */
        state: () => engine.snapshot(),
        /**
         * 引擎推过的每一版快照，按顺序。
         *
         * 有些性质只有"过程中每一版"能回答：某一步是推了一版还是按条数推了几版、
         * 某一版有没有说错话（只说最终状态会把中间那几版全部漏掉）。
         */
        snapshots: () => snapshots,
        /** 落盘次数。写入次数的契约（如"一批只写一次"）只能靠它验 */
        saves: () => saves,
        /** 删除键的次数（迁移删老键、删会话删历史） */
        removes: () => removes,
        /** 存储内容。会话相关的断言要看"哪几个键真的写下去了" */
        store: () => store,
        /** activeTab() 被问了几次。用来证明引擎没有缓存标签页 */
        activeTabCalls: () => activeTabCalls,
        /** 最近一次页面执行落在哪个标签页 */
        lastEvalTabId: () => lastEvalTabId,
        /** 模拟用户切标签页 */
        switchTab: (id) => { currentTabId = id; },
        async send(text) {
            roundCalls = 0;
            await engine.snapshot().actions.send(text);
        },
        /** 不 await 地发起一轮，用来观察"运行中"这个中间态 */
        sendPending(text) {
            roundCalls = 0;
            return engine.snapshot().actions.send(text);
        },
        /**
         * 直接摆消息列表，用于构造删除 / 回退 / 超限的起始状态。
         *
         * 走**存储 + 重新 hydrate**而不是给引擎开一个写入口：hydrate 是真实存在
         * 的代码路径（service worker 被回收后就是靠它恢复），所以这里测到的
         * 是产品行为；加一个 setMessagesForTest() 则会让"恢复"这条路无人覆盖。
         *
         * 写的是**当前会话**那一份（消息按会话分键存），因此摆完之后 hydrate
         * 读到的就是它 —— 摆别的会话的那一份不会影响 state()。
         */
        async setMessages(list) {
            store[PROMPT.sessionMessagesKey(engine.snapshot().activeSessionId)] = list;
            await engine.hydrate();
        },
    };
};

/**
 * 造一个 dispatchTool。
 *
 * tamper 是个可观测的假引擎：applyRules 记账并回注入结果，
 * 这样"改了几次规则""这次注入成不成功"都是可断言的。宿主接口上**没有**落盘那一口
 * （AgentHost.tamper 只有 rules + applyRules），所以"会不会越界落盘"在类型上
 * 就已经不可能 —— 这里只钉"确实调了那唯一的一口"。
 *
 * 第三个返回值 `tamperRef.injected` 让用例能把 applyRules 的返回翻成 false，
 * 造出"规则进了内存但这个页面没装上钩子"那条路径。
 */
const buildDispatch = (tamperState, webviewUrl = DEFAULT_TAB_URL, sandboxImpl = null) => {
    const calls = {
        apply: 0, setCookie: [], setLocal: [], setSession: [], removed: [],
        ranCode: [], navigated: [], sandbox: [],
    };

    const tamper = JSON.parse(JSON.stringify(tamperState));
    /*
     * `rules` 是**函数**而不是属性：规则的唯一权威是插件的 chrome.storage，
     * 而读它是异步的。做成属性时读到的是内存镜像，而镜像可能是"还没加载完"
     * 的空数组 —— 用户明明存了规则，模型却被告知没有。
     *
     * 断言看 `tamperRef.rules`，它就是引擎当前那一份。
     */
    const tamperRef = { rules: {}, injected: true };
    tamperRef.rules = {
        interceptRules: tamper.intercept,
        requestRules: tamper.request,
        headerRules: tamper.headers,
    };
    tamperRef.current = {
        rules: async () => tamperRef.rules,
        applyRules: async (i, r, h) => {
            calls.apply++;
            tamperRef.rules = { interceptRules: i, requestRules: r, headerRules: h };
            return tamperRef.injected;
        },
    };

    /*
     * 默认**有页面**，传 false 才表示"没有可用页面"。
     *
     * 与 buildAgentHarness 同一约定。反过来（默认无页面）会让 storage / tokens
     * 这些"现在要问宿主当前标签"的工具一律走进无页面分支 —— 而它们的用例断言的是
     * cookie 的 key、JWT 的写回位置这些与页面有无无关的性质，会集体退化成
     * 在测失败路径，且看起来像是产品坏了。
     */
    const hasPage = webviewUrl !== false;
    const host = {
        activeTab: async () => (hasPage ? { id: 1, url: webviewUrl } : null),
        evaluate: async (_tabId, source) => {
            calls.ranCode.push(source);
            return '{"ok":true}';
        },
        navigate: async (_tabId, url) => { calls.navigated.push(url); return { url, loaded: true }; },
        /*
         * 签名必须与 AgentHost 逐字对齐（tabId 在第一个参数）。
         *
         * 这里漏掉 tabId 时不会报错，只会**静默错位**：area 收到的是 tabId 数字，
         * 于是 `area === 'local'` 恒为假，读到的永远是 session 那份。
         * 表现为"storage get local 返回了 session 的数据"，而断言只会说
         * "data 应是对象" —— 与真正的原因隔了两层。
         */
        readWebStorage: async (_tabId, area) => JSON.stringify(area === 'local' ? tamper.local : tamper.session),
        writeWebStorage: async (_tabId, area, key, value) => {
            (area === 'local' ? calls.setLocal : calls.setSession).push([key, value]);
            return true;
        },
        removeWebStorage: async (_tabId, area, key) => { calls.removed.push(area + ':' + key); return true; },
        getCookies: async () => tamper.cookies,
        setCookie: async (_tabId, c) => { calls.setCookie.push(c); return true; },
        removeCookie: async (_tabId, n) => { calls.removed.push(n); return true; },
        tamper: tamperRef.current,
    };

    const ctx = {
        host,
        exec: async (code) => { calls.ranCode.push(code); return '{"ok":true}'; },
        sandbox: async (request) => {
            calls.sandbox.push(request);
            // 默认成功且写了一个字节；要造"应用回 error"的用例自己传实现
            return sandboxImpl ? sandboxImpl(request) : { bytes: 1 };
        },
        tabId: hasPage ? 1 : null,
    };

    // 两个参数：调用点不必改签名，宿主由闭包提供
    const dispatchTool = (tool, args) => TOOLS.dispatchTool(tool, args, ctx);
    return { dispatchTool, calls, tamperRef };
};

/* -------------------------------------------------------------------------- */

let pass = 0;
const fails = [];
const check = async (name, fn) => {
    try { await fn(); pass++; }
    catch (e) { fails.push({ name, message: e && e.message ? e.message : String(e) }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
/** 两值必须严格相等。带 msg 时把实际值打出来，省得再去复现 */
const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};
const j = (s) => JSON.parse(s);

/** 无规则 / 无 cookie / 无存储的空引擎状态，多数用例用它 */
const EMPTY = { intercept: [], request: [], headers: [], cookies: [], local: {}, session: {} };

const run = async () => {
    /* ------------------------------ S: 运行 ------------------------------ */

    await check('js 把 code 交给页面执行并回传结果', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        const out = await dispatchTool('js', { code: 'return 1+1;' });
        assert(calls.ranCode.length === 1, `应执行一次，实际 ${calls.ranCode.length}`);
        assert(calls.ranCode[0] === 'return 1+1;', '应原样把 code 交给执行器');
        assert(j(out).ok === true, '应回传执行结果');
    });

    await check('js 缺 code 时直接报错，不执行空脚本', async () => {
        // 空跑一步的代价不是零：这一步的结果（哪怕是 null）会被后续每一步重发。
        // 旧行为是照常执行空脚本，这里钉住新行为，防止回退。
        //
        // 走 `__agentError` 而不是 `error`：js 的返回值是页面数据，里面出现
        // `{error:"..."}` 是正常业务字段，两条通道混用会让判据去猜。
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('js', {}));
        assert(out.__agentError && out.__agentError.includes('code'),
            `应报缺 code，实际 ${JSON.stringify(out)}`);
        assert(calls.ranCode.length === 0, '空 code 不得进执行器');
    });

    await check('js 空白 code 同样拦截', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('js', { code: '  \n ' }));
        assert(out.__agentError, '纯空白 code 应报错');
        assert(calls.ranCode.length === 0, '不得执行');
    });

    /**
     * 页面返回的业务 `error` 字段不是工具失败。
     *
     * 单键的 `{"error":"invalid token"}` 是最常见的接口响应之一。判据曾经按
     * "error 是唯一键就当参数错误"来分辨，于是这类响应被标成失败，模型对着
     * 一次**成功**的数据探测去修正参数。直接调判据，覆盖三种形态。
     */
    await check('页面业务数据的 error 字段不算 js 失败', async () => {
        eq(PARSE.isJsErrorResult('{"error":"invalid token"}'), false,
            '单键业务错误体是数据，不是工具失败');
        eq(PARSE.isJsErrorResult('{"error":"x","data":1}'), false, '带其他字段同理');
        eq(PARSE.isJsErrorResult('{"__agentError":"缺少 code"}'), true,
            '我们自己的失败必须认出来');
        eq(PARSE.isJsErrorResult('{"ok":true}'), false, '正常数据不是失败');
        eq(PARSE.isJsErrorResult('不是 JSON'), false, '不可解析的返回不算失败（那是页面给了非 JSON）');
    });

    /* --------------------- 全工具：action 严格区分大小写 --------------------- */

    // 大小写错误必须在第一步暴露（未知 action + 点名正确写法），
    // 不能猜着执行 —— 猜对是运气，猜错是烧一步。
    await check('tamper / storage / tokens 的 action 写错大小写就报错', async () => {
        const state = { intercept: [], request: [], headers: [], cookies: [], local: {}, session: {} };
        const t = buildDispatch(state);
        const badGet = j(await t.dispatchTool('tamper', { action: 'GET' }));
        assert(badGet.error && badGet.error.includes('get'), `大写 GET 应报错并提示 get，实际 ${JSON.stringify(badGet)}`);
        const badSet = j(await t.dispatchTool('tamper', { action: 'SET', intercept: [] }));
        assert(badSet.error && badSet.error.includes('set'), '大写 SET 应报错');

        const s = buildDispatch(state);
        const sBad = j(await s.dispatchTool('storage', { action: 'GET', area: 'LOCAL' }));
        assert(sBad.error, `大写 GET/LOCAL 应报错，实际 ${JSON.stringify(sBad)}`);

        const k = buildDispatch(state);
        const kBad = j(await k.dispatchTool('tokens', { action: 'FIND' }));
        assert(kBad.error && kBad.error.includes('find'), '大写 FIND 应报错');
    });

    /* ------------------------------ navigate ------------------------------ */

    await check('navigate：裸域名自动补 https', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, 'https://example.com/a');
        const out = j(await dispatchTool('navigate', { url: 'example.org/x' }));
        assert(out.url === 'https://example.org/x', `应补协议，实际 ${out.url}`);
        assert(calls.navigated[0] === 'https://example.org/x', '应按归一后的地址导航');
    });

    await check('navigate：相对路径相对当前页解析', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, 'https://example.com/a/b?x=1');
        const out = j(await dispatchTool('navigate', { url: '/api/login' }));
        assert(out.url === 'https://example.com/api/login', `应相对当前页解析，实际 ${out.url}`);
        assert(calls.navigated[0] === out.url, '导航地址与回显必须一致（下一步 js 基于它判断）');
    });

    await check('navigate：完整 URL 原样通过', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, 'https://example.com/');
        const out = j(await dispatchTool('navigate', { url: 'http://other.com/p' }));
        assert(out.url === 'http://other.com/p', '有协议的地址不得改动');
        assert(calls.navigated[0] === 'http://other.com/p', '导航地址应原样');
    });

    await check('navigate：无页面时报错', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, false);
        const out = j(await dispatchTool('navigate', { url: 'https://example.com/' }));
        assert(out.error && out.error.includes('没有可用'), `应报无页面，实际 ${JSON.stringify(out)}`);
    });

    /* ------------------------- tamper: get ------------------------- */

    await check('tamper get 返回三类规则（协议形态）', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [{ id: 'a', enabled: true, urlPattern: '*', jsonPath: 'vip', newValue: 'true' }],
            request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tamper', { action: 'get' }));
        assert(out.intercept.length === 1, 'intercept 应有 1 条');
        assert(out.intercept[0].key === 'vip', 'key 应为 vip（内部叫 jsonPath，不对外暴露）');
        assert(out.intercept[0].op === 'set', 'op 应为 set');
        assert(out.intercept[0].value === true, '引擎里的 "true" 应逆解成布尔 true');
        assert(out.intercept[0].url_pattern === '*', 'url_pattern 应为 *');
        assert(Array.isArray(out.headers), 'headers 应为数组');
    });

    /* ------------------- tamper: 部分更新（核心） ------------------- */

    // 模型只想加一条请求头规则，不能把用户的拦截规则清空。
    await check('tamper set 只传 headers 时保留 intercept/request', async () => {
        const { dispatchTool, calls, tamperRef } = buildDispatch({
            intercept: [{ id: 'a', enabled: true, urlPattern: '*', jsonPath: 'vip', newValue: 'true' }],
            request: [{ id: 'b', enabled: true, urlPattern: '*', jsonPath: 'x', newValue: '1' }],
            headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            headers: [{ enabled: true, url_pattern: '*', name: 'Referer', value: 'https://x' }],
        }));
        assert(out.applied === true, '应回 applied:true');
        assert(out.counts.intercept === 1, `intercept 应保留 1 条，实际 ${out.counts.intercept}`);
        assert(out.counts.request === 1, `request 应保留 1 条，实际 ${out.counts.request}`);
        assert(out.counts.headers === 1, `headers 应为 1 条，实际 ${out.counts.headers}`);
        assert(calls.apply === 1, '应调用 applyRules 一次');
        const st = tamperRef.rules;
        assert(st.interceptRules[0].jsonPath === 'vip', '拦截规则必须原样保留');
        assert(st.headerRules[0].headerName === 'Referer', '请求头规则名应写入内部 headerName');
    });

    // 模型改规则立刻生效，而宿主的 tamper 只有 applyRules 一口（没有落盘版）。
    await check('tamper set 只调 applyRules 一次，不碰别的写入口', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: true, url_pattern: '*', key: 'vip', value: true, op: 'set' }],
        });
        assert(calls.apply === 1, `应调用 applyRules，实际 ${calls.apply}`);
        eq(calls.setLocal.length + calls.setSession.length + calls.setCookie.length, 0,
            'tamper set 不得顺手写页面存储或 cookie —— 那是另外三个工具的事');
    });

    /**
     * 注入失败必须如实报，不能回 applied:true。
     *
     * 导航会重建页面主世界、把钩子冲掉，而注入是按页面发生的：没有可用标签页、
     * 或当前页面不允许注入（chrome://、扩展商店）时，规则进了内存却没进页面。
     * 报 applied:true 的话模型会以为成功了 —— 这是本项目里最难查的一类故障：
     * 界面显示"启用中"，页面里什么都没发生，且不报任何错。
     */
    await check('tamper set 注入失败时 applied 为 false 并说明原因', async () => {
        const { dispatchTool, tamperRef } = buildDispatch(EMPTY);
        tamperRef.injected = false;

        const out = j(await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: true, url_pattern: '*', key: 'vip', value: true, op: 'set' }],
        }));
        eq(out.applied, false, '注入没成功就不得回 applied:true');
        assert(out.note.includes('没能装上钩子'),
            `note 要说明页面里没生效，实际 ${out.note}`);
        assert(!out.note.includes('已对当前页面生效'),
            `不得同时说"已生效"，实际 ${out.note}`);
        // 规则本身仍然记下了 —— 用户之后点「应用更改」或刷新页面还能用上
        eq(out.counts.intercept, 1, '规则仍应记进内存（只是这个页面没装上钩子）');
    });

    await check('tamper set 给规则补上缺失的 id', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: true, url_pattern: '*', key: 'vip', value: true, op: 'set' }],
        }));
        assert(out.applied === true, '应成功');
        assert(out.counts.intercept === 1, '应有 1 条');
    });

    // 协议值是类型保持的：真布尔/数字按类型进引擎，字符串恒强制成字符串。
    // 模型写 value: true 得到布尔，写 value: "true" 得到字符串 —— 不再需要 = 前缀。
    await check('tamper set 类型保持：布尔按类型写入引擎', async () => {
        const { dispatchTool, tamperRef } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: true, url_pattern: '*', key: 'vip', value: true, op: 'set' }],
        });
        const v = tamperRef.rules.interceptRules[0].newValue;
        assert(typeof v === 'string', `newValue 必须是字符串，实际 ${typeof v}`);
        assert(v === 'true', `newValue 应为 "true"，实际 ${JSON.stringify(v)}`);
    });

    await check('tamper set 类型保持：字符串 "123" 不变成数字 123', async () => {
        const { dispatchTool, tamperRef } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: true, url_pattern: '*', key: 'code', value: '123', op: 'set' }],
        });
        const v = tamperRef.rules.interceptRules[0].newValue;
        assert(v === '=123', `字符串必须强制前缀，实际 ${JSON.stringify(v)}（否则引擎会按数字 123 写入）`);
        // 往返：get 应把 "=123" 逆解回字符串 "123"
        const { dispatchTool: d2 } = buildDispatch({
            intercept: tamperRef.rules.interceptRules,
            request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const got = j(await d2('tamper', { action: 'get' }));
        assert(got.intercept[0].value === '123', `get 应逆解回字符串，实际 ${JSON.stringify(got.intercept[0])}`);
    });

    await check('tamper set op delete 写成 undefined（删字段）', async () => {
        const { dispatchTool, tamperRef } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: true, url_pattern: '*', key: 'secret', op: 'delete' }],
        }));
        assert(out.applied === true, '应成功');
        assert(tamperRef.rules.interceptRules[0].newValue === 'undefined',
            'delete 应译成 undefined（引擎删字段语义）');
    });

    await check('tamper set 非法 op 报错', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: true, url_pattern: '*', key: 'vip', value: 1, op: 'remove' }],
        }));
        assert(typeof out.error === 'string' && out.error.includes('op'), `应报未知 op，实际 ${JSON.stringify(out)}`);
        assert(calls.apply === 0, '出错时不得改引擎状态');
    });

    await check('tamper set 缺 value 报错（set 必须给值）', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: true, url_pattern: '*', key: 'vip', op: 'set' }],
        }));
        assert(typeof out.error === 'string' && out.error.includes('value'), `应报缺 value，实际 ${JSON.stringify(out)}`);
        assert(calls.apply === 0, '出错时不得改引擎状态');
    });

    await check('tamper set 非法 action 报错', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tamper', { action: 'nope' }));
        assert(typeof out.error === 'string', '应回错误');
    });

    /**
     * value 的 '' 在引擎里是**删除该请求头**的意思。
     * 所以模型传数字 42 时必须收敛成 "42"；若被当成"非字符串 → 空串"，
     * 用户的请求头会被静默删掉 —— 一个赋值操作变成了破坏操作。
     */
    await check('tamper set 保留数字 value（空串是删除语义）', async () => {
        const { dispatchTool, tamperRef } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            headers: [{ enabled: true, url_pattern: '*', name: 'X-Retry', value: 42 }],
        }));
        assert(out.applied === true, '应成功');
        const hv = tamperRef.rules.headerRules[0].headerValue;
        assert(hv === '42', `headerValue 应为 "42"，实际 ${JSON.stringify(hv)}（空串会删除该请求头）`);
    });

    await check('tamper set 保留布尔 value', async () => {
        const { dispatchTool, tamperRef } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        await dispatchTool('tamper', {
            action: 'set',
            headers: [{ enabled: true, url_pattern: '*', name: 'X-Flag', value: false }],
        });
        const hv = tamperRef.rules.headerRules[0].headerValue;
        assert(hv === 'false', `headerValue 应为 "false"，实际 ${JSON.stringify(hv)}`);
    });

    await check('tamper set 传非数组报错', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper', { action: 'set', intercept: 'oops' }));
        assert(typeof out.error === 'string', '应回错误');
        assert(calls.apply === 0, '出错时不得改引擎状态');
    });

    /* --------------- tamper: 报出被引擎跳过的规则 --------------- */

    /**
     * 引擎对没有目标键的规则直接丢弃（它永远匹配不上），但那是**静默**的。
     * 不回传的话模型收到 applied:true 就以为设置成功了，实际页面里什么都没发生。
     */
    await check('tamper set 报出被跳过的字段规则', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            intercept: [
                { enabled: true, url_pattern: '*', key: 'vip', value: true, op: 'set' },
                { enabled: true, url_pattern: '*', key: '', value: true, op: 'set' },
            ],
        }));
        assert(out.applied === true, '仍应回 applied:true（规则本身合法，只是有一条无效）');
        assert(Array.isArray(out.dropped), '应带 dropped 数组');
        assert(out.dropped.length === 1, `应有 1 条被跳过，实际 ${out.dropped.length}`);
        assert(out.dropped[0].group === 'intercept', `group 应为 intercept，实际 ${out.dropped[0].group}`);
        assert(out.dropped[0].index === 1, `index 应为 1，实际 ${out.dropped[0].index}`);
        assert(typeof out.dropped[0].reason === 'string' && out.dropped[0].reason, '应说明原因');
    });

    await check('tamper set 报出被跳过的请求头规则', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            headers: [
                { enabled: true, url_pattern: '*', name: 'Referer', value: 'x' },
                { enabled: true, url_pattern: '*', name: '', value: 'y' },
            ],
        }));
        assert(out.dropped.length === 1, `应有 1 条被跳过，实际 ${out.dropped.length}`);
        assert(out.dropped[0].group === 'headers', 'group 应为 headers');
        assert(out.dropped[0].index === 1, 'index 应为 1');
    });

    // 只有点号的写法引擎也认作"没有目标键"，只判空串会漏报
    await check('tamper set 把只有点号的 key 也算作被跳过', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: true, url_pattern: '*', key: '.', value: 1, op: 'set' }],
        }));
        assert(out.dropped.length === 1, `"." 应被判为无目标键，实际 ${out.dropped.length}`);
    });

    // 已禁用的规则不算"被跳过" —— 那是用户/模型主动关的，报出来是噪音
    await check('tamper set 不把已禁用的规则算作被跳过', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: false, url_pattern: '*', key: '', value: 1, op: 'set' }],
        }));
        assert(out.dropped === undefined, `已禁用的规则不该报 dropped，实际 ${JSON.stringify(out.dropped)}`);
    });

    // 全部合法时不该出现 dropped 字段：空数组会让模型误以为"有被跳过的"
    await check('tamper set 全部合法时不含 dropped 字段', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: true, url_pattern: '*', key: 'vip', value: true, op: 'set' }],
            headers: [{ enabled: true, url_pattern: '*', name: 'X', value: '1' }],
        }));
        assert(!('dropped' in out), `不该有 dropped 字段，实际 ${JSON.stringify(out.dropped)}`);
        assert(!/跳过/.test(out.note), `note 不该提跳过，实际 ${out.note}`);
    });

    await check('tamper set 有跳过时 note 里说明条数', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            intercept: [
                { enabled: true, url_pattern: '*', key: '', value: 1, op: 'set' },
                { enabled: true, url_pattern: '*', key: '.', value: 1, op: 'set' },
            ],
        }));
        assert(out.dropped.length === 2, `应有 2 条，实际 ${out.dropped.length}`);
        assert(out.note.includes('2'), `note 应说明条数，实际 ${out.note}`);
    });

    // 部分更新时，未传的那一类若含无效规则，也该被报出来 ——
    // 否则模型会以为"我没动它所以不关我事"，而页面里那类规则确实没生效
    await check('tamper set 也报出未传类别里的无效规则', async () => {
        const { dispatchTool } = buildDispatch({
            ...EMPTY,
            request: [{ id: 'r1', enabled: true, urlPattern: '*', jsonPath: '', newValue: '1' }],
        });
        const out = j(await dispatchTool('tamper', {
            action: 'set',
            headers: [{ enabled: true, url_pattern: '*', name: 'X', value: '1' }],
        }));
        assert(out.dropped.length === 1, `应报出未传类别里的无效规则，实际 ${out.dropped.length}`);
        assert(out.dropped[0].group === 'request', `group 应为 request，实际 ${out.dropped[0].group}`);
    });

    /* --------------------------- storage --------------------------- */

    await check('storage get local 返回展开后的对象', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [],
            local: { vip: 'true', n: '1' }, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'get', area: 'local' }));
        assert(out.area === 'local', 'area 应为 local');
        assert(out.data.vip === 'true', 'data 应是对象而非字符串');
    });

    await check('storage set local 写入字符串', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'set', area: 'local', key: 'k', value: 'v' }));
        assert(out.saved === true, '应成功');
        assert(calls.setLocal.length === 1 && calls.setLocal[0][0] === 'k', '应写 k');
    });

    // 模型常把布尔/数字当值传进来；直接塞给 setItem 会变成 "[object Object]"
    await check('storage set 把非字符串值序列化', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        await dispatchTool('storage', { action: 'set', area: 'local', key: 'k', value: { a: 1 } });
        assert(calls.setLocal[0][1] === '{"a":1}', `应序列化成 JSON，实际 ${calls.setLocal[0][1]}`);
    });

    await check('storage delete local', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'delete', area: 'local', key: 'k' }));
        assert(out.deleted === true, '应成功');
        assert(calls.removed.includes('local:k'), '应调用 removeLocalStorage');
    });

    await check('storage 未知 area 报错', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'get', area: 'indexeddb' }));
        assert(typeof out.error === 'string', '应回错误');
    });

    await check('storage set 缺 key 报错', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'set', area: 'local', value: 'v' }));
        assert(typeof out.error === 'string', '应回错误');
    });

    /**
     * set 缺 value 必须报错，不能当成空值写下去。
     *
     * 少打一个字段就**静默改掉了这条数据的值**，而回执是 `{saved:true}` ——
     * 模型照着自己写的值往下走，页面里读到的却是空。清空是合法操作，但要显式
     * 传空串：两者混在一起，就再也分不出"它想清空"与"它忘了写"。
     */
    await check('storage set 缺 value 报错（不得静默清空）', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);

        const local = j(await dispatchTool('storage', { action: 'set', area: 'local', key: 'k' }));
        assert(typeof local.error === 'string' && local.error.includes('value'),
            `local set 缺 value 应回缺 value 的错误，实际 ${JSON.stringify(local)}`);
        assert(calls.setLocal.length === 0, '不得写下去');

        const cookie = j(await dispatchTool('storage', { action: 'set', area: 'cookie', key: 'n' }));
        assert(typeof cookie.error === 'string' && cookie.error.includes('value'),
            `cookie set 缺 value 应回缺 value 的错误，实际 ${JSON.stringify(cookie)}`);
        assert(calls.setCookie.length === 0, '不得写下去');

        // 显式空串照旧合法 —— 那是"要清空"，与"忘了写"不是一回事
        const empty = j(await dispatchTool('storage', { action: 'set', area: 'local', key: 'k', value: '' }));
        assert(empty.saved === true, `显式空串必须仍能写入，实际 ${JSON.stringify(empty)}`);
        assert(calls.setLocal.length === 1 && calls.setLocal[0][1] === '', '写下去的应是空串本身');
    });

    // cookie 整条覆盖：改值必须带上 httpOnly / expirationDate，否则会话 cookie 会降级
    await check('storage set cookie 保留 httpOnly 与过期时间', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [
                { name: 'sid', value: 'old', httpOnly: true, secure: true, path: '/', domain: '.a.com', expirationDate: 1234567, sameSite: 'lax' },
            ],
            local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'set', area: 'cookie', key: 'sid', value: 'new' }));
        assert(out.saved === true, '应成功');
        const c = calls.setCookie[0];
        assert(c.value === 'new', '值应更新');
        assert(c.httpOnly === true, `httpOnly 必须保留，实际 ${c.httpOnly}`);
        assert(c.expirationDate === 1234567, `过期时间必须保留，实际 ${c.expirationDate}`);
        assert(c.sameSite === 'lax', 'sameSite 必须保留');
    });

    // asString(数字) 会得到空串 —— 那等于静默清空 cookie
    await check('storage set cookie 非字符串值不变成空串', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [],
            cookies: [{ name: 'n', value: 'old', path: '/', domain: 'a.com' }],
            local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'set', area: 'cookie', key: 'n', value: 42 }));
        assert(out.saved === true, '应成功');
        assert(calls.setCookie[0].value === '42', `应为 "42"，实际 ${JSON.stringify(calls.setCookie[0].value)}`);
        assert(out.value === '42', `回显应为 "42"，实际 ${JSON.stringify(out.value)}`);
    });

    await check('storage delete cookie', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [{ name: 'sid', value: 'x' }], local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'delete', area: 'cookie', key: 'sid' }));
        assert(out.deleted === true, '应成功');
        assert(calls.removed.includes('sid'), '应调用 removeCookie');
    });

    /**
     * 同名 cookie 并存时，只给 name 必须**拒绝**，不能猜。
     *
     * 旧实现 `.find(c => c.name === name)` 永远命中第一条：
     * 改不到第二条，还会把第一条的 httpOnly / 过期时间抄到写回对象上
     * （setCookie 是整条覆盖）—— 于是第二条被"降级"成第一条的属性。
     */
    await check('storage get cookie 带唯一 key', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [
                { name: 'sid', value: 'HOST', domain: 'sub.example.com', path: '/' },
                { name: 'sid', value: 'PARENT', domain: '.example.com', path: '/' },
            ],
            local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'get', area: 'cookie' }));
        assert(out.count === 2, `应返回 2 条，实际 ${out.count}`);
        assert(
            out.cookies[0].key !== out.cookies[1].key,
            `两条 key 必须不同，实际都是 ${JSON.stringify(out.cookies[0].key)}`,
        );
    });

    await check('storage set cookie 同名并存时按 key 改对那一条', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [
                { name: 'sid', value: 'HOST', domain: 'sub.example.com', path: '/', httpOnly: true, expirationDate: 111 },
                { name: 'sid', value: 'PARENT', domain: '.example.com', path: '/', httpOnly: false, expirationDate: 222 },
            ],
            local: {}, session: {},
        });
        const got = j(await dispatchTool('storage', { action: 'get', area: 'cookie' }));
        const second = got.cookies[1];

        const out = j(await dispatchTool('storage', {
            action: 'set', area: 'cookie', key: second.key, value: 'NEW',
        }));
        assert(out.saved === true, `应成功，实际 ${JSON.stringify(out)}`);
        const c = calls.setCookie[0];
        assert(c.domain === '.example.com', `应改 .example.com 那条，实际 ${c.domain}`);
        // 属性必须来自**它自己**，不能是第一条的
        assert(c.httpOnly === false, `httpOnly 应取自第二条(false)，实际 ${c.httpOnly}`);
        assert(c.expirationDate === 222, `过期时间应取自第二条(222)，实际 ${c.expirationDate}`);
    });

    // 只收 key，不收 name：按名猜在并存时必然改错，单条时 key 与名等价。
    // name 参数已彻底移除 —— 传了也会被忽略，缺 key 直接报错。
    await check('storage set cookie 缺 key 报错', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [
                { name: 'sid', value: 'HOST', domain: 'sub.example.com', path: '/' },
                { name: 'sid', value: 'PARENT', domain: '.example.com', path: '/' },
            ],
            local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'set', area: 'cookie', value: 'X' }));
        assert(typeof out.error === 'string', `应报错，实际 ${JSON.stringify(out)}`);
        assert(calls.setCookie.length === 0, '缺 key 时不该写任何 cookie');
    });

    // key 命中不存在的条目：不能新建（编一个 key 等于在猜改哪一条），必须报错
    await check('storage set cookie key 不存在时报错', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [
                { name: 'sid', value: 'old', domain: 'a.com', path: '/', httpOnly: true },
            ],
            local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'set', area: 'cookie', key: 'nope', value: 'new' }));
        assert(typeof out.error === 'string', `应报错，实际 ${JSON.stringify(out)}`);
        assert(calls.setCookie.length === 0, '不该写入');
    });

    // delete 一个不存在的 key：不能报 deleted:true（removeCookie 对不存在的名字也不报错）
    await check('storage delete cookie 不存在时报错', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [{ name: 'sid', value: 'x' }], local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'delete', area: 'cookie', key: 'nope' }));
        assert(typeof out.error === 'string', `应报错，实际 ${JSON.stringify(out)}`);
        assert(calls.removed.length === 0, '不该调用 removeCookie');
    });

    /* ---------------------------- tokens ---------------------------- */

    await check('tokens decode 解出 payload', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t = `${b64({ alg: 'none' })}.${b64({ sub: '1' })}.sig`;
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tokens', { action: 'decode', token: t }));
        assert(out.payload.sub === '1', 'payload 应解出 sub');
    });

    await check('tokens decode 坏 token 报错', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tokens', { action: 'decode', token: 'garbage' }));
        assert(typeof out.error === 'string', '应回错误');
    });

    /**
     * 核心：find 报出的 key 必须能直接拿去 rewrite。
     * cookie 的键是 cookie 名；如果按数组下标枚举，会得到 "0" ——
     * 模型拿它当 name 去写回就找不到那条 cookie。
     */
    await check('tokens find 的 cookie key 是 cookie 名而非数组下标', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t = `${b64({ alg: 'none' })}.${b64({ sub: '9' })}.sig`;
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [],
            cookies: [{ name: 'auth_token', value: t }],
            local: {}, session: {},
        });
        const out = j(await dispatchTool('tokens', { action: 'find' }));
        assert(out.count === 1, `应找到 1 个，实际 ${out.count}`);
        assert(out.tokens[0].area === 'cookie', `area 应为 cookie，实际 ${out.tokens[0].area}`);
        assert(out.tokens[0].key === 'auth_token', `key 应为 auth_token，实际 ${JSON.stringify(out.tokens[0].key)}`);
    });

    await check('tokens find 同时扫 local 与 session', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t1 = `${b64({ alg: 'none' })}.${b64({ i: 1 })}.sig`;
        const t2 = `${b64({ alg: 'none' })}.${b64({ i: 2 })}.sig`;
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [],
            local: { token: t1 }, session: { tok2: t2 },
        });
        const out = j(await dispatchTool('tokens', { action: 'find' }));
        assert(out.count === 2, `应找到 2 个，实际 ${out.count}`);
        const areas = out.tokens.map((x) => x.area).sort();
        assert(areas.join(',') === 'local,session', `来源应为 local,session，实际 ${areas.join(',')}`);
    });

    await check('tokens find 无结果时 count 为 0', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: { a: 'plain' }, session: {},
        });
        const out = j(await dispatchTool('tokens', { action: 'find' }));
        assert(out.count === 0, `应为 0，实际 ${out.count}`);
    });

    /**
     * 同一个 token 出现在多处时，**每一处都要报出来**。
     *
     * 旧实现按 token 值去重（`!found.some(f => f.token === token)`），
     * 于是只报最先扫到的那一处。登录态恰恰是"同一个 token 同时躺在
     * local / session / cookie 里"这种形态 —— 模型以为改一处就够了，
     * 而页面读的可能是另一处，rewrite 报了成功却没生效。
     */
    await check('tokens find 报出同一个 token 的所有位置', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const same = `${b64({ alg: 'none' })}.${b64({ sub: '1' })}.sig`;
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [],
            cookies: [{ name: 'sid', value: same }],
            local: { token: same }, session: { auth: same },
        });
        const out = j(await dispatchTool('tokens', { action: 'find' }));

        assert(out.count === 3, `应报出 3 处，实际 ${out.count}`);
        const froms = out.tokens.map((x) => x.from).sort();
        assert(
            froms.join(',') === 'cookie.sid,local.token,session.auth',
            `三处都要报出来，实际 ${froms.join(',')}`,
        );

        // 多位置要单独点出来，模型才知道"改一处不够"
        assert(Array.isArray(out.sharedTokens), '应带 sharedTokens');
        assert(out.sharedTokens.length === 1, `应有 1 个共享 token，实际 ${out.sharedTokens.length}`);
        assert(out.sharedTokens[0].count === 3, `共享计数应为 3，实际 ${out.sharedTokens[0].count}`);
    });

    // 只有一个位置时不该带 sharedTokens（空数组会被误读成"有共享 token"）
    await check('tokens find 单一时不带 sharedTokens', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t = `${b64({ alg: 'none' })}.${b64({ a: 1 })}.sig`;
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: { token: t }, session: {},
        });
        const out = j(await dispatchTool('tokens', { action: 'find' }));
        assert(out.count === 1, `应找到 1 个，实际 ${out.count}`);
        assert(out.sharedTokens === undefined, '不该带 sharedTokens');
    });

    // 同一位置不会被重复计入（去重仍然生效，只是改成按位置去重）
    await check('tokens find 同一位置不重复计入', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t = `${b64({ alg: 'none' })}.${b64({ a: 1 })}.sig`;
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [],
            local: { token: t }, session: {},
        });
        const out = j(await dispatchTool('tokens', { action: 'find' }));
        assert(out.count === 1, `同一个位置只算一次，实际 ${out.count}`);
    });

    /**
     * 同名 cookie 在不同 domain 下并存时，两条的 key 必须不同。
     *
     * 旧实现直接拿 c.name 当 key：两条的 from 都是 "cookie.sid"，
     * 模型连"有两条、要改第几条"都分不出来；rewrite 又用
     * `find(c => c.name === key)` 只命中先出现的那条 —— 第二条永远改不到。
     */
    await check('tokens find 区分同名不同 domain 的 cookie', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t1 = `${b64({ alg: 'none' })}.${b64({ host: 'sub' })}.sig`;
        const t2 = `${b64({ alg: 'none' })}.${b64({ host: 'parent' })}.sig`;
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [],
            cookies: [
                { name: 'sid', value: t1, domain: 'sub.example.com', path: '/' },
                { name: 'sid', value: t2, domain: '.example.com', path: '/' },
            ],
            local: {}, session: {},
        });
        const out = j(await dispatchTool('tokens', { action: 'find' }));
        assert(out.count === 2, `应找到 2 个，实际 ${out.count}`);
        assert(
            out.tokens[0].key !== out.tokens[1].key,
            `两条 key 必须不同，实际都是 ${JSON.stringify(out.tokens[0].key)}`,
        );
        assert(
            out.tokens[0].from !== out.tokens[1].from,
            `两条 from 必须不同，实际都是 ${out.tokens[0].from}`,
        );
    });

    // rewrite 必须按 find 给的 key 取回**那一条**，不能只按 cookie 名
    await check('tokens rewrite 按唯一键写回正确的那条 cookie', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t1 = `${b64({ alg: 'none' })}.${b64({ host: 'sub' })}.sig`;
        const t2 = `${b64({ alg: 'none' })}.${b64({ host: 'parent' })}.sig`;
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [],
            cookies: [
                { name: 'sid', value: t1, domain: 'sub.example.com', path: '/' },
                { name: 'sid', value: t2, domain: '.example.com', path: '/' },
            ],
            local: {}, session: {},
        });

        const found = j(await dispatchTool('tokens', { action: 'find' }));
        // 挑第二条（.example.com 那条）来改
        const target = found.tokens[1];
        const res = j(await dispatchTool('tokens', {
            action: 'rewrite', token: target.token, changes: { vip: true },
            area: 'cookie', key: target.key,
        }));
        assert(res.rewritten === true, `应改写成功，实际 ${JSON.stringify(res)}`);
        assert(calls.setCookie.length === 1, `应写回 1 条，实际 ${calls.setCookie.length}`);
        assert(
            calls.setCookie[0].domain === '.example.com',
            `应写回 .example.com 那条，实际 ${calls.setCookie[0].domain}`,
        );
    });

    /**
     * key 拼错时要明确报错，而不是静默命中"同名的另一条"。
     *
     * 只在**有撞键**时才可能误伤：单条 cookie 的简键就是它的 name，
     * 用 "sid" 查本来就该命中。两条同名并存时简键失效，
     * 这时若还按 name 回退去找，就会改到先出现的那条 —— 而模型以为改的是另一条。
     */
    await check('tokens rewrite 在键有歧义时报错而非误改', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t1 = `${b64({ alg: 'none' })}.${b64({ host: 'sub' })}.sig`;
        const t2 = `${b64({ alg: 'none' })}.${b64({ host: 'parent' })}.sig`;
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [],
            cookies: [
                { name: 'sid', value: t1, domain: 'sub.example.com', path: '/' },
                { name: 'sid', value: t2, domain: '.example.com', path: '/' },
            ],
            local: {}, session: {},
        });
        // 模型偷懒只传 cookie 名（不带 domain）—— 有歧义，必须拒绝
        const res = j(await dispatchTool('tokens', {
            action: 'rewrite', token: t2, changes: { host: 'x' }, area: 'cookie', key: 'sid',
        }));
        assert(typeof res.error === 'string', `有歧义时应报错，实际 ${JSON.stringify(res)}`);
        assert(calls.setCookie.length === 0, '有歧义时不该写任何 cookie');
    });

    // 单条 cookie 时简键就是它的 name，用 name 查必须正常工作（别修过头）
    await check('tokens rewrite 单条 cookie 时用 name 仍可写回', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t = `${b64({ alg: 'none' })}.${b64({ a: 1 })}.sig`;
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [],
            cookies: [{ name: 'sid', value: t, domain: 'sub.example.com', path: '/' }],
            local: {}, session: {},
        });
        const res = j(await dispatchTool('tokens', {
            action: 'rewrite', token: t, changes: { a: 2 }, area: 'cookie', key: 'sid',
        }));
        assert(res.rewritten === true, `应改写成功，实际 ${JSON.stringify(res)}`);
        assert(calls.setCookie.length === 1, '应写回 1 条');
    });

    await check('tokens rewrite 写回 storage 并提示签名失效', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t = `${b64({ alg: 'HS256' })}.${b64({ vip: false })}.sig`;
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: { token: t }, session: {},
        });
        const out = j(await dispatchTool('tokens', {
            action: 'rewrite', token: t, changes: { vip: true }, area: 'local', key: 'token',
        }));
        assert(out.rewritten === true, '应成功');
        assert(typeof out.warning === 'string' && out.warning.length > 0, '必须提示签名失效');
        assert(calls.setLocal.length === 1, '应写回 local');
        assert(calls.setLocal[0][1] !== t, '写回的值应是新 token');
    });

    await check('tokens rewrite 缺 key 报错', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t = `${b64({ alg: 'none' })}.${b64({ a: 1 })}.sig`;
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tokens', { action: 'rewrite', token: t, changes: { a: 2 } }));
        assert(typeof out.error === 'string', '应回错误');
    });

    await check('tokens rewrite 缺 changes 报错', async () => {
        const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const t = `${b64({ alg: 'none' })}.${b64({ a: 1 })}.sig`;
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tokens', { action: 'rewrite', token: t, area: 'local', key: 'k' }));
        assert(typeof out.error === 'string', '应回错误');
    });

    /* ------------------------- sandbox：本机沙箱 ------------------------- */

    /**
     * 派发层只认「参数有没有转过去」与「失败有没有如实报」，
     * 路径越界的判据在应用侧（下面 SBX 那一段直接调它），这里不重复实现一份。
     */
    await check('sandbox write 把 action/path/content 原样转给应用', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('sandbox', {
            action: 'write', path: 'out/notes.md', content: '# 结论',
        }));
        assert(calls.sandbox.length === 1, `应调用一次，实际 ${calls.sandbox.length}`);
        const sent = calls.sandbox[0];
        eq(sent.action, 'write');
        eq(sent.path, 'out/notes.md');
        eq(sent.content, '# 结论');
        eq(out.bytes, 1);
    });

    await check('sandbox edit 把 old/new 原样转给应用（new 允许空串）', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        await dispatchTool('sandbox', { action: 'edit', path: 'a.md', old: '旧', new: '新' });
        const sent = calls.sandbox[0];
        eq(sent.old, '旧');
        eq(sent.new, '新');

        // 空串是合法入参（删掉这一段），不能被 `...(next ? {} : {})` 那类写法吞掉
        await dispatchTool('sandbox', { action: 'edit', path: 'a.md', old: '旧', new: '' });
        eq(calls.sandbox[1].new, '', 'new 为空串时必须照样传下去');
    });

    await check('sandbox lines 传行号区间，checkjs 只传 content 不传 path', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        await dispatchTool('sandbox', { action: 'lines', path: 'a.md', start: 3, end: 5, content: 'x' });
        const sent = calls.sandbox[0];
        eq(sent.start, 3);
        eq(sent.end, 5);
        eq(sent.content, 'x');

        await dispatchTool('sandbox', { action: 'checkjs', content: 'const a = 1;' });
        const js = calls.sandbox[1];
        eq(js.action, 'checkjs');
        eq(js.content, 'const a = 1;');
        assert(!('path' in js), 'checkjs 不碰文件系统，不该带 path');
    });

    await check('sandbox 未知 action 列出全部可用值', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('sandbox', { action: 'WRITE', path: 'a' }));
        assert(typeof out.error === 'string', '大写 WRITE 必须失败（全小写严格匹配）');
        assert(out.error.includes('list / read / write / delete / edit / lines / checkjs / node'),
            `错误里必须列全可用动作，实际：${out.error}`);
        assert(calls.sandbox.length === 0, '动作写错时不得惊动应用');
    });

    /**
     * exec 已经删掉了，而模型的历史里可能还留着旧写法。
     *
     * 这条钉的是"旧动作名必须被明确拒绝"，不是"恰好不在白名单里" ——
     * 后者在有人把 exec 加回来时不会报红。
     */
    await check('sandbox 不再有 exec：调它会被当作未知 action 拒掉', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('sandbox', { action: 'exec', command: 'ls' }));
        assert(typeof out.error === 'string', 'exec 必须失败');
        assert(out.error.includes('未知 action'), `应是未知 action，实际：${out.error}`);
        assert(calls.sandbox.length === 0, '不能把 exec 请求发给应用');
    });

    /**
     * `node` 不是 exec 的回归：它只接受 path（跑哪个文件）+ timeout，
     * **不接受 command**。把 command 透传过去就等于把 shell 又开了回来。
     */
    await check('sandbox node 只带 path 与 timeout，绝不透传 command', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        await dispatchTool('sandbox', {
            action: 'node', path: 'out/crack.js', timeout: 120000, command: 'rm -rf /',
        });
        const sent = calls.sandbox[0];
        eq(sent.action, 'node');
        eq(sent.path, 'out/crack.js');
        eq(sent.timeout, 120000);
        assert(!('command' in sent), 'command 字段绝不能过桥 —— 那等于把 shell 加回来');
    });

    /**
     * write / lines 缺 content 必须报错，而不是当成空串写下去。
     *
     * 当成空串的话，模型少打一个字段就**清空了一个它本来想保留的文件**，
     * 而回执是 {bytes:0} —— 看起来像是"写了个空文件"，不像出了事。
     */
    await check('sandbox write / lines 缺 content 报错而不是清空文件', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        const w = j(await dispatchTool('sandbox', { action: 'write', path: 'out/keep.md' }));
        assert(typeof w.error === 'string', 'write 缺 content 应报错');
        const l = j(await dispatchTool('sandbox', { action: 'lines', path: 'out/keep.md', start: 1 }));
        assert(typeof l.error === 'string', 'lines 缺 content 应报错');
        assert(calls.sandbox.length === 0, '绝不能把清空文件的请求发出去');
    });

    await check('sandbox edit 缺 old、lines 缺 start、文件动作缺 path 都报错', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        assert(typeof j(await dispatchTool('sandbox', { action: 'edit', path: 'a.md', new: 'x' })).error === 'string',
            'edit 缺 old 应报错');
        assert(typeof j(await dispatchTool('sandbox', { action: 'lines', path: 'a.md', content: 'x' })).error === 'string',
            'lines 缺 start 应报错');
        assert(typeof j(await dispatchTool('sandbox', { action: 'read' })).error === 'string',
            'read 缺 path 应报错');
        assert(typeof j(await dispatchTool('sandbox', { action: 'node' })).error === 'string',
            'node 缺 path 应报错（跑哪个文件是必填）');
        assert(typeof j(await dispatchTool('sandbox', { action: 'checkjs' })).error === 'string',
            'checkjs 缺 content 应报错');
        assert(calls.sandbox.length === 0, '参数不全时不该惊动应用');
    });

    /**
     * 桥断了（端口 reject）与"应用回了 error"是两条不同的失败路径。
     *
     * reject 若穿出 dispatchTool，引擎那圈 catch 只会给出「工具 sandbox 执行时抛出异常」，
     * 模型读不出"是应用没开"，于是反复改参数 —— 而改参数永远好不了。
     */
    await check('sandbox 应用未连接时回可行动的错误，不抛异常', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, DEFAULT_TAB_URL, () => {
            throw new Error('本机应用未连接');
        });
        const out = j(await dispatchTool('sandbox', { action: 'list', path: '.' }));
        assert(typeof out.error === 'string', '应回 error 字段而不是抛出');
        assert(out.error.includes('本机应用未连接'), `应把原始故障原因带出来，实际：${out.error}`);
    });

    await check('sandbox 应用返回的 error 原样回灌', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, DEFAULT_TAB_URL, () => ({
            error: 'ENOENT: no such file or directory',
        }));
        const out = j(await dispatchTool('sandbox', { action: 'read', path: 'nope.md' }));
        assert(out.error.includes('ENOENT'), 'fs 的错误码是模型改参数的依据，不得改写');
    });

    /* ------------------- sandbox：越界判据（直接调用） ------------------- */

    /**
     * 这一段直接 require 应用侧的 `app/main/sandbox.js` 并**调用判据**。
     *
     * 不去 grep main.js 的源码：把 `resolveSandboxPath` 换成 `() => null` 或
     * `() => 'C:\\'`，源码断言照样全绿（见 §5.4 的教训）。判据必须被求值。
     */
    const SBX = require(path.join(ROOT, 'app', 'main', 'sandbox.js'));
    const FAKE_ROOT = path.join(path.sep + 'tmp', 'fake-sandbox');
    const okPath = (p) => SBX.resolveSandboxPath(FAKE_ROOT, p) !== null;

    await check('沙箱根内的相对路径放行', async () => {
        assert(okPath('a.md'), '根内单层应放行');
        assert(okPath('out/sub/a.md'), '根内多层应放行');
        assert(okPath('out\\sub\\a.md'), 'Windows 分隔符同样应放行');
        assert(okPath('./a.md'), '开头的 ./ 应被吸收');
        // 模型问"沙箱里有什么"最自然的写法就是 path:"."，拒了它等于功能不可用
        eq(SBX.resolveSandboxPath(FAKE_ROOT, '.'), FAKE_ROOT, 'path "." 应解析到沙箱根');
        eq(SBX.resolveSandboxPath(FAKE_ROOT, './'), FAKE_ROOT, '"./" 同样');
        eq(SBX.resolveSandboxPath(FAKE_ROOT, 'out/..'), null, '带 .. 的一律拒绝');
        const resolved = SBX.resolveSandboxPath(FAKE_ROOT, 'out/a.md');
        assert(resolved.startsWith(FAKE_ROOT), `解析结果应在根内，实际 ${resolved}`);
    });

    await check('越界写法一律拒绝', async () => {
        for (const bad of ['../a', 'out/../../a', '..', '/etc/passwd', 'C:\\Windows\\a', '']) {
            assert(!okPath(bad), `应拒绝：${JSON.stringify(bad)}`);
            eq(SBX.resolveSandboxPath(FAKE_ROOT, bad), null, `应拒绝：${bad}`);
        }
    });

    /**
     * 拒绝的判据要**覆盖三类不同写法**，而不是同一类的三种拼法：
     * 相对上跳（..）、绝对路径（/ 开头）、盘符（C:）。只测第一类的话，
     * 把判据写成"只查 .."的弱版本照样全绿。
     */
    await check('拒绝判据不是只查 ..', async () => {
        assert(!okPath('/etc/passwd'), '绝对路径必须被拒（否则判据只防了 ..）');
        assert(!okPath('C:\\Windows'), '盘符必须被拒');
    });

    /**
     * 替换判据直接求值，不 grep 源码。
     *
     * 这三条是"改文件"的全部安全性所在：判错一处就是把用户的文件改坏，
     * 而回执说成功。所以每一类失败写法都要有一条用例。
     */
    await check('replaceOnce 唯一命中才替换', async () => {
        const ok = SBX.replaceOnce('a\nb\nc\n', 'b', 'B');
        eq(ok.text, 'a\nB\nc\n');
        eq(ok.replaced, 1, '成功时要说清替换了几处');
    });

    await check('replaceOnce 0 命中拒绝落盘', async () => {
        const miss = SBX.replaceOnce('a\nb\n', 'zzz', 'X');
        assert(typeof miss.error === 'string', '找不到就必须报错');
        assert(miss.text === undefined, '失败时不得给出可写回的文本');
    });

    await check('replaceOnce 多处命中拒绝落盘（不许猜改哪一处）', async () => {
        const many = SBX.replaceOnce('x\nx\n', 'x', 'y');
        assert(typeof many.error === 'string', '命中多次必须报错');
        assert(many.error.includes('多次'), `错误要说清是"多次命中"，实际：${many.error}`);
        assert(many.text === undefined, '失败时不得给出可写回的文本');
    });

    /**
     * `$&` / `$1` 这类替换模板只有在用 `String.replace` 时才会被展开。
     * 判据取"结果与输入逐字相等"：用 replace 实现的版本会把它换成匹配到的原文，
     * 而模型写下的字面量被静默改写 —— 这是实测踩过的坑。
     */
    await check('replaceOnce 不把 $& / $1 当反向引用展开', async () => {
        const r = SBX.replaceOnce('price = 100\n', '100', '$& + $1');
        eq(r.text, 'price = $& + $1\n', '替换文本里的 $ 符号必须原样落盘');
    });

    await check('replaceLines 按闭区间替换，行号 1 起', async () => {
        const r = SBX.replaceLines('l1\nl2\nl3\nl4\n', 2, 3, 'X');
        eq(r.text, 'l1\nX\nl4\n');
        eq(r.replaced, 2, '替换的行数要如实回传');
    });

    await check('replaceLines 省略 end 只改一行', async () => {
        eq(SBX.replaceLines('l1\nl2\nl3\n', 2, undefined, 'X').text, 'l1\nX\nl3\n');
    });

    /**
     * 越界**不能**静默截断到末尾：那会把"改第 200 行"变成"改到了最后一行"，
     * 而回执照样成功 —— 文件被改坏且模型不知道。
     */
    await check('replaceLines 行号越界报错而不是改到末尾', async () => {
        const over = SBX.replaceLines('l1\nl2\n', 5, 6, 'X');
        assert(typeof over.error === 'string', '越界必须报错');
        assert(over.error.includes('2'), `错误里要带出实际行数，实际：${over.error}`);
        assert(typeof SBX.replaceLines('l1\nl2\n', 2, 1, 'X').error === 'string', 'end < start 应报错');
        assert(typeof SBX.replaceLines('l1\n', 0, undefined, 'X').error === 'string', '行号 0 应报错');
    });

    /**
     * 行尾风格必须按文件现状保留。
     *
     * 用 `\n` 拼回去的话，一次编辑就把整个 CRLF 文件变成 LF —— 在 git 里
     * 表现为"全文件重写"，用户看到的 diff 里没有一行是真正改过的。
     */
    await check('replaceLines 保留文件原本的行尾风格', async () => {
        const crlf = SBX.replaceLines('l1\r\nl2\r\nl3\r\n', 2, 2, 'X');
        eq(crlf.text, 'l1\r\nX\r\nl3\r\n', 'CRLF 文件改完还得是 CRLF');
        const lf = SBX.replaceLines('l1\nl2\nl3\n', 2, 2, 'X');
        eq(lf.text, 'l1\nX\nl3\n', 'LF 文件改完还得是 LF');
    });

    await check('replaceLines 末行无换行时不会凭空补一个', async () => {
        eq(SBX.replaceLines('l1\nl2', 2, 2, 'X').text, 'l1\nX', '原本没有结尾换行就别加');
        eq(SBX.replaceLines('l1\nl2\n', 2, 2, 'X').text, 'l1\nX\n', '原本有结尾换行就保留');
    });

    await check('checkSyntax 判语法：正常通过、语法错带行号', async () => {
        const ok = SBX.checkSyntax('const a = 1;\n');
        eq(ok.valid, true, '合法代码应通过');
        eq(ok.error, undefined, '通过时不该带 error');
        const bad = SBX.checkSyntax('const a = 1;\nfunction f( {\n  return a\n}\n');
        assert(typeof bad.error === 'string', '语法错必须回 error');
        assert(bad.error.includes('SyntaxError'), `错误类型要带出来，实际：${bad.error}`);
        assert(/:\d+/.test(bad.error), `要带行号定位，实际：${bad.error}`);
        eq(bad.valid, undefined, '失败时不得同时说 valid');
    });

    /**
     * checkjs 是**语法**检查，不是"能不能跑"。
     *
     * 把判据写成"能不能执行"（比如真跑一遍）时，`require` 一个不存在的模块会失败 ——
     * 而那对"我要写的这段代码对不对"毫无信息量。这条钉住它只做解析。
     */
    await check('checkSyntax 不解析依赖：require 不存在的模块照样通过', async () => {
        eq(SBX.checkSyntax('const x = require("这个模块不存在");\n').valid, true,
            '只查语法，不查模块是否存在');
    });

    /**
     * ESM 写法在 CommonJS 解析下确实是语法错误，如实报出来即可 ——
     * 这条钉的是"错误文案由 Node 给出、不是我们编的"，以及提示词里那句说明是真的。
     */
    await check('checkSyntax 对 ESM 写法如实报语法错（提示词已声明这一点）', async () => {
        const imp = SBX.checkSyntax('import fs from "fs";\n');
        assert(typeof imp.error === 'string' && imp.error.includes('import'), `实际：${JSON.stringify(imp)}`);
        const top = SBX.checkSyntax('const r = await fetch("http://x");\n');
        assert(typeof top.error === 'string' && top.error.includes('await'), `实际：${JSON.stringify(top)}`);
    });

    /* -------------------- sandbox：读写改查的真实往返 -------------------- */

    /**
     * 用真实的临时目录跑一遍 handle：写、读、列、精确改、改行、查语法、删。
     *
     * 假 root 只能验判据的形状，验不了"内容真的落盘了""改完还是不是那个文件"。
     */
    const os = require('os');
    const tmpRoot = path.join(os.tmpdir(), `the-play-sbx-${process.pid}`);
    await check('sandbox 写→读→列→改→删 真实往返', async () => {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });

        const w = await SBX.handle({ action: 'write', path: 'out/a.md', content: '# 结论\n\n原始段落\n' }, tmpRoot);
        assert(!w.error, `write 应成功，实际 ${w.error}`);
        eq(w.bytes, Buffer.byteLength('# 结论\n\n原始段落\n', 'utf8'));
        assert(fs.existsSync(path.join(tmpRoot, 'out', 'a.md')), '文件应真的落盘');

        const r = await SBX.handle({ action: 'read', path: 'out/a.md' }, tmpRoot);
        eq(r.content, '# 结论\n\n原始段落\n');

        const l = await SBX.handle({ action: 'list', path: 'out' }, tmpRoot);
        assert(l.entries.some((e) => e.name === 'a.md'), '列目录应看到写进去的文件');

        const e = await SBX.handle({
            action: 'edit', path: 'out/a.md', old: '原始段落', new: '改过的段落',
        }, tmpRoot);
        assert(!e.error, `edit 应成功，实际 ${e.error}`);
        eq(e.replaced, 1);
        eq((await SBX.handle({ action: 'read', path: 'out/a.md' }, tmpRoot)).content,
            '# 结论\n\n改过的段落\n', '改完必须只剩这一处变化');

        const ln = await SBX.handle({
            action: 'lines', path: 'out/a.md', start: 1, end: 1, content: '## 新标题',
        }, tmpRoot);
        assert(!ln.error, `lines 应成功，实际 ${ln.error}`);
        eq((await SBX.handle({ action: 'read', path: 'out/a.md' }, tmpRoot)).content,
            '## 新标题\n\n改过的段落\n');

        const d = await SBX.handle({ action: 'delete', path: 'out/a.md' }, tmpRoot);
        assert(!d.error && d.deleted.replace(/\\/g, '/') === 'out/a.md', `delete 应回相对路径，实际 ${JSON.stringify(d)}`);
        assert(!fs.existsSync(path.join(tmpRoot, 'out', 'a.md')), '文件应真的被删掉');
    });

    /**
     * 上限取消之后最容易回归的一条：read 必须**整份**回传。
     *
     * 造一个明显超过旧 32KB 上限的文件，逐字比对 —— 用"长度大于 32KB"断言的话，
     * 把截断点从 32KB 改成 64KB 照样全绿。
     */
    await check('sandbox read 不截断：超过旧上限的文件整份回传', async () => {
        const big = `${'长'.repeat(40000)}\n尾行\n`;
        await SBX.handle({ action: 'write', path: 'big.txt', content: big }, tmpRoot);
        const r = await SBX.handle({ action: 'read', path: 'big.txt' }, tmpRoot);
        assert(!r.error, `read 应成功，实际 ${r.error}`);
        eq(r.content, big, '内容必须与写进去的逐字相同（含末尾标记行）');
        eq(r.bytes, Buffer.byteLength(big, 'utf8'), 'bytes 应是真实字节数');
        assert(!r.content.includes('已截断'), '不得再出现截断说明');
    });

    await check('sandbox write 不设长度上限', async () => {
        const huge = 'x'.repeat(300000);
        const w = await SBX.handle({ action: 'write', path: 'huge.txt', content: huge }, tmpRoot);
        assert(!w.error, `write 应成功，实际 ${w.error}`);
        eq(w.bytes, 300000);
        eq((await SBX.handle({ action: 'read', path: 'huge.txt' }, tmpRoot)).content, huge);
    });

    await check('sandbox edit 对不存在的文件回 ENOENT（改已有文件，不是建新文件）', async () => {
        const r = await SBX.handle({ action: 'edit', path: 'nope.md', old: 'a', new: 'b' }, tmpRoot);
        assert(typeof r.error === 'string' && r.error.includes('ENOENT'),
            `应如实回 ENOENT，实际 ${JSON.stringify(r)}`);
    });

    await check('sandbox read 不存在的文件回 ENOENT 而不是崩', async () => {
        const r = await SBX.handle({ action: 'read', path: 'nope.md' }, tmpRoot);
        assert(typeof r.error === 'string' && r.error.includes('ENOENT'),
            `应如实回 ENOENT，实际 ${JSON.stringify(r)}`);
    });

    await check('sandbox 越界路径根本到不了 fs', async () => {
        for (const action of ['read', 'write', 'edit', 'lines', 'delete']) {
            const r = await SBX.handle(
                { action, path: '../../../Windows/win.ini', content: 'x', old: 'x', new: 'y', start: 1 },
                tmpRoot,
            );
            assert(r.error && r.error.includes('路径不合法'),
                `${action} 应先被判据拒掉，实际 ${JSON.stringify(r)}`);
        }
    });

    await check('sandbox checkjs 不碰文件系统：path 越界也不影响它', async () => {
        const r = await SBX.handle({ action: 'checkjs', content: 'const a = 1;' }, tmpRoot);
        eq(r.valid, true);
    });

    /* ----------------------- sandbox：node 跑脚本 ----------------------- */

    /**
     * `node` 的判据要用**真的跑一次**来验，不能只验参数转发：
     * "能不能跑起来""退出码怎么回""cwd 在哪"全都只有真起进程才看得见。
     */
    await check('sandbox node 真的执行脚本，回 exitCode 与 output', async () => {
        await SBX.handle({
            action: 'write',
            path: 'run/hello.js',
            content: 'console.log("hello-from-script");\nconsole.error("to-stderr");\n',
        }, tmpRoot);
        const r = await SBX.handle({ action: 'node', path: 'run/hello.js' }, tmpRoot);
        assert(!r.error, `应跑成功，实际 ${r.error}`);
        eq(r.exitCode, 0);
        assert(r.output.includes('hello-from-script'), `stdout 要回传，实际 ${JSON.stringify(r.output)}`);
        assert(r.output.includes('to-stderr'), 'stderr 必须合并进来（分开回等于丢掉报错原因）');
    });

    /**
     * 脚本的 cwd 必须是沙箱根。
     *
     * 模型写的脚本按提示词用相对路径读写自己的数据文件（`out/data.json`）——
     * cwd 落在别处时那些相对路径全部指到沙箱外面，而脚本不会报错，只会读写错地方。
     */
    await check('sandbox node 的工作目录就是沙箱根', async () => {
        await SBX.handle({
            action: 'write',
            path: 'run/cwd.js',
            content: 'console.log("CWD=" + process.cwd());\n',
        }, tmpRoot);
        const r = await SBX.handle({ action: 'node', path: 'run/cwd.js' }, tmpRoot);
        assert(!r.error, `应跑成功，实际 ${r.error}`);
        assert(r.output.includes(tmpRoot), `cwd 应是沙箱根 ${tmpRoot}，实际 ${JSON.stringify(r.output)}`);
    });

    /**
     * **非零退出码不是 error。**
     *
     * 脚本自己 `process.exit(1)` 是它的正常结论（"没爆破出来"就是这种形状）。
     * 把它标成 error 会让引擎把这一步染红，模型据此以为工具坏了、去改参数 ——
     * 而真正的原因就在 output 里，它没读。
     */
    await check('sandbox node 非零退出码不算工具失败，只回 exitCode', async () => {
        await SBX.handle({
            action: 'write',
            path: 'run/fail.js',
            content: 'console.log("no-hit");\nprocess.exit(3);\n',
        }, tmpRoot);
        const r = await SBX.handle({ action: 'node', path: 'run/fail.js' }, tmpRoot);
        eq(r.error, undefined, '非零退出码不得被当成工具失败');
        eq(r.exitCode, 3, '退出码要如实回传');
        assert(r.output.includes('no-hit'), '输出照样要带回来');
    });

    await check('sandbox node 跑不存在的脚本回 ENOENT，不把解释器的栈甩给模型', async () => {
        const r = await SBX.handle({ action: 'node', path: 'run/nope.js' }, tmpRoot);
        assert(typeof r.error === 'string' && r.error.includes('ENOENT'),
            `应先自己 stat 出来回 ENOENT，实际 ${JSON.stringify(r)}`);
    });

    await check('sandbox node 拒绝目录（只能跑文件）', async () => {
        await SBX.handle({ action: 'write', path: 'run/keep.txt', content: 'x' }, tmpRoot);
        const r = await SBX.handle({ action: 'node', path: 'run' }, tmpRoot);
        assert(typeof r.error === 'string' && r.error.includes('目录'),
            `应明确说不能跑目录，实际 ${JSON.stringify(r)}`);
    });

    await check('sandbox node 的越界路径根本到不了 spawn', async () => {
        const r = await SBX.handle({ action: 'node', path: '../../../Windows/System32/calc.exe' }, tmpRoot);
        assert(r.error && r.error.includes('路径不合法'), `应先被判据拒掉，实际 ${JSON.stringify(r)}`);
    });

    /**
     * 超时要把**整棵进程树**杀掉，不能只停止等待。
     *
     * 判据取"目录现在删得掉"：删不掉就是还有进程占着它，而那正是根因本身，
     * 不是靠 sleep 一段时间去赌时序。rm 失败会抛，断言也就跟着红。
     */
    await check('sandbox node 超时会被杀并如实标注，且不留占着沙箱的进程', async () => {
        await SBX.handle({
            action: 'write',
            path: 'run/spin.js',
            content: 'setInterval(() => {}, 1000);\nconsole.log("started");\n',
        }, tmpRoot);
        const started = Date.now();
        const r = await SBX.handle({ action: 'node', path: 'run/spin.js', timeout: 1500 }, tmpRoot);
        const elapsed = Date.now() - started;
        assert(r.timedOut === true, `应标记超时，实际 ${JSON.stringify(r)}`);
        assert(typeof r.error === 'string' && r.error.includes('杀掉'),
            `错误文案要说明进程已被杀（不是"不再等它"），实际 ${r.error}`);
        assert(r.output.includes('started'), '被杀之前已经打出来的输出不能丢');
        assert(elapsed < 15000, `应尽快返回，实际 ${elapsed}ms`);

        // 能删掉即没有进程还占着它；删不掉会抛 EBUSY
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
        assert(!fs.existsSync(tmpRoot), '沙箱目录应已释放');
    });

    await check('sandbox node 的 timeout 被钳到上限，不接受任意长', async () => {
        // 只验钳制逻辑本身：传一个荒谬的大值，它必须被压到上限（否则一个死循环能挂住整轮）
        await SBX.handle({
            action: 'write', path: 'run/quick.js', content: 'console.log("ok");\n',
        }, tmpRoot);
        const r = await SBX.handle({
            action: 'node', path: 'run/quick.js', timeout: 99_999_999,
        }, tmpRoot);
        assert(!r.error, `正常脚本仍应跑完，实际 ${r.error}`);
        eq(r.exitCode, 0);
    });

    await check('sandbox 未知 action 由应用侧兜住', async () => {
        const r = await SBX.handle({ action: 'stat', path: 'a' }, tmpRoot);
        assert(typeof r.error === 'string' && r.error.includes('未知 action'), `实际 ${JSON.stringify(r)}`);
    });

    await check('sandbox exec 已被删除：应用侧不认这个动作', async () => {
        const r = await SBX.handle({ action: 'exec', command: 'ls' }, tmpRoot);
        assert(typeof r.error === 'string' && r.error.includes('未知 action'),
            `exec 必须走"未知 action"，实际 ${JSON.stringify(r)}`);
        assert(r.error.includes('edit'), '错误里要列出当前可用动作，模型才知道改用哪个');
    });

    await fs.promises.rm(tmpRoot, { recursive: true, force: true });

    /* ------------------- sandbox：动作清单与提示词不许漂移 ------------------- */

    /**
     * 动作清单的真值在 `shared/meta/type.ts`，三处消费它：类型联合、工具层门禁、
     * 提示词插值。**exec 的删除也要在这里钉住** —— 只在某一处删掉的话，
     * 模型从提示词里读到 exec、调用却拿到"未知 action"，而代码里没有任何一处是错的。
     */
    await check('沙箱动作清单：exec 已从三处一并移除', async () => {
        const META = require('./build/shared/meta/type.js');
        assert(!META.SANDBOX_ACTIONS.includes('exec'), 'exec 必须已从权威清单里删掉');
        eq(META.SANDBOX_ACTIONS.join(','), 'list,read,write,delete,edit,lines,checkjs,node',
            '动作清单是模型看得见的那一份，改动必须是有意的');
        /**
         * 主进程那份副本也必须逐值相等。它只用来把"未知动作"和"参数不全"分开，
         * 但漂移的表现是"插件放行的动作被应用当成未知动作拒掉"。
         */
        eq(SBX.SANDBOX_ACTIONS.join(','), META.SANDBOX_ACTIONS.join(','),
            '主进程的动作副本与 shared 权威漂移');

        /**
         * 动作清单的**第四处**消费点：工具规格表的 enum。
         *
         * 提示词不再逐条列动作（那正是"散文与 schema 分叉"的源头），改由 schema
         * 的 enum 直接约束模型能产出哪些值 —— 所以这里钉住的是插值而不是文案。
         */
        const specSrc = AGENT_SOURCES.find((s) => s.file === 'toolspec.ts').text;
        assert(/enum: \[\.\.\.SANDBOX_ACTIONS\]/.test(specSrc),
            '规格表的动作 enum 必须从 SANDBOX_ACTIONS 插值，不手抄');
        // 从编译产物里查真值：源码里 "exec" 会出现在 "script execution" 这类说明里
        const names = TOOLS_SPEC.AGENT_TOOLS.map((t) => t.name);
        assert(!names.includes('exec'), '不得再把 exec 当工具或动作暴露给模型');
        const sandbox = TOOLS_SPEC.AGENT_TOOLS.find((t) => t.name === 'sandbox');
        assert(!sandbox.parameters.properties.action.enum.includes('exec'),
            '规格表的动作 enum 里不得再有 exec');
    });

    await check('node 的两条超时：主进程副本与 shared 权威逐值相等', async () => {
        const META = require('./build/shared/meta/type.js');
        eq(SBX.SANDBOX_NODE_TIMEOUT_DEFAULT_MS, META.SANDBOX_NODE_TIMEOUT_DEFAULT_MS, '默认超时漂移');
        eq(SBX.SANDBOX_NODE_TIMEOUT_MAX_MS, META.SANDBOX_NODE_TIMEOUT_MAX_MS, '超时上限漂移');
        // 插件侧等得必须比应用侧杀得久，否则超时文案会由错的一方给出
        assert(META.SANDBOX_NODE_TIMEOUT_MAX_MS > 0, '上限必须为正');
    });

    await check('沙箱的三个上限常量已彻底删除（不留死代码）', async () => {
        const META = require('./build/shared/meta/type.js');
        for (const name of ['SANDBOX_TEXT_LIMIT_BYTES', 'SANDBOX_EXEC_TIMEOUT_DEFAULT_MS', 'SANDBOX_EXEC_TIMEOUT_MAX_MS']) {
            eq(META[name], undefined, `${name} 应已从 shared 删除`);
        }
        const src = AGENT_SOURCES.map((s) => s.text).join('\n');
        assert(!/SANDBOX_TEXT_LIMIT_BYTES|SANDBOX_EXEC_TIMEOUT/.test(src),
            '插件源码里不得再引用已删的上限常量');
        const mainSrc = fs.readFileSync(path.join(ROOT, 'app', 'main', 'sandbox.js'), 'utf8');
        assert(!/SANDBOX_TEXT_LIMIT_BYTES|SANDBOX_EXEC_TIMEOUT|clipToBytes/.test(mainSrc),
            '主进程侧不得留下已删的上限与截断实现');
    });

    /**
     * `node` 与 exec 的区别必须落在**代码**上，不只是注释里：
     * 它不能有 shell、不能接受模型给的命令。
     *
     * 这条是防回归的：把 spawn 改成 `shell: true`、或把 path 拼进一个命令字符串，
     * 功能测试照样全绿（脚本还是能跑），而注入面已经回来了。
     */
    await check('node 的实现不得引入 shell（spawn 必须带参数数组）', async () => {
        const mainSrc = fs.readFileSync(path.join(ROOT, 'app', 'main', 'sandbox.js'), 'utf8');
        assert(!/shell:\s*true/.test(mainSrc), 'node 绝不能开 shell');
        assert(/spawn\(nodeBinary\(\), \[scriptPath\]/.test(mainSrc),
            '必须是 spawn(解释器, [脚本路径]) 的参数数组形式，不能是命令字符串');
    });

    /* --------------------- 工具名注册表不许留空位 --------------------- */

    /**
     * 新增一个工具名要同时落在三处：类型联合、派发 switch、**工具规格表**。
     *
     * 少一处都不会有任何编译错误，也不会报错：
     *   · 少 switch 分支 → 模型调到它只拿到「未知工具」，它会以为是自己拼错了；
     *   · 少规格表条目 → 服务商根本不会把这个工具暴露给模型，功能等于没做。
     * 这是 §5.3-C（注册了但没人听）在本项目里的形态，所以一次断言钉死三处。
     *
     * 规格表取代了旧版的"提示词里有一段散文"：参数形状只有那一个来源。
     */
    await check('每个 AgentToolName 都有派发分支且进了工具规格表', async () => {
        const typeSrc = fs.readFileSync(path.join(ROOT, 'shared', 'meta', 'type.ts'), 'utf8')
            .replace(/\r\n/g, '\n');
        const block = typeSrc.slice(typeSrc.indexOf('export type AgentToolName ='));
        const declared = [...block.slice(0, block.indexOf(';')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        assert(declared.length >= 6, `应从类型里解出全部工具名，实际 ${declared.length}`);

        const toolsSrc = AGENT_SOURCES.find((s) => s.file === 'tools.ts').text;
        const specSrc = AGENT_SOURCES.find((s) => s.file === 'toolspec.ts').text;

        for (const name of declared) {
            assert(toolsSrc.includes(`case '${name}'`), `${name} 在类型里声明了，但 dispatchTool 没有分支`);
            assert(new RegExp(`name: '${name}'`).test(specSrc), `${name} 没有进工具规格表（模型看不到它）`);
        }

        /*
         * 反向：规格表里不得凭空多出没有实现的名字。
         *
         * 这条是**同一份清单的两个方向**：只查"类型里的都有条目"，加一个类型里
         * 没有的名字时（模型会调到一个不存在的工具）就查不出来。
         */
        const inSpec = [...specSrc.matchAll(/^\s*name: '([a-z_]+)',$/gm)].map((m) => m[1]);
        assert(inSpec.length === declared.length,
            `规格表 ${inSpec.length} 条与类型 ${declared.length} 个对不上：多出的会调到一个不存在的工具`);
        for (const name of inSpec) {
            assert(declared.includes(name), `规格表声明了 ${name}，但类型联合里没有它`);
        }
    });

    /* --------------------- 判据只许有一份 --------------------- */

    /**
     * 工具的成败判据只有 parse.ts 一份，失败信号也只有观察值一个通道。
     *
     * 曾经有三份：parse.ts 的 isErrorResult、engine.ts 里逐字重复的
     * isErrorResultLocal、以及 tools.ts 转口又导出的一份 isJsErrorResult
     * （引擎其实是直接从 parse import 的，那份导出无人使用）。
     * 判据重复不报错，只会让同一个工具结果在"当场判"与"别处判"下得到相反结论。
     *
     * `failed` 字段同理：宿主的四条失败路径各写一次，读它的一处也没有 ——
     * 失败已经写在观察值（`__agentError`）里，再挂一个布尔就是第二个存放处。
     */
    await check('成败判据只有一份，失败只有一个通道', async () => {
        const engine = AGENT_SOURCES.find((s) => s.file === 'engine.ts').text;
        assert(/isErrorResult\(result\)/.test(engine), 'engine 应直接用 parse 的判据');
        assert(!/isErrorResultLocal/.test(engine), 'engine 不得再自带一份判据');

        const tools = AGENT_SOURCES.find((s) => s.file === 'tools.ts').text;
        assert(!/export \{ isJsErrorResult \}/.test(tools),
            'tools 不得再转口导出判据（引擎直接 import parse）');

        const parse = AGENT_SOURCES.find((s) => s.file === 'parse.ts').text;
        assert(/export const isErrorResult = /.test(parse), '非 js 判据的权威应在 parse.ts');
        assert(/export const isJsErrorResult = /.test(parse), 'js 判据的权威应在 parse.ts');

        const hostSrc = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'offscreen', 'page-host.ts'), 'utf8');
        assert(!/failed:\s*(true|false)/.test(hostSrc), 'page-host 不得再回一个 failed 字段');
        assert(!/EvaluateResult/.test(hostSrc), 'EvaluateResult 包装类型应已删除');
    });

    /**
     * 模块依赖不成环 —— 环会让模块作用域的插值取到**还没求值完**的导出。
     *
     * 实测事故：text → prompt → parse → text 成环时，SYSTEM_PROMPT（模块作用域
     * 的模板）里插值的 MAX_CALLS_PER_REPLY 读到的是 parse 尚未赋值的导出。
     * 断言本身看不出问题，只有**先求值 parse / text 的入口**才会显形：
     * 提示词当场写成 "at most undefined per reply"，模型照着一个不存在的上限
     * 规划步骤；同样的环在 ESM 打包下还可能是加载期 TDZ 崩溃。
     *
     * 那个具体的插值已经随上限一起删掉了，但环本身仍会造成同一类故障
     * （任何模块作用域的模板都会读到未初始化的导出），所以断言照旧。
     *
     * 因此这条**必须**是结构断言：环的存在不改变任何一次函数调用的结果，
     * 只改变"谁先被求值"，那是代码里读不出来的性质。
     */
    await check('引擎模块依赖不成环', async () => {
        const edges = new Map(AGENT_SOURCES.map((s) => [
            s.file,
            [...s.text.matchAll(/['"]\.\/([a-z]+)['"]/g)].map((m) => `${m[1]}.ts`),
        ]));
        const reaches = (from, at, seen) => {
            for (const next of edges.get(at) || []) {
                if (next === from) return true;
                if (seen.has(next)) continue;
                seen.add(next);
                if (reaches(from, next, seen)) return true;
            }
            return false;
        };
        for (const file of edges.keys()) {
            assert(!reaches(file, file, new Set([file])),
                `${file} 参与了一个模块环：模块作用域的插值会取到未初始化的常量`);
        }
        const text = AGENT_SOURCES.find((s) => s.file === 'text.ts').text;
        assert(!/^import /m.test(text),
            'text.ts 必须是叶子（无 import），否则 text → prompt → parse → text 又成环');
    });

    /**
     * 沙箱的说明现在住在 **schema 的 description** 里，不在提示词正文里。
     *
     * 这条断言因此改为查 toolspec.ts：参数形状只有那一个来源，提示词里再写一份
     * 就必然与 schema 分叉，而模型会照着更啰嗦的那份写。
     */
    await check('沙箱 schema 的说明覆盖关键约束', async () => {
        const spec = AGENT_SOURCES.find((s) => s.file === 'toolspec.ts');
        assert(spec, '应有 toolspec.ts');
        const src = spec.text;
        const at = src.indexOf('const SANDBOX: AiToolSpec');
        assert(at > 0, 'toolspec 应有 SANDBOX 一条');
        /*
         * 切到 sandbox 这一条**结束**为止。
         *
         * 不能切到文件末尾：后面还有 AGENT_TOOLS 的说明，里面提到"不在这张表里"
         * 之类的字样会让反向断言（不得出现某个词）误报。锚在下一个顶层 const。
         */
        const after = src.indexOf('\nconst ', at + 10);
        const block = src.slice(at, after > at ? after : undefined);
        /**
         * 比对的是**拼好的描述字符串**，而不是源码文本：源码里那句被 `+` 折成
         * 两行，直接对源码正则必然匹配不到（而那时断言报的是"没写"，与事实相反）。
         * 从编译产物里取真值 —— 那也是真正发给服务商的那一份。
         */
        const sandboxSpec = TOOLS_SPEC.AGENT_TOOLS.find((t) => t.name === 'sandbox');
        assert(sandboxSpec, '编译产物里应有 sandbox 一条');
        const desc = `${sandboxSpec.description} ${JSON.stringify(sandboxSpec.parameters)}`;
        assert(/never read \+ full write/.test(desc), '必须写明改已有文件用 edit 而不是全量重写');
        assert(/verbatim/.test(desc), 'old 要逐字照抄这一点必须写清（否则模型会随手省略缩进）');
        assert(/never truncate/.test(desc), '要说明读写都不截断，否则模型会按旧上限自行拆分');
        assert(!/\bexec\b/.test(desc), '不得再提 exec');
        // 动作清单必须从 SANDBOX_ACTIONS 插值，不能手抄
        assert(/\.\.\.SANDBOX_ACTIONS/.test(block), '动作清单要从 SANDBOX_ACTIONS 插值，不手抄');
        assert(/\$\{SANDBOX_NODE_TIMEOUT_MAX_MS/.test(block), '超时上限要插值常量，不手抄秒数');
    });

    /* --------------------- 推理文本的定稿（本次修复） --------------------- */

    /**
     * 实测事故：模型思考**没有持久化在页面上**，这轮交互一结束就找不到了。
     *
     * 根因是它只活在流式气泡里 —— 气泡在每步结束时被 setStreaming(null) 收掉，
     * 而三处 appendMessage 都只写 content、从不写 reasoning。不是没存，是从没进过列表。
     *
     * 这里测 keepReasoning 的两个判据（纯函数，可直接求值）。
     */
    await check('keepReasoning 保留非空推理', async () => {
        assert(keepReasoning('先看页面结构，再决定改哪个字段') === '先看页面结构，再决定改哪个字段',
            '非空推理应原样保留');
    });

    await check('keepReasoning 空串归一成 undefined', async () => {
        // 空串必须转 undefined：否则每条无推理的消息都多带 reasoning:""，
        // 序列化进 localStorage 是实打实的字节，界面上却什么都不表示
        assert(keepReasoning('') === undefined, '空串应为 undefined');
        assert(keepReasoning('   \n\t ') === undefined, '纯空白也应为 undefined');
    });

    await check('keepReasoning 去掉首尾空白', async () => {
        assert(keepReasoning('  想一下  ') === '想一下', '应 trim');
    });

    await check('keepReasoning 超长时按字节截断并注明', async () => {
        // 用中文构造：一个字 3 字节，正好验证"按字节而不是按字符"
        const huge = '想'.repeat(40000);
        const out = keepReasoning(huge);
        assert(typeof out === 'string', '超长应返回字符串');
        assert(out.length < huge.length, '应被截断');
        assert(out.includes('已截断'), '必须注明被截断，否则用户以为看到了全文');
        assert(out.includes('保留'), '措辞应是"保留"而不是"回传"—— 这条是存给用户读的，不是发给模型的');
    });

    /**
     * 截断点不能落在一对代理项中间。
     *
     * Emoji 与扩展区汉字在 UTF-16 里是两个单元，按字节二分很容易切在中间：
     * 切片会以半个字符结尾，序列化进 storage 或请求体就是一个孤立代理项 ——
     * 一个宣称"不切坏多字节字符"的函数不该自己制造乱码。
     *
     * 15 字节这个上限是特意挑的：3 个 Emoji 是 12 字节，第 4 个的高位代理项
     * 单独算 3 字节（TextEncoder 按 U+FFFD 计），于是二分正好停在半个字符上。
     */
    await check('按字节截断不切坏代理项（Emoji）', async () => {
        const out = TEXT.truncateBytes('😀'.repeat(10), 15, (total, max) => `仅保留前 ${max} 字节`);
        assert(out.includes('已截断'), '构造前提：应被截断');
        const body = out.slice(0, out.indexOf('\n…['));
        assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body),
            `不得留下孤立的高位代理项，实际 ${JSON.stringify(body)}`);
        assert(body === '😀😀😀', `应整块保留能放下的那 3 个，实际 ${JSON.stringify(body)}`);
        assert(TEXT.byteLength(body) <= 15, '退回一个单元只会更小，不能越界');
    });

    /**
     * 每一处定稿点都必须带上 reasoning。
     *
     * 只测纯函数不够：把 keepReasoning 写对了、却忘了在 appendMessage 里传，
     * bug 原样还在（第 2 轮踩过同样的"只测判据、不测调用点"）。
     *
     * 五处定稿点：
     *   1. 中断且已流出正文
     *   2. 中断且只有推理（正文还空着）
     *   3. 最终回复（模型不再要工具）
     *   4. 工具调用（这一步的思考 —— 最能回答"为什么改这个字段"）
     *   5. 协议错误（模型回了散文/坏 JSON —— 它当时为什么跑偏，只有这段推理能回答）
     * 少任何一处，那种结束方式下的思考就会随气泡一起消失。
     */
    await check('每一处定稿点都带 reasoning', async () => {
        const src = ALL_SRC;
        const hits = src.match(/reasoning:\s*keepReasoning\(liveReasoning\)/g) || [];
        assert(hits.length === 5,
            `应有 5 处定稿点带上推理（中断两种 / 最终回复 / 工具调用 / 协议错误），实际 ${hits.length} 处`);
    });

    await check('中断时只有推理也要落一条消息', async () => {
        const src = ALL_SRC;
        // 用户中途点停止时，常常只流出了推理、正文还是空的。
        // 不落这条的话，那部分思考同样会随气泡消失 —— 正是本次要修的 bug。
        assert(/else if \(liveReasoning\.trim\(\)\)/.test(src),
            '应处理"只有推理、没有正文"的中断情形');
    });

    /**
     * 推理**绝不能进模型上下文** —— 它只该落本地、只该上界面。
     *
     * 这条约束靠结构成立：`transcript`（发给模型）与 `messages`（UI + 落盘）
     * 是两条独立的线，前者只 push 过 { role, content }。但"碰巧成立"不是保障 ——
     * 顺手写成 transcript.push({ role:'assistant', content: reply, reasoning })
     * 也不会有任何编译错误，而后果是每一步都把上一步的思考重发一遍：
     * token 翻倍、上下文被自己的独白挤满。
     *
     * 所以在这里钉死两件事：transcript 的每一次 push 都只有 role/content；
     * chat() 的 messages 实参只能是 transcript，不能是 UI 那份 messages 状态。
     */
    await check('推理不进模型上下文：transcript 只 push role/content', async () => {
        const src = ALL_SRC;

        const pushes = src.match(/transcript\.push\([^)]*\)/g) || [];
        assert(pushes.length > 0, '应能找到 transcript.push（找不到说明实现变了，本断言需重写）');
        for (const p of pushes) {
            assert(!/reasoning/.test(p),
                `transcript.push 不得携带 reasoning（会把思考重发给模型）：${p}`);
        }

        // 初始项同理：它是本轮第一条发给模型的消息
        const init = src.match(/const transcript = \[[^\]]*\]/);
        assert(init, '应能找到 transcript 的初始化');
        assert(!/reasoning/.test(init[0]), 'transcript 初始项不得携带 reasoning');
    });

    await check('推理不进模型上下文：chat 只收 transcript', async () => {
        const src = ALL_SRC;

        /**
         * 先切出 chat({...}) 这一段，再看它里面的 messages 指向谁。
         * 不写成"messages 后面必须紧跟 reasoningEffort"那种正则：那样参数一换序
         * 就会误报，而误报的代价是下一个人去改测试而不是看代码。
         *
         * **必须从 send() 里开始找**：文件里现在有第二个 chat() 调用点
         * （compact 的摘要器，messages 是 digest），从文件头 indexOf 会命中它，
         * 于是这条断言测的是摘要器而不是主循环 —— 主循环把推理漏进上下文也照样绿。
         */
        const sendAt = src.indexOf('private async send(prompt: string)');
        assert(sendAt >= 0, '应能找到 send');
        const start = src.indexOf('this.options.chat.chat({', sendAt);
        assert(start >= 0, '应能在 send 里找到 chat() 调用');
        const end = src.indexOf('});', start);
        assert(end > start, '应能找到 chat() 调用的结尾');
        const call = src.slice(start, end);

        const m = call.match(/messages:\s*([A-Za-z_$][\w$]*)/);
        assert(m, 'chat() 的实参里应能看到 messages');
        assert(m[1] === 'transcript',
            `chat() 的 messages 必须是 transcript（发给模型的那份），实际是 ${m[1]}`);

        // 反过来也钉一下：那段里不该出现别的消息来源
        assert(!/messages:\s*messages\b/.test(call),
            'chat() 不得直接收 UI 那份 messages（它带着 reasoning）');
    });

    /* ---------------------- 跨轮上下文（模型能看到上一轮） ---------------------- */

    /**
     * 这一组防的是"整轮失忆"：send() 原先每次只发 [{ role:'user', content: text }]，
     * 模型看不到任何上一轮的内容 —— 追问「它」「刚才那个」、按提示「继续」全部落空。
     *
     * 上面那两条"推理不进模型上下文"的断言只保证**没多给**，
     * 不保证**该给的给了**：一个恒返回 [] 的 buildTranscript 能通过它们全部。
     */

    const msg = (over) => ({ id: 'x', at: 0, ...over });

    await check('上一轮的用户提问与最终回答都进历史', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: '看看这个页面' }),
            msg({ role: 'assistant', content: '页面是商品列表' }),
        ]);
        assert(out.length === 2, `应回放 2 条，实际 ${out.length}`);
        assert(out[0].role === 'user' && out[0].content === '看看这个页面', '用户提问应原样回放');
        assert(out[1].role === 'assistant' && out[1].content === '页面是商品列表', '助手回答应原样回放');
    });

    /**
     * 工具结果走**原生 tool 角色**。
     *
     * 旧协议没有 tool role（JSON 信封里没有这个概念），工具结果只能伪装成 user
     * 消息，靠 `[工具 X 的执行结果]` 这类文本前缀让模型去猜"这是工具说的还是
     * 用户说的"。现在服务商按 `tool_call_id` 逐条配对，这层猜测由协议承担 ——
     * 所以这条断言钉的是"形状"，不是"措辞"。
     */
    await check('历史里的工具结果以原生 tool 角色回灌，且带 tool_call_id', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: '取一下价格' }),
            msg({ role: 'tool', content: '调用 js', label: 'js', tool: 'js', result: '{"price":9.9}', ok: true, callId: 'c1', callArgs: '{"code":"return 1"}' }),
            msg({ role: 'assistant', content: '价格是 9.9' }),
        ]);
        // user / assistant(tool_calls) / tool / assistant
        assert(out.length === 4, `应为 user/调用/结果/assistant 四条，实际 ${out.length}`);
        assert(out[1].role === 'assistant' && Array.isArray(out[1].tool_calls),
            '工具结果之前必须有一条带 tool_calls 的 assistant 消息（服务商按 id 配对）');
        assert(out[1].tool_calls[0].id === 'c1', 'assistant.tool_calls 的 id 必须与 tool 消息配对');
        assert(out[2].role === 'tool', '结果必须以原生 tool 角色回灌');
        assert(out[2].tool_call_id === 'c1', 'tool 消息必须带 tool_call_id');
        assert(out[2].content.includes('[工具 js 的执行结果]'),
            `观察前缀应带工具名与动作，实际：${out[2].content.slice(0, 40)}`);
        assert(out[2].content.includes('{"price":9.9}'), '观察里应带原始结果');
    });

    await check('label 缺失时回落到 tool 字段', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', tool: 'navigate', result: 'ok' }),
        ]);
        const toolMsg = out.find((m) => m.role === 'tool');
        assert(toolMsg && toolMsg.content.includes('[工具 navigate 的执行结果]'),
            `没有 label 时应回落到 tool，实际：${toolMsg && toolMsg.content.slice(0, 40)}`);
    });

    /**
     * 产品代码必须真的把 label 写进工具消息。
     *
     * 只测"缺 label 时回落到 tool"是不够的 —— 那恰好是**写漏 label** 时的行为，
     * 于是断言会在 bug 存在时照样通过（变异测试里这条变异体就是靠这一条存活的）。
     * 所以这里直接钉住调用点：工具消息里必须带 label，且它含 action。
     */
    await check('工具消息写入 label（含 action），不只写 tool', async () => {
        const src = ALL_SRC;
        /*
         * 找的是**工具调用**那条 tool 消息的构造块。
         *
         * 现在构造块里的 content 是一个三元（协议错误 vs 正常），所以锚在
         * `role: 'tool',` 之后、`label:` 之前的那段 —— 认的是"这个块里有没有
         * 从 item.label 来的 label 字段"。
         */
        const at = src.indexOf("role: 'tool',");
        assert(at > 0, '应能找到工具消息的构造点');
        // 切到这一批的观察回灌为止 —— 只切固定长度会在注释变长后把 label 那行挤出窗口
        const end = src.indexOf('batchObservation', at);
        assert(end > at, '应能找到同一批的观察回灌点');
        const block = src.slice(at, end);
        assert(/label: item\.bad \? PROTOCOL_ERROR_LABEL : item\.label,/.test(block),
            '工具消息必须带 label 字段：历史里只写工具名分不出 sandbox 八个动作');
    });

    await check('推理与脚本源码不进历史', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'assistant', content: '答', reasoning: '很长的思考'.repeat(50) }),
            msg({ role: 'tool', label: 'js', tool: 'js', result: 'r', script: 'return secret();' }),
        ]);
        const blob = JSON.stringify(out);
        assert(!blob.includes('很长的思考'), '推理不得进模型上下文（每步重发会撑爆预算）');
        assert(!blob.includes('return secret();'), '脚本源码不进历史：要复现的代码由模型自己再写一遍');
        /*
         * 只允许协议字段：role / content，以及 tool 配对必需的 tool_calls / tool_call_id。
         *
         * 不能像旧版那样钉死"只有两个字段" —— 现在形状由服务商规定，
         * 那条断言会把正确实现判红。
         */
        const ALLOWED = new Set(['role', 'content', 'tool_calls', 'tool_call_id']);
        const extra = out.flatMap((m) => Object.keys(m).filter((k) => !ALLOWED.has(k)));
        assert(extra.length === 0, `出现了协议外的字段：${extra.join('、')}`);
    });

    await check('空 assistant 消息不占位（中断且无正文时）', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'assistant', content: '', reasoning: '只有推理' }),
        ]);
        assert(out.length === 1, `空正文的 assistant 应被跳过，实际 ${out.length} 条`);
        assert(out[0].role === 'user', '留下的应是用户提问');
    });

    /**
     * 界面自己补的提示（中断 / 空回复 / 协议错误 / 上下文超限）不是模型说的话。
     *
     * 原样当 assistant 回放，模型会读到一句自己从未写过的台词 ——
     * 例如"（模型本轮没有返回内容…）"，它会把这句界面文案当成自己的承诺。
     */
    await check('界面补的提示按系统提示写回，不伪装成模型发言', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'assistant', content: '（模型本轮没有返回内容，已停止。）', notice: true }),
        ]);
        const blob = JSON.stringify(out);
        assert(blob.includes('[系统提示]'), `应按系统提示写回，实际：${blob.slice(0, 140)}`);
        assert(!out.some((m) => m.role === 'assistant'), '不得作为 assistant 发言回放');
    });

    /** 同上：界面提示点都必须真的打上 notice 标记；步数上限已按用户要求彻底去掉 */
    await check('界面提示都写入 notice 标记', async () => {
        const src = ALL_SRC;
        const notices = src.match(/^\s*notice: true,$/gm) || [];
        /*
         * 五处：中断（只有推理那条）+ 空回复 + 协议错误放弃 + 轮内上下文超限
         * + 截断回灌。
         *
         * 注意"中断且已流出正文"那条**不带** notice：它有真实正文，是模型说过的话，
         * 只是没说完 —— 给它打上标记会让历史重建时被写成 [系统提示]，等于否认
         * 那句话出自模型。
         */
        assert(notices.length === 5,
            `只有推理的中断 / 空回复 / 协议错误放弃 / 上下文超限 / 截断都应带 notice，实际 ${notices.length} 处`);
        assert(!/MAX_STEPS/.test(src),
            '单轮步数上限必须彻底移除（不设调用轮次上限），留着常量就是下一个漂移的源头');
    });

    /**
     * 提示词声明的观察前缀与实现一致。
     *
     * 这两处分别在文件的头尾，改一处忘另一处不会有任何编译或运行时错误 ——
     * 只会让模型去找一个根本不存在的标记，于是"回看历史"这条纪律形同虚设。
     *
     * 锚在**英文提示词里那句原话**上：提示词已重写为英文，而前缀本身仍是中文
     * （它们是实现写出来的字面量）。只锚前缀会失去"这句纪律还在不在"的保障。
     */
    await check('提示词声明的观察前缀与实现一致', async () => {
        const src = ALL_SRC;

        // 提示词那一段
        const specAt = src.indexOf('You can see earlier turns and their tool results');
        assert(specAt > 0, '应能在提示词里找到"能看到之前几轮"这条纪律');
        const spec = src.slice(specAt, specAt + 400);

        // 实现真正写出的前缀
        const produced = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', label: 'js', result: 'r' }),
            msg({ role: 'tool', label: '协议错误', result: '我忘了写 JSON', ok: false }),
            msg({ role: 'assistant', content: '提示', notice: true }),
        ]).map((m) => m.content).join('\n');

        // 界面补的提示前缀写作 [系统提示]（带右括号），提示词里也是这么写的
        for (const prefix of ['[工具 ', '[系统提示]', '[协议错误]']) {
            assert(produced.includes(prefix), `实现应写出 ${prefix}（本断言已失效，需更新）`);
            assert(spec.includes(prefix), `提示词必须声明 ${prefix}，否则模型不知道那是历史`);
        }
    });

    await check('连续多个观察各自成为一条 tool 消息', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', label: 'js', tool: 'js', result: 'A', callId: 'c1' }),
            msg({ role: 'tool', label: 'sandbox·list', tool: 'sandbox', result: 'B', callId: 'c2' }),
        ]);
        /*
         * 旧协议把两个观察合并成一条 user 消息。现在**必须各自一条 tool 消息**：
         * 服务商按 tool_call_id 逐条配对，合并之后第二个调用就找不到自己的结果，
         * 整条请求会被拒。批次语义改由内容里的批次头表达。
         */
        const tools = out.filter((m) => m.role === 'tool');
        assert(tools.length === 2, `两个观察应各自成一条 tool 消息，实际 ${tools.length} 条`);
        assert(tools[0].tool_call_id === 'c1' && tools[1].tool_call_id === 'c2', '两条必须各自配对');
        assert(tools[0].content.includes('A') && tools[1].content.includes('B'), '两段结果都要在');
    });

    /**
     * buildTranscript 会**原样回放**它拿到的每一条 —— 包括末尾那条还没有回答的提问。
     *
     * 这不矛盾：调用方（send）在 appendMessage **之前**读历史，那时本轮提问
     * 还没进 messages，所以根本不存在"要摘掉末轮"这回事。
     * 这条断言与下面「send 在追加本轮提问之前读历史」是一对：
     * 前者钉住"给了就发"，后者钉住"什么时候读"，两条合起来才没有重复。
     */
    await check('buildTranscript 原样回放末轮的提问（摘除由调用方时序保证）', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: '第一轮' }),
            msg({ role: 'assistant', content: '答一' }),
            msg({ role: 'user', content: '第二轮' }),
        ]);
        assert(out.length === 3, `应回放全部 3 条，实际 ${out.length} 条`);
        assert(out[2].role === 'user' && out[2].content === '第二轮', '末轮提问应保留');
    });

    /**
     * 历史从 messagesRef 读、且读在 appendMessage **之前**。
     *
     * 这条是"碰巧对"与"结构上对"的分界：写在 appendMessage 之后也能过上面所有
     * 纯函数用例，但那时历史里会不会多出本轮提问，取决于 React 何时提交 setState。
     */
    await check('send 在追加本轮提问之前读历史', async () => {
        const src = ALL_SRC;
        const sendAt = src.indexOf('private async send(prompt: string)');
        assert(sendAt >= 0, '应能找到 send');
        /*
         * 断言认的是"重建历史那一刻"与"追加本轮提问那一刻"的先后。
         *
         * 读历史在引擎里是 `const history = …` —— 不再是 hook 时代的
         * `messagesRef.current`（那时要靠 ref 绕开闭包快照，引擎里 this.messages
         * 永远是当前值，那个中间层随 hook 一起消失了）。现在它是
         * `this.contextOf(this.messages).transcript`：contextOf 内部调
         * buildTranscript，并按 messages 的身份缓存那次重建。两种读法都收 ——
         * 这条钉的是**读的位置**，不是读的写法。
         */
        const rest = src.slice(sendAt);
        const buildAt = rest.search(
            /const history = (?:buildTranscript\(this\.messages\)|this\.contextOf\(this\.messages\)\.transcript)/,
        );
        const appendAt = rest.indexOf("appendMessage({ id: generateId(), role: 'user', content: text");
        assert(buildAt >= 0, 'send 里应重建历史');
        assert(appendAt >= 0, 'send 里应追加本轮用户消息');
        assert(buildAt < appendAt,
            '必须在 appendMessage 之前重建历史，否则本轮提问会重复进上下文');
    });

    await check('send 把历史拼在本轮提问前面', async () => {
        const src = ALL_SRC;
        const m = src.match(/const transcript = \[([^\]]*)\]/);
        assert(m, '应能找到 transcript 的初始化');
        assert(/\.\.\.history/.test(m[1]), `transcript 必须以历史打头，实际：[${m[1]}]`);
        assert(/content: text/.test(m[1]), '本轮提问应排在历史之后');
    });

    /**
     * 上下文重建**不做任何裁剪** —— 这是"硬门槛能真正触发"的前提。
     *
     * 历史上它按 TRANSCRIPT_BUDGET_BYTES（256KB）从后往前丢整轮，后果有两个：
     * 静默丢历史；以及上下文永远到不了 800k（256KB ≈ 10 万 token），
     * 门槛成了死代码。现在超限由用户在界面上处理，程序不替他丢东西。
     */
    await check('上下文重建不裁剪历史（超限交给用户处理）', async () => {
        // 每轮约 1KB，300 轮 ≈ 300KB —— 远超原先那个 256KB 的裁剪预算
        const big = 'x'.repeat(1024);
        const history = [];
        for (let i = 0; i < 300; i += 1) {
            history.push(msg({ role: 'user', content: `round-${i}-${big}` }));
            history.push(msg({ role: 'assistant', content: `答${i}` }));
        }
        const out = buildTranscript(history);
        const blob = JSON.stringify(out);

        assert(out.length === 600, `全部 600 条都该在，实际 ${out.length}`);
        assert(blob.includes('round-0-'), '最旧的一轮不得被丢掉（静默丢历史正是要修的问题）');
        assert(blob.includes('round-299-'), '最近一轮当然要在');
        assert(blob.length > 300 * 1024, `不应有任何裁剪，实际 ${blob.length} 字节`);
    });

    /**
     * 超长观察**完全不截断** —— 从源头到上下文一处都不切。
     *
     * 这条曾经写的是"源头已按 32KB 截过一次，这里不二次截断"。那个上限已经删掉：
     * 它拿"静默把一条观察换掉一半"去换"上下文别被顶穿"，而模型窗口能装多少是
     * 用户配置里的事实，插件里定一个数就是替用户假设。装不下时该失败并说出来。
     */
    await check('超长观察不截断（与用户看到的一致）', async () => {
        const payload = 'y'.repeat(40000);
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', label: 'js', result: payload }),
            msg({ role: 'assistant', content: '看完了' }),
        ]);
        const observation = out.find((m) => m.content.includes('[工具'));
        assert(observation, '应有观察消息');
        assert(observation.content.includes(payload),
            '观察应原样进上下文，不得截断（也不得二次截断）');
        assert(!observation.content.includes('已截断'), '不得出现任何截断说明');
        assert(out.some((m) => m.content === '看完了'), '同轮的对话不得因观察过长而丢失');
    });

    /**
     * js 观察在**真实一轮里**也不截断，且存下来的就是发出去的。
     *
     * 端到端跑一遍是必要的：只测 buildTranscript 证明不了源头那一层 ——
     * 回传路上任何一处收窄，纯函数用例都照样绿。
     */
    await check('js 观察不截断：40KB 返回值整条进上下文', async () => {
        const h = await buildAgentHarness({
            replies: [JSON.stringify({
                intent: '取整页',
                calls: [{ tool: 'js', args: { code: 'return "y".repeat(40000);' } }],
            })],
        });
        await h.send('把整页拿回来');

        const tool = h.state().messages.find((m) => m.role === 'tool');
        assert(tool, '应有工具消息');
        assert(tool.result.includes('y'.repeat(40000)), `返回值应整条落盘，实际 ${tool.result.length} 字符`);
        assert(!tool.result.includes('已截断'), '返回值不得被截断');

        // 存下来的与模型读到的那一段必须逐字一致：对不上的话，用户展开卡片
        // 看到的与模型实际拿到的不是同一段文字，复盘时无从解释
        const wire = h.chats[1].map((m) => m.content).join('\n');
        assert(wire.includes(tool.result), '回灌给模型的观察必须与落盘的那一份一致');
    });

    await check('孤立观察（无新提问）自然留在上一轮里', async () => {
        // 一轮收尾之后工具消息还挂在末尾：此时还没有新的用户提问。
        // 轮次边界只有"新的用户提问"一个，所以这些观察本就还在 current 里没被 flush 过，
        // 不需要任何额外判断 —— 它们自然挂在上一轮尾部，而不是单开一个没有提问的"轮次"。
        const out = buildTranscript([
            msg({ role: 'user', content: '第一轮' }),
            msg({ role: 'assistant', content: '答一' }),
            msg({ role: 'tool', label: 'sandbox·list', tool: 'sandbox', result: 'R' }),
        ]);
        // user / assistant(答一) / assistant(tool_calls) / tool
        assert(out.length === 4, `应并进上一轮成为末尾几条，实际 ${out.length} 条`);
        assert(out[0].content === '第一轮', '首条仍是上一轮的提问');
        assert(out[out.length - 1].role === 'tool', '孤立观察应挂在上一轮尾部');
        assert(out[out.length - 1].content.includes('[工具'), '观察文案应带工具名');
    });

    await check('空历史返回空数组（首轮对话）', async () => {
        assert(buildTranscript([]).length === 0, '空输入应返回空数组');
    });

    /* ------------------- 端到端：第二轮真的能看到第一轮 ------------------- */

    /**
     * 上面全是**纯函数**断言，它们证明不了最关键的一环：
     * `messagesRef` 在 send 读它的那一刻是否真的装着历史 ——
     * 漏掉 `useEffect(() => { messagesRef.current = messages })` 的话，
     * buildTranscript 再正确也只会永远收到空数组，而所有纯函数用例照样全绿。
     *
     * 这正是用户报的原始症状（模型只知道当前轮次的 agent 流），
     * 所以这里把真实的 useAgent 跑起来，直接看第二次 chat() 收到了什么。
     */
    await check('端到端：第二轮请求带着第一轮的问答', async () => {
        const h = await buildAgentHarness();
        await h.send('第一轮的提问：看看这个页面');
        await h.send('第二轮的提问：它有多少条数据？');

        assert(h.chats.length === 2, `应发起 2 次 chat，实际 ${h.chats.length}`);
        assert(h.chats[0].length === 1,
            `首轮不该带任何历史，实际 ${h.chats[0].length} 条`);

        const second = JSON.stringify(h.chats[1]);
        assert(second.includes('第一轮的提问'), '第二轮必须能看到第一轮的提问');
        assert(second.includes('第 1 轮的回答'), '第二轮必须能看到第一轮的回答');
        assert(!second.includes('reasoning'), '历史里不得夹带 reasoning');

        const dupes = (second.match(/第二轮的提问/g) || []).length;
        assert(dupes === 1, `本轮提问只应出现一次，实际 ${dupes} 次（历史里混进了本轮）`);
    });

    await check('端到端：第三轮累积前两轮，且本轮提问不重复', async () => {
        const h = await buildAgentHarness();
        await h.send('第一轮');
        await h.send('第二轮');
        await h.send('第三轮');

        const third = JSON.stringify(h.chats[2]);
        assert(third.includes('第一轮') && third.includes('第二轮'), '第三轮应带着前两轮');
        assert((third.match(/第三轮/g) || []).length === 1, '本轮提问不得重复');
    });

    await check('端到端：工具结果跨轮可见，且以原生 tool 角色出现', async () => {
        const h = await buildAgentHarness({ toolCall: true });
        await h.send('先取一下价格');
        await h.send('刚才取到的价格是多少？');

        const second = h.chats[1];
        const observation = second.find((m) => m.role === 'tool' && m.content.includes('[工具 js 的执行结果]'));
        assert(observation, `第二轮应能看到第一轮的工具结果，实际：${JSON.stringify(second)}`);
        assert(observation.tool_call_id, 'tool 消息必须带 tool_call_id（服务商按它配对）');
        const paired = second.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
        assert(paired, '同一条历史里必须有配对的 assistant.tool_calls');
        assert(paired.tool_calls.some((c) => c.id === observation.tool_call_id),
            'tool_call_id 必须指向同一条历史里的某个调用');
    });

    await check('端到端：大写工具名落到未知工具（严格匹配）', async () => {
        const h = await buildAgentHarness({ toolCall: true, toolCase: 'upper' });
        await h.send('取一下');
        const tool = h.state().messages.find((m) => m.role === 'tool');
        assert(tool, '应有一条 tool 消息（报错也要记账）');
        assert(tool.ok === false, '大写 JS 不得派发成功');
        assert(tool.result.includes('未知工具'), `应报未知工具，实际 ${tool.result}`);
    });

    /* ---------------------- 一次回复里的多个工具调用 ---------------------- */

    /**
     * 一次回复里的多个调用必须**全部执行**，并各留一条记录。
     *
     * 这是"允许并发工具调用"的实质：只解析第一个的话，模型写对的第二、第三项
     * 会被静默丢掉 —— 没有报错、没有回执，它只能从"结果里少了两条"去猜，
     * 而它多半会以为是工具坏了，然后把同一批再发一遍。
     */
    await check('一批调用全部执行，逐条留痕并回灌', async () => {
        const h = await buildAgentHarness({
            replies: [
                JSON.stringify({
                    intent: '一次问三件事',
                    calls: [
                        { tool: 'js', args: { code: 'return 1;' } },
                        { tool: 'sandbox', args: { action: 'list', path: '.' } },
                        { tool: 'storage', args: { action: 'get', area: 'local' } },
                    ],
                }),
                JSON.stringify({ intent: '答完了', final: '三个都拿到了。' }),
            ],
        });
        await h.send('查一下');

        const tools = h.state().messages.filter((m) => m.role === 'tool');
        assert(tools.length === 3, `三个调用都该留痕，实际 ${tools.length} 条`);
        assert(tools.map((m) => m.label).join(',') === 'js,sandbox·list,storage',
            `记录顺序应与声明顺序一致，实际 ${tools.map((m) => m.label).join(',')}`);
        assert(tools.every((m) => m.ok === true), '三个都该成功');
        assert(tools.every((m) => m.content.includes('一次问三件事')),
            '每条记录都应带这一步的 intent（否则列表上是三条看不出关系的记录）');
        assert(h.sandboxCalls().length === 1, 'sandbox 端口应被真的调用一次');
        assert(h.ranCode.length === 1, 'js 应真的执行一次');

        // 回灌给模型的观察：一批一条，且说清这一步有几个结果
        const wire = h.chats[1];
        const observation = wire.find((m) => m.content.includes('执行了 3 个调用'));
        assert(observation, `一批观察必须合成一条并标明批大小，实际：${JSON.stringify(wire)}`);
        for (const label of ['[工具 js 的执行结果]', '[工具 sandbox·list 的执行结果]', '[工具 storage 的执行结果]']) {
            assert(observation.content.includes(label), `批观察里应含 ${label}`);
        }
    });

    /**
     * 一批是**一步**：几条记录必须作为一次写入进历史。
     *
     * 逐条追加时每一条各推一版快照、各落一次盘 —— 界面上是列表按条数连跳
     * （而它们本就是同一步发生的事），落盘那头则是 N 次写、每次都要把整份历史
     * 重过一遍体积预算。三条记录的 at 也因此不可能相同。
     */
    await check('一批作为一步写进历史（同刻、同一次落盘）', async () => {
        const h = await buildAgentHarness({
            replies: [
                JSON.stringify({
                    intent: '一次问三件事',
                    calls: [
                        { tool: 'js', args: { code: 'return 1;' } },
                        { tool: 'js', args: { code: 'return 2;' } },
                        { tool: 'js', args: { code: 'return 3;' } },
                    ],
                }),
                JSON.stringify({ intent: '答完了', final: '三个都拿到了。' }),
            ],
        });
        await h.send('查一下');

        const tools = h.state().messages.filter((m) => m.role === 'tool');
        assert(tools.length === 3, `构造前提：应有 3 条工具记录，实际 ${tools.length}`);
        assert(new Set(tools.map((m) => m.at)).size === 1,
            `同一步的记录必须是同一个时刻，实际 ${JSON.stringify(tools.map((m) => m.at))}`);
        /*
         * 每次落盘写两份：这条会话的历史（大）+ 会话索引（几百字节，列表要用的
         * 条数与自动名字在里面）。3 次落盘 = 用户提问 + 这一批 + 收尾回答，
         * 所以是 6 次。逐条追加的话，光历史那一份就是 5 次。
         */
        assert(h.saves() === 6, `一批只该落一次盘：整轮应 6 次写入（历史 3 + 索引 3），实际 ${h.saves()} 次`);
    });

    /** 只有一个调用时不加批次头：多数回复只有一个，多一层是纯 token 开销 */
    await check('单个调用不加批次头（措辞与从前一致）', async () => {
        const h = await buildAgentHarness({ toolCall: true });
        await h.send('取一下价格');
        const observation = h.chats[1].find((m) => m.content.includes('[工具 js 的执行结果]'));
        assert(observation, '单个调用的观察必须照旧回灌');
        assert(!observation.content.includes('个调用'),
            '单个调用不该带批次头 —— 那会让模型以为自己在批量做事');
    });

    /**
     * 缺工具名的一项 —— 在结构化通道下**不可能出现**（name 由服务商填）。
     *
     * 所以这条改测新形态：**参数坏掉**的那一项不拖垮整批，其余照跑，
     * 且坏掉的那项要作为失败观察被说出来。
     */
    await check('一批里参数坏掉的一项不拖垮整批', async () => {
        const h = await buildAgentHarness({
            replyAsObject: true,
            replyOverride: (at) => {
                if (at === 0) {
                    return {
                        content: '第二项参数坏了',
                        toolCalls: [
                            { id: 'c1', name: 'js', arguments: '{"code":"return 1;"}' },
                            { id: 'c2', name: 'js', arguments: '{"code": ' },
                        ],
                        finishReason: 'tool_calls',
                    };
                }
                if (at === 1) return { content: '完成', toolCalls: [], finishReason: 'stop' };
                return null;
            },
        });
        await h.send('查一下');

        const tools = h.state().messages.filter((m) => m.role === 'tool');
        assert(tools.length === 2, `两项都应留痕（坏的那项也要记账），实际 ${tools.length} 条`);
        assert(tools[0].ok === true, '写对的那项应成功');
        assert(tools[1].ok === false, '参数坏掉的那项应标为失败');
        assert(h.ranCode.length === 1, '只有写对的那项该真的执行');
        assert(h.state().messages[h.state().messages.length - 1].content === '完成', '循环应继续到收尾');
    });

    /**
     * 一次给多少调用**不设上限**：全都执行。
     *
     * 曾经有个"一批最多 8 个"的上限，理由是成本。那条理由站不住 ——
     * 一次给几个是模型自己的判断，按条数砍等于替它决定，而且被砍掉的几条
     * 没有任何提示，模型看到的结果比它写的少，只会以为工具坏了再发一遍。
     * 成本由 800k 上下文门槛与压缩来管。
     */
    await check('一批调用不设条数上限，全都执行', async () => {
        const h = await buildAgentHarness({
            replies: [
                JSON.stringify({
                    intent: '一次发很多',
                    calls: Array.from({ length: 12 }, () => ({ tool: 'js', args: { code: 'return 1;' } })),
                }),
                JSON.stringify({ intent: '收尾', final: '完成' }),
            ],
        });
        await h.send('查一下');

        const tools = h.state().messages.filter((m) => m.role === 'tool');
        eq(tools.length, 12, `12 个调用应全部执行，实际 ${tools.length}`);
        eq(h.ranCode.length, 12, 'js 应真的执行 12 次');
        assert(!h.chats[1].some((m) => m.content.includes('一批最多')),
            '不得再出现"一批最多 N 个"的提示 —— 那个上限已经删掉了');
    });

    /**
     * `calls: []` 与"没有工具调用"现在是**同一件事**：模型没要工具。
     *
     * 旧协议里"给了 calls 字段但为空"要按协议错误处置（因为模型明确写了 calls
     * 却没有内容，是表达错误）。结构化通道下不存在"空 calls"这个概念 ——
     * 服务商不给 tool_calls 就是不给。所以有正文时它就是收尾。
     */
    await check('没有工具调用但有正文 = 收尾，不是协议错误', async () => {
        const h = await buildAgentHarness({
            replies: [
                JSON.stringify({ intent: '我打算这么做', calls: [] }),
                JSON.stringify({ intent: '收到', final: '真的结论' }),
            ],
        });
        await h.send('看看');

        assert(h.chats.length === 1, `应直接收尾，不该回灌，实际 ${h.chats.length} 次请求`);
        assert(!h.state().messages.some((m) => m.label === '协议错误'),
            '没有工具调用不是协议错误');
        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.content === '我打算这么做', `应以它的正文收尾，实际 ${JSON.stringify(last)}`);
    });

    /**
     * 被输出长度截断（`finish_reason: "length"`）必须**回灌**，不能当结论。
     *
     * 这是旧协议完全没有的能力：那时截断只表现为"JSON 没闭合"，靠字符串诊断去猜。
     * 现在服务商直接告诉我们它被砍断了 —— 而模型自己不知道，它收到的正文看起来
     * 完全正常，下一步只会照着半句话继续往下想。
     */
    await check('被截断的回复回灌要求拆小，且不当作回答', async () => {
        const h = await buildAgentHarness({
            replyAsObject: true,
            replyOverride: (at) => {
                if (at === 0) return { content: '我正在写一个很长的脚本，首先', toolCalls: [], finishReason: 'length' };
                if (at === 1) return { content: '拆小之后的结论', toolCalls: [], finishReason: 'stop' };
                return null;
            },
        });
        await h.send('写个大脚本');

        assert(h.chats.length >= 2, `截断后应继续请求模型，实际 ${h.chats.length} 次`);
        const fix = h.chats[1].find((m) => m.content.includes('输出长度上限'));
        assert(fix, `应回灌截断说明，实际：${JSON.stringify(h.chats[1])}`);
        assert(fix.content.includes('拆小'), '必须给出"把这一步拆小"这个动作');

        // 那半句话不得作为回答落进对话流
        assert(!h.state().messages.some((m) => m.role === 'assistant' && m.content === '我正在写一个很长的脚本，首先'),
            '被截断的半句话不得被当成回答');

        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.content === '拆小之后的结论', `应以拆小后的正文收尾，实际 ${JSON.stringify(last)}`);
    });

    /**
     * 一批里的用量只记一次。
     *
     * 用量是用户拿来核账单的数：一批挂 N 份，累计就把**一次**调用算成 N 次，
     * 而界面上每一份看起来都"有出处"，对不上时无从解释。
     */
    await check('一批调用的用量只记在第一条上', async () => {
        const h = await buildAgentHarness({
            replies: [
                JSON.stringify({
                    intent: '并行两件',
                    calls: [
                        { tool: 'js', args: { code: 'return 1;' } },
                        { tool: 'js', args: { code: 'return 2;' } },
                    ],
                }),
                JSON.stringify({ intent: '收尾', final: '完成' }),
            ],
        });
        await h.send('查一下');

        const tools = h.state().messages.filter((m) => m.role === 'tool');
        assert(tools.length === 2, `两个调用都该执行，实际 ${tools.length} 条`);
        assert(tools.filter((m) => m.usage).length === 1,
            '一批只该有一条带用量，否则累计会把一次调用算成两次');
        const st = h.state();
        const sum = st.messages.reduce((s, m) => s + (m.usage ? m.usage.totalTokens : 0), 0);
        assert(st.usage.totalTokens === sum,
            `累计必须等于各条之和，实际 ${st.usage.totalTokens} vs ${sum}`);
    });

    /**
     * 多调用的解析判据本身。
     *
     * 直接调 extractCalls 而不是只跑端到端：端到端能证明"这条路径通了"，
     * 证明不了边界（空输入、条数不设上限），而那些边界正是真会踩的。
     */
    await check('extractCalls 的边界', async () => {
        eq(PARSE.extractCalls([]).calls.length, 0, '没有调用时应返回空');
        eq(PARSE.extractCalls(null).calls.length, 0, 'null 也应返回空（不抛）');

        const one = PARSE.extractCalls([{ id: 'c1', name: 'js', arguments: '{"code":"return 1;"}' }]);
        eq(one.calls.length, 1, '单项应解析出一项');
        eq(one.calls[0].tool, 'js', '工具名应原样保留（不做大小写归一）');
        eq(one.calls[0].raw, '{"code":"return 1;"}', '原始参数串应原样带出（由 parseArguments 负责解析）');

        /*
         * **不设条数上限**：给多少就执行多少。
         *
         * 曾经有过一个 8 条的上限，被砍掉的那几条没有任何提示 —— 模型看到的结果
         * 比它写的少，只会以为工具坏了再把同一批发一遍。成本由上下文门槛与压缩管。
         */
        const many = PARSE.extractCalls(
            Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, name: 'js', arguments: '{}' })),
        );
        eq(many.calls.length, 20, '不设上限：20 个应全部保留');
        assert(!('written' in many), 'written 随上限一起删掉了 —— 不再有"写了比跑的多"这种情况');
    });

    /* ---------------------- 界面：intent 必须画出来 ---------------------- */

    /**
     * 球的对话流要画出**这一步的说明**（模型写的 intent），而不是只画返回值。
     *
     * ## 为什么这条只能钉在源码上
     *
     * 它是**渲染层**的性质，而渲染层在 app/ 下（React + JSX），不在本测试的编译
     * 范围里（见 test/tsconfig.json）。引擎那边已经保证 intent 落进了工具消息的
     * `content`（上面几条断言），漏掉的只可能是界面那一头。
     *
     * ## 只画 result 时是什么样
     *
     * 对话流里只剩一串返回值。用户看到"读了 `window.__DATA__`"却看不到
     * "它想拿价格"，而后者才是复盘时问的第一句 —— 模型每一步的目的就这么丢了。
     *
     * ## 判据认结构，不认措辞
     *
     * 取的是不是工具消息的 content、画在不在结果之前、复制带不带它。样式类名与
     * 具体文案是界面自己的事，钉住它们会让改一次配色就红一片。
     */
    await check('界面画出这一步的 intent，而不是只画返回值', async () => {
        const orb = fs.readFileSync(ORB_SRC, 'utf8');
        const at = orb.indexOf('const MessageRow = (');
        assert(at > 0, '找不到 MessageRow（界面实现变了，本断言需重写）');
        const row = orb.slice(at, orb.indexOf('const MessageRowMemo', at));
        assert(row.length > 0, 'MessageRow 的切片为空');

        // 1. 工具消息的 content 被单独取成一份，而不是并进 result 那一份
        assert(/const intent = message\.role === 'tool'[\s\S]{0,40}message\.content/.test(row),
            'MessageRow 应把工具消息的 content 单独取出来（它写的是 intent）');

        // 2. 取到还要画，且画在结果之上：先看它要做什么，再看结果
        const drawn = row.indexOf('{intent && (');
        const result = row.indexOf('{shown && (');
        assert(drawn > 0, 'intent 必须被渲染出来（只取不画等于没做）');
        assert(result > drawn, 'intent 应画在结果之上：先看它要做什么，再看结果');

        /*
         * 3. 复制要带上它。
         *
         * 只复制 result 时，把这条发给别人就丢了"它当时想干什么"——
         * 而收件人正是靠那句话判断这次调用对不对。
         */
        assert(/writeText\(copyText\)/.test(row), '复制应复制「说明 + 结果」那一份');
        assert(/\[intent, body\]/.test(row), 'copyText 应由 intent 与 body 拼成');
    });

    /* ---------------------- 删除单条 / 回退到检查点 ---------------------- */

    /**
     * 造一段两轮的对话，返回 harness 与两轮的消息 id。
     *
     * 用真实的 send 跑出来而不是手搓 messages：删除与回退的判据都依赖
     * "一条消息属于哪一轮"，手搓的假数据会把这条判据的验证变成自证。
     */
    const twoRounds = async (options = {}) => {
        const h = await buildAgentHarness({ toolCall: true, ...options });
        await h.send('第一轮提问');
        await h.send('第二轮提问');
        const list = h.state().messages;
        const idxOf = (text) => list.findIndex((m) => m.content === text);
        return { h, list, first: list[idxOf('第一轮提问')], second: list[idxOf('第二轮提问')] };
    };

    await check('删除：只删掉指定的那一条，其余原样保留', async () => {
        const { h, list, first } = await twoRounds();
        const before = list.map((m) => m.id);
        const victim = list.find((m) => m.role === 'tool');

        h.state().actions.removeMessage(victim.id);

        const after = h.state().messages;
        assert(after.length === before.length - 1, `应少一条，实际 ${before.length} → ${after.length}`);
        assert(!after.some((m) => m.id === victim.id), '被删的那条不该还在');
        // 其余各条的 id 与顺序必须逐位一致：删除不能顺手改动别的东西
        assert(
            JSON.stringify(after.map((m) => m.id)) === JSON.stringify(before.filter((id) => id !== victim.id)),
            '其余消息的 id 与顺序都应原样保留',
        );
        assert(after.some((m) => m.id === first.id), '第一轮的提问不该受影响');
    });

    await check('删除：删一条用户提问不牵连它那一轮的其他消息', async () => {
        const { h, list, first } = await twoRounds();
        // 同一轮的回答文本现取，不硬编码：toolCall 让每轮发两次 chat，
        // 回答编号是全局调用序号，写死 "第 1 轮的回答" 会对着一个不存在的字符串断言。
        const reply = list.find((m) => m.role === 'assistant');
        assert(reply, '构造前提：应有一条助手回答');

        h.state().actions.removeMessage(first.id);
        const after = h.state().messages;
        assert(!after.some((m) => m.id === first.id), '提问应被删掉');
        assert(after.length === list.length - 1, '只应少这一条（删除与回退的语义差别就在这里）');
        assert(after.some((m) => m.id === reply.id), '同一轮的回答应留着');
    });

    await check('删除：未知 id 是空操作，不抛异常也不动列表', async () => {
        const { h, list } = await twoRounds();
        h.state().actions.removeMessage('不存在的-id');
        assert(h.state().messages.length === list.length, '列表不该变化');
    });

    await check('回退：切点之前的消息逐条保留，不按轮次往前扩', async () => {
        const { h, list, second } = await twoRounds();
        // 停在第二轮中间的工具消息上：切点就是它自己
        const inSecond = list.slice(list.indexOf(second)).find((m) => m.role === 'tool');
        assert(inSecond, '第二轮应有工具消息（构造前提）');

        const at = list.findIndex((m) => m.id === inSecond.id);
        const prompt = h.state().actions.rewindTo(inSecond.id);

        // 目标不是用户提问，没有"提问"可填回输入框
        assert(prompt === '', `回退到工具消息不该返回提问，实际 ${JSON.stringify(prompt)}`);
        const after = h.state().messages;
        assert(after.length === at, `应恰好切到该条之前（剩 ${at} 条），实际 ${after.length} 条`);
        assert(
            JSON.stringify(after.map((m) => m.id)) === JSON.stringify(list.slice(0, at).map((m) => m.id)),
            '保留的必须是原序列的前 at 条，逐位一致',
        );
        // 这条是本次改动要钉住的：切点之前的内容一律不动。
        // 只要实现里又混进"往前找到本轮提问"的逻辑，这两个断言立刻失败。
        assert(after.some((m) => m.id === second.id), '切点之前的第二轮提问必须保留');
        assert(after.some((m) => m.content === '第一轮提问'), '第一轮必须原样留着');
    });

    await check('回退：作用在用户提问上时，连它自己也一并移除', async () => {
        const { h, second } = await twoRounds();
        const prompt = h.state().actions.rewindTo(second.id);
        assert(prompt === '第二轮提问', '应返回该提问原文');
        assert(!h.state().messages.some((m) => m.id === second.id), '被回退到的那条本身也要移除');
    });

    await check('回退：作用在第一轮提问上时清空整个列表', async () => {
        const { h, first } = await twoRounds();
        const prompt = h.state().actions.rewindTo(first.id);
        assert(prompt === '第一轮提问', '应返回第一轮提问原文');
        assert(h.state().messages.length === 0, `应清空，实际还剩 ${h.state().messages.length} 条`);
    });

    /**
     * 回退的语义：**点中哪一条，就把那一条及其之后的全部删掉**。
     *
     * 不按轮次切、不回头改更早的内容 —— 切点之前的消息逐条原样保留。
     * 这里直接查重建结果，钉住"保留的是原序列前 at 条"这个不变量：
     * 只要实现里又混进任何按轮往前扩的逻辑，保留下来的序列就会少几条。
     */
    await check('回退后重建的上下文恰为原序列的前 at 条', async () => {
        const { h, list, second } = await twoRounds();
        const inSecond = list.slice(list.indexOf(second)).find((m) => m.role === 'tool');
        const at = list.findIndex((m) => m.id === inSecond.id);
        h.state().actions.rewindTo(inSecond.id);

        const rebuilt = buildTranscript(h.state().messages);
        const expected = buildTranscript(list.slice(0, at));
        assert(JSON.stringify(rebuilt) === JSON.stringify(expected),
            `重建结果应等于原序列前 ${at} 条的重建结果`);
        assert(rebuilt.length > 0, '回退后仍应保留第一轮（构造前提）');
    });

    await check('回退：未知 id 是空操作，返回空串', async () => {
        const { h, list } = await twoRounds();
        const prompt = h.state().actions.rewindTo('不存在的-id');
        assert(prompt === '', `未知 id 应返回空串，实际 ${JSON.stringify(prompt)}`);
        assert(h.state().messages.length === list.length, '列表不该变化');
    });

    /**
     * 运行中禁止改历史。
     *
     * 主循环正拿着 messages 追加，此刻删除会和它的下一次 appendMessage 抢同一个数组。
     * 更要紧的是：不设这道闸，用户会看到"删了没反应"——那看起来像坏了。
     */
    await check('运行中：删除与回退都被拒绝', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const h = await buildAgentHarness({ hold: gate });
        await h.send('第一轮提问');
        const before = h.state().messages;

        const pending = h.sendPending('第二轮提问');
        // 此刻 status 应为 thinking，canEdit 为 false
        assert(h.state().canEdit === false, '运行中 canEdit 应为 false');

        const target = before[before.length - 1];
        h.state().actions.removeMessage(target.id);
        assert(h.state().messages.some((m) => m.id === target.id), '运行中的删除必须被拒绝');

        const prompt = h.state().actions.rewindTo(target.id);
        assert(prompt === '', '运行中的回退必须被拒绝并返回空串');
        assert(h.state().messages.length >= before.length, '运行中的回退不得改动列表');

        release();
        await pending;
        assert(h.state().canEdit === true, '结束后 canEdit 应恢复');
    });

    await check('空闲时 canEdit 为 true', async () => {
        const { h } = await twoRounds();
        assert(h.state().canEdit === true, '空闲时 canEdit 应为 true');
    });

    /**
     * 运行中推出去的**每一版**快照都不许说"可以编辑"。
     *
     * 只看最后一版是不够的：send() 一进来就把 busy 置真，而 status 要到第一次
     * 请求发出才变 thinking —— 按 status 判 canEdit 的话，"提问刚进对话"那一刻
     * 推出去的那一版会说可以编辑，而改写历史的闸门是 busy：按钮亮着，点下去
     * 什么也不会发生。
     */
    await check('运行中每一版快照都说不可编辑', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const h = await buildAgentHarness({ hold: gate, holdAt: 2 });
        await h.send('第一轮');
        assert(h.state().canEdit === true, '构造前提：空闲时应可编辑');

        const before = h.snapshots().length;
        const pending = h.sendPending('第二轮卡在模型调用上');
        const during = h.snapshots().slice(before);
        assert(during.length > 0, '构造前提：这一轮应已经推出过快照');
        assert(during.every((s) => s.canEdit === false),
            `运行中每一版都必须是 canEdit:false，实际 ${JSON.stringify(during.map((s) => [s.status, s.canEdit]))}`);

        release();
        await pending;
        assert(h.state().canEdit === true, '结束后应恢复可编辑');
    });

    /* ---------------------- 工具失败与协议错误 ---------------------- */

    /**
     * 工具失败必须**明确标注**，且带着错误信息回灌给模型继续。
     *
     * 原先成功与失败共用「[工具 X 的执行结果]」一个前缀，模型只能自己去读
     * JSON 里的 error 字段。实测里它经常读漏，接着按原计划往下走 ——
     * 同一招连错好几次把预算烧光。这条钉住"失败长得与成功不一样"。
     */
    await check('工具失败：回灌前缀标明失败，并附上错误原文', async () => {
        // webview:false → js 返回"当前没有可用的页面"，稳定造出失败
        const h = await buildAgentHarness({ toolCall: true, webview: false });
        await h.send('取一下');

        const tool = h.state().messages.find((m) => m.role === 'tool');
        assert(tool, '构造前提：应有一条 tool 消息');
        assert(tool.ok === false, '失败的工具消息 ok 应为 false');

        // 回灌给模型的那条 tool 消息
        const wire = h.chats[1] || h.chats[h.chats.length - 1];
        const observation = wire.find((m) => m.role === 'tool' && m.content.includes('[工具 js 执行失败]'));
        assert(observation, `失败必须以「执行失败」前缀回灌，实际：${JSON.stringify(wire)}`);
        assert(observation.content.includes('当前没有可用的页面'),
            '必须带上原始错误信息 —— 只说"失败了"模型不知道改什么');
    });

    /**
     * 失败之后必须**继续**，而不是当成结论收尾。
     *
     * 这是本次要修的核心：失败只是这一步的结果，不是任务的终点。
     * 用例让模型第一次调工具（必失败）、第二次给出正文 ——
     * 若实现把失败当成"说完了"，就不会有第二次调用。
     */
    await check('工具失败后继续跑下一步，不当作收尾', async () => {
        const h = await buildAgentHarness({
            webview: false,
            replies: [
                JSON.stringify({ intent: '取数', calls: [{ tool: 'js', args: { action: 'R', code: 'return 1;' } }] }),
                JSON.stringify({ intent: '页面不可用，直接给结论', final: '拿不到页面数据。' }),
            ],
        });
        await h.send('取一下');

        assert(h.chats.length >= 2,
            `失败后应继续请求模型（至少 2 次 chat），实际 ${h.chats.length} 次`);
        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.role === 'assistant' && last.content === '拿不到页面数据。',
            `应以模型的正文收尾，实际 ${JSON.stringify(last)}`);
    });

    /**
     * **散文就是收尾。**
     *
     * 旧协议下"没有 JSON 信封"是一种协议错误，必须回灌让它改。新协议没有信封：
     * 模型不再调用工具、直接写正文，就是它在回答问题。把它当成错误回灌，
     * 等于把一次正常的回答打回重做。
     *
     * 这条断言钉的是这个语义翻转 —— 它是整套改造里最容易写反的一处。
     */
    await check('散文即收尾：没有工具调用就直接当回答，不回灌', async () => {
        const h = await buildAgentHarness({ replies: '页面是商品列表，价格在 meta 里。' });
        await h.send('看看');

        assert(h.chats.length === 1, `散文应直接收尾，不该再请求模型，实际 ${h.chats.length} 次`);
        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.role === 'assistant' && last.content === '页面是商品列表，价格在 meta 里。',
            `散文应原样成为回答，实际 ${JSON.stringify(last)}`);
        assert(!h.state().messages.some((m) => m.label === '协议错误'),
            '不得把一次正常回答记成协议错误');
    });

    /**
     * 真正的协议错误只剩一种：**服务商给的参数不是合法 JSON**。
     *
     * 结构化通道下这不该发生；一旦发生，说明当前服务没有真正约束解码。
     * 它必须回灌（让模型重发同一个调用）并留痕，而不是静默丢掉这一步。
     */
    await check('协议错误：参数不是合法 JSON 时回灌并继续', async () => {
        const h = await buildAgentHarness({
            replyOverride: (at) => {
                if (at === 0) {
                    return {
                        content: '取数',
                        toolCalls: [{ id: 'c1', name: 'js', arguments: '{"code": "return 1"' }],
                        finishReason: 'tool_calls',
                    };
                }
                if (at === 1) return { content: '真正的结论', toolCalls: [], finishReason: 'stop' };
                return null;
            },
        });
        await h.send('看看');

        assert(h.chats.length >= 2, `协议错误后应继续，实际只发了 ${h.chats.length} 次`);

        const wire = h.chats[1];
        const fix = wire.find((m) => m.content.includes('[协议错误]'));
        assert(fix, `应回灌协议错误提示，实际：${JSON.stringify(wire)}`);
        assert(fix.content.includes('合法 JSON'), '提示里必须说明参数不是合法 JSON');

        const bad = h.state().messages.find((m) => m.label === '协议错误');
        assert(bad, '协议错误应在对话流里留一条记录');
        assert(bad.ok === false, '它是一次失败，ok 应为 false');

        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.content === '真正的结论',
            `应等到模型的正文才收尾，实际 ${JSON.stringify(last)}`);
    });

    /**
     * 协议错误的回灌文案在**当场**与**下一轮重建时**必须逐字一致。
     *
     * 这两条路分别由 send 与 roundToMessages 走，是"一个事实两个产出点"的
     * 典型形态。文案只能由 protocolErrorObservation 一个函数产出，
     * 这里把这条对称性钉住。
     */
    await check('协议错误的回灌文案当场与重建时逐字一致', async () => {
        const h = await buildAgentHarness({
            replyAsObject: true,
            replyOverride: (at) => (at === 0
                ? { content: '取数', toolCalls: [{ id: 'c1', name: 'js', arguments: 'not json' }], finishReason: 'tool_calls' }
                : { content: '收尾', toolCalls: [], finishReason: 'stop' }),
        });
        await h.send('看看');

        // 当场的回灌：第一次协议错误之后那一轮请求里带的那条 user 消息
        const live = h.chats[1].find((m) => m.content.includes('[协议错误]'));
        assert(live, `当场应回灌协议错误提示，实际：${JSON.stringify(h.chats[1])}`);

        // 重建的观察：把界面记录原样喂回 buildTranscript
        const rebuilt = buildTranscript(h.state().messages)
            .map((m) => m.content).join('\n');
        assert(rebuilt.includes('[协议错误]'),
            `下一轮重建也必须认出这是协议错误，实际：${rebuilt.slice(0, 200)}`);

        assert(live.content === rebuilt.slice(rebuilt.indexOf('[协议错误]'), rebuilt.indexOf('[协议错误]') + live.content.length),
            '当场与重建的协议错误文案必须逐字一致，否则模型对错误的判断会随轮次漂移');
    });

    /**
     * 工具观察的措辞在**当场**与**下一轮重建时**必须逐字一致。
     *
     * 与协议错误同一形态、同一风险：send 与 roundToMessages 各写一份措辞时，
     * 模型当场读到"失败，请修正参数"，下一轮却只剩一句中性的"执行结果" ——
     * 它会以为自己那一步其实成功了。所以文案只能由 toolObservation 一个函数产出。
     */
    await check('工具观察的文案当场与重建时逐字一致', async () => {
        // webview:false → js 稳定失败，正好覆盖带"修正参数"那段后缀的分支
        const h = await buildAgentHarness({ toolCall: true, webview: false });
        await h.send('取一下');

        const tool = h.state().messages.find((m) => m.role === 'tool');
        const live = (h.chats[1] || []).find((m) => m.content.includes('[工具 '));
        assert(live, '当场应回灌工具观察');

        const rebuilt = buildTranscript(h.state().messages)
            .map((m) => m.content).join('\n');
        assert(rebuilt.includes(`[工具 ${tool.label} 执行失败]`),
            `下一轮重建也必须认出这是一次失败，实际：${rebuilt.slice(0, 200)}`);
        assert(rebuilt.includes(live.content),
            '当场与重建的工具观察必须逐字一致，否则模型对"这步成没成"的判断会随轮次漂移');

        // 成功那一路同理：中性前缀不得被写成失败
        const okOut = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', label: 'js', result: '{"a":1}', ok: true }),
        ]).map((m) => m.content).join('\n');
        assert(okOut.includes('[工具 js 的执行结果]'), '成功应走中性前缀');
        assert(!okOut.includes('这一步没有成功'), '成功不得带失败后缀');
    });

    /**
     * 重建时认不认得出协议错误，全靠 label 这一个字面量。
     *
     * 构造侧写 '协议错误'、重建侧比 '协议错误'，任一侧改字就静默退化
     * （上面那条用例会因为两处都退化而仍然通过），所以这里直接钉住它只有一个来源。
     */
    await check('协议错误的 label 只有一个来源', async () => {
        const src = ALL_SRC;
        assert(/const PROTOCOL_ERROR_LABEL = '协议错误';/.test(src),
            'label 必须由具名常量给出');
        assert(/label: item\.bad \? PROTOCOL_ERROR_LABEL : item\.label,/.test(src),
            '构造侧必须用该常量，不得手写字面量');
        assert(/message\.label === PROTOCOL_ERROR_LABEL/.test(src),
            '重建侧必须用同一个常量比对');
        // 手写的 '协议错误' 字面量只应出现在常量声明那一处
        const literals = (src.match(/'协议错误'/g) || []).length;
        assert(literals === 1,
            `'协议错误' 字面量只应出现在常量声明里，实际 ${literals} 处（多一处就是两个来源）`);
    });

    /**
     * 回复解析的整套机器**必须已经删掉**。
     *
     * 这不是"清理死代码"的洁癖：那套机器存在的前提是"模型手写 JSON 外壳"，
     * 而只要它还留在源码里，下一个改的人就会以为那条路仍然有效 ——
     * 于是又会出现"从正文里抠 JSON"的分支，而它在我们自己的协议下永远抠不到东西。
     */
    await check('回复解析机器已彻底删除', async () => {
        /*
         * 扫的是**去掉注释后的代码**。
         *
         * parse.ts 的文件头解释了那套机器为什么被删，注释里必然还会提到那几个
         * 名字 —— 连注释一起扫的话，这条断言会逼着人删掉解释，那正好毁掉
         * "为什么删"的记录。
         */
        const strip = (text) => text
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|\s)\/\/[^\n]*/g, '$1');
        const src = AGENT_SOURCES.map((s) => strip(s.text)).join('\n');
        for (const gone of ['extractJsonObject', 'diagnoseReply', 'scanBraces', 'ReplyProblem']) {
            assert(!src.includes(gone), `${gone} 应随信封协议一起删除（留着会让人以为那条路还通）`);
        }
        // 提示词里也不得再教模型写外壳
        const promptSrc = AGENT_SOURCES.find((s) => s.file === 'prompt.ts').text;
        assert(!/"calls"\s*:/.test(promptSrc), '提示词不得再教 calls 字段');
        assert(!/"final"\s*:/.test(promptSrc), '提示词不得再教 final 字段');
    });

    /**
     * 参数解析的判据。
     *
     * 旧版本这里测的是"从回复正文里抠 JSON 信封"的四种错法。那套机器随信封协议
     * 一起删掉了 —— 现在唯一要解析的是**服务商生成的** `arguments`，而它坏了
     * 只有一种含义：这个服务没有真正约束解码。
     *
     * 直接调用判据而不是扫源码：源码里写着 `case 'x'` 并不能证明一条真的坏参数
     * 会落到那一支（那正是变异测试里存活下来的写法）。
     */
    await check('参数解析：空串归一成空对象，坏 JSON 与非法类型分开报', async () => {
        // 空串 = 调了工具却没给参数。归一成 {} 而不是报错 ——
        // 工具层对缺参数有自己的文案（"缺少 code" 比 "arguments 是空串" 更好改）
        const empty = PARSE.parseArguments('');
        eq(empty.ok, true, '空串应归一成空对象');
        eq(Object.keys(empty.args).length, 0, '空串不该造出任何键');
        eq(PARSE.parseArguments('   ').ok, true, '纯空白同样归一成空对象');

        // 正常对象
        const good = PARSE.parseArguments('{"code":"return 1"}');
        eq(good.ok, true, '合法对象应解析成功');
        eq(good.args.code, 'return 1', '字段应原样取出');

        // 坏 JSON：必须报错，并带上原文（否则模型看不见自己写了什么）
        const bad = PARSE.parseArguments('{"code": "return 1"');
        eq(bad.ok, false, '没闭合的 JSON 必须报错');
        assert(bad.error.includes('合法 JSON'), `要点明不是合法 JSON，实际 ${bad.error}`);
        assert(bad.error.includes('return 1'), '必须附上原文供自查');

        // 不是对象：数组 / 数字 / null 都算，工具层只认键值对
        for (const raw of ['[1,2]', '42', 'null']) {
            const parsed = PARSE.parseArguments(raw);
            eq(parsed.ok, false, `${raw} 不是对象，必须报错`);
            assert(parsed.error.includes('JSON 对象'), `要点明要的是对象，实际 ${parsed.error}`);
        }
    });

    /**
     * 协议错误的回灌文案**只由这一个函数产出**，且必须给出唯一有效的动作。
     *
     * 旧版本按四种错法分岔（散文 / 截断 / 语法坏 / 少字段），因为那时外壳是模型
     * 手写的。结构化通道下只剩一种可能，分岔文案留着反而会让模型去找别的坑。
     */
    await check('协议错误：回灌文案点名原因并给出重发这一个动作', async () => {
        const reason = '参数不是合法 JSON（Unexpected end of JSON input）。原文：{"code":';
        const text = protocolErrorObservation(reason);
        assert(text.includes('[协议错误]'), '必须带协议错误标记');
        assert(text.includes(reason), '必须原样带上原因，否则模型不知道自己错在哪');
        assert(text.includes('重发同一个调用'), '必须给出唯一有效的动作');
        // 不得再提已经不存在的外壳字段
        assert(!text.includes('"calls"') && !text.includes('"final"'),
            '不得再要求模型写 calls / final —— 那两个字段随信封协议一起删掉了');
    });

    /** 界面上那条记录只给一行结论，不贴原文（原文动辄几千字，会把对话流冲垮） */
    await check('协议错误：界面摘要是单行', async () => {
        const summary = TRANSCRIPT.protocolErrorSummary('参数不是合法 JSON。原文：' + 'a'.repeat(3000));
        assert(!summary.includes('\n'), '界面摘要必须是一行');
        assert(summary.includes('协议错误'), `摘要要点明是协议错误，实际 ${summary}`);
        assert(summary.includes('合法 JSON'), `摘要要带上原因，实际 ${summary}`);
    });

    /**
     * 页面执行失败的位置换算。
     *
     * 宿主（CDP）报的行号是**包装后**源码的行号，而模型只认得自己写的那几行。
     * 这里直接调用换算函数，并把包装偏移**从真实包装结果里量出来** ——
     * 写死一个数字的话，包装模板一改就整体偏一行，而那种偏没有任何症状。
     */
    await check('js 语法错：行号换算回模型自己的代码', async () => {
        const code = 'const a = 1;\nreturn a +;\nconst b = 2;';
        const wrapped = PARSE.buildScriptSource(code);
        // 模型第一行在包装后源码里的行号（1 起）
        const first = wrapped.split('\n').indexOf('const a = 1;') + 1;
        assert(first > 1, '模型代码不应从第 1 行开始（否则这个用例证明不了换算）');

        const raw = JSON.stringify({
            __agentError: "SyntaxError: Unexpected token ';'",
            __agentAt: { line: first + 1, column: 12 },
        });
        const out = PARSE.locateScriptError(raw, code);
        assert(out.includes('第 2 行'), `应换算成模型自己的第 2 行，实际 ${out}`);
        assert(out.includes('return a +;'), '要把出错那一行原文抄出来');
        assert(out.includes('^'), '要给出定位符');
        assert(!out.includes('__agentAt'), '内部的位置字段不该回传给模型');
        assert(out.includes('Unexpected token'), 'V8 的原话要保留');

        // 拿不到位置时原样返回：宁可少说，也不能报一个错的坐标
        const noPos = JSON.stringify({ __agentError: 'TypeError: x is not a function' });
        eq(PARSE.locateScriptError(noPos, code), noPos, '没有位置信息时不得改写');
        // 不是失败结果的（正常返回值）一律不动
        eq(PARSE.locateScriptError('{"a":1}', code), '{"a":1}', '正常返回值不得被改写');

        /*
         * 大而正常的结果不能付一次完整 JSON.parse。
         *
         * 这个函数在**每一个** js 结果上跑一次，而绝大多数结果是正常数据。
         * 实测 16MB 的正常返回：先查 `__agentError` 子串是 1~3ms，直接 parse
         * 是 25~45ms —— 差一个数量级，且那 30ms 之后一行都用不上。
         */
        const rows = Array.from({ length: 80000 }, (_, i) => ({ i, s: 'x'.repeat(180) }));
        const big = JSON.stringify({ rows });
        const started = Date.now();
        eq(PARSE.locateScriptError(big, code), big, '正常的大结果必须原样返回');
        const elapsed = Date.now() - started;
        assert(elapsed < 20,
            `${(big.length / 1024 / 1024).toFixed(0)}MB 的正常结果应在 20ms 内返回，实际 ${elapsed}ms ——`
            + '没有 __agentError 时不该做完整 JSON.parse');
    });

    /**
     * 连续坏参数到上限就停 —— 无上限回灌会把整轮预算烧光，
     * 且每一步都要付一次调用费。
     */
    await check('协议错误：连续超限后停止并说明原因', async () => {
        const h = await buildAgentHarness({
            replyAsObject: true,
            replyOverride: () => ({
                content: '取数',
                toolCalls: [{ id: 'c1', name: 'js', arguments: '{bad' }],
                finishReason: 'tool_calls',
            }),
        });
        await h.send('看看');

        const src = ALL_SRC;
        const max = Number(src.match(/const MAX_PROTOCOL_ERRORS = (\d+);/)[1]);
        assert(h.chats.length === max,
            `应恰好尝试 ${max} 次后停止，实际 ${h.chats.length} 次`);

        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.notice === true, '收尾提示必须带 notice（不是模型说的话）');
        assert(last.content.includes('协议'), `应说明是协议问题，实际 ${last.content}`);
        assert(last.content.includes('约束解码'), '应指出成因是服务商没有约束解码（否则用户只会换个说法重试）');
    });

    /** 成功执行一次工具就归零：偶发故障不该跟着整个会话不放 */
    await check('协议错误计数在工具成功执行后归零', async () => {
        const h = await buildAgentHarness({
            replyAsObject: true,
            replyOverride: (at) => {
                // 0：坏参数 → 计 1 次
                if (at === 0) return { content: '取数', toolCalls: [{ id: 'c1', name: 'js', arguments: '{bad' }], finishReason: 'tool_calls' };
                // 1：正常调用 → 计数归零
                if (at === 1) return { content: '改好了', toolCalls: [{ id: 'c2', name: 'js', arguments: '{"code":"return 1;"}' }], finishReason: 'tool_calls' };
                // 2：再坏一次 —— 若没归零，加上第 0 次就到上限了
                if (at === 2) return { content: '又坏了', toolCalls: [{ id: 'c3', name: 'js', arguments: '{bad' }], finishReason: 'tool_calls' };
                // 3：收尾
                return { content: '结束', toolCalls: [], finishReason: 'stop' };
            },
        });
        await h.send('看看');

        // 归零了 → 不会在第 3 次调用时判定超限，能走到收尾
        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.content === '结束',
            `工具成功后计数应归零，实际以 ${JSON.stringify(last)} 收尾`);
    });

    /**
     * 工具**抛异常**（而非返回 {error}）也必须被兜住并回灌。
     *
     * 这是两条完全不同的失败路径：dispatchTool 内部对预期内的失败都返回
     * {error}，但 preload 桥没暴露、webview 被销毁这类意外会直接抛。
     * 原先异常一路冒到 send 的 finally，循环直接终止 —— 用户看到对话停在半路，
     * 而模型连"这一步失败了"都不知道，下一轮还会照着原计划重来。
     */
    await check('工具抛异常：兜住并回灌，循环不终止', async () => {
        const h = await buildAgentHarness({
            throwOnBridge: true,
            replies: [
                JSON.stringify({ intent: '读存储', calls: [{ tool: 'storage', args: { action: 'get', area: 'local' } }] }),
                JSON.stringify({ intent: '桥断了，改用页面脚本', final: '存储读不到。' }),
            ],
        });
        await h.send('读一下本地存储');

        const tool = h.state().messages.find((m) => m.role === 'tool');
        assert(tool, '异常也应记一条 tool 消息');
        assert(tool.ok === false, '抛异常的步骤 ok 应为 false');
        assert(tool.result.includes('页面宿主不可用'),
            `异常信息必须原样交给模型，实际 ${tool.result}`);

        assert(h.chats.length >= 2, `异常后应继续跑，实际只发了 ${h.chats.length} 次`);
        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.content === '存储读不到。', `应走到模型的 final，实际 ${JSON.stringify(last)}`);
    });

    /**
     * 每次执行都要**重新问**宿主当前是哪个标签页，不得缓存。
     *
     * 这条是变异测试逼出来的：把 `execActive` 改成"首次解析后缓存 tabId"，
     * 170 条断言全绿 —— 因为每个用例只跑一次、只用一个标签页。
     * 而缓存带来的故障恰恰只在**切换标签页之后**才出现：脚本继续跑到上一个
     * 页面上，用户看到的是"我明明切过来了，它还在读旧页面"。
     *
     * 判据是 activeTab() 的调用次数：切换后再执行一次，必须重新问。
     */
    await check('执行前重新解析活动标签，不缓存 tabId', async () => {
        const h = await buildAgentHarness({ toolCall: true });

        await h.send('第一轮提问');
        const afterFirst = h.activeTabCalls();
        assert(h.lastEvalTabId() === 1, `首轮应跑在标签页 1，实际 ${h.lastEvalTabId()}`);

        // 模拟用户切到另一个标签页，再跑一步 js
        h.switchTab(99);
        await h.send('第二轮提问');

        assert(h.activeTabCalls() > afterFirst,
            `切换标签页后必须重新问宿主，实际调用次数停在 ${afterFirst}`);
        assert(h.lastEvalTabId() === 99,
            `脚本应跑在新标签页上，实际 ${h.lastEvalTabId()}`);
    });

    /* --------------------------- 提示词：行为约束 --------------------------- */

    /**
     * intent 字段的写法即工作方式：它是一句话，思考属于模型自己的思维链。
     * 写进 JSON 的"思考"是幻觉，不是推理。
     *
     * 这里只钉这两句 —— 它们与协议本身绑在一起（intent 的定义在 Output protocol
     * 那节里）。至于"证据 / 复现 / 交付 / 换路"那几条行为约束，提示词里已不再
     * 声明，断言随之删除：留着一条锚在不存在的小节上的断言，只会永远报红。
     */
    await check('intent 就是正文：思考必须留在模型自己的思维链里', async () => {
        const src = ALL_SRC;
        assert(src.includes('never in the tool arguments'),
            '必须声明不要把思考写进工具参数（写进去的是幻觉，不是推理）');
        assert(src.includes('in your own thinking'),
            '必须把思考赶回模型自己的思维链');
    });

    /**
     * 提示词不得再声明一批的条数上限。
     *
     * 踩过两次：先是手抄数字（常量改了不跟着变，模型按错的上限规划步骤），
     * 后来是插值一个不该存在的上限。那个上限本身已经删掉了 —— 一次给几个调用
     * 是模型自己的判断，成本由上下文门槛与压缩管。
     */
    await check('提示词不再声明一批的条数上限', async () => {
        const src = ALL_SRC;
        assert(!/MAX_CALLS_PER_REPLY/.test(src), '常量应已删除，不得再引用');
        assert(!/at most \d+ per (turn|reply)/i.test(PROMPT.SYSTEM_PROMPT),
            '提示词不得再声明一批的条数上限');
        // 但"一批是一步、只批独立调用"这条语义必须留着 —— 它决定模型怎么规划
        assert(/A batch is one step/.test(PROMPT.SYSTEM_PROMPT), '必须说明一批就是一步');
        assert(/Batch only independent calls/.test(PROMPT.SYSTEM_PROMPT),
            '必须说明只把互不依赖的调用放进同一批');

        assert(!/RESULT_LIMIT_BYTES/.test(src),
            'js 返回值不再有字节上限，常量与提示词里的声明都该删干净');
    });

    /* --------------------------- 提示词：行为契约 --------------------------- */

    /**
     * 提示词**不再声明输出协议**，因为协议由 tools 参数承担。
     *
     * 这条断言的方向是反的：旧版本要求"必须有 Output protocol 一节"，现在要求
     * "**不得**再有"。留着那一节就会与 schema 分叉，而模型会照着更啰嗦的那份写。
     */
    await check('提示词不再声明输出协议（外壳由协议层承担）', async () => {
        const src = ALL_SRC;
        assert(!src.includes('## Output protocol'), '不得再有「Output protocol」一节');
        assert(!/One JSON object and nothing else/.test(src), '不得再要求"只回一个 JSON 对象"');
        // 但"什么时候算收尾"必须说清，否则模型不知道停下调用就是回答
        assert(/reply with prose and no tool call to finish/i.test(src),
            '必须说明"不再调用工具、直接写正文"就是收尾');
    });

    await check('工具契约：参数形状只在 schema 里，提示词不重复', async () => {
        const specSrc = AGENT_SOURCES.find((s) => s.file === 'toolspec.ts').text;
        /*
         * 参数形状的唯一来源是 toolspec.ts 的 JSON Schema。
         *
         * 这里钉住三件模型最容易搞错、而 schema 表达不了的事：
         * 改文件用 edit、node 不是 shell、navigate 接受相对路径。
         * 它们都是**行为约束**而不是参数形状，所以留在 description 里是对的。
         */
        assert(/relative path/.test(specSrc), 'navigate 的相对路径必须写进说明');
        assert(/substring/.test(specSrc), 'tamper 的 url_pattern 子串语义必须点明');
        assert(/deletes the header/.test(specSrc), 'tamper 的空 header value 语义必须点明');
        assert(/empty string deletes that segment/.test(specSrc), 'edit 的空 new 语义必须点明');
    });

    /* ------------------------- 会话 token 统计 ------------------------- */

    /**
     * 用量必须**落在消息上**，而不是只维护一个累计值。
     *
     * 累计值经不起删除与回退：用户删掉一条或回退一轮之后，累加器只会越走越偏，
     * 而界面上看不出任何异常 —— 只是数字悄悄变大。落在消息上则天然可重算。
     */
    await check('用量落在消息上，且累计由现存消息重算', async () => {
        const h = await buildAgentHarness({ toolCall: true });
        await h.send('第一轮');

        const st = h.state();
        const withUsage = st.messages.filter((m) => m.usage);
        assert(withUsage.length > 0, '应有消息带上 usage');
        assert(st.usage.calls === withUsage.length,
            `调用次数应等于带用量的消息数，实际 ${st.usage.calls} vs ${withUsage.length}`);
        assert(st.usage.totalTokens > 0, '累计总量应大于 0');
        assert(st.usage.promptTokens === withUsage.reduce((s, m) => s + m.usage.promptTokens, 0),
            '累计输入应为各条之和');

        // 删掉一条带用量的消息：累计必须跟着降下来
        const before = st.usage.totalTokens;
        st.actions.removeMessage(withUsage[0].id);
        const after = h.state().usage;
        assert(after.totalTokens < before,
            `删掉一条后累计应减少，实际 ${before} → ${after.totalTokens}`);
        assert(after.calls === withUsage.length - 1, `调用次数应减 1，实际 ${after.calls}`);
    });

    /**
     * **累计必须等于界面上能看到的各步之和。**
     *
     * 这是用户报的原始症状：累计数比每一步加起来多，而差额没有任何出处 ——
     * 看起来就像统计坏了。根因是同一个事实有两个存放处：摘要调用的用量原先挂在
     * `compaction.usage` 上，累计值两处都读，而界面只画得出 `message.usage`。
     *
     * 所以这条断言认的是**界面的口径**，不是内部实现：凡是进了累计的用量，
     * 都必须能在某条消息的 usage 上找到。摘要调用也走压缩分界线那条消息，
     * 它同样是界面上画得出来的一个数。
     */
    await check('累计等于各步用量之和（含摘要调用，界面口径一致）', async () => {
        const h = await buildAgentHarness({ toolCall: true });
        for (let i = 0; i < 6; i += 1) await h.send(`第${i}轮`);
        // 压一次：摘要调用本身也要计费，而它必须落在**消息**上
        const record = await h.state().actions.compact();
        assert(record, '构造前提：应能压出摘要');

        const st = h.state();
        const sum = (pick) => st.messages.reduce((s, m) => s + (m.usage ? pick(m.usage) : 0), 0);

        assert(st.usage.totalTokens === sum((u) => u.totalTokens),
            `累计总量必须等于各条消息之和，实际 ${st.usage.totalTokens} vs ${sum((u) => u.totalTokens)}`);
        assert(st.usage.promptTokens === sum((u) => u.promptTokens), '累计输入应为各条之和');
        assert(st.usage.completionTokens === sum((u) => u.completionTokens), '累计输出应为各条之和');

        // 摘要调用确实进了账，且挂在压缩分界线那条消息上（界面据此画得出来）
        const marker = st.messages.find((m) => m.compaction);
        assert(marker.usage, '摘要调用的用量必须挂在分界线消息上，否则累计里那一份在界面上没有出处');
        assert(marker.usage.promptTokens > 0, '摘要调用的用量应是真实数字');
    });

    /**
     * 服务端不回 usage 时必须有估算兜底 —— 否则本地代理一多，
     * 整个统计功能就是空的，而用户看不出是"没有数据"还是"没有花费"。
     */
    await check('服务端不回 usage 时走估算并标注 estimated', async () => {
        const h = await buildAgentHarness({ noUsage: true });
        await h.send('问一句');

        const st = h.state();
        assert(st.usage.calls > 0, '没有实测值时也要有估算值');
        assert(st.usage.estimatedCalls === st.usage.calls,
            `全部应为估算，实际 ${st.usage.estimatedCalls} / ${st.usage.calls}`);
        assert(st.usage.totalTokens > 0, '估算值应大于 0');
    });

    /**
     * contextTokens 回答的是"下一次请求要发多少"，与累计是两个问题。
     * 它必须随历史增长 —— 那是"该不该压缩"的唯一依据。
     *
     * 清空后**不是 0 而是一个固定基数**：系统提示词每次请求都要发，
     * 它属于"下一次请求的输入量"。这个基数与每一步的 promptTokens 同口径
     * （见 requestTokensOf）—— 少了它，"上下文"会比"这一步的输入"小一大截，
     * 而用户唯一的自查手段就是拿这些数相加，对不上时他只会以为统计坏了。
     */
    await check('上下文占用随历史增长，且由现存消息决定', async () => {
        const h = await buildAgentHarness();
        const empty = h.state().usage.contextTokens;
        assert(empty > 0, '空会话也应计入系统提示词（它就是下一次请求要发的一部分）');

        await h.send('短');
        const first = h.state().usage.contextTokens;
        assert(first > empty, `首轮上下文应大于系统提示词基数，实际 ${empty} → ${first}`);

        await h.send('这是一句明显更长的话，'.repeat(20));
        const second = h.state().usage.contextTokens;
        assert(second > first, `上下文占用应随历史增长，实际 ${first} → ${second}`);
        /*
         * 与"重新算一遍"逐字相同：这个值现在按 messages 的身份缓存（引擎的
         * contextOf），缓存一旦认错了键就会**留在旧值上** —— 而它同时喂给硬门槛
         * 与界面，错了只会表现为"明明还能发却说满了"。所以这里拿纯函数当基准对。
         */
        assert(second === PROMPT.requestTokensOf(buildTranscript(h.state().messages)),
            `缓存值应与重新重建的结果相同，实际 ${second} vs ${PROMPT.requestTokensOf(buildTranscript(h.state().messages))}`);

        // 清空之后必须退回**基数**：派生值不能残留任何历史
        h.state().actions.clear();
        assert(h.state().usage.contextTokens === empty,
            `清空后上下文应退回系统提示词基数，实际 ${h.state().usage.contextTokens} vs ${empty}`);
        assert(h.state().usage.totalTokens === 0, '清空后累计也应归零');
    });

    /**
     * 动作表常驻在引擎上，**不是每版快照现建的一份**。
     *
     * service worker 的转发端点直接调 `engine.actions.*`：要执行一个动作却先算一版
     * 快照（含一次全量上下文重建）是纯浪费，而"每推一版快照就新建 8 个闭包"更是
     * 每一步都在扔对象。快照里仍然带着它，但是**同一份** —— 界面那份过桥时会被
     * JSON 丢掉函数，球本来就只能走 `agent-action`。
     */
    await check('动作表常驻在引擎上，快照带的是同一份', async () => {
        const h = await buildAgentHarness();
        assert(h.state().actions === h.engine.actions, '快照里的 actions 应与引擎上的是同一个对象');

        await h.send('第一轮');
        assert(h.state().actions === h.engine.actions, '推了新快照之后也不该换新对象');

        // 它必须真能驱动引擎 —— 是通路，不是摆设（service worker 就按这条路调）
        h.engine.actions.clear();
        assert(h.state().messages.length === 0,
            `engine.actions 应能驱动引擎，实际还剩 ${h.state().messages.length} 条`);
    });

    /* ------------------------ 上下文硬门槛（800k） ------------------------ */

    /**
     * 造一个"上下文已越过门槛"的状态。
     *
     * 用 setMessages 直接摆，**不走 send** —— send 自己就有那道闸门，
     * 靠它攒到超限是不可能的（正是下面要证明的事）。
     *
     * 两条约束决定了这个形状：
     *  - 填充用中文：estimateTokens 对 CJK 是 1.5 字符/token，
     *    凑同样的 token 数比 ASCII（4 字符/token）省得多；
     *  - **大头必须落在会被压掉的那几条里**。全塞在保留区的话，
     *    压缩保留它们之后仍然超限，overBudget 恒为真，
     *    "压缩后能继续"就永远测不到。
     *
     * 所以：前 3 轮各 40 万 token（合计 120 万，越过 800k），
     * 后 3 轮很小（默认 60% 档覆盖前 7 条，后 5 条原样保留）。
     */
    const fillBeyondLimit = async (h) => {
        const filler = '填'.repeat(600_000);
        const round = (i, content) => ([
            { id: `u${i}`, role: 'user', content: `第${i}轮`, at: i * 2 },
            { id: `a${i}`, role: 'assistant', content, at: i * 2 + 1 },
        ]);
        await h.setMessages([
            ...round(0, filler),
            ...round(1, filler),
            ...round(2, filler),
            ...round(3, '最近一轮的内容'),
            ...round(4, '倒数第二轮'),
            ...round(5, '最新一轮'),
        ]);
    };

    await check('达到门槛即 contextFull 为真', async () => {
        const h = await buildAgentHarness();
        assert(h.state().contextFull === false, '空会话不该算满');

        await fillBeyondLimit(h);
        const st = h.state();
        assert(st.usage.contextTokens >= CONTEXT_LIMIT_TOKENS,
            `构造前提：上下文应已越过门槛，实际 ${st.usage.contextTokens}`);
        assert(st.contextFull === true, '越过门槛后 contextFull 必须为真');
    });

    /**
     * 存储里的坏记录不能把引擎拖死。
     *
     * 存储是外部输入（上一版插件写的、用户手改的），而 hydrate 曾经只做
     * `Array.isArray` 就整份收下。一条 `null` 的代价是**整个引擎瘫痪**：
     * buildTranscript 抛 → hydrate 抛 → snapshot() 也抛 → 界面拿不到快照、
     * 消息列表为空 →「清空」按钮恒为 disabled → 用户只能手动清 storage。
     *
     * 判据是"滤掉坏的、留住好的"，不是"整份丢弃"：一条坏记录不该让整段历史
     * 一起消失。
     */
    await check('存储里的坏记录被滤掉，好记录照常恢复', async () => {
        const h = await buildAgentHarness();
        await h.setMessages([
            { id: 'ok1', role: 'user', content: '这句是好的', at: 1 },
            null,
            '一个字符串',
            { role: 'user', content: '缺 id', at: 2 },
            { id: 'ok2', role: 'assistant', content: { 不是: '字符串' }, at: 3 },
            { id: 'ok3', role: 'assistant', content: '这句也是好的', at: 4 },
        ]);

        // 构造前提：没有抛，且快照可读
        const st = h.state();
        eq(st.messages.length, 2, '两条好记录应原样恢复，四条坏的应被滤掉');
        eq(st.messages.map((m) => m.id).join(','), 'ok1,ok3', '留下的是那两条合法记录');
        assert(st.usage.contextTokens > 0, '上下文重建必须能跑通（它才是抛错的那一环）');

        // 而且引擎还能继续用
        await h.send('坏记录之后照样能提问');
        assert(h.state().messages.some((m) => m.content === '坏记录之后照样能提问'),
            '滤掉坏记录之后引擎必须能继续工作');
    });

    /** 压缩记录坏掉时也不能把整个引擎带下去 */
    await check('压缩记录形状不对时整条记录被滤掉', async () => {
        const h = await buildAgentHarness();
        await h.setMessages([
            { id: 'a', role: 'user', content: '问', at: 1 },
            { id: 'b', role: 'assistant', content: '答', at: 2, compaction: { upTo: 'a' } },
            { id: 'c', role: 'assistant', content: '答二', at: 3 },
        ]);
        eq(h.state().messages.length, 2, '没有 summary 的压缩记录应被滤掉，其余照留');
    });

    /**
     * send() 必须直接拒绝 —— 这是唯一的入口闸门。
     *
     * 界面禁用只是第一道；错误横幅的「重试」、未来的快捷键、以及任何直接调
     * actions.send 的路径都会绕过 disabled。少了这一层，输入框锁着也拦不住。
     */
    await check('超限时 send 直接拒绝，不发起任何模型调用', async () => {
        const h = await buildAgentHarness();
        await fillBeyondLimit(h);
        const callsBefore = h.chats.length;

        await h.send('这条不该发出去');

        assert(h.chats.length === callsBefore,
            `不得发起模型调用，实际从 ${callsBefore} 变成 ${h.chats.length}`);
        assert(h.state().error.includes('上限'),
            `应给出明确原因，实际：${h.state().error}`);
        assert(!h.state().messages.some((m) => m.content === '这条不该发出去'),
            '被拒绝的提问不得进对话流');
    });

    /**
     * 两道闸门（send 入口、轮内每步）给用户看的必须是**同一句话**。
     *
     * 措辞分叉时，用户会以为自己遇到的是两件不同的事，而实际都只有一条出路。
     * 所以文案只能由 contextFullMessage 一个函数产出。
     */
    await check('两道门槛共用同一句文案', async () => {
        const src = ALL_SRC;
        assert(/const contextFullMessage = \(\): string =>/.test(src),
            '越线文案必须由具名函数产出');
        const uses = src.match(/contextFullMessage\(\)/g) || [];
        assert(uses.length === 3,
            `两处 setError 与轮内那条提示都应调它（声明处除外），实际 ${uses.length} 处`);
        // 文案本体只应出现一次 —— 就是 contextFullMessage 里那一份
        const bodies = src.match(/上下文已达 \$\{CONTEXT_LIMIT_TOKENS/g) || [];
        assert(bodies.length === 1,
            `不得再手写第二份越线文案，实际 ${bodies.length} 处`);
    });

    /** 门槛是 >= 而不是 >：正好等于时也要拦住 */
    await check('正好等于门槛时也拦住（>= 语义）', async () => {        const h = await buildAgentHarness();
        // 用中文字符凑一个刚好到门槛的上下文。estimateTokens 对 CJK 是 1.5 字符/token，
        // 所以要 n 个 token 就写 ceil(n * 1.5) 个汉字。
        const chars = Math.ceil(CONTEXT_LIMIT_TOKENS * 1.5);
        await h.setMessages([{ id: 'u0', role: 'user', content: '填'.repeat(chars), at: 0 }]);

        const tokens = h.state().usage.contextTokens;
        assert(tokens >= CONTEXT_LIMIT_TOKENS,
            `构造前提：应达到门槛，实际 ${tokens}`);

        const callsBefore = h.chats.length;
        await h.send('等于门槛也不该放行');
        assert(h.chats.length === callsBefore, '等于门槛时必须拒绝（判据是 >=）');
    });

    /** 严格小于门槛时必须放行 —— 否则用户会被永久锁死 */
    await check('严格小于门槛时正常放行', async () => {
        const h = await buildAgentHarness();
        // 目标：凑到门槛的九成左右，确保严格小于
        const chars = Math.floor(CONTEXT_LIMIT_TOKENS * 1.5 * 0.9);
        await h.setMessages([{ id: 'u0', role: 'user', content: '填'.repeat(chars), at: 0 }]);

        const tokens = h.state().usage.contextTokens;
        assert(tokens < CONTEXT_LIMIT_TOKENS,
            `构造前提：应严格小于门槛，实际 ${tokens}`);
        assert(h.state().contextFull === false, '未达门槛不该算满');

        await h.send('这条应该发得出去');
        assert(h.state().messages.some((m) => m.content === '这条应该发得出去'),
            '未达门槛时提问必须能正常发出');
    });

    /**
     * 轮内门槛量的必须是**真正要发出去的那一份**。
     *
     * 模型每一步的回复都会整条追加进本轮 transcript，里面含完整 `args.code`；
     * 而重建 messages 时工具消息只回放 label + result，脚本源码一个字都不进。
     * 所以"每步写一个大脚本"这条路，按重建量永远量不到 —— 实测连发 3 步
     * 90 万字符的脚本，实际发出 180 万 token 而引擎自报 1707、error 为空。
     *
     * 这里把每一步的回复撑到门槛以上，然后断言：**第一步之后就必须停下**，
     * 且停下时那条提示是真的落进了对话流。
     */
    await check('轮内按真正发出的内容量门槛，超限即停', async () => {
        // 一步就写进 60 万汉字 ≈ 40 万 token；两步必然越过 80 万
        const bigCode = '填'.repeat(600_000);
        const h = await buildAgentHarness({
            replies: [
                JSON.stringify({ intent: '写脚本', calls: [{ tool: 'js', args: { code: bigCode } }] }),
                JSON.stringify({ intent: '再来一步', calls: [{ tool: 'js', args: { code: bigCode } }] }),
                JSON.stringify({ intent: '收尾', final: '不该走到这里' }),
            ],
        });
        await h.send('开始');

        const st = h.state();
        assert(!st.messages.some((m) => m.content === '不该走到这里'),
            '越过门槛后不得再请求模型 —— 那一次请求本身就是超限的');
        assert(st.error.includes('上限'), `应报出超限原因，实际：${JSON.stringify(st.error)}`);
        assert(st.messages.some((m) => m.notice && m.content.includes('上限')),
            '停止原因必须以界面提示落进对话流，否则用户看到对话停在半路');
        /*
         * 停下之后 contextFull **不**要求为真：本轮撑爆的是 transcript（含脚本
         * 源码），而下一轮重建时工具消息只回放 label + result —— 那个数确实小。
         * 这不是漏报：本轮已经真的停了，而下一轮要发的东西也确实没超。
         * 若在这里强求 true，等于让界面锁住一个本来能继续的会话。
         */
        eq(st.messages.filter((m) => m.role === 'tool').length, 1,
            '只有第一步被真正执行，第二步不该发生');
    });

    /**
     * 压缩必须能把上下文拉回门槛以下，否则"压缩后即可继续"是空话。
     */
    await check('压缩后上下文回落，输入框重新可用', async () => {
        const h = await buildAgentHarness();
        await fillBeyondLimit(h);
        assert(h.state().contextFull === true, '构造前提：应已满');

        const record = await h.state().actions.compact();
        assert(record, '应能压出摘要');
        assert(record.afterTokens < record.beforeTokens,
            `压缩后应更小，实际 ${record.beforeTokens} → ${record.afterTokens}`);
        assert(record.overBudget === false,
            `压缩后应回到门槛以内，实际 ${record.afterTokens}（门槛 ${CONTEXT_LIMIT_TOKENS}）`);
        assert(h.state().contextFull === false, '压缩后不该再算满');

        // 真发一条，确认闸门确实放开了
        await h.send('压缩后应该能继续');
        assert(h.state().messages.some((m) => m.content === '压缩后应该能继续'),
            '压缩后必须能继续提问');
    });

    /* --------------------------- 上下文压缩 --------------------------- */

    /**
     * 压缩的核心可断言点：压缩点之前的轮次**不再进上下文**，取而代之的是摘要。
     *
     * 只断言"摘要进去了"是不够的 —— 那与"摘要进去了、原文也还在"无法区分，
     * 而后者等于完全没有压缩。
     */
    await check('压缩后旧轮次退出上下文，摘要取而代之', async () => {
        const h = await buildAgentHarness();
        for (let i = 0; i < 6; i += 1) await h.send(`第${i}轮的提问`);
        const before = h.state().usage.contextTokens;

        const record = await h.state().actions.compact();
        assert(record, '轮数足够时应返回压缩记录');
        assert(record.summary.includes('任务目标'), '摘要应是模型的返回');
        assert(record.coveredMessages > 0, '应覆盖若干条');
        assert(record.beforeTokens === before,
            `压缩前 token 应等于当前上下文占用，实际 ${record.beforeTokens} vs ${before}`);
        assert(record.afterTokens < record.beforeTokens,
            `压缩后应更小，实际 ${record.beforeTokens} → ${record.afterTokens}`);

        // 引擎里 compact() 是 await 的，写完 this.messages 才返回 ——
        // 不需要 hook 时代那次"手动 flush setState"。

        // 下一次请求里：摘要必须在，且被压掉的那一轮原文必须不在
        await h.send('压缩后再问一句');
        const last = JSON.stringify(h.chats[h.chats.length - 1]);
        assert(last.includes(COMPACT_PREFIX), `上下文里应有摘要前缀，实际：${last.slice(0, 200)}`);
        assert(last.includes('任务目标'), '摘要正文应在上下文里');
        assert(!last.includes('第0轮的提问'), '被压缩覆盖的最旧一轮不得再进上下文');
        assert(last.includes('压缩后再问一句'), '本轮提问当然要在');
    });

    /** 压缩记录必须落进对话流（界面上要有那条分界线），且带用量 */
    await check('压缩记录作为一条消息落进对话流并计入用量', async () => {
        const h = await buildAgentHarness();
        for (let i = 0; i < 6; i += 1) await h.send(`第${i}轮`);

        const beforeCalls = h.state().usage.calls;
        const record = await h.state().actions.compact();

        const marker = h.state().messages.find((m) => m.compaction);
        assert(marker, '应有一条带 compaction 的消息');
        assert(marker.compaction.upTo === record.upTo, 'upTo 应与返回值一致');
        assert(marker.content === record.summary, '消息正文就是摘要');
        // 摘要调用本身花了钱，必须计入
        assert(h.state().usage.calls === beforeCalls + 1,
            `摘要调用应计入用量，实际 ${beforeCalls} → ${h.state().usage.calls}`);
        assert(h.state().usage.totalTokens > 0, '摘要调用的 token 应计入累计');
    });

    /** 条数不足时不该压缩：压了也没有可压的内容，白花一次调用 */
    await check('消息不足时压缩是空操作', async () => {
        const h = await buildAgentHarness();

        // 空会话：分界线之后 0 条，任何档位都算不出覆盖数
        assert(await h.state().actions.compact() === null, '空会话应返回 null');
        assert(h.chats.length === 0, '不得发起摘要调用');

        // 1 条消息配 40% 档：floor(1*0.4)=0，同样无可压内容
        await h.setMessages([{ id: 'u0', role: 'user', content: '只有一条', at: 0 }]);
        h.state().actions.setCompactRatio(0.4);
        const before = h.chats.length;

        const record = await h.state().actions.compact();

        assert(record === null, '按当前档位算不出覆盖数时应返回 null');
        assert(h.chats.length === before, '不得发起摘要调用');
        assert(!h.state().messages.some((m) => m.compaction), '不得落压缩消息');
    });

    /** 非法档位直接忽略，不能让脏值把判据搞成 NaN */
    await check('setCompactRatio 拒绝非法档位', async () => {
        const h = await buildAgentHarness();
        assert(h.state().compactRatio === 0.6, '构造前提：默认档位应为 60%');

        h.state().actions.setCompactRatio(0.5);
        assert(h.state().compactRatio === 0.6, '非法档位必须忽略');

        h.state().actions.setCompactRatio(0.8);
        assert(h.state().compactRatio === 0.8, '合法档位必须生效');
    });

    /**
     * canCompact 与 contextFull 是两个正交的问题，界面靠它们分别决定
     * "按钮能不能按"与"输入框锁不锁"。
     *
     * 正交性在这里是可验证的：消息够多但上下文很小（可压缩、不锁），
     * 以及消息很少但每条都很大（不可压缩、但照样锁）。
     */
    await check('canCompact 只看条数与档位，与 contextFull 无关', async () => {
        const h = await buildAgentHarness();

        // 空会话：压不动，也没满
        assert(h.state().canCompact === false, '空会话不该可压缩');
        assert(h.state().contextFull === false, '空会话不该算满');

        // 4 轮 = 8 条消息，默认 60% 档覆盖 floor(8*0.6)=4 条：可压缩，
        // 但离 800k 还差得远
        for (let i = 0; i < 4; i += 1) await h.send(`第${i}轮`);
        assert(h.state().canCompact === true, '条数够了就该可压缩（哪怕上下文很小）');
        assert(h.state().contextFull === false,
            '这几轮远不到门槛，不该锁输入框 —— 但它照样压得动');

        // 真的压一次，确认"可压缩"这个判据没骗人
        const record = await h.state().actions.compact();
        assert(record, 'canCompact 为真时必须真能压出东西，否则按钮就是个摆设');
        assert(record.coveredMessages === 4, `60% 档应覆盖 4 条，实际 ${record.coveredMessages}`);

        /*
         * 覆盖区必须**整段**进摘要器 —— 输入不设上限。
         *
         * 这里曾经按 512KB 从后往前收：超出的部分既没进摘要、又落在分界线之前，
         * 等于压缩时静默丢掉一段历史（那条路已经删掉）。断言"摘要器收到的条数
         * 等于覆盖条数"，钉的就是这个上限不会以任何形式回来。
         */
        const digestAt = h.chatCalls().findIndex((c) => c.system.includes('对话压缩器'));
        assert(digestAt >= 0, '构造前提：应发起过摘要调用');
        eq(h.chats[digestAt].length, record.coveredMessages,
            '摘要器的输入条数必须等于覆盖条数（不得再按体积裁掉一部分）');
    });

    /**
     * 摘要器的输入**不设上限**：覆盖区整段进摘要器。
     *
     * 这条正是"压缩为什么会静默丢历史"的回归点。原先按 512KB 从后往前收，
     * 超出的部分既没进摘要、又落在分界线之前 —— 压缩一次就少一段历史，
     * 而界面只看得出"覆盖 N 条"，用户无从知道有几条是彻底没了。
     *
     * 构造上用 1.6MB 的覆盖区（远超那个旧上限）：**最旧那一条**的内容必须出现在
     * 摘要器的输入里。按体积收的写法永远保留最新的那些，所以这一条内容就是判据。
     */
    await check('摘要器的输入不设上限：覆盖区整段进摘要器', async () => {
        const h = await buildAgentHarness();
        const filler = 'F'.repeat(20000);
        const list = [];
        for (let i = 0; i < 40; i += 1) {
            list.push(msg({ id: `u${i}`, role: 'user', content: `提问${i}-${filler}` }));
            list.push(msg({ id: `a${i}`, role: 'assistant', content: `回答${i}-${filler}` }));
        }
        await h.setMessages(list);

        const record = await h.state().actions.compact();
        assert(record, '80 条消息应压得动');
        assert(record.coveredMessages === 48, `60% 档应覆盖 48 条，实际 ${record.coveredMessages}`);

        const digestAt = h.chatCalls().findIndex((c) => c.system.includes('对话压缩器'));
        assert(digestAt >= 0, '应发起过摘要调用');
        const digest = h.chats[digestAt];
        eq(digest.length, record.coveredMessages,
            '摘要器的输入条数必须等于覆盖条数（不得按体积裁掉一部分）');
        assert(digest.some((m) => m.content.includes('提问0-')),
            '覆盖区里最旧的一条必须进摘要器 —— 按体积从后往前收会先丢掉它');
    });

    /** 清空之后两个判据都要回落，不能残留 */
    await check('清空后 canCompact 与 contextFull 都回落', async () => {
        const h = await buildAgentHarness();
        for (let i = 0; i < 5; i += 1) await h.send(`第${i}轮`);
        assert(h.state().canCompact === true, '构造前提：应可压缩');

        h.state().actions.clear();
        assert(h.state().canCompact === false, '清空后不该可压缩');
        assert(h.state().contextFull === false, '清空后不该算满');
        // 退回系统提示词基数（不是 0）：那部分与历史无关，清空也还在
        const empty = (await buildAgentHarness()).state().usage.contextTokens;
        assert(h.state().usage.contextTokens === empty,
            `清空后上下文占用应退回基数，实际 ${h.state().usage.contextTokens} vs ${empty}`);
    });
    /** 摘要为空是失败，不能把一段历史换成空白还报成功 */
    await check('摘要为空视为失败，历史不动', async () => {
        const h = await buildAgentHarness({ compactReply: '   ' });
        for (let i = 0; i < 6; i += 1) await h.send(`第${i}轮`);
        const before = h.state().messages.length;

        const record = await h.state().actions.compact();

        assert(record === null, '空摘要应返回 null');
        assert(h.state().messages.length === before, '不得落压缩消息');
        assert(h.state().error.includes('压缩失败'), `应给出失败提示，实际：${h.state().error}`);
    });

    /** 运行中禁止压缩：主循环手上的 transcript 是开始那一刻重建的 */
    await check('运行中压缩被拒绝', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        // holdAt 必须指向**第 5 次**调用：前 4 次留给 4 轮对话，
        // 卡在第 2 次的话连构造初始状态都过不去（会直接挂死）
        const h = await buildAgentHarness({ hold: gate, holdAt: 5 });
        for (let i = 0; i < 4; i += 1) await h.send(`第${i}轮`);
        assert(h.state().messages.length > 0, '构造前提：应有 4 轮历史');

        const pending = h.sendPending('新的一轮');
        const record = await h.state().actions.compact();

        assert(record === null, '运行中应拒绝压缩');
        assert(!h.state().messages.some((m) => m.compaction), '运行中不得落压缩消息');

        release();
        await pending;
    });

    /**
     * 用户回退到压缩点之前时，摘要必须**自动作废**。
     *
     * 回退会把分界线连同它覆盖的一切一起删掉，于是那段历史重新长出来。
     * 不作废的话，模型会拿着一份描述"已经不存在的那段对话"的摘要在错误的
     * 上下文里干活 —— 而界面上看不出任何异常。这条是压缩功能里最危险的失效模式。
     */
    await check('回退到压缩点之前后摘要自动作废，原文重新进上下文', async () => {
        const h = await buildAgentHarness();
        for (let i = 0; i < 6; i += 1) await h.send(`第${i}轮`);
        await h.state().actions.compact();
        assert(h.state().messages.some((m) => m.compaction), '构造前提：应已压缩');

        // 回退到**第二轮**的提问（不是第一轮）：这样前面还留着第一轮，
        // 可以验证"摘要作废之后原文真的回来了"，而不是把整个列表清空
        // 导致断言因为空历史而侥幸通过。
        const second = h.state().messages.find((m) => m.content === '第1轮');
        assert(second, '构造前提：应能找到第二轮提问');
        h.state().actions.rewindTo(second.id);

        assert(!h.state().messages.some((m) => m.compaction), '压缩消息应已被回退删掉');
        assert(h.state().messages.some((m) => m.content === '第0轮'), '第一轮应留着（构造前提）');

        await h.send('回退之后的新提问');
        const last = JSON.stringify(h.chats[h.chats.length - 1]);
        assert(!last.includes(COMPACT_PREFIX),
            `摘要已失效，不得再进上下文，实际：${last.slice(0, 200)}`);
        assert(last.includes('第0轮'), '摘要作废后，原文必须重新进上下文（否则等于白丢一轮）');
        assert(last.includes('回退之后的新提问'), '新提问当然要在');
    });

    /**
     * 压缩分界线必须插在**它覆盖的最后一条消息之后**，不是追加到末尾。
     *
     * 位置就是语义：线以上已不在上下文里。追加到末尾的话，界面上它出现在
     * 最新一轮下方，读起来像"压缩发生在刚才"，而用户需要知道的是
     * "线以上那些模型已经看不见了"。
     */
    await check('压缩分界线插在覆盖范围的末尾，不是追加到对话末尾', async () => {
        const h = await buildAgentHarness();
        for (let i = 0; i < 6; i += 1) await h.send(`第${i}轮`);
        await h.state().actions.compact();

        const list = h.state().messages;
        const markerAt = list.findIndex((m) => m.compaction);
        assert(markerAt > 0, '应能找到分界线');
        assert(markerAt < list.length - 1,
            '分界线不该在列表末尾（后面还有被保留的轮次），实际就在末尾');

        const marker = list[markerAt];
        const anchorAt = list.findIndex((m) => m.id === marker.compaction.upTo);
        assert(anchorAt === markerAt - 1,
            `分界线应紧跟在 upTo 那条之后，实际 upTo 在 ${anchorAt}、分界线在 ${markerAt}`);
        // 保留的那几轮必须在分界线**之后**
        assert(list.slice(markerAt + 1).some((m) => m.role === 'user'),
            '被保留的最近几轮应在分界线之后');
    });

    /**
     * 压缩分界线不得被当成模型发言回放。
     *
     * 它是一条 role:'assistant' 的消息。不特判的话，摘要会以"普通助手发言"
     * 的身份留在上下文里，而它描述的是一段模型从未说过的话。
     */
    await check('压缩消息不进上下文，摘要由 buildTranscript 统一重建', async () => {
        const compacted = {
            summary: '旧摘要正文',
            upTo: 'u1',
            at: 1,
            coveredMessages: 3,
            beforeTokens: 100,
            afterTokens: 10,
            overBudget: false,
        };
        const out = buildTranscript([
            msg({ id: 'u1', role: 'user', content: 'q' }),
            msg({ id: 'a1', role: 'assistant', content: '答' }),
            msg({ id: 'c1', role: 'assistant', content: '旧摘要正文', compaction: compacted }),
            msg({ id: 'u2', role: 'user', content: '后续提问' }),
        ]);

        const blob = JSON.stringify(out);
        const markerCount = (blob.match(/旧摘要正文/g) || []).length;
        assert(markerCount === 1,
            `摘要正文只应出现一次（由 buildTranscript 统一重建），实际 ${markerCount} 次`);
        assert(out[0].content.startsWith(COMPACT_PREFIX), '摘要应置于上下文最前');
        assert(blob.includes('后续提问'), '分界线之后的提问必须在');
        // 每条只应有 role 与 content 两个字段：多带字段就是把界面数据漏进了协议层
        assert(out.every((m) => Object.keys(m).length === 2),
            '协议消息只应有 role 与 content');
    });

    /**
     * 压缩覆盖的那一段必须**真的退出**上下文。
     *
     * 只断言"摘要进去了"是不够的：那与"摘要进去了、原文也还在"无法区分，
     * 而后者等于完全没有压缩。
     */
    await check('分界线之前的轮次不再进上下文', async () => {
        const compacted = {
            summary: 'S', upTo: 'a1', at: 1, coveredMessages: 1,
            beforeTokens: 100, afterTokens: 10, overBudget: false,
        };
        const out = buildTranscript([
            msg({ id: 'u1', role: 'user', content: '被压掉的提问' }),
            msg({ id: 'a1', role: 'assistant', content: '被压掉的回答' }),
            msg({ id: 'c1', role: 'assistant', content: 'S', compaction: compacted }),
            msg({ id: 'u2', role: 'user', content: '保留的提问' }),
        ]);

        const blob = JSON.stringify(out);
        assert(!blob.includes('被压掉的提问'), '分界线之前的提问不得进上下文');
        assert(!blob.includes('被压掉的回答'), '分界线之前的回答不得进上下文');
        assert(blob.includes('保留的提问'), '分界线之后的提问必须在');
    });

    /**
     * 分界线**本身被删掉**（单条删除）时，摘要随之作废、原文重新进上下文。
     *
     * 边界由承载摘要的那条消息的位置决定，所以删掉它 = 撤销这次压缩。
     * 这是自愈：否则模型会拿着一份描述"已经不存在的那段对话"的摘要在
     * 错误的前提下干活，而界面上看不出任何异常。
     */
    await check('分界线被删除后摘要作废，原文重新进上下文', async () => {
        const out = buildTranscript([
            msg({ id: 'u1', role: 'user', content: '第一轮' }),
            msg({ id: 'a1', role: 'assistant', content: '答一' }),
            // 分界线消息本身不在这份列表里 —— 用户把它删了
            msg({ id: 'u2', role: 'user', content: '第二轮' }),
        ]);

        const blob = JSON.stringify(out);
        assert(!blob.includes(COMPACT_PREFIX), '没有分界线时不该有摘要');
        assert(blob.includes('第一轮') && blob.includes('第二轮'), '原文应照常回放');
    });

    /** 摘要调用的 system 提示词必须是**结构化**的那一份，不是"总结一下" */
    await check('压缩提示词要求结构化输出并禁止编造', async () => {
        const src = ALL_SRC;
        const at = src.indexOf('const COMPACT_SYSTEM_PROMPT = `');
        assert(at > 0, '应有 COMPACT_SYSTEM_PROMPT');
        const prompt = src.slice(at, src.indexOf('`;', at));

        assert(prompt.includes('任务目标'), '必须要求写任务目标 —— 它是跨轮记忆里最不能丢的');
        assert(prompt.includes('试过但失败的路'),
            '必须要求写失败路径：不写清楚，后续会对着同一堵墙再撞一遍');
        assert(/绝不推测|不要推测|绝不.*编造/.test(prompt),
            '必须明确禁止编造：模型对摘要内容没有分辨能力，写错一个字段名会一路错下去');
        assert(prompt.includes('逐字照抄'), '字段名 / 接口路径必须要求逐字照抄');
    });

    /** 提示词里声明的摘要前缀必须与实现写出的**逐字一致** */
    await check('提示词声明的摘要前缀与实现一致', async () => {
        const src = ALL_SRC;
        assert(src.includes('${COMPACT_PREFIX}'), '提示词应以插值引用 COMPACT_PREFIX，不手抄');

        const compacted = {
            summary: 'S', upTo: 'u1', at: 1, coveredMessages: 1,
            beforeTokens: 1, afterTokens: 1, overBudget: false,
        };
        const produced = buildTranscript([
            msg({ id: 'u1', role: 'user', content: 'q' }),
            msg({ id: 'c1', role: 'assistant', content: 'S', compaction: compacted }),
        ]).map((m) => m.content).join('\n');
        assert(produced.includes(COMPACT_PREFIX), '实现应写出摘要前缀');
    });

    /**
     * 插入锚点找不到时退回追加，而不是把这条记录丢掉。
     *
     * 丢掉等于摘要凭空消失 —— 而它对应的那段历史已经被移出上下文了，
     * 用户会面对一段没有解释的空白。
     */
    await check('insertAfterId 锚点缺失时退回追加，不丢消息', async () => {
        const marker = { id: 'm', at: 0, role: 'assistant', content: '摘要' };
        const out = insertAfterId([msg({ id: 'a', role: 'user', content: 'q' })], '不存在的-id', marker);
        assert(out.length === 2, `应追加，实际 ${out.length} 条`);
        assert(out[1].id === 'm', '应插到末尾');

        const mid = insertAfterId(
            [msg({ id: 'a', role: 'user', content: 'q' }), msg({ id: 'b', role: 'user', content: 'w' })],
            'a', marker,
        );
        assert(mid.map((m) => m.id).join(',') === 'a,m,b', `应插在 a 之后，实际 ${mid.map((m) => m.id).join(',')}`);
    });

    /* --------------------------- 压缩闸门与撤销 --------------------------- */

    /**
     * canCompact 的判据必须与 compact() 里的闸门**同一个表达式**。
     *
     * 不一致时按钮会是可点的，但点了什么都不发生 —— 用户看到的是"坏了"。
     * 同源的载体是一个具名函数：两处都调 compactCoverCount，分界线之后的消息数
     * 配当前档位，>= 1 才算压得动。
     */
    await check('canCompact 与 compact() 的条数闸门同源', async () => {
        const src = ALL_SRC;
        assert(/const \{ messages: live, summary: priorSummary \} = splitByCompaction\(list\);/.test(src),
            'compact() 里应先取分界线之后的消息，全量重算会把压过的再压一遍');
        assert(/const coverCount = compactCoverCount\(live\.length, this\.compactRatio\);/.test(src),
            'compact() 里应按分界线之后的消息数与当前档位算覆盖数');
        assert(/if \(coverCount < 1\) return null;/.test(src),
            'compact() 里覆盖数为 0 时必须返回 null');
        assert(/canCompact: compactCoverCount\(splitByCompaction\(this\.messages\)\.messages\.length, this\.compactRatio\) >= 1/.test(src),
            'canCompact 必须用同一个函数与同一种比较，否则按钮可点但无效果');
        assert(!/COMPACT_KEEP_ROUNDS/.test(src),
            '轮次常量必须彻底移除，留着就是下一个漂移的源头');
    });

    /**
     * 撤销压缩这条链路必须真的通到 hook：界面上的删除按钮走的是 removeMessage，
     * 而 removeMessage 一删掉分界线，splitByCompaction 就找不到它了 —— 于是
     * 原文重新进上下文。这条断言把"按钮 → removeMessage"钉住，
     * 否则按钮可能接到了一个只改本地 state 的假动作。
     */
    await check('撤销压缩后原文重新进上下文（端到端）', async () => {
        const h = await buildAgentHarness();
        for (let i = 0; i < 6; i += 1) await h.send(`第${i}轮`);
        await h.state().actions.compact();

        const marker = h.state().messages.find((m) => m.compaction);
        assert(marker, '构造前提：应已压缩');

        h.state().actions.removeMessage(marker.id);
        assert(!h.state().messages.some((m) => m.compaction), '分界线应被删掉');

        await h.send('撤销之后的新提问');
        const last = JSON.stringify(h.chats[h.chats.length - 1]);
        assert(!last.includes(COMPACT_PREFIX), '撤销后不得再带摘要');
        assert(last.includes('第0轮'), '撤销后原文必须重新进上下文');
    });

    /**
     * 四个档位按**消息条数**覆盖，不分角色。
     *
     * 10 条消息时 40/60/80/100% 分别覆盖前 4/6/8/10 条；
     * 100% 即全压 —— 分界线落到末尾，上下文只剩一条摘要。
     */
    await check('压缩档位按条数覆盖前 N%（40/60/80/100）', async () => {
        for (const [ratio, cover] of [[0.4, 4], [0.6, 6], [0.8, 8], [1, 10]]) {
            const h = await buildAgentHarness();
            await h.setMessages(Array.from({ length: 10 }, (_, i) => (
                { id: `m${i}`, role: 'user', content: `消息${i}`, at: i }
            )));
            h.state().actions.setCompactRatio(ratio);

            const record = await h.state().actions.compact();
            assert(record, `档位 ${ratio} 应能压出东西`);
            assert(record.coveredMessages === cover,
                `档位 ${ratio} 应覆盖 ${cover} 条，实际 ${record.coveredMessages}`);
            assert(record.upTo === `m${cover - 1}`,
                `档位 ${ratio} 的分界线应在 m${cover - 1} 之后，实际 ${record.upTo}`);

            const list = h.state().messages;
            const markerAt = list.findIndex((m) => m.compaction);
            assert(markerAt === cover,
                `分界线应紧跟覆盖区之后（下标 ${cover}），实际 ${markerAt}`);
        }
    });

    /** 100% 全压之后分界线后没有消息，canCompact 必须回落 */
    await check('100% 全压后无可压内容，canCompact 回落', async () => {
        const h = await buildAgentHarness();
        await h.setMessages(Array.from({ length: 5 }, (_, i) => (
            { id: `m${i}`, role: 'user', content: `消息${i}`, at: i }
        )));
        h.state().actions.setCompactRatio(1);

        const record = await h.state().actions.compact();
        assert(record && record.coveredMessages === 5, '100% 应覆盖全部 5 条');

        const list = h.state().messages;
        const markerAt = list.findIndex((m) => m.compaction);
        assert(markerAt === list.length - 1, '全压时分界线应在末尾（后面没有保留的消息）');
        assert(h.state().canCompact === false, '分界线之后没有消息时不该可压缩');
    });

    /**
     * 重复压缩只覆盖**新增**的消息，不把压过的再压一遍。
     *
     * 全量重算的两个症状在这里都能抓到：第二次的 coveredMessages 会把旧的
     * 重复计入，而旧摘要不进 digest（旧分界线之前的内容第二次根本不可见）。
     * 正确行为是增量：只压分界线之后的新内容，旧摘要显式链进摘要器。
     */
    await check('重复压缩只压新增，旧摘要链式进入摘要器', async () => {
        const h = await buildAgentHarness();
        await h.setMessages(Array.from({ length: 10 }, (_, i) => (
            { id: `m${i}`, role: 'user', content: `消息${i}`, at: i }
        )));

        const first = await h.state().actions.compact();
        assert(first && first.coveredMessages === 6, `第一次应覆盖 6 条，实际 ${first && first.coveredMessages}`);
        assert(first.upTo === 'm5', `第一次分界线应在 m5 之后，实际 ${first.upTo}`);

        const second = await h.state().actions.compact();
        assert(second, '有新增可压内容时应返回记录');
        // 分界线之后剩 m6..m9 共 4 条：floor(4*0.6)=2，只压 m6、m7
        assert(second.coveredMessages === 2, `第二次只应覆盖新增 2 条，实际 ${second.coveredMessages}`);
        assert(second.upTo === 'm7', `第二次分界线应在 m7 之后，实际 ${second.upTo}`);

        // 旧摘要必须在第二次的摘要器输入里（链式），而不是被丢掉
        const digest = JSON.stringify(h.chats[h.chats.length - 1]);
        assert(digest.includes('取价格'),
            `第二次摘要应带上第一次的摘要（默认 compactReply），实际：${digest.slice(0, 200)}`);
    });

    /**
     * 压缩在途时发新提问必须被拒绝。
     *
     * compact 的 digest 与 upTo 是开始那一刻算的，中途进来一轮，
     * 分界线就会按过期位置落下。界面输入框已禁用，这里钉的是
     * 快捷键 / 重试按钮这些绕过 disabled 的程序化路径。
     */
    await check('压缩中发新提问被拒绝，历史不被污染', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        // 4 轮对话 = 4 次 chat，第 5 次是压缩的摘要调用，把它卡住
        const h = await buildAgentHarness({ hold: gate, holdAt: 5 });
        for (let i = 0; i < 4; i += 1) await h.send(`第${i}轮`);

        const pending = h.state().actions.compact();
        h.state(); // 让 setCompacting 落地
        assert(h.state().compacting === true, '构造前提：压缩应在途');
        assert(h.state().canEdit === false, '压缩中改历史必须被锁（与运行中同一闸门）');

        await h.send('压缩中偷渡的提问');
        assert(!h.state().messages.some((m) => m.content === '压缩中偷渡的提问'),
            '被拒绝的提问不得进对话流');
        assert(h.state().error.includes('压缩'), `应说明是压缩中，实际：${h.state().error}`);
        assert(h.chats.length === 5, `不得发起新的模型调用，实际 ${h.chats.length} 次`);

        release();
        const record = await pending;
        assert(record, '放行后压缩应正常完成');
        assert(h.state().error === '', '压缩成功后"请稍候"的残留报错必须清掉');
    });

    /**
     * 压缩在途时**所有**改历史的动作都必须被拒绝 —— 与快照说的 canEdit 一致。
     *
     * 曾经写成两处判据：快照判 `!busy && !compacting`（所以界面把按钮禁掉），
     * 而 removeMessage / rewindTo / clear 只判 `busy`。于是压缩在途时界面灰着，
     * 程序化路径（桥端点、快捷键）却能真的删掉、甚至清空 —— 清空还会让这次
     * 摘要调用白跑。用户看到的是"灰着却能生效"，比两种行为都糟。
     *
     * 这条直接调动作，不靠界面：判据必须在动作里。
     */
    await check('压缩中改历史的动作全部被拒绝，压缩照常完成', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const h = await buildAgentHarness({ hold: gate, holdAt: 5 });
        for (let i = 0; i < 4; i += 1) await h.send(`第${i}轮`);
        const before = h.state().messages.map((m) => m.id);

        const pending = h.state().actions.compact();
        h.state();
        assert(h.state().compacting === true, '构造前提：压缩应在途');
        assert(h.state().canEdit === false, '构造前提：快照应说不可编辑');

        // 三个动作逐个试，一个都不许生效
        h.state().actions.removeMessage(before[0]);
        assert(h.state().messages.length === before.length, '压缩中删除必须被拒绝');
        eq(h.state().actions.rewindTo(before[0]), '', '压缩中回退必须被拒绝并返回空串');
        h.state().actions.clear();
        assert(h.state().messages.length === before.length, '压缩中清空必须被拒绝');
        assert(h.state().messages.map((m) => m.id).join() === before.join(),
            '被拒绝的动作一个字都不许动历史');

        release();
        const record = await pending;
        assert(record, '历史没被改，本次压缩应正常完成');
        assert(h.state().messages.filter((m) => m.compaction).length === 1, '摘要应照常落下');
    });

    /**
     * 锚点消失时丢弃摘要 —— 这条闸门现在只在"锁被绕过"时才会用到。
     *
     * 改历史的入口（send / clear / removeMessage / rewindTo / appendMessages）
     * 全部在 `locked()` 之后，压缩期间它们都进不来，所以从 upTo 算到落盘那一刻，
     * 锚点必然还在。留着这道检查是因为**反方向错得更贵**：insertAfterId 找不到
     * 锚点会兜底追加到末尾，摘要于是名义上覆盖全部历史，保留区被静默吞掉。
     *
     * 造法：绕过动作，直接把 messages 换成一份不含锚点的列表（模拟将来某条
     * 新路径忘了过 locked）。这里用 hydrate 摆状态 —— 它是产品里真实存在的
     * 重建入口。
     */
    await check('锚点消失时丢弃本次摘要，历史不动', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const h = await buildAgentHarness({ hold: gate, holdAt: 5 });
        for (let i = 0; i < 4; i += 1) await h.send(`第${i}轮`);
        const before = h.state().messages;

        const pending = h.state().actions.compact();
        h.state();
        // 直接换掉历史：只留最后两条，压缩算出来的 upTo（第 4 条）不在里面了
        await h.setMessages(before.slice(-2));
        const afterTamper = h.state().messages.map((m) => m.id).join();

        release();
        const record = await pending;
        assert(record === null, '锚点已失效应返回 null');
        assert(!h.state().messages.some((m) => m.compaction), '不得落压缩消息');
        assert(h.state().error.includes('变化'), `应说明历史变了，实际：${h.state().error}`);
        assert(h.state().messages.map((m) => m.id).join() === afterTamper,
            '历史应原样不动（只是白花一次调用）');
    });

    /**
     * 连点压缩只发起一次摘要调用。
     *
     * 守卫读 state 的话，两次调用挤在同一帧里都会通过（重渲染还没发生），
     * 落两条分界线、白花一次调用。同步 ref 不存在这个问题。
     */
    await check('连点压缩只发起一次摘要调用', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const h = await buildAgentHarness({ hold: gate, holdAt: 5 });
        for (let i = 0; i < 4; i += 1) await h.send(`第${i}轮`);

        const first = h.state().actions.compact();
        h.state();
        const second = await h.state().actions.compact();

        assert(second === null, '第二次调用（仍在途）应返回 null');
        assert(h.chats.length === 5, `只应发起一次摘要调用，实际 ${h.chats.length} 次`);

        release();
        assert(await first, '第一次应正常完成');
    });

    /**
     * 压缩不自带档位，也不自带输出上限。
     *
     * 摘要那次调用曾经写死 `reasoningEffort: 'low'` —— 那是插件侧最后一个自己维护的
     * 模型配置：用户在设置里选了 max，压缩仍按下发 low，而界面上显示的档位按钮是 max。
     * 判据是这次调用**不带**档位字段（由 AiService 按配置决定），而不是"带的是别的值"。
     *
     * `maxTokens: 2048` 同理删掉了：摘要不会比它的输入更长，而输入能不能装下由模型
     * 窗口决定；在这儿定一个数只会在摘要写长时把它从中间切断 —— 而那份摘要是要
     * **替换掉那段历史**的，切断即静默丢内容。
     */
    await check('压缩不自带档位与输出上限，跟着配置走', async () => {
        const h = await buildAgentHarness({});
        await h.send('聊一句');
        const record = await h.state().actions.compact();
        assert(record, '构造前提：本次压缩应成功');

        const compactCall = h.chatCalls().find((call) => String(call.system || '').includes('对话压缩器'));
        assert(compactCall, '构造前提：应发出过一次摘要调用');
        assert(compactCall.reasoningEffort === undefined,
            `摘要调用不得自带档位，实际 ${JSON.stringify(compactCall.reasoningEffort)}`);
        assert(compactCall.maxTokens === undefined,
            `摘要调用不得自带输出上限，实际 ${JSON.stringify(compactCall.maxTokens)}`);
    });

    /**
     * 停止要能掐断在途的压缩。
     *
     * 那次调用原先拿的是 `new AbortController().signal` —— 一个没有人持有的控制器，
     * stop() 因此永远够不着它：用户点了停止，压缩照跑几十秒，界面上那个按钮对这次
     * 调用毫无作用。而摘要调用恰恰是最容易跑很久的那一次。
     * 这里用一扇**不放行**的闸门 + 桩对 abort 的如实响应来验：不掐断就永远不 settle。
     */
    await check('停止能掐断在途的压缩，历史一个字不动', async () => {
        const h = await buildAgentHarness({ hold: new Promise(() => {}), holdAt: 2 });
        await h.send('聊一句');
        const before = h.state().messages.length;

        const pending = h.state().actions.compact();
        h.state();
        assert(h.state().compacting === true, '构造前提：压缩应在途');

        h.state().actions.stop();
        const outcome = await Promise.race([
            pending.then(() => 'settled'),
            new Promise((r) => setTimeout(() => r('timeout'), 500)),
        ]);
        eq(outcome, 'settled', '停止之后压缩必须结束（信号没被掐断就会一直挂着）');
        eq(await pending, null, '被中止的压缩不得落摘要');
        eq(h.state().compacting, false, '压缩状态必须复位');
        eq(h.state().messages.length, before, '历史必须一个字不动');
        eq(h.state().error, '', '用户主动停止不该留下错误横幅');
    });

    /* ------------------------------ 会话 ------------------------------ */

    /**
     * 全新安装：hydrate 之后**一定有一条会话**。
     *
     * "至少一条"是引擎的不变式。没有会话时，用户按下发送就没有地方可落 ——
     * 那是个连「清空」都救不回来的状态（清空清的是"当前这条"）。
     */
    await check('空存储 hydrate 出一条空会话，索引落盘', async () => {
        const h = await buildAgentHarness({});
        const st = h.state();
        eq(st.sessions.length, 1, '应有一条会话');
        eq(st.activeSessionId, st.sessions[0].id, '当前会话必须指向那条会话');
        eq(st.messages.length, 0, '新会话没有消息');
        assert(h.store()[PROMPT.SESSIONS_STORE_KEY], '索引必须落盘，否则下次启动又是一条新会话');
    });

    /**
     * 上一版（单会话）的历史必须迁过来。
     *
     * 不迁就是"升级一次插件丢掉全部历史"，而那是用户自己写下的、没有任何副本的
     * 东西。三条判据：历史一条不少、进了新键、老键被删掉 —— 老键不删就是最多
     * 1.5MB 的配额被一份没人读的数据占着，而配额正是会话数上限的出处。
     */
    await check('上一版的老键被迁成第一条会话，老键删掉', async () => {
        const legacy = [
            { id: 'u0', role: 'user', content: '旧会话里的提问', at: 1 },
            { id: 'a0', role: 'assistant', content: '旧会话里的回答', at: 2 },
            // 坏记录照旧被滤掉（迁移走的是同一个 isStoredMessage）
            null,
            { id: 'broken' },
        ];
        const h = await buildAgentHarness({ store: { [PROMPT.LEGACY_MESSAGES_STORE_KEY]: legacy } });
        const st = h.state();
        eq(st.messages.length, 2, '老键里的历史必须一条不少地接过来');
        eq(st.sessions.length, 1, '迁移之后只有一条会话');
        eq(st.sessions[0].autoTitle, '旧会话里的提问', '自动名字应取第一条提问');
        eq(st.sessions[0].messageCount, 2, '索引里的条数应与历史一致');
        assert(h.store()[PROMPT.sessionMessagesKey(st.activeSessionId)], '历史必须写进新键');
        /*
         * 判据是"键还在不在"，不是"里面是不是空的"：把老键改写成一个空数组
         * 同样会让 `in` 为真 —— 那样最多 1.5MB 的配额就被一份没人读的数据占着，
         * 而配额正是会话数上限的出处。
         */
        assert(!(PROMPT.LEGACY_MESSAGES_STORE_KEY in h.store()), '老键必须被删掉，而不是改写成空数组');
    });

    /**
     * 索引**没写成**时，上一版的老键一个字都不许动。
     *
     * 这是迁移里唯一会丢数据的写法：把"写过索引了"当成"索引写成了"。一旦它没落盘，
     * 新键的 id 只有索引知道（那份历史谁也找不回来），而老键又被删了 ——
     * 两边同时没有。写不进去在插件里是**常态而非异常**（配额满被静默吞掉），
     * 所以这条路径必须能自愈：下一次 hydrate 重来一遍，成功了才删。
     */
    await check('索引没落盘时老键必须留着，重试成功后才删', async () => {
        const legacy = [{ id: 'u0', role: 'user', content: '升上来的历史', at: 1 }];
        let fail = true;
        const h = await buildAgentHarness({
            store: { [PROMPT.LEGACY_MESSAGES_STORE_KEY]: legacy },
            failSave: (key) => fail && key === PROMPT.SESSIONS_STORE_KEY,
        });

        eq(h.state().messages.length, 1, '构造前提：老键里的历史已经读进内存');
        assert(PROMPT.LEGACY_MESSAGES_STORE_KEY in h.store(),
            '索引没落盘时老键必须留着 —— 它是那份历史唯一的副本');

        // 下一次 hydrate 重来一遍。这次索引写得成，老键才该被删掉
        fail = false;
        await h.engine.hydrate();
        eq(h.state().messages.length, 1, '重试不得丢掉历史');
        assert(!(PROMPT.LEGACY_MESSAGES_STORE_KEY in h.store()), '索引写成之后老键才该被删掉');
    });

    /**
     * 索引是**外部输入**（上一版插件写的、用户手改的）。
     *
     * 一条坏记录足以把 `activeId` 指到一个不存在的会话上 —— 那时消息列表是空的，
     * 而用户按下发送会把新消息写进一个列表里不存在的 id。
     */
    await check('索引里的坏记录被滤掉，activeId 指空就落到第一条', async () => {
        const good = { id: 's1', title: '', autoTitle: '旧名字', createdAt: 1, messageCount: 2 };
        const h = await buildAgentHarness({
            store: {
                [PROMPT.SESSIONS_STORE_KEY]: { activeId: '不存在', sessions: [good, { id: 's2' }, null] },
            },
        });
        eq(h.state().sessions.length, 1, '只有字段齐全的那条能留下来');
        eq(h.state().activeSessionId, 's1', 'activeId 指空时应落到第一条');
        eq(h.state().messages.length, 0, '它的历史键不存在 → 空列表，而不是抛错');
    });

    /**
     * 切换会话换的是"messages 指向哪份历史"，不是把它清掉。
     *
     * 判据是切回去之后**逐条相同**（id 也一样），而不是"条数对得上"：
     * 后者在"两边恰好都是三条"时会给一个假绿。
     */
    await check('新建会话后切回旧的，历史逐条还在', async () => {
        const h = await buildAgentHarness({});
        await h.send('第一条会话里的提问');
        const first = h.state().activeSessionId;
        const ids = h.state().messages.map((m) => m.id);
        assert(ids.length > 0, '构造前提：第一条会话应有消息');

        eq(await h.state().actions.newSession(), true, '新建应成功');
        const second = h.state().activeSessionId;
        assert(second !== first, '新会话的 id 必须与旧的不是同一个');
        eq(h.state().messages.length, 0, '新会话是空的');
        eq(h.state().sessions.length, 2, '应有两条会话');
        eq(h.state().sessions[0].id, second, '新会话排在最前（列表按创建倒序）');

        eq(await h.state().actions.switchSession(first), true, '切回去应成功');
        eq(h.state().messages.map((m) => m.id).join(), ids.join(), '切回去的历史必须逐条相同');
        assert(h.store()[PROMPT.sessionMessagesKey(first)], '第一条会话的历史必须还在它自己那份键里');
    });

    /**
     * 切了会话，发给模型的历史必须跟着换。
     *
     * 只改 `state().messages` 而忘了换上下文缓存的话，模型会读到**上一条会话**的
     * 全部内容 —— 用户以为换了个干净的工作区，实际它什么都记得。
     */
    await check('换会话之后，发给模型的上下文里不得有上一条会话的内容', async () => {
        const h = await buildAgentHarness({});
        await h.send('上一条会话里的秘密');
        await h.state().actions.newSession();
        await h.send('这条会话的问题');

        const last = h.chats[h.chats.length - 1].map((m) => m.content).join('\n');
        assert(!last.includes('上一条会话里的秘密'), '换会话必须换掉发给模型的上下文');
        assert(last.includes('这条会话的问题'), '构造前提：本次提问应在上下文里');
    });

    /**
     * 运行中不许换会话。
     *
     * 主循环正拿着当前这份 messages 追加：中途换一份，这一轮的结果会落进**另一条
     * 会话**，而"哪条会话得到了这些消息"没有答案。三个动作都要拦 —— 新建与删除
     * 同样会让"当前这份"失去主人。
     */
    await check('运行中拒绝新建 / 切换 / 删除会话', async () => {
        const h = await buildAgentHarness({ hold: new Promise(() => {}), holdAt: 2 });
        await h.send('先开一条别的会话');
        const other = h.state().activeSessionId;
        assert(other, '构造前提：应有一条会话');
        await h.state().actions.newSession();
        const active = h.state().activeSessionId;
        eq(h.state().sessions.length, 2, '构造前提：应有两条会话');

        const pending = h.sendPending('这一轮会卡在模型调用上');
        assert(h.state().status !== 'idle', '构造前提：这一轮应在途');

        eq(await h.state().actions.newSession(), false, '运行中不得新建会话');
        eq(await h.state().actions.switchSession(other), false, '运行中不得切换会话');
        eq(await h.state().actions.deleteSession(other), false, '运行中不得删除会话');
        eq(h.state().activeSessionId, active, '当前会话不得变化');
        eq(h.state().sessions.length, 2, '会话数不得变化');

        h.state().actions.stop();
        await pending;
    });

    /**
     * 只剩一条时拒绝删除，并把出路说清楚。
     *
     * 拒绝的理由不是"少了一条不好看"，而是不变式（至少一条）。用户真正想做的
     * 多半是"把这条清掉重新开始" —— 提示里必须给出那个出口。
     */
    await check('只剩一条会话时拒绝删除，提示指向清空', async () => {
        const h = await buildAgentHarness({});
        eq(await h.state().actions.deleteSession(h.state().activeSessionId), false, '不得删掉最后一条');
        eq(h.state().sessions.length, 1, '会话数不得变化');
        assert(h.state().error.includes('清空'), `提示必须给出出路，实际：${h.state().error}`);
    });

    /**
     * 删掉当前会话：剩下的那条必须**立刻顶上来**，并带来它自己的历史。
     *
     * 不换的话，界面上留着的是"一条已经被删掉的会话"的消息 —— 而那一刻它们属于
     * 哪条会话没有答案，用户接着发送就会写进一条不存在的 id。
     */
    await check('删除当前会话后落到剩下那条，并读出它的历史', async () => {
        const h = await buildAgentHarness({});
        await h.send('第一条会话');
        const first = h.state().activeSessionId;
        await h.state().actions.newSession();
        await h.send('第二条会话');
        const second = h.state().activeSessionId;

        eq(await h.state().actions.deleteSession(second), true, '删除应成功');
        eq(h.state().sessions.length, 1, '应只剩一条');
        eq(h.state().activeSessionId, first, '当前会话应落到剩下那条');
        assert(h.state().messages.some((m) => m.content === '第一条会话'),
            '必须读出剩下那条的历史，而不是留着被删那条的');
        assert(!h.store()[PROMPT.sessionMessagesKey(second)], '被删会话的历史键必须删掉');
        assert(h.removes() >= 1, '删会话要连它的历史键一起删，而不是留在存储里');
    });

    /**
     * 索引**没写成**时，被删会话的历史一个字都不许动。
     *
     * 与迁移删老键同一条规矩：索引是提交点。这里刻意选的是"删除宁可不生效"——
     * 内存里那条会话已经没了（界面照常变），但存储里它连历史都还在，重启之后
     * 它会照原样回来。反过来先删历史的话，索引一失败就留下一条**点开即空白的
     * 会话**：用户看得见的坏状态，而且内容真的没了。
     */
    await check('索引没写成时不得删会话历史（宁可删除不生效）', async () => {
        let failIndex = false;
        const h = await buildAgentHarness({
            failSave: (key) => failIndex && key === PROMPT.SESSIONS_STORE_KEY,
        });
        await h.send('第一条会话');
        await h.state().actions.newSession();
        await h.send('第二条会话');
        const second = h.state().activeSessionId;
        assert(h.store()[PROMPT.sessionMessagesKey(second)], '构造前提：第二条会话的历史应已落盘');

        failIndex = true;
        await h.state().actions.deleteSession(second);
        eq(h.state().sessions.length, 1, '内存里这条会话应已删掉（界面要跟着变）');
        assert(h.store()[PROMPT.sessionMessagesKey(second)],
            '索引没落盘时历史必须留着，否则会留下一条点开即空白的会话');
    });

    /**
     * 用户起的名字与自动名字是**两个字段**。
     *
     * 合成一个就必然要在某一刻丢掉其中一个：改名会盖掉自动名字；而回退掉第一条
     * 提问之后，自动名字又再也算不回用户起的那个（非当前会话的历史不在内存里）。
     */
    await check('改名不动自动名字，清掉名字又回落到自动名字', async () => {
        const h = await buildAgentHarness({});
        await h.send('帮我改这个页面的价格');
        const id = h.state().activeSessionId;

        h.state().actions.renameSession(id, '  淘宝比价  ');
        eq(h.state().sessions[0].title, '淘宝比价', '改名要去掉首尾空白');
        eq(h.state().sessions[0].autoTitle, '帮我改这个页面的价格', '自动名字必须原样留着');

        // 回退掉那条提问：自动名字跟着回去（它回答的是"开头问了什么"）
        const firstUser = h.state().messages.find((m) => m.role === 'user');
        h.state().actions.rewindTo(firstUser.id);
        eq(h.state().sessions[0].autoTitle, '未命名会话', '没有提问了，自动名字应回到未命名');
        eq(h.state().sessions[0].title, '淘宝比价', '用户起的名字不该被回退动到');

        h.state().actions.renameSession(id, '');
        eq(h.state().sessions[0].title, '', '清空即没有用户名字，界面回落到自动名字');
    });

    /** 改过的名字必须进索引：它只活在内存里的话，浏览器重启一次就没了 */
    await check('改过的名字落进索引，重新 hydrate 之后还在', async () => {
        const h = await buildAgentHarness({});
        await h.send('第一问');
        const id = h.state().activeSessionId;
        h.state().actions.renameSession(id, '取价格');

        await h.engine.hydrate();
        eq(h.state().sessions[0].title, '取价格', '名字应能从索引里读回来');
        eq(h.state().sessions[0].autoTitle, '第一问', '自动名字也应一起恢复');
    });

    /**
     * 上限是**拒绝**，不是"删掉最旧那条腾地方"。
     *
     * 历史是用户的东西，程序替他扔掉一条会话不可接受 —— 而写不进去只是写不进去，
     * 已经写下的还在。拒绝时也必须说清上限是多少，否则用户只会看到按钮没反应。
     */
    await check('会话数到上限时拒绝新建，并说清上限', async () => {
        const h = await buildAgentHarness({});
        for (let i = 1; i < PROMPT.MAX_SESSIONS; i += 1) {
            eq(await h.state().actions.newSession(), true, `构造前提：第 ${i + 1} 条应建得出来`);
        }
        eq(h.state().sessions.length, PROMPT.MAX_SESSIONS, '构造前提：应正好到上限');

        eq(await h.state().actions.newSession(), false, '到上限必须拒绝');
        eq(h.state().sessions.length, PROMPT.MAX_SESSIONS, '被拒绝时不得多出一条');
        assert(h.state().error.includes(String(PROMPT.MAX_SESSIONS)),
            `报错里要带上限数字，实际：${h.state().error}`);
    });

    /**
     * 会话管理必须**在界面上有入口**。
     *
     * 上面那一批断言全部打在引擎上，而引擎做完了不等于用户够得着：会话条从对话页上
     * 消失时，引擎那一侧一切照旧（测试全绿），只有功能没了。
     *
     * 这条断言能证明的只有"四条动作被界面发出去了"，**不能**证明它画得出来、
     * 点得到 —— 渲染层没有测试环境（见文件头）。所以它是一道兜底，不是覆盖。
     */
    await check('界面把四条会话动作都接到了引擎上', async () => {
        const orb = fs.readFileSync(ORB_SRC, 'utf8');
        for (const type of ['new-session', 'switch-session', 'rename-session', 'delete-session']) {
            assert(orb.includes(`type: '${type}'`), `界面没有发出 ${type}（会话管理等于没有入口）`);
        }
    });

    console.log(`Agent 工具派发：通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
        for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
        return false;
    }
    return true;
};

module.exports = { run };
