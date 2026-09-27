// 代理链路自检：确认本地代理端口能被正确识别、两条出站链路都真的走了代理。
//
// 背景：应用同时用两套网络栈，缺一条就会"列表能刷出来、点进去白屏"：
//   1. Node 侧（acgmhoService 的 https.get）—— 抓列表、探测详情、抓页、下图；
//   2. Chromium 侧（session）—— 内置浏览器打开的页面、过 Cloudflare 挑战的求解窗口。
// 本脚本在真实 Electron 里把两条链路都验一遍，用的是产品代码本身
// （直接从 main.js 源文件里取出网络层与 applySessionProxy 求值，不复制一份逻辑来测）。
//
// 注意：代理与全局接管现在是 main.js 的一部分（进程级网络设施），
// 所以这里从 main.js 源文件里抽取，而不是 require 某个模块。
//
// 用法:
//   npx electron scripts/proxy-check.js            # 探测默认端口
//   npx electron scripts/proxy-check.js 10808      # 指定端口
const path = require('path');
const fs = require('fs');
const { app, session, net } = require('electron');

const root = path.join(__dirname, '..');
const mainPath = path.join(root, 'electron', 'main.js');

// resolveProxy 是异步生效的：setProxy 之后立刻查会拿到上一份配置。
// 必须轮询到稳定，否则会把"还没生效"误判成"配错了"。
async function resolveProxyStable(ses, url, timeoutMs = 8000) {
    const started = Date.now();
    let last = '';
    let stable = 0;
    while (Date.now() - started < timeoutMs) {
        const r = await ses.resolveProxy(url);
        if (r === last) {
            stable += 1;
            if (stable >= 3) return r;
        } else {
            stable = 0;
            last = r;
        }
        await new Promise((res) => setTimeout(res, 250));
    }
    return last;
}

function chromiumFetch(url, timeoutMs = 25000) {
    return new Promise((resolve) => {
        const req = net.request({ url, useSessionCookies: false });
        const timer = setTimeout(() => {
            try { req.abort(); } catch (_e) { /* ignore */ }
            resolve({ ok: false, msg: 'timeout' });
        }, timeoutMs);
        req.on('response', (res) => {
            clearTimeout(timer);
            let n = 0;
            res.on('data', (c) => { n += c.length; });
            res.on('end', () => resolve({ ok: true, status: res.statusCode, bytes: n }));
            res.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, msg: e.message }); });
        });
        req.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, msg: e.message }); });
        req.end();
    });
}

/**
 * 从 main.js 源文件里抽出「全局网络层」整段并求值，拿到 setProxy / getProxy 等。
 *
 * 这样验证的是产品代码本身而非副本。网络层在 main.js 里是一段自包含的代码
 * （只依赖 http/https/net/tls 与 electron），因此可以整段取出独立运行。
 */
function loadNetworkLayer() {
    const src = fs.readFileSync(mainPath, 'utf8');

    // 网络层从「全局网络层」标题开始，到「别名」注释之前结束
    const startMarker = '/*                          全局网络层（进程级设施）';
    const endMarker = '/* ---- 供本文件其余部分调用的别名';
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker);
    if (start < 0 || end < 0 || end <= start) {
        throw new Error('main.js 里找不到全局网络层区段');
    }
    // 往前退到该行行首，连同注释框一起取
    const blockStart = src.lastIndexOf('/* ====', start);
    const block = src.slice(blockStart < 0 ? start : blockStart, end);

    if (!/function setProxy/.test(block)) throw new Error('网络层区段里没有 setProxy');
    if (!/function tunnelThroughSocks5/.test(block)) throw new Error('网络层区段里没有 SOCKS5');

    // 区段内部调用了 require('electron') 的 net.fetch（installGlobalFetch），
    // 其余依赖 Node 内置模块——把 require 与几个内置模块注入进去求值。
    // 这些模块名在 main.js 顶层是 const 声明，抽出的区段里没有，必须显式注入。
    // eslint-disable-next-line no-new-func
    const factory = new Function(
        'require', 'http', 'https', 'net', 'tls',
        `${block}
        return { setProxy, getProxy, getProxyProtocol, installGlobalInterception };`
    );
    return factory(require, require('http'), require('https'), require('net'), require('tls'));
}

