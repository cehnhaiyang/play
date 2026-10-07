// 现场取证 2：只用浏览器侧 CDP 看清 CF 组件到底在哪个帧、复选框在哪个坐标。
// 关键手法（Puppeteer 打跨域 iframe 的同一套）：Target.getTargets → attachToTarget(flatten)
// → 子会话里 Page.createIsolatedWorld → Runtime.evaluate 拿元素 rect。
const { app, session, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { applyKernelUserAgent } = require('../electron/userAgent');
const { channelListUrl } = require('../electron/acgmhoService');

app.setPath('userData', path.join(os.tmpdir(), 'play-cf-probe-e'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP brunhild.challenges.cloudflare.com 104.18.95.41');
app.on('window-all-closed', () => { });

const LOG = path.join(__dirname, 'cfE.txt');
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const log = (m) => fs.appendFileSync(LOG, `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PROXY = 'http://127.0.0.1:10810';
const QUERY = '变态老爷爷的忏悔室日记';

const DUMP = `(() => {
  const q = (s) => [...document.querySelectorAll(s)];
  const rect = (e) => { const r = e.getBoundingClientRect(); return e.tagName + '#' + (e.id||'') + '.' + (String(e.className||'').slice(0,18)) + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); };
  return JSON.stringify({
    url: location.href.slice(0, 120),
    bodyLen: document.body ? document.body.innerHTML.length : -1,
    txt: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 120),
    frames: q('iframe').map(rect).slice(0, 6),
    cands: q('input,[role=checkbox],label,.cb-lb,#challenge-stage').map(rect).slice(0, 8),
    dpr: window.devicePixelRatio, iw: innerWidth, ih: innerHeight, sy: scrollY,
  });
})()`;

async function main() {
    await app.whenReady();
    const ses = session.defaultSession;
    applyKernelUserAgent(ses);
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: PROXY, proxyBypassRules: 'localhost;127.0.0.1;[::1]' });
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, cb) => {
        const h = { ...details.requestHeaders };
        let hostname = '';
        try { hostname = new URL(details.url).hostname; } catch (_e) { }
        if (/(^|\.)acgmho\.com$/i.test(hostname)) h.Referer = 'https://www.acgmho.com/';
        cb({ requestHeaders: h });
    });

    const wa = screen.getPrimaryDisplay().workArea;
    const win = new BrowserWindow({
        width: 520, height: 600, x: wa.x + 40, y: wa.y + 40, show: false,
        webPreferences: { contextIsolation: true, backgroundThrottling: false },
    });
    const wc = win.webContents;
    const dbg = wc.debugger;
    dbg.attach('1.3');
    win.loadURL(channelListUrl('search', 1, QUERY));
    win.showInactive();
    await wait(14000);

    log('主帧 dump = ' + await wc.executeJavaScript(DUMP));
    const targets = (await dbg.sendCommand('Target.getTargets')).targetInfos
        .filter((t) => /cloudflare|acgmho/.test(t.url || ''));
    log(`Target 列表 ${targets.length}: ` + targets.map((t) => `${t.type}@${String(t.url).slice(0, 60)}`).join(' | '));

    for (const t of targets) {
        let sid = null;
        try {
            ({ sessionId: sid } = await dbg.sendCommand('Target.attachToTarget', { targetId: t.targetId, flatten: true }));
        } catch (e) { log(`attach 失败 ${t.url.slice(0, 50)}: ${e.message}`); continue; }
        try {
            const tree = await dbg.sendCommand('Page.getFrameTree', {}, sid);
            const fid = tree.frameTree.frame.id;
            const world = await dbg.sendCommand('Page.createIsolatedWorld', { frameId: fid }, sid);
            const r = await dbg.sendCommand('Runtime.evaluate', {
                expression: DUMP, contextId: world.executionContextId, returnByValue: true,
            }, sid);
            log(`子会话[${t.type} ${String(t.url).slice(0, 70)}] frameId=${fid} → ${r.result && r.result.value}`);
        } catch (e) {
            log(`子会话[${String(t.url).slice(0, 60)}] 取内容失败: ${e.message}`);
        }
    }

    // 顶层坐标下组件里到底命中了什么节点
    for (const [x, y] of [[40, 336], [38, 362], [60, 336], [200, 336], [40, 320]]) {
        try {
            const n = await dbg.sendCommand('DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: true });
            let desc = '';
            try {
                const d = await dbg.sendCommand('DOM.describeNode', { nodeId: n.nodeId });
                desc = `${d.node.nodeName}#${d.node.attributes ? '' : ''} frameId=${n.frameId}`;
            } catch (_e) { desc = `nodeId=${n.nodeId}`; }
            log(`hitTest(${x},${y}) → ${desc}`);
        } catch (e) { log(`hitTest(${x},${y}) 失败: ${e.message}`); }
    }

    fs.writeFileSync(path.join(__dirname, 'cfE.png'), (await wc.capturePage()).toPNG());
    log('DPR/尺寸：窗口内容 = ' + JSON.stringify(win.getContentBounds()) + ' 截图 = ' + JSON.stringify((await wc.capturePage()).getSize()));
    dbg.detach();
    app.exit(0);
}

main().catch((e) => { log('FAILED: ' + ((e && e.stack) || String(e))); app.exit(1); });
