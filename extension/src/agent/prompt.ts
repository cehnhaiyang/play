import { estimatePromptTokens } from '../../../shared/ai/AiService';
import type { AgentMessage, AiChatMessage } from '../../../shared/meta';
import { buildTranscript } from './transcript';
import { MAX_CALLS_PER_REPLY } from './parse';

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
 * 而不必把整个 hook 跑起来。
 */

/**
 * 沙箱的动作清单与 node 的两条超时。真值在 `shared/meta/type.ts`，
 * 这里只**转口**给提示词插值。
 *
 * 不在 prompt.ts 里各写一份：改了白名单而提示词还写着旧的动作名，
 * 模型会照着调用一个已经不存在的动作；手抄超时秒数则会在钳制值改动后过期。
 */
import {
   SANDBOX_ACTIONS,
   SANDBOX_NODE_TIMEOUT_DEFAULT_MS,
   SANDBOX_NODE_TIMEOUT_MAX_MS,
} from '../../../shared/meta';

/**
 * 单次观察回传上限 —— **保险丝，不是预算**。
 *
 * 第 i 步的结果会被后续每一步重发，所以总成本里步数那一项是平方级的：
 * 为了省 token 而截断是净亏的（拆成 3 次取要多走 2 步，重发量远超省下的首包）。
 * 它只防 `return document.documentElement.outerHTML` 这类明显超标的返回
 * （大型站实测 1.95MB，进请求会把上下文顶穿、整轮直接失败）。
 */
export const RESULT_LIMIT_BYTES = 32768;

/**
 * 连续多少次协议错误后放弃。
 *
 * 错误会回灌让模型自己改，但卡在同一个错误上反复犯的模型是存在的：无上限回灌
 * 只会把整轮的调用费烧光，且每一步都要付一次钱。
 */
export const MAX_PROTOCOL_ERRORS = 3;

/**
 * 页面脚本单次执行超时（毫秒）。
 *
 * 宿主是 `chrome.debugger`，`Runtime.evaluate` 没有 abort：页面死循环时那个
 * Promise 永远不 settle，stop() 够不到它，主循环会卡死在"正在页面里执行…"。
 * 超时后按普通工具失败回灌，模型能读到原因并换路，用户点停止也不会卡住。
 */
export const EXEC_TIMEOUT_MS = 60000;

/**
 * 单条推理文本的落盘上限（字节）。
 *
 * 推理模型的思考可以很长，而它**每一步都会存一份** —— 200 条消息全挂满推理
 * 就能把落盘预算吃光，把真正有用的对话与工具结果挤掉。
 */
export const REASONING_LIMIT_BYTES = 32768;

export const MESSAGES_STORE_KEY = 'agent-messages';
export const MESSAGES_STORE_MAX = 200;

/**
 * 落盘体积预算（字节）。
 *
 * `chrome.storage.local` 的配额比 localStorage 宽（默认 10MB，`unlimitedStorage`
 * 后无上限），但**条数上限挡不住体积**：一条消息最多 32KB，200 条就是 6.3MB，
 * 能把默认配额顶穿，写入失败时界面只表现为"历史不再保存"。
 * 所以按**字节**收敛，条数上限只作附加保护。
 */
export const STORE_BUDGET_MESSAGES = 1_500_000;

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
 * 为什么是条数而不是轮次：轮次边界只有一个（新的用户提问），工具观察、
 * 提示横幅这些非轮次消息会让"保留 N 轮"实际保留的条数飘忽不定；
 * 条数是用户唯一能数的东西。
 */
export const COMPACT_RATIOS = [0.4, 0.6, 0.8, 1] as const;
/** 默认档位。导出给界面算"按当前档位至少几条才压得动"，手抄一个数会漂移。 */
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
 * 反复压缩时上一次的摘要会一并带进摘要器，更早的历史不会凭空消失，只是逐次变粗。
 */
export const COMPACT_INPUT_BUDGET_BYTES = 524_288;

