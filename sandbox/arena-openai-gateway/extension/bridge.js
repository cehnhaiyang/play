// ISOLATED world content script.
// Pure message relay: page (MAIN) <-> extension service worker <-> local gateway.
(function () {
  'use strict';
  var NS = 'arena-bridge';

  function toPage(obj) {
    obj.__ns = NS;
    obj.dir = 'to-page';
    window.postMessage(obj, location.origin);
  }

  function toWorker(obj) {
    try { chrome.runtime.sendMessage(obj, function () { void chrome.runtime.lastError; }); } catch (e) {}
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
        if (ready) toWorker({ type: 'arenaBridgeStatus', connected: true, models: modelCache.length });
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
      modelCache = d.models.map(function (m) { return { id: m.id, owned_by: m.owned_by }; });
      toWorker({ type: 'arenaBridgeRegister', models: modelCache });
      return;
    }

    if (d.type === 'selected') {
      var cb = pendingSelect[d.reqId];
      if (cb) { delete pendingSelect[d.reqId]; cb(); }
      return;
    }

    if (d.type === 'delta' || d.type === 'done' || d.type === 'error') {
      toWorker({ type: 'arenaBridgeFrame', frame: { type: d.type, reqId: d.reqId, text: d.text, message: d.message, len: d.len, result: d.result } });
    }
  });

  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (!msg || !msg.type) return false;

    if (msg.type === 'arenaBridgeRequest') {
      var r = msg.req || {};
      var go = function () { toPage({ op: 'send', reqId: r.reqId, prompt: r.content }); };
      if (r.model) {
        var sid = 'sel-' + r.reqId;
        pendingSelect[sid] = go;
        toPage({ op: 'select', reqId: sid, model: r.model });
        setTimeout(function () {
          if (pendingSelect[sid]) { delete pendingSelect[sid]; go(); }
        }, 25000);
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

  // periodic keepalive so the MV3 worker is not suspended mid-stream
  setInterval(function () {
    toPage({ op: 'ping' });
  }, 20000);
})();
