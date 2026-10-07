'use strict';

/**
 * Edge 数据导入（主进程侧）。
 *
 * ============================================================================
 * 为什么这一层在主进程
 * ============================================================================
 *
 * 要读 Edge 的 SQLite 库与 JSON 文件，还要调 Win32 API 解 APPB 密钥 ——
 * 渲染层 nodeIntegration 关着，没有 fs、没有 child_process。边界与 kbService 一致：
 * 这里只负责「把数据取出来」，合并进书签树、去重、UI 呈现全在渲染层。
 *
 * 依赖只有 Node 内置：`node:sqlite`（Node 22.5+，Electron 44 的 Node 24 自带）
 * 与 `child_process`（起 PowerShell 跑 C# 小助手做 DPAPI/NCrypt）。
 * **不需要任何第三方包**，也**不 require electron** ——
 * 后者让本模块可以被 test/ 直接 require 求值。
 *
 * ============================================================================
 * Cookie 走纯离线解密，不再启动 Edge（实测结论）
 * ============================================================================
 *
 * 本机 Edge 154.0.4258.37 的实测解密链：
 *
 *   Local State 的 `app_bound_encrypted_key`（APPB 前缀）
 *     → SYSTEM 身份 CryptUnprotectData（第一层 DPAPI）
 *     → 用户身份 CryptUnprotectData（第二层 DPAPI）
 *     → key blob（`u32 headerLen + header + u32 contentLen + content`，
 *       header 是浏览器安装路径）
 *     → content 就是 **32 字节 v20 主密钥本身**（无内层加密）
 *     → 解 Cookies 表每条 `encrypted_value`
 *      （`v20 + 12B iv + ct + 16B tag`，AES-256-GCM，AAD 为空；
 *       明文 = 32 字节随机前缀 + UTF-8 真值）
 *
 * 关键实测点（Stage 0/1，全部有脚本复现）：
 *   - APPB 剥掉前缀是标准 DPAPI blob，masterKey GUID 落在
 *       C:\Windows\System32\Microsoft\Protect\S-1-5-18\User\<guid>
 *     即 SYSTEM 域 —— 第一层必须在 SYSTEM 上下文解。提权后复制任意
 *     SYSTEM 进程的令牌即可（注意 `Registry` 进程的令牌受限，DPAPI 会
 *     报 ACCESS_DENIED；`smss.exe` 的可用 —— 助手里逐个试，不写死）。
 *   - IElevator COM 走不通：Chromium 按**调用进程路径**校验，
 *     第三方进程必然 ACCESS_DENIED（公开的绕过法是注入浏览器进程，
 *     不采用）。能过 SYSTEM DPAPI 就根本不需要 COM。
 *   - `encrypted_key`（v10 那把）能解但**解不开 v20 行**（GCM 认证失败），
 *     两把密钥没有关系 —— 别拿错。
 *   - 全部 1326 条 v20 用 32 字节 content 解，GCM **全部认证通过**；
 *     其中没有任何一条的完整明文是合法 UTF-8，去掉 32 字节前缀后
 *     1315 条是合法 cookie 值，剩下 11 条明文恰好 32 字节（空值 cookie）。
 *   - `aster_app_bound_encrypted_key` 是第二个 APPB 字段，留作主密钥
 *     派生失败时的候选（同流程再解一次）。
 *
 * 所以不再复制 profile、不再起 Edge、不再走 CDP —— 直接读库解密。
 * 代价是程序必须以管理员运行（拿 SYSTEM 令牌要 SeDebugPrivilege），
 * 见 main.js 启动自提权；非管理员下导入直接报错，不静默降级。
 *
 * **密码库没有对应的离线接口**（password_value 也是 v20，但 Chromium
 * 没有公开它的 AAD/派生细节），所以不导入密码 —— UI 里明确写清原因，
 * 而不是留一个点了没反应的选项。
 *
 * ============================================================================
 * 一条实测硬约束：导入前必须让 Edge 正常退出
 * ============================================================================
 *
 * Edge 关闭窗口后仍有后台进程常驻（`--no-startup-window`），它持有 Cookies 库的
 * **独占锁**。实测三种读法全部失败：
 *
 *   fs.readFileSync（libuv 共享读）        → EBUSY
 *   node:sqlite immutable=1 / mode=ro      → unable to open database file
 *   robocopy /b（SE_BACKUP_NAME，能绕 ACL） → rc=16
 *
 * `robocopy /b` 能绕过 ACL 但**绕不过共享模式** —— 这是 Win32 层的强制拒绝。
 * 所以遇到锁定时直接给出可操作的提示，不做徒劳重试。
 *
 * 另外实测：Cookies 库是 WAL 模式，`taskkill /F` 硬杀后刚写入内存、
 * 还没 checkpoint 的那几条会话 cookie 会丢（磁盘上读不到）。这是离线读的
 * 固有代价 —— 后台杀进程是读库的前提（见 killEdgeProcesses），丢的是
 * Edge 自己都还没落盘的数据，不是我们弄丢的。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const abe = require('./abeCrypto');

/* ========================================================================== */
/*                                   常量                                      */
/* ========================================================================== */

/** Edge 各发行版：User Data 目录与可执行文件所在目录 */
const EDGE_CHANNELS = [
    { id: 'stable', label: 'Microsoft Edge', ud: ['Microsoft', 'Edge', 'User Data'], app: ['Microsoft', 'Edge', 'Application'] },
    { id: 'beta', label: 'Microsoft Edge Beta', ud: ['Microsoft', 'Edge Beta', 'User Data'], app: ['Microsoft', 'Edge Beta', 'Application'] },
    { id: 'dev', label: 'Microsoft Edge Dev', ud: ['Microsoft', 'Edge Dev', 'User Data'], app: ['Microsoft', 'Edge Dev', 'Application'] },
    { id: 'canary', label: 'Microsoft Edge Canary', ud: ['Microsoft', 'Edge SxS', 'User Data'], app: ['Microsoft', 'Edge SxS', 'Application'] },
];

/** 合法的 profile 目录名。`Guest Profile` / `System Profile` 不是用户配置，排除 */
const PROFILE_DIR_RE = /^(Default|Profile \d+)$/;

/**
 * 单个 favicon 的字节上限。
 *
 * 图标要内联进书签节点（dataURL）并整棵树存进 localStorage。Edge 的
 * favicon_bitmaps 里最大的一档能到 128×128 PNG（十几 KB），几百个就撑爆配额，
 * 而 saveStr 配额爆掉是**静默返回 false** —— 表现为"收藏了但没存住"。
 */
const FAVICON_MAX_BYTES = 4096;

/** 整次导入的图标总预算。超了后面的条目就不带图标，而不是丢掉条目本身 */
const FAVICON_BUDGET_BYTES = 320 * 1024;

/** 历史导入条数上限（本机 8728 条 / 20812 次访问） */
const HISTORY_LIMIT = 3000;

/** 自动填充条数上限 */
const AUTOFILL_LIMIT = 500;

/** 账号条数上限 */
const ACCOUNT_LIMIT = 500;

/** 解密小助手（PowerShell + C#）的单次超时：含 Add-Type 编译，实测 10 秒内 */
const ABE_HELPER_TIMEOUT_MS = 120000;

/** 杀掉 Edge 后等它释放 Cookie 库的上限 */
const EDGE_KILL_TIMEOUT_MS = 15000;

/* ========================================================================== */
/*                                  小工具                                     */
/* ========================================================================== */

/** 存在且是文件 */
function isFile(target) {
    try { return fs.statSync(target).isFile(); } catch (_e) { return false; }
}

/** 存在且是目录 */
function isDir(target) {
    try { return fs.statSync(target).isDirectory(); } catch (_e) { return false; }
}

/** 读 JSON，失败返回 null（配置损坏只影响这一个来源） */
function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return null; }
}

/**
 * 复制一个文件，走**共享读**。
 *
 * 不能用 fs.copyFileSync：它内部是 Win32 CopyFileW，目标被别的进程打开时
 * 直接 EBUSY。readFileSync 走 libuv 的共享读打开，能拿到正在被写的库
 * （前提是对方没加独占锁 —— Cookies 就加了，见文件头注释）。
 */
