# arena 项目实现审查报告

审查对象：`sandbox/arena/`（`server.js`、`ws.js`、`extension/{manifest.json,sw.js,bridge.js,page-hook.js,sse-parse.js}`）
审查方式：静态通读 + 可执行复现（本地 mock agent 跑完整网关、RFC6455 一致性用例、在真实 arena.ai 页面上驱动 hook 自身的消息 API 取证）
说明：所有结论都附有可复跑的脚本与命令；`BUG:` 前缀的用例刻意断言“当前（错误）行为”，修复后它们会转为 FAIL，这是我留下的信号。

---

## 0. 结论摘要

整体架构是**干净且克制**的：不复制凭据、不伪造请求，模型目录完全由浏览器上报，网关只做精确匹配、不做模糊兜底。这一点在代码注释和实现上是一致的。

但**扩展侧的 DOM 自动化在当前线上页面上已经失效**，且不是“偶尔找不到元素”的抖动，而是三条确定性错误：

| 编号 | 位置 | 问题 | 实测证据 |
|---|---|---|---|
| H1 | `page-hook.js: composer()` | placeholder 正则匹配不到真实 composer，退化为“最后一个可见 textarea”，在图片直连路由选到**错误的输入框** | 命中下标 1（无 placeholder），`setValue` 后发送按钮仍 `disabled`；真正的 composer 是下标 0（placeholder=`Describe the image you want to generate…`，无 `aria-label`） |
| H2 | `page-hook.js: visibleTextareas()` | `offsetParent !== null` 判定可见性，在首页/图片路由上真 composer 的 `offsetParent` 为 `null`，被误过滤 | `textarea#0 offsetParent === null`（祖先链里没有定位元素） |
| H3 | `page-hook.js: selectModel()` | 触发按钮启发式 `/max\|direct\|router/i` 第一个命中 `Direct`（模式选择器），**不是**模型选择器；真正的模型选择器是 `Max` 按钮 | 通过 hook 自身 API 发 `{op:'select', model:'gemini-2.5-pro'}` → `{"changed":false,"error":"option not found: gemini-2.5-pro"}` |

网关侧（`server.js`）逻辑正确、错误码齐全，但有**四个可复现的边角缺陷**：流式错误被吞成“正常结束”、半开连接僵尸、流式/非流式 model 字段不一致、CORS 全开。

`ws.js` 是一个自研 WebSocket 帧层，符合 RFC6455 的基本路径（握手向量、分片、ping/pong、close 都通过），但缺少协议校验与长度上限，存在内存放大与静默丢帧面。

---

## 1. 数据流

```
arena.ai 页面 (MAIN world)
  page-hook.js  ── 打补丁 window.fetch，观察自身 create-evaluation / post-to-evaluation
                 ── 真实 UI 操作：填 textarea → 点发送 → 读自身 SSE 响应体
        │ window.postMessage (__ns='arena-bridge')
  bridge.js (ISOLATED world)  ── 纯中转
        │ chrome.runtime.sendMessage
  sw.js (MV3 service worker)  ── 单条持久 WebSocket → ws://127.0.0.1:8787/agent
        │ WebSocket (JSON 帧)
  server.js ── POST /v1/chat/completions、GET /v1/models、GET /health
```

模型目录的唯一真相是**浏览器上报**（`server.js` 无内置清单），`resolveModel()` 只接受 id 或 agent 自声明的 aliases 的精确匹配 —— 设计上很干净。

---

## 2. 逐文件审查

### 2.1 `ws.js`（帧层）

**通过**（`arena-test/ws-test.js` 中 PASS 的项）：
- `acceptKey` 与 RFC6455 示例向量一致（`sha1(key+GUID)` base64）。
- `frame()` 三种长度编码（<126 / 126+u16 / 127+u64）正确；服务端帧不掩码。
- `createParser` 能处理：单帧、TCP 分片（逐字节投递）、标准分片（op1/fin0 + op0/fin1）、ping→pong（回显 payload）、close→回 close 帧 + `onClose`。

