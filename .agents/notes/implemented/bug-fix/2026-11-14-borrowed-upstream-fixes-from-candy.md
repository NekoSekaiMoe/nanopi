# Agent Note: 从 Candy 上游挑回来的五处缺陷修复

Status: implemented

## Problem

Issue #738 点名要看 `Ce-daros/Candy` 这个 fork 与 `earendil-works/pi` 的 compare。
它是 pi 的长期 fork（108 fork 侧提交、1390 落后、300 个文件互相交叉），整体结构
已经被改得和 nanopi 不是一棵树：包名、`packages/chord|client|protocol|server|durable`
被删除、`apps/p2` 是它自己的 app、TUI 被改成 fullscreen-only。所以**不能按 commit
pick**，只能按主题从 diff 里挑「改的是同一段代码、缺陷在 nanopi 里仍然存在」的补丁。

逐条对着本地代码核实后，有六处是真的还成立、且都是小范围行为缺陷：

1. Anthropic SSE 解析把行尾跨 chunk 切断的 `\r\n` 当成完整换行，跟在后面的
   `event:` 字段丢掉，整帧静默消失。
2. `kernel` 侧的 agent loop：工具批被 abort 之后 `finishTurn` 若返回 `continue`，
   循环仍然再发一次请求，而那条 transcript 里带着没有结果的 tool call。
3. bash / 工具输出的临时文件在异常路径上只 `end()` 不等待，写失败要么变成
   unhandled `error`，要么根本没人看到。
4. grep 工具只在 ripgrep 子进程起来之后才监听 abort；断开在「查找 rg、探测路径」
   阶段时就等于没断，而且被 abort 杀掉的子进程会被当成 ripgrep 退出码失败。
5. 项目信任沿祖先一路走到 `/`，`$HOME` 之上的 `.agents/skills` 也算项目资源。
6. `RpcClient.promptAndWait` 对 session 自己处理掉的 prompt（`disposition: "handled"`）
   永远等不到 `agent_settled`，只能等超时。

## Decision

六条按上述顺序逐个移植，每条都带一个能复现原缺陷的测试：

- SSE：`consumeLine(text, finished)` 增加 `finished` 参数，`\r` 落在 chunk 末尾时
  先不消费；只有最终 drain 才允许把它当行尾。测试按 `\r\n` / `\r` / `\n` 三种行尾、
  逐字节喂进流。
- agent loop：`signal?.aborted || decision?.action === "end"` 才算结束。abort 之后
  再发请求就是在重放没有结果的 tool call，用户已经按了中断。
- 临时文件：`finished(stream)` 在创建时就挂上（先 `catch` 掉，避免无人 await 的
  拒绝变成 unhandled），`end()` 与 `await` 收进 `finally`，只关一次。顺带把
  `bash-executor` 的 return 挪进 `try`，让 `finally` 覆盖所有正常出口。
- grep：abort 监听提到第一个 `await` 之前，handle 存进 `stopChild`，子进程起来后由
  `killChild` 接上；`settle` 统一注销监听；`close` 回调里 `settled` 直接返回，
  不再把 abort 的 kill 报成 ripgrep 失败。
- 信任：祖先遍历在 `$HOME` 处停下（`$HOME` 自己也不计入 —— 那是用户自己的目录），
  `.nanopi/settings.json` 那一支不变。
- RPC：`collectEvents` 拆成「订阅 + 可 finish 的 collector」，`promptAndWait` 在
  `handled` 时主动 finish，`finally` 兜底。

没移植的（核实后认为不适用或收益不明确）：

- `openai-codex-images` 图片生成 provider、`utils/kimi-coding.ts` 端点改造 —— 是**新功能**，
  不是缺陷，得单独开 PR 谈。
- anthropic-messages 的 SDK 迁移、`inline-tools-2026-09-15` beta、`tool_addition`
  带内联定义 —— 跟上游的 provider runtime 重构绑在一起，硬搬会把 nanopi 的
  tool-declaration 机制和它混成一团。
- `.github/workflows/*`、`apps/p2`、`packages/chord`、fullscreen-only TUI、
  `packages/coding-agent` 的界面重做 —— nanopi 没有对应实体，或者方向不同。
- OAuth 错误文案里 `JSON.stringify(json)` 的脱敏：这条**移植了**，因为它把一个
  真实的泄密面（access/refresh token 出现在错误信息里）变成了一句固定文案。

## Alternatives considered

- **按 commit cherry-pick**：上游的父提交与我们的树不连续（包改名、几十个包删除），
  cherry-pick 必然大面积冲突，且会把它们删包的重构一起拖进来。
- **只挑「大的」改动（图片 provider / kimi-coding）**：那些是新功能，需要单独的设计
  决策和 PR；混在一堆缺陷修复里既难评审，也不会有人回头补齐它们的测试。
- **信任修复改成「信任 `$HOME` 同时也信 `/`」**：等于把 `/` 之下所有 checkout 都当成
  可信项目上下文，这是把缺陷放大成安全问题。
- **grep 只在 `spawn` 之后监听 abort**：改动更小，但「查找 rg」在冷启动时要下载
  二进制，正是最需要能中断的那一段。

## Consequences

- 五条行为变化：CRLF SSE 不再丢帧；abort 之后不再多发一次请求；临时文件写失败会
  冒泡给调用方；grep 在探测阶段就能被中断且不再误报退出码；`$HOME` 之上的资源不算
  项目上下文；`promptAndWait` 对 `handled` 立即返回。
- 每一处都钉了回归测试；上游后续再改这几段时，diff 形状基本可以对着再对一遍。
- agent loop 那条顺带改掉了两处 coding-agent 既有测试的预期，它们把「abort 之后还会
  再发一次请求」当成了正常行为：`agent-session-runtime.test.ts` 的 outgoing 会话不再多
  一条尾部 assistant，`agent-session-concurrent.test.ts` 的 steering 用例改成第二轮请求
  正常结束来投递消息，而不是靠 abort 触发的那次多余请求。
- 后续若要继续吃这个 fork 的收益，仍然要按主题挑，不要指望按 commit 同步。
