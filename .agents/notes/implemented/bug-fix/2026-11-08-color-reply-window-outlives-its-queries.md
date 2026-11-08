# Agent Note: 颜色回复窗口在查询全部答完后关闭

Status: implemented

## Problem

`#587` 从上游挑回的修复给 `TuiBase` 加了一个 1000 ms 的"颜色回复窗口"
（`terminalColorReplyWindowEnd`），目的是把终端迟到的 OSC 10/11/4 回复和
Ghostty 那种被切成多块的回复挡在键盘输入之外。但它漏了一种顺序：窗口只在
"有查询在等回复"时才有意义，而它到期前不会被任何东西提前关掉。

一次 `queryTerminalColors({ timeoutMs: 1 })` 超时后，查询留在
`pendingTerminalColorQueries` 里等迟到的回复。迟到的 `\x1b]11;#ffffff\x07` 到达，
被消费并投给 `onLateReply`；紧接着的 DA1（`\x1b[?62;22c`）把它从待答队列里
`shift` 掉——此时 `pendingTerminalColorQueries.length === 0`，但
`terminalColorReplyWindowEnd` 仍是 `Date.now() + 1000`。终端随后重发的同一个
OSC 11 回复落进这个空窗口，被静默吞掉，没有像普通输入那样交给焦点组件。

`packages/tui/test/terminal-colors.test.ts` 的
"reports late replies after a timeout and consumes them until DA1" 正好断言这一
点（第 223 行 `component.inputs` 期望 `["\x1B]11;#ffffff\x07"]`，实际 `[]`）。
issue #592。

## Decision

`extendTerminalColorReplyWindow` 是窗口唯一的写入点。它现在按待答队列决定：

```ts
this.terminalColorReplyWindowEnd =
	this.pendingTerminalColorQueries.length > 0 ? Date.now() + TERMINAL_COLOR_REPLY_WINDOW_MS : 0;
```

有查询在等回复就照旧续满 1000 ms；一个都没有就把窗口置 0（等价于关闭，
`Date.now() >= 0` 恒真）。同时删掉 `data === "\x07" || data === STRING_TERMINATOR`
分支里那句 `extendTerminalColorReplyWindow()`：那是一个无头（header-less）回复
的终止符，它被吞掉是因为刚清掉的是被暂存的片段，而不是因为还剩查询要答；
在那里续窗口正是"窗口活得比查询久"的来源。

## Alternatives considered

**在 `completeTerminalColorQuery` 里直接关窗（`terminalColorReplyWindowEnd = 0`）。**
最直接，但会打断一次批量回复的尾巴。终端把这些回复一次性写出来，被
`StdinBuffer` 切好后逐个进 `handleTerminalInput`；最后一个回复让 `replied.size`
凑满 18，查询当场完成并关窗，同一批里后面的 DA1 和其余片段就成了"用户输入"
（第一个测试拿到 `["", "x"]`，Ghostty 那条也挂了）。

**把关窗推迟一个 tick（`setTimeout(..., 0)` / `setImmediate`）。** 上面那条的
自然补救，但 DA1 和结尾片段常常和最后一个回复在同一个 chunk 里，中间没有
await，推迟一 tick 又把窗口关得太早。更麻烦的是它是时序依赖的：
`node --test` 里 `mock.timers` 一旦启用，0 ms 定时器不会自己跑，整条用例挂死
（打印 `Promise resolution is still pending but the event loop has already resolved`）。

**给窗口单独挂一个 1000 ms 定时器，到期时若无待答查询就关窗。**
`extendTerminalColorReplyWindow` 每收到一段回复都重排定时器，看起来能同时满足
"批量尾巴不被截断"和"窗口终究要关"。实测不行：重排后的定时器在最后一段回复
之后才到期，而那已经在结尾片段发出之后，`component.inputs` 仍是 `[]`。

**把暂存片段按字符逐字 flush 改成整段 flush（`dispatchTerminalInput(held)`），
并让终止符分支不续窗。** 一起试过，`queries all colors in one write` 立刻返回
`["", "x"]`：整段 flush 在片段为空时多派发了一个空字符串。真正需要的只是终止符
分支不续窗，flush 的粒度与这个 bug 无关。

**让 DA1 单独关窗。** 只在"DA1 是最后一个事件"时成立；批量回复里 DA1 之后还有
尾巴，而且用户完全可能不发 DA1。窗口该不该存在取决于还有没有查询在等，不取决于
最后来的是哪个字节。

## Consequences

- 收益：所有查询答完后，重发的颜色回复、以及只长得像回复的用户输入，都按普通
  输入交给焦点组件。窗口的生命周期和它服务的对象（待答查询）一致。
- 收益：无头回复的终止符不再续窗口，`#587` 加的那条 Ghostty 用例仍然通过（暂存
  片段 + 迟到的 `\x07` 走的还是暂存与清空路径）。
- 代价：窗口现在由"进回复时"判断一次，不再有独立的到期逻辑。若某个调用方在窗口
  开着的时候把 `pendingTerminalColorQueries` 清空而不经过
  `extendTerminalColorReplyWindow`（目前没有任何代码这样做），窗口会一直开到它
  自然过期——正是这次修的那 1 秒。新增的清理路径要么走 `completeTerminalColorQuery`
  让后续回复触发重算，要么自己置 `terminalColorReplyWindowEnd = 0`。
- 回归测试就是 `packages/tui/test/terminal-colors.test.ts` 里 #592 指名的那条；
  它与同文件其余五条（一次性写入、DA1 顺序、Ghostty 切片）一起构成窗口语义的
  约束，改动 `consumeTerminalColorReply` 时六条都要跑。
