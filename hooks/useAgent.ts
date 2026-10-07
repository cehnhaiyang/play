import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
    AgentCompaction,
    AgentMessage,
    AgentRunStatus,
    AgentScript,
    AgentToolName,
    AgentUsage,
    AiChatMessage,
    AiUsage,
    HeaderRule,
    TamperRule,
    WebviewElement,
} from '../meta';
import { chat, estimatePromptTokens } from '../services/AiService';
import {
    buildKbIndex,
    normalizeRel,
    readKbArticle,
    searchKb,
    KB_SEARCH_LIMIT,
    type KbEntry,
    type KbLoadPayload,
} from '../services/KbService';
import {
    buildCookieKeys,
    collectDroppedRules,
    decodeJwt,
    findCookieByKey,
    generateId,
    loadJSON,
    pickJwtCandidates,
    rewriteJwtPayload,
    saveJSON,
} from '../const';
import type { TamperState } from './useBrowse';

/**
 * ============================================================================
 * useAgent — Agent 工作空间（在已登录的页面里执行脚本）
 * ============================================================================
 *
 * 形状是**代码执行器**，不是点击驱动器。七个工具：js（跑脚本）、script_store
 * （脚本的存取，action 分 list/save/update/delete）、navigate、tamper、storage、
 * tokens、kb，全小写严格匹配。
 *
 * 点击、输入、取数、翻页全部塌缩成 js 里的一行代码，依据是上下文经济学：
 * 每次观察都要序列化进模型上下文，DOM 快照动辄数万 token，而脚本返回值可截断。
 *
 * tamper / storage 是**用户手动面板能力的开放**，不是 js 的替代：规则必须在
 * 引擎层生效（钩子装在页面主世界，脚本只影响自己那一次调用），Cookie 必须走原生
 * API（HttpOnly 在渲染进程里读不到）。kb 只读本地文章、不碰页面，检索本身在
 * services/KbService（纯 TS，可单测），这里只做派发与缓存。
 *
 * 由此免费拿到三样 IDE 里 fetch 补不上的东西：会话 cookie、页面自身的 JS 函数
 * （签名参数往往由混淆代码生成）、真实 TLS 栈。这也是本功能存在的理由。
 *
 * 协议用 JSON 而不是原生 tool_calls：换服务商时不必重做适配层，代价是循环要
 * 自己解析模型输出。
 */

/* -------------------------------------------------------------------------- */
/*                                  常量                                       */
/* -------------------------------------------------------------------------- */

/**
 * 单次观察回传上限 —— **保险丝，不是预算**。
 *
 * 第 i 步的结果会被后续每一步重发，所以总成本里步数那一项是平方级的：
 * 为了省 token 而截断是净亏的（拆成 3 次取要多走 2 步，重发量远超省下的首包）。
 * 它只防 return document.documentElement.outerHTML 这类明显超标的返回
 * （大型站实测 1.95MB，进请求会把上下文顶穿、整轮直接失败）。
 */
const RESULT_LIMIT_BYTES = 32768;

/**
 * 连续多少次协议错误后放弃。
 *
 * 错误会回灌让模型自己改，但卡在同一个错误上反复犯的模型是存在的：无上限回灌
 * 只会把整轮的调用费烧光，且每一步都要付一次钱。
 */
const MAX_PROTOCOL_ERRORS = 3;

/**
 * 单条推理文本的落盘上限（字节）。
 *
 * 推理模型的思考可以很长，而它**每一步都会存一份** —— 200 条消息全挂满推理
 * 就能把 1.5MB 的落盘预算吃光，把真正有用的对话与工具结果挤掉。
 */
const REASONING_LIMIT_BYTES = 32768;

const SCRIPTS_STORE_KEY = 'agent-scripts';
const SCRIPTS_STORE_MAX = 100;

const MESSAGES_STORE_KEY = 'agent-messages';
const MESSAGES_STORE_MAX = 200;

/**
 * 落盘体积预算（字节）。
 *
 * localStorage 常见配额 5MB。单限条数挡不住：一条消息最多 32KB，200 条就是 6.3MB，
 * 加上脚本直接超配额，saveJSON 静默返回 false（异常被 persist 吞掉）——
 * 表现为"对话历史不再保存"且无提示。所以按**字节**收敛，条数上限只作附加保护。
 */
const STORE_BUDGET_MESSAGES = 1_500_000;
const STORE_BUDGET_SCRIPTS = 800_000;

/**
 * 上下文硬门槛（token）。达到或超过即**强制压缩**：输入框禁用，不压不能继续。
 *
 * 两道闸门都要有（界面禁用 + send() 拒绝）：只禁界面的话，快捷键与错误横幅的
 * 「重试」等路径仍能绕过去。只有**严格小于**这个值才放行。
 *
 * 为什么必须去掉一切"自动"：压缩是不可逆的历史改写（旧轮次被摘要取代）外加一次
 * 模型调用，不该由程序替用户决定。门槛只负责在越线时拦住他。
 */
export const CONTEXT_LIMIT_TOKENS = 800_000;

/**
 * 压缩档位：每次压缩覆盖掉**分界线之后现存消息**的前百分之几。
 *
 * 按**消息条数**算，不分角色（用户提问 / 模型回答 / 工具结果都计一条）：
 * 100 条消息时四档分别覆盖前 40 / 60 / 80 / 100 条，剩下的原样保留。
 * 100% 即全压 —— 上下文只剩一条摘要，直到新消息进来。
 *
 * 为什么是条数而不是轮次：轮次边界只有一个（新的用户提问），自动脚本、
 * 提示横幅这些非轮次消息会让"保留 N 轮"实际保留的条数飘忽不定；
 * 条数是用户唯一能数的东西。
 */
export const COMPACT_RATIOS = [0.4, 0.6, 0.8, 1] as const;
/** 默认档位。导出给界面算"按当前档位至少几条才压得动"，手抄一个数会漂移。 */
export const COMPACT_RATIO_DEFAULT = 0.6;
const COMPACT_RATIO_STORE_KEY = 'agent-compact-ratio';

/**
 * 按档位算出这次该覆盖几条。 Math.floor 而不是 round：承诺"压前 N%"时，
 * 实际覆盖只能少不能多 —— 多压一条在 100% 档没有区别，在 40% 档就是多吞历史。
 *
 * 返回 0 即"按当前档位无可压内容"，调用方（compact / canCompact）据此返回
 * null / false。两处必须调同一个函数（见 canCompact 的注释）。
 */
const compactCoverCount = (messageCount: number, ratio: number): number =>
    Math.floor(messageCount * ratio);

/**
 * 送进摘要器的原文预算（字节）。
 *
 * **这个值小于硬门槛，是有意的取舍。** 门槛是 800k token（≈2MB 文本），而摘要器
 * 本身也是模型：把 2MB 灌进去需要约 50 万 token 的窗口，多数模型没有。真按门槛
 * 要预算的结果是**摘要调用直接失败** —— 而那时输入框正锁着，用户会被彻底卡死。
 * 宁可少概括一些，也不能让唯一的出路本身失败。
 *
 * 代价是第一次压缩**压不全**：超出预算的消息连摘要都没进，信息是真的没了。
 * 所以压缩记录里分开记 coveredMessages 与 summarizedMessages，界面如实说出差额；
 * 反复压缩时上一次的摘要会一并带进摘要器（见 compact 的 priorSummary），
 * 更早的历史不会凭空消失，只是逐次变粗。
 */
const COMPACT_INPUT_BUDGET_BYTES = 524_288;

/** 摘要请求的输出上限。结构化摘要写不到这么长，这个值只是防跑飞 */
const COMPACT_MAX_TOKENS = 2048;

/** 摘要消息的前缀。系统提示词里逐字声明了它，两处必须一致。 */
const COMPACT_PREFIX = '[上下文压缩摘要]';

/**
 * 按**轮次**切分对话记录。一轮的边界只有一个：新的用户提问。
 *
 * 上下文重建（buildTranscript）用它把同一轮的观察合并成一条消息。
 * 压缩**不用**它：压缩按消息条数与档位切片（见 compactCoverCount），
 * 切在轮次中间是允许的 —— roundToMessages 对任意消息列表都能转，
 * 按轮对齐反而会让"压前 40%"这种承诺无法兑现。
 *
 * 首条消息就是工具消息时（页面自动执行脚本，用户还没提问过），它自成一轮而不是
 * 被丢掉：那段环境事件确实发生过，模型应当知道。
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
 * 一轮对话 → 发给模型的消息序列。
 *
 * 与界面那份 `AgentMessage` 的两个差别（也就是 `buildTranscript` 存在的理由）：
 * 推理与脚本源码不进（每步重发会撑爆预算），界面自己补的提示不伪装成模型发言。
 * 同一轮里连续的观察合并进**一条** user 消息：一条 user 消息带多段结果，
 * 比拆成多条更贴近真实的 ReAct 轨迹。
 */
