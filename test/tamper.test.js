'use strict';
/**
 * 篡改工具下沉后的纯函数回归。
 *
 * 覆盖两处：
 *   1. JWT 工具（decodeJwt / rewriteJwtPayload / pickJwtCandidates）
 *      —— 面板与 Agent 的 tokens 工具共用这一份实现，两边行为必须一致；
 *   2. isRealUrl / buildCookieKeys / buildCookieData / findCookieByKey
 *      —— Cookie 路径守卫与列表键（同名 cookie 在 domain/path 上并存）。
 *
 * 用编译产物 require，不重写副本：被测的就是产品代码本身。
 */
const ROOT = './build';
const {
    decodeJwt, rewriteJwtPayload, pickJwtCandidates, looksLikeJwt,
    isRealUrl, buildCookieKeys, buildCookieData, findCookieByKey,
    ruleTargetKey, isFieldRuleDropped, isHeaderRuleDropped, collectDroppedRules,
    isLinkFromPage, MEDIA_EXTENSIONS, getMediaType,
} = require(`${ROOT}/const`);

let pass = 0;
const fails = [];
const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { fails.push({ name, message: e.message }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };

/** base64url 编码（测试侧独立实现，避免用被测函数造夹具） */
const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * 从**真实的注入脚本**里抽出引擎的 compile / parseValue / isStrictNumber。
 *
 * 关键点：必须求值 INJECT_SCRIPT 那个模板字符串的**结果**，不能读源码原文 ——
 * 反斜杠在模板里会被吃掉（实测源码写 `\d`、运行时变成裸 `d`）。
 * 这里直接读 hooks/useBrowse.ts 的源码文本、按标记切片，
 * 再用 stripTypeScriptTypes 去掉类型后求值，拿到的是与页面里跑的同一份逻辑。
 */
const loadEngineCompile = () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useBrowse.ts'), 'utf8');

    const grab = (marker, endMarker) => {
        const start = src.indexOf(marker);
        if (start < 0) throw new Error(`useBrowse.ts 里找不到 ${marker}`);
        const end = src.indexOf(endMarker, start);
        if (end < 0) throw new Error(`找不到 ${marker} 的结尾`);
        return src.slice(start, end + endMarker.length);
    };

    // compile 依赖 isStrictNumber / parseValue / globMatch / compileMatcher
    const block = [
        grab('var isStrictNumber = function(s) {', '\n    };'),
        grab('var parseValue = function(val) {', '\n    };'),
        grab('var globMatch = function(glob, text) {', '\n    };'),
        grab('var compileMatcher = function(pattern) {', '\n    };'),
        grab('var compile = function(cfg) {', '\n    };'),
    ].join('\n');

    // 模板串里 `\d` 之类会被吃掉，但这一段没有正则字面量（引擎刻意手写字符判断），
    // 所以直接求值即可。断言一下确实没有反斜杠转义，防止将来有人在里面加正则。
    if (/\\[dswb]/.test(block)) {
        throw new Error('引擎片段里出现了反斜杠转义 —— 模板字符串会吃掉它，本测试的求值前提已不成立');
    }

    const js = require('module').stripTypeScriptTypes(block, { mode: 'strip' });
    return new Function(`${js}\nreturn { compile, parseValue, isStrictNumber, globMatch };`)();
};

const token = (header, payload, sig) =>
    [b64url(header), b64url(payload), sig === undefined ? 'fakesig' : sig].filter((s) => s !== null).join('.');

/**
 * 从 hooks/useBrowse.ts 里抽出 pickStoredTabs（标签页恢复的纯函数部分）。
 *
 * 它原本内联在 loadStoredTabs 里、直接读 localStorage，无法测 ——
 * 抽成纯函数就是为了能在这里覆盖 activeIndex 的映射。
 */
const loadPickStoredTabs = () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useBrowse.ts'), 'utf8');

    const start = src.indexOf('export const pickStoredTabs = (saved: unknown)');
    if (start < 0) throw new Error('useBrowse.ts 里找不到 pickStoredTabs');
    const end = src.indexOf('\n};', start);
    if (end < 0) throw new Error('找不到 pickStoredTabs 的结尾');

    const block = [
        'const TABS_STORE_MAX = 20;',
        src.slice(start, end + 3),
    ].join('\n');
    const js = require('module').stripTypeScriptTypes(block, { mode: 'strip' })
        .replace('export const pickStoredTabs', 'const pickStoredTabs');
    return new Function(`${js}\nreturn { pickStoredTabs };`)().pickStoredTabs;
};

