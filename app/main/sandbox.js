'use strict';

/**
 * Agent 的本地沙箱：项目根 `sandbox/` 目录里的文件读写与精确修改。
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
 * ## 没有上限，也没有 exec
 *
 * 读文件不截断、写文件不限长。原先 read 按 32KB 截断，后果不是"少看一点"而是
 * **能力缺口**：超过 32KB 的文件模型读不全，于是无法安全地全量重写它 ——
 * 截断回传 + 全量写回 = 静默丢掉后半篇。要精确改文件，前提是先看得全。
 *
 * exec（跑本机命令）已删除，理由见 `shared/meta/type.ts` 的 SANDBOX_ACTIONS。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * 动作清单的副本。
 *
 * 真值在 `shared/meta/type.ts`，本目录只能写 CommonJS（Electron 主进程约束），
 * 解析不了 TS，与 `extension/host/host.js` 抄 `BRIDGE_PROTOCOL_VERSION` 是同一
 * 处境。**这里只用来把"未知动作"和"参数不全"分开**，不参与任何能力判断：
 * 漏掉一项的表现是那一项被当成未知动作拒掉（响亮地坏），不是静默放行。
 * 由 `test/agenttools.test.js` 逐值比对两处，漂移即报红。
 */
const SANDBOX_ACTIONS = ['list', 'read', 'write', 'delete', 'edit', 'lines', 'checkjs'];

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
 * 在文本里做一次精确替换。
 *
 * 判据是"唯一命中"：`old` 出现 0 次说明模型记错了原文（回错误、不落盘）；
 * 出现多次则说明这段文字不唯一，替换哪一处只能**猜** —— 猜错的结果是文件被改坏
 * 而回执说成功。两种都拒绝，让模型把 old 写长一点（带上前后各一行）自己收窄。
 *
 * 替换用切片而不是 `String.replace`：后者会把 `new` 里的 `$&` / `$1` 当成反向
 * 引用展开，模型写出的替换文本被静默改写 —— 这是实测踩过的坑，不是理论风险。
 */
const replaceOnce = (text, old, next) => {
    const first = text.indexOf(old);
    if (first < 0) {
        return {
            error: '没找到 old 指定的原文 —— 它必须与文件里的内容逐字一致（含缩进与换行）。'
                + '先用 read 取回当前内容，再照抄要改的那一段。',
        };
    }
    if (text.indexOf(old, first + old.length) >= 0) {
        return {
            error: 'old 在文件里出现多次，无法确定改哪一处。'
                + '请把 old 写长一些（带上前后各一行）使它唯一。',
        };
    }
    return { text: text.slice(0, first) + next + text.slice(first + old.length), replaced: 1 };
};

/**
 * 按行号区间替换。
 *
 * 行号 1 起、闭区间；`end` 省略即只替换 `start` 那一行。越界**不**静默截断到
 * 末尾 —— 那会把"改第 200 行"变成"改到了最后一行"而回执照样成功。
 *
 * 行尾风格按文件现状保留：切分时记住用的是 `\r\n` 还是 `\n`，拼回去用同一个。
 * 否则一次编辑会把整个文件的行尾统一掉，git diff 里就是全文件重写。
 */
const replaceLines = (text, start, end, next) => {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r\n|\n/);
    // 末尾换行会切出一个空元素，它不代表一行；记下来拼回去时补上
    const finalNewline = lines[lines.length - 1] === '';
    if (finalNewline) lines.pop();

    const from = start;
    const to = end ?? start;
    if (!Number.isInteger(from) || from < 1) {
        return { error: `start 必须是 ≥1 的整数行号，实际 ${JSON.stringify(start)}` };
    }
    if (!Number.isInteger(to) || to < from) {
        return { error: `end 必须 ≥ start，实际 start=${from} end=${JSON.stringify(end)}` };
    }
    if (to > lines.length) {
        return { error: `行号超出范围：该文件共 ${lines.length} 行，收到 start=${from} end=${to}` };
    }

    const merged = [...lines.slice(0, from - 1), ...next.split(/\r\n|\n/), ...lines.slice(to)];
    return {
        text: merged.join(eol) + (finalNewline ? eol : ''),
        replaced: to - from + 1,
    };
};

/**
 * 语法检查。
 *
 * 用 `vm.Script` 编译一次：**只查语法**，不执行、不解析依赖，所以 `require`
 * 一个不存在的模块照样算通过。查的是"这段 JS 能不能被解析"，不是"跑起来对不对"。
 *
 * ⚠ 因此 ESM 写法（`import` / `export`）与顶层 `await` 会被判为语法错误 ——
 * 它们在 CommonJS 脚本里确实不合法。错误原文里 Node 自己会说清是哪一种，
 * 原样回传即可，不要改写成自己的话。
 *
 * 没有走 `vm.SourceTextModule` 那一支：Electron 的 Node 24 上实测
 * `typeof vm.SourceTextModule === 'undefined'`（要额外开关），用不了。
 */
