/**
 * 插件 ↔ 本机应用 的桥契约。
 *
 * ## 为什么需要这个文件
 *
 * 拆分之后，同一个功能可能落在三个地方：插件（chrome.* 原生）、本机应用
 * （Node / 文件系统 / 子进程）、或两边各做一半。**"某个功能归谁"如果没有
 * 单一事实来源，两边就会各写一份判据然后漂移** —— 症状是"插件里点了没反应"
 * 或"同一份设置在两个地方不一样"。
 *
 * 所以这里把归属写成**数据**（`BRIDGE_ENDPOINTS`），由 `test/bridge.test.js`
 * 逐条比对主进程真实的 `ipcMain.handle` 注册：
 *
 *   · 有 handler 但表里没有 → 新增端点忘了归类，测试报红；
 *   · 表里 route 为 'app' 但没有 handler → 桥的目标不存在，测试报红。
 *
 * 判据写进测试而不是写进注释，是因为注释不会在漂移时报错。
 *
 * ## 路由的三种归属
 *
 * - `extension`：浏览器原生能力。插件直接用 `chrome.*`，**不过桥**。
 *   典型是 cookie、下载、嗅探 —— 这些数据本来就长在浏览器里，
 *   搬到 Node 里做只会多一次序列化，还得自己维护一套等价实现。
 *
 * - `app`：需要 Node 能力（子进程、文件系统、BT 套接字）。插件经
 *   native messaging 转发，**应用是唯一执行者**。
 *
 * - `split`：同一件事按输入分岔。见 `download-media` 的说明。
 *
 * ## 退役的那些
 *
 * 随自建浏览器外壳一起消失的端点与事件列在第 3 节的 `RETIRED_CHANNELS`：
 * 列出来是为了让"删掉了什么"可查，而不是留一堆无处对照的空白。
 */

/* ========================================================================== */
/* 1. 端点归属表                                                              */
/* ========================================================================== */

/**
 * 端点的执行方。
 *
 * 只有三种：已退役的那些不在这个类型里（它们不该再出现在任何一端的调用
 * 代码里），统一列在第 3 节的 `RETIRED_CHANNELS`。
 */
export type BridgeRoute = 'extension' | 'app' | 'split';

export interface BridgeEndpoint {
    /** 谁执行 */
    route: BridgeRoute;
    /**
     * 一句话说明**为什么**是这个归属。
     * 只写"因为需要 Node"是不够的 —— 要写清是哪一项能力把结论定死了，
     * 否则后来人会以为可以随手挪。
     */
    reason: string;
}

/**
 * 全部存活端点及其归属。
 *
 * 键名与 `ipcMain.handle` 的通道名逐字一致（历史原因带连字符，
 * 迁移期间保持同名可以让两端的 diff 最小）。
 */
