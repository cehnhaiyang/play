import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CookieItem, HeaderRule, TamperRule } from '../../../shared/meta';
import {
    buildCookieData,
    collectDroppedRules,
    decodeJwt,
    findCookieByKey,
    isFieldRuleDropped,
    isHeaderRuleDropped,
    pickJwtCandidates,
    ruleTargetKey,
} from '../../../shared/core';
import { bridge } from './bridge-client';

/**
 * Agent 面板里「规则 / 请求头 / 存储 / JWT」四个页签。
 *
 * ## 为什么这四个必须存在
 *
 * 对话页只是**入口**。真正让 Agent 有用的是它能改页面运行时：拦响应、改请求头、
 * 翻存储、解 token。而这四件事全都是"改了之后看不见"的 —— 规则存下来了、
 * 页面里到底生不生效、当前存储里到底有什么，只有把真实值摊开给用户看才说得清。
 *
 * 参照 `新建文件夹/BrowsePanel.tsx` 的 `RulesTab` / `HeadersTab` / `StorageTab` /
 * `JwtTab` 四个组件，但**判据一律取自 `shared/core`**（`isFieldRuleDropped`、
 * `collectDroppedRules`、`buildCookieData`、`decodeJwt`、`pickJwtCandidates`）：
 * 那几个函数是应用侧与插件侧共用的同一份实现，各写一套必然漂移。
 *
 * ## 规则的唯一权威在插件
 *
 * 这里**不存规则**。读走 `tamper-get`、写走 `tamper-set`，中间不落地 ——
 * 面板自己存一份就会与插件那份漂移，症状是"面板显示启用中、页面里没生效"。
 * 本地只留"正在编辑的草稿"，且草稿在保存成功后立即丢弃。
 */

/* ========================================================================== */
/* 规则页                                                                      */
/* ========================================================================== */

/**
 * 一条规则的编辑动作。
 *
 * 新增规则的默认值刻意是**空目标键**：它会被引擎丢弃，而 `collectDroppedRules`
 * 会把这件事报出来（见下面的提示条）。给一个能猜的默认值（比如 `is_vip`）更糟 ——
 * 用户不填就得到一个"看起来在生效"的规则。
 */
const emptyFieldRule = (): TamperRule => ({ id: `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`, enabled: true, urlPattern: '', jsonPath: '', newValue: '' });
const emptyHeaderRule = (): HeaderRule => ({ id: `h${Date.now()}${Math.random().toString(36).slice(2, 6)}`, enabled: true, urlPattern: '', headerName: '', headerValue: '' });

const FieldInput = ({
    label,
    value,
    placeholder,
    onChange,
    hint,
    tone,
}: {
    label: string;
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
    hint?: string;
    tone?: string;
}) => (
    <label className="block min-w-0">
        <span className="mb-0.5 block text-[9px] font-bold uppercase tracking-wider text-slate-600">{label}</span>
        <input
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
            className={`w-full rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1 font-mono text-[10px] outline-none transition focus:border-white/25 ${tone || 'text-slate-200'}`}
        />
        {hint && <span className="mt-0.5 block truncate text-[9px] text-slate-600">{hint}</span>}
    </label>
);

