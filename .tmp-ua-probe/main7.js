// 探针 v7：对照实验 —— 失败是"第二个窗口"还是"UA 覆写"造成的
//  A 无覆写 / B 无覆写 / C webContents.setUserAgent(122) / D <webview useragent=122>
const { app, session, BrowserWindow, webContents } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'play-ua-probe-profile7'));

const LOG = path.join(__dirname, 'result7.txt');
fs.writeFileSync(LOG, '');
const dump = (label, v) => fs.appendFileSync(LOG, `\n### ${label}\n${v}\n`);

const UA122 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const IDENTITY_JS = `(() => {
    const ud = navigator.userAgentData || null;
    return JSON.stringify({ navUA: navigator.userAgent, brands: ud && ud.brands });
})()`;

let received = [];
const srv = http.createServer((req, res) => {
    const h = req.headers;
    received.push({ p: req.url, ua: h['user-agent'], ch: h['sec-ch-ua'] });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><webview id="w"></webview></body></html>');
});

async function report(tag, wc, baseUrl) {
    try {
        dump(`${tag} page identity`, await wc.executeJavaScript(IDENTITY_JS));
        await wc.executeJavaScript(`fetch('/xhr?t=${Math.random()}').then(r=>r.status).catch(()=>0)`);
        await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
        dump(`${tag} js error`, e.message);
    }
    dump(`${tag} server received`, JSON.stringify(received, null, 1));
}

async function sampleWindow(tag, baseUrl, override) {
    const win = new BrowserWindow({ show: false });
    if (override) win.webContents.setUserAgent(override);
    received = [];
    try {
        await win.loadURL(`${baseUrl}?t=${Date.now()}&tag=${tag}`);
    } catch (e) {
        dump(`${tag} load ERROR`, e.message);
    }
    await report(tag, win.webContents, baseUrl);
    win.destroy();
}

async function main() {
    await app.whenReady();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${srv.address().port}/p`;
    dump('session default UA', session.defaultSession.getUserAgent());

    await sampleWindow('A 无覆写', baseUrl, null);
    await sampleWindow('B 无覆写', baseUrl, null);
    await sampleWindow('C wc覆写122', baseUrl, UA122);

    // D：webview 属性覆写（应用当前的用法）
    const win = new BrowserWindow({ show: false, webPreferences: { webviewTag: true } });
    received = [];
    await win.loadURL(`${baseUrl}?t=${Date.now()}&tag=D-host`);
    const guestInfo = await win.webContents.executeJavaScript(`new Promise((resolve) => {
        const w = document.createElement('webview');
        w.setAttribute('useragent', ${JSON.stringify(UA122)});
        w.src = ${JSON.stringify(baseUrl)} + '?guest=1';
        w.style.display = 'inline-block';
        w.addEventListener('did-finish-load', () => {
            resolve({ loaded: true, ua: w.getUserAgent ? undefined : undefined });
        });
        w.addEventListener('did-fail-load', (e) => resolve({ loaded: false, code: e.errorCode, desc: e.errorDescription }));
        document.body.appendChild(w);
        setTimeout(() => resolve({ loaded: false, code: 'TIMEOUT' }), 8000);
    })`);
    await new Promise((r) => setTimeout(r, 500));
    dump('D webview attribute', JSON.stringify(guestInfo));
    dump('D server received', JSON.stringify(received, null, 1));
    win.destroy();

    srv.close();
    app.exit(0);
}

main().catch((e) => {
    dump('probe failed', (e && e.stack) || String(e));
    app.exit(1);
});
