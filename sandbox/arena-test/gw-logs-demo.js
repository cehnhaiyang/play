'use strict';
// A/B: original vs patched gateway startup + logging behaviour.
// The original is kept only for this comparison in arena-audit/original/.
// node arena-test/gw-logs-demo.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOGDIR = path.join(ROOT, 'arena-audit');

const CASES = [
  { label: 'ORIGINAL', file: path.join('arena-audit', 'original', 'server.js') },
  { label: 'LIVE    ', file: path.join('arena', 'server.js') }
];

fs.mkdirSync(LOGDIR, { recursive: true });

function call(port, method, p, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 6000, headers:
      data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 'ERR ' + e.code }));
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (const c of CASES) {
    const port = 8792;
    const logName = 'gw-ab-' + c.label.trim().toLowerCase() + '.log';
    const out = fs.openSync(path.join(LOGDIR, logName), 'w');
    const child = spawn(process.execPath, [path.join(ROOT, c.file)], {
      stdio: ['ignore', out, out],
      env: Object.assign({}, process.env, { PORT: String(port), GATEWAY_KEY: '', LOG_LEVEL: 'info', NO_COLOR: '1' })
    });
    await sleep(900);
    for (const [m, p, b] of [
      ['GET', '/health'], ['GET', '/v1/models'],
      ['POST', '/v1/chat/completions', { model: 'claude-sonnet-5-high', messages: [{ role: 'user', content: 'hi' }] }],
      ['GET', '/nope']
    ]) await call(port, m, p, b);
    await sleep(300);
    child.kill();
    await sleep(500);

    const txt = fs.readFileSync(path.join(LOGDIR, logName), 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    console.log('\n===== ' + c.label + ' ' + c.file + ' (' + lines.length + ' lines of output) =====');
    console.log(txt.trimEnd());
    const requestLines = lines.filter((l) => /GET |POST /.test(l)).length;
    console.log('--> request lines logged: ' + requestLines + (requestLines ? '' : '   <<< nothing: you cannot tell whether a call worked'));
  }

  // failing start: the port is already used by the live gateway on 8787
  console.log('\n===== failing start with the port already in use =====');
  for (const c of CASES) {
    const logName = 'gw-ab-busy-' + c.label.trim().toLowerCase() + '.log';
    const out = fs.openSync(path.join(LOGDIR, logName), 'w');
    const child = spawn(process.execPath, [path.join(ROOT, c.file)], {
      stdio: ['ignore', out, out],
      env: Object.assign({}, process.env, { PORT: '8787', NO_COLOR: '1', LOG_LEVEL: 'info' })
    });
    let exit = null;
    child.on('exit', (code) => { exit = code; });
    await sleep(1200);
    try { child.kill(); } catch (e) {}
    const txt = fs.readFileSync(path.join(LOGDIR, logName), 'utf8');
    const first = txt.split('\n').filter(Boolean).slice(0, 4).join('\n');
    console.log('\n--- ' + c.label + ' exit=' + exit + ' ---');
    console.log(first);
  }
})();
