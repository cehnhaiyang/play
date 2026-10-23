'use strict';
// Focused probe: does the gateway release the agent slot when the socket dies?
process.env.PORT = '8801';
process.env.QUIET = '1';
const net = require('net'), http = require('http'), crypto = require('crypto'), path = require('path');
const P = (f) => path.join(__dirname, '..', 'arena', f);
const { frameMasked, createParser } = require(P('ws.js'));
const gw = require(P('server.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function health() {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 8801, path: '/health' }, (r) => {
      const p = []; r.on('data', (c) => p.push(c)); r.on('end', () => res(JSON.parse(Buffer.concat(p))));
    }).on('error', rej);
  });
}
function conn() {
  const sock = net.connect(8801, '127.0.0.1');
  const parser = createParser((raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'request') sock.write(frameMasked(JSON.stringify({ type: 'done', reqId: m.reqId })));
  }, () => {});
  sock.on('data', (c) => parser.push(c));
  return new Promise((r) => sock.on('connect', () => {
    sock.write('GET /agent HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    setTimeout(() => { sock.write(frameMasked(JSON.stringify({ type: 'hello', models: ['M1'] }))); r(sock); }, 150);
  }));
}

(async () => {
  const srv = await gw.start();
  const log = [];
  log.push(['baseline', await health()]);

  const s1 = await conn();
  log.push(['after connect #1', await health()]);

  const s2 = await conn();
  log.push(['after connect #2 (replaces)', await health()]);

  s2.destroy();
  await sleep(500);
  log.push(['500ms after destroying the LIVE (#2) socket', await health()]);

  await sleep(1500);
  log.push(['2s later', await health()]);

  s1.destroy();
  await sleep(500);
  log.push(['after destroying the stale (#1) socket too', await health()]);

  // abrupt RST instead of clean FIN
  const s3 = await conn();
  await sleep(150);
  log.push(['connect #3', await health()]);
  s3.resetAndDestroy ? s3.resetAndDestroy() : s3.destroy(new Error('hard reset'));
  await sleep(600);
  log.push(['after hard reset of #3', await health()]);

  for (const [k, v] of log) console.log(k, '=>', JSON.stringify(v));
  srv.close();
  process.exit(0);
})();
