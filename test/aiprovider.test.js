'use strict';
/**
 * 服务商预设与思考档位映射的回归测试。
 *
 * 钉两件事：
 *   1. 档位由**模型**持有，服务商不持有（同一个服务商下可以既有认 reasoning_effort
 *      的模型，也有不认的模型）；
 *   2. 每个 (地址, 模型, 档位) 组合实际下发什么，取值必须是确定的——
 *      这里错一次，就是线上给某个模型塞了一个它会拒绝（或会被带偏）的参数。
 *
 * 必须 require 编译产物里的同一份源码（build/shared/ai/AiService.js），
 * 而不是拿源码正则去猜，理由同 aibook.test.js。
 */
const assert = require('assert');
const path = require('path');

const BUILD = path.join(__dirname, 'build');

let passed = 0;
let failed = 0;
const failures = [];

const check = (name, fn) => {
    try {
        fn();
        passed++;
    } catch (e) {
        failed++;
        failures.push({ name, message: e && e.message ? e.message : String(e) });
    }
};

const run = () => {
  const aiService = require(path.join(BUILD, 'shared', 'ai', 'AiService.js'));
  const { AI_PROVIDERS, DEFAULT_AI_CONFIG, resolveReasoningEffort, findAiModelPreset, findAiProvider, getModelPresets } = aiService;

  const byId = (id) => AI_PROVIDERS.find((p) => p.id === id);

  /* ------------------------------ 服务商表 ------------------------------ */

  check('服务商表: agent2api 的地址与密钥符合约定', () => {
    const p = byId('agent2api');
    assert(p, 'AI_PROVIDERS 里应有 agent2api');
    assert.strictEqual(p.baseUrl, 'http://127.0.0.1:3065/v1', '地址应是本地 3065 的 /v1');
    assert(p.apiKey.startsWith('sk-a2a-'), `密钥应是 agent2api 的默认密钥，实际前缀 "${p.apiKey.slice(0, 6)}"`);
  });

  check('服务商表: 思考配置不再挂在服务商上（服务商不持有任何档位字段）', () => {
    for (const p of AI_PROVIDERS) {
      for (const field of ['reasoning', 'efforts', 'modelEfforts']) {
        assert(!(field in p), `${p.id} 上仍有服务商级 ${field}：档位应由模型条目持有`);
      }
    }
  });

  check('服务商表: 每个服务商的模型 id 非空且互不重复', () => {
    for (const p of AI_PROVIDERS) {
      assert(p.models.length > 0, `${p.id} 没有模型候选`);
      const ids = p.models.map((m) => m.id);
      for (const id of ids) assert(id && id === id.trim(), `${p.id} 有空白模型 id`);
      assert.strictEqual(new Set(ids).size, ids.length, `${p.id} 模型 id 重复：${ids.join(', ')}`);
    }
  });

  /* ------------------------------ 档位映射 ------------------------------ */

  const wire = (baseUrl, model, tier) =>
    resolveReasoningEffort({ baseUrl, apiKey: 'x', model, ...(tier ? { reasoningEffort: tier } : {}) });

  /*
   * 全表逐模型核对，而不是挑几个名字写死。
   *
   * 挑名字的代价已经实测：agent2api 的候选从 LongCat-2.0 换成 Qwen3.8-Flash 之后，
   * 这个套件一次红了 5 条，而产品没有任何问题 —— 测试在替一张会变的表背书。
   * 要钉的不变式是「模型声明了什么性质，就下发什么」，与表里有哪几个名字无关。
   */
  check('映射: 全表逐模型核对——声明不需要思考的一律不下发，其余按映射取值下发', () => {
    for (const provider of AI_PROVIDERS) {
      for (const model of provider.models) {
        for (const tier of ['low', 'high', 'max']) {
          const got = wire(provider.baseUrl, model.id, tier);
          if (model.reasoning === false) {
            assert.strictEqual(got, undefined,
              `${provider.id} / ${model.id} 声明不需要思考，${tier} 不该下发参数`);
          } else {
            const mapped = model.efforts ? model.efforts[tier] : undefined;
            assert.strictEqual(got, mapped || tier,
              `${provider.id} / ${model.id} 的 ${tier} 应下发 ${mapped || tier}，实际 ${got}`);
          }
        }
      }
    }
  });

  check('映射: 显式指定的高档位也压不过模型自己的「不思考」', () => {
    for (const provider of AI_PROVIDERS) {
      for (const model of provider.models.filter((entry) => entry.reasoning === false)) {
        const config = { baseUrl: provider.baseUrl, apiKey: 'x', model: model.id, reasoningEffort: 'low' };
        assert.strictEqual(resolveReasoningEffort(config, 'max'), undefined,
          `${model.id} 声明不需要思考，调用方传 max 也不该下发`);
      }
    }
  });

  check('映射: 没有档位就是不下发，与地址、模型无关', () => {
    assert.strictEqual(wire(DEFAULT_AI_CONFIG.baseUrl, DEFAULT_AI_CONFIG.model, undefined), undefined);
    assert.strictEqual(wire('https://api.example.com/v1', 'any-model', undefined), undefined);
  });

  check('映射: 自定义地址没有任何模型依据，按原值下发', () => {
    assert.strictEqual(wire('https://api.example.com/v1', 'any-model', 'high'), 'high');
  });

  check('映射: 预设服务商下的表外模型名按原值下发（并在界面显示实际取值）', () => {
    assert.strictEqual(wire(DEFAULT_AI_CONFIG.baseUrl, 'some-unlisted-model', 'low'), 'low');
    assert.strictEqual(findAiModelPreset(DEFAULT_AI_CONFIG.baseUrl, 'some-unlisted-model'), null);
  });

  check('映射: 地址比对忽略大小写与末尾斜杠', () => {
    const base = DEFAULT_AI_CONFIG.baseUrl;
    const withSlash = `${base.toUpperCase()}/`;
    assert(findAiProvider(withSlash), '归一化后应命中同一个服务商');
    assert.strictEqual(wire(withSlash, DEFAULT_AI_CONFIG.model, 'max'),
      wire(base, DEFAULT_AI_CONFIG.model, 'max'),
      '斜杠与大小写变体必须给出与规范写法相同的结论');
  });

  /* ------------------------------ 模型候选 ------------------------------ */

  check('候选: 已登记地址返回该服务商的模型，未登记地址兜底第一个服务商', () => {
    const base = DEFAULT_AI_CONFIG.baseUrl;
    const provider = findAiProvider(base);
    assert(provider, `默认地址 ${base} 应对应一个预设服务商`);
    assert.deepStrictEqual(
      getModelPresets(base).map((m) => m.id),
      provider.models.map((m) => m.id),
      '已登记地址应原样返回该服务商的候选（界面按钮就是它）',
    );
    assert(provider.models.length > 0, `${provider.id} 没有模型候选`);
    assert.strictEqual(getModelPresets('https://api.example.com/v1')[0].id, AI_PROVIDERS[0].models[0].id,
      '未知地址应兜底给第一个服务商的候选');
  });

  /**
   * 默认模型必须能在预设表里查到 —— 否则 resolveReasoningEffort 会落到
   * "预设表外的模型"那条回落分支，档位映射静默失效（不再报错，只是不下发）。
   *
   * 地址取 DEFAULT_AI_CONFIG.baseUrl 本身：这条要钉的是"默认配置与候选表同源"，
   * 而不是"表里有哪几个名字"。抄死服务商 id 或候选 id 都会随表变动必然过期。
   */
  check('候选: 默认配置的地址能在预设表里查到，且默认模型是其首个候选', () => {
    const base = DEFAULT_AI_CONFIG.baseUrl;
    assert(findAiProvider(base), `默认配置的地址 ${base} 必须对应一个预设服务商`);
    const ids = getModelPresets(base).map((m) => m.id);
    assert(ids.length > 0, '默认服务商应有模型候选');
    assert.strictEqual(ids[0], DEFAULT_AI_CONFIG.model,
      `首个候选应与默认配置的模型一致，实际 ${ids[0]} vs ${DEFAULT_AI_CONFIG.model}`);
    assert(findAiModelPreset(base, DEFAULT_AI_CONFIG.model),
      `默认模型 ${DEFAULT_AI_CONFIG.model} 必须在预设表里，否则档位映射会静默失效`);
  });

  console.log(`AI 服务商与档位映射：通过 ${passed} 项，失败 ${failed} 项`);
  for (const f of failures) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
  return failed === 0;
};

