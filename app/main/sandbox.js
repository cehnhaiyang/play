'use strict';

/**
 * Agent 的本地沙箱：项目根 `sandbox/` 目录里的文件读写与命令执行。
 *
 * ## 为什么单独一个文件
 *
 * 边界判据（哪个路径算越界）必须**可被直接调用验证**。留在 main.js 里就测不到 ——
 * main.js require 了 electron，Node 里加载不动它，于是"越界会不会被拦"只剩
 * 一句源码断言，而源码断言证明不了判据本身（见 §5.4 的教训：把判据换成恒假，
 * 只 grep 源码的测试全绿）。
 *
 * ## 为什么这条边界由这里守，而不是插件侧
 *
 * 插件只能"说它传了什么路径"。校验放在发起方等于让被约束的一方自证清白。
 * 沙箱根与越界判定只在**执行者**这一侧算，一次。
 *
 * ## 上限的三个数字
 *
 * 值是 `shared/meta/type.ts` 里同名三份的副本，**不是另一套真值** —— 本目录只能
 * 写 CommonJS（Electron 主进程约束），解析不了 TS，与 `extension/host/host.js`
 * 抄 `BRIDGE_PROTOCOL_VERSION` 是同一处境。由 `test/bridge.test.js` 逐条比对
 * 两处数字，漂移即报红。
 *
 * `SANDBOX_TEXT_LIMIT_BYTES` 必须在这里截：引擎对非 js 工具的回传值**不做二次
 * 截断**（见 extension/src/agent/transcript.ts），生产端漏截就等于把整份文件
 * 灌进模型上下文。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SANDBOX_TEXT_LIMIT_BYTES = 32768;
const SANDBOX_EXEC_TIMEOUT_DEFAULT_MS = 120000;
const SANDBOX_EXEC_TIMEOUT_MAX_MS = 600000;

/**
 * 相对路径 → 沙箱内的绝对路径。越界返回 null。
 *
 * 判据是**段级黑名单**而不是"解析完再比对前缀"：后者在符号链接下会放行一个
 * 指向沙箱外的路径。这里只认 `/` 与 `\` 分隔，出现 `..`、绝对路径或盘符一律
 * 拒绝 —— 沙箱不需要花活。`.` 与空段吸收掉；整串都是 `.` 时解析到沙箱根本身。
 */
const resolveSandboxPath = (root, raw) => {
    const text = String(raw || '');
    if (!text.trim()) return null;
    if (path.isAbsolute(text) || /^[a-zA-Z]:/.test(text)) return null;

    const segments = text.split(/[/\\]+/).filter((s) => s && s !== '.');
    if (segments.some((s) => s === '..')) return null;
    /**
     * 全是 `.` 的写法（`.` / `./`）解析到沙箱根本身。
     *
     * 不能拒：模型问"沙箱里有什么"时最自然的就是 `{"action":"list","path":"."}`，
     * 拒了它会以为沙箱是坏的或自己拼错了，而不是改用空 path。
     */
    if (segments.length === 0) return root;

    const target = path.join(root, ...segments);
    // 拼接后再确认一次：防的是段检查漏掉的怪写法
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return target;
};

/**
 * 按字节截断 UTF-8 文本。
 *
 * 截点必须落在**完整字符**的边界上。只回退后续字节（0x80-0xBF）不够：切在多字节
 * 字符的最后一个后续字节之后，留下的是一个孤零零的前导字节 —— 实测
 * `clipToBytes('中文…', 5)` 就停在 '中' 之后的 '文' 前导字节上，解出来带一个
 * U+FFFD，而那是"原始字节已丢失、无法还原"的标记；把这种文本回灌给模型
 * 等于亲手损坏它的产物。
 *
 * 判据是"尾部那一段凑不凑得成一个完整字符"：数清末尾连续的后续字节，
 * 再看它们前面那个前导字节声明的长度够不够。
 */
const clipToBytes = (text, limit) => {
    if (Buffer.byteLength(text, 'utf8') <= limit) return { text, truncated: false };
    const buf = Buffer.from(text, 'utf8').subarray(0, limit);

    let end = buf.length;
    let trail = 0;
    while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) { end -= 1; trail += 1; }
    if (end > 0) {
        const lead = buf[end - 1];
        const want = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
        // 前导字节 + 后续字节凑不满它声明的长度 → 断字符，整段丢掉
        if (want > trail + 1) end -= 1;
    }
    return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
};

/**
 * 杀掉整棵进程树。
 *
 * Windows 没有进程组，`child.kill()` 只作用于 shell 本身，孙子进程（shell 起的
 * 那个真正的命令）会留下 —— 只能靠 `taskkill /T` 递归。POSIX 侧配合 `detached`
 * 用**负 pid** 杀整个进程组。
 */
const killTree = (child) => {
    if (!child.pid) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch {
        // 兜底：至少把 shell 自己杀掉。已经消失的进程在这里抛 ESRCH，不用管
        try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
    }
};

/**
 * 跑一条命令。
 *
 * **用 spawn 而不是 exec**：exec 的 `timeout` 只杀它自己拉起的 shell，杀不掉孙子
 * 进程。实测踩过：`ping -n 30` 超时后仍在跑，而回给模型的文案写着"已强制终止"，
 * 那是句假话 —— 模型会以为机器干净，接着起第二条，而沙箱目录还被上一个占着
 * （连临时目录都删不掉）。进程树必须自己管。
 *
 * shell 由 Node 按平台选（Windows 是 cmd.exe，POSIX 是 /bin/sh）；提示词里
 * 不承诺具体 shell，模型按它所在的本机写。
 */
