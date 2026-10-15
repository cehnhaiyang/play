'use strict';
/**
 * 桥的**反方向**：插件 → 应用 的请求。
 *
 * ## 为什么单独一个文件
 *
 * `bridge.test.js` 是静态契约（表 ↔ 注册逐条比对），跑不了异步。而这条路径
 * 的失效方式恰恰是**运行时**的：主进程收下请求却没人处理、回了包但形状不对、
 * 或者干脆不回 —— 三种都表现为插件侧一直等到超时，静态比对一条都抓不到。
 *
 * ## 为什么必须用真 socket
 *
 * 被测的是 `app/main/bridge.js` 的**真实实现**：TCP 分帧、token 校验、
 * 请求分派、回包编码。把 `handleLine` 抠出来单测会绕过前两样，而"分帧写错"
 * 正是这类代码最常见的事故（一次 data 不保证正好一行）。
 *
 * ## APPDATA 必须换掉
 *
 * `bridge.js` 的端点文件路径在**模块求值时**从 `process.env.APPDATA` 算出。
 * 不换的话，这个测试会覆写用户正在运行的应用写下的端点文件（里面是活动端口
 * 与 token），把活的桥打断。所以先把它指到临时目录，再 require。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

let pass = 0;
const fails = [];

/** 一个步骤 = 一项。抛错即失败，不影响后续步骤 */
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

/** 用临时 APPDATA 隔离端点文件，测试结束前不碰用户真实的那个 */
const sandboxAppData = path.join(os.tmpdir(), 'the-play-bridge-test');

/** settings.js 在非 Electron 宿主下的回落位置（见它的 settingsPath） */
const settingsDir = path.join(os.tmpdir(), 'the-play-settings');
const settingsFile = path.join(settingsDir, 'settings.json');

/** 种一份可辨认的配置，用来证明插件拿到的就是**应用持有的那一份** */
const SEEDED = {
    baseUrl: 'http://127.0.0.1:9999/v1',
    apiKey: 'seeded-key',
    model: 'seeded-model-for-bridge-test',
    reasoningEffort: 'high',
};

/** 起连接、按 host.js 的顺序发一条请求、收一条应答 */
const roundTrip = (port, token, request, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = '';
    const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`等待应答超时（${timeoutMs}ms）：${request.method}`));
    }, timeoutMs);

    const finish = (error, value) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
    };

    socket.on('connect', () => {
        // 与 host.js 一致：第一行带 token 握手，第二行才是业务请求
        socket.write(`${JSON.stringify({ hello: 'theplay-host', token })}\n`);
        socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        try {
            finish(null, JSON.parse(line));
        } catch (e) {
            finish(new Error(`回包不是合法 JSON：${line.slice(0, 200)}`));
        }
    });

    socket.on('error', (e) => finish(e));
});

