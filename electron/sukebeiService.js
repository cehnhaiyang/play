/**
 * sukebeiService.js — sukebei.nyaa.site / nyaa.site 资源搜索与 .torrent 获取。
 *
 * 站点结构（实测）：
 * - 搜索页: https://sukebei.nyaa.site/?q=关键词&c=1_2&f=0&p=2
 * - 列表行内含绝对路径详情链 https://sukebei.nyaa.site/view/<id>、
 *   种子直链 https://sukebei.nyaa.si/download/<id>.torrent（注意 host 是 .si）、magnet 链。
 * - 排序参数为 sort/order（与页面表头链接一致）。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const SITES = {
  sukebei: {
    search: 'https://sukebei.nyaa.site/',
    dlHost: 'https://sukebei.nyaa.si',
    label: 'sukebei.nyaa.site（成人/里区）',
  },
  nyaa: {
    search: 'https://nyaa.site/',
    dlHost: 'https://nyaa.si',
    label: 'nyaa.site（主站/表区）',
  },
};

const CATEGORIES = {
  '0_0': '全部分类',
  '1_0': 'Art - 全部',
  '1_1': 'Art - Anime',
  '1_2': 'Art - 同人志',
  '1_3': 'Art - 游戏',
  '1_4': 'Art - 漫画',
  '1_5': 'Art - 图包',
  '2_0': 'Real Life - 全部',
  '2_1': 'Real Life - 写真',
  '2_2': 'Real Life - 视频',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 种子/搜索只允许这几个站：渲染层传来的任意 URL 不能让主进程去抓（防 SSRF 打内网） */
const TORRENT_HOSTS = new Set([
  'sukebei.nyaa.site',
  'sukebei.nyaa.si',
  'nyaa.site',
  'nyaa.si',
]);

function assertTorrentHost(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (_e) {
    throw new Error(`非法种子地址: ${url}`);
  }
  if (!TORRENT_HOSTS.has(host)) {
    throw new Error(`种子地址不在白名单站点: ${host}`);
  }
}

/** 重定向最多跟 5 跳：旧实现无上限，站点 redirect loop 会堆出一串永不决议的 Promise */
const MAX_REDIRECTS = 5;

