const { app, BrowserWindow, ipcMain, shell, webContents, dialog } = require('electron');
const { probeGallery, downloadGallery, saveGalleryImages, fetchGalleryPages, normalizeGid, galleryTaskKey, galleryKeyMatches, GALLERY_CHANNELS, fetchChannelList, buildChannelListResult, channelListUrl, deriveListPageUrl, isCloudflareChallengePage, isCloudflareErrorPage, setUserAgent: pushUserAgentToSite } = require('./acgmhoService');
const { solveChallengeWithBrowser } = require('./challengeSolver');
const { getSettings, saveProxyPort, saveKbRoot, saveAiConfig, testAiConnection } = require('./settings');
const { loadKbSource, readKbArticle, kbStatus } = require('./kbService');
const { detectEdgeProfiles, importEdgeData } = require('./edgeImportService');
const {
    setupBrowserSession, setupBrowserIpc, attachBrowserInput, attachGuestExtras, guardWebviewAttach,
} = require('./browserService');
const { kernelUserAgent } = require('./userAgent');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { spawn, spawnSync, execSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { createWriteStream } = require('fs');
const ffmpegStatic = require('ffmpeg-static');

/* ========================================================================== */
/*                          启动自提权（管理员运行）                            */
/* ========================================================================== */
/*
 * 用户决策：整个程序以管理员身份运行 —— Edge 的 App-Bound Cookie 密钥
 * 第一层 DPAPI 只能在 SYSTEM 上下文解开，而拿到 SYSTEM 令牌需要管理员。
 *
 * 行为：
 *   - 已提权（`net session` 成功）→ 直接往下走；
 *   - 未提权 → 用 `Start-Process -Verb RunAs` 以管理员重启自己，
 *     然后当前进程退出（子进程继承 `THEPLAY_ELEVATED=1`，不会再套娃）；
 *   - UAC 被拒绝 → **直接退出**（用户决策：不降级运行，
 *     免得界面上每个功能都"看起来能点、一点就报权限不足"）。
 *
 * 这段必须在 `app.whenReady()` 之前执行，且不能依赖任何界面。
 * 测试不 require main.js（mainstatic 只读源码），这里不影响测试。
 */
(function ensureElevated() {
    if (process.platform !== 'win32') return;
    if (process.env.THEPLAY_ELEVATED === '1') return;
    /*
     * 以下两种情况说明 main.js 是被当库加载/求值，不是真正的程序启动，
     * 此时绝不能弹 UAC，直接跳过：
     *   - require.main !== module：测试桩用 new Function 求值 main.js 源码
     *     （见 scripts/proxy-check.js、scripts/proxy-sync-check.js），
     *     传进来的 module 是假对象；
     *   - 执行体是纯 node：真启动时 execPath 是 electron.exe（dev）
     *     或打包后的程序，文件名不可能是 node。
     */
    try {
        if (typeof require.main !== 'undefined' && require.main !== module) return;
        if (/^node(\.exe)?$/i.test(path.basename(process.execPath))) return;
    } catch (_e) { return; }
    try {
        execSync('net session', { stdio: 'ignore' });
        return;
    } catch (_e) { /* 未提权，往下走重启流程 */ }
    let relaunched = false;
    try {
        process.env.THEPLAY_ELEVATED = '1';
        const quotedArgs = process.argv.slice(1).map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ');
        const argPart = quotedArgs ? ` -ArgumentList ${quotedArgs}` : '';
        const ps = `Start-Process -FilePath "${process.execPath}"${argPart} -WorkingDirectory "${process.cwd()}" -Verb RunAs`;
        const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
        relaunched = !r.error && r.status === 0;
    } catch (_e) { relaunched = false; }
    app.exit(relaunched ? 0 : 1);
})();

/* ========================================================================== */
/*                          全局网络层（进程级设施）                          */
/* ========================================================================== */
/*
 * 主进程所有出网都由这里统一接管。设计目标是**服务不再各自维护出网逻辑**：
 * acgmhoService 照常写 https.get、settings 照常写 fetch，都不需要知道代理存在。
 *
 * 机制是全局拦截而非逐点注入：
 *   http.globalAgent / https.globalAgent  → 隧道 agent
 *   globalThis.fetch                      → Electron net.fetch（走 Chromium 栈）
 *
 * 为什么不能靠"每个出网点自己记得传 agent"：那样只要漏一处，该路径就静默绕过
 * 代理。事实上漏过两次——sukebeiService 的裸 https.get、main.js 的
 * downloadDirectFile，症状都是"浏览器能开、某个功能直连超时"，极难定位。
 *
 * 两条栈必须分别接管，因为它们的代理来源完全不同：
 *   - Node http/https：读 globalAgent（可被我们替换）
 *   - fetch（undici）：既不读 globalAgent，也不读 Electron 会话代理；
 *     实测同一会话下 net.fetch 200 而原生 fetch 直接失败。故换成 net.fetch。
 */

/* -------------------------------------------------------------------------- */
/*                                    类型                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {'http' | 'socks5'} ProxyProtocol
 *
 * @typedef {Object} ProxyAuth
 * @property {string} username
 * @property {string} password
 *
 * @typedef {Object} ParsedProxyAddress
 * @property {string} host
 * @property {number} port
 * @property {ProxyProtocol | null} protocol  null 表示用户没写协议，交给探测决定
 * @property {ProxyAuth | null} auth
 *
 * @typedef {Object} ProxyEndpoint
 * @property {string} host
 * @property {number} port
 * @property {ProxyProtocol} protocol
 * @property {ProxyAuth | null} auth
 *
 * @typedef {Object} SetProxyResult
 * @property {boolean} changed      端点是否变化（决定要不要重建 agent）
 * @property {boolean} applied      本次是否真的启用了隧道
 * @property {ProxyProtocol | ''} protocol  最终生效的协议，直连时为空串
 * @property {boolean} probeFailed  用户填了端口但连不上
 *
 * @typedef {Object} HttpGetResult
 * @property {string} html
 * @property {string} url  跟随重定向后的最终地址
 */

/* -------------------------------------------------------------------------- */
/*                                代理：状态                                  */
/* -------------------------------------------------------------------------- */
// 出站代理：Node 的 https.get 不读系统代理设置，需要显式注入。
// 走不走、走哪个端口，由用户在设置里填的「代理端口」决定（见 electron/settings.js），
// main.js 读配置后调用 setProxy()：有值走隧道，留空则一律直连。
//
// 端口存活探测：即便用户填了端口，端口也可能没在监听（代理软件没开、填错端口）。
// 一旦认定走代理，每条请求都会失败——表现为"浏览器能开、app 全挂"。
// 因此以"端口真的能连上"为准：连得上才建隧道，连不上就回落直连并上报 probeFailed，
// 由调用方在界面上提示用户去检查端口，而不是让所有请求静默失败。
//
// 协议：本地代理端口有两种常见形态，且默认端口彼此相邻、极易填错——
// v2rayN 默认 SOCKS5 在 10808、HTTP 在 10809；Clash 默认 HTTP 在 7890、SOCKS5 在 7891。
// 只实现 HTTP CONNECT 时，把 SOCKS 端口填进来会得到一句毫无线索的 "socket hang up"：
// CONNECT 的首字节 0x43('C') 不是 SOCKS5 的版本号 0x05，代理按协议错误直接关连接，
// 而 TCP 层握手是成功的，所以存活探测认为"端口可用"、界面还显示"代理已生效"。
// 这里两种协议都实现，并在用户只填裸端口时自动探测该端口说的是哪种。
let proxyEndpoint = null;
// 'host:port' -> 'http' | 'socks5'：探测要真的建一次隧道，不能每条请求都做。
// 端点没变就复用上次结论；隧道在握手阶段失败时清掉，让下次请求重新探测
// （代理软件换了协议重启，不必等用户去设置里再点一次保存）。
const protocolCache = new Map();
/**
 * 解析用户填写的代理地址。
 * 接受 "10810"、"127.0.0.1:10810"、"http://127.0.0.1:10810"、
 * "socks5://127.0.0.1:10808"、"socks5://用户:密码@127.0.0.1:10808"。
 * protocol 为 null 表示用户没指定，交给探测决定。
 * @param {string | null | undefined} value
 * @returns {ParsedProxyAddress | null}
 */
function parseProxyAddress(value) {
    if (!value)
        return null;
    let s = String(value).trim();
    // 显式协议前缀：socks5:// / socks:// / http:// / https://
    // 前缀必须在这里摘掉——它带 ':'，留给下面 lastIndexOf(':') 会把 "socks5" 当主机名。
    let protocol = null;
    const schemeMatch = s.match(/^(socks5h?|socks|https?):\/\//i);
    if (schemeMatch) {
        const raw = schemeMatch[1].toLowerCase();
        protocol = raw === 'http' || raw === 'https' ? 'http' : 'socks5';
        s = s.slice(schemeMatch[0].length);
    }
    // 凭据段 user:pass@：密码里可能有 '@'，所以取最后一个 '@' 之前的部分。
    let auth = null;
    const at = s.lastIndexOf('@');
    if (at > 0) {
        const cred = s.slice(0, at);
        s = s.slice(at + 1);
        const sep = cred.indexOf(':');
        try {
            auth = sep >= 0
                ? { username: decodeURIComponent(cred.slice(0, sep)), password: decodeURIComponent(cred.slice(sep + 1)) }
                : { username: decodeURIComponent(cred), password: '' };
        }
        catch (_e) {
            // 百分号编码非法（如孤立的 '%'）：按字面量处理，不因一个字符让整条配置失效
            auth = sep >= 0
                ? { username: cred.slice(0, sep), password: cred.slice(sep + 1) }
                : { username: cred, password: '' };
        }
    }
    const idx = s.lastIndexOf(':');
    if (idx <= 0)
        return null;
    const host = s.slice(0, idx).replace(/^\[|\]$/g, '');
    const port = Number(s.slice(idx + 1));
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535)
        return null;
    return { host, port, protocol, auth };
}

// 端口存活探测：TCP 握上手即算可用。短超时（本地端口要么立刻 accept，
// 要么立刻 ECONNREFUSED），避免拖慢每次 setProxy。
function probeProxyPort(endpoint, timeout = 1500) {
    if (!endpoint)
        return Promise.resolve(false);
    return new Promise((resolve) => {
        let socket = null;
        let settled = false;
        const done = (ok) => {
            if (settled)
                return;
            settled = true;
            if (socket)
                socket.destroy();
            resolve(ok);
        };
        try {
            socket = net.connect({ host: endpoint.host, port: endpoint.port });
        }
        catch (_e) {
            done(false);
            return;
        }
        socket.setNoDelay(true);
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
        socket.setTimeout(timeout, () => done(false));
    });
}

/* -------------------------------------------------------------------------- */
/*                            SOCKS5（RFC 1928）                               */
/* -------------------------------------------------------------------------- */
const SOCKS5_VERSION = 0x05;
const SOCKS5_NO_AUTH = 0x00;
const SOCKS5_CONNECT = 0x01;
const SOCKS5_ATYP_IPV4 = 0x01;
const SOCKS5_ATYP_DOMAIN = 0x03;
const SOCKS5_ATYP_IPV6 = 0x04;
// 握手阶段的失败原因要能说人话：这些码是"你填错端口/代理没配对"的唯一线索，
// 丢掉就只能看到 socket hang up。
const SOCKS5_ERROR_TEXT = {
    0x01: '代理内部错误',
    0x02: '代理规则不允许连接该目标',
    0x03: '代理无法解析目标域名（可尝试改走 HTTP 端口）',
    0x04: '目标主机不可达',
    0x05: '目标拒绝连接',
    0x06: 'TTL 过期',
    0x07: '代理不支持该命令',
    0x08: '代理不支持该地址类型',
};
/**
 * 标记"这是配置错了、重试没有意义"的错误。
 * 上层（httpGetFinal）据此跳过退避重试——端口填错时重试 3 次只是把
 * 一句明确的话拖成几十秒干等，用户还以为是网络慢。
 */
function proxyConfigError(message) {
    const err = new Error(message);
    err.proxyConfigError = true;
    return err;
}
/**
 * 目标地址的 SOCKS5 编码（ATYP + ADDR，不含 RSV）。
 * 域名交给代理去解析（ATYP=domain）而不是本地 resolve：本地 DNS 在代理环境里
 * 往往被污染或根本不通，而"让代理解析"正是 SOCKS5 的常规用法。
 */
function encodeSocks5Target(targetHost, targetPort) {
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    const ipVersion = net.isIP(targetHost);
    if (ipVersion === 4) {
        return Buffer.concat([Buffer.from([SOCKS5_ATYP_IPV4]), Buffer.from(targetHost.split('.').map(Number)), portBuf]);
    }
    if (ipVersion === 6) {
        return Buffer.concat([Buffer.from([SOCKS5_ATYP_IPV6]), expandIpv6(targetHost), portBuf]);
    }
    const domain = Buffer.from(targetHost, 'utf8');
    if (domain.length > 255)
        throw new Error(`目标域名过长: ${targetHost}`);
    return Buffer.concat([Buffer.from([SOCKS5_ATYP_DOMAIN, domain.length]), domain, portBuf]);
}
/** IPv6 文本 → 16 字节。处理 "::" 缩写与内嵌 IPv4（::ffff:1.2.3.4）。 */
function expandIpv6(address) {
    let head = address;
    let tail = '';
    if (address.includes('::')) {
        const [left, right] = address.split('::');
        head = left;
        tail = right || '';
    }
    const parseGroups = (part) => (part ? part.split(':').filter((g) => g !== '') : []);
    const pushGroup = (list, g) => {
        if (g.includes('.')) {
            // 内嵌 IPv4 占两个 16 位组
            const [a, b, c, d] = g.split('.').map(Number);
            list.push(((a << 8) | b) & 0xffff, ((c << 8) | d) & 0xffff);
        }
        else {
            list.push(parseInt(g, 16) & 0xffff);
        }
    };
    const words = [];
    parseGroups(head).forEach((g) => pushGroup(words, g));
    const tailWords = [];
    parseGroups(tail).forEach((g) => pushGroup(tailWords, g));
    const fill = 8 - words.length - tailWords.length;
    const buf = Buffer.alloc(16);
    let offset = 0;
    const writeWord = (w) => { buf.writeUInt16BE(w, offset); offset += 2; };
    words.forEach(writeWord);
    for (let i = 0; i < fill; i += 1)
        writeWord(0);
    tailWords.forEach(writeWord);
    return buf;
}
/**
 * 经 SOCKS5 代理连到 targetHost:targetPort，成功回调交回已连通的裸 socket。
 * 无认证（0x00）与用户名/密码（0x02）都支持——本地代理多数免认证，
 * 但带认证的也不该直接报错。
 *
 * 阶段推进全部在 onData 里同步完成，不靠"再挂一个 data 监听去改状态"：
 * 数据可能和服务端响应同帧到达，状态必须由"已读到什么"唯一决定。
 */
function tunnelThroughSocks5(targetHost, targetPort, cb, auth = null) {
    let settled = false;
    let socket = null;
    const done = (err, s) => {
        if (settled)
            return;
        settled = true;
        if (err && socket) {
            try {
                socket.destroy();
            }
            catch (_e) { /* ignore */ }
        }
        cb(err, s);
    };
    if (!proxyEndpoint) {
        done(new Error('未配置代理'));
        return;
    }
    try {
        socket = net.connect({ host: proxyEndpoint.host, port: proxyEndpoint.port });
    }
    catch (e) {
        done(e);
        return;
    }
    socket.setNoDelay(true);
    // 阶段机：greeting（方法协商）→ auth（可选）→ reply（连接结果）
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    // 分阶段超时：方法协商阶段对方一个字都不回，几乎只有一个原因——这个端口不是
    // SOCKS5（HTTP 代理会把 0x05 开头的字节当成残缺的请求行，既不回也不关，只是干等）。
    // 所以协商阶段给短超时并直接给出可操作的结论，而不是让用户对着"握手超时"干等。
    socket.setTimeout(4000, () => {
        done(proxyConfigError(stage === 'greeting'
            ? `SOCKS5 代理无响应（${proxyEndpoint.host}:${proxyEndpoint.port} 可能不是 SOCKS5 端口，请确认端口号；HTTP 与 SOCKS5 端口通常只差一位数字）`
            : 'SOCKS5 代理握手超时'));
    });
    const sendConnectRequest = () => {
        stage = 'reply';
        // 请求格式是 VER CMD RSV ATYP DST.ADDR DST.PORT —— RSV 这一个保留字节不能省。
        // 漏掉它 ATYP 就落在 RSV 的位置上，代理读到的地址类型非法，
        // 表现是"握手不报错、连接被直接关掉"，极难从现象反推。
        socket.write(Buffer.concat([
            Buffer.from([SOCKS5_VERSION, SOCKS5_CONNECT, 0x00]),
            encodeSocks5Target(targetHost, targetPort),
        ]));
    };
    const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
            if (stage === 'greeting') {
                if (buffer.length < 2)
                    return;
                const version = buffer[0];
                const method = buffer[1];
                buffer = buffer.slice(2);
                if (version !== SOCKS5_VERSION) {
                    // 回的不是 SOCKS5：这个端口多半是 HTTP 代理。报错要指明，
                    // 否则用户只会看到"连接被重置"，无从判断该填哪个端口。
                    done(proxyConfigError(`该端口不是 SOCKS5 代理（响应版本 0x${version.toString(16)}，可能是 HTTP 代理端口）`));
                    return;
                }
                if (method === 0xff) {
                    done(proxyConfigError('SOCKS5 代理拒绝所有认证方式'));
                    return;
                }
                if (method === 0x02) {
                    if (!auth || !auth.username) {
                        done(proxyConfigError('SOCKS5 代理要求用户名/密码认证，请改用 socks5://用户:密码@主机:端口'));
                        return;
                    }
                    const u = Buffer.from(auth.username, 'utf8');
                    const p = Buffer.from(auth.password || '', 'utf8');
                    if (u.length > 255 || p.length > 255) {
                        done(proxyConfigError('SOCKS5 用户名或密码超过 255 字节'));
                        return;
                    }
                    stage = 'auth';
                    socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
                    return;
                }
                if (method !== SOCKS5_NO_AUTH) {
                    done(proxyConfigError(`SOCKS5 代理要求不支持的认证方式 0x${method.toString(16)}`));
                    return;
                }
                sendConnectRequest();
                return;
            }
            if (stage === 'auth') {
                if (buffer.length < 2)
                    return;
                const ok = buffer[1] === 0x00;
                buffer = buffer.slice(2);
                if (!ok) {
                    done(proxyConfigError('SOCKS5 代理用户名或密码错误'));
                    return;
                }
                sendConnectRequest();
                return;
            }
            if (stage === 'reply') {
                if (buffer.length < 4)
                    return;
                const reply = buffer[1];
                if (reply !== 0x00) {
                    const text = SOCKS5_ERROR_TEXT[reply] || `未知错误 0x${reply.toString(16)}`;
                    done(new Error(`SOCKS5 代理拒绝连接 ${targetHost}:${targetPort}（${text}）`));
                    return;
                }
                // 回复头里还带绑定地址（ATYP + addr + port），必须整段读掉再交回 socket，
                // 否则残留字节会被当成 TLS 握手数据，表现为"证书错误/协议错误"。
                const atyp = buffer[3];
                let need = 4;
                if (atyp === SOCKS5_ATYP_IPV4)
                    need += 4;
                else if (atyp === SOCKS5_ATYP_IPV6)
                    need += 16;
                else if (atyp === SOCKS5_ATYP_DOMAIN) {
                    if (buffer.length < 5)
                        return;
                    need += 1 + buffer[4];
                }
                else {
                    done(proxyConfigError(`SOCKS5 代理回复了未知地址类型 0x${atyp.toString(16)}`));
                    return;
                }
                need += 2;
                if (buffer.length < need)
                    return;
                // 多读到的字节属于目标服务（如 TLS ServerHello），必须 unshift 回去
                const leftover = buffer.slice(need);
                socket.setTimeout(0);
                socket.removeListener('data', onData);
                socket.removeListener('error', onSocketError);
                socket.removeListener('close', onSocketClose);
                settled = true;
                if (leftover.length)
                    socket.unshift(leftover);
                cb(null, socket);
                return;
            }
        }
        catch (e) {
            done(e);
        }
    };
    const onSocketError = (err) => done(err);
    const onSocketClose = () => done(proxyConfigError('SOCKS5 代理在握手完成前关闭了连接（端口可能不是 SOCKS5）'));
    socket.on('data', onData);
    socket.on('error', onSocketError);
    socket.once('close', onSocketClose);
    socket.once('connect', () => {
        // 只声明无认证；代理若选 0x02 会在 greeting 分支里按 auth 处理
        socket.write(Buffer.from([SOCKS5_VERSION, 0x01, SOCKS5_NO_AUTH]));
    });
}
/**
 * 探测该端口说的是哪种代理协议。
 * 判据是"真的发一次请求、看它怎么回"，而不是读 banner——两种协议都不发欢迎语：
 * - HTTP 代理收到 CONNECT 会回状态行（"HTTP/1.1 200 ..."）；
 * - SOCKS5 收到 CONNECT 会把 0x43('C') 当版本号，协议不匹配 → 直接关连接。
 * 所以先试 CONNECT：两种端口都能在毫秒级给出结论（HTTP 回状态行、SOCKS5 立刻断开），
 * 反过来先试 SOCKS5 的话，HTTP 代理对 0x05 开头的数据不置一词、只能干等到超时。
 * 拿到状态行即判 http；连接被关且没有任何 HTTP 响应，再试 SOCKS5 问候语（回 0x05 即 socks5）。
 * 两者都不成立就按 http 处理——保持原有行为，不因探测失败而让功能整体不可用。
 *
 * CONNECT 目标用 example.com:443 这类中性公网地址：只做分类，不掺入业务站点，
 * 免得把"代理规则挡了目标站"误读成"协议不对"。
 */
