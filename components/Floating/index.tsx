import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Magnet, ShieldAlert, Sparkles, X } from 'lucide-react';
import { useSniff, useTamper } from '../../hooks';
import { FoundLink } from '../../meta';
import { ApiKeyFloating } from './ApiKeyFloating';
import { SniffResults } from './SniffResults';
import { TamperFloating } from './TamperFloating';
import { TorrentFloating } from './TorrentFloating';
import { FLOATING_PANEL_OVERLAY, FLOATING_PANEL_SHELL, getFloatingTriggerClassName } from './shared';
import { loadJSON, saveJSON } from '../../utils/persist';

type FloatingPanelType = 'sniff' | 'tamper' | 'torrent' | 'apikey';

interface FloatingProps {
  sniffer: ReturnType<typeof useSniff>;
  tamper: ReturnType<typeof useTamper>;
  currentUrl: string;
  onPlay: (link: FoundLink) => void;
  onAiAnalyze: () => void;
  onOpenGallery?: (url: string) => void;
}

const PANEL_MARGIN = 12;
const BALL_SIZE = 60;

const PANEL_META: Record<
  FloatingPanelType,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    accent: string;
    hint: string;
    statusText: string;
  }
> = {
  sniff: {
    label: '资源嗅探',
    icon: Sparkles,
    accent: 'from-indigo-500 via-violet-500 to-cyan-400',
    hint: '自动侦测音视频、流媒体及直链资源',
    statusText: '实时嗅探中',
  },
  tamper: {
    label: '篡改工具',
    icon: ShieldAlert,
    accent: 'from-rose-500 via-orange-500 to-amber-400',
    hint: '自定义请求拦截、标头注入与存储管理',
    statusText: '规则引擎就绪',
  },
  torrent: {
    label: '磁力下载',
    icon: Magnet,
    accent: 'from-cyan-500 via-sky-500 to-indigo-500',
    hint: '搜索 sukebei / nyaa，内置引擎直下正片',
    statusText: 'BT 引擎就绪',
  },
  apikey: {
    label: 'API Key',
    icon: KeyRound,
    accent: 'from-emerald-500 via-teal-500 to-cyan-400',
    hint: '配置和同步 AI 模型服务调用密钥',
    statusText: '密钥服务正常',
  },
};

const clampPosition = (nextX: number, nextY: number) => ({
  x: Math.max(12, Math.min(nextX, window.innerWidth - BALL_SIZE - 12)),
  y: Math.max(12, Math.min(nextY, window.innerHeight - BALL_SIZE - 12)),
});

