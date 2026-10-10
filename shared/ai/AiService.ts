import type {
    AiChatMessage,
    AiChatOptions,
    AiConfig,
    AiContentPart,
    AiEffortOption,
    AiImageInput,
    AiModelPreset,
    AiProviderPreset,
    AiStory,
    AiStreamDelta,
    AiTestResult,
    AiUsage,
    FoundLink,
    MediaType,
    ReasoningEffort,
} from '../meta';
import { getElectronAPI } from '../meta';
import { fileToDataUrl, loadStr, saveStr, splitDataUrl } from '../core';

/**
 * ============================================================================
 * AI 服务（OpenAI 兼容协议）
 * ============================================================================
 */

/* -------------------------------------------------------------------------- */
/*                                服务商预设                                   */
/* -------------------------------------------------------------------------- */

/** 默认配置：本地 tc2api。预设表引用它，所以声明在表前面 */
export const DEFAULT_AI_CONFIG: AiConfig = {
    baseUrl: 'http://127.0.0.1:7863/v1',
    apiKey: '1',
    model: 'global:deepseek-v4.1-flash',
    reasoningEffort: 'low',
};

/** 界面档位：不思考 + 低 / 高 / 最大三档 */
export const EFFORT_OPTIONS: AiEffortOption[] = [
    { label: '不思考', hint: '不下发思考参数，由服务商默认行为决定' },
    { value: 'low', label: '低', hint: '最快、省 token' },
    { value: 'high', label: '高', hint: '质量与速度平衡' },
    { value: 'max', label: '最大', hint: '最强推理，最慢' },
];

/** 服务商预设表。都是本地服务，顺序即界面按钮顺序 */
export const AI_PROVIDERS: AiProviderPreset[] = [
    {
        id: 'tc2api',
        label: 'tc2api',
        note: '本地 tc2api（7863），默认密钥 1',
        baseUrl: 'http://127.0.0.1:7863/v1',
        apiKey: '1',
        // reasoning_effort 就叫 low / high / max，三个模型都认，不需要映射
        models: [{ id: 'global:deepseek-v4.1-flash' }, { id: 'deepseek-v4-flash' }, { id: 'global:glm-5.2' }],
    },
    {
        id: 'ofm',
        label: 'gcli2api',
        note: '本地 gcli2api，可用默认密钥；档位写在模型名里，不下发思考参数',
        baseUrl: 'http://127.0.0.1:7861/antigravity/v1/',
        apiKey: 'pwd',
        // 档位已由模型名（-high）决定，再下发 reasoning_effort 只是多余参数
        models: [{ id: 'gemini-3.8-flash-high', reasoning: false }, { id: 'claude-sonnet-4-6', reasoning: false }],
    },
    {
        id: 'agent2api',
        label: 'agent2api',
        note: '本地 agent2api（3065），自带默认密钥',
        baseUrl: 'http://127.0.0.1:3065/v1',
        apiKey: 'sk-a2a-f345da9360a116c54801e02675eb0c37',
        models: [
            // 妙手
            { id: 'LongCat-2.0', reasoning: false, }, { id: 'MiniMax-M3', reasoning: false, }, { id: 'deepseek-v4-flash' }, { id: 'glm-5.3-flashx' },
            // zcode
            { id: 'glm-5.3' }, { id: 'glm-5.3-flash' },
            // qoder
            { id: 'Qwen3.8-Flash', reasoning: false, }, { id: 'GLM-5.3-Flash' }
        ],
    },
];

/** 比地址时忽略大小写与末尾斜杠 */
const normalizeBaseUrl = (url: string): string => (url || '').trim().replace(/\/+$/, '').toLowerCase();

/** 按地址找预设；找不到返回 null */
export const findAiProvider = (baseUrl: string): AiProviderPreset | null =>
    AI_PROVIDERS.find((provider) => normalizeBaseUrl(provider.baseUrl) === normalizeBaseUrl(baseUrl)) || null;

/** 该地址下的模型预设；预设表外的模型名返回 null（没有它的思考配置依据） */
export const findAiModelPreset = (baseUrl: string, model: string): AiModelPreset | null =>
    findAiProvider(baseUrl)?.models.find((entry) => entry.id === model) || null;

/**
 * 这次请求实际下发的 reasoning_effort；返回 undefined 表示不下发该参数。
 *
 * 查表以**模型**为单位：档位是不是要下发、下发成什么取值，是模型的性质，
 * 不是服务商的性质（agent2api 下 LongCat-2.0 不认、glm-5.3 认）。
 *
 * 三种取值：
 * - 档位解析不出来（配置缺省 = 界面选了「不思考」，或调用方显式传空）：不下发；
 * - 命中模型预设且它声明不需要思考（LongCat-2.0、gcli2api 的两个模型）：不下发；
 * - 命中不了模型预设（自定义地址、或预设表里没列的模型名）：没有任何映射依据，
 *   按档位原值下发。界面每个档位按钮下方显示的就是实际取值，一眼能看出区别。
 */
