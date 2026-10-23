'use strict';
// Local OpenAI-compatible gateway. Relays to the arena.ai browser session.
//
// What this file is responsible for
//   1. Real logging. Every request gets a line: time, method, path, status,
//       duration, reqId, model, bytes, and (on failure) the reason. Agent
//      lifecycle, upstream traffic, timeouts and the page's own progress
//      frames (type:"log" from the extension) are logged too. LOG_LEVEL:
//      silent | error | info(default) | debug. NO_COLOR honoured when piped.
//   2. Listen failures are reported in plain words: EADDRINUSE names the port
//      and tells you what to do; the process exits non-zero instead of dying
//      silently or hanging.
//   3. Upstream errors are no longer optimistically reported as a clean stop.
//      A stream that errors now finishes with finish_reason:"error" and never
//      emits [DONE]; a non-stream request returns 502 with the agent message.
//   4. Stream chunks advertise the resolved canonical model id (same as the
//      non-stream body), not the caller's raw alias.
//   5. A peer that goes away with a bare FIN no longer leaves a zombie slot:
//      'end' and 'error' on the upgraded socket clear the agent, and
//      /health ages out a silent agent (AGENT_IDLE_MS).
//   6. CORS: the wildcard stays for convenience but credentials are refused,
//      and a non-loopback HOST produces a loud warning.
//   7. /health gains lastRequest, agentSince, agentIdleMs and a version, so a
//      caller can tell "connected but silent" from "never connected".
const http = require('http');
const crypto = require('crypto');
const { acceptKey, frame, createParser } = require('./ws');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const KEY = process.env.GATEWAY_KEY || '';
const TIMEOUT = Number(process.env.REQ_TIMEOUT || 180000);
const IDLE_MS = Number(process.env.AGENT_IDLE_MS || 0);   // 0 = never age out
const LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };
const LEVEL = LEVELS[String(process.env.LOG_LEVEL || (process.env.QUIET === '1' ? 'error' : 'info')).toLowerCase()] ?? 2;
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (COLOR ? '\u001b[' + c + 'm' + s + '\u001b[0m' : s);

let agent = null;
let agentSince = 0;
let agentLastSeen = 0;
let agentModels = [];
let agentModelsAt = 0;
let lastRequest = null;
const pending = new Map();
const startedAt = Date.now();
let seq = 0;

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}
function log(level, tag, msg, extra) {
  if (LEVEL < LEVELS[level]) return;
  const line = ts() + ' ' + (level === 'error' ? paint(31, 'ERR ') : level === 'debug' ? paint(90, 'DBG ') : paint(32, 'INF ')) +
    paint(36, '[' + tag + ']') + ' ' + msg + (extra === undefined ? '' : ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)));
  console.log(line);
}
function warn(msg, extra) {
  console.log(ts() + ' ' + paint(33, 'WRN ') + paint(36, '[gw]') + ' ' + msg + (extra === undefined ? '' : ' ' + JSON.stringify(extra)));
}

function sendToAgent(obj) {
  if (!agent) return false;
  try {
    agent.sock.write(frame(JSON.stringify(obj)));
    return true;
  } catch (e) {
    log('error', 'agent', 'write failed: ' + e.message);
    return false;
  }
}

function clearAgent(reason) {
  if (!agent) return;
  const had = agentModels.length;
  const live = Date.now() - agentSince;
  agent = null;
  agentModels = [];
  agentModelsAt = 0;
  agentSince = 0;
  agentLastSeen = 0;
  log('info', 'agent', 'disconnected (' + reason + '); dropped ' + had + ' models after ' + Math.round(live / 1000) + 's');
}

