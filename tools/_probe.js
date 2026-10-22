'use strict';
/*
 * 一次性探针：确认当前配置的服务商到底认不认 response_format / tools。
 * 这两个事实决定"约束解码"这一档能不能落地 —— 不测就只能猜。
 */
const BASE = 'http://127.0.0.1:3065/v1';
const KEY = 'sk-a2a-f345da9360a116c54801e02675eb0c37';
const MODEL = 'global:deepseek-v4.1-flash';

const post = async (label, payload) => {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    console.log(`${label}: status=${res.status} ms=${Date.now() - started}`);
    console.log(`  body=${text.slice(0, 500)}`);
    return { status: res.status, text };
  } catch (e) {
    console.log(`${label}: THREW ${e && e.message}`);
    return { status: 0, text: '' };
  }
};

const msg = [{ role: 'user', content: 'reply with exactly {"ok":1} and nothing else' }];

(async () => {
  await post('plain', { model: MODEL, messages: msg, max_tokens: 64 });
  await post('json_object', {
    model: MODEL, messages: msg, max_tokens: 64,
    response_format: { type: 'json_object' },
  });
  await post('json_schema', {
    model: MODEL, messages: msg, max_tokens: 64,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'r', strict: true, schema: { type: 'object', properties: { ok: { type: 'number' } }, required: ['ok'], additionalProperties: false } },
    },
  });
  await post('tools', {
    model: MODEL,
    messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
    max_tokens: 128,
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    tool_choice: 'auto',
  });
})();