function httpGetText(url, referer = null, timeout = 30000, retries = 3, redirects = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    function attempt(n) {
      const headers = {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      };
      if (referer) headers.Referer = referer;
      const client = url.startsWith('https:') ? https : http;
      const req = client.get(url, { headers, timeout }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirects <= 0) {
            res.resume();
            reject(new Error(`重定向次数过多: ${url}`));
            return;
          }
          const redirectUrl = new URL(res.headers.location, url).toString();
          res.resume();
          httpGetText(redirectUrl, referer, timeout, retries, redirects - 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          if (n < retries) {
            setTimeout(() => attempt(n + 1), 1000 * n);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          }
          return;
        }
        const chunks = [];
        let received = 0;
        // 搜索页就几百 KB：超 10MB 必是异常响应，直接掐掉防内存爆炸
        const MAX_TEXT_BYTES = 10 * 1024 * 1024;
        res.on('data', (c) => {
          received += c.length;
          if (received > MAX_TEXT_BYTES) {
            req.destroy(new Error(`响应过大(>${MAX_TEXT_BYTES}B)，已中断: ${url}`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      });
      req.on('timeout', () => {
        req.destroy();
        if (n < retries) setTimeout(() => attempt(n + 1), 1000 * n);
        else reject(new Error(`请求超时: ${url}`));
      });
      req.on('error', (err) => {
        if (n < retries) setTimeout(() => attempt(n + 1), 1000 * n);
        else reject(err);
      });
    }
    attempt(1);
  });
}

function unescapeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function stripTags(s) {
  return unescapeHtml(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function buildSearchUrl(site, { q = '', category = '0_0', filter = '0', sort = 'id', order = 'desc', page = 1 } = {}) {
  const base = SITES[site].search;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (category && category !== '0_0') params.set('c', category);
  if (filter && filter !== '0') params.set('f', filter);
  if (sort && sort !== 'id') {
    params.set('sort', sort);
    params.set('order', order);
  }
  if (page && Number(page) > 1) params.set('p', String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function parseList(html, dlHost) {
  const items = [];
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(html)) !== null) {
    const rowHtml = row[0];
    const viewMatch = rowHtml.match(/href="(?:https?:\/\/[^"/]+)?(\/view\/(\d+))"[^>]*>([\s\S]*?)<\/a>/i);
    if (!viewMatch) continue;
    const viewPath = viewMatch[1];
    const id = viewMatch[2];
    const title = stripTags(viewMatch[3]) || `torrent-${id}`;

    const magnetMatch = rowHtml.match(/href="(magnet:\?[^"]+)"/i);
    const torrentMatch = rowHtml.match(/href="((?:https?:\/\/[^"]+)?\/download\/\d+\.torrent)"/i);
    let torrentUrl = torrentMatch ? unescapeHtml(torrentMatch[1]) : `${dlHost}/download/${id}.torrent`;
    if (torrentUrl.startsWith('/')) torrentUrl = dlHost + torrentUrl;
    const magnet = magnetMatch ? unescapeHtml(magnetMatch[1]) : '';

    const cells = [];
    const tdRe = /<td[\s\S]*?>([\s\S]*?)<\/td>/gi;
    let td;
    while ((td = tdRe.exec(rowHtml)) !== null) cells.push(stripTags(td[1]));

    let size = '';
    let date = '';
    const nums = [];
    for (const cell of cells) {
      if (/^[\d.]+\s*(B|KiB|MiB|GiB|TiB)$/i.test(cell)) size = cell;
      if (/^\d{4}-\d{2}-\d{2}/.test(cell)) date = cell;
      if (/^\d+$/.test(cell)) nums.push(parseInt(cell, 10));
    }
    let seeders = -1;
    let leechers = -1;
    let completed = -1;
    if (nums.length >= 3) {
      [seeders, leechers, completed] = nums.slice(-3);
    } else if (nums.length === 2) {
      [seeders, leechers] = nums;
    }

    const catMatch = rowHtml.match(/\?c=(\d+_\d+)/);
    const category = catMatch ? CATEGORIES[catMatch[1]] || catMatch[1] : '';

    items.push({
      id, title, view: viewPath, torrent: torrentUrl, magnet,
      size, date, seeders, leechers, completed, category,
    });
  }
  const seen = new Set();
  return items.filter((it) => {
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

async function searchSukebei({ site = 'sukebei', q = '', category = '0_0', filter = '0', sort = 'id', pages = 1, minSeeders = 0 } = {}) {
  if (!SITES[site]) throw new Error(`未知站点: ${site}`);
  if (!q || !String(q).trim()) throw new Error('搜索关键词不能为空');
  const dlHost = SITES[site].dlHost;
  const pageCount = Math.max(1, Math.min(10, Number(pages) || 1));
  const all = [];
  for (let p = 1; p <= pageCount; p++) {
    const url = buildSearchUrl(site, { q, category, filter, sort, page: p });
    const html = await httpGetText(url, SITES[site].search);
    const items = parseList(html, dlHost);
    if (items.length === 0) break;
    all.push(...items);
    if (p < pageCount) await new Promise((r) => setTimeout(r, 800));
  }
  const seen = new Set();
  const deduped = all.filter((it) => {
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
  const base = SITES[site].search.replace(/\/$/, '');
  const withSite = deduped.map((it) => ({ ...it, site, viewUrl: base + it.view }));
  if (minSeeders > 0) return withSite.filter((it) => it.seeders >= minSeeders);
  return withSite;
}

function sanitizeFileName(name, fallback = 'torrent') {
  const clean = String(name || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return clean || fallback;
}

function downloadBytes(url, referer = null, timeout = 60000, redirects = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': UA, Referer: referer || '' }, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirects <= 0) {
          res.resume();
          reject(new Error(`重定向次数过多: ${url}`));
          return;
        }
        const redirectUrl = new URL(res.headers.location, url).toString();
        res.resume();
        downloadBytes(redirectUrl, referer, timeout, redirects - 1).then(resolve).catch(reject);
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error(`下载失败，HTTP ${res.statusCode || '未知'}: ${url}`));
        return;
      }
      const chunks = [];
      let received = 0;
      // .torrent 正常就几十 KB：超 20MB 必是错链/攻击，直接掐掉
      const MAX_TORRENT_BYTES = 20 * 1024 * 1024;
      res.on('data', (c) => {
        received += c.length;
        if (received > MAX_TORRENT_BYTES) {
          req.destroy();
          reject(new Error(`种子文件过大(>${MAX_TORRENT_BYTES}B)，疑似错误链接: ${url}`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`下载超时: ${url}`));
    });
    req.on('error', reject);
  });
}

/** 下载 .torrent 种子文件到目录，返回保存路径（顺带校验 bencode 头）。 */
async function downloadTorrentFile({ site = 'sukebei', id = '', torrentUrl = '', title = '', outDir = '' } = {}) {
  if (!SITES[site]) throw new Error(`未知站点: ${site}`);
  const vid = String(id).match(/(\d+)/)?.[1] || '';
  const url = torrentUrl || (vid ? `${SITES[site].dlHost}/download/${vid}.torrent` : '');
  if (!url) throw new Error('缺少种子 ID 或直链');
  assertTorrentHost(url);
  const data = await downloadBytes(url, SITES[site].search);
  if (!data || data[0] !== 0x64 /* 'd' */) {
    throw new Error('站点未返回合法 torrent 文件（可能已被删除）');
  }
  const dir = outDir || path.join(require('os').homedir(), 'Downloads', 'the-play', 'torrents');
  fs.mkdirSync(dir, { recursive: true });
  const fileName = vid ? `[${vid}] ${sanitizeFileName(title || vid)}.torrent` : `${sanitizeFileName(title)}.torrent`;
  const dest = path.join(dir, fileName);
  fs.writeFileSync(dest, data);
  return { path: dest, bytes: data.length };
}

function extractId(input) {
  const m = String(input || '').match(/\/view\/(\d+)/) ||
    String(input || '').match(/\/download\/(\d+)\.torrent/) ||
    String(input || '').match(/(\d{4,})/);
  return m ? m[1] : '';
}

module.exports = {
  SITES,
  CATEGORIES,
  buildSearchUrl,
  parseList,
  searchSukebei,
  downloadTorrentFile,
  extractId,
};
