// 分离"CDP 调试器本身被识别为自动化"这个变量。
// Turnstile 有一类检测是"当前有没有 DevTools 会话"（经典手法：给 error.stack 装 getter，
// 只有调试器序列化过这个对象才会触发）。而我们为了点跨进程子帧，每次都要 attach debugger。
// 这一轮把 CF 子帧拉回**同进程**（--disable-features=IsolateOrigins,site-per-process），
// 于是 wc.sendInputEvent 就能点到它，全程不 attach 调试器。
// 只用产品里现成的盒模型函数 findTurnstileHostBox（不依赖 CDP），不改产品代码。
const { app, session, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { channelListUrl, isCloudflareChallengePage } = require('../electron/acgmhoService');
const { findTurnstileHostBox, probeTurnstileFrame } = require('../electron/challengeSolver');

app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP brunhild.challenges.cloudflare.com 104.18.95.41');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'play-cf-nocdp-'));
app.setPath('userData', PROFILE);
app.on('window-all-closed', () => { });

const OUT = path.join(__dirname, 'cfNoCdp.txt');
fs.writeFileSync(OUT, '');
const t0 = Date.now();
const log = (m) => fs.appendFileSync(OUT, `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const QUERY = '变态老爷爷的忏悔室日记';

async function main() {
    await app.whenReady();
    const ses = session.defaultSession;
    log('profile = ' + PROFILE);
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, cb) => {
        const h = { ...details.requestHeaders };
        let hostname = '';
        try { hostname = new URL(details.url).hostname; } catch (_e) { }
        if (/(^|\.)acgmho\.com$/i.test(hostname)) h.Referer = 'https://www.acgmho.com/';
        cb({ requestHeaders: h });
    });

    const win = new BrowserWindow({ width: 1000, height: 800, x: 60, y: 60, show: true });
    const wc = win.webContents;
    log('调试器是否 attach = ' + wc.debugger.isAttached());

    const url = channelListUrl('search', 1, QUERY);
    log('url = ' + url);
    await win.loadURL(url).catch(() => { });
    win.focus();

    const deadline = Date.now() + 75000;
    let clicks = 0;
    let lastTitle = '';
    let nextAt = Date.now() + 9000;
    while (Date.now() < deadline) {
        await wait(1500);
        const st = await wc.executeJavaScript(
            'JSON.stringify({t:document.title,l:document.documentElement.innerHTML.length})').catch(() => null);
        if (!st) continue;
        const o = JSON.parse(st);
        if (o.t !== lastTitle) { log(`title=${o.t.slice(0, 40)} len=${o.l}`); lastTitle = o.t; }
        if (o.l > 6000 && !/请稍候|安全验证/.test(o.t)) {
            log('放行');
            fs.appendFileSync(OUT, '\nRESULT ' + JSON.stringify({ pass: true, clicks, costSec: +((Date.now() - t0) / 1000).toFixed(1) }) + '\n');
            app.exit(0);
            return;
        }
        // 帧树：同进程开关生效的话，CF 帧会出现在这里且能被 executeJavaScript 读到
        const tree = wc.mainFrame.framesInSubtree
            .map((f) => f.url).filter((u) => /cloudflare/.test(u));
        if (Date.now() >= nextAt && clicks < 6) {
            nextAt = Date.now() + 11000;
            clicks += 1;
            const probe = await probeTurnstileFrame(wc, { click: false, log: null });
            const box = await findTurnstileHostBox(wc);
            log(`点击 #${clicks}：cf帧树=${JSON.stringify(tree)} 帧内=${probe ? JSON.stringify(probe.rect) + ' ' + String(probe.text).slice(0, 20) : '读不到'} `
                + `盒=${box ? `(${Math.round(box.left)},${Math.round(box.top)}) ${Math.round(box.width)}x${Math.round(box.height)}` : '无'}`);
            if (!box) continue;
            const px = Math.round(box.left + Math.min(24, box.width / 2));
            const py = Math.round(box.top + box.height / 2);
            for (let i = 0; i < 5; i += 1) {
                wc.sendInputEvent({ type: 'mouseMove', x: px - 40 + i * 10, y: py - 20 + i * 5 });
                await wait(30);
            }
            wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
            await wait(120);
            wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
            await wait(90);
            wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
            log(`sendInputEvent @(${px},${py})`);
        }
    }
    log('调试器是否 attach（结束）= ' + wc.debugger.isAttached());
    fs.appendFileSync(OUT, '\nRESULT ' + JSON.stringify({ pass: false, clicks, costSec: 75 }) + '\n');
    app.exit(1);
}
main();
