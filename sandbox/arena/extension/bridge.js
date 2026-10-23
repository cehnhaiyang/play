// arena-patches/bridge.js
// Drop-in replacement for arena/extension/bridge.js.
//
// 相对原实现的关键改动
//   1. 转发 hook 的 log 帧到 service worker，最终打到网关 stdout。
//      没有这一步，命令行看不到「切模型到哪一步了、为什么失败」。
//   2. 模型切换失败/超时都带上阶段信息，不再只说 "model switch timed out"。
//   3. pendingSelect 带 deadline，收到迟到的 selected 时不再重复 go()（原实现会重复发送）。
//   4. 打开模型选择器失败时不静默：把 hook 的具体错误原样上报。
(function () {
  'use strict';
  var NS = 'arena-bridge';
  var SELECT_TIMEOUT_MS = 40000;

  function toPage(obj) {
    obj.__ns = NS;
    obj.dir = 'to-page';
    window.postMessage(obj, location.origin);
  }

  function toWorker(obj) {
    try { chrome.runtime.sendMessage(obj, function () { void chrome.runtime.lastError; }); } catch (e) {}
  }

  function log(text, reqId) {
    toWorker({ type: 'arenaBridgeFrame', frame: { type: 'log', reqId: reqId || 'bridge', text: text } });
  }

  var ready = false;
  var modelCache = [];
  var pendingSelect = {};

  function refreshModels() {
    var reqId = 'models-' + Date.now();
    toPage({ op: 'models', reqId: reqId });
    setTimeout(function () {
      if (modelCache.length) {
        toWorker({ type: 'arenaBridgeRegister', models: modelCache });
        log('catalogue: ' + modelCache.length + ' models');
      }
    }, 2500);
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__ns !== NS) return;

    if (d.type === 'hook-ready') {
      ready = true;
      toWorker({ type: 'arenaBridgeRegister', models: [] });
      refreshModels();
      return;
    }

    if (d.type === 'models' && Array.isArray(d.models)) {
      modelCache = d.models.map(function (m) {
        return { id: m.id, owned_by: m.owned_by, aliases: Array.isArray(m.aliases) ? m.aliases : [] };
      });
      toWorker({ type: 'arenaBridgeRegister', models: modelCache });
      return;
    }

    // hook 的逐条操作日志 -> 网关
    if (d.type === 'log') {
      log(d.text, d.reqId);
      return;
    }

    if (d.type === 'selected') {
      var pend = pendingSelect[d.reqId];
      if (!pend) return;
      delete pendingSelect[d.reqId];
      if (pend.done) return;                 // 迟到的回复：不要重复发送
      pend.done = true;
      var res = d.result || {};
      if (res.error) {
        log('model switch FAILED: ' + res.error, pend.reqId);
        toWorker({
          type: 'arenaBridgeFrame',
          frame: { type: 'error', reqId: pend.reqId, message: 'model switch failed: ' + res.error }
        });
        return;
      }
      log('model switch ok: ' + JSON.stringify(res.chip || res.model || ''), pend.reqId);
      pend.go();
      return;
    }

    if (d.type === 'delta' || d.type === 'done' || d.type === 'error') {
      toWorker({ type: 'arenaBridgeFrame', frame: { type: d.type, reqId: d.reqId, text: d.text, message: d.message, len: d.len } });
    }
  });

  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (!msg || !msg.type) return false;

    if (msg.type === 'arenaBridgeRequest') {
      var r = msg.req || {};
      log('received request ' + r.reqId + ' model=' + JSON.stringify(r.model || '') + ' modality=' + (r.modality || 'chat'));
      var go = function () { toPage({ op: 'send', reqId: r.reqId, prompt: r.content }); };
      if (r.model) {
        var sid = 'sel-' + r.reqId;
        pendingSelect[sid] = { go: go, reqId: r.reqId, done: false, at: Date.now() };
        toPage({ op: 'select', reqId: sid, model: r.model });
        setTimeout(function () {
          var still = pendingSelect[sid];
          if (!still) return;
          delete pendingSelect[sid];
          if (still.done) return;
          still.done = true;
          log('model switch TIMED OUT after ' + SELECT_TIMEOUT_MS + 'ms', still.reqId);
          toWorker({
            type: 'arenaBridgeFrame',
            frame: { type: 'error', reqId: still.reqId,
                     message: 'model switch timed out after ' + SELECT_TIMEOUT_MS + 'ms (no reply from the page; check the hook log lines above)' }
          });
        }, SELECT_TIMEOUT_MS);
      } else {
        go();
      }
      reply({ ok: true });
      return true;
    }

    if (msg.type === 'arenaBridgeSelect') {
      toPage({ op: 'select', reqId: 'sel-' + Date.now(), model: msg.model });
      reply({ ok: true });
      return true;
    }

    if (msg.type === 'arenaBridgeInfo') {
      toPage({ op: 'info', reqId: 'info-' + Date.now() });
      reply({ ok: true });
      return true;
    }

    return false;
  });

  setInterval(function () { toPage({ op: 'ping' }); }, 20000);
})();