export const resolveReasoningEffort = (config: AiConfig, requested?: ReasoningEffort): string | undefined => {
    const tier = requested || config.reasoningEffort;
    if (!tier) return undefined;

    const model = findAiModelPreset(config.baseUrl, config.model);
    if (!model) return tier;
    if (model.reasoning === false) return undefined;
    return model.efforts?.[tier] || tier;
};

/** 该地址对应的模型候选，界面用 */
export const getModelPresets = (baseUrl: string): AiModelPreset[] =>
    (findAiProvider(baseUrl) || AI_PROVIDERS[0]).models;

/* -------------------------------------------------------------------------- */
/*                                配置读写                                    */
/* -------------------------------------------------------------------------- */

/** 浏览器降级模式下的存储键 */
const AI_CONFIG_STORAGE_KEY = 'play_ai_config';

/** 合法档位：界面、AiService、主进程三处一致；档位可选，缺省即「不思考」 */
const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'high', 'max'];

/** 把任意输入收敛成一份字段齐全且合法的配置 */
const normalizeConfig = (input: Partial<AiConfig> | null | undefined): AiConfig => {
    const raw = input && typeof input === 'object' ? input : {};
    const effort = raw.reasoningEffort as ReasoningEffort | undefined;
    return {
        baseUrl: (raw.baseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_AI_CONFIG.baseUrl,
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : DEFAULT_AI_CONFIG.apiKey,
        model: (raw.model || '').trim() || DEFAULT_AI_CONFIG.model,
        // 档位可选：缺省或非法都当作「不思考」，键直接不落，请求侧自然不下发参数
        ...(effort && REASONING_EFFORTS.includes(effort) ? { reasoningEffort: effort } : {}),
    };
};

/**
 * 读取当前 AI 配置。
 * 优先问主进程；IPC 失败时回落到 localStorage。
 */
export const getAiConfig = async (): Promise<AiConfig> => {
    const settingsApi = getElectronAPI()?.settings;
    if (settingsApi) {
        try {
            const snapshot = await settingsApi.get();
            if (snapshot?.ai) return normalizeConfig(snapshot.ai);
        } catch (_error) {
            // 主进程暂时不可用：继续往下走本地回落，不直接抛错
        }
    }

    try {
        const cached = loadStr(AI_CONFIG_STORAGE_KEY, '', '');
        if (cached) return normalizeConfig(JSON.parse(cached) as Partial<AiConfig>);
    } catch (_error) {
        // 存量配置损坏：按默认值起步
    }

    return { ...DEFAULT_AI_CONFIG };
};

/**
 * 保存 AI 配置。返回主进程（或回落存储）给出的结果。
 * 主进程会做字段校验，非法值不会落盘。
 */
export const saveAiConfig = async (config: AiConfig): Promise<{ success: boolean; message?: string; ai?: AiConfig }> => {
    const settingsApi = getElectronAPI()?.settings;
    if (settingsApi) {
        try {
            const res = await settingsApi.setAiConfig(config);
            if (res?.success && res.ai) return { success: true, message: res.message, ai: res.ai };
            if (res && !res.success) return { success: false, message: res.message };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : '保存失败' };
        }
    }

    // 浏览器回落：本地没有主进程那套校验，这里自己挡一次非法档位
    const normalized = normalizeConfig(config);
    const ok = saveStr(AI_CONFIG_STORAGE_KEY, JSON.stringify(normalized), '');
    return ok
        ? { success: true, message: '已保存到浏览器本地存储', ai: normalized }
        : { success: false, message: '浏览器存储写入失败（可能配额已满）' };
};

/**
 * 测试当前配置能否真正调通。
 * 主进程侧发请求；浏览器回落时用 fetch 自行探测。
 * 档位映射结果一并传给主进程：映射表只在这里，探活发的值要和聊天一致。
 */
export const testAiConnection = async (config: AiConfig): Promise<AiTestResult> => {
    const normalized = normalizeConfig(config);
    // 传 null 而不是 undefined：明确告诉主进程这次不下发思考参数，
    // 否则主进程会回落到配置里的档位，不需要思考的模型（LongCat-2.0）又被塞回一个参数
    const wireEffort = resolveReasoningEffort(normalized) ?? null;

    const settingsApi = getElectronAPI()?.settings;
    if (settingsApi) {
        try {
            return await settingsApi.testAiConfig(normalized, wireEffort);
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : '测试失败' };
        }
    }

    const startedAt = Date.now();
    try {
        const response = await fetch(`${normalized.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(normalized.apiKey ? { Authorization: `Bearer ${normalized.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: normalized.model,
                messages: [{ role: 'user', content: 'ping' }],
                // 128 而非 8：推理模型的思考过程也占 completion 预算，
                // 给太小会导致 content 为空，探活看起来"通了但没回话"
                max_tokens: 128,
                ...(wireEffort ? { reasoning_effort: wireEffort } : {}),
            }),
        });
        const latency = Date.now() - startedAt;
        const text = await response.text();
        if (!response.ok) return { success: false, message: `HTTP ${response.status}：${text.slice(0, 300)}` };

        let reply = '';
        let model = normalized.model;
        try {
            const data = JSON.parse(text);
            reply = data?.choices?.[0]?.message?.content || '';
            model = data?.model || model;
        } catch (_error) {
            // 200 但非 JSON：仍算连通
        }
        return { success: true, message: `连接正常（${latency}ms）`, latency, model, reply: String(reply).slice(0, 120) };
    } catch (error) {
        const reason = error instanceof Error ? error.message : '未知错误';
        return { success: false, message: `连接失败：${reason}` };
    }
};

