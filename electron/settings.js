const fs = require('fs');
const path = require('path');

/**
 * 应用设置：主进程侧持久化（userData/settings.json）。
 *
 * 代理端口放在这里而不是 localStorage，原因有两个：
 * 1. 主进程启动时（app.whenReady 之前）就要知道走不走代理，那时渲染进程还没起来，
 *    读不到 localStorage；
 * 2. 代理是网络层配置，渲染层只是它的一个编辑入口，真值必须由主进程持有，
 *    否则"改了配置但主进程没变"这类不一致迟早出现。
 *
 * AI 配置（baseUrl / 密钥 / 模型 / 思考强度）同样落在这里，理由不同但结论一致：
 * 悬浮面板的「设置」是唯一入口，一份配置一个真值来源，不再散落到 localStorage。
 *
 * 语义（用户约定）：
 * - 代理端口留空 = 一律直连，不做任何系统代理探测；
 *   有值 = 用这个端口（host:port，或只写端口号则默认 127.0.0.1）。
 * - AI 走 OpenAI 兼容协议（/chat/completions），默认指向本地 tc2api。
 */

/** 思考强度档位：与 tc2api 的 reasoning_effort 取值一致，非法值服务端会直接 503 */
const REASONING_EFFORTS = ['low', 'high', 'max'];

/** AI 服务默认值：本地 tc2api，开箱即用 */
const DEFAULT_AI = {
    baseUrl: 'http://127.0.0.1:7863/v1',
    apiKey: '1',
    model: 'global:deepseek-v4.1-flash',
    reasoningEffort: 'low',
};

const DEFAULT_SETTINGS = {
    proxyPort: '',
    ai: { ...DEFAULT_AI },
};

let cachedSettingsPath = null;
let cachedSettings = null;

function settingsPath() {
    if (cachedSettingsPath) return cachedSettingsPath;
    // app 在 Electron 主进程才可用；测试/纯 Node 载入时回落到临时目录，
    // 避免 require 阶段直接抛错导致整个模块不可用。
    let dir;
    try {
        const { app } = require('electron');
        dir = app.getPath('userData');
    } catch (_e) {
        dir = path.join(require('os').tmpdir(), 'the-play-settings');
    }
    cachedSettingsPath = path.join(dir, 'settings.json');
    return cachedSettingsPath;
}

/**
 * 归一化 AI 配置。存量配置可能是手改过的、缺字段的、或上一版结构，
 * 这里保证任何输入都能得到一份字段齐全且合法的配置，读盘阶段不抛错。
 * 非法值一律回落到默认值，而不是让整个 AI 功能不可用。
 */
function normalizeAiConfig(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
    const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    const effort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : '';

    return {
        baseUrl: baseUrl || DEFAULT_AI.baseUrl,
        // 密钥允许为空（本地服务常常不校验）。字段存在就尊重它，哪怕存的是空串——
        // 用户主动清空过，不该被"默认值"悄悄填回去；字段整个缺失才是没配过。
        apiKey: typeof raw.apiKey === 'string' ? apiKey : DEFAULT_AI.apiKey,
        model: model || DEFAULT_AI.model,
        reasoningEffort: REASONING_EFFORTS.includes(effort) ? effort : DEFAULT_AI.reasoningEffort,
    };
}

function readSettings() {
    if (cachedSettings) return cachedSettings;
    let parsed = {};
    try {
        const raw = fs.readFileSync(settingsPath(), 'utf8');
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') parsed = obj;
    } catch (_e) {
        // 首次运行没有文件、或文件被写坏：都按默认值起步，不阻断启动
    }
    cachedSettings = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        // ai 是嵌套对象，浅合并会让"只存了半个 ai"的旧文件丢掉其余默认值
        ai: normalizeAiConfig(parsed.ai),
    };
    return cachedSettings;
}

