# Agent Note: 不引入独立的记忆系统

Status: rejected — 用户判断：项目级记忆（AGENTS.md 一族）加项目内的文档笔记已经够用，不新增记忆系统。

## Problem

ISSUE #400 讨论过接入外部记忆系统（lingshu / dsh-memory）。它们的共同前提是：模型需要一个独立于
代码库的持久层，靠检索把「以前发生过什么」捞回上下文。这个前提在 nanopi 上不成立的地方有三处：

- **上下文预算已经排满。** [prompt-budget-5k](../../implemented/simplification/2026-10-27-prompt-budget-5k.md) 把 system prompt
  与工具声明压到 5k token 量级。任何「常驻注入」的记忆层都是往这个预算里再塞一笔固定开销。
- **写入门槛已经有了形状。** [memory-entry-aging](../../implemented/feature/2026-10-26-memory-entry-aging.md)
  规定了条目必须是「始终为真、短、经用户确认」的规则，带 `(kept YYYY-MM-DD)` 时间戳，能列出年龄、
  能 prune、能识别 `missing` 与 `aged`。它缺的只是「会话级事实」那一层。
- **真正缺的是跨会话的**事实**，不是检索能力**。而事实的天然载体是仓库里的 markdown：`.agents/notes/`
  记决策与取舍，`AGENTS.md` 记规则，issue / PR 记讨论。它们能 `git blame`、能 review、能在 diff 里
  被看见——这是任何私有记忆库都给不了的可审计性。

## Proposal

决定：nanopi 不引入独立的记忆系统。记忆分两层，都落在项目里，跟随代码一起版本化：

- **项目级记忆 = `AGENTS.md` 一族。** `packages/coding-agent/src/core/resource-loader.ts` 的
  `candidates`（`AGENTS.override.md` / `AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD`）
  按目录向上继承，一个目录只取一个文件；`pi-memory` 负责写入、去重、时间戳与 prune。这一层进
  system prompt，所以只准放「永远为真、每条都短」的规则。
- **项目内文档笔记 = `.agents/notes/`。** 决策、取舍、被否掉的方案、踩过的坑写在这里，按
  `{lifecycle}/{class}` 放。它**不进** system prompt，靠 `read` / `grep` / 检索按需读。

分层的判据是一句话：**「这条下次一定用得上，而且短」进 AGENTS.md；「这条只在某些会话里用得上」进
notes。** 前者是规则，后者是背景。规则贵在常驻，背景贵在可查，把背景塞进常驻是这笔交易里唯一会亏
的地方。

因此也**不做**这些：不加向量库、不上 SQLite、不挂 MCP 记忆服务、不在会话结束时自动总结落盘。需要
跨会话记住的东西，由当次会话的模型判断后写进 notes 或 `AGENTS.md`，写完在 diff 里可见。

## Alternatives considered

### 挂 dsh-memory 这类 MCP 记忆服务

它最强的地方是把自己的失败量化了：灵枢的「生效条件」文档实测，三万节点抽样里按「本地文档仓 / 大域
/ 全时窗」填的条件命中率掉到 0.3%。这种诚实很有价值，但接进来的代价是双运行时（Node ≥22.19 +
Python ≥3.12）与一个 71.9 MB 的目录耦合体，而 nanopi 是单文件分发的 CLI。用安装体积和一个外部
服务，去换一个我们已经有更好载体的能力，账不划算。

另外 30+ 个工具声明每个都带 description，进 `<tools>` 会直接打爆 5k 预算；`mcp-lite` 之所以把
MCP 关进 subagent、主 agent 只留一个 `mcp` 壳（见
[mcp-discovery-and-wrapper-tool](../../implemented/architecture/2026-10-21-mcp-discovery-and-wrapper-tool.md)），原因就在这里。

### 会话级记忆层：`.agents/memory/*.md` + 按需读

这是我上一轮倾向的方案，形态上和最终决定很像——都是 markdown、都不进 prompt、都靠 `read`/`grep`
取。但它多一条没人会去爬的路径：事实需要写一份到 `.agents/memory/`，再写一份到 `.agents/notes/` 或
`AGENTS.md`，两边会漂移。既然 notes 已经是「项目内的文档笔记」且本来就有分类和校验脚本，再加一层
只是把同一个东西存两遍，还得回答「什么该进哪一边」。多一层结构，少一个来源。

### 自动记忆：会话结束让模型总结落盘

无需用户确认，覆盖率最高，也最省事。否掉的理由是它写进去的东西没人审：错的总结会和对的总结长得
一样，下一轮会话照单全收。现有 `pi-memory` 的写入门槛（须是规则、须新、须用户确认）就是为这件事
设的，自动落盘等于把它拆掉。记忆的失败模式不是「记不住」，是「记错了却看不出来」。

## Consequences

代价先写清楚：

- **跨会话记忆靠自觉。** 没有东西强制模型在会话结束时留下笔记，忘了就是忘了。缓解手段是
  `AGENTS.md` 里那几条规则与 notes 的写作触发信号，不是机制保障。
- **笔记检索是线性的。** `read` / `grep` 在几千篇笔记后会变慢，也不会做语义召回。如果哪天
  `.agents/notes/` 大到 `grep` 找不回来，那是重新评估「要不要索引」的时候——不是现在。
- **「上次我们为什么否掉了 X」这类问题，答案在文件里，不在上下文里。** 模型得先去读才知道，
  这比自动召回多一步。

收益：

- 零新增运行时依赖、零常驻 token 开销、零新格式。
- 记忆与代码同生命周期：改了什么、为什么改、否掉了什么，都在同一次 review 里被看见，`git blame`
  能追到人。
- 只有一处真源。规则在 `AGENTS.md`，背景在 `.agents/notes/`，不会互相矛盾。

重访条件：如果实测出现大量「同一件事实被反复重新发现、且没人写下来」的会话，说明自觉这一环不够，
那时再谈机制——而不是现在先建一套记忆系统再找问题。
