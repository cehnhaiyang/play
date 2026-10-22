import type {
    AgentMessage,
    AgentUsage,
    AiChatMessage,
} from '../../../shared/meta';
import { COMPACT_PREFIX } from './prompt';

/**
 * 界面记录 → 模型消息序列，以及回灌给模型的那几段文案。
 *
 * ## 为什么不能直接把 `messages` 发给模型
 *
 * 1. **形状不同**。`AgentMessage` 是展示记录（带 reasoning / 脚本源码 / 时间戳），
 *    模型侧只该拿到 role + content。推理尤其不能进 —— 那会把每一步的独白在后续
 *    每一步重发一遍。
 * 2. **时序不同**。工具结果在**本轮循环内**以 tool 消息回灌（原生协议形态），若从
 *    `messages` 全量重建，它们会被当成"用户说的话"再发一遍。所以 `send()` 必须在
 *    **追加本轮提问之前**读历史，本轮上下文交给循环自己维护。
 *
 * ## 工具消息必须是原生 `tool` 角色
 *
 * 服务商要求每条 `tool` 消息都由一个 `tool_call_id` 指回 assistant 那条带
 * `tool_calls` 的消息。旧协议没有 tool 角色（JSON 信封里没有这个概念），工具结果
 * 只能伪装成 user 消息塞回历史 —— 而那样模型读不出"这是工具说的还是用户说的"，
 * 只能靠 `[工具 X 的执行结果]` 这类**文本前缀**去猜。现在这层猜测由协议承担。
 *
 * ## 措辞必须逐字共用
 *
 * 工具结果与协议错误各有专属文案函数，主循环当场回灌用的也是它们 —— 不在这里
 * 各写一遍。同一段历史在"本轮循环里"与"下一轮重建时"长得不一样的话，模型对
 * "这一步到底错在哪"的判断会随轮次漂移。
 */

/**
 * 摘要消息的前缀，**从这里再导出一次**。
 *
 * 它定义在 prompt.ts（系统提示词里逐字声明了它），而写出它的是本文件。
 * 两处必须一致 —— 测试与界面都按同一个字面量断言，各自 import 一处会让
 * "改了 prompt 忘了 transcript"这类漂移无法被察觉。
 */
export { COMPACT_PREFIX };

/**
 * 按**轮次**切分对话记录。一轮的边界只有一个：新的用户提问。
 *
 * 上下文重建用它把同一轮的观察合并成一条消息。压缩**不用**它：压缩按消息条数与
 * 档位切片，切在轮次中间是允许的 —— roundToMessages 对任意消息列表都能转，
 * 按轮对齐反而会让"压前 40%"这种承诺无法兑现。
 *
 * 首条消息就是工具消息时（上一轮结束时还有观察没被 flush，用户没再提问），它自成一轮而不是
 * 被丢掉：那一步确实发生过，模型应当知道。
 */
const splitRounds = (messages: AgentMessage[]): AgentMessage[][] => {
    const rounds: AgentMessage[][] = [];
    let current: AgentMessage[] = [];
    for (const message of messages) {
        if (message.role === 'user' && current.length > 0) {
            rounds.push(current);
            current = [];
        }
        current.push(message);
    }
    if (current.length > 0) rounds.push(current);
    return rounds;
};

/**
 * 协议错误那条记录的 label。
 *
 * 构造（主循环）与重建（roundToMessages）两处必须认同一个字面量：重建时靠它
 * 认出"这是一次协议错误"，从而吐回与当场**逐字相同**的回灌文案。
 *
 * 注意它现在只覆盖**一种**失败：服务商给了一次不可执行的调用（参数不是合法
 * JSON，或给了一个我们没有的工具名）。旧版本的五种错法（没写 JSON / 被截断 /
 * JSON 语法坏 / calls 坏了 / 少了字段）随信封协议一起消失了 —— 那些形状在
 * 结构化通道下根本不存在。
 */
export const PROTOCOL_ERROR_LABEL = '协议错误';