function detectProxyProtocol(endpoint, timeout = 4000) {
    const key = `${endpoint.host}:${endpoint.port}`;
    const cached = protocolCache.get(key);
    if (cached)
        return Promise.resolve(cached);
    const remember = (protocol) => {
        // 探测不出结果时不要写缓存：代理软件可能正在启动，缓存住会把
        // "暂时不可用"固化成永久错误，用户重启代理后仍然连不上。
        if (protocol)
            protocolCache.set(key, protocol);
        return protocol || 'http';
    };
    // 第一步：CONNECT 探测。resolve(null) 表示"没吐出 HTTP 响应"（疑似 SOCKS5）
    const probeHttp = () => new Promise((resolve) => {
        let settled = false;
        let req = null;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (req) {
                try {
                    req.destroy();
                }
                catch (_e) { /* ignore */ }
            }
            resolve(result);
        };
        req = http.request({
            host: endpoint.host,
            port: endpoint.port,
            method: 'CONNECT',
            path: 'www.example.com:443',
            headers: { Host: 'www.example.com:443' },
            // 同 tunnelThroughProxy：探测"这个端口是什么协议"本身就是连代理，
            // 必须用直连 agent，否则会递归。
            agent: directHttpAgent,
        });
        req.once('connect', (res, socket) => {
            socket.destroy();
            // 任何状态行都证明它说 HTTP（200 通了、407 要认证、403 被规则挡，都是 HTTP 代理）
            finish(res.statusCode ? 'http' : null);
        });
        req.once('response', () => finish('http')); // 非 CONNECT 语义的 HTTP 响应
        req.once('error', () => finish(null)); // 被关连接 → 交给 SOCKS5 判断
        req.setTimeout(timeout, () => finish(null));
        req.end();
    });
    // 第二步：SOCKS5 问候语。回 0x05 即 SOCKS5，否则放弃（按 http）
    const probeSocks = () => new Promise((resolve) => {
        let settled = false;
        let socket = null;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (socket) {
                try {
                    socket.destroy();
                }
                catch (_e) { /* ignore */ }
            }
            resolve(result);
        };
        try {
            socket = net.connect({ host: endpoint.host, port: endpoint.port });
        }
        catch (_e) {
            finish(null);
            return;
        }
        socket.setNoDelay(true);
        socket.setTimeout(timeout, () => finish(null));
        socket.once('error', () => finish(null));
        socket.once('connect', () => socket.write(Buffer.from([SOCKS5_VERSION, 0x01, SOCKS5_NO_AUTH])));
        socket.once('data', (chunk) => finish(chunk[0] === SOCKS5_VERSION ? 'socks5' : null));
    });
    return probeHttp().then((result) => (result ? remember(result) : probeSocks().then(remember)));
}
/** 经当前代理建隧道到目标地址；协议由 proxyEndpoint.protocol 决定 */
function tunnelThroughProxy(targetHost, targetPort, cb) {
    if (!proxyEndpoint) {
        cb(new Error('未配置代理'));
        return;
    }
    const protocol = proxyEndpoint.protocol || 'http';
    if (protocol === 'socks5') {
        tunnelThroughSocks5(targetHost, targetPort, (err, socket) => {
            // 协议判断错了（端口换了协议没改配置）→ 作废缓存，下次 setProxy 重新探测。
            // 只作废、不当场重试：重试会把一次请求变两次，且下一条请求会自然纠正。
            if (err && err.proxyConfigError)
                invalidateProtocolCache();
            cb(err, socket);
        }, proxyEndpoint.auth || null);
        return;
    }
    const req = http.request({
        host: proxyEndpoint.host,
        port: proxyEndpoint.port,
        method: 'CONNECT',
        path: `${targetHost}:${targetPort}`,
        headers: { Host: `${targetHost}:${targetPort}` },
        // 直连 agent，不能用 agent:false——那会以 globalAgent 的构造函数新建实例，
        // 而 globalAgent 就是本模块的隧道 agent，等于让"连代理"的请求再去连代理（递归爆栈）。
        agent: directHttpAgent,
    });
    let settled = false;
    const done = (err, socket) => {
        if (settled)
            return;
        settled = true;
        cb(err, socket);
    };
    req.once('connect', (res, socket) => {
        if (res.statusCode !== 200) {
            socket.destroy();
            done(new Error(`代理 CONNECT 被拒（HTTP ${res.statusCode}）`));
            return;
        }
        socket.setTimeout(0);
        socket.setNoDelay(true);
        done(null, socket);
    });
    req.once('error', (err) => {
        // HTTP 代理端口其实是 SOCKS5：CONNECT 的首字节 0x43 不是 SOCKS5 的版本号 0x05，
        // 代理按协议错误直接关连接 → ECONNRESET / socket hang up。
        // 只对这两个码作废缓存：ECONNREFUSED/ENOTFOUND 是代理自己没起来或域名问题，
        // 与协议无关，不该把已经探明的结论丢掉。
        const code = err && err.code;
        if (code === 'ECONNRESET' || /socket hang up/i.test((err && err.message) || '')) {
            invalidateProtocolCache();
        }
        done(err);
    });
    req.setTimeout(15000, () => req.destroy(new Error('代理 CONNECT 超时')));
    req.end();
}
/* -------------------------------------------------------------------------- */
/*                             keep-alive agents                               */
/* -------------------------------------------------------------------------- */

/**
 * 直连 agent：**永不经过代理**，专供"连代理本身"用。
 *
 * 为什么必须显式给一个：接管全局 agent 之后（见 installGlobalAgents），
 * `agent: false` 不再是"不代理"的意思——Node 对它的处理是"以当前
 * globalAgent 的构造函数新建一个实例"，于是新建出来的还是我们的隧道 agent，
 * 连代理的请求又去连代理，无限递归（实测爆栈：
 * tunnelThroughProxy → createConnection → http.request → tunnelThroughProxy …）。
 *
 * 所以凡是"为了建立隧道而发起的请求"（CONNECT 探测、HTTP 隧道）都必须显式
 * 指定这个直连 agent，否则自我递归。
 */
const directHttpAgent = new http.Agent({ keepAlive: false });
const directHttpsAgent = new https.Agent({ keepAlive: false });
/*
 * createConnection 的签名必须与 Node 的 Agent 基类保持一致（callback 可省略、
 * stream 是 Duplex 而非 Socket），否则 tsc 会判定"子类没有正确实现基类方法"。
 * 内部仍按 Socket 使用——我们交回的确实是 net.Socket / TLSSocket，二者都是 Duplex 的子类。
 */
class ProxiedHttpsAgent extends https.Agent {
    createConnection(options, callback) {
        if (!proxyEndpoint)
            return super.createConnection(options, callback);
        const cb = callback;
        const host = options.host;
        const port = options.port || 443;
        tunnelThroughProxy(host, port, (err, socket) => {
            if (err) {
                cb(err, null);
                return;
            }
            const tlsSocket = tls.connect({
                ...options,
                socket,
                servername: options.servername || host,
            });
            // 握手必须自带超时：隧道建好后若握手卡死（代理半死连接/对端不回），
            // 这个 socket 永远不会交给 request，req 的 timeout 无从启动 →
            // 搜索会永久挂起（用户看到"验证窗口不弹出 + 一直转圈"，且没有任何报错）。
            const handshakeTimer = setTimeout(() => {
                tlsSocket.destroy(new Error('TLS 握手超时（代理隧道异常）'));
            }, 10000);
            const onSecure = () => {
                clearTimeout(handshakeTimer);
                tlsSocket.removeListener('error', onError);
                cb(null, tlsSocket);
            };
            const onError = (tlsErr) => {
                clearTimeout(handshakeTimer);
                tlsSocket.removeListener('secureConnect', onSecure);
                cb(tlsErr, null);
            };
            tlsSocket.once('secureConnect', onSecure);
            tlsSocket.once('error', onError);
        });
        return undefined;
    }
}
class ProxiedHttpAgent extends http.Agent {
    createConnection(options, callback) {
        if (!proxyEndpoint)
            return super.createConnection(options, callback);
        const cb = callback;
        tunnelThroughProxy(options.host, options.port || 80, (err, socket) => {
            if (err) {
                cb(err, null);
                return;
            }
            cb(null, socket);
        });
        return undefined;
    }
}
function buildAgents() {
    return {
        httpAgent: new ProxiedHttpAgent({ keepAlive: true, maxSockets: 10 }),
        httpsAgent: new ProxiedHttpsAgent({ keepAlive: true, maxSockets: 10 }),
    };
}
// 连接复用：详情/列表/图片全走 keep-alive，200 页连抓不再每页重建 TCP+TLS。
// maxSockets cap 并发上限，配合业务层并发池使用，避免打满服务端。
const initialAgents = buildAgents();
let httpAgent = initialAgents.httpAgent;
let httpsAgent = initialAgents.httpsAgent;
/**
 * 取当前生效的 agent 对。
 *
 * setProxy 会在端点变化时整体替换 agent 并销毁旧的，所以调用方**不能**在模块
 * 加载时缓存这两个引用，必须在每次发请求前现取——否则代理切换后仍走旧 agent
 * （旧 agent 绑着旧隧道配置），表现为"改了代理设置但请求还是走老路"。
 */
function getAgents() {
    return { httpAgent, httpsAgent };
}
/**
 * 端口存活判定后再落地：连得上才走隧道，连不上就当直连（交给 VPN/系统网络）。
 * changed 表示代理端点是否变化（决定要不要重建 agent），applied 表示本次是否真的
 * 启用了隧道，protocol 是最终生效的协议（供界面显示"经 127.0.0.1:10808（SOCKS5）"），
 * probeFailed 表示端口连不上。
 */
async function setProxy(address) {
    const parsed = parseProxyAddress(address);
    const alive = parsed ? await probeProxyPort(parsed) : false;
    // 用户没写协议前缀才探测：显式写了就尊重用户，不去猜。
    // 探测本身要发一次请求，代价约一次本地 TCP 往返，只在端点变化时发生（结果有缓存）。
    let protocol = parsed ? parsed.protocol : null;
    if (alive && !protocol)
        protocol = await detectProxyProtocol(parsed);
    const next = alive
        ? { host: parsed.host, port: parsed.port, protocol: protocol || 'http', auth: parsed.auth || null }
        : null;
    const before = proxyEndpoint ? `${proxyEndpoint.host}:${proxyEndpoint.port}/${proxyEndpoint.protocol}` : '';
    const after = next ? `${next.host}:${next.port}/${next.protocol}` : '';
    if (before === after) {
        // 端点没变也要保证全局接管处于生效状态（模块刚加载、或曾被外部改写过 globalAgent）
        installGlobalInterception();
        return { changed: false, applied: !!next, protocol: next ? next.protocol : '', probeFailed: !!parsed && !alive };
    }
    proxyEndpoint = next;
    const oldHttp = httpAgent;
    const oldHttps = httpsAgent;
    const agents = buildAgents();
    httpAgent = agents.httpAgent;
    httpsAgent = agents.httpsAgent;
    // 换完立刻重新接管全局：否则 globalAgent 仍指向刚被销毁的旧 agent，
    // 之后所有不传 agent 的请求都会打在死连接上。
    installGlobalInterception();
    try {
        oldHttp.destroy();
    }
    catch (_e) { /* ignore */ }
    try {
        oldHttps.destroy();
    }
    catch (_e) { /* ignore */ }
    return { changed: true, applied: !!next, protocol: next ? next.protocol : '', probeFailed: !!parsed && !alive };
}
function getProxy() {
    return proxyEndpoint ? `${proxyEndpoint.host}:${proxyEndpoint.port}` : null;
}
/** 当前生效的协议（'http' | 'socks5' | ''）：界面与日志用它区分隧道类型。 */
function getProxyProtocol() {
    return proxyEndpoint ? proxyEndpoint.protocol : '';
}
/**
 * 隧道在握手阶段失败时作废协议缓存。
 * 典型场景：用户在 10808 上把 SOCKS5 换成了 HTTP（或反之）而不改端口，
 * 缓存住旧协议会让每条请求都失败且原因难辨。作废后下一次 setProxy 重新探测。
 */
function invalidateProtocolCache() {
    if (proxyEndpoint)
        protocolCache.delete(`${proxyEndpoint.host}:${proxyEndpoint.port}`);
}

/* -------------------------------------------------------------------------- */
/*                          全局接管（覆盖全部流量）                            */
/* -------------------------------------------------------------------------- */

/**
 * 把代理装到 Node 的全局 agent 上，让**所有** http/https 请求自动走代理。
 *
 * 为什么必须这么做：靠"每个出网点自己记得传 agent"是不可靠的——
 * 只要有一处忘了传，那条路径就静默绕过代理。事实上已经漏过两次：
 * sukebeiService 的裸 https.get、main.js 的 downloadDirectFile。
 * 这类漏网的典型症状是"浏览器能开、某个功能直连超时"，极难定位。
 *
 * 机制：Node 在 options.agent 为 undefined 时会用 http.globalAgent /
 * https.globalAgent。把这两个换成我们的隧道 agent，则**任何不传 agent 的
 * 调用都会自动走代理**，调用方无需知情、也无需配合。
 *
 * 覆盖不到的两类，各自另有安排：
 *   1. 显式传了别的 agent 的调用（如我们自己的 httpGetFinal 传了当前 agent）——
 *      它们本来就是走代理的，不受影响；
 *   2. agent: false（每次新建一次性 agent，绕过全局）——少数库会这么写。
 *      当前代码库没有这种用法；若将来出现，那条路径需要单独处理。
 *
 * 反复调用是安全的：每次 setProxy 都会重新装一遍，旧 agent 会被销毁。
 */
function installGlobalAgents() {
    const agents = getAgents();
    http.globalAgent = agents.httpAgent;
    https.globalAgent = agents.httpsAgent;
}

