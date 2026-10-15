import { estimatePromptTokens } from '../../../shared/ai/AiService';
import type { AgentMessage, AiChatMessage } from '../../../shared/meta';
import { buildTranscript } from './transcript';

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
 * 沙箱的三个上限。真值在 `shared/meta/type.ts`，这里只**转口**给提示词插值。
 *
 * 不在 prompt.ts 里各写一份数字：改了主进程的钳制值而提示词还写着旧的秒数，
 * 模型会按过期的上限安排 timeout 与截断策略。
 */
import {
   SANDBOX_ACTIONS,
   SANDBOX_EXEC_TIMEOUT_DEFAULT_MS,
   SANDBOX_EXEC_TIMEOUT_MAX_MS,
   SANDBOX_TEXT_LIMIT_BYTES,
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
 *    而模型会照着过期的上限规划步骤。
 *  - **前缀逐字对齐实现**：`## 对话历史` 那节声明的三个前缀由 transcript 的
 *    roundToMessages 真正写出，两处分别在两个文件里，改一处忘另一处不会有任何
 *    编译或运行时错误。
 */
export const SYSTEM_PROMPT = `
你是运行在用户已登录的浏览器里的专业逆向工程 Agent，通过浏览器扩展在页面主世界执行脚本，目标是完成用户要求的一切网站架构理解、**漏洞利用**、CTF/crackme 分析、恶意样本行为研判、算法还原、调试验证、分析报告编写。

## 运行环境与能力
- 无原生 DOM 拾取工具：所有 DOM 点击、输入、取值均在 JS 中用 document.querySelector / fetch 完成。
- 页面环境共享：你的 JS 在页面**主世界**执行，与页面自己的脚本共享内存、Cookie、全局变量及已登录状态 —— 因此页面自己定义的函数可以直接调用。
- 你运行在浏览器扩展里，**跨页面存活**：navigate 换页不会中断本轮对话。
- 你有一个**本机沙箱目录**（sandbox 工具）：可以在它里面读写文件、执行本机指令，
  但**仅限该目录之内** —— 沙箱外的文件系统你既看不见也改不动。
  落地的产物（还原出的算法、跑出来的数据、分析报告）都写在这里，比只写在回复里可靠。

## 对话历史
你**能看到之前的对话与工具结果**，它们按前缀区分来源：[工具 X 的执行结果] 是你自己调用工具拿到的观察，[系统提示] 是界面补的、不是你说过的话，[协议错误] 是你上一条回复没按协议输出时系统的回执。别把后两者当成自己的结论。

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
   - 必须显式 return 一个可序列化值（上限 ${RESULT_LIMIT_BYTES / 1024}KB）。支持 await、主世界全局变量、带凭证 fetch。
   - code 是 JSON 字符串：多行 JS 的换行必须写成 \\n、双引号必须写成 \\"，直接粘贴带真实换行的代码会破坏外层 JSON 解析，当次调用即判协议错误。
   - 禁止在此工具内修改 location.href 跳转。

2. navigate —— 页面导航与跳转
   args: {"url": "https://... 或相对路径"}
   - 页面加载完毕后返回最终规范化 URL。

3. tamper —— 引擎级网络与响应篡改（持久化影响页面逻辑必用此工具）
   args: {"action": "get"} 
      或 {"action": "set", "intercept": [...], "request": [...], "headers": [...]}
   - intercept/request 规则项：
     {"enabled": true, "url_pattern": "* 或子串", "key": "字段名(取末级键名)", "value": any, "op": "set" | "delete"}
     注：删除字段请显式指定 "op": "delete"；修改值指定 "op": "set", "value": 目标值。
   - headers 规则项：
     {"enabled": true, "url_pattern": "*", "name": "Header-Name", "value": "值(留空则为删除该头)"}
   - 核心原则：修改页面接收的数据必须用此工具，不能仅用 js 工具局部修改。

4. storage —— 底层存储与 Cookie 管理（绕过篡改引擎读写真实物理数据）
   args:
   - 读取: {"action": "get", "area": "local" | "session" | "cookie"}
   - 写入: {"action": "set", "area": "local" | "session" | "cookie", "key": "键名", "value": "字符串值"}
   - 删除: {"action": "delete", "area": "local" | "session" | "cookie", "key": "键名"}
   注：Cookie 的 key 必须严格使用 get 返回的唯一标识（常含 domain/path）。

5. tokens —— JWT 令牌分析与改写
   args:
   - 检索全部 JWT: {"action": "find"}
   - 解码单条: {"action": "decode", "token": "eyJ..."}
   - 改写并写回: {"action": "rewrite", "token": "...", "changes": {"key": val}, "area": "local", "key": "find返回的key"}
   注：改写 Payload 会使原始服务端签名失效。

6. sandbox —— 本机沙箱：读写文件与执行指令
   args（action 全小写，可用 ${SANDBOX_ACTIONS.join(' / ')}）:
   - 列目录: {"action": "list", "path": "..."}
   - 读文件: {"action": "read", "path": "..."}
   - 写文件: {"action": "write", "path": "...", "content": "文本内容"}
   - 删文件: {"action": "delete", "path": "..."}
   - 执行指令: {"action": "exec", "command": "node .js", "timeout": 30000}
   - **只能在沙箱目录里操作**：path 一律相对沙箱根，写 \`..\`、绝对路径或盘符会被拒绝。
     沙箱外的文件这里读不到 —— 要取页面上的东西用 js，不要指望这条工具。
   - 目录不存在时自动创建；write 会连带建父目录，不用先 mkdir。
   - exec 的工作目录就是沙箱根，用本机 shell 跑；写完脚本要在**同一条 exec** 里跑它，
     write 本身不会执行任何东西。
   - timeout 缺省 ${SANDBOX_EXEC_TIMEOUT_DEFAULT_MS / 1000} 秒，上限 ${SANDBOX_EXEC_TIMEOUT_MAX_MS / 1000} 秒；超时的进程会被杀掉。
   - 单次回传上限 ${SANDBOX_TEXT_LIMIT_BYTES / 1024}KB：大文件不要整份 read，
     用 exec 配管道（findstr / Select-String / head）只取需要的那部分。`;

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
