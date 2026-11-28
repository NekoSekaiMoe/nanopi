# Agent Note: Working 行的呼吸点与 run 圆点同列

Status: implemented

## Problem

ISSUE #906 要工作行 beside 渐变加一个像 agy-neo 那样的点动画，并与 run 左边的点对齐。
pi-ui 的 working 行只有 shimmer 文本，没有圆点；工具行（`• Running`、`• Exploring`）的圆点从第 0 列起画，
而状态行嵌进 composer 顶框时被 `CustomEditor` 加了一个前导空格，圆点落在第 1 列。两者差一格。

## Decision

- `pi-ui/src/working.ts` 在 working 行文本前拼一个呼吸点：`∙ → ⋅ → ✦ → ⋅ → ∙`，
  24 帧、每帧 100ms（一个 2.4s 呼吸），颜色沿蓝→紫渐变，按亮度提亮/压暗。
  用 `∙`/`⋅` 而非 `•`/`·`：前者是 East Asian Width neutral，后者在 CJK locale 占两列，会抖行。
  相位由 `state.elapsedMs` 直接算，不用累加器——shimmer 的画布随文本宽度变，呼吸周期固定，
  丢帧也不会跳相。
- `StatusIndicator` 暴露 `hasRowRenderer()`；`CustomEditor` 的 composer 顶框只在宿主默认
  Loader 行保留前导空格。注册渲染器拥有自己的前导圆点，从第 0 列开始，和工具行同列。
  默认 spinner（`⠋ Working`）行为不变。
- 呼吸点只加在 working 行，retry/compaction 沿用它们的 shimmer 文本；两种状态很少同屏，
  不抢同一格视觉锚点。

## Alternatives considered

- **只改 working 文本、不动列对齐。** 圆点会落在第 1 列，和工具行的 `.` 差一格，用户要的"对齐"没做到。
- **在渲染器文本里塞一个前导空格、再统一右移所有工具行。** 会改工具行的布局契约，波及所有模块。
- **用 `⠋/⠙` braille 转轮。** 那是 spinner 不是点，和参考的"点长大成星"动画不同。
- **给呼吸点单独开 30fps 帧循环。** shimmer 已有的 `dtMs` 帧链足够；另起循环只会多一个定时器。

## Consequences

- 收益：working 行现在有从左到右 breathing 的圆点动画，蓝→紫的色调与渐变文本一致；
  它的列与 `• Running`、`• Exploring` 完全对齐。
- 代价：compose 顶框里注册渲染器不再有宿主前导空格；依赖那一格的第三方渲染器会看到自己的文本左移一格。
  这是有意的——渲染器现在负责自己的前导字符。
- 验证：`packages/coding-agent/test/pi-ui-working-step.test.ts` 断言圆点存在、随 `elapsedMs` 换帧、双宽度不变；
  `packages/coding-agent/test/status-indicator.test.ts` 断言注册行从第 0 列起画、默认 spinner 行不动。