/**
 * 接管全局 fetch，让它也走代理。
 *
 * 为什么需要单独处理：Node 的 fetch 由 undici 实现，**既不读 http.globalAgent
 * 也不读 Electron 会话代理**——实测在同一个已配好 SOCKS5 的会话里，
 * net.fetch 返回 200，原生 fetch 直接 "fetch failed"。也就是说上面那套
 * globalAgent 接管对它完全无效，凡是走 fetch 的代码（settings.js 探活 AI、
 * 将来任何新增服务）都会静默绕过代理。
 *
 * 解法是把全局 fetch 换成 Electron 的 net.fetch：它走 Chromium 网络栈，
 * 而 Chromium 会话的代理由 main.js 的 applySessionProxy 配置，天然生效。
 * 这样两条栈（Node http/https 与 fetch）都覆盖到了。
 *
 * 前提：必须在 app ready 之后调用（net.fetch 依赖 ready 的 Electron 运行时）。
 * 早于 ready 调用会抛错，此时保持原生 fetch，由调用方在 ready 后重试。
 */
function installGlobalFetch() {
    try {
        // 延迟 require：本模块在 app ready 前就会被加载，此时 require('electron')
        // 虽可用，但 net.fetch 尚不可调用。这里只做替换，调用时 Electron 已 ready。
        const electron = require('electron');
        if (!electron || typeof electron.net?.fetch !== 'function') return false;
        const netFetch = electron.net.fetch.bind(electron.net);
        if (globalThis.fetch === netFetch) return true;
        globalThis.fetch = netFetch;
        return true;
    } catch (_e) {
        // 非 Electron 环境（如测试、CLI）：保持原生 fetch，不阻断模块加载
        return false;
    }
}

/**
 * 一次性装好全部接管：Node http/https 的全局 agent + 全局 fetch。
 * setProxy 每次变更后调用；main.js 在 app ready 后也会调用一次（fetch 需要 ready）。
 */
function installGlobalInterception() {
    installGlobalAgents();
    return installGlobalFetch();
}

/* -------------------------------------------------------------------------- */
/*                              浏览器会话身份                                  */
/* -------------------------------------------------------------------------- */
// UA 的唯一来源见 electron/userAgent.js：**不改写**，读引擎自己那一份。
// cf_clearance 与 UA 绑定，所以 Node 直抓用的必须是"拿到凭证的那个浏览器的 UA"，
// 而不是另一份手写的字符串——历史上 Node 用 Chrome/126、浏览器用 Chromium 120，
// 三处（UA 头 / navigator / sec-ch-ua）互相矛盾，Cloudflare 校验直接判失败。
//
// 职责划分：站点模块（acgmhoService）仍持有它抓取时用的 UA，因为抓页面的是它。
// 这里只做两件事：记住浏览器会话当前用的 UA，并在它变化时推给站点模块对齐。
// 不在这边再存一份请求头——两份状态迟早不同步，而"Node 用旧 UA、浏览器用新 UA"
// 的表现就是"验证过了但搜索仍 403"，极难定位。
let sessionUserAgent = '';
/**
 * 记录浏览器会话 UA 并推给站点模块。
 *
 * 三个调用点（同步代理后、挑战求解后）都走这里，不要在别处直接调
 * pushUserAgentToSite：去重逻辑在这个 wrapper 里，绕过它会让每次挑战
 * 都白推一遍。
 *
 * 注意 catch 的代价：本函数在 syncAcgmhoProxy 的 try 块里被调用，
 * 一旦这里抛错，catch 会执行 setProxy(null) 把刚建好的隧道清成直连，
 * 界面随即显示"端口连不上"——而端口其实是好的。所以这里不能出现
 * 未定义的引用（曾因 pushUserAgentToSite 漏了导入而真实触发过这个连锁反应）。
 */
function setUserAgent(value) {
    const next = String(value || '').trim();
    if (!next || next === sessionUserAgent)
        return false;
    sessionUserAgent = next;
    // 推给站点模块，保证 Node 直抓与浏览器会话用同一个 UA
    pushUserAgentToSite(next);
    return true;
}
function getUserAgent() {
    return sessionUserAgent;
}

/* ---- 供本文件其余部分调用的别名 ------------------------------------------ */
// 代理相关的能力原先由 acgmhoService 转手导出（它是站点模块，不该管代理）。
// 现在网络层就在本文件里，直接用本地函数，语义也更直白。
const setAcgmhoProxy = setProxy;
const getAcgmhoProxy = getProxy;
const getAcgmhoProxyProtocol = getProxyProtocol;

if (!app.isPackaged) {
    // 开发阶段浏览器能力依赖 webview 与抓包能力，先关闭 Electron 控制台安全告警，
    // 避免无效噪音淹没真实运行时错误。
    process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

// 全文搜索的 Cloudflare managed 挑战依赖 brunhild.challenges.cloudflare.com 下发验证结果。
// 该域名只有 AAAA 记录（实测 Google/Cloudflare DoH 均无 A 记录），而无 IPv6 的环境
// （网卡禁用 IPv6、VPN 阻断 IPv6 均常见）解析必失败，挑战永远无法完成——表现为搜索
// 长关键词一直"无结果"。固定解析到 challenges.cloudflare.com 的同款 IPv4 边缘：
// TLS SNI 仍是 brunhild.*，CF 边缘可正常应答（实测 /i/ 返回 204），且该域名本就不可解析，
// MAP 不会影响任何正常解析路径。
app.commandLine.appendSwitch(
    'host-resolver-rules',
    'MAP brunhild.challenges.cloudflare.com 104.18.95.41'
);

let mainWindow = null;

const USER_AGENT = kernelUserAgent();
/**
 * 必须交给 ffmpeg 才能得到可用文件的后缀。
 *
 * 与嗅探的 stream 分类**同一份清单**（utils.MEDIA_EXTENSIONS 的 stream 类），
 * 也就是 utils.requiresFfmpeg 判据里"后缀"那一半的派生副本：
 * 嗅探把 m3u8 / m3u / mpd / ts / flv / f4v 归为 stream，界面据此打上
 * 「ffmpeg 下载」徽章、并在 ffmpeg 缺失时拦住下载。这里少列一个，
 * 同一个文件就会"界面说要 ffmpeg、实际走裸 HTTP 直存"——
 * 落盘的 .ts / .flv 是播放器（本应用靠 hls.js / flv.js 才认）打不开的裸流。
 *
 * test/sniffer.test.js 会比对这张表与 utils 的分类，漂移即失败。
 */
const STREAM_EXTENSIONS = new Set(['m3u8', 'm3u', 'mpd', 'ts', 'flv', 'f4v']);
const MEDIA_HTTP_HEADERS = {
    'User-Agent': USER_AGENT,
    Referer: '',
};

function resolveFfmpegPath() {
    if (!ffmpegStatic) {
        return null;
    }

    if (!app.isPackaged) {
        return ffmpegStatic;
    }

    const unpackedPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
    return fs.existsSync(unpackedPath) ? unpackedPath : ffmpegStatic;
}

function getDownloadCapabilities() {
    const ffmpegPath = resolveFfmpegPath();
    const ffmpegAvailable = Boolean(ffmpegPath && fs.existsSync(ffmpegPath));

    return {
        ffmpegAvailable,
        ffmpegMessage: ffmpegAvailable
            ? '项目内 ffmpeg 已就绪，可直接下载流媒体资源。'
            : '项目内 ffmpeg 不可用，当前无法下载流媒体资源。',
    };
}

/**
 * content-type 的 MIME 子类型 → 规范后缀。
 *
 * 不能直接把子类型当后缀用：MIME 里大量子类型是**编码名而不是容器名**，
 * 照搬会产出系统与播放器都不认的"后缀"：
 *   video/x-matroska  → matroska（真实后缀 mkv）
 *   video/quicktime   → quicktime（真实后缀 mov）
 *   video/mp2t        → mp2t（真实后缀 ts，已在上游单独处理）
 *   audio/x-mpeg      → mpeg（真实后缀 mp3）
 *   audio/mp4         → mp4（真实后缀 m4a）
 * 这些后缀会一路带到下载：文件名变成 `片子.matroska`，
 * 而本应用的下载判定、播放器类型判定都按 MEDIA_EXTENSIONS 查表，全都落空。
 *
 * 两张表而不是一张：`ogg` 在主类型下含义不同 —— video/ogg 是 `.ogv`、
 * audio/ogg 是 `.ogg`。合成一张表必然把其中一个映射错。
 * 表里没有的（含 `video/mp4` 这种子类型恰好等于后缀的常见情形）回落默认值。
 */
const VIDEO_MIME_EXTS = {
    'mp4': 'mp4', 'mpeg': 'mpg', 'mpg': 'mpg',
    'x-matroska': 'mkv', 'matroska': 'mkv',
    'quicktime': 'mov', 'x-msvideo': 'avi', 'avi': 'avi',
    'webm': 'webm', 'ogg': 'ogv', 'x-ms-wmv': 'wmv', '3gpp': '3gp',
};

const AUDIO_MIME_EXTS = {
    'x-mpeg': 'mp3', 'mpeg': 'mp3', 'mp3': 'mp3', 'mpeg3': 'mp3',
    'wav': 'wav', 'x-wav': 'wav', 'wave': 'wav',
    'aac': 'aac', 'x-aac': 'aac', 'mp4': 'm4a', 'm4a': 'm4a',
    'flac': 'flac', 'x-flac': 'flac', 'opus': 'opus',
    'x-ms-wma': 'wma', 'x-ms-asf': 'wma', 'ogg': 'ogg',
};

function canonicalExtFromMime(contentType, fallback) {
    const sub = String(contentType).split('/')[1]?.split(';')[0]?.trim() || '';
    const table = String(contentType).startsWith('audio/') ? AUDIO_MIME_EXTS : VIDEO_MIME_EXTS;
    return table[sub] || fallback;
}

function sanitizeFileName(name) {
    const fallbackName = 'media';
    const cleanName = String(name || fallbackName)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();

    return cleanName || fallbackName;
}

/**
 * 定后缀。优先用渲染层给的 ext，其次从 URL 路径推断，最后回落 mp4。
 *
 * `'unknown'` 必须当作"没有提示"：嗅探的几条路径（页内脚本、AI 提取）在
 * 认不出后缀时都会显式写 'unknown'，那是**占位符不是后缀** ——
 * 照单全收会落出 `视频标题.unknown` 这种系统认不出类型的文件。
 */
function inferExtension(url, ext) {
    const hinted = String(ext || '').toLowerCase().replace(/^\./, '');
    if (hinted && hinted !== 'unknown') {
        return hinted;
    }

    try {
        const pathname = new URL(url).pathname;
        const matched = pathname.match(/\.([a-zA-Z0-9]+)$/);
        return matched ? matched[1].toLowerCase() : 'mp4';
    } catch (_error) {
        return 'mp4';
    }
}

function resolveDownloadTarget(title, ext) {
    const downloadsDir = app.getPath('downloads');
    const baseName = sanitizeFileName(title);
    const normalizedExt = inferExtension('', ext);
    let fileName = baseName;

    if (!fileName.toLowerCase().endsWith(`.${normalizedExt}`)) {
        fileName = `${fileName}.${normalizedExt}`;
    }

    let targetPath = path.join(downloadsDir, fileName);
    let counter = 1;

    while (fs.existsSync(targetPath)) {
        const parsed = path.parse(fileName);
        targetPath = path.join(downloadsDir, `${parsed.name}-${counter}${parsed.ext}`);
        counter += 1;
    }

    return targetPath;
}

function buildRequestHeaders(url, customReferer) {
    const headers = { ...MEDIA_HTTP_HEADERS };
    if (customReferer) {
        headers.Referer = customReferer;
    } else {
        try {
            headers.Referer = `${new URL(url).origin}/`;
        } catch (_error) {
            headers.Referer = '';
        }
    }
    return headers;
}

async function downloadDirectFile(url, filePath, customReferer, maxRedirects = 5, onProgress, handle) {
    if (maxRedirects <= 0) {
        throw new Error('下载失败：重定向次数过多。');
    }

    const transport = url.startsWith('https:') ? https : http;
    const headers = buildRequestHeaders(url, customReferer);

    return new Promise((resolve, reject) => {
        // 不传 agent：全局拦截（见文件末尾「全局网络层」）已把 http/https 的
        // globalAgent 换成隧道 agent，这里照常写就是走代理的。
        const request = transport.get(url, { headers }, async (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                try {
                    const redirectUrl = new URL(res.headers.location, url).toString();
                    await downloadDirectFile(redirectUrl, filePath, customReferer, maxRedirects - 1, onProgress, handle);
                    resolve();
                } catch (redirectError) {
                    reject(redirectError);
                }
                return;
            }

            if (!res.statusCode || res.statusCode >= 400) {
                res.resume();
                reject(new Error(`下载失败，HTTP 状态码 ${res.statusCode || '未知'}`));
                return;
            }

            // 直链没有"时长"概念，只有字节数。Content-Length 缺失（分块传输）时
            // 总长为 0，界面据此显示"已下载 X MB"的不定进度，而不是假的百分比。
            const totalBytes = Number(res.headers['content-length']) || 0;
            let receivedBytes = 0;

            res.on('data', (chunk) => {
                receivedBytes += chunk.length;
                if (typeof onProgress === 'function') {
                    onProgress({
                        url,
                        percent: totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : null,
                        receivedBytes,
                        totalBytes,
                        processedSeconds: 0,
                        totalSeconds: 0,
                        speed: 0,
                        skippedSegments: 0,
                        status: 'downloading',
                    });
                }
            });

            try {
                await pipeline(res, createWriteStream(filePath));
                resolve();
            } catch (pipeError) {
                reject(pipeError);
            }
        });

        request.on('error', reject);
        // 交给取消逻辑持有：destroy 需要拿到请求引用
        if (handle) handle.request = request;
        // 无超时保护时，僵尸连接会让下载永远挂起；30s 无响应直接失败
        request.setTimeout(30000, () => {
            request.destroy(new Error('下载超时：30s 内服务器无响应。'));
        });
    });
}

async function downloadWithFfmpeg(url, filePath, customReferer, onProgress, handle) {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        throw new Error('未找到项目内 ffmpeg，请重新安装依赖后再试。');
    }

    return new Promise((resolve, reject) => {
        const headers = buildRequestHeaders(url, customReferer);
        const headerArgs = [];

        if (headers['User-Agent']) {
            headerArgs.push('-user_agent', headers['User-Agent']);
        }

        if (headers.Referer) {
            headerArgs.push('-headers', `Referer: ${headers.Referer}\r\n`);
        }

        // ffmpeg 是独立进程，拿不到 Node 的 agent，必须另行走代理。
        // 它只认 HTTP 代理（不支持 SOCKS5），所以仅当当前生效的是 http 代理时才注入：
        // 注入 socks5:// 会让 ffmpeg 直接报协议不支持，比不走代理还糟。
        // 直连（未配代理）或 SOCKS5 时保持原样——至少不会把本来能下的搞坏。
        const proxyArgs = [];
        const appliedProtocol = getAcgmhoProxyProtocol();
        const appliedProxy = getAcgmhoProxy();
        if (appliedProxy && appliedProtocol === 'http') {
            proxyArgs.push('-http_proxy', `http://${appliedProxy}`);
        }

        const ffmpegArgs = [
            '-y',
            ...headerArgs,
            ...proxyArgs,
            // 进度行走 stdout（pipe:1），与 stderr 的诊断日志分开：
            // stdout 只有 key=value 机器可读行，不会被 ffmpeg 的横幅/警告污染
            '-progress',
            'pipe:1',
            '-i',
            url,
            '-c',
            'copy',
            filePath,
        ];

        const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
            windowsHide: true,
            // stdout 现在承载进度行，不能再 ignore
            stdio: ['ignore', 'pipe', 'pipe'],
            // 双保险：ffmpeg 的部分组件读环境变量而非命令行参数
            env: {
                ...process.env,
                ...(appliedProxy && appliedProtocol === 'http'
                    ? { http_proxy: `http://${appliedProxy}`, HTTP_PROXY: `http://${appliedProxy}` }
                    : {}),
            },
        });

        // ffmpeg 遇到源站缺失的分片（HLS 404）会自己重试几次，然后打印
        //   [hls] Segment 15 of playlist 0 failed too many times, skipping
        // 并继续下一个分片，最终退出码仍是 0。也就是说"跳过"它本来就做，
        // 缺的是**让用户知道少了东西** —— 否则一份缺了 700 段的残片会被
        // 当成"下载完成"。
        //
        // 两个缓冲各司其职：
        //  - stderrTail 只为失败时报错取末尾几行，封顶以免长片把 stderr 全攒在内存里；
        //  - stderrCarry 只为跨 chunk 的匹配拼接。若拿 stderrTail 兼做拼接，
        //    截断会把已经数过的匹配挤出去，下一次又数一遍（或漏数）。
        const SKIP_MARK = 'failed too many times, skipping';
        const STDERR_TAIL_MAX = 8000;
        let stderrTail = '';
        let stderrCarry = '';
        let skippedSegments = 0;
        // ffmpeg 只在开头打一次 "Duration: 00:36:50.88"，而进度行在 stdout、
        // 两者不同步。记下来供每次进度计算百分比用；没有它就只能报"已下载 X MB"。
        let totalSeconds = 0;
        const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

        ffmpeg.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX);

            if (!totalSeconds) {
                const dm = text.match(DURATION_RE);
                if (dm) {
                    totalSeconds = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]);
                }
            }

            // 数 combined 里的、减去 carry 里已有的（那些上一轮已经计入）。
            // carry 是上一轮 combined 的后缀，其中的完整匹配必然已数过；
            // 被 chunk 边界切断的那一条只在 combined 里完整，正好补上。
            const combined = stderrCarry + text;
            const countIn = (s) => s.split(SKIP_MARK).length - 1;
            skippedSegments += countIn(combined) - countIn(stderrCarry);
            stderrCarry = combined.slice(-(SKIP_MARK.length * 2));
        });

        // 交给取消逻辑持有：kill 需要拿到子进程引用
        if (handle) handle.child = ffmpeg;

        // ffmpeg 的 -progress 以 key=value 行成块输出，每块以 progress=continue|end 收尾。
        // 攒到一块结束再算一次，避免半块数据（有 out_time_ms 没 total_size）算出跳变的百分比。
        let progressChunk = '';
        const emitProgress = (patch) => {
            if (typeof onProgress === 'function') {
                onProgress({
                    url,
                    percent: null,
                    receivedBytes: 0,
                    totalBytes: 0,
                    processedSeconds: 0,
                    totalSeconds,
                    speed: 0,
                    skippedSegments,
                    ...patch,
                });
            }
        };

        ffmpeg.stdout.on('data', (chunk) => {
            progressChunk += chunk.toString();
            const lines = progressChunk.split('\n');
            // 最后一段可能被切断，留到下一轮
            progressChunk = lines.pop() || '';

            let processedSeconds = 0;
            let receivedBytes = 0;
            let speed = 0;
            let sawBlockEnd = false;

            for (const line of lines) {
                const eq = line.indexOf('=');
                if (eq <= 0) continue;
                const key = line.slice(0, eq).trim();
                const value = line.slice(eq + 1).trim();
                if (key === 'out_time_ms') {
                    // 单位是微秒（ffmpeg 历史命名遗留），不是毫秒
                    const us = Number(value);
                    if (Number.isFinite(us) && us > 0) processedSeconds = us / 1e6;
                } else if (key === 'total_size') {
                    const n = Number(value);
                    if (Number.isFinite(n) && n > 0) receivedBytes = n;
                } else if (key === 'speed') {
                    const n = parseFloat(value);
                    if (Number.isFinite(n)) speed = n;
                } else if (key === 'progress') {
                    sawBlockEnd = true;
                }
            }

            if (!sawBlockEnd) return;
            const percent =
                totalSeconds > 0 && processedSeconds > 0
                    ? Math.min(100, Math.round((processedSeconds / totalSeconds) * 100))
                    : null;
            emitProgress({
                percent,
                receivedBytes,
                processedSeconds,
                speed,
                status: 'downloading',
            });
        });

        ffmpeg.on('error', (error) => {
            if (error && error.code === 'ENOENT') {
                reject(new Error('项目内 ffmpeg 不存在或不可执行，请重新安装依赖。'));
                return;
            }

            reject(new Error(`无法启动 ffmpeg：${error.message}`));
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve({ skippedSegments });
                return;
            }

            const reason = stderrTail.trim().split('\n').slice(-3).join(' ');
            reject(new Error(reason || `ffmpeg 执行失败，退出码 ${code}`));
        });
    });
}