// 从 main.js 源文件里抽出 applySessionProxy，直接求值使用。
function loadApplySessionProxy() {
    const src = fs.readFileSync(mainPath, 'utf8');
    const grab = (marker) => {
        const start = src.indexOf(marker);
        if (start < 0) throw new Error(`main.js 里找不到 ${marker}`);
        const rest = src.slice(start);
        const nextIdx = rest.slice(1).search(/\n(async )?function /);
        return nextIdx < 0 ? rest : rest.slice(0, nextIdx + 1);
    };
    const helper = grab('function parseProxyAddressForChromium(');
    const main = grab('async function applySessionProxy(');
    // eslint-disable-next-line no-new-func
    return new Function('require', `${helper}\n${main}\nreturn applySessionProxy;`)(require);
}

app.whenReady().then(async () => {
    const ses = session.defaultSession;
    let failures = 0;
    const check = (name, pass, detail) => {
        if (!pass) failures += 1;
        console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    };

    // 端口与期望协议：10808 是 v2rayN 的 SOCKS5、10810 是 HTTP。
    // 其它端口不预设期望，只看"能不能真的出网"。
    const ports = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
    const targets = ports.length ? ports : ['10808', '10810'];
    const expectedFor = (p) => (p === '10808' ? 'socks5' : p === '10810' ? 'http' : null);

    const netLayer = loadNetworkLayer();
    const applySessionProxy = loadApplySessionProxy();
    // 站点抓取（不传 agent，靠全局接管走代理）
    const acg = require(path.join(root, 'electron', 'acgmhoService'));

    for (const port of targets) {
        const expected = expectedFor(port);
        console.log(`\n===== 端口 ${port}${expected ? `（期望 ${expected}）` : ''} =====`);

        const res = await netLayer.setProxy(`127.0.0.1:${port}`);
        console.log('[setProxy]', JSON.stringify(res));
        if (expected) {
            check(`服务层识别为 ${expected}`, res.applied && res.protocol === expected, `protocol=${res.protocol}`);
        } else {
            check('端口可用', res.applied, `protocol=${res.protocol || '(none)'}`);
        }
        if (!res.applied) continue;

        await applySessionProxy(`127.0.0.1:${port}`, res);
        const resolved = await resolveProxyStable(ses, 'https://www.acgmho.com/');
        console.log('[resolveProxy acgmho]', resolved);
        // Chromium 对 HTTP 代理回 "PROXY host:port"，对 SOCKS5 回 "SOCKS5 host:port"
        const token = res.protocol === 'socks5' ? 'SOCKS5' : 'PROXY';
        check('Chromium 会话指向代理', resolved.includes(`127.0.0.1:${port}`) && resolved.includes(token), resolved);

        // 环回必须直连：AI 网关 127.0.0.1:7863、开发服务器 localhost:5173
        const loopback = await resolveProxyStable(ses, 'http://127.0.0.1:7863/v1/models');
        check('环回地址绕过代理（DIRECT）', /DIRECT/i.test(loopback), loopback);

        const r = await chromiumFetch('https://www.acgmho.com/');
        check('Chromium 经代理取到页面', r.ok && r.status === 200, JSON.stringify(r));

        try {
            const list = await acg.fetchChannelList({ channelId: 'latest', page: 1 });
            check('Node 侧抓频道列表', list.items.length > 0, `${list.items.length} 条`);
        } catch (e) {
            check('Node 侧抓频道列表', false, e.message);
        }
    }

    // 切回直连必须真的清掉代理，否则用户清空配置后仍走旧代理
    console.log('\n===== 切回直连 =====');
    await netLayer.setProxy(null);
    await applySessionProxy('', { applied: false });
    const cleared = await resolveProxyStable(ses, 'https://www.acgmho.com/');
    check('直连后代理已清除', /DIRECT/i.test(cleared), cleared);

    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
    app.exit(failures === 0 ? 0 : 1);
});
