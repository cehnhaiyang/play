'use strict';

/**
 * 验证嗅探的**端到端延迟不随页面上无关响应的数量增长**。
 *
 * ## 为什么这条需要单独一个 e2e
 *
 * 这个 bug 在单测里看不出来，在"打开一个简单页面试试"里也看不出来 ——
 * 它只在**真实网页**（几百个请求）上暴露，表现是"嗅探结果出得极慢"。
 * 而每个单独的函数看着都没问题：
 *
 *   · `getItems()` 读一次 storage —— 8ms，不快但也不像故障；
 *   · `pushItem()` 读-改-写一次 —— 同样看着没问题；
 *   · `serialize()` 把写操作串起来 —— 那是为了防丢条目，是**对的**。
 *
 * 错的是三者叠在一起：写是 O(n)（第 k 条要序列化 k 条记录，n 条下来是 O(n²)），
 * 而整条链又是串行的。实测修复前：
 *
 *     页面上 0 个无关响应    → 落库    34 ms
 *     页面上 300 个无关响应  → 落库  2867 ms
 *
 * 修复后改成内存镜像 + 去抖写盘，追加与判断都降到 O(1)。
 *
 * ## 量的是"球收到推送"而不是"结果落进 storage"
 *
 * 后者会被写盘策略污染：修复后写盘是去抖的（200ms 一次），
 * 拿 storage 当观测点会把这段**故意加的延迟**算进来，测出一个假的劣化。
 * 而用户看到的延迟是"页面发出媒体请求 → 球上出现这一条"，
 * 也就是推送到达的时刻 —— 那才是这里该量的。
 *
 * ## 判据为什么是"增长倍数"而不是绝对毫秒
 *
 * 绝对耗时受机器负载影响（CI 上、开着别的程序时都会变），拿它当阈值必然变成
 * 一个时不时红一次的假警报。而"300 个无关响应不该让耗时长 10 倍"是**性质**，
 * 与机器快慢无关 —— 它测的是复杂度，不是速度。
 *
 * 跑法：node test/e2e/verify-sniff-latency.js
 * 前置：应用在跑（带 --remote-debugging-port=9222）
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

/** 页面上的无关响应数量。0 是基线，300 是真实网页的量级 */
const SCALES = [0, 300];

/**
 * 允许的倍数上限。
 *
 * 修复前是 84 倍（34 → 2867ms），修复后实测 1.0～1.5 倍。取 5 是给机器抖动
 * 留足余量，同时远低于任何 O(n²) 实现会落到的区间 —— 也就是说它拦得住回归，
 * 但不会因为机器慢就误报。
 */
const MAX_GROWTH = 5;

/** 每种规模重复几次取最小值：最小值是"没有别的东西在抢"时的那一次，最接近真实代价 */
const REPEATS = 2;

