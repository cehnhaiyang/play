'use strict';
// Gemini 转发器 (Node 18+, 零依赖, 无凭据)
// 架构: 前端 -> 本服务(SSE/路由) -> 浏览器扩展 -> Gemini 网页端
// 依据: Agent对话_gemini网页端_不带思考_20261014171053.md 记录 126
//
// 为什么必须走浏览器扩展而不是"页面控制台粘脚本":
//   页面控制台受 Gemini 的 CSP 管辖, connect-src 白名单里没有任何非 Google 域名,
//   连 127.0.0.1 会被浏览器直接拒绝("violates the following Content Security Policy directive")。
//   扩展内容脚本运行在隔离世界, 不受页面 CSP 约束, 这是唯一可行通道。
//
// 为什么用长轮询而不是 SSE:
//   扩展侧若走 Service Worker, MV3 下没有 EventSource; 内容脚本虽可长连接,
//   但长轮询无连接状态、断线自愈, 对"页面可能被刷新"更稳。
//
// 为什么每轮都必须由页面原生发送:
//   模型/等级/工具靠 L5adhe 写服务端会话态, 而票据(!token)由前端 SDK 逐轮加密生成,
//   下一轮的票不在上一轮响应里 —— 固定 seed 必然过期, 过期即被服务端兜底到
//   3.5 Flash-Lite 并另起会话, 参数全部失效。
const http = require('http');
const pathMod = require('path');
const fs = require('fs');
const NL = String.fromCharCode(10);
// 端口: 默认 8787, 被占则依次顺延。
// 实测踩过"进程已死但 socket 仍 LISTENING"的孤儿占用 —— taskkill/Stop-Process/.NET
//   全都看不到该 PID, 换端口是唯一无需重启机器的出路, 故这里自动顺延而非直接崩。
const PORT_CANDIDATES = process.env.RELAY_PORT
    ? [Number(process.env.RELAY_PORT)]
    : [8787, 8788, 8789, 8790];
const ROUTE_TOOL = {
    // 自造路由(保留, 向后兼容)
    '/v1': 'Canvas',
    '/v1/image': 'Create image',
    '/v1/video': 'Create video',
    // OpenAI 兼容路由: 路径与官方一致, 便于把 base_url 指过来就能用
    '/v1/chat/completions': 'Canvas',
    '/chat/completions': 'Canvas',
    '/v1/images/generations': 'Create image',
    '/images/generations': 'Create image',
};
// 哪些路由按 OpenAI 格式应答(而非内部 SSE 格式)。按路径判定, 与上面的路由表解耦。
const OPENAI_ROUTES = {
    '/v1/chat/completions': 1, '/chat/completions': 1,
    '/v1/images/generations': 1, '/images/generations': 1,
};
// 图片路由的应答体与 chat 不同: 返回 data[].url, 没有 choices。
const IMAGES_ROUTES = { '/v1/images/generations': 1, '/images/generations': 1 };

const AGENT_IDLE_MS = 40000;   // 超过这么久没有轮询即视为代理离线
const POLL_HOLD_MS = 25000;    // 长轮询挂起时长, 须明显小于上面的判定窗口
// 下载落盘目录: 与 relay.js 同级的 downloads/
const DOWNLOAD_DIR = pathMod.join(__dirname, 'downloads');

let lastPollAt = 0;
let lastBuild = null;          // 扩展上报的构建号, 用于确认"扩展是否已重载"
let lastPageBuild = null;      // page.js 上报的版本号 —— bridge 重载不代表 page.js 也重载了
let waitingPoll = null;        // 挂起中的 /agent/poll 响应
const pendingTasks = [];       // 已被创建、等待代理领取的任务 id
const dlWaiters = {};          // download 任务 id -> 等待落盘结果的 HTTP 响应
const dlStages = {};           // download 任务 id -> service worker 的分阶段进度
const tasks = {};
let seq = 0;

const sseH = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' };
// OpenAI 兼容应答头。注意: 这里**不立即 writeHead**, 因为要按 stream 决定一次性 JSON 还是 SSE。
// 下面这个对象只用于 /images/generations 这类必然非流式的场合。
const openaiH = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const openaiSseH = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'connection': 'keep-alive' };
// 浏览器扩展访问本服务属跨源; /result 用 JSON POST 会触发预检。
// allow-private-network 应对 Chrome 私有网络访问(PNA): 公开页面请求环回时浏览器会带
// Access-Control-Request-Private-Network 预检, 不回此头会被拦且报错难懂。
const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-private-network': 'true',
};

