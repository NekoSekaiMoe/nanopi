# Agent Note: `/retry` 重跑最近一次失败的 turn（#118）

Status: rejected — 用户判断 `/retry` 与手动发一句「继续」差别不大，不做；#118 关闭，#121 / #122 均未合并。

## Problem

nanopi 的「重试」只活在进程内存里。`_failedResponse`
（`packages/coding-agent/src/core/agent-session.ts`）在 `auto_retry` 和 overflow recovery 时保存
失败响应，`_runAutoRetry` 结束后就清空；`_retryAttempt` 也是纯内存计数。

结果是：只要进程退出（断线、crash、`kill`、OOM、SSH 断开，Ctrl+C 之外的一切），那次失败就永久
留在会话文件里，没有任何入口能重跑它。用户下次 `--continue` 得到的是一段以 error 结尾、且上下文
被 `context_edit` 掏空的历史，只能手动重打一遍。

## Proposal

按 issue 的落地顺序第 1 步，只做 `/retry`，不做启动时自动探测。

**落盘 run 记录**

每次 run 写一条 `custom` entry（`customType: "run"`）：结束该 run 的 assistant entry、
`stopReason`、`errorMessage`、turn 数、已花掉的 retry 次数、outcome（`completed` / `failed` /
`aborted`）。选 `custom` 而不是新增 entry 类型，是因为 `sessionEntryToContextMessages` 对它返回
空数组，snapshot / `projectContextEntry` / tree-selector / export-html / session-jsonl 都不用动。

**可恢复判定**

看分支上最新那条记录，要求 outcome 是 `failed`，且那条失败响应仍在模型视角的末尾：原文还在、
没被 `context_edit` 掏空、其后没有 compaction、这个 run 也没再写进模型能读到的内容。

**`/retry`**

`AgentSession.retryLastRun()`：把失败响应设为 `_failedResponse`，以新的 `before_agent_start`
trigger（`messageType: "continue"`）起一个 run。该 trigger 不产生任何消息，请求就是重放那一轮。
已花掉的次数写回 `_retryAttempt`，重放不会清零预算。RPC 暴露 `retry_last_run`。

## Alternatives considered

### 命令层实现：`/retry` = 替用户发一条明确的「重跑上次请求」消息（#122）

不发角色冒充的假 user 文本，而是追加一条 `customType: "retry"` 的 custom message 再
`triggerTurn`，走正常 prompt 路径开新 run。前置检查是最后一条 assistant 为 `error`（或可恢复的
`length`），其后没有已答复的 user 消息、也没有孤儿 toolResult。

最强论据是实现面小得多：不碰会话格式，不改 auto_retry 语义，只多一条消息渲染器。
代价是它确实只是一条提示词，语义上和用户手打「继续」没有本质差别——这也正是它被否决的入口。

### 为什么不做？

用户的实际判断是：这两条路（重放失败响应 / 手动发一句继续）在日常使用里效果几乎一样，不值得为
它新增会话格式、新增命令和一条独立的重放路径。

理由逐条摊开：

1. **模型看到的上下文几乎相同。** `transformMessages` 回放时会跳过 `stopReason === "error"` 的
   assistant，所以不管是重放还是手打「继续」，失败那一轮本来就不在上下文里。`/retry` 唯一多给的
   是一句「重跑上次那个请求」而不是笼统的「继续」——语义更准，但不是新能力。
2. **真正救不回来的那条路径，两条都没救。** 自动重试在每次尝试前就 `context_edit(null)` 掏空失败
   响应，所以「3 次重试耗尽后彻底放弃」这个最常见形态，`/retry` 追不回来。要救它得把「失败即掏空」
   改成「成功才掏空」，那是 #118 的第 3 步，动到既有持久化语义。收益最大的那块没解决，剩下的只是
   省了用户打字。
3. **省下的动作太小。** 用户不用想措辞、不用回翻上次让它干嘛——这两件事用一句「继续」加一行
   提示就够，撑不起一条新命令 + 一种新 entry。
4. **`aborted` 分不清，判定只能保守。** 用户按 Esc 与进程消失，在会话文件里目前长得一样。强行
   判为可恢复会替用户重跑一轮他主动取消的任务；保守判定又让 `/retry` 在大量真实中断里只会回一句
   「重试不了」。两头都不讨好。

### 只做启动时探测 + 确认提示

`--continue` / `--resume` 命中可恢复状态时提示一次。依赖项相同（run 落盘、可恢复判定），还得再
加一层启动期交互；而它服务的场景（进程异常退出后重跑）用户本来就能用一句「继续」覆盖。

## Acceptance criteria

- `/retry` 在最后一条为 `failed` 且失败响应仍在模型视角末尾时，重放那一轮的原始请求。
- 重放不清零 `_retryAttempt`。
- `aborted` 一律不重试。
- 不满足条件时明确告知「重试不了」，不发请求、不烧 token。

## Risks

- 新增 `custom` entry 与 `before_agent_start` 的 `continue` trigger，跨文件契约面比看上去大。
- 「失败即掏空」不改的前提下，`/retry` 的可用面窄，容易让用户以为它能救所有情况。
- 两个 PR（#121 / #122）路线不同，同时开着会让人不知道该用哪个。
