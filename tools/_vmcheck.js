// 一次性：量 vm.Script 的语法错误形状，决定 checkjs 回传什么。跑完即删。
const vm = require('node:vm');

const show = (label, src) => {
    try {
        new vm.Script(src, { filename: 'out/a.js' });
        console.log(`--- ${label}: OK`);
    } catch (e) {
        console.log(`--- ${label}: name=${e.name}`);
        console.log(`message=${JSON.stringify(e.message)}`);
        console.log('stack=<<<');
        console.log(String(e.stack).split('\n').slice(0, 8).join('\n'));
        console.log('>>>');
    }
};

show('语法错', 'const a = 1;\nfunction f( {\n  return a\n}\n');
show('ESM import', 'import fs from "fs";\nfs.readFileSync("x");\n');
show('ESM export', 'export const a = 1;\n');
show('顶层 await', 'const r = await fetch("http://x");\nconsole.log(r);\n');
show('正常', 'const a = 1;\nconsole.log(a);\n');
process.exit(0);