function copyShared(src, dst) {
    fs.writeFileSync(dst, fs.readFileSync(src));
}

/* ========================================================================== */
/*                                  时间换算                                    */
/* ========================================================================== */

/** WebKit 时间戳起点（1601-01-01）到 Unix 起点（1970-01-01）的毫秒差 */
const WEBKIT_EPOCH_OFFSET_MS = 11644473600000;

/**
 * Edge 的时间戳是「1601 年起的**微秒**」，以字符串形式存（避免 JSON 精度丢失）。
 *
 * 13426657176474389 → 2026-06-23 左右。这个数超过 2^53，所以：
 *   - SQLite 侧一律 `CAST(x AS TEXT)` 取出再算，绕开 number/bigint 的分歧；
 *   - JSON 侧本来就是字符串，直接 Number() 后除以 1000，末位精度损失是微秒级，
 *     换算成毫秒后完全无影响。
 *
 * 非法输入返回 0（不是 NaN）——NaN 会一路传到界面变成 "Invalid Date"。
 */
function webkitMicrosToMs(value) {
    if (value == null) return 0;
    const micros = typeof value === 'bigint' ? Number(value) : Number(String(value).trim());
    if (!Number.isFinite(micros) || micros <= 0) return 0;
    const ms = micros / 1000 - WEBKIT_EPOCH_OFFSET_MS;
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

/* ========================================================================== */
/*                                   书签                                      */
/* ========================================================================== */

/** 给一个 Edge 书签节点生成稳定 id。guid 唯一（实测 73 节点 73 个不同 guid） */
function edgeNodeId(raw) {
    const guid = raw && typeof raw.guid === 'string' ? raw.guid.trim() : '';
    if (guid) return guid;
    const id = raw && raw.id != null ? String(raw.id) : '';
    if (id) return `edge-id-${id}`;
    return '';
}

/**
 * 把一个 Edge 书签节点转成我们的树节点。
 *
 * 递归转换，坏节点返回 null 由调用方过滤 —— 单个坏条目不该让整棵树消失。
 * folder 的 children 允许为空数组（Edge 里确实有空文件夹，要保住它）。
 */
function convertEdgeBookmarkNode(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const isFolder = raw.type === 'folder';
    const isUrl = raw.type === 'url';
    if (!isFolder && !isUrl) return null;

    const rawTitle = typeof raw.name === 'string' ? raw.name.trim() : '';
    const createdAt = webkitMicrosToMs(raw.date_added);

    if (isUrl) {
        const url = typeof raw.url === 'string' ? raw.url.trim() : '';
        if (!url) return null;
        return {
            id: edgeNodeId(raw),
            type: 'url',
            title: rawTitle || url,
            url,
            createdAt,
        };
    }

    const children = Array.isArray(raw.children)
        ? raw.children.map(convertEdgeBookmarkNode).filter((node) => node !== null)
        : [];

    return {
        id: edgeNodeId(raw),
        type: 'folder',
        title: rawTitle || '未命名文件夹',
        children,
        createdAt,
    };
}

/** 空文件夹节点（某个根缺失时的占位，保证界面永远拿到两个根） */
function emptyFolder(title) {
    return { id: '', type: 'folder', title, children: [], createdAt: 0 };
}

/**
 * 解析 Edge 的 Bookmarks JSON。
 *
 * 返回 `{ bar, other, extras }`：
 *   - `bar`     ← roots.bookmark_bar（收藏夹栏）
 *   - `other`   ← roots.other（其他收藏夹）
 *   - `extras`  ← 其余**非空**的根（synced「移动收藏夹」、workspaces_v2「工作区」…）
 *
 * 为什么要有 extras：本机这两个根是空的，但别的机器上未必。**非空的根一律
 * 带回来**（渲染层会挂到「其他收藏夹」下面），否则就是静默丢数据 —— 用户
 * 看到导入"成功"却少了一批书签，且无从知道少了什么。
 */
function parseEdgeBookmarks(raw) {
    const roots = (raw && typeof raw === 'object' && raw.roots) || {};

    const bar = convertEdgeBookmarkNode(roots.bookmark_bar) || emptyFolder('收藏夹栏');
    const other = convertEdgeBookmarkNode(roots.other) || emptyFolder('其他收藏夹');

    const extras = [];
    for (const key of Object.keys(roots)) {
        if (key === 'bookmark_bar' || key === 'other') continue;
        const node = convertEdgeBookmarkNode(roots[key]);
        if (!node) continue;
        if (countBookmarkNodes(node) === 0) continue;
        extras.push(node);
    }

    return { bar, other, extras };
}

/** 深度优先收集所有 url 节点（带所在文件夹路径，供界面按目录分组） */
function flattenBookmarkNodes(node, trail = []) {
    const out = [];
    if (!node || !Array.isArray(node.children)) return out;
    for (const child of node.children) {
        if (!child) continue;
        if (child.type === 'url') {
            out.push({ ...child, folderPath: trail });
        } else {
            out.push(...flattenBookmarkNodes(child, [...trail, child.title]));
        }
    }
    return out;
}

/** 节点总数（含文件夹）。用来判断某个根是否为空 */
function countBookmarkNodes(node) {
    if (!node || !Array.isArray(node.children)) return 0;
    let total = 0;
    for (const child of node.children) {
        if (!child) continue;
        total += 1;
        if (child.type === 'folder') total += countBookmarkNodes(child);
    }
    return total;
}

/* ========================================================================== */
/*                                   Favicon                                   */
/* ========================================================================== */

/**
 * 给一个候选 bitmap 打分，分高者胜。
 *
 * 偏好 32×32：书签栏与标签页的图标槽位在 16–32 px 之间，更大的图只是白占
 * 配额（128×128 的 PNG 能到十几 KB，是 32×32 的四五倍）。
 * 明确的分级而不是"越大越好"，是因为"越大越清晰"在这个尺寸下不成立。
 */
function faviconScore(row) {
    const width = Number(row && row.width) || 0;
    if (width === 32) return 1000;
    if (width === 16) return 900;
    if (width === 64) return 800;
    if (width > 32) return 500 - Math.min(width, 400);   // 越大越差，但不至于低于小图
    return width;                                        // 0..31：有宽度信息就用它排序
}

/** 探测图片 MIME。Edge 存的是 PNG 或 ICO，个别是 BMP */
function detectImageMime(buf) {
    if (!buf || buf.length < 4) return '';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    return '';
}

/**
 * 从 favicon 查询结果里为每个页面挑一张图。
 *
 * rows: `{ page_url, image_data, width, height }`
 * 返回 `Map<page_url, dataURL>`。
 *
 * 两道闸：单图超 FAVICON_MAX_BYTES 直接丢；总量超 FAVICON_BUDGET_BYTES 后
 * 只保留已入选的，后续条目无图标 —— 但**书签条目本身一条不少**。
 */
function selectFavicons(rows) {
    const best = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row.page_url !== 'string' || !row.page_url) continue;
        const data = row.image_data;
        if (!data || typeof data.length !== 'number' || data.length === 0) continue;
        if (data.length > FAVICON_MAX_BYTES) continue;
        const current = best.get(row.page_url);
        if (!current || faviconScore(row) > faviconScore(current.row)) {
            best.set(row.page_url, { row, data });
        }
    }

    const out = new Map();
    let budget = FAVICON_BUDGET_BYTES;
    for (const [pageUrl, entry] of best) {
        const buf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
        const mime = detectImageMime(buf);
        if (!mime) continue;
        const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
        if (dataUrl.length > budget) continue;
        budget -= dataUrl.length;
        out.set(pageUrl, dataUrl);
    }
    return out;
}

/**
 * 给书签树补图标。
 *
 * 匹配键优先用完整 URL，退一步用 origin —— Edge 的 icon_mapping 按页存，
 * 而书签可能带 query/fragment（`https://a.com/x?y=1` 与 `https://a.com/x` 是两条映射）。
 * 只做这两级，不做模糊匹配：错配的图标比没有图标更让人困惑。
 */
