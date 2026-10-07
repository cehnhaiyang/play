// 干净 profile 的端到端复测：把"脏 cookie"这个变量摘掉。
// 之前 cfC.js / cfNet.js 共用 %TEMP%\play-cf-probe-c，那个目录里存着 masked-UA 时代拿到的
// cf_clearance —— cf_clearance 与 UA 绑定，UA 换了以后它就是自相矛盾的证据，
// 会让 CF 直接升级成点了也不放行。所以"诚实身份在 TUN 上过不了"这个结论当时并不干净。
// 这里每次跑都新建空 profile，其余（不覆写 UA / 不绑代理 / 同 solver）与生产一致。
const { app, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { channelListUrl, isCloudflareChallengePage, isCloudflareErrorPage, parseChannelList } = require('../electron/acgmhoService');
const { solveChallengeWithBrowser } = require('../electron/challengeSolver');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'play-cf-clean-'));
app.setPath('userData', PROFILE);
if (process.env.PLAY_HOSTMAP !== '0') {
    app.commandLine.appendSwitch('host-resolver-rules', 'MAP brunhild.challenges.cloudflare.com 104.18.95.41');
}
app.on('window-all-closed', () => { });

const OUT = path.join(__dirname, 'cfClean.txt');
fs.writeFileSync(OUT, '');
const t0 = Date.now();
const log = (m) => fs.appendFileSync(OUT, `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const QUERY = '变态老爷爷的忏悔室日记';

async function main() {
    await app.whenReady();
    const ses = session.defaultSession;
    log('profile = ' + PROFILE);
    log('session UA = ' + ses.getUserAgent());

    const cookies0 = await ses.cookies.get({});
    log('起始 cookie 条数 = ' + cookies0.length
        + ' | cf_clearance = ' + (cookies0.filter((c) => /cf_clearance/i.test(c.name)).length));

    const PROXY = process.env.PLAY_PROXY || '';
    if (PROXY) {
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: PROXY, proxyBypassRules: 'localhost;127.0.0.1;[::1]' });
        log('proxy = ' + PROXY);
    } else {
        log('proxy = 跟随系统（不设 fixed_servers）');
    }

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
    let solveError = '';
    try {
        const out = await solveChallengeWithBrowser({
            url,
            isChallengePage: isCloudflareChallengePage,
            isErrorPage: isCloudflareErrorPage,
            deadlineMs: Number(process.env.PLAY_DEADLINE || 90000),
            log,
        });
        html = out.html;
        log('finalUrl = ' + out.finalUrl);
    } catch (e) {
        solveError = String((e && e.message) || e);
        log('solver threw: ' + solveError);
    }
    const cost = ((Date.now() - started) / 1000).toFixed(1);
    const cookies1 = await ses.cookies.get({});
    log('结束 cookie 条数 = ' + cookies1.length + ' | cf_clearance = '
        + cookies1.filter((c) => /cf_clearance/i.test(c.name)).map((c) => c.name + '@' + c.domain).join(','));
    const items = html ? parseChannelList(html) : [];
    log('html bytes = ' + html.length + ' | parsed items = ' + (Array.isArray(items) ? items.length : -1));
    fs.appendFileSync(OUT, '\nRESULT ' + JSON.stringify({
        pass: !solveError && !!html && !isCloudflareChallengePage(html) && html.length > 500,
        costSec: Number(cost),
        itemCount: Array.isArray(items) ? items.length : -1,
        error: solveError,
    }) + '\n');
    app.exit(solveError ? 1 : 0);
}
main();
