'use strict';

/**
 * 浏览器外壳能力（主进程侧）。
 *
 * ============================================================================
 * 为什么这一层必须待在主进程
 * ============================================================================
 *
 * 官方文档对 `<webview>` 写得很直白：
 *
 *   "You can not add keyboard, mouse, and scroll event listeners to webview"
 *
 * webview 是 Chromium 的跨进程 OOPIF，焦点一旦进入页面，键盘与滚轮事件
 * **根本不冒泡到宿主页面的 window**。所以：
 *
 *   - 浏览器级快捷键只能在 `webContents.on('before-input-event')` 里拦。
 *     写在渲染层 window.addEventListener('keydown') 里，用户点进页面就全部
 *     静默失效 —— 看起来像"没做"，实际是事件根本送不到。
 *   - 右键菜单（context-menu）、会话权限（setPermissionRequestHandler）、
 *     网页自身触发的下载（will-download）同理，只有主进程有这些入口。
 *
 * 反过来，`findInPage` / `setZoomLevel` / `setAudioMuted` / `insertCSS` 这些
 * 方法 **webview 元素上就有**，渲染层直接调即可，不必绕 IPC。
 *
 * 判据：**必须"在页面收到事件之前"截断的，进主进程；能对 webview 元素发起
 * 调用的，留在渲染层。**
 *
 * ============================================================================
 * 本模块的边界
 * ============================================================================
 *
 * 这里只放"纯判据 + Electron API 接线"：
 *
 *   - 判据部分（resolveBrowserShortcut / decidePermission /
 *     buildContextMenuTemplate / snapshotDownload …）
 *     全是纯函数，不碰 Electron，可以被 test/ 直接 require 求值；
 *   - 接线部分（attachGuestExtras / setupBrowserSession / setupBrowserIpc）
 *     只做事件挂载与转发，不含策略。
 *
 * **导航失败归类与缩放换算不在这里** —— 它们的消费方是渲染层，所以住在
 * services/BrowserService（TS，可单测）。判据两边各写一份的症状是
 * "同一个错误在日志里和界面上叫两个名字"，不报错、不崩溃，只是对不上号。
 *
 * **不 require main.js**：主进程入口会 require 本模块，反向依赖会形成循环 ——
 * 而循环 require 只会 warning 不报错，症状是"进程正常启动、第一次用到才炸
 * xxx is not a function"，错误信息完全指不到真正原因。需要窗口时一律由
 * 调用方把 getter 传进来。
 */