function attachFavicons(node, favicons) {
    if (!node || !Array.isArray(node.children)) return;
    for (const child of node.children) {
        if (!child) continue;
        if (child.type === 'folder') { attachFavicons(child, favicons); continue; }
        let icon = favicons.get(child.url);
        if (!icon) {
            try {
                const origin = new URL(child.url).origin;
                icon = favicons.get(origin) || favicons.get(`${origin}/`);
            } catch (_e) { /* 非法 URL 就不配图标 */ }
        }
        if (icon) child.icon = icon;
    }
}

/* ========================================================================== */
/*                                  Cookie                                     */
/* ========================================================================== */

/**
 * 把 Cookies 表的一行 + 解出的明文转成我们要写入会话的形状。
 *
 * 与旧的 normalizeCdpCookie 同形（main.js 的写回逻辑不用改）：
 * 会话 cookie（has_expires 为假，或 expires_utc 非法）不写 expirationDate，
 * 让 Electron 按会话处理（传 -1 会被当成 1969 年过期，cookie 直接消失）。
 *
 * samesite 是 Chromium 的数字枚举：2=Strict，1=Lax，0=None，
 * -1/其它=未指定 —— 对应 Electron 的 strict/lax/no_restriction/unspecified。
 */
function normalizeSqliteCookie(row, value) {
    if (!row || typeof row !== 'object') return null;
    const domain = typeof row.host_key === 'string' ? row.host_key : '';
    const name = typeof row.name === 'string' ? row.name : '';
    if (!domain || !name) return null;

    const path = typeof row.path === 'string' && row.path ? row.path : '/';
    const secure = Boolean(row.is_secure);
    const sameSiteNum = Number(row.samesite);
    const sameSite = sameSiteNum === 2 ? 'strict'
        : sameSiteNum === 1 ? 'lax'
            : sameSiteNum === 0 ? 'no_restriction'
                : 'unspecified';

    let expirationDate;
    if (row.has_expires && row.expires_utc != null) {
        const sec = Math.floor(webkitMicrosToMs(row.expires_utc) / 1000);
        if (Number.isFinite(sec) && sec > 0) expirationDate = sec;
    }

    return {
        url: buildCookieUrl({ domain, path, secure }),
        name,
        value: typeof value === 'string' ? value : '',
        domain,
        path,
        secure,
        httpOnly: Boolean(row.is_httponly),
        sameSite,
        expirationDate,
    };
}

/**
 * 组装 cookies.set 需要的 url。
 *
 * Electron 用 url 推出 domain/path/secure 的默认值，但**显式传了 domain 时
 * url 的 host 只用来做校验**。这里按库里的 host_key/path 拼一个能通过校验的 url：
 * 域名的前导点要去掉（`https://.example.com` 不是合法 URL）。
 */
function buildCookieUrl(raw) {
    const host = String(raw.domain || '').replace(/^\./, '');
    const scheme = raw.secure ? 'https' : 'http';
    return `${scheme}://${host}${raw.path || '/'}`;
}

/* ========================================================================== */
/*                                  profile                                    */
/* ========================================================================== */

/** 一个 User Data 根下有哪些 profile（纯函数，输入是 Local State 的内容） */
function profilesFromLocalState(localState, userDataDir) {
    const cache = (localState && localState.profile && localState.profile.info_cache) || {};
    const names = Object.keys(cache).filter((name) => PROFILE_DIR_RE.test(name));
    if (names.length === 0) names.push('Default');

    // Default 排最前，其余按 Profile N 的数字序 —— 界面上顺序稳定，
    // 而不是随 Object.keys 的插入顺序抖动
    names.sort((a, b) => {
        if (a === 'Default') return -1;
        if (b === 'Default') return 1;
        return a.localeCompare(b, 'en', { numeric: true });
    });

    return names.map((id) => ({
        id,
        name: (cache[id] && typeof cache[id].name === 'string' && cache[id].name.trim()) || id,
        dir: path.join(userDataDir, id),
    }));
}

/** 可执行文件候选路径（各发行版 × 各 Program Files 根） */
function edgeExecutableCandidates(channel) {
    const roots = [
        process.env['ProgramFiles(x86)'],
        process.env.ProgramFiles,
        process.env.LOCALAPPDATA,
    ].filter(Boolean);
    const out = [];
    for (const root of roots) {
        out.push(path.join(root, ...channel.app, 'msedge.exe'));
    }
    return out;
}

/** User Data 候选路径 */
function edgeUserDataCandidates(channel) {
    const local = process.env.LOCALAPPDATA;
    return local ? [path.join(local, ...channel.ud)] : [];
}

/** 从 `Last Version` 读 Edge 版本号；读不到就返回空串 */
function readEdgeVersion(userDataDir) {
    try { return fs.readFileSync(path.join(userDataDir, 'Last Version'), 'utf8').trim(); } catch (_e) { return ''; }
}

/* ========================================================================== */
/*                                  SQLite                                     */
/* ========================================================================== */

/**
 * 惰性加载 node:sqlite。
 *
 * 不放在模块顶层：老版本 Electron 的内置 Node 没有这个模块，顶层 require
 * 会让整个主进程起不来 —— 而这里的功能是可选的，不该拖垮应用。
 */
function loadSqlite() {
    try { return require('node:sqlite'); } catch (_e) { return null; }
}

/**
 * 把一个 SQLite 库（连同 -wal/-shm）复制到临时目录后只读打开。
 *
 * **必须复制**：一是源库可能正被 Edge 打开，二是只读打开源库时 SQLite 仍会
 * 尝试写 -shm，在只读介质/无权限目录上直接失败。
 */
function openSqliteCopy(srcPath, tempDir) {
    const sqlite = loadSqlite();
    if (!sqlite) return { error: '当前运行时没有 node:sqlite，无法读取 Edge 数据库。' };
    if (!isFile(srcPath)) return { error: '文件不存在' };

    const dst = path.join(tempDir, path.basename(srcPath));
    try {
        copyShared(srcPath, dst);
        for (const suffix of ['-wal', '-shm']) {
            if (isFile(srcPath + suffix)) copyShared(srcPath + suffix, dst + suffix);
        }
    } catch (e) {
        return { error: e.code === 'EBUSY' || e.code === 'EPERM' ? 'LOCKED' : `复制失败：${e.message}` };
    }

    try {
        return { db: new sqlite.DatabaseSync(dst, { readOnly: true }) };
    } catch (e) {
        return { error: `打开失败：${e.message}` };
    }
}

/** 安全查询：任何异常都返回 null，由调用方决定降级还是报错 */
function queryAll(db, sql) {
    try { return db.prepare(sql).all(); } catch (_e) { return null; }
}

/* ========================================================================== */
/*                        Cookie 离线解密（APPB / v20）                        */
/* ========================================================================== */

/**
 * C# 小助手源码。
 *
 * 只做**必须调 Win32 API** 的那几步（令牌模拟、两层 DPAPI、必要时 CNG），
 * 跑在提权后的 PowerShell 子进程里（崩了也只死子进程，见 Stage 0 的
 * 0xC0000409 教训）。key blob 解析与主密钥派生在 abeCrypto.js（纯 JS，
 * 可单测），不要往这里加。
 *
 * 铁律：
 *   - 必须是纯 ASCII —— powershell 5.1 按系统代码页读 .cs，非 ASCII
 *     会被破坏；中文注释一律写在外面的 JS 里。
 *   - 不用 BSTR、不直接碰裸 vtable（IElevator 崩溃的根因），只用
 *     Documented 的 Crypt32/NCrypt/Advapi32 入口。
 *   - 输出走行协议（见 Run 的注释），不抛异常到 PS —— 调用方只读文件。
 */
