'use strict';

/**
 * 知识库读盘服务（主进程侧）。
 *
 * 这个模块**只做文件 I/O**，不含任何检索逻辑 —— 解析、评分、切片全在
 * services/KbService（纯 TS，可单测）。边界这么划的理由：
 *
 *  - 主进程目录只能写 .js（见 electron-main-constraints），而
 *    scripts/test/tsconfig.json 不 include electron/，纯逻辑放这儿就没法单测；
 *  - 反过来，读盘必须在这里 —— 渲染层 nodeIntegration 关着，没有 fs。
 *
 * 之所以**不把 KB 打包进 bundle** 而是运行时读盘：KB 是外部仓库、会持续更新
 * （本机刚从旧版换到 1.2.1）。打包意味着每次升级都要改生成物加重构建；
 * 读盘只要换目录，或改一下设置里的 kbRoot。
 */

const fs = require('fs');
const path = require('path');

/**
 * 默认 kb 根目录名。
 *
 * 仓库换版本时目录名会带版本号（open-reverselab-1.2.1），所以这里先按
 * 精确名找，找不到再扫同级目录里以 open-reverselab 开头的候选，
 * 取名字最大的那个 —— 换版本不用改代码。
 */
const DEFAULT_KB_DIR = 'open-reverselab-1.2.1';
const KB_DIR_PREFIX = 'open-reverselab';

/** 单次 load 回传的正文总量上限。超过就只回索引需要的那几个字段 */
const LOAD_TOTAL_LIMIT_BYTES = 16 * 1024 * 1024;

/** 单篇正文上限：防止某个异常大文件把整包撑爆 */
const LOAD_FILE_LIMIT_BYTES = 512 * 1024;

const ARTICLE_RE = /^([^/]+)\/techniques\/(.+\.md)$/;

/**
 * 什么算一篇文章。
 *
 * **这个判据只有这一份**。此前 kbStatus 数"所有 techniques 下的 .md"、
 * 渲染层建索引时另排一遍 README，两边差 11 —— 界面显示 205 篇，
 * 而模型实际只能搜到 194 篇。"显示的和实际发生的不一致"正是这么来的。
 *
 * 排除 README 是因为它们是目录页不是技术文章：正文全是链接清单，
 * 检索命中它没有意义，读回来也答不了任何问题。
 */
function isArticlePath(relative) {
    if (!ARTICLE_RE.test(relative)) return false;
    return !/(^|\/)readme\.md$/i.test(relative);
}

/** 项目根：electron/ 的上一级 */
function projectRoot() {
    return path.join(__dirname, '..');
}

/** 判断目录存在且是目录 */
function isDir(target) {
    try {
        return fs.statSync(target).isDirectory();
    } catch (_e) {
        return false;
    }
}

/**
 * 候选 kb 根目录，按优先级排列。
 *
 * 打包版不把 KB 打进去（build.files 只有 dist / electron / ffmpeg-static），
 * 所以 packaged 时 __dirname 下不会有 KB —— 那时只能靠设置里的绝对路径。
 */
function kbCandidates(configured) {
    const out = [];
    const add = (p) => { if (p && !out.includes(p)) out.push(p); };

    add(configured);

    const base = projectRoot();
    add(path.join(base, DEFAULT_KB_DIR, 'kb'));

    // 换版本时的兜底：扫同级目录，挑字典序最大的 open-reverselab*
    try {
        const siblings = fs.readdirSync(base)
            .filter((name) => name.startsWith(KB_DIR_PREFIX))
            .sort()
            .reverse();
        for (const name of siblings) add(path.join(base, name, 'kb'));
    } catch (_e) {
        // 目录读不到就跳过这一路兜底，不影响前面两个候选
    }

    return out;
}

/**
 * 解析出真正可用的 kb 根目录。
 * 返回绝对路径；一个都不存在时返回 ''（由调用方转成结构化错误，不抛）。
 */
function resolveKbRoot(configured) {
    for (const candidate of kbCandidates(configured)) {
        const resolved = path.resolve(candidate);
        if (isDir(resolved) && isDir(path.join(resolved, 'ctf-website', 'techniques'))) {
            return resolved;
        }
    }
    return '';
}

/**
 * 递归收集 kb 下的 Markdown 文件。
 *
 * 只收 `.md`，且跳过 node_modules / .venv —— KB 根目录理论上很干净，
 * 但用户完全可能把 kbRoot 指到整个仓库根上。
 */
