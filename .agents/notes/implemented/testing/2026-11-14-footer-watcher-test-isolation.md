# Agent Note: footer 的 watcher 测试自己关掉原生监听

Status: implemented

## Problem

`packages/coding-agent/test/footer-data-provider.test.ts` 里两条用
`vi.useFakeTimers()` 的用例（`does not notify listeners when reftable updates
keep the same branch`、`debounces rapid reftable updates into a single async
refresh`）靠手工 `emitReftableChange` 驱动去抖，然后断言
`execFile` 恰好被调用一次。

问题是 `new FooterDataProvider(worktreeDir)` 同时装了三层真实监听：目录上的
`fs.watch`（HEAD 所在目录、reftable 目录）、`tables.list` 上的 `fs.watch`，
以及 `watchFile(tablesListPath, { interval: 250 })` 这个轮询。fixture 创建时写
`tables.list` 就可能留下一个迟到事件；全量并发跑的时候，事件迟到的窗口足够撞进
断言所在的假时钟区间，`scheduleRefresh()` 被多排一次，计数变成 2。

这个 race 结构上成立，实测很难撞（36 次运行、含 8 路并发全过），所以它一直在
CI 里潜伏，直到某次 release 全量运行才炸。

## Decision

测试文件里加一个 `stopNativeWatchEvents(provider)`：`close()` 三个 `FSWatcher`
（head / reftable / tables.list），并对 `tables.list` 调 `unwatchFile`。它有两个
调用点：

- 那两条假时钟用例建完 provider 之后立刻调用，把事件源完全交给
  `emitReftableChange`。
- `updates the cached branch when the reftable directory changes` 那条真事件
  用例，在第一次 `execFile` 落地之后调用。顺序不能反：写文件之前摘掉监听就永远
  等不到第一次刷新。摘掉之后，迟到的 250ms 轮询回调不会再排第二次刷新，精确计数
  断言才稳。

它只关监听、不改断言：去抖「3 次合并成 1 次」和
`does not notify listeners ...` 的精确计数断言照旧，因为这两条验的正是去抖逻辑，
放宽了就没价值。真事件由 `emitReftableChange` 显式注入，走的是同一条
`scheduleRefresh` 路径。

`reftableTablesListPath` 要判空再 `unwatchFile`：非 reftable 仓库里它是 `null`。

## Alternatives considered

- **把断言放宽成 `>= 1` / `toHaveBeenCalled()`**：否。那是上游
  `95cb6e5853` 的另一半，治的是同一条 race 的表症。去抖计数是本文件唯一能证明
  「多次事件合并成一次刷新」的地方，换成宽松断言等于用一个更弱的测试换掉一个
  更强的测试，而真正的病根（原生事件迟到）还留着。
- **只 `provider.dispose()` 再重建**：否。用例需要活着的 provider 才能读到内部
  `reftableWatcher` 并 `emit`，dispose 之后 watcher 是 `null`，
  `emitReftableChange` 的断言直接挂。
- **在 src 里给 provider 加一个「不装原生监听」的构造参数**：否。为了测试给
  生产类开一个开关，等于把一个只在测试里有意义的维度塞进公开契约。
- **给轮询加一个测试开关**：否，见上一条，那等于把测试债转进产品代码。测试本来
  就用 `as unknown as` 读私有字段，follow 现有惯例成本更低。
- **不修，等 CI 真红**：否 —— 这次的起因就是它在全量里红了。

## Consequences

- 三条用例对并行负载免疫：假时钟两条自己决定事件；真事件那条仍由真实 fs 事件驱动
  第一次刷新，只是不再容忍迟到的第二次。
- 断言没有放宽：`updates the cached branch` 仍是 `toHaveBeenCalledTimes(1)`。
  在断言前注入一次 `scheduleRefresh()`，计数立刻变成 2，说明精确计数还有价值。
- 代价是这条 helper 依赖 provider 的私有字段名（`headWatcher` /
  `reftableWatcher` / `reftableTablesListWatcher` / `reftableTablesListPath`），
  用 `as unknown as` 强转。字段改名时这里不会编译报错，只会静默失效 —— 读这段时
  留意 `close()` 是否还真的关掉了东西。
- 真事件用例摘完监听还要继续用 provider，所以 `emitReftableChange` 从「断言
  `reftableWatcher` 非空」改成「为空就静默返回」，否则那条用例自己会挂。
- helper 刻意不把字段置空、也不摘 head 的 `watchFile` 轮询：`updates the cached
  branch` 那条用例摘完监听还要读 `getGitBranch()`，而 head 轮询正是它读缓存分支
  之外的兜底源。试过一并摘掉，两条假时钟用例立刻变成稳定失败（`execFile` 0 次）。
