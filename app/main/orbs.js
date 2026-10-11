'use strict';

/**
 * 两个悬浮球的窗口。
 *
 * ## 为什么球必须由 Electron 画，而不是插件自己开窗口
 *
 * 这是实测出来的，不是偏好。Chrome 扩展能开的最"像球"的东西是
 * `chrome.windows.create({ type: 'popup' })`，而它有三个去不掉的硬限制：
 *
 *   · **最小 136×80**。请求 56×56，Chrome 直接给成 136×80 —— 球做不出来；
 *   · **标题栏固定吃掉 39px 高、16px 宽**。`type: 'panel'`（唯一可能无边框的
 *     那个）在 Windows 上被降级成 popup，实测 `w.type` 回读仍是 `'popup'`；
 *   · **不能置顶**。`windows.update` 没有 `alwaysOnTop` 这个字段，
 *     传了直接报 `Unexpected property`。球会被别的窗口盖住。
 *
 * Electron 这边三样都成立：`frame: false` 去掉标题栏，`transparent: true`
 * 让四角真正透明（否则圆角外面是一块方形的底色），`setAlwaysOnTop` 置顶。
 *
 * ## 每个球一个独立窗口
 *
 * 不是"一个窗口放两个球"。两个球各自有生命周期、各自的位置、各自的展开尺寸，
 * 塞进一个窗口就必须共享一个矩形 —— 而那个矩形要同时满足"球形态"和"面板形态"，
 * 结果是两个都做不好。分开之后每个窗口只有一种形态，尺寸就是内容尺寸。
 *
 * ## 透明窗口的三条约束
 *
 * 1. **`transparent: true` 必须配 `frame: false`**，两者一起才有意义。
 * 2. **必须给 `backgroundColor: '#00000000'`**。不给的话 Windows 上会填一层
 *    不透明底色，表现为"球外面套了个方块"。
 * 3. **不能开 `resizable`**。用户拖窗口边缘把球拉成长方形之后，里面那个圆
 *    要么被裁掉要么留白 —— 两种都不是球。尺寸只由我们按展开/收起改。
 */

const path = require('path');
const fs = require('fs');
const { BrowserWindow, ipcMain, screen } = require('electron');

/* ========================================================================== */
/* 1. 两个球的定义                                                            */
/* ========================================================================== */

/**
 * 球的直径。
 *
 * 64 而不是 56：无边框窗口的圆没有窗口边框帮着"撑开"，56 在 125% 缩放的屏幕上
 * 看着偏小，而 64 正好是 Windows 上"能舒服点中"的最小尺寸。
 */
const BALL_SIZE = 64;

/** 展开/收起后重新收敛到工作区时的留白 */
const MARGIN = 8;

const ORB_DEFS = {
    sniff: {
        title: '资源嗅探',
        /** 展开态尺寸。按内容定：列表每行两行文字，520 能放约 8 条 */
        panel: { w: 380, h: 520 },
        /** 默认位置：右下角 */
        defaultCorner: 'bottom-right',
    },
    agent: {
        title: 'Agent',
        /** 对话比嗅探列表高：要留出输入框与多轮消息 */
        panel: { w: 440, h: 640 },
        /** 默认位置：右侧中部偏下。与嗅探球错开，否则两个球完全重叠 */
        defaultCorner: 'right',
    },
};

const ORB_IDS = Object.keys(ORB_DEFS);

/* ========================================================================== */
/* 2. 位置持久化                                                              */
/* ========================================================================== */

/**
 * 位置存 userData 下的一个 JSON，不用 electron-store 之类的依赖。
 *
 * 存的是**球心**而不是左上角：展开时球心不动、面板围着它铺开，
 * 收起时回到同一个球心。存左上角的话展开一次位置就漂了 —— 因为展开态的
 * 左上角与球形态的左上角不是同一个点。
 */
const positionsFile = () => path.join(require('electron').app.getPath('userData'), 'orb-positions.json');

let positions = {};

