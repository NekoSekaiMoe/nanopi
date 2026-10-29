# Agent Note: 先解释，再让用户点「继续」

Status: implemented

## Problem

权限确认弹窗只给四个答案：允许一次、本会话允许、拒绝、让 AI 决定。用户常常看不懂弹窗上那行命令要干什么，
但四个答案里没有一个能「先看一眼再决定」：选拒绝要重来，选允许就是把没读懂的东西放行。

issue #262 要的是第五个答案：选中后 AI 解释这次调用做什么，然后停下来；此时输入框的联想变成「继续」，
输入「继续」就放行这一次。关键约束是**只放行这一次**——下次同类调用照旧弹窗。

## Decision

### 答案的三种时效

弹窗的答案不是「四个平级按钮」，而是三种时效：

- **单次**（`allow_once`、`deny`）：只针对这一次调用，gate 不留记忆，下次同类调用照旧弹窗。
- **本会话**（`allow_session`）：记住这个工具，之后同工具的调用不再问（危险命令除外）。
- **一直**（`ai_decide`）：这一类调用交给模型裁决，裁决缓存在会话里，不再问。

解释完点「继续」落到**单次**上：用户刚读懂这次调用，只放行这一次才符合他按下说明时的心理。
所以弹窗和继续之后的呈现都写明时效——选项文字直接带范围（`Allow once (this call only)`、
`Allow this session (every call of this tool)`、`Reject (this call only)`、`Let the AI decide (this kind, from now on)`），
联想字是「继续（只放行这一次，下次还会问）」，终端标题同样写明下一次还会问。

`allow_once` 在 gate 里的效果与 `allow` 完全相同（跑一次、不留记忆），保留成两个答案是因为它们是两处不同的
用户动作：一个是弹窗上的「允许一次」，一个是读完解释后的继续。文档和类型注释里都标了这一层。

### 两层实现

两层都在 `packages/extra`，core 只加了传话（弹窗 `description`、联想的 fallback）。

1. **gate 知道「一次性放行」**（`permissions.ts`）。新增 `approveOnce(callId)`：把 callId 记成一张票，
   `check()` 认票即放行并删票。票是 callId 而不是工具名，所以过期或猜来的票没法重放。
   `allow_once` 不留任何记忆，危险命令（`hazard`）也一样只放行一次——这正是它与按工具记忆的
   `allow_session` 的分水岭。

2. **解释是一个回合**（`extension.ts`）。弹窗加一行 `Explain what this does`；选中不是回答，而是：
   把 callId 记进 `explainedCalls`，`sendUserMessage(explainPrompt)` 开一个新回合，prompter 把 `"explain"`
   原样交回 gate。gate 因此仍卡在那次调用上——`tool_call` 处理器在这个回合里直接返回，什么都没跑。
   解释回合结束时 `agent_settled` 调 `approveOnce(callId)`，于是用户输入「继续」时那次调用放行，
   弹窗不再弹出来；下一个同类调用重新问。回合被中断（Escape）则丢掉这张票，调用照常要重新确认。

   暂停本身归 gate：`check()` 收到 `"explain"` 就调 `explain(info)`，后者**先占住** `explainedCalls`
   再经 `onExplain` 让扩展开解释回合。没有第二个 prompter 的 UI（TUI 弹窗）在暂停期间不重弹原对话框——
   `makeDialogExplanationPrompter` 复用同一个选择器但不含「解释」这一项，于是那次调用由「继续」
   （`approveOnce`）或用户的明确答案结算。少了这层，`check()` 会拿着同一个「解释」答案再问一遍，无限循环。

为什么用「阻塞的那次调用 + 一张票」，而不是「拒绝掉这次调用，让模型重发」：重发要靠模型，模型可能不再发，
也可能改参数；阻塞让解释和调用是同一个 callId，握手是确定的。代价是解释回合里模型不能再调任何被门禁
覆盖的工具（会再弹一次窗），所以提示词明确要求它解释完就停。