// 读取请求体。
//   必须先累积 Buffer 再一次性转字符串: 逐块 toString() 会把跨块的多字节 UTF-8 字符
//   切断成替换字符, 中文响应极易触发(实测 90KB 中文 JSON 产生 17 处乱码),
//   落在 JSON 结构或转义序列上时直接解析失败并回 400。
const read = req => new Promise(r => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => r(Buffer.concat(chunks).toString('utf8')));
});
const agentOnline = () => Date.now() - lastPollAt < AGENT_IDLE_MS;

// ── 命令行反馈 ──────────────────────────────────────────────────────────────
// 为什么需要: 前端调用此前在 relay 侧完全静默, 出了问题只能靠浏览器/curl 猜。
//   现在每个前端请求的「到达 -> 派发 -> 完成/拒绝」都在控制台留一行, 带时刻、
//   模型、耗时、实际生效模型(served)、会话 id(conv)、正文长度与链路摘要。
//   brief() 把长 prompt/链路日志压成单行, 既不刷屏也不丢关键信息。
function ts() { return new Date().toTimeString().slice(0, 8); }
function log() {
    const a = Array.prototype.slice.call(arguments);
    console.log('[' + ts() + '] ' + a.join(' '));
}
function brief(s, n) {
    s = String(s == null ? '' : s);
    var out = '', prev = false, i;
    for (i = 0; i < s.length; i++) {
        var cc = s.charCodeAt(i);
        if (cc === 32 || cc === 9 || cc === 10 || cc === 13) { if (!prev) out += ' '; prev = true; }
        else { out += s.charAt(i); prev = false; }
    }
    while (out.charAt(0) === ' ') out = out.slice(1);
    var L = out.length;
    while (L > 0 && out.charAt(L - 1) === ' ') { out = out.slice(0, L - 1); L--; }
    var lim = n || 60;
    return out.length > lim ? out.slice(0, lim) + '…(共' + out.length + '字)' : out;
}

// ── OpenAI 兼容字段映射 ─────────────────────────────────────────────────────
// 原则(用户明确要求):
//   1) 模型名不映射 —— 原样透传。前端直接传真实名(3.1 Pro 等), 不做 gpt-4o→xxx 这类猜测,
//      因为转发器并不知道用户想要哪个真实模型, 猜错比报错更糟。
//   2) 只做"必要映射": 语义等价、且转发器真能实现的字段才转。
//   3) 实现不了的参数不静默丢弃, 而是登记到 ignored 并回传给调用方 ——
//      静默会让前端以为参数生效了。
//
// 必要映射只有两项:
//   messages[]      → prompt    (唯一的会话载体, 不转就没法用)
//   reasoning_effort→ level     (low/medium/high 与思考等级语义等价)
const UNSUPPORTED = [
    'temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens',
    'n', 'stop', 'presence_penalty', 'frequency_penalty', 'logit_bias',
    'seed', 'logprobs', 'top_logprobs', 'tools', 'tool_choice',
    'response_format', 'stream_options', 'user', 'parallel_tool_calls',
    'service_tier', 'store', 'metadata', 'modalities', 'audio', 'prediction',
];
// reasoning_effort → 内部 level。OpenAI 的低中高与思考等级一一对应。
const EFFORT_TO_LEVEL = { low: 'Low', medium: 'Medium', high: 'High' };
// 兼容少数客户端用 'minimal' 表示最省
const EFFORT_ALIAS = { minimal: 'Low', none: 'Low' };
const VALID_LEVELS = { Low: 1, Medium: 1, High: 1 };

