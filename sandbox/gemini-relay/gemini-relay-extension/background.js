// background.js —— MV3 service worker, 只负责"带登录态取视频"
//
// 为什么下载必须由这里做(三条路都实测排除了):
//   1) page.js(主世界): 受页面 CSP 管辖; 目标域实测不回 CORS 头
//      (access-control-allow-origin 缺失, cross-origin-resource-policy: same-site),
//      跨源 fetch 必然被拦。
//   2) content script(隔离世界): MV3 起跨源 fetch 按页面来源处理, 同样受 CORS 限制。
//   3) Node(relay): 没有登录 cookie, 实测取回 "Sign in - Google Accounts" 登录页
//      (HTTP 200 + text/html), 不是视频。
//   只有扩展 service worker 凭 host_permissions 能跨源取数, 且浏览器会自动附上
//   HttpOnly 的 Google 会话 cookie(JS 读不到, 但请求会带上)。
//
// 为什么收到消息后立刻回执、再异步干活:
//   上一版把 sendResponse 留到下载结束才调, 结果卡住时内容脚本只能报"没响应",
//   查不出卡在哪一步。现在立即回执 + 每一步 POST 上报, 任何一步失败都能定位。
//
// 为什么流式上传并报告进度:
//   实测该响应不带 content-length, 且视频体积不小。既不能整块 arrayBuffer()
//   (读满前就可能被 MV3 回收 —— 实测卡在 fetched 后再无下文), 也需要看得见字节
//   有没有在流动, 否则"慢"和"卡死"分不清。故用 TransformStream 边计数边转发。
//
// 数据流: bridge 派发 {url,id} -> 本文件取视频 -> 流式 POST 到 relay /upload
//   -> relay 落盘并回路径 -> relay 直接回应最初的 /download 请求。
// relay 地址: bridge 探测到端口后随 dl 消息传入(msg.relay); 此处仅为兜底默认。
//   端口写死是历史 bug: relay 默认 8787、被占才顺延, 而扩展曾写死 8788 → 永远检测不到。
let RELAY = 'http://127.0.0.1:8787';
const PROGRESS_STEP = 2 * 1024 * 1024;   // 每涨 2MB 报一次进度

// 分阶段上报: 失败也要报, 不能让 relay 那边干等。
//   keepalive 让请求在 worker 被回收时也能发出。
function stage(id, name, detail) {
    try {
        const q = RELAY + '/dlstage?id=' + encodeURIComponent(id) +
            '&stage=' + encodeURIComponent(name) +
            '&detail=' + encodeURIComponent(String(detail === undefined ? '' : detail).slice(0, 300));
        fetch(q, { method: 'POST', keepalive: true }).catch(function () { });
    } catch (e) { }
    console.log('[gemini-relay-sw] ' + id + ' ' + name + ' ' + (detail || ''));
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    // ping: 同步立即回, 用于确认 worker 是否可达(不活动状态也能被唤醒)
    if (msg.type === 'ping') { sendResponse({ ok: true, alive: true, at: Date.now() }); return; }
    if (msg.type !== 'dl') return;
    // 立即回执: 让内容脚本不必等下载完成, 也避免"卡住=没响应"这种查不出原因的失败
    sendResponse({ ok: true, started: true, at: Date.now() });
    doDownload(msg);   // 不 await, 进度走 /dlstage
    return;            // 已同步回复, 不需要保持通道
});

async function doDownload(m) {
    const id = m.id || '?';
    // 用 bridge 探测到的真实端口覆盖兜底值: 之后所有 /dlstage 与 /upload 都走它
    if (m.relay) RELAY = String(m.relay);
    // total 必须声明在 try 之外: catch 里要用它区分"一个字节都没走"与"走了一半才断",
    //   而 let 是块级作用域, 放在 try 里 catch 根本看不到。
    let total = 0;
    try {
        stage(id, 'start', m.url ? m.url.slice(0, 80) : '(无 url)');
        const r = await fetch(m.url, { credentials: 'include' });
        const ct = r.headers.get('content-type') || '';
        const len = r.headers.get('content-length') || '(无)';
        stage(id, 'fetched', 'status=' + r.status + ' ct=' + ct + ' len=' + len);
        // 拿到登录页而不是视频 = cookie 没生效或链接过期, 必须报出来,
        //   否则会把一页 HTML 当 mp4 存盘(实测未带 cookie 时正是如此)。
        if (!r.ok || /text\/html/i.test(ct)) {
            stage(id, 'fail', '非视频内容 status=' + r.status + ' ct=' + ct);
            return;
        }

        // 先读完整个响应体再上传 —— 与"一次性 arrayBuffer()"的区别: 这里自己按块累积
        //   并上报进度, 于是"读得慢/读不动"与"上传失败"能分清。
        // 为什么不用 duplex:'half' 流式: 实测它在 MV3 worker 里直接抛
        //   "Failed to fetch" 且 @total=0(一个字节都没发出), relay 侧完全没收到请求。
        stage(id, 'reading', 'chunked read');
        let lastReport = 0;
        const reader = r.body.getReader();
        const chunks = [];
        for (;;) {
            const step = await reader.read();
            if (step.done) break;
            chunks.push(step.value);
            total += step.value.byteLength;
            if (total - lastReport >= PROGRESS_STEP) {
                lastReport = total;
                stage(id, 'progress', Math.round(total / 1048576) + 'MB');
            }
        }
        stage(id, 'read-done', total + ' bytes in ' + chunks.length + ' chunks');

        const blob = new Blob(chunks, { type: ct || 'application/octet-stream' });
        const q = RELAY + '/upload?id=' + encodeURIComponent(id) +
            '&name=' + encodeURIComponent(m.name || 'video.mp4') +
            '&ct=' + encodeURIComponent(ct);
        const up = await fetch(q, {
            method: 'POST',
            body: blob,
            headers: { 'content-type': ct || 'application/octet-stream' },
        });
        let saved = null;
        try { saved = await up.json(); } catch (e) { saved = { ok: false, err: 'relay 响应非 JSON' }; }
        stage(id, 'uploaded', JSON.stringify(saved).slice(0, 200));
    } catch (e) {
        stage(id, 'error', ((e && e.message) || String(e)) + ' @total=' + total);
    }
}
