// 探针 v9：同 v8，但阻止 window-all-closed 退出（上一版因此只跑到第一轮）
const { app, session, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'play-ua-probe-profile9'));
app.on('window-all-closed', () => { /* 探针期间不许退出 */ });

const LOG = path.join(__dirname, 'result9.txt');
fs.writeFileSync(LOG, '');
const dump = (label, v) => fs.appendFileSync(LOG, `\n### ${label}\n${v}\n`);

const IDENTITY_JS = `(() => {
    const ud = navigator.userAgentData || null;
    return JSON.stringify({ ua: navigator.userAgent, brands: ud && ud.brands });
})()`;

let received = [];
const srv = http.createServer((req, res) => {
    const h = req.headers;
    received.push({ p: req.url, ua: h['user-agent'], ch: h['sec-ch-ua'], chP: h['sec-ch-ua-platform'] });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>ok</body></html>');
});

const UA = (major) => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36';

async function once(tag, uaValue, sessionLevel) {
    const ses = session.defaultSession;
    if (uaValue && sessionLevel) ses.setUserAgent(uaValue);
    const win = new BrowserWindow({ show: false });
    if (uaValue && !sessionLevel) win.webContents.setUserAgent(uaValue);
    received = [];
    let outcome = 'loaded';
    try {
        await win.loadURL('http://127.0.0.1:' + srv.address().port + '/page?tag=' + encodeURIComponent(tag));
    } catch (e) {
        outcome = 'LOAD ERROR: ' + e.message;
    }
    let identity = '(n/a)';
    try {
        identity = await win.webContents.executeJavaScript(IDENTITY_JS);
        await win.webContents.executeJavaScript("fetch('/xhr').then(r=>r.status).catch(e=>String(e))");
        await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
        identity = 'JS ERROR: ' + e.message;
    }
    dump(tag, outcome + '\npage: ' + identity + '\nserver: ' + JSON.stringify(received));
    win.destroy();
    if (sessionLevel) ses.setUserAgent(ses.getUserAgent());
}

async function main() {
    await app.whenReady();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    dump('default UA', session.defaultSession.getUserAgent());
    const kernelMajor = process.versions.chrome.split('.')[0];

    await once('control', null);
    await once('wc-override-canon-' + kernelMajor, UA(kernelMajor));
    await once('wc-override-lie-122', UA('122'));
    session.defaultSession.setUserAgent(session.defaultSession.getUserAgent());
    await once('ses-override-canon', UA(kernelMajor), true);

    srv.close();
    app.exit(0);
}

main().catch((e) => {
    dump('probe failed', (e && e.stack) || String(e));
    app.exit(1);
});
