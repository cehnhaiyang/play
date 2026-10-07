// 探针 C：端到端 A/B/C —— 唯一变量是"会话 UA 怎么来"。
//   PLAY_UA=raw       → 完全不覆写（引擎自己的 UA，含 Electron/44.4.5 token）
//   PLAY_UA=tokenless → 只把 Electron/应用 token 从默认 UA 里摘掉，四位全版本号照实保留
//   PLAY_UA=masked    → 走 applyKernelUserAgent（Chrome/152.0.0.0，版本被掩成 x.0.0.0）
// 三组都用同一套 host-resolver-rules / 会话代理 / Referer 规则 / solver。
const { app, session, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { channelListUrl, isCloudflareChallengePage, isCloudflareErrorPage, parseChannelList } = require('../electron/acgmhoService');
const { solveChallengeWithBrowser } = require('../electron/challengeSolver');

app.setPath('userData', path.join(os.tmpdir(), 'play-cf-probe-c'));
// 与 electron/main.js 保持一致：brunhild.challenges.cloudflare.com 只有 AAAA 记录
// 这条 MAP 映射到的是 challenges.cloudflare.com 的 A 记录（主机名与 IP 不对应），
// 走代理时不生效、直连时会把挑战子帧打到错误端点上，所以留开关对照。
if (process.env.PLAY_HOSTMAP !== '0') {
    app.commandLine.appendSwitch('host-resolver-rules', 'MAP brunhild.challenges.cloudflare.com 104.18.95.41');
}
app.on('window-all-closed', () => { });

// prod = 与生产一致（不改写任何 UA）；masked = 当年那套"派生 Chrome/<major>.0.0.0"的覆写，
// 留在这里只为把 A/B 复现出来，别再往生产代码里带。
const UA_MODE = process.env.PLAY_UA || 'prod';
const OUT = { prod: 'cfC.txt', masked: 'cfC-masked.txt' }[UA_MODE];
const LOG = path.join(__dirname, OUT);
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const log = (m) => fs.appendFileSync(LOG, `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);

const QUERY = '变态老爷爷的忏悔室日记';
const PROXY = 'http://127.0.0.1:10810';

// 本地 data: 页取一次运行时身份快照：UA-CH / window.chrome 这些是内核给的，
// 用来判断"UA 字符串"和"UA 元数据"到底一不一致
async function identitySnapshot(ses) {
    const win = new BrowserWindow({ width: 420, height: 200, show: false, webPreferences: { session: ses } });
    try {
        await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8">id');
        return await win.webContents.executeJavaScript(`({
            ua: navigator.userAgent,
            brands: (navigator.userAgentData && navigator.userAgentData.brands) || null,
            platform: (navigator.userAgentData && navigator.userAgentData.platform) || null,
            chromeKeys: window.chrome ? Object.keys(window.chrome) : null,
            plugins: navigator.plugins.length,
            webdriver: navigator.webdriver,
        })`);
    } catch (_e) {
        return null;
    } finally {
        if (!win.isDestroyed()) win.close();
    }
}

async function main() {
    await app.whenReady();
    const ses = session.defaultSession;
    if (UA_MODE === 'masked') {
        applyKernelUserAgent(ses);
    } else if (UA_MODE === 'tokenless') {
        // 只摘 Electron/<版本> 与应用名 token，版本号照引擎的实际四位写
        const ua = ses.getUserAgent()
            .replace(/\s*Electron\/[\d.]+/, '')
            .replace(new RegExp('\\s*' + app.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[\\d.]+'), '');
        ses.setUserAgent(ua);
    }
    log('mode = ' + UA_MODE);
    log('session UA = ' + ses.getUserAgent());

    const id = await identitySnapshot(ses);
    log('identity = ' + JSON.stringify(id));

    // 默认**不绑代理**：跟随系统（全局 TUN 下直连就能出）。
    // 只有显式给了 PLAY_PROXY 才走固定服务器——之前这里硬编码 127.0.0.1:10810，
    // 等于把"验证没过"和"白鲸没开"混成一件事，是自己给自己造的假故障。
    const PROXY = process.env.PLAY_PROXY || '';
    if (PROXY) {
        await ses.setProxy({
            mode: 'fixed_servers',
            proxyRules: PROXY,
            proxyBypassRules: 'localhost;127.0.0.1;[::1]',
        });
        log('proxy = ' + PROXY);
    } else {
        log('proxy = 跟随系统（不设 fixed_servers）');
    }

    // 与修复后的 applyRequestHeaderRules 一致：只补防盗链 Referer，不碰 UA / sec-ch-ua
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, cb) => {
        const h = { ...details.requestHeaders };
        let hostname = '';
        try { hostname = new URL(details.url).hostname; } catch (_e) { }
        if (/(^|\.)acgmho\.com$/i.test(hostname)) h.Referer = 'https://www.acgmho.com/';
        cb({ requestHeaders: h });
    });

    const url = channelListUrl('search', 1, QUERY);
    log('url = ' + url);

    const started = Date.now();
    let html = '';
    let finalUrl = url;
    let userAgent = '';
    let solveError = '';
    try {
        const out = await solveChallengeWithBrowser({
            url,
            isChallengePage: isCloudflareChallengePage,
            isErrorPage: isCloudflareErrorPage,
            deadlineMs: 120000,
            log,
        });
        html = out.html;
        finalUrl = out.finalUrl;
        userAgent = out.userAgent;
    } catch (e) {
        solveError = String((e && e.message) || e);
        log('solver threw: ' + solveError);
    }
    const cost = ((Date.now() - started) / 1000).toFixed(1);

    log('solved in ' + cost + 's, finalUrl = ' + finalUrl);
    log('html bytes = ' + html.length);
    log('still challenge page? ' + (html ? isCloudflareChallengePage(html) : 'n/a'));

    const items = html ? parseChannelList(html) : [];
    log('parsed items = ' + (Array.isArray(items) ? items.length : JSON.stringify(items)).toString().slice(0, 200));
    if (Array.isArray(items)) {
        for (const it of items.slice(0, 3)) log('  · ' + String(it.title || it.name || JSON.stringify(it)).slice(0, 90));
    }
    fs.appendFileSync(LOG, '\nRESULT ' + JSON.stringify({
        mode: UA_MODE,
        pass: !solveError && !!html && !isCloudflareChallengePage(html) && html.length > 500,
        costSec: Number(cost),
        itemCount: Array.isArray(items) ? items.length : -1,
        error: solveError,
    }) + '\n');
    app.exit(solveError ? 1 : 0);
}

main().catch((e) => {
    log('FAILED: ' + ((e && e.stack) || String(e)));
    fs.appendFileSync(LOG, '\nRESULT {"pass":false,"error":"' + String((e && e.message) || e).replace(/"/g, "'") + '"}\n');
    app.exit(1);
});
