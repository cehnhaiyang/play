// 真实版式的离线验证：顶层页面在 site.test，组件在**跨域**的 challenges.cloudflare.com
// 子帧里，且被塞进**闭式 shadow root**——这三点同时成立才是 CF managed 挑战的实际形态。
// 验证三件事：
//   1) 子帧探测只取子帧的复选框 rect（不能拿顶层的 #challenge-stage 容器）
//   2) CDP 盒模型 与 elementFromPoint 兜底盒 都能定位到组件
//   3) activateCheckbox 合成出的坐标真的能让复选框收到**信任**点击
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

const TMP = path.join(app.getPath('temp'), 'play-cf-dom-probe2');
try { fs.mkdirSync(TMP, { recursive: true }); } catch (_e) { /* ignore */ }
app.setPath('userData', path.join(TMP, 'profile'));

const OUT = path.join(__dirname, 'cfDom2.txt');
fs.writeFileSync(OUT, '');
let T0 = 0;
const say = (s) => fs.appendFileSync(OUT, `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}\n`);

const TOP_URL = 'cfmock://site.test/q/test.html';
const ANCHOR_URL = 'cfmock://challenges.cloudflare.com/cdn-cgi/anchor.html';
const BOX = { x: 12, y: 16, w: 26, h: 26 };

const ANCHOR_HTML = `<html><head><meta charset="utf-8"><style>
  body{margin:0;font:13px sans-serif} #cb{position:absolute;left:${BOX.x}px;top:${BOX.y}px;width:${BOX.w}px;height:${BOX.h}px}
</style></head><body>
<div id="challenge-stage">
  <input id="cb" type="checkbox" aria-label="请验证您是真人">
  <span id="lbl">请验证您是真人</span>
</div>
<script>window.__clicks = [];
  document.getElementById('cb').addEventListener('click', (ev) => {
    window.__clicks.push({ trusted: ev.isTrusted, detail: ev.detail });
  });
</script>
</body></html>`;

// 顶层刻意放了三个"陷阱"：整页覆盖的 .cf-wrapper、带 challenge 字样的文案段落、
// 以及包住组件的容器 div——盒模型兜底必须一个都不选中
const TOP_HTML = `<html><head><meta charset="utf-8"><title>请稍候…</title>
<style>body{margin:0;font:14px sans-serif} .cf-wrapper{position:absolute;inset:0}
#challenge-stage{position:absolute;left:60px;top:220px;width:400px}
#cf-turnstile-host{display:block;margin-top:80px}</style></head>
<body>
<div class="cf-wrapper"></div>
<div id="challenge-stage">
  <p id="challenge-running">正在验证您是否是真人，这可能需要几秒钟。</p>
  <p id="challenge-text">本网站使用安全服务防护恶意自动程序。</p>
  <div id="cf-turnstile-host"></div>
</div>
<script>window._cf_chl_opt = { k: 1 };</script>
<script>
  const host = document.getElementById('cf-turnstile-host');
  const root = host.attachShadow({ mode: 'closed' });
  const f = document.createElement('iframe');
  f.src = ${JSON.stringify(ANCHOR_URL)};
  f.style.cssText = 'width:300px;height:65px;border:0';
  root.appendChild(f);
  // 组件在页面里的真实位置，用来核对兜底盒模型
  window.__expect = new Promise((res) => {
    f.addEventListener('load', () => setTimeout(() => {
      const r = f.getBoundingClientRect();
      res({ left: r.left, top: r.top, width: r.width, height: r.height });
    }, 200));
  });
</script>
</body></html>`;

protocol.registerSchemesAsPrivileged([
    { scheme: 'cfmock', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(async () => {
    T0 = Date.now();
    protocol.handle('cfmock', (req) => {
        const u = new URL(req.url);
        const body = u.host === 'site.test' ? TOP_HTML : ANCHOR_HTML;
        return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    });
    const solver = require('../electron/challengeSolver');
    const { probeTurnstileFrame, findTurnstileFrameBox, findTurnstileHostBox, activateCheckbox } = solver;

    const win = new BrowserWindow({ width: 520, height: 600, show: false, webPreferences: { contextIsolation: true } });
    const wc = win.webContents;
    await win.loadURL(TOP_URL);
    // 真实链路的窗口是可见的（solveChallengeWithBrowser 会 showInactive）。
    // 隐藏窗口时跨进程子帧的命中测试数据不更新，输入会被整帧丢弃 —— 这里必须按同一形态验。
    win.showInactive();
    await new Promise((r) => setTimeout(r, 800));
    const expect = await wc.executeJavaScript('window.__expect');
    say(`组件真实位置 = ${JSON.stringify(expect)}`);
    await new Promise((r) => setTimeout(r, 600));

    const p = await probeTurnstileFrame(wc, { click: false, log: (m) => say(`probe: ${m}`) });
    say(`子帧 rect=${JSON.stringify(p && p.rect)} 文案="${p && p.text}"`);
    say(`CDP 盒=${JSON.stringify(await findTurnstileFrameBox(wc))}`);
    const hostBox = await findTurnstileHostBox(wc);
    say(`兜底盒=${JSON.stringify(hostBox)}`);

    const anchor = wc.mainFrame.framesInSubtree.find((f) => /challenges\.cloudflare\.com/.test(f.url || ''));
    say(`进程分布 main=${wc.mainFrame.processId} anchor=${anchor ? anchor.processId : '-'} 跨进程=${!!anchor && anchor.processId !== wc.mainFrame.processId}`);
    const readClicks = async () => (anchor
        ? await anchor.executeJavaScript('window.__clicks || []').catch((e) => `读取失败:${e.message}`)
        : 'no-anchor-frame');

    await activateCheckbox(wc, 1, (m) => say(`act: ${m}`));
    await new Promise((r) => setTimeout(r, 500));
    say(`AFTER_CDP ${JSON.stringify(await readClicks())}`);

    // 兜底路径单独验：坐标只来自 findTurnstileHostBox 的盒（CDP 盒模型不可用时的形态），
    // 输入通道与 clickByMouse 一致走 CDP Input，否则测的就不是同一条路
    const fb = hostBox ? { x: Math.round(hostBox.left + 24), y: Math.round(hostBox.top + hostBox.height / 2) } : null;
    if (fb) {
        say(`fallback point = ${JSON.stringify(fb)}`);
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        const dm = (t, extra) => wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: t, x: fb.x, y: fb.y, pointerType: 'mouse', pointerID: 1, ...extra,
        });
        await dm('mouseMoved', { buttons: 0 });
        await new Promise((r) => setTimeout(r, 60));
        await dm('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
        await new Promise((r) => setTimeout(r, 90));
        await dm('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
        await new Promise((r) => setTimeout(r, 400));
        try { wc.debugger.detach(); } catch (_e) { /* ignore */ }
        say(`AFTER_FALLBACK ${JSON.stringify(await readClicks())}`);
    }

    const want = expect && p && p.rect
        ? { x: expect.left + p.rect.x + p.rect.w / 2, y: expect.top + p.rect.y + p.rect.h / 2 } : null;
    say(`EXPECTED_POINT ${JSON.stringify(want)}`);
    app.exit(0);
});

app.on('window-all-closed', () => { /* 探针期间不退出 */ });
