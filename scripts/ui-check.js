/**
 * 播放器 UI 回归检查（开发期辅助，不参与打包）。
 *
 * 为什么需要它：`tsc` 与单测都覆盖不到「控件被挤出版口」「提示层不消失」这类
 * 纯布局/交互问题——本轮改造中它俩分别抓到一个真实缺陷（窄窗口下中栏被左右
 * 两栏盖住、拖拽提示层在 dragleave 后不消失），而这两处编译与测试全绿。
 *
 * 覆盖三件事：
 *   1. 截图各状态，供肉眼复核美术与排版；
 *   2. 断言底栏在四种宽度下不重叠、播放键居中、无横向溢出；
 *   3. 断言拖拽导入的完整生命周期（进入→提示层出现；离开→消失；放下→入列）。
 *
 * 用法：
 *   npm run dev                # 另开一个终端
 *   npx electron scripts/ui-check.js
 *
 * 截图输出到 scripts/shots/。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 目标地址默认取 5174，**不是** dev 用的 5173。
 *
 * 原因：开发时经常有 `npm run electron:dev` 挂在 5173 上（vite 配了
 * strictPort，端口被占就直接启动失败）。如果本脚本也抢 5173，
 * 两个场景会互相打架 —— 要么回归跑不起来，要么把开发者正在看的
 * dev server 顶掉。用独立端口后两者可以同时存在。
 * 需要指到别处时用 SHOT_URL 覆盖。
 */
const TARGET = process.env.SHOT_URL || 'http://localhost:5174';
const OUT = path.join(__dirname, 'shots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 用一次性临时 userData，绝不碰真实应用配置。
 *
 * 两个原因，都是实测踩出来的：
 *  1. 默认 profile 里存着**按 origin 持久化的缩放系数**。这个脚本会改视口宽度，
 *     一旦跑在默认 profile 上，缩放会被写进 localStorage 并长期生效 ——
 *     下次打开应用界面就是放大的，且看不出是谁改的。
 *  2. 反过来，残留的缩放也会污染本脚本：实测默认 profile 里躺着 2.08 的缩放，
 *     窗口 1184px 的视口只剩 568px，所有宽度断言都在错误的基准上跑。
 * 每次运行都从干净 profile 起步，结果才可复现。
 */
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'theplay-uicheck-')));

let failures = 0;
/** 进程退出码。见文件末尾 app.exit(exitCode) 处关于 app.quit() 丢弃 exitCode 的说明 */
let exitCode = 0;
const check = (name, ok, detail = '') => {
    if (ok) {
        console.log(`  ✓ ${name}`);
    } else {
        failures += 1;
        console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    }
};

const shot = async (win, name) => {
    // 首次 capturePage 必定抛 UnknownVizError，重试即成功。
    //
    // 这是实测结论，不是猜测：干净 profile 下连续调用 6 次，第 1 次失败、
    // 第 2~6 次全部成功（合成器/抓取管线要等第一帧真正提交后才可用）。
    // 因此这里必须重试 —— 单次调用会让脚本在第一次截图就 fatal 退出，
    // 后面所有布局断言一条都跑不到（此前正是如此：只打印了 [1] 各状态截图 就崩）。
    // 传显式矩形是顺带的好习惯（无参在部分版本同样走不通），但**不是**根因。
    const { width, height } = win.getContentBounds();
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            const img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
            if (!img.isEmpty()) {
                fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
                console.log(`  [shot] ${name}`);
                return;
            }
            lastError = new Error('截图内容为空');
        } catch (e) {
            lastError = e;
        }
        await wait(300);
    }
    throw new Error(`截图 ${name} 失败（已重试 5 次）：${lastError && lastError.message}`);
};

const clickText = (text) => `
(() => {
  const b = [...document.querySelectorAll('button')].find(
    (x) => (x.textContent || '').trim().includes(${JSON.stringify(text)})
  );
  if (!b) return 'not-found';
  b.click();
  return 'clicked';
})()
`;

const esc = `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true })); return 'esc'; })()`;

