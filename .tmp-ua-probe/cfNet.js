// 探针 N：只问一件事 —— 挑战窗口里 cloudflare 相关请求到底成没成。
// 不点击、不判定，只记录 onErrorOccurred / 200 响应，40s 到点就退。
const { app, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'play-cf-probe-c'));
if (process.env.PLAY_HOSTMAP !== '0') {
    app.commandLine.appendSwitch('host-resolver-rules', 'MAP brunhild.challenges.cloudflare.com 104.18.95.41');
}
app.on('window-all-closed', () => { });

const LOG = path.join(__dirname, process.env.PLAY_HOSTMAP === '0' ? 'cfNet-nomap.txt' : 'cfNet.txt');
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const log = (m) => fs.appendFileSync(LOG, `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
log('hostmap = ' + (process.env.PLAY_HOSTMAP === '0' ? '关' : '开（MAP brunhild→104.18.95.41）'));

const CF_RE = /cloudflare\.com/i;
const errs = new Map();
const oks = new Map();

async function main() {
    const { BrowserWindow } = require('electron');
    await app.whenReady();
    const ses = session.defaultSession;
    const proxy = process.env.PLAY_PROXY || '';
    if (proxy) {
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: proxy, proxyBypassRules: 'localhost;127.0.0.1;[::1]' });
    }
    log('proxy = ' + (proxy || '跟随系统'));

    ses.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
        if (!CF_RE.test(details.url)) return;
        const k = details.error + ' :: ' + details.url.replace(/https:\/\//, '').slice(0, 96);
        errs.set(k, (errs.get(k) || 0) + 1);
        log('ERR  ' + details.resourceType + '  ' + k + '  x' + errs.get(k));
    });
    ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
        if (!CF_RE.test(details.url)) return;
        const k = details.statusCode + ' :: ' + details.url.replace(/https:\/\//, '').slice(0, 96);
        oks.set(k, (oks.get(k) || 0) + 1);
        if (oks.get(k) === 1) log('OK   ' + details.resourceType + '  ' + k);
    });

    const win = new BrowserWindow({
        width: 520, height: 600, x: 100, y: 80, show: false,
        webPreferences: { contextIsolation: true, backgroundThrottling: false },
    });
    win.webContents.on('frame-fire-event', () => { });
    win.loadURL('https://www.acgmho.com/q/%E5%8F%98%E6%80%81%E8%80%81%E7%88%B7%E7%88%B7%E7%9A%84%E5%BF%92%E6%82%94%E5%AE%A4%E6%97%A5%E8%AE%B0-1.html').catch(() => { });
    win.showInactive();

    await new Promise((r) => setTimeout(r, 40000));
    log('汇总：cloudflare 成功 ' + oks.size + ' 类 / 失败 ' + errs.size + ' 类');
    for (const [k, n] of oks) log('  OK  x' + n + '  ' + k);
    for (const [k, n] of errs) log('  ERR x' + n + '  ' + k);
    const state = await win.webContents.executeJavaScript('document.title + " | " + document.documentElement.outerHTML.length').catch(() => '读不到');
    log('顶层页面 = ' + state);
    app.exit(0);
}

main().catch((e) => { log('FAILED ' + ((e && e.stack) || e)); app.exit(1); });
