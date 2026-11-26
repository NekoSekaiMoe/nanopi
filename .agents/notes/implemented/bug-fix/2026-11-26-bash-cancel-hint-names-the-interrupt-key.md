# Agent Note: `!` 命令的取消提示指向真正生效的键位

Status: implemented

## Problem

`interactive-mode.ts` 重复 `!` 时的警告硬编码 `Press Esc to cancel it first.`

实际取消走 `app.interrupt`（默认只有 `escape`，`custom-editor.ts:171` 和 `interactive-mode.ts:2568` 都在这条路上）。默认键位恰好都以 `escape` 开头，所以缺陷平时看不见；用户一旦把 `app.interrupt` 改成别的键，提示就指向一个不生效的键——而 `ctrl+c` 在编辑器里是 `app.clear`，按下会清空输入而不是取消命令。

上游的同一处修复随 #813 先落到本仓库，改了 `bash-execution.ts` 那一行；这次补上 `interactive-mode.ts` 的硬编码文案，并给 loader 那一行补上回归测试——上游只改代码，没有测试钉住键位来源。

## Decision

警告改成 `` `A bash command is already running. Press ${keyText("app.interrupt")} to cancel it first.` ``，和 `bash-execution.ts` 的 loader 提示（`Running... (<键> to cancel)`）同一个键位来源。

`keyText` 读全局 `getKeybindings()`，该实例由 `startup-ui.ts:44` 和 `interactive-mode.ts:614` 的 `KeybindingsManager.create()` 设置，已经带上用户配置；所以 remap 后提示自动跟上，不需要额外的配置点。

## Alternatives considered

- **保留 `tui.select.cancel`（`bash-execution.ts` 原来的写法），只在文案里说明「两者默认相同」**：默认相同正是缺陷藏起来的原因；remap 之后提示继续错，等于把一次性的可见错误换成永久的静默错误。
- **新增一个 `bash.cancel` 绑定**：bash 取消没有独立键位，它走的就是中断；多加一个绑定要吃 `keybindings.json` 的迁移、冲突检测和文档，收益只是名字更贴合。

## Consequences

- 默认配置下文案不变（都是 `escape`），只有 remap 之后行为不同。
- loader 文案（`bash-execution.ts`）和这条警告从此同源，也和 `status-indicator.ts`、`interactive-mode.ts:1982` 的既有多处 `app.interrupt` 提示一致。

## Testing

`packages/coding-agent/test/bash-execution-loader-hint.test.ts` 把 `app.interrupt` remap 成 `ctrl+x`，起组件渲染 loader 行，断言出现 `ctrl+x to cancel`、不出现 `ctrl+c to cancel`。反向断言同时覆盖了「提示不能来自 `tui.select.cancel`」。