const run = () => {
    /* ---------------------------- JWT 解码 ---------------------------- */

    check('decodeJwt 解出 header 与 payload', () => {
        const t = token({ alg: 'HS256', typ: 'JWT' }, { sub: '123', vip: false });
        const out = decodeJwt(t);
        assert(out.header.alg === 'HS256', `alg 应为 HS256，实际 ${out.header.alg}`);
        assert(out.payload.sub === '123', 'sub 应为 123');
        assert(out.payload.vip === false, 'vip 应为 false');
    });

    // 这一条是本组测试的核心：atob 返回 Latin-1 字节串，
    // 不先还原成 UTF-8 字节的话，中文会变乱码、emoji 直接抛 InvalidCharacterError。
    check('decodeJwt 正确解出中文 payload', () => {
        const t = token({ alg: 'none' }, { name: '张三', city: '北京' });
        const out = decodeJwt(t);
        assert(out.payload.name === '张三', `中文应为 张三，实际 ${JSON.stringify(out.payload.name)}`);
        assert(out.payload.city === '北京', `城市应为 北京，实际 ${JSON.stringify(out.payload.city)}`);
    });

    check('decodeJwt 正确解出 emoji payload', () => {
        const t = token({ alg: 'none' }, { note: 'ok 🎉🚀' });
        const out = decodeJwt(t);
        assert(out.payload.note === 'ok 🎉🚀', `emoji 应原样还原，实际 ${JSON.stringify(out.payload.note)}`);
    });

    // JWT 规范要求去掉 base64 填充，atob 对非 4 倍数长度会抛错 ——
    // 不补 '=' 的话大多数真实 token 都解不开。
    check('decodeJwt 能吃没有填充的 base64url', () => {
        const payload = { a: 1 };
        const seg = b64url(payload);
        assert(seg.length % 4 !== 0 || seg.length % 4 === 0, '前置条件');
        const t = `eyJhbGciOiJub25lIn0.${seg}.sig`;
        const out = decodeJwt(t);
        assert(out.payload.a === 1, '无填充的段应能解开');
    });

    check('decodeJwt 接受两段（未签名 token）', () => {
        const t = token({ alg: 'none' }, { debug: true }, null);
        assert(t.split('.').length === 2, '前置条件：应为两段');
        const out = decodeJwt(t);
        assert(out.payload.debug === true, '两段 token 应能解开');
    });

    check('decodeJwt 对垃圾输入抛错', () => {
        let threw = false;
        try { decodeJwt('not-a-jwt'); } catch { threw = true; }
        assert(threw, '缺少两段时应抛错');
    });

    /* ---------------------------- JWT 改写 ---------------------------- */

    check('rewriteJwtPayload 合并字段并保留原字段', () => {
        const t = token({ alg: 'HS256' }, { sub: '1', vip: false });
        const next = rewriteJwtPayload(t, { vip: true });
        const out = decodeJwt(next);
        assert(out.payload.vip === true, 'vip 应改成 true');
        assert(out.payload.sub === '1', '原有字段 sub 必须保留');
    });

    // header 段必须逐字符原样搬运：重新编码可能改变键序/空白，
    // 而签名是对 header.payload 原始字节算的。
    check('rewriteJwtPayload 不改动 header 段', () => {
        const t = token({ alg: 'HS256', typ: 'JWT' }, { a: 1 });
        const next = rewriteJwtPayload(t, { a: 2 });
        assert(next.split('.')[0] === t.split('.')[0], 'header 段必须原样不变');
    });

    check('rewriteJwtPayload 保留签名段', () => {
        const t = token({ alg: 'HS256' }, { a: 1 }, 'SIGNATUREPART');
        const next = rewriteJwtPayload(t, { a: 2 });
        assert(next.split('.')[2] === 'SIGNATUREPART', '签名段必须原样不变');
    });

    check('rewriteJwtPayload 两段 token 仍返回两段', () => {
        const t = token({ alg: 'none' }, { a: 1 }, null);
        const next = rewriteJwtPayload(t, { a: 2 });
        assert(next.split('.').length === 2, `应为两段，实际 ${next.split('.').length}`);
    });

    check('rewriteJwtPayload 中文往返不损坏', () => {
        const t = token({ alg: 'none' }, { name: '李四' });
        const next = rewriteJwtPayload(t, { role: '管理员' });
        const out = decodeJwt(next);
        assert(out.payload.name === '李四', '原中文应保留');
        assert(out.payload.role === '管理员', '新中文应正确编码');
    });

    check('rewriteJwtPayload 对数组 payload 抛错', () => {
        const t = token({ alg: 'none' }, [1, 2, 3]);
        let threw = false;
        try { rewriteJwtPayload(t, { a: 1 }); } catch { threw = true; }
        assert(threw, 'payload 不是对象时应抛错');
    });

    /* --------------------------- JWT 候选筛选 --------------------------- */

    check('looksLikeJwt 认两段与三段', () => {
        assert(looksLikeJwt('aa.bb'), '两段应认');
        assert(looksLikeJwt('aa.bb.cc'), '三段应认');
        assert(looksLikeJwt('aa.bb.'), '签名段可为空');
        assert(!looksLikeJwt('aa'), '单段不认');
        assert(!looksLikeJwt(''), '空串不认');
    });

    // Cookie 值常见 "Bearer xxx" 前缀，取最后一段再判
    check('pickJwtCandidates 剥掉 Bearer 前缀', () => {
        const t = token({ alg: 'none' }, { a: 1 });
        const out = pickJwtCandidates([`Bearer ${t}`]);
        assert(out.length === 1, `应找到 1 个，实际 ${out.length}`);
        assert(out[0] === t, '应剥掉前缀返回裸 token');
    });

    check('pickJwtCandidates 去重且保序', () => {
        const a = token({ alg: 'none' }, { i: 1 });
        const b = token({ alg: 'none' }, { i: 2 });
        const out = pickJwtCandidates([a, b, a, 'nope', null, 42, undefined]);
        assert(out.length === 2, `应去重成 2 个，实际 ${out.length}`);
        assert(out[0] === a && out[1] === b, '顺序应为首次出现的顺序');
    });

    check('pickJwtCandidates 跳过非字符串', () => {
        const out = pickJwtCandidates([null, undefined, 123, {}, [], true]);
        assert(out.length === 0, `非字符串应全部跳过，实际找到 ${out.length}`);
    });

    /* ---------------------------- Cookie 守卫 ---------------------------- */

    check('isRealUrl 只接受 http(s)', () => {
        assert(isRealUrl('https://a.com/x'), 'https 应接受');
        assert(isRealUrl('http://a.com'), 'http 应接受');
        assert(!isRealUrl(''), '空串必须拒绝（cookies.get 里表示全部 URL）');
        assert(!isRealUrl('about:blank'), 'about:blank 应拒绝');
        assert(!isRealUrl('file:///C:/x.html'), 'file: 应拒绝');
        assert(!isRealUrl('chrome://settings'), 'chrome: 应拒绝');
        assert(!isRealUrl('not a url'), '非 URL 应拒绝');
    });

    check('buildCookieKeys 对常见情形只显示 name', () => {
        assert(buildCookieKeys([{ name: 'token', path: '/' }])[0] === 'token', '根路径应只显示 name');
        assert(buildCookieKeys([{ name: 'token' }])[0] === 'token', '无 path 应只显示 name');
        assert(
            buildCookieKeys([{ name: 'token', path: '/api' }])[0] === 'token (/api)',
            '非根路径且不撞键时应带 path',
        );
    });

    // 同名不同 path 的 cookie 必须能区分开，否则面板里会互相覆盖
    check('buildCookieKeys 区分同名不同 path', () => {
        const keys = buildCookieKeys([
            { name: 'sid', path: '/' },
            { name: 'sid', path: '/admin' },
        ]);
        assert(keys[0] !== keys[1], `两个键必须不同，实际都是 ${keys[0]}`);
    });

    /**
     * 同名同 path、**domain 不同**是最容易漏的一种：访问 https://sub.example.com/
     * 时 Chromium 会同时返回 `sid@sub.example.com/` 与 `sid@.example.com/`。
     *
     * 旧实现只按 name+path 建键，于是：
     *  - 面板少显示一条（reduce 后写的赢）；
     *  - 按 key 回写时 find 只命中先出现的那条，另一条永远改不到。
     */
    check('buildCookieKeys 区分同名同 path 不同 domain', () => {
        const cookies = [
            { name: 'sid', value: 'HOST-ONLY', domain: 'sub.example.com', path: '/' },
            { name: 'sid', value: 'PARENT-DOM', domain: '.example.com', path: '/' },
        ];
        const keys = buildCookieKeys(cookies);
        assert(keys[0] !== keys[1], `两个键必须不同，实际都是 ${keys[0]}`);

        const data = buildCookieData(cookies);
        assert(Object.keys(data).length === 2, `应显示 2 条，实际 ${Object.keys(data).length}`);
        assert(data[keys[0]] === 'HOST-ONLY' && data[keys[1]] === 'PARENT-DOM', '两条的值都要能取到');
    });

    check('findCookieByKey 取回的是对应那一条', () => {
        const cookies = [
            { name: 'sid', value: 'A', domain: 'sub.example.com', path: '/' },
            { name: 'sid', value: 'B', domain: '.example.com', path: '/' },
        ];
        const keys = buildCookieKeys(cookies);
        assert(findCookieByKey(cookies, keys[0]).value === 'A', '第一个键应取回 A');
        assert(findCookieByKey(cookies, keys[1]).value === 'B', '第二个键应取回 B');
        assert(findCookieByKey(cookies, '不存在') === null, '找不到应返回 null');
    });

    // 不撞键时不该刷出 domain 噪声（否则每行都挂一长串域名）
    check('buildCookieKeys 不撞键时不加 domain', () => {
        const keys = buildCookieKeys([
            { name: 'a', domain: 'www.example.com', path: '/' },
            { name: 'b', domain: 'www.example.com', path: '/' },
        ]);
        assert(keys[0] === 'a' && keys[1] === 'b', `不该出现域名，实际 ${keys.join(', ')}`);
    });

    /* ---------------------- 规则可用性判据 ---------------------- */

    /**
     * 本组最重要的一条：把**引擎自己的 compile** 从注入脚本里抽出来跑，
     * 与 const.ts 里的判据在同一批输入上对照。
     *
     * 引擎那份在模板字符串里、无法 import，所以只能这样交叉验证。
     * 两边判据一旦漂移，面板和 Agent 工具就会报出与引擎不符的结论 ——
     * 那比不报还糟：用户和模型都会照着错的信息去改。
     */
    check('判据与引擎 compile 完全一致', () => {
        const { compile } = loadEngineCompile();

        const cases = [
            // [说明, 规则, 期望被丢弃]
            ['空 jsonPath', { enabled: true, jsonPath: '' }, true],
            ['只有点号', { enabled: true, jsonPath: '.' }, true],
            ['两点号', { enabled: true, jsonPath: '..' }, true],
            ['未填字段（undefined）', { enabled: true }, true],
            ['null', { enabled: true, jsonPath: null }, true],
            ['正常单段', { enabled: true, jsonPath: 'vip' }, false],
            ['正常多段', { enabled: true, jsonPath: 'data.user.id' }, false],
            ['末尾带点', { enabled: true, jsonPath: 'user.' }, true],
            ['点开头', { enabled: true, jsonPath: '.user' }, false],
            ['已禁用（不算丢弃）', { enabled: false, jsonPath: '' }, false],
            ['数字当路径', { enabled: true, jsonPath: 123 }, false],
        ];

        for (const [label, rule, expectDropped] of cases) {
            const compiled = compile({ rules: [rule], requestRules: [], headerRules: [] });
            const engineDropped = compiled.dropped.rules > 0;
            const utilDropped = isFieldRuleDropped(rule);
            assert(
                engineDropped === utilDropped,
                `[${label}] 引擎=${engineDropped} 工具=${utilDropped} 不一致`,
            );
            assert(
                utilDropped === expectDropped,
                `[${label}] 期望 ${expectDropped}，实际 ${utilDropped}`,
            );
        }
    });

    check('请求头判据与引擎一致', () => {
        const { compile } = loadEngineCompile();

        const cases = [
            ['空 headerName', { enabled: true, headerName: '' }, true],
            ['undefined', { enabled: true }, true],
            ['null', { enabled: true, headerName: null }, true],
            ['正常', { enabled: true, headerName: 'Referer' }, false],
            ['空白字符串（引擎认作有值）', { enabled: true, headerName: ' ' }, false],
            ['已禁用', { enabled: false, headerName: '' }, false],
        ];

        for (const [label, rule, expectDropped] of cases) {
            const compiled = compile({ rules: [], requestRules: [], headerRules: [rule] });
            const engineDropped = compiled.dropped.headerRules > 0;
            const utilDropped = isHeaderRuleDropped(rule);
            assert(
                engineDropped === utilDropped,
                `[${label}] 引擎=${engineDropped} 工具=${utilDropped} 不一致`,
            );
            assert(utilDropped === expectDropped, `[${label}] 期望 ${expectDropped}，实际 ${utilDropped}`);
        }
    });

    /**
     * parseValue / isStrictNumber 的取值语义。
     *
     * 这两个函数此前只是被 loadEngineCompile **抽出来给 compile 当依赖**，
     * 本身从没被断言过 —— 抽取是真、覆盖是假。而它们恰恰是"用户填的新值最终
     * 会变成什么"的唯一真值：类型判错的代价是**静默的类型变化**
     * （'007' 变成字符串 7 还是数字 7、'1e3' 是数字还是字符串），
     * 界面上看不出任何异常。
     *
     * BrowsePanel 的 describeNewValue 会在输入框下方实时预告这个结果，
     * 并声称与引擎"逐字一致"。这里就用引擎真值把那份预告一起钉住：
     * 凡引擎会判成数字的写法，预告必须以「数字」开头，反之必须是「字符串」。
     */
    check('parseValue 取值语义与 isStrictNumber 判据', () => {
        const { parseValue, isStrictNumber } = loadEngineCompile();

        // [输入, 期望的 parseValue 结果, 期望被判为严格数字]
        const cases = [
            ['42', 42, true],
            ['-42', -42, true],
            ['0', 0, true],
            ['-0', -0, true],
            ['3.14', 3.14, true],
            ['-0.5', -0.5, true],
            ['1e3', 1000, true],
            ['1E3', 1000, true],
            ['1e+3', 1000, true],
            ['1e-3', 0.001, true],
            ['007', '007', false],      // 前导零 => 字符串，不能变成 7
            ['01', '01', false],
            ['1.', '1.', false],        // 缺小数位
            ['1e', '1e', false],        // 缺指数
            ['1e+', '1e+', false],
            ['.5', '.5', false],        // 缺整数部分
            ['-', '-', false],
            ['', '', false],
            ['abc', 'abc', false],
            ['12abc', '12abc', false],
            ['0x10', '0x10', false],    // 十六进制不是 JSON 数字
            ['Infinity', 'Infinity', false],
            ['NaN', 'NaN', false],
            ['1 ', '1 ', false],        // 尾随空格
            [' 1', ' 1', false],        // 前导空格
            ['true', true, false],
            ['false', false, false],
            ['null', null, false],
            ['undefined', undefined, false],
            // 显式转义前缀 =：取等号后面的**原文**当字符串。
            // 这是用户唯一能强制"就要字符串"的手段（="007"、="42"），
            // 面板的 describeNewValue 也按同一规则预告，两边必须一致。
            ['="007"', '"007"', false],
            ['=42', '42', false],
            ['=', '', false],
            ['=true', 'true', false],
            ['=', '', false],
            ['==x', '=x', false],
        ];

        for (const [input, expected, expectNumber] of cases) {
            assert(
                isStrictNumber(input) === expectNumber,
                `isStrictNumber(${JSON.stringify(input)}) 期望 ${expectNumber}`,
            );
            const got = parseValue(input);
            assert(
                Object.is(got, expected),
                `parseValue(${JSON.stringify(input)}) 期望 ${String(expected)}，实际 ${String(got)}`,
            );
        }
    });

    check('面板的「新值」预告与引擎判据一致', () => {
        const fs = require('fs');
        const path = require('path');
        const { isStrictNumber } = loadEngineCompile();
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'components', 'BrowsePanel.tsx'), 'utf8');

        // 从 BrowsePanel 里抠出它自己那份 isStrictNumber（组件内私有，无法 import）。
        // 签名带 TS 类型标注，不能整段 eval，只取 => 之后的函数体。
        const at = src.indexOf('const isStrictNumber');
        assert(at >= 0, 'BrowsePanel.tsx 里找不到 isStrictNumber');
        const arrow = src.indexOf('=>', at);
        const open = src.indexOf('{', arrow);
        let depth = 0;
        let quote = null;
        let close = -1;
        for (let i = open; i < src.length; i += 1) {
            const ch = src[i];
            if (quote) {
                if (ch === '\\') { i += 1; continue; }
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) { close = i; break; }
            }
        }
        assert(close > open, 'isStrictNumber 函数体没找到');
        const panelIsStrictNumber = new Function('s', src.slice(open + 1, close));

        // 两份实现在同一批输入上必须逐例一致 —— 这正是注释里"逐字一致"的含义
        const probes = ['42', '-42', '0', '-0', '3.14', '1e3', '1E3', '1e+3', '1e-3',
            '007', '01', '1.', '1e', '1e+', '.5', '-', '', 'abc', '12abc', '0x10',
            'Infinity', 'NaN', '1 ', ' 1', 'true', 'null', 'undefined', '0.0', '10.10'];
        for (const p of probes) {
            assert(
                panelIsStrictNumber(p) === isStrictNumber(p),
                `isStrictNumber(${JSON.stringify(p)}) 分叉：面板=${panelIsStrictNumber(p)} 引擎=${isStrictNumber(p)}`,
            );
        }

        // describeNewValue 是输入框下方的实时预告，用户据此判断"我写的会被当成什么"。
        // 它自称与引擎的 parseValue 逐字一致，这里用引擎真值反过来校验它的分类：
        // 引擎判成数字的，预告必须说「数字」；判成字符串的，必须说「字符串」。
        const dvAt = src.indexOf('const describeNewValue');
        assert(dvAt >= 0, 'BrowsePanel.tsx 里找不到 describeNewValue');
        const dvArrow = src.indexOf('=>', dvAt);
        const dvOpen = src.indexOf('{', dvArrow);
        let dvd = 0;
        let dvq = null;
        let dvClose = -1;
        for (let i = dvOpen; i < src.length; i += 1) {
            const ch = src[i];
            if (dvq) {
                if (ch === '\\') { i += 1; continue; }
                if (ch === dvq) dvq = null;
                continue;
            }
            if (ch === "'" || ch === '"' || ch === '`') { dvq = ch; continue; }
            if (ch === '{') dvd += 1;
            else if (ch === '}') {
                dvd -= 1;
                if (dvd === 0) { dvClose = i; break; }
            }
        }
        assert(dvClose > dvOpen, 'describeNewValue 函数体没找到');
        // describeNewValue 的函数体里调用了同文件的 isStrictNumber，
        // 单独 new Function 时那个标识符不在作用域内 —— 把面板自己那份传进去，
        // 这样测的仍是面板的真实组合行为（预告 + 它自己的判据）。
        const describeNewValue = new Function('raw', 'isStrictNumber', src.slice(dvOpen + 1, dvClose));

        const { parseValue } = loadEngineCompile();
        for (const raw of probes.concat(['="007"', '=42', '=', '==x'])) {
            const engineValue = parseValue(raw);
            const preview = describeNewValue(raw, panelIsStrictNumber);
            if (typeof engineValue === 'number') {
                assert(preview.startsWith('数字'),
                    `引擎把 ${JSON.stringify(raw)} 判成数字，但预告说「${preview}」`);
            } else if (typeof engineValue === 'string') {
                assert(preview.startsWith('字符串'),
                    `引擎把 ${JSON.stringify(raw)} 判成字符串，但预告说「${preview}」`);
            }
            // 布尔 / null / undefined 也各有专属文案，不能退化成「字符串」
            if (engineValue === true || engineValue === false) {
                assert(preview.startsWith('布尔'), `${JSON.stringify(raw)} 是布尔，预告却说「${preview}」`);
            }
            if (engineValue === null) {
                assert(preview === 'null', `${JSON.stringify(raw)} 是 null，预告却说「${preview}」`);
            }
            if (engineValue === undefined) {
                assert(preview.includes('undefined'), `${JSON.stringify(raw)} 是 undefined，预告却说「${preview}」`);
            }
        }
    });

    /**
     * globMatch 是 URL 规则匹配的原语（'*' 任意串、'?' 任意单字符）。
     * 它是手写回溯实现（不能用正则 —— 注入脚本嵌在模板字符串里，转义会被吃掉），
     * 手写回溯最容易在连续 '*'、尾随 '*'、空串这些边界上出错，
     * 而一旦判错，表现是"规则莫名其妙不生效/乱生效"，用户完全无从排查。
     * 这里用一份独立的标准实现做对拍。
     */
    check('globMatch 与标准回溯实现逐例一致', () => {
        const { globMatch } = loadEngineCompile();

        // 独立实现（与引擎那份分开写，避免复制粘贴同一个错误）
        const refGlob = (glob, text) => {
            let gi = 0, ti = 0, star = -1, mark = 0;
            while (ti < text.length) {
                if (gi < glob.length && (glob[gi] === '?' || glob[gi] === text[ti])) { gi++; ti++; }
                else if (gi < glob.length && glob[gi] === '*') { star = gi++; mark = ti; }
                else if (star !== -1) { gi = star + 1; ti = ++mark; }
                else return false;
            }
            while (gi < glob.length && glob[gi] === '*') gi++;
            return gi === glob.length;
        };

        const globs = ['*', '?', 'a*', '*a', 'a?c', '*a*', '**', 'a*b*c', '*.*', '?.?',
            'https://*.com/*', '*api*', 'a*b', 'ab*', '*ab', 'a**b', '', '*?*', '?*'];
        const texts = ['', 'a', 'b', 'ab', 'abc', 'aXc', 'a.b', 'https://x.com/y',
            'https://api.x.com/v1', 'aXbYc', 'aabb', '.', 'x.y'];

        for (const g of globs) {
            for (const t of texts) {
                assert(
                    globMatch(g, t) === refGlob(g, t),
                    `globMatch(${JSON.stringify(g)}, ${JSON.stringify(t)}) 引擎=${globMatch(g, t)} 标准=${refGlob(g, t)}`,
                );
            }
        }
    });

    check('ruleTargetKey 取末段', () => {
        assert(ruleTargetKey('vip') === 'vip', '单段应原样');
        assert(ruleTargetKey('data.user.id') === 'id', '多段应取末段');
        assert(ruleTargetKey('') === '', '空应返回空串');
        assert(ruleTargetKey('.') === '', '只有点号应返回空串');
        assert(ruleTargetKey(undefined) === '', 'undefined 应返回空串');
    });

    check('collectDroppedRules 报出下标与原因', () => {
        const dropped = collectDroppedRules({
            intercept: [
                { enabled: true, jsonPath: 'ok' },
                { enabled: true, jsonPath: '' },
            ],
            request: [{ enabled: true, jsonPath: '.' }],
            headers: [
                { enabled: true, headerName: 'Referer' },
                { enabled: true, headerName: '' },
            ],
        });
        assert(dropped.length === 3, `应有 3 条被跳过，实际 ${dropped.length}`);

        const intercept = dropped.filter((d) => d.group === 'intercept');
        assert(intercept.length === 1 && intercept[0].index === 1, '应报出 intercept[1]');

        const request = dropped.filter((d) => d.group === 'request');
        assert(request.length === 1 && request[0].index === 0, '应报出 request[0]');

        const headers = dropped.filter((d) => d.group === 'headers');
        assert(headers.length === 1 && headers[0].index === 1, '应报出 headers[1]');

        for (const d of dropped) {
            assert(typeof d.reason === 'string' && d.reason.length > 0, '每条都要有原因');
        }
    });

    check('collectDroppedRules 全合法时返回空数组', () => {
        const dropped = collectDroppedRules({
            intercept: [{ enabled: true, jsonPath: 'a' }],
            request: [{ enabled: true, jsonPath: 'b' }],
            headers: [{ enabled: true, headerName: 'X' }],
        });
        assert(dropped.length === 0, `应为空，实际 ${dropped.length}`);
    });

    check('collectDroppedRules 容忍缺省与坏输入', () => {
        assert(collectDroppedRules({}).length === 0, '空对象应为空');
        assert(collectDroppedRules({ intercept: [], request: [], headers: [] }).length === 0, '空数组应为空');
        assert(collectDroppedRules({ intercept: undefined }).length === 0, 'undefined 应为空');
        // 数组里混入 null / 非对象不能让整轮崩掉
        assert(collectDroppedRules({ intercept: [null, undefined] }).length === 0, '坏元素应被忽略');
    });

    /* ------------------- 嗅探结果的页面归属 ------------------- */

    /**
     * 「仅当前页」筛选、当前页计数、「清空当前」三处共用 isLinkFromPage。
     * 此前「清空当前」那份少了 `!pageUrl` 这一支，于是没有 pageUrl 的条目
     * 在「仅当前页」下可见却清不掉 —— 点完按钮列表里还剩几条。
     *
     * 这一条断言的就是那个不变量：**筛得出来的，必须清得掉**。
     */
    check('isLinkFromPage 把无 pageUrl 的条目算作当前页', () => {
        const cur = 'https://x.com/';
        assert(isLinkFromPage({ pageUrl: cur }, cur), '同页应算当前页');
        assert(isLinkFromPage({ pageUrl: '' }, cur), 'pageUrl 为空应算当前页（否则永远清不掉）');
        assert(isLinkFromPage({}, cur), '缺字段应算当前页');
        assert(!isLinkFromPage({ pageUrl: 'https://y.com/' }, cur), '别的页不算');
        assert(!isLinkFromPage(null, cur), 'null 不算');
        assert(!isLinkFromPage(undefined, cur), 'undefined 不算');
    });

    check('筛得出的必须清得掉（筛选与清空同判据）', () => {
        const cur = 'https://x.com/';
        const found = [
            { url: 'a', pageUrl: cur },
            { url: 'b', pageUrl: '' },
            { url: 'c', pageUrl: 'https://y.com/' },
        ];

        const shown = found.filter((i) => isLinkFromPage(i, cur));
        const afterClear = found.filter((i) => !isLinkFromPage(i, cur));
        const leftover = afterClear.filter((i) => shown.includes(i));

        assert(shown.length === 2, `应筛出 2 条，实际 ${shown.length}`);
        assert(leftover.length === 0, `清空后不该残留可见条目，实际残留 ${leftover.map((i) => i.url).join(',')}`);
    });

    /* ------------------- 媒体后缀表的单一真值 ------------------- */

    /**
     * .avif 曾经只在主进程嗅探表里，页内嗅探的 imageExts 由 MEDIA_EXTENSIONS
     * 反查而来、不含它 —— 同一个文件走两条路径结论不同。
     * 这一条锁住"表里有 avif，且 getMediaType 认得它"。
     */
    check('MEDIA_EXTENSIONS 覆盖 avif', () => {
        assert(MEDIA_EXTENSIONS.avif === 'image', `avif 应为 image，实际 ${MEDIA_EXTENSIONS.avif}`);
        assert(getMediaType('a.avif') === 'image', 'getMediaType 应把 .avif 判成 image');
        assert(getMediaType('x', undefined, 'https://a/b.avif') === 'image', '按 url 也应判成 image');
    });

    // 页内嗅探的扫描清单与播放器判定必须同源（都派生自 MEDIA_EXTENSIONS），
    // 否则会出现"播放器认、嗅探扫不到"或反之。
    check('媒体类型表不含空值且后缀全小写', () => {
        for (const [ext, type] of Object.entries(MEDIA_EXTENSIONS)) {
            assert(ext === ext.toLowerCase(), `后缀应小写：${ext}`);
            assert(typeof type === 'string' && type.length > 0, `${ext} 的类型不应为空`);
        }
    });

    check('aibook 不被当成可嗅探的图片', () => {
        // useBrowse 的 SNIFF_EXCLUDED_EXTS 会把它排除；这里锁住"表里确实是 image"，
        // 因为那个排除逻辑正是以此为前提写的
        assert(MEDIA_EXTENSIONS.aibook === 'image', 'aibook 在表里应为 image（由嗅探侧显式排除）');
    });

    /**
     * 标签页落盘时 activeIndex 必须**在保存的那一批里**找。
     *
     * 旧写法先 slice(0, MAX) 再对**完整数组** findIndex：标签页超过上限、
     * 且活动页正好在被丢掉的那批里时，存下去的下标指向保存范围之外，
     * 读回时匹配不上、退回第一个 —— 用户重启后回到第一个标签页。
     */
    check('标签页落盘的 activeIndex 不越界', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useBrowse.ts'), 'utf8');

        assert(
            !/const activeIndex = Math\.max\(0, tabs\.findIndex/.test(src),
            '不应再对完整 tabs 数组 findIndex 后直接落盘（下标可能越界）',
        );
        assert(
            /const found = kept\.findIndex/.test(src),
            '应在 slice 之后的那一批里找活动页下标',
        );
    });

    /**
     * 落盘上限必须保留**最新**的若干条，不是最旧的。
     *
     * 条目按发现/收藏顺序追加，末尾最新。slice(0, MAX) 会在攒够上限后把磁盘副本
     * 永久冻结在最早那批 —— 之后无论再嗅到/收藏什么，重启后都看不到。
     * useAgent 的脚本清单踩过同一个坑（那里注释写明了要 slice(-MAX)）。
     */
    check('落盘上限保留最新而非最旧', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useBrowse.ts'), 'utf8');

        for (const [name, key] of [['嗅探结果', 'LINKS_STORE_MAX'], ['书签', 'BOOKMARKS_MAX']]) {
            const wrong = new RegExp(`slice\\(0,\\s*${key}\\)`, 'g');
            const hits = src.match(wrong) || [];
            assert(hits.length === 0, `${name}不应再有 slice(0, ${key})，发现 ${hits.length} 处`);
        }

        // 嗅探的读回与写盘两侧都必须是 slice(-MAX)
        const right = src.match(/\.slice\(-LINKS_STORE_MAX\)/g) || [];
        assert(right.length >= 3, `嗅探读回/写盘/内存态都应 slice(-LINKS_STORE_MAX)，实际 ${right.length} 处`);
    });

    /* ------------------- 标签页恢复的下标映射 ------------------- */

    /**
     * 落盘时 activeIndex 指向**未过滤**数组，读回时空白页会被丢掉 ——
     * 下标不跟着映射就会恢复到错误的标签页。
     *
     * 实测事故：`[空白, A, B]` 且正在看 A（index 1），过滤成 `[A, B]` 后
     * 仍用 1 去索引，落到了 B。用户重启后看到的是"上次那个页面右边的那个"。
     */
    check('pickStoredTabs 恢复正确的活动页（跳过空白页）', () => {
        const pick = loadPickStoredTabs();

        const cases = [
            ['[空白,A,B] 看 A', { tabs: [{ url: '' }, { url: 'A' }, { url: 'B' }], activeIndex: 1 }, 'A'],
            ['[A,空白,B] 看 B', { tabs: [{ url: 'A' }, { url: '' }, { url: 'B' }], activeIndex: 2 }, 'B'],
            ['[空白,B,C] 看 B', { tabs: [{ url: '' }, { url: 'B' }, { url: 'C' }], activeIndex: 1 }, 'B'],
            ['[A,B] 看 A', { tabs: [{ url: 'A' }, { url: 'B' }], activeIndex: 0 }, 'A'],
            ['[空白,A] 看 A', { tabs: [{ url: '' }, { url: 'A' }], activeIndex: 1 }, 'A'],
            ['三连空白后 A', { tabs: [{ url: '' }, { url: '' }, { url: '' }, { url: 'A' }], activeIndex: 3 }, 'A'],
        ];

        for (const [label, saved, expect] of cases) {
            const r = pick(saved);
            assert(r, `[${label}] 不应返回 null`);
            assert(
                r.tabs[r.activeIndex].url === expect,
                `[${label}] 期望 ${expect}，实际 ${r.tabs[r.activeIndex].url}`,
            );
        }
    });

    check('pickStoredTabs 活动页本身是空白页时退回第一个', () => {
        const pick = loadPickStoredTabs();
        const r = pick({ tabs: [{ url: 'A' }, { url: '' }], activeIndex: 1 });
        assert(r && r.tabs[r.activeIndex].url === 'A', '活动页被过滤掉时应退回第一个');
    });

    check('pickStoredTabs 越界/坏输入不崩', () => {
        const pick = loadPickStoredTabs();
        assert(pick(null) === null, 'null 应返回 null');
        assert(pick({}) === null, '缺 tabs 应返回 null');
        assert(pick({ tabs: [] }) === null, '空数组应返回 null');
        assert(pick({ tabs: [{ url: '' }] }) === null, '全是空白页应返回 null');
        assert(pick({ tabs: [{ url: 'A' }], activeIndex: 99 }).tabs[0].url === 'A', '越界下标应退回第一个');
        assert(pick({ tabs: [{ url: 'A' }], activeIndex: 'x' }).tabs[0].url === 'A', '非整数下标应退回第一个');
    });

    /**
     * 嗅探的加载态必须是**计数**，不是布尔量。
     *
     * scan 与 analyzeWithAi 是两个独立操作、共用一个 isAnalyzing。
     * 布尔量下先结束的那个会把还在跑的那个的加载态一起关掉：
     * A 页点「AI 深度嗅探」（慢）→ 导航到 B 页（App 连扫三轮）→
     * scan(B) 很快结束置 false → 界面显示"未在分析"、AI 按钮重新可点，
     * 而 AI 请求还在飞 —— 用户以为没反应，再点一次。
     *
     * 这里断言两件事：用计数、且计数只能归零不能变负。
     */
    check('嗅探加载态用计数而非布尔量', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useBrowse.ts'), 'utf8');

        assert(
            !/setIsAnalyzing\(/.test(src),
            '不应再有 setIsAnalyzing —— 布尔量会被并发操作互相覆盖',
        );
        assert(
            /const isAnalyzing = pendingOps > 0/.test(src),
            'isAnalyzing 应由计数派生',
        );
        assert(
            /Math\.max\(0, n - 1\)/.test(src),
            '计数递减必须夹住下界，否则提前 return 累积会让它变负、之后永久 true',
        );
        assert(
            (src.match(/await trackOp\(async/g) || []).length === 2,
            'scan 与 analyzeWithAi 都应包在 trackOp 里',
        );
    });

    /**
     * AI 分析结果必须校验"出发时那个页面还是当前页"。
     *
     * AI 接口很慢（十几秒），用户完全可能中途切页。原实现没有保护，
     * 迟到的结果会以**旧页面的 URL** 作为 pageUrl 入列 —— 在 B 页看到 A 页的资源。
     */
    check('AI 分析结果带页面归属校验', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useBrowse.ts'), 'utf8');

        const start = src.indexOf('const analyzeWithAi = useCallback');
        assert(start > 0, '找不到 analyzeWithAi');
        const body = src.slice(start, src.indexOf('const clear = useCallback', start));

        assert(/const stillOnPage = /.test(body), '应定义 stillOnPage 判据');
        // 入列前必须校验，否则结果会挂到已经离开的页面上
        const beforeAdd = body.slice(0, body.indexOf('addLinks(extracted.map'));
        assert(
            /if \(!stillOnPage\(\)\) return;/.test(beforeAdd),
            'addLinks 之前必须先校验页面归属',
        );
    });

    console.log(`篡改工具纯函数：通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
        for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
        return false;
    }
    return true;
};

module.exports = { run };
