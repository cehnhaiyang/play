// 复盘导出文件里每一处「协议错误」：把该步骤的原始回复取出来，
// 用 hooks/useAgent.ts 里同一套 extractJsonObject 跑一遍，再看严格 JSON.parse 在哪一列崩。
const fs = require('fs');

const extractJsonObject = (text) => {
    if (!text) return null;
    const starts = [];
    for (let i = 0; i < text.length; i += 1) if (text[i] === '{') starts.push(i);
    for (const start of starts) {
        let depth = 0, inString = false, escaped = false;
        for (let i = start; i < text.length; i += 1) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    try {
                        const parsed = JSON.parse(text.slice(start, i + 1));
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
                    } catch (_e) { /* 下一个起点 */ }
                    break;
                }
            }
        }
    }
    return null;
};

const readBlocks = (lines) => {
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
        const m = /^## (\d+)\. (.+)$/.exec(lines[i]);
        if (!m) continue;
        const header = `#${m[1]} ${m[2]}`;
        let j = i + 1;
        while (j < lines.length && !/^## \d+\./.test(lines[j]) && !lines[j].startsWith('**返回值**')) j += 1;
        if (!lines[j] || !lines[j].startsWith('**返回值**')) continue;
        while (j < lines.length && !lines[j].startsWith('```')) j += 1;
        const open = lines[j];
        const fenceLen = open.length - open.replace(/^`+/, '').length;
        const closer = '`'.repeat(fenceLen);
        const body = [];
        j += 1;
        while (j < lines.length && !lines[j].startsWith(closer)) { body.push(lines[j]); j += 1; }
        out.push({ header, raw: body.join('\n') });
    }
    return out;
};

for (const file of process.argv.slice(2)) {
    const blocks = readBlocks(fs.readFileSync(file, 'utf8').split('\n'));
    console.log('\n===== ' + file);
    for (const b of blocks) {
        if (!/协议错误（失败）/.test(b.header)) continue;
        const parsed = extractJsonObject(b.raw);
        let strict = 'OK';
        try { JSON.parse(b.raw); } catch (e) { strict = e.message; }
        console.log(`\n-- ${b.header}`);
        console.log(`   bytes=${b.raw.length} 左花括号数=${(b.raw.match(/\{/g) || []).length} DSML=${/DSML/.test(b.raw)}`);
        console.log(`   extractJsonObject -> ${parsed === null ? 'null' : JSON.stringify(Object.keys(parsed))}`);
        console.log(`   tool=${parsed && JSON.stringify(parsed.tool)} final=${parsed && parsed.final !== undefined ? `${typeof parsed.final}:${String(parsed.final).length}字` : '(缺字段)'}`);
        console.log(`   严格 JSON.parse(整段) -> ${strict}`);
        const pos = /position (\d+)/.exec(strict);
        if (pos) {
            const p = Number(pos[1]);
            console.log(`   崩点上下文: …${JSON.stringify(b.raw.slice(Math.max(0, p - 70), p + 30))}…`);
            console.log(`   崩点字符=U+${b.raw.charCodeAt(p).toString(16).toUpperCase().padStart(4, '0')}`);
        }
        console.log(`   head=${JSON.stringify(b.raw.slice(0, 110))}`);
    }
}
