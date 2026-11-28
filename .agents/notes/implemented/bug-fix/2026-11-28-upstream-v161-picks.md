# Agent Note: 上游 v1.6.1 的五处缺陷移植

Status: implemented

Ref: shinytale/agent/nanopi#883

## Problem

Issue #883 要求从上游 `v1.6.1...main` 挑出值得移植的修复。对 137 个 first-parent 提交逐条对照本地代码后，选出五处 nanopi 上确实存在、且与本地结构兼容的缺陷（上游 `41da1a524`、`e4ed3d610`、`27157503e`、`596540d43`、`b882d08f3`）。其余提交分两类：一类在本地没有对应模块（p2、durable、Ant Ling、Bedrock Kimi/GLM、Radius、`/llama`），一类是新功能或协议（OSC 7577 resume、`--agent-dir`、pi-image API），不在缺陷移植的范围内。

五处缺陷的共同点是本地和上游有同源代码，但分叉后各自演进，直接 cherry-pick 会带入上游包布局与本地不一致的部分。

## Decision

按缺陷逐项改写本地对应文件，保留 nanopi 的包名和构建配置，不引入上游的 p2 宿主或 finish-reason 工具模块：

- HTML 导出：`packages/coding-agent/src/core/export-html/index.ts` 的十处 `String.replace` 全部改为函数替换。字符串替换会展开 `$$` 和 `$&`，而 `template.js` 里的费用行写成 `$${totalCost.toFixed(3)}`、`highlight.min.js` 也含这两个模式；函数替换按原文插入。CSS 的四处一并改，避免将来 CSS 值含 `$` 时重复踩坑。
- WSL 检测：`packages/coding-agent/src/utils/wsl.ts` 的 `isWSL(platform, env)` 成为唯一判据，先看 `WSL_DISTRO_NAME` / `WSL_INTEROP` / `WSLENV`，再回退 `/proc/version`；非 Linux 直接 false。footer 的 `/mnt/<drive>` 分支轮询、keybindings、两个剪贴板模块都调用它。上游的 p2 宿主在本地不存在，不移植那部分。
- 自动补全：`packages/tui/src/components/editor.ts` 抽出 `confirmAutocomplete()` 与 `applySelectedCompletion()`，`tui.select.confirm` 与 `tui.input.tab` 共用；`CustomEditor` 在 `app.message.followUp` 分支先调用 `confirmAutocomplete()`，返回 `"applied"` 时不提交，返回 `"submit"` 时按原流程提交。这样 Alt+Enter 对斜杠命令名菜单与 Enter 行为一致，对路径补全则先插入、再按一次才提交。
- OpenRouter 图像：`packages/ai/src/api/openrouter-images.ts` 检查 `choices[].error`、顶层 `error` 与非 `stop`/`end` 的 `finish_reason`，把错误以 `stopReason: "error"` 返回；`parseUsage()` 调用 `applyOpenRouterReportedCost()` 应用 provider 上报的 `usage.cost`。本地没有 `openrouter-finish-reason.ts`，原生原因从 choice 上可选字段直接读取；`Usage.cost` 新增 `totalFromProvider?: boolean`，`applyOpenRouterReportedCost()` 在采用 provider 成本时置位，让调用方能区分账单值和目录估算值。
- 按键提示：`tui.input.submit` 用在 extension editor 与 session rename 的提交提示，submenu 提示读 `tui.select.confirm` / `tui.select.cancel`，`/hotkeys` 把取消自动补单独归到 `tui.select.cancel`，`SettingsList` 提示读当前绑定并保留字面 `space`（处理器直接匹配空格）。上游的 config selector 与 fullscreen 复制设置在本地已不存在，不移植。

## Alternatives considered

- **整包 cherry-pick 五个上游提交**：上游树有 p2、durable 与不同的导出接口，cherry-pick 会带入本地没有的包和未使用的 `openrouter-finish-reason.ts`。逐项改写只保留缺陷修复本身。
- **WSL 检测继续在各调用点分别判断**：env-only 检查在 systemd 用户服务启动的终端里失效，导致同一进程内剪贴板与按键/footer 判断不一致；集中到 `isWSL()` 是上游给出的修复，也符合本地已有的 `utils/wsl.ts` 归属。
- **Alt+Enter 无条件先提交补全**：文件补全的文本不该因为一次 Alt+Enter 直接入队；只有斜杠命令名完成时才提交，其余情况插入后仍需第二次提交。
- **图像生成继续忽略 `finish_reason`**：HTTP 200 下 `finish_reason: "error"` 会产生空输出但 `stopReason: "stop"`，调用方无法区分成功与拒答；provider 上报的 cost 被忽略则账目按目录估算值计，与 chat completions 路径不一致。
- **提示里硬编码 Enter / Esc**：键位改绑后提示会指向无效键，和已有的 `keyHint()` / `keyText()` 体系冲突。

## Consequences

- 导出 HTML 的费用行保留 `$`，内嵌脚本与原始文件逐字节一致；十处替换都使用函数形式，后续插入含 `$` 的文件也不会被改写。
- WSL 下无环境变量的终端现在能拿到 Windows 键位、`/mnt` 仓库分支轮询和正确的剪贴板路径；非 Linux 进程带 WSL 变量时不再误判为 WSL。
- Alt+Enter 遇到自动补全菜单时，行为与 Enter 一致：命令名补全后立即提交，其余补全插入文本后等待下一次提交。
- OpenRouter 图像生成的 HTTP 200 错误不再伪装成成功；账单成本进入 `usage.cost.total` 并标记 `totalFromProvider`，历史 usage 的该字段缺省仍能按目录估算值解释。
- 按键提示跟随键位重绑，测试覆盖 `packages/coding-agent/test/` 与 `packages/tui/test/` 下对应回归用例。
