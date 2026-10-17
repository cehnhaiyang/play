import type { AiChatMessage, AiUsage } from '../../../shared/meta';
import { chat, extractMediaLinks } from '../../../shared/ai/AiService';
import type { HostChatRequest, HostEvent, HostRequest } from '../shared/protocol';

/**
 * offscreen 宿主文档。
 *
 * ## 它存在的原因
 *
 * Agent 的一次流式补全可能持续几分钟，而 MV3 的 service worker 空闲约 30 秒
 * 就被回收。它是否会被"在途 fetch"续命，我没有可实测的依据，不能拿它当设计
 * 前提 —— 一次跑到一半被回收的对话，比一开始就不能跑更糟。
 *
 * offscreen 文档没有这个问题：它是扩展自己的页面，生命周期跟扩展走，
 * 也不受任何页面 CSP 约束。**内容脚本**不能承担这个角色（manifest 里现在也没有
 * 内容脚本）：它的 `fetch` 受**页面** CSP 的 `connect-src` 约束，落在白名单外的
 * 站点上会直接失败，且失败与否取决于用户打开的是哪个网站。
 *
 * ## 它不做别的
 *
 * 这里只有模型调用。页面执行在 `offscreen/page-host.ts` —— 那个文件虽然放在
 * 同一目录，但它是被 service worker import 的，**不在这里求值**：offscreen 文档
 * 没有 `chrome.debugger` / `chrome.tabs` 这些命名空间，它是个普通页面。
 * 分工按"谁有这个能力"切，不按"谁离得近"切。
 *
 * ## 事件必须广播，不能只回给调用方
 *
 * `chrome.runtime.sendMessage` 的响应只回给发起者，而流式增量要在**整个过程里**
 * 持续推出去 —— 响应通道做不到（它只有一个终值）。所以增量走
 * `chrome.runtime.sendMessage` 广播，`target: 'chat'`，由 SW 里的 chat-port
 * 按 `requestId` 认领属于自己的那些。
 */

/** 模型调用的整体上限。与"页面脚本单次执行"那个超时是两件事，不要合并 */
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingChat {
    controller: AbortController;
    timer: number;
}

const pending = new Map<string, PendingChat>();

/** 广播一条事件。SW 里的 chat-port 是唯一收件人，没有在等的那条就没人接，吞掉 */
const notify = (event: HostEvent): void => {
    chrome.runtime.sendMessage(event).catch(() => undefined);
};

const runChat = async (request: HostChatRequest): Promise<void> => {
    const controller = new AbortController();
    const timer = self.setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    pending.set(request.requestId, { controller, timer });

    try {
        let usage: AiUsage | undefined;
        const reply = await chat({
            config: request.aiConfig,
            system: request.system,
            messages: request.messages as AiChatMessage[],
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            reasoningEffort: request.reasoningEffort,
            signal: controller.signal,
            onUsage: (u) => {
                usage = u;
            },
            onDelta: (delta) => {
                notify({
                    target: 'chat',
                    kind: 'ai-delta',
                    requestId: request.requestId,
                    ...(delta.content ? { content: delta.content } : {}),
                    ...(delta.reasoning ? { reasoning: delta.reasoning } : {}),
                });
            },
        });

        notify({
            target: 'chat',
            kind: 'ai-done',
            requestId: request.requestId,
            reply,
            ...(usage ? { usage } : {}),
        });
    } catch (e) {
        /*
         * 失败也要推 ai-done。
         *
         * 只推 delta 不推终局的话，界面会永远停在"正在思考" —— 它无从知道
         * 这次调用已经结束了。这与 SW 里"忘了 sendResponse 面板一直转圈"是
         * 同一类问题。
         */
        notify({
            target: 'chat',
            kind: 'ai-done',
            requestId: request.requestId,
            error: e instanceof Error ? e.message : String(e),
        });
    } finally {
        self.clearTimeout(timer);
        pending.delete(request.requestId);
    }
};

/**
 * 顶层同步注册。
 *
 * 与 service worker 同一约束：监听器必须在模块顶层注册。offscreen 文档不像 SW
 * 那样频繁回收，但"注册写在 async 里"这个错误在两者里的表现是一样的 ——
 * 事件没人听，且不报错。
 */
chrome.runtime.onMessage.addListener(
    (message: { target?: string; kind?: string }, _sender, sendResponse) => {
        /*
         * 只处理属于自己的消息。发往 SW / 别的文档的那些会同时广播到这里，
         * 不判 target 就会把它们也认领下来，两边抢着回复。
         */
        if (message?.target !== 'host') return false;
        const request = message as HostRequest;

        switch (request.kind) {
            case 'ai-ready':
                sendResponse({ ok: true, result: { ready: true } });
                return false;

            case 'ai-chat':
                /*
                 * 立刻回执，不等模型。
                 *
                 * 一次补全可能几分钟，而 sendResponse 的通道会被调用方等在那里。
                 * 回执只表示"收到了，结果走广播"，实际内容由 ai-done 送达。
                 */
                sendResponse({ ok: true, result: { accepted: request.requestId } });
                void runChat(request);
                return false;

            case 'ai-cancel': {
                const entry = pending.get(request.requestId);
                // 取消一个已经结束的调用不是错误：用户点停止与调用自然结束之间
                // 本来就有竞态，报错只会让界面闪一条无意义的红字。
                entry?.controller.abort();
                sendResponse({ ok: true, result: { cancelled: !!entry } });
                return false;
            }

            /**
             * AI 深度嗅探。
             *
             * 普通请求/应答即可 —— 它一次返回一个数组，没有流式增量，
             * 不需要 `ai-chat` 那套 requestId 认领与广播。
             *
             * `async` 分支要显式 `return true`：`sendResponse` 在 await 之后才调，
             * 不返回 true 的话响应通道会在函数返回时立刻关闭，调用方拿到 undefined。
             */
            case 'ai-extract-links': {
                void (async () => {
                    try {
                        const links = await extractMediaLinks(request.html, request.title, request.aiConfig);
                        sendResponse({ ok: true, result: { links } });
                    } catch (e) {
                        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                })();
                return true;
            }

            default:
                /*
                 * 未知 kind 也要回一条。
                 *
                 * 不回的话调用方会一直等（响应通道开着但没人写），
                 * 表现为"界面卡在转圈"—— 而真正的原因只是一个拼错的 kind。
                 * 这里显式把 kind 断言成 string：类型上它是 never（联合已穷尽），
                 * 但运行时收到的可能是任何东西。
                 */
                sendResponse({ ok: false, error: `未知消息：${String((request as { kind: string }).kind)}` });
                return false;
        }
    },
);
