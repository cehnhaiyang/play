'use strict';
/**
 * ChatOpens 本地转发端口 —— 修复版
 *
 * 把站点（i.chatopens.vip）的 ChatGPT 后端包装成标准 OpenAI 接口，
 * 让 Cherry Studio / NextChat / 各类 SDK 直接接入。
 *
 * 协议还原自真实流量，不是猜的：
 *   POST /backend-api/f/conversation   accept: text/event-stream
 *   响应是 v1 delta 编码，正文增量在 {o:"append", p:"/message/content/parts/0", v:"…"}
 *
 * 启动：
 *   COOKIE="qr_code_id=…; user_id=…; platform=Sorux" node server.js
 *
 * 相对原版修复的问题（每条都有实测依据）：
 *
 * 1. **上游拒绝被吞成"成功"**（主要问题）。
 *    实测四种拒绝**全是 HTTP 200 + application/json**，正文形如
 *    {"error":"亲!使用的太频繁啦!…"} / {"error":"非法用户"} /
 *    {"detail":"当前的登录状态已过期…"} / {"detail":"请重新创建一个对话使用。…"}。
 *    原版既不读 statusCode 也不读 content-type，解析不到任何 SSE 帧，
 *    于是照常走成功分支 —— 客户端收到 **200 + 空回答**，把"掉登录/被限流"
 *    伪装成"模型没说话"，用户只会去怀疑模型或客户端配置。
 *    这里改为：先确认上游确实回了 SSE，再决定响应状态码；否则原样回报原因。
 *
 * 2. **客户端断连会拖垮进程**。原版没给 cRes 挂 error 监听，
 *    客户端中途关页面后继续 write 会抛未捕获异常。
 *
 * 3. **上游挂住就永远挂着**。原版没设超时，客户端只能一直转圈。
 *
 * 4. **缓冲区尾行被丢**。原版只处理以 \n 结尾的完整行，
 *    上游最后一行没有换行符时会被静默丢弃。
 *
 * 5. **限流是最高频的失败**（导出件里复现 5 次），原版只在文档里提了一句
 *    "建议加请求间隔/队列"却没实现。这里补一个串行队列。
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.UPSTREAM_HOST || 'i.chatopens.vip';
const COOKIE = process.env.COOKIE || '';
const DEVICE = process.env.OAI_DEVICE || 'a47f1bac-28fd-49e0-b2f6-ff5e16be5abb';

/** 上游路径。注意：站点自身用的是 /backend-api/conversation，两者都通，f/ 是前端实际发的 */
const UPSTREAM_PATH = process.env.UPSTREAM_PATH || '/backend-api/f/conversation';

/** 上游整体超时。站点偶发挂住（实测 504 时会回一整页 HTML），不给超时就是无限等待 */
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 180000);

/**
 * 两次上游调用之间的最小间隔（毫秒）。
 *
 * 站点按账号限速，并发打过去只会一起拿到"使用的太频繁"。
 * 实测间隔 1.5s 时连续三次调用仍会被限，所以默认给 2s；
 * 会员节点可调小，设为 0 表示不限间隔（但仍然串行）。
 */
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 2000);

/** 上游错误体的读取上限：504 会回一整页 HTML，全收下来没有意义 */
const ERROR_BODY_LIMIT = 4096;

/* -------------------------------------------------------------------------- */
/*                                  模型清单                                   */
/* -------------------------------------------------------------------------- */

/**
 * 站点可用模型 slug —— 实测来自 `/backend-api/models`，共 24 个。
 *
 * 这些是**上游认的原始值**，不能想当然改大小写或空格
 * （`GPT-5.2 Pro` 带空格、`GLM-5.2 渠道二` 带中文，都照抄）。
 */
