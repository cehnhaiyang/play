/**
 * torrentService.js — 内置 BitTorrent 下载引擎（基于 webtorrent v3，无需任何外部下载工具）。
 *
 * 注意：webtorrent v3 是纯 ESM（含顶层 await），不能再被 CJS require()，
 * 否则在新版 Node/Electron 下抛 ERR_REQUIRE_ASYNC_MODULE。
 * 因此这里用动态 import() 懒加载，主进程其余部分保持 CJS 不变。
 *
 * 能力：
 * - magnet / .torrent 文件 / .torrent 直链 → 直接下载正片文件到磁盘
 * - DHT + PEX + LSD + Tracker 全开找 peer；magnet 自带 tracker 时优先用自带的
 * - 多文件种子可按文件索引选下；完成后继续做种
 * - 进度节流推送（~1s 一次） + 元数据 / 完成 / 出错事件
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// webtorrent v3 为纯 ESM：顶层 require 会抛 ERR_REQUIRE_ASYNC_MODULE，改动态 import 懒加载。

/**
 * 公共 Tracker 大表（udp + http + wss 三栖）：
 * - 旧实现只有 6 个 udp tracker，其中 1~2 个常年失联，找 peer 全靠运气；
 * - http(s) 走 80/443，在 UDP 被墙/运营商 QoS 的网络下是救命通道；
 * - wss 在 Node 主进程同样可用（bittorrent-tracker 内置 ws client），公司网/校园网常只剩它能通。
 * 无效 tracker 只会产生一次失败 announce，由 client 自行消化，不影响其它通道。
 */
const DEFAULT_TRACKERS = [
    // UDP 主力（含亚洲节点，moack 在韩，对国内直连质量最好的一批）
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://www.torrent.eu.org:451/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.tiny-vps.com:6969/announce',
    'udp://tracker1.bt.moack.co.kr:80/announce',
    'udp://tracker.bitsearch.to:1337/announce',
    'udp://explodie.org:6969/announce',
    'udp://tracker.empire-js.us:1337/announce',
    // HTTP(S)：UDP 被墙时的备用通道
    'http://tracker.opentrackr.org:1337/announce',
    'https://opentracker.i2p.rocks:443/announce',
    // WebSocket：在只剩 443 出站的苛刻网络下兜底
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.files.fm:7073/announce',
];

/**
 * DHT 启动节点：k-rpc 默认只有 router.bittorrent / router.utorrent /
 * dht.transmissionbt 三个 6881，传数组会整体替换默认（见 k-rpc toBootstrapArray），
 * 所以默认三个必须原样保留，再追加 libtorrent / BitComet / Vuze 系入口。
 * DHT 进网慢 = magnet 元数据慢 + DHT peer 来得慢，这是“磁链慢”头号原因。
 */
const DHT_BOOTSTRAP_NODES = [
    'router.bittorrent.com:6881',
    'router.utorrent.com:6881',
    'dht.transmissionbt.com:6881',
    'dht.libtorrent.org:25401',
    'router.bitcomet.com:6881',
    'dht.aelitis.com:6881',
];

let client = null;
/** client 正在创建时的共享 Promise，避免并发 start 造出多个实例 */
let clientReady = null;
let taskSeq = 0;
/** taskId -> task record */
const tasks = new Map();
/** 旧临时 id -> task record：rekey（tempId→infoHash）后旧 id 仍可操作，避免元数据到达前暂停/取消报“任务不存在” */
const aliases = new Map();
/** 无元数据超时：DHT/tracker 全挂或纯本机模式无 peer 时，任务不能永远卡在 metadata */
const METADATA_TIMEOUT_MS = 90 * 1000;

async function loadWebTorrentCtor() {
    const mod = await import('webtorrent');
    return mod.default || mod.WebTorrent || mod;
}

