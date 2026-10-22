// MAIN world helper: turn arena's SSE body into assistant text.
(function () {
  'use strict';

  var TEXT_KEYS = ['delta', 'textDelta', 'text_delta', 'text', 'content', 'value', 'token'];
  var SKIP = /^(reasoning|thinking|tool-|step-|data-|source-|start|finish-step|ping|heartbeat)/;
  var DONE = /^(finish|done|end)$/;

  function pickText(o, d) {
    d = d || 0;
    if (d > 6 || o === null || typeof o !== 'object') return null;
    for (var i = 0; i < TEXT_KEYS.length; i++) {
      var v = o[TEXT_KEYS[i]];
      if (typeof v === 'string' && v) return v;
      if (v && typeof v === 'object') {
        var r = pickText(v, d + 1);
        if (r) return r;
      }
    }
    var ks = Object.keys(o);
    for (var j = 0; j < ks.length; j++) {
      var w = o[ks[j]];
      if (w && typeof w === 'object') {
        var q = pickText(w, d + 1);
        if (q) return q;
      }
    }
    return null;
  }

  function readFrame(o) {
    var r = { text: '', error: null, done: false };
    if (!o || typeof o !== 'object') return r;
    if (o.type === 'error' || (o.error && typeof o.error === 'object')) {
      r.error = String((o.error && (o.error.message || o.error)) || o.message || 'stream error');
      return r;
    }
    if (typeof o.type === 'string' && DONE.test(o.type)) { r.done = true; return r; }
    if (o.done === true) { r.done = true; return r; }
    if (typeof o.type === 'string' && SKIP.test(o.type)) return r;
    var t = pickText(o);
    r.text = t || '';
    return r;
  }

  function parse(sse) {
    var out = { texts: [], text: '', error: null, done: false, frames: 0 };
    if (!sse) return out;
    var lines = String(sse).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.slice(0, 5) !== 'data:') continue;
      var raw = line.slice(5).trim();
      if (!raw) continue;
      if (raw === '[DONE]') { out.done = true; continue; }
      var o;
      try { o = JSON.parse(raw); } catch (e) { continue; }
      var f = readFrame(o);
      out.frames++;
      if (f.error) out.error = f.error;
      if (f.done) out.done = true;
      if (f.text) { out.texts.push(f.text); out.text += f.text; }
    }
    return out;
  }

  var api = { parse: parse, readFrame: readFrame, pickText: pickText };
  if (typeof globalThis !== 'undefined') globalThis.ArenaSSE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
