// 用本机**真实安装的浏览器**（Chrome / Edge）去过 Cloudflare 的挑战，把渲染完成的
// 页面 HTML 静默取回来，交给上层现有的解析流程。
//
// 为什么需要这个文件（2026-10-07 实测，同一网络出口、各自全新 profile 的对照）：
//   Electron 44 生产身份 + 自动点击 12 次 → 120s 卡 initial，失败
//   Electron 44 生产身份 + 禁用点击      → 90s 卡 initial，失败
//   Electron 44 + UA 去掉 Electron token  → 71s 失败
//   真 Chrome 154 + 0 次点击              → 42.7s 自动放行
//   真 Chrome 154 + 补 3 次盲点           → 80s 未放行
//   真 Chrome 154 + --remote-debugging-port=0（其余参数同上，交替采样 2 轮）
//                                        → 2/2 卡满 78s 未放行
//   真 Chrome 154 + 固定调试端口（同一批交替采样）
//                                        → 2/2 放行（14.3s / 14.6s）
//   本模块从 Electron 主进程调用 + 固定端口 + 冷 profile → 6 次里 4 次放行（8-15.2s），
//                                        2 次卡满 60-90s 未放行（原因未定位：
//                                        同一份代码从普通 node 调用 10s 放行，
//                                        加不加后台节流开关也都放行，所以这两个都不是变量）
//   本模块从 Electron 主进程调用 + 固定端口 + 暖 profile → 8/8 放行（3.4-7.6s）
//    所以调试端口必须是具体值，不能让浏览器自己选（见 allocateDebugPort）；
//    冷 profile 那 1/3 的卡死用重试兜住（见 fetchHtmlWithRealBrowser）。
// 差异在客户端身份，不在点击：挑战页（https）上 Electron 的
//   sec-ch-ua = "Not?A_Brand";v="24", "Chromium";v="152"，而 UA 字符串自称
//   Chrome/152.0.7977.130 —— 品牌列表里没有 "Google Chrome"，与 UA 自相矛盾；
//   window.chrome 是空对象（Chrome 给 loadTimes/csi/app）；/pat/ 私有状态令牌 401。
// 想把这些补齐的三条路都已实测走不通，不要再往里加代码：
//   CDP Network.setUserAgentOverride 带 userAgentMetadata：四种参数形状全部
//     Invalid parameters（只带 UA 字符串才接受），Electron 根本不给改 UA-CH 的入口；
//   只覆写 UA 字符串而不动 Client Hints（两者分家，矛盾更大）；
//   往 CF 的跨源子帧注入伪造对象属于伪造浏览器身份，不在本项目的做法里。
//
// 行为约定：
//   - 全自动，零点击。真实浏览器自己会静默放行，**任何补点击都是在拖它**（见上表）。
//   - 窗口挪到屏幕外：实测屏幕外 + 零点击仍 42.7s 放行，用户看不到任何弹窗。
//   - 独立持久 profile（userData/real-browser-profile）：cf_clearance 留着复用，
//     第二次起通常几秒就过。绝不使用用户自己的浏览器 profile，也不读它的 cookie。
//   - 代理只透传设置里「代理端口」的值；留空就不传 --proxy-server，交回系统/TUN，
//     不把任何端口绑死。
//   - 不覆写 UA / Client Hints：真实浏览器的身份由它自己给，这正是本模块的前提。
const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, fallback) {
    return Promise.race([
        Promise.resolve(promise).catch(() => fallback),
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
}

// 残页不能当结果：代理在流中途断链时，浏览器会把半截文档报成 readyState=complete，
// 解析出 0 条，用户看到"验证过了但结果是空的"。
function isProperlyClosedHtml(html) {
    return /<\/html>\s*$/i.test(String(html || '').trimEnd());
}

// 标准安装位置。Chrome 在前（实测过验证的就是它），Edge 兜底（同内核）。
// 只认这些位置；找不到就明确报错，不做"随便拉一个能跑的浏览器"的兜底——
// 那会把失败原因推到"到底是谁渲染的页面"这种更难查的地方。
function exePaths() {
    const env = process.env || {};
    const out = [];
    const push = (p) => { if (p && !out.includes(p)) out.push(p); };
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']) {
        if (!base) continue;
        push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (env.LOCALAPPDATA) {
        push(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    return out;
}

/**
 * 找一个本机真实浏览器。
 * @returns {{exe:string, kind:string}|null}
 */
function findRealBrowser() {
    for (const exe of exePaths()) {
        try {
            if (fs.existsSync(exe)) {
                return { exe, kind: /msedge/i.test(exe) ? 'Edge' : 'Chrome' };
            }
        } catch (_e) { /* 读不到就当没有，继续下一个候选 */ }
    }
    return null;
}

/** 当前没人用的调试端口。实测（其余参数完全一致、两轮交替采样）：
 *  --remote-debugging-port=0 两次都在挑战页卡满 78s 未放行，固定端口两次都在 14s 放行，
 *  所以端口 0 不能作为选项，必须把具体端口交给浏览器。 */
function canListen(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '127.0.0.1');
    });
}

// 不写死单个端口：在高位区间里取第一个空闲的，全被占用就明确报错
async function allocateDebugPort() {
    for (let offset = 0; offset < 24; offset += 1) {
        const port = 39271 + offset;
        if (await canListen(port)) return port;
    }
    return null;
}

async function waitForTargets(port, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const list = await withTimeout(httpRequest(port, '/json/list'), 3000, null);
        if (Array.isArray(list) && list.length > 0) return list;
        await wait(200);
    }
    return null;
}

