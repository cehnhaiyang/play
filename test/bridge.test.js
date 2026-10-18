'use strict';
/**
 * 桥契约的一致性测试。
 *
 * 这一套盯的是**拆分过程中最容易悄悄坏掉的东西**：某个功能归谁做。
 *
 * 判据是"归属表（shared/meta/bridge.ts）与主进程真实的 IPC 注册逐条对得上"：
 *
 *   1. 主进程注册了 handler，表里没有 → 有人加了端点没归类。
 *      这正是拆分期的典型事故：新端点随手写在 main.js 里，
 *      没人决定它是插件的还是应用的，最后两边都没实现。
 *
 *   2. 表里 route 是 app/split，主进程却没有 handler → 桥的目标不存在。
 *      插件会发一个永远没人接的请求，表现为"点了没反应"。
 *
 *   3. 已退役的通道名出现在插件里 → 半拆状态。插件实现了一个
 *      应用侧已经删掉的能力，或者还在监听一个永远不来的事件。
 *
 * 注意本套件**不**断言"extension 路由不得有 handler"：自建浏览器外壳
 * 尚未拆除，应用侧目前仍持有这些 handler。那条断言要等外壳删掉之后才成立，
 * 提前写进来只会让一套本来就该红的用例长期红着，最终被无视。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT, 'app', 'main');
const EXTENSION_SRC = path.join(ROOT, 'extension', 'src');

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

/** 递归列出目录下所有文件（跳过 node_modules 与构建产物） */
const walk = (dir) => {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
};

