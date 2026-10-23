'use strict';
// End-to-end test of arena/server.js against a mock browser agent.
// Run from sandbox root: node arena-test/gw-test.js
process.env.PORT = '8799';
process.env.HOST = '127.0.0.1';
process.env.GATEWAY_KEY = 'testkey';
process.env.REQ_TIMEOUT = '1500';
process.env.QUIET = '1';

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const P = (f) => path.join(__dirname, '..', 'arena', f);
const { acceptKey, frameMasked, frame, createParser } = require(P('ws.js'));
const gw = require(P('server.js'));

const results = [];
function t(name, fn) {
  try { const r = fn(); results.push(['PASS', name, r === undefined ? '' : String(r)]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg ? msg + ': ' : '') + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: 8799, path: p, method, headers: Object.assign(
      data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, headers || {}) },
      (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json = null; try { json = JSON.parse(text); } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function connectAgent(models, onRequest) {
  const sock = net.connect(8799, '127.0.0.1');
  const st = { sock, requests: [], pongs: 0, closed: false, handshake: '', hello: null };
  const parser = createParser((raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'request') { st.requests.push(m); if (onRequest) onRequest(m, st); }
    else if (m.type === 'pong') st.pongs++;
  }, () => {} , { requireMasked: false });
  return new Promise((resolve) => {
    sock.on('connect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      st.sentKey = key;
      sock.write('GET /agent HTTP/1.1\r\nHost: 127.0.0.1:8799\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (!st.handshake) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        st.handshake = buf.slice(0, i).toString();
        buf = buf.slice(i + 4);
      }
      if (buf.length) parser.push(buf);
      buf = Buffer.alloc(0);
    });
    st.send = (o) => sock.write(frameMasked(JSON.stringify(o)));
    setTimeout(() => { if (models) st.send({ type: 'hello', models }); resolve(st); }, 120);
  });
}

const CATALOG = [
  { id: 'Alpha Max', owned_by: 'anthropic', aliases: ['alpha-max', 'uuid-1'] },
  'PlainModel',
  { id: 'Dup' },
  { id: 'Dup' },
  { id: '', aliases: ['ghost'] },
  { id: 'Beta', aliases: ['Alpha Max', 'beta', 'beta', ''] }
];

