'use strict';
/**
 * 规则草稿的同步判据。
 *
 * 面板里多了一个必须处理好的情形：**模型也会改规则**
 * （tamper_rules set → applyRules → setInterceptRules）。面板若无条件跟随外部值，
 * 用户敲到一半的规则会被模型的动作冲掉。
 *
 * 被测的是 components/BrowsePanel.tsx 里真实的 resolveDraftSync ——
 * 用 stripTypeScriptTypes 求值源码，不重写副本。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// 浏览器面板合并成一个文件后，草稿判据与它的调用点都在 components/BrowsePanel.tsx 里
const BROWSE_PANEL = path.join(ROOT, 'components', 'BrowsePanel.tsx');
const SRC = fs.readFileSync(BROWSE_PANEL, 'utf8');

/** 切出 resolveDraftSync 与它依赖的 sameRules */
const grab = (marker, endMarker) => {
    const start = SRC.indexOf(marker);
    if (start < 0) throw new Error(`找不到 ${marker}`);
    const end = SRC.indexOf(endMarker, start);
    if (end < 0) throw new Error(`找不到 ${marker} 的结尾`);
    return SRC.slice(start, end + endMarker.length);
};

const build = () => {
    const code = [
        grab('const canonical = (value: unknown): string =>', '\n};'),
        grab('const sameRules = (a: unknown, b: unknown): boolean =>', ';'),
        grab('const resolveDraftSync = <T,>(', '\n};'),
        grab('const showsAsSaved = (status: SaveStatus, dirty: boolean): boolean =>', ';'),
    ].join('\n');
    const js = require('module').stripTypeScriptTypes(code, { mode: 'strip' });
    return new Function(`${js}\nreturn { resolveDraftSync, sameRules, canonical, showsAsSaved };`)();
};

const { resolveDraftSync, sameRules, canonical, showsAsSaved } = build();

/**
 * 地址栏跟随判据在 hooks/useBrowse.ts 里（不在本文件的被测模块内），
 * 单独抽出来求值。
 */
const loadAddressBarFollow = () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useBrowse.ts'), 'utf8');
    const start = src.indexOf('export const shouldAddressBarFollow = (inputFocused: boolean): boolean =>');
    if (start < 0) throw new Error('useBrowse.ts 里找不到 shouldAddressBarFollow');
    const end = src.indexOf(';', start);
    const code = src.slice(start, end + 1).replace('export const shouldAddressBarFollow', 'const shouldAddressBarFollow');
    // 这一行带 TS 类型标注，必须先剥掉才能求值
    const js = require('module').stripTypeScriptTypes(code, { mode: 'strip' });
    return new Function(`${js}\nreturn shouldAddressBarFollow;`)();
};

