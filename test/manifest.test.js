'use strict';
/**
 * 插件产物自检：`extension/dist` 是不是一个 Chrome 真能加载的包。
 *
 * 为什么需要这一步：manifest 与各入口里引用的是**固定文件名**
 * （service-worker.js / content.js / offscreen.html），
 * 构建配置里任何一处路径推导写错，产物都会缺文件或引用错路径 ——
 * 而 Chrome 报的永远是同一句"清单文件丢失或不可读取"，
 * 看不出到底缺哪个。这里把每个引用逐个落到磁盘上验证。
 *
 * 同时也反向检查：已删除的东西（side panel）不该还留在产物或清单里。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'extension', 'dist');

let pass = 0;
const fails = [];

const run = () => {
    // 每次调用都重置：run() 会被同一进程调用多次（变异检查就是）
    pass = 0;
    fails.length = 0;

    const ok = (label, rel) => {
        const f = path.join(DIST, rel);
        if (fs.existsSync(f)) {
            console.log(`  OK    ${label} -> ${rel} (${fs.statSync(f).size}B)`);
            pass += 1;
            return true;
        }
        console.log(`  FAIL  ${label} -> ${rel} 不存在`);
        fails.push(`${label} -> ${rel}`);
        return false;
    };

    if (!fs.existsSync(DIST)) {
        console.log('  产物自检：dist 不存在，先跑 npm run ext:build');
        return false;
    }

    const mfPath = path.join(DIST, 'manifest.json');
    if (!fs.existsSync(mfPath)) {
        console.log('  产物自检：dist/manifest.json 不存在 —— public/ 没有被拷进产物');
        return false;
    }

    let mf;
    try {
        mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    } catch (e) {
        console.log('  产物自检：dist/manifest.json 不是合法 JSON：', e.message);
        return false;
    }

    console.log(`  manifest_version: ${mf.manifest_version}`);
    console.log(`  name: ${mf.name} | version: ${mf.version}`);
    console.log(`  minimum_chrome_version: ${mf.minimum_chrome_version}`);

    // MV3 是硬要求：MV2 的 manifest 在 2024 之后直接被拒
    if (mf.manifest_version !== 3) fails.push('manifest_version 必须是 3');

    // 名字与描述里混进乱码是最隐蔽的一种坏 —— JSON 仍合法，Chrome 照收，
    // 只是商店与扩展页上显示成问号。构建链路里有一步用了非 UTF-8 读写就会这样。
    for (const [field, value] of [['name', mf.name], ['description', mf.description]]) {
        if (typeof value === 'string' && value.includes('\uFFFD')) {
            fails.push(`${field} 里有替换字符（U+FFFD），编码在某一环被破坏了`);
        }
    }
    // Chrome 对 name/description 有长度上限，超了会直接拒绝加载
    if (mf.name && mf.name.length > 75) fails.push(`name 超过 75 字符（${mf.name.length}）`);
    if (mf.description && mf.description.length > 132) {
        fails.push(`description 超过 132 字符（${mf.description.length}）`);
    }

    // 声明了就必须存在 —— 这是"清单文件丢失或不可读取"之外最常见的加载失败
    ok('background.service_worker', mf.background.service_worker);

    /*
     * side_panel 必须**不存在**。
     *
     * 侧边栏已删除，但 manifest 里留着 `side_panel.default_path` 指向一个
     * 不存在的 panel.html 时，Chrome **不会**报错 —— 它只是点图标时打开一个
     * 空白面板。这类"声明了但没产物"的残留没有任何反馈，只能靠断言挡住。
     *
     * 同理 `sidePanel` 权限：留着它会让安装提示多一条无用的权限说明。
     */
    if (mf.side_panel) {
        fails.push('manifest 里还留着 side_panel —— 侧边栏已删除，点图标会打开一个空白面板');
    }
    if ((mf.permissions || []).includes('sidePanel')) {
        fails.push('manifest 里还声明着 sidePanel 权限 —— 侧边栏已删除，这条权限没有用处');
    }

    /*
     * content_scripts 必须**存在且非空**。
     *
     * 只在"声明了就检查文件在不在"是不够的：整个 content_scripts 块被删掉时，
     * 循环一次都不跑，检查全绿 —— 而结果是悬浮球永远不出现。
     * 变异测试实测过这一条（删掉 content_scripts，6 项全过），所以这里
     * 先断言它存在。
     */
    if (!Array.isArray(mf.content_scripts) || mf.content_scripts.length === 0) {
        fails.push('manifest 里没有 content_scripts —— 悬浮球不会注入到任何页面');
    }
    for (const [i, cs] of (mf.content_scripts || []).entries()) {
        if (!Array.isArray(cs.js) || cs.js.length === 0) {
            fails.push(`content_scripts[${i}] 没有 js 文件`);
        }
        for (const js of cs.js || []) ok(`content_scripts[${i}].js`, js);
        for (const css of cs.css || []) ok(`content_scripts[${i}].css`, css);
    }

    /*
     * offscreen.html。
     *
     * 它是 `chrome.offscreen.createDocument` 的目标，路径写在代码里而不是
     * manifest 里 —— 所以没有任何静态检查会盯着它。缺了它的表现是
     * "Agent 一发消息就报 offscreen 宿主无响应"。
     */
    ok('offscreen 宿主文档', 'offscreen.html');
    const offscreenRefs = fs.existsSync(path.join(DIST, 'offscreen.html'))
        ? [...fs.readFileSync(path.join(DIST, 'offscreen.html'), 'utf8')
            .matchAll(/(?:src|href)="([^"]+)"/g)].map((x) => x[1])
        : [];
    for (const ref of offscreenRefs) ok('offscreen.html', ref.replace(/^\//, ''));

    /*
     * panel.html 与 panel.js 必须**不存在**。
     *
     * 侧边栏删掉之后，主构建的 emptyOutDir 会清掉它们 —— 但如果哪天有人
     * 把 panel 加回 vite 的 input，产物里就会重新出现一份没人加载的界面。
     * 那种残留不会报错，只会让下一个读代码的人以为侧边栏还在。
     */
    for (const stale of ['panel.html', 'panel.js']) {
        if (fs.existsSync(path.join(DIST, stale))) {
            fails.push(`产物里还有 ${stale} —— 侧边栏已删除，它不该被构建出来`);
        }
    }

    /*
     * content.js 必须是**自包含的传统脚本**，不能含 import 语句。
     *
     * manifest 的 content_scripts 没有 `type` 字段，声明成 .js 就按传统脚本
     * 求值 —— 出现 `import` 会直接语法错误，整个 content script 不执行。
     * 构建配置里 format 从 'iife' 改成 'es' 就会这样，而 vite 不会报错。
     */
    const contentPath = path.join(DIST, 'content.js');
    if (fs.existsSync(contentPath)) {
        const contentSrc = fs.readFileSync(contentPath, 'utf8');
        if (/^\s*import[\s{*]/m.test(contentSrc)) {
            fails.push('content.js 里有 import 语句 —— content script 必须是自包含的 IIFE');
        }
        // 反向：宿主容器与样式注入是它存在的理由，缺了就是"装了但没反应"
        if (!contentSrc.includes('attachShadow')) {
            fails.push('content.js 里没有 attachShadow —— 悬浮球的样式隔离没生效');
        }
    }

    /*
     * 权限必须与代码实际调用的 API 对得上，否则运行时才炸。
     *
     * **扫描前必须先剥掉注释**：注释里出现 `chrome.userScripts` 是正常的
     * （解释"为什么不用它"），把它当成真实调用会报一条假失败 ——
     * 而假失败会训练人忽略这个检查，那比没有检查更糟。
     */
    const stripComments = (src) => src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    const srcDir = path.join(ROOT, 'extension', 'src');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const used = new Set();
    for (const f of walk(srcDir)) {
        const s = stripComments(fs.readFileSync(f, 'utf8'));
        for (const mm of s.matchAll(/chrome\.([a-zA-Z]+)\./g)) used.add(mm[1]);
    }
    // API 名 → 需要的权限名（只有不同名或需要额外声明的才列出）
    const NEEDS = {
        webRequest: 'webRequest',
        webNavigation: 'webNavigation',
        cookies: 'cookies',
        downloads: 'downloads',
        storage: 'storage',
        tabs: 'tabs',
        // 这两个不是"同名可推导"的：offscreen 没有对应的 API 名，
        // debugger 在类型定义里叫 `_debugger`（导出时才改名），
        // 所以两者都必须显式列出来，否则漏声明也检查不到。
        offscreen: 'offscreen',
        debugger: 'debugger',
        // userScripts 目前没用（js 工具走 debugger），列出来是为了让
        // "哪天改用 userScripts 却忘了声明"变成一条明确的失败
        userScripts: 'userScripts',
    };
    const declared = new Set(mf.permissions || []);
    for (const api of used) {
        const need = NEEDS[api];
        if (need && !declared.has(need)) {
            fails.push(`代码用了 chrome.${api} 但 manifest 没声明 "${need}" 权限`);
        }
    }

    /*
     * 发给球的每一条广播都必须带 `target: 'ball'`。
     *
     * 球的监听器按 `target === 'ball'` 过滤（它必须过滤 —— 否则 offscreen
     * 的流式增量也会被它当成嗅探结果）。漏掉这个字段时事件发得出去、球也
     * 收得到，但**被球自己丢掉**：表现为"打开嗅探开关后列表一直是空的，
     * 刷新页面才出现"。
     *
     * 这个 bug 真实存在过：SW 发的是 `{kind:'sniffed-media'}`，没有 target，
     * 而当时侧边栏的监听器不过滤 target —— 所以删掉侧边栏之前它一直没暴露。
     *
     * ## 为什么要跟一层调用
     *
     * SW 里不是内联字面量，而是 `notifyBall({...})`，函数体内才是
     * `sendMessage(event)`。只扫 `sendMessage({...})` 会一个都匹配不到 ——
     * 检查恒绿。变异测试抓到过这一点（去掉 target，4 项仍全过）。
     * 所以这里按**两种形态**分别扫：内联字面量 + notifyBall 的实参。
     */
    const collectBallBroadcasts = (file) => {
        const full = path.join(srcDir, file);
        if (!fs.existsSync(full)) return [];
        const src = stripComments(fs.readFileSync(full, 'utf8'));
        const found = [];
        // 形态一：sendMessage({ ... }) —— agent-bridge 用的是这种
        for (const m of src.matchAll(/sendMessage\(\s*\{([\s\S]*?)\}\s*\)/g)) {
            if (/kind:\s*'(sniffed-media|agent-snapshot|agent-delta)'/.test(m[1])) found.push(m[1]);
        }
        // 形态二：notifyBall({ ... }) —— service-worker 用的是这种
        for (const m of src.matchAll(/notifyBall\(\s*\{([\s\S]*?)\}\s*\)/g)) found.push(m[1]);
        return found;
    };

    const broadcasts = [
        ...collectBallBroadcasts(path.join('background', 'service-worker.ts')),
        ...collectBallBroadcasts(path.join('background', 'agent-bridge.ts')),
    ];
    if (broadcasts.length === 0) {
        fails.push('找不到任何发给球的广播 —— 检查失效了（球的实时更新全靠这几条）');
    }
    for (const body of broadcasts) {
        if (!/target:\s*'ball'/.test(body)) {
            fails.push(`球事件缺少 target:'ball'（球会丢弃它）：${body.trim().replace(/\s+/g, ' ').slice(0, 70)}`);
        }
    }

    // 反过来：声明了却没人用的权限，会在安装时吓退用户（"读取浏览记录"这类提示）
    const unused = [...declared].filter((perm) => {
        const api = Object.entries(NEEDS).find(([, v]) => v === perm);
        return api ? !used.has(api[0]) : false;
    });
    for (const perm of unused) {
        console.log(`  注意  "${perm}" 权限已声明但代码里没用到（安装提示会多一条）`);
    }

    if (fails.length) {
        console.log(`插件产物自检：通过 ${pass} 项，失败 ${fails.length} 项`);
        for (const f of fails) console.log(`  FAIL  ${f}`);
        return false;
    }
    console.log(`插件产物自检：通过 ${pass} 项，失败 0 项`);
    return true;
};

module.exports = { run };

// 单独执行（npm run ext:check / ext:build 末尾）时自跑一遍，
// 并打印**该加载哪个目录** —— 这一条是实际踩过的坑：
// 把 Chrome 指向 extension/（源码目录）会报"清单文件丢失或不可读取"，
// 因为 manifest.json 在 extension/public/ 下，只有构建才把它拷进 dist/。
if (require.main === module) {
    console.log('=== 插件产物自检 ===');
    const okAll = run();
    if (okAll) {
        console.log(`\n可加载目录：${DIST}`);
        console.log('（Chrome → chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选上面这个目录）');
        console.log('注意：不要选 extension/ —— 那是源码目录，里面没有 manifest.json。');
    }
    process.exitCode = okAll ? 0 : 1;
}
