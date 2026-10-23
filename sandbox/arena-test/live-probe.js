'use strict';
// Is anything already listening on the gateway port, and is it OUR gateway?
// node arena-test/live-probe.js
const http = require('http');

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      const p = []; res.on('data', (c) => p.push(c)); res.on('end', () => resolve({ port, status: res.statusCode, body: Buffer.concat(p).toString().slice(0, 400) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ port, status: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ port, status: 'ERR', code: e.code }));
  });
}

function models(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/v1/models', timeout: 1500 }, (res) => {
      const p = []; res.on('data', (c) => p.push(c)); res.on('end', () => {
        let j = null; try { j = JSON.parse(Buffer.concat(p).toString()); } catch (e) {}
        resolve(j ? (j.data || []).map((m) => m.id) : null);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

(async () => {
  for (const port of [8787, 8788, 8790]) {
    const h = await health(port);
    console.log('port ' + port + ' ->', JSON.stringify(h));
    if (h.status === 200) {
      const ids = await models(port);
      console.log('  /v1/models (' + (ids ? ids.length : 'n/a') + '):', ids ? JSON.stringify(ids.slice(0, 6)) : 'null');
      if (ids) {
        const hit = ids.filter((i) => /claude-sonnet-5/i.test(i));
        console.log('  claude-sonnet-5 matches:', JSON.stringify(hit));
        console.log('  exact "claude-sonnet-5" present:', ids.includes('claude-sonnet-5'));
      }
    }
  }
})();
