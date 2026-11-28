# Agent Note: Copilot reasoning_opaque 进入 openai-completions 回放链

Status: implemented

Ref: shinytale/agent/nanopi#894

## Problem

GitHub Copilot 的 `claude-opus-5.5` 在 `openai-completions` 上先流出 `reasoning_text` delta，再给一个 `reasoning_opaque` delta。原实现只处理 `reasoning_content` / `reasoning` / `reasoning_text` 三个文本字段，opaque 值直接丢弃；第二轮请求只回放文本，Copilot 以缺失 opaque 报错（上游 #12418）。

本地和上游还有一个结构差异：上游 `ede8bdca0` 把 reasoning 逻辑抽到 `openai-completions-reasoning.ts`，并把字段优先级从 `reasoning, reasoning_content, reasoning_text` 改成 `reasoning_content, reasoning, reasoning_text`。后者已经由本地 `4ca636c5e`、`7aab6c26e` 覆盖，直接套整包 diff 会覆盖既有行为。

## Decision

按上游形态落地 replay 数据抽象，但保留本地流式解析逻辑：

- 新增 `packages/ai/src/api/openai-completions-reasoning.ts`，提供 `decodeThinkingSignature` / `encodeThinkingSignature` / `resolveReasoningReplay` 的数据层对应物（解码、编码、legacy tool-call detail）以及字段常量。`thinkingSignature` 现在承载三种格式：裸字段名、OpenRouter `reasoning_details` 数组、`{"field","reasoning_opaque"}`；兼容旧会话已写入的两种格式。
- `openai-completions.ts` 在流式阶段记录最近一次 opaque 值和它绑定的文本字段名；任一 thinking block 结束时写入 signature。回放时 `reasoning_details` 优先于 opaque，opaque 优先于裸文本字段；opaque 单独到达时也只回放 opaque，不伪造 `reasoning_text`。
- 上游把 reasoning / opaque / details 的处理放在 content 之前，使混合 delta 中 thinking 块先于 text 块；本地把这段顺序同步过来，避免同一分块里 content 与 opaque 同时到达时块顺序反转。Opencode-go 的 `reasoning` → `reasoning_content` 映射保持本地行为。
- 回归测试落在 `packages/ai/test/openai-completions-reasoning-opaque.test.ts` 和 `packages/ai/test/openai-completions-reasoning.test.ts`；`packages/ai/test/openai-completions-tool-choice.test.ts` 的块顺序断言同步到上游期望。

## Alternatives considered

- **整包应用 `ede8bdca0`**：上游父版与本地流解析已经分叉（Mistral 文本数组、MiniMax 参数对象、本地重试和 SDK 形态等），整包 diff 会覆盖本地修复；只搬运 reasoning 数据层和必要调用点。
- **沿用裸字段名 signature 拼 JSON 字符串**：无法区分字段名、details 数组和 opaque 对象，也无法处理 opaque 无文本的情形；显式 tagged 格式可保持旧会话可读。
- **只把 opaque 塞进 `reasoning_details`**：Copilot 要求它作为顶层 `reasoning_opaque` 字段回放，结构不同。

## Consequences

- Copilot 多轮 tool call 不再因为缺 `reasoning_opaque` 被拒；其他 provider 的 `reasoning_details` / 裸字段回放路径保持原样。
- `thinkingSignature` 的 JSON 格式扩展为带 tag 的复用槽位；`openai-completions-reasoning.ts` 是回放数据的唯一解析入口。
- 混合 content + opaque delta 的块顺序改为 thinking 先于 text，与上游一致。
