'use strict';

/**
 * 验证篡改规则引擎真的在页面里生效。
 *
 * ## 为什么必须有这个测试
 *
 * 规则引擎是**唯一一类"看起来在工作、实际什么都没做"的功能**：面板显示
 * "启用中"、保存返回成功、控制台可能还有一行 Activated —— 而页面里的值
 * 一个字都没变。单元测试抓不到它，因为那些断言只能证明"规则被存下来了"，
 * 证明不了"钩子装进了页面主世界"。
 *
 * 实测过的两个真实故障都在这一层：
 *   1. `chrome.scripting.executeScript` **默认落隔离世界**，那里有自己的一份
 *      `window`，页面自己的 `JSON.parse` 根本没被替换；
 *   2. 注入挂在页面就绪事件上，而规则是异步从存储读的 —— 读到空镜像就注入
 *      等于装了一个什么都不做的钩子。
 *
 * 所以这个测试走完整的真实链路：存规则 → 注入 → 在页面里**真的调一次**
 * `JSON.parse` / `fetch` / `localStorage.getItem` → 看返回值变没变。
 *
 * ## 三条断言对应三条钩子路径
 *
 *  · `JSON.parse` —— 页面自己解析响应文本的路径（最古老也最普遍）；
 *  · `Response.json()` —— fetch 响应路径，现代前端的默认写法；
 *  · `localStorage.getItem` —— 存储读取路径，规则里没有字段能区分存储区，
 *    所以两个区都要装。
 *
 * ## 为什么不用桥
 *
 * 同 verify-sniff-coverage：用户自己的浏览器也连着同一个应用，两个实例会抢
 * 那唯一一条 socket。全程只跟 service worker 说话。
 *
 * 跑法：node test/e2e/verify-tamper-engine.js
 * 前置：`npm run ext:build` 跑过（用的是 extension/dist）
 */

const http = require('node:http');
const path = require('node:path');
const { Session, launch, waitForTarget, sleep } = require('./cdp');

const EXT = path.resolve(__dirname, '..', '..', 'extension', 'dist');

/** 页面源码。三段脚本各自对应一条被钩的路径，都在主世界执行 */
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>tamper</title></head>
<body>
  <script>
    // 1. JSON.parse 路径：页面解析一段"接口响应"文本
    window.__parsed = JSON.parse('{"is_vip":false,"keep":"untouched"}');

    // 2. localStorage 路径：先写真实值，再读回来（读的时候才会被改）
    localStorage.setItem('vip_flag', 'real-value');
    window.__stored = localStorage.getItem('vip_flag');

    // 3. fetch 路径：请求本机的一个 JSON 接口并解析
    window.__fetched = null;
    fetch('/api/profile').then(function (r) { return r.json(); })
      .then(function (d) { window.__fetched = d; })
      .catch(function (e) { window.__fetched = { error: String(e) }; });
  </script>
