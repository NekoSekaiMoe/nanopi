# Agent Note: footer 测试在断言前关掉原生 watcher，而不是放宽断言

Status: implemented

## Problem

`packages/coding-agent/test/footer-data-provider.test.ts` 里「updates the cached branch when the
reftable directory changes」这条用例，先 `writeFileSync(tables.list, "1\n")`，再
`waitFor(() => execFile.mock.calls.length === 1)`，最后断言 `toHaveBeenCalledTimes(1)`。

问题在中间那个 1：它同时要求「事件到了」和「事件只到一个」。而这条路径上有四个刷新源，
只有第一个是测试摆的：

- `reftableWatcher`（`fs.watch` 目录）—— 测试真正依赖的那个。
- `reftableTablesListWatcher`（`fs.watch` 文件）—— 同一个写入也能触发。
- `watchFile(tablesListPath, { interval: 250 })`（轮询）—— 不受 `provider.dispose()` 之外的
  任何测试控制，fixture 建的时候写 `tables.list` 就可能排上一次回调。
- `headWatcher` + 可选的 `watchFile(HEAD)`。

全量套件下机器忙，轮询回调晚到 250ms 以上是常态，于是 debounce 窗口关掉之后又来一次刷新，
`execFile` 变 2。原始状态下 8 次里撞一次，属于「机制上会挂、平时看不出来」。

## Decision

测试在**第一次刷新已经发生后**调 `stopNativeWatchEvents(provider)`，把上面四个源全部摘掉：
关闭两个 `FSWatcher`、`unwatchFile` 掉 HEAD 与 `tables.list` 两个轮询、字段置 `null`。

顺序不能反。摘 watcher 必须在 `writeFileSync` 之后、`waitFor` 返回第一次刷新之后 —— 真实事件
只能靠这些 watcher 送达，写文件之前摘掉就永远等不到第一次 `execFile`，只能靠轮询那条自杀式路径
兜底。先让真实事件落地，再把后续的迟到源切断，计数才重新变成确定的 1。

断言不放宽，仍是 `toHaveBeenCalledTimes(1)` 和 `onBranchChange` 恰好一次。理由：这条用例验的是
「事件到了能更新分支」，精确计数在这里恰好是免费的冗余信息，而且在摘掉原生 watcher 之后它抓得到
真回归 —— 把 `scheduleRefresh()` 在窗口关闭后再调一次，断言仍然立刻变红（got 2 times）。

`emitReftableChange` 从「断言 watcher 非空再 emit」改成「watcher 为空就静默返回」。摘掉 watcher
之后，它只对没摘的前两条用例（`does not notify listeners…`、`debounces rapid reftable updates…`）
有实际作用，那两条在 `dispose()` 之前不需要它抛错。

## Alternatives considered

**放宽成 `>= 1` / `toHaveBeenCalled()`。** 上游补丁（`95cb6e5853`）走的是这条，同时做两件事。
放弃的理由：放宽之后这条用例不再能区分「刷新一次」和「刷新两次」，而两次刷新会把
`notifyBranchChange` 变成多次通知，是真实缺陷。去抖「3 次合并成 1 次」由另一条
`debounces rapid reftable updates into a single async refresh` 守着，那条覆盖不到「迟到事件」
这个场景。

**给这三条用例都套 `stopNativeWatchEvents`。** 试过，不行：前两条用例靠 `emitReftableChange`
拿 `reftableWatcher`，摘掉之后 emit 成了空操作，`execFile` 一次都不会被调，三条全红。所以这个
helper 只能用在「自己写文件」的那条上。

**改生产代码，让 `watchFile` 轮询可以被测试关掉。** 放弃：为测试往 `FooterDataProvider` 上加开关，
等于把测试的架构债转进产品代码。测试已经用 `as unknown as { … }` 拿了私有字段（同文件里
`retries git watchers 5 seconds after an async fs.watch error` 早就这么干），follow 现有惯例成本更低。

**先摘 watcher 再写文件。** 第一版就是这么写的，测试直接挂：`waitFor` 等不到任何 `execFile`。
真实事件是 watcher 送达的，摘完就只剩轮询，而轮询恰好是被怀疑的那个不确定性来源。

**继续挂着，等 CI 真红一次再说。** 上一轮的结论就是这个。改判的原因是找到了确定性复现方式：
不是靠并发撞运气，而是在窗口关闭后补一次 `scheduleRefresh()`，断言立刻变成 2。机制清楚、
修法只动测试，没有理由等。

## Consequences

代价是 helper 直接摸私有字段名。`FooterDataProvider` 的字段一旦重命名，`stopNativeWatchEvents`
会静默失效（字段取到 undefined，可选链跳过），测试退化成原始状态。这是「脆但不假红」的失败方向，
可以接受。

收益是这条用例不再依赖调度时序，全量套件下的随机红消失。

验证：`packages/coding-agent/test/footer-data-provider.test.ts` 连跑 5 次全绿（原状态下 8 次里红一次）；
在 `waitFor` 之后、断言之前注入一次 `scheduleRefresh()` `scheduleRefresh()`，断言按预期变红（got 2 times），确认精确计数还有价值。
