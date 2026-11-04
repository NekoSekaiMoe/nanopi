# Agent Note: `/remember` 提取在后台跑，底栏不再挂提示

Status: implemented

## Problem

Issues #470 的问题只有一行：`/remember: write this session's durable conclusions to AGENTS.md`
挤在底栏，和 `used 11k/200k`、`◆ 1 checkpoint`、`◆ 1 checkpoint`、`plan`、`shell` 抢同一行的宽度。
截图里那一段被截断成 `used 11… ◆ 1 checkpoint /remember: write this session's du…`。

但把这句话变短只是治症状。这条提示之所以存在，是因为 `/remember` 的代价全在用户按下它的那一刻：
读会话、抽候选、弹确认框，全部串行。所以它得先求用户记得按。而它真正需要的只是「确认」——
抽取这一步没有用户参与，也不该占底栏。

## Decision

抽取移到后台，底栏不放任何字。

- `agent_settled`（且未被中断、`ctx.hasUI` 为真）时，若本会话用户轮数达到
  `MIN_USER_TURNS_FOR_BACKGROUND`（4），后台跑一次 `extract()`。每个会话只跑一次
  （`session.extracted`）：第二次跑只是把同一段 transcript 再付一次钱，得到同一个结论。
- 结果进 `session.cached`，连同它算出来的会话形状（用户轮数、已拒绝候选数）。
  `/remember` 用 `extractionFor()` 取：缓存仍描述当前会话就直接用，否则重算。
  所以用户看到提示后打 `/remember` 是零额外模型调用，只是确认。
- `/remember` 在后台任务还没跑完时 `await session.background`，不另起一次请求。
- 后台有任何候选时才发一条 transcript 通知（`N conclusions from this session are ready
  for AGENTS.md: /remember to review`），由 `ctx.ui.notify` 写进聊天流，不是底栏。
  没有候选、失败、太短的会话都不留痕：后台任务的失败是静默的，下一次 `/remember` 会重跑并报错。
- 无 UI 的会话（print、RPC、子代理）整段跳过。没有输入框就没有人能确认，抽取出来的东西只能被丢掉，
  那是一笔纯亏的模型调用。
- 任何改动文件的动作（`/remember <text>`、确认后的写入、`--prune`、`/forget`）都清掉缓存：
  候选是拿旧文件去重的，文件变了，重算才是对的。

`setStatus` 这条通道仍然被其他模块用着（mode 徽章、checkpoint、subagent、hook 状态）。这次只是
`pi-memory` 不再往上面写。

## Alternatives considered

- **把文案改短**，例如底栏只留 `◆ memory`。否：用户要的是不要挤，而且真正的问题是这个角色本来就
  不该在底栏——底栏是「现在我处于什么状态」，`/remember` 是「你可以做一件事」。状态每轮都在变，
  一次性建议不是。
- **保留底栏提示，只把抽取提前**。否：那样底栏的文字和实际可做的动作脱节——抽取早就跑完了，
  提示却还写着「去写结论」，用户按下去才发现只是确认。
- **保留底栏提示但不写 `setStatus`，改用 widget**。否：widget 在编辑器上下，比底栏更占地方，
  而且 `pi-ui` 会抑制 widget；用一条聊天流通知表达「有东西等你确认」，比常驻状态行更贴近事实。
- **每个 `agent_settled` 都重跑抽取**，让结果总是最新的。否：长会话里 `agent_settled` 一脚就是一次
  完整的模型调用加一次 `git blame`，用户没按 `/remember` 之前这些钱都白花。缓存加会话形状校验，
  在「够新」和「别重复付费」之间取了中间。
- **后台抽取完直接写文件**。否：写入门槛（须是规则、须新、须用户确认）是
  [memory-entry-aging](2026-10-26-memory-entry-aging.md) 立起来的前提，自动落盘等于把它拆掉——
  记忆的失败模式不是「记不住」，是「记错了却看不出来」。

## Consequences

- 收益：底栏回到只放状态（mode 徽章、checkpoint、shell 标签）；`/remember` 从「等模型再等确认」
  变成「等确认」。
- 代价：用户没打 `/remember` 的会话也多一次模型调用（每会话一次，且有 4 轮下限）。这是这次改动
  明确接受的预付成本——它换掉的是「提示常驻在底栏但没人按」这种更常见的浪费。
- 代价：缓存有效期是「会话形状没变」。用户在后台抽取之后又聊了两轮，`/remember` 会重新抽取一次，
  那次就是额外的一次调用。会话形状（轮数 + 拒绝数）比对是廉价的近似，`stale` 清单会漂移，但
  漂移的后果只是多一次请求，不会写出错条目。
- 测试：`packages/coding-agent/test/suite/memory-command.test.ts` 的 `background extraction` 一组
  四条——后台跑过一次后 `/remember` 不再消耗模型响应、整个流程没有一次 `setStatus` 写入、无 UI 的
  会话不发起抽取、轮数不够的会话不发起抽取。把 `ctx.hasUI` 的守卫去掉会让第三条失败，
  把缓存去掉会让第一条失败，所以两条都不是空断言。
