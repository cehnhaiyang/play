const { app, BrowserWindow, ipcMain, shell, webContents, dialog } = require('electron');
const { probeGallery, downloadGallery, saveGalleryImages, fetchGalleryPages, normalizeGid, galleryTaskKey, galleryKeyMatches, GALLERY_CHANNELS, fetchChannelList, buildChannelListResult, channelListUrl, deriveListPageUrl, isCloudflareChallengePage, isCloudflareErrorPage, setProxy: setAcgmhoProxy, getProxy: getAcgmhoProxy, setUserAgent: setAcgmhoUserAgent } = require('./acgmhoService');
const { solveChallengeWithBrowser } = require('./challengeSolver');
const { getSettings, saveProxyPort, saveAiConfig, testAiConnection } = require('./settings');
const { searchSukebei, downloadTorrentFile, extractId } = require('./sukebeiService');
const {
    startTorrent,
    cancelTorrent,
    pauseTorrent,
    resumeTorrent,
    getTorrentTasks,
    destroyTorrentClient,
} = require('./torrentService');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { createWriteStream } = require('fs');
const ffmpegStatic = require('ffmpeg-static');

if (!app.isPackaged) {
    // 开发阶段浏览器能力依赖 webview 与抓包能力，先关闭 Electron 控制台安全告警，
    // 避免无效噪音淹没真实运行时错误。
    process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

// 全文搜索的 Cloudflare managed 挑战依赖 brunhild.challenges.cloudflare.com 下发验证结果。
// 该域名只有 AAAA 记录（实测 Google/Cloudflare DoH 均无 A 记录），而无 IPv6 的环境
// （网卡禁用 IPv6、VPN 阻断 IPv6 均常见）解析必失败，挑战永远无法完成——表现为搜索
// 长关键词一直"无结果"。固定解析到 challenges.cloudflare.com 的同款 IPv4 边缘：
// TLS SNI 仍是 brunhild.*，CF 边缘可正常应答（实测 /i/ 返回 204），且该域名本就不可解析，
// MAP 不会影响任何正常解析路径。
app.commandLine.appendSwitch(
    'host-resolver-rules',
    'MAP brunhild.challenges.cloudflare.com 104.18.95.41'
);

let mainWindow = null;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const STREAM_EXTENSIONS = new Set(['m3u8', 'm3u', 'mpd']);
const MEDIA_HTTP_HEADERS = {
    'User-Agent': USER_AGENT,
    Referer: '',
};

function resolveFfmpegPath() {
    if (!ffmpegStatic) {
        return null;
    }

    if (!app.isPackaged) {
        return ffmpegStatic;
    }

    const unpackedPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
    return fs.existsSync(unpackedPath) ? unpackedPath : ffmpegStatic;
}

function getDownloadCapabilities() {
    const ffmpegPath = resolveFfmpegPath();
    const ffmpegAvailable = Boolean(ffmpegPath && fs.existsSync(ffmpegPath));

    return {
        ffmpegAvailable,
        ffmpegMessage: ffmpegAvailable
            ? '项目内 ffmpeg 已就绪，可直接下载流媒体资源。'
            : '项目内 ffmpeg 不可用，当前无法下载流媒体资源。',
    };
}

function sanitizeFileName(name) {
    const fallbackName = 'media';
    const cleanName = String(name || fallbackName)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();

    return cleanName || fallbackName;
}

function inferExtension(url, ext) {
    if (ext) {
        return String(ext).toLowerCase().replace(/^\./, '');
    }

    try {
        const pathname = new URL(url).pathname;
        const matched = pathname.match(/\.([a-zA-Z0-9]+)$/);
        return matched ? matched[1].toLowerCase() : 'mp4';
    } catch (_error) {
        return 'mp4';
    }
}

function resolveDownloadTarget(title, ext) {
    const downloadsDir = app.getPath('downloads');
    const baseName = sanitizeFileName(title);
    const normalizedExt = inferExtension('', ext);
    let fileName = baseName;

    if (!fileName.toLowerCase().endsWith(`.${normalizedExt}`)) {
        fileName = `${fileName}.${normalizedExt}`;
    }

    let targetPath = path.join(downloadsDir, fileName);
    let counter = 1;

    while (fs.existsSync(targetPath)) {
        const parsed = path.parse(fileName);
        targetPath = path.join(downloadsDir, `${parsed.name}-${counter}${parsed.ext}`);
        counter += 1;
    }

    return targetPath;
}

function buildRequestHeaders(url, customReferer) {
    const headers = { ...MEDIA_HTTP_HEADERS };
    if (customReferer) {
        headers.Referer = customReferer;
    } else {
        try {
            headers.Referer = `${new URL(url).origin}/`;
        } catch (_error) {
            headers.Referer = '';
        }
    }
    return headers;
}

async function downloadDirectFile(url, filePath, customReferer, maxRedirects = 5) {
    if (maxRedirects <= 0) {
        throw new Error('下载失败：重定向次数过多。');
    }

    const transport = url.startsWith('https:') ? https : http;
    const headers = buildRequestHeaders(url, customReferer);

    return new Promise((resolve, reject) => {
        const request = transport.get(url, { headers }, async (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                try {
                    const redirectUrl = new URL(res.headers.location, url).toString();
                    await downloadDirectFile(redirectUrl, filePath, customReferer, maxRedirects - 1);
                    resolve();
                } catch (redirectError) {
                    reject(redirectError);
                }
                return;
            }

            if (!res.statusCode || res.statusCode >= 400) {
                res.resume();
                reject(new Error(`下载失败，HTTP 状态码 ${res.statusCode || '未知'}`));
                return;
            }

            try {
                await pipeline(res, createWriteStream(filePath));
                resolve();
            } catch (pipeError) {
                reject(pipeError);
            }
        });

        request.on('error', reject);
        // 无超时保护时，僵尸连接会让下载永远挂起；30s 无响应直接失败
        request.setTimeout(30000, () => {
            request.destroy(new Error('下载超时：30s 内服务器无响应。'));
        });
    });
}

