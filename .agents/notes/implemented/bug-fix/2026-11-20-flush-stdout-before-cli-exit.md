# Agent Note: 退出前排空 stdout 队列

Status: implemented

## Problem

`process.exit()` 不等待 stdout/stderr 的写队列。交互模式、`--resume` 选择器和启动选择器在 `ui.stop()` 后立刻退出时，终端恢复序列（光标、bracketed paste、Kitty keyboard、focus event）可能还留在队列里，进程一退就丢，用户回到一个没复位或还在鼠标跟踪的终端。

`main.ts` 的 startup benchmark 路径已有 `writableLength`/`drain` 等待，但只覆盖那一条返回路径，不是全局退出保障。

## Decision

新增 `flushStdout()`：只对当前有排队字节的 stdout/stderr 追加一次空写，用空写的回调确认前面的字节已落盘；整个等待用 1 秒超时兜底，临时挂 `error` listener 让死终端上的 EPIPE 不打断正常退出，结束后摘除 listener。

落地位置按本仓库退出路径选择，不照搬上游文件清单：

- `InteractiveMode.shutdown()` 的 signal 分支和正常分支在 `process.exit(0)` 前 await。
- `startup-ui.ts` 三个启动选择器的 finish 在 `ui.stop()` 后、resolve 前 await。
- `session-picker.ts` 的退出回调先 `ui.stop()`，再 flush 后退出。

crash / dead-terminal 的紧急退出路径不动；那些路径故意跳过终端恢复，不能排入新的写操作。

## Alternatives considered

- **直接 cherry-pick 上游 `7c05885bc`**：上游改 `cli/config-selector.ts` 等文件，本仓库没有同名结构；交互模式的 signal-exit / drainInput / runtime dispose 顺序也不同，硬贴会打穿现有恢复语义。
- **把 `main.ts` 的 `writableLength`/`drain` 抽出来全局复用**：只看 `drain` 在流已经不写时会永久等待，且无法覆盖 TUI 的 `process.exit` 调用点；空写回调是更稳的“队尾屏障”。
- **所有退出都 await 无限时长**：死终端会挂住进程；1 秒超时与上游一致，也符合“退出态最多等一小会儿”的边界。

## Consequences

- 正常退出和 signal 退出都给终端恢复序列一次排空机会；队列为空时直接返回，不增加延迟。
-  Writer 卡死最多多等 1 秒；EPIPE 期间不会触发额外的 crash handler。
