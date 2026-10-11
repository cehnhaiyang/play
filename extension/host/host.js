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
 * 退出码 1 且写 stderr 的场景：拿不到端点信息。
 *
 * 这时候**不要静默退出**。Chrome 会把本进程的 stderr 收进扩展的错误日志，
 * 而"插件连上了但什么都没发生"是最难查的一种。宁可写一行原因。
 */
const fail = (message) => {
    process.stderr.write(`[theplay-host] ${message}\n`);
    process.exit(1);
};

const readEndpoint = () => {
    try {
        const raw = fs.readFileSync(ENDPOINT_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed?.port !== 'number' || typeof parsed?.token !== 'string') {
            fail(`端点文件格式不对：${ENDPOINT_FILE}`);
        }
        return parsed;
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            fail(`应用没有在运行（找不到 ${ENDPOINT_FILE}）。请先启动 The Play 应用。`);
        }
        fail(`读端点文件失败：${e && e.message}`);
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

const relay = {
    socket: null,
    /** 应用还没连上时，先把插件发来的消息排队 —— 丢消息比延迟更糟 */
    queue: [],
    buffer: Buffer.alloc(0),

    toExtension(message) {
        if (!this.socket) {
            this.queue.push(message);
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

const endpoint = readEndpoint();

const socket = net.createConnection({ host: '127.0.0.1', port: endpoint.port }, () => {
    // 第一行是握手：带上 token，应用据此确认这是自己的 host 而不是别的本机进程
    socket.write(`${JSON.stringify({ hello: 'theplay-host', token: endpoint.token })}\n`);
    relay.socket = socket;

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

    for (const message of relay.queue.splice(0)) {
        socket.write(`${JSON.stringify(message)}\n`);
    }
});

socket.on('data', (chunk) => relay.onData(chunk));

socket.on('error', (e) => {
    fail(`连接应用失败：${e && e.message}`);
});

/**
 * 应用退出 → 本进程也退出。
 *
 * 不这么做的话 Chrome 会一直留着一个连不上的 host，插件的 `connectNative`
 * 看起来是成功的，但每条请求都石沉大海 —— 表现为"插件里点了没反应"，
 * 而原因在另一个进程里。
 */
socket.on('close', () => {
    process.exit(0);
});

process.stdin.on('data', onStdinData);
// Chrome 关掉管道就是"该结束了"。不监听它的话本进程会变成孤儿
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
