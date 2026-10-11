'use strict';

/**
 * 端到端（推送 + 展开）：嗅探到媒体时球会不会实时更新，展开后画不画得出来。
 *
 * ## 为什么单独一个文件
 *
 * `e2e-full.js` 验的是"球能不能问到数据"（请求-响应方向）。
 * 这条方向即使断了，球打开时仍然能拉到一次全量 —— 所以它**测不出**
 * 推送断掉。而推送断掉的表现正是用户报的那句"球里什么都没有"：
 * 打开那一刻是空的，之后也永远不更新。
 *
 * 所以这里验两件事：
 *   1. 页面上出现媒体请求 → 插件的 webRequest 抓到 → 推给应用 → 球收到；
 *   2. 球展开之后，那条结果真的画在 DOM 里。
 *
 * 前置：应用在跑（带 --remote-debugging-port=9222）。
 */

const http = require('node:http');
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

/** 一个会真的发出媒体请求的页面 */
const startServer = () =>
    new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url.startsWith('/media/')) {
                // 内容不重要，重要的是 content-type 与 URL 后缀能通过分类
                res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '4096' });
                res.end(Buffer.alloc(4096));
                return;
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><html><head><meta charset="utf-8"><title>media</title></head>'
                + '<body><h1>media page</h1>'
                + '<video src="/media/movie.mp4" autoplay muted></video>'
                + '<audio src="/media/song.mp3"></audio>'
                + '</body></html>');
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });

/** 点球展开。走真实的指针事件，与用户点它一致 */
const OPEN_ORB = `(() => {
    const root = document.getElementById('root');
    const ball = root && root.firstElementChild;
    if (!ball) return 'no ball';
    const r = ball.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, pointerId: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    ball.dispatchEvent(new PointerEvent('pointerdown', opts));
    ball.dispatchEvent(new PointerEvent('pointerup', opts));
    ball.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: opts.clientX, clientY: opts.clientY }));
    return 'clicked';
})()`;

const main = async () => {
    if (!fs.existsSync(ENDPOINT_FILE)) {
        console.log('应用没在跑。请先：npx electron . --remote-debugging-port=9222');
        process.exitCode = 1;
        return;
    }

    const { server, port } = await startServer();
    const mediaUrl = `http://127.0.0.1:${port}/`;
    console.log(`测试页：${mediaUrl}`);

    const browser = await launch({ headless: true });
    try {
        const extId = await browser.loadExtension(EXT);
        console.log(`扩展：${extId}`);
        await waitForTarget(browser, (t) => t.type === 'service_worker' && t.url.includes('service-worker.js'), 15000);

        /* ---- 等桥连上 ---- */
        let sniff = null;
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline && !sniff) {
            try {
                const list = await getJson(`http://127.0.0.1:${ELECTRON_PORT}/json/list`);
                const t = list.find((x) => x.url.includes('sniff.html'));
                if (t) {
                    const s = await Session.connect(t.webSocketDebuggerUrl);
                    await s.send('Runtime.enable');
                    const st = await s.evaluate('window.orbApi.bridgeStatus()');
                    if (st?.connected) sniff = s;
                    else s.close();
                }
            } catch {
                // 还没起来
            }
            if (!sniff) await sleep(1000);
        }
        if (!sniff) throw new Error('桥没连上');
        console.log('桥已连接 ✓');

        /* ---- 装一个记录器，看球到底收到哪些事件 ---- */
        await sniff.evaluate(`(() => {
            window.__events = [];
            window.orbApi.onEvent((e) => window.__events.push(e));
            return true;
        })()`);

        /* ---- 清空 + 开嗅探 ---- */
        await sniff.evaluate(`window.orbApi.bridge('sniffer-clear')`);
        await sniff.evaluate(`window.orbApi.bridge('sniffer-set-enabled', { enabled: true })`);
        console.log('嗅探已开');

        /* ---- 打开带媒体的页面 ---- */
        const page = await browser.newTab(mediaUrl);
        const ps = await Session.connect(page.webSocketDebuggerUrl);
        await ps.send('Runtime.enable');
        await sleep(4000);

        /* ---- 1. 球收到事件了吗 ---- */
        const events = await sniff.evaluate('window.__events');
        const sniffEvents = (events || []).filter((e) => e.event === 'sniffed-media');
        console.log(`\n[1] 球收到 sniffed-media 事件 ${sniffEvents.length} 条`);
        for (const e of sniffEvents.slice(0, 5)) {
            console.log(`    ${e.payload?.ext}  ${e.payload?.url}`);
        }

        /* ---- 2. 插件侧确实存下来了吗 ---- */
        const state = await sniff.evaluate(`window.orbApi.bridge('sniffer-get-state')`);
        const parsed = typeof state === 'string' ? JSON.parse(state) : state;
        console.log(`\n[2] 插件侧列表 ${parsed?.result?.items?.length ?? '?'} 条`);
        for (const item of (parsed?.result?.items || []).slice(0, 5)) {
            console.log(`    ${item.ext}  ${item.url}`);
        }

        /* ---- 3. 展开球，看画没画出来 ---- */
        const opened = await sniff.evaluate(OPEN_ORB);
        console.log(`\n[3] 展开球：${opened}`);
        await sleep(900);

        const rendered = await sniff.evaluate(`(() => {
            const root = document.getElementById('root');
            const list = root.querySelectorAll('li');
            return {
                text: root.innerText.replace(/\\n+/g, ' | ').slice(0, 400),
                listItems: list.length,
                hasHeader: !!root.querySelector('header'),
            };
        })()`);
        console.log(`    界面：${JSON.stringify(rendered, null, 2)}`);

        /* ---- 4. 从球上下载一次（走 chrome.downloads） ---- */
        const dl = await sniff.evaluate(`window.orbApi.bridge('downloads-start', { url: ${JSON.stringify(`${mediaUrl}media/movie.mp4`)}, filename: 'e2e-movie.mp4' })`);
        console.log(`\n[4] downloads-start → ${JSON.stringify(dl)}`);

        await sniff.evaluate(`window.orbApi.bridge('sniffer-set-enabled', { enabled: false })`);
        sniff.close();
        ps.close();
    } finally {
        await browser.close();
        server.close();
    }
};

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
