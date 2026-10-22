'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { acceptKey, frame, createParser } = require('./ws');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const KEY = process.env.GATEWAY_KEY || '';
const TIMEOUT = Number(process.env.REQ_TIMEOUT || 180000);
const QUIET = process.env.QUIET === '1';
const log = (...a) => { if (!QUIET) console.log('[gw]', ...a); };

let agent = null;
let agentModels = [];
const pending = new Map();

function staticModels() {
  try {
    const p = path.join(__dirname, 'models.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).models || [];
  } catch (e) {
    return [];
  }
}

function sendToAgent(obj) {
  if (!agent) return false;
  try {
    agent.sock.write(frame(JSON.stringify(obj)));
    return true;
  } catch (e) {
    log('write failed:', e.message);
    return false;
  }
}

function onAgentMessage(raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (m.type === 'hello') {
    agentModels = Array.isArray(m.models) ? m.models : [];
    log('agent hello, models =', agentModels.length);
    return;
  }
  if (m.type === 'ping') { sendToAgent({ type: 'pong' }); return; }
  const p = pending.get(m.reqId);
  if (!p) return;
  if (m.type === 'delta') {
    if (typeof m.text === 'string' && m.text.length) {
      if (p.onDelta) p.onDelta(m.text);
      else p.buf.push(m.text);
    }
    return;
  }
  if (m.type === 'done') {
    pending.delete(m.reqId);
    p.finish();
    return;
  }
  if (m.type === 'error') {
    pending.delete(m.reqId);
    p.fail(new Error(m.message || 'agent reported error'));
  }
}

function callAgent(model, content, modality, onDelta) {
  return new Promise((resolve, reject) => {
    if (!agent) {
      const e = new Error('no browser agent connected: open arena.ai with the extension enabled');
      e.status = 503;
      return reject(e);
    }
    const reqId = crypto.randomUUID();
    const buf = [];
    const timer = setTimeout(() => {
      pending.delete(reqId);
      const e = new Error('upstream timeout');
      e.status = 504;
      reject(e);
    }, TIMEOUT);
    pending.set(reqId, {
      buf,
      onDelta,
      finish: () => { clearTimeout(timer); resolve(buf); },
      fail: (e) => { clearTimeout(timer); reject(e); }
    });
    const ok = sendToAgent({ type: 'request', reqId, model, content, modality: modality || 'chat' });
    if (!ok) {
      pending.delete(reqId);
      clearTimeout(timer);
      const e = new Error('agent socket closed');
      e.status = 503;
      reject(e);
    }
  });
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'access-control-allow-origin': '*'
  });
  res.end(body);
}

function sendErr(res, code, message, type) {
  sendJson(res, code, {
    error: { message: String(message), type: type || 'invalid_request_error', code: null, param: null }
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
      if (n > 8 * 1024 * 1024) { req.destroy(); return reject(new Error('body too large')); }
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

async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return sendErr(res, 400, 'invalid JSON body');
  }
  const model = String(payload.model || '').trim();
  if (!model) return sendErr(res, 400, 'missing required field: model');
  const content = flatten(payload.messages);
  if (!content) return sendErr(res, 400, 'missing required field: messages');

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
    const base = { id, object: 'chat.completion.chunk', created, model };
    const emit = (delta, finish) => {
      const chunk = { ...base, choices: [{ index: 0, delta, finish_reason: finish || null }] };
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
    };
    emit({ role: 'assistant', content: '' });
    try {
      await callAgent(model, content, payload.modality, (t) => emit({ content: t }));
    } catch (e) {
      const chunk = { error: { message: String(e.message || e), type: 'upstream_error' } };
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
    }
    emit({}, 'stop');
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  try {
    const buf = await callAgent(model, content, payload.modality);
    const text = buf.join('');
    return sendJson(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  } catch (e) {
    return sendErr(res, e.status || 502, e.message || String(e), e.status === 503 ? 'service_unavailable' : 'upstream_error');
  }
}

function handleModels(res) {
  let list;
  if (agentModels.length) {
    list = agentModels.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: m.owned_by || 'arena' }));
  } else {
    list = staticModels().map((m) => ({ id: m.name, object: 'model', created: 0, owned_by: m.owned_by || 'arena' }));
  }
  sendJson(res, 200, { object: 'list', data: list });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
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
      return sendJson(res, 200, { ok: true, agent: !!agent, models: agentModels.length });
    }
    if (u.pathname === '/v1/models' && req.method === 'GET') return handleModels(res);
    if (u.pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (!authOk(req)) return sendErr(res, 401, 'invalid api key', 'authentication_error');
      return await handleChat(req, res);
    }
    return sendErr(res, 404, 'not found: ' + u.pathname, 'not_found');
  } catch (e) {
    return sendErr(res, 500, e.message || String(e), 'internal_error');
  }
});

server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/agent') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  const parser = createParser(onAgentMessage, () => { try { socket.destroy(); } catch (e) {} });
  agent = { sock: socket };
  log('agent connected');
  socket.on('data', (c) => parser.push(c, (f) => { try { socket.write(f); } catch (e) {} }));
  socket.on('close', () => { if (agent && agent.sock === socket) { agent = null; log('agent disconnected'); } });
  socket.on('error', () => { if (agent && agent.sock === socket) agent = null; });
});

function start() {
  return new Promise((resolve) => {
    server.listen(PORT, HOST, () => { log('listening on http://' + HOST + ':' + PORT); resolve(server); });
  });
}

module.exports = { start, server };

if (require.main === module) {
  start();
  process.on('SIGINT', () => { log('bye'); process.exit(0); });
}
