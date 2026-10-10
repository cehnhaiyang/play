/**
 * 模型回复与工具结果的解析。
 *
 * 这里的每个判据都对应一类"看错就整轮跑偏"的失效：
 * 抠 JSON 抠不准 → 明明调了工具却判成协议错误；
 * 成败判据写错 → 一次成功的数据探测被标成失败，模型对着成功结果修 bug。
 */

/**
 * 从模型回复里抠出第一个能解析的**平衡** JSON 对象。
 *
 * 不能用正则匹配花括号 —— 脚本源码里必然含 `{ }` 与字符串，只有字符串感知的
 * 括号计数才能切准边界。也不能只看第一个 `{` —— 模型常在 JSON 前写一句
 * "我的计划是…"，那个花括号不是起点，因此逐个 `{` 当起点试，解析成功即返回。
 */
export const extractJsonObject = (text: string): Record<string, unknown> | null => {
    if (!text) return null;

    // 起点全部收集：thought 里花括号再多也不能让外层 JSON 的起点被截掉。
    // 曾经限制过起点数量，后果是"thought 里示例代码多写几个 { }，真正的调用就解析不到"。
    const starts: number[] = [];
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '{') starts.push(i);
    }

    for (const start of starts) {
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
                if (depth === 0) {
                    try {
                        const parsed = JSON.parse(text.slice(start, i + 1));
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            return parsed as Record<string, unknown>;
                        }
                    } catch {
                        /* 这个起点不是合法 JSON，换下一个 */
                    }
                    break;
                }
            }
        }
    }
    return null;
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
export const buildScriptSource = (code: string): string => `(async () => {
  let __v;
  try {
    __v = await (async () => {
${code}
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