/**
 * 正在进行的媒体下载：url -> { cancel, filePath }。
 *
 * 用 Map 而不是单个变量：嗅探列表里可以连着点几条不同的资源，
 * 单变量会让后一条把前一条的记录顶掉，前一条就再也取消不了。
 */
const activeMediaDownloads = new Map();

function sendMediaDownloadProgress(progress) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('media-download-progress', progress);
    }
}

async function handleMediaDownload(_event, payload) {
    const url = payload?.url;
    const ext = inferExtension(url, payload?.ext);
    const title = payload?.title || 'media';
    const referer = payload?.referer || '';

    if (!url) {
        return { success: false, message: '下载失败：缺少资源地址。' };
    }

    // 走不走 ffmpeg：**后缀与渲染层判定的类型，任一为 stream 即走**。
    // 与 utils.requiresFfmpeg 同判据（那边是唯一真值，这里是派生副本）。
    //
    // 两个都要看，各自补对方的漏：
    //  - 只看后缀会漏：AI 提取出的地址常常没有可辨识的路径后缀
    //    （`/api/play?format=hls`），ext 回落到 mp4，但渲染层已按 type='stream'
    //    打了「ffmpeg 下载」徽章、并在 ffmpeg 缺失时拦住了下载；
    //  - 只看 type 会漏：`{"url":"...x.flv","type":"video"}` 这种模型产物，
    //    类型与后缀不自洽，而后缀才是真正决定能不能直存的东西。
    // 两边判据不一致的后果是"界面说要 ffmpeg、实际裸 HTTP 直存" ——
    // 落盘的 .mp4 里装的是 m3u8 文本，播放器打开是黑的。
    const isStream = STREAM_EXTENSIONS.has(ext) || payload?.type === 'stream';

    // 流媒体一律落成 .mp4：ffmpeg 的 -c copy 出来的是 MP4 容器，
    // 按源后缀命名（.ts / .m3u8）会让系统与播放器都认不出类型
    const targetPath = resolveDownloadTarget(title, isStream ? 'mp4' : ext);

    // 同一条资源重复点：把上一次的先取消，避免两个进程往同一个文件写
    const existing = activeMediaDownloads.get(url);
    if (existing) {
        existing.cancel();
    }

    let cancelled = false;
    const cancelledError = () => {
        const err = new Error('已取消下载');
        err.cancelled = true;
        return err;
    };

    // 节流：媒体进度对象用 receivedBytes，且只按时间窗合并（不设字节阈值，
    // 否则 ffmpeg 那种几百 KB 一跳的进度会被字节差条件整帧吞掉）
    const pushProgress = throttleProgress(sendMediaDownloadProgress, 250, 0, (p) => Number(p?.receivedBytes) || 0);

    const handle = {
        filePath: targetPath,
        cancel: () => {
            cancelled = true;
            if (handle.child && !handle.child.killed) {
                // ffmpeg 是独立进程，kill 掉即停；它自己不会清理半成品文件
                try { handle.child.kill(); } catch (_e) { /* 进程可能已退出 */ }
            }
            if (handle.request && !handle.request.destroyed) {
                try { handle.request.destroy(cancelledError()); } catch (_e) { /* 同上 */ }
            }
        },
        child: null,
        request: null,
    };
    activeMediaDownloads.set(url, handle);

    const onProgress = (p) => {
        if (cancelled) return;
        pushProgress({ ...p, url });
    };

    pushProgress({
        url,
        percent: null,
        receivedBytes: 0,
        totalBytes: 0,
        processedSeconds: 0,
        totalSeconds: 0,
        speed: 0,
        skippedSegments: 0,
        status: 'starting',
    });

    try {
        if (isStream) {
            const { skippedSegments } = await downloadWithFfmpeg(url, targetPath, referer, onProgress, handle);
            // 跳过分片时仍算成功（文件确实下下来了），但要如实说明缺了内容 ——
            // 否则用户拿到一份缺 700 段的残片，却看到"已下载完成"
            const done = {
                url,
                percent: 100,
                receivedBytes: 0,
                totalBytes: 0,
                processedSeconds: 0,
                totalSeconds: 0,
                speed: 0,
                skippedSegments,
                status: 'completed',
            };
            pushProgress(done);
            if (skippedSegments > 0) {
                return {
                    success: true,
                    message: `已通过 ffmpeg 下载到 ${targetPath}`,
                    filePath: targetPath,
                    skippedSegments,
                    warning: `源站有 ${skippedSegments} 个分片已失效，已跳过。该文件缺少这部分内容。`,
                };
            }
            return {
                success: true,
                message: `已通过 ffmpeg 下载到 ${targetPath}`,
                filePath: targetPath,
            };
        }

        await downloadDirectFile(url, targetPath, referer, 5, onProgress, handle);
        pushProgress({
            url,
            percent: 100,
            receivedBytes: 0,
            totalBytes: 0,
            processedSeconds: 0,
            totalSeconds: 0,
            speed: 0,
            skippedSegments: 0,
            status: 'completed',
        });
        return {
            success: true,
            message: `下载完成：${targetPath}`,
            filePath: targetPath,
        };
    } catch (error) {
        // 半成品一律删掉：留着会让用户以为"下过了"，实际是坏的。
        // 取消与失败同等对待 —— 两者产出的都是不完整文件。
        //
        // 例外：**被顶替**且**目标路径相同**的本轮不能删。同 URL 再次点击会先取消
        // 旧任务、再起新任务；旧任务还没建出文件时 resolveDownloadTarget 查不到重名，
        // 两次会算出同一个路径。旧任务此刻删文件，删掉的正是新任务正在写的那个 ——
        // 表现为"下载完成但文件不见了"。路径不同则各删各的，互不影响。
        const owner = activeMediaDownloads.get(url);
        const supersededSameTarget = owner !== handle && owner?.filePath === targetPath;
        if (!supersededSameTarget && fs.existsSync(targetPath)) {
            try { fs.unlinkSync(targetPath); } catch (_e) { /* 文件可能已被 ffmpeg 释放 */ }
        }

        const wasCancelled = cancelled || (error && error.cancelled);
        pushProgress({
            url,
            percent: null,
            receivedBytes: 0,
            totalBytes: 0,
            processedSeconds: 0,
            totalSeconds: 0,
            speed: 0,
            skippedSegments: 0,
            status: wasCancelled ? 'cancelled' : 'error',
        });

        return {
            success: false,
            cancelled: wasCancelled,
            message: wasCancelled
                ? '已取消下载，未完成的文件已删除。'
                : (error instanceof Error ? error.message : '下载失败'),
        };
    } finally {
        // 只清自己这一条：同 URL 再次点击会先取消旧任务、再把新 handle 写进同一个键，
        // 旧任务的 finally 晚一步执行，无条件 delete 会把**新任务**的登记抹掉。
        // 后果是新的下载再也取消不了（界面报"没有正在进行的下载"），
        // 且第三次点击因查不到 existing 而不再取消前一个 → 两个进程写同一个文件。
        // 与 acgmho-fetch-pages 的 finally 同款守卫（只清自己那一次）。
        if (activeMediaDownloads.get(url) === handle) {
            activeMediaDownloads.delete(url);
        }
    }
}

function cancelMediaDownload(url) {
    const handle = activeMediaDownloads.get(url);
    if (!handle) return { success: false, message: '该资源当前没有正在进行的下载。' };
    handle.cancel();
    return { success: true };
}


const activeGalleryTasks = new Set();
// gid -> runId：同画廊同时只跑一轮解析，新 run 顶掉旧 run，保证推送顺序不交错
// 键为 galleryTaskKey（prefix:gid），/h/123 与 /hentai/123 是两本不同的作品
const activeFetchRuns = new Map();

// 进度节流：图片分块每 chunk 推一次会洪水式刷 IPC（每秒数百条），
// 按 250ms/256KB 取大者透出，首尾包必达，保证进度条不断、界面不卡。
//
// bytesOf 可换：图集进度用 currentBytes，媒体下载用 receivedBytes。
// 不传就沿用 currentBytes —— 若让调用方各自去凑一个 currentBytes 字段，
// 就得往媒体进度对象里塞一个类型上没有的别名。
function throttleProgress(send, intervalMs = 250, minBytes = 256 * 1024, bytesOf) {
    const readBytes = bytesOf || ((p) => Number(p?.currentBytes) || 0);
    let lastAt = 0;
    let lastBytes = 0;
    let pending = null;
    let timer = null;
    const flush = () => {
        timer = null;
        if (!pending) return;
        const p = pending;
        pending = null;
        lastAt = Date.now();
        lastBytes = readBytes(p);
        send(p);
    };
    return (progress) => {
        const now = Date.now();
        const bytes = readBytes(progress);
        // completed/cancelled/error 收尾必达；file-done 携带单页本地 URL，
        // 渲染层凭它实时回写播放列表，同样不可节流合并
        const immediate = progress?.status === 'completed' || progress?.status === 'cancelled' || progress?.status === 'error' || progress?.status === 'file-done';
        if (immediate) {
            pending = null;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            lastAt = now;
            lastBytes = bytes;
            send(progress);
            return;
        }
        // minBytes > 0 才用字节差判定。传 0 会让 Math.abs(...) >= 0 恒真，
        // 节流等于完全失效（每 chunk 一条 IPC）—— 所以这里显式排除 0。
        const byteTriggered = minBytes > 0 && Math.abs(bytes - lastBytes) >= minBytes;
        if (now - lastAt >= intervalMs || byteTriggered) {
            pending = null;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            lastAt = now;
            lastBytes = bytes;
            send(progress);
            return;
        }
        pending = progress;
        if (!timer) timer = setTimeout(flush, intervalMs);
    };
}

// createWindow 在 macOS activate / 窗口重建时会再次执行，ipcMain.handle 重复注册会直接抛错。
// 三个业务 handler 集合幂等守卫：已注册则跳过，sniffer/tamper 另有自带去重。
let galleryHandlersReady = false;
let downloadHandlersReady = false;
let torrentHandlersReady = false;
let settingsHandlersReady = false;
let kbHandlersReady = false;
let edgeImportHandlersReady = false;

// 搜索限流冷却：站点对搜索接口限流（实测约 10 次连续请求触发，超限返回
// "搜索过于频繁"提示页，约 20s 后恢复；期间继续重试会不断刷新限流窗口）。
// 命中后客户端冷却 30s 直接挡下后续请求，避免"重试→继续限流→永远无结果"的恶性循环。
const SEARCH_RATE_LIMIT_COOLDOWN_MS = 30000;
let searchCooldownUntil = 0;

// 搜索会话 cookie：www 与 search 子域各取一份（含 cf_clearance），拼成 Cookie 头给 Node 直抓。
// 无痕/异常时返回空串，调用方回退裸访。
// 注意 search 优先：cf_clearance 按域签发、两边同名，去重只留一份；
// 403 恰恰发生在 search 子域，之前 www 优先会把 search 的凭证挤掉，
// 导致用户在浏览器里过了验证、直抓依然 403。
async function readSearchCookieHeader() {
    try {
        const { session } = require('electron');
        const sess = session.defaultSession;
        const groups = await Promise.all([
            sess.cookies.get({ url: 'https://search.acgmho.com/' }).catch(() => []),
            sess.cookies.get({ url: 'https://www.acgmho.com/' }).catch(() => []),
        ]);
        const seen = new Set();
        const parts = [];
        for (const c of groups.flat()) {
            if (!c || !c.name || seen.has(c.name)) continue;
            seen.add(c.name);
            parts.push(`${c.name}=${c.value}`);
        }
        return parts.join('; ');
    } catch (_cookieError) {
        return '';
    }
}

/**
 * 诊断时间线：搜索链路每步落一行，便于复现"窗口不弹/一直转圈"时定位卡点。
 *
 * 原实现有三个问题，都会让这份诊断在最需要它的时候失效：
 *
 * 1. **打包后根本写不进去**。路径曾是 `path.join(__dirname, '..', '.tmp-…log')`，
 *    而打包版 __dirname 在 `resources/app.asar` 内 —— asar 是只读归档，
 *    appendFileSync 必然抛错，被 catch 吞掉，日志静默地永远不存在。
 *    注释却写着"用户机器上复现时能直接看到卡在哪一步"，恰恰是唯一做不到的场景。
 *    改写到 `app.getPath('userData')`（可写、且不污染安装目录）。
 * 2. **无上限增长**。每次刷列表都追加若干行，长期使用会一直涨。
 *    超过上限就截断重来，只保留最近一段。
 * 3. **同步写盘挡在主进程上**。这是热路径（每次频道列表请求都会走），
 *    同步 I/O 会卡住整个主进程。改为异步 append，失败同样静默忽略。
 *
 * 默认只在未打包（开发）时启用；打包版需要显式设 THEPLAY_FLOW_LOG=1 才开，
 * 避免把用户磁盘当调试垃圾场。
 */
const FLOW_LOG_ENABLED = !app.isPackaged || process.env.THEPLAY_FLOW_LOG === '1';
const FLOW_LOG_MAX_BYTES = 2 * 1024 * 1024;

function flowLogPath() {
    try {
        return path.join(app.getPath('userData'), 'acgmho-flow.log');
    } catch (_e) {
        return null;   // userData 不可用时直接放弃诊断，不影响主流程
    }
}

function flowLog(...parts) {
    if (!FLOW_LOG_ENABLED) return;
    const target = flowLogPath();
    if (!target) return;
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
    try {
        // 超限先截断：诊断日志只关心最近一段，不做轮转文件
        try {
            if (fs.statSync(target).size > FLOW_LOG_MAX_BYTES) fs.writeFileSync(target, '');
        } catch (_e) { /* 文件不存在 = 无需截断 */ }
        fs.appendFile(target, line, () => { /* 异步写，失败静默 */ });
    } catch (_e) { /* ignore */ }
}

// 代理走不走、走哪个端口，完全由设置里的「代理端口」决定（见 electron/settings.js）：
// - 留空 = 一律直连，不读系统代理、不做任何探测（Proton VPN 这类 TUN 模式 VPN
//   在网卡层接管流量，直连本身就是被代理着的，再去连本地 HTTP 端口只会 ECONNREFUSED）；
// - 有值 = 用该端口走隧道（HTTP CONNECT 或 SOCKS5，服务层自动识别）。
//
// 两条出站链路都要配，缺一条就会出现"列表能刷出来、点进去白屏"这类半通不通：
// 1. Node 侧（acgmhoService 的 https.get）—— 抓列表、探测详情、抓页、下图；
// 2. Chromium 侧（session）—— 应用内浏览器打开的 ACG 页面、以及过 Cloudflare
//    挑战用的自动求解窗口。Chromium 不读 Node 的 agent，必须单独 setProxy。
async function syncAcgmhoProxy() {
    const { session } = require('electron');
    const configured = getSettings().proxyPort;

    // 第一步是**关键路径**：代理没配上，后面全都白搭。
    // 它单独 try：任何后续步骤（会话代理、UA 同步）的失败都不该连累这一步。
    let applied;
    try {
        applied = await setAcgmhoProxy(configured || null);
    } catch (e) {
        // 只在这里回落直连：setProxy 自己失败说明端点真的用不了。
        // 注意 setProxy 内部已把"端口连不上"表达为 probeFailed 而非抛错，
        // 所以走到这里是真的异常，不是用户填错端口。
        flowLog('proxy=', `${configured || 'DIRECT'} 配置失败：${(e && e.message) || e}`);
        await setAcgmhoProxy(null);
        return;
    }

    if (configured && applied && applied.probeFailed) {
        flowLog('proxy=', `${configured} 端口不可用，已回落直连（请在设置中检查代理端口）`);
    }

    // 第二步起都是**尽力而为**：失败只记日志，绝不动已经建好的隧道。
    // 曾经这里是一个大 try，catch 里无条件 setAcgmhoProxy(null)——
    // 于是 UA 同步里一个 ReferenceError 就把刚建好的代理清成直连，
    // 界面显示"端口连不上"，而端口其实是好的，排查方向被彻底带偏。
    try {
        await applySessionProxy(configured, applied);
    } catch (e) {
        flowLog('proxy=', `会话代理配置失败：${(e && e.message) || e}`);
    }
    try {
        // UA 与真实浏览器会话对齐（cf_clearance 与 UA 绑定）
        setUserAgent(session.defaultSession.getUserAgent());
    } catch (e) {
        flowLog('ua=', `UA 同步失败：${(e && e.message) || e}`);
    }
}

