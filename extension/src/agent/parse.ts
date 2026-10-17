/**
 * 模型回复与工具结果的解析。
 *
 * 这里的每个判据都对应一类"看错就整轮跑偏"的失效：
 * 抠 JSON 抠不准 → 明明调了工具却判成协议错误；
 * 成败判据写错 → 一次成功的数据探测被标成失败，模型对着成功结果修 bug。
 */

import { asString, errorText } from './text';

/**
 * 回复不合协议时的**具体**原因。
 *
 * 只说一句"没有工具调用也没有 final"，模型无从下手 —— 它自认为写的是合法
 * JSON，于是下一次原样再来一遍，实测连撞三次就把整个会话撞停了（见
 * MAX_PROTOCOL_ERRORS）。判据必须细到能回答"错在哪一步"：通篇没写 JSON、
 * 被输出长度截断、JSON 语法坏了、还是 JSON 合法但少了 tool / final。
 *
 * 只依赖回复原文这一个输入（纯函数）：回灌文案在"当场"与"下一轮重建"
 * 两处必须逐字一致，而重建时手上只有存下来的那条原文。
 */
type ReplyProblem =
    /** 整条回复里连一个 `{` 都没有 —— 写成了散文 */
    | { kind: 'noJson' }
    /** JSON 没闭合。绝大多数是回复被输出长度截断 */
    | { kind: 'truncated'; detail: string }
    /** 括号闭合了但 JSON.parse 报错 */
    | { kind: 'badJson'; detail: string }
    /**
     * 顶层有 `calls`，但里面**一项可执行的调用都没有**。
     *
     * 与 noTool 分开是必须的：那种情况下"没有 calls 也没有 final"是**自相矛盾**的
     * 说法（诊断同时把 calls 列进了"顶层实际有的键"），模型照着一句错话去改，
     * 只会把已经写对的字段名再改一遍。
     */
    | { kind: 'badCalls'; detail: string }
    /** JSON 合法，顶层字段里既没有 calls 也没有 final */
    | { kind: 'noTool'; keys: string };

/**
 * 诊断一条不合协议的回复。
 *
 * 只看**第一个** `{` 起扫出来的那个对象，不像 extractJsonObject 那样把每个起点
 * 都试一遍：这里要回答的是"这条回复为什么切不出 JSON"，而模型写的那个对象总是
 * 从第一个 `{` 开始。逐起点试是给"前面有散文"用的，那是**找**对象的问题。
 */
export const diagnoseReply = (text: string): ReplyProblem => {
    const start = text.indexOf('{');
    if (start < 0) return { kind: 'noJson' };

    const { spans, inString, depth } = scanBraces(text, start);
    const self = spans.find((span) => span.start === start);

    if (!self) {
        return {
            kind: 'truncated',
            detail: inString
                ? `写到第 ${text.length} 个字符时停在一个字符串中间，JSON 从未闭合`
                : `JSON 的括号没有闭合，还差 ${depth} 个 }`,
        };
    }
    const { end } = self;

    try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];

        /*
         * calls 存在但一项都执行不了 —— 单列一种错法。
         *
         * 落到 noTool 的话回灌文案会说"没有 calls 也没有 final"，而同一句里
         * 又把 calls 列为"顶层实际有的键"：模型读到一句自相矛盾的话，只会去改
         * 一个本来就写对的字段名。这里直接说清是哪一项坏了。
         */
        if ('calls' in parsed && !asString(parsed.final)) {
            const raw = parsed.calls;
            if (!Array.isArray(raw)) {
                return { kind: 'badCalls', detail: `calls 不是数组，而是 ${typeof raw}` };
            }
            if (raw.length === 0) {
                return { kind: 'badCalls', detail: 'calls 是空数组' };
            }
            const broken = raw.findIndex((item) => (
                !item || typeof item !== 'object' || Array.isArray(item) || !asString((item as Record<string, unknown>).tool)
            ));
            if (broken >= 0) {
                return { kind: 'badCalls', detail: `第 ${broken + 1} 项没有 tool 字段（每项都必须写工具名）` };
            }
        }

        return { kind: 'noTool', keys: keys.length ? keys.join('、') : '(空对象)' };
    } catch (e) {
        /*
         * V8 的报错里带 "at position N"，那是**相对这个对象**的偏移。
         * 换算回整条回复的偏移并把出错位置附近的原文抄出来 —— 只报一句
         * "JSON 解析失败"，模型还是得自己逐字找那个引号。
         */
        const message = errorText(e);
        const at = /position (\d+)/.exec(message);
        if (!at) return { kind: 'badJson', detail: message };
        const offset = start + Number(at[1]);
        const near = text.slice(Math.max(0, offset - 30), offset + 30).replace(/\n/g, '\\n');
        return {
            kind: 'badJson',
            detail: `${message}（整条回复的第 ${offset} 个字符附近。原文：…${near}…）`,
        };
    }
};

