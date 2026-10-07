'use strict';
/**
 * 主进程 JS 静态自检：找出「被调用，但在该模块里从未声明」的标识符。
 *
 * 为什么需要它：这类错误只在运行到那一行时才炸（ReferenceError），
 * 而主进程大量使用 try/catch 做降级，错误很容易被吞掉。
 *
 * 真实事故：main.js 的 setAcgmhoUserAgent 被调用 3 次却从未定义
 * （重构时漏了从 acgmhoService 导入）。它位于 syncAcgmhoProxy 的 try 块里，
 * 抛错后 catch 执行 setAcgmhoProxy(null)，把**刚刚建好的**代理清成直连，
 * 界面于是显示「端口连不上」——而端口、代理软件、网络全都是好的。
 * 排查方向被彻底带偏。
 *
 * 关键难点是正则字面量：`/socket hang up/` 里的单词会被朴素正则当成标识符。
 * 这里用「前一个有效 token 能否结束表达式」来判断 `/` 是除号还是正则开头。
 *
 * 已知误报：类方法简写（`createConnection(options) {}`）会被当成自由函数调用。
 * 白名单显式列出，新增时需写明理由。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT, 'electron');

/** 类方法简写等已知误报，不属于"未声明的自由标识符" */
const KNOWN_METHOD_SHORTHANDS = new Set([
    'createConnection',   // ProxiedHttpsAgent / ProxiedHttpAgent 的类方法
]);

/** 去掉注释、字符串、模板串与正则字面量，只留代码骨架 */
function stripLiterals(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let lastSignificant = '';

    // 只有这些字符之后出现的 '/' 才是正则开头，否则是除号
    const regexCanFollow = (ch) => ch === '' || '(,=:[!&|?{};+-*%^~<>'.includes(ch);

    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];

        if (c === '/' && c2 === '/') {                    // 行注释
            while (i < n && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && c2 === '*') {                    // 块注释
            i += 2;
            let newlines = '';
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                // 换行必须原样吐出：否则剥掉注释后行号会漂移，报错位置对不上源码
                if (src[i] === '\n') newlines += '\n';
                i++;
            }
            i += 2;
            out += newlines;
            continue;
        }
        if (c === '/' && regexCanFollow(lastSignificant)) {  // 正则字面量
            i++;
            let inClass = false;
            while (i < n) {
                const d = src[i];
                if (d === '\\') { i += 2; continue; }
                if (d === '[') inClass = true;
                else if (d === ']') inClass = false;
                else if (d === '/' && !inClass) { i++; break; }
                else if (d === '\n') break;               // 未闭合，当除号处理
                i++;
            }
            while (i < n && /[a-z]/.test(src[i])) i++;     // flags
            out += ' RE ';
            lastSignificant = 'E';
            continue;
        }
        if (c === '"' || c === "'") {                      // 字符串
            const quote = c;
            i++;
            let newlines = '';
            while (i < n) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === quote) { i++; break; }
                if (src[i] === '\n') newlines += '\n';     // 保留换行以免行号漂移
                i++;
            }
            out += ` STR ${newlines}`;
            lastSignificant = 'S';
            continue;
        }
        if (c === '`') {                                   // 模板串
            i++;
            let depth = 0;
            let newlines = '';
            while (i < n) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
                if (src[i] === '}' && depth > 0) { depth--; i++; continue; }
                if (src[i] === '`' && depth === 0) { i++; break; }
                if (src[i] === '\n') newlines += '\n';
                i++;
            }
            out += ` TPL ${newlines}`;
            lastSignificant = 'L';
            continue;
        }

        out += c;
        if (!/\s/.test(c)) lastSignificant = c;
        i++;
    }
    return out;
}

const GLOBALS = new Set([
    'globalThis', 'global', 'process', 'require', 'module', 'exports', '__dirname', '__filename',
    'console', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
    'queueMicrotask', 'Promise', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Array',
    'Object', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'TypeError', 'RangeError',
    'SyntaxError', 'EvalError', 'URIError', 'ReferenceError', 'Symbol', 'Proxy', 'Reflect', 'BigInt',
    'Function', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController',
    'AbortSignal', 'fetch', 'structuredClone', 'performance', 'Uint8Array', 'Int8Array',
    'Uint8ClampedArray', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
    'Float64Array', 'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'DataView', 'SharedArrayBuffer',
    'Atomics', 'WeakRef', 'FinalizationRegistry', 'encodeURIComponent', 'decodeURIComponent',
    'encodeURI', 'decodeURI', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'escape', 'unescape',
    'undefined', 'NaN', 'Infinity', 'arguments', 'this', 'super', 'null', 'true', 'false',
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
    'try', 'catch', 'finally', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of', 'void', 'delete',
    'await', 'async', 'yield', 'class', 'extends', 'function', 'const', 'let', 'var', 'import',
    'export', 'from', 'as', 'get', 'set', 'static',
]);