const { Menu, clipboard, shell, app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

/* ========================================================================== */
/*                                浏览器动作表                                  */
/* ========================================================================== */

/**
 * 由**键盘**触发的浏览器动作。
 *
 * 这些是 resolveBrowserShortcut 的取值域，也是唯一需要 preventDefault 的一批 ——
 * 拦下来是不让页面也收到这个按键。
 */
const BROWSER_KEY_ACTIONS = [
    // 标签页
    'newTab', 'closeTab', 'reopenTab', 'nextTab', 'prevTab', 'selectTabIndex', 'lastTab',
    // 地址与导航
    'focusAddressBar', 'reload', 'hardReload', 'stop', 'back', 'forward', 'home',
    // 页面能力
    'find', 'findNext', 'findPrev', 'escape',
    'zoomIn', 'zoomOut', 'zoomReset',
    // 其它
    'toggleBookmark', 'toggleDevTools',
    // Agent 工作区：界面层动作（渲染层只转发给面板）。按键仍要 preventDefault ——
    // Ctrl+K 在页面里没有对应功能，不拦的话页面会收到一个无意义的组合键
    'focusAgentInput',
];

/**
 * 由**右键菜单**触发的浏览器动作。
 *
 * 同样要下发到渲染层，但不由按键产生，所以没有"要不要拦按键"这个问题。
 */
const BROWSER_MENU_ACTIONS = [
    'analyzeElement', 'openInBackgroundTab', 'searchSelection',
];

/**
 * 主进程**主动推送**的状态变更（不是用户操作，是 webContents 事件）。
 *
 * 它们也必须被渲染层认得 —— 所以和上面两批一起构成完整的动作表。
 * 单独列出来是因为它们**不经过 preventDefault 那条路径**：
 * 早先把它们混在一起时，"每个动作都该被 preventDefault"这条断言
 * 会对 audibleChanged 误报，于是有人给它加了个豁免 —— 而豁免本身就是
 * "这张表混了两种东西"的信号。分开列之后两个类别各自自洽。
 */
const BROWSER_PUSH_ACTIONS = [
    'audibleChanged',
];

/**
 * 主进程能下发的**全部**浏览器动作。
 *
 * **这张表是主进程与渲染层的契约**，两边各有一份（这边是 JS 数组，
 * meta/interface.ts 那边是 TS 联合类型）。两份漂移的症状是"按了没反应"——
 * 渲染层收到一个自己不认识的动作名，只能静默忽略。所以有一处静态断言
 * 逐字比对这两份清单（test/browser.test.js）。
 *
 * 由三个子表拼成，而不是手写一个平铺列表：分类本身是有意义的
 * （要不要拦按键、是不是用户操作），拼起来又保证了不会漏。
 */
const BROWSER_ACTIONS = [
    ...BROWSER_KEY_ACTIONS,
    ...BROWSER_MENU_ACTIONS,
    ...BROWSER_PUSH_ACTIONS,
];

/** 允许连发（按住不放）的动作。其余动作在 isAutoRepeat 时直接丢弃 */
const REPEATABLE_ACTIONS = new Set(['zoomIn', 'zoomOut', 'nextTab', 'prevTab', 'findNext', 'findPrev']);

/**
 * 动作是否需要 preventDefault。
 *
 * `Escape` 是唯一一个**不拦**的：页面自己也常用 Esc（关弹窗、退出 HTML5
 * 全屏），而主进程此刻还不知道渲染层要不要用它（查找条开着吗？在加载吗？）。
 * 硬吞掉会把页面的 Esc 弄坏，所以只通知、不拦截，由渲染层自行决定用不用。
 * 这是相对 Chrome 的一处有意偏差，也是这张表里唯一一条例外。
 */
const shouldPreventDefault = (action) => action !== 'escape';

/* ========================================================================== */
/*                                  快捷键                                     */
/* ========================================================================== */

/**
 * 把 Electron 的 Input 事件翻译成浏览器动作。
 *
 * 只处理 `keyDown`；`keyUp` 一律返回 null（否则每个组合键会触发两次）。
 *
 * `Escape` 是唯一一个**不下发 preventDefault** 的动作：页面自己也常用 Esc
 * （关自己的弹窗、退出 HTML5 全屏），主进程此刻还不知道渲染层要不要用它
 * （查找条开着吗？在加载吗？）。硬吞掉会把页面的 Esc 弄坏，所以只通知、
 * 不拦截，由渲染层自行决定用不用。这是相对 Chrome 的一处有意偏差。
 *
 * @param {Electron.Input} input before-input-event 的事件对象
 * @returns {{ action: string, arg?: any } | null}
 */
function resolveBrowserShortcut(input) {
    if (!input || input.type !== 'keyDown') return null;

    /**
     * 输入法正在合成时一律放行。
     *
     * 中文/日文输入法开着的时候，按键要先给输入法处理。此刻拦下组合键会把
     * 输入法自己的操作抢走 —— 用户正在打「你好」，用 Ctrl+数字选候选词，
     * 结果标签页跳走了。
     *
     * 实测确认过这是真实可达的：未加这道守卫时，`isComposing: true` 的
     * Ctrl+T 会照常返回 `newTab`。而本应用的主要用户就在用中文输入法。
     */
    if (input.isComposing) return null;

    const key = String(input.key || '').toLowerCase();
    const ctrl = Boolean(input.control) || Boolean(input.meta); // Windows/Linux 用 Ctrl，macOS 用 Cmd
    const shift = Boolean(input.shift);
    const alt = Boolean(input.alt);

    let hit = null;

    if (ctrl && !alt) {
        switch (key) {
            case 't': hit = shift ? { action: 'reopenTab' } : { action: 'newTab' }; break;
            case 'w': case 'f4': hit = { action: 'closeTab' }; break;
            case 'tab': hit = { action: shift ? 'prevTab' : 'nextTab' }; break;
            case 'pagedown': hit = { action: 'nextTab' }; break;
            case 'pageup': hit = { action: 'prevTab' }; break;
            case 'l': hit = { action: 'focusAddressBar' }; break;
            case 'r': hit = { action: shift ? 'hardReload' : 'reload' }; break;
            case 'f': hit = { action: 'find' }; break;
            case 'g': hit = { action: shift ? 'findPrev' : 'findNext' }; break;
            case 'd': hit = { action: 'toggleBookmark' }; break;
            case 'k': hit = { action: 'focusAgentInput' }; break;
            case 'i': hit = shift ? { action: 'toggleDevTools' } : null; break;
            // Ctrl+= / Ctrl++ / Ctrl+Shift+= 都给 '+'，归一到放大；Ctrl+- / Ctrl+_ 归一缩小
            case '=': case '+': hit = { action: 'zoomIn' }; break;
            case '-': case '_': hit = { action: 'zoomOut' }; break;
            case '0': hit = { action: 'zoomReset' }; break;
            default:
                // Ctrl+1..8 = 第 n 个标签页，Ctrl+9 = 最后一个（与 Chrome 一致）
                if (/^[1-9]$/.test(key)) {
                    hit = key === '9'
                        ? { action: 'lastTab' }
                        : { action: 'selectTabIndex', arg: Number(key) - 1 };
                }
                break;
        }
    } else if (alt && !ctrl) {
        if (key === 'arrowleft') hit = { action: 'back' };
        else if (key === 'arrowright') hit = { action: 'forward' };
        else if (key === 'd') hit = { action: 'focusAddressBar' };
        else if (key === 'home') hit = { action: 'home' };
    } else if (!ctrl && !alt) {
        switch (key) {
            case 'f5': hit = { action: shift ? 'hardReload' : 'reload' }; break;
            case 'f3': hit = { action: shift ? 'findPrev' : 'findNext' }; break;
            case 'f6': hit = { action: 'focusAddressBar' }; break;
            case 'f12': hit = { action: 'toggleDevTools' }; break;
            case 'escape': hit = { action: 'escape' }; break;
            default: break;
        }
    }

    if (!hit) return null;
    if (input.isAutoRepeat && !REPEATABLE_ACTIONS.has(hit.action)) return null;
    return hit;
}

/* ========================================================================== */
/*                                 会话权限                                    */
/* ========================================================================== */

/**
 * 默认**允许**的权限。
 *
 * 判据是"这个权限会不会让页面碰到用户的设备或隐私"。不在这个名单里的一律拒绝。
 *
 * 为什么不能沿用 Electron 的默认（全部自动允许）：那意味着任何被打开的页面
 * 调一次 getUserMedia 就能开摄像头，而且**全程没有任何提示**。这是个真实的
 * 隐私洞，不是理论风险。
 *
 * 为什么也不能反过来全拒：`persistent-storage` 拒了 IndexedDB 会被清、
 * `storage-access` 拒了第三方登录态会断、`fullscreen` 拒了播放器全屏按钮失效。
 * 这些是这个应用真正要用的站点能力。
 *
 * 本应用自身**不用**任何需要授权的 API（实测 getUserMedia / mediaDevices /
 * Notification / getDisplayMedia 在源码里命中数均为 0），所以这份名单只影响
 * webview 里的第三方站点。
 */
const ALLOWED_PERMISSIONS = new Set([
    'fullscreen',                    // 播放器全屏按钮
    'automatic-fullscreen',
    'pointerLock',                   // 网页播放器的光标锁定；Esc 可解，且跑不出 webview
    'persistent-storage',            // 不批的话 IndexedDB 随时可能被清
    'storage-access',                // 第三方 Cookie 分区放行，登录态依赖它
    'top-level-storage-access',
    'background-sync',
    'background-fetch',
    'clipboard-sanitized-write',     // 只写不读，复制按钮用
    'screen-wake-lock',              // 看视频时别熄屏
    'system-wake-lock',
    'speaker-selection',
    'mediaKeySystem',                // EME/DRM 协商；Electron 不带 CDM，批了也是空转
]);

/** 权限的中文名，给日志与提示用 */
const PERMISSION_LABELS = {
    media: '摄像头 / 麦克风',
    'display-capture': '屏幕录制',
    'captured-surface-control': '屏幕内容控制',
    geolocation: '地理位置',
    'geolocation-approximate': '粗略地理位置',
    notifications: '系统通知',
    midi: 'MIDI 设备',
    midiSysex: 'MIDI 设备（系统独占）',
    hid: 'HID 设备',
    serial: '串口设备',
    usb: 'USB 设备',
    nfc: 'NFC',
    'smart-card': '智能卡',
    vr: 'VR 设备',
    ar: 'AR 设备',
    'hand-tracking': '手部追踪',
    'idle-detection': '空闲状态检测',
    'local-fonts': '本机字体列表',
    'window-management': '窗口管理',
    keyboardLock: '键盘独占',
    'clipboard-read': '读取剪贴板',
    'deprecated-sync-clipboard-read': '读取剪贴板（同步）',
    openExternal: '打开外部程序',
    'web-app-installation': '安装为应用',
    'payment-handler': '支付处理',
    'web-printing': '直接调用打印机',
    'local-network': '本地网络',
    'local-network-access': '本地网络',
    'loopback-network': '回环网络',
    'periodic-background-sync': '后台周期同步',
};

/**
 * 权限判据。**唯一一份**：request 与 check 两个 handler 都调它。
 *
 * Electron 文档明确写着 "you must also implement setPermissionCheckHandler to
 * get complete permission handling" —— 只挂 request 的话，一部分 API 走的是
 * check 那条路（先查后请），判定就会漏。
 */
function decidePermission(permission) {
    const name = String(permission || 'unknown');
    if (ALLOWED_PERMISSIONS.has(name)) {
        return { allow: true, permission: name, label: PERMISSION_LABELS[name] || name, sensitive: false };
    }
    return {
        allow: false,
        permission: name,
        label: PERMISSION_LABELS[name] || name,
        // 有中文名的才是我们"认得并主动拒绝"的敏感权限；'unknown' 之类不算
        sensitive: Boolean(PERMISSION_LABELS[name]),
    };
}

/* ========================================================================== */
/*                                 webview 校验                                */
/* ========================================================================== */

/** webview 允许加载的协议。白名单而不是黑名单：漏一个未知协议就等于开一个洞 */
const ALLOWED_WEBVIEW_SCHEMES = new Set(['http:', 'https:', 'file:', 'data:', 'blob:', 'about:']);

/**
 * `will-attach-webview` 的校验判据。
 *
 * webview 活在 DOM 里，**页面脚本可以自己创建一个**。Electron 默认会继承宿主
 * 的安全设置，但 `webPreferences` 是可以被逐个 webview 覆盖的 —— 所以要在
 * attach 之前把危险的项剥掉。
 *
 * 注意这里**不是**站点白名单：这个应用的用途就是让用户去任意站点，
 * 按域名限制会把功能直接锁死。限制的是"能不能拿到更高权限"。
 *
 * @returns {{ ok: boolean, reason?: string, stripped: string[] }}
 */
function reviewWebviewPreferences(webPreferences, params) {
    const stripped = [];
    if (!webPreferences || typeof webPreferences !== 'object') {
        return { ok: true, stripped };
    }

    // preload 是权限最高的一项：它拿到的是 Node 全量能力
    if (webPreferences.preload) {
        delete webPreferences.preload;
        stripped.push('preload');
    }
    if (webPreferences.nodeIntegration) {
        webPreferences.nodeIntegration = false;
        stripped.push('nodeIntegration');
    }
    if (webPreferences.nodeIntegrationInSubFrames) {
        webPreferences.nodeIntegrationInSubFrames = false;
        stripped.push('nodeIntegrationInSubFrames');
    }
    if (webPreferences.contextIsolation === false) {
        webPreferences.contextIsolation = true;
        stripped.push('contextIsolation');
    }
    if (webPreferences.webSecurity === false) {
        delete webPreferences.webSecurity;
        stripped.push('webSecurity');
    }
    if (webPreferences.allowRunningInsecureContent) {
        webPreferences.allowRunningInsecureContent = false;
        stripped.push('allowRunningInsecureContent');
    }
    // 历史遗留的高危项：旧版 Electron 的 webview 允许它们，开启等于把 Node 能力
    // 直接递给页面脚本（与 nodeIntegration 同级风险）。默认即关闭，显式开启才剥。
    if (webPreferences.nodeIntegrationInWorker) {
        webPreferences.nodeIntegrationInWorker = false;
        stripped.push('nodeIntegrationInWorker');
    }
    if (webPreferences.enableRemoteModule) {
        webPreferences.enableRemoteModule = false;
        stripped.push('enableRemoteModule');
    }
    // 默认关闭、开起来只会扩大攻击面的能力。页面脚本可以自建 webview 并
    // 在 webpreferences 串里带上这些，显式开启才剥 —— 正常站点用不到它们。
    if (webPreferences.plugins) {
        webPreferences.plugins = false;
        stripped.push('plugins');
    }
    if (webPreferences.experimentalFeatures) {
        webPreferences.experimentalFeatures = false;
        stripped.push('experimentalFeatures');
    }
    if (webPreferences.enableBlinkFeatures) {
        delete webPreferences.enableBlinkFeatures;
        stripped.push('enableBlinkFeatures');
    }

    const src = String((params && params.src) || '');
    if (src) {
        let scheme = '';
        try {
            scheme = new URL(src).protocol;
        } catch (_e) {
            // 解析不了（相对地址、畸形串）一律拒绝，不猜
            return { ok: false, reason: '地址无法解析', stripped };
        }
        if (!ALLOWED_WEBVIEW_SCHEMES.has(scheme)) {
            return { ok: false, reason: '不允许的协议 ' + scheme, stripped };
        }
    }

    return { ok: true, stripped };
}

/* ========================================================================== */
/*                                  下载记录                                   */
/* ========================================================================== */

/** 保留的下载记录条数。再多也没有翻的意义，而每条都持有 DownloadItem 引用 */
const DOWNLOAD_HISTORY_MAX = 100;

/** 进度推送节流：DownloadItem 的 updated 事件密到每几毫秒一次，直推会把 IPC 打满 */
const DOWNLOAD_PROGRESS_INTERVAL_MS = 250;

/**
 * 生成不覆盖已有文件的保存路径。
 *
 * 浏览器不会问你"要不要覆盖"，它会存成 `名字 (1).ext` —— 直接覆盖用户
 * 上一次的下载是不可接受的。同名文件超过 9999 个才放弃编号（极端情况）。
 */
function uniqueSavePath(dir, filename) {
    const safeName = String(filename || 'download');
    const ext = path.extname(safeName);
    const base = ext ? safeName.slice(0, safeName.length - ext.length) : safeName;

    let candidate = path.join(dir, safeName);
    let n = 1;
    while (fs.existsSync(candidate) && n <= 9999) {
        candidate = path.join(dir, base + ' (' + n + ')' + ext);
        n += 1;
    }
    // 同名文件超过 9999 个时上面的编号已耗尽：此时 candidate 仍然存在，
    // 直接返回会覆盖用户已有文件。用时间戳后缀保证不覆盖。
    if (fs.existsSync(candidate)) {
        candidate = path.join(dir, base + ' (' + Date.now() + ')' + ext);
    }
    return candidate;
}

/** 文件名清洗：去掉路径分隔符与控制字符，避免写到下载目录之外 */
function sanitizeDownloadName(name) {
    let cleaned = String(name || '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return 'download';
    // Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）不能直接作文件名：
    // 落盘会失败并退回保存对话框。加前缀避开，扩展名保持不变。
    const ext = path.extname(cleaned);
    const base = ext ? cleaned.slice(0, cleaned.length - ext.length) : cleaned;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
        cleaned = '_' + cleaned;
    }
    // 过长文件名截断（保留扩展名，只截 base 到 100 字符）：
    // 超长在 setSavePath 才抛，之前过长的名字已经进了快照污染界面，
    // 而调用方的 catch 只会退回保存对话框 —— 用户要手动改名。
    const LONG_EXT = path.extname(cleaned);
    const LONG_BASE = LONG_EXT ? cleaned.slice(0, cleaned.length - LONG_EXT.length) : cleaned;
    if (LONG_BASE.length > 100) {
        cleaned = LONG_BASE.slice(0, 100) + LONG_EXT;
    }
    // Windows 不允许末尾的点与空格（会被静默截掉，导致重名判断错位）
    const loneDotExt = ext === '.';
    const effectiveExt = loneDotExt ? '' : ext;
    const base2 = effectiveExt ? cleaned.slice(0, cleaned.length - effectiveExt.length) : cleaned;
    const trimmedBase = base2.replace(/[. ]+$/, '') || 'download';
    return trimmedBase + effectiveExt || 'download';
}

/**
 * DownloadItem → 可跨 IPC 传输的快照。
 *
 * **必须剔除 item 本身**：它是 Electron 对象，塞进 IPC 会直接抛
 * "An object could not be cloned"。所有字段都当场取值，不保留引用。
 */
function snapshotDownload(record) {
    const now = Date.now();
    const elapsed = Math.max(1, (record.endedAt || now) - record.startedAt);
    const avgSpeed = record.receivedBytes / (elapsed / 1000);

    return {
        id: record.id,
        filename: record.filename,
        savePath: record.savePath,
        url: record.url,
        mimeType: record.mimeType,
        totalBytes: record.totalBytes,
        receivedBytes: record.receivedBytes,
        percent: record.totalBytes > 0
            ? Math.min(100, Math.round((record.receivedBytes / record.totalBytes) * 100))
            : -1,
        state: record.state,
        paused: record.paused,
        canResume: record.canResume,
        speed: record.state === 'progressing' && !record.paused ? Math.round(avgSpeed) : 0,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
    };
}

/* ========================================================================== */
/*                                  右键菜单                                   */
/* ========================================================================== */

/**
 * 构建右键菜单的**模板**（纯数据，不碰 Electron）。
 *
 * 之所以拆成"模板"而不是直接建 Menu：`new Menu()` 在纯 Node 下拿不到
 * （require('electron') 在非 Electron 进程里返回的是二进制路径字符串），
 * 拆开之后这张菜单的每一项、每一处 enabled 判据都能在单测里直接断言。
 * 真正 `Menu.buildFromTemplate` 只在 popupContextMenu 里做一次。
 *
 * @param {object} ctx
 * @param {Electron.ContextMenuParams} ctx.params
 * @param {boolean} ctx.isGuest        是不是 webview 里的页面（宿主页面要用另一套）
 * @param {boolean} ctx.canGoBack
 * @param {boolean} ctx.canGoForward
 * @param {object}  ctx.handlers       各项的回调，缺哪项就不生成哪项
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function buildContextMenuTemplate(ctx) {
    const params = ctx.params || {};
    const h = ctx.handlers || {};
    const items = [];
    const sep = () => {
        // 连续两个分隔符没有意义，末尾的分隔符也没有
        if (items.length === 0) return;
        if (items[items.length - 1].type === 'separator') return;
        items.push({ type: 'separator' });
    };
    const add = (item) => items.push(item);
    const trimEnd = () => {
        while (items.length > 0 && items[items.length - 1].type === 'separator') items.pop();
    };

    /* ------------------------------ 链接 ------------------------------ */
    if (params.linkURL) {
        if (h.openLink) {
            add({ label: '在新标签页中打开链接', click: () => h.openLink(params.linkURL, 'foreground-tab') });
            add({ label: '在后台标签页中打开链接', click: () => h.openLink(params.linkURL, 'background-tab') });
        }
        if (h.saveLink) add({ label: '链接另存为…', click: () => h.saveLink(params.linkURL) });
        sep();
        if (h.copyText) add({ label: '复制链接地址', click: () => h.copyText(params.linkURL) });
        if (params.linkText && h.searchText) {
            const text = String(params.linkText).slice(0, 24);
            add({ label: '搜索「' + text + '」', click: () => h.searchText(params.linkText) });
        }
        sep();
    }

    /* ------------------------------ 媒体 ------------------------------ */
    // 带链接的图片/视频同样要给媒体项（在新标签页中打开图片、图片另存为…）：
    // 之前用 !linkURL 整体跳过，右键点"带链接的图片"时只能存链接存不下图。
    // srcURL 与 linkURL 不同时才展开，避免纯链接被重复刷两遍打开项。
    if (params.mediaType && params.mediaType !== 'none') {
        const kind = params.mediaType === 'image' ? '图片'
            : params.mediaType === 'video' ? '视频'
                : params.mediaType === 'audio' ? '音频'
                    : params.mediaType === 'canvas' ? '画布' : '媒体';
        // src 与链接同地址时不重复展开（存链接与存媒体效果相同，避免刷两遍）
        if (params.srcURL && params.srcURL !== params.linkURL) {
            if (h.openLink) add({ label: '在新标签页中打开' + kind, click: () => h.openLink(params.srcURL, 'foreground-tab') });
            if (h.saveMedia) add({ label: kind + '另存为…', click: () => h.saveMedia(params.srcURL) });
            sep();
            if (h.copyText) add({ label: '复制' + kind + '地址', click: () => h.copyText(params.srcURL) });
            sep();
        }
    }

    /* ---------------------------- 可编辑区域 ---------------------------- */
    if (params.isEditable) {
        const flags = params.editFlags || {};
        const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : [];
        if (params.misspelledWord && suggestions.length > 0 && h.replaceMisspelling) {
            for (const word of suggestions.slice(0, 5)) {
                add({ label: word, click: () => h.replaceMisspelling(word) });
            }
            sep();
        }
        if (h.edit) {
            add({ label: '撤销', enabled: Boolean(flags.canUndo), click: () => h.edit('undo') });
            add({ label: '重做', enabled: Boolean(flags.canRedo), click: () => h.edit('redo') });
            sep();
            add({ label: '剪切', enabled: Boolean(flags.canCut), click: () => h.edit('cut') });
            add({ label: '复制', enabled: Boolean(flags.canCopy), click: () => h.edit('copy') });
            add({ label: '粘贴', enabled: Boolean(flags.canPaste), click: () => h.edit('paste') });
            add({ label: '删除', enabled: Boolean(flags.canDelete), click: () => h.edit('delete') });
            sep();
            add({ label: '全选', enabled: Boolean(flags.canSelectAll), click: () => h.edit('selectAll') });
        }
        sep();
    } else if (params.selectionText) {
        if (h.copyText) add({ label: '复制', click: () => h.copyText(params.selectionText) });
        if (h.searchText) {
            const text = String(params.selectionText).slice(0, 24);
            add({ label: '搜索「' + text + '」', click: () => h.searchText(params.selectionText) });
        }
        sep();
    }

    /* ---------------------------- 空白处：页面级 ---------------------------- */
    if (ctx.isGuest) {
        const nothingAbove = items.length === 0;
        if (nothingAbove && h.navigate) {
            add({ label: '后退', enabled: Boolean(ctx.canGoBack), click: () => h.navigate('back') });
            add({ label: '前进', enabled: Boolean(ctx.canGoForward), click: () => h.navigate('forward') });
            add({ label: '重新加载', click: () => h.navigate('reload') });
            sep();
        }
        // 「让 Agent 分析这个元素」是本项目独有的入口：把右键命中的那个元素
        // 变成一个可直接执行的选择器，填进 Agent 输入框。放在检查元素**之上** ——
        // 它是这个应用里更常用的那个动作。
        if (h.analyzeElement) {
            add({ label: '让 Agent 分析这个元素', click: () => h.analyzeElement(params.x, params.y) });
        }
        if (h.inspect) add({ label: '检查元素', click: () => h.inspect() });
    } else if (h.inspect) {
        // 宿主页面（Agent 面板、地址栏）也给检查元素，但**不给**后退/刷新 ——
        // 那会重载整个应用，而不是当前标签页
        if (items.length === 0) {
            add({ label: '重新加载界面', click: () => h.reloadHost() });
        }
        add({ label: '检查元素', click: () => h.inspect() });
    }

    trimEnd();
    return items;
}

