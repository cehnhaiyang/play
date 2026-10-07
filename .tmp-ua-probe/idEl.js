// 在 Electron 里读渲染层身份表面，页面必须是 https（UA-CH 的 JS API 只在安全上下文暴露）。
// 目的：确认 navigator.userAgentData / window.chrome 在 Electron 到底是"没有"还是"上次 data: 页测不出来"。
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const TMP = path.join(app.getPath('temp'), 'play-id-el-probe');
try { fs.mkdirSync(TMP, { recursive: true }); } catch (_e) { /* ignore */ }
app.setPath('userData', path.join(TMP, 'profile'));

const OUT = path.join(__dirname, 'idEl.txt');
fs.writeFileSync(OUT, '');
let T0 = Date.now();
const say = (s) => fs.appendFileSync(OUT, `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}\n`);

const READ = `({
    ua: navigator.userAgent,
    uaDataType: typeof navigator.userAgentData,
    brands: navigator.userAgentData ? JSON.stringify(navigator.userAgentData.brands) : null,
    platform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    chromeExists: !!window.chrome,
    chromeKeys: window.chrome ? Object.keys(window.chrome).sort().join(',') : null,
    loadTimes: typeof (window.chrome && window.chrome.loadTimes),
    csi: typeof (window.chrome && window.chrome.csi),
    appType: typeof (window.chrome && window.chrome.app && window.chrome.app.isInstalled),
    plugins: navigator.plugins.length,
    webdriver: String(navigator.webdriver),
    languages: navigator.languages.join(','),
    hw: navigator.hardwareConcurrency,
    mem: navigator.deviceMemory,
    pdf: navigator.pdfViewerEnabled,
    secure: window.isSecureContext,
    dns: location.protocol,
})`;

(async () => {
    await app.whenReady();
    say('session UA = ' + session.defaultSession.getUserAgent());
    const win = new BrowserWindow({ width: 800, height: 600, show: false });
    try {
        await win.loadURL('https://example.com/');
        const r = await win.webContents.executeJavaScript(READ);
        say('https 页 = ' + JSON.stringify(r, null, 1));
        const hv = await win.webContents.executeJavaScript(
            'navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(["fullVersionList","platformVersion","architecture","bitness","model"]) : null');
        say('highEntropy = ' + JSON.stringify(hv));
    } catch (e) {
        say('threw: ' + (e && e.message));
    } finally {
        if (!win.isDestroyed()) win.close();
        app.quit();
    }
})();
