'use strict';

/**
 * 验证页内扫描补上了网络层的**盲区**。
 *
 * ## 这个测试要证明什么
 *
 * 网络层（`webRequest`）只能看见**开关打开之后**发生的请求。而用户点开开关时，
 * 页面往往早就加载完了 —— 于是列表是空的，尽管页面上明明在播。
 * 实测过：一个视频站的页面里 `video.src` 已经加载完、`__playinfo__` 里躺着
 * dash 轨、源码里还有一堆没被请求过的直链，网络层一条都看不到。
 *
 * 所以这里刻意构造三种**网络层永远看不到**的地址：
 *
 *   1. `<video preload="none" src>` —— 元素存在但从不发请求；
 *   2. `window.__playinfo__.data.dash.*.baseUrl` —— 播放器全局对象里的轨道；
 *   3. 页面源码里的一段字符串 —— 从没被任何元素引用。
 *
 * 三条都必须被页内扫描捞到。少一条就是一条采集路径漏了，而那种漏在真浏览器里
 * 只表现为"某些站点嗅不到"，看不出是代码少了一段。
 *
 * ## 为什么不用桥
 *
 * 全程只跟 service worker 说话（CDP 直连 SW 的执行上下文）。走桥的话，
 * 用户自己的浏览器也连着同一个应用，两个实例会抢那唯一一条 socket，
 * 测出来的结果取决于谁先连上 —— 那是测试环境的噪声，不是被测代码的性质。
 *
 * 跑法：node test/e2e/verify-sniff-coverage.js
 * 前置：`npm run ext:build` 跑过（用的是 extension/dist）
 */

const http = require('node:http');
const path = require('node:path');
const { Session, launch, waitForTarget, sleep } = require('./cdp');

const EXT = path.resolve(__dirname, '..', '..', 'extension', 'dist');

/** 三种"网络层看不到"的地址。每一个都对应一条采集路径 */
const DOM_ONLY = '/media/dom-only.mp4';
const PLAYINFO_ONLY = '/media/playinfo-track.m4s';
const SOURCE_ONLY = '/media/source-only.m3u8';

/*
 * 页面**从外部脚本**构造前两个地址，HTML 里只有那个 <script src>。
 *
 * ## 为什么不能内联
 *
 * 内联的话地址的字面量会出现在 `document.documentElement.outerHTML` 里，
 * 于是"页面源码正则"那条路径会替另外两条把它捞出来 —— 断言照样绿，
 * 而它其实什么都没钉住。实测过：把 `__playinfo__` 那段整个删掉，
 * 测试**全绿**（一个等价变异体），因为 m4s 是源码正则找到的。
 *
 * 外部脚本的内容不进 outerHTML，所以两条路径各自独立可验。
 * 这也更贴近真实站点：`__playinfo__` 是播放器的 bundle 写的，不是内联的。
 */
const PAGE_JS = `
  var v = document.createElement('video');
  v.preload = 'none';
  v.muted = true;
  v.src = ${JSON.stringify(DOM_ONLY)};
  document.body.appendChild(v);
  window.__playinfo__ = { data: { dash: {
    video: [{ baseUrl: ${JSON.stringify(PLAYINFO_ONLY)} }],
    audio: []
  } } };
`;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>coverage</title></head>
<body>
  <script src="/page.js"></script>
  <script>
    // 只在源码里出现一次的字符串，没有任何元素引用它。
    // 这一条**故意**内联 —— 它要验的正是"页面源码正则"那条路径。
    var neverUsed = '${SOURCE_ONLY}';
  </script>
