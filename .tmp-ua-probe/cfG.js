// 现场取证 4：点击已经进到组件（消息数与像素都变了），剩下的问题是 CF 判了什么。
// 抓三样：组件与往页面上发的消息内容、组件帧的可读文案、以及本机的指纹信号。
const { app, session, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { applyKernelUserAgent } = require('../electron/userAgent');
const { channelListUrl, isCloudflareChallengePage } = require('../electron/acgmhoService');

app.setPath('userData', path.join(os.tmpdir(), 'play-cf-probe-g'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP brunhild.challenges.cloudflare.com 104.18.95.41');
app.on('window-all-closed', () => { });

const LOG = path.join(__dirname, 'cfG.txt');
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const log = (m) => fs.appendFileSync(LOG, `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PROXY = 'http://127.0.0.1:10810';
const QUERY = '变态老爷爷的忏悔室日记';

const HOOK = `(() => {
  window.__msgs = window.__msgs || [];
  if (!window.__hooked) {
    window.__hooked = 1;
    window.addEventListener('message', (e) => {
      let d; try { d = JSON.stringify(e.data); } catch (_err) { d = String(e.data); }
      window.__msgs.push({ i: window.__msgs.length, org: String(e.origin).slice(0, 40), d: String(d).slice(0, 220) });
    }, true);
  }
  return window.__msgs.length;
})()`;

const FP = `(() => {
  const gl = document.createElement('canvas').getContext('webgl');
  const ex = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return JSON.stringify({
    ua: navigator.userAgent.slice(0, 120),
    webdriver: navigator.webdriver,
    plugins: navigator.plugins.length,
    pdf: navigator.pdfViewerEnabled,
    uaData: navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform, fv: navigator.userAgentData.getHighEntropyValues ? 'fn' : '-' } : null,
    hw: navigator.hardwareConcurrency, mem: navigator.deviceMemory,
    touch: navigator.maxTouchPoints,
    vendor: navigator.vendor, lang: navigator.language, langs: navigator.languages.join(','),
    chrome: typeof window.chrome === 'object' ? Object.keys(window.chrome).slice(0, 8) : null,
    electron: typeof window.process !== 'undefined' && !!window.process.versions?.electron,
    gl: ex ? { vendor: gl.getParameter(ex.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ex.UNMASKED_RENDERER_WEBGL) } : null,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
})()`;

const WIDGET_DUMP = `(() => {
  const q = (s) => [...document.querySelectorAll(s)];
  const rect = (e) => { const r = e.getBoundingClientRect(); return e.tagName + '#' + (e.id || '') + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); };
  return JSON.stringify({
    url: location.href.slice(0, 130),
    bodyLen: document.body ? document.body.innerHTML.length : -1,
    txt: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 160),
    frames: q('iframe').map(rect).slice(0, 6),
    cands: q('input,[role=checkbox],label,.cb-lb,.cb-c').map(rect).slice(0, 8),
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
        title: 'CF 取证G', webPreferences: { contextIsolation: true, backgroundThrottling: false },
    });
    const wc = win.webContents;
    wc.debugger.attach('1.3');
    win.loadURL(channelListUrl('search', 1, QUERY));
    win.showInactive();
    await wait(10000);
    log('指纹 = ' + await wc.executeJavaScript(FP).catch((e) => '失败:' + e.message));
    await wc.executeJavaScript(HOOK).catch(() => { });

    const dumpWidgetFrames = async (tag) => {
        const targets = (await wc.debugger.sendCommand('Target.getTargets')).targetInfos
            .filter((t) => /challenges\.cloudflare\.com/.test(t.url || ''));
        log(`${tag} cloudflare 目标 ${targets.length} 个`);
        for (const t of targets) {
            try {
                const { sessionId } = await wc.debugger.sendCommand('Target.attachToTarget', { targetId: t.targetId, flatten: true });
                const tree = await wc.debugger.sendCommand('Page.getFrameTree', {}, sessionId);
                const world = await wc.debugger.sendCommand('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id }, sessionId);
                const r = await wc.debugger.sendCommand('Runtime.evaluate', {
                    expression: WIDGET_DUMP, contextId: world.executionContextId, returnByValue: true,
                }, sessionId);
                log(`${tag} [${t.type}] ${String(r.result && r.result.value).slice(0, 460)}`);
            } catch (e) { log(`${tag} [${String(t.url).slice(0, 50)}] 读取失败: ${e.message}`); }
        }
    };
    await dumpWidgetFrames('t=10s');

    const msgs = async (from) => wc.executeJavaScript(`window.__msgs.slice(${from})`)
        .catch(() => []);

    let seen = 0;
    for (let round = 1; round <= 5; round++) {
        await wait(6000);
        log(`--- 轮${round} 新消息 = ` + JSON.stringify(await msgs(seen)));
        seen += (await msgs(seen)).length;
        const st = await wc.executeJavaScript('({t:document.title,len:document.documentElement.outerHTML.length})').catch(() => null);
        log(`--- 轮${round} 页面 = ${JSON.stringify(st)}`);
        if (round === 3) { await dumpWidgetFrames(`轮${round}`); }
        // 每轮点一次复选框（实测位置 x[25..48] y[325..348]）
        const x = 36, y = 336;
        win.focus(); wc.focus();
        const dm = (type, extra) => wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, pointerType: 'mouse', pointerID: 1, ...extra });
        try {
            await dm('mouseMoved', { buttons: 0 });
            await wait(80);
            await dm('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
            await wait(120);
            await dm('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
        } catch (e) { log(`轮${round} 点击失败: ${e.message}`); }
    }
    const html = await wc.executeJavaScript('document.documentElement.outerHTML').catch(() => '');
    log('最终 挑战页=' + isCloudflareChallengePage(html) + ' htmlLen=' + html.length);
    try {
        fs.writeFileSync(path.join(__dirname, 'cfG.png'), (await wc.capturePage()).toPNG());
    } catch (e) { log('截图失败: ' + e.message); }
    wc.debugger.detach();
    app.exit(0);
}

main().catch((e) => { log('FAILED: ' + ((e && e.stack) || String(e))); app.exit(1); });