/* ========================================================================== */
/*                              运行时状态（模块级）                             */
/* ========================================================================== */

/** 已挂过 before-input-event / context-menu 的 webContents，避免重复挂载 */
const attachedContents = new WeakSet();

/** 已挂过 audio-state-changed 的 webContents。与 attachedContents 分开记账，见 attachGuestExtras */
const audibleWatched = new WeakSet();

/** 已挂过 will-download / 权限 handler 的 session */
const preparedSessions = new WeakSet();

/** 下载记录：id → record（record.item 是 DownloadItem，只在主进程内用） */
const downloadRecords = new Map();
let downloadSeq = 0;

/**
 * 已分配但尚未落盘的保存路径。
 *
 * `uniqueSavePath` 只看"磁盘上有没有"，两次 will-download 紧挨着进来时
 * 两边都看不到对方（上一个还没写出任何字节），会拿到同一个 candidate，
 * 后落盘的覆盖先落盘的。JS 单线程让"查预留→占预留"天然原子，
 * 所以分配即占位、终结即释放就能堵住这个竞态。
 */
const reservedSavePaths = new Set();

/** 上一次推送进度的时间，用于节流 */
const lastProgressAt = new Map();

let browserIpcReady = false;

/** 由 main.js 注入：取当前窗口（下载进度、命令下发都要往它发） */
let windowGetter = () => null;

