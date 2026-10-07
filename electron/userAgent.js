/* -------------------------------------------------------------------------- */
/*                             浏览器身份（出站 UA）                            */
/* -------------------------------------------------------------------------- */
/*
 * 唯一策略：**不改写 UA**。这里只把引擎自己的 UA 读出来给需要字符串的地方用
 * （Node 侧直抓、以及会话就绪后 push 给站点），浏览器进程发什么我们就用什么。
 *
 * 为什么不改写 —— 2026-10-02 在同一站点、同一代理、同一 solver 下的 A/B：
 *   · 不改写（UA 里就带着 `Electron/44.4.5`，Chrome 段是四位全版本号）
 *       → Cloudflare managed 挑战 **36s 自动放行，一次点击都没有**。
 *   · 改写成 `Chrome/152.0.0.0`（抹 token、掩版本）
 *       → 137s 不放行，自动点击 10~12 次全数无效，组件反复重建。
 *
 * 机制：Chromium **不会**按覆写值重算 sec-ch-ua 和 navigator.userAgentData。
 * 所以只要动 UA 字符串，就变成"嘴上是 Chrome 稳定版、元数据仍是 Chromium/Electron"，
 * 这是标准的伪装特征；CF 一旦据此判伪装，会把挑战升级成点了也不会放的死循环，
 * 再多的自动点击都救不回来。Google 那条"浏览器可能不安全"同样是这套一致性判据。
 *
 * 结论：身份要**一致**，不是要**好看**。要让站点看成 Chrome，就得
 * UA + sec-ch-ua + navigator.userAgentData + window.chrome 四层一起换；
 * 只换第一层比不换更糟。
 */

/**
 * 引擎自己的 UA（与 sec-ch-ua / navigator.userAgentData 天然一致）。
 *
 * 必须在 app.ready 之前也能取到，所以用 `app.userAgentFallback`：
 * Node 侧（非 Electron 运行时）require 这个模块时 electron 导出的是二进制路径字符串，
 * 拿不到 app，此时返回空串，调用方据此不去覆写。
 *
 * @returns {string}
 */
function kernelUserAgent() {
    const electron = require('electron');
    const app = electron && electron.app;
    return String((app && app.userAgentFallback) || '');
}

module.exports = { kernelUserAgent };
