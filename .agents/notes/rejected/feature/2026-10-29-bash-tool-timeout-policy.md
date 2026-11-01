# Agent Note: bash 工具的超时策略（不加默认上限）

Status: rejected — 静默默认值会把长任务误判成超时，逃生口已经由 `/kill-bashbg` / `bash_bg` 提供，不再给 `bash` 加默认上限。

## Problem

`bash` 工具的 `timeout` 参数没有默认值，子进程自己永不退出时调用会一直等下去。

`packages/coding-agent/src/core/tools/bash.ts` 里三层一致地表达"没默认值"：

- `resolveTimeoutMs()` 在 `timeout === undefined` 时直接 `return undefined`；
- `exec()` 只在 `if (timeoutMs !== undefined)` 时 `setTimeout`；
- schema 描述原话是 `Timeout in seconds (no default)`。

所以 `bash({ command: "sleep 9999" })` 不会超时。唯一的出口是调用方传 `timeout`，或者外部
`abort` 触发 `killProcessTree()`。

## Proposal

给 `timeout` 加默认上限，超时后按现有形态返回 `timeout:<seconds>` 错误。

比默认值更难定的是后者：一个静默 30 秒被截断的 `pnpm build`、`pnpm test`，对调用方来说是
"命令失败"，不是"超时"。三件事必须先定下来：

1. 默认值取多少。30s 会打断正常构建，120s 又不比现在安全多少，长任务（装依赖、跑测试）总得
   显式声明。
2. 超时的错误形态。现有 `throw new Error(\`timeout:${timeout}\`)` 只给出"超时了"，不给出"是哪
   个 timeout 生效的"。默认值生效时，调用方看不出这是自己忘了传还是默认值到了。
3. 静默截断的影响面。默认值一旦生效，所有没传 `timeout` 的既有调用（含 webui 与 RPC 侧的
   bash 转发）都会继承新语义。

## Alternatives considered

### 维持现状：schema 说清楚就够

`bash.ts:43` 的 schema 已经写明 `(no default)`，`abort` → `killProcessTree()` 也留着。最强的
理由是它把"无上限"变成一个显式契约：调用方要么自己给预算，要么承认自己接受无限等待。代价
是一个忘传 `timeout` 的调用会挂到进程被杀为止，而模型侧对新工具很容易忘参数。

### 只给模型侧系统提示里加一句提醒

不动代码、不动契约，只在 tool 描述里补一句"长命令请传 timeout"。问题是它和 schema 现在那句
`(no default)` 是同一件事，只是更啰嗦；模型该忘还是会忘。

### 在 `waitForChildProcess` 侧加空闲超时

已经有 100ms 的 exit 后空闲宽限，把它放大成一个可配的上限，就能杀掉"子进程 exit 了但后代一直
占着管道"的情形。但这类情形本来就不会挂死（宽限到点就 finalize），它解决不了一个从不 exit 的
进程。

### 靠 `bash_bg` / `/kill-bashbg` 兜住（采纳）

`extras/pi-smart-flow` 已经提供另一条出口：`bash_bg` 的 `action=run` 阻塞到 `timeout` 就自动
转后台并返回 `jobId`，之后由用户用 `/kill-bashbg`（无参数杀全部、`<jobId>` 杀一个、`list` 列出）
或模型用 `action=kill` 收尾。这条路把"何时停"交回调用方与用户，工具本身不需要猜一个上限：

- 默认值要同时对"跑得慢"和"卡住"给出同一个答案，而这两者在工具侧不可分辨；`bash_bg` 只需要
  知道"还没结束"，语义上不含猜测。
- `/kill-bashbg` 是人的出口，不依赖模型记得传参；模型侧则用 `bash_bg` 显式声明预算。
- 代价是 `bash` 的既有契约不变：忘传 `timeout` 又用内建 `bash` 的调用仍会挂到进程被杀为止。
  这一点保留为显式契约，不靠默认值兜底。