const SITE_MODELS = [
    'gpt-5-5', 'gpt-5-6-thinking', 'GPT-5.2 Pro', 'GPT-5.5 codex', 'GPT-image 2.5',
    'DeepSeek-V4-Pro', 'DeepSeek-V4-flash', 'GLM-5.2', 'GLM-5.2 渠道二',
    'Kimi-K2.6-thinking', 'Minimax-M2.7', 'Gemma-4', 'Nano-Banana 2',
    'Gemini-3.1-Pro', 'Gemini-3.1-Pro-api', 'Gemini-3.1-Pro-canvas',
    'Gemini-3.1-Pro-deepsearch', 'Gemini-3.8-thinking', 'Gemini-3.8-thinking-api',
    'Gemini-3.8-flash', 'Grok-4.7', 'Grok-4.7-thinking', 'Grok-4.7-Deepsearch',
    'Grok-4.6-thinking',
];

/**
 * 常用写法的别名。
 *
 * 客户端习惯写 `gpt-5.5` / `gemini-3.1-pro`（点号、全小写），
 * 而上游只认 `gpt-5-5` / `Gemini-3.1-Pro`。不归一的话用户会收到
 * "模型不存在"，而错误里不会告诉他正确写法。
 */
const MODEL_ALIAS = {
    'gpt-5.5': 'gpt-5-5',
    'gpt-5.5-thinking': 'gpt-5-6-thinking',
    'gpt-5.6-thinking': 'gpt-5-6-thinking',
    'gpt-5.2-pro': 'GPT-5.2 Pro',
    'gpt-5.5-codex': 'GPT-5.5 codex',
    'gpt-image-2.5': 'GPT-image 2.5',
    'deepseek-v4-pro': 'DeepSeek-V4-Pro',
    'deepseek-v4-flash': 'DeepSeek-V4-flash',
    'glm-5.2': 'GLM-5.2',
    'kimi-k2.6-thinking': 'Kimi-K2.6-thinking',
    'minimax-m2.7': 'Minimax-M2.7',
    'gemma-4': 'Gemma-4',
    'nano-banana-2': 'Nano-Banana 2',
    'gemini-3.1-pro': 'Gemini-3.1-Pro',
    'gemini-3.1-flash': 'Gemini-3.8-flash',
    'gemini-3.8-flash': 'Gemini-3.8-flash',
    'gemini-3.8-thinking': 'Gemini-3.8-thinking',
    'grok-4.7': 'Grok-4.7',
    'grok-4.7-thinking': 'Grok-4.7-thinking',
};

/** 把客户端给的模型名解析成上游 slug；未知的原样透传（上游会给出它的报错） */
const resolveModel = (raw) => {
    const name = String(raw || '').trim();
    if (!name) return 'gpt-5-5';
    if (MODEL_ALIAS[name]) return MODEL_ALIAS[name];
    const lower = name.toLowerCase();
    if (MODEL_ALIAS[lower]) return MODEL_ALIAS[lower];
    const hit = SITE_MODELS.find((m) => m.toLowerCase() === lower);
    return hit || name;
};

/* -------------------------------------------------------------------------- */
/*                                 上游调用                                    */
/* -------------------------------------------------------------------------- */

/**
 * 组装上游请求体。
 *
 * `messages` 只取**最后一条**，这是站点自身的形态（实测它每次只发新消息，
 * 上下文靠 conversation_id + parent_message_id 维持），不是偷懒。
 * 代价：标准 OpenAI 客户端不会发那两个顶层字段，所以它们接进来时每轮都是新会话。
 * 这是"忠实还原站点协议"与"完全兼容 OpenAI 语义"之间的取舍，选了前者。
 */