/**
 * 从 `start` 起做字符串感知的括号扫描，一遍扫出**全部**平衡对象的跨度。
 *
 * 不能用正则匹配花括号 —— 脚本源码里必然含 `{ }` 与字符串，只有字符串感知的
 * 括号计数才能切准边界。返回按起点升序的跨度，以及扫到结尾时的状态
 * （还在字符串里 / 还差几层），后者供诊断文案区分"截断"与"括号不配对"。
 *
 * ## 为什么必须是一遍
 *
 * `extractJsonObject` 要把每个 `{` 都当起点试一次，而逐个起点现扫会一直走到
 * 文本结尾 —— 复杂度于是变成 O(起点数 × 长度)。实测一份被截断的 1.4MB 回复
 * （96003 个 `{`）要 990ms，而"回复被截断"恰恰是"这一步写的代码太大"的必然
 * 结果，两者总是同时发生，正好卡在最需要快速给出错误文案的时刻。括号配对是
 * 栈的教科书用例，一遍扫完即可。
 *
 * 字符串感知也顺带修正了一处旧行为：从一个**字符串内部**的 `{` 起扫，会把那段
 * 字符串当成 JSON 解析（`他说"{"a":1}"` 会解析出 `{"a":1}`）—— 那不是回复本身。
 */
const scanBraces = (
    text: string,
    start: number,
): { spans: { start: number; end: number }[]; inString: boolean; depth: number } => {
    const open: number[] = [];
    const spans: { start: number; end: number }[] = [];
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }

        if (ch === '"') inString = true;
        else if (ch === '{') open.push(i);
        else if (ch === '}' && open.length > 0) spans.push({ start: open.pop() as number, end: i });
    }

    // 栈是后进先出的，跨度因此按**闭合**顺序产生；起点升序才是"逐个起点试"的顺序
    return { spans: spans.sort((a, b) => a.start - b.start), inString, depth: open.length };
};

/**
 * 从模型回复里抠出第一个能解析的**平衡** JSON 对象。
 *
 * 不能只看第一个 `{` —— 模型常在 JSON 前写一句"我的计划是…"，那个花括号不是
 * 起点，因此每个 `{` 都当起点试一次，解析成功即返回。
 */
export const extractJsonObject = (text: string): Record<string, unknown> | null => {
    if (!text) return null;

    // 起点全部收集：intent 或代码里花括号再多也不能让外层 JSON 的起点被截掉。
    // 曾经限制过起点数量，后果是"回复里示例代码多写几个 { }，真正的调用就解析不到"。
    for (const { start, end } of scanBraces(text, 0).spans) {
        try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            /* 这个起点不是合法 JSON，换下一个 */
        }
    }
    return null;
};

/**
 * 一次回复里的工具调用。**唯一权威**是 `calls` 数组。
 *
 * 解析与执行都只读这一个字段：另留一条 `{"tool":…,"args":…}` 的单数通道看着
 * 无害，实际会让"一个回复里到底能发几个调用"有两个答案 —— 主循环读哪个、
 * 提示词写哪个、历史怎么回放，三处各自漂移，而漂移的症状是**静默丢掉后半批**。
 * 写错字段名的模型会收到协议错误回执，那比猜它想调什么便宜。
 */
interface AgentCall {
    tool: string;
    args: Record<string, unknown>;
}

/**
 * 一条回复里最多执行几个工具调用。
 *
 * 上限的理由是**成本**：一批的实际代价是各次观察之和，而它们会随后续每一步
 * 重发。截断而不是报错 —— 前几条通常已经做完了事，丢掉它们等于白跑。
 *
 * **权威在本文件**（判据 extractCalls 就在这里），提示词那边 import 它去插值：
 * 反过来的话 prompt → transcript → parse → prompt 会成环。
 */
