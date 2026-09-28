'use strict';
/**
 * 浏览器外壳能力的回归测试。
 *
 * 覆盖三块：
 *
 *   1. **跨进程动作表逐字比对** —— 主进程的 BROWSER_ACTIONS（JS 数组）与
 *      meta/interface.ts 的 BrowserAction（TS 联合类型）必须一一对应。
 *      漂移的症状是"按了没反应"：渲染层收到不认识的动作名，switch 落到
 *      default 静默忽略。这是本套件里最重要的一条 —— 它盯的是两份**没有
 *      编译期约束**的清单。
 *
 *   2. **快捷键判据** —— 纯函数，但方向多（Ctrl/Alt/Shift/无修饰四组），
 *      写错一个分支就是某个快捷键静默失效。
 *
 *   3. **权限判据** —— 判错的方向是**隐私泄漏**（把 media 判成允许，
 *      任何被打开的页面都能开摄像头且无提示），所以逐个断言拒绝名单。
 *
 * 用编译产物 require 与主进程源码 require 各取一半：判据在
 * services/BrowserService（TS），接线在 electron/browserService.js（JS）。
 * 两边都是**产品代码本身**，不重写副本。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

let pass = 0;
const fails = [];
const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { fails.push({ name, message: e.message }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};

/** 构造一个 before-input-event 的 Input 对象 */
const key = (k, mods = {}) => ({
    type: 'keyDown',
    key: k,
    code: '',
    isAutoRepeat: false,
    isComposing: false,
    shift: Boolean(mods.shift),
    control: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    meta: Boolean(mods.meta),
    location: 0,
    modifiers: [],
});