/**
 * 界面上那条协议错误记录的**一行摘要**。
 *
 * 与回灌文案（protocolErrorObservation）共用同一个原因，但**不贴原文**：
 * 回灌要带原文让模型自查，而这条是给人看的 —— 原文动辄几千字，贴上去会把
 * 对话流冲得没法读，用户也判断不出错在哪。
 */
export const protocolErrorSummary = (reason: string): string => `协议错误：${reason}`;

/**
 * 协议错误的回灌文案。
 *
 * **只能由这一个函数产出。** 同一段历史在"本轮循环里"与"下一轮重建时"长得不一样
 * 的话，模型对"这一步到底错在哪"的判断会随轮次漂移。
 *
 * ## 为什么现在只有一句
 *
 * 旧版本按五种错法分岔（没写 JSON / 被截断 / 语法坏 / calls 坏了 / 少了字段），
 * 因为那时外壳是模型手写的，五种错法各需一种补救。结构化通道下只剩一种可能：
 * 服务商给的参数不是合法 JSON，或给了一个不存在的工具 —— 两者都只有一条出路，
 * 就是重发这一个调用。分岔文案留着反而会让模型以为还有别的坑要绕。
 *
 * 刻意不写"第 N 次"：那个计数只服务于 MAX_PROTOCOL_ERRORS 这道闸门，
 * 进了文案就没法从消息本身重建（重建时无从知道当时是第几次），
 * 而这正是两处措辞开始分叉的起点。
 */
export const protocolErrorObservation = (reason: string): string => '[协议错误] 这一步没能执行。'
    + `具体是：${reason}`
    + ' 工具调用的参数由协议层生成，正常不会坏 —— 遇到这条就按上面的原因改一次，重发同一个调用。';

/**
 * 工具观察的回灌文案：**只由这一个函数产出**。
 *
 * 与协议错误同一理由：同一段历史在"本轮循环里"与"下一轮重建时"必须逐字一致。
 * 措辞分叉时，模型对"这步成没成"的判断会随轮次漂移 —— 当场读到的是"失败，
 * 请修正参数"，下一轮却只剩一句中性的"执行结果"。
 *
 * 失败与成功必须长得不一样：共用「执行结果」一个前缀时，模型只能自己去读 JSON 里的
 * error 字段才能发现失败，实测里它经常读漏，接着按原计划往下走，同一招连错几次。
 * 后半句"不要原样重试"是必要的 —— 只说失败了，模型最常见的反应是把同样的调用再发一遍。
 */
export const toolObservation = (label: string, result: string, ok: boolean): string => {
    const body = result || '(空)';
    return ok
        ? `[工具 ${label} 的执行结果]\n${body}`
        : `[工具 ${label} 执行失败]\n${body}\n\n这一步没有成功。请根据上面的错误信息修正参数或换一条路，不要原样重试。`;
};

/**
 * 一整批工具调用的回灌文案。**只由这一个函数产出**。
 *
 * 一次回复可以带多个调用，所以观察也必须按**批**回灌。逐条各发一条消息
 * 在时序上等价，但模型看到的是"我发了一次、回来三条"，读不出哪些结果是同一步
 * 拿到的；而"哪几项可以并行"正是它规划下一步的依据。批次头把这件事说清楚。
 *
 * 单个调用时退化成原来的单条文案：多一层批次头是纯 token 开销，
 * 且会让模型以为自己在批量做事。
 */
export const batchObservation = (items: { label: string; result: string; ok: boolean }[]): string => {
    if (items.length === 1) return toolObservation(items[0].label, items[0].result, items[0].ok);

    const failed = items.filter((i) => !i.ok).length;
    const head = `[本步执行了 ${items.length} 个调用，结果如下；`
        + (failed ? `其中 ${failed} 个失败。` : '全部成功。');
    return `${head}\n\n${items.map((i) => toolObservation(i.label, i.result, i.ok)).join('\n\n')}`;
};

