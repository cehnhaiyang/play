'use strict';
/*
 * 探针 2：流式 + tools 能否共存，以及 tool_calls 在流里的分片形状。
 * 引擎依赖 onDelta 做实时滚字，若流式不返 tool_calls，方案要换形状。
 */
const BASE = 'http://127.0.0.1:3065/v1';
const KEY = 'sk-a2a-f345da9360a116c54801e02675eb0c37';
const MODEL = 'global:deepseek-v4.1-flash';

const tools = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'read a file from the sandbox',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'number' } },
      required: ['path'],
    },
  },
}, {
  type: 'function',
  function: {
    name: 'list_dir',
    description: 'list a directory',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}];

(async () => {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'List the sandbox root and read notes.md. Do both in one turn.' }],
      tools,
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 256,
    }),
    signal: AbortSignal.timeout(60000),
  });

  console.log(`status=${res.status} ct=${res.headers.get('content-type')}`);
  if (!res.body) { console.log('no body'); return; }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (line.startsWith('data:')) frames.push(line.slice(5).trim());
    }
  }
  console.log(`frames=${frames.length}`);
  frames.forEach((f, i) => {
    if (f === '[DONE]') { console.log(`  [${i}] DONE`); return; }
    let p; try { p = JSON.parse(f); } catch { console.log(`  [${i}] BAD ${f.slice(0, 80)}`); return; }
    const c = p.choices && p.choices[0];
    const d = c && c.delta;
    const tc = d && d.tool_calls;
    const usage = p.usage ? `usage=${JSON.stringify(p.usage).slice(0, 120)}` : '';
    console.log(`  [${i}] fr=${c ? c.finish_reason : '-'} content=${JSON.stringify(d && d.content)} tool_calls=${tc ? JSON.stringify(tc) : 'null'} ${usage}`);
  });
})();
