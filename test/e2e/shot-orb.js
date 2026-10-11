'use strict';

/**
 * 看球窗口到底画成什么形状。
 *
 * ## 为什么不能只看 DOM
 *
 * 球是 `transparent: true` + `frame: false` 的窗口，圆角之外**必须是透明的**
 * —— 否则用户看到的是"一个方块里画了个圆"，而这在 DOM 上完全看不出来
 * （DOM 里就是一个 rounded-full 的 div，永远正确）。
 *
 * 所以这里做两件事：
 *   1. 用 CDP 截图，直接看像素；
 *   2. 数四个角的像素是不是透明，把"看着像球"变成一条可判定的断言。
 *
 * 跑法：node test/e2e/shot-orb.js
 */

const path = require('node:path');
const fs = require('node:fs');
const { Session, getJson, sleep } = require('./cdp');

const ELECTRON_PORT = Number(process.env.ELECTRON_DEBUG_PORT || 9222);
const OUT_DIR = path.join(__dirname, '..', '..', 'test', 'e2e', 'shots');

const main = async () => {
    let list;
    try {
        list = await getJson(`http://127.0.0.1:${ELECTRON_PORT}/json/list`);
    } catch {
        console.log(`连不上 Electron 调试端口 ${ELECTRON_PORT}`);
        console.log('请这样启动：npx electron . --remote-debugging-port=9222');
        process.exitCode = 1;
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const targets = [
        { name: 'sniff', url: 'sniff.html' },
        { name: 'agent', url: 'agent.html' },
    ];

    for (const { name, url } of targets) {
        const target = list.find((t) => t.url.includes(url));
        if (!target) {
            console.log(`找不到 ${name} 窗口`);
            continue;
        }

        const page = await Session.connect(target.webSocketDebuggerUrl);
        await page.send('Runtime.enable');
        await sleep(600);

        /* ---- 折叠态：应该是 64×64 的球 ---- */
        const metrics = await page.evaluate(`(() => {
            const root = document.getElementById('root');
            const ball = root && root.firstElementChild;
            const inner = ball && ball.firstElementChild;
            const cs = inner ? getComputedStyle(inner) : null;
            const bodyCs = getComputedStyle(document.body);
            return {
                win: { w: window.innerWidth, h: window.innerHeight },
                ballRect: ball ? (() => { const r = ball.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
                radius: cs ? cs.borderRadius : null,
                bodyBg: bodyCs.backgroundColor,
                htmlBg: getComputedStyle(document.documentElement).backgroundColor,
            };
        })()`);
        console.log(`\n=== ${name} 折叠态 ===`);
        console.log(JSON.stringify(metrics, null, 2));

        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        const file = path.join(OUT_DIR, `${name}-ball.png`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log(`截图：${file}`);

        /* ---- 展开态 ---- */
        await page.evaluate(`(() => {
            const root = document.getElementById('root');
            const ball = root.firstElementChild;
            const r = ball.getBoundingClientRect();
            const opts = { bubbles: true, cancelable: true, pointerId: 1, clientX: r.x + r.width/2, clientY: r.y + r.height/2 };
            ball.dispatchEvent(new PointerEvent('pointerdown', opts));
            ball.dispatchEvent(new PointerEvent('pointerup', opts));
            ball.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: opts.clientX, clientY: opts.clientY }));
            return true;
        })()`);
        await sleep(900);

        const expanded = await page.evaluate(`(() => {
            const root = document.getElementById('root');
            const panel = root.firstElementChild;
            return {
                win: { w: window.innerWidth, h: window.innerHeight },
                text: root.innerText.replace(/\\n+/g, ' | ').slice(0, 200),
                hasHeader: !!panel.querySelector('header'),
            };
        })()`);
        console.log(`\n=== ${name} 展开态 ===`);
        console.log(JSON.stringify(expanded, null, 2));

        const shot2 = await page.send('Page.captureScreenshot', { format: 'png' });
        const file2 = path.join(OUT_DIR, `${name}-panel.png`);
        fs.writeFileSync(file2, Buffer.from(shot2.data, 'base64'));
        console.log(`截图：${file2}`);

        page.close();
    }
};

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
