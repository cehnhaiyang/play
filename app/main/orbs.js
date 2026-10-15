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
 * ## 置顶必须是**常驻**的，展开时也不能取消
 *
 * 曾经写成"收起态才置顶，展开成一个面板还压在所有窗口上面很烦人"。那是错的，
 * 而且是实测出来的：置顶窗口（WS_EX_TOPMOST）与普通窗口**不在同一个 Z 序带**里，
 * 一个普通窗口无论怎么点、怎么抢焦点，都盖不住置顶窗口 —— 反过来也一样，
 * 一旦把置顶取消，球立刻掉到**所有**普通窗口下面，而不只是"不再压着别人"。
 *
 * 症状就是"球不在最上层"：桌面上任何窗口（浏览器、资源管理器、甚至被最小化
 * 又恢复的那个）都能把它盖住，而用户点球是点不到的。实测数据：
 * 展开前球心处 `WindowFromPoint` 是球自己，展开后同一个点变成了浏览器窗口。
 *
 * ## 每个球一个独立窗口
 *
 * 不是"一个窗口放两个球"。两个球各自有生命周期、各自的位置、各自的展开尺寸，
 * 塞进一个窗口就必须共享一个矩形 —— 而那个矩形要同时满足"球形态"和"面板形态"，
 * 结果是两个都做不好。分开之后每个窗口只有一种形态，尺寸就是内容尺寸。
 *
 * ## 尺寸：球是固定的，面板由用户拖
 *
 * 球永远是 `BALL_SIZE` 的正方形（圆被拉长就不是圆了），所以 `resizable` 始终
 * 关着，展开态的面板大小由渲染层右下角那个把手驱动（见第 7 节）。
 * 尺寸与球心的唯一权威是 `entry.panel` / `entry.center`，落盘走 `savePositions`。
 *
 * ## 球心的唯一写入口是拖动
 *
 * `entry.center` 是"球在哪"这件事的唯一权威，而它**只能由用户拖动来改**。
 * 展开、收起、缩放都只读它。
 *
 * 这条约束是实测事故换来的：早期有三处从窗口矩形反推球心 —— `setOpen`、
 * `resize-end`、以及 `drag-end`。反推只在"窗口正好是球"时成立，而收起/缩放/
 * 拖动面板的那一帧窗口是**面板**，面板中心根本不是球心（贴边被收敛时差 277px）。
 * 于是"球放左上角，展开一次再收起，球跑到屏幕中间"；同理，拉一下面板大小、
 * 或者按住标题栏挪一下面板，收起后球都会漂走（实测 416px / 315px）。
 * 三处修掉之后，全仓库 `entry.center` 的赋值只剩拖动一处。
 *
 * 判据不是"有没有写它"，而是**写进去的那个值从哪来**：只要来源是某个窗口矩形
 * 的中心，就是同一个 bug 复发。测试里有一条断言盯住赋值点数量（见
 * test/mainstatic.test.js 的第 8 条）。
 *
 * ## 透明窗口的三条约束
 *
 * 1. **`transparent: true` 必须配 `frame: false`**，两者一起才有意义。
 * 2. **必须给 `backgroundColor: '#00000000'`**。不给的话 Windows 上会填一层
 *    不透明底色，表现为"球外面套了个方块"。
 * 3. **不能开 `resizable`**。理由见上一节 —— 球形态下用户拖窗口边缘会把圆
 *    拉成长方形，而面板形态我们自己画把手，比系统那圈看不见的边框更准。
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
        /**
         * 展开态的**初始**尺寸。用户可以拖右下角改，改完存下来 ——
         * 真正的当前尺寸在 `entry.panel` 里，这里只是第一次开面板时用的值。
         */
        panel: { w: 380, h: 520 },
        /** 能拖到的最小尺寸。再窄列表行就挤成一团，再矮就只剩标题栏 */
        panelMin: { w: 300, h: 320 },
        /** 默认位置：右下角 */
        defaultCorner: 'bottom-right',
    },
    agent: {
        title: 'Agent',
        /** 对话比嗅探列表高：要留出输入框与多轮消息 */
        panel: { w: 440, h: 640 },
        /** 比嗅探宽：顶部那排标签页在 360 以下会折成两行 */
        panelMin: { w: 360, h: 400 },
        /** 默认位置：右侧中部偏下。与嗅探球错开，否则两个球完全重叠 */
        defaultCorner: 'right',
    },
};

