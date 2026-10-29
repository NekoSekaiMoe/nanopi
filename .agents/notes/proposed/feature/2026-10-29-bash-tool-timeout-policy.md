# Agent Note: bash 工具的超时策略（无默认值，待定）

Status: proposed

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

## Acceptance criteria

- 未传 `timeout` 的 `bash` 调用在一个明确的默认上限后结束，并交出可分辨的超时结果。
- 显式传 `timeout` 的行为不变，`MAX_TIMEOUT_SECONDS` 仍按现在的方式校验。
- 长任务（`pnpm build` / `pnpm test`）在默认值下不被误杀，或者它们都显式传了 `timeout`。

## Risks

- 默认值会改变所有未传 `timeout` 的调用方语义，包括第三方 extension 的 `bash` 转发。
- 超时淘汰掉的是"命令确实很慢"还是"命令卡住了"，工具侧分不出来；错误信息说得再清楚，用户仍
  要自己判断该不该加时间。
- 现状下"不设默认值"是有意为之，改它属于改契约，不是补 bug；一旦合入就不能再靠 schema 一句
  话回退。