/** 造 6 张合成图 + 1 段 WAV，经隐藏 input 走真实导入链路 */
const INJECT = `
(async () => {
  const mk = (i) => new Promise((res) => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 800;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 1200, 800);
    grad.addColorStop(0, 'hsl(' + (200 + i * 20) + ' 70% 45%)');
    grad.addColorStop(1, '#0b1120');
    g.fillStyle = grad; g.fillRect(0, 0, 1200, 800);
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.font = 'bold 96px sans-serif'; g.fillText('PAGE ' + i, 90, 420);
    g.font = '32px monospace'; g.fillText('synthetic fixture', 92, 480);
    c.toBlob((b) => res(new File([b], 'page' + String(i).padStart(3, '0') + '.png', { type: 'image/png' })), 'image/png');
  });
  const wav = () => {
    const rate = 8000, n = rate * 3, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    const s = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
    s(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true); s(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.sin(i / rate * 440 * 2 * Math.PI) * 8000, true);
    return new File([buf], 'ambient-track.wav', { type: 'audio/wav' });
  };
  const files = [];
  for (let i = 1; i <= 6; i++) files.push(await mk(i));
  files.push(wav());
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  const input = document.querySelector('input[type=file][multiple]:not([webkitdirectory])');
  if (!input) return 'no-file-input';
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'injected:' + files.length;
})()
`;

/** 底栏几何：中栏必须真正居中，且三栏互不重叠、无横向溢出 */
const MEASURE = `
(() => {
  const bar = [...document.querySelectorAll('div')].find(
    (d) => typeof d.className === 'string' && d.className.includes('grid-cols-[1fr_auto_1fr]')
  );
  if (!bar) return { error: 'control bar not found' };
  const cols = [...bar.children];
  const r = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), cx: Math.round(b.left + b.width / 2) }; };
  const play = [...bar.querySelectorAll('button')].find(
    (b) => ['播放', '暂停'].includes(b.getAttribute('aria-label') || '')
  );
  const barRect = r(bar), left = r(cols[0]), mid = r(cols[1]), right = r(cols[2]);
  return {
    viewportW: window.innerWidth,
    containerW: barRect.w,
    playOffset: play ? Math.round(r(play).cx - barRect.cx) : null,
    midOverlapsLeft: mid.l < left.r,
    midOverlapsRight: mid.r > right.l,
    leftRightOverlap: left.r > right.l,
    overflowPx: document.documentElement.scrollWidth - window.innerWidth,
  };
})()
`;

/** 拖拽生命周期探针 */
const DRAG_ENTER = `
(async () => {
  const c = document.createElement('canvas'); c.width = 400; c.height = 300;
  const g = c.getContext('2d'); g.fillStyle = '#3b82f6'; g.fillRect(0, 0, 400, 300);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'dropped-A.png', { type: 'image/png' }));
  dt.items.add(new File([blob], 'dropped-B.png', { type: 'image/png' }));
  window.__dt = dt;
  const t = document.querySelector('.tp-player-main');
  t.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 350));
  return {
    overlayShown: document.body.innerText.includes('松开即可导入'),
    types: [...dt.types],
  };
})()
`;

const DRAG_LEAVE = `
(async () => {
  const t = document.querySelector('.tp-player-main');
  t.dispatchEvent(new DragEvent('dragleave', { dataTransfer: window.__dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 350));
  return { overlayShown: document.body.innerText.includes('松开即可导入') };
})()
`;

const DRAG_DROP = `
(async () => {
  const t = document.querySelector('.tp-player-main');
  t.dispatchEvent(new DragEvent('dragover', { dataTransfer: window.__dt, bubbles: true, cancelable: true }));
  t.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 1800));
  return {
    overlayShown: document.body.innerText.includes('松开即可导入'),
    imported: document.body.innerText.includes('dropped-A'),
  };
})()
`;

