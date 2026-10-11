'use strict';

/**
 * 验证球窗口的三条硬承诺。
 *
 * ## 为什么这三条必须实测
 *
 * 它们都是**窗口管理器的事实**，DOM 里看不出来，渲染层也读不到：
 *
 *   1. **无边框**：`frame:false` 没生效时窗口会多一条标题栏，而球是
 *      64×64 的圆 —— 标题栏会把它挤变形。DOM 上一切正常，只有量
 *      `outerHeight - innerHeight` 才看得出来。
 *   2. **不可缩放**：用户把球拉成长方形之后，里面的圆不是被裁就是留白。
 *      `resizable:false` 是否真的生效只能问 `isResizable()`。
 *   3. **置顶**：`setAlwaysOnTop` 的返回值只说明"调用没报错"，
 *      不说明系统真的把它置于顶层。只能问 `isAlwaysOnTop()`。
 *
 * 跑法：npx electron . --remote-debugging-port=9222
 *       node test/e2e/verify-orb-window.js
 */

const { Session, getJson, sleep } = require('./cdp');

const ELECTRON_PORT = Number(process.env.ELECTRON_DEBUG_PORT || 9222);

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

    const orbs = list.filter((t) => t.url.includes('/orb/'));
    if (orbs.length !== 2) {
        console.log(`期望 2 个球窗口，实际 ${orbs.length} 个 —— 两个球必须各自独立`);
        process.exitCode = 1;
        return;
    }
    console.log(`找到 ${orbs.length} 个球窗口\n`);

    let failures = 0;
    const check = (label, ok, detail) => {
        console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? `  （${detail}）` : ''}`);
        if (!ok) failures += 1;
    };

    /** 两个球折叠态的中心，用来判断它们有没有重叠 */
    const centers = [];

    for (const t of orbs) {
        const page = await Session.connect(t.webSocketDebuggerUrl);
        await page.send('Runtime.enable');
        await sleep(500);

        /* ---- 窗口管理器的状态 ---- */
        const info = await page.evaluate('window.orbApi.windowInfo()');

        /* ---- 渲染层看到的边框开销 ---- */
        const dom = await page.evaluate(`({
            outerWidth: window.outerWidth,
            outerHeight: window.outerHeight,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            screenX: window.screenX,
            screenY: window.screenY,
        })`);

        const borderW = dom.outerWidth - dom.innerWidth;
        const borderH = dom.outerHeight - dom.innerHeight;

        console.log(`=== ${t.title} ===`);
        console.log(`  窗口位置   ${info?.bounds?.x},${info?.bounds?.y}   尺寸 ${info?.bounds?.width}x${info?.bounds?.height}`);

        check('无边框（frame:false 生效）', borderW === 0 && borderH === 0,
            `边框开销 宽 ${borderW} 高 ${borderH}`);
        check('不可缩放（resizable:false 生效）', info?.isResizable === false,
            `isResizable=${info?.isResizable}`);
        check('置顶（alwaysOnTop 生效）', info?.isAlwaysOnTop === true,
            `isAlwaysOnTop=${info?.isAlwaysOnTop}`);
        check('折叠态尺寸是 64x64', info?.bounds?.width === 64 && info?.bounds?.height === 64,
            `${info?.bounds?.width}x${info?.bounds?.height}`);
        check('窗口可见', info?.isVisible === true, `isVisible=${info?.isVisible}`);

        /*
         * 展开之后**仍然**置顶。
         *
         * 这一条单独存在，是因为"折叠态置顶"曾经是真的、"展开态置顶"是假的：
         * setOpen 里写着 `setAlwaysOnTop(!open)`，展开时主动把置顶取消了。
         * 只测折叠态的检查永远发现不了它 —— 而用户看到的就是"球不在最上层"。
         */
        await page.evaluate('window.orbApi.setOpen(true)');
        await sleep(600);
        const opened = await page.evaluate('window.orbApi.windowInfo()');
        check('展开态仍然置顶', opened?.isAlwaysOnTop === true,
            `isAlwaysOnTop=${opened?.isAlwaysOnTop}`);
        check('展开态尺寸是面板尺寸', opened?.bounds?.width > 64 && opened?.bounds?.height > 64,
            `${opened?.bounds?.width}x${opened?.bounds?.height}`);

        await page.evaluate('window.orbApi.setOpen(false)');
        await sleep(600);
        const closed = await page.evaluate('window.orbApi.windowInfo()');
        check('收起后回到 64x64 且仍置顶',
            closed?.bounds?.width === 64 && closed?.bounds?.height === 64 && closed?.isAlwaysOnTop === true,
            `${closed?.bounds?.width}x${closed?.bounds?.height} topmost=${closed?.isAlwaysOnTop}`);

        centers.push({
            title: t.title,
            x: (info?.bounds?.x ?? 0) + (info?.bounds?.width ?? 0) / 2,
            y: (info?.bounds?.y ?? 0) + (info?.bounds?.height ?? 0) / 2,
        });

        console.log('');
        page.close();
    }

    /* ---- 两个球不能重叠 ---- */
    const [a, b] = centers;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    console.log('=== 两个球的位置关系 ===');
    console.log(`  ${a.title} 球心 ${Math.round(a.x)},${Math.round(a.y)}`);
    console.log(`  ${b.title} 球心 ${Math.round(b.x)},${Math.round(b.y)}`);
    console.log(`  距离 ${Math.round(distance)}px`);
    check('两个球不重叠', distance >= 64, `距离 ${Math.round(distance)}px，球直径 64px`);

    console.log(`\n${failures === 0 ? '全部通过。' : `${failures} 项失败。`}`);
    process.exitCode = failures === 0 ? 0 : 1;
};

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