「继续」的呈现：弹窗占着编辑器槽位，联想字（ghost text）在弹窗关闭前看不见，所以只有用户选中解释后才给。
扩展经 `extraBridge.continueSuggestion()` 告诉 TUI 这一轮该给「继续」，TUI 把它当联想字的兜底
（模型没给建议、或联想被关掉时用它），终端标题同时写明「继续」能放行这次调用。

webui 走同一条 gate，但卡片没有输入框可以敲「继续」，所以它的「解释」走另一条路。gate 侧多一个
`explain(info)`：它多挂一次 prompt，这次允许「解释」作为答案（`explanationPrompter`），
拿到 `"explain"` 就返回 `undefined`——调用继续挂着。卡片 POST `decision: "explain"` 交给
`PermissionBroker.answer`，它**不**结算 prompt（条目仍是 active），而是置位 `explanationGranted`、
把 `"explain"` 交给挂起的那次等待，并发 `explain` 事件；服务端转成 SSE `permission_explained`。
用户读完解释后卡片还在，点「只允许这一次 / 本次会话允许 / 拒绝」才是真正的答案。同一次 prompt 只允许解释一次，
避免两个回合叠在一次调用上。`tool_call` 处因此写成 `gate.explain(info) ?? gate.check(info)`：解释完什么也没跑，
下一轮 `check()` 重新问一次，拿到真答案。

卡片因此补齐了两个按钮：`allow_once`（只允许这一次）和 `explain`（解释这次调用），并加了一行时效说明；
前端 `PendingPermission` 原来读 `pending.args`，服务端发的是 `arguments`，参数预览一直是空的，这次一并修好。

## Alternatives considered

- **把 `explain` 写进 `PermissionDecision`，让 `check()` 返回第三种裁决**：弹窗的第五个选项本来就是
  「解释」（`DECISION_LABELS` 里就有），这里放弃的是**另一个**东西——让 gate 的返回值也长出「解释」这一态。
  `check()` 只有放行、拒绝两个出口，硬塞进去就只能二选一：当拒绝会让这次调用凭空消失，还给模型发明了一个
  用户没表达过的「拒绝」；当放行则是凭空执行。解释是交互中的暂停，不裁决任何事，所以停在 prompter 层。
- **拒绝掉这次调用，让模型解释并重发**：重发取决于模型是否照做、参数是否一样，用户可能只看到解释没有下文；
  而且拒绝会把「用户想执行」表达成「用户拒绝」，git guard 的拒绝理由也会误导模型。
- **解释走 `/skill` 或提示词模板文件**：解释要带 callId、参数和 hazard，是数据不是静态提示词，
  模板只会多一层拼接。
- **用占位符（placeholder）代替联想字提示「继续」**：占位符是编辑器空着时的常驻提示，不随回合变化，
  也不表达「输入它就能放行这次调用」。

## Consequences

- 收益：看不懂的调用有了「先解释」这条路，且不会因为解释而放宽后续调用；`PermissionGate` 的记忆语义没变，
  只多了一张一次性票。
- 代价：解释是一次真实的模型调用，会花时间与 token；解释回合里模型被要求不调用受门禁覆盖的工具，
  它若不听话，用户会再看到一个弹窗——行为仍然安全，只是不顺。
- 票以 callId 为键存在 gate 内，不落盘、不跨会话：进程重启或换会话后调用必须重新确认。
- webui 的解释不是 TUI 那条「输入继续」，而是「解释推送 + 卡片继续等答案」：两条路共用 gate 的
  `explain()`，但前端的交互不同（TUI 有编辑器，webui 只有卡片）。
- 解释这条路只覆盖 webui 与 TUI：headless（无 UI）既弹不出对话框，也没有输入框可敲「继续」，
  `tool_call` 在那种会话里直接放行受门禁的工具（见
  [无 UI 会话的权限](2026-10-29-unattended-session-permissions.md)）。
