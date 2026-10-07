// 离线验证自动点击链路：本地 mock 出一个 CF managed 挑战页（闭式 shadow root + 子帧复选框），
// 跑真实的 solveChallengeWithBrowser，检查
//   1) interactive 判据能不能出现（旧逻辑只看顶层文案，永远不出现）
//   2) 激活坐标是否落在复选框上（点到才算过）
//   3) 信任输入点击之后挑战是否放行
const { app, BrowserWindow, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');

const TMP = path.join(app.getPath('temp'), 'play-cf-dom-probe');
try { fs.mkdirSync(TMP, { recursive: true }); } catch (_e) { /* ignore */ }
app.setPath('userData', path.join(TMP, 'profile'));

const OUT = path.join(__dirname, 'cfDom.txt');
fs.writeFileSync(OUT, '');
const say = (s) => fs.appendFileSync(OUT, `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}\n`);
let T0 = 0;

const HOST = 'challenges.cloudflare.com';
const TOP_URL = `cfmock://${HOST}/q/test.html`;

// 复选框在子帧视口里的位置（预期点击 = iframe 页面坐标 + 这组偏移 + 半边长）
const BOX = { x: 12, y: 16, w: 26, h: 26 };

const PASS_HTML = `<html><head><title>搜索结果</title></head><body><div id="listing">${
    '<a class="item">条目</a>'.repeat(400)}</div></body></html>`;

// SILENT=1：子帧里没有任何"点击验证"字样（模拟 CF 换 UI / 帧读不到），
// 只能靠"挑战页静置超时后主动点一次"这条兜底路走通
const SILENT = process.env.PLAY_SILENT === '1';
const ANCHOR_TEXT = SILENT ? '正在完成安全检查…' : '请验证您是真人';

const ANCHOR_HTML = `<html><head><meta charset="utf-8"><style>
  body{margin:0;font:13px sans-serif} #cb{position:absolute;left:${BOX.x}px;top:${BOX.y}px;width:${BOX.w}px;height:${BOX.h}px}
</style></head><body>
<div id="challenge-stage">
  <input id="cb" type="checkbox" aria-label="${ANCHOR_TEXT}">
  <span id="lbl">${ANCHOR_TEXT}</span>
</div>
<script>
  // 只有真实（信任）输入才会派发到这里；JS 直点也到这里，但会带 nonTrusted 标记
  document.getElementById('cb').addEventListener('click', (ev) => {
    try {
      window.top.__clicked = { trusted: ev.isTrusted, at: Date.now() };
      window.top.document.documentElement.innerHTML = ${JSON.stringify(PASS_HTML.slice(6))};
    } catch (e) { window.top.__flipError = String(e); }
  });
</script>
</body></html>`;

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
  f.src = 'cfmock://${HOST}/cdn-cgi/anchor.html';
  f.style.cssText = 'width:300px;height:65px;border:0';
  root.appendChild(f);
  window.__measure = () => { const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
</script>
</body></html>`;

const isChallengePage = (h) => /_cf_chl_opt|challenges\.cloudflare\.com/i.test(h || '')
    && /请稍候|正在验证|安全验证|verify you are human/i.test(h || '');
const isErrorPage = () => false;

protocol.registerSchemesAsPrivileged([
    { scheme: 'cfmock', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(async () => {
    T0 = Date.now();
    protocol.handle('cfmock', (req) => {
        const u = new URL(req.url);
        const body = u.pathname.includes('anchor') ? ANCHOR_HTML : TOP_HTML;
        return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    });
    const { solveChallengeWithBrowser } = require('../electron/challengeSolver');
    const logs = [];
    const log = (m) => { logs.push(String(m)); say(m); };

    const t = await solveChallengeWithBrowser({
        url: TOP_URL, isChallengePage, isErrorPage, log,
        deadlineMs: 60000, silentStallMs: 6000, firstActivationDelayMs: 2000,
        activationCooldownMs: 2000, frameProbeEveryMs: 1200, pollMs: 400,
    }).catch((e) => ({ error: String(e && e.message || e) }));

    const clickLine = logs.find((l) => /mouse click at/.test(l));
    const got = clickLine && clickLine.match(/mouse click at \((-?\d+), (-?\d+)\)/);
    say(`RESULT pass=${!!(t && t.html && !t.error)} htmlLen=${t && t.html ? t.html.length : 0} error=${t && t.error}`);
    say(`RESULT click=${got ? `(${got[1]},${got[2]})` : 'none'}`);
    app.exit(0);
});

app.on('window-all-closed', () => { /* 探针期间不许退出进程，否则拿不到结果 */ });
