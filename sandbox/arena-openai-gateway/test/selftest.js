'use strict';
// End-to-end self test: boots the gateway, attaches a fake browser agent
// over WebSocket, and asserts the OpenAI-compatible surface works.

const http = require('http');
const path = require('path');
const { acceptKey, frameMasked, createParser } = require('../gateway/ws');

process.env.PORT = process.env.PORT || '18999';
process.env.GATEWAY_KEY = 'test-key';
process.env.QUIET = '0';

const gw = require('../gateway/server.js');
const PORT = Number(process.env.PORT);

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + JSON.stringify(extra) : ''));
}

function connectAgent() {
  return new Promise((resolve, reject) => {
    const key = Buffer.from('00000000000000000000000000000000').toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/agent',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key
      }
    });

    req.on('upgrade', (res, socket) => {
      const expect = acceptKey(key);
      if (res.headers['sec-websocket-accept'] !== expect) {
        return reject(new Error('bad Sec-WebSocket-Accept'));
      }
      const agent = { socket, handlers: [], closed: false };
      agent.send = (o) => socket.write(frameMasked(JSON.stringify(o)));
      agent.on = (fn) => agent.handlers.push(fn);
      agent.close = () => { try { socket.destroy(); } catch (e) {} };
      const parser = createParser(
        (raw) => {
          let m;
          try { m = JSON.parse(raw); } catch (e) { return; }
          agent.handlers.forEach((h) => h(m));
        },
        () => { agent.closed = true; }
      );
      socket.on('data', (c) => parser.push(c, (f) => socket.write(f)));
      socket.on('close', () => { agent.closed = true; });
      resolve(agent);
    });

    req.on('error', reject);
    req.end();
  });
}

function post(pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  await gw.start();
  await wait(120);

  // --- 1. no agent yet: must fail cleanly ---
  const before = await post('/v1/chat/completions', { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer test-key' });
  check('503 when no agent', before.status === 503, { status: before.status });

  // --- 2. auth enforcement ---
  const nokey = await post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'hi' }] });
  check('401 without api key', nokey.status === 401, { status: nokey.status });

  // --- 3. attach fake agent ---
  const agent = await connectAgent();
  await wait(80);

  const seen = [];
  agent.on((m) => {
    seen.push(m);
    if (m.type !== 'request') return;
    // simulate a streaming browser agent on the arena side
    const parts = ['PONG', '-123', '.'];
    let i = 0;
    const tick = setInterval(() => {
      if (i < parts.length) {
        agent.send({ type: 'delta', reqId: m.reqId, text: parts[i++] });
      } else {
        clearInterval(tick);
        agent.send({ type: 'done', reqId: m.reqId });
      }
    }, 25);
  });

  agent.send({ type: 'hello', models: [{ id: 'claude-sonnet-5', owned_by: 'anthropic' }, { id: 'gpt-5.1', owned_by: 'openai' }] });
  await wait(120);

  // --- 4. /v1/models reflects the agent catalog ---
  const models = await get('/v1/models');
  let parsed = null;
  try { parsed = JSON.parse(models.body); } catch (e) {}
  check('/v1/models lists agent models', !!(parsed && parsed.data && parsed.data.length === 2), { n: parsed && parsed.data && parsed.data.length });

  // --- 5. non-streaming completion ---
  const nr = await post('/v1/chat/completions', {
    model: 'claude-sonnet-5',
    messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'reply PONG-123' }]
  }, { authorization: 'Bearer test-key' });
  let nrj = null;
  try { nrj = JSON.parse(nr.body); } catch (e) {}
  const nrText = nrj && nrj.choices && nrj.choices[0] && nrj.choices[0].message && nrj.choices[0].message.content;
  check('non-stream returns joined text', nrText === 'PONG-123.', { status: nr.status, text: nrText });

  // --- 6. prompt flattening keeps roles ---
  const lastReq = seen.filter((m) => m.type === 'request').pop();
  check('system+user flattened', !!(lastReq && /\[system\] be terse/.test(lastReq.content) && /reply PONG-123/.test(lastReq.content)), { content: lastReq && lastReq.content });

  // --- 7. streaming completion ---
  const sr = await post('/v1/chat/completions', {
    model: 'gpt-5.1',
    stream: true,
    messages: [{ role: 'user', content: 'stream please' }]
  }, { authorization: 'Bearer test-key' });
  const lines = sr.body.split('\n').filter((l) => l.indexOf('data: ') === 0).map((l) => l.slice(6));
  const objs = lines.filter((l) => l !== '[DONE]').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const deltas = objs.filter((o) => o.choices && o.choices[0] && o.choices[0].delta && o.choices[0].delta.content).map((o) => o.choices[0].delta.content).join('');
  const hasDone = lines.indexOf('[DONE]') >= 0;
  const firstHasRole = !!(objs[0] && objs[0].choices[0].delta.role === 'assistant');
  const finish = objs.some((o) => o.choices && o.choices[0] && o.choices[0].finish_reason === 'stop');
  check('stream emits SSE deltas', deltas === 'PONG-123.', { deltas });
  check('stream terminates with [DONE]', hasDone, {});
  check('stream first chunk has assistant role', firstHasRole, {});
  check('stream ends with finish_reason=stop', finish, {});
  check('stream content-type is SSE', /text\/event-stream/.test(sr.headers['content-type'] || ''), { ct: sr.headers['content-type'] });

  // --- 8. upstream error propagates ---
  agent.handlers.length = 0;
  agent.on((m) => { if (m.type === 'request') agent.send({ type: 'error', reqId: m.reqId, message: 'model unavailable' }); });
  const er = await post('/v1/chat/completions', { model: 'gpt-5.1', messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer test-key' });
  let erj = null;
  try { erj = JSON.parse(er.body); } catch (e) {}
  check('upstream error -> 502 with message', er.status === 502 && !!(erj && erj.error && /model unavailable/.test(erj.error.message)), { status: er.status });

  // --- 9. bad request ---
  const bad = await post('/v1/chat/completions', { messages: [] }, { authorization: 'Bearer test-key' });
  check('400 on missing model', bad.status === 400, { status: bad.status });

  agent.close();
  await wait(150);

  const failed = results.filter((r) => !r.ok);
  console.log('\n--- summary ---');
  console.log('total ' + results.length + ', passed ' + (results.length - failed.length) + ', failed ' + failed.length);
  gw.server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('selftest crashed:', e);
  process.exit(2);
});