const buildBody = (model, messages, convId, parentId) => {
    const last = messages[messages.length - 1] || {};
    const parts = typeof last.content === 'string'
        ? [last.content]
        : (Array.isArray(last.content)
            ? last.content.map((c) => (c && c.text) || '').filter(Boolean)
            : ['']);

    return {
        action: 'next',
        messages: [{
            id: crypto.randomUUID(),
            author: { role: 'user' },
            create_time: Date.now() / 1000,
            content: { content_type: 'text', parts },
            metadata: {
                developer_mode_connector_ids: [], selected_sources: [],
                selected_github_repos: [], selected_all_github_repos: false,
                serialization_metadata: { custom_symbol_offsets: [] },
            },
        }],
        conversation_id: convId || null,
        parent_message_id: parentId || 'client-created-root',
        model,
        timezone_offset_min: -new Date().getTimezoneOffset(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
        conversation_mode: { kind: 'primary_assistant' },
        enable_message_followups: true,
        system_hints: [],
        supports_buffering: true,
        supported_encodings: ['v1'],
        client_contextual_info: {
            is_dark_mode: false, time_since_loaded: 1,
            page_height: 600, page_width: 1200, pixel_ratio: 1,
            screen_height: 800, screen_width: 1200, app_name: 'chatgpt.com',
        },
        paragen_cot_summary_display_override: 'allow',
        force_parallel_switch: 'auto',
    };
};

/**
 * 把上游的拒绝体翻译成一句人能看懂的话。
 *
 * 四种拒绝的正文在实测里都出现过，这里按特征给一句"该怎么办"。
 * 分类只影响提示语，**不改变"必须报错"这个结论** —— 认不出来的也照样报。
 */
const explainUpstream = (status, contentType, body) => {
    const text = String(body || '').trim();
    let detail = text;

    try {
        const parsed = JSON.parse(text);
        const picked = parsed && (parsed.error || parsed.detail);
        if (typeof picked === 'string' && picked) detail = picked;
    } catch { /* 不是 JSON：原样用（实测 504 会回一整页 HTML） */ }

    if (detail.length > 300) detail = `${detail.slice(0, 300)}…`;

    let hint = '';
    if (/太频繁|频繁/.test(detail)) {
        hint = '上游限流。降低调用频率，或把 MIN_INTERVAL_MS 调大。';
    } else if (/非法用户/.test(detail)) {
        hint = '该 user_id 未被上游接受。cookie 里的 user_id 可能无效，或没走过 /codetoken 引导。';
    } else if (/登录状态已过期|重新登录/.test(detail)) {
        hint = '登录态已过期。在浏览器里重新登录站点，再取一份新 cookie。';
    } else if (/重新创建一个对话/.test(detail)) {
        hint = '会话已失效。不要复用旧的 conversation_id / parent_message_id，改用新会话。';
    } else if (!/event-stream/.test(contentType)) {
        hint = `上游没有返回 SSE（content-type: ${contentType || '空'}）。`;
    }

    return { status, detail: detail || '(上游返回空响应体)', hint, raw: text.slice(0, 1000) };
};

/**
 * 调一次上游。返回 Promise，resolve 出 {conversationId, lastMsgId, text}。
 *
 * @param onOpen  上游**确认可用**（真的回了 SSE）时回调一次。
 *                调用方要等这个信号才写响应头 —— 这正是修复 1 的关键：
 *                头一旦发出去状态码就定死了，而"上游是否可用"必须在这之前知道。
 * @param onDelta 每个正文增量回调一次
 * @param ctl     出参：填入 {abort()}，供调用方在客户端断连时掐断上游
 */
const callSite = ({ model, messages, convId, parentId, onOpen, onDelta, ctl }) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(buildBody(model, messages, convId, parentId));
    const fail = (info) => reject(Object.assign(new Error(info.detail), { upstream: info }));

    const req = https.request({
        host: HOST,
        path: UPSTREAM_PATH,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: COOKIE,
            'OAI-Device-Id': DEVICE,
            'OAI-Language': 'zh-CN',
            accept: 'text/event-stream',
            'Content-Length': Buffer.byteLength(payload),
        },
    }, (res) => {
        const contentType = String(res.headers['content-type'] || '');

        /**
         * 修复 1：先判"这是不是一次成功的 SSE"。
         *
         * 实测的四种拒绝全是 200 + application/json，所以**只看 statusCode 不够**，
         * 必须连 content-type 一起判。判定失败时把整个响应体收下来当错误原因。
         */
        if (res.statusCode !== 200 || !contentType.includes('event-stream')) {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                if (body.length < ERROR_BODY_LIMIT) body += chunk;
            });
            res.on('end', () => fail(explainUpstream(res.statusCode, contentType, body)));
            // 上游半路断开也要有结论，否则这个 Promise 永远不 settle
            res.on('error', () => fail(explainUpstream(res.statusCode, contentType, body)));
            return;
        }

        onOpen();

        let buf = '';
        let text = '';
        let outConv = convId;
        let lastId = parentId;
        let failed = null;

        const handleLine = (line) => {
            if (!line.startsWith('data:')) return;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]' || raw[0] !== '{') return;

            let frame;
            try { frame = JSON.parse(raw); } catch { return; }

            if (frame.conversation_id) outConv = frame.conversation_id;

            // 兜底：万一上游改用 SSE 事件回错误，别把它当成正常帧吃掉
            if (frame.error) {
                failed = explainUpstream(200, contentType, raw);
                return;
            }

            // 正文增量：路径必须限定在 parts/0，否则会把 /message/status 之类
            // 的 append（值形如 "finished_successfully"）也拼进正文
            if (frame.o === 'append' && typeof frame.p === 'string'
                && frame.p.startsWith('/message/content/parts/0') && typeof frame.v === 'string') {
                text += frame.v;
                onDelta(frame.v);
                return;
            }

            // 完整消息快照（o:"add" / 无 o 的 {c,v} 帧）：抓助手消息 id 供下一轮当 parent。
            // parts 只在还没有增量时兜底使用 —— 正常流里正文是逐段 append 来的。
            const msg = (frame.v && frame.v.message) ? frame.v.message : (frame.message || null);
            if (msg && msg.author && msg.author.role === 'assistant') {
                if (msg.id) lastId = msg.id;
                const parts = msg.content && msg.content.parts;
                if (Array.isArray(parts) && parts.length && !text) text = parts.join('');
            }
        };

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                handleLine(buf.slice(0, idx));
                buf = buf.slice(idx + 1);
            }
        });

        res.on('end', () => {
            // 修复 4：尾行可能没有换行符收尾，丢掉它等于丢掉最后一段正文
            if (buf.trim()) handleLine(buf);
            if (failed) fail(failed);
            else resolve({ conversationId: outConv, lastMsgId: lastId, text });
        });

        res.on('error', (e) => fail(explainUpstream(200, contentType, String(e && e.message || e))));
    });

    req.on('error', (e) => reject(Object.assign(
        new Error(`连接上游失败：${e && e.message ? e.message : e}`),
        { upstream: { status: 502, detail: `连接上游失败：${e && e.message ? e.message : e}`, hint: '检查网络与 UPSTREAM_HOST。', raw: '' } },
    )));

    // 修复 3：上游挂住不能无限等
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
        req.destroy(new Error(`上游 ${UPSTREAM_TIMEOUT_MS}ms 未响应`));
    });

    ctl.abort = () => req.destroy(new Error('客户端已断开'));

    req.write(payload);
    req.end();
});