function writeSettings(patch) {
    const next = { ...readSettings(), ...patch };
    try {
        const file = settingsPath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch (error) {
        // 写盘失败时绝不能改缓存：否则内存已是新值、磁盘还是旧值，
        // 界面显示"已保存"而重启后配置回退，且失败返回值会自相矛盾。
        return { success: false, message: `设置保存失败：${error.message}` };
    }
    cachedSettings = next;
    return { success: true };
}

/**
 * 归一化用户填写的代理端口/地址。
 * 接受 "10810"、"127.0.0.1:10810"、"http://127.0.0.1:10810"、"[::1]:10810"。
 * 返回 { value, error }：value 为空串表示"留空 = 直连"。
 */
function normalizeProxyInput(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return { value: '', error: '' };

    // 只有数字：视为 127.0.0.1:<port>
    if (/^\d+$/.test(raw)) {
        const port = Number(raw);
        if (port < 1 || port > 65535) return { value: '', error: '端口需在 1-65535 之间' };
        return { value: `127.0.0.1:${port}`, error: '' };
    }

    const s = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const idx = s.lastIndexOf(':');
    if (idx <= 0) return { value: '', error: '格式应为 端口 或 主机:端口，例如 10810 / 127.0.0.1:10810' };
    const host = s.slice(0, idx).replace(/^\[|\]$/g, '').trim();
    const port = Number(s.slice(idx + 1));
    if (!host) return { value: '', error: '缺少主机名' };
    if (!/^\d+$/.test(s.slice(idx + 1).trim()) || !Number.isInteger(port) || port < 1 || port > 65535) {
        return { value: '', error: '端口需为 1-65535 的整数' };
    }
    if (/\s/.test(host)) return { value: '', error: '主机名不能包含空格' };
    // IPv6 保留方括号：裸写的 ::1:10810 无法与 host:port 区分，回读会解析错
    const hostPart = host.includes(':') ? `[${host}]` : host;
    return { value: `${hostPart}:${port}`, error: '' };
}

/**
 * 校验用户填写的 AI 配置。
 * 返回 { value, error }：error 非空表示拒绝保存，value 为归一化结果。
 */
function normalizeAiInput(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const baseUrl = String(raw.baseUrl == null ? '' : raw.baseUrl).trim();
    const apiKey = String(raw.apiKey == null ? '' : raw.apiKey).trim();
    const model = String(raw.model == null ? '' : raw.model).trim();
    const effort = String(raw.reasoningEffort == null ? '' : raw.reasoningEffort).trim();

    if (!baseUrl) return { value: null, error: '接口地址不能为空，例如 http://127.0.0.1:7863/v1' };
    if (!/^https?:\/\//i.test(baseUrl)) return { value: null, error: '接口地址需以 http:// 或 https:// 开头' };
    try {
        // 只做格式校验，不发请求；后续由「测试连接」验证可达性
        new URL(baseUrl);
    } catch (_e) {
        return { value: null, error: '接口地址格式不合法' };
    }
    if (!model) return { value: null, error: '模型名不能为空' };
    if (!REASONING_EFFORTS.includes(effort)) {
        return { value: null, error: `思考强度只能是 ${REASONING_EFFORTS.join(' / ')}` };
    }

    return {
        // 去掉结尾斜杠：拼接 /chat/completions 时不会出现双斜杠
        value: {
            baseUrl: baseUrl.replace(/\/+$/, ''),
            apiKey,
            model,
            reasoningEffort: effort,
        },
        error: '',
    };
}

function getSettings() {
    return { ...readSettings() };
}

/**
 * 保存代理端口。返回 { success, proxyPort, normalized, message }。
 * 空值合法（表示直连），非法值拒绝保存并回传原因。
 */
function saveProxyPort(input) {
    const { value, error } = normalizeProxyInput(input);
    if (error) return { success: false, proxyPort: readSettings().proxyPort, normalized: '', message: error };
    const res = writeSettings({ proxyPort: value });
    if (!res.success) return { success: false, proxyPort: readSettings().proxyPort, normalized: value, message: res.message };
    return {
        success: true,
        proxyPort: value,
        normalized: value,
        message: value ? `已启用代理 ${value}` : '已留空：所有请求直连，不使用代理',
    };
}

/**
 * 保存 AI 配置。返回 { success, ai, message }。
 * 密钥允许为空（部分本地服务不校验），其余字段非法则整份拒绝，避免存下半套配置。
 */
function saveAiConfig(input) {
    const { value, error } = normalizeAiInput(input);
    if (error) return { success: false, ai: getSettings().ai, message: error };
    const res = writeSettings({ ai: value });
    if (!res.success) return { success: false, ai: getSettings().ai, message: res.message };
    return { success: true, ai: value, message: `已保存：${value.model}（思考强度 ${value.reasoningEffort}）` };
}

/**
 * 真实探活：拿当前配置发一次最小请求，验证地址/密钥/模型三者确实可用。
 * 设置面板的「测试连接」用它，避免用户存了一份连不上的配置却毫不知情。
 */
async function testAiConnection(input) {
    const { value, error } = normalizeAiInput(input);
    if (error) return { success: false, message: error };

    const startedAt = Date.now();
    try {
        const response = await fetch(`${value.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(value.apiKey ? { Authorization: `Bearer ${value.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: value.model,
                messages: [{ role: 'user', content: 'ping' }],
                // 128 而非 8：推理模型的思考过程也占 completion 预算，
                // 给太小会导致 content 为空，探活看起来"通了但没回话"
                max_tokens: 128,
                reasoning_effort: value.reasoningEffort,
            }),
            signal: AbortSignal.timeout(20000),
        });

        const latency = Date.now() - startedAt;
        const text = await response.text();

        if (!response.ok) {
            // 服务端报错正文往往比状态码有用得多（模型名写错 / 密钥不对都在这条路上）
            return { success: false, message: `HTTP ${response.status}：${text.slice(0, 300)}` };
        }

        let reply = '';
        let resolvedModel = value.model;
        try {
            const data = JSON.parse(text);
            reply = data?.choices?.[0]?.message?.content || '';
            resolvedModel = data?.model || value.model;
        } catch (_e) {
            // 200 但正文不是 JSON：仍然算连通，只是拿不到回显
        }

        return {
            success: true,
            message: `连接正常（${latency}ms）`,
            latency,
            model: resolvedModel,
            reply: String(reply).slice(0, 120),
        };
    } catch (err) {
        const reason = err && err.name === 'TimeoutError' ? '请求超时（20s）' : (err && err.message) || '未知错误';
        return { success: false, message: `连接失败：${reason}` };
    }
}

module.exports = {
    getSettings,
    saveProxyPort,
    normalizeProxyInput,
    saveAiConfig,
    testAiConnection,
    normalizeAiConfig,
    DEFAULT_AI,
    REASONING_EFFORTS,
};
