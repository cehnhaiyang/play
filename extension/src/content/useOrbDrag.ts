import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

/**
 * 悬浮球的拖动、边缘吸附与位置持久化。
 *
 * ## 每个球一份，互不共享
 *
 * 两个球各自调用这个 hook，各自持有 position / isDragging。共享一份状态会让
 * "拖 A 球时 B 球跟着动"，而它们本来就该互不相干。
 *
 * ## 位置存 chrome.storage 而不是 localStorage
 *
 * content script 的 `localStorage` 是**页面的**，按 origin 隔离 —— 在 A 站
 * 摆好的位置，换到 B 站就复位到默认角落。`chrome.storage.local` 是扩展自己的，
 * 跨站点共享，这才是"用户摆好的位置"该待的地方。
 *
 * ## 位置必须按当前视口重新收敛
 *
 * 存下来的坐标来自**当时那个页面**的窗口尺寸。换到窄窗口直接用，球会落在
 * 视口外，表现为"球不见了"。所以读取时、resize 时、以及展开/收起换尺寸时
 * 都要 clamp 一次。
 */

export interface OrbPosition {
    x: number;
    y: number;
}

export interface OrbFootprint {
    w: number;
    h: number;
}

/** 球距视口边缘的最小留白 */
export const ORB_MARGIN = 12;

/** 拖动位移小于这个值算点击，不算拖动 */
const DRAG_THRESHOLD_PX = 4;

/** 释放时距左右边缘多近就吸附过去 */
const SNAP_THRESHOLD_PX = 72;

const clamp = (x: number, y: number, footprint: OrbFootprint): OrbPosition => ({
    x: Math.min(Math.max(ORB_MARGIN, x), Math.max(ORB_MARGIN, window.innerWidth - footprint.w - ORB_MARGIN)),
    y: Math.min(Math.max(ORB_MARGIN, y), Math.max(ORB_MARGIN, window.innerHeight - footprint.h - ORB_MARGIN)),
});

export interface OrbDrag {
    position: OrbPosition;
    isDragging: boolean;
    /** 拖动过程中是否真的移动过。用来把"拖完松手"和"点击"分开 */
    hasMoved: RefObject<boolean>;
    onPointerDown: (event: ReactPointerEvent) => void;
    onPointerMove: (event: ReactPointerEvent) => void;
    onPointerUp: (event: ReactPointerEvent) => void;
    /** 换尺寸（展开 / 收起面板）后把位置收回视口内 */
    reclamp: () => void;
}

export const useOrbDrag = (
    storageKey: string,
    footprint: OrbFootprint,
    fallback: () => OrbPosition,
): OrbDrag => {
    /*
     * footprint 走 ref 而不是进依赖数组。
     *
     * 展开面板时它从 56×56 变成 380×560，若作为依赖，下面每个 useCallback
     * 都会换一次身份 —— 而它们被挂到球的 DOM 事件上，换身份本身无害，
     * 但会让"拖动中展开"这类边界情况多一层时序要考虑。ref 每次渲染同步，
     * 读到的一定是当前值。
     */
    const footprintRef = useRef(footprint);
    footprintRef.current = footprint;

    const [position, setPosition] = useState<OrbPosition>(() => {
        const initial = fallback();
        return clamp(initial.x, initial.y, footprint);
    });
    const [isDragging, setIsDragging] = useState(false);

    const hasMoved = useRef(false);
    const dragOffset = useRef({ x: 0, y: 0 });
    const pointerStart = useRef({ x: 0, y: 0 });
    const pending = useRef(position);
    const raf = useRef<number | null>(null);

    /*
     * 读回落盘位置。
     *
     * 异步，所以首帧一定用的是 fallback —— 这是有意的：同步等 storage 会把球的
     * 首次出现推迟一个来回。读到之后再跳过去，位移发生在球已经可见之后。
     */
    useEffect(() => {
        let alive = true;
        void chrome.storage.local.get(storageKey).then((got) => {
            const saved = got[storageKey] as OrbPosition | undefined;
            if (!alive || !saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return;
            const next = clamp(saved.x, saved.y, footprintRef.current);
            pending.current = next;
            setPosition(next);
        });
        return () => {
            alive = false;
        };
    }, [storageKey]);

    const reclamp = useCallback(() => {
        setPosition((prev) => {
            const next = clamp(prev.x, prev.y, footprintRef.current);
            pending.current = next;
            return next;
        });
    }, []);

    /* 窗口尺寸变化：存下来的坐标可能已经落到视口外 */
    useEffect(() => {
        window.addEventListener('resize', reclamp);
        return () => window.removeEventListener('resize', reclamp);
    }, [reclamp]);

    /*
     * 拖动期间用 rAF 合并写 state。
     *
     * pointermove 一帧可以来好几次，每次都 setState 会让 React 在一帧里重渲染
     * 多遍。球的面板（嗅探列表、对话记录）都挂在这棵子树下，多渲染一次就是
     * 整份列表重建一次。
     */
    const update = useCallback((x: number, y: number) => {
        pending.current = clamp(x, y, footprintRef.current);
        if (raf.current !== null) return;
        raf.current = window.requestAnimationFrame(() => {
            raf.current = null;
            setPosition(pending.current);
        });
    }, []);

    useEffect(
        () => () => {
            if (raf.current !== null) window.cancelAnimationFrame(raf.current);
        },
        [],
    );

    /* 松手才落盘：拖动过程中每帧写一次 storage 是纯浪费 */
    const persist = useCallback(
        (next: OrbPosition) => {
            void chrome.storage.local.set({ [storageKey]: next });
        },
        [storageKey],
    );

    const onPointerDown = useCallback((event: ReactPointerEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDragging(true);
        hasMoved.current = false;
        pointerStart.current = { x: event.clientX, y: event.clientY };
        const rect = event.currentTarget.getBoundingClientRect();
        dragOffset.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        event.currentTarget.setPointerCapture(event.pointerId);
    }, []);

    const onPointerMove = useCallback(
        (event: ReactPointerEvent) => {
            if (!isDragging) return;
            const dist = Math.hypot(
                event.clientX - pointerStart.current.x,
                event.clientY - pointerStart.current.y,
            );
            if (dist <= DRAG_THRESHOLD_PX) return;
            hasMoved.current = true;
            update(event.clientX - dragOffset.current.x, event.clientY - dragOffset.current.y);
        },
        [isDragging, update],
    );

    const onPointerUp = useCallback(
        (event: ReactPointerEvent) => {
            if (!isDragging) return;
            setIsDragging(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }

            let final = pending.current;
            if (hasMoved.current) {
                /*
                 * 边缘吸附。只吸左右不吸上下：网页是纵向滚动的，把球吸到顶部或
                 * 底部会长期压住页面自己的工具栏与页脚，而左右两侧本来就是留白。
                 */
                const width = window.innerWidth;
                const size = footprintRef.current.w;
                if (final.x < SNAP_THRESHOLD_PX) final = { x: ORB_MARGIN, y: final.y };
                else if (width - final.x - size < SNAP_THRESHOLD_PX) {
                    final = { x: width - size - ORB_MARGIN, y: final.y };
                }
                pending.current = final;
                setPosition(final);
                /*
                 * 拖完松手会紧接着来一个 click。不把标记多留 50ms，那次 click
                 * 会被当成点击而展开面板 —— 表现为"一拖就开"。
                 */
                window.setTimeout(() => {
                    hasMoved.current = false;
                }, 50);
            }
            persist(final);
        },
        [isDragging, persist],
    );

    return { position, isDragging, hasMoved, onPointerDown, onPointerMove, onPointerUp, reclamp };
};