const run = () => {
    const svc = require(path.join(ROOT, 'electron', 'browserService.js'));
    const browser = require('./build/services/BrowserService');

    /* ====================================================================== */
    /* 1. 跨进程动作表逐字比对                                                  */
    /* ====================================================================== */

    check('动作表：主进程 BROWSER_ACTIONS 与渲染层 BrowserAction 逐字一致', () => {
        const ifaceSrc = fs.readFileSync(path.join(ROOT, 'meta', 'interface.ts'), 'utf8');

        // 从 TS 源码里抠出 BrowserAction 联合类型的成员。
        // 不能 eval：那是类型声明，运行时不存在。只能文本提取。
        const start = ifaceSrc.indexOf('export type BrowserAction =');
        assert(start >= 0, 'meta/interface.ts 里找不到 BrowserAction');
        const end = ifaceSrc.indexOf(';', start);
        assert(end > start, 'BrowserAction 声明没有以 ; 结尾');
        const block = ifaceSrc.slice(start, end);

        const rendererActions = [...new Set(
            (block.match(/'([a-zA-Z]+)'/g) || []).map((s) => s.slice(1, -1))
        )];

        assert(rendererActions.length > 0, 'BrowserAction 里一个成员都没提取到（正则没匹配上？）');

        const mainActions = svc.BROWSER_ACTIONS;
        assert(Array.isArray(mainActions) && mainActions.length > 0, 'BROWSER_ACTIONS 不是非空数组');

        const onlyMain = mainActions.filter((a) => !rendererActions.includes(a));
        const onlyRenderer = rendererActions.filter((a) => !mainActions.includes(a));

        const problems = [];
        for (const a of onlyMain) {
            problems.push(`主进程会下发「${a}」，但渲染层的 BrowserAction 里没有它（switch 会静默忽略）`);
        }
        for (const a of onlyRenderer) {
            problems.push(`渲染层声明了「${a}」，但主进程永远不会下发它（死分支）`);
        }
        assert(problems.length === 0, problems.join('；'));
    });

    check('动作表：主进程每个**按键**动作都有对应的 preventDefault 判据', () => {
        // shouldPreventDefault 只对 escape 返回 false，其余都拦。
        // 这条断言防的是"以后有人给某个动作加了分支却忘了让它不被拦"。
        //
        // 只对 KEY 那一批断言：右键菜单动作与推送动作**不经过**按键路径，
        // 早先把三类混在一起时这条断言会对 audibleChanged 误报，
        // 于是有人给它加个豁免 —— 而豁免本身就是"这张表混了两种东西"的信号。
        eq(svc.shouldPreventDefault('escape'), false, 'escape 不该被 preventDefault（页面自己要用）');
        for (const action of svc.BROWSER_KEY_ACTIONS) {
            if (action === 'escape') continue;
            eq(svc.shouldPreventDefault(action), true, `${action} 应当被 preventDefault`);
        }
    });

    check('动作表：三个子表互不重叠，且拼起来等于总表', () => {
        const all = [...svc.BROWSER_KEY_ACTIONS, ...svc.BROWSER_MENU_ACTIONS, ...svc.BROWSER_PUSH_ACTIONS];
        eq(new Set(all).size, all.length, '子表之间有重复项');
        eq(new Set(svc.BROWSER_ACTIONS).size, svc.BROWSER_ACTIONS.length, '总表里有重复项');
        eq(svc.BROWSER_ACTIONS.length, all.length, '总表与子表之和不一致');
        for (const a of all) {
            assert(svc.BROWSER_ACTIONS.includes(a), `${a} 不在总表里`);
        }
    });

    check('动作表：渲染层的 BrowserAction 也分了两类', () => {
        // 渲染层必须同样区分"按键/菜单动作"与"推送动作"——
        // 它靠这个区分决定要不要 preventDefault 以及要不要走 ref 转发。
        const ifaceSrc = fs.readFileSync(path.join(ROOT, 'meta', 'interface.ts'), 'utf8');
        assert(/主进程推送的状态变更/.test(ifaceSrc),
            'meta/interface.ts 的 BrowserAction 没有把推送动作单独标注出来');
    });

    /* ====================================================================== */
    /* 2. 快捷键判据                                                           */
    /* ====================================================================== */

    check('快捷键：keyUp 一律不处理（否则每个组合键触发两次）', () => {
        const up = { ...key('t', { ctrl: true }), type: 'keyUp' };
        eq(svc.resolveBrowserShortcut(up), null);
        eq(svc.resolveBrowserShortcut(null), null);
        eq(svc.resolveBrowserShortcut(undefined), null);
    });

    check('快捷键：Ctrl 组合', () => {
        const cases = [
            ['t', {}, 'newTab'],
            ['w', {}, 'closeTab'],
            ['Tab', {}, 'nextTab'],
            ['Tab', { shift: true }, 'prevTab'],
            ['PageDown', {}, 'nextTab'],
            ['PageUp', {}, 'prevTab'],
            ['l', {}, 'focusAddressBar'],
            ['r', {}, 'reload'],
            ['r', { shift: true }, 'hardReload'],
            ['f', {}, 'find'],
            ['g', {}, 'findNext'],
            ['g', { shift: true }, 'findPrev'],
            ['d', {}, 'toggleBookmark'],
            ['i', { shift: true }, 'toggleDevTools'],
            ['=', {}, 'zoomIn'],
            ['+', {}, 'zoomIn'],
            ['-', {}, 'zoomOut'],
            ['_', {}, 'zoomOut'],
            ['0', {}, 'zoomReset'],
        ];
        for (const [k, mods, expected] of cases) {
            const hit = svc.resolveBrowserShortcut(key(k, { ctrl: true, ...mods }));
            assert(hit, `Ctrl+${mods.shift ? 'Shift+' : ''}${k} 没有匹配到任何动作`);
            eq(hit.action, expected, `Ctrl+${mods.shift ? 'Shift+' : ''}${k}`);
        }
    });

    check('快捷键：Ctrl+1..8 选标签，Ctrl+9 选最后一个', () => {
        for (let n = 1; n <= 8; n += 1) {
            const hit = svc.resolveBrowserShortcut(key(String(n), { ctrl: true }));
            assert(hit, `Ctrl+${n} 没匹配`);
            eq(hit.action, 'selectTabIndex');
            eq(hit.arg, n - 1, `Ctrl+${n} 的下标`);
        }
        const last = svc.resolveBrowserShortcut(key('9', { ctrl: true }));
        eq(last.action, 'lastTab');
        eq(last.arg, undefined, 'Ctrl+9 不该带下标参数');
    });

    check('快捷键：Alt 组合', () => {
        const cases = [
            ['ArrowLeft', 'back'],
            ['ArrowRight', 'forward'],
            ['d', 'focusAddressBar'],
            ['Home', 'home'],
        ];
        for (const [k, expected] of cases) {
            const hit = svc.resolveBrowserShortcut(key(k, { alt: true }));
            assert(hit, `Alt+${k} 没匹配`);
            eq(hit.action, expected, `Alt+${k}`);
        }
    });

    check('快捷键：无修饰键', () => {
        const cases = [
            ['F5', false, 'reload'],
            ['F5', true, 'hardReload'],
            ['F3', false, 'findNext'],
            ['F3', true, 'findPrev'],
            ['F6', false, 'focusAddressBar'],
            ['F12', false, 'toggleDevTools'],
            ['Escape', false, 'escape'],
        ];
        for (const [k, shift, expected] of cases) {
            const hit = svc.resolveBrowserShortcut(key(k, { shift }));
            assert(hit, `${shift ? 'Shift+' : ''}${k} 没匹配`);
            eq(hit.action, expected, `${shift ? 'Shift+' : ''}${k}`);
        }
    });

    check('快捷键：Ctrl+Alt 组合不匹配（避免与系统/输入法快捷键打架）', () => {
        eq(svc.resolveBrowserShortcut(key('t', { ctrl: true, alt: true })), null);
        eq(svc.resolveBrowserShortcut(key('ArrowLeft', { ctrl: true, alt: true })), null);
    });

    check('快捷键：Ctrl+Shift+T 恢复关闭的标签，不是新建', () => {
        // Chrome 的行为。写成 newTab 会让"恢复"变成"越按越多"——
        // 用户按 Ctrl+Shift+T 五次期望找回五个页面，结果开出五个空白页。
        const hit = svc.resolveBrowserShortcut(key('t', { ctrl: true, shift: true }));
        assert(hit, 'Ctrl+Shift+T 没有匹配到动作');
        eq(hit.action, 'reopenTab');
        eq(svc.resolveBrowserShortcut(key('t', { ctrl: true })).action, 'newTab', 'Ctrl+T 仍是新建');
    });

    check('快捷键：输入法合成中一律放行（中文输入法的候选键不能被抢）', () => {
        // 实测确认过这是真实可达的：没有这道守卫时，isComposing:true 的
        // Ctrl+T 会照常返回 newTab。而中文输入法下 Ctrl+数字 常被用来选候选词，
        // 拦下来会让用户打着字、标签页突然跳走。
        const composing = (k, mods) => ({ ...key(k, mods), isComposing: true });
        eq(svc.resolveBrowserShortcut(composing('t', { ctrl: true })), null, '合成中的 Ctrl+T');
        eq(svc.resolveBrowserShortcut(composing('1', { ctrl: true })), null, '合成中的 Ctrl+1（选候选词）');
        eq(svc.resolveBrowserShortcut(composing('Tab', { ctrl: true })), null, '合成中的 Ctrl+Tab');
        eq(svc.resolveBrowserShortcut(composing('=', { ctrl: true })), null, '合成中的 Ctrl+=');
        // 未合成时仍要正常工作
        eq(svc.resolveBrowserShortcut(key('t', { ctrl: true })).action, 'newTab');
    });

    check('快捷键：自动重复只放行可连发的动作', () => {
        const repeat = (k, mods) => ({ ...key(k, mods), isAutoRepeat: true });
        // 缩放与切标签连按有意义
        eq(svc.resolveBrowserShortcut(repeat('=', { ctrl: true })).action, 'zoomIn');
        eq(svc.resolveBrowserShortcut(repeat('Tab', { ctrl: true })).action, 'nextTab');
        // 新建标签连按会瞬间开出几十个标签页 —— 必须挡住
        eq(svc.resolveBrowserShortcut(repeat('t', { ctrl: true })), null, 'Ctrl+T 连发必须被挡');
        eq(svc.resolveBrowserShortcut(repeat('w', { ctrl: true })), null, 'Ctrl+W 连发必须被挡');
    });

    check('快捷键：未映射的键返回 null（不能吞掉页面自己的按键）', () => {
        for (const k of ['a', 'z', 'F1', 'F7', 'Enter', 'Backspace']) {
            eq(svc.resolveBrowserShortcut(key(k)), null, `${k} 不该被拦`);
            eq(svc.resolveBrowserShortcut(key(k, { ctrl: true })), null, `Ctrl+${k} 不该被拦`);
        }
    });

    /* ====================================================================== */
    /* 3. 权限判据                                                             */
    /* ====================================================================== */

    check('权限：摄像头/麦克风、屏幕录制、定位、通知一律拒绝', () => {
        // 这几条判错的后果是**隐私泄漏**：任何被打开的页面都能静默开启设备。
        // Electron 的默认行为是"全部自动允许"，所以这份拒绝名单是唯一的防线。
        const mustDeny = [
            'media', 'display-capture', 'captured-surface-control',
            'geolocation', 'geolocation-approximate', 'notifications',
            'hid', 'serial', 'usb', 'nfc', 'midi', 'midiSysex',
            'clipboard-read', 'deprecated-sync-clipboard-read',
            'openExternal', 'web-printing', 'idle-detection', 'local-fonts',
            'keyboardLock', 'window-management', 'web-app-installation',
            'payment-handler', 'vr', 'ar', 'hand-tracking', 'smart-card',
        ];
        for (const p of mustDeny) {
            const d = svc.decidePermission(p);
            eq(d.allow, false, `权限 ${p} 必须被拒绝`);
            assert(d.sensitive === true, `权限 ${p} 应被标为敏感（要有中文名，便于日志排查）`);
        }
    });

    check('权限：播放器与存储相关的必须放行', () => {
        // 这几条判错的后果是**功能静默失效**：全屏按钮点了没反应、
        // IndexedDB 被清、第三方登录态断掉。用户完全看不出是权限问题。
        const mustAllow = [
            'fullscreen', 'automatic-fullscreen', 'pointerLock',
            'persistent-storage', 'storage-access', 'top-level-storage-access',
            'background-sync', 'background-fetch', 'screen-wake-lock', 'system-wake-lock',
        ];
        for (const p of mustAllow) {
            eq(svc.decidePermission(p).allow, true, `权限 ${p} 必须放行`);
        }
    });

    check('权限：未知权限默认拒绝，且不标为敏感', () => {
        const d = svc.decidePermission('unknown');
        eq(d.allow, false, '未知权限必须默认拒绝');
        eq(d.sensitive, false, 'unknown 没有中文名，不该被标为敏感（否则日志会刷屏）');
        eq(d.label, 'unknown', '没有中文名时标签回落成原权限名');

        const weird = svc.decidePermission('some-future-permission');
        eq(weird.allow, false, '未来新增的权限也必须默认拒绝');
    });

    check('权限：空值与异常输入不抛异常', () => {
        for (const v of [undefined, null, '', 0, {}]) {
            const d = svc.decidePermission(v);
            eq(d.allow, false, `decidePermission(${JSON.stringify(v)}) 必须返回拒绝而不是抛`);
        }
    });

    check('权限：中文名清单与允许清单没有交集', () => {
        // 一条权限如果既在 ALLOWED 里又有中文名，说明有人改了一处忘了另一处。
        // 症状是"明明放行了却打日志说拒绝"，排查方向会被带偏。
        const overlap = [...svc.ALLOWED_PERMISSIONS].filter((p) => svc.PERMISSION_LABELS[p]);
        assert(overlap.length === 0, `这些权限同时被允许又有中文名：${overlap.join(', ')}`);
    });

    /* ====================================================================== */
    /* 4. 导航失败归类（渲染层侧）                                              */
    /* ====================================================================== */

    check('错误归类：已知错误码给出中文说法与建议', () => {
        const cases = [
            [-105, '域名解析失败'],
            [-100, '无法连接到服务器'],
            [-130, '代理连接失败'],
            [-201, '证书已过期'],
            [-207, '证书域名不匹配'],
        ];
        for (const [code, expected] of cases) {
            const e = browser.classifyNavigationError(code, 'ERR_SOMETHING', 'https://example.com/a');
            eq(e.title, expected, `错误码 ${code}`);
            assert(e.hint.length > 0, `错误码 ${code} 应当给出可操作的建议`);
            eq(e.host, 'example.com', `错误码 ${code} 应当解析出域名`);
        }
    });

    check('错误归类：未知错误码回落成 Chromium 原文，不编造说法', () => {
        const e = browser.classifyNavigationError(-9999, 'ERR_WEIRD_THING', 'https://x.test/');
        eq(e.title, 'ERR_WEIRD_THING', '未知码应当直接用原始描述');
        eq(e.hint, '', '未知码没有建议，必须是空串（界面据此决定不画第二行）');
        eq(e.errorCode, -9999);
    });

    check('错误归类：完全没有描述时给一个兜底说法', () => {
        const e = browser.classifyNavigationError(0, '', '');
        eq(e.title, '页面加载失败');
        eq(e.host, '', '地址解析不出时域名是空串，不能抛');
    });

    check('错误归类：证书类与 DNS 类被单独标出来', () => {
        for (const code of [-200, -201, -202, -207, -219]) {
            eq(browser.classifyNavigationError(code, '', '').isCertificate, true, `${code} 是证书类`);
        }
        for (const code of [-199, -220, -105 - 1]) {
            eq(browser.classifyNavigationError(code, '', '').isCertificate, false, `${code} 不是证书类`);
        }
        for (const code of [-105, -137, -138]) {
            eq(browser.classifyNavigationError(code, '', '').isDns, true, `${code} 是 DNS 类`);
        }
        eq(browser.classifyNavigationError(-100, '', '').isDns, false, '-100 是"连不上"，不是 DNS');
    });

    check('错误归类：畸形地址不抛异常', () => {
        for (const u of ['not a url', '://', '', 'http://[', null, undefined, 123]) {
            const e = browser.classifyNavigationError(-105, 'x', u);
            eq(e.host, '', `地址 ${JSON.stringify(u)} 应当解析成空域名而不是抛`);
        }
    });

    /* ====================================================================== */
    /* 5. 错误页显示判据                                                       */
    /* ====================================================================== */

    check('错误页：子框架失败不显示（广告 iframe 挂了不该让整页变错误页）', () => {
        eq(browser.shouldShowNavigationError(-105, false), false);
        eq(browser.shouldShowNavigationError(-105, true), true);
    });

    check('错误页：ERR_ABORTED(-3) 与 0 必须过滤', () => {
        // -3 是正常导航（重定向、点下载、SPA 换页、用户按停止）都会抛的。
        // 不过滤的话每次点下载链接都会闪一下错误页。
        eq(browser.shouldShowNavigationError(-3, true), false, 'ERR_ABORTED 必须过滤');
        eq(browser.shouldShowNavigationError(0, true), false, '0 不是错误');
        eq(browser.shouldShowNavigationError(-105, true), true, '真正的失败要显示');
    });

    check('错误页：isMainFrame 缺失时按主框架处理（宁可多显示也不要吞掉真失败）', () => {
        eq(browser.shouldShowNavigationError(-105, undefined), true);
    });

    /* ====================================================================== */
    /* 6. 缩放判据                                                             */
    /* ====================================================================== */

    check('缩放：步进与边界夹取', () => {
        eq(browser.nextZoomLevel(0, 1), 1);
        eq(browser.nextZoomLevel(0, -1), -1);
        eq(browser.nextZoomLevel(0, 0), 0, 'delta=0 是复位');
        eq(browser.nextZoomLevel(3, 0), 0, '复位无视当前级别');

        // 上限
        eq(browser.nextZoomLevel(5, 1), 5, '到顶后再放大应停在顶');
        eq(browser.nextZoomLevel(4, 1), 5);
        // 下限
        eq(browser.nextZoomLevel(-5, -1), -5, '到底后再缩小应停在底');
        eq(browser.nextZoomLevel(-4, -1), -5);
    });

    check('缩放：从上下限复位之后能正常再放大/缩小（防"卡在边界"）', () => {
        // 这是最容易写错的方向：如果夹取写成 Math.max(MIN, Math.min(MAX, n))
        // 之外的形式，或者复位没把级别归零，用户会发现"按了没反应"
        eq(browser.nextZoomLevel(0, 1), 1, '复位后能放大');
        eq(browser.nextZoomLevel(0, -1), -1, '复位后能缩小');
    });

    check('缩放：非法输入被归一，不产生 NaN', () => {
        for (const v of [NaN, Infinity, -Infinity, undefined, null, '2']) {
            const r = browser.nextZoomLevel(v, 1);
            assert(Number.isInteger(r), `nextZoomLevel(${String(v)}, 1) 应当是整数，实际 ${r}`);
            assert(r >= -5 && r <= 5, `结果越界：${r}`);
        }
    });

    check('缩放：百分比换算与系数换算用同一个底数', () => {
        // 两处各写一个常数时，界面显示 120% 而实际缩放是别的值 —— 不报错，
        // 只是"看着不太对"。这里用 factor 反推百分比来交叉验证。
        for (let level = -5; level <= 5; level += 1) {
            const percent = browser.zoomLevelToPercent(level);
            const factor = browser.zoomLevelToFactor(level);
            eq(Math.round(factor * 100), percent, `level ${level} 的两种换算不一致`);
        }
        eq(browser.zoomLevelToPercent(0), 100, 'level 0 必须是 100%');
        eq(browser.zoomLevelToFactor(0), 1, 'level 0 的系数必须是 1');
    });

    /* ====================================================================== */
    /* 7. 可编辑目标判据                                                       */
    /* ====================================================================== */

    check('可编辑目标：input / textarea / select / contenteditable 都算', () => {
        const mk = (tag, contentEditable) => ({
            tagName: tag, isContentEditable: Boolean(contentEditable),
        });
        eq(browser.isEditableTarget(mk('INPUT')), true);
        eq(browser.isEditableTarget(mk('input')), true, 'tagName 大小写都要认');
        eq(browser.isEditableTarget(mk('TEXTAREA')), true);
        eq(browser.isEditableTarget(mk('SELECT')), true);
        eq(browser.isEditableTarget(mk('DIV', true)), true, 'contenteditable 的 div 也算');
        eq(browser.isEditableTarget(mk('DIV')), false);
        eq(browser.isEditableTarget(null), false);
        eq(browser.isEditableTarget({}), false, '没有 tagName 的对象不该抛');
    });

    /* ====================================================================== */
    /* 8. webview 附着校验                                                     */
    /* ====================================================================== */

    check('webview 校验：高危 webPreferences 被剥掉', () => {
        const prefs = {
            preload: '/evil/preload.js',
            nodeIntegration: true,
            nodeIntegrationInSubFrames: true,
            contextIsolation: false,
            webSecurity: false,
            allowRunningInsecureContent: true,
        };
        const r = svc.reviewWebviewPreferences(prefs, { src: 'https://example.com/' });
        eq(r.ok, true, '剥掉高危项之后应当放行（这个应用的用途就是去任意站点）');
        eq(prefs.preload, undefined, 'preload 必须被删掉（它拿的是 Node 全量能力）');
        eq(prefs.nodeIntegration, false);
        eq(prefs.nodeIntegrationInSubFrames, false);
        eq(prefs.contextIsolation, true);
        eq(prefs.webSecurity, undefined);
        eq(prefs.allowRunningInsecureContent, false);
        eq(r.stripped.length, 6, '六项都该记进 stripped');
    });

    check('webview 校验：不允许的协议被拦截', () => {
        for (const bad of ['javascript:alert(1)', 'chrome-extension://abc/x.html', 'ftp://x/y']) {
            const r = svc.reviewWebviewPreferences({}, { src: bad });
            eq(r.ok, false, `${bad} 必须被拦截`);
        }
        for (const good of ['https://a.test/', 'http://a.test/', 'file:///C:/x.html', 'about:blank', 'data:text/html,x', 'blob:https://a.test/x']) {
            eq(svc.reviewWebviewPreferences({}, { src: good }).ok, true, `${good} 应当放行`);
        }
    });

    check('webview 校验：畸形地址拒绝而不是猜', () => {
        eq(svc.reviewWebviewPreferences({}, { src: 'not-a-url' }).ok, false);
        eq(svc.reviewWebviewPreferences({}, { src: '' }).ok, true, '空 src 交给 Electron 自己处理');
        eq(svc.reviewWebviewPreferences(null, {}).ok, true, '没有 webPreferences 时放行');
    });

    /* ====================================================================== */
    /* 9. 下载辅助                                                             */
    /* ====================================================================== */

    check('下载：文件名清洗掉路径分隔符与控制字符', () => {
        // 不清洗的话 ../../x 会写到下载目录之外
        eq(svc.sanitizeDownloadName('../../evil.exe'), '.._.._evil.exe');
        eq(svc.sanitizeDownloadName('a/b\\c.txt'), 'a_b_c.txt');
        eq(svc.sanitizeDownloadName('x\u0000y.txt'), 'x_y.txt');
        eq(svc.sanitizeDownloadName(''), 'download', '空名给兜底');
        eq(svc.sanitizeDownloadName(null), 'download');
    });

    check('下载：重名自动编号，绝不覆盖', () => {
        const os = require('os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theplay-dl-'));
        try {
            const first = svc.uniqueSavePath(dir, 'file.txt');
            eq(path.basename(first), 'file.txt', '第一个用原名');
            fs.writeFileSync(first, 'x');

            const second = svc.uniqueSavePath(dir, 'file.txt');
            eq(path.basename(second), 'file (1).txt', '重名要编号');
            fs.writeFileSync(second, 'x');

            const third = svc.uniqueSavePath(dir, 'file.txt');
            eq(path.basename(third), 'file (2).txt');

            // 无扩展名也要能编号，且不能把编号拼到名字中间
            fs.writeFileSync(path.join(dir, 'noext'), 'x');
            eq(path.basename(svc.uniqueSavePath(dir, 'noext')), 'noext (1)');

            // 多扩展名：只对最后一段编号
            fs.writeFileSync(path.join(dir, 'a.tar.gz'), 'x');
            eq(path.basename(svc.uniqueSavePath(dir, 'a.tar.gz')), 'a.tar (1).gz');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    check('下载：快照剔除 DownloadItem 引用（否则 IPC 直接抛）', () => {
        // DownloadItem 是 Electron 对象，塞进 IPC 会抛
        // "An object could not be cloned"。快照必须是纯数据。
        const record = {
            id: 'dl-1',
            item: { thisIsAnElectronObject: true },
            filename: 'a.bin',
            savePath: 'C:/x/a.bin',
            url: 'https://a.test/a.bin',
            mimeType: 'application/octet-stream',
            totalBytes: 1000,
            receivedBytes: 250,
            state: 'progressing',
            paused: false,
            canResume: true,
            startedAt: Date.now() - 1000,
            endedAt: 0,
        };
        const snap = svc.snapshotDownload(record);
        eq(snap.item, undefined, 'item 必须被剔除');
        eq(snap.percent, 25, '百分比按 received/total 算');
        assert(JSON.stringify(snap).length > 0, '快照必须能被 JSON 序列化');

        // 总长未知（服务器没给 Content-Length）时 percent 必须是 -1，
        // 界面据此画不定进度条而不是画一条编出来的 0%
        const unknown = svc.snapshotDownload({ ...record, totalBytes: 0, receivedBytes: 500 });
        eq(unknown.percent, -1, '总长未知时百分比必须是 -1');
    });

    check('下载：快照的百分比不越界', () => {
        const base = {
            id: 'dl-2', filename: 'a', savePath: '', url: '', mimeType: '',
            state: 'progressing', paused: false, canResume: false,
            startedAt: Date.now(), endedAt: 0,
        };
        // 服务器给的 Content-Length 偏小时 received 会超过 total
        const over = svc.snapshotDownload({ ...base, totalBytes: 100, receivedBytes: 250 });
        eq(over.percent, 100, '百分比封顶在 100');
    });

    /* ====================================================================== */
    /* 10. 右键菜单模板                                                        */
    /* ====================================================================== */

    check('右键菜单：链接上给出打开/另存/复制地址', () => {
        const labels = [];
        const tpl = svc.buildContextMenuTemplate({
            params: { linkURL: 'https://a.test/x', linkText: '点我' },
            isGuest: true,
            handlers: {
                openLink: () => { }, saveLink: () => { }, copyText: () => { },
                searchText: () => { }, inspect: () => { },
            },
        });
        for (const item of tpl) if (item.label) labels.push(item.label);
        assert(labels.some((l) => l.includes('在新标签页中打开链接')), '缺少新标签打开');
        assert(labels.some((l) => l.includes('在后台标签页中打开链接')), '缺少后台标签打开');
        assert(labels.some((l) => l.includes('链接另存为')), '缺少链接另存为');
        assert(labels.some((l) => l.includes('复制链接地址')), '缺少复制链接地址');
        assert(labels.some((l) => l.includes('点我')), '缺少用链接文字搜索');
    });

    check('右键菜单：webview 里出现「让 Agent 分析这个元素」', () => {
        const tpl = svc.buildContextMenuTemplate({
            params: { x: 10, y: 20 },
            isGuest: true,
            canGoBack: true,
            canGoForward: false,
            handlers: { analyzeElement: () => { }, inspect: () => { }, navigate: () => { } },
        });
        const labels = tpl.map((i) => i.label).filter(Boolean);
        assert(labels.includes('让 Agent 分析这个元素'), '缺少 Agent 入口');

        // 顺序：Agent 入口应当在「检查元素」**之上** ——
        // 在这个应用里它是更常用的那个动作
        const agentIdx = labels.indexOf('让 Agent 分析这个元素');
        const inspectIdx = labels.indexOf('检查元素');
        assert(inspectIdx > agentIdx, 'Agent 入口应当在检查元素之前');
    });

    check('右键菜单：宿主页面（Agent 面板）不给后退/刷新', () => {
        // 对宿主页面来说"刷新"会重载整个应用，而不是当前标签页 ——
        // 那不是用户右键点页面空白处时想要的东西
        const tpl = svc.buildContextMenuTemplate({
            params: {},
            isGuest: false,
            canGoBack: true,
            handlers: { navigate: () => { }, inspect: () => { }, reloadHost: () => { }, analyzeElement: () => { } },
        });
        const labels = tpl.map((i) => i.label).filter(Boolean);
        assert(!labels.includes('后退'), '宿主页面不该有后退');
        assert(!labels.includes('重新加载'), '宿主页面不该有「重新加载页面」');
        assert(labels.includes('重新加载界面'), '宿主页面应当是「重新加载界面」');
        assert(!labels.includes('让 Agent 分析这个元素'), '宿主页面不该有 Agent 入口');
        assert(labels.includes('检查元素'), '宿主页面应当有检查元素');
    });

    check('右键菜单：可编辑区域的撤销/重做按 editFlags 决定可用性', () => {
        const tpl = svc.buildContextMenuTemplate({
            params: {
                isEditable: true,
                editFlags: { canUndo: false, canRedo: true, canCut: false, canCopy: true, canPaste: false, canDelete: false, canSelectAll: true },
            },
            isGuest: true,
            handlers: { edit: () => { }, inspect: () => { } },
        });
        const byLabel = {};
        for (const i of tpl) if (i.label) byLabel[i.label] = i;
        eq(byLabel['撤销'].enabled, false);
        eq(byLabel['重做'].enabled, true);
        eq(byLabel['剪切'].enabled, false);
        eq(byLabel['复制'].enabled, true);
        eq(byLabel['粘贴'].enabled, false);
        eq(byLabel['全选'].enabled, true);
    });

    check('右键菜单：没有 handlers 的项不生成（而不是生成一个点了没反应的）', () => {
        const tpl = svc.buildContextMenuTemplate({
            params: { linkURL: 'https://a.test/' },
            isGuest: true,
            handlers: {},
        });
        // 一个 handler 都没有时，链接相关的项应当全部消失
        const labels = tpl.map((i) => i.label).filter(Boolean);
        assert(!labels.some((l) => l.includes('打开链接')), '没有 openLink 时不该有打开项');
        assert(!labels.some((l) => l.includes('复制')), '没有 copyText 时不该有复制项');
    });

    check('右键菜单：分隔符不重复、不在开头也不在结尾', () => {
        const tpl = svc.buildContextMenuTemplate({
            params: { linkURL: 'https://a.test/', selectionText: 'x' },
            isGuest: true,
            handlers: { openLink: () => { }, saveLink: () => { }, copyText: () => { }, inspect: () => { } },
        });
        eq(tpl[0].type === 'separator', false, '开头不能是分隔符');
        eq(tpl[tpl.length - 1].type === 'separator', false, '结尾不能是分隔符');
        for (let i = 1; i < tpl.length; i += 1) {
            if (tpl[i].type === 'separator') {
                assert(tpl[i - 1].type !== 'separator', `第 ${i} 项是连续分隔符`);
            }
        }
    });

    check('右键菜单：拼写建议被列出来且最多 5 条', () => {
        const tpl = svc.buildContextMenuTemplate({
            params: {
                isEditable: true,
                misspelledWord: 'teh',
                dictionarySuggestions: ['the', 'tech', 'ten', 'tea', 'tee', 'tenth', 'tether'],
                editFlags: {},
            },
            isGuest: true,
            handlers: { replaceMisspelling: () => { }, edit: () => { }, inspect: () => { } },
        });
        const labels = tpl.map((i) => i.label).filter(Boolean);
        for (const w of ['the', 'tech', 'ten', 'tea', 'tee']) {
            assert(labels.includes(w), `缺少拼写建议 ${w}`);
        }
        assert(!labels.includes('tenth'), '第 6 条建议应当被截掉');
    });

    /* ====================================================================== */
    /* 11. 跨文件契约                                                          */
    /* ====================================================================== */

    check('契约：preload 暴露的 browser 方法与 ElectronBrowserAPI 对齐', () => {
        const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
        const ifaceSrc = fs.readFileSync(path.join(ROOT, 'meta', 'interface.ts'), 'utf8');

        const browserBlock = preloadSrc.slice(
            preloadSrc.indexOf('browser: {'),
            preloadSrc.indexOf('},', preloadSrc.indexOf('browser: {')));
        assert(browserBlock.length > 0, 'preload.js 里找不到 browser 命名空间');

        for (const method of ['onCommand', 'onDownload', 'downloads', 'downloadAction']) {
            assert(browserBlock.includes(`${method}:`), `preload 的 browser 里缺少 ${method}`);
            assert(ifaceSrc.includes(`${method}:`), `ElectronBrowserAPI 里缺少 ${method}`);
        }
    });

    check('契约：主进程注册的 IPC 通道与 preload 调用的一致', () => {
        const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
        const svcSrc = fs.readFileSync(path.join(ROOT, 'electron', 'browserService.js'), 'utf8');
        const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');

        // 通道名在 browserService 里注册，在 preload 里调用 —— 两边必须一致。
        // 不一致的症状是 invoke 永远 pending（没有 handler）或报
        // "No handler registered"，而错误信息指不到是哪一侧写错了。
        for (const channel of ['browser-downloads', 'browser-download-action']) {
            assert(svcSrc.includes(`ipcMain.handle('${channel}'`), `browserService 没有注册 ${channel}`);
            assert(preloadSrc.includes(`'${channel}'`), `preload 没有调用 ${channel}`);
        }
        // 推送通道
        for (const channel of ['browser-command', 'browser-download']) {
            assert(svcSrc.includes(`send('${channel}'`), `browserService 没有推送 ${channel}`);
            assert(preloadSrc.includes(`subscribe('${channel}'`), `preload 没有订阅 ${channel}`);
        }
        assert(mainSrc.includes("require('./browserService')"), 'main.js 没有引入 browserService');
    });

    check('契约：主进程两处挂载点都在（宿主 + guest 缺一不可）', () => {
        const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');

        // 只挂宿主 → 用户点进页面后所有快捷键失效；
        // 只挂 guest → 地址栏 / Agent 输入框里按 Ctrl+T 没反应。
        // 这是本模块最容易漏的一处不对称。
        assert(/did-attach-webview[\s\S]{0,1200}?attachGuestExtras\(webContents\)/.test(mainSrc),
            'did-attach-webview 里没有挂 attachGuestExtras（页面内快捷键会全部失效）');
        assert(/attachBrowserInput\(mainWindow\.webContents\)/.test(mainSrc),
            '宿主窗口没有挂 attachBrowserInput（地址栏里的快捷键会失效）');
        assert(/setupBrowserSession\(mainWindow\.webContents\.session\)/.test(mainSrc),
            '主窗口 session 没有挂浏览器能力（权限与下载会退回默认）');
        assert(/did-attach-webview[\s\S]{0,1200}?setupBrowserSession\(webContents\.session\)/.test(mainSrc),
            'did-attach-webview 里没有挂 setupBrowserSession（webview 带 partition 时权限会退回默认全允许）');
        assert(/guardWebviewAttach\(mainWindow\.webContents\)/.test(mainSrc),
            '没有挂 will-attach-webview 校验');
    });

    check('契约：BrowserService 不在渲染层重复实现错误码表', () => {
        // 两份错误码表的漂移症状是"同一个错误在日志里和界面上叫两个名字"，
        // 不报错、不崩溃，只是让人对不上号。所以主进程那份必须是零。
        const svcSrc = fs.readFileSync(path.join(ROOT, 'electron', 'browserService.js'), 'utf8');
        assert(!/ERROR_TABLE/.test(svcSrc), '主进程里又出现了错误码表 —— 判据只该有一份');
        assert(!/classifyNavigationError/.test(svcSrc), '主进程里又出现了 classifyNavigationError');
        assert(!/shouldShowNavigationError/.test(svcSrc), '主进程里又出现了 shouldShowNavigationError');

        // 渲染层也不该自己再写一份缩放换算
        const browseSrc = fs.readFileSync(path.join(ROOT, 'hooks', 'useBrowse.ts'), 'utf8');
        assert(!/Math\.pow\(1\.2/.test(browseSrc), 'useBrowse 里又出现了 1.2 的幂运算 —— 缩放换算只该有一份');
        assert(!/const ERROR_TABLE|ERROR_TABLE\s*=/.test(browseSrc), 'useBrowse 里又出现了错误码表');
    });

    check('契约：webview 的 findInPage 结果必须靠 found-in-page 事件取', () => {
        const browseSrc = fs.readFileSync(path.join(ROOT, 'hooks', 'useBrowse.ts'), 'utf8');
        // webview 的 findInPage 只返回请求 id，**没有**匹配数。
        // 漏了事件监听，查找条会永远显示 0/0。
        assert(browseSrc.includes("addEventListener('found-in-page'"), '没有监听 found-in-page');
        assert(browseSrc.includes('findReporterRef'), '查找结果没有走 ref 转发');
    });

    check('契约：刷新与强制刷新走**两个不同的 webview API**', () => {
        const browseSrc = fs.readFileSync(path.join(ROOT, 'hooks', 'useBrowse.ts'), 'utf8');

        // 共用一个 key + 布尔标志时，"先看标志再看 key"依赖 React 的批处理细节。
        // 走错那一个的症状是"强刷有时有效有时没有"，很难复现。
        //
        // 断言必须查**两个 key 各自递增**，而不是只查名字出现过 ——
        // 实测过：变异体 M30（把 hardReload 改成递增 reloadKey）能通过
        // "hardReloadKey 存在吗"这种弱断言，因为类型声明与初始值里都有这个名字。
        const hardFn = browseSrc.slice(
            browseSrc.indexOf('const hardReload = useCallback'),
            browseSrc.indexOf('}, []);', browseSrc.indexOf('const hardReload = useCallback')));
        assert(hardFn.length > 0, '找不到 hardReload 的实现');
        assert(/hardReloadKey:\s*\(tab\.hardReloadKey \|\| 0\) \+ 1/.test(hardFn),
            'hardReload 没有递增自己的 hardReloadKey（与普通刷新共用一个 key 时，'
            + '"先看标志再看 key"依赖批处理细节，会偶发走错）');
        assert(!/reloadKey:/.test(hardFn), 'hardReload 不该碰 reloadKey');

        const reloadFn = browseSrc.slice(
            browseSrc.indexOf('const reload = useCallback'),
            browseSrc.indexOf('}, []);', browseSrc.indexOf('const reload = useCallback')));
        assert(/reloadKey:\s*\(tab\.reloadKey \|\| 0\) \+ 1/.test(reloadFn), 'reload 没有递增 reloadKey');
        assert(!/hardReloadKey:/.test(reloadFn), 'reload 不该碰 hardReloadKey');

        // 两个 effect 各调各的 API，且不能调错
        const hardEffect = browseSrc.slice(
            browseSrc.indexOf('prevHardReloadKeys.current[tab.id]'),
            browseSrc.indexOf('}, [tabsState.tabs]);', browseSrc.indexOf('prevHardReloadKeys.current[tab.id]')));
        assert(hardEffect.includes('reloadIgnoringCache()'), '强制刷新的 effect 没有调 reloadIgnoringCache');
        assert(!/\bwebview\.reload\(\)/.test(hardEffect), '强制刷新的 effect 调成了普通 reload');
    });

    check('契约：错误页与崩溃页盖在 webview 之上，不替换它', () => {
        const panelSrc = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');

        // 替换 webview 会让它被卸载重挂 —— 那等于用户点一次重试就重新加载
        // 一次页面，而且失败原因被丢掉。必须是绝对定位的兄弟层。
        //
        // 断言必须查**渲染条件是恒真的真条件**，不能只查字符串出现过 ——
        // 实测过：变异体 M33（把 `{tab.error && (` 改成 `{false && tab.error && (`）
        // 能通过 /tab\.error && \(/ 这种弱断言。
        const errorBranch = panelSrc.indexOf('{tab.error && (');
        assert(errorBranch > 0, '错误页的渲染条件不是 `tab.error && (`（被改成了恒假或其他形式）');
        assert(panelSrc.slice(errorBranch, errorBranch + 200).includes('absolute inset-0 z-20'),
            '错误页不是绝对定位的覆盖层（替换 webview 会让它被卸载重挂）');

        const crashBranch = panelSrc.indexOf('{tab.crashed && !tab.error && (');
        assert(crashBranch > 0, '崩溃页的渲染条件不是 `tab.crashed && !tab.error && (`');
        // 崩溃后 did-fail-load 也会来一条，两个都显示会叠在一起
        assert(crashBranch > errorBranch, '崩溃页分支应当在错误页分支之后');

        // 覆盖层必须在 webview 的**同一个 map 里**（兄弟节点），
        // 而不是把 webview 包进一个条件渲染的容器
        const mapStart = panelSrc.indexOf('{tabs.map((tab) => (');
        const mapEnd = panelSrc.indexOf('snifferError &&', mapStart);
        assert(mapStart > 0 && mapEnd > mapStart, '找不到标签页渲染区');
        const mapBody = panelSrc.slice(mapStart, mapEnd);
        assert(mapBody.includes('<webview'), 'webview 不在标签页 map 里');
        assert(mapBody.includes('{tab.error && ('), '错误页不在同一个 map 里（可能包住了 webview）');
        // webview 的渲染不能被任何条件包裹成"错误时不渲染"
        assert(!/tab\.error \? null :/.test(mapBody), 'webview 被错误态条件渲染了');
    });

    check('契约：Ctrl+Shift+T 的分发真的接上了 reopenClosedTab', () => {
        const browseSrc = fs.readFileSync(path.join(ROOT, 'hooks', 'useBrowse.ts'), 'utf8');

        // reopenClosedTab 曾经是**死代码**：定义、导出、进 actions，
        // 但没有任何地方调用它。这类缺陷静态看完全正常 ——
        // 名字在、类型在、测试里断言"存在吗"也过 —— 只是按了没反应。
        assert(/case 'reopenTab'/.test(browseSrc), '分发器里没有 reopenTab 分支');
        const branch = browseSrc.slice(
            browseSrc.indexOf("case 'reopenTab'"),
            browseSrc.indexOf('break;', browseSrc.indexOf("case 'reopenTab'")));
        assert(branch.includes('reopenClosedTab()'), 'reopenTab 分支没有调用 reopenClosedTab');

        // 「最近关闭」栈本身：关标签时要入栈，且空白页不入栈
        const closeFn = browseSrc.slice(
            browseSrc.indexOf('const closeTab = useCallback'),
            browseSrc.indexOf('}, []);', browseSrc.indexOf('const closeTab = useCallback')));
        assert(/closedStackRef\.current\.push/.test(closeFn), '关标签时没有记入「最近关闭」栈');
        assert(/if \(closing && closing\.url\)/.test(closeFn),
            '空白页也进了「最近关闭」栈 —— 用户按 Ctrl+Shift+T 会开回一个空白页');
        assert(/CLOSED_STACK_MAX/.test(closeFn), '「最近关闭」栈没有深度上限（会无限增长）');

        // 栈空时必须什么都不做，不能新建空白页
        const reopenFn = browseSrc.slice(
            browseSrc.indexOf('const reopenClosedTab = useCallback'),
            browseSrc.indexOf('}, []);', browseSrc.indexOf('const reopenClosedTab = useCallback')));
        assert(/if \(!entry\) return false;/.test(reopenFn), '栈空时没有提前返回（会开出空白页）');
    });

    check('契约：切换标签页时查找条要收掉', () => {
        const browseSrc = fs.readFileSync(path.join(ROOT, 'hooks', 'useBrowse.ts'), 'utf8');
        // 查找是针对具体页面的，跟着切会找错页
        assert(/useEffect\(\(\) => \{\s*if \(!findQueryRef\.current\) return;/.test(browseSrc),
            '没有在切换标签页时收掉查找条');
    });

    check('契约：右键填 Agent 输入框只在输入框空着时生效', () => {
        const panelSrc = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        // 用户可能已经写好半句话，右键只是想再补一个元素的信息，
        // 直接覆盖等于替他扔掉正在写的内容
        assert(/setInput\(\(prev\) => \(prev\.trim\(\) \? prev : prefill\.text\)\)/.test(panelSrc),
            'prefill 会覆盖用户已经写好的内容');
        // 带 seq 是因为同一个元素连点两次右键时纯文本 setState 会被 React 跳过
        assert(/seq: \(prev\?\.seq \|\| 0\) \+ 1/.test(panelSrc),
            'prefill 没有递增序号 —— 连点两次右键第二次会没反应');
    });

    /* ====================================================================== */
    /* 12. 真实事件形状（用主进程模块的接线函数跑一遍）                          */
    /* ====================================================================== */

    check('接线：attachGuestExtras 的记账不会让发声监听被跳过', () => {
        // 实测过的 bug 形态：发声监听的守卫若复用 attachBrowserInput 的
        // attachedContents 集合，attachBrowserInput 一填上，本函数就永远
        // 提前返回 —— 症状是发声指示从来不亮，而快捷键一切正常。
        const svcSrc = fs.readFileSync(path.join(ROOT, 'electron', 'browserService.js'), 'utf8');
        const fnStart = svcSrc.indexOf('function attachGuestExtras');
        const fnBody = svcSrc.slice(fnStart, svcSrc.indexOf('\n}', fnStart));
        assert(fnBody.includes('audibleWatched.has'), '发声监听的守卫没有用独立的记账集合');
        assert(!fnBody.includes('attachedContents.has'), '发声监听用了 attachedContents 做守卫，会被永久跳过');
    });

    check('接线：setupBrowserSession 的幂等记账真的被用上', () => {
        // 只断言 `new WeakSet()` 存在是空断言 —— 把 has/add 两行删掉、
        // 留下声明，一样能通过。三条都要查。
        const svcSrc = fs.readFileSync(path.join(ROOT, 'electron', 'browserService.js'), 'utf8');
        assert(/preparedSessions = new WeakSet\(\)/.test(svcSrc), '缺少 preparedSessions 声明');
        assert(/preparedSessions\.has\(sess\)/.test(svcSrc), '缺少 has() 守卫');
        assert(/preparedSessions\.add\(sess\)/.test(svcSrc), '缺少 add() 落账');
        // will-download 是 EventEmitter 的 on（会叠加），重复挂会让一次下载
        // 被记录两次；权限 handler 是 setter（会替换）。两种语义都需要幂等。
        assert(/sess\.on\('will-download'/.test(svcSrc), '没有挂 will-download');
    });

    check('接线：权限的 request 与 check **两个** handler 都真的挂上了', () => {
        // 这条断言必须锚在**调用**上，不能只搜方法名 ——
        // 文件顶部的大段注释里就写着 setPermissionCheckHandler（引用官方文档
        // 那句 "you must also implement setPermissionCheckHandler"），
        // 所以 `svcSrc.includes('setPermissionCheckHandler')` 永远为真，
        // 把调用整行删掉也照样通过。实测过：变异体 M23 就是这么活下来的。
        const svcSrc = fs.readFileSync(path.join(ROOT, 'electron', 'browserService.js'), 'utf8');

        const reqCall = /sess\.setPermissionRequestHandler\(\s*\w+\s*\)/.exec(svcSrc);
        assert(reqCall, '没有真的调用 sess.setPermissionRequestHandler(handler)');

        const checkCall = /sess\.setPermissionCheckHandler\(\s*\w+\s*\)/.exec(svcSrc);
        assert(checkCall, '没有真的调用 sess.setPermissionCheckHandler(handler) —— '
            + '只挂 request 的话，一部分 API 走 check 那条路（先查后请），判定会漏');

        // 两个 handler 必须都指向同一个判据。各写一份的话，
        // "查得到但请不到"或反之 —— 症状是某个权限时灵时不灵。
        const reqArg = reqCall[0].match(/\(\s*(\w+)\s*\)/)[1];
        const checkArg = checkCall[0].match(/\(\s*(\w+)\s*\)/)[1];
        assert(/decidePermission/.test(
            svcSrc.slice(svcSrc.indexOf(`const ${reqArg}`), svcSrc.indexOf(`const ${reqArg}`) + 400)
        ), `${reqArg} 没有调用 decidePermission`);
        assert(new RegExp(`const ${checkArg} = [^;]*decidePermission`).test(svcSrc),
            `${checkArg} 没有直接调用 decidePermission（两条路可能各判一份）`);
    });

    check('接线：命令带来源 webContentsId（发声状态要按页路由）', () => {
        const svcSrc = fs.readFileSync(path.join(ROOT, 'electron', 'browserService.js'), 'utf8');
        assert(/webContentsId: webContents/.test(svcSrc), '命令里没有带来源 webContentsId');
        assert(/sendCommand\(\s*\{[\s\S]{0,200}?\},\s*webContents\)/.test(svcSrc),
            '发声状态推送没有带 webContents');
    });

    /* ====================================================================== */
    /* 12. 嗅探总开关契约                                                     */
    /* ====================================================================== */

    check('契约：切页自动扫描只在"持续嗅探"打开时发生', () => {
        const appSrc = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
        // 自动三轮必须被开关门控：门一删，切页就自动嗅探；调用一删，
        // 打开开关也不扫。两条都要查。
        assert(/actions\.scan\(/.test(appSrc), 'App.tsx 里没有自动扫 —— 打开开关也不会持续嗅探');
        assert(/if \(!sniffer\.sniffEnabled/.test(appSrc), '自动扫没有被 sniffEnabled 门控 —— 关掉开关也照样扫');
        assert(/sniffer\.sniffEnabled/.test(appSrc.slice(appSrc.indexOf('useEffect('))),
            'effect 依赖里没有 sniffEnabled —— 开关切换不会立即生效');
    });

    check('契约：开关状态持久化 + 同步主进程，网络推送只在打开时接收', () => {
        const browseSrc = fs.readFileSync(path.join(ROOT, 'hooks', 'useBrowse.ts'), 'utf8');
        // 开关默认值必须是关闭：默认打开 = 启动即自动嗅探。
        assert(/loadJSON<boolean>\('sniff-enabled', false\)/.test(browseSrc),
            '开关默认值不是 false（启动即自动嗅探）');
        assert(/saveJSON\('sniff-enabled', sniffEnabled\)/.test(browseSrc), '开关状态没有落盘持久化');
        // 中转必须真的调桥：只查 setSniffEnabled 出现过是空断言（接口声明里本来就有）。
        const pushAt = browseSrc.indexOf('const pushSnifferEnabled = useCallback');
        assert(pushAt > 0, '找不到 pushSnifferEnabled 的实现');
        assert(/setSnifferEnabled\?\.\(enabled\)/.test(browseSrc.slice(pushAt, pushAt + 500)),
            'pushSnifferEnabled 没有调 setSnifferEnabled 桥 —— 开关到不了主进程');
        assert(/const setSniffEnabled = useCallback/.test(browseSrc), '没有 setSniffEnabled 的实现');
        const subAt = browseSrc.indexOf('onSniffedMedia((media)');
        assert(subAt > 0, '找不到网络推送订阅');
        assert(/sniffEnabledRef\.current/.test(browseSrc.slice(subAt, subAt + 600)),
            '网络推送回调没有检查开关状态 —— 关掉开关也会收');
    });

    check('契约：手动"嗅探"是一次性扫描，不碰总开关', () => {
        const browseSrc = fs.readFileSync(path.join(ROOT, 'hooks', 'useBrowse.ts'), 'utf8');
        // 锚在 scan 实现体上：里面一旦出现开关写入，点一次按钮就等于打开了开关。
        const scanFn = browseSrc.slice(
            browseSrc.indexOf('const scan = useCallback'),
            browseSrc.indexOf('const analyzeWithAi = useCallback'));
        assert(scanFn.length > 0, '找不到 scan 的实现');
        assert(!/setSniffEnabledState/.test(scanFn), 'scan 里写了开关状态 —— 点一次手动嗅探就把总开关打开了');
        assert(!/pushSnifferEnabled/.test(scanFn), 'scan 里同步了开关给主进程 —— 同上');
    });

    check('契约：嗅探开关的跨进程通道三处对齐', () => {
        const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
        const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
        const ifaceSrc = fs.readFileSync(path.join(ROOT, 'meta', 'interface.ts'), 'utf8');
        assert(mainSrc.includes("ipcMain.handle('sniffer-set-enabled'"), '主进程没有注册 sniffer-set-enabled');
        assert(/let snifferEnabled = false/.test(mainSrc), '主进程开关默认值不是 false（启动即自动嗅探）');
        assert(/if \(!snifferEnabled\) return;/.test(mainSrc), '网络层回调没有被开关门控 —— 默认会推送');
        assert(preloadSrc.includes('setSnifferEnabled') && preloadSrc.includes("'sniffer-set-enabled'"),
            'preload 没有桥接 setSnifferEnabled');
        assert(ifaceSrc.includes('setSnifferEnabled'), 'ElectronAPI 没有声明 setSnifferEnabled');
    });

    check('契约：嗅探面板上有"持续嗅探"开关', () => {
        const floatingSrc = fs.readFileSync(path.join(ROOT, 'components', 'Floating.tsx'), 'utf8');
        assert(/setSniffEnabled\(!sniffEnabled\)/.test(floatingSrc), '面板上没有切换开关的按钮');
        assert(/持续嗅探/.test(floatingSrc), '面板上没有"持续嗅探"文案 —— 用户找不到开关');
    });

    check('契约：磁力下载已迁出悬浮球（小浮窗装不下结果表）', () => {
        const floatingSrc = fs.readFileSync(path.join(ROOT, 'components', 'Floating.tsx'), 'utf8');
        assert(!/TorrentFloating/.test(floatingSrc), 'Floating 里还有 TorrentFloating —— 搬家没搬干净');
        assert(!/torrentNode/.test(floatingSrc), 'Floating 里还有 torrentNode');
        assert(!/useMagnetSearch/.test(floatingSrc), 'Floating 还在引用 useMagnetSearch');
        assert(/saved === 'torrent'/.test(floatingSrc), '存量用户落盘的 torrent 面板没有回落 —— 打开是空白页');
    });

    check('契约：磁力下载是浏览器全屏页（与 ACG/音频/播放器同概念）', () => {
        const panelSrc = fs.readFileSync(path.join(ROOT, 'components', 'TorrentPanel', 'index.tsx'), 'utf8');
        assert(/export const TorrentPanel/.test(panelSrc), 'TorrentPanel 没有导出');
        assert(/onBack/.test(panelSrc), 'TorrentPanel 没有返回入口 —— 全屏页必须能回浏览');
        assert(/useMagnetSearch/.test(panelSrc), 'TorrentPanel 没有接 useMagnetSearch —— 搜索与任务断了');
        const browseSrc = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        assert(/onNavigateToTorrent/.test(browseSrc), '地址栏没有磁力入口 onNavigateToTorrent');
        assert(/title="磁力下载"/.test(browseSrc), '地址栏没有"磁力下载"按钮');
        const appSrc = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
        assert(/'torrent'/.test(appSrc), 'App 的 ViewMode 没有 torrent');
        assert(/<TorrentPanel onBack/.test(appSrc), 'App 没有挂载 TorrentPanel');
        assert(/onNavigateToTorrent=\{openTorrentView\}/.test(appSrc), 'App 没有把入口传给 BrowsePanel');
    });

    /* ====================================================================== */

    if (fails.length > 0) {
        console.log(`浏览器外壳：通过 ${pass} 项，失败 ${fails.length} 项`);
        for (const f of fails) console.log(`  FAIL  ${f.name}\n          ${f.message}`);
        return false;
    }
    console.log(`浏览器外壳：通过 ${pass} 项，失败 0 项`);
    return true;
};

module.exports = { run };