app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const win = new BrowserWindow({ width: 1500, height: 940, show: true, backgroundColor: '#020617' });
    const js = (code) => win.webContents.executeJavaScript(code);

    try {
        await win.loadURL(TARGET);
        await wait(2500);

        console.log('\n[1] 各状态截图');
        await shot(win, '01-browse');
        await js(clickText('播放器'));
        await wait(1200);
        await shot(win, '02-player-empty');

        await js(INJECT);
        await wait(2500);
        await shot(win, '03-player-image');

        // 选中音频条目
        await js(`
          (() => {
            const rows = [...document.querySelectorAll('div')].filter(
              (d) => (d.textContent || '').includes('ambient-track.wav') && d.className.includes('cursor-pointer')
            );
            if (rows.length) { rows[rows.length - 1].click(); return 'ok'; }
            return 'no-row';
          })()
        `);
        await wait(1500);
        await shot(win, '04-player-audio');

        await js(`
          (() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Slash', key: '?', shiftKey: true, bubbles: true })); return 'sent'; })()
        `);
        await wait(900);
        await shot(win, '05-shortcuts');
        await js(esc);
        await wait(600);

        await js(clickText('链接'));
        await wait(900);
        await shot(win, '06-url-modal');
        await js(esc);
        await wait(600);

        await js(clickText('AI 绘本'));
        await wait(1200);
        await shot(win, '07-story-generator');
        await js(clickText('返回媒体'));
        await wait(700);

        console.log('\n[2] 拖拽提示层与导入');
        const enter = await js(DRAG_ENTER);
        await shot(win, '08-drag-overlay');
        check('dragenter 显示提示层', enter.overlayShown === true, JSON.stringify(enter));
        check('dragenter 识别 Files 类型', (enter.types || []).includes('Files'));

        const leave = await js(DRAG_LEAVE);
        check('dragleave 收起提示层', leave.overlayShown === false, JSON.stringify(leave));

        const drop = await js(DRAG_DROP);
        check('drop 后提示层收起', drop.overlayShown === false);
        check('drop 的文件已入列', drop.imported === true);
        await shot(win, '09-dropped');

        console.log('\n[3] 底栏响应式布局');
        // 侧栏占 320px，底栏容器宽度 = 视口 − 320，故断点按容器而非视口。
        //
        // 不能用 setContentSize 制造窄视口：窗口宽度受**物理屏幕**上限约束，
        // 在 1366×768 的屏上请求 1500/1100/880/720 会被依次夹到
        // 1350/1100/880/720 之外的同一档，且 880 以下连窗口带内容一起缩，
        // 620/500/470 三档容器查询根本不会被触发 —— 四个"不同宽度"实测
        // 得到同一个容器宽度，这组断言等于空转。
        // 改用 CDP 设备仿真直接改 CSS 视口，与物理屏幕尺寸完全解耦。
        for (const [w, h, name] of [[1500, 940, 'wide'], [1100, 800, 'mid'], [880, 700, 'narrow'], [720, 620, 'tiny']]) {
            win.webContents.enableDeviceEmulation({
                screenPosition: 'desktop',
                screenSize: { width: w, height: h },
                viewSize: { width: w, height: h },
                viewPosition: { x: 0, y: 0 },
                deviceScaleFactor: 1,
                scale: 1,
            });
            await wait(900);
            const m = await js(MEASURE);
            if (m.error) {
                check(`${name} 找到底栏`, false, m.error);
                continue;
            }
            // 视口真的被压到目标宽度了吗：没有这一条，断点是否触发无从判断，
            // 下面的"未遮挡"就会在同一个宽度上重复四次而全部为真。
            const viewportOk = Math.abs(m.viewportW - w) <= 2;
            check(`${name} 视口压到 ${w}px`, viewportOk, `实际 viewportW=${m.viewportW}`);
            check(`${name}(${m.containerW}px) 播放键居中`, Math.abs(m.playOffset) <= 1, `offset=${m.playOffset}`);
            check(`${name}(${m.containerW}px) 中栏未被左栏遮挡`, m.midOverlapsLeft === false);
            check(`${name}(${m.containerW}px) 中栏未被右栏遮挡`, m.midOverlapsRight === false);
            check(`${name}(${m.containerW}px) 左右栏互不重叠`, m.leftRightOverlap === false);
            check(`${name}(${m.containerW}px) 无横向溢出`, m.overflowPx === 0, `overflow=${m.overflowPx}px`);
            await shot(win, `resp-${name}`);
        }
        win.webContents.disableDeviceEmulation();

        console.log(`\n${failures === 0 ? '全部通过。' : `失败 ${failures} 项。`}`);
        if (failures > 0) exitCode = 1;
    } catch (err) {
        console.error('[fatal]', err);
        exitCode = 1;
    } finally {
        await wait(200);
        // 必须用 app.exit(code) 而不是 `process.exitCode = 1; app.quit()`。
        //
        // 实测：Electron 的 app.quit() 会丢弃 process.exitCode —— 脚本明明打印了
        // "失败 N 项"，进程却仍然以 0 退出，CI 把回归当成通过（此前正是如此）。
        // app.exit(code) 是唯一能把失败状态带出进程的方式。
        app.exit(exitCode);
    }
});
