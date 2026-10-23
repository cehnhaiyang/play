'use strict';
// Prove PRECISE model switching: ask for several models in a row and check that the
// answer comes back labelled with the model that was actually asked for.
// node arena-test/precision-test.js [model ...]
const http = require('http');
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, '..', 'arena-audit', 'gw-live.log');

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

function logTail(n) {
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-n).join('\n');
}

(async () => {
  const models = process.argv.slice(2);
  const list = models.length ? models : ['claude-sonnet-5-high', 'gemini-3.8-flash-high', 'claude-sonnet-5'];
  for (const m of list) {
    const r = await call('POST', '/v1/chat/completions', {
      model: m,
      messages: [{ role: 'user', content: 'Reply with exactly the word: OK' }]
    });
    const choice = r.json && r.json.choices && r.json.choices[0];
    console.log(JSON.stringify({
      asked: m,
      status: r.status,
      ms: r.ms,
      answeredModel: r.json && r.json.model,
      answer: choice ? choice.message.content : (r.json ? r.json.error : r.text.slice(0, 200)),
      finish: choice ? choice.finish_reason : null
    }));
  }
  console.log('\n--- gateway log for those calls ---');
  console.log(logTail(14));
})();
