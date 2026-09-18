const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const BASE = 'https://www.acgmho.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

// 连接复用：详情/列表/图片全走 keep-alive，200 页连抓不再每页重建 TCP+TLS。
// maxSockets  cap 并发上限，配合业务层并发池使用，避免打满服务端。
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

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
      if (i >= n) return;
      out[i] = await worker(list[i], i);
    }
  });
  return Promise.all(runners).then(() => out);
}

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
  return unescapeHtml(s.replace(/<[^>]+>/g, '')).trim();
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

// 抓取 HTML 并跟踪 302 最终地址：站内搜索 /q/xxx-N.html 会 302 到规范页
// （如 /tags/sister.html），后续翻页必须基于规范地址，否则服务端永远回第 1 页。
// extraHeaders：调用方可注入 Cookie（如 Electron 会话里的 Cloudflare 放行凭证），
// 键与 HEADERS 冲突时调用方优先。
function httpGetFinal(url, referer = null, timeout = 30000, retries = 3, redirects = 5, extraHeaders = null) {
  return new Promise((resolve, reject) => {
    // 链内 cookie jar：跳转链中途种下的 cookie（如 www 的会话标识）后续跳要带上，
    // 否则跨子域（www → search.acgmho.com）直接裸访，容易被风控 403。
    const jar = [];
    const rememberCookies = (setCookie) => {
      for (const c of setCookie || []) {
        const pair = String(c).split(';')[0].trim();
        if (!pair || !pair.includes('=')) continue;
        const name = pair.slice(0, pair.indexOf('='));
        const idx = jar.findIndex((j) => j.slice(0, j.indexOf('=')) === name);
        if (idx >= 0) jar[idx] = pair;
        else jar.push(pair);
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

      const client = currentUrl.startsWith('https:') ? https : http;
      const agent = currentUrl.startsWith('https:') ? httpsAgent : httpAgent;
      const req = client.get(currentUrl, { headers, timeout, agent }, (res) => {
        rememberCookies(res.headers['set-cookie']);
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (remaining <= 0) {
            res.resume();
            reject(new Error(`重定向次数过多: ${currentUrl}`));
            return;
          }
          // 中文站 Location 常带未编码的原始 UTF-8（如 /q/汤…-1-<md5>.html）：
          // Node http 头按 latin1 给字符串，直接 new URL 会把"UTF-8 字节误读成 latin1 字符"
          // 再百分编码一次（%E6%B9%AF → %C3%A6…），搜索子域对这类坏 URL 直接 403。
          // 先按 latin1 还原字节、按 UTF-8 解码；已编码的纯 ASCII 路径不受影响。
          const location = Buffer.from(String(res.headers.location), 'latin1').toString('utf-8');
          const redirectUrl = new URL(location, currentUrl).toString();
          res.resume();
          attempt(n, redirectUrl, remaining - 1);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          // 4xx 不重试：404 是资源不存在、403 是风控/挑战拦路，重试只会白等退避时间。
          // 之前全状态都重试：auto 探测 8 候选 × 3 次 × 退避，死 gid 一次探测被拖慢数十秒。
          // 408（超时）/429（限流）与 5xx 例外，仍按退避重试。
          const retryable = res.statusCode === 408 || res.statusCode === 429 || res.statusCode >= 500;
          if (retryable && n < retries) {
            setTimeout(() => attempt(n + 1, currentUrl, remaining), 1000 * n);
          } else {
            reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
          }
          return;
        }

        const chunks = [];
        let received = 0;
        const MAX_BODY = 10 * 1024 * 1024;
        res.on('data', (c) => {
          received += c.length;
          if (received > MAX_BODY) {
            req.destroy();
            reject(new Error(`响应过大，已中断: ${currentUrl}`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf-8'), url: currentUrl }));
      });

      req.on('timeout', () => {
        req.destroy();
        if (n < retries) {
          setTimeout(() => attempt(n + 1, currentUrl, remaining), 1000 * n);
        } else {
          reject(new Error(`Timeout fetching ${currentUrl}`));
        }
      });

      req.on('error', (err) => {
        if (n < retries) {
          setTimeout(() => attempt(n + 1, currentUrl, remaining), 1000 * n);
        } else {
          reject(err);
        }
      });
    }

    attempt(1, url, redirects);
  });
}

function httpGet(url, referer = null, timeout = 30000, retries = 3, redirects = 5) {
  return httpGetFinal(url, referer, timeout, retries, redirects).then((r) => r.html);
}

function normalizeGid(input) {
  const str = String(input || '').trim();
  // /g/ 为站外短链/占位写法：只取数字走 auto 全候选，不硬绑定前缀
  const shortMatch = str.match(/\/g\/(\d+)/i);
  if (shortMatch) {
    return { gid: shortMatch[1], prefix: 'auto' };
  }
  const urlMatch = str.match(/\/(hentai|h|hanime|asmr|gif|animation|cos|webtoon|western)\/(\d+)/i);
  if (urlMatch) {
    const rawPrefix = urlMatch[1].toLowerCase();
    return { gid: urlMatch[2], prefix: rawPrefix === 'animation' ? 'gif' : rawPrefix };
  }
  const idMatch = str.match(/(\d+)/);
  return {
    gid: idMatch ? idMatch[1] : str,
    prefix: 'auto',
  };
}

function pageUrl(gid, n, prefix = 'hentai') {
  return n === 1 ? `${BASE}/${prefix}/${gid}.html` : `${BASE}/${prefix}/${gid}-${n}.html`;
}

function parsePage(gid, n, html, prefix = 'hentai') {
  const picMatch = html.match(/<p class="manga-picture">([\s\S]*?)<\/p>/i);
  let src = null;
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

  const titleMatch = html.match(/<h1 class="title">([\s\S]*?)<\/h1>/i);
  // 站点实测双引号，兼容单引号写法
  const nextMatch = html.match(/next_page_url\s*=\s*["']([^"']+)["']/i);
  const nextUrl = nextMatch ? nextMatch[1] : null;

  let detectedPrefix = prefix;
  if (nextUrl) {
    const prefMatch = nextUrl.match(/^\/(hentai|h|asmr|gif|hanime|cos|webtoon|western|animation)\//i);
    if (prefMatch) {
      detectedPrefix = prefMatch[1].toLowerCase();
    }
  }

  let total = null;
  const pagesBlockMatch = html.match(/<div class="page" id="pages">([\s\S]*?)<\/div>/i);
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
    img_url: src,
    img_alt: alt,
    next_page_url: nextUrl,
    total_pages: total,
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

// 媒体直链归一：站点详情页偶发相对路径（/videos/x.mp4）或 // 开头，
// 原样塞进播放器会导致播不出，统一补成绝对地址
function absolutizeMediaUrl(u) {
  if (!u) return u;
  const s = String(u).trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (s.startsWith('/')) return `${BASE}${s}`;
  return s;
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

  // 按初始前缀组织候选地址：指定前缀只探一个，未指定（auto）全候选并发试
  let candidateUrls = [];
  if (initialPrefix !== 'auto') {
    candidateUrls.push(pageUrl(gid, 1, initialPrefix));
  } else {
    candidateUrls.push(
      `${BASE}/h/${gid}.html`,
      `${BASE}/hentai/${gid}.html`,
      `${BASE}/asmr/${gid}.html`,
      `${BASE}/gif/${gid}.html`,
      `${BASE}/hanime/${gid}.html`,
      `${BASE}/cos/${gid}.html`,
      `${BASE}/webtoon/${gid}.html`,
      `${BASE}/western/${gid}.html`
    );
  }

  // 并发探测：候选按优先级排序，全部并行发出后按优先级取首个有效命中（串行逐个试太慢）。
  let html = null;
  let matchedUrl = '';
  if (candidateUrls.length === 1) {
    try {
      const res = await httpGet(candidateUrls[0]);
      if (res && !isNotFoundPage(res)) {
        html = res;
        matchedUrl = candidateUrls[0];
      }
    } catch (_e) { /* ignore */ }
  } else {
    const settled = await Promise.allSettled(candidateUrls.map((url) => httpGet(url)));
    for (let i = 0; i < candidateUrls.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled' && r.value && !isNotFoundPage(r.value)) {
        html = r.value;
        matchedUrl = candidateUrls[i];
        break;
      }
    }
  }

  if (!html) {
    throw new Error(`未能获取到作品信息 (${gidOrUrl})，请确认链接或作品 ID 是否有效`);
  }

  // 提取通用标题
  const titleMatch = html.match(/<h1[^>]*class="title"[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<title>([\s\S]*?)<\/title>/i);
  const rawTitle = titleMatch ? stripTags(titleMatch[1]) : `ACG作品 ${gid}`;
  const cleanTitle = rawTitle.replace(/\s*-\s*ACG.*$/i, '').trim();

  // 音频 → 视频 → 图集依次判定（分支函数见本文件上方），图集为默认归宿
  const mediaCtx = { gid, cleanTitle, html, matchedUrl };
  return probeAudioResult(mediaCtx) || probeVideoResult(mediaCtx) || probeImageResult(mediaCtx);
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
  if (!spec || spec.trim().toLowerCase() === 'all') {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages = new Set();
  const chunks = spec.split(',');
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
          if (i >= 1 && i <= totalPages) pages.add(i);
        }
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= totalPages) pages.add(num);
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
}

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
    const agent = url.startsWith('https:') ? httpsAgent : httpAgent;
    // 写盘流提至外层：网络错误/超时时一并销毁，否则 fd 泄漏；
    // 写盘流自身错误（如磁盘满）也要接住，否则触发 unhandled 'error' 直接崩进程
    let fileStream = null;
    let req = null;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { if (fileStream) fileStream.destroy(); } catch (_e) { /* ignore */ }
      try { if (req) req.destroy(); } catch (_e) { /* ignore */ }
      reject(err);
    };
    req = client.get(url, { headers, timeout: 120000, agent }, (res) => {
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
          try {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const p = String(prefix || '').toLowerCase();
  const leaf = p && p !== 'auto' ? `${p}-${gid}` : String(gid);
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

  if (cancelled || (isCancelled && isCancelled(gid))) {
    cancelled = true;
    if (onProgress) {
      onProgress({
        gid,
        currentPage: doneCount,
        totalPages: targetPages.length,
        currentBytes: 0,
        totalBytes: 0,
        percent: Math.round((doneCount / targetPages.length) * 100),
        currentUrl: '',
        status: 'cancelled',
        message: '用户已取消下载',
        savedFiles,
      });
    }
  }
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
  const numbered = list.map((item, i) => ({ item, n: item.page > 0 ? item.page : i + 1 }));
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
  if (cancelledEarly) {
    emit({ status: 'cancelled', message: '用户已取消保存' });
  }
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

  const cancelled = isCancelled && isCancelled(gidStr);
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

  if (cancelledSeen || (isCancelled && isCancelled(gid))) {
    emitState(doneCount, null, 'cancelled');
  } else if (pendingPages.length > 0) {
    emitState(doneCount, pages[pages.length - 1] || null, 'completed');
  }
  // 并发完成顺序不定：按页码排序后返回，调用方批量进播放列表时顺序即正确
  // （prefix 即 basePrefix，并发期无人改写，无需回写）
  pages.sort((a, b) => (a.page || 0) - (b.page || 0));
  errors.sort((a, b) => (a.page || 0) - (b.page || 0));

  // 全跳过（纯续抓命中）也给一个 completed，调用方好收尾
  if (pendingPages.length === 0) {
    emitState(0, pages[pages.length - 1] || null, 'completed');
  }

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

  return {
    gid: anchor.gid,
    url: `${BASE}${anchor.href}`,
    title,
    cover,
    date: stripTags((timeM && timeM[1]) || ''),
    lang: stripTags((langM && langM[1]) || ''),
    tag: stripTags((tagM && tagM[1]) || (catM && catM[1]) || ''),
    pages: stripTags((pageNumM && pageNumM[1]) || ''),
    views: stripTags((viewM && viewM[1]) || ''),
    duration,
    artist: stripTags((h4M && h4M[1]) || ''),
    prefix,
    kind,
    channel: channelId,
  };
}

function parseChannelList(html, channelId) {
  const items = [];
  const seen = new Set();
  // 锚点扫描：以外层 li/div 无关的方式找详情锚（thumb 类，或带 title，或后跟标题块），
  // 上下文窗口向后取到下一个详情锚为止，避免把相邻条目元信息串味
  const aRe = /<a[^>]*href="(\/(?:h|hentai|gif|hanime|asmr|cos|webtoon|western|animation)\/(\d+)\.html)"[^>]*>/gi;
  const anchors = [];
  let am;
  while ((am = aRe.exec(html)) !== null) {
    anchors.push({ href: am[1], gid: am[2], tag: am[0], index: am.index });
  }
  // 只要主锚：封面锚（thumb），或自带标题+封面的 grid 锚（hanime/gif）。
  // 标题复读锚（span.title/h3 里的第二个链接）既不建条目，也不切分窗口，
  // 否则封面锚的窗口在标题处被截断，后面的日期/语言/标签全丢。
  const primaries = anchors.filter((a) => {
    const behind = html.slice(Math.max(0, a.index - 200), a.index);
    if (/(<h3[^>]*>|<span class="title"[^>]*>)\s*$/i.test(behind)) return false;
    if (/class="[^"]*\bthumb\b/i.test(a.tag)) return true;
    if (/\stitle="/i.test(a.tag) && /<img/i.test(html.slice(a.index, a.index + 800))) return true;
    return false;
  });
  for (let k = 0; k < primaries.length; k++) {
    const a = primaries[k];
    // 去重键必须带前缀：/h/123 与 /hentai/123 是两本不同的作品
    const uniqKey = `${a.href.split('/')[1].toLowerCase()}:${a.gid}`;
    if (seen.has(uniqKey)) continue;
    const winEnd = k + 1 < primaries.length ? primaries[k + 1].index : a.index + 2500;
    const item = parseChannelItem(html, a, winEnd, channelId);
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
      30000,
      3,
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
  if (isNotFoundPage(html)) {
    if (isSearch) {
      throw new Error(`未找到与「${q}」相关的内容，换个关键词试试`);
    }
    throw new Error('列表页加载失败（站点返回了错误页），请稍后重试');
  }
  const items = parseChannelList(html, channelId);
  // 还有更多：下一页链接存在即视为有。频道页是 index-N.html，
  // 搜索规范页（tags/anime/characters）是 xxx-N.html，两种都认。
  // 注意：必须限定在分页块内判断——画廊详情分页链接（如 /hentai/123-5.html）
  // 同样含 -N.html，全文匹配会在末页误判 hasMore，常亮"加载更多"打转。
  // 取最后一个 page 类 div：翻页器（<div class="page bigpage">）在文档底部；
  // 之前取第一个，文档前部的其他 page 类容器先被命中，非贪婪到首个 </div> 就截断，
  // 块内根本没有翻页链接 → 首页 hasMore 恒为 false，"加载更多"永不出现、无限滚动也不触发。
  const pageBlockMatches = [...html.matchAll(/<div[^>]*class="[^"]*\bpage\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
  const pageBlock = pageBlockMatches.length ? pageBlockMatches[pageBlockMatches.length - 1][1] : '';
  const hasNextInBlock = pageBlock
    ? new RegExp(`(?:index-${p + 1}\\.html|-${p + 1}\\.html)`).test(pageBlock)
    : html.includes(`index-${p + 1}.html`);
  const hasMore = items.length > 0 && hasNextInBlock;
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
};