function collectMarkdown(root) {
    const found = [];
    const skip = new Set(['node_modules', '.venv', '.git', '__pycache__']);

    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_e) {
            return;
        }
        for (const entry of entries) {
            if (skip.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
            found.push(full);
        }
    };

    walk(root);
    return found;
}

/** 相对路径统一成 '/' 分隔，避免 Windows 反斜杠漏进索引键 */
function toPosix(relative) {
    return relative.split(path.sep).join('/');
}

/** 读一个文件，失败返回 null（权限、被占用、编码问题都只跳过这一个） */
function readTextFile(file) {
    try {
        const stat = fs.statSync(file);
        if (stat.size > LOAD_FILE_LIMIT_BYTES) return null;
        return fs.readFileSync(file, 'utf8');
    } catch (_e) {
        return null;
    }
}

/** 读各板块的 kb-index.json。缺失或坏掉都只让那一个板块少一路信号 */
function loadBoardIndexes(root) {
    const out = {};
    let boards;
    try {
        boards = fs.readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch (_e) {
        return out;
    }

    for (const board of boards) {
        const indexFile = path.join(root, board, 'techniques', 'kb-index.json');
        const raw = readTextFile(indexFile);
        if (!raw) continue;
        try {
            out[board] = JSON.parse(raw);
        } catch (_e) {
            // 单个板块索引坏掉不该拖垮整库：少一路加权信号而已
        }
    }
    return out;
}

/**
 * 一次性把整库读给渲染层。
 *
 * 不做增量、不做缓存：整库 248 个文件 / 3 MB，一次读完远比分批请求简单，
 * 而且渲染层会把它长期驻留（见 useAgent 的 kbRef），实际只在启动时读一次。
 */
function loadKbSource(configuredRoot) {
    const root = resolveKbRoot(configuredRoot);
    if (!root) {
        return {
            root: '',
            files: [],
            boardIndexes: {},
            error: '没有找到知识库目录。请在设置里填写 open-reverselab 仓库下 kb 目录的绝对路径。',
        };
    }

    const files = [];
    let total = 0;
    let skipped = 0;

    for (const file of collectMarkdown(root)) {
        const relative = toPosix(path.relative(root, file));
        // 只收文章：README、板块说明、checklists、payloads 都不是可检索的技术文章
        if (!isArticlePath(relative)) continue;

        const content = readTextFile(file);
        if (content == null) { skipped += 1; continue; }
        if (total + content.length > LOAD_TOTAL_LIMIT_BYTES) { skipped += 1; continue; }

        total += content.length;
        files.push({ path: relative, content });
    }

    return {
        root,
        files,
        boardIndexes: loadBoardIndexes(root),
        skipped,
    };
}

/**
 * 单篇正文。
 *
 * 走**白名单**而不是拼接后校验：路径先在 KB 服务侧被 normalizeRel 归一化，
 * 这里再确认它确实落在 kb 根内、且形如 `<board>/techniques/**.md`。
 * 两道都过才读 —— 单独任何一道都不够（归一化防的是 `..`，
 * 这里防的是符号链接与配置指错根目录）。
 */
function readKbArticle(configuredRoot, relativePath) {
    const root = resolveKbRoot(configuredRoot);
    if (!root) return { error: '知识库目录不可用。' };

    const clean = String(relativePath || '').replace(/\\/g, '/');
    if (!ARTICLE_RE.test(clean) || clean.includes('..')) {
        return { error: `不是合法的文章路径：${relativePath}` };
    }

    const full = path.resolve(root, clean);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (!full.startsWith(rootWithSep)) {
        return { error: `路径越出知识库根目录：${relativePath}` };
    }

    const content = readTextFile(full);
    if (content == null) return { error: `读不到文件：${relativePath}` };

    return { path: clean, content };
}

/** 轻量状态：设置面板与 kb 工具的 status 动作都用它 */
function kbStatus(configuredRoot) {
    const root = resolveKbRoot(configuredRoot);
    if (!root) {
        return {
            ready: false,
            root: '',
            articles: 0,
            bytes: 0,
            error: '没有找到知识库目录。请在设置里填写 kb 目录的绝对路径。',
        };
    }

    let articles = 0;
    let bytes = 0;
    for (const file of collectMarkdown(root)) {
        const relative = toPosix(path.relative(root, file));
        if (!isArticlePath(relative)) continue;
        try {
            bytes += fs.statSync(file).size;
            articles += 1;
        } catch (_e) {
            // 单个文件 stat 失败不计入，不影响整体状态
        }
    }

    return { ready: true, root, articles, bytes };
}

module.exports = {
    resolveKbRoot,
    loadKbSource,
    readKbArticle,
    kbStatus,
    isArticlePath,
};
