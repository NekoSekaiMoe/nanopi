# Agent Note: 从 pi 挑回 P0/P2 与「建议挑」缺陷修复

Status: implemented

## Problem

Issue #783 要求跟进 `earendil-works/pi` v1.5.2..v1.6.0。上游 369 个提交大多是另一个产品形态，按 commit 全量合并不可行；只有一批修复命中的是 nanopi 现有代码里的同一缺陷。逐条核对 changelog 和本地代码后，待修的是：

1. retry 分类器不认 `Connection closed.`、裸 Node socket code 和 `connection reset by peer`。
2. `openai-completions` 对非 OpenAI 官方 endpoint 默认发 `developer`，Groq Qwen 等模板回 400。
3. strict JSON schema 遇到无类型节点（`items: {}`、bare `const`）被 OpenAI 400 拒绝；非严格 Anthropic schema 丢根 `additionalProperties`。
4. 退出/Tab 补全/read 图片警告三处用户可见的边界行为：绝对路径 Tab 菜单按 Enter 误提交，read 的非视觉图片警告写进工具结果文本，退出前 SIGTSTP 未走 Ctrl+Z 的终端恢复路径。
5. tool preview 的无 scope 高亮文本继承终端前景色，主题反差下不可读。

Issue #807 的「建议挑」批次中，以下条目在 nanopi 上是同一缺陷（编号以讨论中的上游 PR 为准）：

1. overflow 把 `request_too_large` 当子串匹配，`my_plugin_request_too_large_flag` 这类 400 错误被误判为上下文溢出。
2. `buildContextEntries` 用 spread 拼接最后一次 compact 之后的全部条目，约 12 万条后 `RangeError`。
3. `Editor.addToHistory` 只跳过连续重复，`/tree`、fork、resume 重填历史时同一 prompt 会反复入栈，挤掉旧记录。
4. `+$50` 这类未闭合 `$` 让整段 Markdown 余下内容按 pending 公式保持 raw，含跨行粗体。
5. `hyperlink()` 对超长裸 URL 仍发 OSC 8；换行时每行重发整条 URL，多 MB 输入撑爆堆。
6. retry backoff 的 abort listener 用 `{ once: true }`，正常计时结束时不会移除，同一个 signal 上反复重试会累积 listener。
7. `createProvider` 每次 `getModels()`/`getModel()` 都把动态目录重新合入基线，查找变成 O(n²)。
8. 四个流式读取点（agent proxy、RPC JSONL、session 文件、StdinBuffer paste）每来一个 chunk 都 rescan 整个 pending 字符串，长行/长粘贴是 O(n²)。

## Decision

按主题移植，不改包名、包结构或上游独有的 provider/API：

- retry 分类器：在 `packages/ai/src/utils/retry.ts` 的现有 pattern 里补 `connection.?closed`、五个带边界的 Node socket code 和 `connection reset by peer`。边界用 `(?<![a-z0-9_])...(?![a-z0-9_])`，避免 `EXECONNRESET` 这类标识符误命中。
- instruction role：`detectCompat()` 只在 `api.openai.com` 或 provider `openai` 时默认 `developer`，其他 host 一律 `system`。同时修改 `packages/ai/scripts/generate-models.ts` 的同款判定；生成物是 gitignored，不直接改目录。
- strict schema：`makeJsonSchemaNodeStrict()` 遇到无 type / anyOf / enum 的节点抛 unsupported，`prefer` 降级到非严格、`require` 本地拒绝；enum-only 节点继续严格。Anthropic 非严格 `input_schema` 保留根 `additionalProperties`。
- 其他：`theme.ts` 加 `default` formatter；`editor.ts` 用 `isInSlashCommandNameContext()` 判定 Enter 是否提交；read 的图片警告从 `content` 文本移到 `details.imageUnsupportedByModel`，由渲染器展示；TUI 的 SIGTSTP listener 从 start 绑到 stop，且 stop 在终端恢复后才摘除，并由 `mountInteractiveTui()` 注册到 Ctrl+Z handler。

Issue #807 批次：

- overflow：用 `(?<![A-Za-z0-9_])request_too_large(?![A-Za-z0-9_])` 限定完整标识符，保留大小写不敏感和独立 HTTP 413 判定。
- 长会话：把 spread 换成逐条 push，输出条目和顺序不变。
- editor history：同一 prompt 用 `indexOf` 找旧位置、`splice` 移除后再 `unshift`，最多保留 100 条。
- Markdown pending `$`：跟数字或跨行时不建 pending 公式；本地已有的 LaTeX 线性化不改。
- `hyperlink()`：URL 超过 8192 字符返回纯文本，仍显示但不可点。
- retry backoff：`setTimeout` 回调里先 `removeEventListener`，abort 时仍由 `{ once: true }` 自摘。
- models：在两次 `publish` 的 `update` 回调里用 type+id 索引合并一次，缓存全量和 chat 两个数组，读取只返回引用。
- 线性读取：只 `indexOf` 新增文本，命中时才把 pending 和该段拼接；StdinBuffer 多留末尾 `BRACKETED_PASTE_END.length - 1` 字符覆盖跨 chunk marker。本地 session reader 没有上游的 `pending` 尾部残留问题，不做那部分改动；统一 `SseDecoder` 涉及 5 个 API 适配器和本地 CRLF 修复，留单独 PR。

