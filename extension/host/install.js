'use strict';

/**
 * 把 native messaging host 注册到 Chrome。
 *
 * ## 为什么要写注册表
 *
 * Chrome 不扫描目录找 host —— 它只认注册表里那一个键：
 *
 *     HKCU\Software\Google\Chrome\NativeMessagingHosts\com.theplay.host
 *       (默认值) = host manifest 的**绝对路径**
 *
 * 用 HKCU 而不是 HKLM：不需要管理员权限。这也是阶段 0 能删掉提权要求的原因。
 *
 * ## 为什么要写绝对路径
 *
 * manifest 里的 `path` 必须是**绝对路径**，且不能带 `~`、不能用相对路径。
 * 写错的表现是 `connectNative` 报 "Specified native messaging host not found"，
 * 而那句话与"路径写错"看不出关系。所以这里在安装时把绝对路径填进去，
 * 而不是把仓库路径写死在 json 里 —— 换个目录 clone 就失效了。
 *
 * 跑法：node extension/host/install.js
 * 卸载：node extension/host/install.js --uninstall
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HERE = __dirname;
const HOST_NAME = 'com.theplay.host';
const HOST_SCRIPT = path.join(HERE, 'host.js');
const TEMPLATE = path.join(HERE, 'com.theplay.host.json');

/** 注册表键路径。Chrome 与 Edge 各有一份，这里只注册 Chrome */
const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;

/** 生成的 manifest 落在用户目录，不落在仓库里 —— 它含本机绝对路径 */
const INSTALLED_MANIFEST = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'the-play',
    `${HOST_NAME}.json`,
);

const uninstall = () => {
    try {
        execFileSync('reg', ['delete', REG_KEY, '/f'], { stdio: 'pipe' });
        console.log(`已删除注册表项：${REG_KEY}`);
    } catch {
        console.log(`注册表项本来就不存在：${REG_KEY}`);
    }
    try {
        fs.rmSync(INSTALLED_MANIFEST, { force: true });
        console.log(`已删除 manifest：${INSTALLED_MANIFEST}`);
    } catch {
        // 本来就不在
    }
};

const install = () => {
    if (!fs.existsSync(HOST_SCRIPT)) {
        throw new Error(`host 脚本不存在：${HOST_SCRIPT}`);
    }

    /*
     * 用 node 跑 host.js 还是直接跑 host.js？
     *
     * manifest 的 `path` 只能指向一个可执行文件，**不能带参数**。
     * 所以不能写 "node host.js"。两个选择：
     *   · path 指向 node.exe，靠 .js 的 shebang —— Windows 不认 shebang；
     *   · 写一个 .bat 包一层 —— 但 Chrome 起 .bat 会闪一个控制台窗口。
     *
     * 这里选第三个：manifest 指向 node.exe 做不到（它需要脚本参数），
     * 所以生成一个**只含一行的 .cmd 包装**，且用 `start /b` 之类都不需要 ——
     * Chrome 起子进程时本来就隐藏窗口（stdio 是管道，没有控制台）。
     *
     * 实测确认：Chrome 从 native messaging 拉起 .cmd 时不弹控制台窗口，
     * 因为进程的 stdio 全部被重定向到管道。
     */
    const nodeExe = process.execPath;
    const wrapper = path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'the-play',
        `${HOST_NAME}.cmd`,
    );
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, `@echo off\r\n"${nodeExe}" "${HOST_SCRIPT}" %*\r\n`, 'utf8');

    const manifest = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
    manifest.path = wrapper;
    fs.writeFileSync(INSTALLED_MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');

    execFileSync('reg', ['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', INSTALLED_MANIFEST, '/f'], {
        stdio: 'pipe',
    });

    console.log('已注册 native messaging host：');
    console.log(`  host 名      ${HOST_NAME}`);
    console.log(`  注册表       ${REG_KEY}`);
    console.log(`  manifest     ${INSTALLED_MANIFEST}`);
    console.log(`  启动命令     ${wrapper}`);
    console.log(`  脚本         ${HOST_SCRIPT}`);
    console.log('');
    console.log('重启浏览器后生效。');
};

try {
    if (process.argv.includes('--uninstall')) uninstall();
    else install();
} catch (e) {
    console.error(`失败：${e && e.message}`);
    process.exitCode = 1;
}
