// arena-patches/sse-parse.js
// Drop-in replacement for arena/extension/sse-parse.js.
//
// 原实现只认 SSE 的 "data: {…}" 行，但 arena 的
// /nextjs-api/stream/create-evaluation 与 /stream/post-to-evaluation/<id>
// 返回的是 AI SDK 的 data-stream 协议：
//
//     a0:"OK"
//     ad:{"finishReason":"stop"}
//
// 即「<code>:<JSON>\n」，没有 "data:" 前缀。原 parse() 对真实响应
// 返回 text=""、frames=0、done=false —— 一句话都拿不到，最后 240s 超时。
// 实测（真实页面 /c/01a166b9…，post-to-evaluation）：
//     a0:"OK"\nad:{"finishReason":"stop"}\n
//
// 本实现同时支持两种协议，并给出明确的 done/error 判定。
(function () {
  'use strict';

  // AI SDK 文本增量码
  var TEXT_CODES = { '0': 1, '1': 1 };
  // 结束 / 错误码
  var FINISH_CODES = { 'd': 1, 'e': 1, 'z': 1 };
  var ERROR_CODES = { '3': 1, 'e': 1 };

  var TEXT_KEYS = ['delta', 'textDelta', 'text_delta', 'text', 'content', 'value', 'token'];
  var SKIP = /^(reasoning|thinking|tool-|step-|data-|source-|start|finish-step|ping|heartbeat)/;

  function parseMaybeJson(s) {
    if (typeof s !== 'string') return s;
    var t = s.trim();
    if (!t) return '';
    var c = t.charAt(0);
    if (c !== '"' && c !== '{' && c !== '[' && c !== 'n' && c !== 't' && c !== 'f') return s;
    try { return JSON.parse(t); } catch (e) { return s; }
  }

  // 从任意 JSON 里挑出文本
  function pickText(o, d) {
    d = d || 0;
    if (typeof o === 'string') return o;
    if (d > 6 || o === null || typeof o !== 'object') return null;
    if (Array.isArray(o)) {
      var acc = '';
      for (var k = 0; k < o.length; k++) {
        var r0 = pickText(o[k], d + 1);
        if (r0) acc += r0;
      }
      return acc || null;
    }
    for (var i = 0; i < TEXT_KEYS.length; i++) {
      var v = o[TEXT_KEYS[i]];
      if (typeof v === 'string' && v) return v;
      if (v && typeof v === 'object') {
        var r = pickText(v, d + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function errText(o) {
    if (o && typeof o === 'object') {
      if (typeof o.message === 'string' && o.message) return o.message;
      if (typeof o.errorText === 'string' && o.errorText) return o.errorText;
      if (o.error && typeof o.error === 'object') return errText(o.error);
      if (typeof o.error === 'string' && o.error) return o.error;
    }
    if (typeof o === 'string' && o) return o;
    return null;
  }

  // ---- data-stream 一行 ----
  // 真实字节（2026-10，/nextjs-api/stream/post-to-evaluation/<id>）：
  //     a0:"OK"\nad:{"finishReason":"stop"}\n
  // 前缀不是单字符：a0 / a2 / ad 都出现过，所以按「第一个 ':' 之前」取，
  // 不假设长度；语义主要看 payload 本身。
  function readDataLine(line) {
    var out = { text: '', error: null, done: false, recognised: false };
    var i = line.indexOf(':');
    if (i <= 0 || i > 3) return out;
    var code = line.slice(0, i);
    if (!/^[0-9a-zA-Z]{1,3}$/.test(code)) return out;
    var val = parseMaybeJson(line.slice(i + 1));
    out.recognised = true;

    // 明确的错误码
    if (code === '3') { out.error = errText(val) || 'stream error'; out.done = true; return out; }
    // 明确的结束码
    if (code === 'd' || code === 'e' || code === 'z' || code === 'D') {
      out.done = true;
      if (val && typeof val === 'object') {
        var fr0 = val.finishReason || val.finish_reason;
        if (fr0 === 'error') out.error = errText(val) || 'finishReason=error';
      }
      return out;
    }
    // 对象里带 finishReason / error 的（ad 等）
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      var fr = val.finishReason || val.finish_reason;
      var e = errText(val);
      if (fr === 'error' || (e && (val.type === 'error' || val.error))) {
        out.error = e || 'finishReason=error';
        out.done = true;
        return out;
      }
      if (fr) { out.done = true; return out; }
    }
    // 文本：字符串 payload，或对象/数组里挑出来的文本
    if (typeof val === 'string') { out.text = val; return out; }
    var t = pickText(val);
    if (t) out.text = t;
    return out;
  }

  // ---- SSE 一行 ----
  function readSsePayload(raw) {
    var out = { text: '', error: null, done: false, recognised: true };
    if (raw === '[DONE]') { out.done = true; return out; }
    var o = parseMaybeJson(raw);
    if (typeof o === 'string') { out.text = o; return out; }
    if (!o || typeof o !== 'object') return out;
    var type = typeof o.type === 'string' ? o.type : '';
    if (type === 'error' || (o.error && typeof o.error === 'object')) {
      out.error = errText(o) || 'stream error';
      out.done = true;
      return out;
    }
    if (type === 'finish' || type === 'done' || type === 'end' || o.done === true) { out.done = true; return out; }
    if (type && SKIP.test(type)) return out;
    var t = pickText(o);
    if (t) out.text = t;
    return out;
  }

  function parse(body) {
    var out = { texts: [], text: '', error: null, done: false, frames: 0, protocol: null };
    if (!body) return out;
    var s = String(body);

    // 协议判定：出现 "data:" 行 -> SSE；否则按 data-stream 处理
    var isSse = /(^|\n)\s*data:/.test(s);
    out.protocol = isSse ? 'sse' : 'data-stream';

    var lines = s.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;

      var r;
      if (isSse) {
        // SSE：可能有多行 data:，累积到空行为止（此处按行独立处理足够，
        // 因为 arena 每条事件都是单行 data:）
        if (line.slice(0, 5) === 'data:') {
          r = readSsePayload(line.slice(5).trim());
        } else if (line.charAt(0) === ':') {
          continue;                       // 注释/心跳
        } else {
          continue;
        }
      } else {
        r = readDataLine(line);
        if (!r.recognised) continue;
      }

      out.frames++;
      if (r.error) out.error = r.error;
      if (r.done) out.done = true;
      if (r.text) { out.texts.push(r.text); out.text += r.text; }
    }
    return out;
  }

  var api = { parse: parse, readFrame: readSsePayload, pickText: pickText, readDataLine: readDataLine };
  if (typeof globalThis !== 'undefined') globalThis.ArenaSSE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
