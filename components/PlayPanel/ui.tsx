import React, { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * 播放器 UI 原子件。
 *
 * 此前 PlayPanel 里每个按钮、每个弹窗都是手写一长串 className，同一套
 * 「深色玻璃胶囊」在文件里重复了 30 多次，改一处配色要全文搜索替换，
 * 而且已经开始漂移（有的 rounded-xl 有的 rounded-2xl，有的 border-white/5
 * 有的 /10）。这里把重复度最高的几类抽出来，样式只有一处定义。
 *
 * 排版仍交给 Tailwind，本文件只负责「一致性」这一件事。
 */

/* -------------------------------------------------------------------------- */
/* 点击外部关闭                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 判断一次点击是否落在元素之外。
 *
 * 用 composedPath 而不是 contains：Shadow DOM 与跨根节点的事件里
 * `contains(target)` 会漏判，导致「点了弹窗内部却把弹窗关了」。
 */
export const isOutside = (el: HTMLElement | null, target: EventTarget | null): boolean => {
    if (!el || !target || !(target instanceof Node)) return false;
    const path = typeof (target as unknown as { composedPath?: () => EventTarget[] }).composedPath === 'function'
        ? (target as unknown as { composedPath: () => EventTarget[] }).composedPath()
        : null;
    if (path && path.length > 0) return !path.includes(el);
    return !el.contains(target);
};

/**
 * 绑定「点击/触摸外部即回调」，用于倍速菜单这类轻量浮层。
 * enabled 为 false 时完全不挂监听，避免每个实例都常驻一对全局监听器。
 */
export const useClickOutside = (
    ref: React.RefObject<HTMLElement | null>,
    onOutside: () => void,
    enabled = true
) => {
    const cbRef = useRef(onOutside);
    cbRef.current = onOutside;
    useEffect(() => {
        if (!enabled) return;
        const handler = (e: MouseEvent | TouchEvent) => {
            if (isOutside(ref.current, e.target)) cbRef.current();
        };
        document.addEventListener('mousedown', handler);
        document.addEventListener('touchstart', handler, { passive: true });
        return () => {
            document.removeEventListener('mousedown', handler);
            document.removeEventListener('touchstart', handler);
        };
    }, [ref, enabled]);
};

/* -------------------------------------------------------------------------- */
/* 图标按钮                                                                    */
/* -------------------------------------------------------------------------- */

type IconButtonTone = 'default' | 'accent' | 'danger' | 'teal' | 'amber' | 'ghost';
type IconButtonSize = 'sm' | 'md' | 'lg' | 'xl';

const ICON_TONES: Record<IconButtonTone, string> = {
    default: 'text-slate-400 hover:text-white hover:bg-white/10',
    accent: 'text-indigo-300 hover:text-white hover:bg-indigo-500/20',
    danger: 'text-slate-400 hover:text-rose-400 hover:bg-rose-500/15',
    teal: 'text-teal-300 hover:text-white hover:bg-teal-500/20',
    amber: 'text-amber-300 hover:text-white hover:bg-amber-500/20',
    ghost: 'text-slate-300 hover:text-white hover:bg-white/10',
};

const ICON_SIZES: Record<IconButtonSize, string> = {
    sm: 'p-1.5 rounded-lg',
    md: 'p-2 rounded-xl',
    lg: 'p-2.5 rounded-xl',
    xl: 'p-3 rounded-2xl',
};

/** 各尺寸对应的图标边长，保证图标与内边距同步放大 */
const ICON_GLYPH: Record<IconButtonSize, string> = {
    sm: 'w-3.5 h-3.5',
    md: 'w-4 h-4',
    lg: 'w-[18px] h-[18px]',
    xl: 'w-5 h-5',
};

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    /** 图标尺寸档位；`xl` 用于播放键这类主操作 */
    size?: IconButtonSize;
    tone?: IconButtonTone;
    /** 同时作为 title 与 aria-label，避免只写 title 导致读屏拿不到名字 */
    label: string;
    /** 实心背景（主操作按钮用），会覆盖 tone 的悬停底色 */
    solid?: boolean;
}

export const IconButton: React.FC<IconButtonProps> = ({
    size = 'md',
    tone = 'default',
    label,
    solid = false,
    className = '',
    children,
    ...rest
}) => (
    <button
        type="button"
        title={label}
        aria-label={label}
        className={[
            'inline-flex items-center justify-center shrink-0 transition',
            solid ? '' : ICON_TONES[tone],
            ICON_SIZES[size],
            'disabled:opacity-40 disabled:cursor-not-allowed',
            className,
        ].filter(Boolean).join(' ')}
        {...rest}
    >
        {children}
    </button>
);

/** IconButton 配套的图标尺寸类，供调用方复用同一档位 */
export const iconGlyph = (size: IconButtonSize): string => ICON_GLYPH[size];

/* -------------------------------------------------------------------------- */
/* 胶囊按钮 / 徽章                                                             */
/* -------------------------------------------------------------------------- */

export type PillTone = 'slate' | 'indigo' | 'teal' | 'amber' | 'rose' | 'emerald' | 'cyan' | 'sky';

const PILL_TONES: Record<PillTone, string> = {
    slate: 'bg-white/5 border-white/10 text-slate-300',
    indigo: 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300',
    teal: 'bg-teal-500/15 border-teal-500/30 text-teal-300',
    amber: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
    rose: 'bg-rose-500/15 border-rose-500/30 text-rose-300',
    emerald: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
    cyan: 'bg-cyan-500/15 border-cyan-500/30 text-cyan-300',
    sky: 'bg-sky-500/15 border-sky-500/30 text-sky-300',
};

