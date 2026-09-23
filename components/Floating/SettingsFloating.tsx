import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertCircle,
    BrainCircuit,
    Check,
    Cpu,
    Eye,
    EyeOff,
    Globe,
    KeyRound,
    Link2,
    Loader2,
    Plug,
    Save,
    Wifi,
    Zap,
} from 'lucide-react';
import { getElectronAPI } from '../../meta';
import type { AiConfig, ReasoningEffort } from '../../meta';
import { DEFAULT_AI_CONFIG, saveAiConfig, testAiConnection } from '../../services/AiService';

/**
 * 设置面板：网络代理 + AI 服务，两处配置合并在一页。
 *
 * 代理语义（与主进程 electron/settings.js 一致）：
 * - 留空 = 一律直连，不读系统代理、不做探测。Proton VPN 这类 TUN 模式 VPN
 *   在网卡层接管流量，直连本身就是被代理着的；
 * - 有值 = 用该端口走 HTTP CONNECT 隧道。只填数字默认 127.0.0.1。
 *
 * AI 语义：
 * - 走 OpenAI 兼容协议（POST {baseUrl}/chat/completions），默认指向本地 tc2api；
 * - 思考强度只有 low / high / max 三档，服务端对其它值直接 503，故用选择器而非输入框；
 * - 配置落在主进程 settings.json（浏览器调试时回落 localStorage，见 AiService）。
 *
 * 保存值落在主进程 userData/settings.json：主进程启动时（渲染层还没起来）
 * 就要知道走不走代理，localStorage 那时读不到。
 */
