export const FLOATING_PANEL_SHELL =
  'bg-slate-950/85 backdrop-blur-2xl border border-white/12 shadow-[0_24px_80px_rgba(0,0,0,0.65),0_0_1px_1px_rgba(255,255,255,0.08)]';

export const FLOATING_PANEL_HEADER =
  'border-b border-white/10 bg-gradient-to-r from-white/[0.07] via-white/[0.04] to-transparent';

export const FLOATING_PANEL_FOOTER =
  'border-t border-white/10 bg-white/[0.03]';

export const FLOATING_PANEL_CLOSE_BUTTON =
  'p-2 rounded-full text-slate-400 hover:text-white hover:bg-white/10 active:scale-95 transition-all';

export const FLOATING_PANEL_OVERLAY =
  'fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-300 pointer-events-auto';

export const getFloatingTriggerClassName = (accentClassName: string) =>
  `backdrop-blur-2xl border border-white/15 shadow-[0_16px_40px_rgba(0,0,0,0.4),0_0_20px_rgba(255,255,255,0.05)] ${accentClassName}`;