const ABE_CS_SOURCE = `
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class AbeKey
{
    const uint QLI = 0x1000;
    const uint TOKEN_QUERY = 0x0008;
    const uint TOKEN_DUPLICATE = 0x0002;
    const uint TOKEN_ADJUST = 0x0020;
    const int TokenUser = 1;
    const int SecurityImpersonation = 2;
    const uint SE_ENABLED = 0x00000002;
    const uint SNAPPROC = 0x00000002;
    const int SILENT = 0x40;
    static int lastErr = 0;

    [StructLayout(LayoutKind.Sequential)]
    struct DATA_BLOB { public int cbData; public IntPtr pbData; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCENTRY32 {
        public uint dwSize; public uint cntUsage; public uint pid;
        public IntPtr heap; public uint mod; public uint threads;
        public uint ppid; public int pri; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct LUID { public uint lo; public int hi; }
    [StructLayout(LayoutKind.Sequential)]
    struct LUID_ATTR { public LUID luid; public uint attr; }
    [StructLayout(LayoutKind.Sequential)]
    struct TOKPRIV { public uint count; public LUID_ATTR p; }

    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool b, uint c);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint p);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref PROCENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref PROCENTRY32 e);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr h, uint a, out IntPtr t);
    [DllImport("advapi32.dll")] static extern bool DuplicateToken(IntPtr h, int l, out IntPtr n);
    [DllImport("advapi32.dll")] static extern bool ImpersonateLoggedOnUser(IntPtr t);
    [DllImport("advapi32.dll")] static extern bool RevertToSelf();
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr t, int c, IntPtr b, int l, out int r);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSid(IntPtr s, out IntPtr o);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValue(string s, string n, out LUID l);
    [DllImport("advapi32.dll")] static extern bool AdjustTokenPrivileges(IntPtr t, bool d, ref TOKPRIV p, int l, IntPtr x, IntPtr y);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
    [DllImport("crypt32.dll", SetLastError = true)] static extern bool CryptProtectData(ref DATA_BLOB i, string d, IntPtr e, IntPtr r, IntPtr p, uint f, out DATA_BLOB o);
    [DllImport("crypt32.dll", SetLastError = true)] static extern bool CryptUnprotectData(ref DATA_BLOB i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, uint f, out DATA_BLOB o);
    [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)] static extern int NCryptOpenStorageProvider(out IntPtr h, string n, uint f);
    [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)] static extern int NCryptOpenKey(IntPtr p, out IntPtr h, string n, uint l, uint f);
    [DllImport("ncrypt.dll")] static extern int NCryptDecrypt(IntPtr h, byte[] i, int il, IntPtr pad, byte[] o, int ol, out int r, int f);
    [DllImport("ncrypt.dll")] static extern int NCryptFreeObject(IntPtr h);

    static string Hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.Length * 2);
        foreach (byte v in b) sb.Append(v.ToString("X2"));
        return sb.ToString();
    }

    static byte[] Unprotect(byte[] data) {
        DATA_BLOB inn = new DATA_BLOB();
        inn.cbData = data.Length;
        inn.pbData = Marshal.AllocHGlobal(data.Length);
        Marshal.Copy(data, 0, inn.pbData, data.Length);
        DATA_BLOB ou;
        try {
            if (!CryptUnprotectData(ref inn, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out ou)) {
                lastErr = Marshal.GetLastWin32Error(); return null;
            }
            byte[] r = new byte[ou.cbData];
            Marshal.Copy(ou.pbData, r, 0, ou.cbData);
            Marshal.FreeHGlobal(ou.pbData);
            return r;
        } finally { Marshal.FreeHGlobal(inn.pbData); }
    }

    static bool Roundtrip() {
        byte[] t = Encoding.ASCII.GetBytes("abe-roundtrip-12345678");
        DATA_BLOB inn = new DATA_BLOB();
        inn.cbData = t.Length;
        inn.pbData = Marshal.AllocHGlobal(t.Length);
        Marshal.Copy(t, 0, inn.pbData, t.Length);
        DATA_BLOB mid;
        try {
            if (!CryptProtectData(ref inn, "t", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out mid)) {
                return false;
            }
            byte[] p = new byte[mid.cbData];
            Marshal.Copy(mid.pbData, p, 0, mid.cbData);
            Marshal.FreeHGlobal(mid.pbData);
            byte[] u = Unprotect(p);
            Array.Clear(p, 0, p.Length);
            if (u == null) return false;
            bool same = u.Length == t.Length;
            if (same) for (int i = 0; i < u.Length; i++) if (u[i] != t[i]) { same = false; break; }
            Array.Clear(u, 0, u.Length);
            return same;
        } finally { Marshal.FreeHGlobal(inn.pbData); }
    }

    static string SidOf(IntPtr tok) {
        int need = 0;
        GetTokenInformation(tok, TokenUser, IntPtr.Zero, 0, out need);
        if (need <= 0 || need > 4096) return "";
        IntPtr buf = Marshal.AllocHGlobal(need);
        try {
            int got = 0;
            if (!GetTokenInformation(tok, TokenUser, buf, need, out got)) return "";
            IntPtr sidh = Marshal.ReadIntPtr(buf);
            IntPtr str;
            if (!ConvertSidToStringSid(sidh, out str)) return "";
            string s = Marshal.PtrToStringUni(str);
            LocalFree(str);
            return s == null ? "" : s;
        } finally { Marshal.FreeHGlobal(buf); }
    }

    static byte[] CngDecrypt(byte[] enc) {
        IntPtr prov = IntPtr.Zero, key = IntPtr.Zero;
        try {
            int s = NCryptOpenStorageProvider(out prov, "Microsoft Software Key Storage Provider", 0);
            if (s != 0) { lastErr = s; return null; }
            s = NCryptOpenKey(prov, out key, "Microsoft Edgekey1", 0, 0);
            if (s != 0) { lastErr = s; return null; }
            int need = 0;
            s = NCryptDecrypt(key, enc, enc.Length, IntPtr.Zero, null, 0, out need, SILENT);
            if (s != 0 || need <= 0 || need > 4096) { lastErr = s; return null; }
            byte[] ou = new byte[need];
            int got = 0;
            s = NCryptDecrypt(key, enc, enc.Length, IntPtr.Zero, ou, ou.Length, out got, SILENT);
            if (s != 0) { lastErr = s; return null; }
            if (got != ou.Length) Array.Resize(ref ou, got);
            return ou;
        } finally {
            if (key != IntPtr.Zero) NCryptFreeObject(key);
            if (prov != IntPtr.Zero) NCryptFreeObject(prov);
        }
    }

    // One APPB input (already stripped of the APPB prefix) through both
    // DPAPI layers. Emits B lines (and X lines for flag 3) for tag.
    static void ProcessOne(byte[] blob, IntPtr dup, string tag, StringBuilder log) {
        if (!ImpersonateLoggedOnUser(dup)) return;
        byte[] a = Unprotect(blob);
        if (a == null) { try { RevertToSelf(); } catch { } return; }
        RevertToSelf();
        byte[] b = Unprotect(a);
        Array.Clear(a, 0, a.Length);
        if (b == null) return;
        if (b.Length > 8) {
            int hl = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
            if (hl >= 0 && 4 + hl + 4 <= b.Length) {
                int cpos = 4 + hl + 4;
                if (cpos < b.Length) {
                    int clen = b.Length - cpos;
                    string xsuf = tag == "B" ? "" : "2";
                    if (clen == 32) {
                        // Raw 32-byte master key (Edge 154 shape): there is no
                        // flag byte, the content IS the key. Node parses by
                        // content length, so just mark it 0 and skip CNG.
                        log.AppendLine(tag + "_FLAG=0");
                    } else {
                    int flag = b[cpos];
                    log.AppendLine(tag + "_FLAG=" + flag);
                    if (flag == 3 && cpos + 1 + 32 <= b.Length) {
                        byte[] enc = new byte[32];
                        Array.Copy(b, cpos + 1, enc, 0, 32);
                        byte[] x = CngDecrypt(enc);
                        if (x == null) {
                            if (ImpersonateLoggedOnUser(dup)) {
                                x = CngDecrypt(enc);
                                RevertToSelf();
                            }
                        }
                        Array.Clear(enc, 0, enc.Length);
                        if (x != null) {
                            log.AppendLine("X" + xsuf + "_HEX=" + Hex(x));
                            Array.Clear(x, 0, x.Length);
                        }
                    }
                    }
                }
            }
        }
        log.AppendLine(tag + "_HEX=" + Hex(b));
        Array.Clear(b, 0, b.Length);
    }

    // Line protocol (ASCII only):
    //   CHOSEN=<procname:pid>   working SYSTEM token source (diagnostic)
    //   B_FLAG=<n> B_HEX=<hex> [X_HEX=<hex>]      primary input
    //   B2_FLAG=<n> B2_HEX=<hex> [X2_HEX=<hex>]   fallback input
    //   ERR=SYS_NONE | ERR=UNWRAP_FAIL | ERR=PRIME_FAIL
    public static string Run(string appbB64, string asterB64) {
        StringBuilder log = new StringBuilder();
        List<byte[]> inputs = new List<byte[]>();
        foreach (string s in new string[] { appbB64, asterB64 }) {
            if (s == null || s.Length == 0) continue;
            try {
                byte[] all = Convert.FromBase64String(s);
                if (all.Length > 4 && all[0] == 0x41 && all[1] == 0x50 && all[2] == 0x50 && all[3] == 0x42) {
                    byte[] blob = new byte[all.Length - 4];
                    Array.Copy(all, 4, blob, 0, blob.Length);
                    inputs.Add(blob);
                }
                Array.Clear(all, 0, all.Length);
            } catch { }
        }
        if (inputs.Count == 0) { log.AppendLine("ERR=UNWRAP_FAIL"); return log.ToString(); }

        // SELF-PRIME: one DPAPI roundtrip as ourselves BEFORE any impersonated
        // call. Proven empirically (Stage 0): if the first DPAPI call in the
        // process happens under an impersonation token, every impersonated
        // call fails with gle=127 and the broken state persists for the
        // process lifetime. Priming as self initializes per-process DPAPI
        // state correctly; impersonated calls afterwards work. Do not remove
        // or move below the token enumeration.
        if (!Roundtrip()) { log.AppendLine("ERR=PRIME_FAIL"); return log.ToString(); }

        IntPtr tok0;
        if (OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST | TOKEN_QUERY, out tok0)) {
            LUID luid;
            if (LookupPrivilegeValue(null, "SeDebugPrivilege", out luid)) {
                TOKPRIV tp = new TOKPRIV();
                tp.count = 1; tp.p.luid = luid; tp.p.attr = SE_ENABLED;
                AdjustTokenPrivileges(tok0, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
            }
            CloseHandle(tok0);
        }

        List<string> names = new List<string>();
        List<uint> pids = new List<uint>();
        IntPtr snap = CreateToolhelp32Snapshot(SNAPPROC, 0);
        if (snap.ToInt64() != -1) {
            PROCENTRY32 e = new PROCENTRY32();
            e.dwSize = (uint)Marshal.SizeOf(typeof(PROCENTRY32));
            if (Process32FirstW(snap, ref e)) {
                do {
                    IntPtr h = OpenProcess(QLI, false, e.pid);
                    if (h == IntPtr.Zero) continue;
                    IntPtr tok = IntPtr.Zero;
                    if (!OpenProcessToken(h, TOKEN_QUERY | TOKEN_DUPLICATE, out tok)) {
                        CloseHandle(h); continue;
                    }
                    if (SidOf(tok) == "S-1-5-18") { names.Add(e.name); pids.Add(e.pid); }
                    CloseHandle(tok); CloseHandle(h);
                } while (Process32NextW(snap, ref e));
            }
            CloseHandle(snap);
        }

        IntPtr chosen = IntPtr.Zero;
        string chosenName = "";
        for (int i = 0; i < pids.Count; i++) {
            IntPtr h = OpenProcess(QLI, false, pids[i]);
            if (h == IntPtr.Zero) continue;
            IntPtr tok = IntPtr.Zero;
            if (!OpenProcessToken(h, TOKEN_QUERY | TOKEN_DUPLICATE, out tok)) {
                CloseHandle(h); continue;
            }
            IntPtr d = IntPtr.Zero;
            if (!DuplicateToken(tok, SecurityImpersonation, out d)) {
                CloseHandle(tok); CloseHandle(h); continue;
            }
            CloseHandle(tok); CloseHandle(h);
            if (!ImpersonateLoggedOnUser(d)) { CloseHandle(d); continue; }
            bool ok = Roundtrip();
            RevertToSelf();
            if (ok) { chosen = d; chosenName = names[i] + ":" + pids[i]; break; }
            CloseHandle(d);
        }
        if (chosen == IntPtr.Zero) { log.AppendLine("ERR=SYS_NONE"); return log.ToString(); }
        log.AppendLine("CHOSEN=" + chosenName);

        bool any = false;
        try {
            string[] tags = new string[] { "B", "B2" };
            for (int i = 0; i < inputs.Count && i < 2; i++) {
                int before = log.Length;
                ProcessOne(inputs[i], chosen, tags[i], log);
                if (log.Length > before) any = true;
                Array.Clear(inputs[i], 0, inputs[i].Length);
            }
        } finally {
            if (chosen != IntPtr.Zero) CloseHandle(chosen);
            try { RevertToSelf(); } catch { }
        }
        if (!any) log.AppendLine("ERR=UNWRAP_FAIL");
        return log.ToString();
    }
}
`;