const main = async () => {
    if (!fs.existsSync(ENDPOINT_FILE)) {
        console.log('应用没在跑。请先：npx electron . --remote-debugging-port=9222');
        process.exitCode = 1;
        return;
    }

    let mediaRespondedAt = 0;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/media/movie.mp4') {
            res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '2048' });
            res.end(Buffer.alloc(2048));
            mediaRespondedAt = Date.now();
            return;
        }
        if (url.pathname === '/tiny.png') {
            res.writeHead(200, { 'content-type': 'image/png', 'content-length': '64' });
            res.end(Buffer.alloc(64));
            return;
        }
        const n = Number(url.searchParams.get('n') || 0);
        const imgs = Array.from({ length: n }, (_, i) => `<img src="/tiny.png?i=${i}">`).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>latency</title></head>'
            + `<body>${imgs}<video src="/media/movie.mp4" muted></body></html>`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await launch({ headless: true });
    let failures = 0;
    const check = (label, ok, detail) => {
        console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? `  （${detail}）` : ''}`);
        if (!ok) failures += 1;
    };

    try {
        await browser.loadExtension(EXT);
        const swTarget = await waitForTarget(
            browser,
            (t) => t.type === 'service_worker' && t.url.includes('service-worker.js'),
            15000,
        );
        if (!swTarget) throw new Error('service worker 没起来');
        const sw = await Session.connect(swTarget.webSocketDebuggerUrl);
        await sw.send('Runtime.enable');
        await sleep(300);
        await sw.evaluate(`chrome.storage.local.set({ snifferEnabled: true })`);

        /* ---- 连上球，用它当观测点 ---- */
        let orb = null;
        const orbDeadline = Date.now() + 25000;
        while (Date.now() < orbDeadline && !orb) {
            const list = await getJson(`http://127.0.0.1:${ELECTRON_PORT}/json/list`);
            const t = list.find((x) => x.url.includes('sniff.html'));
            if (t) {
                const s = await Session.connect(t.webSocketDebuggerUrl);
                await s.send('Runtime.enable');
                if (await s.evaluate('!!window.orbApi')) orb = s;
                else s.close();
            }
            if (!orb) await sleep(1000);
        }
        if (!orb) throw new Error('找不到嗅探球窗口（应用带 --remote-debugging-port=9222 起了吗？）');

        /*
         * 等桥连上再量。
         *
         * 应用通常比浏览器先起，所以球窗口打开那一刻桥几乎总是未连接的。
         * 不等它就直接开始量，量到的是"事件没有收件人" —— 表现为一条都收不到，
         * 而真正的原因只是时序，不是被测的那段代码有问题。
         */
        let connected = false;
        const bridgeDeadline = Date.now() + 25000;
        while (Date.now() < bridgeDeadline && !connected) {
            const st = await orb.evaluate('window.orbApi.bridgeStatus()');
            connected = !!st?.connected;
            if (!connected) await sleep(500);
        }
        if (!connected) throw new Error('桥没连上（扩展装上了吗？host 注册了吗？）');
        console.log('桥已连接 ✓\n');

        /*
         * 记录器装在**球的 preload 出口**上，而不是 React 组件里。
         *
         * 组件里那份是"画出来了"，中间还隔着 setState 与一次重渲染；
         * 这里要量的是"推送到了没有"。两者差一个渲染帧，而这一帧不是本测试的主题。
         */
        await orb.evaluate(`(() => {
            window.__arrivals = [];
            window.orbApi.onEvent((e) => {
                if (e && e.event === 'sniffed-media' && e.payload && e.payload.url.endsWith('/media/movie.mp4')) {
                    window.__arrivals.push(Date.now());
                }
            });
            return true;
        })()`);

        const measure = async (n) => {
            await orb.evaluate('window.__arrivals = []');
            mediaRespondedAt = 0;
            const page = await browser.newTab(`${base}/page?n=${n}`);
            const ps = await Session.connect(page.webSocketDebuggerUrl);
            await ps.send('Runtime.enable');

            let arrivals = [];
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline && arrivals.length === 0) {
                arrivals = (await orb.evaluate('window.__arrivals')) || [];
                if (arrivals.length === 0) await sleep(20);
            }
            ps.close();
            if (arrivals.length === 0) throw new Error(`页面上 ${n} 个无关响应时，球 30 秒内没收到推送`);
            if (!mediaRespondedAt) throw new Error('服务端没有记录到媒体响应时刻');
            return arrivals[0] - mediaRespondedAt;
        };

        console.log('嗅探端到端延迟（媒体响应发出 → 球收到推送）\n');
        const results = [];
        for (const n of SCALES) {
            const runs = [];
            for (let i = 0; i < REPEATS; i += 1) runs.push(await measure(n));
            const best = Math.min(...runs);
            results.push(best);
            console.log(`  页面上 ${String(n).padStart(3)} 个无关响应 → ${String(best).padStart(4)} ms`
                + `（${REPEATS} 次：${runs.join(', ')}）`);
        }

        const [baseline, loaded] = results;
        const growth = loaded / Math.max(baseline, 1);
        console.log('');
        check(
            `无关响应从 ${SCALES[0]} 涨到 ${SCALES[1]} 时，耗时不随之放大（复杂度与页面请求数无关）`,
            growth <= MAX_GROWTH,
            `增长 ${growth.toFixed(1)} 倍（上限 ${MAX_GROWTH} 倍）：${baseline}ms → ${loaded}ms`,
        );

        /*
         * 顺带钉住"结果真的进了插件"。
         *
         * 只测耗时会漏掉一种回归：把 pushItem 改成什么都不做，延迟当然是 0 ——
         * 而那是把功能删掉，不是把它修好。
         */
        const stored = await sw.evaluate(
            `chrome.storage.session.get('sniffedItems').then(g => (g.sniffedItems || []).length)`,
        );
        check('结果确实进了插件的 storage', stored > 0, `库里有 ${stored} 条`);

        await sw.evaluate(`chrome.storage.local.set({ snifferEnabled: false })`);
        sw.close();
        orb.close();
    } finally {
        await browser.close();
        server.close();
    }

    console.log(`\n${failures === 0 ? '全部通过。' : `${failures} 项失败。`}`);
    process.exitCode = failures === 0 ? 0 : 1;
};

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
