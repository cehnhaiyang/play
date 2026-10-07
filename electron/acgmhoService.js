const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');

// 本文件只负责 ACG 站点的解析与抓取，**不维护出网逻辑**：
// 代理、隧道、agent 由 main.js 的全局网络层接管——这里照常写 https.get 就是走代理的，
// 不需要传 agent，也不需要知道代理存在。
/* -------------------------------------------------------------------------- */
/*                              站点请求身份                                    */
/* -------------------------------------------------------------------------- */
// 抓取该站时使用的 UA 与默认请求头。
//
// UA 初值由内核版本派生（见 userAgent.js），与浏览器会话天然一致；
// main.js 拿到会话 UA 后会调 setUserAgent 再对齐一次——cf_clearance 与 UA 绑定，
// Node 直抓必须与"拿到凭证的那个浏览器"完全一致，否则表现为"验证过了但搜索仍 403"。
const { kernelUserAgent } = require('./userAgent');
const HEADERS = {
    'User-Agent': kernelUserAgent(),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** 把 UA 换成浏览器会话的真实值（由 main.js 在拿到会话 UA 后调用） */
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

const BASE = 'https://www.acgmho.com';


function unescapeHtml(html) {
    return html
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

// 站点 404 页特征：HTTP 200 包 404 皮（实测 /characters/sensei.html 返回 200 + 404 标题）。
// 列表与探测共用：命中即视为"无此内容"，不再按正常页面解析。
function isNotFoundPage(html) {
    if (!html || html.length < 500) return true;
    return (
        html.includes('<title>404 Not Found') ||
        (html.includes('404 Not Found') && html.includes('404bg.svg')) ||
        html.includes('<title>提示信息</title>') ||
        html.includes('class="showMsg"')
    );
}

// 站点"提示信息"页正文提取（.content 块，如"搜索过于频繁，请稍后再试。"/"关键词太短了"）。
// 该模板同时承载 404 与可恢复提示：此前一律当"无结果"，把限流误报成"未找到"，
// 用户被引导换词重试、请求更密，反而持续维持限流。
function extractSiteTip(html) {
    const m = html.match(/<div class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    return m ? stripTags(m[1]) : '';
}


function normalizeGid(input) {
    const str = String(input || '').trim();
    // /g/ 为站外短链/占位写法：只取数字走 auto 全候选，不硬绑定前缀
    const shortMatch = str.match(/\/g\/(\d+)/i);
    if (shortMatch) {
        return { gid: shortMatch[1], prefix: 'auto' };
    }
    // 西漫系列页地址形如 /western/comic-5609.html（数字前带 comic- 词缀）。
    // 不识别这一形态会掉进下面的宽松分支：gid 虽能抽到，前缀却退化成 auto，
    // 候选地址便从 /h/5609.html 开始逐个试，命中的是网漫同名系列页而非西漫详情。
    const seriesMatch = str.match(/\/(hentai|h|hanime|asmr|gif|animation|cos|webtoon|western)\/comic-(\d+)/i);
    if (seriesMatch) {
        const rawPrefix = seriesMatch[1].toLowerCase();
        return { gid: seriesMatch[2], prefix: rawPrefix === 'animation' ? 'gif' : rawPrefix };
    }
    const urlMatch = str.match(/\/(hentai|h|hanime|asmr|gif|animation|cos|webtoon|western)\/(\d+)/i);
    if (urlMatch) {
        const rawPrefix = urlMatch[1].toLowerCase();
        return { gid: urlMatch[2], prefix: rawPrefix === 'animation' ? 'gif' : rawPrefix };
    }
    // 纯数字才算 gid。此前对任意输入都抽第一段数字、抽不到就原样回填，
    // 于是 "../../evil" 这种输入会把 gid 变成路径片段，defaultGalleryRoot 拼出
    // Downloads\acgmho\..\..\evil → 落盘逃出下载目录（写盘位置被远端/输入控制）。
    const idMatch = str.match(/^(\d+)$/);
    if (idMatch) return { gid: idMatch[1], prefix: 'auto' };
    const loose = str.match(/(\d+)/);
    // 带路径分隔符或 .. 的输入一律只取数字段；取不到数字则视为无效（gid 为空，
    // 上层会拒绝任务，而不是拿一段可疑字符串去拼路径）。
    if (loose && !/[/\\]|\.\./.test(str)) return { gid: loose[1], prefix: 'auto' };
    return { gid: loose ? loose[1] : '', prefix: 'auto' };
}

function pageUrl(gid, n, prefix = 'hentai') {
    return n === 1 ? `${BASE}/${prefix}/${gid}.html` : `${BASE}/${prefix}/${gid}-${n}.html`;
}

function parsePage(gid, n, html, prefix = 'hentai') {
    const picMatch = html.match(/<p class="manga-picture">([\s\S]*?)<\/p>/i); let src = null;
    let alt = null;
    if (picMatch) {
        const imgTagMatch = picMatch[1].match(/<img[^>]*?>/i);
        if (imgTagMatch) {
            const tag = imgTagMatch[0];
            // 站点实测双引号，兼容单引号写法
            const pickAttr = (name) => {
                const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]+)"', 'i')) ||
                    tag.match(new RegExp(name + "\\s*=\\s*'([^']+)'", 'i'));
                return m ? m[1] : null;
            };
            src = pickAttr('src');
            alt = pickAttr('alt');
            // 懒加载占位：src 为 1px/loading 图或内联 data: 时，用 data-original 系真链，
            // 否则会把占位小图当正片下载落盘
            const lazy = pickAttr('data-original') || pickAttr('data-src') || pickAttr('data-lazy-src');
            if (lazy && (!src || /1x1|placeholder|loading|blank/i.test(src) || src.startsWith('data:'))) {
                src = lazy;
            }
        }
    }

    // 标题实测三种模板：<h1 class="title">（/h/ /hentai/）、<h1 class="title mt10">（/gif/ /hanime/ /cos/）、
    // 以及无标题的纯播放页。此前只认严格 class="title"，后两类的页标题恒为 null，
    // 落盘 manifest 与播放列表标题退化成"作品 <gid>"。用词边界匹配兼容多 class。
    const titleMatch = html.match(/<h1[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);
    // next_page_url 语义按频道不同：图集（/h/ /hentai/）指本作下一页（<gid>-2.html），
    // 视频/有声/写真指"站内下一篇作品"（<别的gid>.html，页脚 pre/next 导航）。
    // 只有前者能当翻页依据——把后者当下一页会让图集抓取跳到另一本作品上。
    const nextMatch = html.match(/next_page_url\s*=\s*["']([^"']+)["']/i);
    const nextUrl = nextMatch ? nextMatch[1] : null;

    // 翻页器块：只有图集模板才有 <div id="pages">，用它判定本页是否为多页图集
    const pagesBlockMatch = html.match(/<div[^>]*\bid=["']pages["'][^>]*>([\s\S]*?)<\/div>/i);
    const hasPagesBlock = !!pagesBlockMatch;
    // 同作下一页：地址形如 /<prefix>/<同gid>-N.html（N≥2）才算
    const isSelfNextPage = !!(
        nextUrl &&
        new RegExp(`^/(?:hentai|h|asmr|gif|hanime|cos|webtoon|western|animation)/${gid}-\\d+\\.html$`, 'i').test(nextUrl)
    );
    const selfNextUrl = isSelfNextPage ? nextUrl : null;

    let detectedPrefix = prefix;
    if (nextUrl) {
        const prefMatch = nextUrl.match(/^\/(hentai|h|asmr|gif|hanime|cos|webtoon|western|animation)\//i);
        if (prefMatch) {
            detectedPrefix = prefMatch[1].toLowerCase();
        }
    }

    let total = null;
    // 翻页器实测两套模板：/hentai/ 为 <div class="page" id="pages">，
    // /h/ 为 <div class="page bigpage" id="pages">。此前硬匹配 class="page"，
    // 对 /h/ 全站失配 → total_pages 恒为 null → 上层回退 1 页，
    // 用户点"全本下载"只拿到第 1 页且没有任何报错。改按 id 锚定（class 顺序/多值无关）。
    if (pagesBlockMatch) {
        const blockText = pagesBlockMatch[1];
        const nums = [];
        const linkRegex = /[-/](\d+)-(\d+)\.html/g;
        let lm;
        while ((lm = linkRegex.exec(blockText)) !== null) {
            nums.push(parseInt(lm[2], 10));
        }
        const tagRegex = /<(?:a|span)[^>]*>\s*(\d+)\s*<\/(?:a|span)>/gi;
        let tm;
        while ((tm = tagRegex.exec(blockText)) !== null) {
            nums.push(parseInt(tm[1], 10));
        }
        if (nums.length > 0) {
            total = Math.max(...nums);
        }
    }

    return {
        page: n,
        page_url: pageUrl(gid, n, detectedPrefix),
        title: titleMatch ? stripTags(titleMatch[1]) : null,
        // 大图直链归一为绝对地址：站点部分模板给相对路径（/statics/... 或裸文件名），
        // 原样交给 downloadImageWithResume 会 client.get 直接抛 "Invalid URL"，
        // 表现为整本下载 0 页且每页记录都是"下载失败: Invalid URL"。
        img_url: absolutizeMediaUrl(src),
        img_alt: alt,
        // 只透出"本作下一页"：视频/有声页的 next_page_url 是站内下一篇作品，
        // 透出去会被上层当成翻页依据而跳到别的作品上。
        next_page_url: selfNextUrl,
        // 非图集模板（无 id="pages"）没有总页数概念，交给上层按单页处理
        total_pages: hasPagesBlock ? total : null,
        prefix: detectedPrefix,
    };
}

// APlayer 音轨数组纯文本解析：逐块提 name/url/artist/cover，不执行远端 JS
function parseAplayerAudio(arrayText) {
    const list = [];
    if (!arrayText) return list;
    const blockRe = /\{([^{}]*)\}/g;
    let bm;
    while ((bm = blockRe.exec(arrayText)) !== null) {
        const body = bm[1];
        const pick = (key) => {
            const m = body.match(new RegExp(key + '\\s*:\\s*[\'"]([^\'"]+)[\'"]', 'i'));
            return m ? m[1].trim() : '';
        };
        const url = pick('url');
        if (!url) continue;
        list.push({
            name: pick('name'),
            url,
            artist: pick('artist'),
            cover: pick('cover') || '/statics/images/ext/mp3.png',
        });
    }
    return list;
}

// 媒体直链归一：站点详情页偶发相对路径（/videos/x.mp4、videos/x.mp4）或 // 开头，
// 原样塞进播放器/下载器会导致播不出、下不动，统一补成绝对地址
function absolutizeMediaUrl(u) {
    if (!u) return u;
    const s = String(u).trim();
    if (!s) return s;
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return `https:${s}`;
    if (s.startsWith('/')) return `${BASE}${s}`;
    if (s.startsWith('data:')) return s;
    return `${BASE}/${s}`;
}

// LD-JSON VideoObject 提取：@type 可能是数组，多个结构化数据可能包在 @graph/顶层数组里
function pickVideoObject(node) {
    if (!node || typeof node !== 'object') return null;
    const t = node['@type'];
    if (t === 'VideoObject' || (Array.isArray(t) && t.includes('VideoObject'))) return node;
    return null;
}

// 探测分支函数：音频 → 视频 → 图集依次判定，命中即返回，图集为默认归宿。
// 从 probeGallery 下沉：主流程只剩"候选抓取 + 标题 + 分发"，各分支独立可读可测。

// 音频分支：asmr 频道页，或 HTML 含 APlayer。非音频页返回 null 走下一分支。
// asmr 即使没解出音轨也返回空音轨 probe——它不可能是图文集，null 会误入图集分支。
function probeAudioResult({ gid, cleanTitle, html, matchedUrl }) {
    if (!(matchedUrl.includes('/asmr/') || html.includes('APlayer') || html.includes('aplayer'))) {
        return null;
    }
    const apMatch = html.match(/new\s+APlayer\(\{[\s\S]*?audio:\s*(\[[\s\S]*?\])[\s\S]*?\}\);/i);
    let audioList = [];
    if (apMatch) {
        // 纯正则提取音轨三元组：远端页面不可信，不执行其 JS
        audioList = parseAplayerAudio(apMatch[1]);
        if (audioList.length === 0) {
            const nameM = html.match(/name:\s*['"]([^'"]+)['"]/);
            const urlM = html.match(/url:\s*['"]([^'"]+)['"]/);
            const artistM = html.match(/artist:\s*['"]([^'"]+)['"]/);
            if (urlM) {
                audioList.push({
                    name: nameM ? nameM[1] : cleanTitle,
                    url: urlM[1],
                    artist: artistM ? artistM[1] : 'ACG有声',
                    cover: '/statics/images/ext/mp3.png'
                });
            }
        }
    }

    if (audioList.length > 0) {
        // 音轨直链/封面同样归一相对地址
        for (const t of audioList) {
            t.url = absolutizeMediaUrl(t.url);
            if (t.cover) t.cover = absolutizeMediaUrl(t.cover);
        }
        const coverUrl = audioList[0].cover && !audioList[0].cover.startsWith('http')
            ? `${BASE}${audioList[0].cover}`
            : audioList[0].cover || '';

        return {
            gid,
            title: cleanTitle,
            totalPages: audioList.length,
            firstImgUrl: coverUrl,
            prefix: 'asmr',
            firstPageUrl: matchedUrl,
            firstHtml: html,
            mediaType: 'audio',
            category: 'asmr',
            audioList,
        };
    }

    if (matchedUrl.includes('/asmr/')) {
        return {
            gid,
            title: cleanTitle,
            totalPages: 0,
            firstImgUrl: '',
            prefix: 'asmr',
            firstPageUrl: matchedUrl,
            firstHtml: html,
            mediaType: 'audio',
            category: 'asmr',
            audioList: [],
        };
    }
    return null;
}

// 视频分支：gif/hanime/animation 频道，或 HTML 含 VideoObject/masterUrl/<video>/mp4。
// 纯 <video>/<source> 直链页不分频道都认：找不到 videoUrl 会自然落到图集分支，无误判风险。
function probeVideoResult({ gid, cleanTitle, html, matchedUrl }) {
    const maybePlainVideo = html.includes('<video') || html.includes('.mp4');
    if (!(matchedUrl.includes('/gif/') || matchedUrl.includes('/hanime/') || matchedUrl.includes('/animation/') || html.includes('VideoObject') || html.includes('masterUrl') || maybePlainVideo)) {
        return null;
    }
    let videoUrl = null;
    let poster = null;
    let duration = null;

    const ldJsonMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (ldJsonMatch) {
        try {
            const data = JSON.parse(ldJsonMatch[1]);
            let vo = pickVideoObject(data);
            if (!vo && Array.isArray(data['@graph'])) {
                vo = data['@graph'].map(pickVideoObject).find(Boolean) || null;
            }
            if (!vo && Array.isArray(data)) {
                vo = data.map(pickVideoObject).find(Boolean) || null;
            }
            if (vo) {
                videoUrl = vo.contentUrl;
                poster = Array.isArray(vo.thumbnailUrl) ? vo.thumbnailUrl[0] : vo.thumbnailUrl;
                duration = vo.duration;
            }
        } catch (_e) { }
    }

    if (!videoUrl) {
        const masterUrlMatch = html.match(/masterUrl\s*=\s*["']([^"']+)["']/i) || html.match(/"contentUrl":\s*"([^"]+)"/i);
        videoUrl = masterUrlMatch ? masterUrlMatch[1] : null;
    }

    // <video>/<source> 直链兜底（cos 视频页常见写法，兼容单双引号）
    if (!videoUrl) {
        const sourceMatch = html.match(/<(?:source|video)[^>]*\ssrc=["']([^"']+\.mp4[^"']*)["']/i);
        videoUrl = sourceMatch ? sourceMatch[1] : null;
    }

    if (!poster) {
        const posterMatch = html.match(/poster=["']([^"']+)["']/i);
        poster = posterMatch ? posterMatch[1] : null;
    }

    if (!videoUrl) return null;
    videoUrl = absolutizeMediaUrl(videoUrl);
    poster = absolutizeMediaUrl(poster);
    // 前缀取详情地址实测值：cos 动画不再重映射为 gif，保证来源可回溯
    const urlPref = (matchedUrl.match(/\/(hanime|gif|cos|animation|webtoon|western|hentai|h)\//i) || [])[1];
    const videoPrefix = (urlPref || 'gif').toLowerCase();
    return {
        gid,
        title: cleanTitle,
        totalPages: 1,
        firstImgUrl: poster || '',
        prefix: videoPrefix,
        firstPageUrl: matchedUrl,
        firstHtml: html,
        mediaType: 'video',
        category: 'animation',
        videoUrl,
        poster,
        duration,
    };
}

// 图集分支（默认归宿）：前缀取详情地址实测值，
// webtoon/western/cos 不再强制改写为 h/hentai（否则后续翻页 URL 全错）。
// gif/hanime/animation/asmr 若走到此分支（如动图图集），同样保留实测前缀。
function probeImageResult({ gid, cleanTitle, html, matchedUrl }) {
    const urlPref = (matchedUrl.match(/\/(h|hentai|gif|hanime|animation|asmr|webtoon|western|cos)\//i) || [])[1];
    const currentPrefix = (urlPref || 'hentai').toLowerCase();
    const info = parsePage(gid, 1, html, currentPrefix);

    const firstImg = info.img_url || '';
    const isAnimated = firstImg.toLowerCase().endsWith('.gif') ||
        (firstImg.toLowerCase().endsWith('.webp') &&
            (cleanTitle.toLowerCase().includes('animated') || html.includes('animated') || cleanTitle.includes('动图')));

    return {
        gid,
        title: info.title || cleanTitle,
        totalPages: info.total_pages || 1,
        firstImgUrl: info.img_url || '',
        prefix: info.prefix || currentPrefix,
        firstPageUrl: info.page_url,
        firstHtml: html,
        mediaType: 'image',
        category: isAnimated ? 'animated_gallery' : 'manga',
        isAnimated,
    };
}

async function probeGallery(gidOrUrl) {
    const { gid, prefix: initialPrefix } = normalizeGid(gidOrUrl);
    if (!gid) {
        // normalizeGid 净化后为空：输入既不是纯数字也不是站内详情地址。
        // 直接拒绝，避免拿可疑字符串去拼请求/落盘路径。
        throw new Error(`无效的作品 ID 或链接 (${gidOrUrl})，请填写纯数字 ID 或站内作品页地址`);
    }

    // 按初始前缀组织候选地址：指定前缀只探一个，未指定（auto）全候选并发试。
    // 西漫有互斥的两套地址空间：系列页 /western/comic-<gid>.html 与章节页 /western/<gid>.html
    // （实测同号只会有其一存在），因此 western 前缀下两个形态都要作为候选。
    const candidatesForPrefix = (prefix) => {
        if (prefix === 'western') {
            return [`${BASE}/western/comic-${gid}.html`, pageUrl(gid, 1, prefix)];
        }
        return [pageUrl(gid, 1, prefix)];
    };
    let candidateUrls = [];
    if (initialPrefix !== 'auto') {
        candidateUrls = candidatesForPrefix(initialPrefix);
    } else {
        candidateUrls.push(
            `${BASE}/h/${gid}.html`,
            `${BASE}/hentai/${gid}.html`,
            `${BASE}/asmr/${gid}.html`,
            `${BASE}/gif/${gid}.html`,
            `${BASE}/hanime/${gid}.html`,
            `${BASE}/cos/${gid}.html`,
            `${BASE}/webtoon/${gid}.html`,
            `${BASE}/western/comic-${gid}.html`,
            `${BASE}/western/${gid}.html`
        );
    }

    // 候选页有效性：既不是 404 皮页，也不是 Cloudflare 挑战页/5xx 错误页。
    // 挑战页此前会被当正常页收下（标题 "Just a moment..."、无大图），
    // 探测"成功"返回一本 0 图的空画廊，用户看到的是"作品信息错误"而非"需要过验证"。
    const isUsablePage = (h) =>
        !!h && !isNotFoundPage(h) && !isCloudflareChallengePage(h) && !isCloudflareErrorPage(h);

    // 并发探测：候选按优先级排序，全部并行发出后按优先级取首个有效命中（串行逐个试太慢）。
    let html = null;
    let matchedUrl = '';
    // 首轮是否撞到过挑战页/CF 错误页：拿不到结果时凭它给出准确原因
    let sawChallenge = false;
    const consider = (h) => {
        if (isCloudflareChallengePage(h)) {
            sawChallenge = true;
            return false;
        }
        return isUsablePage(h);
    };
    if (candidateUrls.length === 1) {
        try {
            const res = await httpGet(candidateUrls[0]);
            if (consider(res)) {
                html = res;
                matchedUrl = candidateUrls[0];
            }
        } catch (_e) { /* ignore */ }
    } else {
        const settled = await Promise.allSettled(candidateUrls.map((url) => httpGet(url)));
        for (let i = 0; i < candidateUrls.length; i++) {
            const r = settled[i];
            if (r.status === 'fulfilled' && consider(r.value)) {
                html = r.value;
                matchedUrl = candidateUrls[i];
                break;
            }
        }
    }

    if (!html) {
        // 拿不到可用页时区分原因：撞了挑战要提示过验证，而不是"ID 无效"误导用户换链接。
        if (sawChallenge) {
            throw new Error('站点触发了人机验证（Cloudflare 挑战未完成），没有取到作品信息；请在内置浏览器里打开一次站点通过验证后重试');
        }
        throw new Error(`未能获取到作品信息 (${gidOrUrl})，请确认链接或作品 ID 是否有效`);
    }

    // 章节聚合页（网漫/西漫的频道条目都是这种"系列页"）：正文是章节列表，页面自身没有大图。
    // 不处理会走到图集分支，返回一本 totalPages=1、firstImgUrl 为空的空画廊——
    // 详情页显示"漫画共 1 页"加一个空封面，"边下边播"点下去静默无事发生（无报错、无进度）。
    // 这里自动跟进第一章（章节页自身不再含 dd.chapters，无递归风险），
    // 让卡片点击得到的是真正可读的图集。
    // gid 必须一并换成章节自身的：后续翻页地址由 gid 拼出，沿用系列 gid 会去抓
    // /western/5609-2.html 这种不存在的地址，整本下载每页都失败。
    let resolvedGid = gid;
    const seriesChapters = parseSeriesChapters(html);
    if (seriesChapters.length > 0 && seriesChapters[0].url) {
        try {
            const firstChapter = await httpGetFinal(seriesChapters[0].url, matchedUrl, 30000, 3, 5, null);
            if (isUsablePage(firstChapter.html)) {
                const chapterGid = normalizeGid(seriesChapters[0].url).gid;
                if (chapterGid) resolvedGid = chapterGid;
                html = firstChapter.html;
                matchedUrl = firstChapter.url || seriesChapters[0].url;
            }
        } catch (_seriesErr) {
            // 首章取不到（网络/风控）时不能退回"空画廊"：那会让详情页显示
            // "漫画共 1 页"且封面为空，"边下边播"点下去静默无事发生。
            // 明确报错，用户才知道是章节页没取到，而不是作品本身没内容。
            throw new Error(`该地址是章节列表页（共 ${seriesChapters.length} 章），但第一章抓取失败；请稍后重试，或直接打开其中一章的地址`);
        }
    }

    // 提取通用标题：优先页内 h1（词边界兼容 class="title mt10" 等变体），
    // 缺失时回退 SEO <title>。视频/写真页的 h1 是干净标题，而 <title> 是
    // "标题 - 原神动画…同人H动画 同人H动画" 这类堆关键词的 SEO 串，
    // 直接当作品名会把播放列表标题污染成关键词堆砌。
    const titleMatch = html.match(/<h1[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) ||
        html.match(/<title>([\s\S]*?)<\/title>/i);
    const rawTitle = titleMatch ? stripTags(titleMatch[1]) : `ACG作品 ${resolvedGid}`;
    const cleanTitle = rawTitle.replace(/\s*-\s*ACG.*$/i, '').trim();

    // 音频 → 视频 → 图集依次判定（分支函数见本文件上方），图集为默认归宿
    const mediaCtx = { gid: resolvedGid, cleanTitle, html, matchedUrl };
    const result = probeAudioResult(mediaCtx) || probeVideoResult(mediaCtx) || probeImageResult(mediaCtx);
    // 兜底：解析出来既无大图也无媒体流（模板变更/站点空页）时明确报错，
    // 不再把"1 页空画廊"交给渲染层——那种结果在 UI 上看起来是正常作品，
    // 用户点"边下边播"没有任何反应，也没有任何提示可循。
    const hasPlayable =
        (result.audioList && result.audioList.length > 0) ||
        !!result.videoUrl ||
        !!result.firstImgUrl;
    if (!hasPlayable) {
        throw new Error(`未在 ${gidOrUrl} 解析到可读内容（该地址可能是章节列表页或空页面）`);
    }
    return result;
}

/* -------------------------------------------------------------------------- */
/* 同作品任务键：/h/123 与 /hentai/123 是两本不同的作品，任务键必须带前缀，   */
/* 否则同数字 gid 的两个任务会互顶/误取消。prefix 未知（auto）时回退纯 gid。  */
/* -------------------------------------------------------------------------- */
function galleryTaskKey(gidOrUrl, probeOrOpts) {
    const want = normalizeGid(gidOrUrl);
    const gid = String(want.gid || '').trim();
    const rawPrefix = (probeOrOpts && probeOrOpts.prefix) || want.prefix;
    const prefix = String(rawPrefix || '').toLowerCase();
    if (!gid) return '';
    if (!prefix || prefix === 'auto') return gid;
    return `${prefix}:${gid}`;
}

// 存储键是否属于待取消的 gidOrUrl：精确键相等，或同数字 gid（兼容纯 gid 取消）
function galleryKeyMatches(storedKey, gidOrUrl) {
    const key = String(storedKey || '');
    if (!key) return false;
    const want = normalizeGid(gidOrUrl);
    const gid = String(want.gid || '').trim();
    if (!gid) return false;
    // 去掉 save 任务的 #runToken 后缀再比：base 为 gid 或 prefix:gid
    const base = key.split('#')[0];
    if (base === gid) return true;
    const sep = base.lastIndexOf(':');
    if (sep >= 0) return base.slice(sep + 1) === gid;
    return false;
}

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

// 单页图片下载的两道时限（见 downloadImageWithResume 注释）：
// IDLE 管"对端不发数据"，TOTAL 管"对端一直在发但永远发不完"。
// 单页图片通常几十 KB~几 MB，5 分钟总时限对慢速链路仍有余量。
const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;

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
        // 不传 agent：全局网络层已接管 globalAgent，这条请求自动走代理。
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
        req = client.get(url, { headers, timeout: 120000 }, (res) => {
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


// 默认下载根：优先 Electron 下载目录（随系统语言/用户设置走），
// CLI/未就绪时回退用户主目录（直接拼 USERPROFILE 在 Linux/mac 下为空会落到相对路径）
function defaultGalleryRoot(gid, prefix) {
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
    // 目录带前缀：/h/123 与 /hentai/123 是两本不同的作品，同目录会互踩数字页文件
    // （pruneSiblingPageFiles 会删掉对方同页文件）且 manifest/.gallery 互盖。
    // 旧版无前缀目录（acgmho/<gid>）保持不动（徽标齐全仍可导入），新任务走前缀目录。
    // gid/prefix 落盘前再净化一次：normalizeGid 已保证 gid 是纯数字，
    // 但 saveGalleryImages 允许调用方直传 gid，路径分隔符必须在这里彻底挡死。
    const p = String(prefix || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const safeGid = String(gid || '').replace(/[^0-9a-z_-]/gi, '');
    const leaf = p && p !== 'auto' ? `${p}-${safeGid}` : safeGid;
    return path.join(base, 'acgmho', leaf);
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
// downloadGallery 与 saveGalleryImages 共用，字段口径唯一，不再两处各写一遍改漏。
// 清单写坏不致命（页文件才是本体，下次任务重写），吞错不停任务；徽标失败记日志。
function writeGalleryOutputs(galleryDir, { gid, title, prefix, sourceUrl = '', totalPages, records = [], logTag = 'gallery' }) {
    const now = new Date().toISOString();
    const manifestPath = path.join(galleryDir, 'manifest.json');
    try {
        fs.writeFileSync(
            manifestPath,
            JSON.stringify(
                { gid: String(gid), title, base: BASE, downloadedAt: now, records },
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

async function downloadGallery(options, onProgress, isCancelled) {
    const { gidOrUrl, pages: pageSpec, outDir, delayMs = 1000, probe: preProbe = null } = options;
    // 同 fetchGalleryPages：配套 probe 只在 gid+前缀双匹配时复用，防同名异帖串台
    const want = normalizeGid(gidOrUrl);
    const probe = preProbe && String(preProbe.gid) === String(want.gid) &&
        (!preProbe.prefix || want.prefix === 'auto' || preProbe.prefix === want.prefix)
        ? preProbe
        : await probeGallery(gidOrUrl);
    const { gid, totalPages } = probe;
    let { prefix } = probe;

    const targetPages = parsePageRange(pageSpec, totalPages);
    // 空范围（如非法 range）直接返回，不写 manifest/.gallery，避免产生 0 页空画廊
    if (targetPages.length === 0) {
        return {
            success: false,
            totalDownloaded: 0,
            outDir: outDir || defaultGalleryRoot(String(gid), probe.prefix),
            manifestPath: '',
            galleryMarkerPath: '',
            records: [],
            message: `页码范围「${pageSpec}」无有效页（总 ${totalPages} 页）`,
        };
    }
    // 默认目录用探测出的真实前缀（调用方传了 outDir 则尊重调用方）
    const galleryDir = outDir || defaultGalleryRoot(String(gid), probe.prefix);
    fs.mkdirSync(galleryDir, { recursive: true });

    const records = [];
    const savedFiles = [];
    // 取消标记：worker 发现取消后置位，排队中的页直接跳过，收尾按此发 cancelled 而非 completed
    let cancelled = false;
    // 并发期前缀固定为探测值（同一作品内前缀稳定，多 worker 共享可变值会互盖串台）
    const basePrefix = prefix;
    let doneCount = 0;

    // 3 并发跑"详情 HTML + 图片直链"流水线（串行 200 页全本需 10 分钟以上），keep-alive 复用连接
    await mapWithConcurrency(targetPages, 3, async (n) => {
        if (cancelled || (isCancelled && isCancelled(gid))) {
            cancelled = true;
            return;
        }
        const url = pageUrl(gid, n, basePrefix);
        let html = null;
        try {
            if (n === 1 && probe.firstHtml) {
                html = probe.firstHtml;
            } else {
                html = await httpGet(url);
            }
        } catch (err) {
            records.push({ page: n, page_url: url, error: String(err.message || err) });
            doneCount += 1;
            return;
        }

        const info = parsePage(gid, n, html, basePrefix);

        if (!info.img_url) {
            records.push({
                ...info,
                error: '未在该页找到大图',
            });
            doneCount += 1;
            return;
        }

        const ext = path.extname(info.img_url.split('?')[0]) || '.webp';
        // .gallery 布局：页文件用纯数字命名（1.png、2.jpg），与徽标约定对齐
        const fileName = `${n}${ext}`;
        const dest = path.join(galleryDir, fileName);
        pruneSiblingPageFiles(galleryDir, n, fileName);

        let downloadedBytes = 0;
        try {
            downloadedBytes = await downloadImageWithResume(
                info.img_url,
                dest,
                url,
                (done, total) => {
                    if (onProgress) {
                        onProgress({
                            gid,
                            currentPage: n,
                            totalPages: targetPages.length,
                            currentBytes: done,
                            totalBytes: total,
                            percent: total > 0 ? Math.round((done / total) * 100) : 0,
                            currentUrl: info.img_url,
                            status: 'downloading',
                            message: `正在下载第 ${n} 页 (${(done / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB)`,
                            savedFiles,
                        });
                    }
                }
            );

            records.push({
                ...info,
                saved_as: dest.replace(/\\/g, '/'),
                bytes: downloadedBytes,
            });
            savedFiles.push(dest);
        } catch (downErr) {
            records.push({
                ...info,
                error: `下载失败: ${downErr.message || downErr}`,
            });
        }
        doneCount += 1;

        // 每 worker 内页间间隔：全局速率约 并发数/delayMs，默认 1s 下约 3 页/秒
        if (delayMs > 0 && doneCount < targetPages.length && !(isCancelled && isCancelled(gid))) {
            await sleep(delayMs);
        }
    });

    // 终态只发一次：取消分支的"提前通知"与收尾分支共用同一份状态。
    // 此前取消路径先在这里发一条 cancelled，收尾处又发一条，渲染层收到两条终态
    // （throttleProgress 对终态不节流，两条都会透出），任务栏会闪两次并重复落盘持久化。
    cancelled = cancelled || !!(isCancelled && isCancelled(gid));
    // 并发完成顺序不定：manifest 按页码排序，保证清单与播放顺序一致。
    // prefix 即 basePrefix（并发期固定探测值，worker 不改它），无需回写。
    records.sort((a, b) => (a.page || 0) - (b.page || 0));
    savedFiles.sort();

    // .gallery 布局：数字页文件 + 徽标同目录即一本可导入画廊
    const { manifestPath, galleryMarkerPath } = writeGalleryOutputs(galleryDir, {
        gid,
        title: probe.title,
        prefix,
        sourceUrl: probe.firstPageUrl || '',
        totalPages: probe.totalPages,
        records,
        logTag: 'downloadGallery',
    });

    const successfulCount = records.filter((r) => r.bytes && r.bytes > 0).length;

    if (onProgress) {
        onProgress(cancelled
            ? {
                gid,
                currentPage: targetPages.length,
                totalPages: targetPages.length,
                currentBytes: 0,
                totalBytes: 0,
                percent: Math.round((successfulCount / targetPages.length) * 100),
                currentUrl: '',
                status: 'cancelled',
                message: `下载已取消：已保存 ${successfulCount}/${targetPages.length} 页`,
                savedFiles,
            }
            : {
                gid,
                currentPage: targetPages.length,
                totalPages: targetPages.length,
                currentBytes: 0,
                totalBytes: 0,
                percent: 100,
                currentUrl: '',
                status: 'completed',
                message: `下载完成：成功 ${successfulCount}/${targetPages.length} 页`,
                savedFiles,
            });
    }

    return {
        success: successfulCount > 0 && !cancelled,
        totalDownloaded: successfulCount,
        outDir: galleryDir,
        manifestPath,
        galleryMarkerPath,
        records,
    };
}

const { pathToFileURL } = require('url');

/* -------------------------------------------------------------------------- */
/* 边下边播落盘：调用方已拿到图片直链（在线推送流程解析出的），这里只做      */
/* 纯下载 + 写 manifest/.gallery 徽标，不再重复请求详情页 HTML。             */
/* 进度事件：                                                                 */
/* - {status:'downloading'} 每块触发，带 doneFiles/totalFiles/message          */
/* - {status:'file-done', file:{page,url,title,localUrl,savedPath,bytes}}     */
/*   单页落盘完成即触发，渲染层凭此把播放列表对应页换成本地 URL                */
/* - {status:'completed'|'cancelled'} 收尾                                    */
/* -------------------------------------------------------------------------- */

async function saveGalleryImages(options, onProgress, isCancelled) {
    const {
        gid,
        title: rawTitle,
        prefix = 'hentai',
        sourceUrl = '',
        totalPages: totalHint,
        items = [],
        outDir,
        taskKey = '',
    } = options || {};
    const gidStr = String(gid || '').trim();
    if (!gidStr) throw new Error('缺少作品 gid，无法落盘');
    // 任务键回显：同数字 gid 不同前缀的两本书，渲染层凭此区分进度与 file-done 回写
    const emitTaskKey = String(taskKey || '').trim();
    const list = (Array.isArray(items) ? items : [])
        .filter((it) => it && it.url)
        .map((it) => ({ page: Number(it.page) || 0, url: String(it.url), title: it.title || '' }))
        .sort((a, b) => a.page - b.page);
    if (list.length === 0) throw new Error('没有可保存的图片直链');

    const title = String(rawTitle || `ACG作品 ${gidStr}`);
    // 默认目录带前缀（与 downloadGallery 同口径）：调用方传了 outDir 则尊重调用方
    const galleryDir = outDir || defaultGalleryRoot(gidStr, prefix);
    fs.mkdirSync(galleryDir, { recursive: true });

    const totalFiles = list.length;
    let doneFiles = 0;
    const savedFiles = [];
    const records = [];

    const emit = (extra) => {
        if (onProgress) {
            onProgress({
                gid: gidStr,
                taskKey: emitTaskKey || undefined,
                title,
                doneFiles,
                totalFiles,
                percent: totalFiles > 0 ? Math.round((doneFiles / totalFiles) * 100) : 0,
                outDir: galleryDir,
                ...extra,
            });
        }
    };

    // 4 并发落盘（直链下载相互独立）。file-done 可能乱序，渲染层按页码归位，此处收尾再排序。
    // 注意：n 不能用 doneFiles+1 推导（并发竞态），无页码项按输入顺序预先编号。
    // 编号必须全局唯一：显式页码与回退编号（i+1）此前共用同一取值空间，
    // 混合输入（部分带 page、部分不带）时两者会撞号——实测 4 项只落 2 个文件，
    // 后写的页直接覆盖先写的页，file-done 也重复播报同一页。
    // 因此显式页码优先占位，无页码项只从未占用的序号里补。
    const usedPages = new Set(list.filter((it) => it.page > 0).map((it) => it.page));
    let fallbackCursor = 1;
    const numbered = list.map((item) => {
        if (item.page > 0) return { item, n: item.page };
        while (usedPages.has(fallbackCursor)) fallbackCursor += 1;
        usedPages.add(fallbackCursor);
        return { item, n: fallbackCursor };
    });
    let cancelledEarly = false;
    await mapWithConcurrency(numbered, 4, async ({ item, n }) => {
        if (cancelledEarly || (isCancelled && isCancelled(gidStr))) {
            cancelledEarly = true;
            return;
        }
        const ext = path.extname(item.url.split('?')[0]) || '.webp';
        const fileName = `${n}${ext}`;
        const dest = path.join(galleryDir, fileName);
        pruneSiblingPageFiles(galleryDir, n, fileName);
        // 防盗链：Referer 用同作品分页地址重建（详情页 HTML 不再请求一次）
        const referer = pageUrl(gidStr, n, prefix);

        try {
            const bytes = await downloadImageWithResume(item.url, dest, referer, (done, total) => {
                emit({
                    status: 'downloading',
                    message: `正在保存第 ${n} 页 (${(done / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB)`,
                });
            });
            const localUrl = pathToFileURL(dest).href;
            doneFiles += 1;
            savedFiles.push(dest);
            records.push({ page: n, page_url: referer, img_url: item.url, saved_as: dest.replace(/\\/g, '/'), bytes });
            emit({
                status: 'file-done',
                message: `第 ${n} 页已保存到本地`,
                file: { page: n, url: item.url, title: item.title, localUrl, savedPath: dest, bytes },
            });
        } catch (err) {
            records.push({ page: n, page_url: referer, img_url: item.url, error: String((err && err.message) || err) });
        }
    });
    // 终态只发一次（与 downloadGallery 同口径）：取消的判定统一放到收尾，
    // 否则取消路径会先发一条 cancelled、收尾再发一条，渲染层收到两条终态。
    const cancelled = cancelledEarly || !!(isCancelled && isCancelled(gidStr));
    records.sort((a, b) => (a.page || 0) - (b.page || 0));
    savedFiles.sort();

    // 与 downloadGallery 同约定，保证目录可被识别为一本画廊
    const { manifestPath, galleryMarkerPath } = writeGalleryOutputs(galleryDir, {
        gid: gidStr,
        title,
        prefix,
        sourceUrl: sourceUrl || '',
        totalPages: Number(totalHint) || totalFiles,
        records,
        logTag: 'saveGalleryImages',
    });

    emit({
        status: cancelled ? 'cancelled' : 'completed',
        message: cancelled ? '保存已取消' : `保存完成：成功 ${savedFiles.length}/${totalFiles} 页`,
    });

    return { success: savedFiles.length > 0 && !cancelled, outDir: galleryDir, manifestPath, galleryMarkerPath, savedFiles, records };
}

async function fetchGalleryPages(options, onProgress, isCancelled) {
    const { gidOrUrl, pages: pageSpec, delayMs = 100, skipPages = [], probe: preProbe = null } = options;
    // 复用调用方已探测的结果：配套 probe 只在 gid+前缀双匹配时复用。
    // 纯数字 gid 重探测时候选顺序（/h/ 优先）可能命中同名异站帖子
    // （如 /h/869222 与 /hentai/869222 是两个不同作品），前缀对不上就重探。
    let probe = null;
    const wantGid = normalizeGid(gidOrUrl);
    if (preProbe && String(preProbe.gid) === String(wantGid.gid) &&
        (!preProbe.prefix || wantGid.prefix === 'auto' || preProbe.prefix === wantGid.prefix)) {
        probe = preProbe;
    } else {
        probe = await probeGallery(gidOrUrl);
    }
    const { gid, totalPages, title } = probe;
    let { prefix } = probe;

    const skipSet = new Set((Array.isArray(skipPages) ? skipPages : []).map((n) => Number(n)).filter((n) => Number.isFinite(n)));
    const targetPages = parsePageRange(pageSpec, totalPages);
    // 断点续抓：已知页直接计入进度不再请求，失败只会发生在真正请求的页上
    const pendingPages = targetPages.filter((n) => !skipSet.has(n));
    const skippedCount = targetPages.length - pendingPages.length;
    const pages = [];
    const errors = [];

    // 进度只带新增 item + 计数：之前每次都把全量 pages 数组（200 页）序列化走 IPC，
    // 事件数 × 数组长度是 O(n²) 流量。渲染层只消费 current/total/item/status（已全量 grep 确认无 records 消费）。
    // 完整有序结果只在收尾 return 里给一次。
    const emitState = (doneCount, item, status) => {
        if (onProgress) {
            onProgress({
                gid,
                current: skippedCount + doneCount,
                total: targetPages.length,
                item,
                status,
            });
        }
    };

    // 单页抓取带重试：网络抖动直接丢页会断剧情。并发期前缀固定为探测值（防 worker 互盖串台）。
    const basePrefix = prefix;
    const fetchPageHtml = async (n) => {
        if (n === 1 && probe.firstHtml) return probe.firstHtml;
        const url = pageUrl(gid, n, basePrefix);
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                return await httpGet(url);
            } catch (err) {
                lastErr = err;
                if (attempt < 3) await sleep(400 * attempt);
            }
        }
        throw lastErr;
    };

    // 5 并发在线解析。item 可能乱序到达：调用方批量缓冲排序后进播放列表，此处收尾再排序保证有序。
    let doneCount = 0;
    let cancelledSeen = false;
    await mapWithConcurrency(pendingPages, 5, async (n) => {
        if (cancelledSeen || (isCancelled && isCancelled(gid))) {
            cancelledSeen = true;
            return;
        }
        let html = null;
        try {
            html = await fetchPageHtml(n);
        } catch (err) {
            console.error(`[fetchGalleryPages] 获取第 ${n} 页失败(已重试):`, err && err.message);
            errors.push({ page: n, error: String((err && err.message) || err) });
            doneCount += 1;
            emitState(doneCount, null, 'fetching');
            return;
        }

        // 前缀串台时站点回 200 包 404 皮的错误页：记失败，不当缺图
        if (isNotFoundPage(html)) {
            errors.push({ page: n, error: '该页不存在（可能前缀串台，请用详情页地址重探）' });
            doneCount += 1;
            emitState(doneCount, null, 'fetching');
            return;
        }

        // 挑战页不是结果页：解析出来必然无大图，逐页记"未找到大图"会把
        // "需要过验证"伪装成"这本图集缺页"，用户反复重抓也拿不到图。
        if (isCloudflareChallengePage(html)) {
            errors.push({ page: n, error: '站点触发了人机验证（Cloudflare 挑战未完成），请在内置浏览器通过验证后重试' });
            doneCount += 1;
            emitState(doneCount, null, 'fetching');
            return;
        }

        let info = null;
        try {
            info = parsePage(gid, n, html, basePrefix);
        } catch (err) {
            console.error(`[fetchGalleryPages] 解析第 ${n} 页失败:`, err && err.message);
            errors.push({ page: n, error: `解析失败: ${String((err && err.message) || err)}` });
            doneCount += 1;
            emitState(doneCount, null, 'fetching');
            return;
        }

        if (info.img_url) {
            const pageTitle = `${title || `图集 ${gid}`} - P${String(n).padStart(2, '0')}/${totalPages}`;
            const item = {
                page: n,
                url: info.img_url,
                title: pageTitle,
                alt: info.img_alt,
            };
            pages.push(item);
            doneCount += 1;
            emitState(doneCount, item, 'fetching');
        } else {
            errors.push({ page: n, error: '未在该页找到大图' });
            doneCount += 1;
            emitState(doneCount, null, 'fetching');
        }

        if (delayMs > 0 && doneCount < pendingPages.length && !(isCancelled && isCancelled(gid))) {
            await sleep(delayMs);
        }
    });

    // 终态必须唯一：cancelled 与 completed 互斥，二选一。
    // 此前"全跳过（纯续抓命中）"在下面另发一次 completed，与这里的 cancelled
    // 撞在一起会同时送出 cancelled + completed 两个矛盾终态——渲染层先按
    // cancelled 收尾、又被 completed 重新置为完成，任务栏状态与实际相反。
    if (cancelledSeen || (isCancelled && isCancelled(gid))) {
        emitState(doneCount, null, 'cancelled');
    } else {
        // 收尾事件不带 item：最后一个页 item 已经以 'fetching' 流过，
        // 这里再带一次会被按 item 追加的调用方重复收下一份（实测第 4 页被投递两次，
        // 播放列表出现重复页）。收尾只表达状态与计数。
        // 纯续抓命中（pendingPages 为空）也走这一条，不再额外补发。
        emitState(doneCount, null, 'completed');
    }
    // 并发完成顺序不定：按页码排序后返回，调用方批量进播放列表时顺序即正确
    // （prefix 即 basePrefix，并发期无人改写，无需回写）
    pages.sort((a, b) => (a.page || 0) - (b.page || 0));
    errors.sort((a, b) => (a.page || 0) - (b.page || 0));

    return {
        gid,
        title: probe.title,
        totalPages: probe.totalPages,
        pages,
        errors,
    };
}

/* -------------------------------------------------------------------------- */
/* 内置浏览画廊：频道列表抓取                                                  */
/* 实测 markup（2026-09）：                                                   */
/* - 漫画系 /h/ /hentai/ /webtoon/ /western/ /cos/ /hot/ / ：ul#list > li，    */
/*   a.thumb(href,title)+img(src|data-original)+span.title a+i.time+i.lang/    */
/*   i.top-tags；写真cos系多 span.time/span.pagenum/span.category              */
/* - 有声 /asmr/：ul#asmr_file_list > li.file，a.thumb+img，h3 a标题，         */
/*   h4[作者][时长]，span.date                                                */
/* - 动画 /gif/ /hanime/：li.grid-item，a(href,title)+img+span.title a +      */
/*   span.time/span.view/span.media                                           */
/* - 分页统一：首页 /index-N.html，频道页 <base>/index-N.html                 */
/* -------------------------------------------------------------------------- */

const GALLERY_CHANNELS = [
    { id: 'latest', label: '最新', base: '/', kind: 'image' },
    { id: 'hot', label: '最热', base: '/hot/', kind: 'image' },
    { id: 'manga', label: '漫画', base: '/h/', kind: 'image' },
    { id: 'album', label: '图集', base: '/hentai/', kind: 'image' },
    { id: 'animation', label: '动画', base: '/gif/', kind: 'video' },
    { id: 'hanime', label: '里番剧', base: '/hanime/', kind: 'video' },
    { id: 'asmr', label: '有声', base: '/asmr/', kind: 'audio' },
    { id: 'cosplay', label: '写真', base: '/cos/', kind: 'mixed' },
    { id: 'webtoon', label: '网漫', base: '/webtoon/', kind: 'image' },
    { id: 'western', label: '西漫', base: '/western/', kind: 'image' },
];

function getChannel(id) {
    return GALLERY_CHANNELS.find((c) => c.id === id) || null;
}

function channelListUrl(channelId, page = 1, query = '') {
    const q = String(query || '').trim();
    if (channelId === 'search' || q) {
        const p = Math.max(1, Number(page) || 1);
        const encodedQ = encodeURIComponent(q);
        return `${BASE}/q/${encodedQ}-${p}.html`;
    }
    const ch = getChannel(channelId);
    if (!ch) throw new Error(`未知频道: ${channelId}`);
    const p = Math.max(1, Number(page) || 1);
    if (p <= 1) return `${BASE}${ch.base}`;
    // latest 的 base 就是 '/'，直接拼会得到 //index-2.html，统一去重斜杠
    const base = ch.base.endsWith('/') ? ch.base : `${ch.base}/`;
    return `${BASE}${base}index-${p}.html`;
}

function absolutizeUrl(u) {
    if (!u) return '';
    const s = String(u).trim();
    if (!s || s.startsWith('data:')) return '';
    if (s.startsWith('https://') || s.startsWith('http://')) return s;
    if (s.startsWith('//')) return `https:${s}`;
    if (s.startsWith('/')) return `${BASE}${s}`;
    return `${BASE}/${s}`;
}

function kindOfPrefix(prefix) {
    if (prefix === 'gif' || prefix === 'hanime' || prefix === 'animation') return 'video';
    if (prefix === 'asmr') return 'audio';
    return 'image';
}

/* 主列表容器定位：站点布局固定为「列表容器 → 翻页器 → 右栏（含排行榜侧栏）」。
 * 侧栏的"月榜/周榜/总榜"条目锚与主列表完全同形（都是 /h/689354.html 这类），
 * 不限定区间就按全文扫描，会把侧栏作品当列表条目混进卡片墙：实测首屏每频道
 * 多出 8~36 条（manga 48 实为 36、animation 45 实为 27、hot 70 实为 36），
 * 且这些条目在每一页恒定出现——既污染卡片墙，又让"翻页零增长即收敛"的
 * 判据永远失效（每页都"有新增"），越界空页也会凭侧栏条目伪装成有内容。 */
const MAIN_LIST_OPEN_RES = [
    /<(ul|div)[^>]*\bid=["'](list|asmr_file_list|webtoon_album|western_album)["'][^>]*>/i,
    /<div[^>]*class=["']grid["'][^>]*>/i,
];
const RIGHT_COLUMN_RE = /<div[^>]*class=["'][^"']*\bright\b/i;

function mainListRegion(html) {
    if (!html) return null;
    let open = null;
    for (const re of MAIN_LIST_OPEN_RES) {
        open = html.match(re);
        if (open) break;
    }
    if (!open) return null;
    const start = open.index;
    const rightRel = html.slice(start).search(RIGHT_COLUMN_RE);
    const end = rightRel >= 0 ? start + rightRel : html.length;
    return { start, end, html: html.slice(start, end) };
}

/* 章节聚合页（系列页）识别：网漫 / 西漫的频道条目是"系列页"而非图集页，
 * 正文是 <dd class="chapters"> 下的 <a class="chapter-name"> 章节列表
 * （/webtoon/6291.html → /h/870299.html，/western/comic-5609.html → /western/500622.html），
 * 页面自身没有大图。当图集解析只会得到 0 页空画廊，"边下边播"静默无事发生。 */
function parseSeriesChapters(html) {
    const chapters = [];
    if (!html) return chapters;
    const re = /<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bchapter-name\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const nameM = m[2].match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
        chapters.push({ url: absolutizeUrl(m[1]), title: stripTags(nameM ? nameM[1] : m[2]) });
    }
    return chapters;
}

// 单条目解析：主锚 + 向后窗口（到下一主锚为止）→ 封面/标题/元信息。
// 无封面图的野锚返回 null，调用方跳过（不占去重键）。
function parseChannelItem(html, anchor, winEnd, channelId) {
    const prefix = anchor.href.split('/')[1].toLowerCase();
    const block = html.slice(anchor.index, Math.min(winEnd, anchor.index + 2500));
    // 主锚必带封面图（thumb 或 grid），没有则跳过
    if (!/<img/i.test(block.slice(0, 1200))) return null;

    // 封面：直链 src 优先，lazy 图回退 data-original / data-src
    let cover = '';
    const imgTag = block.match(/<img[^>]*>/i);
    if (imgTag) {
        const srcM = imgTag[0].match(/\ssrc="([^"]+)"/i);
        const lazyM = imgTag[0].match(/\sdata-(?:original|src)="([^"]+)"/i);
        const raw = (srcM && srcM[1]) || (lazyM && lazyM[1]) || '';
        // 占位小图（1px gif / loading）直接丢弃，换 lazy 源
        if (/1x1|placeholder|loading|blank/i.test(raw) && lazyM) {
            cover = absolutizeUrl(lazyM[1]);
        } else {
            cover = absolutizeUrl(raw);
        }
    }
    // <picture> 分支：站点对部分老图给 avif/webp 多源，<img> 只放一张"请换浏览器"占位图
    // （/statics/images/up_browser.png）。只读 <img src> 会让这些条目顶着占位图当封面。
    if (/up_browser|up-browser/i.test(cover) || !cover) {
        const picM = block.match(/<picture[^>]*>([\s\S]*?)<\/picture>/i);
        if (picM) {
            const sources = [...picM[1].matchAll(/<source[^>]*\ssrcset=["']([^"'\s,]+)[^"']*["'][^>]*>/gi)];
            // webp 优先（兼容性最好），否则取首个 source
            const webp = sources.find((s) => /type=["']image\/webp["']/i.test(s[0]));
            const picked = webp || sources[0];
            if (picked) cover = absolutizeUrl(picked[1]);
        }
    }

    // 标题：a title 属性 > span.title 内链文本 > h3 > img alt
    let title = '';
    const titleAttr = anchor.tag.match(/\stitle="([^"]*)"/i);
    const spanTitle = block.match(/<span class="title"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const h3Title = block.match(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const altM = imgTag ? imgTag[0].match(/\salt="([^"]*)"/i) : null;
    title = stripTags((titleAttr && titleAttr[1]) || '')
        || stripTags((spanTitle && spanTitle[1]) || '')
        || stripTags((h3Title && h3Title[1]) || '')
        || stripTags((altM && altM[1]) || '')
        || `作品 ${anchor.gid}`;

    // 元信息
    const timeM = block.match(/<(?:i|span) class="(?:time fl|time|date)"[^>]*>([\s\S]*?)<\/(?:i|span)>/i);
    const langM = block.match(/<(?:i|span) class="(?:lang corner|lang)[^"]*"[^>]*>([\s\S]*?)<\/(?:i|span)>/i);
    const tagM = block.match(/<i class="top-tags"[^>]*>([\s\S]*?)<\/i>/i);
    const pageNumM = block.match(/<span class="pagenum"[^>]*>([\s\S]*?)<\/span>/i);
    const catM = block.match(/<span class="category"[^>]*>([\s\S]*?)<\/span>/i);
    const viewM = block.match(/<span class="view[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const mediaM = block.match(/<span class="media[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const h4M = block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);

    let kind = kindOfPrefix(prefix);
    // 写真频道图文视频混排：标题挂 .mp4 或 category=视频 判为视频
    if (prefix === 'cos' && (/\.mp4\s*$/i.test(title) || /视频/.test((catM && catM[1]) || ''))) {
        kind = 'video';
    }
    const duration = stripTags((mediaM && mediaM[1]) || (pageNumM && /:/.test(pageNumM[1]) ? pageNumM[1] : '') || (h4M && h4M[1].match(/时长[:：]\s*([^[\]]+)/) ? h4M[1].match(/时长[:：]\s*([^[\]]+)/)[1] : '') || '');
    // 有声条目 h4 同时塞了作者与时长（"[小苮儿] [时长:13Min]"）：作者字段必须摘掉时长，
    // 否则播放列表/条目卡片把"作者"渲染成"[小苮儿] [时长:13Min]"。
    const h4Text = stripTags((h4M && h4M[1]) || '');
    const artist = h4Text.replace(/\[?\s*时长[:：][^\]]*\]?/g, '').trim();

    // 网漫/西漫的 .views 里放的是"共 N 章"（章节数）而非观看数：原样塞进 views
    // 会被条目卡片渲染成"共22章 浏览"，而页数槽位反而空着。按语义归位到 pages。
    const viewText = stripTags((viewM && viewM[1]) || '');
    const chapterCountM = viewText.match(/^共\s*(\d+)\s*章$/);
    const pagesText = stripTags((pageNumM && pageNumM[1]) || '');
    const viewsText = chapterCountM ? '' : viewText;

    return {
        gid: anchor.gid,
        url: `${BASE}${anchor.href}`,
        title,
        cover,
        date: stripTags((timeM && timeM[1]) || ''),
        lang: stripTags((langM && langM[1]) || ''),
        tag: stripTags((tagM && tagM[1]) || (catM && catM[1]) || ''),
        pages: chapterCountM ? viewText : pagesText,
        views: viewsText,
        duration,
        artist,
        prefix,
        kind,
        channel: channelId,
    };
}

function parseChannelList(html, channelId) {
    // 只扫主列表容器区间：右栏排行榜侧栏的条目锚与主列表完全同形，
    // 全文扫描会把侧栏作品混进卡片墙（详见 mainListRegion 注释）。
    // 未识别到容器（模板变更）时回退全文，宁可多收也不错收成空列表。
    const region = mainListRegion(html);
    const scope = region ? region.html : html;
    const items = [];
    const seen = new Set();
    // 锚点扫描：以外层 li/div 无关的方式找详情锚（thumb 类，或带 title，或后跟标题块），
    // 上下文窗口向后取到下一个详情锚为止，避免把相邻条目元信息串味
    // 搜索页（search.acgmho.com 跳转后的 www 页面）的条目锚是绝对地址
    // （href="https://www.acgmho.com/h/216093.html"），频道页是相对地址：
    // 前缀组可选，捕获组保持相对路径，下游 `${BASE}${href}` 才不会双重拼接。
    // 西漫系列页是 comic-<数字> 词缀（/western/comic-5609.html），数字前必须有 comic-，
    // 漏掉这一形态会让整个西漫频道解析出 0 条（卡片墙空白）。
    const aRe = /<a[^>]*href="(?:(?:https?:)?\/\/[^"']*?)?(\/(?:h|hentai|gif|hanime|asmr|cos|webtoon|western|animation)\/(?:comic-)?(\d+)\.html)"[^>]*>/gi;
    const anchors = [];
    let am;
    while ((am = aRe.exec(scope)) !== null) {
        anchors.push({ href: am[1], gid: am[2], tag: am[0], index: am.index });
    }
    // 只要主锚：封面锚（thumb），或自带标题+封面的 grid 锚（hanime/gif）。
    // 标题复读锚（span.title/h3 里的第二个链接）既不建条目，也不切分窗口，
    // 否则封面锚的窗口在标题处被截断，后面的日期/语言/标签全丢。
    const primaries = anchors.filter((a) => {
        const behind = scope.slice(Math.max(0, a.index - 200), a.index);
        if (/(<h3[^>]*>|<span class="title"[^>]*>)\s*$/i.test(behind)) return false;
        if (/class="[^"]*\bthumb\b/i.test(a.tag)) return true;
        if (/\stitle="/i.test(a.tag) && /<img/i.test(scope.slice(a.index, a.index + 800))) return true;
        return false;
    });
    for (let k = 0; k < primaries.length; k++) {
        const a = primaries[k];
        // 去重键必须带前缀：/h/123 与 /hentai/123 是两本不同的作品
        const uniqKey = `${a.href.split('/')[1].toLowerCase()}:${a.gid}`;
        if (seen.has(uniqKey)) continue;
        const winEnd = k + 1 < primaries.length ? primaries[k + 1].index : a.index + 2500;
        const item = parseChannelItem(scope, a, winEnd, channelId);
        if (!item) continue;
        seen.add(uniqKey);
        items.push(item);
    }
    return items;
}

// 规范列表页翻页：/tags/sister.html 第 N 页为 /tags/sister-N.html，
// /h/ 这类频道页为 /h/index-N.html。调用方把上一页最终地址传回来即可。
function deriveListPageUrl(baseUrl, page) {
    const p = Math.max(1, Number(page) || 1);
    try {
        const u = new URL(baseUrl);
        if (p <= 1) return u.toString();
        // 全文搜索规范页带 token：/q/<query>-<n>-<md5>.html，页码是 token 前那段数字。
        // 不能走下面的"末尾 -N.html"分支——它会把 md5 尾部的数字当成页码替换，
        // 把 token 切烂。query 本身可含 '-'，用 -<n>-<32hex>.html 从后往前锚定。
        const mt = u.pathname.match(/^(.*)-(\d+)-([0-9a-f]{32})\.html$/i);
        if (mt) {
            u.pathname = `${mt[1]}-${p}-${mt[3]}.html`;
            return u.toString();
        }
        const m = u.pathname.match(/^(.*)-(\d+)\.html$/);
        if (m) {
            u.pathname = `${m[1]}-${p}.html`;
            return u.toString();
        }
        const m2 = u.pathname.match(/^(.*\/)index(-\d+)?\.html$/);
        if (m2) {
            u.pathname = `${m2[1]}index-${p}.html`;
            return u.toString();
        }
        const m3 = u.pathname.match(/^(.*)\.html$/);
        if (m3) {
            u.pathname = `${m3[1]}-${p}.html`;
            return u.toString();
        }
    } catch (_e) { /* 回退频道规则 */ }
    return baseUrl;
}

async function fetchChannelList({ channelId = 'latest', page = 1, query = '', baseUrl = '', cookieHeader = '' } = {}) {
    const q = String(query || '').trim();
    const isSearch = channelId === 'search' || !!q;
    if (isSearch && !q) {
        throw new Error('请输入搜索关键词');
    }
    if (!isSearch) {
        const ch = getChannel(channelId);
        if (!ch) throw new Error(`未知频道: ${channelId}`);
    }
    const p = Math.max(1, Number(page) || 1);

    // 搜索翻页走上一页的规范地址（/tags/xxx-N.html）：直接拼 /q/xxx-N.html
    // 服务端会 302 回第 1 页，翻页永远翻不动
    let url;
    if (isSearch) {
        if (p > 1 && baseUrl) {
            url = deriveListPageUrl(baseUrl, p);
        } else {
            url = channelListUrl('search', p, q);
        }
    } else {
        url = channelListUrl(channelId, p);
    }

    let html;
    let finalUrl;
    try {
        const fetched = await httpGetFinal(
            url,
            `${BASE}/`,
            // 搜索直抓是"有放行 cookie 时走快路"的优化，不能让卡住的连接拖住兜底自动过挑战：
            // 单次 10s、不重试（重试 3 次最坏 93s，用户看到的就是"窗口不弹、一直转圈"）。
            isSearch ? 10000 : 30000,
            isSearch ? 1 : 3,
            5,
            cookieHeader ? { Cookie: cookieHeader } : null
        );
        html = fetched.html;
        finalUrl = fetched.url;
    } catch (error) {
        // 全文搜索落在 search.acgmho.com，其前有 Cloudflare 挑战：裸访（无放行 cookie）
        // 直接 403 "Just a moment..."。把原始 HTTP 状态翻译成可操作的提示，
        // 调用方（main.js）会尽量带上 Electron 会话 cookie 重试前先拿凭证。
        if (isSearch && /HTTP 403/.test(error && error.message)) {
            throw new Error('站点搜索触发了验证：请先在内置浏览器里打开一次搜索页（通过验证），再回来重试');
        }
        // 站点限流另一种形态是直接回 429（与 200+"搜索过于频繁"提示页交替出现）：
        // 未翻译时用户看到裸 "HTTP 429"，且 main.js 的冷却检测也认不出。
        if (isSearch && /HTTP 429/.test(error && error.message)) {
            throw new Error('站点提示：搜索过于频繁，请等待约 30 秒后重试（不必更换关键词）');
        }
        throw error;
    }
    return buildChannelListResult({ channelId, page: p, query: q, html, finalUrl });
}

// 抓取结果组装（HTML → 条目/翻页）：Node 直抓与浏览器兜底共用同一套解析，
// 两处行为（无结果报错、hasMore 判定）天然一致，不会各说各话。
function buildChannelListResult({ channelId = 'latest', page = 1, query = '', html = '', finalUrl = '' }) {
    const q = String(query || '').trim();
    const p = Math.max(1, Number(page) || 1);
    const isSearch = channelId === 'search' || !!q;
    // 挑战页不是结果页：201 行左右的挑战壳会被解析成 0 条，UI 误报"未找到与「xx」相关的内容"，
    // 把"验证没过"伪装成"没有结果"。这里显式拦截，给出真实原因。
    if (isCloudflareChallengePage(html)) {
        throw new Error('站点搜索被人机验证拦截（Cloudflare 挑战未完成），没有取到结果；请检查网络（VPN/代理可能阻断验证域名）后重试');
    }
    if (isNotFoundPage(html)) {
        if (isSearch) {
            // 提示页分两种：可恢复（搜索过于频繁/关键词太短）与真无结果（404 皮页）。
            // 限流提示必须原样透出并给出等待建议，否则用户换词重试只会持续维持限流。
            const tip = extractSiteTip(html);
            if (/过于频繁/.test(tip)) {
                throw new Error('站点提示：搜索过于频繁，请等待约 30 秒后重试（不必更换关键词）');
            }
            if (tip) {
                throw new Error(`站点提示：${tip}`);
            }
            throw new Error(`未找到与「${q}」相关的内容，换个关键词试试`);
        }
        throw new Error('列表页加载失败（站点返回了错误页），请稍后重试');
    }
    const items = parseChannelList(html, channelId);
    // 还有更多：只以"本页是否解析出条目"为准，不采信翻页器里的"下一页"链接。
    // 实测站点翻页器自身不可靠：/index-3.html 的下一页指向自己（/index-3.html）且
    // 块内页码只到 3，但 /index-4.html 确实存在且内容是另一批作品（首个 gid 874370
    // vs 874425），/index-5..5000 同理。按链接判定会让"最新"频道在第 3 页就锁死，
    // 用户再也翻不到第 4 页以后的近万页内容。
    // 反向代价可控：越界页的主列表容器是空的（<ul id="list"></ul>），
    // 因此"本页 0 条"就是可靠的终止信号；末页多发一次请求后由调用方的
    // "追加零增长即收敛"逻辑收尾（见 useAcgmhoGallery.loadPage）。
    // 注意：此判据成立的前提是 parseChannelList 只扫主列表容器——
    // 侧栏排行榜条目会让越界空页看起来有 10~12 条，终止信号随之失效。
    const hasMore = items.length > 0;
    return { channelId, page: p, hasMore, items, query: q, baseUrl: finalUrl };
}

module.exports = {
    probeGallery,
    downloadGallery,
    saveGalleryImages,
    fetchGalleryPages,
    normalizeGid,
    galleryTaskKey,
    galleryKeyMatches,
    parsePageRange,
    GALLERY_CHANNELS,
    channelListUrl,
    deriveListPageUrl,
    parseChannelList,
    buildChannelListResult,
    fetchChannelList,
    isCloudflareChallengePage,
    isCloudflareErrorPage,
    // UA 由本模块持有（抓页面的是它），main.js 在拿到浏览器会话 UA 后推过来。
    // 代理相关不再从这里导出：那是进程级网络设施，归 main.js 的全局网络层。
    setUserAgent,
    getUserAgent,
};