const loadPositions = () => {
    try {
        positions = JSON.parse(fs.readFileSync(positionsFile(), 'utf8')) || {};
    } catch {
        // 首次运行或文件损坏：用默认位置，不报错
        positions = {};
    }
};

const savePositions = () => {
    try {
        fs.writeFileSync(positionsFile(), JSON.stringify(positions, null, 2), 'utf8');
    } catch {
        // 写不进去最多是下次启动位置复位，不值得打断用户
    }
};

/* ========================================================================== */
/* 3. 几何                                                                    */
/* ========================================================================== */

/** 鼠标所在（或主）显示器的可用区域。多显示器下必须按窗口所在屏算 */
const workAreaFor = (point) => {
    try {
        const display = point ? screen.getDisplayNearestPoint(point) : screen.getPrimaryDisplay();
        return display.workArea;
    } catch {
        return { x: 0, y: 0, width: 1920, height: 1080 };
    }
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * 把"球心 + 尺寸"收敛成一个合法的工作区坐标。
 *
 * 收敛而不是拒绝：显示器拔掉、分辨率变小、任务栏挪位之后，存下来的球心
 * 可能落在屏幕外。直接用它的话球会"不见了"，而用户没有任何办法找回来。
 *
 * ⚠️ **返回的键必须是 `x` / `y`，不能是 `left` / `top`。**
 *
 * 这是实测踩过的坑：`BrowserWindow` 的构造参数与 `setBounds` 都只认
 * `x` / `y`，多写的 `left` / `top` **既不报错也不生效**，窗口直接按默认
 * 位置（屏幕居中）出现。后果是两个球**精确重叠在屏幕正中**，用户只看得到
 * 上面那一个 —— 而 orb-positions.json 里明明存着两个不同的坐标，
 * 看上去一切正常。这类"参数名写错但完全静默"的错误只能靠实测发现。
 */
const frameFor = (center, size, workArea) => {
    const maxX = workArea.x + workArea.width - size.w - MARGIN;
    const maxY = workArea.y + workArea.height - size.h - MARGIN;
    const x = clamp(Math.round(center.x - size.w / 2), workArea.x + MARGIN, maxX);
    const y = clamp(Math.round(center.y - size.h / 2), workArea.y + MARGIN, maxY);
    return { x, y, width: size.w, height: size.h };
};

/** 默认球心。两个球错开，否则新用户只看得见上面那一个 */
const defaultCenter = (id, workArea) => {
    const def = ORB_DEFS[id];
    const right = workArea.x + workArea.width - MARGIN - BALL_SIZE / 2;
    const bottom = workArea.y + workArea.height - MARGIN - BALL_SIZE / 2;
    if (def.defaultCorner === 'bottom-right') return { x: right, y: bottom };
    /*
     * 'right'：右侧、纵向约 60% 处。
     *
     * 与右下角那颗**至少拉开一个球的距离**：两颗球都是 64px，而
     * "不重叠"的判据是球心距离 ≥ 64px。0.6 这个比例在 728px 高的工作区上
     * 给出约 291px 的纵向差，足够；但窗口很矮时（比如 400px）只有 240px，
     * 仍然够。真正的下限由下面的 max() 保证。
     */
    const y = workArea.y + Math.max(workArea.height * 0.6, BALL_SIZE * 1.5);
    return { x: right, y: Math.min(y, bottom - BALL_SIZE * 1.5) };
};

/* ========================================================================== */
/* 4. 窗口                                                                    */
/* ========================================================================== */

/** id → { win, open, center } */
const orbs = new Map();

/** 拖动开始时的抓取偏移，屏幕坐标 → 窗口左上角的差 */
const grabOffsets = new Map();

const isDev = () => !require('electron').app.isPackaged;

/**
 * 球窗口加载的页面。
 *
 * 两个球各是一个独立 HTML，而不是同一个页面靠 query 区分：分开之后各自的
 * bundle 只含自己要用的东西，Agent 那份不会把嗅探的列表组件也带上。
 */
const orbUrl = (id) => {
    if (isDev()) return `http://localhost:5173/orb/${id}.html`;
    return path.join(__dirname, '..', '..', 'dist', 'orb', `${id}.html`);
};

const createOrb = (id) => {
    if (orbs.has(id)) return orbs.get(id);

    const def = ORB_DEFS[id];
    const saved = positions[id];
    // 先用默认位置建窗口，再按存下来的球心收敛 —— 构造参数里给 left/top
    // 也躲不掉收敛这一步（存的值可能已经在屏幕外）
    const area = workAreaFor(saved ? { x: saved.x, y: saved.y } : null);
    const center = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
        ? { x: saved.x, y: saved.y }
        : defaultCenter(id, area);

    const frame = frameFor(center, { w: BALL_SIZE, h: BALL_SIZE }, area);

    const win = new BrowserWindow({
        ...frame,
        title: def.title,
        frame: false,
        transparent: true,
        // 不给这个的话 Windows 会填一层不透明底色，球外面套一个方块
        backgroundColor: '#00000000',
        // 关掉用户改尺寸：把球拉成长方形之后里面的圆不是被裁就是留白
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        // 球不该在任务栏里占一格。两个球占两格会让任务栏变脏
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'orb-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // 球要显示远程图片（嗅探到的缩略图）时才需要放宽，现在不需要
            webSecurity: true,
        },
    });

    const entry = { win, open: false, center };
    orbs.set(id, entry);

    const url = orbUrl(id);
    if (isDev()) win.loadURL(url);
    else win.loadFile(url);

    win.once('ready-to-show', () => {
        win.showInactive();
        // 收起态才置顶：展开成一个 440×640 的面板还压在所有窗口上面很烦人
        win.setAlwaysOnTop(true, 'floating');
    });

    win.on('closed', () => {
        orbs.delete(id);
    });

    return entry;
};

