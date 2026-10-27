# Agent Note: webui 的权限卡片先出现，再允许暂停

Status: implemented

## Problem

issue #293「webui 的权限确认能用了吗」。答案是：不能。`nanopi webui` 里每个受门禁
覆盖的调用（bash/edit/write）都直接失败，前端连一张卡片都收不到。

`tool_call` 处理器写的是 `gate.explain(info) ?? gate.check(info)`：先暂停，再问。
而 webui 的 `explain()` 停在 `PermissionBroker.explanationPrompter` 上，那个方法要
拿 broker 的 `active` 条目；条目由 `prompter` 入队时才产生，也就是 `check()` 那一步。
于是每次调用都按这个顺序走完：

1. `explain()` 读 `active` —— 还是空，立刻返回 `undefined`（「没人等这次暂停」）；
2. `check()` 调 prompter，把卡片入队、`emit({type:"prompt"})` —— 但此刻 gate 已经
   在 `check()` 里拿着 prompter 的 Promise 等答案；
3. `explain()` 那句 `await prompter(info)` 的返回值被读成 `undefined`，落进 `default`
   分支，返回 `{action:"deny", reason:"... was dismissed"}`；
4. 卡片从未被 SSE 发出去，模型只收到一条「用户关闭了弹窗」。

`allow_once`/`deny` 也没用：卡片不出现，用户没有可点的东西。

## Decision

把暂停放回 `check()` 内部，让提示先出现：

- `check()` 拿到 prompter 的答案后，只在拿到 `"explain"` 时才调 `explain()`。此时
  broker 的条目是 active 的，`explanationPrompter` 才真正挂得上。暂停返回
  `undefined`（没结论）就回到循环再问一次，拿到的下一个答案就是卡片的真答案。
  一次 `check()` 对模型而言仍然是一次调用。
- `PermissionPrompter` 的返回类型补上 `"explain"`：暂停是提示牌自己给出的答案，
  不是第二个函数的事。
- `PermissionBroker.prompter` 原样透传 `"explain"`（此前把它吞成 `undefined`），
  `answer("explain")` 把 `"explain"` 交给挂起的 prompter，条目继续 active。
- `settle()` 收掉两份一样的 `switch`：`check()` 与 `explain()` 用同一处把裁决翻译
  成结果，避免两条路对 `allow_session`/`ai_decide` 各写一遍。

## Alternatives considered

- **只把 `explain()` 里的 `decision === undefined` 也当成暂停。** 这是最初的修法，
  能救回「暂停被吞成 dismiss」这一半，但救不了顺序：卡片仍然从未出现，用户没有
  机会点「解释」。真正的 bug 是「先暂停，后提示」，不是那一个分支。
- **让 `explanationPrompter` 在没有 active 条目时自己入队等下一次提示。** 它就成了
  第二个 prompter，两个消费者抢同一个队列，`answer` 的匹配规则要重写，还得处理
  两处都超时的情况。把暂停挪进 `check()` 只需要一个循环。
- **把暂停做成 `PermissionDecision` 的第五个值。** `check()` 只会「放行」或「拒绝」，
  暂停不裁决任何事；塞进去就得二选一，要么凭空跑、要么凭空拒，都会给模型一个
  用户没说过的结论。
- **让 webui 也走「输入框敲继续」。** 卡片没有编辑器。这条已被
  `2026-10-26-permission-explain-then-continue` 否过一次，本次不重开。

## Consequences

- 收益：webui 的权限确认恢复可用，卡片出现、四个答案都生效、「解释」暂停后卡片
  仍在。回归由 `packages/coding-agent/test/webui-permission-card.test.ts` 走真实
  HTTP/SSE 钉住（修复前三个用例全挂在「no permission_request event」），broker 与
  gate 的时序由 `packages/extra/test/permissions.test.ts` 的
  `webui explanation handshake` 钉住。
- 代价：`check()` 从「问一次」变成「问一次，遇到暂停再问一次」。暂停只在 UI 明确
  回了 `"explain"` 时发生，普通会话和其他前端仍是一条直线。
- `explainedCalls` 现在覆盖整个暂停期（`try/finally`），同一 callId 的第二次解释请求
  仍被拒；它与 `explanationGranted` 一起保证一次调用上不会叠两个解释回合。