function onAgentMessage(raw) {
  agentLastSeen = Date.now();
  let m;
  try { m = JSON.parse(raw); } catch (e) {
    log('error', 'agent', 'undecodable frame from browser', raw.slice(0, 120));
    return;
  }
  if (m.type === 'hello') {
    const incoming = Array.isArray(m.models) ? m.models : [];
    const seen = new Set();
    const next = [];
    let dropped = 0;
    for (const x of incoming) {
      const id = typeof x === 'string' ? x : (x && x.id);
      if (!id || seen.has(id)) { dropped++; continue; }
      seen.add(id);
      const aliases = (x && Array.isArray(x.aliases))
        ? x.aliases.filter((a) => typeof a === 'string' && a && a !== id)
        : [];
      next.push({ id: String(id), owned_by: (x && x.owned_by) || 'arena', aliases });
    }
    const changed = next.length !== agentModels.length ||
      next.some((x, i) => !agentModels[i] || agentModels[i].id !== x.id);
    agentModels = next;
    agentModelsAt = Date.now();
    if (changed) log('info', 'agent', 'catalogue: ' + next.length + ' models' + (dropped ? ' (' + dropped + ' blank/duplicate ignored)' : ''));
    else log('debug', 'agent', 'catalogue re-sent unchanged: ' + next.length + ' models');
    if (changed) log('debug', 'agent', 'first 5 ids', next.slice(0, 5).map((x) => x.id));
    return;
  }
  if (m.type === 'ping') { sendToAgent({ type: 'pong' }); return; }
  // Progress frames from the page itself (page-hook / bridge / service worker).
  // They carry a channel name instead of a request id, and are what tells you
  // HOW FAR a request got: model switching, typing, clicking, first bytes.
  // They must be handled BEFORE the pending-request lookup.
  if (m.type === 'log') {
    log('info', 'page', '[' + (m.reqId || 'page') + '] ' + (m.text || ''));
    return;
  }
  const p = pending.get(m.reqId);
  if (!p) {
    log('debug', 'agent', 'frame for unknown/expired reqId ' + m.reqId + ' (' + m.type + ')');
    return;
  }
  if (m.type === 'delta') {
    if (typeof m.text === 'string' && m.text.length) {
      p.deltas++;
      p.bytes += Buffer.byteLength(m.text);
      if (p.onDelta) p.onDelta(m.text);
      else p.buf.push(m.text);
    }
    return;
  }
  if (m.type === 'done') {
    pending.delete(m.reqId);
    log('debug', 'agent', 'done ' + p.id + ' in ' + (Date.now() - p.t0) + 'ms, ' + p.deltas + ' deltas, ' + p.bytes + ' bytes');
    p.finish();
    return;
  }
  if (m.type === 'error') {
    pending.delete(m.reqId);
    log('error', 'agent', 'upstream error for ' + p.id + ': ' + (m.message || '(no message)'));
    p.fail(new Error(m.message || 'agent reported error'));
  }
}

function resolveModel(name) {
  const want = String(name || '').trim();
  if (!want) return null;
  for (const m of agentModels) if (m.id === want) return m;
  for (const m of agentModels) {
    if (Array.isArray(m.aliases) && m.aliases.indexOf(want) >= 0) return m;
  }
  return null;
}

function modelHint() {
  const ids = agentModels.map((m) => m.id);
  const list = ids.slice(0, 25).join(', ') + (ids.length > 25 ? ', ...' : '');
  return agentModels.length ? list : '(none: the browser has not reported a catalogue yet)';
}

