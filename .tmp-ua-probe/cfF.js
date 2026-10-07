// 现场取证 3：点击到底有没有进到 CF 组件。
// 判据不看顶层 HTML（组件内部变化不会改顶层文档），而是看两件事：
//   1) 组件与页面之间的 postMessage 流量（Turnstile 一定会往父帧发消息）
//   2) 复选框区域的像素指纹在点击前后有没有变
const { app, session, BrowserWindow, screen, nativeImage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { applyKernelUserAgent } = require('../electron/userAgent');
const { channelListUrl } = require('../electron/acgmhoService');

app.setPath('userData', path.join(os.tmpdir(), 'play-cf-probe-f'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP brunhild.challenges.cloudflare.com 104.18.95.41');
app.on('window-all-closed', () => { });

const LOG = path.join(__dirname, 'cfF.txt');
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const log = (m) => fs.appendFileSync(LOG, `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PROXY = 'http://127.0.0.1:10810';
const QUERY = '变态老爷爷的忏悔室日记';
// 复选框实测位置：x[25..48] y[325..348]
const BOX = { x0: 20, y0: 320, x1: 55, y1: 352 };

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
        title: 'CF 取证', webPreferences: { contextIsolation: true, backgroundThrottling: false },
    });
    const wc = win.webContents;
    wc.debugger.attach('1.3');
    win.loadURL(channelListUrl('search', 1, QUERY));
    win.showInactive();
    await wait(12000);

    const hook = `(() => {
      window.__msgs = window.__msgs || [];
      if (!window.__hooked) {
        window.__hooked = 1;
        window.addEventListener('message', (e) => {
          window.__msgs.push({ org: String(e.origin).slice(0, 40), d: String(e.data).slice(0, 110) });
        }, true);
      }
      return { msgs: window.__msgs.length, focus: document.hasFocus(), vis: document.visibilityState };
    })()`;
    log('挂钩 ' + JSON.stringify(await wc.executeJavaScript(hook)));
    await wait(4000);
    log('基线 ' + JSON.stringify(await wc.executeJavaScript(hook)));
    log('基线消息 ' + JSON.stringify(await wc.executeJavaScript('window.__msgs.slice(-8)')));

    const hashRegion = async () => {
        const img = await wc.capturePage({ x: BOX.x0, y: BOX.y0, width: BOX.x1 - BOX.x0, height: BOX.y1 - BOX.y0 });
        const b = img.getBitmap();
        let h = 0, dark = 0;
        for (let i = 0; i < b.length; i += 4) { h = (h * 31 + b[i]) >>> 0; if (b[i] < 120) dark += 1; }
        return `${img.getSize().width}x${img.getSize().height} h=${h} dark=${dark}`;
    };
    log('点击前复选框区 = ' + await hashRegion());

    const x = 36, y = 336;
    win.focus(); wc.focus();
    const dm = (type, extra) => wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, pointerType: 'mouse', pointerID: 1, ...extra });
    await dm('mouseMoved', { buttons: 0 });
    await wait(80);
    await dm('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
    await wait(120);
    await dm('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
    log(`已点击 (${x},${y}) focus=${JSON.stringify(await wc.executeJavaScript('document.hasFocus()'))}`);

    for (const t of [2, 5, 10]) {
        await wait(t === 2 ? 2000 : t === 5 ? 3000 : 5000);
        log(`+${t}s 状态=${JSON.stringify(await wc.executeJavaScript(hook))} 复选框区=${await hashRegion()}`);
        log(`+${t}s 消息=${JSON.stringify(await wc.executeJavaScript('window.__msgs.slice(-10)'))}`);
    }
    fs.writeFileSync(path.join(__dirname, 'cfF.png'), (await wc.capturePage()).toPNG());
    const st = await wc.executeJavaScript('({t:document.title,u:location.href,len:document.documentElement.outerHTML.length})');
    log('最终 ' + JSON.stringify(st) + ' 挑战页=' + require('../electron/acgmhoService').isCloudflareChallengePage(await wc.executeJavaScript('document.documentElement.outerHTML')));
    wc.debugger.detach();
    app.exit(0);
}

main().catch((e) => { log('FAILED: ' + ((e && e.stack) || String(e))); app.exit(1); });
