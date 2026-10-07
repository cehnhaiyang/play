// 一次性探针：打印 Electron 默认 UA、真实出站请求头、页面侧 userAgentData。
// 独立 userData 目录，不加载项目应用，不碰正在运行的实例。
const { app, session, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'play-ua-probe-profile'));
app.commandLine.appendSwitch('disable-gpu');

const LOG = path.join(__dirname, 'result.txt');
fs.writeFileSync(LOG, '');
const dump = (label, v) => {
    const text = `\n### ${label}\n${v}`;
    console.log(text);
    fs.appendFileSync(LOG, text);
};

const IDENTITY_JS = `(() => {
    const ud = navigator.userAgentData || null;
    return JSON.stringify({
        navigatorUserAgent: navigator.userAgent,
        userAgentData: ud && { brands: ud.brands, platform: ud.platform, mobile: ud.mobile },
    }, null, 2);
})()`;

async function main() {
    await app.whenReady();

    dump('process.versions', JSON.stringify({
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
    }));

    dump('defaultSession.getUserAgent()', session.defaultSession.getUserAgent());

    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://example.com/*'] }, (details, cb) => {
        const h = details.requestHeaders;
        const pick = {};
        for (const k of Object.keys(h)) {
            if (/^(user-agent|sec-ch-ua|sec-ch-ua-mobile|sec-ch-ua-platform|critical-ch|accept-language|sec-fetch-mode|sec-fetch-site|sec-fetch-dest|priority)$/i.test(k)) {
                pick[k] = h[k];
            }
        }
        dump('OUTBOUND headers', JSON.stringify(pick, null, 2));
        cb({ requestHeaders: h });
    });

    const win = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, backgroundThrottling: false },
    });
    await win.loadURL('https://example.com/');
    dump('PAGE-SIDE identity', await win.webContents.executeJavaScript(IDENTITY_JS));

    // 覆写场景：把 UA 设成与内核不同的 major，看 Chromium 是否重算 Client Hints
    session.defaultSession.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    dump('after override, session UA', session.defaultSession.getUserAgent());
    await win.loadURL('https://example.com/?v=2');
    dump('PAGE-SIDE identity (UA overridden to 122)', await win.webContents.executeJavaScript(IDENTITY_JS));

    win.destroy();
    app.exit(0);
}

main().catch((e) => {
    dump('probe failed', (e && e.stack) || String(e));
    app.exit(1);
});