function httpRequest(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', timeout: 5000 }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('调试端口无响应')));
        req.end();
    });
}

// CDP 客户端：只做这个模块需要的几件事。
// 每个 send 都必须带超时——渲染进程卡死时 CDP 的 Promise 永不 settle，
// 会把整个轮询连 deadline 一起吊住（同类事故在应用内求解器上真踩过，那条路已删）。
function createCdp(wsUrl) {
    if (typeof WebSocket !== 'function') {
        throw new Error('当前运行环境没有 WebSocket，无法驱动外部浏览器');
    }
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch (_e) { return; }
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject, timer, onClose } = pending.get(msg.id);
            clearTimeout(timer);
            if (onClose) { try { ws.removeEventListener('close', onClose); } catch (_e) { /* ignore */ } }
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || 'CDP 调用失败'));
            else resolve(msg.result);
        }
    });
    const open = new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve);
        ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连不上')));
    });
    // 用函数声明而不是对象方法简写：主进程静态自检按"名字是否声明过"抓未定义调用，
    // 方法简写对它不可见，写成简写会被报成未声明的调用。
    function sendCommand(method, params, timeoutMs = 8000) {
        const id = ++seq;
        return new Promise((resolve, reject) => {
            const settle = () => {
                clearTimeout(entry.timer);
                try { ws.removeEventListener('close', entry.onClose); } catch (_e) { /* ignore */ }
                pending.delete(id);
            };
            const entry = {};
            entry.timer = setTimeout(() => { settle(); reject(new Error(method + ' 超时')); }, timeoutMs);
            entry.onClose = () => { settle(); reject(new Error(method + ' 连接已关闭')); };
            entry.resolve = (v) => { settle(); resolve(v); };
            entry.reject = (e) => { settle(); reject(e); };
            pending.set(id, entry);
            if (ws.readyState === 1) ws.send(JSON.stringify({ id, method, params: params || {} }));
            else reject(new Error(method + ' 发送失败：连接未就绪'));
        });
    }

    function closeSocket() {
        try { ws.close(); } catch (_e) { /* ignore */ }
    }

    return { ws, open, sendCommand, closeSocket };
}

// 轮询只取轻量状态（标题/URL/readyState/文档长度），全文只在页面看着已收尾之后取一次。
// 早先把两轮失败归因于"每 1.2s 拖一次全文把挑战拖死了"，那条结论不成立：
// 那两轮的真正变量是调试端口（见文件头实测表）。这里保留轻量轮询只是因为省，
// 全量轮询到底有没有副作用没再单独测过，别把它当风险结论。
const LIGHT_STATE = '({ title: document.title, url: location.href,'
    + ' ready: document.readyState,'
    + ' len: document.documentElement ? document.documentElement.outerHTML.length : 0 })';

const HTML_STATE = '({ title: document.title, url: location.href,'
    + ' html: document.documentElement ? document.documentElement.outerHTML : "" })';

// 挑战进行中的顶层文案。命中它就不取全文，省掉那笔跨进程开销
const CHALLENGE_TITLE_RE = /请稍候|正在验证|正在检查|just a moment|verifying|checking your browser/i;

