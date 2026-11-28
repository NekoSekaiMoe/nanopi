# Agent Note: 图像输出 token 分桶计价

Status: implemented

Ref: shinytale/agent/nanopi#893

## Problem

OpenRouter 的图像响应把 `completion_tokens` 拆成图像、文本、推理三类，但本地 `Usage` 只有总数。旧 `openrouter-images.parseUsage()` 自己按 `model.cost.output` 乘总输出，并把 catalog 的 `completion` 写成同一个文本费率。Gemini 3.1 Flash Image 一类模型的图像费率是文本费率的 20 倍，一次生成被低估；FLUX 等 `completion=0` 的纯图像模型则完全不计费。历史 usage 的 `cost` 落盘后还会经 `/token-usage`、`usage-totals` 和各种导出被读出来，因此错误会一直留在账面上。

同时 `ImagesOptions` 只有 `metadata`，`generate_image` 工具只能把比例和分辨率写进 prompt，无法使用 OpenRouter 的 `image_config`。

## Decision

`Usage.imageOutput` 是 `output` 的子集，跟 `reasoning` 一样只在 provider 明确上报 `completion_tokens_details.image_tokens` 时写入；未上报时保持 undefined，避免把「没有拆分」误说成「没有图像 token」。`openrouter-images.parseUsage()` 同时读 `reasoning_tokens`，随后统一调用 `calculateCost()`，再由 `applyOpenRouterReportedCost()` 决定最终账单值。

`ModelCost.imageOutput` 是 USD/百万 token 的图像输出费率，只挂在模型上、不进按输入长度划分的 tiers：OpenRouter 的 `image_output` 是输出费率，不会跟 prompt-length override 联动。`calculateCost()` 用 `min(output, imageOutput ?? output)` 取图像 token 数：显式拆分时文本/推理按 `output` 费率，图像按 `imageOutput`；没有拆分时全部输出按图像费率，避免低估；模型没声明 `imageOutput` 则退回原来的文本费率。`costRevision()` 把 `imageOutput` 纳入哈希，价目变更后历史快照的 revision 随之变化。

catalog 生成时只有图像条目读 `image_output`（`openRouterImageCost()`），chat 条目的 cost 保持原样。`models.json` 的 model override 和 `models.schema.json` 同样支持该字段。`combineUsage()` 合并 `imageOutput`，`durable` 包已删除，不需要额外的 harness 改动。

`ImagesOptions.aspectRatio` / `size` 以原值转发到 `image_config.aspect_ratio` / `image_config.image_size`；`generate_image` 工具把两个可选参数透传给 provider。值不做枚举校验：各模型支持的取值不同，本地校验只会比 provider 的报错更早过时。

## Alternatives considered

- **继续在 `parseUsage()` 里手写乘法**：只要新增一项拆分或 tier，就要在每个 provider 适配层重复一遍费率逻辑；本地 chat 路径已经统一走 `calculateCost()`，图像路径没有理由例外。
- **把图像 token 从 `output` 中减掉**：`output` 的语义是 provider 上报的 completion token 总数，改变它会破坏 token 计数、压缩阈值和既有 session 的含义；子集字段才是本地对 `reasoning` 已经采用的契约。
- **把 `imageOutput` 费率塞进 `tiers`**：OpenRouter 的 prompt-length override 只覆盖 prompt/completion/cache 价格，图像费率不随输入长度变化；放到每一档会复制同一数值并制造错误的语义。
- **在 `generate_image` 工具里校验比例和分辨率取值**：合法集合由模型决定且随 provider 更新，硬编码枚举会挡住新值；透传后由 provider 明确拒绝更诚实。

## Consequences

- 纯图像模型即使 `completion=0`，只要 catalog 带 `image_output`，`usage.cost.total` 也大于 0；provider 明确上报 `cost` 时仍以账单为准并保留 `totalFromProvider`。
- `Usage` 与 `ModelCost` 是公开类型，新增字段是可选属性；历史 usage 没有 `imageOutput` 时按文本费率解释，cost 不回退成 0。
- `cost.imageOutput` 只在图像模型的 catalog 条目上生成；用 `models.json` 手动配置图像模型时，也需要显式写出该字段才能享受图像费率。
- 回归测试在 `packages/ai/test/openrouter-images.test.ts`、`packages/ai/test/image-model-data.test.ts`、`packages/ai/test/models-runtime.test.ts`、`packages/coding-agent/test/pi-image-tool.test.ts` 和 `packages/coding-agent/test/usage-pricing-snapshot.test.ts`。