**缺陷**：

1. **`frameMasked()` 缺 64 位长度分支**（`ws.js:35-43`）：`b.length >= 65536` 时走 `writeUInt16BE` → 抛 `ERR_OUT_OF_RANGE`（实测 `frameMasked(Buffer.alloc(70000))` 抛 `RangeError`，`code=ERR_OUT_OF_RANGE`）。`frameMasked` 被导出但 `server.js` 未引用，所以线上影响面小，但它本身的错误是明确的。
2. **操作码 0 被静默改写为 1**：`const op = opcode || 1;` 让 `frame(_, 0)` / `frameMasked(_, 0)` 产生 opcode=1（实测 `frame(_)[0]&0x0f === 1`）。continuation 帧无法生成。
3. **无协议校验**：未掩码的客户端帧被正常投递（RFC 要求 1002 关闭）；孤儿 continuation 被当成独立消息投递；不检查控制帧的 FIN/长度（控制帧必须 FIN 且 ≤125 字节）；文本帧用 `toString('utf8')` 静默替换非法序列（应 1007）。
4. **无消息长度上限 + 接收缓冲无界**：`st.buf = Buffer.concat([st.buf, chunk])` 会一直累积未消费数据；一个声称 1 TiB 的 `0x7f` 长度头即可让进程持续吃内存（该长度检查缺席）。合计是 DoS 面。
5. **O(n²) 复制**：每个 TCP chunk 都整体 `Buffer.concat` 一次；大消息（例如模型把整段代码/长文一次推完）CPU 放大明显。

补丁见第 5 节（`arena-patches/ws.js`），19 条一致性用例 + 37 条网关端到端用例全绿。

### 2.2 `server.js`（网关）

**正确且经过验证的**（37 条用例，`arena-test/gw-test.js`）：
- 无 agent 时：`/v1/models` 返回空列表（不编造目录），chat 返回 503 `service_unavailable`。
- 鉴权：`GATEWAY_KEY` 只保护 `/v1/chat/completions`；缺/错 bearer → 401 `authentication_error`；`/health`、`/v1/models` 不鉴权。
- 目录：`/v1/models` 只输出 `id/object/created/owned_by`（不泄露 aliases）；`hello` 里空 id 与重复 id 被丢弃。
- 解析：`resolveModel` 精确匹配 id 与自声明别名；小写化别名被拒（404）；前后空白被 trim。
- 提示词扁平化：`[system] …`、`[assistant] …` 标记，数组 content 拼接为一段文本。
- 非流式：delta 聚合、`chatcmpl-<32hex>`、`usage` 全 0（诚实地未估算 token）。
- 流式：SSE 头正确，帧序列 `role → delta… → finish_reason:stop → [DONE]`。
- 错误映射：agent error → 502；超时 → 504（实测按 `REQ_TIMEOUT` 触发）；未知模型 → 404 并列出浏览器可用模型；坏 JSON → 400；未知路径 → 404。
- `/health` 暴露 `modelsAt/modelsAge`，给陈腐检测留了钩子。

**缺陷**：

