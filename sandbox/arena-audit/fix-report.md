# Arena Bridge 修复报告（第二次返工）

## 0. 先说两个关键事实

### 事实 A：你上次"更新插件"时，加载的仍然是原版代码

我直连你正在运行的网关，并用页面自身的消息 API 探测了 hook 的版本：

| 探测项 | 观测值 | 结论 |
|---|---|---|
| `Object.keys(ArenaSSE)` | `["parse","readFrame","pickText"]` | 补丁版应有 `readDataLine` → **原版** |
| `ArenaSSE.parse('a0:"OK"\nad:{}')` | `frames: 0`, `text: ""` | 原版完全不认 data-stream → **原版** |
| hook 的 `info` 回复字段 | `href/recaptcha/captured` | 补丁版会多 `composer/chip/tabVisible` → **原版** |
| 有无 `log` 帧 | 无 | 补丁版每次操作都推 → **原版** |

原因：我只把补丁放在 `arena-patches/`，**从未写进你实际加载的 `arena/extension/`**。
`install-in-place.js` 已把它装好并备份原文件到 `arena-audit/original/`。

### 事实 B：arena 在标签页处于后台时，根本不渲染 composer

这是本次最重要的发现，它解释了为什么"看起来什么都没发生"。

实测（标签页在后台）：

```
body > div#S:2[hidden]           ← 整段应用被 hidden
  └─ div[data-perf-target="composer"]
       └─ form → textarea[placeholder="Ask anything…"]

textarea.offsetWidth        === 0
textarea.getBoundingClientRect() === 0 x 0
textarea.offsetParent       === null
button[aria-label="Send message"].disabled === true（写入文本后仍为 true）
```

三个 Next.js 段 `#S:0/#S:1/#S:2` **全部** `hidden`；`document.hidden === true`。
我伪造 `document.hidden=false` 并派发 `visibilitychange`/`focus`/`pageshow`/`resize`，站点**没有任何反应**。

这意味着原设计里"后台标签页也能自动跑"的假设是错的。原版 hook 的行为链是：

```
visibleTextareas(): offsetParent !== null  →  后台时全部被过滤  →  0 个
composer(): 正则 /ask anything|message|reply/ 匹配 placeholder
            'Ask anything…' 用的是省略号 U+2026，正则可以匹配，
            但候选池已被 offsetParent 清空  →  return null
→ 'composer not found'  →  502
```

**502 的形态变化可以证明补丁确实在起作用**（但只起了一半）：

| 阶段 | 报错 |
|---|---|
| 你上次跑的（原版） | `model switch failed: search box not found` |
| 我用补丁版网关跑（页面里仍是原版 hook） | `composer not found` |
| 补丁版 hook 修好 composer 后 | 应能走通，见下 |

补丁版的 composer 已经去掉了 `offsetParent` 过滤，但我在浏览器里加载的补丁版
被替换掉了（页面里跑的是原版），所以 HTTP 层测到的还是原版行为。

---

## 1. 本次对 `page-hook.js` 的二次修正

我上一版 composer 仍然把"可见性"当**硬性过滤条件**：

```js
// 上一版（仍然错）
.filter(function (t) { return visible(t) && !t.disabled && !t.readOnly; });
```

后台标签页下 `visible()` 全为 false → 候选池为空 → 依然 `composer not found`。

改成**可见性只用于优先、不用于排除**：

```js
function composer() {
  var pool = [...document.querySelectorAll('form textarea')]
    .filter(t => !t.disabled && !t.readOnly);          // 不再按可见性排除
  if (!pool.length) pool = [...document.querySelectorAll('textarea')]
    .filter(t => !t.disabled && !t.readOnly);
  if (!pool.length) return null;
  for (var i = pool.length - 1; i >= 0; i--) if (visible(pool[i])) return pool[i];  // 优先可见
  return pool[pool.length - 1];
}
```

同时新增 `foreground()`，把"为什么失败"说清楚：

```js
var why = foreground()
  ? 'the page is in the foreground, so the composer text did not reach React state'
  : 'the tab is in the BACKGROUND: arena does not render an interactive composer unless the tab is visible.'
    + ' The service worker must activate the tab (chrome.tabs.update active:true) before sending.';
```

`info` 回复现在也带 `tabVisible / composer / composerPlaceholder / composerVisible`。

## 2. 新增 `sw.js`：驱动 UI 前先激活标签页

既然后台标签页无法交互，service worker 必须在发请求前把标签页拉到前台：

```js
chrome.tabs.update(tabId, { active: true }, function (tab) {
  chrome.windows.update(tab.windowId, { focused: true }, ...);
  // 等 600ms 让 Next.js 把 hidden 段切换成可见，再驱动 UI
});
```

另外补上：每个阶段的 `log` 帧（接收请求 → 激活标签页 → 切模型 → 填词 → 等首包 → 完成/失败）、
请求看门狗（超时报出卡在哪一步）、backlog 只在真正写入失败时才保留。

## 3. 新增 `bridge.js`：把 hook 的 log 转发到网关

