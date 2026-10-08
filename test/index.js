'use strict';
/**
 * SPG 引擎测试入口。
 *
 * 先调用 tsc 把引擎（services/AudioService + meta）编译成 CommonJS 到 build/，
 * 再用 Web Audio 模拟层在 Node 里跑真实的解析/调度/合成流程。
 *
 * 为什么不用浏览器跑：这些 bug（时间点倒流、自动化越界、总时长漏算）
 * 在浏览器里只会表现为"听感不对"，很难定位；在 Node 里可以直接断言时间线。
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const here = __dirname;
const tsc = path.join(here, '..', 'node_modules', '.bin', 'tsc.cmd');
const tscFallback = path.join(here, '..', 'node_modules', 'typescript', 'bin', 'tsc');

const runTsc = () => {
  const args = ['-p', path.join(here, 'tsconfig.json')];
  try {
    if (fs.existsSync(tsc)) {
      execFileSync(tsc, args, { stdio: 'inherit', cwd: here });
      return;
    }
  } catch (e) {
    // .cmd 在非 Windows 环境不可执行，回落到 node 直接跑 tsc
  }
  execFileSync(process.execPath, [tscFallback, ...args], { stdio: 'inherit', cwd: here });
};

const main = async () => {
  console.log('编译引擎到 test/build/ ...');
  runTsc();

  console.log('\n=== 引擎回归测试 ===');
  const engineOk = await require('./engine.test.js').run();

  console.log('\n=== 向后兼容测试 ===');
  const compatOk = require('./compat.test.js').run();

  console.log('\n=== AI 绘本测试 ===');
  const aibookOk = require('./aibook.test.js').run();

  console.log('\n=== AI 服务商与档位映射 ===');
  const aiproviderOk = require('./aiprovider.test.js').run();

  console.log('\n=== 搜索引擎测试 ===');
  const searchMod = require('./search.test.js');
  const searchSyncOk = searchMod.run();
  const searchAsyncOk = await searchMod.runAsync();

  console.log('\n=== 主进程静态自检 ===');
  const mainStaticOk = require('./mainstatic.test.js').run();

  console.log('\n=== 篡改工具纯函数 ===');
  const tamperOk = require('./tamper.test.js').run();

  console.log('\n=== Agent 工具派发 ===');
  const agentToolsOk = await require('./agenttools.test.js').run();

  console.log('\n=== 规则草稿同步 ===');
  const draftOk = require('./draft.test.js').run();

  console.log('\n=== 知识库 ===');
  const kbOk = require('./kb.test.js').run();

  console.log('\n=== 浏览器外壳 ===');
  const browserOk = require('./browser.test.js').run();

  console.log('\n=== 嗅探引擎 ===');
  const snifferOk = require('./sniffer.test.js').run();

  console.log('\n=== 运行日志 ===');
  const logsOk = require('./logs.test.js').run();

  console.log('\n=== Edge 导入与书签树 ===');
  const edgeMod = require('./edgeimport.test.js');
  const edgeOk = edgeMod.run();
  const edgeAsyncOk = await edgeMod.runAsync();

  if (!engineOk || !compatOk || !aibookOk || !aiproviderOk || !searchSyncOk || !searchAsyncOk
    || !mainStaticOk || !tamperOk || !agentToolsOk || !draftOk || !kbOk || !browserOk
    || !snifferOk || !logsOk || !edgeOk || !edgeAsyncOk) {
    process.exitCode = 1;
    console.log('\n存在失败用例。');
  } else {
    console.log('\n全部通过。');
  }
};

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