export const MAX_CALLS_PER_REPLY = 8;

/**
 * 从回复里取出本批要执行的调用，顺序即模型写的顺序。
 *
 * 三条判据各有理由：
 *  - **坏的一项不拖垮整批**：缺 tool 名的那一项只是被跳过（调用处发现列表为空
 *    就按协议错误回灌），而不是把已经写对的几项一起丢掉 —— 后者会让模型以为
 *    "整条回复白写了"，于是把同一批原样再发一次。
 *  - **args 缺失归一成 `{}`**：工具层对缺参数有自己的错误文案（"缺少 code"
 *    比"args 不是对象"更能让它一步改对）。
 *  - **上限 MAX_CALLS_PER_REPLY 条**：理由见那个常量，截断而不是报错。
 *
 * 同时回传 `written`（模型这一批写了几个）—— 截断与跳过都是**静默**的，
 * 不回传的话模型看到的结果比它写的少，只会以为工具坏了，然后把同一批再发一遍。
 */
export const extractCalls = (
    reply: Record<string, unknown> | null,
): { calls: AgentCall[]; written: number } => {
    const raw = reply?.calls;
    if (!Array.isArray(raw)) return { calls: [], written: 0 };

    const calls: AgentCall[] = [];
    for (const item of raw.slice(0, MAX_CALLS_PER_REPLY)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const entry = item as Record<string, unknown>;
        const tool = asString(entry.tool);
        if (!tool) continue;
        const args = entry.args;
        calls.push({
            tool,
            args: args && typeof args === 'object' && !Array.isArray(args)
                ? (args as Record<string, unknown>)
                : {},
        });
    }
    return { calls, written: raw.length };
};

/**
 * 解析工具返回的那个 JSON 对象；不是对象（含解析失败）就返回 null。
 *
 * 两个成败判据共用这一步：它们只在"什么样的 error 才算失败"上分岔，
 * 而"结果是不是一个可解析的对象"是同一个问题。分头解析的话，一处改成
 * 容忍数组、另一处没改，两个工具就会对同一种返回给出相反的结论。
 */
