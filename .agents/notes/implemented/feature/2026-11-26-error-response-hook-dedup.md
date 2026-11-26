# Agent Note: 失败响应埋点按错误码去重

Status: implemented

## Problem

Issue #815 讨论把上游 `earendil-works/pi` #12502 的「HTTP 4xx/5xx 也触发 onResponse」落到 nanopi。调研发现本地 `retryProviderRequest` 重试时每次失败尝试都可拿到结构统一的 status/headers，不需要像上游那样改 7-10 个适配器。最初的便宜改法是在每次失败尝试里调回调，但这会导致 429→429→成功 这类请求上报两次；用户要求改成「错误码相同只上报最后一次，不同才每次上报」，其他行为不变。

## Decision

`packages/ai/src/utils/provider-retry.ts` 的 `retryProviderRequest` 接受独立的 `onErrorResponse` 回调和可选的 `model`：

- 连续失败且 status 相同，只在最后一次失败时上报；status 变化则立即上报前一段的最后一次失败。
- 最终成功时补报挂起的失败；重试耗尽、不可重试错误、noRetryStatuses、abort 场景都在退出前上报当前失败。
- 成功响应不触发该回调；`onErrorResponse` 与 `onResponse` 完全分离，避免失败响应的 header 喂进 `AgentSession` 的模型身份检查导致误触发 re-issue。

类型定义在 `ProviderRequestOptions`，通过 `simple-options.ts` 透传，7 个 `retryProviderRequest` 调用点（openai-completions、openai-responses、azure-openai-responses、anthropic、openrouter-images、classifier-shared、google-shared→google-shared-stream）传入 `model`。用独立的 hook 字段，不改 onResponse 语义。

## Alternatives considered

- **上游方案：每个适配器从 error 里挖 status/headers 后上报**。—— 改动 7-10 个适配器且每个都要判断字段位置；本地 `isProviderError` 和 `normalizeProviderError` 已统一错误形状，集中处理更小。
- **每次失败尝试都上报**。—— 429 风暴下一次请求产生多条相同记录，正是用户要求消除的噪声。
- **只在重试耗尽后上报最终失败**。—— 会丢掉 429→500→成功 这类不同错误码的变化，用户明确要求「不同才每次上报」。
- **复用 `onResponse` 上报失败**。—— `AgentSession._installModelIdentityCheck` 会把失败响应的 header 当真实模型回答，可能误触发模型 re-issue；必须独立字段。

## Consequences

收益：一次请求对同一错误码最多一条记录，错误码变化仍可逐段观测，且无需触碰模型身份检查逻辑。代价：`ProviderRequestOptions` 和 7 个适配器多了透传字段；重试工具函数内部维护一个 `pendingError` 状态。`packages/ai/test/provider-retry.test.ts` 用三个用例钉住去重规则（同状态只报一次、状态变化逐段上报、耗尽后报最后一次）。
