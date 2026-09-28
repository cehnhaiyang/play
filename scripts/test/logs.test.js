'use strict';
/**
 * 运行日志服务的回归测试。
 *
 * 两半：
 *
 *   1. **真逻辑** —— formatLogArgs 是纯函数，编译进 build 后直接 require
 *      跑断言：占位符、%c 吞样式、循环引用、Error 展开。参数格式化写错的
 *      症状是"日志页里一堆 [object Object]"，只能这样盯。
 *
 *   2. **源码契约** —— 安装幂等、重入保护、环形上限、落盘策略、index.tsx
 *      首 import、悬浮球面板接线，这些是文本断言（与 browser.test.js 同风格）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

let pass = 0;
const fails = [];
const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { fails.push({ name, message: e.message }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};

const run = () => {
    const svc = require('./build/services/LogService');
    const src = fs.readFileSync(path.join(ROOT, 'services', 'LogService.ts'), 'utf8');

    /* ====================================================================== */
    /* 1. formatLogArgs 真逻辑                                                  */
    /* ====================================================================== */

    check('format：%s/%d 按位消费，多余参数空格拼接', () => {
        eq(svc.formatLogArgs(['a=%s b=%d', 'x', 7]), 'a=x b=7');
        eq(svc.formatLogArgs(['hello', 'world', 42]), 'hello world 42');
        eq(svc.formatLogArgs([]), '');
    });

    check('format：%c 吞掉样式参数（Tamper 的写法）', () => {
        eq(svc.formatLogArgs(['%c[Tamper] hi', 'color: #fff']), '[Tamper] hi');
    });

    check('format：%% 转义，缺参数时保留占位符', () => {
        eq(svc.formatLogArgs(['100%%']), '100%');
        eq(svc.formatLogArgs(['a=%s b=%s', 'x']), 'a=x b=%s');
    });

    check('format：循环对象不炸，记 [Circular]', () => {
        const o = { a: 1 };
        o.self = o;
        const out = svc.formatLogArgs([o]);
        assert(out.includes('[Circular]'), `没看到 [Circular]：${out}`);
    });

    check('format：Error 展开 message 与 stack', () => {
        const out = svc.formatLogArgs([new Error('boom')]);
        assert(out.includes('Error: boom'), `Error 头丢了：${out.slice(0, 80)}`);
    });

    check('format：%o 展开对象，null/undefined 原样', () => {
        eq(svc.formatLogArgs(['%o', { a: 1 }]), '{"a":1}');
        eq(svc.formatLogArgs([null, undefined]), 'null undefined');
    });

    check('常量：内存 1000 / 落盘 200 / 键名 app-logs', () => {
        eq(svc.LOG_BUFFER_CAP, 1000);
        eq(svc.LOG_PERSIST_CAP, 200);
        eq(svc.LOG_STORE_KEY, 'app-logs');
    });

    /* ====================================================================== */
    /* 2. 安装与缓冲契约                                                        */
    /* ====================================================================== */

    check('契约：安装幂等，二次调用直接返回', () => {
        assert(src.includes('let installed = false'), '找不到 installed 标志');
        assert(/if \(installed\) return;/.test(src), 'installLogCapture 开头没有幂等返回 —— 会叠多层拦截');
    });

    check('契约：重入保护，格式化崩了也不炸栈', () => {
        assert(src.includes('let writing = false'), '找不到 writing 标志');
        assert(/if \(writing\)/.test(src), 'wrapper 里没有检查 writing —— 怪异对象能把调用栈撑爆');
        assert(/finally \{\s*\n?\s*writing = false;/.test(src), '没有 finally 复位 writing —— 一次异常后日志永久直通');
    });

    check('契约：五个级别全包裹', () => {
        assert(
            src.includes("const LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug']"),
            'LEVELS 缺级别 —— 那个级别的 console 永远进不了日志页'
        );
    });

    check('契约：未捕获异常与未处理 rejection 也记一笔', () => {
        assert(src.includes("addEventListener('error'"), '没有接 window error');
        assert(src.includes("addEventListener('unhandledrejection'"), '没有接 unhandledrejection');
    });

    check('契约：环形缓冲 + 落盘最近一部分 + 防抖写', () => {
        assert(/buffer\.splice\(0, buffer\.length - LOG_BUFFER_CAP\)/.test(src), '超限没有从头部裁 —— 内存会一直涨');
        assert(/buffer\.slice\(-LOG_PERSIST_CAP\)/.test(src), '落盘没有只取最近一部分');
        assert(/setTimeout\(\(\) =>/.test(src) && src.includes('LOG_PERSIST_DEBOUNCE_MS'),
            '落盘没有防抖 —— 高频日志会每条写一次 localStorage');
    });

    check('契约：恢复落盘时坏数据整批丢弃', () => {
        assert(src.includes('isValidEntry'), '没有条目校验 —— 手改 localStorage 能把面板带崩');
        assert(/if \(!Array\.isArray\(saved\)\) return;/.test(src), '落盘不是数组时没有直接丢弃');
    });

    check('契约：Node 里 require 无副作用（不污染测试输出）', () => {
        assert(
            src.includes("if (typeof window !== 'undefined') installLogCapture();"),
            'import 即安装没有守 window —— Node 里 require 会包掉测试进程的 console'
        );
    });

    /* ====================================================================== */
    /* 3. 接线契约：index.tsx 与悬浮球                                          */
    /* ====================================================================== */

    check('契约：LogService 是 index.tsx 的首个 import 并显式安装', () => {
        const indexSrc = fs.readFileSync(path.join(ROOT, 'index.tsx'), 'utf8');
        const logAt = indexSrc.indexOf("from './services/LogService'");
        assert(logAt > 0, 'index.tsx 没有引入 LogService');
        const reactAt = indexSrc.indexOf("from 'react'");
        assert(logAt < reactAt, 'LogService 不是首个 import —— import 阶段的顶层日志会漏');
        assert(indexSrc.includes('installLogCapture();'), 'index.tsx 没有显式调用 installLogCapture');
    });

    check('契约：悬浮球有运行日志面板（元信息 + 顺序 + 常驻）', () => {
        const floatingSrc = fs.readFileSync(path.join(ROOT, 'components', 'Floating.tsx'), 'utf8');
        assert(/type FloatingPanelType = 'sniff' \| 'settings' \| 'logs';/.test(floatingSrc),
            'FloatingPanelType 没有加 logs');
        assert(/logs: \{\s*\n?\s*label: '运行日志'/.test(floatingSrc), 'PANEL_META 里没有运行日志');
        assert(/'sniff', 'settings', 'logs'/.test(floatingSrc), 'PANEL_ORDER 里没有 logs');
        assert(/logs: logsNode,/.test(floatingSrc), 'panels 表里没有挂 logsNode');
        assert(floatingSrc.includes('Object.keys(PANEL_META)'), '面板落盘校验丢了 —— 存量值会打开空白页');
    });

    check('契约：日志面板有级别过滤 + 搜索 + 清空', () => {
        const floatingSrc = fs.readFileSync(path.join(ROOT, 'components', 'Floating.tsx'), 'utf8');
        assert(/const LogsFloating/.test(floatingSrc), '找不到 LogsFloating 组件');
        assert(/setLevelFilter\(f\)/.test(floatingSrc), '没有级别过滤 chips');
        assert(/搜索日志内容/.test(floatingSrc), '没有搜索框');
        assert(/onClick=\{\(\) => clearLogs\(\)\}/.test(floatingSrc), '清空按钮没有接 clearLogs');
        assert(/role="log"/.test(floatingSrc), '日志列表没有 role="log"');
    });

    check('契约：隐藏时不订阅（keep-alive 常驻，不能每次 console 都重渲染）', () => {
        const floatingSrc = fs.readFileSync(path.join(ROOT, 'components', 'Floating.tsx'), 'utf8');
        assert(/useSyncExternalStore\(subscribe, getLogVersion\)/.test(floatingSrc),
            '没有用 useSyncExternalStore 订阅 —— 每次渲染都重读全量');
        assert(/if \(!activeRef\.current\) return \(\) => \{\};/.test(floatingSrc),
            '订阅没有拿 activeRef 门控 —— 隐藏面板也会被每条日志重渲染');
        assert(/<LogsFloating active=\{logsActive\}/.test(floatingSrc), 'logsNode 没有传 active');
    });

    /* ====================================================================== */

    if (fails.length > 0) {
        console.log(`运行日志：通过 ${pass} 项，失败 ${fails.length} 项`);
        for (const f of fails) console.log(`  FAIL  ${f.name}\n          ${f.message}`);
        return false;
    }
    console.log(`运行日志：通过 ${pass} 项，失败 0 项`);
    return true;
};

module.exports = { run };
