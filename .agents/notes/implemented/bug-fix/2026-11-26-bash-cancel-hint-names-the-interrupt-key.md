# Agent Note: `!` 命令的取消提示指向真正生效的键位

Status: implemented

## Problem

两处文案把「取消正在跑的 bash 命令」写成了错误的键：

- `bash-execution.ts` 的 loader 用 `keyText("tui.select.cancel")`，默认 `escape` + `ctrl+c`。
- `interactive-mode.ts` 重复 `!` 时的警告硬编码 `Press Esc to cancel it first.`

实际取消走 `app.interrupt`（默认只有 `escape`，`custom-editor.ts:171` 和 `interactive-mode.ts:2568` 都在这条路上）。默认键位恰好都以 `escape` 开头，所以缺陷平时看不见；用户一旦把 `app.interrupt` 改成别的键，提示就指向一个不生效的键——而 `ctrl+c` 在编辑器里是 `app.clear`，按下会清空输入而不是取消命令。

## Decision

两处都读 `keyText("app.interrupt")`：loader 文案 `Running... (<键> to cancel)`，警告 `A bash command is already running. Press <键> to cancel it first.`

`keyText` 读全局 `getKeybindings()`，该实例由 `startup-ui.ts:44` 和 `interactive-mode.ts:614` 的 `KeybindingsManager.create()` 设置，已经带上用户配置；所以 remap 后提示自动跟上，不需要额外的配置点。

代码改动随 #813 的上游 backport 进入 `main`（`8a6a081dd`）。那次 backport 只带代码，没有测试钉住键位来源：把 `app.interrupt` 换回 `tui.select.cancel` 编译和现有测试都不会响，而默认配置下两者显示同一行字。所以本改动只剩测试和这篇记录。

## Alternatives considered

- **保留 `tui.select.cancel`，只在文案里说明「两者默认相同」**：默认相同正是缺陷藏起来的原因；remap 之后提示继续错，等于把一次性的可见错误换成永久的静默错误。
- **新增一个 `bash.cancel` 绑定**：bash 取消没有独立键位，它走的就是中断；多加一个绑定要吃 `keybindings.json` 的迁移、冲突检测和文档，收益只是名字更贴合。

## Consequences

- 默认配置下文案不变（都是 `escape`），只有 remap 之后行为不同。
- loader 文案和这条警告同源，也和 `status-indicator.ts`、`interactive-mode.ts:1982` 的既有多处 `app.interrupt` 提示一致。
- 回归测试是断言「两个默认值相同」之外的那一半：remap 之后提示必须换键。没有它，这个缺陷的下一次回退不会有人发现。

## Testing

`packages/coding-agent/test/bash-execution-loader-hint.test.ts` 把 `app.interrupt` remap 成 `ctrl+x`，起组件渲染 loader 行，断言出现 `ctrl+x to cancel`、不出现 `ctrl+c to cancel`。反向断言同时覆盖了「提示不能来自 `tui.select.cancel`」。
