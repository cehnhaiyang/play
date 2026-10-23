'use strict';
// Live reproduction against the running gateway + whatever extension is attached.
// node arena-test/live-repro2.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, '..', 'arena-audit', 'gw-live.log');

function call(method, p, body, headers) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: 8787, path: p, method, timeout: 120000,
      headers: Object.assign(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, headers || {}) }, (res) => {
      const b = []; res.on('data', (c) => b.push(c));
      res.on('end', () => {
        const t = Buffer.concat(b).toString();
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        resolve({ status: res.statusCode, ms: Date.now() - t0, text: t, json: j });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ status: 'ERR', ms: Date.now() - t0, code: e.code }));
    if (data) req.write(data);
    req.end();
  });
}

function tail(n) {
  if (!fs.existsSync(LOG)) return '(no log)';
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-n).join('\n');
}

(async () => {
  console.log('=== health ===');
  const h = await call('GET', '/health');
  console.log(JSON.stringify(h.json));

  console.log('\n=== the exact call you reported: model=claude-sonnet-5 ===');
  const r = await call('POST', '/v1/chat/completions', {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }]
  }, { authorization: 'Bearer testkey' });
  console.log('status=' + r.status + ' (' + r.ms + 'ms)');
  console.log('body=' + r.text.slice(0, 400));

  console.log('\n=== gateway log lines produced by that call ===');
  console.log(tail(14));

  console.log('\n=== try the displayName instead ===');
  const r2 = await call('POST', '/v1/chat/completions', {
    model: 'claude-sonnet-5-high',
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }]
  }, { authorization: 'Bearer testkey' });
  console.log('status=' + r2.status + ' (' + r2.ms + 'ms)');
  console.log('body=' + r2.text.slice(0, 400));
  console.log('\n=== log tail ===');
  console.log(tail(20));
})();