function textFromContent(c) {
    if (typeof c === 'string') return c;
    // 多模态数组: 只取文本部分。图片等附件转发器无法处理, 这里如实跳过。
    if (Array.isArray(c)) {
        var parts = [];
        for (var i = 0; i < c.length; i++) {
            var p = c[i];
            if (p && (p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string') parts.push(p.text);
            else if (p && p.type && /image|audio|file/i.test(p.type)) parts.push('[附件:' + p.type + ' 未转发]');
        }
        return parts.join('\n');
    }
    return '';
}
// messages[] → 单段 prompt。
//   为什么拼成一段: 网页端只接受一条输入, 没有 role 概念。
//   保留 role 前缀, 让模型仍能区分系统指令与用户提问。
function promptFromMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) return '';
    var parts = [];
    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (!m || typeof m !== 'object') continue;
        var role = String(m.role || 'user');
        var txt = textFromContent(m.content);
        if (!txt) continue;
        if (role === 'system' || role === 'developer') parts.push('【系统指令】\n' + txt);
        else if (role === 'assistant') parts.push('【助手先前回复】\n' + txt);
        else parts.push(txt);
    }
    return parts.join('\n\n');
}

// 把任意请求体归一化成内部字段 {prompt, model, level, ignored}
function normalize(body, isOpenAI, routeTool) {
    var ignored = [];
    var out = { prompt: '', model: '', level: '', ignored: ignored };

    if (!isOpenAI) {
        // 自造格式: 原样读取, 不做任何映射
        out.prompt = typeof body.prompt === 'string' ? body.prompt : '';
        out.model = typeof body.model === 'string' ? body.model : '';
        out.level = typeof body.level === 'string' ? body.level : '';
        for (var k in body) {
            if (k !== 'prompt' && k !== 'model' && k !== 'level') ignored.push(k);
        }
        return out;
    }

    // OpenAI 格式
    if (Array.isArray(body.messages) && body.messages.length) {
        out.prompt = promptFromMessages(body.messages);
    } else if (typeof body.prompt === 'string') {
        out.prompt = body.prompt;   // 兼容部分客户端直接给 prompt
    }
    out.model = typeof body.model === 'string' ? body.model : '';
    if (typeof body.reasoning_effort === 'string') {
        var e = body.reasoning_effort.toLowerCase();
        out.level = EFFORT_TO_LEVEL[e] || EFFORT_ALIAS[e] || '';
        if (!out.level) ignored.push('reasoning_effort=' + body.reasoning_effort + '(无法识别, 已按默认档)');
    }
    // stream 由转发器的应答格式决定, 不算被忽略(它确实被响应了)
    for (var j = 0; j < UNSUPPORTED.length; j++) {
        var f = UNSUPPORTED[j];
        if (body[f] !== undefined) ignored.push(f);
    }
    // 其余未识别的字段也如实登记, 但不含已知已处理的
    for (var kk in body) {
        if (kk === 'messages' || kk === 'model' || kk === 'stream' || kk === 'reasoning_effort' || kk === 'prompt') continue;
        if (UNSUPPORTED.indexOf(kk) >= 0) continue;
        ignored.push(kk);
    }
    return out;
}

function sse(res, event, data) {
    res.write('event: ' + event + NL + 'data: ' + JSON.stringify(data) + NL + NL);
}
// 图片路由应答: OpenAI 的 data[].url 形状。
// 取链接的现实困难: 网页端把图片信息打散在多个文本叶子里(文件名、域名+路径、签名串分行),
//   实测形如 "...jpg\nhttps://lh3.googleusercontent.com/gg-dl/<path>\n$<签名>=\nimage/jpeg"。
//   故这里用宽松正则抓 https 链接, 抓不到不报错 —— 而是把原文放进 relay.raw_text,
//   让调用方仍能拿到全部信息, 不因解析规则不匹配而丢内容。
function finishOpenAIImages(res, t, model, level, ignored) {
    const text = t.text || t.thinking || '';
    const urls = [];
    const re = /https?:\/\/[^\s"'<>\\]+/g;
    let m;
    while ((m = re.exec(text))) {
        let u = m[0].replace(/[),.;]+$/, '');
        // 图片链接通常落在 lh3/lh4/googleusercontent 或带图片扩展名
        if (/googleusercontent\.com|\.(png|jpe?g|webp|gif)(\?|$)/i.test(u)) urls.push(u);
    }
    const created = Math.floor(Date.now() / 1000);
    const payload = {
        created: created,
        data: urls.length ? urls.map(u => ({ url: u, revised_prompt: undefined }))
            : [{ url: null, revised_prompt: undefined }],
        relay: {
            requested_model: model, served_model: t.served || null, level: level,
            conv: t.conv || null,
            ignored_params: ignored && ignored.length ? ignored : undefined,
            // 解析不到链接时, 原文仍完整保留, 调用方可自行处理
            raw_text: text || undefined,
            note: urls.length ? undefined : '未从响应中解析出图片链接, 原文见 raw_text',
        },
    };
    // 同 finishOpenAI: 头部已由 handler 写过, 二次写头会导致响应永不结束。
    res.end(JSON.stringify(payload));
}

