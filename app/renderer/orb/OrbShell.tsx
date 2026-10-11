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

    /* 主进程改了窗口尺寸 → 切换形态。尺寸本身不在这里设，见文件头 */
    useEffect(() => {
        const off = window.orbApi?.onLayout(({ open }) => setIsOpen(open));
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
        <div className="animate-orb-unfold flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/12 bg-slate-950/95 font-sans text-slate-200 shadow-[0_24px_80px_rgba(0,0,0,0.7)] select-none backdrop-blur-2xl">
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
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
        </div>
    );
};