const ORB_IDS = Object.keys(ORB_DEFS);

/* ========================================================================== */
/* 2. 位置持久化                                                              */
/* ========================================================================== */

/**
 * 几何存 userData 下的一个 JSON，不用 electron-store 之类的依赖。
 *
 * 一条记录是 `{ x, y, w, h }`：球心 + 面板尺寸。
 *
 * 位置存的是**球心**而不是左上角：展开时球心不动、面板围着它铺开，
 * 收起时回到同一个球心。存左上角的话展开一次位置就漂了 —— 因为展开态的
 * 左上角与球形态的左上角不是同一个点。尺寸则是用户拖右下角把手定下来的。
 *
 * 加入尺寸之前的记录只有 `{ x, y }`，读进来 `w`/`h` 是 undefined ——
 * `clampPanel` 按默认尺寸兜底，位置照旧生效。所以文件名不变、也不需要迁移：
 * 缺字段就是"这个球还没被调过大小"。
 */
const positionsFile = () => path.join(require('electron').app.getPath('userData'), 'orb-positions.json');

/** id → { x, y, w, h }。w/h 可能缺失，见上面 */
let positions = {};

const loadPositions = () => {
    try {
        positions = JSON.parse(fs.readFileSync(positionsFile(), 'utf8')) || {};
    } catch {
        // 首次运行或文件损坏：用默认几何，不报错
        positions = {};
    }
};

/**
 * 落盘，**唯一的写入口**。
 *
 * 拖动与缩放各改各的字段（`entry.center` / `entry.panel`），存的时候统一
 * 从这里读。两处各拼一份 JSON 的话，后写的那个会把先写的那个的字段抹掉 ——
 * 表现为"挪一下位置，之前调好的尺寸就回去了"。
 */
