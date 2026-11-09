# Agent Note: session 重写是一次 rename，不是原地截断

Status: implemented

## Problem

同一个文件有两种写法。`SessionManager._rewriteFile()` 走
`openSync(file, "w")` 原地截断再逐条写；`appendCompaction()` 走 tmp +
`renameSync`。#617 记下了这个不一致，同时撤回了原报告里"信号打断会留半文件"这条
——`O_TRUNC` 在 open 时刻生效，之后每次 `writeFileSync` 是独立写，信号只会让内容
停在合法前缀。

真实风险只剩进程崩溃（SIGKILL、断电、OOM kill）落在写循环中途：文件已经被截断，
只写回了一部分，session 被静默截短。触发面不小 —— `_rewriteFile()` 有三个调用点
（`_setSessionFile` 初始化空文件、`_loadEntries` 的版本迁移、`branch()` 落盘新分支），
迁移那条尤其危险：它恰好发生在打开历史 session 的时刻，重写失败就把历史截短。

所以这次不是"顺手统一写法"，是 `_rewriteFile()` 单独有缺陷。

## Decision

抽 `writeEntriesAtomically(file, entries)` 一处实现，两条路径都走它：

- 临时文件放在目标同目录（`rename` 只在同一文件系统内原子），名字带 pid 加
  `randomUUID()`，并发写不会互撞。
- 写完才 `rename`；失败路径 `rmSync(..., { force: true })` 清临时文件再抛。
- compaction 那里原本自己拼一遍 `lines.concat(...)`，改成把"被重挂的 kept 条目 +
  新 compaction 条目"组成数组交给同一个函数，不再写第二份序列化。

## 被否掉的路

- **只改 `_rewriteFile()`，把 compaction 留在原地**：那样就是两份 tmp + rename，
  下次改命名或清理规则要改两处。抽函数只多一行调用，成本低于留两份。
- **算好整串再 `writeFileSync(file, content)`（不带 tmp）**：确实消除了"写了一半"
  的窗口，但仍然是 `O_TRUNC` 之后才写 —— 崩溃点从循环中间挪到了写中途，文件反而
  更容易变成空文件。rename 是唯一能保证"要么旧的、要么新的"的写法。
- **`fsync` 之后才 rename**：能再挡住掉电丢数据，但每次重写多两次 fsync 系统调用，
  而 session 文件不是数据库。崩溃后拿到旧的完整文件已经够用。

## 代价

重写多一次 `write` + 一次 `rename` + 目录项更新。`_rewriteFile()` 只在初始化、
版本迁移、branch 时跑，不在每次 append 的路径上，这个开销看不见。

## 验证

`test/session-manager/atomic-rewrite.test.ts` 断言重写后 inode 变了 —— 原地截断会
保留 inode，rename 才换。这条测试对旧实现是红的（实测 `expected 51564092455 not to
be 51564092455`），对新的绿。临时文件残留也一并断言（目录里只有 `session.jsonl`）。
