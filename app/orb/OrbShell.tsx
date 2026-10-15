import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 悬浮球的外壳：收起是一颗球，展开是一个面板。
 *
 * ## 尺寸由主进程决定，这里只负责画
 *
 * 窗口的 width/height 是主进程 `setBounds` 改的，渲染层改不了也**不该改** ——
 * 渲染层算出的尺寸和窗口实际尺寸一旦不一致，就会在球形态下露出面板的一角，
 * 或者面板被裁掉一截。所以这里只切"画成球"还是"画成面板"，
 * 尺寸一律 `w-full h-full` 跟着窗口走。
 *
 * 拖动与缩放同理：这里只报**屏幕坐标**，窗口怎么挪、能缩到多小都在主进程里
 * （见 app/main/orbs.js 的第 6、7 节）。
 *
 * ## 拖动与点击必须分开
 *
 * 球的交互有三个：拖、点开、以及拖完松手的那一次 click。第三个别处理的话，
 * 每次拖完都会把面板弹开。所以位移超过阈值就标记为拖动，松手后 50ms 内
 * 忽略 click —— 那个 click 是浏览器补发的，不是用户想展开。
 */

export interface OrbShellProps {
    /** 球心的图标 */
    icon: ReactNode;
    /** 球的渐变（Tailwind 的 from/via/to 组合） */
    accent: string;
    label: string;
    hint: string;
    /** 标题栏右侧的额外控件 */
    toolbar?: ReactNode;
    children: ReactNode;
}

/** 位移小于这个值算点击，不算拖动 */
const DRAG_THRESHOLD_PX = 4;

