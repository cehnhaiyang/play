// Cloudflare managed 挑战的自动通过器：全自动，无需用户点击。
//
// 状态机（轮询页面实际渲染状态驱动）：
//   1. "请稍候…"（初始挑战页）      → 等 CF 自己的静默校验跑完（真浏览器通常几秒内自动放行）
//   2. "正在验证您是否是真人"        → 校验进行中，继续等，绝不打断
//   3. 组件要求交互（复选框）        → 自动激活复选框
//   4. 非挑战页且非 CF 错误页        → 放行成功，返回页面 HTML
//
// 判据必须是"顶层文案 + 子帧实况"两路一起看，不能只看顶层：
// "请验证您是真人"那句话渲染在 challenges.cloudflare.com 的**跨域子帧**里，
// 顶层 outerHTML 永远不含它 —— 只按顶层文案判定 interactive 的话，
// 这个状态在真实挑战页上根本不会出现，激活复选框的分支一次都进不去，
// 表现就是"窗口里明明有复选框，程序只是看着它，永远卡在点击验证"（实测事故）。
//
// 复选框激活的四条路径（依次尝试，优先真实渲染环境）：
//   a. CDP 沿闭式 shadow DOM 穿透找到 Turnstile iframe 的盒模型，
//      与子帧内拿到的元素 rect 相加算出页面真实坐标，sendInputEvent 走真实输入管线点击
//   b. 顶层页面 elementFromPoint 扫描命中 shadow host，取其 rect 代替 CDP 盒模型（同 a 坐标算法）
//   c. 子帧内 JS 直点（untrusted 事件，CF 可能不认，留作兜底）
//   d. 键盘 Tab/Space（Turnstile 复选框可键盘激活）
const { BrowserWindow, screen } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 单步超时兜底：executeJavaScript / 子帧 JS 是对渲染进程的调用，渲染进程卡死时
// 这个 Promise 永不 settle，会把整个轮询循环（连同 deadline 检查一起）永久挂住。
// 每一步都必须能被超时打断，保证 90s 死线一定能到达、一定能报错/放行。
function withTimeout(promise, ms, fallback) {
    return Promise.race([
        Promise.resolve(promise).catch(() => fallback),
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
}

const VERIFYING_RE = /正在验证|正在检查|正在执行安全验证|verifying|checking your browser/i;
const INTERACTIVE_RE = /请验证您是真人|verify you are human|确认您是真人|verify you.re human|click to verify|点击验证|开始验证/i;
const CF_FRAME_RE = /challenges\.cloudflare\.com|\.cloudflare\.com\/(cdn-cgi|turnstile|\.within)/i;
// 组件"已通过"的形态：勾/对号出现，或整块换成 success 文案。
// 已经勾上却继续点（或继续判定卡住）会把激活次数白白烧完。
const VERIFIED_RE = /verified|success|完成验证|已确认|passed|检查通过|turnstile succ/i;

function isVerifyingHtml(html) {
    return VERIFYING_RE.test(String(html || ''));
}

function isInteractiveChallengeHtml(html) {
    return INTERACTIVE_RE.test(String(html || ''));
}

// 页面是否完整收尾：代理在流中途断链时，浏览器会把残页当"完整文档"（readyState=complete），
// 残页尾部停在半个标签上、没有 </html>。不校验的话会把 7KB 的半截页当结果交回去，
// 解析出 0 条——用户看到"验证通过了但搜索结果是空的"。
function isProperlyClosedHtml(html) {
    return /<\/html>\s*$/i.test(String(html || '').trimEnd());
}

async function readPageState(wc) {
    const state = await wc
        .executeJavaScript(
            '({ title: document.title, url: location.href, ready: document.readyState,' +
            ' html: document.documentElement ? document.documentElement.outerHTML : "" })'
        )
        .catch(() => null);
    if (!state) return null;
    return {
        title: String(state.title || ''),
        url: String(state.url || ''),
        ready: String(state.ready || ''),
        html: String(state.html || ''),
    };
}

function collectFrames(frame, out = []) {
    if (!frame) return out;
    out.push(frame);
    for (const child of frame.frames || []) collectFrames(child, out);
    return out;
}

// 子帧里复选框的真实位置与可见文案。
//
// Electron 的 frame.executeJavaScript 能进**跨域**子帧，所以文案和 rect 都要在
// 帧内读——顶层页面读不到（闭式 shadow DOM + 跨域）。
// 取"最小的可点候选"：外层容器（#challenge-stage 之类）能把整块组件都框住，
// 点它的中心会落在组件空隙而不是复选框上。
// @returns {{ rect: {x,y,w,h}|null, text: string, verified: boolean }}|null
async function probeTurnstileFrame(wc, { click, log }) {
    // 只看子帧：顶层文档里的 #challenge-stage 是包住整块组件的容器，
    // 拿它的 rect 去加盒模型会点到组件外面（实测把点击坐标推到视口之外）。
    const frames = collectFrames(wc.mainFrame)
        .filter((f) => f !== wc.mainFrame && CF_FRAME_RE.test(f.url || ''));
    if (!frames.length) {
        if (log) log('未找到 cloudflare 子帧');
        return null;
    }
    const script = `(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
    const cands = [...document.querySelectorAll(
      'input[type="checkbox"], [role="checkbox"], .cb-lb input, .cb-lb, label, #challenge-stage, .cb-c')].filter(vis);
    const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    // 可点元素优先：带尺寸的最小项，而不是 selector 顺序的第一项
    let best = null;
    for (const e of cands) {
      const b = box(e);
      const area = b.w * b.h;
      if (!best || area < best.w * best.h) best = { tag: e.tagName + '.' + String(e.className || ''), ...b };
    }
    if (${click ? 'true' : 'false'} && cands[0]) { try { cands[0].click(); } catch (_e) {} }
    const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 200);
    return best ? { rect: best, text } : (text ? { rect: null, text } : null);
  })()`;
    let picked = null;
    let texts = [];
    let verified = false;
    for (const f of frames) {
        const info = await withTimeout(f.executeJavaScript(script).catch(() => null), 6000, null);
        if (!info) continue;
        const t = String(info.text || '');
        if (t) texts.push(t);
        if (VERIFIED_RE.test(t)) verified = true;
        // 多个子帧都报候选时取面积最小的：复选框在 anchor 帧，容器/文案帧的 rect 只会偏大
        if (info.rect && (!picked || (info.rect.w * info.rect.h) < (picked.rect.w * picked.rect.h))) {
            picked = info;
        }
    }
    if (!picked && !texts.length) {
        if (log) log(`cloudflare 子帧 ${frames.length} 个，帧内脚本无返回（可能已跨进程分离）`);
        return null;
    }
    const out = {
        rect: picked && picked.rect ? picked.rect : null,
        text: texts.join(' | ').slice(0, 240),
        verified,
    };
    if (log) {
        log(`cf帧=${frames.length} rect=${out.rect
            ? `(${Math.round(out.rect.x)},${Math.round(out.rect.y)}) ${Math.round(out.rect.w)}x${Math.round(out.rect.h)}`
            : '无'}${out.verified ? ' verified' : ''} 文案="${out.text.slice(0, 90)}"`);
    }
    return out;
}

// 顶层页面里 Turnstile 组件的占位盒（不依赖 CDP）。
//
// 组件在闭式 shadow root 里，querySelector 扫不到；但 elementFromPoint 会返回
// **shadow host**（或直接返回挑战 iframe 元素），沿祖先链带特征串就能认出组件。
// 命中的元素去重后统一量 rect，优先取 IFRAME 本身：帧内复选框的 rect 是相对
// **子帧视口**的，只有加上 iframe 的位置才是页面真实坐标；
// 拿不到 iframe 就取面积最小的命中节点（外层 wrapper 会包住整页，不能用）。
async function findTurnstileHostBox(wc) {
    const box = await withTimeout(wc.executeJavaScript(`(() => {
    const MARKS = /challenge|cf-|turnstile|captcha|trk_/i;
    const isCfFrame = (n) => n.tagName === 'IFRAME'
      && /challenges\\.cloudflare\\.com/i.test(n.getAttribute('src') || '');
    const looksCf = (n) => isCfFrame(n) || MARKS.test(String(n.id || ''))
      || /(^|[\\s_-])cf[\\s_-]/i.test(String(n.className || '')) || MARKS.test(String(n.className || ''));
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, hits = 0;
    const seen = new Set();
    const vw = innerWidth, vh = innerHeight;
    for (let y = Math.max(0, vh * 0.1); y <= Math.min(vh - 2, vh * 0.95); y += 6) {
      for (let x = 6; x < vw; x += 6) {
        let e = null;
        try { e = document.elementFromPoint(x, y); } catch (_err) {}
        if (!e) continue;
        let node = e, depth = 0, first = null;
        while (node && depth++ < 8) {
          if (looksCf(node)) { first = node; break; }
          node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
        }
        if (!first) continue;
        hits += 1;
        seen.add(first);
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
    if (hits < 4) return null;
    // 候选打分：挑战 iframe 本身最准；其次取"不含文字、尺寸像组件"的最小节点。
    // 必须排掉正文段落——挑战页的 #challenge-text 也带 challenge 特征串，
    // 但它是文案而不是组件，点它会点在文字上。
    const list = [];
    for (const n of seen) {
      if (n === document.body || n === document.documentElement) continue;
      let q = null;
      try { q = n.getBoundingClientRect(); } catch (_err) { continue; }
      if (!(q.width > 1 && q.height > 1)) continue;
      const fr = isCfFrame(n);
      let texty = false;
      if (!fr) { try { texty = ((n.innerText || '') + '').trim().length > 0; } catch (_err) {} }
      list.push({ left: q.left, top: q.top, width: q.width, height: q.height,
        tag: n.tagName, id: String(n.id || '').slice(0, 32), cls: String(n.className || '').slice(0, 32),
        fr, texty });
    }
    if (!list.length) return null;
    const widgetLike = (c) => c.width >= 16 && c.width <= 460 && c.height >= 16 && c.height <= 180;
    const byArea = (a, b) => (a.width * a.height) - (b.width * b.height);
    const chosen = list.find((c) => c.fr)
      || list.filter((c) => !c.texty && widgetLike(c)).sort(byArea)[0]
      || list.filter((c) => !c.texty).sort(byArea)[0]
      || list.sort(byArea)[0];
    if (!chosen) return null;
    return {
      left: chosen.left, top: chosen.top, width: chosen.width, height: chosen.height,
      tag: chosen.tag, id: chosen.id, cls: chosen.cls, isFrame: !!chosen.fr, hits,
      union: { left: l, top: t, width: r - l + 1, height: b - t + 1 },
    };
  })()`), 8000, null);
    return box;
}

// CDP 穿透闭式 shadow DOM，取 Turnstile iframe 占位节点在顶层页面里的盒模型。
async function findTurnstileFrameBox(wc) {
    return withCdp(wc, async (dbg) => {
        const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
        const hits = [];
        const walk = (node) => {
            if (!node) return;
            if (node.nodeName === 'IFRAME' && Array.isArray(node.attributes)) {
                for (let i = 0; i + 1 < node.attributes.length; i += 2) {
                    if (
                        node.attributes[i] === 'src' &&
                        /challenges\.cloudflare\.com/i.test(node.attributes[i + 1] || '')
                    ) {
                        hits.push(node.nodeId);
                    }
                }
            }
            if (Array.isArray(node.children)) node.children.forEach(walk);
            if (Array.isArray(node.shadowRoots)) node.shadowRoots.forEach(walk);
            if (node.contentDocument) walk(node.contentDocument);
        };
        walk(root);
        if (!hits.length) return null;
        const { model } = await dbg.sendCommand('DOM.getBoxModel', { nodeId: hits[0] });
        const quad = model && model.content;
        if (!quad || quad.length < 8) return null;
        const left = Math.min(quad[0], quad[2], quad[4], quad[6]);
        const top = Math.min(quad[1], quad[3], quad[5], quad[7]);
        const right = Math.max(quad[0], quad[2], quad[4], quad[6]);
        const bottom = Math.max(quad[1], quad[3], quad[5], quad[7]);
        return { left, top, width: right - left, height: bottom - top };
    });
}

// CDP 输入通道：Input.* 在**浏览器进程**做命中测试与路由，能递到跨进程子帧；
// wc.sendInputEvent 只递给主帧的渲染进程，OOPIF 里的复选框一个事件都收不到。
// CF 的挑战组件正是跨域 → 跨进程，所以真实链路必须走这里
// （离线探针实测：同进程子帧 sendInputEvent 点得到，跨进程子帧两种鼠标事件全部丢失）。
// 返回 false 表示这条通道不可用（调试器被占用等），调用方再退回 sendInputEvent。
async function withCdp(wc, run) {
    let attachedHere = false;
    try {
        if (!wc.debugger.isAttached()) {
            wc.debugger.attach('1.3');
            attachedHere = true;
        }
        return await run(wc.debugger);
    } catch (_e) {
        return null;
    } finally {
        if (attachedHere) {
            try { wc.debugger.detach(); } catch (_e) { /* ignore */ }
        }
    }
}

async function clickByMouse(wc, x, y, log) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0) return false;
    /**
     * 事件只管发出去，**不等回包**。
     * 实测事故：`Input.dispatchMouseEvent` 的 promise 要等目标渲染进程处理完才 resolve，
     * 而 Turnstile 在 verifying 阶段正跑重活，1.2s 内不 ack。上一版逐条等 ack 加超时，
     * 结果 12 次激活里 10 次被判成"CDP 不可用"、退到 sendInputEvent —— 而那条通道
     * 递不到跨进程子帧，等于一次都没点（日志里那 10 条 sendInputEvent 全是空转）。
     * 命令是同步写进 DevTools 管道的，不 await 也照样派发，所以这里只保留事件节奏，
     * 末尾留一点投递余量再 detach。
     */
    const post = (dbg, params) => {
        dbg.sendCommand('Input.dispatchMouseEvent', params).catch(() => { });
    };
    // 先走一段"接近轨迹"再按下：Turnstile 会看点击前的指针移动，
    // 瞬移到目标点直接按下（0 位移）是典型脚本特征
    const path = [];
    let ax = px - 46, ay = py - 30;
    for (let i = 0; i < 6; i += 1) {
        ax = Math.round(ax + (px - ax) / (7 - i));
        ay = Math.round(ay + (py - ay) / (7 - i));
        path.push([ax + (i % 2 ? 1 : 0), ay]);
    }
    const ok = await withCdp(wc, async (dbg) => {
        for (const [mx, my] of path) {
            post(dbg, { type: 'mouseMoved', x: mx, y: my, pointerType: 'mouse', buttons: 0 });
            await wait(28);
        }
        await wait(60);
        post(dbg, {
            type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1,
            clickCount: 1, pointerType: 'mouse', pointerID: 1,
        });
        await wait(95);
        post(dbg, { type: 'mouseMoved', x: px + 1, y: py, pointerType: 'mouse', buttons: 1 });
        await wait(35);
        post(dbg, {
            type: 'mouseReleased', x: px + 1, y: py, button: 'left', buttons: 0,
            clickCount: 1, pointerType: 'mouse', pointerID: 1,
        });
        await wait(260);
        return true;
    });
    if (ok) {
        log(`mouse click at (${px}, ${py}) via cdp`);
        return true;
    }
    log(`mouse click at (${px}, ${py}) via sendInputEvent（CDP 不可用：调试器 attach 不上；`
        + '跨进程子帧收不到此事件）');
    wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
    await wait(120);
    wc.sendInputEvent({ type: 'mouseMove', x: px + 2, y: py + 1 });
    await wait(120);
    wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
    await wait(80);
    wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
    return true;
}