/* -------------------------------------------------------------------------- */
/*                                串行队列                                     */
/* -------------------------------------------------------------------------- */

/**
 * 修复 5：上游调用串行化，两次之间留最小间隔。
 *
 * 站点按账号限速，"使用的太频繁"是实测里出现最多的失败。
 * 并发发出去只会一起被拒，排队反而吞吐更高（至少前面的能成功）。
 * 队列自身不能因为某一次失败而断掉，所以链上挂的是"吞掉异常"的版本。
 */
let queueTail = Promise.resolve();
let lastCallAt = 0;

const enqueue = (task) => {
    const run = queueTail.then(async () => {
        const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastCallAt = Date.now();
        return task();
    });
    queueTail = run.then(() => undefined, () => undefined);
    return run;
};

/* -------------------------------------------------------------------------- */
/*                                  HTTP 层                                    */
/* -------------------------------------------------------------------------- */

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/** 统一错误响应。状态码取上游的，取不到就 502 */
const sendError = (res, status, message, hint) => {
    if (res.headersSent || res.writableEnded) return;
    const code = status >= 400 && status < 600 ? status : 502;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
        error: { message: hint ? `${message}（${hint}）` : message, type: 'upstream_error', code },
    }));
};

const server = http.createServer((cReq, cRes) => {
    cRes.setHeader('Access-Control-Allow-Origin', '*');
    cRes.setHeader('Access-Control-Allow-Headers', '*');
    cRes.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (cReq.method === 'OPTIONS') return cRes.end();

    if (cReq.url.startsWith('/v1/models')) {
        return cRes.end(JSON.stringify({
            object: 'list',
            data: SITE_MODELS.map((id) => ({ id, object: 'model', owned_by: 'chatopens' })),
        }));
    }

    if (!cReq.url.startsWith('/v1/chat/completions') || cReq.method !== 'POST') {
        cRes.writeHead(404, { 'Content-Type': 'application/json' });
        return cRes.end('{"error":{"message":"not found"}}');
    }

    if (!COOKIE) {
        return sendError(cRes, 500, '未配置 COOKIE 环境变量', 'COOKIE="…" node server.js');
    }

    let body = '';
    cReq.on('data', (d) => {
        body += d;
        // 本地端口也不该被一个超大请求打爆内存
        if (body.length > 4_000_000) cReq.destroy();
    });

    cReq.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
            return sendError(cRes, 400, '请求体不是合法 JSON');
        }

        const model = resolveModel(payload.model);
        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        const wantStream = !!payload.stream;
        const id = `chatcmpl-${crypto.randomUUID()}`;

        // 修复 2：客户端断连后不再往一个死掉的 socket 上写
        let clientGone = false;
        cRes.on('close', () => { clientGone = true; });
        cRes.on('error', () => { clientGone = true; });

        const ctl = { abort: () => {} };
        cRes.on('close', () => { if (clientGone) ctl.abort(); });

        let opened = false;
        const openStream = () => {
            if (opened || clientGone) return;
            opened = true;
            cRes.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            });
        };

        enqueue(() => callSite({
            model,
            messages,
            convId: payload.conversation_id || null,
            parentId: payload.parent_message_id || null,
            ctl,
            // 上游确认可用之后才写头：这样"上游拒绝"还能以一个诚实的错误码返回
            onOpen: () => { if (wantStream) openStream(); },
            onDelta: (delta) => {
                if (!wantStream || clientGone) return;
                cRes.write(sse({
                    id, object: 'chat.completion.chunk', model,
                    choices: [{ delta: { content: delta }, index: 0 }],
                }));
            },
        })).then((info) => {
            if (clientGone) return;

            if (!wantStream) {
                return cRes.end(JSON.stringify({
                    id, object: 'chat.completion', model,
                    conversation_id: info.conversationId,
                    parent_message_id: info.lastMsgId,
                    choices: [{
                        index: 0, finish_reason: 'stop',
                        message: { role: 'assistant', content: info.text },
                    }],
                }));
            }

            // 上游一帧正文都没发但也没报错（空回复）：仍要给出合法的 SSE 收尾，
            // 否则客户端会一直等下去
            openStream();
            cRes.write(sse({
                id, object: 'chat.completion.chunk', model,
                choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
                conversation_id: info.conversationId,
                parent_message_id: info.lastMsgId,
            }));
            cRes.write('data: [DONE]\n\n');
            cRes.end();
        }).catch((err) => {
            if (clientGone) return;
            const info = (err && err.upstream) || { status: 502, detail: String(err && err.message || err), hint: '' };

            if (opened) {
                // 头已经发出去了，改不了状态码，只能以 SSE 事件的形式把错误交给客户端
                cRes.write(sse({ error: { message: info.detail, type: 'upstream_error' } }));
                cRes.write('data: [DONE]\n\n');
                return cRes.end();
            }
            sendError(cRes, info.status, info.detail, info.hint);
        });
    });
});

server.listen(PORT, () => {
    console.log(`forwarder on http://127.0.0.1:${PORT}`);
    console.log(`上游 ${HOST}${UPSTREAM_PATH} · 最小间隔 ${MIN_INTERVAL_MS}ms · 超时 ${UPSTREAM_TIMEOUT_MS}ms`);
    if (!COOKIE) console.warn('警告：未设置 COOKIE，所有请求都会以 500 拒绝。');
});
