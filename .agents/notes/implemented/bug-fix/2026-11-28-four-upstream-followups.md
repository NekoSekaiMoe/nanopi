# Agent Note: 四个上游跟进提交并入生成式模型目录

Status: implemented

Ref: shinytale/agent/nanopi#883

## Problem

Issue #883 要求把上游 `22f5f2995`、`e459be65a`、`d5b453814`、`e3c632633` 落到 nanopi。前三个提交的上游形态是 `packages/ai/catalog/providers/*.ts`，而 nanopi 的模型元数据由 `packages/ai/scripts/generate-models.ts` 从 models.dev 生成，并在生成后统一补 compat / thinking / promptCache；第四个提交只改 `/bug` 文案。

三个 catalog 提交在本地都有对应行为缺口：

- Qwen Token Plan Individual 的 allowlist 还钉着 `qwen3.8-max` 一代，没有上游已经 GA 的 `qwen4-max`。
- Together 的 gpt-oss 与 DeepSeek V4 Pro effort 覆盖仍指向 catalog 已跳过的旧模型，当前 reasoning 模型只剩 Together toggle 一种控制方式。
- GitHub Copilot 上改 thinking level 或工具集会改写顶层请求字段、丢掉整个 prompt cache；Claude 也没有声明缓存寿命，缓存预热不会运行。

`/bug` 文案没有可落点：本地在 `4a63377b6` 已删掉 `/bug` 命令和它的上报链路，改成指向 GitHub issue 模板；`e3c632633` 改的是同一段已被移除的提示。

## Decision

把三个模型提交翻译成生成器的输入，而不是把上游 catalog 文件复制进仓库：

- Qwen：把 `qwen4-max` 加入 Individual allowlist，并把 `qwen4-max-preview` 加进排除集；测试期望同步更新。Cloudflare 默认模型已经在 `9108211ec` 改成 `@cf/zai-org/glm-5.3`，不重复改动。
- Together：删掉两个 effort compat、两个模型集合和两个 thinking level map；任何列出的 reasoning 模型都走 Together toggle。服务端已 deprecated 的模型由 models.dev 的 `status` 过滤挡在目录外，不在本地硬编码 id 白名单。
- Copilot：在 `generate-models.ts` 里给 Copilot 的 Claude 打开 mid-conversation effort 与 tool changes，并给所有 Copilot Anthropic 模型声明 300/3600 秒 promptCache；GPT-6 家族打开 mid-conversation effort，GPT-5.3 Codex 与 MAI-Code flash 打开 mid-conversation system messages。同步把 Fable 5.2 纳入上游 `supportsClaudeMidConvoEffort` 和 `supportsClaudeMidConvoChanges` 的正则，避免本地旧正则漏掉这个已存在的模型。目录标记之外，`openai-responses.ts` 与 `openai-responses-shared.ts` 也实现 `configuration_update`：请求级 `reasoning.effort` 固定为 medium，历史回复按 `providerThinkingLevel` 插入更新项，当前 effort 追加在末尾。
- `/bug`：不移植文案。重新引入 `suggestBugReport()` 会指向一个本地不存在的命令；保留当前启动提示和 issue 模板链接。

## Alternatives considered

- **整包 cherry-pick 四个上游提交**：上游树是 `catalog/providers/*.ts`，本地是生成器 + gitignored shards；直接 pick 会把上游 provider 结构带进来，且重新生成后全部丢失。
- **直接改 `packages/ai/src/providers/github-copilot.models.ts` 等生成物**：这些文件被 gitignore，下一轮 `pnpm run generate:models` 会覆盖，无法作为交付改动。
- **在 Copilot 上继续按旧规则拒绝 tool-change 块**：上游 2026-11-23 实测 Opus/Sonnet/Haiku 5.5 已接受 `tool_addition`/`tool_removal`，继续走顶层 tools 重写会在每次工具集变化时丢缓存。
- **为 Together 保留按 id 的 effort 适配**：这些 id 已从当前 catalog 跳过，保留只会让生成结果和测试围绕不存在的模型打转。
- **为 `/bug` 文案加一个本地等价提示**：`/bug` 命令与上报链路已删除，任何指向它的提示都会把用户引到无效命令；改写成 issue 模板链接属于另一个产品决定，不在本次 pick 范围。

## Consequences

- Qwen Individual 目录现在暴露 `qwen4-max`，测试钉住 allowlist 与生成目录一致。
- Together 的 thinking toggle 覆盖所有当前 reasoning 模型；旧 effort 映射不再影响目录。
- Copilot Claude 在 thinking level / 工具集变化时保留 prompt cache，并获得缓存预热；GPT-6 与少量 Copilot 专属 Responses 模型获得 mid-conversation 行为。OpenCode 的 Claude tool-change 拒绝规则保持不变。
- 上游 `/bug` 文案未落地；本地仍通过文档和 GitHub issue 模板指向反馈入口。
