'use strict';
// Why does /health still report agent:true after the agent socket dies?
process.env.PORT = '8802';
process.env.QUIET = '1';
const net = require('net'), http = require('http'), crypto = require('crypto'), path = require('path');
const P = (f) => path.join(__dirname, '..', 'arena', f);
const { frameMasked, createParser } = require(P('ws.js'));
const gw = require(P('server.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];

function health() {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 8802, path: '/health' }, (r) => {
      const p = []; r.on('data', (c) => p.push(c)); r.on('end', () => res(JSON.parse(Buffer.concat(p))));
    }).on('error', rej);
  });
}
function conn(tag, opts) {
  const sock = net.connect(8802, '127.0.0.1');
  const parser = createParser((raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'request') sock.write(frameMasked(JSON.stringify({ type: 'done', reqId: m.reqId })));
  }, () => events.push(tag + ': client parser onClose'));
  sock.on('data', (c) => parser.push(c));
  sock.on('close', () => events.push(tag + ': CLIENT socket closed'));
  return new Promise((r) => sock.on('connect', () => {
    sock.write('GET /agent HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    setTimeout(() => { sock.write(frameMasked(JSON.stringify({ type: 'hello', models: [tag] }))); r(sock); }, 150);
  }));
}

(async () => {
  gw.server.on('connection', (s) => {
    const id = 'srv#' + (Math.random() * 1e6 | 0);
    events.push(id + ' connection');
    for (const e of ['end', 'close', 'error', 'timeout']) s.on(e, (x) => events.push(id + ' ' + e + (e === 'error' ? ':' + (x && x.code) : '')));
  });
  const srv = await gw.start();

  const s1 = await conn('C1');
  events.push('health after C1: ' + JSON.stringify(await health()));
  const s2 = await conn('C2');
  events.push('health after C2: ' + JSON.stringify(await health()));

  events.push('--- s2.destroy() (raw FIN/RST, no close frame) ---');
  s2.destroy();
  await sleep(1200);
  events.push('health: ' + JSON.stringify(await health()));

  events.push('--- s1.end() then destroy ---');
  s1.end(); await sleep(300); s1.destroy();
  await sleep(1200);
  events.push('health: ' + JSON.stringify(await health()));

  const s3 = await conn('C3');
  events.push('health after C3: ' + JSON.stringify(await health()));
  events.push('--- s3 sends a proper close frame (opcode 8) ---');
  s3.write(frameMasked('', 8));
  await sleep(1200);
  events.push('health: ' + JSON.stringify(await health()));
  s3.destroy();

  console.log(events.join('\n'));
  console.log('server connection count =', await new Promise((r) => gw.server.getConnections((e, n) => r(n))));
  srv.close();
  process.exit(0);
})();