Issue #807 批次：

- overflow：用 `(?<![A-Za-z0-9_])request_too_large(?![A-Za-z0-9_])` 限定完整标识符，保留大小写不敏感和独立 HTTP 413 判定。
- 长会话：把 spread 换成逐条 push，输出条目和顺序不变。
- editor history：同一 prompt 用 `indexOf` 找旧位置、`splice` 移除后再 `unshift`，最多保留 100 条。
- Markdown pending `$`：跟数字或跨行时不建 pending 公式；本地已有的 LaTeX 线性化不改。
- `hyperlink()`：URL 超过 8192 字符返回纯文本，仍显示但不可点。
- retry backoff：`setTimeout` 回调里先 `removeEventListener`，abort 时仍由 `{ once: true }` 自摘。
- models：在两次 `publish` 的 `update` 回调里用 type+id 索引合并一次，缓存全量和 chat 两个数组，读取只返回引用。
- 线性读取：只 `indexOf` 新增文本，命中时才把 pending 和该段拼接；StdinBuffer 多留末尾 `BRACKETED_PASTE_END.length - 1` 字符覆盖跨 chunk marker。本地 session reader 没有上游的 `pending` 尾部残留问题，不做那部分改动；统一 `SseDecoder` 涉及 5 个 API 适配器和本地 CRLF 修复，留单独 PR。

上游的 Mistral strict 修复不适用于本仓库：`mistral-conversations` API 和 provider 已在历史版本中移除（见 `packages/ai/CHANGELOG.md` [20261114] 的 Removed 条目）。Codex WebSocket / 系统提示缓存修复涉及本仓库未采用的传输路径，未纳入。

## Alternatives considered

- **按 commit cherry-pick**：上游父提交与 nanopi 树不连续（包改名、删除整包、生成器结构不同），cherry-pick 会拖入无关的 provider/catalog 重构，冲突成本高。
- **只改生成的 catalog 修 instruction role**：`pnpm run generate:models` 会从 `generate-models.ts` 重建目录，覆盖生成物里的改动；因此必须改生成器。
- **把 SIGTSTP listener 装在 InteractiveMode 构造时**：`TUI` 的终端所有权是 start()/stop() 区间；构造时或 stop() 之前摘除都会把外部编辑器的 SIGTSTP 吞掉，或在终端半恢复时被默认动作打断。按所有权绑定是唯一同时覆盖两种场景的方案。
- **保留 read 的警告文本以兼容导出**：工具结果文本会进会话并被模型重放，模型切到视觉模型后仍看到错误提示；放到 `details` 里既保留用户可见性又不污染上下文。
- **整包 cherry-pick 上游 `#12451`**：它会把 Anthropic/OpenAI Codex/Mistral/pi-messages 四个 SSE 解析器统一到 `SseDecoder`，改动跨 33 个文件，且 Codex 接受 CRLF、pi-messages 合并多行 data 等行为变化会碰到本地已有的 CRLF 修复；这里只取四处 reader 的线性化，风险与 diff 都小得多。
- **保留 editor 的非连续重复**：上游 test 证明 `/tree` 重渲染会让历史成倍增长；移动而非去重会改变 Up-arrow 导航的语义，但这是采纳修复的前提。
- **把超长 URL 截断显示**：会丢失原始数据，且用户无法复制；只取消 OSC 8 链接不改文本。

## Consequences

- retry 分类、instruction role 默认值、strict schema 的接受面和 read 的工具结果文本都发生变化，各自有回归测试钉住。
- instruction role 的 catalog override 仍留在 `generate-models.ts` 里；它们现在是冗余的显式值，但删掉会扩大 diff，且与本次缺陷无关。
- SIGTSTP 在独立 CLI TUI（resume picker、首次设置）仍未接 handler，与上游同一限制，留作后续。
- 本轮共 10 个上游提交按主题落地；P1 的 selector 搜索与 flush stdout 由资深工程师另起分支处理。
- 本轮 8 组修复、24 个文件，全部带回归测试；上游 `#12451` 只取四段 reader，SSE 统一解析留作后续。
