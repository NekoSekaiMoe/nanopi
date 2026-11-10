# Agent Note: 流式高亮的前缀重排只在第一次 exact 时做

Status: rejected — 按「第一次进入 exact 时做一次前缀、之后只画新增行」实现后，带未闭合
模板字符串的 write 内容会停在与全量高亮不同的画面上，而 `write` 没有 `complete`
短路的缓存。收益小、有已知错误画面，故不做。

## Problem

`updateStreamingHighlight`（`packages/coding-agent/src/core/tools/render-utils.ts:92`）在每条新增行
之外，还会把前 `STREAMING_FULL_HIGHLIGHT_PREFIX_LINES = 50` 行按完整上下文重新高亮一次：

```ts
const prefixCount = Math.min(STREAMING_FULL_HIGHLIGHT_PREFIX_LINES, lines.length);
const prefix = highlightLines(lines.slice(0, prefixCount).join("\n"));
```

一次带 400 行 heredoc 的 bash 调用，流式期间 400 帧，每帧多高亮 50 行，合计 2 万行。400 帧里
前缀内容只变过 50 次（新行推进到这里以前，前缀里只是最后一行在变），其余 350 次是纯重复成本。

## Proposal

想法是：结构体上已经有 `exact`（`:53`），前缀重排只在「第一次变为 exact」时做，之后跳过。

实现只有两行：

```ts
const prefixCount =
    previous.exact ? Math.min(1, lines.length) : Math.min(STREAMING_FULL_HIGHLIGHT_PREFIX_LINES, lines.length);
```

（增量分支的前缀里，除最后一行外的前缀行只在某行**首次**进入前缀时内容才有变化；`exact` 转真
表示「上一次已经把前 50 行按完整上下文排过」，此后每次只要重排正在增长的最后一行。`exact` 的
定义仍是 `prefixCount === lines.length`，不需要额外字段。）

## Alternatives considered

### 就这么改

`write` 的 `renderResult` 总是返回组件（`renderers/write.ts:118-127`），`context.argsComplete`
只在 `renderCall` 里被读（`:101`），所以卡片画的是 `renderCall` 留在 `WriteCallRenderComponent`
上的文本，其缓存只由 `renderCall` 自己的比较门控。而 `renderCall` 在内容变化时必然重跑
`updateStreamingHighlight`，没有「参数已定，直接复用」这一层。于是：

- 流式期间，第 50 行之后不再重排前缀；
- `setArgsComplete()` 不再改内容，`renderCall` 的比较门控不落空，但 `updateStreamingHighlight`
  在 `reusable && previous.source === source && (previous.exact || !complete)` 处发现
  `previous.exact === false`，于是走全量分支重排一次。

全量分支的结果与增量分支**不同**：增量按行高亮，全量按整体高亮。对于跨行 token
（未闭合的模板字符串、块注释、heredoc 字符串），两边渲染出的行不一样。`test/streaming-highlight.test.ts`
的 write 用例正是拿这一点做断言：

> `// The unterminated template literal spans lines, so only a full highlight matches a fresh render.`

现在的实现能过，是因为参数定稿后 `renderCall` 会再跑**至少一次增量更新**，那次把前缀补成完整上下文。
跳过前缀重排后，`previous.exact` 在 50 行以内仍能靠完整前缀补上，但超过 50 行的内容就永远停在
逐行高亮的画面上，与新建组件的渲染不等。要么改测试（丢掉这条一致性断言），要么给 `write` 也补一层
`argsComplete` 缓存——后者是第二个改动，收益只有 50 行/帧的量级。

### 收益为什么不够大

- `renderCall` 每帧只跑一次（`ToolExecutionComponent` 的节流），不是每行一次；省下的是
  `50 行 × 帧数` 的 highlight 调用，不是 `O(n²)` 里的大头。
- bash 的调用文本在 `argsComplete` 之后已被缓存（`renderers/bash.ts:110-123`），重复的前缀重排
  只发生在**流式期间**，而流式最多几百帧、每次几十行高亮，相对一次全量高亮（几百行）并不占主导。
- `exact` 现在是「这一段有没有按完整上下文排过」，被跳过的前缀重排会让它继续承担
  「画出来的东西是否可信」的含义；为了省这点量给它加一层「首次」状态，是给读者增加一个需要
  记住的时序，换回来的确定性不值这个价。

## Acceptance criteria

不做。若以后 `write` 也加上「参数定稿即复用文本」，这个改动会变得安全，届时按本记录的
第一条替代方案重新评估：先让 `write` 在 `argsComplete` 且 `exact` 时短路，再考虑前缀重排。

## Risks

- 流式期间的前缀高亮仍是 `50 × 帧数`，长 heredoc 下会有可观测的 CPU 占用。缓解：帧已是节流的，
  且实测（`test/streaming-highlight.test.ts` 的 400 行用例）通过阈值有 60 倍余量。
- 若有人后来只把 `previous.exact` 那次判断加进去、没跑 write 用例，就会出现上面那条不一致的
  画面；本文就是给那次尝试留的记录。
