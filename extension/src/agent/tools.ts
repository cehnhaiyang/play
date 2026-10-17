import type {
    AgentToolName,
    CookieItem,
    HeaderRule,
    SandboxRequest,
    SandboxResult,
    TamperRule,
} from '../../../shared/meta';
import { SANDBOX_ACTIONS } from '../../../shared/meta';
import {
    buildCookieKeys,
    collectDroppedRules,
    decodeJwt,
    findCookieByKey,
    generateId,
    pickJwtCandidates,
    rewriteJwtPayload,
} from '../../../shared/core';
import type { AgentHost } from './host';
import { asString, errorText } from './text';
import { safeParseObject } from './parse';

/**
 * 六个工具的派发。
 *
 * ## 为什么是普通函数
 *
 * 它是**接收宿主接口的纯异步函数**，不碰 React、不碰 DOM、不碰 chrome.*：
 * 宿主可替换，因此每个工具都能在 Node 里直接调，不需要浏览器。
 *
 * ## 返回值一律是字符串
 *
 * 这些字符串会**原样回灌给模型**，所以错误文案是产品的一部分而不是日志：
 * 「未知 action：SET（可用 get / set；注意大小写：请用 get）」比「参数错误」
 * 能让模型少走一整步。改动这些措辞时要知道它们在影响模型行为。
 */

interface ToolContext {
    host: AgentHost;
    /** 在页面里执行代码（走引擎的串行队列，不与模型的其它步骤交错） */
    exec: (code: string) => Promise<string>;
    /**
     * 本机沙箱。桌面应用没连上时工具如实报"不可用"，不回落成"成功但什么都没做"。
     *
     * 必填而不是可选：可选会在缺实现时走进一条运行时分支，而"沙箱能用吗"
     * 是接线问题，编译时就该报错（与 `tamper` 同一教训，见 host.ts）。
     */
    sandbox: (request: SandboxRequest) => Promise<SandboxResult>;
}

/**
 * 未知 area 的错误文案。
 *
 * storage 与 tokens 共用同一组取值，措辞分叉时模型会以为两处收的是不同的东西。
 */
const unknownAreaError = (area: string): string =>
    `未知 area：${area}（可用 local / session / cookie）`;

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
 * cookie 定位失败时的错误文案。
 *
 * 三处写回（storage set / storage delete / tokens rewrite）共用同一句：措辞分叉时
 * 模型只会照着一处去改，另一处继续失败。key 必须是 storage get 或 tokens find
 * 返回的那个原样值 —— 它由 name + path + domain 拼成，同名 cookie 在不同域下
 * 并存时（访问子域就会遇到）只有它能唯一定位。
 */
const cookieKeyError = (key: string): string =>
    `找不到 cookie：${key}。key 要用 storage get 或 tokens find 返回的那个原样传入。`;

/**
 * set 缺 value 时的错误文案。
 *
 * 不能当成空值写下去：模型少打一个字段就**静默改掉了这条数据的值**，而回执是
 * `{saved:true}` —— 它照着自己写的值往下走，页面里读到的却是空。清空是合法操作，
 * 但要显式给空串；两者混在一起，就再也分不出"它想清空"与"它忘了写"。
 */
const missingValueError = (area: string): string =>
    `缺少 value（${area} set 必须给要写入的值；要写成空串请显式传 ""）。`;

/** 把任意值收敛成字符串。引擎内部对规则字段一律 String() 化 */
const toRuleString = (value: unknown): string => (value == null ? '' : String(value));

/**
 * 引擎内部的数字字面量判据。
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
 * 把模型给的字段规则收敛成 `TamperRule[]`。
 *
 * 返回 string 表示**出错**（错误消息），返回数组表示成功 —— 用联合类型而不是抛
 * 异常，是因为这里的错误要原样回传给模型让它自己改，不该中断整轮对话。
 *
 * 缺 id 的补一个：引擎不读它，面板拿它做 React key（`key={rule.id || index}`）。
 * 模型给的规则常常没有 id，靠 index 兜底会让列表在插入 / 删除时错位复用节点。
 */