export const BRIDGE_ENDPOINTS = {
    /* ---------------------------------------------------------------------- */
    /* 浏览器原生：插件直接做，不过桥                                          */
    /* ---------------------------------------------------------------------- */

    'sniffer-set-enabled': {
        route: 'extension',
        reason: '嗅探是插件的 webRequest 观察，开关由插件自己持有；应用不再参与嗅探。',
    },
    /*
     * 下面几条是**悬浮球**用的。
     *
     * 球现在跑在 Electron 里（见 app/main/orbs.js 讲清了为什么），它拿不到
     * `chrome.*`，所以这些原本"球直接问 SW"的操作改走过桥。**归属没有变** ——
     * 数据仍然长在插件里，应用只是转发，不持有任何一份副本。
     */
    'sniffer-get-state': {
        route: 'extension',
        reason: '嗅探开关与结果都在插件的 chrome.storage，球只是显示。',
    },
    'sniffer-clear': {
        route: 'extension',
        reason: '清空的是插件的 storage.session，应用没有这份数据。',
    },
    'sniffer-clear-tab': {
        route: 'extension',
        reason: '同 sniffer-clear。判据是标签页 id —— 球按标签栏筛选，'
            + '应用再写一份会出现"界面看得见、清不掉"的条目。',
    },
    'sniffer-tabs': {
        route: 'extension',
        reason: '"浏览器里开着哪些标签页"只有 chrome.tabs 知道；'
            + '球（Electron 窗口）要把它们画成标签栏，并据此筛选嗅探结果。',
    },
    'sniffer-close-tab': {
        route: 'extension',
        reason: '关闭标签页是 chrome.tabs.remove 的原生动作 —— 应用没有这个能力，'
            + '而且"在球上关掉就等于在浏览器里关掉"要求动作真的发生在浏览器侧。',
    },
    'sniffer-scan': {
        route: 'extension',
        reason: '页内扫描要 chrome.scripting 把代码送进目标标签页，应用没有这个能力；'
            + '扫描结果也直接进插件的列表，不过桥。',
    },
    'sniffer-active-page': {
        route: 'extension',
        reason: '"当前是哪个标签页"是浏览器的事实，只有 chrome.tabs 知道。'
            + '嗅探已不用它（作用域是全部标签页），Agent 球的规则/请求头/存储/JWT '
            + '四个页签用它显示"这些操作作用于哪个页面"。',
    },
    'tamper-get': {
        route: 'extension',
        reason: '规则的唯一权威是插件的 chrome.storage.local，且注入靠 chrome.scripting。'
            + '应用侧再存一份就会出现"面板里改了、页面里没生效"。',
    },
    'tamper-set': {
        route: 'extension',
        reason: '同 tamper-get。写入后要立刻注入目标标签页，那是 chrome.scripting 的能力。',
    },
    'tamper-inject': {
        route: 'extension',
        reason: '注入是 chrome.scripting 的原生动作，应用没有这个能力。',
    },
    'page-storage-read': {
        route: 'extension',
        reason: '读的是浏览器当前会话的真实值（含 HttpOnly cookie）——'
            + '应用侧读到的只是启动时那份快照，而"改完即时生效"要求读到活的。',
    },
    'page-storage-write': {
        route: 'extension',
        reason: '同 page-storage-read。写回后浏览器立即生效，不需要应用通知会话刷新。',
    },
    'downloads-start': {
        route: 'extension',
        reason: 'chrome.downloads 是浏览器的下载管理器，进度与断点都由它持有；'
            + '应用侧的下载列表已随自建外壳一起删掉。',
    },
    'agent-snapshot': {
        route: 'extension',
        reason: 'Agent 引擎（对话历史、主循环、工具派发）跑在插件里，快照的唯一权威在那边。',
    },
    'agent-action': {
        route: 'extension',
        reason: '同 agent-snapshot：动作直接改引擎状态，在应用侧再存一份就会有两套真值。',
    },
    'get-cookies': {
        route: 'extension',
        reason: 'chrome.cookies 直接读，且拿到的是**活的**会话值；应用侧读的是启动时的快照。',
    },
    'set-cookie': {
        route: 'extension',
        reason: '同上。写回后浏览器立即生效，不需要应用通知会话刷新。',
    },
    'remove-cookie': {
        route: 'extension',
        reason: 'chrome.cookies.remove 原生能力；应用侧删 cookie 还要处理"删的是快照还是会话"的歧义。',
    },
    'browser-downloads': {
        route: 'extension',
        reason: 'chrome.downloads 是浏览器自己的下载列表，本来就该由浏览器持有。',
    },
    'browser-download-action': {
        route: 'extension',
        reason: '暂停/继续/取消/定位都是 chrome.downloads 的原生动作。',
    },
    /* ---------------------------------------------------------------------- */
    /* 画廊（多站点）：应用侧持有全部实现                                      */
    /* ---------------------------------------------------------------------- */

    /**
     * 这组通道归应用，不归插件 —— 与上面那组 acgmho-* 的历史归类相反。
     *
     * 原因是一次真实的返工：那组通道当年归给插件，理由是"纯网络读取，
     * 插件 fetch 自带会话与代理"。但画廊的其余部分（逐页解析、批量落盘、
     * 断点续传、manifest 徽标）全都只能在应用侧做，于是一本作品的流程被
     * 劈成两半：列表在插件取、图片在应用下。两边各自维护一套站点解析，
     * 接第二个站点时立刻分叉。
     *
     * 现在的判据是**整条流程的归属**，不是单次请求的性质：抓取、解析、
     * 落盘必须同侧，否则站点解析会分裂成两份。所以画廊端点一律归应用。
     */
    'gallery-sites': {
        route: 'app',
        reason: '站点表由主进程的 galleryRegistry 持有（它才知道装了哪些 provider）。',
    },
    'gallery-channels': {
        route: 'app',
        reason: '频道表跟着 provider 走，provider 只在应用侧。',
    },
    'gallery-probe': {
        route: 'app',
        reason: '探测结果要直接被应用侧的抓取/落盘复用（firstHtml、token、galleryUrl），'
            + '放在插件里就得跨进程传一大段 HTML。',
    },
    'gallery-channel-list': {
        route: 'app',
        reason: '同 gallery-probe：列表条目要直接喂给应用侧的探测与落盘。',
    },
    'gallery-start-download': {
        route: 'app',
        reason: '批量落盘：任意路径写入 + 并发控制 + 断点续传状态，都是 Node 侧能力。',
    },
    'gallery-cancel-download': {
        route: 'app',
        reason: '要中止应用侧的写盘任务。',
    },
    'gallery-save-images': {
        route: 'app',
        reason: '边下边播落盘：写文件 + 写 manifest 与 .gallery 徽标。',
    },
    'gallery-cancel-save-images': {
        route: 'app',
        reason: '要中止应用侧的写盘并清理已落地的半套文件。',
    },
    'gallery-open-folder': {
        route: 'app',
        reason: '打开资源管理器需要 shell API。',
    },
    'gallery-fetch-pages': {
        route: 'app',
        reason: '逐页解析与应用侧下载器共用同一套 provider（含图床直连策略），'
            + '拆到插件就会有两份站点解析。',
    },
    'gallery-cancel-fetch-pages': {
        route: 'app',
        reason: '取消的是应用侧的 run 登记表。',
    },

    'acgmho-probe': {
        route: 'extension',
        reason: '纯网络读取。插件 fetch 天然带上会话 cookie 与用户已配好的代理，'
            + '不再需要应用自己维护代理与 cookie 注入。',
    },
    'acgmho-channels': {
        route: 'extension',
        reason: '内置静态频道表，无网络无副作用，属于插件的数据。',
    },
    'acgmho-channel-list': {
        route: 'extension',
        reason: '同 acgmho-probe：纯网络读取，且要读登录态页面。',
    },
    'acgmho-fetch-pages': {
        route: 'extension',
        reason: '同 acgmho-probe。翻页要带会话，插件里是免费的。',
    },
    'acgmho-cancel-fetch-pages': {
        route: 'extension',
        reason: '取消的是插件自己的 AbortController，跨进程取消只会更复杂。',
    },

    /* ---------------------------------------------------------------------- */
    /* 本机应用：必须过桥                                                      */
    /* ---------------------------------------------------------------------- */

    'torrent-start': {
        route: 'app',
        reason: 'BT 需要 UDP/DHT 套接字与长驻进程，MV3 service worker 两者都没有。',
    },
    'torrent-cancel': {
        route: 'app',
        reason: '要杀任务并删半成品文件，两者都在应用侧。',
    },
    'torrent-pause': {
        route: 'app',
        reason: '操作的是应用内的任务对象。',
    },
    'torrent-resume': {
        route: 'app',
        reason: '恢复的是应用进程内的 BT 会话；插件无法代持这个连接状态。',
    },
    'torrent-tasks': {
        route: 'app',
        reason: '任务列表的唯一权威在应用侧，插件只做展示。',
    },
    'torrent-open-folder': {
        route: 'app',
        reason: '打开资源管理器需要 shell API。',
    },
    'torrent-fetch-file': {
        route: 'app',
        reason: '把 .torrent 落到磁盘需要文件系统权限；白名单防 SSRF 也在应用侧。',
    },
    'sandbox': {
        route: 'app',
        reason: 'Agent 的本地沙箱：读写与改文件要 fs，只有主进程能做；'
            + '而"路径必须落在项目根的 sandbox 目录内"这条边界必须由执行者自己守 —— '
            + '放进插件就等于由发起方自行声明它没有越界。',
    },
    'acgmho-start-download': {
        route: 'app',
        reason: '批量落盘：任意路径写入 + 并发控制 + 断点续传状态，都是 Node 侧能力。',
    },
    'acgmho-cancel-download': {
        route: 'app',
        reason: '要中止应用侧的写盘任务。',
    },
    'acgmho-save-images': {
        route: 'app',
        reason: '边下边播落盘：写文件 + 写 manifest 与 .gallery 徽标。',
    },
    'acgmho-cancel-save-images': {
        route: 'app',
        reason: '要中止应用侧的写盘并清理已落地的半套文件。',
    },
    'acgmho-open-folder': {
        route: 'app',
        reason: '打开资源管理器需要 shell API。',
    },
    'spg-save': {
        route: 'app',
        reason: '写入项目根的 .spg 目录，插件没有任意路径写权限。',
    },
    'spg-pick': {
        route: 'app',
        reason: '要弹系统文件框并把初始目录指到项目根的 .spg，还要读出文件内容 —— 两件事都只有主进程能做。',
    },
    'gallery-save-pack': {
        route: 'app',
        reason: '要弹系统"另存为"对话框并写入用户选定路径。',
    },
    'settings-get': {
        route: 'app',
        reason: '设置必须**只有一个所有者**。AI 配置同时被应用的 AI 绘本与插件的 Agent 使用，'
            + '两边各存一份必然漂移，所以权威留在应用侧，插件代理读取。',
    },
    'settings-set-ai-config': {
        route: 'app',
        reason: '设置的唯一写入点：AI 配置被应用的 AI 绘本与插件的 Agent 共用，两边各存一份必然漂移。',
    },
    'settings-test-ai-config': {
        route: 'app',
        reason: '探活请求必须由持有配置的一侧发出，否则插件会拿一份可能过期的配置去测。',
    },
    'settings-set-proxy-port': {
        route: 'app',
        reason: '代理是 Chromium 会话级设置（session.setProxy），插件无权改；'
            + '且改了也只影响应用，不影响浏览器。**用户需要自己在浏览器里配代理。**',
    },
    'get-download-capabilities': {
        route: 'app',
        reason: '问的是"本机有没有 ffmpeg"，只有应用知道。',
    },

    /* ---------------------------------------------------------------------- */
    /* 分岔：按输入决定谁做                                                    */
    /* ---------------------------------------------------------------------- */

    'download-media': {
        route: 'split',
        reason: '直链（mp4/图片等）交给插件的 chrome.downloads，'
            + '浏览器的下载管理器能显示进度、断点、历史；'
            + 'HLS/需要转封装（ffmpeg -c copy）的必须走应用 —— 插件不能起子进程。',
    },
    'cancel-media-download': {
        route: 'split',
        reason: '跟随 download-media 的分岔：取消谁，取决于当初是谁接的。',
    },
} as const satisfies Record<string, BridgeEndpoint>;

