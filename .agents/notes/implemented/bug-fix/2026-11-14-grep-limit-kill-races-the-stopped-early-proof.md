# Agent Note: grep 的 limit kill 与 stoppedEarly 证据抢同一根管道

Status: implemented

## Problem

`grep` 工具在匹配数刚填满 `limit` 的那一刻就 `killChild(true)`。它随后要读的两样东西
都还在 ripgrep 的 stdout 里排队：

1. 最后一条被允许的匹配的**尾部 context**（`trailingContextEnd` 窗口内的 `context` 事件）；
2. 证明「结果被砍掉了、后面文件没搜完」的那条事件（`stoppedEarly` 的来源）。

SIGTERM 之后这些字节有没有来得及被 readline 读走，取决于调度和管道缓冲。于是同一份
fixture、同一份代码，`packages/coding-agent/test/tools.test.ts` 的 "should mention individual files when the
global match limit stops the walk" 会时过时不过：

```
AssertionError: expected 'f4.txt:1: match\n--\nf3.txt:1: match…'
  to contain 'Search stopped early'
```

复现：`pnpm exec vitest --run test/tools.test.ts -t "global match limit stops the walk"`
串行跑 30 次全过，但 6 路并发跑 36 次挂 2 次、跑 60 次挂 24 次 —— 正是 issue #747 里
「全量跑偶发、单跑不复现」的形状。

## Decision

把 kill 点从「填满 limit 的那条匹配」挪到「证据到手的那一刻」：

- `recordMatch` 返回 `false` 时只把最后一条匹配连同它的前导 context 打出来，
  **不再 kill**。此时没有任何东西证明后面还有结果。
- limit 之后的流由原有的 `trailingFile` / `trailingContextEnd` 窗口判断处理：
  窗口内的行照旧当尾部 context 打印；窗口**外**的事件说明这条结果属于被砍掉的匹配，
  不打印。
- 只有窗口外的 **match** 才算证据，才置 `stoppedEarly` 并 `killChild(true)`。
  context 行不算：ripgrep 先发匹配的前导 context 再发匹配本身，把一条 context 当证据
  会提前 kill 掉正要说明它的那条匹配。

与旧行为的差别只有一处，而且正是缺陷所在：kill 晚发一步，改为由证据驱动。

## Alternatives considered

- **`close` 回调里先 `flush` 再 `rl.close()`**：看着像在修管道丢数据，其实是另一个问题。
  readline 在子进程退出前已经把数据交给我们了，丢的是 kill 之后**根本没写出**的字节，
  不是缓冲区里没读的字节。改这里不会让失败的用例变绿。
- **只在填满时不 kill、永不主动 kill**：结果正确，但被 limit 截断的搜索会把整棵树扫完，
  大仓库上等于把省下来的 time 全还回去，而且 `stoppedEarly` 只是晚知道。kill 必须留着，
  只是要等到能证明它该停的那一刻。
- **在 `!accepted` 分支里给尾部 context 一个固定的等待窗口（如几毫秒）再 kill**：
  把竞态换成延时。负载高时还是会输，且给每次 limit 命中都叠一段白等的延迟。
- **改测试去等一个稳定的断言（比如只断言 limit 提示）**：会把一条真实的行为断言删掉
  来迁就实现。`stoppedEarly` 是给模型看的「后面没搜」信号，不是可选的装饰。

## Consequences

- `packages/coding-agent/test/tools.test.ts` 那条用例从「偶发」变成稳定通过，同时成为这个竞态的回归测试
  （注释里标了 #747）。修复前 6 路并发 60 次 24 挂，修复后同样 60 次 0 挂。
- 用户可见行为不变：同一份 fixture 在修复前后的输出逐字节相同（`stoppedEarly` 只在真
  跨文件截断时出现，同文件内被 limit 截断仍不报）。
- 被 limit 截断的搜索现在会多读到「第一条证明被截断的事件」为止，代价是一两条额外事件
  的读取，换来确定性。
- ripgrep 缺失、走进程内 walker 的那条路径不受影响：它没有子进程可杀，`stoppedEarly`
  本来就在 `recordMatch` 的 `onLimit` 回调里同步置位。
