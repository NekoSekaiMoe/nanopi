# Agent Note: 上下文估算改用 o200k 原生 token 计数

Status: implemented

## Problem

nanopi 的两套上下文估算都靠字符除以常数：`packages/ai/src/utils/estimate.ts` 的
`CHARS_PER_TOKEN = 3.5`、`packages/coding-agent/src/core/messages/builtin-codecs.ts`
的 `charsToTokens = ceil(chars/4)`，以及 `packages/coding-agent/src/core/compaction/compaction.ts`
里每个 core role 的 `Math.ceil(chars / 4)`。这个比例对英文散文大致准，对代码、JSON 工具参数
和中日文严重低估：本机实测同一段中文 chars/4 算 190、o200k 算 480（2.5 倍），日文 2.8 倍，
JSON 1.2 倍。低估的直接后果是 compaction 触发太晚——会话从英文模型切到 tokenizer 更密的
模型后，`shouldCompact` 以为还有余量，直到 provider 以 context overflow 拒绝请求才被动压缩。
`max_tokens` 的 clamp 也用了同一个估值，把偏小的输入当成安全。

上游 oh-my-pi 在 agent 18.16.0（PR #17607）把估算切到原生 tokenizer，并在 changelog 里点名
了这两个症状。issue #763 把它列为第一梯队第一项。

## Decision

引入 `gpt-tokenizer@4.1.2`（MIT，纯 JS，无 wasm），用它的 o200k_base 编码作为所有本地 token
计数的统一实现。计数函数放在 `packages/ai/src/utils/text.ts`（`countTextTokens` /
`countTokenFragments`），带 512 条、单条上限 16KB 的 LRU，短文本复用、长文本直接计数。

- `estimate.ts` 的 `estimateTextTokens` / `estimateMessageTokens` 改用上述函数。assistant 消息
  只计 text、thinking、toolCall 的 name 与 arguments；`thinkingSignature` 和 redacted thinking
  的 opaque payload 不计——请求在换模型回放时会剥掉别家模型签名的其余部分，按本地字节数收费
  等于向读者收它根本看不到的文本（对应上游 #17607 的第二处修复）。图片块保留固定 1200 token
  的占位费，因为本地 tokenizer 无法数图。
- `compaction.ts` 的 `estimateTokens` 同样切到 o200k；`builtin-codecs.ts` 的三个内置 codec
  （bashExecution / branchSummary / compactionSummary）也改为对原文计数，不再走字符数。
  保留 `charsToTokens` 导出，供已经只拿到字符数、拿不到原文的调用方兜底。
- `INPUT_HEADROOM = 1.15` 保留，语义从「弥补 chars/constant 低估」改为「吸收 provider 的
  framing token（角色标记、工具 schema、reasoning 回放）」。它不再是估值的一部分。

o200k_base 不是每个 provider 的真实编码，但它是 OpenAI 从 GPT-4o 起计费的编码，对未知家族
（Gemini、Grok）比 chars/4 更接近真实账单。provider 上报的 usage 一旦可用仍然是权威值，
本地计数只负责 usage 之后的尾部消息（见 `getLastAssistantUsageInfo` 的锚定逻辑，未改动）。

## 为什么不用上游的原生 tokenizer

上游的 `Tokenizer` 类依赖 `@oh-my-pi/pi-natives` 这个 Rust/napi addon，外加 pi-catalog 的
tokenizer family 解析、snapcompact 的 frame billing、以及一整套 thinking-replay compat。
nanopi 没有这些子系统和构建链，照搬等于引入一个新的 native 依赖和几十个文件的契约面。
o200k_base 的纯 JS 实现拿到上游声称的绝大部分收益（修掉 chars/constant 低估），代价只是一个
MIT 运行时依赖。

## Consequences

- 所有走估算的阈值都变了：`max_tokens` clamp、compaction 触发、prompt budget pin。
  `packages/ai/test/context-estimate.test.ts` 断言的 3500 个 x 从 1000 降到 438 token，
  但中文/JSON 等真实内容的估值上升——这正是修复方向。
- `packages/coding-agent/test/sku-prompt-budget.test.ts` 的 PINNED 从 405/1540 更新为
  318/1226；这是一次**估算器换代**导致的读数变化，不是 prompt 或 schema 涨价，
  与 `.agents/notes/rejected/testing/2026-11-10-no-dynamic-prompt-budget-pin.md` 的
  「钉值保持字面量」决定不冲突。
- 多个 compaction/harness 测试用重复字符撑起 token 阈值，按 chars/4 的放大系数构造。
  换代后这些 fixture 不再越界，按各字符在 o200k 下的实测密度调大了重复次数
  （如 `x` 的密度是 chars/4 的 2 倍）。测试意图未变。
- 冷启动多了一次 o200k 编码表的加载（约 125ms）；单次短文本计数 0.03ms 量级，
  处在热路径上但有 LRU 兜底。
- 每次 provider 上报 usage 后的尾部消息仍逐个计数；一个很长的新消息（>16KB）不走缓存，
  按字节长度线性计费。

## Alternatives considered

- **照搬上游 `Tokenizer` + 引入 pi-natives addon**。最强理由：原生计数按每个模型家族选编码，
  比统一 o200k 更准，且上游把 thinking replay 的计费也算进去了。否决：它绑着 nanopi 没有的
  Rust 构建链、catalog tokenizer family 和 snapcompact，硬搬会把整个 provider compat 体系拖进来。
- **保留 chars/4、只把常数调大**。最强理由：零新依赖、零行为风险。否决：单一常数无法同时
  服务英文、代码和 CJK——放大到覆盖中文会让英文散文高估 2 倍，反而让 compaction 提前误触发；
  低估的根因是「字符数不是 token 数」，调参治标不治本。
- **用 `tiktoken` npm 包**。最强理由：OpenAI 官方编码，社区认知度高。否决：它需要下载/打包
  wasm 或原生 binding，`gpt-tokenizer` 是纯 JS、体积可控，且同样产出 o200k_base。

## Verification

- `pnpm run check`：全绿（含 entry-graph 预算、typecheck、biome）。
- `node ./test.mjs`：全包全绿（ai 1566、coding-agent 2857 通过）。
- 新增回归 `packages/ai/test/context-estimate.test.ts`：中文文本估值 480，且严格大于 chars/4
  的读数，直接锁住「CJK 不再被低估」这一不变量。