export type BridgeEndpointName = keyof typeof BRIDGE_ENDPOINTS;

/* ========================================================================== */
/* 2. 推送事件归属表                                                          */
/* ========================================================================== */

/**
 * 主进程 → 调用方 的推送通道。
 *
 * 与端点分开列，因为两者的失效方式不同：端点漏归类是"调用报错"，
 * 事件漏归类是**静默不更新**（界面停在旧数据上，不报任何错）。
 */
export const BRIDGE_EVENTS = {
    'sniffed-media': {
        route: 'extension',
        reason: '嗅探结果由插件的 webRequest 观察直接产生。',
    },
    'tabs-changed': {
        route: 'extension',
        reason: '标签页的开关、导航、改名都发生在浏览器里（chrome.tabs.onCreated/'
            + 'onRemoved/onUpdated）；球据此重拉标签栏，否则它停在打开那一刻的快照上。',
    },
    'browser-download': {
        route: 'extension',
        reason: '对应 chrome.downloads.onChanged。',
    },
    'media-download-progress': {
        route: 'split',
        reason: '跟随 download-media：直链由 chrome.downloads.onChanged 报，'
            + '流媒体由应用解析 ffmpeg 的 -progress 输出后过桥。',
    },
    'gallery-fetch-progress': {
        route: 'app',
        reason: '逐页解析在应用侧执行（Node 直抓），插件里没有这条路。'
            + '与 acgmho-fetch-progress 的区别：那条是插件内抓取，这条是应用内抓取。',
    },
    'gallery-progress': {
        route: 'app',
        reason: '批量下载在应用侧执行。',
    },
    'gallery-save-progress': {
        route: 'app',
        reason: '落盘在应用侧执行。',
    },
    'acgmho-fetch-progress': {
        route: 'extension',
        reason: '抓取在插件内进行，进度不出浏览器。',
    },
    // acgmho-progress / acgmho-save-progress 已随画廊多站点改造退役：
    // 事件改由 gallery-* 推送（带 site 字段）。旧名字留在 RETIRED_CHANNELS 里，
    // 免得有人以为"改回去就能恢复兼容" —— 渲染层已同步改订阅名。
    'torrent-progress': {
        route: 'app',
        reason: 'BT 引擎在应用侧。',
    },
    'play-media-push': {
        route: 'app',
        reason: '嗅探球推给**主窗口**的入列请求。播放列表长在主窗口的渲染层里，'
            + '球（独立窗口）自己没有播放器 —— 这条是应用内部的窗口间转交，插件不参与。',
    },
} as const satisfies Record<string, BridgeEndpoint>;

