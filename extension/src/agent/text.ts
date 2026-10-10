import { REASONING_LIMIT_BYTES } from './prompt';

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
 * `tail` 是截断说明的后半句。默认措辞"仅回传…"只对**发给模型**的工具返回值成立；
 * 推理文本是**存给用户读**的，用同一个词会说反（见 keepReasoning 的传参）。
 */
export const truncateBytes = (
    text: string,
    limit: number,
    tail: (total: number, limit: number) => string = (total, max) => `仅回传前 ${max} 字节`,
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
    return `${text.slice(0, lo)}\n…[已截断：原始 ${total} 字节，${tail(total, limit)}]`;
};

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
