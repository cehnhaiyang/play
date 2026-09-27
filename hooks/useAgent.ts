import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
    AgentMessage,
    AgentRunStatus,
    AgentScript,
    AgentToolName,
    AiChatMessage,
    HeaderRule,
    TamperRule,
    WebviewElement,
} from '../meta';
import { chat } from '../services/AiService';
import {
    buildCookieKeys,
    collectDroppedRules,
    decodeJwt,
    findCookieByKey,
    generateId,
    pickJwtCandidates,
    rewriteJwtPayload,
} from '../utils/utils';
import { loadJSON, saveJSON } from '../utils/persist';
import type { TamperState } from './useBrowse';

/**
 * ============================================================================
 * useAgent — Agent 工作空间（在已登录的页面里执行脚本）
 * ============================================================================
 *
 * 形状是**代码执行器**，不是点击驱动器。工具只有五个：
 *
 *   S             脚本工具，args.action 选四件事：
 *                 R 在活动页面主世界跑一段脚本 / L 列出已保存脚本
 *                 S 保存脚本 / D 删除脚本
 *   navigate      跳转并等页面就绪
 *   tamper_rules  读写拦截规则（响应 / 请求体 / 请求头）
 *   storage       读写 localStorage / sessionStorage / Cookie
 *   tokens        JWT 查找 / 解码 / 改写
 *
 * 后三个是**用户手动面板能力的开放**，不是 S 的替代：规则必须在引擎层生效
 * （钩子装在页面主世界，脚本只影响自己那一次调用），Cookie 必须走原生 API
 * （HttpOnly 在渲染进程里读不到）。
 *
 * 点击、输入、取数、翻页全部塌缩成 S·R 里的一行代码。这样做的依据是
 * 上下文经济学：每次观察都要序列化进模型上下文，DOM 快照动辄数万 token；
 * 而脚本的返回值可以截断，代码本身高度可压缩。
 * 同理，S 的四个动作合并成一个工具条目 —— 工具说明每一步都随请求重发一次。
 *
 * 由此免费拿到三样 IDE 里 fetch 补不上的东西：**会话 cookie、页面自身的 JS 函数
 * （签名参数往往由混淆代码生成）、真实 TLS 栈**。这也是本功能存在的唯一理由 ——
 * 如果目标站点 fetch 就能取到数据，那在 IDE 里写脚本确实更划算。
 *
 * 协议用 JSON 而不是原生 tool_calls：换服务商时不必重做适配层。
 * 代价是循环要自己解析模型输出，收益是任何 OpenAI 兼容端点都能跑。
 */

/* -------------------------------------------------------------------------- */
/*                                  常量                                       */
/* -------------------------------------------------------------------------- */

/**
 * 单次观察回传上限 —— **这是保险丝，不是预算**。
 *
 * 定这个值的依据是成本模型，不是直觉。第 i 步的结果会被后续每一步重发一次，
 * 所以总成本里步数那一项是平方级的：多走一步的边际成本约 (A+R)·S。
 *
 * 由此得出：**为了省 token 而截断是净亏的**。把一份数据拆成 3 次取要多走 2 步，
 * 重发量按平方增长，远超过省下的那点首包体积。截断只要多逼出 2 步就亏。
 *
 * 所以它只防一件事：模型 return document.documentElement.outerHTML 这类
 * 明显超标的返回（大型站实测 1.95MB，进请求会把上下文顶穿、整轮直接失败）。
 * 32KB 的依据：正常量级的单次抓取（列表页、API 响应）装得下，不必拆步；
 * 而 391KB 的 SPA outerHTML 会被挡住。
 */
const RESULT_LIMIT_BYTES = 32768;

/**
 * 单轮对话内的最大工具调用次数，防模型陷入死循环。
 *
 * 不设太小：这个上限与上面的截断是同一类风险 —— 差一步没做完，比多走几步更亏
 * （已完成的步骤全部作废，用户得从头再来）。
 */
const MAX_STEPS = 20;

/**
 * 单条推理文本的落盘上限（字节）。
 *
 * 推理模型的思考可以很长（实测单步几千字），而它**每一步都会存一份**。
 * 200 条消息里若每条都挂着完整推理，光这一项就能把 1.5MB 的预算吃光，
 * 把真正有用的对话与工具结果挤掉 —— 那是拿主要信息换次要信息。
 * 32KB 足够装下一次完整判断（比任何一次工具返回值都宽），
 * 超出部分截断并注明，用户至少知道"这里被砍过"。
 */
const REASONING_LIMIT_BYTES = 32768;

const SCRIPTS_STORE_KEY = 'agent-scripts';
const SCRIPTS_STORE_MAX = 100;

const MESSAGES_STORE_KEY = 'agent-messages';
const MESSAGES_STORE_MAX = 200;

/**
 * 落盘体积预算（字节）。
 *
 * localStorage 常见配额 5MB。单限条数挡不住：一条消息最多 32KB，
 * 200 条 × 32KB = 6.3MB，脚本再 3.1MB，合计 9.4MB 直接超配额，
 * saveJSON 静默返回 false（异常被 persist 吞掉）—— 对话历史不再保存且无提示。
 * 所以这里按**字节**收敛，条数上限只作为附加保护。
 */
const STORE_BUDGET_MESSAGES = 1_500_000;
const STORE_BUDGET_SCRIPTS = 800_000;

/**
 * 重建模型上下文时的字节预算。
 *
 * 比落盘预算（1.5MB）小一个数量级：落盘是本地存储，这里是**每一次请求都要重发**
 * 的体积。历史上限由 MAX_STEPS 与 RESULT_LIMIT_BYTES 决定，一轮最坏约 20×32KB=640KB，
 * 那种轮次本身就接近上下文上限，再叠加历史必然被服务端拒绝；
 * 256KB 装得下 8 个满载轮次，常见量级的对话（几百字节一轮）能装下上千轮。
 */
