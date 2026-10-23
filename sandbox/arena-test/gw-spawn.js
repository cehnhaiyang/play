'use strict';
// Start the REAL gateway (arena/server.js) and see whether the REAL browser extension
// attaches to it. Proves the sandbox node process shares loopback with the browser.
// node arena-test/gw-spawn.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8787;
const LOG = path.join(__dirname, '..', 'arena-audit', 'gw-stock.log');

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 1500 }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, json, text: text.slice(0, 300) });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 'ERR', code: e.code }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const existing = await get('/health');
  console.log('BEFORE SPAWN /health ->', JSON.stringify(existing));

  let child = null;
  if (existing.status === 'ERR' && existing.code === 'ECONNREFUSED') {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const out = fs.openSync(LOG, 'w');
    child = spawn(process.execPath, [path.join(__dirname, '..', 'arena', 'server.js')], {
      detached: true,
      stdio: ['ignore', out, out],
      env: Object.assign({}, process.env, { PORT: String(PORT), GATEWAY_KEY: '' })
    });
    child.unref();
    console.log('spawned pid', child.pid, '-> log:', LOG);
    await sleep(800);
  } else {
    console.log('port already served by something else; probing it as-is');
  }

  for (let i = 0; i < 12; i++) {
    const h = await get('/health');
    const m = h.json ? await get('/v1/models') : null;
    console.log('t=' + (i * 2) + 's health=' + JSON.stringify(h.json || h.status) +
      (m && m.json ? ' | models=' + (m.json.data || []).length + ' first=' + JSON.stringify(((m.json.data || [])[0] || {}).id) : ''));
    if (h.json && h.json.agent) {
      console.log('=> AGENT ATTACHED: the real extension reaches this process over 127.0.0.1');
      break;
    }
    await sleep(2000);
  }

  if (fs.existsSync(LOG)) {
    console.log('--- stock gateway stdout so far ---');
    console.log(JSON.stringify(fs.readFileSync(LOG, 'utf8')));
  }
})();
