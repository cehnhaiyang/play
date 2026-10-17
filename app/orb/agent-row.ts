import type { AgentMessage } from '../../shared/meta';

/**
 * 两条展示记录画出来是不是一样 —— 消息行 `memo` 的判据。
 *
 * ## 为什么不能比对象身份
 *
 * 快照是跨进程送进球的（插件 SW → host → 主进程 → preload → 渲染层），每一跳都
 * 结构化克隆一次：`messages` 数组和里面每一条都是**新对象**，内容一个字没变也一样。
 * 所以 `prev.message === next.message` 永远为假，`memo` 形同虚设 —— 每来一份快照
 * （每一步、每次追加）整个列表都要重渲一遍，而画面其实只多了一行。
 *
 * ## 为什么逐字段比
 *
 * 判据就是"这一行画了什么"：徽标取 notice / label / tool / role，语气取 role 与 ok，
 * 正文取 result（工具）或 content，另有推理、脚本、用量、压缩摘要。
 * **改这一行的渲染就要同步改这里** —— 少比一个字段，那一栏此后就再也不会更新，
 * 而界面不会报错。
 *
 * 单独一个文件而不是留在 `agent.tsx` 里：它是纯函数，而测试构建
 * （`test/tsconfig.json`）编不了 `.tsx`，放在这里才能被直接调用验证。
 */
export const sameAgentRow = (a: AgentMessage, b: AgentMessage): boolean =>
    a.id === b.id
    && a.role === b.role
    && a.notice === b.notice
    && a.content === b.content
    && a.label === b.label
    && a.tool === b.tool
    && a.ok === b.ok
    && a.result === b.result
    && a.reasoning === b.reasoning
    && a.script === b.script
    && a.usage?.totalTokens === b.usage?.totalTokens
    && a.compaction?.summary === b.compaction?.summary;
