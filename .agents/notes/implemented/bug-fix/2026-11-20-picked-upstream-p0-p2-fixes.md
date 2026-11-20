# Agent Note: 从 pi v1.6.0 挑回 P0/P2 缺陷修复

Status: implemented

## Problem

Issue #783 要求跟进 `earendil-works/pi` v1.5.2..v1.6.0。上游 369 个提交大多是另一个产品形态，按 commit 全量合并不可行；只有一批修复命中的是 nanopi 现有代码里的同一缺陷。逐条核对 changelog 和本地代码后，待修的是：

1. retry 分类器不认 `Connection closed.`、裸 Node socket code 和 `connection reset by peer`。
2. `openai-completions` 对非 OpenAI 官方 endpoint 默认发 `developer`，Groq Qwen 等模板回 400。
3. strict JSON schema 遇到无类型节点（`items: {}`、bare `const`）被 OpenAI 400 拒绝；非严格 Anthropic schema 丢根 `additionalProperties`。
4. 退出/Tab 补全/read 图片警告三处用户可见的边界行为：绝对路径 Tab 菜单按 Enter 误提交，read 的非视觉图片警告写进工具结果文本，退出前 SIGTSTP 未走 Ctrl+Z 的终端恢复路径。
5. tool preview 的无 scope 高亮文本继承终端前景色，主题反差下不可读。

## Decision

按主题移植，不改包名、包结构或上游独有的 provider/API：

- retry：在 `packages/ai/src/utils/retry.ts` 的现有 pattern 里补 `connection.?closed`、五个带边界的 Node socket code 和 `connection reset by peer`。边界用 `(?<![a-z0-9_])...(?![a-z0-9_])`，避免 `EXECONNRESET` 这类标识符误命中。
- instruction role：`detectCompat()` 只在 `api.openai.com` 或 provider `openai` 时默认 `developer`，其他 host 一律 `system`。同时修改 `packages/ai/scripts/generate-models.ts` 的同款判定；生成物是 gitignored，不直接改目录。
- strict schema：`makeJsonSchemaNodeStrict()` 遇到无 type / anyOf / enum 的节点抛 unsupported，`prefer` 降级到非严格、`require` 本地拒绝；enum-only 节点继续严格。Anthropic 非严格 `input_schema` 保留根 `additionalProperties`。
- 其他：`theme.ts` 加 `default` formatter；`editor.ts` 用 `isInSlashCommandNameContext()` 判定 Enter 是否提交；read 的图片警告从 `content` 文本移到 `details.imageUnsupportedByModel`，由渲染器展示；TUI 的 SIGTSTP listener 从 start 绑到 stop，且 stop 在终端恢复后才摘除，并由 `mountInteractiveTui()` 注册到 Ctrl+Z handler。

上游的 Mistral strict 修复不适用于本仓库：`mistral-conversations` API 和 provider 已在历史版本中移除（见 `packages/ai/CHANGELOG.md` [20261114] 的 Removed 条目）。Codex WebSocket / 系统提示缓存修复涉及本仓库未采用的传输路径，未纳入。

## Alternatives considered

- **按 commit cherry-pick**：上游父提交与 nanopi 树不连续（包改名、删除整包、生成器结构不同），cherry-pick 会拖入无关的 provider/catalog 重构，冲突成本高。
- **只改生成的 catalog 修 instruction role**：`pnpm run generate:models` 会从 `generate-models.ts` 重建目录，覆盖生成物里的改动；因此必须改生成器。
- **把 SIGTSTP listener 装在 InteractiveMode 构造时**：`TUI` 的终端所有权是 start()/stop() 区间；构造时或 stop() 之前摘除都会把外部编辑器的 SIGTSTP 吞掉，或在终端半恢复时被默认动作打断。按所有权绑定是唯一同时覆盖两种场景的方案。
- **保留 read 的警告文本以兼容导出**：工具结果文本会进会话并被模型重放，模型切到视觉模型后仍看到错误提示；放到 `details` 里既保留用户可见性又不污染上下文。

## Consequences

- retry 分类、instruction role 默认值、strict schema 的接受面和 read 的工具结果文本都发生变化，各自有回归测试钉住。
- instruction role 的 catalog override 仍留在 `generate-models.ts` 里；它们现在是冗余的显式值，但删掉会扩大 diff，且与本次缺陷无关。
- SIGTSTP 在独立 CLI TUI（resume picker、首次设置）仍未接 handler，与上游同一限制，留作后续。
- 本轮共 10 个上游提交按主题落地；P1 的 selector 搜索与 flush stdout 由资深工程师另起分支处理。
