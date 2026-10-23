// MAIN world, document_start.
// Strategy: drive the real arena.ai UI exactly like a user (set textarea, click send)
// and observe the page's own SSE response. No credential copying, no request forgery.
(function () {
  'use strict';
  if (window.__ARENA_BRIDGE_HOOKED__) return;
  window.__ARENA_BRIDGE_HOOKED__ = true;

  var NS = 'arena-bridge';
  var captured = [];   // {url, body, stream}
  var recaptchaCall = null;

  function reply(obj) {
    obj.__ns = NS;
    window.postMessage(obj, location.origin);
  }

  // ---- 1. observe the page's own network traffic (read only) ----
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var p = origFetch.apply(this, arguments);
    try {
      if (/create-evaluation|post-to-evaluation/.test(url)) {
        var body = init && typeof init.body === 'string' ? init.body : null;
        var rec = { url: String(url), body: body, stream: null, done: false };
        captured.push(rec);
        if (captured.length > 40) captured.shift();
        p.then(function (res) {
          try {
            if (/post-to-evaluation/.test(url)) {
              res.clone().text().then(function (t) { rec.stream = t; rec.done = true; })
                .catch(function () { rec.done = true; });
            }
          } catch (e) {}
        }).catch(function () {});
      }
    } catch (e) {}
    return p;
  };

  // ---- 2. learn the recaptcha sitekey/action the page itself uses ----
  function wrapRecaptcha() {
    var g = window.grecaptcha;
    if (!g || !g.enterprise || typeof g.enterprise.execute !== 'function') return;
    var orig = g.enterprise.execute;
    if (typeof orig !== 'function' || orig.__wrapped) return;
    var wrapped = function () {
      try {
        recaptchaCall = {
          sitekey: arguments[0],
          opts: arguments[1] ? JSON.parse(JSON.stringify(arguments[1])) : null
        };
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    wrapped.__wrapped = true;
    g.enterprise.execute = wrapped;
  }
  var rcTimer = setInterval(wrapRecaptcha, 400);
  setTimeout(function () { clearInterval(rcTimer); }, 120000);

  // ---- 3. DOM helpers ----
  function visibleTextareas() {
    return Array.prototype.slice.call(document.querySelectorAll('textarea'))
      .filter(function (t) { return t.offsetParent !== null && !t.disabled && !t.readOnly; });
  }

  function composer() {
    var all = visibleTextareas();
    for (var i = 0; i < all.length; i++) {
      var ph = all[i].getAttribute('placeholder') || '';
      if (/ask anything|message|reply|输入/i.test(ph)) return all[i];
    }
    return all.length ? all[all.length - 1] : null;
  }

  function setValue(el, v) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function sendButton() {
    var b = document.querySelector('button[aria-label="Send message"]');
    if (b) return b;
    var bs = Array.prototype.slice.call(document.querySelectorAll('button'));
    for (var i = bs.length - 1; i >= 0; i--) {
      if (!bs[i].disabled && bs[i].closest('form')) return bs[i];
    }
    return null;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function waitFor(fn, ms) {
    var t0 = Date.now();
    while (Date.now() - t0 < (ms || 15000)) {
      var v = fn();
      if (v) return v;
      await sleep(200);
    }
    return null;
  }

  // ---- 4. switch model through the real picker ----
  async function selectModel(name) {
    var current = new URL(location.href).searchParams.get('model_a');
    if (current === name) return { changed: false, model: name };

    var trigger = null;
    var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].innerText || '').trim();
      if (t && t.length < 60 && /max|direct|router/i.test(t) && !btns[i].disabled) { trigger = btns[i]; break; }
    }
    if (!trigger) return { changed: false, error: 'model picker trigger not found' };
    trigger.click();

    var search = await waitFor(function () {
      return document.querySelector('input[placeholder="Search models"]');
    }, 8000);
    if (!search) { document.body.click(); return { changed: false, error: 'search box not found' }; }

    setValue(search, name);
    await sleep(600);

    var opt = await waitFor(function () {
      var os = Array.prototype.slice.call(document.querySelectorAll('[role="option"]'));
      for (var j = 0; j < os.length; j++) {
        if ((os[j].innerText || '').indexOf(name) >= 0) return os[j];
      }
      return null;
    }, 8000);
    if (!opt) { document.body.click(); return { changed: false, error: 'option not found: ' + name }; }

    opt.click();
    await sleep(900);
    return { changed: true, model: name, href: location.href };
  }

  // ---- 5. pull assistant text out of an SSE body ----
  function collectText(sse) {
    return window.ArenaSSE.parse(sse).texts;
  }

  // ---- 6. the one public operation: send a prompt, stream deltas out ----
  async function send(reqId, prompt) {
    var ta = await waitFor(composer, 10000);
    if (!ta) { reply({ type: 'error', reqId: reqId, message: 'composer not found' }); return; }

    setValue(ta, prompt);
    await sleep(350);

    var btn = await waitFor(function () { var b = sendButton(); return b && !b.disabled ? b : null; }, 8000);
    if (!btn) { reply({ type: 'error', reqId: reqId, message: 'send button stayed disabled' }); return; }

    var mark = captured.length;
    btn.click();

    var rec = await waitFor(function () {
      for (var i = mark; i < captured.length; i++) {
        if (/post-to-evaluation/.test(captured[i].url)) return captured[i];
      }
      return null;
    }, 20000);
    if (!rec) { reply({ type: 'error', reqId: reqId, message: 'no evaluation request observed' }); return; }

    var prevLen = 0;
    var sent = 0;
    var t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      await sleep(400);
      var s = rec.stream || '';
      if (s.length !== prevLen) {
        var parsed = window.ArenaSSE.parse(s);
        if (parsed.text.length > sent) {
          reply({ type: 'delta', reqId: reqId, text: parsed.text.slice(sent) });
          sent = parsed.text.length;
        }
        if (parsed.error) {
          reply({ type: 'error', reqId: reqId, message: parsed.error });
          return;
        }
        prevLen = s.length;
      }
      if (rec.done) {
        var fin = window.ArenaSSE.parse(rec.stream || '');
        if (fin.text.length > sent) reply({ type: 'delta', reqId: reqId, text: fin.text.slice(sent) });
        if (fin.error) { reply({ type: 'error', reqId: reqId, message: fin.error }); return; }
        reply({ type: 'done', reqId: reqId, len: fin.text.length });
        return;
      }
    }
    reply({ type: 'error', reqId: reqId, message: 'stream timeout' });
  }

  // ---- 7. model list from the page's own catalog endpoint ----
  async function listModels() {
    try {
      var r = await origFetch.call(window, '/nextjs-api/model-catalog', { credentials: 'include' });
      var j = await r.json();
      var cats = Array.isArray(j) ? j : [j];
      var seen = {};
      var out = [];
      cats.forEach(function (c) {
        (c.models || []).forEach(function (m) {
          if (m.userSelectable === false) return;
          var key = m.displayName || m.publicName;
          if (!key || seen[key]) return;
          seen[key] = 1;
          // Aliases are derived from the live catalogue only: the public name and
          // the record uuid are accepted spellings of the same picker entry.
          var aliases = [];
          if (m.publicName && m.publicName !== key) aliases.push(m.publicName);
          if (m.id && String(m.id) !== key) aliases.push(String(m.id));
          out.push({ id: key, owned_by: m.organization || 'arena', aliases: aliases, provider: m.provider, arena: c.arena });
        });
      });
      return out;
    } catch (e) {
      return [];
    }
  }

  // ---- 8. message loop with the isolated bridge ----
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__ns !== NS || d.dir !== 'to-page') return;

    if (d.op === 'ping') { reply({ type: 'pong', ready: true }); return; }
    if (d.op === 'info') {
      reply({ type: 'info', reqId: d.reqId, href: location.href, recaptcha: recaptchaCall, captured: captured.length });
      return;
    }
    if (d.op === 'models') {
      listModels().then(function (list) { reply({ type: 'models', reqId: d.reqId, models: list }); });
      return;
    }
    if (d.op === 'select') {
      selectModel(d.model).then(function (r) { reply({ type: 'selected', reqId: d.reqId, result: r }); });
      return;
    }
    if (d.op === 'send') {
      send(d.reqId, d.prompt).catch(function (e) {
        reply({ type: 'error', reqId: d.reqId, message: String((e && e.message) || e) });
      });
      return;
    }
  });

  reply({ type: 'hook-ready' });
})();