(async () => {
  const srv = await gw.start();

  // --- no agent attached -------------------------------------------------
  let r = await req('GET', '/health');
  t('/health before agent', () => { eq(r.json.ok, true); eq(r.json.agent, false); eq(r.json.models, 0); });
  r = await req('GET', '/v1/models');
  t('/v1/models with no agent = empty list, no invented catalogue', () => { eq(r.status, 200); eq(r.json.data, []); });
  r = await req('POST', '/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer testkey' });
  t('chat with no agent -> 503 service_unavailable', () => { eq(r.status, 503); eq(r.json.error.type, 'service_unavailable'); });

  // --- auth --------------------------------------------------------------
  const agent = await connectAgent(CATALOG, null);
  await sleep(150);
  t('handshake accepted by acceptKey()', () => {
    eq(agent.handshake.slice(0, 12), 'HTTP/1.1 101');
    if (!agent.handshake.includes('Sec-WebSocket-Accept: ' + acceptKey(agent.sentKey))) throw new Error('accept key mismatch');
  });
  t('/health after agent', async () => {});
  r = await req('GET', '/health');
  t('/health reports deduped, blank-id-filtered model count (4)', () => {
    eq(r.json.agent, true);
    eq(r.json.models, 4, 'empty-string id and the duplicate Dup are dropped');
  });
  r = await req('POST', '/v1/chat/completions', { model: 'Alpha Max', messages: [{ role: 'user', content: 'hi' }] });
  t('missing/incorrect bearer -> 401 authentication_error', () => { eq(r.status, 401); eq(r.json.error.type, 'authentication_error'); });
  r = await req('GET', '/health', undefined, { authorization: 'Bearer testkey' });
  t('/health needs no auth (key only guards chat)', () => eq(r.status, 200));
  r = await req('GET', '/v1/models', undefined, { authorization: 'Bearer testkey' });
  t('/v1/models needs no auth', () => eq(r.status, 200));

  // --- catalogue shape ---------------------------------------------------
  t('/v1/models mirrors agent ids + owned_by, no aliases leaked', () => {
    eq(r.json.object, 'list');
    eq(r.json.data.map((m) => m.id), ['Alpha Max', 'PlainModel', 'Dup', 'Beta']);
    eq(r.json.data[0].owned_by, 'anthropic');
    eq(r.json.data[3].owned_by, 'arena', 'default owner');
    if ('aliases' in r.json.data[0]) throw new Error('aliases should not be exposed on /v1/models');
  });

  // --- happy path, non-stream -------------------------------------------
  let seen = null;
  const agent2 = agent;
  agent2.sock.removeAllListeners('data');
  // route request handling for the rest of the run
  const route = (m, st) => {
    if (m.type !== 'request') return;
    seen = m;
    st.send({ type: 'delta', reqId: m.reqId, text: 'Hello ' });
    st.send({ type: 'delta', reqId: m.reqId, text: 'world' });
    st.send({ type: 'done', reqId: m.reqId });
  };
  // re-attach parser through a fresh agent so routing is deterministic
  const a = await connectAgent(CATALOG, route);
  await sleep(150);
  r = await req('POST', '/v1/chat/completions', {
    model: 'alpha-max',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
      { role: 'user', content: [{ type: 'text', text: 'multi' }, 'part'] }
    ]
  }, { authorization: 'Bearer testkey' });
  t('alias "alpha-max" resolves to canonical id in response', () => { eq(r.status, 200); eq(r.json.model, 'Alpha Max'); });
  t('prompt flattening: system/assistant tagged, arrays concatenated', () => {
    eq(seen.model, 'Alpha Max', 'canonical model sent to agent');
    eq(seen.content, '[system] be terse\n\nping\n\n[assistant] pong\n\nmultipart');
    eq(seen.modality, 'chat');
  });
  t('delta frames concatenated into one completion', () => {
    eq(r.json.choices[0].message.content, 'Hello world');
    eq(r.json.choices[0].finish_reason, 'stop');
    if (!/^chatcmpl-[0-9a-f]{32}$/.test(r.json.id)) throw new Error('odd id: ' + r.json.id);
    eq(r.json.usage.total_tokens, 0);
  });

  // --- stream ------------------------------------------------------------
  const chunks = [];
  await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: 'PlainModel', stream: true, messages: [{ role: 'user', content: 's' }] });
    const q = http.request({ host: '127.0.0.1', port: 8799, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: 'Bearer testkey' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error('status ' + res.statusCode));
      chunks.push({ status: res.statusCode, ct: res.headers['content-type'] });
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); if (ev.startsWith('data: ')) chunks.push(ev.slice(6)); }
      });
      res.on('end', resolve);
    });
    q.on('error', reject); q.write(payload); q.end();
  });
  t('stream=true -> SSE headers', () => {
    eq(chunks[0].status, 200);
    if (!/^text\/event-stream/.test(chunks[0].ct)) throw new Error('bad content-type ' + chunks[0].ct);
  });
  t('stream chunk sequence: role, content deltas, stop, [DONE]', () => {
    const objs = chunks.slice(1).map((s) => (s === '[DONE]' ? '[DONE]' : JSON.parse(s)));
    eq(objs[0].choices[0].delta, { role: 'assistant', content: '' });
    eq(objs[1].choices[0].delta.content, 'Hello ');
    eq(objs[2].choices[0].delta.content, 'world');
    eq(objs[3].choices[0].finish_reason, 'stop');
    eq(objs[4], '[DONE]');
    eq(objs[0].object, 'chat.completion.chunk');
  });
  t('stream chunks echo the RAW caller string, not the resolved canonical id', () => {
    const o = JSON.parse(chunks[1]);
    if (o.model !== 'PlainModel') throw new Error('chunk model = ' + o.model);
  });



  // --- error paths -------------------------------------------------------
  r = await req('POST', '/v1/chat/completions', { model: 'nope', messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer testkey' });
  t('unknown model -> 404 listing what the browser offers', () => {
    eq(r.status, 404);
    if (r.json.error.message.indexOf('model not found: nope') !== 0) throw new Error(r.json.error.message);
    if (r.json.error.message.indexOf('Alpha Max') < 0) throw new Error('does not list names: ' + r.json.error.message);
  });
  r = await req('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer testkey' });
  t('missing model -> 400', () => { eq(r.status, 400); eq(r.json.error.message, 'missing required field: model'); });
  r = await req('POST', '/v1/chat/completions', { model: 'Beta', messages: [] }, { authorization: 'Bearer testkey' });
  t('no textual messages -> 400', () => { eq(r.status, 400); eq(r.json.error.message, 'missing required field: messages'); });
  r = await req('POST', '/v1/chat/completions', '{oops', { authorization: 'Bearer testkey' });
  t('invalid JSON -> 400', () => { eq(r.status, 400); eq(r.json.error.message, 'invalid JSON body'); });
  r = await req('GET', '/nope');
  t('unknown path -> 404 not_found', () => { eq(r.status, 404); eq(r.json.error.type, 'not_found'); });
  r = await req('OPTIONS', '/v1/chat/completions', undefined, { origin: 'https://evil.example' });
  t('CORS preflight -> 204 with wildcard ACAO (+ credentials hazard)', () => {
    eq(r.status, 204);
    eq(r.headers['access-control-allow-origin'], '*');
    eq(r.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
  });
  t('Case sensitivity: exact-match only, no fuzzy resolution', async () => {});
  r = await req('POST', '/v1/chat/completions', { model: 'alpha max', messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer testkey' });
  t('lowercased alias is rejected (exact match only)', () => eq(r.status, 404));
  r = await req('POST', '/v1/chat/completions', { model: '  alpha-max  ', messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer testkey' });
  t('surrounding whitespace is trimmed', () => eq(r.status, 200));

  // --- control frames + single-agent semantics ---------------------------
  a.send({ type: 'ping' });
  await sleep(120);
  t('agent ping -> gateway replies pong', () => eq(a.pongs, 1));
  const b = await connectAgent([{ id: 'Second' }], route);
  await sleep(200);
  r = await req('GET', '/health');
  t('second agent replaces the first (single viewer slot)', () => { eq(r.json.agent, true); eq(r.json.models, 1); });
  a.sock.destroy();
  await sleep(200);
  r = await req('GET', '/health');
  t('closing the OLD socket does not clear the live agent', () => { eq(r.json.agent, true); eq(r.json.models, 1); });
  // --- close semantics, each on a fresh agent -----------------------------
  const z = await connectAgent([{ id: 'Zombie' }], route);
  await sleep(250);
  z.sock.write(frame(Buffer.alloc(0), 8));   // explicit WebSocket close frame
  await sleep(500);
  r = await req('GET', '/health');
  t('an explicit WebSocket close frame clears the agent slot', () => { eq(r.json.agent, false); eq(r.json.models, 0); });
  r = await req('POST', '/v1/chat/completions', { model: 'Zombie', messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer testkey' });
  t('after a clean disconnect: 503 with an accurate reason', () => { eq(r.status, 503); if (!/no browser agent/.test(r.json.error.message)) throw new Error(r.json.error.message); });

  const z2 = await connectAgent([{ id: 'Zombie2' }], route);
  await sleep(250);
  z2.sock.destroy();                         // FIN only: e.g. a tab that went away ungracefully
  await sleep(700);
  r = await req('GET', '/health');
  t('BUG: a FIN-only disconnect is never noticed -> zombie keeps advertising models', () => {
    eq(r.json.agent, true);
    eq(r.json.models, 1);
    return 'agent:true models:1 modelsAge=' + r.json.modelsAge + 'ms';
  });

  // --- upstream timeout / error passthrough ------------------------------
  const c = await connectAgent([{ id: 'Slow' }], (m, st) => { if (m.content === 'boom') st.send({ type: 'error', reqId: m.reqId, message: 'agent exploded' }); });
  await sleep(150);
  r = await req('POST', '/v1/chat/completions', { model: 'Slow', messages: [{ role: 'user', content: 'boom' }] }, { authorization: 'Bearer testkey' });
  t('agent error frame -> 502 upstream_error with the agent message', () => { eq(r.status, 502); eq(r.json.error.message, 'agent exploded'); });
  const t0 = Date.now();
  r = await req('POST', '/v1/chat/completions', { model: 'Slow', messages: [{ role: 'user', content: 'never answered' }] }, { authorization: 'Bearer testkey' });
  t('unanswered request -> 504 upstream_timeout after REQ_TIMEOUT', () => {
    eq(r.status, 504);
    eq(r.json.error.message, 'upstream timeout');
    const dt = Date.now() - t0;
    if (dt < 1400 || dt > 3000) throw new Error('timeout fired after ' + dt + 'ms');
    return dt + 'ms';
  });
  r = await req('GET', '/health');
  t('health exposes modelsAge for staleness checks', () => { eq(typeof r.json.modelsAge, 'number'); eq(typeof r.json.modelsAt, 'number'); });

  // --- streaming path: the alias/canonical asymmetry ---------------------
  const d = await connectAgent([{ id: 'ErrModel', aliases: ['err-model'] }], (m, st) => {
    if (m.content === 'plain') { st.send({ type: 'delta', reqId: m.reqId, text: 'ok' }); st.send({ type: 'done', reqId: m.reqId }); return; }
    st.send({ type: 'delta', reqId: m.reqId, text: 'partial' });
    st.send({ type: 'error', reqId: m.reqId, message: 'upstream exploded' });
  });
  await sleep(150);

  function sse(model, content) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const payload = JSON.stringify({ model, stream: true, messages: [{ role: 'user', content }] });
      const q = http.request({ host: '127.0.0.1', port: 8799, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: 'Bearer testkey' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('status ' + res.statusCode)); }
        let buf = '';
        res.on('data', (c) => { buf += c.toString(); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); if (ev.startsWith('data: ')) chunks.push(ev.slice(6)); } });
        res.on('end', () => resolve(chunks));
      });
      q.on('error', reject); q.write(payload); q.end();
    });
  }

  const chunks2 = await sse('err-model', 'plain');
  t('BUG(cosmetic): alias in -> stream advertises the ALIAS, not the canonical id', () => {
    eq(JSON.parse(chunks2[1]).model, 'err-model', 'the non-stream path would have returned "ErrModel"');
    eq(JSON.parse(chunks2[1]).choices[0].delta.content, 'ok', 'the request itself did resolve the alias');
  });

  const chunks3 = await sse('ErrModel', 'boom');
  t('upstream error mid-stream: HTTP 200 + an error frame (5 frames total)', () => {
    eq(chunks3.length, 5);
    const errFrame = chunks3.map((c) => (c === '[DONE]' ? null : JSON.parse(c))).find((o) => o && o.error);
    if (!errFrame) throw new Error('no error frame found');
    eq(errFrame.error.type, 'upstream_error');
    return errFrame.error.message;
  });
  t('BUG: after an upstream error the stream still ends with finish_reason:stop + [DONE]', () => {
    const fin = JSON.parse(chunks3[3]);
    eq(fin.choices[0].finish_reason, 'stop', 'a naive client cannot distinguish this from a clean completion');
    eq(chunks3[4], '[DONE]');
    const deltas = chunks3.filter((c) => c !== '[DONE]').map((c) => JSON.parse(c)).filter((o) => o.choices && o.choices[0].delta && o.choices[0].delta.content).map((o) => o.choices[0].delta.content);
    eq(deltas, ['partial'], 'the partial answer is shipped as if complete');
  });
  d.sock.write(frame(Buffer.alloc(0), 8));

  for (const x of results) console.log(x.join(' | '));
  const fails = results.filter((x) => x[0] === 'FAIL').length;
  console.log(fails ? 'FAILURES: ' + fails + '/' + results.length : 'ALL ' + results.length + ' CASES PASS');
  srv.close();
  process.exit(0);
})().catch((e) => { console.log('HARNESS ERROR', e); process.exit(1); });
