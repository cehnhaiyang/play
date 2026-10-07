// 探针 A：验证修复后的身份链路
//   1) 会话级覆写（建窗前）→ 普通窗口 UA 头/navigator/sec-ch-ua 三者一致且无 Electron token
//   2) <webview> 不带 useragent 属性时，guest 是否继承会话 UA（修复方案的关键假设）
//   3) 出站是否仍带 sec-ch-ua（不再被删）
const { app, session, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { kernelUserAgent, applyKernelUserAgent } = require('../electron/userAgent');

app.setPath('userData', path.join(os.tmpdir(), 'play-identity-probe-a'));
app.on('window-all-closed', () => { });

const LOG = path.join(__dirname, 'identityA.txt');
fs.writeFileSync(LOG, '');
const dump = (label, v) => fs.appendFileSync(LOG, `\n### ${label}\n${v}\n`);

let received = [];
const srv = http.createServer((req, res) => {
    const h = req.headers;
    received.push({
        p: req.url,
        ua: h['user-agent'],
        ch: h['sec-ch-ua'] || null,
        chMobile: h['sec-ch-ua-mobile'] || null,
        chPlatform: h['sec-ch-ua-platform'] || null,
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><div id="x">host</div></body></html>');
});

const READ_IDENTITY = `(() => {
    const ud = navigator.userAgentData || null;
    return JSON.stringify({ ua: navigator.userAgent, brands: ud && ud.brands });
})()`;

async function main() {
    await app.whenReady();
    const ses = session.defaultSession;
    applyKernelUserAgent(ses);
    dump('expected canon UA', kernelUserAgent());
    dump('session UA after apply', ses.getUserAgent());

    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}/`;

    // 1) 普通窗口（等价于验证窗/挑战窗）
    received = [];
    const win = new BrowserWindow({ show: false });
    await win.loadURL(`${base}?case=plain`);
    dump('plain window page', await win.webContents.executeJavaScript(READ_IDENTITY));
    dump('plain window server', JSON.stringify(received));
    win.destroy();

    // 2) webview guest，不带 useragent 属性
    received = [];
    const host = new BrowserWindow({ show: false, webPreferences: { webviewTag: true } });
    await host.loadURL(`${base}?case=host`);
    const guestResult = await host.webContents.executeJavaScript(`new Promise((resolve) => {
        const w = document.createElement('webview');
        w.style.cssText = 'display:inline-block;width:420px;height:300px';
        w.src = ${JSON.stringify(base)} + '?case=guest';
        w.addEventListener('did-finish-load', () => {
            const ud = w.contentWindow.navigator.userAgentData;
            resolve(JSON.stringify({ loaded: true, ua: w.contentWindow.navigator.userAgent, brands: ud && ud.brands }));
        });
        w.addEventListener('did-fail-load', (e) => resolve(JSON.stringify({ loaded: false, code: e.errorCode, desc: e.errorDescription })));
        document.body.appendChild(w);
        setTimeout(() => resolve(JSON.stringify({ loaded: false, code: 'TIMEOUT' })), 10000);
    })`);
    await new Promise((r) => setTimeout(r, 400));
    dump('webview guest (no useragent attr)', guestResult);
    dump('guest server received', JSON.stringify(received, null, 1));
    host.destroy();

    srv.close();
    app.exit(0);
}

main().catch((e) => {
    dump('probe failed', (e && e.stack) || String(e));
    app.exit(1);
});