export type BridgeEventName = keyof typeof BRIDGE_EVENTS;

/* ========================================================================== */
/* 3. 已退役的端点与事件                                                      */
/* ========================================================================== */

/**
 * 随自建浏览器外壳一起消失的通道。
 *
 * 留着这张表有两个用处：一是让"外壳拆掉了哪些能力"可查；二是测试可以断言
 * **这些名字不再出现在任何一端** —— 否则半拆状态最容易留下一个还在监听、
 * 但永远收不到消息的订阅点。
 */
export const RETIRED_CHANNELS = [
    'navigate-to-url',
    'browser-command',
    'edge-detect',
    'edge-import',
    // 画廊多站点改造：进度事件统一改叫 gallery-*（带 site 字段），旧名不再推送。
    // 放进这张表而不是留在事件表里 —— 留在表里会让"事件表里 app 路由都有真实
    // 推送点"那条断言长期红着，最终被人无视。
    'acgmho-progress',
    'acgmho-save-progress',
] as const;

/* ========================================================================== */
/* 4. 媒体请求上下文                                                          */
/* ========================================================================== */

/**
 * 请求一个媒体 URL 时，除 URL 本身之外**必须一并传递**的上下文。
 *
 * ## 为什么单列一个类型
 *
 * `<video src>` 无法附加自定义请求头（HTML 规范限制，不是实现缺陷）。
 * 所以防盗链站点上"浏览器里能播、交给应用就 403"是必然的，除非把上下文
 * 一起传过去。当前应用是在自己的会话里靠 `webSecurity:false` 与
 * `onBeforeSendHeaders` 兜住的，拆分后那条路不复存在。
 *
 * 因此这不是可选优化，而是**跨端播放能否成立的前提**：插件知道自己是从
 * 哪个页面嗅到的、当前 UA 是什么、cookie 是什么；应用拿到这三样才能
 * 复现出浏览器那次成功的请求。
 *
 * 缺省字段一律表示"没有额外要求"，而不是"空值覆盖" —— 应用侧不得把
 * 缺省解释成"清空这些头"。
 */