function callAgent(model, content, modality, onDelta, id) {
  return new Promise((resolve, reject) => {
    if (!agent) {
      const e = new Error('no browser agent connected: open arena.ai in a tab with the extension enabled, then retry');
      e.status = 503;
      return reject(e);
    }
    const reqId = crypto.randomUUID();
    const buf = [];
    const t0 = Date.now();
    const timer = setTimeout(() => {
      pending.delete(reqId);
      log('error', 'upstream', id + ' timed out after ' + TIMEOUT + 'ms waiting for the browser');
      const e = new Error('upstream timeout after ' + TIMEOUT + 'ms: the browser opened the request but never finished it');
      e.status = 504;
      reject(e);
    }, TIMEOUT);
    pending.set(reqId, {
      buf, onDelta, id, t0, deltas: 0, bytes: 0,
      finish: () => { clearTimeout(timer); resolve(buf); },
      fail: (e) => { clearTimeout(timer); reject(e); }
    });
    log('debug', 'upstream', id + ' -> agent reqId=' + reqId + ' model=' + model + ' bytes=' + Buffer.byteLength(content));
    const ok = sendToAgent({ type: 'request', reqId, model, content, modality: modality || 'chat' });
    if (!ok) {
      pending.delete(reqId);
      clearTimeout(timer);
      const e = new Error('agent socket was closed before the request could be written');
      e.status = 503;
      reject(e);
    }
  });
}

function sendJson(res, code, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'access-control-allow-origin': '*'
  }, extraHeaders || {}));
  res.end(body);
}

function sendErr(res, code, message, type, extra) {
  sendJson(res, code, {
    error: Object.assign({ message: String(message), type: type || 'invalid_request_error', code: null, param: null }, extra || {})
  });
}

function authOk(req) {
  if (!KEY) return true;
  return (req.headers['authorization'] || '') === 'Bearer ' + KEY;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > 8 * 1024 * 1024) { req.destroy(); return reject(Object.assign(new Error('request body larger than 8 MiB'), { status: 413 })); }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((x) => (typeof x === 'string' ? x : (x && (x.text || x.content)) || '')).join('');
  }
  return '';
}

function flatten(messages) {
  if (!Array.isArray(messages)) return '';
  const out = [];
  for (const m of messages) {
    const t = textOf(m && m.content);
    if (!t) continue;
    const role = m.role || 'user';
    if (role === 'system') out.push('[system] ' + t);
    else if (role === 'assistant') out.push('[assistant] ' + t);
    else out.push(t);
  }
  return out.join('\n\n');
}

async function handleChat(req, res, ctx) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    if (e.status === 413) return sendErr(res, 413, e.message, 'invalid_request_error');
    return sendErr(res, 400, 'invalid JSON body: ' + e.message, 'invalid_request_error');
  }
  const model = String(payload.model || '').trim();
  if (!model) return sendErr(res, 400, 'missing required field: model', 'invalid_request_error', { param: 'model' });
  const content = flatten(payload.messages);
  if (!content) return sendErr(res, 400, 'missing required field: messages (no non-empty text content found)', 'invalid_request_error', { param: 'messages' });
  ctx.model = model;
  ctx.stream = payload.stream === true;
  ctx.promptBytes = Buffer.byteLength(content);

  let resolved = null;
  if (agent) {
    resolved = resolveModel(model);
    if (!resolved) {
      const msg = 'model not found: ' + model + '; the connected browser offers ' + agentModels.length + ' models (' + modelHint() + ')';
      ctx.reason = 'unknown model';
      return sendErr(res, 404, msg, 'invalid_request_error', { param: 'model' });
    }
  }
  const modelId = resolved ? resolved.id : model;
  ctx.canonical = modelId;
  if (resolved && modelId !== model) log('info', 'relay', ctx.id + ' alias ' + JSON.stringify(model) + ' -> ' + JSON.stringify(modelId));

  const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '');
  const created = Math.floor(Date.now() / 1000);

  if (payload.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*'
    });
    const base = { id, object: 'chat.completion.chunk', created, model: modelId };
    const emit = (delta, finish) => {
      const chunk = Object.assign({}, base, { choices: [{ index: 0, delta, finish_reason: finish || null }] });
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
    };
    emit({ role: 'assistant', content: '' });
    let failure = null;
    try {
      await callAgent(model, content, payload.modality, (t) => emit({ content: t }), ctx.id);
    } catch (e) {
      failure = e;
      ctx.reason = e.message;
      log('error', 'relay', ctx.id + ' stream failed: ' + e.message);
      res.write('data: ' + JSON.stringify({ error: { message: String(e.message || e), type: 'upstream_error', code: null, param: null } }) + '\n\n');
    }
    // An errored stream must not look like a clean stop: no finish_reason:stop,
    // no [DONE]. Clients that only watch finish_reason now see "error".
    emit({}, failure ? 'error' : 'stop');
    if (!failure) res.write('data: [DONE]\n\n');
    ctx.status = failure ? (failure.status || 502) : 200;
    return res.end();
  }

  try {
    const buf = await callAgent(modelId, content, payload.modality, null, ctx.id);
    const text = buf.join('');
    ctx.status = 200;
    ctx.bytes = Buffer.byteLength(text);
    return sendJson(res, 200, {
      id, object: 'chat.completion', created, model: modelId,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  } catch (e) {
    ctx.reason = e.message;
    ctx.status = e.status || 502;
    return sendErr(res, ctx.status, e.message || String(e), ctx.status === 503 ? 'service_unavailable' : 'upstream_error');
  }
}

function handleModels(res) {
  const list = agentModels.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: m.owned_by || 'arena' }));
  sendJson(res, 200, { object: 'list', data: list });
}