/* ========================================================================== */
/*                                  接线                                       */
/* ========================================================================== */

/** 往渲染层发一条浏览器命令 */
function sendCommand(payload, webContents) {
    // isDestroyed 检查与 send 之间窗口可能被销毁（下载中关窗、shutdown 间隙的
    // audio-state-changed），裸调会把异常抛进事件发射器。helper 内部兜住。
    try {
        const win = windowGetter();
        if (!win || win.isDestroyed()) return;
        // 带上来源 webContents 的 id：渲染层据此把命令路由到**发出它的那个标签页**，
        // 而不是一律当成"当前标签页"。发声状态这类异步推送尤其需要它 ——
        // 后台标签页开始放音频时，当前标签页根本没变。
        win.webContents.send('browser-command', {
            ...payload,
            webContentsId: webContents && !webContents.isDestroyed() ? webContents.id : 0,
        });
    } catch (error) {
        console.error('browser-command 下发失败:', error);
    }
}

/** 往渲染层发一条下载快照 */
function sendDownload(snapshot) {
    try {
        const win = windowGetter();
        if (!win || win.isDestroyed()) return;
        win.webContents.send('browser-download', snapshot);
    } catch (error) {
        console.error('browser-download 下发失败:', error);
    }
}

/**
 * 会话级浏览器能力：下载拦截 + 权限策略。
 *
 * **必须挂到每一个会用到的 session 上**。`<webview>` 默认继承宿主窗口的
 * session，所以只挂主窗口那次"恰好能用"；一旦有人给 webview 加 partition
 * （独立 session），下载会绕过记录、权限会退回 Electron 的默认全允许 ——
 * 而这两件事都不会报错。用 WeakSet 记账保证幂等（重复挂会叠加监听）。
 *
 * 注意 `will-download` 是普通 EventEmitter 的 `on`（**会叠加**），
 * 而 `setPermissionRequestHandler` 是 setter（**会替换**）。两种语义不同，
 * 但都需要"只生效一次"，所以共用同一个 WeakSet。
 */