/** 是否已提权（`net session` 只有管理员能成功，本仓既有的判据）。结果缓存 */
let cachedElevated = null;
function isProcessElevated() {
    if (cachedElevated !== null) return cachedElevated;
    if (process.platform !== 'win32') {
        cachedElevated = false;
        return false;
    }
    try {
        execSync('net session', { stdio: 'ignore' });
        cachedElevated = true;
    } catch (_e) {
        cachedElevated = false;
    }
    return cachedElevated;
}

/** 把小助手的 ERR 码翻译成人话 */
function decodeHelperError(code) {
    if (code === 'SYS_NONE') {
        return '没有可用的 SYSTEM 上下文：请确认程序是以管理员身份运行的。';
    }
    if (code === 'UNWRAP_FAIL') {
        return 'APPB 密钥两层 DPAPI 都解不开，Cookie 无法解密。';
    }
    if (code === 'PRIME_FAIL') {
        return '解密助手自检失败（本机 DPAPI 不可用），Cookie 无法解密。';
    }
    return `解密助手失败（${code}）。`;
}

/**
 * 解出 32 字节 v20 主密钥。
 *
 * 流程：写 abe.cs 到本次导入的临时目录 → PowerShell 编译运行小助手
 * （提权进程内模拟 SYSTEM 令牌，两层 DPAPI，flag 3 顺手做 CNG）
 * → 读回 B（双层 DPAPI 产物）→ abeCrypto 派生。主备两个 APPB 字段
 * 依次试，第一个派生成功的即返回。
 *
 * .cs 与 .out 都落在本次导入的 tempRoot 里，importEdgeData 的 finally
 * 会整个删掉，不留残留。
 */
async function unwrapMasterKey(options) {
    const { primaryB64, fallbackB64, workDir, report } = options;
    if (!isProcessElevated()) {
        throw new Error('解密 Cookie 需要管理员权限：请以管理员身份运行本程序后重试。');
    }
    const csPath = path.join(workDir, 'abe.cs');
    const outPath = path.join(workDir, 'abe.out');
    fs.writeFileSync(csPath, ABE_CS_SOURCE, 'ascii');
    report && report('正在解密 Cookie 密钥…');
    const cmd = `Add-Type -Path '${csPath}'; [AbeKey]::Run('${primaryB64}','${fallbackB64}') | Out-File -FilePath '${outPath}' -Encoding ascii`;
    const r = spawnSync('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
        { windowsHide: true, timeout: ABE_HELPER_TIMEOUT_MS });
    if (r.error) {
        throw new Error(`解密助手启动失败：${r.error.message}`);
    }
    if (!isFile(outPath)) {
        throw new Error('解密助手没有返回结果。');
    }
    const lines = fs.readFileSync(outPath, 'ascii').split(/\r?\n/);
    const get = (k) => {
        const prefix = `${k}=`;
        const hit = lines.find((x) => x.startsWith(prefix));
        return hit ? hit.slice(prefix.length).trim() : '';
    };
    const err = get('ERR');
    if (err) {
        throw new Error(decodeHelperError(err));
    }
    const candidates = [];
    if (get('B_HEX')) {
        candidates.push({ blobHex: get('B_HEX'), xHex: get('X_HEX') });
    }
    if (get('B2_HEX')) {
        candidates.push({ blobHex: get('B2_HEX'), xHex: get('X2_HEX') });
    }
    for (const cand of candidates) {
        try {
            const parsed = abe.parseKeyBlob(abe.hexToBytes(cand.blobHex));
            const x = cand.xHex ? abe.hexToBytes(cand.xHex) : null;
            return await abe.deriveMasterKey(parsed, x);
        } catch (_e) { /* 试下一个候选 */ }
    }
    throw new Error('APPB 密钥派生失败，Cookie 无法解密。');
}

