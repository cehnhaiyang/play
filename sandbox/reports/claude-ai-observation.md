# claude.ai 当前站点观察报告

## 观察对象
- URL: https://claude.ai/chat/196939e3-b129-4cc7-b78d-9c0932cbf000
- 标题: 理解人格模型 - Claude
- 登录账号组织: 9f4c7722-a955-4fec-a41f-ed00e89834d3 (arnaogiassonkh4844@gmail.com's Organization), capabilities = [chat]
- 交互账号 uuid (前端存储 owner): d22f4d2f-7807-4dea-82a0-1c8245417c55
- 模型: claude-sonnet-5-5 (界面显示 "Sonnet 5.5 Extra")
- UA: Edge 155 / Chrome 155

## 前端架构
- TanStack Router (window.__TSR_ROUTER__)，routeCount = 547，路由用 `/_withSidebar/...` 布局段命名，匹配链 __root__ → /_withSidebar → /_withSidebar/chat → /_withSidebar/chat/$uuid
- 打包器疑似 rolldown (modulepreload 含 rolldown-runtime-BmbMa3VH.js)，模块联邦式的 shared-l-m-N / shared-p-m-N 分片（L/P/M 分层 + 序号），全部走 assets-proxy.anthropic.com/claude-ai/v2/assets/v1/
- SSR + 客户端 hydrate：__BOOTSTRAP_PRELOAD__ = {outcome: "adopted"}，__HISTORY_LOAD_CACHE_KEY__，__CHAT_TREE_PRELOAD__ {dispatchedAt, outcome, url, sessionMarker}
- 框架岛：meta name=frame-shell-entry → frame-shell-DTmmE9CZ.js；iframe 指向 a.claude.ai/isolated-segment.html（跨源隔离，配合 frame_grant_ledger / frame-pinned-valve 做授权账本）
- 可观测性：Datadog (DD_RUM, /api/v2/rum, _dd_s_v2)、Sift (_sift)、event_logging/v2/batch
- 实验：Growthbook (vendor-growthbook)
- 状态：React Query (vendor-query) + zustand 风格 store (conversation-store:*)
- 编辑器：ProseMirror / Tiptap (vendor-prosemirror, vendor-tiptap)
- Zod 全局注册表 (__zod_globalConfig / __zod_globalRegistry)
- 健康标记 __CLIENT_HEALTH__ = {}，__frameSessionId = 603cda0a-...

## 数据模型 (REST，全部同源 /api/)
- GET /api/organizations/{org}/chat_conversations/{uuid}
  返回: uuid, name, summary, model, created_at/updated_at, settings, is_starred/archived/temporary, workspace_upgraded, is_multiplayer, platform, is_wiggle_enabled, effective_thinking_mode, current_leaf_message_uuid, chat_messages[]
- chat_messages 元素字段: uuid, text, content[], sender, index, created_at, updated_at, truncated, attachments[], files[], sync_sources, parent_message_uuid
  当前会话 8 条 (4 human / 4 assistant)，index 0 的 human 消息带 files=[personality.md]
  注意：text 与 content 双写，content[] 该会话为空数组，正文只落在 text
  线性链但保留 parent_message_uuid（可支持分支/编辑重生成）
- 其他端点: /composer_notices, /memory/settings, /skills/list-skills, /projects_v2, /reflections/time_spent, /api/bootstrap/{org}/current_user_access (83 features + 168 permissions), /api/claude_code/organizations/{org}/user_settings

## 认证
- Cookie: sessionKeyLC / sessionKeyV3LC（内联脚本读取）、__ssid、activitySessionId、lastActiveOrg、anthropic-device-id、g_state
- 前端通过内联脚本直接 document.cookie 解析 sessionKeyLC → sessionKeyV3LC 兜底，说明是双 cookie 滚动迁移期
- 内联脚本还处理 clean-url hop、__ml_hop_pending

## 本地存储要点
- claude-conversation-ledger: 每次访问会话记 {u, at, d}，用于会话历史/去重
- conversation-revisits-device: {v, owner, createdAt, evictions, entries:[[uuid, ts]]} 带淘汰
- conversation-store:unsaved:{uuid} 值为 "streaming:<ts>:<uuid>" 或 "settled:<ts>:<uuid>" —— 流式草稿的持久化与结算标记
- chat-draft-wipe-started-at / -id / -completed-at / -id：清理草稿的四阶段状态机（崩溃可续）
- claude-ai:typed-turns:v2 与 claude-ai:client-sent-turns:v2：以 "convUuid:hash" 记录已输入/已发送，防止重复提交
- frame_grant_ledger：artifact 跨源 frame 授权账本，键形如 "<artifactId>.frame.claudeusercontent.com|<ts>"，值为 "org|account|"
- rq-cache-confirmed-account / -session：React Query 缓存归属校验
- 大量 LSS-* / spa:* 是 A/B 实验曝光与 latch 标记

## 页面内容
会话主题：让 Claude 审查并修订一份 personality.md（IS-SHEX 人格模型规格，约 2000 行），产出无修订痕迹的完整版本。
正文 4332 字符，含 8 条消息，最后一条为修订说明（列出数值复算错误、缺口补全、126 条文献覆盖）。

## 结论
claude.ai 是 SSR + 岛屿式框架 + 细粒度代码分片的 TanStack Router SPA；把「流式草稿」「草稿清理」「已发送去重」都显式落盘到 localStorage 并在值里编码状态机与时间戳，是为了在崩溃/多标签页下可恢复且幂等；artifact 预览通过跨源 frame + 授权账本隔离，账号与组织身份在 localStorage 中被显式绑定（logout-at 时间戳），属于多账号共用浏览器场景的隔离设计。