6. **流式错误被吞成正常结束**（`handleChat` 的 `catch` 分支）：agent 报 error 后，代码只推一个 `{error}` chunk，随后**照旧**发 `finish_reason:"stop"` 与 `[DONE]`。实测帧序列为 5 帧：`role` → `error` → `stop` → `[DONE]`（外加此前已推出的部分 delta），客户端**无法**区分“完整答案”与“中途炸掉的半截答案”。OpenAI 语义下应改为在 chunk 上带 `finish_reason:"error"` 或客户端读到 `error` 后不下发 `stop/[DONE]`。
7. **流式/非流式 model 字段不一致**：流式用 `model: payload.model`（回显**调用方原始串**，含别名），非流式用 `model: modelId`（canonical id）。实测同一别名 `err-model`：流式 chunk 里 `model="err-model"`，非流式返回 `"ErrModel"`。调用方按 model 字段做统计会得到两个名字。
8. **半开连接僵尸（最值得修的一条）**：`server.on('upgrade')` 里只在 `socket.on('close')` 清理 `agent/agentModels`。HTTP 升级后的 socket 是半开的，对端（例如标签页崩溃、网络中断）只发 FIN 时，Node 的 `http.Server` 不再监听 `end`/`close`，`close` 事件**不触发**。实测：agent 裸 `destroy()` 后 2.5 s 内 `/health` 仍报 `agent:true, models:1`（我只观测到 2.5 s；按机理可无限持续），模型列表持续陈腐，且新连接会顶替旧槽位，使旧客户端永远收不到响应（其 pending 请求各自挂到 504）。`sse-parse`/`bridge` 侧对此无补偿。
   - 修复方向：在 upgrade 后手动 `socket.on('end', cleanup)`（`readableEnded` 语义），或给 `agent` 加 `lastSeen` + `/health` 里超时降级，并在 `sendToAgent` 失败时清理。
9. **CORS 全开**（`access-control-allow-origin: *`，且 `OPTIONS` 预检无条件放行）：默认绑定 `127.0.0.1` 时，浏览器私网访问保护 + 本地网络 ACL 会挡住公网页面的读取，风险有限；但文档化的 `HOST` 环境变量一旦设成 `0.0.0.0`，任何网页都能携带 `Authorization: Bearer <GATEWAY_KEY>` 读写该网关、消耗用户会话。建议默认拒绝非 `127.0.0.1` 绑定并在启动时告警，或对 Origin 做白名单。
10. `/health` 无鉴权（暴露 agent 连接状态与模型数量，低危）。

### 2.3 `extension/page-hook.js`

**优点**：无凭据复制、不伪造请求；模型列表只用页面自己的 `/nextjs-api/model-catalog`；别名只由实测目录字段推导（`publicName` / `id`）。

**缺陷（H1–H3 + 若干）**：