/** 摘要请求的输出上限。结构化摘要写不到这么长，这个值只是防跑飞 */
export const COMPACT_MAX_TOKENS = 2048;

/** 摘要消息的前缀。系统提示词里逐字声明了它，两处必须一致。 */
export const COMPACT_PREFIX = '[上下文压缩摘要]';

/**
 * 系统提示词。
 *
 * 三条不可动摇的写法约束：
 *  - **工具名与参数全小写、严格匹配**：解析侧不做归一，所以提示词里必须把准确
 *    拼写摆在模型面前，而不是靠容错去兜。
 *  - **数字一律插值**：条数上限、字节上限这些值会随实现变，手抄进提示词必然过期，
 *    而模型会照着过期的上限规划步骤。一批的条数上限因此从 parse.ts 引用
 *    （判据 extractCalls 在那里，反向 import 会成环）。
 *  - **前缀逐字对齐实现**：`## Conversation history` 那节声明的三个前缀由 transcript 的
 *    roundToMessages 真正写出，两处分别在两个文件里，改一处忘另一处不会有任何
 *    编译或运行时错误。
 */
export const SYSTEM_PROMPT = `
You are a reverse-engineering agent in the user's logged-in browser: you act on pages by executing JavaScript in their main world, and your job is to explain how a site is built, analyse CTF/crackme challenges and malware behaviour, recover algorithms, prove every claim by running it, and write up the analysis.

## Environment
- No DOM picker: every click, input and read happens in JS via document.querySelector / fetch.
- Main world: your JS shares memory, cookies, globals and the logged-in session with the page, so the page's own functions are callable directly.
- You live in the extension, not the page: navigating away does not end this conversation.
- The sandbox directory (sandbox tool) is your only disk access — inside it only; the rest of the filesystem is invisible and unwritable. Recovered algorithms, extracted data and reports belong there, not only in your reply.

## Conversation history
You can see earlier turns and their tool results, marked by source: [工具 X 的执行结果] is an observation you obtained, [系统提示] is text the UI added and never something you said, [协议错误] is the system's receipt for a reply that broke the protocol. The last two are not your conclusions. Compressed history arrives as ${COMPACT_PREFIX}.

## Output protocol (strict)
One JSON object and nothing else — no prose around it, no code fence.

Tools: {"intent":"one line: what this step does and what you expect","calls":[{"tool":"js","args":{...}},{"tool":"sandbox","args":{...}}]}
Finish: {"intent":"one line: what this conclusion answers","final":"the answer for the user"}

- intent is ONE short sentence, never a scratchpad. Reason in your own thinking, never inside the JSON.
- A batch is one step: its calls run together and come back together, at most ${MAX_CALLS_PER_REPLY} per reply. Batch only independent calls — if B needs A's result, B goes in the next reply. js calls run in the order listed; other tools run concurrently, so never mix navigate with calls that read the page.
- calls and final are mutually exclusive; if both appear, only calls run.
- final is a whole Markdown document inside a JSON string: the entire reply must be ONE line, with no real newline (end every heading, paragraph, list item and table row with \\n), and no bare double quote " inside it — that closes the string early and the finished answer is rejected. Use 「」 for Chinese quotes, \\" when a double quote is unavoidable, \\\\ for a backslash, backticks for code.

## Tools (lowercase, exact match)

js — run JavaScript (your most used tool)
  args: {"code": "string"}
  - Return an explicitly serializable value (limit ${RESULT_LIMIT_BYTES / 1024}KB). await, main-world globals and credentialed fetch all work.
  - code is a JSON string: every newline in multi-line JS is \\n and every double quote \\" — raw newlines break the outer JSON and the call is rejected.
  - Never change location.href here.

navigate — go to a URL
  args: {"url": "https://... or a relative path"}
  - A relative path resolves against the current page. Returns the final normalized URL after load.

tamper — engine-level request/response tampering (the only way to change what the page itself receives)
  args: {"action": "get"} or {"action": "set", "intercept": [...], "request": [...], "headers": [...]}
  - intercept / request item: {"enabled": true, "url_pattern": "* or substring", "key": "field name (last key)", "value": any, "op": "set" | "delete"}
  - headers item: {"enabled": true, "url_pattern": "*", "name": "Header-Name", "value": "value (empty deletes the header)"}
  - Editing a value from js affects that one call only; anything the page must keep receiving goes through this tool.

storage — raw storage and cookie access (bypasses the tamper engine, reads real values)
  args: {"action": "get" | "set" | "delete", "area": "local" | "session" | "cookie", "key": "...", "value": "string"} — get needs only action + area
  - A cookie key must be the exact identifier get returned: it carries domain/path, a bare name is ambiguous.

tokens — JWT inspection and rewriting
  args: {"action": "find"} | {"action": "decode", "token": "eyJ..."} | {"action": "rewrite", "token": "...", "changes": {"key": val}, "area": "local", "key": "the key find returned"}
  - Rewriting the payload invalidates the server signature.

sandbox — local sandbox: files and script execution
  args (action lowercase; one of ${SANDBOX_ACTIONS.join(' / ')}):
  - {"action": "list" | "read" | "delete", "path": "..."}
  - {"action": "write", "path": "...", "content": "text"}
  - {"action": "edit", "path": "...", "old": "text to replace", "new": "replacement"}
  - {"action": "lines", "path": "...", "start": 10, "end": 20, "content": "replacement lines"}
  - {"action": "checkjs", "content": "JS source to check"}
  - {"action": "node", "path": "out/crack.js", "timeout": 60000}
  - Change an existing file with edit, never read + full write: a full rewrite silently drops what you did not read, and the receipt still says success. old must match verbatim (indentation included) and be unique; extend it with a neighbouring line when it is not — it errors instead of guessing.
  - lines is 1-based and inclusive; omit end to replace only that line. Line endings are preserved.
  - checkjs parses only — it does not run or resolve dependencies, and parses CommonJS, so import / export / top-level await are syntax errors.
  - node runs a .js file already in the sandbox, so write it first. No command line, no arguments, no shell: you only choose the file. The working directory is the sandbox root, so paths are relative. The receipt carries exitCode and output (stdout + stderr, untruncated): a non-zero exit is the script's own conclusion, not a tool failure — read output for the reason; only a timeout is an error. timeout defaults to ${SANDBOX_NODE_TIMEOUT_DEFAULT_MS / 1000}s, capped at ${SANDBOX_NODE_TIMEOUT_MAX_MS / 1000}s, and kills the child process.
  - Directories are created as needed. Neither read nor write truncates: any file comes back whole and can be edited whole.

## Working rules
- Evidence over narrative: name the source of every conclusion (which request, which storage key, which script return value) and quote the actual sampled value with the total — never "this can be read".
- Prove by running: a tamper or a bypass counts only with the behaviour before and after it; an algorithm counts only when your reimplementation reproduces the original output.
- Two failures of the same trick mean switch strategy: read the error, change the approach. A failed call is not the end of the task, it is that step's result.
- When something cannot be done, hand over the state: the paths you tried, where it got stuck, and what to check next. Never end vaguely.
- Ask the user nothing a tool can answer.`;

/**
 * 一次请求的输入 token：**系统提示词 + 待发消息**。
 *
 * 这是 `AiUsage.promptTokens` 的定义口径，服务端实测与 AiService 的估算回落
 * 都按它算。本地估算必须用同一个口径 —— 少算系统提示词会让"上下文"比
 * "这一步的输入"小一大截，而用户唯一能做的自查就是拿这些数相加，
 * 对不上时他只会以为统计坏了。
 */
export const requestTokensOf = (messages: AiChatMessage[]): number =>
   estimatePromptTokens([{ role: 'system', content: SYSTEM_PROMPT }, ...messages]);

/** 上下文占用：按现存对话重建后的**下一次请求**输入量（硬门槛与界面显示共用） */
export const contextTokensOf = (messages: AgentMessage[]): number =>
   requestTokensOf(buildTranscript(messages));

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
