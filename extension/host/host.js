'use strict';

/**
 * native messaging host：插件 ↔ 本机应用 的唯一通道。
 *
 * ## 为什么必须有这个进程
 *
 * 悬浮球现在跑在 Electron 里（见 `app/main/orbs.js` 讲清了为什么不能用
 * 插件的窗口）。而球要显示的东西 —— 嗅探结果、Agent 对话 —— 全部长在插件里。
 * 于是需要一条从应用通向插件的路。
 *
 * **这条路只能由 Chrome 发起。** `chrome.runtime.connectNative` 只有扩展自己
 * 能调；应用无法主动"连上"一个扩展。所以方向是反过来的：
 *
 *     扩展 SW ──connectNative──▶ Chrome 拉起本进程 ──TCP──▶ Electron 主进程
 *
 * 本进程就是被 Chrome 拉起的那个。它的职责只有一件事：**把 stdio 上的
 * native messaging 帧与本地 TCP 之间做双向转发**。它不认识任何业务端点 ——
 * 端点表在 `shared/meta/bridge.ts`，加端点不该动这个文件。
 *
 * ## native messaging 的帧格式
 *
 * 前 4 字节是本机字节序（Windows 上是小端）的 JSON 字节长度，之后是 JSON 本体。
 * **不是换行分隔的 JSON** —— 用 readline 按行读会一行都读不出来，
 * 表现为"连上了但一条消息都不来"。
 *
 * ## 为什么中间要过一段 TCP
 *
 * 因为 stdio 只属于本进程与 Chrome 之间。Electron 主进程拿不到 Chrome 给
 * 本进程的 stdin/stdout 句柄，所以两者之间需要第二条通道。用 127.0.0.1 上的
 * TCP 而不是命名管道：两端都不需要额外依赖，且带 token 之后
 * 只有本机进程能连（token 写在用户目录下的文件里，权限跟随用户）。
 */

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 桥协议版本。必须与 `shared/meta/bridge.ts` 的 `BRIDGE_PROTOCOL_VERSION` 一致。
 *
 * 硬编码而不是 import：本文件是 Chrome 用 node 直接拉起的独立进程，
 * 不经过打包器，解析不了 TS。两处不一致会在握手时立刻暴露 ——
 * 那正是握手存在的意义。
 */
const BRIDGE_PROTOCOL_VERSION = 1;

/** Electron 主进程写下的连接信息。与本文件约定的文件名必须一致 */
const ENDPOINT_FILE = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'the-play',
    'bridge-endpoint.json',
);

/**
 * 致命错误的出口。
 *
 * 只有"这条通道已经不可能再用"才走这里。Chrome 会把本进程的 stderr 收进扩展
 * 的错误日志，所以宁可写一行原因，也不要静默退出。
 *
 * ⚠️ **连不上应用不属于致命错误**，那只是等待状态 —— 见 `scheduleReconnect`。
 */
const fail = (message) => {
    process.stderr.write(`[theplay-host] ${message}\n`);
    process.exit(1);
};

/**
 * 读应用写下的连接信息。**读不到返回 null，不退出。**
 *
 * 应用可能只是还没启动，也可能正在重启 —— 它每次启动都会换端口和 token，
 * 所以这个文件必须在每次重连前重新读一遍，缓存住旧值就永远接不上新实例。
 */
const readEndpoint = () => {
    try {
        const parsed = JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8'));
        if (typeof parsed?.port !== 'number' || typeof parsed?.token !== 'string') return null;
        return parsed;
    } catch {
        return null;
    }
};

/* ========================================================================== */
/* 1. stdio ↔ 帧                                                              */
/* ========================================================================== */

/**
 * 从 stdin 累积并按帧切分。
 *
 * 必须自己缓冲：一次 `data` 事件不保证正好是一个完整帧，也不保证只有一个帧。
 * 直接 `JSON.parse(chunk)` 在小消息上碰巧能跑，一大就碎 —— 而"一大就碎"
 * 只在真实负载下出现，本地测小消息永远发现不了。
 */
let inbound = Buffer.alloc(0);

const onStdinData = (chunk) => {
    inbound = Buffer.concat([inbound, chunk]);
    for (;;) {
        if (inbound.length < 4) return;
        const length = inbound.readUInt32LE(0);
        // 上限防御：长度字段被写坏时不要试图分配几个 GB
        if (length > 64 * 1024 * 1024) fail(`帧长度异常：${length}`);
        if (inbound.length < 4 + length) return;

        const body = inbound.subarray(4, 4 + length).toString('utf8');
        inbound = inbound.subarray(4 + length);

        let message;
        try {
            message = JSON.parse(body);
        } catch (e) {
            // 单条坏消息不该终止整条通道：回一条错误，继续读下一帧
            send({ id: null, ok: false, error: `JSON 解析失败：${e && e.message}` });
            continue;
        }
        relay.toExtension(message);
    }
};

/** 往 stdout 写一个帧。**必须一次写完**，分两次写会让 Chrome 读到半个帧 */
const send = (message) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([header, body]));
};

/* ========================================================================== */
/* 2. 与 Electron 的 TCP 通道                                                 */
/* ========================================================================== */

