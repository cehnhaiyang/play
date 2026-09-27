// 回归验证：syncAcgmhoProxy 必须真的把代理配上，而不是被吞掉的错误清成直连。
// 用真实的 main.js（electron 用递归 no-op 代理 stub，不建窗口）。
//
// 隔离性：stub 的 app.getPath('userData') 指向本脚本自建的临时目录，
// 并预先写入一份 settings.json。这样既不读用户真实配置，又完整走了
// settings.js 的真实读盘路径。
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'electron');

// 端口从命令行取，默认 10808
const PORT = (process.argv[2] || '10808').replace(/\D/g, '') || '10808';

// 临时 userData：settings.js 首次调用 getPath 时缓存路径，所以必须先建好
const fakeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'theplay-proxy-sync-'));
fs.writeFileSync(
    path.join(fakeUserData, 'settings.json'),
    JSON.stringify({ proxyPort: `127.0.0.1:${PORT}` }, null, 2),
    'utf8'
);

const src = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8');

function noopProxy(overrides = {}) {
    const cache = new Map();
    const target = Object.assign(function () { }, overrides);
    return new Proxy(target, {
        get(t, prop) {
            if (prop in t) return t[prop];
            if (typeof prop === 'symbol') return undefined;
            if (!cache.has(prop)) cache.set(prop, noopProxy());
            return cache.get(prop);
        },
        apply() { return noopProxy(); },
    });
}

const fakeElectron = noopProxy({
    app: noopProxy({
        whenReady: () => new Promise(() => { }),   // 不建窗口
        getPath: () => fakeUserData,
        isPackaged: false,
    }),
    session: noopProxy({
        defaultSession: noopProxy({
            getUserAgent: () => 'stub-UA',
            setProxy: async () => { },
            resolveProxy: async () => 'DIRECT',
        }),
    }),
});

const customRequire = (id) => {
    if (id === 'electron') return fakeElectron;
    if (id.startsWith('.')) return require(path.join(electronDir, id));
    return require(id);
};

// settings.js 内部自己 require('electron')，不经过上面的 customRequire。
// 纯 Node 下 require('electron') 得到的是"electron 可执行文件路径"字符串，
// 解构出的 app 是 undefined → settings.js 回落到 os.tmpdir() 的默认目录，
// 于是读不到我们写的配置。这里把 stub 塞进 require 缓存，让嵌套 require 也命中。
try {
    const electronId = require.resolve('electron');
    require.cache[electronId] = {
        id: electronId,
        filename: electronId,
        loaded: true,
        exports: fakeElectron,
    };
} catch (_e) {
    console.log('警告：无法注入 electron stub 到 require 缓存');
}

const factory = new Function('require', '__dirname', '__filename', 'module',
    `${src}\nreturn { syncAcgmhoProxy, setProxy, getProxy, getProxyProtocol, setUserAgent, getUserAgent };`);
const api = factory(customRequire, electronDir, path.join(electronDir, 'main.js'), { exports: {} });

(async () => {
    let failures = 0;
    const check = (name, pass, detail) => {
        if (!pass) failures++;
        console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    };

    const configured = require(path.join(electronDir, 'settings.js')).getSettings().proxyPort;
    console.log(`settings.proxyPort = ${JSON.stringify(configured)}`);
    console.log(`临时 userData      = ${fakeUserData}\n`);

    await api.syncAcgmhoProxy();
    const applied = api.getProxy() || '';
    const protocol = api.getProxyProtocol() || '';
    console.log(`syncAcgmhoProxy 之后: getProxy()=${JSON.stringify(applied)} protocol=${JSON.stringify(protocol)}\n`);

    check('syncAcgmhoProxy 后代理仍生效（未被错误清成直连）',
        Boolean(applied), `applied=${JSON.stringify(applied)}`);
    check('协议识别为 socks5', protocol === 'socks5', `protocol=${protocol}`);
    check('界面不会显示「端口连不上」', !(configured && !applied), `isConfiguredButDead=${Boolean(configured) && !applied}`);

    // UA wrapper 行为。用 try 包住：wrapper 里若出现未定义引用（正是本回归的成因），
    // 应当报成一条 FAIL 而不是让整个脚本崩掉——崩掉会掩盖前面的结论。
    console.log('');
    const attempt = (fn) => {
        try { return { ok: true, value: fn() }; }
        catch (e) { return { ok: false, error: e }; }
    };
    const first = attempt(() => api.setUserAgent('UA-A'));
    const second = attempt(() => api.setUserAgent('UA-A'));
    const third = attempt(() => api.setUserAgent('UA-B'));
    const readBack = attempt(() => api.getUserAgent());

    check('setUserAgent 不抛错（无未定义引用）',
        first.ok && second.ok && third.ok,
        first.ok ? '' : `${first.error.name}: ${first.error.message}`);
    check('setUserAgent 首次返回 true', first.ok && first.value === true);
    check('setUserAgent 相同值去重返回 false', second.ok && second.value === false);
    check('setUserAgent 变化后返回 true', third.ok && third.value === true);
    check('getUserAgent 回读正确', readBack.ok && readBack.value === 'UA-B',
        readBack.ok ? String(readBack.value) : `${readBack.error.name}: ${readBack.error.message}`);

    try { fs.rmSync(fakeUserData, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
    process.exit(failures === 0 ? 0 : 1);
})();
