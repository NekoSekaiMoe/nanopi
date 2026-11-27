# Agent Note: 彻底移除 Qoder provider、API 与签到

Status: implemented

## Problem

Qoder 的浏览器登录已在上一次改动中移除，但 provider、签名推理 API、模型列表刷新和每日签到仍在：
`qoder` / `qoder-cn` 出现在 provider 集合、`apiSets`、compat API 注册表和构建配置里，
`packages/ai/src/qoder/` 与 `packages/coding-agent/src/modules/qoder/` 仍随产物发布。
只清登录提示会留下整条用不到的订阅链路，也让用户误以为 Qoder 仍受支持。

## Decision

Qoder 相关的全部代码和接线一起删除，作为一次纯粹的减法：

- 删除 `packages/ai/src/qoder/`、`packages/ai/src/api/qoder.ts`、`qoder.lazy.ts`、
  `qoder-disabled.ts`、`packages/ai/src/providers/qoder.ts` 和三个 Qoder 测试文件。
- 删除 `packages/coding-agent/src/modules/qoder/` 和 `qoder-checkin-run.test.ts`；
  从 modules 注册表、`buildconfig.json` 的组件 / bundle / 集合、`package.json` 的 `./qoder` 导出、
  `tsconfig.json` 与 vitest 别名中移除对应条目。
- 从 `KnownProvider`、`BUILTIN_APIS`、生成器和 `model-runtime.ts` 里移除 qoder 的 provider id、
  api id 和专用 model catalog 包装。旧 `models.json` 里若写了 `qoder` provider，加载时会按未知 provider 忽略。
- 一并删除只被 Qoder 用于保存续期 token 的 mid-response 轮换机制：`AuthorizationUpdate`、
  `onAuthorizationUpdate`、`Models.storeAuthorizationUpdate`、`ModelRuntime.readCredential`
  及其测试。其它 provider 不调用这些接口，保留只会是一条无调用方的公开契约。

历史 CHANGELOG 和 `.agents/notes/` 里的 Qoder 记录保留，作为已移除功能的档案，不是现行文档。
`docs/providers.md` 的 Qoder 小节和上一轮 note 中关于"保留 provider / 签到"的结论同步删除。

## Alternatives considered

**保留 provider 和签到，只删登录提示（PR #868 的原方案）。** 已被用户否掉：
用户明确要求彻底清除 qoder 相关，而不是只修 `sign in again` 之类的提示。

**只删运行时代码，保留公开类型和接口。** 拒绝：`AuthorizationUpdate` 等接口此时已无调用方，
留着会让外部误以为有 provider 支持响应内凭据轮换，且 `storeAuthorizationUpdate` 的
QODER 专用 env 写入无法在删掉 Qoder 后自圆其说。

## Consequences

- 仓库源码、配置、文档中不再有 qoder / QODER 引用；`rg -i qoder` 只命中 CHANGELOG 与历史 note。
- `qoder` / `qoder-cn` 不再是内置 provider 或 API；`apiSets.endpoint` 与 provider 集合里也没有它们。
- 旧的 `auth.json` 中残留的 Qoder 凭据不再被任何 provider 读取；不提供迁移或转换。
- `pnpm run check` 通过；已有的 Qoder 测试随功能一起删除，没有遗留断言。

## Verification

- `pnpm run check` exits 0（generate:models、typecheck、agent-note 校验均通过）。
- `grep -rin qoder --exclude-dir=node_modules --exclude-dir=.git .` 只命中 CHANGELOG 与 `.agents/notes/`。

> 同日的 [2026-11-27-remove-qoder-oauth-login](./2026-11-27-remove-qoder-oauth-login.md)
> 记录只移除浏览器登录的第一步；本文取代它关于"provider 与签到保留"的结论。