</body></html>`;

const main = async () => {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/page') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(PAGE_HTML);
            return;
        }
        if (url.pathname === '/page.js') {
            res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
            res.end(PAGE_JS);
            return;
        }
        // 三个媒体地址**故意不实现**：它们被请求到就说明网络层提前看见了，
        // 那样这个测试就证明不了页内扫描的作用
        res.writeHead(404);
        res.end();
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

        /* ---- 打开被测页面 ---- */
        const page = await browser.newTab(`${base}/page`);
        const ps = await Session.connect(page.webSocketDebuggerUrl);
        await ps.send('Runtime.enable');
        // 等页面真正就绪：__playinfo__ 是内联脚本写的，它在了就说明解析完了
        await ps.waitFor(
            (m) => m.method === 'Page.loadEventFired',
            8000,
        );
        await sleep(500);

        /*
         * 从 SW 里按 URL 找到那个标签页。
         *
         * **必须显式传 tabId**：不传的话 `sniffer-scan` 会问"当前活动的标签页"，
         * 而下面那个扩展页正是活动的那个 —— 扫的就会是扩展页自己。
         */
        const tabId = await sw.evaluate(
            `chrome.tabs.query({ url: '${base}/page' }).then(list => (list[0] || {}).id ?? -1)`,
        );
        if (tabId < 0) throw new Error('找不到被测标签页');

        /*
         * 用扩展自己的页面发消息。
         *
         * SW **收不到自己发的 `chrome.runtime.sendMessage`** —— 所以不能直接在
         * SW 的上下文里发。offscreen.html 是现成的扩展页，它的 onMessage 只认
         * `target: 'host'`，会把 `target: 'sw'` 这条放行给 SW。
         */
        const bus = await browser.newTab(`chrome-extension://${extensionId}/offscreen.html`);
        const bs = await Session.connect(bus.webSocketDebuggerUrl);
        await bs.send('Runtime.enable');
        await sleep(500);

        const ask = (payload) =>
            bs.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(payload)})`);

        /* ---- 先清空，保证下面看到的东西都来自这一次扫描 ---- */
        await ask({ target: 'sw', kind: 'sniffer-clear' });

        const scanned = await ask({ target: 'sw', kind: 'sniffer-scan', tabId });
        if (!scanned?.ok) throw new Error(`扫描失败：${scanned?.error || '(无回包)'}`);

        const state = await ask({ target: 'sw', kind: 'sniffer-get-state' });
        const items = state?.result?.items || [];
        const urls = items.map((item) => item.url);

        console.log(`\n扫描结果：${items.length} 条\n`);
        for (const item of items.slice(0, 12)) {
            console.log(`  [${item.source}/${item.type}] ${item.url}`);
        }
        console.log('');

        /*
         * 三条断言分开写，而不是"至少有一条命中"。
         *
         * 合成一条的话，删掉任意一条采集路径（比如 Performance 那段）测试照样绿 ——
         * 而"某一条路径没了"正是这个测试要拦的回归。
         */
        check('DOM 里的 <video preload=none> 被页内扫描捞到（网络层永远看不到）',
            urls.some((u) => u.endsWith(DOM_ONLY)),
            DOM_ONLY);

        check('__playinfo__ 的 dash 轨道被捞到',
            urls.some((u) => u.endsWith(PLAYINFO_ONLY)),
            PLAYINFO_ONLY);

        check('页面源码里的孤立直链被正则捞到',
            urls.some((u) => u.endsWith(SOURCE_ONLY)),
            SOURCE_ONLY);

        // 来源要标成 'local'：与网络层的 'network' 分开，用户能看出这条是怎么来的
        const domItem = items.find((i) => i.url.endsWith(DOM_ONLY));
        check('页内扫描的来源标为 local（与网络层区分）', domItem?.source === 'local',
            `实际 ${domItem?.source}`);

        // pageUrl 必须归到被测页面：分组渲染靠它，错了会把条目挂到别的页面上
        check('结果的 pageUrl 指向被测页面',
            items.length > 0 && items.every((i) => i.pageUrl === `${base}/page`),
            items[0]?.pageUrl || '(空)');

        /*
         * 打开开关时立刻扫一次 —— 这是用户最直接感受到的那条路径。
         *
         * 页面**早就加载完了**，网络层一条都看不到。如果打开开关只等着新请求，
         * 用户看到的就是一个空列表，然后合理地认为"嗅探没实现"。
         *
         * ⚠️ 必须先把被测页激活。开关走的是"扫当前活动的标签页"（那正是用户
         * 点开开关时看着的那一页），而上面那条 offscreen 总线页把它顶掉了 ——
         * 不激活的话扫的是扩展页自己，测试会红，但红的是**测试环境**不是产品。
         */
        await ask({ target: 'sw', kind: 'sniffer-clear' });
        await sw.evaluate(`chrome.tabs.update(${tabId}, { active: true })`);
        await sleep(300);
        await ask({ target: 'sw', kind: 'sniffer-set-enabled', enabled: true });
        await sleep(1500);
        const afterEnable = await ask({ target: 'sw', kind: 'sniffer-get-state' });
        const enabledItems = afterEnable?.result?.items || [];
        check('打开开关时自动扫一次（页面已加载完，网络层看不到任何东西）',
            enabledItems.some((i) => i.url.endsWith(DOM_ONLY)),
            `开关打开后有 ${enabledItems.length} 条`);

        /*
         * 「清空当前页」只清这个页面，且必须**真的清掉东西**。
         *
         * 判据（isLinkFromPage）与界面上的「仅当前页」筛选必须是同一条 ——
         * 两处各写一份的后果实测过：没有 pageUrl 的条目在筛选下可见却清不掉，
         * 看起来像按钮没生效。
         *
         * 断言里带上 `removed > 0`：只断言"清完之后没有该页的条目"的话，
         * 在一条都没扫到的情况下会**空过**（0 条里当然没有该页的条目）。
         */
        const before = enabledItems.filter((i) => i.pageUrl === `${base}/page`).length;
        const cleared = await ask({ target: 'sw', kind: 'sniffer-clear-page', pageUrl: `${base}/page` });
        const afterClear = await ask({ target: 'sw', kind: 'sniffer-get-state' });
        check('清空当前页真的清掉了该页的条目（且不误伤别的页）',
            before > 0
            && cleared?.result?.removed === before
            && (afterClear?.result?.items || []).every((i) => i.pageUrl !== `${base}/page`),
            `清前 ${before} 条，清了 ${cleared?.result?.removed} 条`);

        await ask({ target: 'sw', kind: 'sniffer-set-enabled', enabled: false });

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
