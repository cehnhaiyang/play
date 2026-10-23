// The MV3 service worker: one durable WebSocket to the local gateway.
//
// Why it looks like this:
//   1. It must activate the tab before driving the UI. arena does not render an
//      interactive composer while a tab is in the background: the whole composer
//      lives in body > div#S:2[hidden] where the textarea measures 0x0 and the
//      Send button stays disabled, so any background automation just times out.
//   2. Every stage is reported to the gateway as a type:"log" frame, so the
//      terminal shows how far a request got instead of going silent.
//   3. A per-request watchdog reports the stage it stalled at.
//   4. The backlog is only retained when a write actually fails; ws.send does
//      not reliably throw on a closing socket.
'use strict';

var GATEWAY = 'ws://127.0.0.1:8787/agent';
var RETRY_MS = 2000;
var KEEPALIVE_MS = 20000;
var REQ_DEADLINE_MS = 300000;

var ws = null;
var connecting = false;
var tabId = null;
var backlog = [];
var lastModels = [];
var inflight = {};

function toWorkerLog(text) {
  push({ type: 'log', reqId: 'sw', text: text });
}

function toTab(msg) {
  if (tabId === null) { toWorkerLog('no tab registered yet; dropping ' + (msg && msg.type)); return; }
  try {
    chrome.tabs.sendMessage(tabId, msg, function () { void chrome.runtime.lastError; });
  } catch (e) {
    toWorkerLog('sendMessage failed: ' + e.message);
  }
}

function flush() {
  while (backlog.length) {
    var f = backlog[0];
    try {
      ws.send(JSON.stringify(f));
      backlog.shift();
    } catch (e) {
      return;                       // keep it queued; retry on next flush
    }
  }
}

function push(frame) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(frame)); return; } catch (e) {}
  }
  if (backlog.length < 500) backlog.push(frame);
}

function connect() {
  if (connecting) return;
  connecting = true;
  try {
    ws = new WebSocket(GATEWAY);
  } catch (e) {
    connecting = false;
    setTimeout(connect, RETRY_MS);
    return;
  }

  ws.onopen = function () {
    connecting = false;
    toWorkerLog('connected to ' + GATEWAY);
    flush();
    push({ type: 'hello', models: lastModels });
  };

  ws.onmessage = function (ev) {
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'request') {
      // 先把标签页拉到前台，再驱动 UI：后台标签页里 arena 的 composer 不可用
      activateTabThen(function (note) {
        toWorkerLog('req ' + m.reqId + ': ' + note);
        toTab({ type: 'arenaBridgeRequest', req: m });
        var id = m.reqId;
        inflight[id] = { at: Date.now(), stage: 'sent to tab' };
        setTimeout(function () {
          if (!inflight[id]) return;
          var age = Date.now() - inflight[id].at;
          if (age < REQ_DEADLINE_MS) return;
          delete inflight[id];
          push({ type: 'error', reqId: id, message: 'request watchdog: no completion after ' + age + 'ms (last stage: ' + inflight[id] + ')' });
        }, REQ_DEADLINE_MS);
      });
    }
  };

  ws.onclose = function () {
    connecting = false;
    ws = null;
    setTimeout(connect, RETRY_MS);
  };

  ws.onerror = function () {
    try { ws.close(); } catch (e) {}
  };
}

// 把注册过的标签页变成前台活动标签。失败不阻塞，只回报原因。
function activateTabThen(cb) {
  if (tabId === null) { cb('tab not registered'); return; }
  try {
    chrome.tabs.update(tabId, { active: true }, function (tab) {
      if (chrome.runtime.lastError || !tab) {
        cb('tab activate failed: ' + (chrome.runtime.lastError ? chrome.runtime.lastError.message : 'unknown'));
        return;
      }
      var winId = tab.windowId;
      if (winId === undefined) { cb('tab activated (window unknown)'); return; }
      try {
        chrome.windows.update(winId, { focused: true }, function () {
          var err = chrome.runtime.lastError;
          setTimeout(function () { cb(err ? 'tab activated, window focus failed: ' + err.message : 'tab activated and window focused'); }, 600);
        });
      } catch (e) {
        setTimeout(function () { cb('tab activated (windows API unavailable)'); }, 600);
      }
    });
  } catch (e) {
    cb('tab activate threw: ' + e.message);
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg || !msg.type) return false;

  if (msg.type === 'arenaBridgeRegister') {
    if (sender && sender.tab && sender.tab.id !== undefined) tabId = sender.tab.id;
    if (Array.isArray(msg.models) && msg.models.length) lastModels = msg.models;
    push({ type: 'hello', models: lastModels });
    reply({ ok: true, gateway: !!(ws && ws.readyState === WebSocket.OPEN) });
    return true;
  }

  if (msg.type === 'arenaBridgeFrame') {
    var f = msg.frame || {};
    if (f.reqId && inflight[f.reqId]) {
      if (f.type === 'done' || f.type === 'error') delete inflight[f.reqId];
      else inflight[f.reqId].stage = f.type;
    }
    push(f);
    reply({ ok: true });
    return true;
  }

  return false;
});

setInterval(function () {
  push({ type: 'ping' });
  if (!ws || ws.readyState !== WebSocket.OPEN) { connecting = false; connect(); }
}, KEEPALIVE_MS);

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
