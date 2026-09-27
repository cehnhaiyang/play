import type { SiteDescriptor } from '../../meta';
import type { SiteProvider } from './types';
import { nyaaProvider, sukebeiProvider } from './providers/nyaa';
import { apibayProvider } from './providers/apibay';
import { acgripProvider } from './providers/acgrip';
import { dmhyProvider } from './providers/dmhy';
import { animetoshoProvider } from './providers/animetosho';

/**
 * ============================================================================
 * 站点注册表
 * ============================================================================
 *
 * 引擎通过这里认识站点，UI 通过这里列出可勾选的站点。
 * 「加一个站点」的完整动作就是：写一个 provider，然后在下面数组里加一项。
 * 引擎、UI、主进程都不需要改。
 *
 * 顺序即 UI 里的展示顺序：把通用/全年龄的放前面，成人站点靠后。
 */
const PROVIDERS: SiteProvider[] = [
    nyaaProvider,
    apibayProvider,
    animetoshoProvider,
    acgripProvider,
    dmhyProvider,
    sukebeiProvider,
];

/** id → provider */
const registry = new Map<string, SiteProvider>(PROVIDERS.map((p) => [p.descriptor.id, p]));

/** 全部已注册站点（UI 列举用） */
export function listSites(): SiteDescriptor[] {
    return PROVIDERS.map((p) => p.descriptor);
}

/** 按 id 取 provider；未知 id 返回 null（调用方决定是忽略还是报错） */
export function getProvider(id: string): SiteProvider | null {
    return registry.get(id) || null;
}

/** 全部 provider（引擎扇出用） */
export function allProviders(): SiteProvider[] {
    return PROVIDERS;
}

/**
 * 把用户勾选的站点 id 解析成 provider 列表。
 *
 * 语义约定（引擎与 UI 共用，避免两处各自解释）：
 * - 不传 / 传空数组 → 全部站点
 * - includeAdult 为 false → 过滤掉成人站点
 * - 传了具体 id → 只搜这些；无法识别的 id 被忽略（不报错，
 *   否则一个拼错的 id 会让整次搜索失败）
 */
export function resolveProviders(siteIds?: string[], includeAdult = true): SiteProvider[] {
    let list: SiteProvider[];
    if (!siteIds || siteIds.length === 0) {
        list = PROVIDERS.slice();
    } else {
        list = siteIds
            .map((id) => registry.get(id))
            .filter((p): p is SiteProvider => Boolean(p));
    }
    if (!includeAdult) list = list.filter((p) => !p.descriptor.adult);
    return list;
}