- **H1 composer 选错**（`composer()`，`page-hook.js:78-86`）：正则 `/ask anything|message|reply|输入/i` 匹配的是 *placeholder*。图片直连路由的 composer placeholder 是 `Describe the image you want to generate…`（实测），既不匹配正则、也没有 `aria-label`（真实页面上 `button[aria-label="Send message"]` 存在，但输入框无 label），于是落到 `return all[all.length-1]`（最后一个“可见” textarea）。实测该下标是 1（无 placeholder），把文本写进去后发送按钮**仍保持 disabled**（真 composer 是下标 0）。→ 图片/上传路由的 prompt 根本发不出去。
- **H2 可见性判定错误**（`visibleTextareas()`，`page-hook.js:72-76`）：`t.offsetParent !== null` 在 arena.ai 上是**假阴性**——真 composer 的祖先链（`div.flex → form → div.bg-surface-secondary.relative → …`）里没有定位元素，`offsetParent` 为 `null`（实测）。在首页/图片路由，hook 看到的可见 textarea 集合为空或只剩占位框。图片路由之所以“看起来能跑”，是因为唯一可见的 textarea#1 恰好被 `[all.length-1]` 兜底选中——纯属巧合，一旦 DOM 顺序变化即静默失效。
- **H3 模型选择器启发式错误**（`selectModel()`，`page-hook.js:101-131`）：`/max|direct|router/i` 第一个命中的按钮实测是 `Direct`（打开的是 **模式** 选择器：Battle / Agent / Side by Side / Direct），所以后续 `waitFor(input[placeholder="Search models"])` 永远失败。真正的模型选择器是 `Max` 按钮（点它才会出现 `Search models` 输入框，实测 `optionCount=40`）。→ 端到端实测：通过 hook 自身 API 发 `{op:'select', model:'gemini-2.5-pro'}` 得到 `{"changed":false,"error":"option not found: gemini-2.5-pro"}`（即“失败”，而不是“选错”）。**任何跨模型请求都会失败或在更坏的情况下发错模型**。
- **子串匹配选错项**（`selectModel()` 的 `os[j].innerText.indexOf(name) >= 0` + 取第一个）：实测在真实选择器里输入 `Max` 后，`[role=option]` 列表是 `["Max\nRouter", "uni-1.1-max"]`；hook 会点 **`Max\nRouter`**（Router 模式），而不是普通 `Max`。同理请求 `gpt-5.4-nano` 会命中 `gpt-5.4-nano-high`。目录里有 25 个名字含 `max` 这类前缀歧义。
- **`listModels()` 用 displayName 当唯一 id**：实测线上目录 6 个 arena、**449 条记录**，但只有 **250 个唯一 displayName（281 个唯一 uuid）**；同名跨 arena（text/code/document 等）与同名不同 uuid 混合。后果：(a) 暴露 `Max` 这类“路由器/模式名”与歧义名给 API 调用方；(b) 因 `seen[key]` 去重而**丢掉 31 个仅靠 displayName 无法区分的模型**（同名多 uuid）；(c) 另有 118 条记录共享同一 uuid，所以把 uuid 当别名会声称指向某个名字、实际由 arena 决定跑哪个模型。已核实 `/v1/models` 暴露出去的是 `displayName`、别名是 `[publicName?, uuid]`（`server.js` 的 alias 解析也只在**请求**侧生效，`/v1/models` 不泄露别名）。
- **早退比较跨命名空间**（`selectModel()` 开头）：`?model_a=` 实际是 slug（实测 `/image/direct?model_a=max`），而 hook 发布的是 displayName（`Max`），二者永不相等 → 已选中目标模型时仍走一遍 UI 切换（慢且易错）。
- 次要：`selenium`-式兜底 `sendButton()` 取“表单内最后一个非禁用按钮”，实测真表单内该位置的按钮**无 label**（`form button aria-label=""`），命中它不会触发提交；`grecaptcha` 包装在 120 s 后停止，但因发送路径完全走真实 UI，不构成功能缺陷，只影响 `op:'info'` 的观测完整度。

### 2.4 `extension/bridge.js`

- 切换失败不降级（`res.error` → 直接回 error，不 `pend.go()`）——**设计正确，注释与实现一致**。
- 死消息：2500 ms 定时器里发 `arenaBridgeStatus`，但 `sw.js` 没有该分支（无人处理）。
- 计时器泄漏：25 s 超时闭包捕获 `sid/reqId`，请求若已终止，后续 `selected` 仍会调用 `pend.go()` 触发**重复发送**。
- `pendingSelect` 以 `'sel-' + reqId` 为键，pending 粒度是“请求”而非“选择器状态”，并发请求会各自驱动 UI。

### 2.5 `extension/sw.js`

- `push()` 的 `try/catch` 不可靠：`ws.send` 在缓冲/关闭态通常**不抛异常**，因此 backlog 可能一次性全量 flush（包含已超时的请求 delta）。`flush()` 同理。
- 单一 `tabId` 被最后一次 `arenaBridgeRegister` 覆盖；多标签页并存时互相抢槽（`agent` 本来就是单槽位）。
- 无 `hello` 重发之外的目录刷新策略：目录只在注册时上报（`refreshModels` 只在 hook-ready 触发一次），长会话中目录会陈腐（`/health` 的 `modelsAge` 能看出来，但没人用它）。

### 2.6 `extension/sse-parse.js`

