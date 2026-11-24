# Agent Note: 用隐藏内置模块把多次工具往返压成一次

Status: implemented

## Problem

ISSUE #803 讨论省钱手段时确认：model 每多做一次工具往返，就要把完整对话和工具 schema 再送一遍。
Maka 的 Code Mode 用一个脚本 cell 包住多次调用省掉这些 input，但 nanpi 当时没有对应工具。
此前 [#801] 否决的是「fork / QuickJS 脚本编排层」那条重路：要给脚本可见分级、`structuredContent`
直通、权限继承补四层契约，成本远大于收益。用户随后给出明确边界：只要一个默认 registry 里的
hidden module，`pi.registerTool` + `ctx.callableTools` 就够，不要新的执行引擎。

## Decision

`packages/coding-agent/src/modules/batch/index.ts` 作为内置模块注册 `execute_many` 工具，
通过 `ctx.executeTool()` 在一次 model 工具调用里跑一批「工具名 + 参数」，`parallel` 为真时并发。
每个调用走 agent 现有的工具 pipeline：同样的校验、hooks、权限检查，并记到调用方的 `nestedCalls`。
`ctx.tools` 只包含当前可调用的工具；不在其中的名字返回一个错误条目，不抛异常、不静默丢掉。

工具用 `exposure: "hidden"` 注册，默认不激活、不进 model 的工具声明，靠 `prepareLoadout` 把当前
callable 工具名写进自己的描述。模型看到的是一条描述，不用为发现工具多发一轮请求。
模块本身 `hidden: true`，不出现在 `/status` 的 loaded-modules 列表；构建上作为独立
`module/batch` 组件，跟随 `module/*` 的 flavor 规则。

## Alternatives considered

**fork 真 node 子进程跑编排脚本。** 最强理由：最接近正常 Node 脚本，中间状态和 `Promise.all`
都自然。否决理由：脚本能调工具就绕不开四层契约（脚本可见分级、结果形状、权限继承、审计），
为了把每次调用的 spawn 开销挪到每段脚本要做跨包改造，见
[不把 mcp shell 演进成 CodeMode 脚本编排层](../../rejected/architecture/2026-11-24-no-codemode-script-orchestration.md)。
本篇只取代那篇里「不做批量编排」的结论；脚本运行时与四层契约的否决仍然有效。

**用 `Node vm` 或 QuickJS/WASM 跑脚本。** 最强理由：能给定脚本更多隔离。否决理由：`vm` 不是安全
沙箱，同进程死循环卡死 agent；QuickJS 依赖已被删，且与 jiti 转译的 ModuleApi 不兼容。

**让 model 直接多次调用工具，不做 batch。** 最强理由：零改动。否决理由：N 次往返就是 N−1 次
完整 prompt 的 input，这是 #803 里 token 收益最大的一条，缺的正是一个入口工具。

## Consequences

- 一次 `execute_many` 的所有子调用共用调用方的 recorder 和 usage；子结果只在 batch 的返回文本里
  出现一次，不进 transcript 作为独立消息。
- 批量里的工具仍受 permission gate 约束，且顺序模式遇到 abort 会停下；`parallel` 模式已发出的
  调用靠各自的 signal 收尾，不回滚。
- 工具名随 `prepareLoadout` 写进描述，active 工具变化会改变描述，可能影响 Anthropic 的缓存前缀；
  与现有 subagent 的 `prepareLoadout` 做法一致。
- 验证：`packages/coding-agent/test/batch-tool.test.ts` 覆盖顺序/并发、未知工具、abort、隐藏暴露
  和 callable 名单描述。
