# Agent Note: `invalidate()` 重画，`repaintChildren()` 重建

Status: implemented

## Problem

`Component.invalidate()` 的 docstring 只写「Invalidate any cached rendering state」，
但 `Line*` 家族里各组件对一个 `invalidate` 的反应并不一致：

- `Text` 丢换行 / 宽度 / 行缓存，`Markdown` 丢同样三样但留着 `cachedRun`（token 树 + 已渲染行）。
- `Container` / `Box` 递归转发给子节点（`?.()` 顺带把「转发」和「重建」混成同一个动作）。
- 而五个「先 `clear()` 再 `new`」的组件把 `invalidate` 当成重建入口：
  `BranchSummaryMessageComponent`、`CompactionSummaryMessageComponent`、
  `SkillInvocationMessageComponent`、`CustomMessageComponent`、`CustomEntryComponent`。

两件事都被这个混用打穿：

1. **主题重算只刷一半屏幕。** 它们重建子节点，所以重建过程重新读 `theme`，主题变了就跟着变；
   而 `#629` 之后复用实例的 `AssistantMessageComponent` 不重建，`Markdown` 的
   `cachedLines` 在 `invalidate` 后又会用新主题重跑，看起来是对的 —— 前提是主题变化确实被
   `invalidate` 了。`Markdown` 的 `cachedRun.rendered` 里烘的是 `renderToken` 当场调
   `theme.fg(...)` 的旧字符串，`cachedLines` 清了它没清，于是复用的块留着旧色。
2. **重建时机不受控。** 子节点在自己的 `render` 里调 `owner.invalidate()`（语法懒加载完成、
   异步 diff 落地）时，重建发生在当前这一帧里：刚 `clear()` 掉的是正在渲染的子节点，
   这一帧拿到空行，下一帧才画出内容。

## Decision

把「重画」和「重建」拆成两个入口，语义写进 `packages/tui/src/component.ts` 的接口契约。

- `invalidate()` — 输入动了，内容没动，重画。组件丢自己的缓存。容器转发给子节点。
  它**不接受**「也许可以留着缓存」：调用方无从知道缓存还成立不成立
  （`TUI.invalidate()` 的 resize / 主题切换、`context.invalidate()` 的懒加载语法和异步 diff）。
- `repaintChildren()` — 容器自己的钩子，受保护。基类 `Container` / `Box` 的实现是让每个子节点
  各自 `invalidate()`。子类若必须重建子树才能重画（因为重建才是重新读 `theme` 的动作），
  覆写这个，**不覆写 `invalidate`**。
- 容器在 `render` 期间收到的 `invalidate` 被推迟：`Container` / `Box` 记 `rendering` 深度与
  `invalidatedWhileRendering`，最外层 `finally` 里 flush，并顺手清掉 `mouseLayout`
  （重建换了子节点，那份布局描述的已经不是当前的树）。

`Markdown` 因此改成自己判陈旧，而不是指望调用方一定在主题变时 `invalidate` 它：
`cachedRun` 与 `cachedLines` 都带上「主题实例 + `defaultTextStyle` 身份」，
`render` 里发现对不上就丢缓存和 `defaultStylePrefix`。`extendCachedRun` 只在身份相同时保留行。

`Markdown` 侧的入口仍然是 `setTheme(theme)`：`render` 的身份检查只保底，
不替代「换主题时把新实例递进去」。`#666` 走的是 `setMarkdownTheme` → `setTheme` 那条路，
两者并存不冲突 —— `setTheme` 提前丢行，`render` 的身份检查兜住没走 `setTheme` 的调用方。

顺带一个反直觉的正确性说明：`AssistantMessageComponent.invalidate()` 会
`updateContent()` 重建块组件，在本 PR 的延迟 flush 语义下等于「重建 + 重置回放」。
这是对的 —— 主题重算时 `blockKey` 里的主题身份先把旧块换掉，重建顺带补上
`render` 在帧内被推迟的那次，主题切换只会多走一遍，不会画错。没有为它加特判。

`Text` 暴露 `protected getText()`，让 `ThemedText` 能在重建后判断字符串是否真的变了。

`ThemedText` 的 `stale` 语义随之收紧：`invalidate()` 与 `setBuild()` 置 stale，`render` 在
stale 或主题实例变了时重建；重建结果与 `getText()` 相同时也跳过 `setText`
（`setText` 对相同字符串是 no-op，行缓存已经被 `invalidate` 清掉，重跑也只会得到同样的行）。

## Alternatives considered