const TRANSCRIPT_BUDGET_BYTES = 262_144;

/** 工具结果进历史时的单条上限。与 RESULT_LIMIT_BYTES 同源，这里再收一道是
 *  因为预算按**整轮**分配：一条 32KB 的旧观察不该把好几轮对话挤出去。 */
const TRANSCRIPT_RESULT_LIMIT_BYTES = 8192;

/** 从后往前取整轮，直到超出预算。至少保留一轮 —— 全超时也该留下最近发生的事。 */
const takeRecentRounds = (rounds: AiChatMessage[][], budget: number): AiChatMessage[] => {
    const kept: AiChatMessage[][] = [];
    let used = 0;
    for (let i = rounds.length - 1; i >= 0; i -= 1) {
        const size = byteLength(JSON.stringify(rounds[i]));
        if (used + size > budget && kept.length > 0) break;
        used += size;
        kept.push(rounds[i]);
    }
    return kept.reverse().flat();
};

/**
 * 把界面上的对话记录重建成**发给模型的消息序列**。
 *
 * 存在的理由：`send()` 原先每次只发 `[{ role:'user', content: text }]`，
 * 于是模型每一轮都从零开始 —— 追问「它」「刚才那个」、以及按 1164 行那句
 * 「可以让我继续」接着做，全都无从谈起。
 *
 * 两个**不能直接复用 `messages`** 的原因：
 *
 * 1. 两者形状不同。界面的 `AgentMessage` 是展示记录（带 reasoning / 脚本源码 /
 *    时间戳），模型侧只该拿到 role + content。推理尤其不能进 —— 那会把每一步的
 *    独白在后续每一步重发一遍。
 * 2. 时序不同。工具结果在**本轮循环内**以 user 消息回灌（ReAct 形态），
 *    若从 `messages` 全量重建，它们会被当成"用户说的话"再发一遍，同一份观察
 *    在一轮里出现两次。所以调用方必须在**追加本轮提问之前**读历史（见 send），
 *    本轮上下文交给循环自己维护。
 */
const buildTranscript = (messages: AgentMessage[]): AiChatMessage[] => {
    const rounds: AiChatMessage[][] = [];
    let current: AiChatMessage[] = [];
    // 同一轮里连续的观察合并进**一条** user 消息：一条 user 消息带多段结果，
    // 比拆成多条更贴近真实的 ReAct 轨迹。
    let observations: string[] = [];

    const flushObservations = () => {
        if (observations.length === 0) return;
        current.push({ role: 'user', content: observations.join('\n\n') });
        observations = [];
    };
    // 一轮的边界只有一个：新的用户提问。所以末尾那些"还没有新提问"的观察
    // （上一轮结束后 urlPattern 脚本自动执行）自然留在上一轮里，
    // 不需要额外判断 —— 它们本来就还在 current 里没被 flush 过。
    const flushRound = () => {
        flushObservations();
        if (current.length > 0) rounds.push(current);
        current = [];
    };

    for (const m of messages) {
        if (m.role === 'user') {
            // 用户发言 = 新的一轮
            flushRound();
            current.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant') {
            flushObservations();
            if (!m.content) continue;
            if (m.notice) {
                // 界面补的提示（中断 / 空回复 / 步数耗尽）不是模型说的话。
                // 原样回放等于让模型读到一句自己从未写过的台词。
                observations.push(`[系统提示] ${m.content}`);
            } else {
                current.push({ role: 'assistant', content: m.content });
            }
        } else if (m.result || m.content) {
            // 自动执行的脚本不是模型的调用，写成「工具结果」会凭空捏造一次调用；
            // 但它确实改变了页面，所以作为一条**环境事件**如实告知。
            observations.push(m.auto
                ? `[自动脚本「${m.content.replace(/^自动执行：/, '')}」已在页面上执行]\n${m.result || '(无返回值)'}`
                : `[工具 ${m.label || m.tool || '未知'} 的执行结果]\n${m.result || '(空)'}`);
        }
    }
    flushRound();

    // 单条观察截断在取整轮**之前**做：否则一条 32KB 的旧结果会让整轮在预算里显得
    // 很贵，连带把同一轮的对话一起丢掉。
    const capped = rounds.map((round) => round.map((msg) => (
        typeof msg.content === 'string'
            ? { ...msg, content: truncateBytes(msg.content, TRANSCRIPT_RESULT_LIMIT_BYTES) }
            : msg
    )));

    return takeRecentRounds(capped, TRANSCRIPT_BUDGET_BYTES);
};

