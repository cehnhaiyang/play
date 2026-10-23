'use strict';
// Starts the live gateway detached, logging to arena-audit/gw-live.log.
// node arena-test/gw-run.js [port]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.argv[2] || 8787);
const LOG = path.join(__dirname, '..', 'arena-audit', 'gw-live.log');

function health() {
  return new Promise((r) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1200 }, (res) => {
      const p = []; res.on('data', (c) => p.push(c));
      res.on('end', () => { try { r(JSON.parse(Buffer.concat(p).toString())); } catch (e) { r(null); } });
    });
    req.on('timeout', () => { req.destroy(); r(null); });
    req.on('error', () => r(null));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const existing = await health();
  if (existing) {
    console.log('port ' + PORT + ' already serving /health:');
    console.log('  ' + JSON.stringify(existing));
    console.log('  version=' + existing.version + ' agent=' + existing.agent + ' models=' + existing.models);
    return;
  }
  const out = fs.openSync(LOG, 'w');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'arena', 'server.js')], {
    detached: true,
    stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { PORT: String(PORT), LOG_LEVEL: 'debug', NO_COLOR: '1' })
  });
  child.unref();
  console.log('spawned gateway pid=' + child.pid + ' port=' + PORT + ' log=' + LOG);
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const h = await health();
    if (h) { console.log('up after ' + ((i + 1) * 0.5) + 's: version=' + h.version + ' agent=' + h.agent); return; }
  }
  console.log('did not come up; log so far:');
  console.log(fs.readFileSync(LOG, 'utf8'));
})();
