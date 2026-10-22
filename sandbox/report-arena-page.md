# arena.ai /text/direct 页面观察报告

## 1. 页面身份
- URL: https://arena.ai/text/direct?model_a=max
- title: Chat with Multiple Frontier AI Models
- 框架: Next.js App Router + Turbopack chunk；RSC 预取(`?_rsc=`)，无 `__NEXT_DATA__`；React 客户端渲染
- 静态规模: 385 个元素，8 个 hidden/aria-hidden 节点；document.lang=en
- 第三方脚本: Google reCAPTCHA v3、DataDog RUM(browser-intake-us3)、PostHog、Cloudflare(__cf_bm)

## 2. 可见结构(innerText 全文仅 272 字符)
- 侧栏: New Chat(/text/direct)、Leaderboard(/leaderboard)、Search(/history/search)、账户 cdy256448@gmail.com、Terms(/terms-of-use)、Privacy(/privacy-policy)、Cookies
- 入口卡片: Battle Mode(Battle 2 anonymous models) / Agent Mode / Side by Side / Direct / Max
- 输入区: textarea[placeholder="Ask anything…"]、Add files、Direct|Max 档位切换、Send message(初始 disabled)
- form method=get 无 action —— 发送走 JS(fetch/SSE)，不是原生表单提交

## 3. 接口(实测本会话内已发出)
| 端点 | 用途 |
|---|---|
| GET /nextjs-api/model-catalog | 6 个 arena 的完整模型目录(见下) |
| GET /api/history/unified?limit=20&includeArchived=false | 侧栏历史 |
| GET /api/me/pulse | 登录态/额度心跳(本次 200) |
| GET /nextjs-api/autoeval/release-banner | 发布横幅 |
| /leaderboard/<arena>/<tab>?_rsc=… | RSC 预取(tab: text/search/vision/document) |
| /rpc/api/surveys/ | PostHog 代理 |

model-catalog 实测返回 6 个 arena(全部 complete=true)：
- text 118 个模型
- code 81
- search 17
- text-to-image 40
- text-to-video 75
- document 118
模型条目字段: id, organization, provider, publicName, displayName, capabilities{inputCapabilities{text,image,file}, outputCapabilities{text,web}}, userSelectable, rank。

## 4. 会话与凭据(只读观察，未做任何修改)
- cookie arena-auth-prod-v1.0: 值以 `base64-` 前缀，非 httpOnly，内含 access_token(ES256 JWT)、refresh_token、user{id,email,app_metadata.provider=google}、expires_at。
- 内层 access_token 头部: {alg:ES256, kid:09a27963-736f-4c4f-94b2-bfc4b1b61f88, typ:JWT}；声明: iss=https://huogzoeqzcrdvkwtvodi.supabase.co/auth/v1, aud=authenticated, role=authenticated, aal=aal1, amr=[oauth]，iat=1792663741、exp=1792667341(1 小时)。
  => 认证后端是 Supabase Auth，arena.ai 前端只持 JWT。
- 其它 cookie: arena-auth-prod-v1.1(identity 明文 base64)、sidebar_state、user_country_code=JP、arena_build_bucket=stable、__cf_bm(Cloudflare)、PostHog ph_...
- localStorage: arena-open-tabs:v1、posthog device/distinct id、_grecaptcha、app_banner_state、image_edit_promo_state。

## 5. 观察技巧备注
- 本会话内 document.cookie 对 arena-auth-prod-v1.0 的读取被截断在 3173 字符(模 4 余 1，尾部出现半个 base64 组)，但前缀仍可解出内层 JWT 头尾；完整值需用 storage 工具读取。
- 未执行: navigate / tamper / storage 写 / 任何请求改包。

