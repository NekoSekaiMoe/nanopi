# Agent Note: Markdown transformer 覆盖到 custom/summary/changelog，靠上下文过滤而不是注册参数

Status: implemented

## Problem

上游 `eebd5d90` 给 `registerMarkdownTransformer` 加了可选第二参数 `{ messageTypes }`，
把调用点从 `user`/`assistant`/`assistant-thinking` 扩到 `custom`/`summary`/`changelog`。
本仓库的 `MarkdownTransformContext.messageType` 只有那三个值，所以这三个渲染点根本
不走 transformer：`shinytale/nanopi#650` 里列的是同一份清单，触发它是一个显示问题——
`/changelog` 那类块和 summary 的 Markdown 从来没有被任何 transformer 看过。

要不要移植上游那段代码，不是这里的问题：本仓库的 transformer 回调本来就拿得到
`context.messageType`，上游用一个新注册参数换来的能力，读上下文就有。缺的只是覆盖面，
以及一件没人注意的事——`packages/coding-agent/src/core/modules/types.ts` 里
`ModuleRenderingSurface` 被声明了两遍，第一份是旧副本，没有 `registerMessageType`、
`registerToolRowRenderer` 等新方法。两份同名接口靠声明合并叠加，所以编译一直是过的，
代价是「这个 surface 上有哪些方法」有两个事实源，改一个不看另一个也不会红。

## Decision

`messageType` 的取值域扩到六个：`user`、`assistant`、`assistant-thinking`、`custom`、
`summary`、`changelog`。注册签名不变，过滤仍然是回调自己的事——返回 `markdown` 即不处理。

三个新值各自的接线点：

- `custom`：`CustomMessageComponent` 收 `markdownTransformers`，在画默认框体里的
  `Markdown` 前跑一遍。走 codec 的那条路径（模块给 `customType` 注册过 codec）由
  `MessageCodecRenderOptions.markdownTransformers` 带进来。
- `summary`：`CompactionSummaryMessageComponent` / `BranchSummaryMessageComponent` 各加
  一个可选 transformers 参数，同样从 `MessageCodecRenderOptions` 传。它们是在
  `builtin-renderers.ts` 里懒加载的，读不到全局注册表，只能由调用方注入。
- `changelog`：`showStartupNoticesIfNeeded()` 里那份 what's-new 块。

注入而不是读注册表，是因为 `MessageCodecRenderOptions` 那两个渲染点也服务于非交互路径
（print 模式的 codec 渲染）。让 codec 自己去问「当前有哪些 transformer」，等于把交互
transcript 的状态塞进纯投影层。

内置 Mermaid transformer 加了可选的 `messageTypes`，由 `interactive-mode.ts` 传
`["user", "assistant"]`：它是宿主自己的 transformer，不是模块的，读设置是它的既有行为；
但它只该改聊天正文里的图，summary 和 changelog 是写给日志看的，不该被换成方框图。

公开性与测试一起补：

- `docs/modules.md` 加一节「Rewrite Markdown before it is drawn」，写清六个 `messageType`、
  纯函数约定、抛异常保留原文、执行顺序（宿主的 Mermaid 在前，所以后跑的 transformer
  看到的是 inline code span 而不是 fence）、每模块一个槽位。
- `MarkdownTransformContext` / `MarkdownTransformer` 的字段与契约注释。
- `packages/coding-agent/test/markdown-transformer.test.ts` 证明注册的 transformer 真的作用到了 `custom` 与
  两种 summary 行上，并且 Mermaid 不再改这两种行。

## Alternatives considered

- **照上游加 `registerMarkdownTransformer(transformer, { messageTypes })`**：多一个过滤
  维度，而这个维度已经存在于上下文里。两个都能表达同一件事的地方，读者不会知道哪个是
  权威的；而且要维持「声明了 `messageTypes` 却仍在回调里判断 `context.messageType`」这种
  语义，文档上得解释两遍。
- **只做内部统一，把 changelog 那条改成内置调用，不开这个口子**：`#650` 里我自己的建议
  就是这个。它的问题是 `registerMarkdownTransformer` 在 `src` 里除 mermaid 外零消费，
  `docs/modules.md` 只在 surfaces 表格里点了名，「要不要保留它」就成了一个悬着的问题。
  补文档和测试的成本是几十行，比再讨论一轮便宜。
- **删掉 `registerMarkdownTransformer`（没人用）**：用户给的条件是「要是没人用就去了吧」。
  实际情况是它有一处使用（内置 mermaid），而且 `ModuleApi` 的既定原则是导出面比当前
  消费者更宽（见 [remove plugin system](./2026-10-13-remove-plugin-system-programmatic-modules.md)）。
  删掉等于把「扩展能改 Markdown」这条路整个拿掉，而 `#650` 里真正要修的显示问题会失去
  唯一的修法。
- **`MessageTypeRegistry` 里也存 transformer，让 codec 自己取**：codec 是投影层，非交互
  路径也在用；把交互 transcript 的注册表挂进去，会让 `print` 模式也依赖一个只有 TUI 填
  的容器。
- **不动 Mermaid 的适用范围**：它会把 summary 里的 `mermaid` 代码块换成方框图，而 summary
  是给模型读回来、也给用户扫一眼的历史，套上图之后和原文对不上。

## Consequences

- 六个 `messageType` 一旦写进文档就是契约：再删值会是下游穷尽 `switch` 的编译错误。这也
  是当初倾向「先写文档」的理由——现在写上去了，等于承认这个取值域值得长期维持。
- 三个渲染点各自多一个可选构造参数，默认空数组，所以既有调用方行为不变。
- `custom` 行只有「默认框体」那条路走 transformer。模块自己注册了 `customType` 的
  renderer 时，画什么是它自己的事，transformer 不插手。
- 顺序仍然是「宿主的 Mermaid 先、模块按 load order 后」，与上游的链式 patch 语义仍不同：
  本仓库每个模块一个槽位，第二次注册替换第一次。这一点写进了类型注释，没有改实现。
- `ModuleRenderingSurface` 的重复声明删掉了死的那份，`registerMessageType`、
  `registerToolRowRenderer`、`registerShellRenderer`、`registerAssistantMessageRenderer`、
  `registerWorkingIndicator`、`registerMessageRunRenderer` 现在只有一个声明处。

## Verification

- `packages/coding-agent/test/markdown-transformer.test.ts`：5 个用例，覆盖 custom 行、
  compaction summary、branch summary、`createMarkdownTransform` 传下去的 `messageType`
  只作用于目标行，以及 Mermaid 被 `messageTypes` 限制后对 `summary`/`custom` 原样返回。
- `packages/tui/test/markdown.test.ts` 90 个用例全绿（其中的 html 分支断言未受影响）。
- `pnpm run typecheck` 退出码 0；`npx biome check packages/coding-agent/src packages/tui/src`
  无 finding。
