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
     * content_scripts 必须**不存在**。
     *
     * 悬浮球已经从"每个标签页注入一份"改成 Electron 独立窗口（见
     * app/main/orbs.js 讲清了为什么 —— Chrome 的窗口最小 136×80、标题栏固定
     * 吃掉 39px、且不能置顶，插件里做不出球）。
     *
     * 留着 content_scripts 的后果不是"多注入一份没用"，而是**每个页面都会被
     * 注入一个几百 KB 的脚本**，且那个脚本里已经没有界面了 —— 纯浪费，
     * 还会让用户以为球坏了（页面上什么都没有）。
     *
     * 同样要检查产物里没有 content.js：构建配置里 input 加回去就会重新产出。
     */
    if (Array.isArray(mf.content_scripts) && mf.content_scripts.length > 0) {
        fails.push('manifest 里还有 content_scripts —— 球已改成 Electron 窗口，不再往页面注入');
    }
    if (fs.existsSync(path.join(DIST, 'content.js'))) {
        fails.push('产物里还有 content.js —— 球已改成 Electron 窗口，它不该被构建出来');
    }

    /*
     * nativeMessaging 权限必须声明。
     *
     * 悬浮球跑在 Electron 里，拿不到 `chrome.*`，它要的一切都只能经
     * native messaging 问过来。少这条权限的表现是 `connectNative` 直接抛，
     * 而球上显示的是"插件未连接" —— 与"应用没开"完全一样的提示，
     * 从界面上分不出是哪种。
     */
    if (!(mf.permissions || []).includes('nativeMessaging')) {
        fails.push('manifest 没声明 nativeMessaging —— 悬浮球无法连接本机应用');
    }

    /*
     * `key` 必须存在。
     *
     * native messaging 的 host manifest 里写死了 `allowed_origins`，形如
     * `chrome-extension://<id>/`。而未打包扩展的 id 是**由加载路径哈希出来的**
     * —— 换目录、换机器就变，host manifest 立刻失效，报的却是
     * "Specified native messaging host not found"，与真正的原因毫无关系。
     * 写死 `key` 之后 id 只由密钥决定。
     */
    if (!mf.key || typeof mf.key !== 'string' || mf.key.length < 100) {
        fails.push('manifest 缺少 key —— 扩展 id 会随加载路径变化，native messaging 的 allowed_origins 会失效');
    }

    /*
     * host manifest 的 allowed_origins 必须与 manifest 的 key 推出同一个 id。
     *
     * 这是**跨文件**的一致性：改 key 却忘了改 host manifest，报的是一句
     * 与原因无关的 "host not found"。这里按 Chrome 的算法重算一遍 id 再比。
     */
    const hostManifestPath = path.join(ROOT, 'extension', 'host', 'com.theplay.host.json');
    if (fs.existsSync(hostManifestPath)) {
        if (mf.key) {
            const hash = require('crypto').createHash('sha256')
                .update(Buffer.from(mf.key, 'base64')).digest().subarray(0, 16);
            let id = '';
            for (const byte of hash) {
                id += String.fromCharCode(97 + (byte >> 4));
                id += String.fromCharCode(97 + (byte & 0x0f));
            }
            const hostMf = JSON.parse(fs.readFileSync(hostManifestPath, 'utf8'));
            const origins = hostMf.allowed_origins || [];
            if (!origins.includes(`chrome-extension://${id}/`)) {
                fails.push(`host manifest 的 allowed_origins 与 manifest.key 推出的 id 不符。`
                    + `实际 id 是 ${id}，allowed_origins 是 ${JSON.stringify(origins)}`);
            }
        }
    } else {
        fails.push('extension/host/com.theplay.host.json 不存在 —— native messaging 装不上');
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
     * 已删除的界面产物必须**不存在**。
     *
     * 主构建的 emptyOutDir 会清掉它们 —— 但如果哪天有人把 panel 加回 vite 的
     * input，产物里就会重新出现一份没人加载的界面。那种残留不会报错，
     * 只会让下一个读代码的人以为侧边栏还在。
     */
    for (const stale of ['panel.html', 'panel.js']) {
        if (fs.existsSync(path.join(DIST, stale))) {
            fails.push(`产物里还有 ${stale} —— 侧边栏已删除，它不该被构建出来`);
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
     * 产物内部的相对引用必须落得到磁盘上。
     *
     * 打包器会把共享模块拆成 `chunks/*.js`（AiService 就是一个），入口里因此留下
     * `import{…}from"./chunks/AiService-xxxx.js"`。那个文件缺失时 Chrome 报的还是
     * 同一句"清单文件丢失或不可读取"，看不出缺的是哪一个 —— 而它只在**跑起来那一刻**
     * 才暴露（service worker 加载失败 = 插件整个不工作）。
     * 上面那几条只校验了 manifest 直接声明的文件，够不到入口内部的引用。
     */
    for (const file of walk(DIST).filter((f) => f.endsWith('.js'))) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
            if (!fs.existsSync(path.resolve(path.dirname(file), m[1]))) {
                fails.push(`${path.relative(DIST, file)} 引用了 ${m[1]}，但产物里没有这个文件`);
            }
        }
    }

    /*
     * 推给悬浮球的每一条事件都必须过桥，而且**只能**过桥。
     *
     * ## 这一条为什么必须存在
     *
     * 球跑在 Electron 窗口里（不是 content script），它没有 `chrome.runtime`，
     * 收不到扩展内的广播。所以每一次"给球推数据"都必须走 `emitBridgeEvent`。
     * 漏掉的表现是：
     *
     *   · 球能连上、能取到初始快照；
     *   · 但**之后再也不会更新** —— 嗅探出新地址列表不动、模型回复逐字
     *     输出时界面一直空着。
     *
     * 这种"能连上但不动"最难查：连接是好的，请求也是好的，只有推送断了。
     *
     * ## 两个方向都要查
     *
     *  1. **该推的都在推**：BALL_KINDS 里每一个都必须有 emitBridgeEvent 调用点。
     *  2. **没有第二份**：SW 侧不许再出现 `target: 'ball'` 的
     *     `chrome.runtime` 广播 —— 曾经每条快照都多发一遍，收件人根本不存在，
     *     代价是每推一版就把 1MB 量级的 JSON 克隆一次。
     *
     * 扩展内部另有一条通道（offscreen 的 `ai-*` 发给 SW 里的 chat-port），
     * 它的 `target` 是 `'chat'`，与球无关，不在这一条的范围内。
     */
    const BALL_KINDS = ['sniffed-media', 'tabs-changed', 'agent-snapshot', 'agent-delta'];
    const swSide = ['background/service-worker.ts', 'background/agent-bridge.ts'];
    for (const kind of BALL_KINDS) {
        const pushed = swSide.some((file) => {
            const full = path.join(srcDir, file);
            if (!fs.existsSync(full)) return false;
            return new RegExp(`emitBridgeEvent\\(\\s*'${kind}'`).test(stripComments(fs.readFileSync(full, 'utf8')));
        });
        if (!pushed) {
            fails.push(`没有任何地方 emitBridgeEvent('${kind}') —— 球永远收不到这个事件，界面会停在初始状态`);
        }
    }
    for (const file of swSide) {
        const full = path.join(srcDir, file);
        if (!fs.existsSync(full)) continue;
        const src = stripComments(fs.readFileSync(full, 'utf8'));
        if (/target:\s*'ball'/.test(src)) {
            fails.push(`${file} 里又出现了 target: 'ball' 的 chrome.runtime 广播 ——`
                + '球在 Electron 窗口里，那条消息没有收件人，只是白白克隆一遍大对象');
        }
    }

    /*
     * 宿主推事件用的 target 必须与收件人认领的那个字符串**逐字相同**。
     *
     * 两端各写一个字面量，拼错一个字母的表现是"调用发出去了、回执也收到了，
     * 然后界面永远停在正在思考" —— 增量与终局都发进虚空，没有报错。
     * 这条检查存在的理由与上面那条一样：能连上但不动，最难查。
     */
    const hostSrc = fs.readFileSync(path.join(srcDir, 'offscreen', 'host.ts'), 'utf8');
    const portSrc = fs.readFileSync(path.join(srcDir, 'background', 'chat-port.ts'), 'utf8');
    const sendTarget = (hostSrc.match(/target:\s*'([a-z-]+)',\s*\n\s*kind:\s*'ai-delta'/) || [])[1];
    const listenTarget = (portSrc.match(/target\s*!==\s*'([a-z-]+)'/) || [])[1];
    if (!sendTarget || !listenTarget) {
        fails.push('找不到宿主 ai-delta 的 target 或 chat-port 的认领判据 —— 这条检查的正则已失配');
    } else if (sendTarget !== listenTarget) {
        fails.push(`宿主把 ai-delta 发到 target '${sendTarget}'，而 chat-port 只认 '${listenTarget}' ——`
            + '增量与终局会全部落进虚空，界面永远停在"正在思考"且不报错');
    }
    if (sendTarget === 'ball') {
        fails.push('宿主的 ai-* 事件又用 target: \'ball\' 了 —— 球在 Electron 窗口里收不到这条，'
            + '真正的收件人是 SW 里的 chat-port');
    }

    /*
     * 反方向：球那一侧订阅的事件名必须是插件真的会推的。
     *
     * 拼错一个字母的表现与"忘了过桥"完全一样：界面永远不更新，且不报错。
     */
    const orbClient = path.join(ROOT, 'app', 'orb', 'orb-kit.tsx');
    if (fs.existsSync(orbClient)) {
        const clientSrc = fs.readFileSync(orbClient, 'utf8');
        const declared = clientSrc.slice(clientSrc.indexOf('export type BridgeEventName'));
        const names = [...declared.slice(0, declared.indexOf(';')).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
        for (const name of names) {
            if (!BALL_KINDS.includes(name)) {
                fails.push(`球的 BridgeEventName 里声明了 '${name}'，但插件从不推这个事件`);
            }
        }
        for (const kind of BALL_KINDS) {
            if (!names.includes(kind)) {
                fails.push(`插件会推 '${kind}'，但球的 BridgeEventName 里没有它 —— 球会把它丢掉`);
            }
        }
    }

    /*
     * 篡改规则的三个出口必须各司其职，且 Agent 那一口必须真的注入。
     *
     * `applyRules` 只改内存 + 注入（工具层，不落盘），`saveRules` 落盘 + 注入
     * （面板「应用更改」）。两条都只差一行，而差别是"模型能永久改掉浏览器行为"
     * —— 那正是要挡的事。这里钉住：SW 的 tamper-set 走 saveRules，page-host
     * 的 tamper.applyRules 走 applyRules 且把 tabId 传下去。
     *
     * 后半条尤其容易漏：不传 tabId 时规则进了内存却没进页面，工具回"已生效"
     * 而页面还在跑旧规则 —— 没有报错，只有"改了没反应"。
     */
    const pageHostSrc = stripComments(fs.readFileSync(path.join(srcDir, 'offscreen', 'page-host.ts'), 'utf8'));
    const applyCall = pageHostSrc.match(/return applyRules\([\s\S]*?\);/);
    if (!applyCall) {
        fails.push('offscreen/page-host.ts 的 tamper.applyRules 没有转调 tamper.ts 的 applyRules');
    } else if (!/tab\?\.id/.test(applyCall[0])) {
        fails.push('page-host 的 tamper.applyRules 没把当前标签页传给 applyRules ——'
            + '规则只会进内存，页面里不会生效，而工具会回"已生效"');
    }
    if (/saveRules/.test(pageHostSrc)) {
        fails.push('page-host 调了 saveRules —— 模型改规则不得落盘，那是面板「应用更改」的事');
    }
    const swSrc2 = stripComments(fs.readFileSync(path.join(srcDir, 'background', 'service-worker.ts'), 'utf8'));
    if (!/case 'tamper-set'[\s\S]{0,800}?await saveRules\(/.test(swSrc2)) {
        fails.push("service-worker 的 tamper-set 没有走 saveRules —— 面板点「应用更改」不会落盘");
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
