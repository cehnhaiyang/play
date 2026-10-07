/**
 * 浏览器外壳的**纯判据**（渲染层侧）。
 *
 * ============================================================================
 * 为什么这里只有判据、没有 Electron 调用
 * ============================================================================
 *
 * 这个文件与 `electron/browserService.js` 是同一条边界的两侧：
 *
 *   - 必须"在页面收到事件之前"截断的（快捷键、右键菜单、会话权限、网页下载）
 *     → 只能在主进程，见 electron/browserService.js；
 *   - 拿到事件**之后**做判断的（这个错误码是什么意思、缩放该到第几级）
 *     → 留在渲染层，就是这里。
 *
 * 分界的实际好处是**可单测**：主进程目录只能写 .js，而
 * test/tsconfig.json 不 include electron/ —— 判据放在那边就没法测。
 * 放在 services/ 下是 TS，测试直接 import 编译产物求值。
 *
 * 反过来说，**判据绝不能两边各写一份**。错误码表尤其危险：主进程与渲染层
 * 各维护一张表，漂移的症状是"同一个错误在日志里和界面上叫两个名字"，
 * 而且不报错、不崩溃，只是让人对不上号。
 */

/**
 * 一次导航失败。
 *
 * 字段全部来自 `<webview>` 的 `did-fail-load` 事件（errorCode /
 * errorDescription / validatedURL），加上这里归类出来的中文说法。
 */
export interface NavigationError {
    errorCode: number;
    /** 面向用户的一句话 */
    title: string;
    /** 可操作的建议；空串表示没有对应建议，界面据此决定要不要画第二行 */
    hint: string;
    /** Chromium 原始英文描述，收在详情里给排查用 */
    raw: string;
    /** 出错的域名（从 validatedURL 解析），解析不出时为空串 */
    host: string;
    /** 证书类错误：这类错误"重试"没有意义，界面要换一条建议 */
    isCertificate: boolean;
    /** DNS 类错误：值得单独提示去查地址拼写 */
    isDns: boolean;
}

/**
 * Chromium net error 码 → 人话。
 *
 * 只挑**用户真会碰到**的那些，其余回落到 errorDescription。
 * 编一张全表没有意义 —— 错误码有四百多个，写全了也没人维护，
 * 而用户看到的仍然是 Chromium 自己那句英文。
 *
 * 键用**字符串**而不是数字：对象字面量里 `-100` 这类负数键在
 * `Object.keys` 顺序、`in` 判断上都容易出意外，统一成字符串更省心。
 */
const ERROR_TABLE: Record<string, { title: string; hint: string }> = {
    '-2': { title: '网络请求失败', hint: '检查网络连接或代理设置。' },
    '-6': { title: '文件不存在', hint: '本地文件可能已被移动或删除。' },
    '-7': { title: '连接超时', hint: '目标服务器没有在时限内响应，稍后重试或检查代理。' },
    '-21': { title: '网络连接被中断', hint: '连接中途断开，重试通常就能恢复。' },
    '-100': { title: '无法连接到服务器', hint: '域名解析成功但连不上，站点可能已下线或被网络屏蔽。' },
    '-101': { title: '连接被重置', hint: '连接被对端或中间设备切断，常见于网络封锁。' },
    '-102': { title: '连接被拒绝', hint: '目标端口没有服务在监听。' },
    '-104': { title: '无法连接到服务器', hint: '连接失败，稍后重试。' },
    '-105': { title: '域名解析失败', hint: 'DNS 查不到这个域名，检查地址拼写或 DNS 设置。' },
    '-106': { title: '网络已断开', hint: '本机当前没有可用网络。' },
    '-109': { title: '无法访问该地址', hint: '地址不可达。' },
    '-118': { title: '连接超时', hint: '建立连接超时，稍后重试或检查代理。' },
    '-130': { title: '代理连接失败', hint: '代理服务器不可用，检查设置里的代理端口。' },
    '-137': { title: '域名解析失败', hint: 'DNS 查询超时。' },
    '-138': { title: '域名解析失败', hint: 'DNS 服务器返回了无效响应。' },
    '-200': { title: '证书不受信任', hint: '站点证书校验未通过（自签名或签发机构未知）。' },
    '-201': { title: '证书已过期', hint: '站点证书不在有效期内。' },
    '-202': { title: '证书已被吊销', hint: '站点证书已被签发机构吊销。' },
    '-207': { title: '证书域名不匹配', hint: '证书上的域名与访问的地址不一致。' },
    '-324': { title: '响应为空', hint: '服务器接受了连接但没有返回任何数据。' },
    '-501': { title: '不支持的协议', hint: '地址里的协议无法识别。' },
    '-502': { title: '页面加载失败', hint: '响应内容无法解析。' },
};

