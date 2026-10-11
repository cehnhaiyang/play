/*
 * 变异测试：把本次改动逐条改坏，确认新断言真的会红。
 * 每个变异体注入后立刻还原，最后逐字节校验。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const MAIN = path.join(ROOT, 'app', 'main', 'main.js');
const PRELOAD = path.join(ROOT, 'app', 'main', 'preload.js');
const PANEL = path.join(ROOT, 'app', 'renderer', 'components', 'AudioPanel.tsx');
const HOOK = path.join(ROOT, 'app', 'renderer', 'hooks', 'useAudio.ts');

const MUTANTS = [
    ['main: 初始目录退回项目根（不再指向 .spg）', MAIN,
        "path.join(app.getAppPath(), '.spg')", "path.join(app.getAppPath(), '.spg2')"],
    ['main: 不读文件内容，只返回路径', MAIN,
        'const content = await fs.promises.readFile(filePath, \'utf8\');', 'const content = \'\';'],
    ['main: 取消与失败合并（取消也当失败报错）', MAIN,
        "if (canceled || !filePaths.length) return { success: false, cancelled: true };",
        "if (canceled || !filePaths.length) return { success: false };"],
    ['main: 不弹系统文件框', MAIN,
        'const { canceled, filePaths } = win\n            ? await dialog.showOpenDialog(win, opts)\n            : await dialog.showOpenDialog(opts);',
        'const canceled = true, filePaths = [];'],
    ['main: spg-pick 不注册', MAIN,
        "ipcMain.handle('spg-pick', handleSpgPick);", ''],
    ['preload: 不暴露 spg.pick', PRELOAD,
        "pick: () => ipcRenderer.invoke('spg-pick'),", ''],
    ['panel: 导入按钮改回隐藏 input', PANEL,
        '<button onClick={handleFileImport}', '<button onClick={() => {}}'],
    ['panel: 迭代按钮改回隐藏 input', PANEL,
        'onClick={handleRefineImport}', 'onClick={() => {}}'],
    ['panel: 取件失败静默返回', PANEL,
        "        if (message) {\n            audioActions.setParserError({ message, line: 0 });\n            return null;\n        }",
        '        if (message) return null;'],
    ['panel: 迭代不走 refineSpg（当成导入）', PANEL,
        'await audioActions.refineSpg(source)', 'await audioActions.pickSpgSource()'],
    ['hook: 取消也当失败报错', HOOK,
        'if (res.cancelled) return {};', ''],
    ['hook: 桥未加载时静默返回', HOOK,
        "if (!api?.spg?.pick) return { message: '文件选择不可用：桥接未加载。' };",
        'if (!api?.spg?.pick) return {};'],
    ['hook: 内容缺失也当成成功（空源码进工程）', HOOK,
        "if (!res.success || typeof res.content !== 'string') {", 'if (!res.success) {'],
];

const read = (p) => fs.readFileSync(p, 'utf8');
const originals = new Map();
for (const [, file] of MUTANTS) if (!originals.has(file)) originals.set(file, read(file));

const restore = () => { for (const [p, s] of originals) fs.writeFileSync(p, s, 'utf8'); };

const runSuite = () => {
    try {
        const out = execFileSync('npm', ['run', 'test'], {
            cwd: path.join(ROOT, 'test'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { out, failed: false };
    } catch (e) {
        return { out: `${e.stdout || ''}${e.stderr || ''}`, failed: true };
    }
};

const results = [];
for (const [name, file, from, to] of MUTANTS) {
    restore();
    const src = read(file);
    const n = src.split(from).length - 1;
    if (n !== 1) {
        results.push([name, `ANCHOR-MISS(${n})`]);
        continue;
    }
    fs.writeFileSync(file, src.replace(from, () => to), 'utf8');
    const { out, failed } = runSuite();
    // tsc 失败会让用例一行都不跑（stdio: inherit 的输出不进捕获），
    // 这种红不是断言抓住的，必须单独记
    const ran = /通过 \d+ 项/.test(out);
    if (!ran && failed) results.push([name, 'COMPILE-ONLY']);
    else results.push([name, failed ? 'CAUGHT' : 'SURVIVED']);
}
restore();

// 逐字节校验还原
let dirty = 0;
for (const [p, s] of originals) if (read(p) !== s) { console.log('NOT RESTORED:', p); dirty++; }
console.log(dirty ? 'RESTORE FAILED' : '所有源文件已逐字节还原');
for (const [name, verdict] of results) console.log(verdict.padEnd(14), name);
const survived = results.filter(([, v]) => v === 'SURVIVED');
console.log(`\n${results.length - survived.length}/${results.length} 非 SURVIVED`);
