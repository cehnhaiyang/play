// 探针 v4：覆写 UA 后，CH 头与 navigator.userAgentData 是否跟随重算
const { app, session, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'play-ua-probe-profile4'));
app.commandLine.appendSwitch('disable-gpu');

const LOG = path.join(__dirname, 'result4.txt');
fs.writeFileSync(LOG, '');
const dump = (label, v) => fs.appendFileSync(LOG, `\n### ${label}\n${v}`);

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

async function sample(ses, tag) {
    const win = new BrowserWindow({ show: false });
    await win.loadURL('https://example.com/');
    dump(`${tag} page identity`, await win.webContents.executeJavaScript(IDENTITY_JS));
    dump(`${tag} highEntropy`, await win.webContents.executeJavaScript(
        `navigator.userAgentData.getHighEntropyValues(['fullVersionList','platformVersion']).then(v=>JSON.stringify(v))`));
    await win.webContents.executeJavaScript(`fetch('/_chprobe?t=${Date.now()}').then(r=>r.status).catch(()=>0)`);
    win.destroy();
}

async function main() {
    await app.whenReady();
    const ses = session.defaultSession;

    ses.webRequest.onBeforeSendHeaders({ urls: ['https://example.com/*'] }, (details, cb) => {
        const h = details.requestHeaders;
        if (!/_chprobe/.test(details.url)) return cb({ requestHeaders: h });
        const keys = Object.keys(h).filter((k) => /^(user-agent|sec-ch-ua|sec-ch-ua-mobile|sec-ch-ua-platform|critical-ch)$/i.test(k)).sort();
        dump('probe request headers', keys.map((k) => `${k}: ${h[k]}`).join('\n'));
        cb({ requestHeaders: h });
    });

    await sample(ses, 'BASELINE(default Electron UA)');

    const clean = deriveChromeUa(ses.getUserAgent());
    ses.setUserAgent(clean);
    dump('setUserAgent ->', clean);
    await sample(ses, 'AFTER CLEAN OVERRIDE');

    app.exit(0);
}

main().catch((e) => {
    dump('probe failed', (e && e.stack) || String(e));
    app.exit(1);
});