/** 证书类错误码区间（Chromium 的 CERT_* 家族） */
const CERT_CODE_MIN = -219;
const CERT_CODE_MAX = -200;

/** 归类一次导航失败。纯函数：同样的入参永远得到同样的结果，可以直接断言 */
export function classifyNavigationError(
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
): NavigationError {
    const code = Number(errorCode) || 0;
    const raw = String(errorDescription || '').trim();
    const known = ERROR_TABLE[String(code)];

    let host = '';
    try {
        host = new URL(String(validatedURL || '')).hostname;
    } catch {
        host = '';
    }

    return {
        errorCode: code,
        title: known ? known.title : (raw || '页面加载失败'),
        hint: known ? known.hint : '',
        raw,
        host,
        isCertificate: code <= CERT_CODE_MAX && code >= CERT_CODE_MIN,
        isDns: code === -105 || code === -137 || code === -138,
    };
}

/**
 * 这个 `did-fail-load` 该不该让标签页进入"加载失败"态。
 *
 * 两个必须过滤掉的情况，否则界面会满屏假错误：
 *
 *  - **非主框架**：页面里一个广告 iframe 挂了不该让整页变错误页。
 *    `isMainFrame` 缺失时按"是主框架"处理（旧版 Electron 不带这个字段，
 *    宁可多显示一次错误页，也不要静默吞掉真正的失败）。
 *  - **ERR_ABORTED(-3)**：正常导航都会抛它 —— 重定向、点击下载链接、
 *    SPA 换页、用户按了停止。不过滤的话每次点下载都会闪一下错误页。
 */
export function shouldShowNavigationError(errorCode: number, isMainFrame: boolean): boolean {
    if (isMainFrame === false) return false;
    const code = Number(errorCode) || 0;
    if (code === 0 || code === -3) return false;
    return true;
}

/** 缩放级别的上下限。与 Chrome 一致的 ±5 级（每级 1.2 倍，约 40%–249%） */
export const ZOOM_MIN_LEVEL = -5;
export const ZOOM_MAX_LEVEL = 5;

/**
 * 按**方向**算下一个缩放级别，并夹在上下限内。
 *
 * 抽成纯函数是为了能直接测：这里有两个容易搞错的方向 ——
 * 夹取写反会让缩放卡在边界（按了没反应），
 * 步长写错会让某一档永远到不了（Ctrl+0 复位之后再也回不到 100%）。
 *
 * @param current 当前级别
 * @param delta   +1 放大 / -1 缩小 / 0 复位
 */
export const nextZoomLevel = (current: number, delta: number): number => {
    if (delta === 0) return 0;
    const base = Number.isFinite(current) ? Math.round(current) : 0;
    const next = base + (delta > 0 ? 1 : -1);
    return Math.min(ZOOM_MAX_LEVEL, Math.max(ZOOM_MIN_LEVEL, next));
};

/**
 * Electron 的 zoomLevel → 百分比。
 *
 * 换算关系是 `factor = 1.2 ^ level`（Chromium 的 kDefaultZoomLevel 为 0，
 * 每级按 1.2 倍缩放）。界面上显示百分比而不是 level 数字：
 * 用户认得"120%"，不认得"level 1"。
 */
export const zoomLevelToPercent = (level: number): number => {
    const l = Number.isFinite(level) ? level : 0;
    return Math.round(Math.pow(1.2, l) * 100);
};

/**
 * zoomLevel → Electron 的缩放系数。
 *
 * 与 zoomLevelToPercent **必须**用同一个底数：两处各写一个常数时，
 * 界面显示 120% 而实际缩放是 1.25 这种偏差不会报错，只是"看着不太对"。
 */
export const zoomLevelToFactor = (level: number): number =>
    Math.pow(1.2, Number.isFinite(level) ? level : 0);

