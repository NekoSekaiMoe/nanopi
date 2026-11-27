# Agent Note: 移除 Qoder 的 OAuth 登录，保留 provider 与签到

Status: implemented
Archived: 2026-11-27

**Superseded for Qoder by [2026-11-27-remove-qoder-entirely](./2026-11-27-remove-qoder-entirely.md):** Qoder provider, signed API, model catalog and daily check-in are now all removed. This note records the earlier login-only step; its "provider and check-in stay" conclusion no longer holds.

## Problem

Qoder 的浏览器登录把一份设备 token 和账号事实写进 `auth.json`，但签到所需的设备指纹仍要从桌面端抓：
登录流程既不提供指纹，也无法验证用户填的值。登录成功后最常见的下一条消息是签到报
`no device identity`。"登录"因此既没有解决签到，又让账户配置依赖一条浏览器设备码流程。

这次移除的是 `qoder` / `qoder-cn` 的 OAuth 登录入口（`/login qoder`、`/login qoder-cn`、
`nanopi auth login --provider qoder*`）。推理 API、daily check-in 和 provider 注册保留：订阅本身可用，
只是改成用户直接提供 token。

## Decision

OAuth 链路从四处一起裁掉，避免只藏 UI 入口却仍打包 Node-only 流程：

- `packages/ai/src/auth/oauth/qoder-oauth.ts` 和 `packages/ai/test/qoder-oauth.test.ts` 删除；
  `auth/oauth/load.ts`、`bundled-oauth.ts`、`scripts/oauth-flows.mjs`、
  `buildconfig.json` 的 `oauth/qoder-oauth` 组件、`build-components.ts` 的 flow id 同步移除。
  这几个文件由 `validateOAuthFlowRegistry()` 交叉校验，漏一处构建会直接失败。
- `packages/ai/src/providers/qoder.ts` 只保留 `envApiKeyAuth`，不再声明 `oauth`。
  于是 `/login qoder` 不再产生 OAuth 选项；CLI `auth login` 报 "has no OAuth login"；
  webui 也不再把它列进 OAuth provider。
- 模型列表刷新从 `QODER_ACCOUNT_ID` / device token 读账号事实，环境变量与凭据 env 都能用。
  `qoder-cn` 读 `QODER_CN_DEVICE_TOKEN`，与推理 API 的默认取值一致；
  `qoder`（国际站）读 `QODER_DEVICE_TOKEN`。
- 签到入口照旧从"已存凭据"取 token。没有登录流程后，新用户没有 `auth.json` 里的 Qoder 凭据，
  所以签到会报 `not logged in`；老凭据仍可用。签到所需的机器头改由进程环境变量提供，
  因为已没有可写 `env` 的登录对话框。

`OAuthAuth.notice` 是上一轮为 Qoder 登录说明加的通用可选字段。登录入口移除后，Qoder 不再声明它，
但字段和 TUI/CLI 的渲染保留：其它 provider 仍可使用。

## Alternatives considered

**只隐藏登录入口，保留 OAuth 实现。** 失败。懒加载注册和构建 registry 仍会把 Node-only 的
callback server / PKCE 代码带进产物，base flavor 还会为它保留一个组件；用户看不到入口，
构建却继续付出成本和攻击面。

**连 provider 和签到一起删。** 做不到"只移除登录"：那会顺带删掉订阅推理和 daily credit，
而这次的问题只是登录这一步不值得保留。provider 仍在 `providerSets.all/presets`，
保留下来的模型刷新不依赖浏览器登录。

**把签到改成从环境变量读 token。** 会让已经存在的 OAuth 凭据失效，且与推理 API 的凭据解析顺序
（`credential.env` 优先、环境变量兜底）不一致。改动范围超出这次登录移除。

## Consequences

- `/login qoder` 和 `/login qoder-cn` 不再出现；老凭据仍是 OAuth 类型，运行时会按 oauth 刷新，
  但 provider 已经不再声明 OAuth，所以刷新路径只可能来自旧的 stored credential。
- 新用户只靠 `QODER_DEVICE_TOKEN` / `QODER_CN_DEVICE_TOKEN` 使用 provider；
  之前由登录写入的 `QODER_ACCOUNT_*`、`QODER_REGION` 需要自己设置。模型列表刷新要求
  `QODER_ACCOUNT_ID` 加 token，缺任一个就保留 `auto` entry，不做网络请求。
- daily check-in 仍只读 stored OAuth credential，新环境变量方式不会让它"登录"。
  文档明确签到需要已存 token，机器头走进程环境。源码和提示里不再指向 `/login qoder` 做重登：
  推理/签到过期时提示补 `QODER_ACCOUNT_REFRESH_TOKEN` 或重新抓 token，未配置时提示设置
  `QODER_DEVICE_TOKEN` / `QODER_CN_DEVICE_TOKEN`（或用 `/login` 存一个 key）。
- `packages/coding-agent/docs/providers.md` 的 Qoder 小节改为无浏览器登录的说明；
  上一轮关于登录对话框 notice 的决定由本文取代：
  [2026-11-13-qoder-login-carries-the-checkin-caveat](../feature/2026-11-13-qoder-login-carries-the-checkin-caveat.md)
  记录的 UI 机制仍在，但 Qoder 不再是它的使用者。

## Verification

- `pnpm run check` passes with no errors (the note verification reports 241 notes and no broken links).
- `node --test scripts/buildconfig.test.mjs` passes; `validateOAuthFlowRegistry()` passes against the edited `buildconfig.json`.