// 键盘通道同理走 CDP：焦点在子帧时事件才能落到组件上
async function pressKeys(wc, log) {
    log('keyboard Tab/Space');
    const ok = await withCdp(wc, async (dbg) => {
        // 与鼠标通道同理：不等渲染进程 ack（见 clickByMouse 的注释）
        const key = (type, keyCode, code, keyName, text) => dbg.sendCommand('Input.dispatchKeyEvent', {
            type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
            code, key: keyName, text: text || '',
        }).catch(() => { });
        key('keyDown', 9, 'Tab', 'Tab');
        key('keyUp', 9, 'Tab', 'Tab');
        await wait(200);
        key('keyDown', 32, 'Space', ' ', ' ');
        key('keyUp', 32, 'Space', ' ', ' ');
        await wait(200);
        return true;
    });
    if (ok) return;
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await wait(200);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
}

async function activateCheckbox(wc, attempt, log) {
    // 帧内 rect：复选框相对 Turnstile 子帧视口的位置（顺带拿到帧内文案与 verified 状态）
    const probed = await probeTurnstileFrame(wc, { click: false, log });
    const rect = probed && probed.rect ? probed.rect : null;

    // 路径 a：CDP 盒模型（iframe 在顶层页面的位置） + 帧内 rect → 页面真实坐标，真实输入管线点击
    let box = await findTurnstileFrameBox(wc);
    let via = 'cdp';
    if (!box) {
        // 路径 b：不依赖 CDP 的顶层 elementFromPoint 扫描（闭式 shadow host 也能命中）
        box = await findTurnstileHostBox(wc);
        via = 'host-scan';
    }
    if (box) {
        log(`${via} 盒模型 @(${Math.round(box.left)},${Math.round(box.top)}) `
            + `${Math.round(box.width)}x${Math.round(box.height)} `
            + `${box.tag || ''}${box.id ? '#' + box.id : ''}${box.isFrame ? ' (iframe)' : ''}`);
        const inside = (x, y) => x >= box.left - 1 && x <= box.left + box.width + 1
            && y >= box.top - 1 && y <= box.top + box.height + 1;
        const cands = [];
        if (rect) {
            const cx = box.left + rect.x + Math.max(rect.w, 12) / 2;
            const cy = box.top + rect.y + Math.max(rect.h, 12) / 2;
            // 帧内 rect 与盒模型必须来自同一个组件：不同帧（或跨帧偏移）会算出盒外的点，
            // 点了等于没点，所以盒外一律丢弃
            if (inside(cx, cy)) cands.push({ x: cx, y: cy, why: 'frame-rect' });
        }
        // 组件版式兜底：Turnstile 复选框靠左、垂直居中。两个点位交替，
        // 避免一次估错就连点 12 次同一个空处
        cands.push({ x: box.left + Math.min(24, box.width / 2), y: box.top + box.height / 2, why: 'left-center' });
        cands.push({ x: box.left + Math.min(40, box.width * 0.16), y: box.top + box.height / 2, why: 'left-center-2' });
        cands.push({ x: box.left + box.width * 0.3, y: box.top + box.height * 0.5, why: 'mid' });
        const usable = cands.filter((c) => inside(c.x, c.y));
        const pick = usable[(attempt - 1) % Math.max(usable.length, 1)] || usable[0];
        if (!pick) {
            log(`盒模型不可用（组件盒 ${Math.round(box.width)}x${Math.round(box.height)} 太小）→ 改走帧内直点`);
        } else {
            log(`点击点 ${pick.why}（候选 ${usable.length} 个，第 ${((attempt - 1) % usable.length) + 1} 个）`);
            await clickByMouse(wc, pick.x, pick.y, log);
            return probed;
        }
    }
    log('CDP 与 host 扫描都拿不到盒模型 → frame-js click');

    // 路径 c：子帧内 JS 直点
    const clicked = await probeTurnstileFrame(wc, { click: true, log });
    if (clicked) log('frame-js clicked');

    // 路径 d：键盘（Turnstile 复选框可键盘激活）
    if (attempt >= 2) {
        await pressKeys(wc, log);
    }
    return probed || clicked;
}