/**
 * Electron 的缩放系数 → zoomLevel。
 *
 * `zoom-changed` 事件（用户在页内 Ctrl+滚轮）只给 factor 不给 level，
 * 但 Tab 状态存的是 level：不换算回写的话地址栏百分比指示过期，
 * 且下一次 Ctrl+加号会按过期基准跳变。factor = 1.2 ^ level 的逆运算，
 * 四舍五入到最近档并夹在上下限内 —— 原生缩放的任意值（如 1.33）都会
 * 落到最近的整数档，显示与实际最多差半档。
 */
export const zoomFactorToLevel = (factor: number): number => {
    if (!Number.isFinite(factor) || factor <= 0) return 0;
    const level = Math.round(Math.log(factor) / Math.log(1.2));
    return Math.min(ZOOM_MAX_LEVEL, Math.max(ZOOM_MIN_LEVEL, level));
};

/**
 * 键盘事件是不是发生在可编辑控件里。
 *
 * 用于决定某些**不带修饰键**的快捷键该不该放行：在输入框里按 F3 应该
 * 走浏览器查找，但在输入框里打字时不能把普通字符当成快捷键。
 * 判据覆盖 input / textarea / contenteditable / select 四种，
 * 少了 contenteditable 会让所有富文本编辑器（包括本站的 Agent 输入框之外的
 * 第三方页面）在打字时被快捷键抢走按键。
 */
export const isEditableTarget = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return el.isContentEditable === true;
};

/* -------------------------------------------------------------------------- */
/* 地址栏输入判据：地址还是搜索词                                               */
/* -------------------------------------------------------------------------- */

/**
 * 只有这三种协议会被当作"用户就是要访问这个地址"，其余一律退回搜索。
 *
 * 从 hooks/useBrowse 搬过来：判据放 hook 里就进不了单测（测试只编译
 * services/），而这里与错误码表、缩放换算一样是纯函数。hook 与面板
 * 只 import，不许再各写一份。
 */
const SAFE_SCHEME_RE = /^(https?|file):\/\//i;
const ABOUT_BLANK_RE = /^about:blank$/i;
const LOCALHOST_RE = /^localhost(:\d{1,5})?(\/.*)?$/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?(\/.*)?$/;
/**
 * 裸域名。TLD 不限长度 —— 旧版写死 `[a-z]{2,5}`，`example.museum`、
 * `a.technology` 这类合法域名会被误判成搜索词。
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(:\d{1,5})?(\/.*)?$/i;

/** IPv4 每段必须 ≤255：`999.999.999.999` 按网址打开只会落到 DNS 错误页，不如直接搜 */
export const isValidIPv4Host = (target: string): boolean => {
    const m = target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(:\d{1,5})?(\/.*)?$/);
    return !!m && m.slice(1, 5).every((oct) => Number(oct) <= 255);
};

export const isUrlLike = (target: string): boolean => {
    // 含空白的输入几乎不可能是 URL（`site.com/a b` 也按搜索处理）
    if (/\s/.test(target)) return false;
    if (ABOUT_BLANK_RE.test(target)) return true;
    if (SAFE_SCHEME_RE.test(target)) return true;
    if (LOCALHOST_RE.test(target)) return true;
    if (IPV4_RE.test(target)) return isValidIPv4Host(target);
    return HOSTNAME_RE.test(target);
};

/**
 * 地址栏要按同一判据决定"这是地址还是搜索词"：是地址就不该显示搜索引擎选择器，
 * 是搜索词才显示。面板与提交逻辑都调这一份 —— 各抄一份的话，这里显示
 * "搜索 Bing"、回车却当网址打开，是最难被发现的一类不一致。
 */
export const isAddressLike = (input: string): boolean => isUrlLike(input.trim());

/**
 * 地址栏输入 → 最终 URL。纯函数版本：搜索引擎以前缀字符串传入，
 * 不依赖 hook 里的 SearchEngine 类型（类型在 hook 那边，判据在这一边，
 * 依赖只能单向）。
 */
export const resolveInputUrl = (input: string, searchUrlPrefix: string): string => {
    const target = input.trim();
    if (!target) return '';
    // about:blank 是合法导航目标，不能按"无协议裸词"加 https:// 前缀，
    // 否则打开的是搜索页而非空白页（与 isUrlLike 的特判对称）
    if (ABOUT_BLANK_RE.test(target)) return 'about:blank';
    if (!isUrlLike(target)) {
        return `${searchUrlPrefix}${encodeURIComponent(target)}`;
    }
    if (SAFE_SCHEME_RE.test(target)) return target;
    return `https://${target}`;
};