const runCommand = (command, root, timeout) => new Promise((resolve) => {
    const child = spawn(command, {
        cwd: root,
        shell: true,
        // POSIX 下独立成组，超时才能连孙子一起杀（见 killTree）
        detached: process.platform !== 'win32',
        windowsHide: true,
    });

    let out = '';
    let err = '';
    let timedOut = false;
    // 采集上限给到回传上限的 2 倍：再多的部分回传给模型也是截掉的，留着只占内存
    const cap = SANDBOX_TEXT_LIMIT_BYTES * 2;
    const take = (chunk, sink) => {
        if (sink.length < cap) sink += chunk.toString('utf8');
        return sink;
    };

    child.stdout.on('data', (c) => { out = take(c, out); });
    child.stderr.on('data', (c) => { err = take(c, err); });

    const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
    }, timeout);

    const done = (exitCode) => {
        clearTimeout(timer);
        resolve({
            exitCode,
            timedOut,
            text: `${out}${err ? `\n${err}` : ''}`,
        });
    };

    // 起不来（shell 不存在）只抛 error 事件，不会有 exit
    child.on('error', () => done(-1));
    // 被信号杀掉时 code 为 null：按 1 报，与 shell 的常规失败同形，
    // 而"是不是超时"由 timedOut 单独回答，不靠这个数猜
    child.on('close', (code) => done(code === null ? 1 : code));
});

/**
 * 执行一次沙箱动作。
 *
 * `root` 由调用方（main.js）传入，且只有一个调用口径 —— 这里不自己算项目根，
 * 那样落点就会有两份（`app.getAppPath()` 与这里的拼接），打包后的只读 asar
 * 问题就必须修两处。
 */
const handle = async (request, root) => {
    const action = String(request?.action || '');

    try {
        await fs.promises.mkdir(root, { recursive: true });

        if (action === 'exec') {
            const command = String(request?.command || '');
            if (!command.trim()) return { error: '缺少 command（action 为 exec 时必须给）' };

            const timeout = Math.min(
                Number(request?.timeout) || SANDBOX_EXEC_TIMEOUT_DEFAULT_MS,
                SANDBOX_EXEC_TIMEOUT_MAX_MS,
            );
            const output = await runCommand(command, root, timeout);
            const clipped = clipToBytes(output.text, SANDBOX_TEXT_LIMIT_BYTES);

            if (output.timedOut) {
                return {
                    exitCode: output.exitCode,
                    timedOut: true,
                    output: clipped.text,
                    error: `命令超过 ${Math.round(timeout / 1000)} 秒未结束，已强制终止。`
                        + `请把任务拆小，或显式传更长的 timeout（上限 ${SANDBOX_EXEC_TIMEOUT_MAX_MS / 1000} 秒）。`,
                };
            }
            return {
                exitCode: output.exitCode,
                output: clipped.text + (clipped.truncated ? '\n…（输出已截断）' : ''),
            };
        }

        const target = resolveSandboxPath(root, request?.path);
        if (!target) {
            return {
                error: `路径不合法：${String(request?.path || '(空)')}。`
                    + '只能用 sandbox 目录内的相对路径，不允许 .. / 绝对路径 / 盘符。',
            };
        }

        if (action === 'list') {
            const dirents = await fs.promises.readdir(target, { withFileTypes: true });
            const entries = await Promise.all(dirents.map(async (d) => {
                const isDir = d.isDirectory();
                return {
                    // 目录带尾斜杠：模型据此决定下一步 read 还是 list，
                    // 不带就得先 list 一层试探，白走一步
                    name: d.name + (isDir ? '/' : ''),
                    dir: isDir,
                    size: isDir ? 0 : (await fs.promises.stat(path.join(target, d.name))).size,
                };
            }));
            return { entries };
        }

        if (action === 'read') {
            const buf = await fs.promises.readFile(target);
            const clipped = clipToBytes(buf.toString('utf8'), SANDBOX_TEXT_LIMIT_BYTES);
            return {
                content: clipped.text
                    + (clipped.truncated ? '\n…（内容已截断，用 exec 配筛选命令只取需要的部分）' : ''),
                bytes: buf.length,
            };
        }

        if (action === 'write') {
            const content = typeof request?.content === 'string' ? request.content : '';
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            await fs.promises.writeFile(target, content, 'utf8');
            return { bytes: Buffer.byteLength(content, 'utf8') };
        }

        if (action === 'delete') {
            // 不递归：删目录会失败并如实报 ENOTEMPTY。让模型一键抹掉整棵子树
            // 不是沙箱该有的能力
            await fs.promises.rm(target);
            return { deleted: path.relative(root, target).replace(/\\/g, '/') };
        }

        return { error: `未知 action：${action || '(空)'}` };
    } catch (error) {
        /*
         * fs 的失败原样回传。ENOENT / EISDIR / ENOTEMPTY 正是模型下一步改参数的
         * 依据，换成一句"操作失败"它只能瞎猜，而猜是要付调用费的。
         */
        return { error: error instanceof Error ? error.message : String(error) };
    }
};

module.exports = {
    SANDBOX_TEXT_LIMIT_BYTES,
    SANDBOX_EXEC_TIMEOUT_DEFAULT_MS,
    SANDBOX_EXEC_TIMEOUT_MAX_MS,
    resolveSandboxPath,
    clipToBytes,
    handle,
};
