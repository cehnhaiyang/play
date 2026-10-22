# Arena OpenAI Bridge

把**正常登录的浏览器里的 arena.ai 会话**包装成 **OpenAI 兼容 API**,供任意 OpenAI SDK / 客户端调用。

```
你的客户端  --(OpenAI HTTP)-->  本地网关 :8787  --(WebSocket)-->  扩展 SW  --(postMessage)-->  页面 hook  --(真实 UI 点击)-->  arena.ai
```

## 为什么这样分层

| 层 | 职责 | 为什么必须是它 |
|---|---|---|
| 页面 hook(MAIN world) | 用真实 UI 交互发消息、读页面自己的 SSE | 复用页面自己的 cookie、Supabase JWT、reCAPTCHA v3 token;不伪造任何凭据 |
| content bridge(ISOLATED) | 纯消息中转 | 页面与扩展之间的唯一合规通道 |
| service worker | 维持到本地网关的 WebSocket | MV3 里唯一能长连后台的地方 |
| 本地网关(Node) | OpenAI 协议适配、SSE 重新打包 | 把 delta 流翻译成 `chat.completion.chunk` |

## 安装

### 1. 启动网关

```bash
cd arena-openai-gateway
node gateway/server.js
# [gw] listening on http://127.0.0.1:8787
```

环境变量:

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 只绑本地 |
| `GATEWAY_KEY` | 空 | 设置后要求 `Authorization: Bearer <key>` |
| `REQ_TIMEOUT` | `180000` | 单次上游超时 ms |
| `QUIET` | 空 | `1` 关闭日志 |

### 2. 加载扩展

1. Chrome 打开 `chrome://extensions`
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选 `arena-openai-gateway/extension`

### 3. 打开 arena.ai

在**同一个浏览器**里打开 `https://arena.ai/text/direct?model_a=claude-sonnet-5-high` 并保持登录。
扩展会自动:
- 注入页面 hook,拉取 `/nextjs-api/model-catalog` 得到可用模型列表
- service worker 连上 `ws://127.0.0.1:8787/agent`,把模型表发给网关

验证:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"agent":true,"models":281}
```

## 使用

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [{"role": "user", "content": "用一句话介绍你自己"}]
  }'
```

流式:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.1","stream":true,"messages":[{"role":"user","content":"count to 5"}]}'
```

OpenAI Python SDK:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")

for ch in client.chat.completions.create(
    model="claude-sonnet-5",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
):
    print(ch.choices[0].delta.content or "", end="")
```

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, agent, models}` |
| GET | `/v1/models` | 来自浏览器实时 catalog |
| POST | `/v1/chat/completions` | 支持 `stream: true` |
| WS | `/agent` | 扩展专用 |

## 模型命名(重要)

arena 有两套名字,**网关接受两者**:

| 我请求的 | 页面 URL 里的 |
|---|---|
| `claude-sonnet-5`(publicName) | `claude-sonnet-5-high`(displayName) |

页面 hook 通过模型选择器搜索并点击选项来切换模型,所以写哪个都能被搜到。

## 消息格式限制

arena 的页面只接收**一段纯文本**。网关把 OpenAI 数组压平:

```
[system] be terse

user 的第一轮

[assistant] 上一轮回答

这一轮提问
```

- 不支持多模态附件、function calling、`temperature` 等采样参数(页面 UI 无对应控件,网关会忽略)
- `usage` 恒为 0(页面不返回 token 计数)
- 每轮是**页面上的新消息**,历史由你传的 `messages` 重建

## 自测

```bash
node test/selftest.js
```

12 项断言覆盖:无 agent 时 503、鉴权 401、`/v1/models` 直通、非流式拼接、system/user 压平、SSE delta 序列、`[DONE]` 终止、首块 role、`finish_reason`、content-type、上游错误 502、缺字段 400。

## 排错

| 现象 | 原因 |
|---|---|
| `503 browser extension not connected` | 扩展没装 / arena.ai 标签页没开 / 网关没起 |
| `option not found: xxx` | 该模型在当前 Max 列表里不存在,先看 `/v1/models` |
| `send button stayed disabled` | 输入框选择器没命中,通常是还没加载完或弹了 ToU 同意框 |
| `no evaluation request observed` | 页面把你拦在 reCAPTCHA 或限流,人工在页面上发一条确认 |
| 流中途断 | MV3 worker 被回收,扩展已带 20s keepalive;仍断可调大 `REQ_TIMEOUT` |

## 边界

- 网关只绑 `127.0.0.1`,不对外暴露
- 不复制、不外传任何 cookie / JWT / reCAPTCHA token;token 留在页面里由页面自己签名
- 不构造伪造请求:所有上游流量都是真实 UI 点击产生的
- 你的输入会被 arena 按其条款披露给模型提供方,勿发敏感信息