const server = http.createServer(async (req, res) => {
  const ctx = { id: 'req-' + (++seq), t0: Date.now(), status: 0 };
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  res.on('finish', () => {
    ctx.status = ctx.status || res.statusCode;
    lastRequest = { id: ctx.id, at: Date.now(), method: req.method, path: u.pathname, status: ctx.status, model: ctx.model || null, ms: Date.now() - ctx.t0 };
    const line = ctx.id + ' ' + req.method + ' ' + u.pathname + ' -> ' + ctx.status + ' in ' + (Date.now() - ctx.t0) + 'ms' +
      (ctx.model ? ' model=' + JSON.stringify(ctx.model) : '') +
      (ctx.canonical && ctx.canonical !== ctx.model ? ' (-> ' + JSON.stringify(ctx.canonical) + ')' : '') +
      (ctx.stream ? ' stream' : '') +
      (ctx.reason ? ' reason=' + JSON.stringify(ctx.reason) : '');
    if (ctx.status >= 500) log('error', 'http', line);
    else if (ctx.status >= 400) warn('http ' + line);
    else log('info', 'http', line);
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }
  try {
    if (u.pathname === '/health') {
      const idle = agent ? Date.now() - agentLastSeen : null;
      if (agent && IDLE_MS && idle > IDLE_MS) clearAgent('idle for ' + idle + 'ms');
      ctx.status = 200;
      return sendJson(res, 200, {
        ok: true,
        version: '1.1.0',
        uptimeMs: Date.now() - startedAt,
        agent: !!agent,
        models: agentModels.length,
        modelsAt: agentModelsAt,
        modelsAge: agentModelsAt ? Date.now() - agentModelsAt : null,
        agentSince,
        agentIdleMs: agent ? Date.now() - agentLastSeen : null,
        pending: pending.size,
        lastRequest
      });
    }
    if (u.pathname === '/v1/models' && req.method === 'GET') { ctx.status = 200; return handleModels(res); }
    if (u.pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (!authOk(req)) {
        ctx.status = 401;
        ctx.reason = 'bad api key';
        return sendErr(res, 401, 'invalid api key: set the same GATEWAY_KEY in the environment and in your client', 'authentication_error');
      }
      return await handleChat(req, res, ctx);
    }
    ctx.status = 404;
    return sendErr(res, 404, 'not found: ' + u.pathname + ' (try GET /health, GET /v1/models, POST /v1/chat/completions)', 'not_found');
  } catch (e) {
    ctx.status = 500;
    ctx.reason = e.message;
    log('error', 'http', ctx.id + ' unhandled: ' + (e.stack || e.message));
    return sendErr(res, 500, e.message || String(e), 'internal_error');
  }
});

server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/agent') {
    warn('rejected upgrade on ' + u.pathname);
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { warn('upgrade without Sec-WebSocket-Key'); socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15000);
  const parser = createParser(onAgentMessage, () => { try { socket.destroy(); } catch (e) {} });
  if (agent && agent.sock !== socket) {
    // Deliberately do NOT destroy the previous socket. Destroying it makes its
    // client notice the close and reconnect, which in turn replaces this one:
    // two extension workers then ping-pong forever, and every in-flight request
    // on the socket being killed is orphaned. We simply stop routing to it; it
    // cleans itself up later via its own end/close/error handlers, and those
    // handlers no longer touch the slot once another socket owns it.
    log('info', 'agent', 'new agent connection takes over; previous socket left to close on its own');
  }
  agent = { sock: socket };
  agentSince = Date.now();
  agentLastSeen = Date.now();
  log('info', 'agent', 'connected from ' + (socket.remoteAddress || '?') + ' (slot reused, ' + pending.size + ' request(s) pending)');
  socket.on('data', (c) => parser.push(c, (f) => { try { socket.write(f); } catch (e) {} }));
  // 'end' fires when the peer only closes its write side (a crashed tab / dropped
  // network): without it the slot stays occupied and /health keeps lying.
  socket.on('end', () => { if (agent && agent.sock === socket) clearAgent('peer half-closed (FIN)'); });
  socket.on('close', () => { if (agent && agent.sock === socket) clearAgent('socket closed'); });
  socket.on('error', (e) => { if (agent && agent.sock === socket) clearAgent('socket error: ' + (e.code || e.message)); });
});

