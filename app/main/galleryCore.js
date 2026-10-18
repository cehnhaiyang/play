'use strict';
/**
 * 画廊引擎的通用部分：出站请求、图片落盘、画廊目录产物、页码范围。
 *
 * 这个文件里**不允许出现任何站点名**。站点名一旦写进来，下一个要接入的站点
 * 就只能复制粘贴一遍这些逻辑（翻页、限速、去重、落盘、续传全都一样）。
 * 每个站点自己的 URL 形状、HTML 结构、字段口径，一律留在各自的 provider 里
 * （acgmhoService.js / ehentaiService.js），由 galleryRegistry.js 组装。
 *
 * 本文件不维护出网逻辑：代理、隧道、agent 由 main.js 的全局网络层接管 ——
 * 这里照常写 https.get 就是走代理的，不需要传 agent，也不需要知道代理存在。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

/* -------------------------------------------------------------------------- */
/*                              站点请求身份                                    */
/* -------------------------------------------------------------------------- */
// 抓取时使用的 UA 与默认请求头。
//
// UA 由 main.js 在启动时推入（`setUserAgent`）：它读引擎自己那一份
// （`app.userAgentFallback`，会话就绪后再对齐会话实际值）。这里**不自造** UA——
// cf_clearance 与 UA 绑定，Node 直抓必须与"拿到凭证的那个浏览器"完全一致，
// 自造一份就是两个来源，表现为"验证过了但搜索仍 403"。
//
// 本模块不 require electron：那会让它无法被 test/ 直接 require 求值。
const HEADERS = {
    'User-Agent': '',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** 把 UA 换成浏览器会话的真实值（由 main.js 在启动与会话就绪后调用） */
function setUserAgent(value) {
    const next = String(value || '').trim();
    if (!next || next === HEADERS['User-Agent']) return false;
    HEADERS['User-Agent'] = next;
    return true;
}

function getUserAgent() {
    return HEADERS['User-Agent'];
}

/* -------------------------------------------------------------------------- */
/*                                  工具                                       */
/* -------------------------------------------------------------------------- */
// 有限并发 worker 池：结果按输入顺序回填，调用方自行在 worker 内吞掉单项错误。
// 用途：fetch/download/save 的多页并发，进度由 worker 完成时各自上报。
function mapWithConcurrency(list, concurrency, worker) {
    const n = list.length;
    const out = new Array(n);
    let cursor = 0;
    const lanes = Math.min(Math.max(1, Number(concurrency) || 1), n);
    const runners = Array.from({ length: lanes }, async () => {
        while (true) {
            const i = cursor;
            cursor += 1;
            if (i >= n)
                return;
            out[i] = await worker(list[i], i);
        }
    });
    return Promise.all(runners).then(() => out);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function unescapeHtml(html) {
    return html
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#160;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function stripTags(s) {
    if (!s) return '';
    // 折叠连续空白：站点模板用大量缩进/换行排版标题，不折叠会得到
    // "标题\n                         - 原神…" 这类带大段空白的字符串，
    // 直接进播放列表/文件名（文件名里还会变成一串下划线）。
    return unescapeHtml(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/* -------------------------------------------------------------------------- */
/*                                  HTTP GET                                   */
/* -------------------------------------------------------------------------- */
/**
 * 抓取 HTML 并跟踪 302 最终地址：站内搜索 /q/xxx-N.html 会 302 到规范页
 * （如 /tags/sister.html），后续翻页必须基于规范地址，否则服务端永远回第 1 页。
 * extraHeaders：调用方可注入 Cookie（如 Electron 会话里的 Cloudflare 放行凭证），
 * 键与 HEADERS 冲突时调用方优先。
 */
function httpGetFinal(url, referer = null, timeout = 30000, retries = 3, redirects = 5, extraHeaders = null) {
    return new Promise((resolve, reject) => {
        // 链内 cookie jar：跳转链中途种下的 cookie（如 www 的会话标识）后续跳要带上，
        // 否则跨子域（www → search.acgmho.com）直接裸访，容易被风控 403。
        const jar = [];
        const rememberCookies = (setCookie) => {
            for (const c of setCookie || []) {
                const pair = String(c).split(';')[0].trim();
                if (!pair || !pair.includes('='))
                    continue;
                const name = pair.slice(0, pair.indexOf('='));
                const idx = jar.findIndex((j) => j.slice(0, j.indexOf('=')) === name);
                if (idx >= 0)
                    jar[idx] = pair;
                else
                    jar.push(pair);
            }
        };
        if (extraHeaders && extraHeaders.Cookie) {
            // Cookie 头是 "a=1; b=2" 拼串：必须按 ';' 拆成多项再记。
            // 之前整个串当一项塞进去，split(';')[0] 只留下第一个 cookie，
            // 主进程拼好的多凭证（cf_clearance + 会话）到链里只剩一个，搜索 403 雪上加霜。
            rememberCookies(String(extraHeaders.Cookie).split(';'));
        }
        function attempt(n, currentUrl, remaining) {
            const headers = { ...HEADERS, ...(extraHeaders || {}) };
            delete headers.Cookie;
            if (referer) {
                headers.Referer = referer;
            }
            if (jar.length) {
                headers.Cookie = jar.join('; ');
            }
            // 单次尝试的收尾守卫：超时、连接错误、响应中断会在同一毫秒内接连触发多个事件
            // （实测 truncate: res.aborted + res.error + res.close 同帧到达；slow: req.timeout
            // 紧跟 req.error）。此前每个事件各自排一次重试，请求数按 2^n 放大——retries=3
            // 实测打出 7 个请求，站点限流正是被自己触发的，用户看到 429/"搜索过于频繁"。
            // settled 保证一次尝试只结算一次：要么成功、要么排一次重试、要么报错。
            let settled = false;
            const fail = (err) => {
                if (settled)
                    return;
                settled = true;
                // 代理配置类错误（端口不是 SOCKS5、要求认证、密码错）重试多少次结果都一样，
                // 只会把一句明确的话拖成 15 秒 ×3 的干等。直接给结论，让用户去改配置。
                if (err && err.proxyConfigError) {
                    reject(err);
                    return;
                }
                if (n < retries) {
                    setTimeout(() => attempt(n + 1, currentUrl, remaining), 1000 * n);
                }
                else {
                    reject(err);
                }
            };
            const giveUp = (err) => {
                if (settled)
                    return;
                settled = true;
                reject(err);
            };
            const client = currentUrl.startsWith('https:') ? https : http;
            // 不传 agent：main.js 的全局网络层已把 http/https 的 globalAgent
            // 换成隧道 agent，这里照常写就自动走代理。
            const req = client.get(currentUrl, { headers, timeout }, (res) => {
                rememberCookies(res.headers['set-cookie']);
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    if (remaining <= 0) {
                        res.resume();
                        giveUp(new Error(`重定向次数过多: ${currentUrl}`));
                        return;
                    }
                    // 中文站 Location 常带未编码的原始 UTF-8（如 /q/汤…-1-<md5>.html）：
                    // Node http 头按 latin1 给字符串，直接 new URL 会把"UTF-8 字节误读成 latin1 字符"
                    // 再百分编码一次（%E6%B9%AF → %C3%A6…），搜索子域对这类坏 URL 直接 403。
                    // 先按 latin1 还原字节、按 UTF-8 解码；已编码的纯 ASCII 路径不受影响。
                    const location = Buffer.from(String(res.headers.location), 'latin1').toString('utf-8');
                    const redirectUrl = new URL(location, currentUrl).toString();
                    res.resume();
                    // 已交接给下一跳：本跳任何后到事件都不再结算，避免与跳转链抢 resolve/reject
                    settled = true;
                    attempt(n, redirectUrl, remaining - 1);
                    return;
                }
                if (res.statusCode && res.statusCode >= 400) {
                    res.resume();
                    // 4xx 不重试：404 是资源不存在、403 是风控/挑战拦路，重试只会白等退避时间。
                    // 之前全状态都重试：auto 探测 8 候选 × 3 次 × 退避，死 gid 一次探测被拖慢数十秒。
                    // 408（超时）/429（限流）与 5xx 例外，仍按退避重试。
                    const retryable = res.statusCode === 408 || res.statusCode === 429 || res.statusCode >= 500;
                    if (retryable)
                        fail(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
                    else
                        giveUp(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
                    return;
                }
                const chunks = [];
                let received = 0;
                const MAX_BODY = 10 * 1024 * 1024;
                res.on('data', (c) => {
                    received += c.length;
                    if (received > MAX_BODY) {
                        req.destroy();
                        giveUp(new Error(`响应过大，已中断: ${currentUrl}`));
                        return;
                    }
                    chunks.push(c);
                });
                res.on('end', () => {
                    if (settled)
                        return;
                    settled = true;
                    resolve({ html: Buffer.concat(chunks).toString('utf-8'), url: currentUrl });
                });
                // 响应中途断流（代理/VPN 掉线、服务端提前关闭）：req 不报错，只在 res 上体现。
                // 此前没有任何 res 级错误监听，promise 永不结算 → 频道列表/探测/抓页整个挂死，
                // UI 一直转圈且没有任何报错（搜索路径 20s 竞速兜底也救不了非搜索频道）。
                res.on('error', (err) => fail(err));
                // close 是必然事件：complete=false 说明响应被截断，用它兜住 aborted/未捕获的断流
                res.on('close', () => {
                    if (!res.complete)
                        fail(new Error(`响应被中断（连接提前关闭）: ${currentUrl}`));
                });
            });
            req.on('timeout', () => {
                req.destroy();
                fail(new Error(`Timeout fetching ${currentUrl}`));
            });
            req.on('error', (err) => {
                fail(err);
            });
        }
        attempt(1, url, redirects);
    });
}
function httpGet(url, referer = null, timeout = 30000, retries = 3, redirects = 5) {
    return httpGetFinal(url, referer, timeout, retries, redirects).then((r) => r.html);
}

/* -------------------------------------------------------------------------- */
/*                          Cloudflare 拦截页识别                               */
/* -------------------------------------------------------------------------- */
// Cloudflare managed 挑战页识别。挑战页标题随语言变化（英文 "Just a moment..."、
// 中文 "请稍候…"），单查英文标题会漏判；该页还带挑战脚本标记与验证文案，
// 两者结合判定。命中即"这不是结果页"，必须报错而不是解析成 0 条。
const CF_CHALLENGE_SCRIPT_RE = /_cf_chl_opt|cdn-cgi\/challenge-platform|challenges\.cloudflare\.com/i;
const CF_CHALLENGE_TEXT_RE =
    /just a moment|请稍候|安全验证|正在验证|正在进行安全验证|checking your browser|attention required|verify you are human/i;
function isCloudflareChallengePage(html) {
    if (!html) return false;
    return CF_CHALLENGE_SCRIPT_RE.test(html) && CF_CHALLENGE_TEXT_RE.test(html);
}

// Cloudflare 5xx 错误页（如 520 origin 挂掉）不是结果页也不是挑战页：
// 误收会导致"解析出 0 条 → 未找到"，比挑战页更隐蔽。
const CF_ERROR_TEXT_RE =
    /web server is returning|error code \d{3}|bad gateway|gateway time-?out|origin is unreachable|未知错误/i;
function isCloudflareErrorPage(html) {
    if (!html) return false;
    return CF_ERROR_TEXT_RE.test(html) && /cloudflare|cdn-cgi/i.test(html);
}

/* -------------------------------------------------------------------------- */
/*                              图片落盘（可续传）                              */
/* -------------------------------------------------------------------------- */
// 单页图片下载的两道时限：IDLE 管"对端不发数据"，TOTAL 管"对端一直在发但永远发不完"。
// 单页图片通常几十 KB~几 MB，5 分钟总时限对慢速链路仍有余量。
const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 下载单页图片，支持 .part 断点续传。
 *
 * 不传 agent：main.js 的全局网络层已接管 globalAgent，图片请求与站点页一样走代理。
 * 曾按"图床必须直连"给它加过 agent 参数，实测不成立 —— hath.network 经 HTTP 代理
 * 10810 与 SOCKS5 10808 都能拿全图（与直连同样的字节数），那条特例是误判，
 * 留着只会让"某条路径忘了传 agent"变成静默的直连漏网。
 *
 * @param {string} url 图片直链
 * @param {string} dest 目标文件（不含 .part）
 * @param {string|null} referer 防盗链来源页
 * @param {(done:number,total:number)=>void} [onChunk] 进度回调
 */
function downloadImageWithResume(url, dest, referer, onChunk) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            resolve(fs.statSync(dest).size);
            return;
        }

        const part = dest + '.part';
        const resume = fs.existsSync(part);
        let pos = resume ? fs.statSync(part).size : 0;

        const headers = { ...HEADERS };
        if (referer) headers.Referer = referer;
        if (pos > 0) headers.Range = `bytes=${pos}-`;

        const client = url.startsWith('https:') ? https : http;
        // 写盘流提至外层：网络错误/超时时一并销毁，否则 fd 泄漏；
        // 写盘流自身错误（如磁盘满）也要接住，否则触发 unhandled 'error' 直接崩进程
        let fileStream = null;
        let req = null;
        let settled = false;
        // 双重看门狗。req 的 timeout 是"空闲超时"，对端只要还在滴流就永不触发：
        // 实测服务端挂死但保持连接时，这一页会永久占住一个并发位，整本下载卡住
        // 既不完成也不报错。因此按"距上次收到数据"独立计时（IDLE），
        // 并额外设一道总时限（TOTAL）兜住"每 3s 一个字节"这类永不空闲的滴流。
        let idleTimer = null;
        let totalTimer = null;
        const clearWatchdogs = () => {
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
        };
        const fail = (err) => {
            if (settled) return;
            settled = true;
            clearWatchdogs();
            try { if (fileStream) fileStream.destroy(); } catch (_e) { /* ignore */ }
            try { if (req) req.destroy(); } catch (_e) { /* ignore */ }
            reject(err);
        };
        const kickIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                fail(new Error(`下载停滞超过 ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s（对端无数据）: ${url}`));
            }, DOWNLOAD_IDLE_TIMEOUT_MS);
        };
        const armTotal = () => {
            totalTimer = setTimeout(() => {
                fail(new Error(`下载超过总时限 ${DOWNLOAD_TOTAL_TIMEOUT_MS / 1000}s 仍未完成: ${url}`));
            }, DOWNLOAD_TOTAL_TIMEOUT_MS);
        };
        const requestOptions = { headers, timeout: 120000 };
        req = client.get(url, requestOptions, (res) => {
            // 连接已建立：看门狗按"收到数据"续期，覆盖"连上后对端不再发数据"的挂死
            kickIdle();
            armTotal();
            // 416：Range 起点已到/超过文件末尾，说明 .part 其实已经收全（上次写完后
            // 在 rename 前被打断/崩溃，或服务端刚改小了文件）。此时必须把 .part 补完为
            // 正式文件——此前一律当失败抛出，且下一轮 Range 仍是同一位置，同一页永远
            // 下载失败、永远重试，用户看到"下载失败"卡死且目录里留着一个无法收敛的 .part。
            if (res.statusCode === 416 && pos > 0) {
                res.resume();
                if (settled) return;
                settled = true;
                clearWatchdogs();
                try {
                    fs.renameSync(part, dest);
                    resolve(fs.statSync(dest).size);
                } catch (renameErr) {
                    reject(renameErr);
                }
                return;
            }

            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, url).toString();
                res.resume();
                // 已超时 settled 的话不再起新下载：否则旧 promise 已 reject，
                // 内层下载还在后台写文件，变孤儿写盘
                if (settled) return;
                downloadImageWithResume(redirectUrl, dest, referer, onChunk).then(resolve).catch(reject);
                return;
            }

            // 错误页（403/404 欠费图等）按失败抛错：之前会把 HTML 错误页存成 .webp 坏图。
            // 走 fail 而非裸 reject：统一 settled 守卫，后到的 res end/error 不再重复结算
            if (!res.statusCode || res.statusCode >= 400) {
                res.resume();
                fail(new Error(`HTTP ${res.statusCode || '未知'} downloading ${url}`));
                return;
            }
            // 206 续传/200 全量之外（如 204/304 无内容）同样视为失败，避免落盘 0 字节坏图
            if (res.statusCode !== 200 && res.statusCode !== 206) {
                res.resume();
                fail(new Error(`HTTP ${res.statusCode} downloading ${url}`));
                return;
            }

            // 软 404：CDN 对不存在的图回 200 + text/html 错误页（实测站点图床如此）。
            // 此前只判 HTTP 状态码，于是把 HTML 错误页当图片写进 1.webp 并计入"成功页"，
            // 用户拿到一本每页都是 0 字节坏图的画廊，且下载报告显示全部成功。
            const ctype = String(res.headers['content-type'] || '').toLowerCase();
            if (ctype.includes('text/html') || ctype.includes('application/json')) {
                res.resume();
                fail(new Error(`图床返回了网页而非图片（Content-Type: ${ctype.split(';')[0]}）: ${url}`));
                return;
            }

            if (pos > 0 && res.statusCode === 200) {
                // 服务端不支持 Range（回 200 全量）：续传位置作废，从头写
                pos = 0;
            }

            const contentLength = parseInt(res.headers['content-length'] || '0', 10);
            const totalBytes = contentLength + pos;
            let doneBytes = pos;

            fileStream = fs.createWriteStream(part, { flags: pos > 0 ? 'a' : 'w' });
            fileStream.on('error', (err) => {
                try { res.destroy(); } catch (_e) { /* ignore */ }
                fail(err);
            });

            res.on('data', (chunk) => {
                kickIdle();
                fileStream.write(chunk);
                doneBytes += chunk.length;
                if (onChunk) {
                    onChunk(doneBytes, totalBytes);
                }
            });

            res.on('end', () => {
                if (settled) return;
                fileStream.end(() => {
                    if (settled) return;
                    settled = true;
                    clearWatchdogs();
                    try {
                        // 0 字节响应（图床偶发返回空体）不能算成功：此前会 rename 出 0 字节页文件
                        // 并 resolve(0)，上层把空文件留在画廊目录里，导入时该页是坏图；
                        // 且下次任务因 dest.size > 0 不成立会重下，形成"时好时坏"的页。
                        const size = fs.statSync(part).size;
                        if (size === 0) {
                            fs.unlinkSync(part);
                            reject(new Error(`图床返回了空响应（0 字节）: ${url}`));
                            return;
                        }
                        // 截断校验：声明了 Content-Length 却少收字节，说明连接是被"干净关闭"
                        // （FIN 而非 RST）截断的——res 不报 aborted，Node 直接发 end。
                        // 不校验就会把半张图当完整页 rename 成正式文件并计入"成功页"，
                        // 用户在画廊里看到下半截是灰色的破图。.part 保留，下轮 Range 续传补齐。
                        if (contentLength > 0 && size < totalBytes) {
                            reject(new Error(`响应被截断（收到 ${size}/${totalBytes} 字节），已保留断点待续传: ${url}`));
                            return;
                        }
                        fs.renameSync(part, dest);
                        resolve(fs.statSync(dest).size);
                    } catch (renameErr) {
                        reject(renameErr);
                    }
                });
            });

            res.on('error', (err) => {
                fail(err);
            });
        });

        req.on('error', (err) => {
            fail(err);
        });
        req.on('timeout', () => {
            fail(new Error(`Timeout downloading ${url}`));
        });
    });
}