/**
 * 一轮对话 → 发给模型的消息序列。
 *
 * ## 工具结果走原生 `tool` 角色
 *
 * 服务商要求每条 tool 消息用 `tool_call_id` 指回 assistant 那条带 `tool_calls`
 * 的消息，否则整条请求被拒（"tool 消息没有对应的调用"）。所以重建历史时，
 * 先把同一轮的调用还原成一条 `assistant.tool_calls`，再逐条跟 `tool` 消息。
 *
 * 这个形状与**当轮循环内**发给模型的那份 transcript 逐字对齐 —— 两处不一致的话，
 * 同一段历史在"当场"与"下一轮"长得不同，模型对"我这一步做了什么"的判断会漂移。
 *
 * ## 协议错误没有对应的 tool 消息
 *
 * 那次调用**没能执行**，所以服务商那边根本没有它的 tool_call_id 可配对。
 * 它只能以文本回灌（`[协议错误]`），作为 user 消息跟在后面 —— 这是协议层面
 * 唯一能表达"这条调用没有结果"的方式。
 */
export const roundToMessages = (round: AgentMessage[]): AiChatMessage[] => {
    const out: AiChatMessage[] = [];
    /** 攒起来的文本观察（系统提示 / 协议错误），按顺序合成 user 消息 */
    let notes: string[] = [];
    /** 这一批已经发出去的调用，等它们的结果 */
    let pending: { id: string; name: string; arguments: string }[] = [];
    let toolMessages: AiChatMessage[] = [];

    const flushNotes = () => {
        if (notes.length === 0) return;
        out.push({ role: 'user', content: notes.join('\n\n') });
        notes = [];
    };

    const flushTools = () => {
        if (pending.length === 0 && toolMessages.length === 0) return;
        // assistant 那条必须在 tool 消息**之前**：协议按顺序配对
        if (pending.length > 0) out.push({ role: 'assistant', content: '', tool_calls: pending });
        out.push(...toolMessages);
        pending = [];
        toolMessages = [];
    };

    for (const message of round) {
        // 压缩分界线不是对话内容。生效时它由 buildTranscript 统一重建成摘要消息；
        // 失效时（用户回退到了压缩点之前）必须丢掉 —— 否则那段摘要会以一条普通
        // assistant 发言的身份留在上下文里，而它描述的是一段已经不存在的对话。
        if (message.compaction) continue;

        if (message.role === 'user') {
            flushTools();
            flushNotes();
            out.push({ role: 'user', content: message.content });
            continue;
        }

        if (message.role === 'assistant') {
            flushTools();
            flushNotes();
            if (!message.content) continue;
            if (message.notice) {
                // 界面补的提示不是模型说的话，原样回放等于让它读到一句自己从未写过的台词
                notes.push(`[系统提示] ${message.content}`);
            } else {
                out.push({ role: 'assistant', content: message.content });
            }
            continue;
        }

        // 工具消息
        const label = message.label || message.tool || '未知';
        const callId = message.callId || `rebuilt_${message.id}`;

        /*
         * **协议错误也走 tool 消息**，不走文本回灌。
         *
         * 它的 id 已经在 assistant.tool_calls 里发出去了 —— 服务商按 id 逐条配对，
         * 少一条就会被拒（"tool 消息与调用对不上"）。所以哪怕这一步没执行成功，
         * 也必须回一条 tool 消息，只是内容是协议错误文案。
         *
         * 没有 callId 的老记录（上一版插件写的）仍按文本回灌：它们没有对应的
         * assistant.tool_calls，凑一条 tool 消息反而会让配对失败。
         */
        if (message.label === PROTOCOL_ERROR_LABEL && !message.callId) {
            flushTools();
            notes.push(protocolErrorObservation(message.result || ''));
            continue;
        }

        if (!message.result && !message.content) continue;
        flushNotes();

        pending.push({
            id: callId,
            name: message.tool || label,
            arguments: message.callArgs || '{}',
        });
        toolMessages.push({
            role: 'tool',
            tool_call_id: callId,
            content: message.label === PROTOCOL_ERROR_LABEL
                ? protocolErrorObservation(message.result || '')
                : toolObservation(label, message.result || '', message.ok !== false),
        });
    }

    flushTools();
    flushNotes();
    return out;
};