/** 工具清单：既是给模型看的文档，也是解析时的白名单 */
const TOOL_SPEC = `可用工具（每次只回一个 JSON 对象，不要回数组）：

1. S —— 脚本工具，args.action 选四件事：R 运行 / L 列出 / S 保存 / D 删除。
   下面只写 args，外层都是 {"tool":"S","args":…}
   R {"action":"R","code":"..."}   在当前页面主世界跑一段 JS
     - 可用 await、页面自身的函数与全局变量、带 cookie 的 fetch。
     - 必须 return 一个值，序列化后回传（上限 32KB）。
     - 例：{"action":"R","code":"const r=await fetch('/api/user').then(r=>r.json()); return {vip:r.data.is_vip};"}
   L {"action":"L"}                列出已保存脚本（含 id）
   S {"action":"S","name":"...","description":"...","code":"...","urlPattern":""}
     urlPattern 填 URL 子串则每次打开匹配页面自动执行，留空只在对话里调用。
   D {"action":"D","id":"..."}     删除脚本，id 从 L 的返回里取。

2. navigate —— 跳转到新地址，等页面加载完成后再返回。
   args: { "url": "https://..." }
   注意：不要在 S 的 R 里写 location.href 来跳转，那样返回值会随页面一起销毁。

3. tamper_rules —— 读写**拦截规则**（响应篡改 / 请求体篡改 / 请求头篡改）。
   args: { "action": "get" } 或 { "action": "set", "intercept": [...], "request": [...], "headers": [...] }
   set 时只传你要改的那一类，其余保持不变。
   规则字段：
     拦截与请求体规则 { "enabled": true, "urlPattern": "*", "jsonPath": "is_vip", "newValue": "true" }
       - urlPattern：glob 或子串，留空或 * 表示全部。**不是正则**。
       - jsonPath：只按**最后一段**当键名，不限层级。data.user.id 与 id 等价。不是 JSONPath。
       - newValue：字符串写法。true/false/null/42/3.14 会按类型写入；其余按字符串。
         加 = 前缀强制当字符串（=007 得到 "007"）；写 undefined 会**删除该字段**。
     请求头规则 { "enabled": true, "urlPattern": "*", "headerName": "Referer", "headerValue": "https://..." }
       - headerName 大小写不敏感；headerValue 留空表示**删除**该请求头。
   重要：**想改页面收到的数据必须用这个工具，不能用 S 的 R** ——
   规则生效在引擎层（钩住页面的 JSON.parse / fetch / XHR / 存储读取），
   而脚本只能影响它自己那一次调用的返回值。
   改动立刻对当前页面生效，但**不会自动写入本地存储**，用户需要自己点「应用更改」才会持久化。
   返回里若出现 dropped，说明那几条规则缺少目标键（jsonPath / headerName 为空），
   引擎会跳过它们、不会生效 —— 按 dropped 里的 group 与 index 定位并补上字段再 set 一次。

4. storage —— 读写 localStorage / sessionStorage / Cookie。
   args: { "action": "get", "area": "local" }
         { "action": "set", "area": "local", "key": "vip", "value": "true" }
         { "action": "remove", "area": "local", "key": "vip" }
   area 取 "local" / "session" / "cookie"。
   get 返回的是**真实值**（绕过篡改引擎读的），页面 JS 看到的可能被规则改写。
   Cookie 的读取会带上 httpOnly / sameSite / 过期时间，set 时会原样保留这些属性；
   写一个不存在的 Cookie 名会新建一条。
   **改 / 删 Cookie 请用 get 返回的 key 字段**：同名 cookie 可以在不同 domain/path 下
   并存（访问子域时很常见），只给 name 会因为分不清哪一条而报错。

5. tokens —— JWT 令牌：查找、解码、改写。
   args: { "action": "find" }
         { "action": "decode", "token": "eyJ..." }
         { "action": "rewrite", "token": "eyJ...", "changes": {"vip": true}, "area": "local", "key": "token" }
   find 会在 Cookie 与两个 Storage 里搜出所有像 JWT 的值，每条带 from / area / key。
   同一个 token 常同时存在多处（登录态就是这种形态），find 会全部列出，
   并在 sharedTokens 里标出哪些 token 出现在多个位置 —— 只改一处，页面读的可能
   仍是另一处的旧值。要全部改掉就对同一 token 逐个 rewrite。
   rewrite 把 changes 合并进 payload，然后**写回** area + key 指定的位置。
   **key 要原样用 find 返回的那个**：cookie 的 key 可能是 "sid (sub.example.com)"
   这种带 domain 的形态（同名 cookie 在不同域下并存时用来区分），
   自己按 cookie 名拼一个会找不到。
   注意：改写 payload 会让**签名失效**，服务端验签就会拒绝。这是这类调试的固有前提。`;

const SYSTEM_PROMPT = `你是一个浏览器自动化助手，在一个已登录的 Electron 浏览器里工作。

## 你的能力边界

你**没有**点击、输入、读取 DOM 的工具，也不需要 —— 请直接写 JavaScript。
用 document.querySelector(...).click() 点击，用 .value = 赋值，用 textContent 读数。
页面已经登录，你的脚本与页面自身代码共享同一个 JS 环境。

## 输出协议

每次回复只输出**一个 JSON 对象**，放在 \`\`\`json 代码块里：

\`\`\`json
{"thought": "简述你这一步的判断", "tool": "S", "args": {"action": "R", "code": "..."}}
\`\`\`

当你已经拿到答案、不需要再调用工具时，输出：

\`\`\`json
{"thought": "...", "final": "给用户的最终回答"}
\`\`\`

${TOOL_SPEC}

## 纪律

- **一次拿完你需要的东西。** 你的每一步都会把之前所有结果重新发一遍，所以
  **多走一步的代价远大于一次多拿点数据**。列表页、接口响应这类正常量级的数据，
  一次全取回来即可，不要为了"保险"分批取。
- 只有整页 DOM（document.documentElement.outerHTML）这类明显超标的返回才需要
  收窄范围 —— 例如 [...document.querySelectorAll('a')].slice(0,50).map(a=>a.href)。
- 脚本抛错不是终点：错误会原样回传给你，读懂它然后改代码重试。
- 一次只做一件事。先确认页面结构（比如数一下元素个数），再动手取数据。
- 你**能看到之前几轮的对话与工具结果**（它们以 user 消息形式出现，
  前缀是「[工具 … 的执行结果]」「[自动脚本…]」或「[系统提示]」）。
  用户说「继续」「它」「刚才那个」时指的就是上面这些内容 ——
  先回看再动手，不要重新探测已经查清的东西。`;

