// 探针 v2：验证
//  1) session.setUserAgent 的生效时序（建窗前 vs 建窗后）
//  2) 覆写 UA 后 Chromium 是否按覆写值重算 sec-ch-ua / navigator.userAgentData
//  3) 清洗后的 UA（去 app/Electron token、掩四位版本）出站效果
const { app, session, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'play-ua-probe-profile2'));
app.commandLine.appendSwitch('disable-gpu');

const LOG = path.join(__dirname, 'result2.txt');
fs.writeFileSync(LOG, '');
const dump = (label, v) => {
    const text = `\n### ${label}\n${v}`;
    console.log(text);
    fs.appendFileSync(LOG, text);
};

const IDENTITY_JS = `(() => {
    const ud = navigator.userAgentData || null;
    return JSON.stringify({ nav: navigator.userAgent, brands: ud && ud.brands });
})()`;

const ses = session.defaultSession;
ses.webRequest.onBeforeSendHeaders({ urls: ['https://example.com/*'] }, (details, cb) => {
    const h = details.requestHeaders;
    const keys = Object.keys(h).filter((k) => /^(user-agent|sec-ch-ua|sec-ch-ua-mobile|sec-ch-ua-platform)$/i.test(k));
    dump('  outbound', keys.sort().map((k) => `${k}: ${h[k]}`).join('\n'));
    cb({ requestHeaders: h });
});

async function load(label, opts) {
    dump(label, '');
    const win = new BrowserWindow({ show: false, ...opts });
    await win.loadURL('https://example.com/');
    dump('  page', await win.webContents.executeJavaScript(IDENTITY_JS));
    const hi = await win.webContents.executeJavaScript(`(() => {
        const ud = navigator.userAgentData;
        return ud ? ud.getHighEntropyValues(['fullVersionList', 'platformVersion']) : null;
    })().then(v => JSON.stringify(v))`);
    dump('  highEntropy', hi);
    win.destroy();
}

async function main() {
    await app.whenReady();
    dump('default UA', ses.getUserAgent());

    const clean = ses.getUserAgent()
        .replace(/\s*[\w][\w .()-]*\/[\d.]+(?= Chrome\/)/, '')   // 去 app 名 token
        .replace(/\s*Electron\/[\d.]+/, '')                        // 去 Electron token
        .replace(/Chrome\/(\d+)\.[\d.]+/, 'Chrome/$1.0.0.0');      // 掩四位版本
    dump('derived clean UA', clean);

    await load('A. baseline (no override)');

    ses.setUserAgent(clean);
    dump('after setUserAgent, ses.getUserAgent()', ses.getUserAgent());
    await load('B. window created AFTER override (clean 152 UA)');

    const w2 = new BrowserWindow({ show: false });
    w2.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await w2.loadURL('https://example.com/');
    dump('C. webContents UA overridden to 122 — outbound header', '');
    dump('  page', await w2.webContents.executeJavaScript(IDENTITY_JS));
    dump('  highEntropy', await w2.webContents.executeJavaScript(`navigator.userAgentData.getHighEntropyValues(['fullVersionList','platformVersion']).then(v => JSON.stringify(v))`));
    await w2.webContents.executeJavaScript(`fetch('/favicon.ico?probe=1').then(r => r.status)`);
    w2.destroy();

    app.exit(0);
}

main().catch((e) => {
    dump('probe failed', (e && e.stack) || String(e));
    app.exit(1);
});
