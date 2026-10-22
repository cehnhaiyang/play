/**
 * 工具结果与工具参数的解析。
 *
 * ## 这里**不再有**回复解析
 *
 * 旧版本有一整套"从回复正文里抠 JSON 信封"的机器：`extractJsonObject`、
 * `scanBraces`、`diagnoseReply`，以及配套的五种协议错误。它们存在的前提是
 * **模型手写外壳** —— 而那个前提本身就是故障源：实测 100 轮里 9 轮死于
 * 外壳写坏（漏引号、漏括号、被输出长度截断），同一个文件能连撞三次。
 *
 * 现在调用由服务商的结构化通道产出（见 toolspec.ts），参数是一段**服务商生成**的
 * JSON 字符串。剩下唯一要解析的是 `arguments` 本身，而它坏了只有一种含义：
 * 服务商没有真正约束解码。那件事由引擎按"这一步没做成"处置，不再有五种错法。
 *
 * 这个文件里剩下的判据都对应一类"看错就整轮跑偏"的失效：
 * 成败判据写错 → 一次成功的数据探测被标成失败，模型对着成功结果修 bug。
 */

import { errorText } from './text';

/**
 * 一条工具调用的参数解析结果。
 *
 * 用联合类型而不是抛异常：坏参数要**原样回灌**给模型让它改，不该中断整轮对话。
 */
export type ParsedArguments =
    | { ok: true; args: Record<string, unknown> }
    | { ok: false; error: string };

/**
 * 解析工具调用的 `arguments`。
 *
 * 三种情形分开报，因为它们各自只有一种有效的补救：
 *  - **空串**：模型调了工具却没给参数。归一成 `{}` 而不是报错 —— 工具层对缺参数
 *    有自己的文案（"缺少 code"比"arguments 是空串"更能让它一步改对）。
 *  - **不是对象**：数组、数字、`null` 都算。工具层只认键值对。
 *  - **JSON 坏了**：只可能来自"服务商没有约束解码"。把原文抄回去，
 *    否则模型看不见自己写了什么，只会原样再发一次。
 */
export const parseArguments = (raw: string): ParsedArguments => {
    if (!raw.trim()) return { ok: true, args: {} };

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return {
            ok: false,
            error: `参数不是合法 JSON（${errorText(e)}）。原文：${raw.slice(0, 500)}`,
        };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            ok: false,
            error: `参数必须是一个 JSON 对象，实际是 ${Array.isArray(parsed) ? 'array' : typeof parsed}。`,
        };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
};

/**
 * 从一次回复里取出本批要执行的调用，顺序即服务商给的顺序。
 *
 * **一个都不丢。** 曾经有过一个"一批最多 8 个"的上限，理由是成本（各次观察会
 * 随后续每一步重发）。那条理由站不住：一次给几个调用是模型自己的判断，按条数
 * 砍等于替它决定，而且被砍掉的那几条**没有任何提示** —— 模型看到的结果比它写的
 * 少，只会以为工具坏了再把同一批发一遍。真实的成本由 800k 上下文门槛与压缩来管，
 * 那两道闸门本来就存在。
 *
 * **参数解析失败的调用也不在这里丢掉**：它照样进列表，由执行处报一条明确的
 * 失败观察。在这里跳过的话，模型一次都读不到"参数坏了"这个原因。
 */
export const extractCalls = (
    calls: { id: string; name: string; arguments: string }[] | null | undefined,
): { calls: { id: string; tool: string; raw: string }[] } => {
    if (!Array.isArray(calls)) return { calls: [] };
    return {
        calls: calls.map((call) => ({
            id: call.id,
            tool: call.name,
            raw: call.arguments,
        })),
    };
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

/**
 * 工具名是否在规格表里。执行前用它挡掉服务商给了一个我们没有的工具。
 *
 * 判据放在本文件：它是"这一批能不能执行"的一部分，与参数解析同源；
 * 规格表在 toolspec.ts，那边 import 这里会与 prompt 的插值成环。
 */
export const isKnownTool = (name: string, known: readonly string[]): boolean => known.includes(name);
