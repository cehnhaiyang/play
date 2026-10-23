'use strict';
// 用真实抓到的响应体验证已安装的 arena/extension/sse-parse.js。
// 对照对象是 arena-audit/original/sse-parse.js（改动前的原件，仅用于对比）。
// 真实样本来源：真实登录态页面 /c/01a166b9-2756-76fb-a4ab-e5e23a4c2013 发 "Say OK"，
// 拦截到的 /nextjs-api/stream/post-to-evaluation/<id> 响应正文。
// node arena-test/sse-parse-test.js
const assert = require('assert');
const path = require('path');

const ORIG = require(path.join(__dirname, '..', 'arena-audit', 'original', 'sse-parse.js'));
const FIXED = require(path.join(__dirname, '..', 'arena', 'extension', 'sse-parse.js'));

// ---- 真实字节 ----
const REAL_SHORT = 'a0:"OK"\nad:{"finishReason":"stop"}\n';

const results = [];
function t(name, fn) {
  try { results.push(['PASS', name, String(fn() === undefined ? '' : fn())]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

t('原实现：真实响应体解析出 0 文本（这就是"网关返回空"的根因）', () => {
  const r = ORIG.parse(REAL_SHORT);
  assert.strictEqual(r.frames, 0);
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.done, false);
  return 'text=' + JSON.stringify(r.text) + ' frames=' + r.frames + ' done=' + r.done;
});

t('修正后：真实响应体 -> text="OK", frames=2, done=true', () => {
  const r = FIXED.parse(REAL_SHORT);
  assert.strictEqual(r.text, 'OK');
  assert.strictEqual(r.frames, 2);
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.protocol, 'data-stream');
  return JSON.stringify(r);
});

t('多段增量按顺序拼接（a0 多条 + ad 结束）', () => {
  const body = 'a0:"He"\na0:"llo"\na0:", "\na0:"world"\nad:{"finishReason":"stop"}\n';
  const r = FIXED.parse(body);
  assert.strictEqual(r.text, 'Hello, world');
  assert.strictEqual(r.done, true);
  return r.text;
});

t('对象型 data part 里的文本被取出（pickText 递归）', () => {
  const body = 'a2:[{"type":"text","value":"chunk"}]\nad:{"finishReason":"stop"}\n';
  const r = FIXED.parse(body);
  assert.strictEqual(r.text, 'chunk');
  return r.text;
});

t('错误码 3: -> error 且不再当成正常结束', () => {
  const r = FIXED.parse('a0:"partial"\n3:"upstream blew up"\n');
  assert.strictEqual(r.text, 'partial');
  assert.strictEqual(r.error, 'upstream blew up');
  assert.strictEqual(r.done, true);
  return JSON.stringify(r.error);
});

t('finishReason:"error" 也算失败', () => {
  const r = FIXED.parse('a0:"x"\nad:{"finishReason":"error","message":"boom"}\n');
  assert.ok(r.error, 'expected an error');
  return r.error;
});

t('不认识的 payload 不会被误当成文本（保持 0 文本）', () => {
  const r = FIXED.parse('f:{"messageId":"m1"}\nb:{"x":1}\nad:{"finishReason":"stop"}\n');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.done, true);
  return 'frames=' + r.frames;
});

t('旧的 SSE 格式仍然解析（data: {...}）', () => {
  const r = FIXED.parse('data: {"type":"text-delta","textDelta":"OK"}\n\ndata: [DONE]\n\n');
  assert.strictEqual(r.text, 'OK');
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.protocol, 'sse');
  return r.text;
});

t('空响应体不报错', () => {
  const r = FIXED.parse('');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.frames, 0);
});

// 流式调用：模拟 hook 每 400ms 用累积正文重解析，验证增量切片
t('流式累积正文 -> 增量切片正确（hook 的 sent/prevLen 逻辑）', () => {
  const full = 'a0:"He"\na0:"llo"\nad:{"finishReason":"stop"}\n';
  const snapshots = [full.slice(0, 9), full.slice(0, 17), full];
  let sent = 0; const deltas = [];
  for (const s of snapshots) {
    const parsed = FIXED.parse(s);
    if (parsed.text.length > sent) { deltas.push(parsed.text.slice(sent)); sent = parsed.text.length; }
  }
  assert.deepStrictEqual(deltas, ['He', 'llo']);
  return JSON.stringify(deltas);
});

t('未捕获到的端点形状不做断言：未知码不产生文本也不崩', () => {
  // 这是通用稳健性检查，不是真实样本。
  const r = FIXED.parse('x9:{"weird":true}\nad:{"finishReason":"stop"}\n');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.done, true);
  return 'frames=' + r.frames;
});

for (const r of results) console.log(r.join(' | '));
const fails = results.filter((r) => r[0] === 'FAIL').length;
console.log(fails ? 'FAILURES: ' + fails + '/' + results.length : 'ALL ' + results.length + ' CASES PASS');
