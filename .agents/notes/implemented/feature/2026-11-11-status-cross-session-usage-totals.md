# Agent Note: `/status` 显示跨会话累计用量

Status: implemented

## Problem

`/status` 与 `/session` 只报当前会话。想知道「这个月花了多少」「缓存命中率有没有在掉」，
得自己翻 `~/.nanopi/agent/sessions/` 下的 JSONL 再算。数据其实都在：

- 每个响应落盘时带 `usage`，assistant 消息上还有 `provider` / `model` / `responseModel`；
- `core/usage-totals.ts` 的 `getUsageCostBreakdown` 已经把四类来源（assistant 消息、
  `usage` entry、toolResult、compaction/branch_summary）的归并规则写好了。

缺的只是「把 entries 换成整个 sessions 目录」。

## Decision

`/status` 多一行 `Usage totals`：

```
Usage totals:   1.2M tokens, $12.34 over 143 sessions (902 responses), cache hit 61.2%
```

- 数值来自 `core/usage-ledger.ts` 的 `UsageLedgerIndex`：扫 `<agentDir>/sessions/<encoded-cwd>/*.jsonl`，
  每个文件折叠成一条 `{totals, responses, models}` 记录，`totals()` 只做累加。
- 归并规则复用 `addUsageToTotals`，与 `getUsageCostBreakdown` 一致，因此模型数能与 `/session`
  的分模型视图对账。
- **增量靠 stamp，不靠 watcher。** 每次 `refresh()` 全量 `stat`，只重新解析 size 或 mtime 变了的文件。
  会话文件几个月能长到几百 MB，每次全读会让 `/status` 变慢。
- **不进后台进程、不落第二份数据库、不起 web server。** 索引只活在当前进程里，条目都是一个文件的汇总。
- **对话框不等它。** handler 先 `getUsageLedger()`（首次要等一遍扫盘），TUI 下把一次后台刷新
  留给 `startUsageLedgerRefresh`：刷新完成时用 `StatusDialogHandle.refresh()` 原地重画，行内容从
  `indexing...` 变成真实数字。非 TUI 的一次性输出没机会重画，所以必须同步等。
- 解析按 8 个文件一批，批之间 `setImmediate`，避免一个超大会话文件把输入卡住。

## 指标取舍

- **tokens / cost / 缓存命中率**：算得准。`cacheRead / (input + cacheRead + cacheWrite)`。
  没有任何文件上报缓存时输出 `cache not reported`，而不是一个会被误读成「全 miss」的 `0.0%`。
- **cost 是历史价**：`usage.cost` 是写入当天按当时目录价算的，不是今天的报价。
- **不给错误率**：JSONL 里没有「请求发起次数」，重试和失败请求大多不进会话文件。能算的只是
  「会话最后一条 assistant 消息 `stopReason === "error"` 的占比」，和用户理解的错误率不是一回事。
  宁可少一个数，不要一个会被误读的数。
- **不给 tokens/s**：`durationMs` 是按消息计的瞬时值，跨会话只能出分位数，而出分位数的口径
  （哪些消息算数、旧消息缺 `durationMs` 怎么处理）需要单独定义，这一版没做。

## Alternatives considered

**立一条 `nanopi usage` CLI 子命令。** 议题里的首选形状。否决理由：用户明确要「加在 /status 里就行」；
而且一次性的 CLI 反而需要自己定义时间窗（`--since`）、`--json` 输出契约和排序规则，
`/status` 只要一行文本，展示面小得多。

**每次打开都全量解析。** 最简单，也最诚实。否决理由：几百 MB 的 JSONL 全读一遍要几秒，
`/status` 是个随时会按的键。stamp 比较的代价是每个文件一次 `stat`，而 `stat` 加起来是毫秒级。

**后台 watcher + 常驻缓存文件**（omp `stats` 的形状）。否决理由：`stats` 那套是 38k 行、
依赖 `bun:sqlite` 的产物，nanopi 跑 Node，拿不了；watcher 还要求进程常驻。现在的做法把
「多久刷新一次」交给用户按 `/status` 的频率，不引入新的生命周期。

**把 ledger 放进 `core/usage-totals.ts`。** 那个文件是纯函数（entries 进、数字出），
加文件 I/O 会让它不能再被 compaction 之类只需要计算的路径复用。新开 `usage-ledger.ts`。

## Consequences

- 首次 `/status` 要等一遍扫盘；之后每次只 stat 一遍加解析变化的文件。会话多到一个临界点后，
  `getUsageLedger()` 的首次等待会变得明显——那是把索引搬到后台预热的信号，不是改校验逻辑的理由。
- `updatedAt` 取会话文件名里的启动时间（`SessionManager` 用它做 header timestamp），
  拿不到时退回最新 mtime。`loadEntriesFromFile` 不保留 header，所以不从文件内容取。
- 索引在进程内单例，按 sessions 目录区分；`agentDir` 变了会重新建。
- 新增的 `StatusDialogHandle` 是 `/status` 对话框唯一的对外句柄，其它命令要「打开后还能更新」
  可以直接复用 `refresh()`。

## Testing

- `packages/coding-agent/test/usage-ledger.test.ts`：跨项目目录求和、增量（只重解析 stamp 变了的文件）、文件消失后剔除、
  空/不存在的 sessions 目录、行文本的三种状态（indexing / no sessions yet / 真实数字）、
  「不报缓存」与「全 miss」的区分。
- `packages/coding-agent/test/status-command.test.ts`：`Usage totals` 行出现在 `Context` 与 `Memory` 之间。
