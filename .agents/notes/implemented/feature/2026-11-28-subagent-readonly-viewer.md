# Agent Note: 只读 subagent 查看器

Status: implemented

## Problem

ISSUE #909：编辑区下方的 Exploring 行只给出 subagent 的一行 scope，最长 60 字符后截断，
看不到子代理此刻在做什么，也看不到它的报告。用户要的操作是：光标在输入框、按 ↓ 进入某个
subagent，按 Enter 只读查看，Esc 退出；实现要参考 Claude Code 的 subagent 查看方式。

查看器必须只读：不能被误当成 `subagent action=kill/continue` 的入口，也不能把报告写回编辑框。

## Decision

- `pi-subagent-mini` 在既有 `SUBAGENT_CHANNEL` 之外新增 `SUBAGENT_VIEW_CHANNEL`
  （`packages/coding-agent/src/modules/shared-channels.ts`）。前者继续画 editor 下方的 live
  rows，后者只传数据：每个 job 的 id/status/elapsed/scope/detail/report。两条通道职责分开，
  查看器不会把 live block 从 editor 下方顶掉。
- `pi-ui` 在 `session_start` 注册 `SUBAGENT_VIEW_CHANNEL` 的 transform 来缓存最新快照，并用
  `ui.onTerminalInput` 在原始输入层接管 ↓。仅当输入框为空且已有 job 时才 `consume: true`；
  有文本时 ↓ 仍归编辑器移动光标。打开走 `ui.custom({ overlay: true })`，overlay 接管焦点，
  列表的 `handleInput` 处理 ↑/↓、Enter 和 Esc：↑/↓ 移动选中项，Enter 再开一个只读报告 overlay，
  Esc 退出；关闭后宿主把焦点还给编辑器。
- `subagent-viewer.ts` 是不依赖模块上下文的两个 Component：列表显示每个 job 的状态、耗时、
  scope，并预览选中 job 的报告；Enter 打开 `SubagentReportComponent`，显示完整 brief/报告，
  ↑/↓ 滚动、Esc 返回。没有 report 时显示 cwd/tools/attempt 和“no report yet”。两者都是快照，
  不订阅实时输出流，也不提供任何动作。
- 进出路径都在 overlay/焦点层，不改编辑器组件、不改全局键位表；查看器和 Claude Code 一样从
  列表进入一个独立的只读视图，而不是把子代理输出直接塞进主 transcript。

## Alternatives considered

- **把报告直接追加到主会话 transcript。** 最强理由：零新组件，`subagent action=status` 的结果本来
  就在消息里。否决理由：报告是快照而非当前状态，用户要的是主动查看；追加消息会污染上下文和
  token 预算，也无法表达“只读、不交互”。
- **让 ↓/Enter 成为全局快捷键，进入全屏查看器。** 最强理由：按键语义更明确。否决理由：↓ 已被
  编辑器的光标移动占用，全局注册会和输入框冲突；只在空输入框时劫持 ↓ 才能两全。
- **把 view 数据塞进现有 SUBAGENT_CHANNEL。** 最强理由：少一个通道。否决理由：channel 一次只画一个
  widget，view 会覆盖 editor 下方的 live block；改 kind 会让同时存在的两个消费者互相踩踏。
- **展示 job 的实时 stdout 流。** 最强理由：最贴近“正在干什么”。否决理由：child 只把最后一条
  assistant 消息写到 stdout，中间事件被消费掉；要透传得多一条 wire 协议，超出本 issue 的查看需求。

## Consequences

- 收益：空输入框按 ↓ 即可看到所有 subagent 的状态、scope 和报告；↑/↓ 切换、Esc 退出，主
  transcript 与编辑器文本都不受影响。
- 代价：新增一条 channel 契约和一个 overlay 组件；`onTerminalInput` 在编辑器之前看 ↓，因此
  必须严格限制“空输入 + 有 job”，否则会吞掉正常的光标移动。
- 验证：`packages/coding-agent/test/pi-ui-subagent-viewer.test.ts` 覆盖快照校验、只读渲染、
  ↑/↓/Esc、bridge 的打开条件；`pnpm run check` 通过。参考仓库
  `pengchengneo/Claude-Code` 当前返回 404，按 Claude Code 的“独立的只读 subagent 视图”语义实现，
  未逐字对照源码。
