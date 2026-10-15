'use strict';
/**
 * 插件侧那条"向应用要配置"的通路，跑真实的 `bridge-port.ts`。
 *
 * ## 为什么必须跑真实现 + 真 socket
 *
 * 这条链路上每一跳都可能静默失败：
 *
 *   SW ──port.postMessage(id, method)──▶ host.js ──TCP──▶ 应用
 *        ◀──{ id, ok, result }──────────────────────────────
 *
 * 而 `bridge-port` 是**按消息形状**分辨三个方向的（握手 / 应用来的请求 /
 * 应用给的应答）。分错了的表现不是报错，是"请求永远等不到应答"——
 * 也就是超时。所以这里用一个**真的 TCP 服务端**冒充应用，把关卡全部走一遍。
 *
 * ## 沙箱要给什么
 *
 * `chrome.runtime.connectNative` 返回的那个 Port。用一个直连本地 TCP 的
 * 假 Port 顶替它 —— 这正好是复现 host.js 那一段原始字节转发的行为。
 */
const fs = require('fs');
const net = require('net');
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
const PORT_BUILT = path.join(BUILD, 'extension', 'src', 'background', 'bridge-port.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一个假冒"应用"的 TCP 服务端。
 *
 * `onRequest(message, reply)` 决定怎么回；`replies` 记录收到的每一条请求。
 * `sockets` 留着，供"应用退出"那一幕真的把连接掐掉。
 */
const startFakeApp = (onRequest) => new Promise((resolve) => {
    const replies = [];
    const sockets = [];
    const server = net.createServer((socket) => {
        sockets.push(socket);
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            for (;;) {
                const nl = buffer.indexOf('\n');
                if (nl < 0) break;
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (!line.trim()) continue;
                const message = JSON.parse(line);
                if (message.hello) continue; // 握手行
                replies.push(message);
                onRequest(message, (payload) => socket.write(`${JSON.stringify({ id: message.id, ...payload })}\n`));
            }
        });
        socket.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1', () => resolve({
        server,
        port: server.address().port,
        replies,
        /** 模拟"应用退出"：把已建立的连接全部掐断 */
        drop: () => { for (const socket of sockets) socket.destroy(); },
    }));
});

/**
 * 在一个只有 `chrome` 的沙箱里求值 bridge-port，返回它的导出。
 *
 * `connectNative` 造一个直连上面那个 TCP 的假 Port，行为对齐 host.js：
 * 一行一条 JSON，两个方向都是。Port 的 `onMessage` 监听器由沙箱注册，
 * 由这里在收到数据时逐个调用 —— 与 host.js 转发给扩展那一段同形。
 */
const loadBridgePort = (port) => {
    const appListeners = [];
    const disconnectors = [];
    let socket;

    const fakePort = {
        onMessage: { addListener: (fn) => appListeners.push(fn) },
        // 断开监听器同样要收着：插件侧要在断开时让在途请求当场失败
        onDisconnect: { addListener: (fn) => disconnectors.push(fn) },
        postMessage: (message) => {
            socket.write(`${JSON.stringify(message)}\n`);
        },
    };

    const chromeStub = {
        runtime: {
            connectNative: () => {
                socket = net.createConnection({ host: '127.0.0.1', port });
                let buffer = '';
                socket.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                    for (;;) {
                        const nl = buffer.indexOf('\n');
                        if (nl < 0) break;
                        const line = buffer.slice(0, nl);
                        buffer = buffer.slice(nl + 1);
                        if (!line.trim()) continue;
                        for (const fn of appListeners) fn(JSON.parse(line));
                    }
                });
                socket.on('error', () => undefined);
                // 对端断开时 Chrome 会触发 onDisconnect，这里照做
                socket.on('close', () => { for (const fn of disconnectors) fn(); });
                return fakePort;
            },
        },
    };

    /*
     * 沙箱里的定时器由这里统一收着。
     *
     * bridge-port 断线后会**自己重连**（见 scheduleReconnect），那是产品行为、
     * 不该改。但那些重连定时器会一直挂在事件循环上，测试跑完进程不退出 ——
     * 所以收口在这一侧：结束时把它们全部清掉。
     */
    const timers = new Set();
    const sandboxSetTimeout = (fn, ms) => {
        const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
        timers.add(id);
        return id;
    };

    const sandbox = {
        module: { exports: {} },
        exports: {},
        console,
        chrome: chromeStub,
        setTimeout: sandboxSetTimeout,
        clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    };
    sandbox.exports = sandbox.module.exports;
    sandbox.require = (id) => require(require.resolve(id, { paths: [path.dirname(PORT_BUILT)] }));
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(PORT_BUILT, 'utf8'), sandbox, { filename: PORT_BUILT });
    return {
        port: sandbox.module.exports,
        close: () => {
            if (socket) socket.destroy();
            for (const id of timers) clearTimeout(id);
            timers.clear();
            // 重连是断开时才排的：清完再断一次，确保最后那个定时器也被收走
            if (socket) socket.destroy();
            for (const id of timers) clearTimeout(id);
            timers.clear();
        },
    };
};