// 主入口：加载 url，自动通过 CF 挑战，返回最终页面。
async function solveChallengeWithBrowser(options) {
    const {
        url,
        isChallengePage,
        isErrorPage,
        deadlineMs = 150000,
        pollMs = 700,
        firstActivationDelayMs = 6000,
        activationCooldownMs = 4000,
        maxActivations = 12,
        // 挑战页静置多久仍没放行就主动点一次。CF 的静默校验本身只要几秒；
        // 需要交互时它会一直等着不点，所以这个值不能设大（旧值是"永远不点"）。
        silentStallMs = 10000,
        frameProbeEveryMs = 2500,
        log = () => { },
    } = options;

    const workArea = screen.getPrimaryDisplay().workArea;
    const W = 520;
    const H = 600;
    const win = new BrowserWindow({
        width: W,
        height: H,
        x: Math.max(workArea.x, workArea.x + workArea.width - W - 32),
        y: Math.max(workArea.y, workArea.y + workArea.height - H - 48),
        title: '站点验证中（自动进行，无需操作）',
        show: false,
        skipTaskbar: true,
        webPreferences: { contextIsolation: true, backgroundThrottling: false },
    });
    const wc = win.webContents;
    const result = { html: '', finalUrl: url, userAgent: wc.getUserAgent() };

    let retryLoads = 0;
    const retryLoad = (why) => {
        if (retryLoads >= 6 || win.isDestroyed()) return;
        retryLoads += 1;
        log(`${why} → 自动重载（第${retryLoads}次）`);
        setTimeout(() => {
            if (!win.isDestroyed()) win.loadURL(url).catch(() => { });
        }, 1500);
    };
    let lastLoadFailure = '';
    wc.on('did-fail-load', (_e, code, desc, _failedUrl, isMainFrame) => {
        // -3 = ERR_ABORTED（302/主动取消，不是错误）
        if (!isMainFrame || code === -3) return;
        lastLoadFailure = `${code} ${desc}`;
        retryLoad(`加载失败(${code} ${desc})`);
    });

    try {
        win.loadURL(url).catch(() => { });
        win.showInactive();

        const startedAt = Date.now();
        const deadline = startedAt + deadlineMs;
        let lastPhase = '';
        // interactive 判据来自**子帧**，顶层文本变化不足以记账，所以单独存一个时间点
        let interactiveSeenAt = 0;
        let challengeSeenAt = 0;
        let lastPhaseSeen = '';
        let frameProbedAt = 0;
        let frameInteractive = false;
        let activationCount = 0;
        let lastActivationAt = 0;
        let errorStrikes = 0;
        let lastReloadAt = 0;
        let prevHtmlLen = -1;
        let blankStrikes = 0;
        let stallStrikes = 0;
        let truncStrikes = 0;
        // 站点域 cf_clearance 一到手就主动重发一次请求（次数封顶，见循环内注释）
        let clrReloads = 0;
        let clrNextCheck = 0;

        while (Date.now() < deadline) {
            await wait(pollMs);
            if (win.isDestroyed()) throw new Error('验证窗口被关闭，请重试');
            /**
             * 代理/网络根本不通时别坐到死线上。
             * 实测：白鲸没开（10810 无监听）时全站 6 次重载全是 ERR_PROXY_CONNECTION_FAILED，
             * 一个字节都没拿到，却还要空转到 120s 才报"请检查网络"——
             * 现象看起来像"验证卡住"，实际是"根本没连上"，报成验证失败会把人往 solver 里带。
             */
            if (retryLoads >= 6 && lastLoadFailure && !result.html) {
                throw new Error(
                    `站点页面一次都没加载出来（连续 6 次失败：${lastLoadFailure}）。`
                    + '这不是验证没过，是网络/代理没连通，请先确认代理在跑'
                );
            }
            const st = await withTimeout(readPageState(wc), 6000, null);
            if (!st) continue;
            result.finalUrl = st.url || result.finalUrl;
            const html = st.html;
            if (html.length < 500) {
                // 帧没提交/白屏挂起（代理瞬时抖动常见）：持续空白就重载
                blankStrikes += 1;
                if (blankStrikes >= 12) {
                    blankStrikes = 0;
                    retryLoad('页面空白/未提交');
                }
                continue;
            }
            blankStrikes = 0;
            // 流式加载卡死看门狗：解析中但长度长时间不变 → 重载
            if (st.ready !== 'complete' && html.length === prevHtmlLen) {
                stallStrikes += 1;
                if (stallStrikes >= 14) {
                    stallStrikes = 0;
                    retryLoad('文档长时间未加载完成');
                    prevHtmlLen = -1;
                    continue;
                }
            } else {
                stallStrikes = 0;
            }

            if (!isChallengePage(html)) {
                if (isErrorPage && isErrorPage(html)) {
                    if (lastPhase !== 'cf-error') log(`CF 错误页: ${st.title.slice(0, 60)}`);
                    lastPhase = 'cf-error';
                    errorStrikes += 1;
                    if (errorStrikes >= 3 && Date.now() - lastReloadAt > 8000) {
                        errorStrikes = 0;
                        lastReloadAt = Date.now();
                        win.loadURL(result.finalUrl).catch(() => { });
                    }
                    continue;
                }
                if (html.length > 2000) {
                    // 放行瞬间文档可能还在流式加载（标题已到、列表还没流完）：
                    // 必须同一时刻的 readyState=complete 且 HTML 长度连续两次不变，
                    // 否则会把半截页当结果返回（解析出 0 条）
                    if (st.ready !== 'complete') {
                        if (lastPhase !== 'settling') log(`放行，等待文档加载完成（readyState=${st.ready}）`);
                        lastPhase = 'settling';
                        prevHtmlLen = -1;
                        continue;
                    }
                    if (html.length !== prevHtmlLen) {
                        prevHtmlLen = html.length;
                        if (lastPhase !== 'settling') log('放行，等待 HTML 长度稳定');
                        lastPhase = 'settling';
                        continue;
                    }
                    if (!isProperlyClosedHtml(html)) {
                        // 半截页（代理断流）：重载重抓，绝不把残页当结果返回
                        truncStrikes += 1;
                        if (lastPhase !== 'truncated') log(`页面被截断（${html.length} 字节，无收尾标签）→ 重新加载`);
                        lastPhase = 'truncated';
                        if (truncStrikes >= 2) {
                            truncStrikes = 0;
                            prevHtmlLen = -1;
                            retryLoad('页面截断');
                        }
                        continue;
                    }
                    log(`放行成功（${Math.round((Date.now() - startedAt) / 1000)}s）: ${st.title.slice(0, 70)}`);
                    result.html = html;
                    return result;
                }
                continue;
            }

            const now = Date.now();
            if (!challengeSeenAt) challengeSeenAt = now;

            // 子帧实况：跨帧 JS 有成本，按窗口节流；点完一次立刻清零重探
            if (now - frameProbedAt >= frameProbeEveryMs) {
                frameProbedAt = now;
                const probe = await withTimeout(
                    probeTurnstileFrame(wc, { click: false, log: null }), 6000, null);
                if (probe) {
                    frameInteractive = INTERACTIVE_RE.test(probe.text);
                    if (probe.verified && lastPhase !== 'frame-verified') {
                        log(`子帧文案显示校验已通过：${probe.text.slice(0, 60)}`);
                        lastPhase = 'frame-verified';
                    }
                }
            }

            // 拿到站点域的 cf_clearance 就主动再请求一次。
            // 实测：点击答对以后 CF 会发 cf_clearance，但中间页的跳转由组件自己的 JS 触发，
            // 而 Electron 里那个组件经常在 verifying 之后重建（日志 verifying→initial），
            // 跳转丢在半路，页面就一直停在"请稍候…"。带着 cookie 重发，等价于 Chrome
            // 上"答对后自动刷新"那一步。次数封顶，没答上时不做无谓往返。
            if (activationCount > 0 && clrReloads < 2 && now >= clrNextCheck && !wc.isLoading()) {
                clrNextCheck = now + 4000;
                const jar = await withTimeout(
                    wc.session.cookies.get({ name: 'cf_clearance', url }).catch(() => null), 1500, null);
                if (jar && jar.length > 0) {
                    clrReloads += 1;
                    log(`已拿到站点域 cf_clearance → 带 cookie 重新请求（第${clrReloads}次）`);
                    win.loadURL(url).catch(() => { });
                    challengeSeenAt = Date.now();
                    await wait(1000);
                    continue;
                }
            }

            const interactive = isInteractiveChallengeHtml(html) || frameInteractive;
            const verifying = isVerifyingHtml(html);
            const phase = interactive ? 'interactive' : verifying ? 'verifying' : 'initial';
            lastPhaseSeen = phase;
            if (phase !== lastPhase) {
                log(`phase=${phase} title=${st.title.slice(0, 50)}`);
                if (phase === 'interactive' && !interactiveSeenAt) interactiveSeenAt = now;
                lastPhase = phase;
            }

            // 优先走"识别到验证组件"这条快路。顶层与子帧都认不出文案时（CF 换 UI、
            // 子帧跨进程读不到都会这样），挑战页静置超过 silentStallMs 仍不放行，
            // 就按"CF 在等一次点击"处理——点击坐标只从 Turnstile 组件盒算出，
            // 组件不在页面上时拿不到盒模型，最坏是一次落在空白处的点击，
            // 不会打断 CF 自己的静默校验。
            if (!interactive && now - challengeSeenAt < silentStallMs) continue;
            const waited = (interactive && interactiveSeenAt ? now - interactiveSeenAt : now - challengeSeenAt)
                - (interactive ? firstActivationDelayMs : 0);
            if (waited < 0) continue;
            if (activationCount >= maxActivations) {
                if (lastPhase !== 'exhausted') {
                    log(`自动点击次数用尽（${maxActivations} 次），继续等待放行`);
                    lastPhase = 'exhausted';
                }
                continue;
            }
            if (now - lastActivationAt < activationCooldownMs) continue;

            activationCount += 1;
            lastActivationAt = now;
            log(`激活复选框 第${activationCount}次（${interactive
                ? '识别到验证组件'
                : `挑战页静置 ${Math.round((now - challengeSeenAt) / 1000)}s`}）`);
            await withTimeout(activateCheckbox(wc, activationCount, log), 20000, undefined);
            lastPhase = '';
            frameProbedAt = 0;
        }

        throw new Error(
            `站点验证未自动通过（Cloudflare 挑战 ${Math.round((Date.now() - startedAt) / 1000)}s 未放行，`
            + `已自动点击 ${activationCount} 次，最后状态=${lastPhaseSeen || '未知'}）。`
            + '请检查网络（代理/VPN）后重试'
        );
    } finally {
        if (!win.isDestroyed()) win.close();
    }
}

module.exports = {
    solveChallengeWithBrowser, isVerifyingHtml, isInteractiveChallengeHtml,
    // 定位三件套单独导出：离线 DOM 探针可以直接量它们，
    // 不用为了测一条兜底路径去撞真实站点
    probeTurnstileFrame, findTurnstileHostBox, findTurnstileFrameBox, activateCheckbox,
};
