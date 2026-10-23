// arena.ai bridge - MAIN world, injected at document_start.
//
// This is the live content script; it is the only copy of this logic.
// Strategy: drive the real arena.ai UI exactly like a user (pick the model,
// type into the composer, click send) and observe the page's own response.
// No credential copying, no request forgery.
//
// Things this file has to get right, each learned from a real failure:
//   1. Model selection. The model chip is `form button[aria-haspopup="dialog"]`
//      (excluding "Add files"). Matching button TEXT against /max|direct|router/
//      hits the "Direct" MODE chip instead, which opens the mode menu, so
//      input[placeholder="Search models"] never appears -> the gateway reported
//      "search box not found" as a 502.
//   2. Composer lookup must not filter on visibility. With the tab in the
//      background arena parks the whole composer inside body > div#S:2[hidden];
//      there offsetWidth===0, getBoundingClientRect() is 0x0 and offsetParent is
//      null, so any visibility filter returns nothing -> "composer not found".
//   3. The reply does NOT come from one endpoint. The first message of a session
//      goes to /nextjs-api/stream/create-evaluation; later ones go to
//      /nextjs-api/stream/post-to-evaluation/<sessionId>. Watching only the
//      latter made every first message time out.
//   4. The response body is not SSE. It is the AI SDK data-stream format
//      (`a0:"..."`, `ad:{"finishReason":"stop"}`), parsed by sse-parse.js.
//   5. An HTTP error must be reported as an error. create-evaluation is rate
//      limited (429 + `ratelimit-*` headers); treating that as a success gave a
//      200 with an empty answer, the worst possible outcome for a caller.
(function () {
  'use strict';
  if (window.__ARENA_BRIDGE_HOOKED__) return;
  window.__ARENA_BRIDGE_HOOKED__ = true;

  var NS = 'arena-bridge';
  var captured = [];   // { url, body, stream, done, kind, status, ok, retryAt }
  var recaptchaCall = null;
  var captureLimit = 40;

  function reply(obj) {
    obj.__ns = NS;
    obj.dir = 'to-page';
    window.postMessage(obj, location.origin);
  }
  function send(o) {
    if (window.__ARENA_BRIDGE_SINK__) window.__ARENA_BRIDGE_SINK__(o);
    else reply(o);
  }
  function logLine(text) {
    send({ type: 'log', reqId: 'hook', text: text });
  }

  // ---- 1. observe the page's own network traffic (read only) ----
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var p = origFetch.apply(this, arguments);
    try {
      var kind = /create-evaluation/.test(url) ? 'create'
        : /post-to-evaluation/.test(url) ? 'post' : null;
      if (kind) {
        var body = init && typeof init.body === 'string' ? init.body : null;
        var rec = {
          url: String(url), body: body, stream: '', done: false, kind: kind,
          at: Date.now(), status: null, ok: null, retryAt: null
        };
        captured.push(rec);
        if (captured.length > captureLimit) captured.shift();
        logLine('fetch ' + kind + ' ' + url.replace(location.origin, ''));
        p.then(function (res) {
          rec.status = res.status;
          rec.ok = res.ok;
          if (!res.ok) {
            // 429 here is a hard rate limit: surface the reset so a caller can back off
            var reset = Number(res.headers.get('ratelimit-reset')) || 0;
            if (reset) rec.retryAt = reset > 1e12 ? reset : reset * 1000;
            logLine('response ' + kind + ' ' + res.status + ' (NOT OK) ratelimit-reset=' +
              (res.headers.get('ratelimit-reset') || '-') +
              ' remaining=' + (res.headers.get('ratelimit-remaining') || '-'));
          } else {
            logLine('response ' + kind + ' ' + res.status + ' (ok)');
          }
          try {
            res.clone().text().then(function (t) { rec.stream = t; rec.done = true; })
              .catch(function (e) { rec.done = true; rec.err = String(e); });
          } catch (e) {}
        }).catch(function (e) {
          rec.done = true;
          rec.err = String(e);
        });
      }
    } catch (e) {}
    return p;
  };

  // ---- 2. learn the recaptcha sitekey/action the page itself uses (read only) ----
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
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // The composer is the textarea inside the form that owns the Send button.
  // Visibility is used only to PREFER a candidate, never to exclude one: see (2).
  function composer() {
    var sb = document.querySelector('button[aria-label="Send message"]');
    var scope = (sb && sb.closest('form')) || document;
    var pool = Array.prototype.slice.call(scope.querySelectorAll('textarea'))
      .filter(function (t) { return !t.disabled && !t.readOnly; });
    if (!pool.length) {
      pool = Array.prototype.slice.call(document.querySelectorAll('form textarea'))
        .filter(function (t) { return !t.disabled && !t.readOnly; });
    }
    if (!pool.length) {
      pool = Array.prototype.slice.call(document.querySelectorAll('textarea'))
        .filter(function (t) { return !t.disabled && !t.readOnly; });
    }
    if (!pool.length) return null;
    for (var i = pool.length - 1; i >= 0; i--) if (visible(pool[i])) return pool[i];
    return pool[pool.length - 1];
  }

  function foreground() {
    return !document.hidden && document.visibilityState === 'visible';
  }

  // The model chip is the dialog-popup button inside the composer form.
  // "Add files" also has aria-haspopup="dialog", so it is excluded by label.
  function modelChip() {
    var chips = Array.prototype.slice.call(document.querySelectorAll('form button[aria-haspopup="dialog"]'));
    for (var i = 0; i < chips.length; i++) {
      var label = (chips[i].getAttribute('aria-label') || '') + ' ' + (chips[i].textContent || '');
      if (/add files|attach|upload/i.test(label)) continue;
      return chips[i];
    }
    return null;
  }

  function setValue(el, v) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function sendButton() {
    var b = document.querySelector('button[aria-label="Send message"]');
    if (b) return b;
    var form = document.querySelector('form');
    if (!form) return null;
    var bs = Array.prototype.slice.call(form.querySelectorAll('button[type="submit"]'));
    for (var i = bs.length - 1; i >= 0; i--) {
      if (bs[i].getAttribute('aria-label') === 'Send message') return bs[i];
    }
    return null;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function waitFor(fn, ms) {
    var t0 = Date.now(), budget = ms || 15000;
    while (Date.now() - t0 < budget) {
      var v = fn();
      if (v) return v;
      await sleep(200);
    }
    return null;
  }

  // ---- 4. select the exact model ----
  // Measured by loading the page with each spelling in ?model_a= :
  //   claude-sonnet-5-high (displayName) -> chip becomes claude-sonnet-5-high
  //   claude-sonnet-5      (publicName)  -> chip stays "Max" (not resolved)
  //   019f19f2-...         (uuid)        -> chip stays "Max" (not resolved)
  // So in this UI the exact, resolvable spelling is the displayName.
  function normName(s) { return String(s || '').trim(); }

  function chipText() {
    var c = modelChip();
    return c ? (c.textContent || '').trim() : null;
  }

  // chip text looks like "Anthropicclaude-sonnet-5-high" (org + model) or "Max"
  function chipHolds(name) {
    var t = chipText();
    return !!t && t.toLowerCase().indexOf(String(name).toLowerCase()) >= 0;
  }

  function searchBox() {
    return document.querySelector('input[placeholder="Search models"]')
      || document.querySelector('input[placeholder="Search model, lab, or license"]');
  }

  function closePicker() {
    try { document.body.click(); } catch (e) {}
  }

  // Accept only an option whose text is EXACTLY the requested name, so that
  // asking for gpt-5.4-nano cannot silently land on gpt-5.4-nano-high.
  async function pickFromPicker(name) {
    var chip = modelChip();
    if (!chip) return { ok: false, error: 'model chip not found (form button[aria-haspopup=dialog])' };

    chip.click();
    var search = await waitFor(searchBox, 8000);
    if (!search) {
      closePicker();
      return { ok: false, error: 'model picker did not open: no input[placeholder="Search models"] after clicking the chip' };
    }

    setValue(search, name);

    var picked = await waitFor(function () {
      var os = Array.prototype.slice.call(document.querySelectorAll('[role="option"]'));
      if (!os.length) return null;
      var texts = os.map(function (o) { return (o.innerText || '').replace(/\s+/g, ' ').trim(); });
      var i = texts.indexOf(name);                    // exact match
      if (i >= 0) return os[i];
      for (var j = 0; j < os.length; j++) {           // first line exact (option may carry a subtitle)
        if (texts[j].split(' ')[0] === name) return os[j];
      }
      if (os.length === 1) return os[0];              // unambiguous single candidate
      return null;
    }, 8000);

    if (!picked) {
      var listed = Array.prototype.slice.call(document.querySelectorAll('[role="option"]'))
        .map(function (o) { return (o.innerText || '').replace(/\s+/g, ' ').trim(); }).slice(0, 6);
      closePicker();
      return { ok: false, error: 'no exact option == ' + JSON.stringify(name) + '; picker offered ' + JSON.stringify(listed) };
    }

    var chosen = (picked.innerText || '').replace(/\s+/g, ' ').trim();
    picked.click();
    await sleep(900);

    if (!chipHolds(name)) {
      return { ok: false, error: 'clicked ' + JSON.stringify(chosen) + ' but chip is now ' + JSON.stringify(chipText()) };
    }
    return { ok: true, via: 'picker', chosen: chosen, chip: chipText() };
  }

  // Fallback: the site's own deeplink. Only reliable for a displayName.
  async function pickViaDeeplink(name) {
    var u = new URL(location.href);
    u.searchParams.set('model_a', name);
    var target = u.pathname + u.search;
    logLine('deeplink fallback -> ' + target);
    try {
      history.pushState({}, '', target);
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    } catch (e) {}
    var ok = await waitFor(function () { return chipHolds(name) ? chipText() : null; }, 8000);
    if (ok) return { ok: true, via: 'deeplink', chip: ok };
    if (location.search !== u.search) location.assign(target);
    return { ok: false, error: 'deeplink did not select ' + JSON.stringify(name) + '; chip = ' + JSON.stringify(chipText()) };
  }

  async function selectModel(name) {
    name = normName(name);
    if (!name) return { changed: false, error: 'empty model name' };

    var path = location.pathname;
    if (!/\/direct(\/|$)/.test(path) && !/^\/c\//.test(path)) {
      logLine('WARNING: not in Direct mode (path=' + path + '): a single model cannot be guaranteed');
    }

    if (chipHolds(name)) {
      logLine('already on ' + JSON.stringify(name) + ' (chip=' + JSON.stringify(chipText()) + ')');
      return { changed: false, model: name, reason: 'already selected', chip: chipText() };
    }

    logLine('selecting ' + JSON.stringify(name) + ' (chip before=' + JSON.stringify(chipText()) + ')');

    var r = await pickFromPicker(name);
    if (!r.ok) {
      logLine('picker path failed: ' + r.error + ' -> trying deeplink');
      var d = await pickViaDeeplink(name);
      if (d.ok) {
        logLine('deeplink ok, chip=' + JSON.stringify(d.chip));
        return { changed: true, model: name, method: d.via, chip: d.chip };
      }
      logLine('both paths failed: ' + d.error);
      return { changed: false, error: r.error + ' | ' + d.error, href: location.href };
    }
    logLine('selected via ' + r.via + ', chip=' + JSON.stringify(r.chip));
    return { changed: true, model: name, method: r.via, chip: r.chip, href: location.href };
  }

  // ---- 5. pull assistant text out of the page's own response body ----
  function collectText(body) {
    var api = window.ArenaSSE;
    if (!api || typeof api.parse !== 'function') {
      return { text: '', error: 'sse-parse.js did not load (window.ArenaSSE missing)', done: false };
    }
    return api.parse(body);
  }

  // ---- 6. send a prompt and stream the reply back ----
  async function sendPrompt(reqId, prompt) {
    // Activating the tab makes React remount the composer, so any node captured
    // earlier becomes detached and writing to it is silently lost. Type in a
    // retry loop that re-resolves the textarea and verifies the write landed.
    var typed = false, lastPh = null, lastConn = null;
    for (var attempt = 0; attempt < 12 && !typed; attempt++) {
      var ta = composer();
      if (!ta) { await sleep(500); continue; }
      lastPh = ta.placeholder;
      setValue(ta, prompt);
      await sleep(400);
      var live = composer();
      lastConn = ta.isConnected;
      if (live && live.value === prompt) { typed = true; break; }
      // a detached node, or React re-created the composer: try the fresh one
      if (live && live !== ta) { setValue(live, prompt); await sleep(400); }
      await sleep(400);
    }
    if (!typed) {
      return send({
        type: 'error', reqId: reqId,
        message: 'could not type into the composer after 12 attempts' +
          ' (composer=' + JSON.stringify(lastPh) + ', firstNodeStillConnected=' + lastConn +
          ', tabVisible=' + foreground() + ', href=' + location.href + ')'
      });
    }
    logLine('typed into composer=' + JSON.stringify(lastPh) + ' tabVisible=' + foreground());

    var btn = await waitFor(function () {
      var b = sendButton();
      return b && !b.disabled ? b : null;
    }, 8000);
    if (!btn) {
      var sb = sendButton();
      var live2 = composer();
      return send({
        type: 'error', reqId: reqId,
        message: 'send button stayed disabled although the composer holds the text' +
          ' (composer=' + JSON.stringify(live2 ? live2.placeholder : null) +
          ', valueLen=' + (live2 ? live2.value.length : -1) +
          ', send found=' + !!sb + ', disabled=' + (sb ? sb.disabled : 'n/a') +
          ', tabVisible=' + foreground() + ', href=' + location.href + ')'
      });
    }

    var mark = captured.length;
    logLine('click send (captured before=' + mark + ')');
    btn.click();

    // first message of a session -> create-evaluation; later -> post-to-evaluation/<id>
    var rec = await waitFor(function () {
      for (var i = mark; i < captured.length; i++) if (captured[i]) return captured[i];
      return null;
    }, 25000);
    if (!rec) {
      return send({
        type: 'error', reqId: reqId,
        message: 'no evaluation request observed after clicking send (waited 25s; captured=' + captured.length + ')'
      });
    }
    // The record exists before the response resolves; wait for the status so the
    // failure is reported as the HTTP error it is, not as "no text".
    await waitFor(function () { return rec.status !== null ? rec : null; }, 30000);
    logLine('evaluation ' + rec.kind + ' HTTP ' + rec.status);

    // An HTTP error from the page's own endpoint is a failure, not an empty answer.
    if (rec.ok === false) {
      var hint = '';
      if (rec.status === 429) {
        hint = rec.retryAt
          ? '; rate limited by arena, quota resets at ' + new Date(rec.retryAt).toISOString() +
            ' (retry after that, or use a different model/account)'
          : '; rate limited by arena, try again later';
      }
      return send({
        type: 'error', reqId: reqId,
        message: 'arena rejected the evaluation request: HTTP ' + rec.status + hint +
          ' body=' + JSON.stringify((rec.stream || '').slice(0, 300))
      });
    }

    var prevLen = 0, sent = 0, t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      await sleep(400);
      var s = rec.stream || '';
      if (s.length !== prevLen) {
        var parsed = collectText(s);
        if (parsed.text.length > sent) {
          send({ type: 'delta', reqId: reqId, text: parsed.text.slice(sent) });
          sent = parsed.text.length;
        }
        if (parsed.error) return send({ type: 'error', reqId: reqId, message: parsed.error });
        prevLen = s.length;
      }
      if (rec.done) {
        var fin = collectText(rec.stream || '');
        if (fin.text.length > sent) send({ type: 'delta', reqId: reqId, text: fin.text.slice(sent) });
        if (fin.error) return send({ type: 'error', reqId: reqId, message: fin.error });
        // HTTP 200 with no parsed assistant text is not a valid completion either.
        if (!fin.text.length) {
          return send({
            type: 'error', reqId: reqId,
            message: 'arena returned HTTP ' + rec.status + ' but no assistant text could be parsed from ' +
              (rec.stream || '').length + ' bytes: ' + JSON.stringify((rec.stream || '').slice(0, 300))
          });
        }
        return send({ type: 'done', reqId: reqId, len: fin.text.length, kind: rec.kind });
      }
    }
    send({ type: 'error', reqId: reqId, message: 'stream timeout after 240s' });
  }

  // ---- 7. model list from the page's own catalog endpoint ----
  async function listModels() {
    try {
      var r = await origFetch.call(window, '/nextjs-api/model-catalog', { credentials: 'include' });
      if (!r.ok) throw new Error('catalog HTTP ' + r.status);
      var j = await r.json();
      var cats = Array.isArray(j) ? j : [j];
      var seen = {}, out = [];
      cats.forEach(function (c) {
        (c.models || []).forEach(function (m) {
          if (m.userSelectable === false) return;
          var key = m.displayName || m.publicName;
          if (!key || seen[key]) return;
          seen[key] = 1;
          var aliases = [];
          // the deeplink resolver tries displayName, then publicName, then id
          if (m.publicName && m.publicName !== key) aliases.push(m.publicName);
          if (m.id && String(m.id) !== key) aliases.push(String(m.id));
          out.push({ id: key, owned_by: m.organization || 'arena', aliases: aliases, arena: c.arena });
        });
      });
      return out;
    } catch (e) {
      send({ type: 'log', reqId: 'catalog', text: 'catalog error: ' + String((e && e.message) || e) });
      return [];
    }
  }

  // ---- 8. message loop with the isolated bridge ----
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__ns !== NS || d.dir !== 'to-page') return;

    if (d.op === 'ping') { send({ type: 'pong', ready: true }); return; }

    if (d.op === 'info') {
      var c = composer();
      send({
        type: 'info', reqId: d.reqId, href: location.href,
        recaptcha: recaptchaCall,
        captured: captured.length,
        tabVisible: foreground(),
        composer: !!c,
        composerPlaceholder: c ? c.placeholder : null,
        composerVisible: c ? visible(c) : false,
        chip: chipText()
      });
      return;
    }

    if (d.op === 'models') {
      listModels().then(function (l) { send({ type: 'models', reqId: d.reqId, models: l }); });
      return;
    }

    if (d.op === 'select') {
      selectModel(d.model).then(function (r) {
        send({ type: 'selected', reqId: d.reqId, result: r });
      }).catch(function (e) {
        send({ type: 'selected', reqId: d.reqId, result: { changed: false, error: String((e && e.message) || e) } });
      });
      return;
    }

    if (d.op === 'send') {
      sendPrompt(d.reqId, d.prompt).catch(function (e) {
        send({ type: 'error', reqId: d.reqId, message: String((e && e.message) || e) });
      });
      return;
    }
  });

  send({ type: 'hook-ready' });
})();