/* -------------------------------------------------------------------------- */
/*                                底层调用                                     */
/* -------------------------------------------------------------------------- */

/**
 * 服务端错误正文里的 message 字段，比裸状态码有用得多
 */
const extractErrorMessage = (status: number, body: string): string => {
    try {
        const parsed = JSON.parse(body);
        const detail = parsed?.error?.message || parsed?.message;
        if (typeof detail === 'string' && detail.trim()) return detail.trim();
    } catch (_error) {
        // 非 JSON 错误正文：直接截断原文
    }
    return body.trim().slice(0, 300) || `HTTP ${status}`;
};

/* -------------------------------------------------------------------------- */
/*                                token 统计                                   */
/* -------------------------------------------------------------------------- */

/**
 * 本地 token 估算。
 *
 * 只在服务端不回 usage 时用（流式默认不带、部分本地代理不带）。
 *
 * 按**字符类别**分别计数而不是 `字符数 / 4`：Agent 的上下文里中文、代码、
 * JSON 各占相当比例，而三者的 token/字符比差了近 10 倍 —— 一刀切会在
 * 中文占比高的会话里低估一半以上，而"要不要压缩"正是拿这个数判断的。
 *
 * 系数取自各 tokenizer 的公开经验值，误差约 ±20%：
 * - ASCII 字母数字：约 4 字符/token
 * - 中文等 CJK：约 1.5 字符/token（一个汉字常占 1~2 token）
 * - 其余符号与空白：约 3 字符/token
 *
 * 刻意不引入 tokenizer 依赖：这里的用途是"判断上下文是否接近上限"，
 * 不是计费核对。真值由服务端 usage 提供，估算只负责在没有它时给个量级。
 */
export const estimateTokens = (text: string): number => {
    if (!text) return 0;

    let ascii = 0;
    let cjk = 0;
    let other = 0;

    // 用 code point 迭代：中文在 BMP 内，但 emoji 等补充平面字符
    // 用 charCodeAt 会算成两个字符，凭空多算一倍
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x80) {
            if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) ascii += 1;
            else other += 1;
            continue;
        }
        // CJK 统一表意文字、日文假名、韩文音节、全角标点
        if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff)
            || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)
            || (code >= 0xff00 && code <= 0xffef)) {
            cjk += 1;
            continue;
        }
        other += 1;
    }

    return Math.ceil(ascii / 4 + cjk / 1.5 + other / 3);
};

/** 一条消息的 token 数（多模态消息只算文本块；图片按固定额度估） */
const messageTokens = (message: AiChatMessage): number => {
    if (typeof message.content === 'string') return estimateTokens(message.content);
    return message.content.reduce((sum, part) => {
        // 图片无法按字符估：一张图的实际 token 由分辨率与服务商的切块策略决定，
        // 这里给一个常见量级（约 800）—— 它只影响"估算"这条回落的精度，
        // 而带图请求（AI 绘本）本来就不走 Agent 这条链路
        if (part.type === 'image_url') return sum + 800;
        return sum + estimateTokens(part.text);
    }, 0);
};

/** 按完整入参估算一次请求的 prompt token（系统提示词由 chat 拼入，此处已含） */
export const estimatePromptTokens = (messages: AiChatMessage[]): number =>
    messages.reduce((sum, message) => sum + messageTokens(message), 0);

/** 从服务端响应里取 usage；字段缺失或非数字都返回 null（交给估算兜底） */
const pickUsage = (raw: unknown): { promptTokens: number; completionTokens: number; totalTokens: number } | null => {
    if (!raw || typeof raw !== 'object') return null;
    const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    const prompt = Number(usage.prompt_tokens);
    const completion = Number(usage.completion_tokens);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
    // total 不是每个服务商都给：缺了就自己加，不要因此整条 usage 作废
    const total = Number(usage.total_tokens);
    return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: Number.isFinite(total) ? total : prompt + completion,
    };
};

/**
 * 组装一次请求的用量并回调。
 *
 * `measured` 为空即走估算：prompt 用**实际发出的** messages 算（含系统提示词），
 * completion 用**实际收到的**正文算。两者都由调用方传进来，服务层不去猜。
 */
const reportUsage = (
    onUsage: ((usage: AiUsage) => void) | undefined,
    messages: AiChatMessage[],
    reply: string,
    measured: { promptTokens: number; completionTokens: number; totalTokens: number } | null,
): void => {
    if (!onUsage) return;
    if (measured) {
        onUsage({ ...measured, estimated: false });
        return;
    }
    const promptTokens = estimatePromptTokens(messages);
    const completionTokens = estimateTokens(reply);
    onUsage({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true });
};

