'use strict';

/**
 * 应用侧的桥：监听 native messaging host 的连接，把请求转给插件。
 *
 * ## 方向是反的，这一点决定了整个文件的结构
 *
 * 直觉上"应用连插件"更自然，但 Chrome 不允许：`connectNative` 只有扩展能调，
 * 而且 host 进程是 **Chrome 拉起的**，它的 stdin/stdout 属于 Chrome。
 * 所以实际链路是：
 *
 *     扩展 SW ──connectNative──▶ host.js（Chrome 的子进程）
 *                                      │  TCP + token
 *                                      ▼
 *                                  本文件（应用主进程）
 *
 * 也就是说**本文件是服务端**：起一个 127.0.0.1 上的监听，等 host.js 连进来。
 *
 * ## 为什么请求也要从这里发出去
 *
 * 球（Electron 窗口）要拿嗅探结果、要驱动 Agent，而这些数据在插件里。
 * 球 → preload → 本文件 → host.js → 插件 SW，回答沿原路返回。
 * 本文件因此是**双向**的：既能收 host 推来的事件，也能发请求过去。
 *
 * ## token 防的是什么
 *
 * 127.0.0.1 上的端口，本机**任何**进程都能连。没有 token 的话，随便一个
 * 本机程序连上来就能假冒插件、读到 Agent 的对话内容。token 每次启动重新生成，
 * 写进用户目录（权限跟随用户），只有能读到那个文件的本机进程才连得上。
 * 这不是密码学意义上的强隔离，但把"任何本机进程"收窄成"同一用户下的进程"，
 * 而那正是我们信任的边界。
 */

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/** 与 host.js 约定的路径。改这里必须同时改那边 */
const endpointDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'the-play',
);
const endpointFile = path.join(endpointDir, 'bridge-endpoint.json');

/** 一条请求等多久算超时。模型调用可能几分钟，所以给得宽 */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/* ========================================================================== */
/* 1. 状态                                                                    */
/* ========================================================================== */

/** host 连上来的那条 socket。同一时刻只应有一条 */
let hostSocket = null;
/** 累积缓冲。TCP 不保证一次 data 正好一行，必须自己切 */
let buffer = Buffer.alloc(0);

/** 请求 id → 等待者 */
const pending = new Map();

/** 插件推来的事件订阅者 */
const eventListeners = new Set();

/**
 * 插件发来的请求的处理者。
 *
 * 方向在这里**反过来**：应用向插件要东西走 `request()`，插件向应用要东西
 * （读设置就是一条）走这里。两条方向共用同一套信封 `{ id, method, params }`，
 * 但没有就"谁处理"这一问题共享任何一份表 —— 端点归属在
 * `shared/meta/bridge.ts`，由 `test/bridge.test.js` 逐条比对主进程真实的注册。
 */
let requestHandler = null;

/** 状态变化订阅者（球要知道"插件连上没有"） */
const statusListeners = new Set();

let nextId = 1;
const newId = () => `app-${Date.now().toString(36)}-${(nextId += 1).toString(36)}`;

const notifyStatus = () => {
    const connected = !!hostSocket;
    for (const listener of statusListeners) {
        try {
            listener(connected);
        } catch {
            // 一个订阅者出错不该影响别的
        }
    }
};

/* ========================================================================== */
/* 2. 收发                                                                    */
/* ========================================================================== */

const writeLine = (payload) => {
    if (!hostSocket) return false;
    try {
        hostSocket.write(`${JSON.stringify(payload)}\n`);
        return true;
    } catch {
        return false;
    }
};

/**
 * 向插件发一条请求。
 *
 * 插件没连上时**立刻失败**，不排队。理由：桥是"插件在跑"的标志，
 * 没连上说明用户没开浏览器或者插件没装 —— 排队只会让界面转圈到超时，
 * 而真正的原因（插件不在）当场就能说清楚。
 */
const request = (method, params) => {
    if (!hostSocket) {
        return Promise.reject(new Error('插件未连接。请确认浏览器已打开、扩展已加载。'));
    }
    const id = newId();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`插件在 ${REQUEST_TIMEOUT_MS / 1000} 秒内没有回应：${method}`));
        }, REQUEST_TIMEOUT_MS);

        pending.set(id, {
            resolve: (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            },
        });

        if (!writeLine({ id, method, params })) {
            pending.delete(id);
            clearTimeout(timer);
            reject(new Error('写入插件失败（连接已断开）'));
        }
    });
};