/**
 * 把代理配置推给 Chromium 会话。
 *
 * bypass 规则是必须的，不是优化：默认会话同时承载渲染层，而本地服务全在环回上——
 * AI 网关 127.0.0.1:7863、开发态 Vite 的 localhost:5173。一旦这些流量被送进代理，
 * 表现是"开了代理之后 AI 全挂、开发页打不开"，且原因极难定位（代理软件通常不认环回）。
 *
 * 注意不要写 `<-loopback>`：那个标记的含义是"解除 Chromium 对环回的隐式绕过"，
 * 加进来等于强制把本地流量也塞给代理，与这里的意图正好相反（实测 loopback 会解析成
 * SOCKS5 而非 DIRECT）。环回默认就是直连的，这里只需显式列出本机地址即可。
 *
 * 协议直接透传：Chromium 原生支持 socks5:// 与 http:// 两种 proxyRules。
 * 探测出的协议优先于用户书写形式——裸端口时用户没写协议，靠探测结果才知道该用哪种。
 */
async function applySessionProxy(configured, applied) {
    const { session } = require('electron');
    const ses = session.defaultSession;
    const BYPASS = 'localhost;127.0.0.1;[::1]';
    if (!configured || !applied || !applied.applied) {
        // 直连：清掉此前可能设过的代理，否则改了配置重启后仍走旧代理
        await ses.setProxy({ mode: 'direct' });
        return;
    }
    const parsed = parseProxyAddressForChromium(configured);
    if (!parsed) {
        await ses.setProxy({ mode: 'direct' });
        return;
    }
    const protocol = applied.protocol || parsed.protocol || 'http';
    await ses.setProxy({
        proxyRules: `${protocol}://${parsed.host}:${parsed.port}`,
        proxyBypassRules: BYPASS,
    });
}

// 从用户书写的地址里取 host/port/协议，供 Chromium 使用。
// 这里只做"拆解"，校验已由 settings.normalizeProxyInput 完成。
function parseProxyAddressForChromium(value) {
    let s = String(value || '').trim();
    if (!s) return null;
    let protocol = '';
    const schemeMatch = s.match(/^(socks5h?|socks|https?):\/\//i);
    if (schemeMatch) {
        const raw = schemeMatch[1].toLowerCase();
        protocol = raw === 'http' || raw === 'https' ? 'http' : 'socks5';
        s = s.slice(schemeMatch[0].length);
    }
    // 凭据段：Chromium 的 proxyRules 不支持内联用户名密码，这里剥掉再拼
    // （带认证的本地代理极少见；剥掉至少能连通，不至于因为一串凭据整条链路失效）
    const at = s.lastIndexOf('@');
    if (at > 0) s = s.slice(at + 1);
    const idx = s.lastIndexOf(':');
    if (idx <= 0) return null;
    const host = s.slice(0, idx).replace(/^\[|\]$/g, '');
    const port = Number(s.slice(idx + 1));
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host, port, protocol };
}

// 浏览器兜底串行化：Cloudflare 对并发挑战敏感，同时只过一个，后到的排队。
let browserSearchTail = Promise.resolve();
function loadSearchPageViaBrowser(url) {
    const run = browserSearchTail.then(() => loadSearchPageViaBrowserOnce(url));
    // 链不断：某次失败不影响排队中的下一次
    browserSearchTail = run.catch(() => { });
    return run;
}

// 全文搜索被 Cloudflare 挑战拦下时的兜底：交给自动求解器（可见小窗，无需用户操作）。
// 挑战能否通过取决于浏览器指纹是否真实一致：会话 UA 在 ready 时就覆写成内核派生值
// （见 electron/userAgent.js），Client Hints 交回 Chromium 自己发，
// 所以这个窗口的 UA 头 / navigator / sec-ch-ua 三处天然同源，且与 Node 直抓用的是同一个值。
// 通过后 cf_clearance 落在会话里，Node 直抓（走代理 + 同 UA）即可复用。
async function loadSearchPageViaBrowserOnce(url) {
    const { html, finalUrl, userAgent } = await solveChallengeWithBrowser({
        url,
        isChallengePage: isCloudflareChallengePage,
        isErrorPage: isCloudflareErrorPage,
        log: (msg) => {
            console.log('[cf-auto]', msg);
            flowLog('[solver]', msg);
        },
    });
    if (userAgent) setUserAgent(userAgent);
    return { html, finalUrl };
}

function setupGalleryHandlers() {
    if (galleryHandlersReady) return;
    galleryHandlersReady = true;
    ipcMain.handle('acgmho-probe', async (_event, gidOrUrl) => {
        try {
            await syncAcgmhoProxy();
            return await probeGallery(gidOrUrl);
        } catch (error) {
            console.error('acgmho-probe failed:', error);
            throw new Error(error.message || '探测失败');
        }
    });

    // 内置浏览画廊：频道表（静态）与频道列表（分页抓取）
    ipcMain.handle('acgmho-channels', async () => GALLERY_CHANNELS);

    ipcMain.handle('acgmho-channel-list', async (_event, options) => {
        const opts = options || {};
        const q = String(opts.query || '').trim();
        const isSearch = opts.channelId === 'search' || !!q;
        if (isSearch && Date.now() < searchCooldownUntil) {
            const waitSec = Math.ceil((searchCooldownUntil - Date.now()) / 1000);
            return {
                success: false,
                message: `站点提示：搜索过于频繁，请 ${waitSec} 秒后重试（不必更换关键词）`,
                items: [],
                hasMore: false,
            };
        }
        try {
            flowLog('channel-list start', JSON.stringify({ channelId: opts.channelId, q, page: opts.page || 1 }));
            // 全文搜索会 302 到 search.acgmho.com，其前有 Cloudflare 挑战：
            // 先带上 Electron 会话 cookie（含 cf_clearance）直抓，能过则过。
            await syncAcgmhoProxy();
            const cookieHeader = await readSearchCookieHeader();
            flowLog('proxy=', getAcgmhoProxy() || 'DIRECT', '| cookies=', cookieHeader ? cookieHeader.split('; ').map((p) => p.split('=')[0]).join(',') : '(none)');
            const directStartedAt = Date.now();
            const directPromise = fetchChannelList({ ...opts, cookieHeader: cookieHeader || undefined });
            // 直抓是快路，不能卡住整个搜索：搜索请求给 20s 预算，超时即转入内置浏览器自动过挑战。
            // 抛出的文案要能被下面的 netOrChallenge 识别（Timeout fetching）才会触发兜底。
            const listResult = isSearch
                ? await Promise.race([
                    directPromise,
                    new Promise((_resolve, reject) => {
                        setTimeout(() => reject(new Error('Timeout fetching 搜索页直抓（20s 预算）')), 20000);
                    }),
                ])
                : await directPromise;
            flowLog('direct ok ms=', Date.now() - directStartedAt, 'items=', (listResult.items || []).length);
            return { success: true, ...listResult };
        } catch (error) {
            // 直抓被挑战拦下或网络层失败（代理环境直连必挂 ETIMEDOUT/ECONNRESET）→
            // 真浏览器窗口加载同一 URL：过了挑战就返回结果（clearance 同时进会话，
            // 之后直抓恢复）；过不了就如实报"验证未通过"，不再把挑战页当结果解析成 0 条。
            const message = (error && error.message) || '列表加载失败';
            if (isSearch && /过于频繁/.test(message)) {
                searchCooldownUntil = Date.now() + SEARCH_RATE_LIMIT_COOLDOWN_MS;
            }
            const netOrChallenge = /验证|挑战|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|Timeout fetching/i.test(message);
            flowLog('direct fail:', message, '| netOrChallenge=', netOrChallenge);
            if (isSearch && netOrChallenge) {
                try {
                    const page = Math.max(1, Number(opts.page) || 1);
                    const url = page > 1 && opts.baseUrl
                        ? deriveListPageUrl(opts.baseUrl, page)
                        : channelListUrl('search', page, q);
                    flowLog('fallback solver start', url);
                    const { html, finalUrl } = await loadSearchPageViaBrowser(url);
                    const built = buildChannelListResult({
                        channelId: opts.channelId || 'search',
                        page,
                        query: q,
                        html,
                        finalUrl,
                    });
                    flowLog('fallback ok items=', built.items.length, 'htmlLen=', html.length, 'finalUrl=', finalUrl);
                    return { success: true, ...built };
                } catch (fallbackError) {
                    console.error('acgmho-channel-list browser fallback failed:', fallbackError);
                    flowLog('fallback fail:', (fallbackError && fallbackError.message) || 'unknown');
                    // 兜底失败时透出兜底原因（如挑战未完成/网络阻断验证域名），
                    // 比直抓阶段的 403 翻译更贴近实际发生了什么。
                    return {
                        success: false,
                        message: (fallbackError && fallbackError.message) || message,
                        items: [],
                        hasMore: false,
                    };
                }
            }
            console.error('acgmho-channel-list failed:', error);
            flowLog('channel-list fail (no fallback):', message);
            return { success: false, message, items: [], hasMore: false };
        }
    });

    ipcMain.handle('acgmho-start-download', async (_event, options) => {
        // 任务键带前缀（prefix:gid）：/h/123 与 /hentai/123 是两本不同的作品，纯数字键会互顶/误取消
        const opts = options || {};
        if (!opts.gidOrUrl) throw new Error('缺少作品地址或 ID，无法开始下载');
        const key = galleryTaskKey(opts.gidOrUrl, opts.probe) || String(opts.gidOrUrl);
        // 每轮带唯一 runToken：isCancelled 必须凭"本轮是否仍登记在册"判断，
        // 只比对 key 会被同作品的下一轮任务重新登记而永远为真——旧任务停不下来，
        // 两轮并发写同一目录（实测 30 页发出 54 次图片请求、manifest/.gallery 互盖）。
        const runToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const runKey = `${key}#${runToken}`;
        // 同作品互顶：开新下载先清掉同键的旧下载/旧落盘（落盘键为 key#runToken，base 相同）
        for (const t of [...activeGalleryTasks]) {
            if (t.split('#')[0] === key) activeGalleryTasks.delete(t);
        }
        activeGalleryTasks.add(runKey);
        try {
            await syncAcgmhoProxy();
            const downloadOptions = {
                ...opts,
                // 不在这里拼默认目录：服务层探测出真实前缀后按 <prefix>-<gid> 落盘。
                // 此处硬拼纯 gid 会把 /h/123 与 /hentai/123 写进同一目录互踩；
                // 调用方给了 outDir 则原样透传。
                outDir: opts.outDir || undefined,
            };
            const send = throttleProgress((progress) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('acgmho-progress', progress);
                }
            });
            const result = await downloadGallery(
                downloadOptions,
                send,
                // 服务层回传数字 gid：只要本轮已被顶掉/取消（runKey 不在册）就停
                () => !activeGalleryTasks.has(runKey)
            );
            activeGalleryTasks.delete(runKey);
            return result;
        } catch (error) {
            activeGalleryTasks.delete(runKey);
            console.error('acgmho-start-download failed:', error);
            throw error;
        }
    });

    ipcMain.handle('acgmho-cancel-download', async (_event, gid) => {
        // 粗粒度取消：凡同数字 gid（含各前缀变体）一律清掉，避免误留孤儿任务
        for (const t of [...activeGalleryTasks]) {
            if (galleryKeyMatches(t, gid)) activeGalleryTasks.delete(t);
        }
        return { success: true };
    });

    // 边下边播落盘：同作品单飞，新任务顶掉旧任务（旧循环在下一文件边界停）。
    // 与 acgmho-start-download 共用 activeGalleryTasks，保证同作品同时只有一个写盘任务。
    ipcMain.handle('acgmho-save-images', async (_event, options) => {
        const opts = options || {};
        const baseKey = galleryTaskKey(opts.gid || opts.gidOrUrl, opts) || String(opts.gid || opts.gidOrUrl || '');
        if (!baseKey) throw new Error('缺少作品 gid，无法开始保存');
        const key = normalizeGid(opts.gid || opts.gidOrUrl).gid || baseKey;
        const runToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const runKey = `${baseKey}#${runToken}`;
        // 顶掉同作品的旧任务（含旧式下载，base 相同即删）：旧循环下一次 isCancelled 检查即停
        for (const t of [...activeGalleryTasks]) {
            if (t.split('#')[0] === baseKey) activeGalleryTasks.delete(t);
        }
        activeGalleryTasks.add(runKey);
        try {
            await syncAcgmhoProxy();
            const saveOptions = {
                ...opts,
                gid: key,
                // 任务键透传：渲染层用 prefix:gid 区分同数字 gid 的不同作品，进度事件原样带回
                taskKey: opts.taskKey || baseKey,
                // 默认目录交给服务层按 <prefix>-<gid> 定（opts.prefix 已随 ...opts 透传），
                // 此处硬拼纯 gid 会把 /h/123 与 /hentai/123 写进同一目录互踩
                outDir: opts.outDir || undefined,
            };
            const send = throttleProgress((progress) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('acgmho-save-progress', progress);
                }
            });
            const result = await saveGalleryImages(
                saveOptions,
                send,
                (id) => String(id) === key && !activeGalleryTasks.has(runKey)
            );
            activeGalleryTasks.delete(runKey);
            return result;
        } catch (error) {
            activeGalleryTasks.delete(runKey);
            console.error('acgmho-save-images failed:', error);
            throw error;
        }
    });

    ipcMain.handle('acgmho-cancel-save-images', async (_event, gid) => {
        const key = String(gid || '');
        // 精确取消：带前缀的任务键只杀 exact base，纯数字 gid 才做同数字全清（兼容旧调用）
        const exact = key.includes(':') && !key.includes('#');
        for (const t of [...activeGalleryTasks]) {
            const base = t.split('#')[0];
            if (exact ? base === key : galleryKeyMatches(t, key)) activeGalleryTasks.delete(t);
        }
        return { success: true };
    });

    ipcMain.handle('acgmho-open-folder', async (_event, folderPath) => {
        if (folderPath && fs.existsSync(folderPath)) {
            await shell.openPath(folderPath);
            return { success: true };
        }
        return { success: false, message: '目录不存在' };
    });

    ipcMain.handle('acgmho-fetch-pages', async (_event, options) => {
        const opts = options || {};
        // 任务键带前缀（prefix:gid）：纯数字键会把同数字不同前缀的两个抓取任务互相顶掉
        const key = galleryTaskKey(opts.gidOrUrl, opts.probe) || String(opts.gidOrUrl || '');
        if (!key) throw new Error('缺少作品地址或 ID，无法开始解析');
        // 单飞：同作品开新 run 直接顶掉旧 run（旧循环在下一页边界停，
        // 且它的进度带旧 runId，渲染层会丢弃，不会再污染播放列表顺序）
        const runId = opts.runId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        activeFetchRuns.set(key, runId);
        try {
            await syncAcgmhoProxy();
            const result = await fetchGalleryPages(
                opts,
                (progress) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('acgmho-fetch-progress', { ...progress, runId });
                    }
                },
                // 服务层回传的是数字 gid，这里直接比对本轮闭包键，避免键格式耦合
                () => activeFetchRuns.get(key) !== runId
            );
            return { ...result, runId };
        } catch (error) {
            console.error('acgmho-fetch-pages failed:', error);
            throw error;
        } finally {
            // 只清自己的 key：别把后启动的新 run 误删了
            if (activeFetchRuns.get(key) === runId) activeFetchRuns.delete(key);
        }
    });

    ipcMain.handle('acgmho-cancel-fetch-pages', async (_event, gid, runId) => {
        const opts = typeof gid === 'object' && gid ? gid : { gidOrUrl: gid, runId };
        // 调用方多为纯数字 gid（无前缀）：扫描所有同数字 gid 的键，带 runId 只杀匹配者
        for (const [k, v] of [...activeFetchRuns]) {
            if (!galleryKeyMatches(k, opts.gidOrUrl)) continue;
            if (!opts.runId || v === opts.runId) activeFetchRuns.delete(k);
        }
        return { success: true };
    });
}

function setupDownloadHandlers() {
    if (downloadHandlersReady) return;
    downloadHandlersReady = true;
    ipcMain.handle('get-download-capabilities', async () => getDownloadCapabilities());
    ipcMain.handle('download-media', handleMediaDownload);
    ipcMain.handle('cancel-media-download', async (_event, url) => cancelMediaDownload(url));
    ipcMain.handle('gallery-save-pack', handleGalleryPackSave);
}

// 单文件包另存为（.gallery 画廊 ZIP / .aibook 绘本 JSON）：
// 渲染层已按各自规则组好字节，这里只弹对话框 + 落盘。
// 默认落下载目录、文件名取作品名，位置完全由用户定（不强制写项目根）。
// 后缀从 fileName 反推而不是新加参数：调用方本来就要给出带后缀的建议文件名，
// 再传一个 extension 字段只会制造「两者不一致时听谁的」这种歧义。
async function handleGalleryPackSave(event, payload) {
    try {
        const rawName = String(payload?.fileName || '未命名画廊.gallery');
        const isBook = /\.aibook$/i.test(rawName);
        const ext = isBook ? '.aibook' : '.gallery';
        const kindLabel = isBook ? '绘本' : '画廊';
        const safeName = sanitizeFileName(rawName.replace(/\.(gallery|aibook)$/i, '')) + ext;
        const data = payload?.data;
        if (!data || !(data instanceof ArrayBuffer) || data.byteLength === 0) {
            return { success: false, message: '保存失败：打包数据为空。' };
        }
        if (data.byteLength > 2 * 1024 * 1024 * 1024) {
            return { success: false, message: `保存失败：${kindLabel}包超过 2GB 上限。` };
        }
        const win = (event && event.sender && !event.sender.isDestroyed())
            ? BrowserWindow.fromWebContents(event.sender)
            : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined);
        const saveOpts = {
            title: isBook ? '保存为 .aibook 绘本文件' : '保存为 .gallery 画廊文件',
            defaultPath: path.join(app.getPath('downloads'), safeName),
            filters: isBook
                ? [{ name: 'AI 绘本', extensions: ['aibook'] }]
                : [{ name: '画廊文件', extensions: ['gallery'] }],
        };
        const { canceled, filePath } = win
            ? await dialog.showSaveDialog(win, saveOpts)
            : await dialog.showSaveDialog(saveOpts);
        if (canceled || !filePath) {
            return { success: false, cancelled: true, message: '已取消保存。' };
        }
        const target = filePath.toLowerCase().endsWith(ext) ? filePath : `${filePath}${ext}`;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(data));
        return { success: true, filePath: target, message: `已保存：${target}` };
    } catch (error) {
        console.error('gallery-save-pack failed:', error);
        return { success: false, message: error instanceof Error ? error.message : '保存失败' };
    }
}

