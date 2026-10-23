'use strict';
// Runs the shared RFC6455 cases against the shipped module.
// node arena-test/ws-test.js
const run = require('./ws-cases');
const results = run(require('../arena/ws.js'));
for (const r of results) console.log(r.join(' | '));
const fails = results.filter((r) => r[0] === 'FAIL').length;
console.log(fails ? 'FAILURES: ' + fails + '/' + results.length : 'ALL ' + results.length + ' CASES PASS');