export interface MediaRequestContext {
    /** 媒体直链 */
    url: string;
    /**
     * 防盗链 Referer。
     * 通常取媒体所在页面地址（`pageUrl`）而非媒体自身地址 ——
     * 多数站点的校验是"Referer 的 origin 在白名单内"。
     */
    referer?: string;
    /** 嗅探发生时的页面地址，供应用在 referer 缺失时自行推导 */
    pageUrl?: string;
    /** 当前浏览器 UA。UA 与 cf_clearance 一类凭证绑定，不能用应用自己那份 */
    userAgent?: string;
    /** 该请求所需的 Cookie 头原文（含 cf_clearance 等反爬凭证） */
    cookie?: string;
}

/* ========================================================================== */
/* 5. native messaging 传输层                                                 */
/* ========================================================================== */

/**
 * native messaging host 的注册名。
 *
 * 必须与三处逐字一致，任何一处写错的表现都是 `connectNative` 报
 * "Specified native messaging host not found"：
 *   1. 插件的 `chrome.runtime.connectNative(...)` 实参；
 *   2. host manifest 的文件名（`<这个名字>.json`）；
 *   3. host manifest 里的 `name` 字段。
 * 注册表路径：`HKCU\Software\Google\Chrome\NativeMessagingHosts\<名字>`
 * （HKCU 即可，不需要管理员权限 —— 这也是阶段 0 能删掉提权要求的原因）。
 */
