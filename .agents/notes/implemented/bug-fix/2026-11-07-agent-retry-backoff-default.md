# Agent Note: agent 级重试默认退避改成 15s / 30s / 60s

Status: implemented

## Problem

`packages/coding-agent/src/core/settings-defaults.ts` 里 `retry.baseDelayMs` 默认 `2000`，
配合 `maxRetries: 3` 和 `maxAgentDelayMs: 60000`，三次重试分别等 2s / 4s / 8s，
总共 14 秒就放弃。

#574 里一次真实的 429 响应带了 `retry_policy.retry_after: 30`（服务端要求等 30 秒），
nanopi 的 agent 级退避只有 14 秒，三次全撞在同一堵墙上然后报失败。这个 429 的
`retry_after` 在正文里是自由文本（被 `normalizeProviderError` 拼进 `errorMessage`），
agent 级重试（`packages/ai/src/utils/retry.ts` 的 `retryDelayMs`）既不读它、也不做 jitter；
能读 `retry-after` 的只有 provider 级重试（`provider-retry.ts`），而后者默认
`maxRetries: 0`，文档明写「除非必要否则保持 0」。

换句话说：**服务端说等 30 秒，客户端连一次都没等到 30 秒就停了。**

## Decision

把 `retry.baseDelayMs` 默认从 `2000` 改成 `15000`。其余不动：`maxRetries: 3` 与
`maxAgentDelayMs: 60000` 保持，于是 `retryDelayMs` 的 `15000 * 2^(attempt-1)` 被 60 秒
cap 截断后正好是 **15s / 30s / 60s**（#574 要求的三个值），总等待 105 秒。

这是**改默认值，不是改算法**。`retryDelayMs` 的公式、cap、classifier、`retryAssistantCall`
的流程都一字未动；`settings.json` 里显式配了 `baseDelayMs` 的用户不受影响。同步更新的
只是把「2s, 4s, 8s」写死在描述里的几处：`settings-schema.ts` 的 description、
生成的 `schemas/settings.schema.json`、`docs/settings.md` 的默认值表，以及
`settings-manager.test.ts` 对默认值的断言。

15s / 30s / 60s 仍不是 `retry_after` 解析：第一次重试在 15 秒就发出，早于服务端建议的
30 秒。要真正「听服务端的话」得在 `AssistantMessage` 上加结构化字段（见下），那是跨包
契约变更，本次不做。默认值至少让第 2、3 次重试落在 30s / 60s，覆盖 #574 那类
`retry_after` 场景，而不是 14 秒就放弃。

## Alternatives considered

- **解析 `errorMessage` 里的 `retry_after: 30` 并 `max(建议值, 指数退避)`**：#574 的讨论里
  提过这条「最小改动」，但明确否掉了——从自由文本正则抓数字是错方向，provider 的 429
  body 格式各异，抓错会把等待时间算成任意数。正确做法是 adapter 在 429/503 时往
  `AssistantMessage` 填 `retryAfterMs?: number`，`retryDelayMs` 取 `max(建议值, 退避)`
  并加 jitter。这动 `pi-ai` 的公开接口（跨包契约），得单独设计、单独评审，不塞进
  一次默认值调整。本次选择不改类型面。
- **把 `maxAgentDelayMs` 也抬高**：没必要。三次退避刚好在第 3 次到 60s，cap 正是 #574
  要的第三个值；抬高 cap 只会让第 4 次（当前没有）或用户自定义 `maxRetries` 时等更久，
  超出这次要求。
- **只改文档/描述，不改默认值**：描述写 2s/4s/8s 是因为代码真是 2s/4s/8s。只改文字
  会造成文档与行为不符，且没有解决 14 秒放弃的实际问题。
- **改 provider 级重试的默认 `maxRetries`（让它去读 `retry-after`）**：文档明确要求
  provider 级保持 0，因为它会挡住 nanopi 自己处理 quota / usage-limit。打开它等于
  把 #574 第二条讨论里警告过的坑主动踩一遍。

## Consequences

- 默认失败路径变慢：一次连续失败的请求从「14 秒后报错」变成「105 秒后报错」。
  这是有意的取舍——用更长的等待换「服务端限流窗口过去后能成功」，代价是用户多等。
  `Escape` 仍可在退避 sleep 中 abort（见 `RetrySleepAbortError`），且
  `settings.json` 里 `retry.enabled: false` 或自定义 `baseDelayMs` 可随时覆盖。
- `maxAgentDelayMs` 仍是 60 秒，所以 15s / 30s / 60s 里第三个值恰好是 cap 值而非
  `15000 * 4`；若以后有人把 `maxRetries` 调到 4 以上，第 4 次起仍是 60s，不会无限翻倍。
- 生成的 schema 用 `npm run generate:schemas`（在 `packages/coding-agent` 下）重新生成，
  `config-schemas.test.ts` 的 stale 检查因此继续通过；该文件不要手改。
- 覆盖：`settings-manager.test.ts` 断言新默认值 `15000`；`packages/ai/test/retry.test.ts`
  仍用显式 `baseDelayMs`（2000 / 10 等）测 cap 与流程，不受默认值变化影响。