const checkSyntax = (code) => {
    try {
        new vm.Script(code, { filename: 'syntax-check.js' });
        return { valid: true };
    } catch (error) {
        /**
         * 错误类型要显式带上：`error.message` 里没有它（"Unexpected identifier 'a'"
         * 本身不说明这是语法错还是别的），而 `stack` 的第一行才有。少了它模型
         * 分不清"这段代码有语法错"与"这段代码跑起来抛了异常"。
         */
        const name = error instanceof Error ? error.name : 'Error';
        const message = error instanceof Error ? error.message : String(error);
        /**
         * 栈的前几行是「文件:行 / 源码行 / ^」，正是模型改代码要的定位信息；
         * 后面的调用栈对它没有信息量，切掉。
         */
        const stack = String(error instanceof Error ? error.stack : '');
        /**
         * 定位信息是栈**开头**那几行「文件:行 / 源码行 / ^」，到类型名那一行为止 ——
         * 类型名之后是 `at …` 调用帧，对模型改代码没有信息量。
         *
         * 不能反过来用 `\nSyntaxError` 当结束锚：实测那份栈里类型名只出现在
         * 首行（`syntax-check.js:3`），锚不到，行号就一起丢了。
         */
        const where = [];
        for (const line of stack.split('\n')) {
            if (/^\w*Error\b/.test(line) || /^\s+at /.test(line)) break;
            where.push(line);
        }
        const at = where.join('\n').trim();
        return { error: at ? `${name}: ${message}\n${at}` : `${name}: ${message}` };
    }
};

/**
 * 执行一次沙箱动作。
 *
 * `root` 由调用方（main.js）传入，且只有一个调用口径 —— 这里不自己算项目根，
 * 那样落点就会有两份（`app.getAppPath()` 与这里的拼接），打包后的只读 asar
 * 问题就必须修两处。
 *
 * ## 先判动作，再判路径
 *
 * 顺序是有意的：动作写错时要回「未知 action：…（可用 …）」，而路径检查在前
 * 会把一个拼错的动作名报成「路径不合法：(空)」—— 模型据此去改 path，
 * 而真正错的是 action，改 path 永远好不了。未知动作是**最外层**的判据。
 */
const handle = async (request, root) => {
    const action = String(request?.action || '');
    if (!SANDBOX_ACTIONS.includes(action)) {
        return { error: `未知 action：${action || '(空)'}（可用 ${SANDBOX_ACTIONS.join(' / ')}）` };
    }

    try {
        await fs.promises.mkdir(root, { recursive: true });

        /**
         * checkjs 只吃 content，不碰文件系统 —— 所以不需要路径，也不解析它：
         * 模型想"先查语法再决定写哪"时不必先造一个文件出来。
         */
        if (action === 'checkjs') {
            const code = typeof request?.content === 'string' ? request.content : '';
            if (!code.trim()) return { error: '缺少 content（checkjs 要检查的 JS 源码）' };
            return checkSyntax(code);
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
            // 不截断：截了模型就改不了超过上限的文件（见文件头的"没有上限"）
            return { content: buf.toString('utf8'), bytes: buf.length };
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

        /**
         * edit 与 lines 都**必须先把原文件读进来**：改动是在旧内容上做的，
         * 而回写用的是 `writeFile` 整体覆盖 —— 所以这两个动作只对已存在的文件
         * 有意义，读不到就如实报 ENOENT（模型据此改用 write 建新文件）。
         */
        if (action === 'edit') {
            const old = typeof request?.old === 'string' ? request.old : '';
            if (!old) {
                return {
                    error: '缺少 old（要被替换掉的原文）。要新建或整份覆盖请用 write。',
                };
            }
            const next = typeof request?.new === 'string' ? request.new : '';
            const current = await fs.promises.readFile(target, 'utf8');
            const done = replaceOnce(current, old, next);
            if (done.error) return { error: done.error };
            await fs.promises.writeFile(target, done.text, 'utf8');
            return { bytes: Buffer.byteLength(done.text, 'utf8'), replaced: done.replaced };
        }

        if (action === 'lines') {
            if (typeof request?.content !== 'string') {
                return {
                    error: '缺少 content（lines 要写入该行区间的新文本；删掉这些行就传空串）',
                };
            }
            const current = await fs.promises.readFile(target, 'utf8');
            const done = replaceLines(current, request?.start, request?.end, request.content);
            if (done.error) return { error: done.error };
            await fs.promises.writeFile(target, done.text, 'utf8');
            return { bytes: Buffer.byteLength(done.text, 'utf8'), replaced: done.replaced };
        }

        // 上面的分支已穷尽 SANDBOX_ACTIONS；走到这里说明清单加了一项而没人实现
        return { error: `动作 ${action} 已在清单里，但主进程没有实现它` };
    } catch (error) {
        /*
         * fs 的失败原样回传。ENOENT / EISDIR / ENOTEMPTY 正是模型下一步改参数的
         * 依据，换成一句"操作失败"它只能瞎猜，而猜是要付调用费的。
         */
        return { error: error instanceof Error ? error.message : String(error) };
    }
};

module.exports = {
    SANDBOX_ACTIONS,
    resolveSandboxPath,
    replaceOnce,
    replaceLines,
    checkSyntax,
    handle,
};