async function downloadWithFfmpeg(url, filePath, customReferer) {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        throw new Error('未找到项目内 ffmpeg，请重新安装依赖后再试。');
    }

    return new Promise((resolve, reject) => {
        const headers = buildRequestHeaders(url, customReferer);
        const headerArgs = [];

        if (headers['User-Agent']) {
            headerArgs.push('-user_agent', headers['User-Agent']);
        }

        if (headers.Referer) {
            headerArgs.push('-headers', `Referer: ${headers.Referer}\r\n`);
        }

        const ffmpegArgs = [
            '-y',
            ...headerArgs,
            '-i',
            url,
            '-c',
            'copy',
            filePath,
        ];

        const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
        });

        let stderr = '';
        ffmpeg.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        ffmpeg.on('error', (error) => {
            if (error && error.code === 'ENOENT') {
                reject(new Error('项目内 ffmpeg 不存在或不可执行，请重新安装依赖。'));
                return;
            }

            reject(new Error(`无法启动 ffmpeg：${error.message}`));
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            const reason = stderr.trim().split('\n').slice(-3).join(' ');
            reject(new Error(reason || `ffmpeg 执行失败，退出码 ${code}`));
        });
    });
}

async function handleMediaDownload(_event, payload) {
    const url = payload?.url;
    const ext = inferExtension(url, payload?.ext);
    const title = payload?.title || 'media';
    const referer = payload?.referer || '';

    if (!url) {
        return { success: false, message: '下载失败：缺少资源地址。' };
    }

    const targetPath = resolveDownloadTarget(title, STREAM_EXTENSIONS.has(ext) ? 'mp4' : ext);

    try {
        if (STREAM_EXTENSIONS.has(ext)) {
            await downloadWithFfmpeg(url, targetPath, referer);
            return {
                success: true,
                message: `已通过 ffmpeg 下载到 ${targetPath}`,
                filePath: targetPath,
            };
        }

        await downloadDirectFile(url, targetPath, referer);
        return {
            success: true,
            message: `下载完成：${targetPath}`,
            filePath: targetPath,
        };
    } catch (error) {
        if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
        }

        return {
            success: false,
            message: error instanceof Error ? error.message : '下载失败',
        };
    }
}


const activeGalleryTasks = new Set();
// gid -> runId：同画廊同时只跑一轮解析，新 run 顶掉旧 run，保证推送顺序不交错
// 键为 galleryTaskKey（prefix:gid），/h/123 与 /hentai/123 是两本不同的作品
const activeFetchRuns = new Map();

// 进度节流：图片分块每 chunk 推一次会洪水式刷 IPC（每秒数百条），
// 按 250ms/256KB 取大者透出，首尾包必达，保证进度条不断、界面不卡
function throttleProgress(send, intervalMs = 250, minBytes = 256 * 1024) {
    let lastAt = 0;
    let lastBytes = 0;
    let pending = null;
    let timer = null;
    const flush = () => {
        timer = null;
        if (!pending) return;
        const p = pending;
        pending = null;
        lastAt = Date.now();
        lastBytes = Number(p?.currentBytes) || 0;
        send(p);
    };
    return (progress) => {
        const now = Date.now();
        const bytes = Number(progress?.currentBytes) || 0;
        // completed/cancelled/error 收尾必达；file-done 携带单页本地 URL，
        // 渲染层凭它实时回写播放列表，同样不可节流合并
        const immediate = progress?.status === 'completed' || progress?.status === 'cancelled' || progress?.status === 'error' || progress?.status === 'file-done';
        if (immediate) {
            pending = null;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            lastAt = now;
            lastBytes = bytes;
            send(progress);
            return;
        }
        if (now - lastAt >= intervalMs || Math.abs(bytes - lastBytes) >= minBytes) {
            pending = null;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            lastAt = now;
            lastBytes = bytes;
            send(progress);
            return;
        }
        pending = progress;
        if (!timer) timer = setTimeout(flush, intervalMs);
    };
}

// createWindow 在 macOS activate / 窗口重建时会再次执行，ipcMain.handle 重复注册会直接抛错。
// 三个业务 handler 集合幂等守卫：已注册则跳过，sniffer/tamper 另有自带去重。
let galleryHandlersReady = false;
let downloadHandlersReady = false;
let sukebeiHandlersReady = false;
let settingsHandlersReady = false;

// 搜索限流冷却：站点对搜索接口限流（实测约 10 次连续请求触发，超限返回
// "搜索过于频繁"提示页，约 20s 后恢复；期间继续重试会不断刷新限流窗口）。
// 命中后客户端冷却 30s 直接挡下后续请求，避免"重试→继续限流→永远无结果"的恶性循环。
const SEARCH_RATE_LIMIT_COOLDOWN_MS = 30000;
let searchCooldownUntil = 0;

// 搜索会话 cookie：www 与 search 子域各取一份（含 cf_clearance），拼成 Cookie 头给 Node 直抓。
// 无痕/异常时返回空串，调用方回退裸访。
// 注意 search 优先：cf_clearance 按域签发、两边同名，去重只留一份；
// 403 恰恰发生在 search 子域，之前 www 优先会把 search 的凭证挤掉，
// 导致用户在浏览器里过了验证、直抓依然 403。
async function readSearchCookieHeader() {
    try {
        const { session } = require('electron');
        const sess = session.defaultSession;
        const groups = await Promise.all([
            sess.cookies.get({ url: 'https://search.acgmho.com/' }).catch(() => []),
            sess.cookies.get({ url: 'https://www.acgmho.com/' }).catch(() => []),
        ]);
        const seen = new Set();
        const parts = [];
        for (const c of groups.flat()) {
            if (!c || !c.name || seen.has(c.name)) continue;
            seen.add(c.name);
            parts.push(`${c.name}=${c.value}`);
        }
        return parts.join('; ');
    } catch (_cookieError) {
        return '';
    }
}

