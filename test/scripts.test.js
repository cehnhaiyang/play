'use strict';
/**
 * 开发脚本自检：项目根的 .ps1 / .bat 是不是还能跑。
 *
 * ## 为什么需要这一套
 *
 * `.ps1` 是**唯一一个"坏了不会有人立刻发现"的文件** —— 它不进构建、
 * 不被 tsc 检查、也没有任何代码 import 它。改坏了只有下次手动双击才发现，
 * 而那时距离改动可能已经过了很久。
 *
 * 已经踩过两次，两次的症状都指向错误的方向：
 *
 *   1. **丢了 BOM**。本机控制台是 CP936，而 PowerShell 5.1 读**无 BOM** 的
 *      UTF-8 脚本时按 ANSI 解码，中文变乱码。报的却是
 *      "字符串缺少终止符" / "必须在 % 运算符后面提供值表达式" ——
 *      看起来像引号写错了或 `%~dp0` 有问题，与编码毫无关系。
 *      实测：任何编辑器保存时丢掉 BOM 都会触发（本项目的 edit 工具就会）。
 *
 *   2. **消息里内嵌半角双引号**。`"…显示"插件未连接"…"` 会让字符串在
 *      第二个引号处**提前结束**，且不报语法错 —— 界面上只显示前半句，
 *      看起来像消息本来就这么短。
 *
 * 这两条都只能靠断言挡住，靠人眼读是读不出来的。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PS1 = path.join(ROOT, '.ps1');
const BAT = path.join(ROOT, '.bat');

let pass = 0;
const fails = [];
const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { fails.push({ name, message: e.message }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };

/** UTF-8 BOM 的三个字节 */
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

