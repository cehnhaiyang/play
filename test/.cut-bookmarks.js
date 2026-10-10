'use strict';
/**
 * 一次性：从 useBrowse.ts 删掉整个「内部：书签」段（含 useBookmarks）。
 *
 * 按**内容标记**定位而不是硬编码行号：文件是 CRLF，且硬编码行号在
 * 任何一次前置编辑后都会失效。删完断言目标符号已消失。
 */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'hooks', 'useBrowse.ts');
const before = fs.readFileSync(target);
const text = before.toString('utf8');

const START_MARK = '/*                               内部：书签';
const END_MARK = '/*                             内部：搜索引擎';

const startIdx = text.indexOf(START_MARK);
const endIdx = text.indexOf(END_MARK);
if (startIdx < 0) { console.error('找不到书签段起始标记'); process.exit(1); }
if (endIdx < 0 || endIdx <= startIdx) { console.error('找不到搜索引擎段起始标记'); process.exit(1); }

// 起点回退到该行行首（含前面的 /* ---- */ 分隔线）
const lineStart = text.lastIndexOf('\n', startIdx) + 1;
// 分隔线本身在标题行之前一行，再回退一行
const sepStart = text.lastIndexOf('\n', lineStart - 2) + 1;

console.log('将删除的首行:', JSON.stringify(text.slice(sepStart, text.indexOf('\n', sepStart))));
console.log('将删除的末行(前一行):', JSON.stringify(
    text.slice(text.lastIndexOf('\n', endIdx - 2) + 1, endIdx - 1)));

const out = text.slice(0, sepStart) + text.slice(endIdx);
fs.writeFileSync(target, out, 'utf8');

const leftovers = ['useBookmarks', 'loadStoredBookmarks', 'loadBarVisibility', 'trimTree', 'BOOKMARK_']
    .filter((s) => out.includes(s));
if (leftovers.length > 0) {
    console.error('仍有残留符号:', leftovers.join(', '));
    process.exit(1);
}
console.log('删除完成，无残留符号');
console.log('行数:', text.split('\n').length, '->', out.split('\n').length);