/**
 * 发起一次对话补全，返回助手回复文本。
 *
 * 失败一律抛 Error（带服务端原文），由调用方决定如何提示用户——
 * 这里不吞异常，否则界面会把"密钥错了"显示成"未找到资源"。
 *
 * 传了 `options.onDelta` 即走流式（stream:true），增量实时回调，
 * **返回值仍是完整文本**，调用方不需要自己拼接。
 *
 * 传了 `options.onUsage` 时，无论流式与否都会在成功拿到回复后回调一次用量。
 */
export const chat = async (options: AiChatOptions): Promise<string> => {
    const config = await getAiConfig();
    const messages: AiChatMessage[] = options.system
        ? [{ role: 'system', content: options.system }, ...options.messages]
        : options.messages;

    const payload: Record<string, unknown> = { model: config.model, messages };

    // 思考参数可选：配置里只有 low / high / max，当前模型未必认，
    // 下发前按模型预设映射；无档位或模型不需要思考时映射结果为空，整条请求就不带这个参数
    const wireEffort = resolveReasoningEffort(config, options.reasoningEffort);
    if (wireEffort) payload.reasoning_effort = wireEffort;

    if (typeof options.temperature === 'number') payload.temperature = options.temperature;
    if (typeof options.maxTokens === 'number') payload.max_tokens = options.maxTokens;
    if (options.jsonMode) payload.response_format = { type: 'json_object' };

    const finish = (reply: string, measured: ReturnType<typeof pickUsage>): string => {
        reportUsage(options.onUsage, messages, reply, measured);
        return reply;
    };

    if (!options.onDelta) {
        const { reply, usage } = await sendCompletion(payload, config, options.signal);
        return finish(reply, usage);
    }

    /**
     * 流式要显式申请 usage。
     *
     * OpenAI 兼容协议下流式响应**默认不带** usage 块，必须传
     * `stream_options.include_usage`。两处克制：
     *
     * 1. **只有调用方要用量时才传。** 不要用量的调用方（音频工坊、绘本）
     *    完全不该因为别人的需求多担一份被服务商拒绝的风险。
     * 2. **被拒过的服务商记下来，不再重试。** 服务商不认这个参数时多半直接报
     *    400，而 400 落在回落集合里。往下走两条路：
     *    - 只不认 stream_options、认 stream → 第二次用普通流式跑通，
     *      此后不再带这个参数，代价只是第一次多一个来回；
     *    - 连 stream 都不认 → 第二次照样 400，再回落成一次性请求。
     *      这与改动前逐次行为一致（那条路本来就要两个来回），没有额外损失。
     */
    if (options.onUsage && !STREAM_USAGE_REJECTED.has(normalizeBaseUrl(config.baseUrl))) {
        const streamPayload = { ...payload, stream: true, stream_options: { include_usage: true } };
        try {
            const { reply, usage } = await sendStreaming(streamPayload, config, options.onDelta, options.signal);
            return finish(reply, usage);
        } catch (error) {
            if (!(error instanceof StreamUnsupportedError)) throw error;
            STREAM_USAGE_REJECTED.add(normalizeBaseUrl(config.baseUrl));
        }
    }

    // 流式：服务端不认 stream 参数时回落成一次性请求，调用方无感
    try {
        const { reply, usage } = await sendStreaming({ ...payload, stream: true }, config, options.onDelta, options.signal);
        return finish(reply, usage);
    } catch (error) {
        if (!(error instanceof StreamUnsupportedError)) throw error;
        const { reply, usage } = await sendCompletion(payload, config, options.signal);
        return finish(reply, usage);
    }
};

/**
 * 已经拒绝过 `stream_options` 的服务商地址。
 *
 * 进程级缓存，不落盘：它只是一次请求往返的优化，重启后重探一遍的代价可忽略，
 * 而落盘会引入"服务商升级了支持却仍被缓存挡住"的陈旧状态。
 */
const STREAM_USAGE_REJECTED = new Set<string>();

/** 服务端拒绝了 stream 参数。内部信号，不外泄给调用方 */
class StreamUnsupportedError extends Error { }

/** 流式请求被拒时值得重试的状态码。401/403 是鉴权问题，重试也白搭 */
const STREAM_FALLBACK_STATUSES = new Set([400, 404, 405, 415, 422, 501]);

/** 把流式响应里可能是字符串或分块数组的内容归一成文本 */
const pickText = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value
            .map((part) => {
                if (typeof part === 'string') return part;
                const text = (part as { text?: unknown })?.text;
                return typeof text === 'string' ? text : '';
            })
            .join('');
    }
    return '';
};

/** 一次性请求：整包返回后解析 */
const sendCompletion = async (
    payload: Record<string, unknown>,
    config: AiConfig,
    signal?: AbortSignal
): Promise<{ reply: string; usage: ReturnType<typeof pickUsage> }> => {
    const response = await requestCompletion(payload, config, signal);
    const text = await response.text();

    if (!response.ok) {
        throw new Error(`AI 服务返回错误：${extractErrorMessage(response.status, text)}`);
    }

    let data: { choices?: { message?: { content?: string } }[]; usage?: unknown };
    try {
        data = JSON.parse(text);
    } catch (_error) {
        throw new Error('AI 服务返回了无法解析的内容，请确认接口地址指向 OpenAI 兼容服务。');
    }

    return { reply: data?.choices?.[0]?.message?.content || '', usage: pickUsage(data?.usage) };
};