/* ========================================================================== */
/* 5. 展开 / 收起                                                             */
/* ========================================================================== */

const setOpen = (id, open) => {
    const entry = orbs.get(id);
    if (!entry) return;
    const def = ORB_DEFS[id];
    const size = open ? def.panel : { w: BALL_SIZE, h: BALL_SIZE };

    // 展开时以球心为中心铺开：球在哪，面板就从哪长出来
    const current = entry.win.getBounds();
    const center = { x: current.x + current.width / 2, y: current.y + current.height / 2 };

    const area = workAreaFor(center);
    entry.win.setBounds(frameFor(center, size, area));
    entry.win.setAlwaysOnTop(!open, 'floating');
    entry.open = open;

    // 把球心记下来。展开态的中心与球形态的中心在收敛后可能不同，
    // 但用户下次看到的是球，所以记球形态那个点
    if (!open) entry.center = center;

    entry.win.webContents.send('orb:layout', { open, ballSize: BALL_SIZE });
};

/* ========================================================================== */
/* 6. 拖动                                                                    */
/* ========================================================================== */

/**
 * 拖动走 IPC 手动挪窗口，不用 `-webkit-app-region: drag`。
 *
 * app-region 的写法有两个问题：
 *   1. **它吞掉鼠标事件**。同一块区域既要做拖动又要做点击展开，就得靠
 *      `no-drag` 的子元素把点击区抠出来，而那个子元素要正好是球心 —— 布局一变就错位；
 *   2. **区分不了拖动与点击**。app-region 的拖动由系统接管，我们拿不到
 *      "移动了多少"，于是"拖完松手"会被当成一次点击而把面板弹开。
 *
 * 手动挪则两个问题都不存在：位移是我们自己算的，阈值也是我们自己定的。
 */