export const SettingsFloating: React.FC = () => {
    const api = getElectronAPI();
    const settingsApi = api?.settings;

    /* ------------------------------ 代理端口 ------------------------------ */
    const [draft, setDraft] = useState('');
    const [savedValue, setSavedValue] = useState('');
    // 主进程当前真正生效的端点（配了端口但连不上时会是空 → 界面区分"已配置"与"已生效"）
    const [applied, setApplied] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState<'idle' | 'saved' | 'cleared'>('idle');

    /* ------------------------------ AI 服务 ------------------------------ */
    const [aiDraft, setAiDraft] = useState<AiConfig>(DEFAULT_AI_CONFIG);
    const [aiSaved, setAiSaved] = useState<AiConfig>(DEFAULT_AI_CONFIG);
    const [aiError, setAiError] = useState('');
    const [aiStatus, setAiStatus] = useState<'idle' | 'saved'>('idle');
    const [isAiSaving, setIsAiSaving] = useState(false);
    const [isKeyVisible, setIsKeyVisible] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

    // 初次进入读一次主进程配置，避免界面显示与服务端实际不一致
    useEffect(() => {
        let cancelled = false;
        if (!settingsApi) {
            setIsLoading(false);
            return () => { cancelled = true; };
        }
        settingsApi.get()
            .then((res) => {
                if (cancelled) return;
                setSavedValue(res.proxyPort || '');
                setDraft(res.proxyPort || '');
                setApplied(res.applied || '');
                if (res.ai) {
                    setAiSaved(res.ai);
                    setAiDraft(res.ai);
                }
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : '读取设置失败');
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => { cancelled = true; };
    }, [settingsApi]);

    useEffect(() => {
        if (status === 'idle') return;
        const timer = window.setTimeout(() => setStatus('idle'), 2200);
        return () => window.clearTimeout(timer);
    }, [status]);

    useEffect(() => {
        if (aiStatus === 'idle') return;
        const timer = window.setTimeout(() => setAiStatus('idle'), 2200);
        return () => window.clearTimeout(timer);
    }, [aiStatus]);

    const handleSave = useCallback(async () => {
        if (!settingsApi) return;
        setIsSaving(true);
        setError('');
        try {
            const res = await settingsApi.setProxyPort(draft);
            if (!res.success) {
                setError(res.message || '保存失败');
                return;
            }
            setSavedValue(res.proxyPort || '');
            setDraft(res.proxyPort || '');
            setApplied(res.applied || '');
            setStatus(res.proxyPort ? 'saved' : 'cleared');
        } catch (err) {
            setError(err instanceof Error ? err.message : '保存失败');
        } finally {
            setIsSaving(false);
        }
    }, [draft, settingsApi]);

    const handleClear = useCallback(() => {
        setDraft('');
        setError('');
    }, []);

    /* ------------------------------ AI 操作 ------------------------------ */

    // 改任意字段都清掉上一次的测试结论：它对应的是旧配置，留着会误导
    const patchAiDraft = useCallback((patch: Partial<AiConfig>) => {
        setAiDraft((prev) => ({ ...prev, ...patch }));
        setAiError('');
        setTestResult(null);
    }, []);

    const handleSaveAi = useCallback(async () => {
        setIsAiSaving(true);
        setAiError('');
        try {
            const res = await saveAiConfig(aiDraft);
            if (!res.success) {
                setAiError(res.message || '保存失败');
                return;
            }
            const next = res.ai || aiDraft;
            setAiSaved(next);
            setAiDraft(next);
            setAiStatus('saved');
        } catch (err) {
            setAiError(err instanceof Error ? err.message : '保存失败');
        } finally {
            setIsAiSaving(false);
        }
    }, [aiDraft]);

    const handleTestAi = useCallback(async () => {
        setIsTesting(true);
        setTestResult(null);
        setAiError('');
        try {
            const res = await testAiConnection(aiDraft);
            setTestResult({
                ok: res.success,
                text: res.success
                    ? `${res.message}${res.model ? ` · 模型 ${res.model}` : ''}${res.reply ? ` · 回复「${res.reply.trim()}」` : ''}`
                    : res.message,
            });
        } catch (err) {
            setTestResult({ ok: false, text: err instanceof Error ? err.message : '测试失败' });
        } finally {
            setIsTesting(false);
        }
    }, [aiDraft]);

    const isAiDirty = useMemo(
        () =>
            aiDraft.baseUrl !== aiSaved.baseUrl ||
            aiDraft.apiKey !== aiSaved.apiKey ||
            aiDraft.model !== aiSaved.model ||
            aiDraft.reasoningEffort !== aiSaved.reasoningEffort,
        [aiDraft, aiSaved]
    );

    const isDirty = draft.trim() !== savedValue;
    // 配了端口但 applied 为空 → 端口连不上，服务层已回落直连
    const isConfiguredButDead = Boolean(savedValue) && !applied;
    const isDirect = !savedValue;

    if (!api) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-zinc-500">
                <Globe className="h-10 w-10 text-zinc-600" />
                <p className="text-sm">设置仅在 Electron 桌面端可用。</p>
                <p className="text-xs text-zinc-600">浏览器环境下不涉及主进程网络层配置。</p>
            </div>
        );
    }

    const effortOptions: { value: ReasoningEffort; label: string; hint: string }[] = [
        { value: 'low', label: '低', hint: '最快、省 token' },
        { value: 'high', label: '高', hint: '质量与速度平衡' },
        { value: 'max', label: '最大', hint: '最强推理，最慢' },
    ];

    return (
        <div className="flex h-full flex-col overflow-y-auto custom-scrollbar">
            <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
                <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-sky-500/20 bg-sky-500/10">
                        <Wifi className="h-5 w-5 text-sky-400" />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-zinc-100">设置</h3>
                        <p className="text-xs text-zinc-500">网络代理与 AI 服务配置，保存后立即生效。</p>
                    </div>
                </div>
                <span
                    className={`rounded-full border px-3 py-1 text-[11px] ${
                        isDirect
                            ? 'border-white/10 bg-white/5 text-zinc-400'
                            : isConfiguredButDead
                                ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    }`}
                >
                    {isDirect ? '直连模式' : isConfiguredButDead ? '端口不可用' : '代理已生效'}
                </span>
            </div>

            {/* ======================= 分区一：网络与代理 ======================= */}
            <section className="mt-5">
                <div className="flex items-center gap-2">
                    <Wifi className="h-4 w-4 text-sky-400" />
                    <h4 className="text-sm font-bold text-zinc-200">网络与代理</h4>
                </div>

                <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">当前状态</span>
                        {isLoading ? (
                            <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                                <Loader2 className="h-3 w-3 animate-spin" /> 读取中
                            </span>
                        ) : (
                            <span className="text-xs text-zinc-400">
                                {isDirect ? '所有请求直连' : `经 ${applied || savedValue} 建立隧道`}
                            </span>
                        )}
                    </div>
                    <div className="mt-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono text-sm text-zinc-300">
                        {isDirect ? '未使用代理（直连）' : (applied || savedValue)}
                    </div>
                    {isConfiguredButDead && (
                        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300/90">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>已保存 {savedValue}，但该端口当前连不上，本轮已自动回落直连。请确认代理软件已启动、端口填写正确。</span>
                        </p>
                    )}
                </div>

                <div className="mt-4 space-y-2">
                    <label className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">代理端口</label>
                    <div className="relative">
                        <Plug className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            value={draft}
                            onChange={(event) => { setDraft(event.target.value); setError(''); }}
                            onKeyDown={(event) => { if (event.key === 'Enter') void handleSave(); }}
                            placeholder="留空 = 直连，例如 10810 或 127.0.0.1:10810"
                            spellCheck={false}
                            className="w-full rounded-2xl border border-white/10 bg-zinc-950 py-3 pl-11 pr-4 font-mono text-sm text-zinc-200 outline-none transition focus:border-sky-500/60"
                        />
                    </div>
                    {error && (
                        <p className="flex items-start gap-1.5 text-xs text-rose-400">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>{error}</span>
                        </p>
                    )}
                    <p className="text-xs text-zinc-500">
                        只填端口号默认走 127.0.0.1。保存后立即生效，无需重启。
                    </p>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                    <button
                        onClick={() => void handleSave()}
                        disabled={isSaving || isLoading || (!isDirty && !error)}
                        className="flex items-center justify-center gap-2 rounded-2xl bg-sky-500 px-4 py-3 font-bold text-black transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {status === 'saved' ? <Check className="h-4 w-4" /> : isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        {status === 'saved' ? '已保存' : '保存'}
                    </button>
                    <button
                        onClick={handleClear}
                        disabled={isLoading}
                        className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-zinc-900 px-4 py-3 font-bold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                    >
                        <Globe className="h-4 w-4" />
                        {status === 'cleared' ? '已切直连' : '清空（直连）'}
                    </button>
                </div>

                <div className="mt-4 space-y-2 rounded-2xl border border-white/10 bg-gradient-to-br from-zinc-900 to-zinc-950 p-4 text-xs leading-6 text-zinc-400">
                    <p>1. <strong className="text-zinc-300">留空即直连</strong>：应用不会读取系统代理，也不做端口探测。使用 Proton VPN 等 TUN 模式 VPN 时选这项——流量在网卡层已被接管，无需本地代理端口。</p>
                    <p>2. <strong className="text-zinc-300">填入端口</strong>：抓取站点的请求将走该端口的 HTTP CONNECT 隧道，适用于 v2rayN、白鲸等提供本地 HTTP 端口的代理软件。</p>
                    <p>3. 填写后若端口连不上，本轮会自动回落直连，并在上方提示，不会让请求全部失败。</p>
                </div>
            </section>

            {/* ======================= 分区二：AI 服务 ======================= */}
            <section className="mt-7 border-t border-white/10 pt-6">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <BrainCircuit className="h-4 w-4 text-violet-400" />
                        <h4 className="text-sm font-bold text-zinc-200">AI 服务</h4>
                    </div>
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-zinc-400">
                        OpenAI 兼容协议
                    </span>
                </div>

                <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">当前生效</span>
                        <span className="text-xs text-zinc-400">{aiSaved.model}</span>
                    </div>
                    <div className="mt-3 space-y-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-zinc-300">
                        <div className="truncate">{aiSaved.baseUrl}</div>
                        <div className="text-zinc-500">
                            密钥 {aiSaved.apiKey ? `${aiSaved.apiKey.slice(0, 3)}***` : '（空）'} · 思考强度 {aiSaved.reasoningEffort}
                        </div>
                    </div>
                </div>

                <div className="mt-4 space-y-2">
                    <label className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">接口地址 (Base URL)</label>
                    <div className="relative">
                        <Link2 className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            value={aiDraft.baseUrl}
                            onChange={(event) => patchAiDraft({ baseUrl: event.target.value })}
                            placeholder="http://127.0.0.1:7863/v1"
                            spellCheck={false}
                            className="w-full rounded-2xl border border-white/10 bg-zinc-950 py-3 pl-11 pr-4 font-mono text-sm text-zinc-200 outline-none transition focus:border-violet-500/60"
                        />
                    </div>
                    <p className="text-xs text-zinc-500">需包含版本段（/v1），末尾斜杠会自动去掉。</p>
                </div>

                <div className="mt-4 space-y-2">
                    <label className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">密钥 (API Key)</label>
                    <div className="relative">
                        <KeyRound className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                        <input
                            type={isKeyVisible ? 'text' : 'password'}
                            value={aiDraft.apiKey}
                            onChange={(event) => patchAiDraft({ apiKey: event.target.value })}
                            placeholder="本地服务可留空"
                            spellCheck={false}
                            className="w-full rounded-2xl border border-white/10 bg-zinc-950 py-3 pl-11 pr-12 font-mono text-sm text-zinc-200 outline-none transition focus:border-violet-500/60"
                        />
                        <button
                            onClick={() => setIsKeyVisible((prev) => !prev)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors hover:text-zinc-200"
                            title={isKeyVisible ? '隐藏密钥' : '显示密钥'}
                            type="button"
                        >
                            {isKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                    </div>
                </div>

                <div className="mt-4 space-y-2">
                    <label className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">模型</label>
                    <div className="relative">
                        <Cpu className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            value={aiDraft.model}
                            onChange={(event) => patchAiDraft({ model: event.target.value })}
                            placeholder="global:deepseek-v4.1-flash"
                            spellCheck={false}
                            list="ai-model-presets"
                            className="w-full rounded-2xl border border-white/10 bg-zinc-950 py-3 pl-11 pr-4 font-mono text-sm text-zinc-200 outline-none transition focus:border-violet-500/60"
                        />
                    </div>
                    <datalist id="ai-model-presets">
                        <option value="global:deepseek-v4.1-flash" />
                        <option value="deepseek-v4.1-flash" />
                    </datalist>
                    <p className="text-xs text-zinc-500">按服务商实际暴露的模型标识填写，可手动输入任意值。</p>
                </div>

                <div className="mt-4 space-y-2">
                    <label className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">思考强度</label>
                    <div className="grid grid-cols-3 gap-2">
                        {effortOptions.map((option) => {
                            const isActive = aiDraft.reasoningEffort === option.value;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => patchAiDraft({ reasoningEffort: option.value })}
                                    title={option.hint}
                                    className={`flex flex-col items-center gap-0.5 rounded-2xl border px-3 py-2.5 transition-all ${
                                        isActive
                                            ? 'border-violet-500/50 bg-violet-500/15 text-violet-200'
                                            : 'border-white/10 bg-zinc-950 text-zinc-400 hover:border-white/20 hover:text-zinc-200'
                                    }`}
                                >
                                    <span className="flex items-center gap-1.5 text-sm font-bold">
                                        {isActive && <Zap className="h-3.5 w-3.5" />}
                                        {option.label}
                                    </span>
                                    <span className="text-[10px] text-zinc-500">{option.value}</span>
                                </button>
                            );
                        })}
                    </div>
                    <p className="text-xs text-zinc-500">
                        对应接口的 reasoning_effort 字段，仅支持这三档；填写其它值服务端会直接拒绝。
                    </p>
                </div>

                {aiError && (
                    <p className="mt-3 flex items-start gap-1.5 text-xs text-rose-400">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{aiError}</span>
                    </p>
                )}

                {testResult && (
                    <p className={`mt-3 flex items-start gap-1.5 text-xs ${testResult.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {testResult.ok
                            ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            : <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                        <span className="break-all">{testResult.text}</span>
                    </p>
                )}

                <div className="mt-4 grid grid-cols-2 gap-3">
                    <button
                        onClick={() => void handleSaveAi()}
                        disabled={isAiSaving || (!isAiDirty && !aiError)}
                        className="flex items-center justify-center gap-2 rounded-2xl bg-violet-500 px-4 py-3 font-bold text-black transition-colors hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {aiStatus === 'saved' ? <Check className="h-4 w-4" /> : isAiSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        {aiStatus === 'saved' ? '已保存' : '保存配置'}
                    </button>
                    <button
                        onClick={() => void handleTestAi()}
                        disabled={isTesting}
                        className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-zinc-900 px-4 py-3 font-bold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                    >
                        {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                        {isTesting ? '测试中' : '测试连接'}
                    </button>
                </div>

                <div className="mt-4 space-y-2 rounded-2xl border border-white/10 bg-gradient-to-br from-zinc-900 to-zinc-950 p-4 text-xs leading-6 text-zinc-400">
                    <p>1. <strong className="text-zinc-300">测试连接用草稿配置</strong>：不会写盘，可以先验证地址、密钥、模型三者是否可用再决定保存。</p>
                    <p>2. <strong className="text-zinc-300">密钥存在主进程</strong>：落盘在 userData/settings.json，不写入浏览器 localStorage。</p>
                    <p>3. 资源嗅探的 AI 深度分析与音频工作台的代码生成共用这份配置。</p>
                </div>
            </section>
        </div>
    );
};
