'use strict';
/**
 * Agent 新工具（tamper / storage / tokens）的派发回归。
 *
 * 被测的是 useAgent 里真实的 dispatchTool —— 用 react 的 shim 把 hook 跑起来，
 * 不重写副本。测试打在三处容易错的地方：
 *   1. 部分更新：set 只传一类规则时，其余两类必须原样保留；
 *   2. 落盘边界：模型改规则走 applyRules（不落盘），不是 saveRules；
 *   3. tokens find 的 key 必须能写回去（cookie 用 cookie 名，不是数组下标）。
 *
 * 编译产物不含 hooks/（test tsconfig 只 include services/utils/meta），
 * 所以这里用 stripTypeScriptTypes 直接求值源码 —— 与篡改引擎测试同一套办法。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * 被测源码路径。
 *
 * 可用 AGENT_SRC 覆盖 —— 变异测试靠它指向一份**改坏的副本**，
 * 从而在不碰产品文件的前提下验证断言真的能失败。
 */
const SRC_PATH = process.env.AGENT_SRC || path.join(ROOT, 'hooks', 'useAgent.ts');
/**
 * 源码统一成 LF 再切块。
 *
 * 切片标记里带 `\n`（如 `'});\n};'`），而仓库里的文件是 CRLF 检出的 ——
 * 不归一的话 `indexOf` 永远找不到结尾，整套 dispatch 用例会以
 * "找不到 xxx 的结尾" 集体失败。那是换行符的差异，不是产品代码的问题。
 * 归一放在读取处（而不是把标记改成 CRLF），换行风格再变也不会再踩。
 */
const SRC = fs.readFileSync(SRC_PATH, 'utf8').replace(/\r\n/g, '\n');

/** 用正则切出 dispatchTool 的完整函数体（含结尾的依赖数组） */
const grabDispatch = () => {
    const start = SRC.indexOf('    const dispatchTool = useCallback(async (');
    if (start < 0) throw new Error('useAgent.ts 里找不到 dispatchTool');
    const endMarker = '    }, [deps.getActiveWebview, execActive, waitForPageReady]);';
    const end = SRC.indexOf(endMarker, start);
    if (end < 0) throw new Error('找不到 dispatchTool 的结尾');
    return SRC.slice(start, end + endMarker.length);
};

/** 同样切出三个归一化 helper */
const grabBlock = (marker, endMarker) => {
    const start = SRC.indexOf(marker);
    if (start < 0) throw new Error(`找不到 ${marker}`);
    const end = SRC.indexOf(endMarker, start);
    if (end < 0) throw new Error(`找不到 ${marker} 的结尾`);
    return SRC.slice(start, end + endMarker.length);
};

const strip = (ts) => require('module').stripTypeScriptTypes(ts, { mode: 'strip' });

/**
 * useAgent 从 utils 导入的三个 JWT 函数。
 * 直接用**编译产物**（build/utils/utils.js），不重写副本 ——
 * 否则这里测的是我对 JWT 的理解，而不是产品实现。
 */
const UTILS = require('./build/utils/utils.js');

/**
 * 抽 keepReasoning 求值（含它依赖的 truncateBytes / byteLength）。
 *
 * 这三个都是模块级纯函数，可以直接切片求值 —— 比走 hook 便宜得多，
 * 而"推理有没有被保留"这件事本来就只取决于它们。
 */
const loadKeepReasoning = () => {
    const grab = (marker, endMarker) => {
        const start = SRC.indexOf(marker);
        if (start < 0) throw new Error(`useAgent.ts 里找不到 ${marker}`);
        const end = SRC.indexOf(endMarker, start);
        if (end < 0) throw new Error(`找不到 ${marker} 的结尾`);
        return SRC.slice(start, end + endMarker.length);
    };

    const code = [
        'const REASONING_LIMIT_BYTES = 32768;',
        grab('const byteLength = (text: string): number =>', ';'),
        grab('const truncateBytes = (', '\n};'),
        grab('export const keepReasoning = (raw: string): string | undefined =>', '\n};'),
    ].join('\n');

    const js = strip(code).replace('export const keepReasoning', 'const keepReasoning');
    return new Function(`${js}\nreturn { keepReasoning };`)().keepReasoning;
};

const keepReasoning = loadKeepReasoning();

/**
 * 抽 buildTranscript 求值（含它依赖的 takeRecentRoundGroups / splitRounds 等）。
 *
 * 同样切片求值而不是走 hook：这个函数是**纯的**，而它要防的是
 * 「模型看不到上一轮」这种整轮失忆 —— 直接对输入输出下断言最省事也最硬。
 *
 * 常量从源码里抓真实值，不在测试里重写一遍：重写的话产品改了门槛、
 * 测试却仍按旧值断言，行为变化就漏过去了。
 */
const loadBuildTranscript = () => {
    const grab = (marker, endMarker) => {
        const start = SRC.indexOf(marker);
        if (start < 0) throw new Error(`useAgent.ts 里找不到 ${marker}`);
        const end = SRC.indexOf(endMarker, start);
        if (end < 0) throw new Error(`找不到 ${marker} 的结尾`);
        return SRC.slice(start, end + endMarker.length);
    };

    const code = [
        // 上下文硬门槛：断言"到门槛就拦住"时要用真实值，不能在测试里重写。
        // 它是 export const（界面也要用），所以不能走 constOf。
        SRC.match(/export const CONTEXT_LIMIT_TOKENS = [0-9_]+;/)[0].replace('export ', ''),
        // 压缩摘要的前缀：buildTranscript 用它拼摘要消息，测试要按同一个
        // 字面量断言，不能在这里重写一份
        SRC.match(/const COMPACT_PREFIX = '[^']*';/)[0],
        // 这四项是 buildTranscript 的直接依赖。
        // takeRecentRoundGroups / byteLength / truncateBytes 都不再需要：
        // buildTranscript 已不裁剪，测试里也不该抽用不到的代码进来
        grab('const splitRounds = (', '\n};'),
        grab('const roundToMessages = (', '\n};'),
        grab('const splitByCompaction = (', '\n};'),
        grab('const buildTranscript = (', '\n};'),
        // insertAfterId 单独测（压缩分界线的插入位置），与 buildTranscript 无依赖关系
        grab('const insertAfterId = (', '\n};'),
    ].join('\n');

    const js = strip(code);
    return new Function(`${js}\nreturn { buildTranscript, insertAfterId, COMPACT_PREFIX, CONTEXT_LIMIT_TOKENS };`)();
};

const { buildTranscript, insertAfterId, COMPACT_PREFIX, CONTEXT_LIMIT_TOKENS } = loadBuildTranscript();

/* -------------------------------------------------------------------------- */
/*                        端到端 harness：真跑 useAgent                        */
/* -------------------------------------------------------------------------- */

/**
 * 把真实的 useAgent 求值出来并挂到一套最小 React shim 上。
 *
 * 为什么要走这一步：跨轮上下文的关键一环是 `messagesRef` 与 messages 的同步，
 * 它既不在 buildTranscript 里（纯函数测不到），也不是任何一条静态断言能覆盖的
 * —— 漏掉那个 useEffect 时，buildTranscript 永远收到空数组，而纯函数用例全绿。
 *
 * 不用真 React：测试套件是零依赖的 node 脚本（连 react 都没装进 dependencies），
 * 而这里需要的只是"重渲染 + effect + 依赖比较"这三件事。
 */