- `parse()` 只按 `\n` 切分，不处理 SSE 的注释/`event:`/多行 `data:` 累积语义；对“每个 `data:` 行都是独立 JSON”的现行格式够用。
- `TEXT_KEYS`/`SKIP` 依赖假设的帧类型词表（`textDelta`/`text-delta` 等）。可核实的是：线上 `0g__d2-1trrgt.js` 里确有 `text-delta` + `textDelta` 的处理分支，`post-to-evaluation` 响应是 AI-SDK 的**数据流协议**（本项目未引入 `ai` 包，页内只有 Next 自带探针），`06hv3_g-_j7h6.js` 里对该响应**没有任何** `data:` / `\n\n` / `getReader` / `ndjson` 文本解析痕迹。→ 结论：SSE 文本解析能否覆盖真实增量，**未经端到端验证**（我没有真正发一条 prompt 以免消耗用户的额度并生成真实评估会话）。如需闭环，应在 quiescent 状态做一次最小实测并把真实帧样本存进本目录。

### 2.7 `extension/manifest.json`

- `content_scripts` 两个 world、`document_start`、`all_frames: false`；MAIN world 用于打 `window.fetch` 补丁是必要且正确的。
- `permissions: ["storage","tabs"]`、`host_permissions` 仅 `arena.ai` 与本地网关 —— 最小化良好。
- `sse-parse.js` 同时挂在 MAIN（`globalThis.ArenaSSE`），未使用的 `module.exports` 分支是死代码（无害）。

---

## 3. 现场取证（真实页面）

在 `https://arena.ai/` 与 `https://arena.ai/image/direct?model_a=max`（登录态、扩展已注入）实测：

1. hook 已安装：`window.__ARENA_BRIDGE_HOOKED__ === true`，`window.ArenaSSE` 为 object，`window.fetch` 已被替换（非 native）。
2. 目录端点：`GET /nextjs-api/model-catalog` → **200 / application/json / 数组 / 6 个 arena / 449 条记录 / 449 均可选 / 250 个唯一 displayName**。
3. 可见性：`textarea[placeholder^="Ask anything"]` 的 `offsetParent` 为 `null`；祖先链无定位元素。
4. 图片路由：可见 textarea 为 #0（`Describe the image you want to generate…`）与 #1（无 placeholder）；hook 的 `composer()` 选中 **#1**，`setValue` 后发送按钮仍 `disabled`；选 #0 则立即 `disabled=false`。
5. 模型选择器：`/max|direct|router/i` 首个命中是 `Direct`；点开后是 4 个**模式**选项（Battle Mode / Agent Mode / Side by Side / Direct），**无** `Search models`。真正入口是 `Max` 按钮 → 出现 `input[placeholder="Search models"]`、`role=option` 40 项。
6. 通过 hook 自身消息 API：`{op:'info'}` → 无 recaptcha、`captured=0`；`{op:'models'}` → 250 项、首项 `gemini-3.8-flash-high`（`owned_by:google`，别名含其 uuid）；`{op:'select', model:'gemini-2.5-pro'}` → `{changed:false, error:'option not found: gemini-2.5-pro'}`。

局限：为避免消耗额度/产生真实评估会话，**未真实发送 prompt**；因此 H1 的结论是“在 composer/发送按钮层面无法触发提交”，而非“已观测到请求失败”。battle 模式与首页聊天未逐一实测。

---

## 4. 验证产物与复跑方式

| 文件 | 作用 | 命令 | 结果 |
|---|---|---|---|
| `arena-test/ws-cases.js` | 19 条参数化 RFC6455 一致性用例 | — | 共享用例集 |
| `arena-test/ws-test.js` | 对 `arena/ws.js` 跑用例 | `node arena-test/ws-test.js` | **7 项 FAIL**（均为真实缺陷，见 §2.1） |
| `arena-test/ws-fixed-test.js` | 对补丁跑同一用例 | `node arena-test/ws-fixed-test.js` | **19/19 PASS** |
| `arena-test/gw-test.js` | 37 条网关端到端用例（mock agent + 真实握手 + 真实帧） | `node arena-test/gw-test.js` | **37/37 PASS**（含断言当前行为的 `BUG:` 用例） |
| `arena-test/gw-fixed-ws-test.js` | 用 `require.cache` 把 `arena/ws.js` 换成补丁，重跑全套 | `node arena-test/gw-fixed-ws-test.js` | **37/37 PASS**（证明补丁是 drop-in） |
| `arena-test/close-test.js` | 僵尸连接行为矩阵（FIN vs 显式 close 帧） | `node arena-test/close-test.js` | 见下 |
| `arena-test/close2-test.js` | 僵尸连接的服务端事件取证（`end`/`close`） | `node arena-test/close2-test.js` | 见下 |
| `arena-patches/ws.js` | 硬化版帧层（drop-in） | — | 19+37 全绿 |

