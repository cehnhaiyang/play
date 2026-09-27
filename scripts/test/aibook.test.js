'use strict';
/**
 * AI 绘本（.aibook / 故事解析）回归测试。
 *
 * 覆盖两类最容易静默出错的地方：
 *   1. 模型返回脏 JSON（围栏、寒暄、pages 混入非字符串）时的解析健壮性
 *   2. .aibook 的写出/读回往返，以及坏文件的容错边界
 *
 * 这两个函数是纯函数，不需要 Web Audio 模拟层，因此单独成文件。
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
  // .aibook 格式与图片编解码在 utils/utils.ts（与 .gallery 格式段并列）。
  // 这里曾经 require 的是 build/utils.js —— 根目录 utils.ts 的编译产物。
  // 那个文件早已移进 utils/ 目录，于是这条 require 只剩一个**陈旧的 build 产物**
  // 在撑着：clean 重建后它就没了，套件直接 MODULE_NOT_FOUND。
  // 更要紧的是，靠陈旧产物运行时，这 30 项断言测的不是产品代码。
  const utils = require(path.join(BUILD, 'utils', 'utils.js'));

  const { parseStoryJson } = aiService;
  const {
    parseAiBookText,
    buildAiBookJson,
    splitDataUrl,
    sanitizeBookName,
    isAiBookFileName,
    AIBOOK_VERSION,
    AIBOOK_MAX_PAGES,
  } = utils;

  /* ---------------------------- 故事 JSON 解析 ---------------------------- */

  check('parseStoryJson: 干净 JSON', () => {
    const r = parseStoryJson('{"title":"月亮","pages":["第一页","第二页"]}');
    assert.deepStrictEqual(r, { title: '月亮', pages: ['第一页', '第二页'] });
  });

  check('parseStoryJson: ```json 围栏', () => {
    const r = parseStoryJson('```json\n{"title":"T","pages":["a"]}\n```');
    assert.deepStrictEqual(r, { title: 'T', pages: ['a'] });
  });

  check('parseStoryJson: 无语言标记围栏', () => {
    const r = parseStoryJson('```\n{"title":"T","pages":["a"]}\n```');
    assert.deepStrictEqual(r, { title: 'T', pages: ['a'] });
  });

  check('parseStoryJson: 前后寒暄包裹', () => {
    const r = parseStoryJson('好的，这是故事：\n{"title":"T","pages":["a","b"]}\n希望你喜欢！');
    assert.deepStrictEqual(r, { title: 'T', pages: ['a', 'b'] });
  });

  check('parseStoryJson: 缺 title 回落默认名', () => {
    const r = parseStoryJson('{"pages":["a"]}');
    assert.strictEqual(r.title, '未命名故事');
  });

  check('parseStoryJson: title 为空白回落默认名', () => {
    const r = parseStoryJson('{"title":"   ","pages":["a"]}');
    assert.strictEqual(r.title, '未命名故事');
  });

  check('parseStoryJson: pages 里混入非字符串被剔除', () => {
    const r = parseStoryJson('{"title":"T","pages":["a",{"x":1},null,"b"]}');
    assert.deepStrictEqual(r.pages, ['a', 'b']);
  });

  check('parseStoryJson: pages 全为空白返回 null', () => {
    assert.strictEqual(parseStoryJson('{"title":"T","pages":["  ",""]}'), null);
  });

  check('parseStoryJson: pages 为空数组返回 null', () => {
    assert.strictEqual(parseStoryJson('{"title":"T","pages":[]}'), null);
  });

  check('parseStoryJson: pages 不是数组返回 null', () => {
    assert.strictEqual(parseStoryJson('{"title":"T","pages":"a"}'), null);
  });

  check('parseStoryJson: 非 JSON 返回 null', () => {
    assert.strictEqual(parseStoryJson('抱歉，我无法完成这个请求。'), null);
  });

  // 贪婪的 /\{[\s\S]*\}/ 会从第一个 '{' 吃到最后一个 '}'。模型在 JSON 之后
  // 补一句带花括号的说明（"第 2 页用了 {强调} 排版"）就会把整段撑坏，
  // 故事被判为"无法解析"而丢弃。改用括号配平后应能正常抠出对象。
  check('parseStoryJson: JSON 之后还有花括号（贪婪匹配会整段失败）', () => {
    const r = parseStoryJson('{"title":"T","pages":["a","b"]}\n\n（注：第 2 页用了 {强调} 排版）');
    assert.ok(r, '不应返回 null —— 贪婪匹配正是在这里丢掉整个故事');
    assert.deepStrictEqual(r, { title: 'T', pages: ['a', 'b'] });
  });

  check('parseStoryJson: 正文里的花括号不影响配平', () => {
    const r = parseStoryJson('{"title":"T","pages":["他说 {你好} 然后走了","b"]}');
    assert.deepStrictEqual(r.pages, ['他说 {你好} 然后走了', 'b']);
  });

  /* ---------------------- 资源提取的 JSON 数组抠取 ---------------------- */

  // extractJsonArray 此前用贪婪的 /\[[\s\S]*\]/：从第一个 '[' 一直吃到最后一个 ']'。
  // 模型回复里只要在 JSON 之后再出现一个方括号（"注意 [main] 文件很大"），
  // 或它给了两个数组，整段就 parse 失败 → 返回 null → **全部提取结果丢失**，
  // 界面只显示"未找到资源"，看不出是解析挂了。改为括号配平扫描。

  const { extractJsonArray } = aiService;

  check('extractJsonArray: 干净数组', () => {
    const r = extractJsonArray('[{"url":"https://a.com/1.mp4"}]');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].url, 'https://a.com/1.mp4');
  });

  check('extractJsonArray: JSON 之后还有方括号（贪婪匹配会整段失败）', () => {
    const r = extractJsonArray('[{"url":"https://a.com/1.mp4"}]\n\n注意 [main] 文件很大。');
    assert.ok(r, '不应返回 null —— 贪婪匹配正是在这里丢掉全部结果');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].url, 'https://a.com/1.mp4');
  });

  check('extractJsonArray: 回复里有两个数组时取第一个', () => {
    const r = extractJsonArray('[{"url":"https://a.com/1.mp4"}]\n以及\n[{"url":"https://b.com/2.mp4"}]');
    assert.ok(r, '不应返回 null');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].url, 'https://a.com/1.mp4');
  });

  check('extractJsonArray: 标题里的方括号不影响配平', () => {
    const r = extractJsonArray('[{"url":"https://a.com/1.mp4","title":"[Sub] Ep1"}]');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].title, '[Sub] Ep1');
  });

  check('extractJsonArray: 字符串内的 ] 不被当作数组结尾', () => {
    const r = extractJsonArray('[{"title":"a]b","url":"https://a.com/1.mp4"}]');
    assert.ok(r, '不应返回 null');
    assert.strictEqual(r[0].title, 'a]b');
  });

  check('extractJsonArray: 前导非 JSON 方括号会被跳过', () => {
    const r = extractJsonArray('[note] 然后 [{"url":"https://a.com/1.mp4"}]');
    assert.ok(r, '应跳过 [note] 找到真正的数组');
    assert.strictEqual(r[0].url, 'https://a.com/1.mp4');
  });

  check('extractJsonArray: 没有数组时返回 null', () => {
    assert.strictEqual(extractJsonArray('抱歉，没有找到任何资源。'), null);
    assert.strictEqual(extractJsonArray(''), null);
  });

  check('extractJsonArray: 空数组返回空数组（而非 null）', () => {
    assert.deepStrictEqual(extractJsonArray('[]'), []);
  });

  check('parseStoryJson: 空串返回 null', () => {
    assert.strictEqual(parseStoryJson(''), null);
    assert.strictEqual(parseStoryJson(null), null);
  });

  check('parseStoryJson: pages 项首尾空白被裁剪', () => {
    const r = parseStoryJson('{"title":"T","pages":["  a  "]}');
    assert.deepStrictEqual(r.pages, ['a']);
  });

  /* ------------------------------ .aibook 往返 ---------------------------- */

  const onePxPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  check('aibook: 写出后读回内容一致', () => {
    const json = buildAiBookJson('我的故事', [
      { image: onePxPng, text: '第一页' },
      { image: onePxPng, text: '第二页', audio: 'AAAA' },
    ]);
    const parsed = parseAiBookText(json);
    assert.strictEqual(parsed.title, '我的故事');
    assert.strictEqual(parsed.pages.length, 2);
    assert.strictEqual(parsed.pages[0].text, '第一页');
    assert.strictEqual(parsed.pages[0].image, onePxPng);
    assert.strictEqual(parsed.pages[1].audio, 'AAAA');
  });

  check('aibook: 空标题回落默认名', () => {
    const json = buildAiBookJson('   ', [{ image: onePxPng, text: 'x' }]);
    assert.strictEqual(parseAiBookText(json).title, '未命名故事');
  });

  check('aibook: 写出带 version 字段', () => {
    const json = buildAiBookJson('T', [{ image: onePxPng, text: 'x' }]);
    assert.strictEqual(JSON.parse(json).version, AIBOOK_VERSION);
  });

  check('aibook: 缺 image 的页被跳过', () => {
    const json = JSON.stringify({
      title: 'T',
      pages: [{ text: '无图' }, { image: onePxPng, text: '有图' }],
    });
    const parsed = parseAiBookText(json);
    assert.strictEqual(parsed.pages.length, 1);
    assert.strictEqual(parsed.pages[0].text, '有图');
  });

  check('aibook: 一页都不剩则抛错', () => {
    const json = JSON.stringify({ title: 'T', pages: [{ text: '无图' }] });
    assert.throws(() => parseAiBookText(json), /没有任何有效页面/);
  });

  check('aibook: 非法 JSON 抛错并说明原因', () => {
    assert.throws(() => parseAiBookText('{ 坏 json'), /不是合法的 \.aibook 文件/);
  });

  check('aibook: 缺 pages 抛错', () => {
    assert.throws(() => parseAiBookText('{"title":"T"}'), /缺少 pages/);
  });

  check('aibook: 缺 text 的页保留为空串（不算坏页）', () => {
    const json = JSON.stringify({ title: 'T', pages: [{ image: onePxPng }] });
    const parsed = parseAiBookText(json);
    assert.strictEqual(parsed.pages.length, 1);
    assert.strictEqual(parsed.pages[0].text, '');
  });

  check('aibook: 缺 title 时用调用方给的兜底名', () => {
    const json = JSON.stringify({ pages: [{ image: onePxPng, text: 'x' }] });
    assert.strictEqual(parseAiBookText(json, '文件名').title, '文件名');
  });

  check('aibook: 超过上限的页被截断', () => {
    const pages = Array.from({ length: AIBOOK_MAX_PAGES + 20 }, () => ({ image: onePxPng, text: 'x' }));
    const parsed = parseAiBookText(JSON.stringify({ title: 'T', pages }));
    assert.strictEqual(parsed.pages.length, AIBOOK_MAX_PAGES);
  });

  /* -------------------------------- 工具函数 ------------------------------ */

  check('splitDataUrl: 正常拆分', () => {
    const r = splitDataUrl('data:image/jpeg;base64,AAAA');
    assert.deepStrictEqual(r, { mimeType: 'image/jpeg', base64: 'AAAA' });
  });

  check('splitDataUrl: 非 data URL 返回 null', () => {
    assert.strictEqual(splitDataUrl('https://a.com/b.png'), null);
    assert.strictEqual(splitDataUrl(''), null);
  });

  check('splitDataUrl: base64 正文含换行也能拆出', () => {
    const r = splitDataUrl('data:image/png;base64,AA\nBB');
    assert.strictEqual(r.base64, 'AA\nBB');
  });

  check('sanitizeBookName: 去非法字符', () => {
    assert.strictEqual(sanitizeBookName('a/b:c*d?e'), 'a_b_c_d_e');
  });

  check('sanitizeBookName: 空名回落', () => {
    assert.strictEqual(sanitizeBookName('   '), '未命名故事');
  });

  check('sanitizeBookName: 限长 80', () => {
    assert.strictEqual(sanitizeBookName('x'.repeat(200)).length, 80);
  });

  check('isAiBookFileName: 大小写不敏感', () => {
    assert.strictEqual(isAiBookFileName('A.AIBOOK'), true);
    assert.strictEqual(isAiBookFileName('a.aibook'), true);
    assert.strictEqual(isAiBookFileName('a.gallery'), false);
    assert.strictEqual(isAiBookFileName('aibook'), false);
  });

  /* --------------------------------- 汇总 -------------------------------- */

  console.log(`AI 绘本：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.message}`);
  }
  return failed === 0;
};

module.exports = { run };