export const Floating: React.FC<FloatingProps> = ({
  sniffer,
  tamper,
  currentUrl,
  onPlay,
  onAiAnalyze,
  onOpenGallery,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  // 悬浮球位置落盘：退出 App 重进也在上次的位置
  const [position, setPosition] = useState(() => {
    const saved = loadJSON<{ x: number; y: number } | null>('ball-pos', null);
    const fallback = {
      x: typeof window !== 'undefined' ? window.innerWidth - 88 : 1000,
      y: typeof window !== 'undefined' ? window.innerHeight - 180 : 600,
    };
    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return fallback;
    return clampPosition(saved.x, saved.y);
  });
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isIdle, setIsIdle] = useState(false);
  // 当前页落盘：重进直接回到上次看的那页
  const [activePanel, setActivePanel] = useState<FloatingPanelType>(() => {
    const saved = loadJSON<string>('panel', 'sniff');
    const all = Object.keys(PANEL_META) as FloatingPanelType[];
    return all.includes(saved as FloatingPanelType) ? (saved as FloatingPanelType) : 'sniff';
  });
  const [contentVisible, setContentVisible] = useState(false);
  // 访问过的面板常驻内存：打开过一次就不再卸载，切页/关闭重开不丢输入、滚动与已加载数据
  const [visited, setVisited] = useState<Set<FloatingPanelType>>(() => {
    const saved = loadJSON<string>('panel', 'sniff');
    const all = Object.keys(PANEL_META) as FloatingPanelType[];
    const initial: FloatingPanelType = all.includes(saved as FloatingPanelType)
      ? (saved as FloatingPanelType)
      : 'sniff';
    return new Set<FloatingPanelType>(['sniff', initial]);
  });

  // 拖拽结束（非拖拽态的位置变更）即落盘，拖动过程中不写，避免每帧刷 localStorage
  useEffect(() => {
    if (!isDragging) saveJSON('ball-pos', position);
  }, [position, isDragging]);
  useEffect(() => {
    saveJSON('panel', activePanel);
  }, [activePanel]);

  const dragOffset = useRef({ x: 0, y: 0 });
  const pointerStartPos = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);
  const pendingPosition = useRef(position);
  const rafRef = useRef<number | null>(null);
  const idleTimer = useRef<number | null>(null);

  const activeMeta = useMemo(() => PANEL_META[activePanel], [activePanel]);
  const ActiveIcon = activeMeta.icon;

  // 动画控制：展开时微延时淡入内容，收起时先快速淡出内容；
  // 同时把当前页记入常驻集合（内容已挂载时重开就是单纯显示，打开不再卡顿）
  useEffect(() => {
    let timer: number;
    if (isOpen) {
      setVisited((prev) => {
        if (prev.has(activePanel)) return prev;
        const next = new Set(prev);
        next.add(activePanel);
        return next;
      });
      timer = window.setTimeout(() => setContentVisible(true), 70);
    } else {
      setContentVisible(false);
    }
    return () => window.clearTimeout(timer);
  }, [isOpen, activePanel]);

  // 闲置状态计时器：未交互数秒后进入微缩呼吸态，鼠标靠近即唤醒
  const resetIdleTimer = useCallback(() => {
    setIsIdle(false);
    if (idleTimer.current !== null) {
      window.clearTimeout(idleTimer.current);
    }
    if (!isOpen) {
      idleTimer.current = window.setTimeout(() => {
        setIsIdle(true);
      }, 4000);
    }
  }, [isOpen]);

  useEffect(() => {
    resetIdleTimer();
    return () => {
      if (idleTimer.current !== null) {
        window.clearTimeout(idleTimer.current);
      }
    };
  }, [isOpen, resetIdleTimer]);

  // 键盘快捷键支持：ESC 关闭展开面板
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // 窗口尺寸自适应约束
  useEffect(() => {
    const handleResize = () => {
      setPosition((prev) => clampPosition(prev.x, prev.y));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const updatePosition = useCallback((nextX: number, nextY: number) => {
    pendingPosition.current = clampPosition(nextX, nextY);
    if (rafRef.current !== null) {
      return;
    }

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      setPosition(pendingPosition.current);
    });
  }, []);

  const panelStyle = useMemo(() => {
    const transitionStyle = isDragging ? 'none' : 'all 320ms cubic-bezier(0.16, 1, 0.3, 1)';

    if (!isOpen) {
      return {
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${BALL_SIZE}px`,
        height: `${BALL_SIZE}px`,
        borderRadius: '9999px',
        transition: transitionStyle,
      };
    }

    // 全屏展开：占满视口只留一圈边距，不再按悬浮球位置推算，
    // 小屏不再溢出，也就没有“打开状态下挪不动”的问题
    return {
      left: `${PANEL_MARGIN}px`,
      top: `${PANEL_MARGIN}px`,
      width: `calc(100vw - ${PANEL_MARGIN * 2}px)`,
      height: `calc(100vh - ${PANEL_MARGIN * 2}px)`,
      borderRadius: '24px',
      transition: transitionStyle,
    };
  }, [isDragging, isOpen, position]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // 拖拽与点击防误触
  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (isOpen) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsDragging(true);
      hasMoved.current = false;
      pointerStartPos.current = { x: event.clientX, y: event.clientY };

      const rect = event.currentTarget.getBoundingClientRect();
      dragOffset.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      event.currentTarget.setPointerCapture(event.pointerId);
      resetIdleTimer();
    },
    [isOpen, resetIdleTimer]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!isDragging) {
        return;
      }

      const dist = Math.hypot(
        event.clientX - pointerStartPos.current.x,
        event.clientY - pointerStartPos.current.y
      );

      if (dist > 4) {
        hasMoved.current = true;
        updatePosition(event.clientX - dragOffset.current.x, event.clientY - dragOffset.current.y);
      }
    },
    [isDragging, updatePosition]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (!isDragging) {
        return;
      }

      setIsDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);

      // 智能磁吸边缘吸附（释放位置距左右侧边较近时平滑吸附）
      if (hasMoved.current) {
        const snapThreshold = 72;
        const currentX = pendingPosition.current.x;
        const screenW = window.innerWidth;

        if (currentX < snapThreshold) {
          updatePosition(16, pendingPosition.current.y);
        } else if (screenW - currentX - BALL_SIZE < snapThreshold) {
          updatePosition(screenW - BALL_SIZE - 16, pendingPosition.current.y);
        }

        // 避免拖拽释放瞬间被判定为点击
        window.setTimeout(() => {
          hasMoved.current = false;
        }, 50);
      }

      resetIdleTimer();
    },
    [isDragging, resetIdleTimer, updatePosition]
  );

  const toggleOpen = useCallback(() => {
    if (!hasMoved.current) {
      setIsOpen((prev) => !prev);
    }
  }, []);

  // 常驻渲染：访问过的面板用 hidden 藏而不是卸载，内部输入/滚动/已加载数据全部保留；
  // 未访问过的面板不挂载，首屏不为此买单
  const renderPanelContent = () => {
    return (
      <>
        {visited.has('sniff') && (
          <div className={activePanel === 'sniff' ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
            <SniffResults
              sniffer={sniffer}
              onPlay={onPlay}
              onAiAnalyze={onAiAnalyze}
              onOpenGallery={onOpenGallery}
              currentUrl={currentUrl}
            />
          </div>
        )}

        {visited.has('tamper') && (
          <div className={activePanel === 'tamper' ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
            <TamperFloating tamper={tamper} currentUrl={currentUrl} />
          </div>
        )}

        {visited.has('torrent') && (
          <div className={activePanel === 'torrent' ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
            <TorrentFloating />
          </div>
        )}

        {visited.has('apikey') && (
          <div className={activePanel === 'apikey' ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
            <ApiKeyFloating />
          </div>
        )}
      </>
    );
  };

  return (
    <>
      <div
        className={`fixed z-[70] flex flex-col pointer-events-auto select-none group ${isOpen
          ? FLOATING_PANEL_SHELL
          : `${getFloatingTriggerClassName(
            'cursor-grab active:cursor-grabbing hover:scale-105 active:scale-95'
          )} transition-transform`
          }`}
        style={panelStyle}
        onPointerDown={!isOpen ? handlePointerDown : undefined}
        onPointerMove={!isOpen ? handlePointerMove : undefined}
        onPointerUp={!isOpen ? handlePointerUp : undefined}
        onClick={!isOpen ? toggleOpen : undefined}
        onPointerEnter={() => {
          setIsHovered(true);
          resetIdleTimer();
        }}
        onPointerLeave={() => {
          setIsHovered(false);
          resetIdleTimer();
        }}
      >
        {/* ======================= 折叠状态：未来感微晶悬浮球 ======================= */}
        {!isOpen && (
          <div
            className={`relative flex h-full w-full items-center justify-center transition-all duration-300 ${isIdle ? 'opacity-80 scale-95' : 'opacity-100 scale-100'
              }`}
          >
            {/* 1. 声纳扩散波纹（嗅探到资源时向外扩散动态光波） */}
            {sniffer.foundLinks.length > 0 && (
              <>
                <div className="pointer-events-none absolute inset-0 rounded-full border border-cyan-400/50 animate-orb-sonar" />
                <div className="pointer-events-none absolute inset-0 rounded-full border border-indigo-400/40 animate-orb-sonar-delayed" />
              </>
            )}

            {/* 2. 外部流动呼吸光晕 */}
            <div
              className={`pointer-events-none absolute -inset-2.5 rounded-full bg-gradient-to-r ${activeMeta.accent} opacity-45 blur-lg transition-all duration-500 animate-orb-breath group-hover:opacity-85`}
            />

            {/* 3. 多层晶透外壳 */}
            <div className="relative flex h-full w-full items-center justify-center rounded-full border border-white/25 bg-slate-950/80 backdrop-blur-2xl orb-specular shadow-[0_12px_36px_rgba(0,0,0,0.6),0_0_1px_1px_rgba(255,255,255,0.12)]">
              {/* 液态渐变能量核心 */}
              <div
                className={`absolute inset-[5px] rounded-full bg-gradient-to-br ${activeMeta.accent} opacity-90 shadow-inner`}
              />

              {/* 表面晶格光泽反光弧 */}
              <div className="pointer-events-none absolute inset-[5px] rounded-full bg-gradient-to-b from-white/35 via-transparent to-black/30" />
              <div className="pointer-events-none absolute inset-[6px] rounded-full bg-[radial-gradient(circle_at_32%_25%,rgba(255,255,255,0.7),transparent_55%)]" />

              {/* 动态模式核心图标 */}
              <div className="relative z-10 text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)] transition-all duration-300 group-hover:scale-110">
                <ActiveIcon className="h-6 w-6 stroke-[2.2]" />
              </div>

              {/* 赛博霓虹角标 */}
              {sniffer.foundLinks.length > 0 && (
                <div className="absolute -right-1 -top-1 z-20 flex h-5 min-w-[20px] items-center justify-center rounded-full border border-rose-300/50 bg-gradient-to-r from-rose-500 to-pink-500 px-1 text-[10px] font-black text-white shadow-[0_0_12px_rgba(244,63,94,0.7)] animate-orb-badge">
                  {sniffer.foundLinks.length > 99 ? '99+' : sniffer.foundLinks.length}
                </div>
              )}
            </div>

            {/* 4. 悬停微型快捷 HUD / 磁吸轮盘 */}
            {isHovered && !isDragging && !isOpen && (
              <div
                className={`absolute top-1/2 -translate-y-1/2 z-50 flex items-center gap-1.5 rounded-2xl border border-white/15 bg-slate-950/90 p-1.5 backdrop-blur-2xl shadow-[0_16px_40px_rgba(0,0,0,0.65)] animate-in fade-in zoom-in-95 duration-150 pointer-events-auto ${position.x > window.innerWidth / 2 ? 'right-full mr-3.5' : 'left-full ml-3.5'
                  }`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                {/* 状态徽章 */}
                <div className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-zinc-300 whitespace-nowrap">
                  {sniffer.foundLinks.length > 0 ? (
                    <>
                      <Sparkles className="h-3.5 w-3.5 text-cyan-400 animate-pulse" />
                      <span>
                        已嗅探 <strong className="font-bold text-white">{sniffer.foundLinks.length}</strong> 项
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      <span>{activeMeta.label}</span>
                    </>
                  )}
                </div>

                {/* 快捷直达 4 项按钮 */}
                <div className="flex items-center gap-1 border-l border-white/10 pl-1.5">
                  {(Object.keys(PANEL_META) as FloatingPanelType[]).map((panelKey) => {
                    const meta = PANEL_META[panelKey];
                    const Icon = meta.icon;
                    const isCurrent = panelKey === activePanel;
                    const count = panelKey === 'sniff' ? sniffer.foundLinks.length : 0;

                    return (
                      <button
                        key={panelKey}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActivePanel(panelKey);
                          setIsOpen(true);
                        }}
                        className={`relative flex h-8 w-8 items-center justify-center rounded-xl border transition-all ${isCurrent
                          ? `border-white/25 bg-gradient-to-br ${meta.accent} text-white shadow-md`
                          : 'border-white/10 bg-white/5 text-zinc-400 hover:border-white/20 hover:bg-white/15 hover:text-white'
                          }`}
                        title={`一键切换到 ${meta.label}`}
                      >
                        <Icon className="h-4 w-4" />
                        {count > 0 && (
                          <span className="absolute -right-1 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-rose-500 px-0.5 text-[8px] font-bold text-white shadow-[0_0_6px_rgba(244,63,94,0.6)]">
                            {count > 99 ? '99+' : count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ======================= 展开状态：流光毛玻璃 HUD 面板 ======================= */}
        {/* 常驻挂载、关闭只隐藏：关球不再卸载任何面板，抓取进度/输入/滚动原样保留，
            重开就是单纯显示。如改回条件渲染，关球会停掉 ACG 抓取并清空所有状态 */}
        <div
          className={`relative h-full flex-col p-5 transition-opacity duration-200 ${isOpen ? 'flex' : 'hidden'
            } ${contentVisible ? 'opacity-100' : 'opacity-0'}`}
        >
          {/* 弥散柔光氛围底光 */}
          <div
            className={`pointer-events-none absolute -inset-10 rounded-[48px] bg-gradient-to-br ${activeMeta.accent} opacity-15 blur-3xl transition-all duration-700`}
          />

          {/* 面板头部 */}
          <div className="relative z-10 flex shrink-0 items-center justify-between gap-4 border-b border-white/10 pb-4">
            <div className="flex items-center gap-3">
              <div
                className={`flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br ${activeMeta.accent} text-white shadow-[0_8px_20px_rgba(0,0,0,0.3)]`}
              >
                <ActiveIcon className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2.5">
                  <span className="text-xl font-bold tracking-tight text-white">
                    {activeMeta.label}
                  </span>
                  <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    {activeMeta.statusText}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-zinc-400">{activeMeta.hint}</div>
              </div>
            </div>

            {/* 操作区 */}
            <div className="flex items-center gap-2">
              <span className="hidden items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-400 sm:inline-flex">
                <kbd className="font-mono text-[10px] text-zinc-300">ESC</kbd> 关闭
              </span>
              <button
                onClick={() => setIsOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-zinc-400 transition-all hover:rotate-90 hover:border-white/20 hover:bg-white/15 hover:text-white active:scale-95"
                title="关闭面板 (Esc)"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* 现代化胶囊分段导航栏 */}
          <div className="relative z-10 mt-3.5 flex shrink-0 items-center gap-1.5 rounded-2xl border border-white/10 bg-white/[0.04] p-1.5 backdrop-blur-md">
            {(Object.keys(PANEL_META) as FloatingPanelType[]).map((panel) => {
              const meta = PANEL_META[panel];
              const Icon = meta.icon;
              const isActive = panel === activePanel;
              const count = panel === 'sniff' ? sniffer.foundLinks.length : 0;

              return (
                <button
                  key={panel}
                  onClick={() => setActivePanel(panel)}
                  className={`relative flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-all duration-200 ${isActive
                    ? 'border border-white/20 bg-gradient-to-r from-white/15 to-white/10 text-white shadow-[0_4px_16px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.2)]'
                    : 'border border-transparent text-zinc-400 hover:border-white/10 hover:bg-white/5 hover:text-zinc-200'
                    }`}
                  title={meta.hint}
                >
                  <div
                    className={`flex h-6 w-6 items-center justify-center rounded-lg transition-all ${isActive
                      ? `bg-gradient-to-br ${meta.accent} text-white shadow-sm`
                      : 'text-zinc-400'
                      }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <span className="tracking-wide">{meta.label}</span>
                  {count > 0 && (
                    <span className="flex h-4 min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white shadow-[0_0_8px_rgba(244,63,94,0.5)]">
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* 主内容展示区 */}
          <div className="custom-scrollbar relative z-10 mt-3.5 min-h-0 flex-1 overflow-hidden rounded-[20px] border border-white/10 bg-slate-950/40 p-4 shadow-inner">
            {renderPanelContent()}
          </div>
        </div>
      </div>

      {/* 遮罩背景 */}
      {isOpen && (
        <div
          className={FLOATING_PANEL_OVERLAY}
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
};

export { SniffResults } from './SniffResults';
export { TamperFloating } from './TamperFloating';
export { ApiKeyFloating } from './ApiKeyFloating';