const parseToolResult = (result: string): Record<string, unknown> | null => {
    if (!result.startsWith('{')) return null;
    try {
        const parsed = JSON.parse(result);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
};

/**
 * 工具结果是否为错误。
 *
 * 不能用 `result.startsWith('{"error"')` —— 脚本正常返回
 * `{"error": null, "data": [...]}` 是合法值，按前缀判会被标成失败。
 * 必须解析出来看：**含 error 字段且它是非空字符串**才算错。
 *
 * 只管 tamper / storage / tokens / sandbox / navigate：它们的错误对象**只可能**
 * 由我们构造，所以 `{error}` 就是失败。js 不适用 —— 它的返回值是页面数据，
 * 判据见 isJsErrorResult。
 */
export const isErrorResult = (result: string): boolean => {
    const parsed = parseToolResult(result);
    if (!parsed) return false;
    if (typeof parsed.__agentError === 'string' && parsed.__agentError.length > 0) return true;
    return typeof parsed.error === 'string' && parsed.error.length > 0;
};

/**
 * js 脚本执行是否失败。
 *
 * **只认 `__agentError`。** 那是执行器与 dispatchTool 专用的失败通道（脚本抛错 /
 * 返回值不可序列化 / 缺 code）。页面返回值里的 `error` 字段一律不算失败 ——
 * 它是**探测到的业务数据**，`{"error":"invalid token"}` 是最常见的接口响应之一。
 *
 * 曾经按"error 是唯一键就当参数错误"来分辨这两者：那条规则对单键业务错误必然
 * 猜错，把一次成功的数据探测标成失败，模型于是对着成功的结果去"修正参数"。
 * 现在两边各走一条通道（见 tools.ts 的 js 分支），判据不需要猜。
 */
export const isJsErrorResult = (result: string): boolean => {
    const parsed = parseToolResult(result);
    if (!parsed) return false;
    return typeof parsed.__agentError === 'string' && parsed.__agentError.length > 0;
};

/** 解析存储快照；坏了就返回空对象，不让一个坏键毁掉整个 tokens find */
export const safeParseObject = (raw: string): Record<string, unknown> => {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
};

/** 包装前缀。为什么必须包这一层，见 buildScriptSource */
const PREFIX = `(async () => {
  let __v;
  try {
    __v = await (async () => {
`;

/**
 * 模型代码在包装后的源码里从第几行开始（1 起）。
 *
 * 由 PREFIX 现算而不是写死 5：模板哪怕只多一行注释，换算出的行号就整体偏了，
 * 而它正是模型用来定位自己代码的唯一依据。
 */
const CODE_LINE_OFFSET = PREFIX.split('\n').length - 1;

/**
 * 把执行器回的失败结果换成一句**带位置**的说明。
 *
 * V8 给的 `Unexpected token ')'` 不带任何位置，模型只能自己重读整段代码，
 * 而它往往读不出来（实测：漏一个闭合大括号，连撞多次都以为问题在别处）。
 * CDP 的 `exceptionDetails` 里其实带着行列号，但那是**包装后**的行号，
 * 直接给模型只会让它去数包装层。这里换算回模型自己写的行，并把那一行抄出来。
 *
 * 只处理语法错误：运行时异常的位置信息对模型没有额外价值（它知道自己在哪一步抛的），
 * 而语法错误没有位置就完全无法自查。
 *
 * 拿不到位置时原样返回 —— 宁可少说，也不要报一个错的坐标。
 */
export const locateScriptError = (result: string, code: string): string => {
    /*
     * 先看有没有 `__agentError` 再解析。
     *
     * 这个函数在**每一个** js 结果上跑一次，而绝大多数结果是正常数据 ——
     * 对 1.2MB 的正常返回值做一次完整 JSON.parse 要 8.5ms，而查一个子串是 1.1ms
     * （实测）。没有那个字段时解析出来的东西一行都用不上。
     */
    if (!result.includes('__agentError')) return result;

    let parsed: Record<string, unknown>;
    try {
        const value = JSON.parse(result) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
        parsed = value as Record<string, unknown>;
    } catch {
        return result;
    }

    const detail = parsed.__agentError;
    const at = parsed.__agentAt as { line?: unknown; column?: unknown } | undefined;
    if (typeof detail !== 'string' || !at || typeof at.line !== 'number') return result;

    const line = at.line - CODE_LINE_OFFSET;
    const lines = code.split('\n');
    const source = line >= 1 && line <= lines.length ? lines[line - 1] : '';
    const column = typeof at.column === 'number' ? at.column : 0;

    const where = source
        ? `\n出错在你写的第 ${line} 行：\n${source}\n${' '.repeat(Math.max(0, column))}^`
        : `\n位置换算后落在你的代码之外（第 ${line} 行，共 ${lines.length} 行），`
            + '多半是某个括号或引号没有配对。';

    // 只改 __agentError 这一条，其余字段（__agentAt）不再回传给模型
    const next: Record<string, unknown> = { ...parsed, __agentError: `${detail}${where}` };
    delete next.__agentAt;
    return JSON.stringify(next);
};

/**
 * 把模型给的代码包成可返回值的异步 IIFE。
 *
 * 包一层的必要性：模型写的是脚本片段（含 `return`），裸求值里顶层 `return` 是
 * 语法错误；同时返回值必须自己序列化 —— `Runtime.evaluate` 对 DOM 节点、
 * 循环引用这类不可序列化的值会直接抛错或回传空对象。
 */
export const buildScriptSource = (code: string): string => `${PREFIX}${code}
    })();
  } catch (__err) {
    // 基础设施失败走专属通道 __agentError：页面接口正常返回 {error:"..."}
    // 是合法数据，不能与"脚本抛错"混用同一个 error 字段，否则 isJsErrorResult
    // 会把一次成功的数据探测误判成工具失败，模型对着成功的结果修 bug。
    return JSON.stringify({ __agentError: String(__err && __err.message || __err) });
  }
  try {
    if (__v === undefined) return 'null';
    const __s = JSON.stringify(__v);
    return __s === undefined ? JSON.stringify(String(__v)) : __s;
  } catch (__e) {
    return JSON.stringify({ __agentError: '返回值无法序列化：' + String(__e && __e.message || __e) });
  }
})()`;