const savePositions = (id, entry) => {
    positions[id] = { ...entry.center, ...entry.panel };
    try {
        fs.writeFileSync(positionsFile(), JSON.stringify(positions, null, 2), 'utf8');
    } catch {
        // 写不进去最多是下次启动几何复位，不值得打断用户
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
 * 把一组尺寸收敛成这个球合法的面板尺寸。
 *
 * 上下限在这里收口，**不与渲染层的把手尺寸重复**：把手只是"哪里能抓"，
 * 能拖到多小多大由主进程说了算 —— 工作区与最小尺寸都是只有主进程才知道的事实。
 *
 * 每次展开都重新过一遍：分辨率变小或显示器拔掉之后，上次那个 900×1400 的
 * 面板会比工作区还大，而 `frameFor` 只保证左上角在屏内 —— 右下角连同缩放
 * 把手一起被推到屏幕外，用户既看不到内容也拖不回来。
 */
const clampPanel = (id, size, workArea) => {
    const def = ORB_DEFS[id];
    const min = def.panelMin;
    const maxW = Math.max(min.w, (workArea?.width ?? 1920) - MARGIN * 2);
    const maxH = Math.max(min.h, (workArea?.height ?? 1080) - MARGIN * 2);
    return {
        w: Math.round(clamp(Number(size?.w) || def.panel.w, min.w, maxW)),
        h: Math.round(clamp(Number(size?.h) || def.panel.h, min.h, maxH)),
    };
};

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

/** id → { win, open, center, panel } */
const orbs = new Map();

/**
 * 拖动开始时的基准，屏幕坐标 → 窗口左上角的差。
 *
 * 记两项：`grab` 是指针在窗口里的落点（拖动时照着它算窗口左上角），
 * `ball` 是**球心**在窗口里的落点（拖动结束时照着它还原球心）。
 *
 * 为什么球心要单独记：展开态的窗口是面板，而面板中心不是球心 —— 面板被
 * `frameFor` 收敛贴边时两者能差 277px。所以球心不能在拖动结束时从窗口矩形
 * 反推，只能在开始那一刻记下相对位置。收起态两者恰好相等，因此"反推"这种
 * 写法只在展开态下暴露（见第 6 节）。
 */
const dragAnchors = new Map();

/** 缩放开始时的锚点偏移，屏幕坐标 → 窗口左上角的差。与拖动分开，见第 7 节 */
const resizeAnchors = new Map();

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
    /*
     * 球心按**收敛之后**的窗口矩形回写，让 `entry.center` 从第一帧起就等于
     * "球真正所在的那个点"。
     *
     * 存下来的球心可能落在工作区外（显示器拔掉、分辨率变小），`frameFor` 会把它
     * 拉回来。不回写的话 `entry.center` 与球的实际位置就不一致，而这个字段是
     * 展开/收起的唯一基准（见第 5 节）—— 等于把"球在哪"交给每个读它的地方
     * 各自靠 `frameFor` 去修。实测过：单看几何，回写与不回写的落点完全一样
     * （`frameFor` 的收敛是幂等的），所以这里买的是**不变量的可信**，不是可见行为。
     */
    center.x = frame.x + BALL_SIZE / 2;
    center.y = frame.y + BALL_SIZE / 2;

    const win = new BrowserWindow({
        ...frame,
        title: def.title,
        frame: false,
        transparent: true,
        // 不给这个的话 Windows 会填一层不透明底色，球外面套一个方块
        backgroundColor: '#00000000',
        /*
         * 始终关着。球形态下用户拖窗口边缘会把圆拉成长方形；面板形态下
         * 大小的入口是渲染层右下角那个把手（见第 7 节），不经过窗口边框 ——
         * 两种形态都不需要系统这圈热区。
         */
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        // 球不该在任务栏里占一格。两个球占两格会让任务栏变脏
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        /*
         * 置顶在**构造参数**里给，而不是等 ready-to-show 再调。
         *
         * 两者差在"球第一次画出来时是不是已经置顶"：构造参数生效于窗口创建，
         * `showInactive()` 之后不可能出现一帧没置顶的球。等到 ready-to-show
         * 再调的话，球会先以普通窗口的身份出现、再跳上去 —— 用户看到的是
         * 球闪一下才到最上层，而且这一帧里点它会被下面的窗口接走。
         */
        alwaysOnTop: true,
        webPreferences: {
            preload: path.join(__dirname, 'orb-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // 球要显示远程图片（嗅探到的缩略图）时才需要放宽，现在不需要
            webSecurity: true,
            /*
             * 关掉后台节流。
             *
             * 球窗口**从来不被聚焦**（`showInactive()` 起、拖动与点击都不抢焦点），
             * 而 Chromium 的默认节流对"未聚焦/被遮挡"的窗口会把定时器与动画帧
             * 压到 1fps 上下。后果有两个，都直接可见：
             *   · 流式输出时文字一顿一顿地跳（增量按帧合并，而帧被压掉了）；
             *   · 拖动与缩放跟手变差（rAF 合并的 IPC 一帧才发一次）。
             * 面板常驻可见、且是用户正在交互的窗口，节流在这里没有任何收益。
             */
            backgroundThrottling: false,
        },
    });

    const entry = { win, open: false, center, panel: clampPanel(id, saved, area) };
    orbs.set(id, entry);

    const url = orbUrl(id);
    if (isDev()) win.loadURL(url);
    else win.loadFile(url);

    win.once('ready-to-show', () => {
        win.showInactive();
        // 层级名 'floating'：悬浮球要压住普通窗口，但不该压住系统级的东西
        // （任务栏、输入法候选、UAC 弹窗）。'screen-saver' 那一档会盖住它们。
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

    /*
     * 收起时把两条手势的基准一起丢掉。
     *
     * 这是"球已经收起了"这件事的**唯一**落点，所以清理也放这里。不丢的话：
     * 拖到一半按 Esc，窗口缩回 64×64，而指针捕获还在渲染层手里 ——
     * 接下来任何一个 pointermove 都会带着旧基准算尺寸，把**球**撑成面板大小。
     * 拖动那边同理，只是后果轻一些（球被挪走）。
     */
    if (!open) {
        dragAnchors.delete(id);
        resizeAnchors.delete(id);
    }

    /*
     * 球心只有一个权威：`entry.center`（落盘，见第 2 节）。两个方向都从它出发 ——
     * 展开时面板围着它铺开，收起时球回到它上面。
     *
     * ⚠️ **不要从 `entry.win.getBounds()` 反推球心。**
     *
     * 反推在展开时看着没问题（那时窗口就是球，矩形中心正好是球心），收起时却是
     * 错的：那时窗口是**面板**，而面板被 `frameFor` 收敛回工作区之后，中心已经
     * 不在球心上了。实测症状：球放在左上角，展开再收起，球跑到屏幕中间 ——
     * 380×520 的面板围着左上角的球心铺开时被推到 (8,8)，中心变成 (198,268)，
     * 收起时按这个中心摆 64px 的球，落点就是 (166,236)。
     *
     * 反推还有个更隐蔽的坏处：它让"球在哪"变成窗口矩形的函数，于是展开态下
     * 任何一次窗口变动都会顺带改写球的位置。球心是**用户定下来的**，全仓库
     * 只有拖动结束（第 6 节）有权写它。
     */
    const area = workAreaFor(entry.center);

    /*
     * 尺寸的唯一权威是 `entry.panel`（初值来自落盘，见 createOrb），不是 ORB_DEFS。
     *
     * 用户拖过右下角之后面板就不该再弹回默认尺寸 —— 每次开面板都从 ORB_DEFS
     * 取的话，调整只在当次会话里有效，收起再展开就复位。拖动与缩放两条路径
     * 也读同一个字段，三处各算一份必然会漂。
     *
     * 展开时重新过一遍 `clampPanel`：换到更小的显示器上再展开时，上次存下的
     * 尺寸要当场收敛，而不是等下次重启。
     */
    const size = open ? (entry.panel = clampPanel(id, entry.panel, area)) : { w: BALL_SIZE, h: BALL_SIZE };

    entry.win.setBounds(frameFor(entry.center, size, area));
    /*
     * 改完尺寸**重申一次置顶**，而不是按 open 切换它。
     *
     * Windows 上改窗口尺寸会重建非客户区，某些路径下 WS_EX_TOPMOST 会跟着丢
     * （任务栏挪位、DPI 变化、以及"另一个置顶窗口刚被销毁"时都会触发重排）。
     * 重申的代价是一次 SetWindowPos，而丢掉的代价是球沉到所有窗口下面 ——
     * 用户点不到它，也没有任何办法把它叫回来（球没有系统菜单、不在任务栏里）。
     */
    entry.win.setAlwaysOnTop(true, 'floating');
    entry.open = open;

    entry.win.webContents.send('orb:layout', { open, ballSize: BALL_SIZE });
};

/* ========================================================================== */
/* 6. 拖动                                                                    */
/* ========================================================================== */

/**
 * 拖动开始那一刻的基准：指针与**球心**各自在窗口里的落点。
 *
 * 球心必须在这里记，不能在结束时从窗口矩形反推 —— 展开态的窗口是面板，
 * 面板中心不是球心（见 `centerAfterDrag`）。
 */
const dragAnchorAt = (frame, center, pointer) => ({
    grab: { x: pointer.x - frame.x, y: pointer.y - frame.y },
    /*
     * 收起态是 (BALL_SIZE/2, BALL_SIZE/2)；展开态两个分量都可能为负 ——
     * 面板贴左缘时球心就在面板左上角之外。
     */
    ball: { x: center.x - frame.x, y: center.y - frame.y },
});

/** 拖动中窗口的落点。按左上角直接落位，不做球心收敛 —— 那样手感会发飘 */
const frameWhileDragging = (target, size, area) => ({
    x: Math.round(clamp(target.x, area.x - size.w + 40, area.x + area.width - 40)),
    y: Math.round(clamp(target.y, area.y, area.y + area.height - 40)),
    width: size.w,
    height: size.h,
});

/**
 * 拖动结束后球心落在哪。
 *
 * **不是窗口矩形的中心。** 展开态下窗口是面板，而面板被 `frameFor` 收敛贴边时
 * 中心与球心相差可达 277px —— 用中心当球心的话，用户按住标题栏挪一下面板再
 * 收起，球就跑到别处去了。收起态下两者恰好相等，所以这个错法只在展开态暴露。
 *
 * 正确做法是拿开始那一刻记下的 `ball` 偏移还原：拖动是刚体平移，球与窗口的
 * 相对位置在整个拖动过程中不变。
 */
const centerAfterDrag = (frame, anchor) => ({ x: frame.x + anchor.ball.x, y: frame.y + anchor.ball.y });

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
        dragAnchors.set(id, dragAnchorAt(entry.win.getBounds(), entry.center, point));
    });

    ipcMain.on('orb:drag-move', (event, point) => {
        const id = idOfSender(event);
        if (!id) return;
        const entry = orbs.get(id);
        const anchor = dragAnchors.get(id);
        if (!entry || !anchor) return;

        // 展开态用 `entry.panel` 而不是 ORB_DEFS：拖过右下角之后，
        // 从默认尺寸取会把用户调好的面板在拖动第一帧就打回原形
        const size = entry.open
            ? entry.panel
            : { w: BALL_SIZE, h: BALL_SIZE };
        const target = { x: point.x - anchor.grab.x, y: point.y - anchor.grab.y };
        const area = workAreaFor({ x: target.x + size.w / 2, y: target.y + size.h / 2 });
        entry.win.setBounds(frameWhileDragging(target, size, area));
    });

    ipcMain.on('orb:drag-end', (event) => {
        const id = idOfSender(event);
        if (!id) return;
        const anchor = dragAnchors.get(id);
        dragAnchors.delete(id);
        const entry = orbs.get(id);
        if (!entry || !anchor) return;
        entry.center = centerAfterDrag(entry.win.getBounds(), anchor);
        savePositions(id, entry);
    });
};

/* ========================================================================== */
/* 7. 缩放                                                                    */
/* ========================================================================== */

/**
 * 面板大小由渲染层右下角那个把手驱动，走 IPC 让主进程改窗口。
 *
 * ## 为什么不用 `resizable: true` 让系统画边框
 *
 * 透明窗口的边框命中区在 Windows 上不可靠：`transparent: true` 的窗口没有
 * 非客户区，系统那圈 4~8px 的缩放热区**画不出来也测不准**，实测常常是
 * "抓不住"或者"抓到了但拖不动"。而且面板贴边处全是按钮（标题栏的收起、
 * 列表行尾的下载），一条看不见的热区会把它们的点击抢走。
 *
 * 自己画把手则命中区就是我们画的那块三角形，位置、层级、光标全在掌控里。
 *
 * ## 缩放与拖动必须是两套状态
 *
 * 共用一套 `dragAnchors` 的话，"拖到一半又去抓把手"会让两条路径互相改写
 * 对方的基准点，窗口会跳。所以下面用 `resizeAnchors` 单独记一份。
 */
const registerResize = () => {
    ipcMain.on('orb:resize-start', (event, point) => {
        const id = idOfSender(event);
        if (!id) return;
        const entry = orbs.get(id);
        // 球形态没有把手，收到就是异常状态，直接忽略
        if (!entry || !entry.open) return;
        const b = entry.win.getBounds();
        /*
         * 记的是**按下那一刻的完整基准**：指针位置 + 窗口矩形。
         *
         * 不能只记"指针 − 尺寸"这类差值：把手有 16px 宽，指针落在把手里的
         * 哪个像素是不确定的，用差值反推左上角会差出最多 16px ——
         * 表现为"一按下，面板先跳一下"。记原始值则是纯粹的增量，
         * 按下那一刻位移为 0，一点都不会动。
         */
        resizeAnchors.set(id, {
            pointer: { x: point.x, y: point.y },
            frame: { x: b.x, y: b.y, width: b.width, height: b.height },
        });
    });

    ipcMain.on('orb:resize-move', (event, point) => {
        const id = idOfSender(event);
        if (!id) return;
        const entry = orbs.get(id);
        const anchor = resizeAnchors.get(id);
        if (!entry || !anchor) return;

        const frame = frameForResize(id, point, anchor);
        entry.panel = { w: frame.width, h: frame.height };
        entry.win.setBounds(frame);
    });

    ipcMain.on('orb:resize-end', (event) => {
        const id = idOfSender(event);
        if (!id) return;
        resizeAnchors.delete(id);
        const entry = orbs.get(id);
        if (!entry) return;
        /*
         * 只落盘，**不回写球心**。
         *
         * 这里曾经从窗口矩形反推球心，而缩放中的窗口是面板 —— 于是"拉一下
         * 面板大小再收起，球就跑到别处去了"。实测：球在左上角时位移 416px，
         * 比 `setOpen` 那一处漂得还远。
         *
         * 根子上，面板的**位置**从来就不是要被记住的东西：`entry.panel` 是
         * `{ w, h }`，没有 x/y。面板在哪完全由球心与尺寸推出来（`frameFor`），
         * 所以缩放只该改尺寸，位置一个字都不该碰。球心的唯一写入口是拖动
         * （见第 6 节）。
         */
        savePositions(id, entry);
    });
};

/**
 * 一次缩放的目标矩形。
 *
 * ## 尺寸 = 起始尺寸 + 指针位移
 *
 * 右下角的把手，语义就是"右边缘与下边缘跟着指针走"。用增量而不是
 * "指针 − 某原点"，是为了让按下那一刻位移恰好为 0（见 resize-start 的注释）。
 *
 * ## 为什么必须允许窗口整体左移/上移
 *
 * 球的默认位置是**右下角**，而面板是围着球心铺开的，也就是面板的右边缘
 * 一开始就贴着工作区右缘。这时如果死钉左上角，可增长的空间是 0 ——
 * 用户会看到"把手拖得动，面板一动不动"。
 *
 * 所以贴边之后改成**整窗平移**：先把尺寸撑到指针要的大小，再把窗口整体
 * 收敛回工作区。表现是"面板顶到屏幕右边后继续往右拖，它向左长" ——
 * 和拖一个已经贴边的普通窗口一致。每次都从基准重算，往回拖会原路跟回来，
 * 不会累积偏移。
 *
 * 与 `clampPanel` 分开：那个的参照系是工作区本身（展开时的整体收敛），
 * 这个的参照系是**指针**（缩放时要跟手）。
 */
const frameForResize = (id, point, anchor) => {
    const def = ORB_DEFS[id];
    const { frame: from, pointer } = anchor;
    const area = workAreaFor({ x: from.x + from.width / 2, y: from.y + from.height / 2 });

    // 面板永远不该比工作区还大，否则把手会被挤出屏幕
    const maxW = Math.max(def.panelMin.w, area.width - MARGIN * 2);
    const maxH = Math.max(def.panelMin.h, area.height - MARGIN * 2);
    const width = Math.round(clamp(from.width + (point.x - pointer.x), def.panelMin.w, maxW));
    const height = Math.round(clamp(from.height + (point.y - pointer.y), def.panelMin.h, maxH));

    // 装不下时整体平移，而不是裁尺寸 —— 裁尺寸会让指针与边缘脱钩
    const x = Math.round(clamp(from.x, area.x + MARGIN, area.x + area.width - MARGIN - width));
    const y = Math.round(clamp(from.y, area.y + MARGIN, area.y + area.height - MARGIN - height));

    return { x, y, width, height };
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
    registerResize();
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
 *
 * `panel` 是**内存里的权威尺寸**，与 `bounds` 不一定相同：`bounds` 是窗口
 * 管理器回读的事实，`panel` 是我们记下来给下次展开用的。缩放自检要同时看
 * 这两个 —— 只看 `bounds` 说明不了"调完再收起展开还在不在"。
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
        panel: { ...entry.panel },
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
    // 纯几何，给 test/mainstatic.test.js 直接调用。它们不碰 Electron API，
    // 所以能在 Node 里跑 —— 而"缩放算得对不对"正是最容易悄悄错掉的一处。
    clampPanel,
    frameFor,
    frameForResize,
    // 拖动那条路径的几何：球心在展开态下不等于窗口中心，这个契约必须能被直接调用
    dragAnchorAt,
    frameWhileDragging,
    centerAfterDrag,
};