function collectDeclared(code) {
    const declared = new Set();
    const add = (name) => {
        const t = String(name).trim().replace(/^\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(t)) declared.add(t);
    };

    // 简单声明：const a = 1, b = 2  → 取 '=' 之前的名字
    const addSimple = (raw) => {
        for (const piece of raw.split(',')) add(piece.split('=')[0]);
    };
    // 对象解构：const { a, b: c, d = 1, ...rest } = ...
    //   a      → 绑定 a
    //   b: c   → 绑定 c（冒号**后面**才是本地名，冒号前是源对象的键）
    //   d = 1  → 绑定 d
    const addObjectPattern = (raw) => {
        for (const piece of raw.split(',')) {
            const p = piece.trim().replace(/^\.\.\./, '');
            if (!p) continue;
            const colon = p.indexOf(':');
            if (colon >= 0) add(p.slice(colon + 1).split('=')[0]);
            else add(p.split('=')[0]);
        }
    };
    // 数组解构：const [a, b = 1, ...rest] = ...  → 一律取 '=' 之前
    const addArrayPattern = (raw) => {
        for (const piece of raw.split(',')) add(piece.split('=')[0]);
    };

    const patterns = [
        [/\b(?:const|let|var)\s+([^;=\n{}[\]()]+)/g, addSimple],
        [/\b(?:const|let|var)\s*\{([^}]*)\}/g, addObjectPattern],
        [/\b(?:const|let|var)\s*\[([^\]]*)\]/g, addArrayPattern],
        [/\bfunction\s+([A-Za-z_$][\w$]*)/g, add],
        [/\bclass\s+([A-Za-z_$][\w$]*)/g, add],
        [/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g, add],
        [/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g, addSimple],
        [/\(([^()]*)\)\s*=>/g, addSimple],
        [/(?:^|[,{(\s])([A-Za-z_$][\w$]*)\s*=>/g, add],
    ];
    for (const [re, handler] of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(code))) handler(m[1]);
    }
    return declared;
}

/** 扫描单个源文件，返回未声明的函数调用列表 */
function scanSource(src) {
    const code = stripLiterals(src);
    const declared = collectDeclared(code);
    const srcLines = src.split('\n');

    const used = new Map();          // name -> 首次出现的行号
    code.split('\n').forEach((line, idx) => {
        const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
        let m;
        while ((m = re.exec(line))) {
            if (!used.has(m[1])) used.set(m[1], idx + 1);
        }
    });

    const suspects = [];
    for (const [name, line] of used) {
        if (declared.has(name) || GLOBALS.has(name) || KNOWN_METHOD_SHORTHANDS.has(name)) continue;
        suspects.push({ name, line, text: (srcLines[line - 1] || '').trim().slice(0, 110) });
    }
    return suspects;
}