/**
 * 应用还没连上时的排队上限。
 *
 * 队列的意义只有一个：撑过"本进程起来了、TCP 还没连上"这段间隙（通常毫秒级，
 * 应用重启时最多一秒多）。而应用长时间不在时插件仍在推东西（嗅探结果、
 * Agent 的流式增量），无上限地攒下去就是让这个进程一直吃内存 ——
 * 而 Chrome 会一直留着它。
 *
 * 超限丢**最旧的**：这些都是状态推送，越新越有用；且应用一连上就会自己拉一次
 * 全量快照（与 `app`/插件侧"事件不排队"是同一套理由，见 bridge-port.ts）。
 */
const MAX_QUEUE = 200;

const relay = {
    socket: null,
    /** 应用还没连上时，先把插件发来的消息排队 —— 短间隙里丢消息比延迟更糟 */
    queue: [],
    buffer: Buffer.alloc(0),

    toExtension(message) {
        if (!this.socket) {
            this.queue.push(message);
            // 只保留最近 MAX_QUEUE 条，见上面
            if (this.queue.length > MAX_QUEUE) this.queue.shift();
            return;
        }
        this.socket.write(`${JSON.stringify(message)}\n`);
    },

    toApp(message) {
        send(message);
    },

    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const index = this.buffer.indexOf(0x0a);
            if (index < 0) return;
            const line = this.buffer.subarray(0, index).toString('utf8');
            this.buffer = this.buffer.subarray(index + 1);
            if (!line.trim()) continue;
            try {
                this.toApp(JSON.parse(line));
            } catch {
                // 应用发来的坏行忽略，通道继续用
            }
        }
    },
};

/* ========================================================================== */
/* 3. 启动                                                                    */
/* ========================================================================== */

/**
 * 重连间隔。
 *
 * 应用重启是**正常操作**：它每次启动都会换端口与 token，所以旧连接必然断开。
 * 断开之后本进程要自己接回去 —— 这是"重启应用不必重启浏览器"的全部实现。
 *
 * 取 1 秒：应用重启通常一两秒内完成；再密只是空转，再疏用户会明显等。
 */
const RECONNECT_MS = 1000;

let socket = null;
let reconnectTimer = null;

const scheduleReconnect = () => {
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, RECONNECT_MS);
};

/**
 * 连一次应用。
 *
 * **不在这里处理失败。** 连不上（应用没起来、刚退出、端点文件还没落盘）
 * 都只是等待状态，一律交给 `close` 与 `scheduleReconnect` 走下一轮。
 */
const connect = () => {
    if (socket) return;

    const endpoint = readEndpoint();
    if (!endpoint) {
        scheduleReconnect();
        return;
    }

    const created = net.createConnection({ host: '127.0.0.1', port: endpoint.port });
    socket = created;

    created.on('connect', () => {
        // 第一行是握手：带上 token，应用据此确认这是自己的 host 而不是别的本机进程
        created.write(`${JSON.stringify({ hello: 'theplay-host', token: endpoint.token })}\n`);

        /*
         * 第二行告诉插件"应用是谁、协议版本多少"。
         *
         * 插件据此比对版本 —— 不一致要明确报错而不是降级尝试，否则旧应用配新插件
         * 会表现为"某些端点神秘失败"。
         *
         * 版本号是**硬编码**的，不从 shared/ 里 import：host.js 是 Chrome 用
         * node 直接拉起的独立进程，不能依赖打包器解析 TS。改协议版本时
         * 要同时改这里和 shared/meta/bridge.ts —— 两处不一致会立刻在握手时暴露，
         * 这正是握手存在的意义。
         */
        send({ hello: 'theplay-host', protocol: BRIDGE_PROTOCOL_VERSION });

        // 握手发完才开放转发，否则排队中的消息会插到握手前面
        relay.socket = created;
        for (const message of relay.queue.splice(0)) {
            created.write(`${JSON.stringify(message)}\n`);
        }
    });

    created.on('data', (chunk) => relay.onData(chunk));

    created.on('error', () => {
        // 'close' 会跟着来，这里不重复处理
    });

    /**
     * 断开就重连，**不退出进程**。
     *
     * 原先这里是 `process.exit(0)`，那正是"重启应用必须重启浏览器"的根因：
     * 本进程一退，插件的 Port 就断，而插件侧不会重连 —— 于是球永久显示
     * "插件未连接"，用户唯一的出路是重启浏览器，让 Chrome 重新拉起本进程。
     *
     * 本进程的生死只该由一件事决定：Chrome 是否还留着这条 stdio（见文件末尾）。
     * 只要插件还想要这条通道，应用起没起来就只是时间问题。
     */
    created.on('close', () => {
        if (socket === created) socket = null;
        if (relay.socket === created) relay.socket = null;
        // 上一条连接的半截帧不能带进新连接
        relay.buffer = Buffer.alloc(0);
        scheduleReconnect();
    });
};

connect();

process.stdin.on('data', onStdinData);
// Chrome 关掉管道就是"该结束了"。不监听它的话本进程会变成孤儿
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
