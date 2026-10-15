import type {
    AgentCompaction,
    AgentMessage,
    AgentUsage,
    AiChatMessage,
} from '../../../shared/meta';
import { COMPACT_PREFIX } from './prompt';
import { diagnoseReply } from './parse';

/**
 * 摘要消息的前缀，**从这里再导出一次**。
 *
 * 它定义在 prompt.ts（系统提示词里逐字声明了它），而写出它的是本文件。
 * 两处必须一致 —— 测试与界面都按同一个字面量断言，各自 import 一处会让
 * "改了 prompt 忘了 transcript"这类漂移无法被察觉。
 */
export { COMPACT_PREFIX };

/**
 * 界面记录 → 模型消息序列。
 *
 * ## 两个不能直接复用 `messages` 的原因
 *
 * 1. **形状不同**。界面的 `AgentMessage` 是展示记录（带 reasoning / 脚本源码 /
 *    时间戳），模型侧只该拿到 role + content。推理尤其不能进 —— 那会把每一步的
 *    独白在后续每一步重发一遍。
 * 2. **时序不同**。工具结果在**本轮循环内**以 user 消息回灌（ReAct 形态），若从
 *    `messages` 全量重建，它们会被当成"用户说的话"再发一遍。所以调用方必须在
 *    **追加本轮提问之前**读历史，本轮上下文交给循环自己维护。
 *
 * ## 措辞必须逐字共用
 *
 * 两种非工具调用（协议错误 / 普通工具结果）各有专属文案函数。
 * 它们与主循环当场回灌的那一份**逐字共用**，不在这里各写一遍：同一段历史在
 * "本轮循环里"与"下一轮重建时"长得不一样的话，模型对"这一步到底错在哪"的判断
 * 会随轮次漂移。
 */

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
export const splitRounds = (messages: AgentMessage[]): AgentMessage[][] => {
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
 */
export const PROTOCOL_ERROR_LABEL = '协议错误';

/**
 * 界面上那条协议错误记录的**一行摘要**。
 *
 * 与回灌文案（protocolErrorObservation）共用同一个诊断，但**不贴原文**：
 * 回灌要带全文让模型自查，而这条是给人看的 —— 原文动辄几千字，贴上去会把
 * 对话流冲得没法读，用户也判断不出错在哪。诊断结论才是他要的那一句。
 */
export const protocolErrorSummary = (reply: string): string => {
    const problem = diagnoseReply(reply);
    switch (problem.kind) {
        case 'noJson':
            return '协议错误：整条回复里没有 JSON，写成了说明文字';
        case 'truncated':
            return `协议错误：JSON 被截断（${problem.detail}）`;
        case 'badJson':
            return `协议错误：JSON 语法不合法（${problem.detail}）`;
        default:
            return `协议错误：JSON 里既没有 tool 也没有 final（顶层只有 ${problem.keys}）`;
    }
};

/**
 * 协议错误的回灌文案。
 *
 * **只能由这一个函数产出。** 同一段历史在"本轮循环里"与"下一轮重建时"长得不一样
 * 的话，模型对"这一步到底错在哪"的判断会随轮次漂移：当场读到的是"你的 JSON 不合法"，
 * 下一轮却变成"执行失败，请修正参数"——而那次调用压根没有参数可改。
 *
 * ## 为什么要分四种错法
 *
 * 一律回一句"没有工具调用也没有 final"时，模型**只能靠猜**：它自认为写的是合法
 * JSON，于是原样再来一遍。实测连撞三次（MAX_PROTOCOL_ERRORS）就把整轮撞停，
 * 而三次的失败原因其实是同一个"回复被输出长度截断"，模型每次都读不出这件事。
 * 所以这里按 diagnoseReply 的判据分开说，并给出各自**唯一有效的动作**。
 *
 * 诊断只看正文，不看时序，因此当场与重建必然得到同一句 —— 不需要额外记状态。
 *
 * 刻意不写"第 N 次"：那个计数只服务于 MAX_PROTOCOL_ERRORS 这道闸门，
 * 进了文案就没法从消息本身重建（重建时无从知道当时是第几次），
 * 而这正是两处措辞开始分叉的起点。
 */
export const protocolErrorObservation = (reply: string): string => {
    const problem = diagnoseReply(reply);

    let what: string;
    let fix: string;
    switch (problem.kind) {
        case 'noJson':
            what = '整条回复里没有任何 `{`，写成了散文/说明文字。';
            fix = '只输出那一个 JSON 对象本身，前面后面都不要加解释。';
            break;
        case 'truncated':
            what = `JSON 没写完就被截断了：${problem.detail}。`
                + '最常见的原因是这条回复太长，撞上了输出长度上限 —— 不是你把标点写错了。';
            fix = '把这一步拆小：args 里只放**必需**的那段代码，能分两次做的就分两次。'
                + '尤其不要把整份脚本、整篇文档塞进一次回复。';
            break;
        case 'badJson':
            what = `大括号是闭上的，但 JSON 语法不合法：${problem.detail}`;
            fix = '检查 args 里的字符串：换行必须写成 \\n、双引号必须写成 \\"、反斜杠写成 \\\\。';
            break;
        default:
            what = `JSON 本身合法，但没有 tool 也没有 final 字段（顶层只有：${problem.keys}）。`;
            fix = '补上其中一个：要执行工具就写 tool + args，要收尾就写 final。';
            break;
    }

    return '[协议错误] 你上一条回复没有按协议输出。'
        + `具体是：${what}`
        + `改法：${fix}`
        + ' 协议要求只回一个 JSON 对象：'
        + '{"thought":"...","tool":"js","args":{...}} 或 {"thought":"...","final":"..."}，'
        + '不要用 ```json 围栏。'
        + `\n\n你上一条回复的原文：\n${reply}`;
};

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
 * 一轮对话 → 发给模型的消息序列。
 *
 * 同一轮里连续的观察合并进**一条** user 消息：一条 user 消息带多段结果，
 * 比拆成多条更贴近真实的 ReAct 轨迹。
 */
export const roundToMessages = (round: AgentMessage[]): AiChatMessage[] => {
    const out: AiChatMessage[] = [];
    let observations: string[] = [];

    const flushObservations = () => {
        if (observations.length === 0) return;
        out.push({ role: 'user', content: observations.join('\n\n') });
        observations = [];
    };

    for (const message of round) {
        // 压缩分界线不是对话内容。生效时它由 buildTranscript 统一重建成摘要消息；
        // 失效时（用户回退到了压缩点之前）必须丢掉 —— 否则那段摘要会以一条普通
        // assistant 发言的身份留在上下文里，而它描述的是一段已经不存在的对话。
        if (message.compaction) continue;

        if (message.role === 'user') {
            flushObservations();
            out.push({ role: 'user', content: message.content });
            continue;
        }

        if (message.role === 'assistant') {
            flushObservations();
            if (!message.content) continue;
            if (message.notice) {
                // 界面补的提示不是模型说的话，原样回放等于让它读到一句自己从未写过的台词
                observations.push(`[系统提示] ${message.content}`);
            } else {
                out.push({ role: 'assistant', content: message.content });
            }
            continue;
        }

        if (message.result || message.content) {
            if (message.label === PROTOCOL_ERROR_LABEL) {
                observations.push(protocolErrorObservation(message.result || ''));
            } else {
                observations.push(toolObservation(
                    message.label || message.tool || '未知',
                    message.result || '',
                    message.ok !== false,
                ));
            }
        }
    }

    flushObservations();
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
 * **这里不做任何裁剪。** 历史上它按 256KB 从后往前丢掉旧轮次，后果有两个，
 * 都不可接受：静默丢历史（用户与模型都不知道少了什么），以及上下文永远到不了
 * 硬门槛（裁剪先于门槛生效，800k 那条线成了死代码）。现在超限的处置权交给用户。
 */
export const buildTranscript = (messages: AgentMessage[]): AiChatMessage[] => {
    const { messages: live, summary } = splitByCompaction(messages);

    // 观察值不二次截断：执行器回传时已按 RESULT_LIMIT_BYTES 截过一次，
    // 这里再收窄会让"存下来的"与"模型看到的"不一致，复盘时无从解释。
    const flat = splitRounds(live).flatMap(roundToMessages);
    return summary ? [{ role: 'user', content: `${COMPACT_PREFIX}\n${summary}` }, ...flat] : flat;
};

/** 压缩记录的类型别名，供引擎与界面共用同一份定义 */
export type { AgentCompaction };
