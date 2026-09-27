import type { Transport, TransportRequest, TransportResponse } from './types';

/**
 * ============================================================================
 * 默认传输实现：渲染层 fetch
 * ============================================================================
 *
 * 为什么用渲染层 fetch 而不是走主进程 IPC：
 *
 * 1. **代理自动生效**。代理是配在 Chromium 会话上的（主进程
 *    session.defaultSession.setProxy），渲染层 fetch 走的就是 Chromium 网络栈，
 *    因此自动吃到代理，无需任何额外接线。
 *    对比：原来主进程 sukebeiService 用 Node 的 https.get 裸请求，不传 agent，
 *    代理对它完全无效——配好 SOCKS5 后照样 ECONNRESET，而同一时刻同一地址
 *    走 Chromium 栈就正常。这正是本服务要摆脱的老路。
 *
 * 2. **跨域不受限**。主窗口 webSecurity 为 false，跨站请求不会被同源策略拦下，
 *    所以搜索服务可以完整地待在渲染层，不必为了发一个请求而绕道 IPC。
 *
 * 3. **可替换**。Transport 是接口，测试注入假实现即可离线跑完整流程；
 *    将来若某个站需要过 Cloudflare 挑战（要开 BrowserWindow + CDP），
 *    只需另写一个实现，引擎与全部 provider 一行都不用改。
 */

/** 单站请求超时：扇出搜索里一个站卡住不该拖住整体 */
const DEFAULT_TIMEOUT_MS = 12000;

const DEFAULT_HEADERS: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

export class FetchTransport implements Transport {
    async get(req: TransportRequest): Promise<TransportResponse> {
        const timeoutMs = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT_MS;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(req.url, {
                method: 'GET',
                headers: { ...DEFAULT_HEADERS, ...(req.headers || {}) },
                signal: controller.signal,
                credentials: 'omit',
                redirect: 'follow',
                // 这里刻意不传 referrer 选项：按 fetch 规范它只接受同源地址或 about:client，
                // 传跨域地址会直接抛 TypeError。而各 provider 的 Referer 是站点自身域名，
                // 从应用页发起必然跨域——一传就所有站点全挂。
                //
                // Referer 也不能放进 headers：它是 fetch 的禁止头，会被静默丢弃。
                // 所以 provider.headers 里的 Referer 实际不生效；实测这些站点不校验来源，
                // 去掉无影响。若将来某个站确实要求 Referer，那条请求必须改走主进程
                // （Electron 的 net.fetch 允许设置该头），届时只需换一个 Transport 实现。
            });
            const body = await res.text();
            return {
                ok: res.ok,
                status: res.status,
                body,
                finalUrl: res.url || req.url,
            };
        } catch (err: any) {
            // 超时与网络错误都归一成"这次请求失败"，由引擎记进站点状态里。
            // 不往上抛：一个站失败不该让整次扇出搜索失败。
            const aborted = err?.name === 'AbortError';
            return {
                ok: false,
                status: 0,
                body: '',
                finalUrl: req.url,
                ...(aborted ? { error: `请求超时（${timeoutMs}ms）` } : { error: err?.message || '网络错误' }),
            } as TransportResponse;
        } finally {
            clearTimeout(timer);
        }
    }
}

/** 共享实例：transport 无状态，无需每次新建 */
export const fetchTransport = new FetchTransport();
