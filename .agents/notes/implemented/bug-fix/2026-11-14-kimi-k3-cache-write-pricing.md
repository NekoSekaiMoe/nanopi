# Agent Note: Kimi K3 的 cacheWrite 按 $3/MTok 计，不再当 0

Status: implemented

## Problem

`packages/ai/scripts/generate-models.ts` 把 Kimi K3 的成本写死成常量
`KIMI_K3_COST`，其中 `cacheWrite: 0`，旁边还有一句注释断言
「Moonshot does not bill cache writes; models.dev lists the input rate as
cache_write for Kimi K3」。这条断言是错的：Moonshot 确实对 prompt cache 写入
按 5 分钟档收 $3/MTok（1 小时档 $6/MTok），和 input 同价只是数值巧合。

后果不是账面数字难看，而是两处运行时估算被带偏：

- `packages/coding-agent/src/core/cache-warmer.ts:385` 用
  `model.cost.cacheWrite > 0` 决定「重放 prompt 记成 cacheWrite 还是 input」。
  写成 0 时预热一律按 input 记账。
- `packages/coding-agent/src/core/cache-stats.ts:77` 用
  `(cost.input + cost.cacheWrite) / (input + cacheWrite)` 算实际付费单价，
  分子缺了 cacheWrite 那一段。

`KIMI_K3_COST` 同时被 `moonshotai` 的 `kimi-k3` 和 `kimi-coding` 的 `k3`
（订阅版的「等价 API 价值」估算）引用，一处改动两边一起对齐。`kimi-k3.1-pro`
走通用 models.dev 路径，拿到的 cacheWrite 本来就是 2，不受影响。

## Decision

`KIMI_K3_COST.cacheWrite` 从 `0` 改成 `3`，并删掉那句错误注释。

数值取 5 分钟档，因为我们只发默认档：`getPromptCacheOptions` 只在
`supportsExplicitPromptCacheMode` 时下发 `prompt_cache_options`，Kimi 走
`openai-completions`，不在这条路径上。1 小时档（$6）不参与计价。

改的是生成器，不是生成物 —— `packages/ai/src/models.generated.ts` 一类的
shard 每次构建重写且被 gitignore，永远改脚本。

## Alternatives considered

- **维持 0，等官方账单**：否。上一轮的顾虑是「models.dev 的 cache_write 可能只是
  抄了 input 价」，但 models.dev 的 `moonshotai/kimi-k3` 条目注释直接引
  `platform.kimi.ai/docs/pricing/chat`，且官方 API 文档确认用量里有
  `prompt_tokens_details.cache_write_tokens` 字段 —— 字段存在，就不可能不收钱。
  两个一手来源互证之后，等账单只是拖延。
- **写成 1 小时档的 6**：否，见上，我们不投递 `prompt_cache_options`。
- **只改 moonshotai，把 kimi-coding 的订阅估算留在 0**：否。订阅版的「等价值」
  本来就该按 API 实际计价算，两边用同一个常量正是为了不让它们漂移。
- **顺手把 `kimi-for-coding*` 几条的 cacheWrite 也改掉**：否，那是另一个问题。
  它们的 0 同样可疑，但没有对应的官方价位出处，不动。

## Consequences

- Kimi K3 的预热收益和 cache 命中单价估算不再偏高；`cache-warmer` 现在会把
  重放的 prompt 记成 cacheWrite。
- `packages/ai/test/providers.test.ts` 里两处断言（`moonshotai/kimi-k3` 与
  `kimi-coding/k3`）从 `cacheWrite: 0` 改成 `3`，钉住这个价位。
- 后续若要再加别的 Kimi 变体，先确认官方计价页的 5m / 1h 两列，别再凭
  「cacheWrite 等于 input」推。
