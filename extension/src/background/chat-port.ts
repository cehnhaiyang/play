import type { AiChatMessage, AiUsage } from '../../../shared/meta';
import type { ChatPort } from '../agent/engine';
import type { ExtensionResponse, HostChatRequest, HostEvent } from '../shared/protocol';

/**
 * 模型调用端口：把引擎的 `chat()` 转到 offscreen 文档。
 *
 * ## 为什么是"转发"而不是直接调
 *
 * 引擎跑在 service worker（要 chrome.* 全套），而流式补全可能几分钟，
 * SW 空闲约 30 秒被回收。所以真正的 fetch 在 offscreen 文档里发。
 *
 * ## 请求/响应 + 广播，两条通道
 *
 * - `chrome.runtime.sendMessage(ai-chat)` 只拿一个**回执**（收到了），
 *   因为响应通道只有一个终值，装不下持续增量；
 * - 增量与终局由 offscreen **广播** `ai-delta` / `ai-done`，按 `requestId` 认领。
 *
 * 这带来一个必须处理的边界：广播是全局的，所以这里会收到不属于自己的事件。
 * 按登记表过滤，认不出的一律忽略 —— 否则并发两次调用会互相串词。
 */

/** 正在等待的调用：requestId → 聚合器 */
const waiting = new Map<string, {
    onDelta: (delta: { content?: string; reasoning?: string }) => void;
    onUsage: (usage: AiUsage) => void;
    resolve: (reply: string) => void;
    reject: (error: Error) => void;
}>();

/**
 * 顶层注册。
 *
 * 与 SW 里其它监听器同一约束：必须在模块顶层同步注册。这个文件本身在 SW 里
 * 求值，所以"注册写在 async 里"会让事件在回收重启后没人听。
 */
chrome.runtime.onMessage.addListener((message: { target?: string; kind?: string } & Partial<HostEvent>) => {
    if (message?.target !== 'ball') return false;

    if (message.kind === 'ai-delta') {
        const entry = waiting.get(String(message.requestId));
        if (!entry) return false;
        entry.onDelta({
            ...(message.content ? { content: message.content } : {}),
            ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        });
        return false;
    }

    if (message.kind === 'ai-done') {
        const id = String(message.requestId);
        const entry = waiting.get(id);
        if (!entry) return false;
        waiting.delete(id);

        if (message.error) {
            /*
             * 错误要还原成 Error 并保留 AbortError 的语义。
             *
             * 引擎靠 `e.name === 'AbortError'` 区分"用户点了停止"与"真出错了"：
             * 前者不该弹错误横幅，也不该中断对话。用一句普通 Error 代替的话，
             * 每次停止都会显示一条红色的"调用失败"。
             */
            const error = new Error(message.error);
            if (/abort/i.test(message.error)) error.name = 'AbortError';
            entry.reject(error);
            return false;
        }

        if (message.usage) entry.onUsage(message.usage);
        entry.resolve(message.reply || '');
        return false;
    }

    return false;
});

/** 生成一个 requestId。用随机串而不是递增计数：SW 重启后计数会从头开始 */
const newRequestId = (): string =>
    `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const createChatPort = (ensureOffscreen: () => Promise<void>): ChatPort => ({
    chat: async (options) => {
        await ensureOffscreen();

        const requestId = newRequestId();
        const request: HostChatRequest = {
            target: 'host',
            kind: 'ai-chat',
            requestId,
            ...(options.system ? { system: options.system } : {}),
            messages: options.messages as AiChatMessage[],
            ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
            ...(typeof options.maxTokens === 'number' ? { maxTokens: options.maxTokens } : {}),
            ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        };

        const reply = new Promise<string>((resolve, reject) => {
            waiting.set(requestId, {
                onDelta: options.onDelta,
                onUsage: options.onUsage,
                resolve,
                reject,
            });
        });

        /* 用户点停止：把中止信号转成一条取消消息，并立刻让本地等待失败 */
        const onAbort = (): void => {
            const entry = waiting.get(requestId);
            if (!entry) return;
            waiting.delete(requestId);
            void chrome.runtime
                .sendMessage({ target: 'host', kind: 'ai-cancel', requestId })
                .catch(() => undefined);
            const error = new Error('已停止');
            error.name = 'AbortError';
            entry.reject(error);
        };
        options.signal.addEventListener('abort', onAbort, { once: true });

        try {
            const res = (await chrome.runtime.sendMessage(request)) as ExtensionResponse | undefined;
            if (!res) throw new Error('offscreen 宿主无响应（可能创建失败）');
            if (!res.ok) {
                waiting.delete(requestId);
                throw new Error(res.error || '模型调用未能开始');
            }
            return await reply;
        } finally {
            options.signal.removeEventListener('abort', onAbort);
            waiting.delete(requestId);
        }
    },
});
