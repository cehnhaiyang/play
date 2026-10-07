// 探针 B：修复后的 the-play 身份，打到同一个抓取服务，与真机 Chromium 基线对照
const { app, session, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { applyKernelUserAgent } = require('../electron/userAgent');

app.setPath('userData', path.join(os.tmpdir(), 'play-identity-probe-b'));
app.on('window-all-closed', () => { });

const OUT = path.join(__dirname, 'identityB.txt');
const dump = (label, v) => fs.appendFileSync(OUT, `\n### ${label}\n${v}\n`);
fs.writeFileSync(OUT, '');

const BASE = 'http://127.0.0.1:8791/';

async function main() {
    await app.whenReady();
    applyKernelUserAgent(session.defaultSession);

    const win = new BrowserWindow({ show: false, webPreferences: { webviewTag: true } });
    await win.loadURL(BASE + '?client=play-doc');
    await win.webContents.executeJavaScript(`fetch('/xhr?client=play-xhr').then(r=>r.status)`);
    await win.webContents.executeJavaScript(`fetch('/post?client=play-post',{method:'POST',body:'x'}).then(r=>r.status)`);

    // webview guest（不带 useragent 属性）：登录表单实际就是走这里
    await win.webContents.executeJavaScript(`(() => {
        const w = document.createElement('webview');
        w.style.cssText = 'display:inline-block;width:400px;height:300px';
        w.src = '${BASE}?client=play-guest';
        document.body.appendChild(w);
        w.addEventListener('dom-ready', () => {
            try { w.contentWindow.fetch('/guestxhr?client=play-guest-xhr').catch(()=>0); } catch (e) {}
        });
        return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1500));

    dump('host page identity', await win.webContents.executeJavaScript(
        `(() => { const ud=navigator.userAgentData; return JSON.stringify({ua:navigator.userAgent, brands: ud&&ud.brands}); })()`));
    dump('guest identity', await win.webContents.executeJavaScript(
        `(() => { const w=document.querySelector('webview'); try { const cw=w.contentWindow; return JSON.stringify({ua:cw.navigator.userAgent, brands: cw.navigator.userAgentData && cw.navigator.userAgentData.brands}); } catch(e) { return 'ERR '+e.message; } })()`));
    win.destroy();
    app.exit(0);
}

main().catch((e) => {
    dump('probe failed', (e && e.stack) || String(e));
    app.exit(1);
});
