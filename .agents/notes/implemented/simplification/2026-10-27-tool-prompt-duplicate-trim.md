# Agent Note: 工具声明与其 `<rules>` 规则的分工，去掉同一句话说两遍

Status: implemented

## Problem

Issue #347 的测量：默认全量模块下每个请求要付 18195 字符的工具声明和
7081 字符的 system prompt（约 4549 + 1770 tokens）。占大头的不是 schema，
而是同一件事被写了两遍。顺带一提，同一 issue 上先合入的 #350 已经把各处的
框架性废话（"whichever is hit first" 之类）压过一轮，这次动的是结构性重复，
两条线不重叠。

三处具体的重复，都是可数的字符：

- **`lsp_` 五个工具的 guidance 重复了五份。** `LSP_GUIDANCE` 那段
  （530 字符）被挂到 `lsp_diagnostics`/`lsp_hover`/`lsp_definition`/
  `lsp_query`/`lsp_edit` 每个工具的 `promptGuidelines` 里。`buildRules` 会
  按整串去重，所以渲染出的 `<rules>` 里它只出现一次——这正是
  [lsp-tools-lose-to-read](../bug-fix/2026-10-27-lsp-tools-lose-to-read.md)
  里"共享那条已是沉没成本"那句话的依据。但 `<rules>` 不是这些列表唯一的读
  者：`AgentSession.getAllTools()` 把它们原样交出去，任何读声明的路径都拿到
  五份。实测这五份一共 2650 字符，其中 4 份（2120 字符）是纯重复。
- **`subagent` 的 description 和 guideline 讲同一套语义。** description
  1355 字符里，`GOAL/CONTEXT/EXPECTED OUTPUT/STOP RULES` 那四行是父代理写
  brief 的格式（父代理读的是 `<rules>`，那里已经有一条同样的规则），而
  `dependsOn`/`isolated`/`onFailure`/`continue` 的语义在 guideline 里又说了
  一遍。真正只有子代理需要读的只有两件事：它是子代理，以及报告要什么形状。
- **`bash_bg` / `ask_user_question` / `mcp` 的 description 与 guideline 逐句
  重合。** `ask_user_question` 最典型：description 161 字符 + guideline 364
  字符，两者都说"1-4 个问题、2-4 个选项、可用 preview、一次调用问完"，唯一
  多的信息是 guideline 里的"推荐的选项放第一个并标 (Recommended)"。
  `bash_bg` 的 guideline 第 2 条整句只是把 description 的 `action=run` 语义
  再讲一遍。

## Decision

同一件事实只在**读它的那一方**写一次：

- **声明（`description`）写"怎么调用"**——参数语义、动作分支、输出形状。
  模型在构造调用时看这里。
- **`promptGuidelines`（进 `<rules>`）写"什么时候选它、跟谁竞争"**——路由。
  模型在选择工具时看这里。
- **跨工具的公共段落只挂一份**。`LSP_GUIDANCE` 留在 `lsp_diagnostics`（第一个
  注册的工具）的列表里，其余四个工具只留自己的那句话；共享句在 `<rules>` 里
  仍然只渲染一次。
- **`subagent` 的 brief 契约搬进 `task` 参数描述**：那是模型真正写下 brief
  的字段，四段格式就在输入框旁边。"子代理看不到这段对话"这句话合并进
  guideline 里已有的那条 brief 规则，删掉 description 里的重复。description
  只保留子代理视角的两件事（它是子代理 / 报告形状）加一行状态动作。
- 逐句重合的地方删掉较弱的那一份：`ask_user_question` 的 guideline 只留"什么
  时候别猜"，`mcp` 的 guideline 去掉与 description 重复的省略参数说明，
  `bash_bg` 的三条 guideline 并成两条（`action=run` 消歧的那半句并进第一条，
  轮询那条不变）。

## Consequences

同一套真实模块注册（`createHarness` + 全部 `BUILTIN_MODULES`）的实测。合并
#350 之后的基线是 17550 字符声明 / 6453 字符 prompt，落到：

- 工具声明 17550 → 17248 字符（~4388 → ~4312 tokens）。
- system prompt 6453 → 5840 字符（~1613 → ~1460 tokens）。
- 相对本次开工前的原始基线（18195 / 7081），合计少 2136 字符，约 530 tokens
  每请求；其中本 PR 承担的是 915 字符左右。

省下来的全是"同一句话"：没有一条规则的内容是新的，也没有一条语义被删掉，
`lsp_` 的四份重复与 `ask_user_question`/`mcp`/`bash_bg`/`subagent` 的重合句
加起来就是差额本身。剩下的大头是 `subagent`（description 678 + guideline
1001）和 `ask_user_question`（description 197 + guideline 197）。前者是四个
动作加五条路由规则，后者是一条规则加一份调用形状，都还有内容。**下一步能砍的
只有 `subagent` 的 guideline 里 `dependsOn` 那条**（约 260 字符），前提是接受
"模型会自己看参数描述"。

代价：`subagent` 的 brief 契约从 description 挪到 `task` 参数，读 prompt 的人
在 description 里看不到它了。测试改成把整个声明（description + 序列化的
parameters）拼起来断言四个段落名，`test/suite/regressions/subagent-brief-shape.test.ts`
里写了原因。

## Alternatives considered

**给 `buildRules`/`getAllTools` 加一层全局去重，让重复的 guidance 在源头就
被折叠。** 这能一次解决五个工具的问题，且不依赖"哪一份是权威"。否掉：
`getAllTools()` 是扩展 API，按工具返回它自己声明的规则；在这里跨工具去重会
让调用方拿不到某个工具真正声明的内容，"工具 X 的规则"就变成了"除别人已经说
过的以外"。去重放渲染层（`buildRules`）已经足够，问题只是声明的字面量本身
不该重复，那就别写五份。

**把 `LSP_GUIDANCE` 移进 system prompt 的固定段落。** 少一层间接。否掉：
`pi-lsp-mini` 是可运行时关闭的模块，固定段落收不回来，会留下指向不存在工具
的规则（同 [lsp-tools-lose-to-read](../bug-fix/2026-10-27-lsp-tools-lose-to-read.md)
的取舍）。

**把 `subagent` 的 `dependsOn`/`isolated` 规则也删掉，只留参数描述。** 省得
更多（~260 字符）。没做，因为这两条不是参数字典能表达的东西：`dependsOn` 的
规则是"别轮询、已结算的报告会自动贴进 brief、失败的依赖会阻塞"，`isolated`
的规则是"同一工作区里同时只能有一个写文件的子代理"。参数描述说"给它一个 git
worktree"，说不出"所以别同时开两个写的"。
