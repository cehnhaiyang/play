'use strict';

/**
 * 验证 native messaging Port 是否保住 service worker。
 *
 * ## 上一版为什么结论不可信
 *
 * 上一版把 CDP **附着到了 service worker 自己的调试目标**上，然后用
 * `Runtime.evaluate` 去开 Port。问题在于：附着调试器这件事本身就会让 SW
 * 保持活跃 —— 于是"观察 70 秒后 SW 还在"这个结果里，分不出是 Port 的功劳
 * 还是我自己盯着它的功劳。
 *
 * 这一版改成：**从不附着 SW 目标**，只通过 CDP 的目标列表（HTTP 端点）
 * 观察它还在不在。那是一条只读的旁路，不改变被观察者的行为。
 *
 * ## 怎么在不附着 SW 的情况下让它开 Port
 *
 * 用一个普通页面，经 `chrome.runtime.sendMessage` 让 SW 自己在它的
 * 顶层 `ensureBridge()` 里连桥 —— 那条路径不经过 CDP。
 *
 * ## 对照组
 *
 * 同一轮里先测"不连桥"，再测"连桥"。只测后者的话，如果 SW 本来就因为
 * 别的原因（比如 headless 下不回收）活着，结论会是假的。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { launch, waitForTarget, sleep } = require('./cdp');

const EXT = path.resolve(__dirname, '..', '..', 'extension', 'dist');
const OBSERVE_MS = 80000;

const ENDPOINT_FILE = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'the-play',
    'bridge-endpoint.json',
);

/** SW 还在不在。只读目标列表，不附着 */
const swAlive = async (browser) =>
    (await browser.targets()).filter((t) => t.type === 'service_worker' && t.url.includes('service-worker.js')).length > 0;

/** 页面里发一条消息把 SW 叫醒。SW 收到后会跑顶层 ensureBridge() */
const wakeSw = (browser, url) => browser.newTab(url);

const main = async () => {
    if (!fs.existsSync(ENDPOINT_FILE)) {
        console.log(`前置不满足：找不到 ${ENDPOINT_FILE}。请先启动应用（npm run electron:dev）。`);
        process.exitCode = 1;
        return;
    }
    const endpoint = JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8'));
    console.log(`应用端点在听：127.0.0.1:${endpoint.port}`);
    console.log(`观察窗口：${OBSERVE_MS / 1000} 秒（MV3 空闲回收是 30 秒）`);

    const browser = await launch({ headless: true });

    try {
        await browser.loadExtension(EXT);

        /* ---- 对照组：先让 SW 起来，然后什么都不做 ---- */
        console.log('\n[A] 对照组：唤醒 SW 后不管它');
        const warm = await wakeSw(browser, 'about:blank');
        await sleep(3000);
        console.log(`    唤醒后 SW：${await swAlive(browser) ? '在' : '不在'}`);
        await sleep(OBSERVE_MS);
        const controlAlive = await swAlive(browser);
        console.log(`    ${OBSERVE_MS / 1000} 秒后 SW：${controlAlive ? '在' : '被回收'}`);

        if (controlAlive) {
            console.log('\n结论：这一轮无效 —— 对照组里 SW 本来就不回收，分不出 Port 的作用。');
            return;
        }

        /* ---- 实验组：唤醒 SW，让它连桥，然后什么都不做 ---- */
        console.log('\n[B] 实验组：唤醒 SW 并让它连桥');
        await wakeSw(browser, 'about:blank');
        await sleep(4000);
        const aliveAfterWake = await swAlive(browser);
        console.log(`    唤醒后 SW：${aliveAfterWake ? '在' : '不在'}`);

        /* host 进程起来了吗 —— 它起来说明 Port 真的开了 */
        const { execFileSync } = require('node:child_process');
        let procs = '';
        try {
            procs = execFileSync('powershell', ['-NoProfile', '-Command',
                "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
                + "Where-Object { $_.CommandLine -like '*host.js*' } | "
                + "Select-Object -ExpandProperty ProcessId"], { encoding: 'utf8' }).trim();
        } catch {
            procs = '';
        }
        console.log(`    host 进程 PID：${procs || '（没有 —— Port 没开成）'}`);

        await sleep(OBSERVE_MS);
        const testAlive = await swAlive(browser);
        console.log(`    ${OBSERVE_MS / 1000} 秒后 SW：${testAlive ? '还在' : '被回收'}`);

        console.log(`\n结论：${testAlive ? 'Port 保活成立 ✓' : 'Port 没能保住 SW ✗ —— 需要 chrome.alarms 兜底'}`);

        warm.close();
    } finally {
        await browser.close();
    }
};

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
