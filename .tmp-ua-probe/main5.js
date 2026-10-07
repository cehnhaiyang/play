// 探针 v5：本地 HTTP 服务收请求头（服务端真相），对照
//   baseline / session 覆写(内核匹配 152.0.0.0) / webContents 覆写(谎报 122)
const { app, session, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'play-ua-probe-profile5'));
app.commandLine.appendSwitch('disable-gpu');

const LOG = path.join(__dirname, 'result5.txt');
fs.writeFileSync(LOG, '');
const dump = (label, v) => fs.appendFileSync(LOG, `\n### ${label}\n${v}\n`);

function deriveChromeUa(defaultUa) {
    return String(defaultUa)
        .replace(/ (?:[A-Za-z][A-Za-z0-9 ._()-]*\/[0-9][0-9a-zA-Z.+-]*)+(?= Chrome\/)/, '')
        .replace(/ Electron\/[0-9][0-9a-zA-Z.+-]*/, '')
        .replace(/ Chrome\/(\d+)(?:\.[0-9a-zA-Z.+-]+)+/, ' Chrome/$1.0.0.0');
}

const IDENTITY_JS = `(() => {
    const ud = navigator.userAgentData || null;
    return JSON.stringify({ ua: navigator.userAgent, brands: ud && ud.brands });
})()`;

let srv;
let received = [];

function startServer() {
    return new Promise((resolve) => {
        srv = http.createServer((req, res) => {
            const h = req.headers;
            received.push({
                path: req.url,
                ua: h['user-agent'],
                ch: h['sec-ch-ua'],
                chMobile: h['sec-ch-ua-mobile'],
                chPlatform: h['sec-ch-ua-platform'],
            });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><html><head><title>p</title></head><body>ok</body></html>');
        });
        srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}/`));
    });
}

async function sample(baseUrl, tag, mutate) {
    const win = new BrowserWindow({ show: false });
    if (mutate) mutate(win.webContents);
    received = [];
    await win.loadURL(baseUrl).catch((e) => dump(`${tag} load error`, e.message));
    const page = await win.webContents.executeJavaScript(IDENTITY_JS).catch((e) => 'ERR ' + e.message);
    await win.webContents.executeJavaScript(`fetch('/xhr?tag=${tag}').then(r=>r.status).catch(()=>0)`).catch(() => 0);
    await new Promise((r) => setTimeout(r, 350));
    dump(`${tag} page identity`, page);
    dump(`${tag} server received`, JSON.stringify(received, null, 1));
    win.destroy();
}

async function main() {
    await app.whenReady();
    const ses = session.defaultSession;
    const baseUrl = await startServer();
    const defaultUa = ses.getUserAgent();
    const clean = deriveChromeUa(defaultUa);
    dump('default UA', defaultUa);
    dump('derived clean UA', clean);

    await sample(baseUrl, 'A baseline');

    ses.setUserAgent(clean);
    await sample(baseUrl, 'B session override (152.0.0.0)');

    ses.setUserAgent(defaultUa);
    await sample(baseUrl, 'C wc override 谎报 122', (wc) => wc.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'));

    srv.close();
    app.exit(0);
}

main().catch((e) => {
    dump('probe failed', (e && e.stack) || String(e));
    app.exit(1);
});