async function getClient() {
    if (client) return client;
    if (!clientReady) {
        clientReady = (async () => {
            const WebTorrent = await loadWebTorrentCtor();
            // THEPLAY_BT_LOCAL=1：纯本机联调模式，关闭一切对外发现（DHT/Tracker/LSD/uTP/UPnP），
            // 只走手动 addPeer，流量不出 loopback，不会触发 VPN/防火墙告警。
            const local = process.env.THEPLAY_BT_LOCAL === '1';
            const c = new WebTorrent(local ? {
                maxConns: 100,
                dht: false,
                tracker: false,
                lsd: false,
                utp: false,
                natUpnp: false,
            } : {
                // 找 peer 三板斧全开：
                // 1. tracker.announce：client 级默认 tracker，每个非私有种子自动追加
                //    （之前只靠 magnet 里那几个 tr，.torrent 文件起的任务一个都吃不到）；
                // 2. dht.bootstrap：6 入口代替默认 3 个，DHT 进网快一倍；
                // 3. maxConns 100→200：热门资源 peer 多时并行上得去（内存可忽略）。
                // LSD / PEX / UPnP / uTP 保持库默认开启，不动。
                maxConns: 200,
                tracker: { announce: DEFAULT_TRACKERS },
                dht: { bootstrap: DHT_BOOTSTRAP_NODES },
                // dhtPort 默认 0（随机端口），避免与本机其他 BT 客户端抢 6881
            });
            c.on('error', (err) => {
                // 全局错误只记录，具体任务错误走 torrent 'error' 事件
                console.error('[torrent] client error:', err && err.message);
            });
            return c;
        })();
        // 创建失败时清掉共享 Promise，允许下次调用重试而不是永远挂起
        clientReady.then(
            (c) => { client = c; },
            () => { clientReady = null; },
        );
    }
    return clientReady;
}

function ensureMagnetTrackers(magnet) {
    if (!magnet || !magnet.startsWith('magnet:?')) return magnet;
    if (/([?&])tr=/.test(magnet)) return magnet;
    const extra = DEFAULT_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
    return `${magnet}${magnet.includes('?') ? '' : '?'}${extra}`;
}

function guessTempId(input) {
    taskSeq += 1;
    if (typeof input === 'string') {
        const m = input.match(/btih:([a-zA-Z0-9]+)/i);
        if (m) return m[1].toLowerCase();
    }
    return `task-${Date.now()}-${taskSeq}`;
}

function snapshot(task) {
    const t = task.torrent;
    const files = (t.files || []).map((f, i) => ({ index: i, name: f.name, path: f.path, length: f.length }));
    return {
        id: task.id,
        name: t.name || task.nameHint || task.id,
        status: task.status,
        progress: t.progress || 0,
        downloaded: t.downloaded || 0,
        total: t.length || 0,
        downloadSpeed: t.downloadSpeed || 0,
        uploadSpeed: t.uploadSpeed || 0,
        numPeers: t.numPeers || 0,
        etaMs: t.timeRemaining || 0,
        files,
        outDir: task.outDir,
        error: task.error || '',
    };
}

function emit(task, onProgress, force = false) {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - (task.lastEmit || 0) < 900) return;
    task.lastEmit = now;
    try {
        onProgress(snapshot(task));
    } catch (_e) { }
}

function sanitizeDirName(name) {
    const clean = String(name || 'torrent')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .trim()
        .slice(0, 100);
    return clean || 'torrent';
}

/** magnet 去掉我们追加的 tracker 参数后做去重键，避免同一种子因 tr 排序不同被认成两个任务 */
function magnetKey(magnet) {
    const m = String(magnet || '').match(/btih:([a-zA-Z0-9]+)/i);
    return m ? m[1].toLowerCase() : String(magnet || '');
}

