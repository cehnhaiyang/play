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
export type ReplyProblem =
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
 * 与 extractJsonObject 共用同一套扫描（`scanObject`），只在"切不出来之后"分岔：
 * 那边返回 null 就结束了，这里要把**为什么**切不出来说清楚 —— 前者要它把这一步
 * 拆小，后者要它去检查转义，两件事对模型的动作完全不同。
 */
export const diagnoseReply = (text: string): ReplyProblem => {
    const start = text.indexOf('{');
    if (start < 0) return { kind: 'noJson' };

    const { end, inString, depth } = scanObject(text, start);

    if (end < 0) {
        return {
            kind: 'truncated',
            detail: inString
                ? `写到第 ${text.length} 个字符时停在一个字符串中间，JSON 从未闭合`
                : `JSON 的括号没有闭合，还差 ${depth} 个 }`,
        };
    }

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
 * 从 `start` 起做字符串感知的括号扫描。
 *
 * 不能用正则匹配花括号 —— 脚本源码里必然含 `{ }` 与字符串，只有字符串感知的
 * 括号计数才能切准边界。返回对象闭合处的下标；**没闭合返回 -1**，并顺带报出
 * 停下时的状态（还在字符串里 / 还差几层），供诊断文案区分"截断"与"括号不配对"。
 */
const scanObject = (
    text: string,
    start: number,
): { end: number; inString: boolean; depth: number } => {
    let depth = 0;
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
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return { end: i, inString: false, depth: 0 };
        }
    }

    return { end: -1, inString, depth };
};

/**
 * 从模型回复里抠出第一个能解析的**平衡** JSON 对象。
 *
 * 不能只看第一个 `{` —— 模型常在 JSON 前写一句"我的计划是…"，那个花括号不是
 * 起点，因此逐个 `{` 当起点试，解析成功即返回。
 */
export const extractJsonObject = (text: string): Record<string, unknown> | null => {
    if (!text) return null;

    // 起点全部收集：intent 或代码里花括号再多也不能让外层 JSON 的起点被截掉。
    // 曾经限制过起点数量，后果是"回复里示例代码多写几个 { }，真正的调用就解析不到"。
    for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
        const { end } = scanObject(text, start);
        if (end < 0) continue;
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
export interface AgentCall {
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
 *  - **上限 MAX_CALLS_PER_REPLY 条**：一批的实际成本是各次观察之和，而它们会
 *    随每一步重发。截断而不是报错，是因为前几条通常已经做完了事，丢掉它们
 *    等于白跑。
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
export const parseToolResult = (result: string): Record<string, unknown> | null => {
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
 * js 另有专属通道 `__agentError`：页面业务数据里出现 `{error:"..."}` 是成功的
 * 数据，不是工具失败。js 的成败判据见 isJsErrorResult，这里保留对 error 的
 * 判断是给 tamper/storage/tokens 这些"错误只能由我们构造"的工具用的。
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
 * 只认 `__agentError`（脚本抛错 / 返回值不可序列化 / 执行器异常）与
 * dispatchTool 自身的参数错误 `{error}`（缺 code 等，那是调用姿势错了）。
 * 页面数据里自带的 `{error:"..."}` 不是失败 —— 那是探测到的业务字段。
 */
export const isJsErrorResult = (result: string): boolean => {
    const parsed = parseToolResult(result);
    if (!parsed) return false;
    if (typeof parsed.__agentError === 'string' && parsed.__agentError.length > 0) return true;
    // 参数错误同样是 {error}，但它只在 code 缺失等情况下由 dispatchTool 构造；
    // 页面数据里的 error 字段走到这里会被误伤 —— 区分方法是看键集合：
    // dispatchTool 的参数错误对象**只有** error 一个键。
    if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        return Object.keys(parsed).length === 1;
    }
    return false;
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

/**
 * 把模型给的代码包成可返回值的异步 IIFE。
 *
 * 包一层的必要性：模型写的是脚本片段（含 `return`），裸求值里顶层 `return` 是
 * 语法错误；同时返回值必须自己序列化 —— `Runtime.evaluate` 对 DOM 节点、
 * 循环引用这类不可序列化的值会直接抛错或回传空对象。
 */
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
    // 是合法数据，不能与"脚本抛错"混用同一个 error 字段，否则 isErrorResult
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
