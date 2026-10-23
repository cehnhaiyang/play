'use strict';
// Restart the gateway from the single live copy (arena/server.js).
// node arena-test/gw-restart.js
const { spawn, execSync } = require('child_process');
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
  const before = await health();
  if (before) {
    // find and stop the process holding the port (Windows netstat)
    let out = '';
    try { out = execSync('netstat -ano | findstr :' + PORT, { encoding: 'utf8' }); } catch (e) { out = ''; }
    const pids = new Set();
    for (const line of out.split('\n')) {
      if (!/LISTENING/.test(line)) continue;
      const m = line.trim().split(/\s+/);
      const pid = m[m.length - 1];
      if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
    console.log('port ' + PORT + ' held by pid(s): ' + [...pids].join(', ') || '(none found)');
    for (const pid of pids) {
      try { execSync('taskkill /PID ' + pid + ' /F', { stdio: 'ignore' }); console.log('  killed ' + pid); }
      catch (e) { console.log('  could not kill ' + pid + ': ' + e.message); }
    }
    await sleep(700);
  } else {
    console.log('port ' + PORT + ' was free');
  }

  const out = fs.openSync(LOG, 'w');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'arena', 'server.js')], {
    detached: true,
    stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { PORT: String(PORT), LOG_LEVEL: 'debug', NO_COLOR: '1' })
  });
  child.unref();
  console.log('started arena/server.js pid=' + child.pid + ' -> ' + LOG);

  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const h = await health();
    if (h) {
      console.log('up: version=' + h.version + ' agent=' + h.agent + ' models=' + h.models);
      console.log('--- first lines of the log ---');
      console.log(fs.readFileSync(LOG, 'utf8').trimEnd());
      return;
    }
  }
  console.log('did not come up:');
  console.log(fs.readFileSync(LOG, 'utf8'));
})();