const run = () => {
    // 每次调用都重置计数：run() 会被同一进程调用多次（变异检查就是），
    // 计数留在模块级会让第二次调用把上一次的失败一起报出来。
    pass = 0;
    fails.length = 0;

    const bridge = require('./build/shared/meta/bridge');

    /**
     * 主进程真实注册的全部 handler 通道名。
     *
     * ## 为什么要把 `orb:` 排除在外
     *
     * 这套测试的前提是"主进程里的每一个 handler 都是桥端点" —— 那个前提在
     * 只有主窗口时成立。悬浮球加进来之后不再成立：球是一个**独立的
     * Electron 窗口**（见 app/main/orbs.js），它的窗口操作（拖动、展开、
     * 改尺寸）是**应用内部的窗口管理**，一个字节都不出应用，更不过桥。
     *
     * 把它们塞进 `BRIDGE_ENDPOINTS` 是错的 —— 那张表是"插件 ↔ 应用"的契约，
     * 而插件根本不知道球是个窗口、更不知道它怎么拖。
     *
     * 所以这里按命名空间排除，同时**反向断言**这些通道确实不出应用
     * （见下面"orb: 通道不得出现在插件里"）。只排除不反向检查的话，
     * 这个排除就成了一张可以随便往里塞东西的免检牌。
     */
    const ORB_PREFIX = 'orb:';
    const isLocalWindowChannel = (name) => name.startsWith(ORB_PREFIX);

    /** 主进程真实注册的全部 handler 通道名 */
    const registeredHandlers = new Set();
    /** 主进程真实推送的全部通道名 */
    const pushedChannels = new Set();

    for (const file of fs.readdirSync(ELECTRON_DIR).filter((f) => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(ELECTRON_DIR, file), 'utf8');
        for (const m of src.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) registeredHandlers.add(m[1]);
        for (const m of src.matchAll(/\.send\(\s*'([^']+)'/g)) pushedChannels.add(m[1]);
    }

    /* ====================================================================== */
    /* 1. 端点：表 ↔ 主进程注册，双向对齐                                       */
    /* ====================================================================== */

    check('端点表覆盖主进程注册的每一个 handler（无未归类端点）', () => {
        const unclassified = [...registeredHandlers]
            .filter((name) => !isLocalWindowChannel(name))
            .filter((name) => !(name in bridge.BRIDGE_ENDPOINTS));
        eq(unclassified.length, 0,
            `这些通道在主进程注册了但归属表里没有：${unclassified.join('、')}。`
            + '请在 shared/meta/bridge.ts 的 BRIDGE_ENDPOINTS 里归类。');
    });

    /**
     * route 为 app、但**故意不注册 ipcMain 通道**的端点。
     *
     * `sandbox` 在这里：它的调用方只有插件的 Agent，而能力是"写文件 + 跑本机命令"。
     * 主进程每注册一个通道，渲染层就多一个可调用的口；给一个没有调用方的口开通道，
     * 等于把执行面摊给用不上的地方。
     *
     * ⚠ 这条名单是上面那条断言的**免检牌**，代价与 `orb:` 那张一样：下面必须
     * 反向核对它确实有 `bridge.setRequestHandler` 的分派。否则"表里注册了端点、
     * 应用里谁都没接"就正好从这条免检里漏过去 —— 而那恰是这条断言原本要拦的事故。
     */
    const BRIDGE_ONLY_APP_ENDPOINTS = ['sandbox'];

    check('端点表里 app/split 路由都有真实 handler（无悬空目标）', () => {
        const exempt = new Set(BRIDGE_ONLY_APP_ENDPOINTS);
        const dangling = Object.entries(bridge.BRIDGE_ENDPOINTS)
            .filter(([name, meta]) => meta.route !== 'extension' && !exempt.has(name))
            .filter(([name]) => !registeredHandlers.has(name))
            .map(([name, meta]) => `${name}(${meta.route})`);
        eq(dangling.length, 0,
            `这些端点在表里归给应用，但主进程没有 handler：${dangling.join('、')}`);
    });

    /**
     * 免检名单的反向核对：列进来的端点必须真的被 `setRequestHandler` 分派。
     *
     * 认 `case '<name>'` 的形状，因为那份分派就是 switch。
     * 只免检不反查的话，这张名单就成了"我可以随便往里塞东西且不实现"的口子 ——
     * 症状与当年那个"注册了但没人监听"完全一致：插件发出去的请求等满超时，
     * 而没有任何一处代码是错的。
     */
    check('免检的桥专属端点必须有 setRequestHandler 分派', () => {
        const mainSrc = fs.readFileSync(path.join(ELECTRON_DIR, 'main.js'), 'utf8');
        const missing = BRIDGE_ONLY_APP_ENDPOINTS.filter((name) => !mainSrc.includes(`case '${name}'`));
        eq(missing.length, 0,
            `这些端点免检了 ipcMain 注册，但插件请求的分派里也没有它：${missing.join('、')}`);
        for (const name of BRIDGE_ONLY_APP_ENDPOINTS) {
            assert(!(name in bridge.BRIDGE_ENDPOINTS) || bridge.BRIDGE_ENDPOINTS[name].route === 'app',
                `免检名单里的 ${name} 不是 app 路由 —— 那张表按路由分岔，放错了等于绕过两条断言`);
        }
    });

    /*
     * orb: 通道只许留在应用内部。
     *
     * 上面对它们做了免检，这条就是那张免检牌的**代价条款**：如果哪天有人
     * 把球的窗口操作接到了插件上（比如让插件帮忙算窗口位置），这里必须报红
     * —— 那意味着一个纯本地窗口操作绕了半圈跨进程，而它本来不需要。
     */
    check('orb: 窗口通道不得出现在插件里', () => {
        const hits = [];
        for (const file of walk(EXTENSION_SRC)) {
            const src = fs.readFileSync(file, 'utf8');
            for (const name of [...registeredHandlers, ...pushedChannels]) {
                if (isLocalWindowChannel(name) && src.includes(name)) {
                    hits.push(`${path.relative(ROOT, file)} → ${name}`);
                }
            }
        }
        eq(hits.length, 0,
            `插件里出现了球的窗口通道：${hits.join('、')}。`
            + '那些是应用内部的窗口管理，插件不该知道球是个窗口。');
    });

    check('端点表没有重复分类（表内自洽）', () => {
        const names = Object.keys(bridge.BRIDGE_ENDPOINTS);
        eq(new Set(names).size, names.length, 'BRIDGE_ENDPOINTS 存在重复键');
        for (const [name, meta] of Object.entries(bridge.BRIDGE_ENDPOINTS)) {
            assert(['extension', 'app', 'split'].includes(meta.route), `${name} 的 route 非法：${meta.route}`);
            assert(typeof meta.reason === 'string' && meta.reason.length > 8,
                `${name} 缺少说明归属理由的 reason —— 没有理由的归类下次就会被随手改掉`);
        }
    });

    /* ====================================================================== */
    /* 2. 事件：表 ↔ 主进程推送，双向对齐                                       */
    /* ====================================================================== */

    check('事件表覆盖主进程推送的每一个通道（除已退役者）', () => {
        const unclassified = [...pushedChannels]
            .filter((name) => !isLocalWindowChannel(name))
            .filter((name) => !(name in bridge.BRIDGE_EVENTS))
            .filter((name) => !bridge.RETIRED_CHANNELS.includes(name));
        eq(unclassified.length, 0,
            `这些推送通道没有归类：${unclassified.join('、')}`);
    });

    check('事件表里 app/split 路由都有真实推送点', () => {
        const dangling = Object.entries(bridge.BRIDGE_EVENTS)
            .filter(([name, meta]) => meta.route !== 'extension' && !pushedChannels.has(name))
            .map(([name]) => name);
        eq(dangling.length, 0, `这些事件归给应用，但主进程从不推送：${dangling.join('、')}`);
    });

    /* ====================================================================== */
    /* 3. 已退役通道不得出现在插件里                                            */
    /* ====================================================================== */

    check('插件源码里没有已退役的通道名', () => {
        const files = walk(EXTENSION_SRC);
        const hits = [];
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            for (const name of bridge.RETIRED_CHANNELS) {
                if (src.includes(name)) hits.push(`${path.relative(ROOT, file)} → ${name}`);
            }
        }
        eq(hits.length, 0, `插件里出现了已退役通道：${hits.join('、')}`);
    });

    /* ====================================================================== */
    /* 4. 传输层的两条硬约束                                                    */
    /* ====================================================================== */

    check('native host 名是 Chrome 接受的形状', () => {
        // Chrome 要求 host 名只能是小写字母、数字、下划线、点，
        // 且不能以点开头/结尾。写错的症状是 connectNative 报
        // "Specified native messaging host not found"，与"没装"无法区分。
        const name = bridge.NATIVE_HOST_NAME;
        assert(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(name),
            `NATIVE_HOST_NAME 形状非法：${name}（只允许小写字母/数字/下划线/点）`);
        assert(!name.startsWith('.') && !name.endsWith('.'), '不能以点开头或结尾');
    });

    check('协议版本是正整数，且消息上限为有限值', () => {
        assert(Number.isInteger(bridge.BRIDGE_PROTOCOL_VERSION) && bridge.BRIDGE_PROTOCOL_VERSION > 0,
            '协议版本必须是正整数');
        // 上限存在的意义是逼传输层分片。若被改成 Infinity 或 0，
        // "一次发完"的写法就会悄悄回来，表现为大 payload 静默失败。
        assert(Number.isFinite(bridge.NATIVE_MESSAGE_MAX_BYTES) && bridge.NATIVE_MESSAGE_MAX_BYTES > 0,
            'NATIVE_MESSAGE_MAX_BYTES 必须是有限正数（分片逻辑依赖它）');
    });

    /* ====================================================================== */
    /* 5. 媒体请求上下文：跨端播放的前提                                        */
    /* ====================================================================== */

    check('MediaRequestContext 携带复现浏览器请求所需的四要素', () => {
        // 这四个字段不是可选优化：<video src> 无法附加请求头，
        // 缺了它们，防盗链站点上"浏览器能播、应用 403"无解。
        const src = fs.readFileSync(path.join(ROOT, 'shared', 'meta', 'bridge.ts'), 'utf8');
        const block = src.slice(src.indexOf('export interface MediaRequestContext'));
        const body = block.slice(0, block.indexOf('}'));
        for (const field of ['url', 'referer', 'userAgent', 'cookie']) {
            assert(new RegExp(`\\b${field}\\??:`).test(body),
                `MediaRequestContext 缺少 ${field}`);
        }
    });

    check('旧的 DownloadMediaParams 仍带 referer（迁移期不能先丢）', () => {
        // 桥接落地前，应用侧仍走 DownloadMediaParams。若这里先被删掉，
        // 迁移中间态就会出现"下载 403 且无从修"的窗口。
        const src = fs.readFileSync(path.join(ROOT, 'shared', 'meta', 'interface.ts'), 'utf8');
        const block = src.slice(src.indexOf('export interface DownloadMediaParams'));
        const body = block.slice(0, block.indexOf('}'));
        assert(/\breferer\??:/.test(body), 'DownloadMediaParams 丢了 referer');
    });

    /* ====================================================================== */
    /* 6. 迁移进度哨兵：extension 路由的应用侧 handler 只减不增                  */
    /* ====================================================================== */

    /**
     * 原先这里断言的是"归属表条数 == 主进程注册数"。
     *
     * 那条等式在拆外壳之前成立纯属巧合：它两边比的不是一回事 ——
     * 左边含 11 个 extension 路由的端点，右边是应用侧 handler，
     * 只是因为那时应用还替插件持有全部 handler，数量才撞上。
     * browserService.js 一删（带走 browser-downloads / browser-download-action
     * 两个 handler），等式就塌了 —— 而塌掉的是等式，不是产品。
     *
     * 现在改成真正要守的那条纪律：**extension 路由的端点，应用侧只许减不许增**。
     * 增 = 有人把已经归给插件的功能又在应用里实现了一遍（拆分倒退）；
     * 减完没从名单里划掉 = 名单变成一句过期的话，下次没人信它。
     */
    const STILL_IN_APP = [
        'get-cookies',
        'set-cookie',
        'remove-cookie',
        'acgmho-probe',
        'acgmho-channels',
        'acgmho-channel-list',
        'acgmho-fetch-pages',
        'acgmho-cancel-fetch-pages',
    ];

    check('extension 路由的端点不得新增应用侧 handler', () => {
        const allowed = new Set(STILL_IN_APP);
        const extra = Object.entries(bridge.BRIDGE_ENDPOINTS)
            .filter(([name, meta]) => meta.route === 'extension'
                && registeredHandlers.has(name)
                && !allowed.has(name))
            .map(([name]) => name);
        eq(extra.length, 0,
            `这些端点归给插件，应用侧却又注册了 handler：${extra.join('、')}。`
            + '拆分方向是应用把能力交出去，不是收回来。');
    });

    check('已迁完的端点要从 STILL_IN_APP 名单里划掉', () => {
        const stale = STILL_IN_APP.filter((name) => !registeredHandlers.has(name));
        eq(stale.length, 0,
            `这些端点应用侧已经没有 handler 了，请从 STILL_IN_APP 里删掉：${stale.join('、')}。`
            + '名单留着过期条目，下次就没人拿它当判据了。');
    });

    if (fails.length > 0) {
        console.log(`桥契约：通过 ${pass} 项，失败 ${fails.length} 项`);
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
        return false;
    }
    console.log(`桥契约：通过 ${pass} 项，失败 0 项`);
    return true;
};

module.exports = { run };
