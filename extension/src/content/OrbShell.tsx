import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CloseIcon } from './icons';
import { ORB_MARGIN, useOrbDrag } from './useOrbDrag';
import type { OrbPosition } from './useOrbDrag';

/**
 * 悬浮球外壳：折叠态是一颗球，展开态是一个面板。
 *
 * ## 只做形状，不做业务
 *
 * 这个组件不认识嗅探也不认识 Agent。它管三件事：拖动、展开/收起、把标题栏画出来。
 * 两个球各自把内容当 children 传进来，因此**各自的 state 完全独立** ——
 * 收起 A 球不会碰 B 球的任何东西，两边也不会因为共用一个容器而互相重渲染。
 *
 * ## 为什么折叠态和展开态是同一个元素
 *
 * 用两个元素（球一个、面板一个）时，展开的动画只能靠"球消失 + 面板出现"，
 * 中间那一帧两者都在或都不在。同一个元素改 width/height/border-radius 则是
 * 连续的形变，且位置由同一份 position 决定 —— 展开后球心不会跳。
 *
 * ## 展开后为什么不再跟随 position
 *
 * 面板按视口留边距铺开，不按球的位置推算尺寸：小窗口下按球的位置推会溢出，
 * 于是又得加一套"打开状态下挪不动"的约束。铺开之后这个分支从根上没有了。
 */

export interface OrbShellProps {
    /** 位置落盘键。两个球必须用不同的键，否则它们会抢同一个坐标 */
    storageKey: string;
    /** 折叠态直径 */
    ballSize: number;
    /** 展开态尺寸。按视口算，不用百分比：内容区需要确定的高度才能滚动 */
    panelSize: { w: number; h: number };
    label: string;
    hint: string;
    /** 球的渐变，Tailwind 的 from/via/to 组合 */
    accent: string;
    icon: ReactNode;
    /** 标题栏右侧的额外控件（如"清空"） */
    toolbar?: ReactNode;
    /** 面板内容。只在展开时渲染 —— 见下方注释 */
    children: ReactNode;
}

/** 展开与收起的形变时长，与 style 里的 transition 必须一致 */
const MORPH_MS = 280;

export const OrbShell = ({
    storageKey,
    ballSize,
    panelSize,
    label,
    hint,
    accent,
    icon,
    toolbar,
    children,
}: OrbShellProps) => {
    const [isOpen, setIsOpen] = useState(false);

    const footprint = useMemo(
        () => (isOpen ? panelSize : { w: ballSize, h: ballSize }),
        [isOpen, ballSize, panelSize],
    );

    /*
     * 默认落在右侧偏下的位置。
     *
     * 两个球的默认位置必须错开：都落在同一个角落时它们会完全重叠，
     * 用户只会看到上面那一个，另一个"不见了"。
     */
    const fallback = useMemo(
        () => (): OrbPosition => ({
            x: window.innerWidth - ballSize - ORB_MARGIN - 8,
            y: window.innerHeight - ballSize - ORB_MARGIN - 8,
        }),
        [ballSize],
    );

    const drag = useOrbDrag(storageKey, footprint, fallback);

    /* 展开 / 收起换了尺寸，位置要重新收进视口 */
    useEffect(() => {
        drag.reclamp();
        // reclamp 是稳定引用，这里只在开合时触发一次
    }, [isOpen, drag.reclamp]);

    /* ESC 收起。只在本球展开时挂，避免两个球都展开时一次 ESC 关掉两个 */
    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isOpen]);

    const style = useMemo(() => {
        const ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
        /*
         * 显式列出补间属性，不用 `all`。
         *
         * `all` 会把 background、border-color、box-shadow 一并补间，
         * 拖动时每帧都要重算这些与位置无关的属性。transform 必须留在列表里：
         * 内联的 transition 会盖掉类上的 `transition-transform`，
         * 漏掉它 `hover:scale-105` 就成了瞬变。
         */
        const transition = drag.isDragging
            ? 'none'
            : `left ${MORPH_MS}ms ${ease}, top ${MORPH_MS}ms ${ease}, `
              + `width ${MORPH_MS}ms ${ease}, height ${MORPH_MS}ms ${ease}, `
              + `border-radius ${MORPH_MS}ms ${ease}, transform 200ms ${ease}`;

        return isOpen
            ? {
                  left: `${ORB_MARGIN}px`,
                  top: `${ORB_MARGIN}px`,
                  width: `${panelSize.w}px`,
                  height: `${panelSize.h}px`,
                  borderRadius: '20px',
                  transition,
              }
            : {
                  left: `${drag.position.x}px`,
                  top: `${drag.position.y}px`,
                  width: `${ballSize}px`,
                  height: `${ballSize}px`,
                  borderRadius: '9999px',
                  transition,
              };
    }, [isOpen, drag.isDragging, drag.position, ballSize, panelSize]);

    return (
        <div
            /*
             * `pointer-events-auto` 不能省：宿主容器是 `pointer-events: none`
             * （它铺满视口，不挡住页面的任何点击），球必须显式把自己恢复成可点击，
             * 否则整个球点不动 —— 表现为"球在那儿但没反应"。
             */
            className={`pointer-events-auto fixed z-[2147483646] flex flex-col overflow-hidden font-sans text-slate-200 select-none ${
                isOpen
                    ? 'border border-white/12 bg-slate-950/92 shadow-[0_24px_80px_rgba(0,0,0,0.65)] backdrop-blur-2xl'
                    : 'cursor-grab border border-white/25 bg-slate-950/80 shadow-[0_12px_36px_rgba(0,0,0,0.6)] hover:scale-105 active:scale-95 active:cursor-grabbing'
            }`}
            style={style}
            onPointerDown={!isOpen ? drag.onPointerDown : undefined}
            onPointerMove={!isOpen ? drag.onPointerMove : undefined}
            onPointerUp={!isOpen ? drag.onPointerUp : undefined}
            onClick={
                !isOpen
                    ? () => {
                          /* 拖完松手的那次 click 不该展开面板，见 useOrbDrag */
                          if (!drag.hasMoved.current) setIsOpen(true);
                      }
                    : undefined
            }
        >
            {!isOpen && (
                <>
                    {/*
                     * 呼吸光晕。只补间 scale，opacity 留给 hover ——
                     * 关键帧里写 opacity 会把它永久压死（CSS 动画优先级高于普通声明）。
                     */}
                    <span
                        className={`animate-orb-breath pointer-events-none absolute -inset-2 rounded-full bg-gradient-to-br ${accent} opacity-50 blur-lg`}
                    />
                    <span className={`absolute inset-[4px] rounded-full bg-gradient-to-br ${accent} opacity-90`} />
                    <span className="orb-specular pointer-events-none absolute inset-[4px] rounded-full" />
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
                        {icon}
                    </span>
                </>
            )}

            {isOpen && (
                <>
                    <header className="flex shrink-0 items-center gap-2.5 border-b border-white/10 px-3 py-2.5">
                        <span
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${accent} text-white`}
                        >
                            {icon}
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-semibold text-white">{label}</span>
                            <span className="block truncate text-[10px] text-slate-400">{hint}</span>
                        </span>
                        {toolbar}
                        <button
                            type="button"
                            onClick={() => setIsOpen(false)}
                            title="收起（Esc）"
                            aria-label="收起"
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-slate-400 transition hover:border-white/20 hover:bg-white/[0.12] hover:text-white"
                        >
                            <CloseIcon className="h-3.5 w-3.5" />
                        </button>
                    </header>
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
                </>
            )}
        </div>
    );
};
