# Agent Note: ask-lite 不跟随上游的那 6 条交互改动

Status: rejected — 用户判断：六条都先不做。前三条里真正值钱的是三个局部缺口（`unanswered`、行尾光标、`toolCallId`），它们和「跟不跟上上游」是两件事，各自有机会再说。

## Problem

`packages/coding-agent/src/extras/ask-lite` 是 vendored 的 `juicesharp/rpiv-mono` 的
`rpiv-ask-user-question`，停在 1.20.0，上游已经到 2.15.0。逐条对 changelog 后，有 6 条我们没跟：

1. 会话历史里的 compact receipt（2.14.2）
2. `multiSelect` 问题也追加 `Type something.` 行（2.0.0）
3. 内联到编辑器槽位、不走 overlay（2.13.0）
4. `blocked` / `answer` 事件契约
5. 可配置的 `notesKey` / `collapseKey`（2.15.0）
6. ACP 宿主的原生 select/input 对话框（2.0.0）

这 6 条起初按「看着诱人但不建议 pick」被放过，理由是「改动面大」「架构不同」「没需求」。那些理由
有三条站不住：#1 被误判成要接 `renderCall`，其实上游 `presentation.ts` 是 132 行纯函数；#2 上游
2.13.6 给出的合并路径很轻；#3 里藏着一个我们已经踩到的渲染 bug。所以需要重新核一遍，再决定要不要做。

## Proposal

决定：6 条全部不做，但把核对过程中发现的三个**局部缺口**记下来，它们不依赖「跟上游」这个前提：

- **`unanswered` 字段缺失。** 上游 `tool/response-envelope.ts:27-50` 在部分提交时补一段
  `unanswered: "<question>", "<question>".`，并在 `details.unanswered` 带索引。我们
  `tool/response-envelope.ts:23-28` 只是把已答的 segment 拼起来，没答的 tab 什么都不输出，模型收到
  的仍然是 `You can now continue with the user's answers in mind.`（`:6`），会以为全定了。这是
  「模型被喂了错误事实」，不是 UI 偏好。
- **行尾光标消失。** 上游 `view/components/inline-input.ts:48` 有 `const cursorAtLineEnd = rawAt === "\n"`
  这一支；我们 `view/components/wrapping-select.ts:299` 只有 `rawAt === "" || rawAt === " "`。光标落
  在逻辑行尾时 `atCursor` 拿到 `"\n"` —— 宽度 0 的控制符进了反显区间，光标看不见。修的时候不能只
  补 NBSP：`after = buffer.slice(offset + rawAt.length)` 会把那个 `\n` 一起吃掉，逻辑行会并进上一行。
- **prompt 事件没有 `toolCallId`。** `events.ts:22` 的 payload 只有 `questions`，而
  `grep -rn "rpiv:ask-user" packages/` 除 ask-lite 自身外零监听者，所以补一个
  `toolCallId?: string` 是纯 append、不影响任何现存代码。做这个不是因为要跟 4，而是因为以后谁想
  区分「哪一次提问」都得先有它。

三条都各自需要单独的需求确认，不在本文落地。

## Alternatives considered

### 逐条跟上游（尤其 #2、#3）

#2 上游 2.13.6 的写法确实很轻：input 的 Enter 和 `Next` 都收敛到同一个 `kind: "multi"` 答案，
`selected` 放勾选、`answer` 放自定义文本。但落地的连锁是四处：`state/row-intent.ts:92` 的 META 要开
`autoAppendOnMultiSelect`、`multi-select-view.ts` 的 `prefixVisibleWidth()` 要把 numberWidth 从
`options.length` 加到 `options.length + 1`（`naturalHeight` 也因此从 state-independent 变成 props
相关，那是一条写在 `:29` 上的契约）、`key-router.ts` 的 multi 分支要拆出 Enter-as-toggle 与
Enter-in-input、`state-reducer.ts` 的 `multi_confirm` 要同时带 `selected` 和 `answer`（
`format-answer.ts` 的 multi 分支现在只有 `selected.join(", ")`，`tool/types.ts:105` 的注释也写死了
`answer is null`）。四条加起来换一个「多选里能打自由文本」，等有人报再说。

#3 更明确：`ask-user-question.ts:173` 写死 `overlay: true`，宿主那侧
`showExtensionCustom` 是支持 `overlay: false` 的（走 `editorContainer.addChild`），所以门不是宿主
能力，而是 `DialogView.render()` 现在按 `tui.terminal.rows` 划分 `topFixed/bottomFixed/availableMiddle`
（`dialog-builder.ts:144,161-197`）—— editor slot 拿到的行数和 `terminal.rows` 不是一回事，整套行
预算要重做。这是 6 条里唯一会动渲染核心的一条。

### 把 compact receipt 接在 `renderCall` / `renderResult` 上

技术上可行：`registerTool` 的 `renderResult` 上下文里有 `expanded`/`isError`/`toolCallId`，信息够。
但 `view/transcript.ts`（144 行）会把 `view/` 目录拉进**工具注册期**的加载图，而
`ask-user-question.ts:157-159` 特意把 `QuestionnaireSession` 做成懒加载，就是为了不背 `view/` 那
张 ~560ms 的渲染图。要做得把这个渲染器也做成 lazy，等于分叉一条新的加载路径，去换一段更好读的会
话历史。上游自己也在 2.14.2 先做完整回执、又因体积退回 `✓ answer` + 表格，说明这层厚度还没定。
真要改，先做上面那个 `unanswered`，那才是模型看得见的差别。

### 补 `blocked` / `answer` 事件契约

`answer` 不是加个事件：上游 `tool/external-answer.ts` 是「第一答案胜出」的仲裁门，prompt/blocked
都带 `toolCallId`，从 prompt 发出那一刻起接受答案、严格校验、全或无。那是给 pane supervisor / 手机
/ web bridge 这类外部驱动方用的协议，我们一个都没有。已有的等价路径是 `extraBridge.asks`
（`ask-user-question.ts:44-48`、`webui-server.ts` 的 `user_input_request`），那条已经跑通。

### 配置 `notesKey` / `collapseKey`

`collapseKey` 对应不上任何东西：`Ctrl+]` 在 `key-router.ts:184` 是写死的
`matchesKey(data, Key.ctrl("]"))`，连 `TUI_KEYBINDINGS` 都没进——要配置得先把它挪进键位表，等于先
做一个功能再给它加配置。

`notesKey`（上游 #294）是真问题：西里尔等布局下 `n` 打不出来，`key-router.ts:13` 的
`NOTES_ACTIVATE_KEY = "n"` 按不出来就是按不出来。但解法是「解析 + 校验 + 回退一套 key spec」，
且 `buildHintText` 的提示文案 9 个 locale 都要带出配置后的键名。收益只在非拉丁键盘，等具体抱怨。

### 接 ACP 原生对话框

上游 2.0.0 的 native `select`/`input` 是它自己 RPC host 的适配层。我们无 UI 时走
`askViaWebuiBridge`，再退 `ERROR_NO_UI`（`ask-user-question.ts:148-151`），webui 那条路是完整的。
没有对标 host 要适配，接了也没有消费者。

## Acceptance criteria

不做，无验收面。上面三个局部缺口各自立项时再写。

## Risks

- 与上游的差距会继续拉大，之后逐条对的成本只会更高。缓解手段是这份记录本身：下次再翻 changelog 时
  先读这里，不用把「为什么不做」重推一遍。
- `unanswered` 那个缺口是本文里唯一有「模型被喂错事实」性质的一条。把它和其余五条一起搁置，意味着
  这个错会一直存在到有人单独提它。
