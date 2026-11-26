# Agent Note: models.json 的错误在所有模式都上报

Status: implemented

## Problem

`models.json` 读坏（语法错、读失败、schema 不通过）时，`ModelRuntime` 不抛异常：`ModelConfig.load()` 把原因存进 `config.getError()`，provider 组合失败进 `compositionErrors`，被跳过的 model 进 `skippedModels`，三者最后都从 `getError()` / `getWarnings()` 出来。

改之前只有一个地方读它们：`InteractiveMode` 在 TUI 里画出来（`interactive-mode.ts:1115` 的 `models.json error:` 前缀、`:5967` 的 reload 路径）。于是 `-p` / `--mode json` / `--mode rpc` 三种模式下，坏掉的 `models.json` 完全静默——用户看到的是「没有可用模型」，看不到任何指向文件的线索。`--list-models` 有自己的上报（`cli/list-models.ts:58`），其余非交互路径没有。

## Decision

修法落在 `createAgentSessionServices()`：组装完 provider 后把 `modelRuntime.getError()` 作为一条 `warning` 推进 `services.diagnostics`，文案前缀 `models.json error: `。

选这里而不是 `main.ts` 有两层原因：

- `services.diagnostics` 是 SDK 侧唯一的诊断出口，`createAgentSessionServices()` 的每个调用方都拿到，不依赖 CLI 的 `reportDiagnostics()`。
- 非交互模式本来就把 `runtime.diagnostics` 打到 stderr（`main.ts` 的 `appMode !== "interactive" || hasRuntimeErrors` 分支），所以 print/json/rpc 一次性补齐，不用逐个模式加代码。

`type: "warning"` 是刻意的，不是笔误：`error` 会进 `hasRuntimeErrors`，而 `main.ts` 在 `hasRuntimeErrors` 时 `process.exit(1)`。`models.json` 读坏不等于无法工作——`auth.json` 里的凭据仍可能配上某个内置 provider——所以这次只补可见性，不动退出码契约。

## Alternatives considered

- **在 `main.ts` 的 diagnostics 数组里再补一份 `getError()`**（本 Issue 最初的方案）：`createAgentSessionServices` 已经写了一条，再加一条就是同一条消息两条 `models.json error:`，`deduplicateDiagnostics()` 只在 type 和 message 都相同时才合并，两份会同时出现；SDK 调用方也拿不到。这条是实际踩到的：先按它写过，被已有的 print/json/rpc 断言挡下（期望 1 次、实际 2 次）。
- **改成 `type: "error"`**：所有非交互模式因为一个可以绕过的文件错误 `exit(1)`，比静默更糟——用户失去 `auth.json` 那条恢复路径。
- **改 `collectSettingsDiagnostics` 一类的地方**：那是 settings 的通道，models.json 的上报属于 runtime 组装，混进去会让 settings 诊断不再只覆盖 settings。

## Consequences

- 三种非交互模式首次有 models.json 的可见线索；交互模式的行为不变（它本来就画自己的那份，而交互模式不打印 `runtime.diagnostics`）。
- SDK 调用方（`createAgentSessionServices` 的直接用户）也会在 `services.diagnostics` 里看到这条；这是有意的，否则 SDK 里的静默问题只是被挪了个位置。
- 一个仍然存在的小缺口：`interactive-mode.ts:5967` 那处 reload 提示是手写的 `models.json error:` 文案，和这里不是同一个出口，改文案要改两处。

## Testing

`packages/coding-agent/test/models-json-error-diagnostic.test.ts` 钉住四件事：`services.diagnostics` 里恰好一条 `models.json error:` 且 `type` 是 `warning`；print / json / rpc / `--list-models` 四种调用下 stderr 各出现一次、且 JSON 与 RPC 的 stdout 不被污染。
