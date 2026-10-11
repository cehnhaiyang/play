'use strict';

/**
 * 端到端：悬浮球窗口能不能真的拿到插件的数据。
 *
 * ## 这条链有四跳，任何一跳断了结果都一样（球上是空的）
 *
 *     球（Electron 渲染层）
 *       → preload（orb-preload.js）
 *       → 主进程（main.js 的 orb:bridge）
 *       → bridge.js（TCP 服务端）
 *       → host.js（Chrome 拉起的 native host）
 *       → 插件 SW（dispatchBridge）
 *
 * 所以这里**不测链路中间**，直接测两头：用 CDP 连到球窗口的渲染层，
 * 调 `window.orbApi.bridge('sniffer-get-state')`，看回包。
 * 那一句走完上面全部五跳。
 *
 * ## 前置
 *
 *   1. 应用在跑（npm run electron:dev）
 *   2. npm run host:install 跑过
 *   3. 浏览器里加载了 extension/dist
 *
 * 跑法：node test/e2e/e2e-orb.js
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Session, launch, waitForTarget, sleep, getJson } = require('./cdp');

const EXT = path.resolve(__dirname, '..', '..', 'extension', 'dist');

/**
 * 连到 Electron 的调试端口。
 *
 * Electron 不开 `--remote-debugging-port` 就没有 CDP。所以这个测试
 * **需要应用带那个参数启动**：`npx electron . --remote-debugging-port=9222`
 */
const ELECTRON_DEBUG_PORT = Number(process.env.ELECTRON_DEBUG_PORT || 9222);

const main = async () => {
    /* ---- 0. 应用在跑吗 ---- */
    let electronTargets;
    try {
        electronTargets = await getJson(`http://127.0.0.1:${ELECTRON_DEBUG_PORT}/json/list`);
    } catch {
        console.log(`连不上 Electron 的调试端口 ${ELECTRON_DEBUG_PORT}。`);
        console.log('请这样启动应用：npx electron . --remote-debugging-port=9222');
        process.exitCode = 1;
        return;
    }

    console.log('=== Electron 的目标 ===');
    for (const t of electronTargets) console.log(`  [${t.type}] ${t.title || '(无标题)'} ${t.url}`);

    /* ---- 1. 找到球窗口 ---- */
    const sniff = electronTargets.find((t) => t.url.includes('sniff.html'));
    const agent = electronTargets.find((t) => t.url.includes('agent.html'));

    if (!sniff) {
        console.log('\n没有找到嗅探球窗口。目标列表里没有 sniff.html。');
        process.exitCode = 1;
        return;
    }

    /* ---- 2. 连进球的渲染层 ---- */
    const page = await Session.connect(sniff.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await sleep(1200);

    const api = await page.evaluate(`(() => ({
        hasOrbApi: typeof window.orbApi !== 'undefined',
        id: window.orbApi?.id ?? null,
        methods: window.orbApi ? Object.keys(window.orbApi) : [],
    }))()`);
    console.log(`\n=== 嗅探球窗口 ===\n${JSON.stringify(api, null, 2)}`);

    if (!api.hasOrbApi) {
        console.log('\norbApi 不存在 —— preload 没加载，链路第一跳就断了。');
        page.close();
        process.exitCode = 1;
        return;
    }

    /* ---- 3. 桥连上了吗 ---- */
    const status = await page.evaluate('window.orbApi.bridgeStatus()');
    console.log(`\n桥状态：${JSON.stringify(status)}`);

    /* ---- 4. 走完整条链要一次数据 ---- */
    const state = await page.evaluate(`window.orbApi.bridge('sniffer-get-state')`);
    console.log(`\nsniffer-get-state → ${JSON.stringify(state)}`);

    /* ---- 5. 反向：开一次嗅探，看事件会不会推过来 ---- */
    const on = await page.evaluate(`window.orbApi.bridge('sniffer-set-enabled', { enabled: true })`);
    console.log(`sniffer-set-enabled → ${JSON.stringify(on)}`);

    const off = await page.evaluate(`window.orbApi.bridge('sniffer-set-enabled', { enabled: false })`);
    console.log(`再关掉 → ${JSON.stringify(off)}`);

    /* ---- 6. Agent 球也要能拿快照 ---- */
    if (agent) {
        const ap = await Session.connect(agent.webSocketDebuggerUrl);
        await ap.send('Runtime.enable');
        await sleep(800);
        const snap = await ap.evaluate(`window.orbApi.bridge('agent-snapshot')`);
        const parsed = typeof snap === 'object' ? snap : JSON.parse(snap);
        console.log(`\nAgent 球 agent-snapshot → ok=${parsed?.ok}`
            + ` messages=${parsed?.result?.snapshot?.messages?.length ?? '?'}`
            + ` status=${parsed?.result?.snapshot?.status ?? '?'}`);
        if (parsed?.error) console.log(`  错误：${parsed.error}`);
        ap.close();
    } else {
        console.log('\n没有找到 Agent 球窗口');
    }

    /* ---- 7. 界面上到底画出了什么 ---- */
    const rendered = await page.evaluate(`(() => {
        const root = document.getElementById('root');
        return {
            rootChildren: root ? root.children.length : 0,
            text: root ? root.innerText.replace(/\\n+/g, ' | ').slice(0, 300) : '(无 root)',
        };
    })()`);
    console.log(`\n嗅探球界面：${JSON.stringify(rendered)}`);

    page.close();
};

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
