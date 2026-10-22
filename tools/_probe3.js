'use strict';
/*
 * 探针 3：finish_reason 在流里的行为。
 * 「最终答复 = 无 tool_calls 的 content」这条判据全靠它，截断保护也全靠它，
 * 所以必须实测两种取值：正常收尾 stop、被 max_tokens 截断 length。
 */
const BASE = 'http://127.0.0.1:3065/v1';
const KEY = 'sk-a2a-f345da9360a116c54801e02675eb0c37';
const MODEL = 'global:deepseek-v4.1-flash';

const streamOnce = async (label, payload) => {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ ...payload, model: MODEL, stream: true, stream_options: { include_usage: true } }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.body) { console.log(`${label}: no body status=${res.status}`); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const seen = [];
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { seen.push('DONE'); continue; }
      let p; try { p = JSON.parse(data); } catch { continue; }
      const c = p.choices && p.choices[0];
      if (c && c.finish_reason) seen.push(`finish=${c.finish_reason}`);
      if (c && c.delta && c.delta.content) text += c.delta.content;
    }
  }
  console.log(`${label}: status=${res.status} finish=${JSON.stringify(seen)} textLen=${text.length}`);
  console.log(`  text=${JSON.stringify(text.slice(0, 200))}`);
};

(async () => {
  await streamOnce('plain-answer', {
    messages: [{ role: 'user', content: 'Say hello in one word.' }],
    max_tokens: 64,
  });

  await streamOnce('truncated', {
    messages: [{ role: 'user', content: 'Count from 1 to 500, comma separated, no other words.' }],
    max_tokens: 40,
  });

  const tools = [{
    type: 'function',
    function: {
      name: 'write_file',
      description: 'write text to a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  }];
  await streamOnce('tool-truncated', {
    messages: [{ role: 'user', content: 'Write a 3000 word essay about the sea into out/sea.md using write_file.' }],
    tools,
    tool_choice: 'auto',
    max_tokens: 60,
  });
})();
