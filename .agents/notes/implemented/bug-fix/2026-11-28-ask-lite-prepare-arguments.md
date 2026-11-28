# Agent Note: ask-lite 在校验前解码双重编码的提问参数

Status: implemented

Ref: shinytale/agent/nanopi#885

## Problem

Issue #885 让 CodeBuddy 复核 ask-lite 与上游 `rpiv-ask-user-question` 的差距。逐条对比 2.16.0 的 fix 后，其余三项在本地没有对应路径，只有上游 #244 的参数解码对应一个真实缺口：部分工具调用解析器会把 `questions` 数组或数组元素序列化为 JSON 字符串。TypeBox 在 schema 校验阶段就拒绝字符串，工具入口的 `normalizeQuestionParams` 没机会运行，问卷打不开；恢复会话重放历史 tool call 时同样会踩到。

本地的 `prepareArguments` 钩子链是通的：`packages/agent/src/agent-loop.ts` 在校验前调用它，`packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` 会透传模块工具的这个字段。缺的只是 ask-lite 自己没有提供该钩子。

## Decision

在 `packages/coding-agent/src/modules/ask-lite/tool/normalize-params.ts` 加入 `prepareQuestionArguments`，并在 `registerAskUserQuestionTool` 上注册为 `prepareArguments`：

- 只在数组/对象位置解码字符串。`questions` 解析为数组才替换；每个元素和 `options` 元素解析为对象才替换。解析失败或形状不符时原样返回，让 schema 校验继续报告真实错误。
- 不递归到字符串字段内部，不动 `preview` 等富文本；这样 malformed JSON 不会被误当成合法问题内容。
- 既可处理整个 `questions` 是 JSON 字符串、也可处理单个 question/option 是 JSON 字符串，覆盖上游 #244 描述的两种形态。
- 位于 `normalizeQuestionParams` 之前：先恢复结构化参数，再做 CR/LF 清洗和校验。

## Alternatives considered

- **整包升级到上游 2.16.0**：上游包已迁移到 `@earendil-works/pi-coding-agent`，并带 reconcile、blocked/answer 事件、transcript renderer 等本地明确不跟的交互改动（见 [ask-lite 不跟随上游的六条交互改动](../../rejected/feature/2026-11-03-ask-lite-upstream-gaps-we-do-not-pick.md)）。逐条 pick 只补本地存在的缺口。
- **在 `execute` 入口解码**：schema 校验发生在 `execute` 之前，字符串数组此时已经被判为非法，来不及。必须用 host 提供的 `prepareArguments` 钩子。
- **无条件 `JSON.parse` 所有字符串字段**：`question`、`label` 等合法文本本身可能长得像 JSON；只按结构位置解码，并校验解析结果形状，避免把普通文本改写。

## Consequences

- 恢复会话或 vLLM/LiteLLM 工具调用重放时，双重编码的 `questions` 在校验前被还原，问卷正常弹出；合法参数保持同一对象引用，非法输入仍由原校验给出错误。
- `packages/coding-agent/test/ask-lite-normalize-params.test.ts` 覆盖整体 `questions`、元素、`options` 三层的字符串化，以及合法/no-op 与 malformed JSON 的透传。
