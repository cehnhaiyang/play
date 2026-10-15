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
  // 按地址而不是按 id 取「默认配置所属的服务商」：服务商 id 会被改名
  // （tc2api 早先就叫 agent2api），地址与模型表才是这份契约里不变的东西。
  const TC = DEFAULT_AI_CONFIG.baseUrl;
  const GCLI = byId('ofm').baseUrl;
  const A2A = byId('agent2api').baseUrl;

  /* ------------------------------ 服务商表 ------------------------------ */

  check('服务商表: agent2api 的地址与密钥符合约定', () => {
    const p = byId('agent2api');
    assert(p, 'AI_PROVIDERS 里应有 agent2api');
    assert.strictEqual(p.baseUrl, 'http://127.0.0.1:3065/v1', '地址应是本地 3065 的 /v1');
    assert(p.apiKey.startsWith('sk-a2a-'), `密钥应是 agent2api 的默认密钥，实际前缀 "${p.apiKey.slice(0, 6)}"`);
    // models[0] 是什么不再这里钉死：它是"套用预设时的默认值"，由下面那条同源检查
    // 与 DEFAULT_AI_CONFIG 对齐，模型表换名字那次就是这么漏过去的。
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

  /**
   * efforts 这条分支：预设备选表里**当前没有任何模型声明 efforts**（都是 reasoning:false
   * 或"需要思考、原值下发"），所以走真实表数据永远测不到它。
   *
   * 但不能就这么跳过：这条分支一旦坏掉，表现为"该改写的档位被原样发下去"，
   * 界面还照样显示改写后的值，属于静默错。这里用一条临时注册的服务商来钉它 ——
   * findAiProvider 是查 AI_PROVIDERS 的，所以注册后必须还原，否则污染后续用例。
   */
  check('映射: 模型自己声明的 efforts 改写档位（预设备选表里暂无此例，临时注册）', () => {
    const base = 'http://127.0.0.1:29999/v1';
    AI_PROVIDERS.push({
      id: '__efforts_probe__',
      label: 'probe',
      note: 'test only',
      baseUrl: base,
      apiKey: 'x',
      models: [{ id: 'probe-model', efforts: { low: 'low-probe', high: 'high-probe', max: 'max-probe' } }],
    });
    try {
      const wireEff = (tier) => resolveReasoningEffort({ baseUrl: base, apiKey: 'x', model: 'probe-model', ...(tier ? { reasoningEffort: tier } : {}) });
      assert.strictEqual(wireEff('low'), 'low-probe', 'low 应被改写成模型认的写法');
      assert.strictEqual(wireEff('high'), 'high-probe', 'high 应被改写成模型认的写法');
      assert.strictEqual(wireEff('max'), 'max-probe', 'max 应被改写成模型认的写法');
      assert.strictEqual(wireEff('mid'), 'mid', '映射表没覆盖的档位按原值下发');
      assert.strictEqual(wireEff(undefined), undefined, '没有档位就是不下发');
    } finally {
      const i = AI_PROVIDERS.findIndex((p) => p.id === '__efforts_probe__');
      assert(i >= 0, '探针服务商应还在表里，否则上面的断言测的是空气');
      AI_PROVIDERS.splice(i, 1);
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

  /**
   * 默认模型必须能在预设表里查到 —— 否则 resolveReasoningEffort 会落到
   * "预设表外的模型"那条回落分支，档位映射静默失效（不再报错，只是不下发）。
   *
   * 原先这里把三个候选 id 逐个抄进断言，模型表一改就必然过期 ——
   * 而它要钉的从来不是"表里有哪几个名字"，是"默认配置与候选表同源"。
   */
  check('映射: 默认配置里的模型名与地址必须在预设表里查得到', () => {
    const ids = getModelPresets(TC).map((m) => m.id);
    assert(ids.length > 0, `默认服务商（${TC}）应有模型候选`);
    assert(ids[0] !== undefined, '候选表为空');
    assert.strictEqual(ids[0], DEFAULT_AI_CONFIG.model,
      `首个候选应与默认配置的模型一致，实际 ${ids[0]} vs ${DEFAULT_AI_CONFIG.model}`);
    assert(findAiModelPreset(TC, DEFAULT_AI_CONFIG.model),
      `默认模型 ${DEFAULT_AI_CONFIG.model} 必须在预设表里，否则档位映射会静默失效`);
    assert.strictEqual(TC, A2A, '默认配置应指向预设表里的服务商，否则这条同源检查名存实亡');
  });

  console.log(`AI 服务商与档位映射：通过 ${passed} 项，失败 ${failed} 项`);
  for (const f of failures) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
  return failed === 0;
};

module.exports = { run };
