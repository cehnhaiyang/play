/**
 * 篡改规则的可用性判定。
 *
 * 引擎（注入脚本）、面板、Agent 工具三处都要判断"这条规则引擎会不会用"。
 * 引擎那份在注入脚本里、无法 import，所以这里是**面板与工具**的单一实现，
 * 与引擎的一致性由回归测试交叉验证。
 *
 * 与宿主无关：插件侧的面板与 Agent 工具同样读这一份。
 */
import type { DroppedRule } from '../meta';

/**
 * 规则的目标键名 —— 引擎取的是 `jsonPath.split('.').pop()`。
 *
 * 注意 `"."` 这种只有分隔符的写法取到空串，与空 jsonPath 同样不可用。
 */
export const ruleTargetKey = (jsonPath: string | undefined | null): string =>
    String(jsonPath == null ? '' : jsonPath).split('.').pop() || '';

/** 这条字段规则是否会被引擎丢弃（未启用不算丢弃 —— 那是用户主动关的） */
export const isFieldRuleDropped = (rule: { enabled?: boolean; jsonPath?: string } | null | undefined): boolean =>
    !!rule && rule.enabled !== false && !ruleTargetKey(rule.jsonPath);

/** 这条请求头规则是否会被引擎丢弃 */
export const isHeaderRuleDropped = (rule: { enabled?: boolean; headerName?: string } | null | undefined): boolean =>
    !!rule && rule.enabled !== false && !rule.headerName;

export const collectDroppedRules = (rules: {
    intercept?: { enabled?: boolean; jsonPath?: string }[];
    request?: { enabled?: boolean; jsonPath?: string }[];
    headers?: { enabled?: boolean; headerName?: string }[];
}): DroppedRule[] => {
    const out: DroppedRule[] = [];

    const collectFields = (list: { enabled?: boolean; jsonPath?: string }[] | undefined, group: 'intercept' | 'request') => {
        (list || []).forEach((rule, index) => {
            if (isFieldRuleDropped(rule)) {
                out.push({ group, index, reason: 'jsonPath 为空（或只有 "."），没有目标键的规则永远匹配不上' });
            }
        });
    };

    collectFields(rules.intercept, 'intercept');
    collectFields(rules.request, 'request');

    (rules.headers || []).forEach((rule, index) => {
        if (isHeaderRuleDropped(rule)) out.push({ group: 'headers', index, reason: 'headerName 为空' });
    });

    return out;
};