原来 hook 的日志在 MAIN world 里发出去没人接。现在 `d.type === 'log'` 会转发成
`arenaBridgeFrame`，最终出现在网关 stdout。切模型失败的**具体阶段**不再被吞掉。

同时修掉：迟到的 `selected` 不再重复 `go()`（原实现会重复发送），失败/超时消息带上阶段。

## 4. 实测结果（真实网关 127.0.0.1:8787，真实浏览器标签页）

### 4.1 网关日志已经可用

`arena/server.js`（补丁版）实际输出：

```
INF [agent] connected from 127.0.0.1 (slot reused, 0 request(s) pending)
INF [agent] catalogue updated: 250 models
DBG [agent] first 5 ids ["gemini-3.8-flash-high","gemini-3.1-pro-preview",...]
INF [http] req-2 GET /health -> 200 in 1ms
INF [relay] req-5 alias "claude-sonnet-5" -> "claude-sonnet-5-high"
DBG [upstream] req-5 -> agent reqId=f6fa2f02-… model=claude-sonnet-5-high bytes=22
ERR [agent] upstream error for req-5: composer not found
ERR [http] req-5 POST /v1/chat/completions -> 502 in 10615ms model="claude-sonnet-5" (-> "claude-sonnet-5-high") reason="composer not found"
```

对照原版 `arena/server.js`（跑 4 个请求后 stdout 的全部内容）：

```
[gw] listening on http://127.0.0.1:8790
```

端口被占用时的对照：

| | 输出 | 退出码 |
|---|---|---|
| 原版 | `Error: listen EADDRINUSE` + 未捕获异常堆栈 | 1 |
| 补丁版 | `ERR [gw] port 8787 is already in use.` + 换端口/查进程的具体命令 | 1 |

### 4.2 流式路径：错误不再伪装成正常结束

`node arena-test/golden-path.js` 实测：

```
POST model="claude-sonnet-5-high" (non-stream) -> 502  41694ms  "composer not found"

POST 同模型 stream=true -> 200  59998ms  frames=3
  +     3ms  {"choices":[{"delta":{"role":"assistant","content":""}}]}
  + 59998ms  {"error":{"message":"composer not found","type":"upstream_error"}}
  + 59998ms  {"choices":[{"delta":{},"finish_reason":"error"}]}
```

`finish_reason` 是 **`error`**，且**没有** `[DONE]`。原版这里会发 `finish_reason:"stop"` + `[DONE]`，
客户端无法区分"完整答案"和"半截答案"。

### 4.3 精确 id 的结论

- `/v1/models` 里 `claude-sonnet-5-high` ✅ 在列（250 个模型）
- `claude-sonnet-5`（publicName）❌ 不在列 —— 它是别名，不是 id
- 网关能正确解析别名：`INF [relay] alias "claude-sonnet-5" -> "claude-sonnet-5-high"`
- 站点 deeplink 解析器 `findModelForDeeplink` 顺序为 displayName → publicName → id，
  但整页加载实测 publicName / uuid 都会退化成 `Max`，**只有 displayName 可靠**

---

## 5. 已安装的文件

`node arena-test/install-in-place.js` 输出：

```
WROTE  arena/ws.js                  2889 ->  7045
WROTE  arena/server.js             10957 -> 19583
WROTE  arena/extension/page-hook.js 9379 -> 16155
WROTE  arena/extension/sse-parse.js 2428 ->  5978
WROTE  arena/extension/bridge.js    3687 ->  4570
WROTE  arena/extension/sw.js        2363 ->  5116
WROTE  arena/extension/manifest.json  852 ->   852
```

原文件已备份到 `arena-audit/original/`。安装后自检：

```
sse-parse exports readDataLine: true
manifest version: 1.1.0
gateway version marker: v1.1.0 (patched)
gateway has per-request log: true
```

## 6. 你需要做的

1. `chrome://extensions` → 找到 Arena OpenAI Bridge → 点 **重新加载**（版本号应变成 1.1.0）
2. 重载 arena.ai 标签页（让新的 content script 注入）
3. 我起的网关在 8787 上跑着补丁版，日志在 `arena-audit/gw-live.log`

重载后我可以用这个判定补丁是否真的生效（这三项在页面上就能查）：

```js
Object.keys(window.ArenaSSE)                          // 应含 readDataLine
window.ArenaSSE.parse('a0:"OK"\nad:{}').frames         // 应为 2
// 发 {op:'info'} 应回 tabVisible / composerPlaceholder
```

然后 `node arena-test/golden-path.js` 跑真实端到端。

## 7. 我这两次的交付错误

第一次：只读代码就给"已验证"结论，没碰真实网关，没验证解析器。

第二次：补丁放错目录（`arena-patches/` 而不是 `arena/extension/`），
所以我以为"你更新了插件"就等于"补丁生效了"，实际加载的还是原版；而且我的 composer
仍然用可见性做硬过滤，在后台标签页下必然失败。

这两次都是同一个毛病：**把"代码写对了"当成"功能验证通过了"**。
