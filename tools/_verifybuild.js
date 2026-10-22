/**
 * 一次性：核对构建产物里真的有这一轮加的东西（源码里有不等于打包后有 ——
 * 宏、压缩、tree-shaking 都可能把它去掉）。用完即删。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const orbDir = path.join(root, 'dist', 'assets', 'orb');
const sw = path.join(root, 'extension', 'dist', 'service-worker.js');

const orbFiles = fs.readdirSync(orbDir).filter((f) => f.startsWith('agent-'));
console.log('球窗口产物：', orbFiles.join(', '));
const orb = orbFiles.map((f) => fs.readFileSync(path.join(orbDir, f), 'utf8')).join('\n');
const worker = fs.readFileSync(sw, 'utf8');

const report = (label, text, needles) => {
    console.log(`\n--- ${label} ---`);
    for (const needle of needles) {
        const at = text.indexOf(needle);
        console.log(`${at >= 0 ? '有' : '没有'}  ${needle}${at >= 0 ? `   …${text.slice(Math.max(0, at - 30), at + 40)}…` : ''}`);
    }
};

report('球窗口（app/orb/agent.tsx）', orb, [
    'switch-session', 'new-session', 'rename-session', 'delete-session', '会话名（留空则用第一条提问）',
]);
report('插件 service-worker', worker, [
    'agent-sessions', 'agent-messages', 'new-session', 'switch-session', 'rename-session', 'delete-session',
]);