/**
 * 找到当前生效的压缩分界线，返回**分界线之后的消息**与摘要正文。
 *
 * 按分界线在流里的**位置**划分，而不是按记录里的 upTo：upTo 只是插入时的锚点，
 * 插完之后"线在哪"由这条消息自己的位置回答。按 upTo 找的话，用户单条删掉那个
 * 锚点就会找不到边界，一份本来有效的摘要会被误判成失效而丢掉。
 *
 * 找不到分界线 = 这次压缩已经不存在，摘要随之作废、原文重新进上下文。不认这条
 * 自愈规则的话，模型会拿着描述"已经不存在的对话"的摘要在错误前提下干活。
 */
export const splitByCompaction = (
    messages: AgentMessage[],
): { messages: AgentMessage[]; summary: string } => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const compaction = messages[i].compaction;
        if (!compaction?.summary) continue;
        return { messages: messages.slice(i + 1), summary: compaction.summary };
    }
    return { messages, summary: '' };
};

/**
 * 把消息插到指定 id 之后；找不到就追加到末尾。
 *
 * 纯函数，供两处共用：消息列表的更新，以及"压缩后上下文有多大"的预估 ——
 * 后者必须按**压缩真正生效后**的序列去算，而在那一刻新消息还没进 state。
 */
export const insertAfterId = (
    list: AgentMessage[],
    afterId: string,
    message: AgentMessage,
): AgentMessage[] => {
    const at = list.findIndex((m) => m.id === afterId);
    if (at < 0) return [...list, message];
    return [...list.slice(0, at + 1), message, ...list.slice(at + 1)];
};

/** 会话累计用量：按现存消息重算，删除 / 回退后自动收敛 */
export const sumUsage = (messages: AgentMessage[], contextTokens: number): AgentUsage => {
    let promptTokens = 0;
    let completionTokens = 0;
    let calls = 0;
    let estimatedCalls = 0;

    for (const message of messages) {
        // 每一次模型调用都在它**自己那条消息**上留一份用量，累计只是把它加总。
        // 不兼看 compaction.usage：那让同一个事实有两个存放处，而界面只画得出
        // message.usage 那一个 —— 用户看到的"各步之和"永远对不上"累计"。
        const usage = message.usage;
        if (!usage) continue;
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
        calls += 1;
        if (usage.estimated) estimatedCalls += 1;
    }

    return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        calls,
        estimatedCalls,
        contextTokens,
    };
};

/**
 * 把界面上的对话记录重建成**发给模型的消息序列**。
 *
 * 压缩生效时，分界线之前的那一段不再逐条回放，改为一条摘要消息 ——
 * 边界由 splitByCompaction 判定，这里不重复一套。
 *
 * **这里不做任何裁剪。** 裁剪有两个后果都不可接受：静默丢历史（用户与模型都不知道
 * 少了什么），以及裁剪先于硬门槛生效，让那条 CONTEXT_LIMIT_TOKENS 的线永远碰不到。
 * 超限的处置权在用户手里 —— 宁可让他看到"上下文已满"，也不要他看到一份缺了几轮的记录。
 */
export const buildTranscript = (messages: AgentMessage[]): AiChatMessage[] => {
    const { messages: live, summary } = splitByCompaction(messages);

    // 观察值不截断：回传什么就存什么、就发给模型什么。截断只可能发生在源头，
    // 而源头（execOnPage）也刻意不设上限 —— 那会让"用户展开看到的"与"模型读到的"
    // 变成两份不同的东西，复盘时无从解释。
    const flat = splitRounds(live).flatMap(roundToMessages);
    return summary ? [{ role: 'user', content: `${COMPACT_PREFIX}\n${summary}` }, ...flat] : flat;
};
