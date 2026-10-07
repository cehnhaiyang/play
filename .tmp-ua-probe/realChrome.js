// 对照实验：同一网络出口下，**真 Chrome** 打开同一个 CF 保护页面能不能自动放行。
// 目的：把"出口的问题"和"Electron 给不出 attestation"这两个变量分开。
// 只读操作：独立临时 profile，不碰用户 Chrome 配置；结束即终止自己起的进程。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const TARGET = process.env.PLAY_URL
    || 'https://www.acgmho.com/q/%E5%8F%98%E6%80%81%E8%80%81%E7%88%B8%E7%88%B8%E7%9A%84%E5%BF%8F%E6%82%94%E5%AE%A4%E6%97%A5%E8%AE%B0-1.html';
const RUN_MS = Number(process.env.PLAY_RUN || 100000);

const OUT = path.join(__dirname, 'realChrome.txt');
fs.writeFileSync(OUT, '');
const T0 = Date.now();
const say = (s) => fs.appendFileSync(OUT, `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}\n`);

const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 4000 }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve(b));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
});
const put = (p) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'PUT', timeout: 6000 }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve(b));
    });
    req.on('error', reject);
    req.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'play-cf-chrome-'));
    const proc = spawn(CHROME, [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-sync',
        '--disable-background-networking', '--window-size=1280,860',
        'about:blank',
    ], { stdio: 'ignore' });
    let ws = null;
    try {
        let ver = null;
        for (let i = 0; i < 40 && !ver; i += 1) {
            await wait(300);
            try { ver = JSON.parse(await get('/json/version')); } catch (_e) { /* 还没起来 */ }
        }
        if (!ver) throw new Error('Chrome 调试端口没起来');
        say('browser = ' + ver.Browser);
        say('ua = ' + ver['User-Agent']);

        const tab = JSON.parse(await put('/json/new?about:blank'));
        ws = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

        let id = 0;
        const pending = new Map();
        const cf = [];
        const send = (method, params) => new Promise((res) => {
            const mid = ++id;
            pending.set(mid, res);
            ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
        ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
            if (m.method === 'Network.responseReceived') {
                const r = m.params.response;
                if (!/cloudflare/i.test(r.url) && m.params.type === 'Document') {
                    say(`顶层文档 ${r.status} :: ${r.url.slice(0, 90)}`);
                }
                if (/cloudflare\.com/i.test(r.url)) {
                    const key = r.url.replace(/\/[0-9a-f]{16,}.*$/, '/…');
                    const hit = cf.find((c) => c.key === key);
                    const pat = /\/pat\//.test(r.url);
                    const wa = Object.keys(r.headers).filter((h) => /private-state-token|www-authenticate/i.test(h));
                    if (hit) { hit.n += 1; hit.status += ',' + r.status; if (wa.length) hit.wa = wa.join('|'); } else {
                        cf.push({ key, status: String(r.status), n: 1, pat, wa: wa.join('|') });
                    }
                    if (pat) say(`pat ${r.status} :: ${r.url.slice(0, 120)} :: 头 ${wa.join(',') || '无'}`);
                }
            }
        };

        await send('Network.enable');
        await send('Page.enable');
        await send('Runtime.enable');
        say('url = ' + TARGET);
        await send('Page.navigate', { url: TARGET });

        const deadline = Date.now() + RUN_MS;
        let last = '';
        let passed = false;
        let clicks = 0;
        let nextClickAt = Date.now() + 9000;
        while (Date.now() < deadline) {
            await wait(4000);
            const st = await send('Runtime.evaluate', {
                expression: 'JSON.stringify({t:document.title,l:document.documentElement.innerHTML.length,u:location.href})',
                returnByValue: true,
            }).then((r) => {
                const v = r && r.result && r.result.value;
                return v ? JSON.parse(v) : null;
            }).catch(() => null);
            if (!st) { say('evaluate 无返回'); continue; }
            const line = `title=${st.t.slice(0, 40)} len=${st.l}`;
            if (line !== last) { say(line + '  url=' + st.u.slice(0, 60)); last = line; }
            if (st.l > 6000 && !/请稍候|Just a moment|checking/.test(st.t)) { passed = true; say('放行'); break; }

            // 与 app 里 solver 同一套策略：找 challenges.cloudflare.com 的 iframe 盒，
            // 复选框靠左、垂直居中，带接近轨迹后按下。这样两边都是"点了一次"，可比。
            if (Date.now() >= nextClickAt && clicks < 4) {
                nextClickAt = Date.now() + 12000;
                clicks += 1;
                const box = await send('Runtime.evaluate', {
                    expression: `(() => { const f = [...document.querySelectorAll('iframe')]
                        .find(x => /challenges\\.cloudflare\\.com/.test(x.src || ''));
                        if (!f) return null; const r = f.getBoundingClientRect();
                        return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height}); })()`,
                    returnByValue: true,
                }).then((r) => (r && r.result && r.result.value ? JSON.parse(r.result.value) : null))
                  .catch(() => null);
                if (!box) {
                    // 组件在闭式 shadow root 里，顶层 querySelectorAll('iframe') 看不到。
                    // 用截图量出的固定点位兜底（复选框中心 ≈ 238,315）
                    const fb = (process.env.PLAY_CLICK || '238,315').split(',').map(Number);
                    say(`点击 #${clicks}：顶层找不到 cf iframe → 用截图点位 (${fb[0]},${fb[1]})`);
                    for (let i = 0; i < 5; i += 1) {
                        await send('Input.dispatchMouseEvent', {
                            type: 'mouseMoved', x: fb[0] - 40 + i * 10, y: fb[1] - 20 + i * 5, pointerType: 'mouse', buttons: 0,
                        });
                        await wait(30);
                    }
                    await send('Input.dispatchMouseEvent', {
                        type: 'mousePressed', x: fb[0], y: fb[1], button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
                    });
                    await wait(90);
                    await send('Input.dispatchMouseEvent', {
                        type: 'mouseReleased', x: fb[0], y: fb[1], button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse',
                    });
                    continue;
                }
                const px = Math.round(box.x + 26), py = Math.round(box.y + box.h / 2);
                for (let i = 0; i < 5; i += 1) {
                    await send('Input.dispatchMouseEvent', {
                        type: 'mouseMoved', x: px - 40 + i * 10, y: py - 20 + i * 5, pointerType: 'mouse', buttons: 0,
                    });
                    await wait(30);
                }
                await send('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
                });
                await wait(90);
                await send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse',
                });
                say(`点击 #${clicks} @( ${px},${py}) 盒=${JSON.stringify(box)}`);
            }
        }

        const shot = await send('Page.captureScreenshot', { format: 'png' });
        if (shot && shot.data) {
            fs.writeFileSync(path.join(__dirname, 'realChrome.png'), Buffer.from(shot.data, 'base64'));
            say('截图已存 realChrome.png');
        }
        const patCount = cf.filter((c) => c.pat).length;
        const patRetried = cf.filter((c) => c.pat).some((c) => /200/.test(c.status));
        say('cloudflare 记录 = ' + JSON.stringify(cf, null, 1));
        say(`RESULT ${JSON.stringify({
            pass: passed, browser: ver.Browser, patRequests: patCount, patRetriedWithToken: patRetried,
            costSec: +((Date.now() - T0) / 1000).toFixed(1),
        })}`);
    } catch (e) {
        say('threw: ' + (e && e.message));
        say('RESULT ' + JSON.stringify({ pass: false, error: String(e && e.message) }));
    } finally {
        try { if (ws) ws.close(); } catch (_e) { /* ignore */ }
        try { proc.kill(); } catch (_e) { /* ignore */ }
        await wait(800);
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
})();
