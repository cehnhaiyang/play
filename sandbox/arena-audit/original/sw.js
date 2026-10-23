// MV3 service worker: single durable WebSocket to the local gateway.
'use strict';

var GATEWAY = 'ws://127.0.0.1:8787/agent';
var RETRY_MS = 2000;
var KEEPALIVE_MS = 20000;

var ws = null;
var connecting = false;
var tabId = null;
var backlog = [];
var lastModels = [];

function toTab(msg) {
  if (tabId === null) return;
  try {
    chrome.tabs.sendMessage(tabId, msg, function () { void chrome.runtime.lastError; });
  } catch (e) {}
}

function flush() {
  while (backlog.length) {
    var f = backlog.shift();
    try { ws.send(JSON.stringify(f)); } catch (e) { backlog.unshift(f); return; }
  }
}

function push(frame) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(frame)); return; }
    catch (e) {}
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
    flush();
    push({ type: 'hello', models: lastModels });
  };

  ws.onmessage = function (ev) {
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'request') {
      toTab({ type: 'arenaBridgeRequest', req: m });
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
    push(msg.frame);
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