const registerDrag = () => {
    ipcMain.on('orb:drag-start', (event, point) => {
        const id = idOfSender(event);
        if (!id) return;
        const entry = orbs.get(id);
        if (!entry) return;
        const b = entry.win.getBounds();
        grabOffsets.set(id, { x: point.x - b.x, y: point.y - b.y });
    });

    ipcMain.on('orb:drag-move', (event, point) => {
        const id = idOfSender(event);
        if (!id) return;
        const entry = orbs.get(id);
        const grab = grabOffsets.get(id);
        if (!entry || !grab) return;

        const size = entry.open
            ? ORB_DEFS[id].panel
            : { w: BALL_SIZE, h: BALL_SIZE };
        const target = { x: point.x - grab.x, y: point.y - grab.y };
        // 拖动时按窗口左上角直接落位，不做球心收敛 —— 那样手感会发飘
        const area = workAreaFor({ x: target.x + size.w / 2, y: target.y + size.h / 2 });
        entry.win.setBounds({
            x: clamp(target.x, area.x - size.w + 40, area.x + area.width - 40),
            y: clamp(target.y, area.y, area.y + area.height - 40),
            width: size.w,
            height: size.h,
        });
    });

    ipcMain.on('orb:drag-end', (event) => {
        const id = idOfSender(event);
        if (!id) return;
        grabOffsets.delete(id);
        const entry = orbs.get(id);
        if (!entry) return;
        const b = entry.win.getBounds();
        entry.center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        positions[id] = entry.center;
        savePositions();
    });
};

/**
 * 从 IPC 事件反查是哪个球。
 *
 * 不用 `event.sender.id` 建表：窗口可能被销毁重建，而表要跟着维护。
 * 直接拿 sender 与现存窗口比对，任何时候都是准的。
 */
const idOfSender = (event) => {
    for (const [id, entry] of orbs) {
        if (entry.win.webContents === event.sender) return id;
    }
    return null;
};

/* ========================================================================== */
/* 7. 启动                                                                    */
/* ========================================================================== */

const createOrbs = () => {
    loadPositions();
    registerDrag();
    for (const id of ORB_IDS) createOrb(id);
};

/**
 * 重新显示两个球。
 *
 * 球没有关闭按钮（无边框窗口没有系统菜单），所以正常路径下它们一直在。
 * 这个入口给"窗口被意外销毁"兜底 —— 也留给主窗口以后做开关用。
 */
const showOrbs = () => {
    for (const id of ORB_IDS) {
        const entry = orbs.get(id);
        if (entry) entry.win.showInactive();
        else createOrb(id);
    }
};

/** 让两个球随主窗口一起退出。不这么做的话主窗口关了球还留着，进程不退出 */
const destroyOrbs = () => {
    for (const [, entry] of orbs) {
        if (!entry.win.isDestroyed()) entry.win.destroy();
    }
    orbs.clear();
};

/** 广播用：所有活着的球窗口 */
const entriesForBroadcast = () => [...orbs.entries()].filter(([, entry]) => !entry.win.isDestroyed());

/**
 * 一个球窗口的真实状态。
 *
 * 存在的理由是**让"球是置顶的"这条承诺可验证**：`setAlwaysOnTop` 的返回值
 * 只说明"调用没报错"，不说明系统真的把它置于顶层。要判断只能回头问
 * `isAlwaysOnTop()` —— 而那个 API 只在主进程里。
 *
 * 同理 `isResizable` / `isMovable`：它们是窗口管理器的实际状态，
 * 渲染层看不到，而"用户把球拉成长方形"这类故障恰恰只能从这里查。
 */
const windowInfo = (id) => {
    const entry = orbs.get(id);
    if (!entry) return null;
    const win = entry.win;
    const bounds = win.getBounds();
    return {
        id,
        bounds,
        open: entry.open,
        isAlwaysOnTop: win.isAlwaysOnTop(),
        isResizable: win.isResizable(),
        isMovable: win.isMovable(),
        isVisible: win.isVisible(),
        isDestroyed: win.isDestroyed(),
    };
};

module.exports = {
    createOrbs,
    showOrbs,
    destroyOrbs,
    setOpen,
    idOfSender,
    entriesForBroadcast,
    windowInfo,
    BALL_SIZE,
    ORB_DEFS,
    ORB_IDS,
};
