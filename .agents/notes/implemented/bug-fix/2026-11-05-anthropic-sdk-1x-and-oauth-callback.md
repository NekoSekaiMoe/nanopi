# Agent Note: Anthropic SDK 1.x 下 temperature 的去留由 API 版本决定，OAuth 回调要放进 claude.ai 的 frame

Status: implemented

## Problem

`@anthropic-ai/sdk` 0.137.0 → 1.5.0 之后，`packages/ai` 报两处类型错，两个错背后是同一件事：
SDK 1.x 的 typegen 描述的是 **2026-10-21** 协议，而 nanopi 发出的请求不一定跑在那个版本上。
编译错误只是表层，真正要判断的是每个请求落在哪个 `anthropic-version` 上：

- `temperature` 从 `MessageCreateParamsStreaming` 里消失。若当成「字段被协议删了」直接不写，
  自定义网关、OpenRouter、Bedrock 这些还停在 **2023-06-01** 的端点就再也收不到这个字段，
  `supportsTemperature` 变成空操作。
- system 消息的 `content` 被收窄成 text / tool_addition / tool_removal 的联合，
  `ContentBlockParam[]` 不再可赋值。

同一次升级里，Claude 的 OAuth 登录在浏览器路径上也失效了。两处改动同批落地，各自都能独立成立。

## Decision

**temperature 留在 wire 上，版本由 header 决定。** `buildParams` 仍然在 `compat.supportsTemperature`
为真时写入 `temperature`，写入点是加宽后的类型
（`MessageCreateParamsStreaming & { temperature?: number }`）。理由不是绕过类型检查，而是事实：

- 2026-10-21 下任何 `temperature` 值都是 400，`top_p` / `top_k` 同理。
- 2023-06-01 没有废弃。迁移说明给出的两条路是「停发参数」或「请求留在 2023-06-01」，
  需要非默认采样值的请求属于后者。
- 所以字段去留是 `anthropic-version` 的函数。客户端默认 2026-10-21 写在 `buildHeaders` 的第一层，
  `defaultHeaders` 在它之后合并，`model.headers` 能覆盖——版本是每个请求各自决定的。

**system 消息只声明它实际会写的块。** `SystemContentBlockParam` 从
`SystemMessageParam["content"]` 推导（`Exclude<NonNullable<...>, string>[number]`），数组在循环内
就地声明。不能把数组提到循环外：`pendingSystemMessages` 里每一项按引用持有该数组，复用会让排队的
system 更新全部发出最后一条的块。

**OAuth token 端点换成 `api.anthropic.com`。** `platform.claude.com/v1/oauth/token` 是浏览器控制台
用的那份部署，只接受带浏览器上下文的请求，其他客户端一律 `403 forbidden`（带什么 header 都不行）。
`api.anthropic.com` 上跑同一套 OAuth grant，非浏览器客户端走它，并带 `anthropic-beta: oauth-2025-04-20`
与 Claude Code 的 User-Agent。

**`state` 与 PKCE verifier 解耦。** 原来 `state` 直接复用 verifier，verifier 就出现在 URL、浏览器
历史和回调页里。现在 `generateState()` 单独取 32 字节随机数，verifier 只进 token 请求。

**回调页声明 `frame-ancestors`。** Claude 的同意页在 claude.ai 的隐藏 frame 里收尾，并把回调页
渲染在这个 frame 内，所以响应头必须允许该祖先，否则页面不显示。`startOAuthCallbackServer` 新增
可选 `pageOrigin`（默认 `*`），写进 `content-security-policy:
default-src 'none'; style-src 'unsafe-inline'; frame-ancestors <origin>`，404 / 400 / 409 / 502
这些失败页也一并带上，不只成功页。Anthropic 传 `https://claude.ai`。

## Alternatives considered

- **删掉 `temperature` 的写入，让 `supportsTemperature` 失效**：迁移说明明说 2023-06-01 未废弃，
  删掉等于把所有还在旧版本上的自定义端点一起降级，且没有替代路径表达「这个端点需要非默认采样值」。
- **把 `supportsTemperature` 默认值翻成 false**：那是「停发参数」这条路，会把「留在 2023-06-01」
  这条路一并堵死。内置模型这边 `generate-models.ts` 已经把 opus-4.7/4.8/5、sonnet-5.5、haiku-5.5
  标成 false，这批在 2026-10-21 下本来就不该带该字段；默认值留给自定义端点。
- **用 `top_p` / `top_k` 表达采样偏好**：Anthropic 适配器从头到尾不发这两个，且在 2026-10-21 下
  同样是 400，不是替代品。
- **让 `state` 继续等于 verifier**：实现更少一个函数，但把 PKCE 的证明泄漏到 URL 和浏览器历史。
- **给 `platform.claude.com` 补浏览器 header 硬闯 403**：403 针对的是浏览器上下文，不是某几个
  header；补 header 只会得到更多伪造痕迹，且随对方策略变化随时失效。
- **回调页不写 CSP，靠浏览器默认**：默认没有 `frame-ancestors` 限制，但页面在 frame 里需要显式声明；
  同时 `default-src 'none'` 顺带关掉了这个纯状态页的脚本与外链。

## Consequences

- `temperature` 的实际效果取决于端点版本。给自定义端点配 `supportsTemperature: true` 且该端点默认
  2026-10-21 时，请求会 400——`compat-schema.ts` 里这条描述现在直接说明了这一点，配置者要在
  「关掉开关」和「用 `model.headers` 钉 2023-06-01」之间选一条。
- 升级 SDK 时不会再因为 `temperature` 缺槽位而报错，加宽点只有一处，`buildParams` 内。
- `callback-server.ts` 的 `pageOrigin` 默认 `*`，其他 provider 的行为不变；只有 Anthropic 收紧到
  `https://claude.ai`。
- 代价：`claude-cli/2.1.280` 这种版本号写在代码里，Claude Code 发版后需要跟进，否则身份头可能被识别为
  过期客户端。
- Testing: `anthropic-temperature-compat.test.ts` 断言 `model.headers` 钉住 2023-06-01 时 header 就是
  它、不钉时是客户端默认的 2026-10-21，原有六条 wire 断言不变；`anthropic-oauth.test.ts` 覆盖 token
  端点、`anthropic-beta` / User-Agent、state 解耦、浏览器回调页与 409 失败页的 `frame-ancestors`、
  以及首选端口被占时的回退；`transcript-tool-changes.test.ts` 覆盖 system 更新的块内容。