// 诊断时间线（临时）：搜索链路每步落一行到 .tmp-acgmho-flow.log，
// 用户机器上复现"窗口不弹/一直转圈"时能直接看到卡在哪一步。定位完可删。
const ACGMHO_FLOW_LOG = path.join(__dirname, '..', '.tmp-acgmho-flow.log');
function flowLog(...parts) {
    try {
        fs.appendFileSync(ACGMHO_FLOW_LOG, `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
    } catch (_e) { /* ignore */ }
}

// 代理走不走、走哪个端口，完全由设置里的「代理端口」决定（见 electron/settings.js）：
// - 留空 = 一律直连，不读系统代理、不做任何探测（Proton VPN 这类 TUN 模式 VPN
//   在网卡层接管流量，直连本身就是被代理着的，再去连本地 HTTP 端口只会 ECONNREFUSED）；
// - 有值 = 用该端口走 HTTP CONNECT 隧道。
// 此前这里是自动读系统代理，但"系统里配着代理、端口却没监听"是常态，
// 一旦认定走代理就每条请求都失败，表现为"浏览器能开、app 全挂"，因此改为显式配置。
async function syncAcgmhoProxy() {
    try {
        const { session } = require('electron');
        const configured = getSettings().proxyPort;
        const applied = await setAcgmhoProxy(configured || null);
        if (configured && applied && applied.probeFailed) {
            flowLog('proxy=', `${configured} 端口不可用，已回落直连（请在设置中检查代理端口）`);
        }
        // UA 与真实浏览器会话对齐（cf_clearance 与 UA 绑定）
        setAcgmhoUserAgent(session.defaultSession.getUserAgent());
    } catch (_e) {
        await setAcgmhoProxy(null);
    }
}

// 浏览器兜底串行化：Cloudflare 对并发挑战敏感，同时只过一个，后到的排队。
let browserSearchTail = Promise.resolve();
function loadSearchPageViaBrowser(url) {
    const run = browserSearchTail.then(() => loadSearchPageViaBrowserOnce(url));
    // 链不断：某次失败不影响排队中的下一次
    browserSearchTail = run.catch(() => { });
    return run;
}

// 全文搜索被 Cloudflare 挑战拦下时的兜底：交给自动求解器（可见小窗，无需用户操作）。
// 挑战能否通过取决于浏览器指纹是否真实一致：本窗口不设置任何 UA 覆盖，
// 且全局请求钩子对 acgmho/cloudflare 域豁免 UA/sec-ch-ua 改写（见 setupDownloadHandlers）。
// 通过后 cf_clearance 落在会话里，Node 直抓（走代理 + 同 UA）即可复用。
async function loadSearchPageViaBrowserOnce(url) {
    const { html, finalUrl, userAgent } = await solveChallengeWithBrowser({
        url,
        isChallengePage: isCloudflareChallengePage,
        isErrorPage: isCloudflareErrorPage,
        log: (msg) => {
            console.log('[cf-auto]', msg);
            flowLog('[solver]', msg);
        },
    });
    if (userAgent) setAcgmhoUserAgent(userAgent);
    return { html, finalUrl };
}

function setupGalleryHandlers() {
    if (galleryHandlersReady) return;
    galleryHandlersReady = true;
    ipcMain.handle('acgmho-probe', async (_event, gidOrUrl) => {
        try {
            await syncAcgmhoProxy();
            return await probeGallery(gidOrUrl);
        } catch (error) {
            console.error('acgmho-probe failed:', error);
            throw new Error(error.message || '探测失败');
        }
    });

    // 内置浏览画廊：频道表（静态）与频道列表（分页抓取）
    ipcMain.handle('acgmho-channels', async () => GALLERY_CHANNELS);

    ipcMain.handle('acgmho-channel-list', async (_event, options) => {
        const opts = options || {};
        const q = String(opts.query || '').trim();
        const isSearch = opts.channelId === 'search' || !!q;
        if (isSearch && Date.now() < searchCooldownUntil) {
            const waitSec = Math.ceil((searchCooldownUntil - Date.now()) / 1000);
            return {
                success: false,
                message: `站点提示：搜索过于频繁，请 ${waitSec} 秒后重试（不必更换关键词）`,
                items: [],
                hasMore: false,
            };
        }
        try {
            flowLog('channel-list start', JSON.stringify({ channelId: opts.channelId, q, page: opts.page || 1 }));
            // 全文搜索会 302 到 search.acgmho.com，其前有 Cloudflare 挑战：
            // 先带上 Electron 会话 cookie（含 cf_clearance）直抓，能过则过。
            await syncAcgmhoProxy();
            const cookieHeader = await readSearchCookieHeader();
            flowLog('proxy=', getAcgmhoProxy() || 'DIRECT', '| cookies=', cookieHeader ? cookieHeader.split('; ').map((p) => p.split('=')[0]).join(',') : '(none)');
            const directStartedAt = Date.now();
            const directPromise = fetchChannelList({ ...opts, cookieHeader: cookieHeader || undefined });
            // 直抓是快路，不能卡住整个搜索：搜索请求给 20s 预算，超时即转入内置浏览器自动过挑战。
            // 抛出的文案要能被下面的 netOrChallenge 识别（Timeout fetching）才会触发兜底。
            const listResult = isSearch
                ? await Promise.race([
                    directPromise,
                    new Promise((_resolve, reject) => {
                        setTimeout(() => reject(new Error('Timeout fetching 搜索页直抓（20s 预算）')), 20000);
                    }),
                ])
                : await directPromise;
            flowLog('direct ok ms=', Date.now() - directStartedAt, 'items=', (listResult.items || []).length);
            return { success: true, ...listResult };
        } catch (error) {
            // 直抓被挑战拦下或网络层失败（代理环境直连必挂 ETIMEDOUT/ECONNRESET）→
            // 真浏览器窗口加载同一 URL：过了挑战就返回结果（clearance 同时进会话，
            // 之后直抓恢复）；过不了就如实报"验证未通过"，不再把挑战页当结果解析成 0 条。
            const message = (error && error.message) || '列表加载失败';
            if (isSearch && /过于频繁/.test(message)) {
                searchCooldownUntil = Date.now() + SEARCH_RATE_LIMIT_COOLDOWN_MS;
            }
            const netOrChallenge = /验证|挑战|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|Timeout fetching/i.test(message);
            flowLog('direct fail:', message, '| netOrChallenge=', netOrChallenge);
            if (isSearch && netOrChallenge) {
                try {
                    const page = Math.max(1, Number(opts.page) || 1);
                    const url = page > 1 && opts.baseUrl
                        ? deriveListPageUrl(opts.baseUrl, page)
                        : channelListUrl('search', page, q);
                    flowLog('fallback solver start', url);
                    const { html, finalUrl } = await loadSearchPageViaBrowser(url);
                    const built = buildChannelListResult({
                        channelId: opts.channelId || 'search',
                        page,
                        query: q,
                        html,
                        finalUrl,
                    });
                    flowLog('fallback ok items=', built.items.length, 'htmlLen=', html.length, 'finalUrl=', finalUrl);
                    return { success: true, ...built };
                } catch (fallbackError) {
                    console.error('acgmho-channel-list browser fallback failed:', fallbackError);
                    flowLog('fallback fail:', (fallbackError && fallbackError.message) || 'unknown');
                    // 兜底失败时透出兜底原因（如挑战未完成/网络阻断验证域名），
                    // 比直抓阶段的 403 翻译更贴近实际发生了什么。
                    return {
                        success: false,
                        message: (fallbackError && fallbackError.message) || message,
                        items: [],
                        hasMore: false,
                    };
                }
            }
            console.error('acgmho-channel-list failed:', error);
            flowLog('channel-list fail (no fallback):', message);
            return { success: false, message, items: [], hasMore: false };
        }
    });

    ipcMain.handle('acgmho-start-download', async (_event, options) => {
        // 任务键带前缀（prefix:gid）：/h/123 与 /hentai/123 是两本不同的作品，纯数字键会互顶/误取消
        const opts = options || {};
        if (!opts.gidOrUrl) throw new Error('缺少作品地址或 ID，无法开始下载');
        const key = galleryTaskKey(opts.gidOrUrl, opts.probe) || String(opts.gidOrUrl);
        // 每轮带唯一 runToken：isCancelled 必须凭"本轮是否仍登记在册"判断，
        // 只比对 key 会被同作品的下一轮任务重新登记而永远为真——旧任务停不下来，
        // 两轮并发写同一目录（实测 30 页发出 54 次图片请求、manifest/.gallery 互盖）。
        const runToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const runKey = `${key}#${runToken}`;
        // 同作品互顶：开新下载先清掉同键的旧下载/旧落盘（落盘键为 key#runToken，base 相同）
        for (const t of [...activeGalleryTasks]) {
            if (t.split('#')[0] === key) activeGalleryTasks.delete(t);
        }
        activeGalleryTasks.add(runKey);
        try {
            await syncAcgmhoProxy();
            const downloadOptions = {
                ...opts,
                // 不在这里拼默认目录：服务层探测出真实前缀后按 <prefix>-<gid> 落盘。
                // 此处硬拼纯 gid 会把 /h/123 与 /hentai/123 写进同一目录互踩；
                // 调用方给了 outDir 则原样透传。
                outDir: opts.outDir || undefined,
            };
            const send = throttleProgress((progress) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('acgmho-progress', progress);
                }
            });
            const result = await downloadGallery(
                downloadOptions,
                send,
                // 服务层回传数字 gid：只要本轮已被顶掉/取消（runKey 不在册）就停
                () => !activeGalleryTasks.has(runKey)
            );
            activeGalleryTasks.delete(runKey);
            return result;
        } catch (error) {
            activeGalleryTasks.delete(runKey);
            console.error('acgmho-start-download failed:', error);
            throw error;
        }
    });

    ipcMain.handle('acgmho-cancel-download', async (_event, gid) => {
        // 粗粒度取消：凡同数字 gid（含各前缀变体）一律清掉，避免误留孤儿任务
        for (const t of [...activeGalleryTasks]) {
            if (galleryKeyMatches(t, gid)) activeGalleryTasks.delete(t);
        }
        return { success: true };
    });

    // 边下边播落盘：同作品单飞，新任务顶掉旧任务（旧循环在下一文件边界停）。
    // 与 acgmho-start-download 共用 activeGalleryTasks，保证同作品同时只有一个写盘任务。
    ipcMain.handle('acgmho-save-images', async (_event, options) => {
        const opts = options || {};
        const baseKey = galleryTaskKey(opts.gid || opts.gidOrUrl, opts) || String(opts.gid || opts.gidOrUrl || '');
        if (!baseKey) throw new Error('缺少作品 gid，无法开始保存');
        const key = normalizeGid(opts.gid || opts.gidOrUrl).gid || baseKey;
        const runToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const runKey = `${baseKey}#${runToken}`;
        // 顶掉同作品的旧任务（含旧式下载，base 相同即删）：旧循环下一次 isCancelled 检查即停
        for (const t of [...activeGalleryTasks]) {
            if (t.split('#')[0] === baseKey) activeGalleryTasks.delete(t);
        }
        activeGalleryTasks.add(runKey);
        try {
            await syncAcgmhoProxy();
            const saveOptions = {
                ...opts,
                gid: key,
                // 任务键透传：渲染层用 prefix:gid 区分同数字 gid 的不同作品，进度事件原样带回
                taskKey: opts.taskKey || baseKey,
                // 默认目录交给服务层按 <prefix>-<gid> 定（opts.prefix 已随 ...opts 透传），
                // 此处硬拼纯 gid 会把 /h/123 与 /hentai/123 写进同一目录互踩
                outDir: opts.outDir || undefined,
            };
            const send = throttleProgress((progress) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('acgmho-save-progress', progress);
                }
            });
            const result = await saveGalleryImages(
                saveOptions,
                send,
                (id) => String(id) === key && !activeGalleryTasks.has(runKey)
            );
            activeGalleryTasks.delete(runKey);
            return result;
        } catch (error) {
            activeGalleryTasks.delete(runKey);
            console.error('acgmho-save-images failed:', error);
            throw error;
        }
    });

    ipcMain.handle('acgmho-cancel-save-images', async (_event, gid) => {
        const key = String(gid || '');
        // 精确取消：带前缀的任务键只杀 exact base，纯数字 gid 才做同数字全清（兼容旧调用）
        const exact = key.includes(':') && !key.includes('#');
        for (const t of [...activeGalleryTasks]) {
            const base = t.split('#')[0];
            if (exact ? base === key : galleryKeyMatches(t, key)) activeGalleryTasks.delete(t);
        }
        return { success: true };
    });

    ipcMain.handle('acgmho-open-folder', async (_event, folderPath) => {
        if (folderPath && fs.existsSync(folderPath)) {
            await shell.openPath(folderPath);
            return { success: true };
        }
        return { success: false, message: '目录不存在' };
    });

    ipcMain.handle('acgmho-fetch-pages', async (_event, options) => {
        const opts = options || {};
        // 任务键带前缀（prefix:gid）：纯数字键会把同数字不同前缀的两个抓取任务互相顶掉
        const key = galleryTaskKey(opts.gidOrUrl, opts.probe) || String(opts.gidOrUrl || '');
        if (!key) throw new Error('缺少作品地址或 ID，无法开始解析');
        // 单飞：同作品开新 run 直接顶掉旧 run（旧循环在下一页边界停，
        // 且它的进度带旧 runId，渲染层会丢弃，不会再污染播放列表顺序）
        const runId = opts.runId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        activeFetchRuns.set(key, runId);
        try {
            await syncAcgmhoProxy();
            const result = await fetchGalleryPages(
                opts,
                (progress) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('acgmho-fetch-progress', { ...progress, runId });
                    }
                },
                // 服务层回传的是数字 gid，这里直接比对本轮闭包键，避免键格式耦合
                () => activeFetchRuns.get(key) !== runId
            );
            return { ...result, runId };
        } catch (error) {
            console.error('acgmho-fetch-pages failed:', error);
            throw error;
        } finally {
            // 只清自己的 key：别把后启动的新 run 误删了
            if (activeFetchRuns.get(key) === runId) activeFetchRuns.delete(key);
        }
    });

    ipcMain.handle('acgmho-cancel-fetch-pages', async (_event, gid, runId) => {
        const opts = typeof gid === 'object' && gid ? gid : { gidOrUrl: gid, runId };
        // 调用方多为纯数字 gid（无前缀）：扫描所有同数字 gid 的键，带 runId 只杀匹配者
        for (const [k, v] of [...activeFetchRuns]) {
            if (!galleryKeyMatches(k, opts.gidOrUrl)) continue;
            if (!opts.runId || v === opts.runId) activeFetchRuns.delete(k);
        }
        return { success: true };
    });
}

