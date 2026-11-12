# Agent Note: 会话列表与 read 工具的读取流不再持有 abort signal

Status: implemented

## Problem

两处 `createReadStream` 把调用方的 `AbortSignal` 直接交给流，而这两处都会在文件
读完之后提前结束循环，流本身却还开着。之后任何一次 abort 会 destroy 这个流并发出
`'error'`，此时已经没有监听者，未捕获的 `AbortError` 直接把进程带走。

**会话列表**（`packages/coding-agent/src/core/session-manager.ts` 的 `buildSessionInfo`）：
`.jsonl` 首行不是 session 头就 `return null`，readline 提前退出、流没读完。
之后选择器 abort（选中、取消、退出、改名、删除、刷新都会），进程崩。
最小复现：一个不足 1KB 的非 session `.jsonl`，读完首行后 abort → `UNCAUGHT AbortError ABORT_ERR`。

**read 工具**（`packages/coding-agent/src/core/tools/line-reader.ts` 的 `readLinePage`）：
信号在迭代器挂上之前就已经 abort 的话，流在构造函数里被 destroy，`'error'` 晚一拍
发出、无人监听。这条依赖时序，不容易稳定复现，但失败形状一样。

## Decision

两处都不再把 signal 传给 `createReadStream`，改由读循环自己检查并负责结束流：

- 会话列表：循环里 `signal?.throwIfAborted()`；readline 与流在 `finally` 里
  `rl.close()` / `stream.destroy()`；读完文件后再来一次 `signal?.throwIfAborted()`。
- read 工具：`for await` 里 `signal?.throwIfAborted()`，原有的 `finally { stream.destroy() }`
  保持，文件句柄照旧关。

「被取消的列表仍然 reject」是既有契约（`SessionManager.list` 的调用方靠它区分
超时与空目录），所以 check 放在 **循环里和循环之后** 两处：只放循环里，文件读完的
那次 abort 会被 `return` 吞掉，`file-operations.test.ts` 的
「rejects a cancelled session listing」当场变红。

`ReadOperations.createReadStream` 这类公开签名没变，`read` 工具外层那条
`signal?.addEventListener("abort", ...)` 也没动，取消依然是立刻 reject。

## Alternatives considered

**给流挂一个 `'error'` 监听吞掉 `AbortError`。** 改动更小，但要把「这个错误是不是
我们自己 abort 造成的」判断一遍，而且流仍然在有 signal 的情况下被 destroy，
下一次调用方换个结束路径就又会漏。让流完全不持有 signal，错误就没有产生的地方。

**abort 时 `rl.close()` 再 abort。** 需要调用方知道内部流的生命周期，等于把关闭
责任推给几十个调用点（交互式选择器、`/resume`、`/import`、扩展的 `switchSession`）。
读完就关的 `finally` 只有一处。

## Consequences

收益：两条崩溃路径消失，且不再依赖「谁先 abort、流读到哪」的时序。

代价：abort 现在最多晚一个 chunk 才被发现（读循环的检查点），不再有
`createReadStream` 内部的即时中断。对一个本地文本文件的读来说这点延迟不可见。

回归测试：`packages/coding-agent/test/session-manager/listing-abort.test.ts`（非 session
文件读完首行后 abort，进程不受影响）和 `test/tool-streaming-reads.test.ts` 里
「rejects an aborted read with AbortError instead of crashing the process」。
两条都先对着未修的代码跑过：前者在未修时会让测试进程带 `UNCAUGHT AbortError` 退出，
后者在未修时同样触发未捕获的 `AbortError`。