// 认定"这页是正经内容页"的长度下限。实测：挑战页 outerHTML ≈29000 字节，
// 放行后的搜索结果页 ≈6900 字节，而挑战跳转中间态只有 505 字节。
// 500 字节那道门槛会被中间态正好跨过，所以要按实测值重新定。
const MIN_SETTLED_BYTES = 1500;

/**
 * 用真实浏览器取回 url 的最终 HTML（挑战已解开的状态）。
 *
 * 为什么要重试一次：冷 profile（这台机器第一次过这个站）实测 6 次里 2 次卡满时限不放行，
 * 而第二次起 profile 里带着 cf_clearance，7/7 都放行、3.4-15.1s。
 * 冷启动那 2 次卡住的原因没查出来（同一份代码从普通 node 启动就过，
 * 加没加后台节流开关也都过，所以不是节流），先用重试把它兜住。
 * 单次时限 60s × 2 次，最坏 120s，和原来单次 90s 的量级相当。
 *
 * @param {object} options
 * @param {string} options.url
 * @param {(html:string)=>boolean} options.isChallengePage
 * @param {(html:string)=>boolean} [options.isErrorPage]
 * @param {(msg:string)=>void} [options.log]
 * @param {number} [options.deadlineMs] 单次时限
 * @param {number} [options.attempts] 最多试几次（同一份 profile，第二次起就是暖的）
 * @param {string} [options.proxyServer] 形如 http://127.0.0.1:10810；空则跟随系统
 * @returns {Promise<{html:string, finalUrl:string, browser:string, costMs:number}>}
 */
async function fetchHtmlWithRealBrowser(options) {
    const {
        url, isChallengePage, isErrorPage, log = () => { },
        deadlineMs = 60000, proxyServer = '', attempts = 2,
    } = options || {};
    if (!url) throw new Error('缺少要打开的地址');

    const browser = findRealBrowser();
    if (!browser) {
        throw new Error('本机没有安装 Chrome 或 Edge，无法用真实浏览器通过站点验证');
    }
    const profileDir = path.join(app.getPath('userData'), 'real-browser-profile');
    fs.mkdirSync(profileDir, { recursive: true });

    let lastError = null;
    for (let tryNo = 1; tryNo <= attempts; tryNo += 1) {
        try {
            // 每次都是一整个新起的浏览器实例，但 profile 是同一份，
            // 所以第 2 次的起点是"已拿到 cf_clearance"的状态
            return await runOneAttempt({
                browser, profileDir, url, isChallengePage, isErrorPage, log, deadlineMs, proxyServer, tryNo,
            });
        } catch (e) {
            lastError = e;
            if (tryNo < attempts) {
                log(`第 ${tryNo} 次未放行（${String((e && e.message) || e).slice(0, 80)}），重试`);
            }
        }
    }
    throw lastError;
}

