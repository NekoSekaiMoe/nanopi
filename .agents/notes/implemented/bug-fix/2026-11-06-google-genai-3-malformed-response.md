# Agent Note: @google/genai 3.0.0 的穷尽检查撞的是一处新增枚举，不是一次 API 迁移

Status: implemented

## Problem

Renovate 的 `NekoSekaiMoe/nanopi#23` 把 `@google/genai` 从 2.32.0 提到 3.0.0，CI 在
`pnpm run check` 的 `tsc --noEmit` 上红：

```text
src/api/google-shared.ts(468,10): error TS2322:
  Type 'FinishReason.MALFORMED_RESPONSE' is not assignable to type 'never'.
```

报错位置是 `mapStopReason` 的 `default` 分支——`const _exhaustive: never = reason`。
穷尽检查在这里是对的：3.0.0 的 `FinishReason` 加了 `MALFORMED_RESPONSE`（“Token
generation stopped because the response was malformed”），而 2.32.0 的 19 个值我们
已经全部分类过，新值落进 `default` 就编不过。

版本号是 major，但这条升级里真正影响运行时的破坏面不是 major 该有的样子：
`FinishReason` / `GenerateContentResponse` / `Models` 的类型差异逐块 diff 下来，
除了这一条枚举值和若干 JSDoc 示例模型名，没有签名变化。两处行为变更都不落在我们的
调用路径上：

- **Gemini Developer API 默认版本 `v1beta` → `v1`。** 这个适配器从不依赖默认值：
  `createClient` 在 `model.baseUrl` 存在时（内置目录的每个模型都带
  `https://generativelanguage.googleapis.com/v1beta`）同时写
  `httpOptions.apiVersion = ""`，让 baseUrl 里的版本段成为唯一来源。用 SDK 3.0.0 的
  `fetch` 钩子实测，请求仍落在 `/v1beta/models/...:streamGenerateContent`；
  设 `GOOGLE_GENAI_API_VERSION=v1alpha` 也不会改变它——显式 `apiVersion` 优先于环境变量。
- **`engines.node >=22`。** 仓库下限是 24（见
  [node 24 is the floor](../process/2026-10-27-node-24-floor.md)）。

## Decision

给 `mapStopReason` 补一个 case，把 `MALFORMED_RESPONSE` 和其余「中止了但没有正常
收尾」的原因一起归到 `error`：

```ts
case FinishReason.CONTINUATION:
// Added in @google/genai 3.0.0: generation stopped because the response was malformed.
case FinishReason.MALFORMED_RESPONSE:
	return "error";
```

`error` 是唯一说得通的目标：`stop` / `length` / `toolUse` 都表示回合按预期收束，
而畸形响应既不给可用内容，也不给长度信息。这条同 `MALFORMED_FUNCTION_CALL` 一致——
形式不同，性质相同。

`packages/ai/test/google-raw-stop-reason.test.ts` 里那个 mock 的 `FinishReason` 补上
`MALFORMED_RESPONSE`，并加一条断言：两个适配器在这条 finish reason 下都得到
`stopReason: "error"`、`rawStopReason: "MALFORMED_RESPONSE"`，`errorMessage` 是
`Provider stopped with: MALFORMED_RESPONSE`。回归测试钉的是这次编译红背后的不变量——
每个枚举值都必须有归属，且归属要能在不抛异常的情况下走到流收尾。

`pnpm-lock.yaml` 只有 `@google/genai` 三条：importer 的 specifier/version、包的
resolution、snapshot 的键。`protobufjs` 的 override 仍是 7.6.6：3.0.0 把它自己的声明
从 `^7.5.4` 抬到 `^7.6.5`，7.6.6 仍在这个范围内，条件
（[runtime major bumps](../process/2026-10-27-runtime-major-bumps.md)）没有触发。

## Alternatives considered

- **把 `default` 分支改成 `return "error"`，删掉穷尽检查**：下一次 SDK 加枚举值时
  会静默走 `error`，compile 不再提醒我们判断这个新值该归哪一类。这次的
  `MALFORMED_RESPONSE` 恰好归 `error`，但 `CONTINUATION` 当初加进来时同样「恰好」——
  靠巧合不如靠编译器喊一声。
- **把 `reason` 收窄成 `FinishReason | string`，让未知值走 `error`**：等于同时放弃
  穷尽检查、并假装 SDK 会发枚举外的字符串。`candidate.finishReason` 的类型就是
  `FinishReason | undefined`，没有这条缝。
- **回头钉住 2.32.0 或加 `ignoreDeps` 挡住 3.x**：这条升级没有真正的破坏面，
  挡它的代价是以后每次都得手工重估一次「3.0.0 到底坏不坏」，而且丢掉
  `MALFORMED_RESPONSE` 这条 provider 反馈。
- **在 `packages/ai` 里自己维护一份 `FinishReason` 副本做映射**：多一层翻译，
  且新值仍然需要在某处被分类——只是把编译错误换成了运行时静默。

## Consequences

- SDK 再扩 `FinishReason` 时会再一次编译红，位置仍是 `mapStopReason` 的 `default`。
  这是特性不是缺陷：那正是「有一个新原因需要我们决定怎么归类」的时刻，
  照 2.31.0 加 `CONTINUATION`、3.0.0 加 `MALFORMED_RESPONSE` 的先例，改动量是一行 case
  加一条 mock 键。
- `MALFORMED_RESPONSE` 走 `error` 之后，`isTerminalFinishReason` 目前不认它：
  `NON_RETRYABLE_FINISH_REASON_PATTERN`（`packages/ai/src/utils/retry.ts`）里列的
  Google 值是 `SAFETY` / `BLOCKLIST` / `PROHIBITED_CONTENT` / `SPII` / `RECITATION` /
  `IMAGE_SAFETY` / `LANGUAGE` / `NO_IMAGE`。畸形响应更像 `malformed_function_call`
  那种「重试会原样复现」，但这条升级不该顺手改重试策略，所以留给后续判断。
- `pnpm run check` 与 `node ./test.mjs` 全绿：ai 1489、coding-agent 2619、agent 102、
  extra 134、webui 7。