const buildAgentHarness = (options = {}) => {
    const chats = [];
    const store = {};
    // 播种已保存脚本：走真实的落盘 key（agent-scripts），让 normalizeScript /
    // 上限截断这些加载路径也参与验证，而不是手搓一份"已经合法"的 state。
    if (options.seedScripts) store['agent-scripts'] = options.seedScripts;
    /**
     * AiService 的**编译产物**。
     *
     * 用在两处：给 hook 注入真实的 estimatePromptTokens（它算上下文占用），
     * 以及让 chat 桩的估算回落与产品同源 —— 自己重写一份估算，
     * 测的就是"我对估算的理解"而不是产品实现。
     */
    const AI = require('./build/services/AiService.js');
    // 本轮里已经发起过几次 chat。每一轮（每次 send）开始时归零 ——
    // 用它实现"每轮先调一次工具、再收尾"，而不是按全局调用序号算：
    // 后者会让第 2 轮之后再也拿不到工具调用，造不出"轮内有工具消息"的场景。
    let roundCalls = 0;

    const chat = async (opts) => {
        chats.push(opts.messages.map((m) => ({ role: m.role, content: m.content })));
        roundCalls += 1;
        /**
         * usage 回调。这里要**如实复刻真实 chat 的契约**：成功就回调一次，
         * 有服务端 usage 就是实测，没有就是估算（见 AiService.reportUsage）。
         *
         * 不能只在 noUsage 为假时回调 —— 那会让"服务端不回 usage"这条回落路径
         * 在测试里根本走不到，而它恰恰是本地代理环境下最常见的形态。
         * 估算也不在这里重写：直接调编译产物里的 estimatePromptTokens，
         * 与产品同一份实现。
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
                // toolCase: 'upper' 让模型回大写工具名，用来验证解析侧的严格匹配
                // （全小写协议下大写即写错，必须落到未知工具）
                const toolName = options.toolCase === 'upper' ? 'JS' : 'js';
                return JSON.stringify({ thought: '取数', tool: toolName, args: { code: 'return 1;' } });
            }
            return JSON.stringify({ thought: '答完了', final: `第 ${chats.length} 轮的回答` });
        };

        // hold：卡住**指定那一轮**（默认第 2 轮），用来观察"运行中"这个中间态。
        // 不能卡住每一轮 —— 那样连造初始状态的那次 send 都会挂死。
        if (options.hold && chats.length === (options.holdAt || 2)) await options.hold;

        const reply = replyFor();
        if (opts.onUsage) {
            if (options.noUsage) {
                const wire = opts.system ? [{ role: 'system', content: opts.system }, ...opts.messages] : opts.messages;
                const promptTokens = AI.estimatePromptTokens(wire);
                const completionTokens = AI.estimateTokens(reply);
                opts.onUsage({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true });
            } else {
                opts.onUsage({ promptTokens: 100 * chats.length, completionTokens: 10, totalTokens: 100 * chats.length + 10, estimated: false });
            }
        }
        return reply;
    };

    const persist = {
        loadJSON: (k, d) => (k in store ? store[k] : d),
        saveJSON: (k, v) => { store[k] = v; return true; },
    };

    const UTILS = require('./build/utils/utils.js');
    const KBSVC = require('./build/services/KbService/index.js');
    const fakeWindow = { setTimeout: () => 1, clearTimeout: () => {} };

    // 去掉 import（类型导入 strip 后已消失）与 export；
    // 具名导入原本来自四个模块，删掉 import 后从注入口解构回来。
    const body = [
        'const { useState, useRef, useCallback, useMemo, useEffect } = React;',
        'const { chat, estimatePromptTokens } = AiService;',
        'const { buildCookieKeys, collectDroppedRules, decodeJwt, findCookieByKey, generateId, pickJwtCandidates, rewriteJwtPayload } = utils;',
        'const { loadJSON, saveJSON } = persist;',
        // useAgent 从 KbService 具名导入五个符号，其中 KB_SEARCH_LIMIT 还要插值进
        // 提示词模板 —— 漏注入会在求值时直接抛 ReferenceError，而不是某条断言失败。
        'const { buildKbIndex, normalizeRel, readKbArticle, searchKb, KB_SEARCH_LIMIT } = KbService;',
    ].join('\n') + '\n'
        + strip(SRC)
            .replace(/^import[\s\S]*?from\s+'[^']*';\s*$/gm, '')
            .replace(/^export /gm, '');

    const makeAgent = new Function(
        'React', 'AiService', 'utils', 'persist', 'KbService', 'window', 'TextEncoder',
        `${body}\nreturn useAgent;`,
    );

    /* --- 最小 React：只有 hook 槽、依赖比较、重渲染与 effect --- */

    const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
        && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

    const hooks = [];
    let idx = 0;
    let effects = [];
    let queued = false;
    let current = null;
    let result;
    // 首个 useState 就是 messages，记下它的 setter 供测试直接摆状态
    let messagesSetter = null;

    const R = {
        useState(init) {
            const i = idx++;
            if (!(i in hooks)) hooks[i] = { v: typeof init === 'function' ? init() : init };
            const slot = hooks[i];
            const setter = (next) => {
                const val = typeof next === 'function' ? next(slot.v) : next;
                if (Object.is(val, slot.v)) return;
                slot.v = val;
                queued = true;
            };
            if (i === 0 && !messagesSetter) messagesSetter = setter;
            return [slot.v, setter];
        },
        useRef(init) {
            const i = idx++;
            if (!(i in hooks)) hooks[i] = { current: init };
            return hooks[i];
        },
        useCallback(fn, deps) {
            const i = idx++;
            const prev = hooks[i];
            if (prev && sameDeps(prev.deps, deps)) return prev.fn;
            hooks[i] = { fn, deps };
            return fn;
        },
        useMemo(fn, deps) {
            const i = idx++;
            const prev = hooks[i];
            if (prev && sameDeps(prev.deps, deps)) return prev.v;
            const v = fn();
            hooks[i] = { v, deps };
            return v;
        },
        useEffect(fn, deps) {
            const i = idx++;
            const prev = hooks[i];
            if (prev && sameDeps(prev.deps, deps)) return;
            hooks[i] = { deps };
            effects.push(fn);
        },
    };

    // useAgent 在模块加载时就解构 React，所以 Proxy 必须返回稳定的转发函数，
    // 真正的 hook 槽等调用那一刻再从 current 上取。
    const ReactProxy = new Proxy({}, {
        get: (_t, k) => (...args) => {
            if (!current) throw new Error(`React.${String(k)} 在 harness 就绪前被调用`);
            return current[k](...args);
        },
    });

    // estimatePromptTokens 用**编译产物**（build/services/AiService.js），
    // 与产品同源：hook 拿它算上下文占用，测试自己重写一份就测不到真实口径了
    const factory = makeAgent(ReactProxy, { chat, estimatePromptTokens: AI.estimatePromptTokens }, UTILS, persist, KBSVC, fakeWindow, TextEncoder);

    /**
     * 假 webview。默认**有页面**，需要造"没有可用页面"的用例传 webview:false。
     *
     * 默认必须有：没有页面时 js 一律返回 {error: 当前没有可用的页面}，
     * 于是所有依赖成功结果的用例都会悄悄退化成在测失败路径 ——
     * 而它们断言的是观察前缀、跨轮可见性这些与成败无关的性质，测错了也不知道。
     */
    const fakeWebview = options.webview === false ? null : {
        executeJavaScript: async (source) => {
            // 复刻真实执行器的契约：脚本源码是包好的 IIFE，直接求值拿到返回值
            const value = await new Function(`return (${source})`)();
            return typeof value === 'string' ? value : JSON.stringify(value);
        },
        getURL: () => options.webviewUrl || 'https://example.com/',
        loadURL: async () => {},
    };

    const deps = {
        getActiveWebview: () => fakeWebview,
        onPageReady: () => () => {},
        tamper: {
            state: { interceptRules: [], requestRules: [], headerRules: [], cookies: [], local: {}, session: {} },
            actions: {
                applyRules() {}, saveRules: () => true,
                getCookies: async () => [],
                setCookie: async () => true, removeCookie: async () => true,
                // throwOnBridge：让 preload 桥抛异常，用来测"工具内部异常"
                // 这条与"返回 error 字段"完全不同的失败路径。
                // getLocalStorage 是 storage get 与 tokens find 都要过的桥，
                // 在这里抛能覆盖 dispatchTool 里**没有**自己 try/catch 的那一类调用。
                getLocalStorage: async () => {
                    if (options.throwOnBridge) throw new Error('preload 桥不可用');
                    return '{}';
                },
                getSessionStorage: async () => '{}',
                setLocalStorage: async () => true, setSessionStorage: async () => true,
                removeLocalStorage: async () => true, removeSessionStorage: async () => true,
            },
        },
    };

    const render = () => {
        idx = 0;
        effects = [];
        current = R;
        result = factory(deps);
        for (const fn of effects) fn();
    };
    // 把 setState 排下的重渲染跑完（React 里这会发生在下一次 commit）
    const flush = () => {
        let guard = 0;
        while (queued && guard++ < 50) { queued = false; render(); }
    };

    render();
    flush();

    return {
        chats,
        /** 当前状态。先 flush 再取：动作排下的 setState 要跑完才看得到结果 */
        state: () => { flush(); return result; },
        async send(text) {
            roundCalls = 0;
            await result.actions.send(text);
            flush();
        },
        /** 不 await 地发起一轮，用来观察"运行中"这个中间态 */
        sendPending(text) {
            roundCalls = 0;
            const p = result.actions.send(text);
            flush();
            return p;
        },
        /** 直接改消息列表，用于构造删除 / 回退的起始状态 */
        setMessages(list) {
            messagesSetter(list);
            flush();
        },
    };
};

/**
 * 造一个 dispatchTool。
 * tamper 是个可观测的假引擎：applyRules / saveRules 分别记账，
 * 这样"有没有越界落盘"是可断言的。
 */
const buildDispatch = (tamperState, scripts = [], webviewUrl = null) => {
    const helpers = [
        grabBlock('const toRuleString = (value: unknown): string =>', "String(value));"),
        grabBlock('const STRICT_NUMBER_RE = ', '/;'),
        grabBlock('const toEngineValue = (value: unknown): string =>', '\n};'),
        grabBlock('const normalizeFieldRules = (raw: unknown, label: string)', '});\n};'),
        grabBlock('const normalizeHeaderRules = (raw: unknown): HeaderRule[] | string =>', '});\n};'),
        grabBlock('const fieldRuleToProtocol = (rule: TamperRule): Record<string, unknown> =>', '\n};'),
        grabBlock('const headerRuleToProtocol = (rule: HeaderRule): Record<string, unknown> =>', '\n});'),
        grabBlock('const safeParseObject = (raw: string)', '\n};'),
        grabBlock('const readWebviewUrl = (webview: WebviewElement): string =>', '\n};'),
        // 未知 action 的统一错误文案（含大小写提示）也是产品代码的一环，
        // 不抽出来就会 ReferenceError —— 那是脚手架的错，不是产品的错。
        grabBlock('const unknownActionError = (got: string, valid: string[]): string =>', '\n};'),
        // cookie 定位也是产品代码里的一环，
        // 必须原样抽出来测，不能在这里重写一份。
        grabBlock('const resolveCookieArg = <T extends', '\n};'),
    ].join('\n');

    const dispatch = grabDispatch();
    const body = `
${strip(helpers)}
// dispatchTool 外面裹着 useCallback；这里只要那个函数本身
const useCallback = (fn) => fn;
// JWT 三个函数来自 utils 的编译产物（见文件头说明）；collectDroppedRules 同理 ——
// dispatchTool 里对"被跳过的规则"的判定必须与面板同源，不能在这里重写一份。
// buildCookieKeys / findCookieByKey 是 cookie 唯一键（面板与 tokens 工具共用），
// 漏注入会让 tokens find 直接抛 ReferenceError —— 那是测试脚手架的错，不是产品代码的。
const { decodeJwt, pickJwtCandidates, rewriteJwtPayload, collectDroppedRules, buildCookieKeys, findCookieByKey } = __UTILS__;
const asString = (v) => (typeof v === 'string' ? v : '');
const generateId = () => 'gen-' + Math.random().toString(36).slice(2, 8);
const SCRIPTS_STORE_MAX = 3;

const calls = {
  apply: 0, save: 0, setCookie: [], setLocal: [], setSession: [], removed: [],
  ranCode: [], navigated: [],
};
const tamper = ${JSON.stringify(tamperState)};
const tamperRef = {
  current: {
    state: { interceptRules: tamper.intercept, requestRules: tamper.request, headerRules: tamper.headers },
    actions: {
      applyRules: (i, r, h) => { calls.apply++; tamperRef.current.state = { interceptRules: i, requestRules: r, headerRules: h }; },
      saveRules: (i, r, h) => { calls.save++; return true; },
      getCookies: async () => tamper.cookies,
      setCookie: async (c) => { calls.setCookie.push(c); return true; },
      removeCookie: async (n) => { calls.removed.push(n); return true; },
      getLocalStorage: async () => JSON.stringify(tamper.local),
      getSessionStorage: async () => JSON.stringify(tamper.session),
      setLocalStorage: async (k, v) => { calls.setLocal.push([k, v]); return true; },
      setSessionStorage: async (k, v) => { calls.setSession.push([k, v]); return true; },
      removeLocalStorage: async (k) => { calls.removed.push('local:' + k); return true; },
      removeSessionStorage: async (k) => { calls.removed.push('session:' + k); return true; },
    },
  },
};
const deps = { getActiveWebview: () => null };
const __WEBVIEW_URL__ = ${JSON.stringify(webviewUrl)};
// 需要页面的用例传 webviewUrl 进来：桩从这里读地址、导航记进 calls.navigated。
// 传整个 webview 对象不行 —— 下面这段 body 是 new Function 的字符串作用域，
// 外部闭包变量穿不进去，只能穿可 JSON 序列化的配置。
if (__WEBVIEW_URL__) {
  deps.getActiveWebview = () => ({
    getURL: () => __WEBVIEW_URL__,
    loadURL: async (u) => { calls.navigated.push(u); },
  });
}
// 记下真正跑过的代码，好断言 R 确实把 code 交给了执行器
const execActive = async (code) => { calls.ranCode.push(code); return '{"ok":true}'; };
const waitForPageReady = async () => true;
const scriptsRef = { current: ${JSON.stringify(scripts)} };
const setScripts = (fn) => { scriptsRef.current = fn(scriptsRef.current); };

${strip(dispatch)}
return { dispatchTool, calls, tamperRef, scriptsRef };
`;
    return new Function('__UTILS__', body)(UTILS);
};

/* -------------------------------------------------------------------------- */

let pass = 0;
const fails = [];
const check = async (name, fn) => {
    try { await fn(); pass++; }
    catch (e) { fails.push({ name, message: e && e.message ? e.message : String(e) }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const j = (s) => JSON.parse(s);

/** 无规则 / 无 cookie / 无存储的空引擎状态，多数用例用它 */
const EMPTY = { intercept: [], request: [], headers: [], cookies: [], local: {}, session: {} };

const run = async () => {
    /* ------------------------------ S: 运行 ------------------------------ */

    await check('js 把 code 交给页面执行并回传结果', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, []);
        const out = await dispatchTool('js', { code: 'return 1+1;' });
        assert(calls.ranCode.length === 1, `应执行一次，实际 ${calls.ranCode.length}`);
        assert(calls.ranCode[0] === 'return 1+1;', '应原样把 code 交给执行器');
        assert(j(out).ok === true, '应回传执行结果');
    });

    await check('js 缺 code 时直接报错，不执行空脚本', async () => {
        // 空跑一步的代价不是零：这一步的结果（哪怕是 null）会被后续每一步重发。
        // 旧行为是照常执行空脚本，这里钉住新行为，防止回退。
        const { dispatchTool, calls } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('js', {}));
        assert(out.error && out.error.includes('code'), `应报缺 code，实际 ${JSON.stringify(out)}`);
        assert(calls.ranCode.length === 0, '空 code 不得进执行器');
    });

    await check('js 空白 code 同样拦截', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('js', { code: '  \n ' }));
        assert(out.error, '纯空白 code 应报错');
        assert(calls.ranCode.length === 0, '不得执行');
    });

    /* ------------------------ script_store: 列出 ------------------------ */

    await check('script_store·list 列出脚本清单', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: 'd', code: 'return 1;', urlPattern: '*x*', enabled: true },
        ]);
        const out = j(await dispatchTool('script_store', { action: 'list' }));
        assert(Array.isArray(out) && out.length === 1, `应列出 1 条，实际 ${out.length}`);
        assert(out[0].id === 'a' && out[0].name === '甲', 'id 与 name 应正确');
    });

    await check('script_store·list 空清单返回空数组', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('script_store', { action: 'list' }));
        assert(Array.isArray(out) && out.length === 0, '应为空数组');
    });

    /* ------------------------------ S: 保存 ------------------------------ */

    await check('script_store·save 保存脚本并回传 id', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('script_store', {
            action: 'save', name: '抓取', description: '抓列表', code: 'return 1;', url_pattern: '/list',
        }));
        assert(out.saved === true, '应回 saved:true');
        assert(typeof out.id === 'string' && out.id, '应回 id');
        assert(scriptsRef.current.length === 1, '脚本清单应多一条');
        assert(scriptsRef.current[0].urlPattern === '/list', 'urlPattern 应写入');
    });

    await check('script_store·save 缺 code 报错且不写入', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('script_store', { action: 'save', name: 'x' }));
        assert(typeof out.error === 'string', '应回错误');
        assert(scriptsRef.current.length === 0, '出错时不得写入');
    });

    await check('script_store·save 只有空白的 code 也算缺', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('script_store', { action: 'save', code: '   \n  ' }));
        assert(typeof out.error === 'string', '应回错误');
        assert(scriptsRef.current.length === 0, '不得写入');
    });

    await check('script_store·save 缺 name 回落默认名', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('script_store', { action: 'save', code: 'return 1;' }));
        assert(out.saved === true, '应成功');
        assert(scriptsRef.current[0].name === '未命名脚本', `默认名应为「未命名脚本」，实际 ${scriptsRef.current[0].name}`);
    });

    // 满了必须明说，不能静默丢弃（旧实现在数组末尾 slice，砍掉的正是刚加的那条）
    await check('script_store·save 达上限时报错并提示用 delete 删', async () => {
        const full = [1, 2, 3].map((i) => ({
            id: 's' + i, name: 'n' + i, description: '', code: 'return 1;', urlPattern: '', enabled: true,
        }));
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, full);
        const out = j(await dispatchTool('script_store', { action: 'save', code: 'return 2;' }));
        assert(typeof out.error === 'string', '应回错误');
        assert(/delete/.test(out.error), `错误里应提示用 delete 删除，实际：${out.error}`);
        assert(scriptsRef.current.length === 3, '不得写入');
    });

    /* ------------------------ script_store: 删除 ------------------------ */

    await check('script_store·delete 删除指定脚本', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: '', code: 'return 1;', urlPattern: '', enabled: true },
            { id: 'b', name: '乙', description: '', code: 'return 2;', urlPattern: '', enabled: true },
        ]);
        const out = j(await dispatchTool('script_store', { action: 'delete', id: 'a' }));
        assert(out.deleted === true, '应回 deleted:true');
        assert(scriptsRef.current.length === 1, `应剩 1 条，实际 ${scriptsRef.current.length}`);
        assert(scriptsRef.current[0].id === 'b', '删掉的应是 a');
    });

    /**
     * 删**第二条**，不是第一条。
     *
     * 只删第一条的话，"按 id 过滤"与"删掉数组首项"结果相同 ——
     * 实测那个错误实现（slice(1)）能骗过上面那条用例。
     * 目标不在首位，才真正区分两者。
     */
    await check('script_store·delete 删的是指定那条，不是第一条', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: '', code: 'return 1;', urlPattern: '', enabled: true },
            { id: 'b', name: '乙', description: '', code: 'return 2;', urlPattern: '', enabled: true },
            { id: 'c', name: '丙', description: '', code: 'return 3;', urlPattern: '', enabled: true },
        ]);
        const out = j(await dispatchTool('script_store', { action: 'delete', id: 'b' }));
        assert(out.deleted === true, '应回 deleted:true');
        const ids = scriptsRef.current.map((s) => s.id).join(',');
        assert(ids === 'a,c', `应剩 a,c，实际 ${ids}`);
    });

    await check('script_store·delete 删最后一条', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: '', code: 'return 1;', urlPattern: '', enabled: true },
            { id: 'b', name: '乙', description: '', code: 'return 2;', urlPattern: '', enabled: true },
        ]);
        await dispatchTool('script_store', { action: 'delete', id: 'b' });
        const ids = scriptsRef.current.map((s) => s.id).join(',');
        assert(ids === 'a', `应剩 a，实际 ${ids}`);
    });

    await check('script_store·delete 找不到 id 时报错且不动清单', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: '', code: 'return 1;', urlPattern: '', enabled: true },
        ]);
        const out = j(await dispatchTool('script_store', { action: 'delete', id: 'nope' }));
        assert(typeof out.error === 'string', '应回错误');
        assert(scriptsRef.current.length === 1, '不得改动清单');
    });

    /* ----------------- script_store: 大小写与未知 action ----------------- */

    // action 全小写严格匹配：大写 LIST 必须报错（并点名正确写法），不能静默执行
    await check('script_store 的 action 区分大小写', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, []);
        const bad = j(await dispatchTool('script_store', { action: 'LIST' }));
        assert(bad.error && bad.error.includes('list'), `大写 LIST 应报错并提示 list，实际 ${JSON.stringify(bad)}`);
        const out = j(await dispatchTool('script_store', { action: 'list' }));
        assert(Array.isArray(out), '小写 list 应列出清单');
    });

    await check('script_store 未知 action 报错并列出可用取值', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('script_store', { action: 'X' }));
        assert(typeof out.error === 'string', '应回错误');
        for (const k of ['list', 'save', 'update', 'delete']) {
            assert(out.error.includes(k), `错误里应列出 ${k}，实际：${out.error}`);
        }
    });

    await check('script_store 缺 action 报错', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('script_store', {}));
        assert(typeof out.error === 'string', '应回错误');
    });

    /* ------------------------------ S: 更新 ------------------------------ */

    await check('script_store·update 按 id 部分更新，只改传了的字段', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: 'd', code: 'return 1;', urlPattern: '/x', enabled: true },
        ]);
        const out = j(await dispatchTool('script_store', { action: 'update', id: 'a', code: 'return 2;', name: '乙' }));
        assert(out.updated === true && out.id === 'a', '应回 updated');
        const s = scriptsRef.current[0];
        assert(s.code === 'return 2;' && s.name === '乙', '传了的字段应更新');
        assert(s.description === 'd' && s.urlPattern === '/x', '没传的字段应原样保留');
        assert(scriptsRef.current.length === 1, '不得增删条目');
    });

    await check('script_store·update 可开关自动执行', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: '', code: 'return 1;', urlPattern: '', enabled: true },
        ]);
        await dispatchTool('script_store', { action: 'update', id: 'a', enabled: false });
        assert(scriptsRef.current[0].enabled === false, 'enabled 应更新');
    });

    await check('script_store·update 找不到 id 时报错且不动清单', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: '', code: 'return 1;', urlPattern: '', enabled: true },
        ]);
        const out = j(await dispatchTool('script_store', { action: 'update', id: 'nope', code: 'return 2;' }));
        assert(typeof out.error === 'string', '应回错误');
        assert(scriptsRef.current[0].code === 'return 1;', '原脚本不得被改动');
    });

    await check('script_store·update 传了空 code 时报错（不想改就别传）', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: '', code: 'return 1;', urlPattern: '', enabled: true },
        ]);
        const out = j(await dispatchTool('script_store', { action: 'update', id: 'a', code: '  ' }));
        assert(typeof out.error === 'string', '空 code 应报错');
        assert(scriptsRef.current[0].code === 'return 1;', '原 code 不得被清空');
    });

    /* --------------------- 全工具：action 严格区分大小写 --------------------- */

    // 大小写错误必须在第一步暴露（未知 action + 点名正确写法），
    // 不能猜着执行 —— 猜对是运气，猜错是烧一步。
    await check('tamper / storage / tokens 的 action 写错大小写就报错', async () => {
        const state = { intercept: [], request: [], headers: [], cookies: [], local: {}, session: {} };
        const t = buildDispatch(state, []);
        const badGet = j(await t.dispatchTool('tamper', { action: 'GET' }));
        assert(badGet.error && badGet.error.includes('get'), `大写 GET 应报错并提示 get，实际 ${JSON.stringify(badGet)}`);
        const badSet = j(await t.dispatchTool('tamper', { action: 'SET', intercept: [] }));
        assert(badSet.error && badSet.error.includes('set'), '大写 SET 应报错');

        const s = buildDispatch(state, []);
        const sBad = j(await s.dispatchTool('storage', { action: 'GET', area: 'LOCAL' }));
        assert(sBad.error, `大写 GET/LOCAL 应报错，实际 ${JSON.stringify(sBad)}`);

        const k = buildDispatch(state, []);
        const kBad = j(await k.dispatchTool('tokens', { action: 'FIND' }));
        assert(kBad.error && kBad.error.includes('find'), '大写 FIND 应报错');
    });

    /* ------------------------------ navigate ------------------------------ */

    await check('navigate：裸域名自动补 https', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, [], 'https://example.com/a');
        const out = j(await dispatchTool('navigate', { url: 'example.org/x' }));
        assert(out.url === 'https://example.org/x', `应补协议，实际 ${out.url}`);
        assert(calls.navigated[0] === 'https://example.org/x', '应按归一后的地址导航');
    });

    await check('navigate：相对路径相对当前页解析', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, [], 'https://example.com/a/b?x=1');
        const out = j(await dispatchTool('navigate', { url: '/api/login' }));
        assert(out.url === 'https://example.com/api/login', `应相对当前页解析，实际 ${out.url}`);
        assert(calls.navigated[0] === out.url, '导航地址与回显必须一致（下一步 js 基于它判断）');
    });

    await check('navigate：完整 URL 原样通过', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, [], 'https://example.com/');
        const out = j(await dispatchTool('navigate', { url: 'http://other.com/p' }));
        assert(out.url === 'http://other.com/p', '有协议的地址不得改动');
        assert(calls.navigated[0] === 'http://other.com/p', '导航地址应原样');
    });

    await check('navigate：无页面时报错', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, []);
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
        const st = tamperRef.current.state;
        assert(st.interceptRules[0].jsonPath === 'vip', '拦截规则必须原样保留');
        assert(st.headerRules[0].headerName === 'Referer', '请求头规则名应写入内部 headerName');
    });

    // 模型改规则立刻生效，但**不能**越过用户写进本地存储。
    await check('tamper set 走 applyRules 而非 saveRules（不落盘）', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        await dispatchTool('tamper', {
            action: 'set',
            intercept: [{ enabled: true, url_pattern: '*', key: 'vip', value: true, op: 'set' }],
        });
        assert(calls.apply === 1, `应调用 applyRules，实际 ${calls.apply}`);
        assert(calls.save === 0, `不得调用 saveRules（会持久化），实际 ${calls.save}`);
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
        const v = tamperRef.current.state.interceptRules[0].newValue;
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
        const v = tamperRef.current.state.interceptRules[0].newValue;
        assert(v === '=123', `字符串必须强制前缀，实际 ${JSON.stringify(v)}（否则引擎会按数字 123 写入）`);
        // 往返：get 应把 "=123" 逆解回字符串 "123"
        const { dispatchTool: d2 } = buildDispatch({
            intercept: tamperRef.current.state.interceptRules,
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
        assert(tamperRef.current.state.interceptRules[0].newValue === 'undefined',
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
        const hv = tamperRef.current.state.headerRules[0].headerValue;
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
        const hv = tamperRef.current.state.headerRules[0].headerValue;
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
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const hits = src.match(/reasoning:\s*keepReasoning\(liveReasoning\)/g) || [];
        assert(hits.length === 5,
            `应有 5 处定稿点带上推理（中断两种 / 最终回复 / 工具调用 / 协议错误），实际 ${hits.length} 处`);
    });

    await check('中断时只有推理也要落一条消息', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
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
        const src = fs.readFileSync(SRC_PATH, 'utf8');

        const pushes = src.match(/transcript\.push\([^)]*\)/g) || [];
        assert(pushes.length > 0, '应能找到 transcript.push（找不到说明实现变了，本断言需重写）');
        for (const p of pushes) {
            assert(!/reasoning/.test(p),
                `transcript.push 不得携带 reasoning（会把思考重发给模型）：${p}`);
        }

        // 初始项同理：它是本轮第一条发给模型的消息
        const init = src.match(/const transcript: AiChatMessage\[\] = \[[^\]]*\]/);
        assert(init, '应能找到 transcript 的初始化');
        assert(!/reasoning/.test(init[0]), 'transcript 初始项不得携带 reasoning');
    });

    await check('推理不进模型上下文：chat 只收 transcript', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');

        /**
         * 先切出 chat({...}) 这一段，再看它里面的 messages 指向谁。
         * 不写成"messages 后面必须紧跟 reasoningEffort"那种正则：那样参数一换序
         * 就会误报，而误报的代价是下一个人去改测试而不是看代码。
         *
         * **必须从 send() 里开始找**：文件里现在有第二个 chat() 调用点
         * （compact 的摘要器，messages 是 digest），从文件头 indexOf 会命中它，
         * 于是这条断言测的是摘要器而不是主循环 —— 主循环把推理漏进上下文也照样绿。
         */
        const sendAt = src.indexOf('const send = useCallback(async (prompt: string)');
        assert(sendAt >= 0, '应能找到 send');
        const start = src.indexOf('await chat({', sendAt);
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

    await check('历史里的工具结果以 user 观察回灌，且带工具名', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: '取一下价格' }),
            msg({ role: 'tool', content: '调用 js', label: 'js', tool: 'js', result: '{"price":9.9}', ok: true }),
            msg({ role: 'assistant', content: '价格是 9.9' }),
        ]);
        assert(out.length === 3, `应为 user/观察/assistant 三条，实际 ${out.length}`);
        assert(out[1].role === 'user', '观察必须以 user 身份回灌（JSON 协议没有 tool role）');
        assert(out[1].content.includes('[工具 js 的执行结果]'),
            `观察前缀应带工具名与动作，实际：${out[1].content.slice(0, 40)}`);
        assert(out[1].content.includes('{"price":9.9}'), '观察里应带原始结果');
    });

    await check('label 缺失时回落到 tool 字段', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', tool: 'navigate', result: 'ok' }),
        ]);
        assert(out[1].content.includes('[工具 navigate 的执行结果]'),
            `没有 label 时应回落到 tool，实际：${out[1].content.slice(0, 40)}`);
    });

    /**
     * 产品代码必须真的把 label 写进工具消息。
     *
     * 只测"缺 label 时回落到 tool"是不够的 —— 那恰好是**写漏 label** 时的行为，
     * 于是断言会在 bug 存在时照样通过（变异测试里这条变异体就是靠这一条存活的）。
     * 所以这里直接钉住调用点：工具消息里必须带 label，且它含 action。
     */
    await check('工具消息写入 label（含 action），不只写 tool', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const at = src.indexOf("                    role: 'tool',");
        assert(at > 0, '应能找到工具消息的构造点');
        const block = src.slice(at, at + 700);
        assert(/^\s*label,$/m.test(block),
            '工具消息必须带 label 字段：历史里只写工具名分不出 script_store 四个动作');
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
        assert(out.every((m) => Object.keys(m).length === 2 && 'role' in m && 'content' in m),
            '每条只应有 role 与 content 两个字段');
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

    /** 同上：四个提示点都必须真的打上 notice 标记；步数上限已按用户要求彻底去掉 */
    await check('四处界面提示都写入 notice 标记', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const notices = src.match(/^\s*notice: true,$/gm) || [];
        assert(notices.length === 4,
            `中断提示 / 空回复提示 / 协议错误放弃提示 / 轮内上下文超限提示都应带 notice，实际 ${notices.length} 处`);
        assert(!/MAX_STEPS/.test(src),
            '单轮步数上限必须彻底移除（不设调用轮次上限），留着常量就是下一个漂移的源头');
    });

    /**
     * 提示词里承诺的三种前缀，必须与 buildTranscript 真正写出的**逐字一致**。
     *
     * 这两处分别在文件的头尾，改一处忘另一处不会有任何编译或运行时错误 ——
     * 只会让模型去找一个根本不存在的标记，于是"回看历史"这条纪律形同虚设。
     */
    await check('提示词声明的观察前缀与实现一致', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');

        // 提示词那一段
        const specAt = src.indexOf('你**能看到之前几轮的对话与工具结果**');
        assert(specAt > 0, '应能在提示词里找到"能看到之前几轮"这条纪律');
        const spec = src.slice(specAt, specAt + 300);

        // 实现真正写出的前缀
        const produced = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', label: 'js', result: 'r' }),
            msg({ role: 'tool', content: '自动执行：x', auto: true, result: 'r' }),
            msg({ role: 'assistant', content: '提示', notice: true }),
        ]).map((m) => m.content).join('\n');

        for (const prefix of ['[工具 ', '[自动脚本', '[系统提示]']) {
            assert(produced.includes(prefix), `实现应写出 ${prefix}（本断言已失效，需更新）`);
            assert(spec.includes(prefix), `提示词必须声明 ${prefix}，否则模型不知道那是历史`);
        }
    });

    /**
     * 自动执行的脚本不是模型发出的调用。
     * 写成「[工具 js·自动·x 的执行结果]」会凭空捏造一次模型从未发出的调用 ——
     * 模型据此会以为自己已经跑过那段脚本，从而不再主动取数。
     */
    await check('自动执行的脚本按环境事件写回，不伪装成工具调用', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', content: '自动执行：抓价格', tool: 'js', auto: true, result: '{"p":1}' }),
        ]);
        const blob = JSON.stringify(out);
        assert(blob.includes('[自动脚本'), `应按自动脚本写回，实际：${blob.slice(0, 120)}`);
        assert(!blob.includes('[工具 js·自动'), '不得伪装成模型发出的工具调用');
        assert(blob.includes('抓价格'), '应带上脚本名，模型才知道页面上发生了什么');
    });

    /** 同上：onPageReady 那个调用点必须真的打上 auto 标记 */
    await check('自动执行的消息写入 auto 标记', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const at = src.indexOf("content: `自动执行：${script.name}`");
        assert(at > 0, '应能找到自动执行的 appendMessage');
        const block = src.slice(at, at + 500);
        assert(/^\s*auto: true,$/m.test(block),
            '自动执行的消息必须带 auto: true，否则重建上下文时会被伪造成一次模型调用');
    });

    await check('连续多个观察合并进一条 user 消息', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', label: 'js', result: 'A' }),
            msg({ role: 'tool', label: 'script_store·list', result: 'B' }),
        ]);
        assert(out.length === 2, `两个观察应合并成一条，实际 ${out.length} 条`);
        assert(out[1].content.includes('A') && out[1].content.includes('B'), '两段结果都要在');
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
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const sendAt = src.indexOf('const send = useCallback(async (prompt: string)');
        assert(sendAt >= 0, '应能找到 send');
        // 历史先取到局部变量 list，再喂给 buildTranscript。断言认的是
        // "读 messagesRef 那一刻" 与 "appendMessage 那一刻" 的先后，
        // 所以取 messagesRef.current 的位置就是判据。
        const readAt = src.indexOf('messagesRef.current', sendAt);
        const buildAt = src.indexOf('buildTranscript(', sendAt);
        const appendAt = src.indexOf("appendMessage({ id: generateId(), role: 'user', content: text", sendAt);
        assert(readAt > 0, 'send 里应读 messagesRef.current 拿历史');
        assert(buildAt > 0, 'send 里应调用 buildTranscript 重建历史');
        assert(appendAt > 0, 'send 里应追加本轮用户消息');
        assert(readAt < appendAt,
            '必须在 appendMessage 之前读历史，否则本轮提问会重复进上下文');
        assert(buildAt < appendAt,
            '必须在 appendMessage 之前重建历史，否则本轮提问会重复进上下文');
    });

    await check('send 把历史拼在本轮提问前面', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const m = src.match(/const transcript: AiChatMessage\[\] = \[([^\]]*)\]/);
        assert(m, '应能找到 transcript 的初始化');
        assert(/\.\.\.history/.test(m[1]), `transcript 必须以历史打头，实际：[${m[1]}]`);
        assert(/role: 'user', content: text/.test(m[1]), '本轮提问应排在历史之后');
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
     * 超长观察也不二次截断。
     *
     * execOn 回传时已按 RESULT_LIMIT_BYTES（32KB）截过一次；这里再收到 8KB
     * 会让"用户展开卡片看到的"与"模型拿到的"不一致，复盘时无从解释。
     */
    await check('超长观察不二次截断（与用户看到的一致）', async () => {
        const payload = 'y'.repeat(40000);
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', label: 'js', result: payload }),
            msg({ role: 'assistant', content: '看完了' }),
        ]);
        const observation = out.find((m) => m.content.includes('[工具'));
        assert(observation, '应有观察消息');
        assert(observation.content.includes(payload),
            '观察应原样进上下文，不得二次截断（截断只发生在 execOn 回传那一次）');
        assert(out.some((m) => m.content === '看完了'), '同轮的对话不得因观察过长而丢失');
    });

    await check('孤立观察（无新提问）自然留在上一轮里', async () => {
        // 上一轮结束后页面自己触发了 urlPattern 脚本：此时还没有新的用户提问。
        // 轮次边界只有"新的用户提问"一个，所以这些观察本就还在 current 里没被 flush 过，
        // 不需要任何额外判断 —— 它们自然挂在上一轮尾部，而不是单开一个没有提问的"轮次"。
        const out = buildTranscript([
            msg({ role: 'user', content: '第一轮' }),
            msg({ role: 'assistant', content: '答一' }),
            msg({ role: 'tool', content: '自动执行：x', tool: 'js', auto: true, result: 'R' }),
        ]);
        assert(out.length === 3, `应并进上一轮成为第 3 条，实际 ${out.length} 条`);
        assert(out[0].content === '第一轮', '首条仍是上一轮的提问');
        assert(out[2].content.includes('[自动脚本'), '孤立观察应挂在上一轮尾部');
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
        const h = buildAgentHarness();
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
        const h = buildAgentHarness();
        await h.send('第一轮');
        await h.send('第二轮');
        await h.send('第三轮');

        const third = JSON.stringify(h.chats[2]);
        assert(third.includes('第一轮') && third.includes('第二轮'), '第三轮应带着前两轮');
        assert((third.match(/第三轮/g) || []).length === 1, '本轮提问不得重复');
    });

    await check('端到端：工具结果跨轮可见，且以 user 观察形式出现', async () => {
        const h = buildAgentHarness({ toolCall: true });
        await h.send('先取一下价格');
        await h.send('刚才取到的价格是多少？');

        const second = h.chats[1];
        const observation = second.find((m) => m.content.includes('[工具 js 的执行结果]'));
        assert(observation, `第二轮应能看到第一轮的工具结果，实际：${JSON.stringify(second)}`);
        assert(observation.role === 'user', '工具结果必须以 user 身份回灌');
    });

    await check('端到端：大写工具名落到未知工具（严格匹配）', async () => {
        const h = buildAgentHarness({ toolCall: true, toolCase: 'upper' });
        await h.send('取一下');
        const tool = h.state().messages.find((m) => m.role === 'tool');
        assert(tool, '应有一条 tool 消息（报错也要记账）');
        assert(tool.ok === false, '大写 JS 不得派发成功');
        assert(tool.result.includes('未知工具'), `应报未知工具，实际 ${tool.result}`);
    });

    /* ---------------------- 删除单条 / 回退到检查点 ---------------------- */

    /**
     * 造一段两轮的对话，返回 harness 与两轮的消息 id。
     *
     * 用真实的 send 跑出来而不是手搓 messages：删除与回退的判据都依赖
     * "一条消息属于哪一轮"，手搓的假数据会把这条判据的验证变成自证。
     */
    const twoRounds = async (options = {}) => {
        const h = buildAgentHarness({ toolCall: true, ...options });
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
        const h = buildAgentHarness({ hold: gate });
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
        const h = buildAgentHarness({ toolCall: true, webview: false });
        await h.send('取一下');

        const tool = h.state().messages.find((m) => m.role === 'tool');
        assert(tool, '构造前提：应有一条 tool 消息');
        assert(tool.ok === false, '失败的工具消息 ok 应为 false');

        // 回灌给模型的那条 user 观察
        const wire = h.chats[1] || h.chats[h.chats.length - 1];
        const observation = wire.find((m) => m.content.includes('[工具 js 执行失败]'));
        assert(observation, `失败必须以「执行失败」前缀回灌，实际：${JSON.stringify(wire)}`);
        assert(observation.role === 'user', '仍以 user 身份回灌');
        assert(observation.content.includes('当前没有可用的页面'),
            '必须带上原始错误信息 —— 只说"失败了"模型不知道改什么');
    });

    /**
     * 失败之后必须**继续**，而不是当成结论收尾。
     *
     * 这是本次要修的核心：失败只是这一步的结果，不是任务的终点。
     * 用例让模型第一次调工具（必失败）、第二次给出 final ——
     * 若实现把失败当成"说完了"，就不会有第二次调用。
     */
    await check('工具失败后继续跑下一步，不当作收尾', async () => {
        const h = buildAgentHarness({
            webview: false,
            replies: [
                JSON.stringify({ thought: '取数', tool: 'js', args: { action: 'R', code: 'return 1;' } }),
                JSON.stringify({ thought: '页面不可用，改用知识库', final: '拿不到页面数据。' }),
            ],
        });
        await h.send('取一下');

        assert(h.chats.length >= 2,
            `失败后应继续请求模型（至少 2 次 chat），实际 ${h.chats.length} 次`);
        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.role === 'assistant' && last.content === '拿不到页面数据。',
            `应以模型的 final 收尾，实际 ${JSON.stringify(last)}`);
    });

    /**
     * 协议错误（没给 tool 也没给 final）必须回灌让模型自己改，而不是
     * 把那段散文当成最终回答交给用户。
     *
     * 这是本次要修的第二个核心问题：调用错误被当成普通文本处理。
     */
    await check('协议错误：回灌错误提示并继续，不把散文当结论', async () => {
        const h = buildAgentHarness({
            replies: [
                '我先看看页面结构，稍等。',                       // 散文，没有 JSON
                JSON.stringify({ thought: '收到', final: '真正的结论' }),
            ],
        });
        await h.send('看看');

        assert(h.chats.length >= 2, `协议错误后应继续，实际只发了 ${h.chats.length} 次`);

        // 回灌里必须点名协议要求，并带上模型自己的原文
        const wire = h.chats[1];
        const fix = wire.find((m) => m.content.includes('[协议错误]'));
        assert(fix, `应回灌协议错误提示，实际：${JSON.stringify(wire)}`);
        assert(fix.content.includes('tool'), '提示里必须说明要用 tool / final 字段');
        assert(fix.content.includes('我先看看页面结构'),
            '必须带上模型原文，否则它不知道自己错在哪');

        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.content === '真正的结论',
            `应等到模型的 final 才收尾，实际 ${JSON.stringify(last)}`);
        // 那段散文不得作为最终回答出现
        assert(!h.state().messages.some((m) => m.role === 'assistant' && m.content === '我先看看页面结构，稍等。'),
            '散文不得被当成 assistant 结论落进对话');
    });

    /** 协议错误也要在界面上留痕，否则用户看到模型"凭空消失"一步 */
    await check('协议错误：界面留一条失败记录', async () => {
        const h = buildAgentHarness({ replies: '我又忘了写 JSON' });
        await h.send('看看');

        const bad = h.state().messages.find((m) => m.label === '协议错误');
        assert(bad, '协议错误应在对话流里留一条记录');
        assert(bad.ok === false, '它是一次失败，ok 应为 false');
        assert(bad.result.includes('我又忘了写 JSON'), '应存下模型原文供复盘');
    });

    /**
     * 连续错到上限就停 —— 无上限回灌会把整轮预算烧光，
     * 且每一步都要付一次调用费。
     */
    await check('协议错误：连续超限后停止并说明原因', async () => {
        const h = buildAgentHarness({ replies: '一直不按协议回' });
        await h.send('看看');

        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const max = Number(src.match(/const MAX_PROTOCOL_ERRORS = (\d+);/)[1]);
        assert(h.chats.length === max,
            `应恰好尝试 ${max} 次后停止，实际 ${h.chats.length} 次`);

        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.notice === true, '收尾提示必须带 notice（不是模型说的话）');
        assert(last.content.includes('协议'), `应说明是协议问题，实际 ${last.content}`);
    });

    /** 成功执行一次工具就归零：偶发笔误不该跟着整个会话不放 */
    await check('协议错误计数在工具成功执行后归零', async () => {
        const h = buildAgentHarness({
            replies: [
                '第一次写错',                                     // 协议错误 1
                JSON.stringify({ thought: '改好了', tool: 'js', args: { action: 'R', code: 'return 1;' } }),
                '又写错了',                                       // 若没归零，这次就该触发上限
                JSON.stringify({ thought: '收到', final: '结束' }),
            ],
        });
        await h.send('看看');

        // 归零了 → 不会在第 3 次调用时判定超限，能走到最终的 final
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
        const h = buildAgentHarness({
            throwOnBridge: true,
            replies: [
                JSON.stringify({ thought: '读存储', tool: 'storage', args: { action: 'get', area: 'local' } }),
                JSON.stringify({ thought: '桥断了，改用页面脚本', final: '存储读不到。' }),
            ],
        });
        await h.send('读一下本地存储');

        const tool = h.state().messages.find((m) => m.role === 'tool');
        assert(tool, '异常也应记一条 tool 消息');
        assert(tool.ok === false, '抛异常的步骤 ok 应为 false');
        assert(tool.result.includes('preload 桥不可用'),
            `异常信息必须原样交给模型，实际 ${tool.result}`);

        assert(h.chats.length >= 2, `异常后应继续跑，实际只发了 ${h.chats.length} 次`);
        const last = h.state().messages[h.state().messages.length - 1];
        assert(last.content === '存储读不到。', `应走到模型的 final，实际 ${JSON.stringify(last)}`);
    });

    /* ---------------------- 手动执行已保存脚本 ---------------------- */

    /**
     * 手动执行走完整记账：lastRunAt / lastResult 更新 + 一条 tool 消息进对话。
     *
     * 这里用 webview:false 造"没有可用页面"的场景，于是执行结果是那条错误串 ——
     * 正好断言"失败也要记账"：用户点完运行，卡片上必须留下这次的结果，
     * 不能悄无声息。
     */
    await check('手动执行：无页面时错误原样记账并进对话', async () => {
        const h = buildAgentHarness({ webview: false, seedScripts: [{ id: 's1', name: '取价', code: 'return 1;' }] });
        const before = h.state().messages.length;

        const out = await h.state().actions.runScriptNow('s1');

        assert(out.includes('当前没有可用的页面'), `应返回无页面错误，实际 ${out}`);
        const st = h.state();
        assert(st.scripts.length === 1, '脚本清单不应增减');
        assert(st.scripts[0].lastResult === out, 'lastResult 应记下这次的结果（含失败）');
        assert(typeof st.scripts[0].lastRunAt === 'number', 'lastRunAt 应更新');
        const tool = st.messages.slice(before).find((m) => m.role === 'tool');
        assert(tool, '手动执行应追加一条 tool 消息');
        assert(tool.auto === true, '手动执行的消息应标 auto（环境事件语义，与自动执行一致）');
        assert(tool.content.includes('手动执行'), `消息内容应标明手动，实际 ${tool.content}`);
        assert(tool.ok === false, '失败的执行 ok 应为 false');
    });

    await check('手动执行：未知 id 不记账不进对话', async () => {
        const h = buildAgentHarness({ seedScripts: [{ id: 's1', name: '取价', code: 'return 1;' }] });
        const before = h.state().messages.length;

        const out = await h.state().actions.runScriptNow('不存在的-id');

        assert(out.includes('error'), '未知 id 应返回错误串');
        assert(h.state().messages.length === before, '不得追加消息');
        assert(h.state().scripts[0].lastResult === undefined, '不得污染现存脚本的记账');
    });

    await check('运行中：手动执行被拒绝', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const h = buildAgentHarness({ hold: gate, seedScripts: [{ id: 's1', name: '取价', code: 'return 1;' }] });
        await h.send('第一轮提问');
        const before = h.state().messages.length;

        const pending = h.sendPending('第二轮提问');
        const out = await h.state().actions.runScriptNow('s1');

        assert(out.includes('正在运行'), `运行中应拒绝，实际 ${out}`);
        assert(h.state().messages.length >= before, '运行中的手动执行不得追加消息');
        assert(h.state().scripts[0].lastResult === undefined, '运行中的手动执行不得记账');

        release();
        await pending;
    });

    /**
     * 行内操作按钮必须挂在**具名** group 上。
     *
     * `group/msg` + `group-hover/msg:opacity-100` 是 Tailwind 的具名 group 语法。
     * 漏掉 `/msg` 不会有任何编译或运行时错误 —— 按钮只是永远 opacity:0，
     * 用户根本看不到这两个功能。实测变异（改成 `group-hover:opacity-100`）
     * 只有真跑浏览器悬停才能抓到，所以这里至少把类名钉死，防止无声漂移。
     */
    await check('行内操作按钮用具名 group 控制显隐', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        assert(/group-hover\/msg:opacity-100/.test(src),
            '按钮显隐必须用 group-hover/msg（普通 group-hover 会被外层 group 抢走，按钮永不显形）');
        assert(/focus-within:opacity-100/.test(src),
            '还要 focus-within：否则 Tab 聚焦落在一个看不见的按钮上');
        assert(/group\/msg/.test(src), '消息行必须声明 group/msg');
    });

    await check('删除与回退都接到界面上（不是只有 hook）', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        assert(/onRewind=\{\(\) => handleRewind\(message\.id\)\}/.test(src),
            '回退按钮必须接到 handleRewind');
        assert(/onRemove=\{\(\) => actions\.removeMessage\(message\.id\)\}/.test(src),
            '删除按钮必须接到 removeMessage');
        assert(/canEdit=\{canEdit\}/.test(src), '两个按钮都要受 canEdit 控制');
        // 回退的用途是"改一改重发"，提问必须填回输入框
        assert(/setInput\(\(prev\) => \(prev\.trim\(\) \? prev : prompt\)\)/.test(src),
            '回退应把提问填回输入框，且不覆盖用户已写的内容');
    });

    /* --------------------------- 工作区交互 wiring --------------------------- */

    await check('手动执行接到脚本页（不是只有 hook）', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        assert(/onRun=\{actions\.runScriptNow\}/.test(src),
            '脚本页必须接到 runScriptNow —— 否则 actions 里有而界面点不到');
        assert(/runDisabled=\{busy\}/.test(src), '运行中必须禁用手动执行');
        assert(/setRunningId\(script\.id\)/.test(src), '点运行后卡片应有执行中状态');
    });

    await check('边栏标签与输入草稿落盘', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        assert(/theplay\.browse\.agent\.tab/.test(src), '当前标签页必须落盘');
        assert(/theplay\.browse\.agent\.draft/.test(src), '输入草稿必须落盘');
        assert(/AGENT_TABS\.some\(\(tab\) => tab\.id === saved\)/.test(src),
            '恢复标签时必须校验合法性（版本升级删标签不能卡死界面）');
    });

    await check('失败横幅带重试（用同一句提问重发）', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        assert(/actions\.send\(lastPrompt\)/.test(src), '重试必须用最后一句提问重发');
        assert(/!busy && !inputLocked && !compacting && lastPrompt/.test(src),
            '重试只在空闲、未超限、未压缩且有提问时出现（send 会直接拒绝，按钮不该可点）');
    });

    await check('Agent 改规则后对话页有查看入口', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        assert(/draft\.overridden && \(/.test(src), '对话页操作条必须响应 overridden');
        assert(/selectTab\('rules'\)/.test(src), '入口必须切到规则页（只看不自动应用）');
    });

    await check('空态示例可点、复制有 fallback', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        assert(/<EmptyHint onPick=/.test(src), '空态示例必须能点进输入框');
        assert(/document\.execCommand\('copy'\)/.test(src),
            '复制必须有 execCommand fallback（失焦时 clipboard API 不可用）');
    });

    await check('Ctrl+K 聚焦链路贯通（快捷键→类型→转发→面板）', async () => {
        const svc = require(path.join(ROOT, 'electron', 'browserService.js'));
        const hit = svc.resolveBrowserShortcut({
            type: 'keyDown', key: 'k', code: '', isAutoRepeat: false, isComposing: false,
            shift: false, control: true, alt: false, meta: false, location: 0, modifiers: [],
        });
        assert(hit && hit.action === 'focusAgentInput', `Ctrl+K 应命中 focusAgentInput，实际 ${JSON.stringify(hit)}`);
        assert(svc.BROWSER_KEY_ACTIONS.includes('focusAgentInput'), '动作必须在键动作表里（否则不经 preventDefault）');
        assert(svc.shouldPreventDefault('focusAgentInput') === true, 'Ctrl+K 必须拦掉，不让页面收到');
        const browseSrc = fs.readFileSync(path.join(ROOT, 'hooks', 'useBrowse.ts'), 'utf8');
        assert(/command\.action === 'focusAgentInput'/.test(browseSrc), 'useBrowse 必须转发给面板');
        const panelSrc = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        assert(/command\.action === 'focusAgentInput'/.test(panelSrc), '面板必须处理该命令');
        assert(/focusSeq=\{agentFocusSeq\}/.test(panelSrc), '聚焦序号必须传进边栏');
        assert(/inputRef\.current\?\.focus\(\)/.test(panelSrc), '边栏必须真实聚焦输入框');
    });

    /* --------------------------- 提示词：行为约束 --------------------------- */

    /**
     * 方法论约束写漏了不会有任何编译或运行时错误 —— 只会让模型
     * 退回"给概念解释、靠猜下结论、含糊收尾"的默认姿态。所以在这里钉住
     * 新提示词里实际存在的等价表述，而不是已删掉的旧小节名。
     */
    await check('提示词含行为约束（假设 / 证据 / 交付）', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        // thought 字段的写法即工作方式：先假设、再给证据链
        assert(src.includes('假设或判断依据'), '工具调用的 thought 应要求写假设或判断依据');
        assert(src.includes('推导与证据链'), '收尾的 thought 应要求写推导与证据链');
        const at = src.indexOf('## 执行准则');
        assert(at > 0, '应有「执行准则」一节');
        const section = src.slice(at, src.indexOf('`;', at));
        assert(section.includes('证据'), '结论必须有证据支撑');
        assert(/实际采样值/.test(section), '提取数据必须给实际采样值与总量，而非"可以读取"');
        assert(/篡改前后/.test(section), '验证绕过必须给篡改前后的行为对比');
        assert(/已尝试的路径|卡点/.test(section), '做不到时要给可交接的状态，不许含糊收尾');
    });

    /**
     * 提示词里引用的 KB 入口必须真的能搜到。
     *
     * 提示词教模型「不确定时先 search "攻击网"」，而攻击网那 4 篇文章是唯一
     * 没有 front-matter 的（靠 H1 兜底取标题）。哪天索引规则一改把它们漏掉，
     * 提示词就变成在教模型找一个不存在的东西 —— 而这条不会有任何报错。
     */
    await check('提示词推荐的「攻击网」入口确实可搜到', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        assert(src.includes('search "攻击网"'), '提示词应给出攻击网入口');

        const KB = require('./build/services/KbService/index.js');
        const kbService = require(path.join(ROOT, 'electron', 'kbService.js'));
        const root = kbService.resolveKbRoot('');
        if (!root) return; // 没有 KB 目录时跳过（CI / fresh clone）

        const payload = kbService.loadKbSource('');
        const entries = KB.buildKbIndex(payload.files, payload.boardIndexes);
        const hits = KB.searchKb(entries, '攻击网');
        assert(hits.length > 0, '「攻击网」必须能搜到，否则提示词在教模型找一个不存在的东西');
        assert(hits.some((h) => h.path.includes('attack-network')),
            `应命中 attack-network.md，实际 ${hits.map((h) => h.path).join(', ')}`);
    });

    /**
     * 提示词里的数字必须来自真值，不能手抄。
     *
     * 踩过：`kb search 回最多 5 条` 与 `正文 ≤24KB` 都是手写的，
     * 而真值在 KbService 的 KB_SEARCH_LIMIT / KB_READ_LIMIT_BYTES 里 ——
     * 改了常量提示词不跟着变，模型就按错的上限规划步骤。
     */
    await check('提示词用插值引用 KB 常量，不手抄数字', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        assert(/\$\{KB_SEARCH_LIMIT\}/.test(src),
            'search 条数上限应插值 KB_SEARCH_LIMIT，而不是写死');
        assert(!/search 回最多 \d+ 条/.test(src), '不得把条数上限手抄进提示词');
        assert(!/正文 ≤\d+KB/.test(src), '不得把正文上限手抄进提示词');
        // 篇数同理：它会随 KB 升级变，写死必然过期
        assert(!/知识库（\d+ 篇/.test(src), '不得把文章篇数写死 —— KB 升级后必然对不上');
    });

    /* --------------------------- 提示词：输出与参数契约 --------------------------- */

    await check('输出协议：无围栏直接贴 JSON，且 tool/final 互斥', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const at = src.indexOf('## 输出协议');
        assert(at > 0, '应有「输出协议」一节');
        const section = src.slice(at, src.indexOf('## ', at + 10));
        assert(!/```json/.test(section), '不得要求代码块围栏（解析器取首个合法对象，围栏是纯 token 开销）');
        assert(/不要同时给/.test(section), '必须声明 tool 与 final 互斥（同时给时 final 被忽略）');
    });

    await check('工具说明：全小写匹配、update 动作、导航归一都有交代', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const at = src.indexOf('## 可用工具定义');
        assert(at > 0, '应有「可用工具定义」一节');
        const spec = src.slice(at, src.indexOf('## 执行准则', at));
        assert(/全小写/.test(spec), '必须声明全小写严格匹配（写错名字第一步就暴露）');
        assert(/"action": "update"/.test(spec), 'script_store 的 update 必须写进说明，否则模型永远用 delete+save 两步');
        assert(/相对路径/.test(spec), 'navigate 的相对路径必须写进说明');
        assert(/子串/.test(spec), 'script_store 的 url_pattern 子串语义必须点明');
        assert(/"op": "set" \| "delete"/.test(spec), 'tamper 的 op 必须写进说明（删字段用 delete，不许猜）');
    });

    await check('准则：失败两次换路，失败不是终点', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const at = src.indexOf('## 执行准则');
        assert(at > 0, '应有「执行准则」一节');
        const section = src.slice(at, src.indexOf('## 完成标准', at));
        assert(/更换策略/.test(section), '必须要求同一招失败两次就换路（死胡同里每步都要付一次调用费）');
        assert(/不是任务的终点/.test(section), '必须声明失败只是这一步的结果，否则模型失败一两次就含糊收尾');
        assert(!/再动手取数据/.test(section), '旧的"先数数再取数"必须删掉（与一次拿够矛盾）');
    });

    /* ------------------------- 会话 token 统计 ------------------------- */

    /**
     * 用量必须**落在消息上**，而不是只维护一个累计值。
     *
     * 累计值经不起删除与回退：用户删掉一条或回退一轮之后，累加器只会越走越偏，
     * 而界面上看不出任何异常 —— 只是数字悄悄变大。落在消息上则天然可重算。
     */
    await check('用量落在消息上，且累计由现存消息重算', async () => {
        const h = buildAgentHarness({ toolCall: true });
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
     * 服务端不回 usage 时必须有估算兜底 —— 否则本地代理一多，
     * 整个统计功能就是空的，而用户看不出是"没有数据"还是"没有花费"。
     */
    await check('服务端不回 usage 时走估算并标注 estimated', async () => {
        const h = buildAgentHarness({ noUsage: true });
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
     */
    await check('上下文占用随历史增长，且由现存消息决定', async () => {
        const h = buildAgentHarness();
        await h.send('短');
        const first = h.state().usage.contextTokens;
        assert(first > 0, '首轮上下文应大于 0');

        await h.send('这是一句明显更长的话，'.repeat(20));
        const second = h.state().usage.contextTokens;
        assert(second > first, `上下文占用应随历史增长，实际 ${first} → ${second}`);

        // 清空之后必须归零：派生值不能残留
        h.state().actions.clear();
        assert(h.state().usage.contextTokens === 0,
            `清空后上下文应归零，实际 ${h.state().usage.contextTokens}`);
        assert(h.state().usage.totalTokens === 0, '清空后累计也应归零');
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
    const fillBeyondLimit = (h) => {
        const filler = '填'.repeat(600_000);
        const round = (i, content) => ([
            { id: `u${i}`, role: 'user', content: `第${i}轮`, at: i * 2 },
            { id: `a${i}`, role: 'assistant', content, at: i * 2 + 1 },
        ]);
        h.setMessages([
            ...round(0, filler),
            ...round(1, filler),
            ...round(2, filler),
            ...round(3, '最近一轮的内容'),
            ...round(4, '倒数第二轮'),
            ...round(5, '最新一轮'),
        ]);
    };

    await check('达到门槛即 contextFull 为真', async () => {
        const h = buildAgentHarness();
        assert(h.state().contextFull === false, '空会话不该算满');

        fillBeyondLimit(h);
        const st = h.state();
        assert(st.usage.contextTokens >= CONTEXT_LIMIT_TOKENS,
            `构造前提：上下文应已越过门槛，实际 ${st.usage.contextTokens}`);
        assert(st.contextFull === true, '越过门槛后 contextFull 必须为真');
    });

    /**
     * send() 必须直接拒绝 —— 这是唯一的入口闸门。
     *
     * 界面禁用只是第一道；错误横幅的「重试」、未来的快捷键、以及任何直接调
     * actions.send 的路径都会绕过 disabled。少了这一层，输入框锁着也拦不住。
     */
    await check('超限时 send 直接拒绝，不发起任何模型调用', async () => {
        const h = buildAgentHarness();
        fillBeyondLimit(h);
        const callsBefore = h.chats.length;

        await h.send('这条不该发出去');

        assert(h.chats.length === callsBefore,
            `不得发起模型调用，实际从 ${callsBefore} 变成 ${h.chats.length}`);
        assert(h.state().error.includes('上限'),
            `应给出明确原因，实际：${h.state().error}`);
        assert(!h.state().messages.some((m) => m.content === '这条不该发出去'),
            '被拒绝的提问不得进对话流');
    });

    /** 门槛是 >= 而不是 >：正好等于时也要拦住 */
    await check('正好等于门槛时也拦住（>= 语义）', async () => {
        const h = buildAgentHarness();
        // 用中文字符凑一个刚好到门槛的上下文。estimateTokens 对 CJK 是 1.5 字符/token，
        // 所以要 n 个 token 就写 ceil(n * 1.5) 个汉字。
        const chars = Math.ceil(CONTEXT_LIMIT_TOKENS * 1.5);
        h.setMessages([{ id: 'u0', role: 'user', content: '填'.repeat(chars), at: 0 }]);

        const tokens = h.state().usage.contextTokens;
        assert(tokens >= CONTEXT_LIMIT_TOKENS,
            `构造前提：应达到门槛，实际 ${tokens}`);

        const callsBefore = h.chats.length;
        await h.send('等于门槛也不该放行');
        assert(h.chats.length === callsBefore, '等于门槛时必须拒绝（判据是 >=）');
    });

    /** 严格小于门槛时必须放行 —— 否则用户会被永久锁死 */
    await check('严格小于门槛时正常放行', async () => {
        const h = buildAgentHarness();
        // 目标：凑到门槛的九成左右，确保严格小于
        const chars = Math.floor(CONTEXT_LIMIT_TOKENS * 1.5 * 0.9);
        h.setMessages([{ id: 'u0', role: 'user', content: '填'.repeat(chars), at: 0 }]);

        const tokens = h.state().usage.contextTokens;
        assert(tokens < CONTEXT_LIMIT_TOKENS,
            `构造前提：应严格小于门槛，实际 ${tokens}`);
        assert(h.state().contextFull === false, '未达门槛不该算满');

        await h.send('这条应该发得出去');
        assert(h.state().messages.some((m) => m.content === '这条应该发得出去'),
            '未达门槛时提问必须能正常发出');
    });

    /**
     * 压缩必须能把上下文拉回门槛以下，否则"压缩后即可继续"是空话。
     */
    await check('压缩后上下文回落，输入框重新可用', async () => {
        const h = buildAgentHarness();
        fillBeyondLimit(h);
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
        const h = buildAgentHarness();
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

        // 分界线是 compact 排下的一次 setState，必须让它落地再发下一轮：
        // 否则 send 读到的 messagesRef 还是压缩前的快照，测的就不是产品行为。
        // 真实 React 里这次重渲染由 setState 自动触发，harness 得手动 flush。
        h.state();

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
        const h = buildAgentHarness();
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
        const h = buildAgentHarness();

        // 空会话：分界线之后 0 条，任何档位都算不出覆盖数
        assert(await h.state().actions.compact() === null, '空会话应返回 null');
        assert(h.chats.length === 0, '不得发起摘要调用');

        // 1 条消息配 40% 档：floor(1*0.4)=0，同样无可压内容
        h.setMessages([{ id: 'u0', role: 'user', content: '只有一条', at: 0 }]);
        h.state().actions.setCompactRatio(0.4);
        const before = h.chats.length;

        const record = await h.state().actions.compact();

        assert(record === null, '按当前档位算不出覆盖数时应返回 null');
        assert(h.chats.length === before, '不得发起摘要调用');
        assert(!h.state().messages.some((m) => m.compaction), '不得落压缩消息');
    });

    /** 非法档位直接忽略，不能让脏值把判据搞成 NaN */
    await check('setCompactRatio 拒绝非法档位', async () => {
        const h = buildAgentHarness();
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
        const h = buildAgentHarness();

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
    });

    /** 清空之后两个判据都要回落，不能残留 */
    await check('清空后 canCompact 与 contextFull 都回落', async () => {
        const h = buildAgentHarness();
        for (let i = 0; i < 5; i += 1) await h.send(`第${i}轮`);
        assert(h.state().canCompact === true, '构造前提：应可压缩');

        h.state().actions.clear();
        assert(h.state().canCompact === false, '清空后不该可压缩');
        assert(h.state().contextFull === false, '清空后不该算满');
        assert(h.state().usage.contextTokens === 0, '清空后上下文占用应归零');
    });
    /** 摘要为空是失败，不能把一段历史换成空白还报成功 */
    await check('摘要为空视为失败，历史不动', async () => {
        const h = buildAgentHarness({ compactReply: '   ' });
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
        const h = buildAgentHarness({ hold: gate, holdAt: 5 });
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
        const h = buildAgentHarness();
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
        const h = buildAgentHarness();
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
            summarizedMessages: 3,
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
            summary: 'S', upTo: 'a1', at: 1, coveredMessages: 1, summarizedMessages: 1,
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
        const src = fs.readFileSync(SRC_PATH, 'utf8');
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
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        assert(src.includes('${COMPACT_PREFIX}'), '提示词应以插值引用 COMPACT_PREFIX，不手抄');

        const compacted = {
            summary: 'S', upTo: 'u1', at: 1, coveredMessages: 1, summarizedMessages: 1,
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

    /* --------------------------- 统计与压缩的界面接线 --------------------------- */

    await check('用量条与压缩按钮接到界面上（不是只有 hook）', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        assert(/<UsageBar usage=\{usage\} contextFull=\{contextFull\}/.test(src),
            '用量条必须接上（否则 hook 里算了没人看）');
        assert(/actions\.compact\(\)/.test(src), '压缩按钮必须接到 actions.compact');
        assert(/compactDisabled/.test(src), '压缩必须受禁用条件控制');
        assert(/<CompactionDivider compaction=\{message\.compaction\}/.test(src),
            '对话流里必须画出压缩分界线 —— 否则用户以为模型还记得被压掉的内容');
        assert(/CONTEXT_LIMIT_TOKENS/.test(src),
            '进度条分母必须与 hook 的硬门槛同源，界面不得自己写一个数');
    });

    /**
     * 压缩按钮必须**常驻**，不能按任何阈值显隐。
     *
     * 藏起来的两个后果都很实在：用户不知道有这个功能；压缩是不可逆的历史
     * 改写，什么时候压该由他决定，而不是由程序按某个数替他决定。
     * 所以状态全走 disabled + 提示文案，而不是"要不要渲染这个按钮"。
     */
    await check('压缩按钮常驻，只按能否压缩禁用', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');

        const at = src.indexOf('压缩：**常驻**按钮');
        assert(at > 0, '应能找到压缩按钮（注释里写明了它常驻）');
        const block = src.slice(at, src.indexOf('onClick={actions.clear}', at));

        assert(/onClick=\{\(\) => void actions\.compact\(\)\}/.test(block),
            '压缩按钮必须接到 actions.compact');
        assert(/disabled=\{compactDisabled\}/.test(block),
            '必须走 disabled 而不是条件渲染');
        // 关键：不能出现任何形式的条件包裹
        assert(!/\{contextFull && \(/.test(block),
            '不得用 contextFull 决定按钮是否渲染');
        assert(!/\{canCompact && \(/.test(block),
            '不得用 canCompact 决定按钮是否渲染');
        // 但 contextFull 仍应参与样式：达到门槛时把它顶出来（那一刻它是唯一出路）
        assert(/contextFull/.test(block),
            'contextFull 应只影响样式（达到门槛时高亮），不影响是否渲染');
    });

    /** 禁用原因必须分开表述，否则用户只会反复点一个按不动的按钮 */
    await check('压缩的禁用原因分开表述（运行中 / 压缩中 / 条数不足）', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        const at = src.indexOf('const compactDisabled =');
        assert(at > 0, '应有 compactDisabled');
        const block = src.slice(at, src.indexOf('const persist =', at));

        assert(/busy \|\| compacting \|\| !canCompact/.test(block),
            '禁用条件应同时覆盖运行中 / 压缩中 / 条数不足');
        assert(/const compactHint/.test(block), '应有分开的提示文案');
        assert(/运行中/.test(block) && /条消息|档位/.test(block),
            '提示文案要区分"等一等"与"按当前档位消息不够"这两种完全不同的处置');
        assert(/minCompactMessages/.test(block),
            '条数下限必须按当前档位算出来，界面手抄一个数会漂移');
    });

    /**
     * 达到门槛时输入框必须真的锁死。
     *
     * 只改 placeholder 是不够的：用户仍会往里打字，然后奇怪为什么发不出去。
     * textarea 与发送按钮都要 disabled，且整块换成明确的说明。
     */
    await check('超限时输入框与发送按钮都禁用', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');

        const at = src.indexOf('const inputLocked =');
        assert(at > 0, '应有 inputLocked 判据');
        const decl = src.slice(at, src.indexOf('const persist =', at));
        assert(/const inputLocked = contextFull/.test(decl),
            'inputLocked 必须直接由 contextFull 决定，不得掺入别的条件');
        assert(/const inputDisabled = inputLocked \|\| busy \|\| compacting/.test(decl),
            'inputDisabled 应同时覆盖超限、运行中与压缩中（压缩在途时发新提问会顶掉锚点）');

        // 输入区：超限时走另一条分支，而不是把 textarea 留在那儿。
        // 用固定窗口而不是找某个收尾标签：嵌套的 </div> 有几十个，
        // 靠 indexOf 猜边界会在下次改版时静默截错（截短了断言就白测了）
        const areaAt = src.indexOf('{inputLocked ? (');
        assert(areaAt > 0, '输入区必须按 inputLocked 分支渲染');
        // 收尾锚点取输入区之后那个标签页内容容器。不能用固定长度窗口：
        // 输入块有 60 多行，窗口开小了会把发送按钮截在窗口外 ——
        // 断言看着在跑，实际什么也没测到（本用例就曾因此漏报）。
        const areaEnd = src.indexOf('custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2.5', areaAt);
        assert(areaEnd > areaAt, '找不到输入区之后的锚点（面板结构变了，请更新本用例）');
        const area = src.slice(areaAt, areaEnd);

        assert(/disabled=\{inputDisabled\}/.test(area), 'textarea 必须绑 inputDisabled');
        assert(/disabled=\{!input\.trim\(\) \|\| inputDisabled\}/.test(area),
            '发送按钮也要绑 inputDisabled（否则按钮可点但发不出去）');
        assert(/输入已锁定/.test(area), '锁定时必须明确说明原因，而不是只留一个灰输入框');
        assert(/canCompact \? /.test(area),
            '锁定时要按 canCompact 给出不同的出路（压缩 / 清空），不能只报"锁了"');
    });

    /**
     * 超限的横幅必须在**任何标签页**都显示。
     *
     * 与"该压缩了"那种提示不同，这是一条硬拦截：输入框已锁死，用户如果
     * 正好在规则页调东西，不告诉他为什么就切回去，他会对着打不了字的输入框发懵。
     */
    await check('超限横幅不限定标签页，且给出可执行的出路', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        const at = src.indexOf('const showContextBanner =');
        assert(at > 0, '应有 showContextBanner');
        const block = src.slice(at, src.indexOf('const hasBanner', at));

        assert(/const showContextBanner = contextFull;/.test(block),
            '超限横幅必须只看 contextFull，不得再限定 activeTab');
        assert(!/activeTab/.test(block),
            '不得按标签页隐藏 —— 输入框锁死时用户在任何页面都需要知道原因');
    });

    /**
     * 超限时「重试」按钮不该显示。
     *
     * send() 会直接拒绝它，挂一个按不动的按钮只会让用户以为"重试也没用"。
     */
    await check('超限时隐藏重试按钮', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        const at = src.indexOf('重试：用同一句提问再跑一次');
        assert(at > 0, '应能找到重试按钮');
        const block = src.slice(at, at + 400);
        assert(/!busy && !inputLocked && !compacting && lastPrompt/.test(block),
            '重试必须同时排除超限与压缩中：send() 会拒绝，按钮不该挂在那里骗人');
    });

    /**
     * canCompact 的判据必须与 compact() 里的闸门**同一个表达式**。
     *
     * 不一致时按钮会是可点的，但点了什么都不发生 —— 用户看到的是"坏了"。
     * 同源的载体是一个具名函数：两处都调 compactCoverCount，分界线之后的消息数
     * 配当前档位，>= 1 才算压得动。
     */
    await check('canCompact 与 compact() 的条数闸门同源', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        assert(/const \{ messages: live, summary: priorSummary \} = splitByCompaction\(list\);/.test(src),
            'compact() 里应先取分界线之后的消息，全量重算会把压过的再压一遍');
        assert(/const coverCount = compactCoverCount\(live\.length, compactRatio\);/.test(src),
            'compact() 里应按分界线之后的消息数与当前档位算覆盖数');
        assert(/if \(coverCount < 1\) return null;/.test(src),
            'compact() 里覆盖数为 0 时必须返回 null');
        assert(/canCompact: compactCoverCount\(splitByCompaction\(messages\)\.messages\.length, compactRatio\) >= 1/.test(src),
            'canCompact 必须用同一个函数与同一种比较，否则按钮可点但无效果');
        assert(!/COMPACT_KEEP_ROUNDS/.test(src),
            '轮次常量必须彻底移除，留着就是下一个漂移的源头');
    });

    /**
     * 压缩分界线只能"删除"（= 撤销这次压缩），不能"回退"。
     *
     * 回退是"从某条起往后全砍掉"，而分界线只是压缩的记账位置、不是一次发言。
     * 撤销压缩时"删掉它"比"从它开始砍"更贴切 —— 两个按钮并存只会让人犹豫。
     * 删除是有意义的：删掉它，被覆盖的原文会重新进上下文（见 splitByCompaction），
     * 这是用户对摘要质量不满意时的唯一退路。
     */
    await check('压缩分界线可撤销（删除），但不提供回退', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        const at = src.indexOf('if (message.compaction) {');
        assert(at > 0, '应能找到压缩消息的特判');
        // 特判块到下一个 role 判断为止
        const block = src.slice(at, src.indexOf("if (message.role === 'user')", at));

        assert(/return <CompactionDivider|CompactionDivider compaction=/.test(block),
            '压缩消息应渲染分隔条');
        assert(/onClick=\{onRemove\}/.test(block),
            '必须给撤销入口：压缩是模型生成的摘要，质量不满意时用户得有退路');
        assert(!/onRewind/.test(block),
            '不得给回退：分界线不是一次发言，撤销压缩用删除表达更贴切');
        assert(/disabled=\{!canEdit\}/.test(block), '撤销必须受运行中禁用控制');
    });

    /**
     * 撤销压缩这条链路必须真的通到 hook：界面上的删除按钮走的是 removeMessage，
     * 而 removeMessage 一删掉分界线，splitByCompaction 就找不到它了 —— 于是
     * 原文重新进上下文。这条断言把"按钮 → removeMessage"钉住，
     * 否则按钮可能接到了一个只改本地 state 的假动作。
     */
    await check('撤销压缩后原文重新进上下文（端到端）', async () => {
        const h = buildAgentHarness();
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
            const h = buildAgentHarness();
            h.setMessages(Array.from({ length: 10 }, (_, i) => (
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
        const h = buildAgentHarness();
        h.setMessages(Array.from({ length: 5 }, (_, i) => (
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
        const h = buildAgentHarness();
        h.setMessages(Array.from({ length: 10 }, (_, i) => (
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
        const h = buildAgentHarness({ hold: gate, holdAt: 5 });
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
     * 压缩在途时历史被改（程序化路径绕过了界面锁），落盘前必须放弃。
     *
     * 锚点没了还硬插，insertAfterId 会兜底追加到末尾，摘要就名义上覆盖
     * 全部历史 —— 保留的那些被静默吞掉。丢弃是安全方向：历史原样不动，
     * 只是白花一次调用。
     */
    await check('压缩中锚点被删则丢弃本次摘要，历史不动', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const h = buildAgentHarness({ hold: gate, holdAt: 5 });
        for (let i = 0; i < 4; i += 1) await h.send(`第${i}轮`);
        // 8 条消息配 60% 档：覆盖前 4 条，upTo 是第 4 条
        const anchorId = h.state().messages[3].id;

        const pending = h.state().actions.compact();
        h.state();
        h.state().actions.removeMessage(anchorId);
        h.state(); // 让删除提交、messagesRef 同步：真 React 里网络往返的时间足够 commit

        release();
        const record = await pending;
        assert(record === null, '锚点已失效应返回 null');
        assert(!h.state().messages.some((m) => m.compaction), '不得落压缩消息');
        assert(h.state().error.includes('变化'), `应说明历史变了，实际：${h.state().error}`);
        assert(h.state().messages.length === 7, '除被删的那条外历史应原样不动');
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
        const h = buildAgentHarness({ hold: gate, holdAt: 5 });
        for (let i = 0; i < 4; i += 1) await h.send(`第${i}轮`);

        const first = h.state().actions.compact();
        h.state();
        const second = await h.state().actions.compact();

        assert(second === null, '第二次调用（仍在途）应返回 null');
        assert(h.chats.length === 5, `只应发起一次摘要调用，实际 ${h.chats.length} 次`);

        release();
        assert(await first, '第一次应正常完成');
    });

    /** 四个档位按钮必须接到 setCompactRatio，而不是摆设 */
    await check('压缩档位按钮接到界面上', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        assert(/COMPACT_RATIOS/.test(src), '面板应引用档位常量，不得手抄 40/60/80/100');
        assert(/COMPACT_RATIOS\.map/.test(src), '四个档位应由常量渲染，增删档位不用改界面');
        assert(/onClick=\{\(\) => actions\.setCompactRatio\(ratio\)\}/.test(src),
            '档位按钮必须接到 actions.setCompactRatio');
        assert(/disabled=\{busy \|\| compacting\}/.test(src),
            '运行中 / 压缩中不得切档（切了也不会影响在途的那次，反而让人困惑）');
    });

    console.log(`Agent 工具派发：通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
        for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
        return false;
    }
    return true;
};

module.exports = { run };
