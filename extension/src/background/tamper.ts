import type { HeaderRule, TamperRule } from '../../../shared/meta';

/**
 * 篡改规则引擎（插件侧）。
 *
 * ## 为什么规则引擎必须重建，而不是"先存着"
 *
 * 应用里那份（`新建文件夹/useBrowse.ts` 的 `INJECT_SCRIPT`）假定宿主是一个
 * Electron `<webview>` 元素 —— 那个前提随自建外壳一起消失了。而规则**只有
 * 真的注入到页面里才有意义**：存下来却没人执行，是本项目里最难查的一类故障
 * （面板显示"启用中"，页面里什么都没发生，且不报任何错）。
 *
 * 所以这里给的是完整实现：注入脚本 + 规则状态 + 落盘 + 页面就绪时自动重装。
 * Agent 的 `tamper` 工具也从这里拿 `applyRules`，不再是"未接入"。
 *
 * ## 注入用 `func` 而不是字符串
 *
 * 旧实现把脚本写成模板字符串再用 `%CONFIG%` 替换。那样有两个坑：
 *   · 字符串替换会把 config 里的 `$&` / `` $` `` / `$1` 当反向引用解释，
 *     一条 newValue 为 `"$&"` 的规则足以让整段脚本被替换成 config 文本本身；
 *   · 脚本里的正则反斜杠会被模板字符串吃掉（实测过）。
 * `chrome.scripting.executeScript({ func, args })` 由 Chrome 自己序列化函数、
 * 自己传参，两个坑都不存在。所以这里写成**真正的函数**。
 *
 * ## 五条硬约束（改注入脚本时必须守住）
 *
 *  1. **幂等**。脚本会被反复注入（每次导航、每次改规则各一次）。
 *     `__interceptorInstalled` 只在**全部钩子装完之后**才置位 —— 提前置位会让
 *     一次中途失败变成永久失效（再注入也走"已装"分支直接返回）。
 *  2. **不抛给页面**。每一节各自 try/catch。localStorage 在第三方 iframe 里读
 *     会抛 SecurityError，让它冒出去的话后面所有钩子都装不上，页面自己的
 *     JSON.parse 也会跟着炸。
 *  3. **响应规则与请求规则不能混**。两者曾经被合并成一份规则表，结果请求规则
 *     会改写接口响应（把真 token 改成假 token），响应规则会改写请求体。
 *  4. **不重复解析请求体**。请求体必须用**原始** JSON.parse 解析，用被钩过的
 *     那个会把响应规则套上去，且"改动前"取到的已经是改动后的值。
 *  5. **两个存储区对称**。规则里没有字段能区分 localStorage 与 sessionStorage，
 *     面板又把它们并列呈现，只钩一个会让另一半的规则静默不生效。
 *
 * ## 能力边界（架构限制，不是缺陷）
 *
 * 钩子装在**当前页面主世界**，下面这些路径的解析发生在别处，规则一律不生效：
 * Web Worker / SharedWorker / Service Worker 内解析的响应（各有独立全局）、
 * 跨域 iframe 内的请求（注入不到那个文档）、页面在装钩**之前**就存下了
 * `JSON.parse` 引用、WASM 或原生层直接解析的 JSON。
 * 存储规则只覆盖 `storage.getItem(k)`，不覆盖 `storage[k]` 这种具名属性读法。
 */

/** 规则落盘键。与 Agent 的 `agent-*` 同一命名空间，但语义上属于面板 */
export const TAMPER_STORE_KEY = 'tamper-rules';

/** 面板与 Agent 工具共用的规则集合。三类规则**必须一起传**，见约束 3 */
export interface TamperRules {
    interceptRules: TamperRule[];
    requestRules: TamperRule[];
    headerRules: HeaderRule[];
}

export const emptyRules = (): TamperRules => ({
    interceptRules: [],
    requestRules: [],
    headerRules: [],
});

