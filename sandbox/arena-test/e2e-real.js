'use strict';
// 真实端到端：打到用户正在运行的网关 127.0.0.1:8787（真实扩展 + 真实浏览器标签）
// node arena-test/e2e-real.js
const http = require('http');

function call(method, path, body, headers) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: 8787, path, method, timeout: 180000,
      headers: Object.assign(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, headers || {}) },
      (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString();
          let json = null; try { json = JSON.parse(text); } catch (e) {}
          resolve({ status: res.statusCode, ms: Date.now() - t0, text, json });
        });
      });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ status: 'ERR ' + e.code, ms: Date.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const h = await call('GET', '/health');
  console.log('health:', JSON.stringify(h.json));

  const m = await call('GET', '/v1/models');
  const ids = (m.json && m.json.data || []).map((x) => x.id);
  console.log('models:', ids.length, '| claude-sonnet-5*:', JSON.stringify(ids.filter((i) => /claude-sonnet-5/.test(i))));

  // 用最小 prompt，验证「精确 id 调用」是否真的通
  for (const model of ['claude-sonnet-5-high']) {
    console.log('\n>>> POST model=' + JSON.stringify(model));
    const r = await call('POST', '/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 8
    });
    console.log('    status=' + r.status + ' (' + r.ms + 'ms)');
    console.log('    body=' + (r.text || '').slice(0, 600));
  }
})();
