'use strict';
/**
 * 变异校验（**可选的手工工具，不在 index.js 里**）。
 *
 * 用途：把 useBrowse.ts 复制一份、逐条改坏，确认 sniffer.test.js 真的会失败。
 * 断言"存在某段代码"是弱断言 —— 代码还在但行为变了，弱断言照样绿。
 * 这个脚本回答的是"我的断言有没有牙"。
 *
 * 用法（在 test/ 目录下）：node .mutate-check.js
 *
 * **绝不 require index.js**：那会重复触发整套编译与全部用例。
 * 它只 spawn sniffer.test.js 自己，且 sniffer.test.js 不 spawn 任何东西 ——
 * 不构成进程自我复制（本项目的蓝屏事故正是那样来的）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'hooks', 'useBrowse.ts');
const COPY = path.join(__dirname, '.mutant-browse.ts');

const original = fs.readFileSync(SRC, 'utf8');

/**
 * 每个变异体：说明 + 一处替换。
 *
 * 变异点用 String.raw 写：被替换的源码里含 `\\\\.` 这种**多层反斜杠**
 * （模板字符串里的一层转义），普通字符串字面量会把它们再吃掉一层，
 * 结果 indexOf 找不到变异点、变异体全部"存活" —— 那是校验脚本自己的假象。
 */
const EXT_MATCH = String.raw`if (new RegExp('\\\\.' + list[i] + '(?![a-z0-9])').test(lower)) return list[i];`;
const EXT_MATCH_LOOSE = String.raw`if (lower.indexOf('.' + list[i]) >= 0) return list[i];`;

const mutants = [
    ['页内脚本用裸 includes 认后缀（component.tsx 被当成 .ts）', EXT_MATCH, EXT_MATCH_LOOSE],
    ['页内脚本的分片正则失效（分片全进列表）',
        "const hlsSegmentRe = new RegExp(${JSON.stringify(HLS_SEGMENT_RE_SOURCE)}, 'i');",
        "const hlsSegmentRe = new RegExp('a^$', 'i');"],
    ['分片判据放宽成"任何 .ts 都算分片"（整段视频被误伤）',
        String.raw`if (hlsSegmentRe.test(pathname) && !url.includes('playlist')) return null;`,
        String.raw`if (url.indexOf('.ts') >= 0 && !url.includes('playlist')) return null;`],
    ['分片判据丢掉 query 后缀兜底（?file=movie.mpd 认不出）',
        "if (hitStream) { type = 'stream'; ext = hitStream; }",
        "if (false) { type = 'stream'; ext = hitStream; }"],
    ['下载判据退回只看 type（ext=flv 漏掉）',
        "if (requiresFfmpeg(link.type, link.ext) && !downloadCapabilities.ffmpegAvailable) {",
        "if (link.type === 'stream' && !downloadCapabilities.ffmpegAvailable) {"],
    ['筛选清单退回与界面各写一份（落盘校验放行全部键）',
        "const all = SNIFF_FILTER_OPTIONS.map((option) => option.value);",
        "const all = ['all', ...Object.keys(CATEGORIES)] as (MediaType | 'all')[];"],
    ['标题升级判据退回只看 Media_ 前缀（index.m3u8 永远升不了级）',
        '&& isGenericTitle(existing.title) && !isGenericTitle(item.title)) {',
        "&& existing.title.startsWith('Media_')) {"],
];

/**
 * 跑一次被测文件并回答"它失败了吗"。
 *
 * 必须**显式调用 run()**：测试文件本身只导出 run，直接 `node sniffer.test.js`
 * 什么都不做、退出码 0 —— 那样所有变异体都会"存活"，是变异校验自己的假象。
 */
const runTests = (copyPath) => {
    const script = `
        require(${JSON.stringify(path.join(__dirname, 'sniffer.test.js'))})
            .run()
            .then((ok) => { process.exitCode = ok ? 0 : 1; })
            .catch((e) => { console.error(e); process.exitCode = 1; });
    `;
    try {
        execFileSync(process.execPath, ['-e', script], {
            cwd: __dirname,
            env: { ...process.env, BROWSE_SRC: copyPath },
            stdio: 'pipe',
        });
        return false;   // 退出码 0 = 测试通过 = 变异体存活
    } catch (_e) {
        return true;    // 非零退出 = 测试失败 = 变异体被抓住
    }
};

let survived = 0;
for (const [name, from, to] of mutants) {
    if (!original.includes(from)) {
        console.log(`  ?? 找不到变异点：${name}`);
        survived += 1;
        continue;
    }
    fs.writeFileSync(COPY, original.replace(from, to), 'utf8');
    const caught = runTests(COPY);
    console.log(`  ${caught ? 'OK  ' : '存活'} ${name}`);
    if (!caught) survived += 1;
}

fs.rmSync(COPY, { force: true });
console.log(survived === 0 ? '\n全部变异体都被抓住。' : `\n${survived} 个变异体存活 —— 断言不够硬。`);
process.exitCode = survived === 0 ? 0 : 1;
