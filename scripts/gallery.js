#!/usr/bin/env node

/**
 * gallery.js — ACGMHO 图集抓取与全本下载命令行工具
 * 
 * 用法:
 *   node scripts/gallery.js 761277
 *   node scripts/gallery.js 761277 --pages 1-5
 *   node scripts/gallery.js https://www.acgmho.com/h/761277.html --dry-run
 *   npm run gallery 761277
 */

const path = require('path');
const fs = require('fs');
const { probeGallery, downloadGallery, parsePageRange } = require('../electron/acgmhoService');

function printHelp() {
  console.log(`
ACGMHO Gallery Downloader (Node.js CLI)

用法:
  node scripts/gallery.js <id_or_url> [options]

选项:
  --pages <range>     指定页码范围，如 1-5 或 1,3,5 (默认全本)
  --outdir <path>     指定保存根目录 (默认 ~/Downloads/acgmho)
  --delay <sec>       页面请求间隔秒数 (默认 1.0)
  --dry-run           只探测与解析结构，不下载文件
  -h, --help          显示帮助
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(args.length === 0 ? 1 : 0);
  }

  let gidOrUrl = null;
  let pages = null;
  let outdir = null;
  let delay = 1.0;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--pages' && i + 1 < args.length) {
      pages = args[++i];
    } else if (arg === '--outdir' && i + 1 < args.length) {
      outdir = args[++i];
    } else if (arg === '--delay' && i + 1 < args.length) {
      delay = parseFloat(args[++i]);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (!arg.startsWith('-') && !gidOrUrl) {
      gidOrUrl = arg;
    }
  }

  if (!gidOrUrl) {
    console.error('[!] 请指定作品 ID 或 URL');
    process.exit(1);
  }

  console.log(`[*] 探测作品: ${gidOrUrl}`);
  let probe = null;
  try {
    probe = await probeGallery(gidOrUrl);
  } catch (err) {
    console.error(`[!] 探测失败: ${err.message}`);
    process.exit(1);
  }

  console.log(`    标题: ${probe.title}`);
  console.log(`    总页数: ${probe.totalPages}`);
  console.log(`    前缀: /${probe.prefix}/`);
  console.log(`    封面: ${probe.firstImgUrl}`);

  const targetPages = parsePageRange(pages, probe.totalPages);
  console.log(`[*] 待处理页码 [${targetPages.length} 页]: ${targetPages.join(', ')}`);

  if (dryRun) {
    console.log('[*] --dry-run 模式：解析完成，不下载图片。');
    process.exit(0);
  }

  // 空范围直接退出：之前会继续跑出 0 页空画廊（manifest + .gallery 照写不误）
  if (targetPages.length === 0) {
    console.error(`[!] 页码范围「${pages}」无有效页（总 ${probe.totalPages} 页），请检查 --pages 参数`);
    process.exit(1);
  }

  // 与主进程 defaultGalleryRoot 同口径：优先系统主目录，USERPROFILE 在非 Windows 下为空会落到相对路径
  const os = require('os');
  const homeDir = (() => {
    try {
      return os.homedir();
    } catch (_e) {
      return '';
    }
  })();
  const baseDir = outdir || path.join(homeDir || process.env.USERPROFILE || process.env.HOME || '.', 'Downloads', 'acgmho');
  // 与服务层 defaultGalleryRoot 同口径：叶目录带前缀，/h/123 与 /hentai/123 不互踩
  const leaf = probe.prefix && probe.prefix !== 'auto' ? `${probe.prefix}-${probe.gid}` : String(probe.gid);
  const targetDir = path.join(outdir || baseDir, leaf);

  console.log(`[*] 保存目录: ${targetDir}`);
  console.log(`[*] 开始下载...`);

  let lastLineLength = 0;
  function logInline(str) {
    process.stdout.write('\r' + str.padEnd(lastLineLength, ' '));
    lastLineLength = str.length;
  }

  const result = await downloadGallery(
    {
      // 传详情页原文 + 配套 probe：纯数字 gid 重探可能串到同名异帖
      gidOrUrl: probe.firstPageUrl || gidOrUrl,
      pages: targetPages.join(','),
      outDir: targetDir,
      delayMs: Math.round(delay * 1000),
      probe,
    },
    (progress) => {
      if (progress.status === 'downloading') {
        logInline(`    -> [${progress.currentPage}/${progress.totalPages}] ${progress.message || ''}`);
      } else if (progress.status === 'completed') {
        process.stdout.write('\n');
        console.log(`[=] ${progress.message}`);
      }
    }
  );

  console.log(`[=] 清单文件: ${result.manifestPath}`);
  console.log(`[=] 成功下载: ${result.totalDownloaded}/${targetPages.length} 页`);
  // 全军覆没时非零退出：之前打了 0/N 照样 exit 0，脚本调用方无法感知失败
  if (!result.success) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[!] 致命错误:', err);
  process.exit(1);
});