/* -------------------------------------------------------------------------- */
/*                          内置 BT 下载引擎（webtorrent v3）                    */
/* -------------------------------------------------------------------------- */
/*
 * 为什么引擎整个写在 main.js 里、不拆文件：
 * 主进程内置 Node 18.18.2，**没有类型剥离能力**，require 一个 .ts 只会抛
 * "Unexpected token ':'"。而本项目约定 services/ 全 TS、electron/ 全 JS，
 * 所以「能共用的纯工具」写不成 TS，只能写 JS —— 那它就该待在 electron/ 里，
 * 没有理由为它单开一个文件。这里一次性放齐：纯工具在前，引擎在后。
 *
 * webtorrent v3 是纯 ESM（含顶层 await），顶层 require 会抛
 * ERR_REQUIRE_ASYNC_MODULE，因此用动态 import() 懒加载。
 */

/* ------------------------------ 纯工具（无状态） ------------------------------ */

/**
 * 公共 Tracker 大表（udp + http + wss 三栖）：
 * - 旧实现只有 6 个 udp tracker，其中 1~2 个常年失联，找 peer 全靠运气；
 * - http(s) 走 80/443，在 UDP 被墙/运营商 QoS 的网络下是救命通道；
 * - wss 在 Node 主进程同样可用（bittorrent-tracker 内置 ws client），公司网/校园网常只剩它能通。
 * 无效 tracker 只会产生一次失败 announce，由 client 自行消化，不影响其它通道。
 */
const DEFAULT_TRACKERS = [
    // UDP 主力（含亚洲节点，moack 在韩，对国内直连质量最好的一批）
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://www.torrent.eu.org:451/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.tiny-vps.com:6969/announce',
    'udp://tracker1.bt.moack.co.kr:80/announce',
    'udp://tracker.bitsearch.to:1337/announce',
    'udp://explodie.org:6969/announce',
    'udp://tracker.empire-js.us:1337/announce',
    // HTTP(S)：UDP 被墙时的备用通道
    'http://tracker.opentrackr.org:1337/announce',
    'https://opentracker.i2p.rocks:443/announce',
    // WebSocket：在只剩 443 出站的苛刻网络下兜底
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.files.fm:7073/announce',
];

/**
 * DHT 启动节点：k-rpc 默认只有 router.bittorrent / router.utorrent /
 * dht.transmissionbt 三个 6881，传数组会整体替换默认（见 k-rpc toBootstrapArray），
 * 所以默认三个必须原样保留，再追加 libtorrent / BitComet / Vuze 系入口。
 * DHT 进网慢 = magnet 元数据慢 + DHT peer 来得慢，这是“磁链慢”头号原因。
 */
const DHT_BOOTSTRAP_NODES = [
    'router.bittorrent.com:6881',
    'router.utorrent.com:6881',
    'dht.transmissionbt.com:6881',
    'dht.libtorrent.org:25401',
    'router.bitcomet.com:6881',
    'dht.aelitis.com:6881',
];

/** 是否已是合法 magnet 链接（其余形态一律原样返回，不做猜测性改写） */
function isMagnet(input) {
    return typeof input === 'string' && input.startsWith('magnet:?');
}

/**
 * 给不带 tracker 的 magnet 补上公共 tracker。
 *
 * 为什么需要：不少站点给的磁链只有 xt，一个 tr 都没有。纯 DHT 找元数据可能
 * 几分钟不出结果，补上 tracker 后通常几秒内就有 peer。
 * 已有 tr 的磁链原样返回——站点自带 tracker 通常比公共表更贴近资源。
 */
function ensureMagnetTrackers(magnet) {
    if (!isMagnet(magnet)) return magnet;
    if (/([?&])tr=/.test(magnet)) return magnet;
    const extra = DEFAULT_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
    return `${magnet}${magnet.includes('?') ? '' : '?'}${extra}`;
}

/**
 * 从 magnet 或裸 btih 提取 info hash（小写）。提取不到返回空串。
 *
 * 只做十六进制归一：base32 形态的 btih（dmhy / animetosho 会给）在
 * services/SearchService/util.ts 里已有 base32ToHex 负责，这里不重复实现——
 * 重复实现就会有两套编码转换规则，迟早对不上。
 */
function magnetInfoHash(magnet) {
    const m = String(magnet || '').match(/btih:([a-zA-Z0-9]+)/i);
    return m ? m[1].toLowerCase() : '';
}

/**
 * 去重键：同一资源因 tracker 参数顺序不同会被认成两条，这里只取 btih。
 * 拿不到 btih 时退回整串，保证任何输入都有稳定的键。
 */
function magnetKey(magnet) {
    return magnetInfoHash(magnet) || String(magnet || '');
}

/**
 * 把任意标题清洗成合法的单层目录名。
 *
 * Windows 禁止 <>:"/\|?* 与控制字符；末尾的点和空格也会导致 mkdir 失败，
 * 所以一并去掉。截断到 100 字符避免超过路径长度上限。
 */
function sanitizeDirName(name) {
    const clean = String(name || 'torrent')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/[. ]+$/, '')
        .trim()
        .slice(0, 100);
    return clean || 'torrent';
}

/**
 * 按索引选下文件；不传索引 = 全下。
 *
 * 需要在 metadata 事件与添加后各调一次：元数据秒回（缓存 / 本地种子）时，
 * 监听器可能还没挂上，只调一次会导致“只想下一集，结果全下”。
 */
function applyFileSelection(torrent, wantedIndexes) {
    if (!Array.isArray(wantedIndexes) || wantedIndexes.length === 0) return;
    if (!torrent || !torrent.files) return;
    const want = new Set(wantedIndexes);
    torrent.files.forEach((f, i) => {
        try {
            if (want.has(i)) f.select();
            else f.deselect();
        } catch (_e) { }
    });
}

/** 手动 peer 地址格式校验：只认 host:port，坏输入会把 swarm 搞崩 */
function isPeerAddress(addr) {
    return typeof addr === 'string' && /^[a-zA-Z0-9.-]+:\d{1,5}$/.test(addr.trim());
}

/* ------------------------------ 引擎（有状态） ------------------------------ */

/** 无元数据超时：DHT/tracker 全挂或纯本机模式无 peer 时，任务不能永远卡在 metadata */
const METADATA_TIMEOUT_MS = 90 * 1000;

let btClient = null;
/** client 正在创建时的共享 Promise，避免并发 start 造出多个实例 */
let btClientReady = null;
let btTaskSeq = 0;
/** taskId -> task record */
const btTasks = new Map();
/** 旧临时 id -> task record：rekey（tempId→infoHash）后旧 id 仍可操作，
 * 避免元数据到达前暂停/取消报"任务不存在" */
const btAliases = new Map();

async function loadWebTorrentCtor() {
    const mod = await import('webtorrent');
    return mod.default || mod.WebTorrent || mod;
}

function getBtClient() {
    if (btClient) return Promise.resolve(btClient);
    if (!btClientReady) {
        btClientReady = (async () => {
            const WebTorrent = await loadWebTorrentCtor();
            // THEPLAY_BT_LOCAL=1：纯本机联调模式，关闭一切对外发现（DHT/Tracker/LSD/uTP/UPnP），
            // 只走手动 addPeer，流量不出 loopback，不会触发 VPN/防火墙告警。
            const local = process.env.THEPLAY_BT_LOCAL === '1';
            const c = new WebTorrent(local ? {
                maxConns: 100,
                dht: false,
                tracker: false,
                lsd: false,
                utp: false,
                natUpnp: false,
            } : {
                // 找 peer 三板斧全开：
                // 1. tracker.announce：client 级默认 tracker，每个非私有种子自动追加
                //    （之前只靠 magnet 里那几个 tr，.torrent 文件起的任务一个都吃不到）；
                // 2. dht.bootstrap：6 入口代替默认 3 个，DHT 进网快一倍；
                // 3. maxConns 100→200：热门资源 peer 多时并行上得去（内存可忽略）。
                // LSD / PEX / UPnP / uTP 保持库默认开启，不动。
                maxConns: 200,
                tracker: { announce: DEFAULT_TRACKERS },
                dht: { bootstrap: DHT_BOOTSTRAP_NODES },
                // dhtPort 默认 0（随机端口），避免与本机其他 BT 客户端抢 6881
            });
            c.on('error', (err) => {
                // 全局错误只记录，具体任务错误走 torrent 'error' 事件
                console.error('[torrent] client error:', err && err.message);
            });
            return c;
        })();
        // 创建失败时清掉共享 Promise，允许下次调用重试而不是永远挂起
        btClientReady.then(
            (c) => { btClient = c; },
            () => { btClientReady = null; },
        );
    }
    return btClientReady;
}

/** 任务记录 → 可跨 IPC 传输的纯数据快照（不含 torrent 实例，无法结构化克隆） */
function btSnapshot(task) {
    const t = task.torrent;
    const files = (t.files || []).map((f, i) => ({ index: i, name: f.name, path: f.path, length: f.length }));
    return {
        id: task.id,
        name: t.name || task.nameHint || task.id,
        status: task.status,
        progress: t.progress || 0,
        downloaded: t.downloaded || 0,
        total: t.length || 0,
        downloadSpeed: t.downloadSpeed || 0,
        uploadSpeed: t.uploadSpeed || 0,
        numPeers: t.numPeers || 0,
        etaMs: t.timeRemaining || 0,
        files,
        outDir: task.outDir,
        error: task.error || '',
    };
}

/** 进度节流推送：下载事件每秒可触发几十次，逐次过 IPC 会打爆渲染层 */
function btEmit(task, onProgress, force = false) {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - (task.lastEmit || 0) < 900) return;
    task.lastEmit = now;
    try {
        onProgress(btSnapshot(task));
    } catch (_e) { }
}

/** 同名目录已有内容且不属于当前任务时，追加后缀避免两个任务写进同一目录互相覆盖 */
function btUniquifyOutDir(dir) {
    if (!fs.existsSync(dir)) return dir;
    try {
        const entries = fs.readdirSync(dir);
        if (entries.length === 0) return dir;
        for (const t of btTasks.values()) {
            if (t.outDir === dir) return dir;
        }
    } catch (_e) {
        return dir;
    }
    let i = 1;
    let candidate = `${dir}-${i}`;
    while (fs.existsSync(candidate)) {
        i += 1;
        candidate = `${dir}-${i}`;
    }
    return candidate;
}

function btGuessTempId(input) {
    btTaskSeq += 1;
    if (typeof input === 'string') {
        // 有 btih 就用它当临时 id：元数据到达前渲染层拿到的 id 已经是有意义的 hash，
        // 且与 rekey 后的正式 id 形态一致（base32 磁链也照用，rekey 时转 hex 并存别名）
        const hash = magnetInfoHash(input);
        if (hash) return hash;
    }
    return `task-${Date.now()}-${btTaskSeq}`;
}

function btFindTask(taskId) {
    if (btTasks.has(taskId)) return btTasks.get(taskId);
    if (btAliases.has(taskId)) return btAliases.get(taskId);
    const lower = String(taskId).toLowerCase();
    for (const [id, task] of btTasks) {
        if (id.toLowerCase() === lower) return task;
    }
    for (const [id, task] of btAliases) {
        if (id.toLowerCase() === lower) return task;
    }
    return null;
}

function btDropTask(task) {
    btTasks.delete(task.id);
    for (const [aliasId, t] of btAliases) {
        if (t === task) btAliases.delete(aliasId);
    }
    if (task.disarmMetadataTimer) {
        try { task.disarmMetadataTimer(); } catch (_e) { }
    }
}

/**
 * 开启下载任务。options: { magnet?, torrentPath?, torrentData?(Buffer), name?, outDir?, fileIndexes?, addPeers? }
 * fileIndexes 为空 = 全下；否则只下指定文件索引。
 * addPeers: 手动指定 peer（如 ['127.0.0.1:6881']），本机联调或 tracker 全挂时兜底。
 */
function startTorrent(options, onProgress) {
    return new Promise((resolve, reject) => {
        (async () => {
            const { magnet, torrentPath, torrentData, name, fileIndexes } = options || {};
            let torrentId = null;
            if (magnet) torrentId = ensureMagnetTrackers(magnet);
            else if (torrentPath) torrentId = torrentPath;
            else if (torrentData) torrentId = Buffer.isBuffer(torrentData) ? torrentData : Buffer.from(torrentData);
            if (!torrentId) {
                throw new Error('缺少 magnet / torrentPath / torrentData');
            }

            const c = await getBtClient();
            // 去重：同一 magnet / 种子文件重复点“下载”时直接返回既有任务，
            // 否则 c.add 会抛 "torrent is already in the client"
            const sourceKey = magnet ? `magnet:${magnetKey(magnet)}` : `path:${torrentPath || ''}`;
            for (const t of btTasks.values()) {
                if (t.sourceKey && t.sourceKey === sourceKey) {
                    resolve({ taskId: t.id, outDir: t.outDir, duplicate: true });
                    return;
                }
            }
            if (magnet) {
                try {
                    const existing = c.get(torrentId);
                    if (existing) {
                        for (const t of btTasks.values()) {
                            if (t.torrent === existing) {
                                resolve({ taskId: t.id, outDir: t.outDir, duplicate: true });
                                return;
                            }
                        }
                    }
                } catch (_e) { }
            }
            const outDirBase = options.outDir ||
                path.join(app.getPath('downloads'), 'the-play', 'bt', sanitizeDirName(name || btGuessTempId(magnet || '')));
            const outDir = btUniquifyOutDir(outDirBase);
            fs.mkdirSync(outDir, { recursive: true });

            let torrent;
            try {
                torrent = c.add(torrentId, { path: outDir });
            } catch (err) {
                // 并发双点导致的竞态去重：add 抛重复时回退到既有任务
                if (String((err && err.message) || err).toLowerCase().includes('already')) {
                    for (const t of btTasks.values()) {
                        if (t.sourceKey && t.sourceKey === sourceKey) {
                            resolve({ taskId: t.id, outDir: t.outDir, duplicate: true });
                            return;
                        }
                    }
                }
                throw err;
            }

            const tempId = btGuessTempId(magnet || '');
            const task = {
                id: tempId,
                torrent,
                outDir,
                sourceKey,
                nameHint: name || '',
                status: 'metadata',
                error: '',
                lastEmit: 0,
                wantedIndexes: Array.isArray(fileIndexes) ? fileIndexes : null,
                metadataTimer: null,
            };
            btTasks.set(tempId, task);

            const disarmMetadataTimer = () => {
                if (task.metadataTimer) {
                    clearTimeout(task.metadataTimer);
                    task.metadataTimer = null;
                }
            };
            const armMetadataTimer = () => {
                disarmMetadataTimer();
                task.metadataTimer = setTimeout(() => {
                    task.metadataTimer = null;
                    if (task.status === 'metadata') {
                        task.status = 'error';
                        task.error = '长时间未获取到种子元数据：可能无可用 peer / tracker 被墙 / 网络禁 P2P，换节点或稍后重试。';
                        btEmit(task, onProgress, true);
                    }
                }, METADATA_TIMEOUT_MS);
                if (task.metadataTimer.unref) task.metadataTimer.unref();
            };
            task.disarmMetadataTimer = disarmMetadataTimer;
            task.armMetadataTimer = armMetadataTimer;
            armMetadataTimer();

            // 手动 peer（本机联调 / 紧急直连）：只接受 host:port 字符串，防坏输入把 swarm 搞崩
            if (Array.isArray(options.addPeers)) {
                for (const addr of options.addPeers) {
                    if (!isPeerAddress(addr)) continue;
                    try {
                        torrent.addPeer(addr.trim());
                    } catch (_e) { }
                }
            }

            const rekey = (finalId) => {
                if (finalId && finalId !== task.id) {
                    // 保留旧 id 别名：渲染层手里的 tempId 在元数据到达前仍可暂停/取消
                    btAliases.set(task.id, task);
                    btTasks.delete(task.id);
                    task.id = finalId;
                    btTasks.set(finalId, task);
                }
            };

            torrent.on('infoHash', () => {
                if (torrent.infoHash) rekey(torrent.infoHash.toLowerCase());
                btEmit(task, onProgress, true);
            });

            torrent.on('metadata', () => {
                applyFileSelection(torrent, task.wantedIndexes);
                if (torrent.infoHash) rekey(torrent.infoHash.toLowerCase());
                task.status = 'downloading';
                disarmMetadataTimer();
                btEmit(task, onProgress, true);
            });

            torrent.on('download', () => {
                if (task.status !== 'downloading' && !torrent.done) task.status = 'downloading';
                btEmit(task, onProgress, false);
            });

            torrent.on('upload', () => btEmit(task, onProgress, false));

            torrent.on('done', () => {
                task.status = 'seeding';
                disarmMetadataTimer();
                btEmit(task, onProgress, true);
            });

            torrent.on('error', (err) => {
                task.status = 'error';
                task.error = (err && err.message) || String(err);
                disarmMetadataTimer();
                btEmit(task, onProgress, true);
            });

            torrent.on('noPeers', () => {
                // 仅提示一次：长时间无 peer 由调用方按 downloadSpeed==0 判断
                btEmit(task, onProgress, true);
            });

            // 本地种子/缓存导致元数据秒回时，metadata 事件可能抢跑；即时补一次选文件
            try {
                if (torrent.files && torrent.files.length > 0 && torrent.infoHash) {
                    applyFileSelection(torrent, task.wantedIndexes);
                    rekey(torrent.infoHash.toLowerCase());
                    task.status = 'downloading';
                    disarmMetadataTimer();
                }
            } catch (_e) { }

            btEmit(task, onProgress, true);
            // 若同步路径已 rekey（如缓存秒回），返回 task.id 而非过期 tempId
            resolve({ taskId: task.id, outDir });
        })().catch(reject);
    });
}