function run() {
    const files = fs.readdirSync(ELECTRON_DIR).filter((f) => f.endsWith('.js')).sort();
    let failed = 0;
    let checks = 0;

    for (const file of files) {
        const src = fs.readFileSync(path.join(ELECTRON_DIR, file), 'utf8');
        const suspects = scanSource(src);
        checks += 1;
        if (suspects.length === 0) continue;
        failed += 1;
        console.log(`  FAIL  ${file} 有 ${suspects.length} 处未声明的调用：`);
        for (const s of suspects) {
            console.log(`          L${s.line}  ${s.name}()`);
            console.log(`                  ${s.text}`);
        }
    }

    /**
     * 浏览器身份（UA）：只许"同源"，不许"改写"。
     *
     * 两条实测事实，第二条把第一条的方案推翻了：
     *
     * A) Chromium **不会**按覆写的 UA 重算 sec-ch-ua / navigator.userAgentData。
     *    所以历史上那种硬编码旧版本号（UA 声称 Chrome/122、CH 报内核 152、navigator
     *    第三个值）必然自相矛盾：Google 登录据此报「此浏览器或应用可能不安全」。
     *
     * B) 于是改成"派生一个看起来像 Chrome 稳定版的 UA"（抹掉 Electron token、
     *    版本掩成 Chrome/<major>.0.0.0），让 UA 与 CH 的主版本号对上。
     *    2026-10-02 在同一站点、同一代理、同一 solver 下 A/B：
     *      · 不改写（UA 照旧带 `Electron/44.4.5`，Chrome 段是四位全版本号）
     *        → Cloudflare managed 挑战 36s 自动放行，**一次点击都不需要**。
     *      · 改写成 `Chrome/152.0.0.0`
     *        → 137s 不放行，自动点击 10~12 次全部无效，组件反复重建。
     *    因为 UA 嘴上说"我是 Chrome 稳定版"，UA-CH 的 brands 里却没有 Google Chrome、
     *    window.chrome 是空对象——这不是修一致性，是**半谎报**，比不改更糟。
     *    CF 据此把挑战升级成"点了也不会放"的死循环，自动点击救不回来。
     *
     * 所以现在的不变量是：**没有任何地方改写 UA**。
     * UA / sec-ch-ua / navigator.userAgentData 全部交回 Chromium 自己发；
     * Node 直抓那条路读会话实际值来对齐（cf_clearance 与 UA 绑定）。
     * 要让站点看成真 Chrome，得四层一起换，只换第一层不行——这条留给以后决策。
     */
    checks += 1;
    const mainSrc = fs.readFileSync(path.join(ELECTRON_DIR, 'main.js'), 'utf8');
    const browseSrc = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
    const uaSrc = fs.readFileSync(path.join(ELECTRON_DIR, 'userAgent.js'), 'utf8');
    const identityProblems = [];

    // 1) 身份源只读不写：拿不到 app（纯 Node 里 require）必须返回空串，
    //    绝不凭 process.versions 造一个"看起来像 Chrome 稳定版"的 UA
    const { kernelUserAgent } = require(path.join(ELECTRON_DIR, 'userAgent.js'));
    const engineUa = kernelUserAgent();
    if (engineUa !== '') {
        identityProblems.push(`纯 Node 环境不该拿得到 UA，却拿到：${engineUa}`);
    }
    if (/process\.versions\.(chrome|electron)/.test(uaSrc)) {
        identityProblems.push('userAgent.js 又按 process.versions 拼 UA 了（拼出来就是假 Chrome 稳定版）');
    }

    // 2) 任何进程都不许再出现硬编码 UA 字面量
    const uaLiteral = /(["'`])Mozilla\/5\.0[^"'`\n]*Chrome\/\d/;
    const scannedIdentityFiles = {
        'electron/main.js': mainSrc,
        'electron/userAgent.js': uaSrc,
        'electron/acgmhoService.js': fs.readFileSync(path.join(ELECTRON_DIR, 'acgmhoService.js'), 'utf8'),
        'electron/challengeSolver.js': fs.readFileSync(path.join(ELECTRON_DIR, 'challengeSolver.js'), 'utf8'),
        'components/BrowsePanel.tsx': browseSrc,
    };
    for (const [name, src] of Object.entries(scannedIdentityFiles)) {
        const m = src.match(uaLiteral);
        if (m) identityProblems.push(`${name} 里有硬编码 UA 字面量：${m[0].slice(0, 72)}…`);
    }

    // 3) 全仓库不许再有"对 session/webContents 覆写 UA"这一类调用
    //    （本地那个 setUserAgent 只是把值推给站点模块，不动浏览器，所以不算）
    const overrideFiles = {
        'electron/main.js': mainSrc,
        'electron/userAgent.js': uaSrc,
        'electron/browserService.js': fs.existsSync(path.join(ELECTRON_DIR, 'browserService.js'))
            ? fs.readFileSync(path.join(ELECTRON_DIR, 'browserService.js'), 'utf8') : '',
        'electron/challengeSolver.js': scannedIdentityFiles['electron/challengeSolver.js'],
        'components/BrowsePanel.tsx': browseSrc,
    };
    for (const [name, src] of Object.entries(overrideFiles)) {
        const m = src.match(/\.\s*setUserAgent\s*\(/);
        if (m) identityProblems.push(`${name} 仍在覆写浏览器 UA：${m[0]}（UA 与 UA-CH 会分家）`);
    }

    // 4) 不许再删 Client Hints
    if (/delete\s+requestHeaders\[\s*['"`]sec-ch-ua/.test(mainSrc)) {
        identityProblems.push('main.js 仍在删 sec-ch-ua*（删 CH = 谎报浏览器，Google/CF 都判伪造）');
    }

    // 5) 渲染层不许再自带 UA
    if (/useragent\s*=/i.test(browseSrc)) {
        identityProblems.push('BrowsePanel.tsx 的 <webview> 仍写了 useragent 属性（UA 会有第二个来源）');
    }

    // 6) Node 直抓的 UA 必须来自浏览器会话实际值，而不是再算一份
    if (!/setUserAgent\(session\.defaultSession\.getUserAgent\(\)\)/.test(mainSrc)) {
        identityProblems.push('main.js 应把会话实际 UA 推给站点模块（cf_clearance 与 UA 绑定）');
    }

    if (identityProblems.length > 0) {
        failed += 1;
        console.log('  FAIL  浏览器身份（UA/Client Hints）不一致：');
        for (const p of identityProblems) console.log(`          ${p}`);
    }

    /**
     * CF 自动过验证的"会点"不变量。
     *
     * 实测事故：求解器只按**顶层页面**文案判 interactive，而"请验证您是真人"
     * 渲染在 challenges.cloudflare.com 的**跨域子帧**里，顶层 outerHTML 永远不含它
     * → 激活分支一次都进不去，窗口里明明摆着复选框，程序只是看着它，
     * 128 秒里 0 次点击（日志里连一条 frame probe 都没有）。
     *
     * 第二个坑在输入通道：`wc.sendInputEvent` 只递给**主帧的渲染进程**，
     * 跨进程子帧（OOPIF，CF 组件正是这种）一个事件都收不到；
     * 同页探针实测：同一个坐标，同进程子帧点得到、跨进程子帧直接丢弃。
     * 必须走 CDP `Input.dispatch*`（在浏览器进程做命中测试与路由）。
     *
     * 这两条都不报错、只是"永远不动"，所以只能靠静态断言钉住。
     */
    checks += 1;
    const solverSrc = fs.readFileSync(path.join(ELECTRON_DIR, 'challengeSolver.js'), 'utf8');
    const solverProblems = [];
    if (!/=\s*isInteractiveChallengeHtml\(html\)\s*\|\|\s*frameInteractive/.test(solverSrc)) {
        solverProblems.push('interactive 判据没有并上子帧结果（只看顶层文案 = 永远不点）');
    }
    if (!/frameInteractive\s*=\s*INTERACTIVE_RE\.test\(probe\.text\)/.test(solverSrc)) {
        solverProblems.push('没有从子帧文案得出 frameInteractive');
    }
    if (!/f\s*!==\s*wc\.mainFrame/.test(solverSrc)) {
        solverProblems.push('子帧探测没排除主帧（顶层 #challenge-stage 的 rect 会把点击推到组件外）');
    }
    if (!/silentStallMs/.test(solverSrc) || !/if\s*\(!interactive\s*&&\s*now\s*-\s*challengeSeenAt\s*<\s*silentStallMs\)\s*continue/.test(solverSrc)) {
        solverProblems.push('缺少"挑战页静置超时后主动点一次"的兜底（CF 换 UI 或读不到帧文案时会卡死）');
    }
    if (!/Input\.dispatchMouseEvent/.test(solverSrc) || !/Input\.dispatchKeyEvent/.test(solverSrc)) {
        solverProblems.push('鼠标/键盘事件没走 CDP Input.dispatch*（sendInputEvent 进不了跨进程子帧）');
    }
    if (!/const inside = \(x, y\)/.test(solverSrc)) {
        solverProblems.push('点击点没有约束在组件盒内（帧内 rect 与盒模型不同源时会点到盒外，点了等于没点）');
    }
    if (solverProblems.length > 0) {
        failed += 1;
        console.log('  FAIL  CF 求解器不会自动点击：');
        for (const p of solverProblems) console.log(`          ${p}`);
    }

    /**
     * 后缀分类跨进程一致性。
     *
     * 主进程不能 import utils（TS），所以嗅探后缀表是**派生副本**。
     * 副本一旦漂移，同一个地址会被两条路径判成不同类型 ——
     * 实测事故：`ts` 在主进程属 videoExts、在 utils 属 stream，
     * 于是 .ts 地址被标成"视频"，筛选栏归错类，
     * 且下载判定 `type !== 'stream'` 让它跳过 ffmpeg 检查
     * （而 .ts 分片恰恰需要 ffmpeg 才能合成可用文件）。
     *
     * 只比对**两边都有**的后缀：主进程刻意只列媒体后缀
     * （document 类与 aibook/gallery 从不推送），缺项不算漂移，分类不同才算。
     */
    checks += 1;
    const utilsSrc = fs.readFileSync(path.join(ROOT, 'utils', 'utils.ts'), 'utf8');
    const extTable = utilsSrc.slice(
        utilsSrc.indexOf('export const MEDIA_EXTENSIONS'),
        utilsSrc.indexOf('};', utilsSrc.indexOf('export const MEDIA_EXTENSIONS')));

    const utilsExt = {};
    for (const m of extTable.matchAll(/'([a-z0-9]+)':\s*'([a-z]+)'/g)) utilsExt[m[1]] = m[2];

    const grabList = (name) => {
        const i = mainSrc.indexOf(`const ${name} = [`);
        if (i < 0) return null;
        const j = mainSrc.indexOf('];', i);
        return (mainSrc.slice(i, j).match(/'([a-z0-9]+)'/g) || []).map((s) => s.slice(1, -1));
    };
    const mainExt = {};
    for (const [name, type] of [['streamExts', 'stream'], ['videoExts', 'video'],
        ['audioExts', 'audio'], ['imageExts', 'image']]) {
        const list = grabList(name);
        if (list) for (const e of list) mainExt[e] = type;
    }

    const drift = [];
    for (const [ext, type] of Object.entries(mainExt)) {
        if (utilsExt[ext] && utilsExt[ext] !== type) {
            drift.push(`          ${ext.padEnd(8)} utils=${utilsExt[ext].padEnd(9)} main.js=${type}`);
        }
    }
    if (drift.length > 0) {
        failed += 1;
        console.log('  FAIL  后缀分类跨进程不一致（同一个地址会被判成不同类型）：');
        for (const d of drift) console.log(d);
    }

    /**
     * webRequest 监听器的注册范围必须对称。
     *
     * Electron 的 webRequest **每个 session 每个事件只保留最后一个监听器**
     * （官方文档："Only the last attached listener will be used"），
     * 所以"挂到哪些 session"必须显式覆盖，不能靠重复注册叠加。
     *
     * 实测事故：嗅探（setupSniffer）在 did-attach-webview 里按 webview 的 session
     * 补挂，而请求头改写只在 createWindow 里挂了主窗口那一个 ——
     * 一旦 webview 带 partition（独立 session），UA / 防盗链 Referer 就全都不生效。
     */
    checks += 1;
    const coverageProblems = [];
    if (!/did-attach-webview[\s\S]{0,400}?setupSniffer\(webContents\.session\)/.test(mainSrc)) {
        coverageProblems.push('did-attach-webview 里没有为 webview 的 session 挂 setupSniffer');
    }
    if (!/did-attach-webview[\s\S]{0,400}?applyRequestHeaderRules\(webContents\.session\)/.test(mainSrc)) {
        coverageProblems.push('did-attach-webview 里没有为 webview 的 session 挂请求头改写');
    }
    // 幂等记账必须**真的被用上**：只断言 `new WeakSet()` 存在是空断言 ——
    // 把 has/add 两行删掉、留下声明，一样能通过。三条都要查。
    if (!/headerRewriteSessions = new WeakSet\(\)/.test(mainSrc)) {
        coverageProblems.push('请求头改写缺少 WeakSet 幂等记账的声明');
    }
    if (!/headerRewriteSessions\.has\(sess\)/.test(mainSrc)) {
        coverageProblems.push('幂等记账没有 has() 守卫（重复注册会顶掉已有监听器）');
    }
    if (!/headerRewriteSessions\.add\(sess\)/.test(mainSrc)) {
        coverageProblems.push('幂等记账没有 add() 落账（守卫永远为假，等于没有）');
    }
    if (coverageProblems.length > 0) {
        failed += 1;
        console.log('  FAIL  webRequest 注册范围不对称：');
        for (const p of coverageProblems) console.log(`          ${p}`);
    }

    /**
     * index.html 的 importmap 与 package.json 版本必须一致。
     *
     * 这份 importmap 不是死配置 —— 实测：正常加载页面时 esm.sh 请求数为 0，
     * 但在页面里执行 `await import('hls.js')` 会真的走 importmap 打到
     * https://esm.sh/hls.js@^1.6.15，并拉回 1.7.3（因为 ^1.6.15 允许 1.7.x）。
     * 也就是说任何**运行时裸模块 import** 都会绕开打包器、按 importmap 取版本。
     * 一旦它落后于 package.json，同一份依赖会出现两个版本并存
     * （打包器内联一个、importmap 拉另一个），React 这类有全局状态的库会直接崩。
     * 曾经就漂移过：react 19.2.3/19.3.0、hls.js 1.6.15/1.7.3、jszip 3.10.1/3.10.2、
     * electron 39/44、vite 7/8。这里静态盯住，改 package.json 时必须同步改 index.html。
     */
    checks += 1;
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const mapBlock = htmlSrc.slice(
        htmlSrc.indexOf('<script type="importmap">'),
        htmlSrc.indexOf('</script>', htmlSrc.indexOf('<script type="importmap">')));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };

    const mapDrift = [];
    if (!mapBlock) {
        mapDrift.push('index.html 里找不到 importmap');
    } else {
        // 只比对**确实在 package.json 里声明**的包：importmap 里的 path/url/dom
        // 是给浏览器垫片用的，本就不是本项目的依赖。
        // 以 '/' 结尾的 specifier（react/、react-dom/）是**目录映射**，
        // 版本段后面天然带一个 '/'，比对前要剥掉。
        //
        // 包名必须写成 `@?[^@"]+`：作用域包的 specifier 以 '@' 开头
        // （@vitejs/plugin-react、@heroicons/react/），而 `[^@"]]+` 匹配不了开头的 '@'，
        // 于是这两条会被静默跳过 —— 守卫看着在跑，实际漏掉了作用域包。
        // 实测过：@heroicons/react 与 @vitejs/plugin-react 此前从未被比对。
        for (const m of mapBlock.matchAll(/"([^"]+)":\s*"https:\/\/esm\.sh\/(@?[^@"]+)@([^"]+)"/g)) {
            const [, specifier, pkgName, rawMapped] = m;
            const declaredVersion = declared[pkgName];
            if (!declaredVersion) continue;            // 非本项目依赖，跳过
            const mapped = rawMapped.replace(/\/$/, '');
            if (declaredVersion !== mapped) {
                mapDrift.push(`          ${specifier.padEnd(22)} package.json=${declaredVersion.padEnd(10)} importmap=${mapped}`);
            }
        }
    }
    if (mapDrift.length > 0) {
        failed += 1;
        console.log('  FAIL  importmap 与 package.json 版本漂移（运行时裸 import 会取到另一个版本）：');
        for (const d of mapDrift) console.log(d);
    }

    /**
     * SPG 提示词里教的效果器必须都是解析器真正认的。
     *
     * 预设名 / 鼓组名 / 和弦性质都从引擎实现处 import（见 AiService 顶部注释），
     * 唯独「可用效果器」那段是手抄在提示词里的 —— 正是这段最容易漂移：
     * 提示词多教一个效果器，模型就会照着写，解析器抛「未知效果器」，
     * 用户看到的是"AI 生成的代码编译失败"，而根因在提示词与实现不一致。
     * 反过来，解析器新增效果器却忘了写进提示词，模型就永远不会用它（能力白加）。
     * 两个方向都盯住。
     */
    checks += 1;
    const parserSrc = fs.readFileSync(
        path.join(ROOT, 'services', 'AudioService', 'audioEngine', 'parser.ts'), 'utf8');
    const aiSrc = fs.readFileSync(path.join(ROOT, 'services', 'AiService.ts'), 'utf8');

    const effectNamesBlock = parserSrc.match(/const EFFECT_NAMES[^=]*=\s*\[([\s\S]*?)\]/);
    const parserEffects = effectNamesBlock
        ? [...new Set([...effectNamesBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))]
        : [];

    const promptStart = aiSrc.indexOf('可用效果器');
    const promptEnd = aiSrc.indexOf('参数名必须用上面列出的那些');
    const promptSection = promptStart >= 0 && promptEnd > promptStart ? aiSrc.slice(promptStart, promptEnd) : '';
    const promptEffects = [...new Set([...promptSection.matchAll(/\\`([a-z_]+)\(/g)].map((m) => m[1]))];

    const effectProblems = [];
    if (parserEffects.length === 0) effectProblems.push('解析器里找不到 EFFECT_NAMES');
    if (promptEffects.length === 0) effectProblems.push('提示词里找不到「可用效果器」清单');
    for (const e of promptEffects) {
        if (!parserEffects.includes(e)) effectProblems.push(`提示词教了 ${e}()，但解析器不认（生成的代码会编译失败）`);
    }
    for (const e of parserEffects) {
        if (!promptEffects.includes(e)) effectProblems.push(`解析器支持 ${e}()，但提示词没写（模型不会用它）`);
    }
    if (effectProblems.length > 0) {
        failed += 1;
        console.log('  FAIL  SPG 提示词与解析器的效果器清单不一致：');
        for (const p of effectProblems) console.log(`          ${p}`);
    }

    /**
     * 页码范围语义在渲染层与主进程各有一份实现，必须逐例一致。
     *
     * GalleryPanel 的 rangeIncludesPage 与 acgmhoService 的 parsePageRange
     * 是同一套规则的两次实现（注释也自称"同语义"）。它们分叉的后果很隐蔽：
     * 渲染层凭前者决定"要不要自己先塞 P1 建分组"，主进程凭后者决定"真正抓哪些页"，
     * 一旦判定不同，界面显示的与磁盘上落下的就对不上，而且不报错。
     * 已经踩过一次：纯空白 spec（' '）主进程按"0 页"处理、渲染层按"全选"处理。
     * 这里直接把两份实现拉出来对拍，任何输入都不许分叉。
     */
    checks += 1;
    const svc = require(path.join(ROOT, 'electron', 'acgmhoService.js'));
    const gallerySrc = fs.readFileSync(
        path.join(ROOT, 'components', 'GalleryPanel.tsx'), 'utf8');

    // 从源码里抠出 rangeIncludesPage 的实现（它是组件内私有函数，无法 import）。
    //
    // 不能直接 eval 整段赋值：那是 TS 源码，签名带类型标注
    // （`(range: string, page: number): boolean =>`），eval 会抛 SyntaxError。
    // 这里只取 `=>` 之后的**函数体**（做花括号配平，跳过字符串字面量），
    // 再用 new Function 包成纯 JS —— 绕开类型标注，测的仍是真实实现。
    const extractArrowBody = (src, declPrefix) => {
        const at = src.indexOf(declPrefix);
        if (at < 0) return null;
        const arrow = src.indexOf('=>', at);
        if (arrow < 0) return null;
        const open = src.indexOf('{', arrow);
        if (open < 0) return null;
        let depth = 0;
        let quote = null;
        for (let i = open; i < src.length; i += 1) {
            const ch = src[i];
            if (quote) {
                if (ch === '\\') { i += 1; continue; }
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) return src.slice(open + 1, i);
            }
        }
        return null;
    };

    const body = extractArrowBody(gallerySrc, 'const rangeIncludesPage');
    let rangeIncludesPage = null;
    if (body) {
        try {
            rangeIncludesPage = new Function('range', 'page', body);
        } catch (e) {
            rangeIncludesPage = null;
        }
    }

    const rangeProblems = [];
    if (typeof svc.parsePageRange !== 'function') {
        rangeProblems.push('acgmhoService 没有导出 parsePageRange');
    } else if (!rangeIncludesPage) {
        rangeProblems.push('GalleryPanel 里找不到 rangeIncludesPage');
    } else {
        const TOTAL = 10;
        const specs = ['', 'all', 'ALL', ' ', '\t', '   ', '1', '1-3', '3-1', '1,3,5',
            ' 1 , 3 ', '0-5', '5-0', 'abc', '1-', '-3', '1.5', '01', '1 - 3', ',',
            '1,,3', '99', '11-20', '0', '1-99', 'all,3'];
        for (const spec of specs) {
            const renderer = rangeIncludesPage(spec, 1);
            const main = svc.parsePageRange(spec, TOTAL).includes(1);
            if (renderer !== main) {
                rangeProblems.push(
                    `spec ${JSON.stringify(spec)}: 渲染层说包含 P1=${renderer}，主进程=${main}（两边语义分叉）`);
            }
        }
    }
    if (rangeProblems.length > 0) {
        failed += 1;
        console.log('  FAIL  页码范围语义在渲染层与主进程分叉：');
        for (const p of rangeProblems) console.log(`          ${p}`);
    }

    /**
     * 思考强度档位：界面、AiService、主进程三处清单一致，下发前都过映射。
     *
     * low / high / max 是界面与配置的唯一口径（「不思考」等同于档位缺省，
     * 不占白名单名额），各服务商取值不同，由 AiService.resolveReasoningEffort 映射。
     * 清单分叉会让档位被静默改写或点不到，漏映射则是服务端一次 503。
     */
    checks += 1;
    const settingsSrc = fs.readFileSync(path.join(ELECTRON_DIR, 'settings.js'), 'utf8');
    const floatingSrc = fs.readFileSync(path.join(ROOT, 'components', 'Floating.tsx'), 'utf8');
    const aiSvcSrc = fs.readFileSync(path.join(ROOT, 'services', 'AiService.ts'), 'utf8');

    const effortsBlock = settingsSrc.match(/REASONING_EFFORTS\s*=\s*\[([^\]]*)\]/);
    const settingsEfforts = effortsBlock
        ? [...effortsBlock[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
        : [];

    // 界面按钮的档位来自 AiService 的 EFFORT_OPTIONS（低 / 高 / 最大）
    const optionsFrom = aiSvcSrc.indexOf('export const EFFORT_OPTIONS');
    const optionsTo = optionsFrom >= 0 ? aiSvcSrc.indexOf('\n];', optionsFrom) : -1;
    const optionsBlock = optionsFrom >= 0 && optionsTo > optionsFrom
        ? aiSvcSrc.slice(optionsFrom, optionsTo)
        : '';
    const uiEfforts = [...optionsBlock.matchAll(/value:\s*'([a-z]+)'/g)].map((m) => m[1]);

    // AiService 自己的归一化白名单（浏览器降级模式下由它再挡一道）
    const aiEffortsBlock = aiSvcSrc.match(/const REASONING_EFFORTS[^=]*=\s*\[([^\]]*)\]/);
    const aiEfforts = aiEffortsBlock
        ? [...aiEffortsBlock[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
        : [];

    const effortProblems = [];
    if (settingsEfforts.length === 0) effortProblems.push('settings.js 里找不到 REASONING_EFFORTS');
    if (uiEfforts.length === 0) effortProblems.push('AiService.ts 里找不到 EFFORT_OPTIONS');
    if (aiEfforts.length === 0) effortProblems.push('AiService.ts 里找不到 REASONING_EFFORTS');
    for (const e of uiEfforts) {
        if (!settingsEfforts.includes(e)) {
            effortProblems.push(`界面提供「${e}」，但主进程白名单没有它（会被静默改写成默认档）`);
        }
    }
    for (const e of settingsEfforts) {
        if (!uiEfforts.includes(e)) {
            effortProblems.push(`主进程支持「${e}」，但界面没有对应按钮（用户选不到）`);
        }
    }
    for (const e of aiEfforts) {
        if (!settingsEfforts.includes(e)) {
            effortProblems.push(`AiService 认「${e}」，但主进程白名单没有它（同一次配置两条链路判定不同）`);
        }
    }
    for (const e of settingsEfforts) {
        if (!aiEfforts.includes(e)) {
            effortProblems.push(`主进程支持「${e}」，但 AiService 不认（浏览器模式下会被降级成默认档）`);
        }
    }
    // 设置面板必须拿 AiService 的三档；手抄一份清单就等于把"两边分叉"的坑重新埋回去
    if (!/EFFORT_OPTIONS[,}\s]/.test(floatingSrc) || !/from '\.\.\/services\/AiService'/.test(floatingSrc)) {
        effortProblems.push('Floating.tsx 没有从 AiService 取 EFFORT_OPTIONS，档位可能又成了手抄清单');
    }
    if (/const EFFORT_OPTIONS/.test(floatingSrc)) {
        effortProblems.push('Floating.tsx 里又出现了本地的 EFFORT_OPTIONS（档位表的真值应在 AiService）');
    }
    /*
     * 每条发请求的路径都要过映射：chat、chatForSpeech、探活。
     * 漏一条就会把 low/high/max 原样发给只认服务商口径的地址。
     */
    const mapped = (aiSvcSrc.match(/resolveReasoningEffort\(/g) || []).length;
    if (mapped < 3) {
        effortProblems.push(`只有 ${mapped} 处请求映射了档位，应为 3 处（chat / chatForSpeech / 探活）`);
    }
    if (!/async function testAiConnection\(input,\s*wireEffort\)/.test(settingsSrc)) {
        effortProblems.push('settings.js 的探活没有接收映射后的档位取值（会把三档原值发出去）');
    }
    if (effortProblems.length > 0) {
        failed += 1;
        console.log('  FAIL  思考强度档位在界面、AiService 与主进程之间分叉：');
        for (const p of effortProblems) console.log(`          ${p}`);
    }

    console.log(`主进程静态自检：通过 ${checks - failed} 项，失败 ${failed} 项`);
    return failed === 0;
}

module.exports = { run, scanSource, stripLiterals };
