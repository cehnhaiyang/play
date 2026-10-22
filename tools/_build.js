/**
 * 一次性：构建插件（extension）+ 重建球窗口（应用 dist）。
 *
 * 等价于 `npm run ext:build` 加 `npm run build`，但在这里起（本会话没有 shell）。
 * 产物落进仓库既有的 dist/（gitignore 里的），跑完即删本脚本。
 */
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const run = (label, args) => {
    console.log(`\n===== ${label} =====`);
    execFileSync(process.execPath, args, { stdio: 'inherit', cwd: root });
};

try {
    run('插件 vite build', [vite, 'build', '--config', 'extension/vite.config.mts']);
    run('插件产物自检', [path.join(root, 'test', 'manifest.test.js')]);
    run('应用 vite build（球窗口）', [vite, 'build']);
    console.log('\n构建完成。');
} catch (e) {
    console.log(`\n构建失败：${e && e.message ? e.message : e}`);
    process.exitCode = 1;
}
