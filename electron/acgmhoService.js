const fs = require('fs');
const path = require('path');
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

function httpGet(url, referer = null, timeout = 30000, retries = 3, redirects = 5) {
  return new Promise((resolve, reject) => {
    function attempt(n) {
      const headers = { ...HEADERS };
      if (referer) {
        headers.Referer = referer;
      }

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
          httpGet(redirectUrl, referer, timeout, retries, redirects - 1).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          if (n < retries) {
            setTimeout(() => attempt(n + 1), 1000 * n);
          } else {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
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
            reject(new Error(`响应过大，已中断: ${url}`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      });

      req.on('timeout', () => {
        req.destroy();
        if (n < retries) {
          setTimeout(() => attempt(n + 1), 1000 * n);
        } else {
          reject(new Error(`Timeout fetching ${url}`));
        }
      });

      req.on('error', (err) => {
        if (n < retries) {
          setTimeout(() => attempt(n + 1), 1000 * n);
        } else {
          reject(err);
        }
      });
    }

    attempt(1);
  });
}

function normalizeGid(input) {
  const str = String(input || '').trim();
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
    const srcMatch = picMatch[1].match(/<img[^>]*?\ssrc="([^"]+)"/i);
    const altMatch = picMatch[1].match(/<img[^>]*?\salt="([^"]*)"/i);
    src = srcMatch ? srcMatch[1] : null;
    alt = altMatch ? altMatch[1] : null;
  }

  const titleMatch = html.match(/<h1 class="title">([\s\S]*?)<\/h1>/i);
  const nextMatch = html.match(/next_page_url\s*=\s*"([^"]+)"/i);
  const nextUrl = nextMatch ? nextMatch[1] : null;

  let detectedPrefix = prefix;
  if (nextUrl) {
    const prefMatch = nextUrl.match(/^\/(hentai|h|asmr|gif|cos)\//i);
    if (prefMatch) {
      detectedPrefix = prefMatch[1];
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

async function probeGallery(gidOrUrl) {
  const { gid, prefix: initialPrefix } = normalizeGid(gidOrUrl);

  // Candidate URLs to probe based on initial prefix
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
      `${BASE}/webtoon/${gid}.html`
    );
  }

  let html = null;
  let matchedUrl = '';
  for (const url of candidateUrls) {
    try {
      const res = await httpGet(url);
      if (
        res &&
        res.length > 500 &&
        !res.includes('404 Not Found') &&
        !res.includes('<title>提示信息</title>') &&
        !res.includes('class="showMsg"')
      ) {
        html = res;
        matchedUrl = url;
        break;
      }
    } catch (_e) {
      // try next candidate
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

  // 1. 检查是否为 ASMR / 音频 (有声音声)
  if (matchedUrl.includes('/asmr/') || html.includes('APlayer') || html.includes('aplayer')) {
    const apMatch = html.match(/new\s+APlayer\(\{[\s\S]*?audio:\s*(\[[\s\S]*?\])[\s\S]*?\}\);/i);
    let audioList = [];
    if (apMatch) {
      try {
        audioList = new Function('return ' + apMatch[1])();
      } catch (_e) {
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
  }

  // 2. 检查是否为 动画 / 视频 (GIF/Plyr/LD+JSON VideoObject/HLS/里番)
  if (matchedUrl.includes('/gif/') || matchedUrl.includes('/hanime/') || matchedUrl.includes('/animation/') || html.includes('VideoObject') || html.includes('masterUrl')) {
    let videoUrl = null;
    let poster = null;
    let duration = null;

    const ldJsonMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (ldJsonMatch) {
      try {
        const data = JSON.parse(ldJsonMatch[1]);
        if (data['@type'] === 'VideoObject') {
          videoUrl = data.contentUrl;
          poster = Array.isArray(data.thumbnailUrl) ? data.thumbnailUrl[0] : data.thumbnailUrl;
          duration = data.duration;
        }
      } catch (_e) { }
    }

    if (!videoUrl) {
      const masterUrlMatch = html.match(/masterUrl\s*=\s*"([^"]+)"/i) || html.match(/"contentUrl":\s*"([^"]+)"/i);
      videoUrl = masterUrlMatch ? masterUrlMatch[1] : null;
    }

    if (!poster) {
      const posterMatch = html.match(/poster="([^"]+)"/i);
      poster = posterMatch ? posterMatch[1] : null;
    }

    if (videoUrl) {
      const videoPrefix = matchedUrl.includes('/hanime/') ? 'hanime'
        : matchedUrl.includes('/gif/') ? 'gif'
        : matchedUrl.includes('/cos/') ? 'cos' : 'gif';
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
  }

  // 3. 检查是否为漫画 / 动图图集
  const currentPrefix = matchedUrl.includes('/h/') ? 'h' : 'hentai';
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
    const req = client.get(url, { headers, timeout: 120000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        res.resume();
        downloadImageWithResume(redirectUrl, dest, referer, onChunk).then(resolve).catch(reject);
        return;
      }

      if (pos > 0 && res.statusCode === 200) {
        // Server doesn't support Range, start over
        pos = 0;
      }

      const contentLength = parseInt(res.headers['content-length'] || '0', 10);
      const totalBytes = contentLength + pos;
      let doneBytes = pos;

      const fileStream = fs.createWriteStream(part, { flags: pos > 0 ? 'a' : 'w' });

      res.on('data', (chunk) => {
        fileStream.write(chunk);
        doneBytes += chunk.length;
        if (onChunk) {
          onChunk(doneBytes, totalBytes);
        }
      });

      res.on('end', () => {
        fileStream.end(() => {
          try {
            fs.renameSync(part, dest);
            resolve(fs.statSync(dest).size);
          } catch (renameErr) {
            reject(renameErr);
          }
        });
      });

      res.on('error', (err) => {
        fileStream.close();
        reject(err);
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout downloading ${url}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 标题做文件名：去非法字符、压空白、限长，空时回退 gid
function sanitizeTitle(name, fallback) {
  const clean = String(name || fallback || 'gallery')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return clean || String(fallback || 'gallery');
}

async function downloadGallery(options, onProgress, isCancelled) {
  const { gidOrUrl, pages: pageSpec, outDir, delayMs = 1000 } = options;
  const probe = await probeGallery(gidOrUrl);
  const { gid, totalPages } = probe;
  let { prefix } = probe;

  const targetPages = parsePageRange(pageSpec, totalPages);
  const galleryDir = outDir || path.join(process.env.USERPROFILE || '', 'Downloads', 'acgmho', String(gid));
  fs.mkdirSync(galleryDir, { recursive: true });

  const records = [];
  const savedFiles = [];

  for (let idx = 0; idx < targetPages.length; idx++) {
    const n = targetPages[idx];
    if (isCancelled && isCancelled(gid)) {
      if (onProgress) {
        onProgress({
          gid,
          currentPage: n,
          totalPages: targetPages.length,
          currentBytes: 0,
          totalBytes: 0,
          percent: Math.round((idx / targetPages.length) * 100),
          currentUrl: '',
          status: 'cancelled',
          message: '用户已取消下载',
          savedFiles,
        });
      }
      break;
    }

    const url = pageUrl(gid, n, prefix);
    let html = null;
    try {
      if (n === 1 && probe.firstHtml) {
        html = probe.firstHtml;
      } else {
        html = await httpGet(url);
      }
    } catch (err) {
      records.push({ page: n, page_url: url, error: String(err.message || err) });
      continue;
    }

    const info = parsePage(gid, n, html, prefix);
    prefix = info.prefix;

    if (!info.img_url) {
      records.push({
        ...info,
        error: '未在该页找到大图',
      });
      continue;
    }

    const ext = path.extname(info.img_url.split('?')[0]) || '.webp';
    // .gallery 布局：页文件用纯数字命名（1.png、2.jpg），与徽标约定对齐
    const fileName = `${n}${ext}`;
    const dest = path.join(galleryDir, fileName);

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
              currentPage: idx + 1,
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

    if (delayMs > 0 && idx < targetPages.length - 1) {
      await sleep(delayMs);
    }
  }

  const manifestPath = path.join(galleryDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        gid,
        title: probe.title,
        base: BASE,
        downloadedAt: new Date().toISOString(),
        records,
      },
      null,
      2
    ),
    'utf-8'
  );

  // .gallery 徽标/清单：画廊名.gallery，与数字页文件同目录即构成一本可导入画廊
  // （manifest.json 保留，保证旧脚本/旧目录兼容）
  const safeTitle = sanitizeTitle(probe.title, gid);
  const galleryMarkerPath = path.join(galleryDir, `${safeTitle}.gallery`);
  try {
    fs.writeFileSync(
      galleryMarkerPath,
      JSON.stringify(
        {
          format: 'the-play-gallery/1',
          title: probe.title,
          gid: String(gid),
          prefix,
          sourceUrl: probe.firstPageUrl || '',
          totalPages: probe.totalPages,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch (markerErr) {
    console.error('[downloadGallery] 写入画廊徽标失败:', markerErr && markerErr.message);
  }

  const successfulCount = records.filter((r) => r.bytes && r.bytes > 0).length;

  if (onProgress) {
    onProgress({
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
    success: successfulCount > 0,
    totalDownloaded: successfulCount,
    outDir: galleryDir,
    manifestPath,
    galleryMarkerPath,
    records,
  };
}

async function fetchGalleryPages(options, onProgress, isCancelled) {
  const { gidOrUrl, pages: pageSpec, delayMs = 100, skipPages = [], probe: preProbe = null } = options;
  // 复用调用方已探测的结果：纯数字 gid 重探测时候选顺序（/h/ 优先）可能命中
  // 同名异站帖子（如 /h/869222 与 /hentai/869222 是两个不同作品），直接串台。
  // 传了配套 probe 就不再重探，保证详情页看到的和抓到的是同一本。
  let probe = null;
  const wantGid = normalizeGid(gidOrUrl).gid;
  if (preProbe && String(preProbe.gid) === String(wantGid)) {
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

  const emitState = (doneCount, item, status) => {
    if (onProgress) {
      onProgress({
        gid,
        current: skippedCount + doneCount,
        total: targetPages.length,
        item,
        records: pages,
        status,
      });
    }
  };

  // 单页抓取带重试：网络抖动不再直接丢页（之前失败就 continue，剧情直接断）
  const fetchPageHtml = async (n) => {
    if (n === 1 && probe.firstHtml) return probe.firstHtml;
    const url = pageUrl(gid, n, prefix);
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

  for (let idx = 0; idx < pendingPages.length; idx++) {
    const n = pendingPages[idx];
    if (isCancelled && isCancelled(gid)) {
      emitState(idx, null, 'cancelled');
      break;
    }

    let html = null;
    try {
      html = await fetchPageHtml(n);
    } catch (err) {
      console.error(`[fetchGalleryPages] 获取第 ${n} 页失败(已重试):`, err && err.message);
      errors.push({ page: n, error: String((err && err.message) || err) });
      continue;
    }

    let info = null;
    try {
      info = parsePage(gid, n, html, prefix);
    } catch (err) {
      console.error(`[fetchGalleryPages] 解析第 ${n} 页失败:`, err && err.message);
      errors.push({ page: n, error: `解析失败: ${String((err && err.message) || err)}` });
      continue;
    }
    prefix = info.prefix;

    if (info.img_url) {
      const pageTitle = `${title || `图集 ${gid}`} - P${String(n).padStart(2, '0')}/${totalPages}`;
      const item = {
        page: n,
        url: info.img_url,
        title: pageTitle,
        alt: info.img_alt,
      };
      pages.push(item);
      emitState(idx + 1, item, idx + 1 === pendingPages.length ? 'completed' : 'fetching');
    } else {
      errors.push({ page: n, error: '未在该页找到大图' });
    }

    if (delayMs > 0 && idx < pendingPages.length - 1) {
      await sleep(delayMs);
    }
  }

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

function channelListUrl(channelId, page = 1) {
  const ch = getChannel(channelId);
  if (!ch) throw new Error(`未知频道: ${channelId}`);
  const p = Math.max(1, Number(page) || 1);
  if (p <= 1) return `${BASE}${ch.base}`;
  const base = ch.base === '/' ? '/' : ch.base;
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
  if (prefix === 'gif' || prefix === 'hanime') return 'video';
  if (prefix === 'asmr') return 'audio';
  return 'image';
}

function parseChannelList(html, channelId) {
  const items = [];
  const seen = new Set();
  // 锚点扫描：以外层 li/div 无关的方式找详情锚（thumb 类，或带 title，或后跟标题块），
  // 上下文窗口向后取到下一个详情锚为止，避免把相邻条目元信息串味
  const aRe = /<a[^>]*href="(\/(?:h|hentai|gif|hanime|asmr|cos|webtoon|western)\/(\d+)\.html)"[^>]*>/gi;
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
    if (seen.has(a.gid)) continue;
    const winEnd = k + 1 < primaries.length ? primaries[k + 1].index : a.index + 2500;
    const block = html.slice(a.index, Math.min(winEnd, a.index + 2500));
    // 主锚必带封面图（thumb 或 grid），没有则跳过
    if (!/<img/i.test(block.slice(0, 1200))) continue;
    const prefix = a.href.split('/')[1].toLowerCase();

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
    const titleAttr = a.tag.match(/\stitle="([^"]*)"/i);
    const spanTitle = block.match(/<span class="title"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const h3Title = block.match(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const altM = imgTag ? imgTag[0].match(/\salt="([^"]*)"/i) : null;
    title = stripTags((titleAttr && titleAttr[1]) || '')
      || stripTags((spanTitle && spanTitle[1]) || '')
      || stripTags((h3Title && h3Title[1]) || '')
      || stripTags((altM && altM[1]) || '')
      || `作品 ${gid}`;

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

    seen.add(a.gid);
    items.push({
      gid: a.gid,
      url: `${BASE}${a.href}`,
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
    });
  }
  return items;
}

async function fetchChannelList({ channelId = 'latest', page = 1 } = {}) {
  const ch = getChannel(channelId);
  if (!ch) throw new Error(`未知频道: ${channelId}`);
  const p = Math.max(1, Number(page) || 1);
  const url = channelListUrl(channelId, p);
  const html = await httpGet(url, `${BASE}/`);
  const items = parseChannelList(html, channelId);
  // 还有更多：下一页链接存在即视为有
  const hasMore = html.includes(`index-${p + 1}.html`);
  return { channelId, page: p, hasMore, items };
}

module.exports = {
  probeGallery,
  downloadGallery,
  fetchGalleryPages,
  normalizeGid,
  parsePageRange,
  GALLERY_CHANNELS,
  channelListUrl,
  parseChannelList,
  fetchChannelList,
};
