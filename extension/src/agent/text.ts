/**
 * 文本度量与截断。
 *
 * 单独一层是因为这些函数的**失效方式是静默的**：截断写错不会报错，
 * 只会让上限形同虚设，或让一段中文被切成半个字。分开之后可以直接对
 * 输入输出下断言。
 */

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * 按**字节**截断，且不切坏多字节字符。
 *
 * 用二分而非 `slice(0, n)`：中文一个字 3 字节，按字符数截断会让实际体积随内容
 * 浮动，上限就形同虚设。
 *
 * `tail` 是截断说明的后半句，**由调用方给**：措辞要贴着那段文本的用途。
 * 现在只有一处（推理文本，存给用户读的），所以没有默认值 —— 留一个默认值就是
 * 留一句没人用、还会与用途说反的话。
 */
export const truncateBytes = (
    text: string,
    limit: number,
    tail: (total: number, limit: number) => string,
): string => {
    const total = byteLength(text);
    if (total <= limit) return text;

    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (byteLength(text.slice(0, mid)) <= limit) lo = mid;
        else hi = mid - 1;
    }

    /*
     * 切点落在一对代理项中间时，再退回一个单元。
     *
     * 按字节截断本该不切坏字符，但一个"字符"在 UTF-16 里可能是两个单元
     * （Emoji、扩展区汉字）：从中间切开后切片以半个字符结尾，序列化进 storage
     * 或请求体就是一个孤立代理项，被回传/存档的是乱码。TextEncoder 把这种残片
     * 按 U+FFFD（3 字节）计，所以退回一个单元只会让结果更小，不会越界。
     */
    const last = text.charCodeAt(lo - 1);
    if (last >= 0xd800 && last <= 0xdbff) lo -= 1;

    return `${text.slice(0, lo)}\n…[已截断：原始 ${total} 字节，${tail(total, limit)}]`;
};

/**
 * 单条推理文本的落盘上限（字节）。
 *
 * 推理模型的思考可以很长，而它**每一步都会存一份** —— 200 条消息全挂满推理
 * 就能把落盘预算吃光，把真正有用的对话与工具结果挤掉。
 *
 * 定义在这里而不是 prompt.ts（其余上限都在那）：本文件是唯一用它的地方，
 * 而 prompt.ts 会 import parse.ts（提示词里插值一批的条数上限）。这里反向
 * import 回去就成环 —— 实测成环时 SYSTEM_PROMPT 里插值的那个数字会取到
 * parse 尚未求值完的导出，提示词当场写成 "at most undefined per reply"。
 * 本文件不 import 任何东西，环因此在结构上无法重现。
 */
const REASONING_LIMIT_BYTES = 32768;

/**
 * 定稿一轮推理文本：截断到落盘上限，空串归一成 undefined。
 *
 * 空串必须转 undefined：否则每条没有推理的消息都多带一个 `reasoning: ""`，
 * 序列化进 storage 是实打实的字节，而界面上它什么也不表示。
 */
export const keepReasoning = (raw: string): string | undefined => {
    const text = raw.trim();
    if (!text) return undefined;
    // 措辞与工具返回值区分开：这条不是"回传给模型"，而是"存下来给用户看"
    return truncateBytes(
        text,
        REASONING_LIMIT_BYTES,
        (total, max) => `此处仅保留前 ${max} 字节（原文 ${total} 字节）`,
    );
};

/**
 * 按**字节预算**从后往前保留，直到超出为止。
 *
 * 只限条数挡不住体积：200 条 × 32KB 会顶穿 storage 配额，写入失败时界面只
 * 表现为"历史不再保存"。
 *
 * 至少保留一条：单条就超预算时也该留下它，否则等于什么都不存。
 */
export const trimToBudget = <T,>(items: T[], budget: number): T[] => {
    const kept: T[] = [];
    let used = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
        const size = byteLength(JSON.stringify(items[i]));
        if (used + size > budget && kept.length > 0) break;
        used += size;
        kept.push(items[i]);
    }
    return kept.reverse();
};

/**
 * 异常 → 可展示的一行文字。
 *
 * 不用 `String(e)` 一把梭：抛出的东西不一定是 Error（Promise 里 reject 一个字符串
 * 很常见），而 Error 直接 String() 会得到 "Error: xxx" 这种带前缀的噪声。
 */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 把任意值收敛成字符串；非字符串一律给空串（调用方据此判"没传"） */
export const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