/**
 * 把 Cookies 表的一行转成条目（需要主密钥）。
 *
 * v20 行走离线解密；非 v20 但 value 列有明文的（历史遗留写法）直接用；
 * 两边都空的是坏行，返回 null 由调用方计数跳过 —— 不抛错，
 * 一条坏行不该让一千多条好 cookie 全丢。
 */
async function cookieRowToEntry(row, masterKey) {
    const enc = row.encrypted_value;
    const bytes = enc instanceof Uint8Array ? enc : null;
    const isV20 = !!bytes && bytes.length > 3
        && bytes[0] === 0x76 && bytes[1] === 0x32 && bytes[2] === 0x30;
    let value;
    if (isV20) {
        const plaintext = await abe.decryptV20Cookie(masterKey, bytes);
        const parts = abe.splitCookiePlaintext(plaintext);
        value = abe.decodeCookieValue(parts.valueBytes);
    } else if (typeof row.value === 'string' && row.value) {
        value = row.value;
    } else {
        return null;
    }
    return normalizeSqliteCookie(row, value);
}

/**
 * 离线读 Cookie：Local State 取 APPB → 解出主密钥 → 读库逐条解密。
 *
 * 不再复制 profile、不再启动 Edge（用户要求）。Edge 必须事先退出
 * （killEdgeProcesses 在 importEdgeData 开头已做），否则这里读到 LOCKED。
 * 返回 `{ cookies }` 或 `{ cookies: [], error }` —— 与旧 CDP 路径同形，
 * 调用方不用改。
 */
async function readCookiesOffline(options) {
    const { userDataDir, profileDir, tempDb, tempRoot, warnings, report } = options;
    const localState = readJson(path.join(userDataDir, 'Local State'));
    const osCrypt = (localState && localState.os_crypt) || {};
    const primaryB64 = typeof osCrypt.app_bound_encrypted_key === 'string'
        ? osCrypt.app_bound_encrypted_key : '';
    const fallbackB64 = typeof osCrypt.aster_app_bound_encrypted_key === 'string'
        ? osCrypt.aster_app_bound_encrypted_key : '';
    if (!primaryB64 && !fallbackB64) {
        return { cookies: [], error: 'Local State 里没有 APPB 密钥，Edge 无法解密 Cookie。' };
    }

    let masterKey;
    try {
        masterKey = await unwrapMasterKey({ primaryB64, fallbackB64, workDir: tempRoot, report });
    } catch (e) {
        return { cookies: [], error: e.message };
    }

    const opened = openSqliteCopy(path.join(profileDir, 'Network', 'Cookies'), tempDb);
    if (opened.error) {
        return {
            cookies: [],
            error: opened.error === 'LOCKED'
                ? 'Cookie 库被占用，本次未能导入 Cookie。'
                : `读不到 Cookies 库：${describeSqliteError(opened.error)}`,
        };
    }
    let rows = queryAll(opened.db, `
        SELECT host_key, name, value, encrypted_value, path,
               CAST(expires_utc AS TEXT) AS expires_utc,
               is_secure, is_httponly, samesite, has_expires
        FROM cookies
    `);
    if (!rows) {
        // Edge 改了表结构也不至于全丢：退到最小列集
        rows = queryAll(opened.db, `
            SELECT host_key, name, value, encrypted_value, path
            FROM cookies
        `);
    }
    try { opened.db.close(); } catch (_e) { /* 已关 */ }
    if (!rows) {
        warnings.push({ category: 'cookies', message: 'Cookies 表结构不认识，已跳过 Cookie。' });
        return { cookies: [] };
    }

    const cookies = [];
    let skipped = 0;
    for (const row of rows) {
        try {
            const entry = await cookieRowToEntry(row, masterKey);
            if (entry) {
                cookies.push(entry);
            } else {
                skipped++;
            }
        } catch (_e) {
            skipped++;
        }
    }
    if (skipped > 0) {
        warnings.push({ category: 'cookies', message: `${skipped} 条 Cookie 解不开，已跳过。` });
    }
    return { cookies };
}

/* ========================================================================== */
/*                                   探测                                      */
/* ========================================================================== */

/**
 * 判据：Cookies 库现在能不能被共享读打开。
 *
 * 不去枚举进程名 —— 那会把「用户装了 Edge 但没开」和「别的程序恰好同名」
 * 混在一起，而且 tasklist 调用要几十毫秒。直接试真正要紧的那件事：
 * 这个文件现在打不打得开。打得开就是没被独占，打不开就是要先退 Edge。
 *
 * 用 openSync 而不是 readFileSync：这个库本机实测 851 KB，整读只为探一个
 * 锁太浪费，而两者的成败判据完全一致（都是共享模式打开，实测同为 EBUSY）。
 * statSync 在这里没用 —— 元数据不受共享模式限制，锁着也照样成功。
 */
function isCookiesLocked(userDataDir, profileId) {
    const target = path.join(userDataDir, profileId, 'Network', 'Cookies');
    if (!isFile(target)) return false;              // 没有库文件不算"被锁"
    let fd = null;
    try {
        fd = fs.openSync(target, 'r');
        return false;
    } catch (_e) {
        return true;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_e) { /* 已经关了 */ } }
    }
}

/**
 * 杀掉所有 Edge 进程，并等它真正释放 Cookie 库。
 *
 * 为什么要杀：Edge 关掉窗口后仍有一批后台进程常驻（主进程带
 * `--no-startup-window`，实测 9 个），它们持有 `Network/Cookies` 的**独占锁**。
 * 三种读法（共享读 / 只读 SQLite / CopyFileW）全部 EBUSY，Cookie 就导不出来。
 *
 * 用 `taskkill /IM msedge.exe /T /F` 而不是优雅关闭：这里的目标正是那些
 * **没有窗口**的后台进程，没有窗口可关。离线读库不需要 Edge 配合，
 * 杀完直接读（见 readCookiesOffline）。
 *
 * 杀完必须**轮询等锁释放**，不能立刻往下走：进程退出与句柄释放之间有时间差，
 * 实测立刻读仍然是 EBUSY。
 *
 * 返回：{ killed: 是否真的执行过杀进程, unlocked: 库现在是否可读 }
 */