export const OrbShell = ({ icon, accent, label, hint, toolbar, children }: OrbShellProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const hasMoved = useRef(false);
    const raf = useRef<number | null>(null);
    /* 缩放与拖动各自一套状态，理由见下面 onResizeDown 那段 */
    const [isResizing, setIsResizing] = useState(false);
    const resizeRaf = useRef<number | null>(null);

    /*
     * 主进程改了窗口尺寸 → 切换形态。尺寸本身不在这里设，见文件头。
     *
     * 顺手把两条手势状态清掉：拖到一半按 Esc（收起）时，指针捕获还挂在
     * 那个 header 上，而 header 随形态切换被卸载了 —— pointerup 落到球身上，
     * 而球身上那次 `isDragging` 已经是 false，于是提前 return。
     * 结果是两个标记都留着：
     *   · `isDragging` / `isResizing` 留着 → 下一次 pointermove 被当成"还在拖"；
     *   · `hasMoved` 留着 → 球的 onClick 永远认为"刚拖过"，**点不开了**。
     * 主进程那边也在 setOpen 里清基准，同一个理由。
     */
    useEffect(() => {
        const off = window.orbApi?.onLayout(({ open }) => {
            setIsOpen(open);
            setIsDragging(false);
            setIsResizing(false);
            hasMoved.current = false;
        });
        return off;
    }, []);

    /* ESC 收起。主进程据此把窗口缩回球 */
    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') window.orbApi?.setOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isOpen]);

    const onPointerDown = useCallback((event: React.PointerEvent) => {
        /*
         * 展开态的 header 里有按钮（工具条、收起）。在这些控件上按下是要点击，
         * 不是要拖窗口 —— 一旦 preventDefault + 抓指针，按钮就点不动了。
         */
        if ((event.target as HTMLElement).closest('button, input, textarea, select, a')) return;
        event.preventDefault();
        setIsDragging(true);
        hasMoved.current = false;
        /*
         * 抓在 handler 挂着的那个元素上，不是 `event.target`。
         *
         * header 里的图标、标题都是子元素，抓到子元素上时指针事件只在
         * 那个子元素范围内重定向；虽然能冒泡上来，但只要那个子元素在拖动
         * 过程中被重渲染换掉，捕获就一起没了。
         */
        event.currentTarget.setPointerCapture(event.pointerId);
    }, []);

    const onPointerMove = useCallback((event: React.PointerEvent) => {
        if (!isDragging) return;
        /*
         * 用 screenX/screenY 而不是 clientX/clientY。
         *
         * clientX 是**相对窗口**的，而窗口正在跟着鼠标移动 —— 用它算位移会
         * 形成反馈：窗口挪一点，鼠标相对窗口的位置就变回去，表现为球跟不上手
         * 或者疯狂抖动。screen 坐标是绝对屏幕坐标，不受窗口移动影响。
         */
        const point = { x: event.screenX, y: event.screenY };
        if (!hasMoved.current) {
            hasMoved.current = true;
            window.orbApi?.dragStart(point);
            return;
        }
        /* rAF 合并：pointermove 一帧能来好几次，每次都发 IPC 是纯浪费 */
        if (raf.current !== null) return;
        raf.current = window.requestAnimationFrame(() => {
            raf.current = null;
            window.orbApi?.dragMove(point);
        });
    }, [isDragging]);

    const onPointerUp = useCallback((event: React.PointerEvent) => {
        if (!isDragging) return;
        setIsDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (hasMoved.current) {
            window.orbApi?.dragEnd();
            /*
             * 拖完松手浏览器会补一个 click。不把标记多留一会儿，那次 click
             * 会被当成"点击展开" —— 表现为"一拖就开"。
             */
            window.setTimeout(() => {
                hasMoved.current = false;
            }, 50);
        }
    }, [isDragging]);

    const onClick = useCallback(() => {
        if (isOpen || hasMoved.current) return;
        window.orbApi?.setOpen(true);
    }, [isOpen]);

    /*
     * 缩放把手。
     *
     * 与拖动是**两套独立状态**：拖到一半又去抓把手时，共用一套标记会让两条
     * 路径互相改写对方的基准点，窗口会跳。主进程那边同理（resizeAnchors）。
     *
     * 用 `screenX/screenY` 的理由与拖动相同 —— 窗口正在跟着手改尺寸，
     * clientX 是相对窗口的，会形成反馈。
     *
     * 这里**只报指针位置**，尺寸怎么算全在主进程（增量、下限、贴边平移）。
     * 渲染层自己算的话，那几条约束就得分叉成两份。
     */
    const onResizeDown = useCallback((event: React.PointerEvent) => {
        // 防的是浏览器把这次按下当成选择/原生拖拽的起点（面板本身已 select-none）
        event.preventDefault();
        setIsResizing(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        window.orbApi?.resizeStart({ x: event.screenX, y: event.screenY });
    }, []);

    const onResizeMove = useCallback((event: React.PointerEvent) => {
        if (!isResizing) return;
        const point = { x: event.screenX, y: event.screenY };
        /* rAF 合并：pointermove 一帧能来好几次，每次都发 IPC 是纯浪费 */
        if (resizeRaf.current !== null) return;
        resizeRaf.current = window.requestAnimationFrame(() => {
            resizeRaf.current = null;
            window.orbApi?.resizeMove(point);
        });
    }, [isResizing]);

    const onResizeUp = useCallback((event: React.PointerEvent) => {
        if (!isResizing) return;
        setIsResizing(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        window.orbApi?.resizeEnd();
    }, [isResizing]);

    /*
     * 球的容器是**正方形**，且必须与窗口等大。
     *
     * 窗口本身是透明的，所以"球"其实是这个容器里的一个圆。容器用
     * `rounded-full` + `overflow-hidden`，圆角外的部分才不会画出来。
     */
    if (!isOpen) {
        return (
            <div
                className="animate-orb-unfold h-full w-full cursor-grab select-none active:cursor-grabbing"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onClick={onClick}
                title={`${label} · ${hint}`}
            >
                <div className="relative h-full w-full rounded-full">
                    {/*
                     * 呼吸光晕。
                     *
                     * 用 `.orb-halo`（mask 径向淡出）而不是 `blur-*`：
                     * blur 会向外扩散到窗口之外并被裁成直角，球外面就会
                     * 出现一个方块。见 orb.css 里那段说明。
                     *
                     * 它铺满整个窗口而不是 `inset-*` —— 淡出位置由 mask 控制，
                     * 不需要靠 inset 躲开边界。
                     */}
                    <span
                        className={`orb-halo animate-orb-breath pointer-events-none absolute inset-0 rounded-full bg-gradient-to-br ${accent} opacity-70`}
                    />
                    <span className={`absolute inset-2 rounded-full bg-gradient-to-br ${accent} opacity-95`} />
                    <span className="orb-specular pointer-events-none absolute inset-2 rounded-full" />
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.65)]">
                        {icon}
                    </span>
                </div>
            </div>
        );
    }

    return (
        /*
         * 两层：外层只做定位，内层是面板本体。
         *
         * 必须分开，因为内层带 `rounded-2xl` + `overflow-hidden` —— 那是给
         * 内容用的圆角。缩放把手正好落在右下角那个 16px 圆角上，被它一裁就
         * 只剩一半命中区（圆角切掉的是弓形，占三角形面积的 57%）。
         * 把手是**边框级**的东西，不该被表面裁。
         */
        <div className="animate-orb-unfold relative h-full w-full font-sans text-slate-200 select-none">
            {/*
              面板底色：**不用 `backdrop-blur`**。

              底色本来就写到了 95% 不透明，模糊层剩给用户看的只有那 5% ——
              视觉上几乎为零，代价却是真的：透明窗口的 backdrop-filter 要求
              合成器每帧重新抓取并模糊窗口**背后的桌面内容**，而面板展开时
              一直在动（流式输出、滚动、拖拽）。换成实色之后画面几乎一样，
              每帧省下一次全窗模糊。

              不透明度从 95% 提到 97%：文字压在深底上更实，读数更清楚。
            */}
            <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/12 bg-slate-950/[0.97] shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
                {/*
                 * 只有 header 是拖动区。面板本体挂着滚动列表和输入框，
                 * 整块都可拖的话选不中文字、点不到按钮。
                 */}
                <header
                    className="flex shrink-0 cursor-grab items-center gap-2.5 border-b border-white/10 px-3 py-2.5 active:cursor-grabbing"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                >
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${accent} text-white`}>
                        {icon}
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-white">{label}</span>
                        <span className="block truncate text-[10px] text-slate-400">{hint}</span>
                    </span>
                    {toolbar}
                    <button
                        type="button"
                        onClick={() => window.orbApi?.setOpen(false)}
                        title="收起（Esc）"
                        aria-label="收起"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-slate-400 transition hover:border-white/20 hover:bg-white/[0.12] hover:text-white"
                    >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
                            <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                    </button>
                </header>
                {/*
                 * `select-text` 是**必要的覆盖**，不是冗余。
                 *
                 * 面板根节点带 `select-none`（拖动与点按钮时不该选中文字），
                 * 而那个属性会被子元素继承 —— 于是内容区里的工具返回值、
                 * 脚本、对话正文全都选不中，用户想复制一段报错去查都做不到。
                 * 内容区自己声明可选，选择范围不会越出这里。
                 */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden select-text">{children}</div>
            </div>
            {/*
              右下角的缩放把手。

              形状是**角上的三角形**而不是一个方块：方块会压住面板右下角的内容
              （Agent 的「发送」按钮离右下角只有 8px，方块热区正好盖住它的一角，
              点在那里会变成缩放而不是发送）。三角形只覆盖
              `离右边距离 + 离下边距离 ≤ 16` 的区域，与那个 8×8 的角只有一个点相切。

              `clip-path` 同时裁掉命中区（不只是绘制），所以三角形既是外观也是热区，
              不需要额外写一层判据。

              只画右下角、不画整条边：透明窗口没有窗口边框，整条边的热区会盖住
              列表行尾的按钮（"播放"/"下载"就在那一列）。
            */}
            <div
                onPointerDown={onResizeDown}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeUp}
                onPointerCancel={onResizeUp}
                title="拖动调整面板大小"
                aria-label="调整面板大小"
                className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize text-slate-600 transition hover:text-slate-300 [clip-path:polygon(100%_0,100%_100%,0_100%)]"
            >
                {/* 两条斜线离角 5px 与 10px，都落在三角形内，不会被裁掉半截 */}
                <svg
                    className="pointer-events-none absolute right-0 bottom-0 h-4 w-4"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.4}
                    strokeLinecap="round"
                    aria-hidden="true"
                >
                    <path d="M15 6L6 15M15 11L11 15" />
                </svg>
            </div>
        </div>
    );
};