半开连接取证要点（`close2-test.js` 输出）：裸 `destroy()` 只产生服务端 `end`，**没有** `close`，`/health` 继续 `agent:true`；发送显式 close 帧（opcode 8）才产生 `close`，`/health` 立刻回到 `agent:false, models:0`；期间服务端连接数维持 3（僵尸 socket 未释放）。

---

## 5. 已交付补丁：`arena-patches/ws.js`

相对 `arena/ws.js` 的变更：

- opcode 0（continuation）**保留**，不再被 `|| 1` 改写；`frameMasked()` 支持 64 位长度形式。
- 接收侧改为“分片列表 + 每解析出一条消息才 join 一次”，去掉逐 chunk 的 O(n²) `Buffer.concat`。
- 新增 RFC6455 校验：未掩码客户端帧、孤儿 continuation、分片中插入数据帧、控制帧分片/超长、非最小长度编码、RSV 置位、保留操作码 → 发送 1002 并关闭。
- 新增 `MAX_MESSAGE`（默认 32 MiB，可用 `WS_MAX_MESSAGE` 覆盖）：429 声明超长时在缓冲任何 payload **之前**回 1009，避免 1 TiB 头吃内存。
- 文本帧用 `TextDecoder({fatal:true})` 校验 UTF-8，非法序列回 1007，而不是静默替换。
- `createParser(onMessage, onClose, { requireMasked:false })` 可选角色开关，便于用同一实现解析服务端方向（测试客户端需要）。
- 导出 `MAX_MESSAGE` 以便观测。

**仍建议但未改动的部分**（属于 `server.js` / 扩展，未落补丁，改动面更大且需要线上回归）：1. 流式错误路径：遇到 `error` 后不要再发 `finish_reason:"stop"` + `[DONE]`。
2. `socket.on('end')` 清理 agent 槽位（或 `lastSeen` 超时降级），解决僵尸连接。
3. `handleChat` 流式分支统一用 `model: modelId`。
4. `page-hook.js`：`composer()` 改为「按 role/结构选真 composer」而非 placeholder；可见性改用 `getBoundingClientRect().width/height > 0`；模型选择器改为按可访问名精确匹配并**优先精确等于**（`=== name` 优先于子串），并对模型列表暴露稳定 id；早退比较改用 URL slug 归一化。
5. `listModels()`：不要用 displayName 当唯一 id（同名多 uuid 会丢 31 个模型），建议 `id = uuid`、`aliases = [displayName, publicName]`，并在每个 arena 内限定可选项。
6. `bridge.js`：删除或实现 `arenaBridgeStatus`；`pendingSelect` 加“请求已终止”标记，避免重复发送。

---

## 6. 值得肯定的部分

- 不复制凭据、不伪造带 cookie 的请求；只用页面自身 fetch 的观察点 + 真实 UI 驱动（`page-hook.js` 顶部注释与实现相符）。
- 网关没有内置/离线模型目录，`/v1/models` 绝不 advertise 浏览器不能服务的东西；`resolveModel` 无模式匹配、无内置别名表。
- 模型切换失败不降级为“凑合发一个”（`bridge.js` 中显式注释并实现）。
- 错误码语义清晰（400/401/404/502/503/504），`REQ_TIMEOUT`、8 MiB 体积上限、SSE 反缓冲头（`x-accel-buffering: no`）都考虑到了。
- MV3 保活、2 s 重连退避、500 条 backlog 上限 —— 移动端 worker 生命周期处理得当。
