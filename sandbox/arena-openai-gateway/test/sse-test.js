'use strict';
const path = require('path');
const SSE = require(path.join(__dirname, '..', 'extension', 'sse-parse.js'));

let bad = 0;
function t(name, cond, extra) {
  if (!cond) bad++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
}

const A = 'data: {"type":"text-start"}\n\ndata: {"type":"text-delta","delta":"Hello"}\n\ndata: {"type":"text-delta","delta":" world"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n';
const a = SSE.parse(A);
t('text deltas joined', a.text === 'Hello world', a.text);
t('done flag', a.done === true, a.done);
t('no error', a.error === null, a.error);

const b = SSE.parse('data: {"type":"reasoning-delta","delta":"secret"}\n\ndata: {"type":"text-delta","delta":"Answer"}\n\n');
t('reasoning excluded', b.text === 'Answer', b.text);

const c = SSE.parse('data: {"content":{"parts":[{"text":"Nested"}]}}\n\n');
t('nested text found', c.text === 'Nested', c.text);

t('bare text key', SSE.parse('data: {"text":"plain"}\n\n').text === 'plain', null);

t('error surfaced', SSE.parse('data: {"type":"error","error":{"message":"rate limited"}}\n\n').error === 'rate limited', null);

const f = SSE.parse('data: {"delta":"ab"}\n\ndata: {"delta":"cd"}\n\ndata: {"delt');
t('truncated tail ignored', f.text === 'abcd', f.text);

t('junk ignored', SSE.parse('event: x\n\nnot-json\n\ndata: {"delta":"ok"}\n\n').text === 'ok', null);

t('crlf handled', SSE.parse('data: {"delta":"a"}\r\n\r\ndata: {"delta":"b"}\r\n\r\n').text === 'ab', null);

const pre = SSE.parse('data: {"delta":"Hello"}\n\n');
t('partial parse returns prefix', pre.text === 'Hello', pre.text);

console.log(bad ? 'FAILURES: ' + bad : 'all sse tests pass');
process.exit(bad ? 1 : 0);
