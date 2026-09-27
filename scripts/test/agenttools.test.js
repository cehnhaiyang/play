'use strict';
/**
 * Agent 新工具（tamper_rules / storage / tokens）的派发回归。
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

const ROOT = path.join(__dirname, '..', '..');

/**
 * 被测源码路径。
 *
 * 可用 AGENT_SRC 覆盖 —— 变异测试靠它指向一份**改坏的副本**，
 * 从而在不碰产品文件的前提下验证断言真的能失败。
 */
const SRC_PATH = process.env.AGENT_SRC || path.join(ROOT, 'hooks', 'useAgent.ts');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

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
 * 抽 buildTranscript 求值（含它依赖的 truncateBytes / takeRecentRounds / 两个常量）。
 *
 * 同样切片求值而不是走 hook：这个函数是**纯的**，而它要防的是
 * 「模型看不到上一轮」这种整轮失忆 —— 直接对输入输出下断言最省事也最硬。
 *
 * 两个常量从源码里抓真实值，不在测试里重写一遍：重写的话产品把预算调小、
 * 测试却仍按旧值断言，裁剪行为的变化就漏过去了。
 */
const loadBuildTranscript = () => {
    const grab = (marker, endMarker) => {
        const start = SRC.indexOf(marker);
        if (start < 0) throw new Error(`useAgent.ts 里找不到 ${marker}`);
        const end = SRC.indexOf(endMarker, start);
        if (end < 0) throw new Error(`找不到 ${marker} 的结尾`);
        return SRC.slice(start, end + endMarker.length);
    };
    const constOf = (name) => {
        const m = SRC.match(new RegExp(`const ${name} = ([0-9_]+);`));
        if (!m) throw new Error(`useAgent.ts 里找不到常量 ${name}`);
        return `const ${name} = ${m[1].replace(/_/g, '')};`;
    };

    const code = [
        constOf('TRANSCRIPT_BUDGET_BYTES'),
        constOf('TRANSCRIPT_RESULT_LIMIT_BYTES'),
        grab('const byteLength = (text: string): number =>', ';'),
        grab('const truncateBytes = (', '\n};'),
        grab('const takeRecentRounds = (', '\n};'),
        grab('const buildTranscript = (', '\n};'),
    ].join('\n');

    const js = strip(code);
    return new Function(`${js}\nreturn { buildTranscript, TRANSCRIPT_BUDGET_BYTES };`)();
};

