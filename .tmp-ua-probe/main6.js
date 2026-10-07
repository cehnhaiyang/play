// 探针 v6：只看 webContents 级覆写（谎报 122）时，UA 头 / navigator / sec-ch-ua 三者是否一致
const { app, session, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'play-ua-probe-profile6'));

const LOG = path.join(__dirname, 'result6.txt');
fs.writeFileSync(LOG, '');
const dump = (label, v) => fs.appendFileSync(LOG, `\n### ${label}\n${v}\n`);

const IDENTITY_JS = `(() => {
    const ud = navigator.userAgentData || null;
    return JSON.stringify({ navUA: navigator.userAgent, brands: ud && ud.brands });
})()`;

let received = [];
const srv = http.createServer((req, res) => {
    const h = req.headers;
    received.push({ p: req.url, ua: h['user-agent'], ch: h['sec-ch-ua'], chM: h['sec-ch-ua-mobile'] });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>ok</body></html>');
});

async function sample(baseUrl, tag, uaOverride) {
    const win = new BrowserWindow({ show: false });
    if (uaOverride) win.webContents.setUserAgent(uaOverride);
    received = [];
    try {
        await win.loadURL(baseUrl + '?t=' + Date.now());
    } catch (e) {
        dump(`${tag} load error`, e.message);
    }
    try {
        dump(`${tag} page identity`, await win.webContents.executeJavaScript(IDENTITY_JS));
        await win.webContents.executeJavaScript(`fetch('/xhr').then(r=>r.status).catch(()=>0)`);
        await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
        dump(`${tag} js error`, e.message);
    }
    dump(`${tag} server received`, JSON.stringify(received, null, 1));
    win.destroy();
}

async function main() {
    await app.whenReady();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${srv.address().port}/p`;
    dump('session default UA', session.defaultSession.getUserAgent());

    await sample(baseUrl, 'A no override');
    await sample(baseUrl, 'B wc override 122', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    srv.close();
    app.exit(0);
}

main().catch((e) => {
    dump('probe failed', (e && e.stack) || String(e));
    app.exit(1);
});