/**
 * 流式请求：逐 SSE 事件回调增量。
 *
 * 两种"其实不是流"的情况都要处理，否则表现为界面空转或显示空回复：
 *  - 服务端明确拒绝 stream（4xx/501）→ 抛 StreamUnsupportedError 交给上层回落；
 *  - 服务端忽略 stream 参数、照常回一整个 JSON → 按非流式解析，照样有结果。
 */
const sendStreaming = async (
    payload: Record<string, unknown>,
    config: AiConfig,
    onDelta: (delta: AiStreamDelta) => void,
    signal?: AbortSignal
): Promise<{ reply: string; usage: ReturnType<typeof pickUsage> }> => {
    const response = await requestCompletion(payload, config, signal);

    if (!response.ok) {
        const body = await response.text();
        // 服务端不认 stream：交由上层回落，不在这里报错
        if (STREAM_FALLBACK_STATUSES.has(response.status)) throw new StreamUnsupportedError();
        throw new Error(`AI 服务返回错误：${extractErrorMessage(response.status, body)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    // 服务端忽略了 stream，回的是普通 JSON —— 直接当非流式处理，别当失败
    if (!contentType.includes('event-stream') || !response.body) {
        const text = await response.text();
        let data: { choices?: { message?: { content?: string } }[]; usage?: unknown };
        try {
            data = JSON.parse(text);
        } catch (_error) {
            throw new Error('AI 服务返回了无法解析的内容，请确认接口地址指向 OpenAI 兼容服务。');
        }
        const whole = data?.choices?.[0]?.message?.content || '';
        if (whole) onDelta({ content: whole });
        return { reply: whole, usage: pickUsage(data?.usage) };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    // 流式 usage 通常出现在**最后一个** chunk（choices 为空、只有 usage 字段），
    // 所以整个流里持续覆盖，取到的那一份自然是最新的
    let usage: ReturnType<typeof pickUsage> = null;
    let finished = false;

    const handleDataLine = (line: string): void => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data) return;
        if (data === '[DONE]') { finished = true; return; }

        let parsed: { choices?: { delta?: Record<string, unknown> }[]; usage?: unknown };
        try {
            parsed = JSON.parse(data);
        } catch (_error) {
            return; // 单个事件坏掉不该中断整条流
        }

        // usage 块常常和空 choices 一起到达，必须在取 delta 之前接住，
        // 否则下面那句 `if (!delta) continue` 会把它整块丢掉
        const chunkUsage = pickUsage(parsed?.usage);
        if (chunkUsage) usage = chunkUsage;

        const delta = parsed?.choices?.[0]?.delta;
        if (!delta) return;

        const piece = pickText(delta.content);
        // 推理字段名各家不一：reasoning_content 是 DeepSeek 系，reasoning 是通用写法
        const think = pickText(delta.reasoning_content) || pickText(delta.reasoning);

        if (piece) { content += piece; onDelta({ content: piece }); }
        if (think) { reasoning += think; onDelta({ reasoning: think }); }
    };

    try {
        while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;

            // stream:true 让跨 chunk 的多字节字符不被切坏（中文必须）
            buffer += decoder.decode(value, { stream: true });

            // 按行切，**残行留在 buffer 里**：一个 SSE 事件可能跨 chunk 到达，
            // 逐 chunk 直接 JSON.parse 必然在边界上抛错。
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
                const line = buffer.slice(0, newline).replace(/\r$/, '');
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf('\n');

                handleDataLine(line);
                if (finished) break;
            }
        }

        // 收尾：decoder 里可能还压着半个多字节字符，buffer 里可能还剩一行
        // 没有换行符的尾行（上游最后一段正文常常如此）。两处都不处理等于
        // 静默丢掉最后一段增量 —— 症状是回复永远少个标点或少半个字。
        buffer += decoder.decode();
        if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
                handleDataLine(line.replace(/\r$/, ''));
                if (finished) break;
            }
        }
    } finally {
        // 提前退出（[DONE] / 中止）时释放连接，否则 socket 挂到超时
        try { await reader.cancel(); } catch (_error) { /* 已关闭 */ }
    }

    return { reply: content, usage };
};

/** 发请求。网络层失败与用户中止要分开报，否则点停止会看到"无法连接 AI 服务" */
const requestCompletion = async (
    payload: Record<string, unknown>,
    config: AiConfig,
    signal?: AbortSignal
): Promise<Response> => {
    try {
        return await fetch(`${config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify(payload),
            signal,
        });
    } catch (error) {
        // 用户主动停止：原样抛出，让调用方识别成"已停止"而不是故障
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (error instanceof Error && error.name === 'AbortError') throw error;

        // 网络层失败（服务没起、端口不通、被 CSP 拦）走这里
        const reason = error instanceof Error ? error.message : '未知网络错误';
        throw new Error(`无法连接 AI 服务（${config.baseUrl}）：${reason}`);
    }
};

