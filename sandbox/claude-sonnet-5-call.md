# 调用 claude-sonnet-5 (arena.ai) — 实测记录

页面: https://arena.ai/text/direct?model_a=claude-sonnet-5-high
账号: cdy256448@gmail.com

## 结论: 调用成功

| # | 发出的 prompt | 模型回复 |
|---|---|---|
| 1 | Reply with exactly: PONG-123. One short sentence. | PONG-123. |
| 2 | Second probe: reply with exactly OK-456 | OK-456 |

两次都严格按指令返回了指定字符串, 说明请求确实打到了该模型。

## 模型标识

```
publicName    : claude-sonnet-5
displayName   : claude-sonnet-5-high
id            : 019f19f2-41f1-7c6d-9891-48d02fd9952c
organization  : anthropic
provider      : googleVertexAnthropicAdaptive
rank          : text=58, code=47, document=17
userSelectable: true
```

注意: URL 与 UI 显示 displayName (claude-sonnet-5-high), 目录里的 publicName 才是 claude-sonnet-5。
在模型搜索框输入 sonnet, 该 Max 路由下只返回 claude-sonnet-5-high 一个选项。

搜索 arena 目录里全部 sonnet 条目 (6 条 / 4 个唯一 id):

| id | publicName | displayName | arena | provider |
|---|---|---|---|---|
| 019f19f2-41f1-7c6d-9891-48d02fd9952c | claude-sonnet-5 | claude-sonnet-5-high | text, code, document | googleVertexAnthropicAdaptive |
| 019c6f55-70d6-7a9c-b89b-9a0db36a3582 | claude-sonnet-4-6-search | 同左 | search | anthropicSearch |
| 019f1a07-de72-7fbe-8d82-56dbd7348360 | claude-sonnet-5-search | 同左 | search | anthropicSearch |
| 019bda1f-3664-75d3-91b9-ede8f7561e44 | claude-sonnet-4-5-search | 同左 | search | anthropicSearch |

## 调用链 (两段式)

1. POST /nextjs-api/stream/create-evaluation
   建评估会话, 返回 evaluationId (本次 01a162ea-5464-79ea-a4a9-a25ad5eccf7f)
2. POST /nextjs-api/stream/post-to-evaluation/{evaluationId}
   Accept: text/event-stream -> 响应 200, content-type: text/event-stream (SSE 流)

## 第二段请求体 (实测抓包原样)

```json
{
  id: 01a162ea-5464-79ea-a4a9-a25ad5eccf7f,
  modelAId: 019f19f2-41f1-7c6d-9891-48d02fd9952c,
  userMessageId: 01a1631e-d59c-74aa-8bc6-caf42fef2cf0,
  modelAMessageId: 01a1631e-d59d-7a66-ae96-9a4ac965ac5c,
  userMessage: { content: <用户文本>, experimental_attachments: [], metadata: {} },
  modality: chat,
  recaptchaV3Token: <约 2000 字符, grecaptcha enterprise v3>
}
```

要点:

- 所有 id 都是 UUIDv7; 消息 id 由前端预生成。
- modality 枚举域: auto | chat | webdev | search | image | p2l | video | audio。
- 必须带 recaptchaV3Token, 否则会被拒。
- 请求体里没有模型名文本, 只有 modelAId, 模型靠 id 解析。
- Direct 模式只填 A 侧字段; battle 模式另有 modelBId / modelBMessageId。

## 其他观察

- 首次发送前弹 ToU 同意框, 点 Agree 后前端 POST /api/me/update-tou-consent。
- 发送期间伴随 GET /api/me/pulse 与 GET /api/history/unified?limit=20&includeArchived=false。
- 流式 thinking 指示用的是 Rive 动画 https://arena.ai/rive/thinking-light.riv。
- POST /rpc/i/v0/e/ 为 PostHog 事件上报, 与模型调用无关。