function setupBrowserSession(sess) {
    if (!sess || preparedSessions.has(sess)) return;
    preparedSessions.add(sess);

    sess.on('will-download', (event, item, webContents) => {
        try {
            beginDownload(item, webContents);
        } catch (error) {
            console.error('will-download 处理失败:', error);
        }
    });

    const onPermissionRequest = (webContents, permission, callback) => {
        const decision = decidePermission(permission);
        if (!decision.allow && decision.sensitive) {
            // 拒绝要留痕：站点功能静默失效时，用户至少能从主进程日志里看到原因
            console.warn('已拒绝权限请求:', decision.permission, decision.label);
        }
        callback(decision.allow);
    };

    const onPermissionCheck = (_webContents, permission) => decidePermission(permission).allow;

    sess.setPermissionRequestHandler(onPermissionRequest);
    sess.setPermissionCheckHandler(onPermissionCheck);
}

/**
 * 开始记录一次网页下载。
 *
 * 保存路径**不问用户**（Chrome 也是直接存进下载目录）——弹保存对话框会让
 * "点一下链接"变成一次打断。同名文件自动编号，绝不覆盖。
 */
function beginDownload(item, webContents) {
    downloadSeq += 1;
    const id = 'dl-' + downloadSeq;

    const rawName = sanitizeDownloadName(item.getFilename());
    let savePath = '';
    try {
        savePath = uniqueSavePath(app.getPath('downloads'), rawName);
        if (reservedSavePaths.has(savePath)) {
            // 并发同名：上一个已分配但还没落盘，existsSync 看不到它。
            // 序号+时间戳双保险（同一毫秒内两次并发只靠时间戳仍会撞）。
            const dir = app.getPath('downloads');
            const dupExt = path.extname(rawName);
            const dupBase = dupExt ? rawName.slice(0, rawName.length - dupExt.length) : rawName;
            savePath = path.join(dir, dupBase + ' (' + Date.now() + '-' + downloadSeq + ')' + dupExt);
        }
        item.setSavePath(savePath);
        reservedSavePaths.add(savePath);
    } catch (error) {
        // 设不上就退回 Electron 的默认流程（弹保存对话框），至少不会丢文件
        console.error('设置下载路径失败，改用默认流程:', error);
        savePath = '';
    }

    const record = {
        id,
        item,
        filename: rawName,
        savePath,
        url: item.getURL(),
        mimeType: item.getMimeType(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        state: 'progressing',
        paused: false,
        canResume: false,
        startedAt: Date.now(),
        endedAt: 0,
        // 已被移除的记录：监听闭包还在，updated/done 回来时必须跳过推送，
        // 否则渲染层 upsert 会把删掉的下载"复活"回列表顶部。
        disposed: false,
    };

    downloadRecords.set(id, record);
    pruneDownloadRecords();
    sendDownload(snapshotDownload(record));

    item.on('updated', (_event, state) => {
        if (record.disposed) return;
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        record.paused = item.isPaused();
        record.canResume = item.canResume();
        record.state = state === 'interrupted' ? 'interrupted' : 'progressing';

        // 节流：updated 密到每几毫秒一次，逐条直推会把 IPC 与渲染层一起打满
        const now = Date.now();
        const last = lastProgressAt.get(id) || 0;
        if (now - last < DOWNLOAD_PROGRESS_INTERVAL_MS) return;
        lastProgressAt.set(id, now);
        sendDownload(snapshotDownload(record));
    });

    item.once('done', (_event, state) => {
        lastProgressAt.delete(id);
        if (record.disposed) return;
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        // 首个 updated 之前就失败/中断的下载，canResume 还停在初始 false，
        // 即使服务端支持 Range 界面也会显示"无法继续"。收尾时刷新一次。
        try { record.canResume = item.canResume(); } catch (_e) { /* 保持旧值 */ }
        record.state = state;
        record.paused = false;
        record.endedAt = Date.now();
        // 落盘（或终结）后预留即释放：之后同名下载靠 existsSync 避让，不再占集合
        if (record.savePath) reservedSavePaths.delete(record.savePath);
        sendDownload(snapshotDownload(record));
    });
}

/** 记录数封顶，防止长时间挂着不断堆积 */
function pruneDownloadRecords() {
    if (downloadRecords.size <= DOWNLOAD_HISTORY_MAX) return;
    const ordered = [...downloadRecords.values()].sort((a, b) => a.startedAt - b.startedAt);
    const drop = ordered.slice(0, downloadRecords.size - DOWNLOAD_HISTORY_MAX);
    for (const record of drop) {
        // 进行中/中断的不摘：监听闭包还活着，摘了旧推送会把记录"复活"，
        // 而且中断的恢复还要写回原路径。只摘终结的。
        if (record.state === 'progressing' || record.state === 'interrupted') continue;
        if (record.savePath) reservedSavePaths.delete(record.savePath);
        downloadRecords.delete(record.id);
    }
}

/** 全部下载快照，新的在前 */
function listDownloads() {
    return [...downloadRecords.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(snapshotDownload);
}

/** 对某条下载执行操作 */
async function actOnDownload(id, action) {
    const record = downloadRecords.get(String(id || ''));
    if (!record) return { success: false, message: '找不到这条下载记录' };

    const item = record.item;
    try {
        switch (action) {
            case 'pause':
                if (!item.isPaused()) item.pause();
                record.paused = true;
                break;
            case 'resume':
                // 服务器不支持断点续传时 canResume 为 false：此时 resume() 是空操作，
                // 若仍按成功返回并把 paused 置 false，界面会显示"下载中"而实际卡死。
                if (!item.canResume()) {
                    return { success: false, message: '服务器不支持断点续传，无法继续' };
                }
                item.resume();
                record.paused = false;
                break;
            case 'cancel':
                item.cancel();
                break;
            case 'reveal':
                if (record.savePath && fs.existsSync(record.savePath)) {
                    shell.showItemInFolder(record.savePath);
                } else {
                    return { success: false, message: '文件还没落盘' };
                }
                break;
            case 'open':
                if (record.savePath && fs.existsSync(record.savePath)) {
                    await shell.openPath(record.savePath);
                } else {
                    return { success: false, message: '文件还没落盘' };
                }
                break;
            case 'remove':
                // 只摘记录不 cancel：下载本身继续在后台写文件（与 Chrome 的
                // "从列表中移除"一致）。打 disposed 标记让后续 updated/done
                // 跳过推送，否则渲染层 upsert 会把它"复活"回列表。
                record.disposed = true;
                if (record.savePath) reservedSavePaths.delete(record.savePath);
                downloadRecords.delete(record.id);
                return { success: true };
            default:
                return { success: false, message: '未知操作 ' + String(action) };
        }
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : '操作失败' };
    }

    sendDownload(snapshotDownload(record));
    return { success: true };
}

/**
 * 弹出右键菜单。
 *
 * 菜单项由 buildContextMenuTemplate 生成（纯函数、可单测），这里只负责把
 * 各项接到真正的 Electron 能力上。`webContents` 是**触发菜单的那个**：
 * 对 webview 里的页面是 guest，对 Agent 面板是宿主页面，两者菜单不同。
 */
function popupContextMenu(webContents, params) {
    if (!webContents || webContents.isDestroyed()) return;

    const isGuest = webContents.getType() === 'webview';

    const handlers = {
        openLink: (url, disposition) => {
            if (disposition === 'background-tab') {
                sendCommand({ action: 'openInBackgroundTab', arg: { url } }, webContents);
                return;
            }
            // 前台打开复用既有的 navigate-to-url 通道：那条链路渲染层已经在用，
            // 再开一条只会多一处需要同步的地方
            const win = windowGetter();
            if (win && !win.isDestroyed()) win.webContents.send('navigate-to-url', url);
        },
        saveLink: (url) => { try { webContents.downloadURL(url); } catch (e) { console.error(e); } },
        saveMedia: (url) => { try { webContents.downloadURL(url); } catch (e) { console.error(e); } },
        copyText: (text) => clipboard.writeText(String(text || '')),
        searchText: (text) => sendCommand({ action: 'searchSelection', arg: { text: String(text || '') } }, webContents),
        edit: (command) => {
            try {
                if (typeof webContents[command] === 'function') webContents[command]();
            } catch (e) { console.error('编辑命令失败:', command, e); }
        },
        replaceMisspelling: (word) => {
            try { webContents.replaceMisspelling(word); } catch (e) { console.error(e); }
        },
        navigate: (action) => {
            // 走渲染层而不是直接 webContents.goBack()：标签页的 history/loading
            // 记账在渲染层，直接调会让两边状态漂移（按钮灰着但页面已经动了）
            // 带上来源 webContents：发声/分析类命令靠它按页路由，这里保持一致
            sendCommand({ action }, webContents);
        },
        reloadHost: () => {
            const win = windowGetter();
            if (win && !win.isDestroyed()) win.webContents.reload();
        },
        inspect: () => {
            try { webContents.inspectElement(params.x, params.y); } catch (e) { console.error(e); }
        },
        analyzeElement: (x, y) => sendCommand({ action: 'analyzeElement', arg: { x, y } }, webContents),
    };

    const template = buildContextMenuTemplate({
        params,
        isGuest,
        canGoBack: (() => { try { return webContents.canGoBack(); } catch (_e) { return false; } })(),
        canGoForward: (() => { try { return webContents.canGoForward(); } catch (_e) { return false; } })(),
        handlers,
    });

    if (template.length === 0) return;
    const menu = Menu.buildFromTemplate(template);
    const win = BrowserWindow.fromWebContents(webContents);
    menu.popup(win ? { window: win } : undefined);
}

/**
 * 给一个 webContents 挂上浏览器级输入处理。
 *
 * **两个挂载点缺一不可**：
 *  - 宿主窗口（React 应用）：焦点在地址栏 / Agent 输入框时，快捷键也要生效；
 *  - 每个 webview 的 guest：焦点在页面里时，只有它能收到键盘事件。
 *
 * 只挂宿主 → 用户点进页面后所有快捷键失效；只挂 guest → 地址栏里按 Ctrl+T
 * 没反应。这是本模块最容易漏的一处不对称。
 */
function attachBrowserInput(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    if (attachedContents.has(webContents)) return;
    attachedContents.add(webContents);

    webContents.on('before-input-event', (event, input) => {
        const hit = resolveBrowserShortcut(input);
        if (!hit) return;

        if (hit.action === 'toggleDevTools') {
            // F12 是"看这个页面的开发者工具"，不是"看应用的"。devtools 自己的
            // 窗口不该再被拦一次，否则在里面按 Ctrl+F 会去开浏览器的查找条
            if (webContents.getType() === 'devtools') return;
            try { webContents.toggleDevTools(); } catch (e) { console.error(e); }
            event.preventDefault();
            return;
        }

        if (shouldPreventDefault(hit.action)) event.preventDefault();
        sendCommand(hit, webContents);
    });

    webContents.on('context-menu', (_event, params) => {
        try {
            popupContextMenu(webContents, params);
        } catch (error) {
            console.error('右键菜单构建失败:', error);
        }
    });
}

/**
 * guest（webview 里的页面）额外需要的接线。
 *
 * `audio-state-changed` 只有 webContents 有，`<webview>` 元素**没有**对应的
 * addEventListener 事件 —— 元素上只有 media-started-playing / media-paused，
 * 而那两个判不出"静音的视频"与"有声的视频"。所以发声状态必须从这里推。
 */
function attachGuestExtras(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    attachBrowserInput(webContents);

    // 独立的记账集合，不能复用 attachedContents：那个集合在 attachBrowserInput
    // 里就被填上了，用它做守卫会让本函数**永远提前返回** ——
    // 症状是发声指示从来不亮，而快捷键一切正常，看起来完全不像是同一个 bug。
    if (audibleWatched.has(webContents)) return;
    audibleWatched.add(webContents);

    webContents.on('audio-state-changed', (event) => {
        sendCommand({
            action: 'audibleChanged',
            arg: { audible: Boolean(event && event.audible) },
        }, webContents);
    });
}

/**
 * 主进程入口调用一次：注册 IPC、把窗口 getter 注入进来。
 *
 * 所有 IPC 都集中在这里注册，且只注册一次（重复 handle 同一个通道会抛
 * "Attempted to register a second handler"）。
 */
function setupBrowserIpc(getWindow) {
    if (typeof getWindow === 'function') windowGetter = getWindow;
    if (browserIpcReady) return;
    browserIpcReady = true;

    const { ipcMain } = require('electron');

    ipcMain.handle('browser-downloads', async () => {
        try {
            return listDownloads();
        } catch (error) {
            // 与 action 通道对称：这里抛了渲染层会 hang 住等一个永远不来的列表
            console.error('读取下载列表失败:', error);
            return [];
        }
    });
    ipcMain.handle('browser-download-action', async (_event, payload) => {
        const id = payload && payload.id;
        const action = payload && payload.action;
        return actOnDownload(id, action);
    });
}

/** 宿主窗口的 will-attach-webview 校验。单独导出是因为它挂在 webContents 上而不是 session 上 */
function guardWebviewAttach(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    webContents.on('will-attach-webview', (event, webPreferences, params) => {
        const review = reviewWebviewPreferences(webPreferences, params);
        if (review.stripped.length > 0) {
            console.warn('webview 附着时剥离了高危配置:', review.stripped.join(', '));
        }
        if (!review.ok) {
            console.warn('已拦截 webview 附着:', review.reason, params && params.src);
            event.preventDefault();
        }
    });
}

module.exports = {
    // 常量
    BROWSER_ACTIONS,
    BROWSER_KEY_ACTIONS,
    BROWSER_MENU_ACTIONS,
    BROWSER_PUSH_ACTIONS,
    ALLOWED_PERMISSIONS,
    PERMISSION_LABELS,
    ALLOWED_WEBVIEW_SCHEMES,
    // 纯判据
    resolveBrowserShortcut,
    shouldPreventDefault,
    decidePermission,
    reviewWebviewPreferences,
    uniqueSavePath,
    sanitizeDownloadName,
    snapshotDownload,
    buildContextMenuTemplate,
    // 接线
    setupBrowserSession,
    setupBrowserIpc,
    attachBrowserInput,
    attachGuestExtras,
    guardWebviewAttach,
    popupContextMenu,
    listDownloads,
    actOnDownload,
};