/** 一组字段规则（响应篡改 / 请求体篡改共用同一个编辑器） */
const RuleSection = ({
    title,
    desc,
    rules,
    onChange,
    tone,
}: {
    title: string;
    desc: string;
    rules: TamperRule[];
    onChange: (rules: TamperRule[]) => void;
    tone: string;
}) => {
    const update = (index: number, field: keyof TamperRule, value: unknown) => {
        const next = [...rules];
        next[index] = { ...next[index], [field]: value };
        onChange(next);
    };

    return (
        <section>
            <div className="mb-1.5 flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <h4 className={`text-[11px] font-bold ${tone}`}>{title}</h4>
                    <p className="mt-0.5 text-[9px] leading-relaxed text-slate-600">{desc}</p>
                </div>
                <button
                    type="button"
                    onClick={() => onChange([...rules, emptyFieldRule()])}
                    className="shrink-0 rounded-lg border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-300 transition hover:bg-white/[0.12] hover:text-white"
                >
                    新增
                </button>
            </div>

            {rules.length === 0 ? (
                <p className="rounded-lg border border-dashed border-white/10 px-2 py-2 text-[10px] text-slate-600">还没有规则。</p>
            ) : (
                <div className="space-y-1.5">
                    {rules.map((rule, index) => (
                        <div
                            key={rule.id || index}
                            className={`rounded-lg border p-1.5 ${rule.enabled ? 'border-white/10 bg-white/[0.04]' : 'border-white/5 bg-black/20 opacity-60'}`}
                        >
                            <div className="mb-1 flex items-center gap-1.5">
                                <input
                                    type="checkbox"
                                    checked={rule.enabled}
                                    onChange={(event) => update(index, 'enabled', event.target.checked)}
                                    className="h-3 w-3 accent-fuchsia-400"
                                />
                                <span className="text-[9px] text-slate-500">{rule.enabled ? '启用中' : '已禁用'}</span>
                                {isFieldRuleDropped(rule) && (
                                    <span className="rounded bg-amber-500/20 px-1 text-[9px] text-amber-300" title="目标键为空，引擎会跳过这条规则">
                                        会被跳过
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => onChange(rules.filter((_, i) => i !== index))}
                                    className="ml-auto shrink-0 text-[9px] text-slate-600 transition hover:text-rose-300"
                                >
                                    删除
                                </button>
                            </div>
                            {/* 面板窄，字段竖排；不并排是为了让输入框有足够宽度写字 */}
                            <div className="space-y-1">
                                <FieldInput label="URL 匹配" value={rule.urlPattern} placeholder="*（全部）" onChange={(v) => update(index, 'urlPattern', v)} />
                                <FieldInput
                                    label="目标键"
                                    value={rule.jsonPath}
                                    placeholder="例如 is_vip"
                                    onChange={(v) => update(index, 'jsonPath', v)}
                                    hint={ruleTargetKey(rule.jsonPath) ? `实际匹配字段：${ruleTargetKey(rule.jsonPath)}` : undefined}
                                />
                                <FieldInput
                                    label="新值"
                                    value={rule.newValue}
                                    placeholder="true（加 = 强制当字符串）"
                                    onChange={(v) => update(index, 'newValue', v)}
                                    tone={tone}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
};

export const RulesTab = ({
    rules,
    onChange,
}: {
    rules: { interceptRules: TamperRule[]; requestRules: TamperRule[]; headerRules: HeaderRule[] };
    onChange: (next: { interceptRules: TamperRule[]; requestRules: TamperRule[]; headerRules: HeaderRule[] }) => void;
}) => (
    <div className="space-y-4">
        {/*
          能力边界必须写出来。不写的话，用户遇到"改了没反应"会一直以为
          是自己规则写错了，而真正的原因在架构上（钩子只装在页面主世界）。
        */}
        <div className="rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1.5 text-[9px] leading-relaxed text-slate-500">
            规则作用于<strong className="text-slate-400">当前页面的 JS</strong>（XHR / fetch / 存储）。
            以下不生效：Web Worker / Service Worker 内部解析、跨域 iframe 内的请求、
            页面在注入前就存下了 <code className="text-slate-400">JSON.parse</code> 引用、WASM 解析。
            <br />
            存储规则只覆盖 <code className="text-slate-400">storage.getItem(k)</code>，
            不覆盖 <code className="text-slate-400">storage[k]</code> 这种具名属性读法。
        </div>

        <RuleSection
            title="响应篡改"
            desc="拦截 JSON 响应并替换目标字段。同名规则也会改写 localStorage / sessionStorage 的读取结果。"
            tone="text-cyan-300"
            rules={rules.interceptRules}
            onChange={(interceptRules) => onChange({ ...rules, interceptRules })}
        />
        <RuleSection
            title="请求体篡改"
            desc="在请求发出前修改 JSON Body 中的目标字段。"
            tone="text-violet-300"
            rules={rules.requestRules}
            onChange={(requestRules) => onChange({ ...rules, requestRules })}
        />
    </div>
);

/* ========================================================================== */
/* 请求头页                                                                    */
/* ========================================================================== */

/**
 * 请求头控制页。
 *
 * `headerValue` 留空 = **删除**该请求头（引擎里 `''` 有专门语义）。
 * 占位符必须写出来，否则用户以为留空是"不改"。
 */
export const HeadersTab = ({
    headers,
    onChange,
}: {
    headers: HeaderRule[];
    onChange: (rules: HeaderRule[]) => void;
}) => {
    const update = (index: number, field: keyof HeaderRule, value: unknown) => {
        const next = [...headers];
        next[index] = { ...next[index], [field]: value };
        onChange(next);
    };

    return (
        <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <h4 className="text-[11px] font-bold text-amber-300">请求头注入</h4>
                    <p className="mt-0.5 text-[9px] leading-relaxed text-slate-600">
                        修改或注入 HTTP Request Headers，例如 Authorization、User-Agent。
                        <strong className="text-slate-400"> 值留空表示删除该请求头。</strong>
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => onChange([...headers, emptyHeaderRule()])}
                    className="shrink-0 rounded-lg border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-300 transition hover:bg-white/[0.12] hover:text-white"
                >
                    新增
                </button>
            </div>

            {headers.length === 0 ? (
                <p className="rounded-lg border border-dashed border-white/10 px-2 py-2 text-[10px] text-slate-600">还没有请求头规则。</p>
            ) : (
                <div className="space-y-1.5">
                    {headers.map((rule, index) => (
                        <div
                            key={rule.id || index}
                            className={`rounded-lg border p-1.5 ${rule.enabled ? 'border-white/10 bg-white/[0.04]' : 'border-white/5 bg-black/20 opacity-60'}`}
                        >
                            <div className="mb-1 flex items-center gap-1.5">
                                <input
                                    type="checkbox"
                                    checked={rule.enabled}
                                    onChange={(event) => update(index, 'enabled', event.target.checked)}
                                    className="h-3 w-3 accent-amber-400"
                                />
                                <span className="text-[9px] text-slate-500">{rule.enabled ? '启用中' : '已禁用'}</span>
                                {isHeaderRuleDropped(rule) && (
                                    <span className="rounded bg-amber-500/20 px-1 text-[9px] text-amber-300" title="Header 名为空，引擎会跳过这条规则">
                                        会被跳过
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => onChange(headers.filter((_, i) => i !== index))}
                                    className="ml-auto shrink-0 text-[9px] text-slate-600 transition hover:text-rose-300"
                                >
                                    删除
                                </button>
                            </div>
                            <div className="space-y-1">
                                <FieldInput label="URL 匹配" value={rule.urlPattern} placeholder="*（全部）" onChange={(v) => update(index, 'urlPattern', v)} />
                                <FieldInput label="Header 名" value={rule.headerName} placeholder="例如 Authorization" onChange={(v) => update(index, 'headerName', v)} />
                                <FieldInput
                                    label="值"
                                    value={rule.headerValue}
                                    placeholder="留空 = 删除该请求头"
                                    onChange={(v) => update(index, 'headerValue', v)}
                                    tone="text-amber-300"
                                />
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

/* ========================================================================== */
/* 存储页                                                                      */
/* ========================================================================== */

/** 三块存储的展开态。默认只展开 localStorage —— 三块全开时列表太长 */
interface StorageData {
    local: Record<string, string>;
    session: Record<string, string>;
    cookies: CookieItem[];
}

const parseObject = (text: string): Record<string, string> => {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        // 页面禁用了存储或读回的不是 JSON：当作空，而不是让整个页签崩掉
        return {};
    }
};

/**
 * 存储页。
 *
 * ## 为什么 Cookie 也在这里
 *
 * 三者是同一件事的三个面："页面能读到什么"。分开成两个页签会让用户为了
 * 改一个 token 先想清楚"它到底在 cookie 里还是 localStorage 里" ——
 * 而那正是他要来这里查的问题。
 *
 * ## 改 Cookie 必须带完整对象
 *
 * `chrome.cookies.set` 是**整条覆盖**：漏掉 httpOnly 会把 HttpOnly 会话 cookie
 * 降级成 JS 可读的普通 cookie，漏掉 expirationDate 会把持久 cookie 变成会话
 * cookie（关掉窗口就掉登录态）。所以这里把原条目整个传回去，只换 value。
 * 这条路径由插件的 `page-storage-write` 走 `pageHost.setCookie` 保证 ——
 * 面板不自己拼 cookie 对象。
 */
export const StorageTab = ({ pageUrl }: { pageUrl: string }) => {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({ local: true, session: false, cookie: false });
    const [data, setData] = useState<StorageData>({ local: {}, session: {}, cookies: [] });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const result = await bridge<{ local: string; session: string; cookies: CookieItem[] }>('page-storage-read');
            setData({
                local: parseObject(result.local),
                session: parseObject(result.session),
                cookies: Array.isArray(result.cookies) ? result.cookies : [],
            });
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    // 存储按当前页面取，切标签页时重新读
    useEffect(() => { void refresh(); }, [refresh, pageUrl]);

    const write = useCallback(async (area: 'local' | 'session', key: string, value: string | null) => {
        try {
            const result = await bridge<{ ok: boolean }>('page-storage-write', { area, key, value });
            setError(result.ok ? '' : '写入失败：页面可能已禁用存储或配额已满。');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        await refresh();
    }, [refresh]);

    /** 改一条 cookie。走插件侧整条覆盖语义，只换 value，见上面那段 */
    const writeCookie = useCallback(async (cookie: CookieItem, value: string) => {
        try {
            const result = await bridge<{ ok: boolean }>('page-storage-write', {
                area: 'cookie',
                // cookie 的写入是整条覆盖，必须把原条目整个传回去（保留 httpOnly /
                // 过期时间），只换 value。插件侧按这个对象调 pageHost.setCookie。
                key: cookie.name,
                cookie,
                value,
            });
            setError(result.ok ? '' : '写入 Cookie 失败：当前没有可用的页面地址。');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        await refresh();
    }, [refresh]);

    const cookieData = useMemo(() => buildCookieData(data.cookies), [data.cookies]);

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <p className="text-[9px] leading-relaxed text-slate-600">
                    改完即时生效。这里显示的是<strong className="text-slate-400">真实值</strong>，
                    页面 JS 读到的可能被规则改写。
                </p>
                <button
                    type="button"
                    onClick={() => void refresh()}
                    disabled={loading}
                    className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-40"
                >
                    {loading ? '读取中…' : '刷新'}
                </button>
            </div>

            {error && (
                <div className="flex items-start justify-between gap-2 rounded-lg border border-rose-400/20 bg-rose-500/[0.08] px-2 py-1.5 text-[9px] text-rose-200">
                    <span className="min-w-0">{error}</span>
                    <button type="button" onClick={() => setError('')} className="shrink-0 text-rose-300/70 hover:text-rose-100">关闭</button>
                </div>
            )}

            <StorageGroup
                title="Local Storage"
                expanded={!!expanded.local}
                onToggle={() => setExpanded((prev) => ({ ...prev, local: !prev.local }))}
                data={data.local}
                onSave={(key, value) => void write('local', key, value)}
                onDelete={(key) => void write('local', key, null)}
            />
            <StorageGroup
                title="Session Storage"
                expanded={!!expanded.session}
                onToggle={() => setExpanded((prev) => ({ ...prev, session: !prev.session }))}
                data={data.session}
                onSave={(key, value) => void write('session', key, value)}
                onDelete={(key) => void write('session', key, null)}
            />
            <StorageGroup
                title="Cookies"
                expanded={!!expanded.cookie}
                onToggle={() => setExpanded((prev) => ({ ...prev, cookie: !prev.cookie }))}
                /*
                 * 同名 cookie 在 Chrome 里按 name+domain+path 并存，访问子域时会
                 * 同时返回 `sid@sub.example.com` 与 `sid@.example.com`。键必须能
                 * 区分它们，否则面板少显示一条、且回写只会命中先出现的那条。
                 */
                data={cookieData}
                onSave={(key, value) => {
                    const cookie = findCookieByKey(data.cookies, key);
                    if (cookie) void writeCookie(cookie, value);
                }}
                onDelete={(key) => {
                    const cookie = findCookieByKey(data.cookies, key);
                    if (cookie) void writeCookie(cookie, '');
                }}
            />
        </div>
    );
};

/** 一块存储：折叠头 + 键值列表。每行的编辑是就地输入，改完失焦即保存 */
const StorageGroup = ({
    title,
    expanded,
    onToggle,
    data,
    onSave,
    onDelete,
}: {
    title: string;
    expanded: boolean;
    onToggle: () => void;
    data: Record<string, string>;
    onSave: (key: string, value: string) => void;
    onDelete: (key: string) => void;
}) => {
    const keys = Object.keys(data);

    return (
        <div className="rounded-lg border border-white/10 bg-white/[0.02]">
            <button
                type="button"
                onClick={onToggle}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition hover:bg-white/[0.04]"
            >
                <span className="text-[10px] text-slate-400">{expanded ? '▾' : '▸'}</span>
                <span className="text-[11px] text-slate-300">{title}</span>
                <span className="ml-auto font-mono text-[9px] text-slate-600">{keys.length}</span>
            </button>

            {expanded && (
                keys.length === 0 ? (
                    <p className="border-t border-white/5 px-2 py-1.5 text-[9px] text-slate-600">没有数据。</p>
                ) : (
                    <ul className="divide-y divide-white/5 border-t border-white/5">
                        {keys.map((key) => (
                            <StorageRow key={key} name={key} value={data[key]} onSave={onSave} onDelete={onDelete} />
                        ))}
                    </ul>
                )
            )}
        </div>
    );
};

/**
 * 一行存储。
 *
 * ## 为什么用受控草稿而不是直接改
 *
 * 每敲一个字符就写回页面等于每敲一个字符改一次页面状态，而页面可能正读着它 ——
 * 且写盘是跨进程往返，打字会卡。所以本地留草稿，失焦或回车才提交。
 *
 * ## 为什么长值要折叠
 *
 * token 动辄几百字符，全展开会把列表冲得没法看。但**不能截断显示** ——
 * 用户来这里正是要抄那个值。给一个展开开关而不是切片。
 */
const StorageRow = ({
    name,
    value,
    onSave,
    onDelete,
}: {
    name: string;
    value: string;
    onSave: (key: string, value: string) => void;
    onDelete: (key: string) => void;
}) => {
    const [draft, setDraft] = useState(value);
    const [expanded, setExpanded] = useState(false);

    /* 外部刷新（切页面、重读）之后草稿要跟着走，否则界面显示的是过期值 */
    useEffect(() => setDraft(value), [value]);

    const commit = () => {
        if (draft !== value) onSave(name, draft);
    };

    const long = value.length > 80;

    return (
        <li className="px-2 py-1.5">
            <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-400" title={name}>{name}</span>
                {long && (
                    <button
                        type="button"
                        onClick={() => setExpanded((v) => !v)}
                        className="shrink-0 text-[9px] text-slate-600 transition hover:text-slate-300"
                    >
                        {expanded ? '收起' : '展开'}
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => onDelete(name)}
                    className="shrink-0 text-[9px] text-slate-600 transition hover:text-rose-300"
                >
                    删除
                </button>
            </div>
            {expanded ? (
                <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commit}
                    spellCheck={false}
                    rows={3}
                    className="mt-0.5 w-full resize-y rounded border border-white/10 bg-slate-950/70 px-1.5 py-1 font-mono text-[10px] text-slate-300 outline-none focus:border-white/25"
                />
            ) : (
                <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commit}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); commit(); }
                    }}
                    spellCheck={false}
                    className="mt-0.5 w-full rounded border border-white/10 bg-slate-950/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 outline-none focus:border-white/25"
                />
            )}
        </li>
    );
};

/* ========================================================================== */
/* JWT 页                                                                      */
/* ========================================================================== */

/**
 * JWT 解码页。
 *
 * ## 只做解码，不做改写
 *
 * 改 payload 会让签名失效（签名覆盖的正是 payload），而"改完还能用"这件事
 * 在客户端做不到。这类改写要交给 Agent 的 `tokens` 工具 —— 它会一并说明后果。
 * 给一个点了之后页面直接掉登录态的按钮，比没有这个功能更糟。
 *
 * ## 「自动查找」的判据与应用侧共用
 *
 * `pickJwtCandidates` 只要求**两段** base64url 即可：未签名的调试 token 只有
 * 两段，要求三段会把它们全漏掉。这个判据写在 `shared/core/jwt.ts` 里，
 * 面板与 Agent 工具读的是同一份。
 */
export const JwtTab = ({ pageUrl }: { pageUrl: string }) => {
    const [input, setInput] = useState('');
    const [searchHint, setSearchHint] = useState('');

    /*
     * 解码结果由输入派生，不存 state。
     *
     * 存 state 就要在 input 变化时同步一次 —— 那是一个可以忘、忘了之后界面
     * 显示上一次结果的状态。`useMemo` 让它结构上不可能不同步。
     */
    const decoded = useMemo(() => {
        if (!input.trim()) return null;
        try {
            const { header, payload } = decodeJwt(input.trim());
            return { header: JSON.stringify(header, null, 2), payload: JSON.stringify(payload, null, 2), error: '' };
        } catch (e) {
            return { header: '', payload: '', error: e instanceof Error ? e.message : '解析失败' };
        }
    }, [input]);

    /**
     * 从 Cookie / localStorage / sessionStorage 里找一个 JWT。
     *
     * 走 `page-storage-read` 一次取回三样 —— 与应用侧的 `findJwt` 同一判据，
     * 但不用三次跨进程调用。
     */
    const findJwt = useCallback(async () => {
        setSearchHint('');
        try {
            const result = await bridge<{ local: string; session: string; cookies: CookieItem[] }>('page-storage-read');
            const values: unknown[] = [
                ...(result.cookies || []).map((cookie) => cookie.value),
                ...Object.values(parseObject(result.local)),
                ...Object.values(parseObject(result.session)),
            ];
            const [first] = pickJwtCandidates(values);
            if (first) { setInput(first); return; }
            setSearchHint('未在 Cookie 与本地存储里找到 JWT。');
        } catch (e) {
            setSearchHint(e instanceof Error ? e.message : String(e));
        }
    }, []);

    // 换页面时清空：上一个站点的 token 留在这里只会让人误以为它是当前页的
    useEffect(() => { setInput(''); setSearchHint(''); }, [pageUrl]);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
                <label className="text-[9px] font-bold uppercase tracking-wider text-slate-600">Encoded Token</label>
                <button
                    type="button"
                    onClick={() => void findJwt()}
                    className="rounded-lg border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/[0.12] hover:text-white"
                >
                    自动查找
                </button>
            </div>

            <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="请粘贴 JWT，例如 eyJhbGciOi…"
                spellCheck={false}
                rows={3}
                className="w-full resize-y rounded-lg border border-white/10 bg-slate-950/70 p-2 font-mono text-[10px] leading-relaxed text-slate-300 outline-none transition focus:border-rose-400/40"
            />

            {searchHint && (
                <div className="rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1.5 text-[9px] text-slate-400">{searchHint}</div>
            )}

            {decoded?.error && (
                <div className="rounded-lg border border-amber-400/20 bg-amber-500/[0.08] px-2 py-1.5 text-[9px] text-amber-200">
                    无法解析：{decoded.error}
                </div>
            )}

            {/* 上下叠放：面板窄，Header 与 Payload 并排会把两边都挤成竖排单字 */}
            <JwtPanel title="Header" tone="text-rose-300" content={decoded?.header || '// Header info'} />
            <JwtPanel title="Payload" tone="text-violet-300" content={decoded?.payload || '// Payload data'} />

            <p className="text-[9px] leading-relaxed text-slate-600">
                只做解码。改 payload 会让签名失效（签名覆盖的正是 payload），
                这类改写请让 Agent 用 <code className="font-mono">tokens</code> 工具做。
            </p>
        </div>
    );
};

const JwtPanel = ({ title, tone, content }: { title: string; tone: string; content: string }) => (
    <div className="flex flex-col gap-1">
        <label className={`text-[9px] font-bold uppercase tracking-wider ${tone}`}>{title}</label>
        <div className="max-h-40 overflow-auto rounded-lg border border-white/10 bg-white/[0.03] p-2">
            <pre className={`whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed ${tone}`}>{content}</pre>
        </div>
    </div>
);

/** 规则的"会被跳过"提示条。与引擎的丢弃判据同一份（collectDroppedRules） */
export const droppedHint = (rules: { interceptRules: TamperRule[]; requestRules: TamperRule[]; headerRules: HeaderRule[] }): string => {
    const dropped = collectDroppedRules({
        intercept: rules.interceptRules,
        request: rules.requestRules,
        headers: rules.headerRules,
    });
    if (dropped.length === 0) return '';
    return `有 ${dropped.length} 条启用中的规则没填「目标键 / Header 名」，引擎会跳过它们。`;
};
