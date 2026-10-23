'use strict';
// Probe the running gateway: is the updated extension attached?
// node arena-test/probe-now.js
const http = require('http');
function get(p) {
  return new Promise((r) => {
    const req = http.get({ host: '127.0.0.1', port: 8787, path: p, timeout: 1500 }, (res) => {
      const b = []; res.on('data', (c) => b.push(c));
      res.on('end', () => { const t = Buffer.concat(b).toString(); let j = null; try { j = JSON.parse(t); } catch (e) {} r({ status: res.statusCode, json: j, len: t.length }); });
    });
    req.on('timeout', () => { req.destroy(); r({ status: 'TIMEOUT' }); });
    req.on('error', (e) => r({ status: 'ERR ' + e.code }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 8; i++) {
    const h = await get('/health');
    const m = await get('/v1/models');
    console.log('t=' + i + 's', JSON.stringify(h.json || h.status),
      m.json ? '| models=' + (m.json.data || []).length : '');
    if (h.json && h.json.agent) {
      const ids = (m.json.data || []).map((x) => x.id);
      console.log('agent attached. claude-sonnet-5*:', JSON.stringify(ids.filter((x) => /claude-sonnet-5/.test(x))));
      return;
    }
    await sleep(1000);
  }
  console.log('no agent yet');
})();
