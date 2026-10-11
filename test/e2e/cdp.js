'use strict';

/**
 * 一个够用就行的 CDP 客户端。
 *
 * 为什么不装 puppeteer：这里只需要三件事 —— 开一个带扩展的 Chrome、
 * 在页面里求值、收控制台异常。puppeteer 会把一个几百 MB 的浏览器再下一遍，
 * 而本机已经有 Chrome。`ws` 是现成的依赖。
 *
 * ## 为什么不用管道读 Chrome 的 stdout
 *
 * Chrome 的日志走 stderr，而它启动后不会退出。用 `stdio: 'pipe'` 抓它的输出
 * 会把管道一直挂着，进程结束时容易卡住不返回。这里用 `stdio: 'ignore'`，
 * 所有信息都从 CDP 拿 —— 那才是结构化的那份。
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);

const findChrome = () => {
    for (const candidate of CHROME_CANDIDATES) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('找不到 Chrome。设 CHROME_PATH 环境变量指定 chrome.exe 的路径。');
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一个 HTTP GET，返回解析后的 JSON。CDP 的发现端点都是普通 HTTP */
const getJson = (url) =>
    new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new Error(`${url} 返回的不是 JSON：${body.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error(`${url} 超时`)));
    });

/** 建一个标签页。CDP 的 `/json/new` 只接受 PUT */
const putJson = (url) =>
    new Promise((resolve, reject) => {
        const req = http.request(url, { method: 'PUT' }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new Error(`PUT ${url} 返回的不是 JSON：${body.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });

/**
 * 一个 CDP 会话。
 *
 * `events` 收集所有事件，`send` 是一条命令。没有实现 sessionId 多路复用 ——
 * 这里的用法是"一个目标一条连接"，用不到。
 */
class Session {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.events = [];
        this.listeners = new Set();

        ws.on('message', (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (message.id !== undefined) {
                const entry = this.pending.get(message.id);
                if (!entry) return;
                this.pending.delete(message.id);
                if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
                else entry.resolve(message.result);
                return;
            }
            this.events.push(message);
            for (const listener of this.listeners) listener(message);
        });
    }

    static async connect(wsUrl) {
        const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
        });
        return new Session(ws);
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, method });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    onEvent(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** 在页面主世界求值。返回值直接是 JS 值（不开 returnByValue 拿不到） */
    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            const detail = result.exceptionDetails.exception?.description
                || result.exceptionDetails.text
                || '求值抛出异常';
            throw new Error(detail);
        }
        return result.result?.value;
    }

    /**
     * 在**指定的执行上下文**里求值。
     *
     * content script 跑在隔离世界，`Runtime.evaluate` 默认落在主世界 ——
     * 要读 `chrome.runtime` 就必须点名隔离世界的 executionContextId。
     */
    async evaluateIn(contextId, expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            contextId,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            const detail = result.exceptionDetails.exception?.description
                || result.exceptionDetails.text
                || '求值抛出异常';
            throw new Error(detail);
        }
        return result.result?.value;
    }

    /** 等一个事件，或超时返回 null */
    waitFor(predicate, timeoutMs) {
        const hit = this.events.find(predicate);
        if (hit) return Promise.resolve(hit);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.listeners.delete(listener);
                resolve(null);
            }, timeoutMs);
            const listener = (message) => {
                if (!predicate(message)) return;
                clearTimeout(timer);
                this.listeners.delete(listener);
                resolve(message);
            };
            this.listeners.add(listener);
        });
    }

    close() {
        try {
            this.ws.close();
        } catch {
            // 已经关了
        }
    }
}

/**
 * 启动一个装了扩展的 Chrome。
 *
 * `--headless=new` 支持扩展（旧的 `--headless` 不支持）。但 headless 下
 * `chrome.debugger` 与部分 UI 相关行为未必与有头一致，所以保留 `headless: false`
 * 的开关，由调用方决定。
 */
const launch = async ({ port = 9333, headless = true, extraArgs = [] } = {}) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-play-e2e-'));
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        `--no-first-run`,
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        /*
         * Translate / OptimizationHints 会在启动时抢网络与首帧，
         * 让"等一会儿再看 DOM"这类时序不稳。
         */
        '--disable-features=Translate,OptimizationHints',
        /*
         * `--enable-unsafe-extension-debugging` 是 `Extensions.loadUnpacked`
         * 的前置条件，必须留着。
         *
         * 曾经这里用的是 `--load-extension` —— 那条路在 Chrome 137 起被**静默**
         * 关掉了：命令行照收，扩展不装，不报错也不提示。代价是整套断言都在
         * "扩展根本不存在"的前提下跑，全绿而毫无意义。见 loadExtension。
         */
        '--enable-unsafe-extension-debugging',
    ];
    if (headless) args.push('--headless=new');
    args.push(...extraArgs);

    const child = spawn(findChrome(), args, { stdio: 'ignore', windowsHide: true });

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30000;
    let version = null;
    while (Date.now() < deadline) {
        try {
            version = await getJson(`${base}/json/version`);
            break;
        } catch {
            await sleep(200);
        }
    }
    if (!version) {
        child.kill();
        throw new Error('Chrome 没能在 30 秒内起来');
    }

    return {
        child,
        base,
        version,
        userDataDir,
        /** 当前所有目标 */
        targets: () => getJson(`${base}/json/list`),
        newTab: (url) => putJson(`${base}/json/new?${encodeURIComponent(url)}`),
        /**
         * 装一个未打包扩展，返回它的扩展 id。
         *
         * 这是 Chrome 137 之后唯一还能用的加载方式。`Extensions.loadUnpacked`
         * 只在**浏览器级**会话上有效（页面的 ws 上发会报 method not found），
         * 所以这里现开一条浏览器级连接，用完就关。
         *
         * 连接要留着还是关掉？关掉。浏览器级会话断开**不会**卸载扩展 ——
         * 装上是进程内的持久状态，而留着一条空闲连接只会让 close() 多一个
         * 要清理的东西。
         */
        loadExtension: async (extensionPath) => {
            const session = await Session.connect(version.webSocketDebuggerUrl);
            try {
                const res = await session.send('Extensions.loadUnpacked', { path: extensionPath });
                return res.id;
            } finally {
                session.close();
            }
        },
        close: async () => {
            try {
                child.kill();
            } catch {
                // 已经退出了
            }
            // Windows 上 kill 之后句柄不会立刻释放，删不掉就留着
            await sleep(300);
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {
                // 忽略
            }
        },
    };
};

/** 等一个目标出现，按 type 与可选的 url 前缀过滤 */
const waitForTarget = async (browser, predicate, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const list = await browser.targets();
        const hit = list.find(predicate);
        if (hit) return hit;
        await sleep(200);
    }
    return null;
};

module.exports = { Session, launch, waitForTarget, sleep, findChrome, getJson };
