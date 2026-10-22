'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const files = [
  'gateway/ws.js',
  'gateway/server.js',
  'extension/sse-parse.js',
  'extension/page-hook.js',
  'extension/bridge.js',
  'extension/sw.js',
  'test/selftest.js'
];

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  try {
    new vm.Script(src, { filename: f });
    console.log('OK    ' + f + ' (' + src.length + ' bytes)');
  } catch (e) {
    bad++;
    console.log('FAIL  ' + f + ' ' + e.message);
  }
}

const mf = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
const worlds = (mf.content_scripts || []).map((c) => c.world);
const ok = mf.manifest_version === 3 && worlds.indexOf('MAIN') >= 0 && worlds.indexOf('ISOLATED') >= 0;
console.log('manifest v3=' + (mf.manifest_version === 3) + ' worlds=' + JSON.stringify(worlds));
if (!ok) bad++;

console.log(bad ? 'FAILURES: ' + bad : 'all scripts parse');
process.exit(bad ? 1 : 0);
