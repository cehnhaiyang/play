'use strict';
/**
 * 插件的模型调用是否**跟着应用里的配置**走。
 *
 * ## 这一条测的是整个 bug 本身
 *
 * 症状："Agent 调用的模型不跟着应用里的配置更改而更改。"
 *
 * 成因不是某一处写错，而是 offscreen 宿主文档里**没有任何东西**知道应用
 * 持有的那份配置：`getAiConfig()` 依次问 electronAPI（offscreen 里不存在）、
 * 扩展的 localStorage（从来没人写过这份配置），最后落到内置的
 * `DEFAULT_AI_CONFIG` —— 每一级都是"合法回落"，所以全程不报错，
 * 只是永远拿着常量去调模型。
 *
 * 因此这里**必须跑 offscreen 的真实实现**（`offscreen/host.ts` 的编译产物），
 * 而不是断言"源码里有没有那一行"。判据是：给宿主文档塞一份 Electron 的
 * API 进去，看它实际发出去的请求体用的是哪个模型。
 *
 * ## 沙箱要给什么
 *
 * 需要 `chrome.runtime`（注册监听、广播增量）与 `fetch`（真正发请求）。
 * **刻意不给 `window.electronAPI`** —— 那正是插件宿主文档的真实处境，
 * 一给就把被测的那条路径绕过去了。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const step = async (name, fn) => {
    try {
        await fn();
        pass++;
    } catch (e) {
        fails.push({ name, message: e && e.message ? e.message : String(e) });
    }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};

const BUILD = path.join(__dirname, 'build');
const HOST_BUILT = path.join(BUILD, 'extension', 'src', 'offscreen', 'host.js');

/**
 * 在一个"没有 electronAPI"的沙箱里求值 offscreen 宿主，返回它注册的消息监听器。
 *
 * `sent` 收集宿主广播出去的消息（增量与终局）。
 *
 * 假 fetch 装在**真实的全局**上（`installFetchStub`），而不是沙箱里：
 * 宿主文档自己的 `chrome` 必须在沙箱里给（它是 MV3 才有的全局），
 * 但它已经编译好的依赖（AiService）是被真实 `require` 求值的，
 * 在那里 `fetch` 解析到的是 Node 的全局 —— 只往沙箱里塞一个 stub 根本拦不住它。
 */
const loadHost = () => {
    const listeners = [];
    const sent = [];

    const chromeStub = {
        runtime: {
            onMessage: { addListener: (fn) => listeners.push(fn) },
            sendMessage: async (message) => { sent.push(message); return undefined; },
        },
    };

    const sandbox = {
        module: { exports: {} },
        exports: {},
        console,
        // offscreen 宿主用 self.setTimeout / self.clearTimeout
        self: { setTimeout, clearTimeout },
        chrome: chromeStub,
        AbortController,
        TextDecoder,
        TextEncoder,
        URL,
    };
    sandbox.exports = sandbox.module.exports;
    sandbox.require = (id) => require(require.resolve(id, { paths: [path.dirname(HOST_BUILT)] }));

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(HOST_BUILT, 'utf8'), sandbox, { filename: HOST_BUILT });

    assert(listeners.length === 1, `offscreen 宿主应在顶层注册一个 onMessage 监听器，实际 ${listeners.length}`);

    return { listener: listeners[0], sent };
};

/** 换掉全局 fetch，把每次请求的地址与请求体记下来 */
const installFetchStub = (bodies) => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const body = init && init.body ? JSON.parse(init.body) : {};
        bodies.push({ url, body });
        // 深度嗅探要一个数组才走完解析；普通补全给一个对象
        const content = /Extract direct media URLs/.test(JSON.stringify(body.messages))
            ? '[{"url":"https://x/y.mp4","title":"y","type":"video"}]'
            : '{"final":"ok"}';
        return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
        };
    };
    return () => { globalThis.fetch = original; };
};

