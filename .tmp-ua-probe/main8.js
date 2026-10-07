// 探针 v8：单窗口最小对照。每轮只开一个窗口，地址全部 encodeURIComponent。
//  轮次：control(不覆写) / override-canon(内核匹配的 152.0.0.0) / override-lie(谎报 122)
const { app, session, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'play-ua-probe-profile8'));

const LOG = path.join(__dirname, 'result8.txt');
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

async function once(tag, uaValue) {
    const win = new BrowserWindow({ show: false });
    if (uaValue) win.webContents.setUserAgent(uaValue);
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
    dump(tag, outcome + '\npage: ' + identity + '\nserver: ' + JSON.stringify(received, null, 1));
    win.destroy();
    await new Promise((r) => setTimeout(r, 200));
}

async function main() {
    await app.whenReady();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    dump('default UA', session.defaultSession.getUserAgent());

    const kernelMajor = process.versions.chrome.split('.')[0];
    const canon = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + kernelMajor + '.0.0.0 Safari/537.36';
    const lie = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    dump('canon (kernel-matching)', canon);

    await once('control-no-override', null);
    await once('override-canon', canon);
    await once('override-lie-122', lie);

    srv.close();
    app.exit(0);
}

main().catch((e) => {
    dump('probe failed', (e && e.stack) || String(e));
    app.exit(1);
});
