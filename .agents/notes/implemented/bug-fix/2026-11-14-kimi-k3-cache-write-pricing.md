# Agent Note: Kimi K3 的 cacheWrite 按官方 5m 档 $3 计，不再是 0

Status: implemented

## Problem

`packages/ai/scripts/generate-models.ts` 的 `KIMI_K3_COST` 把 cacheWrite 写成 0，旁边那行注释
写着「Moonshot does not bill cache writes; models.dev lists the input rate as cache_write」。
引的是上游 `at-inc/pi` 的说法（`6eb0867346`），我们跟着抄了结论，也没跟账单核过。

这个 0 不是无害的显示问题，它进了两处计算：

- `packages/coding-agent/src/core/cache-warmer.ts` 用 `model.cost.cacheWrite > 0` 决定「重放 prompt
  算 cacheWrite 还是 input」。0 让 Kimi K3 的预热一律按 input 价估。
- `packages/coding-agent/src/core/cache-stats.ts` 用 `(cost.input + cost.cacheWrite) / (input + cacheWrite)`
  算实际付费单价。分母里 cacheWrite 的权重被抹掉了。

两处都指向同一个方向：Kimi K3 的预热收益被算高。

## Decision

`KIMI_K3_COST.cacheWrite` 是 3，保留 input 3 / output 15 / cacheRead 0.3 不变，注释换成出处
`https://platform.kimi.ai/docs/pricing/chat`。

三个一手来源对上：

- Kimi 官方计价页的 kimi-k3 行是 `$3.00 / $15.00 / $0.30 / $3.00 / $6.00`，后两列是 5m / 1h 的
  cache write。5m 档就是 3。
- models.dev 的 `providers/moonshotai/models/kimi-k3.toml` 写 `cache = { read = 0.3, write = { "5m" = 3, "1h" = 6 } }`，
  注释直接引同一个官方页。它的值和官方价一致，不是把 input 抄过去。
- 官方 API 文档里 `prompt_tokens_details.cache_write_tokens` 确实存在，且
  `cached_tokens + cache_write_tokens + 未缓存余量 = prompt_tokens`。我们对这个字段的解析本来就是对。

取 5m 档而不是 1h，是因为 `getPromptCacheOptions` 只在 `supportsExplicitPromptCacheMode` 时下发
`prompt_cache_options`；Kimi 走 openai-completions，发的是默认 5m。要用 1h 得先有下发通道。

`KIMI_CODING_IMPLIED_COSTS.k3` 引用同一个常量，所以 kimi-coding 的 k3 自动跟着变成 3，不用改。
`kimi-k3.1-pro` 走通用 models.dev 路径，拿到的 cacheWrite 本来就是 2（等于它的 input 价），
和官方价对得上，不动。

## Alternatives considered

**维持 0，等 Moonshot 账单。** 最初的判断是「没有账单就不能推翻一条价格判断」。放弃的原因是
这轮找到了两个一手来源（官方计价页 + models.dev 的 toml 及其引文），它们互相独立且和官方 API
文档的用量字段自洽。账单只会再确认一次，不会推翻。

**取 1h 档 $6，或者做一个随 TTL 变化的 cost。** 放弃：我们发不出 1h 的请求，写 6 会让每一笔
缓存写入都被高估一倍。cost 是单一标量，按 TTL 分档需要在 cache-warmer 里换一套按档位取价的逻辑，
而所有 provider 里只有 Kimi 有这个需求。

**改成从 models.dev 直接读，删掉 `KIMI_K3_COST`。** 放弃：Moonshot 的 kimi-k3 条目里 cost 是全的，
但 kimi-coding（订阅制）那边 models.dev 报 0，`KIMI_CODING_IMPLIED_COSTS` 存在的理由就是补这个缺口。
删掉常量等于让订阅制那侧的估算归零。

## Consequences

代价是这个常量成了第二个需要跟官方计价同步的地方。`KIMI_K3_COST` 的注释现在写明了出处链接，
下次调价时改这里、改 `packages/ai/test/providers.test.ts` 的两条断言即可。

收益是 Kimi K3 的缓存预热收益和实际付费单价不再系统性偏高。`packages/ai/test/providers.test.ts`
的「uses official Kimi K3 pricing for Moonshot providers」和「uses API-equivalent implied pricing for
Kimi Coding subscription models」两条断言现在钉住 cacheWrite: 3。
