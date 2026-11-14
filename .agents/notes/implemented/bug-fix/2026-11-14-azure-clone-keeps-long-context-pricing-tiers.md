# Agent Note: Azure 克隆保留长上下文档定价，并补上 GPT-6 系列的 1.05M 窗口

Status: implemented

## Problem

`packages/ai/scripts/generate-models.ts` 的 Azure 派生是「照抄 OpenAI 的
`openai-responses` 模型，再逐字段挑要改的」，挑的时候把 `cost.tiers` 落下了：

```ts
cost: {
    input: model.cost.input,
    output: model.cost.output,
    cacheRead: model.cost.cacheRead,
    cacheWrite: model.cost.cacheWrite,
},
```

`withOpenAiLongContextPricing` 给出的 272k 档（input ×2、output ×1.5）在 Azure 侧
直接消失。叠加 `AZURE_CONTEXT_WINDOW_OVERRIDES` 之后，问题从「少一条元数据」变成
「记错账」：Azure 的 `gpt-5.4` / `gpt-5.5` / `gpt-5.6-*` 窗口是 1050000，但
`calculateCost` 找不到匹配档位，272k..1.05M 的输入全部按短档单价计。

同时 `AZURE_CONTEXT_WINDOW_OVERRIDES` 自己只覆盖到 `gpt-5.6-terra`，`gpt-6-astra` /
`gpt-6-sol` / `gpt-6-luna` / `gpt-6.1-sol` 落回 OpenAI 直连的 272000，而 models.dev
的 azure 条目里这四个都是 `context: 1050000`。

## Decision

两处都改在生成器里：

- 删掉那个手工重建的 `cost` 字面量，让 Azure 克隆直接继承 OpenAI 侧带 tiers 的
  `cost`。tiers 的绝对数值与 models.dev 的 azure 条目逐条对得上（`gpt-5.4` 5/22.5、
  `gpt-6-astra` 20/75、`gpt-6.1-sol` 4/15 等），不需要额外改写。
- `AZURE_CONTEXT_WINDOW_OVERRIDES` 补上四个 GPT-6 型号的 1050000。

窗口和档位必须一起改：只放宽 `contextWindow` 而不带 tiers，等于让 272k..1.05M
按短档单价计费；只带 tiers 不放宽窗口，档位永远够不到，等于没改。

## Alternatives considered

- **保留 `cost` 字面量，只往里加 tiers**：否。重建字面量的唯一理由本来是「Azure 的
  价格可能和 OpenAI 不同」，但 models.dev 的 azure 与 openai 条目在这些型号上
  `input` / `output` / `cache_read` / `cache_write` / `tiers` 完全一致，深拷贝一份只会
  在下一次 OpenAI 侧调价时重新漂移。
- **用 `structuredClone(model.cost)`**：否。浅展开已经够，多一层克隆只是噪音。
- **给 `gpt-6.1-terra` 也加 override**：不需要，它本来就在 1050000。
- **同时把 Codex（`openai-codex-responses`）的 `gpt-6.1-sol` 提到 500k**：
  否，那是另一个决定。500k 没有任何数据源（models.dev 报的是 1050000，Codex 侧只有
  「观察到的服务端行为」），而 `withOpenAiLongContextPricing` 的 `inputTokensAbove`
  固定在 272000，等于 272k..500k 按 2 倍 input 计费。没有实测证据就不动。

## Consequences

- Azure 上超过 272k input 的请求开始按长档计价，footer 与 `/cost` 不再低报。
- `packages/ai/test/azure-long-context-pricing.test.ts` 钉住两件事：四个 GPT-6 型号的
  Azure 窗口是 1050000 而 OpenAI 直连仍是 272000；`calculateCost` 在 200k 走短档、
  400k 走长档。
- OpenAI 直连的 272k 上限（`OPENAI_SHORT_CONTEXT_CAPPED_MODEL_IDS` 那套价格闸门）
  不受影响，用户仍可用 `modelOverrides` 自行放宽。