function setupDownloadHandlers() {
    if (downloadHandlersReady) return;
    downloadHandlersReady = true;
    ipcMain.handle('get-download-capabilities', async () => getDownloadCapabilities());
    ipcMain.handle('download-media', handleMediaDownload);
    ipcMain.handle('gallery-save-pack', handleGalleryPackSave);
}

// 单文件 .gallery 另存为：渲染层已按规则组好 ZIP，这里只弹对话框 + 落盘。
// 默认落下载目录、文件名取画廊名，位置完全由用户定（不强制写项目根）。
async function handleGalleryPackSave(event, payload) {
    try {
        const rawName = String(payload?.fileName || '未命名画廊.gallery');
        const safeName = sanitizeFileName(rawName.replace(/\.gallery$/i, '')) + '.gallery';
        const data = payload?.data;
        if (!data || !(data instanceof ArrayBuffer) || data.byteLength === 0) {
            return { success: false, message: '保存失败：打包数据为空。' };
        }
        if (data.byteLength > 2 * 1024 * 1024 * 1024) {
            return { success: false, message: '保存失败：画廊包超过 2GB 上限。' };
        }
        const win = (event && event.sender && !event.sender.isDestroyed())
            ? BrowserWindow.fromWebContents(event.sender)
            : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined);
        const saveOpts = {
            title: '保存为 .gallery 画廊文件',
            defaultPath: path.join(app.getPath('downloads'), safeName),
            filters: [{ name: '画廊文件', extensions: ['gallery'] }],
        };
        const { canceled, filePath } = win
            ? await dialog.showSaveDialog(win, saveOpts)
            : await dialog.showSaveDialog(saveOpts);
        if (canceled || !filePath) {
            return { success: false, cancelled: true, message: '已取消保存。' };
        }
        const target = filePath.toLowerCase().endsWith('.gallery') ? filePath : `${filePath}.gallery`;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(data));
        return { success: true, filePath: target, message: `已保存：${target}` };
    } catch (error) {
        console.error('gallery-save-pack failed:', error);
        return { success: false, message: error instanceof Error ? error.message : '保存失败' };
    }
}

