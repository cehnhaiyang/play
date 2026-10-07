// 抓真 Chrome 在这个站点上**实际出站**的请求头（含 UA / sec-ch-ua 全套 / Accept-Language），
// 作为 Electron 侧对齐的目标值。用 CDP 的 requestWillBeSentExtraInfo（能看到浏览器真实发出的头）。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const TARGET = 'https://www.acgmho.com/q/%E5%8F%98%E6%80%81%E8%80%81%E7%88%B8%E7%88%B8%E7%9A%84%E5%BF%8F%E6%82%94%E5%AE%A4%E6%97%A5%E8%AE%B0-1.html';
const OUT = path.join(__dirname, 'chromeHeaders.txt');
fs.writeFileSync(OUT, '');
const T0 = Date.now();
const say = (s) => fs.appendFileSync(OUT, `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b)); }).on('error', rej));
const put = (p) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'PUT' }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b)); }); q.on('error', rej); q.end(); });

(async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'play-cf-hdr-'));
    const proc = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], { stdio: 'ignore' });
    let ws = null;
    try {
        let ver = null;
        for (let i = 0; i < 40 && !ver; i += 1) { await wait(300); try { ver = JSON.parse(await get('/json/version')); } catch (_e) { } }
        if (!ver) throw new Error('调试端口没起来');
        const tab = JSON.parse(await put('/json/new?about:blank'));
        ws = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 0;
        const pending = new Map();
        const send = (m, p) => new Promise((r) => { const k = ++id; pending.set(k, r); ws.send(JSON.stringify({ id: k, method: m, params: p || {} })); });
        const seen = new Map();
        ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
            if (m.method === 'Network.requestWillBeSentExtraInfo') {
                const h = m.params.headers;
                const u = m.params.requestId;
                if (!seen.has(u)) seen.set(u, h);
            }
        };
        await send('Network.enable');
        await send('Page.enable');
        await send('Page.navigate', { url: TARGET });
        await wait(25000);
        const rows = [...seen.entries()].slice(0, 6);
        for (const [rid, h] of rows) {
            say('--- 请求头 ---');
            for (const k of Object.keys(h).sort()) {
                if (/^(user-agent|accept-language|cookie)$/i.test(k)
                    || /^sec-ch-ua/i.test(k) || /^sec-fetch-/i.test(k)) {
                    say(`  ${k}: ${String(h[k]).slice(0, 160)}`);
                }
            }
            const ck = Object.keys(h).find((k) => /^cookie$/i.test(k));
            if (ck) say(`  cookie: ${String(h[ck]).slice(0, 300)}`);
        }
        say('请求组数 = ' + seen.size);
    } catch (e) {
        say('threw: ' + (e && e.message));
    } finally {
        try { if (ws) ws.close(); } catch (_e) { }
        try { proc.kill(); } catch (_e) { }
        await wait(600);
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) { }
    }
})();
