// arena.ai — 以 claude-sonnet-5 发起一次真实对话并抓包
// 用法: 打开 https://arena.ai/text/direct?model_a=claude-sonnet-5-high
//       在页面主世界执行本文件内容, 再 await __probe('你的问题')

window.__log = [];

(function hookNetwork(){
  var of = window.fetch;
  window.fetch = function(){
    var a = arguments;
    var r = a[0];
    var rec = {
      t: 'fetch',
      url: (typeof r === 'string') ? r : (r && r.url) || String(r),
      method: (a[1] && a[1].method) || (r && r.method) || 'GET'
    };
    if (a[1] && typeof a[1].body === 'string') rec.body = a[1].body.slice(0, 4000);
    window.__log.push(rec);
    var p = of.apply(this, a);
    if (p && p.then) p.then(function(resp){
      try { rec.status = resp.status; rec.ct = resp.headers.get('content-type'); } catch(e){}
    });
    return p;
  };
})();

function setValue(el, v){
  var d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
  d.set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

window.__probe = async function(prompt, waitMs){
  waitMs = waitMs || 20000;
  var ta = [].slice.call(document.querySelectorAll('textarea'))
             .filter(function(t){ return (t.placeholder||'').indexOf('Ask') !== -1; })[0]
           || document.querySelector('textarea');
  setValue(ta, prompt);
  await new Promise(function(r){ setTimeout(r, 500); });

  var send = [].slice.call(document.querySelectorAll('button'))
               .filter(function(b){ return b.getAttribute('aria-label') === 'Send message'; })[0];
  if (!send || send.disabled) return { err: 'send button unavailable' };

  window.__log = [];
  send.click();
  await new Promise(function(r){ setTimeout(r, waitMs); });

  return {
    href: location.href,
    requests: window.__log.map(function(x){
      return { url: x.url, method: x.method, status: x.status || null,
               ct: x.ct || null, body: x.body ? x.body.slice(0, 600) : null };
    }),
    reply: document.body.innerText.slice(-800)
  };
};

// 关键端点回顾:
//   1) POST /nextjs-api/stream/create-evaluation          -> { evaluationId }
//   2) POST /nextjs-api/stream/post-to-evaluation/{id}    -> SSE 流
// 请求体: { id, modelAId, userMessageId, modelAMessageId,
//           userMessage:{content,experimental_attachments,metadata},
//           modality:'chat', recaptchaV3Token }
// claude-sonnet-5 的 modelAId = 019f19f2-41f1-7c6d-9891-48d02fd9952c