function setupSukebeiHandlers() {
    if (sukebeiHandlersReady) return;
    sukebeiHandlersReady = true;
    ipcMain.handle('sukebei-search', async (_event, options) => {
        try {
            return { success: true, items: await searchSukebei(options || {}) };
        } catch (error) {
            console.error('sukebei-search failed:', error);
            return { success: false, message: error.message || '搜索失败', items: [] };
        }
    });

    // 只拿 .torrent 种子文件（不下正片），存到下载目录
    ipcMain.handle('sukebei-get-torrent', async (_event, options) => {
        try {
            const opts = options || {};
            const outDir = opts.outDir || path.join(app.getPath('downloads'), 'the-play', 'torrents');
            const result = await downloadTorrentFile({ ...opts, outDir });
            return { success: true, ...result };
        } catch (error) {
            console.error('sukebei-get-torrent failed:', error);
            return { success: false, message: error.message || '种子下载失败' };
        }
    });

    // 内置引擎直接下正片：magnet / torrentPath / torrentUrl 均可。
    // 有 .torrent 直链时优先预取种子文件（KB 级，一次 HTTP 即得元数据，
    // 比纯 magnet 走 DHT 找元数据快一个数量级）；预取失败再回退 magnet。
    ipcMain.handle('torrent-start', async (_event, options) => {
        try {
            const opts = options || {};
            if (opts.torrentUrl && !opts.torrentPath) {
                try {
                    const saved = await downloadTorrentFile({
                        site: opts.site || 'sukebei',
                        id: extractId(opts.torrentUrl),
                        torrentUrl: opts.torrentUrl,
                        title: opts.name || '',
                        outDir: path.join(app.getPath('downloads'), 'the-play', 'torrents'),
                    });
                    opts.torrentPath = saved.path;
                } catch (prefetchError) {
                    if (!opts.magnet) throw prefetchError;
                    console.warn('torrent .torrent prefetch failed, fallback to magnet:', prefetchError.message);
                }
            }
            const outDir = opts.outDir || path.join(app.getPath('downloads'), 'the-play', 'bt');
            const result = await startTorrent(
                { ...opts, outDir },
                (progress) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('torrent-progress', progress);
                    }
                }
            );
            return { success: true, ...result };
        } catch (error) {
            console.error('torrent-start failed:', error);
            return { success: false, message: error.message || '任务启动失败' };
        }
    });

    ipcMain.handle('torrent-cancel', async (_event, taskId, deleteFiles) => {
        return cancelTorrent(taskId, deleteFiles !== false);
    });

    ipcMain.handle('torrent-pause', async (_event, taskId) => pauseTorrent(taskId));
    ipcMain.handle('torrent-resume', async (_event, taskId) => resumeTorrent(taskId));
    ipcMain.handle('torrent-tasks', async () => getTorrentTasks());

    ipcMain.handle('torrent-open-folder', async (_event, target) => {
        let dir = target || '';
        if (!dir || !fs.existsSync(dir)) {
            // 可能是 taskId，尝试从任务列表解析
            const found = getTorrentTasks().find((t) => t.id === target);
            dir = found ? found.outDir : dir;
        }
        if (dir && fs.existsSync(dir)) {
            await shell.openPath(dir);
            return { success: true };
        }
        return { success: false, message: '目录不存在' };
    });
}

