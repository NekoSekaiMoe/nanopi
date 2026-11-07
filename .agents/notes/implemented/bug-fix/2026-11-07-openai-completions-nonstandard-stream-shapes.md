# Agent Note: openai-completions 修掉三种非标准流形态

Status: implemented

## Problem

`api/openai-completions.ts` 的流解析循环按 OpenAI 官方 wire 契约写死，对三种
真实存在的后端变体没有防线，后果都不是报错，而是**静默产出错误内容**：

- `delta.content` 是 parts 数组（`[{type:"text",text:"..."}]`，Mistral Medium 这类）。
  旧代码 `block.text += choice.delta.content` 直接拼数组，用户拿到的是
  `"[object Object]"`，模型输出全毁。
- `function.arguments` 是 JSON 对象（MiniMax 一类）。旧代码当字符串拼，`partialArgs`
  变成 `"[object Object]"`，`parseToolCallArguments` 给出 `argumentsError`，
  工具参数为空——调用整个失效。
- 续传 chunk 既无 `index` 也无 `id`。`ensureToolCallBlock` 先按 `index`、再按 `id`
  查块，两者都缺就 `blocks.push` 一块新的：一个逻辑调用被拆成两块，第二块
  `name` 为空、参数只剩残尾。

三种都只影响解析，不影响 wire 契约，所以不需要新的 compat 字段。

## Decision

- `normalizeStreamingContentText`：接受 `string | parts[]`，数组里取 `type` 缺失或
  为 `"text"` 的 `text` 字段拼接，其它形态返回空串。文本 delta 与 `block.text`
  共用这一个结果，保证 `text_delta` 的累计和最终块一致。
- `mergeStreamingArgumentObject`：对象形态的 arguments 递归合并进
  `block.arguments`，并把合并后的 JSON 写回 `partialArgs`，让"流式 delta 文本"
  与"最终解析结果"仍是同一份数据。
- `lastToolCallBlock` 指针：`index` 和 `id` 都缺失的 chunk 续接到上一块，除非它
  自报的 `name` 与上一块不同（那说明是新调用）。`streamIndex` 后来补齐时照旧
  登记进 `toolCallBlocksByIndex`。

## Alternatives considered

- **给三种变体各加一个 compat 开关**：语义上更"显式"，但这些形态没有厂商边界
  （同一家不同模型都可能变），开关只会在 `detectCompat` 和生成器两处再漂一次，
  而规范化本身对标准形态是恒等变换。
- **对象形态 arguments 直接 `JSON.stringify` 当字符串续接**：会把两个对象拼成
  `{...}{...}` 这种非法 JSON，最终还是 `argumentsError`。
- **缺 `index` / `id` 时用"同一 chunk 内的顺序"推断块**：`index` 缺失时 chunk
  内的位置并不表示逻辑调用的顺序（一条 chunk 常常只带一个续传片段），推断不出
  比"上一块"更强的信息。

## Consequences

- 收益：三类后端从"静默错误输出"变成正确解析，无需改配置；`text_delta` /
  `toolcall_delta` 的事件流对下游（`assistant-message-frame`、webui）保持原语义。
- 代价：`lastToolCallBlock` 是一个跨 chunk 的隐式状态。如果某后端在同一轮里用
  完全相同的工具名发两个都不带 `index`/`id` 的调用，两次会被并成一次——这种
  形态没有可用的区分信息，接受合并而不是猜。
- 回归测试在 `packages/ai/test/openai-completions-nonstandard-stream-shapes.test.ts`。