const normalizeFieldRules = (raw: unknown, label: string): TamperRule[] | string => {
    if (!Array.isArray(raw)) return `${label} 必须是数组`;
    const rules: TamperRule[] = [];
    for (let i = 0; i < raw.length; i += 1) {
        const r = (raw[i] && typeof raw[i] === 'object' ? raw[i] : {}) as Record<string, unknown>;
        const op = asString(r.op) || 'set';
        if (op !== 'set' && op !== 'delete') return `${label}[${i}] 未知 op：${op}（可用 set / delete）`;
        if (op === 'set' && !('value' in r)) {
            return `${label}[${i}] 缺少 value（op 为 set 时必须给 value；删字段请用 op delete）`;
        }
        rules.push({
            id: typeof r.id === 'string' && r.id ? r.id : generateId(),
            enabled: r.enabled !== false,
            urlPattern: toRuleString(r.url_pattern),
            jsonPath: toRuleString(r.key),
            newValue: op === 'delete' ? 'undefined' : toEngineValue(r.value),
        });
    }
    return rules;
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

/**
 * 没有可用页面时的回执。
 *
 * 抽成常量是因为它现在出现在三个工具里（navigate / storage / tokens），
 * 措辞分叉时模型会以为遇到的是三种不同的故障。
 */
const NO_PAGE = '当前没有可用的页面';

export const dispatchTool = async (
    tool: AgentToolName,
    args: Record<string, unknown>,
    ctx: ToolContext,
): Promise<string> => {
    switch (tool) {
        /**
         * js —— 在当前页面主世界跑一段脚本。
         *
         * 无 action：整个工具就做这一件事。空 code 直接报错 ——
         * 空跑一步的代价不是零，这一步的结果（哪怕是 null）会被后续每一步重发。
         *
         * 自己的错误走 `__agentError`，与脚本抛错同一个通道：js 的返回值是**页面
         * 数据**，里面出现 `{error:"..."}` 是完全正常的业务字段（`{"error":"invalid
         * token"}` 这种接口响应很常见）。两条通道混用的话，判据只能去猜"这个 error
         * 是我们写的还是页面给的" —— 猜法（看键数）对单键业务错误必然猜错。
         */
        case 'js': {
            const code = asString(args.code);
            if (!code.trim()) {
                return JSON.stringify({ __agentError: '缺少 code（要运行的 JS，必须显式 return 一个可序列化值）' });
            }
            return ctx.exec(code);
        }

        case 'navigate': {
            const raw = asString(args.url).trim();
            if (!raw) return JSON.stringify({ error: '缺少 url' });
            /**
             * 模型从页面里读到的地址常常不是完整 URL（相对路径 `/api/user`、裸域名
             * `example.com`）。直接导航会失败或落到奇怪的地方，而失败信息指不出
             * "缺协议"这个真正原因。在这里归一：有协议原样，`/` 开头相对当前页解析，
             * 其余补 `https://`。回显归一后的最终地址 —— 模型下一步的 js 要基于它判断。
             */
            const current = await ctx.host.activeTab();
            if (!current) return JSON.stringify({ error: NO_PAGE });
            let url = raw;
            try {
                if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
                    url = raw;
                } else if (raw.startsWith('/')) {
                    url = new URL(raw, current.url).href;
                } else {
                    url = `https://${raw}`;
                }
            } catch {
                return JSON.stringify({ error: `地址解析失败：${raw}（相对路径需要当前页面地址可读）` });
            }

            try {
                const result = await ctx.host.navigate(current.id, url);
                return JSON.stringify({ url: result.url, loaded: result.loaded });
            } catch (e) {
                return JSON.stringify({ error: `导航失败：${errorText(e)}` });
            }
        }

        case 'tamper': {
            const engine = ctx.host.tamper;

            const action = asString(args.action) || 'get';
            // 现读而不是缓存：用户在面板里改完规则，下一句 `tamper get` 就该看到新的
            const current = await engine.rules();

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

            /*
             * 改内存 + 注入当前页面，**不落盘**：模型改的规则立刻生效，但不越过
             * 用户写进本地存储。
             *
             * 返回值是**注入**结果。false 表示规则进了内存，但这个页面没装上
             * 钩子（没有可用标签页 / 受限页面）—— 必须说出来。导航会重建主世界，
             * 注入失败时页面还在跑旧规则，而 applied:true 会让模型以为成功了，
             * 它会一直不知道为什么"改了没反应"。
             */
            const applied = await engine.applyRules(nextIntercept, nextRequest, nextHeaders);

            /**
             * 报出会被引擎跳过的规则。引擎对没有目标键的规则直接丢弃（它永远匹配
             * 不上），但那是**静默**的 —— 不回传的话模型收到 applied:true 就以为
             * 设置成功了，实际页面里什么都没发生，而它会一直不知道为什么"改了没反应"。
             */
            const dropped = collectDroppedRules({
                intercept: nextIntercept,
                request: nextRequest,
                headers: nextHeaders,
            });

            const parts = [
                applied
                    ? '已对当前页面生效。'
                    : '规则已记下，但这个页面没能装上钩子（没有可用标签页，或当前页面不允许注入），'
                        + '页面里暂时不会生效。',
            ];
            if (dropped.length > 0) {
                parts.push(`有 ${dropped.length} 条被引擎跳过（见 dropped），这些规则不会生效。`);
            }
            parts.push('未写入本地存储，用户点「应用更改」后才持久化。');

            return JSON.stringify({
                applied,
                counts: {
                    intercept: nextIntercept.length,
                    request: nextRequest.length,
                    headers: nextHeaders.length,
                },
                // 只在真有时才带这个字段：空数组会让模型误以为"有被跳过的"
                ...(dropped.length > 0 ? { dropped } : {}),
                note: parts.join(''),
            });
        }

        case 'storage': {
            const action = asString(args.action) || 'get';
            const area = asString(args.area) || 'local';
            if (area !== 'local' && area !== 'session' && area !== 'cookie') {
                return JSON.stringify({ error: unknownAreaError(area) });
            }
            // 先验动作、再验参数：与 tokens 同一理由，写错大小写必须报未知 action，
            // 不能报"缺少 key"把模型带偏。
            if (action !== 'get' && action !== 'set' && action !== 'delete') {
                return JSON.stringify({ error: unknownActionError(action, ['get', 'set', 'delete']) });
            }

            const tab = await ctx.host.activeTab();
            if (!tab) return JSON.stringify({ error: NO_PAGE });

            if (area === 'cookie') {
                if (action === 'get') {
                    const cookies = await ctx.host.getCookies(tab.id);
                    const keys = buildCookieKeys(cookies);
                    return JSON.stringify({
                        count: cookies.length,
                        // key 与 tokens find 用同一套唯一键：同名 cookie 在不同域下
                        // 并存时，模型必须能指定改哪一条（set / delete 都收 key）。
                        cookies: cookies.map((c: CookieItem, i: number) => ({
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
                    const list = await ctx.host.getCookies(tab.id);
                    const target = findCookieByKey(list, key);
                    // 没命中不能当成"删掉了"：按 name 删时传一个不存在的名字
                    // 浏览器也不报错，静默返回成功。
                    if (!target) return JSON.stringify({ error: cookieKeyError(key) });
                    const ok = await ctx.host.removeCookie(tab.id, target.name);
                    return ok
                        ? JSON.stringify({ deleted: true, name: target.name, note: '同名不同 path 的 Cookie 会被一起删掉。' })
                        : JSON.stringify({ error: '删除失败：当前没有可用的页面地址' });
                }

                // 到这里只剩 set（未知 action 已在入口拦掉）
                if (args.value === undefined) { return JSON.stringify({ error: missingValueError('cookie') }); }
                // 已存在则取回原属性再改值 —— setCookie 是整条覆盖，漏掉 httpOnly /
                // expirationDate 会让会话 cookie 降级甚至掉登录态。key 找不到时
                // 直接报错：编一个 key 等于在猜改哪一条，比报错更难查。
                const list = await ctx.host.getCookies(tab.id);
                const existing = findCookieByKey(list, key);
                if (!existing) return JSON.stringify({ error: cookieKeyError(key) });
                // 值统一成字符串：cookie 只能是字符串，而 asString 会把数字/布尔
                // 变成空串 —— 那等于静默清空这条 cookie，比报错更难查。
                // 对象用 JSON 而不是 String()：后者得到 "[object Object]"，
                // 写进去等于亲手毁掉这条 cookie 的值，且回显看不出原值是什么。
                const cookieValue = typeof args.value === 'string'
                    ? args.value
                    : (args.value != null && typeof args.value === 'object'
                        ? JSON.stringify(args.value)
                        : String(args.value ?? ''));
                const ok = await ctx.host.setCookie(tab.id, { ...existing, value: cookieValue });
                return ok
                    ? JSON.stringify({
                        // 回显写进去的那个值，不是原始入参 —— 两者会被上面的转换拉开
                        saved: true, name: existing.name, value: cookieValue,
                        preserved: '已保留原有 httpOnly / sameSite / 过期时间',
                    })
                    : JSON.stringify({ error: '写入失败：当前没有可用的页面地址' });
            }

            if (action === 'get') {
                const raw = await ctx.host.readWebStorage(tab.id, area);
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
                const ok = await ctx.host.removeWebStorage(tab.id, area, key);
                return ok
                    ? JSON.stringify({ deleted: true, area, key })
                    : JSON.stringify({ error: '删除失败：页面可能已禁用存储，或没有可用的页面' });
            }

            // 到这里只剩 set（未知 action 已在入口拦掉）
            if (args.value === undefined) { return JSON.stringify({ error: missingValueError(area) }); }
            // 值统一转成字符串：Storage 规范规定存进去的只能是字符串，
            // 传数字/对象进来会被浏览器隐式转成 "[object Object]"，不如自己转干净。
            const value = typeof args.value === 'string' ? args.value : JSON.stringify(args.value ?? '');
            const ok = await ctx.host.writeWebStorage(tab.id, area, key, value);
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

            const tab = await ctx.host.activeTab();
            if (!tab) return JSON.stringify({ error: NO_PAGE });

            if (action === 'find') {
                const cookies = await ctx.host.getCookies(tab.id);
                const local = safeParseObject(await ctx.host.readWebStorage(tab.id, 'local'));
                const session = safeParseObject(await ctx.host.readWebStorage(tab.id, 'session'));

                /**
                 * 来源要标出来：模型下一步 rewrite 时必须知道写回哪里。key 必须是
                 * **能写回去的键**：storage 用存储键名，cookie 用面板同款的唯一键
                 * （name + path + domain）—— 直接用 cookie 名不行：访问子域时同名
                 * cookie 会并存，两条的 from 完全相同、rewrite 又只命中先出现的那条，
                 * 于是第二条永远改不到，模型还看不出有两条。
                 *
                 * 去重按**位置**而不是按 token 值：同一个 token 常常同时躺在
                 * local / session / cookie 里（登录态就是这种形态）。按值去重会让模型
                 * 只看到其中一处，改写完另一处仍是旧值 —— 而页面读的可能正是那一处。
                 */
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
                add(cookies.map((c: CookieItem, i: number) => [cookieKeys[i], c.value] as [string, unknown]), 'cookie');

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
                    return JSON.stringify({ error: `解码失败：${errorText(e)}` });
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
                return JSON.stringify({ error: `改写失败：${errorText(e)}` });
            }

            if (area === 'cookie') {
                // key 是 find 给出的唯一键（name + path + domain），必须用它取回，
                // 不能只按 name —— 同名 cookie 并存时会永远命中第一条。
                const list = await ctx.host.getCookies(tab.id);
                const existing = findCookieByKey(list, key);
                if (!existing) return JSON.stringify({ error: cookieKeyError(key) });
                const ok = await ctx.host.setCookie(tab.id, { ...existing, value: next });
                if (!ok) return JSON.stringify({ error: '写回失败：当前没有可用的页面地址' });
            } else if (area === 'local' || area === 'session') {
                const ok = await ctx.host.writeWebStorage(tab.id, area, key, next);
                if (!ok) return JSON.stringify({ error: '写回失败：页面可能已禁用存储或配额已满' });
            } else {
                return JSON.stringify({ error: unknownAreaError(area) });
            }

            return JSON.stringify({
                rewritten: true,
                area,
                key,
                token: next,
                warning: '签名已失效 —— 签名覆盖的正是 payload，服务端验签就会拒绝。这是这类调试的固有前提。',
            });
        }

        /**
         * sandbox —— 本机项目根 `sandbox/` 目录里的文件操作与脚本执行。
         *
         * ## 为什么只有这里能碰磁盘
         *
         * 前五个工具的作用域都在浏览器里（页面、存储、规则、令牌）。本机文件系统
         * 与子进程两者都不属于扩展的能力范围，必须过桥交给应用（归属见
         * `shared/meta/bridge.ts` 的 `sandbox`）。工具层因此**不自己拼路径**：
         * 沙箱根的边界由执行者守，发起方声明"我没越界"不作数。
         *
         * ## 动作校验在这里做，而不是交给应用
         *
         * 与 storage / tokens 同一取舍：动作写错时模型要看到的是"可用 list / read /
         * write / delete / edit / lines / checkjs / node"，而过桥一趟拿回来的只会是
         * 一句应用侧的未知动作。参数形状在这里收敛，路径合法性与替换判据交给应用。
         */
        case 'sandbox': {
            const rawAction = asString(args.action) || 'list';
            /**
             * 用 `SANDBOX_ACTIONS.find()` 而不是 `includes()` 做门禁。
             *
             * 两者行为一样，但只有前者能把值**收窄成联合类型**：includes 版在下面
             * 组装请求时 `action` 仍是 string，编译器抓不到"往 action 里塞了个
             * 白名单外的值"这类错（实测就是在那里报红的）。清单也只剩 shared 一份。
             */
            const action = SANDBOX_ACTIONS.find((a) => a === rawAction);
            if (!action) {
                return JSON.stringify({ error: unknownActionError(rawAction, [...SANDBOX_ACTIONS]) });
            }

            const relPath = asString(args.path);
            const content = typeof args.content === 'string' ? args.content : undefined;
            /**
             * checkjs 没有 path：它查的是传进来的源码，不碰文件。其余动作一律要 path
             * —— 报错要**指名缺哪个**，模型才知道补什么。
             */
            if (action !== 'checkjs' && !relPath) {
                return JSON.stringify({ error: '缺少 path（相对 sandbox 的路径，如 out/notes.md）' });
            }
            if (action === 'checkjs' && content === undefined) {
                return JSON.stringify({ error: '缺少 content（checkjs 要检查的 JS 源码）' });
            }
            /**
             * write / lines 缺 content 必须报错，而不是当成空串写下去。
             *
             * 当成空串的话，模型少打一个字段就**清空了一个它本来想保留的文件**，
             * 而回执是 {bytes:0} —— 看起来像是"写了个空文件"，不像出了事。
             * edit 的 `new` 空串是**合法**的（就是删掉这一段），所以只查存在性。
             */
            if ((action === 'write' || action === 'lines') && content === undefined) {
                return JSON.stringify({
                    error: `缺少 content（${action} 必须给要写入的文本；不给会当成空内容把文件清空）`,
                });
            }
            if (action === 'edit' && typeof args.old !== 'string') {
                return JSON.stringify({
                    error: '缺少 old（要被替换掉的原文，必须与文件里逐字一致）。要整份覆盖请用 write。',
                });
            }
            if (action === 'lines' && args.start === undefined) {
                return JSON.stringify({ error: '缺少 start（起始行号，1 起）' });
            }

            const request: SandboxRequest = {
                action,
                ...(relPath ? { path: relPath } : {}),
                ...(content !== undefined ? { content } : {}),
                ...(typeof args.old === 'string' ? { old: args.old } : {}),
                // edit 的 new 可以是空串（删掉这一段），所以判据是"给了没有"而不是真假
                ...(typeof args.new === 'string' ? { new: args.new } : {}),
                ...(typeof args.start === 'number' ? { start: args.start } : {}),
                ...(typeof args.end === 'number' ? { end: args.end } : {}),
                ...(typeof args.timeout === 'number' ? { timeout: args.timeout } : {}),
            };

            let result: SandboxResult;
            try {
                result = await ctx.sandbox(request);
            } catch (e) {
                // 桥断了 / 应用没开：这是环境故障，与参数写错是两件事，
                // 回一句"未知错误"模型会反复改参数，而改参数永远好不了
                return JSON.stringify({
                    error: `本机沙箱不可用：${errorText(e)}。要确认桌面应用正在运行且插件已连上。`,
                });
            }

            if (result?.error) return JSON.stringify(result);
            return JSON.stringify(result ?? {});
        }

        default:
            return JSON.stringify({ error: `未知工具：${String(tool)}` });
    }
};
