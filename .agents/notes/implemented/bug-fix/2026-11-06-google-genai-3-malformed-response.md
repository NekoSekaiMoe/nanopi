# Agent Note: @google/genai 3.x 的穷尽检查撞的是一批新增枚举，不是一次 API 迁移

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

3.3.0 重演了同一件事，只是这次一次加了四个：`MISSING_THOUGHT_SIGNATURE`（重放时
缺了必需的 thought signature）、`ESCALATION`（被升级规则拦下）、`PUP_LIMITED_DISABLED`
（账号因违反 Prohibited Use Policy 被限制或停用）、`MODEL_ARMOR`（响应被 Model Armor
拦截）。CI 上的报错形状与 3.0.0 一致，只是 `never` 的分支列变成了四个值。

## Decision

给 `mapStopReason` 补 case，把 `MALFORMED_RESPONSE` 和其余「中止了但没有正常
收尾」的原因一起归到 `error`：

```ts
case FinishReason.CONTINUATION:
// Added in @google/genai 3.0.0: generation stopped because the response was malformed.
case FinishReason.MALFORMED_RESPONSE:
// Added in @google/genai 3.3.0: a replay dropped a required thought signature.
case FinishReason.MISSING_THOUGHT_SIGNATURE:
// Added in @google/genai 3.3.0: the request was dropped by an escalation rule.
case FinishReason.ESCALATION:
// Added in @google/genai 3.3.0: the account is limited or disabled under Google's
// Prohibited Use Policy.
case FinishReason.PUP_LIMITED_DISABLED:
// Added in @google/genai 3.3.0: Model Armor blocked the response.
case FinishReason.MODEL_ARMOR:
	return "error";
```

`error` 是唯一说得通的目标：`stop` / `length` / `toolUse` 都表示回合按预期收束，
而畸形响应既不给可用内容，也不给长度信息。这条同 `MALFORMED_FUNCTION_CALL` 一致——
形式不同，性质相同。

`packages/ai/test/google-raw-stop-reason.test.ts` 里那个 mock 的 `FinishReason` 跟上
SDK 的枚举值，断言改成按值参数化：两个适配器 × 五个新值，每个都得到
`stopReason: "error"`、`rawStopReason` 等于该值、`errorMessage` 是
`Provider stopped with: <值>`。回归测试钉的是编译红背后的不变量——每个枚举值都必须有
归属，且归属要能在不抛异常的情况下走到流收尾。参数化是为了下一次 SDK 加值时只加一行
数据，而不是再抄一遍用例。

`pnpm-lock.yaml` 只有 `@google/genai` 三条：importer 的 specifier/version、包的
resolution、snapshot 的键。`protobufjs` 的 override 仍是 7.6.6：3.0.0 把它自己的声明
从 `^7.5.4` 抬到 `^7.6.5`，3.3.0 没动这个范围，7.6.6 仍在其中，条件
（[runtime major bumps](../process/2026-10-27-runtime-major-bumps.md)）没有触发。

## Alternatives considered

- **把 `default` 分支改成 `return "error"`，删掉穷尽检查**：下一次 SDK 加枚举值时
  会静默走 `error`，compile 不再提醒我们判断这个新值该归哪一类。这次的
  `MALFORMED_RESPONSE` 恰好归 `error`，但 `CONTINUATION` 当初加进来时同样「恰好」——
  靠巧合不如靠编译器喊一声。
- **把 `reason` 收窄成 `FinishReason | string`，让未知值走 `error`**：等于同时放弃
  穷尽检查、并假装 SDK 会发枚举外的字符串。`candidate.finishReason` 的类型就是
  `FinishReason | undefined`，没有这条缝。
- **回头钉住旧版本或加 `ignoreDeps` 挡住 3.x**：这条升级没有真正的破坏面，
  挡它的代价是以后每次都得手工重估一次「3.0.0 到底坏不坏」，而且丢掉
  `MALFORMED_RESPONSE` 这条 provider 反馈。
- **在 `packages/ai` 里自己维护一份 `FinishReason` 副本做映射**：多一层翻译，
  且新值仍然需要在某处被分类——只是把编译错误换成了运行时静默。

## Consequences

- SDK 再扩 `FinishReason` 时会再一次编译红，位置仍是 `mapStopReason` 的 `default`。
  这是特性不是缺陷：那正是「有一个新原因需要我们决定怎么归类」的时刻。先例已经走过
  两次：2.31.0 加 `CONTINUATION`、3.0.0 加 `MALFORMED_RESPONSE`，3.3.0 一次加了四个。
  每次的改动量是一段 case 加测试里的一行数据。
- 3.3.0 另外把 `ThinkingLevel` 加了 `XHIGH`/`xhigh`。它不在这条编译红里：nanopi 的
  思考级别是 `minimal|low|medium|high|xhigh|max`，`ResolvedGoogleThinkingLevel` 显式排除
  `xhigh` 与 `max`，`clampThinkingLevel` 会先把模型不支持的级别降下来。内置目录里
  `gemini-4-hydrogen` 声明了 `xhigh: "xhigh"`，但 `usesGoogleThinkingLevel` 的 id 正则
  不认 `gemini-4-*`，所以它走的是 `thinkingBudget` 那条；这条错配在这次升级之前就有，
  与 SDK 版本无关，别把它算进这次的破坏面。
- `MALFORMED_RESPONSE` 走 `error` 之后，`isTerminalFinishReason` 不认它：
  `NON_RETRYABLE_FINISH_REASON_PATTERN`（`packages/ai/src/utils/retry.ts`）里列的
  Google 值是 `SAFETY` / `BLOCKLIST` / `PROHIBITED_CONTENT` / `SPII` / `RECITATION` /
  `IMAGE_SAFETY` / `LANGUAGE` / `NO_IMAGE`。这不是「会重复打一次」：这条缺失不改变
  重试结果。`isRetryableAssistantError` 读的是 `errorMessage`，实测值是
  `Provider stopped with: MALFORMED_RESPONSE`，既不命中 `RETRYABLE_PROVIDER_ERROR_PATTERN`
  （`provider.?returned.?(?:an.?)?error` 要求 `returned`，这里没有），也不命中别处，
  所以判定为不重试，行为与把它加进 terminate 名单一致。缺的只是一层保险：将来某人给
  `RETRYABLE_PROVIDER_ERROR_PATTERN` 加一条能被这段文本命中的宽泛模式（例如裸
  `malformed`），畸形响应就会开始重试，而那时没有第二道闸。要补就补这条保险，
  不是补一个重复请求的漏洞。
- `pnpm run check` 与 `node ./test.mjs` 全绿：ai 1489、coding-agent 2619、agent 102、
  extra 134、webui 7。
