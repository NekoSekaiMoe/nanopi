# Agent Note: 把 system prompt + 工具声明压到 5k token 量级的预算里

Status: implemented

## Problem

Issue #352 给的预算：system prompt 与工具声明合计约 5k token（可浮动到 5.1k），
且不能影响工具调用。默认全模块构建的实测（20 个工具、chars/4 口径）：

- 工具声明（wire 形式）17889 字符，约 4473 token
- system prompt 5841 字符，约 1461 token
- 合计 5934 token

超出预算约 830 token。上一轮（[tool-prompt-duplicate-trim](2026-10-27-tool-prompt-duplicate-trim.md)）
已经把"同一句话说两遍"清掉了，剩下的是**同一件事实写在了它不会被用到的位置**：
选工具的模型读 `<rules>`，构造参数的模型读 schema，而两边都被塞了对方的活。

## Decision

按"读者是谁"划分三类，各自只写自己需要的：

- **声明（`description`）写"怎么调用"**：参数语义、动作分支、输出形状。
- **`promptGuidelines`（进 `<rules>`）写"什么时候选它、跟谁竞争"**。
- **`promptSnippet`（进 `<tools>`）一行，不重复 description 的细节**。

具体落点：

- **`<tools>` 的 snippet 只留名字**：`grep`/`find` 的 "respects .gitignore" 与
  "by glob pattern" 在 description 里已有；`ask_user_question` 不再复述
  1-4 题/2-4 选项。
- **`read` tool 的 guideline 删掉**（"Use read to examine files instead of cat or
  sed"）。它和 `buildRules` 里那条偏好规则（"Prefer read for file contents …
  over shell equivalents (cat, …)"）是同一件事，后者还更完整。
- **`edit` 两条 guideline 并一条**，description 里的"donot pad oldText with large
  unchanged regions"与 `oldText` 参数的描述重复，删掉。
- **`bash` 那条 pipeline 规则压缩**：删掉 "Run it bare"（后半句的截断说明已经
  表达了同一件事）。
- **`web_search`/`read_page` 的 description 去掉引擎链的枚举**（那属于配置与
  诊断细节，不是构造调用需要的信息），"不要凭记忆回答、读返回的条目"那条并进
  guideline。
- **`mcp` 三条 guideline 并两条**：`args` 原样透传已经从参数描述里读得到。
- **`todo` 的 description 改写成动作表 + 一条消歧句**：原来那条"弱模型正例"
  段落被删掉之后，仍要保证 add 用 `texts`、delete 用 `ids` 不被写错，所以保留
  一条 `add takes texts and delete takes ids, never a singular text/id`。
- **system prompt**：preamble 去掉"你帮我读文件/跑命令/改代码/写文件"（工具
  列表就在下面）；`<docs>` 的标题句压成一行、三条路径并一行；偏好规则与
  "Be concise / Show file paths clearly" 两条各自压缩。

## Consequences

同一套真实模块注册（`createHarnessWithExtensions` + 全部 `BUILTIN_MODULES`），
chars/4 口径（与 `/context` 命令一致）：

- 工具声明 17889 → 17058 字符（4473 → 4265 token）
- system prompt 5841 → 5300 字符（1461 → 1325 token）
- 合计 5934 → 5590 token，落到 5k 线上浮 10% 以内

`node ./test.mjs` 全绿（323 文件 / 2473 用例），`pnpm run check` 全绿。
`test/system-prompt.test.ts` 与 `todo-lite` 的 prompt 回归测试跟着新文案改：
断言从"完整 JSON 正例"改成"每个 action 的字段形态"，因为 description 不再给
正例，消歧这件事改由那一条 never 句子承担。工具调用行为没有变化：被删掉的每
一条都是另一处已经写过的同一事实，schema 与 `execute` 一律未动。

## Alternatives considered

**继续按"删废话"的方向压。** 上一轮已经把这类目标清完了，剩下的重复是结构性的
（同一事实服务两个读者），再删就会真的丢信息：比如 `subagent` 的 `dependsOn`
规则（约 230 字符）是参数描述表达不了的时序约束，`bash_bg` 的 description 是
六个 action 的说明书。否掉。

**按需加载工具：默认只声明常用工具，其余走 `prepareLoadout`。** 省得更多（能
省掉 `subagent`+`bash_bg` 那 5000 字符里的大头），但代价是模型看不到工具就
不会用，`lsp_`/`subagent` 这类要"想起来才有用"的工具会退化成摆设。用户的前提
是"不影响工具调用"，否掉。

**把 `<tools>` 列表整个删掉，只留声明。** 省 1144 字符。否掉：声明是模型主动
去想"有没有合适的工具"时才读的，`<tools>` 是那之前的一览表；删了就只剩
description 里的名字，等于让模型先猜。

**给 `estimateTokens` 加一条工具声明口径并写进 `/context`。** 这是观测手段，
不是这次的目标；`/context` 的 tools 一栏已经单独统计，保持现状。
