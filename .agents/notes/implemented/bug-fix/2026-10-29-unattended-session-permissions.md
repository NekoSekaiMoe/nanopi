# Agent Note: 无 UI 会话不再一律拒绝受门禁工具

Status: implemented

## Problem

权限门禁只按「有没有 prompter」判断能不能问：`session_start` 里 UI 不存在时塞一个恒返回
`undefined` 的空 prompter，`PermissionGate.settle(undefined)` 把它当成「弹窗被关掉」，于是
`{ action: "deny" }`。结果是 print 模式、`--output json`、以及每一个子代理（它自己就是一个
`--output json -p` 子进程，而 `CHILD_MODULE_SKIP` 不含 `extra`）里，`edit`、`write`、`bash`
全部被拒——子代理实质只读。

同一处代码还有第二层空转：`gate` 永远非空，`if (engine.yolo || gate === undefined …)` 里那段
`gate === undefined` 是死代码，看不出「没有 UI」这个前提从未被表达过。

## Decision

「能不能问」在 `session_start` 算一次，存成 `gated`：`ctx.mode === "webui" || ctx.hasUI`。
`tool_call` 用 `gated` 而不是 `gate === undefined` 决定是否走门禁。

- 有 UI（TUI/RPC）与 webui：行为不变，照常弹窗。
- 无 UI（print/json/子代理）：受门禁的工具直接放行。这类会话既弹不出弹窗，也没有输入框可敲
  「继续」，把它判成「用户拒绝了每一次编辑」是在替不存在的用户表态。

危险命令的护栏不因此消失：`git guard` 与 `shell guard` 都是 `tool_call` 里的独立判断，
在门禁之前执行，与 `gated` 无关。

## Alternatives considered

- **保持拒绝，靠文档要求 headless 用户加 `--yolo`**：`--yolo` 是 CLI 参数，子代理由
  `pi-subagent-mini` 拼命令行启动，用户没法给每个子进程补参数；而且它同时跳过 `project_trust`，
  语义远大于「这个会话没人能答弹窗」。
- **给无 UI 会话加一个可配的 `--allow-tools` 清单**：多一个开关就多一条要维护、要写文档、
  要测试面覆盖的路径，而默认值仍然要么全拒要么全放——真实诉求只是后者。
- **让空 prompter 返回 `allow` 而不是 `undefined`**：把策略藏在一个假装是 UI 的闭包里，
  下一个人读 `settle()` 依然看不出这是「没有用户」而不是「用户关掉了弹窗」。
- **子代理不加载 `extra` 模块**：那就连 `git guard`、`shell guard`、plan 模式的白名单一起丢了，
  等于用关闭护栏来换可用。

## Consequences

- 收益：子代理能改文件，print/json 会话能跑完整任务；`tool_call` 里「没有用户」这个前提是显式的。
- 代价：自动化会话里模型可以无确认地编辑和写文件。这是本仓库既有安全模型的一部分
  （`--yolo` 一直如此），差异在于它现在是默认，而不是需要用户记得加的参数。
- webui 不改：它的 prompter 走 `PermissionBroker`，卡片能等很久，不存在无人可问的情况。
