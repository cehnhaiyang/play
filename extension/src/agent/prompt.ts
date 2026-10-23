import { estimatePromptTokens } from '../../../shared/ai/AiService';
import type { AiChatMessage } from '../../../shared/meta';

/**
 * Agent 的提示词与上下文门槛。
 *
 * ## 为什么与协议、工具分开
 *
 * 这三块各有一个"改了不会有任何报错"的失效面：
 *   · 提示词里的数字手抄 → 与实现漂移，模型照过期的上限规划步骤；
 *   · 前缀措辞 → 与重建历史的函数分叉，模型对同一段历史的判断随轮次漂移；
 *   · 门槛口径 → 输入框禁用但 send 放行。
 *
 * 分开之后，`test/agenttools.test.js` 可以对每一块单独下断言，
 * 而不必把整个主循环跑起来。
 */

/**
 * 连续多少次协议错误后放弃。
 *
 * 错误会回灌让模型自己改，但卡在同一个错误上反复犯的模型是存在的：无上限回灌
 * 只会把整轮的调用费烧光，且每一步都要付一次钱。
 */
export const MAX_PROTOCOL_ERRORS = 3;

/**
 * 会话索引的存储键：全部会话的元信息，以及当前是哪一个。
 *
 * 与消息本体**分开存**：一份历史可以到 1.5MB，而这个索引只有几百字节。
 * 装在一起就意味着一份历史的每次追加都要把**别的会话**的整份历史重写一遍。
 */
export const SESSIONS_STORE_KEY = 'agent-sessions';

/**
 * 上一版（单会话）的消息存储键。
 *
 * 只有 hydrate 的迁移路径读它：见到它就说明这份历史是上一版留下的，
 * 迁成一条会话之后立刻删掉 —— 留着就是最多 1.5MB 的配额被一份再也无人读的数据
 * 占着，而配额正是会话数上限的出处（见 MAX_SESSIONS）。
 */
export const LEGACY_MESSAGES_STORE_KEY = 'agent-messages';

/**
 * 一条会话的消息本体存储键。
 *
 * 加冒号而不是另起一个前缀：老键是 `agent-messages`，新键是
 * `agent-messages:<会话 id>`，两者在存储里不会撞名，而前缀本身说明了它是什么。
 */
export const sessionMessagesKey = (id: string): string => `${LEGACY_MESSAGES_STORE_KEY}:${id}`;

/** 单条会话的消息条数上限 */
export const MESSAGES_STORE_MAX = 200;

/**
 * **单条会话**的落盘体积预算（字节）。
 *
 * `chrome.storage.local` 的配额是 10MB，而 manifest 里**没有** `unlimitedStorage`
 * —— 这是真上限，不是靠声明能绕开的软约束。**条数上限挡不住体积**：推理文本
 * 单条就能到 32KB，200 条就是 6.3MB，能把配额顶穿，而写入失败在界面上只表现为
 * "历史不再保存"（persist 静默吞掉错误）。所以按**字节**收敛，条数上限只作附加保护。
 */
export const STORE_BUDGET_MESSAGES = 1_500_000;

/**
 * 会话数上限。
 *
 * 这个数是**算出来的**，不是随手定的：配额 10MB，而每条会话各自可以长到
 * `STORE_BUDGET_MESSAGES` —— 6 × 1.5MB = 9MB，剩下 1MB 留给插件其余状态
 * （篡改规则、嗅探开关，都是 KB 量级）。
 *
 * 超限时**拒绝新建并说清原因**：配额顶穿的表现是"写入失败且界面上没有提示"，
 * 比"建不了新会话"难查得多，而且那时丢的是已经写下的历史。要留更多会话，
 * 先把不用的那条导出成 Markdown 再删。
 */
export const MAX_SESSIONS = 6;