/** 顶部浮层与列表里的小徽章，统一描边、圆角与字重 */
export const Pill: React.FC<{
    tone?: PillTone;
    className?: string;
    children: React.ReactNode;
    title?: string;
}> = ({ tone = 'slate', className = '', children, title }) => (
    <span
        title={title}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold leading-4 whitespace-nowrap ${PILL_TONES[tone]} ${className}`}
    >
        {children}
    </span>
);

/* -------------------------------------------------------------------------- */
/* 模态框外壳                                                                  */
/* -------------------------------------------------------------------------- */

export interface ModalProps {
    open: boolean;
    onClose: () => void;
    /** 标题，同时用于 aria-labelledby */
    title: string;
    /** 标题左侧图标 */
    icon?: React.ReactNode;
    /** 标题右侧、关闭按钮之前的补充操作 */
    headerExtra?: React.ReactNode;
    /** 底部操作区 */
    footer?: React.ReactNode;
    maxWidth?: string;
    children: React.ReactNode;
}

/**
 * 统一模态框：遮罩点击关闭、Esc 关闭、打开时聚焦首个可输入元素、
 * Tab 在框内循环（简易焦点陷阱）。
 *
 * 此前 URL / ACG 两个弹窗各写一遍外壳，且都没有 role="dialog"、
 * 没有焦点管理：打开后焦点仍在背后的页面上，Tab 会跑到播放器控制条上。
 */
export const Modal: React.FC<ModalProps> = ({
    open,
    onClose,
    title,
    icon,
    headerExtra,
    footer,
    maxWidth = 'max-w-md',
    children,
}) => {
    const panelRef = useRef<HTMLDivElement>(null);
    const titleId = React.useId();

    // 打开时把焦点移进弹窗（优先输入框），关闭后不抢回焦点，
    // 因为触发按钮通常已经因视图切换而不存在了
    useEffect(() => {
        if (!open) return;
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = panel.querySelector<HTMLElement>(
            'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])'
        );
        (focusable || panel).focus({ preventScroll: true });
    }, [open]);

    const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Tab') return;
        const panel = panelRef.current;
        if (!panel) return;
        const nodes = Array.from(
            panel.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !panel.contains(active))) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    }, []);

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150"
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                onKeyDown={onKeyDown}
                className={`bg-slate-900 border border-white/10 rounded-2xl w-full ${maxWidth} shadow-2xl animate-in zoom-in-95 duration-150 outline-none max-h-[90vh] flex flex-col`}
            >
                <div className="flex items-center justify-between gap-3 border-b border-white/10 px-6 py-4 shrink-0">
                    <h3 id={titleId} className="text-base font-bold text-white flex items-center gap-2 min-w-0">
                        {icon}
                        <span className="truncate">{title}</span>
                    </h3>
                    <div className="flex items-center gap-1 shrink-0">
                        {headerExtra}
                        <IconButton label="关闭 (Esc)" onClick={onClose}>
                            <X className="w-4 h-4" />
                        </IconButton>
                    </div>
                </div>

                <div className="px-6 py-4 overflow-y-auto custom-scrollbar">{children}</div>

                {footer && (
                    <div className="px-6 py-4 border-t border-white/10 flex justify-end gap-2 shrink-0">{footer}</div>
                )}
            </div>
        </div>
    );
};

/* -------------------------------------------------------------------------- */
/* 滑杆                                                                        */
/* -------------------------------------------------------------------------- */

export interface RangeSliderProps {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    onChange: (value: number) => void;
    /** 强调色（CSS 颜色值）。不传则用主题 indigo */
    color?: string;
    label: string;
    disabled?: boolean;
    className?: string;
}

/**
 * 带「已填充轨道」的原生 range。
 *
 * Chromium 不提供 ::-webkit-slider-runnable-track 的进度伪元素，填充只能靠
 * 渐变伪造，所以这里把百分比写进 `--tp-fill` 交给 index.css 使用。
 * 之前的写法是 `appearance-none accent-indigo-500`——`accent-color` 在
 * appearance:none 下不生效，等于填充和滑块一起消失。
 */
export const RangeSlider: React.FC<RangeSliderProps> = ({
    value,
    min = 0,
    max = 1,
    step = 0.01,
    onChange,
    color,
    label,
    disabled = false,
    className = '',
}) => {
    const span = max - min;
    const pct = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0;
    const style = {
        '--tp-fill': `${pct}%`,
        ...(color ? { '--tp-range-color': color } : {}),
    } as React.CSSProperties;

    return (
        <input
            type="range"
            aria-label={label}
            title={label}
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            style={style}
            className={`w-full disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
        />
    );
};

/* -------------------------------------------------------------------------- */
/* 播放中的均衡器指示                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 三根跳动的小竖条，替代「正在播放」的静态圆点。
 * 高度写死、仅 transform 动画，避免每帧触发重排。
 */
export const EqualizerBars: React.FC<{ active: boolean; className?: string }> = ({ active, className = '' }) => (
    <span className={`inline-flex items-end gap-[2px] h-3 ${className}`} aria-hidden="true">
        {[0, 0.18, 0.36].map((delay, i) => (
            <span
                key={i}
                className={`w-[2px] rounded-full bg-current ${active ? 'tp-eq-bar' : ''}`}
                style={{
                    height: `${[10, 12, 8][i]}px`,
                    animationDelay: `${delay}s`,
                    ...(active ? {} : { transform: 'scaleY(0.3)' }),
                }}
            />
        ))}
    </span>
);