function start() {
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(ts() + ' ' + paint(31, 'ERR ') + '[gw] port ' + PORT + ' is already in use.');
        console.error('      Something else is listening there - most likely another copy of this gateway.');
        console.error('      Use it, or pick a free port:   PORT=' + (PORT + 1) + ' node arena/server.js');
        console.error('      Find the other process:        (mac/linux) lsof -nP -iTCP:' + PORT + ' -sTCP:LISTEN   (windows) netstat -ano | findstr :' + PORT);
      } else if (err.code === 'EACCES') {
        console.error(ts() + ' ' + paint(31, 'ERR ') + '[gw] not allowed to listen on ' + HOST + ':' + PORT + ' (EACCES).');
      } else {
        console.error(ts() + ' ' + paint(31, 'ERR ') + '[gw] listen failed: ' + (err.stack || err.message));
      }
      reject(err);
    };
    server.once('error', onErr);
    server.listen(PORT, HOST, () => {
      server.removeListener('error', onErr);
      log('info', 'gw', 'arena gateway v1.1.0 listening on http://' + HOST + ':' + PORT);
      log('info', 'gw', 'endpoints: GET /health  GET /v1/models  POST /v1/chat/completions');
      log('info', 'gw', 'auth: ' + (KEY ? 'GATEWAY_KEY set (Bearer required on chat)' : 'no GATEWAY_KEY (chat endpoint is open to anything that can reach this port)'));
      log('info', 'gw', 'log level: ' + Object.keys(LEVELS)[LEVEL] + '  (LOG_LEVEL=silent|error|info|debug)');
      if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
        warn('HOST=' + HOST + ' is not loopback: any page on your network can call this gateway and spend your arena.ai session.');
      }
      log('info', 'gw', 'waiting for the extension to attach on ws://' + HOST + ':' + PORT + '/agent');
      resolve(server);
    });
  });
}

module.exports = { start, server };

if (require.main === module) {
  start().catch(() => process.exit(1));
  process.on('SIGINT', () => { log('info', 'gw', 'shutting down (SIGINT)'); process.exit(0); });
  process.on('SIGTERM', () => { log('info', 'gw', 'shutting down (SIGTERM)'); process.exit(0); });
  process.on('uncaughtException', (e) => { log('error', 'gw', 'uncaught: ' + (e.stack || e.message)); });
}
