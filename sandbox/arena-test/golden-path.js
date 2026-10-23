'use strict';
// 真实端到端金路径：打到用户正在运行的网关 127.0.0.1:8787
// 1) /health  -> 扩展是否挂上、模型数、最后请求
// 2) /v1/models -> 精确 id 是否在列
// 3) POST 非流式 minimum prompt
// 4) POST 流式，打印每帧
// node arena-test/golden-path.js
const http = require('http');

const PORT = Number(process.env.GW_PORT || 8787);

function call(method, path, body, headers) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, timeout: 300000,
      headers: Object.assign(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, headers || {}) },
      (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString();
          let json = null; try { json = JSON.parse(text); } catch (e) {}
          resolve({ status: res.statusCode, ms: Date.now() - t0, text, json, ct: res.headers['content-type'] });
        });
      });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ status: 'ERR ' + e.code, ms: Date.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });
}

function sse(model, content) {
  return new Promise((resolve) => {
    const frames = [];
    const payload = JSON.stringify({ model, stream: true, messages: [{ role: 'user', content }] });
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST', timeout: 300000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          if (ev.startsWith('data: ')) frames.push({ at: Date.now() - t0, data: ev.slice(6) });
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0, frames }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', frames }); });
    req.on('error', (e) => resolve({ status: 'ERR ' + e.code, frames }));
    req.write(payload); req.end();
  });
}

(async () => {
  const h = await call('GET', '/health');
  console.log('=== /health ===');
  console.log(JSON.stringify(h.json || h.text, null, 2));

  const m = await call('GET', '/v1/models');
  const ids = (m.json && m.json.data || []).map((x) => x.id);
  console.log('\n=== /v1/models === ' + ids.length + ' models');
  console.log('claude-sonnet-5-high in list:', ids.includes('claude-sonnet-5-high'));
  console.log('claude-sonnet-5 (alias) in list:', ids.includes('claude-sonnet-5'));

  const MODEL = process.env.MODEL || 'claude-sonnet-5-high';
  const PROMPT = 'Reply with exactly: OK';

  console.log('\n=== POST /v1/chat/completions  model=' + JSON.stringify(MODEL) + ' (non-stream) ===');
  const r = await call('POST', '/v1/chat/completions', {
    model: MODEL, messages: [{ role: 'user', content: PROMPT }]
  });
  console.log('status=' + r.status + '  ' + r.ms + 'ms');
  console.log('body=' + (r.text || '').slice(0, 900));
  if (r.json && r.json.choices) {
    console.log('>>> ANSWER = ' + JSON.stringify(r.json.choices[0].message.content));
    console.log('>>> model  = ' + JSON.stringify(r.json.model));
    console.log('>>> finish = ' + JSON.stringify(r.json.choices[0].finish_reason));
  }

  console.log('\n=== POST same model, stream=true ===');
  const s = await sse(MODEL, PROMPT);
  console.log('status=' + s.status + '  ' + s.ms + 'ms  frames=' + s.frames.length);
  for (const f of s.frames) console.log('  +' + String(f.at).padStart(6) + 'ms  ' + f.data.slice(0, 200));
})();