</body></html>`;

const main = async () => {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/api/profile') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            // 服务端**永远**返回 false。页面里读到 true 只可能是钩子改的
            res.end(JSON.stringify({ is_vip: false, keep: 'untouched' }));
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    let failures = 0;
    const check = (label, ok, detail) => {
        console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? `  （${detail}）` : ''}`);
        if (!ok) failures += 1;
    };

    const browser = await launch({ headless: true });
    try {
        const extensionId = await browser.loadExtension(EXT);
        const swTarget = await waitForTarget(
            browser,
            (t) => t.type === 'service_worker' && t.url.includes('service-worker.js'),
            15000,
        );
        if (!swTarget) throw new Error('service worker 没起来（扩展没装上？）');
        const sw = await Session.connect(swTarget.webSocketDebuggerUrl);
        await sw.send('Runtime.enable');
        await sleep(300);

        /*
         * 消息总线。
         *
         * SW **收不到自己发的 `chrome.runtime.sendMessage`**，所以不能直接在
         * SW 上下文里发。offscreen.html 是现成的扩展页，它的 onMessage 只认
         * `target: 'host'`，会把 `target: 'sw'` 放行给 SW。
         */
        const bus = await browser.newTab(`chrome-extension://${extensionId}/offscreen.html`);
        const bs = await Session.connect(bus.webSocketDebuggerUrl);
        await bs.send('Runtime.enable');
        await sleep(500);

        const ask = (payload) =>
            bs.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(payload)})`);

        /* ---- 先打开页面：注入发生在导航完成时，所以规则要在那之前存好 ---- */
        const page = await browser.newTab(`${base}/page`);
        const ps = await Session.connect(page.webSocketDebuggerUrl);
        await ps.send('Runtime.enable');
        await ps.waitFor((m) => m.method === 'Page.loadEventFired', 8000);
        await sleep(400);

        const tabId = await sw.evaluate(
            `chrome.tabs.query({ url: '${base}/page' }).then(list => (list[0] || {}).id ?? -1)`,
        );
        if (tabId < 0) throw new Error('找不到被测标签页');

        /* ---- 注入前：三个值都是"真实值" ---- */
        const before = await ps.evaluate(`JSON.stringify({
            parsed: window.__parsed,
            stored: window.__stored,
            fetched: window.__fetched,
        })`);
        console.log(`\n注入前：${before}\n`);
        check('注入前页面读到真实值（否则下面的断言证明不了任何事）',
            JSON.parse(before).parsed?.is_vip === false,
            before);

        /* ---- 存规则。这条会落盘并立刻注入当前标签页 ---- */
        const saved = await ask({
            target: 'sw',
            kind: 'tamper-set',
            tabId,
            interceptRules: [
                { id: 'r1', enabled: true, urlPattern: '*', jsonPath: 'is_vip', newValue: 'true' },
                /*
                 * 存储路径按**存储键名**匹配，不是按 JSON 字段名 ——
                 * `TamperRule.jsonPath` 的语义在两条路径上不同（见 shared/meta
                 * 的说明）。所以这里要单独写一条以 `vip_flag` 为目标的规则，
                 * 用上面那条 `is_vip` 是匹配不上 `localStorage.vip_flag` 的。
                 */
                { id: 'r2', enabled: true, urlPattern: '*', jsonPath: 'vip_flag', newValue: 'true' },
            ],
            requestRules: [],
            headerRules: [],
        });
        if (!saved?.ok) throw new Error(`存规则失败：${saved?.error || '(无回包)'}`);
        check('规则已落盘', saved.result?.saved === true, JSON.stringify(saved.result?.saved));

        // 等注入落地。executeScript 是异步的，注入本身很快但要给它一拍
        await sleep(600);

        /*
         * 在页面里**重新解析一次**。
         *
         * 不能读 `window.__parsed` —— 那是页面脚本在**注入之前**解析的，
         * 钩子还没装上。要验的是"装完之后页面再解析会被改写"，所以这里
         * 通过 CDP 在主世界新跑一段 JSON.parse。
         */
        const afterParse = await ps.evaluate(`JSON.stringify(JSON.parse('{"is_vip":false,"keep":"untouched"}'))`);
        console.log(`注入后 JSON.parse：${afterParse}\n`);
        const parsedAfter = JSON.parse(afterParse);

        check('★ JSON.parse 被改写（is_vip: false → true）',
            parsedAfter.is_vip === true,
            `实际 ${JSON.stringify(parsedAfter.is_vip)}`);

        check('未被规则命中的字段原样保留（不是整份替换）',
            parsedAfter.keep === 'untouched',
            `实际 ${JSON.stringify(parsedAfter.keep)}`);

        /*
         * 存储路径。**必须用原生方法读**：`localStorage.getItem` 已被替换成
         * 我们的钩子，直接调它正是被测行为；这里读的就是它。
         */
        const afterStore = await ps.evaluate(`localStorage.getItem('vip_flag')`);
        check('★ localStorage.getItem 被改写（real-value → true）',
            afterStore === 'true',
            `实际 ${JSON.stringify(afterStore)}`);

        /* ---- fetch 路径：`Response.json()` 那条钩子 ---- */
        const afterFetch = await ps.evaluate(
            `fetch('/api/profile').then(function (r) { return r.json(); }).then(function (d) { return JSON.stringify(d); })`,
        );
        const fetched = JSON.parse(afterFetch);
        check('★ Response.json() 被改写（服务端返回 false，页面读到 true）',
            fetched.is_vip === true,
            `实际 ${JSON.stringify(fetched)}`);

        /*
         * 关掉规则之后必须**不再**改写。
         *
         * 只验"生效"是不够的：一个把 `JSON.parse` 无条件改写成固定值的实现
         * 也能让上面三条全绿。这条钉住"规则是判据"，而判据来自规则表。
         */
        await ask({ target: 'sw', kind: 'tamper-set', tabId, interceptRules: [], requestRules: [], headerRules: [] });
        await sleep(600);
        const afterDisable = JSON.parse(await ps.evaluate(`JSON.stringify(JSON.parse('{"is_vip":false}'))`));
        check('★ 清空规则后不再改写（证明改写真的由规则表驱动）',
            afterDisable.is_vip === false,
            `实际 ${JSON.stringify(afterDisable.is_vip)}`);

        /* ---- 页签要读得到规则：面板与 Agent 工具都走这条 ---- */
        const got = await ask({ target: 'sw', kind: 'tamper-get' });
        check('tamper-get 回得到规则（面板四个页签的数据源）',
            got?.ok === true && got.result?.rules !== undefined,
            JSON.stringify(got?.result?.rules));

        /* ---- 存储读取端点：存储页与 JWT 页都走它 ---- */
        const storage = await ask({ target: 'sw', kind: 'page-storage-read', tabId });
        const readBack = storage?.result;
        check('page-storage-read 能读到页面的 localStorage',
            typeof readBack?.local === 'string' && readBack.local.includes('vip_flag'),
            String(readBack?.local).slice(0, 80));
        check('page-storage-read 同时带回 cookie 与页面地址',
            Array.isArray(readBack?.cookies) && typeof readBack?.pageUrl === 'string',
            `cookies=${readBack?.cookies?.length} pageUrl=${readBack?.pageUrl}`);

        ps.close();
        bs.close();
        sw.close();
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
