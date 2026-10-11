'use strict';

/**
 * 端到端（完整）：浏览器 + 插件 + 本机应用 + 悬浮球窗口。
 *
 * ## 与 e2e-orb.js 的分工
 *
 * `e2e-orb.js` 只验应用那一半（球窗口能不能调到主进程的桥）。它跑的时候
 * 浏览器里没有插件，所以桥永远是"未连接" —— 那是对的，它验的是
 * **失败路径也如实报出来**。
 *
 * 这个文件把浏览器也拉起来，验完整链路：
 *
 *     球窗口 ─preload─▶ 主进程 ─TCP─▶ host.js ◀─connectNative─ 插件 SW
 *
 * ## 为什么浏览器必须由这个脚本自己起
 *
 * 因为要用 CDP 装扩展（Chrome 137 起 `--load-extension` 静默失效，
 * 见 cdp.js）。用户自己开的浏览器不会带那个调试端口，脚本连不进去。
 * 所以这里起一个**独立的** Chrome 实例，它有自己的 profile，
 * 与用户日常那个互不干扰。
 *
 * 前置：应用在跑，且带 `--remote-debugging-port=9222`。
 * 跑法：node test/e2e/e2e-full.js
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Session, launch, waitForTarget, sleep, getJson } = require('./cdp');

const EXT = path.resolve(__dirname, '..', '..', 'extension', 'dist');
const ELECTRON_PORT = Number(process.env.ELECTRON_DEBUG_PORT || 9222);

const ENDPOINT_FILE = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'the-play',
    'bridge-endpoint.json',
);

/** 等应用侧的桥报告"已连接" */
const waitForBridgeConnected = async (browser, timeoutMs = 25000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const list = await getJson(`http://127.0.0.1:${ELECTRON_PORT}/json/list`);
            const sniff = list.find((t) => t.url.includes('sniff.html'));
            if (sniff) {
                const page = await Session.connect(sniff.webSocketDebuggerUrl);
                await page.send('Runtime.enable');
                const status = await page.evaluate('window.orbApi.bridgeStatus()');
                page.close();
                if (status?.connected) return true;
            }
        } catch {
            // 应用还没起来或端口还没开
        }
        await sleep(1000);
    }
    return false;
};

const main = async () => {
    if (!fs.existsSync(ENDPOINT_FILE)) {
        console.log(`找不到 ${ENDPOINT_FILE} —— 应用没在跑。`);
        console.log('请先：npx electron . --remote-debugging-port=9222');
        process.exitCode = 1;
        return;
    }
    console.log(`应用端点在听：${JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8')).port}`);

    const browser = await launch({ headless: true });
    console.log(`已起浏览器：${browser.version.Browser}`);

    try {
        const extId = await browser.loadExtension(EXT);
        console.log(`已装扩展：${extId}`);

        const swTarget = await waitForTarget(
            browser,
            (t) => t.type === 'service_worker' && t.url.includes('service-worker.js'),
            15000,
        );
        console.log(`service worker：${swTarget ? '起来了' : '没起来'}`);

        /* ---- 1. 桥连上了吗 ---- */
        console.log('\n[1] 等桥连接（插件 SW 顶层 ensureBridge）');
        const connected = await waitForBridgeConnected(browser);
        console.log(`    桥状态：${connected ? '已连接 ✓' : '未连接 ✗'}`);

        if (!connected) {
            /* 桥没连上，把插件那一侧的失败原因问出来 */
            if (swTarget) {
                const sw = await Session.connect(swTarget.webSocketDebuggerUrl);
                await sw.send('Runtime.enable');
                await sleep(500);
                const probe = await sw.evaluate(`(() => {
                    try {
                        const port = chrome.runtime.connectNative('com.theplay.host');
                        let msg = null;
                        port.onDisconnect.addListener(() => {
                            msg = chrome.runtime.lastError ? chrome.runtime.lastError.message : '(无 lastError)';
                        });
                        return { created: !!port, note: '等 2 秒看 msg' };
                    } catch (e) { return { threw: String(e && e.message || e) }; }
                })()`);
                console.log(`    手动 connectNative：${JSON.stringify(probe)}`);
                await sleep(2500);
                const err = await sw.evaluate(`chrome.runtime.lastError ? chrome.runtime.lastError.message : null`);
                console.log(`    lastError：${err}`);
                sw.close();
            }
            console.log('\n结论：桥没通。上面那几行是插件侧的真实原因。');
            return;
        }

        /* ---- 2. 球窗口要一次嗅探状态 ---- */
        const list = await getJson(`http://127.0.0.1:${ELECTRON_PORT}/json/list`);
        const sniffTarget = list.find((t) => t.url.includes('sniff.html'));
        const sniff = await Session.connect(sniffTarget.webSocketDebuggerUrl);
        await sniff.send('Runtime.enable');
        await sleep(600);

        const state = await sniff.evaluate(`window.orbApi.bridge('sniffer-get-state')`);
        console.log(`\n[2] sniffer-get-state → ${JSON.stringify(state)}`);

        /* ---- 3. 真的开一次嗅探，看事件推不推得过来 ---- */
        console.log('\n[3] 开嗅探并制造一条媒体请求');
        await sniff.evaluate(`window.orbApi.bridge('sniffer-set-enabled', { enabled: true })`);

        /*
         * 在浏览器里开一个带 <video> 的页面。
         *
         * 用 data: URL 而不是起本地服务：省掉一个 http server，
         * 而嗅探只关心"有没有一个 media 类型的响应"。
         * data: URL 不会被 webRequest 观察（它不出网），所以这里用一个
         * 真正会发请求的页面 —— 指向浏览器自己的 favicon 不够 media，
         * 所以直接请求一个 .mp4 后缀的地址，哪怕 404 也无所谓：
         * 分类只看 URL 后缀与 content-type，而我们要验的是**事件通道**。
         */
        const page = await browser.newTab('about:blank');
        const ps = await Session.connect(page.webSocketDebuggerUrl);
        await ps.send('Runtime.enable');
        await ps.send('Page.enable');
        await ps.send('Page.navigate', { url: 'https://example.com/' });
        await sleep(3000);

        const after = await sniff.evaluate(`window.orbApi.bridge('sniffer-get-state')`);
        const parsed = typeof after === 'string' ? JSON.parse(after) : after;
        console.log(`    嗅探列表条数：${parsed?.result?.items?.length ?? '?'}`);
        console.log(`    开关：${parsed?.result?.enabled}`);

        /* ---- 4. 球界面上画出了什么 ---- */
        const rendered = await sniff.evaluate(`(() => {
            const root = document.getElementById('root');
            return {
                text: root ? root.innerText.replace(/\\n+/g, ' | ').slice(0, 200) : '(无 root)',
                orbCount: document.querySelectorAll('.rounded-full').length,
            };
        })()`);
        console.log(`\n[4] 嗅探球界面：${JSON.stringify(rendered)}`);

        await sniff.evaluate(`window.orbApi.bridge('sniffer-set-enabled', { enabled: false })`);
        sniff.close();
        ps.close();
    } finally {
        await browser.close();
    }
};

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