export const NATIVE_HOST_NAME = 'com.theplay.host';

/**
 * 桥协议版本。
 *
 * 插件与应用可以各自独立更新，所以握手时必须比对：**版本不一致要明确报错，
 * 不能降级尝试**。否则旧插件配新应用会表现为"某些端点神秘失败"，
 * 而不是一句能看懂的"请更新"。
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * native messaging 单条消息的字节上限。
 *
 * ⚠️ **这个值未经实测确认**（写此文件时联网检索不可用）。
 * 已知的约束方向是"有上限且远小于无限"，因此传输层必须**按帧分片**而不是
 * 假定一次能发完 —— 分片后即使真实上限与此值不同，也只是分片粒度变化，
 * 不会出现"小数据能通、大数据静默截断"。
 *
 * 需要实测确认的项（阶段 4 落地时必须验）：
 *   · Chrome → host 与 host → Chrome 两个方向的上限是否相同；
 *   · 超限时的行为是报错、截断还是断开连接。
 * 在实测之前，任何"一次发完就行"的写法都不成立。
 */
export const NATIVE_MESSAGE_MAX_BYTES = 1024 * 1024;

/**
 * 过桥请求的信封。
 *
 * 与具体端点无关：`method` 用 `BridgeEndpointName`，两端共用一套编解码，
 * 新增端点不需要动传输层。
 */
export interface BridgeRequest {
    /** 请求标识，用于把响应与请求配对（并发调用时必需） */
    id: string;
    method: BridgeEndpointName;
    params?: unknown;
}

export interface BridgeResponse {
    id: string;
    ok: boolean;
    /** ok 为 true 时存在 */
    result?: unknown;
    /** ok 为 false 时存在，供界面直接显示 */
    error?: string;
}

/** 应用主动推送的事件（订阅类端点用） */
export interface BridgeEventMessage {
    event: BridgeEventName;
    payload: unknown;
}