const run = () => {
    pass = 0;
    fails.length = 0;

    if (!fs.existsSync(PS1)) {
        console.log('开发脚本自检：.ps1 不存在，跳过');
        return true;
    }

    const bytes = fs.readFileSync(PS1);
    const text = fs.readFileSync(PS1, 'utf8');

    /* ====================================================================== */
    /* 1. 编码：必须带 UTF-8 BOM                                               */
    /* ====================================================================== */

    check('.ps1 带 UTF-8 BOM', () => {
        assert(bytes.subarray(0, 3).equals(BOM),
            '缺 UTF-8 BOM。PowerShell 5.1 会按系统 ANSI（本机 CP936）解码本文件，'
            + '中文变乱码并导致语法错误 —— 报的却是"字符串缺少终止符"，看不出是编码问题。'
            + '修复：[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding $true))');
    });

    check('.ps1 是合法 UTF-8（没有替换字符）', () => {
        assert(!text.includes('\uFFFD'),
            '文件里有 U+FFFD 替换字符 —— 某一环用非 UTF-8 读写过它，中文已经损坏。');
    });

    /* ====================================================================== */
    /* 2. 消息里的引号：内嵌半角双引号会截断字符串                              */
    /* ====================================================================== */

    /**
     * 检查一行 Write-* 调用的消息参数是否被内嵌引号截断。
     *
     * ## 为什么不能只数引号个数
     *
     * 第一版用的是"一行里双引号个数为奇数就算错"。实测**漏掉了真正的坏写法**：
     *
     *     Write-Info "前缀"插入""
     *
     * 这一行有 4 个引号（偶数），却是坏的 —— PowerShell 把它解析成
     * **三个**参数（字符串"前缀"、裸词 插入、空字符串），而 `[string]$Msg`
     * 只接第一个，后两个静默丢掉。界面上显示"前缀"，看起来像消息本来就这么短。
     *
     * 更麻烦的是 PowerShell 自己的解析器也**不报错**（语法合法），
     * 所以不能靠"解析失败"来发现它。
     *
     * ## 判据
     *
     * 第一个参数必须是**一个完整的引号串**，紧跟着它的下一个非空字符只能是
     * 语句的收尾或具名参数的开头：
     *
     *     -  具名参数（-ForegroundColor）
     *     }  语句块结束
     *     ;  语句分隔
     *     |  管道
     *     )  括号结束
     *
     * 是别的字符（比如中文）就说明字符串在那里被截断了。
     */
    const messageArgIsIntact = (line) => {
        const m = line.match(/Write-(?:Info|Ok|Err|Step)\b(.*)$/);
        if (!m) return true;
        const rest = m[1];

        let i = 0;
        while (i < rest.length && /\s/.test(rest[i])) i += 1;
        if (i >= rest.length) return true;
        const open = rest[i];
        if (open !== '"' && open !== "'") return true; // 非常量消息（拼接、变量），不判

        // 扫到该引号串结束
        let j = i + 1;
        while (j < rest.length) {
            const ch = rest[j];
            if (ch === '`') { j += 2; continue; }
            if (ch === open) {
                if (rest[j + 1] === open) { j += 2; continue; } // "" / '' 是转义
                break;
            }
            j += 1;
        }
        if (j >= rest.length) return true; // 引号没闭合，交给别的检查

        // 看紧跟其后的第一个非空字符
        let k = j + 1;
        while (k < rest.length && /\s/.test(rest[k])) k += 1;
        if (k >= rest.length) return true;

        return '-};|)'.includes(rest[k]);
    };

    check('.ps1 的 Write-* 消息没有被内嵌引号截断', () => {
        const bad = [];
        const lines = text.split(/\r?\n/);
        for (const [i, line] of lines.entries()) {
            if (!/Write-(?:Info|Ok|Err|Step)\b/.test(line)) continue;
            // 跳过函数定义本身：那行里的 Write-Host 是函数体，不是调用
            if (/function\s+Write-/.test(line)) continue;
            if (!messageArgIsIntact(line)) bad.push(i + 1);
        }
        assert(bad.length === 0,
            `这些行的消息参数被截断了：第 ${bad.join('、')} 行。`
            + '内嵌的半角双引号会让字符串提前结束，只显示前半句且不报错。'
            + '消息里要引用请用「」而不是半角双引号。');
    });

    /* ====================================================================== */
    /* 3. 菜单与 package.json 的对应关系                                        */
    /* ====================================================================== */

    check('.ps1 引用的 npm script 都真实存在', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const scripts = pkg.scripts || {};
        const missing = [];
        // 形如 Invoke-Npm -NpmArgs @('run', 'xxx') 与 & npm.cmd run xxx
        for (const m of text.matchAll(/NpmArgs\s+@\(\s*'run'\s*,\s*'([^']+)'\s*\)/g)) {
            if (!(m[1] in scripts)) missing.push(m[1]);
        }
        for (const m of text.matchAll(/npm\.cmd\s+run\s+([a-zA-Z0-9:_-]+)/g)) {
            if (!(m[1] in scripts)) missing.push(m[1]);
        }
        assert(missing.length === 0,
            `这些 npm script 在 package.json 里不存在：${[...new Set(missing)].join('、')}。`
            + '脚本里写着但实际没有，用户点了只会看到一句 npm 报错。');
    });

    /* ====================================================================== */
    /* 4. .bat 与 .ps1 的配合                                                  */
    /* ====================================================================== */

    if (fs.existsSync(BAT)) {
        const bat = fs.readFileSync(BAT, 'utf8');

        check('.bat 以 UTF-8 读入 .ps1 再执行', () => {
            /*
             * 为什么必须这样读：.bat 交给 powershell.exe 时，若直接
             * `powershell -File .ps1`，5.1 会按 ANSI 解码那个无 BOM 的文件。
             * 现在 .ps1 有 BOM 了，两种方式都能跑 —— 但这条写法要留着：
             * 它对 BOM 的依赖更小，且是实际验证过能跑的那条路。
             */
            assert(/ReadAllText\([^)]*Encoding\]::UTF8/.test(bat),
                '.bat 没有以 UTF-8 读入 .ps1。中文会按 ANSI 解码而乱码。');
            assert(/Scriptblock\]::Create/.test(bat),
                '.bat 没有用 Scriptblock::Create 执行读到的内容。');
        });

        check('.bat 先切到自身所在目录', () => {
            // .ps1 里 $PSScriptRoot 为空时要靠这个兜底定位项目根
            assert(/cd\s+\/d\s+"%~dp0"/.test(bat),
                '.bat 没有 cd /d "%~dp0"。经它启动时 .ps1 的 $PSScriptRoot 为空，'
                + '会退到"当前目录"，而当前目录可能是任何地方。');
        });

        check('.bat 设了 UTF-8 代码页', () => {
            assert(/chcp\s+65001/.test(bat),
                '.bat 没有 chcp 65001，中文输出会乱码。');
        });
    }

    /* ====================================================================== */
    /* 5. 本机桥：菜单里得有注册入口，且与 install.js 的 host 名一致            */
    /* ====================================================================== */

    check('.ps1 里的 host 名与 install.js 一致', () => {
        const install = path.join(ROOT, 'extension', 'host', 'install.js');
        if (!fs.existsSync(install)) return;
        const src = fs.readFileSync(install, 'utf8');
        const m = src.match(/HOST_NAME\s*=\s*'([^']+)'/);
        assert(m, 'install.js 里找不到 HOST_NAME');
        assert(text.includes(m[1]),
            `.ps1 里没有出现 host 名 ${m[1]} —— 两处不一致时 connectNative 会报`
            + '"Specified native messaging host not found"，与真正的原因无关。');
    });

    check('.ps1 提供 host:install 的菜单入口', () => {
        assert(/host:install/.test(text),
            '.ps1 没有调用 host:install —— 用户装完依赖却不知道还要注册本机桥，'
            + '球会一直显示「插件未连接」。');
    });

    if (fails.length > 0) {
        console.log(`开发脚本自检：通过 ${pass} 项，失败 ${fails.length} 项`);
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
        return false;
    }
    console.log(`开发脚本自检：通过 ${pass} 项，失败 0 项`);
    return true;
};

module.exports = { run };
