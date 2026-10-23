'use strict';
// LIVE reproduction against the gateway that is actually running on 127.0.0.1:8787
// (the same process the real browser extension has attached to).
// Drives the real page UI through the real bridge, but stops at the model picker.
// node arena-test/e2e-repro.js
const http = require('http');

const GW = { host: '127.0.0.1', port: 8787 };

function call(method, path, body, headers) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const t0 = Date.now();
    const req = http.request({ host: GW.host, port: GW.port, path, method, timeout: 120000, headers: Object.assign(
      data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, headers || {}) }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, ms: Date.now() - t0, text, json });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ status: 'ERR', code: e.code, ms: Date.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const h = await call('GET', '/health');
  console.log('health      :', h.status, JSON.stringify(h.json));

  const m = await call('GET', '/v1/models');
  const ids = (m.json && m.json.data || []).map((x) => x.id);
  console.log('models      :', m.status, ids.length, 'entries');
  console.log('  claude-*  :', JSON.stringify(ids.filter((i) => /claude/i.test(i)).slice(0, 8)));
  console.log('  "claude-sonnet-5" listed verbatim?', ids.includes('claude-sonnet-5'));

  for (const model of ['claude-sonnet-5', 'claude-sonnet-5-high']) {
    const r = await call('POST', '/v1/chat/completions', {
      model, messages: [{ role: 'user', content: 'ping' }]
    }, { authorization: 'Bearer testkey' });
    console.log('\nPOST model=' + JSON.stringify(model) + ' ->', r.status, '(' + r.ms + 'ms)');
    console.log('  body: ' + (r.text || '').slice(0, 500));
  }
})();