- **让 `invalidate()` 一律保留缓存（只有 `setText` 清）。** 否掉：`invalidate()` 是
  「输入动了、内容不动」的通道，调用方恰恰不知道内容有没有变。`TUI.invalidate()` 的 resize
  和主题重算、`context.invalidate()` 的懒加载回调和异步 diff，都在这个语义下要求重新出图。
  返回旧行是静默画错，不是优化。`Text` 那侧的决定见
  [Text.invalidate() redraws the same text](../architecture/2026-11-10-text-invalidate-redraws-settext-swaps.md)（同目录另一篇）。
- **让 `invalidate()` 只能被 UI 调用，组件内部一律走 `repaintChildren`。** 否掉：五个组件之外
  还有人把 `invalidate` 当「重建入口」（`context-dialog` 的 `Markdown`、`ask-lite` 的预览缓存），
  改语义等于逐个审计调用方，且没有收益 —— 重建的时机问题靠延迟 flush 解决更直接。
- **在 `Markdown` 上加 `setMarkdownTheme`，每个渲染点显式调用。** 否掉：六个渲染点
  （assistant thinking/text、user、custom、summary ×2、changelog）都要记得调，
  忘一个就回到旧色。而 `theme.ts:403` 的注释本来就承诺了「比较实例身份来失效缓存」的契约，
  改成组件自己守这条契约，调用方一处都不用改。
- **容器在 `render` 里收到 `invalidate` 时直接重建。** 否掉：重建替换掉的正是这一帧刚渲染的
  子节点，画面会闪一帧空白。延迟到帧尾 flush，下一帧画新树。
- **`ThemedText` 靠 `setText` 对相同字符串 no-op 来省一次重排。** 保留，但要先 `getText()`
  比一次：主题重算可能产出完全相同的转义序列，此时 `setText` 是 no-op，而 `invalidate` 刚丢掉
  的行仍然要重建 —— 两者不冲突，前提是别把「字符串相同」当成「不用重画」。

## Consequences

- 收益：主题重算后 `Markdown` 不会留着旧色；容器重建不再吃掉当前帧；五个重建型组件不再
  需要 `override invalidate + super.invalidate()` 的模板，覆写 `repaintChildren` 即可。
- 代价：`invalidate` 的契约从一句话变成一段话，`repaintChildren` 成为一个新的可覆写点。
  子类**同时**覆写两者时会重建两次（`invalidate` 里重建一次，flush 后又一次），
  这一点没有机制兜住，靠接口 docstring 说清楚「覆写这个，不覆写 `invalidate`」。
- 代价：`ThemedText` 现在每次 `render` 多两次同一性比较（主题实例、`stale`）。
  `stale` 为 false 且主题没换时停在一次比较上，与 `Text.render` 的字符串比较同量级。
- 代价：`Markdown` 在主题实例变化时不信任 `cachedRun`，意味着整段重渲染一次。主题变化本来
  就要整屏重画，这不是新增的路径，只是把它从「看调用方是否记得 invalidate」变成必然。
- 测试：`packages/tui/test/container-repaint.test.ts`（转发 / 覆写 / 帧内延迟）、
  `packages/tui/test/markdown.test.ts` 的「re-renders cached output when the theme instance is
  replaced」与「keeps resumed rows only while the theme and the default text style hold」、
  `packages/coding-agent/test/themed-text.test.ts`（懒构建 / 主题实例变化重建 / `setBuild` 后重建）。
- 与 `#666`（message bodies 复用同一个 `Markdown`）合并时，冲突集中在三个文件：
  `Markdown` 的主题身份检查两边各写了一份（`renderedTheme` / `prefixTheme` 对
  `cachedStyle` / `styledBy`），保留后者的「主题 + `defaultTextStyle`」二元组；
  `BranchSummaryMessageComponent` / `CompactionSummaryMessageComponent` 同时拿到
  `setMarkdownTheme` 与 `repaintChildren`，两者都留：前者换主题，后者重建。
  五个组件里 `AssistantMessageComponent` 仍覆写 `invalidate`，因为它重建的是
  `Container` 的子树而不是自己，语义上等价于基类转发，没有改动。
- 未覆盖：`extras/pi-ui/src/thinking.ts` 的展开态 thinking 仍是 `clear() + new Markdown`
  （#628 标为后续），这一轮不动。

## Related

- [Text.invalidate() redraws the same text, setText swaps it](../architecture/2026-11-10-text-invalidate-redraws-settext-swaps.md)
- [Markdown resumes rendering from the settled blocks](../simplification/2026-11-10-markdown-render-resumes-from-settled-blocks.md)
