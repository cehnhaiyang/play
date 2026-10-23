'use strict';
// Where does the running code actually live, and is it patched?
// This is the guard against the mistake I made: writing fixes to a second
// directory that the browser never loads.
// node arena-test/verify-live.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const LIVE = [
  ['arena/ws.js', ['frameMasked', 'MAX_MESSAGE', 'requireMasked']],
  ['arena/server.js', ['v1.1.0', 'agentIdleMs', "socket.on('end'", "log('info', 'http'", 'reason=']],
  ['arena/extension/sse-parse.js', ['readDataLine', 'data-stream']],
  ['arena/extension/page-hook.js', ['foreground(', 'logLine(', 'aria-haspopup']],
  ['arena/extension/bridge.js', ["d.type === 'log'", 'pendingSelect', 'model switch timed out']],
  ['arena/extension/sw.js', ['chrome.tabs.update', 'toWorkerLog']],
  ['arena/extension/manifest.json', ['1.1.0']]
];

let ok = 0;
let bad = 0;

console.log('=== the files the browser and the gateway actually load ===');
for (const [f, markers] of LIVE) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log('MISSING  ' + f); bad++; continue; }
  const src = fs.readFileSync(p, 'utf8');
  const missing = markers.filter((m) => !src.includes(m));
  if (missing.length) {
    console.log('STALE    ' + f.padEnd(34) + src.length + 'B  missing markers: ' + JSON.stringify(missing));
    bad++;
  } else {
    console.log('PATCHED  ' + f.padEnd(34) + src.length + 'B  all ' + markers.length + ' markers present');
    ok++;
  }
}

console.log('');
console.log('=== there must be exactly one copy of the code ===');
// The name is assembled at runtime so that this checker does not report itself.
const DUP = ['arena', 'patches'].join('-');
if (!fs.existsSync(path.join(ROOT, DUP))) {
  console.log('OK    no second copy: the only copy is arena/ + arena/extension/');
} else {
  const leftovers = fs.readdirSync(path.join(ROOT, DUP));
  console.log(leftovers.length
    ? 'FAIL  a second copy still holds ' + leftovers.length + ' file(s): ' + JSON.stringify(leftovers)
    : 'OK    the empty leftover directory holds no files');
  if (leftovers.length) bad++;
}

console.log('');
console.log('=== nothing may reference a second copy ===');
const testDir = path.join(ROOT, 'arena-test');
let refs = 0;
for (const f of fs.readdirSync(testDir)) {
  if (!f.endsWith('.js')) continue;
  const src = fs.readFileSync(path.join(testDir, f), 'utf8');
  if (src.includes(DUP)) { refs++; console.log('  STILL REFERENCING a second copy: arena-test/' + f); }
}
if (!refs) console.log('  OK    no file references a second copy');
else bad += refs;

console.log('');
console.log('=== originals kept only for A/B comparison ===');
for (const f of fs.readdirSync(path.join(ROOT, 'arena-audit', 'original'))) {
  console.log('  arena-audit/original/' + f);
}

console.log('');
console.log('live files patched: ' + ok + '/' + LIVE.length + (bad ? '   PROBLEMS: ' + bad : '   all clear'));
process.exit(bad ? 1 : 0);