/** 处理一行来自 host 的消息 */
const handleLine = (line) => {
    if (!line.trim()) return;
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return;
    }

    /* 握手行：host 连上来的第一句 */
    if (message.hello === 'theplay-host') {
        if (message.token !== token) {
            // token 不对：不是我们的 host（或端点文件过期）。断开而不是将就
            hostSocket?.destroy();
            return;
        }
        return;
    }

    /* 应答 */
    if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(message.error || '插件返回了失败'));
        return;
    }

    /* 推送事件 */
    if (message.event) {
        for (const listener of eventListeners) {
            try {
                listener(message.event, message.payload);
            } catch {
                // 同上：单个订阅者出错不影响其他
            }
        }
        return;
    }

    /* 插件发来的请求 */
    if (message.id && message.method) {
        handleExtensionRequest(message);
    }
};

/**
 * 处理一条插件发来的请求。
 *
 * **每一条都要回包，包括失败的那些。** 不回的话插件侧会一直等满自己的超时 ——
 * 而真正的原因可能只是一条没注册的 method，那本该当场说清楚。
 */
const handleExtensionRequest = (message) => {
    const reply = (payload) => {
        if (!writeLine({ id: message.id, ...payload })) {
            // 插件恰好在这一刻断开：没有别的补救办法，记一行以免静默丢失
            console.error('回包失败（插件连接已断开）：', message.method);
        }
    };

    if (!requestHandler) {
        reply({ ok: false, error: '应用尚未就绪（请求分派器未注册）' });
        return;
    }

    Promise.resolve()
        .then(() => requestHandler(message.method, message.params))
        .then(
            (result) => reply({ ok: true, result }),
            (error) => reply({ ok: false, error: error && error.message ? error.message : String(error) }),
        );
};

/* ========================================================================== */
/* 3. 监听                                                                    */
/* ========================================================================== */

const token = crypto.randomBytes(24).toString('hex');
let server = null;

/**
 * 起监听并把端点信息写给 host.js。
 *
 * 端口用 0 让系统分配：固定端口会和"上一次没退干净的实例"撞上，
 * 表现是 host 连到了旧进程、新进程永远收不到消息。写文件让 host 知道是哪个端口。
 */
const start = () =>
    new Promise((resolve, reject) => {
        server = net.createServer((socket) => {
            /*
             * 只留一条连接。
             *
             * 浏览器重启会拉起新的 host，旧的连接可能还没断 —— 两条同时存在时
             * "谁来收应答"就成了竞态。新连接到来即顶掉旧的。
             */
            if (hostSocket) {
                try {
                    hostSocket.destroy();
                } catch {
                    // 已经断了
                }
            }
            hostSocket = socket;
            buffer = Buffer.alloc(0);

            socket.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                for (;;) {
                    const index = buffer.indexOf(0x0a);
                    if (index < 0) return;
                    const line = buffer.subarray(0, index).toString('utf8');
                    buffer = buffer.subarray(index + 1);
                    handleLine(line);
                }
            });

            socket.on('close', () => {
                if (hostSocket === socket) {
                    hostSocket = null;
                    // 插件断了：在途请求全部失败，否则界面会一直转圈
                    for (const [, entry] of pending) {
                        entry.reject(new Error('插件连接已断开'));
                    }
                    pending.clear();
                    notifyStatus();
                }
            });

            socket.on('error', () => {
                // 'close' 会跟着来，这里不重复处理
            });

            notifyStatus();
        });

        server.on('error', reject);

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            try {
                fs.mkdirSync(endpointDir, { recursive: true });
                fs.writeFileSync(endpointFile, JSON.stringify({ port, token }, null, 2), 'utf8');
            } catch (e) {
                reject(new Error(`写端点文件失败：${e && e.message}`));
                return;
            }
            resolve({ port });
        });
    });

/**
 * 退出时把端点文件删掉。
 *
 * 不删的话，应用已经退出但 host.js 还能读到那个文件、连一个没人听的端口 ——
 * 插件的每条请求都会等满超时，而不是立刻得到"应用没在运行"。
 */
const stop = () => {
    try {
        fs.rmSync(endpointFile, { force: true });
    } catch {
        // 删不掉就算了，下次启动会覆盖
    }
    try {
        server?.close();
    } catch {
        // 已经关了
    }
    try {
        hostSocket?.destroy();
    } catch {
        // 已经断了
    }
    hostSocket = null;
};

module.exports = {
    start,
    stop,
    request,
    /**
     * 注册插件请求的分派器。主进程在启动时调一次。
     *
     * 与 `request` 是一对反向的入口：那边应用问插件，这边插件问应用。
     */
    setRequestHandler: (fn) => {
        requestHandler = fn;
    },
    /** 插件推来的事件。返回取消订阅的函数 */
    onEvent: (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
    },
    /** 桥的连通状态变化。回调立刻用当前状态调一次 */
    onStatus: (listener) => {
        statusListeners.add(listener);
        listener(!!hostSocket);
        return () => statusListeners.delete(listener);
    },
    isConnected: () => !!hostSocket,
};