/**
 * 下发形态（需要 await chat，所以与 run 分开）。
 *
 * 打在这里而不是别处：它是 **AiService 拼请求体**这件事的契约，与档位映射同源。
 *
 * ## 为什么这条断言必须存在
 *
 * 内部类型 `AiToolCall` 是扁平的（id / name / arguments），而协议要求
 * `{id, type:'function', function:{name, arguments}}`。少包这一层**不报错**：
 * 实测本地 agent2api 回 `HTTP 200` 加一个零字节的流，引擎读成"没正文也没调用"，
 * 于是每一步都判成模型无输出而收尾 —— 用户看到的是"Agent 干了一步就停"。
 *
 * 只有回放历史时才带 tool_calls，所以第一轮永远正常、从第二步开始坏。
 * 这类"只在第二步出现、且不报错"的失效，靠跑真实服务才发现得了，
 * 所以把请求体本身钉住。
 */
const runAsync = async () => {
  const aiService = require(path.join(BUILD, 'shared', 'ai', 'AiService.js'));
  const { chat, DEFAULT_AI_CONFIG } = aiService;

  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(String(init && init.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({
        choices: [{ message: { content: '好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    };
  };

  const flatCall = { id: 'call_1', name: 'js', arguments: '{"code":"return 1;"}' };
  const history = [
    { role: 'user', content: '取数' },
    { role: 'assistant', content: '', tool_calls: [flatCall] },
    { role: 'tool', tool_call_id: 'call_1', content: '[工具 js 的执行结果]\n1' },
  ];
  const spec = { name: 'js', description: '跑脚本', parameters: { type: 'object', properties: {} } };

  let body = null;
  let withTools = null;
  try {
    await chat({ config: DEFAULT_AI_CONFIG, messages: history });
    body = captured;
    await chat({ config: DEFAULT_AI_CONFIG, messages: [{ role: 'user', content: 'hi' }], tools: [spec] });
    withTools = captured;
  } finally {
    globalThis.fetch = realFetch;
  }

  // run() 已经把它的成绩报过了；这里只统计本段新增的那几条
  const basePassed = passed;
  const baseFailed = failed;

  check('下发形态: 回放历史时 tool_calls 包成 {type,function}', () => {
    const assistant = body.messages.find((m) => m.role === 'assistant');
    assert(assistant && Array.isArray(assistant.tool_calls), 'assistant 消息必须带 tool_calls');
    const wire = assistant.tool_calls[0];
    assert.strictEqual(wire.type, 'function', 'tool_calls 每项必须有 type:"function"');
    assert(wire.function, 'tool_calls 每项必须有 function 对象（扁平字段会被上游静默吞掉）');
    assert.strictEqual(wire.function.name, flatCall.name, 'function.name 必须原样带上工具名');
    assert.strictEqual(wire.function.arguments, flatCall.arguments, 'function.arguments 必须原样带上参数串');
    assert(!('name' in wire) && !('arguments' in wire), '不允许把扁平字段同时留在外层');
  });

  check('下发形态: tool 消息的 tool_call_id 与调用 id 逐字配对', () => {
    const assistant = body.messages.find((m) => m.role === 'assistant');
    const tool = body.messages.find((m) => m.role === 'tool');
    assert(tool, 'tool 消息必须在');
    assert.strictEqual(tool.tool_call_id, assistant.tool_calls[0].id, 'tool_call_id 必须指回调用的 id');
  });

  check('下发形态: 工具规格与调用项是同一条包装规则', () => {
    assert(Array.isArray(withTools.tools) && withTools.tools.length === 1, 'tools 必须下发');
    assert.strictEqual(withTools.tools[0].type, 'function', 'tools 每项必须有 type:"function"');
    assert.strictEqual(withTools.tools[0].function.name, spec.name, 'tools 的 function.name 必须是工具名');
  });

  const added = failed - baseFailed;
  console.log(`AI 下发形态：通过 ${passed - basePassed} 项，失败 ${added} 项`);
  for (const f of failures.slice(failures.length - added)) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
  return added === 0;
};

module.exports = { run, runAsync };