const roundToMessages = (round: AgentMessage[]): AiChatMessage[] => {
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
            // 自动执行的脚本不是模型的调用，写成「工具结果」会凭空捏造一次调用；
            // 但它确实改变了页面，所以作为一条**环境事件**如实告知。
            if (message.auto) {
                observations.push(`[自动脚本「${message.content.replace(/^自动执行：/, '')}」已在页面上执行]\n${message.result || '(无返回值)'}`);
            } else {
                // 措辞必须与 send() 回灌时**逐字一致**：同一段历史在"本轮循环里"与
                // "下一轮重建时"长得不一样的话，模型对"这步成没成"的判断会随轮次漂移。
                const label = message.label || message.tool || '未知';
                observations.push(message.ok === false
                    ? `[工具 ${label} 执行失败]\n${message.result || '(空)'}\n\n这一步没有成功。请根据上面的错误信息修正参数或换一条路，不要原样重试。`
                    : `[工具 ${label} 的执行结果]\n${message.result || '(空)'}`);
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
const splitByCompaction = (messages: AgentMessage[]): { messages: AgentMessage[]; summary: string } => {
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
 * 纯函数，供两处共用：setMessages 的更新器，以及"压缩后上下文有多大"的预估 ——
 * 后者必须按**压缩真正生效后**的序列去算，而在那一刻新消息还没进 state。
 */
const insertAfterId = (list: AgentMessage[], afterId: string, message: AgentMessage): AgentMessage[] => {
    const at = list.findIndex((m) => m.id === afterId);
    if (at < 0) return [...list, message];
    return [...list.slice(0, at + 1), message, ...list.slice(at + 1)];
};

/** 会话累计用量：按现存消息重算，删除 / 回退后自动收敛 */
const sumUsage = (messages: AgentMessage[], contextTokens: number): AgentUsage => {
    let promptTokens = 0;
    let completionTokens = 0;
    let calls = 0;
    let estimatedCalls = 0;

    for (const message of messages) {
        // 摘要调用自身的成本也要算：它花的是真钱，漏掉会让"这个会话花了多少"
        // 在压缩过的会话里系统性偏低
        const usage = message.usage || message.compaction?.usage;
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
 * 两个不能直接复用 `messages` 的原因：
 *
 * 1. 形状不同。界面的 `AgentMessage` 是展示记录（带 reasoning / 脚本源码 / 时间戳），
 *    模型侧只该拿到 role + content。推理尤其不能进 —— 那会把每一步的独白在后续
 *    每一步重发一遍。
 * 2. 时序不同。工具结果在**本轮循环内**以 user 消息回灌（ReAct 形态），若从
 *    `messages` 全量重建，它们会被当成"用户说的话"再发一遍。所以调用方必须在
 *    **追加本轮提问之前**读历史（见 send），本轮上下文交给循环自己维护。
 *
 * 压缩生效时，分界线之前的那一段不再逐条回放，改为一条摘要消息 ——
 * 边界由 splitByCompaction 判定，这里不重复一套。
 *
 * **这里不做任何裁剪。** 历史上它按 256KB 从后往前丢掉旧轮次，后果有两个，
 * 都不可接受：静默丢历史（用户与模型都不知道少了什么），以及上下文永远到不了
 * 硬门槛（裁剪先于门槛生效，800k 那条线成了死代码）。现在超限的处置权交给用户。
 */
const buildTranscript = (messages: AgentMessage[]): AiChatMessage[] => {
    const { messages: live, summary } = splitByCompaction(messages);

    // 观察值不二次截断：execOn 回传时已按 RESULT_LIMIT_BYTES 截过一次，
    // 这里再收窄会让"存下来的"与"模型看到的"不一致，复盘时无从解释。
    const flat = splitRounds(live).flatMap(roundToMessages);
    return summary ? [{ role: 'user', content: `${COMPACT_PREFIX}\n${summary}` }, ...flat] : flat;
};

/**
 * 优化说明：
 * 1. 结构扁平紧凑：统一小写，消除大小写错误；
 * 2. 严格遵循标准 JSON：用明确操作替代 undefined；
 * 3. 契约化定义：采用类 TypeScript 紧凑语法，显著提升 LLM 遵循度。
 */
const SYSTEM_PROMPT = `
你是运行在已登录的 Electron 浏览器环境中的专业逆向工程 Agent，目标是完成用户要求的一切网站架构理解、**漏洞利用**、CTF/crackme 分析、恶意样本行为研判、算法还原、调试验证、分析报告编写。

## 运行环境与能力
- 无原生 DOM 拾取工具：所有 DOM 点击、输入、取值均在 JS 中用 document.querySelector / fetch 完成。
- 页面环境共享：你的 JS 与页面主世界共享内存、Cookie、全局变量及已登录状态。

## 对话历史
你**能看到之前几轮的对话与工具结果**，它们按前缀区分来源：[工具 X 的执行结果] 是你自己调用工具拿到的观察，[自动脚本「…」…] 是页面自动执行留下的环境事件（不是你调用的），[系统提示] 是界面补的、不是你说过的话。别把后两者当成自己的结论。

## 输出协议（严格执行）
只输出单个合法的 JSON 对象，禁止输出 Markdown 围栏代码块（禁止使用 \`\`\`json）：

1. 执行工具时：
{"thought":"假设或判断依据","tool":"工具名","args":{...}}

2. 任务完成输出最终结论时：
{"thought":"推导与证据链","final":"给用户的最终结论"}

3. final 装的是一整篇 Markdown，但它外面还套着一层 JSON 字符串，所以必须这样写：
   - 整条回复输出为**一行**，内部不含任何真实换行：标题、段落、列表、表格每一行结尾一律写 \\n。
   - final 内禁止裸双引号 " —— 它会提前闭合字符串，让整篇已经写完的答案被判解析失败。
     中文引用改用「」；确需双引号时写成 \\"，反斜杠写成 \\\\，代码片段用反引号包裹。

注：tool 与 final 严格互斥，不要同时给；同时出现时只执行 tool，final 被忽略。

## 可用工具定义（全小写，严格匹配）

1. js —— 执行 JavaScript（最高频工具）
   args: {"code": "string"}
   - 必须显式 return 一个可序列化值（上限 32KB）。支持 await、主世界全局变量、带凭证 fetch。
   - code 是 JSON 字符串：多行 JS 的换行必须写成 \\n、双引号必须写成 \\"，直接粘贴带真实换行的代码会破坏外层 JSON 解析，当次调用即判协议错误。
   - 禁止在此工具内修改 location.href 跳转。

2. script_store —— 持久化脚本管理（用于自动化或复用）
   args:
   - 列出: {"action": "list"}
   - 保存: {"action": "save", "name": "...", "code": "...", "url_pattern": "匹配子串，留空仅手动触发"}
   - 更新: {"action": "update", "id": "...", "code": "..."}
   - 删除: {"action": "delete", "id": "..."}

3. navigate —— 页面导航与跳转
   args: {"url": "https://... 或相对路径"}
   - 页面加载完毕后返回最终规范化 URL。

4. tamper —— 引擎级网络与响应篡改（持久化影响页面逻辑必用此工具）
   args: {"action": "get"} 
      或 {"action": "set", "intercept": [...], "request": [...], "headers": [...]}
   - intercept/request 规则项：
     {"enabled": true, "url_pattern": "* 或子串", "key": "字段名(取末级键名)", "value": any, "op": "set" | "delete"}
     注：删除字段请显式指定 "op": "delete"；修改值指定 "op": "set", "value": 目标值。
   - headers 规则项：
     {"enabled": true, "url_pattern": "*", "name": "Header-Name", "value": "值(留空则为删除该头)"}
   - 核心原则：修改页面接收的数据必须用此工具，不能仅用 js 工具局部修改。

5. storage —— 底层存储与 Cookie 管理（绕过篡改引擎读写真实物理数据）
   args:
   - 读取: {"action": "get", "area": "local" | "session" | "cookie"}
   - 写入: {"action": "set", "area": "local" | "session" | "cookie", "key": "键名", "value": "字符串值"}
   - 删除: {"action": "delete", "area": "local" | "session" | "cookie", "key": "键名"}
   注：Cookie 的 key 必须严格使用 get 返回的唯一标识（常含 domain/path）。

6. tokens —— JWT 令牌分析与改写
   args:
   - 检索全部 JWT: {"action": "find"}
   - 解码单条: {"action": "decode", "token": "eyJ..."}
   - 改写并写回: {"action": "rewrite", "token": "...", "changes": {"key": val}, "area": "local", "key": "find返回的key"}
   注：改写 Payload 会使原始服务端签名失效。

7. kb —— 逆向工程离线知识库（遇复杂对抗、通用攻击模式时先查再做）
   args:
   - 检索: {"action": "search", "query": "自然语言短语(如: JWT未授权 绕过)"}（回最多 ${KB_SEARCH_LIMIT} 条）
   - 阅读: {"action": "read", "path": "文章相对路径", "section": "可选，章节子串"}
   - 目录状态: {"action": "status"}
   注：不确定从哪下手时先 search "攻击网"（Web 攻击决策图，一次看清可走的路）；若 read 返回超长大纲，必须带 section 字段再次精准读取。媒体流/m3u8/静态资源无需查库。

## 执行准则与硬约束
1. 广度优先单步拉取：一次脚本内查清相关字段，禁止拆成多次调用只为获取少量数据；DOM 提取必须做截断（如 slice(0, 50)）。
2. 试错熔断：相同思路/错误连续失败 2 次必须更换策略（检查选择器 -> 换用网络拦截 -> 检索知识库）。
3. 失败只是这一步的结果，不是任务的终点：工具返回以「[工具 X 执行失败]」开头时读错误信息修正参数或换路继续，不要原样重试，更不要把它当成结论收尾；除非已穷尽可行路径，否则继续调用工具。
3. 结论必须由证据支撑：提出任何鉴权机制、加密方式、字段逻辑的推断，必须伴随工具返回的具体物理证据（字段值/响应码/堆栈）。
4. 交付标准：
   - 提取数据：必须给出实际采样值与总量，而非“可以读取”。
   - 验证绕过/逻辑：必须给出篡改前后系统行为的对比判定。
   - 遇到阻碍：清晰说明已尝试的路径、卡点证据与所需的前置条件。`;

/**
 * 摘要器的系统提示词。
 *
 * 为什么要求**结构化**而不是"总结一下"：Agent 的跨轮记忆里，最不能丢的不是
 * 聊了什么，而是「任务目标」「已确认的事实（含证据来源）」「试过且失败的路」。
 * 自由发挥的摘要几乎必然倒向"用户要求做 X，助手做了 Y"这种叙事，
 * 恰好把后两类压没 —— 而它们正是模型重复劳动的唯一防线。
 *
 * 明确禁止编造：摘要会作为历史发给模型，模型对它**没有分辨能力**。
 * 摘要里写错一个字段名，后续每一步都会照着那个错的名字去写脚本。
 */
const COMPACT_SYSTEM_PROMPT = `你是一个对话压缩器。把给定的 Agent 工作记录压缩成一份结构化摘要。

这份摘要会替换掉原始记录、成为后续对话的历史上下文，所以**准确性远比简洁重要**：
- 只写记录里**确实出现过**的内容。没有的信息就留空，**绝不推测、绝不补全**。
- 字段名、接口路径、选择器、token、错误码一律**逐字照抄**，不要改写、不要翻译。
- 记录里被截断的内容（带「已截断」标记）就按截断后的写，不要试图补全。

按下面的结构输出 Markdown，没有内容的小节写「（无）」：

## 任务目标
用户要达成什么。若目标在过程中变过，写清变化。

## 已确认的事实
已经**验证过**的结论，每条注明来源（哪个接口 / 哪个存储键 / 哪段脚本的返回值）。

## 已完成的操作
改动了什么、在哪一层生效（引擎规则 / 脚本 / 存储 / 页面）。含保存下来的脚本名与用途。

## 试过但失败的路
失败的做法与**失败原因**。这一节最容易被忽略但最值钱 —— 不写清楚，
后续会对着同一堵墙再撞一遍。

## 待办与下一步
还没做完的部分，以及当时判断的下一步。

只输出这份 Markdown，不要前言、不要结语、不要代码块围栏。`;

/* -------------------------------------------------------------------------- */
/*                                  工具函数                                  */
/* -------------------------------------------------------------------------- */

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * 按**字节**截断，且不切坏多字节字符。
 *
 * 用二分而非 slice(0, n)：中文一个字 3 字节，按字符数截断会让实际体积随内容浮动，
 * 上限就形同虚设。
 *
 * `tail` 是截断说明的后半句。默认措辞"仅回传…"只对**发给模型**的工具返回值成立；
 * 推理文本是**存给用户读**的，用同一个词会说反（见 keepReasoning 的传参）。
 */
const truncateBytes = (
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
 * 从模型回复里抠出第一个能解析的**平衡** JSON 对象。
 *
 * 不能用正则匹配花括号 —— 脚本源码里必然含 { } 与字符串，只有字符串感知的括号
 * 计数才能切准边界。也不能只看第一个 { —— 模型常在 JSON 前写一句"我的计划是…"，
 * 那个花括号不是起点，因此逐个 { 当起点试，解析成功即返回。
 */
const extractJsonObject = (text: string): Record<string, unknown> | null => {
    if (!text) return null;

    // 起点全部收集：thought 里花括号再多也不能让外层 JSON 的起点被截掉。
    // 上限 50 曾导致"thought 里示例代码多写几个 { }，真正的调用就解析不到"。
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
                    } catch { /* 这个起点不是合法 JSON，换下一个 */ }
                    break;
                }
            }
        }
    }
    return null;
};

/**
 * 把模型给的代码包成可返回值的异步 IIFE。
 *
 * 包一层的必要性：模型写的是脚本片段（含 return），裸 executeJavaScript 里顶层
 * return 是语法错误；同时返回值必须自己序列化 —— executeJavaScript 对 DOM 节点、
 * 循环引用这类不可序列化的值会直接抛错或回传空对象。
 */
const buildScriptSource = (code: string): string => `(async () => {
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

const readWebviewUrl = (webview: WebviewElement): string => {
    try { return webview.getURL?.() || ''; } catch { return ''; }
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * 未知 action 的错误文案。
 *
 * 光列可用值不够 —— 模型看到"未知 action：SET（可用 get / set）"可能以为是别的
 * 问题，加一句点名大小写的提示，一步就能改对。
 */
const unknownActionError = (got: string, valid: string[]): string => {
    const hint = valid.find((v) => v.toLowerCase() === got.toLowerCase());
    return `未知 action：${got || '(空)'}（可用 ${valid.join(' / ')}`
        + `${hint && hint !== got ? `；注意大小写：请用 ${hint}` : ''}）`;
};

/**
 * 工具结果是否为错误。
 *
 * 不能用 `result.startsWith('{"error"')` —— 脚本正常返回
 * `{"error": null, "data": [...]}` 是合法值，按前缀判会被标成失败。
 * 必须解析出来看：**含 error 字段且它是非空字符串**才算错。
 *
 * S·R 另有专属通道 __agentError（见 buildScriptSource）：页面业务数据里出现
 * `{error:"..."}` 是成功的数据，不是工具失败。js 的成败判据见
 * isJsErrorResult，这里保留对 error 的判断是给 tamper/storage/tokens/kb
 * 这些"错误只能由我们构造"的工具用的。
 */
const isErrorResult = (result: string): boolean => {
    if (!result.startsWith('{')) return false;
    try {
        const parsed = JSON.parse(result) as { error?: unknown; __agentError?: unknown } | null;
        if (!parsed || typeof parsed !== 'object') return false;
        if (typeof parsed.__agentError === 'string' && parsed.__agentError.length > 0) return true;
        return typeof parsed.error === 'string' && parsed.error.length > 0;
    } catch {
        return false;
    }
};

/**
 * js 脚本执行是否失败。
 *
 * 只认 __agentError（脚本抛错 / 返回值不可序列化 / 执行器异常）与
 * dispatchTool 自身的参数错误 {error}（缺 code 等，那是调用姿势错了）。
 * 页面数据里自带的 `{error:"..."}` 不是失败 —— 那是探测到的业务字段。
 */
const isJsErrorResult = (result: string): boolean => {
    if (!result.startsWith('{')) return false;
    try {
        const parsed = JSON.parse(result) as { error?: unknown; __agentError?: unknown } | null;
        if (!parsed || typeof parsed !== 'object') return false;
        if (typeof parsed.__agentError === 'string' && parsed.__agentError.length > 0) return true;
        // 参数错误同样是 {error}，但它只在 code 缺失/脚本清单越界等情况下由
        // dispatchTool 构造；页面数据里的 error 字段走到这里会被误伤 ——
        // 区分方法是看键集合：dispatchTool 的参数错误对象**只有** error 一个键。
        if (typeof parsed.error === 'string' && parsed.error.length > 0) {
            return Object.keys(parsed).length === 1;
        }
        return false;
    } catch {
        return false;
    }
};

/**
 * 按**字节预算**从后往前保留，直到超出为止。
 *
 * 两个调用点：落盘时收敛消息/脚本的体积，压缩时挑出能进摘要器的消息。
 * 后者传入的是「消息转出的数组」而返回分组本身 —— 调用方需要知道"有几条进了预算"，
 * 按扁平结果反推会把「一条消息转出多段」算错。
 *
 * 只限条数挡不住体积：200 条 × 32KB 会超 localStorage 配额，saveJSON 静默返回
 * false —— 表现为"对话历史忽然不再保存"且没有任何提示。
 * 至少保留一条：单条就超预算时也该留下它，否则等于什么都不存。
 */
const trimToBudget = <T,>(items: T[], budget: number): T[] => {
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

const normalizeScript = (raw: unknown): AgentScript | null => {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Partial<AgentScript>;
    if (typeof item.code !== 'string' || !item.code.trim()) return null;
    return {
        id: typeof item.id === 'string' && item.id ? item.id : generateId(),
        name: (typeof item.name === 'string' && item.name.trim()) || '未命名脚本',
        description: asString(item.description),
        code: item.code,
        urlPattern: asString(item.urlPattern),
        enabled: item.enabled !== false,
        lastRunAt: typeof item.lastRunAt === 'number' ? item.lastRunAt : undefined,
        lastResult: typeof item.lastResult === 'string' ? item.lastResult : undefined,
    };
};

/** 把任意值收敛成字符串。引擎内部对规则字段一律 String() 化，这里先做掉，
 *  免得模型传真实布尔/数字进来后，面板的 raw.charAt(0) 直接抛错。 */
const toRuleString = (value: unknown): string => (value == null ? '' : String(value));

/**
 * 引擎内部的数字字面量判据（与主进程引擎同口径，见 TamperRule 类型注释）。
 *
 * 只有严格形式才算数字：007、0x10、Infinity、1.、.5、+1、带空格的都是字符串。
 * get 输出逆解时用它，保证 set 进去的类型能原样回来。
 */
const STRICT_NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * 协议值 → 引擎字符串。
 *
 * 映射是**类型保持**的：JSON 类型原样对应引擎类型，字符串恒强制。
 * 模型写 `"value": 42` 得到数字 42，写 `"value": "42"` 得到字符串 "42" ——
 * 不需要任何 `=` 前缀转义，那是旧协议的东西。
 */
const toEngineValue = (value: unknown): string => {
    if (typeof value === 'string') return `=${value}`;
    if (value === null) return 'null';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

/**
 * 把模型给的字段规则收敛成 TamperRule[]。
 *
 * 协议字段（url_pattern / key / value / op）在这里译成内部形状
 * （urlPattern / jsonPath / newValue），面板与引擎只认后者。
 *
 * 返回 string 表示**出错**（错误消息），返回数组表示成功 —— 用联合类型而不是抛
 * 异常，是因为这里的错误要原样回传给模型让它自己改，不该中断整轮对话。
 * 缺 id 的补一个：面板按 id 做 React key 与删除定位，没有 id 会删错行。
 */
const normalizeFieldRules = (raw: unknown, label: string): TamperRule[] | string => {
    if (!Array.isArray(raw)) return `${label} 必须是数组`;
    const items = raw.map((item) => (item && typeof item === 'object' ? item as Record<string, unknown> : {}));
    for (let i = 0; i < items.length; i += 1) {
        const op = asString(items[i].op) || 'set';
        if (op !== 'set' && op !== 'delete') return `${label}[${i}] 未知 op：${op}（可用 set / delete）`;
        if (op === 'set' && !('value' in items[i])) {
            return `${label}[${i}] 缺少 value（op 为 set 时必须给 value；删字段请用 op delete）`;
        }
    }
    return items.map((r) => {
        const op = asString(r.op) || 'set';
        return {
            id: typeof r.id === 'string' && r.id ? r.id : generateId(),
            enabled: r.enabled !== false,
            urlPattern: toRuleString(r.url_pattern),
            jsonPath: toRuleString(r.key),
            newValue: op === 'delete' ? 'undefined' : toEngineValue(r.value),
        };
    });
};

const normalizeHeaderRules = (raw: unknown): HeaderRule[] | string => {
    if (!Array.isArray(raw)) return 'headers 必须是数组';
    return raw.map((item) => {
        const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        return {
            id: typeof r.id === 'string' && r.id ? r.id : generateId(),
            enabled: r.enabled !== false,
            urlPattern: toRuleString(r.url_pattern),
            headerName: toRuleString(r.name),
            // 空串保持空串：引擎把空 headerValue 解释为「删除该请求头」，
            // 转成别的值会把这个语义弄丢。
            headerValue: toRuleString(r.value),
        };
    });
};

/**
 * 内部规则 → 协议形态。
 *
 * get 必须吐协议形状（key / value / op），不能吐内部形状：模型拿 get 的返回
 * 改几个字段再 set 回去，同一套字段名才能直接复用。类型逆解 set 时的映射，
 * 保证 get → 改 → set 能原样往返。
 */
const fieldRuleToProtocol = (rule: TamperRule): Record<string, unknown> => {
    const base = {
        id: rule.id,
        enabled: rule.enabled,
        url_pattern: rule.urlPattern,
        key: rule.jsonPath,
    };
    const v = rule.newValue;
    if (v === 'undefined') return { ...base, op: 'delete' };
    if (v.startsWith('=')) return { ...base, op: 'set', value: v.slice(1) };
    if (v === 'true') return { ...base, op: 'set', value: true };
    if (v === 'false') return { ...base, op: 'set', value: false };
    if (v === 'null') return { ...base, op: 'set', value: null };
    if (STRICT_NUMBER_RE.test(v)) return { ...base, op: 'set', value: Number(v) };
    return { ...base, op: 'set', value: v };
};

/** 内部请求头规则 → 协议形态（请求头的值恒为字符串，无需类型逆解） */
const headerRuleToProtocol = (rule: HeaderRule): Record<string, unknown> => ({
    id: rule.id,
    enabled: rule.enabled,
    url_pattern: rule.urlPattern,
    name: rule.headerName,
    value: rule.headerValue,
});

/** 解析存储快照；坏了就返回空对象，不让一个坏键毁掉整个 tokens find */
const safeParseObject = (raw: string): Record<string, unknown> => {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
};

/**
 * 把模型给的 cookie 定位参数解析成**具体那一条**。
 *
 *  - `key`：`storage get` / `tokens find` 返回的唯一键，精确匹配，首选；
 *  - `name`：只给名字，向后兼容。**只在没有歧义时才接受** ——
 *    同名 cookie 在不同 domain/path 下并存时（访问子域就会遇到），按名字取第一条
 *    会静默改错对象，甚至把第一条的 httpOnly / 过期时间抄到第二条上。
 *
 * @returns 命中时 `{ cookie }`；否则 `{ error }`（错误文案原样回给模型）
 */
const resolveCookieArg = <T extends { name: string; path?: string; domain?: string }>(
    cookies: T[],
    key: string,
    name: string,
): { cookie: T | null; error?: string } => {
    if (key) {
        const byKey = findCookieByKey(cookies, key);
        if (byKey) return { cookie: byKey };
        // key 给了但没命中：可能是模型自己拼的。有 name 就退回按 name 试，
        // 否则明确报错（不要静默当成新建）。
        if (!name) {
            return { cookie: null, error: `找不到 cookie：${key}。key 要用 storage get 或 tokens find 返回的那个原样传入。` };
        }
    }

    if (!name) return { cookie: null, error: '缺少 name 或 key' };

    const sameName = cookies.filter((c) => c.name === name);
    if (sameName.length > 1) {
        return {
            cookie: null,
            error: `有 ${sameName.length} 条同名 cookie「${name}」，无法确定改哪一条。`
                + '请改用 key 指定（storage get 返回的 key 字段）。',
        };
    }
    return { cookie: sameName[0] || null };
};

/* -------------------------------------------------------------------------- */
/*                                  类型                                       */
/* -------------------------------------------------------------------------- */

export interface AgentDeps {
    getActiveWebview: () => WebviewElement | null;
    /** 页面就绪广播：自动执行的脚本挂在这里，不另挂监听 */
    onPageReady: (cb: (tabId: string, webview: WebviewElement) => void) => () => void;
    /**
     * 篡改引擎的完整状态。
     *
     * 要 state 不只是 actions：规则的真值由 useTamper 持有，`tamper` 的
     * 部分更新必须先读到当前值再合并。Agent 这边**不另存副本** —— 两份真值
     * 迟早会不一致。
     */
    tamper: TamperState;
    /**
     * 知识库取数桥。
     *
     * 与 tamper 同一手法：Agent 不自己 require 主进程、也不碰 window，由 App 把
     * preload 暴露的 kb API 注进来，测试可以直接喂一个假桥。
     * 可空 —— 桥缺失时 kb 工具回结构化错误而不是崩，那是加载故障不是运行环境。
     */
    kb?: KbBridge;
}

/** 知识库桥：preload 暴露的四个方法里 Agent 只用前两个 */
export interface KbBridge {
    load: () => Promise<KbLoadPayload>;
    read: (path: string) => Promise<{ path?: string; content?: string; error?: string }>;
}

export interface AgentState {
    messages: AgentMessage[];
    scripts: AgentScript[];
    status: AgentRunStatus;
    error: string;
    /**
     * 正在流式输出的这一轮（尚未定稿）。
     * 内容实时增长；这一轮结束后它会转成正式的 assistant 消息并清空。
     */
    streaming: { content: string; reasoning: string } | null;
    /**
     * 现在能不能改历史（删除 / 回退 / 清空）。
     *
     * 运行中或压缩中为 false：前者主循环正拿着 messages 追加，此刻改动会和它的
     * 下一次 appendMessage 抢同一个数组；后者压缩正拿着 upTo 锚点做落盘，
     * 此刻改动会让锚点失效。界面据此禁用按钮，而不是让用户点了没反应。
     */
    canEdit: boolean;
    /** 会话累计 token 统计（含当前上下文占用） */
    usage: AgentUsage;
    /**
     * 上下文是否已达硬门槛。为 true 时输入框禁用，且 send() 直接拒绝。
     *
     * 与 canCompact 正交：门槛到了但消息太少时（按当前档位算不出可压的内容），
     * 压缩救不了，只能清空 —— 界面必须分别处理这两种情况。
     */
    contextFull: boolean;
    /**
     * 现在压缩有没有意义：按当前档位至少能覆盖 1 条才压得出东西。
     *
     * 与 contextFull 正交：前者是"满了"，后者是"压得动吗"。合成一个判据会让用户
     * 在两件不同的事之间猜。
     */
    canCompact: boolean;
    /** 正在压缩中（摘要调用在途）。界面据此禁用按钮并显示进度 */
    compacting: boolean;
    /** 当前压缩档位（0.4 / 0.6 / 0.8 / 1），落盘持久化 */
    compactRatio: number;
    actions: {
        send: (prompt: string) => Promise<void>;
        stop: () => void;
        clear: () => void;
        /** 删除单条消息体（只删这一条，不牵连同轮的其他消息） */
        removeMessage: (id: string) => void;
        /**
         * 回退到某条消息**之前**：这条连同它之后的全部移除。
         *
         * 与 removeMessage 同一粒度（都只认这一条），差别在于一个删中间、
         * 一个砍尾巴。返回该条的提问原文供填回输入框；这条不是用户提问时返回空串。
         */
        rewindTo: (id: string) => string;
        /**
         * 把分界线之后的旧消息按当前档位压成结构化摘要，剩下的原样保留。
         *
         * **只由用户手动触发，没有自动压缩。** 压缩是不可逆的历史改写加上一次模型
         * 调用，这两样代价都不该由程序替他决定；程序只负责在 contextFull 时拦住他。
         *
         * 返回压缩记录；无可压消息或正在运行 / 压缩中时返回 null。
         */
        compact: () => Promise<AgentCompaction | null>;
        /**
         * 切换压缩档位（0.4 / 0.6 / 0.8 / 1）。非法值直接忽略 ——
         * 界面只会从 COMPACT_RATIOS 里选，这里是防手写调用传错。
         */
        setCompactRatio: (ratio: number) => void;
        /** 手动执行一段脚本（界面上直接跑，不进对话） */
        runScript: (code: string) => Promise<string>;
        /**
         * 手动执行一条已保存脚本（脚本页的"运行"按钮）。
         *
         * 与自动执行同一套记账：lastRunAt/lastResult 更新 + 一条 tool 消息进对话。
         * 消息标 auto:true —— 它不属于任何一次模型调用，重建上下文时按"环境事件"
         * 写回，与自动执行的消息同一语义。
         *
         * 运行中拒绝：主循环正拿着 webview 跑模型的步骤，此刻手动执行会与它的下一步
         * 交错读页面，两边看到的状态互相污染。规则与改历史一致。
         */
        runScriptNow: (id: string) => Promise<string>;
        removeScript: (id: string) => void;
        toggleScript: (id: string) => void;
    };
}

/**
 * 定稿一轮推理文本：截断到落盘上限，空串归一成 undefined。
 *
 * 抽成**模块级纯函数**是为了能直接单测：它的两个判据都容易写错，且错了不会报错 ——
 * 只会让推理悄悄消失或悄悄膨胀（后者会把落盘预算吃光）。
 * 空串必须转 undefined：否则每条没有推理的消息都多带一个 `reasoning: ""`，
 * 序列化进 localStorage 是实打实的字节，而界面上它什么也不表示。
 */
export const keepReasoning = (raw: string): string | undefined => {
    const text = raw.trim();
    if (!text) return undefined;
    // 措辞与工具返回值区分开：这条不是"回传给模型"，而是"存下来给用户看"
    return truncateBytes(text, REASONING_LIMIT_BYTES, (total, max) => `此处仅保留前 ${max} 字节（原文 ${total} 字节）`);
};

/* -------------------------------------------------------------------------- */
/*                                  Hook                                       */
/* -------------------------------------------------------------------------- */

export const useAgent = (deps: AgentDeps): AgentState => {
    const [messages, setMessages] = useState<AgentMessage[]>(() => {
        const saved = loadJSON<AgentMessage[]>(MESSAGES_STORE_KEY, []);
        if (!Array.isArray(saved)) return [];
        // 存量/损坏数据只做形状过滤，不抛错：一条坏消息不能毁掉整个会话重建。
        // buildTranscript 会遍历每条的 role/result，直接让 null 或缺 role 的
        // 条目进去会在重建时抛错，症状是"打开面板就白屏"。
        return saved
            .filter((m) => !!m && typeof m === 'object'
                && (m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
                && typeof m.id === 'string' && typeof m.content === 'string')
            .slice(-MESSAGES_STORE_MAX);
    });
    const [scripts, setScripts] = useState<AgentScript[]>(() => {
        const saved = loadJSON<unknown[]>(SCRIPTS_STORE_KEY, []);
        if (!Array.isArray(saved)) return [];
        // slice(-MAX) 而非 slice(0, MAX)：超出时保留**最新**的，与落盘侧一致
        return saved.map(normalizeScript).filter((s): s is AgentScript => !!s).slice(-SCRIPTS_STORE_MAX);
    });
    const [status, setStatus] = useState<AgentRunStatus>('idle');
    const [error, setError] = useState('');
    const [streaming, setStreaming] = useState<{ content: string; reasoning: string } | null>(null);
    // 压缩在途标记。与 status 分开：压缩不是 Agent 的运行状态（它不碰页面、也不属于
    // 任何一轮），混进 AgentRunStatus 会让"运行中禁止改历史"那条闸门把压缩自己挡住。
    const [compacting, setCompacting] = useState(false);
    /**
     * 压缩在途的同步镜像。state 翻转要等重渲染，两次调用挤在同一帧里都会通过
     * `compacting` 的检查 —— 落两条分界线、白花一次摘要调用。ref 当场可见，
     * state 只留给界面显示。
     */
    const compactingRef = useRef(false);
    /**
     * 当前压缩档位。非法存量（旧版本 / 手改 localStorage）回落到默认，
     * 不能让一个脏值把压缩判据搞成 NaN。
     */
    const [compactRatio, setCompactRatioState] = useState<number>(() => {
        const saved = loadJSON<unknown>(COMPACT_RATIO_STORE_KEY, COMPACT_RATIO_DEFAULT);
        return typeof saved === 'number' && (COMPACT_RATIOS as readonly number[]).includes(saved)
            ? saved
            : COMPACT_RATIO_DEFAULT;
    });
    const setCompactRatio = useCallback((ratio: number) => {
        if (!(COMPACT_RATIOS as readonly number[]).includes(ratio)) return;
        setCompactRatioState(ratio);
        saveJSON(COMPACT_RATIO_STORE_KEY, ratio);
    }, []);

    // 落盘按字节预算收敛（见 STORE_BUDGET_* 注释）。
    // 每次追加都全量序列化整个数组是这条路的固有成本，用预算把上界压住。
    useEffect(() => {
        saveJSON(MESSAGES_STORE_KEY, trimToBudget(messages, STORE_BUDGET_MESSAGES).slice(-MESSAGES_STORE_MAX));
    }, [messages]);
    useEffect(() => {
        saveJSON(SCRIPTS_STORE_KEY, trimToBudget(scripts, STORE_BUDGET_SCRIPTS).slice(-SCRIPTS_STORE_MAX));
    }, [scripts]);

    // 最新值镜像：dom-ready 回调里要读当前脚本清单，不能绑订阅时的快照
    const scriptsRef = useRef(scripts);
    useEffect(() => { scriptsRef.current = scripts; }, [scripts]);

    // 对话历史镜像。send() 要读**本轮开始之前**的历史来重建模型上下文，而它读不了
    // messages：send 开头的 appendMessage 只是排队了一次 setState，同一次渲染的闭包里
    // messages 仍是旧值 —— 依赖 messages 还会让 send 的身份每来一条消息就变一次，
    // 把 BrowsePanel 里依赖它的 useCallback 全部击穿。
    const messagesRef = useRef(messages);
    useEffect(() => { messagesRef.current = messages; }, [messages]);

    // 篡改引擎镜像，同理：dispatchTool 在 await 之间读它，绑快照会读到旧规则。
    // 存整个 TamperState 而不是拆成几个字段：state 与 actions 必须来自同一次渲染，
    // 混用两次渲染的切片会让"读到的旧规则"与"写入的新规则"打架。
    const tamperRef = useRef(deps.tamper);
    useEffect(() => { tamperRef.current = deps.tamper; }, [deps.tamper]);

    /**
     * 知识库桥镜像。
     *
     * 与 tamperRef 同一理由：dispatchTool 的依赖数组里没有 deps.kb（它由 preload
     * 暴露，引用天然稳定），但派发发生在 await 之间，读镜像比赌闭包捕获的是哪一次
     * 渲染可靠。
     */
    const kbBridgeRef = useRef(deps.kb);
    useEffect(() => { kbBridgeRef.current = deps.kb; }, [deps.kb]);

    /**
     * 知识库索引缓存。
     *
     * 整库约 3MB 正文，解析一次要遍历全部 front-matter。缓存**存在性**而不是内容：
     * `entries` 为 null 表示还没读过，空数组表示读过但库里一篇文章都没有 ——
     * 后者不能当"没读过"再读一遍。同时缓存一个在途 Promise：模型可能一步里连发两次
     * search，没有它就会并发读两遍整库。
     */
    const kbCacheRef = useRef<{ entries: KbEntry[] | null; inflight: Promise<KbEntry[]> | null }>({
        entries: null,
        inflight: null,
    });

    // 停止标志。不能靠 state：循环体在 await 之间读它，state 更新不会及时可见
    const stoppedRef = useRef(false);
    const busyRef = useRef(false);
    // 在途请求的中断句柄：点停止要真掐断连接，而不是等整包回来再丢弃
    const abortRef = useRef<AbortController | null>(null);

    const appendMessage = useCallback((message: AgentMessage) => {
        setMessages((prev) => [...prev, message].slice(-MESSAGES_STORE_MAX));
    }, []);

    /**
     * 把压缩分界线插到**它覆盖的最后一条消息之后**，而不是追加到末尾。
     *
     * 位置就是语义：这条线以上的轮次已不在模型上下文里。追加到末尾的话，界面上它
     * 出现在最新一轮下方，读起来像"压缩发生在刚才"—— 而用户需要知道的是"线以上
     * 那些，模型已经看不见了"。导出 Markdown 时同理。
     */
    const insertAfterMessage = useCallback((afterId: string, message: AgentMessage) => {
        setMessages((prev) => insertAfterId(prev, afterId, message).slice(-MESSAGES_STORE_MAX));
    }, []);

    /* ------------------------------ 上下文压缩 ------------------------------ */

    /**
     * 把分界线之后的旧消息按当前档位压成摘要，剩下的原样保留。
     *
     * 四条不可让步的判据：
     *
     * 1. **分界线是一条消息，不是一份旁挂的状态。** 摘要正文就存在这条消息上，
     *    用户回退到压缩点之前时那条消息被删掉，摘要自动作废（见 splitByCompaction）。
     * 2. **压缩本身也要计费。** 摘要调用的 usage 一并记进这条消息，漏掉它会让
     *    "这个会话花了多少"在压缩过的会话里系统性偏低。
     * 3. **压完可能仍超门槛。** 此时必须如实标注 overBudget —— 报一个绿色的
     *    "压缩完成"会把用户引向错误的安心，而输入框仍然禁用着。
     * 4. **只压分界线之后的新内容。** 全量重算会让第二次压缩把已经压过的
     *    再压一遍：白花一次调用，coveredMessages 注水，而 priorSummary
     *    的链式设计本来就是为增量准备的。
     */
    const compact = useCallback(async (): Promise<AgentCompaction | null> => {
        // 与手动执行脚本同一套闸门：运行中压缩会和主循环抢 messages。更要紧的是主循环
        // 手上的 transcript 是**开始那一刻**重建的，中途换掉历史对它没有任何影响 ——
        // 用户会以为压缩没生效。
        // 读 ref 不读 state：连点时 state 还没翻转，ref 当场可见（见 compactingRef）。
        if (busyRef.current || compactingRef.current) return null;

        const list = messagesRef.current;
        // 分界线之后的消息才是"还没被压过的"。从全量算的话，第二次压缩会把
        // 第一次已经压过的重新送进摘要器 —— 越压越贵，而界面上只显示"压缩成功"。
        const { messages: live, summary: priorSummary } = splitByCompaction(list);
        // 按档位从前往后覆盖：旧的先进摘要器，当前的"工作集"（刚做了什么、
        // 什么失败了）留在原文里。count 与界面上的 canCompact 必须同源
        // （同一个 compactCoverCount），否则按钮可点但点了什么都不发生。
        const coverCount = compactCoverCount(live.length, compactRatio);
        if (coverCount < 1) return null;
        const covered = live.slice(0, coverCount);

        // 上一次的摘要必须**显式**带进来：它在 messages 里是一条 compaction 消息，
        // 而 roundToMessages 会跳过这类消息（live 里本来就没有它），不显式拼一遍
        // 的话，第二次压缩会把第一次的摘要整个丢掉 —— 越压越少，
        // 而界面上只显示"压缩成功"。
        //
        // 预算从后往前分配，保证**离现在最近的旧消息**优先进入摘要 —— 它们与当前
        // 任务的相关性最高。转出来是空的消息先滤掉：assistant 的空回复、既无结果
        // 又无正文的 tool 记录，它们既不该占预算，也不该被算进下面那两个
        // **给用户看**的消息数，否则 coveredMessages - summarizedMessages 的差额
        // 会把"空消息"混进"因超预算被丢弃的消息"。
        const summarizable = covered
            .map((message) => roundToMessages([message]))
            .filter((converted) => converted.length > 0);
        const budgeted = trimToBudget(summarizable, COMPACT_INPUT_BUDGET_BYTES);
        // summarizedMessages 是真正进了摘要器的，coveredMessages 是被这次压缩移出
        // 上下文的；差额即"超出摘要输入上限、连摘要都没进"的那些，
        // 界面必须如实说出这个差额。
        const summarizedMessages = budgeted.length;
        // 刻意不叫 transcript：那是 send() 里"发给模型的本轮上下文"的名字，而这份是
        // **送进摘要器的历史原文**，两者的生命周期与用途都不同，同名会把人搞混。
        const digest: AiChatMessage[] = priorSummary
            ? [{ role: 'user', content: `${COMPACT_PREFIX}\n${priorSummary}` }, ...budgeted.flat()]
            : budgeted.flat();

        compactingRef.current = true;
        setCompacting(true);
        setError('');
        try {
            let usage: AiUsage | undefined;
            const body = await chat({
                system: COMPACT_SYSTEM_PROMPT,
                messages: digest,
                maxTokens: COMPACT_MAX_TOKENS,
                // 摘要要的是忠实，不是创意：温度压到最低能显著减少"顺手补全"的编造
                temperature: 0,
                reasoningEffort: 'low',
                onUsage: (u) => { usage = u; },
            });

            const summary = body.trim();
            // 空摘要不能落盘：那等于把一段历史换成了空白，而且没有任何提示
            if (!summary) {
                setError('压缩失败：模型没有返回摘要内容，历史未改动。');
                return null;
            }

            const beforeTokens = estimatePromptTokens(buildTranscript(list));
            const upTo = covered[covered.length - 1].id;
            const next: AgentCompaction = {
                summary,
                upTo,
                at: Date.now(),
                // 用 summarizable 而不是 covered：空消息不该出现在给用户看的消息数里
                coveredMessages: summarizable.length,
                summarizedMessages,
                beforeTokens,
                afterTokens: 0,
                overBudget: false,
                ...(usage ? { usage } : {}),
            };

            // afterTokens 要按**压缩真正生效后**的消息序列算：那一刻新消息
            // 还没进 state，只能先用同一个 insertAfterId 拼出来。
            // 不能只拿摘要的 token 数自己估 —— 保留的那些也占地方，
            // 漏掉它们会低估一大截，而 overBudget 的判据正是建立在这个数上。
            const marker: AgentMessage = {
                id: generateId(),
                role: 'assistant',
                content: summary,
                compaction: next,
                at: next.at,
            };
            const after = insertAfterId(list, upTo, marker);
            next.afterTokens = estimatePromptTokens(buildTranscript(after));
            next.overBudget = next.afterTokens >= CONTEXT_LIMIT_TOKENS;

            // 落盘前再确认一次锚点还在：压缩是异步的，这期间历史可能被改过
            // （回退 / 删除 / 清空）。锚点没了还硬插，insertAfterId 会兜底追加到末尾，
            // 摘要就会名义上覆盖**全部**历史 —— 保留的那些会被静默吞掉。
            // 丢弃这次摘要是安全方向：历史原样不动，只是白花一次调用。
            // 界面侧已用 canEdit 禁掉压缩中的改历史操作，这里是防程序化调用。
            if (!messagesRef.current.some((m) => m.id === upTo)) {
                setError('压缩期间对话发生了变化，本次摘要已丢弃，历史未改动。');
                return null;
            }
            insertAfterMessage(upTo, marker);
            // 成功后清掉报错：压缩在途时 send() 的拒绝会写一条"请稍候"，
            // 压缩完了它就过期了，留着会指向一个已经不存在的状态。
            setError('');

            return next;
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            setError(`压缩失败：${reason}`);
            return null;
        } finally {
            compactingRef.current = false;
            setCompacting(false);
        }
    }, [insertAfterMessage, compactRatio]);

    /* ------------------------------ 脚本执行 ------------------------------ */

    /**
     * 脚本执行的串行队列。
     *
     * 模型步骤与自动脚本都会进 execOn，而 webview.executeJavaScript 的并发语义
     * 不可靠：两段脚本交错读页面时，双方看到的都是对方改了一半的状态。
     * 串行后"谁先谁后"有明确顺序，排查时能复现。队列自身吞掉异常 ——
     * 某一次失败不能把排在后面的全部卡死（与 server.js 的上游队列同一理由）。
     */
    const execQueueRef = useRef<Promise<unknown>>(Promise.resolve());

    /**
     * 页面脚本单次执行超时（毫秒）。
     *
     * executeJavaScript 没有 abort：页面死循环时这个 Promise 永远不 settle，
     * stop() 够不到它，主循环会卡死在"正在页面里执行…"。超时后按普通工具
     * 失败回灌，模型能读到原因并换路，用户点停止也不会卡住。
     */
    const EXEC_TIMEOUT_MS = 60000;

    const execOn = useCallback(async (webview: WebviewElement, code: string): Promise<string> => {
        const task = async (): Promise<string> => {
            const run = (async () => {
                try {
                    const raw = await webview.executeJavaScript(buildScriptSource(code));
                    return truncateBytes(typeof raw === 'string' ? raw : String(raw), RESULT_LIMIT_BYTES);
                } catch (e) {
                    // 脚本抛错不是终点：把错误原样交给模型，它自己改代码重试。
                    // 走 __agentError 通道（见 buildScriptSource），不与页面数据
                    // 里合法的 {error} 字段混淆。
                    const reason = e instanceof Error ? e.message : String(e);
                    return JSON.stringify({ __agentError: reason });
                }
            })();

            const timeout = new Promise<string>((resolve) => {
                window.setTimeout(() => {
                    resolve(JSON.stringify({
                        __agentError: `脚本执行超过 ${EXEC_TIMEOUT_MS / 1000} 秒未返回（页面可能在死循环或弹窗阻塞）。请把任务拆小：先取少量字段确认选择器，再分步推进，不要一次 return 整个页面。`,
                    }));
                }, EXEC_TIMEOUT_MS);
            });

            // 超时只是"不等了"，不是"掐断了"：后返回的 run 结果会被丢弃，
            // 队列按 race 的 settle 推进，不会因此卡住。
            return Promise.race([run, timeout]);
        };

        const queued: Promise<string> = execQueueRef.current.then(task, task);
        execQueueRef.current = queued.then(() => undefined, () => undefined);
        return queued;
    }, []);

    const execActive = useCallback(async (code: string): Promise<string> => {
        const webview = deps.getActiveWebview();
        if (!webview) return JSON.stringify({ error: '当前没有可用的页面（标签页是空白页或未就绪）' });
        return execOn(webview, code);
    }, [deps.getActiveWebview, execOn]);

    /**
     * 等**指定那个** webview 就绪。
     *
     * 三个必须带上的条件：
     *  - 比对 webview 身份 —— onPageReady 是全局广播，不校验的话别的标签页加载完也会
     *    resolve(true)，navigate 会带着"已加载"的错误结论返回；
     *  - 监听 stoppedRef —— 否则点停止后这个 Promise 要等满 timeout 才结束，
     *    期间界面一直停在"正在页面里执行…"。
     *  - 可取消 —— navigate 里先订阅再 loadURL，loadURL 抛错时必须能取消这次
     *    等待，否则定时器与广播订阅泄漏到 15 秒超时（并持续轮询 stoppedRef）。
     */
    const waitForPageReady = useCallback((webview: WebviewElement, timeoutMs = 15000) => {
        let cancel: () => void = () => { };
        const promise = new Promise<boolean>((resolve) => {
            let done = false;
            let poll: number | null = null;
            let deadline: number | null = null;
            let unsubscribe: () => void = () => { };

            const finish = (ok: boolean) => {
                if (done) return;
                done = true;
                if (poll !== null) window.clearInterval(poll);
                if (deadline !== null) window.clearTimeout(deadline);
                unsubscribe();
                resolve(ok);
            };

            cancel = () => finish(false);

            unsubscribe = deps.onPageReady((_tabId, readyWebview) => {
                if (readyWebview === webview) finish(true);
            });

            // 轮询停止标志：stop() 只置标志位与 abort 在途 fetch，够不到这个 Promise。
            // 不轮询的话，navigate 后点停止要等满 timeout 才结束，界面一直停在"正在执行…"。
            poll = window.setInterval(() => {
                if (stoppedRef.current) finish(false);
            }, 100);

            deadline = window.setTimeout(() => finish(false), timeoutMs);
        });
        return Object.assign(promise, { cancel });
    }, [deps.onPageReady]);

    /* ------------------------------ 工具派发 ------------------------------ */

    const dispatchTool = useCallback(async (
        tool: AgentToolName,
        args: Record<string, unknown>
    ): Promise<string> => {
        switch (tool) {
            /**
             * js —— 在当前页面主世界跑一段脚本。
             *
             * 无 action：整个工具就做这一件事。空 code 直接报错 ——
             * 空跑一步的代价不是零，这一步的结果（哪怕是 null）会被后续每一步重发。
             */
            case 'js': {
                const code = asString(args.code);
                if (!code.trim()) return JSON.stringify({ error: '缺少 code（要运行的 JS，必须显式 return 一个可序列化值）' });
                return execActive(code);
            }

            /**
             * script_store —— 脚本的持久化管理（列出 / 保存 / 更新 / 删除）。
             *
             * 与 js 分开：一个管"跑一次"，一个管"存下来复用"。动作全小写严格匹配。
             */
            case 'script_store': {
                const action = asString(args.action);

                if (action === 'list') {
                    return JSON.stringify(scriptsRef.current.map((s) => ({
                        id: s.id, name: s.name, description: s.description,
                        url_pattern: s.urlPattern, enabled: s.enabled,
                    })));
                }

                if (action === 'save') {
                    const code = asString(args.code);
                    if (!code.trim()) return JSON.stringify({ error: '缺少 code' });
                    if (scriptsRef.current.length >= SCRIPTS_STORE_MAX) {
                        // 满了就明说，不能静默丢弃：原先 slice(0, MAX) 砍掉的正是刚加进去的
                        // 那一条（在数组末尾），却仍回 {saved:true}，模型会一直找不到它。
                        return JSON.stringify({
                            error: `脚本数量已达上限 ${SCRIPTS_STORE_MAX}，请先用 script_store 的 delete 删掉不用的`,
                        });
                    }
                    const script: AgentScript = {
                        id: generateId(),
                        name: asString(args.name) || '未命名脚本',
                        description: asString(args.description),
                        code,
                        urlPattern: asString(args.url_pattern),
                        enabled: true,
                    };
                    setScripts((prev) => [...prev, script].slice(-SCRIPTS_STORE_MAX));
                    return JSON.stringify({ saved: true, id: script.id, name: script.name });
                }

                /**
                 * 按 id 部分更新：只改传了的字段，其余保留。
                 *
                 * 没有它时模型改脚本要走 delete+save 两步 —— 中间那一步清单里就没有这个脚本，
                 * 若 delete 成功而 save 的 code 恰好写错，等于亲手删掉了原来能跑的版本。
                 */
                if (action === 'update') {
                    const id = asString(args.id);
                    const existing = scriptsRef.current.find((s) => s.id === id);
                    if (!existing) {
                        return JSON.stringify({ error: `找不到脚本 ${id}（id 从 list 的返回里取）` });
                    }
                    if (args.code !== undefined) {
                        const code = asString(args.code);
                        if (!code.trim()) return JSON.stringify({ error: 'code 传了就不能为空（不想改就别传这个字段）' });
                    }
                    setScripts((prev) => prev.map((s) => {
                        if (s.id !== id) return s;
                        return {
                            ...s,
                            ...(typeof args.name === 'string' ? { name: args.name || '未命名脚本' } : {}),
                            ...(typeof args.description === 'string' ? { description: args.description } : {}),
                            ...(typeof args.code === 'string' ? { code: args.code } : {}),
                            ...(typeof args.url_pattern === 'string' ? { urlPattern: args.url_pattern } : {}),
                            ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
                        };
                    }));
                    return JSON.stringify({ updated: true, id });
                }

                if (action === 'delete') {
                    const id = asString(args.id);
                    const exists = scriptsRef.current.some((s) => s.id === id);
                    if (!exists) return JSON.stringify({ error: `找不到脚本 ${id}` });
                    setScripts((prev) => prev.filter((s) => s.id !== id));
                    return JSON.stringify({ deleted: true, id });
                }

                return JSON.stringify({ error: unknownActionError(action, ['list', 'save', 'update', 'delete']) });
            }

            case 'navigate': {
                const raw = asString(args.url).trim();
                if (!raw) return JSON.stringify({ error: '缺少 url' });
                const webview = deps.getActiveWebview();
                if (!webview) return JSON.stringify({ error: '当前没有可用的页面' });

                /**
                 * 模型从页面里读到的地址常常不是完整 URL（相对路径 /api/user、裸域名
                 * example.com）。直接 loadURL 会失败或落到奇怪的地方，而失败信息
                 * （ERR_…）指不出"缺协议"这个真正原因。在这里归一：有协议原样，
                 * / 开头相对当前页解析，其余补 https://。回显归一后的最终地址 ——
                 * 模型下一步的 js 要基于它判断。
                 */
                let url = raw;
                try {
                    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
                        url = raw;
                    } else if (raw.startsWith('/')) {
                        url = new URL(raw, readWebviewUrl(webview)).href;
                    } else {
                        url = `https://${raw}`;
                    }
                } catch {
                    return JSON.stringify({ error: `地址解析失败：${raw}（相对路径需要当前页面地址可读）` });
                }

                const ready = waitForPageReady(webview);
                try {
                    await webview.loadURL(url);
                } catch (e) {
                    // 先订阅后导航：loadURL 抛错时等待必须取消，否则定时器与
                    // 广播订阅泄漏到超时，且这 15 秒里一直轮询 stoppedRef。
                    ready.cancel();
                    return JSON.stringify({ error: `导航失败：${e instanceof Error ? e.message : String(e)}` });
                }
                const ok = await ready;
                return JSON.stringify({ url, loaded: ok, currentUrl: readWebviewUrl(webview) });
            }

            case 'tamper': {
                const action = asString(args.action) || 'get';
                const current = tamperRef.current.state;

                if (action === 'get') {
                    return JSON.stringify({
                        intercept: current.interceptRules.map(fieldRuleToProtocol),
                        request: current.requestRules.map(fieldRuleToProtocol),
                        headers: current.headerRules.map(headerRuleToProtocol),
                        // 说清"生效"与"持久"的区别：模型需要知道用户还得点一下才存住
                        note: '这些规则已对当前页面生效。改动只在内存里，用户需在面板点「应用更改」才会持久化。',
                    });
                }

                if (action !== 'set') {
                    return JSON.stringify({ error: unknownActionError(action, ['get', 'set']) });
                }

                // 部分更新：只合并传了的类别，其余原样保留 —— 否则模型只想加一条请求头
                // 规则，却会把用户的拦截规则全清空。
                const nextIntercept = args.intercept === undefined
                    ? current.interceptRules
                    : normalizeFieldRules(args.intercept, 'intercept');
                const nextRequest = args.request === undefined
                    ? current.requestRules
                    : normalizeFieldRules(args.request, 'request');
                const nextHeaders = args.headers === undefined
                    ? current.headerRules
                    : normalizeHeaderRules(args.headers);

                if (typeof nextIntercept === 'string') return JSON.stringify({ error: nextIntercept });
                if (typeof nextRequest === 'string') return JSON.stringify({ error: nextRequest });
                if (typeof nextHeaders === 'string') return JSON.stringify({ error: nextHeaders });

                // applyRules 而非 saveRules：模型改规则立刻生效，但不越过用户写进本地存储
                tamperRef.current.actions.applyRules(nextIntercept, nextRequest, nextHeaders);

                // 报出会被引擎跳过的规则。引擎对没有目标键的规则直接丢弃（它永远匹配
                // 不上），但那是**静默**的 —— 不回传的话模型收到 applied:true 就以为
                // 设置成功了，实际页面里什么都没发生，而它会一直不知道为什么"改了没反应"。
                // 带上 group+index+原因，一步就能改对。
                const dropped = collectDroppedRules({
                    intercept: nextIntercept,
                    request: nextRequest,
                    headers: nextHeaders,
                });

                return JSON.stringify({
                    applied: true,
                    counts: {
                        intercept: nextIntercept.length,
                        request: nextRequest.length,
                        headers: nextHeaders.length,
                    },
                    // 只在真有时才带这个字段：空数组会让模型误以为"有被跳过的"
                    ...(dropped.length > 0 ? { dropped } : {}),
                    note: dropped.length > 0
                        ? `已对当前页面生效，但有 ${dropped.length} 条被引擎跳过（见 dropped），这些规则不会生效。未写入本地存储，用户点「应用更改」后才持久化。`
                        : '已对当前页面生效。未写入本地存储，用户点「应用更改」后才持久化。',
                });
            }

            case 'storage': {
                const action = asString(args.action) || 'get';
                const area = asString(args.area) || 'local';
                if (area !== 'local' && area !== 'session' && area !== 'cookie') {
                    return JSON.stringify({ error: `未知 area：${area}（可用 local / session / cookie）` });
                }
                // 先验动作、再验参数：与 tokens 同一理由，写错大小写必须报未知 action，
                // 不能报"缺少 key"把模型带偏。
                if (action !== 'get' && action !== 'set' && action !== 'delete') {
                    return JSON.stringify({ error: unknownActionError(action, ['get', 'set', 'delete']) });
                }

                if (area === 'cookie') {
                    if (action === 'get') {
                        const cookies = await tamperRef.current.actions.getCookies();
                        const keys = buildCookieKeys(cookies);
                        return JSON.stringify({
                            count: cookies.length,
                            // key 与 tokens find 用同一套唯一键：同名 cookie 在不同域下
                            // 并存时，模型必须能指定改哪一条（set / delete 都收 key）。
                            cookies: cookies.map((c, i) => ({
                                key: keys[i],
                                name: c.name, value: c.value, domain: c.domain, path: c.path,
                                httpOnly: c.httpOnly, secure: c.secure,
                                sameSite: c.sameSite, expirationDate: c.expirationDate,
                            })),
                            note: '这是真实值。页面 JS 读到的可能被拦截规则改写。set / delete 请用 key 指定是哪一条。',
                        });
                    }

                    // 只收 key：同名 cookie 在不同 domain/path 下并存时（访问子域
                    // 就会遇到），按名字取第一条会静默改错对象，甚至把另一条的
                    // httpOnly / 过期时间抄过来造成降级。key 必须用 get 返回的原样值。
                    const key = asString(args.key);
                    if (!key) return JSON.stringify({ error: '缺少 key（用 storage get 返回的 key 字段原样传入）' });

                    if (action === 'delete') {
                        const list = await tamperRef.current.actions.getCookies();
                        const target = resolveCookieArg(list, key, '');
                        if (target.error) return JSON.stringify({ error: target.error });
                        // 没命中不能当成"删掉了"：removeCookie 按 name 删，传一个不存在的
                        // 名字 Electron 也不报错，静默返回成功。
                        if (!target.cookie) {
                            return JSON.stringify({ error: `找不到 cookie：${key}` });
                        }
                        const ok = await tamperRef.current.actions.removeCookie(target.cookie.name);
                        return ok
                            ? JSON.stringify({ deleted: true, name: target.cookie.name, note: '同名不同 path 的 Cookie 会被一起删掉。' })
                            : JSON.stringify({ error: '删除失败：当前没有可用的页面地址' });
                    }

                    // 到这里只剩 set（未知 action 已在入口拦掉）
                    // 已存在则取回原属性再改值 —— setCookie 是整条覆盖，漏掉 httpOnly /
                    // expirationDate 会让会话 cookie 降级甚至掉登录态。key 找不到时
                    // 直接报错：编一个 key 等于在猜改哪一条，比报错更难查。
                    const list = await tamperRef.current.actions.getCookies();
                    const target = resolveCookieArg(list, key, '');
                    if (target.error) return JSON.stringify({ error: target.error });
                    const existing = target.cookie;
                    if (!existing) return JSON.stringify({ error: `找不到 cookie：${key}` });
                    // 值统一成字符串：cookie 只能是字符串，而 asString 会把数字/布尔
                    // 变成空串 —— 那等于静默清空这条 cookie，比报错更难查。
                    // 对象用 JSON 而不是 String()：后者得到 "[object Object]"，
                    // 写进去等于亲手毁掉这条 cookie 的值，且回显看不出原值是什么。
                    const cookieValue = typeof args.value === 'string'
                        ? args.value
                        : (args.value != null && typeof args.value === 'object'
                            ? JSON.stringify(args.value)
                            : String(args.value ?? ''));
                    const ok = await tamperRef.current.actions.setCookie({
                        ...existing,
                        value: cookieValue,
                    });
                    return ok
                        ? JSON.stringify({
                            // 回显写进去的那个值，不是原始入参 —— 两者会被上面的转换拉开
                            saved: true, name: existing.name, value: cookieValue,
                            preserved: '已保留原有 httpOnly / sameSite / 过期时间',
                        })
                        : JSON.stringify({ error: '写入失败：当前没有可用的页面地址' });
                }

                const read = area === 'local'
                    ? tamperRef.current.actions.getLocalStorage
                    : tamperRef.current.actions.getSessionStorage;

                if (action === 'get') {
                    const raw = await read();
                    // 展开成对象再返回，而不是把 JSON 字符串塞进 data：塞字符串的话模型
                    // 得对着 "{\"k\":\"v\"}" 再解一次，多一层转义既费 token 又容易误判成
                    // "没有数据"。
                    return JSON.stringify({
                        area,
                        data: safeParseObject(raw),
                        note: '这是真实值（绕过拦截规则读的）。页面 JS 读到的可能被规则改写。',
                    });
                }

                const key = asString(args.key);
                if (!key) return JSON.stringify({ error: '缺少 key' });

                if (action === 'delete') {
                    const fn = area === 'local'
                        ? tamperRef.current.actions.removeLocalStorage
                        : tamperRef.current.actions.removeSessionStorage;
                    const ok = await fn(key);
                    return ok
                        ? JSON.stringify({ deleted: true, area, key })
                        : JSON.stringify({ error: '删除失败：页面可能已禁用存储，或没有可用的页面' });
                }

                // 到这里只剩 set（未知 action 已在入口拦掉）
                const fn = area === 'local'
                    ? tamperRef.current.actions.setLocalStorage
                    : tamperRef.current.actions.setSessionStorage;
                // 值统一转成字符串：Storage 规范规定存进去的只能是字符串，
                // 传数字/对象进来会被浏览器隐式转成 "[object Object]"，不如自己转干净。
                const value = typeof args.value === 'string' ? args.value : JSON.stringify(args.value ?? '');
                const ok = await fn(key, value);
                return ok
                    ? JSON.stringify({ saved: true, area, key, value })
                    : JSON.stringify({ error: '写入失败：页面可能已禁用存储或配额已满' });
            }

            case 'tokens': {
                const action = asString(args.action) || 'find';
                // 先验动作、再验参数：写错大小写（FIND）时必须报未知 action，
                // 不能报"缺少 token" —— 后者会让模型去补 token，补完还是错。
                if (action !== 'find' && action !== 'decode' && action !== 'rewrite') {
                    return JSON.stringify({ error: unknownActionError(action, ['find', 'decode', 'rewrite']) });
                }

                if (action === 'find') {
                    const cookies = await tamperRef.current.actions.getCookies();
                    const local = safeParseObject(await tamperRef.current.actions.getLocalStorage());
                    const session = safeParseObject(await tamperRef.current.actions.getSessionStorage());

                    // 来源要标出来：模型下一步 rewrite 时必须知道写回哪里。key 必须是
                    // **能写回去的键**：storage 用存储键名，cookie 用面板同款的唯一键
                    // （name + path + domain）—— 直接用 cookie 名不行：访问子域时同名
                    // cookie 会并存，两条的 from 完全相同、rewrite 又只命中先出现的那条，
                    // 于是第二条永远改不到，模型还看不出有两条。也不能把 cookie 数组交给
                    // 下面这个按 Object.entries 枚举的 helper —— 数组的键是 "0"/"1" 下标。
                    //
                    // 去重按**位置**而不是按 token 值：同一个 token 常常同时躺在
                    // local / session / cookie 里（登录态就是这种形态）。按值去重会让模型
                    // 只看到其中一处，改写完另一处仍是旧值 —— 而页面读的可能正是那一处。
                    const cookieKeys = buildCookieKeys(cookies);
                    const found: { token: string; from: string; area: string; key: string }[] = [];
                    const seenAt = new Set<string>();
                    const add = (entries: [string, unknown][], area: string) => {
                        for (const [key, value] of entries) {
                            const at = `${area}.${key}`;
                            if (seenAt.has(at)) continue;
                            seenAt.add(at);
                            for (const token of pickJwtCandidates([value])) {
                                found.push({ token, from: at, area, key });
                            }
                        }
                    };
                    add(Object.entries(local), 'local');
                    add(Object.entries(session), 'session');
                    add(cookies.map((c, i) => [cookieKeys[i], c.value] as [string, unknown]), 'cookie');

                    // 同一个 token 出现在多处时点出来：模型需要知道"改一处不够"。
                    const byToken = new Map<string, number>();
                    for (const f of found) byToken.set(f.token, (byToken.get(f.token) || 0) + 1);
                    const shared = [...byToken.entries()]
                        .filter(([, n]) => n > 1)
                        .map(([token, n]) => ({ token, count: n }));

                    return JSON.stringify({
                        count: found.length,
                        tokens: found.map((f) => ({ token: f.token, from: f.from, area: f.area, key: f.key })),
                        // 只在真有多处时才带：空数组会被误读成"有共享 token"
                        ...(shared.length > 0 ? { sharedTokens: shared } : {}),
                    });
                }

                const token = asString(args.token);
                if (!token) return JSON.stringify({ error: '缺少 token' });

                if (action === 'decode') {
                    try {
                        const { header, payload } = decodeJwt(token);
                        return JSON.stringify({ header, payload });
                    } catch (e) {
                        return JSON.stringify({ error: `解码失败：${e instanceof Error ? e.message : String(e)}` });
                    }
                }

                // 到这里只剩 rewrite（未知 action 已在入口拦掉）
                const changes = args.changes;
                if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
                    return JSON.stringify({ error: '缺少 changes（要合并进 payload 的字段对象）' });
                }

                const area = asString(args.area) || 'local';
                const key = asString(args.key);
                if (!key) return JSON.stringify({ error: '缺少 key（改完写回哪个位置）' });

                let next: string;
                try {
                    next = rewriteJwtPayload(token, changes as Record<string, unknown>);
                } catch (e) {
                    return JSON.stringify({ error: `改写失败：${e instanceof Error ? e.message : String(e)}` });
                }

                if (area === 'cookie') {
                    // key 是 find 给出的唯一键（name + path + domain），必须用它取回，
                    // 不能只按 name —— 同名 cookie 并存时会永远命中第一条。
                    const list = await tamperRef.current.actions.getCookies();
                    const existing = findCookieByKey(list, key);
                    if (!existing) {
                        return JSON.stringify({
                            error: `找不到 cookie：${key}。key 要用 tokens find 返回的那个原样传入。`,
                        });
                    }
                    const ok = await tamperRef.current.actions.setCookie({ ...existing, value: next });
                    if (!ok) return JSON.stringify({ error: '写回失败：当前没有可用的页面地址' });
                } else if (area === 'local' || area === 'session') {
                    const fn = area === 'local'
                        ? tamperRef.current.actions.setLocalStorage
                        : tamperRef.current.actions.setSessionStorage;
                    const ok = await fn(key, next);
                    if (!ok) return JSON.stringify({ error: '写回失败：页面可能已禁用存储或配额已满' });
                } else {
                    return JSON.stringify({ error: `未知 area：${area}（可用 local / session / cookie）` });
                }

                return JSON.stringify({
                    rewritten: true,
                    area,
                    key,
                    token: next,
                    warning: '签名已失效 —— 签名覆盖的正是 payload，服务端验签就会拒绝。这是这类调试的固有前提。',
                });
            }

            case 'kb': {
                const bridge = kbBridgeRef.current;
                if (!bridge) {
                    return JSON.stringify({
                        error: '知识库不可用：当前不在 Electron 环境里，没有取数通道。',
                    });
                }

                const action = asString(args.action) || 'search';

                /**
                 * 取索引，必要时读一次整库。
                 *
                 * 失败不缓存：路径配错时用户会去改设置，缓存住错误就再也读不到新路径。
                 * 成功才写进 entries —— 空库是合法状态，必须与"没读过"区分开。
                 */
                const getEntries = async (): Promise<KbEntry[]> => {
                    const cache = kbCacheRef.current;
                    if (cache.entries) return cache.entries;
                    if (cache.inflight) return cache.inflight;

                    const task = (async () => {
                        const payload = await bridge.load();
                        if (payload?.error) throw new Error(payload.error);
                        const built = buildKbIndex(payload?.files || [], payload?.boardIndexes || {});
                        kbCacheRef.current.entries = built;
                        return built;
                    })();

                    cache.inflight = task;
                    try {
                        return await task;
                    } finally {
                        // 无论成败都清掉在途标记：失败后要允许下一次重试
                        kbCacheRef.current.inflight = null;
                    }
                };

                if (action === 'status') {
                    try {
                        const entries = await getEntries();
                        const boards: Record<string, number> = {};
                        for (const entry of entries) {
                            boards[entry.board] = (boards[entry.board] || 0) + 1;
                        }
                        return JSON.stringify({ ready: true, articles: entries.length, boards });
                    } catch (e) {
                        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
                    }
                }

                if (action === 'search') {
                    const query = asString(args.query);
                    if (!query.trim()) return JSON.stringify({ error: '缺少 query' });

                    try {
                        const entries = await getEntries();
                        const hits = searchKb(entries, query);
                        if (hits.length === 0) {
                            // 无命中不是错误，但要给出下一步 —— 否则模型会原地重试同一个词
                            return JSON.stringify({
                                query,
                                hits: [],
                                notice: '没有匹配。换个说法：用更完整的自然短语，'
                                    + '或直接说页面现象（如「接口返回 401 未授权」「付费墙遮挡正文」）。'
                                    + '若这属于视频嗅探 / m3u8 / 防盗链一类，本库不覆盖，请直接用 S 探测页面。',
                            });
                        }
                        return JSON.stringify({ query, hits });
                    } catch (e) {
                        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
                    }
                }

                if (action === 'read') {
                    const target = asString(args.path);
                    if (!target) return JSON.stringify({ error: '缺少 path' });

                    try {
                        const entries = await getEntries();
                        // 路径按归一化后的形式比对：模型可能原样回传 search 给的 path，
                        // 也可能自己拼一个带 './' 或反斜杠的
                        const normalized = normalizeRel(target);
                        const entry = entries.find((item) => item.path === normalized);
                        if (!entry) {
                            return JSON.stringify({
                                error: `知识库里没有这篇文章：${target}。`
                                    + 'path 要用 search 返回的那个，形如 ctf-website/techniques/…/xx.md。',
                            });
                        }

                        const payload = await bridge.read(entry.path);
                        if (payload?.error) return JSON.stringify({ error: payload.error });
                        if (typeof payload?.content !== 'string') {
                            return JSON.stringify({ error: `读不到正文：${entry.path}` });
                        }

                        const result = readKbArticle(entry, payload.content, {
                            section: asString(args.section),
                        });
                        return JSON.stringify(result);
                    } catch (e) {
                        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
                    }
                }

                return JSON.stringify({
                    error: unknownActionError(action, ['search', 'read', 'status']),
                });
            }

            default:
                return JSON.stringify({ error: `未知工具：${String(tool)}` });
        }
    }, [deps.getActiveWebview, execActive, waitForPageReady]);

    /* -------------------------------- 主循环 -------------------------------- */

    const send = useCallback(async (prompt: string) => {
        const text = prompt.trim();
        if (!text || busyRef.current) return;

        /**
         * 压缩在途时拒绝新提问。
         *
         * compact 手上的 digest 与 upTo 是开始那一刻算的，中途进来一轮，
         * 分界线就会按过期位置落下：本该保留的工作集被划进覆盖区，
         * 既没进摘要器又不再进上下文。读 ref 而不是 state：send 的身份不能
         * 跟着 compacting 每翻一次就变一次（会把面板的 useCallback 全部击穿），
         * 而 ref 当场可见。界面侧输入框同样禁用，这里是防快捷键与重试按钮。
         */
        if (compactingRef.current) {
            setError('正在压缩上下文，请稍候再试。');
            return;
        }

        /**
         * 硬门槛的第二道闸门。
         *
         * 界面已禁用输入框，但**不能只靠界面**：错误横幅的「重试」按钮、快捷键、
         * 以及任何直接调 actions.send 的路径都会绕过 disabled。在唯一的入口处拦一次
         * 才是真正的保证。
         *
         * 读 messagesRef 而不是闭包里的 messages：本函数被 useCallback 记忆，闭包捕获
         * 的是它创建那一刻的快照；messagesRef 由 effect 持续同步，永远是当前值。
         */
        if (estimatePromptTokens(buildTranscript(messagesRef.current)) >= CONTEXT_LIMIT_TOKENS) {
            setError(
                `上下文已达 ${CONTEXT_LIMIT_TOKENS.toLocaleString()} token 上限，`
                + '必须先压缩或清空对话才能继续。'
            );
            return;
        }

        busyRef.current = true;
        stoppedRef.current = false;
        setError('');

        // 历史必须在 appendMessage **之前**读。那行之后 messagesRef 是否已经跟上，
        // 取决于 React 何时提交这次 setState —— 读在它前面就不必关心这个时序，
        // 也不会把本轮提问重复算进历史。不接历史的话模型每轮都从零开始，
        // 追问「它 / 刚才那个」与按提示「继续」全部落空。
        const list = messagesRef.current;
        const history = buildTranscript(list);

        appendMessage({ id: generateId(), role: 'user', content: text, at: Date.now() });

        // 模型侧记录。JSON 协议没有 tool role，观察结果以 user 消息回灌（ReAct 形态）
        const transcript: AiChatMessage[] = [...history, { role: 'user', content: text }];

        try {
            // 连续协议错误计数。只统计**连续**的：中途成功执行过一次工具就归零，
            // 否则一个偶发笔误会跟着整个会话不放，几次之后把还正常的模型判死。
            let protocolErrors = 0;

            // 不设步数上限：什么时候停由模型自己决定（不再要工具就收尾）。
            for (; ;) {
                if (stoppedRef.current) break;

                // 轮内门槛：transcript 在本轮内单调增长，入口处那道闸门管不住它。
                // 超限后继续调模型只会拿到 context_length_exceeded，
                // 整轮的已完成步骤全部作废 —— 不如提前停下来让用户压缩后继续。
                if (estimatePromptTokens(transcript) >= CONTEXT_LIMIT_TOKENS) {
                    appendMessage({
                        id: generateId(),
                        role: 'assistant',
                        content: `本轮上下文已达 ${CONTEXT_LIMIT_TOKENS.toLocaleString()} token 上限，已停止。请先压缩或清空对话，再让我继续。`,
                        notice: true,
                        at: Date.now(),
                    });
                    setError(
                        `上下文已达 ${CONTEXT_LIMIT_TOKENS.toLocaleString()} token 上限，`
                        + '必须先压缩或清空对话才能继续。'
                    );
                    break;
                }

                setStatus('thinking');
                setStreaming({ content: '', reasoning: '' });

                // 增量累积在局部变量里，再整块 setState：
                // 每个 token 都走一次 setState 会让长回复卡住渲染。
                let liveContent = '';
                let liveReasoning = '';
                let flushTimer: number | null = null;
                const flush = () => {
                    flushTimer = null;
                    setStreaming({ content: liveContent, reasoning: liveReasoning });
                };
                const scheduleFlush = () => {
                    if (flushTimer !== null) return;
                    flushTimer = window.setTimeout(flush, 60);
                };

                const controller = new AbortController();
                abortRef.current = controller;

                // 本次调用的用量。在 onUsage 里落进局部变量而不是直接 setState：
                // 它要跟着下面那条 assistant / tool 消息一起定稿，单独存一份会让
                // "这条消息花了多少"永远对不上号。
                let stepUsage: AiUsage | undefined;

                let reply: string;
                try {
                    reply = await chat({
                        system: SYSTEM_PROMPT,
                        messages: transcript,
                        // 不指定 reasoningEffort：由配置里的档位决定（见
                        // resolveReasoningEffort）。硬编码 'high' 会无视用户在
                        // 设置里选的「不思考 / 低 / 最大」，而推理强度是按调用
                        // 计费的，不该由程序替用户决定。
                        signal: controller.signal,
                        onUsage: (u) => { stepUsage = u; },
                        onDelta: (delta) => {
                            if (delta.content) liveContent += delta.content;
                            if (delta.reasoning) liveReasoning += delta.reasoning;
                            scheduleFlush();
                        },
                    });
                } catch (e) {
                    // 用户点停止导致的中断：不算错误，把已流出的部分定稿即可
                    const aborted = e instanceof Error && e.name === 'AbortError';
                    if (flushTimer !== null) window.clearTimeout(flushTimer);
                    if (!aborted) setError(e instanceof Error ? e.message : String(e));
                    /**
                     * 中断的这两条消息**不带 usage**，这不是遗漏。
                     *
                     * chat 只在成功拿到完整回复后才回调 onUsage（见 reportUsage），中止时
                     * 它直接抛 AbortError —— 客户端根本没收到 usage 块。服务端那边这次调用
                     * 确实可能已经计了费，但那个数字本地无从得知；编一个估算值挂上去，只会让
                     * "累计"这个本该能核对账单的数变得不可信。
                     */
                    if (liveContent.trim()) {
                        appendMessage({
                            id: generateId(), role: 'assistant',
                            content: liveContent.trim(),
                            reasoning: keepReasoning(liveReasoning),
                            at: Date.now(),
                        });
                    } else if (liveReasoning.trim()) {
                        // 只有推理、没有正文（用户中途停止时很常见）：也要落一条，
                        // 否则这一轮的思考同样会随气泡消失。
                        appendMessage({
                            id: generateId(), role: 'assistant',
                            content: '（本轮已中断，模型只输出了推理）',
                            reasoning: keepReasoning(liveReasoning),
                            notice: true,
                            at: Date.now(),
                        });
                    }
                    break;
                } finally {
                    if (flushTimer !== null) window.clearTimeout(flushTimer);
                    abortRef.current = null;
                    setStreaming(null);
                }

                if (stoppedRef.current) break;
                transcript.push({ role: 'assistant', content: reply });

                const call = extractJsonObject(reply);
                // 工具名全小写严格匹配（js / script_store / navigate / tamper / storage / tokens / kb），
                // 写错会落到"未知工具"。不归一：归一等于把"拼写检查"这道关口拆掉，
                // 写错名字是最便宜的笔误，就该在第一步暴露，而不是猜着执行。
                const tool = call?.tool as AgentToolName | undefined;

                /**
                 * 没有可执行的工具调用 —— 三种情况必须分开处置，混为一谈会让 Agent
                 * 在最需要自救的时候停下来：
                 *
                 * 1. **模型明确收尾**（给了 final）：正常结束，落一条回答。
                 * 2. **协议错误**（没给 final，也没给 tool）：模型输出了一段散文、或把
                 *    JSON 写坏了。这不是"它说完了"，而是**这一步没做成** —— 直接当成
                 *    普通文本收尾，等于把一次失败的调用当成结论交给用户，而模型自己
                 *    压根不知道自己错了。必须把错误回灌让它改。
                 * 3. **空回复**：推理模型偶发，回灌也无从改起，如实提示后停止。
                 */
                if (!call || !tool) {
                    const finalText = asString(call?.final);

                    if (finalText) {
                        appendMessage({
                            id: generateId(), role: 'assistant',
                            content: finalText,
                            reasoning: keepReasoning(liveReasoning),
                            ...(stepUsage ? { usage: stepUsage } : {}),
                            at: Date.now(),
                        });
                        break;
                    }

                    // 走到这里：既没有 final 也没有 tool。有正文内容才算协议错误 ——
                    // 空回复回灌一句"你没输出"它也变不出内容来，那是浪费一次调用。
                    if (reply.trim()) {
                        protocolErrors += 1;
                        const hint = `你的回复里没有可执行的工具调用，也没有 final 字段。`
                            + `必须严格按协议只回一个 JSON 对象：`
                            + `{"thought":"...","tool":"js","args":{...}} 或 {"thought":"...","final":"..."}。`
                            + `不要输出解释文字，不要用 \`\`\`json 围栏。`
                            + `args.code 是 JSON 字符串：里面的换行必须写成 \\n、引号必须写成 \\"，`
                            + `直接粘多行 JS 会破坏 JSON 解析。`
                            + `（第 ${protocolErrors} 次）`;

                        appendMessage({
                            id: generateId(), role: 'tool',
                            content: '协议错误：回复里没有工具调用也没有 final',
                            reasoning: keepReasoning(liveReasoning),
                            label: '协议错误',
                            ok: false,
                            result: reply.trim(),
                            ...(stepUsage ? { usage: stepUsage } : {}),
                            at: Date.now(),
                        });

                        // 把模型自己的原文一并回灌：只说"你错了"它不知道该改哪里，
                        // 看到原文才能定位是自己漏了 JSON 还是围栏没去掉。
                        transcript.push({ role: 'user', content: `[协议错误] ${hint}\n\n你上一条回复的原文：\n${reply.trim()}` });

                        if (protocolErrors >= MAX_PROTOCOL_ERRORS) {
                            appendMessage({
                                id: generateId(),
                                role: 'assistant',
                                content: `连续 ${MAX_PROTOCOL_ERRORS} 次没有按输出协议回复，已停止。`
                                    + `可以再说一次，或换个更明确的说法。`,
                                notice: true,
                                at: Date.now(),
                            });
                            break;
                        }
                        continue;
                    }

                    // 空回复（推理模型偶发）：不能静默 break —— 那样用户看到对话停在
                    // 半路，分不清是结束还是卡住。
                    appendMessage({
                        id: generateId(),
                        role: 'assistant',
                        content: '（模型本轮没有返回内容，已停止。可以再说一次或换个说法。）',
                        notice: true,
                        at: Date.now(),
                    });
                    break;
                }

                const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;
                const thought = asString(call.thought);

                setStatus('acting');
                /**
                 * 工具派发**不能让异常穿出去**。
                 *
                 * dispatchTool 内部对预期内的失败（缺参数、找不到 id、脚本抛错）都返回
                 * {error}，但意外异常仍然存在：preload 桥没暴露、webview 被销毁、主进程
                 * IPC 断掉。原先这些异常会一路冒到 send 的 finally，循环直接终止 —— 用户
                 * 看到的是对话停在半路，而模型连"这一步失败了"都不知道，下一轮还会照着
                 * 原计划重来一遍。捕获后按普通工具结果回灌，模型能读到失败原因并自己换路。
                 */
                let result: string;
                try {
                    result = await dispatchTool(tool, args);
                } catch (e) {
                    result = JSON.stringify({
                        error: `工具 ${tool} 执行时抛出异常：${e instanceof Error ? e.message : String(e)}`,
                    });
                }
                if (stoppedRef.current) break;

                // 这一步真的执行了（无论成败），协议错误计数归零 ——
                // 判据是"模型能不能正确表达调用意图"，它已经表达对了。
                protocolErrors = 0;

                // 日志只写工具名会分不清模型做的是哪件事
                // （列清单 / 存脚本 / 改脚本 / 删脚本都是 "script_store"）。
                // 把 action 拼进显示文案；js 没有动作，标签就是工具名本身。
                const rawAction = asString(args.action);
                const label = tool === 'script_store' && rawAction ? `${tool}·${rawAction}` : tool;

                /**
                 * 失败与成功必须长得不一样，界面与模型两侧都用这一个判据。
                 *
                 * 回灌给模型时原先是共用「[工具 X 的执行结果]」一个前缀，模型只能自己
                 * 去读 JSON 里的 error 字段才能发现失败。实测里它经常读漏，接着按原计划
                 * 往下走 —— 于是同一招连错好几次，把预算烧光。
                 *
                 * js 用专属判据：页面数据里合法的 {error} 字段不能算失败
                 * （见 isJsErrorResult），否则一次成功的数据探测会被当成
                 * 失败重做，预算烧在正确的结果上。
                 */
                const failed = tool === 'js' ? isJsErrorResult(result) : isErrorResult(result);

                appendMessage({
                    id: generateId(),
                    role: 'tool',
                    content: thought || `调用 ${label}`,
                    reasoning: keepReasoning(liveReasoning),
                    tool,
                    // 显示文案会被 thought 顶掉，而 label 是**稳定**的那一份：重建上下文时
                    // 若只按 tool 写回，模型在历史里看不出这一步做的是列清单还是存脚本。
                    label,
                    // js 跑的源码存下来供界面展开查看；其它工具没有源码。
                    script: tool === 'js' ? asString(args.code) : undefined,
                    ok: !failed,
                    result,
                    // 用量挂在这条工具消息上而不是上一条 assistant：assistant 那条在这一步里
                    // 只是"决定要调用工具"的中间产物，用户真正会展开看的是这一步干了什么。
                    ...(stepUsage ? { usage: stepUsage } : {}),
                    at: Date.now(),
                });

                /**
                 * 回灌给模型的观察值。措辞必须与 roundToMessages 重建历史时**逐字一致**，
                 * 否则同一段历史在本轮循环里与下一轮重建后会长得不一样，模型对"这步到底
                 * 成没成"的判断会随轮次漂移。
                 */
                transcript.push({
                    role: 'user',
                    content: failed
                        ? `[工具 ${label} 执行失败]\n${result}\n\n这一步没有成功。请根据上面的错误信息修正参数或换一条路，不要原样重试。`
                        : `[工具 ${label} 的执行结果]\n${result}`,
                });
            }
        } finally {
            busyRef.current = false;
            setStatus('idle');
            setStreaming(null);
        }
    }, [appendMessage, dispatchTool]);

    const stop = useCallback(() => {
        stoppedRef.current = true;
        // 真掐断在途请求。只置标志位的话，得等整包回来循环才会发现已停止 ——
        // 流式下这一点尤其明显：界面还在滚字，用户以为停止没生效。
        abortRef.current?.abort();
    }, []);

    const clear = useCallback(() => {
        // 运行中禁止清空：主循环正拿着 messages 追加，此刻清空后它的下一次
        // appendMessage 会把旧轮次"接"回来，界面表现为"清了但历史又冒出来"。
        // 与 removeMessage / rewindTo 同一闸门（见 canEdit）。
        if (busyRef.current) return;
        setMessages([]);
        setError('');
        // 正在流式输出时清空对话：气泡也要收掉，否则残留在空列表上方
        setStreaming(null);
    }, []);

    /**
     * 删除单条消息体。
     *
     * 与「回退」分开是有意的：删一条只动一条，用于清掉某次失败的探测、一条泄露了
     * 密钥的工具返回值；回退是从这条起往后全砍掉。两者粒度相同（都只认这一条消息），
     * 差别只在砍多长。
     *
     * 运行中一律拒绝（见 canEdit）：此刻 messages 正在被主循环追加，用户删掉的那条
     * 可能在下一句 appendMessage 之后又被"接"回来，界面表现为"删了没反应"。
     */
    const removeMessage = useCallback((id: string) => {
        if (busyRef.current) return;
        setMessages((prev) => (prev.some((m) => m.id === id) ? prev.filter((m) => m.id !== id) : prev));
    }, []);

    /**
     * 回退到某条消息**之前**：这条连同它之后的全部删掉，返回该条的提问原文。
     *
     * 切点就是用户点中的**那一条**，不按轮次往前扩 —— 一轮里的消息本就该能单独作废
     * 后半段：某轮模型连发了十来步工具，用户只想扔掉后面几步、留住前面那些还有用的
     * 探测结果，按整轮切会把有用的部分一起扔掉。
     *
     * 只有落在用户提问上时才返回原文：回退到工具消息或回答上没有"提问"可填，
     * 硬塞一条工具返回值进输入框等于替用户写了一句他没说过的话。
     *
     * 读 messagesRef 而不是走 setMessages 的函数式更新：返回值必须是**同步**的，
     * 而函数式更新里的代码在 React 提交时才跑，那时早就 return 过了。
     */
    const rewindTo = useCallback((id: string): string => {
        if (busyRef.current) return '';
        const list = messagesRef.current;
        const at = list.findIndex((m) => m.id === id);
        if (at < 0) return '';

        const prompt = list[at].role === 'user' ? list[at].content : '';

        setMessages(list.slice(0, at));
        // 上一轮留下的报错横幅属于被删掉的那一段，留着会指向不存在的东西
        setError('');
        return prompt;
    }, []);

    const runScript = useCallback((code: string) => execActive(code), [execActive]);

    /**
     * 手动执行一条已保存脚本。记账与自动执行对齐（lastRunAt / lastResult / tool
     * 消息），界面上的"最近执行"与"返回值"对两种触发方式一致 —— 否则手动点的那次
     * 在脚本卡片上不留痕，用户会以为没跑。
     */
    const runScriptNow = useCallback(async (id: string): Promise<string> => {
        if (busyRef.current) return JSON.stringify({ error: 'Agent 正在运行，先停止再手动执行' });
        const script = scriptsRef.current.find((s) => s.id === id);
        if (!script) return JSON.stringify({ error: '脚本不存在（可能已被删除）' });
        const result = await execActive(script.code);
        setScripts((prev) => prev.map((s) => (
            s.id === id ? { ...s, lastRunAt: Date.now(), lastResult: result } : s
        )));
        appendMessage({
            id: generateId(),
            role: 'tool',
            content: `手动执行：${script.name}`,
            tool: 'js',
            label: `js·手动·${script.name}`,
            auto: true,
            script: script.code,
            ok: !isJsErrorResult(result),
            result,
            at: Date.now(),
        });
        return result;
    }, [execActive, appendMessage]);

    const removeScript = useCallback((id: string) => {
        setScripts((prev) => prev.filter((s) => s.id !== id));
    }, []);

    const toggleScript = useCallback((id: string) => {
        setScripts((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
    }, []);

    /* ------------------------------ 自动执行 ------------------------------ */

    // 页面每次就绪 → 跑一遍命中的脚本。这一步直接复用 useBrowse 的广播，
    // 与篡改引擎共用同一条生命周期，不需要另挂 dom-ready 监听。
    // 并发由 execOn 内的串行队列消化：模型步骤与自动脚本不会交错读页面，
    // 这里不需要再判 busy 而跳过 —— 跳过会漏掉命中的自动化，而排队只是晚一点跑。
    useEffect(() => deps.onPageReady((_tabId, webview) => {
        const url = readWebviewUrl(webview);
        if (!url) return;

        const hits = scriptsRef.current.filter(
            (s) => s.enabled && s.urlPattern && url.includes(s.urlPattern)
        );
        if (hits.length === 0) return;

        hits.forEach((script) => {
            void (async () => {
                const result = await execOn(webview, script.code);
                setScripts((prev) => prev.map((s) => (
                    s.id === script.id ? { ...s, lastRunAt: Date.now(), lastResult: result } : s
                )));
                appendMessage({
                    id: generateId(),
                    role: 'tool',
                    content: `自动执行：${script.name}`,
                    tool: 'js',
                    label: `js·自动·${script.name}`,
                    // 标记成自动：它不属于任何一次模型调用，重建上下文时要按
                    // 「环境事件」写回，不能伪造成一次模型发出的工具调用。
                    auto: true,
                    script: script.code,
                    ok: !isJsErrorResult(result),
                    result,
                    at: Date.now(),
                });
            })();
        });
    }), [deps.onPageReady, execOn, appendMessage]);

    const actions = useMemo(() => ({
        send, stop, clear, compact, setCompactRatio, runScript, runScriptNow, removeScript, toggleScript,
        removeMessage, rewindTo,
    }), [send, stop, clear, compact, setCompactRatio, runScript, runScriptNow, removeScript, toggleScript, removeMessage, rewindTo]);

    /**
     * 会话用量与两个闸门判据。
     *
     * 全部按现存消息**重算**，不维护任何累加器：删除一条、回退一段之后累加器只会越走
     * 越偏，而重算的代价只是遍历一遍数组。
     *
     * contextTokens 用**估算**而不是最近一次调用的实测 promptTokens：实测值只在发过
     * 请求之后才有，而用户刚删掉几轮、或刚压缩完时正需要看到当前占用 —— 那时一个陈旧
     * 的实测值比估算更误导。
     *
     * 注意每次渲染都要走一遍 buildTranscript —— 去掉上下文裁剪之后，这个遍历的规模
     * 随历史线性增长（800k token 量级时是几 MB 的字符串拼接）。这是"不静默丢历史"的
     * 代价，用 useMemo 把重算限制在 messages 变化时。
     */
    const derived = useMemo(() => {
        const contextTokens = estimatePromptTokens(buildTranscript(messages));
        return {
            usage: sumUsage(messages, contextTokens),
            // 硬门槛：>= 即拦住，只有**严格小于**才放行。界面、send() 的闸门、压缩后的
            // overBudget 三处必须用同一个比较，否则会出现"输入框禁用但 send 放行"。
            contextFull: contextTokens >= CONTEXT_LIMIT_TOKENS,
            // 条数判据必须与 compact() 里那道闸门**同一个表达式**（同一个
            // compactCoverCount）：两处不一致时，按钮会是可点的但点了什么都不发生。
            // 注意按分界线之后算 —— 压过的历史不参与"还能压多少"，否则压完一次
            // 按钮永远可点，用户可以无意义连点。
            canCompact: compactCoverCount(splitByCompaction(messages).messages.length, compactRatio) >= 1,
        };
    }, [messages, compactRatio]);

    return useMemo(() => ({
        messages, scripts, status, error, streaming, actions,
        // 运行中**或压缩中**禁止改历史（删除 / 回退 / 清空）：主循环正拿着 messages
        // 追加，此刻改动会和它的下一次 appendMessage 抢同一个数组；压缩则正拿着
        // upTo 锚点做落盘，此刻改动会让锚点失效。界面据此禁用按钮，而不是让用户
        // 点了没反应 —— 那看起来像坏了。
        canEdit: status === 'idle' && !compacting,
        usage: derived.usage,
        contextFull: derived.contextFull,
        canCompact: derived.canCompact,
        compacting,
        compactRatio,
    }), [
        messages, scripts, status, error, streaming, actions, derived, compacting,
        compactRatio,
    ]);
};
