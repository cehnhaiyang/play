'use strict';
// Definitive end-to-end demo: one real request, then show the gateway log lines it produced.
// node arena-test/final-proof.js [model]
const http = require('http');
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, '..', 'arena-audit', 'gw-live.log');

const MODEL = process.argv[2] || 'claude-sonnet-5-high';

function call(method, p, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: 8787, path: p, method, timeout: 180000,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const b = []; res.on('data', (c) => b.push(c));
      res.on('end', () => {
        const t = Buffer.concat(b).toString();
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        resolve({ status: res.statusCode, ms: Date.now() - t0, json: j, text: t });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ status: 'ERR ' + e.code, ms: Date.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const mark = fs.readFileSync(LOG, 'utf8').split('\n').length;

  console.log('=== health before ===');
  const h = await call('GET', '/health');
  console.log('version=' + h.json.version + ' agent=' + h.json.agent + ' models=' + h.json.models);

  console.log('');
  console.log('=== POST /v1/chat/completions model=' + JSON.stringify(MODEL) + ' stream=true ===');
  const s = await call('POST', '/v1/chat/completions', {
    model: MODEL, stream: true,
    messages: [{ role: 'user', content: 'Reply with exactly the word: OK' }]
  });
  console.log('HTTP ' + s.status + '  ' + s.ms + 'ms  bytes=' + s.text.length);
  for (const ev of s.text.split('\n\n')) if (ev.startsWith('data: ')) console.log('  ' + ev.slice(6, 190));

  console.log('');
  console.log('=== gateway log lines produced by that call ===');
  const lines = fs.readFileSync(LOG, 'utf8').split('\n');
  for (const l of lines.slice(mark - 1).filter(Boolean)) console.log(l);
})();
