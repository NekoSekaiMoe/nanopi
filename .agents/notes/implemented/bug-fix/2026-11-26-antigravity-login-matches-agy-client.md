# Agent Note: Antigravity 登录对齐 agy 官方客户端的 PKCE / scope / 请求头

Status: implemented

## Problem

上游 `pi-antigravity-bridge` 的 `docs/ACP-PROTOCOL-REFERENCE.md` 记录了官方 `agy` 客户端
2026-09-03 的实抓登录 URL，和 nanopi 里 2026-10 写的直连 OAuth 流有三处实质差异：

1. 官方用 PKCE `code_challenge` (S256) + `state` nonce，`scope` 是
   `cloud-platform` + `userinfo.email` + `aicode`；nanopi 没有 PKCE/state，且用
   `userinfo.profile` + `cclog` + `experimentsandconfigs`，其中两个 scope 官方已经不再申请。
2. `loadCodeAssist` / `onboardUser` 是 Cloud Code 调用。身份头（`X-Client-Name`、
   `X-Client-Version`、`X-Goog-Api-Client`、`User-Agent`）在推理路径上有，登录路径上
   只有 `User-Agent: antigravity`，同一个客户端在两步之间身份不一致。
3. 手动粘贴重定向 URL 时没有校验 `state`。

用户按上游更新（`shinytale/nanopi#825`），目标是把这两条路径统一到官方客户端的形状。

## Decision

`packages/ai/src/auth/oauth/antigravity.ts`：

- 授权请求加 `code_challenge` / `code_challenge_method=S256` / `state`，scope 换成官方的三项；
  移除了 `client_secret` 之外无必要的 `include_granted_scopes`。`code_verifier` 通过复用
  `oauth/pkce.ts` 的 `generatePKCE()` 生成，只在 token 交换里出现，不进浏览器 URL。
- 回调服务器和手动粘贴的 URL 都校验 `state`：callback server 传 `state` 选项，手动路径
  解析 `?code=...&state=...` 与 `code#state`，不匹配直接失败且不会发 token 请求。
- `postCloudCode` 从 `api/antigravity-request.ts` 复用 `clientHeaders()`，让登录时的
  Cloud Code 调用和推理请求带同一组身份头。这个函数是纯数据模块，OAuth 是按需加载，
  不把 Google SDK 拉进包里。

`packages/ai/test/antigravity-oauth.test.ts` 用真实 Web Crypto 算出 verifier 的 S256
challenge，断言它与授权 URL 里的 challenge 相等；同时断言 scope、state 形状、两组
Cloud Code 调用的头，以及 state 不匹配时不发 token 请求。

## Alternatives considered

- **把 scope 列表只做增量补齐（保留 `cclog` 等旧项）**：看似兼容，但官方客户端已经不申请
  这些 scope，额外的 consent 项会让登录页面偏离官方形状；纳 pi 的第三方客户端本来就在
  灰区，不值得再多加权限。
- **在 OAuth 模块里复制一份头常量**，避免引入 `api/` 依赖：两处常量迟早漂移，#386 修的
  就是身份头漂移；`antigravity-request.ts` 只有字符串常量和纯函数，导入成本为零。
- **用 verifier 同时充当 state**：省一次随机数生成，但会把 PKCE 证明放进地址栏和浏览器
  历史，Anthropic 流专门避开这一点，这里沿用同一做法。

## Consequences

- 新登录的 scope 变窄；旧凭据的 refresh 调用不受影响（token 端点只换 token，不重新申请 scope）。
- 手动粘贴只有裸 `code=` 且不带 `state` 仍然接受：官方 URL 会带 state，但历史指引里
  有只让复制 code 的用法；带 state 的粘贴会被校验，避免伪造回调。
- `client_secret` 仍在 token 请求里：官方 ACP 流用 PKCE 公开客户端，但纳 pi 的 token
  端点行为以现有可工作路径为准，不在没有实抓 token 请求的情况下删掉凭据。