let pass = 0;
const fails = [];
const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { fails.push({ name, message: e && e.message ? e.message : String(e) }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };

const rule = (jsonPath, newValue) => ({ id: 'x', enabled: true, urlPattern: '*', jsonPath, newValue });

const run = () => {
    /* ------------------- 用户没在编辑 → 跟随外部 ------------------- */

    check('用户草稿干净时跟随外部新值', () => {
        const prev = [rule('a', '1')];
        const next = [rule('a', '1'), rule('b', '2')];
        const current = [rule('a', '1')];          // 与 prev 相同 ⇒ 没在编辑
        const r = resolveDraftSync(prev, next, current);
        assert(r.kept === false, '应跟随，kept 应为 false');
        assert(r.value.length === 2, `应采用外部新值（2 条），实际 ${r.value.length}`);
    });

    check('两边都空时跟随（不误判成编辑中）', () => {
        const r = resolveDraftSync([], [], []);
        assert(r.kept === false, '空对空不该判成有编辑');
        assert(Array.isArray(r.value) && r.value.length === 0, '应返回空数组');
    });

    /* ------------------- 用户有编辑 → 保留草稿（核心） ------------------- */

    // 这是本组最重要的一条：模型在后台改了规则，不能把用户敲了一半的输入冲掉。
    check('用户有未应用编辑时保留草稿', () => {
        const prev = [rule('a', '1')];
        const next = [rule('a', '999')];           // 模型改的
        const current = [rule('a', '1'), rule('typing', '')];  // 用户加了半条
        const r = resolveDraftSync(prev, next, current);
        assert(r.kept === true, '应保留用户草稿，kept 应为 true');
        assert(r.value.length === 2, `应保留 2 条草稿，实际 ${r.value.length}`);
        assert(r.value[1].jsonPath === 'typing', '保留的应是用户那半条');
    });

    check('用户改了值但条数相同，仍保留草稿', () => {
        const prev = [rule('a', '1')];
        const next = [rule('a', '2')];
        const current = [rule('a', '1.5')];        // 用户改到一半
        const r = resolveDraftSync(prev, next, current);
        assert(r.kept === true, '应保留用户草稿');
        assert(r.value[0].newValue === '1.5', `应保留 "1.5"，实际 ${r.value[0].newValue}`);
    });

    check('用户删掉一条时保留草稿', () => {
        const prev = [rule('a', '1'), rule('b', '2')];
        const next = [rule('a', '1'), rule('b', '2'), rule('c', '3')];
        const current = [rule('a', '1')];          // 用户删掉了 b
        const r = resolveDraftSync(prev, next, current);
        assert(r.kept === true, '应保留用户的删除操作');
        assert(r.value.length === 1, `应保留 1 条，实际 ${r.value.length}`);
    });

    /* ------------------- 跟随之后就不再是"编辑中" ------------------- */

    check('连续两次外部变化：第二次仍能跟随', () => {
        const v1 = [rule('a', '1')];
        const v2 = [rule('a', '2')];
        const v3 = [rule('a', '3')];

        // 第一次：用户干净，跟随到 v2
        const r1 = resolveDraftSync(v1, v2, v1);
        assert(r1.kept === false && r1.value === v2, '第一次应跟随');

        // 第二次：草稿现在是 v2（上一版外部值），仍应跟随到 v3
        const r2 = resolveDraftSync(v2, v3, r1.value);
        assert(r2.kept === false, '第二次也应跟随');
        assert(r2.value === v3, '应采用 v3');
    });

    check('保留草稿后外部再变，仍继续保留', () => {
        const v1 = [rule('a', '1')];
        const v2 = [rule('a', '2')];
        const v3 = [rule('a', '3')];
        const mine = [rule('draft', 'x')];

        const r1 = resolveDraftSync(v1, v2, mine);
        assert(r1.kept === true, '第一次应保留');

        const r2 = resolveDraftSync(v2, v3, r1.value);
        assert(r2.kept === true, '第二次仍应保留');
        assert(r2.value[0].jsonPath === 'draft', '用户的草稿应一直在');
    });

    /* ------------- 用户自己保存后不该报「被覆盖」（实测事故） ------------- */

    /**
     * 用户点「应用更改」→ save() 调 saveRules(intercept,...) →
     * useBrowse 的 applyRules 把**同一个数组**交给 setState。
     * 于是外部值 next 与草稿 current 是同一个引用，而 prev 是保存前那份。
     *
     * 旧判据只比 current vs prev，必然判成"用户有未应用的编辑"，
     * 界面于是弹出「Agent 在对话里改过规则，你手上有未应用的编辑」——
     * 而 Agent 根本没参与，规则也明明已经生效了（dirty=false）。
     * 每次保存都误报一次。
     */
    check('用户自己保存后不报「被覆盖」', () => {
        const before = [rule('a', '1')];
        const draft = [rule('a', '2')];          // 用户改成 2 并点了应用

        // saveRules 把 draft 原样交给 setState ⇒ next 就是 draft
        const r = resolveDraftSync(before, draft, draft);
        assert(r.kept === false, '自己保存不该报"被覆盖"');
        assert(r.value === draft, '应采用这份草稿');
    });

    check('外部改成与草稿相同的值时不算被覆盖', () => {
        const before = [rule('a', '1')];
        const mine = [rule('a', '2')];
        const same = [rule('a', '2')];           // 内容相同但不是同一引用

        const r = resolveDraftSync(before, same, mine);
        assert(r.kept === false, '内容一致就没有"被覆盖"可言');
    });

    // 但真正被覆盖时仍必须保留用户草稿 —— 上面那条放宽不能把这条吃掉
    check('外部改成不同值、用户有编辑时仍保留', () => {
        const before = [rule('a', '1')];
        const mine = [rule('a', 'half-typed')];
        const theirs = [rule('a', '999')];

        const r = resolveDraftSync(before, theirs, mine);
        assert(r.kept === true, '内容不同时必须保留用户草稿');
        assert(r.value[0].newValue === 'half-typed', '保留的应是用户那份');
    });

    /* ------------- 「已应用」确认态不能盖住新改动（实测事故） ------------- */

    /**
     * 保存成功后 saveStatus 保持 'saved' 两秒再收回。这两秒里用户若又改了规则，
     * dirty 已变 true，但按钮还挂着绿勾「已应用」，横幅也不显示（它要求 idle）——
     * 此刻切走再回来，看到的就是"改动已保存"。
     */
    check('有未应用改动时不再显示「已应用」', () => {
        assert(showsAsSaved('saved', false), '干净时应显示已应用');
        assert(!showsAsSaved('saved', true), '又改过之后必须立刻撤掉绿勾');
        assert(!showsAsSaved('idle', false), 'idle 不是已应用');
        assert(!showsAsSaved('idle', true), 'idle 且有改动不是已应用');
    });

    // failed 说的是"没写进本地存储"，与之后改不改无关，不能被 dirty 抹掉
    check('失败提示不受 dirty 影响', () => {
        assert(!showsAsSaved('failed', false), 'failed 不是已应用');
        assert(!showsAsSaved('failed', true), 'failed 且有改动也不是已应用');
    });

    /**
     * 面板必须**调用**这个判据，而不是自己内联一份。
     *
     * 上一组测的是纯函数；若有人把条件写回 `saveStatus === 'saved'`，
     * 纯函数测试照样全绿而 bug 已经回来了（第 2 轮踩过同样的"只测判据、不测调用点"）。
     */
    check('Agent 边栏调用共享判据而非内联', () => {
        const fs = require('fs');
        const src = fs.readFileSync(BROWSE_PANEL, 'utf8');

        assert(
            /showsAsSaved\(saveStatus,\s*draft\.dirty\)/.test(src),
            '应调用 showsAsSaved(saveStatus, draft.dirty)',
        );
        assert(
            !/saveStatus === 'saved'\s*\?/.test(src),
            '不应内联 saveStatus === "saved" 做外观判断（会盖住新改动）',
        );
    });

    /* ---------------- 地址栏跟随：用户输入不能被 SPA 导航吞掉 ---------------- */

    /**
     * 实测事故：用户点进地址栏开始敲新地址，页面自己 pushState 跳了一下
     * （did-navigate-in-page → activeTab.url 变化 → effect 重跑），
     * 输入被覆盖成当前页地址。用户看到一串自己没打过的字符，回车就跳错地方。
     */
    check('地址栏在聚焦时不跟随页面 URL', () => {
        const follow = loadAddressBarFollow();

        assert(follow(false) === true, '未聚焦时应跟随');
        assert(follow(true) === false, '聚焦时必须停止跟随，否则用户输入会被覆盖');
    });

    // 判据必须真的被 effect 用上，而不是写在内联 if 里
    check('地址栏 effect 调用共享判据', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useBrowse.ts'), 'utf8');

        assert(
            /if \(!shouldAddressBarFollow\(inputFocusedRef\.current\)\) return;/.test(src),
            'effect 应通过 shouldAddressBarFollow 判断是否跟随',
        );
        assert(
            /setInputFocused/.test(src),
            '应把聚焦状态暴露给地址栏组件',
        );
    });

    // 组件必须上报聚焦/失焦，否则判据永远读到 false、等于没修
    check('AddressBar 上报聚焦与失焦', () => {
        const fs = require('fs');
        const src = fs.readFileSync(BROWSE_PANEL, 'utf8');

        assert(/setInputFocused\(true\)/.test(src), 'onFocus 应上报 true');
        assert(/setInputFocused\(false\)/.test(src), 'onBlur 应上报 false');
    });

    /* ------------------- 字段级差异也要认出来 ------------------- */

    check('enabled 翻转算作有编辑', () => {
        const prev = [{ id: 'x', enabled: true, urlPattern: '*', jsonPath: 'a', newValue: '1' }];
        const current = [{ id: 'x', enabled: false, urlPattern: '*', jsonPath: 'a', newValue: '1' }];
        const next = [{ id: 'x', enabled: true, urlPattern: '*', jsonPath: 'a', newValue: '1' }];
        const r = resolveDraftSync(prev, next, current);
        assert(r.kept === true, '关掉一条规则也算编辑，应保留');
        assert(r.value[0].enabled === false, '应保留用户的禁用状态');
    });

    check('键序不同但内容相同视为未编辑', () => {
        const prev = [{ id: 'x', enabled: true, jsonPath: 'a', urlPattern: '*', newValue: '1' }];
        const current = [{ id: 'x', enabled: true, urlPattern: '*', jsonPath: 'a', newValue: '1' }];
        const next = [rule('a', '1')];
        const r = resolveDraftSync(prev, next, current);
        assert(r.kept === false, '内容相同（仅键序不同）应视为未编辑');
    });

    /* ------------------- 比较本身的性质 ------------------- */

    check('canonical 忽略键序', () => {
        assert(canonical({ a: 1, b: 2 }) === canonical({ b: 2, a: 1 }), '键序应被忽略');
    });

    check('canonical 对嵌套对象也忽略键序', () => {
        const x = { id: 'x', meta: { p: 1, q: 2 } };
        const y = { meta: { q: 2, p: 1 }, id: 'x' };
        assert(canonical(x) === canonical(y), '嵌套键序也应被忽略');
    });

    check('canonical 仍能区分不同内容', () => {
        assert(canonical({ a: 1 }) !== canonical({ a: 2 }), '值不同必须判为不同');
        assert(canonical({ a: 1 }) !== canonical({ a: 1, b: 2 }), '多一个键必须判为不同');
        assert(canonical([1, 2]) !== canonical([2, 1]), '数组顺序必须敏感');
    });

    check('canonical 区分类型与空值', () => {
        assert(canonical({ a: '1' }) !== canonical({ a: 1 }), '字符串 1 与数字 1 应不同');
        assert(canonical({ a: null }) !== canonical({ a: 'null' }), 'null 与 "null" 应不同');
        assert(canonical({ a: true }) !== canonical({ a: 'true' }), 'true 与 "true" 应不同');
    });

    check('sameRules 对数组元素顺序敏感', () => {
        const a = [rule('a', '1'), rule('b', '2')];
        const b = [rule('b', '2'), rule('a', '1')];
        assert(!sameRules(a, b), '规则顺序不同应判为不同（顺序影响引擎遍历）');
    });

    console.log(`规则草稿同步：通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
        for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
        return false;
    }
    return true;
};

module.exports = { run };
