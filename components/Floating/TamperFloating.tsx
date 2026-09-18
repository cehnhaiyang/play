import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Globe,
  KeyRound,
  Layers,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Trash2,
  Zap,
} from 'lucide-react';
import { useTamper } from '../../hooks';
import { HeaderRule, TamperRule, getElectronAPI } from '../../meta';
import { generateId } from '../../utils';

interface TamperFloatingProps {
  tamper: ReturnType<typeof useTamper>;
  currentUrl: string;
}

type TabType = 'rules' | 'headers' | 'storage' | 'jwt';

export const TamperFloating: React.FC<TamperFloatingProps> = ({ tamper, currentUrl }) => {
  const { state, actions } = tamper;
  const { interceptRules, requestRules, headerRules } = state;

  const [activeTab, setActiveTab] = useState<TabType>('rules');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    local: true,
    session: false,
    cookie: false,
  });
  const [localIntercept, setLocalIntercept] = useState<TamperRule[]>([]);
  const [localRequest, setLocalRequest] = useState<TamperRule[]>([]);
  const [localHeaders, setLocalHeaders] = useState<HeaderRule[]>([]);
  const [cookies, setCookies] = useState<any[]>([]);
  const [localStorageData, setLocalStorageData] = useState<Record<string, string>>({});
  const [sessionStorageData, setSessionStorageData] = useState<Record<string, string>>({});
  const [jwtInput, setJwtInput] = useState('');
  const [jwtDecoded, setJwtDecoded] = useState<{ header: string; payload: string } | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');

  const refreshStorage = useCallback(async () => {
    const electronAPI = getElectronAPI();
    if (electronAPI) {
      const currentCookies = await electronAPI.getCookies(currentUrl);
      setCookies(currentCookies);
    }

    const lsStr = await actions.getLocalStorage();
    try {
      setLocalStorageData(JSON.parse(lsStr));
    } catch {
      setLocalStorageData({});
    }

    const ssStr = await actions.getSessionStorage();
    try {
      setSessionStorageData(JSON.parse(ssStr));
    } catch {
      setSessionStorageData({});
    }
  }, [actions, currentUrl]);

  useEffect(() => {
    setLocalIntercept(interceptRules);
    setLocalRequest(requestRules);
    setLocalHeaders(headerRules);
    void refreshStorage();
  }, [headerRules, interceptRules, requestRules, refreshStorage]);

  useEffect(() => {
    if (saveStatus !== 'saved') {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  useEffect(() => {
    if (!jwtInput) {
      setJwtDecoded(null);
      return;
    }

    try {
      const [headerB64, payloadB64] = jwtInput.split('.');
      if (!headerB64 || !payloadB64) {
        throw new Error('Invalid format');
      }

      const headerStr = atob(headerB64.replace(/-/g, '+').replace(/_/g, '/'));
      const payloadStr = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
      setJwtDecoded({
        header: JSON.stringify(JSON.parse(headerStr), null, 2),
        payload: JSON.stringify(JSON.parse(payloadStr), null, 2),
      });
    } catch {
      setJwtDecoded(null);
    }
  }, [jwtInput]);

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const updateRule = (type: 'intercept' | 'request', index: number, field: keyof TamperRule, value: any) => {
    const updater = type === 'intercept' ? setLocalIntercept : setLocalRequest;
    const source = type === 'intercept' ? localIntercept : localRequest;
    const next = [...source];
    next[index] = { ...next[index], [field]: value };
    updater(next);
  };

  const updateHeaderRule = (index: number, field: keyof HeaderRule, value: any) => {
    const next = [...localHeaders];
    next[index] = { ...next[index], [field]: value };
    setLocalHeaders(next);
  };

  const addRule = (type: 'intercept' | 'request') => {
    const newRule: TamperRule = { id: generateId(), enabled: true, urlPattern: '', jsonPath: '', newValue: '' };
    if (type === 'intercept') {
      setLocalIntercept([...localIntercept, newRule]);
      return;
    }

    setLocalRequest([...localRequest, newRule]);
  };

  const addHeaderRule = () => {
    const newRule: HeaderRule = { id: generateId(), enabled: true, urlPattern: '', headerName: '', headerValue: '' };
    setLocalHeaders([...localHeaders, newRule]);
  };

  const removeRule = (type: 'intercept' | 'request', index: number) => {
    if (type === 'intercept') {
      setLocalIntercept(localIntercept.filter((_, currentIndex) => currentIndex !== index));
      return;
    }

    setLocalRequest(localRequest.filter((_, currentIndex) => currentIndex !== index));
  };

  const removeHeaderRule = (index: number) => {
    setLocalHeaders(localHeaders.filter((_, currentIndex) => currentIndex !== index));
  };

  const saveAll = () => {
    actions.saveRules(localIntercept, localRequest, localHeaders);
    setSaveStatus('saved');
  };

  const updateCookie = async (cookie: any, newValue: string) => {
    const electronAPI = getElectronAPI();
    if (!electronAPI) {
      return;
    }

    await electronAPI.setCookie({
      url: currentUrl,
      name: cookie.name,
      value: newValue,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
    });
    await refreshStorage();
  };

  const updateLS = async (key: string, value: string) => {
    await actions.setLocalStorage(key, value);
    await refreshStorage();
  };

  const updateSS = async (key: string, value: string) => {
    await actions.setSessionStorage(key, value);
    await refreshStorage();
  };

  const findJwt = () => {
    const jwtRegex = /^[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+$/;
    for (const cookie of cookies) {
      if (jwtRegex.test(cookie.value)) {
        setJwtInput(cookie.value);
        return;
      }
    }

    for (const value of Object.values(localStorageData)) {
      if (jwtRegex.test(value)) {
        setJwtInput(value);
        return;
      }
    }

    for (const value of Object.values(sessionStorageData)) {
      if (jwtRegex.test(value)) {
        setJwtInput(value);
        return;
      }
    }

    alert('未自动检测到 JWT Token');
  };

  const hostName = (() => {
    try {
      return new URL(currentUrl).hostname;
    } catch {
      return 'N/A';
    }
  })();

  return (
    <div className="flex h-full min-h-0">
      <div className="w-52 shrink-0 border-r border-white/10 pr-4">
        <div className="flex items-center gap-3 border-b border-white/10 pb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-rose-400/20 bg-gradient-to-br from-rose-500/16 to-orange-500/12">
            <ShieldAlert className="h-5 w-5 text-rose-300" />
          </div>
          <div>
            <h3 className="text-base font-bold text-zinc-100">篡改工具</h3>
            <p className="text-[11px] text-zinc-500">规则 / 头 / 存储 / JWT</p>
          </div>
        </div>

        <div className="mt-4 space-y-1">
          <NavButton id="rules" label="拦截规则" icon={Database} activeTab={activeTab} onClick={setActiveTab} />
          <NavButton id="headers" label="请求头控制" icon={ArrowRightLeft} activeTab={activeTab} onClick={setActiveTab} />
          <NavButton id="storage" label="存储管理" icon={Globe} activeTab={activeTab} onClick={setActiveTab} />
          <NavButton id="jwt" label="JWT 调试" icon={KeyRound} activeTab={activeTab} onClick={setActiveTab} />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col pl-5">
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="min-w-0">
            <h4 className="text-lg font-bold text-zinc-100">
              {activeTab === 'rules' && '拦截与篡改'}
              {activeTab === 'headers' && 'HTTP 请求头'}
              {activeTab === 'storage' && '本地存储与 Cookie'}
              {activeTab === 'jwt' && 'JWT 令牌工具'}
            </h4>
            <div className="mt-1 inline-flex max-w-full items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-mono text-zinc-400">
              {hostName}
            </div>
          </div>
          <div className="flex gap-3">
            {activeTab === 'storage' && (
              <button onClick={() => void refreshStorage()} className="rounded-xl border border-white/10 bg-white/5 p-2 text-zinc-400 transition hover:bg-white/10 hover:text-white" title="刷新存储">
                <RefreshCw className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={saveAll}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all ${
                saveStatus === 'saved'
                  ? 'bg-green-600 text-white shadow-[0_0_15px_rgba(22,163,74,0.4)]'
                  : 'bg-white text-zinc-900 hover:bg-slate-100'
              }`}
            >
              {saveStatus === 'saved' ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
              {saveStatus === 'saved' ? '已应用' : '应用更改'}
            </button>
          </div>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-thin">
          {activeTab === 'rules' && (
            <div className="space-y-8">
              <RuleSection
                title="响应篡改"
                desc="拦截 JSON 响应，并替换目标字段的值。适用于 XHR 与 Fetch。"
                color="cyan"
                rules={localIntercept}
                onAdd={() => addRule('intercept')}
                onUpdate={(index, field, value) => updateRule('intercept', index, field, value)}
                onRemove={(index) => removeRule('intercept', index)}
                icon={Database}
              />
              <RuleSection
                title="请求体篡改"
                desc="在请求发出前修改 JSON Body 中的目标字段。"
                color="purple"
                rules={localRequest}
                onAdd={() => addRule('request')}
                onUpdate={(index, field, value) => updateRule('request', index, field, value)}
                onRemove={(index) => removeRule('request', index)}
                icon={Zap}
              />
            </div>
          )}

          {activeTab === 'headers' && (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <h4 className="flex items-center gap-2 text-sm font-bold text-yellow-400">
                    <ArrowRightLeft className="h-4 w-4" />
                    请求头注入
                  </h4>
                  <p className="mt-1 text-xs text-zinc-500">修改或注入 HTTP Request Headers，例如 Authorization、User-Agent。</p>
                </div>
                <button onClick={addHeaderRule} className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/6 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-white/10">
                  <Plus className="h-3.5 w-3.5" />
                  新增规则
                </button>
              </div>
              <div className="space-y-3">
                {localHeaders.length === 0 ? <EmptyState /> : localHeaders.map((rule, index) => (
                  <HeaderRuleRow
                    key={rule.id || index}
                    rule={rule}
                    onChange={(field, value) => updateHeaderRule(index, field, value)}
                    onRemove={() => removeHeaderRule(index)}
                  />
                ))}
              </div>
            </div>
          )}

          {activeTab === 'storage' && (
            <div className="space-y-4">
              <StorageGroup
                title="Local Storage"
                count={Object.keys(localStorageData).length}
                expanded={expandedSections.local}
                onToggle={() => toggleSection('local')}
                data={localStorageData}
                onSave={updateLS}
                icon={Layers}
              />
              <StorageGroup
                title="Session Storage"
                count={Object.keys(sessionStorageData).length}
                expanded={expandedSections.session}
                onToggle={() => toggleSection('session')}
                data={sessionStorageData}
                onSave={updateSS}
                icon={Layers}
              />
              <StorageGroup
                title="Cookies"
                count={cookies.length}
                expanded={expandedSections.cookie}
                onToggle={() => toggleSection('cookie')}
                data={cookies.reduce((acc: Record<string, string>, cookie: any) => ({ ...acc, [cookie.name]: cookie.value }), {})}
                onSave={(key, value) => {
                  const cookie = cookies.find((item) => item.name === key);
                  if (cookie) {
                    void updateCookie(cookie, value);
                  }
                }}
                icon={Globe}
              />
            </div>
          )}

          {activeTab === 'jwt' && (
            <div className="flex h-full min-h-[420px] flex-col gap-4">
              <div className="flex items-end justify-between">
                <div>
                  <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-zinc-500">Encoded Token</label>
                  <button onClick={findJwt} className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/6 px-2 py-1 text-[10px] text-zinc-400 transition hover:text-white">
                    <Search className="h-3 w-3" />
                    自动查找
                  </button>
                </div>
              </div>
              <textarea
                value={jwtInput}
                onChange={(event) => setJwtInput(event.target.value)}
                placeholder="请粘贴 JWT，例如 eyJhbGciOi..."
                className="h-32 w-full resize-none rounded-xl border border-white/10 bg-zinc-950 p-4 font-mono text-xs text-zinc-300 outline-none transition focus:border-rose-500/50"
              />
              <div className="flex min-h-0 flex-1 gap-4">
                <JwtPanel title="Header" color="text-rose-300" content={jwtDecoded?.header || '// Header info'} />
                <JwtPanel title="Payload" color="text-violet-300" content={jwtDecoded?.payload || '// Payload data'} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const NavButton = ({
  id,
  label,
  icon: Icon,
  activeTab,
  onClick,
}: {
  id: TabType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  activeTab: TabType;
  onClick: (id: TabType) => void;
}) => (
  <button
    onClick={() => onClick(id)}
    className={`relative flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-xs font-bold transition-all ${
      activeTab === id ? 'bg-rose-500/12 text-rose-200' : 'text-zinc-500 hover:bg-white/6 hover:text-zinc-200'
    }`}
  >
    <div className={`absolute left-0 top-2 bottom-2 w-1 rounded-full bg-rose-400 transition-transform ${activeTab === id ? 'scale-y-100' : 'scale-y-0'}`} />
    <Icon className={`h-4 w-4 ${activeTab === id ? 'text-rose-300' : 'text-zinc-600'}`} />
    {label}
  </button>
);

const EmptyState: React.FC = () => (
  <div className="rounded-xl border border-dashed border-white/10 bg-white/4 py-8 text-center text-xs text-zinc-500">
    暂无规则配置
  </div>
);

const RuleSection: React.FC<{
  title: string;
  desc: string;
  color: 'cyan' | 'purple';
  rules: TamperRule[];
  onAdd: () => void;
  onUpdate: (index: number, field: keyof TamperRule, value: any) => void;
  onRemove: (index: number) => void;
  icon: React.ComponentType<{ className?: string }>;
}> = ({ title, desc, color, rules, onAdd, onUpdate, onRemove, icon: Icon }) => {
  const colorClass = color === 'cyan' ? 'text-cyan-300' : 'text-purple-300';

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h4 className={`flex items-center gap-2 text-sm font-bold ${colorClass}`}>
            <Icon className="h-4 w-4" />
            {title}
          </h4>
          <p className="mt-1 text-xs text-zinc-500">{desc}</p>
        </div>
        <button onClick={onAdd} className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/6 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-white/10">
          <Plus className="h-3.5 w-3.5" />
          新增规则
        </button>
      </div>
      <div className="space-y-3">
        {rules.length === 0 ? <EmptyState /> : rules.map((rule, index) => (
          <div key={rule.id || index} className={`rounded-xl border p-3 transition-all ${rule.enabled ? 'border-white/10 bg-white/5' : 'border-white/6 bg-black/10 opacity-60 grayscale'}`}>
            <div className="mb-3 flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 select-none">
                <input type="checkbox" checked={rule.enabled} onChange={(event) => onUpdate(index, 'enabled', event.target.checked)} className="accent-rose-400" />
                <span className={`text-xs font-bold ${rule.enabled ? 'text-zinc-200' : 'text-zinc-500'}`}>
                  {rule.enabled ? '启用中' : '已禁用'}
                </span>
              </label>
              <div className="mx-2 h-px flex-1 bg-white/10" />
              <button onClick={() => onRemove(index)} className="text-zinc-500 transition hover:text-rose-300">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <FieldInput
                label="URL 匹配"
                value={rule.urlPattern}
                placeholder="*"
                onChange={(value) => onUpdate(index, 'urlPattern', value)}
                className="md:col-span-2"
              />
              <FieldInput
                label="目标键"
                value={rule.jsonPath}
                placeholder="例如 is_vip"
                onChange={(value) => onUpdate(index, 'jsonPath', value)}
              />
              <FieldInput
                label="新值"
                value={rule.newValue}
                placeholder="例如 true"
                onChange={(value) => onUpdate(index, 'newValue', value)}
                inputClassName={color === 'cyan' ? 'text-cyan-300' : 'text-purple-300'}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const FieldInput: React.FC<{
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  className?: string;
  inputClassName?: string;
}> = ({ label, value, placeholder, onChange, className, inputClassName }) => (
  <div className={`relative ${className || ''}`}>
    <span className="absolute left-2.5 top-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{label}</span>
    <input
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-white/10 bg-black/20 px-2.5 pb-1.5 pt-6 text-xs text-zinc-200 outline-none transition focus:border-white/20 ${inputClassName || ''}`}
    />
  </div>
);

const HeaderRuleRow: React.FC<{
  rule: HeaderRule;
  onChange: (field: keyof HeaderRule, value: any) => void;
  onRemove: () => void;
}> = ({ rule, onChange, onRemove }) => (
  <div className={`flex flex-col gap-3 rounded-xl border p-3 transition-all ${rule.enabled ? 'border-white/10 bg-white/5' : 'border-white/6 bg-black/10 opacity-60'}`}>
    <div className="flex items-center gap-3">
      <input type="checkbox" checked={rule.enabled} onChange={(event) => onChange('enabled', event.target.checked)} className="accent-yellow-500" />
      <input
        type="text"
        value={rule.headerName}
        onChange={(event) => onChange('headerName', event.target.value)}
        placeholder="Header Name"
        className="w-1/3 border-b border-transparent bg-transparent text-xs font-bold text-yellow-400 outline-none transition placeholder:text-zinc-700 hover:border-white/10 focus:border-yellow-500"
      />
      <span className="text-zinc-600">:</span>
      <input
        type="text"
        value={rule.headerValue}
        onChange={(event) => onChange('headerValue', event.target.value)}
        placeholder="Value"
        className="w-1/2 border-b border-transparent bg-transparent text-xs text-zinc-300 outline-none transition placeholder:text-zinc-700 hover:border-white/10 focus:border-yellow-500"
      />
      <button onClick={onRemove} className="ml-auto text-zinc-500 transition hover:text-rose-300">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
    <input
      type="text"
      value={rule.urlPattern}
      onChange={(event) => onChange('urlPattern', event.target.value)}
      placeholder="URL 匹配模式"
      className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[11px] font-mono text-zinc-400 outline-none transition focus:border-white/20"
    />
  </div>
);

const StorageGroup: React.FC<{
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  data: Record<string, string>;
  onSave: (key: string, value: string) => void | Promise<void>;
  icon: React.ComponentType<{ className?: string }>;
}> = ({ title, count, expanded, onToggle, data, onSave, icon: Icon }) => {
  const keys = Object.keys(data);

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
      <button onClick={onToggle} className="flex w-full items-center justify-between px-4 py-3 transition hover:bg-white/6">
        <div className="flex items-center gap-2 text-sm font-bold text-zinc-300">
          <Icon className="h-4 w-4 text-zinc-500" />
          {title}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-zinc-500">{count} 项</span>
          {expanded ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/10">
          {keys.length === 0 ? (
            <div className="p-4 text-center text-xs text-zinc-600">没有可显示的数据</div>
          ) : (
            keys.map((key) => (
              <StorageRow key={key} label={key} value={data[key]} onSave={(value) => onSave(key, value)} />
            ))
          )}
        </div>
      )}
    </div>
  );
};

const StorageRow: React.FC<{ label: string; value: string; onSave: (value: string) => void | Promise<void> }> = ({ label, value, onSave }) => {
  const [draftValue, setDraftValue] = useState(value);
  const hasChanged = draftValue !== value;

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <div className="border-t border-white/6 p-3 first:border-t-0">
      <div className="mb-2 flex items-center justify-between gap-4">
        <span className="max-w-[320px] truncate font-mono text-xs font-bold text-zinc-400" title={label}>
          {label}
        </span>
        {hasChanged && (
          <button onClick={() => void onSave(draftValue)} className="rounded-md bg-green-600 px-2 py-0.5 text-[10px] font-bold text-white transition hover:bg-green-500">
            保存
          </button>
        )}
      </div>
      <textarea
        value={draftValue}
        onChange={(event) => setDraftValue(event.target.value)}
        className="h-16 w-full resize-none rounded-lg border border-white/10 bg-zinc-950 p-2 font-mono text-[10px] text-zinc-300 outline-none transition focus:border-white/20"
        spellCheck={false}
      />
    </div>
  );
};

const JwtPanel: React.FC<{ title: string; color: string; content: string }> = ({ title, color, content }) => (
  <div className="flex min-h-0 flex-1 flex-col gap-2">
    <label className={`text-xs font-bold uppercase tracking-wider ${color}`}>{title}</label>
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-white/10 bg-white/5 p-4">
      <pre className={`whitespace-pre-wrap font-mono text-xs ${color}`}>{content}</pre>
    </div>
  </div>
);
