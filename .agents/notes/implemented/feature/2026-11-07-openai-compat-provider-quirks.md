# Agent Note: 自建 endpoint、OpenRouter 与 xAI 的请求字段按 vendor 语义分开

Status: implemented

## Problem

对照 omp 的 `docs/provider-quirks.md` 扫 nanopi 的 compat 层时，发现三类同源的错：
`detectCompat`（`packages/ai/src/api/openai-completions.ts`）把「不是已知厂商」一律当作
OpenAI 官方语义，而 OpenAI 官方语义里那几个字段恰好是别人拒绝的。见 shinytale/nanopi#580。

三个具体症状，都是跑 mock chunk 实测的：

1. **loopback 上的推理服务器收到 OpenAI 专有字段。** baseUrl 是 `http://localhost:11434/v1`
   这类自建地址时，`isNonStandard` 为 false，于是请求里带上 `store: false`、
   `max_completion_tokens` 和 `reasoning_effort`（模型 `reasoning: true` 时）。
   部分 vLLM 版本对 `store` / `reasoning_effort` 直接 400。
2. **OpenRouter 永远带输出上限，把备用上游过滤掉。** `buildBaseOptions`
   （`src/api/simple-options.ts`）总把 `model.maxTokens` 填进 `options.maxTokens`，
   `buildParams` 于是总发 `max_completion_tokens`。OpenRouter 按这个值剔除
   max output 更低的上游 —— 正好废掉用户配的 `openRouterRouting.order` 备份链。
3. **xAI 的 prompt cache 头发错了。** `createClient` 只认
   `openai` / `openai-nosession` / `openrouter` 三种 affinity 格式，xAI 收到的是
   `session_id` + `x-client-request-id`，而它按 `x-grok-conv-id` 路由。同一会话的请求
   落到不同副本，缓存命中率掉。

## Decision

三个字段各自按 vendor 语义分开，不改 wire 契约、不加新 API 层。

**自建 endpoint 走保守组合。** `src/utils/endpoint.ts` 的 `isSelfHostedEndpoint(baseUrl)`
判定「用户自己跑的机器」：loopback 主机名、`.local`、RFC 1918 私网 IPv4、link-local。
命中即并入 `isNonStandard` 与 `useMaxTokens`，于是 `supportsStore: false`、
`maxTokensField: "max_tokens"`、`supportsReasoningEffort: false`（同时排除 Cerebras，
它也不认这个字段）。运行时 `detectCompat` 和生成器
`packages/ai/scripts/generate-models.ts` 的 `detectOpenAICompletionsCompat` 都调同一个 helper —— 这两份
是手工同步的拷贝（#580 第五节也点了这个漂移），至少判定逻辑不再分叉。

**OpenRouter 只发调用方显式要求的输出上限。** `buildBaseOptions` 里新增
`resolveBaseMaxTokens`：OpenRouter 且调用方没给 `maxTokens` 时返回 `undefined`。
`OpenAICompletionsOptions.implicitMaxTokens` 标记「这个 `maxTokens` 是 catalog 推出来的」，
`buildParams` 看到标记就不发字段，但 `resolveClampedThinkingBudget` 仍拿它当思考预算的
天花板（此时退回 `clampMaxTokensToContext(model, context, model.maxTokens)`）。
Anthropic 不受影响：它 `max_tokens` 必填，`buildParams` 本来就有 `?? model.maxTokens` 兜底。

**xAI 用自己的会话头。** `sessionAffinityFormat` 联合类型加 `"xai"` 字面量，两个 adapter 在
匹配时发 `x-grok-conv-id` 且只发这一个。Responses 侧由
`detectSessionAffinityFormat` 从 `provider === "xai"` / `api.x.ai` 自动推出；生成器里
`XAI_RESPONSES_COMPAT` 显式写 `sessionAffinityFormat: "xai"`，completions 侧
`detectCompat` 让 `isGrok` 同时打开 `sendSessionAffinityHeaders`。

## Alternatives considered

- **把 `models.json` 的 `api` 默认改成保守值**：#580 提的另一条路。这会把「自建服务器
  该不该收 OpenAI 字段」这个判断推给用户配置，而绝大多数自定义 endpoint 就是本机
  vLLM / Ollama。host 判据不需要用户做任何事，且能覆盖经 `models.json` 添加的自建地址。
- **逐 provider 的规则表（omp 的 `rules/providers/*.kdl`）**：#580 第四节已否。
  分类器 + 级联覆盖会把 634 行的 `detectCompat` 变成 2000 行，收益只是覆盖更多厂商。
- **给 `maxTokens` 加一个「这是 catalog 默认」的独立字段，而不是 `implicitMaxTokens` 布尔**：
  独立数值字段会和真实调用方的上限互相覆盖，语义反而更绕。布尔标记只回答「要不要发」，
  天花板仍取 `maxTokens`。
- **在 OpenRouter 侧完全不发 `max_tokens` 也不做天花板计算**：思考预算会失去上限，
  `thinkingBudgetForLevel("high")` 就是 16384，可能超过模型实际允许的输出。
- **xAI 保留 OpenAI 那组头、额外补 `x-grok-conv-id`**：多发无意义的头不会帮上忙，
  而且 `session_id` 在 xAI 侧的含义未定义，发出去只是噪音。
- **顺手把 `detectCompat` 和生成器那份合成一个函数**：#580 第五节建议单独开 issue。
  本次只抽出 `isSelfHostedEndpoint` 这一块共享判定，合并整份仍是独立工作。

## Consequences

- 自建 endpoint 的行为变化：不再收到 `store` / `reasoning_effort` / `max_completion_tokens`，
  改发 `max_tokens`。`stream_options.include_usage` 保留（本地服务器普遍支持）；
  Cerebras 例外，它的 `supportsUsageInStreaming` 现在为 false。
- OpenRouter 默认请求里不再有输出上限，备用上游因此不会被过滤。代价是模型只能靠
  自己的默认输出长度，调用方要给上限得显式传 `maxTokens`。缓存预热传的是 `maxTokens: 1`，
  属于显式值，不受影响。
- `implicitMaxTokens` 是 `OpenAICompletionsOptions` 上的可选字段，`StreamOptions` 面没变。
  只有 `streamSimple` 会设置它。
- catalog 产物随生成器变化：`xai.json` 的 models 多出 `sessionAffinityFormat: "xai"`，
  `cerebras.json` 多出 `supportsUsageInStreaming: false` 与 `supportsReasoningEffort: false`。
  这些文件是 gitignore 的构建产物，`packages/coding-agent/schemas/models.schema.json`
  则要跟着 `npm run generate:schemas` 重新生成并提交。
- 覆盖：`packages/ai/test/openai-completions-request-fields.test.ts` 跑 7 种私网/loopback 地址断言三个
  字段都不发、公开地址仍发、OpenRouter 无显式上限时不发字段但有上限时照发、思考预算
  仍在模型上限内；`packages/ai/test/xai-responses.test.ts` 断言两个 adapter 都只发 `x-grok-conv-id`。
