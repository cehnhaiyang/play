/**
 * ============================================================================
 * SearchService — 通用资源搜索引擎
 * ============================================================================
 *
 * 一次关键词 → 扇出查询全部已注册站点 → 归一化汇总 → 统一结果列表。
 *
 * 分层：
 *   providers/   站点插口：每个站一个文件，只回答"怎么搜"与"怎么解析"
 *   registry.ts  站点注册表：引擎与 UI 认识站点的唯一入口
 *   engine.ts    引擎：扇出/并发/超时/去重/排序/容错（不认识任何具体站点）
 *   transport.ts 传输：唯一碰网络的地方，可替换
 *   util.ts      归一化：各站格式差异（体积/时间/磁链编码）在此消化
 *
 * 加一个站点的完整动作：写 providers/<name>.ts，在 registry.ts 的数组里加一项。
 * 引擎、UI、主进程都不用改。
 */
export * from './types';
export { search } from './engine';
export { listSites, getProvider, allProviders, resolveProviders } from './registry';
export { fetchTransport, FetchTransport } from './transport';
export * from './util';