/** 取消任务。deleteFiles 仅删除未完成分片：已完工（done）任务默认保留文件，
 * 否则任务列表里点一下“删除”就把下好的正片一起扬了。 */
function cancelTorrent(taskId, deleteFiles = true) {
    return new Promise((resolve) => {
        (async () => {
            const task = btFindTask(taskId);
            if (!task) {
                resolve({ success: false, message: '任务不存在' });
                return;
            }
            const c = await getBtClient();
            // 已完成任务：destroyStore 会连正片一起删，必须强制 false
            const destroyStore = Boolean(deleteFiles) && !task.torrent.done;
            try {
                c.remove(task.torrent, { destroyStore }, (err) => {
                    btDropTask(task);
                    if (err) resolve({ success: false, message: String(err.message || err) });
                    else resolve({ success: true });
                });
            } catch (err) {
                btDropTask(task);
                resolve({ success: false, message: String(err.message || err) });
            }
        })().catch((err) => resolve({ success: false, message: String((err && err.message) || err) }));
    });
}

function pauseTorrent(taskId) {
    const task = btFindTask(taskId);
    if (!task) return { success: false, message: '任务不存在' };
    try {
        task.torrent.pause();
        task.status = 'paused';
        // 暂停后元数据不会再来，计时器继续跑会误报 error；先停掉，恢复时重建
        if (task.disarmMetadataTimer) task.disarmMetadataTimer();
        return { success: true };
    } catch (err) {
        return { success: false, message: String(err.message || err) };
    }
}

function resumeTorrent(taskId) {
    const task = btFindTask(taskId);
    if (!task) return { success: false, message: '任务不存在' };
    try {
        task.torrent.resume();
        task.status = task.torrent.done ? 'seeding' : 'downloading';
        if (task.status === 'downloading' && task.armMetadataTimer && !task.torrent.infoHash) {
            task.armMetadataTimer();
        }
        return { success: true };
    } catch (err) {
        return { success: false, message: String(err.message || err) };
    }
}

function getTorrentTasks() {
    return Array.from(btTasks.values()).map(btSnapshot);
}

/** 退出时销毁 client：不销毁则 DHT/Peer 的 socket 句柄会让进程挂住不退出 */
function destroyTorrentClient() {
    return new Promise((resolve) => {
        for (const t of btTasks.values()) {
            if (t.disarmMetadataTimer) {
                try { t.disarmMetadataTimer(); } catch (_e) { }
            }
        }
        btTasks.clear();
        btAliases.clear();
        if (!btClient) {
            resolve();
            return;
        }
        const c = btClient;
        btClient = null;
        try {
            c.destroy(() => resolve());
        } catch (_e) {
            resolve();
        }
    });
}

/**
 * 内置 BT 引擎的任务管理。
 *
 * 注意这里不做任何站点特化：搜索与结果归一化全在 services/SearchService，
 * 主进程只负责"起任务 / 停任务 / 报进度"。
 * 种子文件预取走 net.fetch（Chromium 栈，自动吃会话代理），见 fetchTorrentFileToDisk。
 */
function setupTorrentHandlers() {
    if (torrentHandlersReady) return;
    torrentHandlersReady = true;

    // 内置引擎直接下正片：magnet / torrentPath / torrentUrl 均可。
    // 有 .torrent 直链时优先预取种子文件（KB 级，一次请求即得元数据，
    // 比纯 magnet 走 DHT 找元数据快一个数量级）；预取失败再回退 magnet。
    ipcMain.handle('torrent-start', async (_event, options) => {
        try {
            const opts = options || {};
            if (opts.torrentUrl && !opts.torrentPath) {
                try {
                    const saved = await fetchTorrentFileToDisk({
                        url: opts.torrentUrl,
                        title: opts.name || '',
                        outDir: path.join(app.getPath('downloads'), 'the-play', 'torrents'),
                    });
                    opts.torrentPath = saved.path;
                } catch (prefetchError) {
                    if (!opts.magnet) throw prefetchError;
                    console.warn('torrent .torrent prefetch failed, fallback to magnet:', prefetchError.message);
                }
            }
            const outDir = opts.outDir || path.join(app.getPath('downloads'), 'the-play', 'bt');
            const result = await startTorrent(
                { ...opts, outDir },
                (progress) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('torrent-progress', progress);
                    }
                }
            );
            return { success: true, ...result };
        } catch (error) {
            console.error('torrent-start failed:', error);
            return { success: false, message: error.message || '任务启动失败' };
        }
    });

    ipcMain.handle('torrent-cancel', async (_event, taskId, deleteFiles) => {
        return cancelTorrent(taskId, deleteFiles !== false);
    });

    ipcMain.handle('torrent-pause', async (_event, taskId) => pauseTorrent(taskId));
    ipcMain.handle('torrent-resume', async (_event, taskId) => resumeTorrent(taskId));
    ipcMain.handle('torrent-tasks', async () => getTorrentTasks());

    ipcMain.handle('torrent-open-folder', async (_event, target) => {
        let dir = target || '';
        if (!dir || !fs.existsSync(dir)) {
            // 可能是 taskId，尝试从任务列表解析
            const found = getTorrentTasks().find((t) => t.id === target);
            dir = found ? found.outDir : dir;
        }
        if (dir && fs.existsSync(dir)) {
            await shell.openPath(dir);
            return { success: true };
        }
        return { success: false, message: '目录不存在' };
    });
}

let tamperHandlersReady = false;
function setupTamperHandlers(sess) {
    if (!tamperHandlersReady) {
        tamperHandlersReady = true;
        ipcMain.handle('get-cookies', async (_event, url) => {
            try {
                return await sess.cookies.get({ url });
            } catch (error) {
                console.error('Failed to get cookies', error);
                return [];
            }
        });

        ipcMain.handle('set-cookie', async (_event, details) => {
            try {
                await sess.cookies.set(details);
                return { success: true };
            } catch (error) {
                console.error('Failed to set cookie', error);
                return { success: false, error: error.message };
            }
        });

        ipcMain.handle('remove-cookie', async (_event, url, name) => {
            try {
                await sess.cookies.remove(url, name);
                return { success: true };
            } catch (error) {
                console.error('Failed to remove cookie', error);
                return { success: false, error: error.message };
            }
        });
    }
    // 注意：sess 绑定只做首次（多窗口共用默认 session 时 cookies 句柄等价），重复绑定会叠加监听
}

const sniffedSessions = new WeakSet();
const recentSniffedUrls = new Map();

/**
 * 网络层嗅探总开关，默认关闭 —— 由嗅探面板的"持续嗅探"开关控制：
 * 打开时持续推送捕获到的媒体，关闭时一条不推。
 * 开关只管"推不推送"：webRequest 监听器本身常驻不摘，
 * Electron 每个事件只保留最后一个监听器，摘掉重装反而会
 * 和请求头改写互相顶掉，且常驻监听的开销只是每次回调多一次判断。
 */
let snifferEnabled = false;

// 只注册一次：setupSniffer 是按 session 调用的，放里面会重复注册
// （ipcMain.handle 重复注册同一通道会抛），所以挂在模块顶层。
ipcMain.handle('sniffer-set-enabled', async (_event, enabled) => {
    snifferEnabled = enabled === true;
    return { success: true, armed: snifferEnabled };
});

setInterval(() => {
    const now = Date.now();
    for (const [url, time] of recentSniffedUrls.entries()) {
        if (now - time > 15000) {
            recentSniffedUrls.delete(url);
        }
    }
}, 30000);

function setupSniffer(sess) {
    if (!sess || sniffedSessions.has(sess)) {
        return;
    }
    sniffedSessions.add(sess);

    const filter = { urls: ['<all_urls>'] };

    // ACG 专属资源不进嗅探：图集封面/动画/有声走画廊流程，
    // 否则翻一本漫画就刷几十条封面进嗅探列表。与渲染层 utils.isAcgUrl 保持同口径
    const ACG_SNIFF_EXCLUDE_SUFFIXES = ['acgmho.com', 'acgnngca.com', 'acgnfl.com', 'acg-hentai.com'];
    const isAcgExcluded = (u) => {
        if (!u || typeof u !== 'string') return false;
        try {
            const host = new URL(u).hostname.toLowerCase();
            return ACG_SNIFF_EXCLUDE_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
        } catch (_e) {
            return false;
        }
    };

    /**
     * 后缀表。主进程是独立进程、不能 import utils（TS），所以这里是**派生副本**。
     *
     * 与 utils.MEDIA_EXTENSIONS 的分工：
     *  - 只列"媒体"后缀：嗅探的目的就是发现可下载媒体，
     *    document 类（md/txt/pdf/json）与 aibook/gallery 不在此列，也从不推送；
     *  - **分类必须与 utils 一致**。曾经 `ts` 被放在 videoExts 里，
     *    于是同一个 .ts 地址：网络层推 type='video'、页内扫描判 'stream'。
     *    后果是筛选栏里它出现在"视频"下、徽章文案错，
     *    且下载时 `type !== 'stream'` 让它**跳过 ffmpeg 检查** ——
     *    而 .ts 分片恰恰需要 ffmpeg 才能合成可用文件。
     *    test/sniffer.test.js 会比对两边都有后缀的分类，漂移即失败。
     */
    const streamExts = ['m3u8', 'm3u', 'mpd', 'flv', 'f4v', 'ts'];
    const videoExts = ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'ogv', '3gp', 'mpg', 'mpeg', 'm4s'];
    const audioExts = ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'opus', 'wma'];
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'avif'];

    /**
     * HLS 分片路径判据。与 utils.HLS_SEGMENT_RE_SOURCE **逐字同源**
     * （独立进程不能 import TS，只能复制；test/sniffer.test.js 盯着不漂移）。
     *
     * 单独一份而不是内联在回调里：分片判据只对 .ts 生效，但它决定了
     * "一个页面播 HLS 时会不会推几十上百条 segNNN.ts 刷满列表"。
     */
    const hlsSegmentRe = new RegExp(
        '(?:^|/)(?:segment|seg|chunk|slice|frag|part|track|ts)[-_]?\\d*/'
        + '|(?:^|/)(?:segment|seg|chunk|slice|frag|part|track)[-_]?\\d*\\.ts$'
        + '|(?:^|/)\\d+\\.ts$'
        + '|[-_]\\d+\\.ts$',
        'i'
    );

    /**
     * 从查询参数值里认出媒体后缀（`?file=movie.mp4`、`?url=a%2Fb.m3u8`）。
     *
     * 后缀必须**成词**，不能用裸 includes：`component.tsx` 里含 `.ts`、
     * `backup.mpd2` 里含 `.mpd` —— 那是源码与备份文件，不是流媒体。
     * 裸 includes 会把它们推成 stream，界面据此打上「ffmpeg 下载」徽章，
     * 用户点了才发现下回来一个文本文件。
     * 成词判据是"后缀后面不能再跟字母数字"（`?`、`&`、`#`、`/` 都算边界）。
     *
     * 返回命中的**真实后缀**而不是写死的 m3u8/mp4：`?file=movie.mpd` 的扩展名
     * 是 mpd，写死 m3u8 会让徽章、下载命名与 ffmpeg 判定三处都用错后缀。
     */
    const matchExtInValue = (value, exts) => {
        const lower = String(value).toLowerCase();
        for (const e of exts) {
            if (new RegExp(`\\.${e}(?![a-z0-9])`).test(lower)) return e;
        }
        return '';
    };

    sess.webRequest.onResponseStarted(filter, (details) => {
        // 总开关没打开时直接丢弃："持续嗅探"关闭中，网络层不推送任何结果。
        // 放第一行，后面的 ACG/后缀判定都省了。
        if (!snifferEnabled) return;
        const { url, responseHeaders, method, statusCode } = details;
        if (!url || (statusCode !== 200 && statusCode !== 206) || method === 'OPTIONS' || method === 'HEAD') {
            return;
        }

        // ACG 资源直接丢弃：资源直链在 ACG 域名，或请求挂在 ACG 页面下（referrer）
        if (isAcgExcluded(url) || isAcgExcluded(details.referrer)) {
            return;
        }

        if (
            url.startsWith('chrome-extension:') ||
            url.startsWith('devtools:') ||
            url.startsWith('blob:') ||
            url.startsWith('data:') ||
            url.startsWith('file:')
        ) {
            // file: 必须排除：嗅探是为了发现远端媒体以下载，本地文件进列表零作用；
            // 且 ACG 落盘页正是 file://（hostname 为空，走不进上面的域名排除，
            // img 又是 no-referrer），否则保存完成后轮播每翻一页就往嗅探列表推一条。
            return;
        }

        const getHeader = (headers, name) => {
            if (!headers) return '';
            const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
            if (!key) return '';
            const val = headers[key];
            return Array.isArray(val) ? val[0] : String(val);
        };

        const contentType = getHeader(responseHeaders, 'content-type').toLowerCase();

        // 快速过滤不需要的普通网页文本文件
        if (
            contentType.includes('text/html') ||
            contentType.includes('text/css') ||
            contentType.includes('javascript') ||
            contentType.includes('application/json')
        ) {
            return;
        }

        let detectedType = null;
        let ext = '';

        // 1. 基于 Content-Type 判定
        if (
            contentType.includes('mpegurl') ||
            contentType.includes('dash+xml') ||
            contentType.includes('vnd.ms-sstr') ||
            contentType.includes('application/x-mpegurl')
        ) {
            detectedType = 'stream';
            ext = contentType.includes('dash') ? 'mpd' : 'm3u8';
        } else if (contentType.startsWith('video/')) {
            if (contentType.includes('x-flv')) {
                detectedType = 'stream';
                ext = 'flv';
            } else if (contentType.includes('mp2t')) {
                // MPEG-TS。必须与 utils 同口径判成 stream、后缀归一为 'ts'：
                // utils 的 MEDIA_EXTENSIONS 里 'ts' 属 stream，若这里照搬 content-type
                // 的字面量（'mp2t'）判成 video，同一个地址就会两条路径两个结论 ——
                // 筛选栏归错类，界面按 type 判 ffmpeg 徽章而主进程按 ext 判下载方式。
                detectedType = 'stream';
                ext = 'ts';
            } else {
                detectedType = 'video';
                ext = canonicalExtFromMime(contentType, 'mp4');
            }
        } else if (contentType.startsWith('audio/')) {
            detectedType = 'audio';
            ext = canonicalExtFromMime(contentType, 'mp3');
        } else if (contentType.startsWith('image/')) {
            let imgExt = contentType.split('/')[1]?.split(';')[0];
            if (imgExt === 'svg+xml') {
                imgExt = 'svg';
            }
            if (imageExts.includes(imgExt)) {
                detectedType = 'image';
                ext = imgExt;
            }
        }

        // 2. 基于 URL 路径拓展名判定
        let urlObj = null;
        let pathname = '';
        try {
            urlObj = new URL(url);
            pathname = urlObj.pathname.toLowerCase();
        } catch (_e) {
            pathname = url.split('?')[0].split('#')[0].toLowerCase();
        }

        const pathMatch = pathname.match(/\.([a-zA-Z0-9]+)$/);
        const pathExt = pathMatch ? pathMatch[1] : '';

        if (!detectedType) {
            if (streamExts.includes(pathExt)) {
                detectedType = 'stream';
                ext = pathExt;
            } else if (videoExts.includes(pathExt)) {
                detectedType = 'video';
                ext = pathExt;
            } else if (audioExts.includes(pathExt)) {
                detectedType = 'audio';
                ext = pathExt;
            } else if (imageExts.includes(pathExt)) {
                detectedType = 'image';
                ext = pathExt;
            }
        }

        // 3. 基于 Query 参数中嵌套媒体拓展名探测
        if (!detectedType && urlObj) {
            for (const [, val] of urlObj.searchParams.entries()) {
                const hitStream = matchExtInValue(val, streamExts);
                if (hitStream) {
                    detectedType = 'stream';
                    ext = hitStream;
                    break;
                }
                const hitVideo = matchExtInValue(val, videoExts);
                if (hitVideo) {
                    detectedType = 'video';
                    ext = hitVideo;
                    break;
                }
                const hitAudio = matchExtInValue(val, audioExts);
                if (hitAudio) {
                    detectedType = 'audio';
                    ext = hitAudio;
                    break;
                }
            }
        }

        // 过滤 TS 切片分段。
        //
        // 判据同时看 ext 与 contentType：HLS 分片的响应头是 video/mp2t，
        // 而步骤 1 现在把它归一成 ext='ts'（见上面的 mp2t 分支），
        // 步骤 2 只在 !detectedType 时才跑 —— 所以 ext 与 content-type 两条都要开门。
        //
        // 第三条门（pathExt === 'ts'）不能省：部分 CDN 把分片标成
        // application/octet-stream，既不是 video/mp2t 也不进 streamExts 的
        // content-type 分支，只靠前两条门会让整页 segNNN.ts 全被推给渲染层。
        //
        // 不写成"任何 .ts 都算分片"：整段的 .ts 视频同样可下载，不该被丢，
        // 所以最终判据仍然交给路径正则（它只认分片命名）。
        if (ext === 'ts' || ext === 'mp2t' || pathExt === 'ts' || contentType.includes('mp2t')) {
            const isSegment = contentType.includes('mp2t') || hlsSegmentRe.test(pathname);
            // 播放列表本身要留下（它是"可下载的流"入口），只丢分片
            if (isSegment && !url.includes('playlist')) {
                return;
            }
        }

        if (!detectedType || !mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        // 去重检查 (5 秒内相同 URL 不重复推送)
        const now = Date.now();
        const lastSeen = recentSniffedUrls.get(url);
        if (lastSeen && now - lastSeen < 5000) {
            return;
        }
        recentSniffedUrls.set(url, now);

        // 提取文件名与安全标题
        let filename = '';
        const dispositionHeader = getHeader(responseHeaders, 'content-disposition');
        if (dispositionHeader) {
            const match = dispositionHeader.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
            if (match && match[1]) {
                filename = match[1];
            }
        }

        if (!filename && urlObj) {
            const parts = urlObj.pathname.split('/').filter(Boolean);
            filename = parts.pop() || '';
        }

        if (!filename || filename.length > 80) {
            filename = `Media_${ext || 'stream'}`;
        }

        let safeTitle = filename;
        try {
            safeTitle = decodeURIComponent(filename);
        } catch (_err) {
            safeTitle = filename;
        }

        let senderUrl = '';
        if (details.webContentsId) {
            try {
                const sender = webContents.fromId(details.webContentsId);
                if (sender && !sender.isDestroyed()) {
                    senderUrl = sender.getURL() || '';
                }
            } catch (_e) { }
        }

        const referer = details.referrer || senderUrl || '';
        const pageUrl = senderUrl || details.referrer || '';

        // 二次兜底：宿主页面在 ACG 站（senderUrl）但 referrer 为空时，早期拦截拦不住，
        // 这里按最终 pageUrl/referer 再拦一次，与渲染层 addLinks 同口径
        if (isAcgExcluded(referer) || isAcgExcluded(pageUrl)) {
            return;
        }

        try {
            mainWindow.webContents.send('sniffed-media', {
                url,
                title: safeTitle,
                type: detectedType,
                ext: ext || 'unknown',
                source: 'network',
                referer,
                pageUrl,
            });
        } catch (_e) { }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: 'React Advanced Player',
        backgroundColor: '#020617',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            allowRunningInsecureContent: false,
            webSecurity: false,
            webviewTag: true,
        },
    });

    const isDev = !app.isPackaged;
    const devUrl = 'http://localhost:5173';
    const prodPath = path.join(__dirname, '../dist/index.html');

    if (isDev) {
        mainWindow.loadURL(devUrl);
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(prodPath);
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 弹窗洪水节流：页面里 `while(1) window.open(url)` 会无上限开新标签页
    // （每个都带一个 webview），正常站点只会零星弹窗。同一来源 3 秒内开
    // 第 9 个起直接拒掉 —— 阈值只拦机器，不拦人。两处 setWindowOpenHandler
    // （主窗口 + guest）共用这一份记账。
    const popupOpenTimes = new WeakMap();
    const allowPopupOpen = (source) => {
        const now = Date.now();
        const list = (popupOpenTimes.get(source) || []).filter((t) => now - t < 3000);
        if (list.length >= 8) {
            popupOpenTimes.set(source, list);
            console.warn('弹窗过于频繁，已拦截');
            return false;
        }
        list.push(now);
        popupOpenTimes.set(source, list);
        return true;
    };

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (!allowPopupOpen(mainWindow.webContents)) return { action: 'deny' };
        mainWindow.webContents.send('navigate-to-url', url);
        return { action: 'deny' };
    });

    const filter = { urls: ['*://*/*'] };

    /**
     * 请求头改写：补防盗链 Referer；顺带把该 session 的 UA 对齐内核。
     *
     * 抽成具名函数是因为它必须挂到**每一个**会用到的 session 上，
     * 而不只是主窗口那个：
     *
     *  - Electron 的 webRequest **每个 session 每个事件只保留最后一个监听器**
     *    （官方文档："Only the last attached listener will be used"）。
     *    所以重复注册不是"叠加"而是"替换"，不能靠多调几次来覆盖多个 session。
     *  - `<webview>` 默认继承宿主窗口的 session，但一旦将来有人给 webview 加
     *    partition（独立 session），主窗口那次注册就管不到它了 ——
     *    表现为防盗链 403，而且 partition session 的 UA 会退回 Electron 默认值
     *    （自带 `Electron/` token），
     *    而嗅探（setupSniffer）**有**覆盖多 session 的守卫，两者不对称。
     *
     * 用 WeakSet 记账：同一个 session 只注册一次，避免后注册的把先注册的顶掉。
     *
     * 定义放在 did-attach-webview 注册**之前**：那里会引用它。
     * 事件回调不会同步触发，所以放后面其实也不会 TDZ，但那样读起来要额外推一遍时序。
     */
    const headerRewriteSessions = new WeakSet();
    const applyRequestHeaderRules = (sess) => {
        if (!sess || headerRewriteSessions.has(sess)) return;
        headerRewriteSessions.add(sess);

        sess.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
            const requestHeaders = { ...details.requestHeaders };
            let hostname = '';
            try {
                hostname = new URL(details.url).hostname;
            } catch (_error) { }
            // 这里**不再碰 UA 与 sec-ch-ua\***，也不再覆写任何 session 的 UA。
            // 原先把非白名单域的 UA 一刀切改成旧版 Chrome、并删掉三个 Client Hints，
            // 结果是"UA 声称 122 / sec-ch-ua 报内核 152 / navigator 又是第三个值"——
            // Google 据此判定"浏览器或应用可能不安全"，Cloudflare 把它当伪造流量。
            // 现在 UA 与 Client Hints 全部交回 Chromium 自己发，天然同源（见 userAgent.js）。

            if (/(^|\.)bilivideo\.com$/i.test(hostname) || /(^|\.)hdslb\.com$/i.test(hostname)) {
                requestHeaders.Referer = 'https://www.bilibili.com/';
            } else if (
                /(^|\.)acgmho\.com$/i.test(hostname) ||
                /(^|\.)acgnngca\.com$/i.test(hostname) ||
                /(^|\.)acgnfl\.com$/i.test(hostname) ||
                /(^|\.)acg-hentai\.com$/i.test(hostname)
            ) {
                // 与嗅探排除口径（ACG_SNIFF_EXCLUDE_SUFFIXES）保持一致：四个镜像站都要补 Referer 防盗链
                requestHeaders.Referer = 'https://www.acgmho.com/';
            }

            callback({ requestHeaders });
        });
    };

    mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
        if (webContents.session) {
            setupSniffer(webContents.session);
            // 请求头规则同样要覆盖到这个 session：webview 若带 partition
            // （独立 session），只挂主窗口那次注册就管不到它的请求 ——
            // 表现为防盗链 403、UA 与渲染层不一致。WeakSet 记账保证幂等。
            applyRequestHeaderRules(webContents.session);
            // 浏览器能力同理：下载拦截与权限策略也按 session 生效。
            // 漏了这一行，webview 一旦带 partition，网页下载会绕过记录、
            // 权限会退回 Electron 的默认"全部允许"——两件事都不报错。
            setupBrowserSession(webContents.session);
        }

        // 焦点在页面里时，只有 guest 能收到键盘事件（webview 是跨进程 OOPIF，
        // 键盘/滚轮不冒泡到宿主页面）。浏览器级快捷键必须挂在这里，
        // 否则用户一点进页面就全部静默失效。见 browserService 顶部注释。
        attachGuestExtras(webContents);

        webContents.setWindowOpenHandler(({ url }) => {
            if (!allowPopupOpen(webContents)) return { action: 'deny' };
            mainWindow.webContents.send('navigate-to-url', url);
            return { action: 'deny' };
        });
    });

    applyRequestHeaderRules(mainWindow.webContents.session);
    setupBrowserSession(mainWindow.webContents.session);

    // 宿主窗口自己也要挂：焦点在地址栏或 Agent 输入框里时，
    // 键盘事件落在宿主 webContents 上，只挂 guest 会让这些位置的快捷键失效。
    // 两处都挂才是完整的 —— 这是本模块最容易漏的一处不对称。
    attachBrowserInput(mainWindow.webContents);
    guardWebviewAttach(mainWindow.webContents);

    const { session } = require('electron');
    setupSniffer(session.defaultSession);
    if (mainWindow.webContents.session !== session.defaultSession) {
        setupSniffer(mainWindow.webContents.session);
    }

    setupTamperHandlers(mainWindow.webContents.session);
    setupDownloadHandlers();
    setupGalleryHandlers();
    setupTorrentHandlers();
    setupTorrentFileHandlers();
    setupSettingsHandlers();
    setupKbHandlers();
    setupEdgeImportHandlers();
    // 浏览器外壳能力的 IPC（下载记录 / 下载操作）。窗口 getter 用闭包注入，
    // 不让 browserService 反向 require main.js —— 那会形成循环依赖，
    // 而循环 require 只报 warning 不报错，症状是第一次用到才炸。
    setupBrowserIpc(() => mainWindow);
}