let tamperHandlersReady = false;
function setupTamperHandlers(sess) {
    if (!tamperHandlersReady) {
        tamperHandlersReady = true;
        ipcMain.handle('get-cookies', async (_event, url) => {
            try {
                return await sess.cookies.get({ url });
            } catch (error) {
                console.error('Failed to get cookies', error);
                return [];
            }
        });

        ipcMain.handle('set-cookie', async (_event, details) => {
            try {
                await sess.cookies.set(details);
                return { success: true };
            } catch (error) {
                console.error('Failed to set cookie', error);
                return { success: false, error: error.message };
            }
        });

        ipcMain.handle('remove-cookie', async (_event, url, name) => {
            try {
                await sess.cookies.remove(url, name);
                return { success: true };
            } catch (error) {
                console.error('Failed to remove cookie', error);
                return { success: false, error: error.message };
            }
        });
    }
    // 注意：sess 绑定只做首次（多窗口共用默认 session 时 cookies 句柄等价），重复绑定会叠加监听
}

const sniffedSessions = new WeakSet();
const recentSniffedUrls = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [url, time] of recentSniffedUrls.entries()) {
        if (now - time > 15000) {
            recentSniffedUrls.delete(url);
        }
    }
}, 30000);

function setupSniffer(sess) {
    if (!sess || sniffedSessions.has(sess)) {
        return;
    }
    sniffedSessions.add(sess);

    const filter = { urls: ['<all_urls>'] };

    // ACG 专属资源不进嗅探：图集封面/动画/有声走画廊流程，
    // 否则翻一本漫画就刷几十条封面进嗅探列表。与渲染层 utils.isAcgUrl 保持同口径
    const ACG_SNIFF_EXCLUDE_SUFFIXES = ['acgmho.com', 'acgnngca.com', 'acgnfl.com', 'acg-hentai.com'];
    const isAcgExcluded = (u) => {
        if (!u || typeof u !== 'string') return false;
        try {
            const host = new URL(u).hostname.toLowerCase();
            return ACG_SNIFF_EXCLUDE_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
        } catch (_e) {
            return false;
        }
    };

    const streamExts = ['m3u8', 'm3u', 'mpd', 'flv', 'f4v'];
    const videoExts = ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'ogv', '3gp', 'mpg', 'mpeg', 'm4s', 'ts'];
    const audioExts = ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'opus', 'wma'];
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'avif'];

    sess.webRequest.onResponseStarted(filter, (details) => {
        const { url, responseHeaders, method, statusCode } = details;
        if (!url || (statusCode !== 200 && statusCode !== 206) || method === 'OPTIONS' || method === 'HEAD') {
            return;
        }

        // ACG 资源直接丢弃：资源直链在 ACG 域名，或请求挂在 ACG 页面下（referrer）
        if (isAcgExcluded(url) || isAcgExcluded(details.referrer)) {
            return;
        }

        if (
            url.startsWith('chrome-extension:') ||
            url.startsWith('devtools:') ||
            url.startsWith('blob:') ||
            url.startsWith('data:') ||
            url.startsWith('file:')
        ) {
            // file: 必须排除：嗅探是为了发现远端媒体以下载，本地文件进列表零作用；
            // 且 ACG 落盘页正是 file://（hostname 为空，走不进上面的域名排除，
            // img 又是 no-referrer），否则保存完成后轮播每翻一页就往嗅探列表推一条。
            return;
        }

        const getHeader = (headers, name) => {
            if (!headers) return '';
            const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
            if (!key) return '';
            const val = headers[key];
            return Array.isArray(val) ? val[0] : String(val);
        };

        const contentType = getHeader(responseHeaders, 'content-type').toLowerCase();

        // 快速过滤不需要的普通网页文本文件
        if (
            contentType.includes('text/html') ||
            contentType.includes('text/css') ||
            contentType.includes('javascript') ||
            contentType.includes('application/json')
        ) {
            return;
        }

        let detectedType = null;
        let ext = '';

        // 1. 基于 Content-Type 判定
        if (
            contentType.includes('mpegurl') ||
            contentType.includes('dash+xml') ||
            contentType.includes('vnd.ms-sstr') ||
            contentType.includes('application/x-mpegurl')
        ) {
            detectedType = 'stream';
            ext = contentType.includes('dash') ? 'mpd' : 'm3u8';
        } else if (contentType.startsWith('video/')) {
            if (contentType.includes('x-flv')) {
                detectedType = 'stream';
                ext = 'flv';
            } else {
                detectedType = 'video';
                ext = contentType.split('/')[1]?.split(';')[0]?.replace('x-', '') || 'mp4';
            }
        } else if (contentType.startsWith('audio/')) {
            detectedType = 'audio';
            ext = contentType.split('/')[1]?.split(';')[0]?.replace('x-', '') || 'mp3';
        } else if (contentType.startsWith('image/')) {
            let imgExt = contentType.split('/')[1]?.split(';')[0];
            if (imgExt === 'svg+xml') {
                imgExt = 'svg';
            }
            if (imageExts.includes(imgExt)) {
                detectedType = 'image';
                ext = imgExt;
            }
        }

        // 2. 基于 URL 路径拓展名判定
        let urlObj = null;
        let pathname = '';
        try {
            urlObj = new URL(url);
            pathname = urlObj.pathname.toLowerCase();
        } catch (_e) {
            pathname = url.split('?')[0].split('#')[0].toLowerCase();
        }

        const pathMatch = pathname.match(/\.([a-zA-Z0-9]+)$/);
        const pathExt = pathMatch ? pathMatch[1] : '';

        if (!detectedType) {
            if (streamExts.includes(pathExt)) {
                detectedType = 'stream';
                ext = pathExt;
            } else if (videoExts.includes(pathExt)) {
                detectedType = 'video';
                ext = pathExt;
            } else if (audioExts.includes(pathExt)) {
                detectedType = 'audio';
                ext = pathExt;
            } else if (imageExts.includes(pathExt)) {
                detectedType = 'image';
                ext = pathExt;
            }
        }

        // 3. 基于 Query 参数中嵌套媒体拓展名探测
        if (!detectedType && urlObj) {
            for (const [, val] of urlObj.searchParams.entries()) {
                const lowerVal = val.toLowerCase();
                if (streamExts.some((s) => lowerVal.includes(`.${s}`))) {
                    detectedType = 'stream';
                    ext = 'm3u8';
                    break;
                } else if (videoExts.some((v) => lowerVal.includes(`.${v}`))) {
                    detectedType = 'video';
                    ext = 'mp4';
                    break;
                } else if (audioExts.some((a) => lowerVal.includes(`.${a}`))) {
                    detectedType = 'audio';
                    ext = 'mp3';
                    break;
                }
            }
        }

        // 过滤 TS 切片分段
        if (ext === 'ts') {
            const isSegment =
                /\b(seg|chunk|slice|frag|part|track|\d{2,})\b/i.test(pathname) ||
                /[-_]\d+\.ts/i.test(pathname) ||
                pathname.includes('/ts/') ||
                contentType.includes('mp2t');
            if (isSegment && !url.includes('playlist')) {
                return;
            }
        }

        if (!detectedType || !mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        // 去重检查 (5 秒内相同 URL 不重复推送)
        const now = Date.now();
        const lastSeen = recentSniffedUrls.get(url);
        if (lastSeen && now - lastSeen < 5000) {
            return;
        }
        recentSniffedUrls.set(url, now);

        // 提取文件名与安全标题
        let filename = '';
        const dispositionHeader = getHeader(responseHeaders, 'content-disposition');
        if (dispositionHeader) {
            const match = dispositionHeader.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
            if (match && match[1]) {
                filename = match[1];
            }
        }

        if (!filename && urlObj) {
            const parts = urlObj.pathname.split('/').filter(Boolean);
            filename = parts.pop() || '';
        }

        if (!filename || filename.length > 80) {
            filename = `Media_${ext || 'stream'}`;
        }

        let safeTitle = filename;
        try {
            safeTitle = decodeURIComponent(filename);
        } catch (_err) {
            safeTitle = filename;
        }

        let senderUrl = '';
        if (details.webContentsId) {
            try {
                const sender = webContents.fromId(details.webContentsId);
                if (sender && !sender.isDestroyed()) {
                    senderUrl = sender.getURL() || '';
                }
            } catch (_e) { }
        }

        const referer = details.referrer || senderUrl || '';
        const pageUrl = senderUrl || details.referrer || '';

        // 二次兜底：宿主页面在 ACG 站（senderUrl）但 referrer 为空时，早期拦截拦不住，
        // 这里按最终 pageUrl/referer 再拦一次，与渲染层 addLinks 同口径
        if (isAcgExcluded(referer) || isAcgExcluded(pageUrl)) {
            return;
        }

        try {
            mainWindow.webContents.send('sniffed-media', {
                url,
                title: safeTitle,
                type: detectedType,
                ext: ext || 'unknown',
                source: 'network',
                referer,
                pageUrl,
            });
        } catch (_e) { }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: 'React Advanced Player',
        backgroundColor: '#020617',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            allowRunningInsecureContent: false,
            webSecurity: false,
            webviewTag: true,
        },
    });

    const isDev = !app.isPackaged;
    const devUrl = 'http://localhost:5173';
    const prodPath = path.join(__dirname, '../dist/index.html');

    if (isDev) {
        mainWindow.loadURL(devUrl);
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(prodPath);
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        mainWindow.webContents.send('navigate-to-url', url);
        return { action: 'deny' };
    });

    mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
        if (webContents.session) {
            setupSniffer(webContents.session);
        }
        webContents.setWindowOpenHandler(({ url }) => {
            mainWindow.webContents.send('navigate-to-url', url);
            return { action: 'deny' };
        });
    });

    const filter = { urls: ['*://*/*'] };
    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
        const requestHeaders = { ...details.requestHeaders };
        let hostname = '';
        try {
            hostname = new URL(details.url).hostname;
        } catch (_error) { }
        // acgmho 系与 Cloudflare 域豁免 UA/sec-ch-ua 改写：这两处流量要过 Cloudflare
        // managed 挑战，UA 必须是浏览器真实值，Client Hints 也必须原样发送。
        // 之前一刀切改成 Chrome/122 并删除 sec-ch-ua，导致"UA 头 / JS 里的 UA / 内核版本"
        // 三处互相矛盾，挑战验证必失败（点击了也过不去、反复弹回挑战页）。
        const isChallengeSensitive =
            /(^|\.)acgmho\.com$/i.test(hostname) ||
            /(^|\.)acgnngca\.com$/i.test(hostname) ||
            /(^|\.)acgnfl\.com$/i.test(hostname) ||
            /(^|\.)acg-hentai\.com$/i.test(hostname) ||
            /(^|\.)cloudflare\.com$/i.test(hostname);
        if (!isChallengeSensitive) {
            requestHeaders['User-Agent'] = USER_AGENT;
            delete requestHeaders['sec-ch-ua'];
            delete requestHeaders['sec-ch-ua-mobile'];
            delete requestHeaders['sec-ch-ua-platform'];
        }

        if (/(^|\.)bilivideo\.com$/i.test(hostname) || /(^|\.)hdslb\.com$/i.test(hostname)) {
            requestHeaders.Referer = 'https://www.bilibili.com/';
        } else if (
            /(^|\.)acgmho\.com$/i.test(hostname) ||
            /(^|\.)acgnngca\.com$/i.test(hostname) ||
            /(^|\.)acgnfl\.com$/i.test(hostname) ||
            /(^|\.)acg-hentai\.com$/i.test(hostname)
        ) {
            // 与嗅探排除口径（ACG_SNIFF_EXCLUDE_SUFFIXES）保持一致：四个镜像站都要补 Referer 防盗链
            requestHeaders.Referer = 'https://www.acgmho.com/';
        }

        callback({ requestHeaders });
    });

    const { session } = require('electron');
    setupSniffer(session.defaultSession);
    if (mainWindow.webContents.session !== session.defaultSession) {
        setupSniffer(mainWindow.webContents.session);
    }

    setupTamperHandlers(mainWindow.webContents.session);
    setupDownloadHandlers();
    setupGalleryHandlers();
    setupSukebeiHandlers();
    setupSettingsHandlers();
}