async function runOneAttempt(ctx) {
    const {
        browser, profileDir, url, isChallengePage, isErrorPage, log,
        deadlineMs, proxyServer, tryNo,
    } = ctx;
    const debugPort = await allocateDebugPort();
    if (!debugPort) {
        throw new Error('本机 39271-39294 全部被占用，拿不到调试端口，无法驱动真实浏览器');
    }

    const args = [
        // 具体端口（实测端口 0 会让浏览器过不了验证，见 allocateDebugPort 上方）
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run', '--no-default-browser-check', '--disable-sync',
        '--disable-background-networking',
        // 屏幕外 + 小窗：实测不影响 CF 的静默放行，用户看不到窗口
        '--window-position=-24000,-24000', '--window-size=980,720',
        'about:blank',
    ];
    // 代理只在设置里填了端口时才传；留空就交回系统/TUN，绝不写死某个端口
    if (proxyServer) args.push(`--proxy-server=${proxyServer}`);

    log(`启动 ${browser.kind} 过验证（第 ${tryNo} 次，屏幕外实例，独立 profile${proxyServer ? '，走已配置代理' : ''}）`);
    const startedAt = Date.now();
    const child = spawn(browser.exe, args, { stdio: 'ignore', windowsHide: true });
    let client = null;
    let result = null;
    let lastPhase = '未开始';
    let challengeLogAt = 0;
    try {
        const targets = await waitForTargets(debugPort, 15000);
        const page = Array.isArray(targets)
            ? targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : null;
        if (!page) throw new Error(`${browser.kind} 的调试端口 ${debugPort} 没起来（可能被安全软件拦截）`);

        client = createCdp(page.webSocketDebuggerUrl);
        await withTimeout(client.open, 8000, null);
        await client.sendCommand('Page.enable');
        await client.sendCommand('Runtime.enable');
        await client.sendCommand('Page.navigate', { url }, 15000);

        const deadline = startedAt + deadlineMs;
        while (Date.now() < deadline) {
            await wait(1500);
            const light = await client.sendCommand('Runtime.evaluate', {
                expression: LIGHT_STATE, returnByValue: true,
            }, 8000).then((r) => (r && r.result ? r.result.value : null)).catch(() => null);
            if (!light) { lastPhase = '页面无响应'; continue; }

            const title = String(light.title || '');
            if (CHALLENGE_TITLE_RE.test(title)) {
                // 每 15s 重报一次：只报一次的话，日志看起来像"程序没在动"，
                // 而实际上页面正在反复重算（实测 len 会在 29106/29235/29363 之间跳）。
                if (lastPhase !== 'challenge' || Date.now() - challengeLogAt > 15000) {
                    challengeLogAt = Date.now();
                    log(`challenge title=${title.slice(0, 50)} len=${light.len}`);
                    lastPhase = 'challenge';
                }
                continue;
            }

            // 标题一变就取全文会拿到半截文档（实测取回过 505 字节的"成功页"：
            // 标题已经换成正经标题、正文还没落进来，交回去就是 0 条结果）。
            // 等到 readyState=complete 且文档长度过下限再取。
            const lenNum = Number(light.len) || 0;
            if (String(light.ready || '') !== 'complete' || lenNum < MIN_SETTLED_BYTES) {
                if (lastPhase !== 'settling') {
                    log(`等待页面收尾 ready=${light.ready} len=${lenNum} title=${title.slice(0, 40)}`);
                    lastPhase = 'settling';
                }
                continue;
            }

            // 顶层文案已脱离"请稍候"，才取一次全文，用站点侧判据核实内容
            const full = await client.sendCommand('Runtime.evaluate', {
                expression: HTML_STATE, returnByValue: true,
            }, 15000).then((r) => (r && r.result ? r.result.value : null)).catch(() => null);
            if (!full) { lastPhase = '取全文失败'; continue; }
            const html = String(full.html || '');
            if (typeof isErrorPage === 'function' && isErrorPage(html)) {
                throw new Error('站点返回了 Cloudflare 错误页（不是"验证中"），请稍后重试');
            }
            if (typeof isChallengePage === 'function' && isChallengePage(html)) {
                // 文案变了但内容仍是挑战页（CF 换 UI 的形态）：继续等，别当成放行
                if (lastPhase !== 'challenge-content') {
                    log(`title=${title.slice(0, 40)} 但内容仍是挑战页，继续等`);
                    lastPhase = 'challenge-content';
                }
                continue;
            }
            if (html.length >= MIN_SETTLED_BYTES && isProperlyClosedHtml(html)) {
                result = {
                    html,
                    finalUrl: String(full.url || url),
                    browser: browser.kind,
                    costMs: Date.now() - startedAt,
                };
                log(`${browser.kind} 放行成功（第 ${tryNo} 次，${Math.round(result.costMs / 1000)}s）：`
                    + title.slice(0, 60));
                break;
            }
            if (lastPhase !== 'pending') {
                log(`pending title=${title.slice(0, 50)} bytes=${html.length}`);
                lastPhase = 'pending';
            }
        }
        if (!result) {
            throw new Error(`${browser.kind} 未能在 ${Math.round(deadlineMs / 1000)}s 内通过站点验证`
                + `（最后状态=${lastPhase}）。这通常是站点正在加强校验，稍后重试即可。`);
        }
        return result;
    } finally {
        // 优雅关闭：浏览器会在这一步把 profile（含 cf_clearance）落盘，
        // 强杀会让下一次重新过一遍验证，白等几十秒。收不住才强杀。
        if (client) {
            await withTimeout(client.sendCommand('Browser.close', {}, 4000), 4500, null);
            client.closeSocket();
        }
        await wait(600);
        if (!child.killed) {
            try { child.kill(); } catch (_e) { /* 已退出 */ }
        }
    }
}

module.exports = { fetchHtmlWithRealBrowser, findRealBrowser, isProperlyClosedHtml };