/** 同名目录已有内容且不属于当前任务时，追加后缀避免两个任务写进同一目录互相覆盖 */
function uniquifyOutDir(dir) {
    if (!fs.existsSync(dir)) return dir;
    try {
        const entries = fs.readdirSync(dir);
        if (entries.length === 0) return dir;
        for (const t of tasks.values()) {
            if (t.outDir === dir) return dir;
        }
    } catch (_e) {
        return dir;
    }
    let i = 1;
    let candidate = `${dir}-${i}`;
    while (fs.existsSync(candidate)) {
        i += 1;
        candidate = `${dir}-${i}`;
    }
    return candidate;
}

/** 按 wantedIndexes 应用文件选下；metadata 事件与添加后即时各调一次，
 * 防止“元数据秒回（缓存/本地种子）时监听器还没挂上导致全下” */
function applyFileSelection(torrent, wantedIndexes) {
    if (!Array.isArray(wantedIndexes) || wantedIndexes.length === 0) return;
    if (!torrent.files) return;
    const want = new Set(wantedIndexes);
    torrent.files.forEach((f, i) => {
        try {
            if (want.has(i)) f.select();
            else f.deselect();
        } catch (_e) { }
    });
}

/**
 * 开启下载任务。options: { magnet?, torrentPath?, torrentData?(Buffer), name?, outDir?, fileIndexes?, addPeers? }
 * fileIndexes 为空 = 全下；否则只下指定文件索引。
 * addPeers: 手动指定 peer（如 ['127.0.0.1:6881']），本机联调或 tracker 全挂时兜底。
 */