/**
 * 上下文硬门槛（token）。达到或超过即**强制压缩**：输入框禁用，不压不能继续。
 *
 * 两道闸门都要有（界面禁用 + send() 拒绝）：只禁界面的话，任何直接调
 * `actions.send` 的路径（`agent-action` 桥端点）仍能绕过去。只有**严格小于**
 * 这个值才放行。
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
 * 为什么是条数而不是轮次：轮次边界只有一个（新的用户提问），工具观察、
 * 提示横幅这些非轮次消息会让"保留 N 轮"实际保留的条数飘忽不定；
 * 条数是用户唯一能数的东西。
 */
export const COMPACT_RATIOS = [0.4, 0.6, 0.8, 1] as const;
/** 默认档位。界面上那份候选表是手写的（两个构建产物不互相 import），这份是引擎的缺省 */
export const COMPACT_RATIO_DEFAULT = 0.6;
export const COMPACT_RATIO_STORE_KEY = 'agent-compact-ratio';

/**
 * 按档位算出这次该覆盖几条。`Math.floor` 而不是 round：承诺"压前 N%"时，
 * 实际覆盖只能少不能多 —— 多压一条在 100% 档没有区别，在 40% 档就是多吞历史。
 *
 * 返回 0 即"按当前档位无可压内容"，调用方（compact / canCompact）据此返回
 * null / false。两处必须调同一个函数。
 */
export const compactCoverCount = (messageCount: number, ratio: number): number =>
  Math.floor(messageCount * ratio);

/** 摘要消息的前缀。系统提示词里逐字声明了它，两处必须一致。 */
export const COMPACT_PREFIX = '[上下文压缩摘要]';

/**
 * 系统提示词。
 */
export const SYSTEM_PROMPT = `
You are a reverse-engineering agent in the user's logged-in browser: you act on pages by executing JavaScript in their main world, and your job is to explain how a site is built, analyse CTF/crackme challenges and malware behaviour, recover algorithms, prove every claim by running it, and write up the analysis.

Compressed history arrives as ${COMPACT_PREFIX}.`;

/**
 * 一次请求的输入 token：**系统提示词 + 待发消息**。
 *
 * 这是 `AiUsage.promptTokens` 的定义口径，服务端实测与 AiService 的估算回落
 * 都按它算。本地估算必须用同一个口径 —— 少算系统提示词会让"上下文"比
 * "这一步的输入"小一大截，而用户唯一能做的自查就是拿这些数相加，
 * 对不上时他只会以为统计坏了。
 *
 * 界面显示的"上下文占用"就是它作用在 `buildTranscript(messages)` 上的结果，
 * 那一步在引擎里（contextOf）：它要顺带把重建结果当历史用，且要按 messages
 * 的身份缓存 —— 每推一版快照都重算一遍全量历史是纯浪费。
 */
export const requestTokensOf = (messages: AiChatMessage[]): number =>
  estimatePromptTokens([{ role: 'system', content: SYSTEM_PROMPT }, ...messages]);

/**
 * 上下文越线时给用户看的那句话。
 *
 * 两道闸门（send 入口、轮内每步）共用它：措辞分叉时用户会以为自己遇到的是
 * 两件不同的事，而实际都只有一条出路（压缩或清空）。
 */
export const contextFullMessage = (): string =>
  `上下文已达 ${CONTEXT_LIMIT_TOKENS.toLocaleString()} token 上限，必须先压缩或清空对话才能继续。`;

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
export const COMPACT_SYSTEM_PROMPT = `你是一个对话压缩器。把给定的 Agent 工作记录压缩成一份结构化摘要。

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
改动了什么、在哪一层生效（引擎规则 / 脚本 / 存储 / 页面）。含写进沙箱的文件路径。

## 试过但失败的路
失败的做法与**失败原因**。这一节最容易被忽略但最值钱 —— 不写清楚，
后续会对着同一堵墙再撞一遍。

## 待办与下一步
还没做完的部分，以及当时判断的下一步。

只输出这份 Markdown，不要前言、不要结语、不要代码块围栏。`;