/** 走一次 ai-chat：发消息 → 收广播里的终局 */
const runChat = async (listener, sent, aiConfig) => {
    const requestId = `t-${Math.random().toString(36).slice(2, 8)}`;
    const before = sent.length;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 ai-done 超时')), 5000);
        // 宿主的应答是同步的（立刻回执），终局走广播；这里轮询已发出的广播
        const tick = setInterval(() => {
            if (sent.slice(before).some((m) => m.kind === 'ai-done')) {
                clearInterval(tick);
                clearTimeout(timer);
                resolve();
            }
        }, 5);
        listener(
            {
                target: 'host',
                kind: 'ai-chat',
                requestId,
                aiConfig,
                messages: [{ role: 'user', content: 'hi' }],
            },
            {},
            () => undefined,
        );
    });
    const done = sent.slice(before).find((m) => m.kind === 'ai-done');
    // 收件人必须是 SW 里的 chat-port，不是球 —— 球收不到 chrome.runtime 广播
    eq(done.target, 'chat', 'ai-done 的 target 必须是 chat（chat-port 才认）');
    assert(done && !done.error, `模型调用应当成功，实际：${JSON.stringify(done)}`);
    return done;
};

const runAsync = async () => {
    pass = 0;
    fails.length = 0;

    if (!fs.existsSync(HOST_BUILT)) {
        console.log('插件模型配置：找不到 offscreen 宿主的编译产物，跳过（先跑 test/index.js 编译）');
        return true;
    }

    /** 应用设置里配的那一份。**与 DEFAULT_AI_CONFIG 刻意不同**，否则测不出区别 */
    const APP_CONFIG = {
        baseUrl: 'http://127.0.0.1:7777/v1',
        apiKey: 'app-key',
        model: 'model-from-app-settings',
        reasoningEffort: 'high',
    };
    const DEFAULT = require(path.join(BUILD, 'shared', 'ai', 'AiService.js')).DEFAULT_AI_CONFIG;

    const bodies = [];
    const restoreFetch = installFetchStub(bodies);
    const { listener, sent } = loadHost();

    try {
        await step('模型用的是设置里那一份，而不是内置默认值', async () => {
            await runChat(listener, sent, APP_CONFIG);
            eq(bodies.length, 1, `应当恰好发出一次请求，实际 ${bodies.length}`);
            eq(bodies[0].body.model, APP_CONFIG.model,
                `发出去的模型应是设置里的 ${APP_CONFIG.model}；拿到内置默认值 ${DEFAULT.model} 就是本 bug`);
            assert(bodies[0].body.model !== DEFAULT.model, '测试前提被破坏：两份模型名应当不同');
        });

        await step('地址、密钥、思考档位也全部跟着设置走', async () => {
            eq(bodies[0].url, `${APP_CONFIG.baseUrl}/chat/completions`, '接口地址应来自设置');
            eq(bodies[0].body.reasoning_effort, APP_CONFIG.reasoningEffort, '档位应来自设置');
        });

        await step('设置改成另一份之后，下一次调用就用新的（不缓存）', async () => {
            const changed = { ...APP_CONFIG, model: 'model-changed-by-user', baseUrl: 'http://127.0.0.1:8888/v1' };
            await runChat(listener, sent, changed);
            eq(bodies.length, 2, '第二次调用应当再发一次请求');
            eq(bodies[1].body.model, 'model-changed-by-user', '改了设置之后必须用新模型');
            eq(bodies[1].url, `${changed.baseUrl}/chat/completions`, '地址也应随之改变');
        });

        await step('AI 深度嗅探走的是同一份配置（两条路径不能各读一份）', async () => {
            const before = bodies.length;
            await new Promise((resolve) => {
                listener(
                    { target: 'host', kind: 'ai-extract-links', html: '<a href="https://x/y.mp4">y</a>', title: 't', aiConfig: APP_CONFIG },
                    {},
                    () => resolve(),
                );
            });
            // 等实际请求落地（宿主内部是异步的）
            for (let i = 0; i < 100 && bodies.length === before; i++) await new Promise((r) => setTimeout(r, 20));
            assert(bodies.length > before, '深度嗅探没有发出请求');
            eq(bodies[bodies.length - 1].body.model, APP_CONFIG.model, '深度嗅探也必须用设置里的模型');
        });
    } finally {
        restoreFetch();
    }

    if (fails.length > 0) {
        console.log(`插件模型配置：通过 ${pass} 项，失败 ${fails.length} 项`);
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
        return false;
    }
    console.log(`插件模型配置：通过 ${pass} 项，失败 0 项`);
    return true;
};

module.exports = { runAsync };
