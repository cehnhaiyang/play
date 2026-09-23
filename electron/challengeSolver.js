// Cloudflare managed 挑战的自动通过器：全自动，无需用户点击。
//
// 状态机（轮询页面实际渲染状态驱动）：
//   1. "请稍候…"（初始挑战页）      → 等 CF 自己的静默校验跑完（真浏览器通常几秒内自动放行）
//   2. "正在验证您是否是真人"        → 校验进行中，继续等，绝不打断
//   3. "正在进行安全验证" + 复选框   → 静默校验失败，CF 要求交互：自动激活复选框
//   4. 非挑战页且非 CF 错误页        → 放行成功，返回页面 HTML
//
// 复选框激活的三条路径（依次尝试，全部走真实渲染环境）：
//   a. 跨域子帧内 JS 直点（拿不到坐标时至少能返回元素真实 rect 供路径 b 使用）
//   b. CDP 沿闭式 shadow DOM 穿透找到 Turnstile iframe 的盒模型，
//      与 a 拿到的帧内 rect 相加算出屏幕真实坐标，sendInputEvent 走真实输入管线点击
//   c. 键盘 Tab/Space（Turnstile 复选框可键盘激活）
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
const INTERACTIVE_RE = /请验证您是真人|verify you are human|确认您是真人|verify you.re human/i;

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

// 在 challenges.cloudflare.com 子帧里找复选框并尝试点击；返回帧内 rect（相对子帧视口）。
async function probeTurnstileFrame(wc, { click }) {
    const frames = collectFrames(wc.mainFrame);
    const cfFrame = frames.find((f) => /challenges\.cloudflare\.com/i.test(f.url || ''));
    if (!cfFrame) return null;
    const script = `(() => {
    const cand = document.querySelector('input[type="checkbox"], [role="checkbox"], label, .cb-lb, #challenge-stage');
    if (!cand) return null;
    const r = cand.getBoundingClientRect();
    ${click ? 'try { cand.click(); } catch (_e) {}' : ''}
    return { tag: cand.tagName, x: r.left, y: r.top, w: r.width, h: r.height };
  })()`;
    const rect = await cfFrame.executeJavaScript(script).catch(() => null);
    if (!rect) return null;
    return rect;
}

// CDP 穿透闭式 shadow DOM，取 Turnstile iframe 占位节点在顶层页面里的盒模型。
async function findTurnstileFrameBox(wc) {
    try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
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
        const { model } = await wc.debugger.sendCommand('DOM.getBoxModel', { nodeId: hits[0] });
        const quad = model && model.content;
        if (!quad || quad.length < 8) return null;
        const left = Math.min(quad[0], quad[2], quad[4], quad[6]);
        const top = Math.min(quad[1], quad[3], quad[5], quad[7]);
        const right = Math.max(quad[0], quad[2], quad[4], quad[6]);
        const bottom = Math.max(quad[1], quad[3], quad[5], quad[7]);
        return { left, top, width: right - left, height: bottom - top };
    } catch (_e) {
        return null;
    } finally {
        try { wc.debugger.detach(); } catch (_e) { /* ignore */ }
    }
}

async function clickByMouse(wc, x, y, log) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0) return false;
    log(`mouse click at (${px}, ${py})`);
    wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
    await wait(120);
    wc.sendInputEvent({ type: 'mouseMove', x: px + 2, y: py + 1 });
    await wait(120);
    wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
    await wait(80);
    wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
    return true;
}

async function activateCheckbox(wc, attempt, log) {
    // 帧内 rect：复选框相对 Turnstile 子帧视口的位置
    const rect = await probeTurnstileFrame(wc, { click: false });
    if (rect) {
        log(`frame probe: ${rect.tag} rect=(${Math.round(rect.x)},${Math.round(rect.y)}) ${Math.round(rect.w)}x${Math.round(rect.h)}`);
    }

    // 路径 a：CDP 盒模型（iframe 在顶层页面的位置） + 帧内 rect → 屏幕真实坐标，真实输入管线点击
    const box = await findTurnstileFrameBox(wc);
    if (box) {
        log(`turnstile iframe box @(${Math.round(box.left)},${Math.round(box.top)}) ${Math.round(box.width)}x${Math.round(box.height)}`);
        const rx = rect ? box.left + rect.x + Math.max(rect.w, 12) / 2 : box.left + 21;
        const ry = rect ? box.top + rect.y + Math.max(rect.h, 12) / 2 : box.top + 30;
        await clickByMouse(wc, rx, ry, log);
        return;
    }
    log('CDP box not found → frame-js click');

    // 路径 b：子帧内 JS 直点
    const clicked = await probeTurnstileFrame(wc, { click: true });
    if (clicked) log('frame-js clicked');

    // 路径 c：键盘（Turnstile 复选框可键盘激活）
    if (attempt >= 2) {
        log('keyboard Tab/Space');
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
        await wait(200);
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    }
}

// 主入口：加载 url，自动通过 CF 挑战，返回最终页面。
async function solveChallengeWithBrowser(options) {
    const {
        url,
        isChallengePage,
        isErrorPage,
        deadlineMs = 150000,
        firstActivationDelayMs = 12000,
        activationCooldownMs = 7000,
        maxActivations = 6,
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
    wc.on('did-fail-load', (_e, code, desc, _failedUrl, isMainFrame) => {
        // -3 = ERR_ABORTED（302/主动取消，不是错误）
        if (!isMainFrame || code === -3) return;
        retryLoad(`加载失败(${code} ${desc})`);
    });

    try {
        win.loadURL(url).catch(() => { });
        win.showInactive();

        const startedAt = Date.now();
        const deadline = startedAt + deadlineMs;
        let lastPhase = '';
        let interactiveFirstSeen = 0;
        let activationCount = 0;
        let lastActivationAt = 0;
        let errorStrikes = 0;
        let lastReloadAt = 0;
        let prevHtmlLen = -1;
        let blankStrikes = 0;
        let stallStrikes = 0;
        let truncStrikes = 0;

        while (Date.now() < deadline) {
            await wait(900);
            if (win.isDestroyed()) throw new Error('验证窗口被关闭，请重试');
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

            const interactive = isInteractiveChallengeHtml(html);
            const verifying = isVerifyingHtml(html);
            const phase = verifying ? 'verifying' : interactive ? 'interactive' : 'initial';
            if (phase !== lastPhase) {
                log(`phase=${phase} title=${st.title.slice(0, 50)}`);
                if (phase === 'interactive') interactiveFirstSeen = Date.now();
                lastPhase = phase;
            }

            if (phase !== 'interactive') continue;
            const now = Date.now();
            const waited = now - interactiveFirstSeen;
            if (waited < firstActivationDelayMs) continue;
            if (activationCount >= maxActivations) continue;
            if (now - lastActivationAt < activationCooldownMs) continue;

            activationCount += 1;
            lastActivationAt = now;
            log(`激活复选框 第${activationCount}次`);
            await withTimeout(activateCheckbox(wc, activationCount, log), 20000, undefined);
            lastPhase = '';
        }

        throw new Error(
            '站点验证未自动通过（Cloudflare 挑战在限时内未放行）。请检查网络（代理/VPN）后重试'
        );
    } finally {
        if (!win.isDestroyed()) win.close();
    }
}

module.exports = { solveChallengeWithBrowser, isVerifyingHtml, isInteractiveChallengeHtml };