/* -------------------------------------------------------------------------- */
/*                       种子文件获取（通用，无站点特化）                        */
/* -------------------------------------------------------------------------- */

/**
 * 搜索本身不经过主进程——引擎完整地待在 services/SearchService，
 * 用渲染层 fetch 直接请求各站点（代理配在 Chromium 会话上，自动生效）。
 *
 * 这里只保留渲染层做不到的那件事：把 .torrent 落到磁盘（需要文件系统权限）。
 *
 * 站点白名单是安全边界，不是特化：渲染层传来的任意地址不能让主进程无条件去抓，
 * 否则页面里一段脚本就能借主进程去打内网（SSRF）。
 * 新增搜索站点时若该站提供 .torrent 直链，需把它的下载域名加进这里。
 */
const TORRENT_FILE_HOSTS = new Set([
    'nyaa.si',
    'sukebei.nyaa.si',
    'sukebei.nyaa.site',
    'acg.rip',
    'animetosho.org',
    'apibay.org',
    'share.dmhy.org',
    'mikanani.me',
    'nekobt.to',
]);

/** 校验目标地址属于白名单站点，且必须是 https/http 的 .torrent 直链 */
function assertTorrentFileUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || ''));
    } catch (_e) {
        throw new Error(`非法的种子地址: ${rawUrl}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`种子地址协议不受支持: ${parsed.protocol}`);
    }
    const host = parsed.hostname.toLowerCase();
    if (!TORRENT_FILE_HOSTS.has(host)) {
        throw new Error(`种子地址不在白名单站点: ${host}`);
    }
    return parsed.toString();
}

/**
 * 下载 .torrent 并落盘。
 *
 * 走 Electron 的 net 模块而不是 Node 的 https：net 使用 Chromium 网络栈，
 * 因此**自动继承已配置的会话代理**。这是与旧实现的关键区别——旧版用裸
 * https.get 且不传 agent，代理对它完全无效，配好 SOCKS5 后照样 ECONNRESET。
 */
async function fetchTorrentFileToDisk({ url, title, outDir }) {
    const target = assertTorrentFileUrl(url);
    const { net } = require('electron');

    const res = await net.fetch(target, {
        method: 'GET',
        headers: { Referer: new URL(target).origin + '/' },
    });
    if (!res.ok) throw new Error(`下载失败，HTTP ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());
    // bencode 字典必以 'd' 开头。不是的话多半是错误页（被拦/资源已删），
    // 落盘一个坏文件比直接报错更难排查。
    if (!buf.length || buf[0] !== 0x64) {
        throw new Error('站点未返回合法 torrent 文件（资源可能已被删除）');
    }
    // 20MB 上限：正常种子就几十 KB，超过必是错误链接
    if (buf.length > 20 * 1024 * 1024) {
        throw new Error('种子文件异常过大，疑似错误链接');
    }

    const dir = outDir || path.join(app.getPath('downloads'), 'the-play', 'torrents');
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${sanitizeFileName(title || 'torrent')}.torrent`;
    const dest = path.join(dir, fileName);
    fs.writeFileSync(dest, buf);
    return { path: dest, bytes: buf.length };
}

let torrentFileHandlersReady = false;
function setupTorrentFileHandlers() {
    if (torrentFileHandlersReady) return;
    torrentFileHandlersReady = true;

    ipcMain.handle('torrent-fetch-file', async (_event, options) => {
        try {
            const result = await fetchTorrentFileToDisk(options || {});
            return { success: true, ...result };
        } catch (error) {
            console.error('torrent-fetch-file failed:', error);
            return { success: false, message: error.message || '种子下载失败' };
        }
    });
}

function setupSettingsHandlers() {
    if (settingsHandlersReady) return;
    settingsHandlersReady = true;

    ipcMain.handle('settings-get', async () => {
        const { proxyPort, ai, kbRoot } = getSettings();
        return {
            success: true,
            proxyPort,
            applied: getAcgmhoProxy() || '',
            proxyProtocol: getAcgmhoProxyProtocol() || '',
            ai,
            kbRoot,
            kb: kbStatus(kbRoot),
        };
    });

    // 保存后立即把新配置推给服务层，不必重启应用。
    // 返回 applied 让界面能区分「配了端口但连不上，已回落直连」，
    // proxyProtocol 让界面能显示实际识别到的协议（裸端口时尤其有用）。
    ipcMain.handle('settings-set-proxy-port', async (_event, value) => {
        const res = saveProxyPort(value);
        if (!res.success) {
            return { ...res, applied: getAcgmhoProxy() || '', proxyProtocol: getAcgmhoProxyProtocol() || '' };
        }
        await syncAcgmhoProxy();
        return { ...res, applied: getAcgmhoProxy() || '', proxyProtocol: getAcgmhoProxyProtocol() || '' };
    });

    // AI 配置由主进程持有：渲染层只提交，落盘与校验都在这一侧完成
    ipcMain.handle('settings-set-ai-config', async (_event, value) => {
        return saveAiConfig(value);
    });

    // 探活用提交上来的草稿配置，不落盘。第二个参数是映射后的档位取值，由渲染层传入；
    // 传 null 表示这次不下发思考参数（服务商不需要思考，或用户选了「不思考」）
    ipcMain.handle('settings-test-ai-config', async (_event, value, reasoningEffort) => {
        return testAiConnection(value, reasoningEffort);
    });
}

/**
 * 知识库 IPC。
 *
 * 主进程这一侧**只搬字节**：解析 front-matter、评分、切片全在渲染层的
 * services/KbService（纯 TS，可单测）。这里返回的东西就是磁盘上的原文，
 * 不做任何加工 —— 加工逻辑一旦分居两侧，两边迟早会漂移。
 */
function setupKbHandlers() {
    if (kbHandlersReady) return;
    kbHandlersReady = true;

    // 整库一次读完（248 个文件 / 约 3 MB）。渲染层把它长期驻留，
    // 之后每次检索都在本地算，不再往返 IPC。
    ipcMain.handle('kb-load', async () => loadKbSource(getSettings().kbRoot));

    ipcMain.handle('kb-read', async (_event, relativePath) => {
        return readKbArticle(getSettings().kbRoot, relativePath);
    });

    ipcMain.handle('kb-status', async () => kbStatus(getSettings().kbRoot));

    // 保存路径后立刻回报新状态，界面不用再发一次 kb-status
    ipcMain.handle('kb-set-root', async (_event, value) => {
        const res = saveKbRoot(value);
        return { ...res, status: kbStatus(getSettings().kbRoot) };
    });
}

/**
 * Edge 数据导入 IPC。
 *
 * 分两步而不是一步：
 *
 *   - `edge-detect` 只读 Local State 与 Bookmarks 的大小/条目数，快且不会被锁影响；
 *   - `edge-import` 才打开 SQLite 与解密。耗时操作放在用户点「导入」之后，
 *     而不是打开设置面板就做。
 *
 * Cookie 的写回放在这里而不是服务里：服务不 require electron（那样才能被测试
 * 直接 require），而 cookies.set 是 session 的能力。
 */
function setupEdgeImportHandlers() {
    if (edgeImportHandlersReady) return;
    edgeImportHandlersReady = true;

    ipcMain.handle('edge-detect', async () => detectEdgeProfiles());

    ipcMain.handle('edge-import', async (event, options) => {
        const report = (message) => {
            try { event.sender.send('edge-import-progress', message); } catch (_e) { /* 窗口关了就算了 */ }
        };

        const result = await importEdgeData(options, report);
        if (!result.ok || result.cookies.length === 0) return result;

        // 写回 Cookie：目标 session 必须与 <webview> 用的一致。
        // webview 没有配 partition，用的就是 defaultSession。
        const session = require('electron').session.defaultSession;
        const failed = [];
        for (const cookie of result.cookies) {
            try {
                await session.cookies.set({
                    url: cookie.url,
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path,
                    secure: cookie.secure,
                    httpOnly: cookie.httpOnly,
                    sameSite: cookie.sameSite,
                    ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
                });
            } catch (e) {
                failed.push(cookie.domain + cookie.name);
            }
        }

        result.stats.cookiesApplied = result.cookies.length - failed.length;
        if (failed.length > 0) {
            result.warnings.push({
                category: 'cookies',
                message: `有 ${failed.length} 条 Cookie 被会话拒绝（多为过期或域不匹配），其余已写入。`,
            });
        }
        return result;
    });
}

app.whenReady().then(async () => {
    // 会话 UA 一个字节都不改（理由见 electron/userAgent.js：只改 UA 不改 UA-CH＝谎报，
    // Cloudflare 会据此把挑战升级成点多少次都不放行的死循环）。
    // Node 直抓那条路的 UA 由下面的 syncAcgmhoProxy 读会话实际值后对齐。
    // 启动即同步代理配置：留空则直连，配了端口则建隧道。
    // 这一步同时完成全局接管（http/https 的 globalAgent + 全局 fetch）。
    await syncAcgmhoProxy();
    // 再补一次接管：fetch 的替换依赖已 ready 的 Electron 运行时，
    // 而 NetworkServices 在模块加载时（早于 ready）只能接管 agent 部分。
    installGlobalInterception();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    try {
        // 同步销毁 BT 引擎，避免退出时 DHT/Peer 句柄挂起
        destroyTorrentClient();
    } catch (_e) { }
});
