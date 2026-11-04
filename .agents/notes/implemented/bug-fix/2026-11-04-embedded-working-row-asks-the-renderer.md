# Agent Note: 边框里的 Working 行要走注册渲染器

Status: implemented

## Problem

`registerWorkingIndicator` 落地后，pi-ui 的渐变 Working 行在真实界面里退回成了
`⠋ Working`——没有 shimmer，也没有 todo 步骤，只有转圈。

原因是两条入口只有一条走过契约：

- `WorkingStatusIndicator.render()` 问 `rowRenderer`，返回 `{ text }` 就整行替换。
- `CustomEditor.renderTopBorder()` 调的是 `renderInBorder()`，而它写的是
  `super.render(width + 2)[1]`——直接跳过 `WorkingStatusIndicator.render`，
  拿到的是 `Loader` 的 `⠋ + message`。

默认编辑器 `embedWorkingStatus: true`（`interactive-mode.ts` 构造 `CustomEditor`），
所以交互模式**永远**走第二条路：钩子装上了，画出来的还是宿主行。

第二个缺口在同一个类里：`render` 把 `dtMs` 写死成 0。shimmer 的频相位是
`phase += dt` 累加的，`dt` 恒为 0 意味着频带一步不动；即使行渲染器接上了，
动画也是静止的。宿主没有帧循环——`Loader` 的 interval 只 setText，
`TUI.requestRender` 也没人按帧调用。

## Decision

`StatusIndicator.renderInBorder()` 调 `this.render(...)`，不调 `super.render(...)`。
子类接管的行就是边框里画出来的行；`Loader` 的自有渲染退化成一个"没有行渲染器时"
的默认实现，这正是 `registerWorkingIndicator` 返回 `undefined` 的语义。

`WorkingStatusIndicator` 自己持有帧循环：

- `setRowRenderer(renderer)` 非空时启动 `setInterval(requestRender, 1000/30)`，
  清空时停掉；`dispose()` 也停。
- `render` 用 `lastFrameAt` 算真实的 `dtMs = now - lastFrameAt` 交给渲染器，
  并推进 `lastFrameAt`。这是 `WorkingIndicatorState.dtMs` 文档里承诺的
  "milliseconds since the previous frame"。
- 30fps 与 pi-ui shimmer 的 `SHIMMER_SPEED_CELLS_PER_S = 30` 对齐：每帧
  ~1 cell，和改契约之前 pi-ui 自己的帧链节奏一致。`TUI` 的 `MIN_RENDER_INTERVAL_MS`
  （16ms）会自然把重复请求合并掉，所以 30fps 的 interval 不会把终端打爆。

## Alternatives considered

- **让宿主按帧渲染（core 提供帧回调）。** 更干净：动画节奏归 TUI，模块只画。
  但 `WorkingIndicatorRenderer` 已经是"宿主每帧问我一句"的形状，缺的只是宿主
  没在按帧问；补一个 `ui.requestAnimationFrame` 是新的公开契约，比这一次修复
  的范围大。放在后续提案里。
- **`renderInBorder` 保留 `super.render`，另设一条 `renderRow()`。** 两个方法
  做同一件事，调用方还得记住选哪个——这本来就是漏掉第二条入口的原因。
- **`dtMs` 用 `Date.now() % 周期` 让频带自己动。** 文本宽度变了周期就变，频带
  会瞬移；`shimmer.ts` 的注释已经记过这个坑。
- **不动 `dtMs`，只修 `renderInBorder`。** 渐变回来了但静止，用户会报第二个 bug。

## Consequences

- Benefit: 钩子装了什么就画什么。`renderInBorder` 的调用方（默认编辑器）和
  `render()` 的调用方（独立状态行）走同一条路，`registerWorkingIndicator` 的
  两条摆放位置（`editorFrame` / `statusRow`）终于一致。
- Benefit: 帧循环跟着 indicator 的生命周期走。`clearStatusIndicator` 已经在
  `dispose()`，没有残留 timer；`stop()`（Loader 的 spinner interval）与帧循环
  是两件独立的事，停在任一处都不会漏。
- Cost: 一个 30fps 的 `setInterval` 在回合期间常驻。它只调 `requestRender`，
  不重排内容；`render` 每帧本当要跑一次。
- Testing: `test/status-indicator.test.ts` 加了两条——一条断言嵌在边框里的行来自
  行渲染器（且 `dtMs` 不是硬编码 0），一条断言帧循环在 install 后按帧请求渲染、
  `dispose` 后停止。原 `embeds the working indicator when the editor opts in`
  仍然通过，说明没有行渲染器时行为不变。