function startTorrent(options, onProgress) {
    return new Promise((resolve, reject) => {
        (async () => {
            const { magnet, torrentPath, torrentData, name, fileIndexes } = options || {};
            let torrentId = null;
            if (magnet) torrentId = ensureMagnetTrackers(magnet);
            else if (torrentPath) torrentId = torrentPath;
            else if (torrentData) torrentId = Buffer.isBuffer(torrentData) ? torrentData : Buffer.from(torrentData);
            if (!torrentId) {
                throw new Error('缺少 magnet / torrentPath / torrentData');
            }

            const c = await getClient();
            // 去重：同一 magnet / 种子文件重复点“下载”时直接返回既有任务，
            // 否则 c.add 会抛 "torrent is already in the client"
            const sourceKey = magnet ? `magnet:${magnetKey(magnet)}` : `path:${torrentPath || ''}`;
            for (const t of tasks.values()) {
                if (t.sourceKey && t.sourceKey === sourceKey) {
                    resolve({ taskId: t.id, outDir: t.outDir, duplicate: true });
                    return;
                }
            }
            if (magnet) {
                try {
                    const existing = c.get(torrentId);
                    if (existing) {
                        for (const t of tasks.values()) {
                            if (t.torrent === existing) {
                                resolve({ taskId: t.id, outDir: t.outDir, duplicate: true });
                                return;
                            }
                        }
                    }
                } catch (_e) { }
            }
            const outDirBase = options.outDir ||
                path.join(app_downloadsDir(), 'the-play', 'bt', sanitizeDirName(name || guessTempId(magnet || '')));
            const outDir = uniquifyOutDir(outDirBase);
            fs.mkdirSync(outDir, { recursive: true });

            let torrent;
            try {
                torrent = c.add(torrentId, { path: outDir });
            } catch (err) {
                // 并发双点导致的竞态去重：add 抛重复时回退到既有任务
                if (String((err && err.message) || err).toLowerCase().includes('already')) {
                    for (const t of tasks.values()) {
                        if (t.sourceKey && t.sourceKey === sourceKey) {
                            resolve({ taskId: t.id, outDir: t.outDir, duplicate: true });
                            return;
                        }
                    }
                }
                throw err;
            }

            const tempId = guessTempId(magnet || '');
            const task = {
                id: tempId,
                torrent,
                outDir,
                sourceKey,
                nameHint: name || '',
                status: 'metadata',
                error: '',
                lastEmit: 0,
                wantedIndexes: Array.isArray(fileIndexes) ? fileIndexes : null,
                metadataTimer: null,
            };
            tasks.set(tempId, task);

            const disarmMetadataTimer = () => {
                if (task.metadataTimer) {
                    clearTimeout(task.metadataTimer);
                    task.metadataTimer = null;
                }
            };
            const armMetadataTimer = () => {
                disarmMetadataTimer();
                task.metadataTimer = setTimeout(() => {
                    task.metadataTimer = null;
                    if (task.status === 'metadata') {
                        task.status = 'error';
                        task.error = '长时间未获取到种子元数据：可能无可用 peer / tracker 被墙 / 网络禁 P2P，换节点或稍后重试。';
                        emit(task, onProgress, true);
                    }
                }, METADATA_TIMEOUT_MS);
                if (task.metadataTimer.unref) task.metadataTimer.unref();
            };
            task.disarmMetadataTimer = disarmMetadataTimer;
            task.armMetadataTimer = armMetadataTimer;
            armMetadataTimer();

            // 手动 peer（本机联调 / 紧急直连）：只接受 host:port 字符串，防坏输入把 swarm 搞崩
            if (Array.isArray(options.addPeers)) {
                for (const addr of options.addPeers) {
                    if (typeof addr !== 'string' || !/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(addr.trim())) continue;
                    try {
                        torrent.addPeer(addr.trim());
                    } catch (_e) { }
                }
            }

            const rekey = (finalId) => {
                if (finalId && finalId !== task.id) {
                    // 保留旧 id 别名：渲染层手里的 tempId 在元数据到达前仍可暂停/取消
                    aliases.set(task.id, task);
                    tasks.delete(task.id);
                    task.id = finalId;
                    tasks.set(finalId, task);
                }
            };

            torrent.on('infoHash', () => {
                if (torrent.infoHash) rekey(torrent.infoHash.toLowerCase());
                emit(task, onProgress, true);
            });

            torrent.on('metadata', () => {
                applyFileSelection(torrent, task.wantedIndexes);
                if (torrent.infoHash) rekey(torrent.infoHash.toLowerCase());
                task.status = 'downloading';
                disarmMetadataTimer();
                emit(task, onProgress, true);
            });

            torrent.on('download', () => {
                if (task.status !== 'downloading' && !torrent.done) task.status = 'downloading';
                emit(task, onProgress, false);
            });

            torrent.on('upload', () => emit(task, onProgress, false));

            torrent.on('done', () => {
                task.status = 'seeding';
                disarmMetadataTimer();
                emit(task, onProgress, true);
            });

            torrent.on('error', (err) => {
                task.status = 'error';
                task.error = (err && err.message) || String(err);
                disarmMetadataTimer();
                emit(task, onProgress, true);
            });

            torrent.on('noPeers', () => {
                // 仅提示一次：长时间无 peer 由调用方按 downloadSpeed==0 判断
                emit(task, onProgress, true);
            });

            // 本地种子/缓存导致元数据秒回时，metadata 事件可能抢跑；即时补一次选文件
            try {
                if (torrent.files && torrent.files.length > 0 && torrent.infoHash) {
                    applyFileSelection(torrent, task.wantedIndexes);
                    rekey(torrent.infoHash.toLowerCase());
                    task.status = 'downloading';
                    disarmMetadataTimer();
                }
            } catch (_e) { }

            emit(task, onProgress, true);
            // 若同步路径已 rekey（如缓存秒回），返回 task.id 而非过期 tempId
            resolve({ taskId: task.id, outDir });
        })().catch(reject);
    });
}

function findTask(taskId) {
    if (tasks.has(taskId)) return tasks.get(taskId);
    if (aliases.has(taskId)) return aliases.get(taskId);
    const lower = String(taskId).toLowerCase();
    for (const [id, task] of tasks) {
        if (id.toLowerCase() === lower) return task;
    }
    for (const [id, task] of aliases) {
        if (id.toLowerCase() === lower) return task;
    }
    return null;
}