const runAsync = async () => {
    pass = 0;
    fails.length = 0;

    if (!fs.existsSync(PORT_BUILT)) {
        console.log('插件桥通路：找不到 bridge-port 的编译产物，跳过（先跑 test/index.js 编译）');
        return true;
    }

    /* ------------------------- 1. 正常一问一答 ------------------------- */

    const app = await startFakeApp((message, reply) => {
        if (message.method === 'settings-get') {
            reply({ ok: true, result: { ai: { baseUrl: 'http://127.0.0.1:7777/v1', apiKey: 'k', model: 'from-app' } } });
        } else {
            reply({ ok: false, error: `应用不认识的桥端点：${message.method}` });
        }
    });

    const a = loadBridgePort(app.port);
    try {
        a.port.ensureBridge();

        await step('插件能从应用读到配置，且模型名就是应用那一份', async () => {
            // 等假 Port 连上再发请求
            for (let i = 0; i < 50 && !a.port.isBridgeReady(); i++) await sleep(20);
            assert(a.port.isBridgeReady(), '桥没连上（connectNative 或 TCP 连接失败）');

            const snapshot = await a.port.requestApp('settings-get');
            eq(snapshot?.ai?.model, 'from-app', '拿到的不是应用那一份配置');
            eq(app.replies.length, 1, `应用应收到恰好一条请求，实际 ${app.replies.length}`);
            eq(app.replies[0].method, 'settings-get', '方法名要原样传给应用');
            assert(/^ext-/.test(app.replies[0].id), `请求要带自己的 id（用于配对），实际 ${app.replies[0].id}`);
        });

        await step('应用回失败时，插件侧拿到的是抛错而不是一个空结果', async () => {
            const result = await a.port.requestApp('nope').then(() => 'resolved', (e) => `rejected:${e.message}`);
            assert(result.startsWith('rejected'), `失败的应答必须让调用方抛错，实际：${result}`);
            assert(/不认识的桥端点/.test(result), `错误信息应来自应用，实际：${result}`);
        });

        await step('并发两条请求各自拿到自己的应答（不串线）', async () => {
            const [one, two] = await Promise.all([
                a.port.requestApp('settings-get'),
                a.port.requestApp('settings-get'),
            ]);
            eq(one?.ai?.model, 'from-app', '第一条拿错了');
            eq(two?.ai?.model, 'from-app', '第二条拿错了');
            const ids = app.replies.map((r) => r.id);
            eq(new Set(ids).size, ids.length, `请求 id 必须互不相同，实际 ${ids.join(',')}`);
        });

        /* ------------------------- 2. 应用不回包 ------------------------- */

        await step('应用收下却不回包时，插件侧在超时后失败（不会永远挂着）', async () => {
            const silent = await startFakeApp(() => undefined);
            const b = loadBridgePort(silent.port);
            try {
                b.port.ensureBridge();
                for (let i = 0; i < 50 && !b.port.isBridgeReady(); i++) await sleep(20);
                assert(b.port.isBridgeReady(), '桥没连上');

                const started = Date.now();
                let settledAt = 0;
                const pending = b.port.requestApp('settings-get')
                    .then(() => 'resolved', (e) => `rejected:${e.message}`)
                    .finally(() => { settledAt = Date.now(); });

                // 请求是否真的发到了应用：要等它落地再断言，否则断在"还没发出去"上
                for (let i = 0; i < 100 && silent.replies.length === 0; i++) await sleep(20);
                eq(silent.replies.length, 1, '请求应当已经发到应用');

                const result = await pending;
                assert(result.startsWith('rejected'), '不回包必须失败，不能让调用方一直等');
                assert(settledAt - started >= 4000 && settledAt - started < 8000,
                    `应当在自身的超时（约 5s）后失败，实际 ${settledAt - started}ms —— `
                    + '这个数决定了"应用没在跑"时用户等多久');
            } finally {
                b.close();
                silent.server.close();
            }
        });

        /* ------------------------- 3. 连接断开 ------------------------- */

        await step('连接断开时在途请求当场失败，不等满超时', async () => {
            const held = await startFakeApp(() => undefined);
            const c = loadBridgePort(held.port);
            try {
                c.port.ensureBridge();
                for (let i = 0; i < 50 && !c.port.isBridgeReady(); i++) await sleep(20);
                assert(c.port.isBridgeReady(), '桥没连上');

                const started = Date.now();
                const pending = c.port.requestApp('settings-get').then(() => 'resolved', (e) => `rejected:${e.message}`);
                for (let i = 0; i < 100 && held.replies.length === 0; i++) await sleep(20);
                eq(held.replies.length, 1, '请求应当已经发到应用');

                // 应用退出：那条 TCP 会断，插件侧的 Port 随之 onDisconnect
                held.drop();

                const result = await pending;
                const elapsed = Date.now() - started;
                assert(result.startsWith('rejected'), `断开后必须失败，实际：${result}`);
                assert(elapsed < 4000,
                    `断开应立即失败而不是等满超时，实际 ${elapsed}ms —— `
                    + '否则用户每关一次应用都要等满超时');
            } finally {
                c.close();
                held.server.close();
            }
        });
    } finally {
        a.close();
        app.server.close();
    }

    if (fails.length > 0) {
        console.log(`插件桥通路：通过 ${pass} 项，失败 ${fails.length} 项`);
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
        return false;
    }
    console.log(`插件桥通路：通过 ${pass} 项，失败 0 项`);
    return true;
};

module.exports = { runAsync };
