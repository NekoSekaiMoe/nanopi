# Agent Note: 失败响应埋点按错误码去重

Status: implemented

## Problem

Issue #815 讨论把上游 `earendil-works/pi` #12502 的「HTTP 4xx/5xx 也触发 onResponse」落到 nanopi。调研发现本地 `retryProviderRequest` 重试时每次失败尝试都可拿到结构统一的 status/headers，不需要像上游那样改 7-10 个适配器。最初的便宜改法是在每次失败尝试里调回调，但这会导致 429→429→成功 这类请求上报两次。随后规则收紧为「连续同码只报最后一次」，再进一步定稿为「每种错误码只上报最新一次」：403→403→429 只留一次 403 和一次 429；相同错误码在后面再次出现时覆盖之前的记录。其他行为不变。

## Decision

`packages/ai/src/utils/provider-retry.ts` 的 `retryProviderRequest` 接受独立的 `onErrorResponse` 回调和可选的 `model`：

- `retryProviderRequest` 用 `Map<status, error>` 记录每种 status 的最新失败，请求结束时统一上报。相同 status 再次出现覆盖旧记录，不同 status 各自保留一条，按首次出现的顺序上报。
- 成功、重试耗尽、不可重试错误、noRetryStatuses、abort 都在退出前上报已记录的失败；`onErrorResponse` 回调抛错会中断请求并返回对应错误。
- 成功响应不触发该回调；`onErrorResponse` 与 `onResponse` 完全分离，避免失败响应的 header 喂进 `AgentSession` 的模型身份检查导致误触发 re-issue。

类型定义在 `ProviderRequestOptions`，通过 `simple-options.ts` 透传，7 个 `retryProviderRequest` 调用点（openai-completions、openai-responses、azure-openai-responses、anthropic、openrouter-images、classifier-shared、google-shared→google-shared-stream）传入 `model`。用独立的 hook 字段，不改 onResponse 语义。

## Alternatives considered

- **上游方案：每个适配器从 error 里挖 status/headers 后上报**。—— 改动 7-10 个适配器且每个都要判断字段位置；本地 `isProviderError` 和 `normalizeProviderError` 已统一错误形状，集中处理更小。
- **每次失败尝试都上报**。—— 429 风暴下一次请求产生多条相同记录，正是用户要求消除的噪声。
- **连续同码去重、码变化立即上报前一段**。—— 只处理相邻重复：403→403→429→403 会在 429 前报一次 403、再在末尾报一次 403。用户明确要求每个错误码只留最新一次，故改成按 status 维护最新失败并在请求结束时统一上报。
- **只在重试耗尽后上报最终失败**。—— 会丢掉 429→500→成功 这类不同错误码的变化，用户明确要求「不同才每次上报」。
- **复用 `onResponse` 上报失败**。—— `AgentSession._installModelIdentityCheck` 会把失败响应的 header 当真实模型回答，可能误触发模型 re-issue；必须独立字段。

## Consequences

收益：一次请求对同一错误码最多一条记录，错误码变化仍可逐段观测，且无需触碰模型身份检查逻辑。代价：`ProviderRequestOptions` 和 7 个适配器多了透传字段；重试工具函数内部维护一个 `Map<status, error>`。上报推迟到请求结束，回调读到的是每种错误码的最新 headers，而不是首次失败时的快照。`packages/ai/test/provider-retry.test.ts` 用五个用例钉住去重规则（同状态只报一次、每种状态只报最新一次且保留最新 headers、耗尽后报最后一次、abort 时仍上报）。