const { buildTranscript, TRANSCRIPT_BUDGET_BYTES } = loadBuildTranscript();

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
    // 本轮里已经发起过几次 chat。每一轮（每次 send）开始时归零 ——
    // 用它实现"每轮先调一次工具、再收尾"，而不是按全局调用序号算：
    // 后者会让第 2 轮之后再也拿不到工具调用，造不出"轮内有工具消息"的场景。
    let roundCalls = 0;

    const chat = async (opts) => {
        chats.push(opts.messages.map((m) => ({ role: m.role, content: m.content })));
        roundCalls += 1;
        // hold：卡住**指定那一轮**（默认第 2 轮），用来观察"运行中"这个中间态。
        // 不能卡住每一轮 —— 那样连造初始状态的那次 send 都会挂死。
        if (options.hold && chats.length === (options.holdAt || 2)) await options.hold;
        // toolCall：每轮第一次调用要工具，第二次收尾 —— 于是每轮都有一条工具消息
        if (options.toolCall && roundCalls === 1) {
            return JSON.stringify({ thought: '取数', tool: 'S', args: { action: 'R', code: 'return 1;' } });
        }
        return JSON.stringify({ thought: '答完了', final: `第 ${chats.length} 轮的回答` });
    };

    const persist = {
        loadJSON: (k, d) => (k in store ? store[k] : d),
        saveJSON: (k, v) => { store[k] = v; return true; },
    };

    const UTILS = require('./build/utils/utils.js');
    const fakeWindow = { setTimeout: () => 1, clearTimeout: () => {} };

    // 去掉 import（类型导入 strip 后已消失）与 export；
    // 具名导入原本来自四个模块，删掉 import 后从注入口解构回来。
    const body = [
        'const { useState, useRef, useCallback, useMemo, useEffect } = React;',
        'const { chat } = AiService;',
        'const { buildCookieKeys, collectDroppedRules, decodeJwt, findCookieByKey, generateId, pickJwtCandidates, rewriteJwtPayload } = utils;',
        'const { loadJSON, saveJSON } = persist;',
    ].join('\n') + '\n'
        + strip(SRC)
            .replace(/^import[\s\S]*?from\s+'[^']*';\s*$/gm, '')
            .replace(/^export /gm, '');

    const makeAgent = new Function(
        'React', 'AiService', 'utils', 'persist', 'window', 'TextEncoder',
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

    const factory = makeAgent(ReactProxy, { chat }, UTILS, persist, fakeWindow, TextEncoder);

    const deps = {
        getActiveWebview: () => null,
        onPageReady: () => () => {},
        tamper: {
            state: { interceptRules: [], requestRules: [], headerRules: [], cookies: [], local: {}, session: {} },
            actions: {
                applyRules() {}, saveRules: () => true, getCookies: async () => [],
                setCookie: async () => true, removeCookie: async () => true,
                getLocalStorage: async () => '{}', getSessionStorage: async () => '{}',
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
const buildDispatch = (tamperState, scripts = []) => {
    const helpers = [
        grabBlock('const toRuleString = (value: unknown): string =>', "String(value));"),
        grabBlock('const normalizeFieldRules = (raw: unknown, label: string)', '});\n};'),
        grabBlock('const normalizeHeaderRules = (raw: unknown): HeaderRule[] | string =>', '});\n};'),
        grabBlock('const safeParseObject = (raw: string)', '\n};'),
        // cookie 定位（key 优先、name 仅在无歧义时接受）也是产品代码里的一环，
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
  ranCode: [],
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

    await check('S·R 把 code 交给页面执行并回传结果', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, []);
        const out = await dispatchTool('S', { action: 'R', code: 'return 1+1;' });
        assert(calls.ranCode.length === 1, `应执行一次，实际 ${calls.ranCode.length}`);
        assert(calls.ranCode[0] === 'return 1+1;', '应原样把 code 交给执行器');
        assert(j(out).ok === true, '应回传执行结果');
    });

    await check('S·R 缺 code 时仍会执行（空脚本），不崩', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, []);
        await dispatchTool('S', { action: 'R' });
        assert(calls.ranCode.length === 1, '应执行一次空脚本');
        assert(calls.ranCode[0] === '', '空 code 应传空串');
    });

    /* ------------------------------ S: 列出 ------------------------------ */

    await check('S·L 列出脚本清单', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: 'd', code: 'return 1;', urlPattern: '*x*', enabled: true },
        ]);
        const out = j(await dispatchTool('S', { action: 'L' }));
        assert(Array.isArray(out) && out.length === 1, `应列出 1 条，实际 ${out.length}`);
        assert(out[0].id === 'a' && out[0].name === '甲', 'id 与 name 应正确');
    });

    await check('S·L 空清单返回空数组', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('S', { action: 'L' }));
        assert(Array.isArray(out) && out.length === 0, '应为空数组');
    });

    /* ------------------------------ S: 保存 ------------------------------ */

    await check('S·S 保存脚本并回传 id', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('S', {
            action: 'S', name: '抓取', description: '抓列表', code: 'return 1;', urlPattern: '/list',
        }));
        assert(out.saved === true, '应回 saved:true');
        assert(typeof out.id === 'string' && out.id, '应回 id');
        assert(scriptsRef.current.length === 1, '脚本清单应多一条');
        assert(scriptsRef.current[0].urlPattern === '/list', 'urlPattern 应写入');
    });

    await check('S·S 缺 code 报错且不写入', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('S', { action: 'S', name: 'x' }));
        assert(typeof out.error === 'string', '应回错误');
        assert(scriptsRef.current.length === 0, '出错时不得写入');
    });

    await check('S·S 只有空白的 code 也算缺', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('S', { action: 'S', code: '   \n  ' }));
        assert(typeof out.error === 'string', '应回错误');
        assert(scriptsRef.current.length === 0, '不得写入');
    });

    await check('S·S 缺 name 回落默认名', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('S', { action: 'S', code: 'return 1;' }));
        assert(out.saved === true, '应成功');
        assert(scriptsRef.current[0].name === '未命名脚本', `默认名应为「未命名脚本」，实际 ${scriptsRef.current[0].name}`);
    });

    // 满了必须明说，不能静默丢弃（旧实现在数组末尾 slice，砍掉的正是刚加的那条）
    await check('S·S 达上限时报错并提示用 D 删', async () => {
        const full = [1, 2, 3].map((i) => ({
            id: 's' + i, name: 'n' + i, description: '', code: 'return 1;', urlPattern: '', enabled: true,
        }));
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, full);
        const out = j(await dispatchTool('S', { action: 'S', code: 'return 2;' }));
        assert(typeof out.error === 'string', '应回错误');
        assert(/D/.test(out.error), `错误里应提示用 D 删除，实际：${out.error}`);
        assert(scriptsRef.current.length === 3, '不得写入');
    });

    /* ------------------------------ S: 删除 ------------------------------ */

    await check('S·D 删除指定脚本', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: '', code: 'return 1;', urlPattern: '', enabled: true },
            { id: 'b', name: '乙', description: '', code: 'return 2;', urlPattern: '', enabled: true },
        ]);
        const out = j(await dispatchTool('S', { action: 'D', id: 'a' }));
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
    await check('S·D 删的是指定那条，不是第一条', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: '', code: 'return 1;', urlPattern: '', enabled: true },
            { id: 'b', name: '乙', description: '', code: 'return 2;', urlPattern: '', enabled: true },
            { id: 'c', name: '丙', description: '', code: 'return 3;', urlPattern: '', enabled: true },
        ]);
        const out = j(await dispatchTool('S', { action: 'D', id: 'b' }));
        assert(out.deleted === true, '应回 deleted:true');
        const ids = scriptsRef.current.map((s) => s.id).join(',');
        assert(ids === 'a,c', `应剩 a,c，实际 ${ids}`);
    });

    await check('S·D 删最后一条', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: '', code: 'return 1;', urlPattern: '', enabled: true },
            { id: 'b', name: '乙', description: '', code: 'return 2;', urlPattern: '', enabled: true },
        ]);
        await dispatchTool('S', { action: 'D', id: 'b' });
        const ids = scriptsRef.current.map((s) => s.id).join(',');
        assert(ids === 'a', `应剩 a，实际 ${ids}`);
    });

    await check('S·D 找不到 id 时报错且不动清单', async () => {
        const { dispatchTool, scriptsRef } = buildDispatch(EMPTY, [
            { id: 'a', name: '甲', description: '', code: 'return 1;', urlPattern: '', enabled: true },
        ]);
        const out = j(await dispatchTool('S', { action: 'D', id: 'nope' }));
        assert(typeof out.error === 'string', '应回错误');
        assert(scriptsRef.current.length === 1, '不得改动清单');
    });

    /* --------------------- S: 大小写与未知 action --------------------- */

    // 模型常把小写 action 写出来；大小写不敏感能省一整步重试
    await check('S 的 action 大小写不敏感', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY, []);
        await dispatchTool('S', { action: 'r', code: 'return 1;' });
        assert(calls.ranCode.length === 1, '小写 r 也应触发运行');
    });

    await check('S 未知 action 报错并列出可用取值', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('S', { action: 'X' }));
        assert(typeof out.error === 'string', '应回错误');
        for (const k of ['R', 'L', 'S', 'D']) {
            assert(out.error.includes(k), `错误里应列出 ${k}，实际：${out.error}`);
        }
    });

    await check('S 缺 action 报错', async () => {
        const { dispatchTool } = buildDispatch(EMPTY, []);
        const out = j(await dispatchTool('S', {}));
        assert(typeof out.error === 'string', '应回错误');
    });

    /* ------------------------- tamper_rules: get ------------------------- */

    await check('tamper_rules get 返回三类规则', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [{ id: 'a', enabled: true, urlPattern: '*', jsonPath: 'vip', newValue: 'true' }],
            request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tamper_rules', { action: 'get' }));
        assert(out.intercept.length === 1, 'intercept 应有 1 条');
        assert(out.intercept[0].jsonPath === 'vip', 'jsonPath 应为 vip');
        assert(Array.isArray(out.headers), 'headers 应为数组');
    });

    /* ------------------- tamper_rules: 部分更新（核心） ------------------- */

    // 模型只想加一条请求头规则，不能把用户的拦截规则清空。
    await check('tamper_rules set 只传 headers 时保留 intercept/request', async () => {
        const { dispatchTool, calls, tamperRef } = buildDispatch({
            intercept: [{ id: 'a', enabled: true, urlPattern: '*', jsonPath: 'vip', newValue: 'true' }],
            request: [{ id: 'b', enabled: true, urlPattern: '*', jsonPath: 'x', newValue: '1' }],
            headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tamper_rules', {
            action: 'set',
            headers: [{ enabled: true, urlPattern: '*', headerName: 'Referer', headerValue: 'https://x' }],
        }));
        assert(out.applied === true, '应回 applied:true');
        assert(out.counts.intercept === 1, `intercept 应保留 1 条，实际 ${out.counts.intercept}`);
        assert(out.counts.request === 1, `request 应保留 1 条，实际 ${out.counts.request}`);
        assert(out.counts.headers === 1, `headers 应为 1 条，实际 ${out.counts.headers}`);
        assert(calls.apply === 1, '应调用 applyRules 一次');
        const st = tamperRef.current.state;
        assert(st.interceptRules[0].jsonPath === 'vip', '拦截规则必须原样保留');
    });

    // 模型改规则立刻生效，但**不能**越过用户写进本地存储。
    await check('tamper_rules set 走 applyRules 而非 saveRules（不落盘）', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        await dispatchTool('tamper_rules', {
            action: 'set',
            intercept: [{ enabled: true, urlPattern: '*', jsonPath: 'vip', newValue: 'true' }],
        });
        assert(calls.apply === 1, `应调用 applyRules，实际 ${calls.apply}`);
        assert(calls.save === 0, `不得调用 saveRules（会持久化），实际 ${calls.save}`);
    });

    await check('tamper_rules set 给规则补上缺失的 id', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tamper_rules', {
            action: 'set',
            intercept: [{ enabled: true, urlPattern: '*', jsonPath: 'vip', newValue: 'true' }],
        }));
        assert(out.applied === true, '应成功');
        assert(out.counts.intercept === 1, '应有 1 条');
    });

    // 模型传真实布尔/数字时，引擎内部会 String() 化；面板的 raw.charAt(0) 会直接抛错。
    await check('tamper_rules set 把非字符串 newValue 收敛成字符串', async () => {
        const { dispatchTool, tamperRef } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        await dispatchTool('tamper_rules', {
            action: 'set',
            intercept: [{ enabled: true, urlPattern: '*', jsonPath: 'vip', newValue: true }],
        });
        const v = tamperRef.current.state.interceptRules[0].newValue;
        assert(typeof v === 'string', `newValue 必须是字符串，实际 ${typeof v}`);
        assert(v === 'true', `newValue 应为 "true"，实际 ${JSON.stringify(v)}`);
    });

    await check('tamper_rules set 非法 action 报错', async () => {
        const { dispatchTool } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tamper_rules', { action: 'nope' }));
        assert(typeof out.error === 'string', '应回错误');
    });

    /**
     * headerValue 的 '' 在引擎里是**删除该请求头**的意思。
     * 所以模型传数字 42 时必须收敛成 "42"；若被当成"非字符串 → 空串"，
     * 用户的请求头会被静默删掉 —— 一个赋值操作变成了破坏操作。
     */
    await check('tamper_rules set 保留数字 headerValue（空串是删除语义）', async () => {
        const { dispatchTool, tamperRef } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('tamper_rules', {
            action: 'set',
            headers: [{ enabled: true, urlPattern: '*', headerName: 'X-Retry', headerValue: 42 }],
        }));
        assert(out.applied === true, '应成功');
        const hv = tamperRef.current.state.headerRules[0].headerValue;
        assert(hv === '42', `headerValue 应为 "42"，实际 ${JSON.stringify(hv)}（空串会删除该请求头）`);
    });

    await check('tamper_rules set 保留布尔 headerValue', async () => {
        const { dispatchTool, tamperRef } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        await dispatchTool('tamper_rules', {
            action: 'set',
            headers: [{ enabled: true, urlPattern: '*', headerName: 'X-Flag', headerValue: false }],
        });
        const hv = tamperRef.current.state.headerRules[0].headerValue;
        assert(hv === 'false', `headerValue 应为 "false"，实际 ${JSON.stringify(hv)}`);
    });

    await check('tamper_rules set 传非数组报错', async () => {
        const { dispatchTool, calls } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper_rules', { action: 'set', intercept: 'oops' }));
        assert(typeof out.error === 'string', '应回错误');
        assert(calls.apply === 0, '出错时不得改引擎状态');
    });

    /* --------------- tamper_rules: 报出被引擎跳过的规则 --------------- */

    /**
     * 引擎对没有目标键的规则直接丢弃（它永远匹配不上），但那是**静默**的。
     * 不回传的话模型收到 applied:true 就以为设置成功了，实际页面里什么都没发生。
     */
    await check('tamper_rules set 报出被跳过的字段规则', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper_rules', {
            action: 'set',
            intercept: [
                { enabled: true, urlPattern: '*', jsonPath: 'vip', newValue: 'true' },
                { enabled: true, urlPattern: '*', jsonPath: '', newValue: 'true' },
            ],
        }));
        assert(out.applied === true, '仍应回 applied:true（规则本身合法，只是有一条无效）');
        assert(Array.isArray(out.dropped), '应带 dropped 数组');
        assert(out.dropped.length === 1, `应有 1 条被跳过，实际 ${out.dropped.length}`);
        assert(out.dropped[0].group === 'intercept', `group 应为 intercept，实际 ${out.dropped[0].group}`);
        assert(out.dropped[0].index === 1, `index 应为 1，实际 ${out.dropped[0].index}`);
        assert(typeof out.dropped[0].reason === 'string' && out.dropped[0].reason, '应说明原因');
    });

    await check('tamper_rules set 报出被跳过的请求头规则', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper_rules', {
            action: 'set',
            headers: [
                { enabled: true, urlPattern: '*', headerName: 'Referer', headerValue: 'x' },
                { enabled: true, urlPattern: '*', headerName: '', headerValue: 'y' },
            ],
        }));
        assert(out.dropped.length === 1, `应有 1 条被跳过，实际 ${out.dropped.length}`);
        assert(out.dropped[0].group === 'headers', 'group 应为 headers');
        assert(out.dropped[0].index === 1, 'index 应为 1');
    });

    // 只有点号的写法引擎也认作"没有目标键"，只判空串会漏报
    await check('tamper_rules set 把只有点号的 jsonPath 也算作被跳过', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper_rules', {
            action: 'set',
            intercept: [{ enabled: true, urlPattern: '*', jsonPath: '.', newValue: '1' }],
        }));
        assert(out.dropped.length === 1, `"." 应被判为无目标键，实际 ${out.dropped.length}`);
    });

    // 已禁用的规则不算"被跳过" —— 那是用户/模型主动关的，报出来是噪音
    await check('tamper_rules set 不把已禁用的规则算作被跳过', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper_rules', {
            action: 'set',
            intercept: [{ enabled: false, urlPattern: '*', jsonPath: '', newValue: '1' }],
        }));
        assert(out.dropped === undefined, `已禁用的规则不该报 dropped，实际 ${JSON.stringify(out.dropped)}`);
    });

    // 全部合法时不该出现 dropped 字段：空数组会让模型误以为"有被跳过的"
    await check('tamper_rules set 全部合法时不含 dropped 字段', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper_rules', {
            action: 'set',
            intercept: [{ enabled: true, urlPattern: '*', jsonPath: 'vip', newValue: 'true' }],
            headers: [{ enabled: true, urlPattern: '*', headerName: 'X', headerValue: '1' }],
        }));
        assert(!('dropped' in out), `不该有 dropped 字段，实际 ${JSON.stringify(out.dropped)}`);
        assert(!/跳过/.test(out.note), `note 不该提跳过，实际 ${out.note}`);
    });

    await check('tamper_rules set 有跳过时 note 里说明条数', async () => {
        const { dispatchTool } = buildDispatch(EMPTY);
        const out = j(await dispatchTool('tamper_rules', {
            action: 'set',
            intercept: [
                { enabled: true, urlPattern: '*', jsonPath: '', newValue: '1' },
                { enabled: true, urlPattern: '*', jsonPath: '.', newValue: '1' },
            ],
        }));
        assert(out.dropped.length === 2, `应有 2 条，实际 ${out.dropped.length}`);
        assert(out.note.includes('2'), `note 应说明条数，实际 ${out.note}`);
    });

    // 部分更新时，未传的那一类若含无效规则，也该被报出来 ——
    // 否则模型会以为"我没动它所以不关我事"，而页面里那类规则确实没生效
    await check('tamper_rules set 也报出未传类别里的无效规则', async () => {
        const { dispatchTool } = buildDispatch({
            ...EMPTY,
            request: [{ id: 'r1', enabled: true, urlPattern: '*', jsonPath: '', newValue: '1' }],
        });
        const out = j(await dispatchTool('tamper_rules', {
            action: 'set',
            headers: [{ enabled: true, urlPattern: '*', headerName: 'X', headerValue: '1' }],
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

    await check('storage remove local', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'remove', area: 'local', key: 'k' }));
        assert(out.removed === true, '应成功');
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
        const out = j(await dispatchTool('storage', { action: 'set', area: 'cookie', name: 'sid', value: 'new' }));
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
            intercept: [], request: [], headers: [], cookies: [], local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'set', area: 'cookie', name: 'n', value: 42 }));
        assert(out.saved === true, '应成功');
        assert(calls.setCookie[0].value === '42', `应为 "42"，实际 ${JSON.stringify(calls.setCookie[0].value)}`);
        assert(out.value === '42', `回显应为 "42"，实际 ${JSON.stringify(out.value)}`);
    });

    await check('storage remove cookie', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [{ name: 'sid', value: 'x' }], local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'remove', area: 'cookie', name: 'sid' }));
        assert(out.removed === true, '应成功');
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

    // 只给 name 且有歧义 -> 必须报错，而不是静默改第一条
    await check('storage set cookie 同名并存时拒绝只给 name', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [
                { name: 'sid', value: 'HOST', domain: 'sub.example.com', path: '/' },
                { name: 'sid', value: 'PARENT', domain: '.example.com', path: '/' },
            ],
            local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'set', area: 'cookie', name: 'sid', value: 'X' }));
        assert(typeof out.error === 'string', `应报错，实际 ${JSON.stringify(out)}`);
        assert(calls.setCookie.length === 0, '有歧义时不该写任何 cookie');
    });

    // 单条同名时只给 name 仍要能用（别修过头）
    await check('storage set cookie 无歧义时 name 仍可用', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [
                { name: 'sid', value: 'old', domain: 'a.com', path: '/', httpOnly: true },
            ],
            local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'set', area: 'cookie', name: 'sid', value: 'new' }));
        assert(out.saved === true, `应成功，实际 ${JSON.stringify(out)}`);
        assert(calls.setCookie[0].httpOnly === true, 'httpOnly 应保留');
    });

    // remove 一个不存在的名字：不能报 removed:true（removeCookie 对不存在的名字也不报错）
    await check('storage remove cookie 不存在时报错', async () => {
        const { dispatchTool, calls } = buildDispatch({
            intercept: [], request: [], headers: [], cookies: [{ name: 'sid', value: 'x' }], local: {}, session: {},
        });
        const out = j(await dispatchTool('storage', { action: 'remove', area: 'cookie', name: 'nope' }));
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
     * 四处定稿点：
     *   1. 中断且已流出正文
     *   2. 中断且只有推理（正文还空着）
     *   3. 最终回复（模型不再要工具）
     *   4. 工具调用（这一步的思考 —— 最能回答"为什么改这个字段"）
     * 少任何一处，那种结束方式下的思考就会随气泡一起消失。
     */
    await check('每一处定稿点都带 reasoning', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const hits = src.match(/reasoning:\s*keepReasoning\(liveReasoning\)/g) || [];
        assert(hits.length === 4,
            `应有 4 处定稿点带上推理（中断两种 / 最终回复 / 工具调用），实际 ${hits.length} 处`);
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

        // 先切出 chat({...}) 这一段，再看它里面的 messages 指向谁。
        // 不写成"messages 后面必须紧跟 reasoningEffort"那种正则：那样参数一换序
        // 就会误报，而误报的代价是下一个人去改测试而不是看代码。
        const start = src.indexOf('await chat({');
        assert(start >= 0, '应能找到 chat() 调用');
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
            msg({ role: 'tool', content: '调用 S·R', label: 'S·R', tool: 'S', result: '{"price":9.9}', ok: true }),
            msg({ role: 'assistant', content: '价格是 9.9' }),
        ]);
        assert(out.length === 3, `应为 user/观察/assistant 三条，实际 ${out.length}`);
        assert(out[1].role === 'user', '观察必须以 user 身份回灌（JSON 协议没有 tool role）');
        assert(out[1].content.includes('[工具 S·R 的执行结果]'),
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
            '工具消息必须带 label 字段：历史里只写 "S" 分不出 R/L/S/D 四个动作');
    });

    await check('推理与脚本源码不进历史', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'assistant', content: '答', reasoning: '很长的思考'.repeat(50) }),
            msg({ role: 'tool', label: 'S·R', tool: 'S', result: 'r', script: 'return secret();' }),
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
     * 界面自己补的提示（中断 / 空回复 / 步数耗尽）不是模型说的话。
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

    /** 同上：三个提示点都必须真的打上 notice 标记 */
    await check('三处界面提示都写入 notice 标记', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const notices = src.match(/^\s*notice: true,$/gm) || [];
        assert(notices.length === 3,
            `中断提示 / 空回复提示 / 步数耗尽提示都应带 notice，实际 ${notices.length} 处`);
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
            msg({ role: 'tool', label: 'S·R', result: 'r' }),
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
     * 写成「[工具 S·自动·x 的执行结果]」会凭空捏造一次模型从未发出的调用 ——
     * 模型据此会以为自己已经跑过那段脚本，从而不再主动取数。
     */
    await check('自动执行的脚本按环境事件写回，不伪装成工具调用', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', content: '自动执行：抓价格', tool: 'S', auto: true, result: '{"p":1}' }),
        ]);
        const blob = JSON.stringify(out);
        assert(blob.includes('[自动脚本'), `应按自动脚本写回，实际：${blob.slice(0, 120)}`);
        assert(!blob.includes('[工具 S·自动'), '不得伪装成模型发出的工具调用');
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
            msg({ role: 'tool', label: 'S·R', result: 'A' }),
            msg({ role: 'tool', label: 'S·L', result: 'B' }),
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
        const buildAt = src.indexOf('buildTranscript(messagesRef.current)', sendAt);
        const appendAt = src.indexOf("appendMessage({ id: generateId(), role: 'user', content: text", sendAt);
        assert(buildAt > 0, 'send 里应调用 buildTranscript(messagesRef.current)');
        assert(appendAt > 0, 'send 里应追加本轮用户消息');
        assert(buildAt < appendAt,
            '必须在 appendMessage 之前读历史，否则本轮提问会重复进上下文');
    });

    await check('send 把历史拼在本轮提问前面', async () => {
        const src = fs.readFileSync(SRC_PATH, 'utf8');
        const m = src.match(/const transcript: AiChatMessage\[\] = \[([^\]]*)\]/);
        assert(m, '应能找到 transcript 的初始化');
        assert(/\.\.\.history/.test(m[1]), `transcript 必须以历史打头，实际：[${m[1]}]`);
        assert(/role: 'user', content: text/.test(m[1]), '本轮提问应排在历史之后');
    });

    await check('超预算时丢最旧的整轮、保留最近的', async () => {
        // 每轮约 1KB，手写 300 轮把预算撑爆，验证裁的是旧的那头。
        // 标记用 round-<i>- 而不是 "<i>:"：后者会被 "100:" 里的 "0:" 子串命中，
        // 断言会对着一条**确实还在**的旧轮次报"没被丢掉"（我第一次就写错了）。
        const big = 'x'.repeat(1024);
        const history = [];
        for (let i = 0; i < 300; i += 1) {
            history.push(msg({ role: 'user', content: `round-${i}-${big}` }));
            history.push(msg({ role: 'assistant', content: `答${i}` }));
        }
        const out = buildTranscript(history);
        const blob = JSON.stringify(out);
        assert(blob.length <= TRANSCRIPT_BUDGET_BYTES + 4096,
            `应被裁剪到预算内（${TRANSCRIPT_BUDGET_BYTES}），实际 ${blob.length}`);
        assert(out.length > 0, '不能裁成空');
        assert(JSON.stringify(out[out.length - 1]).includes('答299'), '必须保留最近一轮');
        assert(!blob.includes('round-0-'), '最旧的一轮应被丢掉');
        assert(!blob.includes('round-50-'), '远超预算的旧轮次都该丢掉');
    });

    await check('单条超长观察被截断，不挤掉同轮的对话', async () => {
        const out = buildTranscript([
            msg({ role: 'user', content: 'q' }),
            msg({ role: 'tool', label: 'S·R', result: 'y'.repeat(40000) }),
            msg({ role: 'assistant', content: '看完了' }),
        ]);
        const observation = out.find((m) => m.content.includes('[工具'));
        assert(observation, '应有观察消息');
        assert(observation.content.includes('已截断'), '超长观察应注明被截断');
        assert(observation.content.length < 40000, '应真的被截断');
        assert(out.some((m) => m.content === '看完了'), '同轮的对话不得因观察过长而丢失');
    });

    await check('孤立观察（无新提问）自然留在上一轮里', async () => {
        // 上一轮结束后页面自己触发了 urlPattern 脚本：此时还没有新的用户提问。
        // 轮次边界只有"新的用户提问"一个，所以这些观察本就还在 current 里没被 flush 过，
        // 不需要任何额外判断 —— 它们自然挂在上一轮尾部，而不是单开一个没有提问的"轮次"。
        const out = buildTranscript([
            msg({ role: 'user', content: '第一轮' }),
            msg({ role: 'assistant', content: '答一' }),
            msg({ role: 'tool', content: '自动执行：x', tool: 'S', auto: true, result: 'R' }),
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
        const observation = second.find((m) => m.content.includes('[工具 S·R 的执行结果]'));
        assert(observation, `第二轮应能看到第一轮的工具结果，实际：${JSON.stringify(second)}`);
        assert(observation.role === 'user', '工具结果必须以 user 身份回灌');
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

    await check('回退：从该条所在轮的提问处整段切掉', async () => {
        const { h, list, second } = await twoRounds();
        // 停在第二轮中间的工具消息上，回退应回到**第二轮的提问**之前
        const inSecond = list.slice(list.indexOf(second)).find((m) => m.role === 'tool');
        assert(inSecond, '第二轮应有工具消息（构造前提）');

        const prompt = h.state().actions.rewindTo(inSecond.id);

        assert(prompt === '第二轮提问', `应返回该轮提问原文，实际 ${JSON.stringify(prompt)}`);
        const after = h.state().messages;
        assert(after.every((m) => m.content !== '第二轮提问'), '第二轮提问及其之后应全部移除');
        assert(after.some((m) => m.content === '第一轮提问'), '第一轮必须原样留着');
        assert(after.length < list.length, '总条数应减少');
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
     * 回退必须切在**轮次边界**上，不能只切那一条。
     *
     * 只砍掉后半截会留下"有提问、没结果"的畸形轮次 —— 下一轮重建上下文时
     * 模型看到自己"被问了却没答"，会以为任务还没开始而重做一遍。
     * 这条断言直接查重建结果：回退后历史里不得有悬空的提问。
     */
    await check('回退后重建的上下文里没有悬空提问', async () => {
        const { h, list, second } = await twoRounds();
        const inSecond = list.slice(list.indexOf(second)).find((m) => m.role === 'tool');
        h.state().actions.rewindTo(inSecond.id);

        const rebuilt = buildTranscript(h.state().messages);
        // 按轮分组：提问是"不以 [ 开头的 user 消息"，观察（[工具…]）属于当前轮。
        // 不变量是**每轮都得有模型的回应** —— 悬空提问会让模型以为自己被问了却没答，
        // 下一轮就会重做一遍。
        let question = null;
        let answered = false;
        const dangling = [];
        for (const m of rebuilt) {
            if (m.role === 'user' && !m.content.startsWith('[')) {
                if (question && !answered) dangling.push(question);
                question = m.content;
                answered = false;
            } else if (m.role === 'assistant') {
                answered = true;
            }
        }
        if (question && !answered) dangling.push(question);

        assert(dangling.length === 0, `这些提问没有回应：${dangling.join(' / ')}`);
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

    console.log(`Agent 工具派发：通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
        for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
        return false;
    }
    return true;
};

module.exports = { run };