function dropTask(task) {
    tasks.delete(task.id);
    for (const [aliasId, t] of aliases) {
        if (t === task) aliases.delete(aliasId);
    }
    if (task.disarmMetadataTimer) {
        try { task.disarmMetadataTimer(); } catch (_e) { }
    }
}

/** 取消任务。deleteFiles 仅删除未完成分片：已完工（done）任务默认保留文件，
 * 否则任务列表里点一下“删除”就把下好的正片一起扬了。 */
function cancelTorrent(taskId, deleteFiles = true) {
    return new Promise((resolve) => {
        (async () => {
            const task = findTask(taskId);
            if (!task) {
                resolve({ success: false, message: '任务不存在' });
                return;
            }
            const c = await getClient();
            // 已完成任务：destroyStore 会连正片一起删，必须强制 false
            const destroyStore = Boolean(deleteFiles) && !task.torrent.done;
            try {
                c.remove(task.torrent, { destroyStore }, (err) => {
                    dropTask(task);
                    if (err) resolve({ success: false, message: String(err.message || err) });
                    else resolve({ success: true });
                });
            } catch (err) {
                dropTask(task);
                resolve({ success: false, message: String(err.message || err) });
            }
        })().catch((err) => resolve({ success: false, message: String((err && err.message) || err) }));
    });
}

function pauseTorrent(taskId) {
    const task = findTask(taskId);
    if (!task) return { success: false, message: '任务不存在' };
    try {
        task.torrent.pause();
        task.status = 'paused';
        // 暂停后元数据不会再来，计时器继续跑会误报 error；先停掉，恢复时重建
        if (task.disarmMetadataTimer) task.disarmMetadataTimer();
        return { success: true };
    } catch (err) {
        return { success: false, message: String(err.message || err) };
    }
}

function resumeTorrent(taskId) {
    const task = findTask(taskId);
    if (!task) return { success: false, message: '任务不存在' };
    try {
        task.torrent.resume();
        task.status = task.torrent.done ? 'seeding' : 'downloading';
        if (task.status === 'downloading' && task.armMetadataTimer && !task.torrent.infoHash) {
            task.armMetadataTimer();
        }
        return { success: true };
    } catch (err) {
        return { success: false, message: String(err.message || err) };
    }
}

function getTorrentTasks() {
    return Array.from(tasks.values()).map(snapshot);
}

function openTorrentFolder(target) {
    const task = target ? findTask(target) : null;
    const dir = task ? task.outDir : target;
    return dir || '';
}

function destroyTorrentClient() {
    return new Promise((resolve) => {
        for (const t of tasks.values()) {
            if (t.disarmMetadataTimer) {
                try { t.disarmMetadataTimer(); } catch (_e) { }
            }
        }
        tasks.clear();
        aliases.clear();
        if (!client) {
            resolve();
            return;
        }
        const c = client;
        client = null;
        try {
            c.destroy(() => resolve());
        } catch (_e) {
            resolve();
        }
    });
}

// 延迟绑定 app.getPath('downloads')，避免在 electron 未就绪时调用
let downloadsDirOverride = null;
function app_downloadsDir() {
    if (downloadsDirOverride) return downloadsDirOverride;
    try {
        const { app } = require('electron');
        if (app && app.getPath) return app.getPath('downloads');
    } catch (_e) { }
    return path.join(os.homedir(), 'Downloads');
}
function setDownloadsDir(dir) {
    downloadsDirOverride = dir;
}

module.exports = {
    DEFAULT_TRACKERS,
    DHT_BOOTSTRAP_NODES,
    startTorrent,
    cancelTorrent,
    pauseTorrent,
    resumeTorrent,
    getTorrentTasks,
    openTorrentFolder,
    destroyTorrentClient,
    setDownloadsDir,
    ensureMagnetTrackers,
};
