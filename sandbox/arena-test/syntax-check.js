'use strict';
// Syntax-check every live file (vm.Script compiles without executing).
// node arena-test/syntax-check.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'arena/ws.js', 'arena/server.js',
  'arena/extension/sse-parse.js', 'arena/extension/page-hook.js',
  'arena/extension/bridge.js', 'arena/extension/sw.js'
];

let bad = 0;
for (const f of FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log('MISSING ' + f); bad++; continue; }
  const src = fs.readFileSync(p, 'utf8');
  try {
    new vm.Script(src, { filename: f });
    console.log('OK    ' + f.padEnd(34) + src.length + ' bytes');
  } catch (e) {
    bad++;
    console.log('FAIL  ' + f.padEnd(34) + e.message);
  }
}
// manifest must be valid JSON with the expected entries
const m = 'arena/extension/manifest.json';
try {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, m), 'utf8'));
  const js = j.content_scripts.flatMap((c) => c.js);
  console.log('OK    ' + m.padEnd(34) + 'v' + j.version + ' scripts=' + JSON.stringify(js) + ' perms=' + JSON.stringify(j.permissions));
} catch (e) { bad++; console.log('FAIL  ' + m + ' ' + e.message); }

// the originals kept for A/B must still parse too
const orig = path.join(ROOT, 'arena-audit', 'original');
for (const f of fs.readdirSync(orig)) {
  if (!f.endsWith('.js')) continue;
  try { new vm.Script(fs.readFileSync(path.join(orig, f), 'utf8'), { filename: f }); }
  catch (e) { bad++; console.log('FAIL  arena-audit/original/' + f + ' ' + e.message); }
}
console.log(bad ? '\nSYNTAX ERRORS: ' + bad : '\nall files parse cleanly');
