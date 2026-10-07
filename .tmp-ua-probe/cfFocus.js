// 只测一个变量：solver 那个窗口是**聚焦的前台窗口**时，点击还算不算自动化。
// 上一轮 12 次点击全部经 CDP 送达、组件仍 verifying→重建；而真 Chrome 一次点击就放行。
// 两边剩下的差别里最可疑的是窗口焦点：人点复选框时窗口一定在前台，
// showInactive() 的窗口收到点击是"后台窗口被点"，这正是脚本特征。
// 探针不改产品代码：窗口一出现就用 BrowserWindow.getAllWindows() 抓过来 show+focus。
const { app, session, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { channelListUrl, isCloudflareChallengePage, isCloudflareErrorPage } = require('../electron/acgmhoService');
const { solveChallengeWithBrowser } = require('../electron/challengeSolver');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'play-cf-focus-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP brunhild.challenges.cloudflare.com 104.18.95.41');
app.on('window-all-closed', () => { });

const OUT = path.join(__dirname, 'cfFocus.txt');
fs.writeFileSync(OUT, '');
const t0 = Date.now();
const log = (m) => fs.appendFileSync(OUT, `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const QUERY = '变态老爷爷的忏悔室日记';

async function main() {
    await app.whenReady();
    const ses = session.defaultSession;
    log('profile = ' + PROFILE + '\nUA = ' + ses.getUserAgent());

    // 盯住 solver 建的窗口：一旦出现就摆到前台并聚焦，之后每 2s 重新确认一次焦点
    let watched = null;
    const timer = setInterval(async () => {
        const extra = BrowserWindow.getAllWindows().filter((w) => w !== watched && !w.isDestroyed());
        if (extra.length) {
            watched = extra[extra.length - 1];
            log('抓到验证窗口，show + focus + 移到 (60,60)');
        }
        if (!watched || watched.isDestroyed()) return;
        try {
            watched.show();
            watched.focus();
            const st = await watched.webContents.executeJavaScript(
                'JSON.stringify({vis:document.visibilityState,focus:document.hasFocus(),t:document.title})');
            const o = JSON.parse(st);
            if (o.focus !== true) log(`焦点丢了 vis=${o.vis} title=${o.t.slice(0, 20)} → 再 focus 一次`);
        } catch (_e) { /* 导航中，下一轮再看 */ }
    }, 2000);

    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, cb) => {
        const h = { ...details.requestHeaders };
        let hostname = '';
        try { hostname = new URL(details.url).hostname; } catch (_e) { }
        if (/(^|\.)acgmho\.com$/i.test(hostname)) h.Referer = 'https://www.acgmho.com/';
        cb({ requestHeaders: h });
    });

    const url = channelListUrl('search', 1, QUERY);
    const started = Date.now();
    let html = '';
    let solveError = '';
    try {
        const out = await solveChallengeWithBrowser({
            url,
            isChallengePage: isCloudflareChallengePage,
            isErrorPage: isCloudflareErrorPage,
            deadlineMs: 90000,
            log,
        });
        html = out.html;
    } catch (e) {
        solveError = String((e && e.message) || e);
        log('solver threw: ' + solveError);
    }
    clearInterval(timer);
    const cost = ((Date.now() - started) / 1000).toFixed(1);
    log('html bytes = ' + html.length);
    fs.appendFileSync(OUT, '\nRESULT ' + JSON.stringify({
        pass: !solveError && !!html && !isCloudflareChallengePage(html) && html.length > 500,
        costSec: Number(cost), error: solveError,
    }) + '\n');
    app.exit(solveError ? 1 : 0);
}
main();