/**
 * 发起一次可能返回音频的补全（语音合成）。
 *
 * 与 chat 分开的原因：TTS 的音频不在 content 里，而在 message.audio.data，
 * 且必须显式请求 modalities=['audio']，否则服务端只回文本。
 * 返回 Base64 PCM（24kHz 单声道 16bit），无音频时返回 null。
 */
export const chatForSpeech = async (options: AiChatOptions): Promise<string | null> => {
    const config = await getAiConfig();
    const messages: AiChatMessage[] = options.system
        ? [{ role: 'system', content: options.system }, ...options.messages]
        : options.messages;

    const payload: Record<string, unknown> = {
        model: config.model,
        messages,
        modalities: ['audio'],
        audio: { voice: 'alloy', format: 'pcm16' },
    };

    // 与 chat 同一套规则：没有可下发的档位就不带这个参数
    const wireEffort = resolveReasoningEffort(config, options.reasoningEffort);
    if (wireEffort) payload.reasoning_effort = wireEffort;

    if (typeof options.temperature === 'number') payload.temperature = options.temperature;

    let response: Response;
    try {
        response = await fetch(`${config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify(payload),
            signal: options.signal,
        });
    } catch (error) {
        // 与 requestCompletion 同一约定：中止原样抛出，调用方据此识别"用户停止"
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (error instanceof Error && error.name === 'AbortError') throw error;

        const reason = error instanceof Error ? error.message : '未知网络错误';
        throw new Error(`无法连接 AI 服务（${config.baseUrl}）：${reason}`);
    }

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`语音合成失败：${extractErrorMessage(response.status, text)}`);
    }

    let data: { choices?: { message?: { audio?: { data?: string } } }[] };
    try {
        data = JSON.parse(text);
    } catch (_error) {
        throw new Error('语音合成返回了无法解析的内容。');
    }

    return data?.choices?.[0]?.message?.audio?.data || null;
};

/* -------------------------------------------------------------------------- */
/*                                文本清洗                                     */
/* -------------------------------------------------------------------------- */

/**
 * 括号配平扫描：从 text 里找出第一个能 parse 成 JSON 的 `open`/`close` 包围块。
 *
 * 为什么不能用 `/\[[\s\S]*\]/` 或 `/\{[\s\S]*\}/`：量词是**贪婪**的，
 * 会从第一个开括号一直吃到最后一个闭括号。模型回复里只要在 JSON 之后再出现
 * 一个同类括号 —— "注意 [main] 文件很大"、"(注：第 2 页用了 {强调} 排版)"，
 * 或者它干脆给了两个数组 —— 整段就 parse 失败、返回 null，
 * 调用方拿到空结果，**全部内容凭空消失**，界面只显示"未找到"，
 * 用户完全看不出是解析挂了。
 *
 * 这里逐字符扫描并配平：对每个开括号起点找它自己的闭合括号，
 * 切出来试 parse，第一个能解析的就返回。字符串内部的括号会被跳过
 * （标题里带 `[Sub]`、`[7³ACG]`，正文里带 `{强调}` 都很常见）。
 */
const extractBalanced = (text: string, open: string, close: string): unknown => {
    if (!text) return undefined;
    for (let start = text.indexOf(open); start !== -1; start = text.indexOf(open, start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i += 1) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === open) depth += 1;
            else if (ch === close) {
                depth -= 1;
                if (depth === 0) {
                    try {
                        return JSON.parse(text.slice(start, i + 1));
                    } catch (_error) { /* 这段不是合法 JSON，换下一个起点 */ }
                    break; // 该起点的最外层已闭合，继续找后面的开括号
                }
            }
        }
    }
    return undefined;
};

/**
 * 从可能带围栏/前后缀的回复里抠出 JSON 数组。
 * 导出仅供回归测试直接断言（见 test/aibook.test.js）。
 */
export const extractJsonArray = (text: string): unknown[] | null => {
    const parsed = extractBalanced(text, '[', ']');
    return Array.isArray(parsed) ? parsed : null;
};


/* -------------------------------------------------------------------------- */
/*                              AI 绘本（读图成书）                             */
/* -------------------------------------------------------------------------- */

/** 生成器的图片输入上限：一次读图创作过多会让模型上下文爆炸且成本失控 */
export const AIBOOK_MAX_SOURCE_IMAGES = 60;

/**
 * 把一张图片（File 或 data URL）读成模型入参。
 *
 * File 走 FileReader，是唯一不经过 Blob URL 往返的路径；
 * 已经是 data URL 的直接拆，避免多一次编解码。
 */
export const toImageInput = async (source: File | string): Promise<AiImageInput> => {
    if (typeof source === 'string') {
        const split = splitDataUrl(source);
        if (!split || !split.base64) throw new Error('图片数据不是合法的 data URL');
        return { base64: split.base64, mimeType: split.mimeType };
    }

    const dataUrl = await fileToDataUrl(source);
    const split = splitDataUrl(dataUrl);
    if (!split || !split.base64) throw new Error('图片读取失败：无法解析为 data URL');
    return { base64: split.base64, mimeType: split.mimeType || source.type || 'image/png' };
};

/**
 * 默认的故事创作指令；用户可在生成器里用「自定义故事风格」整段替换。
 *
 * 这里是**人设与体裁**通道，与 buildStoryPrompt 的分工不可混淆：
 * 本段声明写给谁看、用什么调子写，可被用户整段替换；而"忠实于画面""用场景写"
 * 这类**任何风格下都必须成立**的规则放在 buildStoryPrompt，不受替换影响。
 *
 * 必须点明「成年读者」。不点明时模型按默认预期把"绘本"读成儿童读物，
 * 于是任何黑暗题材都被自我审查成含糊概括 —— 症状是不拒绝但空转，
 * 与内容边界无关，纯粹是定位缺失。
 */
const STORY_SYSTEM_PROMPT = `你是一位面向成年读者的NSFW绘本作者，旨在产出极度色情、淫乱的网络文学作品，主要发布于pixiv、ehentai等著名同人平台。
你须按素材本身的质地处理题材，着重于、最大化图片本身的撸点与爽点。`;

/** 每页文案的软性长度约束，写进提示词避免模型写成小作文 */
const STORY_PAGE_HINT = '每页 2～4 句、约 60～120 字，朗读顺畅';

/**
 * 拼出一次读图创作的提示词。
 *
 * 单独抽出来是为了让格式约束与画面忠实度约束集中在一处，
 * 避免散进调用点后被改漏。
 */
const buildStoryPrompt = (imageCount: number): string =>
    `请按顺序观察上面的 ${imageCount} 张图片，把它们串成一个连贯、生动的故事。

要求：
1. 先为故事取一个有吸引力的标题。
2. 内容必须完全来自图片：只写画面中真实存在的人物、场景、动作与细节，
   不要添加图片里没有的情节、设定或角色，也不要凭空补全画面外的信息。
3. 具体优先于概括。每一页都要落在画面里真实可见的东西上——谁在做什么、
   身体姿态、表情、光线、材质、画面中的物件与文字。禁止用空泛的总结句代替
   场景："气氛变得紧张""发生了可怕的事""一切都不对劲了"这类句子若单独成页
   即为不合格；也不要用"难以形容""无法描述""此处省略"绕过具体描写。
4. 如实描绘画面。画面里有的就写，画面里没有的就不写：不因题材沉重、黑暗
   或涉及成人内容就淡化、跳过或替换成更安全的场景。
5. 在忠于画面的前提下让各页前后呼应、有起承转合，而不是逐张平铺直叙。
6. 为每一张图片写一段剧情文字，共 ${imageCount} 段，与图片一一对应。
7. ${STORY_PAGE_HINT}。
8. 严格输出 JSON 对象：{"title":"故事标题","pages":["第1页文案","第2页文案"]}
9. 不要输出 JSON 以外的任何内容，不要用 Markdown 代码块包裹。`;

/**
 * 从模型回复里抠出 { title, pages }。
 *
 * 模型即使被要求「只输出 JSON」也常带 ```json 围栏或前后寒暄，
 * 因此按「围栏 → 首个花括号块」两级回落，与 AiService 里既有的
 * extractJsonArray 保持同一套宽容策略。
 *
 * 导出供测试直接覆盖各种脏回复形态（围栏、寒暄、pages 里混入非字符串）。
 */
export const parseStoryJson = (raw: string): AiStory | null => {
    let text = (raw || '').trim();
    if (!text) return null;

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) {
        text = fenced[1].trim();
    }

    // 先按整段 parse（围栏剥掉后通常就是纯 JSON）；
    // 失败再用括号配平扫描抠出对象 —— 不能用贪婪的 /\{[\s\S]*\}/：
    // 模型在 JSON 之后补一句 "(注：第 2 页用了 {强调} 排版)" 就会把整段撑坏，
    // 故事直接判为"无法解析"而被丢弃。
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (_error) {
        parsed = extractBalanced(text, '{', '}');
    }
    if (parsed === undefined) return null;

    const data = parsed as { title?: unknown; pages?: unknown };
    if (!data || !Array.isArray(data.pages) || data.pages.length === 0) return null;

    // pages 里混进非字符串（模型偶尔塞对象）时丢弃该项而不是整篇失败
    const pages = data.pages
        .map((p) => (typeof p === 'string' ? p.trim() : ''))
        .filter((p) => p.length > 0);
    if (pages.length === 0) return null;

    const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : '未命名故事';
    return { title, pages };
};

/**
 * 根据一组图片创作连贯故事。
 *
 * 图片按传入顺序送给模型（顺序即叙事顺序），因此调用方必须先排好序。
 *
 * **只请求一次，解析失败不重试。** 重试会把一次读图创作的成本翻倍，而模型
 * 返回脏 JSON 通常是服务商不支持 jsonMode 或接口被中间层改写 —— 换一段更
 * 强硬的措辞治不了这两样。失败时把原始回复片段附在错误里，让用户直接看到
 * 模型究竟回了什么，比悄悄重发一次再报同样的错有用。
 */
export const generateStoryFromImages = async (
    images: AiImageInput[],
    systemInstruction?: string
): Promise<AiStory> => {
    if (!images || images.length === 0) throw new Error('请先添加至少一张图片');

    const parts: AiContentPart[] = images.map((img) => ({
        type: 'image_url' as const,
        image_url: { url: `data:${img.mimeType || 'image/png'};base64,${img.base64}` },
    }));

    const system = (systemInstruction || '').trim() || STORY_SYSTEM_PROMPT;

    const raw = await chat({
        system,
        messages: [{
            role: 'user',
            content: [...parts, { type: 'text' as const, text: buildStoryPrompt(images.length) }],
        }],
        temperature: 0.9,
        jsonMode: true,
        // 读图 + 长文创作是重活，用高推理档换一次成稿率
        reasoningEffort: 'high',
    });

    const story = parseStoryJson(raw);
    if (story) return story;

    const preview = (raw || '').slice(0, 300);
    throw new Error(
        `故事数据解析失败：模型没有返回合法 JSON。原始回复片段：${preview || '(空)'}`
    );
};

/**
 * 语音合成：返回 Base64 PCM（24kHz 单声道 16bit），失败返回 null。
 *
 * 模型未配置语音能力时服务端会直接报错，这里不吞成静默失败，
 * 由调用方决定提示文案。
 */
export const generateSpeech = async (text: string): Promise<string | null> => {
    const clean = (text || '').trim();
    if (!clean) return null;
    return chatForSpeech({ messages: [{ role: 'user', content: clean }] });
};

/* -------------------------------------------------------------------------- */
/*                              页面资源提取                                   */
/* -------------------------------------------------------------------------- */

const EXTRACT_PROMPT = `Extract direct media URLs from the text below.
Target: Stream (m3u8, mpd), Video (mp4, mkv, etc), Audio (mp3, etc), Images (high res).
Return strictly JSON array: [{"url": "...", "title": "...", "type": "video"}]
Do not wrap in markdown code blocks. Just the raw JSON.
Text: `;

/** 嗅探结果里认可的媒体类型；其余（含 other）一律丢弃 */
const KNOWN_TYPES: MediaType[] = ['stream', 'video', 'audio', 'image', 'document'];

/**
 * 用 AI 从页面源码里提取直链资源。
 *
 * 输出不可信：只收录 http(s) 直链、已知媒体类型，ext 去掉 query/hash，上限 50 条。
 * 返回的字段与 FoundLink 对齐，由调用方补齐 pageUrl/referer 等上下文。
 */
export const extractMediaLinks = async (
    pageContent: string,
    fallbackTitle: string
): Promise<Array<Pick<FoundLink, 'url' | 'title' | 'type' | 'ext'>>> => {
    const preview = pageContent.length > 80000 ? pageContent.slice(0, 80000) : pageContent;

    const text = await chat({
        messages: [{ role: 'user', content: `${EXTRACT_PROMPT}${preview}` }],
        reasoningEffort: 'low',
    });

    const parsed = extractJsonArray(text);
    if (!parsed) return [];

    return parsed
        /**
         * 只收 http(s) 直链。
         *
         * `blob:` 必须排除：它是**页面自己那块内存**的句柄，不是可下载的远端资源 ——
         * 跨不过进程边界（主进程下载器按这个地址请求只会失败），
         * 播放器也不在页面那个源上，同样读不到。收进来等于给用户两个点了没反应的按钮。
         *
         * 提示词里写的就是 "direct media URLs"，页内脚本与网络层也都各自拦了 blob:，
         * 唯独这里放行过 —— 三条路径口径必须一致，否则同一个页面走哪条路结论不同。
         */
        .filter((item): item is { url: string; title?: string; type?: string } => {
            const url = (item as { url?: unknown })?.url;
            return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
        })
        .slice(0, 50)
        .map((item) => {
            const cleanUrl = item.url.trim();
            const pathPart = cleanUrl.split('?')[0].split('#')[0];
            const lastSegment = pathPart.split('/').pop() || '';
            /**
             * 后缀只从**最后一个路径段**里取，且必须是真正的扩展名。
             *
             * 早先直接 `pathPart.split('.').pop()`：路径里没有点时（`/stream/abc123`）
             * 取到的是整个末段，`^[a-z0-9]{2,5}$` 一过就把它当成后缀 ——
             * 于是落盘文件叫 `标题.abc123`，系统认不出类型。
             * 现在要求末段里**确实有点**，且点不在首位（`.hidden` 不是后缀）。
             */
            const dot = lastSegment.lastIndexOf('.');
            const extGuess = dot > 0 ? lastSegment.slice(dot + 1).toLowerCase() : '';
            const ext = /^[a-z0-9]{2,5}$/.test(extGuess) ? extGuess : 'unknown';
            const type: MediaType = KNOWN_TYPES.includes(item.type as MediaType)
                ? (item.type as MediaType)
                : 'other';
            return { url: cleanUrl, title: item.title || fallbackTitle || 'AI 识别资源', type, ext };
        })
        // 'other' 非媒体候选项直接丢弃，避免污染嗅探列表
        .filter((item) => item.type !== 'other');
};
