// 探针 v3：验证
//  1) webContents.setUserAgent 覆写后，出站 UA 头 / navigator.userAgent 是否同步
//  2) sec-ch-ua 与 navigator.userAgentData 是否按覆写值重算（决定"改 UA 会不会造成 CH 矛盾"）
//  3) 从 Electron 默认 UA 派生"真 Chrome 形状 UA"的清洗规则效果
const { app, session, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'play-ua-probe-profile3'));
app.commandLine.appendSwitch('disable-gpu');

const LOG = path.join(__dirname, 'result3.txt');
fs.writeFileSync(LOG, '');
const dump = (label, v) => fs.appendFileSync(LOG, `\n### ${label}\n${v}`);

const IDENTITY_JS = `(() => {
    const ud = navigator.userAgentData || null;
    return JSON.stringify({ navUA: navigator.userAgent, brands: ud && ud.brands }, null, 1);
})()`;

// Electron 默认 UA → 真 Chrome 形状：去 app token、去 Electron token、掩掉四位版本
function deriveChromeUa(defaultUa) {
    return String(defaultUa)
        .replace(/ (?:[A-Za-z][A-Za-z0-9 ._()-]*\/[0-9][0-9a-zA-Z.+-]*)+(?= Chrome\/)/, '')
        .replace(/ Electron\/[0-9][0-9a-zA-Z.+-]*/, '')
        .replace(/ Chrome\/(\d+)(?:\.[0-9a-zA-Z.+-]+)+/, ' Chrome/$1.0.0.0');
}

async function main() {
    await app.whenReady();
    const ses = session.defaultSession;

    dump('process.versions', JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome }));
    dump('default UA', ses.getUserAgent());
    dump('derived', deriveChromeUa(ses.getUserAgent()));

    ses.webRequest.onBeforeSendHeaders({ urls: ['https://example.com/*'] }, (details, cb) => {
        const h = details.requestHeaders;
        const keys = Object.keys(h).filter((k) => /^(user-agent|sec-ch-ua|sec-ch-ua-mobile|sec-ch-ua-platform|critical-ch)$/i.test(k)).sort();
        dump(`outbound [${new URL(details.url).pathname}]`, keys.length ? keys.map((k) => `${k}: ${h[k]}`).join('\n') : '(no UA/CH headers)');
        cb({ requestHeaders: h });
    });

    // A：默认（不覆写）
    const wA = new BrowserWindow({ show: false });
    await wA.loadURL('https://example.com/');
    dump('A page (default)', await wA.webContents.executeJavaScript(IDENTITY_JS));
    wA.destroy();

    // B：session 级覆写 + 新建窗口
    ses.setUserAgent(deriveChromeUa(ses.getUserAgent()));
    const wB = new BrowserWindow({ show: false });
    await wB.loadURL('https://example.com/?b');
    dump('B ses override, new window', await wB.webContents.executeJavaScript(IDENTITY_JS));
    wB.destroy();

    // C：已存在窗口上做 webContents 级覆写后再导航
    const wC = new BrowserWindow({ show: false });
    wC.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await wC.loadURL('https://example.com/?c');
    dump('C wc override to 122 (错报版本)', await wC.webContents.executeJavaScript(IDENTITY_JS));
    dump('C highEntropy', await wC.webContents.executeJavaScript(`navigator.userAgentData.getHighEntropyValues(['fullVersionList','platformVersion']).then(v=>JSON.stringify(v))`));
    wC.destroy();

    app.exit(0);
}

main().catch((e) => {
    dump('probe failed', (e && e.stack) || String(e));
    app.exit(1);
});