const runAsync = async () => {
    pass = 0;
    fails.length = 0;

    const priorAppData = process.env.APPDATA;
    const priorSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;

    process.env.APPDATA = sandboxAppData;
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsFile, `${JSON.stringify({ proxyPort: '', ai: SEEDED }, null, 2)}\n`, 'utf8');

    const bridge = require('../app/main/bridge.js');
    const settings = require('../app/main/settings.js');

    /**
     * 分派器照抄 main.js 里注册的那一条。这里**不 require main.js** ——
     * 它一求值就要 electron 的 app / BrowserWindow，在纯 Node 里起不来。
     *
     * 但取数据的那一步用的是**产品自己的** `getPluginSettings()`，不是桩：
     * 于是"插件拿到的就是应用持有的那一份、且形状是插件要读的 `.ai`"这件事
     * 仍然被真值验证 —— 手抄一份 `{ ai: getSettings().ai }` 就只能证明
     * "我以为它是这么写的"。
     */
    const dispatcher = async (method) => {
        switch (method) {
            case 'settings-get':
                return settings.getPluginSettings();
            default:
                throw new Error(`应用不认识的桥端点：${method}`);
        }
    };
    bridge.setRequestHandler(dispatcher);

    let started = false;
    try {
        await bridge.start();
        started = true;

        const endpointFile = path.join(sandboxAppData, 'the-play', 'bridge-endpoint.json');
        assert(fs.existsSync(endpointFile), '端点文件没写出来，桥没真正起来');
        const endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));

        /* ------------------------------ 1. 正向 ------------------------------ */

        let reply;
        await step('插件读到的 AI 配置就是应用持有的那一份（含模型、地址、档位）', async () => {
            reply = await roundTrip(endpoint.port, endpoint.token, { id: 'req-1', method: 'settings-get' });
            eq(reply.id, 'req-1', '回包必须带上原请求的 id —— 不带的话插件无从把应答对回请求');
            eq(reply.ok, true, `settings-get 应当成功，实际 ${JSON.stringify(reply)}`);
            eq(reply.result?.ai?.model, SEEDED.model,
                '插件拿到的模型不是应用持有的那一份 —— 这正是"设置里改了模型、Agent 不跟着变"');
            eq(reply.result.ai.baseUrl, SEEDED.baseUrl, '地址也必须是应用持有的那一份');
            eq(reply.result.ai.reasoningEffort, SEEDED.reasoningEffort, '档位同样要跟着应用走');
        });

        /* ------------------------------ 2. 未知端点 ------------------------------ */

        await step('不认识的端点明确失败（不回一个"成功但空"的结果）', async () => {
            const unknown = await roundTrip(endpoint.port, endpoint.token, { id: 'req-2', method: 'nope-nope' });
            eq(unknown.id, 'req-2', '失败回包也要带 id');
            eq(unknown.ok, false, '不认识的端点必须明确失败，不能回一个空结果当成功');
            assert(/不认识的桥端点/.test(unknown.error || ''),
                `错误信息应说清是端点不认识，实际：${JSON.stringify(unknown.error)}`);
        });

        /* ------------------------------ 3. 没有分派器 ------------------------------ */

        await step('应用未注册分派器时也回包（不让插件等满超时）', async () => {
            bridge.setRequestHandler(null);
            const idle = await roundTrip(endpoint.port, endpoint.token, { id: 'req-3', method: 'settings-get' });
            eq(idle.ok, false, '没有分派器时要回失败');
            assert(/尚未就绪/.test(idle.error || ''),
                `错误信息应指出分派器未注册，实际：${JSON.stringify(idle.error)}`);
            bridge.setRequestHandler(dispatcher);
        });

        /* ------------------------------ 4. token 不对就不认 ------------------------------ */

        await step('token 不对的连接拿不到任何应答', async () => {
            // 本机任何进程都能连这个端口，token 是唯一的门槛（见 bridge.js 文件头）
            const bad = await roundTrip(endpoint.port, 'wrong-token', { id: 'req-4', method: 'settings-get' })
                .then(() => 'answered', (e) => `rejected:${e.message}`);
            assert(bad.startsWith('rejected'), `token 不对的连接不该收到任何应答，实际：${bad}`);
        });

        /* ------------------------------ 5. 相邻请求不串线 ------------------------------ */

        await step('并发两条请求各自拿到自己的应答（分帧与 id 配对都要对）', async () => {
            // 两条请求写在同一个 TCP 段里是最自然的并发形态，也是分帧最容易错的地方
            const socket = net.createConnection({ host: '127.0.0.1', port: endpoint.port });
            const lines = [];
            const got = new Promise((resolve, reject) => {
                const timer = setTimeout(() => { socket.destroy(); reject(new Error('等两条应答超时')); }, 5000);
                socket.on('data', (chunk) => {
                    for (const part of chunk.toString('utf8').split('\n')) {
                        if (!part) continue;
                        lines.push(JSON.parse(part));
                        if (lines.length === 2) { clearTimeout(timer); socket.destroy(); resolve(); }
                    }
                });
                socket.on('error', reject);
            });
            await new Promise((r) => socket.on('connect', r));
            socket.write(`${JSON.stringify({ hello: 'theplay-host', token: endpoint.token })}\n`);
            socket.write(`${JSON.stringify({ id: 'a', method: 'settings-get' })}\n${JSON.stringify({ id: 'b', method: 'settings-get' })}\n`);
            await got;

            eq(lines.length, 2, '两条请求应回两条，且各自独立成行');
            eq(lines.map((l) => l.id).sort().join(','), 'a,b', '回包的 id 集合应与请求一致');
            for (const line of lines) eq(line.result?.ai?.model, SEEDED.model, `id=${line.id} 的应答内容不对`);
        });
    } finally {
        if (started) bridge.stop();
        if (priorSettings === null) fs.rmSync(settingsFile, { force: true });
        else fs.writeFileSync(settingsFile, priorSettings, 'utf8');
        fs.rmSync(sandboxAppData, { recursive: true, force: true });
        if (priorAppData === undefined) delete process.env.APPDATA;
        else process.env.APPDATA = priorAppData;
    }

    if (fails.length > 0) {
        console.log(`桥·插件请求方向：通过 ${pass} 项，失败 ${fails.length} 项`);
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
        return false;
    }
    console.log(`桥·插件请求方向：通过 ${pass} 项，失败 0 项`);
    return true;
};

module.exports = { runAsync };
