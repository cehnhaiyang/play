// 现场取证：真实 acgmho 挑战页跑到卡住时，到底页面上有什么。
// 输出：截图 PNG、CDP 里的 iframe 节点与盒模型、帧树（url/进程/能否执行 JS/失败原因）、
// 以及"点一下之后页面有没有变"。
const { app, session, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { applyKernelUserAgent } = require('../electron/userAgent');
const { channelListUrl, isCloudflareChallengePage } = require('../electron/acgmhoService');

app.setPath('userData', path.join(os.tmpdir(), 'play-cf-probe-d'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP brunhild.challenges.cloudflare.com 104.18.95.41');
app.on('window-all-closed', () => { });

const LOG = path.join(__dirname, 'cfD.txt');
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const log = (m) => fs.appendFileSync(LOG, `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERY = '变态老爷爷的忏悔室日记';
const PROXY = 'http://127.0.0.1:10810';

async function dumpFrames(wc, tag) {
    const frames = wc.mainFrame.framesInSubtree;
    log(`${tag} 帧数=${frames.length}`);
    for (const f of frames) {
        let probe;
        try {
            probe = await Promise.race([
                f.executeJavaScript('({txt:(document.body&&document.body.innerText||"").replace(/\\s+/g," ").slice(0,140), html:(document.body&&document.body.innerHTML||"").length, boxes:[...document.querySelectorAll("input,[role=checkbox],label,.cb-lb")].map(e=>{const r=e.getBoundingClientRect();return e.tagName+" "+Math.round(r.left)+","+Math.round(r.top)+" "+Math.round(r.width)+"x"+Math.round(r.height)})})'),
                new Promise((_r, j) => setTimeout(() => j(new Error('超时8s')), 8000)),
            ]);
        } catch (e) {
            probe = { error: String((e && e.message) || e).slice(0, 120) };
        }
        log(`${tag}   frame url=${String(f.url).slice(0, 110)} pid=${f.processId} detached=${f.detached} 结果=${JSON.stringify(probe).slice(0, 420)}`);
    }
}

async function dumpIframeNodes(wc, dbg, tag) {
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const hits = [];
    const walk = (node, depth) => {
        if (!node) return;
        if (node.nodeName === 'IFRAME' && Array.isArray(node.attributes)) {
            let src = '';
            for (let i = 0; i + 1 < node.attributes.length; i += 2) {
                if (node.attributes[i] === 'src') src = node.attributes[i + 1];
            }
            hits.push({ nodeId: node.nodeId, src: String(src).slice(0, 140), depth });
        }
        if (Array.isArray(node.children)) node.children.forEach((c) => walk(c, depth + 1));
        if (Array.isArray(node.shadowRoots)) node.shadowRoots.forEach((s) => walk(s, depth + 1));
        if (node.contentDocument) walk(node.contentDocument, depth + 1);
    };
    walk(root, 0);
    log(`${tag} CDP IFRAME 节点 ${hits.length} 个`);
    for (const h of hits) {
        let box = null;
        try {
            const { model } = await dbg.sendCommand('DOM.getBoxModel', { nodeId: h.nodeId });
            const q = model.content;
            box = { left: Math.min(q[0], q[2], q[4], q[6]), top: Math.min(q[1], q[3], q[5], q[7]),
                width: Math.max(q[0], q[2], q[4], q[6]) - Math.min(q[0], q[2], q[4], q[6]),
                height: Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7]) };
        } catch (e) { box = { error: String((e && e.message) || e).slice(0, 80) }; }
        log(`${tag}   #${h.nodeId} depth=${h.depth} box=${JSON.stringify(box)} src=${h.src}`);
    }
    return hits;
}

async function main() {
    await app.whenReady();
    const ses = session.defaultSession;
    applyKernelUserAgent(ses);
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: PROXY, proxyBypassRules: 'localhost;127.0.0.1;[::1]' });
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, cb) => {
        const h = { ...details.requestHeaders };
        let hostname = '';
        try { hostname = new URL(details.url).hostname; } catch (_e) { }
        if (/(^|\.)acgmho\.com$/i.test(hostname)) h.Referer = 'https://www.acgmho.com/';
        cb({ requestHeaders: h });
    });
    log('UA = ' + ses.getUserAgent());

    const wa = screen.getPrimaryDisplay().workArea;
    const win = new BrowserWindow({
        width: 520, height: 600, x: wa.x + 40, y: wa.y + 40, show: false,
        webPreferences: { contextIsolation: true, backgroundThrottling: false },
    });
    const wc = win.webContents;
    wc.debugger.attach('1.3');
    win.loadURL(channelListUrl('search', 1, QUERY));
    win.showInactive();

    for (const t of [8, 20, 32]) {
        const spent = Date.now() - t0;
        if (spent < t * 1000) await wait(t * 1000 - spent);
        const html = await wc.executeJavaScript('document.documentElement.outerHTML').catch(() => '');
        const st = await wc.executeJavaScript('({title:document.title,url:location.href,ready:document.readyState})').catch(() => null);
        log(`t=${t}s 状态=${JSON.stringify(st)} htmlLen=${html.length} 是挑战页=${isCloudflareChallengePage(html)}`);
        await dumpFrames(wc, `t=${t}s`);
        const hits = await dumpIframeNodes(wc, wc.debugger, `t=${t}s`);
        const img = await wc.capturePage();
        fs.writeFileSync(path.join(__dirname, `cfD-${t}.png`), img.toPNG());
        if (t === 20 && hits.length) {
            const { model } = await wc.debugger.sendCommand('DOM.getBoxModel', { nodeId: hits[0].nodeId }).catch(() => null);
            if (model) {
                const q = model.content;
                const x = Math.round(Math.min(q[0], q[2], q[4], q[6]) + 24);
                const y = Math.round((Math.min(q[1], q[3], q[5], q[7]) + Math.max(q[1], q[3], q[5], q[7])) / 2);
                const before = await wc.executeJavaScript('document.documentElement.outerHTML.length');
                log(`点击组件 (${x},${y})`);
                const dm = (type, extra) => wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, pointerType: 'mouse', pointerID: 1, ...extra });
                const tClick = Date.now();
                await dm('mouseMoved', { buttons: 0 });
                await dm('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
                await dm('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
                log(`三次 Input.dispatch 用时 ${Date.now() - tClick}ms`);
                await wait(6000);
                const after = await wc.executeJavaScript('document.documentElement.outerHTML.length');
                log(`点击后 6s：HTML ${before} → ${after}，标题=${JSON.stringify(await wc.executeJavaScript('document.title').catch(() => null))}`);
                fs.writeFileSync(path.join(__dirname, 'cfD-after.png'), (await wc.capturePage()).toPNG());
            }
        }
    }
    wc.debugger.detach();
    app.exit(0);
}

main().catch((e) => { log('FAILED: ' + ((e && e.stack) || String(e))); app.exit(1); });
