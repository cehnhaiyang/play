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
 * 必须 require 编译产物里的同一份源码（build/services/AiService.js），
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
  const aiService = require(path.join(BUILD, 'services', 'AiService.js'));
  const { AI_PROVIDERS, resolveReasoningEffort, findAiModelPreset, findAiProvider, getModelPresets } = aiService;

  const byId = (id) => AI_PROVIDERS.find((p) => p.id === id);
  const TC = byId('tc2api').baseUrl;
  const GCLI = byId('ofm').baseUrl;
  const A2A = byId('agent2api').baseUrl;

  /* ------------------------------ 服务商表 ------------------------------ */

  check('服务商表: agent2api 的地址、密钥与模型符合约定', () => {
    const p = byId('agent2api');
    assert(p, 'AI_PROVIDERS 里应有 agent2api');
    assert.strictEqual(p.baseUrl, 'http://127.0.0.1:3065/v1', '地址应是本地 3065 的 /v1');
    assert(p.apiKey.startsWith('sk-a2a-'), `密钥应是 agent2api 的默认密钥，实际前缀 "${p.apiKey.slice(0, 6)}"`);
    assert.strictEqual(p.models[0].id, 'LongCat-2.0', '默认模型应是 LongCat-2.0');
  });

  check('服务商表: LongCat-2.0 声明没有思考配置', () => {
    const m = findAiModelPreset(A2A, 'LongCat-2.0');
    assert(m, 'LongCat-2.0 应在 agent2api 的模型候选里');
    assert.strictEqual(m.reasoning, false, 'reasoning 必须是 false，否则档位会被原样下发');
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

  check('映射: 不思考的模型三档全部不下发', () => {
    for (const [base, model] of [
      [A2A, 'LongCat-2.0'],
      [GCLI, 'gemini-3.8-flash-high'],
      [GCLI, 'claude-sonnet-4-6'],
    ]) {
      for (const tier of ['low', 'high', 'max']) {
        assert.strictEqual(wire(base, model, tier), undefined, `${model} + ${tier} 不该下发参数`);
      }
    }
  });

  check('映射: 单次调用显式指定的高档位也压不过模型自己的「不思考」', () => {
    const config = { baseUrl: A2A, apiKey: 'x', model: 'LongCat-2.0', reasoningEffort: 'low' };
    assert.strictEqual(resolveReasoningEffort(config, 'max'), undefined,
      '调用方传 max 时仍下发了参数——LongCat-2.0 会被这个值带偏');
  });

  check('映射: 认思考的模型保持原档位（现有行为不变）', () => {
    for (const tier of ['low', 'high', 'max']) {
      assert.strictEqual(wire(TC, 'global:deepseek-v4.1-flash', tier), tier, `tc2api ${tier} 应原值下发`);
      assert.strictEqual(wire(TC, 'global:glm-5.2', tier), tier, `tc2api glm ${tier} 应原值下发`);
    }
  });

  check('映射: 没有档位就是不下发，与地址、模型无关', () => {
    assert.strictEqual(wire(TC, 'global:deepseek-v4.1-flash', undefined), undefined);
    assert.strictEqual(wire(A2A, 'LongCat-2.0', undefined), undefined);
  });

  check('映射: 自定义地址没有任何模型依据，按原值下发', () => {
    assert.strictEqual(wire('https://api.example.com/v1', 'any-model', 'high'), 'high');
  });

  check('映射: 预设服务商下的表外模型名按原值下发（并在界面显示实际取值）', () => {
    assert.strictEqual(wire(A2A, 'some-unlisted-model', 'low'), 'low');
    assert.strictEqual(findAiModelPreset(A2A, 'some-unlisted-model'), null);
  });

  check('映射: 地址比对忽略大小写与末尾斜杠', () => {
    const withSlash = 'HTTP://127.0.0.1:3065/V1/';
    assert(findAiProvider(withSlash), '归一化后应命中 agent2api');
    assert.strictEqual(wire(withSlash, 'LongCat-2.0', 'max'), undefined, '斜杠变体下仍不该下发');
  });

  /* ------------------------------ 模型候选 ------------------------------ */

  check('候选: 已登记地址返回该服务商的模型，未登记地址兜底第一个服务商', () => {
    const a2aModels = getModelPresets(A2A).map((m) => m.id);
    assert(a2aModels.includes('LongCat-2.0'), `agent2api 候选应含 LongCat-2.0，实际 ${a2aModels.join(', ')}`);
    assert(getModelPresets('https://api.example.com/v1')[0].id === AI_PROVIDERS[0].models[0].id,
      '未知地址应兜底给第一个服务商的候选');
  });

  check('候选: tc2api 的三个模型候选与默认配置同源', () => {
    const ids = getModelPresets(TC).map((m) => m.id);
    assert.deepStrictEqual(ids, ['global:deepseek-v4.1-flash', 'deepseek-v4.1-flash', 'global:glm-5.2']);
  });

  console.log(`AI 服务商与档位映射：通过 ${passed} 项，失败 ${failed} 项`);
  for (const f of failures) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
  return failed === 0;
};

module.exports = { run };