function sendJson(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
}

// ── OpenAI 兼容应答 ────────────────────────────────────────────────────────
// 两条路都要支持, 因为客户端行为不同:
//   stream:true  → 逐块 SSE(chat.completion.chunk), 最后由 [DONE] 收尾
//   否则         → 一次性 JSON(chat.completion)
// 注意: 网页端本身是"思考完再给全文", 不存在逐字流, 所以这里是一次性推一个 chunk。
//   不假装逐字流 —— 那会误导前端以为在实时输出。
function finishOpenAI(res, t, model, level, tool, route, ignored) {
    const id = 'chatcmpl-' + (t.id || 'x') + '-' + Date.now().toString(36);
    const created = Math.floor(Date.now() / 1000);
    const text = t.text || '';
    // 把转发器自己的元信息塞进非标准字段: 标准客户端会忽略未知字段,
    //   而需要自检的前端能读到实际生效的模型(served)与会话 id(conv)。
    const meta = {
        relay: {
            requested_model: model, served_model: t.served || null,
            level: level, tool: tool, route: route, conv: t.conv || null,
            ignored_params: ignored && ignored.length ? ignored : undefined,
        },
    };
    const usage = {
        // 网页端不返回 token 数, 这里给字符数近似值并如实标注字段含义
        prompt_tokens: 0,
        completion_tokens: text.length,
        total_tokens: text.length,
    };

    if (res.__stream) {
        const base = { id: id, object: 'chat.completion.chunk', created: created, model: model };
        const send = obj => res.write('data: ' + JSON.stringify(obj) + NL + NL);
        send(Object.assign({}, base, { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
        if (t.thinking) {
            // 思考内容放在非标准 delta 字段, 不污染 content
            send(Object.assign({}, base, { choices: [{ index: 0, delta: { reasoning_content: t.thinking }, finish_reason: null }], relay: meta.relay }));
        }
        if (text) send(Object.assign({}, base, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
        send(Object.assign({}, base, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usage, relay: meta.relay }));
        res.write('data: [DONE]' + NL + NL);
        res.end();
        return;
    }

    const payload = {
        id: id, object: 'chat.completion', created: created, model: model,
        choices: [{
            index: 0,
            message: Object.assign({ role: 'assistant', content: text },
                t.thinking ? { reasoning_content: t.thinking } : {}),
            finish_reason: 'stop',
        }],
        usage: usage,
    };
    Object.assign(payload, meta);
    // 头部已由 handler 写过了(它要按 stream 决定 Content-Type)。
    //   这里绝不能再次 writeHead —— 二次写头会抛 "Cannot write headers after they are sent",
    //   异常导致 res.end() 永不执行, 客户端就永久挂起(实测就是这么卡死的)。
    res.end(JSON.stringify(payload));
}

function handler(req, res) {
    const path = req.url.split('?')[0];

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    for (const k in CORS) res.setHeader(k, CORS[k]);

    // 预检: 发测试前先确认"扩展已重载到新码", 避免把旧码结果当成新码结论。
    //   EXPECT_BUILD 是 relay 侧期望的构建号, 与 bridge.js 的 BUILD 必须一致。
    if (path === '/doctor') {
        const EXPECT_BUILD = Number(process.env.EXPECT_BUILD) || 22;
        const EXPECT_PB = Number(process.env.EXPECT_PB) || 30;
        const ok = agentOnline() && lastBuild === EXPECT_BUILD && lastPageBuild === EXPECT_PB;
        const why = !agentOnline() ? '扩展未连上: 检查 gemini 页面是否打开、扩展是否已加载'
            : (lastBuild !== EXPECT_BUILD ? 'bridge.js 仍是旧码(见 build): 在 chrome://extensions 重新加载扩展'
                : (lastPageBuild !== EXPECT_PB ? 'page.js 仍是旧码(见 pb): 重载扩展后必须再刷新 gemini 页面'
                    : '就绪'));
        sendJson(res, 200, {
            ready: ok, agent: agentOnline(),
            build: lastBuild, expectBuild: EXPECT_BUILD,
            pb: lastPageBuild, expectPb: EXPECT_PB,
            hint: ok ? '就绪, 可以测试' : why,
        });
        return;
    }

    // 探活: 不开浏览器也能确认代理是否已连上
    if (path === '/status') {
        sendJson(res, 200, { agent: agentOnline(), build: lastBuild, pending: pendingTasks.length });
        return;
    }

    // 代理长轮询: 有任务立即返回, 否则挂起到 POLL_HOLD_MS 后回 204
    if (path === '/agent/poll') {
        const wasOffline = !agentOnline();
        lastPollAt = Date.now();
        const bq = /[?&]build=(\d+)/.exec(req.url || '');
        if (bq) lastBuild = Number(bq[1]);
        const pq = /[?&]pb=(\d+)/.exec(req.url || '');
        if (pq) lastPageBuild = Number(pq[1]);
        if (wasOffline) log('agent 上线 (bridge build ' + (lastBuild || '?') + ', page pb ' + (lastPageBuild || '?') + ')');
        // 跳过已被丢弃的任务
        let id = null;
        while (pendingTasks.length) {
            const x = pendingTasks.shift();
            if (tasks[x] && !tasks[x].done) { id = x; break; }
        }
        if (id) { log('[领取] ' + id + ' agent 取走任务'); sendJson(res, 200, tasks[id]); return; }
        const w = { res: res, timer: null };
        w.timer = setTimeout(() => {
            if (waitingPoll === w) { waitingPoll = null; res.writeHead(204); res.end(); }
        }, POLL_HOLD_MS);
        req.on('close', () => { clearTimeout(w.timer); if (waitingPoll === w) waitingPoll = null; });
        waitingPoll = w;
        return;
    }

    // 视频结果回捞: 视频是异步生成的(页面先回"正在生成视频, 可能需要几分钟"),
    //   单次 /v1/video 请求拿不到成品, 故提供本接口事后查询页面 DOM 里的视频链接。
    //   纯读取, 不触发生成, 可安全反复调用(建议隔几分钟重试)。
    if (path === '/videos') {
        if (!agentOnline()) { sendJson(res, 200, { available: false, note: 'browser agent offline' }); return; }
        const cq = /[?&]conv=([^&]+)/.exec(req.url || '');
        const convId = cq ? decodeURIComponent(cq[1]) : '';
        const id = 'v' + (++seq);
        tasks[id] = { id: id, videos: true, conv: convId, done: false };
        tasks[id].notify = () => {
            const t = tasks[id];
            if (!t) return;
            // bridge 回传的 text 已是 {"available":..,"report":{..}} 这一层结构,
            //   这里直接透传解析结果, 不能再套一层 report —— 否则出现
            //   {"available":true,"report":{"available":true,"report":{...}}}(实测踩过)。
            let rep = null;
            try { rep = JSON.parse(t.text || 'null'); } catch (e) { rep = { parseError: String((t.text || '').slice(0, 120)) }; }
            sendJson(res, 200, rep || { available: false, note: '空响应' });
            delete tasks[id];
        };
        const w = waitingPoll;
        if (w) { waitingPoll = null; clearTimeout(w.timer); sendJson(w.res, 200, tasks[id]); }
        else pendingTasks.push(id);
        return;
    }

    // 视频下载: 视频直链需登录态, Node 无 cookie(实测取回登录页), 故交给扩展 service worker
    //   凭 host_permissions 带 cookie 取, 再以流式 POST 回传到 /upload 落盘。
    //   纯读取+落盘, 不触发任何生成。
    if (path === '/download') {
        if (!agentOnline()) { sendJson(res, 200, { ok: false, err: 'browser agent offline' }); return; }
        const cq = /[?&]conv=([^&]+)/.exec(req.url || '');
        const nq = /[?&]name=([^&]+)/.exec(req.url || '');
        const convId = cq ? decodeURIComponent(cq[1]) : '';
        const name = nq ? decodeURIComponent(nq[1]) : 'video.mp4';
        const id = 'd' + (++seq);
        dlWaiters[id] = { res: res, name: name, done: false };
        tasks[id] = { id: id, download: true, conv: convId, name: name, done: false };
        // 安全兜底: worker 可能在下载中途被 MV3 回收, 那样 /dlstage 与 /upload 都不会再来,
        //   请求会一直挂着。到点必须给出明确失败, 而不是让调用方无限等。
        const guard = setTimeout(() => {
            const w = dlWaiters[id];
            if (w && !w.done) {
                w.done = true; delete dlWaiters[id];
                if (tasks[id]) delete tasks[id];
                sendJson(w.res, 200, { ok: false, err: '下载超时(180s): worker 可能在途中被回收', stages: dlStages[id] || [] });
            }
        }, 180000);
        dlWaiters[id].clear = () => clearTimeout(guard);
        tasks[id].notify = () => {
            const t = tasks[id];
            if (!t) return;
            let rep = null;
            try { rep = JSON.parse(t.text || 'null'); } catch (e) { rep = { ok: false, err: '回传非 JSON' }; }
            // 落盘结果以 /upload 那边为准(它才知道真实字节数与路径);
            //   这里只是兜底, 避免 worker 报错时请求悬着不响应。
            const w = dlWaiters[id];
            if (w && !w.done) {
                w.done = true; delete dlWaiters[id];
                if (w.clear) w.clear();
                if (rep && rep.worker && !rep.worker.ok) { rep.stages = dlStages[id] || []; }
                sendJson(w.res, 200, rep);
            }
            delete tasks[id];
        };
        const w = waitingPoll;
        if (w) { waitingPoll = null; clearTimeout(w.timer); sendJson(w.res, 200, tasks[id]); }
        else pendingTasks.push(id);
        return;
    }

    // service worker 的分阶段进度上报。
    //   为什么需要: 上一版 worker 只在下载结束才回复, 一旦卡住内容脚本只能报"没响应",
    //   查不出卡在哪一步。有了分阶段上报, 任何一步失败都能定位到具体阶段。
    //   stage=error|fail 视为本次下载失败, 立即让挂起的 /download 返回, 不再干等。
    if (path === '/dlstage') {
        const iq = /[?&]id=([^&]+)/.exec(req.url || '');
        const sq = /[?&]stage=([^&]+)/.exec(req.url || '');
        const dq = /[?&]detail=([^&]*)/.exec(req.url || '');
        const id = iq ? decodeURIComponent(iq[1]) : '';
        const st = sq ? decodeURIComponent(sq[1]) : '';
        const detail = dq ? decodeURIComponent(dq[1]) : '';
        if (id && st) {
            dlStages[id] = (dlStages[id] || []).concat([st + ':' + detail]);
            console.log('[dl ' + id + '] ' + st + ' ' + detail);
            if (st === 'error' || st === 'fail') {
                const w = dlWaiters[id];
                if (w && !w.done) {
                    w.done = true; delete dlWaiters[id];
                    if (w.clear) w.clear();
                    if (tasks[id]) delete tasks[id];
                    sendJson(w.res, 200, { ok: false, stage: st, err: detail, stages: dlStages[id] });
                }
            }
        }
        sendJson(res, 200, { ok: true });
        return;
    }

    // service worker 把视频字节流式送到这里落盘
    if (path === '/upload') {
        const iq = /[?&]id=([^&]+)/.exec(req.url || '');
        const nq = /[?&]name=([^&]+)/.exec(req.url || '');
        const cq = /[?&]ct=([^&]+)/.exec(req.url || '');
        const id = iq ? decodeURIComponent(iq[1]) : '';
        // 文件名白名单化: 它来自 URL, 直接拼路径可被 ../ 穿越到任意位置(自己写的服务也不能留这口子)
        let name = nq ? decodeURIComponent(nq[1]) : 'video.mp4';
        name = (name.split(/[\\/]/).pop() || 'video.mp4').replace(/[^\w.\-]/g, '_');
        if (!/\.(mp4|webm|mov|m4v)$/i.test(name)) name += '.mp4';
        const out = pathMod.join(DOWNLOAD_DIR, name);
        try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch (e) { }
        let bytes = 0;
        const ws = fs.createWriteStream(out);
        req.on('data', c => { bytes += c.length; });
        ws.on('error', e => {
            sendJson(res, 500, { ok: false, err: '写盘失败: ' + e.message });
        });
        ws.on('finish', () => {
            const r = { ok: bytes > 0, path: out, bytes: bytes, name: name, ct: cq ? decodeURIComponent(cq[1]) : '' };
            r.stages = dlStages[id] || [];
            sendJson(res, 200, r);
            const w = dlWaiters[id];
            if (w && !w.done) { w.done = true; delete dlWaiters[id]; if (w.clear) w.clear(); sendJson(w.res, 200, r); }
            if (tasks[id]) delete tasks[id];
        });
        req.pipe(ws);
        return;
    }

    // 代理回传结果
    if (path === '/result') {
        read(req).then(b => {
            let j = null;
            try {
                j = JSON.parse(b);
            } catch (e) {
                // 解析失败要记下收到的内容, 不然只知道"失败"不知道收到了什么
                console.error('[/result 解析失败] ' + e.message + ' | bytes=' + Buffer.byteLength(b || '') +
                    ' | head=' + JSON.stringify(String(b || '').slice(0, 200)));
                res.statusCode = 400; res.end('bad');
                return;
            }
            // notify() 内部会结束对外那条响应(SSE 或 OpenAI 应答), 它可能抛出
            //   "Cannot write headers after they are sent" —— 那是 notify 自己的问题,
            //   不该被算作 /result 的解析失败而回 400(实测就是这么误报的)。
            //   故这里分开 try: 回传本身成功就回 ok, notify 出错只记日志。
            const t = tasks[j.id];
            if (t) {
                t.done = true; t.thinking = j.thinking; t.text = j.text; t.served = j.served; t.rpc = j.rpc;
                t.conv = j.conv; t.sctx = j.sctx;
                const dt = ((Date.now() - (t.createdAt || Date.now())) / 1000).toFixed(1);
                log('[完成] ' + j.id + ' | served=' + (j.served || '?') + ' conv=' + (j.conv || '?') + ' | text=' + String(j.text || '').length + '字 thinking=' + String(j.thinking || '').length + '字 | 耗时' + dt + 's');
                if (j.rpc) log('[链路] ' + j.id + ' ' + brief(j.rpc, 300));
                try {
                    if (t.notify) t.notify();
                } catch (e) {
                    console.error('[/result notify 出错] ' + e.message + ' | id=' + j.id);
                }
                delete tasks[j.id];
            } else {
                log('[完成] ' + j.id + ' 无对应任务(可能已超时或重复回传)');
            }
            res.end('ok');
        });
        return;
    }

    // 对外接口: /probe 走"真实 UI 选模型 + 原生发送", 用于判定 served 判据是否可信
    const isProbe = (path === '/probe');
    const isOpenAI = !!OPENAI_ROUTES[path];
    if (!isProbe && (ROUTE_TOOL[path] === undefined || req.method !== 'POST')) { res.statusCode = 404; res.end(); return; }
    if (isProbe && req.method !== 'POST') { res.statusCode = 404; res.end(); return; }

    read(req).then(b => {
        // 解析失败必须报错, 不能静默用空 prompt 继续 —— 否则会在会话里发出一条
        // 只有标记、没有正文的消息(实测踩过: shell 吃掉引号后 JSON 非法, prompt 变空)。
        let body;
        try { body = JSON.parse(b); }
        catch (e) {
            log('[拒绝] ' + path + ' 请求体不是合法 JSON: ' + brief(b, 100));
            if (isOpenAI) {
                sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request_error', code: 'invalid_json' } });
                return;
            }
            res.writeHead(200, sseH);
            sse(res, 'error', { message: '请求体不是合法 JSON', hint: '检查引号转义; 建议把 body 写进文件后用 --data-binary @file 发送', got: b.slice(0, 120) });
            res.end();
            return;
        }

        // 字段归一化: 自造格式直读, OpenAI 格式按必要映射转换
        const N = isProbe
            ? { prompt: body.prompt || '', model: body.model || '', level: body.level || '', ignored: [] }
            : normalize(body, isOpenAI, ROUTE_TOOL[path]);
        if (!N.prompt || !N.prompt.trim()) {
            log('[拒绝] ' + path + ' prompt 为空, body=' + brief(b, 100));
            if (isOpenAI) {
                sendJson(res, 400, { error: { message: '未取到任何文本内容(messages/prompt 均为空)', type: 'invalid_request_error', code: 'empty_prompt' } });
                return;
            }
            res.writeHead(200, sseH);
            sse(res, 'error', { message: 'prompt 缺失或为空', got: JSON.stringify(body).slice(0, 120) });
            res.end();
            return;
        }
        const model = N.model || '3.8 Flash';
        const level = VALID_LEVELS[N.level] ? N.level : 'High';
        const tool = isProbe ? '(probe)' : ROUTE_TOOL[path];
        const tStart = Date.now();
        log('[请求] ' + req.method + ' ' + path + ' | model=' + model + ' level=' + level + ' tool=' + tool + ' | prompt=' + brief(N.prompt, 80) + (N.ignored && N.ignored.length ? ' | ignored=' + N.ignored.join(',') : ''));

        // 代理离线的判定必须在写头之前: 一旦写了头再 sendJson 就会抛
        //   "Cannot write headers after they are sent"(实测踩过)。
        if (!agentOnline()) {
            log('[拒绝] ' + path + ' agent 离线(扩展未连上或页面未打开)');
            if (isOpenAI) {
                sendJson(res, 503, { error: { message: 'browser agent offline: 请确认扩展已加载且 gemini.google.com 页面处于打开状态', type: 'server_error', code: 'agent_offline' } });
                return;
            }
            res.writeHead(200, sseH);
            sse(res, 'error', { message: 'browser agent offline', hint: '确认扩展已加载, 且 gemini.google.com 页面处于打开状态' });
            res.end();
            return;
        }

        // 头在这里才写: OpenAI 路由按 stream 决定应答形态
        if (isOpenAI) {
            res.__stream = !!body.stream;
            res.writeHead(200, res.__stream ? openaiSseH : openaiH);
        } else {
            res.writeHead(200, sseH);
        }

        const id = 't' + (++seq);
        tasks[id] = { id: id, model: model, level: level, tool: tool, prompt: N.prompt, done: false, createdAt: tStart };
        if (isProbe) tasks[id].probe = true;

        tasks[id].notify = () => {
            const t = tasks[id];
            if (!t) return;
            if (isOpenAI) {
                if (IMAGES_ROUTES[path]) finishOpenAIImages(res, t, model, level, N.ignored);
                else finishOpenAI(res, t, model, level, tool, path, N.ignored);
                delete tasks[id];
                return;
            }
            sse(res, 'meta', { model: model, level: level, tool: tool, route: path, served: t.served, conv: t.conv, sctx: t.sctx, rpc: t.rpc });
            sse(res, 'thinking', { full: t.thinking });
            sse(res, 'text', { full: t.text });
            sse(res, 'done', { ok: true });
            res.end();
        };

        // 有挂起中的轮询就直接派发, 否则入队等下一次轮询
        const w = waitingPoll;
        if (w) {
            waitingPoll = null;
            clearTimeout(w.timer);
            log('[派发] ' + id + ' -> agent (立即)');
            sendJson(w.res, 200, tasks[id]);
        } else {
            pendingTasks.push(id);
            log('[排队] ' + id + ' 等待 agent 轮询');
        }
    });
}

// 依次尝试候选端口, 绑定成功即停; 全失败才退出
(function bindAt(i) {
    if (i >= PORT_CANDIDATES.length) {
        console.error('所有端口均被占用: ' + PORT_CANDIDATES.join(', '));
        process.exit(1);
    }
    const port = PORT_CANDIDATES[i];
    const srv = http.createServer(handler);
    srv.once('error', e => {
        if (e.code === 'EADDRINUSE') {
            console.warn('端口 ' + port + ' 被占用, 尝试下一个');
            bindAt(i + 1);
        } else {
            console.error('监听失败: ' + e.message);
            process.exit(1);
        }
    });
    srv.listen(port, () => log('relay 已启动, 监听 http://127.0.0.1:' + port + '  (等待浏览器扩展连接…)'));
})(0);
