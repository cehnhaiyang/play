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
const ELECTRON_DIR = path.join(ROOT, 'app', 'main');

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
    // WebSocket 是 Node 22 / Electron 主进程自带的全局（外部浏览器的 CDP 客户端用它）
    'WebSocket',
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
        /*
         * `for (const x of xs)` 的循环变量。
         *
         * 必须单列一条：上面那条简单声明模式取的是「const 之后到 = 或括号之前」
         * 的整段，于是 `const x of xs` 被当成一个名字交给 addSimple，
         * 而它含空格、过不了标识符判据 —— x 就没被登记，下面把它当未声明的调用报红。
         * 实测：主进程里写一个 `for (const forward of set)` 就会得到一条假失败，
         * 而假失败会训练人忽略这个检查，比没有检查更糟。
         */
        [/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\b/g, add],
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
    const identityProblems = [];

    // 1) 不许凭 process.versions 拼一个"看起来像 Chrome 稳定版"的 UA。
    //    UA 的唯一来源是引擎自己（app.userAgentFallback / 会话实际值）。
    for (const file of fs.readdirSync(ELECTRON_DIR).filter((f) => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(ELECTRON_DIR, file), 'utf8');
        if (/process\.versions\.(chrome|electron)/.test(src)) {
            identityProblems.push(`electron/${file} 按 process.versions 拼 UA 了（拼出来就是假 Chrome 稳定版）`);
        }
    }

    // 2) 任何进程都不许再出现硬编码 UA 字面量
    const uaLiteral = /(["'`])Mozilla\/5\.0[^"'`\n]*Chrome\/\d/;
    const scannedIdentityFiles = {
        'app/main/main.js': mainSrc,
        'app/main/acgmhoService.js': fs.readFileSync(path.join(ELECTRON_DIR, 'acgmhoService.js'), 'utf8'),
    };
    for (const [name, src] of Object.entries(scannedIdentityFiles)) {
        const m = src.match(uaLiteral);
        if (m) identityProblems.push(`${name} 里有硬编码 UA 字面量：${m[0].slice(0, 72)}…`);
    }

    // 3) 主进程不许"对 session/webContents 覆写 UA"
    //    （main.js 的 setUserAgent 只是把值推给站点模块，不动浏览器，所以不算）
    {
        const m = mainSrc.match(/\.\s*setUserAgent\s*\(/);
        if (m) identityProblems.push(`app/main/main.js 仍在覆写浏览器 UA：${m[0]}（UA 与 UA-CH 会分家）`);
    }

    // 4) 不许再删 Client Hints
    if (/delete\s+requestHeaders\[\s*['"`]sec-ch-ua/.test(mainSrc)) {
        identityProblems.push('main.js 仍在删 sec-ch-ua*（删 CH = 谎报浏览器，Google/CF 都判伪造）');
    }

    // 5) Node 直抓的 UA 必须来自浏览器会话实际值，而不是再算一份
    if (!/setUserAgent\(session\.defaultSession\.getUserAgent\(\)\)/.test(mainSrc)) {
        identityProblems.push('main.js 应把会话实际 UA 推给站点模块（cf_clearance 与 UA 绑定）');
    }

    if (identityProblems.length > 0) {
        failed += 1;
        console.log('  FAIL  浏览器身份（UA/Client Hints）不一致：');
        for (const p of identityProblems) console.log(`          ${p}`);
    }

    /**
     * 后缀分类跨进程一致性。
     *
     * 主进程不能 import const（TS），所以嗅探后缀表是**派生副本**。
     * 副本一旦漂移，同一个地址会被两条路径判成不同类型 ——
     * 实测事故：`ts` 在主进程属 videoExts、在 const.ts 属 stream，
     * 于是 .ts 地址被标成"视频"，筛选栏归错类，
     * 且下载判定 `type !== 'stream'` 让它跳过 ffmpeg 检查
     * （而 .ts 分片恰恰需要 ffmpeg 才能合成可用文件）。
     *
     * 只比对**两边都有**的后缀：主进程刻意只列媒体后缀
     * （document 类与 aibook/gallery 从不推送），缺项不算漂移，分类不同才算。
     */
    checks += 1;
    const constSrc = fs.readFileSync(path.join(ROOT, 'shared', 'core', 'media.ts'), 'utf8');
    const extTable = constSrc.slice(
        constSrc.indexOf('export const MEDIA_EXTENSIONS'),
        constSrc.indexOf('};', constSrc.indexOf('export const MEDIA_EXTENSIONS')));

    const constExt = {};
    for (const m of extTable.matchAll(/'([a-z0-9]+)':\s*'([a-z]+)'/g)) constExt[m[1]] = m[2];

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
        if (constExt[ext] && constExt[ext] !== type) {
            drift.push(`          ${ext.padEnd(8)} const.ts=${constExt[ext].padEnd(9)} main.js=${type}`);
        }
    }
    if (drift.length > 0) {
        failed += 1;
        console.log('  FAIL  后缀分类跨进程不一致（同一个地址会被判成不同类型）：');
        for (const d of drift) console.log(d);
    }

    /**
     * webRequest 监听器必须挂到应用真正会用到的每一个 session 上。
     *
     * Electron 的 webRequest **每个 session 每个事件只保留最后一个监听器**
     * （官方文档："Only the last attached listener will be used"），
     * 所以"挂到哪些 session"必须显式覆盖，不能靠重复注册叠加。
     *
     * 自建浏览器外壳（含 <webview>）拆除后，应用只剩主窗口一个 session，
     * 原先那组"did-attach-webview 里补挂"的断言随之失效 —— 它守的是
     * 一个已经不存在的结构。现在守的是剩下这条：
     *
     *   · webviewTag 必须关掉。外壳没了却还开着它，等于给渲染层留一个
     *     能加载任意远程页面的口子，而没有任何地方需要 —— 而且一旦有人
     *     真用起来，上面那条"每个 session 只留最后一个监听器"的坑会立刻复现；
     *   · 主窗口的 session 必须两样都挂上（嗅探 + 请求头改写），
     *     且请求头改写要带幂等记账：将来若再加第二个 session，
     *     重复注册会把先注册的顶掉，而不是叠加。
     */
    checks += 1;
    const coverageProblems = [];
    if (/webviewTag:\s*true/.test(mainSrc)) {
        coverageProblems.push('webviewTag 仍开着：浏览器外壳已拆，应用里不该再能嵌入远程页面');
    }
    if (!/applyRequestHeaderRules\(mainWindow\.webContents\.session\)/.test(mainSrc)) {
        coverageProblems.push('主窗口 session 没有挂请求头改写（防盗链 Referer 会全部失效）');
    }
    if (!/setupSniffer\(session\.defaultSession\)/.test(mainSrc)) {
        coverageProblems.push('默认 session 没有挂 setupSniffer');
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
        console.log('  FAIL  webRequest 注册范围不完整：');
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
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
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
        path.join(ROOT, 'app', 'services', 'AudioService.ts'), 'utf8');
    // SPG 的语法文档（含「可用效果器」清单）已按功能归属切到 SpgAiService.ts ——
    // 它需要 AudioService 的名字表，留在 AiService 里会把整个音频引擎拖进插件 bundle。
    const aiSrc = fs.readFileSync(path.join(ROOT, 'app', 'services', 'SpgAiService.ts'), 'utf8');

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
    const svc = require(path.join(ROOT, 'app', 'main', 'acgmhoService.js'));
    const gallerySrc = fs.readFileSync(
        path.join(ROOT, 'app', 'components', 'GalleryPanel.tsx'), 'utf8');

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
     * 思考强度档位：清单**只有一份**（`shared/ai/ai-defaults.json`），两侧都从它推导。
     *
     * low / high / max 是界面与配置的唯一口径（「不思考」等同于档位缺省，
     * 不占白名单名额），各模型认的取值不同，由 AiService.resolveReasoningEffort
     * 按模型映射（映射矩阵本身在 aiprovider.test.js 里跑真实函数验证）。
     * 清单分叉会让档位被静默改写或点不到，漏映射则是服务端一次 503。
     *
     * 这里**调用两侧的真实模块**取清单，而不是从源码切字符串 —— 切字符串只能证明
     * "两处文本长得一样"，证明不了"读的是同一份"。再加两条负向断言，防止有人把
     * 清单抄回代码里：抄一份就重新有了分叉的可能。
     */
    checks += 1;
    const settingsSrc = fs.readFileSync(path.join(ELECTRON_DIR, 'settings.js'), 'utf8');
    const floatingSrc = fs.readFileSync(path.join(ROOT, 'app', 'components', 'Floating.tsx'), 'utf8');
    const aiSvcSrc = fs.readFileSync(path.join(ROOT, 'shared', 'ai', 'AiService.ts'), 'utf8');

    const aiEfforts = require(path.join(__dirname, 'build', 'shared', 'ai', 'AiService.js'))
        .EFFORT_OPTIONS.filter((option) => option.value).map((option) => option.value);
    const settingsEfforts = require(path.join(ELECTRON_DIR, 'settings.js')).REASONING_EFFORTS;

    const effortProblems = [];
    if (aiEfforts.length === 0) effortProblems.push('AiService 的 EFFORT_OPTIONS 里没有档位');
    if (settingsEfforts.length === 0) effortProblems.push('settings.js 的 REASONING_EFFORTS 是空的');
    for (const e of aiEfforts) {
        if (!settingsEfforts.includes(e)) {
            effortProblems.push(`界面提供「${e}」，但主进程白名单没有它（会被静默改写成默认档）`);
        }
    }
    for (const e of settingsEfforts) {
        if (!aiEfforts.includes(e)) {
            effortProblems.push(`主进程支持「${e}」，但界面没有对应按钮（用户选不到）`);
        }
    }
    if (/REASONING_EFFORTS\s*=\s*\[/.test(settingsSrc)) {
        effortProblems.push('settings.js 里又出现了档位数组字面量（应从 ai-defaults.json 推导）');
    }
    if (/REASONING_EFFORTS\s*(:[^=\n]*)?=\s*\[/.test(aiSvcSrc)) {
        effortProblems.push('AiService.ts 里又出现了档位数组字面量（应从 ai-defaults.json 推导）');
    }
    const tierTable = require(path.join(ROOT, 'shared', 'ai', 'ai-defaults.json')).reasoningEfforts || [];
    for (const tier of tierTable) {
        // 缺 label / hint 会在界面上画出一个没有文字的按钮，而按钮仍然可点
        if (!tier.value || !tier.label || !tier.hint) {
            effortProblems.push(`ai-defaults.json 的档位缺少 value/label/hint：${JSON.stringify(tier)}`);
        }
    }
    // 设置面板必须拿 AiService 的三档；手抄一份清单就等于把"两边分叉"的坑重新埋回去
    if (!/EFFORT_OPTIONS[,}\s]/.test(floatingSrc) || !/from '[^']*shared\/ai\/AiService'/.test(floatingSrc)) {
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

    /**
     * 主进程 require 的仓内文件必须进打包清单。
     *
     * 主进程是**纯 CJS 源码**，electron-builder 按 package.json 的 `build.files`
     * 白名单打包：require 一个不在清单里的文件，开发态一切正常，装出来的应用
     * 启动即 MODULE_NOT_FOUND。此前主进程不 require 仓内任何文件，这条约束一直是
     * 隐含的；默认 AI 配置挪进 `shared/ai/ai-defaults.json` 之后必须显式钉住。
     */
    checks += 1;
    const packFiles = ((require(path.join(ROOT, 'package.json')).build || {}).files) || [];
    const packed = (rel) => packFiles.some((entry) => {
        const norm = String(entry).replace(/\\/g, '/');
        if (norm.endsWith('/**/*')) return rel.startsWith(norm.slice(0, -4));
        if (norm.endsWith('/**')) return rel.startsWith(norm.slice(0, -2));
        return norm === rel;
    });
    const packProblems = [];
    for (const file of fs.readdirSync(ELECTRON_DIR).filter((f) => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(ELECTRON_DIR, file), 'utf8');
        for (const m of src.matchAll(/require\('(\.\.?\/[^']+)'\)/g)) {
            const rel = path.relative(ROOT, path.resolve(ELECTRON_DIR, m[1])).replace(/\\/g, '/');
            if (rel.startsWith('..')) continue;   // 仓外路径不归这条清单管
            if (!packed(rel)) {
                packProblems.push(`${file} require 了 ${rel}，但 package.json 的 build.files 里没有它（打包后启动即崩）`);
            }
        }
    }
    if (packProblems.length > 0) {
        failed += 1;
        console.log('  FAIL  主进程 require 的文件没进打包清单：');
        for (const p of packProblems) console.log(`          ${p}`);
    }

    /**
     * 悬浮球面板缩放的几何。
     *
     * `frameForResize` / `clampPanel` 是**纯函数**，不碰 Electron API，
     * 所以能在这里直接调用 —— 必须调用而不是查源码：这两处的错法全都
     * 是"算得出一个数、但那个数是错的"，正则匹配永远看不出来。
     *
     * 实测事故：把手有 16px 宽，指针落在把手里的哪个像素是不确定的。
     * 早期版本用 `指针 − 尺寸` 反推左上角，于是**一按下窗口就先跳最多 16px**。
     * 下面第一条断言盯的就是它。
     */
    checks += 1;
    const orbMod = require(path.join(ELECTRON_DIR, 'orbs.js'));
    const orbProblems = [];

    const close = (a, b) => Math.abs(a - b) < 0.51;
    const eqFrame = (label, got, want) => {
        for (const k of ['x', 'y', 'width', 'height']) {
            if (!close(got?.[k], want[k])) {
                orbProblems.push(`${label}：${k} 期望 ${want[k]}，实际 ${got?.[k]}`);
            }
        }
    };

    // 无 Electron 环境时 workAreaFor 兜底成 1920x1080，下面按它算
    const AREA = { x: 0, y: 0, width: 1920, height: 1080 };
    const MARGIN = 8;

    if (typeof orbMod.frameForResize !== 'function' || typeof orbMod.clampPanel !== 'function'
        || typeof orbMod.frameFor !== 'function'
        || typeof orbMod.dragAnchorAt !== 'function' || typeof orbMod.frameWhileDragging !== 'function'
        || typeof orbMod.centerAfterDrag !== 'function') {
        orbProblems.push('orbs.js 没有导出 frameFor / frameForResize / clampPanel / 拖动三件套（几何无法被断言）');
    } else {
        const orbSrc = fs.readFileSync(path.join(ELECTRON_DIR, 'orbs.js'), 'utf8');
        const base = { x: 400, y: 300, width: 380, height: 520 };

        // 1) 按下不跳：指针没动，窗口就必须一个像素都不动
        eqFrame('按下时不动', orbMod.frameForResize('sniff',
            { x: 1000, y: 1000 }, { pointer: { x: 1000, y: 1000 }, frame: base }), base);

        // 2) 增量语义：指针移多少，尺寸变多少，位置不动（还有空间时）
        eqFrame('指针右下移 100/50', orbMod.frameForResize('sniff',
            { x: 1100, y: 1050 }, { pointer: { x: 1000, y: 1000 }, frame: base }),
            { x: 400, y: 300, width: 480, height: 570 });

        // 3) 下限：往左上拖过头，尺寸被最小尺寸挡住
        const floored = orbMod.frameForResize('sniff',
            { x: 100, y: 100 }, { pointer: { x: 1000, y: 1000 }, frame: base });
        if (floored.width !== 300 || floored.height !== 320) {
            orbProblems.push(`缩放下限失效：拖到 ${floored.width}x${floored.height}，应为 300x320`);
        }

        // 4) 上限：面板不许比工作区还大，否则把手会被挤出屏幕
        const capped = orbMod.frameForResize('sniff',
            { x: 99999, y: 99999 }, { pointer: { x: 1000, y: 1000 }, frame: base });
        if (capped.width > AREA.width - MARGIN * 2 || capped.height > AREA.height - MARGIN * 2) {
            orbProblems.push(`缩放上限失效：${capped.width}x${capped.height} 超出工作区`);
        }
        if (capped.x + capped.width > AREA.width - MARGIN || capped.y + capped.height > AREA.height - MARGIN) {
            orbProblems.push(`缩放后越出工作区：右下角 ${capped.x + capped.width},${capped.y + capped.height}`);
        }

        /*
         * 5) 贴右边之后继续往右拖，面板必须**还能变大**（改成向左长）。
         *
         * 这一条是"球的默认位置在右下角"逼出来的：面板围着球心铺开，右边缘
         * 一开始就贴着工作区右缘。死钉左上角的话可增长空间是 0，
         * 用户看到的是"把手拖得动，面板一动不动"。
         */
        const atRightEdge = { x: AREA.width - MARGIN - 380, y: 300, width: 380, height: 520 };
        const grown = orbMod.frameForResize('sniff',
            { x: atRightEdge.x + atRightEdge.width + 100, y: 1000 },
            { pointer: { x: atRightEdge.x + atRightEdge.width, y: 1000 }, frame: atRightEdge });
        if (grown.width <= atRightEdge.width) {
            orbProblems.push(`贴右边后无法继续加宽：${atRightEdge.width} → ${grown.width}（应为"向左长"）`);
        }
        if (grown.x + grown.width > AREA.width - MARGIN) {
            orbProblems.push(`贴右边加宽后越界：右缘 ${grown.x + grown.width}`);
        }

        // 6) clampPanel：默认值 / 旧记录缺 w,h / 下限 / 上限
        const def = orbMod.ORB_DEFS.sniff;
        const cases = [
            ['无记录用默认尺寸', undefined, { w: def.panel.w, h: def.panel.h }],
            ['旧记录只有 x,y 时用默认尺寸', { x: 100, y: 100 }, { w: def.panel.w, h: def.panel.h }],
            ['过小的记录被顶到下限', { w: 10, h: 10 }, { w: def.panelMin.w, h: def.panelMin.h }],
            ['过大的记录被收到工作区内', { w: 5000, h: 5000 },
                { w: AREA.width - MARGIN * 2, h: AREA.height - MARGIN * 2 }],
        ];
        for (const [label, saved, want] of cases) {
            const got = orbMod.clampPanel('sniff', saved, AREA);
            if (got.w !== want.w || got.h !== want.h) {
                orbProblems.push(`clampPanel ${label}：期望 ${want.w}x${want.h}，实际 ${got.w}x${got.h}`);
            }
        }

        /*
         * 7) 展开再收起，球必须回到**原来那个点**。
         *
         * 这是实测事故：球放在左上角，展开一次再收起，球跑到屏幕中间去了。
         * 根因是 `setOpen` 从窗口矩形反推球心 —— 收起时窗口是面板，而面板
         * 被 `frameFor` 收敛回工作区之后中心已经不在球心上了。球心是用户
         * 定下来的，只能由拖动/缩放改，不能是窗口矩形的函数。
         *
         * `setOpen` 要 Electron 才能跑，所以下面分两步：
         *   a. 先证明"反推"这条错法在贴边的两个角上**确实会漂**（用例有效性）；
         *   b. 再对 `setOpen` 的取心方式下一道结构断言。
         * 只做 b 的话，用例选错（比如只挑屏幕正中，那里面板不被收敛、反推
         * 恰好也对）就会让守卫永远绿 —— 见下面注释里那个"为什么这 bug 一直
         * 没被发现"的原因。
         */
        const ballSize = orbMod.BALL_SIZE;
        const panelSize = { w: def.panel.w, h: def.panel.h };

        // 屏幕正中不算：那里面板不被收敛，反推球心恰好等于真球心，
        // 正是这个巧合让"球放在中间"的人一直没发现问题。
        for (const [label, corner] of [
            ['左上角', { x: AREA.x + MARGIN + ballSize / 2, y: AREA.y + MARGIN + ballSize / 2 }],
            ['右下角', { x: AREA.width - MARGIN - ballSize / 2, y: AREA.height - MARGIN - ballSize / 2 }],
        ]) {
            const ball = orbMod.frameFor(corner, { w: ballSize, h: ballSize }, AREA);
            const panel = orbMod.frameFor(corner, panelSize, AREA);

            // 展开确实把窗口挪离了球心，否则这个用例证明不了任何事
            const panelCenter = { x: panel.x + panel.width / 2, y: panel.y + panel.height / 2 };
            const drift = Math.hypot(panelCenter.x - corner.x, panelCenter.y - corner.y);
            if (drift < 1) {
                orbProblems.push(
                    `用例无效：「${label}」展开后窗口中心与球心重合（漂移 ${drift.toFixed(1)}px），`
                    + '反推球心在这条路径上不会出错，拦不住真实事故');
                continue;
            }

            // 老写法：拿面板矩形的中心当球心。必须与真球心摆出不同的位置
            const wrong = orbMod.frameFor(panelCenter, { w: ballSize, h: ballSize }, AREA);
            if (wrong.x === ball.x && wrong.y === ball.y) {
                orbProblems.push(
                    `用例无效：「${label}」反推球心摆出的位置与真球心相同（${ball.x},${ball.y}），`
                    + '拦不住真实事故');
            }
        }

        /*
         * 结构断言：`setOpen` 的取心处不许出现 `getBounds`。
         *
         * 这是**形态断言，不是行为验证** —— 它拦得住"改回从窗口矩形反推"，
         * 拦不住另一种同样错的写法。真正的行为验证需要 Electron 环境。
         */
        const setOpenSrc = orbSrc.slice(orbSrc.indexOf('const setOpen ='));
        // 必须先剥注释：setOpen 的说明里正举着 `getBounds()` 当反面教材，
        // 直接搜源码会命中那段注释，把正确的代码判成错的
        const setOpenBody = stripLiterals(setOpenSrc.slice(0, setOpenSrc.indexOf('\n};')));
        if (!/frameFor\(entry\.center,/.test(setOpenBody)) {
            orbProblems.push('setOpen 没有用 entry.center 定位（球心必须只有一个权威）');
        }
        if (/getBounds\(\)/.test(setOpenBody)) {
            orbProblems.push('setOpen 里出现了 getBounds()：从窗口矩形反推球心会让收起后的球漂走');
        }

        /*
         * 8) 球心的写入口只能有一个。
         *
         * 上面那条只盯住了 `setOpen`，而同一个错法在 `resize-end` 里也有一份：
         * 那里同样从窗口矩形反推球心，而缩放中的窗口是面板 —— 实测球在左上角时
         * 位移 416px，比 setOpen 那处漂得还远。只修一处的话，用户"拉一下面板
         * 大小再收起"照样看到球跑掉。
         *
         * 判据是**位置无关的**：只要"球心 = 某个窗口矩形的中心"这个写法再出现
         * 在任何一处（除了拖动结束，那时窗口确实就是球），就是同一个 bug 复发。
         */
        const centerWrites = stripLiterals(orbSrc).match(/entry\.center\s*=/g) || [];
        if (centerWrites.length !== 1) {
            orbProblems.push(
                `entry.center 有 ${centerWrites.length} 个写入口，应恰好 1 个（拖动结束）；`
                + '多出来的那些会让球在展开/收起/缩放之间漂走');
        }

        /*
         * 9) 拖动这条路径：球心必须跟着窗口平移，且**不能用窗口中心当球心**。
         *
         * 展开态的窗口是面板，面板被 `frameFor` 收敛贴边时中心与球心差 277px。
         * 老写法（`centerAfterDrag` 里取窗口中心）只在收起态恰好正确，所以
         * 用例必须走**展开态 + 贴边**这条路径，否则拦不住。
         *
         * 直接调用三个纯函数跑完整条链路，而不是查源码：这类错误全是"算得出
         * 一个数、但那个数是错的"，正则看不出来。
         */
        const ballSize2 = orbMod.BALL_SIZE;
        const panelSize2 = { w: def.panel.w, h: def.panel.h };

        for (const [label, ballCenter, open, delta] of [
            ['收起态拖球', { x: MARGIN + ballSize2 / 2, y: MARGIN + ballSize2 / 2 }, false, { x: 120, y: 90 }],
            ['展开态拖面板（左上角，被收敛）', { x: MARGIN + ballSize2 / 2, y: MARGIN + ballSize2 / 2 }, true, { x: 60, y: 0 }],
            ['展开态拖面板（右下角，被收敛）',
                { x: AREA.width - MARGIN - ballSize2 / 2, y: AREA.height - MARGIN - ballSize2 / 2 }, true, { x: -70, y: -50 }],
        ]) {
            const ballBefore = orbMod.frameFor(ballCenter, { w: ballSize2, h: ballSize2 }, AREA);
            // 球心是权威，展开**不会**改写它（面板位置由它推出来，不是反过来）
            const center = { x: ballBefore.x + ballSize2 / 2, y: ballBefore.y + ballSize2 / 2 };
            const win = open ? orbMod.frameFor(center, panelSize2, AREA) : ballBefore;

            const pointer = { x: win.x + 30, y: win.y + 20 };
            const anchor = orbMod.dragAnchorAt(win, center, pointer);
            const moved = orbMod.frameWhileDragging(
                { x: pointer.x - anchor.grab.x + delta.x, y: pointer.y - anchor.grab.y + delta.y },
                open ? panelSize2 : { w: ballSize2, h: ballSize2 }, AREA);
            const after = orbMod.centerAfterDrag(moved, anchor);

            // 语义：拖面板 = 把球心平移同样的量
            const want = { x: center.x + delta.x, y: center.y + delta.y };
            if (!close(after.x, want.x) || !close(after.y, want.y)) {
                orbProblems.push(
                    `${label}：拖动后球心 ${after.x},${after.y}，应为 ${want.x},${want.y}`
                    + `（漂了 ${Math.hypot(after.x - want.x, after.y - want.y).toFixed(0)}px）`);
            }

            // 用例有效性：这条路径上"用窗口中心当球心"必须真的会算错
            if (open) {
                const wrong = { x: moved.x + moved.width / 2, y: moved.y + moved.height / 2 };
                if (close(wrong.x, want.x) && close(wrong.y, want.y)) {
                    orbProblems.push(
                        `用例无效：「${label}」面板未被收敛，用窗口中心当球心也算得对，拦不住真实事故`);
                }
            }
        }
    }

    if (orbProblems.length > 0) {
        failed += 1;
        console.log('  FAIL  悬浮球面板缩放的几何算错：');
        for (const p of orbProblems) console.log(`          ${p}`);
    }

    console.log(`主进程静态自检：通过 ${checks - failed} 项，失败 ${failed} 项`);
    return failed === 0;
}

module.exports = { run, scanSource, stripLiterals };