function setupSettingsHandlers() {
    if (settingsHandlersReady) return;
    settingsHandlersReady = true;

    ipcMain.handle('settings-get', async () => {
        const { proxyPort, ai } = getSettings();
        return {
            success: true,
            proxyPort,
            applied: getAcgmhoProxy() || '',
            ai,
        };
    });

    // 保存后立即把新配置推给服务层，不必重启应用。
    // 返回 applied 让界面能区分「配了端口但连不上，已回落直连」。
    ipcMain.handle('settings-set-proxy-port', async (_event, value) => {
        const res = saveProxyPort(value);
        if (!res.success) return { ...res, applied: getAcgmhoProxy() || '' };
        await syncAcgmhoProxy();
        return { ...res, applied: getAcgmhoProxy() || '' };
    });

    // AI 配置由主进程持有：渲染层只提交，落盘与校验都在这一侧完成
    ipcMain.handle('settings-set-ai-config', async (_event, value) => {
        return saveAiConfig(value);
    });

    // 探活用提交上来的草稿配置，不落盘 —— 用户可以先验证再决定要不要保存
    ipcMain.handle('settings-test-ai-config', async (_event, value) => {
        return testAiConnection(value);
    });
}

app.whenReady().then(async () => {
    // 启动即同步代理配置：留空则直连，配了端口则建隧道
    await syncAcgmhoProxy();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    try {
        // 同步销毁 BT 引擎，避免退出时 DHT/Peer 句柄挂起
        destroyTorrentClient();
    } catch (_e) { }
});
