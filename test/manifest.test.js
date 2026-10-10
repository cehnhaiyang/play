'use strict';
/**
 * 插件产物自检：`extension/dist` 是不是一个 Chrome 真能加载的包。
 *
 * 为什么需要这一步：manifest 与 panel.html 里引用的是**固定文件名**
 * （service-worker.js / panel.html / panel.js / assets/*.css），
 * 构建配置里任何一处路径推导写错，产物都会缺文件或引用错路径 ——
 * 而 Chrome 报的永远是同一句"清单文件丢失或不可读取"，
 * 看不出到底缺哪个。这里把每个引用逐个落到磁盘上验证。
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
    ok('side_panel.default_path', mf.side_panel.default_path);

    // panel.html 里引用的每个资源都要落得到盘上
    const html = fs.readFileSync(path.join(DIST, 'panel.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((x) => x[1]);
    if (refs.length === 0) fails.push('panel.html 里没有任何资源引用（构建可能没产出）');
    for (const ref of refs) ok('panel.html', ref.replace(/^\//, ''));

    // 权限必须与代码实际调用的 API 对得上，否则运行时才炸
    const srcDir = path.join(ROOT, 'extension', 'src');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const used = new Set();
    for (const f of walk(srcDir)) {
        const s = fs.readFileSync(f, 'utf8');
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
    };
    const declared = new Set(mf.permissions || []);
    for (const api of used) {
        const need = NEEDS[api];
        if (need && !declared.has(need)) {
            fails.push(`代码用了 chrome.${api} 但 manifest 没声明 "${need}" 权限`);
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