/* -------------------------------------------------------------------------- */
/*                             画廊目录产物                                     */
/* -------------------------------------------------------------------------- */
// 默认下载根：优先 Electron 下载目录（随系统语言/用户设置走），
// CLI/未就绪时回退用户主目录（直接拼 USERPROFILE 在 Linux/mac 下为空会落到相对路径）
// rootName 按站点分目录（acgmho / ehentai）：不同站点的 gid 空间互不相干，
// 混在同一层里同号作品会撞名互踩。
function defaultGalleryRoot(rootName, gid, prefix) {
    let base = '';
    try {
        const { app } = require('electron');
        if (app && app.isReady && app.isReady() && app.getPath) {
            base = app.getPath('downloads');
        }
    } catch (_e) { /* 非 Electron 环境或未就绪，走回退 */ }
    if (!base) {
        try {
            base = path.join(os.homedir(), 'Downloads');
        } catch (_e) { /* ignore */ }
    }
    if (!base) {
        base = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads');
    }
    // 目录带前缀：同站 /h/123 与 /hentai/123 是两本不同的作品，同目录会互踩数字页文件
    // （pruneSiblingPageFiles 会删掉对方同页文件）且 manifest/.gallery 互盖。
    // 旧版无前缀目录保持不动（徽标齐全仍可导入），新任务走前缀目录。
    // gid/prefix 落盘前再净化一次：normalizeGid 已保证 gid 是纯数字，
    // 但 saveImages 允许调用方直传 gid，路径分隔符必须在这里彻底挡死。
    const p = String(prefix || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const safeGid = String(gid || '').replace(/[^0-9a-z_-]/gi, '');
    const leaf = p && p !== 'auto' ? `${p}-${safeGid}` : safeGid;
    return path.join(base, String(rootName || 'gallery'), leaf);
}

// 写新徽标前清掉同目录残留的旧徽标：改名重存时旧“<旧标题>.gallery”
// 会一直留着，导致导入时一本画廊认出两个名
function pruneStaleMarkers(galleryDir, keepFileName) {
    let entries = [];
    try {
        entries = fs.readdirSync(galleryDir);
    } catch (_e) {
        return;
    }
    for (const name of entries) {
        if (!/\.gallery$/i.test(name) || name === keepFileName) continue;
        try {
            fs.unlinkSync(path.join(galleryDir, name));
        } catch (_e) { /* ignore */ }
    }
}
function sanitizeTitle(name, fallback) {
    const clean = String(name || fallback || 'gallery')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return clean || String(fallback || 'gallery');
}

// 落盘输出二件套：manifest.json（旧脚本/旧目录兼容）+ <标题>.gallery 徽标（可导入画廊标识）。
// 各站点的 downloadGallery 与 saveImages 共用，字段口径唯一，不再两处各写一遍改漏。
// 清单写坏不致命（页文件才是本体，下次任务重写），吞错不停任务；徽标失败记日志。
function writeGalleryOutputs(galleryDir, { site = '', base = '', gid, title, prefix, sourceUrl = '', totalPages, records = [], logTag = 'gallery' }) {
    const now = new Date().toISOString();
    const manifestPath = path.join(galleryDir, 'manifest.json');
    try {
        fs.writeFileSync(
            manifestPath,
            JSON.stringify(
                { gid: String(gid), title, base, downloadedAt: now, records },
                null,
                2
            ),
            'utf-8'
        );
    } catch (_e) { /* 清单写坏不影响已落盘的页文件 */ }

    const markerName = `${sanitizeTitle(title, gid)}.gallery`;
    // 改名重存时清掉同目录旧徽标，否则一本画廊认出两个名
    pruneStaleMarkers(galleryDir, markerName);
    const galleryMarkerPath = path.join(galleryDir, markerName);
    try {
        fs.writeFileSync(
            galleryMarkerPath,
            JSON.stringify(
                {
                    format: 'the-play-gallery/1',
                    // site 让导入侧知道这本属于哪个站点（同号 gid 在两个站点是两本书）
                    site,
                    title,
                    gid: String(gid),
                    prefix,
                    sourceUrl,
                    totalPages,
                    createdAt: now,
                },
                null,
                2
            ),
            'utf-8'
        );
    } catch (markerErr) {
        console.error(`[${logTag}] 写入画廊徽标失败:`, markerErr && markerErr.message);
    }
    return { manifestPath, galleryMarkerPath };
}

// 同页换后缀清理：站点图片格式变更（webp 改 jpg）时，旧 `1.webp` 会和新 `1.jpg`
// 并存，导入时同一页码出现两次。落盘前删掉同页其他后缀的旧文件
function pruneSiblingPageFiles(galleryDir, pageNum, keepFileName) {
    const n = Number(pageNum);
    if (!Number.isFinite(n) || n < 1) return;
    let entries = [];
    try {
        entries = fs.readdirSync(galleryDir);
    } catch (_e) {
        return;
    }
    const siblingRe = new RegExp(`^${n}\\.[a-z0-9]+$`, 'i');
    for (const name of entries) {
        if (name === keepFileName || !siblingRe.test(name)) continue;
        if (!/\.(webp|jpe?g|png|gif|avif|bmp|heic)$/i.test(name)) continue;
        try {
            fs.unlinkSync(path.join(galleryDir, name));
        } catch (_e) { /* ignore */ }
    }
}

/* -------------------------------------------------------------------------- */
/*                                页码范围                                     */
/* -------------------------------------------------------------------------- */
function parsePageRange(spec, totalPages) {
    // 总页数必须归一为有限正整数：探测异常时上游可能传 null/undefined/NaN，
    // 此前 'all' 分支会走 Array.from({length: null}) → 空数组，
    // 下载静默变成"0 页"（用户点全本下载什么都没发生，也没有报错）。
    const total = Number.isFinite(Number(totalPages)) && Number(totalPages) > 0
        ? Math.floor(Number(totalPages))
        : 0;
    // 归一化必须先 trim 再判空。原来判的是 `!spec`（只挡 null/undefined/''），
    // 于是**纯空白**的 spec（' '、'\t'）会掉进下面的 split 分支：
    // 每段 trim 后都是空串被 continue 掉，最终返回空数组 —— 同样是"0 页、无报错"。
    // 渲染层有个同名同语义的 rangeIncludesPage（GalleryPanel），它把纯空白当"全选"，
    // 两边就此分叉：UI 认为在抓全部，主进程一页都不抓。
    // 目前渲染层总会先 trim 成 `1-${total}` 再传（见 handleFetchPages），
    // 所以还没炸；但这条 IPC 边界不保证调用方一定归一化，靠调用方自觉太脆。
    // 在这里统一按"空 = 全部"处理，两边语义重新对齐。
    const normalized = typeof spec === 'string' ? spec.trim() : '';
    if (!normalized || normalized.toLowerCase() === 'all') {
        return Array.from({ length: total }, (_, i) => i + 1);
    }
    const pages = new Set();
    const chunks = normalized.split(',');
    for (const chunk of chunks) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        if (trimmed.includes('-')) {
            const [startStr, endStr] = trimmed.split('-');
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
                    if (i >= 1 && i <= total) pages.add(i);
                }
            }
        } else {
            const num = parseInt(trimmed, 10);
            if (!isNaN(num) && num >= 1 && num <= total) pages.add(num);
        }
    }
    return Array.from(pages).sort((a, b) => a - b);
}

module.exports = {
    HEADERS,
    setUserAgent,
    getUserAgent,
    mapWithConcurrency,
    sleep,
    unescapeHtml,
    stripTags,
    httpGetFinal,
    httpGet,
    isCloudflareChallengePage,
    isCloudflareErrorPage,
    DOWNLOAD_IDLE_TIMEOUT_MS,
    DOWNLOAD_TOTAL_TIMEOUT_MS,
    downloadImageWithResume,
    defaultGalleryRoot,
    pruneStaleMarkers,
    sanitizeTitle,
    writeGalleryOutputs,
    pruneSiblingPageFiles,
    parsePageRange,
};
