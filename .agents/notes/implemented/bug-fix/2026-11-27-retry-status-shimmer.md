# Agent Note: Retry and compaction rows get the working shimmer through the same registration contract

Status: implemented

## Problem

`registerWorkingIndicator` 只描述流式工作行。b38b5402d 把 pi-ui 对 `Loader.prototype.updateDisplay`
的原型补丁撤掉时，retry/compaction 的状态行没有补契约，于是从带 shimmer 的绿色圆点退回了
`warning` 色的静态 spinner。用户报告「retry 的渐变和 working 不一样」。

[2026-11-04-transcript-row-contracts](../architecture/2026-11-04-transcript-row-contracts.md)
的「out of scope」曾经明确记下这个缺口。

## Decision

`WorkingIndicatorRenderer` 的 `state` 带上 `kind`，同一份注册可以按种类画不同行：
`registerWorkingIndicator(renderer, kinds?)` 默认只接管 `"working"`，
`"retry"` / `"compaction"` / `"branchSummary"` 由调用方点名。
注册表改成按 kind 存 renderer，仍保持「同 kind 后注册者替换前者」。

`StatusIndicator` 基类承接原先 `WorkingStatusIndicator` 独有的帧循环和委托渲染：
任何状态行拿到 renderer 后都按 30fps 重绘，`dtMs` 首帧归零。
`showStatusIndicator` 统一按 `indicator.kind` 挂 renderer，所以独立状态行和嵌在
editor 顶框里的行走同一条路。

pi-ui 用第二个注册把 retry/compaction 的宿主文案（`Retrying (1/3) in 2s...`、
`Compacting context...`）交给 `shimmerSegmentsAnimated`，每种 kind 一个 sweep，
避免与 working 共用相位后互相拉扯。宿主仍拥有文案和倒计时，模块只改颜色。

## Alternatives considered

- **恢复 `Loader.prototype.updateDisplay` 原型补丁。** 能直接复刻旧效果，但把 b38b5402d
  刚刚清掉的隐式类手术带回来，文案识别靠 `message.startsWith("Retrying")` 字符串嗅探。
  拒绝了。
- **给 retry/compaction 另建 `registerStatusRowRenderer` 契约。** 语义更干净，但三种
  状态行和 working 行共享同一套 `state`/帧循环/`hidden` 语义，新契约会复制这些方法。
  扩展 `kind` 后一份实现覆盖全部，拒绝了。

## Consequences

第 2 个参数保持可选，只实现 working 行的模块不用改；想接管多种行的模块可以按 kind
注册。`WorkingIndicatorState.kind` 是新增只读字段，传给老 renderer 不会破坏它们。

**验证**：`packages/coding-agent/test/status-indicator.test.ts` 覆盖 retry 行拿到
renderer 后的首帧 `dtMs=0`、倒计时文案更新与 dispose；
`packages/coding-agent/test/pi-ui-working-step.test.ts` 覆盖 retry shimmer 的 ANSI
分段与相位推进；`packages/coding-agent/test/module-transcript-hooks.test.ts` 覆盖按
kind 独立注册。`packages/coding-agent/test/interactive-tui.test.ts` 的 prototype
context 必须带 `session.moduleRegistry.getWorkingIndicatorRenderer`，否则新路由会在
测试夹具上抛 `TypeError`；它验证的是路由依赖，而不是 shimmer 本身。