/* -------------------------------------------------------------------------- */
/*                                  工具函数                                    */
/* -------------------------------------------------------------------------- */

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * 按**字节**截断，且不切坏多字节字符。
 *
 * 用二分而非 slice(0, n)：中文一个字 3 字节，按字符数截断会让实际体积随内容浮动，
 * 上限就形同虚设。
 *
 * `tail` 是截断说明的后半句。默认措辞是"仅回传…"——那只对**发给模型**的工具返回值
 * 成立；推理文本是**存给用户读**的，用同一个词会说反（见 keepReasoning 的传参）。
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
 * 两个坑：
 *  - 不能用正则匹配花括号 —— 脚本源码里必然含 { } 与字符串，只有字符串感知的
 *    括号计数才能切准边界；
 *  - 不能只看第一个 { —— 模型常在 JSON 前写一句"我的计划是…{…}"，
 *    那个花括号不是 JSON 起点。因此逐个 { 当起点试，解析成功即返回。
 */
const extractJsonObject = (text: string): Record<string, unknown> | null => {
    if (!text) return null;

    const starts: number[] = [];
    for (let i = 0; i < text.length && starts.length < 50; i += 1) {
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
 * 包一层的必要性：模型写的是脚本片段（含 return），裸 executeJavaScript 里
 * 顶层 return 是语法错误；同时返回值必须自己序列化 —— executeJavaScript 对
 * DOM 节点、循环引用这类不可序列化的值会直接抛错或回传空对象。
 */
const buildScriptSource = (code: string): string => `(async () => {
  let __v;
  try {
    __v = await (async () => {
${code}
    })();
  } catch (__err) {
    return JSON.stringify({ error: String(__err && __err.message || __err) });
  }
  try {
    if (__v === undefined) return 'null';
    const __s = JSON.stringify(__v);
    return __s === undefined ? JSON.stringify(String(__v)) : __s;
  } catch (__e) {
    return JSON.stringify({ error: '返回值无法序列化：' + String(__e && __e.message || __e) });
  }
})()`;

const readWebviewUrl = (webview: WebviewElement): string => {
    try { return webview.getURL?.() || ''; } catch { return ''; }
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * 工具结果是否为错误。
 *
 * 不能用 `result.startsWith('{"error"')` —— 脚本正常返回
 * `{"error": null, "data": [...]}` 是合法值，按字符串前缀判会被标成失败。
 * 必须解析出来看：**含 error 字段且它是非空字符串**才算错。
 */
const isErrorResult = (result: string): boolean => {
    if (!result.startsWith('{')) return false;
    try {
        const parsed = JSON.parse(result) as { error?: unknown } | null;
        return !!parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error.length > 0;
    } catch {
        return false;
    }
};

/**
 * 按**字节预算**保留最新的若干条。
 *
 * 只限条数挡不住体积：一条消息最多 32KB，200 条就是 6.3MB，
 * 超过 localStorage 常见 5MB 配额后 saveJSON 会静默返回 false ——
 * 表现为"对话历史忽然不再保存"，且没有任何提示。
 *
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
 * 把模型给的字段规则收敛成 TamperRule[]。
 *
 * 返回 string 表示**出错**（错误消息），返回数组表示成功 —— 用联合类型而不是
 * 抛异常，是因为这里的错误要原样回传给模型让它自己改，不该中断整轮对话。
 *
 * 缺 id 的补一个：面板按 id 做 React key 与删除定位，没有 id 的规则会让
 * 删除按钮删错行。
 */
const normalizeFieldRules = (raw: unknown, label: string): TamperRule[] | string => {
    if (!Array.isArray(raw)) return `${label} 必须是数组`;
    return raw.map((item) => {
        const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        return {
            id: typeof r.id === 'string' && r.id ? r.id : generateId(),
            enabled: r.enabled !== false,
            urlPattern: toRuleString(r.urlPattern),
            jsonPath: toRuleString(r.jsonPath),
            newValue: toRuleString(r.newValue),
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
            urlPattern: toRuleString(r.urlPattern),
            headerName: toRuleString(r.headerName),
            // 空串保持空串：引擎把空 headerValue 解释为「删除该请求头」，
            // 转成别的值会把这个语义弄丢。
            headerValue: toRuleString(r.headerValue),
        };
    });
};

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
 * 两种写法：
 *  - `key`：`storage get` / `tokens find` 返回的唯一键，精确匹配，首选；
 *  - `name`：只给名字，向后兼容。**只在没有歧义时才接受** ——
 *    同名 cookie 在不同 domain/path 下并存时（访问子域就会遇到），
 *    按名字取第一条会静默改错对象，甚至把第一条的 httpOnly / 过期时间
 *    抄到第二条上。这种情况必须报错让模型改用 key。
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
     * 要 state 不只是 actions：规则的真值由 useTamper 持有，`tamper_rules` 的
     * 部分更新（只传 intercept 不传 headers）必须先读到当前值再合并。
     * Agent 这边**不另存一份副本** —— 两份真值迟早会不一致。
     */
    tamper: TamperState;
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
     * 运行中为 false：主循环正拿着 messages 追加，此刻改动会和它的下一次
     * appendMessage 抢同一个数组。界面据此禁用按钮，而不是让用户点了没反应。
     */
    canEdit: boolean;
    actions: {
        send: (prompt: string) => Promise<void>;
        stop: () => void;
        clear: () => void;
        /** 删除单条消息体（只删这一条，不牵连整轮） */
        removeMessage: (id: string) => void;
        /** 回退到某条消息所属轮次之前，返回该轮的提问原文（供填回输入框） */
        rewindTo: (id: string) => string;
        /** 手动执行一段脚本（界面上直接跑，不进对话） */
        runScript: (code: string) => Promise<string>;
        removeScript: (id: string) => void;
        toggleScript: (id: string) => void;
    };
}

/**
 * 定稿一轮推理文本：截断到落盘上限，空串归一成 undefined。
 *
 * 抽成**模块级纯函数**（而不是 hook 内的 useCallback）是为了能直接单测：
 * 它的两个判据都容易写错，且错了不会报错、只会让推理悄悄消失或悄悄膨胀 ——
 * 前者正是本次要修的 bug 本身，后者会把 1.5MB 的落盘预算吃光。
 *
 * 空串必须转 undefined：否则每条没有推理的消息都会多带一个 `reasoning: ""`，
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
        // 存量数据里没有 reasoning 字段（它是后加的），缺失即为 undefined，
        // 界面按"没有推理"处理 —— 不需要额外迁移
        return saved.slice(-MESSAGES_STORE_MAX);
    });
    const [scripts, setScripts] = useState<AgentScript[]>(() => {
        const saved = loadJSON<unknown[]>(SCRIPTS_STORE_KEY, []);
        if (!Array.isArray(saved)) return [];
        // slice(-MAX) 而非 slice(0, MAX)：与落盘侧一致，超出时保留**最新**的，
        // 而不是最旧的（旧写法在存量超过上限时会优先留下早就没用的脚本）
        return saved.map(normalizeScript).filter((s): s is AgentScript => !!s).slice(-SCRIPTS_STORE_MAX);
    });
    const [status, setStatus] = useState<AgentRunStatus>('idle');
    const [error, setError] = useState('');
    const [streaming, setStreaming] = useState<{ content: string; reasoning: string } | null>(null);

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

    // 对话历史镜像。send() 要读**本轮开始之前**的历史来重建模型上下文，
    // 而它读不了 messages：send 开头的 appendMessage 只是排队了一次 setState，
    // 同一次渲染的闭包里 messages 仍是旧值 —— 依赖 messages 还会让 send 的身份
    // 每来一条消息就变一次，把 BrowsePanel 里依赖它的 useCallback 全部击穿。
    const messagesRef = useRef(messages);
    useEffect(() => { messagesRef.current = messages; }, [messages]);

    // 篡改引擎镜像，同理：dispatchTool 在 await 之间读它，绑快照会读到旧规则。
    // 存整个 TamperState 而不是拆成几个字段：state 与 actions 必须来自同一次渲染，
    // 混用两次渲染的切片会让"读到的旧规则"与"写入的新规则"打架。
    const tamperRef = useRef(deps.tamper);
    useEffect(() => { tamperRef.current = deps.tamper; }, [deps.tamper]);

    // 停止标志。不能靠 state：循环体在 await 之间读它，state 更新不会及时可见
    const stoppedRef = useRef(false);
    const busyRef = useRef(false);
    // 在途请求的中断句柄：点停止要真掐断连接，而不是等整包回来再丢弃
    const abortRef = useRef<AbortController | null>(null);

    const appendMessage = useCallback((message: AgentMessage) => {
        setMessages((prev) => [...prev, message].slice(-MESSAGES_STORE_MAX));
    }, []);

    /* ------------------------------ 脚本执行 ------------------------------ */

    const execOn = useCallback(async (webview: WebviewElement, code: string): Promise<string> => {
        try {
            const raw = await webview.executeJavaScript(buildScriptSource(code));
            return truncateBytes(typeof raw === 'string' ? raw : String(raw), RESULT_LIMIT_BYTES);
        } catch (e) {
            // 脚本抛错不是终点：把错误原样交给模型，它自己改代码重试
            const reason = e instanceof Error ? e.message : String(e);
            return JSON.stringify({ error: reason });
        }
    }, []);

    const execActive = useCallback(async (code: string): Promise<string> => {
        const webview = deps.getActiveWebview();
        if (!webview) return JSON.stringify({ error: '当前没有可用的页面（标签页是空白页或未就绪）' });
        return execOn(webview, code);
    }, [deps.getActiveWebview, execOn]);

    /**
     * 等**指定那个** webview 就绪。
     *
     * 两个必须带上的条件：
     *  - 比对 webview 身份 —— onPageReady 是全局广播，不校验的话别的标签页加载完
     *    也会 resolve(true)，navigate 会带着"已加载"的错误结论返回；
     *  - 监听 stoppedRef —— 否则点停止后这个 Promise 要等满 timeout 才结束，
     *    期间界面一直停在"正在页面里执行…"。
     */
    const waitForPageReady = useCallback((webview: WebviewElement, timeoutMs = 15000) => new Promise<boolean>((resolve) => {
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

        unsubscribe = deps.onPageReady((_tabId, readyWebview) => {
            if (readyWebview === webview) finish(true);
        });

        // 轮询停止标志：stop() 只置标志位与 abort 在途 fetch，够不到这个 Promise。
        // 不轮询的话，navigate 后点停止要等满 timeout 才结束，界面一直停在"正在执行…"。
        poll = window.setInterval(() => {
            if (stoppedRef.current) finish(false);
        }, 100);

        deadline = window.setTimeout(() => finish(false), timeoutMs);
    }), [deps.onPageReady]);

    /* ------------------------------ 工具派发 ------------------------------ */

    const dispatchTool = useCallback(async (
        tool: AgentToolName,
        args: Record<string, unknown>
    ): Promise<string> => {
        switch (tool) {
            /**
             * 脚本工具：R 运行 / L 列出 / S 保存 / D 删除。
             *
             * 四个动作共用一个工具名，靠 args.action 区分。合并的依据是它们本就
             * 操作同一份状态（脚本清单），而工具说明每一步都要随请求重发一次。
             */
            case 'S': {
                const action = asString(args.action).toUpperCase();

                if (action === 'R') {
                    return execActive(asString(args.code));
                }

                if (action === 'L') {
                    return JSON.stringify(scriptsRef.current.map((s) => ({
                        id: s.id, name: s.name, description: s.description,
                        urlPattern: s.urlPattern, enabled: s.enabled,
                    })));
                }

                if (action === 'S') {
                    const code = asString(args.code);
                    if (!code.trim()) return JSON.stringify({ error: '缺少 code' });
                    if (scriptsRef.current.length >= SCRIPTS_STORE_MAX) {
                        // 满了就明说，不能静默丢弃：原先 slice(0, MAX) 砍掉的正是刚加进去的
                        // 那一条（在数组末尾），却仍回 {saved:true}，模型会一直找不到它。
                        return JSON.stringify({
                            error: `脚本数量已达上限 ${SCRIPTS_STORE_MAX}，请先用 S 的 D 删掉不用的`,
                        });
                    }
                    const script: AgentScript = {
                        id: generateId(),
                        name: asString(args.name) || '未命名脚本',
                        description: asString(args.description),
                        code,
                        urlPattern: asString(args.urlPattern),
                        enabled: true,
                    };
                    setScripts((prev) => [...prev, script].slice(-SCRIPTS_STORE_MAX));
                    return JSON.stringify({ saved: true, id: script.id, name: script.name });
                }

                if (action === 'D') {
                    const id = asString(args.id);
                    const exists = scriptsRef.current.some((s) => s.id === id);
                    if (!exists) return JSON.stringify({ error: `找不到脚本 ${id}` });
                    setScripts((prev) => prev.filter((s) => s.id !== id));
                    return JSON.stringify({ deleted: true, id });
                }

                return JSON.stringify({
                    error: `未知 action：${action || '(空)'}（S 可用 R 运行 / L 列出 / S 保存 / D 删除）`,
                });
            }

            case 'navigate': {
                const url = asString(args.url);
                if (!url) return JSON.stringify({ error: '缺少 url' });
                const webview = deps.getActiveWebview();
                if (!webview) return JSON.stringify({ error: '当前没有可用的页面' });

                const ready = waitForPageReady(webview);
                try {
                    await webview.loadURL(url);
                } catch (e) {
                    return JSON.stringify({ error: `导航失败：${e instanceof Error ? e.message : String(e)}` });
                }
                const ok = await ready;
                return JSON.stringify({ url, loaded: ok, currentUrl: readWebviewUrl(webview) });
            }

            case 'tamper_rules': {
                const action = asString(args.action) || 'get';
                const current = tamperRef.current.state;

                if (action === 'get') {
                    return JSON.stringify({
                        intercept: current.interceptRules,
                        request: current.requestRules,
                        headers: current.headerRules,
                        // 说清"生效"与"持久"的区别：模型需要知道用户还得点一下才存住
                        note: '这些规则已对当前页面生效。改动只在内存里，用户需在面板点「应用更改」才会持久化。',
                    });
                }

                if (action !== 'set') {
                    return JSON.stringify({ error: `未知 action：${action}（可用 get / set）` });
                }

                // 部分更新：只合并传了的类别，其余原样保留。
                // 不这么做的话，模型只想加一条请求头规则却会把用户的拦截规则全清空。
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

                // 报出会被引擎跳过的规则。
                // 引擎对没有目标键的规则直接丢弃（它永远匹配不上），但那是**静默**的 ——
                // 不回传的话模型收到 applied:true 就以为设置成功了，实际页面里什么都没发生，
                // 而且它会一直不知道为什么"改了没反应"。带上 group+index+原因，一步就能改对。
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

                if (area === 'cookie') {
                    if (action === 'get') {
                        const cookies = await tamperRef.current.actions.getCookies();
                        const keys = buildCookieKeys(cookies);
                        return JSON.stringify({
                            count: cookies.length,
                            // key 与 tokens find 用同一套唯一键：同名 cookie 在不同域下
                            // 并存时，模型必须能指定改哪一条（set / remove 都收 key）。
                            cookies: cookies.map((c, i) => ({
                                key: keys[i],
                                name: c.name, value: c.value, domain: c.domain, path: c.path,
                                httpOnly: c.httpOnly, secure: c.secure,
                                sameSite: c.sameSite, expirationDate: c.expirationDate,
                            })),
                            note: '这是真实值。页面 JS 读到的可能被拦截规则改写。set / remove 请用 key 指定是哪一条。',
                        });
                    }

                    // key 优先，name 作为向后兼容的兜底（单条同名时两者等价）
                    const name = asString(args.name);
                    const key = asString(args.key);
                    if (!name && !key) return JSON.stringify({ error: '缺少 name 或 key' });

                    if (action === 'remove') {
                        const list = await tamperRef.current.actions.getCookies();
                        const target = resolveCookieArg(list, key, name);
                        if (target.error) return JSON.stringify({ error: target.error });
                        // 没命中：不能当成"删掉了"。removeCookie 按 name 删，
                        // 传一个不存在的名字 Electron 也不报错，静默返回成功。
                        if (!target.cookie) {
                            return JSON.stringify({ error: `找不到 cookie：${key || name}` });
                        }
                        const ok = await tamperRef.current.actions.removeCookie(target.cookie.name);
                        return ok
                            ? JSON.stringify({ removed: true, name: target.cookie.name, note: '同名不同 path 的 Cookie 会被一起删掉。' })
                            : JSON.stringify({ error: '删除失败：当前没有可用的页面地址' });
                    }

                    if (action !== 'set') {
                        return JSON.stringify({ error: `未知 action：${action}（可用 get / set / remove）` });
                    }

                    // 已存在则取回原属性再改值 —— setCookie 是整条覆盖，
                    // 漏掉 httpOnly / expirationDate 会让会话 cookie 降级甚至掉登录态。
                    // 必须按唯一键取，否则同名 cookie 并存时会把**另一条**的属性抄过来。
                    const list = await tamperRef.current.actions.getCookies();
                    const target = resolveCookieArg(list, key, name);
                    if (target.error) return JSON.stringify({ error: target.error });
                    const existing = target.cookie;
                    const finalName = existing ? existing.name : (name || key);
                    // 值统一成字符串：cookie 只能是字符串，而 asString 会把数字/布尔
                    // 变成空串 —— 那等于静默清空这条 cookie，比报错更难查。
                    const cookieValue = typeof args.value === 'string' ? args.value : String(args.value ?? '');
                    const ok = await tamperRef.current.actions.setCookie({
                        ...(existing || {}),
                        name: finalName,
                        value: cookieValue,
                        ...(args.domain !== undefined ? { domain: asString(args.domain) } : {}),
                        ...(args.path !== undefined ? { path: asString(args.path) } : {}),
                    });
                    return ok
                        ? JSON.stringify({
                            // 回显写进去的那个值，不是原始入参 —— 两者会被上面的转换拉开
                            saved: true, name: finalName, value: cookieValue,
                            preserved: existing ? '已保留原有 httpOnly / sameSite / 过期时间' : '新建 Cookie',
                        })
                        : JSON.stringify({ error: '写入失败：当前没有可用的页面地址' });
                }

                const read = area === 'local'
                    ? tamperRef.current.actions.getLocalStorage
                    : tamperRef.current.actions.getSessionStorage;

                if (action === 'get') {
                    const raw = await read();
                    // 展开成对象再返回，而不是把 JSON 字符串塞进 data。
                    // 塞字符串的话模型得对着 "{\"k\":\"v\"}" 再解一次，
                    // 多一层转义既费 token 又容易让它误判成"没有数据"。
                    return JSON.stringify({
                        area,
                        data: safeParseObject(raw),
                        note: '这是真实值（绕过拦截规则读的）。页面 JS 读到的可能被规则改写。',
                    });
                }

                const key = asString(args.key);
                if (!key) return JSON.stringify({ error: '缺少 key' });

                if (action === 'remove') {
                    const fn = area === 'local'
                        ? tamperRef.current.actions.removeLocalStorage
                        : tamperRef.current.actions.removeSessionStorage;
                    const ok = await fn(key);
                    return ok
                        ? JSON.stringify({ removed: true, area, key })
                        : JSON.stringify({ error: '删除失败：页面可能已禁用存储，或没有可用的页面' });
                }

                if (action !== 'set') {
                    return JSON.stringify({ error: `未知 action：${action}（可用 get / set / remove）` });
                }

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

                if (action === 'find') {
                    const cookies = await tamperRef.current.actions.getCookies();
                    const local = safeParseObject(await tamperRef.current.actions.getLocalStorage());
                    const session = safeParseObject(await tamperRef.current.actions.getSessionStorage());

                    // 来源要标出来：模型下一步 rewrite 时必须知道写回哪里。
                    // key 必须是**能写回去的键**：storage 用存储键名，cookie 用
                    // 面板同款的唯一键（name + path + domain）——
                    // 直接用 cookie 名不行：访问子域时同名 cookie 会并存
                    // （sid@sub.example.com 与 sid@.example.com），
                    // 两条的 from 会完全相同、rewrite 又只命中先出现的那条，
                    // 于是第二条永远改不到，模型还看不出有两条。
                    // 也不能把 cookie 数组交给下面这个按 Object.entries 枚举的 helper ——
                    // 数组的键是 "0"/"1" 下标，模型拿这个当 name 去 rewrite 会找不到。
                    //
                    // 去重按**位置**而不是按 token 值：同一个 token 常常同时躺在
                    // local / session / cookie 里（登录态就是这种形态）。按值去重会让
                    // 模型只看到其中一处，改写完另一处仍是旧值 —— 而页面读的可能正是
                    // 那一处，于是 rewrite 报了成功却没生效。
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

                if (action !== 'rewrite') {
                    return JSON.stringify({ error: `未知 action：${action}（可用 find / decode / rewrite）` });
                }

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

            default:
                return JSON.stringify({ error: `未知工具：${String(tool)}` });
        }
    }, [deps.getActiveWebview, execActive, waitForPageReady]);

    /* -------------------------------- 主循环 -------------------------------- */

    const send = useCallback(async (prompt: string) => {
        const text = prompt.trim();
        if (!text || busyRef.current) return;

        busyRef.current = true;
        stoppedRef.current = false;
        setError('');

        // 历史必须在 appendMessage **之前**读。那行之后 messagesRef 是否已经跟上，
        // 取决于 React 何时提交这次 setState（事件处理器里会被批处理，但
        // flushSync 之类的路径不保证）—— 读在它前面，就不必关心这个时序，
        // 也不会把本轮提问重复算进历史。
        //
        // 接上历史是本轮修复的核心：不接的话模型每轮都从零开始，
        // 追问「它 / 刚才那个」与按提示「继续」全部落空。
        const history = buildTranscript(messagesRef.current);

        appendMessage({ id: generateId(), role: 'user', content: text, at: Date.now() });

        // 模型侧记录。JSON 协议没有 tool role，观察结果以 user 消息回灌（ReAct 形态）
        const transcript: AiChatMessage[] = [...history, { role: 'user', content: text }];

        try {
            for (let step = 0; step < MAX_STEPS; step += 1) {
                if (stoppedRef.current) break;

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

                let reply: string;
                try {
                    reply = await chat({
                        system: SYSTEM_PROMPT,
                        messages: transcript,
                        reasoningEffort: 'high',
                        signal: controller.signal,
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
                    if (liveContent.trim()) {
                        appendMessage({
                            id: generateId(), role: 'assistant',
                            content: liveContent.trim(),
                            reasoning: keepReasoning(liveReasoning),
                            at: Date.now(),
                        });
                    } else if (liveReasoning.trim()) {
                        // 只有推理、没有正文（用户中途停止时很常见）：也要落一条，
                        // 否则这一轮的思考同样会随气泡消失 —— 那正是本次要修的问题。
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
                const tool = call?.tool as AgentToolName | undefined;

                // 没有工具调用 = 模型认为可以收尾了
                if (!call || !tool) {
                    const finalText = asString(call?.final) || reply.trim();
                    if (finalText) {
                        appendMessage({
                            id: generateId(), role: 'assistant',
                            content: finalText,
                            reasoning: keepReasoning(liveReasoning),
                            at: Date.now(),
                        });
                    } else {
                        // 空回复（推理模型偶发）：不能静默 break —— 那样用户看到对话
                        // 停在半路，分不清是结束还是卡住。
                        appendMessage({
                            id: generateId(),
                            role: 'assistant',
                            content: '（模型本轮没有返回内容，已停止。可以再说一次或换个说法。）',
                            notice: true,
                            at: Date.now(),
                        });
                    }
                    break;
                }

                const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;
                const thought = asString(call.thought);

                setStatus('acting');
                const result = await dispatchTool(tool, args);
                if (stoppedRef.current) break;

                // 合并成 S 之后，日志只写工具名会分不清模型做的是哪件事
                // （跑脚本 / 列清单 / 存脚本 / 删脚本都是 "S"）。
                // 把 action 拼进显示文案，脚本源码只在真正跑脚本时才展示。
                const action = asString(args.action).toUpperCase();
                const label = tool === 'S' && action ? `${tool}·${action}` : tool;

                appendMessage({
                    id: generateId(),
                    role: 'tool',
                    content: thought || `调用 ${label}`,
                    reasoning: keepReasoning(liveReasoning),
                    tool,
                    // 显示文案会被 thought 顶掉，而 label 是**稳定**的那一份：
                    // 重建上下文时若只按 tool 写回，模型在历史里看不出这一步
                    // 做的是 R 还是 S（四个动作都显示成 "S"）。
                    label,
                    script: tool === 'S' && action === 'R' ? asString(args.code) : undefined,
                    ok: !isErrorResult(result),
                    result,
                    at: Date.now(),
                });

                transcript.push({ role: 'user', content: `[工具 ${label} 的执行结果]\n${result}` });

                // 最后一轮：告知模型预算耗尽，让它用已有信息收尾而不是继续要工具。
                // 不能只是静默退出 —— 那样用户看到的是对话停在半路，没有任何解释。
                if (step === MAX_STEPS - 1) {
                    appendMessage({
                        id: generateId(),
                        role: 'assistant',
                        content: `已达到单轮 ${MAX_STEPS} 步上限，已停止。可以让我继续，或把任务拆小一点。`,
                        notice: true,
                        at: Date.now(),
                    });
                }
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
        setMessages([]);
        setError('');
        // 正在流式输出时清空对话：气泡也要收掉，否则残留在空列表上方
        setStreaming(null);
    }, []);

    /**
     * 删除单条消息体。
     *
     * 与「回退」分开是有意的：删一条只动一条，用于清掉某次失败的探测、
     * 一条泄露了密钥的工具返回值；回退则是整轮作废。
     *
     * 运行中一律拒绝（见下面的 canEdit）：此刻 messages 正在被主循环追加，
     * 用户删掉的那条可能在下一句 appendMessage 之后又被"接"回来，
     * 界面表现为"删了没反应"。先停止再改，规则简单且不会骗人。
     */
    const removeMessage = useCallback((id: string) => {
        if (busyRef.current) return;
        setMessages((prev) => (prev.some((m) => m.id === id) ? prev.filter((m) => m.id !== id) : prev));
    }, []);

    /**
     * 回退到某条消息**之前**（把这条连同它之后的全部丢掉），返回该轮的提问。
     *
     * 边界取**整轮**而不是那一条：一轮是"提问 → 工具 → 回答"的序列，
     * 只砍掉后半截会留下一个有提问、没结果的畸形轮次 —— 下一轮重建上下文时
     * 模型看到自己"被问了却没答"，会以为任务还没开始而重做一遍。
     * 往前找到本轮的第一条用户消息，从那里切。
     *
     * 返回提问原文，由调用方填回输入框：回退的主要用途就是改一改重发，
     * 让用户重新手打一遍自己刚写的话是没道理的。
     *
     * 读 messagesRef 而不是走 setMessages 的函数式更新：返回值必须是**同步**的，
     * 而函数式更新里的代码在 React 提交时才跑，那时早就 return 过了。
     */
    const rewindTo = useCallback((id: string): string => {
        if (busyRef.current) return '';
        const list = messagesRef.current;
        const at = list.findIndex((m) => m.id === id);
        if (at < 0) return '';

        let start = at;
        while (start > 0 && list[start].role !== 'user') start -= 1;

        // 一条用户消息都没有的列表（只跑过自动脚本）没有"轮"可分：
        // 此时 start 停在 0，整段清掉，prompt 为空。
        const prompt = list[start].role === 'user' ? list[start].content : '';

        setMessages(list.slice(0, start));
        // 上一轮留下的报错横幅属于被删掉的那一段，留着会指向不存在的东西
        setError('');
        return prompt;
    }, []);

    const runScript = useCallback((code: string) => execActive(code), [execActive]);

    const removeScript = useCallback((id: string) => {
        setScripts((prev) => prev.filter((s) => s.id !== id));
    }, []);

    const toggleScript = useCallback((id: string) => {
        setScripts((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
    }, []);

    /* ------------------------------ 自动执行 ------------------------------ */

    // 页面每次就绪 → 跑一遍命中的脚本。这一步直接复用 useBrowse 的广播，
    // 与篡改引擎共用同一条生命周期，不需要另挂 dom-ready 监听。
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
                    tool: 'S',
                    label: `S·自动·${script.name}`,
                    // 标记成自动：它不属于任何一次模型调用，重建上下文时要按
                    // 「环境事件」写回，不能伪造成一次模型发出的工具调用。
                    auto: true,
                    script: script.code,
                    ok: !isErrorResult(result),
                    result,
                    at: Date.now(),
                });
            })();
        });
    }), [deps.onPageReady, execOn, appendMessage]);

    const actions = useMemo(() => ({
        send, stop, clear, runScript, removeScript, toggleScript,
        removeMessage, rewindTo,
    }), [send, stop, clear, runScript, removeScript, toggleScript, removeMessage, rewindTo]);

    return useMemo(() => ({
        messages, scripts, status, error, streaming, actions,
        // 运行中禁止改历史（删除 / 回退 / 清空）：主循环正拿着 messages 追加，
        // 此刻改动会和它的下一次 appendMessage 抢同一个数组。界面据此禁用按钮，
        // 而不是让用户点了没反应 —— 那看起来像坏了。
        canEdit: status === 'idle',
    }), [
        messages, scripts, status, error, streaming, actions,
    ]);
};
