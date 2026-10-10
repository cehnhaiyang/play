import type { ReactNode } from 'react';

/**
 * 悬浮球自己的图标。
 *
 * 刻意不用 `lucide-react`：这个包会被打进 content script，而它随页面一起加载 ——
 * 为一个球和两个面板图标拖进几百 KB 的图标库，代价落在每一次页面打开上。
 * 内联两个 path 更省，也不会因为图标库的版本变化而改动产物体积。
 */

interface IconProps {
    className?: string;
}

/** 嗅探：同心弧，与"正在接收信号"同义 */
export const RadarIcon = ({ className }: IconProps) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <path d="M4.9 19.1a10 10 0 0 1 0-14.2" />
        <path d="M7.8 16.2a6 6 0 0 1 0-8.4" />
        <path d="M10.6 13.4a2 2 0 0 1 0-2.8" />
        <path d="M16.2 7.8a6 6 0 0 1 0 8.4" />
        <path d="M19.1 4.9a10 10 0 0 1 0 14.2" />
    </svg>
);

/** Agent：终端提示符，与"在这里执行代码"同义 */
export const TerminalIcon = ({ className }: IconProps) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <path d="M4 17l6-5-6-5" />
        <path d="M12 19h8" />
    </svg>
);

export const CloseIcon = ({ className }: IconProps) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        aria-hidden="true"
    >
        <path d="M6 6l12 12M18 6L6 18" />
    </svg>
);

/** 面板标题栏左侧的容器，保持两个球的面板头部结构一致 */
export const IconBox = ({ children }: { children: ReactNode }) => (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/10 text-white">
        {children}
    </span>
);