/* ========================================================================== */
/* 注入脚本                                                                    */
/* ========================================================================== */

/**
 * 注入到页面**主世界**的钩子。
 *
 * `executeScript({ func })` 会把这个函数 `toString()` 之后在目标页面里重新求值，
 * 所以它**不能引用任何外部绑定** —— 下面所有工具函数都定义在函数体内。
 * 这一点由 `test/extsniffer.test.js` 的沙箱断言盯着。
 */
const installInterceptor = (config: TamperRules): void => {
    /* ---- 0. 基础工具 ---- */

    /** 伪装钩子。`toString` 也换掉，否则页面一查就露 */
    const maskFn = <A extends unknown[], R>(
        fn: (...args: A) => R,
        original: { name: string; length: number; toString: () => string },
    ): ((...args: A) => R) => {
        try {
            Object.defineProperty(fn, 'name', { value: original.name });
            Object.defineProperty(fn, 'length', { value: original.length });
            Object.defineProperty(fn, 'toString', { value: () => original.toString(), writable: true });
        } catch { /* 某些环境不允许改，不影响功能 */ }
        return fn;
    };

    /** 原始 JSON.parse。请求体必须用它解析，见约束 4 */
    const parseOriginal = JSON.parse;

    /**
     * 值类型还原。
     *
     * 面板只有一个文本框，没有类型选择器，所以只能靠写法猜。猜的规则要**窄**：
     * 只认严格的 JSON 标量字面量，别的一律当字符串。
     *
     * 曾经用 `!isNaN(Number(t))` 判断，等于把「任何能被 Number() 吃掉的东西」
     * 都变数字：`"007"` → 7（订单号/手机号被毁）、`"1.10"` → 1.1（版本号语义丢失）、
     * `"0x10"` → 16、`" 42"` → 42、`"Infinity"` → Infinity（序列化成 null）。
     * 这些写法明显是想表达**字符串**，静默改类型会让页面里的 `=== "007"` 失败，
     * 而用户完全看不出为什么。
     */
    const parseValue = (val: unknown): unknown => {
        if (typeof val !== 'string') return val;

        // 显式转义：= 后面原样当字符串
        if (val.charAt(0) === '=') return val.slice(1);

        if (val === 'true') return true;
        if (val === 'false') return false;
        if (val === 'null') return null;
        if (val === 'undefined') return undefined;

        // 严格数字：可选负号 + 不许前导零的整数，或小数，或科学计数法。
        // 手写字符判断而不用正则 —— 这段代码会被序列化后在页面里求值，
        // 正则字面量在序列化往返里最容易出问题，且它本来就比手写慢。
        const isStrictNumber = (s: string): boolean => {
            if (s === '') return false;
            let i = 0;
            if (s.charAt(0) === '-') i++;
            if (i >= s.length) return false;

            const intStart = i;
            if (s.charAt(i) === '0') {
                i++;
            } else if (s.charAt(i) >= '1' && s.charAt(i) <= '9') {
                i++;
                while (i < s.length && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
            } else {
                return false;
            }
            // 前导零后面还有数字 => "007" 这类，判为字符串
            if (i - intStart > 1 && s.charAt(intStart) === '0' && s.charAt(i) >= '0' && s.charAt(i) <= '9') return false;

            if (i < s.length && s.charAt(i) === '.') {
                i++;
                const fracStart = i;
                while (i < s.length && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
                if (i === fracStart) return false;   // "1." 不算数字
            }

            if (i < s.length && (s.charAt(i) === 'e' || s.charAt(i) === 'E')) {
                i++;
                if (i < s.length && (s.charAt(i) === '+' || s.charAt(i) === '-')) i++;
                const expStart = i;
                while (i < s.length && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
                if (i === expStart) return false;    // "1e" 不算数字
            }

            return i === s.length;
        };

        return isStrictNumber(val) ? Number(val) : val;
    };

    /** glob 匹配：`*` 任意串、`?` 任意单字符 */
    const globMatch = (glob: string, text: string): boolean => {
        let g = 0;
        let t = 0;
        let star = -1;
        let mark = 0;
        while (t < text.length) {
            if (g < glob.length && (glob.charAt(g) === '?' || glob.charAt(g) === text.charAt(t))) { g++; t++; }
            else if (g < glob.length && glob.charAt(g) === '*') { star = g++; mark = t; }
            else if (star >= 0) { g = star + 1; t = ++mark; }
            else return false;
        }
        while (g < glob.length && glob.charAt(g) === '*') g++;
        return g === glob.length;
    };

    /**
     * 编译 URL 匹配器。`null` 表示「全部匹配」—— 空串、`*`、`.*` 都算。
     *
     * UI 里 URL 匹配的占位符写的就是 `*`，不认它等于所有规则默认失效。
     */
    const compileMatcher = (pattern: unknown): ((urls: string[]) => boolean) | null => {
        const p = pattern == null ? '' : String(pattern);
        if (p === '' || p === '*' || p === '.*') return null;
        if (p.indexOf('*') !== -1 || p.indexOf('?') !== -1) {
            return (urls) => {
                for (let i = 0; i < urls.length; i++) { if (urls[i] && globMatch(p, urls[i])) return true; }
                return false;
            };
        }
        return (urls) => {
            for (let i = 0; i < urls.length; i++) { if (urls[i] && urls[i].indexOf(p) !== -1) return true; }
            return false;
        };
    };

    interface FieldRule { key: string; rawPath: string; rawValue: string; value: unknown; match: ((urls: string[]) => boolean) | null }
    interface HeadRule { name: string; lower: string; value: string; match: ((urls: string[]) => boolean) | null }

    /** 规则预编译：过滤 enabled、拆好目标键、编好 URL 匹配器 */
    const compile = (cfg: TamperRules): { rules: FieldRule[]; requestRules: FieldRule[]; headerRules: HeadRule[] } => {
        const buildFields = (list: TamperRule[] | undefined): FieldRule[] => {
            const out: FieldRule[] = [];
            if (!list || !list.length) return out;
            for (let i = 0; i < list.length; i++) {
                const r = list[i];
                if (!r || !r.enabled) continue;
                const path = r.jsonPath == null ? '' : String(r.jsonPath);
                const key = path.split('.').pop();
                // 没有目标键的规则永远匹配不上。丢弃是对的，但**必须报出来** ——
                // 面板「新增规则」默认就是空 jsonPath，用户填一半就点应用时，
                // 界面显示「启用中」而引擎里根本不存在这条规则。
                if (!key) { console.warn('[Tamper] 规则因「目标键为空」被跳过：', r); continue; }
                out.push({
                    key,
                    rawPath: path,
                    rawValue: r.newValue == null ? '' : String(r.newValue),
                    value: parseValue(r.newValue),
                    match: compileMatcher(r.urlPattern),
                });
            }
            return out;
        };
        const buildHeaders = (list: HeaderRule[] | undefined): HeadRule[] => {
            const out: HeadRule[] = [];
            if (!list || !list.length) return out;
            for (let i = 0; i < list.length; i++) {
                const r = list[i];
                if (!r || !r.enabled) continue;
                if (!r.headerName) { console.warn('[Tamper] 请求头规则因「Header 名为空」被跳过：', r); continue; }
                out.push({
                    name: String(r.headerName),
                    lower: String(r.headerName).toLowerCase(),
                    value: r.headerValue == null ? '' : String(r.headerValue),
                    match: compileMatcher(r.urlPattern),
                });
            }
            return out;
        };
        return {
            rules: buildFields(cfg && cfg.interceptRules),
            requestRules: buildFields(cfg && cfg.requestRules),
            headerRules: buildHeaders(cfg && cfg.headerRules),
        };
    };

    /**
     * 深度遍历并改写。
     *
     * `rules` 必须由调用方明确传入：响应路径传 `rules`，请求路径传 `requestRules`。
     * `urls` 是该数据可能的来源地址（接口地址 + 页面地址）—— 规则既能按页面地址
     * 匹配也能按接口地址匹配，两者取或。只按页面地址匹配时，针对具体接口写的
     * 规则永远不生效。
     *
     * `seen` 集合是**载荷性**的，不能删：JSON.parse 的 reviver 可以造出循环引用
     * （在 reviver 里写 `v.self = v`），去掉之后 walk 会无限递归抛 RangeError，
     * 而那个异常会被下面每一处的 try/catch **吞掉** —— 症状不是页面崩溃，
     * 而是"篡改对这份数据静默失效"，极难排查。
     */
    const traverseAndModify = (obj: unknown, rules: FieldRule[], urls: string[]): unknown => {
        if (!obj || typeof obj !== 'object' || !rules || !rules.length) return obj;

        const seen = new Set<unknown>();
        const walk = (target: unknown): void => {
            if (!target || typeof target !== 'object') return;
            if (seen.has(target)) return;
            seen.add(target);

            const record = target as Record<string, unknown>;
            for (const key in record) {
                if (!Object.prototype.hasOwnProperty.call(record, key)) continue;

                for (let i = 0; i < rules.length; i++) {
                    const rule = rules[i];
                    if (rule.key !== key) continue;
                    if (rule.match && !rule.match(urls)) continue;

                    const cur = record[key];
                    if (cur === rule.value) continue;
                    if (cur === null || typeof cur !== 'object') {
                        console.log('%c[Tamper] ✏️ ' + key + ' -> ' + rule.value, 'color: cyan; background: #000;');
                    }
                    record[key] = rule.value;
                }

                const next = record[key];
                if (next && typeof next === 'object') walk(next);
            }
        };

        walk(obj);
        return obj;
    };

    const pageUrl = (): string => {
        try { return String(window.location.href); } catch { return ''; }
    };

    /* ---- 1. 配置更新 ---- */
    /* 已装过就只换配置：重复打补丁会让钩子链越套越深，同一个响应被篡改 N 次。
       只存预编译结果：原始 config 没有任何读取方，留着是死状态。 */
    const host = window as unknown as { __interceptorInstalled?: boolean; __interceptorCompiled?: ReturnType<typeof compile> };
    if (host.__interceptorInstalled) {
        host.__interceptorCompiled = compile(config);
        console.log('%c[Tamper] 🔄 Rules Updated', 'color: #0f0; background: #333; padding: 2px 4px;');
        return;
    }

    host.__interceptorCompiled = compile(config);

    /* ---- 2. JSON.parse（响应文本解析路径）---- */
    try {
        const originalParse = JSON.parse;
        JSON.parse = maskFn(function (this: unknown, ...args: Parameters<typeof JSON.parse>) {
            const data = originalParse.apply(this, args);
            try {
                const c = host.__interceptorCompiled;
                if (data && typeof data === 'object' && c && c.rules.length) {
                    traverseAndModify(data, c.rules, [pageUrl()]);
                }
            } catch { /* 页面数据不能被我们的异常打断 */ }
            return data;
        } as typeof JSON.parse, originalParse);
    } catch { /* 页面冻结了 JSON.parse */ }

    /* ---- 3. Response.prototype.json（fetch 响应路径）---- */
    try {
        const originalResponseJson = Response.prototype.json;
        if (originalResponseJson) {
            Response.prototype.json = maskFn(function (this: Response) {
                const self = this;
                return Promise.resolve(originalResponseJson.call(self)).then((data: unknown) => {
                    try {
                        const c = host.__interceptorCompiled;
                        let u = '';
                        try { u = String(self.url || ''); } catch { /* 跨域响应读不到 url */ }
                        if (data && typeof data === 'object' && c && c.rules.length) {
                            traverseAndModify(data, c.rules, [u, pageUrl()]);
                        }
                    } catch { /* 同上 */ }
                    return data;
                });
            }, originalResponseJson);
        }
    } catch { /* 页面冻结了 Response */ }

    /* ---- 4. XMLHttpRequest（请求体 / 请求头 / 响应）---- */
    try {
        const originalXHR = window.XMLHttpRequest;
        if (typeof originalXHR === 'function') {
            const WrappedXHR = maskFn(function (this: unknown) {
                const xhr = new originalXHR();
                const originalOpen = xhr.open;
                const originalSetRequestHeader = xhr.setRequestHeader;
                const originalSend = xhr.send;
                const scratch = xhr as unknown as { __tamperUrl?: string };

                /*
                 * 参数原样转发。
                 *
                 * `open` 有两个重载（3 参与 5 参），所以这里收 `unknown[]` 再整体
                 * 转出去 —— 手写参数表会丢掉一个重载，而漏掉的后果很严重：
                 * 把 `async` 补成 `undefined` 会被 WebIDL 当成 `false`，
                 * 一次普通请求就变成**同步 XHR**，页面直接卡死。
                 * 唯一要读的是第 2 个参数（URL），规则按它匹配。
                 */
                xhr.open = maskFn(function (this: XMLHttpRequest, ...args: unknown[]) {
                    try { scratch.__tamperUrl = String(args[1]); } catch { /* 参数形状不对就算了 */ }
                    return (originalOpen as (...a: unknown[]) => void).apply(this, args);
                }, originalOpen) as typeof xhr.open;

                xhr.setRequestHeader = maskFn(function (this: XMLHttpRequest, header: string, value: string) {
                    let finalValue = value;
                    let blocked = false;
                    try {
                        const c = host.__interceptorCompiled;
                        const rules = (c && c.headerRules) || [];
                        const name = String(header).toLowerCase();
                        const urls = [scratch.__tamperUrl || '', pageUrl()];
                        for (let i = 0; i < rules.length; i++) {
                            const rule = rules[i];
                            if (rule.lower !== name) continue;
                            if (rule.match && !rule.match(urls)) continue;
                            if (rule.value === '') {
                                blocked = true;
                                console.log('%c[Tamper] 🚫 Header 已删除: ' + header, 'color: #f66');
                            } else {
                                finalValue = rule.value;
                                console.log('%c[Tamper] ✏️ Header 已改写: ' + header, 'color: #ff0');
                            }
                        }
                    } catch { /* 规则出错不能影响这次请求 */ }
                    // 留空 = 删除：不调 setRequestHeader 就是"没设过这个头"
                    if (blocked) return;
                    originalSetRequestHeader.call(this, header, finalValue);
                }, originalSetRequestHeader);

                xhr.send = maskFn(function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
                    let finalBody = body;
                    try {
                        const c = host.__interceptorCompiled;
                        if (c && c.requestRules.length && typeof body === 'string'
                            && (body.charAt(0) === '{' || body.charAt(0) === '[')) {
                            // 必须用 parseOriginal：见约束 4
                            const data = parseOriginal(body);
                            const before = JSON.stringify(data);
                            traverseAndModify(data, c.requestRules, [scratch.__tamperUrl || '', pageUrl()]);
                            const after = JSON.stringify(data);
                            if (after !== before) {
                                console.log('%c[Tamper] 💉 请求体已注入 (XHR)', 'color: #f0f');
                                finalBody = after;
                            }
                        }
                    } catch { /* 请求体不是 JSON，原样发出去 */ }
                    originalSend.call(this, finalBody as XMLHttpRequestBodyInit);
                }, originalSend);

                return xhr;
            }, originalXHR);

            /*
             * `instanceof` 必须仍然成立：包装函数返回的是真正的 XHR 实例，
             * 把原型指回去即可（构造函数返回对象时，`new` 拿到的就是那个对象）。
             */
            try { (WrappedXHR as unknown as { prototype: unknown }).prototype = originalXHR.prototype; } catch { /* 冻住了 */ }
            try { Object.setPrototypeOf(WrappedXHR, originalXHR); } catch {
                try { Object.assign(WrappedXHR, originalXHR); } catch { /* 只能放弃这层伪装 */ }
            }

            window.XMLHttpRequest = WrappedXHR as unknown as typeof XMLHttpRequest;
            /*
             * `responseType = 'json'` 时浏览器自己解析响应，绕过 JSON.parse 与
             * `Response.json`。这是现代前端最常见的取数方式，不在这里补一刀则
             * 响应篡改对它完全无效。
             */
            try {
                const respDesc = Object.getOwnPropertyDescriptor(originalXHR.prototype, 'response');
                const originalResponseGetter = respDesc?.get;
                if (respDesc && typeof originalResponseGetter === 'function') {
                    Object.defineProperty(originalXHR.prototype, 'response', {
                        configurable: true,
                        enumerable: respDesc.enumerable,
                        get(this: XMLHttpRequest) {
                            const v = originalResponseGetter.call(this) as unknown;
                            try {
                                const c = host.__interceptorCompiled;
                                if (v && typeof v === 'object' && c && c.rules.length) {
                                    let u = '';
                                    try { u = String(this.responseURL || ''); } catch { /* 同 Response.url */ }
                                    traverseAndModify(v, c.rules, [u, pageUrl()]);
                                }
                            } catch { /* 同上 */ }
                            return v;
                        },
                    });
                }
            } catch { /* 原型不可改 */ }
        }
    } catch { /* 页面冻结了 XMLHttpRequest */ }

    /* ---- 5. fetch（请求体 / 请求头）---- */
    try {
        const originalFetch = window.fetch;
        if (typeof originalFetch === 'function') {
            window.fetch = maskFn(function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
                let url = '';
                let isRequest = false;
                try {
                    isRequest = typeof Request === 'function' && input instanceof Request;
                    url = isRequest ? String((input as Request).url) : String(input);
                } catch { url = ''; }

                const c = host.__interceptorCompiled;
                let nextInput = input;
                let nextInit = init;

                /*
                 * 请求头：`init.headers` 优先，其次 Request 实例自带的头；
                 * 两者都没有时也要能注入 —— 只在 `init.headers` 存在时才处理的话，
                 * `fetch(url)` / `fetch(Request)` 这两种最常见写法下头规则形同虚设。
                 */
                try {
                    const hRules = (c && c.headerRules) || [];
                    if (hRules.length) {
                        let headers: Headers | null = null;
                        try {
                            if (nextInit && nextInit.headers) headers = new Headers(nextInit.headers);
                            else if (isRequest) headers = new Headers((nextInput as Request).headers);
                            else headers = new Headers();
                        } catch {
                            try { headers = new Headers(); } catch { headers = null; }
                        }

                        if (headers) {
                            let changed = false;
                            const pendingLogs: string[] = [];
                            const urls = [url, pageUrl()];
                            for (let i = 0; i < hRules.length; i++) {
                                const rule = hRules[i];
                                if (rule.match && !rule.match(urls)) continue;
                                if (rule.value === '') {
                                    if (headers.has(rule.name)) {
                                        headers.delete(rule.name);
                                        changed = true;
                                        pendingLogs.push('🚫 Header 已删除: ' + rule.name);
                                    }
                                } else {
                                    headers.set(rule.name, rule.value);
                                    changed = true;
                                    pendingLogs.push('✏️ Header 已改写: ' + rule.name);
                                }
                            }
                            if (changed) {
                                let applied = true;
                                if (!nextInit && isRequest) {
                                    // Request.headers 不可变，只能重建
                                    try { nextInput = new Request(nextInput as Request, { headers }); }
                                    catch { applied = false; }
                                } else {
                                    nextInit = Object.assign({}, nextInit, { headers });
                                }

                                /*
                                 * 失败时**不能**再打"已改写" —— 只靠颜色区分不够，
                                 * 控制台里复制出来就是一串成功记录。
                                 */
                                if (applied) {
                                    for (const line of pendingLogs) console.log('%c[Tamper] ' + line, 'color: #ff0');
                                } else {
                                    console.warn('[Tamper] ⚠️ 请求头未能改写（Request 无法重建，body 可能已被消费）：'
                                        + pendingLogs.length + ' 条规则未生效');
                                }
                            }
                        }
                    }
                } catch { /* 头处理失败就按原样发 */ }

                /* 请求体 */
                try {
                    const rRules = (c && c.requestRules) || [];
                    if (rRules.length && nextInit && typeof nextInit.body === 'string'
                        && (nextInit.body.charAt(0) === '{' || nextInit.body.charAt(0) === '[')) {
                        const data = parseOriginal(nextInit.body);
                        const before = JSON.stringify(data);
                        traverseAndModify(data, rRules, [url, pageUrl()]);
                        const after = JSON.stringify(data);
                        if (after !== before) {
                            console.log('%c[Tamper] 💉 请求体已注入 (fetch)', 'color: #f0f');
                            nextInit = Object.assign({}, nextInit, { body: after });
                        }
                    }
                } catch { /* 同上 */ }

                return originalFetch.call(this, nextInput, nextInit);
            } as typeof window.fetch, originalFetch);
        }
    } catch { /* 页面冻结了 fetch */ }

    /* ---- 6. 存储读取篡改 ---- */
    /*
     * 两个存储区都要装：面板把它们并列呈现，规则又没有字段能区分是哪一个，
     * 只钩 localStorage 会让"给 sessionStorage 里的键写的规则"静默不生效。
     * 每个区各自 try/catch —— 沙箱 iframe 里读其中一个就抛 SecurityError，
     * 合并成一个 try 会让另一个区一起装不上（约束 2）。
     */
    const hookStorage = (areaName: 'localStorage' | 'sessionStorage'): void => {
        try {
            const storage = window[areaName];
            const originalGetItem = storage && storage.getItem;
            if (typeof originalGetItem !== 'function') return;
            storage.getItem = maskFn(function (this: Storage, key: string) {
                try {
                    const c = host.__interceptorCompiled;
                    const rules: FieldRule[] = (c && c.rules) || [];
                    const k = String(key);
                    const urls = [pageUrl()];
                    for (let i = 0; i < rules.length; i++) {
                        const rule = rules[i];
                        // 存储按「键」精确匹配：整条 jsonPath 或它的末段都算
                        if (rule.key !== k && rule.rawPath !== k) continue;
                        if (rule.match && !rule.match(urls)) continue;
                        console.log('%c[Tamper] 📖 存储读取已改写: ' + areaName + '.' + k, 'color: #f80');
                        return rule.rawValue;
                    }
                } catch { /* 规则出错就返回真实值 */ }
                return originalGetItem.call(this, key);
            }, originalGetItem);
        } catch { /* 该存储区不可访问 */ }
    };
    hookStorage('localStorage');
    hookStorage('sessionStorage');

    // 全部装完才置位：中途失败时保持未装状态，下次注入可以补齐（约束 1）
    host.__interceptorInstalled = true;
    console.log('%c[Tamper] 🛡️ Interceptor Activated', 'color: #fff; background: #e00; font-weight: bold;');
};

/* ========================================================================== */
/* 状态与注入                                                                  */
/* ========================================================================== */

/**
 * 规则的内存镜像。
 *
 * **唯一权威是 `chrome.storage.local`**，这里是它的同步读口：注入发生在页面
 * 就绪事件里，那时再去 await 一次 storage 会让注入晚于页面自己的脚本 ——
 * 而"页面在装钩前就把 JSON.parse 存了引用"正是规则失效的一条已知路径。
 *
 * ## 加载必须只有一个入口，且读它的人必须 await 过它
 *
 * SW 每次被唤醒都会重新求值本模块，`rules` 从空开始。曾经把"从存储恢复"放在
 * 页面就绪事件里 —— 于是**先问规则的调用方拿到的是空数组**：用户明明存了规则，
 * Agent 的 `tamper get` 回一个空列表，面板也可能在那一瞬间显示"没有规则"。
 *
 * 现在 `loadRules()` 是唯一的恢复点，且它自己保证只读一次盘（`loading` 缓存）。
 * 任何读规则的地方都必须先 await 它，所以 `getRules()` 这个同步口**不存在** ——
 * 有它就会有人用，用了就会读到空。
 */
let rules: TamperRules = emptyRules();

/** 在途的加载。并发调用合并成一次读盘，见 loadRules */
let loading: Promise<void> | null = null;

/**
 * 恢复规则。第一次调用读盘，之后直接返回内存镜像。
 *
 * 读盘失败按空规则处理而不是抛：调用方是页面就绪事件与面板请求，让它们各自
 * 去处理一个"读存储失败"只会得到四种不同的处理方式。空规则是安全的降级
 * （不注入任何东西），失败原因留在控制台。
 *
 * 缓存的是**读盘这件事做完了**，不是读到的那个对象 —— 否则 `applyRules` 之后
 * 这里会一直回旧的那份，而"改了规则界面不更新"正是最难查的一类症状。
 */
export const loadRules = async (): Promise<TamperRules> => {
    if (!loading) {
        loading = (async (): Promise<void> => {
            try {
                const got = await chrome.storage.local.get(TAMPER_STORE_KEY);
                const saved = got[TAMPER_STORE_KEY] as Partial<TamperRules> | undefined;
                rules = {
                    interceptRules: Array.isArray(saved?.interceptRules) ? saved.interceptRules : [],
                    requestRules: Array.isArray(saved?.requestRules) ? saved.requestRules : [],
                    headerRules: Array.isArray(saved?.headerRules) ? saved.headerRules : [],
                };
            } catch (e) {
                console.warn('[Tamper] 读取规则失败，按空规则处理：', e);
                rules = emptyRules();
            }
        })();
    }
    await loading;
    return rules;
};

/**
 * 把当前规则注入一个标签页的主世界。
 *
 * 失败**不抛**：注入会在每个页面就绪事件里发生，而受限页面（chrome://、
 * 扩展商店、PDF 阅读器）本来就不允许注入。抛出去只会让调用方多一层无意义的
 * try/catch，且把"这个页面注入不了"（正常）与"规则写错了"（异常）混在一起。
 *
 * 自己先 await `loadRules()`：注入是**规则的下游**，拿到空镜像就注入等于
 * 装了一个什么都不做的钩子 —— 而页面看起来"装了"（控制台有 Activated 日志），
 * 用户会以为规则不生效是规则本身的问题。
 */
export const injectRules = async (tabId: number): Promise<boolean> => {
    const current = await loadRules();
    try {
        await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            // 必须 MAIN：钩子要改的是**页面自己**的 JSON.parse / fetch。
            // 隔离世界里改的是我们那份副本，页面一行都感知不到。
            world: 'MAIN',
            func: installInterceptor,
            args: [current],
        });
        return true;
    } catch {
        return false;
    }
};

/**
 * 换一套规则并落盘。
 *
 * 落盘与注入**顺序固定**：先写内存镜像再注入，这样注入用的是新规则；
 * 落盘是异步的且失败只记日志 —— 配额满了的时候，用户最不该看到的是
 * "改了规则之后面板卡住"。规则已经对当前页面生效，只是活不过浏览器重启。
 */
export const applyRules = async (next: TamperRules, tabId?: number): Promise<{ saved: boolean }> => {
    rules = next;
    let saved = true;
    try {
        await chrome.storage.local.set({ [TAMPER_STORE_KEY]: next });
    } catch {
        saved = false;
    }
    if (typeof tabId === 'number') await injectRules(tabId);
    return { saved };
};