async function killEdgeProcesses(userDataDir, profileId, report) {
    const lockedBefore = isCookiesLocked(userDataDir, profileId);
    if (!lockedBefore) return { killed: false, unlocked: true };

    report && report('正在关闭 Edge 后台进程…');
    try {
        // /T 连子进程一起杀（渲染进程、GPU 进程都是子进程），/F 强制
        spawn('taskkill', ['/IM', 'msedge.exe', '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch (_e) {
        return { killed: false, unlocked: false };
    }

    const deadline = Date.now() + EDGE_KILL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        if (!isCookiesLocked(userDataDir, profileId)) return { killed: true, unlocked: true };
    }
    return { killed: true, unlocked: false };
}

/**
 * 探测本机装了哪些 Edge、各有哪些 profile、每个 profile 里有多少数据。
 *
 * 只读 `Local State` / `Bookmarks` 的文件大小与条目数，**不打开任何 SQLite** ——
 * 探测要快，而且不能因为某个库被锁就让整个列表失败。
 */
function detectEdgeProfiles() {
    for (const channel of EDGE_CHANNELS) {
        const userDataDir = edgeUserDataCandidates(channel).find(isDir);
        if (!userDataDir) continue;

        const executable = edgeExecutableCandidates(channel).find(isFile) || '';
        const localState = readJson(path.join(userDataDir, 'Local State'));
        const version = readEdgeVersion(userDataDir);
        const profiles = profilesFromLocalState(localState, userDataDir);

        const detailed = profiles.map((profile) => {
            const bookmarksFile = path.join(profile.dir, 'Bookmarks');
            let bookmarkCount = 0;
            let folderCount = 0;
            if (isFile(bookmarksFile)) {
                const tree = parseEdgeBookmarks(readJson(bookmarksFile));
                const all = [...flattenBookmarkNodes(tree.bar), ...flattenBookmarkNodes(tree.other)];
                bookmarkCount = all.length;
                folderCount = countBookmarkNodes(tree.bar) + countBookmarkNodes(tree.other) - bookmarkCount;
            }
            return {
                ...profile,
                exists: isDir(profile.dir),
                bookmarkCount,
                folderCount,
                hasCookies: isFile(path.join(profile.dir, 'Network', 'Cookies')),
                hasHistory: isFile(path.join(profile.dir, 'History')),
            };
        }).filter((profile) => profile.exists);

        if (detailed.length === 0) continue;

        return {
            available: true,
            channel: channel.id,
            label: channel.label,
            version,
            userDataDir,
            executable,
            profiles: detailed,
        };
    }

    return {
        available: false,
        reason: '没有找到 Edge 的 User Data 目录。',
        profiles: [],
    };
}

/* ========================================================================== */
/*                                 导入主流程                                   */
/* ========================================================================== */

/** 归一化导入选项 */
function normalizeImportOptions(options) {
    const raw = options && typeof options === 'object' ? options : {};
    const include = raw.include && typeof raw.include === 'object' ? raw.include : {};
    return {
        profileId: typeof raw.profileId === 'string' && raw.profileId ? raw.profileId : 'Default',
        userDataDir: typeof raw.userDataDir === 'string' ? raw.userDataDir : '',
        include: {
            bookmarks: include.bookmarks !== false,
            favicons: include.favicons !== false,
            history: include.history !== false,
            autofill: include.autofill !== false,
            accounts: include.accounts !== false,
            cookies: include.cookies !== false,
            searchEngine: include.searchEngine !== false,
        },
        historyLimit: Number.isFinite(raw.historyLimit) ? Math.max(0, Math.floor(raw.historyLimit)) : HISTORY_LIMIT,
        autofillLimit: Number.isFinite(raw.autofillLimit) ? Math.max(0, Math.floor(raw.autofillLimit)) : AUTOFILL_LIMIT,
        accountLimit: Number.isFinite(raw.accountLimit) ? Math.max(0, Math.floor(raw.accountLimit)) : ACCOUNT_LIMIT,
    };
}

/** 读书签（纯文件，不需要 SQLite） */
function readBookmarksFromProfile(profileDir, warnings) {
    const file = path.join(profileDir, 'Bookmarks');
    if (!isFile(file)) {
        warnings.push({ category: 'bookmarks', message: '这个 profile 里没有 Bookmarks 文件。' });
        return null;
    }
    const json = readJson(file);
    if (!json) {
        warnings.push({ category: 'bookmarks', message: 'Bookmarks 文件解析失败，可能已损坏。' });
        return null;
    }
    return parseEdgeBookmarks(json);
}

/** 读 favicon（SQLite） */
function readFaviconsFromProfile(profileDir, tempDir, warnings) {
    const opened = openSqliteCopy(path.join(profileDir, 'Favicons'), tempDir);
    if (opened.error) {
        if (opened.error !== '文件不存在') {
            warnings.push({ category: 'favicons', message: `读不到 Favicons：${describeSqliteError(opened.error)}` });
        }
        return new Map();
    }

    const rows = queryAll(opened.db, `
        SELECT im.page_url AS page_url,
               fb.image_data AS image_data,
               fb.width AS width,
               fb.height AS height
        FROM icon_mapping im
        JOIN favicon_bitmaps fb ON fb.icon_id = im.icon_id
        WHERE fb.image_data IS NOT NULL AND length(fb.image_data) > 0
    `);
    try { opened.db.close(); } catch (_e) { /* 已关 */ }

    if (!rows) {
        warnings.push({ category: 'favicons', message: 'Favicons 表结构不认识，已跳过图标。' });
        return new Map();
    }
    return selectFavicons(rows);
}

/** 读历史（SQLite） */
function readHistoryFromProfile(profileDir, tempDir, limit, warnings) {
    if (limit <= 0) return [];
    const opened = openSqliteCopy(path.join(profileDir, 'History'), tempDir);
    if (opened.error) {
        if (opened.error !== '文件不存在') {
            warnings.push({ category: 'history', message: `读不到 History：${describeSqliteError(opened.error)}` });
        }
        return [];
    }

    // CAST(... AS TEXT)：last_visit_time 是 1601 年起的微秒，超过 2^53，
    // 让 SQLite 以整数返回会在 number/bigint 之间产生分歧，转文本最稳
    const rows = queryAll(opened.db, `
        SELECT url AS url,
               title AS title,
               visit_count AS visit_count,
               CAST(last_visit_time AS TEXT) AS last_visit_time
        FROM urls
        WHERE hidden = 0 AND url IS NOT NULL AND url != ''
        ORDER BY last_visit_time DESC
        LIMIT ${limit}
    `);
    try { opened.db.close(); } catch (_e) { /* 已关 */ }

    if (!rows) {
        warnings.push({ category: 'history', message: 'History 表结构不认识，已跳过历史。' });
        return [];
    }

    return rows.map((row) => ({
        url: String(row.url || ''),
        title: String(row.title || ''),
        visitCount: Number(row.visit_count) || 0,
        lastVisit: webkitMicrosToMs(row.last_visit_time),
    })).filter((entry) => entry.url);
}

/** 读自动填充（SQLite） */
function readAutofillFromProfile(profileDir, tempDir, limit, warnings) {
    if (limit <= 0) return [];
    const opened = openSqliteCopy(path.join(profileDir, 'Web Data'), tempDir);
    if (opened.error) {
        if (opened.error !== '文件不存在') {
            warnings.push({ category: 'autofill', message: `读不到 Web Data：${describeSqliteError(opened.error)}` });
        }
        return [];
    }

    const rows = queryAll(opened.db, `
        SELECT name AS name, value AS value, count AS use_count
        FROM autofill
        WHERE name IS NOT NULL AND value IS NOT NULL
        ORDER BY count DESC
        LIMIT ${limit}
    `);
    try { opened.db.close(); } catch (_e) { /* 已关 */ }

    if (!rows) {
        warnings.push({ category: 'autofill', message: 'Web Data 表结构不认识，已跳过自动填充。' });
        return [];
    }

    return rows.map((row) => ({
        name: String(row.name || ''),
        value: String(row.value || ''),
        count: Number(row.use_count) || 0,
    })).filter((entry) => entry.name);
}

/**
 * 读账号（用户名）。
 *
 * **用户名是明文**：`Login Data` 的 `logins.username_value` 没有加密 ——
 * 实测本机 131 行里 120 行有用户名，全部是可读文本（邮箱、手机号、昵称）。
 * 加密的只有 `password_value`（v20 App-Bound，第三方解不开）。
 *
 * 所以这一项**能导**，而且正是用户说的"账号"。它和密码是两回事：
 * 密码解不开是 Windows 的设计边界，用户名解不开只是没去读。
 *
 * 不导 `blacklisted_by_user=1` 的行 —— 那是用户在 Edge 里选的「从不保存」，
 * 把它导进来等于无视用户的明确选择。
 */
function readAccountsFromProfile(profileDir, tempDir, limit, warnings) {
    if (limit <= 0) return [];
    const opened = openSqliteCopy(path.join(profileDir, 'Login Data'), tempDir);
    if (opened.error) {
        if (opened.error !== '文件不存在') {
            warnings.push({ category: 'accounts', message: `读不到 Login Data：${describeSqliteError(opened.error)}` });
        }
        return [];
    }

    const rows = queryAll(opened.db, `
        SELECT origin_url AS origin_url,
               username_value AS username,
               times_used AS times_used,
               CAST(date_last_used AS TEXT) AS date_last_used
        FROM logins
        WHERE username_value IS NOT NULL AND username_value != ''
          AND blacklisted_by_user = 0
        ORDER BY times_used DESC
        LIMIT ${limit}
    `);
    try { opened.db.close(); } catch (_e) { /* 已关 */ }

    if (!rows) {
        warnings.push({ category: 'accounts', message: 'Login Data 表结构不认识，已跳过账号。' });
        return [];
    }

    // 同一个用户名会在多个站点各存一行，**不按值去重** —— 它们是不同站点的
    // 登录名，合并会丢掉"这个账号在哪些站用过"这条信息
    return rows.map((row) => ({
        origin: String(row.origin_url || ''),
        username: String(row.username || ''),
        timesUsed: Number(row.times_used) || 0,
        lastUsed: webkitMicrosToMs(row.date_last_used),
    })).filter((entry) => entry.username);
}

/** 读默认搜索引擎（纯 JSON） */
function readSearchEngineFromProfile(profileDir) {
    const prefs = readJson(path.join(profileDir, 'Preferences'));
    const data = prefs && prefs.default_search_provider_data && prefs.default_search_provider_data.template_url_data;
    if (!data || typeof data !== 'object') return null;
    const keyword = typeof data.keyword === 'string' ? data.keyword : '';
    const shortName = typeof data.short_name === 'string' ? data.short_name : '';
    const url = typeof data.url === 'string' ? data.url : '';
    if (!shortName && !keyword) return null;
    return { keyword, shortName, url };
}

/** 把 openSqliteCopy 的错误码翻译成人话 */
function describeSqliteError(error) {
    if (error === 'LOCKED') return '文件被 Edge 独占（请完全退出 Edge 后重试）';
    return error;
}

/**
 * 执行一次导入。
 *
 * **逐项报告**：每个来源要么有数据、要么在 `warnings` 里有一条带原因的说明。
 * 绝不静默跳过 —— 用户看到"导入成功"却少了一批数据、且无从知道少了什么，
 * 比明确报错糟糕得多。
 */
async function importEdgeData(options, report) {
    const opts = normalizeImportOptions(options);
    const warnings = [];
    const stats = { bookmarks: 0, folders: 0, favicons: 0, history: 0, autofill: 0, accounts: 0, cookies: 0 };

    const detected = detectEdgeProfiles();
    if (!detected.available) {
        return { ok: false, error: detected.reason, warnings, stats };
    }

    const userDataDir = opts.userDataDir || detected.userDataDir;
    const profileDir = path.join(userDataDir, opts.profileId);
    if (!isDir(profileDir)) {
        return { ok: false, error: `找不到 profile 目录：${profileDir}`, warnings, stats };
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-import-'));
    const tempDb = path.join(tempRoot, 'db');
    fs.mkdirSync(tempDb, { recursive: true });

    /**
     * **导入之前先杀掉 Edge 的全部后台进程**，然后才读任何东西。
     *
     * 放在最前面而不是只放在 Cookie 那一段：Edge 关掉窗口后常驻的那批进程
     * （主进程带 `--no-startup-window`，实测 9 个）持有的是**整份 profile** 里
     * 多个 SQLite 的锁 —— Cookies、History、Web Data、Login Data 都受影响。
     * 只挡 Cookie 的话，历史/自动填充/账号仍会在被锁的库上读，
     * 表现是"有的项导进来了、有的莫名其妙是空的"。
     */
    if (detected.executable) {
        const killResult = await killEdgeProcesses(userDataDir, opts.profileId, report);
        if (killResult.killed && !killResult.unlocked) {
            warnings.push({
                category: 'edge',
                message: '已尝试关闭 Edge，但它的数据文件仍被占用，本次可能有部分内容读不到。',
            });
        }
    }

    const result = {
        ok: true,
        edge: {
            label: detected.label,
            version: detected.version,
            profileId: opts.profileId,
            userDataDir,
        },
        bookmarks: null,
        history: [],
        autofill: [],
        accounts: [],
        cookies: [],
        searchEngine: null,
        warnings,
        stats,
    };

    try {
        if (opts.include.bookmarks) {
            report && report('正在读取收藏夹…');
            const tree = readBookmarksFromProfile(profileDir, warnings);
            if (tree) {
                if (opts.include.favicons) {
                    report && report('正在读取网站图标…');
                    const favicons = readFaviconsFromProfile(profileDir, tempDb, warnings);
                    attachFavicons(tree.bar, favicons);
                    attachFavicons(tree.other, favicons);
                    for (const extra of tree.extras) attachFavicons(extra, favicons);
                    stats.favicons = favicons.size;
                }
                result.bookmarks = tree;
                stats.bookmarks = flattenBookmarkNodes(tree.bar).length + flattenBookmarkNodes(tree.other).length
                    + tree.extras.reduce((sum, node) => sum + flattenBookmarkNodes(node).length, 0);
                const folderTotal = countBookmarkNodes(tree.bar) + countBookmarkNodes(tree.other)
                    + tree.extras.reduce((sum, node) => sum + countBookmarkNodes(node), 0);
                stats.folders = Math.max(0, folderTotal - stats.bookmarks);
            }
        }

        if (opts.include.history) {
            report && report('正在读取浏览历史…');
            result.history = readHistoryFromProfile(profileDir, tempDb, opts.historyLimit, warnings);
            stats.history = result.history.length;
        }

        if (opts.include.autofill) {
            report && report('正在读取自动填充…');
            result.autofill = readAutofillFromProfile(profileDir, tempDb, opts.autofillLimit, warnings);
            stats.autofill = result.autofill.length;
        }

        if (opts.include.accounts) {
            report && report('正在读取账号…');
            result.accounts = readAccountsFromProfile(profileDir, tempDb, opts.accountLimit, warnings);
            stats.accounts = result.accounts.length;
        }

        if (opts.include.searchEngine) {
            result.searchEngine = readSearchEngineFromProfile(profileDir);
        }

        if (opts.include.cookies) {
            // 离线解密不再需要 msedge.exe —— 可执行文件找得到找不到都不影响。
            const cookieResult = await readCookiesOffline({
                userDataDir,
                profileId: opts.profileId,
                profileDir,
                tempDb,
                tempRoot,
                warnings,
                report,
            });
            if (cookieResult.error) {
                warnings.push({ category: 'cookies', message: cookieResult.error });
            } else {
                result.cookies = cookieResult.cookies;
                stats.cookies = cookieResult.cookies.length;
            }
        }

        return result;
    } finally {
        try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_e) { /* 临时目录清不掉不影响结果 */ }
    }
}

module.exports = {
    // 常量（测试与界面共用）
    FAVICON_MAX_BYTES,
    FAVICON_BUDGET_BYTES,
    HISTORY_LIMIT,
    AUTOFILL_LIMIT,
    ACCOUNT_LIMIT,
    WEBKIT_EPOCH_OFFSET_MS,
    PROFILE_DIR_RE,
    // 纯判据
    webkitMicrosToMs,
    convertEdgeBookmarkNode,
    parseEdgeBookmarks,
    flattenBookmarkNodes,
    countBookmarkNodes,
    faviconScore,
    detectImageMime,
    selectFavicons,
    attachFavicons,
    normalizeSqliteCookie,
    buildCookieUrl,
    profilesFromLocalState,
    edgeExecutableCandidates,
    edgeUserDataCandidates,
    describeSqliteError,
    normalizeImportOptions,
    isCookiesLocked,
    isProcessElevated,
    // 接线
    detectEdgeProfiles,
    importEdgeData,
    killEdgeProcesses,
    unwrapMasterKey,
    readCookiesOffline,
    loadSqlite,
};
