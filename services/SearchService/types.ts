import type { SearchHit, SiteDescriptor } from '../../meta';

/**
 * ============================================================================
 * 搜索引擎的插口契约
 * ============================================================================
 *
 * 引擎对任何具体站点一无所知，它只认这个文件里的接口。
 * 「加一个站点」= 新写一个 SiteProvider 实现并注册，不碰引擎、不碰 UI。
 *
 * provider 的 buildSearchUrl 与 parse 都必须是**纯函数**：
 * 不发起网络请求、不读全局状态。这样可以用保存下来的真实响应快照做离线测试，
 * 站点改版导致解析失效时，测试会直接失败，而不是等到用户搜出空结果才发现。
 */

/** 引擎交给 provider 的解析上下文 */
export interface ParseContext {
    /** 本次实际请求的地址（部分站点需要从中回填信息） */
    url: string;
    /** 搜索关键词 */
    query: string;
}

/**
 * provider 产出的条目。
 * site / siteLabel 由引擎按注册信息统一盖章，provider 不必也不该自己填——
 * 否则同一个站点在两处各写一遍名字，迟早不一致。
 */
export type ProviderHit = Omit<SearchHit, 'site' | 'siteLabel'>;

/**
 * 站点插口。
 *
 * 实现者只需回答两个问题：这个站怎么搜、它返回的东西怎么读。
 * 翻页、并发、限速、去重、排序、容错全部由引擎负责。
 */
export interface SiteProvider {
    /** 站点元信息（id / 显示名 / 主页 / 是否成人 / 内容类型） */
    descriptor: SiteDescriptor;
    /**
     * 关键词 → 搜索地址。纯函数。
     * 站点特有的查询参数（分类编码、排序字段、分页格式）都封在这里。
     */
    buildSearchUrl(query: string): string;
    /**
     * 响应正文 → 归一化条目。纯函数。
     *
     * 必须容错：站点改版、返回错误页、返回空结果时应当返回空数组而不是抛错。
     * 单个站点解析失败不该让整个扇出搜索失败——引擎会把空结果记为「0 条」。
     */
    parse(body: string, ctx: ParseContext): ProviderHit[];
    /**
     * 站点要求的请求头（多为 Referer）。
     * 部分站点校验来源，缺失会返回 403 或空列表。
     */
    headers?: Record<string, string>;
}

/** 一次取字节请求 */
export interface TransportRequest {
    url: string;
    headers?: Record<string, string>;
    /** 单次请求超时（毫秒） */
    timeoutMs?: number;
}

/** 一次取字节结果 */
export interface TransportResponse {
    ok: boolean;
    /** HTTP 状态码；0 表示连接根本没建立（超时 / DNS / 网络错误） */
    status: number;
    body: string;
    /** 跟随重定向后的最终地址 */
    finalUrl: string;
    /** 失败原因（status 为 0 或非 2xx 时有值），引擎据此在站点状态里说明原因 */
    error?: string;
}

/**
 * 传输层：引擎唯一碰网络的地方。
 *
 * 抽成接口有两个实际好处：
 * 1. 测试时可以注入假实现，离线跑完整扇出流程；
 * 2. 将来若要改走主进程代取（例如需要过 Cloudflare 挑战），
 *    只需换一个实现，引擎与全部 provider 一行都不用动。
 */
export interface Transport {
    get(req: TransportRequest): Promise<TransportResponse>;
}
